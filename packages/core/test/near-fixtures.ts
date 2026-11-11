// NEAR test fixtures: the user of the first derivation vector (implicit account, key, seed) and borsh requests built
// with @near-js/transactions (an independent encoder). Test-only keys from public test inputs.
import { KeyPair, PublicKey } from '@near-js/crypto';
import { type Action, SCHEMA, actionCreators, buildDelegateAction, createTransaction, encodeTransaction } from '@near-js/transactions';
import { serialize } from 'borsh';
import { base64Encode, fromHex, sha256, utf8 } from '../src/bytes.ts';
import { readText } from './helpers.ts';

const NV = JSON.parse(readText('vectors/derivation-v1-near.json')) as { vectors: { prkHex: string; sHex: string; accounts: { near: { seedHex: string; accountId: string; publicKey: string; exportBase58: string } }[] }[] };

/** The user: vector 0, account 0. */
export const NEAR_USER = NV.vectors[0]!.accounts[0]!.near.accountId;
export const NEAR_USER_KEY = NV.vectors[0]!.accounts[0]!.near.publicKey;
export const NEAR_USER_SEED = (): Uint8Array => fromHex(NV.vectors[0]!.accounts[0]!.near.seedHex);
export const NEAR_USER_S = (): Uint8Array => fromHex(NV.vectors[0]!.sHex);
/** Another key (vector 1). */
export const NEAR_OTHER_KEY = KeyPair.fromString(`ed25519:${NV.vectors[1]!.accounts[0]!.near.exportBase58}`).getPublicKey();
export const NEAR_OTHER = NV.vectors[1]!.accounts[0]!.near.accountId;
export const NEAR_BLOCK = sha256(utf8('a testnet block'));

export const { createAccount, deployContract, functionCall, transfer, stake, addKey, deleteKey, deleteAccount, fullAccessKey, functionCallAccessKey, deployGlobalContract, useGlobalContract } = actionCreators;

/** borsh(Transaction) from the user to `receiver`. */
export function nearTxBytes(actions: Action[], opts: { signer?: string; key?: PublicKey; receiver?: string; nonce?: bigint } = {}): Uint8Array {
  return encodeTransaction(createTransaction(opts.signer ?? NEAR_USER, opts.key ?? PublicKey.fromString(NEAR_USER_KEY), opts.receiver ?? 'guestbook.testnet', opts.nonce ?? 1n, actions, NEAR_BLOCK));
}

/** borsh(DelegateAction) (no NEP-461 prefix) from the user to `receiver`. */
export function nearDelegateBytes(actions: Action[], opts: { sender?: string; key?: PublicKey; receiver?: string; maxBlockHeight?: bigint } = {}): Uint8Array {
  const da = buildDelegateAction({
    senderId: opts.sender ?? NEAR_USER,
    receiverId: opts.receiver ?? 'guestbook.testnet',
    actions,
    nonce: 5n,
    maxBlockHeight: opts.maxBlockHeight ?? 277_300_000n,
    publicKey: opts.key ?? PublicKey.fromString(NEAR_USER_KEY),
  });
  return serialize(SCHEMA.DelegateAction, da);
}

export const guestbookCall = (text = 'gm'): Action => functionCall('add_message', { text }, 30_000_000_000_000n, 0n);

export const NEAR_PARAMS = {
  near_signTransaction: { network: 'testnet', transaction: base64Encode(nearTxBytes([guestbookCall()])) },
  near_signMessage: { message: 'Sign in to Guestbook', recipient: 'guestbook.example', nonce: base64Encode(new Uint8Array(32).fill(3)) },
  near_signDelegateAction: { network: 'testnet', delegateAction: base64Encode(nearDelegateBytes([guestbookCall()])) },
} as const;
