// The partner Users screen (D310; docs/batch-c-spec.md "Users and Support ID" → "What partners never see"): an org's
// end users across its own scopes, with the user id, the Support ID, when the user was first and last seen, the kinds of
// account connected ("google", "email") and the wallet addresses. Never an email address, a Google `sub`, an identity
// key or any other identity detail: the API's ConsoleRpc answers partner views only (the wallet directory, D315), and
// the console re-shapes every row through the allowlist below before it answers, so a field the API adds later (or a
// bug there) can't reach a partner's screen. The shape is the data contract the tests pin, not just what the UI renders.
//
// Behind `USERS_SCREEN` (off by default; D357): the ConsoleRpc reads (`listUsers`, `getUser`) are the wallet
// directory's (D310, D315) with D346's User ID (`userId` = the identity token's `sub`, `u1_…`; `supportId` its short
// form; the internal `hu_…` id never reaches a partner). Until the flag is on in an env, the routes are 404 and the tab
// is hidden: turn it on once that env's API runs D346.
import {
  type ConsoleGetUserInput,
  type ConsoleListUsersInput,
  type PartnerUser,
  type RpcFail,
  type RpcOk,
  USER_CURSOR_RE as CORE_CURSOR_RE,
  USER_ID_RE as CORE_USER_ID_RE,
} from '@hana-id/console-core';
import type { Env } from './env.ts';
import { errorResponse, json } from './http.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';

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
  wallets: { chain: 'stellar' | 'evm'; address: string; firstSeenAt: number; lastUsedAt: number }[];
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
/** The API's page cursor (console-core's pattern), passed back as given. */
export const USER_CURSOR_RE = CORE_CURSOR_RE;
const KINDS = new Set(['google', 'email', 'apple']);

const time = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * One user as a partner may see it, rebuilt field by field from the API's answer, or null when the row doesn't have
 * the expected form (dropped and logged, never passed through). An account is its kind only; a wallet is a chain, an
 * address of that chain's form and two times.
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
    if (x.chain === 'stellar' && STELLAR_RE.test(x.address)) wallets.push({ chain: 'stellar', address: x.address, firstSeenAt: first, lastUsedAt: last });
    else if (x.chain === 'evm' && EVM_RE.test(x.address)) wallets.push({ chain: 'evm', address: x.address, firstSeenAt: first, lastUsedAt: last });
    else return null;
  }
  return { userId: r.userId, supportId: r.supportId, scopeId: r.scopeId, createdAt, lastSeenAt, accounts, wallets };
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
