// What the vault signs (docs/batch-b-spec.md "Signing and approval", "What gets signed"). A sign request first becomes
// an approval subject (@hana-id/core protocol.ts approvalContent: exactly the bytes that get signed, or hashed into what
// gets signed, plus the network context); the approval popup decodes those bytes itself and the approval digest binds
// them. After an approval (or an accepted auto-approve policy) the vault signs from the same parsed request. Each chain
// key is derived from PRK per signature (withChainKey, HKDF-Expand) and zeroed in `finally`.
import {
  APPROVAL_KIND,
  type ApprovalSubject,
  ErrorCode,
  type PortRequest,
  type PortResultMap,
  type SignMethod,
  approvalChain,
  approvalContent,
  bytesEqual,
  from0xHex,
  TEST_APP_NETWORK_RULE,
  TEST_APP_RAW_RULE,
  hashTypedData,
  mainnetOfRequest,
  normalizeTypedData,
  personalSign,
  signEvmDigest,
  signEvmTransaction,
} from '@hana-id/core';
import { withChainKey } from '@hana-id/core/derivation';
import { type DemoAssessment, MAINNET_DEMO, assessMainnetDemo, formatUsd } from '@hana-id/core/mainnet-demo';
import {
  parseStellarAuthPreimage,
  parseStellarEnvelope,
  signStellarAuthEntry,
  signStellarMessage,
  signStellarRaw,
  signStellarTransaction,
} from '@hana-id/core/signers/stellar';
import type { RecordAddresses } from './record.ts';
import { VaultError } from './errors.ts';

export type SignRequest = Extract<PortRequest, { method: SignMethod }>;

/** The account under the path's key_index (fixed at 0 in the MVP; other values reserved). */
const ACCOUNT = 0;

const sameEvm = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface SubjectRules {
  /** The app's raw-signing setting in force (the vault re-reads it before a raw request). */
  rawSign: 'off' | 'approval';
  /** A pk_test_ app: mainnet chains are refused (docs/decisions.md D39, @hana-id/core networks.ts). */
  testApp: boolean;
  /**
   * The mainnet demo exception (D426): set only when this vault's build is a dev testnet build and the app's
   * `mainnetDemo` was confirmed on (vault.ts freshMainnetDemo); `nowMs` is the server-corrected time the price table is
   * checked against. Null: every mainnet is refused for a test app, as D39 says.
   */
  mainnetDemo?: { nowMs: number } | null;
  /**
   * EVM digests a raw request may never be (D179): the session's own identity wallet-proof digest, so an approved raw
   * signature can't stand in for a wallet proof.
   */
  reservedEvmDigests?: readonly Uint8Array[];
}

/** Hana's own signing domains start with this; raw Stellar bytes that do are refused (D179). */
export const RESERVED_RAW_PREFIX = 'hana-id';
const RESERVED_RAW_PREFIX_BYTES = new TextEncoder().encode(RESERVED_RAW_PREFIX);

/** Refuses a raw request that could double as a Hana-domain signature (a wallet proof, a session proof). */
function refuseReservedRaw(request: SignRequest, rules: SubjectRules): void {
  if (request.method !== 'hana_signRaw') return;
  const p = request.params;
  const reserved =
    p.chain === 'stellar'
      ? p.bytes.length >= RESERVED_RAW_PREFIX_BYTES.length && bytesEqual(p.bytes.subarray(0, RESERVED_RAW_PREFIX_BYTES.length), RESERVED_RAW_PREFIX_BYTES)
      : (rules.reservedEvmDigests ?? []).some((d) => bytesEqual(d, p.digest));
  if (reserved) throw new VaultError(ErrorCode.unauthorized, 'This raw request is a Hana signing domain and is never signed', { reason: 'raw_reserved_domain' });
}

/**
 * The approval subject of a sign request for this vault's addresses. Throws VaultError 4100 when the request names
 * another address, when raw signing is off, when a test app asks for a mainnet (reason `mainnet_not_allowed`) or for a
 * raw signature (reason `raw_not_allowed_for_test_apps`), or when
 * the request can't be signed as given (malformed typed data, non-canonical XDR, an envelope that doesn't parse for its
 * network).
 */
export function approvalSubject(request: SignRequest, addresses: RecordAddresses, rules: SubjectRules): ApprovalSubject {
  // A test app never signs raw (D39): a raw digest can be a mainnet transaction's hash. Before the app's setting.
  if (request.method === 'hana_signRaw' && rules.testApp) throw new VaultError(ErrorCode.unauthorized, TEST_APP_RAW_RULE, { reason: 'raw_not_allowed_for_test_apps' });
  if (request.method === 'hana_signRaw' && rules.rawSign !== 'approval') throw new VaultError(ErrorCode.unauthorized, 'Raw signing is off for this app', { reason: 'raw_sign_off' });
  refuseReservedRaw(request, rules);
  const chain = approvalChain(request);
  const address = chain === 'stellar' ? addresses.stellar : addresses.evm;
  switch (request.method) {
    case 'stellar_signTransaction':
    case 'stellar_signAuthEntry':
    case 'stellar_signMessage':
      if (request.params.address !== undefined && request.params.address !== addresses.stellar) throw addressMismatch();
      break;
    case 'personal_sign':
      if (!sameEvm(request.params[1], addresses.evm)) throw addressMismatch();
      break;
    case 'eth_signTypedData_v4':
      if (!sameEvm(request.params[0], addresses.evm)) throw addressMismatch();
      break;
    case 'eth_signTransaction': {
      const from = (request.params.tx as { from?: unknown }).from;
      if (from !== undefined && (typeof from !== 'string' || !sameEvm(from, addresses.evm))) throw addressMismatch();
      break;
    }
    default:
      break;
  }
  let content: ReturnType<typeof approvalContent>;
  try {
    content = approvalContent(request);
    // Refuse what the signer would refuse before anything is shown: typed data must normalize, and Stellar XDR must be
    // canonical for its network (the popup decodes these same bytes).
    if (request.method === 'eth_signTypedData_v4') normalizeTypedData(request.params[1]);
    if (request.method === 'stellar_signTransaction') parseStellarEnvelope(request.params.xdr, request.params.networkPassphrase);
    if (request.method === 'stellar_signAuthEntry') parseStellarAuthPreimage(request.params.preimageXdr, request.params.networkPassphrase);
  } catch {
    throw new VaultError(ErrorCode.unauthorized, 'The request is malformed', { reason: 'invalid_request' });
  }
  const subject: ApprovalSubject = { kind: APPROVAL_KIND[request.method], chain, address, ...content };
  // Before any popup or policy: a test app's keys come from the testnet MPC and must never sign for a mainnet, except
  // under the mainnet demo (D426), which signs only what it can value under its cap.
  if (rules.testApp) {
    const mainnet = mainnetOfRequest(request);
    if (mainnet) {
      if (!rules.mainnetDemo) throw new VaultError(ErrorCode.unauthorized, TEST_APP_NETWORK_RULE, { reason: 'mainnet_not_allowed', ...mainnet });
      const assessed = assessMainnetDemo(subject, rules.mainnetDemo.nowMs);
      if (!assessed.ok) throw demoRefusal(assessed, mainnet);
    }
  }
  return subject;
}

