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
