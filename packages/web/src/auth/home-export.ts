// Hana Home's "Move this wallet to another wallet app" (home-page.ts mounts it on an app's page): the user opens one
// app's wallet from Hana Home and takes its private key, with the export window's safeguards (key-reveal.ts).
//
// It starts collapsed and does nothing until the user expands it and presses "Sign in again to continue": nothing in
// the page's address can open, preselect or start it. Then, as the export window does:
//   1. a child `/login?mode=home` is opened in the click; this page makes a session key of its own (one use, key index
//      0, 15 minutes), checks on NEAR that the Google client it will use still opens this app's wallets, and answers
//      the child's hello with `hana:home-derive-params`. Google signs the user in again (`max_age=0`);
//   2. Google's answer comes back through the login relay; the token is checked against Google's keys, and must be for
//      the account Hana Home is signed in as (nothing is sent otherwise);
//   3. the path is the identity's own, or its account root's once both NEAR providers confirm it (export-path.ts);
//   4. one `POST /v1/home/login` (one `create_session_and_derive`); the answer is decrypted with the pinned CKD key
//      and the pairing check, for that path. The request is never sent a second time by the page;
//   5. the wallet's two addresses are worked out and shown; the user picks a chain, types EXPORT, and uses Show key or
//      Copy key.
//
// SECURITY (what holds a secret, and for how long):
// - PRK, the secret both chain keys come from: one Uint8Array, zeroed HOME_PRK_LIFETIME_MS (5 minutes) after the
//   derive, on "Lock now", when the user leaves the app's page, signs out or signs in as someone else, and when the
//   page is hidden for good (pagehide). The CKD answer's secret is zeroed as soon as PRK is taken from it.
// - A chain's private key: derived from PRK inside one Show or Copy and zeroed in the same call; only its export
//   string outlives it, in the reveal's text node or the clipboard (key-reveal.ts says what that means).
// - The per-app token: held until the request is sent, then dropped. The session key is non-extractable and dropped
//   with the attempt; the relay keys and the salt are zeroed.
// - Nothing here is written to storage, a URL, a log or a message. The only message sent is the child's parameters
//   (public values and the relay key). The API gets the token and public keys, never key material.
import {
  ApiError,
  type CkdResult,
  EXPORT_MAX_AUTH_AGE_MS,
  HOME_EMAIL_AUDIENCE,
  type Jwk,
  RELAY_KEY_BYTES,
  type RelayReadResponse,
  SALT_BYTES,
  type WindowMessage,
  base64UrlEncode,
  chainPrivateKey,
  ckdAppId,
  decryptCkd,
  decryptRelayPayload,
  deriveAddresses,
  extractPrk,
  isJsonFormToken,
  isRelayToken,
  jsonBytes,
  newAppKey,
  newSessionKey,
  parseWindowMessage,
  randomBytes,
  relayIdFor,
  sessionKeyFailure,
  sessionNonce,
  signDerive,
  verifyGoogleIdToken,
} from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { ChainLoginError, loginOnChain } from './chain-login.ts';
import type { ServerClock } from './clock.ts';
import type { Child, Dom } from './dom.ts';
import { sessionKeyText } from './errors.ts';
import { ExportPathError, exportPath } from './export-path.ts';
import type { HomeAddress, HomeApi, HomeConfig, HomeIdentity, HomeLoginBody, HomeScope } from './home-api.ts';
import { type HomeEmailApi, type HomeEmailStep, emailTokenClaims, homeEmailStep } from './home-email.ts';
import { type HomeProblem, deriveRateLimited, homeProblem, plainProblem } from './home-problems.ts';
import { EXPORT_CLIPBOARD_NOTE, EXPORT_CONFIRMATION, EXPORT_WARNING, type ExportClipboard, type KeyReveal, type ScreenGuard, exportString, keyReveal } from './key-reveal.ts';
import type { NearReader } from './near-rpc.ts';
import { type GestureCheck, type PageWindow, randomName } from './page-window.ts';

/** How long the opened wallet's secret stays in the page after the derive. */
export const HOME_PRK_LIFETIME_MS = 5 * 60_000;
/** The per-app session's lifetime: it is used once, within minutes (the API allows at most 20 minutes). */
export const HOME_EXPORT_SESSION_TTL_MS = 15 * 60_000;
/** How long the page waits for Google's answer in the relay. */
export const HOME_EXPORT_LOGIN_LIMIT_MS = 5 * 60_000;
/** How often the page checks the secret's deadline against the server-corrected clock (a timer can fire late). */
export const HOME_EXPORT_CHECK_MS = 1_000;
/** The sign-in child's path and query: the same child as Hana Home's own sign-in, with another message. */
const LOGIN_CHILD = '/login?mode=home';
const RELAY_WAIT_S = 25;
const CHILD_WATCH_MS = 500;
const CHAIN_NAMES = { stellar: 'Stellar', evm: 'EVM' } as const;
export const HOME_EXPORT_TITLE = 'Move this wallet to another wallet app';
/** What the collapsed section says under its heading, and its button: the same shape as "Devices and auto-approve". */
export const HOME_EXPORT_ABOUT = 'Hana Home can show you the private key of your wallet in this app, so that you can import it into another wallet app.';
export const HOME_EXPORT_OPEN = 'Show how to move it';

export type HomeExportState =
  /** Collapsed: the heading, one sentence and one button. Where it always starts, whatever the page's address says. */
  | 'closed'
  /** Expanded: what this does, the warning, and the button that starts the sign-in (or why it can't be offered). */
  | 'intro'
  | 'signing_in'
  /** The token is in: the path, the derive and the decrypt. */
  | 'opening'
  /** The wallet is open: its addresses, and the choice of a chain. */
  | 'unlocked'
  /** A chain is chosen: the warning and the typed confirmation. */
  | 'confirm'
  | 'reveal'
  /** The secret was erased (its 5 minutes, or "Lock now"). */
  | 'ended'
  | 'refused';

