// `GET {authOrigin}/login/callback` (docs/batch-b-spec.md "Login" step 6): Google's redirect target. It reads the
// fragment and clears it at once, takes the relayKey that /login stored for this `state` (single use), encrypts
// Google's answer under it and writes it to the relay, then closes. The vault (or the export window) reads the slot
// with its read key; the API stores only ciphertext.
//
// SECURITY: the fragment holds a Google ID token. It is cleared from the URL before anything else, never logged,
// stored or shown, and dropped once encrypted; relayKey is zeroed after use.
import { ApiError, type RelayPayload, encryptRelayPayload } from '@hana-id/core';
import type { AuthApi } from './api.ts';
import { dom, errorView } from './dom.ts';
import { parseCallbackFragment } from './google.ts';
import { takeLogin } from './login-storage.ts';
import { type PageWindow, isFramed } from './page-window.ts';

export interface CallbackPageDeps {
  win: PageWindow;
  api: AuthApi;
  now?: () => number;
  /** Monotonic ms on this page's clock (performance.now), for a pk_test_ app's timings. */
  perfNow?: () => number;
  /** This page's navigation timing (ms on its clock), for a pk_test_ app's timings; null when the browser has none. */
  navigation?: () => CallbackNavigation | null;
}

/** The parts of this page's PerformanceNavigationTiming the timings use. */
export interface CallbackNavigation {
  fetchStart: number;
  responseEnd: number;
}

function browserNavigation(): CallbackNavigation | null {
  const nav = typeof performance === 'undefined' ? undefined : (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined);
  return nav ? { fetchStart: nav.fetchStart, responseEnd: nav.responseEnd } : null;
}

/**
 * A pk_test_ app's popup timings (timings.ts LOGIN_TIMING_STAGES), each a duration on this page's clock, whose origin
 * is the navigation that brought Google's answer here: `callbackRedirect` (Google's redirect hops before this page was
 * fetched), `callbackFetch` (the auth page Worker's answer: DNS, TLS, the Worker, the HTML), `callbackBoot` (parsing
 * and loading this page's script), `callbackPrep` (taking the relay key and encrypting, up to the relay POST).
 */
export function callbackTimings(nav: CallbackNavigation | null, scriptStart: number, postAt: number): Record<string, number> {
  const out: Record<string, number> = { callbackPrep: Math.max(0, postAt - scriptStart) };
  if (nav && nav.responseEnd > 0 && nav.responseEnd >= nav.fetchStart) {
    out.callbackRedirect = Math.max(0, nav.fetchStart);
    out.callbackFetch = nav.responseEnd - nav.fetchStart;
    out.callbackBoot = Math.max(0, scriptStart - nav.responseEnd);
  }
  return out;
}

export type CallbackOutcome =
  /** Relayed and closed. */
  | 'relayed'
  /** No state, an unknown or reused state, or a framed page: nothing was posted. */
  | 'refused'
  /** The relay refused the write (409 `relay_used`, …) or the network failed; the window stays open. */
  | 'relay_failed';

export async function runCallbackPage(deps: CallbackPageDeps): Promise<CallbackOutcome> {
  const { win, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  const scriptStart = perfNow();
  const d = dom(win.document);
  // First: read the fragment and drop it from the URL and history entry.
  const fragment = parseCallbackFragment(win.location.hash);
  try {
    win.history.replaceState(null, '', win.location.pathname);
  } catch {
    // Nothing else to do; the page continues and never shows the URL.
  }

  if (isFramed(win)) {
    d.show(errorView(d, 'Sign-in stopped', 'The Hana sign-in window can’t run inside another page.'));
    return 'refused';
  }
  if (fragment.kind === 'no_state') {
    d.show(errorView(d, 'Sign-in stopped', 'Google’s answer did not belong to a sign-in started here. Start again from the app.'));
    return 'refused';
  }
  const taken = takeLogin(win.sessionStorage, fragment.state, now());
  if (!taken) {
    d.show(errorView(d, 'Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.'));
    return 'refused';
  }

  const { relayKey } = taken;
  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Finishing sign-in…')));
  let payload: RelayPayload | null =
    fragment.kind === 'token' ? { idToken: fragment.idToken } : fragment.kind === 'error' ? { error: fragment.error } : { error: 'invalid_response' };
  // A pk_test_ app's login (/login stored its timings): this page's stages ride in the encrypted slot to the vault.
  // `callbackPrep` ends just before the POST; encrypting takes well under a millisecond.
  const timings = (): Record<string, number> | undefined =>
    taken.timings ? { ...taken.timings, ...callbackTimings((deps.navigation ?? browserNavigation)(), scriptStart, perfNow()) } : undefined;
  try {
    let value;
    try {
      const t = timings();
      value = await encryptRelayPayload(relayKey, fragment.state, t ? { ...payload, timings: t } : payload);
    } catch {
      // A token the relay format can't carry (over 4 KiB): tell the vault Google's answer was unusable.
      value = await encryptRelayPayload(relayKey, fragment.state, { error: 'invalid_response' });
    }
    payload = null;
    await api.writeRelay(fragment.state, value);
  } catch (err) {
    const used = err instanceof ApiError && err.code === 'relay_used';
    d.show(
      errorView(
        d,
        'Sign-in could not finish',
        used ? 'This sign-in was already completed. Close this window.' : 'Hana could not be reached to finish the sign-in. Close this window and try again from the app.',
        err instanceof ApiError ? err.code : 'api_unavailable',
      ),
    );
    return 'relay_failed';
  } finally {
    payload = null;
    relayKey.fill(0);
  }
  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signed in'), d.h('p', { class: 'muted' }, 'You can close this window.')));
  win.close();
  return 'relayed';
}
