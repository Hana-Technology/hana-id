// Linking one person's IDs across a network's apps (D925; docs/partner-platform-spec.md piece P7, B6, finding L9):
// `ConsoleRpc.linkUser`, for the owners of the org that owns a marked scope (console-core linking.ts says who and why).
// The console checks the member is an owner, on every request and again in the audit row it writes before it answers
// (apps/console src/users.ts); this file holds what the API itself enforces:
//
// - **Reach, in the statement.** One SELECT finds the person by a whole User ID or Support ID among the people of the
//   org's own marked scopes only (`scopes.org_id`, `scopes.app_user_ids = 1`), through the scope-level IDs
//   (`end_users`) or an app's own (`end_user_apps`, of a live app of that org on the person's scope), and lists that
//   person's apps under the same filters. Another org's person, a person of an unmarked scope, a deleted app's ID and a
//   code nobody holds all give the same `not_found`, by the same statement (the same index probes; no other read).
// - **No oracle.** Whole values only: a User ID's exact text, or a Support ID's 8 characters (look-alikes read as
//   console-core `parseSupportId` does); no prefix, no LIKE. A Support ID (40 bits) that more than one person of the org
//   holds is refused (`ambiguous`), never resolved to one of them, as the erase script refuses one (D919): the owner
//   asks for the User ID instead. Only the org's own people count, so the refusal says nothing about other orgs.
// - **Limits, before the read.** 60 lookups a member an hour and 300 a day, 1 000 an org a day (fixed windows, UTC),
//   counted on two RateLimiter objects (`console-link:<member>`, `console-link-org:<org>`) before the statement runs,
//   so a lookup that finds nothing counts too (guessing costs the same as looking). Past 30 a member in an hour, or 200
//   an org in a day, one `link_lookup_volume` security event per window (a deterministic id), which the admin Worker
//   emails to Journear security; it never refuses.
// - **Bounded answer.** The person's scope-level User ID and Support ID (what the Users screen shows), the scope, which
//   kind of code matched, and per app (at most LINK_APPS_MAX, most recently used first) its id and name, the User ID
//   and Support ID it gives the person and two times. The statement never selects the internal id (`hu_…`, joined on
//   only), a sub, an identity key, an email or an address.
//
// SECURITY: nothing here logs the query, a User ID, a Support ID or a row; the RPC's log line has the method, the org
// and the outcome only.
import {
  LINK_ALERT_MEMBER_PER_HOUR,
  LINK_ALERT_ORG_PER_DAY,
  LINK_ALERT_ORG_PER_WEEK,
  LINK_APPS_MAX,
  LINK_MEMBER_PER_DAY,
  LINK_MEMBER_PER_HOUR,
  LINK_ORG_PER_DAY,
  type LinkPurpose,
  type LinkQuery,
  type LinkedApp,
  type UserLinkView,
  formatSupportId,
  linkAuditRef,
  parseLinkQuery,
} from '@hana-id/console-core';
import { refuse } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { HOUR_MS, eventId } from '../changes/guard.ts';
import { type Q, q, raw } from '../changes/sql.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { Limit } from '../rate-limiter.ts';

const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** A member's windows (its own object): the two limits, and the alert's soft window. */
export const LINK_MEMBER_LIMITS: Limit[] = [
  { name: 'hour', windowMs: HOUR_MS, max: LINK_MEMBER_PER_HOUR },
  { name: 'day', windowMs: DAY_MS, max: LINK_MEMBER_PER_DAY },
  { name: 'alert-hour', windowMs: HOUR_MS, max: LINK_ALERT_MEMBER_PER_HOUR, soft: true },
];
/** An org's windows (its own object). */
export const LINK_ORG_LIMITS: Limit[] = [
  { name: 'day', windowMs: DAY_MS, max: LINK_ORG_PER_DAY },
  { name: 'alert-day', windowMs: DAY_MS, max: LINK_ALERT_ORG_PER_DAY, soft: true },
  { name: 'alert-week', windowMs: WEEK_MS, max: LINK_ALERT_ORG_PER_WEEK, soft: true },
];

export const linkMemberObject = (memberId: string): string => `console-link:${memberId}`;
export const linkOrgObject = (orgId: string): string => `console-link-org:${orgId}`;

/**
 * Counts one lookup for the member and the org, before anything is read: `rate_limited` past a limit (the member's
 * count given back when the org's refuses, so a refusal costs nothing). Past an alert's threshold, writes that window's
 * `link_lookup_volume` event once (INSERT OR IGNORE of an id derived from the window). A limiter that can't be reached
 * throws (the RPC answers `internal`): no count, no lookup.
 */
