// `POST /v1/login` and its failure handling (docs/batch-b-spec.md "Failure handling"), for a caller that holds the
// session key and computed the path itself: the export window here (the vault runs the same table). Session state is
// re-synced from NEAR (get_session, optimistic), never taken from the API, and a re-synced session must carry this
// login's scope and path. Lost outcomes are recovered by polling the transaction with `sender_account_id = RELAYER`.
//
// SECURITY: the body carries the Google ID token; it is sent only to the API and never logged.
import { ApiError, type CkdResult, type HanaErrorCode, type LoginBody, type SessionView } from '@hana-id/core';
import { apiErrorCode } from './errors.ts';
import type { NearReader } from './near-rpc.ts';

/** The API's not-executed codes: nothing reached the chain, so the same body may be sent once more. */
export const NOT_EXECUTED_CODES: ReadonlySet<string> = new Set(['method_not_allowed', 'near_unavailable', 'near_rejected', 'relayer_busy', 'relayer_unconfigured']);
/** How long a transaction whose outcome is unknown is polled before re-syncing. */
export const TX_POLL_LIMIT_MS = 120_000;
export const TX_POLL_INTERVAL_MS = 2_000;
/** `relayer_unavailable` without a transaction: wait this long before re-syncing. */
export const RELAYER_UNAVAILABLE_WAIT_MS = 3_000;
const TOKEN_CODES: ReadonlySet<string> = new Set(['invalid_token', 'nonce_mismatch', 'token_expired', 'wrong_audience', 'issuer_keys_unavailable']);

export class ChainLoginError extends Error {
  constructor(
    readonly code: HanaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChainLoginError';
  }
}

