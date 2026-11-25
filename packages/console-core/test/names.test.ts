// D686 (as extended by D765): an app's name may not look like a web address or hold "Hana", "Journear" or "Passport Home"
// (any case, accents, look-alike letters, letters split by spaces or punctuation); since D891 not "Passport" alone or as
// the wallet (since the Tech Lead's 2026-11-23 answers, nor as an edition of it: "Passport Pro"), no imitation letters or
// badges, no claim word after sentence punctuation, no vouching word at the end.
// normalisePartnerAppName is what the API and the CLI apply when an app is named.
import { describe, expect, it } from 'vitest';
import { APP_NAME_BADGES, APP_NAME_PASSPORT_TIER_WORDS, APP_NAME_PASSPORT_TIER_WORDS_BEFORE, APP_NAME_PASSPORT_TIER_WORDS_BEFORE_AT_END, appNameProblem, brandNameIn, hanaWordIn, journearWordIn, lookalikeLettersIn, looksLikeAddress, nameSkeleton, normalisePartnerAppName, passportNameIn, passportProblemIn, sentenceClaimIn, vouchingWordIn } from '../src/names.ts';
import { CHECK_MARKS } from '../../core/src/verified-contracts.ts';
import { appNameLookalikeKey, namesLookAlike } from '../src/names.ts';
import { PLATFORM_OPS_LIMITS, platformAddOriginsBody, platformCreateAppBody, platformEmptyBody, platformRemoveOriginsBody, platformSuspendBody } from '../src/platform-ops.ts';

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
    // After PR 129's review: a version number, a whole number or a trade mark between the two words too.
    for (const name of ['Passport Home', 'passport home', 'PASSPORT HOME', 'PassportHome', 'passport-home', 'P a s s p o r t Home', `Pass${cyrillicEr}ort H${cyrillicO}me`, 'Passp0rt Home', 'My Passport Home', 'Passport Home Rentals', 'Passport 2.0 Home', 'Passport v2 Home', 'Passport 2 Home', 'Passport 365 Home', 'Passport™ Home', 'Passport (TM) Home']) {
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
  // an edition word after it (the Tech Lead's decision 2026-11-23, narrowed the same day), "Pros", look-alikes, split and
  // joined letters too; six of them before it; run together
  ['Passport Plus', 'Plus'], ['Passport Pro', 'Pro'], ['Passport One', 'One'], ['Passport Lite', 'Lite'], ['Passport Mini', 'Mini'], ['Passport Max', 'Max'],
  ['Passport Ultra', 'Ultra'], ['Passport Prime', 'Prime'], ['Passport Premium', 'Premium'], ['Passport Basic', 'Basic'], ['Passport Classic', 'Classic'],
  ['Passport Beta', 'Beta'], ['Passport Pros', 'Pros'], ['Passport PRO', 'PRO'], ['passport pro', 'pro'], ['Passport-Pro', 'Pro'], ['Passport Pr0', 'Pr0'],
  ['Passport 0ne', '0ne'], ['Passport L1te', 'L1te'], ['Passport Ｐｒｏ', 'Pro'], ['Passport P r o', 'Pro'], ['Pa55port Plus', 'Plus'], ['My Passport Pro', 'Pro'],
  ['The Passport Premium', 'Premium'], ['Passport Pro Max', 'Pro'], ['My Passport Plus', 'Plus'], ['My Passport Ultra', 'Ultra'], ['My NEAR Passport Lite', 'Lite'],
  ['Premium Passport', 'Premium'], ['Pro Passport', 'Pro'], ['Plus Passport', 'Plus'], ['Lite Passport', 'Lite'], ['Ultra Passport', 'Ultra'], ['Beta Passport', 'Beta'],
  ['My Pro Passport', 'Pro'], ['The Premium Passport', 'Premium'],
  ['PassportPlus', 'PassportPlus'], ['PassportPro', 'PassportPro'], ['PassportOne', 'PassportOne'], ['ProPassport', 'ProPassport'], ['PremiumPassport', 'PremiumPassport'],
  ['My PassportPro', 'PassportPro'],
  // a trade mark glued on (NFKC "TM"), a one-character word between, digits after (the review of PR 117)
  ['Passport Pro™', 'Pro'], ['Passport PRO™', 'PRO'], ['Passport Pro℠', 'Pro'], ['PassportPro™', 'PassportPro'], ['Passport Plus™', 'Plus'], ['Passport One™', 'One'],
  ['Passport Pro TM', 'Pro'], ['Passport X Pro', 'Pro'], ['Passport 2 Pro', 'Pro'], ['My Passport X Pro', 'Pro'], ['Passport X Plus', 'Plus'], ['Passport Pro2', 'Pro2'],
  ['Passport Plus1', 'Plus1'], ['Passport Pro X', 'Pro'],
  // a wallet word past edition words or one character, or with a trade mark
  ['Passport Pro App', 'App'], ['Passport Plus Wallet', 'Wallet'], ['Passport One Login', 'Login'], ['Passport X Wallet', 'Wallet'], ['Passport Wallet™', 'Wallet'],
  ['PassportWallet™', 'PassportWallet'], ['Acme Passport Pro App', 'App'],
  ['Passport+', null], ['Passport X', null], ['Passport Free', 'Free'],
  // D903 (the Tech Lead 2026-11-24): Elite, Platinum and Deluxe as edition words; before "Passport" only when the name ends
  // there; a trade mark glued on "Passport" no longer hides the word next to it
  ['Passport Elite', 'Elite'], ['Passport Platinum', 'Platinum'], ['Passport Deluxe', 'Deluxe'], ['My Passport Elite', 'Elite'], ['Passport ELITE', 'ELITE'],
  ['Passport Platinum™', 'Platinum'], ['Passport Pro Platinum', 'Pro'], ['Passport Deluxe Max', 'Deluxe'], ['PassportElite', 'PassportElite'],
  ['PassportPlatinum', 'PassportPlatinum'], ['Passport D3luxe', 'D3luxe'], ['Passport El1te', 'El1te'], ['Pa55port Platinum', 'Platinum'],
  ['Elite Passport', 'Elite'], ['Platinum Passport', 'Platinum'], ['Deluxe Passport', 'Deluxe'], ['My Deluxe Passport', 'Deluxe'], ['The Platinum Passport', 'Platinum'],
  ['Elite Passport™', 'Elite'], ['ElitePassport', 'ElitePassport'], ['DeluxePassport', 'DeluxePassport'], ['Passport Elite Wallet', 'Wallet'],
  ['Passport™ Wallet', 'Wallet'], ['Passport™ Pro', 'Pro'], ['Verified Passport™', 'Verified'], ['Premium Passport™', 'Premium'],
  // D903: a version number with "Passport" and nothing of the partner's own
  ['Passport 2.0', '2.0'], ['Passport V2', 'V2'], ['Passport v2', 'v2'], ['Passport v2.0', 'v2.0'], ['Passport V 2', 'V 2'], ['Passport V10', 'V10'],
  ['Passport 3.1.4', '3.1.4'], ['Passport 10.0', '10.0'], ['Passport Version 2', 'Version 2'], ['Passport ver. 3', 'ver. 3'], ['Passport Ver2', 'Ver2'],
  ['PassportV2', 'V2'], ['Passport2.0', '2.0'], ['PassportV2.0', 'V2.0'], ['My Passport V2', 'V2'], ['The Passport 2.0', '2.0'], ['Passports 2.0', '2.0'],
  ['Passport 2.0™', '2.0'], ['Passport V2 TM', 'V2'], ['Passport ２.０', '2.0'], ['Passport Ｖ２', 'V2'], ['Passport-V2', 'V2'], ['Passport_v2', 'v2'],
  ['V2 Passport', 'V2'], ['2.0 Passport', '2.0'], ['Passport X 2.0', '2.0'], ['Passport (v2)', null], ['Passport [2.0]', null],
  ['Passport Pro 2.0', 'Pro'], ['Passport 2.0 Pro', 'Pro'], ['Passport V2 Wallet', 'Wallet'], ['Passport 2.0 App', 'App'], ['Passport 2.0 | Acme', null],
  // after PR 129's review: trade marks as signs, spaced, bracketed, as letters, glued; the version rule's gaps
  ['Passport ™ Wallet', 'Wallet'], ['Passport TM Wallet', 'Wallet'], ['Passport ℠ Wallet', 'Wallet'], ['Passport TM Pro', 'Pro'], ['Passport ™ Pro', 'Pro'],
  ['Passport™Wallet', 'PassportTMWallet'], ['Passport™V2', 'V2'], ['Passport™2.0', '2.0'], ['Passport® Wallet', 'Wallet'], ['Passport (R) Wallet', 'Wallet'],
  ['Passport (TM) Wallet', 'Wallet'], ['Passport(SM) Pro', 'Pro'], ['Passport © Wallet', 'Wallet'], ['PassportTMWallet', 'PassportTMWallet'], ['Passport SM Elite', 'Elite'],
  ['Passport v  2', 'v  2'], ['Passport V.2', 'V.2'], ['Passport v. 2', 'v. 2'], ['Pa55portV2', 'V2'], ['Pa55port2.0', '2.0'], ['Pass portV2', 'V2'], ['Passp0rtV2', 'V2'],
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
  // ordinary business words, allowed again when the Tech Lead narrowed the rule (2026-11-23), real names among them
  'Passport Card', 'PassportCard', 'PassportCard Nomads', 'Passport Online', 'US Passport Online', 'Mobile Passport', 'Mobile Passport Control', 'Passport Mobile',
  'Passport Next Door', 'Passport Goes Global', 'Passport Go', 'Passport Web', 'Passport Cloud', 'Passport Desktop', 'Passport Extension', 'Cloud Passport',
  'Next Passport', 'Passport Next', 'Passport Cards',
  // an edition word's plural that is an ordinary word; one of the six not before "Passport"
  'Passport Basics', 'Passport Classics', 'Passport Minis', 'Passport Primes', 'Passport Ultras', 'Passport Ones', 'Passport Maxes', 'Passport Premiums',
  'Passport Betas', 'Passport Pluses', 'Passport Lites', 'One Passport', 'OnePassport', 'Prime Passport', 'Classic Passport', 'Basic Passport', 'Mini Passport',
  'Max Passport', 'Kids Mini Passport',
  // a brand of the partner's own before it, or words of their own after it (the review of PR 117)
  'Capital One Passport', 'HBO Max Passport', 'Amazon Prime Passport', 'Disney Plus Passport', 'Xbox One Passport', 'Acme Passport Plus', 'WD My Passport Ultra',
  'Mobile Passport Plus', 'Acme ProPassport', 'Passport Mini Golf', 'Passport Max Fitness', 'Passport Classic Cars', 'Passport One Travel', 'Passport Basic Training',
  'Passport Prime Rib', 'PassportPro Tools', 'Passport Keyes', 'Passport Boxes',
  // open for the Tech Lead, not built: Roman numerals and other edition words
  'Passport II', 'Passport III', 'Passport Ultimate', 'Passport Enterprise', 'Passport Uno', 'Passport Gold',
  // D903: Elite, Platinum and Deluxe with a brand of the partner's own, words after them, or as part of a longer word;
  // before "Passport" with words after it
  'Acme Passport Elite', 'WD My Passport Platinum', 'Passport Elite Travel', 'Passport Platinum Club', 'Passport Deluxe Covers', 'Elite Passport Travel',
  'Elite Passport Photos', 'Deluxe Passport Covers', 'Platinum Passport Club', 'Acme Elite Passport', 'Thailand Elite Passport', 'Passport Elites',
  'Passport Elitist', 'Passport Platinums', 'Passport Deluxes', 'Passport Delux', 'PassportElite Tours', 'Acme PlatinumPassport', 'Platinum Acme Passport',
  'Passport Lite Elite Club',
  // D903: a version number with a brand of the partner's own or words after it; a plain number; a number with letters
  'Acme Passport 2.0', 'Acme Passport V2', 'Gitcoin Passport 2.0', 'Human Passport v2', 'WD My Passport V2', 'Passport V2 Travel', 'Passport 2.0 Summit',
  'Web 3.0 Passport', 'Passport 24', 'Passport 10', 'Passport 360', 'Passport 2026', 'Passport 4x4', 'Passport 3D', 'Passport 1.5L', 'Passport MV2',
  'Passport Dev2', 'Passport Vee', 'Passport Volume 2 Books', 'Passport 2 Asia', 'Passport™ Travel', 'Gitcoin Passport™', 'Acme Passport™', 'v2.0 Wallet',
  // after PR 129's review: letters "tm" or "sm" inside a word, a brand "SM", a trade mark before words of the partner's
  // own
  'Passport Tmall', 'Passport Smart', 'PassportSmart', 'PassportTmall', 'SM Passport', 'SM Entertainment Passport', 'Passport TM Travel', 'Passport SMS',
  'Passport® Travel', 'Acme® Passport',
  // an edition word only as part of a longer word, or not next to "Passport" (the rule is word for word)
  'Passport Protocol', 'Passport Proton', 'Passport Golf', 'Passport Webster', 'Passport Maximus', 'Passport Oneida', 'Passport Cardiff', 'Passport Nexus',
  'Passport Classical Tours', 'Passport Photo Online', 'Passport Photos Online Co', 'Passport Express', 'Passport 365', 'Passport Plumbing', 'Passport Prost',
  'Passport Webb', 'Passport Gold', 'Passport Kids', 'Acme Pro Shop Passport Photos', 'Passport Office', 'Passport Promise', 'Passport Plush Toys',
  'Proton Passport', 'Webster Passport', 'Golden Passport', 'Passport 2 Go Travel', 'WD My Passport', 'Premiumpass Passport',
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
  it('an edition word is refused right after "Passport" or joined to it; six of them before it too (the Tech Lead 2026-11-23, narrowed)', () => {
    expect([...APP_NAME_PASSPORT_TIER_WORDS]).toEqual(['plus', 'pro', 'premium', 'prime', 'max', 'ultra', 'lite', 'mini', 'basic', 'classic', 'one', 'beta', 'elite', 'platinum', 'deluxe']);
    expect([...APP_NAME_PASSPORT_TIER_WORDS_BEFORE]).toEqual(['premium', 'pro', 'plus', 'lite', 'ultra', 'beta']);
    expect([...APP_NAME_PASSPORT_TIER_WORDS_BEFORE_AT_END]).toEqual(['elite', 'platinum', 'deluxe']);
    for (const word of APP_NAME_PASSPORT_TIER_WORDS) {
      const w = word[0]!.toUpperCase() + word.slice(1);
      for (const name of [`Passport ${w}`, `Passport${w}`, `Passport ${w.toUpperCase()}`, `My Passport ${w}`, `Passport ${w}™`, `Passport X ${w}`, `Passport ${w}2`]) {
        expect(passportProblemIn(name)?.kind, name).toMatch(/^tier_/u);
        expect(appNameProblem(name), name).toMatch(/version of the wallet/u);
      }
      const atEnd = APP_NAME_PASSPORT_TIER_WORDS_BEFORE_AT_END.includes(word);
      const before = APP_NAME_PASSPORT_TIER_WORDS_BEFORE.includes(word) || atEnd;
      for (const [name, kind] of [[`${w} Passport`, 'tier_before'], [`My ${w} Passport`, 'tier_before'], [`${w}Passport`, 'tier_joined']] as const) {
        expect(passportProblemIn(name)?.kind ?? null, name).toBe(before ? kind : null);
      }
      // D903: Elite, Platinum and Deluxe before it only when the name ends there; the six others with words after too.
      for (const name of [`${w} Passport Travel`, `${w}Passport Travel`]) expect(passportProblemIn(name)?.kind ?? null, name).toBe(before && !atEnd ? (name.includes(' Passport') ? 'tier_before' : 'tier_joined') : null);
      // Away from "Passport", with the partner's own words between, a brand in front or words after, it is fine; no
      // plural but "Pros" counts.
      for (const name of [`Acme ${w}`, `${w} Acme`, `Passport Acme ${w}`, `${w} Acme Passport`, `Acme Passport ${w}`, `Passport ${w} Acme`, `Acme ${w} Passport`, `Passport${w} Acme`]) allowed(name);
      // A wallet word past it is the wallet rule's.
      expect(passportProblemIn(`Passport ${w} Wallet`), w).toEqual({ kind: 'after', word: 'Wallet' });
      if (word !== 'pro') expect(passportProblemIn(`Passport ${w}s`), `Passport ${w}s`).toBeNull();
    }
    // A longer real word is never cut down to an edition word ("goes" was read as a plural of "go").
    for (const name of ['Passport Goes Global', 'Passport Onesie', 'Passport Prose', 'Passport Maxed', 'Passport Pluses', 'Passport Keyes', 'Passport Boxes']) expect(passportProblemIn(name), name).toBeNull();
    // The plural rule the wallet words share: s, or es after s, x, z, ch or sh only.
    for (const name of ['Passport Keys', 'Passport Services', 'Passport IDs', 'Passport Wallets']) expect(passportProblemIn(name)?.kind, name).toBe('after');
  });
  it('the edition messages name the word, the side, and say what is fine', () => {
    expect(appNameProblem('Passport Pro')).toBe('The name must not have "Pro" right after "Passport": it reads as a version of the wallet, as "Passport Pro" would. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    expect(appNameProblem('Premium Passport')).toBe('The name must not have "Premium" right before "Passport": it reads as a version of the wallet, as "Premium Passport" would. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    expect(appNameProblem('My PassportPlus')).toBe('The name must not have "PassportPlus": "Passport" joined with a word like "Pro", "Plus" or "Lite" reads as a version of the wallet. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    // A wallet word wins over an edition word when both are there; "Free" stays the claim rule's.
    expect(passportProblemIn('Passport Wallet Pro')).toEqual({ kind: 'after', word: 'Wallet' });
    expect(appNameProblem('Passport Pro™')).toMatch(/^The name must not have "Pro" right after "Passport"/u);
    expect(passportProblemIn('Passport Free')).toEqual({ kind: 'claim', word: 'Free' });
  });
  it('D903: known misses, recorded in D903: a comma or a space as the version\'s dot, Roman numerals', () => {
    // Outside the property below on purpose: "Passport 2,0" and "Passport 2 0" compare equal to the refused "Passport 2.0".
    for (const name of ['Passport 2,0', 'Passport 2 0', 'Passport II']) expect(passportProblemIn(name), name).toBeNull();
  });
  it('D903: a version number with "Passport" alone is a version of the wallet; its message names it as written', () => {
    expect(appNameProblem('Passport 2.0')).toBe('The name must not have a version number such as "2.0" with "Passport": it reads as a version of the wallet, as "Passport 2.0" would. Users call Journear Passport "Passport". Your brand first, as in "Acme Passport", or "Passport" with words of your own, as in "Passport Photos Co", is fine');
    expect(passportProblemIn('My Passport V2')).toEqual({ kind: 'version', word: 'V2' });
    expect(passportProblemIn('Passport Version 2')).toEqual({ kind: 'version', word: 'Version 2' });
    // Other rules keep their messages when a version number sits beside them.
    expect(passportProblemIn('Passport Pro 2.0')).toEqual({ kind: 'tier_after', word: 'Pro' });
    expect(passportProblemIn('Passport V2 Wallet')).toEqual({ kind: 'after', word: 'Wallet' });
    // "Passport 2" was already the alone rule's (one digit after it), and stays so.
    expect(passportProblemIn('Passport 2')?.kind).toBe('alone');
    // Any script's decimal digits are digits.
    expect(passportProblemIn('Passport ٢.٠')).toEqual({ kind: 'version', word: '٢.٠' });
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
  // D924: measured as work, not wall-clock milliseconds (which failed under parallel load): each call's cost is the best of
  // five timed batches, and a rule that backtracks catastrophically shows as a cost that explodes with the length (twice
  // the characters, thousands of times the work), where linear or quadratic rules grow 2 to 4 times. Each adversarial
  // name is also held against a plain name of the same length checked by the same rules.
  const cost = (f: () => void, batch: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      for (let i = 0; i < batch; i++) f();
      best = Math.min(best, performance.now() - t);
    }
    return Math.max(best, 0.05); // below the timer's resolution, a floor rather than a zero
  };
  it('64-character adversarial names: no rule’s work explodes with the length, and none costs far more than a plain name', () => {
    const inputs = [
      'P'.repeat(64), 'p a s s p o r t '.repeat(4), 'Passport '.repeat(7), 'P-a-s-s-p-o-r-t-'.repeat(4), `${'a '.repeat(31)}!`, '. '.repeat(32), `Passport${' '.repeat(55)}|`,
      'J o u r n e a r '.repeat(4), `${'the '.repeat(15)}Passport`, 'Wallet Passport '.repeat(4), '.-'.repeat(32), `${'x'.repeat(63)}.`, 'Sa fe '.repeat(10),
      `Passport ${'Pro '.repeat(14)}`, `Passport ${'X '.repeat(28)}Pro`, `${'my '.repeat(19)}Passport Pro`, `${'Passport Pro '.repeat(5)}`, `Passport${'Pro'.repeat(18)}™`,
      `Passport ${'1.'.repeat(27)}x`, `Passport ${'v2 '.repeat(18)}`, `${'Passport 2.0 '.repeat(5)}`, `Passport ${'Elite '.repeat(10)}`, `${'v'.repeat(60)}2.0`,
    ];
    const plain = cost(() => appNameProblem('Coffee Club Rewards and Loyalty for Small Shops Downtown Seattle W'.slice(0, 64)), 40);
    for (const name of inputs) {
      const full = cost(() => appNameProblem(name.slice(0, 64)), 40);
      const half = cost(() => appNameProblem(name.slice(0, 32)), 40);
      expect(full / half, `${name}: 64 vs 32 characters`).toBeLessThan(32);
      expect(full / plain, `${name}: against a plain name`).toBeLessThan(200);
    }
    // The version and trade-mark steps on 2,000 characters (far past the 64 a name may have): the same, 2,000 against 1,000.
    for (const name of [`Passport ${'v'.repeat(2000)}`, `Passport ${'1.'.repeat(1000)}x`, `Passport${'v.'.repeat(1000)}`, `Pa55port${'9.'.repeat(1000)}`, `${'Pass port'.repeat(220)}V2`, `Passport ${'(TM) '.repeat(400)}`, `${'v  '.repeat(700)}2`]) {
      const check = (n: string) => () => {
        passportProblemIn(n);
        brandNameIn(n);
      };
      const full = cost(check(name), 20);
      const quarter = cost(check(name.slice(0, Math.ceil(name.length / 4))), 20);
      // Four times the characters: a quadratic rule costs 16 times as much, a cubic one 64 (after PR 151's review, L8:
      // the doubling ratio under 32 caught only n^5). Measured over the quadrupling, not a doubling, so the bound sits
      // between the two with room for a loaded machine's noise (the version step is quadratic: 0.15, 0.38, 1.27 and 4.53
      // ms at 500 to 4,000 characters, 2026-11-25), and none may take seconds outright.
      expect(full / quarter, `${name.slice(0, 20)}: 2,000 vs 500 characters`).toBeLessThan(32);
      expect(full / 20, `${name.slice(0, 20)}: one call on 2,000 characters`).toBeLessThan(2000);
    }
  });
});

describe('look-alike app names on one scope (D929, the platform API’s create, L15)', () => {
  it('reads names alike across case, spacing, punctuation, accents, look-alike letters and rn/m, vv/w', () => {
    for (const other of ['ACME SWAP', 'acme-swap', 'Acme  Swap', 'Acrne Swap', 'Àcmé Swap', 'AcmeSwap', 'Acme_Swap', 'Ac.me Swap']) expect(namesLookAlike('Acme Swap', other), other).toBe(true);
    expect(namesLookAlike('Acme Wallet', 'Acme VVallet')).toBe(true);
    expect(namesLookAlike('Acme Swap', 'Acme Swap Pro')).toBe(false);
    expect(namesLookAlike('Acme Swap', 'Acme Swop')).toBe(false);
    // Nothing to compare: never alike.
    expect(namesLookAlike('!!!', '???')).toBe(false);
    expect(appNameLookalikeKey('Acme Swap')).toBe('acmeswap');
  });
});

describe('the platform API’s bodies (D929)', () => {
  it('are strict: an unknown field, a 21st web address or a bad scope id is refused', () => {
    expect(platformCreateAppBody.safeParse({ scopeId: 's1', name: 'Acme' }).success).toBe(true);
    expect(platformCreateAppBody.safeParse({ scopeId: 's1', name: 'Acme', userIds: 'scope' }).success).toBe(false);
    expect(platformCreateAppBody.safeParse({ scopeId: 'S!', name: 'Acme' }).success).toBe(false);
    expect(platformCreateAppBody.safeParse({ scopeId: 's1', name: 'Acme', origins: Array(21).fill('https://a.example') }).success).toBe(false);
    expect(platformAddOriginsBody.safeParse({ add: [], expectedVersion: 1 }).success).toBe(false);
    expect(platformRemoveOriginsBody.safeParse({ remove: ['https://a.example'], expectedVersion: -1 }).success).toBe(false);
    expect(platformSuspendBody.safeParse({ suspended: 'yes' }).success).toBe(false);
    expect(platformEmptyBody.safeParse({ note: 1 }).success).toBe(false);
    expect(PLATFORM_OPS_LIMITS).toMatchObject({ creationsPerHour: 2, proposalsPerHour: 20, waitingPerOrg: 30, listPage: 50, keysShown: 20 });
  });
});
