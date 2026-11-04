import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_CLAIMS } from '../src/claims.ts';
import { DEFAULT_GAS_TGAS, TGAS } from '../src/gas.ts';
import { EXPORTS_PER_PATH_HOUR, exportLimiterKey, loginFailure } from '../src/login.ts';
import { failedExecutor } from '../src/near/tx.ts';
import { ORIGIN, appHeaders, bytes, call, chain, newSessionKey, seedApp, sessionBody, uid } from './helpers.ts';
import { AUTH, VAULT, appKey, hanaHeaders, loginBody, mismatchedAppKey, withCombinedCall } from './login-helpers.ts';
import { panic, receiptFailure } from './near-mock.ts';
import { usageOf } from './usage-ledger.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const newAud = (): string => `${uid()}.apps.googleusercontent.com`;
const login = (app: { key: string }, req: unknown, headers: Record<string, string> = hanaHeaders(app), bindings?: Partial<typeof env>): Promise<Response> =>
  call('/v1/login', { headers, body: req, env: bindings });

/** The app's usage events (the in-memory ledger, usage-ledger.ts) as `outcome[ code] relayed|-`, in order. */
const usage = (appId: string): string[] => usageOf(appId).map((e) => [e.endpoint, e.outcome, e.code, e.relayed ? 'relayed' : '-'].filter(Boolean).join(' '));

/** An app whose own Google client is `aud`, on a chain that runs the combined call. */
async function setup(opts: { ckd?: 'ok' | 'fail' | 'pairing' } = {}) {
  const app = await seedApp();
  const aud = newAud();
  const near = withCombinedCall(chain({ [aud]: app.scope }), opts);
  return { app, aud, near };
}

