#!/usr/bin/env node
// Writes vectors/email-v1.json: the FROZEN golden vectors of email normalization v1 and the e1. `sub`
// (docs/email-login-spec.md "Email normalization", "`sub`: HMAC of the normalized email"). It is an independent
// implementation: Node's own UTS #46 (`url.domainToASCII`, the WHATWG URL host parser: non-transitional, Ada in
// Node) plus this file's own LDH, length and Gmail rules, and node:crypto HMAC. The package code (tr46, Web Crypto)
// must reproduce every vector: test/vectors.test.ts. The one shared input is data, not code: the list of code
// points assigned after Unicode 15.0 (src/unicode-age.ts, generated from Unicode's DerivedAge.txt), read as text and
// checked here with this file's own logic.
//
// Run once to create the file; afterwards it only re-checks: it refuses to overwrite a file whose content would
// change (an address-changing edit) unless --force is passed, which must never happen after the address freeze.
//
//   node packages/email/scripts/gen-vectors.mjs           # write if absent, else verify
//   node packages/email/scripts/gen-vectors.mjs --force   # rewrite (before the address freeze only)
//
// The `sub` vectors use a TEST key, sha256 of a public preimage; it is never K_sub of any environment.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { domainToASCII, domainToUnicode } from 'node:url';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PKG, 'vectors', 'email-v1.json');

// Code points assigned after Unicode 15.0 (D156), from the vendored table's text.
const AGE_TEXT = /ASSIGNED_AFTER_CUTOFF = `([^`]*)`/.exec(readFileSync(join(PKG, 'src', 'unicode-age.ts'), 'utf8'))[1];
const NEW_RANGES = AGE_TEXT.trim().split(/\s+/).map((r) => {
  const [lo, hi = lo] = r.split('..');
  return [parseInt(lo, 16), parseInt(hi, 16)];
});
const isNew = (cp) => NEW_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
const anyNew = (s) => [...s].some((c) => isNew(c.codePointAt(0)));

const SUB_PREFIX = 'e1.';
const SUB_LABEL = 'hana-id/email-sub/v1';
const TEST_KEY_PREIMAGE = 'hana-id/email-sub/v1 TEST key (never an environment K_sub)';
const TEST_KEY = createHash('sha256').update(TEST_KEY_PREIMAGE, 'utf8').digest();

// ---- independent normalization ----------------------------------------------------------------------------------

const ATEXT = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-/=?^_`{|}~");
function isDotAtom(s) {
  if (s.length === 0) return false;
  return s.split('.').every((atom) => atom.length > 0 && [...atom].every((c) => ATEXT.has(c)));
}
function isLdh(label) {
  if (label.length < 1 || label.length > 63) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;
  return [...label].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-');
}
function hyphensOk(asciiLabel) {
  // UTS #46 CheckHyphens on the Unicode form of the label: no "--" in positions 3 and 4, no edge hyphen.
  const u = asciiLabel.startsWith('xn--') ? domainToUnicode(asciiLabel) : asciiLabel;
  if (u === '') return false;
  const cps = [...u];
  if (cps[2] === '-' && cps[3] === '-') return false;
  return !(u.startsWith('-') || u.endsWith('-'));
}

function domainOf(input) {
  if (!input.isWellFormed()) return null;
  if (anyNew(input)) return null;
  const ascii = domainToASCII(input);
  if (ascii === '') return null;
  if (ascii.split('.').some((l) => anyNew(l.startsWith('xn--') ? domainToUnicode(l) : l))) return null;
  let d = ascii.toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);
  if (d.length === 0 || d.length > 253) return null;
  const labels = d.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => isLdh(l) && hyphensOk(l))) return null;
  if (!/[a-z]/.test(labels.at(-1))) return null;
  return d;
}

