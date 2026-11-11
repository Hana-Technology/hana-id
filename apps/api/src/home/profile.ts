// Hana Home: the user's own name, and the apps it is shared with (D714, migration 0019). Both parts are optional.
//
//   GET  /v1/home/profile[?appId=app_…]  the name this identity set, the apps it shares it with (newest first, at most
//                                        HOME_NAME_SHARES_MAX), and with `appId` whether the account shares a name with
//                                        that app (whichever of its sign-in identities shared it)
//   POST /v1/home/profile       {givenName, familyName}  set, change or remove the name (both null or empty: removed,
//                                                         and every share of this identity's name ends with it)
//   POST /v1/home/name-sharing  {appId, share}           start or stop sharing the name with one app
//
// The name belongs to the sign-in identity Home is signed in as (`home_profiles` keyed by `(provider, sub)`, as the wallet
// directory keys identities). A share is per app × account: keyed by the account's User ID in the app's scope (root.ts,
// the rule every Home list and stop uses), so the app's identity tokens (identity/name.ts) and its console find it by the
// token's `sub`. A share holds no copy of the name: an edit reaches every app at its next token, a removal ends them all.
//
// Off by default: nothing is shared until the user turns it on for an app. A share can only be made for an app Home lists
// to anyone (not deleted, and has had a login: `first_login_at`, D462), and only once a name is set. A member-resolved
// root is confirmed on chain before any write and before the app's state is read (D661): a stale directory row must not
// let a removed login share or stop anything for its former account.
//
// SECURITY: `(provider, sub)` comes only from `homeGate`'s verified token, and every row is read or written by it or by
// the User ID root.ts computes from it: nothing in a request can name another user's rows. Names go out as JSON data and
// are display-safe by construction (`normalizeProfileName`). Nothing here logs a name, an app id, a `sub` or a User ID.
import { normalizeProfileName } from '@hana-id/core/identity';
import type { Env } from '../env.ts';
import { type Ctx, done, lap, newCtx, reject } from '../handlers.ts';
import { LIVE_NAME_SHARE, type ProfileName, noNameTables, storedName } from '../identity/name.ts';
import { homeGate } from './identity.ts';
import { type HomeRoot, confirmedRoot, scopeRoot } from './root.ts';

export const HOME_PROFILE_ENDPOINT = '/v1/home/profile';
export const HOME_NAME_SHARING_ENDPOINT = '/v1/home/name-sharing';
/** The read's windows, as `GET /v1/home/devices`; the two writes share one window per IP and one per Home key. */
export const HOME_PROFILE_PER_IP_MINUTE = 30;
export const HOME_PROFILE_PER_KEY_MINUTE = 60;
export const HOME_PROFILE_WRITE_PER_IP_MINUTE = 30;
export const HOME_PROFILE_WRITE_PER_KEY_MINUTE = 30;
/** The apps a name is shared with, in one answer (`more` when there are others). */
export const HOME_NAME_SHARES_MAX = 100;

const APP_RE = /^app_[A-Za-z0-9_-]{1,64}$/u;

type Who = { provider: string; sub: string };

const unavailable = (ctx: Ctx): Response => reject(ctx, 503, 'home_directory_unavailable', 'Could not reach the records, try again');
/** Before migration 0019: names can't be stored in this environment yet. */
const notYet = (ctx: Ctx): Response => reject(ctx, 503, 'profile_unavailable', 'Names are unavailable in this environment');
const noName = (ctx: Ctx): Response => reject(ctx, 409, 'no_profile_name', 'Set a name first');
const chainDown = (ctx: Ctx): Response => reject(ctx, 503, 'near_unavailable', 'Could not confirm the account on NEAR, try again', { 'retry-after': '2' });

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const exactly = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

async function profileOf(db: D1Database, who: Who): Promise<ProfileName | null> {
  return storedName(await db.prepare('SELECT given_name, family_name FROM home_profiles WHERE provider = ?1 AND sub = ?2').bind(who.provider, who.sub).first());
}

