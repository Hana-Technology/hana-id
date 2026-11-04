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
import { type Budget, recipients, sendToAll } from './mail.ts';
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
export const SKIPPED_AUDIT_ACTIONS: ReadonlySet<string> = new Set(['invite.notified', 'owner_grant.notified', 'change.link_cancel']);

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
async function initialise<R extends { seq: number }>(ops: OpsStore, key: string, from: number, read: (seq: number, limit: number) => Promise<R[]>): Promise<FeedStepResult> {
  let cursor = from;
  let total = 0;
  for (let p = 0; p < FEED_INIT_PAGES; p++) {
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
): Promise<FeedStepResult> {
  const state = await ops.getState([key, initKey(key)]);
  const row = state.get(key);
  if (!row) return initialise(ops, key, seqOf(state.get(initKey(key))?.value) ?? 0, read);
  let cursor = seqOf(row.value) ?? 0;
  const result: FeedStepResult = { read: 0, emailedGroups: 0, failedGroups: 0 };
  for (let p = 0; p < FEED_PAGES; p++) {
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

async function sendGroup(env: Env, sender: EmailSender, budget: Budget, contacts: Contacts, orgId: string | null, extra: string[], message: Rendered, purpose: string, alsoAlias: boolean): Promise<'sent' | 'failed' | 'budget'> {
  const orgContacts = orgId ? await contacts.of(orgId) : [];
  if (orgContacts === null) return 'failed';
  let to = recipients(orgContacts, extra, alsoAlias ? env.SECURITY_ALIAS : undefined);
  if (to.length === 0) to = [env.SECURITY_ALIAS];
  const r = await sendToAll(sender, budget, to, message, purpose);
  return r.outOfBudget ? 'budget' : r.allAccepted ? 'sent' : 'failed';
}

const mail = (env: Env): MailContext => ({ env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN });

export function feedChanges(env: Env, ops: OpsStore, sender: EmailSender, budget: Budget): Promise<FeedStepResult> {
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
  );
}

export function feedAudit(env: Env, ops: OpsStore, sender: EmailSender, budget: Budget): Promise<FeedStepResult> {
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
  );
}

/** Security events: the API's `notified_at` is their cursor; marked once the group's sends were all accepted. */
export async function feedSecurityEvents(env: Env, sender: EmailSender, budget: Budget): Promise<FeedStepResult> {
  const r = await env.API.securityEvents({ ...systemCtx(), unnotifiedOnly: true, limit: FEED_PAGE });
  if (!r.ok) throw new Error(`securityEvents: ${r.code}`);
  const contacts = new Contacts(env);
  const result: FeedStepResult = { read: r.events.length, emailedGroups: 0, failedGroups: 0 };
  for (const g of groupByOrg<SecurityEvent>(r.events, (e) => e.orgId ?? null)) {
    const outcome = await sendGroup(env, sender, budget, contacts, g.orgId, [], securityDigest(mail(env), g.orgId, g.rows), `feed:security_events:${g.rows.map((e) => e.id).join(',')}`, true);
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
