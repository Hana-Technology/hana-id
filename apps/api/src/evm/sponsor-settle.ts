// EVM gas sponsorship's settlement (D848): turning a mined receipt into the audit row's final status and the budgets'
// final figures, once, whoever gets there first: the send request (inside `waitUntil`, so a client that goes away
// doesn't stop it) or the cron's reconciler, which picks up every row left `sending`, `sent`, `timeout` or `unknown` a
// minute after its last update (a request whose isolate died, a receipt later than 30 s, a relayer failure that may
// have sent). The row's status moves first, by a conditional UPDATE from the states that may move: only the caller that
// moved it applies the budget and failure-slot changes, so a settlement never happens twice. Amounts settle into the
// day windows of the row's `created_at` (when they were reserved).
//
// SECURITY: nothing here logs an address, a digest or a hash; events carry chain ids and counts only.
import { eventId } from '../changes/guard.ts';
import type { Env } from '../env.ts';
import { limiter } from '../handlers.ts';
import { log } from '../log.ts';
import { receiptCost, type ReservedFor } from './op-fee.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, sponsorChain } from './sponsor-config.ts';
import { type BillingFigures, type BillingOutcome, billingStatement } from './sponsor-billing.ts';
import { executedIn } from './sponsor-checks.ts';
import { type EvmRelayerLookup, type EvmRelayerPort, type Hex, type SponsorChainPort, type SponsorReceipt, sponsorPorts } from './sponsor-ports.ts';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const HOUR = 60 * MINUTE;

// ---- limiter subjects (shared with sponsor.ts) ----

export const accountSubject = (chainId: number, account: string) => `evm-sponsor:account:${chainId}:${account.toLowerCase()}`;
export const appSubjectOf = (appId: string) => `app:${appId}`;
/** The env's day budget lives on its own object (read by the status route). */
export const envBudgetSubject = (chainId: number) => `evm-sponsor:budget:${chainId}`;
/** The day budget's window, on `app:<id>` and on the env's budget object. */
export const budgetWindow = (chainId: number) => `evm-sponsor:${chainId}:wei`;
/** The account's nonce floor: the lowest executeNonce not yet known to be used (RateLimiter.floor). */
export const NONCE_FLOOR = 'evm-sponsor:nonce';
export const FAILURES = 'evm-sponsor:failures';
/** The failed-send count's object: the user's (across chains), or the account's on the chain without a directory user. */
export const failureSubject = (chainId: number, account: string, userId: string | null) => (userId ? `evm-sponsor:failures:${userId}` : `evm-sponsor:failures:${chainId}:${account.toLowerCase()}`);

export type EventKind = 'evm_relay_budget_high' | 'evm_relay_balance_low' | 'evm_relay_stuck' | 'evm_relay_receipt_odd' | 'evm_relay_nonce_taken' | 'evm_billing_late';

/** One security event per fixed id (`kind` and `idParts`). Amounts, counts and chain ids only. Never throws. */
export async function noteEvent(env: Env, ctx: { requestId?: string; endpoint?: string } | null, kind: EventKind, idParts: string[], detail: Record<string, unknown>, now: number): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, ?3, ?4)')
      .bind(await eventId(kind, ...idParts), now, kind, JSON.stringify(detail))
      .run();
  } catch {
    log({ event: 'evm_sponsor_alert_failed', requestId: ctx?.requestId, endpoint: ctx?.endpoint, code: kind }, 'warn');
  }
}

/** Settles a reservation: what wasn't spent comes back, a spend above it is charged, on both budgets. Never throws. */
export async function settleBudget(env: Env, appId: string, chainId: number, reserved: bigint, spent: bigint, at: number): Promise<void> {
  const diff = reserved - spent;
  if (diff === 0n) return;
  const name = budgetWindow(chainId);
  const subjects = [appSubjectOf(appId), envBudgetSubject(chainId)];
  try {
    if (diff > 0n) await Promise.all(subjects.map((s) => limiter(env, s).giveBack(name, DAY, diff.toString(), at)));
    else await Promise.all(subjects.map((s) => limiter(env, s).charge(name, DAY, (-diff).toString(), at)));
  } catch {
    // A failed give-back leaves the count high (the budget errs on the side of spending less); a failed charge is lost.
  }
}

