// admin.ts labels:check (lib/admin-labels-check.ts, D922 and PR 150's review): every stored Request labels version
// waiting or in force, parsed again with this checkout's parser, on node:sqlite with the real migrations. A valid
// version parses the same as its baseline; one a stricter rule now refuses fails with the rule's code and where; one
// whose lines, rules or attached apps changed since the baseline reads differently, with only the changed lines
// printed. Exit 1 on any of those; read-only; refused on a mainnet env; every printed line display-safe; a baseline
// written by the same commit refused without --same-build; --save only ever creates a new labels-lines-*.json in the
// env's .secrets folder.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseLabelDocument } from '@hana-id/core/partner-labels';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import {
  BASELINE_FORMAT,
  type LabelsBaseline,
  type LabelsBuild,
  type LabelsCheckDeps,
  type LabelsCheckOptions,
  baselineTarget,
  canonicalJson,
  labelsCheck,
  labelsCheckSql,
  linesDiff,
  readBaselineFile,
  renderedLines,
  writeNewSecretJson,
} from '../lib/admin-labels-check.ts';
import { newHotDb, seedHotApp } from './hot-db.ts';
import { testTempDir } from './temp.ts';

const PASSPHRASE = 'Test SDF Network ; September 2015';
/** A random public key nobody holds the secret of (an address book refuses a public seed's account). */
const TILL = 'GC4OI7BDJ3EGZCOJOA3FNHCHQFQ4OKHXKZK6MXS2WFZBVMZ37I2NS4HC';
const NOW = Date.UTC(2026, 10, 25, 9, 0);
const HOUR = 3_600_000;
const DEPLOYED: LabelsBuild = { commit: 'a'.repeat(40), dirty: false, deployed: null };
const TO_DEPLOY: LabelsBuild = { commit: 'b'.repeat(40), dirty: false, deployed: null };

/** A classic payment document (D907's shape): "pay for <object> “1042”", ending with the till's name. */
const paymentDoc = (object: string, o: { name?: string; amountAtMost?: string } = {}): string =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { stellar: { networkPassphrase: PASSPHRASE } },
    metadata: { addressBook: [{ account: TILL, name: o.name ?? 'Coffee Club till' }] },
    display: {
      formats: {
        payment: {
          call: { memo: 'text', assets: ['native'], amountAtMost: o.amountAtMost ?? '1000000000' },
          intent: { verb: 'pay', object },
          sentence: ['verb', { word: 'for' }, 'object', { field: 'memo' }],
          fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }],
        },
      },
    },
  });

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

function db(): DatabaseSync {
  const d = newHotDb();
  seedHotApp(d, { id: 'app_rally', key: 'pk_test_Rallyyyyyyyyyyyyyyyyyyyyy', scope: 's_rally', name: 'Stamp Rally', orgId: 'org_a' });
  seedHotApp(d, { id: 'app_rally2', key: 'pk_test_Rally2yyyyyyyyyyyyyyyyyy', scope: 's_rally', name: 'Rally Two', orgId: 'org_a' });
  d.exec("INSERT INTO partner_labels (id, org_id, scope_id, created_at, created_by) VALUES ('pl_pay', 'org_a', 's_rally', 1, 'usr_1'), ('pl_old', 'org_a', 's_rally', 1, 'usr_1')");
  return d;
}

function addVersion(d: DatabaseSync, id: string, text: string, o: { label?: string; status?: string; notifiedAt?: number | null; activeFrom?: number | null; apps?: string[] } = {}): void {
  d.prepare(
    `INSERT INTO label_changes (id, label_id, org_id, scope_id, doc_text, doc_schema, doc_sha256, doc_bytes, context_key, apps_json, status, proposed_by, proposer_sub, proposed_at, notified_at, active_from, request_id)
     VALUES (?, ?, 'org_a', 's_rally', ?, 'journear-labels/1', ?, ?, ?, ?, ?, 'usr_1', 'sub-1', ?, ?, ?, ?)`,
  ).run(
    id,
    o.label ?? 'pl_pay',
    text,
    sha(text),
    Buffer.byteLength(text),
    `stellar:${PASSPHRASE}`,
    JSON.stringify(o.apps ?? ['app_rally']),
    o.status ?? 'pending',
    NOW - 2 * HOUR,
    o.notifiedAt === undefined ? NOW - HOUR : o.notifiedAt,
    o.activeFrom === undefined ? NOW + HOUR : o.activeFrom,
    `req_${id}`,
  );
}

