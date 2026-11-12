// The brand package (D426 as amended by D765): the fonts are the design system's three OFL families and nothing else,
// each with its licence beside it; fonts.css loads only those files, from beside itself; the tokens are the design
// system's and meet WCAG AA in light and dark, with state colours kept apart from the brand; components.css loads
// nothing and reads only the tokens; the logo files are plain SVG written from the logo's geometry in code (D789).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, tokenSchemes, woff2Names } from '../src/check.ts';
import {
  BRAND,
  FONT_FILES,
  FONT_LICENCE_FILES,
  FONT_UNICODE_RANGE,
  LOCKUP,
  LOGO_COLOURS,
  LOGO_FILES,
  logoFile,
  MARK_BRACKET,
  MARK_CARD,
  MARK_SQUARE_VIEWBOX,
  MARK_VIEWBOX,
  markSvg,
  PASSPORT_PATH,
  WORDMARK_PATH,
} from '../src/index.ts';

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

/** The exact bounds of an absolute SVG path of M, L, H, V, Q and Z commands (what the logo's paths use). */
function bounds(d: string, transform = { x: 0, y: 0, s: 1 }): [number, number, number, number] {
  const tokens = d.match(/[MLHVQZ]|-?\d*\.?\d+/gu)!;
  expect(d.replace(/[MLHVQZ]|-?\d*\.?\d+|[\s,]/gu, ''), 'only absolute M, L, H, V, Q, Z').toBe('');
  const b = [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number];
  const add = (x: number, y: number) => {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  };
  let [x, y, cmd, i] = [0, 0, '', 0];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Z]/u.test(tokens[i]!)) cmd = tokens[i++]!;
    if (cmd === 'Z') continue;
    if (cmd === 'H') x = num();
    else if (cmd === 'V') y = num();
    else if (cmd === 'Q') {
      const [cx, cy, ex, ey] = [num(), num(), num(), num()];
      // A quadratic's extreme on an axis is at t = (p0 - p1) / (p0 - 2 p1 + p2), when that is inside (0, 1).
      for (const t of [(x - cx) / (x - 2 * cx + ex), (y - cy) / (y - 2 * cy + ey)]) {
        if (t > 0 && t < 1) add((1 - t) ** 2 * x + 2 * (1 - t) * t * cx + t * t * ex, (1 - t) ** 2 * y + 2 * (1 - t) * t * cy + t * t * ey);
      }
      [x, y] = [ex, ey];
    } else [x, y] = [num(), num()];
    add(x, y);
  }
  const { x: tx, y: ty, s } = transform;
  return [tx + b[0] * s, ty + b[1] * s, tx + b[2] * s, ty + b[3] * s];
}
const union = (...bs: [number, number, number, number][]) =>
  bs.reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
const box = (viewBox: string) => {
  const [x, y, w, h] = viewBox.split(' ').map(Number) as [number, number, number, number];
  return [x, y, x + w, y + h] as const;
};
const transformOf = (t: string) => {
  const m = /^translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.]+)\)$/u.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) };
};

