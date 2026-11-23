// D686 (as extended by D765): an app's name may not look like a web address or hold "Hana", "Journear" or "Passport Home"
// (any case, accents, look-alike letters, letters split by spaces or punctuation); since D891 not "Passport" alone or as
// the wallet (since the founder's 2026-11-23 answer, nor as a version of it: "Passport Pro"), no imitation letters or
// badges, no claim word after sentence punctuation, no vouching word at the end.
// normalisePartnerAppName is what the API and the CLI apply when an app is named.
import { describe, expect, it } from 'vitest';
import { APP_NAME_BADGES, APP_NAME_PASSPORT_TIER_WORDS, appNameProblem, brandNameIn, hanaWordIn, journearWordIn, lookalikeLettersIn, looksLikeAddress, nameSkeleton, normalisePartnerAppName, passportNameIn, passportProblemIn, sentenceClaimIn, vouchingWordIn } from '../src/names.ts';
import { CHECK_MARKS } from '../../core/src/verified-contracts.ts';

const ch = (n: number): string => String.fromCodePoint(n);

describe('appNameProblem (D686)', () => {
  it('refuses names that look like a web address', () => {
    for (const name of ['Sign in at evil.example', 'www.evil.example', 'evil.com', 'https://evil.example', 'ftp://x', 'WWW.Wallet', 'pay.me', `evil${ch(0xff0e)}com`, `evil${ch(0x3002)}com`, 'x.Y']) {
      expect(looksLikeAddress(name), name).toBe(true);
      expect(appNameProblem(name), name).toMatch(/web address/u);
    }
  });

  it('refuses "Hana" in any case, with accents, look-alike letters or split letters', () => {
    const cyrillicEn = ch(0x041d);
    const cyrillicA = ch(0x0430);
    const greekEta = ch(0x0397);
    for (const name of ['Hana Home', 'Hana', 'hana', 'HANA wallet', `${cyrillicEn}ana Home`, `H${cyrillicA}n${cyrillicA}`, `${greekEta}ANA`, 'Hāna', 'Ｈａｎａ', 'H a n a', 'H-A-N-A', 'H.A.N.A', 'My Hana Pay', 'H4na', 'Hanami', '(Hana)']) {
      expect(hanaWordIn(name), name).toBe(true);
      expect(appNameProblem(name), name).not.toBeNull();
    }
    expect(nameSkeleton(`${cyrillicEn}ana`)).toBe('hana');
  });

  it('accepts ordinary names, including ones with "hana" inside a word and dots not before a letter', () => {
    for (const name of ['Sodax Demo', 'Test Wallet', 'Email Home App', 'Smoke B (shared only)', 'Smoke A', 'Live app', 'Renamed', 'Second', 'Fresh', 'Ethan Apps', 'Johana Pay', 'Thanatos', 'Ohana', 'Shanahan & Co', 'Dr. Wallet', 'v2.0 Wallet', 'Café', 'Wallet 3', "O'Brien & Sons", '😀 Wallet']) {
      expect(appNameProblem(name), name).toBeNull();
    }
  });

  it('refuses "Journear" (D765) in any case, with accents, look-alike letters or digits, split letters, or inside a word', () => {
    const cyrillicO = ch(0x043e);
    const cyrillicJe = ch(0x0458);
    const cyrillicIe = ch(0x0435);
    const greekUpsilon = ch(0x03c5);
    const names = [
      'Journear',
      'journear',
      'JOURNEAR',
      'J0urnear',
      'J0URN3AR',
      'journear-pay',
      'Journear Passport',
      'Pay with Journear',
      'MyJournear',
      'TheJournearApp',
      `J${cyrillicO}urnear`,
      `${cyrillicJe}ourn${cyrillicIe}ar`,
      `Jo${greekUpsilon}rnear`,
      'Jöurnéar',
      'Ｊｏｕｒｎｅａｒ',
      'J o u r n e a r',
      'J.O.U.R.N.E.A.R',
      'J-o-u-r-n-e-a-r Wallet',
      '(Journear)',
      'Jøurnear',
    ];
    for (const name of names) {
      expect(journearWordIn(name), name).toBe(true);
      expect(brandNameIn(name), name).toBe('Journear');
      // Refused either way ("J.O.U.R.N.E.A.R" also looks like an address, a mixed-alphabet word as imitation letters).
      expect(appNameProblem(name), name).not.toBeNull();
    }
    expect(nameSkeleton(`J${cyrillicO}urn${cyrillicIe}ar`)).toBe('journear');
    expect(nameSkeleton('J0URN3AR')).toBe('journear');
  });

  it('refuses "Passport Home" (the users\' own wallet page, whose mails an app must not imitate) as its own brand', () => {
    const cyrillicEr = ch(0x0440);
    const cyrillicO = ch(0x043e);
    for (const name of ['Passport Home', 'passport home', 'PASSPORT HOME', 'PassportHome', 'passport-home', 'P a s s p o r t Home', `Pass${cyrillicEr}ort H${cyrillicO}me`, 'Passp0rt Home', 'My Passport Home', 'Passport Home Rentals']) {
      expect(brandNameIn(name), name).toBe('Passport Home');
      expect(appNameProblem(name), name).toMatch(/"Passport Home"|imitate/u);
    }
    // brandNameIn names only Hana, Journear and Passport Home; "Passport" itself is D891's rule (below).
    for (const name of ['Passport', 'Passport Travel', 'passport', 'Passport Pay', 'Travel Passport', 'Passport Homes', 'Passport Homestay', 'My Passport']) {
      expect(brandNameIn(name), name).toBeNull();
    }
    for (const name of ['Passport Travel', 'Travel Passport', 'Passport Homes', 'Passport Homestay']) expect(appNameProblem(name), name).toBeNull();
  });

  it('still refuses "Hana" beside the new names; the old helper is unchanged', () => {
    for (const name of ['Hana Home', 'Hana', 'H4na', 'Hana Journear']) expect(appNameProblem(name), name).not.toBeNull();
    expect(brandNameIn('Hana Wallet')).toBe('Hana');
    expect(hanaWordIn('Journear')).toBe(false);
    expect(journearWordIn('Hana')).toBe(false);
  });

  it('accepts names that only come close: "jour", "near", "journey", split letters inside a word', () => {
    for (const name of ['Journey', 'Journal Pay', 'Near Wallet', 'Bonjour nearby', 'Jour Market', 'Sojourn Ear', 'Journeys Near', 'Adjourn']) {
      expect(journearWordIn(name), name).toBe(false);
      expect(appNameProblem(name), name).toBeNull();
    }
  });

  it('normalisePartnerAppName: the stored-form rules first, then D686', () => {
    expect(normalisePartnerAppName('  Sodax Demo  ')).toEqual({ ok: true, name: 'Sodax Demo' });
    expect(normalisePartnerAppName('Hana Home')).toMatchObject({ ok: false, problem: expect.stringMatching(/Hana/u) });
    expect(normalisePartnerAppName('Journear Pay')).toMatchObject({ ok: false, problem: expect.stringMatching(/Journear/u) });
    expect(normalisePartnerAppName('  Passport Travel ')).toEqual({ ok: true, name: 'Passport Travel' });
    expect(normalisePartnerAppName(' Passport ')).toMatchObject({ ok: false, problem: expect.stringMatching(/"Passport" on its own/u) });
    expect(normalisePartnerAppName('Acme. Verified')).toMatchObject({ ok: false, problem: expect.stringMatching(/sentence punctuation/u) });
    expect(normalisePartnerAppName('evil.com')).toMatchObject({ ok: false, problem: expect.stringMatching(/web address/u) });
    expect(normalisePartnerAppName('   ').ok).toBe(false);
    expect(normalisePartnerAppName(`Wal${ch(0x202e)}let`).ok).toBe(false);
  });
});

