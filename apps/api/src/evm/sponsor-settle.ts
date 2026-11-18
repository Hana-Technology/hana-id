// EVM gas sponsorship's settlement (D848): turning a mined receipt into the audit row's final status and the budgets'
// final figures, once, whoever gets there first: the send request (inside `waitUntil`, so a client that goes away
// doesn't stop it) or the cron's reconciler, which picks up every row left `sending`, `sent`, `timeout`, `unknown` or
// `rejected` a minute after its last update (a request whose isolate died, a receipt later than 30 s, a relayer failure
// that may have sent, a batch no node took whose nonce went to the relayer's cancel). The row's status moves first, by a conditional UPDATE from the states that may move: only the caller that
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
import { type BillingFigures, type BillingOutcome, billingStatement, correctionStatement, notChargedCorrectionStatement } from './sponsor-billing.ts';
import { executedIn } from './sponsor-checks.ts';
import { blockTimestamp, type EvmRelayerLookup, type EvmRelayerPort, type Hex, type SponsorChainPort, type SponsorReceipt, sponsorPorts } from './sponsor-ports.ts';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const HOUR = 60 * MINUTE;

// ---- limiter subjects (shared with sponsor.ts) ----

export const accountSubject = (chainId: number, account: string) => `evm-sponsor:account:${chainId}:${account.toLowerCase()}`;
export const appSubjectOf = (appId: string) => `app:${appId}`;
/** The user's day of sends and attempts (with a directory user). */
export const userSubjectOf = (userId: string) => `evm-sponsor:user:${userId}`;
/** The env's minute and day of sends. */
export const envSubjectOf = (chainId: number) => `evm-sponsor:global:${chainId}`;
/** The day windows a send counts in (its name on each subject), given back when it was not the user's or the partner's doing. */
export const dayWindowName = (chainId: number) => `evm-sponsor:${chainId}:day`;
export const ENV_DAY_WINDOW = 'evm-sponsor:day';
export const attemptsWindowName = (chainId: number) => `evm-sponsor:${chainId}:attempts`;
/** The env's day budget lives on its own object (read by the status route). */
export const envBudgetSubject = (chainId: number) => `evm-sponsor:budget:${chainId}`;
/** The day budget's window, on `app:<id>` and on the env's budget object. */
export const budgetWindow = (chainId: number) => `evm-sponsor:${chainId}:wei`;
/** The account's nonce floor: the lowest executeNonce not yet known to be used (RateLimiter.floor). */
export const NONCE_FLOOR = 'evm-sponsor:nonce';
export const FAILURES = 'evm-sponsor:failures';
/** The failed-send count's object: the user's (across chains), or the account's on the chain without a directory user. */
export const failureSubject = (chainId: number, account: string, userId: string | null) => (userId ? `evm-sponsor:failures:${userId}` : `evm-sponsor:failures:${chainId}:${account.toLowerCase()}`);
/** The statuses of a send still in flight: an app's count of these is its share of the relayer (D847, derived from D1). */
export const INFLIGHT_STATUSES = ['sending', 'sent', 'timeout', 'unknown', 'rejected'] as const;

export type EventKind = 'evm_relay_budget_high' | 'evm_relay_balance_low' | 'evm_relay_stuck' | 'evm_relay_receipt_odd' | 'evm_relay_nonce_taken' | 'evm_billing_late' | 'evm_relay_closed_slot_mined';

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

export type SendStatus = 'sending' | 'sent' | 'executed' | 'reverted' | 'not_executed' | 'mined' | 'timeout' | 'unknown' | 'rejected' | 'refused' | 'lost' | 'consumed_elsewhere' | 'duplicate';
/**
 * The states a settlement may move a row from. `rejected`: no node took the batch and the relayer gave its nonce to its
 * own cancel at once (the send answered at once); the row settles to the cancel's cost once the relayer reports it.
 */
export const OPEN_STATUSES: readonly SendStatus[] = ['sending', 'sent', 'timeout', 'unknown', 'rejected'];

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
  /** `<cause>:<code>` of a batch no node took (its counts were settled at that rejection), or null. */
  rejection: string | null;
}

