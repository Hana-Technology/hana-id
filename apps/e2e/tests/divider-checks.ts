// The approval and consent windows' dividers (D884's note, 2026-11-23), measured on the page as the browser draws it:
// where two ruled blocks meet there is one line, never two with nothing between them; no rule sits at a group's edge
// against a box's own border; no ruled block is empty; and the space above a rule matches the space below it.
//
// A "line" is any drawn top or bottom border inside the window's content (`div.request`, `div.consent`): a rule (a
// border with no side borders: `dl.jp-kv`, an operation's top rule) or a box's edge (an alert, the details box, a
// quoted or signed message's box). Two lines that overlap across the page with no text, control or other line between
// them read as a doubled divider, unless both are box edges (two boxes stacked are two boxes).
import { type Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/** How far apart two lines can be and still read as one doubled divider when nothing is between them. */
export const DOUBLE_WITHIN_PX = 48;
/** How much the space above a rule may differ from the space below it (sub-pixel layout). */
export const EVEN_WITHIN_PX = 1.5;

/** What breaks the rules on the window on show, as readable lines (empty when none). */
export async function dividerProblems(popup: Page): Promise<string[]> {
  return popup.evaluate(
    ({ doubleWithin, evenWithin }) => {
      const roots = [...document.querySelectorAll('div.request:not([data-shown]), div.consent')];
      type Line = { y: number; x1: number; x2: number; box: boolean; el: Element; side: 'top' | 'bottom' };
      type Rect = { top: number; bottom: number; x1: number; x2: number };
      const lines: Line[] = [];
      const content: Rect[] = [];
      const name = (el: Element) => {
        const cls = [...el.classList].join('.');
        const text = (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
        return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} “${text}”`;
      };
      const drawn = (s: CSSStyleDeclaration, side: 'Top' | 'Bottom' | 'Left' | 'Right') =>
        parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
        s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
        !/rgba\([^)]*,\s*0\)|transparent/u.test(s.getPropertyValue(`border-${side.toLowerCase()}-color`));
      for (const root of roots) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (!el.checkVisibility()) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const s = getComputedStyle(el);
          const box = drawn(s, 'Left') && drawn(s, 'Right');
          // A line's place is the middle of its border.
          if (drawn(s, 'Top')) lines.push({ y: r.top + parseFloat(s.borderTopWidth) / 2, x1: r.left, x2: r.right, box, el, side: 'top' });
          if (drawn(s, 'Bottom')) lines.push({ y: r.bottom - parseFloat(s.borderBottomWidth) / 2, x1: r.left, x2: r.right, box, el, side: 'bottom' });
          // A control, or the space kept for what Copy did (approve-page.ts, ui.ts reservedLine): content, not a gap.
          if (el.matches('svg, img, button, input, select, textarea, .copy-said')) content.push({ top: r.top, bottom: r.bottom, x1: r.left, x2: r.right });
        }
        // Text, measured by the box of the block it is set in (a dt, dd, p, h3): the space a rule keeps is CSS's (padding,
        // gap), the same above and below whatever the font's own metrics.
        const blocks = new Set<Element>();
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          let el = n.parentElement;
          if (!(n.textContent ?? '').trim() || !el?.checkVisibility()) continue;
          while (el && el !== root && /^(inline|contents)/u.test(getComputedStyle(el).display)) el = el.parentElement;
          if (el) blocks.add(el);
        }
        for (const el of blocks) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) content.push({ top: r.top, bottom: r.bottom, x1: r.left, x2: r.right });
        }
      }
      const overlaps = (a: { x1: number; x2: number }, b: { x1: number; x2: number }) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0.5 * Math.min(a.x2 - a.x1, b.x2 - b.x1);
      const problems: string[] = [];
      lines.sort((a, b) => a.y - b.y);
      for (const [i, a] of lines.entries()) {
        // The next line down that overlaps this one across the page.
        const b = lines.slice(i + 1).find((l) => l.y > a.y + 0.5 && overlaps(a, l));
        if (!b || b.y - a.y > doubleWithin || (a.box && b.box)) continue;
        // Something between them: text, a control or a block that starts or ends there (one around both is their container).
        const between = content.some((c) => c.bottom > a.y + 0.5 && c.top < b.y - 0.5 && !(c.top <= a.y && c.bottom >= b.y) && overlaps(c, { x1: Math.max(a.x1, b.x1), x2: Math.min(a.x2, b.x2) }));
        if (between) continue;
        if (a.el === b.el) problems.push(`empty: ${name(a.el)} draws two lines around nothing`);
        else problems.push(`double: ${a.side} of ${name(a.el)} and ${b.side} of ${name(b.el)} are ${Math.round(b.y - a.y)} px apart with nothing between`);
      }
      // A rule's space above and below: to the nearest text, control or other line over the same stretch.
      for (const a of lines) {
        if (a.box) continue;
        const marks = [...content, ...lines.filter((l) => l !== a).map((l) => ({ top: l.y, bottom: l.y, x1: l.x1, x2: l.x2 }))].filter((c) => overlaps(c, a));
        const above = Math.max(...marks.filter((c) => c.bottom <= a.y - 0.5).map((c) => c.bottom));
        const below = Math.min(...marks.filter((c) => c.top >= a.y + 0.5).map((c) => c.top));
        if (!Number.isFinite(above) || !Number.isFinite(below)) continue;
        const up = a.y - above;
        const down = below - a.y;
        if (Math.abs(up - down) > evenWithin) problems.push(`uneven: ${a.side} rule of ${name(a.el)} has ${up.toFixed(1)} px above and ${down.toFixed(1)} px below`);
      }
      return problems;
    },
    { doubleWithin: DOUBLE_WITHIN_PX, evenWithin: EVEN_WITHIN_PX },
  );
}

/**
 * Checks the window on show, folded and (when it has them) with the details open; restores the details' state. `soft`
 * records a failure and carries on (the screenshot specs: every screen is still saved).
 */
export async function expectEvenDividers(popup: Page, label = '', o: { soft?: boolean } = {}): Promise<void> {
  const check = o.soft ? expect.soft : expect;
  const details = popup.locator('details.request-details');
  const has = (await details.count()) > 0;
  const wasOpen = has ? await details.first().evaluate((d) => (d as HTMLDetailsElement).open) : false;
  for (const open of has ? [false, true] : [false]) {
    if (has) await details.first().evaluate((d, o) => ((d as HTMLDetailsElement).open = o), open);
    check(await dividerProblems(popup), `${label}${has ? (open ? ' (details open)' : ' (details folded)') : ''}`).toEqual([]);
  }
  if (has) await details.first().evaluate((d, o) => ((d as HTMLDetailsElement).open = o), wasOpen);
}
