// `purpose` and `commitment` of `start` (spec "Endpoints"): the commitment carries every input of that purpose's
// nonce, never the nonce itself, and the issuer computes the nonce with the pinned signer. Byte arrays are JSON arrays
// of numbers (as the API's bodies and the contract's arguments); identity keys are 64 lowercase hex characters (as the
// contract's views and arguments).
import { KEY_INDEX_LIMIT, MAX_USES_LIMIT, fromHex } from './bytes.ts';
import { isObj, onlyKeys } from './http.ts';
import { EMAIL_PROVIDER, type SessionCommitment, linkAccountPreimage, linkChangePreimage, linkNewPreimage, nonceOf, sessionNonceOf } from './layouts.ts';

/** Every purpose an email token can serve. `auto_link` challenges are created by google-match only (D195). */
export const PURPOSES = ['session', 'link_new', 'link_account', 'link_change', 'auto_link'] as const;
export type Purpose = (typeof PURPOSES)[number];
/** The purposes `start` accepts. */
export const START_PURPOSES: readonly Purpose[] = ['session', 'link_new', 'link_account', 'link_change'];

const MAX_SESSION_MS = 24 * 60 * 60_000;
const SKEW_MS = 5 * 60_000;

const isBytes = (v: unknown, min: number, max: number): v is number[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const isU64 = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isIk = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
export const isScopeId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,64}$/u.test(v);

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** The session nonce fields (`session` purpose, and google-match's commitment). */
export function parseSessionCommitment(v: unknown, now: number): Checked<SessionCommitment> {
  if (!isObj(v) || !onlyKeys(v, ['scopeId', 'sessionPublicKey', 'expiresAtMs', 'keyIndex', 'maxUses', 'salt'])) return bad('commitment must be {scopeId, sessionPublicKey, expiresAtMs, keyIndex, maxUses, salt}');
  const { scopeId, sessionPublicKey, expiresAtMs, keyIndex, maxUses, salt } = v;
  if (!isScopeId(scopeId)) return bad('commitment.scopeId is malformed');
  if (!isBytes(sessionPublicKey, 32, 32)) return bad('commitment.sessionPublicKey must be 32 bytes');
  if (!isBytes(salt, 16, 64)) return bad('commitment.salt must be 16 to 64 bytes');
  if (!isU64(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + MAX_SESSION_MS + SKEW_MS) return bad('commitment.expiresAtMs must be in the next 24 hours');
  if (!Number.isInteger(keyIndex) || (keyIndex as number) < 0 || (keyIndex as number) > KEY_INDEX_LIMIT) return bad('commitment.keyIndex must be 0 to 2^31 - 1');
  if (!Number.isInteger(maxUses) || (maxUses as number) < 1 || (maxUses as number) > MAX_USES_LIMIT) return bad(`commitment.maxUses must be 1 to ${MAX_USES_LIMIT}`);
  return { ok: true, value: { scopeId, sessionPublicKey: Uint8Array.from(sessionPublicKey), expiresAtMs, keyIndex: keyIndex as number, maxUses: maxUses as number, salt: Uint8Array.from(salt) } };
}

export interface ParsedCommitment {
  purpose: Purpose;
  scopeId: string;
  /** The token's nonce, computed here (null for auto_link: it depends on the chain state at minting). */
  nonce: string;
}

/**
 * Checks `commitment` for a `start` purpose and computes that purpose's nonce. The email token is always the
 * email identity's: for `link_new` it is the new identity N (provider `email`), for `link_account` the account's active
 * identity A, for `link_change` the identity that cancels or unlinks.
 */
export function commitmentNonce(signer: string, purpose: unknown, commitment: unknown, now: number): Checked<ParsedCommitment> {
  if (typeof purpose !== 'string' || !(START_PURPOSES as readonly string[]).includes(purpose)) return bad(`purpose must be one of ${START_PURPOSES.join(', ')}`);
  const p = purpose as Purpose;
  if (p === 'session') {
    const c = parseSessionCommitment(commitment, now);
    if (!c.ok) return c;
    return { ok: true, value: { purpose: p, scopeId: c.value.scopeId, nonce: sessionNonceOf(signer, c.value) } };
  }
  if (!isObj(commitment)) return bad('commitment must be an object');
  const c = commitment;
  if (p === 'link_new') {
    if (!onlyKeys(c, ['scopeId', 'rootIk', 'epoch', 'salt'])) return bad('commitment must be {scopeId, rootIk, epoch, salt}');
    if (!isScopeId(c.scopeId) || !isIk(c.rootIk) || !isU64(c.epoch) || !isBytes(c.salt, 16, 64)) return bad('Malformed link_new commitment');
    return { ok: true, value: { purpose: p, scopeId: c.scopeId, nonce: nonceOf(linkNewPreimage(signer, c.scopeId, fromHex(c.rootIk), EMAIL_PROVIDER, c.epoch, Uint8Array.from(c.salt))) } };
  }
  if (p === 'link_account') {
    if (!onlyKeys(c, ['scopeId', 'rootIk', 'newIk', 'epoch', 'salt'])) return bad('commitment must be {scopeId, rootIk, newIk, epoch, salt}');
    if (!isScopeId(c.scopeId) || !isIk(c.rootIk) || !isIk(c.newIk) || !isU64(c.epoch) || !isBytes(c.salt, 16, 64)) return bad('Malformed link_account commitment');
    return { ok: true, value: { purpose: p, scopeId: c.scopeId, nonce: nonceOf(linkAccountPreimage(signer, c.scopeId, fromHex(c.rootIk), fromHex(c.newIk), c.epoch, Uint8Array.from(c.salt))) } };
  }
  // link_change
  if (!onlyKeys(c, ['scopeId', 'action', 'rootIk', 'memberIk', 'epoch', 'salt'])) return bad('commitment must be {scopeId, action, rootIk, memberIk, epoch, salt}');
  if (!isScopeId(c.scopeId) || (c.action !== 'cancel' && c.action !== 'unlink') || !isIk(c.rootIk) || !isIk(c.memberIk) || !isU64(c.epoch) || !isBytes(c.salt, 16, 64)) {
    return bad('Malformed link_change commitment');
  }
  return {
    ok: true,
    value: { purpose: p, scopeId: c.scopeId, nonce: nonceOf(linkChangePreimage(signer, c.scopeId, c.action, fromHex(c.rootIk), fromHex(c.memberIk), c.epoch, Uint8Array.from(c.salt))) },
  };
}
