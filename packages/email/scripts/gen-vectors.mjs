#!/usr/bin/env node
// Writes vectors/email-v1.json: the FROZEN golden vectors of email normalization v1 and the e1. `sub`
// (docs/email-login-spec.md "Email normalization", "`sub`: HMAC of the normalized email"). It is an independent
// implementation: Node's own UTS #46 (`url.domainToASCII`, the WHATWG URL host parser: non-transitional, Ada in
// Node) plus this file's own LDH, length and Gmail rules, and node:crypto HMAC. The package code (tr46, Web Crypto)
// must reproduce every vector: test/vectors.test.ts.
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

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'email-v1.json');

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
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input)) return null;
  const ascii = domainToASCII(input);
  if (ascii === '') return null;
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
    local = local.split('+')[0].split('.').join('');
    if (local === '') return null;
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
  ['Gmail: dots and +tag dropped, lowercased', 'A.B.C+Tag@Gmail.com'],
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
