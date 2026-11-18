// The NEAR meta-transaction relay's billing records (D863), on the pattern of EVM sponsorship's (D852): one permanent
// record per NEAR transaction the relay sent for a user (a relayed delegate action or an account activation), so a
// future billing of partners can count what Journear paid, and a check that none is missing.
//
// - At the relay (near/relay.ts): once the relay has its answer and the transaction may have run, one D1 INSERT OR
//   IGNORE keyed on (network, tx hash), run AFTER the answer (`waitUntil`): the request path waits for nothing and
//   behaves exactly as before. Most records are final at once:
//     · an `ok` relay: the relay waited for every receipt (EXECUTED_OPTIMISTIC) and summed the gas and tokens burnt over
//       the transaction and every receipt (near/tx.ts burntGas; refund receipts burn nothing): those figures are the
//       transaction's, `figures_from: 'relay'`;
//     · a relay that certainly never ran: `near_rejected` (a definite validation refusal before inclusion) and
//       `relayer_busy` with a hash (dropped: a later nonce of the key landed, or the nonce refused): `not_executed`,
//       nothing burnt.
//   Every other result (a contract or delegate failure, whose receipt decides whether the user's own action failed; a
//   timeout; an RPC error; an `ok` without figures) is read again by the cron. A write that fails is parked in a
//   RateLimiter queue (bounded) for the cron to write later; a result that may have been sent but has no hash, or a
//   park that fails, is counted as a miss.
// - The cron (every run, its own budget of NEAR_BILLING_FETCHES outside fetches, its own RPC client and health so it can
//   never mark an endpoint down for the relay): drains the parked records; once a UTC day checks each relay key's nonce
//   on chain against the recorded nonces; reads due records with `tx` `wait_until: 'NONE'` (an answer at once), final
//   only when the node says FINAL, else tried again later (doubling from a minute); fills block heights and times with
//   whatever budget is left; copies final records to the usage ledger (`usage.near_relayed_txs`, migrations-usage 0010).
//   A record is `unknown` only after GIVE_UP_TRIES actual reads and six hours.
//
// Pseudonymous: no name, email, account id or user id; the receiver is the contract a delegate called (an allowlisted
// receiver), never the user's account; an activation's receiver (the user's account) is not stored. The transaction
// hash and the relay key's nonce are public chain data that can be traced to an account (D863).
//
// SECURITY: nothing here logs a hash, an account or an amount.
import type { App } from '../apps.ts';
import { eventId } from '../changes/guard.ts';
import type { Env } from '../env.ts';
import { limiter } from '../handlers.ts';
import { log } from '../log.ts';
import type { RelayResult } from '../relayer-key.ts';
import { classifyWriteError, usageTransport } from '../usage/record.ts';
import { statusObject } from './outcome.ts';
import { nearRelayConfig, nearRelayKeys } from './relay.ts';
import { type FinalOutcome, RpcError, RpcHealth, nearRpcEndpoint, rpcEndpoints } from './rpc.ts';
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

/** Relay results that certainly never ran on chain: final at once, nothing burnt. */
const NEVER_RAN: ReadonlySet<string> = new Set(['near_rejected', 'relayer_busy']);

/** The record as the relay's answer makes it: final at once when the answer is complete (see the header). */
export function initialRecord(r: RelayResult): { outcome: 'executed' | 'not_executed' | 'pending'; gas: string | null; tokens: string | null; final: boolean } {
  const gas = r.relayGasBurnt && /^\d{1,20}$/u.test(r.relayGasBurnt) ? r.relayGasBurnt : null;
  const tokens = r.relayTokensBurnt && /^\d{1,40}$/u.test(r.relayTokensBurnt) ? r.relayTokensBurnt : null;
  if (!r.ok && NEVER_RAN.has(r.code)) return { outcome: 'not_executed', gas: '0', tokens: '0', final: true };
  if (r.ok && gas !== null && tokens !== null) return { outcome: 'executed', gas, tokens, final: true };
  return { outcome: 'pending', gas, tokens, final: false };
}

