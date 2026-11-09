// D411's `at_login`: the login popup ends on the email sharing sheet instead of closing. /login marks the login (its
// relayId) when the vault's auth-params say `emailShare`; the page that would close the window at the end of the
// sign-in (the callback after its relay, the email step's follow-up mode on the vault's last word) takes the mark and
// goes to `/share-email?from=login` in the same window instead, where the vault shows the sheet if this user hasn't
// answered it yet (or tells the window to close).
//
// The mark is public (no secret: a relayId and a time), lives in sessionStorage beside the login's entry, and is
// deleted when taken or after LOGIN_ENTRY_MAX_AGE_MS.
import { RELAY_ID_PATTERN } from '@hana-id/core';
import { LOGIN_ENTRY_MAX_AGE_MS } from './login-storage.ts';

export const SHARE_PATH = '/share-email';
export const SHARE_MARK_PREFIX = 'hana.share.';

/** Marks the login `relayId` as ending on the sheet (best effort: a storage failure just closes the window as before). */
export function markEmailShare(storage: Storage, relayId: string, now: number): void {
  if (!RELAY_ID_PATTERN.test(relayId)) return;
  try {
    storage.setItem(`${SHARE_MARK_PREFIX}${relayId}`, String(now));
  } catch {
    // The sheet is never mandatory: without the mark the window closes and the user is asked at the next login.
  }
}

/** Whether the login `relayId` ends on the sheet; the mark is deleted either way. */
export function takeEmailShare(storage: Storage, relayId: string, now: number): boolean {
  if (!RELAY_ID_PATTERN.test(relayId)) return false;
  const key = `${SHARE_MARK_PREFIX}${relayId}`;
  try {
    const v = storage.getItem(key);
    storage.removeItem(key);
    const at = v === null ? Number.NaN : Number(v);
    return Number.isSafeInteger(at) && now - at >= 0 && now - at < LOGIN_ENTRY_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** The end of a sign-in in the popup: the sheet when the login is marked, else the window closes. */
export function closeOrShare(win: { sessionStorage: Storage; close(): void; location: { assign(url: string): void } }, relayId: string, now: number): void {
  if (takeEmailShare(win.sessionStorage, relayId, now)) win.location.assign(`${SHARE_PATH}?from=login`);
  else win.close();
}
