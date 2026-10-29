// An in-isolate cache of `getAppByKey` for the vault endpoints (`/v1/vault/*`, vault/endpoints.ts), so a reload's
// unlock doesn't pay two D1 queries before its rate limits (docs/decisions.md D78).
//
// Staleness bound: an entry is used for at most APP_CACHE_TTL_MS after the D1 read that filled it, per isolate. Nothing
// in the Worker writes `apps` or `app_origins` (operators change them with the admin CLI, straight in D1), so there is no
// event to invalidate on: an app suspended, a publishable key removed or changed, an origin removed, a scope conflict
// or a plan change reaches the vault endpoints within APP_CACHE_TTL_MS. Unknown keys are never cached (a new app works
// at once, and made-up keys can't fill the cache). The relay endpoints, GET /v1/app and the vault page don't use it:
// they read D1 on every request, so a suspension stops logins (gas) and new vault loads at once.
//
// Keyed by the publishable key itself: it is a public identifier (shipped in partner pages), not a secret.
import { type App, getAppByKey } from './apps.ts';

/** How long one D1 read of an app serves the vault endpoints in this isolate. */
export const APP_CACHE_TTL_MS = 30_000;
/** At most this many apps per isolate; the oldest entry goes first. */
export const APP_CACHE_MAX = 256;

interface Entry {
  app: App;
  at: number;
}

const entries = new Map<string, Entry>();

/**
 * The app behind `publishableKey`, from this isolate's cache when the entry is younger than APP_CACHE_TTL_MS (and not
 * from the future: a clock that went back refetches), else from D1. Throws what getAppByKey throws (nothing cached).
 */
export async function getAppByKeyCached(db: D1Database, publishableKey: string, now: () => number = Date.now): Promise<App | null> {
  const hit = entries.get(publishableKey);
  const t = now();
  if (hit && t >= hit.at && t - hit.at < APP_CACHE_TTL_MS) return hit.app;
  entries.delete(publishableKey);
  const app = await getAppByKey(db, publishableKey);
  if (!app) return null;
  const frozen: App = Object.freeze({ ...app, origins: Object.freeze([...app.origins]) as string[] });
  if (entries.size >= APP_CACHE_MAX) entries.delete(entries.keys().next().value as string);
  // Stamped with the time the read started: the entry never outlives TTL from what D1 could have answered.
  entries.set(publishableKey, { app: frozen, at: t });
  return frozen;
}

/** Drops every cached app (tests that change an app in D1 mid-test). */
export function forgetCachedApps(): void {
  entries.clear();
}

/** How many apps are cached (tests). */
export const cachedAppCount = (): number => entries.size;
