// Email normalization v1 (docs/email-login-spec.md "Email normalization"). FROZEN at the address freeze: the
// normalized address feeds `sub`, so any change here moves every email user's address. The frozen vectors in
// vectors/email-v1.json and test/vectors.test.ts guard it; where the spec allowed two readings the stricter one is
// implemented and recorded (docs/decisions.md D156).
//
// Pure and platform-neutral: no Node API, no I/O. Runs in Workers and browsers.

import { toASCII, toUnicode } from 'tr46';
import { EMAIL_V1 } from './constants.ts';
import { hasLoneSurrogate, hasPostCutoffCodePoint } from './unicode.ts';

export type InvalidEmailReason =
  /** Not a string. */
  | 'not_string'
  /** Holds an unpaired UTF-16 surrogate (not a Unicode string). */
  | 'malformed'
  /** Over 254 UTF-8 bytes, trimmed or normalized. */
  | 'too_long'
  /** Not exactly one `@`. */
  | 'at_sign'
  /** Empty local part (also after the Gmail canonical form, e.g. `+tag@gmail.com`). */
  | 'local_empty'
  /** Local part over 64 bytes. */
  | 'local_too_long'
  /** A non-ASCII local part (no SMTPUTF8 in the MVP). */
  | 'local_not_ascii'
  /** Not an RFC 5322 dot-atom (quoted strings, spaces, leading, trailing or doubled dots, ...). */
  | 'local_syntax'
  /** UTS #46 ToASCII refused the domain (disallowed code points, bad punycode, hyphen, bidi or joiner rules). */
  | 'domain_idna'
  /** Not a valid DNS host name after ToASCII (empty or over-long labels, numeric TLD, over 253 bytes). */
  | 'domain_syntax'
  /** A single-label domain. */
  | 'domain_no_dot'
  /** A code point assigned after Unicode `EMAIL_V1.unicodeCutoff` (15.0), in the input or the decoded domain (D156). */
  | 'domain_unicode_version';

export type NormalizeResult =
  | {
      ok: true;
      email: string;
      local: string;
      domain: string;
      /**
       * The delivery mailbox, for rate limits only (never an identity, never a recipient): `email` without its
       * `+tag` on every domain (Gmail, Outlook, iCloud, Fastmail and others deliver tags to one inbox). Limits on
       * codes sent must key on this, or cycling tags would mail one inbox without bound (D159).
       */
      mailbox: string;
    }
  | { ok: false; reason: InvalidEmailReason };

export type NormalizeDomainResult = { ok: true; domain: string } | { ok: false; reason: InvalidEmailReason };

/** WHATWG "ASCII whitespace": TAB, LF, FF, CR, SPACE. Anything else stays and fails the syntax checks. */
const EDGE_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
const NON_ASCII = /[^\x00-\x7F]/;
/** RFC 5322 §3.2.3 dot-atom-text: 1*atext *("." 1*atext). */
const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;
/** An LDH label (RFC 1123), already lowercase: no leading or trailing hyphen, 1 to 63 bytes. */
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HAS_LETTER = /[a-z]/;

const encoder = new TextEncoder();
const utf8Length = (s: string): number => encoder.encode(s).length;
/** ASCII-only lowercase (never locale- or Unicode-dependent). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * Spec step 2 on its own: UTS #46 ToASCII (non-transitional), lowercase, strip one trailing dot, then a valid DNS
 * name with at least one dot. Used for the domain of an address and to check the disposable-domain list (Google's
 * `hd` is compared without being normalized, D158). Refuses any code point assigned after Unicode 15.0, in the input
 * or in the decoded result, so the runtime's Unicode data can't change the answer (D156).
 */
