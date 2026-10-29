// GET /v1/governance (governance-status.ts): the read-only governance snapshot batch C's admin portal reads.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode } from '../src/bytes.ts';
import { GOVERNANCE_CACHE_MS, accessKeyStatus, jwksVerdict } from '../src/governance-status.ts';
import type { KeyChange } from '../src/issuer-keys.ts';
import { call } from './helpers.ts';
import { NearMock } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM issuer_key_proposals'), env.DB.prepare('DELETE FROM issuer_key_sync_runs')]);
});

const SIGNER = 'signer.test.near';
const NOW = Date.UTC(2026, 9, 29, 12, 0);
const n = (seed: number): string => base64UrlEncode(Uint8Array.from({ length: 256 }, (_, i) => (seed + i * 3) % 255 || 7));
const jwk = (kid: string, seed: number) => ({ kid, n: n(seed), e: 'AQAB', kty: 'RSA', alg: 'RS256', use: 'sig' });
const UPDATER_PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const OTHER_PK = 'ed25519:H9k5eiU4xhJGq6mMXyqdbmLLxwtF1bfNE5gR7jzjDbrv';
const FULL_PK = 'ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847';

const config = (extra: Record<string, unknown> = {}) => ({
  owner: 'hana-council.sputnikv2.testnet',
  mpc: 'mpc.test.near',
  ckd_domain_id: 2,
  console_audiences: [['google', 'console.apps.googleusercontent.com']],
  pending_console_audiences: [{ provider: 'google', aud: 'console2.apps.googleusercontent.com', effective_at_ms: NOW + 1000 }],
  sponsors: [],
  shared_clients: [],
  pending_shared_clients: [],
  change_delay_ms: 172_800_000,
  pending_change_delay: null,
  public_registration: false,
  issuer_key_delay_ms: 7_200_000,
  pending_issuer_key_delay: { change_delay_ms: 3_600_000, effective_at_ms: NOW + 259_200_000 },
  governance_delay_ms: 259_200_000,
  pending_governance_delay: null,
  paused: false,
  unpaused_at_ms: NOW - 3_600_000,
  changes_unlock_floor_ms: NOW + 169_200_000,
  sessions_valid_from_ms: NOW - 3_600_001,
  ...extra,
});

const governance = (extra: Record<string, unknown> = {}) => ({
  state_version: 2,
  watchdogs: [
    { account_id: 'hana-id-watchdog-dev1.testnet', confirm_from_ms: 0 },
    { account_id: 'watchdog-2.testnet', confirm_from_ms: NOW + 60_000 },
  ],
  keys_slow_until_ms: 0,
  updater_keys: [UPDATER_PK],
  updater_methods: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'],
  pending_upgrade: { code_hash: '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp', proposed_at_ms: NOW - 1000, executable_at_ms: NOW + 259_199_000 },
  pending_owner: { owner: 'new-dao.sputnikv2.testnet', acceptable_at_ms: NOW - 1 },
  pending_withdrawal: null,
  ...extra,
});

const changes: KeyChange[] = [
  { id: 7, provider: 'google', kid: 'k2', op: 'Add', n: n(2), e: 'AQAB', by: SIGNER, proposed_at_ms: NOW - 3_600_000, executable_at_ms: NOW + 3_600_000 },
  { id: 8, provider: 'google', kid: 'forged', op: 'Add', n: n(9), e: 'AQAB', by: SIGNER, proposed_at_ms: NOW - 7_200_000, executable_at_ms: NOW },
  { id: 9, provider: 'google', kid: 'k0', op: 'Remove', n: null, e: null, by: SIGNER, proposed_at_ms: NOW - 1, executable_at_ms: NOW + 1 },
];