function normalize(input) {
  const s = input.replace(/^[\t\n\f\r ]+/, '').replace(/[\t\n\f\r ]+$/, '');
  if (/[\uD800-\uDFFF]/.test(s) && !s.isWellFormed()) return null;
  if (Buffer.byteLength(s, 'utf8') > 254) return null;
  const at = s.split('@');
  if (at.length !== 2) return null;
  let [local, domainIn] = at;
  if (Buffer.byteLength(local, 'utf8') > 64) return null;
  if (/[^\x00-\x7f]/.test(local) || !isDotAtom(local)) return null;
  let domain = domainOf(domainIn);
  if (domain === null) return null;
  local = local.toLowerCase();
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    domain = 'gmail.com';
    const [user, ...rest] = local.split('+');
    const tag = rest.join('+');
    const base = user.split('.').join('');
    if (base === '') return null;
    local = tag === '' ? base : base + '+' + tag;
  }
  const out = `${local}@${domain}`;
  return out.length > 254 ? null : out;
}

function sub(normalized) {
  const msg = Buffer.concat([Buffer.from(SUB_LABEL, 'utf8'), Buffer.from([0]), Buffer.from(normalized, 'utf8')]);
  return SUB_PREFIX + createHmac('sha256', TEST_KEY).update(msg).digest('base64url');
}

// ---- inputs -----------------------------------------------------------------------------------------------------

const a = (n, c = 'a') => c.repeat(n);
// A domain whose ASCII form is exactly 253 bytes, starting with an IDN label (例え → xn--r8jz45g, 6 → 11 bytes).
const idn253 = `例え.${a(63, 'b')}.${a(63, 'c')}.${a(63, 'd')}.${a(45, 'e')}.com`;
// 64-byte local + '@' + 189-byte domain = 254 bytes.
const domain189 = `${a(63, 'b')}.${a(63, 'c')}.${a(57, 'd')}.com`;

const ACCEPT = [
  ['plain', 'alice@example.com'],
  ['uppercase local and domain', 'Alice@Example.COM'],
  ['surrounding ASCII whitespace (space, tab, LF, CR, FF)', ' \t\r\n\falice@example.com \t\r\n\f'],
  ['one trailing dot on the domain', 'alice@example.com.'],
  ['ideographic full stop as the trailing dot', 'alice@example.com。'],
  ['+tag kept outside Gmail', 'alice+news@example.com'],
  ['dots kept outside Gmail', 'a.l.i.c.e@example.com'],
  ['every atext character', "!#$%&'*+-/=?^_`{|}~@example.com"],
  ['digits, underscore, hyphen, multi-label domain', 'first_last-1@sub.example.co.uk'],
  ['apostrophe', "O'Brien@Example.ie"],
  ['Gmail: dots dropped from the username, +tag kept, lowercased', 'A.B.C+Tag@Gmail.com'],
  ['Gmail: a +tag is its own identity', 'alice+1@gmail.com'],
  ['Gmail: dots inside the +tag are kept', 'a.b+x.y@gmail.com'],
  ['Gmail: an empty +tag is the plain username', 'abc+@gmail.com'],
  ['Gmail canonical form itself', 'abc@gmail.com'],
  ['googlemail.com becomes gmail.com', 'a.b.c@googlemail.com'],
  ['googlemail.com, uppercase, two +, trailing dot', 'ABC+x+y@GOOGLEMAIL.COM.'],
  ['Gmail: a dot right before +', 'a.+b@gmail.com'],
  ['Gmail: whitespace around', '  A.B.C@gmail.com\n'],
  ['fullwidth gmail.com maps to gmail.com (UTS #46)', 'x@ｇｍａｉｌ．ｃｏｍ'],
  ['a gmail.com subdomain is not Gmail', 'a.b+c@mail.gmail.com'],
  ['gmail.co.uk is not Gmail', 'a.b+c@gmail.co.uk'],
  ['IDN: ü', 'x@Bücher.example'],
  ['IDN: already punycode', 'x@xn--bcher-kva.example'],
  ['IDN: uppercase punycode', 'x@XN--BCHER-KVA.EXAMPLE'],
  ['IDN: ß non-transitional (not fass.de)', 'x@faß.de'],
  ['ASCII fass.de stays distinct from faß.de', 'x@FASS.de'],
  ['IDN: final sigma non-transitional', 'x@ς.gr'],
  ['IDN: capital sigma maps to σ', 'x@ΣΟΦΟΣ.gr'],
  ['IDN: Japanese labels', 'x@例え.テスト'],
  ['IDN: right-to-left labels', 'x@مثال.إختبار'],
  ['IDN: soft hyphen is ignored', 'x@exa­mple.com'],
  ['IDN: circled letter maps to ASCII', 'x@ⓔxample.com'],
  ['IDN: emoji label (UTS #46 allows it)', 'x@\u{1F4A9}.la'],
  ['IDN: emoji label as punycode', 'x@xn--ls8h.la'],
  ['IDN: ZWNJ in a valid ContextJ (Persian)', 'x@نامه‌ای.ir'],
  ['IDN: ignored zero width space', 'x@exa​mple.com'],
  ['IDN: ignored variation selector 16', 'x@exa️mple.com'],
  ['IDN: ignored combining grapheme joiner', 'x@exa͏mple.com'],
  ['IDN: halfwidth ideographic full stop as an inner dot', 'x@example｡com'],
  ['IDN: ideographic full stop as an inner dot', 'x@example。com'],
  ['IDN: capital I with dot above maps to i + U+0307', 'x@İstanbul.example'],
  ['IDN: a Unicode 15.0 character (the cutoff itself)', 'x@\u{31350}.example'],
  ['local part of exactly 64 bytes', `${a(64)}@example.com`],
  ['address of exactly 254 bytes', `${a(64)}@${domain189}`],
  ['label of exactly 63 bytes, domain of 252 bytes', `a@${a(63)}.${a(63, 'b')}.${a(63, 'c')}.${a(56, 'd')}.com`],
];

