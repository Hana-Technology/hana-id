// `GET {authOrigin}/home`: Hana Home. One Hana page where a user signs in with Google and sees the apps they use with
// Hana, whether Hana can still open their wallet in each, their addresses there and their Support ID. It derives no key
// and sends no chain transaction: everything shown comes from `GET /v1/home/apps`. Exporting a key, the devices list and
// email sign-in are later additions with their own seams here (the `home-app-extras` element, `SIGN_IN_METHODS`).
//
// Sign-in: a click opens a child `/login?mode=home` (as the export window opens its own), which takes
// `hana:home-params` only from this page, goes to Google with a nonce that commits to a key made for this sign-in, and
// relays Google's answer through the login relay. This page checks the token against Google's keys, then signs every
// API call with that key (home-api.ts). A new sign-in always makes a new key.
//
// The sign-in lasts 15 minutes. The page tells its end from the identity's own end and from a 401; it warns two
// minutes before; when it ends, everything on screen stays and nothing is fetched until the user signs in again; no
// request is ever sent again by the page itself.
//
// SECURITY:
// - The identity (key, token, `sub`) is in memory only: never in storage, a URL, a message other than the one to the
//   child (which carries the public key and the relay key, no token) or a log.
// - App names, origins and logos are partner-supplied. They reach the page only as text nodes, attribute values that
//   aren't URLs, and a logo `<img>` pinned to this build's files origin (logo.ts). Nothing here builds markup from a
//   string, and no partner string becomes a link.
// - The page drops its opener at load, refuses to run framed, takes messages only from its own child window, and acts
//   only on real clicks in its own page.
import { ApiError, type Jwk, RELAY_KEY_BYTES, type RelayReadResponse, type WindowMessage, base64UrlEncode, decryptRelayPayload, isJsonFormToken, isRelayToken, parseWindowMessage, randomBytes, relayIdFor, sessionKeyFailure, verifyGoogleIdToken } from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { ServerClock } from './clock.ts';
import { type Child, type Dom, dom } from './dom.ts';
import { sessionKeyText } from './errors.ts';
import { googleKeys } from './google-keys.ts';
import { HOME_APP_ID, HOME_SEARCH_MAX, HOME_SEARCH_MIN, type HomeApi, type HomeApp, type HomeAppsPage, type HomeAppsQuery, type HomeConfig, type HomeCoverage, type HomeIdentity, type HomeScope, newHomeIdentity } from './home-api.ts';
import { appLogo } from './logo.ts';
import { type GestureCheck, type PageWindow, isFramed, isUserGesture, randomName } from './page-window.ts';

/** How long before the sign-in's end the page warns. */
export const HOME_EXPIRY_WARN_MS = 2 * 60_000;
/** How long the page waits for Google's answer in the relay. */
export const HOME_LOGIN_LIMIT_MS = 5 * 60_000;
/** The sign-in child's path and query. */
export const HOME_LOGIN_CHILD = '/login?mode=home';
export const HOME_PATH = '/home';
/** The sign-in methods the page offers. Email joins with its own route. */
export const SIGN_IN_METHODS = ['google'] as const;
const RELAY_WAIT_S = 25;
const CHILD_WATCH_MS = 500;
/** How long "Copied" stays. */
const COPIED_MS = 4000;

/** The one Clipboard API call the page makes: it writes an address or a Support ID, it never reads. */
export interface HomeClipboard {
  writeText(text: string): Promise<void>;
}

export interface HomePageDeps {
  win: PageWindow;
  env: HanaEnv;
  api: HomeApi;
  /** The login relay's read (auth/api.ts): Google's answer, written by the callback page. */
  relay: Pick<AuthApi, 'readRelay'>;
  /** Google's signing keys (default: fetched from Google's JWKS). */
  jwks?: (kid: string) => Promise<Jwk | null>;
  deviceNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether an event is a real user gesture (default: `event.isTrusted`). */
  isGesture?: GestureCheck;
  /** The Clipboard API's write (default: `navigator.clipboard` when the browser has one; null: none). */
  clipboard?: HomeClipboard | null;
}

export type HomeStage =
  /** Reading `GET /v1/home/config`. */
  | 'loading'
  /** The page can't offer a sign-in (the config can't be read, or no sign-in is set up); "Try again" reads it again. */
  | 'unavailable'
  | 'signed_out'
  /** The first sign-in's child window is open. */
  | 'signing_in'
  /** A list has been shown for a sign-in. It stays `signed_in` after that sign-in ends: what is on screen stays. */
  | 'signed_in'
  /** Framed, or another fatal start-up problem: nothing else happens. */
  | 'stopped';

/** The Home sign-in's own life, apart from what is on screen. */
export type HomeSession = 'none' | 'active' | 'ending' | 'ended';

export type HomeListState = 'idle' | 'loading' | 'ready' | 'error';

export interface HomePage {
  readonly stage: HomeStage;
  readonly session: HomeSession;
  /** A sign-in child is open while a list is on screen (signing in again). */
  readonly renewing: boolean;
  readonly list: HomeListState;
  /** The listing whose page is open, or null on the front page. */
  readonly openScope: string | null;
  /** The code of the problem on screen, or null. */
  readonly errorCode: string | null;
  /** The sign-in child's window name, once opened. */
  readonly childName: string | null;
  /** The sign-in is prepared and waits for the child's hello. */
  readonly awaitingChild: boolean;
  /** How many Home API requests the page has sent. */
  readonly requests: number;
  /** Resolves once nothing the page started is still running (tests). */
  idle(): Promise<void>;
}

// ---- what the page says ----

export type CoverageTone = 'ok' | 'warn' | 'off' | 'muted';

export interface CoverageText {
  badge: string;
  tone: CoverageTone;
  /** The question above the sentence on the app's page. */
  question: string;
  detail: string;
}

type CoverageKind = 'yes' | 'maybe' | 'no' | 'unknown';
const COVERAGE_KIND: Readonly<Record<HomeCoverage, CoverageKind>> = Object.freeze({ shared: 'yes', hana_client: 'yes', exit: 'yes', email: 'yes', partner_client: 'maybe', none: 'no', unknown: 'unknown' });

