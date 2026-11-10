// GET /v1/home/devices (docs/hana-home-spec.md "Home: list and revoke", D45, D98 items 9 and 10, D411 point 6, D534): where
// a Hana Home user is signed in to their apps, and what each device may do without asking. Per scope, from D1 only (no
// chain read, no key derived):
//   - devices: the live shares under the account root's path (root.ts), one per browser profile and app session, with the
//     vault's coarse label, the partner origin, when it signed in, when it was last used and when it ends;
//   - the active auto-approve consent of each device, and the consents of apps that keep no share ('none' mode);
//   - the addresses the account shares with each app (email sharing, D411).
//
// "Active" and "live" are judged exactly as the vault's status read judges them (consent-store.ts `shareLive`,
// `consentActive`): never from `revoked_at` alone, because a 'session'-mode logout ends the share and leaves the consent's
// `revoked_at` NULL (D534).
//
// Which scopes: with `?scopeId=`, that one (an app's page in Home, the user's own or one they found); with no parameter or
// `?cursor=`, the scopes the wallet directory records for this identity, HOME_DEVICES_PAGE at a time in scope order. It
// never loops over every scope: the free plan's 10 ms CPU and 50 subrequests (D417). One D1 read for the roots and one
// D1 batch for the rows; each scope's rows are bounded.
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
import { type HomeRoot, overlayRoots, scopeRoot } from './root.ts';

export const HOME_DEVICES_ENDPOINT = '/v1/home/devices';
/** docs/hana-home-spec.md "Rate limits": the list's windows, as `GET /v1/home/apps`. */
export const HOME_DEVICES_PER_IP_MINUTE = 30;
export const HOME_DEVICES_PER_KEY_MINUTE = 60;
/** The user's own scopes in one answer (the spec allows 50: 10 keeps one batch of 40 small statements). */
export const HOME_DEVICES_PAGE = 10;
/** Live devices, and consents of apps with no share, per scope: the most recent ones, with `more` when there are others. */
export const HOME_DEVICES_PER_SCOPE = 25;
export const HOME_CONSENTS_PER_SCOPE = 25;
/** Shared addresses per scope, and apps per scope read for their names and origins. */
export const HOME_EMAILS_PER_SCOPE = 25;
export const HOME_DEVICE_APPS_PER_SCOPE = 50;

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

interface ShareRow extends ShareLiveness {
  share_id: unknown;
  app_id: string;
  device_label: string | null;
  idle_ttl_ms: number;
}

interface ConsentRow {
  consent_id: unknown;
  app_id: string;
  share_id: unknown;
  partner_origin: string;
  label: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  live_share: unknown;
  share_revoked_at: number | null;
  idle_until: number | null;
  abs_expires_at: number | null;
  created_at: number | null;
  share_origin: string | null;
  persistence: string;
  session_ttl_ms: number;
}

/** The consent's share as `consentActive` takes it: null in 'none' mode, 'gone' when its row was pruned. */
const consentShare = (c: ConsentRow): ShareLiveness | null | 'gone' =>
  c.share_id === null
    ? null
    : c.live_share === null
      ? 'gone'
      : { revoked_at: c.share_revoked_at, idle_until: c.idle_until!, abs_expires_at: c.abs_expires_at!, created_at: c.created_at!, partner_origin: c.share_origin!, persistence: c.persistence, session_ttl_ms: c.session_ttl_ms };

interface EmailRow {
  app_id: string;
  email: string;
}

/** The share's own condition of life in SQL (its origin is checked after, against the app's origins in force). */
const LIVE_SHARE = `s.revoked_at IS NULL AND ?2 < s.idle_until AND ?2 < s.abs_expires_at AND ?2 < s.created_at + a.session_ttl_ms AND a.persistence = 'session'`;

