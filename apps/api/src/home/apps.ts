// GET /v1/home/apps (docs/hana-home-spec.md "Discovery", D462, D466, D500-D503): the apps Home can show a signed-in user.
// Two reads, no chain transaction and no key derived:
//   - the list: every scope with `scopes.first_session_at` set and an app that has had a login (`apps.first_login_at`,
//     D462), with those apps in D1, suspended and deleted included, which survives the wallet directory's purge (30 days
//     after a scope's apps are all deleted). A scope's own users see all of its apps, marked or not;
//   - the overlay: the directory rows of this identity's `(provider, sub)` (D466), which mark a scope `mine` and give
//     its Support ID and addresses. A linked member's row points at its account, so it gets the account root's wallet.
//
// SECURITY: `(provider, sub)` comes only from `homeGate`'s verified token, and every per-user value (`mine`, `supportId`,
// `addresses`) is read by it: nothing in the request can name another user. Only a row the directory records as `active`
// counts (D466): an unlinked or cancelled identity, or a link still in its delay, sees none of the account's rows, and a
// link past its delay counts once the member's login writes `active`. Partner-controlled strings (names, origins, logos)
// go out as JSON data. Nothing here logs `sub`, a token, an address or a path hash.
//
// The free plan's 10 ms CPU and 50 subrequests (D417) bound everything: at most HOME_MINE_MAX own rows and HOME_LIST_PAGE
// listed rows, the per-scope `get_scope` reads capped at HOME_SCOPE_READS a request and stopped at the first failure (a
// failing endpoint can multiply a read by the fallbacks). A row with no read answers `coverage: 'unknown'`; the page asks
// for it by `?scopeId=` (a quiet scope by `?appId=`, D502). Coverage is display only: `POST /v1/home/login` (H3) and the contract check it again.
import { formatSupportId } from '@hana-id/console-core';
import { HotDb } from '../changes/db.ts';
import { type Q, join, q, raw } from '../changes/sql.ts';
import { logoUrl } from '../changes/views.ts';
import type { Env } from '../env.ts';
import { done, ipKey, lap, limiter, newCtx, reject } from '../handlers.ts';
import { isDevEnv } from '../origins.ts';
import { type ConfigView, type ScopeView, cachedHomeScope, getConfig, readHomeScope } from '../views.ts';
import { type HomeCoverage, homeCoverage } from './coverage.ts';
import { homeGate } from './identity.ts';
import { HOME_APPS_ALL_MAX, HOME_APPS_PER_SCOPE } from '@hana-id/core/home';

export const HOME_APPS_ENDPOINT = '/v1/home/apps';
/** docs/hana-home-spec.md "Rate limits". */
export const HOME_APPS_PER_IP_MINUTE = 30;
export const HOME_APPS_PER_KEY_MINUTE = 60;
/** A search scans `apps`: its own, tighter window per Home key (D500). */
export const HOME_SEARCH_PER_KEY_MINUTE = 10;
/** The user's own scopes in one answer, and the listed scopes of one page. */
export const HOME_MINE_MAX = 30;
export const HOME_LIST_PAGE = 15;
/** `get_scope` reads a request may make; what the isolate has cached (at most about 70 s, D500) doesn't count. */
export const HOME_SCOPE_READS = 16;
/** Reads at once, so a failure stops the rest of them. */
const HOME_READ_BATCH = 5;
/**
 * A scope's apps in every answer (a list page, a search, one scope by `scopeId` or `appId`), and in the explicit full
 * answer (`&all=1` with `scopeId` or `appId`, which Home sends only for "Show all apps"); one number with the page's
 * parser (@hana-id/core/home). Every scope says how many apps it has (`appsTotal`) and how many of them are open
 * (`appsOpen`), so Home never hides one without saying so (D922). The full answer reads about three times the rows a
 * list answer does for a scope of 100 apps (each app's origins), so it has its own, tighter windows.
 */
export { HOME_APPS_PER_SCOPE, HOME_APPS_ALL_MAX } from '@hana-id/core/home';
export const HOME_ORIGINS_PER_APP = 5;
/** The full answer's windows (D922's review): per Home key and per IP, a minute each, apart from the list's. */
export const HOME_APPS_ALL_PER_KEY_MINUTE = 6;
export const HOME_APPS_ALL_PER_IP_MINUTE = 12;
/** A search term, in characters, after trimming. */
export const HOME_SEARCH_MIN = 2;
export const HOME_SEARCH_MAX = 64;

const MINUTE = 60_000;
const SCOPE_RE = /^[a-z0-9]{1,64}$/u;
const APP_RE = /^app_[A-Za-z0-9_-]{1,64}$/u;

