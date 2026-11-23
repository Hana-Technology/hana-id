// `GET /api/security` in C8 (docs/batch-c-spec.md "Admin BFF routes"; D285): the part of the security screen this
// batch can fill. The notice backlog (guarded changes, invites, owner grants not yet announced), the security events
// the feed has still to email, the feed's cursors with their lag (the age of the oldest row not yet emailed), the
// watcher's cursor and the last cron run. C12 adds the ledger's part (`ledger`): each relayer key's latest nonce check,
// the rejection-rate alerts (D91), the settlement alerts (relayed events not billed because their transaction wasn't
// their own, D321) and the settlement backlog, and the partitions ahead (fewer than 2 is a warning). The
// "Security & monitoring" view comes with C14.
import { type LabelFeedItem, type SecurityEvent, securityEventLabel } from '@hana-id/console-core';
import { getPlaybook } from '@hana-id/playbooks';
import type { Env } from './env.ts';
import { CRON_LAST_RUN } from './cron.ts';
import { FEED_CURSORS } from './feed.ts';
import { json } from './http.ts';
import { errorName, log } from './log.ts';
import { openTracked } from './neon.ts';
import { type LedgerStore, ledgerSource } from './ledger.ts';
import { opsSource } from './ops.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';
import { WATCH_CURSOR } from './watcher.ts';

/**
 * The playbook of each security event kind that has one (docs/playbooks.md): what it means, how urgent, what to do.
 * The gas sponsorship kinds (D848, D852, D869) and the NEAR relay's billing kind (D863) included (D843); a test holds
 * every gas sponsorship and billing-late kind to a playbook that exists.
 */
export const SECURITY_EVENT_PLAYBOOKS: Readonly<Record<string, string>> = Object.freeze({
  home_budget_high: 'home-budget-high',
  near_relay_budget_high: 'near-relay-budget-high',
  near_relay_balance_low: 'near-relay-balance-low',
  evm_relay_budget_high: 'evm-relay-budget-high',
  evm_relay_balance_low: 'evm-relay-balance-low',
  evm_relay_stuck: 'evm-relay-paused',
  evm_relay_receipt_odd: 'evm-relay-receipt-odd',
  evm_relay_nonce_taken: 'evm-relay-slot-taken',
  evm_billing_late: 'evm-billing-late',
  evm_relay_closed_slot_mined: 'evm-relay-closed-slot-mined',
  // D890: the relayer's pause for money ended by itself after a refill.
  evm_relay_auto_resumed: 'evm-relay-auto-resumed',
  near_billing_late: 'near-billing-late',
  // D872: the usage database's free monthly compute allowance.
  neon_compute_high: 'neon-compute-high',
});

export function withWords(e: SecurityEvent): SecurityEvent & { title: string; playbook: { id: string; title: string } | null } {
  const id = Object.hasOwn(SECURITY_EVENT_PLAYBOOKS, e.kind) ? SECURITY_EVENT_PLAYBOOKS[e.kind]! : null;
  const pb = id ? getPlaybook(id) : undefined;
  return { ...e, title: securityEventLabel(e.kind), playbook: pb ? { id: pb.id, title: pb.title } : null };
}

interface FeedSource {
  cursor: number;
  updatedAt: number | null;
  /** ms since the oldest row after the cursor was written; 0 when caught up; null when unreadable. */
  lagMs: number | null;
}

