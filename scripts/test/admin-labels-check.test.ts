// admin.ts labels:check (lib/admin-labels-check.ts, D922): every stored Request labels version waiting or in force,
// parsed again with this checkout's parser, on node:sqlite with the real migrations. A valid version parses the same as
// its baseline; one a stricter rule now refuses fails with the rule's code and where; one that parses but whose lines
// changed since the baseline (an older build's lines, or the app renamed) reads differently, with only the changed
// lines printed. Exit 1 on any of those; read-only; refused on a mainnet env.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { BASELINE_FORMAT, type LabelsBaseline, type LabelsCheckDeps, type LabelsCheckOptions, labelsCheck, labelsCheckSql, linesDiff } from '../lib/admin-labels-check.ts';
import { newHotDb, seedHotApp } from './hot-db.ts';

const PASSPHRASE = 'Test SDF Network ; September 2015';
/** A random public key nobody holds the secret of (an address book refuses a public seed's account). */
const TILL = 'GC4OI7BDJ3EGZCOJOA3FNHCHQFQ4OKHXKZK6MXS2WFZBVMZ37I2NS4HC';
const NOW = Date.UTC(2026, 10, 25, 9, 0);
const HOUR = 3_600_000;

/** A classic payment document (D907's shape): "pay for <object> “1042”", ending with the till's name. */
const paymentDoc = (object: string, name = 'Coffee Club till'): string =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { stellar: { networkPassphrase: PASSPHRASE } },
    metadata: { addressBook: [{ account: TILL, name }] },
    display: {
      formats: {
        payment: {
          call: { memo: 'text', assets: ['native'], amountAtMost: '1000000000' },
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
  d.exec("INSERT INTO partner_labels (id, org_id, scope_id, created_at, created_by) VALUES ('pl_pay', 'org_a', 's_rally', 1, 'usr_1'), ('pl_old', 'org_a', 's_rally', 1, 'usr_1')");
  return d;
}

function addVersion(d: DatabaseSync, id: string, text: string, o: { label?: string; status?: string; notifiedAt?: number | null; activeFrom?: number | null } = {}): void {
  d.prepare(
    `INSERT INTO label_changes (id, label_id, org_id, scope_id, doc_text, doc_schema, doc_sha256, doc_bytes, context_key, apps_json, status, proposed_by, proposer_sub, proposed_at, notified_at, active_from, request_id)
     VALUES (?, ?, 'org_a', 's_rally', ?, 'journear-labels/1', ?, ?, ?, '["app_rally"]', ?, 'usr_1', 'sub-1', ?, ?, ?, ?)`,
  ).run(id, o.label ?? 'pl_pay', text, sha(text), Buffer.byteLength(text), `stellar:${PASSPHRASE}`, o.status ?? 'pending', NOW - 2 * HOUR, o.notifiedAt === undefined ? NOW - HOUR : o.notifiedAt, o.activeFrom === undefined ? NOW + HOUR : o.activeFrom, `req_${id}`);
}

/** The deps over a node:sqlite database; files in memory; every line logged kept. */
function deps(d: DatabaseSync) {
  const files = new Map<string, unknown>();
  const lines: string[] = [];
  const statements: string[] = [];
  const x: LabelsCheckDeps = {
    read: (s) => {
      statements.push(s);
      return d.prepare(s).all() as Record<string, unknown>[];
    },
    secretsEnvDir: (env) => `/repo/.secrets/${env}`,
    writeJson: (file, value) => void files.set(file, JSON.parse(JSON.stringify(value))),
    readJson: (file) => {
      if (!files.has(file)) throw new Error(`no ${file}`);
      return files.get(file);
    },
    log: (l) => void lines.push(l),
    now: () => new Date(NOW),
  };
  return { x, files, lines, statements };
}

const opts = (over: Partial<LabelsCheckOptions> = {}): LabelsCheckOptions => ({ env: 'local', network: 'testnet', database: 'hana-id-local', remote: false, save: false, out: undefined, baseline: undefined, ...over });

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

    // 1. The deployed build's lines (here this checkout's), saved as the baseline.
    expect(await labelsCheck(opts({ save: true, out: '/repo/.secrets/local/base.json' }), t.x)).toBe(1);
    const base = t.files.get('/repo/.secrets/local/base.json') as LabelsBaseline;
    expect(base.format).toBe(BASELINE_FORMAT);
    expect(Object.keys(base.versions)).toEqual(['lc_1valid', 'lc_2renders']);
    // As an older build read lc_2renders: its payment sentence without the till's name (what D907 added).
    const old = base.versions.lc_2renders!.lines.map(([k, v]): [string, string] => [k, k === 'payment' ? v.replace(/ to “Coffee Club till” \(G[A-Z0-9]+\)/u, '') : v]);
    expect(old).not.toEqual(base.versions.lc_2renders!.lines);
    t.files.set('/repo/.secrets/local/old.json', { ...base, versions: { ...base.versions, lc_2renders: { ...base.versions.lc_2renders!, lines: old } } });

    // 2. The check from the checkout to deploy.
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: '/repo/.secrets/local/old.json' }), t.x)).toBe(1);
    expect(t.lines[0]).toMatch(/^local: hana-id-local \(local\): 3 Request labels versions waiting or in force, compared with \/repo\/\.secrets\/local\/old\.json/u);
    expect(t.lines[1]).toBe('  lc_1valid (apps app_rally; waiting): parses the same');
    expect(t.lines[2]).toBe('  lc_2renders (apps app_rally; in force): READS DIFFERENTLY:');
    expect(t.lines[3]).toBe('      - payment: Stamp Rally says: pay for the fare “1042” · Order: “1042”');
    expect(t.lines[4]).toMatch(/^ {6}\+ payment: Stamp Rally says: pay for the fare “1042” to “Coffee Club till” \(GC4OI7/u);
    expect(t.lines[5]).toBe('  lc_3fails (apps app_rally; waiting): FAILS: sentence_text at display.formats.payment.intent.object');
    expect(t.lines[6]).toMatch(/^2 versions to propose again/u);
    expect(t.lines).toHaveLength(7);
    // The partner's words appear only in the changed lines: never for the version that parses the same or fails.
    const text = t.lines.join('\n');
    expect(text.match(/Coffee Club till/gu)).toHaveLength(1);
    expect(text).not.toContain('monthly membership');
    expect(text).not.toContain('lc_4ended');
    // Read-only: nothing but SELECTs.
    for (const s of t.statements) expect(s).toMatch(/^SELECT /u);
  });

  it('every version the same as its baseline: exit 0; renaming the app reads differently', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'));
    const t = deps(d);
    expect(await labelsCheck(opts({ save: true }), t.x)).toBe(0);
    const file = [...t.files.keys()][0]!;
    expect(file).toBe('/repo/.secrets/local/labels-lines-20261125T090000000Z.json');
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: file }), t.x)).toBe(0);
    expect(t.lines.slice(1)).toEqual(['  lc_1valid (apps app_rally; waiting): parses the same']);
    // The window says "{App} says:", so a renamed app reads differently.
    d.exec("UPDATE apps SET name = 'Rally Two' WHERE id = 'app_rally'");
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: file }), t.x)).toBe(1);
    expect(t.lines[1]).toBe('  lc_1valid (apps app_rally; waiting): READS DIFFERENTLY:');
    expect(t.lines[2]).toMatch(/^ {6}- payment: Stamp Rally says:/u);
    expect(t.lines[3]).toMatch(/^ {6}\+ payment: Rally Two says:/u);
  });

  it('without a baseline: parse only, said so; a version not in the baseline is not compared and exits 1', async () => {
    const d = db();
    addVersion(d, 'lc_1valid', paymentDoc('order'));
    const t = deps(d);
    expect(await labelsCheck(opts(), t.x)).toBe(0);
    expect(t.lines).toEqual([
      'local: hana-id-local (local): 1 Request labels version waiting or in force',
      '  lc_1valid (apps app_rally; waiting): parses (lines not compared: no --baseline)',
      'Every version parses; the lines were not compared (run with --baseline to compare them)',
    ]);
    t.files.set('/b.json', { format: BASELINE_FORMAT, env: 'local', database: 'hana-id-local', remote: false, takenAt: new Date(NOW).toISOString(), versions: {} });
    t.lines.length = 0;
    expect(await labelsCheck(opts({ baseline: '/b.json' }), t.x)).toBe(1);
    expect(t.lines[1]).toMatch(/lc_1valid .*NOT COMPARED: not in the baseline/u);
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

  it('refuses a mainnet env, --out without --save, and a baseline of another env or database', async () => {
    const t = deps(db());
    await expect(labelsCheck(opts({ network: 'mainnet', env: 'prod' }), t.x)).rejects.toThrow(new CliError('prod is a mainnet env: labels:check runs on testnet envs only'));
    await expect(labelsCheck(opts({ out: '/repo/.secrets/local/x.json' }), t.x)).rejects.toThrow('--out is where --save writes');
    t.files.set('/b.json', { format: BASELINE_FORMAT, env: 'sandbox-dev', database: 'hana-id-local', remote: false, takenAt: 'x', versions: {} });
    await expect(labelsCheck(opts({ baseline: '/b.json' }), t.x)).rejects.toThrow('--baseline is of sandbox-dev, not local');
    t.files.set('/c.json', { format: BASELINE_FORMAT, env: 'local', database: 'hana-id-local', remote: true, takenAt: 'x', versions: {} });
    await expect(labelsCheck(opts({ baseline: '/c.json' }), t.x)).rejects.toThrow('--baseline is of hana-id-local, not hana-id-local (local)');
    t.files.set('/d.json', { format: 'other' });
    await expect(labelsCheck(opts({ baseline: '/d.json' }), t.x)).rejects.toThrow(`--baseline is not a ${BASELINE_FORMAT} file`);
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