export async function admitLinkLookup(env: Env, a: { memberId: string; orgId: string }, now: number): Promise<void> {
  const member = placedStub(env, env.RATE_LIMITER, linkMemberObject(a.memberId));
  const org = placedStub(env, env.RATE_LIMITER, linkOrgObject(a.orgId));
  const m = await member.hit(LINK_MEMBER_LIMITS, now);
  if (!m.ok) return refuse('rate_limited', m.limit === 'hour' ? 'Too many look-ups this hour: try again later' : 'Too many look-ups today: try again tomorrow');
  const o = await org.hit(LINK_ORG_LIMITS, now);
  if (!o.ok) {
    await member.unhit(LINK_MEMBER_LIMITS, now);
    return refuse('rate_limited', 'Your organisation has made too many look-ups today: try again tomorrow');
  }
  // Only the look-up that crosses a threshold writes its event (the RateLimiter names a soft window once per window).
  if (m.soft?.includes('alert-hour')) await volumeEvent(env.DB, { limit: 'member_hour', orgId: a.orgId, memberId: a.memberId, windowMs: HOUR_MS, threshold: LINK_ALERT_MEMBER_PER_HOUR }, now);
  if (o.soft?.includes('alert-day')) await volumeEvent(env.DB, { limit: 'org_day', orgId: a.orgId, memberId: null, windowMs: DAY_MS, threshold: LINK_ALERT_ORG_PER_DAY }, now);
  if (o.soft?.includes('alert-week')) await volumeEvent(env.DB, { limit: 'org_week', orgId: a.orgId, memberId: null, windowMs: WEEK_MS, threshold: LINK_ALERT_ORG_PER_WEEK }, now);
}

/** At most this many `link_lookup_volume` writes one look-up can make (one per soft window): counted in its cost. */
export const LINK_ALERT_WRITES_MAX = 3;

/**
 * One `link_lookup_volume` event, written by the look-up that crosses a threshold (once per window; its id is still
 * derived from the window, so a retry can't write a second). An org's events carry its `org_id`; a member's is filed
 * under no org (a member's limits follow them across orgs): its detail names the member and the org whose look-up
 * crossed it, and staff see every org the member's look-ups touched in the console audit (actor = the member).
 * `detail_json` holds the window and the threshold, never a person's ID. A failure is logged, never thrown: the alert
 * must not stop a look-up the limits allowed.
 */
async function volumeEvent(db: D1Database, e: { limit: 'member_hour' | 'org_day' | 'org_week'; orgId: string; memberId: string | null; windowMs: number; threshold: number }, now: number): Promise<void> {
  const windowStart = Math.floor(now / e.windowMs) * e.windowMs;
  const member = e.memberId !== null;
  try {
    await db
      .prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, detail_json) VALUES (?1, ?2, 'link_lookup_volume', ?3, ?4)")
      .bind(
        await eventId('link_lookup_volume', e.limit, member ? e.memberId! : e.orgId, String(windowStart)),
        now,
        member ? null : e.orgId,
        JSON.stringify({ limit: e.limit, windowStart, windowMs: e.windowMs, threshold: e.threshold, ...(member ? { memberId: e.memberId, crossedInOrg: e.orgId } : {}) }),
      )
      .run();
  } catch {
    log({ event: 'console_rpc', method: 'linkUser', outcome: 'error', code: 'volume_event_failed' }, 'error');
  }
}

/** The person-finding part of the statement: whole values, the org's marked scopes, live apps of the org on that scope. */
function hits(orgId: string, query: LinkQuery): Q {
  const scopeCol = query.kind === 'userId' ? 'u.token_sub' : 'u.support_code';
  const appCol = query.kind === 'userId' ? 'e.app_sub' : 'e.support_code';
  const value = query.kind === 'userId' ? query.userId : query.code;
  return q`SELECT u.user_id AS user_id, 'scope' AS via, NULL AS app_id
       FROM end_users u JOIN scopes s ON s.scope_id = u.scope_id
      WHERE ${raw(scopeCol)} = ${value} AND s.org_id = ${orgId} AND s.app_user_ids = 1
     UNION ALL
     SELECT e.user_id, 'app', e.app_id
       FROM end_user_apps e JOIN end_users u ON u.user_id = e.user_id JOIN scopes s ON s.scope_id = u.scope_id JOIN apps a ON a.id = e.app_id
      WHERE ${raw(appCol)} = ${value} AND s.org_id = ${orgId} AND s.app_user_ids = 1
        AND a.org_id = ${orgId} AND a.scope_id = u.scope_id AND a.deleted_at IS NULL`;
}

