// Approval requests and the approval digest (docs/batch-b-spec.md "Approval flow", step 6). The popup computes the
// digest from exactly what it rendered and returns it with Approve; the vault recomputes it from the queued request and
// signs only on a match, so an approval binds the whole request: id, kind, chain, address, parent origin, network
// context and every byte.
//
//   digest = sha256(utf8("hana-id/approve/v1") ‖ borsh(id) ‖ borsh(kind) ‖ borsh(chain) ‖ borsh(address)
//                   ‖ borsh(parentOrigin) ‖ borsh(contextString) ‖ u32le(len(bytes)) ‖ bytes)
//
// borsh(s) is u32 LE byte length ‖ UTF-8; contextString is the network passphrase (Stellar), the decimal chain ID
// (EVM) or `near:testnet` / `near:mainnet` (NEAR, D722) for the kinds whose request names its network (stellar_tx,
// stellar_auth_entry, evm_tx, near_tx, near_delegate), and '' for the others:
// a message, typed data (its domain carries the chain) or a raw request names none, and the vault, which never learns
// the partner's selected EVM chain (the SDK answers eth_chainId), has none to bind.
import { sha256 } from '@noble/hashes/sha2';

export const APPROVAL_DIGEST_DOMAIN = 'hana-id/approve/v1';

/**
 * What a request signs, and what its `bytes` are:
 * - `stellar_tx`: a `TransactionEnvelope` XDR (v1, v0 or fee-bump);
 * - `stellar_auth_entry`: a `HashIdPreimage` XDR (`ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`);
 * - `stellar_message`: the SEP-53 message;
 * - `evm_tx`: the unsigned transaction the vault signs (EIP-1559 `0x02 ‖ rlp(9 fields)` or EIP-155 legacy rlp);
 * - `personal_sign`: the EIP-191 message;
 * - `eip712`: the `eth_signTypedData_v4` JSON, UTF-8;
 * - `raw`: the Ed25519 message (Stellar, ≤ 4 KiB) or the 32-byte secp256k1 digest (EVM). Never decoded.
 * - `near_tx`: a borsh NEAR `Transaction` (its sha256 is signed);
 * - `near_delegate`: a borsh NEP-366 `DelegateAction`, without NEP-461's prefix (sha256(prefix ‖ bytes) is signed);
 * - `near_message`: NEP-413's `u32le(2^31 + 413) ‖ borsh(Payload)` (its sha256 is signed).
 */
