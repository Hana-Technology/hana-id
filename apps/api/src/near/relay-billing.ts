// The NEAR meta-transaction relay's billing records (D863), on the pattern of EVM sponsorship's (D852): one permanent
// record per NEAR transaction the relay sent for a user that reached the chain (a relayed delegate action or an account
// activation; success or failure), so a future billing of partners can count what Journear paid.
//
// - At the relay (near/relay.ts): once the relay has its answer and the transaction may have run (anything but "certainly
//   not sent"), one D1 INSERT OR IGNORE keyed on (network, tx hash), run AFTER the answer (`waitUntil`): the request path
//   waits for nothing and behaves exactly as before. The relay's figures are provisional (EXECUTED_OPTIMISTIC).
//   A write that fails (migration 0023 not applied yet, D1 unreachable) never fails the relay: it is counted (a
//   RateLimiter counter, which needs no migration) and the cron raises `near_billing_late`.
// - The cron (every run, bounded): re-reads each new record's transaction at FINAL (the relay account is the signer)
//   for the settled gas, tokens burnt, status and block (as the login pool's `usage.gas_settlements` are settled at
//   FINAL), then copies final records to the usage ledger (`usage.near_relayed_txs`, migrations-usage 0010).
//
// No personal data: no user account id, user id or IP; the receiver is the contract a delegate called (an allowlisted
// receiver), never the user's account; an activation's receiver (the user's account) is not stored. The transaction hash
// is public chain data (D863 says what it reveals).
//
// SECURITY: nothing here logs a hash, an account or an amount.
import type { App } from '../apps.ts';
import type { Env } from '../env.ts';
import { limiter } from '../handlers.ts';
import { log } from '../log.ts';
import type { RelayResult } from '../relayer-key.ts';
import { classifyWriteError, usageTransport } from '../usage/record.ts';
import { eventId } from '../changes/guard.ts';
import { statusObject } from './outcome.ts';
import { nearRelayConfig } from './relay.ts';
import { type FinalOutcome, nearRpc } from './rpc.ts';
import { burntGas } from './tx.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

/** What the relay sent, as the record keeps it (no user data). */
export interface NearRelayFacts {
  kind: 'delegate' | 'activation';
  /** A delegate's receiver contract; null for an activation (its receiver is the user's account). */
  receiver: string | null;
  methods: string[];
  /** NEAR the relay attached or sent on the user's behalf (an activation's transfer; a delegate's deposits, 0 by policy). */
  attachedYocto: bigint;
}

/** The answer's code as the record keeps it (`ok` for a success). */
const relayCode = (r: RelayResult): string => (r.ok ? 'ok' : r.code.slice(0, 40));

/** The provisional outcome from the relay's answer: final only after the cron's FINAL read. */
function provisional(r: RelayResult): 'executed' | 'failed' | 'pending' {
  if (r.ok) return 'executed';
  if (r.code === 'contract_rejected' || r.code === 'delegate_rejected') return 'failed';
  return 'pending';
}

/** Where a write that failed is counted (a RateLimiter `spend` total per UTC day: no migration needed). */
const MISSES_SUBJECT = 'near-relay:billing';
const MISSES = 'near-relay:billing-misses';

/**
 * The relay's billing write, to run after its answer. `sent`: the relay's result was not "certainly not sent" (the
 * caller decides with certainlyNotSent). Without a transaction hash there is nothing on chain to record. Never throws.
 */
export async function recordNearRelay(env: Env, app: App, result: RelayResult, facts: NearRelayFacts, now: number = Date.now()): Promise<void> {
  const hash = result.nearTx;
  if (typeof hash !== 'string' || !B58.test(hash)) return;
  const gas = result.relayGasBurnt && /^\d{1,20}$/u.test(result.relayGasBurnt) ? result.relayGasBurnt : null;
  const tokens = result.relayTokensBurnt && /^\d{1,40}$/u.test(result.relayTokensBurnt) ? result.relayTokensBurnt : null;
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO near_relay_billing (network, tx_hash, org_id, app_id, environment, kind, relay_code, outcome, gas_burnt,
         tokens_burnt, attached_yocto, receiver, methods_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
      .bind(env.NETWORK, hash, app.org_id, app.id, env.ENV_NAME, facts.kind, relayCode(result), provisional(result), gas, tokens, facts.attachedYocto.toString(), facts.kind === 'activation' ? null : facts.receiver, JSON.stringify(facts.methods.slice(0, 8)), now)
      .run();
  } catch {
    log({ event: 'near_billing_write_failed', code: 'audit_unavailable' }, 'error');
    await limiter(env, MISSES_SUBJECT).charge(MISSES, DAY, '1', now, now).catch(() => undefined);
  }
}

/**
 * Runs the write after the answer when an execution context is given (the request waits for nothing), else in the
 * background. Never throws, never delays or changes the relay's answer.
 */