/**
 * The one statement of a lookup: at most two people (two means `ambiguous`), each with the codes that matched and its
 * apps (at most LINK_APPS_MAX + 1, so the answer can say it was cut). Exported for the rows-read tests.
 */
export function linkStatement(orgId: string, query: LinkQuery): Q {
  return q`WITH hit AS (${hits(orgId, query)})
    SELECT u.token_sub, u.support_code, u.scope_id,
      (SELECT json_group_array(json_object('via', h.via, 'app_id', h.app_id)) FROM hit h WHERE h.user_id = u.user_id) AS hits_json,
      (SELECT json_group_array(json_object('app_id', x.app_id, 'name', x.name, 'app_sub', x.app_sub, 'support_code', x.support_code, 'first_seen_at', x.first_seen_at, 'last_seen_at', x.last_seen_at))
         FROM (SELECT e.app_id, a.name, e.app_sub, e.support_code, e.first_seen_at, e.last_seen_at
                 FROM end_user_apps e JOIN apps a ON a.id = e.app_id
                WHERE e.user_id = u.user_id AND a.org_id = ${orgId} AND a.scope_id = u.scope_id AND a.deleted_at IS NULL
                ORDER BY e.last_seen_at DESC, e.app_id LIMIT ${LINK_APPS_MAX + 1}) x) AS apps_json
      FROM end_users u WHERE u.user_id IN (SELECT user_id FROM hit) ORDER BY u.token_sub LIMIT 2`;
}


interface LinkRow {
  token_sub: string;
  support_code: string;
  scope_id: string;
  hits_json: string;
  apps_json: string;
}

type Json = Record<string, unknown>;
const list = (s: string): Json[] => (JSON.parse(s || '[]') as (Json | null)[]).filter((x): x is Json => x !== null);

/** `ConsoleRpc.linkUser`'s work, after the limits: the person a whole User ID or Support ID names, and their apps. */
export async function consoleLinkUser(db: HotDb, i: { orgId: string; query: string; purpose: LinkPurpose }, subKey: Uint8Array): Promise<UserLinkView & { auditRef: string }> {
  const query = parseLinkQuery(i.query);
  if (!query) return refuse('bad_request', 'query: not a User ID (u1_…) or Support ID (HANA-XXXX-XXXX)');
  // The panel opens by the person's User ID for all the apps (PR 153's review): any other code is the search, so the
  // audit's `by` can't be made to say "panel" for a search by an app's code.
  if (i.purpose === 'panel' && query.kind !== 'userId') return refuse('bad_request', PANEL_ONLY);
  const rows = await db.all<LinkRow>(linkStatement(i.orgId, query));
  // Another org's person, an unmarked scope, a deleted app and a code nobody holds: the same answer.
  if (rows.length === 0) return refuse('not_found', 'No such user');
  if (rows.length > 1) return refuse('ambiguous', 'More than one person has this Support ID: ask for their User ID');
  const r = rows[0]!;
  const matched = list(r.hits_json);
  // The scope's own code first (a 'scope' app's row holds the same code as the person's scope-level one).
  const scopeHit = matched.some((h) => h.via === 'scope');
  const appHit = matched.find((h) => h.via === 'app' && typeof h.app_id === 'string');
  const of: 'scope' | 'app' = scopeHit || !appHit ? 'scope' : 'app';
  if (i.purpose === 'panel' && of !== 'scope') return refuse('bad_request', PANEL_ONLY);
  const appsAll = list(r.apps_json)
    .map(
      (a): LinkedApp => ({
        appId: String(a.app_id),
        appName: String(a.name),
        userId: String(a.app_sub),
        supportId: formatSupportId(String(a.support_code)),
        firstSeenAt: Number(a.first_seen_at),
        lastSeenAt: Number(a.last_seen_at),
      }),
    )
    .sort((x, y) => y.lastSeenAt - x.lastSeenAt || (x.appId < y.appId ? -1 : 1));
  return {
    userId: r.token_sub,
    supportId: formatSupportId(r.support_code),
    scopeId: r.scope_id,
    match: { kind: query.kind, of, appId: of === 'app' ? String(appHit!.app_id) : null },
    apps: appsAll.slice(0, LINK_APPS_MAX),
    truncated: appsAll.length > LINK_APPS_MAX,
    // The console's audit names the person by this, never by the User ID (console-core `linkAuditRef`).
    auditRef: await linkAuditRef(subKey, r.token_sub),
  };
}

const PANEL_ONLY = 'purpose: the panel opens by the person’s User ID for all your apps; an app’s code is a search';