type HomeQuery = { kind: 'first' } | { kind: 'cursor'; cursor: string } | { kind: 'search'; term: string } | { kind: 'scope'; scopeId: string; all: boolean } | { kind: 'app'; appId: string; all: boolean };

/**
 * At most one parameter: the page after a cursor, a search, or one scope or app (the partner's link); and `all=1` beside
 * `scopeId` or `appId` only, for every app of it (D922). Null when malformed.
 */
function parseQuery(url: URL): HomeQuery | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return { kind: 'first' };
  const all = keys.length === 2 && keys[1] === 'all' && url.searchParams.getAll('all').length === 1 && url.searchParams.get('all') === '1';
  if (keys.length > 2 || (keys.length === 2 && !all)) return null;
  const key = keys[0] as string;
  if (all && key !== 'scopeId' && key !== 'appId') return null;
  const value = url.searchParams.get(key) as string;
  switch (key) {
    case 'cursor':
      return SCOPE_RE.test(value) ? { kind: 'cursor', cursor: value } : null;
    case 'q': {
      const term = value.trim();
      const length = [...term].length;
      return length >= HOME_SEARCH_MIN && length <= HOME_SEARCH_MAX ? { kind: 'search', term } : null;
    }
    case 'scopeId':
      return SCOPE_RE.test(value) ? { kind: 'scope', scopeId: value, all } : null;
    case 'appId':
      return APP_RE.test(value) ? { kind: 'app', appId: value, all } : null;
    default:
      return null;
  }
}

interface OverlayEntry {
  supportCode: string;
  addresses: { chain: string; address: string }[];
}

interface OverlayRow {
  scope_id: string;
  support_code: string;
  wallets_json: string;
}

/**
 * This identity's directory rows, newest first (D466): identities of its account only, and only rows recorded `active`.
 * A `pending` row past its `effective_at` stays out: a cancel's directory sync is best effort, so the row alone can't say
 * the link wasn't cancelled. A matured member's next login writes `active` (`syncAfterLogin`). Addresses at `key_index`
 * 0, the only ones Home derives.
 */
async function readOverlay(db: HotDb, provider: string, sub: string): Promise<Map<string, OverlayEntry>> {
  const rows = await db.all<OverlayRow>(
    q`SELECT i.scope_id, u.support_code,
        (SELECT json_group_array(json_object('chain', w.chain, 'address', w.address)) FROM end_user_wallets w WHERE w.user_id = i.user_id AND w.key_index = 0) AS wallets_json
        FROM end_user_identities i JOIN end_users u ON u.user_id = i.user_id
       WHERE i.sub = ${sub} AND i.provider = ${provider} AND i.status = 'active'
       ORDER BY u.last_seen_at DESC, i.scope_id LIMIT ${HOME_MINE_MAX}`,
  );
  const out = new Map<string, OverlayEntry>();
  for (const r of rows) {
    // Stellar, EVM, then NEAR (D755; an older Home page leaves out a chain it doesn't know).
    const rank = (c: string): number => ({ stellar: 0, evm: 1, near: 2 })[c] ?? 9;
    const addresses = (JSON.parse(r.wallets_json || '[]') as { chain: string; address: string }[]).sort((a, b) => (a.chain === b.chain ? (a.address < b.address ? -1 : 1) : rank(a.chain) - rank(b.chain)));
    out.set(r.scope_id, { supportCode: r.support_code, addresses });
  }
  return out;
}

interface AppJson {
  id: string;
  name: string;
  status: string;
  suspended_by: number;
  deleted_at: number | null;
  logo_key: string | null;
  google_web_client_id: string | null;
  origins: string[];
}

interface ScopeRow {
  scope_id: string;
  environment: 'test' | 'live';
  /** The scope's mark (D915): several partners' apps share this wallet, and the scope's owner can see which of them a person used (D925). */
  app_user_ids: number | null;
  /** Up to one more app than the answer's limit (scopeColumns). */
  apps_json: string;
  held_json: string;
}

/**
 * Live apps first, then deleted ones, one more than `appsLimit` (the extra one says there are more: it is never sent);
 * origins in force, at most HOME_ORIGINS_PER_APP each, never one the app may use only inside a frame (D934: Home's
 * "where it runs" and its cancel button name a page to open, and such a web address opened on its own is refused). `allApps`: true for the user's own scopes (the marker may have
 * failed to write, and the directory is per scope, so it can't say which app they used); otherwise only apps with a
 * first login. A scope with no more apps than the limit is counted from what this read; only a scope with more is
 * counted, by `countApps` (D922's review: a count in this statement read every app row of every scope again).
 */
