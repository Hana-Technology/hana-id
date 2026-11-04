import { b64url, usageEventV1, type UsageEventV1 } from '@hana-id/console-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, freshDb, type TestDb } from './db.ts';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const NOW = Date.now();
let seq = 0;
const rid = () => `req-${NOW}-${++seq}`;

/** A valid relayed ok login (UsageEvent v1) at `at_ms`, with fresh request id. */
const event = (patch: Partial<Record<keyof UsageEventV1, unknown>> = {}): Record<string, unknown> => ({
  v: 1,
  request_id: rid(),
  at_ms: NOW,
  org_id: 'org_legacy',
  app_id: 'app_a',
  scope_id: 's1',
  endpoint: 'login',
  outcome: 'ok',
  code: null,
  status: 200,
  latency_ms: 812,
  relayed: true,
  near_tx: 'FbqJmVBv3Wv9ghTkw3wFpoXvWZQJaKdZmpWxE4CRWwBF',
  relayer_pk: 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp',
  relayer_nonce: '193000000000001',
  relay_gas_burnt: '4174947687500',
  relay_tokens_burnt_yocto: '417494768750000000000',
  uid: b64url(new Uint8Array(16).fill(7)),
  ...patch,
});
const strip = (e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));

const record = (e: Record<string, unknown>) => db.query<{ r: boolean }>('SELECT usage.record_event($1::jsonb) AS r', [JSON.stringify(strip(e))]).then((rows) => rows[0]!.r);
const asWriter = <T>(fn: () => Promise<T>) => db.asRole('usage_writer', fn);
const asAdmin = <T>(fn: () => Promise<T>) => db.asRole('usage_admin', fn);
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params))[0]!.n);

const TABLES = ['usage.events', 'usage.app_users', 'usage.gas_settlements', 'usage.near_usd_rates', 'usage.statements', 'usage.identity_tokens', 'usage.email_counts', 'usage.rate_overrides', 'ops.state', 'ops.scope_snapshot', 'ops.scope_watch', 'ops.nonce_checks', 'ops.retention_runs', 'ops.rejection_alerts', 'ops.settlement_alerts', 'ops.settlement_tries', 'ops.statement_notices'];