const MINE_QUESTION = 'Does this wallet depend on the app?';
const OTHER_QUESTION = 'Would a wallet here depend on the app?';
/**
 * The words say only what is true today. For the user's own app: whether Hana's sign-in to the wallet depends on the
 * app. For any other app, where Hana knows of no wallet of theirs: the same, as an "if". Nothing here promises an
 * action the page doesn't offer.
 */
const COVERAGE_WORDS: Readonly<Record<'mine' | 'other', Readonly<Record<CoverageKind, CoverageText>>>> = Object.freeze({
  mine: {
    yes: { badge: 'Stays reachable', tone: 'ok', question: MINE_QUESTION, detail: 'No. Signing in to this wallet doesn’t depend on the app: it would still work through Hana if the app stopped running.' },
    maybe: { badge: 'Depends on the app', tone: 'warn', question: MINE_QUESTION, detail: 'Yes. This app uses its own Google sign-in, so signing in to this wallet works only while the app keeps that sign-in running.' },
    no: { badge: 'Out of reach', tone: 'off', question: MINE_QUESTION, detail: 'Signing in to this wallet through Hana no longer works: the sign-in this app used is gone. If the app still runs, use the app itself.' },
    unknown: { badge: 'Not checked yet', tone: 'muted', question: MINE_QUESTION, detail: 'Hana hasn’t checked this app yet.' },
  },
  other: {
    yes: { badge: 'Supported', tone: 'ok', question: OTHER_QUESTION, detail: 'No. If you had a wallet in this app, signing in to it would still work through Hana if the app stopped running. Hana has no wallet on record for you here.' },
    maybe: { badge: 'Depends on the app', tone: 'warn', question: OTHER_QUESTION, detail: 'Yes. This app uses its own Google sign-in, so signing in to a wallet here works only while the app keeps that sign-in running. Hana has no wallet on record for you here.' },
    no: { badge: 'Out of reach', tone: 'off', question: OTHER_QUESTION, detail: 'Signing in to wallets in this app through Hana no longer works: the sign-in it used is gone. If the app still runs, use the app itself.' },
    unknown: { badge: 'Not checked yet', tone: 'muted', question: OTHER_QUESTION, detail: 'Hana hasn’t checked this app yet.' },
  },
});

/** How a coverage reads to a user: the badge, and the question and sentence on the app's page. */
export const coverageText = (coverage: HomeCoverage, mine: boolean): CoverageText => COVERAGE_WORDS[mine ? 'mine' : 'other'][COVERAGE_KIND[coverage]];

export interface HomeProblem {
  code: string;
  text: string;
  requestId: string | null;
  /** The sign-in itself was refused: the page asks for a new one instead of showing this. */
  signInAgain: boolean;
}

const UNREACHABLE = 'Hana Home is not reachable right now. Nothing on screen was lost. Try again in a moment.';

/** The sentence for an API refusal's code. Codes of calls a later version of the page makes are here too, so every Home refusal reads the same. */
const PROBLEM_TEXT: Readonly<Record<string, string>> = Object.freeze({
  rate_limited: 'Too many requests. Wait a minute and try again.',
  home_busy: 'Hana Home has reached its limit for today. Try again tomorrow.',
  home_no_wallet: 'There is no wallet for this sign-in in that app.',
  home_account_mismatch: 'Sign in as the same account you used in Hana Home.',
  not_covered: 'Hana can’t open this wallet from here. If the app still runs, use the app itself.',
  link_pending: 'A sign-in method is still being added to this wallet. Try again once that has finished.',
  unknown_scope: 'Hana doesn’t know that app.',
  counter_reused: 'That request was already sent. Try again.',
  bad_request: 'Hana Home couldn’t read that request. Try again.',
  origin_not_allowed: 'Hana Home can’t be used from this address.',
  bad_response: 'Hana Home got an answer it couldn’t read. Try again in a moment.',
  home_directory_unavailable: UNREACHABLE,
  rate_limiter_unavailable: UNREACHABLE,
  near_unavailable: UNREACHABLE,
  api_unavailable: UNREACHABLE,
});

/** A code as the page may show it: the API's lowercase snake case only, so an odd answer can't put text there. */
const shownCode = (code: string): string => (/^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : 'error');
const shownRequestId = (id: string | null): string | null => (id !== null && /^[A-Za-z0-9_-]{1,64}$/u.test(id) ? id : null);

/** What the page says for a failed Home API call. Never the API's own message: only a code picks the sentence. */
export function homeProblem(err: unknown): HomeProblem {
  if (!(err instanceof ApiError)) return { code: 'api_unavailable', text: UNREACHABLE, requestId: null, signInAgain: false };
  const code = shownCode(err.code);
  const requestId = shownRequestId(err.requestId);
  // Every credential refusal is a 401: the sign-in has ended, whatever the code.
  if (err.status === 401) return { code, text: 'Your sign-in to Hana Home has ended. Sign in again to go on.', requestId, signInAgain: true };
  const known = Object.hasOwn(PROBLEM_TEXT, code) ? PROBLEM_TEXT[code] : undefined;
  if (known !== undefined) return { code, text: known, requestId, signInAgain: false };
  if (err.status === 429) return { code, text: PROBLEM_TEXT.rate_limited as string, requestId, signInAgain: false };
  if (err.status >= 500) return { code, text: UNREACHABLE, requestId, signInAgain: false };
  return { code, text: 'Something went wrong. Try again.', requestId, signInAgain: false };
}

const STATUS_TEXT: Readonly<Record<HomeApp['status'], string | null>> = Object.freeze({ active: null, suspended: 'Paused', deleted: 'Closed' });

/** Where a Stellar account can be looked up, by the env's network. An EVM address is the same on every EVM chain, so it gets no single link. */
const STELLAR_ACCOUNT_URL: Readonly<Record<HanaEnv['network'], { name: string; url: string }>> = Object.freeze({
  testnet: { name: 'StellarExpert (testnet)', url: 'https://stellar.expert/explorer/testnet/account/' },
});