// ---- the audit row ----

export type SendStatus = 'sending' | 'sent' | 'executed' | 'reverted' | 'not_executed' | 'mined' | 'timeout' | 'unknown' | 'refused' | 'lost' | 'consumed_elsewhere';
/** The states a settlement may move a row from. */
export const OPEN_STATUSES: readonly SendStatus[] = ['sending', 'sent', 'timeout', 'unknown'];

/** What settling a row needs (its D1 columns). */
export interface SendRow {
  id: string;
  appId: string;
  chainId: number;
  account: Hex;
  userId: string | null;
  digest: Hex;
  executeNonce: bigint;
  txHash: Hex | null;
  /** Every hash the relayer reported for the digest (persisted). */
  hashes: Hex[];
  deadline: number;
  reserved: ReservedFor;
  /** The relayer answered this send as a replay: its reservation and counts were given back at once. */
  replay: boolean;
  createdAt: number;
}

interface RowColumns {
  id: string;
  app_id: string;
  chain_id: number;
  account: string;
  user_id: string | null;
  digest: string;
  execute_nonce: string;
  tx_hash: string | null;
  tx_hashes: string;
  deadline: number;
  gas_limit: string;
  fee_cap_wei: string;
  l1_bound_wei: string;
  op_bound_wei: string;
  reserved_wei: string;
  replay: number;
  created_at: number;
  updated_at: number;
  status: SendStatus;
}

const rowOf = (c: RowColumns): SendRow => ({
  id: c.id,
  appId: c.app_id,
  chainId: c.chain_id,
  account: c.account as Hex,
  userId: c.user_id,
  digest: c.digest as Hex,
  executeNonce: BigInt(c.execute_nonce),
  txHash: c.tx_hash && /^0x[0-9a-f]{64}$/u.test(c.tx_hash) ? (c.tx_hash as Hex) : null,
  hashes: parseHashes(c.tx_hashes),
  deadline: c.deadline,
  reserved: { gasLimit: BigInt(c.gas_limit), feeCap: BigInt(c.fee_cap_wei), l1Bound: BigInt(c.l1_bound_wei), operatorBound: BigInt(c.op_bound_wei), reservedWei: BigInt(c.reserved_wei) },
  replay: c.replay === 1,
  createdAt: c.created_at,
});

/** The persisted hash list (malformed entries dropped). */
function parseHashes(json: string): Hex[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((h): h is Hex => typeof h === 'string' && /^0x[0-9a-f]{64}$/u.test(h)) : [];
  } catch {
    return [];
  }
}

/** At most this many hashes are kept per row (the relayer signs at most 64 per nonce, plus the answered ones). */
export const MAX_ROW_HASHES = 80;

/**
 * Adds hashes to a row's persisted list (a union in one UPDATE, so concurrent writers never drop each other's), bounded
 * to MAX_ROW_HASHES (a hash beyond it is not added: the relayer's own bound is lower). Never throws.
 */
export async function persistHashes(env: Env, id: string, hashes: readonly Hex[]): Promise<void> {
  const clean = [...new Set(hashes.filter((h) => /^0x[0-9a-fA-F]{64}$/u.test(h)).map((h) => h.toLowerCase()))];
  if (clean.length === 0) return;
  try {
    await env.DB.prepare(
      `UPDATE evm_sponsor_sends SET tx_hashes = (
         SELECT json_group_array(value) FROM (
           SELECT value FROM (SELECT value, 0 AS o FROM json_each(evm_sponsor_sends.tx_hashes)
                              UNION SELECT value, 1 AS o FROM json_each(?2) WHERE value NOT IN (SELECT value FROM json_each(evm_sponsor_sends.tx_hashes)))
           ORDER BY o LIMIT ?3))
       WHERE id = ?1`,
    )
      .bind(id, JSON.stringify(clean), MAX_ROW_HASHES)
      .run();
  } catch {
    log({ event: 'evm_sponsor_audit_failed', code: 'hashes' }, 'error');
  }
}

/**
 * Moves a row from one of `from` to `status`, with the given fields; true when this call moved it. `billing` (the
 * billing record's statement, sponsor-billing.ts) runs in the same D1 batch, right after the move: a settled row and its
 * record are written together or not at all.
 */
