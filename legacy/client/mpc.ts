// Address derivation and signing for Hana Embed. Keys never exist anywhere: the NEAR MPC network signs, and only
// after hana-signer has checked the user's session (opened with their Google login) signed this exact envelope.
import { Buffer } from 'buffer';
import { FeeBumpTransaction, Keypair, StrKey, type Transaction, xdr } from '@stellar/stellar-sdk';
import { KeyType, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction } from '@near-js/transactions';
import { baseDecode } from '@near-js/utils';
import { getAddress, keccak256, type Hex } from 'viem';
import { ENVELOPE_METHOD, MPC_CONTRACT, MPC_DOMAIN, NEAR_RPC, SIGNER_CONTRACT } from './config';

async function viewCall<T>(account: string, method: string, args: unknown): Promise<T> {
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'embed',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string } };
  if (!body.result?.result) throw new Error(body.result?.error ?? body.error?.message ?? 'NEAR RPC error');
  return JSON.parse(Buffer.from(body.result.result).toString()) as T;
}

/** The MPC network's CKD public key (domain 2, BLS12-381 G2), as `bls12381g2:<base58>`. */
export async function ckdNetworkKey(): Promise<string> {
  const state = await viewCall<{ Running: { keyset: { domains: { domain_id: number; key: { Bls12381?: { public_key: string } } }[] } } }>(MPC_CONTRACT, 'state', {});
  const key = state.Running.keyset.domains.find((d) => d.domain_id === MPC_DOMAIN.ckd)?.key.Bls12381?.public_key;
  if (!key) throw new Error('The MPC has no CKD key');
  return key;
}

/** The MPC public key at a derivation path, as NEAR prints it (`secp256k1:…` / `ed25519:…`). */
export function derivedPublicKey(path: string, curve: keyof typeof MPC_DOMAIN): Promise<string> {
  return viewCall<string>(MPC_CONTRACT, 'derived_public_key', { path, predecessor: SIGNER_CONTRACT, domain_id: MPC_DOMAIN[curve] });
}

/** `secp256k1:<base58 of the 64-byte uncompressed point>` → checksummed EVM address. */
export function evmAddressFromNearKey(nearKey: string): Hex {
  const [type, data] = nearKey.split(':');
  if (type !== 'secp256k1' || !data) throw new Error(`Not a secp256k1 key: ${nearKey}`);
  const point = baseDecode(data);
  if (point.length !== 64) throw new Error('Unexpected secp256k1 key length');
  return getAddress(`0x${keccak256(point).slice(-40)}`);
}

/** `ed25519:<base58 of 32 bytes>` → Stellar G-address. */
export function stellarAddressFromNearKey(nearKey: string): string {
  const [type, data] = nearKey.split(':');
  if (type !== 'ed25519' || !data) throw new Error(`Not an ed25519 key: ${nearKey}`);
  return StrKey.encodeEd25519PublicKey(Buffer.from(baseDecode(data)));
}

export interface EmbedAddresses {
  stellar: string;
  evm: Hex;
}

/** The user's addresses at their session's path (`{scope}#google#{sub}`). */
export async function deriveAddresses(path: string): Promise<EmbedAddresses> {
  const [ed, secp] = await Promise.all([derivedPublicKey(path, 'ed25519'), derivedPublicKey(path, 'secp256k1')]);
  return { stellar: stellarAddressFromNearKey(ed), evm: evmAddressFromNearKey(secp) };
}

/**
 * The bytes the contract signs: a NEAR transaction used only as an envelope (kept from the NEAR Auth flow, whose
 * login accepts nothing else). One function call on hana-signer whose method names the chain and whose args are
 * the bytes to sign. The zero block hash makes it impossible to execute on NEAR.
 */
export function envelope(chain: keyof typeof ENVELOPE_METHOD, bytes: Uint8Array): number[] {
  const tx = createTransaction(
    'hana-embed',
    new PublicKey({ keyType: KeyType.ED25519, data: new Uint8Array(32) }),
    SIGNER_CONTRACT,
    0n,
    [actionCreators.functionCall(ENVELOPE_METHOD[chain], bytes, 0n, 0n)],
    new Uint8Array(32),
  );
  return [...encodeTransaction(tx)];
}

/** Gets an envelope signed by the user's MPC keys and returns the MPC's raw result (see auth.ts `signWithSession`). */
export type Approve = (envelope: number[]) => Promise<{ result: unknown; nearTx?: string }>;

/** What the MPC returns, by curve (the contract passes it through unchanged). */
export type MpcSignature =
  | { scheme: 'Ed25519'; signature: number[] }
  | { scheme: 'Secp256k1'; big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

export function ed25519Signature(sig: MpcSignature): Uint8Array {
  if (sig.scheme !== 'Ed25519' || sig.signature.length !== 64) throw new Error('Expected a 64-byte Ed25519 signature from the MPC');
  return Uint8Array.from(sig.signature);
}

/** MPC secp256k1 output → r, s, yParity. `big_r` is a compressed point; r is its x coordinate. */
export function secp256k1Signature(sig: MpcSignature): { r: Hex; s: Hex; yParity: 0 | 1 } {
  if (sig.scheme !== 'Secp256k1') throw new Error('Expected a secp256k1 signature from the MPC');
  const point = sig.big_r.affine_point;
  if (!/^0[23][0-9a-fA-F]{64}$/u.test(point) || !/^[0-9a-fA-F]{64}$/u.test(sig.s.scalar)) throw new Error('Malformed MPC secp256k1 signature');
  if (sig.recovery_id !== 0 && sig.recovery_id !== 1) throw new Error('Unexpected MPC recovery id');
  return { r: `0x${point.slice(2)}`, s: `0x${sig.s.scalar}`, yParity: sig.recovery_id };
}

export interface SignTiming {
  /** Session signature → relayer → contract checks → MPC signature back. */
  nearMs: number;
  nearTx?: string;
}

export async function mpcSign(approve: Approve, payload: number[]): Promise<{ signature: MpcSignature; timing: SignTiming }> {
  const t0 = performance.now();
  const { result, nearTx } = await approve(payload);
  if (!result) throw new Error('The MPC returned no signature');
  return { signature: result as MpcSignature, timing: { nearMs: Math.round(performance.now() - t0), nearTx } };
}

/** Signs a Stellar transaction with the user's MPC key and attaches the signature (verified locally first). */
export async function signStellarTransaction(approve: Approve, address: string, tx: Transaction): Promise<SignTiming> {
  if ((tx as unknown) instanceof FeeBumpTransaction) throw new Error('Fee-bump transactions aren’t supported');
  const { signature, timing } = await mpcSign(approve, envelope('stellar', tx.signatureBase()));
  const sig = Buffer.from(ed25519Signature(signature));
  const kp = Keypair.fromPublicKey(address);
  // The contract signed sha256(signature base) = the Stellar tx hash. Check before attaching.
  if (!kp.verify(tx.hash(), sig)) throw new Error('The MPC signature doesn’t verify for this account');
  tx.signatures.push(new xdr.DecoratedSignature({ hint: kp.signatureHint(), signature: sig }));
  return timing;
}

/** Signs a keccak preimage (unsigned tx serialisation, EIP-191 or EIP-712 bytes) with the user's EVM MPC key. */
export async function signEvmPreimage(approve: Approve, preimage: Uint8Array): Promise<{ r: Hex; s: Hex; yParity: 0 | 1; timing: SignTiming }> {
  const { signature, timing } = await mpcSign(approve, envelope('evm', preimage));
  return { ...secp256k1Signature(signature), timing };
}