/** Why the section can't offer the move for this app, or null when it can. */
export type HomeExportOff = 'link' | 'none' | 'unknown';

export const HOME_EXPORT_OFF_TEXT: Readonly<Record<HomeExportOff, string>> = Object.freeze({
  link: 'You came to this app through a link. Hana Home never moves a wallet out from a link, because a link can come from anyone. If you want to move this wallet, open Hana Home yourself, without the link, and find the app in your list or by its name.',
  none: 'Hana can’t open this wallet from here. If the app still runs, use the app itself.',
  unknown: 'Hana hasn’t checked this app yet. Use “Check now” above, then come back here.',
});

export const HOME_EXPORT_END_TEXT = Object.freeze({
  expired: 'Your key was erased from this page: it is kept for 5 minutes only.',
  locked: 'Your key was erased from this page.',
});

export interface HomeExportDeps {
  win: PageWindow;
  env: HanaEnv;
  d: Dom;
  api: Pick<HomeApi, 'login'>;
  relay: Pick<AuthApi, 'readRelay'>;
  near: NearReader;
  jwks: (kid: string) => Promise<Jwk | null>;
  clock: ServerClock;
  sleep: (ms: number) => Promise<void>;
  isGesture: GestureCheck;
  guard: ScreenGuard;
  clipboard: () => ExportClipboard | null;
  hasFocus: () => boolean;
  /**
   * Hana Home's live sign-in and the account it is for, or null when there is none. An email account carries the
   * address it signed in with (memory only): opening a wallet sends its code there.
   */
  session: () => { identity: HomeIdentity; account: { provider: 'google' | 'email'; sub: string; address?: string } } | null;
  /** The issuer's Home route (home-email.ts), or null in an env without an email issuer. */
  email: HomeEmailApi | null;
  config: () => HomeConfig | null;
  /** Whether Hana Home's own sign-in child is open: one child at a time. */
  signingIn: () => boolean;
  /** The API refused Hana Home's sign-in itself (a 401). */
  onSignedOut: () => void;
  /** The opened wallet's addresses, for the app's page. */
  onAddresses: (scopeId: string, addresses: HomeAddress[]) => void;
  track: (p: Promise<unknown>) => void;
}

export interface HomeExport {
  readonly state: HomeExportState;
  /** The chain whose key is on the confirm or reveal screen. */
  readonly chain: 'stellar' | 'evm' | null;
  readonly errorCode: string | null;
  readonly childName: string | null;
  readonly awaitingChild: boolean;
  /** Whether the wallet's secret is in memory. */
  readonly holdsSecret: boolean;
  /**
   * The section's element for `scope`'s page. Asking for another app's ends whatever was open for the last one. The
   * same element is handed back while the app stays the same, so a re-render of the page around it changes nothing.
   */
  view(scope: HomeScope, fromLink: boolean): HTMLElement;
  /** The user left the app's page, signed out, or the page is going away: erase everything and collapse. */
  leave(): void;
  /** Hana Home's own sign-in is starting: a per-app sign-in that hasn't finished gives way to it. */
  yieldChild(): void;
  /** A message to the page: true when it was this section's child's hello. */
  onMessage(e: MessageEvent): boolean;
}

/**
 * How Hana Home signs in again to open an app's wallet:
 * - `shared`: Hana's shared Google client, for an app with shared login on;
 * - `own`: a Google client of the app itself;
 * - `exit`: Hana Home's exit Google client (D468, D484), where the app's own Google route is gone (D490), answered at
 *   `/home/callback` (D491);
 * - `email`: a code to the address Hana Home signed in with; the issuer gives the token the app's email client, or the
 *   email exit where the app dropped it (D485).
 */
type Route = { kind: 'shared' | 'own' | 'exit'; clientId: string } | { kind: 'email' };

