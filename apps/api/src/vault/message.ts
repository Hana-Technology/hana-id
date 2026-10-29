// Vault message layout (off-chain only, docs/batch-b-spec.md "Vault message layout"):
//   utf8("hana-id-vault-v1:") ‖ borsh(signer) ‖ borsh(appId) ‖ shareId (16) ‖ u64le(counter) ‖ sha256(payload)
// `appId` is the D1 apps.id of the gate app, so a signature made for one app never verifies for another. The prefix
// differs from "hana-id-session-v1:", so a vault signature can never be relayed as a derive or a revoke.
import { borshString, concatBytes, sha256, u64le } from '../bytes.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const VAULT_MESSAGE_PREFIX = 'hana-id-vault-v1:';
export const SHARE_ID_BYTES = 16;
/** The create-share message's share id (there is no share yet). */
export const NO_SHARE_ID = new Uint8Array(SHARE_ID_BYTES);

export type ShareAction = 'unlock' | 'touch' | 'revoke' | 'revoke-all';

/** create share: utf8("share") ‖ borsh(parentOrigin). */
export const createSharePayload = (parentOrigin: string): Uint8Array => concatBytes(utf8('share'), borshString(parentOrigin));
/** unlock, touch, revoke, revoke-all: the action's name. */
export const actionPayload = (action: ShareAction): Uint8Array => utf8(action);

export interface VaultMessageInput {
  signer: string;
  appId: string;
  shareId: Uint8Array;
  counter: number;
  payload: Uint8Array;
}

export async function vaultMessage(i: VaultMessageInput): Promise<Uint8Array> {
  if (i.shareId.length !== SHARE_ID_BYTES) throw new Error('shareId must be 16 bytes');
  return concatBytes(utf8(VAULT_MESSAGE_PREFIX), borshString(i.signer), borshString(i.appId), i.shareId, u64le(i.counter), await sha256(i.payload));
}

/** Ed25519 (WebCrypto) check of a session-key signature over vaultMessage(i). False for any malformed key or signature. */
export async function verifyVaultSignature(sessionPk: Uint8Array, signature: Uint8Array, i: VaultMessageInput): Promise<boolean> {
  if (sessionPk.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', sessionPk, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, await vaultMessage(i));
  } catch {
    return false;
  }
}
