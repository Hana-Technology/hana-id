// EVM gas sponsorship's billing records (D852): one permanent record per sponsored transaction that reached the chain
// (the batch, executed or reverted or run without effect, or the deadline's self-transfer), and one per charge that has
// no mined transaction of its own (`lost`: the reservation kept because nobody could prove nothing was spent;
// `consumed_elsewhere`: the relayer's nonce went to something else, its reservation kept), so the books add up.
//
// Where: the API's D1 table `evm_sponsor_billing` (migration 0022) is the record of truth, written in the same D1 batch
// as the audit row's final move (so a settled send can't exist without its record), and copied by the cron into the
// usage ledger (`usage.evm_sponsored_txs`, migrations-usage 0009, through `usage.record_evm_sponsored`), where the
// monthly statements and a later billing job read. The ledger copy is retried until it lands; nothing is lost while the
// ledger is off or unreachable.
//
// No personal data: no account address, no user id, no IP. The transaction hash is public chain data (anyone can read
// the transaction on the chain); the record holds it as proof of the charge. These records are never pruned and survive
// a user's erasure on purpose: they are Journear's books, not the user's profile (D852).
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { classifyWriteError, usageTransport } from '../usage/record.ts';
import type { Hex } from './sponsor-ports.ts';

/** What a record says happened. */
export type BillingOutcome = 'executed' | 'reverted' | 'not_executed' | 'cancelled' | 'mined' | 'lost' | 'consumed_elsewhere';

/** The figures of a mined transaction (null for a charge with no mined transaction). */
export interface BillingFigures {
  txHash: Hex;
  blockNumber: bigint | null;
  blockTimestamp: number | null;
  gasUsed: bigint | null;
  effectiveGasPrice: bigint | null;
  executionWei: bigint | null;
  l1FeeWei: bigint | null;
  operatorFeeWei: bigint | null;
  totalCostWei: bigint;
}

/** Where a record's key comes from: the transaction hash, or the audit row for a charge with no mined transaction. */
export const billingKey = (sendId: string, txHash: Hex | null): string => (txHash ? txHash.toLowerCase() : `send:${sendId}`);

const s = (n: bigint | null | undefined): string | null => (n === null || n === undefined ? null : n.toString());

/**
 * The statement that writes a send's billing record, to run in the same D1 batch as (and right after) the audit row's
 * move to `status`: it copies the app, its org, the batch's shape and times from the audit row, and writes only while
 * that row is in `status` and is not a relayer replay (the original send carries the transaction). INSERT OR IGNORE on
 * (chain, key) and on the send: a second settlement attempt writes nothing.
 */
export function billingStatement(env: Env, sendId: string, status: string, outcome: BillingOutcome, settledWei: bigint, figures: BillingFigures | null, now: number): D1PreparedStatement {
  const key = billingKey(sendId, figures?.txHash ?? null);
  return env.DB.prepare(
    `INSERT OR IGNORE INTO evm_sponsor_billing (chain_id, record_key, send_id, org_id, app_id, environment, tx_hash, block_number,
       block_timestamp, outcome, gas_used, effective_gas_price_wei, execution_wei, l1_fee_wei, operator_fee_wei, total_cost_wei,
       settled_wei, call_count, targets_json, with_setup, created_at, settled_at)
     SELECT s.chain_id, ?2, s.id, a.org_id, s.app_id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, s.call_count, s.targets_json,
            s.with_setup, s.created_at, ?15
       FROM evm_sponsor_sends s JOIN apps a ON a.id = s.app_id
      WHERE s.id = ?1 AND s.status = ?16 AND s.replay = 0`,
  ).bind(
    sendId,
    key,
    env.ENV_NAME,
    figures?.txHash?.toLowerCase() ?? null,
    s(figures?.blockNumber),
    figures?.blockTimestamp ?? null,
    outcome,
    s(figures?.gasUsed),
    s(figures?.effectiveGasPrice),
    s(figures?.executionWei),
    s(figures?.l1FeeWei),
    s(figures?.operatorFeeWei),
    s(figures?.totalCostWei),
    settledWei.toString(),
    now,
    status,
  );
}

/**
 * A correction (D847): the send's final figures when the relayer's verdict at confirmed depth names another of its
 * transactions than the receipt it was settled from (a reorg). A new record keyed 'fix:<send>' that names the record it
 * supersedes; the first is never edited. INSERT OR IGNORE: one correction per send. Never for a relayer replay (its
 * transaction is the original send's, which carries the record and its correction).
 */
