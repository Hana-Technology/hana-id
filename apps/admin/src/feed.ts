// The security feed (docs/batch-c-spec.md "Email": best effort, at least once; D281). Every 5 minutes it walks three
// sources and emails what changed, after the fact:
//
//   app_changes      AdminRpc.changesSince(cursor `feed.app_changes.seq` in ops.state) → the org's security contacts
//   audit_log        StaffRpc.auditSince(cursor `feed.audit_log.seq`)                  → the org's security contacts
//   security_events  AdminRpc.securityEvents(unnotified) → the alias and the org's contacts → markSecurityEventNotified
//
// A cursor with no row in ops.state yet starts at the source's current position, silently (D344, amending D281): the
// first run reads to the end without sending anything and stores where it stopped, so the history before the deploy
// is never emailed; from then on only new rows are. A source too long to read in one run continues from
// `<cursor key>.init` the next run, still silent, until it reaches the end. Security events keep their own per-row
// `notified_at` and are emailed as before (each one is a security signal).
//
// Rows are grouped per org into one digest per run (one message per recipient). A cursor advances only past rows
// whose digest every recipient's send accepted, so a failure means a repeat next run, never a gap. An org with no
// security contacts gets its digest sent to the security alias instead, so no row goes nowhere. Each source runs on its
// own: the console being down stops only the audit_log source.
//
// Budget (D280, D380): every page read, contacts lookup and mark is one RPC of the run's budget, every email one call.
// A page or a digest that doesn't fit what is left isn't started; the cursor (or the silent walk's place) stays, and
// the next run carries on from it.
//
// Not emailed (they are covered by a blocking notice, or by the app_changes row of the same act): the proposals and
// the announcement of a guarded change (`origin.proposed`, `policy.proposed`, `raw_sign.proposed`, `change.announced`),
// the notices' own audit rows (`invite.notified`, `owner_grant.notified`) and the console's record of a link cancel
// (`change.link_cancel`; the API's `change.cancelled` is emailed). Sign-in rows (`auth.*`, `session.*`, from C9) are
// for the hourly bulk refusal digest of C9, not this feed. Everything else is emailed, so a new kind is never silent.
import type { AppChange, AuditRow, SecurityEvent } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { auditDigest, changesDigest, type MailContext, securityDigest } from './email/messages.ts';
import type { Rendered } from './email/render.ts';
import type { EmailSender } from './email/sender.ts';
import { errorName, log } from './log.ts';
import { type Budget, meteredEnv, recipients, sendToAll } from './mail.ts';
import type { OpsStore } from './ops.ts';
import { systemCtx } from './rpc.ts';

export const FEED_CURSORS = { changes: 'feed.app_changes.seq', audit: 'feed.audit_log.seq' } as const;
/** Rows read per page; at most FEED_PAGES pages per source and run. */
export const FEED_PAGE = 50;
export const FEED_PAGES = 4;
/** The silent first walk (D344): pages of this many rows (the RPCs' maximum), at most FEED_INIT_PAGES per run. */
export const FEED_INIT_PAGE = 500;
export const FEED_INIT_PAGES = 10;
/** Where an unfinished silent first walk keeps its place between runs. */
export const initKey = (key: string): string => `${key}.init`;

export const SKIPPED_CHANGE_KINDS: ReadonlySet<string> = new Set(['origin.proposed', 'policy.proposed', 'raw_sign.proposed', 'change.announced']);
/** Never emailed: notices' own bookkeeping, emailed-link cancels, staff Support ID lookups and Users finds (never mailed, D396, D410). */
export const SKIPPED_AUDIT_ACTIONS: ReadonlySet<string> = new Set(['invite.notified', 'owner_grant.notified', 'change.link_cancel', 'support.lookup', 'users.find']);

export const emailedChange = (r: AppChange): boolean => !SKIPPED_CHANGE_KINDS.has(r.kind);
export const emailedAudit = (r: AuditRow): boolean => !SKIPPED_AUDIT_ACTIONS.has(r.action) && !r.action.startsWith('auth.') && !r.action.startsWith('session.');

export interface FeedStepResult {
  read: number;
  emailedGroups: number;
  failedGroups: number;
  cursor?: number;
  /** D344: this run was (part of) the silent first walk; `true` once it reached the current position. */
  initialised?: boolean;
}

const seqOf = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * D344: a source whose cursor has no row yet is read to its end without sending anything, and the cursor is stored at
 * its last row (0 for an empty source). A walk that doesn't reach the end in this run stores its place under
 * `initKey(key)` and goes on next run; the cursor itself is written only at the end, so the feed never starts mid-way.
 */
