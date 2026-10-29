// `createHana`, the partner client (docs/batch-b-spec.md "Partner client"):
//
//   const hana = createHana({ publishableKey: 'pk_test_…', environment: 'sandbox-dev', evm?, stellar?, container? });
//   await hana.ready;            // handshake done, status known (an unlock has run); rejects vault_unavailable after 5 s
//   hana.status;                 // 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error'
//   hana.on('statusChanged' | 'accountsChanged' | 'sessionExpired' | 'disconnect', cb);
//   hana.login();                // call synchronously in a click handler
//   hana.prepareApproval();      // in a click handler, before awaiting a quote: opens the approval popup now (D99)
//   hana.logout(); hana.exportKey(chain); hana.revokeOtherDevices();
//   hana.stellar; hana.ethereum; hana.signRaw(params);
//
// The client holds no key material and no token: it mounts the vault iframe (vault-connection.ts), opens the login
// popup (login.ts) and, inside the user's click, the approval popup for signing requests (approval-window.ts, D99),
// and relays requests over the port. Everything it learns is public (addresses, expiry, status).
// Beyond the spec's list it also exposes cancelLogin() (the port's hana_cancelLogin), the auto-approve port methods,
// destroy() (React's HanaProvider unmount), and the `loginProgress`, `autoApproved` and `launcher` events.
import {
  ErrorCode,
  UNLOCK_TIMING_STAGES,
  isApprovalPopupMethod,
  type AutoApproveStatus,
  type LoginResult,
  type Persistence,
  type PortEvent,
  type PortEventMap,
  type PortMethod,
  type PortParamsMap,
  type PortResultMap,
  isPublishableKey,
  isTestPublishableKey,
} from '@hana-id/core';
import { VERSION } from '../version.ts';
import { type ApprovalTicket, ApprovalWindows } from './approval-window.ts';
import { Emitter } from './emitter.ts';
import { type HanaError, asHanaError, hanaError } from './errors.ts';
import { type EvmConfig, HanaEthereumProvider, announceEip6963, rdnsFor, validateEvmConfig } from './ethereum.ts';
import { LoginAttempt, openLoginPopup } from './login.ts';
import { type FetchLike } from './rpc.ts';
import { partnerPageIssues } from './requirements.ts';
import { HanaStellarSigner, type StellarConfig, validateStellarConfig } from './stellar.ts';
import { type ReadyStatus, VaultConnection } from './vault-connection.ts';

export interface HanaConfig {
  publishableKey: string;
  /** The Hana deployment, e.g. 'sandbox-dev': one of HANA_ENVIRONMENTS (the envs/ manifests this build carries). */
  environment: string;
  evm?: EvmConfig;
  stellar?: StellarConfig;
  /** Where the vault iframe and launcher go (default document.body). */
  container?: HTMLElement;
}

export type HanaStatus = 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error';

export interface HanaAddresses {
  stellar: string;
  evm: string;
}

export interface HanaEvents {
  statusChanged: [HanaStatus];
  accountsChanged: [HanaAddresses | null];
  sessionExpired: [];
  disconnect: [{ code: number }];
  loginProgress: [PortEventMap['loginProgress']];
  autoApproved: [PortEventMap['autoApproved']];
  /** The vault's launcher (a 320×72 px Hana button) is shown or hidden; `label` is its text. */
  launcher: [{ visible: boolean; label: string }];
  /**
   * `persistence` changed after login: 'none' when the vault could not save the session for reloads (D79). The wallet
   * keeps working on this page; the next page load needs a new login.
   */
  persistenceChanged: [Persistence];
}

export type SignRawParams = PortParamsMap['hana_signRaw'];

/** The two Hana origins of an env (the partner client needs nothing else from the manifest). */
export interface HanaOrigins {
  vaultOrigin: string;
  authOrigin: string;
}

export interface HanaClientDeps {
  win: Window;
  origins: HanaOrigins;
  fetch: FetchLike;
  /** Monotonic ms for pk_test_ timings; defaults to performance.now. */
  now?: () => number;
}

