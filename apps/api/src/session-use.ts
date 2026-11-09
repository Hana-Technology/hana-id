// Off-chain mirror of the contract's session-use rules (contracts/hana-signer/src/sessions.rs: use_session and
// revoke_session), so a derive_key or revoke_session that would certainly panic on chain is not relayed. Signed
// requests are public once on chain: without this anyone could replay them, at ~2.2 Tgas of relayer allowance a copy.
// A request that might still succeed is always relayed.
import { hex } from './bytes.ts';
import type { Env } from './env.ts';
import { type SessionView, getSession } from './views.ts';

export type SessionMethod = 'derive_key' | 'revoke_session';

export interface SessionRejection {
  status: number;
  code: string;
  error: string;
  /** Counter errors only: the counter the session's next request must carry (`used + 1`). */
  nextCounter?: number;
}

const UNKNOWN: SessionRejection = { status: 404, code: 'unknown_session', error: 'Unknown or expired session' };

/**
 * Why the contract would certainly refuse request `counter` of `method` on `session`, or null if it might accept it.
 * Both methods need a live (unrevoked) session and counter = used + 1; derive_key also needs used < max_uses. `used`
 * only grows, so a counter ≤ used can never succeed again, nor can one past the session's last usable counter
 * (max_uses for derive_key; max_uses + 1 for revoke_session, which ignores the limit so an exhausted session can still
 * be revoked). A counter ahead of used + 1 may still succeed if the requests before it land first (in flight here or
 * in another isolate), so it is not refused.
 */
export function sessionUseRejection(session: SessionView | null, appScope: string, method: SessionMethod, counter: number, now: number): SessionRejection | null {
  if (!session) return UNKNOWN;
  if (session.scope_id !== appScope) return { status: 403, code: 'scope_mismatch', error: 'Session belongs to a different app' };
  // The contract would still revoke an expired, unpruned session; the API doesn't bother (it can't be used anyway).
  if (session.expires_at_ms <= now) return UNKNOWN;
  const next = session.used + 1;
  if (method === 'derive_key' && session.used >= session.max_uses) return { status: 409, code: 'session_exhausted', error: 'Session use limit reached, open a new session' };
  if (counter < next) return { status: 409, code: 'counter_used', error: `Counter already used (replayed request); the next one is ${next}`, nextCounter: next };
  const last = method === 'derive_key' ? session.max_uses : session.max_uses + 1;
  if (counter > last) return { status: 409, code: 'counter_out_of_range', error: `Counter is past the session's use limit; the next one is ${next}`, nextCounter: next };
  return null;
}

/** The pre-check's verdict: why the request is refused, or the session it was accepted against. */
export type SessionCheck = { rejection: SessionRejection; session?: undefined } | { rejection: null; session: SessionView };

function judge(session: SessionView | null, appScope: string, method: SessionMethod, counter: number): SessionCheck {
  const rejection = sessionUseRejection(session, appScope, method, counter, Date.now());
  // A null session is always rejected (unknown_session), so an accepted one is never null.
  return rejection ? { rejection } : { rejection: null, session: session! };
}

/**
 * Check 6 for /v1/derive and /v1/sessions/revoke. A cached view never rejects on its own: other isolates may have
 * used, revoked or (after expiry) replaced the session, so a request the cache would refuse is judged again on a fresh
 * read. An accepted request comes with the session it was judged against, so its use is only counted in that session
 * (recordSessionUse). Throws when the chain can't be read.
 */
export async function precheckSessionUse(env: Env, appScope: string, method: SessionMethod, sessionPublicKey: number[], counter: number): Promise<SessionCheck> {
  const read = await getSession(env, sessionPublicKey);
  const check = judge(read.session, appScope, method, counter);
  if (!check.rejection || !read.cached) return check;
  const fresh = await getSession(env, sessionPublicKey, { fresh: true });
  return judge(fresh.session, appScope, method, counter);
}

/** `session key:counter` → settles when the request holding that counter is done (this isolate only). */
const inFlight = new Map<string, Promise<void>>();

/**
 * Holds `counter` of this session in this isolate until the returned release is called (call it exactly once). A second
 * request for the same counter (a client retry, or a replay racing the original before chain views show it) waits for
 * the first to finish rather than being relayed beside it, since at most one of them can succeed; it is then judged
 * on the first one's outcome (counted in the session cache after a successful derive, or the session read again
 * after a failure). Other counters don't wait. Copies arriving in other isolates meet at the session's relayer key
 * object instead, which relays one (RelayerKey `claims`, D455).
 */
export async function claimCounter(sessionPublicKey: number[], counter: number): Promise<() => void> {
  const key = `${hex(new Uint8Array(sessionPublicKey))}:${counter}`;
  for (let held = inFlight.get(key); held; held = inFlight.get(key)) await held;
  let settle!: () => void;
  const held = new Promise<void>((resolve) => (settle = resolve));
  inFlight.set(key, held);
  return () => {
    if (inFlight.get(key) === held) inFlight.delete(key);
    settle();
  };
}

/** Tests only: counters held in this isolate. */
export function heldCounters(): number {
  return inFlight.size;
}
