// The GitHub Actions workflows stay free and safe in a public repository (D857; docs/operations.md "CI and git"):
// every job on a standard GitHub-hosted runner (larger runners are billed even for public repositories), every
// action pinned to a commit, no `pull_request_target` (a fork's PR would run with secrets and a write token), read-only
// permissions at the top of each workflow and no write grant in CI, every artifact small-lived (at most 3 days), a
// timeout on every job. Parsed with a real YAML parser, so a flow-style or quoted value can't slip past.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { uses?: string; with?: Record<string, unknown>; if?: string; run?: string; env?: Record<string, unknown> };
type Job = { 'runs-on'?: unknown; 'timeout-minutes'?: unknown; permissions?: unknown; steps?: Step[]; uses?: string; environment?: unknown; env?: Record<string, unknown> };
type Workflow = { on?: unknown; permissions?: unknown; jobs?: Record<string, Job> };

const DIR = join(repoRoot, '.github', 'workflows');
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/u.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
/** The file without its comments (a `#` at a line's start or after a space): what GitHub runs, not what it says. */
const code = (f: string) => read(f).replace(/(^|\s)#.*$/gmu, '$1');
const load = (f: string) => parse(read(f)) as Workflow;
/** The `on:` triggers' names (a string, a list or a map). */
const triggers = (on: unknown): string[] => (typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys((on as object) ?? {}));
const steps = (w: Workflow) => Object.entries(w.jobs ?? {}).flatMap(([id, j]) => (j.steps ?? []).map((s) => ({ id, s })));

/** The permission scopes a workflow or job may hold at the top: read-only, or none. */
function onlyRead(p: unknown): boolean {
  if (p === undefined) return false; // the repository default applies (write for this repo): always state it
  if (typeof p === 'object' && p !== null && !Array.isArray(p)) return Object.values(p).every((v) => v === 'read' || v === 'none');
  return false; // 'read-all' / 'write-all' / anything else: broader than needed
}

describe('every workflow', () => {
  it('finds the three workflows', () => {
    expect(files).toEqual(['ci.yml', 'identity-probe.yml', 'publish-sdk.yml']);
  });

  for (const f of files) {
    describe(f, () => {
      const w = load(f);
      const jobs = Object.entries(w.jobs ?? {});

      it('has jobs', () => expect(jobs.length).toBeGreaterThan(0));

      it('runs every job on ubuntu-latest (a standard runner; a larger one is billed even when public)', () => {
        for (const [id, j] of jobs) expect(j['runs-on'], `${f} ${id}`).toBe('ubuntu-latest');
      });

      it('gives every job a timeout of at most an hour', () => {
        for (const [id, j] of jobs) {
          expect(typeof j['timeout-minutes'], `${f} ${id}`).toBe('number');
          expect(j['timeout-minutes'] as number, `${f} ${id}`).toBeGreaterThan(0);
          expect(j['timeout-minutes'] as number, `${f} ${id}`).toBeLessThanOrEqual(60);
        }
      });

      it('pins every action to a full commit SHA (no reusable workflows, no local or docker actions)', () => {
        for (const [id, j] of jobs) expect(j.uses, `${f} ${id}: a reusable workflow`).toBeUndefined();
        for (const { id, s } of steps(w)) if (s.uses !== undefined) expect(s.uses, `${f} ${id}`).toMatch(/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/u);
        // A `uses:` the parser didn't see as a step's (a typo'd key) still has to be pinned.
        for (const m of code(f).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gmu)) expect(m[1], `${f}`).toMatch(/@[0-9a-f]{40}$/u);
      });

      it('never uses pull_request_target or workflow_run (they run with secrets and a write token for fork code)', () => {
        expect(triggers(w.on)).not.toContain('pull_request_target');
        expect(triggers(w.on)).not.toContain('workflow_run');
        expect(code(f)).not.toContain('pull_request_target');
      });

      it('holds read-only permissions at the top', () => {
        expect(onlyRead(w.permissions), JSON.stringify(w.permissions)).toBe(true);
      });

      it('checks every downloaded file against a sha256 pinned in the workflow (no unverified binary runs)', () => {
        for (const [id, j] of jobs) {
          for (const st of j.steps ?? []) {
            const run = st.run ?? '';
            const downloads = [...run.matchAll(/\b(?:curl|wget)\b[^\n]*/gu)].map((m) => m[0]);
            if (downloads.length === 0) continue;
            const where = `${f} ${id}: ${downloads[0]}`;
            // Fetching a page into a pipe that runs it is never allowed.
            expect(run, where).not.toMatch(/\b(?:curl|wget)\b[^\n]*\|\s*(?:ba|z)?sh\b/u);
            // Every download writes a file (-o / -O), and as many checks as downloads follow it.
            for (const d of downloads) expect(d, where).toMatch(/\s-(?:o|O)\s|\s-\w*[oO]\s/u);
            expect((run.match(/sha256sum -c -/gu) ?? []).length, where).toBeGreaterThanOrEqual(downloads.length);
            // Each check reads a pinned hash: a *_SHA256 variable of 64 hex characters in the step's or the job's env.
            const env = { ...(j.env ?? {}), ...(st.env ?? {}) };
            const pinned = Object.entries(env).filter(([k, v]) => /_SHA256$/u.test(k) && /^[0-9a-f]{64}$/u.test(String(v))).map(([k]) => k);
            expect(pinned.length, where).toBeGreaterThan(0);
            for (const m of run.matchAll(/echo "\$\{?(\w+)\}?\s+[^"]+" \| sha256sum -c -/gu)) expect(pinned, where).toContain(m[1]);
            expect((run.match(/echo "\$\{?\w+\}?\s+[^"]+" \| sha256sum -c -/gu) ?? []).length, where).toBe((run.match(/sha256sum -c -/gu) ?? []).length);
          }
        }
      });

      it('keeps every artifact at most 3 days', () => {
        for (const { id, s } of steps(w)) {
          if (!s.uses?.startsWith('actions/upload-artifact@')) continue;
          const days = s.with?.['retention-days'];
          expect(typeof days, `${f} ${id}: retention-days`).toBe('number');
          expect(days as number, `${f} ${id}`).toBeGreaterThan(0);
          expect(days as number, `${f} ${id}`).toBeLessThanOrEqual(3);
        }
      });
    });
  }
});

describe('ci.yml', () => {
  const w = load('ci.yml');
  const jobs = Object.entries(w.jobs ?? {});

  it('runs on PRs, after a merge into next, develop or main, and by hand; no schedule (D857)', () => {
    const on = w.on as Record<string, { branches?: string[] } | null>;
    expect(Object.keys(on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(on.push?.branches).toEqual(['develop', 'next', 'main']);
  });

  it('grants no job a write permission, and only the changes job anything beyond contents: read', () => {
    expect(w.permissions).toEqual({ contents: 'read' });
    for (const [id, j] of jobs) {
      if (j.permissions === undefined) continue;
      expect(onlyRead(j.permissions), `${id}: ${JSON.stringify(j.permissions)}`).toBe(true);
      if (id !== 'changes') expect(j.permissions, id).toEqual({ contents: 'read' });
    }
    expect(jobs.find(([id]) => id === 'changes')?.[1].permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('reads no secret and uses no environment (a fork PR gets neither; nothing here should need one)', () => {
    // An expression naming the secrets context (`secrets.X`, `secrets['X']`, `toJSON(secrets)`), or passing them on.
    for (const m of code('ci.yml').matchAll(/\$\{\{([^}]*)\}\}/gu)) expect(m[1], m[0]).not.toMatch(/\bsecrets\b/u);
    expect(code('ci.yml')).not.toMatch(/secrets:\s*inherit/u);
    for (const [id, j] of jobs) expect(j.environment, id).toBeUndefined();
  });

  it('leaves no credentials in any checkout', () => {
    for (const { id, s } of steps(w)) if (s.uses?.startsWith('actions/checkout@')) expect(s.with?.['persist-credentials'], id).toBe(false);
  });

  it('uploads artifacts only on a failure', () => {
    const uploads = steps(w).filter(({ s }) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(uploads.length).toBeGreaterThan(0);
    for (const { id, s } of uploads) expect(s.if, id).toMatch(/^failure\(\)/u);
  });

  it('cancels a superseded run of the same PR or branch', () => {
    expect((parse(read('ci.yml')) as { concurrency?: unknown }).concurrency).toEqual({ group: 'ci-${{ github.event_name }}-${{ github.ref }}', 'cancel-in-progress': true });
  });
});
