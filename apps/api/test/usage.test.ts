// Usage capture (docs/batch-c-spec.md "Usage capture", tests "Topology and config" rows 1–2 and "Usage ledger"
// capture rows; docs/batch-c-build-plan.md C4). The ledger is the in-memory one of usage-ledger.ts unless a test puts
// pg itself back (realTransport) against a refusing server. Logins must never depend on it.
import { USAGE_ENDPOINTS, usageEventV1 } from '@hana-id/console-core';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import worker from '../src/index.ts';
import type { FinalOutcome } from '../src/near/rpc.ts';
import { burntGas } from '../src/near/tx.ts';
import { parseRelayerKeys } from '../src/relayer-config.ts';
import type { RelayResult } from '../src/relayer-key.ts';
import { IDENTITY_SYNC_DAYS, RECORD_IDENTITY_SQL, syncIdentityUsage } from '../src/usage/identity-sync.ts';
import { ENSURE_PARTITIONS_SQL, USAGE_PARTITION_MONTHS, ensureUsagePartitions } from '../src/usage/partitions.ts';
import { RECORD_EVENT_SQL, USAGE_RETRY_DELAY_MS, classifyWriteError, recordUsage, usageTransport } from '../src/usage/record.ts';
import { relayFacts, wasRelayed } from '../src/usage/event.ts';
import { ORIGIN, appHeaders, call, chain, deriveBody, newKey, newSessionKey, revokeBody, seedApp, seedPlan, sessionBody, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { MOCK_RECEIPT_GAS, MOCK_TX_GAS, panic } from './near-mock.ts';
import { eventFor, ledger, realTransport, usageOf } from './usage-ledger.ts';
import { act, createShare } from './vault-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const SUB = '1234567890';
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.clone().json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const NO_BINDING = { USAGE_DB: undefined };
/** An error as the server sends it (pg's DatabaseError, the only one classifyWriteError reads a SQLSTATE from). */
const dbError = (code: string) => Object.assign(new pg.DatabaseError('server said no', 0, 'error'), { code });
/** A server that refuses connections (nothing listens on the discard port): the real pg driver's failure path. */
const REFUSING = { USAGE_DB: { connectionString: 'postgresql://usage_writer:fake-pw-refused@127.0.0.1:9/usage' } as unknown as Hyperdrive };

/** Structured log lines of one level written while `fn` ran. */
async function logged<T>(fn: () => Promise<T>): Promise<{ value: T; lines: Record<string, unknown>[]; raw: string[] }> {
  const raw: string[] = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void raw.push(a.map(String).join(' ')));
  const value = await fn();
  const lines = raw.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { value, lines, raw };
}

async function loginSetup() {
  const app = await seedApp();
  const aud = newAud();
  const near = withCombinedCall(chain({ [aud]: app.scope }), { ckd: 'ok' });
  return { app, aud, near };
}

/** b64url of HMAC-SHA256(USER_ID_KEY, "hana-id/uid/v1" ‖ borsh(scope) ‖ borsh(provider) ‖ borsh(sub))[0..16], written
 * here without console-core (the independent implementation the API's uid is checked against). */
async function expectedUid(scope: string, provider: string, sub: string): Promise<string> {
  const enc = new TextEncoder();
  const borsh = (s: string): Uint8Array => {
    const b = enc.encode(s);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, true);
    out.set(b, 4);
    return out;
  };
  const parts = [enc.encode('hana-id/uid/v1'), borsh(scope), borsh(provider), borsh(sub)];
  const msg = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (msg.set(p, at), at + p.length), 0);
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(env.USER_ID_KEY!), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)).slice(0, 16);
  return btoa(String.fromCharCode(...mac)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** One of each captured endpoint for `app` (login, session, derive, revoke, unlock), all succeeding. */
async function everyEndpoint(bindings: Partial<typeof env> = {}): Promise<Response[]> {
  const { app, aud, near } = await loginSetup();
  const out: Response[] = [];
  out.push(await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: bindings }));
  const req = await sessionBody(app.scope, aud);
  out.push(await call('/v1/sessions', { headers: appHeaders(app), body: req, env: bindings }));
  const spk = req.sessionPublicKey as number[];
  out.push(await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk), env: bindings }));
  out.push(await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk), env: bindings }));
  const share = await createShare(app, near, { env: bindings });
  out.push(await act(app, share, 'unlock', 1, { env: bindings }));
  return out;
}