const ENV_DIR = '/repo/.secrets/local';

/** The deps over a node:sqlite database; files in memory (created exclusively, as writeNewSecretJson); every line kept. */
function deps(d: DatabaseSync, build: LabelsBuild = DEPLOYED) {
  const files = new Map<string, unknown>();
  const lines: string[] = [];
  const statements: string[] = [];
  const state = { build };
  const x: LabelsCheckDeps = {
    read: (s) => {
      statements.push(s);
      return d.prepare(s).all() as Record<string, unknown>[];
    },
    build: () => state.build,
    secretsEnvDir: (env) => `/repo/.secrets/${env}`,
    writeNew: (file, value) => {
      if (files.has(file)) throw new CliError(`${file} already exists`);
      files.set(file, JSON.parse(JSON.stringify(value)));
    },
    readJson: (file) => {
      if (!files.has(file)) throw new Error(`no ${file}`);
      return files.get(file);
    },
    log: (l) => void lines.push(l),
    now: () => new Date(NOW),
  };
  return { x, files, lines, statements, state };
}

const opts = (over: Partial<LabelsCheckOptions> = {}): LabelsCheckOptions => ({ env: 'local', network: 'testnet', database: 'hana-id-local', remote: false, save: false, out: undefined, baseline: undefined, sameBuild: false, ...over });

/** Saves a baseline as the deployed build, then switches the deps to the build to deploy. */
async function saveThenSwitch(t: ReturnType<typeof deps>, name = 'base'): Promise<{ file: string; base: LabelsBaseline }> {
  const file = `${ENV_DIR}/labels-lines-${name}.json`;
  t.state.build = DEPLOYED;
  await labelsCheck(opts({ save: true, out: file }), t.x);
  t.state.build = TO_DEPLOY;
  t.lines.length = 0;
  return { file, base: t.files.get(file) as LabelsBaseline };
}

/** The lines from the count line on (a comparison starts with its two build lines). */
const body = (lines: string[]) => lines.slice(lines.findIndex((l) => l.startsWith('local: ')));

