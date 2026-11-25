// The partner Users screen (D310; docs/batch-c-spec.md "Users and Support ID" → "What partners never see"): an org's
// end users across its own scopes, with the user id, the Support ID, when the user was first and last seen, the kinds of
// account connected ("google", "email"), the wallet addresses, and an email only once the user shared it with one of
// the org's apps (D411: the API's own copy of a granted consent, never the issuer's directory), and the user's name
// only once they shared it from Passport Home with one of the org's live apps (D714). Never an unshared address, a Google
// `sub`, an identity key or any other identity detail: the API's ConsoleRpc answers partner views only (the wallet
// directory, D315), and the console re-shapes every row through the allowlist below before it answers, so a field the
// API adds later (or a bug there) can't reach a partner's screen. The shape is the data contract the tests pin, not
// just what the UI renders.
//
// Behind `USERS_SCREEN` (off by default; D357): the ConsoleRpc reads (`listUsers`, `getUser`) are the wallet
// directory's (D310, D315) with D346's User ID (`userId` = the identity token's `sub`, `u1_…`; `supportId` its short
// form; the internal `hu_…` id never reaches a partner). Until the flag is on in an env, the routes are 404 and the tab
// is hidden: turn it on once that env's API runs D346.
import {
  type ConsoleGetUserInput,
  type ConsoleLinkUserInput,
  type LinkedApp,
  type UserLinkView,
  LINK_APPS_MAX,
  linkUserBody,
  type ConsoleListUsersInput,
  type PartnerUser,
  type RpcFail,
  type RpcOk,
  USER_CURSOR_RE as CORE_CURSOR_RE,
  USER_ID_RE as CORE_USER_ID_RE,
  APP_NAME_MAX,
  isDisplaySafeName,
} from '@hana-id/console-core';
import { normalizeProfileName } from '@hana-id/core/identity';
import { type Writer, auditInsert, entry } from './audit.ts';
import type { Env } from './env.ts';
import { errorResponse, json, readJson } from './http.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { frag, ownerNow } from './sql.ts';

/** The partner user as ConsoleRpc answers it (console-core `PartnerUser`). */
export type PartnerUserIn = PartnerUser;

type UsersCtx = Omit<ConsoleListUsersInput, 'scopeId' | 'search' | 'cursor' | 'limit'>;

/** The two ConsoleRpc reads the screen needs (apps/api/src/rpc/console.ts). */
export interface ConsoleUsersClient {
  listUsers(c: ConsoleListUsersInput): Promise<RpcOk<{ users: PartnerUserIn[]; nextCursor: string | null }> | RpcFail>;
  getUser(c: ConsoleGetUserInput): Promise<RpcOk<{ user: PartnerUserIn }> | RpcFail>;
}

/** What the console answers for a user: exactly these fields, nothing else. */
export interface PartnerUserOut {
  userId: string;
  supportId: string;
  scopeId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Connected account kinds only: no address, no Google account id. */
  accounts: { kind: 'google' | 'email' | 'apple' | 'other'; status: 'active' | 'pending' }[];
  wallets: { chain: 'stellar' | 'evm' | 'near'; address: string; firstSeenAt: number; lastUsedAt: number }[];
  /** The address most recently shared with one of the org's apps (D411), or null ("Not shared"). */
  email: string | null;
  /** A user's detail only: every address shared with the org's apps, per app. */
  emails?: { appId: string; appName: string; email: string; sharedAt: number }[];
  /** The name shared from Passport Home with one of the org's live apps (D714), or null ("Not shared"). */
  name: { givenName: string | null; familyName: string | null } | null;
  /** The scope is marked as shared (D915): these are the person's IDs for every app made before the mark (D925). */
  sharedScope: boolean;
}

/**
 * The User ID partners see (D346): the identity token's `sub` (`u1_` ‖ 22 base64url characters), one per scope and
 * account, like Privy's DID. The directory's internal `hu_…` key is never shown. console-core's own pattern.
 */