describe('logins never depend on the ledger', () => {
  it('with no USAGE_DB binding every captured endpoint answers and nothing is sent', async () => {
    const res = await everyEndpoint(NO_BINDING);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(ledger.calls).toEqual([]);
  });

  it('with USAGE_DB at a refusing server every endpoint answers the same status, body and headers; usage_write_failed once per request after one retry', async () => {
    usageTransport.query = realTransport;
    // Same-shaped requests with no binding and with the refusing one; only per-request values may differ.
    const shape = async (r: Response) => {
      const b = await body(r);
      // supportId: each run logs in a fresh scope, so its user's code differs (support-lookup.test.ts pins the value).
      const volatile = new Set(['requestId', 'nearTx', 'timings', 'session', 'shareId', 'ks', 'absExpiresAtMs', 'idleUntilMs', 'supportId']);
      const headers = [...r.headers].filter(([k]) => k !== 'x-request-id');
      const norm = JSON.parse(JSON.stringify(b, (k, v: unknown) => (volatile.has(k) ? typeof v : k === 'result' && v && typeof v === 'object' && 'path' in v ? 'session' : v))) as unknown;
      return { status: r.status, body: norm, headers };
    };
    const without = await everyEndpoint(NO_BINDING);
    const { value: refused, lines, raw } = await logged(() => everyEndpoint(REFUSING));
    expect(await Promise.all(refused.map(shape))).toEqual(await Promise.all(without.map(shape)));
    const failed = lines.filter((l) => l.event === 'usage_write_failed');
    // One per captured request (share creation isn't captured), each after its second attempt.
    expect(failed.map((l) => [l.endpoint, l.code, l.attempt])).toEqual(
      ['/v1/login', '/v1/sessions', '/v1/derive', '/v1/sessions/revoke', '/v1/vault/unlock'].map((e) => [e, 'connection', 2]),
    );
    expect(new Set(failed.map((l) => l.requestId)).size).toBe(5);
    // Nothing logged names the connection: no password, host or URL.
    expect(raw.join('\n')).not.toMatch(/fake-pw-refused|127\.0\.0\.1|postgresql:/u);
  });

  it('answers before the write: a ledger that never answers delays no response', async () => {
    usageTransport.query = () => new Promise<void>(() => undefined);
    const { app, aud } = await loginSetup();
    const pending: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), exec });
    expect(res.status).toBe(200);
    const settled = await Promise.race([Promise.all(pending).then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 100))]);
    expect(settled).toBe('pending');
  });

  it('a refused event is not retried, nor another server refusal; a transient error is, once; the login answers 200 throughout', async () => {
    const { app, aud } = await loginSetup();
    const login = async (fail: typeof ledger.fail) => {
      const req = await loginBody(app.scope, aud);
      ledger.calls = [];
      ledger.fail = fail;
      const { value, lines } = await logged(() => call('/v1/login', { headers: hanaHeaders(app), body: req }));
      expect(value.status).toBe(200);
      return { attempts: ledger.calls.length, logs: lines.filter((l) => String(l.event).startsWith('usage_write')).map((l) => `${l.event} ${l.code}`) };
    };
    const err = dbError;
    expect(await login(() => err('22023'))).toEqual({ attempts: 1, logs: ['usage_write_rejected pg_22023'] });
    expect(await login(() => err('23514'))).toEqual({ attempts: 1, logs: ['usage_write_failed pg_23514'] });
    expect(await login(() => err('57014'))).toEqual({ attempts: 2, logs: ['usage_write_failed pg_57014'] });
    expect(await login(() => new Error('Connection terminated unexpectedly'))).toEqual({ attempts: 2, logs: ['usage_write_failed connection'] });
    expect(usageOf(app.id)).toEqual([]);
  });

  it('a transient failure then success writes the event once, the retry USAGE_RETRY_DELAY_MS later', async () => {
    const { app, aud } = await loginSetup();
    const req = await loginBody(app.scope, aud);
    ledger.fail = (_sql, attempt) => (attempt === 1 ? new Error('Connection terminated unexpectedly') : undefined);
    const { value, lines } = await logged(() => call('/v1/login', { headers: hanaHeaders(app), body: req }));
    expect(value.status).toBe(200);
    expect(lines.filter((l) => String(l.event).startsWith('usage_write'))).toEqual([]);
    expect(ledger.calls.map((c) => c.sql)).toEqual([RECORD_EVENT_SQL, RECORD_EVENT_SQL]);
    const [first, second] = ledger.calls;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(USAGE_RETRY_DELAY_MS - 5);
    expect(usageOf(app.id)).toHaveLength(1);
  });

  it('classifies write errors: only the server’s DatabaseError has a SQLSTATE; a transient class retries; 22023 is a refused event; others fail', () => {
    expect(classifyWriteError(new Error('boom'))).toEqual({ kind: 'retry', code: 'connection' });
    // A socket's errno code, or anything shaped like a SQLSTATE that isn't the server's answer, is a connection error.
    for (const e of [{ code: 'ECONNREFUSED' }, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), { code: '22023' }, Object.assign(new Error('x'), { code: '23514' })]) {
      expect(classifyWriteError(e), JSON.stringify(e)).toEqual({ kind: 'retry', code: 'connection' });
    }
    for (const c of ['08006', '53300', '57014', '57P01', '58000', '40001']) expect(classifyWriteError(dbError(c)).kind, c).toBe('retry');
    expect(classifyWriteError(dbError('22023'))).toEqual({ kind: 'rejected', code: 'pg_22023' });
    for (const c of ['23514', '42501', '42883', '28P01']) expect(classifyWriteError(dbError(c)).kind, c).toBe('failed');
  });

  it('does all its work after the response: nothing is computed or sent before the first yield', async () => {
    const draft = { v: 1, request_id: 'req-after-response-1', at_ms: Date.now(), org_id: 'org_legacy', app_id: 'app_x', scope_id: 's1', endpoint: 'login', outcome: 'ok', code: null, status: 200, latency_ms: 1, relayed: false } as const;
    let resolved = false;
    const pending = recordUsage(env, draft, { path: `s1#google#${SUB}#0`, logEndpoint: '/v1/login' }).then(() => (resolved = true));
    // Microtasks (a handler returning its response) run before the yield ends.
    await Promise.resolve();
    await Promise.resolve();
    expect([ledger.calls.length, resolved]).toEqual([0, false]);
    await pending;
    expect(ledger.events.map((e) => e.request_id)).toEqual(['req-after-response-1']);
  });

  it('an event UsageEvent v1 refuses is never sent (usage_write_rejected)', async () => {
    const draft = { v: 1, request_id: 'req-bad-shape-1', at_ms: Date.now(), org_id: 'org_legacy', app_id: null, scope_id: 's1', endpoint: 'login', outcome: 'ok', code: null, status: 200, latency_ms: 1, relayed: false } as const;
    const { lines } = await logged(() => recordUsage(env, draft, { logEndpoint: '/v1/login' }));
    expect(ledger.calls).toEqual([]);
    expect(lines.map((l) => [l.event, l.code])).toEqual([['usage_write_rejected', 'invalid_event']]);
  });
});

