// D686: an app's name may not look like a web address or hold "Hana" (any case, accents, look-alike letters, letters
// split by spaces or punctuation). normalisePartnerAppName is what the API and the CLI apply when an app is named.
import { describe, expect, it } from 'vitest';
import { appNameProblem, hanaWordIn, looksLikeAddress, nameSkeleton, normalisePartnerAppName } from '../src/names.ts';

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

  it('normalisePartnerAppName: the stored-form rules first, then D686', () => {
    expect(normalisePartnerAppName('  Sodax Demo  ')).toEqual({ ok: true, name: 'Sodax Demo' });
    expect(normalisePartnerAppName('Hana Home')).toMatchObject({ ok: false, problem: expect.stringMatching(/Hana/u) });
    expect(normalisePartnerAppName('evil.com')).toMatchObject({ ok: false, problem: expect.stringMatching(/web address/u) });
    expect(normalisePartnerAppName('   ').ok).toBe(false);
    expect(normalisePartnerAppName(`Wal${ch(0x202e)}let`).ok).toBe(false);
  });
});
