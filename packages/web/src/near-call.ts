// One NEAR JSON-RPC call from a Hana page (the vault and the export window: get_session re-syncs, registry views, tx
// polling), with the manifest's optional `rpcFallback` (docs/batch-b-spec.md Q9). The call goes to the primary `rpc`;
// only when that fails (a network error, no answer within the timeout, an HTTP error, a body that isn't a JSON object,
// or a body the caller can't use) does the same request go to the fallback. Each call's answer comes whole from one
// endpoint: nothing is ever combined from both. The next call starts at the primary again.
//
// A lying endpoint can do more than fail: the pairing check proves only that a CKD answer is the key *of the path the
// vault asked about*, so a view that names another identity's path (a member's account root) must not come from one
// provider alone. Those reads use `independentEndpoints` and `nearCallAt`, which ask each provider separately
// (../path-check.ts, D263). Every CKD result still passes the pairing check against the pinned network key, and a
// re-synced session must carry the vault's own scope and path.

type Fetch = typeof fetch;

/** How long an endpoint gets to answer before the call moves to the fallback (or fails). */
export const NEAR_RPC_TIMEOUT_MS = 8_000;

export interface NearEndpoints {
  /** Manifest `rpc`. */
  readonly rpc: string;
  /** Manifest `rpcFallback` (https), when the env sets one. */
  readonly rpcFallback?: string | undefined;
}

export interface NearCallOptions {
  /** JSON-RPC `id`. */
  id: string;
  /** Whether an endpoint's body is an answer the caller can use; false moves to the next endpoint. Default: any object. */
  usable?: (body: Record<string, unknown>) => boolean;
  timeoutMs?: number;
  /** The caller's own signal (a login's): its abort ends the call too, beside the timeout. */
  signal?: AbortSignal;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The endpoints a call tries, in order: the primary, then the fallback (unless it is the same URL). */
export function nearEndpoints(e: NearEndpoints): string[] {
  return e.rpcFallback && e.rpcFallback !== e.rpc ? [e.rpc, e.rpcFallback] : [e.rpc];
}

async function callOne(fetchFn: Fetch, url: string, body: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = globalThis.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal,
    });
    if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
    const parsed: unknown = await res.json();
    if (!isObj(parsed)) throw new Error('NEAR RPC: malformed response');
    return parsed;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * The two providers a confirmation reads separately (D263): the primary and the fallback, or null when the env has no
 * fallback (a path through another identity can then never be confirmed, and is refused).
 */
export function independentEndpoints(e: NearEndpoints): readonly [string, string] | null {
  return e.rpcFallback && e.rpcFallback !== e.rpc ? [e.rpc, e.rpcFallback] : null;
}

/** One endpoint's usable body, with no fallback; throws when it fails or the body isn't usable. */
export async function nearCallAt(url: string, fetchFn: Fetch, method: string, params: unknown, o: NearCallOptions): Promise<Record<string, unknown>> {
  const answer = await callOne(fetchFn, url, JSON.stringify({ jsonrpc: '2.0', id: o.id, method, params }), o.timeoutMs ?? NEAR_RPC_TIMEOUT_MS, o.signal);
  if (!(o.usable ?? (() => true))(answer)) throw new Error(`NEAR RPC: ${method} failed`);
  return answer;
}

/** The body of the first endpoint that answers usably; throws when none does. */
export async function nearCall(endpoints: NearEndpoints, fetchFn: Fetch, method: string, params: unknown, o: NearCallOptions): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: o.id, method, params });
  const usable = o.usable ?? (() => true);
  let last: unknown = new Error('NEAR RPC: no endpoint');
  for (const url of nearEndpoints(endpoints)) {
    try {
      const answer = await callOne(fetchFn, url, body, o.timeoutMs ?? NEAR_RPC_TIMEOUT_MS, o.signal);
      if (usable(answer)) return answer;
      last = new Error(`NEAR RPC: ${method} failed`);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('NEAR RPC failed');
}

/**
 * NEAR's "not known (yet)" answers to EXPERIMENTAL_tx_status: an answer about the transaction (keep polling), not an
 * endpoint failure. Any other error moves to the fallback.
 */
export function isPendingTxError(error: unknown): boolean {
  if (!isObj(error)) return false;
  const cause = isObj(error.cause) ? error.cause.name : undefined;
  return cause === 'UNKNOWN_TRANSACTION' || cause === 'TIMEOUT_ERROR' || error.name === 'TIMEOUT_ERROR';
}
