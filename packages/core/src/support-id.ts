// The user's Support ID (batch C15; D96, D276 as amended by D346): `HANA-XXXX-XXXX`, the short form of the identity
// token's `sub` (the User ID) for the account root: the Crockford base32 (uppercase) of the first 5 of the 16 bytes the
// `sub` encodes. The API computes the `sub` (it needs IDENTITY_SUB_KEY's output) and sends the Support ID with the
// session in the `/v1/login` and `/v1/sessions` answers; the vault keeps it with the session, and partners read it in
// `hana_status`. The SDK only checks the shape of what the API sent. `supportIdFromSub` is the one implementation of
// the sub -> Support ID step (console-core re-exports it for the API, the console and the admin), also for partner
// backends that store the `sub` and show the Support ID beside it. It carries no address, and it is not a credential
// (staff change nothing on a code alone).

/** Crockford's base32 alphabet, uppercase: digits, then letters without I, L, O and U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SUPPORT_ID_PREFIX = 'HANA-';
/** The `sub`'s leading bytes the Support ID encodes: 40 bits, exactly 8 Crockford characters. */
export const SUPPORT_ID_BYTES = 5;
/**
 * An identity token's `sub` (the User ID): "u1_" and the canonical unpadded base64url of 16 bytes (22 characters; the
 * last one's 4 low bits are zero, so it is A, Q, g or w). Case-sensitive.
 */
export const IDENTITY_SUB_RE = /^u1_[A-Za-z0-9_-]{21}[AQgw]$/u;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Crockford base32 (uppercase), most significant bit first, the last group zero-padded; no `=` padding. */
export function crockford32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** The 16 bytes an identity `sub` encodes (its base64url decoded); a TypeError for anything that isn't one. */
export function decodeIdentitySub(sub: string): Uint8Array {
  if (typeof sub !== 'string' || !IDENTITY_SUB_RE.test(sub)) throw new TypeError('Not a Hana identity sub (u1_...)');
  const out = new Uint8Array(16);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const c of sub.slice(3)) {
    acc = ((acc << 6) | B64URL.indexOf(c)) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/** The 8-character Support code of a `sub` (no prefix or dash): Crockford base32 of its first 5 bytes. */
export const supportCodeFromSub = (sub: string): string => crockford32(decodeIdentitySub(sub).subarray(0, SUPPORT_ID_BYTES));

/** `HANA-XXXX-XXXX` from an 8-character Support code. */
export const formatSupportId = (code: string): string => `${SUPPORT_ID_PREFIX}${code.slice(0, 4)}-${code.slice(4, 8)}`;

/**
 * The Support ID (`HANA-XXXX-XXXX`) of an identity token's `sub` (`u1_...`), exactly as `hana.supportId` shows it: the
 * `sub`'s 22 characters base64url-decoded to 16 bytes, the first 5 of them (40 bits) in Crockford base32, most
 * significant bit first, uppercase, split 4 + 4. Throws a TypeError for anything that isn't a `sub`.
 */
export const supportIdFromSub = (sub: string): string => formatSupportId(supportCodeFromSub(sub));

/** `HANA-` + 4 + `-` + 4 characters of Crockford's alphabet (no I, L, O, U), uppercase: the API's exact output. */
export const SUPPORT_ID_RE = /^HANA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u;

export const isSupportId = (v: unknown): v is string => typeof v === 'string' && SUPPORT_ID_RE.test(v);

/**
 * The Support ID of an API answer (`body.supportId`), or null when it is absent or not one. A malformed value is
 * dropped, never a reason to refuse the answer: the session it came with is already on chain, and the code is only
 * shown to the user.
 */
export function supportIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = (body as { supportId?: unknown }).supportId;
  return isSupportId(v) ? v : null;
}

/**
 * The first SDK version whose protocol validators take `supportId` in `hana_status`, `hana_login` and the `ready`
 * event. The vault adds the field only for an SDK whose `hana:hello` names this version or a later one: an older SDK's
 * validators refuse any key they don't know (a reply it can't parse fails the call; a `ready` it can't parse never
 * arrives), so it must keep getting exactly the shapes it knows.
 */
export const SUPPORT_ID_SDK_MIN = '0.2.0';

/**
 * Whether the `sdk` version of a `hana:hello` (semver: `x.y.z`, optionally `-prerelease`) is at least `min`. A
 * prerelease counts as its release's predecessor (`0.2.0-rc.1` < `0.2.0`), as semver orders them; anything that isn't
 * a version is false (the safe answer: the old shapes).
 */
export function sdkAtLeast(sdk: string | null | undefined, min: string): boolean {
  const parse = (v: string): { n: [number, number, number]; pre: boolean } | null => {
    const m = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]+)?$/u.exec(v);
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined } : null;
  };
  if (typeof sdk !== 'string') return false;
  const a = parse(sdk);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i]! > b.n[i]!;
  return !a.pre || b.pre;
}