const ROW_COLUMNS = `id, app_id, chain_id, account, user_id, digest, execute_nonce, tx_hash, tx_hashes, deadline, gas_limit, fee_cap_wei, l1_bound_wei,
                op_bound_wei, reserved_wei, replay, created_at, updated_at, status, rejection`;

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
export async function moveRow(env: Env, id: string, from: readonly SendStatus[], status: SendStatus, f: { txHash?: Hex; relayerNonce?: number; settledWei?: bigint; replay?: boolean; rejection?: string; confirmedAt?: number } = {}, billing?: (status: SendStatus) => D1PreparedStatement): Promise<boolean> {
  try {
    const update = env.DB.prepare(
      `UPDATE evm_sponsor_sends SET status = ?2, tx_hash = COALESCE(?3, tx_hash), relayer_nonce = COALESCE(?4, relayer_nonce),
         settled_wei = COALESCE(?5, settled_wei), replay = COALESCE(?6, replay), rejection = COALESCE(?9, rejection), confirmed_at = COALESCE(?10, confirmed_at),
         updated_at = MAX(created_at, ?7)
       WHERE id = ?1 AND status IN (SELECT value FROM json_each(?8))`,
    ).bind(id, status, f.txHash ?? null, f.relayerNonce ?? null, f.settledWei?.toString() ?? null, f.replay === undefined ? null : f.replay ? 1 : 0, Date.now(), JSON.stringify(from), f.rejection ?? null, f.confirmedAt ?? null);
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
  return { txHash: receipt.transactionHash.toLowerCase() as Hex, blockNumber: receipt.blockNumber, blockTimestamp, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, executionWei: execution, l1FeeWei: l1, operatorFeeWei: op, totalCostWei: cost };
}

/**
 * Settles a row from a receipt for one of its own hashes, once: the row moves from `from` to its outcome, with its
 * billing record in the same D1 batch; then, unless it was a replay (already given back), the reservation settles to the
 * receipt's checked cost (receiptCost: a receipt outside what was reserved settles at the reservation and writes
 * `evm_relay_receipt_odd`) and a success frees its failure slot. `cancelled`: the receipt is the relayer's own cancel:
 * the batch didn't run, the row is `not_executed`, the record `cancelled`. `confirmed`: the relayer's verdict at
 * confirmed depth names this very transaction (else the row waits for the reconciler's check, D847, and the account's
 * nonce floor rises only then). A transaction already billed to another row of the digest (a first attempt that came
 * back unknown, then the retry) makes this row a `duplicate`: settled at zero, its reservation given back, so the money is
 * charged once. Null when another caller had already settled it.
 */
export async function settleFromReceipt(
  env: Env,
  cfg: Readonly<EvmSponsorChainConfig>,
  row: SendRow,
  receipt: SponsorReceipt,
  from: readonly SendStatus[],
  o: { cancelled?: boolean; chain?: SponsorChainPort; confirmed?: boolean } = {},
): Promise<{ outcome: Outcome; cost: bigint } | null> {
  const outcome: Outcome = !o.cancelled && executedIn(receipt, row.account, row.digest) ? 'executed' : receipt.status === 0 && !o.cancelled ? 'reverted' : 'not_executed';
  const { cost, odd } = receiptCost(receipt, cfg.opStack, row.reserved);
  const at = o.chain ? await blockTimestamp(o.chain, receipt.blockNumber).then(Number, () => null) : null;
  const figures = figuresOf(receipt, cost, cfg, row, at);
  const record: BillingOutcome = o.cancelled ? 'cancelled' : outcome;
  const now = Date.now();
  const moved = await moveRow(env, row.id, from, outcome, { txHash: figures.txHash, settledWei: row.replay ? 0n : cost, ...(o.confirmed ? { confirmedAt: now } : {}) }, (status) => billingStatement(env, row.id, status, record, cost, figures, now));
  if (!moved) return null;
  if (await billedElsewhere(env, row, figures.txHash)) {
    await settleDuplicate(env, row);
    return { outcome, cost: 0n };
  }
  if (odd) await noteEvent(env, null, 'evm_relay_receipt_odd', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId, settledAtReservation: true }, now);
  if (!row.replay) await settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, cost, row.createdAt);
  if (outcome === 'executed' && !row.replay) await limiter(env, failureSubject(row.chainId, row.account, row.userId)).giveBack(FAILURES, DAY, '1', row.createdAt).catch(() => undefined);
  if (outcome === 'executed' && o.confirmed) await raiseAccountFloor(env, row);
  return { outcome, cost };
}

