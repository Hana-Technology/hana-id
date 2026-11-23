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
// never be able to imitate). Since D891 "Passport" itself is refused too, alone or in a form that reads as the wallet
// ("My Passport", "Passport Wallet", "Passport by …"), because users know Journear Passport as "Passport" and the
// approval window says "Sponsored by {App}."; "Passport" as one word of another name ("Passport Photos Co") stays
// allowed. Also since D891, a name that holds sentence punctuation may not hold one of Journear's claim words ("Acme.
// Verified" would read "Sponsored by Acme. Verified." in Journear's own line). The rule applies where an app is named
// or renamed (the API's create and settings paths, the operator CLI); stored names are never rewritten; the email
// issuer applies it again when it writes a mail, so a name stored before the rule is shown as "an app".

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

// ---- "Passport" as the wallet's own name (D891) ----

/** The skeleton's words: runs of letters and digits ("P a s s p o r t" is eight words; see `compactWords`). */
const wordsOf = (skeleton: string): string[] => skeleton.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

/**
 * The words with each run of one-character words joined into one ("S a f e" → "safe", "Acme. V e r i f i e d" →
 * "acme", "verified"), so letters split by spaces or punctuation count as the word they spell.
 */
function compactWords(words: readonly string[]): string[] {
  const out: string[] = [];
  let run = '';
  for (const w of words) {
    if ([...w].length === 1) {
      run += w;
      continue;
    }
    if (run) out.push(run);
    run = '';
    out.push(w);
  }
  if (run) out.push(run);
  return out;
}

/**
 * The whole name, its letters and digits only, that is "Passport" itself: alone, after a determiner or the wallet's
 * own words ("The", "My", "Your", "Our", "NEAR", "Wallet"), with a trailing "TM" (what "™" folds to). Compared on the
 * skeleton with every separator removed, so "P a s s p o r t", "PASS-PORT", "Pаssport" (Cyrillic а), "Pa55port" and
 * "Passport!" all count.
 */
const PASSPORT_ALONE_RE = /^(?:the|my|your|our|near|wallet)?passport(?:tm)?$/u;
/**
 * "Passport" followed, as words, by a word that makes it the wallet or one of its parts ("Passport Wallet", "Passport
 * App", "Passport Sign-in", "Passport Support", "Passport by Acme"), anywhere in the name. "Passport Home" has its own
 * rule (D686 as extended by D765, `brandNameIn`).
 */
const PASSPORT_PRODUCT_WORDS = ['wallet', 'app', 'account', 'accounts', 'id', 'login', 'signin', 'support', 'help', 'security', 'team', 'official', 'pay', 'vault', 'by'];
const PASSPORT_PRODUCT_RE = new RegExp(`${WORD_START}${spelled('passport')}${SEP}(?:${PASSPORT_PRODUCT_WORDS.map(spelled).join('|')})${WORD_END}`, 'u');

/**
 * Whether the name passes for Journear Passport itself, called "Passport" by its users (D891): "Passport" alone or
 * in a form that reads as the wallet (`PASSPORT_ALONE_RE`, `PASSPORT_PRODUCT_RE`), in any case, accent, alphabet,
 * look-alike letter or spacing. "Passport" as one word of another name ("Passport Photos Co", "Passport Travel",
 * "Travel Passport") is allowed.
 */
export function passportNameIn(name: string): boolean {
  const skeleton = nameSkeleton(name);
  return PASSPORT_ALONE_RE.test(wordsOf(skeleton).join('')) || PASSPORT_PRODUCT_RE.test(skeleton);
}

// ---- sentence punctuation with a claim word (D891) ----

/**
 * What ends or splits a sentence in Journear's lines: a full stop (also ideographic and half-width), "!", "?", their
 * inverted forms, ":", ";", "…", an en or em dash, and a hyphen with a space on either side. Matched after NFKC, so
 * full-width forms count.
 */
const SENTENCE_BREAK_RE = /[.!?¡¿:;…–—。｡]|\s-|-\s/u;

/**
 * Journear's claim words and their usual inflections, as skeleton words (lower case, accents dropped, look-alikes and
 * digits folded): what a name that reads as a sentence may not say after "Sponsored by " or before " wants to".
 */
export const APP_NAME_CLAIM_WORDS: readonly string[] = Object.freeze([
  'checked',
  'verify', 'verifies', 'verified', 'verification',
  'official', 'officially',
  'safe', 'safer', 'safest', 'safely', 'safety',
  'secure', 'secured', 'securely', 'security',
  'guarantee', 'guarantees', 'guaranteed',
  'risk', 'risks', 'riskless',
  'free', 'fee', 'fees', 'feeless',
  'refund', 'refunds', 'refunded', 'refundable',
  'insure', 'insured', 'insurance',
  'approve', 'approves', 'approved', 'approval',
  'recommend', 'recommends', 'recommended',
  'trust', 'trusted', 'trustworthy',
  'protect', 'protected', 'protection',
  'certified', 'audited', 'endorsed', 'authentic', 'genuine', 'legit', 'legitimate',
]);
const CLAIM_WORDS = new Set(APP_NAME_CLAIM_WORDS);

/**
 * The claim word a name uses beside sentence punctuation (D891), or null. A name with no sentence punctuation may hold
 * any of these words ("Safe Wallet", "Free Now", "Trust Wallet"); a name with it may hold none ("Acme. Verified",
 * "Acme: safe", "Acme! No fees", "Acme – risk free", "S4fe. Acme", "Acme. S a f e"). On the skeleton, so look-alike
 * letters and digits fold as for Journear's names, "1" read as "i" too.
 */
export function sentenceClaimIn(name: string): string | null {
  if (!SENTENCE_BREAK_RE.test(name.normalize('NFKC'))) return null;
  const words = compactWords(wordsOf(nameSkeleton(name).replace(/1/gu, 'i')));
  return words.find((w) => CLAIM_WORDS.has(w)) ?? null;
}

/** Why an app name is refused by D686's rule (as extended by D765 and D891), or null. Runs on the stored form (`normaliseAppName`'s output). */
export function appNameProblem(name: string): string | null {
  if (looksLikeAddress(name)) return 'The name must not look like a web address (no "://", "www." or a dot before a letter, as in "example.com")';
  const brand = brandNameIn(name);
  if (brand) return `The name must not contain "${brand}" (in any case, spelling or alphabet): Journear's pages and mails name Journear Passport themselves`;
  if (passportNameIn(name)) {
    return 'The name must not be "Passport" on its own or read as the wallet ("My Passport", "Passport Wallet", "Passport App", "Passport by …"), in any case, spelling or alphabet: users call Journear Passport "Passport". "Passport" with words of your own, as in "Passport Photos Co", is fine';
  }
  const claim = sentenceClaimIn(name);
  if (claim) {
    return `The name must not use sentence punctuation (". ", "!", "?", ":", ";" or a dash) together with a word like "${claim}": in the approval window it could read as Journear's own words. Drop the punctuation or the word`;
  }
  return null;
}

/** An app name as stored, under every rule: `normaliseAppName` and D686's (as extended by D765 and D891). */
export function normalisePartnerAppName(input: string): { ok: true; name: string } | { ok: false; problem: string } {
  const r = normaliseAppName(input);
  if (!r.ok) return r;
  const problem = appNameProblem(r.name);
  return problem ? { ok: false, problem } : r;
}
