// The other apps that use this app's wallet (D912), as the vault reads them from its own GET /v1/app (`otherApps`, sent
// to the vault's origin only) and hands them to its windows: the sign-in popup's auth-params and the approval popup's
// requests, both posted to the auth origin only. Never in anything the vault sends the partner page (the port, events,
// errors): the partner page must not learn which other apps share its users' wallets.
import { OTHER_APPS_COUNT_MAX, OTHER_APPS_NAMES_MAX, type OtherApps, isOtherApps } from '@hana-id/core';
import { homeAppName } from '../auth/app-name.ts';

/**
 * How long a request's approval window waits, once, for a read of the other apps when the vault has none yet (a request
 * right after the page loaded, before its first GET /v1/app answered): then it goes with what is known, or without the
 * line. The window is never blocked or failed by it.
 */
export const OTHER_APPS_WAIT_MS = 3_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The API's `otherApps` as the vault keeps it, with each name cut as Passport Home shows it (an unsafe one replaced by
 * Journear's words), or null for no answer: absent (another API, a failed read) or of any other shape. `count` 0: the
 * app is alone on its scope.
 */
export function readServedOtherApps(v: unknown): OtherApps | null {
  if (!isObj(v) || Object.keys(v).length !== 2 || !Array.isArray(v.names)) return null;
  const count = v.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > OTHER_APPS_COUNT_MAX) return null;
  if (count === 0) return v.names.length === 0 ? { count: 0, names: [] } : null;
  if (v.names.length !== Math.min(count as number, OTHER_APPS_NAMES_MAX)) return null;
  const out: OtherApps = { count: count as number, names: v.names.map(homeAppName) };
  return isOtherApps(out) ? out : null;
}

/** A window message's `otherApps`: a copy, only when other apps share the wallet, so an app alone sends the older message. */
export function otherAppsField(o: OtherApps | null | undefined): { otherApps?: OtherApps } {
  return o && o.count > 0 && isOtherApps(o) ? { otherApps: { count: o.count, names: [...o.names] } } : {};
}

/**
 * What a window gets (after PR 141's review): the apps when other apps share the wallet; `otherAppsUnknown` when the vault
 * has no answer at all (none read, none kept), so the window says the wallet may be shared rather than nothing; nothing
 * when the vault knows the app is alone.
 */
export function windowOtherApps(o: OtherApps | 'unknown' | null | undefined): { otherApps?: OtherApps; otherAppsUnknown?: true } {
  if (o === 'unknown') return { otherAppsUnknown: true };
  return otherAppsField(o);
}

// ---- kept in the vault origin's own storage ----
//
// The last answer for this app, so a new tab (or a vault whose reads are refused or late) starts out knowing. It lives in
// the vault frame's localStorage: the vault origin's, in the partner site's partition, which the partner page can't read
// or write (another origin). One entry per app, under its id, overwritten by each answer the vault reads; an entry is
// used only while younger than OTHER_APPS_KEPT_MS (by the time it was read, on the vault's server-corrected clock) and is
// deleted once older or unreadable. A count of 0 (the app alone) is kept too. A fresh read always replaces it.

/** How long a kept answer is used without a newer read (after PR 141's review; decided while building, to confirm). */
export const OTHER_APPS_KEPT_MS = 7 * 24 * 3_600_000;
export const OTHER_APPS_KEY_PREFIX = 'hana.other-apps.';

/** The parts of Storage the vault uses (window.localStorage in the browser, null when the browser refuses it). */
export interface KeptStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The kept answer for `appId`, or null (none, older than OTHER_APPS_KEPT_MS, from the future, unreadable: then removed). */
export function readKeptOtherApps(store: KeptStore | null | undefined, appId: string, now: number): { apps: OtherApps; at: number } | null {
  if (!store) return null;
  const key = OTHER_APPS_KEY_PREFIX + appId;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    let v: unknown = null;
    try {
      v = JSON.parse(raw);
    } catch {
      // Unreadable: removed below.
    }
    const at = isObj(v) && v.v === 1 && Number.isSafeInteger(v.at) ? (v.at as number) : null;
    const apps = at !== null && isObj(v) ? readServedOtherApps({ count: v.count, names: v.names }) : null;
    if (at === null || !apps || now - at >= OTHER_APPS_KEPT_MS || at > now + 60_000) {
      store.removeItem(key);
      return null;
    }
    return { apps, at };
  } catch {
    return null;
  }
}

/** Keeps `apps` (read at `at`) for `appId`; a store that refuses it changes nothing. */
export function keepOtherApps(store: KeptStore | null | undefined, appId: string, apps: OtherApps, at: number): void {
  if (!store) return;
  try {
    store.setItem(OTHER_APPS_KEY_PREFIX + appId, JSON.stringify({ v: 1, count: apps.count, names: apps.names, at: Math.floor(at) }));
  } catch {
    // A full or blocked store: the next tab reads the API, as before.
  }
}