/** The four statements of one scope, in one batch with the other scopes'. */
function scopeStatements(db: D1Database, r: HomeRoot, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT a.id, a.name, a.status, a.suspended_by, a.deleted_at, sc.environment,
                (SELECT json_group_array(o.origin) FROM app_origins o WHERE o.app_id = a.id AND o.active_from <= ?2) AS origins_json
           FROM apps a JOIN scopes sc ON sc.scope_id = a.scope_id
          WHERE a.scope_id = ?1 ORDER BY (a.deleted_at IS NOT NULL), a.created_at, a.id LIMIT ?3`,
      )
      .bind(r.scopeId, now, HOME_DEVICE_APPS_PER_SCOPE),
    db
      .prepare(
        `SELECT s.share_id, s.app_id, s.partner_origin, s.device_label, s.created_at, s.idle_until, s.abs_expires_at, s.revoked_at,
                a.persistence, a.session_ttl_ms, a.idle_ttl_ms
           FROM vault_shares s JOIN apps a ON a.id = s.app_id
          WHERE s.path_hash = ?1 AND a.scope_id = ?3 AND ${LIVE_SHARE}
          ORDER BY s.created_at DESC, s.share_id LIMIT ?4`,
      )
      .bind(r.pathHash, now, r.scopeId, HOME_DEVICES_PER_SCOPE + 1),
    // A consent with its share's row, as the vault's status read joins them (consent-store.ts `consentStatus`); only
    // consents that can still be active come back, and `consentActive` then judges each by the same rule.
    db
      .prepare(
        `SELECT c.consent_id, c.app_id, c.share_id, c.partner_origin, c.label, c.granted_at, c.expires_at, c.revoked_at,
                s.share_id AS live_share, s.revoked_at AS share_revoked_at, s.idle_until, s.abs_expires_at, s.created_at, s.partner_origin AS share_origin,
                a.persistence, a.session_ttl_ms
           FROM vault_consents c JOIN apps a ON a.id = c.app_id
           LEFT JOIN vault_shares s ON s.share_id = c.share_id AND s.app_id = c.app_id
          WHERE c.path_hash = ?1 AND a.scope_id = ?3 AND c.revoked_at IS NULL AND ?2 < c.expires_at
            AND (c.share_id IS NULL OR (s.share_id IS NOT NULL AND ${LIVE_SHARE}))
          ORDER BY c.granted_at DESC, c.consent_id LIMIT ?4`,
      )
      .bind(r.pathHash, now, r.scopeId, HOME_DEVICES_PER_SCOPE + HOME_CONSENTS_PER_SCOPE + 1),
    db
      .prepare(
        `SELECT e.app_id, e.email FROM email_consents e JOIN apps a ON a.id = e.app_id
          WHERE e.user_sub = ?1 AND a.scope_id = ?2 AND e.state = 'granted' ORDER BY e.app_id, e.decided_at DESC, e.email_mac LIMIT ?3`,
      )
      .bind(r.userSub ?? '', r.scopeId, HOME_EMAILS_PER_SCOPE),
  ];
}

const id = (v: unknown): string => base64UrlEncode(blob(v));

function appStatus(a: AppRow): 'active' | 'suspended' | 'deleted' {
  if (a.deleted_at !== null) return 'deleted';
  return a.suspended_by !== 0 || a.status !== 'active' ? 'suspended' : 'active';
}

/**
 * When the share was last used, from its idle limit: an unlock or an approved signature's touch slides `idle_until` to
 * that moment plus the app's idle limit (D55). Null where that can't be told: the slide was cut short by the share's end,
 * so the last use is somewhere before. An auto-signature doesn't slide it (D539), so this is the last time the user was
 * there, not the last signature.
 */
function lastUsedAt(s: ShareRow): number | null {
  const end = Math.min(s.abs_expires_at, s.created_at + s.session_ttl_ms);
  if (s.idle_until >= end) return null;
  return Math.max(s.created_at, s.idle_until - s.idle_ttl_ms);
}

/** One scope's answer from its four result sets. */
function scopeAnswer(envName: string, r: HomeRoot, results: D1Result[], now: number) {
  const [appsRes, sharesRes, consentsRes, emailsRes] = results as [D1Result<AppRow>, D1Result<ShareRow>, D1Result<ConsentRow>, D1Result<EmailRow> | undefined];
  const apps = new Map((appsRes.results ?? []).map((a) => [a.id, a]));
  const allowed = (appId: string) => (origin: string) => {
    const a = apps.get(appId);
    return a !== undefined && parentOriginAllowed(envName, { environment: a.environment, origins: JSON.parse(a.origins_json || '[]') as string[] }, origin);
  };

  const shareRows = (sharesRes.results ?? []).filter((s) => shareLive(s, now, allowed(s.app_id)));
  const moreDevices = shareRows.length > HOME_DEVICES_PER_SCOPE;
  const shares = shareRows.slice(0, HOME_DEVICES_PER_SCOPE);
  const liveShares = new Set(shares.map((s) => id(s.share_id)));
  const consentRows = (consentsRes.results ?? []).filter((c) => consentActive(c, consentShare(c), now, allowed(c.app_id)));
  const consentOf = new Map<string, ConsentRow>();
  const noShare: ConsentRow[] = [];
  for (const c of consentRows) {
    if (c.share_id === null) noShare.push(c);
    else if (liveShares.has(id(c.share_id)) && !consentOf.has(id(c.share_id))) consentOf.set(id(c.share_id), c);
  }
  const consentJson = (c: ConsentRow) => ({ consentId: id(c.consent_id), label: c.label, grantedAtMs: c.granted_at, expiresAtMs: c.expires_at });

  const devices = shares.map((s) => {
    const c = consentOf.get(id(s.share_id));
    return {
      shareId: id(s.share_id),
      appId: s.app_id,
      partnerOrigin: s.partner_origin,
      label: s.device_label,
      signedInAtMs: s.created_at,
      lastUsedAtMs: lastUsedAt(s),
      idleUntilMs: s.idle_until,
      expiresAtMs: Math.min(s.abs_expires_at, s.created_at + s.session_ttl_ms),
      consent: c ? consentJson(c) : null,
    };
  });
  const moreConsents = noShare.length > HOME_CONSENTS_PER_SCOPE;
  const consents = noShare.slice(0, HOME_CONSENTS_PER_SCOPE).map((c) => ({ appId: c.app_id, partnerOrigin: c.partner_origin, ...consentJson(c) }));

  // Email sharing: null when this env can't tell (no IDENTITY_SUB_KEY, or no email consent table yet).
  let email: { appId: string; addresses: string[] }[] | null = null;
  if (r.userSub !== null && emailsRes) {
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
  };
}

/** Whether a D1 error is migration 0014's table missing (an env before email sharing): the email part is then unknown. */
const noEmailTable = (err: unknown): boolean => err instanceof Error && /no such table: email_consents/u.test(err.message);

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

  const read = async (withEmail: boolean): Promise<D1Result[]> =>
    env.DB.batch(roots.flatMap((r) => scopeStatements(env.DB, r, now).slice(0, withEmail ? 4 : 3)));
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

  const per = withEmail ? 4 : 3;
  const scopes = roots.map((r, i) => {
    const set = results.slice(i * per, i * per + per);
    return scopeAnswer(env.ENV_NAME, withEmail ? r : { ...r, userSub: null }, set, now);
  });
  return done(ctx, 200, { scopes, nextCursor });
}
