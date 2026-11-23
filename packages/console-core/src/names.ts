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

// ---- what an app's name may look like (D686, D688; extended to Journear by D765, and by D891) ----
//
// An app's name is shown in the sign-in pages, the approval window ("From {App}", "{App} wants to…", "Sponsored by
// {App}.") and mails beside the service's own words, so it may not pass for the service, for an endorsement or for an
// address: mail clients turn text that looks like a host into a link, and a code mail must carry none. Refused
// (D686, D765, D891): a web-address shape; letters that only imitate others (scripts and blocks that exist here only
// to look like Latin, a word mixing Latin with another alphabet); a check mark, shield or lock; "Hana", "Journear" and
// "Passport Home"; "Passport" alone or as the wallet (with only a determiner, NEAR or a wallet word around it, a wallet
// or claim word right before or after it, a tier word such as Pro, Plus or Online right before or after it, or as the
// start of "Passport by/from/| {another name}"); a claim word after sentence punctuation ("Acme. Verified"); and a
// vouching word as the last word or after a bracket or bar ("Acme Official", "Acme (Verified)"). "{Brand} Passport" and "Passport" with words of the partner's own stay allowed. The
// rule applies where an app is named or renamed (the API's create and settings paths, the operator CLI); stored names
// are never rewritten; the email issuer applies it again when it writes a mail, so a stored name it refuses is shown
// as "an app".

