// The NEAR relay's part of AdminRpc.systemStatus (D784–D786; near/relay-status.ts): the relay's state (off, its config
// or keys unusable, on), the relay account's available balance and full-access keys against the API's relay keys
// (public keys only), the UTC day's spend as the budget's RateLimiter counts it (read only), each failing on its own,
// and the NEAR and RateLimiter reads it makes (two and one, none when off). The fake NEAR RPC: test/near-mock.ts.
import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { KeyPair } from '@near-js/crypto';
import { actionCreators, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, Signature, SignedDelegate } from '@near-js/transactions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Encode, hex } from '../src/bytes.ts';
import { TGAS } from '../src/near/delegate.ts';
import { rpcHealth } from '../src/near/rpc.ts';
import { nearRelayStatus, relaySpendTiming } from '../src/near/relay-status.ts';
import { defaultNearAccountLookup, forgetHead, nearDirectory, nearRelayKeys, nearRelayReady } from '../src/near/relay.ts';
import { appHeaders, call, chain } from './helpers.ts';
import { adminRpc, governanceViews, hana, ownerChain } from './rpc-helpers.ts';
import { vaultSetup } from './vault-helpers.ts';

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
  relaySpendTiming.timeoutMs = 2_500;
  nearDirectory.lookup = defaultNearAccountLookup;
});

/** Every relay secret, whole and as a prefix of its base58 part (what a log line or an answer must never hold). */
const secretFragments = (): string[] => (JSON.parse(env.NEAR_RELAY_KEYS!) as string[]).flatMap((k) => [k, k.slice('ed25519:'.length, 'ed25519:'.length + 16)]);

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

describe('after the security review (2026-11-12)', () => {
  it('a budget object that never answers: the spend is rate_limiter_unavailable within the deadline, the rest stands', async () => {
    chain();
    relaySpendTiming.timeoutMs = 30;
    const stalled = { ...env, RATE_LIMITER: { idFromName: () => ({}), get: () => ({ spent: () => new Promise<string>(() => {}) }) } as unknown as typeof env.RATE_LIMITER };
    const started = Date.now();
    const s = await nearRelayStatus(stalled, nextDay());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s).toMatchObject({ state: 'on', chain: { ok: true }, spend: { ok: false, code: 'rate_limiter_unavailable' } });
  });

  it('a budget object that fails after the deadline: dropped, no unhandled rejection', async () => {
    chain();
    relaySpendTiming.timeoutMs = 10;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    globalThis.addEventListener('unhandledrejection', onUnhandled);
    try {
      const late = { ...env, RATE_LIMITER: { idFromName: () => ({}), get: () => ({ spent: () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 60)) }) } as unknown as typeof env.RATE_LIMITER };
      const s = await nearRelayStatus(late, nextDay());
      expect(s.spend).toEqual({ ok: false, code: 'rate_limiter_unavailable' });
      await new Promise((r) => setTimeout(r, 120));
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.removeEventListener('unhandledrejection', onUnhandled);
    }
  });

  it('no relay secret, whole or as a prefix, reaches a log line on any path of the status build', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const near = governanceViews(ownerChain());
    near.accessKeyList = relayPublicKeys().map(fullAccess);
    const own = (JSON.parse(env.NEAR_RELAY_KEYS!) as string[])[0]!;
    const broken = { idFromName: () => ({}), get: () => ({ spent: () => Promise.reject(new Error('down')) }) } as unknown as typeof env.RATE_LIMITER;
    // On, no keys, bad keys (repeated, junk), bad config, off, the account missing, NEAR down, the budget down.
    for (const e of [env, { ...env, NEAR_RELAY_KEYS: undefined }, { ...env, NEAR_RELAY_KEYS: JSON.stringify([own, own]) }, { ...env, NEAR_RELAY_KEYS: 'not json' }, { ...env, NEAR_RELAY: '{' }, { ...env, NEAR_RELAY: undefined }, { ...env, RATE_LIMITER: broken }]) await nearRelayStatus(e, nextDay());
    near.missingAccounts.add(RELAY_ACCOUNT);
    await nearRelayStatus(env, nextDay());
    near.missingAccounts.delete(RELAY_ACCOUNT);
    await adminRpc().systemStatus(hana());
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockImplementation(async () => new Response('bad gateway', { status: 502 }));
    await nearRelayStatus(env, nextDay());
    await adminRpc().systemStatus(hana());
    expect(lines.some((l) => l.includes('near_relay_unreadable'))).toBe(true);
    const text = lines.join('\n');
    for (const f of secretFragments()) expect(text).not.toContain(f);
  });

  it('a real relay through the relay’s own route shows up in the status answer’s spend', async () => {
    forgetHead();
    const { app } = await vaultSetup();
    const keyPair = KeyPair.fromRandom('ed25519');
    const sender = hex(keyPair.getPublicKey().data);
    nearDirectory.lookup = async (_db, q) => (q.accountId === sender && q.scopeId === app.scope ? { userId: `hu_${sender.slice(0, 12)}` } : null);
    const da = buildDelegateAction({ senderId: sender, receiverId: 'guestbook.test.near', actions: [actionCreators.functionCall('add_message', { text: 'hello' }, 30n * TGAS, 0n)], nonce: 101n, maxBlockHeight: 1100n, publicKey: keyPair.getPublicKey() });
    const hash = new Uint8Array(createHash('sha256').update(encodeDelegateAction(da)).digest());
    const signed = encodeSignedDelegate(new SignedDelegate({ delegateAction: da, signature: new Signature({ keyType: 0, data: keyPair.sign(hash).signature }) }));
    const before = await nearRelayStatus(env);
    expect(before.spend).toMatchObject({ ok: true });
    const res = await call('/v1/near/relay', { headers: appHeaders(app), body: { network: 'testnet', signedDelegateAction: base64Encode(signed) } });
    expect(res.status).toBe(200);
    const after = await nearRelayStatus(env);
    if (!before.spend?.ok || !after.spend?.ok) throw new Error('no spend');
    // What the relay burnt (settled from its worst-case reservation), as the budget counted it.
    expect(BigInt(after.spend.spentYocto)).toBeGreaterThan(BigInt(before.spend.spentYocto));
    expect(after.spend.spentYocto).toBe(await budget().spent('near-relay:day', DAY));
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
