// Hana Home's "Devices and auto-approve" (home-page.ts mounts it on the front page and on each app's page): where the
// user is signed in to their apps with Hana, which of those devices may sign without asking, and the apps they share
// their email with, each with a way to stop it (docs/hana-home-spec.md F5, D45, D98 item 9, D411 point 6).
//
// It reads `GET /v1/home/devices` only when the user asks ("Show devices"), or once after sign-in when the page was opened
// at `/home?view=devices` (the address Hana's own "Manage in Hana Home" links will use; nothing links to it yet). A stop
// asks first, on the page itself, saying what stopping does and doesn't do, and is sent once, on a real click:
//   - "Stop auto-approving": that device's consent; auto-signing stops there within about 10 seconds (D465);
//   - "Sign out this device": its share, and its consent with it;
//   - "Stop sharing email": every address the account shares with that app.
// The answer is never re-sent by the page, and a refusal reads as one of Hana's sentences (home-problems.ts).
//
// SECURITY: app names, origins and the policy's label are the partner's words: they reach the page as text nodes only,
// never as a heading, a link or markup. The device label is the vault's coarse "Chrome on macOS", also text. Ids are held
// in memory only, for the stop the user clicks. Nothing here is written to storage, a URL or a log.
import type { Child, Dom } from './dom.ts';
import { type HomeConsent, type HomeDevice, type HomeDeviceScope, type HomeDevicesApi, type HomeDevicesQuery, type HomeIdentity, type HomeScope, type HomeStop, type HomeStopResult, type HomeTabConsent, HOME_DEVICES_MAX } from './home-api.ts';
import { type HomeProblem, homeProblem, plainProblem } from './home-problems.ts';
import type { GestureCheck, PageWindow } from './page-window.ts';

export const HOME_DEVICES_TITLE = 'Devices and auto-approve';
/** The one query `/home` takes for this section (exactly it): open it after sign-in. */
export const HOME_DEVICES_VIEW = 'devices';

/** Whether the page's address asks for the devices section: exactly `?view=devices`. */
export function devicesLinked(search: string): boolean {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  return keys.length === 1 && keys[0] === 'view' && q.getAll('view').length === 1 && q.get('view') === HOME_DEVICES_VIEW;
}

/** What each stop says before it is sent: what it does, and what it doesn't. */
export const HOME_STOP_CONFIRM = Object.freeze({
  share: {
    title: 'Sign out this device?',
    points: [
      'Automatic signing stops on that device within about 10 seconds.',
      'The next time the app is opened or reloaded there, it asks to sign in again.',
      'Whoever has that device can still approve and sign in a tab of the app that is already open there: for up to about a minute in an app that can sign some requests by itself, for up to about 10 minutes in other apps.',
      'Signatures and transactions already made stay valid. Signing out doesn’t move your funds: if someone else may have your wallet’s key, move your funds to a new wallet.',
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
      'Sign-in tokens the app already received keep it for up to an hour.',
      'A copy the app already stored is the app’s own: Hana can’t delete it. Ask the app if you want it deleted.',
    ],
    go: 'Stop sharing',
    going: 'Stopping…',
  },
});

/** What the page says once a stop is done (`changed`: false when it had already ended). */
export function stopDoneText(kind: HomeStop['kind'], changed: boolean): string {
  if (kind === 'share') return changed ? 'Signed out. Automatic signing stops there within about 10 seconds, a tab already open there ends within about a minute (up to about 10 minutes in an app that never signs by itself), and the app asks to sign in again the next time it opens there.' : 'That device was already signed out.';
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
  /** The front page's section. The same element each time. */
  frontView(): HTMLElement;
  /** The section of `scope`'s page. Another app's page starts it closed again; the same app keeps what it shows. */
  appView(scope: HomeScope): HTMLElement;
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
}

const newView = (): View => ({ state: 'closed', scopes: [], nextCursor: null, problem: null, busy: null, notes: new Map() });