describe('events', () => {
  it('one event per post-gate outcome on every endpoint; none for gate rejections or GET /v1/app', async () => {
    await seedPlan(`p${uid()}`, 1000, 100000, 1).catch(() => undefined);
    const { app, aud, near } = await loginSetup();
    const ids = async (r: Response) => (await body(r)).requestId as string;
    // Gate rejections: no key, an unknown key, a suspended app, a foreign origin, the per-IP limit; and GET /v1/app.
    const suspended = await seedApp({ suspendedBy: 1 });
    const plan = `tight${uid()}`;
    await seedPlan(plan, 1000, 100000, 1);
    const tight = await seedApp({ plan });
    const gated = [
      await call('/v1/sessions', { headers: { origin: ORIGIN }, body: {} }),
      await call('/v1/sessions', { headers: appHeaders({ key: newKey() }), body: {} }),
      await call('/v1/sessions', { headers: appHeaders(suspended), body: {} }),
      await call('/v1/derive', { headers: appHeaders(app, 'https://evil.example'), body: {} }),
      await call('/v1/login', { headers: { ...hanaHeaders(app), 'x-hana-parent-origin': 'https://evil.example' }, body: {} }),
      await call('/v1/sessions', { headers: { ...appHeaders(tight), 'cf-connecting-ip': '198.51.100.7' }, body: {} }),
      await call('/v1/sessions', { headers: { ...appHeaders(tight), 'cf-connecting-ip': '198.51.100.7' }, body: {} }),
      await call('/v1/app', { headers: appHeaders(app) }),
    ];
    expect(gated.map((r) => r.status)).toEqual([401, 401, 403, 403, 403, 400, 429, 200]);
    // The first tight request passed the gate (and failed on its body): it has its event; the 429 has none.
    expect(eventFor(await ids(gated[5]!))).toMatchObject({ outcome: 'rejected', code: 'bad_request', status: 400 });
    for (const r of [...gated.slice(0, 5), gated[6]!, gated[7]!]) expect(eventFor(await ids(r))).toBeUndefined();
    expect(ledger.events.filter((e) => e.app_id === suspended.id)).toEqual([]);

    // Post-gate outcomes of each endpoint, each recorded once with its status and code.
    const spk = newSessionKey();
    near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#${SUB}#0`, scope_id: app.scope, expires_at_ms: Date.now() + 3_600_000, max_uses: 10, used: 0 });
    const share = await createShare(app, near);
    const after = [
      await call('/v1/sessions', { headers: appHeaders(app), body: { nope: 1 } }),
      await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud, { signature: Array(64).fill(1) }) }),
      await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { signature: Array(64).fill(0) }) }),
      await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) }),
      await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk) }),
      await act(app, share, 'unlock', 5),
      await act(app, share, 'unlock', 1),
    ];
    const events = await Promise.all(after.map(async (r) => eventFor(await ids(r))));
    expect(events.map((e) => e && [e.endpoint, e.outcome, e.code, e.status])).toEqual([
      ['session', 'rejected', 'bad_request', 400],
      ['login', 'rejected', 'invalid_signature', 401],
      ['derive', 'rejected', 'invalid_signature', 401],
      ['derive', 'ok', null, 200],
      ['revoke', 'ok', null, 200],
      ['unlock', 'rejected', 'bad_counter', 409],
      ['unlock', 'ok', null, 200],
    ]);
    // Share creation and the other share actions are not captured.
    expect(usageOf(app.id).map((e) => e.endpoint)).toEqual(['session', 'login', 'derive', 'derive', 'revoke', 'unlock', 'unlock']);
    for (const e of ledger.events) expect(usageEventV1.safeParse(e).success).toBe(true);
  });

  it('allowlist snapshot: the event holds the UsageEvent v1 fields only, never a sub, JWT, email, IP or session key', async () => {
    const { app, aud } = await loginSetup();
    const req = await loginBody(app.scope, aud, {}, { email: 'someone@example.com' });
    const ip = '203.0.113.77';
    const res = await call('/v1/login', { headers: { ...hanaHeaders(app), 'cf-connecting-ip': ip }, body: req });
    // The login refuses a token with email (allow-list), so mint one without for the ok event.
    expect(res.status).toBe(400);
    const okReq = await loginBody(app.scope, aud);
    const ok = await call('/v1/login', { headers: { ...hanaHeaders(app), 'cf-connecting-ip': ip }, body: okReq });
    expect(ok.status).toBe(200);
    const e = eventFor((await body(ok)).requestId as string)!;
    expect(Object.keys(e).sort()).toEqual([
      'app_id', 'at_ms', 'code', 'endpoint', 'latency_ms', 'near_tx', 'org_id', 'outcome', 'relay_gas_burnt', 'relay_tokens_burnt_yocto',
      'relayed', 'relayer_nonce', 'relayer_pk', 'request_id', 'scope_id', 'status', 'uid', 'v',
    ]);
    expect(e).toMatchObject({ v: 1, endpoint: 'login', outcome: 'ok', code: null, status: 200, app_id: app.id, scope_id: app.scope, org_id: 'org_legacy', relayed: true });
    const spk = okReq.sessionPublicKey as number[];
    const text = JSON.stringify(usageOf(app.id));
    // The sub, both tokens, the email, the caller's IP, the session key (as bytes), and any derivation path.
    for (const secret of [SUB, req.jwt as string, okReq.jwt as string, 'someone@example.com', ip, JSON.stringify(spk), spk.join(','), '#google#']) {
      expect(text, secret.slice(0, 20)).not.toContain(secret);
    }
  });

  it('org_id is the gate row’s (the scope’s org when the request ran)', async () => {
    const { app, aud } = await loginSetup();
    await env.DB.prepare("UPDATE scopes SET org_id = 'org_partner_1' WHERE scope_id = ?1").bind(app.scope).run();
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    expect(usageOf(app.id).map((e) => e.org_id)).toEqual(['org_partner_1']);
  });

  it('relayed events name the pool key that signed, its nonce, the transaction and the provisional gas (BigInt sums)', async () => {
    const { app, aud, near } = await loginSetup();
    const sessionPool = parseRelayerKeys(env.RELAYER_KEYS, 'RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    near.contract.create_session_and_derive = () => panic('nope');
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(422);
    const [ok, rejected] = usageOf(app.id);
    for (const [e, tx] of [
      [ok!, near.sent[0]!],
      [rejected!, near.sent[1]!],
    ] as const) {
      expect(e.relayed).toBe(true);
      expect(e.near_tx).toBe(tx.hash);
      expect(e.relayer_pk).toBe(tx.publicKey);
      expect(sessionPool).toContain(e.relayer_pk);
      expect(e.relayer_nonce).toBe(tx.nonce.toString());
      // One conversion step and one receipt in the mock: their exact BigInt sums.
      expect(e.relay_gas_burnt).toBe((BigInt(MOCK_TX_GAS.gas_burnt) + BigInt(MOCK_RECEIPT_GAS.gas_burnt)).toString());
      expect(e.relay_tokens_burnt_yocto).toBe((BigInt(MOCK_TX_GAS.tokens_burnt) + BigInt(MOCK_RECEIPT_GAS.tokens_burnt)).toString());
    }
    expect(rejected).toMatchObject({ outcome: 'rejected', code: 'contract_rejected', status: 422 });
  });

  it('each relay code maps to relayed as the spec’s table says', () => {
    const fail = (code: string, nearTx?: string): RelayResult => ({ ok: false, status: 502, code, error: 'x', ...(nearTx ? { nearTx } : {}) });
    const tx = 'FbqJmVBv3Wv9ghTkw3wFpoXvWZQJaKdZmpWxE4CRWwBF';
    expect(wasRelayed({ ok: true, result: null, nearTx: tx })).toBe(true);
    for (const code of ['contract_rejected', 'timeout', 'near_error']) expect(wasRelayed(fail(code, tx)), code).toBe(true);
    // relayer_busy and near_rejected name a transaction that can never execute.
    for (const code of ['relayer_busy', 'near_rejected']) expect(wasRelayed(fail(code, tx)), code).toBe(false);
    for (const code of ['near_unavailable', 'relayer_unavailable', 'relayer_unconfigured', 'method_not_allowed', 'contract_rejected', 'timeout']) expect(wasRelayed(fail(code)), code).toBe(false);
    expect(relayFacts({ ok: true, result: null, nearTx: tx, relayerPk: 'ed25519:pk', relayerNonce: '7', relayGasBurnt: '1', relayTokensBurnt: '2' })).toEqual({
      relayed: true,
      near_tx: tx,
      relayer_pk: 'ed25519:pk',
      relayer_nonce: '7',
      relay_gas_burnt: '1',
      relay_tokens_burnt_yocto: '2',
    });
    expect(relayFacts(fail('relayer_busy', tx))).toEqual({ relayed: false, near_tx: tx });
    // Gas past the event's bounds is left out (both figures); the rest of the event stays.
    const big = { ok: true as const, result: null, nearTx: tx, relayerPk: 'ed25519:pk', relayerNonce: '7' };
    expect(relayFacts({ ...big, relayGasBurnt: (2n ** 63n).toString(), relayTokensBurnt: '2' })).toEqual({ relayed: true, near_tx: tx, relayer_pk: 'ed25519:pk', relayer_nonce: '7' });
    expect(relayFacts({ ...big, relayGasBurnt: '1', relayTokensBurnt: (10n ** 39n).toString() })).toEqual({ relayed: true, near_tx: tx, relayer_pk: 'ed25519:pk', relayer_nonce: '7' });
    expect(relayFacts({ ...big, relayGasBurnt: (2n ** 63n - 1n).toString(), relayTokensBurnt: (10n ** 39n - 1n).toString() })).toMatchObject({ relay_gas_burnt: (2n ** 63n - 1n).toString() });
  });

  it('a request that never reached the relay (an unlock, a refusal) is not relayed and names no transaction', async () => {
    const { app, aud } = await loginSetup();
    await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud, { signature: Array(64).fill(1) }) });
    expect(usageOf(app.id)).toEqual([expect.objectContaining({ relayed: false })]);
    expect(usageOf(app.id)[0]).not.toHaveProperty('near_tx');
  });

  it('a handler that throws past its gate is recorded as the router answers it: 500 internal', async () => {
    const { app, aud } = await loginSetup();
    // No relayer key namespace: the relay throws once every check passed.
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud), env: { RELAYER_KEY: undefined as unknown as typeof env.RELAYER_KEY } });
    expect(res.status).toBe(500);
    expect(usageOf(app.id).map((e) => [e.outcome, e.code, e.status])).toEqual([['error', 'internal', 500]]);
  });

  it('every endpoint name UsageEvent v1 knows is produced by some API path', async () => {
    const { USAGE_ENDPOINT } = await import('../src/usage/event.ts');
    expect([...new Set(Object.values(USAGE_ENDPOINT))].sort()).toEqual([...USAGE_ENDPOINTS].sort());
  });
});

