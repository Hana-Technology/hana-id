// Spreads relays across the RelayerKey Durable Objects, one per key in RELAYER_KEYS.
import type { Env } from './env.ts';
import type { ContractCall } from './near/tx.ts';
import { type RelayResult, parseRelayerKeys } from './relayer-key.ts';

let parsedFrom: string | undefined;
let keyCount = 0;
/** Round-robin cursor, random start so isolates don't all begin on key 0. */
let cursor = Math.floor(Math.random() * 1_000_000);

export function relayerKeyCount(env: Pick<Env, 'RELAYER_KEYS'>): number {
  if (parsedFrom !== env.RELAYER_KEYS) {
    keyCount = parseRelayerKeys(env.RELAYER_KEYS).length;
    parsedFrom = env.RELAYER_KEYS;
  }
  return keyCount;
}

/** Next key index, round-robin over the pool. */
export function pickKeyIndex(count: number): number {
  if (count <= 0) throw new Error('No relayer keys configured');
  cursor = (cursor + 1) % 1_000_000_000;
  return cursor % count;
}

export const relayerKeyName = (index: number): string => `relayer-key-${index}`;

export async function relay(env: Env, call: ContractCall, requestId: string): Promise<RelayResult & { keyIndex?: number }> {
  let count: number;
  try {
    count = relayerKeyCount(env);
  } catch {
    return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The relayer is not configured' };
  }
  if (count === 0) return { ok: false, status: 503, code: 'relayer_unconfigured', error: 'The relayer is not configured' };
  const keyIndex = pickKeyIndex(count);
  const stub = env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(relayerKeyName(keyIndex)));
  try {
    const result = (await stub.relay(keyIndex, call, requestId)) as RelayResult;
    return { ...result, keyIndex };
  } catch {
    return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again', keyIndex };
  }
}