/** Where misses are counted (a RateLimiter `charge` per UTC day: no migration needed) and failed writes parked. */
const BILLING_SUBJECT = 'near-relay:billing';
const MISSES = 'near-relay:billing-misses';
const NONCE_GAPS = 'near-relay:billing-nonce-gaps';
const PARKED = 'near-relay-billing';
/** Records parked at most (beyond it a failed write is only counted). */
export const PARK_MAX = 500;
/** The first FINAL read of a record that isn't final at once, and its doubling backoff's ceiling. */
export const FIRST_TRY_MS = MINUTE;
export const MAX_BACKOFF_MS = 6 * HOUR;

const toNonce = (v: string | undefined): number | null => (v && /^\d{1,16}$/u.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);

interface Fields {
  network: string;
  tx_hash: string;
  org_id: string;
  app_id: string;
  environment: string;
  kind: 'delegate' | 'activation';
  relay_code: string;
  outcome: string;
  figures_from: string | null;
  gas_burnt: string | null;
  tokens_burnt: string | null;
  attached_yocto: string;
  receiver: string | null;
  methods_json: string;
  relayer_pk: string | null;
  relayer_nonce: number | null;
  created_at: number;
  final_at: number | null;
  next_try_at: number;
}

const insertSql = `INSERT OR IGNORE INTO near_relay_billing (network, tx_hash, org_id, app_id, environment, kind, relay_code, outcome, figures_from, gas_burnt,
    tokens_burnt, attached_yocto, receiver, methods_json, relayer_pk, relayer_nonce, created_at, final_at, next_try_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`;

const insert = (env: Env, f: Fields) =>
  env.DB.prepare(insertSql).bind(f.network, f.tx_hash, f.org_id, f.app_id, f.environment, f.kind, f.relay_code, f.outcome, f.figures_from, f.gas_burnt, f.tokens_burnt, f.attached_yocto, f.receiver, f.methods_json, f.relayer_pk, f.relayer_nonce, f.created_at, f.final_at, f.next_try_at);

const countMiss = (env: Env, now: number) => limiter(env, BILLING_SUBJECT).charge(MISSES, DAY, '1', now, now).catch(() => undefined);

/**
 * The relay's billing write, to run after its answer, for a result that may have been sent (the caller decides with
 * certainlyNotSent). No hash: nothing on chain can be named, so it counts as a miss. A failed write is parked for the
 * cron (or, the queue full or unreachable, counted). Never throws.
 */
