// NEAR signers (D721): Ed25519 over the hashes codec.ts defines. Each takes the 32-byte seed from withChainKey (the
// caller zeroes it), is synchronous, and returns only public values. The bytes must already have passed the decoder
// (the vault signs what the popup decoded), and are decoded again here so nothing undecodable is ever signed.
import { ed25519 } from '@noble/curves/ed25519';
import { nearImplicitAccountId, nearPublicKeyString } from '../addresses.ts';
import { base64Encode, bytesEqual, toBytes } from '../bytes.ts';
import {
  type NearDelegateAction,
  type NearTransaction,
  decodeNearDelegateAction,
  decodeNearTransaction,
  decodeNep413Message,
  encodeNearSignedDelegateAction,
  encodeNearSignedTransaction,
  nearDelegateActionHash,
  nearTransactionHash,
  nearTransactionHashString,
  nep413Hash,
} from './codec.ts';

function checkSigner(seed: Uint8Array, key: { type: string; bytes: Uint8Array }, what: string): void {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  if (key.type !== 'ed25519' || !bytesEqual(key.bytes, ed25519.getPublicKey(seed))) throw new Error(`The ${what} public key is not this key`);
}

export interface NearSignedTransactionResult {
  /** base64 of the 64-byte Ed25519 signature. */
  signature: string;
  /** base64 of borsh(SignedTransaction), ready for `send_tx` / `broadcast_tx_commit`. */
  signedTransaction: string;
  /** base58 sha256 of the transaction (its NEAR hash). */
  hash: string;
}

/** Signs a borsh Transaction whose public_key is this seed's key. */
export function signNearTransaction(seed: Uint8Array, txBytes: Uint8Array): NearSignedTransactionResult {
  const tx: NearTransaction = decodeNearTransaction(txBytes);
  checkSigner(seed, tx.publicKey, 'transaction');
  const sig = toBytes(ed25519.sign(nearTransactionHash(txBytes), seed));
  return {
    signature: base64Encode(sig),
    signedTransaction: base64Encode(encodeNearSignedTransaction(txBytes, { type: 'ed25519', bytes: sig })),
    hash: nearTransactionHashString(txBytes),
  };
}

export interface NearSignedDelegateResult {
  signature: string;
  /** base64 of borsh(SignedDelegateAction), what a relayer wraps in its own transaction. */
  signedDelegateAction: string;
}

/** Signs a borsh DelegateAction (NEP-366) whose public_key is this seed's key, under NEP-461's prefix. */
export function signNearDelegateAction(seed: Uint8Array, delegateBytes: Uint8Array): NearSignedDelegateResult {
  const da: NearDelegateAction = decodeNearDelegateAction(delegateBytes);
  checkSigner(seed, da.publicKey, 'delegate action');
  const sig = toBytes(ed25519.sign(nearDelegateActionHash(delegateBytes), seed));
  return { signature: base64Encode(sig), signedDelegateAction: base64Encode(encodeNearSignedDelegateAction(delegateBytes, { type: 'ed25519', bytes: sig })) };
}

export interface Nep413SignedResult {
  /** The signer's implicit account id (the hex of its public key). */
  accountId: string;
  /** `ed25519:<base58>`. */
  publicKey: string;
  /** base64 of the 64-byte signature. */
  signature: string;
}

/** Signs NEP-413 message bytes (`u32le(2^31 + 413) ‖ borsh(Payload)`), as this seed's implicit account. */
export function signNep413Message(seed: Uint8Array, messageBytes: Uint8Array): Nep413SignedResult {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  decodeNep413Message(messageBytes);
  const pub = ed25519.getPublicKey(seed);
  return { accountId: nearImplicitAccountId(pub), publicKey: nearPublicKeyString(pub), signature: base64Encode(ed25519.sign(nep413Hash(messageBytes), seed)) };
}
