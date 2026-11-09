// Spreads relays across the RelayerKey Durable Objects of a pool (one object per key in that pool's secret).
import { hex } from './bytes.ts';
import type { Env } from './env.ts';
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

/**
 * The key a session's requests go through: its session key's first four bytes modulo the pool (session keys are
 * random, so sessions spread evenly). Every copy of a request reaches the same object from any isolate, and that object
 * relays one of them (RelayerKey `claims`).
 */
export function claimKeyIndex(sessionPublicKey: readonly number[], count: number): number {
  if (count <= 0) throw new Error('No relayer keys configured');
  const [a = 0, b = 0, c = 0, d = 0] = sessionPublicKey;
  return (a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d) % count;
}

/**
 * Relays `call` through a key of `pool`. Methods outside the pool's allowlist are refused here and in the object. With
 * a `claim`, the key is the session's (claimKeyIndex) and a copy already relayed answers `already_relayed`.
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
  const keyIndex = claim ? claimKeyIndex(claim.sessionPublicKey, count) : pickKeyIndex(count, pool);
  const stub = placedStub(env, env.RELAYER_KEY, relayerKeyName(pool, keyIndex));
  try {
    const result = (await stub.relay(pool, keyIndex, { method: call.method, args: call.args }, requestId, claim ? claimId(claim) : undefined)) as RelayResult;
    return { ...result, keyIndex };
  } catch {
    return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again', keyIndex };
  }
}
