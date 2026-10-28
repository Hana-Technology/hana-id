// The partner side of login step 1 (docs/batch-b-spec.md "Login"):
//
// - openLoginPopup runs synchronously in the partner's click handler, before any await:
//   window.open('{authOrigin}/login?v=<vault frame name>', 'hana-login-<32 hex>', 'popup,width=480,height=640'),
//   without noopener (the popup finds the vault through window.opener.frames[v]).
// - LoginAttempt then sends `hana_login` on the port, or `hana_login {popupBlocked: true}` when window.open returned
//   null (the vault shows its "Sign in with Hana" launcher and keeps the login pending). With a popup it polls
//   `popup.closed` every 100 ms until the vault reports `loginProgress: popup_connected`:
//   - closed first → `coop_blocks_popup` (partner COOP same-origin, or the user closed it before it loaded);
//   - 15 s from opening without `popup_connected` → `hana_cancelLogin`, close the popup, `login_timeout`
//     (`data.stage: 'connect'`).
//   After `popup_connected` it stops looking at `popup.closed`, because Google's COOP may make the handle report closed.
// - A newer login supersedes this one (`login_cancelled`); the partner's cancelLogin() ends it with `login_cancelled`,
//   or `popup_blocked` when it was waiting on the launcher. Either way the vault is told (`hana_cancelLogin`) when it
//   has the request, so it drops its pending state.
import type { LoginResult, PortMethod, PortParamsMap, PortResultMap } from '@hana-id/core';
import { type HanaError, asHanaError, hanaError } from './errors.ts';
import { randomHex } from './random.ts';

export const POPUP_POLL_MS = 100;
/** `popup_connected` must arrive this long after window.open. */
export const POPUP_CONNECT_TIMEOUT_MS = 15_000;
export const LOGIN_POPUP_FEATURES = 'popup,width=480,height=640';

/** Opens the login popup. Returns null when the browser blocked it (or window.open threw). Synchronous. */
export function openLoginPopup(win: Window, authOrigin: string, vaultFrameName: string): Window | null {
  try {
    return win.open(`${authOrigin}/login?v=${encodeURIComponent(vaultFrameName)}`, `hana-login-${randomHex(16)}`, LOGIN_POPUP_FEATURES) ?? null;
  } catch {
    return null;
  }
}

export interface LoginPort {
  /** Resolves once the vault is ready (rejects with vault_unavailable). */
  ready(): Promise<unknown>;
  send<M extends PortMethod>(method: M, params?: PortParamsMap[M]): Promise<PortResultMap[M]>;
}

/** What a login attempt ends with: a fresh login, or the vault turned out already logged in (no hana_login sent). */
export type LoginOutcome = { kind: 'login'; result: LoginResult } | { kind: 'already' };

export class LoginAttempt {
  readonly promise: Promise<LoginOutcome>;
  readonly popupBlocked: boolean;

  readonly #port: LoginPort;
  readonly #popup: Window | null;
  readonly #isLoggedIn: () => boolean;
  #settled = false;
  #sent = false;
  #connected = false;
  #cancelSent = false;
  #poll: ReturnType<typeof setInterval> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #resolve!: (o: LoginOutcome) => void;
  #reject!: (e: HanaError) => void;

  /**
   * `popup` is what openLoginPopup returned, just before this. `isLoggedIn` is read once the vault is ready: a page
   * that called login() before the handshake finished may turn out to be unlocked already.
   */
  constructor(port: LoginPort, popup: Window | null, isLoggedIn: () => boolean) {
    this.#port = port;
    this.#popup = popup;
    this.#isLoggedIn = isLoggedIn;
    this.popupBlocked = popup === null;
    this.promise = new Promise<LoginOutcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    if (popup) {
      this.#poll = setInterval(() => {
        if (!this.#connected && this.#popupClosed()) this.#fail(hanaError('coop_blocks_popup'), true);
      }, POPUP_POLL_MS);
      this.#deadline = setTimeout(() => {
        if (!this.#connected) this.#fail(hanaError('login_timeout', undefined, { stage: 'connect' }), true);
      }, POPUP_CONNECT_TIMEOUT_MS);
    }
    void this.#run();
  }

  get settled(): boolean {
    return this.#settled;
  }

  async #run(): Promise<void> {
    try {
      await this.#port.ready();
    } catch (e) {
      this.#fail(asHanaError(e), false);
      return;
    }
    if (this.#settled) return;
    if (this.#isLoggedIn()) {
      this.#stopWatching();
      this.#closePopup();
      this.#settle();
      this.#resolve({ kind: 'already' });
      return;
    }
    this.#sent = true;
    let result: LoginResult;
    try {
      result = await this.#port.send('hana_login', this.popupBlocked ? { popupBlocked: true } : undefined);
    } catch (e) {
      this.#fail(asHanaError(e), false);
      return;
    }
    if (this.#settled) return;
    this.#settle();
    this.#resolve({ kind: 'login', result });
  }

  /** The vault reported `loginProgress: popup_connected`. */
  connected(): void {
    if (this.#settled || !this.#sent) return;
    this.#connected = true;
    this.#stopWatching();
  }

  /** A newer login replaced this one (the vault cancels its own pending login when it gets the new hana_login). */
  supersede(): void {
    this.#fail(hanaError('login_cancelled', 'A newer sign-in replaced this one'), false);
  }

  /** The partner called cancelLogin(). */
  cancel(): void {
    this.#fail(this.popupBlocked ? hanaError('popup_blocked') : hanaError('login_cancelled'), true);
  }

  /** The client is being destroyed: end with 4900 without touching the (closing) port. */
  abort(e: HanaError): void {
    this.#fail(e, false);
  }

  #fail(e: HanaError, tellVault: boolean): void {
    if (this.#settled) return;
    this.#settle();
    if (!this.#connected) this.#closePopup();
    if (tellVault && this.#sent && !this.#cancelSent) {
      this.#cancelSent = true;
      // The vault answers the old hana_login with login_cancelled, which this attempt no longer waits for.
      this.#port.send('hana_cancelLogin').catch(() => {});
    }
    this.#reject(e);
  }

  #settle(): void {
    this.#settled = true;
    this.#stopWatching();
  }

  #stopWatching(): void {
    clearInterval(this.#poll);
    clearTimeout(this.#deadline);
    this.#poll = undefined;
    this.#deadline = undefined;
  }

  #popupClosed(): boolean {
    try {
      return this.#popup?.closed === true;
    } catch {
      return false;
    }
  }

  #closePopup(): void {
    try {
      this.#popup?.close();
    } catch {
      // A COOP-severed or cross-origin handle may throw; nothing else to do.
    }
  }
}