export async function recordNearRelay(env: Env, app: App, result: RelayResult, facts: NearRelayFacts, now: number = Date.now()): Promise<void> {
  const hash = result.nearTx;
  if (typeof hash !== 'string' || !B58.test(hash)) {
    log({ event: 'near_billing_no_hash', code: relayCode(result) }, 'warn');
    await countMiss(env, now);
    return;
  }
  const first = initialRecord(result);
  const f: Fields = {
    network: env.NETWORK ?? 'testnet',
    tx_hash: hash,
    org_id: app.org_id,
    app_id: app.id,
    environment: env.ENV_NAME,
    kind: facts.kind,
    relay_code: relayCode(result),
    outcome: first.outcome,
    figures_from: first.final ? 'relay' : null,
    gas_burnt: first.gas,
    tokens_burnt: first.tokens,
    attached_yocto: facts.attachedYocto.toString(),
    receiver: facts.kind === 'activation' ? null : facts.receiver,
    methods_json: JSON.stringify(facts.methods.slice(0, 8)),
    relayer_pk: typeof result.relayerPk === 'string' && result.relayerPk.length <= 100 ? result.relayerPk : null,
    relayer_nonce: toNonce(result.relayerNonce),
    created_at: now,
    final_at: first.final ? now : null,
    next_try_at: first.final ? now : now + FIRST_TRY_MS,
  };
  try {
    await insert(env, f).run();
  } catch {
    log({ event: 'near_billing_write_failed', code: 'audit_unavailable' }, 'error');
    const parked = await limiter(env, BILLING_SUBJECT)
      .queuePush(PARKED, f, PARK_MAX, now)
      .catch(() => false);
    if (!parked) await countMiss(env, now);
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

// ---- the cron ----

/** Outside fetches one cron run of this job may make (the free plan's 50 a run are shared with the other jobs). */
export const NEAR_BILLING_FETCHES = 10;
/** Actual FINAL reads, and age, before a record is given up as `unknown` (its provisional figures kept). */
export const GIVE_UP_TRIES = 8;
export const FINALIZE_GIVE_UP_MS = 6 * HOUR;
export const NEAR_BILLING_LATE_MS = HOUR;
export const RECORD_NEAR_RELAYED_SQL = 'SELECT usage.record_near_relayed($1::jsonb) AS n';
export const MIRROR_BATCH = 200;
/** One attempt's limit: `wait_until: 'NONE'` answers at once, so a slow node is simply asked again later. */
const READ_TIMEOUT_MS = 5_000;

/**
 * The cron's own NEAR client: at most `max` fetches a run (each call is exactly one: one endpoint, no failover inside),
 * its own RpcHealth (it never marks an endpoint down for the relay), the next endpoint after one that gave no answer.
 */
export class BudgetedRpc {
  private used = 0;
  private at = 0;
  private readonly health = new RpcHealth();

  constructor(
    private readonly urls: readonly string[],
    private readonly max: number,
  ) {}

  get left(): number {
    return Math.max(0, this.max - this.used);
  }

  get fetches(): number {
    return this.used;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    if (this.left === 0) throw new Error('near billing: fetch budget spent');
    this.used++;
    const url = this.urls[this.at % this.urls.length] as string;
    try {
      return await nearRpcEndpoint(url, { health: this.health, viewTimeoutMs: READ_TIMEOUT_MS, txTimeoutMs: READ_TIMEOUT_MS }).call<T>(method, params, READ_TIMEOUT_MS);
    } catch (e) {
      // No JSON-RPC answer (network, timeout, 5xx): the next call asks the next endpoint.
      if (!(e instanceof RpcError) || e.rpc === null) this.at++;
      throw e;
    }
  }
}

interface Row extends Fields {
  had_failed_receipt: number;
  block_hash: string | null;
  block_height: string | null;
  block_time: number | null;
  mirrored_at: number | null;
  tries: number;
}

interface Receipt {
  id?: string;
  outcome: { status: { Failure?: unknown } | string; receipt_ids?: string[] };
}

const failedStatus = (s: unknown): boolean => typeof s === 'object' && s !== null && 'Failure' in s && Boolean((s as { Failure?: unknown }).Failure);

/**
 * A settled outcome's status. `failed` when the transaction itself or one of the user's own action's receipts failed:
 * for an activation the transaction's first receipt (the transfer); for a delegate the first receipt (the delegate
 * action) and the receipts it produced (the user's calls). A failure only in a later receipt (a callback of a call that
 * itself succeeded) is `executed` with `hadFailedReceipt`. Without receipt ids, the first one or two receipts are the
 * user's. Amounts are the same either way.
 */
export function finalStatus(o: FinalOutcome, kind: 'delegate' | 'activation' = 'delegate'): { outcome: 'executed' | 'failed'; hadFailedReceipt: boolean } {
  const receipts = (o.receipts_outcome ?? []) as Receipt[];
  const txFailed = 'Failure' in (statusObject(o.status) ?? {});
  const byId = new Map(receipts.filter((r) => typeof r.id === 'string').map((r) => [r.id as string, r]));
  const firstId = (o.transaction_outcome as { outcome?: { receipt_ids?: string[] } } | undefined)?.outcome?.receipt_ids?.[0];
  let own: Receipt[];
  const first = firstId ? byId.get(firstId) : undefined;
  if (first) own = kind === 'delegate' ? [first, ...(first.outcome.receipt_ids ?? []).map((id) => byId.get(id)).filter((r): r is Receipt => r !== undefined)] : [first];
  else own = receipts.slice(0, kind === 'delegate' ? 2 : 1);
  const failed = txFailed || own.some((r) => failedStatus(r.outcome.status));
  const anyFailed = receipts.some((r) => failedStatus(r.outcome.status));
  return { outcome: failed ? 'failed' : 'executed', hadFailedReceipt: !failed && anyFailed };
}

/** A block's height and time (ms) from nearcore's `block` answer: `header.height`, `header.timestamp_nanosec` (else `timestamp`, ns). */
export function blockFigures(b: unknown): { height: string | null; time: number | null } {
  const h = (b as { header?: { height?: unknown; timestamp?: unknown; timestamp_nanosec?: unknown } } | null)?.header;
  const height = typeof h?.height === 'number' && Number.isSafeInteger(h.height) && h.height >= 0 ? String(h.height) : null;
  let time: number | null = null;
  if (typeof h?.timestamp_nanosec === 'string' && /^\d{1,25}$/u.test(h.timestamp_nanosec)) time = Number(BigInt(h.timestamp_nanosec) / 1_000_000n);
  else if (typeof h?.timestamp === 'number' && Number.isFinite(h.timestamp) && h.timestamp > 0) time = Math.floor(h.timestamp / 1_000_000);
  return { height, time };
}

/** Writes the parked records into D1 (no fetch). */
async function drainParked(env: Env): Promise<number> {
  let parked: [string, unknown][];
  try {
    parked = await limiter(env, BILLING_SUBJECT).queuePeek(PARKED, 50);
  } catch {
    return 0;
  }
  const done: string[] = [];
  for (const [key, item] of parked) {
    try {
      await insert(env, item as Fields).run();
      done.push(key);
    } catch {
      break; // D1 still refuses: the next run
    }
  }
  if (done.length) await limiter(env, BILLING_SUBJECT).queueAck(PARKED, done).catch(() => undefined);
  return done.length;
}

/**
 * Once a UTC day, per relay key (one `view_access_key` each, inside the budget): the key's nonce on chain against the
 * records' nonces. A range is checked a day after it was seen (its records have landed by then): every nonce the key
 * used in it should have a record. The missing ones are counted for `near_billing_late`.
 */
async function checkNonces(env: Env, rpc: BudgetedRpc, now: number): Promise<number> {
  const config = nearRelayConfig(env);
  const keys = nearRelayKeys(env);
  if (!config || keys.state !== 'ok') return 0;
  const day = Math.floor(now / DAY);
  const store = limiter(env, BILLING_SUBJECT);
  let gaps = 0;
  try {
    // Nothing recorded yet (or no table before migration 0023): nothing to compare, no chain read.
    const any = await env.DB.prepare('SELECT EXISTS (SELECT 1 FROM near_relay_billing) AS n').first<{ n: number }>();
    if (any?.n !== 1) return 0;
    if (!(await store.reserve(`near-billing-nonces:${day}`, (day + 2) * DAY, now))) return 0;
  } catch {
    return 0;
  }
  for (const pk of keys.publicKeys) {
    if (rpc.left === 0) break;
    let onChain: bigint;
    try {
      onChain = BigInt((await rpc.call<{ nonce: number | string }>('query', { request_type: 'view_access_key', finality: 'final', account_id: config.account, public_key: pk })).nonce);
    } catch {
      continue;
    }
    try {
      const [seen, checked] = await Promise.all([store.floor(`near-billing:seen:${pk}`), store.floor(`near-billing:checked:${pk}`)]);
      const lo = BigInt(checked);
      const hi = BigInt(seen);
      if (hi > lo && lo > 0n) {
        const recorded = await env.DB.prepare('SELECT COUNT(DISTINCT relayer_nonce) AS n FROM near_relay_billing WHERE relayer_pk = ?1 AND relayer_nonce > ?2 AND relayer_nonce <= ?3 AND outcome <> ?4')
          .bind(pk, Number(lo), Number(hi), 'not_executed')
          .first<{ n: number }>();
        const missing = Number(hi - lo) - (recorded?.n ?? 0);
        if (missing > 0) gaps += missing;
      }
      // The range just checked is done; the one seen now is checked tomorrow. The first run only starts the watermark.
      await store.raiseFloor(`near-billing:checked:${pk}`, (hi > 0n ? hi : onChain).toString());
      await store.raiseFloor(`near-billing:seen:${pk}`, onChain.toString());
    } catch {
      // the next day
    }
  }
  if (gaps > 0) await store.charge(NONCE_GAPS, DAY, String(gaps), now, now).catch(() => undefined);
  return gaps;
}

/**
 * Reads the due records (oldest `next_try_at` first) with `tx` `wait_until: 'NONE'`: final only when the node says
 * FINAL (the settled gas and tokens burnt, the status and the block's hash); else tried again later, doubling from a
 * minute. After GIVE_UP_TRIES actual reads and FINALIZE_GIVE_UP_MS a record keeps its relay figures as `unknown`. A
 * starved record (never read for want of budget) is never given up, only late. Returns the records finalised.
 */
export async function finalizeNearBilling(env: Env, rpc: BudgetedRpc, now: number = Date.now()): Promise<number> {
  const config = nearRelayConfig(env);
  if (!config || rpc.left === 0) return 0;
  let rows: Row[];
  try {
    rows = (
      await env.DB.prepare('SELECT * FROM near_relay_billing WHERE mirrored_at IS NULL AND final_at IS NULL AND next_try_at <= ?1 ORDER BY next_try_at LIMIT ?2').bind(now, rpc.left).all<Row>()
    ).results;
  } catch {
    return 0; // before migration 0023 there is no table
  }
  let done = 0;
  for (const r of rows) {
    if (rpc.left === 0) break;
    let o: FinalOutcome | null = null;
    try {
      o = await rpc.call<FinalOutcome>('tx', { tx_hash: r.tx_hash, sender_account_id: config.account, wait_until: 'NONE' });
    } catch {
      o = null;
    }
    const gas = o && o.final_execution_status === 'FINAL' ? burntGas(o) : null;
    const tries = r.tries + 1;
    if (!o || !gas) {
      const giveUp = tries >= GIVE_UP_TRIES && now - r.created_at >= FINALIZE_GIVE_UP_MS;
      const next = now + Math.min(FIRST_TRY_MS * 2 ** tries, MAX_BACKOFF_MS);
      await env.DB.prepare(giveUp ? "UPDATE near_relay_billing SET outcome = 'unknown', tries = ?3, final_at = ?4 WHERE network = ?1 AND tx_hash = ?2 AND final_at IS NULL" : 'UPDATE near_relay_billing SET tries = ?3, next_try_at = ?4 WHERE network = ?1 AND tx_hash = ?2 AND final_at IS NULL')
        .bind(r.network, r.tx_hash, tries, giveUp ? now : next)
        .run()
        .catch(() => undefined);
      if (giveUp) done++;
      continue;
    }
    const status = finalStatus(o, r.kind);
    const blockHash = (o.transaction_outcome as { block_hash?: unknown } | undefined)?.block_hash;
    try {
      await env.DB.prepare(
        `UPDATE near_relay_billing SET outcome = ?3, had_failed_receipt = ?4, figures_from = 'final', gas_burnt = ?5, tokens_burnt = ?6, block_hash = ?7, tries = ?8, final_at = ?9
          WHERE network = ?1 AND tx_hash = ?2 AND final_at IS NULL`,
      )
        .bind(r.network, r.tx_hash, status.outcome, status.hadFailedReceipt ? 1 : 0, gas.gasBurnt.toString(), gas.tokensBurnt.toString(), typeof blockHash === 'string' && B58.test(blockHash) ? blockHash : null, tries, now)
        .run();
      done++;
    } catch {
      // the next run
    }
  }
  return done;
}

/** With budget left: the block height and time of final records not yet copied (one `block` read each). */
async function fillBlocks(env: Env, rpc: BudgetedRpc): Promise<number> {
  if (rpc.left === 0) return 0;
  let rows: { network: string; tx_hash: string; block_hash: string }[];
  try {
    rows = (
      await env.DB.prepare('SELECT network, tx_hash, block_hash FROM near_relay_billing WHERE mirrored_at IS NULL AND final_at IS NOT NULL AND block_hash IS NOT NULL AND block_height IS NULL ORDER BY next_try_at LIMIT ?1')
        .bind(rpc.left)
        .all<{ network: string; tx_hash: string; block_hash: string }>()
    ).results;
  } catch {
    return 0;
  }
  let filled = 0;
  for (const r of rows) {
    if (rpc.left === 0) break;
    try {
      const b = blockFigures(await rpc.call('block', { block_id: r.block_hash }));
      if (b.height === null) continue;
      await env.DB.prepare('UPDATE near_relay_billing SET block_height = ?3, block_time = ?4 WHERE network = ?1 AND tx_hash = ?2').bind(r.network, r.tx_hash, b.height, b.time).run();
      filled++;
    } catch {
      // the money is what matters; the ledger can take the block later
    }
  }
  return filled;
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
    had_failed_receipt: r.had_failed_receipt === 1,
    figures_from: r.figures_from,
    block_hash: r.block_hash,
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
 * Copies final records the ledger doesn't have yet into `usage.near_relayed_txs` (idempotent there), then marks them in
 * one UPDATE. Without `USAGE_DB` nothing is sent and the records wait in D1. Never throws.
 */
export async function mirrorNearBilling(env: Env, now: number = Date.now()): Promise<number> {
  const binding = env.USAGE_DB;
  if (!binding) return 0;
  let rows: Row[];
  try {
    rows = (await env.DB.prepare('SELECT * FROM near_relay_billing WHERE mirrored_at IS NULL AND final_at IS NOT NULL ORDER BY next_try_at LIMIT ?1').bind(MIRROR_BATCH).all<Row>()).results;
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
 * What's late, once a UTC day with the counts (`near_billing_late`): today's misses (no hash, a write neither made nor
 * parked), records still parked, records not final past the give-up time, records not copied to the ledger an hour on,
 * and today's nonce gaps (transactions of a relay key without a record). Logs when the event can't be written (the
 * event's CHECK before migration 0023). Never throws.
 */
export async function checkNearBillingLate(env: Env, now: number = Date.now()): Promise<{ misses: number; parked: number; notFinal: number; unmirrored: number; nonceGaps: number }> {
  const store = limiter(env, BILLING_SUBJECT);
  const read = async (p: Promise<string | number>): Promise<number> => {
    try {
      return Number(await p);
    } catch {
      return 0;
    }
  };
  const [misses, parked, nonceGaps] = await Promise.all([read(store.spent(MISSES, DAY, now)), read(store.queueLength(PARKED)), read(store.spent(NONCE_GAPS, DAY, now))]);
  let notFinal = 0;
  let unmirrored = 0;
  try {
    notFinal = (await env.DB.prepare('SELECT COUNT(*) AS n FROM near_relay_billing WHERE mirrored_at IS NULL AND final_at IS NULL AND created_at <= ?1').bind(now - FINALIZE_GIVE_UP_MS).first<{ n: number }>())?.n ?? 0;
    if (env.USAGE_DB) unmirrored = (await env.DB.prepare('SELECT COUNT(*) AS n FROM near_relay_billing WHERE mirrored_at IS NULL AND final_at IS NOT NULL AND final_at <= ?1').bind(now - NEAR_BILLING_LATE_MS).first<{ n: number }>())?.n ?? 0;
  } catch {
    // no table yet: the misses tell
  }
  const counts = { misses, parked, notFinal, unmirrored, nonceGaps };
  if (Object.values(counts).some((n) => n > 0)) {
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'near_billing_late', ?3)")
        .bind(await eventId('near_billing_late', String(Math.floor(now / DAY) * DAY)), now, JSON.stringify(counts))
        .run();
    } catch {
      log({ event: 'near_billing_alert_failed', code: 'near_billing_late' }, 'error');
    }
  }
  return counts;
}

/** TESTS ONLY: a fault thrown inside the job (its isolation from the other cron jobs is tested). */
export const nearBillingFaults: { throwAt: 'start' | null } = { throwAt: null };

/**
 * The cron's part (every run): parked records, the daily nonce check, the FINAL reads, block figures, the ledger copy,
 * lateness; at most NEAR_BILLING_FETCHES outside fetches. Isolated: never throws (anything thrown inside is logged), so
 * no other cron job is affected. Returns the fetches made.
 */
export async function nearBillingMaintenance(env: Env, now: number = Date.now()): Promise<number> {
  const rpc = new BudgetedRpc(rpcEndpoints(env), NEAR_BILLING_FETCHES);
  try {
    if (nearBillingFaults.throwAt === 'start') throw new Error('test fault');
    await drainParked(env);
    await checkNonces(env, rpc, now);
    await finalizeNearBilling(env, rpc, now);
    await fillBlocks(env, rpc);
    await mirrorNearBilling(env, now);
    await checkNearBillingLate(env, now);
  } catch {
    log({ event: 'near_billing_maintenance', outcome: 'error', code: 'internal' }, 'error');
  }
  return rpc.fetches;
}
