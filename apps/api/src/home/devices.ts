// GET /v1/home/devices (docs/hana-home-spec.md "Home: list and revoke", D45, D98 items 9 and 10, D411 point 6, D534): where
// a Hana Home user is signed in to their apps, and what each device may do without asking. Per scope, from D1 (no key
// derived):
//   - devices: the live shares under the account root's path (root.ts), one per browser profile and app session, with the
//     vault's coarse label, the partner origin, when it signed in, when it was last opened or approved there and when it
//     ends, each with its own active auto-approve consent (read by its share, so no other list's bound can hide it);
//   - the active consents of apps that keep no share ('none' mode);
//   - the addresses the account shares with each app (email sharing, D411).
//
// "Active" and "live" are judged exactly as the vault's status read judges them (consent-store.ts `shareLive`,
// `consentActive`): never from `revoked_at` alone, because a 'session'-mode logout ends the share and leaves the consent's
// `revoked_at` NULL (D534).
//
// A member-resolved root (the directory says this identity is in another root's account) is confirmed on chain first
// (D661): a stale `active` row after an unlink whose sync failed must not show a removed login the account's addresses or
// let it stop anything. Such a scope's devices are still listed (as the app list shows its addresses), but with no stop and
// no addresses until the chain confirms it; where the chain contradicts the directory, the identity's own rows are used.
//
// Which scopes: with `?scopeId=`, that one (an app's page in Home, the user's own or one they found); with no parameter or
// `?cursor=`, the scopes the wallet directory records for this identity, HOME_DEVICES_PAGE at a time in scope order. It
// never loops over every scope: the free plan's 10 ms CPU and 50 subrequests (D417). One D1 read for the roots, at most
// HOME_MEMBER_READS `get_identity` views, and one D1 batch for the rows (a second only before migration 0014).
//
// SECURITY: `(provider, sub)` comes only from `homeGate`'s verified token, and every row is read by the root's path hash or
// User ID that root.ts computes from it: nothing in the request can name another user's rows. Partner strings (app names,
// origins, the policy's label) go out as JSON data. Nothing here logs a `sub`, a path hash, an id, a label or an address.
import { base64UrlEncode } from '../bytes.ts';
import type { Env } from '../env.ts';
import { done, lap, newCtx, reject } from '../handlers.ts';
import { blob } from '../vault/shares.ts';
import { type ShareLiveness, consentActive, shareLive } from '../vault/consent-store.ts';
import { parentOriginAllowed } from '../vault/origins.ts';
import { homeGate } from './identity.ts';
import { type HomeRoot, confirmMember, overlayRoots, ownRoot, scopeRoot } from './root.ts';

export const HOME_DEVICES_ENDPOINT = '/v1/home/devices';
/** docs/hana-home-spec.md "Rate limits": the list's windows, as `GET /v1/home/apps`. */
export const HOME_DEVICES_PER_IP_MINUTE = 30;
export const HOME_DEVICES_PER_KEY_MINUTE = 60;
/** The user's own scopes in one answer (the spec allows 50: 10 keeps the batch and the chain reads small). */
export const HOME_DEVICES_PAGE = 10;
/** Live devices, and consents of apps with no share, per scope: the most recent ones, with `more` when there are others. */
export const HOME_DEVICES_PER_SCOPE = 25;
export const HOME_CONSENTS_PER_SCOPE = 25;
/** Shared addresses per scope, and the apps per scope read for their names and origins (only apps the rows name). */
export const HOME_EMAILS_PER_SCOPE = 25;
export const HOME_DEVICE_APPS_PER_SCOPE = 100;
/**
 * `get_identity` reads a request may make to confirm member-resolved roots (D661), and how many at once. With the page at
 * 10, every member scope of a page is read. Worst case, every read failing over through NEAR_RPC and its 3 fallbacks and
 * the reads stopped after the first batch with a failure: 5 + 5 × 4 = 25 fetches.
 */
export const HOME_MEMBER_READS = 10;
export const HOME_MEMBER_READ_BATCH = 5;

const SCOPE_RE = /^[a-z0-9]{1,64}$/u;

type DevicesQuery = { kind: 'first' } | { kind: 'cursor'; cursor: string } | { kind: 'scope'; scopeId: string };

/** At most one parameter: the page after a cursor, or one scope. Null when malformed. */
function parseQuery(url: URL): DevicesQuery | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return { kind: 'first' };
  if (keys.length > 1) return null;
  const key = keys[0] as string;
  const value = url.searchParams.get(key) as string;
  if (!SCOPE_RE.test(value)) return null;
  if (key === 'cursor') return { kind: 'cursor', cursor: value };
  if (key === 'scopeId') return { kind: 'scope', scopeId: value };
  return null;
}

