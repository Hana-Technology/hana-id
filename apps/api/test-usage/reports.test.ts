// The report, ledger and statement functions of migrations-usage 0006 (batch C12) on PGlite (D140): docs/batch-c-spec.md
// "Tests: Usage ledger" (reports, settlement, statements) and the C4 obligation (review L7, D222; D321): a relayed
// event is billed only when its transaction is its own.
import { REPORT_MAX_DAYS, type ReportSqlRow, formatTgas, usageRowOf, usdMicrosOf } from '@hana-id/console-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, freshDb, type TestDb } from './db.ts';

let db: TestDb;
const MONTHS = ['2025_01', '2025_02', '2025_03'];
beforeAll(async () => {
  db = await freshDb();
  for (const m of MONTHS) {
    const [y, mo] = m.split('_').map(Number) as [number, number];
    const from = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
    const to = new Date(Date.UTC(y, mo, 1)).toISOString();
    await db.exec(`CREATE TABLE usage.events_${m} PARTITION OF usage.events FOR VALUES FROM ('${from}') TO ('${to}')`);
  }
});
afterAll(async () => {
  await db.close();
});

let seq = 0;
const TX = () => {
  // A base58 hash-shaped string, unique per call.
  const n = (++seq).toString().replace(/0/gu, 'z');
  return `Tx${n}${'A'.repeat(40 - n.length)}`;
};
const PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

interface Ev {
  rid?: string;
  at: string;
  received?: string;
  org?: string;
  app?: string | null;
  scope?: string;
  endpoint?: string;
  outcome?: 'ok' | 'rejected' | 'error';
  code?: string | null;
  latency?: number;
  relayed?: boolean;
  tx?: string;
  nonce?: string;
  uid?: number;
}

/** Inserts an event as the owner (full control of received_at); returns its request id and tx. */
async function ev(e: Ev): Promise<{ rid: string; tx: string | null; at: string }> {
  const rid = e.rid ?? `req-${++seq}-xxxxxxxx`;
  const relayed = e.relayed ?? false;
  const tx = relayed ? (e.tx ?? TX()) : (e.tx ?? null);
  const outcome = e.outcome ?? 'ok';
  await db.query(
    `INSERT INTO usage.events (request_id, at, received_at, org_id, app_id, scope_id, endpoint, outcome, code, status, latency_ms, relayed, near_tx, relayer_pk, relayer_nonce, uid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 200, $10, $11, $12, $13, $14, $15)`,
    [
      rid,
      e.at,
      e.received ?? e.at,
      e.org ?? 'org_a',
      e.app === undefined ? 'app_1' : e.app,
      e.scope ?? 's1',
      e.endpoint ?? 'login',
      outcome,
      outcome === 'ok' ? null : (e.code ?? 'contract_rejected'),
      e.latency ?? 100,
      relayed,
      tx,
      tx ? PK : null,
      tx ? (e.nonce ?? String(1000 + seq)) : null,
      e.uid === undefined ? null : Buffer.from(new Uint8Array(16).fill(e.uid)),
    ],
  );
  return { rid, tx, at: e.at };
}

async function settle(rid: string, at: string, tx: string, gas: bigint | null, tokens: bigint | null, reason: string | null = null): Promise<void> {
  await db.query('INSERT INTO usage.gas_settlements (request_id, at, near_tx, result, gas_burnt, tokens_burnt, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    rid,
    at,
    tx,
    gas === null ? 'unsettled' : 'final',
    gas === null ? null : gas.toString(),
    tokens === null ? null : tokens.toString(),
    reason,
  ]);
}

const report = (org: string, from: string, to: string, by: 'day' | 'month', apps: string[] | null = null, asOf: string | null = null) =>
  db.query<ReportSqlRow>('SELECT * FROM usage.org_report($1, $2::date, $3::date, $4, $5::text[], $6::timestamptz)', [org, from, to, by, apps, asOf]);

const nearestRank = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
};