/**
 * Letters from other alphabets, digits and a few symbols that look like a Latin letter: the conservative fold
 * `nameSkeleton` applies after NFKC and accent removal (so "J0urnear", "Jоurnear" with a Cyrillic o, and
 * "Ｊｏｕｒｎｅａｒ" all fold to "journear"). i, l, 1, | and ! all fold to l.
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
  // From core's partner-name confusables (verified-contracts.ts), merged here (D891 after PR 112's review).
  'в': 'b', // Cyrillic ve
  'і': 'l', // Cyrillic i (read as l, as i is)
  'ї': 'l',
  'к': 'k',
  'с': 'c',
  'у': 'y',
  'х': 'x',
  'ԁ': 'd',
  'ԛ': 'q',
  'ԝ': 'w',
  'ӏ': 'l',
  'ɡ': 'g',
  'ı': 'l', // dotless i
  'β': 'b',
  'ι': 'l', // Greek iota
  'κ': 'k',
  'ν': 'v',
  'χ': 'x',
  'ω': 'w',
  'ϲ': 'c', // Greek lunate sigma
  'Ƨ': 's', // Latin tone two (looks like a reversed S)
  'ƨ': 's',
  'Ϸ': 'p', // Greek sho
  'ϸ': 'p',
  'ɛ': 'e', // Latin open e (Akan, Ewe)
  'ɔ': 'o', // Latin open o
  '₱': 'p', // peso sign
  '¢': 'c',
  '€': 'e',
  '¥': 'y',
  // i and l, and what passes for them, read as one letter ("Wa11et", "WaIIet", "lD" for "ID").
  'i': 'l',
  '1': 'l',
  '|': 'l',
  '!': 'l',
});

/** The name folded for comparison: NFKC (fullwidth and styled letters), accents dropped, look-alikes mapped, lower case. */
export function nameSkeleton(name: string): string {
  const folded = [...name.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')].map((c) => LOOKALIKE[c] ?? c).join('');
  return [...folded.toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join('');
}

/** "rn" read as "m" and "vv" as "w" ("Joumear", "VVallet"): compared in this form on both sides. */
const canon = (skeleton: string): string => skeleton.replace(/rn/gu, 'm').replace(/vv/gu, 'w');

// ---- letters that only imitate others (D891 after PR 112's review) ----

/**
 * Scripts and blocks that exist in an app name only to look like Latin: Lisu, Cherokee, Coptic, the IPA, phonetic and
 * small-capital blocks, spacing modifier letters, Latin Extended-D and -E (ꜰ, ꞉). Akan and Ewe's ɛ and ɔ are kept.
 */
const IMITATION = /[\p{Script=Lisu}\p{Script=Cherokee}\p{Script=Coptic}\u0250-\u0253\u0255-\u025a\u025c-\u02ff\u1d00-\u1dbf\ua720-\ua7ff\uab30-\uab6f]/u;
/** Alphabets whose letters pass for Latin ones: one word may use only one of them (and Latin is one). */
const ALPHABETS: readonly RegExp[] = [/\p{Script=Latin}/u, /\p{Script=Greek}/u, /\p{Script=Cyrillic}/u, /\p{Script=Armenian}/u, /\p{Script=Georgian}/u];

/**
 * The first character or word of the name made of look-alike letters, or null: a letter from IMITATION, or a word
 * that mixes two ALPHABETS ("Pаssport" with a Cyrillic а, "Verіfied" with a Cyrillic і). A word wholly in one other
 * alphabet ("Москва") or in a script that has no Latin look-alikes ("東京", "株式会社") is allowed.
 */
export function lookalikeLettersIn(name: string): string | null {
  const s = name.normalize('NFKC');
  const bad = IMITATION.exec(s);
  if (bad) return bad[0];
  for (const word of s.split(/[^\p{L}\p{M}]+/u)) {
    if (!word) continue;
    let used = 0;
    for (const re of ALPHABETS) if (re.test(word)) used++;
    if (used > 1) return word;
  }
  return null;
}

/**
 * Check marks, shields, locks and seals: only Journear's own badge carries one (D44 strips them from partner contract
 * names; core's `CHECK_MARKS` is a subset of this, a test keeps it so).
 */
export const APP_NAME_BADGES = /[\u2611\u2705\u2713\u2714\u221a\u237b\u{10102}\u{1F5F8}\u{1F5F9}\u{1FBB1}\u{1F6E1}\u26e8\u26e9\u{1F50F}-\u{1F513}\u{1F396}\u{1F397}\u{1F3C5}\u{1F947}\u{1F197}\u{1F44D}\u{1F4AF}\ufe0e\ufe0f]/u;

// ---- the service's names (D686, D765) ----

/** Anything but a letter or a digit: what may split a word's letters ("H a n a", "J.O.U.R.N.E.A.R"). */
const SEP = String.raw`[^\p{L}\p{N}]*`;
/** A word's letters, possibly split by `SEP`. */
const spelled = (word: string): string => [...word].join(SEP);
const WORD_START = String.raw`(?:^|[^\p{L}\p{N}])`;
const WORD_END = String.raw`(?![\p{L}\p{N}])`;

const HANA_RE = new RegExp(`${WORD_START}${spelled('hana')}`, 'u');
/**
 * "journear" anywhere, its letters together ("MyJournear", "journear-pay"), or at the start of a word with its letters
 * split ("J o u r n e a r"). Split letters count only from a word's start, so "Bonjour nearby" stays allowed. Also
 * tried with "m" read as "rn" ("Joumear").
 */
const JOURNEAR_RE = new RegExp(`journear|${WORD_START}${spelled('journear')}`, 'u');
/** "Passport Home" as words ("passport-home", "PassportHome", "P.A.S.S.P.O.R.T Home"); "Passport Homes" is allowed. */
const PASSPORT_HOME_RE = new RegExp(`${WORD_START}${spelled('passport')}${SEP}${spelled('home')}${WORD_END}`, 'u');

/** The skeleton, and the skeleton with "m" read as "rn" and "w" as "vv" (for "Joumear"). */
const skeletons = (name: string): string[] => {
  const s = nameSkeleton(name);
  const wide = s.replace(/m/gu, 'rn').replace(/w/gu, 'vv');
  return wide === s ? [s] : [s, wide];
};

/** Whether a word of the name starts with "hana", its letters possibly split by spaces or punctuation ("H a n a", "H.A.N.A"). */
export const hanaWordIn = (name: string): boolean => HANA_RE.test(nameSkeleton(name));

/** Whether the name holds "Journear" (D765), in any case, accent, alphabet or spacing (see JOURNEAR_RE). */
export const journearWordIn = (name: string): boolean => skeletons(name).some((s) => JOURNEAR_RE.test(s));

/**
 * The service name a partner's app name passes for, or null: "Hana", "Journear" or "Passport Home" (D686 as extended
 * by D765). "Passport" itself is D891's rule (`passportProblemIn`).
 */
export function brandNameIn(name: string): 'Hana' | 'Journear' | 'Passport Home' | null {
  const skeleton = nameSkeleton(name);
  if (journearWordIn(name)) return 'Journear';
  if (PASSPORT_HOME_RE.test(skeleton)) return 'Passport Home';
  if (HANA_RE.test(skeleton)) return 'Hana';
  return null;
}

/** Whether the name looks like a URL or a host: `://`, `www.`, or a dot followed by a letter after a letter or digit. */
export const looksLikeAddress = (name: string): boolean => {
  const s = name.normalize('NFKC');
  return s.includes('://') || /(?:^|[^\p{L}\p{N}])www\./iu.test(s) || /[\p{L}\p{N}][.。．｡]\p{L}/u.test(s);
};

// ---- words ----

/** A word of the name: as written (NFKC) and as compared (`canon(nameSkeleton(…))`). */
interface Word {
  readonly text: string;
  readonly key: string;
}

/**
 * The name's words: runs of letters, marks, digits and the symbols the skeleton reads as letters ($ @ | ! ₱ ¢ € ¥),
 * with each run of one-character words joined ("P a s s p o r t" → "Passport"). Split before folding, so each word
 * keeps its written form for messages.
 */
function wordsIn(text: string): Word[] {
  // "|" and "!" pass for l only inside a word ("Wa||et"); at a word's edge they are punctuation ("Yahoo!").
  const raw = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{M}\p{N}$@|!₱¢€¥]+/u)
    .map((w) => w.replace(/^[|!]+|[|!]+$/gu, ''))
    .filter((w) => w.length > 0);
  const out: Word[] = [];
  let run = '';
  const push = (t: string) => out.push({ text: t, key: canon(nameSkeleton(t)) });
  for (const w of raw) {
    if ([...w].length === 1) {
      run += w;
      continue;
    }
    if (run) push(run);
    run = '';
    push(w);
  }
  if (run) push(run);
  return out;
}

