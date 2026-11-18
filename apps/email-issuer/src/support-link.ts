// The support links (D866): the one-time tokens a staff `admin/unlock` or `admin/unsuppress` mails to the address
// itself, and that the support pages on the sign-in site (`{authOrigin}/email/unlock#…`, `/email/confirm#…`) post back
// after the user pressed their one button (`POST /v1/email/unlock`, `/v1/email/confirm`).
//
// A token is a prefix that names its action ("ug1." unlock, "uc1." confirm) and 32 random bytes (b64url, 43
// characters): unguessable, and useless for the other action (its own prefix, its own record, checked by name and by
// the record's `action`). It travels in the link's fragment, which browsers never send to a server. The issuer keeps:
// - a record in the `EmailChallenge` namespace named by the token's sha256 (`g:` unlock, `u:` confirm), holding the
//   action, the exact address's key (K_sup HMAC), for an unlock the mailbox's limiter key, the support reference staff
//   gave, the expiry, and the address itself AES-256-GCM-encrypted under a key derived from the token: the stored record
//   holds no readable address, and the worker reads it only during a request that carries the token (the page then
//   shows the address the mail went to, which the token's holder already knows);
// - for an unlock, the mailbox's grant (rate-limiter.ts `issueGrant`), named by the same sha256.
// Nothing here or in the record is ever logged; the token itself is never stored.
import { base64UrlEncode, concatBytes, fromUtf8, sha256, utf8, base64UrlDecode } from './bytes.ts';
import { randomId } from './keys.ts';

export type SupportAction = 'unlock' | 'unsuppress';

export const UNLOCK_TOKEN_RE = /^ug1\.[A-Za-z0-9_-]{43}$/u;
export const CONFIRM_TOKEN_RE = /^uc1\.[A-Za-z0-9_-]{43}$/u;
const PREFIX: Readonly<Record<SupportAction, string>> = Object.freeze({ unlock: 'ug1.', unsuppress: 'uc1.' });
const NAME: Readonly<Record<SupportAction, string>> = Object.freeze({ unlock: 'g:', unsuppress: 'u:' });
const EMAIL_DOMAIN = 'hana-id/support-link-email/v1';

/** A new token for `action`: its prefix and 32 random bytes. */
export const newSupportToken = (action: SupportAction): string => `${PREFIX[action]}${randomId(32)}`;

/** Whether `token` has `action`'s exact form. */
export const isSupportToken = (action: SupportAction, token: unknown): token is string => typeof token === 'string' && (action === 'unlock' ? UNLOCK_TOKEN_RE : CONFIRM_TOKEN_RE).test(token);

/** b64url(sha256(token)): the mailbox's grant name for an unlock, and the per-token limiter's subject. */
export const tokenHash = (token: string): string => base64UrlEncode(sha256(utf8(token)));

/** The record's object name: the action's prefix and the token's sha256 (as the confirm records were always named). */
export const supportLinkName = (action: SupportAction, token: string): string => `${NAME[action]}${tokenHash(token)}`;

const aesKey = (token: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', sha256(concatBytes(utf8(EMAIL_DOMAIN), Uint8Array.of(0), utf8(token))), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** b64url(iv ‖ AES-GCM(address)) under the token's key, the action as AAD. */
export async function sealLinkEmail(action: SupportAction, token: string, email: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(action) }, await aesKey(token), utf8(email)));
  return base64UrlEncode(concatBytes(iv, ct));
}

/** The address, or null when `enc` doesn't open under this token and action (another token, a tampered record). */
export async function openLinkEmail(action: SupportAction, token: string, enc: string): Promise<string | null> {
  try {
    const raw = base64UrlDecode(enc);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: utf8(action) }, await aesKey(token), raw.subarray(12));
    return fromUtf8(new Uint8Array(pt));
  } catch {
    return null;
  }
}
