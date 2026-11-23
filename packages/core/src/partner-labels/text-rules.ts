// The partner text rules (D892): the one check for every piece of text a partner writes into a label (the object
// phrase, a field's label, an enumeration's labels, an address book name). Partner text sits in the approval window
// beside Journear's own words and true values, so it is held to a strict, small shape: a short line of Latin letters,
// digits and a few punctuation marks, saying no claim, naming no product or token, and looking like no address or
// amount. Each rule's reason is in D892 "The text rules". Pure: no imports beyond core's pinned lists.
import { DEMO_CHECK_IN_NAME, VERIFIED_CONTRACTS, nameSkeleton } from '../verified-contracts.ts';
import { KNOWN_TOKENS } from '../known-tokens.ts';
import { REVIEWED_NEAR_CONTRACTS } from '../reviewed-near-calls.ts';
import { OTHER_NAMES } from './names-data.ts';

/** Where a piece of partner text appears; only the length limit depends on it. */
export type PartnerTextRole = 'object' | 'fieldLabel' | 'enumLabel' | 'addressName';

/** The longest text per role, in characters (code points). */
export const PARTNER_TEXT_MAX: Readonly<Record<PartnerTextRole, number>> = Object.freeze({ object: 30, fieldLabel: 24, enumLabel: 32, addressName: 32 });

/** Why a partner text is refused: a stable code, and a plain message a partner can act on. */
export type PartnerTextCode =
  | 'text_not_string'
  | 'text_empty'
  | 'text_too_long'
  | 'text_not_nfc'
  | 'text_spacing'
  | 'text_character'
  | 'text_punctuation'
  | 'text_no_letter'
  | 'text_number'
  | 'text_looks_like_address'
  | 'text_link'
  | 'text_brand'
  | 'text_reviewed_name'
  | 'text_claim'
  | 'text_you'
  | 'text_negation'
  | 'text_ui_word'
  | 'text_number_word'
  | 'text_money_word'
  | 'text_phishing'
  | 'text_ownership'
  | 'text_other_name'
  | 'text_jargon';

export interface PartnerTextProblem {
  readonly code: PartnerTextCode;
  readonly message: string;
}

// ---- characters ----

/**
 * Latin letters a label may use besides A–Z and a–z: Latin-1's and Latin Extended-A's letters (accents, ß, ø, ł, …),
 * less the ones that pass for another letter or fold into two (dotless ı, kra ĸ, ŉ, Ŀ ŀ with their middle dot, long s
 * ſ, the ĳ ligature) and the signs × and ÷.
 */
const LATIN_EXTRA = /[À-ÖØ-öø-ÿĀ-ıĴ-ķĹ-ľŁ-ňŊ-ž]/u;
const EXCLUDED_LATIN = new Set(['ı', 'Ĳ', 'ĳ', 'ĸ', 'ŉ', 'Ŀ', 'ŀ', 'ſ']);
/** The punctuation a label may use: a space, a hyphen, an apostrophe (straight or curly), a comma and an ampersand. */
const PUNCTUATION = new Set([' ', '-', "'", '’', ',', '&']);

const isAsciiLetter = (c: string): boolean => /^[A-Za-z]$/u.test(c);
const isDigit = (c: string): boolean => /^[0-9]$/u.test(c);
const isLetter = (c: string): boolean => isAsciiLetter(c) || (LATIN_EXTRA.test(c) && !EXCLUDED_LATIN.has(c));
const allowedChar = (c: string): boolean => isLetter(c) || isDigit(c) || PUNCTUATION.has(c);

const hexCode = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

// ---- folding: what a word reads as ----