/** The account's nonce floor past this row's own nonce: only on the relayer's verdict at confirmed depth (D847). */
async function raiseAccountFloor(env: Env, row: Pick<SendRow, 'chainId' | 'account' | 'executeNonce'>): Promise<void> {
  try {
    await limiter(env, accountSubject(row.chainId, row.account)).raiseFloor(NONCE_FLOOR, (row.executeNonce + 1n).toString());
  } catch {
    log({ event: 'evm_sponsor_floor_failed', code: 'rate_limiter_unavailable' }, 'error');
  }
}

/** Whether the transaction's billing record belongs to another row (this row's own insert was ignored). */
async function billedElsewhere(env: Env, row: Pick<SendRow, 'id' | 'chainId'>, txHash: Hex): Promise<boolean> {
  try {
    const b = await env.DB.prepare('SELECT send_id FROM evm_sponsor_billing WHERE chain_id = ?1 AND record_key = ?2').bind(row.chainId, txHash.toLowerCase()).first<{ send_id: string }>();
    return b !== null && b.send_id !== row.id;
  } catch {
    return false;
  }
}

/** A second row of a digest whose transaction is billed to the first: `duplicate`, zero, everything it reserved back. */
async function settleDuplicate(env: Env, row: SendRow): Promise<void> {
  await env.DB.prepare("UPDATE evm_sponsor_sends SET status = 'duplicate', settled_wei = '0', confirmed_at = COALESCE(confirmed_at, ?2), updated_at = MAX(created_at, ?2) WHERE id = ?1")
    .bind(row.id, Date.now())
    .run()
    .catch(() => undefined);
  if (row.replay) return;
  await Promise.all([settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, 0n, row.createdAt), limiter(env, failureSubject(row.chainId, row.account, row.userId)).giveBack(FAILURES, DAY, '1', row.createdAt).catch(() => undefined)]);
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
  if (!(await moveRow(env, row.id, OPEN_STATUSES, status, { txHash: minedHash, settledWei: row.replay ? 0n : cost, confirmedAt: now }, (st) => billingStatement(env, row.id, st, cancelled ? 'cancelled' : 'mined', cost, figures, now)))) return false;
  if (await billedElsewhere(env, row, minedHash)) {
    await settleDuplicate(env, row);
    return true;
  }
  if (!row.replay) await settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, cost, row.createdAt);
  return true;
}

/**
 * A charge with no mined transaction of its own, kept as the reservation: `lost` (nothing proved nothing was spent).
 * The row moves with its billing record (the reservation as the amount); no budget moves.
 */
export async function settleAsCharge(env: Env, row: SendRow, status: 'lost'): Promise<boolean> {
  const now = Date.now();
  const amount = row.replay ? 0n : row.reserved.reservedWei;
  return moveRow(env, row.id, OPEN_STATUSES, status, { settledWei: amount }, (st) => billingStatement(env, row.id, st, status, amount, null, now));
}

/**
 * A slot used up by a transaction Journear's relayer did not send (`consumed_elsewhere`: staff closed the relayer's
 * record after the relayer itself stopped on it; a leaked or misused relayer key), so the user's action never ran.
 * Journear's own loss, not the partner's (D869, the founder's decision): the row settles at 0 with its billing record
 * (outcome `consumed_elsewhere`, settled 0, no cost figures: a billing job never bills it, the monthly view shows it
 * apart, counted), the amount set aside goes back to the app's and the env's day budgets, and the user's and the app's
 * day counts, the user's attempts and failure slot are given back (none of it was their doing). Once: the row moves
 * only from the status it was read in (`prior`), so only one caller moves it and that caller knows what was already
 * returned: a `rejected` row's counts were settled when it was rejected (given back then for a cause not the user's,
 * kept for the user's own `request` cause), so only its money comes back here. The row is final, so no later receipt
 * or correction can charge it. `evm_relay_nonce_taken` is written for staff. Never throws.
 */
