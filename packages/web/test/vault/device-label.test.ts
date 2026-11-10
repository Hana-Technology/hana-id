// The device label a new share carries (D98 item 10, D512): browser and system families only, from the User-Agent; the
// API's shape (apps/api vault/endpoints.ts DEVICE_LABEL_RE) always accepts it.
import { describe, expect, it } from 'vitest';
import { deviceLabel } from '../../src/vault/device-label.ts';

/** The API's rule: letters, digits and ` .()/_-`, at most 40, starting with a letter or digit. */
const API_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .()/_-]{0,39}$/u;

const CASES: [string, string, string | null][] = [
  ['Chrome on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome on macOS'],
  ['Safari on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari on macOS'],
  ['Firefox on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox on Windows'],
  ['Edge on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge on Windows'],
  ['Opera on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', 'Opera on Linux'],
  ['Safari on iOS (an iPhone)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
  ['Chrome on iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1', 'Chrome on iOS'],
  ['Firefox on iOS', 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15', 'Firefox on iOS'],
  ['Chrome on Android, never the phone model', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
  ['Samsung Internet on Android', 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'Samsung Internet on Android'],
  ['Chrome on ChromeOS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome on ChromeOS'],
  ['an unknown browser on a known system', 'SomeBrowser/1.0 (Windows NT 10.0)', 'Browser on Windows'],
  ['a known browser on an unknown system', 'Mozilla/5.0 (PlayStation; rv:1) Gecko/20100101 Firefox/120.0', 'Firefox'],
  ['nothing recognised: no label', 'curl/8.4.0', null],
  ['empty: no label', '', null],
];

describe('deviceLabel', () => {
  it.each(CASES)('%s', (_name, ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
    if (label) expect(label).toMatch(API_SHAPE);
  });

  it('carries no version, model or language, whatever the User-Agent holds', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A.231005.007; wv; en-GB) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36';
    const label = deviceLabel(ua) as string;
    expect(label).toBe('Chrome on Android');
    expect(label).not.toMatch(/\d|SM-|en-GB|wv/u);
  });

  it('no label for a missing or oversized User-Agent', () => {
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel(`Chrome/1 ${'x'.repeat(1100)}`)).toBeNull();
  });
});