export function normalizeDomain(input: string): NormalizeDomainResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not_string' };
  if (hasLoneSurrogate(input)) return { ok: false, reason: 'malformed' };
  // Before tr46 validates: its NFC step uses the runtime's Unicode data, which may predate a newer character. First
  // the raw input, then its mapped form with `xn--` labels decoded (an ASCII `xn--` label can hide a newer character;
  // mapping and decoding are table-driven, and NFC is runtime-independent once every code point is in 15.0), then
  // the Unicode form of the result again. Each check gives the same answer on every runtime.
  if (hasPostCutoffCodePoint(input)) return { ok: false, reason: 'domain_unicode_version' };
  if (hasPostCutoffCodePoint(toUnicode(input).domain)) return { ok: false, reason: 'domain_unicode_version' };
  const ascii = toASCII(input, { ...EMAIL_V1.idna.options });
  if (ascii === null) return { ok: false, reason: 'domain_idna' };
  if (hasPostCutoffCodePoint(toUnicode(ascii).domain)) return { ok: false, reason: 'domain_unicode_version' };
  let domain = asciiLower(ascii);
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (domain.length === 0 || domain.length > EMAIL_V1.maxDomainBytes) return { ok: false, reason: 'domain_syntax' };
  const labels = domain.split('.');
  if (labels.length < 2) return { ok: false, reason: 'domain_no_dot' };
  for (const label of labels) {
    if (label.length > EMAIL_V1.maxLabelBytes || !LDH_LABEL.test(label)) return { ok: false, reason: 'domain_syntax' };
  }
  // An all-numeric top-level label is an IPv4 address in disguise, never a mail domain (D156).
  if (!HAS_LETTER.test(labels[labels.length - 1]!)) return { ok: false, reason: 'domain_syntax' };
  return { ok: true, domain };
}

/**
 * The normalized address that `sub` is computed from, or why the input is not an acceptable address
 * (`400 invalid_email` at the issuer). Steps as the spec numbers them:
 *
 * 1. Trim ASCII whitespace; at most 254 bytes, exactly one `@`, a local part of at most 64 bytes.
 * 2. Domain: {@link normalizeDomain}.
 * 3. Local part: ASCII dot-atom only, lowercased.
 * 4. Gmail canonical form for `gmail.com` / `googlemail.com`: domain `gmail.com`, drop from the first `+`, drop dots.
 * 5. Nothing else provider-specific.
 *
 * The result is idempotent: `normalizeEmail(r.email)` gives `r.email` again.
 *
 * **The issuer must send the code to `r.email`, byte for byte, never to the raw input.** The normalized form is the
 * address `sub` stands for; the raw input can reach another mailbox. Example: `x@faß.de` normalizes to
 * `x@xn--fa-hia.de`, but a mailer that applies transitional IDNA to the raw input would deliver to `x@fass.de`, a
 * different domain with a different owner.
 */
export function normalizeEmail(input: string): NormalizeResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not_string' };
  if (hasLoneSurrogate(input)) return { ok: false, reason: 'malformed' };
  const trimmed = input.replace(EDGE_WHITESPACE, '');
  if (utf8Length(trimmed) > EMAIL_V1.maxAddressBytes) return { ok: false, reason: 'too_long' };
  const parts = trimmed.split('@');
  if (parts.length !== 2) return { ok: false, reason: 'at_sign' };
  const [rawLocal, rawDomain] = parts as [string, string];
  if (rawLocal.length === 0) return { ok: false, reason: 'local_empty' };
  if (utf8Length(rawLocal) > EMAIL_V1.maxLocalBytes) return { ok: false, reason: 'local_too_long' };
  if (NON_ASCII.test(rawLocal)) return { ok: false, reason: 'local_not_ascii' };
  if (!DOT_ATOM.test(rawLocal)) return { ok: false, reason: 'local_syntax' };

  const d = normalizeDomain(rawDomain);
  if (!d.ok) return d;
  let domain = d.domain;
  let local = asciiLower(rawLocal);

  if ((EMAIL_V1.gmailDomains as readonly string[]).includes(domain)) {
    domain = EMAIL_V1.gmailCanonicalDomain;
    // Dots are dropped from the username only; a `+tag` is kept as typed (lowercased), so each tag is its own
    // identity, and an empty tag (`name+@gmail.com`) is the plain username (D159).
    const plus = local.indexOf('+');
    const tag = plus === -1 ? '' : local.slice(plus + 1);
    const user = (plus === -1 ? local : local.slice(0, plus)).replaceAll('.', '');
    if (user.length === 0) return { ok: false, reason: 'local_empty' };
    local = tag.length === 0 ? user : `${user}+${tag}`;
  }

  const email = `${local}@${domain}`;
  // Punycode can make the domain longer than the input's: the limit holds for the normalized address too (D156).
  if (email.length > EMAIL_V1.maxAddressBytes) return { ok: false, reason: 'too_long' };
  const plus = local.indexOf('+');
  const mailbox = plus > 0 ? `${local.slice(0, plus)}@${domain}` : email;
  return { ok: true, email, local, domain, mailbox };
}

/** True when `email` is exactly the output of {@link normalizeEmail} (what `sub` and the Google-hosted rule accept). */
export function isNormalizedEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  const r = normalizeEmail(email);
  return r.ok && r.email === email;
}
