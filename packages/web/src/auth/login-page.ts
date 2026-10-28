// `GET {authOrigin}/login` (docs/batch-b-spec.md "Login" steps 3–5): the login popup. It finds whoever prepared the
// login (the vault, or the export window), authenticates its reply by origin and window, cross-checks it against the
// pinned SIGNER and GET /v1/app, recomputes the nonce, stores the relayKey under the state in its own sessionStorage
// and navigates to Google. It never sees a token: /login/callback relays Google's answer.
//
// Opener modes:
//   partner  /login?v=<vault frame name>  opened by the partner page; the vault is window.opener.frames[v]
//   vault    /login?from=vault            opened by the vault's launcher; the vault is window.opener
//   export   /login?mode=export           opened by the export window (authOrigin); it is window.opener
//
// SECURITY: auth-params carries relayKey, the one session secret that crosses postMessage. It is accepted only from
// the authenticated sender, kept only in sessionStorage, and the in-memory copy is zeroed.
import { type WindowMessage, parseWindowMessage, sessionNonce } from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { type Dom, dom, errorView } from './dom.ts';
import { PageError, apiErrorCode, errorMessage } from './errors.ts';
import { googleAuthUrl } from './google.ts';
import { storeLoginEntry } from './login-storage.ts';
import { type PageWindow, isFramed } from './page-window.ts';

export type OpenerMode = 'partner' | 'vault' | 'export';

/** The vault iframe's name, `hana-vault-<32 hex>` (128-bit random, set by the SDK). */
export const VAULT_FRAME_NAME = /^hana-vault-[0-9a-f]{32}$/u;
export const HELLO_INTERVAL_MS = 100;
export const HELLO_TIMEOUT_MS = 15_000;
export const EXPORT_PATH = '/export';

export interface LoginPageDeps {
  win: PageWindow;
  env: HanaEnv;
  api: AuthApi;
  /** Device clock (only for sessionStorage entry ages). */
  now?: () => number;
}

export type LoginPageState =
  | { readonly stage: 'connecting'; readonly mode: OpenerMode }
  | { readonly stage: 'checking'; readonly mode: OpenerMode }
  | { readonly stage: 'redirecting'; readonly mode: OpenerMode; readonly url: string }
  | { readonly stage: 'error'; readonly code: string };

export interface LoginPage {
  readonly state: LoginPageState;
  /** Resolves when the page reached `redirecting` or `error`. */
  readonly done: Promise<LoginPageState>;
  stop(): void;
}

/** The opener mode from the query, or null when the link is not one of the three forms exactly. */
export function openerMode(search: string): { mode: OpenerMode; vaultFrame?: string } | null {
  const q = new URLSearchParams(search);
  const keys = [...q.keys()];
  if (keys.length !== 1) return null;
  const values = q.getAll(keys[0] as string);
  if (values.length !== 1) return null;
  const value = values[0] as string;
  if (keys[0] === 'v' && VAULT_FRAME_NAME.test(value)) return { mode: 'partner', vaultFrame: value };
  if (keys[0] === 'from' && value === 'vault') return { mode: 'vault' };
  if (keys[0] === 'mode' && value === 'export') return { mode: 'export' };
  return null;
}

/** Child frame `name` of `w`, or null (cross-origin named access to child frames is allowed; anything odd is null). */
function childFrame(w: Window, name: string): unknown {
  try {
    return (w.frames as unknown as Record<string, unknown>)[name] ?? null;
  } catch {
    return null;
  }
}

function parentOf(w: unknown): unknown {
  try {
    return (w as Window).parent;
  } catch {
    return null;
  }
}

/** `window.opener.location.pathname` when the opener is same-origin, else null (a cross-origin read throws). */
function openerPath(opener: Window): string | null {
  try {
    return opener.location.pathname;
  } catch {
    return null;
  }
}