export const USER_ID_RE = CORE_USER_ID_RE;
const SUPPORT_ID_RE = /^HANA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u;
const SCOPE_RE = /^(global|s[0-9a-z]{1,32})$/u;
const STELLAR_RE = /^G[A-Z2-7]{55}$/u;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/u;
/** A NEAR implicit account id (D755): 64 lowercase hex characters, as the API stores it. */
const NEAR_RE = /^[0-9a-f]{64}$/u;
/** The chains this console shows; a wallet of a chain it doesn't know yet is left out (not passed through), the user kept. */
const WALLET_RES: Record<string, RegExp> = { stellar: STELLAR_RE, evm: EVM_RE, near: NEAR_RE };
/** The API's page cursor (console-core's pattern), passed back as given. */
export const USER_CURSOR_RE = CORE_CURSOR_RE;
const KINDS = new Set(['google', 'email', 'apple']);
/** An app id (console-core `appIdInput`'s pattern). */
const APP_ID_RE = /^app_[A-Za-z0-9]{1,64}$/u;
/** The longest address shown (RFC 5321's path limit). */
export const EMAIL_MAX = 254;

const time = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * A shared address as the screen may show it: 3..254 characters, exactly one `@` with text on both sides, no
 * whitespace, one display-safe line (no control, bidi or zero-width character). Anything else is not an address.
 */
export function isShownEmail(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 3 || v.length > EMAIL_MAX || /\s/u.test(v) || !isDisplaySafeName(v)) return false;
  const at = v.indexOf('@');
  return at > 0 && at === v.lastIndexOf('@') && at < v.length - 1;
}

/** An app name as the API stores it: one display-safe line of 1..64 code points. */
const isAppName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && [...v].length <= APP_NAME_MAX && isDisplaySafeName(v);
/** Shown instead of an app name that isn't one display-safe line: the user and their shared address stay listed. */
export const UNNAMED_APP = 'Unnamed app';

/** One part of a shared name: null, or a string already in `normalizeProfileName`'s form (D714); undefined otherwise. */
const namePart = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && normalizeProfileName(v) === v ? v : undefined);

/**
 * A shared name as the screen may show it (D714): null when not shared (or absent: an API before profile names), else
 * exactly `{givenName, familyName}`, each part null or a string `normalizeProfileName` leaves unchanged (NFC, trimmed,
 * 1..50 code points, one display-safe line), at least one set; undefined (the row is dropped) for anything else.
 */
function sharedName(v: unknown): PartnerUserOut['name'] | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const x = v as Record<string, unknown>;
  const givenName = namePart(x.givenName);
  const familyName = namePart(x.familyName);
  if (givenName === undefined || familyName === undefined || (givenName === null && familyName === null)) return undefined;
  return { givenName, familyName };
}

/**
 * One user as a partner may see it, rebuilt field by field from the API's answer, or null when the row doesn't have
 * the expected form (dropped and logged, never passed through). An account is its kind only; a wallet is a chain, an
 * address of that chain's form and two times; `email` a shared address or null; `emails` (a detail only) an app id, its
 * name, the address and when it was shared; `name` a shared name's two parts or null (`sharedName`). An entry's other
 * keys are dropped, as an account's, a wallet's or a name's.
 */
