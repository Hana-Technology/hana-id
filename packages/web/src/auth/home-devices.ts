// Passport Home's "Devices and auto-approve" (home-page.ts mounts it as its own view under "Your account", for every
// wallet, and on each wallet's page, D893): where the user is signed in to their apps with Journear, which of those
// devices may sign without asking, and the apps they share their email with, each with a way to stop it
// (docs/hana-home-spec.md F5, D45, D98 item 9, D411 point 6). On a wallet's page (D901) the email sharing is drawn apart
// (`emailView`), as the email part of the card "What these apps get from you", from the same read: its own line, its
// own "Show email sharing" (the same rule as "Show devices") and "Stop sharing email" with its confirmation.
//
// It reads `GET /v1/home/devices` only when the user asks: "Show devices", opening the view from "Your account"
// (`openFront`), which the page also does once after sign-in when it was opened at `/home?view=devices` (the address
// Journear's own "Manage in Passport Home" links will use; nothing links to it yet), or opening a wallet's Security tab
// by a press (`openApp`, D897: that wallet only, once while its page is open, quietly: no focus move, no alert; the
// cards wait for "Show devices", which reads again when that read is over a minute old). Back and Forward never read.
// What is on screen is drawn again, with no request, when the page becomes visible, at midnight and when a date on it
// passes, so "today", "Auto-approve on" and "may sign without asking" never stay false. A stop
// asks first, on the page itself, saying what stopping does and doesn't do, and is sent once, on a real click:
//   - "Stop auto-approving": that device's consent; auto-signing stops there within about 10 seconds (D465);
//   - "Sign out this device": its share, and its consent with it;
//   - "Stop sharing email": every address the account shares with that app.
// The answer is never re-sent by the page, and a refusal reads as one of Hana's sentences (home-problems.ts).
//
// SECURITY: app names, origins and the policy's label are the partner's words: they reach the page as text nodes only,
// never as a heading, a link or markup. The device label is the vault's coarse "Chrome on macOS", also text. Ids are held
// in memory only, for the stop the user clicks. Nothing here is written to storage, a URL or a log.
import { type Child, type Dom, originText, supportCode, supportRequest } from './dom.ts';
import { type HomeConsent, type HomeDevice, type HomeDeviceScope, type HomeDevicesApi, type HomeDevicesQuery, type HomeIdentity, type HomeScope, type HomeStop, type HomeStopResult, type HomeTabConsent, HOME_DEVICES_MAX } from './home-api.ts';
import { type HomeProblem, homeProblem, plainProblem } from './home-problems.ts';
import type { GestureCheck, PageWindow } from './page-window.ts';
import { BTN, alert, icon } from './ui.ts';

export const HOME_DEVICES_TITLE = 'Devices and auto-approve';
/**
 * What the section says on an app's page where Journear has no wallet of the user's on record (no wallet called theirs).
 * D901: the email sharing is in "What this app gets from you", so the devices' sentence no longer names it.
 */
export const HOME_DEVICES_APP_INTRO = 'Where you’re signed in to this app with Journear, and what those devices may sign without asking.';
/** What the section says on a wallet's page (D893: "this wallet"; D901: the email is in its own card). */
export const HOME_DEVICES_WALLET_INTRO = 'Where you’re signed in to this wallet, and what those devices may sign without asking.';
/** D901: the email sharing's part of "What these apps get from you" on a wallet's page. */
export const HOME_EMAIL_TITLE = 'Your email';
export const HOME_EMAIL_SHOW = 'Show email sharing';
/** The one query `/home` takes for this section (exactly it): open it after sign-in. */
export const HOME_DEVICES_VIEW = 'devices';

/** Whether the page's address asks for the devices section: exactly `?view=devices`. */
export function devicesLinked(search: string): boolean {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  return keys.length === 1 && keys[0] === 'view' && q.getAll('view').length === 1 && q.get('view') === HOME_DEVICES_VIEW;
}

/**
 * What each stop says before it is sent: `points`, at most three short lines, always shown; `more`, the full detail behind
 * a "More" disclosure. The short lines never promise more than the detail says.
 */
export const HOME_STOP_CONFIRM: Readonly<Record<HomeStop['kind'], { title: string; points: readonly string[]; more?: readonly string[]; go: string; going: string }>> = Object.freeze({
  share: {
    title: 'Sign out this device?',
    points: ['Signs that device out of this app and stops automatic signing there.', 'A tab already open there can keep signing for up to about a minute.'],
    more: [
      'Automatic signing stops on that device within about 10 seconds.',
      'The next time the app is opened or reloaded there, it asks to sign in again.',
      'Whoever has that device can still approve and sign in a tab of the app that is already open there for up to about a minute, or for up to about 3 minutes while that device can’t reach Journear.',
      'A tab nobody is using may still look signed in for a few minutes, but it can’t sign anything.',
      'Signatures and transactions already made stay valid. Signing out doesn’t move your money: if someone else may have your wallet’s key, move your money to a new wallet.',
    ],
    go: 'Sign out',
    going: 'Signing out…',
  },
  consent: {
    title: 'Stop auto-approving on this device?',
    points: [
      'Automatic signing stops within about 10 seconds. After that, the app asks you to approve each request on that device.',
      'The device stays signed in.',
      'Signatures already made stay valid.',
    ],
    go: 'Stop auto-approving',
    going: 'Stopping…',
  },
  email: {
    title: 'Stop sharing your email with this app?',
    points: [
      'The app’s new sign-ins and its dashboard lose your address at once.',
      'The app may still see it for up to an hour.',
      'A copy the app already stored is the app’s own: Journear can’t delete it. Ask the app if you want it deleted.',
    ],
    go: 'Stop sharing',
    going: 'Stopping…',
  },
});

/** What the page says once a stop is done (`changed`: false when it had already ended). */
export function stopDoneText(kind: HomeStop['kind'], changed: boolean): string {
  if (kind === 'share') return changed ? 'Signed out. Automatic signing stops there within about 10 seconds, a tab already open there can’t sign after about a minute, and the app asks to sign in again the next time it opens there.' : 'That device was already signed out.';
  if (kind === 'consent') return changed ? 'Auto-approve stopped. Within about 10 seconds the app asks you to approve each request on that device.' : 'Auto-approve had already stopped on that device.';
  return changed ? 'Your email is no longer shared with this app. Its new sign-ins don’t include it.' : 'Your email was no longer shared with this app.';
}