/** A vocabulary word in compared form. */
const key = (word: string): string => canon(nameSkeleton(word));
const keys = (list: readonly string[]): Set<string> => new Set(list.map(key));

// ---- claim words (D891) ----

/**
 * Claim stems: a word that starts with one of these makes a claim only Journear may make (checked, safe, free,
 * official, …), with every inflection ("Verifying", "Certification"). Also the common Latin-script forms of Spanish,
 * Portuguese, French, German, Italian and Malay. Compared in skeleton form. "Insure" is a whole word only
 * (`APP_NAME_CLAIM_WORDS`), so a store title such as "Allstate: Insurance Quotes" stays allowed.
 */
export const APP_NAME_CLAIM_STEMS: readonly string[] = Object.freeze([
  'verif', 'certif', 'offici', 'ofici', 'guarant', 'garant', 'warrant', 'approv', 'aprob', 'recommend', 'endors', 'authent', 'genuin', 'legit',
  'refund', 'reimburs', 'secur', 'segur', 'protect', 'trust', 'safe', 'sicher', 'gratis', 'gratuit', 'kostenlos', 'percuma', 'selamat', 'disahkan',
  'rasmi', 'dijamin', 'jaminan', 'harmless', 'riskless', 'riskfree', 'feeless', 'scamfree', 'reversib', 'audit', 'authoriz', 'authoris', 'licens',
  'licenc', 'regulat', 'vetted', 'reviewed', 'sponsor', 'checked', 'validated',
]);
/** Whole claim words. */
export const APP_NAME_CLAIM_WORDS: readonly string[] = Object.freeze(['insure', 'insured', 'insures', 'insuring', 'free', 'freely', 'fee', 'fees', 'risk', 'risks', 'cost', 'costs', 'costless', 'nocost', 'nofee', 'nofees', 'norisk']);
/** Claim phrases of two words. */
const CLAIM_PAIRS: readonly (readonly [string, string])[] = [['no', 'charge'], ['no', 'charges'], ['costs', 'nothing'], ['zero', 'cost']];

const STEMS = APP_NAME_CLAIM_STEMS.map(key);
const CLAIM_EXACT = keys(APP_NAME_CLAIM_WORDS);
const PAIRS = CLAIM_PAIRS.map(([a, b]) => [key(a), key(b)] as const);

