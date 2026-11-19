// The plain-wording rule (D853) and D859's rules on a real approval window, as the browser shows it: no chain jargon
// above the fold, no zero-cost claim outside the allowlist, every short form the short form of a value written out
// whole in exactly one row, hidden from screen readers. The same words and rules as the unit tests'
// (packages/core/test/plain-words.ts, packages/web/test/auth/plain-words.ts), here through the real flow.
import { type Page } from '@playwright/test';
import { shortId } from '@hana-id/core/decode';
import { ZERO_COST, ZERO_COST_ALLOWED, ZERO_COST_ALLOWED_REVIEWED, jargonWords } from '../../../packages/core/test/plain-words.ts';
import { expect } from './fixtures.ts';

/** Checks the window on show; fails the test with what breaks the rules. */
export async function expectPlainWindow(popup: Page): Promise<void> {
  const seen = await popup.evaluate(() => {
    const req = document.querySelector('div.request');
    if (!req) return null;
    const above = [...req.children].filter((c) => !c.matches('details'));
    const copy = above.map((c) => {
      const x = c.cloneNode(true) as Element;
      for (const n of Array.from(x.querySelectorAll('details, code, pre, dd strong, .sr-only, div.summary-quote'))) n.remove();
      return x.textContent ?? '';
    });
    const all = (sel: string) => above.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]);
    return {
      reviewed: req.hasAttribute('data-reviewed'),
      words: copy.join(' ').replace(/\s+/gu, ' '),
      shorts: all('code.short-id').map((c) => ({ text: c.textContent ?? '', hidden: c.getAttribute('aria-hidden') === 'true' })),
      fulls: all('dl.id-rows dd').map((dd) => dd.textContent ?? ''),
    };
  });
  if (!seen) return;
  const problems: string[] = [];
  const j = jargonWords(seen.words);
  if (j.length > 0) problems.push(`jargon “${j.join('”, “')}”`);
  // A reviewed NEAR call's own sentences only on a reviewed screen (D885).
  const allowed = [...ZERO_COST_ALLOWED, ...(seen.reviewed ? ZERO_COST_ALLOWED_REVIEWED : [])];
  const z = ZERO_COST.exec(allowed.reduce((t, a) => t.split(a).join(' '), seen.words));
  if (z) problems.push(`zero-cost claim “${z[0]}”`);
  const norm = (v: string) => (/^0x[0-9a-fA-F]{40}$/u.test(v) ? v.toLowerCase() : v);
  const counts = new Map<string, number>();
  for (const f of seen.fulls) counts.set(norm(f), (counts.get(norm(f)) ?? 0) + 1);
  for (const [f, n] of counts) if (n !== 1) problems.push(`${f} has ${n} rows`);
  for (const s of seen.shorts) {
    if (!seen.fulls.some((f) => shortId(f) === s.text)) problems.push(`short form ${s.text} has no row`);
    if (!s.hidden) problems.push(`short form ${s.text} is read aloud`);
  }
  expect(problems, seen.words).toEqual([]);
}