describe('migrations-usage on an empty database', () => {
  it('creates the schemas, tables and the current month with the next 12 (0001 made 3, 0003 the rest)', async () => {
    for (const t of TABLES) expect((await db.query<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [t]))[0]!.r, t).toBe(t);
    const parts = await db.query<{ name: string }>("SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'usage.events'::regclass ORDER BY 1");
    const d = new Date(NOW);
    const months = Array.from({ length: 13 }, (_, k) => k).map((k) => {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
      return `events_${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    expect(parts.map((p) => p.name)).toEqual(months);
  });

  it('creates the two roles without login and with their statement timeouts; no credential in the DDL', async () => {
    const roles = await db.query<{ rolname: string; rolcanlogin: boolean }>("SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('usage_writer', 'usage_admin') ORDER BY 1");
    expect(roles).toEqual([
      { rolname: 'usage_admin', rolcanlogin: false },
      { rolname: 'usage_writer', rolcanlogin: false },
    ]);
    const settings = await db.query<{ rolname: string; setconfig: string[] }>("SELECT r.rolname, s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname LIKE 'usage_%' ORDER BY 1");
    expect(settings).toEqual([
      { rolname: 'usage_admin', setconfig: ['statement_timeout=60s'] },
      { rolname: 'usage_writer', setconfig: ['statement_timeout=5s'] },
    ]);
  });

  it('each role can execute exactly its functions; nobody else (PUBLIC) any', async () => {
    await db.exec('CREATE ROLE usage_test_nobody NOLOGIN');
    const fns = async (role: string) =>
      (
        await db.query<{ f: string }>(
          "SELECT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('usage', 'ops') AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1",
          [role],
        )
      ).map((r) => r.f);
    // 0006 (batch C12) adds the report functions to both roles and the admin's own; `usage.classified` is nobody's.
    expect(await fns('usage_writer')).toEqual(['usage.ensure_partitions', 'usage.org_ledger', 'usage.org_report', 'usage.org_statements', 'usage.record_email_counts', 'usage.record_event', 'usage.record_identity_tokens']);
    expect(await fns('usage_admin')).toEqual(['usage.ensure_partitions', 'usage.org_ledger', 'usage.org_report', 'usage.org_statements', 'usage.override_rate', 'usage.rejection_rates', 'usage.statement_blockers']);
    expect(await fns('usage_test_nobody')).toEqual([]);
  });
});

describe('the writer role', () => {
  it('records the link relays’ events (migrations-usage 0005): link, link_cancel, link_unlink, without a uid', async () => {
    for (const endpoint of ['link', 'link_cancel', 'link_unlink']) {
      expect(await asWriter(() => record(event({ endpoint, uid: undefined, request_id: `link-${endpoint}` }))), endpoint).toBe(true);
    }
  });

  it('records events through record_event', async () => {
    expect(await asWriter(() => record(event()))).toBe(true);
  });

  it('has no table privilege: direct INSERT, SELECT, UPDATE and DELETE are refused on every table', async () => {
    for (const t of TABLES) {
      const [schema, table] = t.split('.');
      const [{ col }] = (await db.query<{ col: string }>('SELECT column_name AS col FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT 1', [schema, table])) as [{ col: string }];
      for (const sql of [`SELECT 1 FROM ${t} LIMIT 1`, `DELETE FROM ${t}`, `UPDATE ${t} SET ${col} = ${col}`]) {
        const f = await failure(asWriter(() => db.query(sql)));
        expect(f?.code, `${sql}`).toBe('42501');
      }
    }
    const insert = await failure(asWriter(() => db.query("INSERT INTO usage.events (request_id, at, org_id, app_id, scope_id, endpoint, outcome, status, latency_ms, relayed) VALUES ('x', now(), 'o', 'a', 's', 'login', 'ok', 200, 1, false)")));
    expect(insert?.code).toBe('42501');
  });

  it('keeps partitions ahead with ensure_partitions (0003, the API’s hourly cron): bounded, creates only missing months', async () => {
    const parts = async () => Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent = 'usage.events'::regclass"))[0]!.n);
    const before = await parts();
    expect((await asWriter(() => db.query<{ n: number }>('SELECT usage.ensure_partitions(12) AS n')))[0]!.n).toBe(0);
    expect((await asWriter(() => db.query<{ n: number }>('SELECT usage.ensure_partitions(14) AS n')))[0]!.n).toBe(2);
    expect(await parts()).toBe(before + 2);
    for (const bad of [-1, 25]) expect((await failure(asWriter(() => db.query('SELECT usage.ensure_partitions($1)', [bad]))))?.code, String(bad)).toBe('22023');
    // An event a year ahead now has its partition.
    const d = new Date(NOW);
    expect(await asWriter(() => record(event({ at_ms: Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), 15) })))).toBe(true);
    // Still no table privilege, and no way to drop a partition.
    expect((await failure(asWriter(() => db.query('DROP TABLE usage.events_2000_01'))))?.code).toMatch(/^42/u);
  });
});

describe('the admin role', () => {
  it('reads the ledger and writes settlements, rates, statements and ops state', async () => {
    await asAdmin(async () => {
      expect((await db.query('SELECT count(*) FROM usage.events')).length).toBe(1);
      await db.query("INSERT INTO usage.gas_settlements (request_id, at, near_tx, result, gas_burnt, tokens_burnt) VALUES ('s-1', now(), 'tx', 'final', 1, 2)");
      await db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ('2001-01-01', 2500000, 'coingecko')");
      // A rate is replaced only through the audited override (0006); a direct UPDATE is refused.
      await db.query("SELECT usage.override_rate('2001-01-01', 2600000, 'staff', 'corrected from the contract source')");
      await db.query("INSERT INTO ops.state (key, value) VALUES ('feed.cursor', '0')");
      await db.query("UPDATE ops.state SET value = '1' WHERE key = 'feed.cursor'");
      await db.query("INSERT INTO ops.retention_runs (started_at) VALUES (now())");
      await db.query("DELETE FROM ops.state WHERE key = 'feed.cursor'");
      expect((await db.query<{ n: number }>('SELECT usage.ensure_partitions(3) AS n'))[0]!.n).toBe(0);
    });
  });

  it("can't update or delete events, statements or settlements, insert events, or call record_event", async () => {
    for (const sql of [
      "UPDATE usage.events SET org_id = 'x'",
      'DELETE FROM usage.events',
      "INSERT INTO usage.events (request_id, at, org_id, app_id, scope_id, endpoint, outcome, status, latency_ms, relayed) VALUES ('x', now(), 'o', 'a', 's', 'login', 'ok', 200, 1, false)",
      "UPDATE usage.statements SET issued_by = 'x'",
      'DELETE FROM usage.statements',
      "UPDATE usage.gas_settlements SET result = 'unsettled'",
      'DELETE FROM usage.gas_settlements',
      'DELETE FROM usage.near_usd_rates',
      "UPDATE usage.near_usd_rates SET day = '2001-01-02'",
      "UPDATE usage.near_usd_rates SET usd_micros = 1",
      'DELETE FROM usage.rate_overrides',
      "UPDATE usage.rate_overrides SET reason = 'x'",
      'DELETE FROM usage.app_users',
      'TRUNCATE usage.events',
      'CREATE TABLE ops.mine (x int)',
    ]) {
      expect((await failure(asAdmin(() => db.query(sql))))?.code, sql).toBe('42501');
    }
    expect((await failure(asAdmin(() => record(event()))))?.code).toBe('42501');
  });
});

describe('record_event', () => {
  it('is idempotent on a retry with the same request_id and at', async () => {
    const e = event();
    expect(await record(e)).toBe(true);
    expect(await record(e)).toBe(false);
    expect(await count('SELECT count(*) AS n FROM usage.events WHERE request_id = $1', [e.request_id])).toBe(1);
  });

  it('stores the fields exactly (millisecond time, big decimals, the uid bytes)', async () => {
    const e = event({ at_ms: NOW - (NOW % 1000) + 999, relay_tokens_burnt_yocto: '999999999999999999999999999999999999999', relayer_nonce: '9223372036854775807' });
    await record(e);
    const [row] = await db.query<Record<string, unknown>>(
      "SELECT (extract(epoch FROM at) * 1000)::bigint::text AS at_ms, relay_tokens_burnt::text AS t, relayer_nonce::text AS n, encode(uid, 'hex') AS uid, received_at <= now() AS recv FROM usage.events WHERE request_id = $1",
      [e.request_id],
    );
    expect(row).toEqual({ at_ms: String(e.at_ms), t: e.relay_tokens_burnt_yocto, n: e.relayer_nonce, uid: '07'.repeat(16), recv: true });
  });

  it('keeps first_seen the minimum and last_seen the maximum when events arrive out of order', async () => {
    const uid = b64url(new Uint8Array(16).fill(9));
    const dayMs = 86_400_000;
    const start = Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth(), 1) + 12 * 3_600_000;
    // Three days of the current month, recorded middle, last, first.
    for (const k of [1, 2, 0]) await record(event({ app_id: 'app_order', uid, at_ms: start + k * dayMs }));
    const [u] = await db.query<{ first_seen: string; last_seen: string }>("SELECT first_seen::text, last_seen::text FROM usage.app_users WHERE app_id = 'app_order'");
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(u).toEqual({ first_seen: iso(start), last_seen: iso(start + 2 * dayMs) });
  });

  it('fails loudly for an event outside every partition', async () => {
    const f = await failure(record(event({ at_ms: Date.UTC(2000, 0, 1) })));
    expect(f?.code).toBe('23514');
  });

  it('puts the last millisecond of a month in that month and the next in the next', async () => {
    const d = new Date(NOW);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const a = event({ at_ms: next - 1 });
    const b = event({ at_ms: next });
    await record(a);
    await record(b);
    const rows = await db.query<{ request_id: string; part: string }>('SELECT request_id, tableoid::regclass::text AS part FROM usage.events WHERE request_id = ANY($1) ORDER BY at', [[a.request_id, b.request_id]]);
    const name = (ms: number) => `usage.events_${new Date(ms).getUTCFullYear()}_${String(new Date(ms).getUTCMonth() + 1).padStart(2, '0')}`;
    expect(rows.map((r) => r.part)).toEqual([name(next - 1), name(next)]);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['v', { v: 2 }],
    ['unknown field', { sub: '123' }],
    ['request_id', { request_id: 'short' }],
    ['at_ms', { at_ms: -1 }],
    ['at_ms', { at_ms: 1.5 }],
    ['at_ms', { at_ms: '1793000000000' }],
    ['org_id', { org_id: '' }],
    ['app_id', { app_id: 5 }],
    ['endpoint', { endpoint: 'app' }],
    ['outcome', { outcome: 'maybe' }],
    ['code', { code: 'Bad-Code' }],
    ['status', { status: 99 }],
    ['latency_ms', { latency_ms: 2_147_483_648 }],
    ['latency_ms', { latency_ms: { x: 1 } }],
    ['relayed', { relayed: 'yes' }],
    ['near_tx', { near_tx: 'not base58 0OIl' }],
    ['relayer_pk', { relayer_pk: 'secp256k1:abc' }],
    ['relayer_nonce', { relayer_nonce: '9223372036854775808' }],
    ['relayer_nonce', { relayer_nonce: 5 }],
    ['relay_tokens_burnt_yocto', { relay_tokens_burnt_yocto: '1'.repeat(40) }],
    ['uid', { uid: b64url(new Uint8Array(15)) }],
    ['a relayed event', { near_tx: undefined }],
    ['owner actions', { app_id: null }],
    ['owner actions', { endpoint: 'owner_action', uid: undefined }],
    ['carry a uid', { outcome: 'rejected', code: 'contract_rejected' }],
    ['carry a uid', { endpoint: 'unlock' }],
    ['carry a uid', { endpoint: 'link' }],
    ['code is null', { code: 'x' }],
    ['code is null', { outcome: 'error', code: null, uid: undefined }],
  ];
  for (const [why, patch] of invalid) {
    it(`refuses a bad shape (${why}: ${JSON.stringify(patch)}), as UsageEvent v1 does`, async () => {
      const e = strip(event(patch));
      expect(usageEventV1.safeParse(e).success).toBe(false);
      const f = await failure(record(e));
      expect(f?.code).toBe('22023');
      expect(f?.message).toContain('usage_event_invalid');
    });
  }

  it('refuses a missing required field and a non-object', async () => {
    const { status: _, ...noStatus } = event();
    expect((await failure(record(noStatus)))?.message).toContain('missing status');
    expect((await failure(db.query("SELECT usage.record_event('[1]'::jsonb)")))?.code).toBe('22023');
  });

  it('accepts every event shape UsageEvent v1 accepts', async () => {
    const valid = [
      event(),
      event({ relayed: false, near_tx: undefined, relayer_pk: undefined, relayer_nonce: undefined, relay_gas_burnt: undefined, relay_tokens_burnt_yocto: undefined }),
      event({ endpoint: 'session' }),
      event({ endpoint: 'derive', relayed: false, near_tx: undefined, relayer_pk: undefined, relayer_nonce: undefined }),
      event({ endpoint: 'revoke', uid: undefined }),
      event({ endpoint: 'unlock', uid: undefined, relayed: false, near_tx: undefined, relayer_pk: undefined, relayer_nonce: undefined, relay_gas_burnt: undefined, relay_tokens_burnt_yocto: undefined }),
      event({ endpoint: 'owner_action', app_id: null, uid: undefined }),
      event({ outcome: 'rejected', code: 'contract_rejected', status: 400, uid: undefined }),
      event({ outcome: 'error', code: 'timeout', status: 504, uid: undefined }),
      event({ latency_ms: 0, status: 599, at_ms: NOW }),
    ];
    for (const e of valid) {
      expect(usageEventV1.safeParse(strip(e)).success, JSON.stringify(e)).toBe(true);
      expect(await record(e), JSON.stringify(e)).toBe(true);
    }
  });
});

describe('frozen statements and rates', () => {
  const month = '2001-02-01';
  beforeAll(async () => {
    await db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ('2001-02-10', 2500000, 'coingecko'), ('2001-03-10', 2500000, 'coingecko')");
    await db.query(
      "INSERT INTO usage.statements (org_id, month, as_of, csv_key, csv_sha256, totals, issued_by) VALUES ('org_s', $1, now(), 'statements/org_s/2001-02/x.csv', decode(repeat('ab', 32), 'hex'), '{}', 'staff')",
      [month],
    );
  });

  it('refuses UPDATE, DELETE and TRUNCATE of a statement, even by the owner', async () => {
    for (const sql of ["UPDATE usage.statements SET issued_by = 'x'", 'DELETE FROM usage.statements', 'TRUNCATE usage.statements']) {
      expect((await failure(db.query(sql)))?.code, sql).toBe('42501');
    }
    expect(await count('SELECT count(*) AS n FROM usage.statements')).toBe(1);
  });

  it('refuses a second statement for the same org and month', async () => {
    const f = await failure(db.query("INSERT INTO usage.statements (org_id, month, as_of, csv_key, csv_sha256, totals, issued_by) VALUES ('org_s', $1, now(), 'k', decode(repeat('ab', 32), 'hex'), '{}', 'staff')", [month]));
    expect(f?.code).toBe('23505');
  });

  it('refuses a rate change in a month that has a statement, from either side', async () => {
    expect((await failure(db.query("UPDATE usage.near_usd_rates SET usd_micros = 1 WHERE day = '2001-02-10'")))?.code).toBe('42501');
    expect((await failure(db.query("DELETE FROM usage.near_usd_rates WHERE day = '2001-02-10'")))?.code).toBe('42501');
    expect((await failure(db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ('2001-02-11', 1, 'x')")))?.code).toBe('42501');
    expect((await failure(db.query("UPDATE usage.near_usd_rates SET day = '2001-02-12' WHERE day = '2001-03-10'")))?.code).toBe('42501');
    // Another month's rate still changes (the audited override, PUT /api/rates/:day).
    expect(await failure(asAdmin(() => db.query("SELECT usage.override_rate('2001-03-10', 2600000, 'staff', 'corrected from the contract source')")))).toBeNull();
    expect((await failure(asAdmin(() => db.query("SELECT usage.override_rate('2001-02-10', 2600000, 'staff', 'corrected from the contract source')"))))?.code).toBe('42501');
  });

  it('checks statement shapes: first-of-month, 32-byte hashes, a PDF key with its hash', async () => {
    const insert = (m: string, sha: string, pdf: string | null, pdfSha: string | null) =>
      failure(db.query(`INSERT INTO usage.statements (org_id, month, as_of, csv_key, csv_sha256, pdf_key, pdf_sha256, totals, issued_by) VALUES ('org_t', $1, now(), 'k', decode($2, 'hex'), $3, decode($4, 'hex'), '{}', 'staff')`, [m, sha, pdf, pdfSha]));
    expect((await insert('2001-04-02', 'ab'.repeat(32), null, null))?.code).toBe('23514');
    expect((await insert('2001-04-01', 'ab'.repeat(31), null, null))?.code).toBe('23514');
    expect((await insert('2001-04-01', 'ab'.repeat(32), 'k.pdf', null))?.code).toBe('23514');
    expect(await insert('2001-04-01', 'ab'.repeat(32), 'k.pdf', 'cd'.repeat(32))).toBeNull();
  });
});

describe('ensure_partitions', () => {
  it('is idempotent and bounded', async () => {
    expect((await db.query<{ n: number }>('SELECT usage.ensure_partitions(3) AS n'))[0]!.n).toBe(0);
    // 0001 and 0003 made 12 months ahead, and the writer's test above two more.
    expect((await db.query<{ n: number }>('SELECT usage.ensure_partitions(14) AS n'))[0]!.n).toBe(0);
    expect((await db.query<{ n: number }>('SELECT usage.ensure_partitions(16) AS n'))[0]!.n).toBe(2);
    for (const bad of [-1, 25]) expect((await failure(db.query('SELECT usage.ensure_partitions($1)', [bad])))?.code).toBe('22023');
  });
});

describe('settlement shape', () => {
  it('a final settlement has its sums; an unsettled one none', async () => {
    const insert = (result: string, gas: number | null, tokens: string | null) =>
      failure(db.query('INSERT INTO usage.gas_settlements (request_id, at, near_tx, result, gas_burnt, tokens_burnt) VALUES ($1, now(), $2, $3, $4, $5)', [rid(), 'tx', result, gas, tokens]));
    expect(await insert('final', 1, '2')).toBeNull();
    expect(await insert('unsettled', null, null)).toBeNull();
    expect((await insert('final', null, null))?.code).toBe('23514');
    expect((await insert('unsettled', 1, '2'))?.code).toBe('23514');
    expect((await insert('final', -1, '2'))?.code).toBe('23514');
  });
});
