// `GET {authOrigin}/home/callback` (D491): Google's redirect target for Hana Home's exit client, and that client's only
// authorized redirect URI. Hana Home's sign-in child (`/login?mode=home`) sends Google here only when Hana Home named the
// exit client: for its own sign-in when no shared Google client is in force, and to open the wallet of an app whose
// own sign-in route is gone (D490). Like `/login/callback` for a plain login, it reads the fragment and clears it at
// once, takes the relay key the child stored for this `state` (single use), encrypts Google's answer under it, writes it
// to the relay, and closes; Hana Home reads the slot. Nothing else: no follow-up legs, no email scope, no vault.
//
// What it takes (and what it never relays):
// - a `state` whose entry the child stored for the exit client (`exit`, with the client and the nonce): a plain login's
//   entry is never used here, and `/login/callback` never uses an exit entry;
// - an ID token whose `aud` is that client and whose `nonce` is that nonce, read unverified (Hana Home verifies the
//   token against Google's keys before using it, and the API again): anything else is relayed as `invalid_response`;
// - an ID token with a claim outside the allow-list is never relayed (`token_has_pii`), as on `/login/callback`;
// - a window opened by a page this page can't vouch for: an opener on another origin, or on this origin away from
//   Hana Home, stops it with nothing relayed. A missing opener is accepted, because Google's own pages may cut it.
//
// SECURITY: the fragment holds the ID token. It is cleared from the URL before anything else, never logged, stored or
// shown, and dropped once encrypted; the relay key is zeroed after use.
import { RELAY_CLAIM_NAME, type RelayPayload, disallowedClaim, encryptRelayPayload } from '@hana-id/core';
import type { AuthApi } from './api.ts';
import { dom, errorView } from './dom.ts';
import { parseCallbackFragment, unverifiedClaims } from './google.ts';
import { takeLogin, zeroTaken } from './login-storage.ts';
import { type PageWindow, isFramed } from './page-window.ts';

/** Hana Home's page: the only opener this page takes, when it can read one. */
export const HOME_OPENER_PATH = '/home';

export interface HomeCallbackDeps {
  win: PageWindow;
  /** This page's origin (env.authOrigin): Hana Home's too. */
  authOrigin: string;
  api: Pick<AuthApi, 'writeRelay'>;
  now?: () => number;
}

export type HomeCallbackOutcome =
  /** Relayed (a token, or Google's error) and closed. */
  | 'relayed'
  /** No state, an unknown, reused or plain-login state, a framed page or an opener it can't vouch for: nothing posted. */
  | 'refused'
  /** The relay refused the write or the network failed; the window stays open. */
  | 'relay_failed';

/** Whether this window's opener is one this page takes: none (Google may cut it), or this origin's Hana Home. */
function openerOk(win: PageWindow, authOrigin: string): boolean {
  const opener = win.opener as Window | null;
  if (!opener) return true;
  try {
    return opener.location.origin === authOrigin && opener.location.pathname === HOME_OPENER_PATH;
  } catch {
    // Another origin's window: its address can't be read.
    return false;
  }
}

const STOP = 'Sign-in stopped';

export async function runHomeCallbackPage(deps: HomeCallbackDeps): Promise<HomeCallbackOutcome> {
  const { win } = deps;
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
    d.show(errorView(d, STOP, 'The Journear Passport sign-in window can’t run inside another page.'));
    return 'refused';
  }
  if (!openerOk(win, deps.authOrigin)) {
    d.show(errorView(d, STOP, 'This sign-in window wasn’t opened by Passport Home. Close it and sign in again from Passport Home.'));
    return 'refused';
  }
  if (fragment.kind === 'no_state') {
    d.show(errorView(d, STOP, 'Google’s answer did not belong to a sign-in started in Passport Home. Close this window and sign in again from Passport Home.'));
    return 'refused';
  }
  const taken = takeLogin(win.sessionStorage, fragment.state, now());
  // Only the exit client's entry, with its client and nonce: a plain login's (or a parked one's) is never relayed here.
  if (!taken || !taken.exit || !taken.clientId || !taken.nonce || taken.cancelled || taken.followKey) {
    if (taken) zeroTaken(taken);
    d.show(errorView(d, STOP, 'This sign-in has expired or was already used. Close this window and sign in again from Passport Home.'));
    return 'refused';
  }

  let payload: RelayPayload;
  if (fragment.kind === 'error') payload = { error: fragment.error };
  else if (fragment.kind !== 'token') payload = { error: 'invalid_response' };
  else {
    const claims = unverifiedClaims(fragment.idToken);
    const claim = claims ? disallowedClaim(claims) : null;
    if (claim !== null) payload = { error: 'token_has_pii', ...(RELAY_CLAIM_NAME.test(claim) ? { claim } : {}) };
    else if (!claims || claims.aud !== taken.clientId || claims.nonce !== taken.nonce) payload = { error: 'invalid_response' };
    else payload = { idToken: fragment.idToken };
  }
  try {
    const value = await encryptRelayPayload(taken.relayKey, fragment.state, payload).catch(() => encryptRelayPayload(taken.relayKey, fragment.state, { error: 'invalid_response' }));
    await deps.api.writeRelay(fragment.state, value);
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === 'string' ? ((err as { code: string }).code) : 'api_unavailable';
    d.show(errorView(d, 'Sign-in could not finish', code === 'relay_used' ? 'This sign-in was already completed. Close this window.' : 'Journear could not be reached to finish the sign-in. Close this window and sign in again from Passport Home.', code));
    return 'relay_failed';
  } finally {
    zeroTaken(taken);
  }
  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signed in'), d.h('p', { class: 'muted' }, 'You can close this window.')));
  try {
    win.close();
  } catch {
    // The text above says what to do.
  }
  return 'relayed';
}
