// App names as the API stores them (docs/batch-c-spec.md "Other app settings, name and logo": ≤ 64 characters, the
// batch B label rules). The name is shown beside the verified origin in the consent and approval popups, so it must be
// one display-safe line: the property-based rule of @hana-id/core `isDisplaySafeLine` (display-safe.ts), copied here
// because the Worker can't typecheck @hana-id/core's root entry; test/names.test.ts checks the two agree on every code
// point.
const INVISIBLE = String.raw`\p{Cf}\p{Co}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0100}-\u{e01ef}`;
const UNSAFE_LINE = new RegExp(String.raw`[\p{Cc}${INVISIBLE}]`, 'u');

/** One-line text with no control, format (bidi, zero-width), private-use, separator or other invisible character. */
export const isDisplaySafeName = (text: string): boolean => !UNSAFE_LINE.test(text);

/** The longest app name, in code points, after NFC and trimming. */
export const APP_NAME_MAX = 64;

/** The stored form of an app name (NFC, trimmed), or why it is refused. */
export function normaliseAppName(input: string): { ok: true; name: string } | { ok: false; problem: string } {
  const name = input.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > APP_NAME_MAX) return { ok: false, problem: `The name must be 1..${APP_NAME_MAX} characters` };
  if (!isDisplaySafeName(name)) return { ok: false, problem: 'The name has a control, format (bidi, zero-width), separator or other invisible character' };
  return { ok: true, name };
}

// ---- what an app's name may look like (D686) ----
//
// An app's name is shown in Hana's sign-in pages and mails beside Hana's own words, so it may not pass for Hana or
// for an address: mail clients turn text that looks like a host into a link, and a code mail must carry none. The
// rule applies where an app is named or renamed (the API's create and settings paths, the operator CLI); the email
// issuer applies it again when it writes a mail, so a name stored before the rule is shown as "an app".

/** Letters from other alphabets (and two symbols) that look like a, h or n: the conservative fold `hanaWordIn` uses. */
const LOOKALIKE: Readonly<Record<string, string>> = Object.freeze({
  // a
  'а': 'a', // Cyrillic a
  'А': 'a', // Cyrillic A
  'α': 'a', // Greek alpha
  'Α': 'a', // Greek Alpha
  'ɑ': 'a', // Latin alpha
  '@': 'a',
  '4': 'a',
  // h
  'Н': 'h', // Cyrillic En (looks like H)
  'н': 'h', // Cyrillic en
  'һ': 'h', // Cyrillic shha
  'Һ': 'h', // Cyrillic Shha
  'Η': 'h', // Greek Eta
  'հ': 'h', // Armenian ho
  // n
  'Ν': 'n', // Greek Nu
  'η': 'n', // Greek eta
  'п': 'n', // Cyrillic pe
  'ո': 'n', // Armenian vo
  'ռ': 'n', // Armenian ra
});

/** The name folded for comparison: NFKC (fullwidth and styled letters), accents dropped, look-alikes mapped, lower case. */
export function nameSkeleton(name: string): string {
  const folded = [...name.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')].map((c) => LOOKALIKE[c] ?? c).join('');
  return [...folded.toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join('');
}

/** Whether a word of the name starts with "hana", its letters possibly split by spaces or punctuation ("H a n a", "H.A.N.A"). */
export const hanaWordIn = (name: string): boolean => /(?:^|[^\p{L}\p{N}])h[^\p{L}\p{N}]*a[^\p{L}\p{N}]*n[^\p{L}\p{N}]*a/u.test(nameSkeleton(name));

/** Whether the name looks like a URL or a host: `://`, `www.`, or a dot followed by a letter after a letter or digit. */
export const looksLikeAddress = (name: string): boolean => {
  const s = name.normalize('NFKC');
  return s.includes('://') || /(?:^|[^\p{L}\p{N}])www\./iu.test(s) || /[\p{L}\p{N}][.。．｡]\p{L}/u.test(s);
};

/** Why an app name is refused by D686's rule, or null. Runs on the stored form (`normaliseAppName`'s output). */
export function appNameProblem(name: string): string | null {
  if (looksLikeAddress(name)) return 'The name must not look like a web address (no "://", "www." or a dot before a letter, as in "example.com")';
  if (hanaWordIn(name)) return 'The name must not contain "Hana" (in any case, spelling or alphabet): Hana\'s pages and mails name Hana themselves';
  return null;
}

/** An app name as stored, under every rule: `normaliseAppName` and D686's. */
export function normalisePartnerAppName(input: string): { ok: true; name: string } | { ok: false; problem: string } {
  const r = normaliseAppName(input);
  if (!r.ok) return r;
  const problem = appNameProblem(r.name);
  return problem ? { ok: false, problem } : r;
}