export async function securityView(env: Env, staff: StaffRequest): Promise<Response> {
  const ctx = staffCtx(staff);
  const now = Date.now();
  const settle = async <T>(p: () => Promise<T>): Promise<T | null> => {
    try {
      return await p();
    } catch {
      return null;
    }
  };
  const [changeNotices, memberNotices, events, labelQueue] = await Promise.all([
    settle(() => env.API.pendingNotices({ ...ctx, limit: 100 })),
    settle(() => env.CONSOLE.pendingMemberNotices({ ...ctx, limit: 100 })),
    settle(() => env.API.securityEvents({ ...ctx, unnotifiedOnly: true, limit: 100 })),
    // D894: the partner label changes waiting (the Partner labels screen has them in full).
    settle(() => env.API.labelQueue({ ...ctx })),
  ]);
  let feed: Record<string, FeedSource> | null = null;
  let watcher: { cursor: string | null; updatedAt: number | null } | null = null;
  let lastRun: unknown = null;
  let opsError: string | null = null;
  try {
    // D872: the screen opens the ledger (a Neon wake-up), reported when each connection closes (NEON_PLAN only).
    const ops = await openTracked(env, () => opsSource.open(env.USAGE_DB));
    if (!ops) opsError = 'USAGE_DB is not bound: the feed and the watcher are off';
    else {
      try {
        const state = await ops.getState([FEED_CURSORS.changes, FEED_CURSORS.audit, WATCH_CURSOR, CRON_LAST_RUN]);
        const cursorOf = (k: string) => Number(state.get(k)?.value ?? '0') || 0;
        const lag = async (read: () => Promise<{ at: number }[] | null>): Promise<number | null> => {
          const rows = await settle(read);
          return rows === null ? null : rows[0] ? Math.max(0, now - rows[0].at) : 0;
        };
        const changesCursor = cursorOf(FEED_CURSORS.changes);
        const auditCursor = cursorOf(FEED_CURSORS.audit);
        feed = {
          app_changes: {
            cursor: changesCursor,
            updatedAt: state.get(FEED_CURSORS.changes)?.updatedAt ?? null,
            lagMs: await lag(async () => {
              const r = await env.API.changesSince({ ...ctx, seq: changesCursor, limit: 1 });
              return r.ok ? r.changes : null;
            }),
          },
          audit_log: {
            cursor: auditCursor,
            updatedAt: state.get(FEED_CURSORS.audit)?.updatedAt ?? null,
            lagMs: await lag(async () => {
              const r = await env.CONSOLE.auditSince({ ...ctx, seq: auditCursor, limit: 1 });
              return r.ok ? r.rows : null;
            }),
          },
        };
        watcher = { cursor: state.get(WATCH_CURSOR)?.value || null, updatedAt: state.get(WATCH_CURSOR)?.updatedAt ?? null };
        const raw = state.get(CRON_LAST_RUN)?.value;
        lastRun = raw ? (JSON.parse(raw) as unknown) : null;
      } finally {
        await ops.close();
      }
    }
  } catch (err) {
    opsError = 'The ops store is unavailable';
    log({ event: 'bff', route: 'GET /api/security', requestId: staff.requestId, outcome: 'error', code: 'ops_unavailable', error: errorName(err) }, 'warn');
  }
  const ledger = await ledgerPart(env, staff);
  return json(200, {
    ledger,
    notices: {
      changes: changeNotices?.ok ? changeNotices.notices.map((n) => ({ changeId: n.change.id, kind: n.change.kind, appId: n.app.id, orgId: n.app.orgId, proposedAt: n.change.proposedAt, contacts: n.contacts.length })) : null,
      members: memberNotices?.ok ? memberNotices.notices.map((n) => ({ kind: n.kind, id: n.invite?.id ?? n.grant?.id, orgId: n.invite?.orgId ?? n.grant?.orgId ?? null, createdAt: n.grant?.createdAt ?? n.invite?.createdAt })) : null,
    },
    // Each event with its title in words and its playbook (D843), so staff read what it means, not its code.
    unnotifiedEvents: events?.ok ? events.events.map(withWords) : null,
    labels: labelQueue?.ok ? labelsWaiting(labelQueue.items) : null,
    feed,
    watcher,
    lastRun,
    opsError,
  });
}

/** The partner label changes still waiting (D894): how many, how many of them wait for a staff Allow, and the soonest live. */
export function labelsWaiting(items: LabelFeedItem[]): { waiting: number; awaitingAllow: number; notAnnounced: number; nextLiveAt: number | null } {
  const waiting = items.filter((i) => i.change.state === 'proposed' || i.change.state === 'announced' || i.change.state === 'waiting_review');
  const times = waiting.map((i) => i.change.activeFrom).filter((t): t is number => typeof t === 'number');
  return { waiting: waiting.length, awaitingAllow: waiting.filter((i) => i.change.state === 'waiting_review').length, notAnnounced: waiting.filter((i) => i.change.state === 'proposed').length, nextLiveAt: times.length ? Math.min(...times) : null };
}

/** Fewer future partitions than this is a warning (spec "Usage ledger": the admin console alerts below 2). */
export const MIN_PARTITIONS_AHEAD = 2;

async function ledgerPart(env: Env, staff: StaffRequest): Promise<Record<string, unknown>> {
  let store: LedgerStore | null;
  try {
    store = await openTracked(env, () => ledgerSource.open(env.USAGE_DB));
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/security', requestId: staff.requestId, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'warn');
    return { error: 'The usage ledger is unavailable' };
  }
  if (!store) return { error: 'USAGE_DB is not bound: settlement, the nonce check and the rejection check are off' };
  try {
    const [nonce, rejections, settlement, backlog, partitionsAhead] = [
      await store.nonceChecks({ unalertedUnexplainedOnly: false, limit: 50 }),
      await store.rejectionAlerts({ unalertedOnly: false, limit: 50 }),
      await store.settlementAlerts({ unalertedOnly: false, limit: 50 }),
      await store.settlementBacklog(),
      await store.partitionsAhead(),
    ];
    return {
      nonceChecks: nonce.map((n) => ({ ...n, chainNonce: n.chainNonce.toString() })),
      rejectionAlerts: rejections,
      settlementAlerts: settlement,
      settlementBacklog: backlog,
      partitionsAhead,
      partitionsLow: partitionsAhead < MIN_PARTITIONS_AHEAD,
      relayerAccountSet: Boolean(env.RELAYER_ACCOUNT),
    };
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/security', requestId: staff.requestId, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'warn');
    return { error: 'The usage ledger is unavailable' };
  } finally {
    await store.close();
  }
}