const refusedBy = (re: RegExp) => (name: string) => {
  const p = appNameProblem(name);
  expect(p, name).not.toBeNull();
  expect(p, name).toMatch(re);
};
const allowed = (name: string) => expect(appNameProblem(name), name).toBeNull();

/** Every name refused because it reads as Journear Passport, with the word the message names (or null for "alone"). */
const PASSPORT_REFUSED: readonly (readonly [string, string | null])[] = [
  // alone, in any spelling
  ['Passport', null], ['passport', null], ['PASSPORT', null], ['Passport!', null], ['Passport.', null], ['(Passport)', null], ['“Passport”', null],
  ['Passport 🛂', null], ['Passport™', null], ['Passport℠', null], ['Passport®', null], ['Passport©', null], ['P a s s p o r t', null], ['PASS-PORT', null],
  ['Pass Port', null], ['Pa55port', null], ['Pa$$p0rt', null], ['Pâssport', null], ['Ｐａｓｓｐｏｒｔ', null], ['𝐏𝐚𝐬𝐬𝐩𝐨𝐫𝐭', null], ['Раѕѕрогт', null],
  ['PAƧƧPORT', null], ['₱assport', null], ['Passports', null], ["Passport's", null], ['Passport’s', null], ['Passport 2', null], ['Passport X', null],
  // with up to two prefixes
  ['A Passport', null], ['An Passport', null], ['My Passport', null], ['MyPassport', null], ['Your Passport', null], ['The Passport', null], ['Our Passport', null],
  ['NEAR Passport', null], ['Wallet Passport', null], ['Official Passport', null], ['The Official Passport', null], ['My NEAR Passport', null],
  ['Your NEAR Passport', null], ['The NEAR Passport', null], ['Near Wallet Passport', null],
  // a wallet word after it, plurals too
  ['Passport Wallet', 'Wallet'], ['Passport Wallets', 'Wallets'], ['Passport-Wallet', 'Wallet'], ['PassportWallet', 'PassportWallet'], ['My Passport Wallet', 'Wallet'],
  ['Passport App', 'App'], ['Passport Apps', 'Apps'], ['Passport Account', 'Account'], ['Passport ID', 'ID'], ['Passport IDs', 'IDs'], ['Passport ID Systems', 'ID'],
  ['Passport Login', 'Login'], ['Passport Logins', 'Logins'], ['Passport Sign-in', 'Sign in'], ['Passport Sign in', 'Sign in'], ['Passport Signup', 'Signup'],
  ['Passport Sign up', 'Sign up'], ['Passport Sign-on', 'Sign on'], ['Passport Support', 'Support'], ['Passport Help', 'Help'], ['Passport Security', 'Security'],
  ['Passport Team', 'Team'], ['Passport Teams', 'Teams'], ['Passport Official', 'Official'], ['Passport Pay', 'Pay'], ['Passport Vault', 'Vault'],
  ['Passport Verify', 'Verify'], ['Passport Recovery', 'Recovery'], ['Passport Admin', 'Admin'], ['Passport Staff', 'Staff'], ['Passport Service', 'Service'],
  ['Passport Services', 'Services'], ['Passport Auth', 'Auth'], ['Passport Connect', 'Connect'], ['Passport Keys', 'Keys'], ['Passport Gas', 'Gas'],
  ['Passport Relayer', 'Relayer'], ['Passport Sponsor', 'Sponsor'], ['Passport by Acme', 'by'], ['Acme Passport App', 'App'], ['Passp0rt W4llet', 'W4llet'],
  ['Passport lD', 'lD'], ['Passport 1D', '1D'], ['Passport Wa11et', 'Wa11et'], ['Passport WaIIet', 'WaIIet'], ['Passport VVallet', 'VVallet'],
  ['Passport Adrnin', 'Adrnin'],
  // a wallet word before it
  ['Admin Passport', 'Admin'], ['Wallet by Passport', 'by'], ['Support Passport', 'Support'], ['WalletPassport', null], ['Sign in Passport', 'Sign in'],
  // a claim word next to it
  ['Passport Verified', 'Verified'], ['Passport Secure', 'Secure'], ['Passport Safe', 'Safe'], ['Verified Passport', 'Verified'], ['Secure Passport', 'Secure'],
  ['Trusted Passport', 'Trusted'], ['Passport Free', 'Free'], ['VerifiedPassport', 'VerifiedPassport'], ['Passport Certified', 'Certified'],
  // a tier or form word after or before it (founder 2026-11-23), plurals, look-alikes, split and joined letters too
  ['Passport Plus', 'Plus'], ['Passport Pro', 'Pro'], ['Passport One', 'One'], ['Passport Go', 'Go'], ['Passport Lite', 'Lite'], ['Passport Mini', 'Mini'],
  ['Passport Max', 'Max'], ['Passport Ultra', 'Ultra'], ['Passport Prime', 'Prime'], ['Passport Premium', 'Premium'], ['Passport Basic', 'Basic'],
  ['Passport Classic', 'Classic'], ['Passport Beta', 'Beta'], ['Passport Next', 'Next'], ['Passport Card', 'Card'], ['Passport Online', 'Online'],
  ['Passport Mobile', 'Mobile'], ['Passport Web', 'Web'], ['Passport Cloud', 'Cloud'], ['Passport Desktop', 'Desktop'], ['Passport Extension', 'Extension'],
  ['Passport Cards', 'Cards'], ['Passport Pros', 'Pros'], ['Passport Pluses', 'Pluses'], ['Passport PRO', 'PRO'], ['passport pro', 'pro'], ['Passport-Pro', 'Pro'],
  ['Passport Pr0', 'Pr0'], ['Passport 0ne', '0ne'], ['Passport L1te', 'L1te'], ['Passport Ｐｒｏ', 'Pro'], ['Passport P r o', 'Pro'], ['Passport On line', 'On line'],
  ['Pa55port Plus', 'Plus'], ['My Passport Pro', 'Pro'], ['The Passport Premium', 'Premium'], ['Passport Pro Max', 'Pro'], ['Passport Card Services', 'Card'],
  ['Acme Passport Plus', 'Plus'], ['Premium Passport', 'Premium'], ['Mobile Passport', 'Mobile'], ['Pro Passport', 'Pro'], ['One Passport', 'One'],
  ['Cloud Passport', 'Cloud'], ['Next Passport', 'Next'], ['On Line Passport', 'On Line'], ['PassportPlus', 'PassportPlus'], ['PassportCard', 'PassportCard'],
  ['PassportPro', 'PassportPro'], ['OnePassport', 'OnePassport'], ['MobilePassport', 'MobilePassport'], ['Passport+', null], ['Passport X', null],
  ['Passport Free', 'Free'],
  // the start of another name
  ['Passport, by Acme', null], ['Passport from Acme', null], ['Passport | Acme', null], ['Passport (Acme)', null], ['Passport - Acme', null], ['Passport – Acme', null],
  ['Passport: Acme', null], ['Passport / Acme', null], ['Passport · Acme', null], ['Passport of Acme', null], ['The Passport | Acme', null],
];

