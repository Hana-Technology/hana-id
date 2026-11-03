// POST /v1/login failure handling (docs/batch-b-spec.md "Failure handling", "Tests → Web unit → Login (vault)"):
// session_exists / session_key_in_use recovery, RPC re-sync before a retry, the timeout and near_error tx-poll path
// with sender_account_id = RELAYER, one resend for not-executed codes, relayer_unavailable, ckd_failed per mode.
import { ApiError, type CkdResult, type LoginBody, type SessionView } from '@hana-id/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type ChainLoginContext,
  ChainLoginError,
  IN_USE_RESYNC_INTERVAL_MS,
  IN_USE_RESYNC_LIMIT_MS,
  NOT_EXECUTED_CODES,
  RELAYER_UNAVAILABLE_WAIT_MS,
  TX_POLL_LIMIT_MS,
  loginOnChain,
} from '../../src/auth/chain-login.ts';
import { type TxOutcome, txOutcomeOf } from '../../src/auth/near-rpc.ts';

const NOW = 1_800_000_000_000;
const RESULT: CkdResult = { big_y: 'bls12381g1:y', big_c: 'bls12381g1:c' };
const OTHER: CkdResult = { big_y: 'bls12381g1:y2', big_c: 'bls12381g1:c2' };
const PATH = 's1#google#123#0';
const TX = '7'.repeat(44);
const TX2 = '8'.repeat(44);
const SIGNER = 'hana-signer.testnet';
const RELAYER = 'hana-relayer.testnet';

const body: LoginBody = { jwt: 'jwt', sessionPublicKey: [1], expiresAtMs: NOW + 600_000, salt: [2], keyIndex: 0, maxUses: 1, signature: [3], pk1: 'p1', pk2: 'p2' };
const session = (over: Partial<SessionView> = {}): SessionView => ({ path: PATH, scope_id: 's1', expires_at_ms: NOW + 600_000, max_uses: 1, used: 1, ...over });
const apiErr = (status: number, code: string, nearTx: string | null = null, details: Record<string, unknown> = {}) => new ApiError(status, code, code, nearTx, null, details);

interface Harness {
  ctx: ChainLoginContext;
  login: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  txOutcome: ReturnType<typeof vi.fn>;
  derive: ReturnType<typeof vi.fn> | undefined;
  clock: { t: number };
}

function harness(o: {
  login: (n: number) => Promise<{ result: CkdResult }>;
  sessions?: (SessionView | null)[];
  tx?: (hash: string) => TxOutcome;
  maxUses?: number;
  derive?: boolean;
}): Harness {
  const clock = { t: NOW };
  let calls = 0;
  const login = vi.fn(() => o.login(++calls));
  const sessions = [...(o.sessions ?? [])];
  const getSession = vi.fn(async () => (sessions.length > 1 ? sessions.shift() : sessions[0]) ?? null);
  const txOutcome = vi.fn(async (hash: string) => (o.tx ? o.tx(hash) : { status: 'pending' as const }));
  const derive = o.derive ? vi.fn(async () => OTHER) : undefined;
  const ctx: ChainLoginContext = {
    login,
    near: { getSession, txOutcome, view: vi.fn() },
    signer: SIGNER,
    relayer: RELAYER,
    scopeId: 's1',
    expectedPath: PATH,
    sessionPublicKey: new Uint8Array(32),
    maxUses: o.maxUses ?? 1,
    resendableUntil: NOW + 300_000,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...(derive ? { derive } : {}),
  };
  return { ctx, login, getSession, txOutcome, derive, clock };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChainLoginError) return e.code;
    throw e;
  }
  return 'resolved';
};