/** A name for a device the vault didn't label (a vault before labels). */
export const UNNAMED_DEVICE = 'A browser (not named)';

export interface HomeDevicesDeps {
  win: PageWindow;
  d: Dom;
  api: HomeDevicesApi;
  isGesture: GestureCheck;
  /** Hana Home's usable sign-in, or null when there is none. */
  session: () => HomeIdentity | null;
  /** The API refused Hana Home's sign-in itself (a 401). */
  onSignedOut: () => void;
  track: (p: Promise<unknown>) => void;
  /** An app's name from the page's own listings, for an app the answer didn't name. */
  appName?: (appId: string) => string | null;
  /** The clock "today" and "tomorrow" are told by (default: the device's). */
  now?: () => number;
  /** A timer (default: the window's); returns its cancel. */
  setTimer?: (run: () => void, ms: number) => () => void;
}

export type HomeDevicesState = 'closed' | 'loading' | 'ready';

export interface HomeDevices {
  readonly front: HomeDevicesState;
  readonly app: HomeDevicesState;
  /** The stop whose confirmation is on screen, or null. */
  readonly confirming: string | null;
  /** The code of the problem on screen in either view, or null. */
  readonly errorCode: string | null;
  /** How many requests this section has sent. */
  readonly requests: number;
  /** The section of the "Devices and auto-approve" view (every wallet; its heading is the view's `h1`). The same element each time. */
  frontView(): HTMLElement;
  /** The user opened that view (its row under "Your account", or `?view=devices`): reads once if it hasn't yet. */
  openFront(): void;
  /** The user left that view: an open confirmation closes (one on its way is left to finish). What it shows stays. */
  leaveFront(): void;
  /** The section of `scope`'s page. Another app's page starts it closed again; the same app keeps what it shows. */
  appView(scope: HomeScope): HTMLElement;
  /**
   * D897: the person opened the wallet's Security tab: one read for this wallet, unless it is read already or on its
   * way, so the section's one line can say where the wallet is signed in. The details stay behind "Show devices".
   */
  openApp(): void;
  /** Whether the wallet's page shows the details (true once "Show devices" is pressed). */
  readonly appExpanded: boolean;
  /**
   * D901: the email part of the wallet's "What these apps get from you" card, for `scope` (the same scope as `appView`;
   * the same element each time). It shows what the devices' read says about the email; its rows, each with "Stop
   * sharing email", wait for "Show email sharing" (the same rule as "Show devices": the tab's read while fresh).
   */
  emailView(scope: HomeScope): HTMLElement;
  /** Whether the email part shows its rows (true once "Show email sharing" is pressed). */
  readonly emailExpanded: boolean;
  /** The user left an app's page: its section closes, and opening the page again reads it again. */
  leaveApp(): void;
  /** Another account, or signed out: everything is dropped and both views close. */
  reset(): void;
}

type Where = 'front' | 'app';

interface View {
  state: HomeDevicesState;
  scopes: HomeDeviceScope[];
  nextCursor: string | null;
  problem: HomeProblem | null;
  busy: 'load' | 'more' | null;
  /** Sentences after a stop, by scope. */
  notes: Map<string, string>;
  /** The details are on screen (the front view always; a wallet's page once "Show devices" is pressed, D897). */
  expanded: boolean;
  /** When the shown answer was read (D897: "Show devices" reads again when the tab's own read is over a minute old). */
  readAtMs: number | null;
  /** The Security tab's own read failed (D897): said quietly, never as an alert nobody asked for. */
  quietFailed: boolean;
  /** D901 (a wallet's page only): the email part shows its rows ("Show email sharing" pressed). */
  emailExpanded: boolean;
  /** D901: the sentence after an email stop on a wallet's page, said in the email part. */
  emailNote: string | null;
  /** D901: which part of a wallet's page a refusal shows in: where the person acted. */
  problemAt: Part;
}

/** D901: a wallet's page has two parts that show this section's read: the devices, and the email in its own card. */
type Part = 'devices' | 'email';

const newView = (): View => ({ state: 'closed', scopes: [], nextCursor: null, problem: null, busy: null, notes: new Map(), expanded: true, readAtMs: null, quietFailed: false, emailExpanded: false, emailNote: null, problemAt: 'devices' });

/** D897: "Show devices" shows the Security tab's read only while it is at most this old; older, the press reads again. */
export const DEVICES_FRESH_MS = 60_000;

const stopKey = (s: HomeStop, scopeId: string): string => (s.kind === 'consent' ? `consent:${s.consentId}` : s.kind === 'share' ? `share:${s.shareId}` : `email:${scopeId}:${s.appId}`);