describe('uid (a keyed pseudonym of the user in the scope, D96)', () => {
  it('is the same from the login, session and derive paths, ignores key_index, separates scopes, and matches an independent HMAC', async () => {
    const { app, aud, near } = await loginSetup();
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud, { keyIndex: 0 }) })).status).toBe(200);
    const req = await sessionBody(app.scope, aud, { keyIndex: 3 });
    expect((await call('/v1/sessions', { headers: appHeaders(app), body: req })).status).toBe(200);
    expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(req.sessionPublicKey as number[]) })).status).toBe(200);
    const want = await expectedUid(app.scope, 'google', SUB);
    expect(usageOf(app.id).map((e) => [e.endpoint, e.uid])).toEqual([
      ['login', want],
      ['session', want],
      ['derive', want],
    ]);
    // Another scope: the same Google user is another uid.
    const other = await seedApp();
    const otherAud = newAud();
    near.clients[otherAud] = other.scope;
    expect((await call('/v1/sessions', { headers: appHeaders(other), body: await sessionBody(other.scope, otherAud) })).status).toBe(200);
    const otherUid = usageOf(other.id)[0]!.uid;
    expect(otherUid).toBe(await expectedUid(other.scope, 'google', SUB));
    expect(otherUid).not.toBe(want);
  });

  it('none for a path that doesn’t parse for the scope (warned), nor on revoke, unlock or a refusal', async () => {
    const { app, near } = await loginSetup();
    const paths = [`${app.scope}#google#${SUB}`, `other#google#${SUB}#0`, `${app.scope}#google#${SUB}#0#x`];
    const { lines } = await logged(async () => {
      for (const path of paths) {
        const spk = newSessionKey();
        near.sessions.set(JSON.stringify(spk), { path, scope_id: app.scope, expires_at_ms: Date.now() + 3_600_000, max_uses: 10, used: 0 });
        expect((await call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk) })).status).toBe(200);
        expect((await call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk) })).status).toBe(200);
      }
    });
    expect(usageOf(app.id).map((e) => [e.endpoint, e.outcome, 'uid' in e])).toEqual(paths.flatMap(() => [['derive', 'ok', false], ['revoke', 'ok', false]]));
    expect(lines.filter((l) => l.event === 'usage_uid_unavailable').map((l) => l.code)).toEqual(['bad_path', 'bad_path', 'bad_path']);
    const share = await createShare(app, near);
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
    expect(usageOf(app.id).at(-1)).toMatchObject({ endpoint: 'unlock', outcome: 'ok' });
    expect(usageOf(app.id).at(-1)).not.toHaveProperty('uid');
  });

  it('without USER_ID_KEY events are still recorded, without a uid (warned once)', async () => {
    const { app, aud } = await loginSetup();
    const { lines } = await logged(async () => {
      for (let i = 0; i < 2; i++) expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { USER_ID_KEY: undefined } })).status).toBe(200);
    });
    expect(usageOf(app.id).map((e) => 'uid' in e)).toEqual([false, false]);
    expect(lines.filter((l) => l.event === 'usage_uid_unavailable').map((l) => l.code)).toEqual(['missing_key']);
  });
});