const REJECT = [
  ['empty', ''],
  ['whitespace only', ' \t\n'],
  ['no @', 'alice.example.com'],
  ['two @', 'alice@@example.com'],
  ['@ in the local part', 'a@b@example.com'],
  ['empty local part', '@example.com'],
  ['empty domain', 'alice@'],
  ['single-label domain', 'alice@localhost'],
  ['single-label domain with a trailing dot', 'alice@localhost.'],
  ['two trailing dots', 'alice@example.com..'],
  ['empty label', 'alice@example..com'],
  ['leading dot in the domain', 'alice@.example.com'],
  ['leading hyphen in a label', 'alice@-example.com'],
  ['trailing hyphen in a label', 'alice@example-.com'],
  ['hyphens in positions 3 and 4 (not xn--)', 'alice@ab--cd.com'],
  ['underscore in the domain', 'alice@ex_ample.com'],
  ['space in the domain', 'alice@exam ple.com'],
  ['invalid punycode', 'alice@xn--a.com'],
  ['punycode of an ASCII-only label', 'alice@xn--abc-.com'],
  ['IPv4 address', 'alice@1.2.3.4'],
  ['IPv4 literal', 'alice@[1.2.3.4]'],
  ['numeric top-level label', 'alice@example.123'],
  ['zero-width joiner (CheckJoiners)', 'alice@a‍b.com'],
  ['LTR and RTL in one label (CheckBidi)', 'alice@aא.com'],
  ['label starting with a combining mark', 'alice@́a.com'],
  ['NUL in the domain', 'alice@example.com\u0000'],
  ['non-breaking space is not trimmed', ' alice@example.com'],
  ['non-ASCII local part (no SMTPUTF8)', 'alicé@example.com'],
  ['non-ASCII local part, all letters', 'δοκιμή@example.com'],
  ['quoted local part', '"alice"@example.com'],
  ['space in a quoted local part', '"a b"@example.com'],
  ['leading dot in the local part', '.alice@example.com'],
  ['trailing dot in the local part', 'alice.@example.com'],
  ['two dots in a row in the local part', 'al..ice@example.com'],
  ['comment in the local part', 'alice(comment)@example.com'],
  ['backslash in the local part', 'al\\ice@example.com'],
  ['lone surrogate in the domain', 'alice@ex\uD800ample.com'],
  ['Gmail: nothing left before +', '+tag@gmail.com'],
  ['googlemail: nothing left before +', '+@googlemail.com'],
  ['Gmail: two dots in a row are still a syntax error', 'a..b@gmail.com'],
  ['local part of 65 bytes', `${a(65)}@example.com`],
  ['address of 255 bytes', `${a(64)}@${a(63, 'b')}.${a(63, 'c')}.${a(58, 'd')}.com`],
  ['label of 64 bytes', `alice@${a(64, 'b')}.com`],
  ['domain of 254 bytes', `a@${a(63)}.${a(63, 'b')}.${a(63, 'c')}.${a(58, 'd')}.com`],
  ['address of 255 bytes, domain of 253', `a@${a(63)}.${a(63, 'b')}.${a(63, 'c')}.${a(57, 'd')}.com`],
  ['normalized address over 254 bytes (punycode grows the domain)', `a@${idn253}`],
  ['Unicode 17.0 combining mark U+1AD0 (runtime NFC would differ)', 'alice@x\u1AD0\u0316.com'],
  ['the same as punycode, in the order Unicode 17 NFC gives', 'alice@xn--x-4cb633p.com'],
  ['the same as punycode, in the order a pre-17 runtime gives', 'alice@xn--x-4cb533p.com'],
  ['Unicode 17.0 combining mark U+1AE0', 'alice@a\u1AE0.com'],
  ['Unicode 17.0 Tai Yo letters (U+1E6E3)', 'alice@\u{1E6E3}\u{1E6E0}.example'],
  ['Unicode 15.1 CJK ideograph (after the 15.0 cutoff)', 'alice@\u{2EBF0}.example'],
  ['Unicode 18.0 character', 'alice@a\u0B53.com'],
];