export async function settleNotCharged(env: Env, row: SendRow, prior: SendStatus): Promise<boolean> {
  const now = Date.now();
  if (!OPEN_STATUSES.includes(prior)) return false;
  if (!(await moveRow(env, row.id, [prior], 'consumed_elsewhere', { settledWei: 0n }, (st) => billingStatement(env, row.id, st, 'consumed_elsewhere', 0n, null, now)))) return false;
  if (!row.replay) await giveBackNotCharged(env, row, row.reserved.reservedWei, { counts: prior !== 'rejected', failure: prior !== 'rejected' });
  await noteEvent(env, null, 'evm_relay_nonce_taken', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId, charged: false }, now);
  return true;
}

/**
 * Gives back what a not-charged send took (D869): `money` (what its budgets hold for it now) to the app's and the env's
 * day budgets; with `counts`, the user's, the app's and the env's day counts and the user's attempts; with `failure`, the
 * failure slot. Un-hit in the windows of the row's creation (an attempt counted just before UTC midnight and created
 * just after decrements the next day's attempts: negligible, D869). Callers call it once, after the one move. Never throws.
 */
async function giveBackNotCharged(env: Env, row: SendRow, money: bigint, o: { counts: boolean; failure: boolean }): Promise<void> {
  const at = row.createdAt;
  const unhit = (subject: string, name: string) => limiter(env, subject).unhit([{ name, windowMs: DAY, max: 1 }], at).catch(() => undefined);
  await Promise.all([
    settleBudget(env, row.appId, row.chainId, money, 0n, at),
    ...(o.failure ? [limiter(env, failureSubject(row.chainId, row.account, row.userId)).giveBack(FAILURES, DAY, '1', at).catch(() => undefined)] : []),
    ...(o.counts
      ? [
          unhit(appSubjectOf(row.appId), dayWindowName(row.chainId)),
          unhit(envSubjectOf(row.chainId), ENV_DAY_WINDOW),
          ...(row.userId ? [unhit(userSubjectOf(row.userId), dayWindowName(row.chainId))] : []),
          unhit(row.userId ? userSubjectOf(row.userId) : accountSubject(row.chainId, row.account), attemptsWindowName(row.chainId)),
        ]
      : []),
  ]);
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
  lost: number;
  open: number;
  /** Rows settled at head the relayer's verdict at confirmed depth agreed with, and rows it corrected (a reorg). */
  confirmed: number;
  corrected: number;
  /** Closed slots found mined after all (`evm_relay_closed_slot_mined`), from the lowest-priority watch. */
  closedMined?: number;
}

/** Inline (the send path, when the app's in-flight share is full): this app's and chain's rows only, at most `limit`. */
export interface ReconcileScope {
  appId: string;
  chainId: number;
  limit: number;
}

/**
 * Settles what the requests couldn't (bounded: RECONCILE_ROWS a run, oldest update first; idempotent through moveRow).
 * A row settles ONLY from (a) a receipt for one of its own hashes (every hash the relayer ever reported, persisted on
 * the row, and the ones its lookup lists now), or (b) the relayer's lookup: `mined` (at confirmed depth) with its cost
 * (for a `rejected` row at once: its cancel; for any other when the receipt itself still can't be read an hour past
 * the deadline) or `closed` `consumed_elsewhere` (not charged: Journear's loss, everything given back, D869; an event for staff). Anything else
 * stays open, and an hour past the deadline becomes `lost` with the reservation kept (and a billing record of that
 * amount). A `rejected` row's receipt of any hash but its batch's is the cancel's. Never throws.
 */
