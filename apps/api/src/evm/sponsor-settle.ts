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

export type EventKind = 'evm_relay_budget_high' | 'evm_relay_balance_low' | 'evm_relay_stuck' | 'evm_relay_receipt_odd' | 'evm_relay_nonce_taken';

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

export type SendStatus = 'sending' | 'sent' | 'executed' | 'reverted' | 'not_executed' | 'timeout' | 'unknown' | 'refused' | 'lost';
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

/** Moves a row from one of `from` to `status`, with the given fields; true when this call moved it. */
export async function moveRow(env: Env, id: string, from: readonly SendStatus[], status: SendStatus, f: { txHash?: Hex; relayerNonce?: number; settledWei?: bigint; replay?: boolean } = {}): Promise<boolean> {
  try {
    const r = await env.DB.prepare(
      `UPDATE evm_sponsor_sends SET status = ?2, tx_hash = COALESCE(?3, tx_hash), relayer_nonce = COALESCE(?4, relayer_nonce),
         settled_wei = COALESCE(?5, settled_wei), replay = COALESCE(?6, replay), updated_at = MAX(created_at, ?7)
       WHERE id = ?1 AND status IN (SELECT value FROM json_each(?8))`,
    )
      .bind(id, status, f.txHash ?? null, f.relayerNonce ?? null, f.settledWei?.toString() ?? null, f.replay === undefined ? null : f.replay ? 1 : 0, Date.now(), JSON.stringify(from))
      .run();
    return (r.meta.changes ?? 0) === 1;
  } catch {
    log({ event: 'evm_sponsor_audit_failed', code: 'update' }, 'error');
    return false;
  }
}

export type Outcome = 'executed' | 'reverted' | 'not_executed';

/**
 * Settles a row from its mined receipt, once: the row moves from `from` to its outcome first; then, unless it was a
 * replay (already given back), the reservation settles to the receipt's checked cost (receiptCost: a receipt outside
 * what was reserved settles at the reservation and writes `evm_relay_receipt_odd`), a success frees its failure slot
 * and raises the account's floor past its own executeNonce (never to a figure the RPC reported). Null when another
 * caller had already settled it.
 */
export async function settleFromReceipt(env: Env, cfg: Readonly<EvmSponsorChainConfig>, row: SendRow, receipt: SponsorReceipt, from: readonly SendStatus[]): Promise<{ outcome: Outcome; cost: bigint } | null> {
  const outcome: Outcome = executedIn(receipt, row.account, row.digest) ? 'executed' : receipt.status === 0 ? 'reverted' : 'not_executed';
  const { cost, odd } = receiptCost(receipt, cfg.opStack, row.reserved);
  if (!(await moveRow(env, row.id, from, outcome, { txHash: receipt.transactionHash.toLowerCase() as Hex, settledWei: row.replay ? 0n : cost }))) return null;
  if (odd) {
    const now = Date.now();
    await noteEvent(env, null, 'evm_relay_receipt_odd', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId, settledAtReservation: true }, now);
  }
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
 * The relayer says the batch's nonce was taken by something that is no version of it (`state: 'taken'`) and no version
 * has a receipt: the batch did not run and cost nothing. The row becomes `not_executed` settled at zero, the reservation
 * and the failure slot (not the user's doing) come back, and `evm_relay_nonce_taken` shows it to staff (once an hour per
 * chain). Null when another caller had already settled it.
 */
export async function settleTaken(env: Env, row: SendRow, from: readonly SendStatus[]): Promise<boolean> {
  if (!(await moveRow(env, row.id, from, 'not_executed', { settledWei: 0n }))) return false;
  const now = Date.now();
  await noteEvent(env, null, 'evm_relay_nonce_taken', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId }, now);
  if (!row.replay) {
    await settleBudget(env, row.appId, row.chainId, row.reserved.reservedWei, 0n, row.createdAt);
    await limiter(env, failureSubject(row.chainId, row.account, row.userId)).giveBack(FAILURES, DAY, '1', row.createdAt).catch(() => undefined);
  }
  return true;
}

const HASH = /^0x[0-9a-fA-F]{64}$/u;