export function recordAfterAnswer(env: Env, exec: Pick<ExecutionContext, 'waitUntil'> | undefined, app: App, result: RelayResult, facts: NearRelayFacts): void {
  const p = recordNearRelay(env, app, result, facts).catch(() => undefined);
  if (exec) exec.waitUntil(p);
}

// ---- the cron: FINAL, the ledger copy, lateness ----

/** Records read at FINAL per run, and how long a record waits before its first FINAL read. */
export const FINALIZE_ROWS = 20;
export const FINALIZE_AFTER_MS = MINUTE;
/** A record whose transaction is still unknown this long after the relay is given up (`unknown`, provisional figures kept). */
export const FINALIZE_GIVE_UP_MS = 6 * HOUR;
export const NEAR_BILLING_LATE_MS = HOUR;
export const RECORD_NEAR_RELAYED_SQL = 'SELECT usage.record_near_relayed($1::jsonb) AS n';
export const MIRROR_BATCH = 200;

interface Row {
  network: string;
  tx_hash: string;
  org_id: string;
  app_id: string;
  environment: string;
  kind: 'delegate' | 'activation';
  relay_code: string;
  outcome: string;
  block_height: string | null;
  block_time: number | null;
  gas_burnt: string | null;
  tokens_burnt: string | null;
  attached_yocto: string;
  receiver: string | null;
  methods_json: string;
  created_at: number;
  final_at: number | null;
}

/** A settled outcome's status: `failed` when the transaction or any receipt failed, else `executed`. */
export function finalStatus(o: FinalOutcome): 'executed' | 'failed' {
  if ('Failure' in (statusObject(o.status) ?? {})) return 'failed';
  const failed = o.receipts_outcome?.some((r) => typeof r.outcome.status === 'object' && r.outcome.status !== null && 'Failure' in r.outcome.status && r.outcome.status.Failure);
  return failed ? 'failed' : 'executed';
}

/**
 * Re-reads each record's transaction at FINAL (signer: the relay account) for the settled gas and tokens burnt, the
 * status and the block (height, time). Bounded: FINALIZE_ROWS a run. A transaction still unknown FINALIZE_GIVE_UP_MS
 * after the relay keeps the relay's figures as `unknown`. Never throws; returns the records finalised.
 */
export async function finalizeNearBilling(env: Env, now: number = Date.now()): Promise<number> {
  const config = nearRelayConfig(env);
  if (!config) return 0;
  let rows: Row[];
  try {
    rows = (
      await env.DB.prepare('SELECT * FROM near_relay_billing WHERE final_at IS NULL AND created_at <= ?1 ORDER BY created_at LIMIT ?2').bind(now - FINALIZE_AFTER_MS, FINALIZE_ROWS).all<Row>()
    ).results;
  } catch {
    return 0; // before migration 0023 there is no table
  }
  const rpc = nearRpc(env);
  let done = 0;
  for (const r of rows) {
    let o: FinalOutcome | null = null;
    try {
      o = await rpc.call<FinalOutcome>('tx', { tx_hash: r.tx_hash, sender_account_id: config.account, wait_until: 'FINAL' }, 10_000);
    } catch {
      o = null;
    }
    const gas = o ? burntGas(o) : null;
    if (!o || !gas) {
      if (now - r.created_at < FINALIZE_GIVE_UP_MS) continue;
      await env.DB.prepare("UPDATE near_relay_billing SET outcome = 'unknown', final_at = ?3 WHERE network = ?1 AND tx_hash = ?2 AND final_at IS NULL").bind(r.network, r.tx_hash, now).run().catch(() => undefined);
      done++;
      continue;
    }
    let height: string | null = null;
    let time: number | null = null;
    const blockHash = (o.transaction_outcome as { block_hash?: unknown } | undefined)?.block_hash;
    if (typeof blockHash === 'string' && B58.test(blockHash)) {
      try {
        const b = await rpc.call<{ header?: { height?: unknown; timestamp?: unknown } }>('block', { block_id: blockHash }, 8_000);
        const h = b.header?.height;
        const ts = b.header?.timestamp;
        if (typeof h === 'number' && Number.isSafeInteger(h) && h >= 0) height = String(h);
        if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) time = Math.floor(ts / 1_000_000);
        else if (typeof ts === 'string' && /^\d{1,25}$/u.test(ts)) time = Number(BigInt(ts) / 1_000_000n);
      } catch {
        // the block's figures stay empty; the money is what matters
      }
    }
    try {
      await env.DB.prepare(
        `UPDATE near_relay_billing SET outcome = ?3, gas_burnt = ?4, tokens_burnt = ?5, block_height = ?6, block_time = ?7, final_at = ?8
          WHERE network = ?1 AND tx_hash = ?2 AND final_at IS NULL`,
      )
        .bind(r.network, r.tx_hash, finalStatus(o), gas.gasBurnt.toString(), gas.tokensBurnt.toString(), height, time, now)
        .run();
      done++;
    } catch {
      // the next run
    }
  }
  return done;
}

