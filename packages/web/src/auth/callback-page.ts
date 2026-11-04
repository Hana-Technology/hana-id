// `GET {authOrigin}/login/callback` (docs/batch-b-spec.md "Login" step 6): Google's redirect target. It reads the
// fragment and clears it at once, takes the relayKey that /login stored for this `state` (single use), encrypts
// Google's answer under it and writes it to the relay, then closes. The vault (or the export window) reads the slot
// with its read key; the API stores only ciphertext.
//
// Linking (build plan batch 8b), in a login of an app with email (the entry carries the follow-up key):
// - two-request mode (auth/google.ts): after relaying the login's token (`access: 'follow'`), it makes the second,
//   silent Google request for the `email` scope, and that answer (`#access_token`) comes back here to follow-up
//   slot 1 (asked once more without `prompt=none` when Google needs the user);
// - one-request mode: the access token rides beside the token;
// - case B's "Link and continue" (the email step stored it): the token carries `caseB {linkTicket, emailSub}` (D139);
// - a proof the vault asked for (a link method's, `leg: 'proof'`) goes to its own follow-up slot;
// then, instead of closing, the window goes to /login/email's follow-up mode, which reads the vault's next notice
// (google-match's screens, link banners, the vault's last word).
//
// SECURITY: the fragment holds a Google ID token (and maybe an access token). It is cleared from the URL before
// anything else, never logged, stored or shown, and dropped once encrypted; relayKey and followKey are zeroed after
// use, or stored again (sessionStorage, 10 min) only for the next leg.
import { ApiError, type RelayPayload, encryptRelayPayload, followSlot } from '@hana-id/core';
import type { AuthApi } from './api.ts';
import { dom, errorView } from './dom.ts';
import { type CallbackFragment, GOOGLE_EMAIL_FLOW, SILENT_ERRORS, googleAccessUrl, parseCallbackFragment, unverifiedSub } from './google.ts';
import { type TakenLogin, storeLoginEntry, takeLogin, zeroTaken } from './login-storage.ts';
import { type PageWindow, isFramed } from './page-window.ts';

export interface CallbackPageDeps {
  win: PageWindow;
  api: AuthApi;
  /** This page's origin (env.authOrigin): the redirect URI of a second Google request. */
  authOrigin?: string;
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
  | 'relay_failed'
  /** Google needs the user for its email permission: this window explains it and waits for a click (D264). */
  | 'confirm';

/** Where a login of an app with email goes once a leg is relayed (batch 8b): the email step's follow-up mode. */
export const FOLLOW_PATH = '/login/email';

export async function runCallbackPage(deps: CallbackPageDeps): Promise<CallbackOutcome> {
  const { win, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  /** Google's redirect URI for a second request: this page's own origin (the env's authOrigin). */
  const authOrigin = deps.authOrigin ?? (typeof location === 'undefined' ? '' : location.origin);
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

  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Finishing sign-in…')));
  // Batch 8b: a login of an app with email (its entry has the follow-up key) has more legs than one.
  const followKey = taken.followKey ?? null;
  const home = taken.home ?? fragment.state;
  // The second request's silent attempt needed the user: ask once more, interactively (auth/google.ts), after a
  // screen that says what Google is about to ask and why (D264, G-M2).
  if (followKey && taken.leg === 'access' && fragment.kind === 'error' && SILENT_ERRORS.has(fragment.error) && !taken.interactive && taken.clientId && taken.loginHint) {
    const state = fragment.state;
    try {
      storeLoginEntry(win.sessionStorage, state, taken.relayKey, now(), undefined, { followKey, home, next: taken.next ?? 2, leg: 'access', clientId: taken.clientId, loginHint: taken.loginHint, interactive: true });
    } catch {
      // No storage for the next leg: the vault hears why (G-L2), and this window says so.
      return relayLeg(deps, { kind: 'error', state, error: 'storage_unavailable' }, taken, scriptStart);
    }
    const url = googleAccessUrl({ clientId: taken.clientId, authOrigin, state, loginHint: taken.loginHint, silent: false });
    zeroTaken(taken);
    explainEmailPrompt(d, {
      // A click, so Google's page loads as the user's own navigation.
      onContinue: () => win.location.assign(url),
      // "Not now": the same as declining on Google's screen, for the vault's consent screen (D264).
      onSkip: () => {
        const again = takeLogin(win.sessionStorage, state, now());
        if (!again) {
          d.show(errorView(d, 'Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.'));
          return;
        }
        void relayLeg(deps, { kind: 'error', state, error: 'access_denied' }, again, perfNow());
      },
    });
    return 'confirm';
  }
  return relayLeg(deps, fragment, taken, scriptStart);
}

/** What the explainer before Google's email prompt says (D264, G-M2). */
export const EMAIL_PROMPT_TEXT =
  'Google will now ask to share your email address with Hana. Hana uses it to find a wallet you may already have with that address and keeps it with your account. It doesn’t share it with the app you’re signing in to.';

function explainEmailPrompt(d: ReturnType<typeof dom>, on: { onContinue: () => void; onSkip: () => void }): void {
  const go = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'email-prompt-continue' } }, 'Continue');
  const skip = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-prompt-skip' } }, 'Not now');
  go.addEventListener('click', () => {
    go.setAttribute('disabled', '');
    skip.setAttribute('disabled', '');
    on.onContinue();
  });
  skip.addEventListener('click', () => {
    go.setAttribute('disabled', '');
    skip.setAttribute('disabled', '');
    on.onSkip();
  });
  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'One more step with Google'), d.h('p', { attrs: { id: 'email-prompt-text' } }, EMAIL_PROMPT_TEXT), d.h('div', { class: 'actions' }, skip, go)));
}