/** The claim word (as written) at `i` in `words`, read alone or joined with the next word ("Sa fe"), or null. */
function claimAt(words: readonly Word[], i: number): string | null {
  const w = words[i]!;
  const next = words[i + 1];
  const isClaim = (k: string) => CLAIM_EXACT.has(k) || STEMS.some((s) => k.startsWith(s));
  if (isClaim(w.key)) return w.text;
  if (next && isClaim(w.key + next.key) && !isClaim(next.key)) return `${w.text} ${next.text}`;
  if (next && PAIRS.some(([a, b]) => w.key === a && next.key === b)) return `${w.text} ${next.text}`;
  return null;
}

// ---- "Passport" as the wallet's own name (D891) ----

const PASSPORT = key('passport');
/** Words that only make "Passport" more the wallet's when they come before it, as the whole name ("My NEAR Passport"). */
const PASSPORT_PREFIXES = keys(['the', 'a', 'an', 'my', 'your', 'our', 'near', 'wallet', 'official']);
/**
 * The whole name, as compared and run together, that is "Passport": at most two PASSPORT_PREFIXES before it, and at
 * most a trade mark (TM, SM), a plural or possessive s, one digit or one letter after it.
 */
const PASSPORT_ALONE_RE = new RegExp(`^(?:${[...PASSPORT_PREFIXES].join('|')}){0,2}${PASSPORT}(?:tm|sm|[\\p{L}\\p{N}])?$`, 'u');
/**
 * Words that make "Passport" the wallet or one of its parts when right after it ("Passport Wallet") or right before it
 * ("Wallet Passport", "Wallet by Passport"), with an optional plural. ID and from count only after it ("World ID
 * Passport" is another product's name).
 */
const PASSPORT_PRODUCT_WORDS = [
  'wallet', 'app', 'account', 'login', 'signin', 'signon', 'signup', 'support', 'help', 'security', 'team', 'official', 'pay', 'vault', 'verify',
  'recovery', 'admin', 'staff', 'service', 'auth', 'connect', 'key', 'relayer', 'sponsor', 'gas', 'by',
];
const PRODUCT = keys(PASSPORT_PRODUCT_WORDS);
const PRODUCT_AFTER_ONLY = keys(['id', 'from']);
/** A word of `set`, alone or with a plural s/es. */
const inWithPlural = (set: (x: string) => boolean, k: string): boolean =>
  set(k) || (k.endsWith('s') && set(k.slice(0, -1))) || (k.endsWith('es') && set(k.slice(0, -2)));
/** A product word, alone or with a plural s/es. */
const productWord = (k: string, after: boolean): boolean => inWithPlural((x) => PRODUCT.has(x) || (after && PRODUCT_AFTER_ONLY.has(x)), k);
/**
 * Words that make "Passport" read as a version, tier or form of the wallet itself when right after it ("Passport
 * Pro", "Passport Online") or right before it ("Premium Passport", "Mobile Passport"), plural too (decided by the
 * founder 2026-11-23, D891). "Free" is a claim word already; "X" and other single letters are the "alone" rule.
 */
export const APP_NAME_PASSPORT_TIER_WORDS: readonly string[] = Object.freeze([
  'plus', 'pro', 'one', 'go', 'lite', 'mini', 'max', 'ultra', 'prime', 'premium', 'basic', 'classic', 'beta', 'next', 'card', 'online', 'mobile', 'web',
  'cloud', 'desktop', 'extension',
]);
const TIER = keys(APP_NAME_PASSPORT_TIER_WORDS);
/** A tier word, alone or with a plural s/es. */
const tierWord = (k: string): boolean => inWithPlural((x) => TIER.has(x), k);

/** A word or two at `i` that pass `test` (joined: "On line", "Sign up"); the span, or null. */
function spanAt(words: readonly Word[], i: number, test: (k: string) => boolean): { len: number; text: string } | null {
  const w = words[i];
  if (!w) return null;
  if (test(w.key)) return { len: 1, text: w.text };
  const n = words[i + 1];
  if (n && test(w.key + n.key)) return { len: 2, text: `${w.text} ${n.text}` };
  return null;
}