export const APPROVAL_KINDS = [
  'stellar_tx',
  'stellar_auth_entry',
  'stellar_message',
  'evm_tx',
  'personal_sign',
  'eip712',
  'raw',
  'near_tx',
  'near_message',
  'near_delegate',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalChain = 'stellar' | 'evm' | 'near';
export const APPROVAL_CHAINS: readonly ApprovalChain[] = ['stellar', 'evm', 'near'];

/**
 * Kinds no auto-approve policy can ever cover. The NEAR kinds are here because no policy format covers NEAR yet:
 * every NEAR request gets the approval popup.
 */
export const NEVER_AUTO_APPROVED_KINDS: ReadonlySet<ApprovalKind> = new Set([
  'raw',
  'personal_sign',
  'stellar_message',
  'near_tx',
  'near_message',
  'near_delegate',
]);

/** The NEAR networks a request may name. */
export const NEAR_NETWORKS = ['testnet', 'mainnet'] as const;
export type NearNetwork = (typeof NEAR_NETWORKS)[number];
export const isNearNetwork = (v: unknown): v is NearNetwork => v === 'testnet' || v === 'mainnet';

export type ApprovalContext =
  | { readonly networkPassphrase: string }
  | { readonly chainId: number }
  | { readonly nearNetwork: NearNetwork }
  | { readonly [key: string]: never };

/** The context a kind carries: the network passphrase, the chain ID, the NEAR network, or none (`{}`). */
export function approvalKindContext(kind: ApprovalKind): 'networkPassphrase' | 'chainId' | 'nearNetwork' | 'none' {
  if (kind === 'stellar_tx' || kind === 'stellar_auth_entry') return 'networkPassphrase';
  if (kind === 'near_tx' || kind === 'near_delegate') return 'nearNetwork';
  return kind === 'evm_tx' ? 'chainId' : 'none';
}

/** The signed part of a request: everything the popup renders and the digest binds, except `id` and origin. */
export interface ApprovalSubject {
  readonly kind: ApprovalKind;
  readonly chain: ApprovalChain;
  /** The vault's address on `chain` (StrKey G…, EIP-55 0x… or the NEAR implicit account id). */
  readonly address: string;
  readonly context: ApprovalContext;
  readonly bytes: Uint8Array;
}

export interface ApprovalDigestInput extends ApprovalSubject {
  /** The request id (128-bit random, from the vault). */
  readonly id: string;
  /** The partner origin the vault pinned at the handshake. */
  readonly parentOrigin: string;
}

export const APPROVAL_MAX_BYTES = 192 * 1024;
export const RAW_STELLAR_MAX_BYTES = 4096;
const MAX_STRING_BYTES = 1024;

/** The chain a kind belongs to, or null for `raw` (Stellar or EVM). */
export function approvalKindChain(kind: ApprovalKind): ApprovalChain | null {
  if (kind === 'raw') return null;
  if (kind.startsWith('near_')) return 'near';
  return kind.startsWith('stellar_') ? 'stellar' : 'evm';
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// Without the `u` flag a regex sees UTF-16 code units, so this finds a surrogate that is not half of a pair (which
// TextEncoder would silently turn into U+FFFD, making two different strings encode the same).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(s: unknown, what: string): asserts s is string {
  if (typeof s !== 'string' || s.length === 0) throw new Error(`${what} must be a non-empty string`);
  if (LONE_SURROGATE.test(s)) throw new Error(`${what} has a lone surrogate`);
  if (utf8(s).length > MAX_STRING_BYTES) throw new Error(`${what} is too long`);
}

/** Throws unless kind, chain, context and bytes fit together (the shape both the popup and the vault require). */
export function validateApprovalSubject(s: ApprovalSubject): void {
  if (!(APPROVAL_KINDS as readonly string[]).includes(s.kind)) throw new Error('Unknown approval kind');
  if (!APPROVAL_CHAINS.includes(s.chain)) throw new Error('Unknown approval chain');
  const kindChain = approvalKindChain(s.kind);
  if (kindChain !== null && kindChain !== s.chain) throw new Error(`Kind ${s.kind} is not on ${s.chain}`);
  checkString(s.address, 'address');
  const contextKeys = typeof s.context === 'object' && s.context !== null ? Object.keys(s.context) : null;
  const wanted = approvalKindContext(s.kind);
  if (wanted === 'none' ? contextKeys?.length !== 0 : contextKeys?.length !== 1 || contextKeys[0] !== wanted) {
    throw new Error(wanted === 'none' ? `${s.kind} has no context` : `${s.kind} context is {${wanted}}`);
  }
  approvalContextString(s.chain, s.context);
  if (!(s.bytes instanceof Uint8Array)) throw new Error('bytes must be a Uint8Array');
  if (s.bytes.length > APPROVAL_MAX_BYTES) throw new Error('bytes too large');
  if (s.kind === 'raw') {
    if (s.chain === 'near') throw new Error('A raw request is on Stellar or EVM');
    if (s.chain === 'evm' && s.bytes.length !== 32) throw new Error('A raw EVM request is a 32-byte digest');
    if (s.chain === 'stellar' && (s.bytes.length === 0 || s.bytes.length > RAW_STELLAR_MAX_BYTES)) {
      throw new Error(`A raw Stellar request is 1 to ${RAW_STELLAR_MAX_BYTES} bytes`);
    }
  }
}

/**
 * The network passphrase (Stellar), the decimal chain ID (EVM), `near:<network>` (NEAR), or '' for an empty context.
 * Throws if the context doesn't fit the chain (validateApprovalSubject also checks it fits the kind).
 */
export function approvalContextString(chain: ApprovalChain, context: ApprovalContext): string {
  if (typeof context !== 'object' || context === null) throw new Error('context must be an object');
  const keys = Object.keys(context);
  if (keys.length === 0) return '';
  if (chain === 'stellar') {
    if (keys.length !== 1 || !('networkPassphrase' in context)) {
      throw new Error('Stellar context is {networkPassphrase}');
    }
    checkString(context.networkPassphrase, 'networkPassphrase');
    return context.networkPassphrase;
  }
  if (chain === 'near') {
    if (keys.length !== 1 || !('nearNetwork' in context)) throw new Error('NEAR context is {nearNetwork}');
    if (!isNearNetwork(context.nearNetwork)) throw new Error('nearNetwork is testnet or mainnet');
    return `near:${context.nearNetwork}`;
  }
  if (keys.length !== 1 || !('chainId' in context)) throw new Error('EVM context is {chainId}');
  if (!Number.isSafeInteger(context.chainId) || context.chainId <= 0) {
    throw new Error('chainId must be a positive integer');
  }
  return String(context.chainId);
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

const borshString = (s: string): Uint8Array[] => {
  const b = utf8(s);
  return [u32le(b.length), b];
};

/** The digest preimage (exposed for the layout fixture test). Validates the input first. */
export function approvalDigestPreimage(i: ApprovalDigestInput): Uint8Array {
  validateApprovalSubject(i);
  checkString(i.id, 'id');
  checkString(i.parentOrigin, 'parentOrigin');
  const parts = [
    utf8(APPROVAL_DIGEST_DOMAIN),
    ...borshString(i.id),
    ...borshString(i.kind),
    ...borshString(i.chain),
    ...borshString(i.address),
    ...borshString(i.parentOrigin),
    ...borshString(approvalContextString(i.chain, i.context)),
    u32le(i.bytes.length),
    i.bytes,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The 32-byte approval digest. */
export const approvalDigest = (i: ApprovalDigestInput): Uint8Array => sha256(approvalDigestPreimage(i));

/** Constant-time comparison of two digests (the vault compares the popup's digest with its own). */
export function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** The raw-signing warning the approval popup shows. */
export const rawSigningWarning = (chainName: string, appName: string): string =>
  `Raw signing can authorize any transaction, authorization or message on ${chainName}. Hana can't tell what this is. ` +
  `Only approve if you trust ${appName} completely.`;