export function partnerUserView(u: unknown): PartnerUserOut | null {
  if (typeof u !== 'object' || u === null) return null;
  const r = u as Record<string, unknown>;
  const createdAt = time(r.createdAt);
  const lastSeenAt = time(r.lastSeenAt);
  if (typeof r.userId !== 'string' || !USER_ID_RE.test(r.userId) || typeof r.supportId !== 'string' || !SUPPORT_ID_RE.test(r.supportId)) return null;
  if (typeof r.scopeId !== 'string' || !SCOPE_RE.test(r.scopeId) || createdAt === null || lastSeenAt === null) return null;
  if (!Array.isArray(r.accounts) || !Array.isArray(r.wallets)) return null;
  const accounts: PartnerUserOut['accounts'] = [];
  for (const a of r.accounts as unknown[]) {
    const kind = (a as { kind?: unknown } | null)?.kind;
    const status = (a as { status?: unknown } | null)?.status;
    if (typeof kind !== 'string' || (status !== 'active' && status !== 'pending')) return null;
    accounts.push({ kind: KINDS.has(kind) ? (kind as 'google' | 'email' | 'apple') : 'other', status });
  }
  const wallets: PartnerUserOut['wallets'] = [];
  for (const w of r.wallets as unknown[]) {
    const x = (w ?? {}) as Record<string, unknown>;
    const first = time(x.firstSeenAt);
    const last = time(x.lastUsedAt);
    if (first === null || last === null || typeof x.address !== 'string') return null;
    if (typeof x.chain !== 'string') return null;
    const re = Object.hasOwn(WALLET_RES, x.chain) ? WALLET_RES[x.chain] : undefined;
    // A chain this console doesn't know (an API newer than it): that wallet is left out, the user still listed.
    if (!re) continue;
    if (!re.test(x.address)) return null;
    wallets.push({ chain: x.chain as 'stellar' | 'evm' | 'near', address: x.address, firstSeenAt: first, lastUsedAt: last });
  }
  // Always present (null: not shared); a missing or malformed one drops the row rather than guess.
  const email = r.email === null ? null : isShownEmail(r.email) ? r.email : undefined;
  if (email === undefined) return null;
  let emails: PartnerUserOut['emails'];
  if (r.emails !== undefined) {
    if (!Array.isArray(r.emails)) return null;
    emails = [];
    for (const e of r.emails as unknown[]) {
      const x = (e ?? {}) as Record<string, unknown>;
      const sharedAt = time(x.sharedAt);
      if (typeof x.appId !== 'string' || !APP_ID_RE.test(x.appId) || !isShownEmail(x.email) || sharedAt === null) return null;
      emails.push({ appId: x.appId, appName: isAppName(x.appName) ? x.appName : UNNAMED_APP, email: x.email, sharedAt });
    }
  }
  // Missing (an API before profile names): not shared. Malformed: the row is dropped, as for `email`.
  const name = sharedName(r.name);
  if (name === undefined) return null;
  // Missing (an API before D925): not marked.
  return { userId: r.userId, supportId: r.supportId, scopeId: r.scopeId, createdAt, lastSeenAt, accounts, wallets, email, ...(emails ? { emails } : {}), name, sharedScope: r.sharedScope === true };
}

export const usersScreenOn = (env: Pick<Env, 'USERS_SCREEN'>): boolean => env.USERS_SCREEN === '1';

/** The users client, when the flag is on and the API binding has the reads; else null (the routes are 404). */
export function usersClient(env: Pick<Env, 'USERS_SCREEN' | 'API'>): ConsoleUsersClient | null {
  const api = env.API as Partial<ConsoleUsersClient>;
  return usersScreenOn(env) && typeof api.listUsers === 'function' && typeof api.getUser === 'function' ? (api as ConsoleUsersClient) : null;
}

/** `GET /api/orgs/:org/users?scope&search&cursor` (viewer) → `{users, next?}`; `GET /api/orgs/:org/users/:userId` → `{user}`. */
export async function usersRoute(env: Pick<Env, 'USERS_SCREEN' | 'API'>, url: URL, info: RequestInfo, ctx: UsersCtx, userId: string | undefined): Promise<Response> {
  const client = usersClient(env);
  if (!client) return errorResponse('not_found');
  if (userId !== undefined) {
    if (!USER_ID_RE.test(userId)) return errorResponse('not_found');
    const r = await client.getUser({ ...ctx, userId });
    if (!r.ok) return errorResponse(r.code);
    const user = partnerUserView(r.user);
    if (!user) {
      log({ event: 'users_shape', requestId: info.requestId, outcome: 'error', code: 'bad_row' }, 'error');
      return errorResponse('internal');
    }
    return json(200, { user });
  }
  const q = url.searchParams;
  const one = (k: string): string | undefined => {
    const v = q.getAll(k);
    return v.length === 1 && v[0] !== '' ? v[0] : undefined;
  };
  const scopeId = one('scope');
  const search = one('search');
  const cursor = one('cursor');
  if ((scopeId !== undefined && !SCOPE_RE.test(scopeId)) || (search !== undefined && search.length > 255) || (cursor !== undefined && !USER_CURSOR_RE.test(cursor))) {
    return errorResponse('bad_request', 'Bad scope, search or cursor');
  }
  const r = await client.listUsers({ ...ctx, ...(scopeId ? { scopeId } : {}), ...(search ? { search } : {}), ...(cursor ? { cursor } : {}), limit: 50 });
  if (!r.ok) return errorResponse(r.code);
  const users: PartnerUserOut[] = [];
  for (const row of r.users) {
    const v = partnerUserView(row);
    if (v) users.push(v);
    else log({ event: 'users_shape', requestId: info.requestId, outcome: 'error', code: 'bad_row' }, 'error');
  }
  return json(200, { users, ...(r.nextCursor ? { next: r.nextCursor } : {}) });
}