interface AppRow {
  id: string;
  name: string;
  status: string;
  suspended_by: number;
  deleted_at: number | null;
  environment: 'test' | 'live';
  origins_json: string;
}

/** A live share with its one unrevoked consent, if any (at most one per session key: `vault_consents_one_active`). */
interface ShareRow extends ShareLiveness {
  share_id: unknown;
  app_id: string;
  device_label: string | null;
  idle_ttl_ms: number;
  consent_id: unknown;
  consent_label: string | null;
  consent_granted_at: number | null;
  consent_expires_at: number | null;
  consent_revoked_at: number | null;
}

interface TabConsentRow {
  consent_id: unknown;
  app_id: string;
  partner_origin: string;
  label: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface EmailRow {
  app_id: string;
  email: string;
}

/** The share's own condition of life in SQL (its origin is checked after, against the app's origins in force). */
const LIVE_SHARE = `s.revoked_at IS NULL AND ?2 < s.idle_until AND ?2 < s.abs_expires_at AND ?2 < s.created_at + a.session_ttl_ms AND a.persistence = 'session'`;

/**
 * The statements of one scope, in one batch with the other scopes'. `withEmail` false: an env before migration 0014, or a
 * root not confirmed on chain (D661), whose shared addresses are not read at all.
 */
function scopeStatements(db: D1Database, r: HomeRoot, now: number, withEmail: boolean): D1PreparedStatement[] {
  const emailApps = withEmail ? 'OR EXISTS (SELECT 1 FROM email_consents e WHERE e.app_id = a.id AND e.user_sub = ?4)' : '';
  const statements = [
    // The apps the rows name (names, statuses and origins in force): a device is never dropped because its app wasn't read.
    db
      .prepare(
        `SELECT a.id, a.name, a.status, a.suspended_by, a.deleted_at, sc.environment,
                (SELECT json_group_array(o.origin) FROM app_origins o WHERE o.app_id = a.id AND o.active_from <= ?2) AS origins_json
           FROM apps a JOIN scopes sc ON sc.scope_id = a.scope_id
          WHERE a.scope_id = ?1 AND (
                EXISTS (SELECT 1 FROM vault_shares s WHERE s.app_id = a.id AND s.path_hash = ?3)
             OR EXISTS (SELECT 1 FROM vault_consents c WHERE c.app_id = a.id AND c.path_hash = ?3) ${emailApps})
          ORDER BY a.id LIMIT ?5`,
      )
      .bind(r.scopeId, now, r.pathHash, r.userSub ?? '', HOME_DEVICE_APPS_PER_SCOPE),
    // Each device with its own consent, joined by its share: a device's consent is never lost to another list's bound.
    db
      .prepare(
        `SELECT s.share_id, s.app_id, s.partner_origin, s.device_label, s.created_at, s.idle_until, s.abs_expires_at, s.revoked_at,
                a.persistence, a.session_ttl_ms, a.idle_ttl_ms,
                c.consent_id, c.label AS consent_label, c.granted_at AS consent_granted_at, c.expires_at AS consent_expires_at, c.revoked_at AS consent_revoked_at
           FROM vault_shares s JOIN apps a ON a.id = s.app_id
           LEFT JOIN vault_consents c ON c.share_id = s.share_id AND c.app_id = s.app_id AND c.revoked_at IS NULL
          WHERE s.path_hash = ?1 AND a.scope_id = ?3 AND ${LIVE_SHARE}
          ORDER BY s.created_at DESC, s.share_id LIMIT ?4`,
      )
      .bind(r.pathHash, now, r.scopeId, HOME_DEVICES_PER_SCOPE + 1),
    // Consents with no share ('none' mode): active while not revoked and before their end (consentStatus's rule).
    db
      .prepare(
        `SELECT c.consent_id, c.app_id, c.partner_origin, c.label, c.granted_at, c.expires_at, c.revoked_at
           FROM vault_consents c JOIN apps a ON a.id = c.app_id
          WHERE c.path_hash = ?1 AND a.scope_id = ?3 AND c.share_id IS NULL AND c.revoked_at IS NULL AND ?2 < c.expires_at
          ORDER BY c.granted_at DESC, c.consent_id LIMIT ?4`,
      )
      .bind(r.pathHash, now, r.scopeId, HOME_CONSENTS_PER_SCOPE + 1),
  ];
  if (withEmail)
    statements.push(
      db
        .prepare(
          `SELECT e.app_id, e.email FROM email_consents e JOIN apps a ON a.id = e.app_id
            WHERE e.user_sub = ?1 AND a.scope_id = ?2 AND e.state = 'granted' ORDER BY e.app_id, e.decided_at DESC, e.email_mac LIMIT ?3`,
        )
        .bind(r.userSub ?? '', r.scopeId, HOME_EMAILS_PER_SCOPE),
    );
  return statements;
}

const id = (v: unknown): string => base64UrlEncode(blob(v));

function appStatus(a: AppRow): 'active' | 'suspended' | 'deleted' {
  if (a.deleted_at !== null) return 'deleted';
  return a.suspended_by !== 0 || a.status !== 'active' ? 'suspended' : 'active';
}

/**
 * When the device was last opened or a request approved there, from its idle limit: an unlock or an approved signature's
 * touch slides `idle_until` to that moment plus the app's idle limit (D55). Null where that can't be told: the slide was
 * cut short by the share's end. An auto-signature doesn't slide it (D539), so auto-signatures don't count. Never later
 * than now (a lowered idle limit would otherwise put it in the future).
 */
function lastUsedAt(s: ShareRow, now: number): number | null {
  const end = Math.min(s.abs_expires_at, s.created_at + s.session_ttl_ms);
  if (s.idle_until >= end) return null;
  return Math.min(now, Math.max(s.created_at, s.idle_until - s.idle_ttl_ms));
}

/** How a scope's root stands (D661): `canStop` false while a member's account couldn't be confirmed on chain. */
interface Checked {
  root: HomeRoot;
  canStop: boolean;
}

/** One scope's answer from its result sets. */
function scopeAnswer(envName: string, c: Checked, results: D1Result[], withEmail: boolean, now: number) {
  const r = c.root;
  const [appsRes, sharesRes, tabsRes, emailsRes] = results as [D1Result<AppRow>, D1Result<ShareRow>, D1Result<TabConsentRow>, D1Result<EmailRow> | undefined];
  const apps = new Map((appsRes.results ?? []).map((a) => [a.id, a]));
  // Each app's origins, parsed once.
  const origins = new Map([...apps.values()].map((a) => [a.id, { environment: a.environment, origins: JSON.parse(a.origins_json || '[]') as string[] }]));
  // An app past the read's bound can't have its origins checked: its device is shown rather than hidden.
  const allowed = (appId: string) => (origin: string) => {
    const o = origins.get(appId);
    return o === undefined || parentOriginAllowed(envName, o, origin);
  };

  const shareRows = (sharesRes.results ?? []).filter((s) => shareLive(s, now, allowed(s.app_id)));
  const moreDevices = shareRows.length > HOME_DEVICES_PER_SCOPE;
  const devices = shareRows.slice(0, HOME_DEVICES_PER_SCOPE).map((s) => {
    const active = s.consent_id !== null && consentActive({ revoked_at: s.consent_revoked_at, expires_at: s.consent_expires_at as number }, s, now, allowed(s.app_id));
    return {
      shareId: id(s.share_id),
      appId: s.app_id,
      partnerOrigin: s.partner_origin,
      label: s.device_label,
      signedInAtMs: s.created_at,
      lastUsedAtMs: lastUsedAt(s, now),
      idleUntilMs: s.idle_until,
      expiresAtMs: Math.min(s.abs_expires_at, s.created_at + s.session_ttl_ms),
      consent: active ? { consentId: id(s.consent_id), label: s.consent_label as string, grantedAtMs: s.consent_granted_at as number, expiresAtMs: s.consent_expires_at as number } : null,
    };
  });
  const tabRows = (tabsRes.results ?? []).filter((t) => consentActive(t, null, now, () => true));
  const moreConsents = tabRows.length > HOME_CONSENTS_PER_SCOPE;
  const consents = tabRows
    .slice(0, HOME_CONSENTS_PER_SCOPE)
    .map((t) => ({ consentId: id(t.consent_id), appId: t.app_id, partnerOrigin: t.partner_origin, label: t.label, grantedAtMs: t.granted_at, expiresAtMs: t.expires_at }));

  // Email sharing: null when this env can't tell (no IDENTITY_SUB_KEY, no migration 0014) or the account wasn't confirmed
  // on chain (D661): a stale directory row never shows anyone the account's addresses.
  let email: { appId: string; addresses: string[] }[] | null = null;
  if (withEmail && r.userSub !== null && emailsRes) {
    const by = new Map<string, string[]>();
    for (const e of emailsRes.results ?? []) by.set(e.app_id, [...(by.get(e.app_id) ?? []), e.email]);
    email = [...by].map(([appId, addresses]) => ({ appId, addresses }));
  }

  // The apps the answer names, with the names the page shows (partner strings, as data).
  const named = new Set([...devices.map((x) => x.appId), ...consents.map((x) => x.appId), ...(email ?? []).map((x) => x.appId)]);
  return {
    scopeId: r.scopeId,
    apps: [...apps.values()].filter((a) => named.has(a.id)).map((a) => ({ appId: a.id, name: a.name, status: appStatus(a) })),
    devices,
    consents,
    email,
    more: moreDevices || moreConsents,
    canStop: c.canStop,
  };
}

/** Whether a D1 error is migration 0014's table missing (an env before email sharing): the email part is then unknown. */
const noEmailTable = (err: unknown): boolean => err instanceof Error && /no such table: email_consents/u.test(err.message);

/**
 * Confirms the member-resolved roots on chain (D661): at most HOME_MEMBER_READS, HOME_MEMBER_READ_BATCH at once, stopping
 * after the first batch with a failure (a failing endpoint multiplies a read by the fallbacks). A root the chain
 * contradicts becomes the identity's own; one not confirmed keeps its devices listed but offers no stop and no addresses.
 */
async function checkRoots(env: Env, roots: HomeRoot[], who: { provider: string; sub: string }): Promise<Checked[]> {
  const out: Checked[] = roots.map((root) => ({ root, canStop: !root.member }));
  const todo = out.filter((c) => c.root.member).slice(0, HOME_MEMBER_READS);
  for (let i = 0; i < todo.length; i += HOME_MEMBER_READ_BATCH) {
    const batch = todo.slice(i, i + HOME_MEMBER_READ_BATCH);
    const results = await Promise.allSettled(batch.map((c) => confirmMember(env, c.root, who)));
    let failed = false;
    for (const [n, res] of results.entries()) {
      const c = batch[n] as Checked;
      if (res.status === 'rejected') failed = true;
      else if (res.value) c.canStop = true;
      else {
        c.root = await ownRoot(env, c.root.scopeId, who);
        c.canStop = true;
      }
    }
    if (failed) break;
  }
  return out;
}

export async function handleHomeDevices(request: Request, env: Env, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_DEVICES_ENDPOINT, request);
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_DEVICES_PER_IP_MINUTE, keyPerMinute: HOME_DEVICES_PER_KEY_MINUTE, window: 'devices' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');

