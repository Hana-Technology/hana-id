// The approval popup's single entry point: decode a request's bytes itself (never trusting a summary from the vault)
// and check them against the request's network context. A request that doesn't decode is refused before display.
// `raw` is never decoded, even when its bytes happen to be a valid transaction or hash.
import { type ApprovalSubject, validateApprovalSubject } from '../approval.ts';
import { type NormalizedTypedData, normalizeTypedData, typedDataChainId } from '../typed-data.ts';
import { type TypedDataView, typedDataView } from './eip712.ts';
import { DecodeError, fail } from './errors.ts';
import { type DecodedEvmTx, decodeEvmTransaction } from './evm.ts';
import { toHex0x } from './hex.ts';
import { type DecodedMessage, decodeMessage } from './message.ts';
import {
  type DecodedStellarAuthPreimage,
  type DecodedStellarEnvelope,
  decodeStellarAuthPreimage,
  decodeStellarTransaction,
} from './stellar.ts';

export type DecodedApproval =
  | { readonly kind: 'stellar_tx'; readonly networkPassphrase: string; readonly envelope: DecodedStellarEnvelope }
  | {
      readonly kind: 'stellar_auth_entry';
      readonly networkPassphrase: string;
      readonly preimage: DecodedStellarAuthPreimage;
    }
  | { readonly kind: 'stellar_message'; readonly message: DecodedMessage }
  | { readonly kind: 'evm_tx'; readonly chainId: number; readonly tx: DecodedEvmTx }
  | { readonly kind: 'personal_sign'; readonly chainId: number; readonly message: DecodedMessage }
  | {
      readonly kind: 'eip712';
      readonly chainId: number;
      readonly typedData: NormalizedTypedData;
      readonly view: TypedDataView;
    }
  | { readonly kind: 'raw'; readonly chain: 'stellar' | 'evm'; readonly hex: string };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 bytes of typed-data JSON → its normalized form. Throws DecodeError. */
export function typedDataFromBytes(bytes: Uint8Array): NormalizedTypedData {
  let json: string;
  try {
    json = utf8Decoder.decode(bytes);
  } catch {
    fail('malformed', 'Typed data is not valid UTF-8');
  }
  return normalizeTypedData(json);
}

/**
 * Decodes a request for display (and for the auto-approve matcher). Throws DecodeError when the bytes are malformed
 * or name another network than `context` (an EVM transaction's or a typed-data domain's chain ID, an authorization's
 * network ID).
 */
export function decodeApprovalRequest(s: ApprovalSubject): DecodedApproval {
  try {
    validateApprovalSubject(s);
  } catch (e) {
    fail('malformed', (e as Error).message);
  }
  const ctx = s.context as { networkPassphrase?: string; chainId?: number };
  switch (s.kind) {
    case 'stellar_tx':
      return {
        kind: s.kind,
        networkPassphrase: ctx.networkPassphrase as string,
        envelope: decodeStellarTransaction(s.bytes),
      };
    case 'stellar_auth_entry':
      return {
        kind: s.kind,
        networkPassphrase: ctx.networkPassphrase as string,
        preimage: decodeStellarAuthPreimage(s.bytes, ctx.networkPassphrase as string),
      };
    case 'stellar_message':
      return { kind: s.kind, message: decodeMessage(s.bytes) };
    case 'evm_tx': {
      const tx = decodeEvmTransaction(s.bytes);
      if (tx.chainId !== BigInt(ctx.chainId as number)) fail('network_mismatch', 'Transaction is for another chain');
      return { kind: s.kind, chainId: ctx.chainId as number, tx };
    }
    case 'personal_sign':
      return { kind: s.kind, chainId: ctx.chainId as number, message: decodeMessage(s.bytes) };
    case 'eip712': {
      const typedData = typedDataFromBytes(s.bytes);
      const domainChain = typedDataChainId(typedData);
      if (domainChain !== null && domainChain !== ctx.chainId) {
        fail('network_mismatch', 'Typed data domain is for another chain');
      }
      return { kind: s.kind, chainId: ctx.chainId as number, typedData, view: typedDataView(typedData) };
    }
    case 'raw':
      return { kind: s.kind, chain: s.chain, hex: toHex0x(s.bytes) };
    default:
      throw new DecodeError('unsupported', 'Unknown approval kind');
  }
}
