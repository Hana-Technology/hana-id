// The supply-chain checks of the sweep's "before mainnet" items: the publish workflow's shape and gate (OPER-4, D451),
// the sandbox binary's pin (OPER-8, D452) and the dependency advisory check (OPER-9, D453). CI is off (D387), so these
// are what keeps the workflow files right until it returns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';

type Finding = { id: string; name: string; version: string; title: string; where: string };
type Allow = Record<string, { where: string[]; reviewBy: string; reason: string }>;
interface DepAudit {
  CARGO_LOCKS: string[];
  NPM: string;
  parsePnpm(report: unknown): Finding[];
  parseCargo(report: unknown, lock: string): Finding[];
  triage(findings: Finding[], allow: Allow, today: string): { allowed: Finding[]; failing: (Finding & { why: string })[] };
  allowListProblems(allow: unknown): string[];
}
interface PublishGate {
  PUBLISH_ENVIRONMENT: string;
  publishGate(o: { repoToken?: string; ref?: string; environment: unknown; branchPolicies: unknown }): { ready: boolean; error?: string; notice?: string };
}
const script = (name: string) => pathToFileURL(join(repoRoot, 'scripts', name)).href;
const { allowListProblems, CARGO_LOCKS, NPM, parseCargo, parsePnpm, triage } = (await import(script('dep-audit.mjs'))) as DepAudit;
const { PUBLISH_ENVIRONMENT, publishGate } = (await import(script('publish-gate.mjs'))) as PublishGate;

const workflow = (name: string) => readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8');

function jobOf(yml: string, id: string): string {
  const start = yml.indexOf(`\n  ${id}:\n`);
  expect(start, id).toBeGreaterThan(0);
  const next = yml.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/u);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

describe('publish-sdk.yml (OPER-4)', () => {
  const yml = workflow('publish-sdk.yml');
  const publish = jobOf(yml, 'publish');
  const build = jobOf(yml, 'build');
  const gate = jobOf(yml, 'gate');

  it('takes the token only in a job on the protected environment, gated to main at the job level', () => {
    expect(publish).toContain(`environment: ${PUBLISH_ENVIRONMENT}`);
    expect(publish).toContain("if: needs.gate.outputs.ready == 'true' && github.ref == 'refs/heads/main'");
    expect(publish).toContain('secrets.NPM_TOKEN');
    expect(build).not.toContain('secrets.');
  });

  it('keeps install, tests and OIDC apart: the job with id-token installs and runs nothing of the repo', () => {
    expect(publish).toContain('id-token: write');
    expect(publish).not.toMatch(/pnpm|actions\/checkout/u);
    expect(build).not.toContain('id-token');
    expect(gate).not.toContain('id-token');
    expect(build).toContain('pnpm install --frozen-lockfile');
    expect(yml.split('\njobs:\n')[0]).toContain('contents: read');
  });

  it('the gate job has no environment, so its NPM_TOKEN can only be a repository or organisation one', () => {
    expect(gate).not.toContain('environment:');
    expect(gate).toContain('REPO_NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(gate).toContain('node scripts/publish-gate.mjs');
    expect(gate).toContain(`environments/${PUBLISH_ENVIRONMENT}`);
  });

  it('pins every action to a commit', () => {
    for (const m of yml.matchAll(/uses: (\S+)/gu)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/u);
  });
});

describe('publishGate', () => {
  const main = 'refs/heads/main';
  const environment = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const mainOnly = { branch_policies: [{ name: 'main', type: 'branch' }] };

  it('is ready on main with the environment limited to main and no repository token', () => {
    expect(publishGate({ ref: main, environment, branchPolicies: mainOnly })).toEqual({ ready: true });
  });

  it('skips with a notice while the environment is not set up (or unreadable): nothing is published', () => {
    const out = publishGate({ ref: main, environment: null, branchPolicies: null });
    expect(out.ready).toBe(false);
    expect(out.error).toBeUndefined();
    expect(out.notice).toContain('not set up');
  });

  it('fails the run on a repository or organisation NPM_TOKEN, whatever else holds', () => {
    const out = publishGate({ repoToken: 'set', ref: main, environment, branchPolicies: mainOnly });
    expect(out.ready).toBe(false);
    expect(out.error).toContain('repository or organisation secret');
  });

  it('fails off main', () => {
    for (const ref of ['refs/heads/develop', 'refs/tags/sdk-v1.0.0']) expect(publishGate({ ref, environment, branchPolicies: mainOnly }).error, ref).toContain('main only');
  });

  it('fails unless the environment allows exactly the branch main', () => {
    const bad: [unknown, unknown][] = [
      [{ deployment_branch_policy: null }, mainOnly],
      [{ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, mainOnly],
      [environment, { branch_policies: [] }],
      [environment, { branch_policies: [{ name: 'main' }, { name: 'develop' }] }],
      [environment, { branch_policies: [{ name: '*' }] }],
      [environment, { branch_policies: [{ name: 'main', type: 'tag' }] }],
      [environment, null],
    ];
    for (const [env, branchPolicies] of bad) expect(publishGate({ ref: main, environment: env, branchPolicies }).error, JSON.stringify([env, branchPolicies])).toContain('main only');
  });
});

describe('ci.yml supply chain', () => {
  const yml = workflow('ci.yml');

  it('installs the sandbox binary checksum-verified, for the version the locked crate uses (OPER-8)', () => {
    const e2e = jobOf(yml, 'e2e');
    expect(e2e).toMatch(/NEAR_SANDBOX_SHA256: [0-9a-f]{64}\n/u);
    expect(e2e).toContain('sha256sum -c -');
    expect(e2e).toContain('NEAR_SANDBOX_BIN_PATH=');
    expect(e2e.indexOf('NEAR_SANDBOX_BIN_PATH=')).toBeLessThan(e2e.indexOf('run: cargo test --locked'));
    // A near-sandbox bump changes the binary it would fetch: re-pin NEAR_SANDBOX_VERSION and its hash with it.
    const lock = readFileSync(join(repoRoot, 'contracts', 'integration-tests', 'Cargo.lock'), 'utf8');
    const crate = /name = "near-sandbox"\nversion = "([^"]+)"/u.exec(lock)?.[1];
    expect(e2e).toContain(`NEAR_SANDBOX_CRATE: ${crate}\n`);
  });

  it('checks dependency advisories on every event, cargo-audit checksum-verified (OPER-9)', () => {
    const audit = jobOf(yml, 'audit');
    expect(audit).not.toContain('needs.changes');
    expect(audit).not.toContain('if:');
    expect(audit).toMatch(/CARGO_AUDIT_SHA256: [0-9a-f]{64}\n/u);
    expect(audit).toContain('sha256sum -c -');
    expect(audit).toContain('run: node scripts/dep-audit.mjs');
  });
});