export async function moveRow(env: Env, id: string, from: readonly SendStatus[], status: SendStatus, f: { txHash?: Hex; relayerNonce?: number; settledWei?: bigint; replay?: boolean } = {}, billing?: (status: SendStatus) => D1PreparedStatement): Promise<boolean> {
  try {
    const update = env.DB.prepare(
      `UPDATE evm_sponsor_sends SET status = ?2, tx_hash = COALESCE(?3, tx_hash), relayer_nonce = COALESCE(?4, relayer_nonce),
         settled_wei = COALESCE(?5, settled_wei), replay = COALESCE(?6, replay), updated_at = MAX(created_at, ?7)
       WHERE id = ?1 AND status IN (SELECT value FROM json_each(?8))`,
    ).bind(id, status, f.txHash ?? null, f.relayerNonce ?? null, f.settledWei?.toString() ?? null, f.replay === undefined ? null : f.replay ? 1 : 0, Date.now(), JSON.stringify(from));
    const [r] = billing ? await env.DB.batch([update, billing(status)]) : [await update.run()];
    return (r!.meta.changes ?? 0) === 1;
  } catch {
    log({ event: 'evm_sponsor_audit_failed', code: 'update' }, 'error');
    return false;
  }
}

export type Outcome = 'executed' | 'reverted' | 'not_executed';

/** The receipt's own figures for the billing record. */
function figuresOf(receipt: SponsorReceipt, cost: bigint, cfg: Readonly<EvmSponsorChainConfig>, row: SendRow, blockTimestamp: number | null): BillingFigures {
  const execution = receipt.gasUsed * receipt.effectiveGasPrice;
  const l1 = cfg.opStack ? (receipt.l1Fee ?? row.reserved.l1Bound) : 0n;
  const op = cfg.opStack ? (receipt.operatorFee ?? row.reserved.operatorBound) : 0n;
  return { txHash: receipt.transactionHash.toLowerCase() as Hex, blockNumber: receipt.blockNumber ?? null, blockTimestamp, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, executionWei: execution, l1FeeWei: l1, operatorFeeWei: op, totalCostWei: cost };
}

/**
 * Settles a row from a receipt for one of its own hashes, once: the row moves from `from` to its outcome, with its
 * billing record in the same D1 batch; then, unless it was a replay (already given back), the reservation settles to the
 * receipt's checked cost (receiptCost: a receipt outside what was reserved settles at the reservation and writes
 * `evm_relay_receipt_odd`), a success frees its failure slot and raises the account's floor past its own executeNonce.
 * `cancelled`: the receipt is the relayer's deadline self-transfer (its lookup says so): the batch didn't run, the row
 * is `not_executed`, the record `cancelled`. Null when another caller had already settled it.
 */
export async function settleFromReceipt(
  env: Env,
  cfg: Readonly<EvmSponsorChainConfig>,
  row: SendRow,
  receipt: SponsorReceipt,
  from: readonly SendStatus[],
  o: { cancelled?: boolean; chain?: SponsorChainPort } = {},
): Promise<{ outcome: Outcome; cost: bigint } | null> {
  const outcome: Outcome = !o.cancelled && executedIn(receipt, row.account, row.digest) ? 'executed' : receipt.status === 0 && !o.cancelled ? 'reverted' : 'not_executed';
  const { cost, odd } = receiptCost(receipt, cfg.opStack, row.reserved);
  const blockTimestamp = o.chain && receipt.blockNumber !== undefined && receipt.blockNumber !== null && o.chain.blockTimestamp ? await o.chain.blockTimestamp(receipt.blockNumber).then(Number, () => null) : null;
  const figures = figuresOf(receipt, cost, cfg, row, blockTimestamp);
  const record: BillingOutcome = o.cancelled ? 'cancelled' : outcome;
  const now = Date.now();
  const moved = await moveRow(env, row.id, from, outcome, { txHash: figures.txHash, settledWei: row.replay ? 0n : cost }, (status) => billingStatement(env, row.id, status, record, cost, figures, now));
  if (!moved) return null;
  if (odd) await noteEvent(env, null, 'evm_relay_receipt_odd', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId, settledAtReservation: true }, now);
  if (!row.replay) await settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, cost, row.createdAt);
  if (outcome === 'executed') {
    if (!row.replay) await limiter(env, failureSubject(row.chainId, row.account, row.userId)).giveBack(FAILURES, DAY, '1', row.createdAt).catch(() => undefined);
    try {
      await limiter(env, accountSubject(row.chainId, row.account)).raiseFloor(NONCE_FLOOR, (row.executeNonce + 1n).toString());
    } catch {
      log({ event: 'evm_sponsor_floor_failed', code: 'rate_limiter_unavailable' }, 'error');
    }
  }
  return { outcome, cost };
}

