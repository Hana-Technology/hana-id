// Platform keys in the partner console (D918; docs/partner-platform-spec.md A3, A11): what registration, acceptance,
// confirmation and revocation strictly need (the rest of the screens are piece P5's).
//
// - `GET /api/orgs/:org/platform-keys` (any member): the org's keys, the people who registered, accepted and confirmed
//   them (the org's own members' addresses; staff are "Journear staff"), the org's test scopes, and the server's clock.
// - `GET /api/orgs/:org/platform-keys/:id` (any member): one key and whether this member may accept or confirm it now,
//   with the reason if not: the page the announcement's Confirm link opens (`/confirm-platform-key/:id`, which finds
//   the key's org with `GET /api/platform-keys/:id/org`). A GET never changes anything.
// - `POST …/platform-keys/:id/revoke` and `…/cancel` (an owner; immediate, no fresh sign-in; allowed while the org is
//   frozen: kill switches). Registering, accepting and confirming are step-ups (actions.ts kinds `platform.key_*`).
// - `POST /api/platform-keys/cancel` and `/api/platform-keys/revoke` (no session: the emailed link's token; the `link`
//   actor), under the CSRF rules and the per-IP link limit like `/api/cancel`.
//
// Who may confirm (A3, D914, D917): an `owner` of an active org who is an on-chain owner of each scope the key names,
// with the fresh sign-in. On a real-money setup (`fourEyes`) never the registrant: another console user (here and in
// the API), another Google `sub` (the API, against the step-up's), another email compared without dots and `+tags`
// (here against the registrant's address, and in the API against the one it stored), and an owner since before the key
// was registered (here only: the API doesn't hold roles). These person checks run when the action is built and again
// in the callback, so a change of role in between is caught.
import { type Actor, PLATFORM_CALLS_PAGE, type PlatformKeyView, appIdInput, personEmailKey, platformKeyByLinkInput } from '@hana-id/console-core';
import { z } from '@hana-id/env/zod';
import { type Writer, auditInsert, entry } from './audit.ts';
import { type OrgCaller, actorOf } from './actions.ts';
import type { Env } from './env.ts';
import { errorResponse, json, readJson } from './http.ts';
import { ipPrefix, ipSubject } from './ip.ts';
import { CONSOLE_LIMIT_PERIOD_S, consoleIpKey } from './limits.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { NearUnavailable, oidcOwners, viewScope } from './near.ts';
import { lit, ownerNow } from './sql.ts';
import type { Session } from './sessions.ts';
import { memberships } from './bff.ts';

export const PLATFORM_KEY_ID = 'pkc_[1-9A-HJ-NP-Za-km-z]{12,17}';

/** Why this member can't accept or confirm a key now (shown on the page; null: they may). */
export type Ability = { allowed: true } | { allowed: false; reason: string };

/**
 * The addresses of the people a key names, for the screens: only current members of `orgId` (a registrant, acceptor or
 * confirmer who has left the org, any other console user and staff are left out, and the screens say "a former
 * member" or "Journear staff"). Never used for four eyes (registrantEmail, which is never returned to a caller).
 */
export async function peopleOf(env: Env, orgId: string, ids: readonly (string | undefined)[]): Promise<Record<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.startsWith('usr_')))];
  if (want.length === 0) return {};
  const { results } = await env.CONSOLE_DB.prepare(`SELECT u.id, u.email FROM console_users u JOIN members m ON m.user_id = u.id AND m.org_id = ? WHERE u.id IN (${want.map(() => '?').join(', ')})`)
    .bind(orgId, ...want)
    .all<{ id: string; email: string }>();
  return Object.fromEntries(results.map((r) => [r.id, r.email]));
}

/** The registrant's address for four eyes' email comparison only (also after they left the org); never returned to a caller. */
async function registrantEmail(env: Env, userId: string): Promise<string | null> {
  return (await env.CONSOLE_DB.prepare('SELECT email FROM console_users WHERE id = ?').bind(userId).first<{ email: string }>())?.email ?? null;
}

