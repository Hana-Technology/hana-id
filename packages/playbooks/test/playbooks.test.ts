// The playbooks are well-formed and grounded: unique ids, valid actors, refs that point at real decisions and doc
// headings, and commands that exist (scripts and their flags in the repo; anything else verbatim in a runbook).
// That every watchdog alert kind has a playbook is checked next to the registry, in apps/watchdog/test/registry.test.ts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTORS, getPlaybook, PLAYBOOKS, playbookForAlertKind } from '../src/index.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DECISION_RE = /^D\d{1,4}$/u;
const DOC_REF_RE = /^(?:docs\/[a-z0-9-]+\.md|apps\/[a-z0-9-]+\/README\.md|README\.md)(?:#[a-z0-9_-]+)?$/u;

/** GitHub's heading anchors: lowercased, punctuation dropped (except `-` and `_`), spaces to hyphens, `-n` for repeats. */
function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const m = !inFence && /^#{1,6} (.+)$/u.exec(line);
    if (!m) continue;
    const base = m[1]!
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /gu, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n ? `${base}-${n}` : base);
  }
  return slugs;
}

const allSteps = PLAYBOOKS.flatMap((p) => p.steps.map((s) => ({ p, s })));
const allCommands = allSteps.flatMap(({ p, s }) => (s.commands ?? []).map((cmd) => ({ p, s, cmd })));

describe('playbook ids and shape', () => {
  it('ids are unique, kebab-case and short', () => {
    const ids = PLAYBOOKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, id).toMatch(ID_RE);
      expect(id.length, id).toBeLessThanOrEqual(48);
    }
  });

  it('alert playbooks list alert kinds, each in one playbook only; incident playbooks list none', () => {
    const kinds = PLAYBOOKS.flatMap((p) => p.alertKinds ?? []);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const p of PLAYBOOKS) {
      if (p.kind === 'alert') {
        expect(p.alertKinds?.length, p.id).toBeGreaterThan(0);
        for (const k of p.alertKinds!) {
          expect(k, p.id).toMatch(/^[a-z][a-z_]*$/u);
          expect(playbookForAlertKind(k)?.id).toBe(p.id);
        }
      } else expect(p.alertKinds, p.id).toBeUndefined();
    }
  });

  it('every playbook has signals, impact, ordered steps with a valid actor, and a way to verify', () => {
    for (const p of PLAYBOOKS) {
      for (const field of ['title', 'summary'] as const) expect(p[field].trim(), `${p.id} ${field}`).not.toBe('');
      for (const field of ['signals', 'impact', 'steps', 'verify', 'refs'] as const) expect(p[field].length, `${p.id} ${field}`).toBeGreaterThan(0);
      for (const s of p.steps) {
        expect(ACTORS, `${p.id}: ${s.title}`).toContain(s.who);
        expect(s.title.trim() && s.detail.trim(), `${p.id}: ${s.title}`).toBeTruthy();
      }
      const text = [p.title, p.summary, ...p.signals, ...p.impact, ...p.verify, ...p.followUps, ...p.steps.flatMap((s) => [s.title, s.detail])];
      for (const t of text) expect(t, p.id).not.toMatch(/[\r\n]/u);
    }
  });

  it('planned playbooks say so; live ones are for built features', () => {
    for (const p of PLAYBOOKS) expect(['live', 'planned'], p.id).toContain(p.status);
    expect(getPlaybook('email-issuer-key-compromised')?.status).toBe('planned');
  });
});