describe('session markers (the no_session waiver’s hot-DB sign, migration 0009)', () => {
  const marker = (appId: string) => env.DB.prepare('SELECT first_at FROM session_markers WHERE app_id = ?1').bind(appId).first<{ first_at: number }>();
  const firstSession = (scope: string) => env.DB.prepare('SELECT first_session_at FROM scopes WHERE scope_id = ?1').bind(scope).first<{ first_session_at: number | null }>();

  it('the first session-pool relay on a scope with no first_session_at writes it and the app’s marker, whatever the outcome', async () => {
    const app = await seedApp({ firstSession: null });
    const aud = newAud();
    const near = withCombinedCall(chain({ [aud]: app.scope }), { ckd: 'ok' });
    near.contract.create_session_and_derive = () => panic('nope');
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(422);
    expect((await firstSession(app.scope))!.first_session_at).toEqual(expect.any(Number));
    expect((await marker(app.id))!.first_at).toEqual(expect.any(Number));
  });

  it('nothing is written once the scope has first_session_at; a request refused before the relay writes neither', async () => {
    const seen = await seedApp();
    const aud = newAud();
    withCombinedCall(chain({ [aud]: seen.scope }), { ckd: 'ok' });
    expect((await call('/v1/login', { headers: hanaHeaders(seen), body: await loginBody(seen.scope, aud) })).status).toBe(200);
    expect(await marker(seen.id)).toBeNull();
    const fresh = await seedApp({ firstSession: null });
    chain({ [aud]: fresh.scope });
    expect((await call('/v1/sessions', { headers: appHeaders(fresh), body: { nope: 1 } })).status).toBe(400);
    expect(await marker(fresh.id)).toBeNull();
    expect((await firstSession(fresh.scope))!.first_session_at).toBeNull();
  });

  it('a lost scope write still leaves the marker (and the loss is logged)', async () => {
    const app = await seedApp({ firstSession: null });
    const aud = newAud();
    withCombinedCall(chain({ [aud]: app.scope }), { ckd: 'ok' });
    // A trigger that refuses the scope write only, as a failed D1 write would.
    await env.DB.prepare("CREATE TRIGGER IF NOT EXISTS test_lost_first_session BEFORE UPDATE OF first_session_at ON scopes WHEN NEW.scope_id LIKE 'lost%' BEGIN SELECT RAISE(ABORT, 'lost'); END").run();
    const lost = await seedApp({ firstSession: null, scope: `lost${uid()}` });
    withCombinedCall(chain({ [aud]: lost.scope }), { ckd: 'ok' });
    const { value, lines } = await logged(() => loginBody(lost.scope, aud).then((b) => call('/v1/login', { headers: hanaHeaders(lost), body: b })));
    await env.DB.prepare('DROP TRIGGER test_lost_first_session').run();
    expect(value.status).toBe(200);
    expect((await firstSession(lost.scope))!.first_session_at).toBeNull();
    expect(await marker(lost.id)).not.toBeNull();
    expect(lines.filter((l) => l.event === 'first_session_write_failed').map((l) => l.what)).toEqual(['scope']);
    void app;
  });
});