describe('usage.org_report', () => {
  it('percentiles (exact nearest rank) match brute force with 1, 2 and random samples', async () => {
    const cases: [string, number[]][] = [
      ['org_p1', [250]],
      ['org_p2', [300, 100]],
      ['org_pr', Array.from({ length: 57 }, (_, i) => ((i * 7919) % 997) + 1)],
    ];
    for (const [org, lat] of cases) {
      for (const l of lat) await ev({ org, at: '2025-01-10T12:00:00Z', latency: l });
      // Derives and failed logins don't enter the login percentiles.
      await ev({ org, at: '2025-01-10T12:00:00Z', endpoint: 'derive', latency: 9999 });
      await ev({ org, at: '2025-01-10T12:00:00Z', outcome: 'rejected', code: 'bad_token', latency: 9999 });
      const [r] = await report(org, '2025-01-10', '2025-01-10', 'day');
      expect(r!.login_p50, org).toBe(nearestRank(lat, 0.5));
      expect(r!.login_p95, org).toBe(nearestRank(lat, 0.95));
      expect(r!.derive_p50).toBe(9999);
    }
  });

  it('puts 23:59:59.999 UTC in its day and midnight in the next', async () => {
    await ev({ org: 'org_utc', at: '2025-01-31T23:59:59.999Z' });
    await ev({ org: 'org_utc', at: '2025-02-01T00:00:00.000Z' });
    await ev({ org: 'org_utc', at: '2025-02-01T00:00:00.000Z', endpoint: 'derive' });
    const days = await report('org_utc', '2025-01-31', '2025-02-01', 'day');
    expect(days.map((r) => [r.period, Number(r.logins), Number(r.derives)])).toEqual([
      ['2025-01-31', 1, 0],
      ['2025-02-01', 1, 1],
    ]);
    const months = await report('org_utc', '2025-01-01', '2025-02-28', 'month');
    expect(months.map((r) => [r.period, Number(r.logins)])).toEqual([
      ['2025-01', 1],
      ['2025-02', 1],
    ]);
    // The range is inclusive of its last day and stops at its midnight.
    expect((await report('org_utc', '2025-01-31', '2025-01-31', 'day')).map((r) => r.period)).toEqual(['2025-01-31']);
  });

  it('counts MAU as distinct uids across days and endpoints; new users from app_users.first_seen', async () => {
    const org = 'org_mau';
    await ev({ org, app: 'app_m', at: '2025-01-03T10:00:00Z', uid: 1 });
    await ev({ org, app: 'app_m', at: '2025-01-04T10:00:00Z', endpoint: 'session', uid: 1 });
    await ev({ org, app: 'app_m', at: '2025-01-05T10:00:00Z', endpoint: 'derive', uid: 1 });
    await ev({ org, app: 'app_m', at: '2025-01-05T11:00:00Z', uid: 2 });
    await db.query("INSERT INTO usage.app_users (app_id, uid, first_seen, last_seen) VALUES ('app_m', $1, '2025-01-03', '2025-01-05'), ('app_m', $2, '2024-12-20', '2025-01-05')", [
      Buffer.from(new Uint8Array(16).fill(1)),
      Buffer.from(new Uint8Array(16).fill(2)),
    ]);
    const [m] = await report(org, '2025-01-01', '2025-01-31', 'month');
    expect(Number(m!.active_users)).toBe(2);
    expect(Number(m!.logins)).toBe(3);
    expect(Number(m!.new_users)).toBe(1);
    const days = await report(org, '2025-01-01', '2025-01-31', 'day');
    expect(days.map((r) => [r.period, Number(r.active_users), Number(r.new_users)])).toEqual([
      ['2025-01-03', 1, 1],
      ['2025-01-04', 1, 0],
      ['2025-01-05', 2, 0],
    ]);
  });

  it('values gas in USD per day (round half up of yocto × rate / 10^24), a month the sum of its days; NULL without a rate', async () => {
    const org = 'org_usd';
    // Vectors: [yocto burnt, usd_micros per NEAR, expected micro-dollars].
    const vectors: [bigint, bigint, bigint][] = [
      [500_000_000_000_000_000n, 1n, 0n], // 5e17 × 1 / 1e24 = 5e-7 micro-dollars → 0
      [500_000_000_000_000_000_000_000n, 1n, 1n], // exactly 0.5 → 1 (half up)
      [499_999_999_999_999_999_999_999n, 1n, 0n], // just under 0.5 → 0
      [1_000_000_000_000_000_000_000_000n, 2_345_678n, 2_345_678n], // 1 NEAR
      [3_244_726_730_498_400_000_000n, 2_500_000n, 8_112n], // a create_session_and_derive at 2.50 USD
    ];
    for (const [y, r, want] of vectors) expect(usdMicrosOf(y, r), `${y} @ ${r}`).toBe(want);
    const days = ['2025-02-10', '2025-02-11', '2025-02-12'];
    for (const [i, [y, r]] of vectors.slice(1, 4).entries()) {
      const e = await ev({ org, at: `${days[i]}T08:00:00Z`, relayed: true });
      await settle(e.rid, e.at, e.tx!, 1_000_000_000_000n, y);
      await db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ($1, $2, 'coingecko') ON CONFLICT DO NOTHING", [days[i], r.toString()]);
    }
    const rows = await report(org, '2025-02-10', '2025-02-12', 'day');
    expect(rows.map((r) => [r.period, r.usd_micros, Number(r.near_usd_rate), r.rate_source])).toEqual([
      ['2025-02-10', '1', 1, 'coingecko'],
      ['2025-02-11', '0', 1, 'coingecko'],
      ['2025-02-12', '2345678', 2345678, 'coingecko'],
    ]);
    const [month] = await report(org, '2025-02-10', '2025-02-12', 'month');
    expect(month!.usd_micros).toBe('2345679');
    expect(month!.near_usd_rate).toBeNull();
    // A day with gas and no rate: that day and its month have no USD.
    const late = await ev({ org, at: '2025-02-13T08:00:00Z', relayed: true });
    await settle(late.rid, late.at, late.tx!, 1n, 1n);
    expect((await report(org, '2025-02-13', '2025-02-13', 'day'))[0]!.usd_micros).toBeNull();
    expect((await report(org, '2025-02-10', '2025-02-13', 'month'))[0]!.usd_micros).toBeNull();
  });

  it('splits settled gas into all, relayed-then-rejected and error; refused-before-relay has none; unsettled counted', async () => {
    const org = 'org_gas';
    const ok = await ev({ org, at: '2025-01-20T01:00:00Z', relayed: true });
    const rej = await ev({ org, at: '2025-01-20T02:00:00Z', relayed: true, outcome: 'rejected', code: 'contract_rejected' });
    const err = await ev({ org, at: '2025-01-20T03:00:00Z', relayed: true, outcome: 'error', code: 'timeout' });
    const pending = await ev({ org, at: '2025-01-20T04:00:00Z', relayed: true });
    const lost = await ev({ org, at: '2025-01-20T05:00:00Z', relayed: true });
    await ev({ org, at: '2025-01-20T06:00:00Z', outcome: 'rejected', code: 'bad_token' });
    await settle(ok.rid, ok.at, ok.tx!, 30_000_000_000_000n, 3_000_000_000_000_000_000_000n);
    await settle(rej.rid, rej.at, rej.tx!, 2_200_000_000_000n, 220_000_000_000_000_000_000n);
    await settle(err.rid, err.at, err.tx!, 5_000_000_000_000n, 500_000_000_000_000_000_000n);
    await settle(lost.rid, lost.at, lost.tx!, null, null, 'not_final');
    void pending;
    const [r] = await report(org, '2025-01-20', '2025-01-20', 'day');
    expect([r!.gas, r!.rejected_gas, r!.error_gas]).toEqual(['37200000000000', '2200000000000', '5000000000000']);
    expect([r!.burnt_yocto, r!.rejected_yocto, r!.error_yocto]).toEqual(['3720000000000000000000', '220000000000000000000', '500000000000000000000']);
    expect(Number(r!.unsettled)).toBe(2);
    const row = usageRowOf(org, r!);
    expect(row.tgas).toBe('37.2');
    expect(row.relayedRejectedTgas).toBe('2.2');
    expect(row.errorTgas).toBe('5');
    expect(row.failuresByCode).toEqual({ bad_token: 1, contract_rejected: 1, timeout: 1 });
  });

  it('returns owner actions per scope (app NULL) after the app rows; an app filter leaves them out', async () => {
    const org = 'org_own';
    await ev({ org, app: 'app_z', scope: 's9', at: '2025-01-15T00:00:00Z' });
    await ev({ org, app: null, scope: 's9', endpoint: 'owner_action', at: '2025-01-15T00:00:01Z' });
    await ev({ org, app: null, scope: 's9', endpoint: 'owner_action', at: '2025-01-15T00:00:02Z', outcome: 'rejected', code: 'not_owner' });
    const rows = await report(org, '2025-01-15', '2025-01-15', 'day');
    expect(rows.map((r) => [r.app_id, r.scope_id, Number(r.logins), Number(r.owner_actions)])).toEqual([
      ['app_z', 's9', 1, 0],
      [null, 's9', 0, 1],
    ]);
    expect((await report(org, '2025-01-15', '2025-01-15', 'day', ['app_z'])).map((r) => r.app_id)).toEqual(['app_z']);
  });

  it('includes link relays and the identity tokens copied for the org', async () => {
    const org = 'org_link';
    await ev({ org, app: 'app_l', at: '2025-01-16T00:00:00Z', endpoint: 'link' });
    await ev({ org, app: 'app_l', at: '2025-01-16T00:00:00Z', endpoint: 'link_unlink' });
    await db.query("INSERT INTO usage.identity_tokens (app_id, day, org_id, scope_id, tokens) VALUES ('app_l', '2025-01-16', $1, 's1', 4), ('app_l', '2025-01-17', $1, 's1', 2)", [org]);
    const rows = await report(org, '2025-01-16', '2025-01-17', 'day');
    expect(rows.map((r) => [r.period, Number(r.link_actions), Number(r.identity_tokens)])).toEqual([
      ['2025-01-16', 2, 4],
      ['2025-01-17', 0, 2],
    ]);
  });

  it('never returns another org’s rows', async () => {
    await ev({ org: 'org_other', at: '2025-01-21T00:00:00Z' });
    await ev({ org: 'org_mine', at: '2025-01-21T00:00:00Z' });
    const rows = await report('org_mine', '2025-01-21', '2025-01-21', 'day');
    expect(rows.map((r) => Number(r.logins))).toEqual([1]);
    expect(await report('org_nobody', '2025-01-01', '2025-01-31', 'day')).toEqual([]);
  });

  it(`refuses ranges over ${REPORT_MAX_DAYS} days, an inverted range, more than 100 apps and a bad grouping`, async () => {
    expect(await failure(report('org_a', '2025-01-01', '2026-02-04', 'day'))).toBeNull(); // exactly 400 days
    for (const p of [
      report('org_a', '2025-01-01', '2026-02-05', 'day'),
      report('org_a', '2025-01-02', '2025-01-01', 'day'),
      report('org_a', '2025-01-01', '2025-01-02', 'week' as 'day'),
      report('org_a', '2025-01-01', '2025-01-02', 'day', Array.from({ length: 101 }, (_, i) => `app_${i}`)),
      report('org_a', '2025-01-01', '2025-01-02', 'day', []),
    ]) {
      expect((await failure(p))?.code).toBe('22023');
    }
  });

  it('is callable by the writer and the admin, with no table access for the writer', async () => {
    expect(await failure(db.asRole('usage_writer', () => report('org_mine', '2025-01-21', '2025-01-21', 'day')))).toBeNull();
    expect(await failure(db.asRole('usage_admin', () => report('org_mine', '2025-01-21', '2025-01-21', 'day')))).toBeNull();
    expect((await failure(db.asRole('usage_writer', () => db.query("SELECT * FROM usage.classified('org_mine', now(), now(), NULL)"))))?.code).toBe('42501');
    expect((await failure(db.asRole('usage_admin', () => db.query("SELECT * FROM usage.classified('org_mine', now(), now(), NULL)"))))?.code).toBe('42501');
  });
});