/**
 * Settles a row the relayer reports mined (one of its own versions, at confirmed depth) when the receipt itself can't be
 * read: the money from the relayer's `costWei` (bounded: at most the reservation, else the reservation), the row
 * `mined` (the batch's result unknown: no log was read) or `not_executed` for the deadline's cancel. The billing record
 * says `mined` or `cancelled` with the cost and no breakdown.
 */
export async function settleFromRelayerCost(env: Env, row: SendRow, minedHash: Hex, costWei: bigint, cancelled: boolean): Promise<boolean> {
  const cost = costWei >= 0n && costWei <= row.reserved.reservedWei ? costWei : row.reserved.reservedWei;
  const status: SendStatus = cancelled ? 'not_executed' : 'mined';
  const now = Date.now();
  const figures: BillingFigures = { txHash: minedHash, blockNumber: null, blockTimestamp: null, gasUsed: null, effectiveGasPrice: null, executionWei: null, l1FeeWei: null, operatorFeeWei: null, totalCostWei: cost };
  if (!(await moveRow(env, row.id, OPEN_STATUSES, status, { txHash: minedHash, settledWei: row.replay ? 0n : cost }, (st) => billingStatement(env, row.id, st, cancelled ? 'cancelled' : 'mined', cost, figures, now)))) return false;
  if (!row.replay) await settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, cost, row.createdAt);
  return true;
}

/**
 * A charge with no mined transaction of its own, kept as the reservation: `lost` (nothing proved nothing was spent) or
 * `consumed_elsewhere` (staff closed the relayer's record: its nonce went to something else; `evm_relay_nonce_taken`).
 * The row moves with its billing record (the reservation as the amount); no budget moves.
 */
export async function settleAsCharge(env: Env, row: SendRow, status: 'lost' | 'consumed_elsewhere'): Promise<boolean> {
  const now = Date.now();
  const amount = row.replay ? 0n : row.reserved.reservedWei;
  if (!(await moveRow(env, row.id, OPEN_STATUSES, status, { settledWei: amount }, (st) => billingStatement(env, row.id, st, status, amount, null, now)))) return false;
  if (status === 'consumed_elsewhere') await noteEvent(env, null, 'evm_relay_nonce_taken', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId }, now);
  return true;
}

/** At most this many hashes per row are read per poll. */

const HASH = /^0x[0-9a-fA-F]{64}$/u;

/**
 * The relayer's own versions a lookup lists (well-formed, lowercase), its mined one first when it is one of them (a
 * mined hash the lookup doesn't list as a version is never adopted).
 */
export function lookupHashes(l: EvmRelayerLookup | null): Hex[] {
  const listed = Array.isArray(l?.hashes) ? l.hashes.filter((h): h is Hex => typeof h === 'string' && HASH.test(h)).map((h) => h.toLowerCase() as Hex) : [];
  const mined = typeof l?.minedHash === 'string' && listed.includes(l.minedHash.toLowerCase() as Hex) ? [l.minedHash.toLowerCase() as Hex] : [];
  return [...new Set([...mined, ...listed])];
}

/**
 * The hashes to read for a digest: the mined one when the relayer says so, then every hash it lists, then every one
 * known for the row (persisted: complete even after the relayer forgot the digest). Newest relayer versions first.
 */
export function hashesToPoll(known: readonly Hex[], l: EvmRelayerLookup | null): Hex[] {
  const listed = lookupHashes(l);
  const mined = listed.length && l?.minedHash ? listed.slice(0, 1) : [];
  const rest = listed.slice(mined.length).reverse();
  return [...new Set([...mined, ...rest, ...known.map((h) => h.toLowerCase() as Hex)])].slice(0, MAX_ROW_HASHES);
}

