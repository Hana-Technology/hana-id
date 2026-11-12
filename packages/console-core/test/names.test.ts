// D686 (as extended by D765): an app's name may not look like a web address or hold "Hana", "Journear" or "Passport Home"
// (any case, accents, look-alike letters, letters split by spaces or punctuation); "Passport" alone is allowed.
// normalisePartnerAppName is what the API and the CLI apply when an app is named.
import { describe, expect, it } from 'vitest';
import { appNameProblem, brandNameIn, hanaWordIn, journearWordIn, looksLikeAddress, nameSkeleton, normalisePartnerAppName } from '../src/names.ts';

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

  it('refuses "Passport Home" (the users\' own wallet page, whose mails an app must not imitate), but not "Passport" alone', () => {
    const cyrillicEr = ch(0x0440);
    const cyrillicO = ch(0x043e);
    for (const name of ['Passport Home', 'passport home', 'PASSPORT HOME', 'PassportHome', 'passport-home', 'P a s s p o r t Home', `Pass${cyrillicEr}ort H${cyrillicO}me`, 'Passp0rt Home', 'My Passport Home', 'Passport Home Rentals']) {
      expect(brandNameIn(name), name).toBe('Passport Home');
      expect(appNameProblem(name), name).toMatch(/"Passport Home"/u);
    }
    for (const name of ['Passport', 'Passport Travel', 'passport', 'Passport Pay', 'Travel Passport', 'Passport Homes', 'Passport Homestay', 'My Passport']) {
      expect(brandNameIn(name), name).toBeNull();
      expect(appNameProblem(name), name).toBeNull();
    }
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
    expect(normalisePartnerAppName('evil.com')).toMatchObject({ ok: false, problem: expect.stringMatching(/web address/u) });
    expect(normalisePartnerAppName('   ').ok).toBe(false);
    expect(normalisePartnerAppName(`Wal${ch(0x202e)}let`).ok).toBe(false);
  });
});
