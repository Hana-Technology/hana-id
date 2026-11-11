// The email layout (src/email.ts): escaping, what it refuses, what it never emits, and its size.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAIL_COLOURS, type MailBlock, isMailLoopbackHost, mailHtml, mailLogoUrl, mailText, mailUrlProblem } from '../src/email.ts';
import { MAIL_LOGO_HEIGHT, MAIL_LOGO_PATH, MAIL_LOGO_PNG_BASE64, MAIL_LOGO_SHA256, MAIL_LOGO_WIDTH } from '../src/mail-logo.ts';

const BIDI = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);

const base = (blocks: MailBlock[], extra: Partial<Parameters<typeof mailHtml>[0]> = {}): string => mailHtml({ title: 'T', preheader: 'P', blocks, ...extra });

/** The HTML with the head's style sheet removed: what the body itself emits. */
const body = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/u, '');

describe('mailHtml', () => {
  it('is a whole document: lang, charset, both colour-scheme metas, no remote resource, script, form or image', () => {
    const html = base([{ kind: 'heading', text: 'Hi' }, { kind: 'code', code: '550046' }, { kind: 'button', label: 'Go', url: 'https://console.example/x' }]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toMatch(/@media \(prefers-color-scheme:dark\)/u);
    expect(html).not.toMatch(/<img|<script|<form|<input|<link|<iframe|<object|<svg|@import|url\(|src=/iu);
    // The one link is the button's.
    expect([...html.matchAll(/href="([^"]*)"/gu)].map((m) => m[1])).toEqual(['https://console.example/x']);
  });

  it('escapes every string and drops control, bidi and invisible characters: no markup, link or hidden text gets in', () => {
    const hostile = `<a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>"'${BIDI}evil${ZWSP}${NUL}${BOM}`;
    const html = base(
      [
        { kind: 'heading', text: hostile },
        { kind: 'p', text: [hostile, { strong: hostile }, { host: hostile }] },
        { kind: 'callout', tone: 'warn', text: hostile },
        { kind: 'kv', rows: [[hostile, hostile]] },
        { kind: 'list', items: [hostile] },
        { kind: 'pre', text: hostile },
        { kind: 'button', label: hostile, url: 'https://console.example/a?b="><script>' },
      ],
      { title: hostile, preheader: hostile, envNotice: hostile, footer: hostile },
    );
    expect(html).not.toMatch(/<a href="javascript|<img|<script/u);
    // Every tag is one the layout writes itself (the hostile strings are text, the "onerror" only as escaped text).
    // '!' is the Outlook conditional comment.
    const tags = new Set([...body(html).matchAll(/<\/?([a-z0-9!]+)/giu)].map((m) => m[1]!.toLowerCase()));
    expect([...tags].sort()).toEqual(['!', '!doctype', 'a', 'body', 'br', 'div', 'h1', 'head', 'html', 'li', 'meta', 'p', 'pre', 'span', 'strong', 'table', 'td', 'title', 'tr', 'ul', 'wbr'].sort());
    expect(html).not.toMatch(/ on[a-z]+="/u);
    for (const c of [BIDI, ZWSP, NUL, BOM]) expect(html).not.toContain(c);
    expect(html).toContain('&#60;a href=&#34;javascript:alert(1)&#34;&#62;');
    // The button's URL is an attribute value: quotes and angle brackets escaped.
    expect(html).toContain('href="https://console.example/a?b=&#34;&#62;&#60;script&#62;"');
    expect([...html.matchAll(/<a /gu)]).toHaveLength(1);
  });

  it('refuses a button URL that is not https (http only on a loopback host) and a code that is not 4-12 digits or capitals', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/', 'mailto:a@b.c', 'not a url', 'JAVASCRIPT:alert(1)']) {
      expect(mailUrlProblem(url), url).not.toBeNull();
      expect(() => base([{ kind: 'button', label: 'x', url }]), url).toThrow();
    }
    expect(mailUrlProblem('https://console.example/invite#t=abc')).toBeNull();
    expect(mailUrlProblem('http://localhost:4400/x')).toBeNull();
    for (const code of ['55 0046', '<b>1</b>', '123', 'abcdef', '1234567890123']) expect(() => base([{ kind: 'code', code }]), code).toThrow();
  });

  it('shows a code as one selectable token: one text node, no space or cell between its characters', () => {
    const html = base([{ kind: 'code', code: '550046', caption: 'It expires in 10 minutes.' }]);
    expect(html).toMatch(/user-select:all"><strong style="font-weight:700">550046<\/strong><\/div>/u);
    expect(html).toContain('It expires in 10 minutes.');
  });

  it('shows a host as text that clients do not link: every dot in its own element, nothing invisible added', () => {
    const html = base([{ kind: 'p', text: ['(', { host: 'auth.hana.example' }, ')'] }]);
    expect(html).toContain('auth<span>.</span><wbr>hana<span>.</span><wbr>example');
    expect(html).not.toContain('auth.hana.example');
    expect(html.replace(/<[^>]+>/gu, '')).toContain('(auth.hana.example)');
  });

  it('a table value or list item may be inline runs: an unlinked origin splits at each dot and slash, still escaped (D700)', () => {
    const html = body(base([{ kind: 'kv', rows: [['Origin', [{ unlinked: 'http://localhost:5173/<b>' }]], ['Plain', 'a.b']] }, { kind: 'list', items: [[{ unlinked: 'https://evil.example' }], 'x.y'] }]));
    expect(html).toContain('http:<span>/</span><wbr><span>/</span><wbr>localhost:5173<span>/</span><wbr>&#60;b&#62;');
    expect(html).toContain('https:<span>/</span><wbr><span>/</span><wbr>evil<span>.</span><wbr>example');
    expect(html).not.toContain('<b>');
    // A plain string is unchanged: escaped text, no spans.
    expect(html).toContain('>a.b</td>');
    expect(html).toContain('>x.y</li>');
  });

  it('keeps the preview line to its text, padded so the body (and a code) does not fill the rest', () => {
    const html = base([{ kind: 'code', code: '550046' }], { preheader: 'Your code to sign in. It expires in 10 minutes.' });
    const pre = /<div style="display:none[^"]*">([\s\S]*?)<\/div>/u.exec(html)![1]!;
    expect(pre.startsWith('Your code to sign in. It expires in 10 minutes.')).toBe(true);
    expect(pre).not.toContain('550046');
    expect(html.indexOf('550046')).toBeGreaterThan(html.indexOf(pre) + pre.length);
  });

  it('marks a non-production env in a banner; none without one', () => {
    expect(base([], { envNotice: '[SANDBOX] Not production.' })).toContain('[SANDBOX] Not production.');
    expect(base([])).not.toContain('Not production');
  });

  it('stays small: a full mail is far under Gmail’s 102 KB clip', () => {
    const html = base([
      { kind: 'heading', text: 'Your sign-in code for Hana Home' },
      { kind: 'p', text: 'Your code to sign in to Hana Home:' },
      { kind: 'code', code: '550046', caption: 'It expires in 10 minutes.' },
      { kind: 'callout', tone: 'info', text: ['Type this code only in the Hana window you opened (', { host: 'auth.example' }, ').'] },
      { kind: 'p', text: 'If you didn’t try to sign in to Hana Home, ignore this mail.' },
    ]);
    expect(new TextEncoder().encode(html).length).toBeLessThan(12_000);
  });

  it('dark colours: every text/surface pair the layout uses in either scheme is WCAG AA (4.5:1)', () => {
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const s of [MAIL_COLOURS.light, MAIL_COLOURS.dark]) {
      const pairs: [string, string][] = [
        [s.ink, s.card],
        [s.ink2, s.card],
        [s.muted, s.card],
        [s.muted, s.page],
        [s.ink, s.codeBg],
        [s.ink2, s.codeBg],
        [s.ink, s.infoBg],
        [s.warnInk, s.warnBg],
        [s.onAccent, s.accent],
        [s.accent, s.page],
      ];
      for (const [fg, bg] of pairs) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('mailText escapes the five HTML characters', () => {
    expect(mailText(`&<>"'`)).toBe('&#38;&#60;&#62;&#34;&#39;');
  });
});

describe('what text may hold: the display-safety rule, by class', () => {
  const ch = (n: number): string => String.fromCodePoint(n);
  const cases: [string, number[]][] = [
    ['Cc, controls (but tab and line feed)', [0x00, 0x07, 0x0d, 0x1b, 0x7f, 0x85, 0x9f]],
    ['Cf, format: bidi, zero-width, soft hyphen, Arabic letter mark, Mongolian vowel separator, interlinear, BOM, tags', [0x202e, 0x2066, 0x200b, 0x200d, 0x00ad, 0x061c, 0x180e, 0xfff9, 0xfffb, 0xfeff, 0xe0001, 0xe0041, 0xe007f]],
    ['Co, private use', [0xe000, 0xf8ff, 0xf0000]],
    ['Zl, line separator', [0x2028]],
    ['Zp, paragraph separator', [0x2029]],
    ['fillers: combining grapheme joiner, Hangul, Khmer, Mongolian selectors, braille blank, variation selectors', [0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x2800, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef]],
  ];
  for (const [what, points] of cases) {
    it(`drops ${what}`, () => {
      for (const n of points) expect(mailText(`a${ch(n)}b`), n.toString(16)).toBe('ab');
    });
  }

  it('keeps tab and line feed (a preformatted block needs them), letters, accents and emoji without a selector', () => {
    expect(mailText('a\tb\nc')).toBe('a\tb\nc');
    expect(mailText('Café Ünïcode 日本 😀')).toBe('Café Ünïcode 日本 😀');
  });
});

describe('the hosted logo (D685)', () => {
  it('replaces the text wordmark with one <img>: the URL as given, fixed size, alt "Hana ID" styled as the wordmark', () => {
    const url = `https://files.example${MAIL_LOGO_PATH}`;
    const html = base([], { logoUrl: url });
    const img = [...html.matchAll(/<img\b[^>]*>/gu)].map((m) => m[0]);
    expect(img).toHaveLength(1);
    expect(img[0]).toContain(`src="${url}"`);
    expect(img[0]).toContain(`width="${MAIL_LOGO_WIDTH}" height="${MAIL_LOGO_HEIGHT}"`);
    expect(img[0]).toContain('alt="Hana ID"');
    expect(img[0]).toMatch(/font-size:20px;[^"]*font-weight:800;[^"]*color:#16073a/u);
    expect(html).not.toContain('>Hana</span> <span');
    // Without a URL, or with one that isn't https (or loopback http): the text wordmark, no image.
    for (const logoUrl of [undefined, 'http://files.example/x.png', 'javascript:alert(1)', 'not a url']) {
      const h = base([], logoUrl === undefined ? {} : { logoUrl });
      expect(h, String(logoUrl)).not.toContain('<img');
      expect(h).toContain('>Hana</span> <span');
    }
  });

  it('mailLogoUrl: the files origin and the hashed path, nothing per recipient', () => {
    expect(mailLogoUrl('https://files.example')).toBe(`https://files.example${MAIL_LOGO_PATH}`);
    expect(mailLogoUrl('https://files.example/')).toBe(`https://files.example${MAIL_LOGO_PATH}`);
    expect(mailLogoUrl(undefined)).toBeUndefined();
    expect(mailLogoUrl('')).toBeUndefined();
  });

  it('the logo bytes: a PNG of the declared size, whose sha256 the path names, the same as mail/hana-mail-logo.png', () => {
    const bytes = Buffer.from(MAIL_LOGO_PNG_BASE64, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: width and height at 2x.
    expect(bytes.readUInt32BE(16)).toBe(MAIL_LOGO_WIDTH * 2);
    expect(bytes.readUInt32BE(20)).toBe(MAIL_LOGO_HEIGHT * 2);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(MAIL_LOGO_SHA256);
    expect(MAIL_LOGO_PATH).toBe(`/brand/hana-mail-logo-${MAIL_LOGO_SHA256.slice(0, 16)}.png`);
    expect(readFileSync(new URL('../mail/hana-mail-logo.png', import.meta.url)).equals(bytes)).toBe(true);
    expect(bytes.length).toBeLessThan(8 * 1024);
  });
});

describe('mailUrlProblem: https, or http on a loopback host', () => {
  it('accepts every loopback form isLoopbackHost does', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '[::ffff:7f00:1]', 'localhost.']) {
      expect(isMailLoopbackHost(new URL(`http://${host}/`).hostname), host).toBe(true);
      expect(mailUrlProblem(`http://${host}:4400/x`), host).toBeNull();
    }
    for (const host of ['example.com', '10.0.0.1', '0.0.0.0', 'localhost.example.com', '[::2]']) expect(mailUrlProblem(`http://${host}/x`), host).not.toBeNull();
  });
});
