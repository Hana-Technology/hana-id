// The brand package (D426 as amended by D765): the fonts are the design system's three OFL families and nothing else,
// each with its licence beside it; fonts.css loads only those files, from beside itself; the tokens are the design
// system's and meet WCAG AA in light and dark, with state colours kept apart from the brand; components.css loads
// nothing and reads only the tokens; the logo files are plain SVG and match the mark's geometry in code.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, tokenSchemes, woff2Names } from '../src/check.ts';
import { BRAND, FONT_FILES, FONT_LICENCE_FILES, FONT_UNICODE_RANGE, MARK_CHEVRON, MARK_FRAME, markSvg } from '../src/index.ts';

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(here(p));
const text = (p: string) => read(p).toString('utf8');

describe('fonts', () => {
  it('fonts/ holds exactly the manifest’s WOFF2 files and their licences', () => {
    expect(readdirSync(here('fonts/')).sort()).toEqual([...FONT_FILES.map((f) => f.file), ...FONT_LICENCE_FILES].sort());
    for (const f of FONT_FILES) expect(FONT_LICENCE_FILES).toContain(f.licence);
  });

  it('each file is the manifest’s bytes, a WOFF2 whose own name table names its family, version and authors', () => {
    for (const f of FONT_FILES) {
      const buf = read(`fonts/${f.file}`);
      expect(createHash('sha256').update(buf).digest('hex'), f.file).toBe(f.sha256);
      const names = woff2Names(buf);
      expect(names.get(1), f.file).toMatch(new RegExp(`^${f.family}\\b`, 'u'));
      expect(names.get(5), f.file).toBe(f.version);
      expect(names.get(0), f.file).toMatch(f.family === 'Archivo' ? /The Archivo Project Authors/u : /IBM Corp\./u);
      // Small: a Latin subset, never the full multi-script build.
      expect(buf.length, f.file).toBeLessThan(26_000);
    }
  });

  it('each licence is the full OFL 1.1 with its fonts’ copyright and no Reserved Font Name', () => {
    const copyright: Record<string, string> = {
      'OFL-Archivo.txt': 'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)',
      'OFL-IBMPlexSans.txt': 'Copyright 2019 IBM Corp.',
      'OFL-IBMPlexMono.txt': 'Copyright 2017 IBM Corp.',
    };
    for (const l of FONT_LICENCE_FILES) {
      const ofl = text(`fonts/${l}`);
      expect(ofl, l).toContain(copyright[l]);
      expect(ofl, l).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
      expect(ofl, l).toContain('PERMISSION & CONDITIONS');
      expect(ofl, l).toContain('TERMINATION');
      expect(ofl, l).not.toMatch(/Reserved Font Name "/u);
    }
  });

  it('no commercial face is shipped, and Hana’s old Montserrat is gone', () => {
    const all = readdirSync(here('fonts/')).join(' ') + text('fonts.css') + text('tokens.css') + text('components.css');
    expect(all).not.toMatch(/proxima|agrandir|montserrat/iu);
  });

  it('fonts.css declares one face per file, from ./fonts/ beside it, and loads nothing else', () => {
    const css = text('fonts.css');
    const urls = [...css.matchAll(/url\(([^)]*)\)/gu)].map((m) => m[1]);
    expect(urls.sort()).toEqual(FONT_FILES.map((f) => `'./fonts/${f.file}'`).sort());
    expect(css).not.toMatch(/@import|https?:|\/\/|data:/u);
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map((m) => m[1]!);
    expect(faces).toHaveLength(FONT_FILES.length);
    for (const f of FONT_FILES) {
      const face = faces.find((x) => x.includes(f.file))!;
      expect(face).toContain(`font-family: '${f.family}';`);
      expect(face).toContain(`font-weight: ${f.weight};`);
      expect(face).toContain('font-display: swap;');
      expect(face).toContain(`unicode-range: ${FONT_UNICODE_RANGE};`);
    }
  });

  it('the tokens’ stacks name the three families, each with a system fallback', () => {
    const css = text('tokens.css');
    expect(css).toMatch(/--jp-font-display: "Archivo",[^;]*system-ui/u);
    expect(css).toMatch(/--jp-font-body: +"IBM Plex Sans",[^;]*system-ui/u);
    expect(css).toMatch(/--jp-font-mono: +"IBM Plex Mono",[^;]*monospace/u);
  });
});

