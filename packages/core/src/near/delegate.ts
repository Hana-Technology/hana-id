// NEP-366 delegate actions for test apps (Hana's rule): the nonce and the expiry both close to testnet's current
// height, and only actions a replay elsewhere can't use (nearTestAppDelegateProblem).
//
// nearcore runs a delegate action on any network whose own height H has nonce < H × 10^6 (its
// ACCESS_KEY_NONCE_RANGE_MULTIPLIER; NonceTooLarge otherwise) and H ≤ max_block_height, if the sender's key there has a
// lower nonce; it then sets the key's nonce to the delegate's. With nonce > (h − NEAR_DELEGATE_MAX_BLOCKS) × 10^6 and
// max_block_height ≤ h + NEAR_DELEGATE_MAX_BLOCKS (h: testnet's height when it is signed), that is a fixed window of
// heights, at most 20,000 blocks wide (about 700 with nearDelegateNonce and a 600-block expiry). A network whose height
// is behind testnet's passes through that window later: mainnet, ~53 million blocks behind in 2026-11 at the same ~1.7
// blocks a second, about a year later. The window bounds when a kept signature could run there; it doesn't stop it.
// Moving the key's nonce up to about height × 10^6 breaks nothing on testnet: every later transaction or delegate
// action uses the key's nonce + 1 (or a higher floor), which stays below the bound because the height only grows.
import type { NearActionType, NearDelegateAction } from './codec.ts';

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
 * The nonce to give a delegate action built now: the highest of the access key's nonce + 1, (blockHeight − 100) ×
 * 10^6, and `lastUsed` + 1 when given. `keyNonce` and `blockHeight` are what `view_access_key` returns (`nonce`,
 * `block_height`). Two delegate actions built from the same read get the same nonce and only the first can run: pass
 * the previous one's nonce as `lastUsed` (or read the key again) when building several. Throws if the nonce would reach
 * nearcore's bound for the height (height × 10^6).
 */
export function nearDelegateNonce({ keyNonce, blockHeight, lastUsed }: { keyNonce: bigint | number; blockHeight: bigint | number; lastUsed?: bigint | number }): bigint {
  const k = toBig(keyNonce, 'keyNonce');
  const h = toBig(blockHeight, 'blockHeight');
  const floor = (h - BigInt(NEAR_DELEGATE_NONCE_LAG_BLOCKS)) * NEAR_NONCE_PER_BLOCK;
  let nonce = k + 1n > floor ? k + 1n : floor;
  if (lastUsed !== undefined) {
    const next = toBig(lastUsed, 'lastUsed') + 1n;
    if (next > nonce) nonce = next;
  }
  if (nonce >= h * NEAR_NONCE_PER_BLOCK) throw new RangeError('The key’s nonce is at the bound for this height: wait a block');
  return nonce;
}

/** The only actions a test app's delegate action may hold: calls and transfers, to a `*.testnet` account. */
export const NEAR_TEST_APP_DELEGATE_ACTIONS: readonly NearActionType[] = ['functionCall', 'transfer'];

/**
 * Why a test app's delegate action is refused, or null (Hana's rule for test apps' delegate actions, which name no
 * network). A signed delegate action can be replayed on another network whose height later passes through its
 * window; these rules keep such a replay from doing anything there:
 * - only FunctionCall and Transfer (`near_delegate_test_app_action`): nothing that acts on the user's own account
 *   (AddKey, DeleteKey, DeleteAccount, DeployContract, DeployGlobalContract, UseGlobalContract, Stake, CreateAccount);
 * - the receiver is a `*.testnet` account (`near_delegate_test_app_receiver`), so never the user's own (implicit)
 *   account. On mainnet `testnet` doesn't exist: a top-level account under 32 characters can be created only by the
 *   `registrar` account there, and `x.testnet` only by `testnet`, so a replayed call or transfer fails there
 *   (AccountDoesNotExist) and its deposit returns to the user.
 */
export function nearTestAppDelegateProblem(d: Pick<NearDelegateAction, 'actions' | 'receiverId' | 'senderId'>): { reason: 'near_delegate_test_app_action' | 'near_delegate_test_app_receiver'; message: string } | null {
  const bad = d.actions.find((a) => !NEAR_TEST_APP_DELEGATE_ACTIONS.includes(a.type));
  if (bad) return { reason: 'near_delegate_test_app_action', message: `A test app's delegate action may only call contracts or send NEAR, not ${bad.type}` };
  if (!d.receiverId.endsWith('.testnet') || d.receiverId === d.senderId) {
    return { reason: 'near_delegate_test_app_receiver', message: "A test app's delegate action must go to a *.testnet account other than the user's own" };
  }
  return null;
}
