// The staff Users screen's BFF routes (D275 as confirmed 2026-11-05, batch C8b; docs/batch-c-spec.md "Users and
// Support ID" → "Users screen"). POST only, so no address, sub or code lands in a URL or a log line.
//
//   POST /api/users/search  the email issuer's directory (`ISSUER` → DirectoryRpc.search): address (a full address
//                           exactly, else a ≥ 3-character substring), provider, app, sub, unverified only; keyset pages.
//                           A support reference (`ticket`) is optional here.
//   POST /api/users/find    the wallet directory (`API` → AdminRpc.findUsers): a wallet address, User ID (`u1_…`),
//                           internal id (`hu_…`) or Support ID (`HANA-XXXX-XXXX`); identities with their subs, wallets
//                           and ids, no address (the Support ID lookup with activity is C15).
//   POST /api/users/get     one identity, the ticket required: its directory row and apps (DirectoryRpc.get, audited
//                           by the issuer), the app names (AdminRpc.appNames), the wallet directory's users holding it
//                           (AdminRpc.findUsers by provider and sub: User ID, Support ID, internal id, wallets; D310,
//                           D346), and per scope the on-chain path read live (`get_identity`, `get_account`, with the
//                           block height; a failed read is "chain unavailable", never a guessed path).
//
// The issuer checks the staff member itself from the request's Access JWT (passed as it came; this Worker verified it
// too), writes the audit row, and keeps the per-staff row budget: a `rate_limited` answer with `budget` makes this
// Worker email the security alias (`directory_budget`, one message per staff member and window). A detail's outbound
// calls come out of one D380 budget (40 calls, at most 30 RPCs), so the page never passes the plan's subrequest limit:
// what doesn't fit is marked "not read".
import { ACCESS_JWT_HEADER } from '@hana-id/oidc';
import { type AppNameView, DIRECTORY_PAGE_MAX, type DirectoryFail, type DirectoryUserApp, type DirectoryUserRow, type StaffUser, UNVERIFIED_CLAIM_WARNING } from '@hana-id/console-core';
import { directoryBudget } from './email/ledger-messages.ts';
import { outbound } from './email/sender.ts';
import type { Env } from './env.ts';
import { type ErrorCode, errorResponse, json } from './http.ts';
import { errorName, log } from './log.ts';
import { Budget, metered, recipients, sendToAll } from './mail.ts';
import { type ChainAccount, type ChainIdentity, getAccount, getIdentity } from './near.ts';
import type { RouteCtx } from './routes.ts';
import { staffCtx } from './rpc.ts';

/** Scopes whose on-chain standing one detail reads (two NEAR calls each at most). */
export const DETAIL_CHAIN_SCOPES_MAX = 8;
/** Apps whose name, org and environment one detail looks up (one AdminRpc.appNames call). */
export const DETAIL_APP_NAMES_MAX = 50;

const PROVIDERS = new Set(['email', 'google']);

/** The ticket rule of the issuer's staff routes (console-core SUPPORT_TICKET_RE): checked again by the issuer. */
const TICKET_RE = /^[A-Za-z0-9._#:-]{1,64}$/u;

/** The staff call's identity for the issuer: the Access JWT exactly as Cloudflare put it on this request. */
const staffCall = (c: RouteCtx) => ({ requestId: c.staff.requestId, accessJwt: c.request.headers.get(ACCESS_JWT_HEADER) ?? '' });

const pick = (b: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (b[k] !== undefined && b[k] !== '' && b[k] !== null) out[k] = b[k];
  return out;
};

/** The issuer's refusal as this BFF's answer; a budget refusal first emails the security alias. */
async function directoryFailure(c: RouteCtx, route: string, f: DirectoryFail): Promise<Response> {
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: f.code });
  switch (f.code) {
    case 'unauthenticated':
    case 'not_staff':
      log({ event: 'directory_refused', route, requestId: c.staff.requestId, outcome: 'error', code: f.code }, 'error');
      return errorResponse('directory_refused');
    case 'access_unavailable':
      return errorResponse('directory_unavailable', 'The email issuer could not check the staff identity (its admin Access config or the Access certs)');
    case 'rate_limited': {
      if (f.budget) await budgetAlert(c, f.budget);
      const retry = f.budget ? Math.max(1, Math.ceil(f.budget.retryAfterMs / 1000)) : 60;
      const msg = f.budget
        ? `Directory row budget reached (${f.budget.limit} identities ${f.budget.window === '1h' ? 'an hour' : 'a day'} per staff member); Hana security has been emailed. Reads open again in ${Math.ceil(retry / 60)} min.`
        : f.error;
      return errorResponse('rate_limited', msg, { 'retry-after': String(retry) });
    }
    default:
      return errorResponse(f.code as ErrorCode, f.error);
  }
}