/**
 * Reads every hash's receipt, telling "no receipt" from a failed read: a mined receipt (its own hash); `none` only when
 * every read succeeded and found nothing; else `error` (nothing may be decided from it).
 */
export async function readReceipts(chain: SponsorChainPort, hashes: readonly Hex[]): Promise<{ kind: 'mined'; receipt: SponsorReceipt } | { kind: 'none' } | { kind: 'error' }> {
  let failed = false;
  for (const hash of hashes) {
    try {
      const r = await chain.receipt(hash);
      if (r && r.transactionHash.toLowerCase() === hash) return { kind: 'mined', receipt: r };
    } catch {
      failed = true;
    }
  }
  return failed ? { kind: 'error' } : { kind: 'none' };
}

/** The relayer's lookup, or null when it doesn't know the digest or can't be asked (`asked` tells them apart). */
export async function lookupDigest(relayer: EvmRelayerPort | null, digest: Hex): Promise<{ asked: boolean; value: EvmRelayerLookup | null }> {
  if (!relayer) return { asked: false, value: null };
  try {
    return { asked: true, value: await relayer.lookup(digest) };
  } catch {
    return { asked: false, value: null };
  }
}

/**
 * A send the relayer's staff closed as never sent: the row moves to `refused` first, and only then (and only for the
 * caller that moved it) do the reservation and the failure slot come back. A replay row's were given back by its
 * request. Nothing reached the chain, so there is no billing record.
 */
async function refundNeverSent(env: Env, row: SendRow): Promise<boolean> {
  if (!(await moveRow(env, row.id, OPEN_STATUSES, 'refused', { settledWei: 0n }))) return false;
  if (!row.replay) {
    await settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, 0n, row.createdAt);
    await limiter(env, failureSubject(row.chainId, row.account, row.userId)).giveBack(FAILURES, DAY, '1', row.createdAt).catch(() => undefined);
  }
  return true;
}

// ---- the reconciler (every cron run) ----

/** Rows per run (each: one lookup and a receipt read per known hash, at most MAX_ROW_HASHES). */
export const RECONCILE_ROWS = 20;
/** A row is the reconciler's once untouched this long (the request's own wait is 30 s). */
export const RECONCILE_AFTER_MS = MINUTE;
/**
 * A `sending` row is the request's until this long after its last update: the request's longest life from the row's
 * insert to its next move (the relayer object's queue and send, bounded by its RPC timeouts, well under 5 minutes; the
 * receipt wait happens after the move to `sent`). The reconciler never races a live request's give-back.
 */
export const SENDING_LIFETIME_MS = 5 * MINUTE;
/** An open row older than this writes `evm_relay_stuck` (once an hour per chain). */
export const STUCK_ROW_MS = 10 * MINUTE;
/** A row nothing settles is given up (lost, the reservation kept) this long past its deadline. */
export const GIVE_UP_AFTER_MS = 60 * MINUTE;

export interface ReconcileCounts {
  settled: number;
  refused: number;
  lost: number;
  open: number;
}

/**
 * Settles what the requests couldn't (bounded: RECONCILE_ROWS a run, oldest update first; idempotent through moveRow).
 * A row settles ONLY from (a) a receipt for one of its own hashes (every hash the relayer ever reported, persisted on
 * the row, and the ones its lookup lists now), or (b) the relayer's lookup: `mined` with its cost (used when the receipt
 * itself still can't be read an hour past the deadline), `closed` `never_sent` (refunded) or `closed`
 * `consumed_elsewhere` (the reservation kept as the cost, an event for staff). Anything else stays open, and an hour past
 * the deadline becomes `lost` with the reservation kept (and a billing record of that amount). Never throws.
 */
