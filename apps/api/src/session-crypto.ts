// Byte layouts the contract checks, reproduced so the API can reject bad requests before relaying (each relayed tx
// costs gas even when the contract rejects it). Layouts: docs/batch-a2-shared-client.md ("Byte layouts") and
// docs/contract-interface.md. The contract re-checks everything.
import { base64UrlEncode, borshString, concatBytes, sha256, u32le, u64le } from './bytes.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const SESSION_NONCE_DOMAIN = 'hana-id/session/v1';
export const SESSION_MESSAGE_DOMAIN = 'hana-id-session-v1:';
export const CKD_PAYLOAD_PREFIX = 'hana-id-ckd-v1:';
export const REVOKE_PAYLOAD = 'revoke';

export interface SessionNonceInput {
  /** hana-signer account (`env::current_account_id()`), i.e. SIGNER_ACCOUNT. */
  signer: string;
  /** The app's scope id (from D1, never from the client). */
  scopeId: string;
  sessionPublicKey: Uint8Array | number[];
  expiresAtMs: number;
  keyIndex: number;
  maxUses: number;
  salt: Uint8Array | number[];
}

/**
 * The `nonce` an ID token must carry to open a session:
 * b64url(sha256("hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ session_public_key (32) ‖ expires_at_ms u64 LE
 * ‖ key_index u32 LE ‖ max_uses u32 LE ‖ salt)).
 */
export async function sessionNonce(i: SessionNonceInput): Promise<string> {
  return base64UrlEncode(await sha256(sessionNoncePreimage(i)));
}

/** The session nonce's preimage (its sha256 is in the create proof and the auto_link nonce). */
export function sessionNoncePreimage(i: SessionNonceInput): Uint8Array {
  return concatBytes(
    utf8(SESSION_NONCE_DOMAIN),
    borshString(i.signer),
    borshString(i.scopeId),
    Uint8Array.from(i.sessionPublicKey),
    u64le(i.expiresAtMs),
    u32le(i.keyIndex),
    u32le(i.maxUses),
    Uint8Array.from(i.salt),
  );
}

export const CREATE_PROOF_PREFIX = 'hana-id-create-v1:';

/**
 * create_session's proof-of-possession payload (D137), signed with counter 0: "hana-id-create-v1:" ‖ sha256(session
 * nonce preimage). Contract v3 requires the signature; v2 ignores the extra argument.
 */
export async function createProofPayload(i: SessionNonceInput): Promise<Uint8Array> {
  return concatBytes(utf8(CREATE_PROOF_PREFIX), await sha256(sessionNoncePreimage(i)));
}

export const CKD_LINK_PREFIX = 'hana-id-ckd-link-v1:';

/**
 * The counter-1 payload of a combined login that carries a link (D133): "hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖
 * mode u8 (1 = link_immediate) ‖ pk1 ‖ ":" ‖ pk2.
 */
export async function linkedCkdPayload(pk1: string, pk2: string, linkJwt: string, immediate: boolean): Promise<Uint8Array> {
  return concatBytes(utf8(CKD_LINK_PREFIX), await sha256(utf8(linkJwt)), Uint8Array.of(immediate ? 1 : 0), utf8(`${pk1}:${pk2}`));
}

// ---- Identity keys and link nonces (docs/contract-interface.md "Identity key, link nonces and the linked CKD payload") ----

export const IDENTITY_DOMAIN = 'hana-id/identity/v1';
export const LINK_NEW_DOMAIN = 'hana-id/link-new/v1';
export const LINK_ACCOUNT_DOMAIN = 'hana-id/link-account/v1';
export const LINK_CHANGE_DOMAIN = 'hana-id/link-change/v1';
export const AUTO_LINK_DOMAIN = 'hana-id/auto-link/v1';
/** `join` of the auto_link nonce: the session identity joins the link identity's account (case A). */
export const JOIN_SESSION_IDENTITY = 1;
/** The link identity joins the session identity's account (cases B, C). */
export const JOIN_LINK_IDENTITY = 2;

/** ik = sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub)). */
export async function identityKey(scopeId: string, provider: string, sub: string): Promise<Uint8Array> {
  return sha256(concatBytes(utf8(IDENTITY_DOMAIN), borshString(scopeId), borshString(provider), borshString(sub)));
}