// ---- linking one person across the org's apps (D925; docs/partner-platform-spec.md piece P7, B6) ----

/** ConsoleRpc's linking read (apps/api/src/directory/link.ts). */
export interface ConsoleLinkClient {
  linkUser(c: ConsoleLinkUserInput): Promise<RpcOk<{ link: unknown }> | RpcFail>;
}

/** What the console answers for a lookup: exactly these fields (console-core `UserLinkView`), nothing else. */
export type UserLinkOut = UserLinkView;

/**
 * A lookup's answer as an owner may see it, rebuilt field by field, or null when it doesn't have the expected form
 * (dropped and logged, never passed through): the person's scope-level User ID and Support ID, the scope, which kind of
 * code matched (and the app it is the own code of), and per app its id, name, User ID, Support ID and two times.
 */
export function userLinkView(u: unknown): UserLinkOut | null {
  if (typeof u !== 'object' || u === null) return null;
  const r = u as Record<string, unknown>;
  if (typeof r.userId !== 'string' || !USER_ID_RE.test(r.userId) || typeof r.supportId !== 'string' || !SUPPORT_ID_RE.test(r.supportId)) return null;
  if (typeof r.scopeId !== 'string' || !SCOPE_RE.test(r.scopeId) || typeof r.truncated !== 'boolean' || !Array.isArray(r.apps) || r.apps.length > LINK_APPS_MAX) return null;
  const m = (r.match ?? {}) as Record<string, unknown>;
  if ((m.kind !== 'userId' && m.kind !== 'supportId') || (m.of !== 'scope' && m.of !== 'app')) return null;
  const matchApp = m.of === 'app' ? (typeof m.appId === 'string' && APP_ID_RE.test(m.appId) ? m.appId : undefined) : m.appId === null ? null : undefined;
  if (matchApp === undefined) return null;
  const apps: LinkedApp[] = [];
  for (const a of r.apps as unknown[]) {
    const x = (a ?? {}) as Record<string, unknown>;
    const first = time(x.firstSeenAt);
    const last = time(x.lastSeenAt);
    if (typeof x.appId !== 'string' || !APP_ID_RE.test(x.appId) || typeof x.userId !== 'string' || !USER_ID_RE.test(x.userId)) return null;
    if (typeof x.supportId !== 'string' || !SUPPORT_ID_RE.test(x.supportId) || first === null || last === null) return null;
    apps.push({ appId: x.appId, appName: isAppName(x.appName) ? x.appName : UNNAMED_APP, userId: x.userId, supportId: x.supportId, firstSeenAt: first, lastSeenAt: last });
  }
  return { userId: r.userId, supportId: r.supportId, scopeId: r.scopeId, match: { kind: m.kind, of: m.of, appId: matchApp }, apps, truncated: r.truncated };
}

/** The linking client, when the Users screen is on and the API binding has the read; else null (the route is 404). */
export function linkClient(env: Pick<Env, 'USERS_SCREEN' | 'API'>): ConsoleLinkClient | null {
  const api = env.API as Partial<ConsoleLinkClient>;
  return usersScreenOn(env) && typeof api.linkUser === 'function' ? (api as ConsoleLinkClient) : null;
}

