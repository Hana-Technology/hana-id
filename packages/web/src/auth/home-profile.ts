// Passport Home's "Your name" (was Hana Home's) (home-page.ts mounts it on the front page and on each app's page, D714): the first and last
// name the user may set for their apps, both optional, and per app whether that app gets it. Nothing is shared until
// the user turns it on for an app, on that app's page.
//
// Like "Devices and auto-approve" (home-devices.ts, D677's shape), each view starts collapsed: a heading, one sentence and
// a button. Only that button reads:
//   - the front page: `GET /v1/home/profile` (the name, the apps it is shared with), then the form (First name, Last
//     name, Save, "Remove my name") and the list, each app with "Stop sharing";
//   - an app's page: `GET /v1/home/profile?appId=` for each app of the listing, then per app "Share my name with {App}"
//     or "Stop sharing my name" (`POST /v1/home/name-sharing`).
// Each part is checked with the API's own rule (`normalizeProfileName`) before anything is sent, and the normalized value
// is what is sent. Saving both parts empty, or "Remove my name", asks first, on the page, saying that it stops sharing
// with every app. Each write is sent once, on a real click; the page never sends one again, and a refusal reads as one of
// Hana's sentences (home-problems.ts).
//
// SECURITY: the user's name and the apps' names reach the page as text nodes only (a button's label included), never as
// markup, a heading or a link. The name is held in memory only, for this sign-in: nothing here writes it to storage, a
// URL or a log, and `reset()` (sign-out, another account) drops it and the typed drafts with every view.
import { PROFILE_NAME_MAX, normalizeProfileName } from '@hana-id/core/identity';
import type { Child, Dom } from './dom.ts';
import { type HomeIdentity, type HomeNameShare, type HomeProfileApi, type HomeProfileName, type HomeScope, HOME_MAX_APPS, HOME_NAME_SHARES_MAX } from './home-api.ts';
import { type HomeProblem, homeProblem, plainProblem } from './home-problems.ts';
import type { GestureCheck, PageWindow } from './page-window.ts';
import { BTN, alert, icon } from './ui.ts';

export const HOME_NAME_TITLE = 'Your name';

/** Everything the section says in Journear's own words (an app's name, where one goes, is passed in and set as text). */
export const HOME_NAME_TEXT = Object.freeze({
  frontAbout: 'Add a first and last name for your apps if you like: no app gets it until you turn on sharing for that app.',
  frontShow: 'Show my name',
  appAbout: 'Choose whether this app gets the name you set in Passport Home: it doesn’t unless you share it.',
  appShow: 'Show name sharing',
  loading: 'Loading your name…',
  given: 'First name',
  family: 'Last name',
  help: 'Nothing is shared until you turn it on for an app, on that app’s page.',
  /** Each field's own hint, under it (an error takes its place). */
  hint: `Up to ${PROFILE_NAME_MAX} characters.`,
  optional: 'optional',
  invalid: `Use up to ${PROFILE_NAME_MAX} characters on one line, with no hidden or control characters.`,
  empty: 'Type a first name, a last name or both, then save.',
  unchanged: 'Nothing to save: that is already your name.',
  save: 'Save',
  saving: 'Saving…',
  savedShared: 'Saved. The apps you share your name with get the new one with their next sign-in.',
  savedAlone: 'Saved. No app gets your name until you share it from that app’s page.',
  remove: 'Remove my name',
  removed: 'Your name is removed. No app gets it any more.',
  sharesTitle: 'Apps you share your name with',
  noShares: 'You aren’t sharing your name with any app.',
  more: `Passport Home lists the ${HOME_NAME_SHARES_MAX} apps you shared it with most recently; there are others. To stop sharing with one of those, open its page.`,
  howToShare: 'To share your name with an app, open the app’s page from “Your apps” and choose “Share my name”.',
  stop: 'Stop sharing',
  stopApp: 'Stop sharing my name',
  stopping: 'Stopping…',
  sharing: 'Sharing…',
  again: 'Show again',
  current: 'Your name in Passport Home: ',
  noName: 'You haven’t set a name in Passport Home. To share one, go back to all apps, open “Your name” and save it first.',
  shared: 'Shared',
  notShared: 'Not shared',
  cantShare: 'Passport Home can’t share your name with this app.',
  deleted: 'This app has been deleted, so Journear shares no name with it.',
});

