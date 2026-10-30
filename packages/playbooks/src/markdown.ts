// Renders docs/playbooks.md from the playbooks (`scripts/gen-docs.ts` writes it; `test/docs.test.ts` fails when the
// committed file differs). Deterministic: same input, same bytes.
import { LAST_VERIFIED, NOTES, PLAYBOOKS } from './index.ts';
import type { Playbook } from './types.ts';

export const DOC_PATH = 'docs/playbooks.md';

const IDS = [...PLAYBOOKS.map((p) => p.id)].sort((a, b) => b.length - a.length);
const ID_RE = new RegExp(`(?<![\\w-])(${IDS.join('|')})(?![\\w-])`, 'gu');

/** Links every playbook id named in prose (outside code spans) to its anchor. */
function linkify(text: string): string {
  return text
    .split(/(`[^`]*`)/u)
    .map((part) => (part.startsWith('`') ? part : part.replace(ID_RE, '[$1](#$1)')))
    .join('');
}

const list = (items: readonly string[]) => items.map((i) => `- ${linkify(i)}`).join('\n');

function section(label: string, items: readonly string[]): string[] {
  return items.length ? [`**${label}**`, '', list(items), ''] : [];
}

function refLink(ref: string): string {
  if (/^D\d+$/u.test(ref)) return `${ref} (\`docs/decisions.md\`)`;
  const [path, anchor] = ref.split('#');
  // Links relative to docs/.
  const rel = path!.startsWith('docs/') ? path!.slice('docs/'.length) : `../${path}`;
  return `[\`${ref}\`](${rel}${anchor ? `#${anchor}` : ''})`;
}

function renderPlaybook(p: Playbook): string {
  const meta = [`\`${p.id}\``, p.severity, ...(p.status === 'planned' ? ['**planned: not built yet**'] : [])];
  if (p.alertKinds?.length) meta.push(`alert kinds: ${p.alertKinds.map((k) => `\`${k}\``).join(', ')}`);
  const out = [`<a id="${p.id}"></a>`, '', `### ${p.title}`, '', meta.join(' · '), '', linkify(p.summary), ''];
  out.push(...section('Signals', p.signals), ...section('Impact', p.impact));
  out.push('**Steps**', '');
  p.steps.forEach((s, i) => {
    out.push(`${i + 1}. **${s.title}** (who: ${s.who}). ${linkify(s.detail)}`);
    if (s.commands?.length) out.push('', '   ```sh', ...s.commands.map((cmd) => `   ${cmd}`), '   ```');
    out.push('');
  });
  out.push(...section('Verify', p.verify), ...section('Follow-ups', p.followUps));
  const tail = [`**Refs:** ${p.refs.map(refLink).join(', ')}`];
  if (p.related?.length) tail.push(`**See also:** ${p.related.map((id) => `[${id}](#${id})`).join(', ')}`);
  out.push(tail.join(' · '), '');
  return out.join('\n');
}

export function renderMarkdown(): string {
  const alerts = PLAYBOOKS.filter((p) => p.kind === 'alert');
  const incidents = PLAYBOOKS.filter((p) => p.kind === 'incident');
  const row = (p: Playbook) =>
    `| [${p.title}](#${p.id}) | ${p.severity}${p.status === 'planned' ? ' (planned)' : ''} | ${p.alertKinds?.map((k) => `\`${k}\``).join(', ') ?? '—'} |`;
  return [
    '# Recovery playbooks',
    '',
    `Generated from \`packages/playbooks\` (D126) by \`corepack pnpm --filter @hana-id/playbooks gen-docs\`: edit the package,`,
    'not this file (a test fails when it is stale). Last verified against code: ' + LAST_VERIFIED + '.',
    '',
    'One step-by-step guide for every watchdog alert kind and for every incident the watchdog does not raise. The admin',
    "portal's \"Security & monitoring\" view renders the same playbooks (`docs/batch-c-spec.md`), and every watchdog",
    'alert names its playbook (`Playbook: <id>` in the alert text, `playbook` in `GET /status` `alert_kinds`). What each',
    'alert kind means: `docs/operations.md` "Watchdog alerts (runbook)".',
    '',
    '## Before you start',
    '',
    list(NOTES),
    '',
    '## Index',
    '',
    '| Playbook | Severity | Alert kinds |',
    '|---|---|---|',
    ...alerts.map(row),
    ...incidents.map(row),
    '',
    '## Alert playbooks',
    '',
    ...alerts.map(renderPlaybook),
    '## Incident playbooks',
    '',
    ...incidents.map(renderPlaybook),
  ]
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\n*$/u, '\n');
}
