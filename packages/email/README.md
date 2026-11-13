# @hana-id/email

The email login's identity rules, implemented once for the email issuer (`apps/email-issuer`), the API and the popup:
address normalization, the `e1.` `sub`, the Google-hosted rule and the disposable-domain block. Pure functions on Web
Crypto; no I/O and no Node API, so it runs in Cloudflare Workers and browsers. Source of truth:
`docs/email-login-spec.md` ("`sub`", "Email normalization", "Rate limits and abuse", "The four cases").

**Frozen at the address freeze.** The normalized address feeds `sub`, and `sub` is in every email user's CKD path
(`{scope}#email#{sub}#{key_index}`). Any change to normalization, the `sub` layout or the IDNA library version moves
every email address; `test/vectors.test.ts` fails on any such change (`vectors/email-v1.json`, the `EMAIL_V1`
constants, the pinned `tr46` and `punycode` versions). Before the freeze such a change must be called out; after it,
never (`docs/decisions.md` D156–D159).

## API

```ts
import { normalizeEmail, emailSub, importSubKey, isGoogleHosted, isDisposableDomain } from '@hana-id/email';

// start: the address the user typed
const r = normalizeEmail(' A.B+news@GoogleMail.com ');   // { ok: true, email: 'ab@gmail.com', local: 'ab', domain: 'gmail.com' }
if (!r.ok) return error(400, 'invalid_email');            // r.reason says why (tests and logs; never sent with the address)
if (isDisposableDomain(r.domain)) return error(400, 'email_domain_not_allowed');
await sendCode(r.email, code);                            // the NORMALIZED address, byte for byte (below)

const kSub = await importSubKey(rawKSub);                 // 32 bytes from the env's secret; non-extractable HMAC key
const sub = await emailSub(kSub, r.email);                // 'e1.' + 43 base64url characters

// google-match: the address from Google's userinfo, not anything the user typed
const g = normalizeEmail(userinfo.email);
if (g.ok) isGoogleHosted({ email: g.email, emailVerified: userinfo.email_verified, hd: userinfo.hd });
```

**Send the code to `r.email`, byte for byte, never to the raw input.** The normalized form is the address `sub`
stands for; the raw input can reach another mailbox. `x@faß.de` normalizes to `x@xn--fa-hia.de`, but a mailer that
applies transitional IDNA to the raw input would deliver to `x@fass.de`, a different domain with a different owner.

| Export | What |
|---|---|
| `normalizeEmail(input)` | `{ ok: true, email, local, domain }` or `{ ok: false, reason }` (`InvalidEmailReason`) |
| `normalizeDomain(input)` | The domain step alone (UTS #46, lowercase, one trailing dot, DNS checks) |
| `isNormalizedEmail(s)` | `s` is exactly `normalizeEmail`'s output |
| `emailSub(key, normalized)` | `"e1." ‖ b64url(HMAC-SHA256(K_sub, "hana-id/email-sub/v1" ‖ 0x00 ‖ utf8(normalized)))`; throws on an unnormalized address or a key that isn't a 32-byte HMAC-SHA256 key |
| `importSubKey(raw)` | Imports K_sub (32 bytes) as a non-extractable HMAC-SHA256 signing key |
| `subMessage(normalized)` | The exact bytes K_sub authenticates |
| `isEmailSub(s)` | Shape check of an `e1.` sub |
| `isGoogleHosted({ email, emailVerified, hd })` | The Google-hosted rule: needs a normalized address and `emailVerified === true`; `hd` absent → `gmail.com` only; `hd` present → exactly equal to the domain |
| `isDisposableDomain(domain)` | The normalized domain or any parent is on the pinned list |
| `disposableDomains()`, `DISPOSABLE_DOMAINS_SOURCE` | The list as a set, and its source metadata |
| `EMAIL_V1` | The frozen constants (prefix, label, limits, Gmail domains, IDNA library and options, Unicode cutoff) |

`K_sub` is always an input: this package never generates, stores or logs it (`scripts/email-issuer.ts init`, batch 4,
creates it in `.secrets/<env>/`).

## Normalization (spec steps, with the stricter readings of D156)

1. Trim ASCII whitespace (TAB, LF, FF, CR, SPACE) at both ends; at most 254 UTF-8 bytes; exactly one `@`; a local
   part of 1 to 64 bytes. The 254-byte limit is checked again on the normalized address (punycode can lengthen it).
2. Domain: UTS #46 ToASCII, non-transitional, with CheckHyphens, CheckBidi, CheckJoiners and UseSTD3ASCIIRules on;
   ASCII lowercase; strip one trailing dot; then a DNS host name: at least two labels, each 1 to 63 bytes of
   letters, digits and inner hyphens, at most 253 bytes, and a top-level label with a letter (no IP addresses).
   Any code point assigned after **Unicode 15.0** is refused, in the input, in its mapped form with `xn--` labels
   decoded, and in the result (`domain_unicode_version`; below).
3. Local part: ASCII only (no SMTPUTF8), an RFC 5322 dot-atom (no quoted strings, comments, leading, trailing or
   doubled dots), ASCII-lowercased.
4. Gmail canonical form for `gmail.com` and `googlemail.com` only (checked on the normalized domain, so `GMAIL.COM.`
   and fullwidth `ｇｍａｉｌ．ｃｏｍ` count): domain `gmail.com`; every `.` is dropped from the username (the part
   before the first `+`), and a non-empty `+tag` is kept as typed, so `name+1@gmail.com` is its own identity (its own
   wallet) and `name+@gmail.com` is `name@gmail.com` (D159). An empty username is refused. Google's help pages behind
   the dot rule are cited in `test/vectors.test.ts`.
   `normalizeEmail` also returns `mailbox`: the address without its `+tag` (every domain). It is a rate-limit key
   only: limits on codes sent key on it, or cycling tags would mail one inbox without bound. Never use it as an
   identity or a recipient.
5. No other provider rules: `+tag` and dots stay significant everywhere else.

## Dependency: `tr46` 7.0.0 (pinned exactly)

UTS #46 needs Unicode's IDNA mapping table. [`tr46`](https://github.com/jsdom/tr46) (MIT, the jsdom project's
implementation behind `whatwg-url`) is small (a 9 KB implementation plus 145 KB of mapping table and 73 KB of generated regexes), pure JavaScript, maintained, and
its only dependency is `punycode` 2.3.1 (pinned by the lockfile and checked by the guard test). 7.0.0 implements
UTS #46 revision 36 on **Unicode 18.0.0**. It exposes every UTS #46 option, which the platform does not.