// ---- build and check ----------------------------------------------------------------------------------------------

const normalizeVectors = ACCEPT.map(([label, input]) => {
  const out = normalize(input);
  if (out === null) throw new Error(`generator rejects an ACCEPT input: ${label}`);
  if (normalize(out) !== out) throw new Error(`not idempotent: ${label}`);
  return { label, in: input, out };
});
const rejectVectors = REJECT.map(([label, input]) => {
  if (normalize(input) !== null) throw new Error(`generator accepts a REJECT input: ${label} -> ${normalize(input)}`);
  return { label, in: input };
});
// Self-checks of this generator on the inputs whose lengths matter.
if (Buffer.byteLength(`a@${idn253}`, 'utf8') > 254) throw new Error('the punycode-growth input must fit 254 bytes as typed');
if (domainOf(idn253)?.length !== 253) throw new Error('idn253 must be 253 bytes in ASCII');

const subEmails = [...new Set(normalizeVectors.map((v) => v.out))];
const subVectors = subEmails.map((email) => ({ email, sub: sub(email) }));
for (const v of subVectors) if (v.sub.length !== 46 || v.sub.includes('#')) throw new Error(`bad sub shape for ${v.email}`);

const file = {
  _comment:
    'FROZEN email identity v1 vectors (packages/email/scripts/gen-vectors.mjs, an independent implementation). Changing this file changes every email user\'s address: see test/vectors.test.ts. The sub key is a TEST key: sha256(utf8(testKey.preimage)).',
  version: 1,
  provider: 'email',
  subPrefix: SUB_PREFIX,
  subLabel: SUB_LABEL,
  idna: { standard: 'UTS #46, non-transitional', library: 'tr46', version: '7.0.0', unicode: '18.0.0' },
  testKey: { preimage: TEST_KEY_PREIMAGE, derivation: 'sha256(utf8(preimage))' },
  normalize: normalizeVectors,
  reject: rejectVectors,
  sub: subVectors,
};
const text = `${JSON.stringify(file, null, 2)}\n`;

if (existsSync(OUT) && !process.argv.includes('--force')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} differs from what this generator computes: address-changing edit. Refusing to overwrite (use --force only before the address freeze).`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${normalizeVectors.length} normalize, ${rejectVectors.length} reject, ${subVectors.length} sub vectors`);
}