const scopeColumns = (now: number, allApps: Q, appsLimit: number): Q =>
  q`s.scope_id, s.environment, s.app_user_ids,
    (SELECT json_group_array(json_object('id', a.id, 'name', a.name, 'status', a.status, 'suspended_by', a.suspended_by, 'deleted_at', a.deleted_at,
        'logo_key', a.logo_key, 'google_web_client_id', a.google_web_client_id,
        'origins', json((SELECT json_group_array(o.origin) FROM (SELECT origin FROM app_origins WHERE app_id = a.id AND active_from <= ${now} AND frame_only = 0 ORDER BY origin LIMIT ${HOME_ORIGINS_PER_APP}) o))))
       FROM (SELECT x.* FROM apps x WHERE x.scope_id = s.scope_id AND (x.first_login_at IS NOT NULL OR ${allApps}) ORDER BY (x.deleted_at IS NOT NULL), x.created_at, x.id LIMIT ${appsLimit + 1}) a) AS apps_json,
    (SELECT json_group_array(h.aud) FROM hana_held_clients h WHERE h.scope_id = s.scope_id AND h.provider = 'google') AS held_json`;

/** Open: not deleted and not suspended (any bit, or the legacy status), as D912 counts the apps that can still ask. */
const isOpen = (a: Pick<AppJson, 'deleted_at' | 'suspended_by' | 'status'>): boolean => a.deleted_at === null && a.suspended_by === 0 && a.status === 'active';

/**
 * How many apps each of these scopes has by the listing's rule, and how many are open: one statement, only for the
 * scopes whose read came back over its limit (through the scope index; a row per app of those scopes).
 */
async function countApps(db: HotDb, scopeIds: readonly string[], mine: readonly string[]): Promise<Map<string, { total: number; open: number }>> {
  const out = new Map<string, { total: number; open: number }>();
  if (scopeIds.length === 0) return out;
  const isMine = mine.length > 0 ? q`x.scope_id IN (${join(mine.map((id) => q`${id}`), ', ')})` : raw('0');
  const rows = await db.all<{ scope_id: string; total: number; open: number }>(
    q`SELECT x.scope_id, COUNT(*) AS total, SUM(CASE WHEN x.deleted_at IS NULL AND x.suspended_by = 0 AND x.status = 'active' THEN 1 ELSE 0 END) AS open
        FROM apps x WHERE x.scope_id IN (${join(scopeIds.map((id) => q`${id}`), ', ')}) AND (x.first_login_at IS NOT NULL OR ${isMine})
       GROUP BY x.scope_id`,
  );
  for (const r of rows) out.set(r.scope_id, { total: Number(r.total), open: Number(r.open) });
  return out;
}

/** Test apps only in dev envs (D98 item 8). */
const environmentFilter = (env: Env): Q => (isDevEnv(env.ENV_NAME) ? raw('1') : raw("s.environment = 'live'"));

