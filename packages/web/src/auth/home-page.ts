// `GET {authOrigin}/home`: Passport Home (was Hana Home). One Journear page where a user signs in with Google or an
// email code and sees their wallets in the apps they use with Journear, whether Journear can still open each, its
// addresses and its Support ID. Looking derives no key and sends no chain transaction: the lists come from
// `GET /v1/home/apps`.
//
// Its views (structure A, D888, D893), all at the one address `/home`:
//   - "Your wallets", the front page: the user's wallets as rows (one per listing; a row names the apps that share the
//     wallet), "Your account" (two rows: "Devices and auto-approve" and "Your name", each opening its own view), and
//     "Other apps" last (find an app by name, and the apps where Journear has no wallet on record for the user);
//   - a wallet's page, "Wallet details" ("App details" for an app where the user has no wallet): the apps, whether the
//     wallet needs them, its addresses, its Support ID, then its tools: "Devices and auto-approve" (home-devices.ts),
//     "Ways to sign in" (home-sign-ins.ts, D874), "Your name" (home-profile.ts, D714) and, last, a collapsed section
//     that lets the user open the wallet and take its private key to another wallet app (home-export.ts): it does
//     nothing until the user expands it and signs in again, and nothing in the page's address can open or start it;
//   - "Devices and auto-approve" and "Your name" for every wallet.
// Each view's `h1` names it, and so does the window's title ("Your wallets – Passport Home"). The browser's Back and
// Forward move between the front page and a view (D893): opening a view adds a history entry at the same address that
// carries only an opaque marker (`HomeSteps`), so Back returns to "Your wallets" instead of leaving Home and its
// sign-in; Back from the front page leaves Home as before.
//
// Sign-in, with Google or an email code (`SIGN_IN_METHODS`). Google: a click opens a child `/login?mode=home` (as the
// export window opens its own), which takes `hana:home-params` only from this page, goes to Google with a nonce that
// commits to a key made for this sign-in, and relays Google's answer through the login relay. The shared Google client
// is used while one is in force, else Hana Home's exit client (D490), whose answer comes back through `/home/callback`
// (D491). This page checks the token against Google's keys. Email (D463): the code screens are on this page
// (home-email.ts); the issuer's Home route signs a token whose nonce commits to the key, and the API checks it against
// the chain's email keys. Then every API call is signed with that key (home-api.ts). A new sign-in always makes a new
// key. Two methods are two accounts, even with the same id (D559).
//
// The sign-in lasts 15 minutes. The page tells its end from the identity's own end and from a 401; it warns two
// minutes before; when it ends, everything on screen stays and nothing is fetched until the user signs in again; no
// request is ever sent again by the page itself.
//
// SECURITY:
// - The identity (key, token, `sub`) is in memory only: never in storage, a URL, a message other than the one to the
//   child (which carries the public key and the relay key, no token) or a log. So is an email sign-in's address: it is
//   sent to the issuer only, and kept for the sign-in it was typed for (opening a wallet sends its code there).
// - The page never changes its own address (D555). The history entries it adds (D893) hold one opaque string: a random
//   tag made for the sign-in and the step's number. Which view a step shows, and for whom, is in this page's memory
//   only, so a reload, a sign-out or another account leaves entries that show nothing.
// - App names, origins and logos are partner-supplied. They reach the page only as text nodes, attribute values that
//   aren't URLs, and a logo `<img>` pinned to this build's files origin (logo.ts). Nothing here builds markup from a
//   string, and no partner string becomes a link.
// - The page drops its opener at load, refuses to run framed, takes messages only from its own child window, and acts
//   only on real clicks in its own page.
import { ApiError, HOME_EMAIL_AUDIENCE, type Jwk, RELAY_KEY_BYTES, type RelayReadResponse, type WindowMessage, base64UrlEncode, decryptRelayPayload, isJsonFormToken, isRelayToken, parseWindowMessage, randomBytes, relayIdFor, sessionKeyFailure, verifyGoogleIdToken } from '@hana-id/core';
import { BRAND } from '@hana-id/brand';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { ServerClock } from './clock.ts';
import { type Child, type Dom, addressText, dom, headingText, maskedAddress, originText, supportCode, supportRequest } from './dom.ts';
import { sessionKeyText } from './errors.ts';
import { googleKeys } from './google-keys.ts';
import { HOME_APP_ID, HOME_SEARCH_MAX, HOME_SEARCH_MIN, type HomeAddress, type HomeApi, type HomeApp, type HomeAppsPage, type HomeAppsQuery, type HomeConfig, type HomeCoverage, type HomeIdentity, type HomeScope, newHomeIdentity } from './home-api.ts';
import { HOME_DEVICES_TITLE, type HomeDevices, devicesLinked, startHomeDevices } from './home-devices.ts';
import { HOME_NAME_TITLE, type HomeProfileSection, startHomeProfile } from './home-profile.ts';
import { type HomeSignIns, startHomeSignIns } from './home-sign-ins.ts';
import { EMAIL_SUB_RE, type HomeEmailApi, type HomeEmailStep, emailTokenClaims, homeEmailStep } from './home-email.ts';
import { type HomeExport, type HomeExportState, homeExportRoute, startHomeExport } from './home-export.ts';
import { type HomeProblem, homeProblem } from './home-problems.ts';
import { type ExportClipboard, type ScreenGuard, browserClipboard as exportClipboard, screenGuard } from './key-reveal.ts';
import type { NearReader } from './near-rpc.ts';
import { appLogo } from './logo.ts';
import { type GestureCheck, type PageWindow, isFramed, isUserGesture, randomName } from './page-window.ts';
import { type Toaster, toaster } from './toast.ts';
import { BTN, alert, icon, reservedLine } from './ui.ts';

/** How long before the sign-in's end the page warns. */
export const HOME_EXPIRY_WARN_MS = 2 * 60_000;
/** How long the page waits for Google's answer in the relay. */
export const HOME_LOGIN_LIMIT_MS = 5 * 60_000;
/** The sign-in child's path and query. */
export const HOME_LOGIN_CHILD = '/login?mode=home';
export const HOME_PATH = '/home';
/** The sign-in methods the page offers, each while `GET /v1/home/config` says it is open. */
export const SIGN_IN_METHODS = ['google', 'email'] as const;
const RELAY_WAIT_S = 25;
const CHILD_WATCH_MS = 500;
/** How long "Copied" stays. */
const COPIED_MS = 4000;
/** A copy that didn't work: the browser has no Clipboard API, or refused the write. */
const COPY_FAILED = Object.freeze({
  none: (what: string): string => `This browser can’t copy for you. Select the ${what} and copy it yourself.`,
  refused: (what: string): string => `This browser didn’t allow the copy. Select the ${what} and copy it yourself.`,
});
/** The sign-in's notice: two minutes before its end, and at the end (D553). */
const ENDING_TEXT = (minutes: number): string => `Your sign-in to ${BRAND.home} ends in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Everything on screen stays. To load anything new after that, sign in again.`;
const ENDED_TEXT = `Your sign-in to ${BRAND.home} has ended. Everything on screen stays. To load anything new, sign in again.`;
/** The skip link's words (D888), the first thing Tab reaches on the page. */
export const HOME_SKIP_TEXT = 'Skip to content';

/**
 * Passport Home's own words for its views (D893): "wallet" is the main noun where the user's wallet is meant; "app"
 * stays where the partner's app is meant. In one place for the tests and the plain-words check.
 */
export const HOME_TEXT = Object.freeze({
  signedOutAbout: `See your wallets in the apps you use with ${BRAND.company}, and their addresses, in one place.`,
  walletsTitle: 'Your wallets',
  walletsLede: `Your wallets in the apps you use with ${BRAND.company}. Apps that share a wallet are listed together. Open a wallet to see its addresses.`,
  walletsLoading: 'Loading your wallets…',
  walletsEmptyTitle: 'No wallets yet',
  walletsEmpty: (account: string): string => `You don’t have a wallet with this ${account} yet. A wallet appears here after you sign in to an app with ${BRAND.company}.`,
  walletsFailedTitle: 'Your wallets didn’t load',
  walletsFailed: `${BRAND.home} couldn’t load your wallets. Try again in a moment.`,
  retry: 'Try again',
  linkedTitle: 'The app from your link',
  accountTitle: 'Your account',
  devicesRow: 'Where you’re signed in to your apps, and what may sign without asking',
  nameRow: 'A name for your apps, if you want one. No app gets it until you share it.',
  othersTitle: 'Other apps',
  othersLede: `Apps that use ${BRAND.company}, where ${BRAND.company} has no wallet on record for you.`,
  othersEmptyTitle: 'No other apps listed',
  othersEmpty: 'Some apps appear only when you search for their whole name.',
  othersFailed: 'The list of other apps didn’t load either. You can still find an app by name.',
  searchLabel: 'Find an app by name',
  searchHint: 'Some apps appear only when you type their whole name.',
  noResultsTitle: 'No app found with that name',
  noResults: 'Check the spelling, or type the app’s whole name.',
  back: 'Your wallets',
  walletTitle: 'Wallet details',
  appTitle: 'App details',
  walletApp: 'App that uses this wallet',
  walletApps: 'Apps that use this wallet',
  noAddress: `${BRAND.company} has no address on record for this wallet yet.`,
  /** The top bar's Sign out, as a screen reader and a tooltip name it: apart from "Sign out this device". */
  signOutName: `Sign out of ${BRAND.home}`,
});

/** The window's title on a signed-in view (D893): the view's `h1`, then the page's name. */
export const homeViewTitle = (heading: string): string => `${heading} – ${BRAND.home}`;

/** The marker a history entry of Passport Home holds (D893): `home:`, the sign-in's random tag, `:`, the step. */
const STEP_MARK = /^home:([A-Za-z0-9_-]{16}):([1-9][0-9]{0,2})$/u;

/**
 * The part of `window.history` the page uses for Back inside Home (D893). Every member is optional: without them (an
 * old browser, a test window) Back leaves Home, as it did before.
 */
interface HomeHistory {
  readonly state?: unknown;
  scrollRestoration?: string;
  pushState?(data: unknown, unused: string): void;
  go?(delta: number): void;
}

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
  /** The NEAR reads of opening a wallet (home-export.ts): the app's registration, the path, a lost outcome. */
  near: NearReader;
  /** Whether this window has focus (default: `document.hasFocus()`): the guard and the clipboard blank need it. */
  hasFocus?: () => boolean;
  /** The email issuer's Home route (home-email.ts), or null (the default) in an env without an email issuer. */
  email?: HomeEmailApi | null;
  /** The guard's clock (default: Date.now; tests inject one): Continue, Show key and Copy key wait for it. */
  guardNow?: () => number;
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