describe('billing only a transaction of its own (C4 review L7, D222)', () => {
  it('a near_tx carried by two relayed events bills neither, even when the first had settled final', async () => {
    const org = 'org_dup';
    const first = await ev({ org, at: '2025-03-02T01:00:00Z', relayed: true });
    await settle(first.rid, first.at, first.tx!, 4_000_000_000_000n, 400_000_000_000_000_000_000n);
    expect((await report(org, '2025-03-02', '2025-03-02', 'day'))[0]!.gas).toBe('4000000000000');
    // A second event (another org, as a leaked writer credential could write) attaches the same transaction.
    const copy = await ev({ org: 'org_thief', at: '2025-03-02T01:00:05Z', received: '2025-03-02T02:00:00Z', relayed: true, tx: first.tx! });
    await settle(copy.rid, copy.at, copy.tx!, null, null, 'duplicate_tx');
    const [r] = await report(org, '2025-03-02', '2025-03-02', 'day');
    expect([r!.gas, Number(r!.unsettled)]).toEqual(['0', 1]);
    expect((await report('org_thief', '2025-03-02', '2025-03-02', 'day'))[0]!.gas).toBe('0');
    // Read as of a time before the copy arrived, the first is billed again: a statement stays reproducible.
    expect((await report(org, '2025-03-02', '2025-03-02', 'day', null, '2025-03-02T01:30:00Z'))[0]!.gas).toBe('4000000000000');
  });

  it('a settlement row of another event with the same request id never bills a second event', async () => {
    const org = 'org_rid';
    const a = await ev({ org, rid: 'req-collide-1', at: '2025-03-03T01:00:00Z', relayed: true });
    await ev({ org, rid: 'req-collide-1', at: '2025-03-03T01:00:01Z', relayed: true });
    await settle(a.rid, a.at, a.tx!, 1_000_000_000_000n, 100n);
    const [r] = await report(org, '2025-03-03', '2025-03-03', 'day');
    expect([r!.gas, Number(r!.unsettled)]).toEqual(['1000000000000', 1]);
    // Not pending either: it doesn't hold back a statement.
    expect((await db.query<{ pending: string }>("SELECT pending::text FROM usage.statement_blockers($1, '2025-03-01')", [org]))[0]!.pending).toBe('0');
  });

  it('a signer or nonce mismatch recorded by settlement is unsettled, not billed', async () => {
    const org = 'org_mis';
    const e = await ev({ org, at: '2025-03-04T01:00:00Z', relayed: true });
    await settle(e.rid, e.at, e.tx!, null, null, 'signer_mismatch');
    const [r] = await report(org, '2025-03-04', '2025-03-04', 'day');
    expect([r!.gas, Number(r!.unsettled)]).toEqual(['0', 1]);
    // The settlement's shape: a reason only on an unsettled row.
    expect((await failure(settle('req-x-xxxxxxxx', e.at, e.tx!, 1n, 1n, 'signer_mismatch')))?.code).toBe('23514');
    expect((await failure(settle('req-y-xxxxxxxx', e.at, e.tx!, null, null, 'made_up')))?.code).toBe('23514');
  });
});