const PASSPORT_ALLOWED: readonly string[] = [
  'Passport Photos Co', 'Passport Travel', 'Travel Passport', 'Passport Parking', 'Passport Health', 'Passport Brewing', 'Passport Labs', 'Passport Inc',
  'Passport Network', 'Passport Protocol', 'Passport Homes', 'Passport Homestay', 'Passports & Visas Ltd', 'Passport Identity Checks', 'Passport Bytes',
  'Passport Byron Bay', 'Passport Payroll', 'Passport 2 Asia', 'Near Passport Office Cafe', 'Pet Passport', 'Culture Passport', 'Gitcoin Passport',
  'Human Passport', 'Holonym Passport', 'World ID Passport', 'Galxe Passport', 'Immutable Passport', 'Passport XYZ', 'WD My Passport', 'Passport Co',
  'Passport-Health', 'Passport & Co', 'Acme Passport', 'Passport Photo Booth', 'Passport Rewards Club',
  // a tier word only as part of a longer word, or not next to "Passport" (founder 2026-11-23's rule is word for word)
  'Passport Protocol', 'Passport Proton', 'Passport Golf', 'Passport Webster', 'Passport Maximus', 'Passport Oneida', 'Passport Cardiff', 'Passport Nexus',
  'Passport Classical Tours', 'Passport Photo Online', 'Passport Photos Online Co', 'Passport Express', 'Passport 365', 'Passport Plumbing', 'Passport Prost',
  'Passport Webb', 'Passport Gold', 'Passport Kids', 'Acme Pro Shop Passport Photos', 'Passport Office',
  'Proton Passport', 'Webster Passport', 'Golden Passport', 'Passport 2 Go Travel', 'WD My Passport',
];