describe('dep-audit (OPER-9)', () => {
  const finding = (id: string, where = NPM) => ({ id, name: 'x', version: '1', title: 't', where });
  const allow = { 'GHSA-a': { where: [NPM], reviewBy: '2026-12-31', reason: 'a reason long enough to read' } };

  it('reads pnpm and cargo reports', () => {
    expect(parsePnpm({ advisories: { 1: { github_advisory_id: 'GHSA-a', module_name: 'x', title: 't', findings: [{ version: '1' }, { version: '1' }, { version: '2' }] } } })).toEqual([
      { id: 'GHSA-a', name: 'x', version: '1, 2', title: 't', where: NPM },
    ]);
    const lock = CARGO_LOCKS[0]!;
    expect(parseCargo({ vulnerabilities: { list: [{ advisory: { id: 'RUSTSEC-1', title: 't' }, package: { name: 'x', version: '1' } }] } }, lock)).toEqual([{ id: 'RUSTSEC-1', name: 'x', version: '1', title: 't', where: lock }]);
  });

  it('a report it cannot read is an error, never a pass', () => {
    expect(() => parsePnpm({ error: { code: 'ERR' } })).toThrow(/no report/u);
    expect(() => parseCargo({}, CARGO_LOCKS[0]!)).toThrow(/no report/u);
  });

  it('fails what is not triaged, triaged elsewhere, or past its review date', () => {
    const today = '2026-11-09';
    expect(triage([finding('GHSA-a')], allow, today)).toMatchObject({ allowed: [{ id: 'GHSA-a' }], failing: [] });
    expect(triage([finding('GHSA-b')], allow, today).failing).toMatchObject([{ id: 'GHSA-b', why: 'not triaged' }]);
    expect(triage([finding('GHSA-a', CARGO_LOCKS[0]!)], allow, today).failing).toMatchObject([{ why: 'not triaged' }]);
    expect(triage([finding('__proto__')], allow, today).failing).toMatchObject([{ why: 'not triaged' }]);
    expect(triage([finding('GHSA-a')], allow, '2026-12-31').allowed).toHaveLength(1);
    expect(triage([finding('GHSA-a')], allow, '2027-01-01').failing).toMatchObject([{ why: 'triage expired on 2026-12-31' }]);
  });

  it('the allow list is well formed: a reason, a date and a place for every entry', () => {
    const file = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'dep-audit-allow.json'), 'utf8'));
    expect(allowListProblems(file)).toEqual([]);
    expect(allowListProblems({ x: { where: [NPM], reviewBy: 'soon', reason: 'short' } })).toEqual(['x: needs a reason', 'x: reviewBy must be YYYY-MM-DD']);
    expect(allowListProblems({ x: { where: ['nowhere'], reviewBy: '2026-12-31', reason: 'a reason long enough to read' } })).toEqual(['x: where must name "npm" or a Cargo.lock']);
  });

  it('covers every Cargo.lock of the contracts', () => {
    expect(CARGO_LOCKS).toEqual(['contracts/hana-signer/Cargo.lock', 'contracts/integration-tests/Cargo.lock', 'contracts/mock-mpc/Cargo.lock']);
  });
});
