import { domainToUnicode } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hostToUnicode, isMixedScript, labelScripts, LOCALHOST_WILDCARD, MAX_APP_ORIGINS, normaliseOrigin, OriginError, originDisplay, originProblem, type OriginRules, punycodeDecode } from '../src/index.ts';

describe('normaliseOrigin', () => {
  // Shared vectors: the API, the console and the CLI all go through this one function (spec "Tests": byte-identical).
  const cases: [string, string][] = [
    ['https://App.Example.com', 'https://app.example.com'],
    ['https://app.example.com/', 'https://app.example.com'],
    ['https://app.example.com:443', 'https://app.example.com'],
    ['http://app.example.com:80', 'http://app.example.com'],
    ['https://app.example.com:8443', 'https://app.example.com:8443'],
    ['https://app.example.com.', 'https://app.example.com'],
    ['https://app.example.com.:444/', 'https://app.example.com:444'],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
    ['https://BÜCHER.example', 'https://xn--bcher-kva.example'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://[0:0:0:0:0:0:0:1]:3000', 'http://[::1]:3000'],
    ['http://LOCALHOST:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    [LOCALHOST_WILDCARD, LOCALHOST_WILDCARD],
  ];
  for (const [input, out] of cases) {
    it(`${input} → ${out}`, () => {
      expect(normaliseOrigin(input)).toBe(out);
      expect(normaliseOrigin(out)).toBe(out); // idempotent
    });
  }

  it('refuses non-origins with a reason', () => {
    const refused: [string, string][] = [
      ['not a url', 'invalid'],
      ['ftp://example.com', 'not_http'],
      ['javascript:alert(1)', 'not_http'],
      ['https://user:pw@example.com', 'credentials'],
      ['https://example.com/path', 'path'],
      ['https://example.com?q', 'path'],
      ['https://example.com/#x', 'path'],
      ['https://example.com#', 'path'],
    ];
    for (const [input, reason] of refused) {
      try {
        normaliseOrigin(input);
        expect.unreachable(input);
      } catch (e) {
        expect(e).toBeInstanceOf(OriginError);
        expect((e as OriginError).reason, input).toBe(reason);
      }
    }
  });
});

describe('punycode display', () => {
  it('decodes RFC 3492 samples and agrees with Node for IDN hosts', () => {
    expect(punycodeDecode('bcher-kva')).toBe('bücher');
    expect(punycodeDecode('ihqwcrb4cv8a8dqg056pqjye')).toBe('他们为什么不说中文');
    for (const host of ['xn--bcher-kva.example', 'xn--80ak6aa92e.com', 'xn--fiqs8s.xn--fiqz9s', 'xn--mnchen-3ya.de', 'app.xn--e1afmkfd.xn--p1ai', 'plain.example']) {
      expect(hostToUnicode(host), host).toBe(domainToUnicode(host));
    }
  });

  it('refuses malformed punycode and leaves the label as it is', () => {
    for (const bad of ['a-9999999999', 'ü', 'abc-$$']) expect(() => punycodeDecode(bad), bad).toThrow(RangeError);
    expect(hostToUnicode('xn--ü.example')).toBe('xn--ü.example');
  });

  it('originDisplay flags IDN origins with the decoded form beside the ASCII one', () => {
    expect(originDisplay('https://xn--bcher-kva.example:8443')).toEqual({ origin: 'https://xn--bcher-kva.example:8443', display: 'https://bücher.example:8443', idn: true });
    expect(originDisplay('https://app.example.com')).toEqual({ origin: 'https://app.example.com', display: 'https://app.example.com', idn: false });
    expect(originDisplay(LOCALHOST_WILDCARD).idn).toBe(false);
  });
});

describe('mixed script (UTS #39 highly restrictive)', () => {
  it('classifies letters and ignores digits and hyphens', () => {
    expect([...labelScripts('app-2')]).toEqual(['Latin']);
    expect([...labelScripts('аpple')].sort()).toEqual(['Cyrillic', 'Latin']); // Cyrillic а
    expect([...labelScripts('123-')]).toEqual([]);
  });

  it('refuses Latin with Cyrillic or Greek in one label, allows single scripts and the CJK sets', () => {
    expect(isMixedScript('аpple.com')).toBe(true); // Cyrillic а + Latin
    expect(isMixedScript('pаypal.example')).toBe(true);
    expect(isMixedScript('gοogle.example')).toBe(true); // Greek ο
    expect(isMixedScript('яндекс.рф')).toBe(false);
    expect(isMixedScript('bücher.example')).toBe(false);
    expect(isMixedScript('東京tokyo.jp')).toBe(false); // Han + Latin
    expect(isMixedScript('ひらがなカタカナ漢字.jp')).toBe(false); // Hiragana + Katakana + Han
    expect(isMixedScript('한국어漢字.kr')).toBe(false); // Hangul + Han
    expect(isMixedScript('한국ひら.kr')).toBe(true); // Hangul + Hiragana: not an allowed set
    // Scripts may differ between labels (each label is checked on its own).
    expect(isMixedScript('яндекс.example')).toBe(false);
  });
});

describe('originProblem', () => {
  const devTest: OriginRules = { envName: 'sandbox-dev', network: 'testnet', environment: 'test', refusedOrigins: ['https://vault.hana.example'] };
  const devLive: OriginRules = { ...devTest, environment: 'live' };
  const stagingTest: OriginRules = { ...devTest, envName: 'staging' };
  const mainnetTest: OriginRules = { ...devTest, envName: 'sandbox-x', network: 'mainnet' };

  it('accepts an https origin with a real DNS name everywhere', () => {
    for (const r of [devTest, devLive, stagingTest, mainnetTest]) expect(originProblem('https://app.partner.example', r)).toBeNull();
  });

  it('loopback and the localhost wildcard only on test scopes in dev envs, never on mainnet', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://localhost', LOCALHOST_WILDCARD]) {
      expect(originProblem(o, devTest), o).toBeNull();
      expect(originProblem(o, devLive)?.reason, o).toMatch(/loopback|wildcard/u);
      expect(originProblem(o, stagingTest)?.reason, o).toMatch(/loopback|wildcard/u);
      expect(originProblem(o, mainnetTest)?.reason, o).toMatch(/loopback|wildcard/u);
    }
  });

  it('refuses plain http, IPs, public suffixes, single labels, Hana origins and unnormalised input', () => {
    expect(originProblem('http://app.partner.example', devTest)?.reason).toBe('not_https');
    expect(originProblem('https://10.0.0.1', devTest)?.reason).toBe('ip_or_suffix');
    expect(originProblem('https://workers.dev', devTest)?.reason).toBe('ip_or_suffix');
    expect(originProblem('https://intranet', devTest)?.reason).toBe('ip_or_suffix');
    expect(originProblem('https://vault.hana.example', devTest)?.reason).toBe('refused');
    expect(originProblem('https://App.example.com', devTest)?.reason).toBe('invalid');
    expect(originProblem('https://example.com/x', devTest)?.reason).toBe('path');
  });

  it('refuses a mixed-script host on live scopes only', () => {
    const o = normaliseOrigin('https://аpple.example');
    expect(originProblem(o, devLive)?.reason).toBe('mixed_script');
    expect(originProblem(o, devTest)).toBeNull();
    expect(originProblem(normaliseOrigin('https://bücher.example'), devLive)).toBeNull();
  });

  it('caps an app at 20 origins (the vault page limit)', () => {
    expect(MAX_APP_ORIGINS).toBe(20);
  });
});