export async function reconcileEvmSends(env: Env, config: EvmSponsorConfig, now: number = Date.now(), scope?: ReconcileScope): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { settled: 0, lost: 0, open: 0, confirmed: 0, corrected: 0 };
  let rows: RowColumns[];
  try {
    rows = scope
      ? // Inline: no age wait, but never a row a live request still owns (`sending`, `sent`).
        (
          await env.DB.prepare(
            `SELECT ${ROW_COLUMNS} FROM evm_sponsor_sends
              WHERE status IN ('timeout', 'unknown', 'rejected') AND app_id = ?1 AND chain_id = ?2 ORDER BY updated_at LIMIT ?3`,
          )
            .bind(scope.appId, scope.chainId, scope.limit)
            .all<RowColumns>()
        ).results
      : (
          await env.DB.prepare(
            `SELECT ${ROW_COLUMNS} FROM evm_sponsor_sends
              WHERE ((status IN ('sent', 'timeout', 'unknown', 'rejected') AND updated_at <= ?1) OR (status = 'sending' AND updated_at <= ?3))
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
    const rejected = c.status === 'rejected';
    if (read.kind === 'mined') {
      const hash = read.receipt.transactionHash.toLowerCase();
      const atDepth = v?.state === 'mined' && v.minedHash?.toLowerCase() === hash;
      const cancelled = (atDepth && v?.outcome === 'cancel') || (rejected && hash !== row.txHash);
      if (await settleFromReceipt(env, cfg, row, read.receipt, OPEN_STATUSES, { cancelled, chain, confirmed: atDepth && v?.outcome === 'execute' })) counts.settled++;
      continue;
    }
    if (v?.state === 'closed' && v.outcome === 'consumed_elsewhere') {
      if (await settleNotCharged(env, row, c.status)) counts.settled++;
      continue;
    }
    if (v?.state === 'mined' && v.minedHash && own.has(v.minedHash.toLowerCase() as Hex) && typeof v.costWei === 'bigint' && (v.outcome === 'execute' || v.outcome === 'cancel') && (rejected || pastDeadline >= GIVE_UP_AFTER_MS)) {
      // The relayer saw one of this row's own versions mined; its receipt still can't be read here: settle from its cost.
      if (await settleFromRelayerCost(env, row, v.minedHash.toLowerCase() as Hex, v.costWei, v.outcome === 'cancel')) counts.settled++;
      continue;
    }
    // Lost only on evidence: the relayer answered (it doesn't know the digest, or knows it unmined nowhere) and every
    // receipt read succeeded and found nothing. A failed lookup or read leaves the row open.
    if (pastDeadline >= GIVE_UP_AFTER_MS && l.asked && read.kind === 'none' && v?.state !== 'mined' && v?.state !== 'pending' && v?.state !== 'cancelling') {
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
  if (!scope) await confirmSettled(env, config, now, counts);
  // Lowest priority, after everything else: closed slots that may still mine (D869 review L2).
  if (!scope) counts.closedMined = await watchClosedSlots(env, config, now);
  return counts;
}

/** Rows settled at head checked per run, and how long the relayer remembers a digest (past that a row stays as it is). */
export const CONFIRM_ROWS = 20;
export const CONFIRM_WITHIN_MS = 7 * DAY;

/**
 * The reorg check (D847): a row settled from a receipt at head (`confirmed_at` NULL) is compared with the relayer's
 * verdict at confirmed depth once it has one. The same transaction: confirmed (and, executed, the account's nonce floor
 * rises past its nonce). Another of the batch's own versions: the row takes that transaction's outcome and cost, the
 * budgets move by the difference, and a correction billing record supersedes the first (never an edit). Nothing else
 * moves a row. Never throws.
 */
async function confirmSettled(env: Env, config: EvmSponsorConfig, now: number, counts: ReconcileCounts): Promise<void> {
  let rows: (RowColumns & { settled_wei: string | null })[];
  try {
    rows = (
      await env.DB.prepare(
        `SELECT ${ROW_COLUMNS}, settled_wei FROM evm_sponsor_sends
          WHERE confirmed_at IS NULL AND status IN ('executed', 'reverted', 'not_executed') AND updated_at <= ?1 AND created_at >= ?2
          ORDER BY updated_at LIMIT ?3`,
      )
        .bind(now - RECONCILE_AFTER_MS, now - CONFIRM_WITHIN_MS, CONFIRM_ROWS)
        .all<RowColumns & { settled_wei: string | null }>()
    ).results;
  } catch {
    return;
  }
  for (const c of rows) {
    const cfg = sponsorChain(config, c.chain_id);
    if (!cfg) continue;
    const row = rowOf(c);
    const l = await lookupDigest(sponsorPorts.relayer(env, row.chainId), row.digest);
    const v = l.value;
    // Settled at head, then reorged out, then its slot used by something else and closed by staff (D869): not charged.
    if (l.asked && v?.state === 'closed' && v.outcome === 'consumed_elsewhere') {
      if (await correctToNotCharged(env, c, row, now)) counts.corrected++;
      continue;
    }
    if (!l.asked || v?.state !== 'mined' || !v.minedHash) continue;
    const mined = v.minedHash.toLowerCase() as Hex;
    if (mined === row.txHash) {
      await env.DB.prepare('UPDATE evm_sponsor_sends SET confirmed_at = ?2 WHERE id = ?1 AND confirmed_at IS NULL').bind(row.id, now).run().catch(() => undefined);
      if (c.status === 'executed' && v.outcome === 'execute') await raiseAccountFloor(env, row);
      counts.confirmed++;
      continue;
    }
    if (!lookupHashes(v).includes(mined)) continue;
    const read = await readReceipts(sponsorPorts.chain(env, cfg), [mined]);
    if (read.kind !== 'mined') continue;
    const receipt = read.receipt;
    const cancelled = v.outcome === 'cancel';
    const outcome: Outcome = !cancelled && executedIn(receipt, row.account, row.digest) ? 'executed' : receipt.status === 0 && !cancelled ? 'reverted' : 'not_executed';
    if (row.replay) {
      // A relayer replay's transaction is the original send's: that row carries the money, the record and its
      // correction. Here only the row is confirmed (and the floor follows an executed batch).
      await env.DB.prepare('UPDATE evm_sponsor_sends SET confirmed_at = ?2 WHERE id = ?1 AND confirmed_at IS NULL').bind(row.id, now).run().catch(() => undefined);
      if (outcome === 'executed' && v.outcome === 'execute') await raiseAccountFloor(env, row);
      counts.confirmed++;
      continue;
    }
    const { cost } = receiptCost(receipt, cfg.opStack, row.reserved);
    const figures = figuresOf(receipt, cost, cfg, row, null);
    const before = c.settled_wei !== null && /^\d{1,78}$/u.test(c.settled_wei) ? BigInt(c.settled_wei) : 0n;
    try {
      const [moved] = await env.DB.batch([
        env.DB.prepare('UPDATE evm_sponsor_sends SET status = ?2, tx_hash = ?3, settled_wei = ?4, confirmed_at = ?5, updated_at = MAX(created_at, ?5) WHERE id = ?1 AND confirmed_at IS NULL').bind(row.id, outcome, mined, row.replay ? '0' : cost.toString(), now),
        correctionStatement(env, row.id, row.txHash ?? '', cancelled ? 'cancelled' : outcome, row.replay ? 0n : cost, figures, now),
      ]);
      if ((moved!.meta.changes ?? 0) !== 1) continue;
    } catch {
      continue;
    }
    // The budgets follow the transaction that counts: what the first settlement charged comes back, the final cost is taken.
    if (!row.replay) await settleBudget(env, row.appId, row.chainId, before, cost, row.createdAt);
    if (outcome === 'executed' && v.outcome === 'execute') await raiseAccountFloor(env, row);
    log({ event: 'evm_sponsor_corrected', code: `${c.status}:${outcome}` }, 'error');
    counts.corrected++;
  }
}

/**
 * A row settled from a receipt at head (`executed`, `reverted`, `not_executed`, unconfirmed) whose transaction the
 * chain later dropped (a reorg) and whose slot staff then closed as used by something else (D869): the row moves to
 * `consumed_elsewhere` at 0 with a correction record `fix:<send>` (outcome `consumed_elsewhere`, settled 0, no
 * transaction: never an edit of the first), in one D1 batch guarded on the status read and `confirmed_at IS NULL`, so
 * only one run moves it; that run gives back what the first settlement charged and the counts it kept (the day counts
 * and attempts, unless a rejection settled them; the failure slot, unless the send was `executed` or rejected). True
 * when this call moved it. Never throws.
 */
async function correctToNotCharged(env: Env, c: RowColumns & { settled_wei: string | null }, row: SendRow, now: number): Promise<boolean> {
  const before = c.settled_wei !== null && /^\d{1,78}$/u.test(c.settled_wei) ? BigInt(c.settled_wei) : 0n;
  const original = row.txHash ? row.txHash.toLowerCase() : `send:${row.id}`;
  try {
    const [moved] = await env.DB.batch([
      env.DB.prepare("UPDATE evm_sponsor_sends SET status = 'consumed_elsewhere', settled_wei = '0', confirmed_at = ?3, updated_at = MAX(created_at, ?3) WHERE id = ?1 AND status = ?2 AND confirmed_at IS NULL").bind(row.id, c.status, now),
      notChargedCorrectionStatement(env, row.id, original, now),
    ]);
    if ((moved!.meta.changes ?? 0) !== 1) return false;
  } catch {
    return false;
  }
  if (!row.replay) await giveBackNotCharged(env, row, before, { counts: c.rejection === null, failure: c.rejection === null && c.status !== 'executed' });
  await noteEvent(env, null, 'evm_relay_nonce_taken', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId, charged: false, corrected: true }, now);
  log({ event: 'evm_sponsor_corrected', code: `${c.status}:consumed_elsewhere` }, 'error');
  return true;
}

// ---- a slot closed as used elsewhere that later mines anyway (D869 review L2) ----

/** How long after a close the cron keeps looking for the closed slot's own transactions. */
export const CLOSED_WATCH_MS = 7 * DAY;
/** Closed rows checked per run, and hashes per row (lowest priority: after everything else). */
export const CLOSED_WATCH_ROWS = 4;
export const CLOSED_WATCH_HASHES = 8;

/**
 * For 7 days after staff closed a slot as used elsewhere, reads receipts for the row's own persisted hashes (at most
 * CLOSED_WATCH_ROWS rows, CLOSED_WATCH_HASHES hashes each, a run): one mined means the close was mistaken and the user's
 * action ran for free and unrecorded as a charge. It writes `evm_relay_closed_slot_mined` once per row (its id) for
 * staff, and never charges anything. Returns how many it found. Never throws.
 */
export async function watchClosedSlots(env: Env, config: EvmSponsorConfig, now: number = Date.now()): Promise<number> {
  let rows: { id: string; chain_id: number; tx_hash: string | null; tx_hashes: string }[];
  try {
    rows = (
      await env.DB.prepare(
        `SELECT s.id, s.chain_id, s.tx_hash, s.tx_hashes FROM evm_sponsor_sends s
          WHERE s.status = 'consumed_elsewhere' AND s.replay = 0 AND s.updated_at >= ?1
            AND NOT EXISTS (SELECT 1 FROM security_events e WHERE e.kind = 'evm_relay_closed_slot_mined' AND e.detail_json LIKE '%' || s.id || '%')
          ORDER BY s.updated_at DESC LIMIT ?2`,
      )
        .bind(now - CLOSED_WATCH_MS, CLOSED_WATCH_ROWS)
        .all<{ id: string; chain_id: number; tx_hash: string | null; tx_hashes: string }>()
    ).results;
  } catch {
    return 0;
  }
  let found = 0;
  for (const r of rows) {
    const cfg = sponsorChain(config, r.chain_id);
    if (!cfg) continue;
    const hashes = [...new Set([...(r.tx_hash ? [r.tx_hash.toLowerCase() as Hex] : []), ...parseHashes(r.tx_hashes)])].slice(0, CLOSED_WATCH_HASHES);
    if (hashes.length === 0) continue;
    const read = await readReceipts(sponsorPorts.chain(env, cfg), hashes);
    if (read.kind !== 'mined') continue;
    found++;
    await noteEvent(env, null, 'evm_relay_closed_slot_mined', [r.id], { chainId: r.chain_id, sendId: r.id }, now);
    log({ event: 'evm_sponsor_closed_slot_mined', code: 'not_charged' }, 'error');
  }
  return found;
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
