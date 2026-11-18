// migrations-usage 0010: the NEAR meta-transaction relay's billing records (D863), copied by the API's cron
// (src/near/relay-billing.ts mirrorNearBilling) through `usage.record_near_relayed`. On PGlite (D140), as the writer
// role's Hyperdrive connection runs. Never pruned by the retention functions, never touched by an erasure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, freshDb, type TestDb } from './db.ts';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const HASH = '9vCrVxB9Z9zBs8Gmyqh1W2hJ5L3DzJ1vCrVxB9Z9zBs8';
const row = (patch: Record<string, unknown> = {}) => ({
  network: 'testnet',
  tx_hash: HASH,
  org_id: 'org_a',
  app_id: 'app_a',
  environment: 'sandbox-dev',
  kind: 'delegate',
  relay_code: 'ok',
  outcome: 'executed',
  block_height: '1000',
  block_time: '2026-11-18T01:02:03.000Z',
  gas_burnt: '2428000000000',
  tokens_burnt_yocto: '242800000000000000000',
  attached_yocto: '0',
  receiver: 'stamps.journear.testnet',
  methods: ['collect'],
  created_at: '2026-11-18T01:02:00.000Z',
  final_at: '2026-11-18T01:03:00.000Z',
  had_failed_receipt: false,
  figures_from: 'relay',
  block_hash: '7tkzFg8RHBmMw1ncRJZCCZAizgq4rwCftTKYLce8RU8t',
  ...patch,
});
const copy = (rows: unknown) => db.asRole('usage_writer', () => db.query<{ n: number }>('SELECT usage.record_near_relayed($1::jsonb) AS n', [JSON.stringify(rows)])).then((r) => r[0]!.n);
const count = async () => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM usage.near_relayed_txs'))[0]!.n);

describe('usage.record_near_relayed (D863)', () => {
  it('records each transaction once, an activation without a receiver; a copy changes nothing', async () => {
    const act = row({ tx_hash: `${HASH.slice(0, -1)}A`, kind: 'activation', receiver: null, methods: [], attached_yocto: '0', relay_code: 'ok' });
    expect(await copy([row(), act])).toBe(2);
    expect(await copy([row({ tokens_burnt_yocto: '1' })])).toBe(0);
    const [r] = await db.query<{ tokens_burnt: string; receiver: string }>('SELECT tokens_burnt::text AS tokens_burnt, receiver FROM usage.near_relayed_txs WHERE tx_hash = $1', [HASH]);
    expect(r).toEqual({ tokens_burnt: '242800000000000000000', receiver: 'stamps.journear.testnet' });
  });

  it('is queryable per org, app and month (staff only)', async () => {
    const rows = await db.asRole('usage_admin', () =>
      db.query<{ kind: string; month: string; transactions: string; tokens_burnt_yocto: string | null }>(
        "SELECT kind, to_char(month, 'YYYY-MM') AS month, transactions::text AS transactions, tokens_burnt_yocto::text AS tokens_burnt_yocto FROM usage.near_relayed_monthly WHERE org_id = 'org_a' ORDER BY kind",
      ),
    );
    expect(rows).toEqual([
      { kind: 'activation', month: '2026-11', transactions: '1', tokens_burnt_yocto: '242800000000000000000' },
      { kind: 'delegate', month: '2026-11', transactions: '1', tokens_burnt_yocto: '242800000000000000000' },
    ]);
    expect((await failure(db.asRole('usage_writer', () => db.query('SELECT * FROM usage.near_relayed_txs'))))?.code).toBe('42501');
  });

  const bad: [string, unknown][] = [
    ['not an array', row()],
    ['an unknown field (the user’s account)', [{ ...row(), sender: 'a'.repeat(64) }]],
    ['a hex hash', [row({ tx_hash: `0x${'ab'.repeat(32)}` })]],
    ['an activation naming a receiver', [row({ kind: 'activation' })]],
    ['a delegate without a receiver', [row({ receiver: null })]],
    ['a pending outcome (only final records are copied)', [row({ outcome: 'pending' })]],
    ['a bad method name', [row({ methods: ['a b'] })]],
    ['a negative amount', [row({ attached_yocto: '-1' })]],
  ];
  for (const [what, rows] of bad) {
    it(`refuses ${what}, writing nothing`, async () => {
      const before = await count();
      expect(await failure(copy(rows))).not.toBeNull();
      expect(await count()).toBe(before);
    });
  }

  it('survives the retention functions and an erasure', async () => {
    await copy([row({ tx_hash: `${HASH.slice(0, -1)}B`, created_at: '2017-01-01T00:00:00.000Z', final_at: '2017-01-01T00:01:00.000Z' })]);
    const before = await count();
    await db.asRole('usage_admin', async () => {
      await db.query('SELECT * FROM usage.drop_expired_partitions()');
      await db.query('SELECT * FROM usage.strip_uids(10000)');
      await db.query('SELECT * FROM ops.purge_expired()');
      await db.query("SELECT * FROM usage.erase_uid(decode('00112233445566778899aabbccddeeff', 'hex'))");
    });
    expect(await count()).toBe(before);
  });
});

describe('the outcomes and flags of D863 as amended', () => {
  it('takes not_executed, a failed callback flag and where the figures came from; refuses a bad flag or source', async () => {
    const h = '8vCrVxB9Z9zBs8Gmyqh1W2hJ5L3DzJ1vCrVxB9Z9zBs8';
    expect(await copy([row({ tx_hash: h, outcome: 'not_executed', had_failed_receipt: true, figures_from: 'final', block_hash: null })])).toBe(1);
    const [r] = await db.query<{ outcome: string; had_failed_receipt: boolean; figures_from: string }>('SELECT outcome, had_failed_receipt, figures_from FROM usage.near_relayed_txs WHERE tx_hash = $1', [h]);
    expect(r).toEqual({ outcome: 'not_executed', had_failed_receipt: true, figures_from: 'final' });
    for (const bad of [{ had_failed_receipt: 1 }, { figures_from: 'guess' }, { block_hash: 'not base58!' }]) {
      expect((await failure(copy([row({ tx_hash: '6vCrVxB9Z9zBs8Gmyqh1W2hJ5L3DzJ1vCrVxB9Z9zBs8', ...bad })])))?.message).toBeTruthy();
    }
  });
});