The platform's `URL` / `domainToASCII` was rejected: it is UTS #46 non-transitional too (a test checks the two agree
on valid IDNs), but with the WHATWG URL flags (CheckHyphens and UseSTD3ASCIIRules off), and its Unicode version is
whatever the runtime ships (V8/ICU in workerd, each browser's own), so a Workers or browser upgrade could silently
move an address. A pinned library makes the mapping a reviewed dependency bump that the frozen vectors catch.

**The Unicode 15.0 cutoff.** One platform piece remains inside `tr46`: it calls the runtime's
`String.prototype.normalize('NFC')`. A runtime whose Unicode data predates a character treats it as unassigned
(combining class 0) and doesn't reorder it, so the same input gave a different address on Node 22.12 and Node 24
(`alice@x\u1AD0\u0316.com`, U+1AD0 being Unicode 17). So every code point assigned after Unicode 15.0 is refused,
from a vendored table (`src/unicode-age.ts`, generated by `scripts/update-unicode-age.mjs` from Unicode's
`DerivedAge-18.0.0.txt`, hash-pinned by the guard test), never from the engine's own Unicode data. 15.0 is the
newest version every target runtime knows: Safari 16.4 and later (16.4 shipped the Unicode 15.0 emoji),
Chrome, Edge and Firefox from the last two years (ICU 74+, Unicode 15.1), Node 22 (ICU 74+) and workerd. For
characters of 15.0 or older, Unicode's normalization stability policy makes NFC the same on all of them. The cost: a
domain using a script or ideograph added since September 2022 can't sign in (D156). The vectors are also run in
workerd (`test-workerd/`, `vitest.workerd.config.ts`).

Workers and browsers: `test/platform.test.ts` bundles the package with esbuild for the browser platform (no Node
built-in can resolve) and runs the frozen vectors in a bare V8 context with only Web Crypto, `TextEncoder` and
`btoa`. The bundle is about 435 KB unminified (about 120 KB minified and gzipped), most of it the IDNA tables and
the domain list, so a browser bundle should import it only where the popup needs it.

## Unicode data licence

`src/unicode-age.ts` is derived from Unicode's `DerivedAge-18.0.0.txt` (the Unicode Character Database), Copyright ©
Unicode, Inc., under the **Unicode License v3**. Its copyright and permission notice is in
[`LICENSE-Unicode.txt`](LICENSE-Unicode.txt), copied from <https://www.unicode.org/license.txt>; the licence allows
the notice to appear in associated documentation rather than with each copy. It is kept beside the table, not in the
table's header, because the freeze guard pins `src/unicode-age.ts` byte for byte (D791).

## Disposable-address domains

`src/disposable-domains.ts` vendors `disposable_email_blocklist.conf` from
[disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
(CC0 1.0) at commit `e4f0910adf5ab418dc998a1d8e6c15906ca04864` (2026-10-23): **9927 domains**, the upstream file byte
for byte (its sha256 is in the file header and checked by a test). A domain is blocked when it or any parent is listed
(upstream lists registrable domains; D157). The list is not address-defining.

Guard: no Google-hosted domain (`gmail.com`, `googlemail.com`, plus `google.com`) or any parent of one may be on it
(`test/disposable.test.ts`, and the update script refuses such a list).

To update (a reviewed PR; the script refuses an upstream commit less than 7 days old, and a list with a protected
domain from `scripts/protected-domains.mjs`, the module the guard test also imports):

```sh
node packages/email/scripts/update-disposable-domains.mjs <40-hex commit>
```

then update the commit and count in this README.

## Vectors

`vectors/email-v1.json` is written by `scripts/gen-vectors.mjs`, an independent implementation (Node's own UTS #46,
its own syntax rules, `node:crypto` HMAC) with a public TEST key; the only thing it shares with the package is the
data of `src/unicode-age.ts`, read as text. It refuses to overwrite a changed file unless `--force` is passed, which
is allowed only before the address freeze and must be called out. `pnpm test` runs the vectors in Node, in a bare V8
context (the browser bundle) and in workerd.

The Unicode table is regenerated only with a new `tr46` (both change addresses; a reviewed PR before the freeze):

```sh
curl -sSfLo DerivedAge.txt https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt
node packages/email/scripts/update-unicode-age.mjs DerivedAge.txt 18.0.0 15.0
```

```sh
corepack pnpm --filter @hana-id/email test
corepack pnpm --filter @hana-id/email gen-vectors   # verify only
```