/** The per-app sign-in's own session (one use, key index 0), and for Google the child's relay. */
interface Pending {
  scopeId: string;
  route: Route;
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  salt: Uint8Array;
  nonce: string;
  privateKey: CryptoKey;
  /** Google only: the relay Google's answer comes back through, and the child's parameters. */
  relay: { id: string; key: Uint8Array; readKey: Uint8Array; params: WindowMessage<'hana:home-derive-params'>; helloAccepted: boolean } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * How Hana Home signs in to open this app's wallet for an account of `provider`, or why the move can't be offered.
 * `email`: whether this page can send email codes (an email issuer in this env).
 */
export function homeExportRoute(scope: HomeScope, config: HomeConfig | null, fromLink: boolean, provider: 'google' | 'email' = 'google', email = false): Route | HomeExportOff {
  // The app the page's link named, the user's own included: never from this page load. Whoever sent the link may be
  // coaching the user to take the key out and hand it over.
  if (fromLink) return 'link';
  if (scope.coverage === 'unknown') return 'unknown';
  if (provider === 'email') {
    // An email account's coverage is its scope's email client, or the email exit (the API's coverage.ts).
    return (scope.coverage === 'email' || scope.coverage === 'exit') && email ? { kind: 'email' } : 'none';
  }
  switch (scope.coverage) {
    case 'shared': {
      const clientId = scope.googleClientId ?? config?.sharedGoogleClientId ?? null;
      return clientId ? { clientId, kind: 'shared' } : 'none';
    }
    case 'hana_client':
    case 'partner_client':
      return scope.googleClientId ? { clientId: scope.googleClientId, kind: 'own' } : 'none';
    case 'exit': {
      // The exit client in force that the API named, which must be the one Hana Home's settings name.
      const clientId = config?.exitGoogleClientId ?? null;
      return clientId && (scope.googleClientId === null || scope.googleClientId === clientId) ? { clientId, kind: 'exit' } : 'none';
    }
    case 'email':
    case 'none':
      return 'none';
  }
}

export function startHomeExport(deps: HomeExportDeps): HomeExport {
  const { win, env, d, near, clock, guard, isGesture } = deps;
  const root = d.h('section', { class: 'home-export', attrs: { id: 'home-export', 'aria-labelledby': 'home-export-title' } });

  let state: HomeExportState = 'closed';
  let scope: HomeScope | null = null;
  let fromLink = false;
  let problem: HomeProblem | null = null;
  let endReason: keyof typeof HOME_EXPORT_END_TEXT = 'locked';
  /** Raised whenever what is in progress is dropped: an answer from before it is thrown away. */
  let run = 0;

  let pending: Pending | null = null;
  let child: Window | null = null;
  let childName: string | null = null;
  /** The email route's code screens, and the element they draw in (kept across renders). */
  let emailStep: HomeEmailStep | null = null;
  let emailBox: HTMLElement | null = null;

  /** The opened wallet's secret (memory only), its addresses, and when it is erased (server-corrected ms). */
  let prk: Uint8Array | null = null;
  let addresses: { stellar: string; evm: string } | null = null;
  /** A recorded address that differs from the wallet's own. */
  let mismatch = false;
  let deadline = Number.POSITIVE_INFINITY;
  let prkTimer: ReturnType<typeof setTimeout> | null = null;
  let checker: ReturnType<typeof setInterval> | null = null;
  let chain: 'stellar' | 'evm' | null = null;
  let reveal: KeyReveal | null = null;

  // ---- view parts ----
  const button = (label: string, id: string, onClick: (e: Event) => void, cls?: string): HTMLButtonElement => {
    const b = d.h('button', { ...(cls ? { class: cls } : {}), attrs: { type: 'button', id } }, label);
    b.addEventListener('click', (e) => {
      if (isGesture(e)) onClick(e);
    });
    return b;
  };
  const title = (text: string): HTMLElement => d.h('h3', { attrs: { id: 'home-export-title', tabindex: '-1' } }, text);
  const show = (...children: Child[]): void => {
    root.replaceChildren();
    for (const c of children) if (c !== null && c !== undefined && c !== false) root.append(typeof c === 'string' ? win.document.createTextNode(c) : c);
  };
  const focusTitle = (): void => {
    try {
      (root.querySelector('#home-export-title') as HTMLElement | null)?.focus();
    } catch {
      // Focus is a convenience.
    }
  };
  const addressRows = (a: { stellar: string; evm: string }): HTMLElement =>
    d.h(
      'div',
      { class: 'home-addresses', attrs: { id: 'home-export-addresses' } },
      d.h('div', { class: 'home-address' }, d.h('p', { class: 'home-address-label' }, 'Stellar'), d.h('p', { class: 'mono home-address-value', attrs: { id: 'home-export-address-stellar' } }, a.stellar)),
      d.h('div', { class: 'home-address' }, d.h('p', { class: 'home-address-label' }, 'EVM (Ethereum and similar networks)'), d.h('p', { class: 'mono home-address-value', attrs: { id: 'home-export-address-evm' } }, a.evm)),
    );

  // ---- erasing ----
  function wipePending(): void {
    emailStep?.end();
    emailStep = null;
    emailBox = null;
    if (!pending) return;
    pending.salt.fill(0);
    if (pending.relay) {
      pending.relay.key.fill(0);
      pending.relay.readKey.fill(0);
      pending.relay.params.relayKey.fill(0);
      pending.relay.params.salt.fill(0);
    }
    pending = null;
  }
  function closeChild(): void {
    try {
      child?.close();
    } catch {
      // Already closed.
    }
    child = null;
  }
  /** Erases the wallet's secret and everything shown from it. */
  function wipeSecret(): void {
    reveal?.end();
    reveal = null;
    prk?.fill(0);
    prk = null;
    addresses = null;
    mismatch = false;
    chain = null;
    deadline = Number.POSITIVE_INFINITY;
    if (prkTimer !== null) clearTimeout(prkTimer);
    if (checker !== null) clearInterval(checker);
    prkTimer = null;
    checker = null;
  }
  /** Drops whatever is in progress or open. */
  function wipeAll(): void {
    run += 1;
    wipePending();
    closeChild();
    wipeSecret();
  }

  /** The secret's time is up, or the user locked it. */
  function lock(reason: keyof typeof HOME_EXPORT_END_TEXT): void {
    if (prk === null) return;
    wipeAll();
    endReason = reason;
    state = 'ended';
    render();
    focusTitle();
  }
  /** Erases the secret if its deadline passed; true when there is none to use. */
  function expired(): boolean {
    if (prk === null) return true;
    if (clock.now() >= deadline) {
      lock('expired');
      return true;
    }
    return false;
  }

  function refuse(p: HomeProblem): void {
    wipeAll();
    problem = p;
    state = 'refused';
    render();
    focusTitle();
  }

  // ---- the per-app sign-in ----
  /**
   * The click: opens the child synchronously, before any await (a window opened after one loses the user's activation
   * in some browsers), then prepares the session while the child loads.
   */
  function begin(): void {
    if (state !== 'intro' || !scope) return;
    const live = deps.session();
    const route = homeExportRoute(scope, deps.config(), fromLink, live?.account.provider ?? 'google', deps.email !== null);
    if (typeof route === 'string') return;
    // Hana Home's own sign-in child is open: one child at a time, and that one comes first.
    if (deps.signingIn()) return refuse(plainProblem('home_signing_in'));
    if (!live) return refuse(plainProblem('home_signed_out'));
    run += 1;
    const mine = run;
    if (route.kind === 'email') {
      // No child window: the code screens are on this page, once the route is checked on NEAR.
      state = 'signing_in';
      render();
      focusTitle();
      deps.track(prepare(mine, scope.scopeId, route));
      return;
    }
    childName = randomName('hana-home-open-');
    child = win.open(`${env.authOrigin}${LOGIN_CHILD}`, childName, 'popup,width=480,height=640');
    if (!child) return refuse(plainProblem('popup_blocked'));
    state = 'signing_in';
    render();
    focusTitle();
    const opened = child;
    // A child closed before it connected: back to the start. After the hello the handle isn't watched, because
    // Google's pages may make it report `closed`; Cancel and the time limit cover that.
    const watch = setInterval(() => {
      if (run !== mine || child !== opened || state !== 'signing_in' || pending?.relay?.helloAccepted) {
        clearInterval(watch);
        return;
      }
      let closed = false;
      try {
        closed = opened.closed === true;
      } catch {
        closed = false;
      }
      if (closed) {
        clearInterval(watch);
        refuse(plainProblem('login_cancelled'));
      }
    }, CHILD_WATCH_MS);
    deps.track(prepare(mine, scope.scopeId, route));
  }

  /**
   * Whether `route`'s client still opens this app's wallets, read from NEAR by this page itself (the API only named
   * it): the shared client in force with shared login on, or a client registered on this very app.
   */
  async function checkRoute(scopeId: string, route: Route): Promise<'ok' | 'not_covered' | 'near_unreadable'> {
    try {
      if (route.kind === 'own') return (await near.view(env.signer, 'scope_for_client', { provider: 'google', aud: route.clientId })) === scopeId ? 'ok' : 'not_covered';
      const [onChain, config] = await Promise.all([near.view(env.signer, 'get_scope', { scope_id: scopeId }), near.view(env.signer, 'get_config', {})]);
      if (onChain === null) return 'not_covered';
      if (!isObj(onChain) || typeof onChain.allow_shared !== 'boolean' || !isObj(config)) return 'near_unreadable';
      const has = (list: unknown, provider: string, aud: string): boolean => Array.isArray(list) && list.some((c) => Array.isArray(c) && c.length === 2 && c[0] === provider && c[1] === aud);
      // An exit client in force: listed, or a pending addition whose time has come (an older contract has neither).
      const exitInForce = (provider: string, aud: string): boolean =>
        has(config.exit_clients, provider, aud) ||
        (Array.isArray(config.pending_exit_clients) && config.pending_exit_clients.some((p) => isObj(p) && p.provider === provider && p.aud === aud && typeof p.effective_at_ms === 'number' && p.effective_at_ms <= clock.now()));
      if (route.kind === 'exit') return exitInForce('google', route.clientId) ? 'ok' : 'not_covered';
      if (route.kind === 'email') return has(onChain.clients, 'email', `email:${scopeId}`) || exitInForce('email', HOME_EMAIL_AUDIENCE) ? 'ok' : 'not_covered';
      if (!Array.isArray(config.shared_clients)) return 'near_unreadable';
      return onChain.allow_shared && has(config.shared_clients, 'google', route.clientId) ? 'ok' : 'not_covered';
    } catch {
      return 'near_unreadable';
    }
  }

  /** This page's own session for the derive: one use, key index 0, its own nonce and relay keys. */
  async function prepare(mine: number, scopeId: string, route: Route): Promise<void> {
    let sessionKey: Awaited<ReturnType<typeof newSessionKey>>;
    let verdict: Awaited<ReturnType<typeof checkRoute>>;
    try {
      [sessionKey, verdict] = await Promise.all([newSessionKey(), checkRoute(scopeId, route)]);
    } catch (e) {
      if (run === mine) refuse(plainProblem('derive_failed', sessionKeyText(sessionKeyFailure(e))));
      return;
    }
    if (run !== mine) return;
    if (verdict !== 'ok') return refuse(plainProblem(verdict));
    const salt = randomBytes(SALT_BYTES);
    const expiresAtMs = clock.now() + HOME_EXPORT_SESSION_TTL_MS;
    const sessionPublicKey = sessionKey.publicKey;
    const nonce = sessionNonce({ signer: env.signer, scopeId, sessionPublicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
    const base = { scopeId, route, sessionPublicKey, expiresAtMs, salt, nonce, privateKey: sessionKey.keyPair.privateKey };
    if (route.kind === 'email') {
      const p: Pending = { ...base, relay: null };
      pending = p;
      return startEmailCode(mine, p);
    }
    const relayKey = randomBytes(RELAY_KEY_BYTES);
    const relayReadKey = randomBytes(32);
    const relayId = relayIdFor(relayReadKey);
    const params: WindowMessage<'hana:home-derive-params'> = {
      v: 1,
      t: 'hana:home-derive-params',
      signer: env.signer,
      clientId: route.clientId,
      scopeId,
      sessionPublicKey,
      expiresAtMs,
      salt: Uint8Array.from(salt),
      nonce,
      relayId,
      relayKey: Uint8Array.from(relayKey),
      // The exit client answers at /home/callback only (D491).
      ...(route.kind === 'exit' ? { exit: true as const } : {}),
    };
    pending = { ...base, relay: { id: relayId, key: relayKey, readKey: relayReadKey, params, helloAccepted: false } };
  }

  /**
   * The email route: the code screens, for the address Hana Home signed in with (memory only), over this session's
   * commitment. The issuer computes the nonce from it; the token must carry this session's nonce and the account's id.
   */
  function startEmailCode(mine: number, p: Pending): void {
    const live = deps.session();
    const api = deps.email;
    const address = live?.account.provider === 'email' ? live.account.address : undefined;
    if (!live || !api || !address) return refuse(plainProblem('home_signed_out'));
    const box = d.h('div', { class: 'home-email-step', attrs: { id: 'home-export-email' } });
    emailBox = box;
    emailStep = homeEmailStep({
      d,
      root: box,
      isGesture,
      now: () => clock.now(),
      title: 'Get a code to open this wallet',
      intro: 'Hana Home sends a code to the email you signed in with. The key then stays ready in this page for 5 minutes.',
      address,
      // The issuer mails this code only to the address Hana Home is signed in as, shown by the sign-in's own token.
      start: (to) => api.start(to, 'derive', { scopeId: p.scopeId, sessionPublicKey: p.sessionPublicKey, expiresAtMs: p.expiresAtMs, salt: p.salt }, live.identity.token ?? ''),
      api,
      ids: 'home-export-email',
      onToken: (token) => {
        if (run !== mine || pending !== p) return;
        emailStep = null;
        emailBox = null;
        const c = emailTokenClaims(token);
        // The session's own token: its nonce, the app's email client or the email exit, the env's issuer, unexpired.
        if (!c || c.nonce !== p.nonce || (c.aud !== `email:${p.scopeId}` && c.aud !== HOME_EMAIL_AUDIENCE) || (env.emailIss !== undefined && c.iss !== env.emailIss) || c.exp * 1000 <= clock.now()) {
          return refuse(plainProblem('email_token_invalid'));
        }
        state = 'opening';
        render();
        focusTitle();
        deps.track(open(p, mine, token, { provider: 'email', sub: c.sub }));
      },
      onStop: ({ code }) => {
        if (run !== mine) return;
        // The issuer no longer takes Hana Home's sign-in (its token's 10 minutes are over): the sign-in has ended.
        if (code === 'home_identity_invalid') {
          deps.onSignedOut();
          return refuse(plainProblem('home_signed_out'));
        }
        refuse(plainProblem(code === 'not_covered' || code === 'home_email_unavailable' ? code : 'email_token_invalid'));
      },
      onCancel: () => {
        if (run === mine) cancel();
      },
    });
    render();
    focusTitle();
  }

  /** Whether `w` is on this origin at the sign-in child's address. A window whose address can't be read isn't. */
  function childAtLogin(w: Window): boolean {
    try {
      return `${w.location.pathname}${w.location.search}` === LOGIN_CHILD;
    } catch {
      return false;
    }
  }

  function onMessage(e: MessageEvent): boolean {
    const p = pending;
    const r = p?.relay;
    if (!p || !r || r.helloAccepted || child === null || e.source !== child || e.origin !== env.authOrigin) return false;
    if (!parseWindowMessage(e.data, ['hana:auth-hello'])) return false;
    if (!childAtLogin(child)) return true;
    r.helloAccepted = true;
    try {
      child.postMessage(r.params, env.authOrigin);
    } catch {
      refuse(plainProblem('login_cancelled'));
      return true;
    } finally {
      // postMessage cloned it; the page keeps only its own copy of the relay key, for the decrypt.
      r.params.relayKey.fill(0);
    }
    deps.track(awaitToken(p, run));
    return true;
  }

  /** The sentence for a refusal of the derive: the API's code picks it, with the derive's own words for its limits. */
  function deriveProblem(err: ApiError): HomeProblem {
    const p = homeProblem(err);
    return p.code === 'rate_limited' ? { ...p, text: deriveRateLimited(err.details.retryAfterS) } : p;
  }

  /** Long-polls the relay for Google's answer and checks the token, then opens the wallet with it (`open`). */
  async function awaitToken(p: Pending, mine: number): Promise<void> {
    const stale = () => run !== mine || pending !== p;
    const r = p.relay;
    if (!r || p.route.kind === 'email') return;
    const clientId = p.route.clientId;
    const limit = clock.now() + HOME_EXPORT_LOGIN_LIMIT_MS;
    const readKey = base64UrlEncode(r.readKey);
    let value: RelayReadResponse | null = null;
    while (value === null) {
      if (stale()) return;
      if (clock.now() > limit) return refuse(plainProblem('login_timeout'));
      try {
        value = await deps.relay.readRelay(r.id, readKey, RELAY_WAIT_S);
      } catch (err) {
        if (stale()) return;
        // A slot that is gone or forbidden never recovers; anything else is the wait itself failing, so it goes on.
        if (err instanceof ApiError && (err.status === 410 || err.status === 403)) return refuse(plainProblem('token_invalid'));
        await deps.sleep(1000);
      }
    }
    if (stale()) return;
    clock.sync(value.serverTimeMs);
    closeChild();
    state = 'opening';
    render();
    focusTitle();

    // 2. Google's answer: an ID token of this client for this session's nonce, from a sign-in made just now.
    try {
      const payload = await decryptRelayPayload(r.key, r.id, value).catch(() => null);
      if (stale()) return;
      if (payload === null) return refuse(plainProblem('token_invalid'));
      if ('error' in payload) return refuse(plainProblem(payload.error === 'access_denied' ? 'login_cancelled' : 'google_error', payload.error === 'access_denied' ? 'The sign-in was cancelled.' : undefined));
      if (!isRelayToken(payload) || payload.accessToken !== undefined || payload.access !== undefined || payload.caseB !== undefined || payload.as !== undefined || isJsonFormToken(payload.idToken)) {
        return refuse(plainProblem('token_invalid'));
      }
      const checked = await verifyGoogleIdToken(payload.idToken, { clientId, nonce: p.nonce, nowMs: clock.now(), jwks: deps.jwks }).catch(() => null);
      if (stale()) return;
      if (checked === null) return refuse(plainProblem('api_unavailable', 'Google’s keys could not be read. Try again.'));
      if (!checked.ok) return refuse(plainProblem(checked.code === 'token_has_pii' ? 'token_has_pii' : 'token_invalid'));
      // Google sends no auth_time today even with max_age=0, so its absence is accepted; when present it must be fresh.
      if (checked.token.authTime !== null && checked.token.authTime * 1000 < clock.now() - EXPORT_MAX_AUTH_AGE_MS) return refuse(plainProblem('stale_sign_in'));
      await open(p, mine, payload.idToken, { provider: 'google', sub: checked.token.sub });
    } catch {
      if (!stale()) refuse(plainProblem('derive_failed'));
    }
  }

  /**
   * Steps 3 to 5 with the per-app sign-in's token (Google's, checked against Google's keys; or the issuer's, whose
   * nonce and audience were checked): the account must be Hana Home's own, then the path, the one derive, the decrypt.
   */
  async function open(p: Pending, mine: number, token: string, who: { provider: 'google' | 'email'; sub: string }): Promise<void> {
    const stale = () => run !== mine || pending !== p;
    let secret: Uint8Array | null = null;
    try {
      // The same account as Hana Home's sign-in (the method and its id), checked here before anything is sent.
      const live = deps.session();
      if (!live) return refuse(plainProblem('home_signed_out'));
      if (live.account.provider !== who.provider || live.account.sub !== who.sub) return refuse(plainProblem('home_account_mismatch'));

      // 3. The path: this identity's own, or its account root's once both NEAR providers agree.
      let path: string;
      let linked: boolean;
      try {
        ({ path, linked } = await exportPath({ near, signer: env.signer, scopeId: p.scopeId, who, keyIndex: 0 }));
      } catch (e) {
        if (stale()) return;
        if (!(e instanceof ExportPathError)) throw e;
        return refuse(plainProblem(e.reason === 'identity_unreadable' ? 'near_unreadable' : e.reason));
      }
      if (stale()) return;

      // 4. One derive. The page never sends it twice (`resendableUntil: 0`): an outcome it can't learn is looked up on
      // NEAR, and anything else is a refusal the user answers.
      const appKey = newAppKey();
      const { pk1, pk2 } = appKey.publicKey.AppPublicKeyPV;
      const signature = await signDerive(p.privateKey, 1, pk1, pk2);
      const body: HomeLoginBody = {
        jwt: token,
        sessionPublicKey: jsonBytes(p.sessionPublicKey),
        expiresAtMs: p.expiresAtMs,
        salt: jsonBytes(p.salt),
        keyIndex: 0,
        maxUses: 1,
        signature: jsonBytes(signature),
        pk1,
        pk2,
        scopeId: p.scopeId,
      };
      token = '';
      let refused: ApiError | null = null;
      /** The answer the API itself gave, if it gave one: any other result was looked up on NEAR by the page. */
      let answered: CkdResult | null = null;
      let result: CkdResult;
      try {
        result = await loginOnChain(body, {
          login: async (b) => {
            try {
              const out = await deps.api.login(live.identity, { ...b, scopeId: p.scopeId } as HomeLoginBody);
              answered = out.result;
              return out;
            } catch (err) {
              if (err instanceof ApiError) refused = err;
              throw err;
            }
          },
          near,
          signer: env.signer,
          relayer: env.relayer,
          scopeId: p.scopeId,
          expectedPath: path,
          sessionPublicKey: p.sessionPublicKey,
          maxUses: 1,
          resendableUntil: 0,
          now: () => clock.now(),
          sleep: deps.sleep,
        });
      } catch (err) {
        if (stale()) return;
        const api = refused as ApiError | null;
        if (api !== null && api.status === 401) {
          deps.onSignedOut();
          return refuse(plainProblem('home_signed_out'));
        }
        if (!(err instanceof ChainLoginError)) return refuse(api ? deriveProblem(api) : plainProblem('api_unavailable'));
        // The API's own refusal says more than the login table's summary of it, except where the table went on to look
        // the outcome up on NEAR and found its own answer.
        const tableOwn = err.code === 'session_consumed' || err.code === 'ckd_failed' || err.code === 'derive_failed';
        return refuse(api && !(tableOwn && (api.code === 'session_exists' || api.code === 'contract_rejected' || api.status >= 500)) ? deriveProblem(api) : plainProblem(String(err.code)));
      } finally {
        body.jwt = '';
      }
      if (stale()) return;

      // The answer is the MPC's key for exactly this path, or it isn't used (the pairing check against the pinned key).
      try {
        secret = decryptCkd(result, appKey.a, ckdAppId(env.signer, path), env.ckdNetworkKey);
      } catch {
        return refuse(plainProblem('pairing_failed'));
      }
      const made = extractPrk(secret);
      let opened: { stellar: string; evm: string };
      try {
        opened = deriveAddresses(made, 0);
      } catch {
        made.fill(0);
        return refuse(plainProblem('derive_failed'));
      }
      if (stale()) {
        made.fill(0);
        return;
      }
      const s = scope;
      if (!s || s.scopeId !== p.scopeId) {
        made.fill(0);
        return;
      }
      const differs = s.addresses.some((a) => (a.chain === 'stellar' ? a.address !== opened.stellar : a.address.toLowerCase() !== opened.evm.toLowerCase()));
      // Where the pairing check alone doesn't prove the key is the user's, a difference from the record stops the move,
      // as the export window stops on a difference from the vault's address: a root's path (two lying providers could
      // name a root whose owner can forge an answer for it), and an answer the page looked up on NEAR itself rather than
      // got from the API. On the identity's own path with the API's own answer, only the MPC could have made the key:
      // there the record is what's wrong, and it is said, not hidden.
      if (differs && (linked || result !== answered)) {
        made.fill(0);
        return refuse(plainProblem('address_mismatch'));
      }
      wipePending();
      prk = made;
      addresses = opened;
      mismatch = differs;
      // The deadline: a timer, which device clock changes can't move, and the server-clock check beside it.
      deadline = clock.now() + HOME_PRK_LIFETIME_MS;
      prkTimer = setTimeout(() => lock('expired'), HOME_PRK_LIFETIME_MS);
      checker = setInterval(expired, HOME_EXPORT_CHECK_MS);
      state = 'unlocked';
      deps.onAddresses(p.scopeId, [
        { chain: 'stellar', address: opened.stellar },
        { chain: 'evm', address: opened.evm },
      ]);
      render();
      focusTitle();
    } catch {
      if (!stale()) refuse(plainProblem('derive_failed'));
    } finally {
      secret?.fill(0);
    }
  }

  // ---- screens ----
  function render(): void {
    reveal?.end();
    reveal = null;
    guard.newScreen();
    const s = scope;
    if (!s) return show();
    switch (state) {
      case 'closed':
        // Collapsed: its heading, one sentence and one button, like the devices section above it. Never the first thing
        // on the page, never hidden, and nothing but this button's click opens it.
        return show(title(HOME_EXPORT_TITLE), d.h('p', { attrs: { id: 'home-export-about' } }, HOME_EXPORT_ABOUT), d.h('div', { class: 'actions start' }, button(HOME_EXPORT_OPEN, 'home-export-open', expand)));
      case 'intro': {
        const route = routeFor(s);
        const close = button('Close', 'home-export-close', collapse);
        if (typeof route === 'string') return show(title(HOME_EXPORT_TITLE), d.h('p', { attrs: { id: 'home-export-off' } }, HOME_EXPORT_OFF_TEXT[route]), d.h('div', { class: 'actions start' }, close));
        const byEmail = route.kind === 'email';
        return show(
          title(HOME_EXPORT_TITLE),
          d.h(
            'p',
            {},
            s.mine
              ? 'Hana Home can show you this wallet’s private key, so that you can import it into another wallet app. The wallet keeps working in the app as before.'
              : `Hana has no wallet on record for you in this app. If you had one, ${byEmail ? 'confirm with a code' : 'sign in again'} and Hana Home will look for it. If it finds one, it can show you its private key, so that you can import it into another wallet app.`,
          ),
          d.h('p', { class: 'warn' }, EXPORT_WARNING),
          d.h(
            'p',
            { class: 'muted' },
            byEmail
              ? 'First Hana Home sends a new code to the email you signed in with. The key then stays ready in this page for 5 minutes.'
              : 'First you choose your Google account again; it must be the account you used for Hana Home. Google may not ask for your password again. The key then stays ready in this page for 5 minutes.',
          ),
          d.h('div', { class: 'actions start' }, button(byEmail ? 'Continue with a code' : 'Sign in again to continue', 'home-export-start', begin, 'primary'), close),
        );
      }
      case 'signing_in':
        if (pending?.route.kind === 'email' || routeKind() === 'email') {
          // The email route's code screens (home-email.ts), once the route is checked on NEAR.
          return show(...(emailBox ? [emailBox] : [title('Get a code to open this wallet'), d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Checking this app on NEAR…'), d.h('div', { class: 'actions start' }, button('Cancel', 'home-export-cancel', cancel))]));
        }
        return show(
          title('Choose your Google account again'),
          d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Finish signing in with Google in the other window.'),
          d.h('div', { class: 'actions start' }, button('Cancel', 'home-export-cancel', cancel)),
        );
      case 'opening':
        return show(title('Opening your wallet'), d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'This can take about 10 seconds. Keep this page open.'));
      case 'unlocked': {
        if (!addresses) return show();
        return show(
          title('Your wallet is open'),
          mismatch
            ? d.h('p', { class: 'warn', attrs: { id: 'home-export-mismatch' } }, 'The address Hana had on record for you in this app is different from this wallet’s. The addresses below come from the wallet’s own key, worked out in this page.')
            : null,
          addressRows(addresses),
          d.h('p', {}, 'Choose the key to show: the Stellar key for a Stellar wallet app, the EVM key for an Ethereum-style wallet app.'),
          d.h('div', { class: 'actions start' }, button('Stellar key', 'home-export-stellar', () => choose('stellar')), button('EVM key', 'home-export-evm', () => choose('evm'))),
          d.h('p', { class: 'muted' }, 'The wallet is locked again 5 minutes after you signed in, when you leave this app’s page, and when you close or reload Hana Home.'),
          d.h('div', { class: 'actions start' }, button('Lock now', 'home-export-lock', () => lock('locked'))),
        );
      }
      case 'confirm': {
        if (!addresses || !chain) return show();
        const picked = chain;
        const input = d.h('input', { attrs: { id: 'home-export-confirm', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${EXPORT_CONFIRMATION}` } });
        const go = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'home-export-continue' } }, 'Continue');
        guard.button(go, () => input.value === EXPORT_CONFIRMATION);
        input.addEventListener('input', guard.sync);
        go.addEventListener('click', (e) => {
          if (input.value !== EXPORT_CONFIRMATION || state !== 'confirm' || chain !== picked || !guard.click(e) || expired()) return;
          state = 'reveal';
          render();
          focusTitle();
        });
        show(
          title(`Your ${CHAIN_NAMES[picked]} key`),
          d.h('p', { class: 'account' }, 'For ', d.h('code', { class: 'mono' }, addresses[picked])),
          d.h('p', {}, 'Your key is ready. Make sure nobody can see your screen.'),
          d.h('p', { class: 'warn' }, EXPORT_WARNING),
          d.h('label', {}, `Type ${EXPORT_CONFIRMATION} to continue`, input),
          d.h('div', { class: 'actions start' }, go, button('Back', 'home-export-back', back)),
        );
        guard.rendered();
        return;
      }
      case 'reveal': {
        if (!addresses || !chain) return show();
        const picked = chain;
        const r = keyReveal({ d, win, guard, isGesture, clipboard: deps.clipboard, hasFocus: deps.hasFocus, ready: () => state === 'reveal' && chain === picked && !expired(), secret: () => chainSecret(picked) });
        reveal = r;
        show(
          title(`Your ${CHAIN_NAMES[picked]} key`),
          d.h('p', { class: 'account' }, 'For ', d.h('code', { class: 'mono' }, addresses[picked])),
          r.out,
          r.actions,
          r.status,
          d.h('p', { class: 'muted' }, 'A shown key hides again after 60 seconds. It is erased from this page 5 minutes after you signed in, when you leave this app’s page, and when you close or reload Hana Home.'),
          d.h('p', { class: 'muted' }, EXPORT_CLIPBOARD_NOTE),
          d.h('div', { class: 'actions start' }, button('Choose another key', 'home-export-back', back), button('Lock now', 'home-export-lock', () => lock('locked'))),
        );
        guard.rendered();
        return;
      }
      case 'ended':
        return show(
          title('Wallet locked'),
          d.h('p', { attrs: { role: 'status', id: 'home-export-ended' } }, HOME_EXPORT_END_TEXT[endReason]),
          d.h('p', { class: 'muted' }, 'To open it again, sign in with Google again.'),
          d.h('div', { class: 'actions start' }, button('Start again', 'home-export-again', expand, 'primary'), button('Close', 'home-export-close', collapse)),
        );
      case 'refused': {
        const p = problem ?? plainProblem('derive_failed');
        return show(
          title(HOME_EXPORT_TITLE),
          d.h(
            'div',
            { class: 'home-problem', attrs: { role: 'alert', id: 'home-export-problem' } },
            d.h('p', {}, p.text),
            d.h('p', { class: 'code muted' }, `Code: ${p.code}`),
            p.requestId ? d.h('p', { class: 'code muted' }, `Request: ${p.requestId}`) : null,
          ),
          d.h('div', { class: 'actions start' }, button('Try again', 'home-export-again', expand, 'primary'), button('Close', 'home-export-close', collapse)),
        );
      }
    }
  }

  /**
   * One chain's export string, for one Show or Copy: the chain key is derived from the secret, turned into its string
   * and zeroed here, so it never outlives the call.
   */
  function chainSecret(c: 'stellar' | 'evm'): string | null {
    if (prk === null) return null;
    const key = chainPrivateKey(prk, c, 0);
    try {
      return exportString(c, key);
    } finally {
      key.fill(0);
    }
  }

  /** How this page would open `s`'s wallet for the signed-in account. */
  function routeFor(s: HomeScope): Route | HomeExportOff {
    return homeExportRoute(s, deps.config(), fromLink, deps.session()?.account.provider ?? 'google', deps.email !== null);
  }
  const routeKind = (): Route['kind'] | null => {
    const r = scope ? routeFor(scope) : null;
    return r && typeof r !== 'string' ? r.kind : null;
  };

  function expand(): void {
    if (state !== 'closed' && state !== 'ended' && state !== 'refused') return;
    problem = null;
    state = 'intro';
    render();
    focusTitle();
  }
  function collapse(): void {
    if (state !== 'intro' && state !== 'ended' && state !== 'refused') return;
    problem = null;
    state = 'closed';
    render();
    // Focus goes back to the button that opens it (the Close button just pressed is gone).
    try {
      (root.querySelector('#home-export-open') as HTMLElement | null)?.focus();
    } catch {
      // Focus is a convenience.
    }
  }
  function cancel(): void {
    if (state !== 'signing_in') return;
    wipeAll();
    state = 'intro';
    render();
    focusTitle();
  }
  function choose(c: 'stellar' | 'evm'): void {
    if (state !== 'unlocked' || expired()) return;
    chain = c;
    state = 'confirm';
    render();
    focusTitle();
  }
  function back(): void {
    if ((state !== 'confirm' && state !== 'reveal') || expired()) return;
    chain = null;
    state = 'unlocked';
    render();
    focusTitle();
  }

  function leave(): void {
    wipeAll();
    problem = null;
    state = 'closed';
    scope = null;
    fromLink = false;
    show();
  }

  // A tab coming back from the background checks at once (its timers may have been held while hidden).
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') expired();
  });
  // A frozen tab runs no timers, so the 5 minutes could pass unnoticed with the secret still in memory: it is erased as
  // the tab freezes.
  win.document.addEventListener('freeze', () => lock('locked'));
  // The page is going away, or into the back/forward cache: nothing of the wallet stays in it.
  win.addEventListener('pagehide', () => {
    const s = scope;
    const link = fromLink;
    leave();
    // If the page comes back from the cache, the section is there again, collapsed.
    if (s) {
      scope = s;
      fromLink = link;
      render();
    }
  });

  return {
    get state() {
      return state;
    },
    get chain() {
      return chain;
    },
    get errorCode() {
      return state === 'refused' ? (problem?.code ?? null) : null;
    },
    get childName() {
      return childName;
    },
    get awaitingChild() {
      return pending?.relay != null && !pending.relay.helloAccepted;
    },
    get holdsSecret() {
      return prk !== null;
    },
    view(next, link) {
      if (scope?.scopeId !== next.scopeId) {
        leave();
        scope = next;
        fromLink = link;
        render();
      } else {
        const changed = scope.coverage !== next.coverage || scope.googleClientId !== next.googleClientId || scope.mine !== next.mine || fromLink !== link;
        scope = next;
        fromLink = link;
        // A fresher listing can change what the collapsed or first screen says; a screen past it is left alone.
        if (changed && (state === 'closed' || state === 'intro')) render();
      }
      return root;
    },
    leave,
    yieldChild() {
      if (state === 'signing_in') cancel();
    },
    onMessage,
  };
}
