// The retention functions of migrations-usage 0007 (batch C13) on PGlite (D140): docs/batch-c-spec.md "Tests: Usage
// ledger" retention rows (D90): uids NULL after month + 24 months with the rows kept; partitions and settlements past 7
// years dropped; app_users rows with last_seen past 24 months and of an app deleted 30 days ago purged; the erasure by
// uid only through its function; each run recorded in ops.retention_runs (one at a time); the erasure log append-only.
// Every function is called as usage_admin, the only role granted it. The clock is the database's own `now()`: the
// partitions and rows are placed relative to the cutoffs the migration computes from it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, freshDb, type TestDb } from './db.ts';

let db: TestDb;
/** The first instant still kept raw (24 months, D90) and the 7-year bound, as the functions compute them. */
let uidCutoff: Date;
let recordsCutoff: Date;

const monthName = (d: Date) => `events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const addMonths = (d: Date, k: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
const partitionFor = async (month: Date) => {
  await db.exec(`CREATE TABLE IF NOT EXISTS usage.${monthName(month)} PARTITION OF usage.events FOR VALUES FROM ('${month.toISOString()}') TO ('${addMonths(month, 1).toISOString()}')`);
};
const partitions = async () => (await db.query<{ n: string }>("SELECT c.relname AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'usage.events'::regclass ORDER BY 1")).map((r) => r.n);

beforeAll(async () => {
  db = await freshDb();
  const [c] = await db.query<{ u: Date; r: Date }>('SELECT usage.uid_cutoff() AS u, usage.records_cutoff() AS r');
  uidCutoff = new Date(c!.u);
  recordsCutoff = new Date(c!.r);
  // Two months that ended more than 7 years ago, the month that ends after the bound, and the two months around the
  // 24-month line.
  for (const m of [addMonths(recordsCutoff, -2), addMonths(recordsCutoff, -1), recordsCutoff, addMonths(uidCutoff, -1), uidCutoff]) await partitionFor(m);
});
afterAll(async () => {
  await db.close();
});

const asAdmin = <T>(fn: () => Promise<T>) => db.asRole('usage_admin', fn);
const asWriter = <T>(fn: () => Promise<T>) => db.asRole('usage_writer', fn);
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params))[0]!.n);
const uidBytes = (n: number) => Buffer.from(new Uint8Array(16).fill(n));

let seq = 0;
/** An ok login with a uid (inserted as the owner), at `at`. */
async function ev(at: Date, o: { uid?: number | null; app?: string; relayed?: boolean } = {}): Promise<string> {
  const rid = `ret-${++seq}-xxxxxxxx`;
  const relayed = o.relayed ?? false;
  await db.query(
    `INSERT INTO usage.events (request_id, at, org_id, app_id, scope_id, endpoint, outcome, status, latency_ms, relayed, near_tx, relayer_pk, relayer_nonce, uid)
     VALUES ($1, $2, 'org_a', $3, 's1', 'login', 'ok', 200, 10, $4, $5, $6, $7, $8)`,
    [rid, at.toISOString(), o.app ?? 'app_1', relayed, relayed ? `Tx${seq}${'A'.repeat(40)}` : null, relayed ? 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp' : null, relayed ? String(seq) : null, o.uid === null ? null : uidBytes(o.uid ?? 1)],
  );
  return rid;
}
const uidOf = async (rid: string) => (await db.query<{ u: string | null }>("SELECT encode(uid, 'hex') AS u FROM usage.events WHERE request_id = $1", [rid]))[0]!.u;
const hex = (n: number) => uidBytes(n).toString('hex');
const appUser = (app: string, uid: number, first: string, last: string) =>
  db.query('INSERT INTO usage.app_users (app_id, uid, first_seen, last_seen) VALUES ($1, $2, $3::date, $4::date) ON CONFLICT DO NOTHING', [app, uidBytes(uid), first, last]);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

describe('usage.strip_uids (raw usage 24 months, D90)', () => {
  it('NULLs the uid of events in months that ended more than 24 months ago and keeps the rows; the next month keeps its uids', async () => {
    const old1 = await ev(new Date(uidCutoff.getTime() - 1), { uid: 2 });
    const old2 = await ev(addMonths(uidCutoff, -1), { uid: 3 });
    const kept = await ev(uidCutoff, { uid: 4 });
    const recent = await ev(new Date(), { uid: 5 });
    const [r] = await asAdmin(() => db.query<{ events: string; app_users: string; more: boolean }>('SELECT * FROM usage.strip_uids(10000)'));
    expect(Number(r!.events)).toBeGreaterThanOrEqual(2);
    expect(r!.more).toBe(false);
    expect(await uidOf(old1)).toBeNull();
    expect(await uidOf(old2)).toBeNull();
    expect(await uidOf(kept)).toBe(hex(4));
    expect(await uidOf(recent)).toBe(hex(5));
    // The rows themselves stay (de-identified, with the settlement records, until the 7-year drop).
    expect(await count('SELECT count(*) AS n FROM usage.events WHERE request_id = ANY($1)', [[old1, old2]])).toBe(2);
    // Again: nothing left to strip.
    const [again] = await asAdmin(() => db.query<{ events: string; more: boolean }>('SELECT * FROM usage.strip_uids(10000)'));
    expect(Number(again!.events)).toBe(0);
  });

  it('works in batches of max_rows and says when there is more', async () => {
    const at = addMonths(uidCutoff, -1);
    for (let k = 0; k < 5; k++) await ev(new Date(at.getTime() + k * 1000), { uid: 10 + k });
    const run = () => asAdmin(() => db.query<{ events: string; more: boolean }>('SELECT * FROM usage.strip_uids(2)')).then((rows) => rows[0]!);
    const first = await run();
    expect([Number(first.events), first.more]).toEqual([2, true]);
    const second = await run();
    expect([Number(second.events), second.more]).toEqual([2, true]);
    const third = await run();
    expect([Number(third.events), third.more]).toEqual([1, false]);
    expect(await count('SELECT count(*) AS n FROM usage.events WHERE uid IS NOT NULL AND at < $1', [uidCutoff.toISOString()])).toBe(0);
  });

  it('deletes app_users rows last seen more than 24 months ago; a user seen since keeps its row (and its first day)', async () => {
    await appUser('app_old', 21, daysAgo(900), daysAgo(800)); // last seen > 24 months ago
    await appUser('app_old', 22, daysAgo(900), daysAgo(10)); // first seen long ago, seen recently
    await appUser('app_old', 23, daysAgo(600), daysAgo(600)); // within 24 months
    await asAdmin(() => db.query('SELECT * FROM usage.strip_uids(10000)'));
    const left = (await db.query<{ b: number }>("SELECT get_byte(uid, 0) AS b FROM usage.app_users WHERE app_id = 'app_old' ORDER BY uid")).map((r) => r.b);
    expect(left).toEqual([22, 23]);
  });

  it('refuses a bad batch size', async () => {
    for (const bad of [0, -1, 100001]) expect((await failure(asAdmin(() => db.query('SELECT * FROM usage.strip_uids($1)', [bad]))))?.code, String(bad)).toBe('22023');
  });
});

describe('usage.drop_expired_partitions (settlement records 7 years, D90)', () => {
  it('drops whole months that ended more than 7 years ago with their settlements and day counts; never statements or rates', async () => {
    const gone = addMonths(recordsCutoff, -1);
    const keptMonth = recordsCutoff;
    const r1 = await ev(new Date(gone.getTime() + 3_600_000), { relayed: true });
    const r2 = await ev(new Date(keptMonth.getTime() + 3_600_000), { relayed: true });
    for (const [rid, at] of [
      [r1, new Date(gone.getTime() + 3_600_000)],
      [r2, new Date(keptMonth.getTime() + 3_600_000)],
    ] as const) {
      await db.query("INSERT INTO usage.gas_settlements (request_id, at, near_tx, result, gas_burnt, tokens_burnt) VALUES ($1, $2, 'tx', 'final', 1, 1)", [rid, at.toISOString()]);
      await db.query("INSERT INTO ops.settlement_alerts (request_id, at, org_id, near_tx, reason) VALUES ($1, $2, 'org_a', 'tx', 'duplicate_tx')", [rid, at.toISOString()]);
      await db.query("INSERT INTO ops.settlement_tries (request_id, at, tries, last_tried_at) VALUES ($1, $2, 1, now())", [rid, at.toISOString()]);
    }
    for (const day of [isoDay(gone), isoDay(keptMonth)]) {
      await db.query("INSERT INTO usage.identity_tokens (app_id, day, org_id, scope_id, tokens) VALUES ('app_1', $1::date, 'org_a', 's1', 3)", [day]);
      await db.query("INSERT INTO usage.email_counts (app_id, day, org_id, scope_id, email_sessions, links) VALUES ('app_1', $1::date, 'org_a', 's1', 3, 1)", [day]);
    }
    // A statement and a rate of the expired month: due for review by a person, never dropped by the job.
    await db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ($1::date, 2000000, 'coingecko')", [isoDay(gone)]);
    await db.query("INSERT INTO usage.statements (org_id, month, as_of, csv_key, csv_sha256, totals, issued_by) VALUES ('org_a', $1::date, now(), 'k', decode(repeat('ab', 32), 'hex'), '{}', 'staff')", [isoDay(gone)]);

    const before = await partitions();
    expect(before).toContain(monthName(addMonths(recordsCutoff, -2)));
    const [r] = await asAdmin(() => db.query<Record<string, string | number>>('SELECT * FROM usage.drop_expired_partitions()'));
    expect(Number(r!.partitions)).toBe(2);
    expect([r!.settlements, r!.identity_tokens, r!.email_counts, r!.settlement_alerts, r!.settlement_tries].map(Number)).toEqual([1, 1, 1, 1, 1]);
    const after = await partitions();
    expect(after).not.toContain(monthName(addMonths(recordsCutoff, -2)));
    expect(after).not.toContain(monthName(gone));
    expect(after).toContain(monthName(keptMonth));
    expect(await count('SELECT count(*) AS n FROM usage.events WHERE request_id = $1', [r2])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM usage.gas_settlements WHERE request_id = $1', [r2])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM usage.gas_settlements WHERE request_id = $1', [r1])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM usage.statements', [])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM usage.near_usd_rates WHERE day = $1::date', [isoDay(gone)])).toBe(1);
    // Listed as due for review.
    const [due] = await asAdmin(() => db.query<{ statements: string; rates: string; oldest_statement: string }>('SELECT * FROM usage.retention_due()'));
    expect([Number(due!.statements), Number(due!.rates), due!.oldest_statement]).toEqual([1, 1, isoDay(gone).slice(0, 7)]);
    // Idempotent.
    const [again] = await asAdmin(() => db.query<{ partitions: number }>('SELECT * FROM usage.drop_expired_partitions()'));
    expect(Number(again!.partitions)).toBe(0);
  });

  it('the admin role still can’t drop a partition or delete a settlement itself', async () => {
    expect((await failure(asAdmin(() => db.query(`DROP TABLE usage.${monthName(recordsCutoff)}`))))?.code).toBe('42501');
    expect((await failure(asAdmin(() => db.query('DELETE FROM usage.gas_settlements'))))?.code).toBe('42501');
  });
});

describe('usage.purge_app_users (an app deleted + 30 days, D90)', () => {
  it("deletes that app's app_users rows only", async () => {
    await appUser('app_deleted', 31, daysAgo(10), daysAgo(1));
    await appUser('app_deleted', 32, daysAgo(10), daysAgo(1));
    await appUser('app_live', 31, daysAgo(10), daysAgo(1));
    const [r] = await asAdmin(() => db.query<{ n: string }>("SELECT usage.purge_app_users('app_deleted') AS n"));
    expect(Number(r!.n)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM usage.app_users WHERE app_id = 'app_deleted'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM usage.app_users WHERE app_id = 'app_live'")).toBe(1);
    expect(Number((await asAdmin(() => db.query<{ n: string }>("SELECT usage.purge_app_users('app_deleted') AS n")))[0]!.n)).toBe(0);
    for (const bad of [null, '', 'x'.repeat(65)]) expect((await failure(asAdmin(() => db.query('SELECT usage.purge_app_users($1)', [bad]))))?.code).toBe('22023');
  });
});

describe('usage.erase_uid (uid:erase, D362)', () => {
  it('deletes the user’s app_users rows in every app and NULLs the uid on every event carrying it; others untouched', async () => {
    const mine = [await ev(new Date(), { uid: 41, app: 'app_x' }), await ev(new Date(), { uid: 41, app: 'app_y' })];
    const theirs = await ev(new Date(), { uid: 42, app: 'app_x' });
    await appUser('app_x', 41, daysAgo(3), daysAgo(1));
    await appUser('app_y', 41, daysAgo(3), daysAgo(1));
    await appUser('app_x', 42, daysAgo(3), daysAgo(1));
    const [r] = await asAdmin(() => db.query<{ app_users: string; events: string }>('SELECT * FROM usage.erase_uid($1)', [uidBytes(41)]));
    expect([Number(r!.app_users), Number(r!.events)]).toEqual([2, 2]);
    for (const rid of mine) expect(await uidOf(rid)).toBeNull();
    expect(await uidOf(theirs)).toBe(hex(42));
    expect(await count('SELECT count(*) AS n FROM usage.app_users WHERE uid = $1', [uidBytes(41)])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM usage.app_users WHERE uid = $1', [uidBytes(42)])).toBe(1);
    // The rows stay (counts and billing are unchanged), and a second call finds nothing.
    expect(await count('SELECT count(*) AS n FROM usage.events WHERE request_id = ANY($1)', [mine])).toBe(2);
    const [again] = await asAdmin(() => db.query<{ app_users: string; events: string }>('SELECT * FROM usage.erase_uid($1)', [uidBytes(41)]));
    expect([Number(again!.app_users), Number(again!.events)]).toEqual([0, 0]);
  });

  it('refuses anything but a 16-byte uid, and is the only way: the admin can’t update events or delete app_users directly', async () => {
    for (const bad of [null, Buffer.alloc(15), Buffer.alloc(17)]) expect((await failure(asAdmin(() => db.query('SELECT * FROM usage.erase_uid($1)', [bad]))))?.code).toBe('22023');
    expect((await failure(asAdmin(() => db.query('UPDATE usage.events SET uid = NULL'))))?.code).toBe('42501');
    expect((await failure(asAdmin(() => db.query('DELETE FROM usage.app_users'))))?.code).toBe('42501');
    expect((await failure(asWriter(() => db.query('SELECT * FROM usage.erase_uid($1)', [uidBytes(1)]))))?.code).toBe('42501');
  });
});

describe('ops.purge_expired (the admin’s own state)', () => {
  it('nonce checks and rejection alerts after 400 days, notified watcher rows after 400 days; recent and pending rows stay', async () => {
    const pk = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
    await db.query("INSERT INTO ops.nonce_checks (relayer_pk, checked_at, chain_nonce, explained, ledger_relayed_since_last) VALUES ($1, now() - interval '401 days', 1, true, 0), ($1, now() - interval '10 days', 2, true, 0)", [pk]);
    await db.query("INSERT INTO ops.rejection_alerts (org_id, day, relayed, rejected) VALUES ('org_a', (now() - interval '401 days')::date, 100, 9), ('org_a', (now() - interval '1 day')::date, 100, 9)");
    await db.query(
      "INSERT INTO ops.scope_watch (scope_id, change_id, first_seen_at, notified_at) VALUES ('s1', 1, now() - interval '500 days', now() - interval '401 days'), ('s1', 2, now() - interval '500 days', NULL), ('s1', 3, now(), now())",
    );
    const [r] = await asAdmin(() => db.query<Record<string, string>>('SELECT * FROM ops.purge_expired()'));
    expect([r!.nonce_checks, r!.rejection_alerts, r!.scope_watch].map(Number)).toEqual([1, 1, 1]);
    expect(await count('SELECT count(*) AS n FROM ops.nonce_checks')).toBe(1);
    expect((await db.query<{ c: string }>('SELECT change_id::text AS c FROM ops.scope_watch ORDER BY 1')).map((x) => x.c)).toEqual(['2', '3']);
  });
});

describe('ops.retention_runs (D90: each run recorded)', () => {
  it('one run at a time; a finished run has its time, a failed one its error, an alert only on a failure', async () => {
    const month = isoDay(addMonths(new Date(), 0)).slice(0, 8) + '01';
    await asAdmin(async () => {
      await db.query("DELETE FROM ops.retention_runs WHERE status = 'running'");
      await db.query('INSERT INTO ops.retention_runs (started_at, month) VALUES (now(), $1::date)', [month]);
      expect((await failure(db.query('INSERT INTO ops.retention_runs (started_at, month) VALUES (now(), $1::date)', [month])))?.code).toBe('23505');
      for (const bad of [
        "UPDATE ops.retention_runs SET status = 'ok' WHERE status = 'running'", // no finished_at
        "UPDATE ops.retention_runs SET status = 'failed', finished_at = now() WHERE status = 'running'", // no error
        "UPDATE ops.retention_runs SET status = 'ok', finished_at = now(), alerted_at = now() WHERE status = 'running'", // an alert on a success
      ]) {
        expect((await failure(db.query(bad)))?.code, bad).toBe('23514');
      }
      await db.query("UPDATE ops.retention_runs SET status = 'ok', finished_at = now() WHERE status = 'running'");
      // The next run may start once the first finished; a run's month is a first of month.
      await db.query('INSERT INTO ops.retention_runs (started_at, month) VALUES (now(), $1::date)', [month]);
      await db.query("UPDATE ops.retention_runs SET status = 'failed', finished_at = now(), error = 'strip_uids: pg_57014' WHERE status = 'running'");
      expect((await failure(db.query("INSERT INTO ops.retention_runs (started_at, month) VALUES (now(), '2026-11-02')")))?.code).toBe('23514');
    });
  });
});

describe('ops.erasures (who erased what, never whom)', () => {
  it('the admin role inserts and reads; nobody changes a row, and a row is deleted only after 60 months', async () => {
    await asAdmin(() => db.query("INSERT INTO ops.erasures (ticket, operator, scope_id, rows) VALUES ('SUP-1', 'cli:ops', 's1', '{\"ledgerEvents\": 2}')"));
    expect(await asAdmin(() => count('SELECT count(*) AS n FROM ops.erasures'))).toBe(1);
    for (const sql of ["UPDATE ops.erasures SET ticket = 'x'", 'DELETE FROM ops.erasures']) expect((await failure(asAdmin(() => db.query(sql))))?.code, sql).toBe('42501');
    // The owner too: the trigger.
    for (const sql of ["UPDATE ops.erasures SET ticket = 'x'", 'DELETE FROM ops.erasures', 'TRUNCATE ops.erasures']) expect((await failure(db.query(sql)))?.code, sql).toBe('42501');
    await db.query("INSERT INTO ops.erasures (at, ticket, operator, scope_id) VALUES (now() - interval '61 months', 'SUP-0', 'cli:ops', 's1')");
    const [r] = await asAdmin(() => db.query<{ erasures: string }>('SELECT * FROM ops.purge_expired()'));
    expect(Number(r!.erasures)).toBe(1);
    expect((await db.query<{ t: string }>('SELECT ticket AS t FROM ops.erasures')).map((x) => x.t)).toEqual(['SUP-1']);
  });
});