/** `directory_budget` to the security alias: one message per staff member and window (the provider drops repeats). */
async function budgetAlert(c: RouteCtx, b: NonNullable<DirectoryFail['budget']>): Promise<void> {
  const now = Date.now();
  const opens = Math.round((now + b.retryAfterMs) / 60_000);
  const to = recipients(c.env.SECURITY_ALIAS);
  try {
    const r = await sendToAll(
      outbound.email(c.env),
      new Budget(to.length, 0),
      to,
      directoryBudget({ env: c.env.ENV_NAME, consoleOrigin: c.env.CONSOLE_ORIGIN }, { staff: c.staff.actor.email, window: b.window, limit: b.limit, retryAfterMs: b.retryAfterMs, at: now }),
      `directory_budget:${c.env.ENV_NAME}:${c.staff.actor.email}:${b.window}:${opens}`,
    );
    log({ event: 'directory_budget', requestId: c.staff.requestId, outcome: r.allAccepted ? 'ok' : 'error', sent: r.sent, failed: r.failed }, r.allAccepted ? 'warn' : 'error');
  } catch (err) {
    log({ event: 'directory_budget', requestId: c.staff.requestId, outcome: 'error', error: errorName(err) }, 'error');
  }
}

const unavailable = (c: RouteCtx, route: string, err?: unknown): Response => {
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'directory_unavailable', ...(err ? { error: errorName(err) } : {}) }, 'error');
  return errorResponse('directory_unavailable');
};

/** POST /api/users/search */
export async function usersSearchRoute(c: RouteCtx): Promise<Response> {
  const route = 'POST /api/users/search';
  if (!c.env.ISSUER) return unavailable(c, route);
  const limit = typeof c.body.limit === 'number' ? Math.min(c.body.limit, DIRECTORY_PAGE_MAX) : c.body.limit;
  const input = { ...staffCall(c), ...pick(c.body, 'ticket', 'q', 'provider', 'appId', 'sub', 'cursor'), ...(c.body.unverifiedOnly === true ? { unverifiedOnly: true } : {}), ...(limit !== undefined ? { limit } : {}) };
  let r;
  try {
    r = await c.env.ISSUER.search(input);
  } catch (err) {
    return unavailable(c, route, err);
  }
  if (!r.ok) return directoryFailure(c, route, r);
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', count: r.users.length });
  return json(200, { users: r.users, ...(r.next ? { next: r.next } : {}), unverifiedWarning: UNVERIFIED_CLAIM_WARNING });
}

/** POST /api/users/find: the wallet directory by wallet address, User ID, internal id or Support ID. */
export async function usersFindRoute(c: RouteCtx): Promise<Response> {
  const route = 'POST /api/users/find';
  let r;
  try {
    r = await c.env.API.findUsers({ ...staffCtx(c.staff), query: c.body.query });
  } catch (err) {
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable');
  }
  if (!r.ok) return errorResponse(r.code, r.error);
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', count: r.users.length });
  return json(200, { users: r.users });
}

// ---- the detail ----

export const ownPath = (scopeId: string, provider: string, sub: string): string => `${scopeId}#${provider}#${sub}#0`;

/** An account as the page shows it: members by key, with the sub where the wallet directory knows it. */
export type StandingAccount = ChainAccount & { members: (ChainAccount['members'][number] & { sub: string | null })[] };

export type ChainStanding =
  | {
      scopeId: string;
      ok: true;
      blockHeight: number | null;
      status: ChainIdentity['status'];
      opened: boolean;
      identityKey: string;
      /** The path this identity's logins open: its own for `own`, the root's for `member` (and `pending`, from `effectiveAtMs`). */
      path: string;
      root: { provider: string; sub: string } | null;
      effectiveAtMs: number | null;
      /** The account (root and members), or null when in none. */
      account: StandingAccount | null;
      /** In an account, but its members weren't read (the page's call budget ran out, or the read failed). */
      accountUnread?: 'not_read' | 'chain_unavailable';
    }
  | { scopeId: string; ok: false; reason: 'chain_unavailable' | 'not_read' };

/** One scope's standing, read live; never a guessed path. `subOf` names a member's sub where the wallet directory has it. */
async function standing(env: Env, budget: Budget, scopeId: string, provider: string, sub: string, subOf: (key: string) => string | null): Promise<ChainStanding> {
  if (!budget.fits(1)) return { scopeId, ok: false, reason: 'not_read' };
  budget.take();
  let id: Awaited<ReturnType<typeof getIdentity>>;
  try {
    id = await getIdentity(env.NEAR_RPC, env.SIGNER_ACCOUNT, scopeId, provider, sub);
  } catch {
    return { scopeId, ok: false, reason: 'chain_unavailable' };
  }
  const i = id.identity;
  const path = i.status === 'own' || !i.root ? ownPath(scopeId, provider, sub) : ownPath(scopeId, i.root.provider, i.root.sub);
  let account: StandingAccount | null = null;
  let accountUnread: 'not_read' | 'chain_unavailable' | undefined;
  if (i.accountEpoch > 0) {
    // In an account: its members, read live too (without them the page shows the path, marked).
    if (!budget.fits(1)) accountUnread = 'not_read';
    else {
      budget.take();
      try {
        const a = await getAccount(env.NEAR_RPC, env.SIGNER_ACCOUNT, scopeId, provider, sub);
        account = a.account ? { ...a.account, members: a.account.members.map((m) => ({ ...m, sub: subOf(m.key) })) } : null;
      } catch {
        accountUnread = 'chain_unavailable';
      }
    }
  }
  return { scopeId, ok: true, blockHeight: id.blockHeight, status: i.status, opened: i.opened, identityKey: i.key, path, root: i.root, effectiveAtMs: i.effectiveAtMs, account, ...(accountUnread ? { accountUnread } : {}) };
}

