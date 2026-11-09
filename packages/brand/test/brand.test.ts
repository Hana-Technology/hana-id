// The brand package (D426): the fonts are Hana's own OFL Montserrat build and nothing else, with the licence beside
// them; fonts.css loads only those files, from beside itself; the tokens meet WCAG AA in light and dark, and the state
// colours never look like a Hana purple.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, tokenSchemes, woff2Names } from '../src/check.ts';
import { FONT_FILES, FONT_LICENCE_FILE, MARK_PATHS } from '../src/index.ts';

const here = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(here(p));

describe('fonts', () => {
  it('fonts/ holds exactly the manifest’s WOFF2 files and the licence', () => {
    expect(readdirSync(here('fonts/')).sort()).toEqual([...FONT_FILES.map((f) => f.file), FONT_LICENCE_FILE].sort());
  });

  it('each file is the manifest’s bytes, a WOFF2 whose own name table says Montserrat and the SIL OFL 1.1', () => {
    for (const f of FONT_FILES) {
      const buf = read(`fonts/${f.file}`);
      expect(createHash('sha256').update(buf).digest('hex'), f.file).toBe(f.sha256);
      const names = woff2Names(buf);
      expect(names.get(1), f.file).toMatch(new RegExp(`^${f.family}\\b`, 'u'));
      expect(names.get(5), f.file).toBe(f.version);
      expect(names.get(0), f.file).toContain('The Montserrat Project Authors');
      expect(names.get(13), f.file).toContain('SIL Open Font License, Version 1.1');
      // Small: a Latin subset, never the full multi-script build.
      expect(buf.length, f.file).toBeLessThan(24_000);
    }
  });

  it('the licence beside them is the full OFL 1.1 with the fonts’ copyright and no Reserved Font Name', () => {
    const ofl = read(`fonts/${FONT_LICENCE_FILE}`).toString('utf8');
    expect(ofl).toContain('Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat)');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(ofl).toContain('PERMISSION & CONDITIONS');
    expect(ofl).toContain('TERMINATION');
    expect(ofl).not.toMatch(/Reserved Font Name "/u);
  });

  it('no commercial face is shipped: Proxima Nova and PP Agrandir stay in Hana’s apps (their licences don’t cover us)', () => {
    const all = readdirSync(here('fonts/')).join(' ') + read('fonts.css').toString('utf8') + read('tokens.css').toString('utf8');
    expect(all).not.toMatch(/proxima|agrandir/iu);
  });

  it('fonts.css declares one face per file, from ./fonts/ beside it, and loads nothing else', () => {
    const css = read('fonts.css').toString('utf8');
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
      expect(face).toMatch(/unicode-range: U\+0000-017F,/u);
    }
  });
});

describe('tokens', () => {
  const css = read('tokens.css').toString('utf8');
  const schemes = tokenSchemes(css);

  it('are variables on :root only, and load nothing', () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{/gu)].map((m) => m[1]!.trim());
    expect(selectors).toEqual([':root', '@media (prefers-color-scheme: dark)', ':root']);
    expect(css).not.toMatch(/url\(|@import|@font-face/u);
  });

  // [foreground, background, minimum]: 4.5 for text, 3 for focus rings and the mark (non-text, WCAG 1.4.11).
  const PAIRS: [string, string, number][] = [
    ...['--hana-bg', '--hana-surface', '--hana-surface-2', '--hana-surface-3'].map((bg): [string, string, number] => ['--hana-ink', bg, 7]),
    ...['--hana-bg', '--hana-surface', '--hana-surface-2', '--hana-surface-3'].map((bg): [string, string, number] => ['--hana-ink-2', bg, 4.5]),
    ...['--hana-bg', '--hana-surface', '--hana-surface-2'].map((bg): [string, string, number] => ['--hana-muted', bg, 4.5]),
    ...['--hana-bg', '--hana-surface', '--hana-surface-2', '--hana-accent-soft'].map((bg): [string, string, number] => ['--hana-accent', bg, 4.5]),
    ['--hana-accent-ink', '--hana-accent', 4.5],
    ['--hana-accent-ink', '--hana-accent-hover', 4.5],
    ['--hana-ink', '--hana-accent-soft', 4.5],
    ['--hana-ok', '--hana-ok-soft', 4.5],
    ['--hana-ok', '--hana-surface', 4.5],
    ['--hana-warn', '--hana-warn-soft', 4.5],
    ['--hana-warn', '--hana-surface', 4.5],
    ['--hana-danger', '--hana-danger-soft', 4.5],
    ['--hana-danger', '--hana-surface', 4.5],
    ['--hana-on-danger', '--hana-danger', 4.5],
    ['--hana-on-danger', '--hana-danger-hover', 4.5],
    ['--hana-ink', '--hana-ok-soft', 4.5],
    ['--hana-ink', '--hana-warn-soft', 4.5],
    ['--hana-ink', '--hana-danger-soft', 4.5],
    ...['--hana-bg', '--hana-surface', '--hana-surface-2', '--hana-accent-soft'].map((bg): [string, string, number] => ['--hana-focus', bg, 3]),
    ['--hana-mark-fg', '--hana-mark-bg', 3],
  ];

  for (const scheme of ['light', 'dark'] as const) {
    it(`meet WCAG AA in ${scheme}`, () => {
      const v = schemes[scheme];
      const failing = PAIRS.flatMap(([fg, bg, min]) => {
        const [a, b] = [v.get(fg), v.get(bg)];
        if (!a || !b) return [`${fg} on ${bg}: missing`];
        const r = contrast(a, b);
        return r >= min ? [] : [`${fg} ${a} on ${bg} ${b}: ${r.toFixed(2)} < ${min}`];
      });
      expect(failing).toEqual([]);
    });

    it(`keep state apart from the brand in ${scheme}: ok, warn and danger are not purple, and differ from the accent`, () => {
      const v = schemes[scheme];
      const hue = (hex: string): number => {
        const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        if (d === 0) return 0;
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (h * 60 + 360) % 360;
      };
      for (const s of ['--hana-ok', '--hana-warn', '--hana-danger']) {
        const h = hue(v.get(s)!);
        // Hana's purples sit at 250°–300° (#3308a8: 256°, #bba8f6: 255°, #d772d3: 302°).
        expect(h < 240 || h > 330, `${s} hue ${h.toFixed(0)}°`).toBe(true);
      }
      expect(Math.abs(hue(v.get('--hana-accent')!) - hue(v.get('--hana-danger')!))).toBeGreaterThan(60);
    });
  }
});

describe('logo', () => {
  it('the mark’s paths in code are the SVG file’s (hana-extension hana.svg), and the files are plain SVG', () => {
    const mark = read('logo/hana-mark.svg').toString('utf8');
    for (const d of MARK_PATHS) expect(mark).toContain(`d="${d}"`);
    for (const f of readdirSync(here('logo/'))) {
      const svg = read(`logo/${f}`).toString('utf8');
      expect(svg, f).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
      expect(svg, f).not.toMatch(/<script|on\w+=|href=|<image|<foreignObject|style=/iu);
    }
  });
});
