// Login relay payload (docs/batch-b-spec.md "Login" steps 6 and 7): the callback page encrypts Google's answer under
// `relayKey` (AES-GCM-256, 12-byte random IV, AAD = relayAad(relayId)) and the vault (or the export window) decrypts
// it. The API stores only `{iv, ct}` and can neither read nor replace the token.
//
// SECURITY: the plaintext holds a Google ID token. Never log it; drop it once verified.
import { base64UrlDecode, base64UrlEncode, fromUtf8, toBytes, utf8 } from './bytes.ts';
import { relayAad } from './layouts.ts';
import { isTimings } from './timings.ts';

export const RELAY_IV_BYTES = 12;
export const RELAY_KEY_BYTES = 32;
/** The relay's body cap (12 KiB, enforced by the API too: apps/api login-relay.ts RELAY_MAX_BODY). */
export const RELAY_MAX_BODY_BYTES = 12_288;
/**
 * The largest plaintext a relay value may have: its ciphertext (plus the 16-byte tag), base64url in `{"iv","ct"}`, then
 * fits RELAY_MAX_BODY_BYTES with room to spare (33 + ⌈4·(9000 + 16)/3⌉ = 12 055 bytes). Every payload the format
 * allows fits: its largest token payload (an ID token of 4096 and an access token of 2048 characters beside it, case
 * B's proof and 8 timings) is about 6.6 KB (G-L7). encryptRelayValue refuses anything larger.
 */
export const RELAY_MAX_PLAINTEXT_BYTES = 9000;
const GOOGLE_ERROR = /^[a-z_]{1,64}$/u;

/**
 * What a login popup relays to the vault: a token (Google's, or an email token), Google's `error` code, or Google's
 * access token. `timings`: pk_test_ apps only, the login popup's stage durations (`authCheck`, `callback*`,
 * timings.ts), which the vault adds to the login's timings.
 *
 * Email login and linking (build plan batch 8b), only in a login whose auth-params carried a `followKey`:
 * - `accessToken`: Google's access token beside the ID token, for the vault's google-match only (one-request mode's
 *   form; no popup sends it since that mode's removal, D273);
 * - `access: 'follow'`: Google's access token is in follow-up slot 1 (second_request's silent request, or
 *   token_first's first request, D270; in a token_first record-only login, `emailRecord`, for google-record);
 * - `caseB`: this popup's email step found the address's Google wallet (`verify` → `linkTicket`, the address's
 *   `sub`), and the user chose "Link and continue" before going to Google (D139);
 * - `as`: what a token answering the vault's follow-up is (`link`: case A's `auto_link` token after the code step;
 *   `session`: an email login's token; `proof`: a link method's proof).
 * - `sealedEmail` (D438): beside an email login's token, the issuer's `verify` answer's sealed address (opaque to the
 *   popup's relay and the vault; only the API opens it).
 */
export type RelayPayload = RelayTokenPayload | (({ accessToken: string } | { error: string; claim?: string }) & { timings?: Record<string, number> });

/** A claim name the popup may name beside `{error: 'token_has_pii'}` (the first claim outside the allow-list, D273). */
export const RELAY_CLAIM_NAME = /^[A-Za-z0-9_.:-]{1,64}$/u;

/** A relayed token (RelayPayload's first form). */
export interface RelayTokenPayload {
  idToken: string;
  accessToken?: string;
  access?: 'follow';
  caseB?: CaseBProof;
  as?: 'link' | 'session' | 'proof';
  sealedEmail?: string;
  timings?: Record<string, number>;
}

/** Whether a relay payload is a token (rather than an access token or an error). */
export const isRelayToken = (p: RelayPayload): p is RelayTokenPayload => 'idToken' in p;

/** Case B (D139): proof that this popup ran the email step for the address whose `sub` is `emailSub`. */
export interface CaseBProof {
  linkTicket: string;
  emailSub: string;
}
/** At most this many popup timings ride along in the slot. */
export const RELAY_TIMINGS_MAX_KEYS = 8;
/** Google's access tokens are well under 2 KiB. */
export const ACCESS_TOKEN_MAX = 2048;

