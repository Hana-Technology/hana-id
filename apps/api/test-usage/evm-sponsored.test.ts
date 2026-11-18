// migrations-usage 0009: the EVM sponsored transactions' billing records (D852), copied by the API's cron
// (src/evm/sponsor-billing.ts mirrorEvmBilling) through `usage.record_evm_sponsored`. On PGlite (D140), as the writer
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

const hash = (b: string) => `0x${b.repeat(32)}`;
const row = (patch: Record<string, unknown> = {}) => ({
  chain_id: 84532,
  record_key: hash('aa'),
  org_id: 'org_a',
  app_id: 'app_a',
  environment: 'sandbox-dev',
  tx_hash: hash('aa'),
  block_number: '123',
  block_time: '2026-11-18T01:02:03.000Z',
  outcome: 'executed',
  gas_used: '60000',
  effective_gas_price_wei: '150000000',
  execution_wei: '9000000000000',
  l1_fee_wei: '500',
  operator_fee_wei: '0',
  total_cost_wei: '9000000000500',
  settled_wei: '9000000000500',
  call_count: 1,
  targets: [{ address: `0x${'c4'.repeat(20)}`, selector: '0x183ff085' }],
  with_setup: true,
  created_at: '2026-11-18T01:02:00.000Z',
  settled_at: '2026-11-18T01:02:30.000Z',
  ...patch,
});
const copy = (rows: unknown) => db.asRole('usage_writer', () => db.query<{ n: number }>('SELECT usage.record_evm_sponsored($1::jsonb) AS n', [JSON.stringify(rows)])).then((r) => r[0]!.n);
const count = async () => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM usage.evm_sponsored_txs'))[0]!.n);

describe('usage.record_evm_sponsored (D852)', () => {
  it('records each transaction once (a copy changes nothing), and a charge without a transaction by its send key', async () => {
    expect(await copy([row(), row({ record_key: 'send:es_00000000000000000000000000000001', tx_hash: null, outcome: 'lost', block_number: null, block_time: null, gas_used: null, effective_gas_price_wei: null, execution_wei: null, l1_fee_wei: null, operator_fee_wei: null, total_cost_wei: null, settled_wei: '300000000000000' })])).toBe(2);
    expect(await copy([row({ settled_wei: '1' })])).toBe(0);
    const [r] = await db.query<{ settled_wei: string; outcome: string; with_setup: boolean }>("SELECT settled_wei::text AS settled_wei, outcome, with_setup FROM usage.evm_sponsored_txs WHERE record_key = $1", [hash('aa')]);
    expect(r).toEqual({ settled_wei: '9000000000500', outcome: 'executed', with_setup: true });
  });

  it('is queryable per org, app and month (the monthly view, staff only)', async () => {
    const rows = await db.asRole('usage_admin', () =>
      db.query<{ org_id: string; app_id: string; month: string; outcome: string; transactions: string; settled_wei: string }>(
        "SELECT org_id, app_id, to_char(month, 'YYYY-MM') AS month, outcome, transactions::text AS transactions, settled_wei::text AS settled_wei FROM usage.evm_sponsored_monthly ORDER BY outcome",
      ),
    );
    expect(rows).toEqual([
      { org_id: 'org_a', app_id: 'app_a', month: '2026-11', outcome: 'executed', transactions: '1', settled_wei: '9000000000500' },
      { org_id: 'org_a', app_id: 'app_a', month: '2026-11', outcome: 'lost', transactions: '1', settled_wei: '300000000000000' },
    ]);
    // The writer can't read it, nor write it directly.
    expect((await failure(db.asRole('usage_writer', () => db.query('SELECT * FROM usage.evm_sponsored_txs'))))?.code).toBe('42501');
  });

  const bad: [string, unknown][] = [
    ['not an array', row()],
    ['an unknown field (an address)', [{ ...row(), account: `0x${'11'.repeat(20)}` }]],
    ['a malformed hash', [row({ tx_hash: '0x12', record_key: '0x12' })]],
    ['an unknown outcome', [row({ outcome: 'refunded' })]],
    ['a negative or decimal amount', [row({ settled_wei: '-1' })]],
    ['a number for an amount', [row({ settled_wei: 5 })]],
    ['a bad target', [row({ targets: [{ address: 'x', selector: '0x183ff085' }] })]],
    ['a target with an extra field', [row({ targets: [{ address: `0x${'c4'.repeat(20)}`, selector: '0x183ff085', user: 'u' }] })]],
    ['a key that is not the hash', [row({ record_key: hash('bb') })]],
    ['too many calls', [row({ call_count: 9 })]],
  ];
  for (const [what, rows] of bad) {
    it(`refuses ${what}, writing nothing`, async () => {
      const before = await count();
      expect(await failure(copy(rows))).not.toBeNull();
      expect(await count()).toBe(before);
    });
  }

  it('survives the retention functions and an erasure: never pruned, never stripped', async () => {
    await copy([row({ record_key: hash('cc'), tx_hash: hash('cc'), created_at: '2017-01-01T00:00:00.000Z', settled_at: '2017-01-01T00:01:00.000Z' })]);
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