export function startLoginPage(deps: LoginPageDeps): LoginPage {
  const { win, env, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const d: Dom = dom(win.document);
  let state: LoginPageState = { stage: 'error', code: 'config_mismatch' };
  let finish: (s: LoginPageState) => void = () => {};
  const done = new Promise<LoginPageState>((resolve) => {
    finish = resolve;
  });
  let helloTimer: ReturnType<typeof setInterval> | undefined;
  let helloDeadline: ReturnType<typeof setTimeout> | undefined;
  let accepted = false;

  const stop = () => {
    clearInterval(helloTimer);
    clearTimeout(helloDeadline);
    win.removeEventListener('message', onMessage);
  };
  const fail = (code: string | number, title: string, message: string) => {
    stop();
    state = { stage: 'error', code: String(code) };
    d.show(errorView(d, title, message, String(code)));
    finish(state);
  };

  const parsed = openerMode(win.location.search);
  const opener = win.opener;

  function onMessage(event: Event): void {
    if (accepted || !parsed || !opener) return;
    const e = event as MessageEvent;
    const msg = parseWindowMessage(e.data, ['hana:auth-params']);
    if (!msg) return;
    if (!fromPreparer(e, parsed.mode, parsed.vaultFrame)) return;
    accepted = true;
    stop();
    void check(msg, parsed.mode);
  }

  /** Step 4's sender check for the opener mode. */
  function fromPreparer(e: MessageEvent, mode: OpenerMode, vaultFrame?: string): boolean {
    if (!opener) return false;
    if (mode === 'export') return e.origin === env.authOrigin && e.source === opener && openerPath(opener) === EXPORT_PATH;
    if (e.origin !== env.vaultOrigin) return false;
    if (mode === 'vault') return e.source === opener;
    const vault = childFrame(opener, vaultFrame as string);
    return vault !== null && e.source === vault && parentOf(e.source) === opener;
  }

  async function check(msg: WindowMessage<'hana:auth-params'>, mode: OpenerMode): Promise<void> {
    state = { stage: 'checking', mode };
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Checking the sign-in request…')));
    try {
      if (msg.signer !== env.signer) throw new PageError('config_mismatch', 'The vault named another signer.');
      let app;
      try {
        app = await api.getApp(msg.pk, msg.parentOrigin);
      } catch (err) {
        const code = apiErrorCode(err);
        throw new PageError(code, errorMessage(code));
      }
      if (app.signer !== env.signer || app.scopeId !== msg.scopeId || app.google.clientId !== msg.clientId) {
        throw new PageError('config_mismatch', 'The sign-in request does not match this app’s settings.');
      }
      const nonce = sessionNonce({
        signer: env.signer,
        scopeId: msg.scopeId,
        sessionPublicKey: msg.sessionPublicKey,
        expiresAtMs: msg.expiresAtMs,
        keyIndex: msg.keyIndex,
        maxUses: msg.maxUses,
        salt: msg.salt,
      });
      if (nonce !== msg.nonce) throw new PageError('config_mismatch', 'The sign-in request’s nonce does not commit to its session.');
      try {
        storeLoginEntry(win.sessionStorage, msg.relayId, msg.relayKey, now());
      } catch {
        throw new PageError('storage_unavailable', 'This browser blocked the storage the sign-in needs.');
      } finally {
        msg.relayKey.fill(0);
      }
      const url = googleAuthUrl({ clientId: msg.clientId, authOrigin: env.authOrigin, nonce: msg.nonce, state: msg.relayId, forceReauth: mode === 'export' });
      const appName = app.name ?? msg.appName;
      d.show(
        d.h(
          'section',
          { class: 'panel' },
          d.h('h1', {}, mode === 'export' ? 'Confirm it’s you' : 'Signing in'),
          d.h('p', {}, 'Signing in to ', d.h('strong', {}, appName), ' at ', d.h('span', { class: 'origin' }, msg.parentOrigin)),
          d.h('p', { class: 'muted' }, 'Continuing to Google…'),
        ),
      );
      state = { stage: 'redirecting', mode, url };
      finish(state);
      win.location.assign(url);
    } catch (err) {
      msg.relayKey.fill(0);
      const e = err instanceof PageError ? err : new PageError('config_mismatch', 'The sign-in request could not be checked.');
      fail(e.code, 'Sign-in stopped', e.message);
    }
  }

  if (isFramed(win)) {
    fail('config_mismatch', 'Sign-in stopped', 'The Hana sign-in window can’t run inside another page.');
  } else if (!parsed) {
    fail('config_mismatch', 'Sign-in stopped', 'This sign-in link is not valid. Start again from the app.');
  } else if (opener === null) {
    fail(
      'coop_blocks_popup',
      'This site’s settings block the Hana sign-in window (COOP)',
      'The site you came from cut this window off from it, so the sign-in can’t finish here. Close this window and tell the site’s developers.',
    );
  } else {
    state = { stage: 'connecting', mode: parsed.mode };
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Connecting…')));
    win.addEventListener('message', onMessage);
    const targetOrigin = parsed.mode === 'export' ? env.authOrigin : env.vaultOrigin;
    const hello = () => {
      const target = parsed.mode === 'partner' ? childFrame(opener, parsed.vaultFrame as string) : opener;
      try {
        (target as Window | null)?.postMessage({ v: 1, t: 'hana:auth-hello' }, targetOrigin);
      } catch {
        // The opener navigated away or the frame is gone; keep trying until the deadline.
      }
    };
    hello();
    helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
    helloDeadline = setTimeout(() => {
      if (!accepted) fail('login_timeout', 'Sign-in stopped', 'The app’s Hana vault did not answer. Close this window and start again from the app.');
    }, HELLO_TIMEOUT_MS);
  }

  return {
    get state() {
      return state;
    },
    done,
    stop,
  };
}
