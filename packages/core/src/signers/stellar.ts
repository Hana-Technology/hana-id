// Stellar signers (docs/batch-b-spec.md "Signing and approval", "What gets signed"). Each takes the 32-byte Ed25519
// seed that derivation.ts withChainKey hands it for one signature, and never keeps it. XDR parsing uses
// @stellar/stellar-base; the signing itself is @noble/curves Ed25519, so the seed never enters stellar-base.
//
// - transaction: Ed25519 over sha256(sha256(passphrase) ‖ envelopeType ‖ tx XDR) (stellar-base's Transaction.hash),
//   appended as a DecoratedSignature (hint = the last 4 bytes of the public key). Fee-bump envelopes are signed as
//   given (the outer envelope).
// - auth entry: Ed25519 over sha256(HashIdPreimage XDR), which must be ENVELOPE_TYPE_SOROBAN_AUTHORIZATION for the
//   given network.
// - message: SEP-53, Ed25519 over sha256("Stellar Signed Message:\n" ‖ message).
// - raw: Ed25519 over the bytes themselves (≤ 4 KiB). It can sign anything on Stellar; only under raw approval.
import { ed25519 } from '@noble/curves/ed25519';
import { FeeBumpTransaction, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-base';
import { STRKEY_VERSION, decodeStrKey, stellarAddress } from '../addresses.ts';
import { type Bytes, base64Decode, base64Encode, bytesEqual, concatBytes, sha256, toBytes, utf8 } from '../bytes.ts';

export const SEP53_PREFIX = 'Stellar Signed Message:\n';
/** hana_signRaw's Stellar limit. */
export const STELLAR_RAW_MAX_BYTES = 4096;
/** Stellar's limit on signatures per envelope. */
const MAX_SIGNATURES = 20;
const MAX_PASSPHRASE_LENGTH = 256;

export type StellarEnvelopeKind = 'transaction' | 'fee_bump';

function checkSeed(seed: Uint8Array): void {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
}

function checkPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) throw new Error('Invalid network passphrase');
}

/** The G… address of a seed. */
export function stellarSignerAddress(seed: Uint8Array): string {
  checkSeed(seed);
  return stellarAddress(ed25519.getPublicKey(seed));
}

/**
 * Parses a base64 TransactionEnvelope for `networkPassphrase`. The input must be canonical XDR (it re-encodes to the
 * same string), so the bytes the approval popup decodes are exactly the ones whose hash is signed.
 */
export function parseStellarEnvelope(envelopeXdr: string, networkPassphrase: string): { kind: StellarEnvelopeKind; tx: Transaction | FeeBumpTransaction } {
  checkPassphrase(networkPassphrase);
  if (typeof envelopeXdr !== 'string') throw new Error('Transaction XDR must be a base64 string');
  base64Decode(envelopeXdr);
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  } catch {
    throw new Error('Malformed transaction XDR');
  }
  if (envelope.toXDR('base64') !== envelopeXdr) throw new Error('Transaction XDR is not canonical');
  const type = envelope.switch();
  if (type !== xdr.EnvelopeType.envelopeTypeTx() && type !== xdr.EnvelopeType.envelopeTypeTxFeeBump() && type !== xdr.EnvelopeType.envelopeTypeTxV0()) {
    throw new Error('Unsupported envelope type');
  }
  const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase);
  return { kind: tx instanceof FeeBumpTransaction ? 'fee_bump' : 'transaction', tx };
}

/** The 32-byte hash a Stellar transaction signature covers. */
export function stellarTransactionHash(envelopeXdr: string, networkPassphrase: string): Bytes {
  return toBytes(parseStellarEnvelope(envelopeXdr, networkPassphrase).tx.hash());
}

/** Signs a v1, v0 or fee-bump envelope and returns it with the signature appended. */
export function signStellarTransaction(seed: Uint8Array, envelopeXdr: string, networkPassphrase: string): { signedTxXdr: string; signerAddress: string } {
  checkSeed(seed);
  const { tx } = parseStellarEnvelope(envelopeXdr, networkPassphrase);
  if (tx.signatures.length >= MAX_SIGNATURES) throw new Error('The envelope already has the maximum number of signatures');
  const publicKey = ed25519.getPublicKey(seed);
  const signerAddress = stellarAddress(publicKey);
  const signature = ed25519.sign(toBytes(tx.hash()), seed);
  // addSignature re-verifies the signature against the public key and builds the hint from it.
  tx.addSignature(signerAddress, base64Encode(signature));
  return { signedTxXdr: tx.toXDR(), signerAddress };
}