describe('logo', () => {
  it('logo/ holds the mark and lockup files src/logo.ts writes (pnpm --filter @hana-id/brand logo) and the wordmarks', () => {
    const wordmarks = ['journear-wordmark.svg', 'journear-wordmark-ink.svg', 'journear-wordmark-white.svg'];
    expect(readdirSync(here('logo/')).sort()).toEqual([...LOGO_FILES, ...wordmarks].sort());
    for (const f of LOGO_FILES) expect(text(`logo/${f}`), `${f}: run pnpm --filter @hana-id/brand logo`).toBe(logoFile(f));
    // The wordmark files are the same outline as the lockup's "Journear".
    for (const f of wordmarks) expect(/\sd="([^"]+)"/u.exec(text(`logo/${f}`))![1], f).toBe(WORDMARK_PATH);
  });

  it('the files are plain SVG: one <svg>, no live text, nothing that loads, runs or styles', () => {
    for (const f of readdirSync(here('logo/'))) {
      const svg = text(`logo/${f}`);
      expect(svg, f).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
      expect(svg, f).not.toMatch(/<script|on\w+=|href=|<image|<foreignObject|style=|<text|<use|font-/iu);
      // No nested <svg> (a sanitiser or an inlining page may drop or mis-size it): one root, flattened with transforms.
      expect(svg.match(/<svg\b/gu), f).toHaveLength(1);
      expect(svg, f).toContain('aria-label="Journear Passport"');
    }
  });

  it('the mark is the supplied artwork’s two shapes, as they are (D789)', () => {
    expect(MARK_CARD).toBe('M19 83 Q12 83 15 74 L26 38 Q28 31 35 28 L92 8 Q101 5 98 15 L89 55 Q87 64 79 67 L23 83 Q21 84 19 83 Z');
    expect(MARK_BRACKET).toBe('M31 94 Q24 96 23 90 Q22 85 29 83 L87 67 Q94 65 96 57 L105 24 Q107 18 112 20 Q117 22 115 29 L106 69 Q104 78 96 81 L34 94 Z');
    const mark = text('logo/journear-mark.svg');
    expect(mark).toContain(`<path fill="${LOGO_COLOURS.teal}" d="${MARK_CARD}"/>`);
    expect(mark).toContain(`<path fill="${LOGO_COLOURS.orange}" d="${MARK_BRACKET}"/>`);
  });

  it('the viewBoxes hold the ink uncropped: the tight one within a unit, the square one centred, the lockup within 3', () => {
    const ink = union(bounds(MARK_CARD), bounds(MARK_BRACKET));
    const tight = box(MARK_VIEWBOX);
    for (const k of [0, 1] as const) expect(tight[k]).toBeLessThanOrEqual(ink[k]);
    for (const k of [2, 3] as const) expect(tight[k]).toBeGreaterThanOrEqual(ink[k]);
    for (const k of [0, 1, 2, 3] as const) expect(Math.abs(tight[k] - ink[k])).toBeLessThan(1);
    const [, , sw, sh] = MARK_SQUARE_VIEWBOX.split(' ').map(Number);
    expect(sw).toBe(sh);
    const sq = box(MARK_SQUARE_VIEWBOX);
    expect(Math.abs(ink[0] - sq[0] - (sq[2] - ink[2]))).toBeLessThan(0.05);
    expect(Math.abs(ink[1] - sq[1] - (sq[3] - ink[3]))).toBeLessThan(0.05);
    expect(ink[0] - sq[0]).toBeGreaterThanOrEqual(0);
    expect(sw! - (ink[2] - ink[0])).toBeLessThan(1);

    const m = transformOf(LOCKUP.mark);
    const lockupInk = union(
      bounds(MARK_CARD, m),
      bounds(MARK_BRACKET, m),
      bounds(LOCKUP.word.d, transformOf(LOCKUP.word.transform)),
      bounds(LOCKUP.sub.d, transformOf(LOCKUP.sub.transform)),
    );
    const lb = box(LOCKUP.viewBox);
    expect(LOCKUP.viewBox.split(' ').slice(2).map(Number)).toEqual([LOCKUP.width, LOCKUP.height]);
    for (const k of [0, 1] as const) expect(lockupInk[k] - lb[k]).toBeGreaterThanOrEqual(1);
    for (const k of [2, 3] as const) expect(lb[k] - lockupInk[k]).toBeGreaterThanOrEqual(1);
    for (const k of [0, 1] as const) expect(lockupInk[k] - lb[k]).toBeLessThan(3);
    for (const k of [2, 3] as const) expect(lb[k] - lockupInk[k]).toBeLessThan(3);
    // "PASSPORT" sits under "Journear", smaller (the logo rules: never as big as the wordmark).
    const word = bounds(LOCKUP.word.d, transformOf(LOCKUP.word.transform));
    const sub = bounds(LOCKUP.sub.d, transformOf(LOCKUP.sub.transform));
    expect(sub[1]).toBeGreaterThan(word[3]);
    expect(sub[3] - sub[1]).toBeLessThan((word[3] - word[1]) / 2);
    expect(PASSPORT_PATH.length).toBeGreaterThan(0);
  });

  it('the logo’s colours are the tokens’ (teal, stamp orange, ink), and the dark lockup reads on the ink ground', () => {
    const css = text('tokens.css');
    const { light } = tokenSchemes(css);
    expect(LOGO_COLOURS.teal.toLowerCase()).toBe(light.get('--jp-teal-500'));
    expect(LOGO_COLOURS.orange.toLowerCase()).toBe(light.get('--jp-orange-500'));
    expect(LOGO_COLOURS.ink.toLowerCase()).toBe(light.get('--jp-teal-900'));
    const lockup = text('logo/journear-lockup.svg');
    expect(lockup.match(/fill="#[0-9A-F]{6}"/gu)).toEqual([`fill="${LOGO_COLOURS.teal}"`, `fill="${LOGO_COLOURS.orange}"`, `fill="${LOGO_COLOURS.ink}"`, `fill="${LOGO_COLOURS.ink}"`]);
    const white = text('logo/journear-lockup-white.svg');
    expect(white.match(/fill="#[0-9A-F]{6}"/gu)).toEqual([`fill="${LOGO_COLOURS.teal}"`, `fill="${LOGO_COLOURS.orange}"`, `fill="${LOGO_COLOURS.white}"`, `fill="${LOGO_COLOURS.white}"`]);
    expect(new Set(text('logo/journear-lockup-mono.svg').match(/fill="#[0-9A-F]{6}"/gu))).toEqual(new Set([`fill="${LOGO_COLOURS.ink}"`]));
    expect(new Set(text('logo/journear-mark-mono.svg').match(/fill="#[0-9A-F]{6}"/gu))).toEqual(new Set([`fill="${LOGO_COLOURS.ink}"`]));
    expect(new Set(text('logo/journear-mark-white.svg').match(/fill="#[0-9A-F]{6}"/gu))).toEqual(new Set([`fill="${LOGO_COLOURS.white}"`]));
    // On the ink ground (journear_passport_dark.svg's): the teal card at 3:1 or more (a graphic), white type at AA.
    expect(contrast(LOGO_COLOURS.teal, LOGO_COLOURS.ink)).toBeGreaterThanOrEqual(3);
    expect(contrast(LOGO_COLOURS.orange, LOGO_COLOURS.ink)).toBeGreaterThanOrEqual(3);
    expect(contrast(LOGO_COLOURS.white, LOGO_COLOURS.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it('markSvg draws the mark in the logo’s colours, at least 20 px, with a clean label or hidden', () => {
    expect(markSvg()).toContain(`<path fill="var(--jp-teal-500)" d="${MARK_CARD}"/>`);
    expect(markSvg()).toContain(`<path fill="var(--jp-orange-500)" d="${MARK_BRACKET}"/>`);
    expect(markSvg()).toContain(`viewBox="${MARK_VIEWBOX}"`);
    expect(markSvg()).toContain('aria-hidden="true"');
    expect(markSvg({ size: 8 })).toContain('height="20"');
    expect(markSvg({ size: 44 })).toContain('width="51" height="44"');
    expect(markSvg({ mono: true })).not.toContain('var(--jp-');
    expect(markSvg({ label: 'Journear "x" <b>' })).toContain('aria-label="Journear x b"');
  });

  it('the names users read', () => {
    expect(BRAND).toEqual({ company: 'Journear', product: 'Journear Passport', home: 'Passport Home', badge: 'Secured by Journear Passport' });
  });
});