/** What "Remove my name" (and saving both parts empty) says before it is sent. */
export const HOME_NAME_REMOVE_CONFIRM = Object.freeze({
  title: 'Remove your name?',
  points: Object.freeze([
    'Passport Home deletes your first and last name, and stops sharing your name with every app.',
    'The apps’ new sign-ins don’t include it. Sign-in tokens they already received keep it for up to an hour.',
    'A copy an app already stored is the app’s own: Journear can’t delete it. Ask the app if you want it deleted.',
  ]),
  go: 'Remove my name',
  going: 'Removing…',
});

/** A share's "Share my name with {App}" label. */
export const shareLabel = (app: string): string => `Share my name with ${app}`;

/** The name as one line: the parts that are set, first name first. */
export const fullName = (n: HomeProfileName): string => [n.givenName, n.familyName].filter((p): p is string => p !== null).join(' ');

/**
 * The two typed parts, checked with the API's rule: each normalized, or `bad` names the parts that fail. `empty`: neither
 * part is set once normalized (a removal).
 */
export function checkNameDraft(given: string, family: string): { ok: true; name: HomeProfileName; empty: boolean } | { ok: false; bad: ('given' | 'family')[] } {
  const g = normalizeProfileName(given);
  const f = normalizeProfileName(family);
  const bad: ('given' | 'family')[] = [];
  if (g === undefined) bad.push('given');
  if (f === undefined) bad.push('family');
  if (g === undefined || f === undefined) return { ok: false, bad };
  return { ok: true, name: { givenName: g, familyName: f }, empty: g === null && f === null };
}

export interface HomeProfileDeps {
  win: PageWindow;
  d: Dom;
  api: HomeProfileApi;
  isGesture: GestureCheck;
  /** Hana Home's usable sign-in, or null when there is none. */
  session: () => HomeIdentity | null;
  /** The API refused Hana Home's sign-in itself (a 401). */
  onSignedOut: () => void;
  track: (p: Promise<unknown>) => void;
  /** The server-corrected clock, for a share made on an app's page (its "since"). */
  now: () => number;
}

export type HomeProfileState = 'closed' | 'loading' | 'ready';

export interface HomeProfileSection {
  readonly front: HomeProfileState;
  readonly app: HomeProfileState;
  /** The removal's confirmation is on screen. */
  readonly confirming: boolean;
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
  /** Another account, or signed out: the name, the drafts and everything shown are dropped; both views close. */
  reset(): void;
}

type Where = 'front' | 'app';

/** A sentence after an action, with the app it names (set as text) where it names one. */
type Note = { text: string } | { app: string; before: string; after: string };

interface FrontView {
  state: HomeProfileState;
  problem: HomeProblem | null;
  shares: HomeNameShare[];
  more: boolean;
  given: string;
  family: string;
  /** The parts that failed the rule at the last Save. */
  bad: ('given' | 'family')[];
  formNote: string | null;
  note: Note | null;
}

interface AppEntry {
  appId: string;
  name: string;
  /** Null: Hana can't share a name with it (the API doesn't list it), or it is deleted. */
  shared: boolean | null;
  deleted: boolean;
}

interface AppView {
  state: HomeProfileState;
  problem: HomeProblem | null;
  apps: AppEntry[];
  notes: Map<string, Note>;
}

const newFront = (): FrontView => ({ state: 'closed', problem: null, shares: [], more: false, given: '', family: '', bad: [], formNote: null, note: null });
const newApp = (): AppView => ({ state: 'closed', problem: null, apps: [], notes: new Map() });