/** Relays one leg's answer to its slot (`fragment.state`), then goes on: the next leg, the follow-up mode, or closes. */
async function relayLeg(deps: CallbackPageDeps, fragment: Exclude<CallbackFragment, { kind: 'no_state' }>, taken: TakenLogin, scriptStart: number): Promise<CallbackOutcome> {
  const { win, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  const authOrigin = deps.authOrigin ?? (typeof location === 'undefined' ? '' : location.origin);
  const d = dom(win.document);
  const { relayKey } = taken;
  const followKey = taken.followKey ?? null;
  const home = taken.home ?? fragment.state;
  let payload: RelayPayload | null = payloadFor(fragment, taken);
  // Two-request mode: the login's own token says an access token follows, in slot 1 (never with a link task's proof).
  const accessLeg = !!followKey && !taken.leg && !taken.task && fragment.kind === 'token' && GOOGLE_EMAIL_FLOW === 'second_request' && taken.clientId ? unverifiedSub(fragment.idToken) : null;
  if (accessLeg && payload && 'idToken' in payload) payload = { ...payload, access: 'follow' };
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
      // A token the relay format can't carry: tell the vault Google's answer was unusable.
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
    zeroTaken(taken);
    return 'relay_failed';
  } finally {
    payload = null;
  }
  if (fragment.kind === 'error' && fragment.error === 'storage_unavailable') {
    zeroTaken(taken);
    d.show(errorView(d, 'Sign-in stopped', STORAGE_TEXT, 'storage_unavailable'));
    return 'relay_failed';
  }
  if (followKey) {
    try {
      if (accessLeg) {
        // The second, silent request for the email scope: its answer goes to follow-up slot 1.
        const slot = followSlot(followKey, 1).id;
        try {
          storeLoginEntry(win.sessionStorage, slot, relayKey, now(), undefined, { followKey, home, next: 2, leg: 'access', clientId: taken.clientId as string, loginHint: accessLeg });
        } catch {
          // The vault waits on slot 1: it hears why instead of waiting for the login's limit (G-L2).
          await tellStorageFailed(api, relayKey, slot);
          d.show(errorView(d, 'Sign-in stopped', STORAGE_TEXT, 'storage_unavailable'));
          return 'relay_failed';
        }
        win.location.assign(googleAccessUrl({ clientId: taken.clientId as string, authOrigin, state: slot, loginHint: accessLeg, silent: true }));
        return 'relayed';
      }
      // The vault's next notice, read by the email step's follow-up mode (it shows google-match's screens and banners).
      const next = taken.next ?? 2;
      try {
        storeLoginEntry(win.sessionStorage, home, relayKey, now(), undefined, { followKey, home, next });
      } catch {
        // The follow-up mode can't start: a screen the vault may show next would wait for nobody, so its answer slot
        // says why now (the vault ends the login with storage_unavailable if it asks).
        await tellStorageFailed(api, relayKey, followSlot(followKey, next + 1).id);
        d.show(errorView(d, 'Sign-in stopped', STORAGE_TEXT, 'storage_unavailable'));
        return 'relay_failed';
      }
    } finally {
      zeroTaken(taken);
    }
    win.location.assign(`${FOLLOW_PATH}#${home}`);
    return 'relayed';
  }
  relayKey.fill(0);
  d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signed in'), d.h('p', { class: 'muted' }, 'You can close this window.')));
  win.close();
  return 'relayed';
}

const STORAGE_TEXT = 'This browser blocked the storage the sign-in needs. Close this window and try again from the app.';

/** `{error: 'storage_unavailable'}` to a follow-up slot, best effort (the vault then stops instead of waiting). */
async function tellStorageFailed(api: AuthApi, relayKey: Uint8Array, slotId: string): Promise<void> {
  try {
    await api.writeRelay(slotId, await encryptRelayPayload(relayKey, slotId, { error: 'storage_unavailable' }));
  } catch {
    // The vault ends the login at its limit instead.
  }
}

/** What this leg relays: the token (with case B's proof), the access token, a proof, or Google's error. */
function payloadFor(fragment: CallbackFragment, taken: TakenLogin): RelayPayload {
  if (fragment.kind === 'error') return { error: fragment.error };
  if (fragment.kind === 'access') return taken.leg === 'access' ? { accessToken: fragment.accessToken } : { error: 'invalid_response' };
  if (fragment.kind !== 'token' || taken.leg === 'access') return { error: 'invalid_response' };
  if (taken.leg === 'proof') return { idToken: fragment.idToken, as: 'proof' };
  // An access token beside the ID token only counts in one-request mode (the login's own request asked for it).
  const access = taken.followKey && !taken.task && fragment.accessToken && GOOGLE_EMAIL_FLOW === 'one_request' ? { accessToken: fragment.accessToken } : {};
  return { idToken: fragment.idToken, ...access, ...(taken.caseB ? { caseB: taken.caseB } : {}) };
}
