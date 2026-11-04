// The wallet record (D310 point 3, D311): after a login the vault reports the wallet's Stellar and EVM addresses to the
// API (`POST /v1/wallets/record`), each signed by that chain's own derived key over a domain-separated statement, so
// the API stores an address for a user only when the address's key says so for that user's path and a live session
// of it. Shared by the vault (packages/web), the API (apps/api) and the tests.
//
//   statement = "hana-id/wallet-record/v1" ‖ 0x00 ‖ borsh(env) ‖ borsh(signer) ‖ borsh(app_id) ‖ borsh(scope_id)
//               ‖ borsh(path) ‖ borsh(chain) ‖ borsh(address) ‖ session_pk(32) ‖ u64le(issued_at_ms)
//   Stellar: Ed25519 (RFC 8032) by the account's key over the statement itself, 64 bytes.
//   EVM:     secp256k1 ECDSA (RFC 6979, low s) by the account's key over sha256(statement), r ‖ s ‖ v, v ∈ {27, 28}.
//
// borsh(s) is u32 LE byte length ‖ UTF-8. `address` is canonical (G… StrKey; EVM in EIP-55), `path` the on-chain
// session path `scope#provider#sub#key_index` (a linked member's is its account root's), `issued_at_ms` the vault's
// server-corrected clock.
//
// Why a record signature is never anything else (each point has a test in test/wallet-record.test.ts):
//
// - Stellar transactions, Soroban authorization entries and SEP-53 messages. The network checks Ed25519 signatures
//   over a 32-byte hash: a transaction's over sha256(network id ‖ ENVELOPE_TYPE_TX… ‖ tx), an auth entry's over
//   sha256(HashIdPreimage ENVELOPE_TYPE_SOROBAN_AUTHORIZATION …), and SEP-53 wallets sign sha256("Stellar Signed
//   Message:\n" ‖ m). Ed25519 signs the message bytes themselves and a signature verifies for that message only
//   (EUF-CMA), and a statement is always far longer than 32 bytes (the domain alone is 24), so it is never one of
//   those hashes: a record signature can't be replayed as any of them.
// - EVM transactions, EIP-191 and EIP-712. Each is an ECDSA signature over a keccak256 digest: of the RLP (or 0x02 ‖
//   RLP) transaction, of "\x19Ethereum Signed Message:\n" ‖ len ‖ m, of 0x19 0x01 ‖ domainSeparator ‖ structHash. A
//   record signature is over sha256(statement), so replaying it as one of those needs a keccak256 output equal to a
//   sha256 output of a chosen-prefix input: a second preimage across two hash functions, not feasible. The digest is
//   also never handed to a dapp: the vault sends the proof only to the API, which never stores or returns it.
// - What the approval flow signs (approval.ts, packages/web/src/vault/signing.ts). Its Stellar kinds sign the
//   32-byte hashes above (never a statement, by length). Its EVM kinds other than raw sign keccak256 digests (above).
//   A raw Stellar request is any 1..4096 bytes, but the vault refuses raw bytes that start with "hana-id" before any
//   popup (D179, `RESERVED_RAW_PREFIX`), and every statement does. A raw EVM request is any 32-byte digest: the vault
//   refuses the digest of its own session's record (as D179 refuses its identity wallet proof), but a digest is
//   opaque, so a user who approves a raw EVM signature over a digest an attacker computed from the attacker's own
//   session can let that attacker list the user's EVM address under the attacker's own user. That is D179's residual,
//   by construction: any ECDSA proof is forgeable by an approved raw signature, and the approval already authorizes
//   any transaction from that key (the popup's red warning). Mitigations: raw signing is off by default, a guarded
//   change, never auto-approved and refused for test apps; the attacker gains a false row under its own user only,
//   never another user's wallet; an address listed under more than one user is shown so (`sharedWith`). D311 records
//   why a non-ECDSA scheme (BIP-340 with the same key) was rejected.
// - Other Hana signatures. The domain differs from every other Hana signing domain (the session message
//   "hana-id-session-v1:", the vault message "hana-id-vault-v1:", the identity token's "hana-id-identity-v1:" and
//   "hana-id/identity-wallet/v1", the approval digest "hana-id/approve/v1"), and the 0x00 after it ends the domain, so
//   no other Hana message is a record statement or the other way round.
//
// SECURITY: the chain keys come from derivation.ts withChainKey, for one signature each, and are zeroed there. A record
// is not secret (it says "this address is this path's"), but it is never logged, and the API keeps only the address.
import { concatBytes, borshString, sha256, toBytes, u64le, utf8, type Bytes } from './bytes.ts';
import { type IdentityChain, IDENTITY_CHAINS, canonicalWalletAddress, signWalletProof } from './identity.ts';
import { recoverEvmAddress } from './signers/evm.ts';
import { STRKEY_VERSION, decodeStrKey } from './addresses.ts';
import { ed25519 } from '@noble/curves/ed25519';