/** A root that may be read or written for: an own root as it is; a member's once the chain confirms it (D661). Null: the chain didn't answer. */
async function confirmed(env: Env, ctx: Ctx, r: HomeRoot, who: Who): Promise<HomeRoot | null> {
  if (!r.member) return r;
  try {
    const out = await confirmedRoot(env, r, who);
    lap(ctx, 'chain');
    return out;
  } catch {
    return null;
  }
}

/** An app a share may name: not deleted, and listed by Home (it has had a login). Null otherwise. */
async function shareableApp(db: D1Database, appId: string): Promise<{ scopeId: string } | null> {
  const r = await db.prepare('SELECT scope_id FROM apps WHERE id = ?1 AND deleted_at IS NULL AND first_login_at IS NOT NULL').bind(appId).first<{ scope_id: string }>();
  return r ? { scopeId: r.scope_id } : null;
}

// ---- GET /v1/home/profile ----

export async function handleHomeProfileGet(request: Request, env: Env, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_PROFILE_ENDPOINT, request);
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_PROFILE_PER_IP_MINUTE, keyPerMinute: HOME_PROFILE_PER_KEY_MINUTE, window: 'profile' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  const appId = params.get('appId');
  if (keys.length > 1 || (keys.length === 1 && (keys[0] !== 'appId' || appId === null || !APP_RE.test(appId)))) return reject(ctx, 400, 'bad_request', 'Give at most appId');
  const who = gate.identity;

  try {
    // The app's state first: it may need the chain (a member's account), and is null for an app Home doesn't list.
    let app: { appId: string; shared: boolean } | null = null;
    if (appId !== null) {
      const a = await shareableApp(env.DB, appId);
      if (a) {
        const root = await confirmed(env, ctx, await scopeRoot(env, a.scopeId, who), who);
        if (!root) return chainDown(ctx);
        const hit = root.userSub === null ? null : await env.DB.prepare(`SELECT 1 AS hit FROM name_shares n WHERE n.app_id = ?1 AND n.user_sub = ?2 AND ${LIVE_NAME_SHARE('?3')}`).bind(appId, root.userSub, now).first();
        app = { appId, shared: hit !== null };
      }
    }
    const [profile, shares] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare('SELECT given_name, family_name FROM home_profiles WHERE provider = ?1 AND sub = ?2').bind(who.provider, who.sub),
      env.DB.prepare(
        `SELECT n.app_id, a.name, a.scope_id, n.shared_at FROM name_shares n JOIN apps a ON a.id = n.app_id
          WHERE n.provider = ?1 AND n.sub = ?2 AND a.deleted_at IS NULL AND ${LIVE_NAME_SHARE('?4')} ORDER BY n.shared_at DESC, n.app_id LIMIT ?3`,
      ).bind(who.provider, who.sub, HOME_NAME_SHARES_MAX + 1, now),
    ]);
    lap(ctx, 'rows');
    const name = storedName((profile?.results[0] as { given_name: string | null; family_name: string | null } | undefined) ?? null);
    const rows = (shares?.results ?? []) as { app_id: string; name: string; scope_id: string; shared_at: number }[];
    return done(ctx, 200, {
      name,
      // A share without a name shares nothing; the list says so by being empty.
      shares: name === null ? [] : rows.slice(0, HOME_NAME_SHARES_MAX).map((r) => ({ appId: r.app_id, name: r.name, scopeId: r.scope_id, sharedAtMs: r.shared_at })),
      more: name !== null && rows.length > HOME_NAME_SHARES_MAX,
      app: app && { ...app, shared: name !== null && app.shared },
    });
  } catch (err) {
    return noNameTables(err) ? notYet(ctx) : unavailable(ctx);
  }
}

// ---- POST /v1/home/profile ----