export interface ChainLoginContext {
  /** POST /v1/login with this body (the caller binds pk and parent origin). */
  login(body: LoginBody): Promise<{ result: CkdResult }>;
  near: NearReader;
  /** Pinned build constants. */
  signer: string;
  relayer: string;
  scopeId: string;
  /** `scopeId#google#<sub>#<keyIndex>`, computed by the caller from its own verified token. */
  expectedPath: string;
  sessionPublicKey: Uint8Array;
  maxUses: number;
  /** Server-corrected ms after which the body must not be resent (the token's exp or the session's expiry). */
  resendableUntil: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * `/v1/derive` with `counter` for a session that still has uses (the vault in 'none' mode). The export window has
   * none (authOrigin can't call /v1/derive): a session with uses left that it didn't spend is then `session_consumed`.
   */
  derive?: (counter: number) => Promise<CkdResult>;
}

/** The protocol code for a gate or token failure of /v1/login. */
function gateCode(err: ApiError): HanaErrorCode {
  if (err.code === 'token_has_pii') return 'token_has_pii';
  if (TOKEN_CODES.has(err.code) || err.status === 401) return 'token_invalid';
  return apiErrorCode(err);
}

/** Runs the login and returns the MPC's CKD result for this session's counter-1 (or recovered) derive. */
export async function loginOnChain(body: LoginBody, ctx: ChainLoginContext): Promise<CkdResult> {
  const knownTxs: string[] = [];
  let resent = false;
  const canResend = () => !resent && ctx.now() < ctx.resendableUntil && ctx.now() < body.expiresAtMs;
  const fail = (code: HanaErrorCode, message: string): never => {
    throw new ChainLoginError(code, message);
  };

  const resync = async (): Promise<SessionView | null> => {
    let s: SessionView | null;
    try {
      s = await ctx.near.getSession(ctx.signer, ctx.sessionPublicKey);
    } catch {
      return fail('api_unavailable', 'NEAR could not be read to check the session');
    }
    if (s && (s.scope_id !== ctx.scopeId || s.path !== ctx.expectedPath)) fail('derive_failed', 'The session on chain is not this login’s');
    return s;
  };

  /** Polls `hash` until it succeeds, fails or `limitMs` passes; the result, or null. */
  const pollTx = async (hash: string, limitMs: number): Promise<CkdResult | null> => {
    const deadline = ctx.now() + limitMs;
    for (;;) {
      try {
        const out = await ctx.near.txOutcome(hash, ctx.relayer);
        if (out.status === 'success') return out.result;
        if (out.status === 'failed') return null;
      } catch {
        // RPC hiccup: keep polling until the deadline.
      }
      if (ctx.now() + TX_POLL_INTERVAL_MS > deadline) return null;
      await ctx.sleep(TX_POLL_INTERVAL_MS);
    }
  };

  /** The result of any earlier attempt of this login (one quick look each). */
  const fromKnownTxs = async (): Promise<CkdResult | null> => {
    for (const hash of knownTxs) {
      const r = await pollTx(hash, 0);
      if (r) return r;
    }
    return null;
  };

  const deriveWith = async (s: SessionView): Promise<CkdResult> => {
    if (!ctx.derive) return fail('session_consumed', 'This sign-in’s session was used by someone else');
    return ctx.derive(s.used + 1);
  };

  /** 409 session_exists / session_key_in_use: someone's create landed first (or an earlier attempt of ours). */
  const inUse = async (): Promise<CkdResult> => {
    const s = await resync();
    if (!s) return fail('derive_failed', 'The session key is in use but no session was found');
    if (s.used < Math.min(s.max_uses, ctx.maxUses)) return deriveWith(s);
    const r = await fromKnownTxs();
    return r ?? fail('session_consumed', 'This sign-in’s only use was spent by someone else');
  };

  /** 422 ckd_failed: the session is committed with used = 1 and the MPC side failed. */
  const ckdFailed = async (): Promise<CkdResult> => {
    if (ctx.derive && ctx.maxUses >= 2) {
      const s = await resync();
      if (s && s.used < Math.min(s.max_uses, ctx.maxUses)) return ctx.derive(s.used + 1);
    }
    return fail('ckd_failed', 'The key service failed to produce the key');
  };

  /** 504 timeout, 502 near_error, 503 relayer_unavailable, a network error: the outcome is unknown. */
  const unknown = async (hash: string | null): Promise<CkdResult> => {
    if (hash) {
      const r = await pollTx(hash, TX_POLL_LIMIT_MS);
      if (r) return r;
    }
    const s = await resync();
    if (!s) {
      if (canResend()) {
        resent = true;
        return send();
      }
      return fail('api_unavailable', 'The sign-in transaction did not go through');
    }
    if (s.used < Math.min(s.max_uses, ctx.maxUses)) return deriveWith(s);
    const r = await fromKnownTxs();
    return r ?? fail('derive_failed', 'The sign-in transaction’s result could not be recovered');
  };

  const send = async (): Promise<CkdResult> => {
    for (;;) {
      let err: unknown;
      try {
        return (await ctx.login(body)).result;
      } catch (e) {
        err = e;
      }
      if (!(err instanceof ApiError)) return unknown(null);
      if (err.nearTx && !knownTxs.includes(err.nearTx)) knownTxs.push(err.nearTx);
      const code = err.code;
      if ((err.status === 409 && code === 'session_exists') || (code === 'contract_rejected' && err.details.reason === 'session_key_in_use')) return inUse();
      if (code === 'ckd_failed') return ckdFailed();
      if (code === 'contract_rejected') return fail('derive_failed', 'The signer contract refused the sign-in');
      if (NOT_EXECUTED_CODES.has(code)) {
        if (canResend()) {
          resent = true;
          continue;
        }
        return fail('api_unavailable', 'Hana could not send the sign-in transaction');
      }
      if ((code === 'timeout' || code === 'near_error') && err.nearTx) return unknown(err.nearTx);
      if (code === 'relayer_unavailable') {
        if (err.nearTx) return unknown(err.nearTx);
        await ctx.sleep(RELAYER_UNAVAILABLE_WAIT_MS);
        return unknown(null);
      }
      return fail(gateCode(err), err.message);
    }
  };

  return send();
}
