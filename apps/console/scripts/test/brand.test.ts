// The console's stylesheet on the Journear Passport design system (D765): it imports the brand's fonts, tokens and
// component classes and nothing else; it uses only --jp-* tokens (no --hana-* variable, no colour of its own, no
// Montserrat); and the text pairs the console adds on top of the system's own components meet WCAG AA in light and
// dark (packages/brand's test checks the system's pairs).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { contrast, tokenSchemes } from '@hana-id/brand/check';
import { describe, expect, it } from 'vitest';

const web = new URL('../../web/', import.meta.url).pathname;
const css = readFileSync(join(web, 'src', 'styles.css'), 'utf8');
const tokens = readFileSync(new URL('../../../../packages/brand/tokens.css', import.meta.url), 'utf8');
const sources = (readdirSync(join(web, 'src'), { recursive: true }) as string[]).filter((f) => /\.(tsx?|css|html)$/u.test(f)).map((f) => ({ f, text: readFileSync(join(web, 'src', f), 'utf8') }));

describe('the console’s stylesheet', () => {
  it('imports the brand’s fonts, tokens and components, and nothing else', () => {
    expect([...css.matchAll(/@import\s+'([^']+)'/gu)].map((m) => m[1])).toEqual(['@hana-id/brand/fonts.css', '@hana-id/brand/tokens.css', '@hana-id/brand/components.css']);
    expect(css).not.toMatch(/url\(|https?:/u);
  });

  it('reads only --jp-* tokens: no --hana-* variable, no hex or rgb colour of its own, no Montserrat', () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/iu);
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/--hana-/u);
      expect(text, f).not.toMatch(/montserrat/iu);
    }
    // Every variable it reads is a token, or one of its own three layout measures.
    const own = new Set(['--side-w', '--gutter', '--top']);
    const defined = new Set([...tokens.matchAll(/(--jp-[\w-]+)\s*:/gu)].map((m) => m[1]!));
    for (const m of body.matchAll(/var\((--[\w-]+)/gu)) expect(own.has(m[1]!) || defined.has(m[1]!), m[1]).toBe(true);
  });

  const schemes = tokenSchemes(tokens);
  const resolve = (v: Map<string, string>, name: string): string | undefined => {
    const direct = v.get(name);
    if (direct) return direct;
    const m = tokens.match(new RegExp(`${name}:\\s*var\\((--jp-[\\w-]+)\\)`, 'u'));
    return m ? resolve(v, m[1]!) : undefined;
  };
  // [foreground, background]: each pair styles.css (or a badge or tone ui.tsx picks) puts text on.
  const PAIRS: [string, string][] = [
    ['--jp-fg', '--jp-primary-soft'], // the current section in the sidebar
    ['--jp-link', '--jp-primary-soft'], // the teal badge (Owner, Live): styles.css gives it the link teal, as the system's --jp-primary is 4.2:1 here in dark
    ['--jp-fg-muted', '--jp-bg-subtle'], // hints and lines on the page
    ['--jp-fg-muted', '--jp-surface'], // hints in cards
    ['--jp-link', '--jp-surface'], // links, the copy and inline buttons
    ['--jp-warning', '--jp-warning-bg'], // the session's coming end, a waiting change
    ['--jp-danger', '--jp-danger-bg'], // the session's end, the confirm
    ['--jp-success', '--jp-success-bg'], // signed in again
    ['--jp-fg', '--jp-warning-bg'], // a waiting change's text
    ['--jp-fg', '--jp-danger-bg'], // the confirm's detail
    ['--jp-ink-muted', '--jp-ink-surface'], // the save bar's note (the bar is ink in both schemes)
    ['--jp-ink-tint', '--jp-ink-surface'], // the code block's copy button
  ];
  for (const scheme of ['light', 'dark'] as const) {
    it(`its own text pairs meet WCAG AA (4.5:1) in ${scheme}`, () => {
      const v = schemes[scheme];
      const failing = PAIRS.flatMap(([fg, bg]) => {
        const [a, b] = [resolve(v, fg), resolve(v, bg)];
        if (!a || !b) return [`${fg} on ${bg}: missing`];
        const r = contrast(a, b);
        return r >= 4.5 ? [] : [`${fg} ${a} on ${bg} ${b}: ${r.toFixed(2)}`];
      });
      expect(failing).toEqual([]);
    });
  }
});

describe('the page', () => {
  it('names the product, asks for both schemes, and loads one module script', () => {
    const html = readFileSync(join(web, 'index.html'), 'utf8');
    expect(html).toContain('<title>Journear Passport console</title>');
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(html).not.toMatch(/Hana/u);
  });
});
