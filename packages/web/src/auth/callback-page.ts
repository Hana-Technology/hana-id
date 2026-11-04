// `GET {authOrigin}/login/callback` (docs/batch-b-spec.md "Login" step 6): Google's redirect target. It reads the
// fragment and clears it at once, takes the relayKey that /login stored for this `state` (single use), encrypts
// Google's answer under it and writes it to the relay, then closes. The vault (or the export window) reads the slot
// with its read key; the API stores only ciphertext.
//
// Linking (build plan batch 8b), in a login that carries the follow-up key (auth/google.ts GOOGLE_EMAIL_FLOW):
// - second_request: after relaying the login's token (`access: 'follow'`), it makes the second, silent Google request
//   for the `email` scope, and that answer (`#access_token`) comes back here to follow-up slot 1 (asked once more
//   without `prompt=none` when Google needs the user, after Hana's explainer, D264);
// - token_first (D270; the entry says `tokenFirst`): the login's first answer is an access token for `openid email`.
//   This page reads its client and `sub` from Google's tokeninfo (`accessTokenSub`; another client's token, or no
//   answer, ends the login: never a request without the hint), relays it to slot 1 at once (so it is never stored
//   across Google's page), then asks Google silently for the openid-only ID token of that `sub` with the login's nonce
//   (`leg: 'id'`, under the login's own slot). A silent failure gets one interactive openid-only retry for the same
//   account (D273); an ID token of another account ends the login (`google_account_mismatch`). Only that ID token is
//   relayed for the chain, with `access: 'follow'`; an ID token answered to the access token request never is;
// - case B's "Link and continue" (the email step stored it): the token carries `caseB {linkTicket, emailSub}` (D139);
// - a proof the vault asked for (a link method's, `leg: 'proof'`) goes to its own follow-up slot;
// then, instead of closing, the window goes to /login/email's follow-up mode, which reads the vault's next notice
// (google-match's screens, link banners, the vault's last word). A record-only login (token_first in an app without
// email login, `record`: the access token is for the issuer's directory only, D269) has no follow-up mode: it closes.
// It doesn't depend on tokeninfo either: when tokeninfo can't answer or refuses the token, the access token is
// dropped, nothing goes to slot 1, and the login is batch B's openid login with the account chooser (the vault then
// records nothing); only another client's token still ends it.
//
// Every ID token is checked against the claim allow-list before it is relayed (D270): one with any other claim (an
// `email`, an `hd`) is never relayed; the slot says `token_has_pii` and the login ends.
//
// SECURITY: the fragment holds a Google ID token or access token. It is cleared from the URL before anything else,
// never logged, stored or shown, and dropped once encrypted (an access token is sent only to Google's tokeninfo, in a
// POST body); relayKey and followKey are zeroed after use, or stored again (sessionStorage, 10 min) only for the next
// leg.
import { ApiError, RELAY_CLAIM_NAME, type RelayPayload, disallowedClaim, encryptRelayPayload, followSlot } from '@hana-id/core';
import type { AuthApi } from './api.ts';
import { dom, errorView } from './dom.ts';
import { type AccessTokenSub, type CallbackFragment, SILENT_ERRORS, accessTokenSub, googleAccessUrl, googleAuthUrl, parseCallbackFragment, unverifiedClaims, unverifiedSub } from './google.ts';
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
  /** token_first's tokeninfo call (auth/google.ts accessTokenSub); tests stub it. */
  tokenInfo?: (accessToken: string, clientId: string) => Promise<AccessTokenSub>;
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
  | 'confirm'
  /** The login ended here (token_first's checks, an ID token with a claim outside the allow-list): the slot says why. */
  | 'stopped';

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
  // token_first (D270): the login's first answer (an access token), then its ID token request's.
  if (followKey && taken.tokenFirst && !taken.leg && !taken.task) return tokenFirstAccess(deps, fragment, taken, scriptStart);
  if (followKey && taken.leg === 'id') return tokenFirstId(deps, fragment, taken, scriptStart);
  return relayLeg(deps, fragment, taken, scriptStart);
}

/** Why token_first's checks, or the claim allow-list, ended a login here: the relayed code and what this window says. */
const STOPS = {
  tokeninfo_unavailable: 'Hana couldn’t check your Google sign-in with Google. Close this window and try again from the app.',
  tokeninfo_client_mismatch: 'Google’s answer was for another app, so the sign-in was stopped. Close this window and try again from the app.',
  tokeninfo_invalid: 'Google’s answer could not be used. Close this window and try again from the app.',
  google_account_mismatch: 'Google signed in another account than the one you picked. Close this window and try again from the app.',
  token_has_pii: 'Google returned more account details than Hana accepts, so the sign-in was stopped.',
} as const;
export type CallbackStopCode = keyof typeof STOPS;

/**
 * Relays `{error: code}` to `slot` (with `claim`, the first claim outside the allow-list, for `token_has_pii`; best
 * effort), shows why, zeroes the entry's keys: the login ends here.
 */
