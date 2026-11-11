// The approval popup's single entry point: decode a request's bytes itself (never trusting a summary from the vault)
// and check them against the request's network context. A request that doesn't decode is refused before display.
// `raw` is never decoded, even when its bytes happen to be a valid transaction or hash.
import { isNearImplicitAccountId, nearImplicitPublicKey } from '../addresses.ts';
import { type ApprovalSubject, type NearNetwork, validateApprovalSubject } from '../approval.ts';
import { bytesEqual } from '../bytes.ts';
import { type NearPublicKey, decodeNearDelegateAction, decodeNearTransaction, decodeNep413Message, nearRelaysDelegate, nearTransactionHashString } from '../near/codec.ts';
import { type DecodedNearDelegate, type DecodedNearMessage, type DecodedNearTx, nearMessageView } from './near.ts';
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
  | { readonly kind: 'personal_sign'; readonly message: DecodedMessage }
  | {
      readonly kind: 'eip712';
      /** The domain's chainId, or null when the domain declares none (the request itself names no network). */
      readonly chainId: number | null;
      readonly typedData: NormalizedTypedData;
      readonly view: TypedDataView;
    }
  | { readonly kind: 'raw'; readonly chain: 'stellar' | 'evm'; readonly hex: string }
  | ({ readonly kind: 'near_tx' } & DecodedNearTx)
  | ({ readonly kind: 'near_delegate' } & DecodedNearDelegate)
  | ({ readonly kind: 'near_message' } & DecodedNearMessage);

/** The NEAR request's account and key must be the vault's: its implicit account id and the key it is the hex of. */
function checkNearSigner(address: string, account: string, key: NearPublicKey, what: string): void {
  if (!isNearImplicitAccountId(address)) fail('malformed', 'The NEAR address is not an implicit account id');
  if (account !== address) fail('invalid_value', `The ${what} is not from this account`);
  if (key.type !== 'ed25519' || !bytesEqual(key.bytes, nearImplicitPublicKey(address))) fail('invalid_value', `The ${what} is not for this account's key`);
}

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
 * or name another network than `context` (an EVM transaction's chain ID, an authorization's network ID). Messages,
 * typed data and raw requests carry no context (approval.ts); typed data shows its domain's chain. A NEAR transaction
 * or delegate action must be signed by the subject's account with its key (`invalid_value` otherwise); NEAR bytes
 * name no network, so the context is the request's claim (the vault checks a test app's transaction's block hash).
 */
export function decodeApprovalRequest(s: ApprovalSubject): DecodedApproval {
  try {
    validateApprovalSubject(s);
  } catch (e) {
    fail('malformed', (e as Error).message);
  }
  const ctx = s.context as { networkPassphrase?: string; chainId?: number; nearNetwork?: NearNetwork };
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
      return { kind: s.kind, message: decodeMessage(s.bytes) };
    case 'eip712': {
      const typedData = typedDataFromBytes(s.bytes);
      return { kind: s.kind, chainId: typedDataChainId(typedData), typedData, view: typedDataView(typedData) };
    }
    case 'raw':
      if (s.chain === 'near') fail('malformed', 'A raw request is on Stellar or EVM');
      return { kind: s.kind, chain: s.chain, hex: toHex0x(s.bytes) };
    case 'near_tx': {
      const tx = decodeNearTransaction(s.bytes);
      checkNearSigner(s.address, tx.signerId, tx.publicKey, 'transaction');
      // Its signer would prepay every deposit of the delegate it relays: never shown, never signed.
      if (nearRelaysDelegate(tx)) fail('unsupported', 'Hana doesn’t sign a NEAR transaction that relays a delegate action: its signer pays the delegate’s deposits');
      return { kind: s.kind, network: ctx.nearNetwork as NearNetwork, tx, hash: nearTransactionHashString(s.bytes) };
    }
    case 'near_delegate': {
      const delegate = decodeNearDelegateAction(s.bytes);
      checkNearSigner(s.address, delegate.senderId, delegate.publicKey, 'delegate action');
      return { kind: s.kind, network: ctx.nearNetwork as NearNetwork, delegate };
    }
    case 'near_message':
      return { kind: s.kind, ...nearMessageView(decodeNep413Message(s.bytes)) };
    default:
      throw new DecodeError('unsupported', 'Unknown approval kind');
  }
}
