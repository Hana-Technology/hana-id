// D853 on the stamps site: the words people read (its notices, errors, slots, labels and page) hold no chain or
// engineering jargon (`@hana-id/brand/plain-words`). The one exception is the judges' legend of what each stamp proves
// (`STAMP_PROOFS`), which stays technical under a heading that says so (`UI_TEXT.proofs`): its sentences are allowed by
// exact string, nothing else is. Codes are fine (`near_page_rpc_failed` is not a word).
import { readFileSync } from 'node:fs';
import { jargonIn, sentencesIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../../src/collector.ts';
import { CONTRACT_ERRORS } from '../../src/stamps.ts';
import { STAMP_PROOFS, UI_TEXT } from '../../src/ui/labels.ts';

const ROOT = new URL('../../', import.meta.url);
const FILES = ['src/messages.ts', 'src/view.ts', 'src/app.ts', 'src/ui/labels.ts', 'src/ui/index.ts'];
const LEGEND: ReadonlySet<string> = new Set(Object.values(STAMP_PROOFS));

describe('plain words on the stamps site (D853)', () => {
  it('no sentence people read holds a banned word, the labelled legend aside', () => {
    const found: string[] = [];
    const check = (where: string, s: string) => {
      if (LEGEND.has(s)) return;
      const words = jargonIn(s);
      if (words.length > 0) found.push(`${where}: [${words.join(', ')}] ${s.slice(0, 120)}`);
    };
    for (const f of FILES) for (const s of sentencesIn(readFileSync(new URL(f, ROOT), 'utf8'))) check(f, s);
    for (const s of Object.values(STAGES)) check('collector STAGES', s);
    for (const s of Object.values(CONTRACT_ERRORS)) check('stamps CONTRACT_ERRORS', s);
    const html = readFileSync(new URL('index.html', ROOT), 'utf8');
    for (const m of html.matchAll(/content="([^"]+)"|>([^<>]+)</gu)) check('index.html', (m[1] ?? m[2] ?? '').trim());
    expect(found).toEqual([]);
  });

  it('the legend is technical on purpose, and its heading says so', () => {
    expect(UI_TEXT.proofs).toMatch(/technical explanation/u);
    expect(Object.values(STAMP_PROOFS).some((s) => jargonIn(s).length > 0)).toBe(true);
  });

  it('every error says whether anything was lost or sent, and what to do', () => {
    for (const s of Object.values(CONTRACT_ERRORS).filter((x) => !/^(Collect your Arrival|You already hold|The postcard needs)/u.test(x))) expect(s, s).toMatch(/Nothing was (lost|sent)/u);
  });
});