describe('labels:check', () => {
  it('a valid version, one a rule now refuses, one that reads differently: each verdict, exit 1, and only the changed lines printed', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'));
    addVersion(d, 'lc_2renders', paymentDoc('the fare'), { label: 'pl_old', status: 'active', activeFrom: NOW - HOUR });
    // Stored before D907's rule (the phrase and the longest name at most 40 characters): refused now.
    addVersion(d, 'lc_3fails', paymentDoc('the monthly membership renewal'), { notifiedAt: null, activeFrom: null });
    // Not checked: versions no longer waiting or in force.
    addVersion(d, 'lc_4ended', paymentDoc('the monthly membership renewal'), { status: 'ended' });
    const t = deps(d);
    const { file, base } = await saveThenSwitch(t);
    expect(base.format).toBe(BASELINE_FORMAT);
    expect(base.build).toEqual(DEPLOYED);
    expect(Object.keys(base.versions)).toEqual(['lc_1valid', 'lc_2renders']);
    // As an older build read lc_2renders: its payment sentence without the till's name (what D907 added).
    const old = base.versions.lc_2renders!.lines.map(([k, v]): [string, string] => [k, k === 'payment' ? v.replace(/ to “Coffee Club till” \(G[A-Z0-9]+\)/u, '') : v]);
    expect(old).not.toEqual(base.versions.lc_2renders!.lines);
    t.files.set(`${ENV_DIR}/labels-lines-old.json`, { ...base, versions: { ...base.versions, lc_2renders: { ...base.versions.lc_2renders!, lines: old } } });

    expect(await labelsCheck(opts({ baseline: `${ENV_DIR}/labels-lines-old.json` }), t.x)).toBe(1);
    expect(t.lines[0]).toBe('Baseline: written by aaaaaaaaaaaa at 2026-11-25T09:00:00.000Z');
    expect(t.lines[1]).toBe('This checkout: bbbbbbbbbbbb');
    const b = body(t.lines);
    expect(b[0]).toMatch(/^local: hana-id-local \(local\): 3 Request labels versions waiting or in force, compared with \/repo\/\.secrets\/local\/labels-lines-old\.json$/u);
    expect(b[1]).toBe('  lc_1valid (apps app_rally; waiting): parses the same');
    expect(b[2]).toBe('  lc_2renders (apps app_rally; in force): READS DIFFERENTLY:');
    expect(b[3]).toBe('      - payment: Stamp Rally says: pay for the fare “1042” · Order: “1042”');
    expect(b[4]).toMatch(/^ {6}\+ payment: Stamp Rally says: pay for the fare “1042” to “Coffee Club till” \(GC4OI7/u);
    expect(b[5]).toBe('  lc_3fails (apps app_rally; waiting): FAILS: sentence_text at display.formats.payment.intent.object');
    expect(b[6]).toMatch(/^2 versions to propose again/u);
    expect(b).toHaveLength(7);
    // The partner's words appear only in the changed lines: never for the version that parses the same or fails.
    const text = t.lines.join('\n');
    expect(text.match(/Coffee Club till/gu)).toHaveLength(1);
    expect(text).not.toContain('monthly membership');
    expect(text).not.toContain('lc_4ended');
    // Read-only: nothing but SELECTs.
    for (const s of t.statements) expect(s).toMatch(/^SELECT /u);
    expect(file).toBe(`${ENV_DIR}/labels-lines-base.json`);
  });

  it('every version the same: exit 0; renaming the second attached app, or the first, reads differently', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'), { apps: ['app_rally', 'app_rally2'] });
    const t = deps(d);
    expect(await labelsCheck(opts({ save: true }), t.x)).toBe(0);
    const file = [...t.files.keys()][0]!;
    expect(file).toBe(`${ENV_DIR}/labels-lines-20261125T090000000Z.json`);
    t.state.build = TO_DEPLOY;
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: file }), t.x)).toBe(0);
    expect(body(t.lines).slice(1)).toEqual(['  lc_1valid (apps app_rally, app_rally2; waiting): parses the same']);
    // The second app's name is compared too.
    d.exec("UPDATE apps SET name = 'Rally Three' WHERE id = 'app_rally2'");
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: file }), t.x)).toBe(1);
    expect(body(t.lines).slice(1, 4)).toEqual([
      '  lc_1valid (apps app_rally, app_rally2; waiting): READS DIFFERENTLY:',
      '      - (apps): app_rally “Stamp Rally”, app_rally2 “Rally Two”',
      '      + (apps): app_rally “Stamp Rally”, app_rally2 “Rally Three”',
    ]);
    // The first app's name is also in every line ("{App} says:").
    d.exec("UPDATE apps SET name = 'Rally Two' WHERE id = 'app_rally2'");
    d.exec("UPDATE apps SET name = 'Rally One' WHERE id = 'app_rally'");
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: file }), t.x)).toBe(1);
    expect(t.lines.join('\n')).toMatch(/\+ payment: Rally One says:/u);
  });

  it('a deleted attached app reads differently', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'), { apps: ['app_rally', 'app_rally2'] });
    const t = deps(d);
    const { file } = await saveThenSwitch(t);
    d.exec("UPDATE apps SET deleted_at = 5 WHERE id = 'app_rally2'");
    expect(await labelsCheck(opts({ baseline: file }), t.x)).toBe(1);
    expect(t.lines).toContain('      + (apps): app_rally “Stamp Rally”, app_rally2 “Rally Two” (deleted)');
  });

  it('a rule the example lines don’t show (amountAtMost 1000000000 → 5) changes the rules line, so it reads differently', () => {
    const doc = (amountAtMost: string) => {
      const r = parseLabelDocument(paymentDoc('order', { amountAtMost }));
      if (!r.ok) throw new Error('fixture refused');
      return r.document;
    };
    const apps = [{ id: 'app_rally', name: 'Stamp Rally', deleted: false }];
    const a = renderedLines(doc('1000000000'), apps);
    const b = renderedLines(doc('5'), apps);
    // Every example line is the same …
    expect(a.filter(([k]) => !k.startsWith('(rules)'))).toEqual(b.filter(([k]) => !k.startsWith('(rules)')));
    // … but the payment's rules are not.
    const diff = linesDiff(a, b);
    expect(diff).toHaveLength(2);
    expect(diff[0]).toMatch(/^- \(rules\) payment: sha256 [0-9a-f]{16}$/u);
    expect(diff[1]).toMatch(/^\+ \(rules\) payment: sha256 [0-9a-f]{16}$/u);
    expect(a.map(([k]) => k)).toEqual(['(describes)', '(apps)', `(account) ${TILL}`, 'payment', '(rules) context and metadata', '(rules) payment']);
    // The canonical form sorts keys and is the same for the same parsed value.
    expect(canonicalJson({ b: 1, a: [2n, { d: null, c: 'x' }] })).toBe('{"a":["2n",{"c":"x","d":null}],"b":1}');
    expect(canonicalJson(doc('5'))).toBe(canonicalJson(doc('5')));
  });

  it('without a baseline: parse only, said so; a version not in the baseline is not compared and exits 1', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'));
    const t = deps(d, TO_DEPLOY);
    expect(await labelsCheck(opts(), t.x)).toBe(0);
    expect(t.lines).toEqual([
      'local: hana-id-local (local): 1 Request labels version waiting or in force',
      '  lc_1valid (apps app_rally; waiting): parses (lines not compared: no --baseline)',
      'Every version parses; the lines were not compared (run with --baseline to compare them)',
    ]);
    t.files.set('/b.json', { format: BASELINE_FORMAT, env: 'local', database: 'hana-id-local', remote: false, takenAt: new Date(NOW).toISOString(), build: DEPLOYED, versions: {} });
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: '/b.json' }), t.x)).toBe(1);
    expect(t.lines.some((l) => /lc_1valid .*NOT COMPARED: not in the baseline/u.test(l))).toBe(true);
  });

  it('a stored text that no longer matches its sha256 fails; a version past its due time says so', async () => {
    const d = db();
    addVersion(d, 'lc_due', paymentDoc('order'), { activeFrom: NOW - 1 });
    const t = deps(d);
    expect(await labelsCheck(opts(), t.x)).toBe(0);
    expect(t.lines[1]).toBe('  lc_due (apps app_rally; in force from its due time (unless held for review)): parses (lines not compared: no --baseline)');
    const d2 = db();
    const text = paymentDoc('order');
    d2.prepare(
      `INSERT INTO label_changes (id, label_id, org_id, scope_id, doc_text, doc_schema, doc_sha256, doc_bytes, context_key, apps_json, status, proposed_by, proposer_sub, proposed_at, request_id)
       VALUES ('lc_x', 'pl_pay', 'org_a', 's_rally', ?, 'journear-labels/1', ?, 10, 'x', '["app_rally"]', 'pending', 'u', 's', ?, 'r')`,
    ).run(text, 'ab'.repeat(32), NOW);
    const t2 = deps(d2);
    expect(await labelsCheck(opts(), t2.x)).toBe(1);
    expect(t2.lines[1]).toMatch(/lc_x .*FAILS: stored_text_changed/u);
  });

  it('pages through every version, 50 at a time, in id order', async () => {
    const d = db();
    for (let i = 0; i < 120; i += 1) addVersion(d, `lc_${String(i).padStart(3, '0')}`, paymentDoc('order'), { label: i % 2 ? 'pl_pay' : 'pl_old' });
    const t = deps(d);
    expect(await labelsCheck(opts(), t.x)).toBe(0);
    expect(t.statements).toHaveLength(3);
    expect(t.statements[1]).toContain("AND c.id > 'lc_049'");
    expect(t.lines.filter((l) => l.includes('parses (lines'))).toHaveLength(120);
  });

  it('every printed line is display-safe: a partner key with an escape sequence, a baseline’s values, an error naming them', async () => {
    const d = db();
    const evil = '\u001b]0;pwned\u0007\u001b[2J';
    const text = JSON.stringify({ ...JSON.parse(paymentDoc('order')), [evil]: 1 });
    addVersion(d, 'lc_evil', text);
    const t = deps(d);
    expect(await labelsCheck(opts(), t.x)).toBe(1);
    const all = t.lines.join('\n');
    expect(all).toContain('FAILS: unknown_key at ');
    expect(all).toContain('?]0;pwned??[2J');
    // No control, bidi or invisible character reaches the terminal.
    for (const l of t.lines) expect(l).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    // A baseline's own values (its time, its env) are cleaned too, in a line and in a refusal.
    t.files.set(`${ENV_DIR}/labels-lines-x.json`, { format: BASELINE_FORMAT, env: 'local', database: 'hana-id-local', remote: false, takenAt: '\u001b[31mred‮', build: { commit: 'c'.repeat(40), dirty: false, deployed: null }, versions: {} });
    t.lines.length = 0;
    await labelsCheck(opts({ baseline: `${ENV_DIR}/labels-lines-x.json` }), t.x);
    expect(t.lines[0]).toBe('Baseline: written by cccccccccccc at ?[31mred?');
    t.files.set('/e.json', { format: BASELINE_FORMAT, env: 'lo\u001b[2Jcal', database: 'hana-id-local', remote: false, takenAt: 'x', build: DEPLOYED, versions: {} });
    await expect(labelsCheck(opts({ baseline: '/e.json' }), t.x)).rejects.toThrow('--baseline is of lo?[2Jcal, not local');
  });

  it('which code wrote the baseline: printed at compare; this same commit refused unless --same-build; a dirty tree, or a baseline not from the deployed commit, warned', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'));
    const t = deps(d);
    const { file } = await saveThenSwitch(t);
    // The same commit on both sides: refused, then allowed when asked for.
    t.state.build = DEPLOYED;
    await expect(labelsCheck(opts({ baseline: file }), t.x)).rejects.toThrow('The baseline was written by this same commit');
    expect(await labelsCheck(opts({ baseline: file, sameBuild: true }), t.x)).toBe(0);
    await expect(labelsCheck(opts({ sameBuild: true }), t.x)).rejects.toThrow('--same-build is for --baseline');
    // A dirty checkout and a baseline written away from the deployed build are said.
    t.files.set(`${ENV_DIR}/labels-lines-dep.json`, { ...(t.files.get(file) as LabelsBaseline), build: { commit: 'a'.repeat(40), dirty: true, deployed: 'dddddddddddd' } });
    t.state.build = { commit: 'b'.repeat(40), dirty: true, deployed: 'dddddddddddd' };
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: `${ENV_DIR}/labels-lines-dep.json` }), t.x)).toBe(0);
    expect(t.lines.slice(0, 5)).toEqual([
      'Baseline: written by aaaaaaaaaaaa with uncommitted changes at 2026-11-25T09:00:00.000Z; the API then ran dddddddddddd',
      'This checkout: bbbbbbbbbbbb with uncommitted changes; the API runs dddddddddddd',
      'Warning: the baseline was not written from the deployed commit (dddddddddddd): what it holds may not be what the versions were reviewed with',
      'Warning: the baseline was written from a tree with uncommitted changes',
      'Warning: this checkout has uncommitted changes: what it parses is not exactly any commit',
    ]);
    // The saved file records the build it was written by.
    expect((t.files.get(file) as LabelsBaseline).build).toEqual(DEPLOYED);
  });

  it('refuses a mainnet env, --out without --save, and a baseline of another env, database or format, or with no usable lines', async () => {
    const t = deps(db());
    await expect(labelsCheck(opts({ network: 'mainnet', env: 'prod' }), t.x)).rejects.toThrow(new CliError('prod is a mainnet env: labels:check runs on testnet envs only'));
    await expect(labelsCheck(opts({ out: `${ENV_DIR}/labels-lines-x.json` }), t.x)).rejects.toThrow('--out is where --save writes');
    const base = { format: BASELINE_FORMAT, env: 'local', database: 'hana-id-local', remote: false, takenAt: 'x', build: DEPLOYED, versions: {} };
    t.files.set('/b.json', { ...base, env: 'sandbox-dev' });
    await expect(labelsCheck(opts({ baseline: '/b.json' }), t.x)).rejects.toThrow('--baseline is of sandbox-dev, not local');
    t.files.set('/c.json', { ...base, remote: true });
    await expect(labelsCheck(opts({ baseline: '/c.json' }), t.x)).rejects.toThrow('--baseline is of hana-id-local, not hana-id-local (local)');
    for (const bad of [{ format: 'other' }, { ...base, format: 'hana-id/labels-check/v1' }, { ...base, build: undefined }, { ...base, build: { commit: 'xyz', dirty: false, deployed: null } }, { ...base, versions: [] }, null, 'text']) {
      t.files.set('/d.json', bad);
      await expect(labelsCheck(opts({ baseline: '/d.json' }), t.x)).rejects.toThrow(`--baseline is not a ${BASELINE_FORMAT} file`);
    }
    for (const lines of [undefined, 'x', [['a']], [['a', 1]]]) {
      t.files.set('/f.json', { ...base, versions: { lc_1: { sha256: 'x', lines } } });
      await expect(labelsCheck(opts({ baseline: '/f.json' }), t.x)).rejects.toThrow('--baseline has no usable lines for lc_1');
    }
  });

  it('the diff: only changed lines, cut to a line each, at most twelve; an order change said as such', () => {
    expect(linesDiff([['a', '1'], ['b', '2']], [['a', '1'], ['b', '3'], ['c', '4']])).toEqual(['- b: 2', '+ b: 3', '+ c: 4']);
    expect(linesDiff([['a', '1'], ['b', '2']], [['b', '2'], ['a', '1']])).toEqual(['~ the same lines in another order: b, a']);
    const many = linesDiff([], Array.from({ length: 20 }, (_, i): [string, string] => [`k${i}`, 'x'.repeat(300)]));
    expect(many).toHaveLength(13);
    expect(many[0]!.length).toBe(160);
    expect(many[12]).toBe('… and 8 more changed lines');
    expect(labelsCheckSql(null)).not.toContain('c.id >');
    expect(labelsCheckSql("lc_'x")).toContain("c.id > 'lc_''x'");
  });
});