/** The 4100 a mainnet demo refusal answers: the reason, the network and, over the cap, the value and the cap. */
function demoRefusal(a: Extract<DemoAssessment, { ok: false }>, mainnet: NonNullable<ReturnType<typeof mainnetOfRequest>>): VaultError {
  const message = a.reason === 'mainnet_not_allowed' ? TEST_APP_NETWORK_RULE : a.message;
  return new VaultError(ErrorCode.unauthorized, message, {
    reason: a.reason,
    ...mainnet,
    ...(a.usdMicros !== undefined ? { usd: formatUsd(a.usdMicros) } : {}),
  });
}

/** The reasons a mainnet demo refusal carries (`mainnet_not_allowed` stays D39's). */
export const MAINNET_DEMO_REFUSALS: ReadonlySet<string> = new Set(['mainnet_demo_unknown_call', 'mainnet_demo_unpriced', 'mainnet_demo_over_cap', 'mainnet_demo_prices_stale']);

/** What the launcher flashes when the vault refuses a mainnet demo request (in Hana's own UI, at most 80 characters). */
export function demoRefusalFlash(reason: string): string {
  switch (reason) {
    case 'mainnet_demo_over_cap':
      return `Refused: over Hana’s ${formatUsd(MAINNET_DEMO.txCapUsdMicros)} mainnet demo limit per transaction`;
    case 'mainnet_demo_unpriced':
      return 'Refused: Hana has no price for an asset this moves (mainnet demo)';
    case 'mainnet_demo_prices_stale':
      return 'Refused: Hana’s mainnet demo prices need a review';
    default:
      return 'Refused: Hana can’t tell how much this mainnet request moves';
  }
}

const addressMismatch = (): VaultError => new VaultError(ErrorCode.unauthorized, 'The request names another address');

/**
 * Signs `request` with the key derived from `prk`. `subject` is the approved (or auto-approved) subject; the request is
 * re-checked against it, so the signature covers exactly the approved bytes and network.
 */
export function signRequest(prk: Uint8Array, request: SignRequest, subject: ApprovalSubject): PortResultMap[SignMethod] {
  const again = approvalContent(request);
  if (!bytesEqual(again.bytes, subject.bytes)) throw new Error('The request changed after approval');
  try {
    switch (request.method) {
      case 'stellar_signTransaction': {
        const { xdr, networkPassphrase } = request.params;
        return withChainKey(prk, 'stellar', ACCOUNT, (seed) => signStellarTransaction(seed, xdr, networkPassphrase));
      }
      case 'stellar_signAuthEntry': {
        const { preimageXdr, networkPassphrase } = request.params;
        return withChainKey(prk, 'stellar', ACCOUNT, (seed) => signStellarAuthEntry(seed, preimageXdr, networkPassphrase));
      }
      case 'stellar_signMessage': {
        const message = request.params.message;
        return withChainKey(prk, 'stellar', ACCOUNT, (seed) => signStellarMessage(seed, typeof message === 'string' ? message : Uint8Array.from(message)));
      }
      case 'eth_signTransaction': {
        const tx = request.params.tx;
        return withChainKey(prk, 'evm', ACCOUNT, (d) => signEvmTransaction(d, tx));
      }
      case 'personal_sign': {
        const message = from0xHex(request.params[0]);
        return withChainKey(prk, 'evm', ACCOUNT, (d) => personalSign(d, message));
      }
      case 'eth_signTypedData_v4': {
        // The single EIP-712 parser: the vault hashes the same normalized object the popup rendered.
        const digest = hashTypedData(normalizeTypedData(request.params[1]));
        return withChainKey(prk, 'evm', ACCOUNT, (d) => `0x${Array.from(signEvmDigest(d, digest), (b) => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`);
      }
      case 'hana_signRaw': {
        const params = request.params;
        if (params.chain === 'stellar') return { signature: withChainKey(prk, 'stellar', ACCOUNT, (seed) => signStellarRaw(seed, params.bytes)) };
        return { signature: withChainKey(prk, 'evm', ACCOUNT, (d) => signEvmDigest(d, params.digest)) };
      }
    }
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError(ErrorCode.unauthorized, 'The request could not be signed', { reason: 'invalid_request' });
  }
}