describe('usage.org_ledger', () => {
  it('pages by (request id, at); its final gas equals the report’s for the same as_of; late events excluded', async () => {
    const org = 'org_led';
    const settled: { gas: bigint; tokens: bigint }[] = [];
    for (let i = 0; i < 7; i++) {
      const e = await ev({ org, at: `2025-02-0${i + 1}T10:00:00Z`, relayed: i % 2 === 0, app: i === 6 ? null : 'app_1', endpoint: i === 6 ? 'owner_action' : 'login' });
      if (e.tx) {
        const gas = BigInt(1_000_000_000_000 * (i + 1));
        const tokens = gas * 100_000_000n;
        await settle(e.rid, e.at, e.tx, gas, tokens);
        settled.push({ gas, tokens });
      }
    }
    // A late event (received after the as_of) and a pending one.
    await ev({ org, at: '2025-02-20T10:00:00Z', received: '2025-03-05T00:00:00Z', relayed: true });
    const asOf = '2025-03-04T00:00:00Z';
    const all: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (;;) {
      const page: Record<string, unknown>[] = await db.query('SELECT * FROM usage.org_ledger($1, $2::date, $3::timestamptz, $4, $5)', [org, '2025-02-01', asOf, after, 3]);
      all.push(...page);
      if (page.length < 3) break;
      const last = page[page.length - 1]!;
      after = `${String(last.request_id)},${String(last.at_ms)}`;
    }
    expect(all.length).toBe(7);
    expect(new Set(all.map((r) => r.request_id)).size).toBe(7);
    expect(all.map((r) => r.gas_status).sort()).toEqual(['final', 'final', 'final', 'final', 'none', 'none', 'none']);
    const sumGas = all.reduce((n, r) => n + BigInt(String(r.gas_burnt ?? 0)), 0n);
    const sumTokens = all.reduce((n, r) => n + BigInt(String(r.tokens_burnt ?? 0)), 0n);
    expect(sumGas).toBe(settled.reduce((n, s) => n + s.gas, 0n));
    const [month] = await report(org, '2025-02-01', '2025-02-28', 'month', null, asOf);
    const own = (await report(org, '2025-02-01', '2025-02-28', 'month', null, asOf)).reduce((n, r) => n + BigInt(r.gas), 0n);
    expect(own).toBe(sumGas);
    expect(month).toBeTruthy();
    expect((await report(org, '2025-02-01', '2025-02-28', 'month', null, asOf)).reduce((n, r) => n + BigInt(r.burnt_yocto), 0n)).toBe(sumTokens);
    expect(formatTgas(sumGas)).toBe('16');
    // Without the as_of bound the late event is there, pending.
    const now = await db.query<{ gas_status: string }>("SELECT gas_status FROM usage.org_ledger($1, '2025-02-01', NULL, NULL, 1000)", [org]);
    expect(now.filter((r) => r.gas_status === 'pending').length).toBe(1);
  });

  it('refuses a bad month, cursor or page size', async () => {
    for (const [m, after, lim] of [
      ['2025-02-02', null, 10],
      ['2025-02-01', 'not a cursor', 10],
      ['2025-02-01', null, 0],
      ['2025-02-01', null, 1001],
    ] as const) {
      expect((await failure(db.query('SELECT * FROM usage.org_ledger($1, $2::date, NULL, $3, $4)', ['org_led', m, after, lim])))?.code).toBe('22023');
    }
  });
});

