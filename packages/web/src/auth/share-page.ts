// `GET {authOrigin}/share-email` (D411, D438–D442; docs/email-sharing-spec.md "Screens"): the email sharing sheet. It
// talks only to the app's vault on vaultOrigin, shows the app's name and the exact address the app would get, and
// answers with the user's choice; the vault records it.
//
// Opener modes:
//   login    /share-email?from=login                   the login popup at the end of an `at_login` sign-in
//                                                      (share-handoff.ts): the vault is the opener or one of its frames,
//                                                      as for the callback's signals (it doesn't know the frame's name)
//   partner  /share-email?from=partner&v=<vault frame> opened by the SDK in the partner's click (requestEmailSharing):
//                                                      the vault is window.opener.frames[v], authenticated as the
//                                                      approval popup does it
//   vault    /share-email?from=vault                   opened by the vault's launcher: the vault is window.opener
//
// Steps: `hana:email-share-hello` to the vault (again every HELLO_EVERY_MS: in login mode the vault is still finishing
// the sign-in) → `hana:email-share-request` from the vault → the address from the API
// (`POST /v1/identity/email-consent/preview` with the vault's single-use proof: the vault never sees the address) →
// the sheet → `hana:email-share-answer` → the vault's `hana:email-share-done` (or `-close`) → the window closes.
//
// "Share email" is the approval popup's guarded button (approve-guard.ts, D36); "Not now" always lets the user go on
// (D411 point 7). The copy never promises more than Hana can keep (D42): an app on its own Google client can get the
// address from Google whatever the user chooses here, and an app keeps what it already received.
//
// SECURITY: the address is shown through text nodes only and dropped once the user answered; nothing is logged or
// stored. Messages count only from the authenticated vault; this page posts only to it (targetOrigin vaultOrigin).
import { type WindowMessage, parseWindowMessage } from '@hana-id/core';
import { BRAND } from '@hana-id/brand';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { ApproveGuard, type GuardInput, guardInputOf } from './approve-guard.ts';
import { type Dom, dom, errorView, originText } from './dom.ts';
import { appLogo } from './logo.ts';
import { BTN, alert } from './ui.ts';
import { type GestureCheck, type PageWindow, VAULT_FRAME_NAME, childFrame, fromPartnerVault, isFramed, isUserGesture } from './page-window.ts';

/** How often the hello is sent again until the vault answers. */
export const HELLO_EVERY_MS = 500;
/** How long the page waits for the vault: the login's own limit in login mode, less when opened for the sheet alone. */
export const LOGIN_WAIT_MS = 5 * 60_000;
export const OPENED_WAIT_MS = 60_000;
/** How long the page shows the outcome before it closes. */
export const DONE_CLOSE_MS = 1_200;

export type ShareOpener = { mode: 'login' } | { mode: 'vault' } | { mode: 'partner'; vaultFrame: string };

/** The opener mode from the query: exactly `from=login`, `from=vault`, or `from=partner&v=<vault frame name>`. */
export function shareOpenerMode(search: string): ShareOpener | null {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  if (q.getAll('from').length !== 1) return null;
  const from = q.get('from');
  if ((from === 'login' || from === 'vault') && keys.length === 1) return { mode: from };
  if (from !== 'partner' || keys.length !== 2 || q.getAll('v').length !== 1) return null;
  const v = q.get('v') as string;
  return VAULT_FRAME_NAME.test(v) ? { mode: 'partner', vaultFrame: v } : null;
}

export interface SharePageDeps {
  win: PageWindow;
  env: HanaEnv;
  api: Pick<AuthApi, 'emailPreview'>;
  now?: () => number;
  isGesture?: GestureCheck;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
}

export type SharePageState = 'connecting' | 'loading' | 'ask' | 'shared' | 'saving' | 'done' | 'closed' | 'error';

export interface SharePage {
  readonly state: SharePageState;
  readonly guard: ApproveGuard;
  stop(): void;
}