describe('refs and links', () => {
  const decisions = read('docs/decisions.md');

  it('refs are unique per playbook and well-formed', () => {
    for (const p of PLAYBOOKS) {
      expect(new Set(p.refs).size, p.id).toBe(p.refs.length);
      for (const r of p.refs) expect(DECISION_RE.test(r) || DOC_REF_RE.test(r), `${p.id}: ${r}`).toBe(true);
    }
  });

  it('decision refs exist in docs/decisions.md', () => {
    for (const p of PLAYBOOKS) for (const r of p.refs.filter((x) => DECISION_RE.test(x))) expect(decisions, `${p.id}: ${r}`).toMatch(new RegExp(`^### ${r}\\. `, 'mu'));
  });

  it('doc refs name an existing file and one of its headings', () => {
    for (const p of PLAYBOOKS) {
      for (const r of p.refs.filter((x) => !DECISION_RE.test(x))) {
        const [path, anchor] = r.split('#');
        expect(existsSync(join(root, path!)), `${p.id}: ${r}`).toBe(true);
        if (anchor) expect([...headingSlugs(read(path!))], `${p.id}: ${r}`).toContain(anchor);
      }
    }
  });

  it('related ids are other existing playbooks', () => {
    for (const p of PLAYBOOKS) {
      for (const id of p.related ?? []) {
        expect(getPlaybook(id), `${p.id} -> ${id}`).toBeDefined();
        expect(id).not.toBe(p.id);
      }
    }
  });

  it('every playbook id named in a step or a follow-up exists', () => {
    const ids = new Set(PLAYBOOKS.map((p) => p.id));
    // A word that looks like a playbook id (two or more kebab parts ending in a playbook-ish noun) must be one.
    for (const { p, s } of allSteps) {
      for (const m of s.detail.matchAll(/\b(?:follow|see|go to) ([a-z0-9]+(?:-[a-z0-9]+)+)/giu)) expect(ids, `${p.id}: ${s.title}: ${m[1]}`).toContain(m[1]);
      for (const m of s.detail.matchAll(/\(([a-z0-9]+(?:-[a-z0-9]+)+)(?:'s [^)]*)?\)/gu)) if (!m[1]!.includes('_')) expect(ids, `${p.id}: ${s.title}: ${m[1]}`).toContain(m[1]);
    }
  });
});

describe('commands', () => {
  const pkgDirs: Record<string, string> = { scripts: 'scripts', watchdog: 'apps/watchdog', api: 'apps/api', web: 'packages/web', playbooks: 'packages/playbooks' };
  const scriptsSource = [
    ...readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.ts')).map((f) => read(`scripts/${f}`)),
    ...readdirSync(join(root, 'scripts/lib')).filter((f) => f.endsWith('.ts')).map((f) => read(`scripts/lib/${f}`)),
  ].join('\n');
  const ownerMethods = new Set([...(/OWNER_METHODS = \[([^\]]+)\]/u.exec(read('scripts/lib/contract.ts'))?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!));
  // Runbook commands, with `\`-continued lines joined and whitespace collapsed.
  const runbooks = ['docs/operations.md', 'apps/watchdog/README.md', 'README.md', 'docs/api.md']
    .map(read)
    .join('\n')
    .replace(/\\\n\s*/gu, ' ')
    .replace(/[ \t]+/gu, ' ');
  /** Commands that aren't verbatim in a runbook, each with the documented command it adapts. */
  const ADAPTED: Record<string, string> = {
    'near account delete-keys <watchdog.account> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send': 'the relayer key deletion in docs/operations.md "Relayer keys", for the watchdog account',
    'mv .secrets/<env>/keys-updater.json .secrets/<env>/keys-updater.revoked-<yyyymmdd>.json': 'docs/operations.md "Keys-updater key": "move .secrets/<env>/keys-updater.json aside" (the drill kept keys-updater.revoked-<date>.json)',
  };
  const isWatchdogRoute = (cmd: string) => /^curl -H "authorization: Bearer \$\(jq -r \.WATCHDOG_STATUS_TOKEN \.secrets\/<env>\/watchdog-secrets\.json\)" '?https:\/\/<workerName>\.<subdomain>\.workers\.dev\/(?:status|alerts\?severity=critical|actions)'?$/u.test(cmd);

  it('use placeholders, never a real account, env or secret', () => {
    for (const { p, cmd } of allCommands) {
      expect(cmd, p.id).not.toMatch(/\.testnet\b|\.near\b(?!-)|sandbox-dev|ed25519:[1-9A-HJ-NP-Za-km-z]{20,}|mainnet/u);
      expect(cmd, p.id).not.toMatch(/[\r\n]/u);
    }
  });

  it('pnpm --filter commands name an existing package script, and scripts flags and subcommands exist', () => {
    for (const { p, cmd } of allCommands) {
      const m = /^corepack pnpm --filter @hana-id\/([a-z]+) (?:run )?(\S+)/u.exec(cmd);
      if (!m) continue;
      const dir = pkgDirs[m[1]!];
      expect(dir, `${p.id}: ${cmd}`).toBeDefined();
      const scripts = (JSON.parse(read(`${dir}/package.json`)) as { scripts: Record<string, string> }).scripts;
      expect(Object.keys(scripts), `${p.id}: ${cmd}`).toContain(m[2]);
      if (m[1] !== 'scripts') continue;
      for (const f of cmd.matchAll(/ --([a-z][a-z-]*)/gu)) expect(scriptsSource.includes(`'${f[1]}'`) || scriptsSource.includes(`--${f[1]}`), `${p.id}: --${f[1]} in ${cmd}`).toBe(true);
      const admin = /^corepack pnpm --filter @hana-id\/scripts run admin <env> (\S+)(?: (\S+))?/u.exec(cmd);
      if (admin) {
        expect(read('scripts/admin.ts'), `${p.id}: ${cmd}`).toContain(`'${admin[1]}'`);
        if (admin[1] === 'owner:call') expect([...ownerMethods], `${p.id}: ${cmd}`).toContain(admin[2]);
      }
    }
  });

  it('every other command is verbatim in a runbook, a watchdog status route, or a listed adaptation', () => {
    for (const { p, cmd } of allCommands) {
      if (cmd.startsWith('corepack pnpm --filter ')) continue;
      const ok = runbooks.includes(cmd) || isWatchdogRoute(cmd) || cmd in ADAPTED;
      expect(ok, `${p.id}: not in the runbooks: ${cmd}`).toBe(true);
    }
  });
});