  const query = parseQuery(new URL(request.url));
  if (!query) return reject(ctx, 400, 'bad_request', 'Give at most one of cursor or scopeId');

  let roots: HomeRoot[];
  let nextCursor: string | null = null;
  try {
    if (query.kind === 'scope') roots = [await scopeRoot(env, query.scopeId, gate.identity)];
    else {
      roots = await overlayRoots(env.DB, gate.identity, query.kind === 'cursor' ? query.cursor : null, HOME_DEVICES_PAGE);
      if (roots.length > HOME_DEVICES_PAGE) {
        roots = roots.slice(0, HOME_DEVICES_PAGE);
        nextCursor = (roots.at(-1) as HomeRoot).scopeId;
      }
    }
  } catch {
    return reject(ctx, 503, 'home_directory_unavailable', 'The devices list is unavailable, try again');
  }
  lap(ctx, 'roots');
  if (roots.length === 0) return done(ctx, 200, { scopes: [], nextCursor: null });

  const checked = await checkRoots(env, roots, gate.identity);
  lap(ctx, 'chain');

  // One batch, which D1 counts as one query against its per-invocation limit whatever its statement count; a second only
  // before migration 0014, without the email statements.
  const read = (withEmail: boolean): Promise<D1Result[]> => env.DB.batch(checked.flatMap((c) => scopeStatements(env.DB, c.root, now, withEmail && c.canStop)));
  let results: D1Result[];
  let withEmail = true;
  try {
    try {
      results = await read(true);
    } catch (err) {
      if (!noEmailTable(err)) throw err;
      withEmail = false;
      results = await read(false);
    }
  } catch {
    return reject(ctx, 503, 'home_directory_unavailable', 'The devices list is unavailable, try again');
  }
  lap(ctx, 'rows');

  let at = 0;
  const scopes = checked.map((c) => {
    const withRows = withEmail && c.canStop;
    const n = withRows ? 4 : 3;
    const set = results.slice(at, at + n);
    at += n;
    return scopeAnswer(env.ENV_NAME, c, set, withRows, now);
  });
  return done(ctx, 200, { scopes, nextCursor });
}
