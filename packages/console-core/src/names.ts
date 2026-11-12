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

// ---- what an app's name may look like (D686, D688; extended to Journear by D765) ----
//
// An app's name is shown in the sign-in pages and mails beside the service's own words, so it may not pass for the
// service or for an address: mail clients turn text that looks like a host into a link, and a code mail must carry
// none. The service's names are refused in any case, accent, alphabet or spacing: "Hana" (its name until D765),
// "Journear" (its name since), and "Passport Home" (the users' own wallet page, whose code mails a partner's app must
// never be able to imitate). "Passport" on its own is a common word and stays allowed. The rule applies where an app
// is named or renamed (the API's create and settings paths, the operator CLI); the email issuer applies it again when
// it writes a mail, so a name stored before the rule is shown as "an app".

/**
 * Letters from other alphabets, digits and a few symbols that look like a letter of "hana", "journear" or "passport
 * home": the conservative fold `nameSkeleton` applies after NFKC and accent removal (so "J0urnear", "Jоurnear" with a
 * Cyrillic o, and "Ｊｏｕｒｎｅａｒ" all fold to "journear").
 */
const LOOKALIKE: Readonly<Record<string, string>> = Object.freeze({
  // a
  'а': 'a', // Cyrillic a
  'А': 'a', // Cyrillic A
  'α': 'a', // Greek alpha
  'Α': 'a', // Greek Alpha
  'ɑ': 'a', // Latin alpha
  '@': 'a',
  '4': 'a',
  // e
  'е': 'e', // Cyrillic ie
  'Е': 'e', // Cyrillic IE
  'ё': 'e', // Cyrillic io (NFD keeps it whole)
  'Ε': 'e', // Greek Epsilon
  'ε': 'e', // Greek epsilon
  'є': 'e', // Ukrainian ie
  '3': 'e',
  // h
  'Н': 'h', // Cyrillic En (looks like H)
  'н': 'h', // Cyrillic en
  'һ': 'h', // Cyrillic shha
  'Һ': 'h', // Cyrillic Shha
  'Η': 'h', // Greek Eta
  'հ': 'h', // Armenian ho
  // j
  'ј': 'j', // Cyrillic je
  'Ј': 'j', // Cyrillic Je
  'ϳ': 'j', // Greek yot
  'ʝ': 'j', // Latin j with crossed tail
  // m
  'М': 'm', // Cyrillic Em
  'м': 'm', // Cyrillic em
  'Μ': 'm', // Greek Mu
  // n
  'Ν': 'n', // Greek Nu
  'η': 'n', // Greek eta
  'п': 'n', // Cyrillic pe
  'ո': 'n', // Armenian vo
  'ռ': 'n', // Armenian ra
  // o
  'о': 'o', // Cyrillic o
  'О': 'o', // Cyrillic O
  'ο': 'o', // Greek omicron
  'Ο': 'o', // Greek Omicron
  'σ': 'o', // Greek sigma
  'օ': 'o', // Armenian oh
  'ø': 'o',
  'Ø': 'o',
  '0': 'o',
  // p
  'р': 'p', // Cyrillic er
  'Р': 'p', // Cyrillic Er
  'ρ': 'p', // Greek rho
  'Ρ': 'p', // Greek Rho
  // r
  'г': 'r', // Cyrillic ghe
  'ʀ': 'r', // Latin small capital R
  // s
  'ѕ': 's', // Cyrillic dze
  'Ѕ': 's', // Cyrillic Dze
  '5': 's',
  '$': 's',
  // t
  'т': 't', // Cyrillic te
  'Т': 't', // Cyrillic Te
  'Τ': 't', // Greek Tau
  'τ': 't', // Greek tau
  '7': 't',
  // u
  'υ': 'u', // Greek upsilon
  'ս': 'u', // Armenian seh
  'μ': 'u', // Greek mu
});

/** The name folded for comparison: NFKC (fullwidth and styled letters), accents dropped, look-alikes mapped, lower case. */
export function nameSkeleton(name: string): string {
  const folded = [...name.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')].map((c) => LOOKALIKE[c] ?? c).join('');
  return [...folded.toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join('');
}

/** Anything but a letter or a digit: what may split a word's letters ("H a n a", "J.O.U.R.N.E.A.R"). */
const SEP = String.raw`[^\p{L}\p{N}]*`;
/** A word's letters, possibly split by `SEP`. */
const spelled = (word: string): string => [...word].join(SEP);
const WORD_START = String.raw`(?:^|[^\p{L}\p{N}])`;
const WORD_END = String.raw`(?![\p{L}\p{N}])`;

const HANA_RE = new RegExp(`${WORD_START}${spelled('hana')}`, 'u');
/**
 * "journear" anywhere, its letters together ("MyJournear", "journear-pay"), or at the start of a word with its letters
 * split ("J o u r n e a r"). Split letters count only from a word's start, so "Bonjour nearby" stays allowed.
 */
const JOURNEAR_RE = new RegExp(`journear|${WORD_START}${spelled('journear')}`, 'u');
/** "Passport Home" as words ("passport-home", "PassportHome", "P.A.S.S.P.O.R.T Home"); "Passport Homes" is allowed. */
const PASSPORT_HOME_RE = new RegExp(`${WORD_START}${spelled('passport')}${SEP}${spelled('home')}${WORD_END}`, 'u');

/** Whether a word of the name starts with "hana", its letters possibly split by spaces or punctuation ("H a n a", "H.A.N.A"). */
export const hanaWordIn = (name: string): boolean => HANA_RE.test(nameSkeleton(name));

/** Whether the name holds "Journear" (D765), in any case, accent, alphabet or spacing (see JOURNEAR_RE). */
export const journearWordIn = (name: string): boolean => JOURNEAR_RE.test(nameSkeleton(name));

/**
 * The service name a partner's app name passes for, or null: "Hana", "Journear" or "Passport Home" (D686 as extended
 * by D765). "Passport" alone is allowed.
 */
export function brandNameIn(name: string): 'Hana' | 'Journear' | 'Passport Home' | null {
  const skeleton = nameSkeleton(name);
  if (JOURNEAR_RE.test(skeleton)) return 'Journear';
  if (PASSPORT_HOME_RE.test(skeleton)) return 'Passport Home';
  if (HANA_RE.test(skeleton)) return 'Hana';
  return null;
}

/** Whether the name looks like a URL or a host: `://`, `www.`, or a dot followed by a letter after a letter or digit. */
export const looksLikeAddress = (name: string): boolean => {
  const s = name.normalize('NFKC');
  return s.includes('://') || /(?:^|[^\p{L}\p{N}])www\./iu.test(s) || /[\p{L}\p{N}][.。．｡]\p{L}/u.test(s);
};

/** Why an app name is refused by D686's rule (as extended by D765), or null. Runs on the stored form (`normaliseAppName`'s output). */
export function appNameProblem(name: string): string | null {
  if (looksLikeAddress(name)) return 'The name must not look like a web address (no "://", "www." or a dot before a letter, as in "example.com")';
  const brand = brandNameIn(name);
  if (brand) return `The name must not contain "${brand}" (in any case, spelling or alphabet): Journear's pages and mails name Journear Passport themselves`;
  return null;
}

/** An app name as stored, under every rule: `normaliseAppName` and D686's. */
export function normalisePartnerAppName(input: string): { ok: true; name: string } | { ok: false; problem: string } {
  const r = normaliseAppName(input);
  if (!r.ok) return r;
  const problem = appNameProblem(r.name);
  return problem ? { ok: false, problem } : r;
}