/** The relay slot value, base64url. */
export interface RelayCiphertext {
  iv: string;
  ct: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAccessToken = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ACCESS_TOKEN_MAX && /^[\x21-\x7e]+$/u.test(v);
const isCaseB = (v: unknown): v is CaseBProof =>
  isObj(v) &&
  Object.keys(v).length === 2 &&
  typeof v.linkTicket === 'string' &&
  /^[A-Za-z0-9_-]{22,64}$/u.test(v.linkTicket) &&
  typeof v.emailSub === 'string' &&
  /^e1\.[A-Za-z0-9_-]{43}$/u.test(v.emailSub);
const TOKEN_EXTRAS: readonly string[] = ['accessToken', 'access', 'caseB', 'as', 'sealedEmail'];
/** The issuer's sealed address (@hana-id/email sealed.ts): `se1.` and base64url, at most 1024 characters. */
export const isSealedEmailText = (v: unknown): v is string => typeof v === 'string' && v.length > 4 && v.length <= 1024 && /^se1\.[A-Za-z0-9_-]+$/u.test(v);

/**
 * True for `{idToken[, accessToken | access, caseB, as]}`, `{accessToken}` or `{error: ^[a-z_]{1,64}$}` (with
 * `claim` only beside `token_has_pii`: the popup refused an ID token before relaying it, D273), each with an optional
 * `timings` record.
 */
export function isRelayPayload(v: unknown): v is RelayPayload {
  if (!isObj(v)) return false;
  const keys = Object.keys(v).filter((k) => k !== 'timings');
  if ('timings' in v && !(isTimings(v.timings) && Object.keys(v.timings).length <= RELAY_TIMINGS_MAX_KEYS)) return false;
  if (keys.includes('idToken')) {
    if (!keys.every((k) => k === 'idToken' || TOKEN_EXTRAS.includes(k))) return false;
    if (typeof v.idToken !== 'string' || v.idToken.length === 0 || v.idToken.length > 4096) return false;
    if (v.accessToken !== undefined && (!isAccessToken(v.accessToken) || v.access !== undefined)) return false;
    if (v.access !== undefined && v.access !== 'follow') return false;
    if (v.caseB !== undefined && !isCaseB(v.caseB)) return false;
    if (v.sealedEmail !== undefined && !isSealedEmailText(v.sealedEmail)) return false;
    return v.as === undefined || v.as === 'link' || v.as === 'session' || v.as === 'proof';
  }
  if (keys.length === 2 && keys.includes('error') && keys.includes('claim')) {
    return v.error === 'token_has_pii' && typeof v.claim === 'string' && RELAY_CLAIM_NAME.test(v.claim);
  }
  if (keys.length !== 1) return false;
  if (keys[0] === 'accessToken') return isAccessToken(v.accessToken);
  if (keys[0] === 'error') return typeof v.error === 'string' && GOOGLE_ERROR.test(v.error);
  return false;
}

async function importKey(relayKey: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (relayKey.length !== RELAY_KEY_BYTES) throw new Error(`relayKey must be ${RELAY_KEY_BYTES} bytes`);
  // importKey keeps its own copy: the one made for it is zeroed straight after.
  const raw = toBytes(relayKey);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
  } finally {
    raw.fill(0);
  }
}

/** Encrypts the callback's payload for `relayId`. */
export function encryptRelayPayload(relayKey: Uint8Array, relayId: string, payload: RelayPayload): Promise<RelayCiphertext> {
  if (!isRelayPayload(payload)) throw new Error('Malformed relay payload');
  return encryptRelayValue(relayKey, relayId, payload);
}

/** Decrypts and validates a relay slot value. Throws (without detail) if it doesn't decrypt under `relayKey` for `relayId`. */
export function decryptRelayPayload(relayKey: Uint8Array, relayId: string, value: RelayCiphertext): Promise<RelayPayload> {
  return decryptRelayValue(relayKey, relayId, value, isRelayPayload);
}

// ---- the vault's follow-up notices to the login popup (build plan batch 8b) ----

/**
 * A sign-in the vault asks the popup for: Google with this nonce (and the account to pick, `loginHint`, a Google
 * `sub`), or an email code with this purpose and commitment (the issuer computes the nonce from it, D195).
 */
export type FollowProve =
  | { method: 'google'; nonce: string; loginHint: string | null }
  | { method: 'email'; purpose: 'session' | 'link_new' | 'link_account' | 'link_change'; commitment: Record<string, unknown> };

/** A link banner (spec "Notices"): a sign-in method of this wallet's account, and what this popup may do about it. */
export interface LinkBanner {
  provider: string;
  status: 'pending' | 'active';
  /** When the method was (or will be) able to open the wallet. */
  effectiveAtMs: number;
  /** Made by this login. */
  fresh: boolean;
  /** Cancel (pending) or remove (active) it with a fresh sign-in of this login's method, when this identity may. */
  action?: { kind: 'cancel' | 'unlink'; prove: FollowProve };
}

/**
 * What the vault tells the popup after Google's (or the email step's) answer, in the follow-up slots 2, 4, 6, …; the
 * popup answers a notice in slot `n` (a token or `{error}`) in slot `n + 1`.
 * - `link_code`: case A, not Google-hosted: "Link and continue" (google-match prepared a code to `to`, a…@domain,
 *   sent by `resend` after the click) or "Sign in with email" (D195).
 * - `use_email`: case A that can't link (the email's account already has a Google sign-in, or is full): only "Sign in
 *   with email" (never a second wallet, D122).
 * - `email_consent`: a Google identity without a wallet whose address google-match couldn't read, because the user
 *   declined Google's email permission (`declined`) or picked another Google account on Google's screen
 *   (`account_mismatch`): the popup explains why it is needed and offers "Sign in with email instead" (an email login,
 *   `as: 'session'`) or "Try Google again" (the access request again, `login_hint` the signed-in `sub`, whose answer,
 *   `{accessToken}` or `{error}`, is the reply), D264.
 * - `prove`: a link method's proof (`hana.linkAccount`'s two sign-ins).
 * - `done`: the vault's last word: close, or show these banners first.
 * - `stop`: the login ended with `code` (`link_pending`: this method's link activates at `effectiveAtMs`).
 */