function when(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** The device's 12- or 24-hour preference, for times written in English (D897). */
function hourCycle(): 'h12' | 'h23' {
  try {
    const c = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return c === 'h23' || c === 'h24' ? 'h23' : 'h12';
  } catch {
    return 'h12';
  }
}

/** A time in English, as the device prefers its hours ("2:20 PM" or "14:20"). */
function timeOf(ms: number): string {
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', hourCycle: hourCycle() }).format(ms);
}

/** The full date and time, for a screen reader and a tooltip (D897): "Monday, November 23, 2026 at 2:20 PM". */
export function whenFull(ms: number): string {
  try {
    return `${new Intl.DateTimeFormat('en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(ms)} at ${timeOf(ms)}`;
  } catch {
    return when(ms);
  }
}

/**
 * A date and time in a few plain words (D897): "today at 2:20 PM", "tomorrow at 2:20 AM", "yesterday at 9:05 AM", "on
 * Nov 25 at 2:20 AM" (this year), else "on Nov 25, 2027 at 2:20 AM". In English like the sentence around it (never
 * "on 2027年1月2日 at"), with the device's 12- or 24-hour preference.
 */
export function whenWords(ms: number, nowMs: number): string {
  try {
    const day = (t: number): number => {
      const x = new Date(t);
      return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
    };
    const time = timeOf(ms);
    const diff = day(ms) - day(nowMs);
    if (diff === 0) return `today at ${time}`;
    if (diff === 1) return `tomorrow at ${time}`;
    if (diff === -1) return `yesterday at ${time}`;
    const sameYear = new Date(ms).getFullYear() === new Date(nowMs).getFullYear();
    const date = new Intl.DateTimeFormat('en', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(ms);
    return `on ${date} at ${time}`;
  } catch {
    return when(ms);
  }
}

/** What `devicesSummary` needs of a scope's answer. */
export interface DevicesSummaryScope {
  readonly apps: readonly { readonly appId: string; readonly name: string }[];
  readonly devices: readonly { readonly consent: unknown }[];
  readonly consents: readonly unknown[];
  readonly email: readonly { readonly appId: string }[] | null;
}

/**
 * The section's one line on a wallet's page (D897), from its one read: where the wallet is signed in (a "place" is one
 * sign-in: one browser on one site for one app, so one laptop in two apps is two places) and what may sign without
 * asking. `mine`: the person's own wallet ("this wallet"), else an app's page ("this app"). D901: which app gets the email
 * is said in "What these apps get from you" (`emailSummary`), no longer here.
 */
export function devicesSummary(s: DevicesSummaryScope, mine = true): string {
  const thing = mine ? 'this wallet' : 'this app';
  const n = s.devices.length;
  const k = s.devices.filter((x) => x.consent !== null).length;
  const t = s.consents.length;
  const parts: string[] = [];
  if (n === 0) parts.push(t === 0 ? `Not signed in to ${thing} anywhere right now.` : `Not kept signed in to ${thing} anywhere.`);
  else {
    parts.push(`Signed in to ${thing} in ${n} ${n === 1 ? 'place' : 'places'}.`);
    if (n === 1) parts.push(k === 1 ? 'It may sign without asking.' : 'It asks you before signing.');
    else parts.push(k === 0 ? 'Each asks you before signing.' : `${k} of them may sign without asking.`);
  }
  if (t > 0) parts.push(`${t === 1 ? 'A tab' : `${t} tabs`} that may still be open can${n > 0 ? ' also' : ''} sign without asking.`);
  return parts.join(' ');
}

/** D901: how the email part names the apps: "the app" (a wallet of one app), "this app" (an app's page), "these apps". */
const emailWho = (apps: number, mine: boolean): string => (apps > 1 ? 'these apps' : mine ? 'the app' : 'this app');

/** D901: what the email part says before anything is read (or when the read failed). */
export function emailAbout(apps: number, mine = true): string {
  return `Whether you share your email address with ${emailWho(apps, mine)}.`;
}

/**
 * D901: the email part's one line, from the devices' read (the sentences D897's line and the devices section said):
 * which app gets the email ("Your email is shared with Sodax."), that none does, or that Passport Home can't tell.
 * `nameOf`: an app's name (partner text, only ever set as text).
 */
export function emailSummary(s: Pick<DevicesSummaryScope, 'apps' | 'email'>, mine = true, nameOf: (appId: string) => string = (id) => s.apps.find((a) => a.appId === id)?.name ?? 'an app'): string {
  const who = emailWho(s.apps.length, mine);
  if (s.email === null) return `Passport Home can’t tell right now whether you share your email with ${who}.`;
  if (s.email.length === 0) return `You aren’t sharing your email address with ${who}.`;
  const names = s.email.map((e) => nameOf(e.appId));
  const to = s.apps.length <= 1 ? who : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} apps`;
  return `Your email is shared with ${to}.`;
}

/**
 * What of an answer is still true at `nowMs` (D897): an auto-approve past its end is off; a sign-in past its last
 * moment, and a tab's auto-approve past its end, are gone. Nothing is read: the page draws what it has again.
 */
export function stillTrue<S extends HomeDeviceScope>(s: S, nowMs: number): S {
  return {
    ...s,
    devices: s.devices.filter((x) => x.expiresAtMs > nowMs).map((x) => (x.consent && x.consent.expiresAtMs <= nowMs ? { ...x, consent: null } : x)),
    consents: s.consents.filter((c) => c.expiresAtMs > nowMs),
  };
}

/** The next moment something on screen stops being true (an end or a sign-out), or null. */
export function nextChange(scopes: readonly HomeDeviceScope[], nowMs: number): number | null {
  const times = scopes.flatMap((s) => [...s.devices.flatMap((x) => [x.idleUntilMs, x.expiresAtMs, ...(x.consent ? [x.consent.expiresAtMs] : [])]), ...s.consents.map((c) => c.expiresAtMs)]).filter((t) => t > nowMs);
  return times.length > 0 ? Math.min(...times) : null;
}

/** The next local midnight after `nowMs` ("today" becomes "yesterday"). */
export function nextMidnight(nowMs: number): number {
  const x = new Date(nowMs);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate() + 1).getTime();
}

export function startHomeDevices(deps: HomeDevicesDeps): HomeDevices {
  const { d, isGesture } = deps;
  const now = deps.now ?? (() => Date.now());
  /** A date as a few plain words, with the full date for a tooltip and a screen reader (D897). */
  const at = (ms: number): HTMLElement =>
    d.h('span', { class: 'home-when' }, d.h('time', { attrs: { datetime: new Date(ms).toISOString(), title: whenFull(ms), 'aria-hidden': 'true' } }, whenWords(ms, now())), d.h('span', { class: 'sr-only' }, `${whenFull(ms)}`));
  let epoch = 0;
  let requests = 0;
  const views: Record<Where, View> = { front: newView(), app: newView() };
  let appScope: HomeScope | null = null;
  let confirm: { where: Where; key: string } | null = null;
  let stopping: string | null = null;

  const frontRoot = d.h('section', { class: 'home-devices', attrs: { id: 'home-devices', 'aria-labelledby': 'home-devices-title' } });
  const appRoot = d.h('section', { class: 'home-devices home-devices-app', attrs: { id: 'home-app-devices', 'aria-labelledby': 'home-app-devices-title' } });
  /** D901: the email part of the wallet's "What these apps get from you" card. */
  const emailRoot = d.h('section', { class: 'home-gets-part home-email-part', attrs: { id: 'home-app-email', 'aria-labelledby': 'home-app-email-title' } });

  /** A button that acts only on a real click: secondary unless `kind` says otherwise (danger only inside a confirmation). */
  const button = (label: string, id: string, onClick: () => void, o: { cls?: string; disabled?: boolean; describedBy?: string; kind?: keyof typeof BTN; sm?: boolean } = {}): HTMLButtonElement => {
    const cls = [o.cls, BTN[o.kind ?? 'secondary'], o.sm ? 'jp-btn-sm' : null].filter(Boolean).join(' ');
    const b = d.h('button', { class: cls, attrs: { type: 'button', id, ...(o.describedBy ? { 'aria-describedby': o.describedBy } : {}) } }, label);
    if (o.disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', (e) => {
      if (isGesture(e)) onClick();
    });
    return b;
  };
  const badge = (text: string, tone: 'ok' | 'plain'): HTMLElement => d.h('span', { class: `badge badge-${tone} ${tone === 'ok' ? 'jp-badge jp-badge-success' : 'jp-badge'}` }, text);
  /** A setting row (the system's `.jp-setting`): what it is and a line about it on the left, its one control on the right. */
  const settingRow = (cls: string, text: Child[], control: Child): HTMLElement =>
    d.h('div', { class: `jp-setting home-setting ${cls}` }, d.h('span', { class: 'home-setting-text' }, ...text), control ? d.h('span', { class: 'home-setting-control' }, control) : null);
  /** The system's empty state. */
  const empty = (id: string, title: string, text: string): HTMLElement => d.h('div', { class: 'jp-empty home-empty', attrs: { id } }, icon(d, 'wallet'), d.h('b', {}, title), d.h('span', {}, text));
  const focus = (id: string): void => {
    try {
      deps.win.document.getElementById(id)?.focus();
    } catch {
      // Focus is a convenience.
    }
  };
  /**
   * D897: a read that finished takes the focus to the section's heading only if nobody moved it meanwhile: it is still
   * on that heading, or nowhere (the pressed button was drawn over by "Loading…").
   */
  const focusHeading = (id: string): void => {
    const a = deps.win.document.activeElement;
    if (a === null || a === deps.win.document.body || a.id === id) focus(id);
  };

  // ---- requests: one at a time per view, never repeated by the page ----

  /** Runs one call with Hana Home's sign-in; null when not sent or failed (the problem is then on `view`). */
  async function send<T>(view: View, run: (id: HomeIdentity) => Promise<T>): Promise<T | null> {
    const id = deps.session();
    if (!id) {
      view.problem = plainProblem('home_signed_out');
      return null;
    }
    const at = epoch;
    requests += 1;
    try {
      const out = await run(id);
      return at === epoch ? out : null;
    } catch (err) {
      if (at !== epoch) return null;
      // A new sign-in took over while this was on its way: what it answered says nothing now.
      const current = deps.session();
      if (current !== null && current !== id) return null;
      const p = homeProblem(err);
      if (p.signInAgain) {
        deps.onSignedOut();
        view.problem = plainProblem('home_signed_out');
        return null;
      }
      view.problem = p;
      return null;
    }
  }

  /**
   * `quiet`: read because the Security tab opened (D897), so the focus stays where the person left it. `part`: on a
   * wallet's page, where the person asked (D901: the devices, or the email part), so a refusal and the focus land there.
   */
  async function load(where: Where, more = false, quiet = false, part: Part = 'devices'): Promise<void> {
    const view = views[where];
    if (view.busy) return;
    const scopeId = appScope?.scopeId;
    const query: HomeDevicesQuery | null = where === 'app' ? (scopeId ? { kind: 'scope', scopeId } : null) : more && view.nextCursor ? { kind: 'cursor', cursor: view.nextCursor } : { kind: 'first' };
    if (!query) return;
    view.busy = more ? 'more' : 'load';
    view.problem = null;
    view.problemAt = part;
    view.quietFailed = false;
    if (!more && view.state === 'closed') view.state = 'loading';
    confirm = null;
    render(where);
    const at = epoch;
    const page = await send(view, (id) => deps.api.devices(id, query));
    if (at !== epoch || (where === 'app' && appScope?.scopeId !== scopeId)) return;
    view.busy = null;
    if (page) {
      view.scopes = more ? [...view.scopes, ...page.scopes.filter((s) => !view.scopes.some((x) => x.scopeId === s.scopeId))] : page.scopes;
      view.nextCursor = where === 'front' ? page.nextCursor : null;
      view.state = 'ready';
      if (!more) {
        view.notes.clear();
        view.emailNote = null;
        view.readAtMs = now();
      }
    } else {
      if (view.state === 'loading') view.state = 'closed';
      // D897: the tab's own read failed: a quiet note, not an alert nobody asked for (the alert comes with a press).
      if (quiet) {
        view.problem = null;
        view.quietFailed = true;
      }
    }
    render(where);
    if (page && !more && !quiet) focusHeading(where === 'front' ? 'home-devices-title' : part === 'email' ? 'home-app-email-title' : 'home-app-devices-title');
  }

  /** Applies a stop to whatever either view shows of it. */
  function applyStop(stop: HomeStop, scopeId: string): void {
    for (const view of Object.values(views)) {
      view.scopes = view.scopes.map((s) => {
        if (s.scopeId !== scopeId) return s;
        if (stop.kind === 'share') return { ...s, devices: s.devices.filter((x) => x.shareId !== stop.shareId) };
        if (stop.kind === 'consent')
          return { ...s, devices: s.devices.map((x) => (x.consent?.consentId === stop.consentId ? { ...x, consent: null } : x)), consents: s.consents.filter((c) => c.consentId !== stop.consentId) };
        return { ...s, email: s.email === null ? null : s.email.filter((e) => e.appId !== stop.appId) };
      });
    }
  }

  async function runStop(where: Where, stop: HomeStop, scopeId: string): Promise<void> {
    const key = stopKey(stop, scopeId);
    if (stopping || confirm?.key !== key) return;
    const view = views[where];
    // D901: on a wallet's page an email stop is made, and answered, in the email part of its own card.
    const inEmail = where === 'app' && stop.kind === 'email';
    stopping = key;
    view.problem = null;
    view.problemAt = inEmail ? 'email' : 'devices';
    // The last stop's sentence goes: what is said next is this stop's outcome alone.
    view.notes.delete(scopeId);
    view.emailNote = null;
    render(where);
    const at = epoch;
    const result: HomeStopResult | null = await send(view, (id) => deps.api.stop(id, stop));
    if (at !== epoch) return;
    stopping = null;
    confirm = null;
    if (result) {
      applyStop(stop, scopeId);
      const done = stopDoneText(stop.kind, typeof result.revoked === 'number' ? result.revoked > 0 : result.revoked);
      if (inEmail) view.emailNote = done;
      else view.notes.set(scopeId, done);
    }
    render('front');
    render('app');
    focus(inEmail ? (result ? 'home-app-email-note' : 'home-app-email-problem') : result ? `home-devices-note-${where}-${scopeId}` : `home-devices-problem-${where}`);
  }

  function ask(where: Where, key: string, focusId: string): void {
    if (stopping) return;
    confirm = { where, key };
    views[where].problem = null;
    render(where);
    focus(focusId);
  }

  function cancel(where: Where): void {
    if (stopping) return;
    confirm = null;
    render(where);
  }

  // ---- what it shows ----

  /** The confirmation for one stop, in place of the button that asked for it. */
  function confirmPanel(where: Where, stop: HomeStop, scopeId: string, id: string): HTMLElement {
    const words = HOME_STOP_CONFIRM[stop.kind];
    const busy = stopping === stopKey(stop, scopeId);
    return d.h(
      'div',
      { class: 'home-confirm', attrs: { role: 'group', 'aria-labelledby': `${id}-title`, id } },
      icon(d, 'warn', 'home-confirm-ic'),
      d.h('p', { class: 'home-confirm-title', attrs: { id: `${id}-title`, tabindex: '-1' } }, words.title),
      d.h('ul', {}, ...words.points.map((p) => d.h('li', {}, p))),
      // The full detail, one native disclosure (keyboard and screen reader friendly), closed by default.
      words.more ? d.h('details', { class: 'home-confirm-more', attrs: { id: `${id}-more` } }, d.h('summary', {}, 'More'), d.h('ul', {}, ...words.more.map((p) => d.h('li', {}, p)))) : null,
      d.h(
        'div',
        { class: 'actions start' },
        button(busy ? words.going : words.go, `${id}-go`, () => deps.track(runStop(where, stop, scopeId)), { cls: 'stop', kind: 'danger', sm: true, disabled: stopping !== null }),
        button('Cancel', `${id}-cancel`, () => cancel(where), { sm: true, disabled: stopping !== null }),
      ),
    );
  }

  const confirming = (where: Where, stop: HomeStop, scopeId: string): boolean => confirm?.where === where && confirm.key === stopKey(stop, scopeId);

  /** The stop's button, for the right of its row; none while its confirmation is open (below the row, `stopPanel`). */
  function stopButton(where: Where, stop: HomeStop, scopeId: string, label: string, idBase: string, describedBy: string): HTMLElement | null {
    if (confirming(where, stop, scopeId)) return null;
    return button(label, idBase, () => ask(where, stopKey(stop, scopeId), `${idBase}-confirm-title`), { describedBy, sm: true, disabled: stopping !== null });
  }

  /** The stop's confirmation, when the user asked for it: what it does and doesn't, then the stop itself (danger). */
  function stopPanel(where: Where, stop: HomeStop, scopeId: string, idBase: string): HTMLElement | null {
    return confirming(where, stop, scopeId) ? confirmPanel(where, stop, scopeId, `${idBase}-confirm`) : null;
  }

  const nameOf = (s: HomeDeviceScope, appId: string): string => s.apps.find((a) => a.appId === appId)?.name ?? deps.appName?.(appId) ?? 'An app Journear no longer lists';

  function consentLines(c: HomeConsent): Child[] {
    return [
      d.h('p', { class: 'home-consent-state' }, badge('Auto-approve on', 'ok'), ' until ', at(c.expiresAtMs)),
      // The app's own words, in quotes and labelled as the app's: never Journear's description. On their own line, so
      // they read at a phone's width (D897).
      d.h('p', { class: 'home-policy' }, 'In the app’s words, it may sign without asking:', d.h('q', { class: 'home-policy-label' }, c.label)),
    ];
  }

  /** The auto-approve row of a device or a tab: its state and the app's words, "Stop auto-approving" on the right. */
  function consentRow(where: Where, s: HomeDeviceScope, c: HomeConsent, nameId: string): HTMLElement[] {
    const stop: HomeStop = { kind: 'consent', consentId: c.consentId };
    const idBase = `home-stop-consent-${where}-${c.consentId}`;
    const row = settingRow('home-device-consent', consentLines(c), s.canStop ? stopButton(where, stop, s.scopeId, 'Stop auto-approving', idBase, nameId) : null);
    const panel = s.canStop ? stopPanel(where, stop, s.scopeId, idBase) : null;
    return panel ? [row, panel] : [row];
  }

  function deviceItem(where: Where, s: HomeDeviceScope, x: HomeDevice, showApp: boolean): HTMLElement {
    const nameId = `home-device-${where}-${x.shareId}`;
    // D897: one plain line each, a short date with the full one for a tooltip and a screen reader.
    // Once the idle moment has passed, the sentence says what may have happened (Journear can't tell whether it was used).
    const idlePassed = x.idleUntilMs <= now();
    const ends: Child[] =
      x.idleUntilMs >= x.expiresAtMs
        ? ['Signs out by itself ', at(x.expiresAtMs), '.']
        : idlePassed
          ? ['If it wasn’t used, it signed out by itself ', at(x.idleUntilMs), '; if it was, it signs out ', at(x.expiresAtMs), ' at the latest.']
          : ['Signs out by itself ', at(x.idleUntilMs), ' if it isn’t used, and ', at(x.expiresAtMs), ' at the latest.'];
    const share: HomeStop = { kind: 'share', shareId: x.shareId };
    const shareId = `home-stop-share-${where}-${x.shareId}`;
    // A card of setting rows: the device (where, when, "Sign out this device"), then its auto-approve.
    return d.h(
      'li',
      { class: 'home-device jp-card', attrs: { 'data-share': x.shareId } },
      settingRow(
        'home-device-row',
        [
          // The device, then where (the site on its own line, broken only where it must be: D897).
          d.h('p', { class: 'home-device-name', attrs: { id: nameId } }, d.h('strong', {}, x.label ?? UNNAMED_DEVICE), d.h('span', { class: 'sr-only' }, ' on '), originText(d, x.partnerOrigin)),
          showApp ? d.h('p', { class: 'muted' }, 'App: ', d.h('span', { class: 'home-device-app' }, nameOf(s, x.appId))) : null,
          d.h(
            'div',
            { class: 'home-device-facts' },
            d.h('p', {}, 'Signed in ', at(x.signedInAtMs), '.'),
            x.lastUsedAtMs !== null ? d.h('p', {}, 'Last opened or approved here ', at(x.lastUsedAtMs), '.') : null,
            d.h('p', {}, ...ends),
          ),
        ],
        s.canStop ? stopButton(where, share, s.scopeId, 'Sign out this device', shareId, nameId) : null,
      ),
      s.canStop ? stopPanel(where, share, s.scopeId, shareId) : null,
      ...(x.consent ? consentRow(where, s, x.consent, nameId) : [settingRow('home-device-consent-off', [d.h('p', { class: 'muted' }, 'Auto-approve is off: this device asks you to approve every request.')], null)]),
    );
  }

  /** A consent of an app that keeps no sign-in on the device: it lives as long as that tab, which may have closed already. */
  function tabConsentItem(where: Where, s: HomeDeviceScope, c: HomeTabConsent, showApp: boolean): HTMLElement {
    const nameId = `home-tab-consent-${where}-${c.consentId}`;
    return d.h(
      'li',
      { class: 'home-device jp-card', attrs: { 'data-consent': c.consentId } },
      settingRow(
        'home-device-row',
        [
          d.h('p', { class: 'home-device-name', attrs: { id: nameId } }, d.h('strong', {}, 'A tab (may be closed)'), d.h('span', { class: 'sr-only' }, ' on '), originText(d, c.partnerOrigin)),
          showApp ? d.h('p', { class: 'muted' }, 'App: ', d.h('span', { class: 'home-device-app' }, nameOf(s, c.appId))) : null,
          d.h('p', { class: 'muted' }, 'This app keeps no sign-in on the device: the tab is signed out when it closes, and Journear can’t tell whether it still is open.'),
        ],
        null,
      ),
      ...consentRow(where, s, c, nameId),
    );
  }

  /**
   * The apps the email is shared with, each a card with "Stop sharing email". Unknown or none: nothing here (the front
   * page says it once for all, in `body`; on a wallet's page the email part's line says it, D901).
   */
  function emailBlock(where: Where, s: HomeDeviceScope, showApp: boolean): Child[] {
    if (s.email === null || s.email.length === 0) return [];
    return s.email.map((e) => {
      const lineId = `home-email-${where}-${s.scopeId}-${e.appId}`;
      const stop: HomeStop = { kind: 'email', appId: e.appId };
      const idBase = `home-stop-email-${where}-${s.scopeId}-${e.appId}`;
      return d.h(
        'div',
        { class: 'home-email jp-card', attrs: { 'data-app': e.appId } },
        settingRow(
          'home-email-row',
          [
            d.h(
              'p',
              { attrs: { id: lineId } },
              'Your email is shared with ',
              showApp ? d.h('strong', {}, nameOf(s, e.appId)) : 'this app',
              ': ',
              ...e.addresses.flatMap((a, i) => [i > 0 ? ', ' : null, d.h('span', { class: 'mono' }, a)]),
            ),
          ],
          s.canStop ? stopButton(where, stop, s.scopeId, 'Stop sharing email', idBase, lineId) : null,
        ),
        s.canStop ? stopPanel(where, stop, s.scopeId, idBase) : null,
      );
    });
  }

  const isEmpty = (s: HomeDeviceScope): boolean => s.devices.length === 0 && s.consents.length === 0 && (s.email?.length ?? 0) === 0;

  function scopeGroup(where: Where, read: HomeDeviceScope): HTMLElement {
    // D897: only what is still true now (an ended auto-approve is off, an ended sign-in gone); nothing is read for it.
    const s = stillTrue(read, now());
    const showApp = where === 'front' || s.apps.length > 1;
    const note = views[where].notes.get(s.scopeId);
    const items = [...s.devices.map((x) => deviceItem(where, s, x, showApp)), ...s.consents.map((c) => tabConsentItem(where, s, c, showApp))];
    return d.h(
      'div',
      { class: 'home-devices-group', attrs: { 'data-scope': s.scopeId } },
      // Which app: the partner's names, in the neutral box, never a heading.
      where === 'front' ? d.h('div', { class: 'home-devices-apps' }, d.h('p', {}, 'In ', ...s.apps.flatMap((a, i) => [i > 0 ? ' · ' : null, d.h('strong', {}, a.name)]))) : null,
      // A stop's outcome stays beside the app it changed (it says when the change reaches the device), not in a toast.
      d.h('p', { class: note ? 'home-devices-note jp-alert jp-alert-success' : 'home-devices-note', attrs: { role: 'status', id: `home-devices-note-${where}-${s.scopeId}`, tabindex: '-1' } }, ...(note ? [icon(d, 'check-c'), d.h('span', { class: 'body' }, note)] : [])),
      s.canStop
        ? null
        : alert(
            d,
            'warning',
            { class: 'note', attrs: { id: `home-devices-unconfirmed-${where}-${s.scopeId}` } },
            'Passport Home couldn’t confirm that this sign-in is still part of your account, so it offers no stop and shows no email sharing here for now. Show your devices again in a moment.',
          ),
      items.length > 0
        ? d.h('ul', { class: 'home-device-list' }, ...items)
        : where === 'app'
          ? empty('home-app-devices-empty', 'Nothing signed in', appScope?.mine === false ? 'No device is signed in to this app with Journear right now.' : 'No device is signed in to this wallet right now.')
          : null,
      s.more ? d.h('p', { class: 'muted' }, `Passport Home shows the ${HOME_DEVICES_MAX} most recent here; others are signed in too. Sign out the ones you don’t use, then show your devices again.`) : null,
      s.devices.some((x) => x.lastUsedAtMs !== null) ? d.h('p', { class: 'muted home-last-used-note' }, '“Last opened or approved here” doesn’t count requests the app signed by itself.') : null,
      // D901: on a wallet's page the email sharing is in its own card ("What these apps get from you", `emailBody`).
      ...(where === 'front' ? emailBlock(where, s, showApp) : []),
    );
  }

  const problemView = (where: Where, p: HomeProblem, id = `home-devices-problem-${where}`): HTMLElement =>
    alert(
      d,
      'danger',
      { tag: 'div', class: 'home-problem', attrs: { role: 'alert', id, tabindex: '-1' } },
      d.h('p', {}, p.text),
      d.h('p', { class: 'code muted' }, supportCode(p.code)),
      p.requestId ? d.h('p', { class: 'code muted' }, supportRequest(p.requestId)) : null,
    );

  function body(where: Where): Child[] {
    const view = views[where];
    const ids = where === 'front' ? { show: 'home-devices-show', again: 'home-devices-refresh' } : { show: 'home-app-devices-show', again: 'home-app-devices-refresh' };
    // D901: a refusal of what the person asked in the email part shows there, not here.
    const out: Child[] = [view.problem && (where === 'front' || view.problemAt === 'devices') ? problemView(where, view.problem) : null];
    if (view.state === 'closed' && view.quietFailed) out.push(d.h('p', { class: 'muted', attrs: { id: `home-devices-quiet-${where}` } }, 'Passport Home couldn’t check this just now. “Show devices” tries again.'));
    if (view.state === 'closed') {
      out.push(
        d.h(
          'div',
          { class: 'actions start' },
          button(
            view.busy ? 'Loading…' : 'Show devices',
            ids.show,
            () => {
              view.expanded = true;
              deps.track(load(where));
            },
            { disabled: view.busy !== null },
          ),
        ),
      );
      return out;
    }
    if (view.state === 'loading') {
      out.push(d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Loading your devices…'));
      return out;
    }
    // D897: on a wallet's page, read when the Security tab opened, the details wait for "Show devices" (no second read).
    if (!view.expanded) {
      out.push(
        d.h(
          'div',
          { class: 'actions start' },
          button('Show devices', ids.show, () => {
            view.expanded = true;
            // D897: the tab's read is shown while it is fresh; older than a minute, the press reads again.
            if (view.readAtMs === null || now() - view.readAtMs > DEVICES_FRESH_MS) {
              deps.track(load(where));
              return;
            }
            render(where);
            focus(where === 'front' ? 'home-devices-title' : 'home-app-devices-title');
          }),
        ),
      );
      return out;
    }
    // D897: "Show again" beside what it refreshes, at the top, as small as the cards' own buttons.
    out.push(d.h('div', { class: 'actions start home-devices-again' }, button(view.busy === 'load' ? 'Loading…' : 'Show again', ids.again, () => deps.track(load(where)), { disabled: view.busy !== null || stopping !== null, sm: true })));
    // On the front page an app with nothing left is left out, unless a stop just emptied it (its sentence stays).
    const shown = where === 'front' ? view.scopes.filter((s) => !isEmpty(s) || view.notes.has(s.scopeId)) : view.scopes;
    if (where === 'front' && shown.length === 0) {
      out.push(empty('home-devices-empty', 'Nothing signed in', 'No device is signed in to your apps with Journear right now, and you aren’t sharing your email with any of them.'));
    } else {
      out.push(...shown.map((s) => scopeGroup(where, s)));
    }
    if (where === 'front' && view.scopes.some((s) => s.email === null)) out.push(d.h('p', { class: 'muted', attrs: { id: 'home-email-unknown-front' } }, 'Passport Home can’t tell right now which apps you share your email with.'));
    if (where === 'front') out.push(d.h('p', { class: 'muted' }, 'Only apps Journear has on record for you are listed here. For any other app, find it on “Your wallets”, under “Other apps”, and open it.'));
    if (where === 'front' && view.nextCursor) out.push(d.h('div', { class: 'actions start' }, button(view.busy === 'more' ? 'Loading…' : 'Show more', 'home-devices-more', () => deps.track(load(where, true)), { disabled: view.busy !== null })));
    return out;
  }

  /**
   * D901: the email part of a wallet's "What these apps get from you" card, from the same read as the devices: its line
   * (what the read says about the email, or what the part is about), then "Show email sharing" until pressed, then the
   * apps the email is shared with, each with "Stop sharing email" and its confirmation, and "Show again".
   */
  function emailBody(): Child[] {
    const view = views.app;
    const out: Child[] = [view.problem && view.problemAt === 'email' ? problemView('app', view.problem, 'home-app-email-problem') : null];
    const show = (): void => {
      view.emailExpanded = true;
      // Asking about the email isn't asking for the devices' cards: they keep waiting for "Show devices".
      if (view.state === 'closed') view.expanded = false;
      // The same rule as "Show devices" (D897): the tab's read while it is at most a minute old, else a new read.
      if (view.state !== 'ready' || view.readAtMs === null || now() - view.readAtMs > DEVICES_FRESH_MS) {
        deps.track(load('app', false, false, 'email'));
        return;
      }
      render('app');
      focus('home-app-email-title');
    };
    if (view.state !== 'ready') {
      if (view.state === 'closed' && view.quietFailed) out.push(d.h('p', { class: 'muted', attrs: { id: 'home-email-quiet' } }, `Passport Home couldn’t check this just now. “${HOME_EMAIL_SHOW}” tries again.`));
      out.push(d.h('div', { class: 'actions start' }, button(view.busy ? 'Loading…' : HOME_EMAIL_SHOW, 'home-app-email-show', show, { disabled: view.busy !== null })));
      return out;
    }
    if (!view.emailExpanded) {
      out.push(d.h('div', { class: 'actions start' }, button(HOME_EMAIL_SHOW, 'home-app-email-show', show, { disabled: view.busy !== null })));
      return out;
    }
    out.push(d.h('div', { class: 'actions start home-devices-again' }, button(view.busy === 'load' ? 'Loading…' : 'Show again', 'home-app-email-refresh', () => deps.track(load('app', false, false, 'email')), { disabled: view.busy !== null || stopping !== null, sm: true })));
    const s = view.scopes[0];
    // A stop's outcome stays here, beside what it changed (D765), not in a toast.
    out.push(d.h('p', { class: view.emailNote ? 'home-devices-note jp-alert jp-alert-success' : 'home-devices-note', attrs: { role: 'status', id: 'home-app-email-note', tabindex: '-1' } }, ...(view.emailNote ? [icon(d, 'check-c'), d.h('span', { class: 'body' }, view.emailNote)] : [])));
    if (s) out.push(...emailBlock('app', s, s.apps.length > 1));
    return out;
  }

  function render(where: Where): void {
    const root = where === 'front' ? frontRoot : appRoot;
    const intro =
      where === 'front'
        ? 'Where you’re signed in to your apps with Journear, which of those devices may sign for you without asking, and the apps you share your email with.'
        : appScope?.mine === false
          ? HOME_DEVICES_APP_INTRO
          : HOME_DEVICES_WALLET_INTRO;
    // The view's own heading for every wallet (D893: the page's `h1` names the view); a section of a wallet's page.
    const heading = where === 'front' ? d.h('h1', { attrs: { id: 'home-devices-title', tabindex: '-1' } }, HOME_DEVICES_TITLE) : d.h('h2', { attrs: { id: 'home-app-devices-title', tabindex: '-1' } }, HOME_DEVICES_TITLE);
    // D897: on a wallet's page, once read, the one line says where the wallet is signed in (in place of the intro).
    const scope = where === 'app' && views.app.state === 'ready' ? views.app.scopes[0] : undefined;
    const mine = appScope?.mine !== false;
    const line = scope ? devicesSummary(stillTrue(scope, now()), mine) : intro;
    root.replaceChildren();
    schedule();
    const put = (to: HTMLElement, children: Child[]): void => {
      for (const c of children) if (c !== null && c !== undefined && c !== false) to.append(typeof c === 'string' ? deps.win.document.createTextNode(c) : c);
    };
    put(root, [heading, d.h('p', { class: 'home-set-summary', attrs: { id: where === 'front' ? 'home-devices-about' : 'home-app-devices-summary', ...(scope ? { 'data-read': '' } : {}) } }, line), ...body(where)]);
    if (where !== 'app') return;
    // D901: the email part, drawn with the devices it is read with. Its line says what the read says about the email.
    const emailLine = scope ? emailSummary(scope, mine, (appId) => nameOf(scope, appId)) : emailAbout(appScope?.apps.length ?? 1, mine);
    emailRoot.replaceChildren();
    put(emailRoot, [d.h('h3', { attrs: { id: 'home-app-email-title', tabindex: '-1' } }, HOME_EMAIL_TITLE), d.h('p', { class: 'home-set-summary', attrs: { id: 'home-app-email-summary', ...(scope ? { 'data-read': '' } : {}) } }, emailLine), ...emailBody()]);
  }

  // ---- D897: what is on screen stays true: drawn again (no request) when the page is seen again, at midnight, and when
  // a date on it passes ----
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  });
  let cancelTimer: (() => void) | null = null;

  /** Draws both views again from what they hold, keeping the focus on the same control when it is still there. */
  function refresh(): void {
    for (const where of ['front', 'app'] as const) {
      const view = views[where];
      if (view.state !== 'ready' || view.busy !== null || stopping !== null) continue;
      const roots = where === 'front' ? [frontRoot] : [appRoot, emailRoot];
      const inside = (el: Element | null): boolean => el !== null && roots.some((r) => r.contains(el));
      const had = deps.win.document.activeElement;
      const keep = had && inside(had) && had.id ? had.id : null;
      render(where);
      if (keep && !inside(deps.win.document.activeElement)) focus(keep);
    }
    schedule();
  }

  function schedule(): void {
    cancelTimer?.();
    cancelTimer = null;
    const t = now();
    const shown = [...(views.front.state === 'ready' ? views.front.scopes : []), ...(views.app.state === 'ready' ? views.app.scopes : [])];
    if (shown.length === 0) return;
    const change = nextChange(shown, t);
    const next = Math.min(nextMidnight(t), change ?? Number.POSITIVE_INFINITY);
    // A little after the moment, so the date has passed; long waits are re-checked within a day (timers drift).
    cancelTimer = setTimer(refresh, Math.min(Math.max(next - t + 500, 500), 86_400_000));
  }

  deps.win.document.addEventListener('visibilitychange', () => {
    if (deps.win.document.visibilityState === 'visible') refresh();
  });

  /** A wallet's page's scope: another one starts both parts closed again; the same one keeps what they show. */
  function useScope(scope: HomeScope): void {
    if (appScope?.scopeId !== scope.scopeId) {
      appScope = scope;
      views.app = newView();
      if (confirm?.where === 'app') confirm = null;
      render('app');
    } else appScope = scope;
  }

  render('front');
  render('app');

  return {
    get front() {
      return views.front.state;
    },
    get app() {
      return views.app.state;
    },
    get confirming() {
      return confirm?.key ?? null;
    },
    get errorCode() {
      return views.front.problem?.code ?? views.app.problem?.code ?? null;
    },
    get requests() {
      return requests;
    },
    frontView() {
      return frontRoot;
    },
    openFront() {
      // Opening the view is the user asking to see their devices: one read, unless it is shown already or on its way.
      // Without a usable sign-in nothing is sent: the view shows "Show devices", whose press says to sign in again.
      if (views.front.state !== 'closed' || views.front.busy !== null || !deps.session()) return;
      deps.track(load('front'));
    },
    leaveFront() {
      if (confirm?.where !== 'front' || stopping !== null) return;
      confirm = null;
      render('front');
    },
    get appExpanded() {
      return views.app.expanded;
    },
    openApp() {
      if (!appScope || views.app.state !== 'closed' || views.app.busy !== null || !deps.session()) return;
      views.app.expanded = false;
      deps.track(load('app', false, true));
    },
    appView(scope) {
      useScope(scope);
      return appRoot;
    },
    emailView(scope) {
      useScope(scope);
      return emailRoot;
    },
    get emailExpanded() {
      return views.app.emailExpanded;
    },
    leaveApp() {
      appScope = null;
      views.app = newView();
      if (confirm?.where === 'app') confirm = null;
      if (stopping === null) render('app');
    },
    reset() {
      epoch += 1;
      views.front = newView();
      views.app = newView();
      appScope = null;
      confirm = null;
      stopping = null;
      render('front');
      render('app');
    },
  };
}