describe('identity token counts into the ledger (hourly)', () => {
  const day = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
  const DAY = 86_400_000;

  it('copies the last IDENTITY_SYNC_DAYS days per app with its org and scope; a replay never lowers a count', async () => {
    const app = await seedApp();
    await env.DB.prepare("UPDATE scopes SET org_id = 'org_ident' WHERE scope_id = ?1").bind(app.scope).run();
    for (const [ago, n] of [[0, 5], [(IDENTITY_SYNC_DAYS - 1) * DAY, 2], [IDENTITY_SYNC_DAYS * DAY, 9]] as const) {
      await env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, ?3)').bind(app.id, day(ago), n).run();
    }
    expect(await syncIdentityUsage(env)).toBeGreaterThanOrEqual(2);
    const mine = () => ledger.identity.filter((r) => r.app_id === app.id).sort((a, b) => a.day.localeCompare(b.day));
    expect(mine()).toEqual([
      { app_id: app.id, day: day((IDENTITY_SYNC_DAYS - 1) * DAY), org_id: 'org_ident', scope_id: app.scope, tokens: 2 },
      { app_id: app.id, day: day(0), org_id: 'org_ident', scope_id: app.scope, tokens: 5 },
    ]);
    await env.DB.prepare('UPDATE identity_usage SET tokens = 7 WHERE app_id = ?1 AND day = ?2').bind(app.id, day(0)).run();
    await syncIdentityUsage(env);
    expect(mine().map((r) => r.tokens)).toEqual([2, 7]);
    expect(ledger.calls.every((c) => c.sql === RECORD_IDENTITY_SQL)).toBe(true);
  });

  it('sends nothing without the binding; a failing ledger is logged and never throws', async () => {
    const app = await seedApp();
    await env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 1)').bind(app.id, day(0)).run();
    expect(await syncIdentityUsage({ ...env, USAGE_DB: undefined })).toBe(0);
    expect(ledger.calls).toEqual([]);
    ledger.fail = () => new Error('Connection terminated unexpectedly');
    const { value, lines } = await logged(() => syncIdentityUsage(env));
    expect(value).toBe(0);
    expect(lines.map((l) => [l.event, l.code])).toEqual([['identity_usage_sync_failed', 'connection']]);
  });

  it('the hourly cron run copies them; the quarter-hourly runs don’t', async () => {
    const app = await seedApp();
    await env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 3)').bind(app.id, day(0)).run();
    // A chain whose issuer keys match Google's JWKS, so the run's other jobs have nothing to do.
    const near = chain();
    near.views.get_key_changes = () => [];
    const hour = Date.UTC(2026, 10, 2, 10, 0, 0);
    const run = async (scheduledTime: number) => {
      const ctx = createExecutionContext();
      await logged(() => worker.scheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime }), env, ctx).catch(() => undefined));
      await waitOnExecutionContext(ctx);
    };
    await run(hour + 15 * 60_000);
    expect(ledger.identity.filter((r) => r.app_id === app.id)).toEqual([]);
    await run(hour);
    expect(ledger.identity.filter((r) => r.app_id === app.id).map((r) => r.tokens)).toEqual([3]);
    // The same hourly run keeps the ledger's partitions 12 months ahead (migrations-usage 0003); the quarter's didn't.
    expect(ledger.partitionCalls).toEqual([USAGE_PARTITION_MONTHS]);
    expect(USAGE_PARTITION_MONTHS).toBe(12);
  });

  it('a failing partition call is logged, never fails the cron, and the identity copy still runs', async () => {
    const app = await seedApp();
    await env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 4)').bind(app.id, day(0)).run();
    ledger.fail = (sql) => (sql === ENSURE_PARTITIONS_SQL ? dbError('42501') : undefined);
    const { value, lines } = await logged(() => ensureUsagePartitions(env));
    expect(value).toBe(false);
    expect(lines.map((l) => [l.event, l.code])).toEqual([['usage_partitions_failed', 'pg_42501']]);
    expect(await ensureUsagePartitions({ ...env, USAGE_DB: undefined })).toBe(true);
    expect(await syncIdentityUsage(env)).toBeGreaterThanOrEqual(1);
  });
});

