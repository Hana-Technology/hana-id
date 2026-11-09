#!/usr/bin/env node
// `pnpm deps:audit`: known-vulnerability check of the dependencies (security sweep OPER-9, D453): `pnpm audit --prod`
// over the workspace and `cargo audit` over each Cargo.lock. Fails on any advisory not triaged in
// scripts/dep-audit-allow.json, or triaged with a passed `reviewBy`, so an exception is looked at again rather than
// kept for good. Runs in the CI job `audit` and in `pnpm verify --full`; needs the network, and cargo-audit
// (`cargo install cargo-audit --locked`). No dependencies beyond Node's standard library: CI runs it before any install.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CARGO_LOCKS = ['contracts/hana-signer/Cargo.lock', 'contracts/integration-tests/Cargo.lock', 'contracts/mock-mpc/Cargo.lock'];
/** Where a `pnpm audit` finding is, in the allow list's `where`. */
export const NPM = 'npm';

/** @returns {{ id: string, name: string, version: string, title: string, where: string }[]} */
export function parsePnpm(report) {
  if (!report || typeof report.advisories !== 'object' || report.advisories === null) throw new Error('pnpm audit gave no report');
  return Object.values(report.advisories).map((a) => ({
    id: a.github_advisory_id,
    name: a.module_name,
    version: [...new Set(a.findings.map((f) => f.version))].join(', '),
    title: a.title,
    where: NPM,
  }));
}

/** Vulnerabilities only: cargo-audit's unmaintained and unsound notices are warnings there too. */
export function parseCargo(report, lock) {
  if (!report || !Array.isArray(report.vulnerabilities?.list)) throw new Error(`cargo audit gave no report for ${lock}`);
  return report.vulnerabilities.list.map((v) => ({ id: v.advisory.id, name: v.package.name, version: v.package.version, title: v.advisory.title, where: lock }));
}

/**
 * Splits findings into triaged ones and the ones that fail the check: no entry, an entry for other places, or an entry
 * whose `reviewBy` (YYYY-MM-DD, valid through that day) has passed.
 */
export function triage(findings, allow, today) {
  const allowed = [];
  const failing = [];
  for (const f of findings) {
    const entry = Object.hasOwn(allow, f.id) ? allow[f.id] : undefined;
    if (!entry || !entry.where.includes(f.where)) failing.push({ ...f, why: 'not triaged' });
    else if (entry.reviewBy < today) failing.push({ ...f, why: `triage expired on ${entry.reviewBy}` });
    else allowed.push(f);
  }
  return { allowed, failing };
}

/** An allow-list entry must say why and until when: a bare id is refused. */
export function allowListProblems(allow) {
  const problems = [];
  for (const [id, e] of Object.entries(allow)) {
    if (typeof e.reason !== 'string' || e.reason.length < 20) problems.push(`${id}: needs a reason`);
    if (typeof e.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(e.reviewBy)) problems.push(`${id}: reviewBy must be YYYY-MM-DD`);
    if (!Array.isArray(e.where) || e.where.length === 0 || !e.where.every((w) => w === NPM || CARGO_LOCKS.includes(w))) problems.push(`${id}: where must name "npm" or a Cargo.lock`);
  }
  return problems;
}

/** Runs a tool that exits non-zero when it finds something; only its JSON counts. */
function json(cmd, args, what) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what} gave no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
}

function main() {
  const allow = JSON.parse(readFileSync(join(ROOT, 'scripts', 'dep-audit-allow.json'), 'utf8'));
  const problems = allowListProblems(allow);
  if (problems.length) throw new Error(`scripts/dep-audit-allow.json:\n  ${problems.join('\n  ')}`);
  if (spawnSync('cargo', ['audit', '--version'], { encoding: 'utf8' }).status !== 0) throw new Error('cargo-audit is not installed: cargo install cargo-audit --locked');
  const findings = parsePnpm(json('pnpm', ['audit', '--prod', '--json'], 'pnpm audit'));
  for (const lock of CARGO_LOCKS) findings.push(...parseCargo(json('cargo', ['audit', '--json', '--file', lock], `cargo audit (${lock})`), lock));
  const { allowed, failing } = triage(findings, allow, new Date().toISOString().slice(0, 10));
  for (const f of allowed) console.log(`triaged  ${f.id}  ${f.name} ${f.version}  (${f.where})`);
  for (const f of failing) console.log(`FAIL     ${f.id}  ${f.name} ${f.version}  (${f.where}): ${f.why}: ${f.title}`);
  console.log(`${findings.length} advisories: ${allowed.length} triaged, ${failing.length} failing`);
  return failing.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