describe('tokens', () => {
  const css = text('tokens.css');
  const schemes = tokenSchemes(css);

  it('declare variables only, and load nothing', () => {
    expect(css).not.toMatch(/url\(|@import|@font-face/u);
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{/gu)].map((m) => m[1]!.trim());
    expect(selectors).toEqual([
      ':root',
      '@media (prefers-color-scheme: dark)',
      ':root:not([data-theme="light"])',
      ':root[data-theme="dark"]',
      '.jp-dark',
      '.jp-light',
      '@media (pointer: coarse)',
      ':root',
    ]);
  });

  it('the forced dark (data-theme, .jp-dark) and light (.jp-light) scopes carry the same colours as the schemes', () => {
    const block = (sel: string) => {
      const at = css.indexOf(`${sel} {`);
      return css.slice(at, css.indexOf('}', at));
    };
    const darkMedia = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'));
    const hex = (s: string) => [...s.matchAll(/(--jp-[\w-]+):\s*(#[0-9a-f]{6})/giu)].map((m) => `${m[1]}=${m[2]!.toLowerCase()}`).sort();
    expect(hex(block(':root[data-theme="dark"]'))).toEqual(hex(darkMedia));
    expect(hex(block('.jp-dark'))).toEqual(hex(darkMedia));
  });

  // [foreground, background, minimum]: 4.5 for text, 7 for body ink, 3 for focus rings (non-text, WCAG 1.4.11).
  const resolve = (v: Map<string, string>, name: string): string | undefined => {
    const direct = v.get(name);
    if (direct) return direct;
    const m = css.match(new RegExp(`${name}:\\s*var\\((--jp-[\\w-]+)\\)`, 'u'));
    return m ? resolve(v, m[1]!) : undefined;
  };
  const BGS = ['--jp-bg', '--jp-bg-subtle', '--jp-surface'];
  const PAIRS: [string, string, number][] = [
    ...BGS.map((bg): [string, string, number] => ['--jp-fg', bg, 7]),
    ...BGS.map((bg): [string, string, number] => ['--jp-fg-muted', bg, 4.5]),
    ...[...BGS, '--jp-primary-soft'].map((bg): [string, string, number] => ['--jp-link', bg, 4.5]),
    ['--jp-on-primary', '--jp-primary', 4.5],
    ['--jp-on-primary', '--jp-primary-hover', 4.5],
    ['--jp-on-primary', '--jp-primary-active', 4.5],
    ['--jp-on-accent', '--jp-accent', 4.5],
    ['--jp-on-accent', '--jp-accent-hover', 4.5],
    ['--jp-on-danger', '--jp-danger', 4.5],
    ['--jp-success', '--jp-success-bg', 4.5],
    ['--jp-warning', '--jp-warning-bg', 4.5],
    ['--jp-danger', '--jp-danger-bg', 4.5],
    ['--jp-info', '--jp-info-bg', 4.5],
    ...['--jp-success', '--jp-warning', '--jp-danger', '--jp-info'].map((s): [string, string, number] => [s, '--jp-bg', 4.5]),
    ...['--jp-success-bg', '--jp-warning-bg', '--jp-danger-bg', '--jp-info-bg'].map((bg): [string, string, number] => ['--jp-fg', bg, 4.5]),
    ...[...BGS, '--jp-primary-soft'].map((bg): [string, string, number] => ['--jp-focus', bg, 3]),
    ['--jp-ink-fg', '--jp-ink-surface', 7],
    ['--jp-ink-muted', '--jp-ink-surface', 4.5],
    ['--jp-ink-link', '--jp-ink-surface', 4.5],
  ];

  for (const scheme of ['light', 'dark'] as const) {
    it(`meet WCAG AA in ${scheme}`, () => {
      const v = schemes[scheme];
      const failing = PAIRS.flatMap(([fg, bg, min]) => {
        const [a, b] = [resolve(v, fg), resolve(v, bg)];
        if (!a || !b) return [`${fg} on ${bg}: missing`];
        const r = contrast(a, b);
        return r >= min ? [] : [`${fg} ${a} on ${bg} ${b}: ${r.toFixed(2)} < ${min}`];
      });
      expect(failing).toEqual([]);
    });
  }

  it('keep the brand teal and the stamp orange apart from the state colours: red never means brand', () => {
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const scheme of ['light', 'dark'] as const) {
      const v = schemes[scheme];
      const danger = hue(resolve(v, '--jp-danger')!);
      expect(Math.abs(hue(resolve(v, '--jp-primary')!) - danger), scheme).toBeGreaterThan(60);
      expect(Math.abs(hue(resolve(v, '--jp-accent')!) - danger), scheme).toBeGreaterThan(10);
    }
  });
});

describe('components', () => {
  const css = text('components.css');

  it('load nothing (the one data: URI is the select chevron) and read colours only from the tokens', () => {
    expect(css).not.toMatch(/@import|@font-face|https?:\/\/(?!www\.w3\.org\/2000\/svg)/u);
    expect([...css.matchAll(/url\(/gu)]).toHaveLength(1);
    const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/url\("data:[^"]*"\)/gu, '');
    expect(stripped.match(/#[0-9a-f]{3,8}\b/giu) ?? []).toEqual([]);
  });

  it('style only .jp-* classes', () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/gu, '');
    const selectors = [...body.matchAll(/([^{}@]+)\{[^{}]*\}/gu)].map((m) => m[1]!.trim()).filter(Boolean);
    for (const s of selectors) for (const part of s.split(',')) expect(part, s).toMatch(/\.jp-|\[class[*^]=" ?jp-"\]/u);
  });

  it('the AA fixes: the danger button reads --jp-on-danger, the primary badge --jp-link (both pairs are in the tokens’ AA list)', () => {
    expect(css).toContain('.jp-btn-danger{background:var(--jp-danger);color:var(--jp-on-danger)}');
    expect(css).toContain('.jp-badge-primary{background:var(--jp-primary-soft);color:var(--jp-link);border-color:transparent}');
  });
});

describe('logo', () => {
  it('the files are plain SVG, and the mark’s geometry in code is the files’', () => {
    for (const f of readdirSync(here('logo/'))) {
      const svg = text(`logo/${f}`);
      expect(svg, f).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
      expect(svg, f).not.toMatch(/<script|on\w+=|href=|<image|<foreignObject|style=/iu);
      expect(svg, f).toContain('aria-label="Journear Passport"');
    }
    const mark = text('logo/journear-mark.svg');
    const fr = MARK_FRAME;
    expect(mark).toContain(`<rect x="${fr.x}" y="${fr.y}" width="${fr.width}" height="${fr.height}" rx="${fr.rx}" fill="none" stroke="#0F766E" stroke-width="${fr.strokeWidth}"/>`);
    for (const d of MARK_CHEVRON.paths) expect(mark).toContain(`d="${d}"`);
  });

  it('markSvg draws the mark from the tokens, at least 20 px, with a clean label or hidden', () => {
    expect(markSvg()).toContain('stroke="var(--jp-primary)"');
    expect(markSvg()).toContain('stroke="var(--jp-accent)"');
    expect(markSvg()).toContain('aria-hidden="true"');
    expect(markSvg({ size: 8 })).toContain('height="20"');
    expect(markSvg({ mono: true })).not.toContain('var(--jp-');
    expect(markSvg({ label: 'Journear "x" <b>' })).toContain('aria-label="Journear x b"');
  });

  it('the names users read', () => {
    expect(BRAND).toEqual({ company: 'Journear', product: 'Journear Passport', home: 'Passport Home', badge: 'Secured by Journear Passport' });
  });
});