/** The sheet's words, in one place (tests read them). */
export const SHARE_TEXT = {
  ask: (app: string) => `Share your email with ${app}?`,
  wants: (app: string) => `${app} would like your email address:`,
  use: (app: string) => `${app} can then email you and recognise your account. You can stop sharing later; ${app} may keep the address it already received.`,
  ownGoogle: (app: string) => `${app} uses its own Google sign-in, so Google may give ${app} your address whatever you choose here.`,
  shared: (app: string) => `Email shared with ${app}`,
  sharedText: (app: string) => `${app} gets this address from ${BRAND.company} when you sign in:`,
  stopNote: (app: string) => `If you stop sharing, ${app} may keep the address it already received; ask ${app} to delete it.`,
  savedShared: (app: string) => `${app} now gets your email address.`,
  savedNotShared: (app: string) => `${app} doesn’t get your email address from ${BRAND.company}.`,
};

export function startSharePage(deps: SharePageDeps): SharePage {
  const { win, env } = deps;
  const now = deps.now ?? (() => Date.now());
  const isGesture = deps.isGesture ?? isUserGesture;
  const timers = deps.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const d: Dom = dom(win.document);
  const opener = win.opener;
  const opened = shareOpenerMode(win.location.search);
  let state: SharePageState = 'connecting';
  let stopped = false;
  let helloTimer: unknown = null;
  let waitTimer: unknown = null;
  let primary: HTMLButtonElement | null = null;
  /** The vault window that sent the request: answers go there only. */
  let vault: Window | null = null;
  let current: WindowMessage<'hana:email-share-request'> | null = null;
  const visible = () => win.document.visibilityState !== 'hidden';
  const hasFocus = () => (typeof win.document.hasFocus === 'function' ? win.document.hasFocus() : true);
  const guard = new ApproveGuard(now, visible() && hasFocus() ? now() : null, (armed) => {
    if (primary) primary.disabled = !armed;
  });

  /** The windows that may be the vault, for the opener mode (read each time, as the other popups do). */
  const targets = (): unknown[] => {
    if (!opener || !opened) return [];
    if (opened.mode === 'vault') return [opener];
    if (opened.mode === 'partner') return [childFrame(opener, opened.vaultFrame)].filter((w) => w !== null);
    const out: unknown[] = [opener];
    try {
      for (let i = 0; i < Math.min(opener.length, 32); i++) out.push(opener[i]);
    } catch {
      // The opener's frames can't be listed: the opener alone.
    }
    return out;
  };
  const fromVault = (e: MessageEvent): boolean => {
    if (!opener || !opened || e.origin !== env.vaultOrigin || !e.source) return false;
    if (opened.mode === 'partner') return fromPartnerVault(e, opener, opened.vaultFrame, env.vaultOrigin);
    if (vault) return e.source === vault;
    return targets().includes(e.source);
  };

  const hello = (): void => {
    for (const t of targets()) {
      try {
        (t as Window).postMessage({ v: 1, t: 'hana:email-share-hello' }, env.vaultOrigin);
      } catch {
        // Gone: the next round tries again.
      }
    }
  };

  const onGesture = (type: GuardInput['type']) => (e: Event) => {
    if (isGesture(e)) guard.gesture(guardInputOf(type, e));
  };
  const onVisibility = () => (visible() ? guard.focused() : guard.blurred());
  const listeners: [string, (e: Event) => void][] = [
    ['message', onMessage],
    ['focus', () => guard.focused()],
    ['blur', () => guard.blurred()],
    ['pointermove', onGesture('pointermove')],
    ['pointerdown', onGesture('pointerdown')],
    ['keydown', onGesture('keydown')],
  ];

  function stop(): void {
    stopped = true;
    if (helloTimer !== null) timers.clearTimeout(helloTimer);
    if (waitTimer !== null) timers.clearTimeout(waitTimer);
    helloTimer = null;
    waitTimer = null;
    for (const [t, l] of listeners) win.removeEventListener(t, l);
    win.document.removeEventListener('visibilitychange', onVisibility);
  }

  function close(): void {
    if (state === 'closed') return;
    stop();
    current = null;
    state = 'closed';
    win.close();
  }

  function fail(title: string, text: string, code?: string): void {
    stop();
    current = null;
    primary = null;
    state = 'error';
    const btn = d.h('button', { class: `secondary ${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'share-close' } }, 'Close');
    btn.addEventListener('click', () => win.close());
    d.show(errorView(d, title, text, code), d.h('div', { class: 'actions' }, btn));
  }

  function header(m: WindowMessage<'hana:email-share-request'>): HTMLElement {
    return d.h('header', { class: 'app' }, d.h('p', {}, appLogo(d, env, m.logoUrl), 'From ', d.h('strong', {}, m.appName)), originText(d, m.parentOrigin, 'p'));
  }

  function answer(a: 'granted' | 'declined' | 'revoke' | 'keep'): void {
    if (!current || !vault || stopped || (state !== 'ask' && state !== 'shared')) return;
    const app = current.appName;
    state = 'saving';
    primary = null;
    guard.cleared();
    try {
      vault.postMessage({ v: 1, t: 'hana:email-share-answer', answer: a }, env.vaultOrigin);
    } catch {
      fail('Couldn’t save your choice', 'Close this window and try again from the app.');
      return;
    }
    d.show(d.h('section', { class: 'panel share' }, d.h('h1', {}, 'Saving…'), d.h('p', { class: 'muted' }, app)));
  }

  function showAsk(m: WindowMessage<'hana:email-share-request'>, email: string): void {
    state = 'ask';
    const no = d.h('button', { class: `secondary ${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'share-not-now' } }, 'Not now');
    no.addEventListener('click', (e) => {
      if (isGesture(e)) answer('declined');
    });
    const yes = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'share-email' } }, 'Share email');
    yes.disabled = true;
    yes.addEventListener('focus', () => guard.primaryFocused());
    yes.addEventListener('blur', () => guard.primaryBlurred());
    yes.addEventListener('click', (e) => {
      // As Approve: the guard is checked on click too, and the click must have started after the arming gesture.
      if (isGesture(e) && guard.mayActivate((e as MouseEvent).detail === 0)) answer('granted');
    });
    primary = yes;
    d.show(
      d.h(
        'section',
        { class: 'panel share' },
        header(m),
        d.h('h1', {}, SHARE_TEXT.ask(m.appName)),
        d.h('p', {}, SHARE_TEXT.wants(m.appName)),
        d.h('p', { class: 'address' }, d.h('strong', { class: 'mono', attrs: { id: 'share-address' } }, email)),
        d.h('p', { class: 'muted' }, SHARE_TEXT.use(m.appName)),
        m.ownGoogleClient ? alert(d, 'info', { class: 'note' }, SHARE_TEXT.ownGoogle(m.appName)) : null,
        d.h('div', { class: 'actions' }, no, yes),
      ),
    );
    guard.rendered();
  }

  function showShared(m: WindowMessage<'hana:email-share-request'>, email: string): void {
    state = 'shared';
    primary = null;
    const stopBtn = d.h('button', { class: `secondary ${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'share-stop' } }, 'Stop sharing');
    stopBtn.addEventListener('click', (e) => {
      if (isGesture(e)) answer('revoke');
    });
    const done = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'share-done' } }, 'Done');
    done.addEventListener('click', (e) => {
      if (isGesture(e)) answer('keep');
    });
    d.show(
      d.h(
        'section',
        { class: 'panel share' },
        header(m),
        d.h('h1', {}, SHARE_TEXT.shared(m.appName)),
        d.h('p', {}, SHARE_TEXT.sharedText(m.appName)),
        d.h('p', { class: 'address' }, d.h('strong', { class: 'mono', attrs: { id: 'share-address' } }, email)),
        d.h('p', { class: 'muted' }, SHARE_TEXT.stopNote(m.appName)),
        m.ownGoogleClient ? alert(d, 'info', { class: 'note' }, SHARE_TEXT.ownGoogle(m.appName)) : null,
        d.h('div', { class: 'actions' }, stopBtn, done),
      ),
    );
  }

  async function onRequest(m: WindowMessage<'hana:email-share-request'>, source: Window): Promise<void> {
    if (current) return;
    current = m;
    vault = source;
    if (helloTimer !== null) timers.clearTimeout(helloTimer);
    if (waitTimer !== null) timers.clearTimeout(waitTimer);
    helloTimer = null;
    waitTimer = null;
    state = 'loading';
    d.show(d.h('section', { class: 'panel share' }, header(m), d.h('p', { class: 'muted' }, 'Loading…')));
    let email: string;
    try {
      email = await deps.api.emailPreview(m.pk, m.parentOrigin, {
        sessionPublicKey: Array.from(m.proof.sessionPublicKey),
        issuedAtMs: m.proof.issuedAtMs,
        nonce: Array.from(m.proof.nonce),
        signature: Array.from(m.proof.signature),
        sealedEmail: m.sealedEmail,
      });
    } catch {
      if (stopped) return;
      fail('Couldn’t load your email address', `${BRAND.company} couldn’t read the address to show it. Close this window; you can share it later from the app.`);
      return;
    }
    if (stopped || current !== m) return;
    if (m.state === 'granted') showShared(m, email);
    else showAsk(m, email);
  }

  function onDone(s: 'granted' | 'declined' | 'failed'): void {
    if (!current) return;
    const app = current.appName;
    if (s === 'failed') {
      fail('Couldn’t save your choice', `${BRAND.company} couldn’t save it. Close this window and try again from the app.`);
      return;
    }
    stop();
    current = null;
    state = 'done';
    d.show(d.h('section', { class: 'panel share' }, d.h('h1', {}, s === 'granted' ? 'Email shared' : 'Email not shared'), d.h('p', {}, s === 'granted' ? SHARE_TEXT.savedShared(app) : SHARE_TEXT.savedNotShared(app))));
    timers.setTimeout(() => {
      state = 'closed';
      win.close();
    }, DONE_CLOSE_MS);
  }

  function onMessage(event: Event): void {
    const e = event as MessageEvent;
    if (stopped || !fromVault(e)) return;
    const m = parseWindowMessage(e.data, ['hana:email-share-request', 'hana:email-share-close', 'hana:email-share-done']);
    if (!m) return;
    if (m.t === 'hana:email-share-close') {
      close();
      return;
    }
    if (m.t === 'hana:email-share-request') {
      void onRequest(m, e.source as Window);
      return;
    }
    if (e.source === vault) onDone(m.state);
  }

  if (isFramed(win)) {
    fail('Stopped', `This ${BRAND.product} window can’t run inside another page.`);
    return { get state() { return state; }, guard, stop };
  }
  if (!opener || !opened) {
    fail('Nothing to show', `This window wasn’t opened by ${BRAND.product}. Close it and use the app.`);
    return { get state() { return state; }, guard, stop };
  }
  for (const [t, l] of listeners) win.addEventListener(t, l);
  win.document.addEventListener('visibilitychange', onVisibility);
  d.show(d.h('section', { class: 'panel share' }, d.h('h1', {}, opened.mode === 'login' ? 'Finishing sign-in…' : 'Loading…')));
  const tick = (): void => {
    helloTimer = null;
    if (stopped || current) return;
    hello();
    helloTimer = timers.setTimeout(tick, HELLO_EVERY_MS);
  };
  tick();
  waitTimer = timers.setTimeout(() => {
    waitTimer = null;
    if (!current && !stopped) close();
  }, opened.mode === 'login' ? LOGIN_WAIT_MS : OPENED_WAIT_MS);

  return {
    get state() {
      return state;
    },
    guard,
    stop,
  };
}