describe('POST /v1/login', () => {
  it('relays create_session_and_derive with 150 Tgas and answers the CKD result, the session and the tx', async () => {
    const { app, aud, near } = await setup();
    const req = await loginBody(app.scope, aud);
    const res = await login(app, req);
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json).toEqual({
      result: { big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' },
      session: { scope_id: app.scope, expires_at_ms: req.expiresAtMs, max_uses: 1, used: 1 },
      nearTx: expect.any(String),
      // A pk_test_ app: the request's own timings (test/timings.test.ts).
      timings: { totalMs: expect.any(Number), phases: expect.any(Object) },
      requestId: expect.any(String),
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(VAULT);
    expect(near.sent).toHaveLength(1);
    const tx = near.sent[0]!;
    expect([tx.receiverId, tx.signerId, tx.method]).toEqual([env.SIGNER_ACCOUNT, env.RELAYER_ACCOUNT, 'create_session_and_derive']);
    // D155: 150 Tgas covers a 4096-bit issuer key (≈ 89 needed).
    expect(tx.gas).toBe(150n * TGAS);
    expect(DEFAULT_GAS_TGAS.create_session_and_derive).toBe(150);
    expect(tx.args).toEqual({
      jwt: req.jwt,
      scope_id: app.scope,
      session_public_key: req.sessionPublicKey,
      expires_at_ms: req.expiresAtMs,
      salt: req.salt,
      key_index: 0,
      max_uses: 1,
      signature: req.signature,
      pk1: req.pk1,
      pk2: req.pk2,
    });
    // get_config first: the session standing (session-standing.ts) reads it (cached) to know whether links can exist;
    // on a chain without them nothing else is read for it.
    expect(near.viewCalls).toEqual([
      { method: 'get_config', args: {} },
      { method: 'scope_for_client', args: { provider: 'google', aud } },
      { method: 'session_key_in_use', args: { session_public_key: req.sessionPublicKey } },
      { method: 'get_issuer', args: { provider: 'google' } },
    ]);
    expect(usage(app.id)).toEqual(['login ok relayed']);
    // The session is committed with its use spent.
    expect(near.sessions.get(JSON.stringify(req.sessionPublicKey))).toMatchObject({ used: 1, max_uses: 1 });
  });

  it('serves the export window on authOrigin, never a partner page (any key, any env)', async () => {
    const { app, aud, near } = await setup();
    expect((await login(app, await loginBody(app.scope, aud), hanaHeaders(app, AUTH))).status).toBe(200);
    for (const bindings of [undefined, { ENV_NAME: 'prod' }]) {
      const res = await login(app, await loginBody(app.scope, aud), appHeaders(app), bindings);
      expect([res.status, (await body(res)).code]).toEqual([403, 'origin_not_allowed']);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(near.sent).toHaveLength(1);
  });

  it('limits exports (the auth origin) to 3 per hour per user path per app, counted only for a verified token', async () => {
    expect(EXPORTS_PER_PATH_HOUR).toBe(3);
    const { app, aud, near } = await setup();
    const exportLogin = async (claims: Record<string, unknown> = {}, target = app, client = aud) => login(target, await loginBody(target.scope, client, {}, claims), hanaHeaders(target, AUTH));
    // A refused token costs nothing.
    const bad = await login(app, await loginBody(app.scope, aud, {}, { nonce: 'A'.repeat(43) }), hanaHeaders(app, AUTH));
    expect((await body(bad)).code).toBe('nonce_mismatch');
    for (let i = 0; i < EXPORTS_PER_PATH_HOUR; i++) expect((await exportLogin()).status).toBe(200);
    const over = await exportLogin();
    expect([over.status, (await body(over)).code]).toEqual([429, 'rate_limited']);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(near.sent).toHaveLength(EXPORTS_PER_PATH_HOUR);
    // The vault's own logins aren't exports; another user, and the same user in another app, have their own count.
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(200);
    expect((await exportLogin({ sub: '209384756102938475610' })).status).toBe(200);
    const other = await seedApp();
    const otherAud = newAud();
    withCombinedCall(chain({ [aud]: app.scope, [otherAud]: other.scope }));
    expect((await exportLogin({}, other, otherAud)).status).toBe(200);
  });

  it('keys the export limit by app and a hash of the path (no Google sub in the key)', async () => {
    const path = 's1#google#110248495921238986420#0';
    const key = await exportLimiterKey('app_1', path);
    expect(key).toMatch(/^export:app_1:[0-9a-f]{64}$/u);
    expect(key).not.toContain('110248495921238986420');
    expect(await exportLimiterKey('app_2', path)).not.toBe(key);
    expect(await exportLimiterKey('app_1', 's1#google#110248495921238986420#1')).not.toBe(key);
  });

  it('503 when the export limiter is unavailable: nothing is relayed', async () => {
    const { app, aud, near } = await setup();
    vi.spyOn(env.RATE_LIMITER, 'idFromName').mockImplementation(() => {
      throw new Error('DO down');
    });
    const res = await login(app, await loginBody(app.scope, aud), hanaHeaders(app, AUTH));
    expect(res.status).toBe(503);
    expect(near.sent).toHaveLength(0);
  });

  it('checks x-hana-parent-origin against the app’s origins (and still answers the Hana page in CORS)', async () => {
    const { app, aud, near } = await setup();
    for (const parent of [null, 'https://evil.example', `${ORIGIN}/`, VAULT]) {
      const res = await login(app, await loginBody(app.scope, aud), hanaHeaders(app, VAULT, parent));
      expect([res.status, (await body(res)).code], String(parent)).toEqual([403, 'origin_not_allowed']);
      expect(res.headers.get('access-control-allow-origin')).toBe(VAULT);
    }
    expect(near.sent).toHaveLength(0);
  });

  it('refuses malformed bodies before reading the token', async () => {
    const { app, aud, near } = await setup();
    const valid = await loginBody(app.scope, aud);
    const { signature: _s, ...noSignature } = valid;
    const cases: Record<string, unknown>[] = [
      noSignature,
      { ...valid, signature: (valid.signature as number[]).slice(0, 63) },
      { ...valid, pk1: 'bls12381g2:abc' },
      { ...valid, pk2: 'x'.repeat(400) },
      { ...valid, scopeId: app.scope },
      { ...valid, counter: 1 },
      { ...valid, extra: true },
      { ...valid, keyIndex: 0x8000_0000 },
      { ...valid, keyIndex: 0xffff_ffff },
      { ...valid, maxUses: 0 },
    ];
    for (const req of cases) {
      const res = await login(app, req);
      expect([res.status, (await body(res)).code], JSON.stringify(Object.keys(req))).toEqual([400, 'bad_request']);
    }
    for (const raw of ['[]', '"x"', 'not json']) {
      expect((await call('/v1/login', { headers: { ...hanaHeaders(app), 'content-type': 'application/json' }, rawBody: raw })).status).toBe(400);
    }
    expect((await call('/v1/login', { headers: hanaHeaders(app), rawBody: 'x'.repeat(17 * 1024) })).status).toBe(413);
    expect(near.sent).toHaveLength(0);
    expect(near.viewCalls).toHaveLength(0);
  });

  it('accepts key_index 2^31 − 1, the last unreserved one', async () => {
    const { app, aud, near } = await setup();
    const res = await login(app, await loginBody(app.scope, aud, { keyIndex: 0x7fff_ffff }));
    expect(res.status).toBe(200);
    expect(near.sent[0]!.args.key_index).toBe(0x7fff_ffff);
  });

  it('refuses bad tokens: signature, issuer, expiry, nonce', async () => {
    const { app, aud, near } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const cases: [Record<string, unknown>, number, string][] = [
      [await loginBody(app.scope, aud, { jwt: 'aaaa.bbbb.cccc' }), 401, 'invalid_token'],
      [await loginBody(app.scope, aud, {}, { iss: 'https://evil.example' }), 400, 'unsupported_issuer'],
      [await loginBody(app.scope, aud, {}, { exp: now - 120 }), 400, 'token_expired'],
      [await loginBody(app.scope, aud, {}, { nonce: 'other' }), 400, 'nonce_mismatch'],
      [await loginBody(app.scope, aud, {}, { nonce: undefined }), 400, 'nonce_mismatch'],
    ];
    for (const [req, status, code] of cases) {
      const res = await login(app, req);
      expect([res.status, (await body(res)).code], code).toEqual([status, code]);
    }
    // A body changed after the token committed to it.
    const req = await loginBody(app.scope, aud);
    const changed = await login(app, { ...req, salt: bytes(16, 99) });
    expect((await body(changed)).code).toBe('nonce_mismatch');
    expect(near.sent).toHaveLength(0);
  });

  it('claim allow-list: every other claim gives token_has_pii with its name; every allowed claim passes', async () => {
    const { app, aud, near } = await setup();
    const refused = ['email', 'email_verified', 'name', 'picture', 'given_name', 'family_name', 'hd', 'locale', 'profile', 'something_new'];
    for (const claim of refused) {
      const res = await login(app, await loginBody(app.scope, aud, {}, { [claim]: claim === 'email_verified' ? true : 'x' }));
      expect([res.status, await body(res)], claim).toEqual([400, expect.objectContaining({ code: 'token_has_pii', data: { claim } })]);
    }
    expect(near.sent).toHaveLength(0);
    // The spike's exact openid-only claim set, plus auth_time: all allowed.
    expect([...ALLOWED_CLAIMS].sort()).toEqual(['aud', 'auth_time', 'azp', 'exp', 'iat', 'iss', 'jti', 'nbf', 'nonce', 'sub']);
    const now = Math.floor(Date.now() / 1000);
    const res = await login(app, await loginBody(app.scope, aud, {}, { azp: aud, iat: now, nbf: now - 5, jti: 'j1', auth_time: now }));
    expect(res.status).toBe(200);
  });

  it('checks the client’s scope and that the session key is unused, before relaying', async () => {
    const { app, aud, near } = await setup();
    const other = newAud();
    near.clients[other] = 'sother';
    const wrong = await login(app, await loginBody(app.scope, other));
    expect([wrong.status, (await body(wrong)).code]).toEqual([403, 'scope_mismatch']);
    const unregistered = await login(app, await loginBody(app.scope, newAud()));
    expect([unregistered.status, (await body(unregistered)).code]).toEqual([403, 'unregistered_client']);

    const req = await loginBody(app.scope, aud);
    expect((await login(app, req)).status).toBe(200);
    // The same body again (a replay, or a client retry): the key holds a session now.
    const again = await login(app, req);
    expect([again.status, (await body(again)).code]).toEqual([409, 'session_exists']);
    expect(near.sent).toHaveLength(1);
  });

  it('502 near_unavailable when scope_for_client, or separately session_key_in_use, can’t be read; nothing is sent', async () => {
    for (const view of ['scope_for_client', 'session_key_in_use'] as const) {
      const { app, aud, near } = await setup();
      // The node answers the view with an error (as for a contract it can't run).
      delete near.views[view];
      const res = await login(app, await loginBody(app.scope, aud));
      expect([res.status, (await body(res)).code]).toEqual([502, 'near_unavailable']);
      expect(near.viewCalls.map((c) => c.method)).toContain(view);
      expect(near.sent).toHaveLength(0);
      expect(usage(app.id)).toEqual(['login error near_unavailable -']);
    }
  });

  it('503 issuer_keys_unavailable when Google’s JWKS can’t be fetched; nothing is read or sent', async () => {
    const { app, aud, near } = await setup();
    near.jwksStatus = 500;
    const res = await login(app, await loginBody(app.scope, aud));
    expect([res.status, (await body(res)).code]).toEqual([503, 'issuer_keys_unavailable']);
    expect(near.jwksFetches).toBe(1);
    expect(near.viewCalls).toEqual([]);
    expect(near.sent).toHaveLength(0);
  });

  it('502 bad_contract_result with the transaction when the call succeeds without big_y/big_c', async () => {
    const { app, aud, near } = await setup();
    for (const value of [{}, { big_y: 'bls12381g1:Y' }, null]) {
      near.contract.create_session_and_derive = () => value;
      const res = await login(app, await loginBody(app.scope, aud));
      expect([res.status, await body(res)]).toEqual([502, expect.objectContaining({ code: 'bad_contract_result', nearTx: expect.any(String) })]);
    }
    expect(near.sent).toHaveLength(3);
    expect(usage(app.id)).toEqual(Array(3).fill('login error bad_contract_result relayed'));
  });

  it('shared login: a shared client into a scope that allows it', async () => {
    const app = await seedApp();
    const shared = newAud();
    const near = withCombinedCall(chain({}, { shared: [shared], allowShared: [app.scope] }));
    expect((await login(app, await loginBody(app.scope, shared))).status).toBe(200);
    const closed = await seedApp();
    const res = await login(closed, await loginBody(closed.scope, shared), hanaHeaders(closed));
    expect([res.status, (await body(res)).code]).toEqual([403, 'shared_login_disabled']);
    expect(near.sent).toHaveLength(1);
  });

  it('refuses a signature that is not the session key’s over counter 1 of this CKD request', async () => {
    const { app, aud, near } = await setup();
    const req = await loginBody(app.scope, aud);
    const { signSession } = await import('./helpers.ts');
    const { ckdPayload } = await import('../src/session-crypto.ts');
    const spk = req.sessionPublicKey as number[];
    const cases = [
      await signSession(spk, 2, ckdPayload(req.pk1 as string, req.pk2 as string)),
      await signSession(spk, 1, ckdPayload(appKey().pk1, req.pk2 as string)),
      await signSession(newSessionKey(), 1, ckdPayload(req.pk1 as string, req.pk2 as string)),
      Array(64).fill(0),
    ];
    for (const signature of cases) {
      const res = await login(app, { ...req, signature });
      expect([res.status, (await body(res)).code]).toEqual([401, 'invalid_signature']);
    }
    expect(near.sent).toHaveLength(0);
  });

  it('refuses app keys that are not one compressed, non-identity point each (always on)', async () => {
    const { app, aud, near } = await setup();
    const { baseEncode } = await import('@near-js/utils');
    const good = appKey();
    const g1 = (b: Uint8Array): string => `bls12381g1:${baseEncode(b)}`;
    const g2 = (b: Uint8Array): string => `bls12381g2:${baseEncode(b)}`;
    const identity1 = new Uint8Array(48);
    identity1[0] = 0xc0;
    const identity2 = new Uint8Array(96);
    identity2[0] = 0xc0;
    const uncompressed = new Uint8Array(48);
    uncompressed[0] = 0x17;
    const cases: { pk1: string; pk2: string }[] = [
      { pk1: g1(new Uint8Array(47).fill(0x99)), pk2: good.pk2 },
      { pk1: g1(identity1), pk2: good.pk2 },
      { pk1: g1(uncompressed), pk2: good.pk2 },
      { pk1: good.pk1, pk2: g2(identity2) },
      { pk1: good.pk1, pk2: g2(new Uint8Array(48).fill(0x99)) },
      { pk1: 'bls12381g1:0OIl', pk2: good.pk2 },
    ];
    for (const key of cases) {
      const res = await login(app, await loginBody(app.scope, aud, {}, {}, key));
      expect([res.status, (await body(res)).code], JSON.stringify(key)).toEqual([400, 'invalid_app_key']);
    }
    expect(near.sent).toHaveLength(0);
  });

  it('BLS_PRECHECK = "1": a pk1/pk2 pair that fails the pairing is refused before relaying', async () => {
    const { app, aud, near } = await setup();
    const on = { BLS_PRECHECK: '1' };
    const bad = await login(app, await loginBody(app.scope, aud, {}, {}, mismatchedAppKey()), hanaHeaders(app), on);
    expect([bad.status, (await body(bad)).code]).toEqual([400, 'invalid_app_key']);
    // Well-formed bytes (flags, length) that are not a point of G1's prime-order subgroup: x = 0 is on the curve
    // (y² = 4) but outside the subgroup.
    const { baseEncode } = await import('@near-js/utils');
    const x0 = new Uint8Array(48);
    x0[0] = 0x80;
    const outside = { pk1: `bls12381g1:${baseEncode(x0)}`, pk2: appKey().pk2 };
    const off = await login(app, await loginBody(app.scope, aud, {}, {}, outside), hanaHeaders(app), on);
    expect((await body(off)).code).toBe('invalid_app_key');
    expect(near.sent).toHaveLength(0);
    expect((await login(app, await loginBody(app.scope, aud), hanaHeaders(app), on)).status).toBe(200);
  });

  it('BLS_PRECHECK = "0": no pairing check, so a bad pair is relayed and the MPC’s refusal maps to ckd_failed', async () => {
    const { app, aud, near } = await setup();
    const res = await login(app, await loginBody(app.scope, aud, {}, {}, mismatchedAppKey()));
    expect([res.status, await body(res)]).toEqual([422, expect.objectContaining({ code: 'ckd_failed', session: { used: 1 }, nearTx: expect.any(String) })]);
    expect(near.sent).toHaveLength(1);
  });

  it('maps failures by the failing receipt’s executor', async () => {
    const { app, aud, near } = await setup();
    const run = async (outcome: () => unknown): Promise<[number, Record<string, unknown>]> => {
      near.contract.create_session_and_derive = outcome;
      const res = await login(app, await loginBody(app.scope, aud));
      return [res.status, await body(res)];
    };
    // Signer receipt: the whole call reverted.
    const inUse = await run(() => {
      throw new Error('Session key already in use');
    });
    expect(inUse).toEqual([422, expect.objectContaining({ code: 'contract_rejected', reason: 'session_key_in_use', nearTx: expect.any(String) })]);
    const otherPanic = await run(() => panic('Session expiry out of range'));
    expect(otherPanic[0]).toBe(422);
    expect(otherPanic[1]).toMatchObject({ code: 'contract_rejected' });
    expect(otherPanic[1]).not.toHaveProperty('reason');
    // MPC receipt: the session was committed.
    expect(await run(() => receiptFailure(env.MPC_ACCOUNT, 'CKD timed out'))).toEqual([422, expect.objectContaining({ code: 'ckd_failed', session: { used: 1 } })]);
    // Any other executor, or none.
    for (const executor of ['someone.test.near', null]) {
      expect(await run(() => receiptFailure(executor, 'odd'))).toEqual([502, expect.objectContaining({ code: 'near_error', nearTx: expect.any(String) })]);
    }
  });

  it('failedExecutor: the executor of the first failed receipt, or null', () => {
    const fail = { Failure: { ActionError: {} } };
    const r = (executor_id: string | undefined, status: unknown) => ({ outcome: { executor_id, status } as { executor_id?: string; status: { Failure?: unknown } } });
    expect(failedExecutor({ status: fail, receipts_outcome: [r('signer', { SuccessReceiptId: 'x' }), r('mpc', fail), r('other', fail)] })).toBe('mpc');
    expect(failedExecutor({ status: fail, receipts_outcome: [r('signer', fail)] })).toBe('signer');
    expect(failedExecutor({ status: fail, receipts_outcome: [] })).toBeNull();
    expect(failedExecutor({ status: fail })).toBeNull();
    expect(failedExecutor({ status: fail, receipts_outcome: [r(undefined, fail)] })).toBeNull();
    expect(failedExecutor({ status: { SuccessValue: '' }, receipts_outcome: [r('signer', { SuccessValue: '' })] })).toBeNull();
  });

  it('loginFailure keeps relayer codes and never matches an unset MPC account', () => {
    const e = { SIGNER_ACCOUNT: 'signer.near', MPC_ACCOUNT: '' };
    expect(loginFailure(e, { ok: false, status: 503, code: 'relayer_busy', error: 'x', nearTx: 't' })).toEqual({ status: 503, body: { error: 'x', code: 'relayer_busy', nearTx: 't' } });
    expect(loginFailure(e, { ok: false, status: 422, code: 'contract_rejected', error: 'x', nearTx: 't', executor: '' }).body.code).toBe('near_error');
    expect(loginFailure(e, { ok: false, status: 422, code: 'contract_rejected', error: 'x', nearTx: 't' }).body.code).toBe('near_error');
  });

  it('records one event per login: ckd_failed and a contract rejection as rejected relayed calls, a success as ok with a uid', async () => {
    const { app, aud, near } = await setup({ ckd: 'fail' });
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(422);
    expect(usage(app.id)).toEqual(['login rejected ckd_failed relayed']);
    near.contract.create_session_and_derive = () => panic('nope');
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(422);
    expect(usage(app.id)).toEqual(['login rejected ckd_failed relayed', 'login rejected contract_rejected relayed']);
    withCombinedCall(near, { ckd: 'ok' });
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(200);
    expect(usage(app.id)).toEqual(['login rejected ckd_failed relayed', 'login rejected contract_rejected relayed', 'login ok relayed']);
    expect(usageOf(app.id).map((e) => e.uid !== undefined)).toEqual([false, false, true]);
  });

  it('an unknown outcome is 504 timeout with the transaction', async () => {
    const { app, aud, near } = await setup();
    const req = await loginBody(app.scope, aud);
    near.sendTxTimesOut = true;
    near.txPollFailures = 1000;
    // Every poll fails; run the clock fast so the relay gives up on its 60 s outcome deadline quickly.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (skew += 10_000));
    const res = await login(app, req);
    vi.restoreAllMocks();
    expect([res.status, await body(res)]).toEqual([504, expect.objectContaining({ code: 'timeout', nearTx: expect.any(String) })]);
    // An unknown outcome may have executed: relayed (gas may be burnt), settled later by the admin Worker.
    expect(usage(app.id)).toEqual(['login error timeout relayed']);
  });

  it('relayer errors keep their codes (not executed)', async () => {
    const { app, aud, near } = await setup();
    const res = await login(app, await loginBody(app.scope, aud), hanaHeaders(app), { RELAYER_KEYS: '' });
    expect([res.status, (await body(res)).code]).toEqual([503, 'relayer_unconfigured']);
    expect(near.sent).toHaveLength(0);
  });

  it('routing: POST only, preflight from the Hana origins', async () => {
    const { app } = await setup();
    expect((await call('/v1/login', { headers: hanaHeaders(app) })).status).toBe(405);
    for (const origin of [VAULT, AUTH]) {
      const pre = await call('/v1/login', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-hana-key, x-hana-parent-origin' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
      expect(pre.headers.get('access-control-allow-headers')).toContain('x-hana-parent-origin');
    }
  });

  it('counts against the app’s relay quota like /v1/sessions', async () => {
    const { seedPlan } = await import('./helpers.ts');
    const plan = `p${uid()}`;
    await seedPlan(plan, 1, 1000, 1000);
    const app = await seedApp({ plan });
    const aud = newAud();
    withCombinedCall(chain({ [aud]: app.scope }));
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(200);
    const res = await call('/v1/sessions', { headers: appHeaders(app), body: await sessionBody(app.scope, aud) });
    expect([res.status, (await body(res)).code]).toEqual([429, 'rate_limited']);
  });

  it('junk with the public key and forged Hana headers never uses up the quota: it is counted after every check (APIW-1)', async () => {
    const { seedPlan } = await import('./helpers.ts');
    const { rsaSigner } = await import('./near-mock.ts');
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1, 1000);
    const app = await seedApp({ plan });
    const aud = newAud();
    const near = withCombinedCall(chain({ [aud]: app.scope }));
    const evil = await rsaSigner('evil-login-kid');
    const { google } = await import('./helpers.ts');
    near.jwks = { keys: [google.jwk, evil.jwk] };
    const junk = [
      {},
      await loginBody(app.scope, aud, { signature: bytes(64, 1) }),
      await loginBody(app.scope, aud, {}, { nonce: 'other' }),
      await loginBody(app.scope, aud, {}, {}, appKey(), evil),
      await loginBody(app.scope, aud, { pk1: 'bls12381g1:1111', pk2: 'bls12381g2:1111' }),
    ];
    for (let round = 0; round < 4; round++) {
      for (const req of junk) {
        const res = await login(app, req);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).not.toBe(429);
      }
    }
    expect(near.sent).toHaveLength(0);
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(200);
    // The day quota of 1 is now used, by the one login that passed.
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(429);
  });

  it('never logs the token, signature, keys or the CKD result', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const { app, aud, near } = await setup();
    const req = await loginBody(app.scope, aud);
    expect((await login(app, req)).status).toBe(200);
    near.contract.create_session_and_derive = () => {
      throw new Error(`echo ${String(req.jwt)}`);
    };
    expect((await login(app, await loginBody(app.scope, aud))).status).toBe(422);
    const all = lines.join('\n');
    expect(lines.some((l) => l.includes('"endpoint":"/v1/login"'))).toBe(true);
    const jwt = String(req.jwt);
    for (const secret of [jwt, jwt.split('.')[1]!, app.key, req.pk1 as string, req.pk2 as string, 'bls12381g1:Y', 'bls12381g1:C', JSON.stringify(req.signature), JSON.stringify(req.sessionPublicKey)]) {
      expect(all).not.toContain(secret);
    }
  });
});