/** Separators after a leading "Passport" that make the rest another name: "Passport, by Acme", "Passport | Acme". */
const PASSPORT_THEN_NAME = new RegExp(
  String.raw`^[^\p{L}\p{N}]*(?:(?:the|a|an|my|your|our|near|wallet|offlclal)[^\p{L}\p{N}]+){0,2}${spelled('passport')}s?\s*(?:[,()\[\]{}:;·•/\\<>«»"“”„]|[\p{Pd}−](?=\s)|\s[\p{Pd}−]|[–-―]|(?:by|from|of)${WORD_END})`,
  'u',
);

/** Why the name passes for Journear Passport itself, called "Passport" by its users (D891), or null. */
export type PassportProblem =
  | { readonly kind: 'alone'; readonly around: string }
  | { readonly kind: 'after' | 'before'; readonly word: string }
  | { readonly kind: 'tier_after' | 'tier_before' | 'tier_joined'; readonly word: string }
  | { readonly kind: 'claim'; readonly word: string }
  | { readonly kind: 'then_name' };

/** Where the words at `i` (one word, or two joined: "Pass Port") read "passport"; the span's length, or 0. */
function passportSpan(words: readonly Word[], i: number): number {
  if (words[i]!.key === PASSPORT) return 1;
  if (words[i + 1] && words[i]!.key + words[i + 1]!.key === PASSPORT) return 2;
  return 0;
}

/** A word or two at `i` that read as a product word (joined: "Sign up", "Sign-on"); the span, or null. */
const productSpan = (words: readonly Word[], i: number, after: boolean) => spanAt(words, i, (k) => productWord(k, after));

/**
 * Whether, and why, the name passes for Journear Passport (D891 after PR 112's review), compared word by word on the
 * skeleton (case, accents, look-alike letters, digits for letters, split letters, "rn" for "m"):
 * - "alone": the whole name is "Passport" with at most two of the/a/an/my/your/our/near/wallet/official before it and
 *   at most a trade mark, an s, a digit or a letter after it ("My NEAR Passport", "Passports", "Passport's",
 *   "Passport 2", "Passport℠");
 * - "after" / "before": a wallet word or "by" right after or before it, plural too ("Passport Wallets", "Admin
 *   Passport", "Wallet by Passport"); ID and from only after it;
 * - "tier_after" / "tier_before": a tier or form word (`APP_NAME_PASSPORT_TIER_WORDS`) right after or before it,
 *   plural too ("Passport Pro", "Passport Online", "Premium Passport"), or run together with it ("tier_joined":
 *   "PassportPlus", "OnePassport"): a version of the wallet itself;
 * - "claim": a claim word right before or after it ("Verified Passport", "Passport Safe");
 * - "then_name": the name starts with "Passport" followed by a separator, "by", "from" or "of" and another name
 *   ("Passport | Acme", "Passport (Acme)", "Passport from Acme"): it reads as "Passport, made by Acme".
 * "{Brand} Passport" ("Gitcoin Passport", "World ID Passport") and "Passport" with words of the partner's own
 * ("Passport Photos Co", "Passport Network") stay allowed.
 */