export type FollowNotice =
  | { t: 'link_code'; challengeId: string; expiresAtMs: number; to: string }
  | { t: 'use_email'; reason: 'provider_taken' | 'account_full' | 'unavailable' }
  | { t: 'email_consent'; reason: 'declined' | 'account_mismatch'; loginHint: string }
  | { t: 'prove'; why: 'link_new' | 'link_account'; prove: FollowProve; provider: string }
  | { t: 'done'; banners: LinkBanner[] }
  | { t: 'stop'; code: string; effectiveAtMs?: number; banners?: LinkBanner[] };

const isMsValue = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isShortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const isProvider = (v: unknown): v is string => v === 'google' || v === 'email';

export function isFollowProve(v: unknown): v is FollowProve {
  if (!isObj(v)) return false;
  if (v.method === 'google') {
    return Object.keys(v).length === 3 && typeof v.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v.nonce) && (v.loginHint === null || isShortText(v.loginHint, 255));
  }
  if (v.method === 'email') {
    return (
      Object.keys(v).length === 3 &&
      (v.purpose === 'session' || v.purpose === 'link_new' || v.purpose === 'link_account' || v.purpose === 'link_change') &&
      isObj(v.commitment) &&
      JSON.stringify(v.commitment).length <= 2048
    );
  }
  return false;
}

const isBanner = (v: unknown): v is LinkBanner =>
  isObj(v) &&
  Object.keys(v).every((k) => ['provider', 'status', 'effectiveAtMs', 'fresh', 'action'].includes(k)) &&
  isProvider(v.provider) &&
  (v.status === 'pending' || v.status === 'active') &&
  isMsValue(v.effectiveAtMs) &&
  typeof v.fresh === 'boolean' &&
  (v.action === undefined || (isObj(v.action) && Object.keys(v.action).length === 2 && (v.action.kind === 'cancel' || v.action.kind === 'unlink') && isFollowProve(v.action.prove)));
const isBanners = (v: unknown): v is LinkBanner[] => Array.isArray(v) && v.length <= 4 && v.every(isBanner);

export function isFollowNotice(v: unknown): v is FollowNotice {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (v.t) {
    case 'link_code':
      return only('t', 'challengeId', 'expiresAtMs', 'to') && typeof v.challengeId === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(v.challengeId) && isMsValue(v.expiresAtMs) && isShortText(v.to, 260);
    case 'use_email':
      return only('t', 'reason') && (v.reason === 'provider_taken' || v.reason === 'account_full' || v.reason === 'unavailable');
    case 'email_consent':
      return only('t', 'reason', 'loginHint') && (v.reason === 'declined' || v.reason === 'account_mismatch') && typeof v.loginHint === 'string' && /^[0-9A-Za-z_-]{1,255}$/u.test(v.loginHint);
    case 'prove':
      return only('t', 'why', 'prove', 'provider') && (v.why === 'link_new' || v.why === 'link_account') && isFollowProve(v.prove) && isProvider(v.provider);
    case 'done':
      return only('t', 'banners') && isBanners(v.banners);
    case 'stop':
      return only('t', 'code', 'effectiveAtMs', 'banners') && typeof v.code === 'string' && /^[a-z_]{1,64}$/u.test(v.code) && (v.effectiveAtMs === undefined || isMsValue(v.effectiveAtMs)) && (v.banners === undefined || isBanners(v.banners));
    default:
      return false;
  }
}

/** Encrypts any JSON value for one relay slot (AES-GCM under relayKey, AAD relayAad(relayId)). */
export async function encryptRelayValue(relayKey: Uint8Array, relayId: string, payload: unknown): Promise<RelayCiphertext> {
  const plain = utf8(JSON.stringify(payload));
  try {
    if (plain.length > RELAY_MAX_PLAINTEXT_BYTES) throw new Error('The relay value is too large');
    const key = await importKey(relayKey, 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(RELAY_IV_BYTES));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: relayAad(relayId) }, key, plain));
    return { iv: base64UrlEncode(iv), ct: base64UrlEncode(ct) };
  } finally {
    plain.fill(0);
  }
}

/** Decrypts a relay slot value and checks it with `check`. Throws (without detail) when it doesn't decrypt or check. */
export async function decryptRelayValue<T>(relayKey: Uint8Array, relayId: string, value: RelayCiphertext, check: (v: unknown) => v is T): Promise<T> {
  const key = await importKey(relayKey, 'decrypt');
  let plain: Uint8Array;
  try {
    const iv = base64UrlDecode(value.iv);
    if (iv.length !== RELAY_IV_BYTES) throw new Error('bad iv');
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: relayAad(relayId) }, key, base64UrlDecode(value.ct)));
  } catch {
    throw new Error('The relay payload does not decrypt');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(plain));
  } catch {
    parsed = null;
  } finally {
    plain.fill(0);
  }
  if (!check(parsed)) throw new Error('Malformed relay payload');
  return parsed;
}