describe('statements: blockers, late events, rates', () => {
  it('names relayed events without a settlement and the days without a rate', async () => {
    const org = 'org_blk';
    const a = await ev({ org, at: '2025-01-05T00:00:00Z', relayed: true });
    await ev({ org, at: '2025-01-06T00:00:00Z' });
    const [b1] = await db.query<{ pending: string; missing_rate_days: string[] }>("SELECT pending::text, missing_rate_days FROM usage.statement_blockers($1, '2025-01-01')", [org]);
    expect(b1!.pending).toBe('1');
    await settle(a.rid, a.at, a.tx!, 1n, 1n);
    await db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) SELECT d::date, 2500000, 'coingecko' FROM generate_series('2025-01-01'::date, '2025-01-30'::date, interval '1 day') d ON CONFLICT DO NOTHING");
    const [b2] = await db.query<{ pending: string; missing_rate_days: string[] }>("SELECT pending::text, missing_rate_days FROM usage.statement_blockers($1, '2025-01-01')", [org]);
    expect(b2).toEqual({ pending: '0', missing_rate_days: ['2025-01-31'] });
  });

  it('lists late events of a month with a statement as after_statement; org_statements returns the totals', async () => {
    const org = 'org_late';
    await ev({ org, at: '2025-01-09T00:00:00Z', received: '2025-01-09T00:00:01Z' });
    await ev({ org, at: '2025-01-09T00:00:00Z', received: '2025-02-04T00:00:00Z' });
    await db.query(
      "INSERT INTO usage.statements (org_id, month, as_of, csv_key, csv_sha256, totals, issued_by) VALUES ($1, '2025-01-01', '2025-02-03T00:00:00Z', 'k', decode(repeat('ab', 32), 'hex'), '{\"v\":1}', 'staff')",
      [org],
    );
    const [r] = await report(org, '2025-01-09', '2025-01-09', 'day');
    expect([Number(r!.logins), Number(r!.after_statement)]).toEqual([2, 1]);
    const [s] = await db.asRole('usage_writer', () => db.query<Record<string, unknown>>('SELECT * FROM usage.org_statements($1)', [org]));
    expect(s).toMatchObject({ month: '2025-01', csv_sha256: 'ab'.repeat(32), totals: { v: 1 }, issued_by: 'staff' });
    expect(Number(s!.as_of_ms)).toBe(Date.parse('2025-02-03T00:00:00Z'));
  });

  it('overrides a rate through usage.override_rate only, with an audit row; refused once the month has a statement', async () => {
    const admin = <T>(fn: () => Promise<T>) => db.asRole('usage_admin', fn);
    await admin(() => db.query("INSERT INTO usage.near_usd_rates (day, usd_micros, source) VALUES ('2025-03-10', 2000000, 'coingecko')"));
    const [{ id }] = (await admin(() => db.query<{ id: string }>("SELECT usage.override_rate('2025-03-10', 2100000, 'staff@hana.example', 'Provider outage: rate from the contract source') AS id")))!;
    expect(Number(id)).toBeGreaterThan(0);
    const [rate] = await db.query('SELECT usd_micros::text, source, entered_by FROM usage.near_usd_rates WHERE day = $1', ['2025-03-10']);
    expect(rate).toEqual({ usd_micros: '2100000', source: 'manual', entered_by: 'staff@hana.example' });
    const [audit] = await admin(() => db.query('SELECT usd_micros::text, previous_usd_micros::text, previous_source, entered_by, reason FROM usage.rate_overrides WHERE day = $1', ['2025-03-10']));
    expect(audit).toEqual({ usd_micros: '2100000', previous_usd_micros: '2000000', previous_source: 'coingecko', entered_by: 'staff@hana.example', reason: 'Provider outage: rate from the contract source' });
    // A new day through the override has no previous rate.
    await admin(() => db.query("SELECT usage.override_rate('2025-03-11', 2200000, 'staff@hana.example', 'No fetched rate for this day')"));
    for (const bad of [
      "SELECT usage.override_rate('2025-03-12', 0, 's', 'a valid reason here')",
      "SELECT usage.override_rate('2025-03-12', 1, 's', 'short')",
      "SELECT usage.override_rate('2999-01-01', 1, 's', 'a valid reason here')",
      "SELECT usage.override_rate('2025-03-12', 1, '', 'a valid reason here')",
    ]) {
      expect((await failure(admin(() => db.query(bad))))?.code, bad).toBe('22023');
    }
    // January has a statement (above): its rates are frozen, the override included.
    expect((await failure(admin(() => db.query("SELECT usage.override_rate('2025-01-15', 2600000, 'staff', 'too late for this month')"))))?.code).toBe('42501');
    // The writer can't override.
    expect((await failure(db.asRole('usage_writer', () => db.query("SELECT usage.override_rate('2025-03-12', 1, 's', 'a valid reason here')"))))?.code).toBe('42501');
  });
});

