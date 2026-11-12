// The NEAR relay's part of AdminRpc.systemStatus (D784–D786; near/relay-status.ts): the relay's state (off, its config
// or keys unusable, on), the relay account's available balance and full-access keys against the API's relay keys
// (public keys only), the UTC day's spend as the budget's RateLimiter counts it (read only), each failing on its own,
// and the NEAR and RateLimiter reads it makes (two and one, none when off). The fake NEAR RPC: test/near-mock.ts.
import { env } from 'cloudflare:workers';
import { KeyPair } from '@near-js/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rpcHealth } from '../src/near/rpc.ts';
import { nearRelayStatus } from '../src/near/relay-status.ts';
import { nearRelayKeys, nearRelayReady } from '../src/near/relay.ts';
import { chain } from './helpers.ts';
import { adminRpc, governanceViews, hana, ownerChain } from './rpc-helpers.ts';

const RELAY_ACCOUNT = 'near-relay.test.near';
const DAY = 86_400_000;
const E24 = 10n ** 24n;
/** A day of its own per test (the budget's windows are per UTC day, the RateLimiter object shared). */
let dayIndex = 30_000 + Math.floor(Math.random() * 10_000);
const nextDay = (): number => (dayIndex += 1) * DAY + 3_600_000;

const relayPublicKeys = (): string[] => (JSON.parse(env.NEAR_RELAY_KEYS!) as string[]).map((k) => KeyPair.fromString(k as `ed25519:${string}`).getPublicKey().toString());
const fullAccess = (publicKey: string) => ({ public_key: publicKey, access_key: { nonce: 0, permission: 'FullAccess' } });
const functionCall = (publicKey: string) => ({ public_key: publicKey, access_key: { nonce: 0, permission: { FunctionCall: { allowance: null, receiver_id: 'guestbook.test.near', method_names: [] } } } });
const budget = () => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('near-relay:budget'));

afterEach(() => {
  vi.restoreAllMocks();
  rpcHealth.clear();
});

