// The plain-wording rule's check for the rendered window (D853): no chain jargon above the fold, in Journear's own
// words. Left out: the folded details (technical on purpose), code values (addresses, account ids, methods, the raw
// bytes of a message), a message's own text and the values a request names in bold (an asset code, a recipient).
import { afterAll, expect } from 'vitest';
import { shortId } from '@hana-id/core/decode';
import { ZERO_COST, ZERO_COST_ALLOWED, jargonWords } from '../../../core/test/plain-words.ts';

/** The window's own words above the fold. */
export function plainAboveFold(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const n of Array.from(copy.querySelectorAll('details, code, pre, dd strong'))) n.remove();
  return (copy.textContent ?? '').replace(/\s+/gu, ' ');
}

/** Collects every rendered window of a test file and fails the file if any says jargon above the fold. */
export function jargonWatch(): (el: Element) => Element {
  const hits: string[] = [];
  afterAll(() => expect(hits).toEqual([]));
  return (el) => {
    const words = plainAboveFold(el);
    const m = jargonWords(words);
    if (m.length > 0) hits.push(`“${m.join('”, “')}” in: ${words}`);
    // The renderer's own fixed rows and notes too (review of PR 80): no claim that the request costs nothing, outside
    // the allowlist (the demo check-in's sentences).
    const z = ZERO_COST.exec(ZERO_COST_ALLOWED.reduce((t, a) => t.split(a).join(' '), words));
    if (z) hits.push(`zero-cost claim “${z[0]}” in: ${words}`);
    hits.push(...idProblems(el));
    return el;
  };
}

/**
 * D859's rules on a rendered window, above the fold: every short form in a sentence is the short form of a value
 * written out whole in a row (the same value), hidden from screen readers with a spoken pointer; every whole value has
 * exactly one row; a numbered value ("account 1") has a row labelled with its number; no sentence (outside the rows)
 * holds a value that has a row; and D876's: every whole value is in one piece. Returns what breaks them.
 */
export function idProblems(el: Element): string[] {
  const out: string[] = [];
  const above = [...el.children].filter((c) => !c.matches('details'));
  const q = (sel: string) => above.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]);
  const fulls = q('dl.id-rows dd').map((dd) => dd.textContent ?? '');
  const norm = (v: string) => (/^0x[0-9a-fA-F]{40}$/u.test(v) ? v.toLowerCase() : v);
  const counts = new Map<string, number>();
  for (const f of fulls) counts.set(norm(f), (counts.get(norm(f)) ?? 0) + 1);
  for (const [f, n] of counts) if (n !== 1) out.push(`${f} has ${n} rows`);
  for (const s of q('code.short-id')) {
    if (s.closest('p.account')) continue;
    const short = s.textContent ?? '';
    if (!fulls.some((f) => shortId(f) === short)) out.push(`short form ${short} has no row with its whole value`);
    if (s.getAttribute('aria-hidden') !== 'true') out.push(`short form ${short} is read aloud`);
    // The spoken pointer, when there is one, points the right way: to its row below, or above.
    const hint = s.nextElementSibling?.matches('.sr-only') ? s.nextElementSibling.textContent : null;
    const row = q('dl.id-rows dd').find((dd) => shortId(dd.textContent ?? '') === short);
    if (hint && row) {
      const below = (s.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (hint !== (below ? ' (written out below)' : ' (written out above)')) out.push(`short form ${short} says “${hint}” but its row is ${below ? 'below' : 'above'}`);
    }
  }
  // D876: each whole value is in one piece: one text node, no spaces, groups or other elements inside it.
  for (const c of q('code.id-full')) {
    const v = c.textContent ?? '';
    if (c.childNodes.length !== 1 || c.firstChild?.nodeType !== 3 || /\s/u.test(v)) out.push(`${v} isn’t shown in one piece`);
  }
  const labels = q('dl.id-rows dt').map((dt) => dt.textContent ?? '');
  for (const n of q('.id-number')) if (!labels.some((l) => l.endsWith(`(${n.textContent})`))) out.push(`${n.textContent} has no row`);
  // A sentence never repeats a whole value that has its own row (it would be the place a look-alike hides).
  const sentences = q('h2.summary-headline, p.summary-line, p.risk-lead, ul.risk-more > li').map((x) => {
    const c = x.cloneNode(true) as Element;
    for (const r of Array.from(c.querySelectorAll('dl.id-rows'))) r.remove();
    return c.textContent ?? '';
  });
  for (const f of fulls) if (sentences.some((t) => t.includes(f))) out.push(`${f} is whole in a sentence as well as its row`);
  return out;
}

/** What a sighted user reads in `n`: its text without the screen-reader-only words (D859's "(written out below)"). */
export function shownText(n: Element | null | undefined): string | undefined {
  if (!n) return undefined;
  const copy = n.cloneNode(true) as Element;
  for (const x of Array.from(copy.querySelectorAll('.sr-only'))) x.remove();
  return copy.textContent ?? '';
}