const nonceOf = async (preimage: Uint8Array): Promise<string> => base64UrlEncode(await sha256(preimage));
const ik32 = (k: Uint8Array): Uint8Array => {
  if (k.length !== 32) throw new Error('An identity key is 32 bytes');
  return k;
};

/** link_new = "hana-id/link-new/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ borsh(new provider) ‖ epoch u64 LE ‖ salt */
export const linkNewNonce = (signer: string, scopeId: string, rootIk: Uint8Array, newProvider: string, epoch: number, salt: Uint8Array): Promise<string> =>
  nonceOf(concatBytes(utf8(LINK_NEW_DOMAIN), borshString(signer), borshString(scopeId), ik32(rootIk), borshString(newProvider), u64le(epoch), salt));

/** link_account = "hana-id/link-account/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ new_ik ‖ epoch u64 LE ‖ salt */
export const linkAccountNonce = (signer: string, scopeId: string, rootIk: Uint8Array, newIk: Uint8Array, epoch: number, salt: Uint8Array): Promise<string> =>
  nonceOf(concatBytes(utf8(LINK_ACCOUNT_DOMAIN), borshString(signer), borshString(scopeId), ik32(rootIk), ik32(newIk), u64le(epoch), salt));

/** link_change = "hana-id/link-change/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(action) ‖ root_ik ‖ member_ik ‖ epoch u64 LE ‖ salt */
export const linkChangeNonce = (signer: string, scopeId: string, action: 'cancel' | 'unlink', rootIk: Uint8Array, memberIk: Uint8Array, epoch: number, salt: Uint8Array): Promise<string> =>
  nonceOf(concatBytes(utf8(LINK_CHANGE_DOMAIN), borshString(signer), borshString(scopeId), borshString(action), ik32(rootIk), ik32(memberIk), u64le(epoch), salt));

export interface AutoLinkInput {
  signer: string;
  scopeId: string;
  /** sha256 of this login's session nonce preimage. */
  sessionHash: Uint8Array;
  sessionIk: Uint8Array;
  join: 1 | 2;
  joinerIk: Uint8Array;
  targetRootIk: Uint8Array;
  /** The target account's epoch (0: no account yet). */
  targetEpoch: number;
  immediate: boolean;
}

/**
 * auto_link = "hana-id/auto-link/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik
 *             ‖ join u8 ‖ joiner_ik ‖ target_root_ik ‖ target epoch u64 LE ‖ mode u8
 */
export function autoLinkNonce(i: AutoLinkInput): Promise<string> {
  if (i.sessionHash.length !== 32) throw new Error('The session hash is 32 bytes');
  return nonceOf(
    concatBytes(
      utf8(AUTO_LINK_DOMAIN),
      borshString(i.signer),
      borshString(i.scopeId),
      i.sessionHash,
      ik32(i.sessionIk),
      Uint8Array.of(i.join),
      ik32(i.joinerIk),
      ik32(i.targetRootIk),
      u64le(i.targetEpoch),
      Uint8Array.of(i.immediate ? 1 : 0),
    ),
  );
}

/** What a session key signs: "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload). */
export async function sessionMessage(counter: number, payload: Uint8Array): Promise<Uint8Array> {
  return concatBytes(utf8(SESSION_MESSAGE_DOMAIN), u64le(counter), await sha256(payload));
}

/** derive_key payload: "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2. */
export const ckdPayload = (pk1: string, pk2: string): Uint8Array => utf8(`${CKD_PAYLOAD_PREFIX}${pk1}:${pk2}`);
export const revokePayload = (): Uint8Array => utf8(REVOKE_PAYLOAD);

/**
 * Ed25519 (WebCrypto) check of a session-key signature over sessionMessage(counter, payload). False for any malformed
 * key or signature. Counter freshness is checked against the session (session-use.ts) and, finally, by the contract.
 */
export async function verifySessionSignature(sessionPublicKey: number[], counter: number, signature: number[], payload: Uint8Array): Promise<boolean> {
  if (sessionPublicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(sessionPublicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(signature), await sessionMessage(counter, payload));
  } catch {
    return false;
  }
}