/**
 * The audit row's guard: the acting member is an owner of the org now (`ownerNow`, the same rule as every owner write),
 * not disabled, and the org's Workspace rule holds for the session's domain. Read in the insert itself, so a member
 * demoted, removed or disabled since the request began gets no row, and so no answer.
 */
const ownerGuard = (orgId: string, userId: string, hd: string | null, now: number) =>
  frag(
    `EXISTS (SELECT 1 FROM members m JOIN orgs o ON o.id = m.org_id JOIN console_users cu ON cu.id = m.user_id
       WHERE m.org_id = ? AND m.user_id = ? AND cu.disabled_at IS NULL AND (o.required_hd IS NULL OR o.required_hd = ?) AND ${ownerNow('m', now)})`,
    orgId,
    userId,
    hd,
  );

/**
 * `POST /api/orgs/:org/users/link {query, purpose}` (owner): one person of the org's marked scopes, by a whole User ID
 * or Support ID (the scope's or one app's own), with that person's ID on each of the org's apps (D925). In order:
 *
 *   1. the route matrix: an owner now (a viewer is `403 forbidden` before anything is read or counted);
 *   2. `ConsoleRpc.linkUser`: counted for the member and the org, then one SELECT held to the org's marked scopes;
 *   3. the `users.link_view` audit row, written only while the member is still an owner (`ownerGuard`, read in the
 *      insert): target the person's scope-level User ID (none when nothing was found), the app whose own code matched,
 *      what opened it and the kind of code; no other identifier. A refusal is recorded the same way, with its code;
 *   4. only then the answer, rebuilt field by field. An audit row that can't be written, or a guard that no longer holds,
 *      means no answer (`internal`, `forbidden`): the lookup's count stays spent.
 *
 * POST, so no code lands in a URL; the query is never logged or stored.
 */
export async function linkRoute(env: Env, request: Request, info: RequestInfo, ctx: UsersCtx & { orgId: string }, w: Writer, hd: string | null): Promise<Response> {
  const client = linkClient(env);
  if (!client) return errorResponse('not_found');
  const b = await readJson(request);
  if (!b.ok) return errorResponse(b.code);
  const body = linkUserBody.safeParse(b.value);
  if (!body.success) return errorResponse('bad_request', 'Expected {query, purpose}');
  const r = await client.linkUser({ ...ctx, query: body.data.query, purpose: body.data.purpose });
  const view = r.ok ? userLinkView(r.link) : null;
  if (r.ok && !view) log({ event: 'users_shape', requestId: info.requestId, outcome: 'error', code: 'bad_link' }, 'error');
  const code = !r.ok ? r.code : view ? null : 'internal';
  const details: Record<string, string> = { by: body.data.purpose, ...(view ? { kind: view.match.kind, of: view.match.of } : { code: code! }) };
  let recorded: number;
  try {
    const res = await auditInsert(
      env.CONSOLE_DB,
      entry(w, 'users.link_view', { orgId: ctx.orgId, appId: view?.match.appId ?? null, target: view?.userId ?? null, outcome: view ? 'ok' : 'failed', details }),
      ownerGuard(ctx.orgId, ctx.actor.id, hd, w.now),
    ).run();
    recorded = res.meta.changes;
  } catch (err) {
    log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'error');
    return errorResponse('internal', 'The look-up couldn’t be recorded, so nothing is shown. Try again.');
  }
  log({ event: 'console_rpc', method: 'linkUser', requestId: info.requestId, orgId: ctx.orgId, outcome: view ? 'ok' : 'rejected', ...(code ? { code } : {}) });
  if (recorded !== 1) return errorResponse('forbidden', 'Only an owner of the organisation can do this');
  // The API's own words for a limit or an ambiguous code (fixed texts, never the query); every other refusal its code.
  if (!view) return !r.ok ? errorResponse(r.code, r.code === 'rate_limited' || r.code === 'ambiguous' ? r.error : undefined) : errorResponse('internal');
  return json(200, { link: view });
}