export const WALLET_RECORD_DOMAIN = 'hana-id/wallet-record/v1';
/** The API accepts a record whose `issuedAtMs` is within this of its clock (a replay changes nothing: rows only move forward in time). */
export const WALLET_RECORD_WINDOW_MS = 5 * 60_000;
/** The vault gives the background report this long, then drops it (one call, no retry). */
export const WALLET_RECORD_TIMEOUT_MS = 15_000;
/** The request body's cap at the API. */
export const WALLET_RECORD_MAX_BODY = 4096;

export type WalletRecordChain = IdentityChain;
export const WALLET_RECORD_CHAINS: readonly WalletRecordChain[] = IDENTITY_CHAINS;

export interface WalletRecordContext {
  /** The env name (`envs/<env>.json` name; the API's ENV_NAME). */
  env: string;
  /** The pinned hana-signer account. */
  signer: string;
  /** The D1 `apps.id` the vault runs for. */
  appId: string;
  scopeId: string;
  /** The on-chain session path `scope#provider#sub#key_index`. */
  path: string;
  /** Raw 32-byte Ed25519 session public key. */
  sessionPublicKey: Uint8Array;
  /** The vault's server-corrected clock, ms. */
  issuedAtMs: number;
}

const MAX_FIELD_BYTES = 1024;

function field(s: string, what: string): Bytes {
  if (typeof s !== 'string' || s.length === 0) throw new Error(`${what} must be a non-empty string`);
  const b = utf8(s);
  if (b.length > MAX_FIELD_BYTES) throw new Error(`${what} is too long`);
  return borshString(s);
}

/** The statement a chain key signs (layout in the header). Throws on a malformed input; `address` must be canonical. */
export function walletRecordStatement(ctx: WalletRecordContext, chain: WalletRecordChain, address: string): Bytes {
  if (!(ctx.sessionPublicKey instanceof Uint8Array) || ctx.sessionPublicKey.length !== 32) throw new Error('Session public key must be 32 bytes');
  if (!Number.isSafeInteger(ctx.issuedAtMs) || ctx.issuedAtMs < 0) throw new Error('issuedAtMs must be a non-negative integer');
  if (chain !== 'stellar' && chain !== 'evm') throw new Error('Unknown chain');
  if (canonicalWalletAddress(chain, address) !== address) throw new Error('The address must be canonical');
  if (!ctx.path.startsWith(`${ctx.scopeId}#`)) throw new Error('The path is not of this scope');
  return concatBytes(
    utf8(WALLET_RECORD_DOMAIN),
    Uint8Array.of(0),
    field(ctx.env, 'env'),
    field(ctx.signer, 'signer'),
    field(ctx.appId, 'appId'),
    field(ctx.scopeId, 'scopeId'),
    field(ctx.path, 'path'),
    borshString(chain),
    borshString(address),
    toBytes(ctx.sessionPublicKey),
    u64le(ctx.issuedAtMs),
  );
}

/** The 32-byte digest the EVM key signs (and the raw EVM digest the vault refuses for its own session, D179). */
export const walletRecordEvmDigest = (ctx: WalletRecordContext, address: string): Bytes => sha256(walletRecordStatement(ctx, 'evm', address));

/**
 * A record signature by `key` (the Stellar Ed25519 seed or the EVM secp256k1 `d`, as withChainKey hands it), for
 * use inside withChainKey: synchronous, the key never kept. The scheme is the identity wallet proof's (identity.ts).
 */
export function signWalletRecord(chain: WalletRecordChain, key: Uint8Array, statement: Uint8Array): Bytes {
  return signWalletProof(chain, key, statement);
}

export interface WalletRecordProof {
  address: string;
  /** Stellar: 64 bytes; EVM: 65 bytes r ‖ s ‖ v. */
  signature: Uint8Array;
}

/**
 * Checks one record: the address well formed (EVM in any case, canonicalized to EIP-55) and the signature over the
 * statement for `ctx` and that canonical address by the address's own key (Ed25519 strict, as the contract; EVM by
 * recovery). Returns the canonical address, or null.
 */
export function verifyWalletRecord(ctx: WalletRecordContext, chain: WalletRecordChain, proof: WalletRecordProof): string | null {
  const address = canonicalWalletAddress(chain, proof.address);
  if (address === null || !(proof.signature instanceof Uint8Array)) return null;
  let statement: Bytes;
  try {
    statement = walletRecordStatement(ctx, chain, address);
  } catch {
    return null;
  }
  try {
    if (chain === 'stellar') {
      if (proof.signature.length !== 64) return null;
      return ed25519.verify(proof.signature, statement, decodeStrKey(STRKEY_VERSION.ed25519PublicKey, address), { zip215: false }) ? address : null;
    }
    if (proof.signature.length !== 65) return null;
    return recoverEvmAddress(sha256(statement), proof.signature) === address ? address : null;
  } catch {
    return null;
  }
}

// ---- POST /v1/wallets/record ----

/** The request body: bytes as JSON number arrays. */
export interface WalletRecordBody {
  sessionPublicKey: number[];
  issuedAtMs: number;
  path: string;
  wallets: { stellar: { address: string; signature: number[] }; evm: { address: string; signature: number[] } };
}

export interface WalletRecordResponse {
  recorded: true;
}

export const isWalletRecordResponse = (v: unknown): v is WalletRecordResponse => typeof v === 'object' && v !== null && (v as WalletRecordResponse).recorded === true;
