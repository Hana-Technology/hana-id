// D686 (as extended by D765): an app's name may not look like a web address or hold "Hana", "Journear" or "Passport Home"
// (any case, accents, look-alike letters, letters split by spaces or punctuation); since D891 not "Passport" alone or as
// the wallet ("My Passport", "Passport Wallet"), and no claim word beside sentence punctuation. normalisePartnerAppName is what the API and the CLI apply when an app is named.
import { describe, expect, it } from 'vitest';
import { APP_NAME_CLAIM_WORDS, appNameProblem, brandNameIn, hanaWordIn, journearWordIn, looksLikeAddress, nameSkeleton, normalisePartnerAppName, passportNameIn, sentenceClaimIn } from '../src/names.ts';

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
      // Refused either way ("J.O.U.R.N.E.A.R" also looks like an address and is refused as one first).
      expect(appNameProblem(name), name).toMatch(name.includes('.') ? /web address/u : /"Journear"/u);
    }
    expect(nameSkeleton(`J${cyrillicO}urn${cyrillicIe}ar`)).toBe('journear');
    expect(nameSkeleton('J0URN3AR')).toBe('journear');
  });

  it('refuses "Passport Home" (the users\' own wallet page, whose mails an app must not imitate) as its own brand', () => {
    const cyrillicEr = ch(0x0440);
    const cyrillicO = ch(0x043e);
    for (const name of ['Passport Home', 'passport home', 'PASSPORT HOME', 'PassportHome', 'passport-home', 'P a s s p o r t Home', `Pass${cyrillicEr}ort H${cyrillicO}me`, 'Passp0rt Home', 'My Passport Home', 'Passport Home Rentals']) {
      expect(brandNameIn(name), name).toBe('Passport Home');
      expect(appNameProblem(name), name).toMatch(/"Passport Home"/u);
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

  it('D891: refuses "Passport" itself, in any case, spelling, alphabet or spacing', () => {
    const cyrillicA = ch(0x0430);
    const cyrillicEr = ch(0x0440);
    const cyrillicO = ch(0x043e);
    const greekRho = ch(0x03c1);
    const names = [
      'Passport',
      'passport',
      'PASSPORT',
      'Passport!',
      'Passport.',
      '(Passport)',
      '“Passport”',
      'Passport 🛂',
      'Passport™',
      'Passport®',
      'P a s s p o r t',
      'PASS-PORT',
      'Pass Port',
      `P${cyrillicA}ssport`,
      `${cyrillicEr}assport`,
      `Passp${cyrillicO}rt`,
      `${greekRho}assport`,
      'Pa55port',
      'Pa$$p0rt',
      'Pâssport',
      'Ｐａｓｓｐｏｒｔ',
      '𝐏𝐚𝐬𝐬𝐩𝐨𝐫𝐭',
    ];
    for (const name of names) {
      expect(passportNameIn(name), name).toBe(true);
      expect(appNameProblem(name), name).toMatch(/"Passport" on its own/u);
    }
  });

  it('D891: refuses forms that read as the wallet: a determiner or NEAR before it, a product word or "by" after it', () => {
    const names = [
      'My Passport',
      'MyPassport',
      'Your Passport',
      'The Passport',
      'Our Passport',
      'NEAR Passport',
      'Wallet Passport',
      'Passport Wallet',
      'Passport-Wallet',
      'PassportWallet',
      'My Passport Wallet',
      'Passport App',
      'Passport Account',
      'Passport ID',
      'Passport Login',
      'Passport Sign-in',
      'Passport Sign in',
      'Passport Support',
      'Passport Help',
      'Passport Security',
      'Passport Team',
      'Passport Official',
      'Passport Pay',
      'Passport Vault',
      'Passport by Acme',
      'Passp0rt W4llet',
      'Acme Passport App',
    ];
    for (const name of names) {
      expect(passportNameIn(name), name).toBe(true);
      expect(appNameProblem(name), name).toMatch(/"Passport" on its own/u);
    }
    // "Journear Passport", "Passport by Journear" and "Passport Home" stay refused by the older rules, which come first.
    for (const name of ['Journear Passport', 'Passport by Journear']) expect(appNameProblem(name), name).toMatch(/"Journear"/u);
    expect(appNameProblem('Passport Home')).toMatch(/"Passport Home"/u);
  });

  it('D891: keeps "Passport" as one word of another name', () => {
    const names = [
      'Passport Photos Co',
      'Passport Travel',
      'Travel Passport',
      'Passport Parking',
      'Passport Health',
      'Passport Brewing',
      'Passport Labs',
      'Passport Homes',
      'Passports',
      'Passports & Visas Ltd',
      'Passport Identity Checks',
      'Passport Bytes',
      'Passport Byron Bay',
      'Passport Payroll',
      'Passport 2 Asia',
      'Near Passport Office Cafe',
      'Pet Passport',
      'Culture Passport',
    ];
    for (const name of names) {
      expect(passportNameIn(name), name).toBe(false);
      expect(appNameProblem(name), name).toBeNull();
    }
  });

  it('D891: refuses a claim word beside sentence punctuation, also folded, spaced or in leet', () => {
    const names: [string, string][] = [
      ['Acme. Verified', 'verified'],
      ['Acme. Checked', 'checked'],
      ['Acme: safe', 'safe'],
      ['Acme! No fees', 'fees'],
      ['Acme? Free', 'free'],
      ['Acme; official', 'official'],
      ['Acme – risk free', 'risk'],
      ['Acme — guaranteed', 'guaranteed'],
      ['Acme - Secure', 'secure'],
      ['Acme… Trusted', 'trusted'],
      ['Acme. Approved by banks', 'approved'],
      ['Acme. Recommended', 'recommended'],
      ['Acme. Refund on failure', 'refund'],
      ['Acme. Insured', 'insured'],
      ['Acme. V3rified', 'verified'],
      ['Acme. Ver1fied', 'verified'],
      ['Acme. S a f e', 'safe'],
      ['Acme. S4FE', 'safe'],
      [`Acme. ${'Ｓａｆｅ'}`, 'safe'],
      [`Acme${'！'} Safe`, 'safe'],
      [`Acme. S${ch(0x0430)}fe`, 'safe'],
      ['Safe. Acme', 'safe'],
      ['Acme Safe.', 'safe'],
      ['Acme: no risk', 'risk'],
    ];
    for (const [name, word] of names) {
      expect(sentenceClaimIn(name), name).toBe(word);
      expect(appNameProblem(name), name).toMatch(/sentence punctuation/u);
    }
    // Without sentence punctuation the same words are allowed: real names use them.
    for (const name of ['Safe Wallet', 'Trust Wallet', 'Free Now', 'Secure Pay', 'Verified Market Research', 'Risk-Free Trading', 'SafeMoon', 'Acme Safe Swaps']) {
      expect(sentenceClaimIn(name), name).toBeNull();
      expect(appNameProblem(name), name).toBeNull();
    }
    // Whole words only: "Coffee" is not "fee", "Safeway" is not "safe".
    for (const name of ['Dr. Coffee', 'St. Safeway', 'Wait. Checkout', 'Mr. Freeman']) expect(sentenceClaimIn(name), name).toBeNull();
    // The list is lower-case skeleton words (what the check compares).
    for (const w of APP_NAME_CLAIM_WORDS) expect(nameSkeleton(w), w).toBe(w);
  });

  // Awkward real-world names: what D891 must not break, and what was already refused before it.
  it('D891: awkward real-world names', () => {
    const allowed = [
      'Yahoo!',
      'Yahoo! Japan',
      'Yum! Brands',
      'Jeopardy!',
      'Panic! at the Disco',
      'Westward Ho!',
      'Guess?',
      'Who? Weekly',
      'Dr. Martens',
      'Dr. Oetker',
      'Mr. Porter',
      'Mrs. Fields',
      'St. Ives',
      'Wait. What',
      'Re: Store',
      'E*TRADE',
      'Toys R Us',
      'Toys"R"Us',
      'AT&T',
      'H&M',
      "Ben & Jerry's",
      "McDonald's",
      "L'Oréal",
      'Häagen-Dazs',
      'Coca-Cola',
      '7-Eleven',
      '1-800-Flowers',
      'Société Générale',
      'Moët Hennessy',
      'Cirque du Soleil',
      'Safe{Wallet}',
      'Under Armour',
      'Procter & Gamble',
      'Stamp Trail',
      'E2E Partner',
      'Sodax Demo',
    ];
    for (const name of allowed) expect(appNameProblem(name), name).toBeNull();
    // Already refused by D686's address rule (a dot between letters), unchanged by D891: such a company registers
    // its name without the inner dots ("APC", "JCrew", "US Bank").
    for (const name of ['A.P.C.', 'J.Crew', 'U.S. Bank', 'Booking.com']) expect(appNameProblem(name), name).toMatch(/web address/u);
    // Already refused by D765: Journear's own hosted demo is a stored row, named before (or around) the rule.
    expect(appNameProblem('Journear demo')).toMatch(/"Journear"/u);
    // Refused by D891's punctuation rule: real but rare shapes, which register without the punctuation.
    for (const name of ['Yahoo! Finance Free', 'Acme: Official Store']) expect(appNameProblem(name), name).toMatch(/sentence punctuation/u);
  });
});