describe('loginOnChain', () => {
  it('returns the result of a 200', async () => {
    const h = harness({ login: async () => ({ result: RESULT }) });
    expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
    expect(h.getSession).not.toHaveBeenCalled();
  });

  describe.each([
    ['409 session_exists', () => apiErr(409, 'session_exists')],
    ['422 contract_rejected / session_key_in_use', () => apiErr(422, 'contract_rejected', TX, { reason: 'session_key_in_use' })],
  ])('%s', (_, err) => {
    it('re-syncs from NEAR and derives with used + 1 when uses remain', async () => {
      const h = harness({ login: async () => Promise.reject(err()), sessions: [session({ used: 0, max_uses: 2 })], maxUses: 2, derive: true });
      expect(await loginOnChain(body, h.ctx)).toEqual(OTHER);
      expect(h.getSession).toHaveBeenCalledWith(SIGNER, h.ctx.sessionPublicKey);
      expect(h.derive).toHaveBeenCalledWith(1);
      expect(h.login).toHaveBeenCalledTimes(1);
    });

    it('polls an earlier attempt’s nearTx when the session is used up', async () => {
      let n = 0;
      const h = harness({
        login: async () => {
          n++;
          if (n === 1) throw apiErr(504, 'timeout', TX2);
          throw err();
        },
        sessions: [null, session()],
        tx: (hash) => (hash === TX2 && n > 1 ? { status: 'success', result: RESULT } : { status: 'pending' }),
      });
      h.clock.t = NOW;
      expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
      expect(h.txOutcome).toHaveBeenCalledWith(TX2, RELAYER);
    });

    it('fails session_consumed when the session is used up and no attempt of ours is known to have landed', async () => {
      const h = harness({ login: async () => Promise.reject(err()), sessions: [session()], tx: () => ({ status: 'failed' }) });
      expect(await code(loginOnChain(body, h.ctx))).toBe('session_consumed');
      expect(h.login).toHaveBeenCalledTimes(1);
    });

    it('a lagging RPC node: get_session null once, then the session → re-reads after 300 ms and goes on', async () => {
      const h = harness({ login: async () => Promise.reject(err()), sessions: [null, session({ used: 0, max_uses: 2 })], maxUses: 2, derive: true });
      expect(await loginOnChain(body, h.ctx)).toEqual(OTHER);
      expect(h.getSession).toHaveBeenCalledTimes(2);
      expect(h.clock.t - NOW).toBe(IN_USE_RESYNC_INTERVAL_MS);
      expect(h.derive).toHaveBeenCalledWith(1);
      expect(h.login).toHaveBeenCalledTimes(1);
    });

    it('session still null after 2 s: a known nearTx of ours that succeeded gives the result', async () => {
      let n = 0;
      const h = harness({
        login: async () => {
          n++;
          if (n === 1) throw apiErr(502, 'near_unavailable', TX2);
          throw err();
        },
        sessions: [null],
        tx: (hash) => (hash === TX2 ? { status: 'success', result: RESULT } : { status: 'pending' }),
      });
      expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
      expect(h.login).toHaveBeenCalledTimes(2);
      // Read every 300 ms for up to 2 s, then the known transaction.
      expect(h.getSession.mock.calls.length).toBe(Math.floor(IN_USE_RESYNC_LIMIT_MS / IN_USE_RESYNC_INTERVAL_MS) + 1);
      expect(h.clock.t - NOW).toBeLessThanOrEqual(IN_USE_RESYNC_LIMIT_MS);
      expect(h.txOutcome).toHaveBeenCalledWith(TX2, RELAYER);
      expect(h.getSession.mock.invocationCallOrder.at(-1)).toBeLessThan(h.txOutcome.mock.invocationCallOrder[0] as number);
    });

    it('session still null after 2 s and no known transaction succeeded: derive_failed', async () => {
      const h = harness({ login: async () => Promise.reject(err()), sessions: [null], tx: () => ({ status: 'failed' }) });
      expect(await code(loginOnChain(body, h.ctx))).toBe('derive_failed');
      expect(h.getSession.mock.calls.length).toBeGreaterThan(1);
      expect(h.clock.t - NOW).toBeLessThanOrEqual(IN_USE_RESYNC_LIMIT_MS);
      expect(h.login).toHaveBeenCalledTimes(1);
    });

    it('fails session_consumed (no /v1/derive from the export window) when a front-run create left a use', async () => {
      const h = harness({ login: async () => Promise.reject(err()), sessions: [session({ used: 0 })] });
      expect(await code(loginOnChain(body, h.ctx))).toBe('session_consumed');
    });
  });

  it('refuses a re-synced session with another path or scope (never uses an API or chain path)', async () => {
    for (const s of [session({ path: 's1#google#attacker#0', used: 0, max_uses: 2 }), session({ scope_id: 's2', used: 0, max_uses: 2 })]) {
      const h = harness({ login: async () => Promise.reject(apiErr(409, 'session_exists')), sessions: [s], maxUses: 2, derive: true });
      expect(await code(loginOnChain(body, h.ctx))).toBe('derive_failed');
      expect(h.derive).not.toHaveBeenCalled();
    }
  });

  it.each([...NOT_EXECUTED_CODES])('%s: resends the same body once, then fails api_unavailable', async (c) => {
    const h = harness({ login: async () => Promise.reject(apiErr(c === 'method_not_allowed' ? 400 : 502, c)) });
    expect(await code(loginOnChain(body, h.ctx))).toBe('api_unavailable');
    expect(h.login).toHaveBeenCalledTimes(2);
    expect(h.login.mock.calls[0]).toEqual(h.login.mock.calls[1]);
  });

  it('a not-executed code is not resent once the token has expired', async () => {
    const h = harness({ login: async () => Promise.reject(apiErr(503, 'relayer_busy')) });
    h.ctx.resendableUntil = NOW - 1;
    expect(await code(loginOnChain(body, h.ctx))).toBe('api_unavailable');
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  it('a resend after a not-executed code can succeed', async () => {
    const h = harness({ login: async (n) => (n === 1 ? Promise.reject(apiErr(502, 'near_unavailable')) : { result: RESULT }) });
    expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
  });

  describe.each([
    ['504 timeout', () => apiErr(504, 'timeout', TX)],
    ['502 near_error', () => apiErr(502, 'near_error', TX)],
    ['503 relayer_unavailable with nearTx', () => apiErr(503, 'relayer_unavailable', TX)],
  ])('%s', (_, err) => {
    it('polls the transaction with sender_account_id = RELAYER', async () => {
      let polls = 0;
      const h = harness({ login: async () => Promise.reject(err()), tx: () => (++polls < 3 ? { status: 'pending' } : { status: 'success', result: RESULT }) });
      expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
      expect(h.txOutcome).toHaveBeenCalledWith(TX, RELAYER);
      expect(h.getSession).not.toHaveBeenCalled();
    });

    it('after 120 s without an outcome, re-syncs: no session → resends the same body once', async () => {
      const h = harness({ login: async (n) => (n === 1 ? Promise.reject(err()) : { result: RESULT }), sessions: [null] });
      h.ctx.resendableUntil = NOW + 10 * TX_POLL_LIMIT_MS;
      expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
      expect(h.clock.t - NOW).toBeGreaterThanOrEqual(TX_POLL_LIMIT_MS - 2000);
      expect(h.getSession).toHaveBeenCalledTimes(1);
      expect(h.login).toHaveBeenCalledTimes(2);
    });

    it('a failed transaction and a used-up session fail derive_failed', async () => {
      const h = harness({ login: async () => Promise.reject(err()), sessions: [session()], tx: () => ({ status: 'failed' }) });
      expect(await code(loginOnChain(body, h.ctx))).toBe('derive_failed');
      expect(h.login).toHaveBeenCalledTimes(1);
    });
  });

  it('503 relayer_unavailable without nearTx waits 3 s, then re-syncs', async () => {
    const h = harness({ login: async (n) => (n === 1 ? Promise.reject(apiErr(503, 'relayer_unavailable')) : { result: RESULT }), sessions: [null] });
    expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
    expect(h.clock.t - NOW).toBe(RELAYER_UNAVAILABLE_WAIT_MS);
    expect(h.getSession).toHaveBeenCalledTimes(1);
  });

  it('a network error re-syncs before any retry', async () => {
    const h = harness({ login: async (n) => (n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : { result: RESULT }), sessions: [null] });
    expect(await loginOnChain(body, h.ctx)).toEqual(RESULT);
    expect(h.getSession).toHaveBeenCalledTimes(1);
    expect(h.getSession.mock.invocationCallOrder[0]).toBeLessThan(h.login.mock.invocationCallOrder[1] as number);
  });

  it('ckd_failed: max_uses 1 (session mode, export) fails; max_uses 2 (none mode) re-syncs and derives counter 2', async () => {
    const one = harness({ login: async () => Promise.reject(apiErr(422, 'ckd_failed', TX)) });
    expect(await code(loginOnChain(body, one.ctx))).toBe('ckd_failed');
    const two = harness({ login: async () => Promise.reject(apiErr(422, 'ckd_failed', TX)), sessions: [session({ used: 1, max_uses: 2 })], maxUses: 2, derive: true });
    expect(await loginOnChain({ ...body, maxUses: 2 }, two.ctx)).toEqual(OTHER);
    expect(two.derive).toHaveBeenCalledWith(2);
  });

  it('other contract_rejected reasons fail derive_failed without a retry', async () => {
    const h = harness({ login: async () => Promise.reject(apiErr(422, 'contract_rejected', TX)) });
    expect(await code(loginOnChain(body, h.ctx))).toBe('derive_failed');
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  it.each([
    [apiErr(400, 'token_has_pii', null, { data: { claim: 'email' } }), 'token_has_pii'],
    [apiErr(401, 'invalid_token'), 'token_invalid'],
    [apiErr(400, 'nonce_mismatch'), 'token_invalid'],
    [apiErr(403, 'app_suspended'), 'app_suspended'],
    [apiErr(403, 'origin_not_allowed'), 'origin_not_allowed'],
    [apiErr(429, 'rate_limited'), 'rate_limited'],
    [apiErr(409, 'no_google_client'), 'no_google_client'],
    [apiErr(503, 'config_unavailable'), 'api_unavailable'],
  ])('maps gate failure %s', async (err, expected) => {
    const h = harness({ login: async () => Promise.reject(err) });
    expect(await code(loginOnChain(body, h.ctx))).toBe(expected);
    expect(h.login).toHaveBeenCalledTimes(1);
  });
});

describe('txOutcomeOf', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
  it('reads the CKD result from SuccessValue, and failures and unknown states', () => {
    expect(txOutcomeOf({ status: { SuccessValue: b64(RESULT) } })).toEqual({ status: 'success', result: RESULT });
    expect(txOutcomeOf({ status: { SuccessValue: b64({ nope: 1 }) } })).toEqual({ status: 'failed' });
    expect(txOutcomeOf({ status: { Failure: {} } })).toEqual({ status: 'failed' });
    expect(txOutcomeOf({ status: 'Started' })).toEqual({ status: 'pending' });
    expect(txOutcomeOf(null)).toEqual({ status: 'pending' });
  });
});