/** Passport Home's views while signed in (D893): "Your wallets", a wallet's page, and the two "Your account" views. */
export type HomeViewKind = 'front' | 'wallet' | 'devices' | 'profile';
/** A view as the page remembers it (memory only): a wallet's view keeps the listing it was opened from. */
type HomeView = { readonly kind: 'front' } | { readonly kind: 'wallet'; scope: HomeScope } | { readonly kind: 'devices' } | { readonly kind: 'profile' };

export type HomeListState = 'idle' | 'loading' | 'ready' | 'error';

export interface HomePage {
  readonly stage: HomeStage;
  readonly session: HomeSession;
  /** A sign-in child is open while a list is on screen (signing in again). */
  readonly renewing: boolean;
  readonly list: HomeListState;
  /** The listing whose page is open, or null on any other view. */
  readonly openScope: string | null;
  /** The view on screen while signed in (D893): the front page, a wallet's (or an app's) page, or an account view. */
  readonly view: HomeViewKind;
  /** The code of the problem on screen, or null. */
  readonly errorCode: string | null;
  /** The sign-in child's window name, once opened. */
  readonly childName: string | null;
  /** The sign-in is prepared and waits for the child's hello. */
  readonly awaitingChild: boolean;
  /** How many Home API requests the page has sent. */
  readonly requests: number;
  /** The "Move this wallet" section of the app page that is open (home-export.ts). */
  readonly moving: { readonly state: HomeExportState; readonly chain: 'stellar' | 'evm' | 'near' | null; readonly errorCode: string | null; readonly childName: string | null; readonly awaitingChild: boolean; readonly holdsSecret: boolean };
  /** "Devices and auto-approve" (home-devices.ts), its own view and on each wallet's page. */
  readonly devices: Pick<HomeDevices, 'front' | 'app' | 'confirming' | 'errorCode' | 'requests'>;
  /** "Your name" (home-profile.ts), its own view and on each wallet's page. */
  readonly profile: Pick<HomeProfileSection, 'front' | 'app' | 'confirming' | 'errorCode' | 'requests'>;
  /** "Ways to sign in" (home-sign-ins.ts), on each app's page. */
  readonly signIns: Pick<HomeSignIns, 'state' | 'reads' | 'errorCode'>;
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

const MINE_QUESTION = 'Does this wallet need the app?';
const OTHER_QUESTION = 'Would a wallet here need the app?';
/**
 * The words say only what is true today. For the user's own app: whether Hana's sign-in to the wallet depends on the
 * app. For any other app, where Hana knows of no wallet of theirs: the same, as an "if". Nothing here promises an
 * action the page doesn't offer.
 */
const COVERAGE_WORDS: Readonly<Record<'mine' | 'other', Readonly<Record<CoverageKind, CoverageText>>>> = Object.freeze({
  mine: {
    yes: { badge: 'Safe if the app closes', tone: 'ok', question: MINE_QUESTION, detail: 'No. If this app shuts down, you can still sign in to this wallet through Journear.' },
    maybe: { badge: 'Needs the app', tone: 'warn', question: MINE_QUESTION, detail: 'Yes. This app runs its own Google sign-in. If this app shuts down, you can no longer sign in to this wallet.' },
    no: { badge: 'Can’t be opened here', tone: 'off', question: MINE_QUESTION, detail: 'Journear can no longer sign you in to this wallet: the sign-in this app used is gone. If the app still runs, use the app itself.' },
    unknown: { badge: 'Not checked yet', tone: 'muted', question: MINE_QUESTION, detail: 'Journear hasn’t checked this app yet.' },
  },
  other: {
    yes: { badge: 'Safe if the app closes', tone: 'ok', question: OTHER_QUESTION, detail: 'No. If you had a wallet in this app and the app shut down, you could still sign in to it through Journear. Journear has no wallet on record for you here.' },
    maybe: { badge: 'Needs the app', tone: 'warn', question: OTHER_QUESTION, detail: 'Yes. This app runs its own Google sign-in. If it shuts down, nobody can sign in to a wallet here any more. Journear has no wallet on record for you here.' },
    no: { badge: 'Can’t be opened here', tone: 'off', question: OTHER_QUESTION, detail: 'Journear can no longer sign anyone in to wallets in this app: the sign-in it used is gone. If the app still runs, use the app itself.' },
    unknown: { badge: 'Not checked yet', tone: 'muted', question: OTHER_QUESTION, detail: 'Journear hasn’t checked this app yet.' },
  },
});

/** What the sentence adds for the user's own wallet when this page can move it out. */
const MOVE_WORDS: Readonly<Partial<Record<CoverageKind, string>>> = Object.freeze({
  yes: ' You can also move it to another wallet app below.',
  maybe: ' To avoid that, you can move it to another wallet app below.',
});

/**
 * How a coverage reads to a user: the badge, and the question and sentence on the app's page. `canMove`: the page
 * offers "Move this wallet to another wallet app" for this app, so the sentence may say so; it never does otherwise.
 */
export function coverageText(coverage: HomeCoverage, mine: boolean, canMove = false): CoverageText {
  const kind = COVERAGE_KIND[coverage];
  const words = COVERAGE_WORDS[mine ? 'mine' : 'other'][kind];
  const more = mine && canMove ? MOVE_WORDS[kind] : undefined;
  return more ? { ...words, detail: `${words.detail}${more}` } : words;
}

export { type HomeProblem, homeProblem } from './home-problems.ts';

/** Each tone's badge in the design system (the words say it too: never colour alone). */
const BADGE_CLASS: Readonly<Record<CoverageTone | 'plain', string>> = Object.freeze({ ok: 'jp-badge jp-badge-success', warn: 'jp-badge jp-badge-warning', off: 'jp-badge jp-badge-danger', muted: 'jp-badge', plain: 'jp-badge' });

const STATUS_TEXT: Readonly<Record<HomeApp['status'], string | null>> = Object.freeze({ active: null, suspended: 'Paused', deleted: 'Closed' });

/** Where a Stellar account can be looked up, by the env's network. An EVM address is the same on every EVM chain, so it gets no single link. */
const STELLAR_ACCOUNT_URL: Readonly<Record<HanaEnv['network'], { name: string; url: string }>> = Object.freeze({
  testnet: { name: 'StellarExpert (test network)', url: 'https://stellar.expert/explorer/testnet/account/' },
});
/** Where a NEAR account can be looked up, by the env's network (D755). */
const NEAR_ACCOUNT_URL: Readonly<Record<HanaEnv['network'], { name: string; url: string }>> = Object.freeze({
  testnet: { name: 'NearBlocks (test network)', url: 'https://testnet.nearblocks.io/address/' },
});
/** Each chain's label on an app's page, and its copy button's name. */
const ADDRESS_LABEL = Object.freeze({ stellar: 'Stellar', evm: 'Ethereum-style (Ethereum and similar networks)', near: 'NEAR' });
const ADDRESS_NAME = Object.freeze({ stellar: 'Stellar address', evm: 'Ethereum-style address', near: 'NEAR account' });

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

/** The most lines the who line keeps when its words get shorter (home.css `.home-who-lines-N`). */
const WHO_LINES_KEPT = 4;

/** The top bar's parts the page fills: who is signed in and Sign out, and the sign-in's notice. */
interface TopBar {
  readonly header: HTMLElement;
  readonly account: HTMLElement;
  readonly notice: HTMLElement;
}

/**
 * Passport Home's shell (D888). The top bar is the build's static `header.home-top` (the lockup; pageHtml), made here if
 * the document has none. The page adds its two parts to it, outside `#app`: who is signed in with Sign out (filled while
 * signed in), and the sign-in's notice (`#home-banner`, a live region kept for the page's life), a row of the bar
 * itself, so the bar grows when it shows and covers nothing. Before the bar, a skip link that moves focus into `#app`
 * without changing the page's address (D555).
 */
function topBar(d: Dom): TopBar {
  const doc = d.doc;
  const main = doc.getElementById('app');
  let header = doc.querySelector<HTMLElement>('header.home-top');
  if (!header) {
    header = d.h('header', { class: 'home-top' });
    if (main) main.before(header);
    else doc.body.prepend(header);
  }
  const account = d.h('div', { class: 'home-top-account', attrs: { id: 'home-account' } });
  // `home`: what the notice shows (the email code screens too) is styled as it is in the page.
  const notice = d.h('div', { class: 'home-top-notice home' }, d.h('div', { attrs: { id: 'home-banner', 'aria-live': 'polite' } }));
  header.append(account, notice);
  if (main) {
    main.setAttribute('tabindex', '-1');
    const skip = d.h('a', { class: 'home-skip', attrs: { href: '#app' } }, HOME_SKIP_TEXT);
    skip.addEventListener('click', (e) => {
      // Focus only: the page never changes its own address (D555), so the link's `#app` is never followed.
      e.preventDefault();
      try {
        main.focus();
      } catch {
        // Focus is a convenience.
      }
    });
    header.before(skip);
  }
  return { header, account, notice };
}

type SizeWatch = { observe(el: Element): void; disconnect(): void };

/**
 * D888: watches elements' heights and calls `changed(el, height)` when one changes after it was first seen. Null in a
 * browser without ResizeObserver: the page still works, and the guard still starts over on what the page itself
 * changes (the notice, a refusal).
 */
function sizeWatch(changed: (el: Element, height: number, was: number | undefined, widthChanged: boolean) => void): SizeWatch | null {
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (typeof RO !== 'function') return null;
  const seen = new WeakMap<Element, { h: number; w: number }>();
  const ro = new RO((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      const r = el.getBoundingClientRect();
      const h = Math.round(r.height);
      const w = Math.round(r.width);
      const was = seen.get(el);
      seen.set(el, { h, w });
      if (was?.h === h) continue;
      changed(el, h, was?.h, was !== undefined && was.w !== w);
    }
  });
  return { observe: (el) => ro.observe(el), disconnect: () => ro.disconnect() };
}

/** Who a sign-in is for: the method and that method's id for the person. Memory only. */
interface HomeAccount {
  provider: 'google' | 'email';
  sub: string;
}

interface PendingSignIn {
  identity: HomeIdentity;
  /** The Google client this sign-in uses: the shared client, or the exit client (answered at `/home/callback`). */
  clientId: string;
  relayId: string;
  relayKey: Uint8Array;
  relayReadKey: Uint8Array;
  params: WindowMessage<'hana:home-params'>;
  helloAccepted: boolean;
}