async function stopLogin(deps: CallbackPageDeps, taken: TakenLogin, slot: string, code: CallbackStopCode, claim?: string): Promise<CallbackOutcome> {
  const d = dom(deps.win.document);
  try {
    const named = claim !== undefined && RELAY_CLAIM_NAME.test(claim) ? { claim } : {};
    await deps.api.writeRelay(slot, await encryptRelayPayload(taken.relayKey, slot, { error: code, ...named }));
  } catch {
    // The vault ends the login at its limit instead; this window says why either way.
  }
  zeroTaken(taken);
  d.show(errorView(d, 'Sign-in stopped', STOPS[code], code));
  return 'stopped';
}

/**
 * token_first's first leg: Google's access token for `openid email`. tokeninfo names its client and `sub`; the token
 * goes to follow-up slot 1 now; then the silent openid-only ID token request for that `sub`, answered to the login's
 * own slot (`leg: 'id'`). Google's error (the user declined, closed the chooser) is relayed: the login ends.
 */
async function tokenFirstAccess(deps: CallbackPageDeps, fragment: Exclude<CallbackFragment, { kind: 'no_state' }>, taken: TakenLogin, scriptStart: number): Promise<CallbackOutcome> {
  const { win, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const authOrigin = deps.authOrigin ?? (typeof location === 'undefined' ? '' : location.origin);
  const d = dom(win.document);
  // An ID token was never asked for here (it would carry the email, D270): never relayed, whatever it holds.
  if (fragment.kind === 'token') return relayLeg(deps, { kind: 'error', state: fragment.state, error: 'invalid_response' }, taken, scriptStart);
  if (fragment.kind !== 'access') return relayLeg(deps, fragment, taken, scriptStart);
  const { clientId, nonce } = taken;
  const followKey = taken.followKey as Uint8Array;
  const state = fragment.state;
  if (!clientId || !nonce) return relayLeg(deps, { kind: 'error', state, error: 'invalid_response' }, taken, scriptStart);
  // The login hint: the access token's own `sub`, from Google (D270). Never a request without it.
  const info = await (deps.tokenInfo ?? accessTokenSub)(fragment.accessToken, clientId);
  // A record-only login (no email login, so no match: D269's directory is best effort) doesn't need tokeninfo: when
  // it can't answer or refuses the token, the access token is dropped (nothing goes to slot 1) and the login is batch
  // B's openid login, with the account chooser and the login's nonce. Another client's token still ends it (that
  // isn't an outage). An app with email login stops on every failure: its match needs the account (D255).
  if (!info.ok && taken.record && info.reason !== 'wrong_client') return recordOnlyFallback(deps, taken, clientId, nonce, state, scriptStart);
  if (!info.ok) return stopLogin(deps, taken, state, info.reason === 'wrong_client' ? 'tokeninfo_client_mismatch' : info.reason === 'unavailable' ? 'tokeninfo_unavailable' : 'tokeninfo_invalid');
  // Slot 1 now: the access token is never kept across Google's next page.
  const slot1 = followSlot(followKey, 1).id;
  try {
    await api.writeRelay(slot1, await encryptRelayPayload(taken.relayKey, slot1, { accessToken: fragment.accessToken }));
  } catch (err) {
    const used = err instanceof ApiError && err.code === 'relay_used';
    try {
      // The vault waits on the login's slot: it hears that this login can't go on.
      await api.writeRelay(state, await encryptRelayPayload(taken.relayKey, state, { error: 'relay_failed' }));
    } catch {
      // The vault ends the login at its limit instead.
    }
    zeroTaken(taken);
    d.show(
      errorView(
        d,
        'Sign-in could not finish',
        used ? 'This sign-in was already completed. Close this window.' : 'Hana could not be reached to finish the sign-in. Close this window and try again from the app.',
        err instanceof ApiError ? err.code : 'api_unavailable',
      ),
    );
    return 'relay_failed';
  }
  try {
    storeLoginEntry(win.sessionStorage, state, taken.relayKey, now(), taken.timings ?? undefined, idLegEntry(taken, info.sub, false));
  } catch {
    // The vault waits on this slot: it hears why (G-L2).
    return relayLeg(deps, { kind: 'error', state, error: 'storage_unavailable' }, taken, scriptStart);
  }
  zeroTaken(taken);
  win.location.assign(googleAuthUrl({ clientId, authOrigin, nonce, state, forceReauth: false, loginHint: info.sub, silent: true }));
  return 'relayed';
}

/**
 * A record-only login whose access token tokeninfo couldn't check: Google's openid-only ID token request with the
 * account chooser and the login's nonce, answered to the login's own slot. Its entry is a plain login's (no follow-up
 * key, no `leg`), so the callback relays that ID token with no `access: 'follow'` and closes: the vault reads no slot
 * 1 and records nothing (D269 best effort). The access token is never relayed or stored.
 */
function recordOnlyFallback(deps: CallbackPageDeps, taken: TakenLogin, clientId: string, nonce: string, state: string, scriptStart: number): CallbackOutcome | Promise<CallbackOutcome> {
  const now = deps.now ?? (() => Date.now());
  const authOrigin = deps.authOrigin ?? (typeof location === 'undefined' ? '' : location.origin);
  try {
    storeLoginEntry(deps.win.sessionStorage, state, taken.relayKey, now(), taken.timings ?? undefined);
  } catch {
    // The vault waits on this slot: it hears why (G-L2).
    return relayLeg(deps, { kind: 'error', state, error: 'storage_unavailable' }, taken, scriptStart);
  }
  zeroTaken(taken);
  deps.win.location.assign(googleAuthUrl({ clientId, authOrigin, nonce, state, forceReauth: false }));
  return 'relayed';
}

/** token_first's ID leg entry: the login's own slot again, for the openid-only ID token of `sub`. */
function idLegEntry(taken: TakenLogin, sub: string, interactive: boolean): Parameters<typeof storeLoginEntry>[5] {
  return {
    followKey: taken.followKey as Uint8Array,
    leg: 'id',
    tokenFirst: true,
    clientId: taken.clientId as string,
    nonce: taken.nonce as string,
    loginHint: sub,
    ...(interactive ? { interactive: true } : {}),
    ...(taken.caseB ? { caseB: taken.caseB } : {}),
    ...(taken.record ? { record: true } : {}),
  };
}

/**
 * token_first's ID leg: the openid-only ID token of the account tokeninfo named. A silent failure Google needs the
 * user for is asked once more interactively, still openid only and for that account (D273); a second failure, or any
 * other error, is relayed. An ID token of another account ends the login (`google_account_mismatch`).
 */
async function tokenFirstId(deps: CallbackPageDeps, fragment: Exclude<CallbackFragment, { kind: 'no_state' }>, taken: TakenLogin, scriptStart: number): Promise<CallbackOutcome> {
  const { win } = deps;
  const now = deps.now ?? (() => Date.now());
  const authOrigin = deps.authOrigin ?? (typeof location === 'undefined' ? '' : location.origin);
  const state = fragment.state;
  const { clientId, nonce, loginHint } = taken;
  if (!clientId || !nonce || !loginHint) return relayLeg(deps, { kind: 'error', state, error: 'invalid_response' }, taken, scriptStart);
  if (fragment.kind === 'error' && SILENT_ERRORS.has(fragment.error) && !taken.interactive) {
    try {
      storeLoginEntry(win.sessionStorage, state, taken.relayKey, now(), taken.timings ?? undefined, idLegEntry(taken, loginHint, true));
    } catch {
      return relayLeg(deps, { kind: 'error', state, error: 'storage_unavailable' }, taken, scriptStart);
    }
    zeroTaken(taken);
    // Google's own page for the same account (it may ask the user to confirm or sign in again); no email is asked.
    win.location.assign(googleAuthUrl({ clientId, authOrigin, nonce, state, forceReauth: false, loginHint, silent: false }));
    return 'relayed';
  }
  if (fragment.kind === 'access') return relayLeg(deps, { kind: 'error', state, error: 'invalid_response' }, taken, scriptStart);
  if (fragment.kind === 'token' && unverifiedSub(fragment.idToken) !== loginHint) return stopLogin(deps, taken, state, 'google_account_mismatch');
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
  // D270: an ID token with a claim outside the allow-list (an `email`, an `hd`) is never relayed, whichever leg.
  if (fragment.kind === 'token') {
    const claims = unverifiedClaims(fragment.idToken);
    const claim = claims ? disallowedClaim(claims) : null;
    if (claim !== null) return stopLogin(deps, taken, fragment.state, 'token_has_pii', claim);
  }
  let payload: RelayPayload | null = payloadFor(fragment, taken);
  // second_request: the login's own token says an access token follows, in slot 1 (never with a link task's proof, a
  // token_first login's or a record-only one's).
  const accessLeg =
    !!followKey && !taken.leg && !taken.task && !taken.tokenFirst && !taken.record && fragment.kind === 'token' && taken.clientId ? unverifiedSub(fragment.idToken) : null;
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
  if (followKey && !taken.record) {
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
  zeroTaken(taken);
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

/**
 * What this leg relays: the token (with case B's proof; token_first's says its access token is in slot 1), the access
 * token, a proof, or Google's error. An access token beside an ID token is never relayed (nothing asks for one).
 */
function payloadFor(fragment: CallbackFragment, taken: TakenLogin): RelayPayload {
  if (fragment.kind === 'error') return { error: fragment.error };
  if (fragment.kind === 'access') return taken.leg === 'access' ? { accessToken: fragment.accessToken } : { error: 'invalid_response' };
  if (fragment.kind !== 'token' || taken.leg === 'access') return { error: 'invalid_response' };
  if (taken.leg === 'proof') return { idToken: fragment.idToken, as: 'proof' };
  const follows = taken.leg === 'id' ? { access: 'follow' as const } : {};
  return { idToken: fragment.idToken, ...follows, ...(taken.caseB ? { caseB: taken.caseB } : {}) };
}