/**
 * Since when the member is an owner of the org without a break, or null if not an owner now (D918 after PR 149's
 * review): an owner's `role_since`; a viewer whose matured grant isn't applied yet, the later of `role_since` and that
 * grant's `owner_from` (applied grants don't count: a demotion, or a removal and a new membership, resets the clock, and
 * `role_since` moves with each of them).
 */
export async function ownerSince(env: Env, orgId: string, userId: string, now: number): Promise<number | null> {
  const r = await env.CONSOLE_DB.prepare(
    `SELECT m.role, m.role_since, ${ownerNow('m', now)} AS is_owner,
            (SELECT MAX(og.owner_from) FROM owner_grants og WHERE og.org_id = m.org_id AND og.user_id = m.user_id AND og.cancelled_at IS NULL AND og.applied_at IS NULL
                AND og.notified_at IS NOT NULL AND og.owner_from <= ${lit(now)}) AS granted_from
       FROM members m WHERE m.org_id = ? AND m.user_id = ?`,
  )
    .bind(orgId, userId)
    .first<{ role: string; role_since: number; is_owner: number; granted_from: number | null }>();
  if (!r || !r.is_owner) return null;
  if (r.role === 'owner') return r.role_since;
  return r.granted_from === null ? null : Math.max(r.role_since, r.granted_from);
}

/**
 * Four eyes' person checks (A3, D917), for a key with `fourEyes`: not the registrant's console user, not the
 * registrant's email (dots and `+tags` aside), and an owner since before the key was registered. Null when none
 * applies or all pass.
 */
export async function fourEyesProblem(env: Env, orgId: string, who: { userId: string; email: string }, key: PlatformKeyView, now: number): Promise<string | null> {
  if (!key.fourEyes) return null;
  if (key.proposedByKind === 'member') {
    if (key.proposedBy === who.userId) return 'You registered this key, so another owner must confirm it. If nobody does, it starts working when its wait ends.';
    const theirs = await registrantEmail(env, key.proposedBy);
    if (theirs !== null && personEmailKey(theirs) === personEmailKey(who.email)) return 'This account has the same email address as the owner who registered the key, so another owner must confirm it.';
  }
  const since = await ownerSince(env, orgId, who.userId, now);
  if (since === null || since > key.proposedAt) return 'Only an owner who was already an owner when the key was registered can confirm it.';
  return null;
}

/** Whether the session's Google account is an on-chain owner of every scope the key names (each read uncached). */
async function ownsEveryScope(env: Env, scopes: readonly string[], sub: string): Promise<boolean | 'unavailable'> {
  for (const scopeId of scopes) {
    let s;
    try {
      s = await viewScope(env, scopeId);
    } catch (err) {
      if (err instanceof NearUnavailable) return 'unavailable';
      throw err;
    }
    if (!s || !oidcOwners(s).some((o) => o.provider === 'google' && o.sub === sub)) return false;
  }
  return true;
}

