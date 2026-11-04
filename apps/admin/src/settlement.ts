// Gas settlement, every 15 minutes (docs/batch-c-spec.md "Settlement"; build plan C12 with the C4 obligation, review
// L7, D222; D321, D322). Each relayed event without a settlement row gets one: its transaction read with `tx` at FINAL,
// billed only when the transaction is its own:
//
// 1. its `near_tx` is carried by no other relayed event in the ledger (a duplicate bills neither: `duplicate_tx`);
// 2. its `relayer_pk` is one of the env's relayer pool keys (`AdminRpc.relayerKeys`, both pools);
// 3. the transaction at FINAL has that hash, is signed by the env's relayer account with that key at that nonce, and is
//    sent to the signer contract (`signer_mismatch` otherwise).
//
// A refusal is written `unsettled` with its reason (never billed, listed in the admin's security screen) and raises a
// settlement alert, emailed to the security alias by the alert step (alerts.ts): a leaked writer credential could
// otherwise attach a real transaction to an org it isn't for. A transaction that isn't final yet is read again an hour
// later; after 24 h without a final answer the event is written `unsettled` (`not_final`), counted on the statement,
// never estimated. Each `tx` read takes one call of the run's budget (D280's 40).
import type { Budget } from './mail.ts';
import type { LedgerStore, QueuedEvent } from './ledger.ts';
import type { NearReader } from './near.ts';

/** The spec's per-run cap; the run's outbound budget is the tighter bound (D322). */
export const SETTLEMENT_MAX = 500;
export const SETTLEMENT_RETRY_MS = 60 * 60 * 1000;
export const UNSETTLED_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SettlementDeps {
  store: LedgerStore;
  near: NearReader;
  /** The env's relayer pool public keys (`ed25519:…`), read once per run. */
  poolKeys: ReadonlySet<string>;
  relayerAccount: string;
  signerAccount: string;
  budget: Budget;
  now: number;
}

export interface SettlementSummary {
  read: number;
  final: number;
  unsettled: number;
  refused: number;
  retried: number;
}

/** Why a transaction read at FINAL isn't this event's, or null when it is (each mismatching field, for the alert). */
export function mismatchOf(e: QueuedEvent, tx: { hash: string; signerId: string; publicKey: string; nonce: bigint; receiverId: string }, d: Pick<SettlementDeps, 'relayerAccount' | 'signerAccount'>): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (tx.hash !== e.nearTx) out.hash = tx.hash;
  if (tx.signerId !== d.relayerAccount) out.signerId = tx.signerId;
  if (tx.publicKey !== e.relayerPk) out.publicKey = tx.publicKey;
  if (tx.nonce !== e.relayerNonce) out.nonce = tx.nonce.toString();
  if (tx.receiverId !== d.signerAccount) out.receiverId = tx.receiverId;
  return Object.keys(out).length ? out : null;
}

async function refuse(d: SettlementDeps, e: QueuedEvent, reason: 'duplicate_tx' | 'signer_mismatch', detail: Record<string, unknown>): Promise<void> {
  // The alert first: a settlement row without its alert would be a refusal nobody hears of.
  await d.store.addSettlementAlert({ requestId: e.requestId, at: e.at, orgId: e.orgId, nearTx: e.nearTx, reason, detail });
  await d.store.recordSettlement({ requestId: e.requestId, at: e.at, nearTx: e.nearTx, result: 'unsettled', reason });
}

export async function runSettlement(d: SettlementDeps): Promise<SettlementSummary> {
  const sum: SettlementSummary = { read: 0, final: 0, unsettled: 0, refused: 0, retried: 0 };
  const limit = Math.min(SETTLEMENT_MAX, Math.max(0, d.budget.remaining));
  if (limit === 0) return sum;
  const queue = await d.store.settlementQueue(limit, d.now, SETTLEMENT_RETRY_MS);
  for (const e of queue) {
    // 1. Its own transaction: no other relayed event carries the hash.
    const same = await d.store.relayedWithTx(e.nearTx);
    const others = same.filter((x) => !(x.requestId === e.requestId && x.at === e.at));
    if (others.length > 0) {
      await refuse(d, e, 'duplicate_tx', { others: others.slice(0, 10).map((o) => ({ requestId: o.requestId, orgId: o.orgId, at: new Date(o.at).toISOString() })) });
      sum.refused++;
      continue;
    }
    // 2. A key of the env's relayer pools (no chain read needed to refuse).
    if (!d.poolKeys.has(e.relayerPk)) {
      await refuse(d, e, 'signer_mismatch', { notInPool: e.relayerPk, nonce: e.relayerNonce.toString() });
      sum.refused++;
      continue;
    }
    if (!d.budget.take()) break;
    sum.read++;
    const read = await d.near.txFinal(e.nearTx, d.relayerAccount);
    if (read.kind === 'final' && read.tx.gas) {
      // 3. Signed by the relayer account with that key at that nonce, to the signer contract.
      const mismatch = mismatchOf(e, read.tx, d);
      if (mismatch) {
        await refuse(d, e, 'signer_mismatch', { expected: { publicKey: e.relayerPk, nonce: e.relayerNonce.toString() }, chain: mismatch });
        sum.refused++;
        continue;
      }
      await d.store.recordSettlement({ requestId: e.requestId, at: e.at, nearTx: e.nearTx, result: 'final', gasBurnt: read.tx.gas.gasBurnt, tokensBurnt: read.tx.gas.tokensBurnt });
      sum.final++;
      continue;
    }
    const why = read.kind === 'final' ? 'malformed_amounts' : read.why;
    if (d.now - e.at >= UNSETTLED_AFTER_MS) {
      await d.store.recordSettlement({ requestId: e.requestId, at: e.at, nearTx: e.nearTx, result: 'unsettled', reason: 'not_final' });
      sum.unsettled++;
    } else {
      await d.store.recordTry(e.requestId, e.at, d.now, why);
      sum.retried++;
    }
  }
  return sum;
}