describe('usage.rejection_rates', () => {
  it('counts relayed attempts and relayed-then-rejected ones per org for the day (gate refusals are not relayed)', async () => {
    for (let i = 0; i < 4; i++) await ev({ org: 'org_rr', at: '2025-03-20T05:00:00Z', relayed: true });
    await ev({ org: 'org_rr', at: '2025-03-20T05:00:00Z', relayed: true, outcome: 'rejected', code: 'contract_rejected' });
    await ev({ org: 'org_rr', at: '2025-03-20T05:00:00Z', outcome: 'rejected', code: 'bad_token' });
    await ev({ org: 'org_rr', at: '2025-03-21T00:00:00Z', relayed: true, outcome: 'rejected', code: 'contract_rejected' });
    const rows = await db.asRole('usage_admin', () => db.query<{ org_id: string; relayed: string; rejected: string }>("SELECT org_id, relayed::text, rejected::text FROM usage.rejection_rates('2025-03-20')"));
    expect(rows.filter((r) => r.org_id === 'org_rr')).toEqual([{ org_id: 'org_rr', relayed: '5', rejected: '1' }]);
    expect((await failure(db.asRole('usage_writer', () => db.query("SELECT * FROM usage.rejection_rates('2025-03-20')"))))?.code).toBe('42501');
  });
});
