// Spreads relays across the RelayerKey Durable Objects of a pool (one object per key in that pool's secret).
import type { Env } from './env.ts';
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

/** Relays `call` through a key of `pool`. Methods outside the pool's allowlist are refused here and in the object. */
export async function relay(env: Env, pool: Pool, call: ContractCall, requestId: string): Promise<RelayResult & { keyIndex?: number }> {
  if (!poolAllows(pool, call.method)) return { ok: false, status: 400, code: 'method_not_allowed', error: `Method ${call.method} is not relayed by the ${pool} pool` };
  let count: number;
  try {
    count = relayerKeyCount(env, pool);
  } catch {
    return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The relayer is not configured' };
  }
  if (count === 0) return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The relayer is not configured' };
  const keyIndex = pickKeyIndex(count, pool);
  const stub = env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(relayerKeyName(pool, keyIndex)));
  try {
    const result = (await stub.relay(pool, keyIndex, { method: call.method, args: call.args }, requestId)) as RelayResult;
    return { ...result, keyIndex };
  } catch {
    return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again', keyIndex };
  }
}