const updaterKey = { public_key: UPDATER_PK, access_key: { nonce: 5, permission: { FunctionCall: { allowance: '1000000000000000000000000', receiver_id: SIGNER, method_names: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'] } } } };

function governanceChain(): NearMock {
  const near = new NearMock();
  near.views.get_config = () => config();
  near.views.get_governance = () => governance();
  near.views.get_key_changes = () => changes;
  near.views.get_issuer = (a) => (a.provider === 'google' ? { provider: 'google', iss_values: ['https://accounts.google.com'], kids: ['k0', 'k1'] } : null);
  near.accessKeyList = [
    updaterKey,
    { public_key: OTHER_PK, access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: SIGNER, method_names: ['set_issuer_key'] } } } },
    { public_key: FULL_PK, access_key: { nonce: 1, permission: 'FullAccess' } },
  ];
  near.jwks = { keys: [jwk('k1', 1), jwk('k2', 2), jwk('k0', 0)] };
  near.install();
  return near;
}

const get = async (): Promise<{ res: Response; body: Record<string, unknown> }> => {
  const res = await call('/v1/governance');
  return { res, body: (await res.json()) as Record<string, unknown> };
};

describe('GET /v1/governance', () => {
  it('summarises the chain, the JWKS and the access keys', async () => {
    governanceChain();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${GOVERNANCE_CACHE_MS / 1000}`);
    const { requestId, ...rest } = body;
    expect(typeof requestId).toBe('string');
    expect(rest).toEqual({
      signer: SIGNER,
      env: env.ENV_NAME,
      readAtMs: NOW,
      stateVersion: 2,
      paused: false,
      unpausedAtMs: NOW - 3_600_000,
      changesUnlockFloorMs: NOW + 169_200_000,
      sessionsValidFromMs: NOW - 3_600_001,
      delays: {
        issuerKeyDelayMs: 7_200_000,
        governanceDelayMs: 259_200_000,
        changeDelayMs: 172_800_000,
        pendingIssuerKeyDelay: { valueMs: 3_600_000, effectiveAtMs: NOW + 259_200_000 },
        pendingGovernanceDelay: null,
        pendingChangeDelay: null,
      },
      issuers: [{ provider: 'google', activeKids: ['k0', 'k1'], jwksKids: ['k1', 'k2', 'k0'] }],
      keyChanges: [
        { id: 7, provider: 'google', kid: 'k2', op: 'Add', by: SIGNER, proposedAtMs: NOW - 3_600_000, executableAtMs: NOW + 3_600_000, due: false, jwks: 'match' },
        { id: 8, provider: 'google', kid: 'forged', op: 'Add', by: SIGNER, proposedAtMs: NOW - 7_200_000, executableAtMs: NOW, due: true, jwks: 'absent' },
        { id: 9, provider: 'google', kid: 'k0', op: 'Remove', by: SIGNER, proposedAtMs: NOW - 1, executableAtMs: NOW + 1, due: false, jwks: 'present' },
      ],
      watchdogs: [
        { accountId: 'hana-id-watchdog-dev1.testnet', confirmFromMs: 0, canConfirm: true },
        { accountId: 'watchdog-2.testnet', confirmFromMs: NOW + 60_000, canConfirm: false },
      ],
      keysSlowUntilMs: 0,
      updaterKeys: [UPDATER_PK],
      updaterMethods: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'],
      signerAccessKeys: [
        { publicKey: UPDATER_PK, kind: 'function_call', receiverId: SIGNER, methodNames: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'], allowanceYocto: '1000000000000000000000000', updaterKey: true, updaterPermission: true },
        { publicKey: OTHER_PK, kind: 'function_call', receiverId: SIGNER, methodNames: ['set_issuer_key'], allowanceYocto: null, updaterKey: false, updaterPermission: false },
        { publicKey: FULL_PK, kind: 'full_access', receiverId: null, methodNames: null, allowanceYocto: null, updaterKey: false, updaterPermission: false },
      ],
      pendingUpgrade: { codeHash: '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp', proposedAtMs: NOW - 1000, executableAtMs: NOW + 259_199_000, due: false },
      pendingOwner: { owner: 'new-dao.sputnikv2.testnet', acceptableAtMs: NOW - 1, due: true },
      pendingWithdrawal: null,
      pendingConsoleAudiences: [{ provider: 'google', aud: 'console2.apps.googleusercontent.com', effectiveAtMs: NOW + 1000 }],
      pendingSharedClients: [],
      updater: { lastRuns: [], proposals: [] },
    });
  });

  it('includes the JWKS cron’s last run and the proposals it tracks', async () => {
    governanceChain();
    await env.DB.prepare("INSERT INTO issuer_key_sync_runs (provider, at_ms, outcome, code, summary) VALUES ('google', ?1, 'skipped', 'no_keys_updater_key', ?2)").bind(NOW - 60_000, JSON.stringify({ proposed: [], skipped: 'no_keys_updater_key' })).run();
    await env.DB.prepare("INSERT INTO issuer_key_proposals (provider, kid, op, change_id, proposed_at, cancelled_seen_at) VALUES ('google', 'k2', 'Add', 7, ?1, NULL), ('google', 'kx', 'Add', 3, ?2, ?1)").bind(NOW - 3_600_000, NOW - 7_200_000).run();
    const { body } = await get();
    expect(body.updater).toEqual({
      lastRuns: [{ provider: 'google', atMs: NOW - 60_000, outcome: 'skipped', code: 'no_keys_updater_key', summary: { proposed: [], skipped: 'no_keys_updater_key' } }],
      proposals: [
        { provider: 'google', kid: 'kx', op: 'Add', changeId: 3, proposedAtMs: NOW - 7_200_000, cancelledSeenAtMs: NOW - 3_600_000 },
        { provider: 'google', kid: 'k2', op: 'Add', changeId: 7, proposedAtMs: NOW - 3_600_000, cancelledSeenAtMs: null },
      ],
    });
  });

  it('serves one snapshot per isolate for GOVERNANCE_CACHE_MS', async () => {
    const near = governanceChain();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.body.readAtMs).toBe(NOW);
    expect(b.body.readAtMs).toBe(NOW);
    const reads = (): number => near.viewCalls.filter((v) => v.method === 'get_governance').length;
    expect(reads()).toBe(1);
    near.views.get_config = () => config({ paused: true });
    vi.spyOn(Date, 'now').mockReturnValue(NOW + GOVERNANCE_CACHE_MS - 1);
    expect((await get()).body.paused).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + GOVERNANCE_CACHE_MS);
    expect((await get()).body).toMatchObject({ paused: true, readAtMs: NOW + GOVERNANCE_CACHE_MS });
    expect(reads()).toBe(2);
  });

  it('degrades only the parts that aren’t contract views: access keys, JWKS, D1', async () => {
    const near = governanceChain();
    near.jwksStatus = 500;
    near.accessKeyList = [{ public_key: 5 }];
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body.signerAccessKeys).toBeNull();
    expect((body.keyChanges as { jwks: string }[]).map((c) => c.jwks)).toEqual(['unknown', 'unknown', 'unknown']);
    expect((body.issuers as { jwksKids: unknown }[])[0]!.jwksKids).toBeNull();
  });

  it('502 when a contract view fails or answers in an unknown shape (e.g. a contract still on v1)', async () => {
    const near = governanceChain();
    delete near.views.get_governance;
    let r = await get();
    expect([r.res.status, r.body.code]).toEqual([502, 'near_unavailable']);
    near.views.get_governance = () => governance({ watchdogs: 'none' });
    r = await get();
    expect([r.res.status, r.body.code]).toEqual([502, 'bad_contract_result']);
    near.views.get_governance = () => governance();
    near.views.get_key_changes = () => [{ id: 1 }];
    r = await get();
    expect([r.res.status, r.body.code]).toEqual([502, 'bad_contract_result']);
    near.views.get_key_changes = () => changes;
    near.views.get_config = () => config({ paused: 'no' });
    r = await get();
    expect([r.res.status, r.body.code]).toEqual([502, 'bad_contract_result']);
  });

  it('is read-only: GET, HEAD and OPTIONS only, and it sends no transaction', async () => {
    const near = governanceChain();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await call('/v1/governance', { method, body: {} });
      expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET']);
    }
    expect((await call('/v1/governance', { method: 'OPTIONS' })).status).toBe(204);
    expect((await call('/v1/governance', { method: 'HEAD' })).status).toBe(200);
    expect(near.sent).toHaveLength(0);
    expect(near.rpcMethods.every((m) => m === 'query')).toBe(true);
  });

  it('never carries a secret', async () => {
    governanceChain();
    const text = await (await call('/v1/governance')).text();
    expect(text).not.toContain(env.KEYS_UPDATER_KEY!);
    for (const k of JSON.parse(env.RELAYER_KEYS) as string[]) expect(text).not.toContain(k);
    expect(text).not.toMatch(/private_key|secret/iu);
  });
});

describe('verdicts', () => {
  const add = (kid: string, seed: number): KeyChange => ({ id: 1, provider: 'google', kid, op: 'Add', n: n(seed), e: 'AQAB', by: SIGNER, proposed_at_ms: 0, executable_at_ms: 0 });

  it('compares a pending change with the JWKS', () => {
    const keys = [jwk('a', 1)];
    expect(jwksVerdict(add('a', 1), keys)).toBe('match');
    expect(jwksVerdict(add('a', 2), keys)).toBe('mismatch');
    expect(jwksVerdict(add('b', 1), keys)).toBe('absent');
    expect(jwksVerdict({ ...add('a', 1), op: 'Remove', n: null, e: null }, keys)).toBe('present');
    expect(jwksVerdict({ ...add('b', 1), op: 'Remove', n: null, e: null }, keys)).toBe('absent');
    expect(jwksVerdict(add('a', 1), null)).toBe('unknown');
  });

  it('flags an updater key whose permission isn’t exactly the updater’s', () => {
    const fc = (o: Record<string, unknown>) => ({ public_key: UPDATER_PK, access_key: { nonce: 1, permission: { FunctionCall: { allowance: '1000000000000000000000000', receiver_id: SIGNER, method_names: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'], ...o } } } });
    expect(accessKeyStatus(fc({}) as never, SIGNER, [UPDATER_PK]).updaterPermission).toBe(true);
    expect(accessKeyStatus(fc({ allowance: '1000000000000000000000001' }) as never, SIGNER, [UPDATER_PK]).updaterPermission).toBe(false);
    expect(accessKeyStatus(fc({ allowance: null }) as never, SIGNER, [UPDATER_PK]).updaterPermission).toBe(false);
    expect(accessKeyStatus(fc({ receiver_id: 'other.near' }) as never, SIGNER, [UPDATER_PK]).updaterPermission).toBe(false);
    expect(accessKeyStatus(fc({ method_names: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change', 'remove_issuer_key'] }) as never, SIGNER, [UPDATER_PK]).updaterPermission).toBe(false);
    expect(accessKeyStatus(fc({ method_names: [] }) as never, SIGNER, [UPDATER_PK]).updaterPermission).toBe(false);
    expect(accessKeyStatus(fc({}) as never, SIGNER, []).updaterKey).toBe(false);
  });
});
