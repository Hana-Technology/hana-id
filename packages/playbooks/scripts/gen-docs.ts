// Writes docs/playbooks.md from the playbooks: `corepack pnpm --filter @hana-id/playbooks gen-docs`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOC_PATH, renderMarkdown } from '../src/markdown.ts';

const file = fileURLToPath(new URL(`../../../${DOC_PATH}`, import.meta.url));
writeFileSync(file, renderMarkdown());
console.log(`wrote ${DOC_PATH}`);
