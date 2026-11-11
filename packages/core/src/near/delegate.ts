// NEP-366 delegate actions bound to the network they are built on (Hana's rule for test apps): the nonce and the
// expiry both close to that network's current height, so the action can run there now and nowhere whose height is
// far from it.
//
// nearcore takes a delegate action whose nonce is above the access key's and below height × 10^6 (its
// ACCESS_KEY_NONCE_RANGE_MULTIPLIER; NonceTooLarge otherwise), and sets the key's nonce to it after use. A nonce at
// least (height − NEAR_DELEGATE_MAX_BLOCKS) × 10^6 with an expiry at most height + NEAR_DELEGATE_MAX_BLOCKS can run on
// another network only while that network's height is within about 2 × NEAR_DELEGATE_MAX_BLOCKS blocks of this one's.
// Moving the key's nonce up to about height × 10^6 breaks nothing: every later transaction or delegate action uses
// the key's nonce + 1 (or a higher floor), which stays below the bound because the height only grows.

/** A delegate action must expire within this many blocks of the network's current height (about 1.6 hours). */
export const NEAR_DELEGATE_MAX_BLOCKS = 10_000;

/** nearcore's ACCESS_KEY_NONCE_RANGE_MULTIPLIER: a nonce must be below height × this. */
export const NEAR_NONCE_PER_BLOCK = 1_000_000n;

/** nearDelegateNonce's floor sits this many blocks below the height it was given (room for the time until signing). */
export const NEAR_DELEGATE_NONCE_LAG_BLOCKS = 100;

/** The lowest nonce (exclusive) a delegate action may have at `height`: (height − NEAR_DELEGATE_MAX_BLOCKS) × 10^6. */
export const nearDelegateNonceFloor = (height: bigint): bigint => (height - BigInt(NEAR_DELEGATE_MAX_BLOCKS)) * NEAR_NONCE_PER_BLOCK;

function toBig(v: bigint | number, what: string): bigint {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new RangeError(`${what} must not be negative`);
    return v;
  }
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what} must be a non-negative safe integer`);
  return BigInt(v);
}

/**
 * The nonce to give a delegate action built now: the access key's nonce + 1, or (blockHeight − 100) × 10^6 if that is
 * higher (it is, for any key not used within the last 100 blocks). `keyNonce` and `blockHeight` are what
 * `view_access_key` returns (`nonce`, `block_height`). Throws if the key's nonce is already at the height's bound.
 */
export function nearDelegateNonce({ keyNonce, blockHeight }: { keyNonce: bigint | number; blockHeight: bigint | number }): bigint {
  const k = toBig(keyNonce, 'keyNonce');
  const h = toBig(blockHeight, 'blockHeight');
  const floor = (h - BigInt(NEAR_DELEGATE_NONCE_LAG_BLOCKS)) * NEAR_NONCE_PER_BLOCK;
  const nonce = k + 1n > floor ? k + 1n : floor;
  if (nonce >= h * NEAR_NONCE_PER_BLOCK) throw new RangeError('The key’s nonce is at the bound for this height: wait a block');
  return nonce;
}