/** Parses a base64 HashIdPreimage; it must be ENVELOPE_TYPE_SOROBAN_AUTHORIZATION for `networkPassphrase`. */
export function parseStellarAuthPreimage(preimageXdr: string, networkPassphrase: string): { bytes: Bytes; preimage: xdr.HashIdPreimage } {
  checkPassphrase(networkPassphrase);
  if (typeof preimageXdr !== 'string') throw new Error('Auth entry preimage must be a base64 string');
  const bytes = base64Decode(preimageXdr);
  let preimage: xdr.HashIdPreimage;
  try {
    preimage = xdr.HashIdPreimage.fromXDR(preimageXdr, 'base64');
  } catch {
    throw new Error('Malformed auth entry preimage');
  }
  if (preimage.toXDR('base64') !== preimageXdr) throw new Error('Auth entry preimage is not canonical');
  if (preimage.switch() !== xdr.EnvelopeType.envelopeTypeSorobanAuthorization()) throw new Error('Auth entry preimage must be ENVELOPE_TYPE_SOROBAN_AUTHORIZATION');
  const networkId = sha256(utf8(networkPassphrase));
  if (!bytesEqual(toBytes(preimage.sorobanAuthorization().networkId()), networkId)) throw new Error('Auth entry preimage is for another network');
  return { bytes, preimage };
}

/** The 32-byte hash an auth entry signature covers: sha256(HashIdPreimage XDR). */
export const stellarAuthEntryHash = (preimageXdr: string, networkPassphrase: string): Bytes => sha256(parseStellarAuthPreimage(preimageXdr, networkPassphrase).bytes);

/** Signs a Soroban authorization preimage. `signedAuthEntry` is the base64 of the 64-byte signature. */
export function signStellarAuthEntry(seed: Uint8Array, preimageXdr: string, networkPassphrase: string): { signedAuthEntry: string; signerAddress: string } {
  checkSeed(seed);
  const hash = stellarAuthEntryHash(preimageXdr, networkPassphrase);
  return { signedAuthEntry: base64Encode(ed25519.sign(hash, seed)), signerAddress: stellarSignerAddress(seed) };
}

/** The message bytes (a string is UTF-8). */
export const stellarMessageBytes = (message: string | Uint8Array): Bytes => (typeof message === 'string' ? utf8(message) : toBytes(message));

/** SEP-53 hash: sha256("Stellar Signed Message:\n" ‖ message). */
export const sep53MessageHash = (message: string | Uint8Array): Bytes => sha256(concatBytes(utf8(SEP53_PREFIX), stellarMessageBytes(message)));

/** SEP-53 signature; `signedMessage` is base64 of the 64-byte signature. */
export function signStellarMessage(seed: Uint8Array, message: string | Uint8Array): { signedMessage: string; signerAddress: string } {
  checkSeed(seed);
  return { signedMessage: base64Encode(ed25519.sign(sep53MessageHash(message), seed)), signerAddress: stellarSignerAddress(seed) };
}

/** Raw Ed25519 signature (64 bytes) over `bytes` (1..4096 bytes). Can authorize anything on Stellar. */
export function signStellarRaw(seed: Uint8Array, bytes: Uint8Array): Bytes {
  checkSeed(seed);
  if (bytes.length === 0 || bytes.length > STELLAR_RAW_MAX_BYTES) throw new Error(`Raw Stellar input must be 1..${STELLAR_RAW_MAX_BYTES} bytes`);
  return toBytes(ed25519.sign(bytes, seed));
}

/** True if `signature` is a valid Ed25519 signature by the G… `address` over `message`. */
export function verifyStellarSignature(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, decodeStrKey(STRKEY_VERSION.ed25519PublicKey, address));
  } catch {
    return false;
  }
}