async function initialise<R extends { seq: number }>(ops: OpsStore, key: string, from: number, read: (seq: number, limit: number) => Promise<R[]>, budget: Budget): Promise<FeedStepResult> {
  let cursor = from;
  let total = 0;
  for (let p = 0; p < FEED_INIT_PAGES; p++) {
    // Each page is one RPC of the run's budget; without one the walk keeps its place for the next run.
    if (!budget.fits(1, 1)) break;
    const rows = await read(cursor, FEED_INIT_PAGE);
    total += rows.length;
    if (rows.length) cursor = Math.max(cursor, rows[rows.length - 1]!.seq);
    if (rows.length < FEED_INIT_PAGE) {
      await ops.setState(key, String(cursor));
      return { read: total, emailedGroups: 0, failedGroups: 0, cursor, initialised: true };
    }
  }
  await ops.setState(initKey(key), String(cursor));
  return { read: total, emailedGroups: 0, failedGroups: 0, cursor, initialised: false };
}

/** Each org's security contacts for this run (null: unreadable, so its digest waits). */
class Contacts {
  private readonly cache = new Map<string, string[] | null>();
  constructor(private readonly env: Env) {}
  /** Whether `of(orgId)` would make an RPC (each org's contacts are read once a run). */
  uncached(orgId: string | null): boolean {
    return orgId !== null && !this.cache.has(orgId);
  }
  async of(orgId: string): Promise<string[] | null> {
    if (!this.cache.has(orgId)) {
      const r = await this.env.API.getSecurityContacts({ ...systemCtx(), orgId }).catch(() => null);
      this.cache.set(orgId, r?.ok ? r.emails : null);
    }
    return this.cache.get(orgId)!;
  }
}

interface Group<R> {
  orgId: string | null;
  rows: R[];
}

