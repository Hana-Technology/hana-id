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
import { takeLoginEntry } from './login-storage.ts';
import { type PageWindow, isFramed } from './page-window.ts';

export interface CallbackPageDeps {
  win: PageWindow;
  api: AuthApi;
  now?: () => number;
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
  const relayKey = takeLoginEntry(win.sessionStorage, fragment.state, now());
  if (!relayKey) {
    d.show(errorView(d, 'Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.'));
    return 'refused';
  }

  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Finishing sign-in…')));
  let payload: RelayPayload | null =
    fragment.kind === 'token' ? { idToken: fragment.idToken } : fragment.kind === 'error' ? { error: fragment.error } : { error: 'invalid_response' };
  try {
    let value;
    try {
      value = await encryptRelayPayload(relayKey, fragment.state, payload);
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