/** A final record as the ledger function takes it. */
export function nearLedgerRow(r: Row): Record<string, unknown> {
  let methods: unknown = [];
  try {
    methods = JSON.parse(r.methods_json);
  } catch {
    methods = [];
  }
  return {
    network: r.network,
    tx_hash: r.tx_hash,
    org_id: r.org_id,
    app_id: r.app_id,
    environment: r.environment,
    kind: r.kind,
    relay_code: r.relay_code,
    outcome: r.outcome,
    block_height: r.block_height,
    block_time: r.block_time === null ? null : new Date(r.block_time).toISOString(),
    gas_burnt: r.gas_burnt,
    tokens_burnt_yocto: r.tokens_burnt,
    attached_yocto: r.attached_yocto,
    receiver: r.receiver,
    methods,
    created_at: new Date(r.created_at).toISOString(),
    final_at: r.final_at === null ? null : new Date(r.final_at).toISOString(),
  };
}

/**
 * Copies final records the ledger doesn't have yet into `usage.near_relayed_txs` (idempotent there), then marks them.
 * Without `USAGE_DB` nothing is sent and the records wait in D1. Never throws.
 */
export async function mirrorNearBilling(env: Env, now: number = Date.now()): Promise<number> {
  const binding = env.USAGE_DB;
  if (!binding) return 0;
  let rows: Row[];
  try {
    rows = (await env.DB.prepare('SELECT * FROM near_relay_billing WHERE final_at IS NOT NULL AND mirrored_at IS NULL ORDER BY created_at LIMIT ?1').bind(MIRROR_BATCH).all<Row>()).results;
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;
  try {
    await usageTransport.query(binding, RECORD_NEAR_RELAYED_SQL, [JSON.stringify(rows.map(nearLedgerRow))]);
  } catch (err) {
    log({ event: 'near_billing_mirror_failed', code: classifyWriteError(err).code }, 'error');
    return 0;
  }
  await env.DB.prepare("UPDATE near_relay_billing SET mirrored_at = ?1 WHERE mirrored_at IS NULL AND (network || ' ' || tx_hash) IN (SELECT value FROM json_each(?2))")
    .bind(now, JSON.stringify(rows.map((r) => `${r.network} ${r.tx_hash}`)))
    .run()
    .catch(() => undefined);
  log({ event: 'near_billing_mirror', outcome: 'ok', synced: rows.length });
  return rows.length;
}

/**
 * What's late: failed writes counted today, records not final, and (with the ledger bound) records not copied, an hour
 * on. Writes one `near_billing_late` an hour when any is non-zero; logs when it can't (the event's CHECK before
 * migration 0023). Never throws.
 */
export async function checkNearBillingLate(env: Env, now: number = Date.now()): Promise<{ misses: number; notFinal: number; unmirrored: number }> {
  let misses = 0;
  try {
    misses = Number(await limiter(env, MISSES_SUBJECT).spent(MISSES, DAY, now));
  } catch {
    misses = 0;
  }
  let notFinal = 0;
  let unmirrored = 0;
  try {
    notFinal = (await env.DB.prepare('SELECT COUNT(*) AS n FROM near_relay_billing WHERE final_at IS NULL AND created_at <= ?1').bind(now - NEAR_BILLING_LATE_MS).first<{ n: number }>())?.n ?? 0;
    if (env.USAGE_DB) unmirrored = (await env.DB.prepare('SELECT COUNT(*) AS n FROM near_relay_billing WHERE final_at IS NOT NULL AND mirrored_at IS NULL AND final_at <= ?1').bind(now - NEAR_BILLING_LATE_MS).first<{ n: number }>())?.n ?? 0;
  } catch {
    // no table yet: the misses tell
  }
  const counts = { misses, notFinal, unmirrored };
  if (misses > 0 || notFinal > 0 || unmirrored > 0) {
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'near_billing_late', ?3)")
        .bind(await eventId('near_billing_late', String(Math.floor(now / HOUR) * HOUR)), now, JSON.stringify(counts))
        .run();
    } catch {
      log({ event: 'near_billing_alert_failed', code: 'near_billing_late' }, 'error');
    }
  }
  return counts;
}

/** The cron's part (every run): FINAL, the ledger copy, lateness. Never throws. */
export async function nearBillingMaintenance(env: Env, now: number = Date.now()): Promise<void> {
  await finalizeNearBilling(env, now).catch(() => 0);
  await mirrorNearBilling(env, now).catch(() => 0);
  await checkNearBillingLate(env, now).catch(() => undefined);
}