/** Whether this member may accept (a staff key awaiting acceptance) or confirm (a waiting, announced key) now, and why not. */
export async function abilityFor(env: Env, c: OrgCaller, key: PlatformKeyView, what: 'accept' | 'confirm', now: number): Promise<Ability> {
  const no = (reason: string): Ability => ({ allowed: false, reason });
  if (c.role !== 'owner') return no('Only an owner of your organisation can do this.');
  if (c.orgStatus !== 'active') return no('Journear has frozen your organisation, so keys can’t be accepted or confirmed.');
  if (what === 'accept') {
    if (key.state !== 'awaiting_acceptance') return no('This key isn’t waiting for an acceptance.');
    // Four eyes for the screen too (the API refuses it anyway): on a real-money setup the person who registered the
    // staff key (by email: staff aren't console users) can't accept it. The owner-since rule isn't applied to an
    // acceptance: the staff member who registered it is the first person, so a second owner account adds nothing.
    if (key.fourEyes && key.registeredByYou) return no('This account has the same email address as the person who registered the key, so another owner must accept it.');
  } else {
    if (key.fourEyes && key.registeredByYou && key.proposedByKind === 'member' && key.proposedBy !== c.session.userId) return no('This account has the same email address or Google account as the owner who registered the key, so another owner must confirm it.');
    if (key.state !== 'waiting' || key.notifiedAt === undefined || key.confirmedAt !== undefined) return no(key.state === 'waiting' ? 'This key can be confirmed once its email has gone out.' : 'This key isn’t waiting.');
    const problem = await fourEyesProblem(env, c.orgId, { userId: c.session.userId, email: c.session.email }, key, now);
    if (problem) return no(problem);
  }
  const owns = await ownsEveryScope(env, key.scopes, c.session.sub);
  if (owns === 'unavailable') return no('We couldn’t check the wallet settings’ owners just now. Try again in a minute.');
  if (!owns) return no('Only an owner of this wallet’s settings can do this (an on-chain owner of every scope the key names).');
  return { allowed: true };
}

const ctxOf = (c: OrgCaller, info: RequestInfo) => ({ actor: actorOf(c.session) as Actor, requestId: info.requestId, clientIp: info.clientIp });

/** `GET /api/orgs/:org/platform-keys`. */
export async function listRoute(env: Env, info: RequestInfo, c: OrgCaller): Promise<Response> {
  const ctx = ctxOf(c, info);
  const [keys, apps] = await Promise.all([env.API.listPlatformKeys({ ...ctx, orgId: c.orgId }), env.API.listApps({ ...ctx, orgId: c.orgId })]);
  if (!keys.ok) return errorResponse(keys.code);
  const scopes = apps.ok ? [...new Set(apps.apps.filter((a) => a.environment === 'test').map((a) => a.scopeId))].sort() : [];
  const people = await peopleOf(env, c.orgId, keys.keys.flatMap((k) => [k.proposedBy, k.acceptedBy, k.confirmedBy]));
  return json(200, { keys: keys.keys, platform: { enabled: keys.platform.enabled, frozen: keys.platform.frozen }, scopes, people, role: c.role, now: Date.now() });
}

/**
 * `GET /api/orgs/:org/platform-activity?app=&before=` (any member, D930): one page of the org's platform calls, newest
 * first, with the labels of the org's keys and the names of its apps for the screen. Reads only.
 */
export async function activityRoute(env: Env, info: RequestInfo, c: OrgCaller, url: URL): Promise<Response> {
  const app = url.searchParams.get('app');
  const before = url.searchParams.get('before');
  if (app !== null && !appIdInput.safeParse(app).success) return errorResponse('bad_request', 'Bad app');
  if (before !== null && !/^[1-9]\d{0,15}$/u.test(before)) return errorResponse('bad_request', 'Bad cursor');
  const ctx = ctxOf(c, info);
  const [calls, keys, apps] = await Promise.all([
    env.API.platformCalls({ ...ctx, orgId: c.orgId, limit: PLATFORM_CALLS_PAGE, ...(app !== null ? { appId: app } : {}), ...(before !== null ? { before: Number(before) } : {}) }),
    env.API.listPlatformKeys({ ...ctx, orgId: c.orgId }),
    env.API.listApps({ ...ctx, orgId: c.orgId }),
  ]);
  if (!calls.ok) return errorResponse(calls.code);
  const keyLabels = keys.ok ? Object.fromEntries(keys.keys.map((k) => [k.id, k.label])) : {};
  // Every app of the org that the platform created, for the filter; names of any app a call names.
  const appList = apps.ok ? apps.apps.filter((a) => a.createdByKind === 'platform').map((a) => ({ id: a.id, name: a.name })) : [];
  const appNames = apps.ok ? Object.fromEntries(apps.apps.map((a) => [a.id, a.name])) : {};
  return json(200, { calls: calls.calls, ...(calls.next !== undefined ? { next: calls.next } : {}), keyLabels, apps: appList, appNames, platform: keys.ok ? { enabled: keys.platform.enabled } : null });
}