/** Letters with a stroke or ligatures that NFD doesn't take apart: each to the plain letters it reads as. */
const STROKE_FOLD: Readonly<Record<string, string>> = Object.freeze({ đ: 'd', ð: 'd', ħ: 'h', ł: 'l', ø: 'o', ŧ: 't', ŋ: 'n', œ: 'oe', æ: 'ae', ß: 'ss', þ: 'p' });
/** Digits that stand in for letters in a word ("Fr33", "S4fe", "V3rified", "0fficial"). */
const DIGIT_FOLD: Readonly<Record<string, string>> = Object.freeze({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' });

/** A text folded for comparing words: NFKC, accents dropped, lower case, strokes and ligatures read as letters. */
export const foldLetters = (text: string): string =>
  Array.from(text.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(), (c) => STROKE_FOLD[c] ?? c).join('');

/** The words of a folded text (runs of letters and digits), with each run of one-letter words joined ("s a f e"). */
function wordsOf(folded: string): string[] {
  const raw = folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  const out: string[] = [];
  let run = '';
  for (const w of raw) {
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

/** The words of a text twice over: as written (folded) and with digits read as the letters they imitate. */
function wordForms(text: string): { plain: string[]; leet: string[]; compact: string } {
  const folded = foldLetters(text);
  const plain = wordsOf(folded);
  const leet = wordsOf(Array.from(folded, (c) => DIGIT_FOLD[c] ?? c).join(''));
  return { plain, leet, compact: leet.join('') };
}

// ---- the lists ----

/** A word in compared form: digits read as letters, i and l read as one letter, and u and v ("1egit", "Iegit", "trvsted"). */
const cf = (w: string): string => Array.from(w, (c) => DIGIT_FOLD[c] ?? c).join('').replace(/[il]/gu, 'l').replace(/[uv]/gu, 'v');

/** A deny-list: whole words (each also matched when split in two or three: "fr-ee", "tru sted") and word stems. */
interface DenyList {
  readonly exact: ReadonlySet<string>;
  readonly stems: readonly string[];
}
const denyList = (exact: readonly string[], stems: readonly string[] = []): DenyList => ({ exact: new Set(exact.map(cf)), stems: stems.map(cf) });

/**
 * Claim words: a statement about checking, safety, cost or refunds that only Journear may make, with the usual
 * inflections. A word is refused when it starts with one of the stems or is one of the exact words; split words are
 * joined first ("s a f e", "sa-fe", "secu re"); the long stems are also refused inside a longer run of letters
 * ("Superverified"), and run-together phrases ("nofee", "costfree") anywhere. English first, with the common
 * Latin-script forms of Spanish, French, German, Portuguese, Italian and Malay.
 */
const CLAIM = denyList(
  [
    'checked', 'unchecked', 'audit', 'audits', 'audited', 'auditor', 'auditors', 'free', 'freely', 'fee', 'fees', 'risk', 'risks', 'cost', 'costs', 'costless',
    'real', 'vetted', 'tested', 'covered', 'backed', 'kyc', 'fdic', 'reviewed', 'inspected', 'nofee', 'nofees', 'nocost', 'costfree', 'feefree', 'zerofee',
    'zerofees', 'norisk', 'riskfree', 'moneyback', 'bankgrade',
  ],
  [
    'verif', 'certif', 'offici', 'ofici', 'guarant', 'garant', 'warrant', 'insur', 'approv', 'aprob', 'recommend', 'endors', 'authent', 'genuin', 'legit',
    'refund', 'reimburs', 'secur', 'segur', 'protect', 'trust', 'safe', 'sicher', 'gratis', 'gratuit', 'kostenlos', 'percuma', 'selamat', 'disahkan',
    'rasmi', 'dijamin', 'jaminan', 'harmless', 'riskless', 'feeless', 'scamfree', 'reversib', 'authoris', 'authoriz', 'validat', 'whitelist', 'licens',
    'licenc', 'regulat', 'complian', 'assur',
  ],
);
/** Stems long enough to refuse inside a longer run of letters too ("Superverified", "Officialstamp"). */
const CLAIM_LONG_STEMS = Object.freeze(['verif', 'certif', 'offici', 'guarant', 'approv', 'recommend', 'endors', 'authent', 'refund', 'reimburs'].map(cf));
/** Run-together claim phrases, refused anywhere in the letters ("Nofeestamp"). */
const CLAIM_RUNS = Object.freeze(['nofee', 'nocost', 'costfree', 'feefree', 'zerofee', 'norisk', 'riskfree', 'moneyback'].map(cf));

/**
 * The deny-lists for meaning, applied to every role: words that assert harmlessness, the
 * window's own words and instructions, amounts in words, money and loss, phishing, and ownership (which reads as the
 * user's own account). A first filter: a person may still write a misleading phrase from other words (whether a person
 * reviews each text is an open decision).
 */
const MEANING: readonly { readonly code: PartnerTextCode; readonly list: DenyList; readonly message: string }[] = [
  {
    code: 'text_negation',
    list: denyList(['no', 'not', 'nothing', 'none', 'never', 'without', 'zero', 'cannot', 'cant', 'wont', 'dont', 'doesnt', 'isnt', 'only', 'just', 'nor', 'neither', 'nobody', 'noone']),
    message: 'Don’t use “no”, “not”, “nothing”, “never”, “only” or similar: they can read as a promise that the request is harmless.',
  },
  {
    code: 'text_ui_word',
    list: denyList(['approve', 'reject', 'details', 'detail', 'confirm', 'continue', 'ok', 'okay', 'sign', 'signature', 'cancel', 'warning', 'warnings', 'alert', 'ignore', 'skip', 'tap', 'press', 'click', 'below', 'above', 'red', 'amber', 'yellow', 'green', 'read', 'button', 'proceed', 'accept', 'allow', 'yes', 'window', 'popup']),
    message: 'Don’t use the window’s own words or instructions (approve, reject, details, sign, warning, tap, below, …).',
  },
  {
    code: 'text_number_word',
    list: denyList(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions', 'billion', 'billions', 'trillion', 'dozen', 'all', 'entire', 'whole', 'half', 'double', 'triple', 'every', 'everything', 'any', 'max', 'maximum', 'minimum', 'least']),
    message: 'Don’t write amounts or quantities in words (one, hundred, all, half, every, …): amounts come from the request.',
  },
  {
    code: 'text_money_word',
    list: denyList(['cash', 'money', 'fund', 'funds', 'balance', 'balances', 'loss', 'losses', 'lose', 'losing', 'lost', 'win', 'wins', 'winner', 'winning', 'prize', 'prizes', 'reward', 'rewards', 'bonus', 'bonuses', 'airdrop', 'airdrops', 'gift', 'gifts', 'giveaway', 'jackpot', 'profit', 'profits', 'payout', 'cashback', 'earn', 'earnings']),
    message: 'Don’t use money, prize or loss words (cash, money, funds, balance, reward, bonus, prize, airdrop, gift, …).',
  },
  {
    code: 'text_phishing',
    list: denyList(['seed', 'phrase', 'password', 'passcode', 'recovery', 'privatekey', 'secret', 'mnemonic', 'sync', 'migrate', 'migration', 'restore', 'upgrade', 'support', 'admin', 'wallet', 'wallets', 'login', 'unlock']),
    message: 'Don’t use words that phishing uses (seed, phrase, password, recovery, private key, sync, migrate, restore, upgrade, support, admin, wallet, …).',
  },
  {
    code: 'text_ownership',
    list: denyList(['my', 'mine', 'own', 'self', 'personal', 'main', 'primary', 'savings']),
    message: 'Don’t use “my”, “own”, “main”, “savings” or similar: they read as the user’s own account, which only the window may say.',
  },
];

/** The first word, or two or three adjacent words joined, that the list denies, or null. */
function denied(words: readonly string[], list: DenyList): string | null {
  const hit = (w: string) => list.exact.has(w) || list.stems.some((s) => w.startsWith(s));
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const w = words.slice(i, i + n).join('');
      if (hit(w)) return w;
    }
  }
  return null;
}

/** Words that would stand in for the window's own computed text ("your account") or speak to the user. */
const YOU_WORDS = new Set(['you', 'your', 'yours', 'yourself', 'youre', 'u', 'ur']);

/** Words that start a link. */
const LINK_WORDS = new Set(['www', 'http', 'https', 'ftp', 'mailto']);

/**
 * The plain-words list (the approval window's banned technical words), copied from the brand package's list (core has
 * no runtime dependency on it); test/partner-labels-text.test.ts checks the two are the same list.
 */
export const PARTNER_JARGON: readonly string[] = Object.freeze([
  'gas', 'gasless', 'nonce', 'RPC', 'block hash', 'block height', 'vault', 'ledger', 'decoder', 'API', 'relayer', 'relay', 'sponsored', 'faucet', 'testnet',
  'mainnet', 'sandbox', 'pk_test', 'EVM', 'chain id', 'allowance', 'spender', 'signer', 'calldata', 'on chain', 'on-chain', 'smart contract', 'contract',
  'NFT', 'wei', 'yocto', 'yoctoNEAR', 'stroops', 'COOP', 'key service', 'CKD', 'MPC', 'storage balance', 'full-access key', 'function-call key',
  'access key', 'account id', 'delegate action', 'explorer', 'Not production', 'chain', 'chains', 'contracts', 'operator', 'revoke', 'revoked', 'revokes',
  'unlimited', 'signers', 'threshold', 'thresholds', 'weight', 'weights', 'burn', 'burnt', 'burned', 'burns', 'trust line', 'trust lines', 'trustline',
  'trustlines', 'smallest units', 'decimals', 'gwei', 'NFTs', 'verified', 'unverified', 'reviewed list', 'pinned', 'authorization', 'authorize',
  'authorizes', 'authorized', 'delegate', 'declined', 'log in', 'technical details', 'sponsor', 'sponsorship', 'relayed',
]);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+');
const JARGON_PATTERNS: readonly [string, RegExp][] = PARTNER_JARGON.map((w) => [w, new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, 'iu')]);

/**
 * Names a label may not use: Journear's own ("Journear", "Passport", "Hana", the name before Journear), and every
 * name on Journear's reviewed lists, which only Journear's own lines name: the protocols and contracts of the verified
 * list, the reviewed NEAR contracts, the known tokens' symbols and names, and the networks' own coins.
 */
const BRAND_WORDS = Object.freeze(['journear', 'passport']);
const NATIVE_COINS = Object.freeze(['NEAR', 'ETH', 'Ether', 'XLM', 'Lumens', 'BTC', 'Bitcoin']);

function reviewedNames(): { words: Set<string>; long: string[] } {
  const names = new Set<string>([DEMO_CHECK_IN_NAME]);
  for (const c of VERIFIED_CONTRACTS) names.add(c.name).add(c.protocol);
  for (const c of Object.values(REVIEWED_NEAR_CONTRACTS)) names.add(c.name);
  const tables = [...Object.values(KNOWN_TOKENS.evm), ...Object.values(KNOWN_TOKENS.stellar), ...Object.values(KNOWN_TOKENS.near)];
  for (const t of tables) for (const e of Object.values(t)) names.add(e.symbol).add(e.name);
  const words = new Set<string>();
  const long: string[] = [];
  for (const n of names) {
    const w = wordsOf(foldLetters(n));
    if (w.length === 1) words.add(w[0]!);
    const sk = nameSkeleton(n);
    if (sk.length >= 5) long.push(sk);
  }
  // The networks' coins as whole words only ("Ether" is inside "together").
  for (const n of NATIVE_COINS) words.add(foldLetters(n));
  return { words, long: [...new Set(long)] };
}
const REVIEWED = reviewedNames();
const OTHER = new Set(OTHER_NAMES.map(cf));

// ---- the rule ----

const problem = (code: PartnerTextCode, message: string): PartnerTextProblem => ({ code, message });

/**
 * Why `text` may not appear in a partner label as `role`, or null when it may. The same rule for every place partner
 * text appears; only the length limit depends on the role. In order: shape (a string, NFC, trimmed, single spaces,
 * length), characters (the Latin allowlist), punctuation, links, Journear's names, the reviewed lists' names, claim
 * words, words for the user, numbers and address-like runs, plain-words jargon. The first rule broken is the answer.
 */
export function partnerTextProblem(text: unknown, role: PartnerTextRole): PartnerTextProblem | null {
  if (typeof text !== 'string') return problem('text_not_string', 'This must be text.');
  if (text.length === 0) return problem('text_empty', 'This can’t be empty.');
  const max = PARTNER_TEXT_MAX[role];
  if ([...text].length > max) return problem('text_too_long', `Use at most ${max} characters.`);
  if (text.normalize('NFC') !== text) return problem('text_not_nfc', 'Write accented letters as single characters (Unicode NFC); the console does this when you type them.');
  if (text.trim() !== text || /\s{2}/u.test(text)) return problem('text_spacing', 'No spaces at the start or end, and one space between words.');
  for (const c of text) {
    if (!allowedChar(c)) {
      const shown = /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c) ? `“${c}” (${hexCode(c)})` : hexCode(c);
      return problem('text_character', `Use only Latin letters, digits, spaces and - ' ’ , &. ${shown} isn’t allowed.`);
    }
  }
  if (/\d,\d/u.test(text)) return problem('text_number', 'Don’t write numbers with a comma: amounts and numbers come from the request.');
  const chars = [...text];
  if (!isLetter(chars[0]!) && !isDigit(chars[0]!)) return problem('text_punctuation', 'Start with a letter or a digit.');
  const last = chars[chars.length - 1]!;
  if (!isLetter(last) && !isDigit(last) && last !== "'" && last !== '’') return problem('text_punctuation', 'End with a letter, a digit or an apostrophe.');
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]!;
    const b = chars[i]!;
    if (a !== ' ' && b !== ' ' && PUNCTUATION.has(a) && PUNCTUATION.has(b)) return problem('text_punctuation', 'Don’t put two punctuation marks together.');
  }
  // A hyphen joins two words' letters ("check-in"); a comma follows a word and a space; an apostrophe follows a
  // letter ("Members’", "rock’n’roll"), so it can never open a quotation.
  if (/(?:^|[^\p{L}\p{N}])-|-(?:[^\p{L}\p{N}]|$)/u.test(text)) return problem('text_punctuation', 'Use a hyphen only between two letters or digits, as in “check-in”.');
  if (/(?:^|[^\p{L}\p{N}]),|,(?! )/u.test(text)) return problem('text_punctuation', 'Put a comma right after a word, with a space after it.');
  if (/(?:^|[^\p{L}])['’]/u.test(text)) return problem('text_punctuation', 'Use an apostrophe only after a letter, as in “member’s”.');
  if (!chars.some(isLetter)) return problem('text_no_letter', 'Use at least one letter.');

  const { plain, leet, compact } = wordForms(text);
  const all = [...new Set([...plain, ...leet])];
  if (all.some((w) => LINK_WORDS.has(w))) return problem('text_link', 'No links or web addresses.');

  const skeleton = nameSkeleton(text);
  if (BRAND_WORDS.some((b) => compact.includes(b) || skeleton.includes(nameSkeleton(b))) || all.some((w) => w.startsWith('hana'))) {
    return problem('text_brand', 'Don’t use Journear’s names (Journear, Journear Passport, Passport, Hana): the window names Journear itself.');
  }
  if (all.some((w) => REVIEWED.words.has(w)) || REVIEWED.long.some((n) => skeleton.includes(n))) {
    return problem('text_reviewed_name', 'Don’t name a token, a network’s coin or a program Journear lists (USDC, NEAR, Sodax, …): the window names those itself, from the request.');
  }
  const cw = leet.map(cf);
  const ccompact = cf(compact);
  if (denied(cw, CLAIM) !== null || CLAIM_LONG_STEMS.some((s) => ccompact.includes(s)) || CLAIM_RUNS.some((s) => ccompact.includes(s))) {
    return problem('text_claim', 'Don’t say the request is checked, safe, free, guaranteed, official, refundable or similar: only Journear’s own lines may say that.');
  }
  if (cw.some((w, i) => OTHER.has(w) || (cw[i + 1] !== undefined && OTHER.has(w + cw[i + 1]!)))) {
    return problem('text_other_name', 'Don’t name a currency, a token, a wallet, an exchange, a payment brand or a bank: the window names what moves, from the request.');
  }
  if (all.some((w) => YOU_WORDS.has(w))) return problem('text_you', 'Don’t write “you” or “your”: the window says “your account” itself, only where it is true.');
  for (const m of MEANING) if (denied(cw, m.list) !== null) return problem(m.code, m.message);
  // Numbers and things that look like an address: an amount or an account written as text would sit beside the true
  // values and could be taken for one.
  if (/\d{5}/u.test(text)) return problem('text_number', 'Use at most 4 digits in a row: amounts and numbers come from the request.');
  for (const run of text.split(/[^A-Za-z0-9]+/u)) {
    if (run.length >= 8 && /\d/u.test(run) && /[A-Za-z]/u.test(run)) return problem('text_looks_like_address', 'This looks like an address or a code. Accounts and amounts are shown from the request; don’t write them.');
    if (/^0x[0-9a-f]/iu.test(run) && run.length >= 3) return problem('text_looks_like_address', 'This looks like an address. Accounts are shown from the request; don’t write them.');
    if (run.length >= 12 && /[A-Z]/u.test(run.slice(1)) && /[a-z]/u.test(run)) return problem('text_looks_like_address', 'This looks like an address or a code (mixed upper and lower case). Accounts are shown from the request.');
    if (run.length >= 16 && run === run.toUpperCase()) return problem('text_looks_like_address', 'This looks like an address or a code. Accounts are shown from the request.');
  }
  // Two or more short runs that mix capitals and digits read as a shortened address ("GBX3 KQ2M").
  if (text.split(/[^A-Za-z0-9]+/u).filter((run) => run.length >= 3 && /\d/u.test(run) && /[A-Z]/u.test(run) && !/[a-z]/u.test(run)).length >= 2) {
    return problem('text_looks_like_address', 'This looks like a shortened address. Accounts are shown from the request; don’t write them.');
  }

  const jargon = JARGON_PATTERNS.find(([, re]) => re.test(text) || re.test(leet.join(' ')));
  if (jargon) return problem('text_jargon', `Use plain words: “${jargon[0]}” is on Journear’s list of technical words users shouldn’t need to know.`);
  return null;
}
