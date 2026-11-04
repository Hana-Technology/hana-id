// Logo URLs (src/logo.ts, batch C11): the shape the protocol takes and the origin and app the pages pin.
import { describe, expect, it } from 'vitest';
import { LOGO_PATH_RE, isLogoUrl, logoUrlOn } from '../src/logo.ts';

const HEX = 'a1'.repeat(32);
const FILES = 'https://files.example';
const URL_OK = `${FILES}/logos/app_abc123/${HEX}.png`;

describe('isLogoUrl', () => {
  it('takes the canonical logo URL on any http(s) origin', () => {
    expect(isLogoUrl(URL_OK)).toBe(true);
    expect(isLogoUrl(`http://127.0.0.1:8790/logos/app_abc123/${HEX}.png`)).toBe(true);
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['another path', `${FILES}/statements/app_abc123/${HEX}.png`],
    ['a short hash', `${FILES}/logos/app_abc123/${HEX.slice(2)}.png`],
    ['an uppercase hash', `${FILES}/logos/app_abc123/${HEX.toUpperCase()}.png`],
    ['another extension', `${FILES}/logos/app_abc123/${HEX}.svg`],
    ['a query', `${URL_OK}?v=1`],
    ['an empty query', `${URL_OK}?`],
    ['a fragment', `${URL_OK}#x`],
    ['credentials', `https://user@files.example/logos/app_abc123/${HEX}.png`],
    ['a non-canonical origin', `HTTPS://FILES.example/logos/app_abc123/${HEX}.png`],
    ['a default port spelled out', `https://files.example:443/logos/app_abc123/${HEX}.png`],
    ['a dot segment', `${FILES}/logos/x/../app_abc123/${HEX}.png`],
    ['an encoded slash', `${FILES}/logos/app_abc123%2F/${HEX}.png`],
    ['another scheme', `ftp://files.example/logos/app_abc123/${HEX}.png`],
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
    ['too long', `https://${'a'.repeat(700)}.example/logos/app_abc123/${HEX}.png`],
  ])('refuses %s', (_, v) => {
    expect(isLogoUrl(v)).toBe(false);
  });

  it('matches the files Worker’s path rule', () => {
    expect(LOGO_PATH_RE.test(`/logos/app_abc123/${HEX}.png`)).toBe(true);
    expect(LOGO_PATH_RE.test(`/logos/app_abc123/${HEX}.png/`)).toBe(false);
  });
});

describe('logoUrlOn', () => {
  it('keeps a logo on the pinned files origin, and of the app when one is named', () => {
    expect(logoUrlOn(FILES, URL_OK)).toBe(URL_OK);
    expect(logoUrlOn(FILES, URL_OK, 'app_abc123')).toBe(URL_OK);
  });

  it('drops a logo of another origin or app, any other value, and every logo in a build with no files origin', () => {
    expect(logoUrlOn('https://other.example', URL_OK)).toBeNull();
    expect(logoUrlOn(FILES, URL_OK, 'app_abc12')).toBeNull();
    expect(logoUrlOn(FILES, URL_OK, 'app_abc1234')).toBeNull();
    expect(logoUrlOn(FILES, null)).toBeNull();
    expect(logoUrlOn(FILES, undefined)).toBeNull();
    expect(logoUrlOn(FILES, `${URL_OK}?x`)).toBeNull();
    expect(logoUrlOn(undefined, URL_OK)).toBeNull();
    expect(logoUrlOn('', URL_OK)).toBeNull();
  });
});