/** The hashes a lookup lists (well-formed, lowercase), its mined one first. */
export function lookupHashes(l: EvmRelayerLookup | null): Hex[] {
  const mined = typeof l?.minedHash === 'string' && HASH.test(l.minedHash) ? [l.minedHash.toLowerCase() as Hex] : [];
  const listed = Array.isArray(l?.hashes) ? l.hashes.filter((h): h is Hex => typeof h === 'string' && HASH.test(h)).map((h) => h.toLowerCase() as Hex) : [];
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

/** One read of every hash: the first mined receipt (its own hash), or null. RPC failures count as "not yet". */
export async function firstReceipt(chain: SponsorChainPort, hashes: readonly Hex[]): Promise<SponsorReceipt | null> {
  for (const hash of hashes) {
    try {
      const r = await chain.receipt(hash);
      if (r && r.transactionHash.toLowerCase() === hash) return r;
    } catch {
      // the next hash
    }
  }
  return null;
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
 * A send that verifiably never ran: the row moves to `refused` first, and only then (and only for the caller that moved
 * it) do the reservation and the failure slot come back. A replay row's were given back by its request.
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
/** The relayer forgets a mined batch 10 minutes after its deadline; before 9 minutes, "unknown to it" means never sent. */
const NEVER_SENT_FROM_MS = 2 * MINUTE;
const NEVER_SENT_UNTIL_MS = 9 * MINUTE;
/** Reads that keep failing for a sent row the relayer forgot: given up (lost, the reservation kept) this long past the deadline. */
const GIVE_UP_AFTER_MS = 60 * MINUTE;

export interface ReconcileCounts {
  settled: number;
  refused: number;
  lost: number;
  open: number;
}

/**
 * Settles what the requests couldn't (bounded: RECONCILE_ROWS a run, oldest update first; idempotent through
 * settleFromReceipt and moveRow). Per row: the relayer's lookup and receipts for every hash it lists (and the row's own).
 * A receipt settles it. Unknown to the relayer between 2 and 9 minutes past the deadline (it would remember a mined or
 * pending one): nothing was sent, so everything comes back (`refused`). Unknown to it later, with no receipt: `lost`,
 * the reservation kept. Never throws.
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
    const read = await readReceipts(chain, hashesToPoll([...(row.txHash ? [row.txHash] : []), ...row.hashes], l.value));
    if (read.kind === 'mined') {
      if (await settleFromReceipt(env, cfg, row, read.receipt, OPEN_STATUSES)) counts.settled++;
      continue;
    }
    // The relayer says the nonce went to something else: settled at zero only when every receipt read found nothing.
    if (l.value?.state === 'taken') {
      if (read.kind === 'none' && (await settleTaken(env, row, OPEN_STATUSES))) counts.settled++;
      else counts.open++;
      continue;
    }
    const pastDeadline = now - row.deadline * 1000;
    // The relayer answered (no error) that it doesn't know the digest, past the deadline (the batch can't execute later).
    const unknownToRelayer = l.asked && l.value === null && pastDeadline >= NEVER_SENT_FROM_MS;
    if (unknownToRelayer && row.txHash === null && row.hashes.length === 0 && (c.status === 'sending' || c.status === 'unknown')) {
      // Never given a hash: while the relayer would still remember a sent batch (to 10 minutes past the deadline), its
      // "unknown" means nothing was sent: everything comes back. Later it proves nothing: lost, the reservation kept.
      if (pastDeadline < NEVER_SENT_UNTIL_MS) {
        if (await refundNeverSent(env, row)) counts.refused++;
      } else if (await moveRow(env, row.id, OPEN_STATUSES, 'lost')) counts.lost++;
      continue;
    }
    if (unknownToRelayer && (row.txHash !== null || row.hashes.length > 0)) {
      // A hash was sent and the relayer no longer remembers the digest: never refunded. Its receipts (every persisted
      // hash) were read above; nothing mined among them proves nothing (a version this row never saw, or a node
      // missing it), and nothing in the user's account (its code and storage are the user's) can prove it either. Lost,
      // the reservation kept. A read that failed is tried again (it may yet find the receipt), lost an hour past the
      // deadline.
      if (read.kind === 'none' || pastDeadline >= GIVE_UP_AFTER_MS) {
        if (await moveRow(env, row.id, OPEN_STATUSES, 'lost')) counts.lost++;
        continue;
      }
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