const stopKey = (s: HomeStop, scopeId: string): string => (s.kind === 'consent' ? `consent:${s.consentId}` : s.kind === 'share' ? `share:${s.shareId}` : `email:${scopeId}:${s.appId}`);

function when(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function startHomeDevices(deps: HomeDevicesDeps): HomeDevices {
  const { d, isGesture } = deps;
  const linked = devicesLinked(deps.win.location.search);
  let epoch = 0;
  let requests = 0;
  let autoLoaded = false;
  const views: Record<Where, View> = { front: newView(), app: newView() };
  let appScope: HomeScope | null = null;
  let confirm: { where: Where; key: string } | null = null;
  let stopping: string | null = null;

  const frontRoot = d.h('section', { class: 'home-devices', attrs: { id: 'home-devices', 'aria-labelledby': 'home-devices-title' } });
  const appRoot = d.h('section', { class: 'home-devices home-devices-app', attrs: { id: 'home-app-devices', 'aria-labelledby': 'home-app-devices-title' } });

  const button = (label: string, id: string, onClick: () => void, o: { cls?: string; disabled?: boolean; describedBy?: string } = {}): HTMLButtonElement => {
    const b = d.h('button', { ...(o.cls ? { class: o.cls } : {}), attrs: { type: 'button', id, ...(o.describedBy ? { 'aria-describedby': o.describedBy } : {}) } }, label);
    if (o.disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', (e) => {
      if (isGesture(e)) onClick();
    });
    return b;
  };
  const badge = (text: string, tone: 'ok' | 'plain'): HTMLElement => d.h('span', { class: `badge badge-${tone}` }, text);
  const focus = (id: string): void => {
    try {
      deps.win.document.getElementById(id)?.focus();
    } catch {
      // Focus is a convenience.
    }
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

  async function load(where: Where, more = false): Promise<void> {
    const view = views[where];
    if (view.busy) return;
    const scopeId = appScope?.scopeId;
    const query: HomeDevicesQuery | null = where === 'app' ? (scopeId ? { kind: 'scope', scopeId } : null) : more && view.nextCursor ? { kind: 'cursor', cursor: view.nextCursor } : { kind: 'first' };
    if (!query) return;
    view.busy = more ? 'more' : 'load';
    view.problem = null;
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
      if (!more) view.notes.clear();
    } else if (view.state === 'loading') view.state = 'closed';
    render(where);
    if (page && !more) focus(where === 'front' ? 'home-devices-title' : 'home-app-devices-title');
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
    stopping = key;
    view.problem = null;
    // The last stop's sentence goes: what is said next is this stop's outcome alone.
    view.notes.delete(scopeId);
    render(where);
    const at = epoch;
    const result: HomeStopResult | null = await send(view, (id) => deps.api.stop(id, stop));
    if (at !== epoch) return;
    stopping = null;
    confirm = null;
    if (result) {
      applyStop(stop, scopeId);
      view.notes.set(scopeId, stopDoneText(stop.kind, typeof result.revoked === 'number' ? result.revoked > 0 : result.revoked));
    }
    render('front');
    render('app');
    focus(result ? `home-devices-note-${where}-${scopeId}` : `home-devices-problem-${where}`);
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
      d.h('p', { class: 'home-confirm-title', attrs: { id: `${id}-title`, tabindex: '-1' } }, words.title),
      d.h('ul', {}, ...words.points.map((p) => d.h('li', {}, p))),
      d.h(
        'div',
        { class: 'actions start' },
        button(busy ? words.going : words.go, `${id}-go`, () => deps.track(runStop(where, stop, scopeId)), { cls: 'stop', disabled: stopping !== null }),
        button('Cancel', `${id}-cancel`, () => cancel(where), { disabled: stopping !== null }),
      ),
    );
  }

  /** The stop's button, or its confirmation when the user asked for it. */
  function stopControl(where: Where, stop: HomeStop, scopeId: string, label: string, idBase: string, describedBy: string): HTMLElement {
    const key = stopKey(stop, scopeId);
    const panelId = `${idBase}-confirm`;
    if (confirm?.where === where && confirm.key === key) return confirmPanel(where, stop, scopeId, panelId);
    return d.h('div', { class: 'actions start' }, button(label, idBase, () => ask(where, key, `${panelId}-title`), { describedBy, disabled: stopping !== null }));
  }

  const nameOf = (s: HomeDeviceScope, appId: string): string => s.apps.find((a) => a.appId === appId)?.name ?? deps.appName?.(appId) ?? 'An app Hana no longer lists';

  function consentLines(c: HomeConsent): Child[] {
    return [
      d.h('p', {}, badge('Auto-approve on', 'ok'), ` until ${when(c.expiresAtMs)}`),
      // The app's own words, in quotes and labelled as the app's: never Hana's description.
      d.h('p', { class: 'home-policy' }, 'The app describes what it may sign without asking as: ', d.h('q', { class: 'home-policy-label' }, c.label)),
    ];
  }

  function deviceItem(where: Where, s: HomeDeviceScope, x: HomeDevice, showApp: boolean): HTMLElement {
    const nameId = `home-device-${where}-${x.shareId}`;
    const ends = x.idleUntilMs < x.expiresAtMs ? `${when(x.idleUntilMs)} if it isn’t used before then, ${when(x.expiresAtMs)} at the latest` : when(x.expiresAtMs);
    return d.h(
      'li',
      { class: 'home-device', attrs: { 'data-share': x.shareId } },
      d.h('p', { class: 'home-device-name', attrs: { id: nameId } }, d.h('strong', {}, x.label ?? UNNAMED_DEVICE), ' on ', d.h('span', { class: 'origin' }, x.partnerOrigin)),
      showApp ? d.h('p', { class: 'muted' }, 'App: ', d.h('span', { class: 'home-device-app' }, nameOf(s, x.appId))) : null,
      d.h(
        'dl',
        { class: 'home-device-facts' },
        d.h('dt', {}, 'Signed in'),
        d.h('dd', {}, when(x.signedInAtMs)),
        x.lastUsedAtMs !== null ? d.h('dt', {}, 'Last opened or approved here') : null,
        x.lastUsedAtMs !== null ? d.h('dd', {}, when(x.lastUsedAtMs)) : null,
        d.h('dt', {}, 'Signs out by itself'),
        d.h('dd', {}, ends),
      ),
      x.consent
        ? d.h('div', { class: 'home-device-consent' }, ...consentLines(x.consent), s.canStop ? stopControl(where, { kind: 'consent', consentId: x.consent.consentId }, s.scopeId, 'Stop auto-approving', `home-stop-consent-${where}-${x.consent.consentId}`, nameId) : null)
        : d.h('p', { class: 'muted' }, 'Auto-approve is off: this device asks you to approve every request.'),
      s.canStop ? stopControl(where, { kind: 'share', shareId: x.shareId }, s.scopeId, 'Sign out this device', `home-stop-share-${where}-${x.shareId}`, nameId) : null,
    );
  }

  /** A consent of an app that keeps no sign-in on the device: it lives as long as that tab, which may have closed already. */
  function tabConsentItem(where: Where, s: HomeDeviceScope, c: HomeTabConsent, showApp: boolean): HTMLElement {
    const nameId = `home-tab-consent-${where}-${c.consentId}`;
    return d.h(
      'li',
      { class: 'home-device', attrs: { 'data-consent': c.consentId } },
      d.h('p', { class: 'home-device-name', attrs: { id: nameId } }, d.h('strong', {}, 'A tab (may be closed)'), ' on ', d.h('span', { class: 'origin' }, c.partnerOrigin)),
      showApp ? d.h('p', { class: 'muted' }, 'App: ', d.h('span', { class: 'home-device-app' }, nameOf(s, c.appId))) : null,
      d.h('p', { class: 'muted' }, 'This app keeps no sign-in on the device: the tab is signed out when it closes, and Hana can’t tell whether it still is open.'),
      d.h('div', { class: 'home-device-consent' }, ...consentLines(c), s.canStop ? stopControl(where, { kind: 'consent', consentId: c.consentId }, s.scopeId, 'Stop auto-approving', `home-stop-consent-${where}-${c.consentId}`, nameId) : null),
    );
  }

  function emailBlock(where: Where, s: HomeDeviceScope, showApp: boolean): Child[] {
    // Unknown here: the app's page says so; the front page says it once for all (body).
    if (s.email === null) return where === 'app' ? [d.h('p', { class: 'muted', attrs: { id: 'home-email-unknown-app' } }, 'Hana Home can’t tell right now whether you share your email with this app.')] : [];
    if (s.email.length === 0) return where === 'app' ? [d.h('p', { class: 'muted', attrs: { id: 'home-email-none' } }, 'You aren’t sharing your email address with this app.')] : [];
    return s.email.map((e) => {
      const lineId = `home-email-${where}-${s.scopeId}-${e.appId}`;
      return d.h(
        'div',
        { class: 'home-email', attrs: { 'data-app': e.appId } },
        d.h(
          'p',
          { attrs: { id: lineId } },
          'Your email is shared with ',
          showApp ? d.h('strong', {}, nameOf(s, e.appId)) : 'this app',
          ': ',
          ...e.addresses.flatMap((a, i) => [i > 0 ? ', ' : null, d.h('span', { class: 'mono' }, a)]),
        ),
        s.canStop ? stopControl(where, { kind: 'email', appId: e.appId }, s.scopeId, 'Stop sharing email', `home-stop-email-${where}-${s.scopeId}-${e.appId}`, lineId) : null,
      );
    });
  }

  const isEmpty = (s: HomeDeviceScope): boolean => s.devices.length === 0 && s.consents.length === 0 && (s.email?.length ?? 0) === 0;

  function scopeGroup(where: Where, s: HomeDeviceScope): HTMLElement {
    const showApp = where === 'front' || s.apps.length > 1;
    const note = views[where].notes.get(s.scopeId);
    const items = [...s.devices.map((x) => deviceItem(where, s, x, showApp)), ...s.consents.map((c) => tabConsentItem(where, s, c, showApp))];
    return d.h(
      'div',
      { class: 'home-devices-group', attrs: { 'data-scope': s.scopeId } },
      // Which app: the partner's names, in the neutral box, never a heading.
      where === 'front' ? d.h('div', { class: 'home-devices-apps' }, d.h('p', {}, 'In ', ...s.apps.flatMap((a, i) => [i > 0 ? ' · ' : null, d.h('strong', {}, a.name)]))) : null,
      d.h('p', { class: 'home-devices-note', attrs: { role: 'status', id: `home-devices-note-${where}-${s.scopeId}`, tabindex: '-1' } }, note ?? null),
      s.canStop
        ? null
        : d.h(
            'p',
            { class: 'note', attrs: { id: `home-devices-unconfirmed-${where}-${s.scopeId}` } },
            'Hana Home couldn’t check on NEAR that this sign-in is still part of this account, so it offers no stop and shows no email sharing here for now. Show your devices again in a moment.',
          ),
      items.length > 0
        ? d.h('ul', { class: 'home-device-list' }, ...items)
        : where === 'app'
          ? d.h('p', { class: 'muted', attrs: { id: 'home-app-devices-empty' } }, 'No device is signed in to this app with Hana right now.')
          : null,
      s.more ? d.h('p', { class: 'muted' }, `Hana Home shows the ${HOME_DEVICES_MAX} most recent here; others are signed in too. Sign out the ones you don’t use, then show your devices again.`) : null,
      s.devices.some((x) => x.lastUsedAtMs !== null) ? d.h('p', { class: 'muted home-last-used-note' }, '“Last opened or approved here” doesn’t count requests the app signed by itself.') : null,
      ...emailBlock(where, s, showApp),
    );
  }

  const problemView = (where: Where, p: HomeProblem): HTMLElement =>
    d.h(
      'div',
      { class: 'home-problem', attrs: { role: 'alert', id: `home-devices-problem-${where}`, tabindex: '-1' } },
      d.h('p', {}, p.text),
      d.h('p', { class: 'code muted' }, `Code: ${p.code}`),
      p.requestId ? d.h('p', { class: 'code muted' }, `Request: ${p.requestId}`) : null,
    );

  function body(where: Where): Child[] {
    const view = views[where];
    const ids = where === 'front' ? { show: 'home-devices-show', again: 'home-devices-refresh' } : { show: 'home-app-devices-show', again: 'home-app-devices-refresh' };
    const out: Child[] = [view.problem ? problemView(where, view.problem) : null];
    if (view.state === 'closed') {
      out.push(d.h('div', { class: 'actions start' }, button(view.busy ? 'Loading…' : 'Show devices', ids.show, () => deps.track(load(where)), { disabled: view.busy !== null })));
      return out;
    }
    if (view.state === 'loading') {
      out.push(d.h('p', { class: 'muted', attrs: { role: 'status' } }, 'Loading your devices…'));
      return out;
    }
    // On the front page an app with nothing left is left out, unless a stop just emptied it (its sentence stays).
    const shown = where === 'front' ? view.scopes.filter((s) => !isEmpty(s) || view.notes.has(s.scopeId)) : view.scopes;
    if (where === 'front' && shown.length === 0) {
      out.push(d.h('p', { class: 'muted', attrs: { id: 'home-devices-empty' } }, 'No device is signed in to your apps with Hana right now, and you aren’t sharing your email with any of them.'));
    } else {
      out.push(...shown.map((s) => scopeGroup(where, s)));
    }
    if (where === 'front' && view.scopes.some((s) => s.email === null)) out.push(d.h('p', { class: 'muted', attrs: { id: 'home-email-unknown-front' } }, 'Hana Home can’t tell right now which apps you share your email with.'));
    if (where === 'front') out.push(d.h('p', { class: 'muted' }, 'Only apps Hana has on record for you are listed here. For any other app, find it and open its page.'));
    out.push(
      d.h(
        'div',
        { class: 'actions start' },
        where === 'front' && view.nextCursor ? button(view.busy === 'more' ? 'Loading…' : 'Show more', 'home-devices-more', () => deps.track(load(where, true)), { disabled: view.busy !== null }) : null,
        button(view.busy === 'load' ? 'Loading…' : 'Show again', ids.again, () => deps.track(load(where)), { disabled: view.busy !== null || stopping !== null }),
      ),
    );
    return out;
  }

  function render(where: Where): void {
    const root = where === 'front' ? frontRoot : appRoot;
    const intro =
      where === 'front'
        ? 'Where you’re signed in to your apps with Hana, which of those devices may sign for you without asking, and the apps you share your email with.'
        : 'Where you’re signed in to this app with Hana, what those devices may sign without asking, and whether you share your email with it.';
    const heading = where === 'front' ? d.h('h2', { attrs: { id: 'home-devices-title', tabindex: '-1' } }, HOME_DEVICES_TITLE) : d.h('h3', { attrs: { id: 'home-app-devices-title', tabindex: '-1' } }, HOME_DEVICES_TITLE);
    root.replaceChildren();
    for (const c of [heading, d.h('p', {}, intro), ...body(where)]) if (c !== null && c !== undefined && c !== false) root.append(typeof c === 'string' ? deps.win.document.createTextNode(c) : c);
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
      // `/home?view=devices`: the user came to see their devices, so they load once, after the sign-in.
      if (linked && !autoLoaded && deps.session()) {
        autoLoaded = true;
        queueMicrotask(() => deps.track(load('front')));
      }
      return frontRoot;
    },
    appView(scope) {
      if (appScope?.scopeId !== scope.scopeId) {
        appScope = scope;
        views.app = newView();
        if (confirm?.where === 'app') confirm = null;
        render('app');
      } else appScope = scope;
      return appRoot;
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
      autoLoaded = false;
      render('front');
      render('app');
    },
  };
}