/** `GET /api/orgs/:org/platform-keys/:id`: the key, the people it names, and this member's abilities. Reads only. */
export async function keyRoute(env: Env, info: RequestInfo, c: OrgCaller, keyId: string): Promise<Response> {
  const r = await env.API.getPlatformKey({ ...ctxOf(c, info), orgId: c.orgId, keyId });
  if (!r.ok) return errorResponse(r.code);
  const now = Date.now();
  const people = await peopleOf(env, c.orgId, [r.key.proposedBy, r.key.acceptedBy, r.key.confirmedBy]);
  const [accept, confirm, owners] = await Promise.all([abilityFor(env, c, r.key, 'accept', now), abilityFor(env, c, r.key, 'confirm', now), ownerCount(env, c.orgId, now)]);
  return json(200, { key: r.key, people, role: c.role, accept, confirm, owners, now });
}

/** How many owners the org has now (D930: the page says when only one, so a real-money key always waits). */
async function ownerCount(env: Env, orgId: string, now: number): Promise<number> {
  const r = await env.CONSOLE_DB.prepare(`SELECT COUNT(*) AS n FROM members m JOIN console_users u ON u.id = m.user_id WHERE m.org_id = ? AND u.disabled_at IS NULL AND ${ownerNow('m', now)}`)
    .bind(orgId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** `GET /api/platform-keys/:id/org`: which of the member's organisations the key is in (for the email's Confirm link). */
export async function findOrgRoute(env: Env, info: RequestInfo, s: Session, keyId: string): Promise<Response> {
  if (!new RegExp(`^${PLATFORM_KEY_ID}$`, 'u').test(keyId)) return errorResponse('not_found');
  const orgs = (await memberships(env, s, Date.now())).slice(0, 10);
  for (const m of orgs) {
    const r = await env.API.getPlatformKey({ actor: actorOf(s), requestId: info.requestId, clientIp: info.clientIp, orgId: m.orgId, keyId });
    if (r.ok) return json(200, { orgId: m.orgId });
  }
  return errorResponse('not_found');
}

const writerOf = (c: OrgCaller, info: RequestInfo): Writer => ({ actor: actorOf(c.session), requestId: info.requestId, now: Date.now(), ipPrefix: ipPrefix(info.clientIp), country: info.country });

async function audited(env: Env, w: Writer, action: 'platform_key.revoked' | 'platform_key.cancelled', orgId: string, keyId: string, code: string | null): Promise<void> {
  try {
    await auditInsert(env.CONSOLE_DB, entry(w, action, { orgId, target: keyId, outcome: code ? 'failed' : 'ok', details: code ? { code, keyId } : { keyId } })).run();
  } catch (err) {
    log({ event: 'audit_write_failed', requestId: w.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
  }
}

/** `POST …/platform-keys/:id/revoke {reason?}`: at once, whatever the key's state (a kill switch). */
export async function revokeRoute(request: Request, env: Env, info: RequestInfo, c: OrgCaller, keyId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b.ok) return errorResponse(b.code);
  const p = z.object({ reason: z.string().trim().max(200).optional() }).strict().safeParse(b.value);
  if (!p.success) return errorResponse('bad_request', 'Expected {reason?}');
  const r = await env.API.revokePlatformKey({ ...ctxOf(c, info), orgId: c.orgId, keyId, ...(p.data.reason ? { reason: p.data.reason } : {}) });
  log({ event: 'console_rpc', method: 'revokePlatformKey', requestId: info.requestId, orgId: c.orgId, outcome: r.ok ? 'ok' : 'rejected', ...(r.ok ? {} : { code: r.code }) });
  await audited(env, writerOf(c, info), 'platform_key.revoked', c.orgId, keyId, r.ok ? null : r.code);
  return r.ok ? json(200, { key: r.key }) : errorResponse(r.code, r.error);
}

/** `POST …/platform-keys/:id/cancel {}`: a waiting key, at once. */
export async function cancelRoute(request: Request, env: Env, info: RequestInfo, c: OrgCaller, keyId: string): Promise<Response> {
  const b = await readJson(request);
  if (!b.ok) return errorResponse(b.code);
  if (!z.object({}).strict().safeParse(b.value).success) return errorResponse('bad_request', 'Expected {}');
  const r = await env.API.cancelPlatformKey({ ...ctxOf(c, info), orgId: c.orgId, keyId });
  log({ event: 'console_rpc', method: 'cancelPlatformKey', requestId: info.requestId, orgId: c.orgId, outcome: r.ok ? 'ok' : 'rejected', ...(r.ok ? {} : { code: r.code }) });
  await audited(env, writerOf(c, info), 'platform_key.cancelled', c.orgId, keyId, r.ok ? null : r.code);
  return r.ok ? json(200, { key: r.key }) : errorResponse(r.code, r.error);
}

/** Failures worth an audit row: a refusal of a valid link (too late, already used); wrong tokens are only logged (D244). */
const AUDITED_FAILURES: ReadonlySet<string> = new Set(['not_pending', 'already_applied', 'conflict', 'internal']);

/** `POST /api/platform-keys/cancel {keyId, token}` and `POST /api/platform-keys/revoke {keyId, token}`: the emailed links. */
export function linkRoute(what: 'cancel' | 'revoke') {
  return async (request: Request, env: Env, info: RequestInfo): Promise<Response> => {
    const { success } = await env.CONSOLE_IP_LIMIT.limit({ key: consoleIpKey(env.ENV_NAME, 'link', ipSubject(info.clientIp)) });
    if (!success) return errorResponse('rate_limited', undefined, { 'retry-after': String(CONSOLE_LIMIT_PERIOD_S) });
    const body = await readJson(request);
    if (!body.ok) return errorResponse(body.code);
    const parsed = z.object({ keyId: z.string(), token: z.string() }).strict().safeParse(body.value);
    if (!parsed.success) return errorResponse('bad_request', 'Expected {keyId, token}');
    const input = { actor: { kind: 'link' as const, id: parsed.data.keyId }, requestId: info.requestId, clientIp: info.clientIp, keyId: parsed.data.keyId, token: parsed.data.token };
    if (!platformKeyByLinkInput.safeParse(input).success) return errorResponse('bad_request', 'Expected {keyId, token}');
    let r: Awaited<ReturnType<Env['API']['cancelPlatformKeyByLink']>>;
    try {
      r = what === 'cancel' ? await env.API.cancelPlatformKeyByLink(input) : await env.API.revokePlatformKeyByLink(input);
    } catch (err) {
      log({ event: 'link_cancel', method: `${what}PlatformKeyByLink`, requestId: info.requestId, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
      return errorResponse('internal');
    }
    const code = r.ok ? null : r.code;
    log({ event: 'link_cancel', method: `${what}PlatformKeyByLink`, requestId: info.requestId, outcome: r.ok ? 'ok' : 'rejected', ...(code ? { code } : {}) });
    if (r.ok || AUDITED_FAILURES.has(code!)) {
      const w: Writer = { actor: { kind: 'link', id: input.keyId }, requestId: info.requestId, now: Date.now(), ipPrefix: ipPrefix(info.clientIp), country: info.country };
      try {
        await auditInsert(env.CONSOLE_DB, entry(w, what === 'cancel' ? 'platform_key.link_cancel' : 'platform_key.link_revoke', { target: input.keyId, outcome: r.ok ? 'ok' : 'failed', details: { keyId: input.keyId, ...(code ? { code } : {}) } })).run();
      } catch (err) {
        log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
      }
    }
    return r.ok ? json(200, r.key) : errorResponse(r.code, r.error);
  };
}
