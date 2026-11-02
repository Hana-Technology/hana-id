// The byte layouts behind every email token's nonce (docs/contract-interface.md "Identity key, link nonces and the
// linked CKD payload", "Session nonce", "Client proof"). The issuer computes each purpose's nonce itself from the
// commitment, with the pinned signer account, so an email token can only serve the purpose it was minted for (spec
// "Endpoints"). test/layouts.test.ts checks every layout byte for byte against the contract's worked examples
// (contracts/hana-signer/src/email_fixture.json and test_fixture.json).
import { type Bytes, base64UrlEncode, borshString, concatBytes, sessionNoncePreimage, sha256, u64le, utf8 } from './bytes.ts';

export const IDENTITY_DOMAIN = 'hana-id/identity/v1';
export const LINK_NEW_DOMAIN = 'hana-id/link-new/v1';
export const LINK_ACCOUNT_DOMAIN = 'hana-id/link-account/v1';
export const LINK_CHANGE_DOMAIN = 'hana-id/link-change/v1';
export const AUTO_LINK_DOMAIN = 'hana-id/auto-link/v1';
export const CLIENT_PROOF_DOMAIN = 'hana-id/client-proof/v1';

/** `join` of the auto_link nonce (D133): the session identity joins the link identity's account (case A). */
export const JOIN_SESSION_IDENTITY = 1;
/** The link identity joins the session identity's account (cases B, C). */
export const JOIN_LINK_IDENTITY = 2;

/** The email provider name: in every email path (`{scope}#email#{sub}#{key_index}`), frozen. */
export const EMAIL_PROVIDER = 'email';

export const nonceOf = (preimage: Uint8Array): string => base64UrlEncode(sha256(preimage));

const ik32 = (k: Uint8Array, what: string): Uint8Array => {
  if (k.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return k;
};
const salt = (s: Uint8Array): Uint8Array => {
  if (s.length < 16 || s.length > 64) throw new Error('Salt must be 16-64 bytes');
  return s;
};

/** ik = sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub)). */
export const identityKey = (scopeId: string, provider: string, sub: string): Bytes => sha256(concatBytes(utf8(IDENTITY_DOMAIN), borshString(scopeId), borshString(provider), borshString(sub)));

export interface SessionCommitment {
  scopeId: string;
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  keyIndex: number;
  maxUses: number;
  salt: Uint8Array;
}

export const sessionPreimage = (signer: string, c: SessionCommitment): Bytes => sessionNoncePreimage({ signer, ...c });
export const sessionNonceOf = (signer: string, c: SessionCommitment): string => nonceOf(sessionPreimage(signer, c));

export const linkNewPreimage = (signer: string, scopeId: string, rootIk: Uint8Array, newProvider: string, epoch: number, s: Uint8Array): Bytes =>
  concatBytes(utf8(LINK_NEW_DOMAIN), borshString(signer), borshString(scopeId), ik32(rootIk, 'root_ik'), borshString(newProvider), u64le(epoch), salt(s));

export const linkAccountPreimage = (signer: string, scopeId: string, rootIk: Uint8Array, newIk: Uint8Array, epoch: number, s: Uint8Array): Bytes =>
  concatBytes(utf8(LINK_ACCOUNT_DOMAIN), borshString(signer), borshString(scopeId), ik32(rootIk, 'root_ik'), ik32(newIk, 'new_ik'), u64le(epoch), salt(s));

export const linkChangePreimage = (signer: string, scopeId: string, action: 'cancel' | 'unlink', rootIk: Uint8Array, memberIk: Uint8Array, epoch: number, s: Uint8Array): Bytes =>
  concatBytes(utf8(LINK_CHANGE_DOMAIN), borshString(signer), borshString(scopeId), borshString(action), ik32(rootIk, 'root_ik'), ik32(memberIk, 'member_ik'), u64le(epoch), salt(s));

export interface AutoLinkJoin {
  /** JOIN_SESSION_IDENTITY (case A) or JOIN_LINK_IDENTITY (cases B, C). */
  join: 1 | 2;
  joinerIk: Uint8Array;
  targetRootIk: Uint8Array;
  /** The target account's epoch (0: no account yet). */
  targetEpoch: number;
  /** 1 = link_immediate, 0 = after change_delay_ms. */
  mode: 0 | 1;
}

/**
 * auto_link = "hana-id/auto-link/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik
 *             ‖ join u8 ‖ joiner_ik ‖ target_root_ik ‖ target epoch u64 LE ‖ mode u8
 */
export function autoLinkPreimage(signer: string, scopeId: string, sessionHash: Uint8Array, sessionIk: Uint8Array, j: AutoLinkJoin): Bytes {
  if (sessionHash.length !== 32) throw new Error('session hash must be 32 bytes');
  return concatBytes(
    utf8(AUTO_LINK_DOMAIN),
    borshString(signer),
    borshString(scopeId),
    sessionHash,
    ik32(sessionIk, 'session_ik'),
    Uint8Array.of(j.join),
    ik32(j.joinerIk, 'joiner_ik'),
    ik32(j.targetRootIk, 'target_root_ik'),
    u64le(j.targetEpoch),
    Uint8Array.of(j.mode),
  );
}

/** client_proof = "hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE. */
export const clientProofPreimage = (signer: string, scopeId: string, actionNonce: number): Bytes => concatBytes(utf8(CLIENT_PROOF_DOMAIN), borshString(signer), borshString(scopeId), u64le(actionNonce));