export function passportProblemIn(name: string): PassportProblem | null {
  const words = wordsIn(name);
  if (PASSPORT_ALONE_RE.test(words.map((w) => w.key).join(''))) {
    return { kind: 'alone', around: words.filter((w) => w.key !== PASSPORT && [...w.text].length > 1).map((w) => w.text).join(' ') };
  }
  const isClaim = (k: string) => CLAIM_EXACT.has(k) || STEMS.some((s) => k.startsWith(s));
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    // Run together: "PassportWallet", "WalletPassport", "VerifiedPassport".
    if (w.key !== PASSPORT && w.key.startsWith(PASSPORT)) {
      const rest = w.key.slice(PASSPORT.length);
      if (productWord(rest, true)) return { kind: 'after', word: w.text };
      if (tierWord(rest)) return { kind: 'tier_joined', word: w.text };
      if (isClaim(rest)) return { kind: 'claim', word: w.text };
    }
    if (w.key !== PASSPORT && w.key.endsWith(PASSPORT)) {
      const rest = w.key.slice(0, -PASSPORT.length);
      if (productWord(rest, false)) return { kind: 'before', word: w.text };
      if (tierWord(rest)) return { kind: 'tier_joined', word: w.text };
      if (isClaim(rest)) return { kind: 'claim', word: w.text };
    }
    const span = passportSpan(words, i);
    if (!span) continue;
    const next = productSpan(words, i + span, true);
    if (next) return { kind: 'after', word: next.text };
    const nextTier = spanAt(words, i + span, tierWord);
    if (nextTier) return { kind: 'tier_after', word: nextTier.text };
    const p1 = words[i - 1];
    const p2 = words[i - 2];
    if (p1 && productWord(p1.key, false)) return { kind: 'before', word: p1.text };
    if (p1 && p2 && productWord(p2.key + p1.key, false)) return { kind: 'before', word: `${p2.text} ${p1.text}` };
    if (p1 && tierWord(p1.key)) return { kind: 'tier_before', word: p1.text };
    if (p1 && p2 && tierWord(p2.key + p1.key)) return { kind: 'tier_before', word: `${p2.text} ${p1.text}` };
    const claimAfter = i + span < words.length ? claimAt(words, i + span) : null;
    if (claimAfter) return { kind: 'claim', word: claimAfter };
    if (p1 && isClaim(p1.key)) return { kind: 'claim', word: p1.text };
    if (p1 && p2 && isClaim(p2.key + p1.key)) return { kind: 'claim', word: `${p2.text} ${p1.text}` };
  }
  if (PASSPORT_THEN_NAME.test(nameSkeleton(name.replace(/[|¦｜!]/gu, '/')))) return { kind: 'then_name' };
  return null;
}

/** Whether the name passes for Journear Passport (`passportProblemIn`). */
export const passportNameIn = (name: string): boolean => passportProblemIn(name) !== null;

// ---- sentence punctuation with a claim word (D891) ----

/**
 * What ends or splits a sentence in Journear's lines: Unicode's terminal punctuation (full stops, "!", "?", "‽", ":",
 * ";", the Arabic, Devanagari, Ethiopic and CJK stops, …) but commas; "…"; any dash or the minus sign beside a space;
 * an en dash, em dash or horizontal bar anywhere; and the look-alike dots and colons (ꓸ ∶ ꞉ ː ⸱ ⁏). Matched after
 * NFKC, so full-width forms count. "Dr.", "Mr.", "Mrs.", "Ms.", "St.", "Jr.", "Sr." and "Mt." before a space are
 * abbreviations, not a break.
 */
const SENTENCE_BREAK_RE = /(?![,\u060c\u3001\ufe50\uff0c\ufe51\ufe10])[\p{Term}\p{Sentence_Terminal}\u2026\u203d\ua4f8\u2236\ua789\u02d0\u2e31\u204f\u2013-\u2015]|[\p{Pd}\u2212](?=\s)|(?<=\s)[\p{Pd}\u2212]/u;
const ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|St|Jr|Sr|Mt)\.(?=\s)/giu;

/**
 * The claim word a name uses after sentence punctuation (D891), as written, or null. Only the words after the first
 * break count, so a brand before it stays allowed ("Trust: Crypto & Bitcoin Wallet", "Stay Safe!", "Dr. Trust"); after
 * it, any claim word or stem ("Acme. Verified", "Acme: safe", "Acme! No fees", "Acme – risk free", "Acme. Sa fe").
 */
export function sentenceClaimIn(name: string): string | null {
  const s = name.normalize('NFKC').replace(ABBREVIATION, (m) => m.slice(0, -1));
  const m = SENTENCE_BREAK_RE.exec(s);
  if (!m) return null;
  const words = wordsIn(s.slice(m.index + m[0].length));
  for (let i = 0; i < words.length; i++) {
    const c = claimAt(words, i);
    if (c) return c;
  }
  return null;
}

// ---- a vouching word at the end (D891, decided while reviewing PR 112) ----

/** Words that vouch for something: refused as the name's last word or right after a bracket, bar, slash, comma or dot. */
const VOUCHING_STEMS = ['verif', 'offici', 'checked', 'certif', 'approv', 'audited', 'endors', 'authent', 'genuin', 'legit'].map(key);