function when(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function startHomeProfile(deps: HomeProfileDeps): HomeProfileSection {
  const { d, isGesture } = deps;
  let epoch = 0;
  let requests = 0;
  /** The name as the API last answered it, once read in this sign-in; `known` false before any read. */
  let name: HomeProfileName | null = null;
  let known = false;
  let front = newFront();
  let app = newApp();
  let appScope: HomeScope | null = null;
  /** Raised whenever the app page changes, so an answer for another app's page is dropped. */
  let appTurn = 0;
  let confirmRemove = false;
  /** What is on its way (one at a time for the section): the button that sent it says so. */
  let busy: string | null = null;

  const frontRoot = d.h('section', { class: 'home-profile', attrs: { id: 'home-profile', 'aria-labelledby': 'home-profile-title' } });
  const appRoot = d.h('section', { class: 'home-profile home-profile-app', attrs: { id: 'home-app-profile', 'aria-labelledby': 'home-app-profile-title' } });

  /** A button: secondary unless `kind` says otherwise (one primary per view; danger only inside the confirmation). */
  const button = (label: string, id: string, onClick: () => void, o: { cls?: string; disabled?: boolean; describedBy?: string; type?: 'button' | 'submit'; kind?: keyof typeof BTN; sm?: boolean } = {}): HTMLButtonElement => {
    const cls = [o.cls, BTN[o.kind ?? 'secondary'], o.sm ? 'jp-btn-sm' : null].filter(Boolean).join(' ');
    const b = d.h('button', { class: cls, attrs: { type: o.type ?? 'button', id, ...(o.describedBy ? { 'aria-describedby': o.describedBy } : {}) } }, label);
    if (o.disabled) b.setAttribute('disabled', '');
    // A submit button acts through its form's submit, which checks the gesture itself.
    if (o.type !== 'submit')
      b.addEventListener('click', (e) => {
        if (isGesture(e)) onClick();
      });
    return b;
  };
  const badge = (text: string, tone: 'ok' | 'plain'): HTMLElement => d.h('span', { class: `badge badge-${tone} ${tone === 'ok' ? 'jp-badge jp-badge-success' : 'jp-badge'}` }, text);
  /** A setting row (the system's `.jp-setting`, as in home-devices.ts): the app and a line about it, its one control on the right. */
  const settingRow = (cls: string, attrs: Record<string, string>, text: Child[], control: Child, after: Child[] = []): HTMLElement =>
    d.h(
      'li',
      { class: `${cls} home-setting-item`, attrs },
      d.h('div', { class: 'jp-setting home-setting' }, d.h('span', { class: 'home-setting-text' }, ...text), control ? d.h('span', { class: 'home-setting-control' }, control) : null),
      ...after,
    );
  const nameText = (n: HomeProfileName): HTMLElement => d.h('strong', { class: 'home-name-value' }, fullName(n));
  /** An outcome, inline beside what it changed (it says when the change reaches the apps): the system's success alert. */
  const noteView = (n: Note | null | undefined, id: string): HTMLElement =>
    d.h(
      'p',
      { class: n ? 'home-devices-note jp-alert jp-alert-success' : 'home-devices-note', attrs: { role: 'status', id, tabindex: '-1' } },
      ...(n ? [icon(d, 'check-c'), d.h('span', { class: 'body' }, ...('text' in n ? [n.text] : [n.before, d.h('strong', {}, n.app), n.after]))] : []),
    );
  const focus = (id: string): void => {
    try {
      deps.win.document.getElementById(id)?.focus();
    } catch {
      // Focus is a convenience.
    }
  };

  // ---- requests: one at a time, never repeated by the page ----

  /** Runs one call with Passport Home's sign-in; null when not sent or failed (the problem is then on `where`'s view). */
  async function send<T>(where: Where, run: (id: HomeIdentity) => Promise<T>): Promise<T | null> {
    const view = where === 'front' ? front : app;
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

  /** The name changed (read, saved or removed): each view shows it. */
  function setName(next: HomeProfileName | null): void {
    name = next;
    known = true;
    if (next === null) {
      front.shares = [];
      front.more = false;
      app.apps = app.apps.map((a) => (a.shared === null ? a : { ...a, shared: false }));
    }
  }

  async function loadFront(): Promise<void> {
    if (busy) return;
    busy = 'load-front';
    front.problem = null;
    if (front.state === 'closed') front.state = 'loading';
    confirmRemove = false;
    render('front');
    const at = epoch;
    const out = await send('front', (id) => deps.api.profile(id));
    if (at !== epoch) return;
    busy = null;
    if (out) {
      setName(out.name);
      front.shares = out.shares;
      front.more = out.more;
      front.given = out.name?.givenName ?? '';
      front.family = out.name?.familyName ?? '';
      front.bad = [];
      front.formNote = null;
      front.note = null;
      front.state = 'ready';
    } else if (front.state === 'loading') front.state = 'closed';
    render('front');
    if (out) focus('home-profile-title');
  }

  async function loadApp(): Promise<void> {
    const scope = appScope;
    if (busy || !scope) return;
    busy = 'load-app';
    app.problem = null;
    if (app.state === 'closed') app.state = 'loading';
    render('app');
    const at = epoch;
    const turn = appTurn;
    const seen = new Set<string>();
    const rows = scope.apps.filter((a) => !seen.has(a.appId) && seen.add(a.appId)).slice(0, HOME_MAX_APPS);
    const read: AppEntry[] = [];
    let latest: HomeProfileName | null | undefined;
    // One read per app of the listing, one after another; the first that fails stops the rest.
    for (const a of rows) {
      if (a.status === 'deleted') {
        read.push({ appId: a.appId, name: a.name, shared: null, deleted: true });
        continue;
      }
      const out = await send('app', (id) => deps.api.profile(id, a.appId));
      if (at !== epoch || turn !== appTurn) return;
      if (!out) {
        busy = null;
        if (app.state === 'loading') app.state = 'closed';
        render('app');
        return;
      }
      latest = out.name;
      read.push({ appId: a.appId, name: a.name, shared: out.app ? out.app.shared : null, deleted: false });
    }
    busy = null;
    if (latest !== undefined) setName(latest);
    app.apps = read;
    app.notes.clear();
    app.state = 'ready';
    render('app');
    render('front');
    focus('home-app-profile-title');
  }

  async function save(): Promise<void> {
    if (busy) return;
    front.formNote = null;
    front.note = null;
    front.problem = null;
    const checked = checkNameDraft(front.given, front.family);
    if (!checked.ok) {
      front.bad = checked.bad;
      render('front');
      focus(checked.bad[0] === 'given' ? 'home-name-given' : 'home-name-family');
      return;
    }
    front.bad = [];
    if (checked.empty) {
      // Both empty: with a name set, that is a removal, which asks first; without one there is nothing to save.
      if (name === null) {
        front.formNote = HOME_NAME_TEXT.empty;
        render('front');
        focus('home-name-given');
        return;
      }
      askRemove();
      return;
    }
    if (name !== null && name.givenName === checked.name.givenName && name.familyName === checked.name.familyName) {
      front.given = name.givenName ?? '';
      front.family = name.familyName ?? '';
      front.formNote = HOME_NAME_TEXT.unchanged;
      render('front');
      return;
    }
    busy = 'save';
    render('front');
    const at = epoch;
    const out = await send('front', (id) => deps.api.saveName(id, checked.name));
    if (at !== epoch) return;
    busy = null;
    if (out) {
      setName(out.name);
      front.given = out.name?.givenName ?? '';
      front.family = out.name?.familyName ?? '';
      front.note = { text: out.name === null ? HOME_NAME_TEXT.removed : front.shares.length > 0 || front.more ? HOME_NAME_TEXT.savedShared : HOME_NAME_TEXT.savedAlone };
    }
    render('front');
    render('app');
    focus(out ? 'home-profile-note' : 'home-profile-problem-front');
  }

  function askRemove(): void {
    if (busy) return;
    confirmRemove = true;
    front.problem = null;
    front.note = null;
    front.formNote = null;
    render('front');
    focus('home-name-remove-confirm-title');
  }

  function cancelRemove(): void {
    if (busy) return;
    confirmRemove = false;
    render('front');
    focus(name !== null ? 'home-name-remove' : 'home-name-given');
  }

  async function remove(): Promise<void> {
    if (busy || !confirmRemove) return;
    busy = 'remove';
    front.problem = null;
    render('front');
    const at = epoch;
    const out = await send('front', (id) => deps.api.saveName(id, { givenName: null, familyName: null }));
    if (at !== epoch) return;
    busy = null;
    confirmRemove = false;
    if (out) {
      setName(null);
      front.given = '';
      front.family = '';
      front.note = { text: HOME_NAME_TEXT.removed };
    }
    render('front');
    render('app');
    focus(out ? 'home-profile-note' : 'home-profile-problem-front');
  }

  /** Starts or stops sharing with one app, from either view; both views show the outcome. */
  async function toggle(where: Where, appId: string, appName: string, share: boolean, scopeId: string | null): Promise<void> {
    if (busy) return;
    busy = `${share ? 'share' : 'stop'}:${appId}`;
    const view = where === 'front' ? front : app;
    view.problem = null;
    if (where === 'front') front.note = null;
    else app.notes.delete(appId);
    render(where);
    const at = epoch;
    const turn = appTurn;
    const out = await send(where, (id) => deps.api.shareName(id, appId, share));
    if (at !== epoch) return;
    busy = null;
    if (out) {
      const stoppedNote = (changed: boolean): Note =>
        changed
          ? { app: appName, before: 'Stopped sharing your name with ', after: '. Its new sign-ins don’t include it; sign-in tokens it already received keep it for up to an hour.' }
          : { app: appName, before: 'Your name was no longer shared with ', after: '.' };
      if (out.shared) {
        app.apps = app.apps.map((a) => (a.appId === appId ? { ...a, shared: true } : a));
        // The front page's list, if it is loaded, gains the app (newest first).
        if (front.state === 'ready' && scopeId !== null) front.shares = [{ appId, name: appName, scopeId, sharedAtMs: deps.now() }, ...front.shares.filter((s) => s.appId !== appId)];
        if (where === 'app' && turn === appTurn) app.notes.set(appId, { app: appName, before: 'Shared. ', after: ' gets your name with its next sign-in.' });
      } else {
        app.apps = app.apps.map((a) => (a.appId === appId && a.shared !== null ? { ...a, shared: false } : a));
        front.shares = front.shares.filter((s) => s.appId !== appId);
        const note = stoppedNote(out.stopped > 0);
        if (where === 'front') front.note = note;
        else if (turn === appTurn) app.notes.set(appId, note);
      }
    } else if (where === 'app' && app.problem?.code === 'no_profile_name') {
      // The name is gone (removed elsewhere): the page says to set one first, and offers no share.
      setName(null);
    }
    render('front');
    render('app');
    focus(out ? (where === 'front' ? 'home-profile-note' : `home-app-profile-note-${appId}`) : `home-profile-problem-${where}`);
  }

  // ---- what it shows ----

  const problemView = (where: Where, p: HomeProblem): HTMLElement =>
    alert(
      d,
      'danger',
      { tag: 'div', class: 'home-problem', attrs: { role: 'alert', id: `home-profile-problem-${where}`, tabindex: '-1' } },
      d.h('p', {}, p.text),
      d.h('p', { class: 'code muted' }, `Code: ${p.code}`),
      p.requestId ? d.h('p', { class: 'code muted' }, `Request: ${p.requestId}`) : null,
    );

  /**
   * One part of the name on the system's field (D765): the label above, marked optional (both parts are), the field, and
   * a hint under it that an error replaces on the same line. The part is checked with the API's rule when the field
   * loses focus, never while the user types (typing again clears the mark); Save checks both again.
   */
  function field(part: 'given' | 'family'): HTMLElement {
    const id = `home-name-${part}`;
    const input = d.h('input', {
      class: 'jp-input',
      attrs: {
        id,
        type: 'text',
        name: part === 'given' ? 'given-name' : 'family-name',
        autocomplete: part === 'given' ? 'given-name' : 'family-name',
        maxlength: String(PROFILE_NAME_MAX),
        spellcheck: 'false',
      },
    });
    input.value = part === 'given' ? front.given : front.family;
    const wrap = d.h(
      'div',
      { class: 'jp-field home-name-field' },
      d.h('label', { class: 'jp-label', attrs: { for: id } }, part === 'given' ? HOME_NAME_TEXT.given : HOME_NAME_TEXT.family, d.h('span', { class: 'opt' }, HOME_NAME_TEXT.optional)),
      input,
      d.h('p', { class: 'jp-hint', attrs: { id: `${id}-hint` } }, HOME_NAME_TEXT.hint),
    );
    /** Marks the part (in place: the section isn't drawn again, so a click on its way to a button still lands). */
    const mark = (invalid: boolean): void => {
      front.bad = invalid ? [...new Set([...front.bad, part])] : front.bad.filter((b) => b !== part);
      wrap.classList.toggle('is-invalid', invalid);
      wrap.querySelector(`#${id}-error`)?.remove();
      if (invalid) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', `${id}-error home-name-help`);
        wrap.append(d.h('p', { class: 'jp-error field-error', attrs: { id: `${id}-error` } }, icon(d, 'warn'), HOME_NAME_TEXT.invalid));
      } else {
        input.removeAttribute('aria-invalid');
        input.setAttribute('aria-describedby', `${id}-hint home-name-help`);
      }
    };
    mark(front.bad.includes(part));
    // Typing is kept as it goes (memory only), so drawing the section again never loses it.
    input.addEventListener('input', () => {
      if (part === 'given') front.given = input.value;
      else front.family = input.value;
      if (wrap.classList.contains('is-invalid')) mark(false);
    });
    input.addEventListener('blur', () => mark(normalizeProfileName(input.value) === undefined));
    return wrap;
  }

  function removeControl(): HTMLElement | null {
    if (confirmRemove) {
      const id = 'home-name-remove-confirm';
      const going = busy === 'remove';
      return d.h(
        'div',
        { class: 'home-confirm', attrs: { role: 'group', 'aria-labelledby': `${id}-title`, id } },
        icon(d, 'warn', 'home-confirm-ic'),
        d.h('p', { class: 'home-confirm-title', attrs: { id: `${id}-title`, tabindex: '-1' } }, HOME_NAME_REMOVE_CONFIRM.title),
        d.h('ul', {}, ...HOME_NAME_REMOVE_CONFIRM.points.map((p) => d.h('li', {}, p))),
        d.h(
          'div',
          { class: 'actions start' },
          button(going ? HOME_NAME_REMOVE_CONFIRM.going : HOME_NAME_REMOVE_CONFIRM.go, `${id}-go`, () => deps.track(remove()), { cls: 'stop', kind: 'danger', sm: true, disabled: busy !== null }),
          button('Cancel', `${id}-cancel`, cancelRemove, { sm: true, disabled: busy !== null }),
        ),
      );
    }
    return null;
  }

  function frontBody(): Child[] {
    const out: Child[] = [front.problem ? problemView('front', front.problem) : null];
    if (front.state === 'closed') {
      out.push(d.h('div', { class: 'actions start' }, button(busy === 'load-front' ? 'Loading…' : HOME_NAME_TEXT.frontShow, 'home-profile-show', () => deps.track(loadFront()), { disabled: busy !== null })));
      return out;
    }
    if (front.state === 'loading') {
      out.push(d.h('p', { class: 'muted', attrs: { role: 'status' } }, HOME_NAME_TEXT.loading));
      return out;
    }
    const form = d.h(
      'form',
      { class: 'home-name-form', attrs: { id: 'home-name-form', novalidate: '', 'aria-labelledby': 'home-profile-title' } },
      d.h('div', { class: 'home-name-fields' }, field('given'), field('family')),
      d.h('p', { class: 'muted', attrs: { id: 'home-name-help' } }, HOME_NAME_TEXT.help),
      front.formNote ? alert(d, 'info', { class: 'note', attrs: { role: 'status', id: 'home-name-form-note' } }, front.formNote) : null,
      d.h(
        'div',
        { class: 'actions start' },
        button(busy === 'save' ? HOME_NAME_TEXT.saving : HOME_NAME_TEXT.save, 'home-name-save', () => {}, { cls: 'primary', kind: 'primary', type: 'submit', disabled: busy !== null || confirmRemove }),
        // Not the danger button itself: that one is in the confirmation it opens.
        name !== null && !confirmRemove ? button(HOME_NAME_TEXT.remove, 'home-name-remove', askRemove, { disabled: busy !== null }) : null,
      ),
      removeControl(),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      // A submit from the keyboard or the button, never one a script made.
      if (!isGesture(e)) return;
      deps.track(save());
    });
    out.push(form, noteView(front.note, 'home-profile-note'));
    out.push(d.h('h3', { attrs: { id: 'home-name-shares-title' } }, HOME_NAME_TEXT.sharesTitle));
    if (front.shares.length === 0)
      out.push(d.h('div', { class: 'jp-empty home-empty', attrs: { id: 'home-name-shares-none' } }, icon(d, 'shield'), d.h('span', {}, HOME_NAME_TEXT.noShares)));
    else
      out.push(
        d.h(
          'ul',
          { class: 'home-name-shares jp-card', attrs: { 'aria-labelledby': 'home-name-shares-title' } },
          ...front.shares.map((s) => {
            const lineId = `home-name-share-${s.appId}`;
            return settingRow(
              'home-name-share',
              { 'data-app': s.appId },
              [d.h('span', { class: 'home-setting-title', attrs: { id: lineId } }, d.h('strong', {}, s.name)), d.h('small', {}, `Shared since ${when(s.sharedAtMs)}`)],
              button(busy === `stop:${s.appId}` ? HOME_NAME_TEXT.stopping : HOME_NAME_TEXT.stop, `home-name-stop-${s.appId}`, () => deps.track(toggle('front', s.appId, s.name, false, null)), { describedBy: lineId, sm: true, disabled: busy !== null }),
            );
          }),
        ),
      );
    if (front.more) out.push(d.h('p', { class: 'muted', attrs: { id: 'home-name-shares-more' } }, HOME_NAME_TEXT.more));
    out.push(d.h('p', { class: 'muted' }, HOME_NAME_TEXT.howToShare));
    out.push(d.h('div', { class: 'actions start' }, button(busy === 'load-front' ? 'Loading…' : HOME_NAME_TEXT.again, 'home-profile-refresh', () => deps.track(loadFront()), { disabled: busy !== null })));
    return out;
  }

  function appEntry(a: AppEntry): HTMLElement {
    const lineId = `home-app-name-line-${a.appId}`;
    const going = busy === `share:${a.appId}` || busy === `stop:${a.appId}`;
    let control: Child = null;
    const why = a.deleted ? HOME_NAME_TEXT.deleted : a.shared === null ? HOME_NAME_TEXT.cantShare : null;
    if (a.deleted || a.shared === null) control = null;
    else if (a.shared)
      control = button(going ? HOME_NAME_TEXT.stopping : HOME_NAME_TEXT.stopApp, `home-app-name-stop-${a.appId}`, () => deps.track(toggle('app', a.appId, a.name, false, appScope?.scopeId ?? null)), { describedBy: lineId, sm: true, disabled: busy !== null });
    else if (name !== null)
      control = button(going ? HOME_NAME_TEXT.sharing : shareLabel(a.name), `home-app-name-share-${a.appId}`, () => deps.track(toggle('app', a.appId, a.name, true, appScope?.scopeId ?? null)), {
        // Secondary: an app's page can list several apps, and a view has one primary at most.
        cls: 'share',
        sm: true,
        describedBy: lineId,
        disabled: busy !== null,
      });
    return settingRow(
      'home-name-app',
      { 'data-app': a.appId },
      [d.h('span', { class: 'home-setting-title', attrs: { id: lineId } }, d.h('strong', {}, a.name), a.shared === null ? null : ' ', a.shared === null ? null : badge(a.shared ? HOME_NAME_TEXT.shared : HOME_NAME_TEXT.notShared, a.shared ? 'ok' : 'plain')), why ? d.h('small', {}, why) : null],
      control,
      [noteView(app.notes.get(a.appId), `home-app-profile-note-${a.appId}`)],
    );
  }

  function appBody(): Child[] {
    const out: Child[] = [app.problem ? problemView('app', app.problem) : null];
    if (app.state === 'closed') {
      out.push(d.h('div', { class: 'actions start' }, button(busy === 'load-app' ? 'Loading…' : HOME_NAME_TEXT.appShow, 'home-app-profile-show', () => deps.track(loadApp()), { disabled: busy !== null })));
      return out;
    }
    if (app.state === 'loading') {
      out.push(d.h('p', { class: 'muted', attrs: { role: 'status' } }, HOME_NAME_TEXT.loading));
      return out;
    }
    // The name, once a read has said what it is (a listing of deleted apps alone reads nothing).
    if (name !== null) out.push(d.h('p', { attrs: { id: 'home-app-name-current' } }, HOME_NAME_TEXT.current, nameText(name)));
    else if (known) out.push(d.h('p', { class: 'muted', attrs: { id: 'home-app-name-none' } }, HOME_NAME_TEXT.noName));
    if (app.apps.length > 0) out.push(d.h('ul', { class: 'home-name-apps jp-card' }, ...app.apps.map(appEntry)));
    out.push(d.h('div', { class: 'actions start' }, button(busy === 'load-app' ? 'Loading…' : HOME_NAME_TEXT.again, 'home-app-profile-refresh', () => deps.track(loadApp()), { disabled: busy !== null })));
    return out;
  }

  function render(where: Where): void {
    const root = where === 'front' ? frontRoot : appRoot;
    const heading = where === 'front' ? d.h('h2', { attrs: { id: 'home-profile-title', tabindex: '-1' } }, HOME_NAME_TITLE) : d.h('h3', { attrs: { id: 'home-app-profile-title', tabindex: '-1' } }, HOME_NAME_TITLE);
    const about = d.h('p', {}, where === 'front' ? HOME_NAME_TEXT.frontAbout : HOME_NAME_TEXT.appAbout);
    root.replaceChildren();
    for (const c of [heading, about, ...(where === 'front' ? frontBody() : appBody())]) if (c !== null && c !== undefined && c !== false) root.append(typeof c === 'string' ? deps.win.document.createTextNode(c) : c);
  }

  render('front');
  render('app');

  return {
    get front() {
      return front.state;
    },
    get app() {
      return app.state;
    },
    get confirming() {
      return confirmRemove;
    },
    get errorCode() {
      return front.problem?.code ?? app.problem?.code ?? null;
    },
    get requests() {
      return requests;
    },
    frontView() {
      return frontRoot;
    },
    appView(scope) {
      if (appScope?.scopeId !== scope.scopeId) {
        appScope = scope;
        appTurn += 1;
        app = newApp();
        if (busy === 'load-app') busy = null;
        render('app');
      } else appScope = scope;
      return appRoot;
    },
    leaveApp() {
      appScope = null;
      appTurn += 1;
      app = newApp();
      if (busy === 'load-app') busy = null;
      render('app');
    },
    reset() {
      epoch += 1;
      appTurn += 1;
      name = null;
      known = false;
      front = newFront();
      app = newApp();
      appScope = null;
      confirmRemove = false;
      busy = null;
      render('front');
      render('app');
    },
  };
}