function groupByOrg<R>(rows: R[], orgOf: (r: R) => string | null): Group<R>[] {
  const out: Group<R>[] = [];
  const at = new Map<string | null, Group<R>>();
  for (const r of rows) {
    const o = orgOf(r);
    let g = at.get(o);
    if (!g) {
      g = { orgId: o, rows: [] };
      at.set(o, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

/**
 * One cursor-walked source: pages after the cursor, emails each page's groups, and stores the cursor past the last
 * row before the first group that wasn't sent (or past the page when every group was).
 */
async function walk<R extends { seq: number }>(
  ops: OpsStore,
  key: string,
  read: (seq: number, limit: number) => Promise<R[]>,
  emailed: (r: R) => boolean,
  orgOf: (r: R) => string | null,
  send: (g: Group<R>) => Promise<'sent' | 'failed' | 'budget'>,
  budget: Budget,
): Promise<FeedStepResult> {
  const state = await ops.getState([key, initKey(key)]);
  const row = state.get(key);
  if (!row) return initialise(ops, key, seqOf(state.get(initKey(key))?.value) ?? 0, read, budget);
  let cursor = seqOf(row.value) ?? 0;
  const result: FeedStepResult = { read: 0, emailedGroups: 0, failedGroups: 0 };
  for (let p = 0; p < FEED_PAGES; p++) {
    // Each page is one RPC of the run's budget, read only with room for one digest after it (its contacts and an
    // email); otherwise the cursor stays for the next run.
    if (!budget.fits(3, 2)) break;
    const rows = await read(cursor, FEED_PAGE);
    result.read += rows.length;
    if (rows.length === 0) break;
    const groups = groupByOrg(rows.filter(emailed), orgOf);
    let stopAt: number | null = null;
    let budgetOut = false;
    for (const g of groups) {
      const outcome = await send(g);
      if (outcome === 'sent') result.emailedGroups++;
      else {
        if (outcome === 'failed') result.failedGroups++;
        else budgetOut = true;
        const first = g.rows[0]!.seq;
        stopAt = stopAt === null ? first : Math.min(stopAt, first);
        if (budgetOut) break;
      }
    }
    const next = stopAt === null ? rows[rows.length - 1]!.seq : stopAt - 1;
    if (next > cursor) {
      cursor = next;
      await ops.setState(key, String(cursor));
    }
    if (stopAt !== null || rows.length < FEED_PAGE) break;
  }
  result.cursor = cursor;
  return result;
}

/**
 * One org's digest: its contacts (one RPC, once a run), one email per recipient, and `after` RPCs once sent (the
 * security events' mark). A digest that doesn't fit what is left of the budget is 'budget': not started, it and the
 * rest of the page wait for the next run (D280, D380).
 */
async function sendGroup(env: Env, sender: EmailSender, budget: Budget, contacts: Contacts, orgId: string | null, extra: string[], message: Rendered, purpose: string, alsoAlias: boolean, after = 0): Promise<'sent' | 'failed' | 'budget'> {
  const lookup = contacts.uncached(orgId) ? 1 : 0;
  if (!budget.fits(lookup + 1 + after, lookup + after)) return 'budget';
  const orgContacts = orgId ? await contacts.of(orgId) : [];
  if (orgContacts === null) return 'failed';
  let to = recipients(orgContacts, extra, alsoAlias ? env.SECURITY_ALIAS : undefined);
  if (to.length === 0) to = [env.SECURITY_ALIAS];
  if (!budget.fits(to.length + after, after)) return 'budget';
  const r = await sendToAll(sender, budget, to, message, purpose);
  return r.outOfBudget ? 'budget' : r.allAccepted ? 'sent' : 'failed';
}

const mail = (env: Env): MailContext => ({ env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN });

export function feedChanges(rawEnv: Env, ops: OpsStore, sender: EmailSender, budget: Budget): Promise<FeedStepResult> {
  const env = meteredEnv(rawEnv, budget);
  const contacts = new Contacts(env);
  return walk<AppChange>(
    ops,
    FEED_CURSORS.changes,
    async (seq, limit) => {
      const r = await env.API.changesSince({ ...systemCtx(), seq, limit });
      if (!r.ok) throw new Error(`changesSince: ${r.code}`);
      return r.changes;
    },
    emailedChange,
    (r) => r.orgId,
    (g) => {
      // A contacts change goes to the old contacts as well as the new ones (spec "Email").
      const extra = g.rows.flatMap((r) => (r.kind === 'org.security_contacts' ? [...((r.detail.old as string[] | undefined) ?? []), ...((r.detail.new as string[] | undefined) ?? [])] : [])).filter((e) => typeof e === 'string');
      const first = g.rows[0]!.seq;
      const last = g.rows[g.rows.length - 1]!.seq;
      return sendGroup(env, sender, budget, contacts, g.orgId, extra, changesDigest(mail(env), g.orgId ?? 'no organisation', g.rows), `feed:app_changes:${g.orgId}:${first}-${last}`, false);
    },
    budget,
  );
}

export function feedAudit(rawEnv: Env, ops: OpsStore, sender: EmailSender, budget: Budget): Promise<FeedStepResult> {
  const env = meteredEnv(rawEnv, budget);
  const contacts = new Contacts(env);
  return walk<AuditRow>(
    ops,
    FEED_CURSORS.audit,
    async (seq, limit) => {
      const r = await env.CONSOLE.auditSince({ ...systemCtx(), seq, limit });
      if (!r.ok) throw new Error(`auditSince: ${r.code}`);
      return r.rows;
    },
    emailedAudit,
    (r) => r.orgId ?? null,
    (g) => {
      const first = g.rows[0]!.seq;
      const last = g.rows[g.rows.length - 1]!.seq;
      return sendGroup(env, sender, budget, contacts, g.orgId, [], auditDigest(mail(env), g.orgId, g.rows), `feed:audit_log:${g.orgId}:${first}-${last}`, false);
    },
    budget,
  );
}

/** Security events: the API's `notified_at` is their cursor; marked once the group's sends were all accepted. */
export async function feedSecurityEvents(rawEnv: Env, sender: EmailSender, budget: Budget): Promise<FeedStepResult> {
  const env = meteredEnv(rawEnv, budget);
  // The page read is one RPC, worth it only with room for one digest after it (its contacts, an email, the mark);
  // without that nothing is read and every event waits for the next run.
  if (!budget.fits(4, 3)) return { read: 0, emailedGroups: 0, failedGroups: 0 };
  const r = await env.API.securityEvents({ ...systemCtx(), unnotifiedOnly: true, limit: FEED_PAGE });
  if (!r.ok) throw new Error(`securityEvents: ${r.code}`);
  const contacts = new Contacts(env);
  const result: FeedStepResult = { read: r.events.length, emailedGroups: 0, failedGroups: 0 };
  for (const g of groupByOrg<SecurityEvent>(r.events, (e) => e.orgId ?? null)) {
    const outcome = await sendGroup(env, sender, budget, contacts, g.orgId, [], securityDigest(mail(env), g.orgId, g.rows), `feed:security_events:${g.rows.map((e) => e.id).join(',')}`, true, 1);
    if (outcome === 'budget') break;
    if (outcome === 'failed') {
      result.failedGroups++;
      continue;
    }
    const marked = await env.API.markSecurityEventNotified({ ...systemCtx(), ids: g.rows.map((e) => e.id) });
    if (marked.ok) result.emailedGroups++;
    else result.failedGroups++;
  }
  return result;
}

/** The three sources, each on its own: one failing (the console down, say) doesn't hold back the others. */
export async function runFeed(env: Env, ops: OpsStore, sender: EmailSender, budget: Budget): Promise<Record<string, FeedStepResult | null>> {
  const out: Record<string, FeedStepResult | null> = {};
  const steps: [string, () => Promise<FeedStepResult>][] = [
    ['security_events', () => feedSecurityEvents(env, sender, budget)],
    ['app_changes', () => feedChanges(env, ops, sender, budget)],
    ['audit_log', () => feedAudit(env, ops, sender, budget)],
  ];
  for (const [step, run] of steps) {
    try {
      out[step] = await run();
      const r = out[step]!;
      log({ event: 'feed', step, outcome: r.failedGroups ? 'rejected' : 'ok', count: r.read, sent: r.emailedGroups, failed: r.failedGroups, ...(r.initialised !== undefined ? { code: r.initialised ? 'cursor_initialised' : 'cursor_initialising' } : {}) });
    } catch (err) {
      out[step] = null;
      log({ event: 'feed', step, outcome: 'error', error: errorName(err) }, 'error');
    }
  }
  return out;
}
