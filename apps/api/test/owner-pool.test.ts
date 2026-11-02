// The hourly owner-pool allowance check (docs/batch-c-spec.md "On-chain owner actions", Allowance alert; owner-pool.ts):
// a key below 25% of its initial allowance, or missing from the relayer account, writes one `owner_allowance_low`
// event per key and UTC day; a healthy pool writes nothing; NEAR down never fails the cron.
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOwnerPoolAllowance, initialOwnerAllowance, lowOwnerAllowances } from '../src/owner-pool.ts';
import { OWNER_POOL_ALLOWANCE_YOCTO, parseRelayerKeys } from '../src/relayer-config.ts';
import { NearMock } from './near-mock.ts';

const DAY = 24 * 60 * 60 * 1000;
const ownerKeys = parseRelayerKeys(env.OWNER_RELAYER_KEYS, 'OWNER_RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
const sessionKeys = parseRelayerKeys(env.RELAYER_KEYS, 'RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
const fc = (publicKey: string, allowance: string | null) => ({
  public_key: publicKey,
  access_key: { nonce: 1, permission: { FunctionCall: { allowance, receiver_id: env.SIGNER_ACCOUNT, method_names: ['propose_change'] } } },
});

let n: NearMock;
beforeEach(async () => {
  n = new NearMock();
  n.install();
  await env.DB.prepare("DELETE FROM security_events WHERE kind = 'owner_allowance_low'").run();
});
afterEach(() => vi.restoreAllMocks());

const events = async () => (await env.DB.prepare("SELECT * FROM security_events WHERE kind = 'owner_allowance_low' ORDER BY id").all<Record<string, unknown>>()).results;

describe('owner-pool allowance check', () => {
  it('the test env has owner-pool keys, and the base is the deploy default (0.5 NEAR) unless the var says otherwise', () => {
    expect(ownerKeys.length).toBeGreaterThan(0);
    expect(initialOwnerAllowance(env)).toBe(OWNER_POOL_ALLOWANCE_YOCTO);
    expect(OWNER_POOL_ALLOWANCE_YOCTO).toBe(5n * 10n ** 23n);
    expect(initialOwnerAllowance({ ...env, OWNER_POOL_ALLOWANCE_YOCTO: '2000000000000000000000000' })).toBe(2n * 10n ** 24n);
    expect(initialOwnerAllowance({ ...env, OWNER_POOL_ALLOWANCE_YOCTO: 'lots' })).toBe(OWNER_POOL_ALLOWANCE_YOCTO);
  });

  it('a healthy pool writes nothing; only the owner pool is read (never the session pool)', async () => {
    n.accessKeyList = [...ownerKeys.map((k) => fc(k, (OWNER_POOL_ALLOWANCE_YOCTO / 4n).toString())), ...sessionKeys.map((k) => fc(k, '1'))];
    expect(await lowOwnerAllowances(env)).toEqual([]);
    expect(await checkOwnerPoolAllowance(env)).toBe(0);
    expect(await events()).toEqual([]);
    // One view_access_key_list per check.
    expect(n.rpcMethods).toEqual(['query', 'query']);
  });

  it('below 25% of the initial allowance, or missing: one event per key and UTC day', async () => {
    const [low, ...rest] = ownerKeys;
    const below = (OWNER_POOL_ALLOWANCE_YOCTO / 4n - 1n).toString();
    n.accessKeyList = rest.map((k) => fc(k, OWNER_POOL_ALLOWANCE_YOCTO.toString())).concat([fc(low!, below)]);
    const now = Date.UTC(2026, 10, 2, 10);
    expect(await checkOwnerPoolAllowance(env, now)).toBe(1);
    expect(await checkOwnerPoolAllowance(env, now + 3_600_000)).toBe(0);
    let ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ org_id: null, app_id: null, scope_id: null, notified_at: null });
    expect(JSON.parse(ev[0]!.detail_json as string)).toEqual({
      publicKey: low,
      allowanceYocto: below,
      missing: false,
      initialYocto: OWNER_POOL_ALLOWANCE_YOCTO.toString(),
      thresholdPct: 25,
      day: '2026-11-02',
    });
    // The next UTC day reports it again; a key gone from the account is reported as missing.
    n.accessKeyList = [fc(low!, below)];
    expect(await checkOwnerPoolAllowance(env, now + DAY)).toBe(1 + rest.length);
    ev = await events();
    expect(ev).toHaveLength(2 + rest.length);
    expect(ev.map((e) => JSON.parse(e.detail_json as string)).filter((d) => d.missing).map((d) => d.publicKey).sort()).toEqual([...rest].sort());
  });

  it('NEAR RPC down: logged, nothing written, the cron is not failed', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    expect(await checkOwnerPoolAllowance(env)).toBe(0);
    expect(await events()).toEqual([]);
    expect(errors.join('\n')).toContain('owner_allowance_check');
  });

  it('no owner pool configured: nothing read', async () => {
    expect(await lowOwnerAllowances({ ...env, OWNER_RELAYER_KEYS: '' })).toEqual([]);
    expect(n.rpcMethods).toEqual([]);
  });
});
