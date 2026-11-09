// Spreads relays across the RelayerKey Durable Objects of a pool (one object per key in that pool's secret).
import { concatBytes, hex } from './bytes.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { placedStub } from './placement.ts';
import type { ContractCall } from './near/tx.ts';
import { POOL_SECRET, type Pool, parseRelayerKeys, poolAllows, relayerKeyName } from './relayer-config.ts';
import type { RelayResult } from './relayer-key.ts';

export { relayerKeyName };

const parsed: Record<Pool, { from: string | undefined; count: number }> = { session: { from: undefined, count: 0 }, owner: { from: undefined, count: 0 } };
/** Round-robin cursor per pool, random start so isolates don't all begin on key 0. */
const cursors: Record<Pool, number> = { session: Math.floor(Math.random() * 1_000_000), owner: Math.floor(Math.random() * 1_000_000) };

export function relayerKeyCount(env: Pick<Env, 'RELAYER_KEYS' | 'OWNER_RELAYER_KEYS'>, pool: Pool = 'session'): number {
  const name = POOL_SECRET[pool];
  const raw = env[name];
  const p = parsed[pool];
  if (p.from !== raw || p.count === 0) {
    p.count = parseRelayerKeys(raw, name).length;
    p.from = raw;
  }
  return p.count;
}

/** Next key index of `pool`, round-robin. */
export function pickKeyIndex(count: number, pool: Pool = 'session'): number {
  if (count <= 0) throw new Error('No relayer keys configured');
  cursors[pool] = (cursors[pool] + 1) % 1_000_000_000;
  return cursors[pool] % count;
}

/**
 * What makes a session-signed request one of a kind (D454): the session's key, its `expiresAtMs` (a key may open a new
 * session after one expires, and its counters start again) and the counter (0 for create_session, 1 for a login).
 */
export interface RelayClaim {
  sessionPublicKey: number[];
  expiresAtMs: number;
  counter: number;
}

export const claimId = (c: RelayClaim): string => `${hex(new Uint8Array(c.sessionPublicKey))}:${c.expiresAtMs}:${c.counter}`;

/** Domain separation for the routing HMAC: nothing else computes an HMAC under the pool secret (D454's note). */
const CLAIM_ROUTE_LABEL = 'hana-id-relayer-route-v1';
const routeKeys: Partial<Record<Pool, { from: string; key: Promise<CryptoKey> }>> = {};

/** The pool secret as an HMAC key (imported once per isolate and secret value). */
function routeKey(pool: Pool, secret: string): Promise<CryptoKey> {
  const cached = routeKeys[pool];
  if (cached?.from === secret) return cached.key;
  const key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  routeKeys[pool] = { from: secret, key };
  return key;
}

/**
 * The key a session's requests go through: HMAC-SHA256 under the pool's secret (`env[POOL_SECRET[pool]]`, the value
 * every isolate of a deploy shares) of the session key, modulo the pool, D454. Every copy of a request reaches the same
 * object from any isolate, and that object relays one of them (RelayerKey `claims`). A client generates its session key
 * but can't compute this: it can't pick a key's index by choosing session keys offline, only find out which key a
 * session landed on (the signer of its transaction) after opening one. A session's own uses stay on its key, at most
 * the contract's MAX_USES per session.
 */
export async function claimKeyIndex(pool: Pool, secret: string, sessionPublicKey: readonly number[], count: number): Promise<number> {
  if (count <= 0) throw new Error('No relayer keys configured');
  const key = await routeKey(pool, secret);
  const label = new TextEncoder().encode(`${CLAIM_ROUTE_LABEL}:${pool}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, concatBytes(label, Uint8Array.of(0), Uint8Array.from(sessionPublicKey))));
  return new DataView(mac.buffer).getUint32(0) % count;
}

type PoolRelayResult = RelayResult & { keyIndex?: number };

/**
 * Outcomes of a claimed relay that move to the next key (D454's note). All but `relayer_unavailable` are "this transaction never ran":
 * nothing left the object (`near_unavailable`), the node refused it (`near_rejected`) or a later nonce of the key
 * replaced it (`relayer_busy`). `relayer_unavailable` also covers the object's call throwing part way through, when a
 * transaction may have left it; resending is still safe because the contract takes a session's request once
 * (`create_session`: session_key_in_use; `derive_key`, `revoke_session`: the counter).
 */
const NOT_EXECUTED_ON_KEY: ReadonlySet<string> = new Set(['near_rejected', 'near_unavailable', 'relayer_busy', 'relayer_unavailable']);

function notExecutedOnKey(r: PoolRelayResult): boolean {
  if (r.ok || !NOT_EXECUTED_ON_KEY.has(r.code)) return false;
  // Never set today, but a named transaction is the client's to poll, not ours to replace (handlers.ts relayFailure).
  return r.code !== 'relayer_unavailable' || !r.nearTx;
}

/**
 * Relays `call` through a key of `pool`. Methods outside the pool's allowlist are refused here and in the object. With
 * a `claim`, the key is the session's (claimKeyIndex), a copy already relayed answers `already_relayed`, and an outcome
 * that didn't execute is tried once more on the next key with the same claim (D454's note): the next index depends only
 * on the first, so copies still meet at one object, and without this a session pinned to a bad key could neither derive
 * nor revoke. A relay without a claim has no failover: the client's resend picks another key round-robin.
 */
export async function relay(env: Env, pool: Pool, call: ContractCall, requestId: string, claim?: RelayClaim): Promise<RelayResult & { keyIndex?: number }> {
  if (!poolAllows(pool, call.method)) return { ok: false, status: 400, code: 'method_not_allowed', error: `Method ${call.method} is not relayed by the ${pool} pool` };
  let count: number;
  try {
    count = relayerKeyCount(env, pool);
  } catch {
    return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The relayer is not configured' };
  }
  if (count === 0) return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The relayer is not configured' };
  const keyIndex = claim ? await claimKeyIndex(pool, env[POOL_SECRET[pool]] as string, claim.sessionPublicKey, count) : pickKeyIndex(count, pool);
  const first = await relayThrough(env, pool, call, requestId, claim, keyIndex);
  if (!claim || count < 2 || first.ok || !notExecutedOnKey(first)) return first;
  log({ event: 'relay_failover', requestId, pool, keyIndex, method: call.method, code: first.code }, 'warn');
  const second = await relayThrough(env, pool, call, requestId, claim, (keyIndex + 1) % count);
  // A first outcome that may have left the object stays the answer unless the second says more than "not executed": the
  // client must keep polling for it rather than resend blind (packages/web NOT_EXECUTED).
  return first.code === 'relayer_unavailable' && notExecutedOnKey(second) ? first : second;
}

async function relayThrough(env: Env, pool: Pool, call: ContractCall, requestId: string, claim: RelayClaim | undefined, keyIndex: number): Promise<PoolRelayResult> {
  const stub = placedStub(env, env.RELAYER_KEY, relayerKeyName(pool, keyIndex));
  try {
    const result = (await stub.relay(pool, keyIndex, { method: call.method, args: call.args }, requestId, claim ? claimId(claim) : undefined)) as RelayResult;
    return { ...result, keyIndex };
  } catch {
    return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again', keyIndex };
  }
}