export async function handleHomeProfileSet(request: Request, env: Env, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_PROFILE_ENDPOINT, request);
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_PROFILE_WRITE_PER_IP_MINUTE, keyPerMinute: HOME_PROFILE_WRITE_PER_KEY_MINUTE, window: 'profile-write' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');
  const o = parseJson(gate.body);
  if (!o || !exactly(o, ['givenName', 'familyName'])) return reject(ctx, 400, 'bad_request', 'Body must be {givenName, familyName}');
  const givenName = normalizeProfileName(o.givenName);
  const familyName = normalizeProfileName(o.familyName);
  if (givenName === undefined || familyName === undefined) return reject(ctx, 400, 'bad_name', 'Each name is at most 50 characters, on one line, with no hidden characters');
  const who = gate.identity;
  try {
    if (givenName === null && familyName === null) {
      // Removed: the profile, and every share of it in the same batch (a share without a name would share nothing, and
      // must not start sharing again by itself when a new name is set).
      const [, gone] = await env.DB.batch([
        env.DB.prepare('DELETE FROM home_profiles WHERE provider = ?1 AND sub = ?2').bind(who.provider, who.sub),
        env.DB.prepare('DELETE FROM name_shares WHERE provider = ?1 AND sub = ?2').bind(who.provider, who.sub),
      ]);
      return done(ctx, 200, { name: null, stopped: gone?.meta.changes ?? 0 });
    }
    await env.DB.prepare(
      `INSERT INTO home_profiles (provider, sub, given_name, family_name, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (provider, sub) DO UPDATE SET given_name = excluded.given_name, family_name = excluded.family_name, updated_at = excluded.updated_at`,
    )
      .bind(who.provider, who.sub, givenName, familyName, now)
      .run();
    return done(ctx, 200, { name: { givenName, familyName } });
  } catch (err) {
    return noNameTables(err) ? notYet(ctx) : unavailable(ctx);
  }
}

// ---- POST /v1/home/name-sharing ----

export async function handleHomeNameSharing(request: Request, env: Env, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_NAME_SHARING_ENDPOINT, request);
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_PROFILE_WRITE_PER_IP_MINUTE, keyPerMinute: HOME_PROFILE_WRITE_PER_KEY_MINUTE, window: 'profile-write' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');
  const o = parseJson(gate.body);
  if (!o || !exactly(o, ['appId', 'share']) || typeof o.appId !== 'string' || !APP_RE.test(o.appId) || typeof o.share !== 'boolean') return reject(ctx, 400, 'bad_request', 'Body must be {appId, share: boolean}');
  const appId = o.appId;
  const who = gate.identity;
  try {
    const app = await shareableApp(env.DB, appId);
    if (!app) return reject(ctx, 404, 'unknown_app', 'Unknown app');
    if (o.share && !(await profileOf(env.DB, who))) return noName(ctx);
    const root = await confirmed(env, ctx, await scopeRoot(env, app.scopeId, who), who);
    if (!root) return chainDown(ctx);
    if (root.userSub === null) return reject(ctx, 503, 'name_sharing_unavailable', 'Name sharing is unavailable in this environment');
    lap(ctx, 'row');
    if (!o.share) {
      // Any identity of the account may stop the account's share, whichever of them made it.
      const res = await env.DB.prepare('DELETE FROM name_shares WHERE app_id = ?1 AND user_sub = ?2').bind(appId, root.userSub).run();
      return done(ctx, 200, { shared: false, stopped: res.meta.changes });
    }
    // One share per app × account: sharing again (or from another identity of the account) names this identity's name.
    // Written only while the name exists, in the same statement, so a removal racing this can't leave a share behind.
    const res = await env.DB.prepare(
      `INSERT INTO name_shares (app_id, user_sub, provider, sub, via, shared_at)
       SELECT ?1, ?2, ?3, ?4, ?6, ?5 WHERE EXISTS (SELECT 1 FROM home_profiles WHERE provider = ?3 AND sub = ?4)
       ON CONFLICT (app_id, user_sub) DO UPDATE SET provider = excluded.provider, sub = excluded.sub, via = excluded.via, shared_at = excluded.shared_at`,
    )
      .bind(appId, root.userSub, who.provider, who.sub, now, root.member ? 'member' : 'own')
      .run();
    if (res.meta.changes === 0) return noName(ctx);
    return done(ctx, 200, { shared: true });
  } catch (err) {
    return noNameTables(err) ? notYet(ctx) : unavailable(ctx);
  }
}