/** Which Google client Hana Home's own sign-in uses: the shared client while one is in force, else the exit client (D490). */
export function homeGoogleRoute(config: HomeConfig | null): { clientId: string; exit: boolean } | null {
  if (config?.sharedGoogleClientId) return { clientId: config.sharedGoogleClientId, exit: false };
  if (config?.exitGoogleClientId) return { clientId: config.exitGoogleClientId, exit: true };
  return null;
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
  /** The listing the page's link named, the user's own or not: its wallet is never moved out in this page load. */
  let linkScope: string | null = null;
  let list: HomeListState = 'idle';
  /** The view on screen (D893). A wallet's view keeps the listing it opened, so Back and Forward can show it again. */
  let viewing: HomeView = { kind: 'front' };
  let problem: HomeProblem | null = null;
  /**
   * Where a refusal of the page's own actions shows (D893): `top`, under the view's heading (the first list, a link, a
   * wallet's "Check now"); `others`, under the search (a search, "Show more"), where the user acted.
   */
  let problemAt: 'top' | 'others' = 'top';
  /** Which action is loading, so only its button says so. */
  let busy: 'more' | 'search' | 'check' | null = null;
  /** `/home?view=devices` (D613): the devices view opens once after each new account's sign-in. */
  const devicesLink = devicesLinked(win.location.search);

  // The sign-in in progress.
  let pending: PendingSignIn | null = null;
  let signingIn = false;
  let child: Window | null = null;
  let childName: string | null = null;
  let signInError: HomeProblem | null = null;
  /** A sign-in again that didn't finish: said in the bar's notice, where it was started, not at the page's top. */
  let renewProblem: HomeProblem | null = null;
  /** An email sign-in in progress: its code screens, where they draw, and the identity its code is for. */
  let emailStep: HomeEmailStep | null = null;
  let emailBox: HTMLElement | null = null;
  let emailIdentity: HomeIdentity | null = null;
  /** The signed-in email account's address, for its later codes (memory only). */
  let emailAddress: string | null = null;
  const emailApi: HomeEmailApi | null = deps.email ?? null;
  const emailOpen = (): boolean => emailApi !== null && config?.emailSignIn === true;

  /** Addresses of wallets opened in this page, by listing: shown where Hana had none on record. Memory only. */
  const opened = new Map<string, HomeAddress[]>();

  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Short outcomes (a copy that worked): the stack lives outside `#app`, which is redrawn. */
  const toasts: Toaster = toaster(d);
  /** The top bar's own parts (D888): who is signed in with Sign out, and the sign-in's notice; outside `#app`. */
  const bar = topBar(d);

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

  // ---- moving a wallet out (home-export.ts) ----
  const hasFocus = deps.hasFocus ?? (() => win.document.hasFocus());
  const view = (): (Window & typeof globalThis) | null => win.document.defaultView;
  /**
   * The move flow's guarded buttons and where each was in the page (not the window: scrolling doesn't change it) when
   * the guard last started over or saw an arming gesture. D888's catch-all: whatever moved one (an observed tool, an
   * unobserved element, a scrollbar, WebKit's page move, the key's box growing), the next pointer move, press or key
   * notices before the guard does and starts the guard over, so the press can't act on a button that moved under it.
   */
  const guardedButtons = new Set<HTMLButtonElement>();
  const placed = new Map<HTMLButtonElement, string>();
  const placeOf = (el: HTMLButtonElement): string | null => {
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const v = view();
    return `${Math.round(r.top + (v?.scrollY ?? 0))},${Math.round(r.left + (v?.scrollX ?? 0))}`;
  };
  const notePlaces = (): void => {
    placed.clear();
    for (const el of guardedButtons) {
      const at = placeOf(el);
      if (at !== null) placed.set(el, at);
    }
  };
  /** Whether a guarded button is somewhere else in the page than when its place was last noted. */
  const guardedMoved = (): boolean => {
    for (const el of guardedButtons) {
      const at = placeOf(el);
      if (at === null) continue;
      const was = placed.get(el);
      if (was !== undefined && was !== at) return true;
    }
    return false;
  };
  // Registered before the guard's own listeners, and in the capture phase: the check runs first on every input.
  const onInput = (): void => {
    if (guardedButtons.size === 0) return;
    if (guardedMoved()) rawGuard.rendered();
    notePlaces();
  };
  for (const type of ['pointermove', 'pointerdown', 'keydown']) (win as unknown as { addEventListener(t: string, l: () => void, capture: boolean): void }).addEventListener(type, onInput, true);
  const rawGuard = screenGuard({ win, isGesture, hasFocus, ...(deps.guardNow ? { now: deps.guardNow } : {}) });
  /** The move flow's guard (Continue, Show key, Copy key): held here too, so a change of layout can start it over. */
  const guard: ScreenGuard = {
    button(el, ready) {
      guardedButtons.add(el);
      rawGuard.button(el, ready);
    },
    newScreen() {
      guardedButtons.clear();
      placed.clear();
      rawGuard.newScreen();
    },
    rendered() {
      rawGuard.rendered();
      notePlaces();
    },
    sync: () => rawGuard.sync(),
    click: (e) => rawGuard.click(e),
    hint: () => rawGuard.hint(),
  };
  /**
   * D888: anything that changes the layout around the page's content (the bar's height, its notice, the refusal at the
   * top of the page) starts the guard over: a fresh wait and a new arming gesture before Continue, Show key or Copy key
   * act, so a press aimed at what was under the pointer before the change can't turn into one of them. It acts only on
   * the guarded buttons on screen; with none, it changes nothing.
   */
  const layoutChanged = (): void => guard.rendered();
  const rootStyle = (name: string, value: string): void => {
    try {
      win.document.documentElement.style.setProperty(name, value);
    } catch {
      // The offsets are a convenience.
    }
  };
  /** Where the bar's bottom is in the window now (0 once a bar that scrolls with the page is gone): a phone's toasts start below it. */
  const noteBarBottom = (): void => rootStyle('--home-bar-bottom', `${Math.max(0, Math.round(bar.header.getBoundingClientRect().bottom))}px`);
  const sticky = (): boolean => view()?.getComputedStyle(bar.header).position === 'sticky';
  /** The page's scroll position as last seen, before any change of layout this frame. */
  let lastScrollY = view()?.scrollY ?? 0;
  /**
   * D893 (a fix to D888's step 1): the scroll position just before the page itself changed the bar (its notice, who is
   * signed in), held until the bar's resize is handled. The browser's own scroll anchoring moves the page in the same
   * frame and fires a scroll event BEFORE the resize observation; that event used to overwrite `lastScrollY`, so the
   * resize took the anchoring as missing and scrolled by the bar's change a second time (hidden while the page was
   * already at its end, as the front page with step 1's layout mostly was). Dropped at once when the change left the
   * bar's height as it was (no resize will come), else by the resize that handles it.
   */
  let beforeBarChange: number | null = null;
  /** The bar's height as the resize observer last reported it (null before its first report, or without one). */
  let barSeen: number | null = null;
  const noteBarChange = (): void => {
    beforeBarChange = view()?.scrollY ?? lastScrollY;
    lastScrollY = beforeBarChange;
  };
  const barChanged = (): void => {
    if (beforeBarChange === null) return;
    let now: number | null = null;
    try {
      now = Math.round(bar.header.getBoundingClientRect().height);
    } catch {
      now = null;
    }
    if (barSeen === null || now === null || now === barSeen) beforeBarChange = null;
  };
  const onScroll = (): void => {
    if (beforeBarChange === null) lastScrollY = view()?.scrollY ?? 0;
    noteBarBottom();
  };
  // The bar's height: written to the root's --home-bar-h (through the CSSOM, which the CSP allows; no style attribute),
  // which focus scrolling keeps clear of; a change starts the guard over.
  sizeWatch((_, height, was, widthChanged) => {
    barSeen = height;
    rootStyle('--home-bar-h', `${height}px`);
    noteBarBottom();
    if (was === undefined) return;
    // A bar that scrolls with the page (a phone) grew or shrank above what the user is looking at: scroll by what the
    // browser's own scroll anchoring didn't (all of it in WebKit, every iPhone, which reports the property but doesn't
    // anchor here; nothing in Chromium and Firefox), before the next paint, so what is in view stays put. Never on a
    // desktop: there the bar is stuck over the page, and content must move out from under it.
    const v = view();
    // The bar's width changed too: the window was resized and everything reflowed; not the bar changing above what is
    // in view.
    const before = beforeBarChange ?? lastScrollY;
    beforeBarChange = null;
    if (v && !widthChanged && !sticky() && before >= was) {
      const missing = height - was - (v.scrollY - before);
      if (Math.abs(missing) >= 1) v.scrollBy(0, missing);
    }
    if (v) lastScrollY = v.scrollY;
    layoutChanged();
  })?.observe(bar.header);
  view()?.addEventListener('scroll', onScroll, { passive: true });
  // On a wallet's page, everything above the move flow in the page (the way back, the details with a refusal under their
  // heading, the other tools): a change in its height moves the guarded buttons, so it starts the guard over too. D893:
  // not a list of selectors any more but every element before the move flow's section, at each level up to `main`, so
  // a part added above it later (step 3's tabs) is watched too. The move flow's own section isn't watched: its screens
  // start the guard themselves. The catch-all (`onInput`) still covers whatever this misses.
  const above = sizeWatch((_, __, was) => {
    if (was !== undefined) layoutChanged();
  });
  const watchAbove = (): void => {
    if (!above) return;
    above.disconnect();
    const doc = win.document;
    const main = doc.getElementById('app');
    for (let el: Element | null = doc.getElementById('home-export'); el && el !== main && el !== doc.body; el = el.parentElement) {
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) above.observe(s);
    }
  };
  const moving: HomeExport = startHomeExport({
    win,
    env,
    d,
    api,
    relay: deps.relay,
    near: deps.near,
    jwks,
    clock,
    sleep,
    isGesture,
    guard,
    clipboard: (): ExportClipboard | null => (deps.clipboard === undefined ? exportClipboard() : deps.clipboard),
    hasFocus,
    session: () => {
      checkSession();
      if (!identity || !identity.usable || !account) return null;
      return { identity, account: account.provider === 'email' && emailAddress ? { ...account, address: emailAddress } : account };
    },
    email: emailApi,
    config: () => config,
    signingIn: () => signingIn,
    onSignedOut: () => endSession(),
    onAddresses: (scopeId, addresses) => {
      opened.set(scopeId, addresses);
      renderContent();
    },
    track,
  });

  // ---- devices and auto-approve (home-devices.ts) ----
  const devices: HomeDevices = startHomeDevices({
    win,
    d,
    api,
    isGesture,
    session: () => {
      checkSession();
      return identity && identity.usable ? identity : null;
    },
    onSignedOut: () => endSession(),
    track,
    appName: (appId) => allScopes().flatMap((s) => s.apps).find((a) => a.appId === appId)?.name ?? null,
  });

  // ---- the user's name (home-profile.ts) ----
  const profile: HomeProfileSection = startHomeProfile({
    win,
    d,
    api,
    isGesture,
    session: () => {
      checkSession();
      return identity && identity.usable ? identity : null;
    },
    onSignedOut: () => endSession(),
    track,
    now: () => clock.now(),
  });

  // ---- the ways to sign in to each app's wallet (home-sign-ins.ts) ----
  const signIns: HomeSignIns = startHomeSignIns({
    win,
    d,
    near: deps.near,
    signer: env.signer,
    isGesture,
    session: () => {
      checkSession();
      return identity && identity.usable && account ? { provider: account.provider, sub: account.sub, address: account.provider === 'email' ? emailAddress : null } : null;
    },
    ended: () => session === 'ended',
    track,
    now: () => clock.now(),
  });

  // ---- small view parts ----
  const byId = (id: string): HTMLElement | null => win.document.getElementById(id);
  const fill = (id: string, ...children: Child[]): void => {
    const el = byId(id);
    if (!el) return;
    el.replaceChildren();
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? win.document.createTextNode(c) : c);
  };
  /** A screen without a sign-in (signed out, loading, signing in, a refusal): the window's title is the page's name. */
  const showGate = (...children: Child[]): void => {
    d.show(...children);
    setTitle(BRAND.home);
  };
  const setTitle = (title: string): void => {
    try {
      win.document.title = title;
    } catch {
      // The title is a convenience.
    }
  };
  /**
   * A button that acts only on a real click. The design system's kinds: `primary` (one per view), else secondary;
   * `ghost` for an inline action; `sm` for a row's own control.
   */
  const button = (label: string, onClick: (e: Event) => void, props: { class?: string; id?: string; ariaLabel?: string; disabled?: boolean; kind?: 'primary' | 'secondary' | 'ghost'; sm?: boolean; icon?: Parameters<typeof icon>[1] } = {}): HTMLButtonElement => {
    const kind = props.kind ?? (props.class?.split(' ').includes('primary') ? 'primary' : 'secondary');
    // `link`: a text button inside a sentence or an alert (auth.css `button.link`), not a box.
    const link = props.class?.split(' ').includes('link') === true;
    const cls = [props.class, link ? null : BTN[kind], !link && props.sm ? 'jp-btn-sm' : null].filter(Boolean).join(' ');
    const b = d.h('button', { class: cls, attrs: { type: 'button', ...(props.id ? { id: props.id } : {}), ...(props.ariaLabel ? { 'aria-label': props.ariaLabel } : {}) } }, props.icon ? icon(d, props.icon) : null, label);
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
  const badge = (text: string, tone: CoverageTone | 'plain'): HTMLElement => d.h('span', { class: `badge badge-${tone} ${BADGE_CLASS[tone]}` }, text);

  /** A refusal, inline (the system's danger alert): the sentence, then the code and request for support. */
  const problemView = (p: HomeProblem, id: string, onDismiss?: () => void): HTMLElement =>
    alert(
      d,
      'danger',
      { tag: 'div', class: 'home-problem', attrs: { role: 'alert', id } },
      d.h('p', {}, p.text),
      d.h('p', { class: 'code muted' }, supportCode(p.code)),
      p.requestId ? d.h('p', { class: 'code muted' }, supportRequest(p.requestId)) : null,
      onDismiss ? button('Dismiss', onDismiss, { class: 'link' }) : null,
    );

  /** The system's empty state: an icon, what is missing, and what makes something appear. */
  const empty = (id: string, title: string, text: string): HTMLElement =>
    d.h('div', { class: 'jp-empty home-empty', attrs: { id } }, icon(d, 'wallet'), d.h('b', {}, title), d.h('span', {}, text));

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
    replaceWho();
    signIns.sessionEnded();
    renderBanner();
  }

  /** Brings `session` up to date with the clock. Timers can fire late (a sleeping laptop), so every request checks too. */
  function checkSession(): void {
    if (!identity || session === 'none' || session === 'ended') return;
    const left = identity.endsAtMs - clock.now();
    if (left <= 0) endSession();
    else if (left <= HOME_EXPIRY_WARN_MS && session !== 'ending') {
      session = 'ending';
      renderBanner();
    }
  }

  function scheduleSession(id: HomeIdentity): void {
    clearSessionTimers();
    const left = id.endsAtMs - clock.now();
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
    problemAt = 'top';
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
        linkScope = own.scopeId;
        openWallet(own.scopeId);
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
        linkScope = found.scopeId;
        openWallet(found.scopeId);
      } else if (found) {
        linked = found;
        renderContent();
      } else {
        if (one) problem = { code: 'app_not_found', text: 'Passport Home couldn’t find the app this link is for.', requestId: null, signInAgain: false };
        renderContent();
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || busy) return;
    busy = 'more';
    problem = null;
    problemAt = 'others';
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
      problemAt = 'others';
      problem = { code: 'search_term', text: `Type ${HOME_SEARCH_MIN} to ${HOME_SEARCH_MAX} characters of the app’s name.`, requestId: null, signInAgain: false };
      renderContent();
      return;
    }
    busy = 'search';
    problem = null;
    problemAt = 'others';
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
    problemAt = 'top';
    renderContent();
    const at = epoch;
    const page = await request(query);
    if (at !== epoch) return;
    busy = null;
    const fresh = page?.scopes.find((s) => s.scopeId === scope.scopeId);
    if (fresh) replaceScope(fresh);
    renderContent();
  }

  // ---- the views, and Back and Forward inside Home (D893) ----
  //
  // The front page ("Your wallets") is the history entry the page was on when the user signed in; it is never added.
  // Opening a view from it (a wallet, an app, "Devices and auto-approve", "Your name") adds one entry at the same
  // address (`history.pushState` with no URL: D555's address never changes) holding only `home:{tag}:{step}`, where
  // `tag` is 16 random characters made for this sign-in and `step` its number. Which view a step is lives here, in
  // memory (`steps`), never in the entry. So:
  //   - Back from a view returns to the front page; Forward shows the view again from memory (nothing is read: Back and
  //     Forward never send a request); Back from the front page leaves Home, as before;
  //   - "Your wallets" (the way back on a view) goes back to the front page's own entry (`history.go`), so the front
  //     page stays the first entry and Back from it still leaves Home; Forward still reaches the view;
  //   - a reload signs out (D553) and keeps no tag: the entries it leaves show the signed-out page; a sign-out or
  //     another account gets a new tag (and the page goes back to its first entry), so an earlier account's entries
  //     show nothing of it: an entry whose tag isn't this sign-in's is the front page; signed out, the page ignores them.
  // Leaving a wallet's view, by its way back or by Back, locks and erases a wallet opened in it (home-export.ts
  // `leave`, D553); Forward shows its page with the move flow closed again, never a key.
  const hist = (): HomeHistory | null => {
    try {
      return (win as { history?: HomeHistory }).history ?? null;
    } catch {
      return null;
    }
  };
  /** This sign-in's random tag, the views by step (0 is the front page) and the step on screen. Memory only. */
  let stepTag = '';
  let steps: HomeView[] = [{ kind: 'front' }];
  let step = 0;
  /** The page asked the browser to go back (`history.go`): its popstate is the page's own; a view opened meanwhile waits for it. */
  let rewinding = false;
  let rewindTimer: ReturnType<typeof setTimeout> | undefined;
  let afterRewind: (() => void) | null = null;
  /** Where the front page was scrolled when a view opened over it, and the row that opened it: both come back with it. */
  let frontScroll = 0;
  let frontReturn: string | null = null;

  const stepMark = (n: number): string => `home:${stepTag}:${n}`;
  /** The step an entry's marker names, for this sign-in only; null for anything else (another sign-in's, none). */
  const stepOf = (state: unknown): number | null => {
    if (typeof state !== 'string') return null;
    const m = STEP_MARK.exec(state);
    return m && m[1] === stepTag ? Number(m[2]) : null;
  };
  /** Whether the browser is on the entry the page added for the step on screen (so going back lands on the front page). */
  const onOwnStep = (): boolean => {
    try {
      return step > 0 && hist()?.state === stepMark(step);
    } catch {
      return false;
    }
  };
  /** Goes back to the front page's entry, when the browser is on the page's own step; true when it asked. */
  function rewind(): boolean {
    const h = hist();
    if (!onOwnStep() || typeof h?.go !== 'function') return false;
    rewinding = true;
    clearTimeout(rewindTimer);
    // A popstate that never comes (a browser that drops it) mustn't hold a view opened meanwhile for ever.
    rewindTimer = setTimeout(() => endRewind(), 1000);
    try {
      h.go(-step);
      return true;
    } catch {
      endRewind();
      return false;
    }
  }
  function endRewind(): void {
    rewinding = false;
    clearTimeout(rewindTimer);
    const next = afterRewind;
    afterRewind = null;
    next?.();
  }
  /** A new account's views (a sign-in, a sign-out): a new tag, and the browser back on the page's first entry. */
  function newSteps(): void {
    rewind();
    stepTag = base64UrlEncode(randomBytes(12));
    steps = [{ kind: 'front' }];
    step = 0;
    frontScroll = 0;
    frontReturn = null;
  }
  /** Adds the history entry for a view just opened (after the page's own Back, if one is on its way). */
  function addStep(v: HomeView): void {
    const add = (): void => {
      if (viewing !== v) return;
      const h = hist();
      if (typeof h?.pushState !== 'function') return;
      try {
        h.pushState(stepMark(step + 1), '');
      } catch {
        // A browser that refuses (too many entries at once): no entry, so Back leaves Home from here, as before.
        return;
      }
      step += 1;
      steps = [...steps.slice(0, step), v];
    };
    if (rewinding) afterRewind = add;
    else add();
  }

  function onPopState(event: Event): void {
    if (rewinding) return endRewind();
    // Signed out (or signing in): nothing of an account is shown, whatever the entry.
    if (stage !== 'signed_in') return;
    const n = stepOf((event as { state?: unknown }).state ?? null);
    const target = n !== null && n < steps.length ? n : 0;
    const next = steps[target] as HomeView;
    step = target;
    if (next === viewing || (next.kind === 'front' && viewing.kind === 'front')) return;
    showView(next, 'history');
  }

  /** What leaving a view drops: a wallet's page locks its wallet and closes its tools; an account view closes a confirmation. */
  function leaveView(v: HomeView): void {
    if (v.kind === 'wallet') {
      // Leaving a wallet's page locks its wallet: nothing of it stays in the page. Its devices are read again next time.
      moving.leave();
      devices.leaveApp();
      signIns.leaveApp();
      profile.leaveApp();
    } else if (v.kind === 'devices') devices.leaveFront();
    else if (v.kind === 'profile') profile.leaveFront();
  }

  const scrollTo = (y: number): void => {
    try {
      view()?.scrollTo(0, y);
    } catch {
      // Scrolling is a convenience.
    }
  };
  const focusQuiet = (el: HTMLElement | null): boolean => {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
      return true;
    } catch {
      return false;
    }
  };
  /** The row the user opened a view with, on the front page now (a wallet's by its listing, an account row by its id). */
  const returnRow = (): HTMLElement | null => {
    const ret = frontReturn;
    if (!ret) return null;
    if (ret.startsWith('#')) return byId(ret.slice(1));
    return Array.from(win.document.querySelectorAll<HTMLElement>('#home-content .home-row[data-scope]')).find((el) => el.getAttribute('data-scope') === ret) ?? null;
  };

  /**
   * Shows a view. `open`: the user opened it (one read where the view needs it); `back`: the way back to the front page;
   * `history`: Back or Forward (never a read). A view starts at its top with focus on its heading; the front page comes
   * back where it was scrolled, with focus on the row the user opened (its heading when that row is gone).
   */
  function showView(next: HomeView, how: 'open' | 'back' | 'history'): void {
    const was = viewing;
    if (was.kind === 'front') frontScroll = view()?.scrollY ?? 0;
    if (was !== next) leaveView(was);
    viewing = next;
    problem = null;
    renderContent();
    if (next.kind === 'front') {
      if (!focusQuiet(returnRow())) focusQuiet(byId('home-title'));
      scrollTo(frontScroll);
    } else {
      scrollTo(0);
      focusHeading(next.kind === 'wallet' ? 'home-app-title' : next.kind === 'devices' ? 'home-devices-title' : 'home-profile-title');
    }
    if (how !== 'open') return;
    // Opening a wallet's page is the user asking about it: one read, when the list couldn't say.
    if (next.kind === 'wallet' && next.scope.coverage === 'unknown' && session !== 'ended') track(checkScope(next.scope));
    // Opening an account view is the user asking to see it: one read, if it hasn't been read in this sign-in.
    if (next.kind === 'devices') devices.openFront();
    if (next.kind === 'profile') profile.openFront();
  }

  /** Opens a wallet's page (an app's, where the user has none) from the front page or the partner's link. */
  function openWallet(scopeId: string): void {
    const scope = findScope(scopeId);
    if (!scope) return;
    if (viewing.kind === 'front') frontReturn = scopeId;
    const v: HomeView = { kind: 'wallet', scope };
    showView(v, 'open');
    addStep(v);
  }

  /** Opens "Devices and auto-approve" or "Your name" from "Your account" (or `?view=devices`). */
  function openAccount(kind: 'devices' | 'profile'): void {
    if (viewing.kind === kind) return;
    if (viewing.kind === 'front') frontReturn = kind === 'devices' ? '#home-open-devices' : '#home-open-profile';
    const v: HomeView = { kind };
    showView(v, 'open');
    addStep(v);
  }

  /** "Your wallets", the way back on a view: the front page, and the browser back on its entry. */
  function goFront(): void {
    if (viewing.kind === 'front') return;
    rewind();
    step = 0;
    showView(steps[0] as HomeView, 'back');
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
  function endEmailStep(): void {
    emailStep?.end();
    emailStep = null;
    emailBox = null;
    emailIdentity?.end();
    emailIdentity = null;
  }

  function signInFailed(p: HomeProblem | null): void {
    if (pending) pending.identity.end();
    wipePending();
    closeChild();
    endEmailStep();
    signingIn = false;
    if (stage === 'signing_in') {
      stage = 'signed_out';
      signInError = p;
      renderSignedOut();
    } else {
      if (p) renewProblem = p;
      renderBanner();
    }
  }

  const plain = (code: string, text: string): HomeProblem => ({ code, text, requestId: null, signInAgain: false });

  /**
   * The click: opens the child sign-in window synchronously, before any await (a window opened after one loses the
   * user's activation in some browsers), then makes this sign-in's key while the child loads. The child repeats its
   * hello every 100 ms, so one that arrives early is answered by a later one.
   */
  function beginSignIn(): void {
    if (signingIn || !homeGoogleRoute(config) || stage === 'loading' || stage === 'stopped' || stage === 'unavailable') return;
    // One sign-in child at a time: a per-app sign-in that hasn't finished gives way to this one.
    moving.yieldChild();
    signingIn = true;
    signInError = null;
    renewProblem = null;
    childName = randomName('hana-home-login-');
    child = win.open(`${env.authOrigin}${HOME_LOGIN_CHILD}`, childName, 'popup,width=480,height=640');
    if (!child) {
      signingIn = false;
      const blocked = plain('popup_blocked', 'Your browser blocked the sign-in window. Allow pop-ups for this page and try again.');
      if (stage === 'signed_out') {
        signInError = blocked;
        renderSignedOut();
      } else {
        renewProblem = blocked;
        renderBanner();
      }
      return;
    }
    if (stage === 'signed_out') {
      stage = 'signing_in';
      showGate(
        d.h(
          'section',
          { class: 'panel home home-gate' },
          d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, `Signing in to ${BRAND.home}`),
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
    track(prepare(opened, config as HomeConfig));
  }

  async function prepare(opened: Window, cfg: HomeConfig): Promise<void> {
    const route = homeGoogleRoute(cfg);
    if (!route) return signInFailed(plain('no_google_client', 'Passport Home can’t sign you in with Google right now.'));
    const clientId = route.clientId;
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
      // The exit client answers at /home/callback only (D491).
      ...(route.exit ? { exit: true as const } : {}),
    };
    pending = { identity: made, clientId, relayId, relayKey, relayReadKey, params, helloAccepted: false };
  }

  /**
   * "Continue with email": the code screens, on this page (no child window). Each "Send code" makes this sign-in's key
   * (so its 15 minutes start then), and the code it mails is for that key alone. Signing in again for an email account
   * sends the code to the same address.
   */
  function beginEmailSignIn(): void {
    const api = emailApi;
    if (signingIn || !api || !emailOpen() || stage === 'loading' || stage === 'stopped' || stage === 'unavailable') return;
    moving.yieldChild();
    signingIn = true;
    signInError = null;
    renewProblem = null;
    const renew = stage === 'signed_in';
    const fixed = renew && account?.provider === 'email' ? emailAddress : null;
    const box = d.h('div', { class: 'home-email-step', attrs: { id: 'home-email' } });
    emailBox = box;
    emailStep = homeEmailStep({
      d,
      root: box,
      isGesture,
      now: () => clock.now(),
      title: renew ? 'Sign in again' : 'Sign in with email',
      // In the top bar, before the page's `h1`: the titles are no headings there (D888).
      ...(renew ? { titleTag: 'p' as const } : {}),
      intro: renew ? 'Passport Home sends a new code to the email you signed in with.' : 'Use the email you sign in to your apps with. Journear sends a 6-digit code to it.',
      address: fixed,
      start: async (address) => {
        emailIdentity?.end();
        emailIdentity = null;
        const made = await newHomeIdentity(env.signer, clock.now());
        if (emailBox !== box) {
          made.end();
          throw new ApiError(499, 'login_cancelled', 'cancelled', null, null);
        }
        emailIdentity = made;
        return api.start(address, 'identity', { homePublicKey: made.publicKey, expiresAtMs: made.expiresAtMs, salt: made.salt });
      },
      api,
      ids: 'home-email',
      onToken: (token, address) => emailSignedIn(token, address),
      onStop: ({ code }) => signInFailed(plain(code === 'home_email_unavailable' ? code : 'email_token_invalid', code === 'home_email_unavailable' ? 'Email sign-in to Passport Home isn’t available right now. Try again later.' : 'The email sign-in could not be finished. Try again.')),
      onCancel: () => signInFailed(null),
    });
    if (renew) {
      renderBanner();
      return;
    }
    stage = 'signing_in';
    showGate(d.h('section', { class: 'panel home home-gate' }, d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, BRAND.home), box));
  }

  /** The code was right: the token must be the issuer's Home identity for this sign-in's key. */
  function emailSignedIn(token: string, address: string): void {
    const made = emailIdentity;
    emailIdentity = null;
    emailStep = null;
    emailBox = null;
    const c = emailTokenClaims(token);
    // Read without its signature (the API checks that against the chain's keys): the Home audience, this key's nonce,
    // the env's issuer, an email `sub`, not expired.
    if (!made || !c || c.aud !== HOME_EMAIL_AUDIENCE || c.nonce !== made.nonce || (env.emailIss !== undefined && c.iss !== env.emailIss) || !EMAIL_SUB_RE.test(c.sub) || c.exp * 1000 <= clock.now()) {
      made?.end();
      return signInFailed(plain('email_token_invalid', 'Journear couldn’t check your email sign-in. Try again.'));
    }
    if (clock.now() >= made.expiresAtMs) {
      made.end();
      return signInFailed(plain('login_timeout', 'The sign-in took too long. Try again.'));
    }
    made.attach(token);
    signingIn = false;
    signedIn(made, { provider: 'email', sub: c.sub }, address);
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
    if (moving.onMessage(e)) return;
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
        if (err instanceof ApiError && (err.status === 410 || err.status === 403)) return signInFailed(plain('token_invalid', 'Journear couldn’t check your Google sign-in. Try again.'));
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
        failure = payload.error === 'access_denied' ? plain('login_cancelled', 'The sign-in was cancelled.') : plain('google_error', 'Google didn’t finish the sign-in. Try again.');
      } else if (!isRelayToken(payload) || payload.accessToken !== undefined || payload.access !== undefined || payload.caseB !== undefined || payload.as !== undefined || isJsonFormToken(payload.idToken)) {
        failure = plain('token_invalid', 'Journear couldn’t check your Google sign-in. Try again.');
      } else {
        const checked = await verifyGoogleIdToken(payload.idToken, { clientId: p.clientId, nonce: p.identity.nonce, nowMs: clock.now(), jwks }).catch(() => null);
        if (checked === null) failure = plain('api_unavailable', 'Journear couldn’t check your Google sign-in right now. Try again.');
        else if (!checked.ok) failure = checked.code === 'token_has_pii' ? plain('token_has_pii', 'Google returned more account details than Journear accepts, so the sign-in was stopped.') : plain('token_invalid', 'Journear couldn’t check your Google sign-in. Try again.');
        else {
          token = payload.idToken;
          who = checked.token.sub;
        }
      }
    } catch {
      failure = plain('token_invalid', 'Journear couldn’t check your Google sign-in. Try again.');
    }
    if (pending !== p) return;
    if (failure || token === null || who === null) return signInFailed(failure ?? plain('token_invalid', 'Journear couldn’t check your Google sign-in. Try again.'));
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
  function signedIn(next: HomeIdentity, who: HomeAccount, address: string | null = null): void {
    // The same person is the same sign-in method and the same id from it: two methods can use the same id for two people.
    const same = stage === 'signed_in' && account !== null && account.provider === who.provider && account.sub === who.sub;
    identity?.end();
    identity = next;
    account = who;
    emailAddress = who.provider === 'email' ? address : null;
    session = 'active';
    signInError = null;
    renewProblem = null;
    scheduleSession(next);
    if (same) {
      problem = null;
      // The same account: only the header's address can differ (the same mailbox, typed in another case).
      replaceWho();
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
    // `/home?view=devices` (D613): the user came to see their devices, so their view opens (one read) for each account.
    if (devicesLink) openAccount('devices');
  }

  function clearScreen(): void {
    moving.leave();
    devices.reset();
    signIns.reset();
    // The name and anything typed for it go with the account.
    profile.reset();
    opened.clear();
    mine = [];
    listed = [];
    nextCursor = null;
    search = null;
    searchDraft = '';
    linked = null;
    list = 'idle';
    // The views and their history entries go with the account (D893): the browser goes back to the page's first entry,
    // and entries left from this account show nothing of it.
    newSteps();
    viewing = steps[0] as HomeView;
    problem = null;
    problemAt = 'top';
    busy = null;
  }

  function signOut(): void {
    epoch += 1;
    clearSessionTimers();
    if (pending) pending.identity.end();
    wipePending();
    closeChild();
    endEmailStep();
    signingIn = false;
    identity?.end();
    identity = null;
    account = null;
    emailAddress = null;
    session = 'none';
    renewProblem = null;
    clearScreen();
    toasts.clear();
    // The top bar's account and notice go with the sign-in.
    bar.account.replaceChildren();
    bar.account.className = 'home-top-account';
    fill('home-banner');
    stage = 'signed_out';
    signInError = null;
    renderSignedOut();
  }

  // ---- screens ----
  function renderSignedOut(): void {
    const google = homeGoogleRoute(config) !== null;
    const email = emailOpen();
    // The login modal pattern: one primary provider (Google when it is offered), email second; there is no passkey.
    const provider = (label: string, run: () => void, id: string, primary: boolean, ic: 'google' | 'mail'): HTMLButtonElement => {
      const b = d.h('button', { class: primary ? 'jp-provider primary' : 'jp-provider', attrs: { type: 'button', id } }, icon(d, ic), label, icon(d, 'chev-r', 'chev'));
      b.addEventListener('click', (e) => {
        if (isGesture(e)) run();
      });
      return b;
    };
    const buttons = [
      google ? provider('Continue with Google', beginSignIn, 'home-sign-in', true, 'google') : null,
      email ? provider('Continue with email', beginEmailSignIn, 'home-sign-in-email', !google, 'mail') : null,
    ].filter((b): b is HTMLButtonElement => b !== null);
    const how = google && email ? 'the Google account or the email' : email ? 'the email' : 'the Google account';
    showGate(
      d.h(
        'section',
        { class: 'panel home home-gate' },
        d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, BRAND.home),
        d.h('p', {}, HOME_TEXT.signedOutAbout),
        d.h('p', { class: 'muted' }, `Sign in with ${how} you use in those apps. You stay signed in for a short time, and not after you close or reload this page.`),
        signInError ? problemView(signInError, 'home-sign-in-problem') : null,
        d.h('div', { class: 'providers' }, ...buttons),
      ),
    );
  }

  /** How the page names the signed-in account in its sentences. */
  const accountName = (): string => (account?.provider === 'email' ? 'email address' : 'Google account');

  function renderUnavailable(p: HomeProblem): void {
    stage = 'unavailable';
    signInError = p;
    showGate(
      d.h(
        'section',
        { class: 'panel home home-gate' },
        d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, BRAND.home),
        problemView(p, 'home-sign-in-problem'),
        d.h('div', { class: 'actions' }, button('Try again', () => track(loadConfig()), { class: 'primary', id: 'home-retry' })),
      ),
    );
  }

  /**
   * Who is signed in, in the top bar: an email account by the address it signed in with (the page's own memory of it,
   * `emailAddress`), a Google account by its method only (Home's Google sign-in asks for `openid` alone: the page never
   * learns the address).
   */
  function whoText(): HTMLElement {
    const el = d.h('span', { class: 'muted', attrs: { id: 'home-who' } });
    // Once the sign-in has ended the address is masked on screen; the page still holds it for "Sign in again".
    if (account?.provider === 'email' && emailAddress) el.append('Signed in as ', addressText(d, session === 'ended' ? maskedAddress(emailAddress) : emailAddress, 'strong', 'home-who-address'));
    else el.append(account?.provider === 'email' ? 'Signed in with email' : 'Signed in with Google');
    return el;
  }

  /** The most lines the who line has taken in this sign-in's bar: it keeps at least that many. */
  let keptLines = 0;
  /**
   * Puts the who line in again (the sign-in ended, or the same account signed in again). Its line keeps at least the
   * lines it took (D888): a masked address is shorter, and the top bar's height must not change under the page.
   */
  function replaceWho(): void {
    const old = byId('home-who');
    if (!old) return;
    noteBarChange();
    // The line's box (a flex item, so one box however many lines it wraps to) over its line height.
    let lines = 0;
    try {
      const lineHeight = Number.parseFloat(win.document.defaultView?.getComputedStyle(old).lineHeight ?? '');
      if (lineHeight > 0) lines = Math.round(old.getBoundingClientRect().height / lineHeight);
    } catch {
      lines = 0;
    }
    if (lines > 1) {
      keptLines = Math.max(lines, keptLines);
      for (let n = 2; n <= WHO_LINES_KEPT; n += 1) bar.account.classList.remove(`home-who-lines-${n}`);
      bar.account.classList.add(`home-who-lines-${Math.min(keptLines, WHO_LINES_KEPT)}`);
    }
    old.replaceWith(whoText());
    barChanged();
  }

  /**
   * The top bar's account part: who is signed in and Sign out (D888). A plain part of the header: it holds a status line
   * and a button, no navigation, so it is no `nav`. Sign out reads "Sign out" and is named "Sign out of Passport Home"
   * (its accessible name and its tooltip, D893), apart from "Sign out this device" under "Devices and auto-approve".
   */
  function renderAccount(): void {
    keptLines = 0;
    bar.account.className = 'home-top-account';
    const out = button('Sign out', signOut, { id: 'home-sign-out', sm: true, ariaLabel: HOME_TEXT.signOutName });
    out.setAttribute('title', HOME_TEXT.signOutName);
    bar.account.replaceChildren(d.h('div', { class: 'home-account' }, d.h('p', { class: account?.provider === 'email' && emailAddress ? 'home-who home-who-email' : 'home-who' }, whoText(), out)));
  }

  /**
   * The signed-in page's frame: built once per sign-in, so a banner or a notice never rebuilds what the user is reading.
   * Who is signed in, Sign out and the sign-in's notice are in the top bar, outside it (D888). Each view brings its own
   * `h1` (D893): the product's name is in the bar's lockup, not a heading on every view.
   */
  function renderShell(): void {
    d.show(d.h('section', { class: 'panel home' }, d.h('div', { attrs: { id: 'home-content' } })));
    renderAccount();
    renderBanner();
    renderContent();
  }

  function renderBanner(): void {
    if (stage !== 'signed_in') return;
    // Where the page was scrolled before the bar changes (a scroll event may not have come yet).
    noteBarChange();
    fill('home-banner', ...bannerParts());
    barChanged();
    layoutChanged();
  }

  /** What the bar's notice shows: a sign-in again that didn't finish, then the sign-in's own state. */
  function bannerParts(): Child[] {
    const failed = renewProblem
      ? problemView(renewProblem, 'home-renew-problem', () => {
          renewProblem = null;
          renderBanner();
        })
      : null;
    if (signingIn && emailBox) {
      // Signing in again with email: the code screens, kept as they are while the banner is drawn again.
      return [d.h('div', { class: 'home-banner home-banner-email jp-card' }, emailBox)];
    }
    if (signingIn) {
      return [alert(d, 'info', { tag: 'div', class: 'home-banner note' }, d.h('p', {}, 'Finish signing in with Google in the other window.'), button('Cancel', () => signInFailed(null), { id: 'home-cancel', sm: true }))];
    }
    // Sign in again with the method this account uses.
    const again = () => button('Sign in again', account?.provider === 'email' ? beginEmailSignIn : beginSignIn, { class: 'primary', id: 'home-sign-in-again', sm: true });
    // The warning and the end keep the space of the longest of their sentences (ui.ts reservedLine), so the bar's
    // height doesn't change when one becomes the other (D888).
    const sessionLine = (text: string): HTMLElement => reservedLine(d, d.h('p', {}, text), 'home-banner-text', [ENDING_TEXT(2), ENDING_TEXT(1), ENDED_TEXT]).box;
    if (session === 'ending' && identity) {
      const minutes = Math.max(1, Math.ceil((identity.endsAtMs - clock.now()) / 60_000));
      return [failed, alert(d, 'warning', { tag: 'div', class: 'home-banner note', attrs: { id: 'home-ending' } }, sessionLine(ENDING_TEXT(minutes)), again())];
    }
    if (session === 'ended') {
      return [failed, alert(d, 'warning', { tag: 'div', class: 'home-banner note', attrs: { id: 'home-ended' } }, sessionLine(ENDED_TEXT), again())];
    }
    return [failed];
  }

  /** The refusal the top of the page shows now: a change of it moves the page, so it starts the guard over (D888). */
  let noticeShown: HomeProblem | null = null;
  function renderNotice(): void {
    if (stage !== 'signed_in') return;
    if (noticeShown !== problem) {
      noticeShown = problem;
      layoutChanged();
    }
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

  /**
   * One wallet (or an app where the user has none) as one row (D893): ONE button, so a click, a tap, Enter and Space all
   * open it. Its tile is the first app's logo over a neutral placeholder (a logo that is missing or fails to load leaves
   * the placeholder); its title names every app that shares the wallet, with their state badges; under it, quieter, where
   * the first app runs and how many more addresses there are; then the coverage badge, exactly as the cards had it. All
   * of it partner-supplied text, except the badges.
   */
  function scopeRow(scope: HomeScope): HTMLElement {
    const cover = coverageText(scope.coverage, scope.mine);
    const origins = scope.apps.flatMap((a) => a.origins);
    const first = origins[0];
    const title =
      scope.apps.length > 0
        ? scope.apps.flatMap((a, i) => [i > 0 ? d.h('span', { class: 'home-row-sep', attrs: { 'aria-hidden': 'true' } }, ' · ') : null, d.h('span', { class: 'home-row-app' }, d.h('span', { class: 'home-row-name' }, a.name), ...appBadges(a))])
        : [scopeTitle(scope)];
    const row = d.h(
      'button',
      { class: 'home-row', attrs: { type: 'button', 'data-scope': scope.scopeId } },
      d.h('span', { class: 'home-tile', attrs: { 'aria-hidden': 'true' } }, icon(d, 'wallet'), scope.apps.map((a) => appLogo(d, env, a.logoUrl)).find((img) => img !== null) ?? null),
      d.h(
        'span',
        { class: 'home-row-text' },
        d.h('span', { class: 'home-row-title' }, ...title),
        first !== undefined ? d.h('span', { class: 'home-row-sub' }, originText(d, first), origins.length > 1 ? ` and ${origins.length - 1} more` : null) : null,
      ),
      badge(cover.badge, cover.tone),
      icon(d, 'chev-r', 'chev'),
    );
    row.addEventListener('click', (e) => {
      if (isGesture(e)) openWallet(scope.scopeId);
    });
    return d.h('li', {}, row);
  }

  const rows = (scopes: HomeScope[], id?: string): HTMLElement => d.h('ul', { class: 'home-rows', ...(id ? { attrs: { id } } : {}) }, ...scopes.map(scopeRow));

  /** A "Your account" row: one button that opens its view. */
  function accountRow(id: string, ic: 'device' | 'person', title: string, sub: string, open: () => void): HTMLElement {
    const row = d.h(
      'button',
      { class: 'home-row', attrs: { type: 'button', id } },
      d.h('span', { class: 'home-tile home-tile-own', attrs: { 'aria-hidden': 'true' } }, icon(d, ic)),
      d.h('span', { class: 'home-row-text' }, d.h('span', { class: 'home-row-title' }, title), d.h('span', { class: 'home-row-sub' }, sub)),
      icon(d, 'chev-r', 'chev'),
    );
    row.addEventListener('click', (e) => {
      if (isGesture(e)) open();
    });
    return d.h('li', {}, row);
  }

  /** A group's empty or failed state (the system's empty state): an icon, what is missing, why, and what to do. */
  const stateBox = (id: string, ic: 'wallet' | 'search' | 'warn' | 'info', title: string, text: string, ...more: Child[]): HTMLElement =>
    d.h('div', { class: 'jp-empty home-empty', attrs: { id } }, icon(d, ic), d.h('strong', {}, title), d.h('span', {}, text), ...more);

  /** A list on its way: two placeholder rows (hidden from screen readers), and the words for them when there are some. */
  const loadingRows = (id: string, words: string | null): HTMLElement =>
    d.h(
      'div',
      { class: 'home-loading', attrs: { id } },
      words ? d.h('p', { class: 'muted', attrs: { role: 'status' } }, words) : null,
      d.h('ul', { class: 'home-rows home-rows-loading', attrs: { 'aria-hidden': 'true' } }, ...[0, 1].map(() => d.h('li', {}, d.h('span', { class: 'home-row home-row-skeleton' }, d.h('span', { class: 'home-tile' }), d.h('span', { class: 'home-row-text' }, d.h('span', { class: 'jp-skel home-skeleton-line' }), d.h('span', { class: 'jp-skel home-skeleton-line short' })))))),
    );

  /** The refusal's slot (`#home-notice`) where it belongs on this view; none where the refusal shows elsewhere. */
  const noticeSlot = (at: 'top' | 'others'): HTMLElement | null => (problemAt === at ? d.h('div', { class: 'home-notice', attrs: { id: 'home-notice' } }) : null);

  /** A view's way back to the front page (D893): "Your wallets", a quiet link-like button. */
  const backLink = (): HTMLElement => button(HOME_TEXT.back, goFront, { class: 'home-back', id: 'home-back', kind: 'ghost', sm: true, icon: 'chev-l' });

  function renderContent(): void {
    if (stage !== 'signed_in') return;
    // What has focus in the page, so a redraw doesn't take it away (D893: the search can be typed in while the list
    // loads, and the list's arrival redraws the page; a Copy pressed again after a check, …).
    const doc = win.document;
    const active = doc.activeElement as HTMLElement | null;
    const keep = active && active.id && byId('home-content')?.contains(active) ? active.id : null;
    const caret = active instanceof (doc.defaultView?.HTMLInputElement ?? HTMLInputElement) ? ([active.selectionStart, active.selectionEnd] as const) : null;
    const v = viewing;
    if (v.kind === 'wallet') {
      // A fresher copy of the listing when the page has one (a "Check now"); else the one it was opened with.
      v.scope = findScope(v.scope.scopeId) ?? v.scope;
      fill('home-content', ...appPage(v.scope));
    } else if (v.kind === 'devices') fill('home-content', backLink(), devices.frontView());
    else if (v.kind === 'profile') fill('home-content', backLink(), profile.frontView());
    else fill('home-content', ...frontPage());
    if (keep) {
      const again = byId(keep);
      if (again && doc.activeElement !== again && !again.hasAttribute('disabled') && focusQuiet(again) && caret && again instanceof (doc.defaultView?.HTMLInputElement ?? HTMLInputElement)) {
        try {
          again.setSelectionRange(caret[0], caret[1]);
        } catch {
          // Not every input has a caret.
        }
      }
    }
    renderNotice();
    // The window's title follows the view's heading (D893): "Wallet details – Passport Home".
    const h1 = byId('home-content')?.querySelector('h1') ?? null;
    setTitle(h1 ? homeViewTitle(headingText(h1)) : BRAND.home);
    watchAbove();
  }

  function frontPage(): Child[] {
    const loading = list === 'loading' || list === 'idle';
    const input = d.h('input', { class: 'jp-input', attrs: { id: 'home-search', type: 'search', maxlength: String(HOME_SEARCH_MAX), autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'home-search-help' } });
    input.value = searchDraft;
    input.addEventListener('input', () => {
      searchDraft = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && isGesture(e)) track(runSearch());
    });
    const others = listed.filter((s) => s.scopeId !== linked?.scopeId);
    // The first list failed: the group says so, with the refusal and "Try again" together (never a lone button).
    const failed = (): HTMLElement => {
      const box = stateBox(
        'home-list-failed',
        'warn',
        HOME_TEXT.walletsFailedTitle,
        problem?.text ?? HOME_TEXT.walletsFailed,
        problem ? d.h('span', { class: 'code muted' }, supportCode(problem.code)) : null,
        problem?.requestId ? d.h('span', { class: 'code muted' }, supportRequest(problem.requestId)) : null,
        d.h('span', { class: 'actions' }, button(HOME_TEXT.retry, () => track(loadFirst()), { class: 'primary', id: 'home-reload' })),
      );
      box.setAttribute('role', 'alert');
      return box;
    };
    const othersList = (): Child[] => {
      if (loading) return [loadingRows('home-others-loading', null)];
      if (list === 'error') return [d.h('p', { class: 'muted', attrs: { id: 'home-others-failed' } }, HOME_TEXT.othersFailed)];
      if (others.length === 0 && !nextCursor) return [stateBox('home-others-empty', 'info', HOME_TEXT.othersEmptyTitle, HOME_TEXT.othersEmpty)];
      return [
        others.length > 0 ? rows(others, 'home-others-list') : null,
        nextCursor ? d.h('div', { class: 'actions start' }, button(busy === 'more' ? 'Loading…' : 'Show more', () => track(loadMore()), { id: 'home-more', disabled: busy !== null })) : null,
      ];
    };
    return [
      d.h(
        'section',
        { class: 'home-group', attrs: { id: 'home-mine', 'aria-labelledby': 'home-title' } },
        d.h('div', { class: 'home-view-head' }, d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, HOME_TEXT.walletsTitle), d.h('p', { class: 'home-lede' }, HOME_TEXT.walletsLede)),
        list === 'error' ? null : noticeSlot('top'),
        loading
          ? loadingRows('home-loading', HOME_TEXT.walletsLoading)
          : list === 'error'
            ? failed()
            : mine.length > 0
              ? rows(mine, 'home-mine-list')
              : stateBox('home-empty', 'wallet', HOME_TEXT.walletsEmptyTitle, HOME_TEXT.walletsEmpty(accountName())),
      ),
      list === 'ready' && linked && !mine.some((s) => s.scopeId === linked?.scopeId)
        ? d.h(
            'section',
            { class: 'home-group', attrs: { id: 'home-linked', 'aria-labelledby': 'home-linked-title' } },
            d.h('h2', { attrs: { id: 'home-linked-title' } }, HOME_TEXT.linkedTitle),
            alert(d, 'info', { class: 'note' }, `The link you opened is for the app below. ${BRAND.company} has no wallet on record for this ${accountName()} in it. Its name and address are the app’s own, not ${BRAND.company}’s.`),
            rows([linked]),
          )
        : null,
      d.h(
        'section',
        { class: 'home-group', attrs: { id: 'home-your-account', 'aria-labelledby': 'home-account-title' } },
        d.h('h2', { attrs: { id: 'home-account-title' } }, HOME_TEXT.accountTitle),
        d.h('ul', { class: 'home-rows' }, accountRow('home-open-devices', 'device', HOME_DEVICES_TITLE, HOME_TEXT.devicesRow, () => openAccount('devices')), accountRow('home-open-profile', 'person', HOME_NAME_TITLE, HOME_TEXT.nameRow, () => openAccount('profile'))),
      ),
      d.h(
        'section',
        { class: 'home-group home-find', attrs: { id: 'home-others', 'aria-labelledby': 'home-others-title' } },
        d.h('div', { class: 'home-view-head' }, d.h('h2', { attrs: { id: 'home-others-title' } }, HOME_TEXT.othersTitle), d.h('p', { class: 'home-lede' }, HOME_TEXT.othersLede)),
        d.h(
          'div',
          { class: 'jp-field home-search-field', attrs: { role: 'search' } },
          d.h('label', { class: 'jp-label', attrs: { for: 'home-search' } }, HOME_TEXT.searchLabel),
          d.h(
            'div',
            { class: 'home-search-row' },
            input,
            button(busy === 'search' ? 'Searching…' : 'Search', () => track(runSearch()), { id: 'home-search-go', disabled: busy !== null, icon: 'search' }),
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
          d.h('p', { class: 'jp-hint', attrs: { id: 'home-search-help' } }, HOME_TEXT.searchHint),
        ),
        noticeSlot('others'),
        ...(search
          ? [
              d.h(
                'div',
                { attrs: { id: 'home-results' } },
                d.h('h3', { attrs: { id: 'home-results-title', tabindex: '-1' } }, 'Results for ', d.h('strong', {}, search.term)),
                search.results.length > 0 ? rows(search.results, 'home-results-list') : stateBox('home-no-results', 'search', HOME_TEXT.noResultsTitle, HOME_TEXT.noResults),
              ),
            ]
          : othersList()),
      ),
    ];
  }

  let copied: string | null = null;
  function copyButton(what: string, value: string, id: string): HTMLButtonElement {
    return button(
      'Copy',
      () => {
        const c = clipboard();
        // A copy that worked is a toast (nothing to do about it); one that didn't stays on the page, under the
        // addresses, because the user has to copy by hand. Its line keeps its space (D888): nothing below it moves.
        const failed = (text: string) => {
          copied = text;
          fill('home-copied', text);
          clearTimeout(copiedTimer);
          copiedTimer = setTimeout(() => {
            copied = null;
            fill('home-copied');
          }, COPIED_MS);
        };
        if (!c) return failed(COPY_FAILED.none(what));
        track(
          c.writeText(value).then(
            () => {
              clearTimeout(copiedTimer);
              copied = null;
              fill('home-copied');
              toasts.show({ tone: 'success', title: `Copied the ${what}.` });
            },
            () => failed(COPY_FAILED.refused(what)),
          ),
        );
      },
      { class: 'home-copy', id, ariaLabel: `Copy the ${what}`, sm: true, icon: 'copy' },
    );
  }

  /** One listing's page: its apps, whether Hana can open the wallet, the addresses on record and the Support ID. */
  function appPage(scope: HomeScope): Child[] {
    // The app the page's link named, the user's own included: a link can come from anyone ("open this, press Move this
    // wallet, paste the key here"), so the page never offers to open that wallet in this page load.
    const fromLink = linked?.scopeId === scope.scopeId || linkScope === scope.scopeId;
    const cover = coverageText(scope.coverage, scope.mine, typeof homeExportRoute(scope, config, fromLink, account?.provider ?? 'google', emailApi !== null) !== 'string');
    const stellar = STELLAR_ACCOUNT_URL[env.network];
    const nearExplorer = NEAR_ACCOUNT_URL[env.network];
    // Addresses on record, or, where Hana has none, those of the wallet the user opened here in this page.
    const fromWallet = scope.addresses.length === 0 ? (opened.get(scope.scopeId) ?? []) : [];
    const shown: readonly HomeAddress[] = scope.addresses.length > 0 ? scope.addresses : fromWallet;
    const addressRows = shown.map((a) => {
      const name = ADDRESS_NAME[a.chain];
      return d.h(
        'div',
        { class: 'home-address' },
        d.h('p', { class: 'home-address-label' }, ADDRESS_LABEL[a.chain]),
        d.h('p', { class: 'mono home-address-value', attrs: { id: `home-address-${a.chain}` } }, a.address),
        d.h(
          'p',
          { class: 'home-address-actions' },
          copyButton(name, a.address, `home-copy-${a.chain}`),
          // The link is built from a fixed address of Hana's choosing and an address of the chain's own form.
          a.chain === 'stellar' && stellar ? d.h('a', { class: 'explorer', attrs: { href: `${stellar.url}${encodeURIComponent(a.address)}`, target: '_blank', rel: 'noopener noreferrer' } }, `View on ${stellar.name}`, icon(d, 'ext')) : null,
          a.chain === 'near' && nearExplorer ? d.h('a', { class: 'explorer', attrs: { href: `${nearExplorer.url}${encodeURIComponent(a.address)}`, target: '_blank', rel: 'noopener noreferrer' } }, `View on ${nearExplorer.name}`, icon(d, 'ext')) : null,
        ),
      );
    });
    // D755: NEAR is on record only once the user signed in to this app through an SDK of 0.4.0 or later; say so plainly.
    if (shown.length > 0 && !shown.some((a) => a.chain === 'near')) {
      addressRows.push(
        d.h(
          'div',
          { class: 'home-address' },
          d.h('p', { class: 'home-address-label' }, ADDRESS_LABEL.near),
          d.h('p', { class: 'muted', attrs: { id: 'home-no-near' } }, 'No NEAR account on record here yet. It appears after you next sign in to this app, if the app uses NEAR.'),
        ),
      );
    }
    // What the copy line may say on this page: its space is that of the longest (D888).
    const copyWhats = [...shown.map((a) => ADDRESS_NAME[a.chain]), ...(scope.supportId ? ['Support ID'] : [])];
    const copyLine = reservedLine(
      d,
      d.h('p', { class: 'copy-status', attrs: { id: 'home-copied', role: 'status' } }, copied),
      'home-copied-box',
      copyWhats.flatMap((what) => [COPY_FAILED.none(what), COPY_FAILED.refused(what)]),
    );
    // The apps' label: for the user's wallet, the apps that use it (D893); for an app where Journear has no wallet of
    // theirs, as before.
    const appsLabel = scope.mine ? (scope.apps.length > 1 ? HOME_TEXT.walletApps : HOME_TEXT.walletApp) : scope.apps.length > 1 ? 'Apps that share one wallet' : 'App';
    return [
      backLink(),
      d.h(
        'section',
        { class: 'home-app-details', attrs: { 'aria-labelledby': 'home-app-title' } },
        // The heading is Journear's own words, always, and names the view (D893): "Wallet details" for the user's wallet,
        // "App details" for an app where they have none. An app's name is the partner's: it is a labelled value in the
        // box below, never the heading of a page on Journear's origin.
        d.h('h1', { attrs: { id: 'home-app-title', tabindex: '-1' } }, scope.mine ? HOME_TEXT.walletTitle : HOME_TEXT.appTitle),
        noticeSlot('top'),
        d.h('h2', { attrs: { id: 'home-app-label' } }, appsLabel),
        scope.apps.length > 0 ? d.h('div', { class: 'home-card-apps home-app-all', attrs: { 'aria-labelledby': 'home-app-label', role: 'group' } }, ...scope.apps.map((a) => appLine(a, 5))) : d.h('p', { class: 'muted' }, scopeTitle(scope)),
        d.h('h2', {}, cover.question),
        d.h('p', { attrs: { id: 'home-coverage' } }, badge(cover.badge, cover.tone), ' ', busy === 'check' ? 'Checking…' : cover.detail),
        scope.coverage === 'unknown' && busy !== 'check' ? d.h('div', { class: 'actions start' }, button('Check now', () => track(checkScope(scope)), { id: 'home-check' })) : null,
        // The addresses and the Support ID: side by side where there is room, one above the other on a phone.
        d.h(
          'div',
          { class: 'home-app-split' },
          d.h(
            'div',
            { class: 'home-app-addresses' },
            d.h('h2', {}, 'Your addresses'),
            addressRows.length > 0
              ? d.h(
                  'div',
                  { class: 'home-addresses' },
                  fromWallet.length > 0 ? d.h('p', { class: 'muted', attrs: { id: 'home-opened-note' } }, 'From the wallet you opened on this page. Journear had no address on record for you here.') : null,
                  ...addressRows,
                  // The copy line, at the card's foot (its space kept, so nothing anywhere moves when it speaks).
                  copyLine.box,
                )
              : d.h('p', { class: 'muted', attrs: { id: 'home-no-address' } }, scope.mine ? HOME_TEXT.noAddress : `${BRAND.company} has no wallet on record for this ${accountName()} in this app.`),
          ),
          scope.supportId
            ? d.h(
                'div',
                { class: 'home-support' },
                d.h('h2', {}, 'Support ID'),
                d.h('p', {}, d.h('span', { class: 'mono', attrs: { id: 'home-support-id' } }, scope.supportId), ' ', copyButton('Support ID', scope.supportId, 'home-copy-support')),
                d.h('p', { class: 'muted' }, 'Give this to the app’s support team if you need help. It doesn’t reveal your email or your Google account.'),
                // With no addresses, the copy line is the Support ID's.
                addressRows.length === 0 ? copyLine.box : null,
              )
            : null,
        ),
      ),
      // Where the wallet's tools go: the devices signed in to it, the ways to sign in to it, the name its apps get, and
      // moving the wallet out (last, never featured; its screens' titles stay `h3`, home-export.ts unchanged, D893).
      d.h('div', { attrs: { id: 'home-app-extras' } }, devices.appView(scope), signIns.appView(scope), profile.appView(scope), moving.view(scope, fromLink)),
    ];
  }

  // ---- start ----
  async function loadConfig(): Promise<void> {
    stage = 'loading';
    showGate(d.h('section', { class: 'panel home home-gate' }, d.h('h1', { attrs: { id: 'home-title', tabindex: '-1' } }, BRAND.home), d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Loading…')));
    try {
      config = await api.config();
    } catch (err) {
      renderUnavailable(homeProblem(err));
      return;
    }
    clock.sync(config.serverTimeMs);
    if (config.signer !== env.signer) return renderUnavailable(plain('config_mismatch', 'Passport Home’s settings don’t match this page, so sign-in is off. Try again later.'));
    // D550's open point, settled: with no shared Google client in force, Google sign-in uses the exit client; only with
    // neither, and no email sign-in, is there nothing to offer.
    if (!homeGoogleRoute(config) && !emailOpen()) return renderUnavailable(plain('no_google_client', 'Passport Home can’t sign you in right now. Try again later.'));
    stage = 'signed_out';
    signInError = null;
    renderSignedOut();
  }

  if (isFramed(win)) {
    stage = 'stopped';
    signInError = plain('config_mismatch', `${BRAND.home} can’t run inside another page.`);
    showGate(d.h('section', { class: 'panel error', attrs: { role: 'alert' } }, d.h('h1', {}, `${BRAND.home} stopped`), d.h('p', {}, signInError.text)));
  } else {
    // Whoever opened this window gets no handle on it from here on.
    try {
      (win as { opener: unknown }).opener = null;
    } catch {
      // A browser that refuses the write still gives the opener nothing: the page takes no message from it.
    }
    win.addEventListener('message', onMessage);
    // D893: Back and Forward between Home's views; the page restores scroll and focus itself.
    win.addEventListener('popstate', onPopState);
    try {
      const h = hist();
      if (h && 'scrollRestoration' in h) h.scrollRestoration = 'manual';
    } catch {
      // Scroll restoration is a convenience.
    }
    win.document.body?.append(toasts.root);
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
      return viewing.kind === 'wallet' ? viewing.scope.scopeId : null;
    },
    get view() {
      return viewing.kind;
    },
    get errorCode() {
      return (stage === 'signed_in' ? (problem ?? renewProblem) : signInError)?.code ?? null;
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
    moving,
    devices,
    profile,
    signIns,
    idle,
  };
}