describe('labels:check’s files (the real readers and writers)', () => {
  it('--out: only a new labels-lines-*.json directly in the env’s .secrets folder', () => {
    const dir = '/repo/.secrets/local';
    const now = new Date(NOW);
    expect(baselineTarget(undefined, dir, now)).toBe(`${dir}/labels-lines-20261125T090000000Z.json`);
    expect(baselineTarget(`${dir}/labels-lines-before-deploy.json`, dir, now)).toBe(`${dir}/labels-lines-before-deploy.json`);
    // Another secret's name in that folder, a file outside the repo, another env's folder, a path that climbs out.
    for (const out of [`${dir}/vault-kek.json`, `${dir}/relayer-keys.json`, '/tmp/labels-lines-x.json', '/repo/.secrets/sandbox-dev/labels-lines-x.json', `${dir}/../labels-lines-x.json`, `${dir}/sub/labels-lines-x.json`, `${dir}/labels-lines-.json`]) {
      expect(() => baselineTarget(out, dir, now), out).toThrow(CliError);
    }
  });

  it('writeNewSecretJson creates the file 0600 and never replaces one', () => {
    const dir = join(testTempDir('lc-'), '.secrets', 'local');
    const file = join(dir, 'labels-lines-a.json');
    writeNewSecretJson(file, { a: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(() => writeNewSecretJson(file, { a: 2 })).toThrow('already exists: --save never replaces a file');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
  });

  it('a baseline file: 0600 only, JSON, its text never in an error; a missing file said so', () => {
    const dir = join(testTempDir('lc-'), '.secrets', 'local');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const good = join(dir, 'labels-lines-good.json');
    writeFileSync(good, '{"format":"x"}', { mode: 0o600 });
    expect(readBaselineFile(good)).toEqual({ format: 'x' });
    const open = join(dir, 'labels-lines-open.json');
    writeFileSync(open, '{}');
    chmodSync(open, 0o644);
    expect(() => readBaselineFile(open)).toThrow('has mode 644; secret files must be 0600');
    const broken = join(dir, 'labels-lines-broken.json');
    writeFileSync(broken, '{"secret-ish words", ', { mode: 0o600 });
    let message = '';
    try {
      readBaselineFile(broken);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(`${broken} is not valid JSON (check for a missing or trailing comma)`);
    expect(message).not.toContain('secret-ish');
    const none = join(dir, 'labels-lines-none.json');
    expect(existsSync(none)).toBe(false);
    expect(() => readBaselineFile(none)).toThrow(`--baseline: no file ${none}`);
  });
});