/**
 * The vouching word that ends the name or follows a separator ("From Acme Official", "Sponsored by Acme Verified.",
 * "Acme (Official)", "Acme | Certified"), as written, or null. At the start of a name they are part of a brand
 * ("Verified Voting", "Official Charts Company") and stay allowed; safe, free, secure and trust stay allowed here (too
 * common in real names).
 */
export function vouchingWordIn(name: string): string | null {
  const vouches = (w: Word | undefined) => (w !== undefined && VOUCHING_STEMS.some((s) => w.key.startsWith(s)) ? w.text : null);
  const all = wordsIn(name);
  if (all.length > 1) {
    const last = vouches(all[all.length - 1]);
    if (last) return last;
  }
  const parts = name.normalize('NFKC').split(/[()[\]{}|/\\,·•]+/u);
  for (const part of parts.slice(1)) {
    const first = vouches(wordsIn(part)[0]);
    if (first) return first;
  }
  return null;
}

// ---- the rule ----

const PASSPORT_KEEP = 'Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine';

function passportMessage(p: PassportProblem): string {
  switch (p.kind) {
    case 'alone':
      return `The name must not be "Passport" on its own${p.around ? ` or with only "${p.around}" around it` : ''}, in any case, spelling or alphabet. ${PASSPORT_KEEP}`;
    case 'after':
      return `The name must not have "${p.word}" right after "Passport": it reads as part of the wallet. ${PASSPORT_KEEP}`;
    case 'before':
      return `The name must not have "${p.word}" right before "Passport": it reads as part of the wallet. ${PASSPORT_KEEP}`;
    case 'tier_after':
      return `The name must not have "${p.word}" right after "Passport": it reads as a version of the wallet, as "Passport Pro" would. ${PASSPORT_KEEP}`;
    case 'tier_before':
      return `The name must not have "${p.word}" right before "Passport": it reads as a version of the wallet, as "Premium Passport" would. ${PASSPORT_KEEP}`;
    case 'tier_joined':
      return `The name must not be "${p.word}": "Passport" joined with a word like "Pro", "Plus" or "Online" reads as a version of the wallet. ${PASSPORT_KEEP}`;
    case 'claim':
      return `The name must not put "${p.word}" next to "Passport": it reads as the wallet vouching for itself. ${PASSPORT_KEEP}`;
    case 'then_name':
      return `The name must not start with "Passport" followed by another name ("Passport by Acme", "Passport | Acme", "Passport (Acme)"): it reads as the wallet, made by that brand. ${PASSPORT_KEEP}`;
  }
}

/** Why an app name is refused by D686's rule (as extended by D765 and D891), or null. Runs on the stored form (`normaliseAppName`'s output). */
export function appNameProblem(name: string): string | null {
  if (looksLikeAddress(name)) return 'The name must not look like a web address (no "://", "www." or a dot before a letter, as in "example.com")';
  const brand = brandNameIn(name);
  if (brand) return `The name must not contain "${brand}" (in any case, spelling or alphabet): Journear's pages and mails name Journear Passport themselves`;
  const imitation = lookalikeLettersIn(name);
  if (imitation !== null) {
    return 'The name must not use letters that imitate others: small capitals, phonetic letters, Cherokee, Lisu or Coptic letters, or a word that mixes Latin with Greek, Cyrillic or another alphabet. Write each word in one alphabet';
  }
  if (APP_NAME_BADGES.test(name)) return 'The name must not have a check mark, a shield, a lock or a medal: only Journear’s own badge carries a check mark';
  const passport = passportProblemIn(name);
  if (passport) return passportMessage(passport);
  const claim = sentenceClaimIn(name);
  if (claim) {
    return `The name must not have a word like "${claim}" after sentence punctuation (a full stop, "!", "?", ":", ";", "…", an en or em dash, or a hyphen or dash with a space beside it): in the approval window it could read as Journear's own words. Drop the punctuation or the word`;
  }
  const vouching = vouchingWordIn(name);
  if (vouching) {
    return `The name must not end with "${vouching}" or have it after a bracket, bar or comma: "From Acme ${vouching}" reads as an endorsement. Put it first, or leave it out`;
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