/** The vault's own parts of the iframe's load (unlock timings), taken out of the frame load the partner sees. */
const VAULT_LOAD_STAGES: readonly string[] = UNLOCK_TIMING_STAGES.filter((s) => s.startsWith('vault'));

export class HanaClient extends Emitter<HanaEvents> {
  /** Resolves when the handshake is done and the status is known; rejects with `vault_unavailable`. */
  readonly ready: Promise<void>;
  readonly stellar: HanaStellarSigner;
  readonly ethereum: HanaEthereumProvider;
  readonly vaultOrigin: string;
  readonly authOrigin: string;

  readonly #win: Window;
  readonly #conn: VaultConnection;
  #status: HanaStatus = 'unlocking';
  #addresses: HanaAddresses | null = null;
  #expiresAtMs: number | null = null;
  #persistence: Persistence | null = null;
  #warning: 'storage_unavailable' | null = null;
  #error: HanaError | null = null;
  #lastLogin: LoginResult | null = null;
  #readyTimings: Record<string, number> | null = null;
  readonly #now: () => number;
  readonly #createdAt: number;
  readonly #testApp: boolean;
  #attempt: LoginAttempt | null = null;
  #destroyed = false;
  /** The handshake failed or the port died: status stays 'error'. */
  #vaultDown = false;
  #stopEip6963: (() => void) | null = null;
  readonly #windows: ApprovalWindows;