describe('D891: "Passport" as the wallet', () => {
  it.each(PASSPORT_REFUSED)('refuses %j', (name, word) => {
    expect(passportNameIn(name), name).toBe(true);
    const p = appNameProblem(name);
    expect(p, name).not.toBeNull();
    if (word !== null) expect(p, name).toContain(`"${word}"`);
  });
  it.each(PASSPORT_ALLOWED)('keeps %j', (name) => {
    expect(passportProblemIn(name), name).toBeNull();
    allowed(name);
  });
  it('the messages name what triggered them and say what is fine', () => {
    expect(appNameProblem('Passport ID Systems')).toBe('The name must not have "ID" right after "Passport": it reads as part of the wallet. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    expect(appNameProblem('My NEAR Passport')).toMatch(/^The name must not be "Passport" on its own or with only "My NEAR" around it/u);
    expect(appNameProblem('Passport (Acme)')).toMatch(/^The name must not start with "Passport" followed by another name/u);
    expect(appNameProblem('Verified Passport')).toMatch(/^The name must not put "Verified" next to "Passport"/u);
  });
  it('a tier word is refused on either side, run together, with a plural, in any spelling (founder 2026-11-23)', () => {
    for (const word of APP_NAME_PASSPORT_TIER_WORDS) {
      const w = word[0]!.toUpperCase() + word.slice(1);
      for (const name of [`Passport ${w}`, `${w} Passport`, `Passport${w}`, `${w}Passport`, `Passport ${w}s`, `Passport ${w.toUpperCase()}`, `My Passport ${w}`]) {
        expect(passportProblemIn(name)?.kind, name).toMatch(/^tier_/u);
        expect(appNameProblem(name), name).toMatch(/version of the wallet/u);
      }
      // A tier word away from "Passport", or with the partner's own words between, is fine.
      for (const name of [`Acme ${w}`, `${w} Acme`, `Passport Acme ${w}`, `${w} Acme Passport`]) allowed(name);
    }
  });
  it('the tier messages name the word, the side, and say what is fine', () => {
    expect(appNameProblem('Passport Pro')).toBe('The name must not have "Pro" right after "Passport": it reads as a version of the wallet, as "Passport Pro" would. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    expect(appNameProblem('Mobile Passport')).toBe('The name must not have "Mobile" right before "Passport": it reads as a version of the wallet, as "Premium Passport" would. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    expect(appNameProblem('PassportPlus')).toBe('The name must not be "PassportPlus": "Passport" joined with a word like "Pro", "Plus" or "Online" reads as a version of the wallet. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    // A wallet word wins over a tier word when both are there; "Free" stays the claim rule's.
    expect(passportProblemIn('Passport Wallet Pro')).toEqual({ kind: 'after', word: 'Wallet' });
    expect(passportProblemIn('Passport Free')).toEqual({ kind: 'claim', word: 'Free' });
  });
  it('the older brand rules still come first', () => {
    for (const name of ['Journear Passport', 'Passport by Journear']) expect(appNameProblem(name), name).toMatch(/"Journear"/u);
    expect(appNameProblem('Passport Home')).toMatch(/"Passport Home"/u);
  });
  it('no allowed name compares equal to a refused one, word for word (the property the rule rests on)', () => {
    const refusedKeys = new Set(PASSPORT_REFUSED.map(([n]) => nameSkeleton(n).replace(/[^\p{L}\p{N}]+/gu, '')));
    for (const name of PASSPORT_ALLOWED) expect(refusedKeys.has(nameSkeleton(name).replace(/[^\p{L}\p{N}]+/gu, '')), name).toBe(false);
  });
});

describe('D891: letters that only imitate others, and badges', () => {
  const imitations = [
    'ꓑꓮꓢꓢꓑꓳꓣꓔ', 'ꓑassport', 'ᏢᎪՏՏᏢᎾᎡᎢ', 'Ꮲassport', 'ᴘassport', 'ᴘᴀssᴘᴏʀᴛ', 'ⲣassport', 'Passpⲟrt', 'Passpoɾt', 'ϷΑЅЅРОRТ', 'ᴊᴏᴜʀɴᴇᴀʀ', 'Passport Іd',
    'Passport ΙD', 'Passport Ԝallet', 'Acme. Verіfied', 'Acme. Ѵerified', 'Acme. ᏚAFE', 'Acme. ꜰʀᴇᴇ', `P${String.fromCharCode(0x0430)}ssport`, 'Hаna Pay', 'Acme ꞉ Safe',
  ];
  it.each(imitations)('refuses %j', (name) => {
    expect(lookalikeLettersIn(name), name).not.toBeNull();
    // A look-alike of Journear's own names is refused as that name (the clearer message); the rest as imitation letters.
    refusedBy(/imitate|"Journear"|"Hana"/u)(name);
  });
  it('folds the rest as before ("Joumear", whole-word Cyrillic look-alikes) and keeps whole words in another script', () => {
    refusedBy(/"Journear"/u)('Joumear');
    refusedBy(/"Journear"/u)('JOUMEAR Pay');
    for (const name of ['Москва Shop', 'Αθήνα Travel', '東京 Market', 'LINE株式会社', 'Café Ɛkwan', 'Ołówek', 'Şişli Cafe', 'Țara Mea', 'Đà Nẵng Tours']) allowed(name);
  });
  it('refuses check marks, shields, locks and medals; core’s CHECK_MARKS are all refused', () => {
    for (const name of ['Acme ✅', 'Acme ✓', '✓ Acme', 'Acme ✔', 'Acme ☑', 'Acme 🛡', 'Acme 🔒', 'Acme 🔐', 'Acme 🏅', 'Acme 💯', 'Acme 👍']) refusedBy(/check mark/u)(name);
    for (const c of CHECK_MARKS.source.replace(/^\[|\]$/gu, '').match(/\\u\{?[0-9a-fA-F]+\}?/gu) ?? []) {
      const cp = Number.parseInt(c.replace(/\\u\{?|\}/gu, ''), 16);
      expect(APP_NAME_BADGES.test(`Acme ${String.fromCodePoint(cp)}`), c).toBe(true);
    }
    for (const name of ['Acme™', 'Acme®', 'Sodax · Stellar 🌸', '😀 Wallet']) allowed(name);
  });
});

describe('D891: a claim word after sentence punctuation', () => {
  const refused: [string, string][] = [
    ['Acme. Verified', 'Verified'], ['Acme. Checked', 'Checked'], ['Acme: safe', 'safe'], ['Acme! No fees', 'fees'], ['Acme? Free', 'Free'],
    ['Acme; official', 'official'], ['Acme – risk free', 'risk'], ['Acme — guaranteed', 'guaranteed'], ['Acme - Secure', 'Secure'], ['Acme… Trusted', 'Trusted'],
    ['Acme. Approved by banks', 'Approved'], ['Acme. Recommended', 'Recommended'], ['Acme. Refund on failure', 'Refund'], ['Acme. Insured', 'Insured'],
    ['Acme. V3rified', 'V3rified'], ['Acme. Ver1fied', 'Ver1fied'], ['Acme. S a f e', 'Safe'], ['Acme. S4FE', 'S4FE'], ['Acme. Ｓａｆｅ', 'Safe'],
    ['Acme！ Safe', 'Safe'], ['Acme: no risk', 'risk'], ['Acme. Verifying', 'Verifying'], ['Acme. Verifiable', 'Verifiable'], ['Acme. Certify', 'Certify'],
    ['Acme. Certification', 'Certification'], ['Acme. Audits', 'Audits'], ['Acme. Endorse', 'Endorse'], ['Acme. Trusts', 'Trusts'], ['Acme. Secures', 'Secures'],
    ['Acme. Protects', 'Protects'], ['Acme. Approving', 'Approving'], ['Acme. Insures', 'Insures'], ['Acme. Officials', 'Officials'],
    ['Acme. Authenticated', 'Authenticated'], ['Acme. Riskfree', 'Riskfree'], ['Acme. Authorized', 'Authorized'], ['Acme. Licensed', 'Licensed'],
    ['Acme. Regulated', 'Regulated'], ['Acme. Vetted', 'Vetted'], ['Acme. Reviewed', 'Reviewed'], ['Acme. Warranted', 'Warranted'], ['Acme. Sponsored', 'Sponsored'],
    ['Acme. No charge', 'No charge'], ['Acme. Costs nothing', 'Costs'], ['Acme. Sa fe', 'Sa fe'], ['Acme‽ Safe', 'Safe'], ['Acme ‐ Safe', 'Safe'],
    ['Acme − Safe', 'Safe'], ['Acme ― Safe', 'Safe'], ['Acme۔ Safe', 'Safe'], ['Acme। Safe', 'Safe'], ['Acme። Safe', 'Safe'], ['Acme ꓸ Safe', 'Safe'],
    ['Acme ∶ Safe', 'Safe'], ['Acme ⸱ Safe', 'Safe'], ['Acme ⁏ Safe', 'Safe'], ['Acme。 Safe', 'Safe'],
  ];
  it.each(refused)('refuses %j', (name, word) => {
    if (lookalikeLettersIn(name) !== null) return refusedBy(/imitate/u)(name);
    expect(sentenceClaimIn(name), name).toBe(word);
    refusedBy(/after sentence punctuation/u)(name);
  });
  it('only the words after the first break count; abbreviations are not a break; whole words only', () => {
    for (const name of [
      'Dr. Trust', 'Mr. Safe', 'St. Trusted', 'Trust: Crypto & Bitcoin Wallet', 'Safe{Wallet}: Multisig', 'Safe - Multisig wallet', 'Free Now – Taxi & more',
      'Garena Free Fire: Winterlands', 'Safe Haven: Mental Health', 'Allstate: Insurance Quotes', 'Free! Magazine', 'Stay Safe!', 'Safe. Acme', 'Acme Safe.',
      'Dr. Coffee', 'St. Safeway', 'Wait. Checkout', 'Mr. Freeman', 'Acme. Coffee', 'Safe Wallet', 'Trust Wallet', 'Free Now', 'Secure Pay', 'Risk-Free Trading',
      'SafeMoon', 'Acme Safe Swaps',
    ]) {
      expect(sentenceClaimIn(name), name).toBeNull();
    }
    expect(appNameProblem('Allstate: Insurance Quotes')).toBeNull();
    expect(appNameProblem('Trust: Crypto & Bitcoin Wallet')).toBeNull();
  });
});

describe('D891: a vouching word at the end or after a separator', () => {
  it('refuses', () => {
    for (const [name, word] of [['Acme Official', 'Official'], ['Acme Verified', 'Verified'], ['Acme (Official)', 'Official'], ['Acme | Certified', 'Certified'], ['Acme, Approved Shop', 'Approved'], ['Acme · Genuine', 'Genuine'], ['Acme Legit', 'Legit'], ['Acme Audited', 'Audited'], ['Acme Endorsed', 'Endorsed'], ['Acme Authentic', 'Authentic'], ['Acme Checked', 'Checked'], ['Acme / Verified Store', 'Verified']] as const) {
      expect(vouchingWordIn(name), name).toBe(word);
      refusedBy(/reads as an endorsement/u)(name);
    }
  });
  it('keeps them at the start of a name, and safe, free, secure and trust anywhere', () => {
    for (const name of ['Verified Voting', 'Official Charts Company', 'Trusted Shops', 'Guaranteed Rate', 'Secure Trust Bank', 'Free People', 'Safeway', 'Safe{Wallet}', 'Acme Safe', 'Acme Free', 'Acme Secure', 'Acme Trust', 'Genuine Parts Company', 'Certified Angus Beef']) allowed(name);
  });
});

describe('D891: awkward real-world names', () => {
  it('keeps them', () => {
    for (const name of [
      'Yahoo!', 'Yahoo! Japan', 'Yum! Brands', 'Jeopardy!', 'Panic! at the Disco', 'Westward Ho!', 'Guess?', 'Who? Weekly', 'Dr. Martens', 'Dr. Oetker', 'Mr. Porter',
      'Mrs. Fields', 'St. Ives', 'Wait. What', 'Re: Store', 'E*TRADE', 'Toys R Us', 'Toys"R"Us', 'AT&T', 'H&M', "Ben & Jerry's", "McDonald's", "L'Oréal", 'Häagen-Dazs',
      'Coca-Cola', '7-Eleven', '1-800-Flowers', 'Société Générale', 'Moët Hennessy', 'Cirque du Soleil', 'Safe{Wallet}', 'Under Armour', 'Procter & Gamble',
      'Stamp Trail', 'E2E Partner', 'Sodax Demo', 'Smoke B (shared only)', 'Test Wallet', 'Email Home App', 'Dr. Wallet', 'v2.0 Wallet', 'Wallet 3', "O'Brien & Sons",
      'Free Now – Taxi & more', 'Garena Free Fire: Winterlands', 'Safe Haven: Mental Health', 'Allstate: Insurance Quotes', 'Free! Magazine', 'Stay Safe!',
      'Trust: Crypto & Bitcoin Wallet', 'Safe{Wallet}: Multisig', 'Safe - Multisig wallet',
    ]) {
      allowed(name);
    }
  });
  it('the ones still refused, each for a stated reason', () => {
    for (const name of ['A.P.C.', 'J.Crew', 'U.S. Bank', 'Booking.com']) refusedBy(/web address/u)(name);
    refusedBy(/"Journear"/u)('Journear demo');
    // Rare but real shapes the punctuation or vouching rules refuse; they register without the punctuation or the word.
    for (const name of ['Yahoo! Finance Free', 'Acme: Official Store', 'GM Genuine', 'Too Legit']) expect(appNameProblem(name), name).not.toBeNull();
  });
});

describe('D891: no rule is slow (no catastrophic backtracking)', () => {
  it('64-character adversarial names take under 20 ms each', () => {
    const inputs = [
      'P'.repeat(64), 'p a s s p o r t '.repeat(4), 'Passport '.repeat(7), 'P-a-s-s-p-o-r-t-'.repeat(4), `${'a '.repeat(31)}!`, '. '.repeat(32), `Passport${' '.repeat(55)}|`,
      'J o u r n e a r '.repeat(4), `${'the '.repeat(15)}Passport`, 'Wallet Passport '.repeat(4), '.-'.repeat(32), `${'x'.repeat(63)}.`, 'Sa fe '.repeat(10),
    ];
    for (const name of inputs) {
      const t = performance.now();
      appNameProblem(name.slice(0, 64));
      expect(performance.now() - t, name).toBeLessThan(20);
    }
  });
});
