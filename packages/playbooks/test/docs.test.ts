// docs/playbooks.md is generated from the package: this fails when the committed file is stale.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLAYBOOKS } from '../src/index.ts';
import { DOC_PATH, renderMarkdown } from '../src/markdown.ts';

const committed = () => readFileSync(fileURLToPath(new URL(`../../../${DOC_PATH}`, import.meta.url)), 'utf8');

describe(DOC_PATH, () => {
  it('is up to date (run `corepack pnpm --filter @hana-id/playbooks gen-docs`)', () => {
    expect(committed()).toBe(renderMarkdown());
  });

  it('has an anchor, a heading and every step of every playbook', () => {
    const md = renderMarkdown();
    for (const p of PLAYBOOKS) {
      expect(md).toContain(`<a id="${p.id}"></a>`);
      expect(md).toContain(`### ${p.title}`);
      for (const s of p.steps) expect(md).toContain(`**${s.title}** (who: ${s.who})`);
    }
  });

  it('is deterministic', () => {
    expect(renderMarkdown()).toBe(renderMarkdown());
  });
});