  constructor(config: HanaConfig, deps: HanaClientDeps) {
    super();
    this.#now = deps.now ?? (() => performance.now());
    this.#createdAt = this.#now();
    if (typeof config !== 'object' || config === null) throw new TypeError('createHana takes a config object');
    if (!isPublishableKey(config.publishableKey)) throw new TypeError('publishableKey must be a pk_test_… or pk_live_… key');
    const evm = config.evm === undefined ? undefined : validateEvmConfig(config.evm);
    const stellar = config.stellar === undefined ? undefined : validateStellarConfig(config.stellar);
    this.#win = deps.win;
    this.#testApp = isTestPublishableKey(config.publishableKey);
    this.vaultOrigin = deps.origins.vaultOrigin;
    this.authOrigin = deps.origins.authOrigin;

    this.stellar = new HanaStellarSigner(
      { stellarAddress: () => this.#addresses?.stellar ?? null, login: () => this.login(), request: (m, p) => this.#request(m, p) },
      stellar,
    );
    this.ethereum = new HanaEthereumProvider(
      {
        evmAddress: () => this.#addresses?.evm ?? null,
        login: () => this.login(),
        request: (m, p) => this.#request(m, p),
        prepareApproval: () => this.prepareApproval(),
        fetch: deps.fetch,
        testApp: isTestPublishableKey(config.publishableKey),
      },
      evm,
    );

    this.#conn = new VaultConnection({
      win: deps.win,
      container: config.container ?? null,
      vaultOrigin: this.vaultOrigin,
      publishableKey: config.publishableKey,
      sdkVersion: VERSION,
      onEvent: (e) => this.#onEvent(e),
      onDisconnect: () => this.#onDisconnect(),
      now: this.#now,
    });
    this.#windows = new ApprovalWindows(deps.win, this.authOrigin, this.#conn.frameName, this.#now);
    this.ready = this.#conn.ready.then(
      (s) => this.#onReady(s),
      (e: unknown) => {
        const h = asHanaError(e);
        this.#vaultDown = true;
        this.#error = h;
        this.#setStatus('error');
        throw h;
      },
    );
    this.ready.catch(() => {});
    if (evm !== undefined) this.#stopEip6963 = announceEip6963(deps.win, this.ethereum, rdnsFor(this.authOrigin));
  }

  get status(): HanaStatus {
    return this.#status;
  }

  /** `{stellar, evm}` while logged in, else null. */
  get addresses(): HanaAddresses | null {
    return this.#addresses === null ? null : { ...this.#addresses };
  }

  /** When the session ends (ms since the epoch, server-corrected), while logged in. */
  get expiresAtMs(): number | null {
    return this.#expiresAtMs;
  }

  /** The app's persistence mode as the vault runs it ('none' after a storage fallback), once ready. */
  get persistence(): Persistence | null {
    return this.#persistence;
  }

  /** `storage_unavailable` when persistence fell back to 'none' (informational). */
  get warning(): 'storage_unavailable' | null {
    return this.#warning;
  }

  /** The last failure (vault_unavailable, a failed login, …); cleared by a successful login. */
  get error(): HanaError | null {
    return this.#error;
  }

  /** The last login's full result (pk_test_ apps also get per-stage `timings`). */
  get lastLogin(): LoginResult | null {
    return this.#lastLogin;
  }

  /**
   * pk_test_ apps: the handshake's (and, after a reload, the unlock's) per-stage ms, from createHana to `ready`
   * (`UNLOCK_TIMING_STAGES` and `UNLOCK_TIMING_DETAILS` in @hana-id/core). Null for pk_live_ apps and before `ready`.
   */
  get readyTimings(): Record<string, number> | null {
    return this.#readyTimings === null ? null : { ...this.#readyTimings };
  }

  /**
   * Logs in and resolves with the addresses. Call it synchronously in a click handler: the popup is opened before
   * anything else, so the browser's user activation still holds. Already logged in: resolves at once, no popup. A
   * blocked popup falls back to the vault's "Sign in with Hana" launcher, and the call resolves after that login.
   * A second call while one is pending supersedes it (the first rejects with `login_cancelled`).
   */
  login(): Promise<HanaAddresses> {
    if (this.#destroyed) return Promise.reject(hanaError(ErrorCode.disconnected));
    if (this.#vaultDown && this.#error) return Promise.reject(this.#error);
    if (this.#status === 'logged_in' && this.#addresses) return Promise.resolve({ ...this.#addresses });
    const calledAt = this.#now();
    const popup = openLoginPopup(this.#win, this.authOrigin, this.#conn.frameName);
    const openedAt = this.#now();
    this.#attempt?.supersede();
    const attempt = new LoginAttempt(
      { ready: () => this.#conn.ready, send: (m, p) => this.#conn.send(m, p) },
      popup,
      () => this.#status === 'logged_in' || (this.#status === 'logging_in' && this.#addresses !== null),
      this.#now,
    );
    this.#attempt = attempt;
    this.#setStatus('logging_in');
    return attempt.promise.then(
      (outcome) => {
        if (this.#attempt === attempt) this.#attempt = null;
        if (outcome.kind === 'login') this.#applyLogin(this.#withClientTimings(outcome.result, calledAt, openedAt, attempt));
        else if (this.#addresses) this.#setStatus('logged_in');
        if (!this.#addresses) throw hanaError(ErrorCode.unauthorized);
        return { ...this.#addresses };
      },
      (e: unknown) => {
        const h = asHanaError(e);
        if (this.#attempt === attempt) {
          this.#attempt = null;
          this.#error = h;
          this.#setStatus(this.#vaultDown ? 'error' : this.#addresses ? 'logged_in' : 'logged_out');
        }
        throw h;
      },
    );
  }

  /**
   * Opens the Hana approval popup now, inside the user's click, for a signing call that comes after an await (a quote
   * fetch, a chain switch): call it synchronously at the top of the click handler. The next signing request uses that
   * window. The signing methods do this themselves, so a handler that calls them before any await needs nothing else.
   * Opens nothing when logged out, without user activation, when the browser blocks it (the vault's launcher is then the
   * fallback) or when an approval popup is already open (it is reused). `cancel()` closes a window no request used.
   */
  prepareApproval(): ApprovalTicket {
    if (this.#destroyed || this.#status !== 'logged_in') return { cancel: () => {} };
    return this.#windows.prepare();
  }

  /** Ends a pending login: it rejects with `login_cancelled`, or `popup_blocked` if it was waiting on the launcher. */
  cancelLogin(): void {
    this.#attempt?.cancel();
  }

  async logout(): Promise<void> {
    await this.#request('hana_logout');
    this.#setAddresses(null);
    this.#expiresAtMs = null;
    if (this.#status !== 'logging_in') this.#setStatus('logged_out');
  }

  /** Starts a key export: the vault shows its launcher, and the key is shown only in a Hana window. */
  exportKey(chain: 'stellar' | 'evm'): Promise<null> {
    return this.#request('hana_export', { chain });
  }

  /** Revokes this user's shares on other devices; allowed within 5 min of a fresh login. */
  revokeOtherDevices(): Promise<{ revoked: number }> {
    return this.#request('hana_revokeOtherDevices');
  }

  /** Raw signing: 4100 unless the app enables it, and always behind an approval with the raw warning. */
  signRaw(params: SignRawParams): Promise<{ signature: Uint8Array }> {
    return this.#request('hana_signRaw', params);
  }

  /** Asks the user to accept the app's auto-approve policy (consent screen in a Hana popup); 4100 without a policy. */
  requestAutoApprove(): Promise<{ granted: boolean; policyId?: string; expiresAtMs?: number }> {
    return this.#request('hana_requestAutoApprove');
  }

  autoApproveStatus(): Promise<AutoApproveStatus | null> {
    return this.#request('hana_autoApproveStatus');
  }

  revokeAutoApprove(): Promise<null> {
    return this.#request('hana_revokeAutoApprove');
  }

  /** Removes the vault iframe and every listener; pending and later calls reject with 4900. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#attempt?.abort(hanaError(ErrorCode.disconnected));
    this.#attempt = null;
    this.#stopEip6963?.();
    this.#conn.destroy();
    this.removeAllListeners();
    this.ethereum.removeAllListeners();
  }

  #request<M extends PortMethod>(method: M, params?: PortParamsMap[M]): Promise<PortResultMap[M]> {
    if (this.#destroyed) return Promise.reject(hanaError(ErrorCode.disconnected));
    if (!isApprovalPopupMethod(method)) return this.#conn.request(method, params);
    // Synchronously, before the first await: a call from a click opens the approval popup in that click (D99).
    this.prepareApproval();
    const popupOpened = this.#windows.claim();
    return this.#conn.request(method, params, popupOpened ? { popupOpened } : undefined);
  }

  /**
   * A pk_test_ login's timings with this page's stages added (timings.ts): `open` (window.open), `wait` (until the
   * vault's handshake was done and hana_login sent) and `port` (the hana_login round trip minus the vault's own time).
   */
  #withClientTimings(r: LoginResult, calledAt: number, openedAt: number, attempt: LoginAttempt): LoginResult {
    if (!this.#testApp) {
      // pk_live_ apps never get timings (the vault sends none; this holds even if one did).
      const { timings: _drop, ...rest } = r;
      return rest;
    }
    if (!r.timings) return r;
    const rtt = attempt.repliedAt - attempt.sentAt;
    const vault = r.timings.vault ?? rtt;
    return {
      ...r,
      timings: { ...r.timings, open: Math.max(0, openedAt - calledAt), wait: Math.max(0, attempt.sentAt - openedAt), port: Math.max(0, rtt - vault) },
    };
  }

  /**
   * A pk_test_ app's `ready` timings with this page's stages added (timings.ts): `mount` (createHana → the iframe in the
   * document), `frameStart` (its load as seen here, minus the vault's own load stages) and `port` (iframe load → `ready`
   * minus the vault's own time after the hello).
   */
  #handshakeTimings(s: ReadyStatus): Record<string, number> | null {
    const marks = this.#conn.handshakeMarks;
    if (!this.#testApp || !s.timings || !marks) return null;
    const vaultLoad = VAULT_LOAD_STAGES.reduce((sum, k) => sum + (s.timings?.[k] ?? 0), 0);
    const roundTrip = marks.readyAt - marks.loadAt;
    return {
      ...s.timings,
      mount: Math.max(0, marks.appendedAt - this.#createdAt),
      frameStart: Math.max(0, marks.loadAt - marks.appendedAt - vaultLoad),
      port: Math.max(0, roundTrip - (s.timings.vault ?? roundTrip)),
    };
  }

  #onReady(s: ReadyStatus): void {
    this.#readyTimings = this.#handshakeTimings(s);
    this.#persistence = s.persistence;
    this.#warning = s.warning ?? null;
    if (s.status === 'logged_in' && s.addresses) {
      this.#expiresAtMs = s.expiresAtMs ?? null;
      this.#setAddresses(s.addresses);
    }
    if (this.#status === 'unlocking') this.#setStatus(this.#addresses ? 'logged_in' : 'logged_out');
    this.ethereum.connected();
  }

  #applyLogin(r: LoginResult): void {
    this.#lastLogin = r;
    this.#persistence = r.persistence;
    this.#warning = r.warning ?? this.#warning;
    this.#expiresAtMs = r.expiresAtMs;
    this.#error = null;
    this.#setAddresses(r.addresses);
    this.#setStatus('logged_in');
  }

  #onEvent(e: PortEvent): void {
    switch (e.event) {
      case 'ready':
        return; // handled through conn.ready
      case 'accountsChanged':
        this.#setAddresses(e.data.addresses);
        if (e.data.addresses === null) this.#expiresAtMs = null;
        if (this.#status === 'logged_in' || this.#status === 'logged_out') this.#setStatus(e.data.addresses ? 'logged_in' : 'logged_out');
        return;
      case 'disconnect':
        this.#loggedOut();
        this.emit('disconnect', { code: e.data.code });
        return;
      case 'sessionExpired':
        this.#loggedOut();
        this.emit('sessionExpired');
        return;
      case 'loginProgress':
        if (e.data.stage === 'popup_connected') this.#attempt?.connected();
        this.emit('loginProgress', e.data);
        return;
      case 'ui':
        this.emit('launcher', { visible: e.data.launcher === 'show', label: e.data.label });
        return;
      case 'approvalWindow':
        this.#windows.vaultWindowOpen = e.data.open;
        return;
      case 'autoApproved':
        this.emit('autoApproved', e.data);
        return;
      case 'persistenceChanged':
        if (this.#persistence === e.data.persistence) return;
        this.#persistence = e.data.persistence;
        this.emit('persistenceChanged', e.data.persistence);
        return;
    }
  }

  #loggedOut(): void {
    this.#setAddresses(null);
    this.#expiresAtMs = null;
    if (this.#status === 'logged_in') this.#setStatus('logged_out');
  }

  #onDisconnect(): void {
    this.#vaultDown = true;
    this.#attempt?.abort(hanaError(ErrorCode.disconnected));
    this.#attempt = null;
    this.#setAddresses(null);
    this.#expiresAtMs = null;
    if (!this.#destroyed) {
      this.#error = hanaError(ErrorCode.disconnected);
      this.#setStatus('error');
      this.emit('disconnect', { code: ErrorCode.disconnected });
      this.ethereum.disconnected();
    }
  }

  #setAddresses(next: HanaAddresses | null): void {
    const prev = this.#addresses;
    if (prev?.stellar === next?.stellar && prev?.evm === next?.evm) return;
    this.#addresses = next === null ? null : { stellar: next.stellar, evm: next.evm };
    this.emit('accountsChanged', next === null ? null : { ...next });
    this.ethereum.accountsChanged(next?.evm ?? null);
  }

  #setStatus(s: HanaStatus): void {
    if (this.#status === s) return;
    this.#status = s;
    this.emit('statusChanged', s);
  }
}

/** Logs each partner-page issue once per page (console.warn), so integrators see unsupported setups early. */
const warned = new Set<string>();
export function warnPartnerIssues(win: Window): void {
  for (const issue of partnerPageIssues(win)) {
    if (warned.has(issue.code)) continue;
    warned.add(issue.code);
    console.warn(`[Hana ID] ${issue.message}`);
  }
}