export async function reconcileEvmSends(env: Env, config: EvmSponsorConfig, now: number = Date.now()): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { settled: 0, refused: 0, lost: 0, open: 0 };
  let rows: RowColumns[];
  try {
    rows = (
      await env.DB.prepare(
        `SELECT id, app_id, chain_id, account, user_id, digest, execute_nonce, tx_hash, tx_hashes, deadline, gas_limit, fee_cap_wei, l1_bound_wei,
                op_bound_wei, reserved_wei, replay, created_at, updated_at, status
           FROM evm_sponsor_sends
          WHERE ((status IN ('sent', 'timeout', 'unknown') AND updated_at <= ?1) OR (status = 'sending' AND updated_at <= ?3))
          ORDER BY updated_at LIMIT ?2`,
      )
        .bind(now - RECONCILE_AFTER_MS, RECONCILE_ROWS, now - SENDING_LIFETIME_MS)
        .all<RowColumns>()
    ).results;
  } catch {
    log({ event: 'evm_sponsor_reconcile', outcome: 'error', code: 'audit_unavailable' }, 'warn');
    return counts;
  }
  const stuck = new Map<number, { rows: number; oldestMs: number }>();
  for (const c of rows) {
    const cfg = sponsorChain(config, c.chain_id);
    if (!cfg) continue;
    const row = rowOf(c);
    const relayer = sponsorPorts.relayer(env, row.chainId);
    const chain = sponsorPorts.chain(env, cfg);
    const l = await lookupDigest(relayer, row.digest);
    // Every hash the relayer lists now is persisted first, so the set stays complete after it forgets the digest.
    const listed = lookupHashes(l.value);
    if (listed.some((h) => !row.hashes.includes(h))) await persistHashes(env, row.id, listed);
    const own = new Set([...(row.txHash ? [row.txHash] : []), ...row.hashes, ...listed]);
    const read = await readReceipts(chain, hashesToPoll([...own], l.value));
    const pastDeadline = now - row.deadline * 1000;
    const v = l.value;
    if (read.kind === 'mined') {
      const cancelled = v?.state === 'mined' && v.outcome === 'cancel' && v.minedHash?.toLowerCase() === read.receipt.transactionHash.toLowerCase();
      if (await settleFromReceipt(env, cfg, row, read.receipt, OPEN_STATUSES, { cancelled, chain })) counts.settled++;
      continue;
    }
    if (v?.state === 'closed' && v.outcome === 'never_sent') {
      if (await refundNeverSent(env, row)) counts.refused++;
      continue;
    }
    if (v?.state === 'closed' && v.outcome === 'consumed_elsewhere') {
      if (await settleAsCharge(env, row, 'consumed_elsewhere')) counts.settled++;
      continue;
    }
    if (v?.state === 'mined' && v.minedHash && own.has(v.minedHash.toLowerCase() as Hex) && typeof v.costWei === 'bigint' && (v.outcome === 'execute' || v.outcome === 'cancel') && pastDeadline >= GIVE_UP_AFTER_MS) {
      // The relayer saw one of this row's own versions mined; its receipt still can't be read here: settle from its cost.
      if (await settleFromRelayerCost(env, row, v.minedHash.toLowerCase() as Hex, v.costWei, v.outcome === 'cancel')) counts.settled++;
      continue;
    }
    if (pastDeadline >= GIVE_UP_AFTER_MS && v?.state !== 'mined' && v?.state !== 'pending' && v?.state !== 'cancelling') {
      if (await settleAsCharge(env, row, 'lost')) counts.lost++;
      continue;
    }
    counts.open++;
    const age = now - row.createdAt;
    if (age > STUCK_ROW_MS) {
      const s = stuck.get(row.chainId) ?? { rows: 0, oldestMs: 0 };
      stuck.set(row.chainId, { rows: s.rows + 1, oldestMs: Math.max(s.oldestMs, age) });
    }
  }
  for (const [chainId, s] of stuck) {
    await noteEvent(env, null, 'evm_relay_stuck', [String(chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId, pending: s.rows, oldestPendingMs: s.oldestMs }, now);
  }
  return counts;
}

/** The audit rows' retention (D848): 24 months, then deleted by the hourly cron, at most this many a run. */
export const AUDIT_RETENTION_MS = 730 * DAY;
export const PRUNE_ROWS = 500;

/** Deletes audit rows older than 24 months (bounded; also without sponsorship configured). Never throws. */
export async function pruneEvmSponsorSends(env: Env, now: number = Date.now()): Promise<number> {
  try {
    const r = await env.DB.prepare('DELETE FROM evm_sponsor_sends WHERE id IN (SELECT id FROM evm_sponsor_sends WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)').bind(now - AUDIT_RETENTION_MS, PRUNE_ROWS).run();
    return r.meta.changes ?? 0;
  } catch {
    // Before migration 0022 there is no table: nothing to prune.
    return 0;
  }
}