export function correctionStatement(env: Env, sendId: string, corrects: string, outcome: BillingOutcome, settledWei: bigint, figures: BillingFigures, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO evm_sponsor_billing (chain_id, record_key, send_id, org_id, app_id, environment, tx_hash, block_number,
       block_timestamp, outcome, gas_used, effective_gas_price_wei, execution_wei, l1_fee_wei, operator_fee_wei, total_cost_wei,
       settled_wei, call_count, targets_json, with_setup, created_at, settled_at, corrects)
     SELECT s.chain_id, 'fix:' || s.id, s.id, a.org_id, s.app_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, s.call_count, s.targets_json,
            s.with_setup, s.created_at, ?14, ?15
       FROM evm_sponsor_sends s JOIN apps a ON a.id = s.app_id
      WHERE s.id = ?1 AND s.replay = 0`,
  ).bind(
    sendId,
    env.ENV_NAME,
    figures.txHash.toLowerCase(),
    s(figures.blockNumber),
    figures.blockTimestamp ?? null,
    outcome,
    s(figures.gasUsed),
    s(figures.effectiveGasPrice),
    s(figures.executionWei),
    s(figures.l1FeeWei),
    s(figures.operatorFeeWei),
    s(figures.totalCostWei),
    settledWei.toString(),
    now,
    corrects,
  );
}

// ---- the ledger copy (every cron run) ----

export const RECORD_EVM_SPONSORED_SQL = 'SELECT usage.record_evm_sponsored($1::jsonb) AS n';
/** Records copied per call, and calls per run. */
export const MIRROR_BATCH = 200;
export const MIRROR_BATCHES = 5;

interface BillingColumns {
  chain_id: number;
  record_key: string;
  org_id: string;
  app_id: string;
  environment: string;
  tx_hash: string | null;
  block_number: string | null;
  block_timestamp: number | null;
  outcome: BillingOutcome;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  execution_wei: string | null;
  l1_fee_wei: string | null;
  operator_fee_wei: string | null;
  total_cost_wei: string | null;
  settled_wei: string;
  call_count: number;
  targets_json: string;
  with_setup: number;
  created_at: number;
  settled_at: number;
  corrects: string | null;
}

/** A record as the ledger function takes it (times as ISO strings; amounts as decimal strings). */
export function ledgerRow(c: BillingColumns): Record<string, unknown> {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  let targets: unknown = [];
  try {
    targets = JSON.parse(c.targets_json);
  } catch {
    targets = [];
  }
  return {
    chain_id: c.chain_id,
    record_key: c.record_key,
    org_id: c.org_id,
    app_id: c.app_id,
    environment: c.environment,
    tx_hash: c.tx_hash,
    block_number: c.block_number,
    block_time: c.block_timestamp === null ? null : iso(c.block_timestamp * 1000),
    outcome: c.outcome,
    gas_used: c.gas_used,
    effective_gas_price_wei: c.effective_gas_price_wei,
    execution_wei: c.execution_wei,
    l1_fee_wei: c.l1_fee_wei,
    operator_fee_wei: c.operator_fee_wei,
    total_cost_wei: c.total_cost_wei,
    settled_wei: c.settled_wei,
    call_count: c.call_count,
    targets,
    with_setup: c.with_setup === 1,
    created_at: iso(c.created_at),
    settled_at: iso(c.settled_at),
    ...(c.corrects ? { corrects: c.corrects } : {}),
  };
}

/**
 * Copies records the ledger doesn't have yet (`mirrored_at` NULL) into `usage.evm_sponsored_txs` (idempotent there on
 * (chain, key)), then marks them. Without the `USAGE_DB` binding nothing is sent and the records wait in D1. Never
 * throws; a failure is logged (`evm_billing_mirror_failed`) and the next run sends the same records again.
 */
export async function mirrorEvmBilling(env: Env, now: number = Date.now()): Promise<number> {
  const binding = env.USAGE_DB;
  if (!binding) return 0;
  let sent = 0;
  for (let b = 0; b < MIRROR_BATCHES; b++) {
    let rows: BillingColumns[];
    try {
      rows = (
        await env.DB.prepare(
          `SELECT chain_id, record_key, org_id, app_id, environment, tx_hash, block_number, block_timestamp, outcome, gas_used,
                  effective_gas_price_wei, execution_wei, l1_fee_wei, operator_fee_wei, total_cost_wei, settled_wei, call_count,
                  targets_json, with_setup, created_at, settled_at, corrects
             FROM evm_sponsor_billing WHERE mirrored_at IS NULL AND quarantined_at IS NULL ORDER BY settled_at LIMIT ?1`,
        )
          .bind(MIRROR_BATCH)
          .all<BillingColumns>()
      ).results;
    } catch {
      return sent;
    }
    if (rows.length === 0) break;
    try {
      await usageTransport.query(binding, RECORD_EVM_SPONSORED_SQL, [JSON.stringify(rows.map(ledgerRow))]);
    } catch (err) {
      const why = classifyWriteError(err);
      log({ event: 'evm_billing_mirror_failed', code: why.code, synced: sent }, 'error');
      // The ledger refused the batch's input: one bad row must not hold every other back. Row by row (at most
      // QUARANTINE_TRIES of them), a row refused on its own is set aside (`quarantined_at`, `evm_billing_late`).
      if (why.kind === 'rejected') sent += await mirrorOneByOne(env, binding, rows.slice(0, QUARANTINE_TRIES), now);
      return sent;
    }
    try {
      await env.DB.prepare('UPDATE evm_sponsor_billing SET mirrored_at = ?1 WHERE mirrored_at IS NULL AND (chain_id, record_key) IN (SELECT json_extract(value, \'$[0]\'), json_extract(value, \'$[1]\') FROM json_each(?2))')
        .bind(now, JSON.stringify(rows.map((r) => [r.chain_id, r.record_key])))
        .run();
    } catch {
      // Sent but not marked: the next run sends them again and the ledger ignores the copies.
      return sent + rows.length;
    }
    sent += rows.length;
    if (rows.length < MIRROR_BATCH) break;
  }
  if (sent > 0) log({ event: 'evm_billing_mirror', outcome: 'ok', synced: sent });
  return sent;
}

/** Rows tried alone after the ledger refused a batch's input. */
export const QUARANTINE_TRIES = 20;

async function mirrorOneByOne(env: Env, binding: Hyperdrive, rows: BillingColumns[], now: number): Promise<number> {
  let sent = 0;
  for (const r of rows) {
    try {
      await usageTransport.query(binding, RECORD_EVM_SPONSORED_SQL, [JSON.stringify([ledgerRow(r)])]);
      await env.DB.prepare('UPDATE evm_sponsor_billing SET mirrored_at = ?3 WHERE chain_id = ?1 AND record_key = ?2').bind(r.chain_id, r.record_key, now).run();
      sent++;
    } catch (err) {
      if (classifyWriteError(err).kind !== 'rejected') return sent;
      await env.DB.prepare('UPDATE evm_sponsor_billing SET quarantined_at = ?3 WHERE chain_id = ?1 AND record_key = ?2').bind(r.chain_id, r.record_key, now).run().catch(() => undefined);
      log({ event: 'evm_billing_quarantined', code: 'ledger_refused' }, 'error');
    }
  }
  return sent;
}

/** A settled send without its billing record, or a record the ledger hasn't had for this long, is raised to staff. */
export const BILLING_LATE_MS = 60 * 60_000;

/**
 * Counts what's late: settled sends (not replays) older than BILLING_LATE_MS with no billing record, and (with the
 * ledger bound) records not copied to it within BILLING_LATE_MS. Null when it can't be read.
 */
export async function lateBilling(env: Env, now: number = Date.now()): Promise<{ missing: number; unmirrored: number; quarantined: number } | null> {
  try {
    const missing = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM evm_sponsor_sends s
        WHERE s.status IN ('executed', 'reverted', 'not_executed', 'mined', 'lost', 'consumed_elsewhere') AND s.replay = 0 AND s.updated_at <= ?1
          AND NOT EXISTS (SELECT 1 FROM evm_sponsor_billing b WHERE b.send_id = s.id)`,
    )
      .bind(now - BILLING_LATE_MS)
      .first<{ n: number }>();
    const unmirrored = env.USAGE_DB ? await env.DB.prepare('SELECT COUNT(*) AS n FROM evm_sponsor_billing WHERE mirrored_at IS NULL AND quarantined_at IS NULL AND settled_at <= ?1').bind(now - BILLING_LATE_MS).first<{ n: number }>() : { n: 0 };
    const quarantined = await env.DB.prepare('SELECT COUNT(*) AS n FROM evm_sponsor_billing WHERE quarantined_at IS NOT NULL AND mirrored_at IS NULL').first<{ n: number }>();
    return { missing: missing?.n ?? 0, unmirrored: unmirrored?.n ?? 0, quarantined: quarantined?.n ?? 0 };
  } catch {
    return null;
  }
}