/** POST /api/users/get */
export async function usersGetRoute(c: RouteCtx): Promise<Response> {
  const route = 'POST /api/users/get';
  const { provider, sub, ticket } = c.body;
  if (typeof provider !== 'string' || !PROVIDERS.has(provider) || typeof sub !== 'string' || sub.length === 0 || sub.length > 255) return errorResponse('bad_request', 'Give provider (email or google) and sub');
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return errorResponse('bad_request', 'A support reference (ticket: 1–64 letters, digits or ._#:-) is required to open a user');
  if (!c.env.ISSUER) return unavailable(c, route);

  // One budget for the page's outbound calls (D380's rules for a request): the issuer, the API and NEAR.
  const budget = new Budget();
  const issuer = metered(c.env.ISSUER, budget);
  const api = metered(c.env.API, budget);
  const ctx = staffCtx(c.staff);

  let dir: Awaited<ReturnType<NonNullable<Env['ISSUER']>['get']>>;
  let wallets: { ok: true; users: StaffUser[] } | { ok: false; code: string };
  try {
    const [d, w] = await Promise.all([
      issuer.get({ ...staffCall(c), ticket, provider, sub }),
      api.findUsers({ ...ctx, query: sub, provider }).then(
        (r) => (r.ok ? { ok: true as const, users: r.users } : { ok: false as const, code: r.code }),
        () => ({ ok: false as const, code: 'upstream_unavailable' }),
      ),
    ]);
    dir = d;
    wallets = w;
  } catch (err) {
    return unavailable(c, route, err);
  }
  let user: DirectoryUserRow | null = null;
  let apps: DirectoryUserApp[] = [];
  let appsTruncated = false;
  if (dir.ok) {
    user = dir.user;
    apps = dir.apps;
    appsTruncated = (dir as { appsTruncated?: boolean }).appsTruncated === true;
  } else if (dir.code !== 'not_found') return directoryFailure(c, route, dir);
  // A directory miss is still a page: the wallet directory and the chain may know the identity (a login before the
  // directory, D269, or an app on no issuer env); the issuer audited the lookup either way.
  const walletUsers = wallets.ok ? wallets.users : null;

  // The identity's members by key, as the wallet directory saw them (subs of members it knows).
  const subByKey = new Map<string, string>();
  for (const u of walletUsers ?? []) for (const i of u.identities) if (i.sub !== null) subByKey.set(i.identityKey, i.sub);

  // The apps' names, orgs and environments in one AdminRpc.appNames call (the directory names apps by id only).
  const ids = apps.slice(0, DETAIL_APP_NAMES_MAX).map((a) => a.appId);
  let names: Map<string, AppNameView> | null = null;
  let namesError: string | undefined;
  if (ids.length > 0) {
    try {
      const r = await api.appNames({ ...ctx, appIds: ids });
      if (r.ok) names = new Map(r.apps.map((a) => [a.id, a]));
      else namesError = r.code;
    } catch (err) {
      namesError = err instanceof Error && err.name === 'OutOfBudget' ? 'not_read' : 'upstream_unavailable';
    }
  }
  const named = apps.map((a) => {
    const n = names?.get(a.appId);
    return { ...a, name: n?.name ?? null, orgId: n?.orgId ?? null, environment: n?.environment ?? null, deletedAt: n?.deletedAt ?? null };
  });

  // The scopes to read: the directory's apps' and the wallet directory's users', in order, at most DETAIL_CHAIN_SCOPES_MAX.
  const scopes = [...new Set([...apps.map((a) => a.scopeId), ...(walletUsers ?? []).map((u) => u.scopeId)])].sort();
  // In parallel (each read's call is taken from the budget before it starts), so a slow RPC costs one timeout, not eight.
  const chain: ChainStanding[] = await Promise.all(
    scopes.map((scopeId, k) => (k < DETAIL_CHAIN_SCOPES_MAX ? standing(c.env, budget, scopeId, provider, sub, (key) => subByKey.get(key) ?? null) : Promise.resolve({ scopeId, ok: false as const, reason: 'not_read' as const }))),
  );

  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', count: chain.length, calls: { ...budget.used } });
  return json(200, {
    provider,
    sub,
    user,
    ...(user?.unverifiedClaim ? { warning: UNVERIFIED_CLAIM_WARNING } : {}),
    apps: named,
    ...(appsTruncated ? { appsTruncated: true } : {}),
    ...(namesError ? { appNamesError: namesError } : {}),
    walletUsers,
    ...(wallets.ok ? {} : { walletError: wallets.code }),
    chain,
  });
}