function browserClipboard(): HomeClipboard | null {
  try {
    const c = (globalThis as { navigator?: { clipboard?: Partial<HomeClipboard> } }).navigator?.clipboard;
    return c && typeof c.writeText === 'function' ? (c as HomeClipboard) : null;
  } catch {
    return null;
  }
}

/** The app a partner's link names (`/home?appId=app_…`), or null: exactly that one parameter, of the app id's form. */
export function linkedAppId(search: string): string | null {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  if (keys.length !== 1 || keys[0] !== 'appId') return null;
  const values = q.getAll('appId');
  return values.length === 1 && HOME_APP_ID.test(values[0] as string) ? (values[0] as string) : null;
}

/** Who a sign-in is for: the method and that method's id for the person. Memory only. */
interface HomeAccount {
  provider: 'google' | 'email';
  sub: string;
}

interface PendingSignIn {
  identity: HomeIdentity;
  relayId: string;
  relayKey: Uint8Array;
  relayReadKey: Uint8Array;
  params: WindowMessage<'hana:home-params'>;
  helloAccepted: boolean;
}

export function startHomePage(deps: HomePageDeps): HomePage {
  const { win, env, api } = deps;
  const d: Dom = dom(win.document);
  const clock = new ServerClock(deps.deviceNow);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isGesture = deps.isGesture ?? isUserGesture;
  const jwks = deps.jwks ?? googleKeys();
  const clipboard = (): HomeClipboard | null => (deps.clipboard === undefined ? browserClipboard() : deps.clipboard);
  const linkApp = linkedAppId(win.location.search);

  let stage: HomeStage = 'loading';
  let session: HomeSession = 'none';
  let config: HomeConfig | null = null;
  /** The signed-in identity, and the Google account it is for (memory only). */
  let identity: HomeIdentity | null = null;
  let account: HomeAccount | null = null;
  /** Raised on a sign-out or an account change: an answer that started before it is dropped. */
  let epoch = 0;
  let requests = 0;

  // What is on screen.
  let mine: HomeScope[] = [];
  let listed: HomeScope[] = [];
  let nextCursor: string | null = null;
  let search: { term: string; results: HomeScope[] } | null = null;
  let searchDraft = '';
  /** A listing reached only by the partner's link. */
  let linked: HomeScope | null = null;
  let list: HomeListState = 'idle';
  let openScope: string | null = null;
  let problem: HomeProblem | null = null;
  /** Which action is loading, so only its button says so. */
  let busy: 'more' | 'search' | 'check' | null = null;

  // The sign-in in progress.
  let pending: PendingSignIn | null = null;
  let signingIn = false;
  let child: Window | null = null;
  let childName: string | null = null;
  let signInError: HomeProblem | null = null;

  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- idle tracking (tests) ----
  let running = 0;
  let idleWaiters: (() => void)[] = [];
  const track = (p: Promise<unknown>): void => {
    running += 1;
    void p
      .catch(() => {})
      .finally(() => {
        running -= 1;
        if (running === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const w of waiters) w();
        }
      });
  };
  const idle = (): Promise<void> => (running === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)));

  // ---- small view parts ----
  const byId = (id: string): HTMLElement | null => win.document.getElementById(id);
  const fill = (id: string, ...children: Child[]): void => {
    const el = byId(id);
    if (!el) return;
    el.replaceChildren();
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? win.document.createTextNode(c) : c);
  };
  /** A button that acts only on a real click. */
  const button = (label: string, onClick: (e: Event) => void, props: { class?: string; id?: string; ariaLabel?: string; disabled?: boolean } = {}): HTMLButtonElement => {
    const b = d.h('button', { ...(props.class ? { class: props.class } : {}), attrs: { type: 'button', ...(props.id ? { id: props.id } : {}), ...(props.ariaLabel ? { 'aria-label': props.ariaLabel } : {}) } }, label);
    if (props.disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', (e) => {
      if (isGesture(e)) onClick(e);
    });
    return b;
  };
  const focusHeading = (id: string): void => {
    try {
      byId(id)?.focus();
    } catch {
      // Focus is a convenience.
    }
  };
  const badge = (text: string, tone: CoverageTone | 'plain'): HTMLElement => d.h('span', { class: `badge badge-${tone}` }, text);

  const problemView = (p: HomeProblem, id: string, onDismiss?: () => void): HTMLElement =>
    d.h(
      'div',
      { class: 'home-problem', attrs: { role: 'alert', id } },
      d.h('p', {}, p.text),
      d.h('p', { class: 'code muted' }, `Code: ${p.code}`),
      p.requestId ? d.h('p', { class: 'code muted' }, `Request: ${p.requestId}`) : null,
      onDismiss ? button('Dismiss', onDismiss, { class: 'link' }) : null,
    );

  // ---- the sign-in's life ----
  const clearSessionTimers = (): void => {
    clearTimeout(warnTimer);
    clearTimeout(endTimer);
    warnTimer = undefined;
    endTimer = undefined;
  };

  /** The sign-in has ended (its 15 minutes, or a 401): the key and token are dropped; the screen stays as it is. */
  function endSession(): void {
    clearSessionTimers();
    identity?.end();
    identity = null;
    if (session === 'none') return;
    session = 'ended';
    renderBanner();
  }

  /** Brings `session` up to date with the clock. Timers can fire late (a sleeping laptop), so every request checks too. */
  function checkSession(): void {
    if (!identity || session === 'none' || session === 'ended') return;
    const left = identity.expiresAtMs - clock.now();
    if (left <= 0) endSession();
    else if (left <= HOME_EXPIRY_WARN_MS && session !== 'ending') {
      session = 'ending';
      renderBanner();
    }
  }

  function scheduleSession(id: HomeIdentity): void {
    clearSessionTimers();
    const left = id.expiresAtMs - clock.now();
    warnTimer = setTimeout(checkSession, Math.max(0, left - HOME_EXPIRY_WARN_MS));
    endTimer = setTimeout(checkSession, Math.max(0, left));
  }

  // ---- requests: one at a time per action, never repeated by the page ----
  /**
   * Runs one Home API call with the current identity. Null when it wasn't sent (no usable sign-in) or failed: the
   * problem is then on screen, and the page sends nothing more until the user acts.
   */
  async function request(query: HomeAppsQuery): Promise<HomeAppsPage | null> {
    checkSession();
    const id = identity;
    if (!id || !id.usable) {
      if (session !== 'ended') endSession();
      return null;
    }
    const at = epoch;
    requests += 1;
    try {
      const page = await api.apps(id, query);
      return at === epoch ? page : null;
    } catch (err) {
      if (at !== epoch) return null;
      // The sign-in this request belonged to is gone (it ended, or a new one replaced it while the request was on its
      // way): whatever it answered says nothing about Hana Home now, so nothing is shown and nothing is sent again.
      if (identity !== id) return null;
      const p = homeProblem(err);
      // A 401 ends this sign-in.
      if (p.signInAgain) {
        endSession();
        return null;
      }
      problem = p;
      return null;
    }
  }

  const allScopes = (): HomeScope[] => [...mine, ...(linked ? [linked] : []), ...(search?.results ?? []), ...listed];
  const findScope = (scopeId: string): HomeScope | null => allScopes().find((s) => s.scopeId === scopeId) ?? null;
  /** Puts a fresher copy of a listing wherever it is shown. */
  function replaceScope(fresh: HomeScope): void {
    const swap = (rows: HomeScope[]): HomeScope[] => rows.map((s) => (s.scopeId === fresh.scopeId ? fresh : s));
    mine = swap(mine);
    listed = swap(listed);
    if (search) search = { term: search.term, results: swap(search.results) };
    if (linked?.scopeId === fresh.scopeId) linked = fresh;
  }

  async function loadFirst(): Promise<void> {
    list = 'loading';
    problem = null;
    renderContent();
    const at = epoch;
    const page = await request({ kind: 'first' });
    if (at !== epoch) return;
    if (!page) {
      list = mine.length + listed.length > 0 ? 'ready' : 'error';
      renderContent();
      return;
    }
    mine = page.scopes.filter((s) => s.mine);
    listed = page.scopes.filter((s) => !s.mine);
    nextCursor = page.nextCursor;
    list = 'ready';
    renderContent();
    // The partner's link names one app: read it once. Only an app that is the user's own opens straight away. Any
    // other is the partner's words about an app Hana knows no wallet of theirs in, so the user's own list comes first
    // and the linked app sits below it under Hana's own notice.
    if (linkApp && !linked) {
      const hasLinked = (s: HomeScope): boolean => s.apps.some((a) => a.appId === linkApp);
      const own = mine.find(hasLinked);
      if (own) {
        openApp(own.scopeId);
        return;
      }
      const known = listed.find(hasLinked);
      if (known) {
        linked = known;
        listed = listed.filter((s) => s.scopeId !== known.scopeId);
        renderContent();
        return;
      }
      const one = await request({ kind: 'app', appId: linkApp });
      if (at !== epoch) return;
      const found = one?.scopes[0];
      if (found?.mine) {
        mine = [found, ...mine.filter((s) => s.scopeId !== found.scopeId)];
        openApp(found.scopeId);
      } else if (found) {
        linked = found;
        renderContent();
      } else {
        if (one) problem = { code: 'app_not_found', text: 'Hana Home couldn’t find the app this link is for.', requestId: null, signInAgain: false };
        renderContent();
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || busy) return;
    busy = 'more';
    problem = null;
    renderContent();
    const at = epoch;
    const page = await request({ kind: 'cursor', cursor: nextCursor });
    if (at !== epoch) return;
    busy = null;
    if (page) {
      const have = new Set(allScopes().map((s) => s.scopeId));
      listed = [...listed, ...page.scopes.filter((s) => !have.has(s.scopeId))];
      nextCursor = page.nextCursor;
    }
    renderContent();
  }

  async function runSearch(): Promise<void> {
    if (busy) return;
    const term = searchDraft.trim();
    const length = [...term].length;
    if (length < HOME_SEARCH_MIN || length > HOME_SEARCH_MAX) {
      problem = { code: 'search_term', text: `Type ${HOME_SEARCH_MIN} to ${HOME_SEARCH_MAX} characters of the app’s name.`, requestId: null, signInAgain: false };
      renderContent();
      return;
    }
    busy = 'search';
    problem = null;
    renderContent();
    const at = epoch;
    const page = await request({ kind: 'search', term });
    if (at !== epoch) return;
    busy = null;
    if (page) search = { term, results: page.scopes };
    renderContent();
    if (page) focusHeading('home-results-title');
  }

  /** Reads one listing again: its coverage when the list couldn't say. A user's own listing by its id, another by its app. */
  async function checkScope(scope: HomeScope): Promise<void> {
    if (busy) return;
    const first = scope.apps[0];
    const query: HomeAppsQuery | null = scope.mine || !first ? { kind: 'scope', scopeId: scope.scopeId } : { kind: 'app', appId: first.appId };
    busy = 'check';
    problem = null;
    renderContent();
    const at = epoch;
    const page = await request(query);
    if (at !== epoch) return;
    busy = null;
    const fresh = page?.scopes.find((s) => s.scopeId === scope.scopeId);
    if (fresh) replaceScope(fresh);
    renderContent();
  }

  function openApp(scopeId: string): void {
    const scope = findScope(scopeId);
    if (!scope) return;
    openScope = scopeId;
    problem = null;
    renderContent();
    focusHeading('home-app-title');
    // Opening an app's page is the user asking about it: one read, when the list couldn't say.
    if (scope.coverage === 'unknown' && session !== 'ended') track(checkScope(scope));
  }

  function closeApp(): void {
    openScope = null;
    problem = null;
    renderContent();
    focusHeading('home-title');
  }

  // ---- sign-in ----
  function wipePending(): void {
    if (!pending) return;
    pending.relayKey.fill(0);
    pending.relayReadKey.fill(0);
    pending.params.relayKey.fill(0);
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

  /** The sign-in attempt is over without a new identity: back to where the page was. */
  function signInFailed(p: HomeProblem | null): void {
    if (pending) pending.identity.end();
    wipePending();
    closeChild();
    signingIn = false;
    if (stage === 'signing_in') {
      stage = 'signed_out';
      signInError = p;
      renderSignedOut();
    } else {
      if (p) problem = p;
      renderBanner();
      renderNotice();
    }
  }

  const plain = (code: string, text: string): HomeProblem => ({ code, text, requestId: null, signInAgain: false });

  /**
   * The click: opens the child sign-in window synchronously, before any await (a window opened after one loses the
   * user's activation in some browsers), then makes this sign-in's key while the child loads. The child repeats its
   * hello every 100 ms, so one that arrives early is answered by a later one.
   */
  function beginSignIn(): void {
    if (signingIn || !config?.sharedGoogleClientId || stage === 'loading' || stage === 'stopped' || stage === 'unavailable') return;
    signingIn = true;
    signInError = null;
    childName = randomName('hana-home-login-');
    child = win.open(`${env.authOrigin}${HOME_LOGIN_CHILD}`, childName, 'popup,width=480,height=640');
    if (!child) {
      signingIn = false;
      const blocked = plain('popup_blocked', 'Your browser blocked the sign-in window. Allow pop-ups for this page and try again.');
      if (stage === 'signed_out') {
        signInError = blocked;
        renderSignedOut();
      } else {
        problem = blocked;
        renderNotice();
      }
      return;
    }
    if (stage === 'signed_out') {
      stage = 'signing_in';
      d.show(
        d.h(
          'section',
          { class: 'panel home' },
          d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, 'Signing in to Hana Home'),
          d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Finish signing in with Google in the other window.'),
          d.h('div', { class: 'actions' }, button('Cancel', () => signInFailed(null), { id: 'home-cancel' })),
        ),
      );
    } else {
      renderBanner();
    }
    const opened = child;
    // A child closed before it connected: offer a new attempt. After the hello the handle isn't watched, because
    // Google's pages may make it report `closed`; Cancel and the time limit cover that.
    const watch = setInterval(() => {
      if (child !== opened || !signingIn || pending?.helloAccepted) {
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
        signInFailed(plain('login_cancelled', 'The sign-in window closed before it finished. Try again.'));
      }
    }, CHILD_WATCH_MS);
    track(prepare(opened, config));
  }

  async function prepare(opened: Window, cfg: HomeConfig): Promise<void> {
    const clientId = cfg.sharedGoogleClientId as string;
    let made: HomeIdentity;
    try {
      made = await newHomeIdentity(env.signer, clock.now());
    } catch (e) {
      if (child === opened && signingIn) signInFailed(plain('derive_failed', sessionKeyText(sessionKeyFailure(e))));
      return;
    }
    if (child !== opened || !signingIn) {
      made.end();
      return;
    }
    const relayKey = randomBytes(RELAY_KEY_BYTES);
    const relayReadKey = randomBytes(32);
    const relayId = relayIdFor(relayReadKey);
    const params: WindowMessage<'hana:home-params'> = {
      v: 1,
      t: 'hana:home-params',
      signer: env.signer,
      clientId,
      homePublicKey: Uint8Array.from(made.publicKey),
      expiresAtMs: made.expiresAtMs,
      salt: Uint8Array.from(made.salt),
      nonce: made.nonce,
      relayId,
      relayKey: Uint8Array.from(relayKey),
    };
    pending = { identity: made, relayId, relayKey, relayReadKey, params, helloAccepted: false };
  }

  /** Whether `w` is on this origin at `/login?mode=home`. A window whose address can't be read (another origin) isn't. */
  function childAtLogin(w: Window): boolean {
    try {
      return `${w.location.pathname}${w.location.search}` === HOME_LOGIN_CHILD;
    } catch {
      return false;
    }
  }

  /** The only messages the page takes: its own child's hello, answered once with this sign-in's parameters. */
  function onMessage(event: Event): void {
    const e = event as MessageEvent;
    const p = pending;
    if (!p || p.helloAccepted || child === null || e.source !== child || e.origin !== env.authOrigin) return;
    if (!parseWindowMessage(e.data, ['hana:auth-hello'])) return;
    // The mirror of the child's own check: the window that gets the relay key is at the sign-in child's address.
    if (!childAtLogin(child)) return;
    p.helloAccepted = true;
    try {
      child.postMessage(p.params, env.authOrigin);
    } catch {
      signInFailed(plain('login_cancelled', 'The sign-in window closed. Try again.'));
      return;
    } finally {
      // postMessage cloned it; the page keeps only its own copy of the relay key, for the decrypt.
      p.params.relayKey.fill(0);
    }
    track(awaitToken(p));
  }

  /** Long-polls the relay for Google's answer, checks the token, and signs in. */
  async function awaitToken(p: PendingSignIn): Promise<void> {
    const cfg = config as HomeConfig;
    const deadline = clock.now() + HOME_LOGIN_LIMIT_MS;
    const readKey = base64UrlEncode(p.relayReadKey);
    let value: RelayReadResponse | null = null;
    while (value === null) {
      if (pending !== p) return;
      if (clock.now() > deadline) return signInFailed(plain('login_timeout', 'The sign-in took too long. Try again.'));
      try {
        value = await deps.relay.readRelay(p.relayId, readKey, RELAY_WAIT_S);
      } catch (err) {
        if (pending !== p) return;
        // A slot that is gone or forbidden never recovers; anything else is the wait itself failing, so it goes on.
        if (err instanceof ApiError && (err.status === 410 || err.status === 403)) return signInFailed(plain('token_invalid', 'Google’s answer could not be read. Try again.'));
        await sleep(1000);
      }
    }
    if (pending !== p) return;
    clock.sync(value.serverTimeMs);
    closeChild();

    let failure: HomeProblem | null = null;
    let token: string | null = null;
    let who: string | null = null;
    try {
      const payload = await decryptRelayPayload(p.relayKey, p.relayId, value);
      if ('error' in payload) {
        failure = payload.error === 'access_denied' ? plain('login_cancelled', 'The sign-in was cancelled.') : plain('google_error', 'Google did not complete the sign-in. Try again.');
      } else if (!isRelayToken(payload) || payload.accessToken !== undefined || payload.access !== undefined || payload.caseB !== undefined || payload.as !== undefined || isJsonFormToken(payload.idToken)) {
        failure = plain('token_invalid', 'Google’s answer could not be verified. Try again.');
      } else {
        const checked = await verifyGoogleIdToken(payload.idToken, { clientId: cfg.sharedGoogleClientId as string, nonce: p.identity.nonce, nowMs: clock.now(), jwks }).catch(() => null);
        if (checked === null) failure = plain('api_unavailable', 'Google’s keys could not be read. Try again.');
        else if (!checked.ok) failure = checked.code === 'token_has_pii' ? plain('token_has_pii', 'Google returned more account details than Hana accepts, so the sign-in was stopped.') : plain('token_invalid', 'Google’s answer could not be verified. Try again.');
        else {
          token = payload.idToken;
          who = checked.token.sub;
        }
      }
    } catch {
      failure = plain('token_invalid', 'Google’s answer could not be read. Try again.');
    }
    if (pending !== p) return;
    if (failure || token === null || who === null) return signInFailed(failure ?? plain('token_invalid', 'Google’s answer could not be verified. Try again.'));
    if (clock.now() >= p.identity.expiresAtMs) return signInFailed(plain('login_timeout', 'The sign-in took too long. Try again.'));

    p.identity.attach(token);
    token = null;
    const next = p.identity;
    pending = null;
    p.relayKey.fill(0);
    p.relayReadKey.fill(0);
    signingIn = false;
    signedIn(next, { provider: 'google', sub: who });
  }

  /** A sign-in finished. The same account keeps the screen as it is and fetches nothing; another account starts over. */
  function signedIn(next: HomeIdentity, who: HomeAccount): void {
    // The same person is the same sign-in method and the same id from it: two methods can use the same id for two people.
    const same = stage === 'signed_in' && account !== null && account.provider === who.provider && account.sub === who.sub;
    identity?.end();
    identity = next;
    account = who;
    session = 'active';
    signInError = null;
    scheduleSession(next);
    if (same) {
      problem = null;
      renderBanner();
      renderNotice();
      checkSession();
      return;
    }
    epoch += 1;
    clearScreen();
    stage = 'signed_in';
    renderShell();
    checkSession();
    track(loadFirst());
  }

  function clearScreen(): void {
    mine = [];
    listed = [];
    nextCursor = null;
    search = null;
    searchDraft = '';
    linked = null;
    list = 'idle';
    openScope = null;
    problem = null;
    busy = null;
  }

  function signOut(): void {
    epoch += 1;
    clearSessionTimers();
    if (pending) pending.identity.end();
    wipePending();
    closeChild();
    signingIn = false;
    identity?.end();
    identity = null;
    account = null;
    session = 'none';
    clearScreen();
    stage = 'signed_out';
    signInError = null;
    renderSignedOut();
  }

  // ---- screens ----
  function renderSignedOut(): void {
    const start = button('Continue with Google', beginSignIn, { class: 'primary', id: 'home-sign-in' });
    d.show(
      d.h(
        'section',
        { class: 'panel home' },
        d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, 'Hana Home'),
        d.h('p', {}, 'See the apps you use with Hana and your wallet addresses in each of them, in one place.'),
        d.h('p', { class: 'muted' }, 'Sign in with the Google account you use in those apps. You stay signed in for 15 minutes, and not after you close or reload this page.'),
        signInError ? problemView(signInError, 'home-sign-in-problem') : null,
        d.h('div', { class: 'actions choose' }, start),
      ),
    );
  }

  function renderUnavailable(p: HomeProblem): void {
    stage = 'unavailable';
    signInError = p;
    d.show(
      d.h(
        'section',
        { class: 'panel home' },
        d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, 'Hana Home'),
        problemView(p, 'home-sign-in-problem'),
        d.h('div', { class: 'actions' }, button('Try again', () => track(loadConfig()), { class: 'primary', id: 'home-retry' })),
      ),
    );
  }

  /** The signed-in page's frame: built once per sign-in, so a banner or a notice never rebuilds what the user is reading. */
  function renderShell(): void {
    d.show(
      d.h(
        'section',
        { class: 'panel home' },
        d.h(
          'header',
          { class: 'home-head' },
          d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, 'Hana Home'),
          d.h('p', { class: 'home-who' }, d.h('span', { class: 'muted' }, 'Signed in with Google'), button('Sign out', signOut, { id: 'home-sign-out' })),
        ),
        d.h('div', { attrs: { id: 'home-banner', 'aria-live': 'polite' } }),
        d.h('div', { attrs: { id: 'home-notice' } }),
        d.h('div', { attrs: { id: 'home-content' } }),
      ),
    );
    renderBanner();
    renderContent();
  }

  function renderBanner(): void {
    if (stage !== 'signed_in') return;
    if (signingIn) {
      fill('home-banner', d.h('div', { class: 'home-banner note' }, d.h('p', {}, 'Finish signing in with Google in the other window.'), button('Cancel', () => signInFailed(null), { id: 'home-cancel' })));
      return;
    }
    const again = () => button('Sign in again', beginSignIn, { class: 'primary', id: 'home-sign-in-again' });
    if (session === 'ending' && identity) {
      const minutes = Math.max(1, Math.ceil((identity.expiresAtMs - clock.now()) / 60_000));
      fill(
        'home-banner',
        d.h(
          'div',
          { class: 'home-banner note', attrs: { id: 'home-ending' } },
          d.h('p', {}, `Your sign-in to Hana Home ends in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Everything on screen stays. To load anything new after that, sign in again.`),
          again(),
        ),
      );
    } else if (session === 'ended') {
      fill(
        'home-banner',
        d.h('div', { class: 'home-banner note', attrs: { id: 'home-ended' } }, d.h('p', {}, 'Your sign-in to Hana Home has ended. Everything on screen stays. To load anything new, sign in again.'), again()),
      );
    } else {
      fill('home-banner');
    }
  }

  function renderNotice(): void {
    if (stage !== 'signed_in') return;
    fill(
      'home-notice',
      problem
        ? problemView(problem, 'home-problem', () => {
            problem = null;
            renderNotice();
          })
        : null,
    );
  }

  /** An app's state badges ("Paused", "Closed", "Test app"), if any. */
  const appBadges = (app: HomeApp): Child[] => {
    const status = STATUS_TEXT[app.status];
    return [status ? badge(status, 'plain') : null, app.environment === 'test' ? badge('Test app', 'plain') : null];
  };

  /** Where an app runs: its origins, as text (never links), or null when it has none. */
  function appOrigins(app: HomeApp, limit: number): HTMLElement | null {
    const shown = app.origins.slice(0, limit);
    const more = app.origins.length - shown.length;
    if (shown.length === 0) return null;
    return d.h('p', { class: 'home-app-origins' }, ...shown.flatMap((o, i) => [i > 0 ? ' ' : null, d.h('span', { class: 'origin' }, o)]), more > 0 ? d.h('span', { class: 'muted' }, ` and ${more} more`) : null);
  }

  /** One app of a listing: its logo, name and state, and where it runs. All of it partner-supplied, all of it text. */
  function appLine(app: HomeApp, originLimit: number): HTMLElement {
    return d.h(
      'div',
      { class: 'home-app' },
      appLogo(d, env, app.logoUrl),
      d.h('div', { class: 'home-app-text' }, d.h('p', { class: 'home-app-name' }, d.h('strong', {}, app.name), ...appBadges(app)), appOrigins(app, originLimit)),
    );
  }

  const scopeTitle = (scope: HomeScope): string => scope.apps[0]?.name ?? 'An app that is no longer listed';

  function scopeCard(scope: HomeScope): HTMLElement {
    const cover = coverageText(scope.coverage, scope.mine);
    return d.h(
      'li',
      { class: 'home-card', attrs: { 'data-scope': scope.scopeId } },
      scope.apps.length > 0 ? d.h('div', { class: 'home-card-apps' }, ...scope.apps.map((a) => appLine(a, 1))) : d.h('p', { class: 'muted' }, scopeTitle(scope)),
      d.h('div', { class: 'home-card-foot' }, badge(cover.badge, cover.tone), button('View', () => openApp(scope.scopeId), { class: 'home-open', ariaLabel: `View ${scopeTitle(scope)}` })),
    );
  }

  const cards = (rows: HomeScope[]): HTMLElement => d.h('ul', { class: 'home-cards' }, ...rows.map(scopeCard));

  function renderContent(): void {
    if (stage !== 'signed_in') return;
    renderNotice();
    const open = openScope ? findScope(openScope) : null;
    if (open) fill('home-content', ...appPage(open));
    else fill('home-content', ...frontPage());
  }

  function frontPage(): Child[] {
    const loading = list === 'loading' || list === 'idle';
    const input = d.h('input', { attrs: { id: 'home-search', type: 'search', maxlength: String(HOME_SEARCH_MAX), autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'home-search-help' } });
    input.value = searchDraft;
    input.addEventListener('input', () => {
      searchDraft = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && isGesture(e)) track(runSearch());
    });
    const others = listed.filter((s) => s.scopeId !== linked?.scopeId);
    return [
      d.h('h2', { attrs: { id: 'home-mine-title' } }, 'Your apps'),
      loading
        ? d.h('p', { class: 'muted', attrs: { role: 'status', id: 'home-loading' } }, 'Loading your apps…')
        : list === 'error'
          ? d.h('div', { class: 'actions start' }, button('Try again', () => track(loadFirst()), { class: 'primary', id: 'home-reload' }))
          : mine.length > 0
            ? cards(mine)
            : d.h('p', { class: 'muted', attrs: { id: 'home-empty' } }, 'No apps yet for this Google account. An app appears here once you have signed in to it with Hana.'),
      list === 'ready' && linked && !mine.some((s) => s.scopeId === linked?.scopeId)
        ? d.h(
            'section',
            { attrs: { id: 'home-linked', 'aria-labelledby': 'home-linked-title' } },
            d.h('h2', { attrs: { id: 'home-linked-title' } }, 'The app from your link'),
            d.h('p', { class: 'note' }, 'The link you opened is for the app below. Hana has no wallet on record for this Google account in it. Its name and address are the app’s own, not Hana’s.'),
            cards([linked]),
          )
        : null,
      list === 'ready'
        ? d.h(
            'section',
            { class: 'home-find', attrs: { role: 'search', 'aria-labelledby': 'home-find-title' } },
            d.h('h2', { attrs: { id: 'home-find-title' } }, 'Find an app'),
            d.h('label', { attrs: { for: 'home-search' } }, 'App name', input),
            d.h('p', { class: 'muted', attrs: { id: 'home-search-help' } }, 'Some apps appear only when you type their whole name.'),
            d.h(
              'div',
              { class: 'actions start' },
              button(busy === 'search' ? 'Searching…' : 'Search', () => track(runSearch()), { id: 'home-search-go', disabled: busy !== null }),
              search
                ? button(
                    'Clear',
                    () => {
                      search = null;
                      searchDraft = '';
                      problem = null;
                      renderContent();
                    },
                    { id: 'home-search-clear' },
                  )
                : null,
            ),
            search
              ? d.h(
                  'div',
                  { attrs: { id: 'home-results' } },
                  d.h('h3', { attrs: { id: 'home-results-title', tabindex: '-1' } }, 'Results for ', d.h('strong', {}, search.term)),
                  search.results.length > 0 ? cards(search.results) : d.h('p', { class: 'muted' }, 'No app found with that name.'),
                )
              : null,
          )
        : null,
      list === 'ready' && !search && others.length > 0
        ? d.h(
            'section',
            { attrs: { 'aria-labelledby': 'home-others-title' } },
            d.h('h2', { attrs: { id: 'home-others-title' } }, 'Other apps that use Hana'),
            cards(others),
            nextCursor ? d.h('div', { class: 'actions start' }, button(busy === 'more' ? 'Loading…' : 'Show more', () => track(loadMore()), { id: 'home-more', disabled: busy !== null })) : null,
          )
        : null,
    ];
  }

  let copied: string | null = null;
  function copyButton(what: string, value: string, id: string): HTMLButtonElement {
    return button(
      'Copy',
      () => {
        const c = clipboard();
        const done = (text: string) => {
          copied = text;
          fill('home-copied', text);
          clearTimeout(copiedTimer);
          copiedTimer = setTimeout(() => {
            copied = null;
            fill('home-copied');
          }, COPIED_MS);
        };
        if (!c) return done(`This browser can’t copy for you. Select the ${what} and copy it yourself.`);
        track(
          c.writeText(value).then(
            () => done(`Copied the ${what}.`),
            () => done(`This browser didn’t allow the copy. Select the ${what} and copy it yourself.`),
          ),
        );
      },
      { class: 'home-copy', id, ariaLabel: `Copy the ${what}` },
    );
  }

  /** One listing's page: its apps, whether Hana can open the wallet, the addresses on record and the Support ID. */
  function appPage(scope: HomeScope): Child[] {
    const cover = coverageText(scope.coverage, scope.mine);
    const stellar = STELLAR_ACCOUNT_URL[env.network];
    const addressRows = scope.addresses.map((a) => {
      const name = a.chain === 'stellar' ? 'Stellar address' : 'EVM address';
      return d.h(
        'div',
        { class: 'home-address' },
        d.h('p', { class: 'home-address-label' }, a.chain === 'stellar' ? 'Stellar' : 'EVM (Ethereum and similar networks)'),
        d.h('p', { class: 'mono home-address-value', attrs: { id: `home-address-${a.chain}` } }, a.address),
        d.h(
          'p',
          { class: 'home-address-actions' },
          copyButton(name, a.address, `home-copy-${a.chain}`),
          // The link is built from a fixed address of Hana's choosing and an address of the chain's own form.
          a.chain === 'stellar' && stellar ? d.h('a', { class: 'explorer', attrs: { href: `${stellar.url}${encodeURIComponent(a.address)}`, target: '_blank', rel: 'noopener noreferrer' } }, `View on ${stellar.name}`) : null,
        ),
      );
    });
    return [
      button('Back to all apps', closeApp, { class: 'link', id: 'home-back' }),
      // The heading is Hana's own words, always. An app's name is the partner's: it is a labelled value in the box below
      // ("App"), never the heading of a page on Hana's origin.
      d.h('h2', { attrs: { id: 'home-app-title', tabindex: '-1' } }, 'App details'),
      d.h('h3', { attrs: { id: 'home-app-label' } }, scope.apps.length > 1 ? 'Apps that share one wallet' : 'App'),
      scope.apps.length > 0 ? d.h('div', { class: 'home-card-apps home-app-all', attrs: { 'aria-labelledby': 'home-app-label', role: 'group' } }, ...scope.apps.map((a) => appLine(a, 5))) : d.h('p', { class: 'muted' }, scopeTitle(scope)),
      d.h('h3', {}, cover.question),
      d.h('p', { attrs: { id: 'home-coverage' } }, badge(cover.badge, cover.tone), ' ', busy === 'check' ? 'Checking…' : cover.detail),
      scope.coverage === 'unknown' && busy !== 'check' ? d.h('div', { class: 'actions start' }, button('Check now', () => track(checkScope(scope)), { id: 'home-check' })) : null,
      d.h('h3', {}, 'Your addresses'),
      addressRows.length > 0
        ? d.h('div', { class: 'home-addresses' }, ...addressRows)
        : d.h('p', { class: 'muted', attrs: { id: 'home-no-address' } }, scope.mine ? 'Hana has no address on record for you in this app yet.' : 'Hana has no wallet on record for this Google account in this app.'),
      scope.supportId
        ? d.h(
            'div',
            { class: 'home-support' },
            d.h('h3', {}, 'Support ID'),
            d.h('p', {}, d.h('span', { class: 'mono', attrs: { id: 'home-support-id' } }, scope.supportId), ' ', copyButton('Support ID', scope.supportId, 'home-copy-support')),
            d.h('p', { class: 'muted' }, 'Give this to the app’s support team if you need help. It doesn’t reveal your email or your Google account.'),
          )
        : null,
      d.h('p', { class: 'copy-status', attrs: { id: 'home-copied', role: 'status' } }, copied),
      // Where the per-app tools go: moving the wallet out, and the devices signed in to it.
      d.h('div', { attrs: { id: 'home-app-extras' } }),
    ];
  }

  // ---- start ----
  async function loadConfig(): Promise<void> {
    stage = 'loading';
    d.show(d.h('section', { class: 'panel home' }, d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, 'Hana Home'), d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Loading…')));
    try {
      config = await api.config();
    } catch (err) {
      renderUnavailable(homeProblem(err));
      return;
    }
    clock.sync(config.serverTimeMs);
    if (config.signer !== env.signer) return renderUnavailable(plain('config_mismatch', 'Hana Home’s settings don’t match this page, so sign-in is off. Try again later.'));
    if (!config.sharedGoogleClientId) return renderUnavailable(plain('no_google_client', 'Hana Home can’t sign you in right now. Try again later.'));
    stage = 'signed_out';
    signInError = null;
    renderSignedOut();
  }

  if (isFramed(win)) {
    stage = 'stopped';
    signInError = plain('config_mismatch', 'Hana Home can’t run inside another page.');
    d.show(d.h('section', { class: 'panel error', attrs: { role: 'alert' } }, d.h('h1', {}, 'Hana Home stopped'), d.h('p', {}, signInError.text)));
  } else {
    // Whoever opened this window gets no handle on it from here on.
    try {
      (win as { opener: unknown }).opener = null;
    } catch {
      // A browser that refuses the write still gives the opener nothing: the page takes no message from it.
    }
    win.addEventListener('message', onMessage);
    // A timer can fire late after the device slept: look again whenever the page is shown or focused.
    for (const type of ['focus', 'pageshow', 'visibilitychange']) win.addEventListener(type, () => checkSession());
    track(loadConfig());
  }

  return {
    get stage() {
      return stage;
    },
    get session() {
      return session;
    },
    get renewing() {
      return signingIn && stage === 'signed_in';
    },
    get list() {
      return list;
    },
    get openScope() {
      return openScope;
    },
    get errorCode() {
      return (stage === 'signed_in' ? problem : signInError)?.code ?? null;
    },
    get childName() {
      return childName;
    },
    get awaitingChild() {
      return pending !== null && !pending.helloAccepted;
    },
    get requests() {
      return requests;
    },
    idle,
  };
}
