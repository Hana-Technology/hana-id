// The plain-wording rule's check for the rendered window (D853): no chain jargon above the fold, in Journear's own
// words. Left out: the folded details (technical on purpose), code values (addresses, account ids, methods, the raw
// bytes of a message), a message's own text and the values a request names in bold (an asset code, a recipient).
import { afterAll, expect } from 'vitest';
import { JARGON } from '../../../core/test/plain-words.ts';

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
    const m = JARGON.exec(words);
    if (m) hits.push(`“${m[0]}” in: ${words}`);
    return el;
  };
}