/** `LIKE`'s wildcards in a user's term, as data. */
const likeTerm = (term: string): string => `%${term.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

/** The statement that picks this request's listed rows (D462); the quieter listing is D502's. */
function listingQuery(query: Exclude<HomeQuery, { kind: 'first' }> | null, env: Env, now: number, mine: readonly string[]): Q {
  const isMine = mine.length > 0 ? q`s.scope_id IN (${join(mine.map((id) => q`${id}`), ', ')})` : raw('0');
  // Only the explicit full answer (`all`) carries up to HOME_APPS_ALL_MAX apps; every other, HOME_APPS_PER_SCOPE a scope
  // (each read one more, to know whether there are more).
  const all = (query?.kind === 'scope' || query?.kind === 'app') && query.all;
  const select = q`SELECT ${scopeColumns(now, isMine, all ? HOME_APPS_ALL_MAX : HOME_APPS_PER_SCOPE)} FROM scopes s WHERE ${environmentFilter(env)}`;
  // A scope a stranger may see: one app has had a login (D462).
  const launched = raw('EXISTS (SELECT 1 FROM apps x WHERE x.scope_id = s.scope_id AND x.first_login_at IS NOT NULL)');
  // Scope ids are sequential, so a quiet scope isn't found by one (D502): its link names an app id, which can't be walked.
  if (query?.kind === 'scope') return q`${select} AND s.scope_id = ${query.scopeId} AND (${isMine} OR (s.first_session_at IS NOT NULL AND s.home_quiet = 0 AND ${launched}))`;
  // A link to an app with no login answers nothing to a stranger, as the list would. (A stranger can derive a key in any
  // registered scope through Home, D527, but that writes no directory row, so it doesn't make them one of its users.)
  if (query?.kind === 'app') return q`${select} AND s.scope_id = (SELECT scope_id FROM apps WHERE id = ${query.appId}) AND (${isMine} OR (s.first_session_at IS NOT NULL AND EXISTS (SELECT 1 FROM apps x WHERE x.id = ${query.appId} AND x.first_login_at IS NOT NULL)))`;
  if (query?.kind === 'search') {
    // A listed scope by any part of an app's name; a quiet one only by an app's whole name, so a search can't enumerate them.
    return q`${select} AND s.first_session_at IS NOT NULL AND EXISTS (SELECT 1 FROM apps a WHERE a.scope_id = s.scope_id AND (a.first_login_at IS NOT NULL OR ${isMine})
        AND ((s.home_quiet = 0 AND a.name LIKE ${likeTerm(query.term)} ESCAPE '\\') OR a.name = ${query.term} COLLATE NOCASE))
      ORDER BY s.scope_id LIMIT ${HOME_LIST_PAGE}`;
  }
  const after = query?.kind === 'cursor' ? q` AND s.scope_id > ${query.cursor}` : raw('');
  return q`${select} AND s.first_session_at IS NOT NULL AND s.home_quiet = 0 AND ${launched}${after} ORDER BY s.scope_id LIMIT ${HOME_LIST_PAGE + 1}`;
}

/** The chain's scopes for the rows in order, spending at most HOME_SCOPE_READS and stopping at a failed read. */
async function readScopes(env: Env, scopeIds: readonly string[]): Promise<Map<string, ScopeView | null>> {
  const views = new Map<string, ScopeView | null>();
  const misses: string[] = [];
  for (const id of scopeIds) {
    const cached = cachedHomeScope(id);
    if (cached === undefined) misses.push(id);
    else views.set(id, cached);
  }
  const todo = misses.slice(0, HOME_SCOPE_READS);
  for (let i = 0; i < todo.length; i += HOME_READ_BATCH) {
    const batch = todo.slice(i, i + HOME_READ_BATCH);
    const results = await Promise.allSettled(batch.map((id) => readHomeScope(env, id)));
    let failed = false;
    results.forEach((r, n) => {
      if (r.status === 'fulfilled') views.set(batch[n] as string, r.value);
      else failed = true;
    });
    if (failed) break;
  }
  return views;
}

function appStatus(a: AppJson): 'active' | 'suspended' | 'deleted' {
  if (a.deleted_at !== null) return 'deleted';
  return a.suspended_by !== 0 || a.status !== 'active' ? 'suspended' : 'active';
}

export async function handleHomeApps(request: Request, env: Env, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_APPS_ENDPOINT, request);
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_APPS_PER_IP_MINUTE, keyPerMinute: HOME_APPS_PER_KEY_MINUTE, window: 'apps' }, now);
  if (!gate.ok) return gate.response;
  const { provider, sub, keyHash } = gate.identity;
  lap(ctx, 'identity');

  const query = parseQuery(new URL(request.url));
  if (!query) return reject(ctx, 400, 'bad_request', 'Give at most one of cursor, q (2 to 64 characters), scopeId or appId (and all=1 with scopeId or appId)');
  if (query.kind === 'search') {
    try {
      const hit = await limiter(env, `home-key:${keyHash}`).hit([{ name: 'home:apps:search:key', windowMs: MINUTE, max: HOME_SEARCH_PER_KEY_MINUTE }], now);
      if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (searches per Home key per minute)', { 'retry-after': String(hit.retryAfterS) });
    } catch {
      return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
    }
  }
  // The full answer (D922's review): its own windows per Home key and per IP, apart from the list's, so the larger read
  // can't be asked for at the list's rate.
  if ((query.kind === 'scope' || query.kind === 'app') && query.all) {
    try {
      const byKey = await limiter(env, `home-key:${keyHash}`).hit([{ name: 'home:apps:all:key', windowMs: MINUTE, max: HOME_APPS_ALL_PER_KEY_MINUTE }], now);
      if (!byKey.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (full app lists per Home key per minute)', { 'retry-after': String(byKey.retryAfterS) });
      const byIp = await limiter(env, ipKey(request)).hit([{ name: 'home:apps:all:ip', windowMs: MINUTE, max: HOME_APPS_ALL_PER_IP_MINUTE }], now);
      if (!byIp.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (full app lists per IP per minute)', { 'retry-after': String(byIp.retryAfterS) });
    } catch {
      return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
    }
  }

  let config: ConfigView;
  try {
    config = await getConfig(env);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the Home clients');
  }

  let overlay: Map<string, OverlayEntry>;
  let rows: ScopeRow[];
  let counts: Map<string, { total: number; open: number }>;
  let nextCursor: string | null = null;
  const appsLimit = (query.kind === 'scope' || query.kind === 'app') && query.all ? HOME_APPS_ALL_MAX : HOME_APPS_PER_SCOPE;
  try {
    const db = new HotDb(env.DB);
    overlay = await readOverlay(db, provider, sub);
    const mine = [...overlay.keys()];
    const statements: Q[] = [listingQuery(query.kind === 'first' ? null : query, env, now, mine)];
    if (query.kind === 'first' && mine.length > 0) statements.push(q`SELECT ${scopeColumns(now, raw('1'), HOME_APPS_PER_SCOPE)} FROM scopes s WHERE ${environmentFilter(env)} AND s.scope_id IN (${join(mine.map((id) => q`${id}`), ', ')})`);
    const [listed, own] = await db.batch(statements);
    let listedRows = (listed?.results ?? []) as unknown as ScopeRow[];
    if (query.kind === 'first' || query.kind === 'cursor') {
      if (listedRows.length > HOME_LIST_PAGE) {
        listedRows = listedRows.slice(0, HOME_LIST_PAGE);
        nextCursor = (listedRows.at(-1) as ScopeRow).scope_id;
      }
      // The first answer already carried the user's own; a page never repeats them.
      listedRows = listedRows.filter((r) => !mine.includes(r.scope_id));
    }
    const ownRows = ((own?.results ?? []) as unknown as ScopeRow[]).sort((a, b) => mine.indexOf(a.scope_id) - mine.indexOf(b.scope_id));
    rows = [...ownRows, ...listedRows];
    // Only a scope that came back over its limit is counted (one statement for all of them).
    counts = await countApps(db, rows.filter((r) => (JSON.parse(r.apps_json || '[]') as unknown[]).length > appsLimit).map((r) => r.scope_id), mine);
  } catch {
    return reject(ctx, 503, 'home_directory_unavailable', 'The app list is unavailable, try again');
  }
  lap(ctx, 'directory');

  const views = await readScopes(env, rows.map((r) => r.scope_id));
  lap(ctx, 'chain');

  const scopes = rows.map((r) => {
    const read = JSON.parse(r.apps_json || '[]') as AppJson[];
    const apps = read.slice(0, appsLimit);
    const counted = read.length > appsLimit ? counts.get(r.scope_id) : undefined;
    const total = Math.max(counted?.total ?? apps.length, apps.length);
    const open = Math.min(counted?.open ?? apps.filter(isOpen).length, total);
    const view = views.get(r.scope_id);
    const route: { coverage: HomeCoverage | 'unknown'; googleClientId: string | null } =
      view === undefined
        ? { coverage: 'unknown', googleClientId: null }
        : homeCoverage({
            provider,
            scope: view,
            config,
            heldClients: JSON.parse(r.held_json || '[]') as string[],
            // The first HOME_APPS_PER_SCOPE live apps, as every answer has them, so the full answer's route is the list's (D922's review).
            preferredClients: apps
              .filter((a) => a.deleted_at === null)
              .slice(0, HOME_APPS_PER_SCOPE)
              .flatMap((a) => (a.google_web_client_id ? [a.google_web_client_id] : [])),
            now,
          });
    const entry = overlay.get(r.scope_id);
    return {
      scopeId: r.scope_id,
      mine: entry !== undefined,
      coverage: route.coverage,
      googleClientId: route.googleClientId,
      // D913 question 10, D925: on the person's own wallet only (PR 153's review), whether the scope is marked: Home tells
      // them that the scope's owner can see which of its apps they use, and labels its Support ID as Journear's.
      ...(entry ? { supportId: formatSupportId(entry.supportCode), addresses: entry.addresses, sharedScope: r.app_user_ids === 1 } : {}),
      apps: apps.map((a) => ({ appId: a.id, name: a.name, status: appStatus(a), environment: r.environment, origins: a.origins, logoUrl: logoUrl(env.FILES_ORIGIN, a.logo_key) ?? null })),
      // How many apps the scope has by the same rule, and how many of them are open, so a page can say "and N more" and
      // whether some have closed (D922).
      appsTotal: total,
      appsOpen: open,
    };
  });

  return done(ctx, 200, { scopes, nextCursor });
}