describe('nearRelayStatus', () => {
  it('on: the balance less what storage locks, every API key a full-access key on chain, the day’s spend', async () => {
    const near = chain();
    const [a, b] = relayPublicKeys();
    near.balances.set(RELAY_ACCOUNT, (12n * E24).toString());
    near.accessKeyList = [fullAccess('ed25519:4kqyRk2KyNBUm2oWT7m8n3fESEFJr3vV3YdBSiHVpDWp'), fullAccess(a!), fullAccess(b!)];
    const now = nextDay();
    await budget().spend('near-relay:day', DAY, (5n * E24).toString(), (4n * E24).toString(), now);
    const before = near.rpcMethods.length;
    const s = await nearRelayStatus(env, now);
    expect(s).toEqual({
      state: 'on',
      offReason: null,
      readAt: now,
      account: RELAY_ACCOUNT,
      lowBalanceYocto: (2n * E24).toString(),
      dailyBudgetYocto: (5n * E24).toString(),
      budgetAlertPct: 80,
      // The mock's storage_usage is 182 bytes: 182 × 10^19 yocto locked.
      chain: { ok: true, exists: true, availableYocto: (12n * E24 - 182n * 10n ** 19n).toString(), fullAccessKeys: 3 },
      keys: { configured: 2, missing: [] },
      spend: { ok: true, day: new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10), spentYocto: (4n * E24).toString() },
    });
    // Exactly two NEAR reads (view_account, view_access_key_list).
    expect(near.rpcMethods.slice(before)).toEqual(['query', 'query']);
  });

  it('a key missing on chain, or there only as a function-call key, is listed by its public key', async () => {
    const near = chain();
    const [a, b] = relayPublicKeys();
    near.accessKeyList = [fullAccess(a!), functionCall(b!)];
    const s = await nearRelayStatus(env, nextDay());
    expect(s.keys).toEqual({ configured: 2, missing: [b] });
    expect(s.chain).toMatchObject({ ok: true, fullAccessKeys: 1 });
  });

  it('a missing account: exists false, every key missing', async () => {
    const near = chain();
    near.missingAccounts.add(RELAY_ACCOUNT);
    const s = await nearRelayStatus(env, nextDay());
    expect(s.chain).toEqual({ ok: true, exists: false, availableYocto: '0', fullAccessKeys: 0 });
    expect(s.keys).toEqual({ configured: 2, missing: relayPublicKeys() });
  });

  it('NEAR unreadable: chain near_unavailable, no key verdict, the spend still read', async () => {
    chain();
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('bad gateway', { status: 502 }));
    const now = nextDay();
    const s = await nearRelayStatus(env, now);
    expect(s).toMatchObject({ state: 'on', chain: { ok: false, code: 'near_unavailable' }, keys: null, spend: { ok: true, spentYocto: '0' } });
  });

  it('off: no NEAR_RELAY, empty receivers, or not testnet; nothing is read', async () => {
    const near = chain();
    const calls = () => near.rpcMethods.length;
    const before = calls();
    expect(await nearRelayStatus({ ...env, NEAR_RELAY: undefined })).toMatchObject({ state: 'off', offReason: 'none', account: null, chain: null, keys: null, spend: null });
    expect(await nearRelayStatus({ ...env, NEAR_RELAY: JSON.stringify({ account: RELAY_ACCOUNT, receivers: [] }) })).toMatchObject({ state: 'off', offReason: 'no_receivers', chain: null });
    expect(await nearRelayStatus({ ...env, NETWORK: 'mainnet' })).toMatchObject({ state: 'off', offReason: 'not_testnet', chain: null });
    expect(calls()).toBe(before);
  });

  it('a config the API refuses is bad_config (nothing read); the relayer’s own account as the relay account too', async () => {
    const near = chain();
    const before = near.rpcMethods.length;
    expect(await nearRelayStatus({ ...env, NEAR_RELAY: '{not json' })).toMatchObject({ state: 'bad_config', offReason: null, account: null, chain: null, spend: null });
    expect(await nearRelayStatus({ ...env, NEAR_RELAY: JSON.stringify({ account: env.RELAYER_ACCOUNT, receivers: ['guestbook.test.near'] }) })).toMatchObject({ state: 'bad_config' });
    expect(near.rpcMethods.length).toBe(before);
  });

  it('no keys (the off switch) and unusable keys: the account and spend still read, no key verdict; the relay itself refuses', async () => {
    chain();
    const none = await nearRelayStatus({ ...env, NEAR_RELAY_KEYS: undefined }, nextDay());
    expect(none).toMatchObject({ state: 'no_keys', account: RELAY_ACCOUNT, chain: { ok: true, exists: true }, keys: null, spend: { ok: true } });
    expect(nearRelayReady({ ...env, NEAR_RELAY_KEYS: undefined })).toBeNull();
    // A relay key that is also a session-pool key, a repeated key, and junk.
    const pool = (JSON.parse(env.RELAYER_KEYS!) as string[])[0]!;
    const own = (JSON.parse(env.NEAR_RELAY_KEYS!) as string[])[0]!;
    for (const bad of [JSON.stringify([pool]), JSON.stringify([own, own]), 'not json']) {
      expect(await nearRelayStatus({ ...env, NEAR_RELAY_KEYS: bad }, nextDay())).toMatchObject({ state: 'bad_keys', keys: null });
      expect(nearRelayReady({ ...env, NEAR_RELAY_KEYS: bad })).toBeNull();
    }
    expect(nearRelayKeys(env)).toEqual({ state: 'ok', publicKeys: relayPublicKeys() });
    expect(nearRelayReady(env)).toMatchObject({ keyCount: 2 });
  });

  it('a RateLimiter that can’t be reached is spend rate_limiter_unavailable; the rest stands', async () => {
    chain();
    const broken = { ...env, RATE_LIMITER: { idFromName: () => ({}), get: () => ({ spent: () => Promise.reject(new Error('object unavailable')) }) } as unknown as typeof env.RATE_LIMITER };
    const s = await nearRelayStatus(broken, nextDay());
    expect(s).toMatchObject({ state: 'on', chain: { ok: true }, spend: { ok: false, code: 'rate_limiter_unavailable' } });
  });

  it('the spend read changes nothing: reading twice, then spending, counts only the spend', async () => {
    chain();
    const now = nextDay();
    await nearRelayStatus(env, now);
    await nearRelayStatus(env, now);
    expect(await budget().spend('near-relay:day', DAY, (5n * E24).toString(), '7', now)).toEqual({ ok: true, spent: '7' });
    expect((await nearRelayStatus(env, now)).spend).toMatchObject({ spentYocto: '7' });
    // The next UTC day starts at 0.
    expect((await nearRelayStatus(env, now + DAY)).spend).toMatchObject({ spentYocto: '0' });
  });
});

describe('AdminRpc.systemStatus carries it', () => {
  it('as `nearRelay`, public keys only: no relay secret in the answer', async () => {
    const near = governanceViews(ownerChain());
    near.accessKeyList = relayPublicKeys().map(fullAccess);
    const r = await adminRpc().systemStatus(hana());
    expect(r).toMatchObject({ ok: true, nearRelay: { state: 'on', account: RELAY_ACCOUNT, keys: { configured: 2, missing: [] } } });
    const text = JSON.stringify(r);
    for (const secret of JSON.parse(env.NEAR_RELAY_KEYS!) as string[]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice('ed25519:'.length, 'ed25519:'.length + 20));
    }
  });
});
