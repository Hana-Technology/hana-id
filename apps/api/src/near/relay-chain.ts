// The NEAR reads the relay makes before it sends anything (D732): the head block (height, gas price) and the user's
// own access key on their implicit account. Pure (rpc.ts only), so the sandbox tests check the error classification
// against a real node.
import { fromHex } from '../bytes.ts';
import { nearPublicKeyString } from './delegate.ts';
import { type Rpc, RpcError } from './rpc.ts';

const textOf = (e: unknown): string => (e instanceof RpcError ? `${e.rpc?.cause?.name ?? ''} ${e.rpc?.name ?? ''} ${e.message}` : '');

/** The node's answer for an account that doesn't exist (`UNKNOWN_ACCOUNT`, or "account … does not exist while viewing"). */
export const isUnknownAccount = (e: unknown): boolean => /UNKNOWN_ACCOUNT\b|\baccount \S+ does not exist while viewing/u.test(textOf(e));
/** The node's answer for a key the account doesn't hold (`UNKNOWN_ACCESS_KEY`, or "access key … does not exist while viewing"). */
export const isUnknownAccessKey = (e: unknown): boolean => /UNKNOWN_ACCESS_KEY\b|\baccess key \S+ does not exist while viewing/u.test(textOf(e));

/** The final block's height and gas price (yocto per gas unit). Throws when NEAR can't be read or answers oddly. */
export async function headBlock(rpc: Rpc): Promise<{ height: bigint; gasPrice: bigint }> {
  const b = await rpc.call<{ header?: { height?: number; gas_price?: string } }>('block', { finality: 'final' }, 8_000);
  const h = b.header;
  if (!h || !Number.isSafeInteger(h.height) || typeof h.gas_price !== 'string' || !/^\d{1,30}$/u.test(h.gas_price)) throw new Error('Unreadable block');
  return { height: BigInt(h.height as number), gasPrice: BigInt(h.gas_price) };
}

export type AccountKey = { kind: 'key'; nonce: bigint; height: bigint } | { kind: 'no_account' } | { kind: 'no_key' };

/** Whether `accountId` exists (`view_account`). Throws when NEAR can't say. */
export async function accountExists(rpc: Rpc, accountId: string): Promise<boolean> {
  try {
    await rpc.call('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId }, 8_000);
    return true;
  } catch (e) {
    if (isUnknownAccount(e)) return false;
    throw e;
  }
}

/**
 * `publicKey` on `accountId`: its nonce and the block the view answered at, or which of the two is missing. A node
 * answers a missing key either as a JSON-RPC error or as a result carrying `error` text, and answers a missing key of
 * a missing account as a missing key (an implicit account id, measured on near-sandbox 2.13.4): a missing key is
 * then told from a missing account by `view_account`. Anything else unreadable throws.
 */
export async function accessKeyState(rpc: Rpc, accountId: string, publicKey: string): Promise<AccountKey> {
  const state = await keyView(rpc, accountId, publicKey);
  if (state.kind !== 'no_key') return state;
  return (await accountExists(rpc, accountId)) ? state : { kind: 'no_account' };
}

async function keyView(rpc: Rpc, accountId: string, publicKey: string): Promise<AccountKey> {
  let view: { nonce?: unknown; block_height?: unknown; error?: unknown };
  try {
    view = (await rpc.viewAccessKey(accountId, publicKey)) as typeof view;
  } catch (e) {
    if (isUnknownAccessKey(e)) return { kind: 'no_key' };
    if (isUnknownAccount(e)) return { kind: 'no_account' };
    throw e;
  }
  if (typeof view.error === 'string') {
    const asError = new RpcError(view.error, null);
    if (isUnknownAccessKey(asError)) return { kind: 'no_key' };
    if (isUnknownAccount(asError)) return { kind: 'no_account' };
    throw asError;
  }
  const nonce = typeof view.nonce === 'number' && Number.isSafeInteger(view.nonce) ? BigInt(view.nonce) : typeof view.nonce === 'string' && /^\d{1,20}$/u.test(view.nonce) ? BigInt(view.nonce) : null;
  if (nonce === null || !Number.isSafeInteger(view.block_height)) throw new Error('Unreadable access key view');
  return { kind: 'key', nonce, height: BigInt(view.block_height as number) };
}

/** The implicit account's own key (the one its id is the hex of). */
export const implicitAccountKey = (rpc: Rpc, accountId: string): Promise<AccountKey> => accessKeyState(rpc, accountId, nearPublicKeyString(fromHex(accountId)));