describe('gas sums (near/tx.ts burntGas)', () => {
  /** The RPC's JSON is untyped: the fixture goes in as the RPC hands it over. */
  const gas = (o: unknown) => burntGas(o as Partial<FinalOutcome>);
  // Shaped as a create_session_and_derive at FINAL on testnet: the conversion step, the signer's receipt, the MPC's
  // yield/resume receipts and the gas refunds (0 gas, tokens burnt 0), with token amounts past 2^53.
  const outcome = {
    status: { SuccessValue: '' },
    transaction_outcome: { outcome: { gas_burnt: 2_428_158_088_232, tokens_burnt: '242815808823200000000' } },
    receipts_outcome: [
      { outcome: { gas_burnt: 21_872_349_118_391, tokens_burnt: '2187234911839100000000', status: { SuccessReceiptId: 'a' } } },
      { outcome: { gas_burnt: 4_934_418_219_458, tokens_burnt: '493441821945800000000', status: { SuccessReceiptId: 'b' } } },
      { outcome: { gas_burnt: 3_212_341_878_903, tokens_burnt: '321234187890300000000', status: { SuccessValue: '' } } },
      { outcome: { gas_burnt: 223_182_562_500, tokens_burnt: '0', status: { SuccessValue: '' } } },
      { outcome: { gas_burnt: 0, tokens_burnt: '0', status: { SuccessValue: '' } } },
    ],
  };

  it('sums gas_burnt and tokens_burnt exactly over the transaction and every receipt', () => {
    expect(gas(outcome)).toEqual({ gasBurnt: 32_670_449_867_484n, tokensBurnt: 3_244_726_730_498_400_000_000n });
    // Numbers would have lost the tokens' low digits.
    const asNumber = [outcome.transaction_outcome, ...outcome.receipts_outcome].reduce((n, s) => n + Number(s.outcome.tokens_burnt), 0);
    expect(BigInt(asNumber)).not.toBe(3_244_726_730_498_400_000_000n);
  });

  it('is null without a transaction outcome or with a malformed amount (never a guess)', () => {
    expect(gas({ status: { SuccessValue: '' }, receipts_outcome: outcome.receipts_outcome })).toBeNull();
    for (const bad of [-1, 1.5, '12a', '', '01', Number.MAX_SAFE_INTEGER + 2, `${2n ** 64n}`]) {
      expect(gas({ ...outcome, transaction_outcome: { outcome: { gas_burnt: bad as number, tokens_burnt: '0' } } }), String(bad)).toBeNull();
    }
    expect(gas({ ...outcome, transaction_outcome: { outcome: { gas_burnt: 1, tokens_burnt: `${2n ** 128n}` } } })).toBeNull();
    expect(gas({ ...outcome, transaction_outcome: { outcome: { gas_burnt: '18446744073709551615', tokens_burnt: '0' } }, receipts_outcome: [] })).toEqual({ gasBurnt: 2n ** 64n - 1n, tokensBurnt: 0n });
  });
});
