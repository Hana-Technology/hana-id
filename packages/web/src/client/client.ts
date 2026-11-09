// `createHana`, the partner client (docs/batch-b-spec.md "Partner client"):
//
//   const hana = createHana({ publishableKey: 'pk_test_…', environment: 'sandbox-dev', evm?, stellar?, container? });
//   await hana.ready;            // handshake done, status known (an unlock has run); rejects vault_unavailable (vault-connection.ts)
//   hana.status;                 // 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error'
//   hana.on('statusChanged' | 'accountsChanged' | 'sessionExpired' | 'disconnect', cb);
//   hana.login();                // call synchronously in a click handler
//   hana.prepareApproval();      // in a click handler, before awaiting a quote: opens the approval popup now (D99)
//   hana.logout(); hana.exportKey(chain); hana.revokeOtherDevices();
//   await hana.getIdentityToken();  // a short-lived JWT for the partner's backend, or null (no popup; any handler)
//   hana.stellar; hana.ethereum; hana.signRaw(params);
//
// The client holds no key material and no token: it mounts the vault iframe (vault-connection.ts), opens the login
// popup (login.ts) and, inside the user's click, the approval popup for signing requests (approval-window.ts, D99),
// and relays requests over the port. Everything it learns is public (addresses, expiry, status, the user's Support ID).
// Beyond the spec's list it also exposes cancelLogin() (the port's hana_cancelLogin), the auto-approve port methods,
// destroy() (React's HanaProvider unmount), and the `loginProgress`, `autoApproved` and `launcher` events.
import {
  ErrorCode,
  IDENTITY_MAX_MAX_AGE_MS,
  IDENTITY_MIN_MAX_AGE_MS,
  UNLOCK_TIMING_STAGES,
  isApprovalPopupMethod,
  type AccountResult,
  type AutoApproveStatus,
  type LinkChange,
  type LoginMethod,
  type LoginResult,
  type MainnetDemoState,
  type Persistence,
  type PortEvent,
  type PortEventMap,
  type PortMethod,
  type PortParamsMap,
  type PortResultMap,
  isPublishableKey,
  isTestPublishableKey,
} from '@hana-id/core';
import { MAINNET_DEMO_ASSETS, type MainnetDemoAsset, type MainnetDemoPriceBook, type MainnetDemoPriceSource, usdMicrosToString } from '@hana-id/core/mainnet-demo-prices';
import { VERSION } from '../version.ts';
import { type ApprovalTicket, ApprovalWindows } from './approval-window.ts';
import { Emitter } from './emitter.ts';
import { HanaError, RpcCode, asHanaError, hanaError } from './errors.ts';
import { type EvmConfig, HanaEthereumProvider, announceEip6963, rdnsFor, validateEvmConfig } from './ethereum.ts';
import { LoginAttempt, type LoginOptions, loginRequest, openLoginPopup } from './login.ts';
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
   * `persistence` changed after login: 'none' when the vault could not save the session for reloads. The wallet
   * keeps working on this page; the next page load needs a new login.
   */
  persistenceChanged: [Persistence];
  /**
   * The identity token changed: a new one was minted (here or in another tab of the session), or null once the
   * session ended (logout, expiry, revocation, a newer login).
   */
  identityTokenChanged: [string | null];
  /**
   * `supportId` changed: the user's Support ID arrived with a login or a restored session, or went (null) with the
   * session.
   */
  supportIdChanged: [string | null];
  /**
   * A sign-in method of the wallet was added (`pending` until `effectiveAtMs`, or `active`), became active, or was
   * removed. Show pending ones to the user with a way to cancel: the mailbox of
   * a pending email may not be theirs.
   */
  linkChanged: [LinkChange];
  /**
   * Hana's mainnet demo for this test app changed: on with its rules and prices, or off (null). Only a sandbox build of
   * Hana's vault sends it, for apps Hana staff switched on; `hana.mainnetDemo` holds the latest. It fires again when
   * the prices change.
   */
  mainnetDemoChanged: [MainnetDemo | null];
}

/** The vault's price book as a page reads it. */
function demoPricesForPage(book: MainnetDemoPriceBook): MainnetDemoPrices {
  const assets = Object.fromEntries(MAINNET_DEMO_ASSETS.map((a) => [a, { usd: usdMicrosToString(BigInt(book.assets[a].usdMicros)), usdMicros: book.assets[a].usdMicros, source: book.assets[a].source }])) as MainnetDemoPrices['assets'];
  return { source: MAINNET_DEMO_ASSETS.every((a) => book.assets[a].source === 'live') ? 'live' : 'fixed', atMs: book.atMs, assets };
}

/** One asset's price as the vault values it. */
export interface MainnetDemoPrice {
  /** USD per whole unit, as a decimal string: `"2251.7985"`. */
  usd: string;
  /** The same in millionths of a dollar, in decimal, for exact arithmetic. */
  usdMicros: string;
  /** `live`: from Hana's price feed; `fixed`: Hana's reviewed table, used when no live price is available for the asset. */
  source: MainnetDemoPriceSource;
}

/** The prices the vault values requests with. */
export interface MainnetDemoPrices {
  /** `live` only when every asset's price is live; check each asset's `source` for the detail. */
  source: MainnetDemoPriceSource;
  /** The time (ms) of the oldest live price, or null when every asset is on the fixed table. */
  atMs: number | null;
  assets: Record<MainnetDemoAsset, MainnetDemoPrice>;
}

/**
 * Hana's mainnet demo for this test app: the mainnets it may sign on, the per-transaction cap and the prices in force.
 * The vault values each request itself with exactly these prices, and refuses one over the cap (4100
 * `mainnet_demo_over_cap`, `data.usd` and `data.capUsd` strings such as `"$12.40"`) or one it can't value
 * (`mainnet_demo_unknown_call`, `mainnet_demo_unpriced`). Your page can aim under the cap: value the amount, plus the
 * transaction's maximum fee in the native asset, at `prices`, and compare with `txCapUsd`.
 */
export interface MainnetDemo extends MainnetDemoState {
  /** The cap in dollars, `"9.99"`. */
  txCapUsd: string;
  /** The prices in force, or null while the vault hasn't sent them (a vault older than this SDK). */
  prices: MainnetDemoPrices | null;
}

export interface IdentityTokenOptions {
  /**
   * A token minted at most this long ago, else a fresh one (a partner backend checking `iat` for a sensitive action).
   * At least 30 s (smaller values count as 30 s), at most 1 h.
   */
  maxAgeMs?: number;
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
  #supportId: string | null = null;
  #persistence: Persistence | null = null;
  #warning: 'storage_unavailable' | null = null;
  #error: HanaError | null = null;
  #lastLogin: LoginResult | null = null;
  #readyTimings: Record<string, number> | null = null;
  #identity: { token: string; expiresAtMs: number } | null = null;
  readonly #now: () => number;
  readonly #createdAt: number;
  readonly #testApp: boolean;
  #attempt: LoginAttempt | null = null;
  #destroyed = false;
  /** The handshake failed or the port died: status stays 'error'. */
  #vaultDown = false;
  #stopEip6963: (() => void) | null = null;
  /** The vault's latest `mainnetDemo` announcement, or null. */
  #mainnetDemo: MainnetDemo | null = null;
  /** The vault's latest price book, kept apart so the announcement can arrive on either side of it. */
  #mainnetDemoPrices: MainnetDemoPrices | null = null;
  /** Whether `ready` resolved: the vault has said whatever it was going to say about the demo. */
  #mainnetDemoKnown = false;
  readonly #windows: ApprovalWindows;

  constructor(config: HanaConfig, deps: HanaClientDeps) {
    super();
    this.#now = deps.now ?? (() => performance.now());
    this.#createdAt = this.#now();
    if (typeof config !== 'object' || config === null) throw new TypeError('createHana takes a config object');
    if (!isPublishableKey(config.publishableKey)) throw new TypeError('publishableKey must be a pk_test_… or pk_live_… key');
    // A live app's RPC, Horizon and Soroban RPC URLs must be https (loopback excepted, D115).
    const live = !isTestPublishableKey(config.publishableKey);
    const evm = config.evm === undefined ? undefined : validateEvmConfig(config.evm, live);
    const stellar = config.stellar === undefined ? undefined : validateStellarConfig(config.stellar, live);
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
        // The mainnet demo (D428): exactly the EVM mainnets the vault said this app may use, else none.
        demoEvmChains: () => this.#mainnetDemo?.evmChains ?? [],
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
      onDisconnect: (launcherWasVisible) => this.#onDisconnect(launcherWasVisible),
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

  /** True for a `pk_test_` key: test networks only, and plaintext http RPC URLs allowed (the adapters read it). */
  get testApp(): boolean {
    return this.#testApp;
  }

  /**
   * Hana's mainnet demo for this test app, as the vault stated it, or null: not on, or not known yet (tell those apart
   * with `mainnetDemoKnown`). See MainnetDemo; `mainnetDemoChanged` tells you when it changes.
   */
  get mainnetDemo(): MainnetDemo | null {
    return this.#mainnetDemo;
  }

  /**
   * True once `ready` has resolved. Until then a null `mainnetDemo` means "not known yet"; after it, null means the
   * demo is off for this app. It stays false if the vault never connected.
   */
  get mainnetDemoKnown(): boolean {
    return this.#mainnetDemoKnown;
  }

  /** `{stellar, evm}` while logged in, else null. */
  get addresses(): HanaAddresses | null {
    return this.#addresses === null ? null : { ...this.#addresses };
  }

  /** When the session ends (ms since the epoch, server-corrected), while logged in. */
  get expiresAtMs(): number | null {
    return this.#expiresAtMs;
  }

  /**
   * The logged-in user's Support ID (`HANA-XXXX-XXXX`), or null: logged out, or the session has none (an API that
   * couldn't compute it, or a session saved by an older vault). The short form of the identity token's `sub`, the same
   * in every app of your scope; it carries no address or email. Show it where your users look for help, put it in your
   * diagnostics, and give it to Hana with the request IDs when you escalate.
   */
  get supportId(): string | null {
    return this.#supportId;
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

  /** The last identity token this page received (getIdentityToken or identityTokenChanged), or null. */
  get identityToken(): string | null {
    return this.#identity?.token ?? null;
  }

  /** When that token expires (ms since the epoch), or null. */
  get identityTokenExpiresAtMs(): number | null {
    return this.#identity?.expiresAtMs ?? null;
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
   *
   * `options.method` ('google' | 'email') opens that method directly; without it, an app with email on shows the
   * popup's chooser ("Continue with Google", "Continue with email"). `options.emailHint` prefills the email field.
   */
  login(options?: LoginOptions): Promise<HanaAddresses> {
    if (this.#destroyed) return Promise.reject(hanaError(ErrorCode.disconnected));
    const request = loginRequest(options);
    if (request instanceof HanaError) return Promise.reject(request);
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
      request,
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
    this.#setIdentity(null);
    this.#setAddresses(null);
    this.#expiresAtMs = null;
    this.#setSupportId(null);
    if (this.#status !== 'logging_in') this.#setStatus('logged_out');
  }

  /**
   * The wallet's sign-in methods: its own (`root: true`) and the ones linked to it, each
   * `active` or `pending` until `effectiveAtMs`. No identifiers or addresses. Rejects 4100 when logged out.
   */
  account(): Promise<AccountResult> {
    return this.#request('hana_account');
  }

  /**
   * Adds a sign-in method to the wallet (`'google'` or `'email'`). Call it synchronously in a
   * click handler, like login(): the Hana popup signs in the new method, then the wallet's own, and the link waits
   * `change_delay_ms` (24 h on mainnet) before it opens the wallet; it resolves with `{provider, status: 'pending',
   * effectiveAtMs}`. Rejects with `link_refused` (`data.reason`) when the methods can't be linked.
   */
  linkAccount(options: { method: LoginMethod }): Promise<LinkChange> {
    if (this.#destroyed) return Promise.reject(hanaError(ErrorCode.disconnected));
    const method = typeof options === 'object' && options !== null ? (options as { method?: unknown }).method : undefined;
    if (method !== 'google' && method !== 'email') return Promise.reject(hanaError(RpcCode.invalidParams, "method must be 'google' or 'email'"));
    if (this.#status !== 'logged_in') return Promise.reject(hanaError(ErrorCode.unauthorized));
    const popup = openLoginPopup(this.#win, this.authOrigin, this.#conn.frameName);
    return this.#request('hana_linkAccount', { method, ...(popup ? {} : { popupBlocked: true }) }).catch((e: unknown) => {
      try {
        popup?.close();
      } catch {
        // A COOP-severed handle: nothing to do.
      }
      throw e;
    });
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

  /**
   * The partner identity token: an ES256 JWT for this app that the partner's
   * backend verifies against Hana's JWKS. Resolves null while logged out (never rejects for that). Silent: no popup, no
   * user activation needed, and it doesn't count as activity. The vault caches the token across this session's tabs
   * and mints a new one when less than 5 min remain or the cached one is older than `maxAgeMs`. Rejects with
   * `identity_unavailable` (retryable), `session_ended` (the session is over; `sessionExpired` fires too) or
   * `rate_limited`.
   */
  async getIdentityToken(opts: IdentityTokenOptions = {}): Promise<string | null> {
    if (this.#destroyed) throw hanaError(ErrorCode.disconnected);
    if (typeof opts !== 'object' || opts === null) throw new TypeError('getIdentityToken takes an options object');
    let maxAgeMs: number | undefined;
    if (opts.maxAgeMs !== undefined) {
      if (typeof opts.maxAgeMs !== 'number' || !Number.isFinite(opts.maxAgeMs) || opts.maxAgeMs <= 0) {
        throw hanaError(RpcCode.invalidParams, 'maxAgeMs must be a positive number of milliseconds');
      }
      maxAgeMs = Math.min(IDENTITY_MAX_MAX_AGE_MS, Math.max(IDENTITY_MIN_MAX_AGE_MS, Math.ceil(opts.maxAgeMs)));
    }
    const r = await this.#request('hana_identityToken', maxAgeMs === undefined ? undefined : { maxAgeMs });
    this.#setIdentity(r.identityToken === null || r.expiresAtMs === null ? null : { token: r.identityToken, expiresAtMs: r.expiresAtMs });
    return r.identityToken;
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
   * document), `retry` (only after a retry: the first iframe → the one that answered), `frameStart` (its load as seen
   * here, minus the vault's own load stages) and `port` (iframe load → `ready` minus the vault's own time after the
   * hello).
   */
  #handshakeTimings(s: ReadyStatus): Record<string, number> | null {
    const marks = this.#conn.handshakeMarks;
    if (!this.#testApp || !s.timings || !marks) return null;
    const vaultLoad = VAULT_LOAD_STAGES.reduce((sum, k) => sum + (s.timings?.[k] ?? 0), 0);
    const roundTrip = marks.readyAt - marks.loadAt;
    return {
      ...s.timings,
      mount: Math.max(0, marks.firstAppendedAt - this.#createdAt),
      ...(marks.appendedAt > marks.firstAppendedAt ? { retry: marks.appendedAt - marks.firstAppendedAt } : {}),
      frameStart: Math.max(0, marks.loadAt - marks.appendedAt - vaultLoad),
      port: Math.max(0, roundTrip - (s.timings.vault ?? roundTrip)),
    };
  }

  #onReady(s: ReadyStatus): void {
    this.#mainnetDemoKnown = true;
    this.#readyTimings = this.#handshakeTimings(s);
    this.#persistence = s.persistence;
    this.#warning = s.warning ?? null;
    if (s.status === 'logged_in' && s.addresses) {
      this.#expiresAtMs = s.expiresAtMs ?? null;
      this.#setSupportId(s.supportId ?? null);
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
    this.#setSupportId(r.supportId ?? null);
    this.#error = null;
    this.#setAddresses(r.addresses);
    this.#setStatus('logged_in');
  }

  /**
   * After the vault switched to another session on its own (a login in another tab of this app): the Support ID is
   * read again with hana_status, and kept only if the vault still reports the same addresses.
   */
  #refreshSupportId(addresses: HanaAddresses): void {
    this.#conn.request('hana_status').then(
      (st) => {
        const now = this.#addresses;
        if (st.status === 'logged_in' && now && st.addresses?.stellar === now.stellar && st.addresses.evm === now.evm && now.stellar === addresses.stellar) this.#setSupportId(st.supportId ?? null);
      },
      () => {},
    );
  }

  #onEvent(e: PortEvent): void {
    switch (e.event) {
      case 'connected':
      case 'ready':
        return; // handled through conn.ready
      case 'accountsChanged': {
        const prev = this.#addresses;
        const next = e.data.addresses;
        const changed = prev?.stellar !== next?.stellar || prev?.evm !== next?.evm;
        // Another session's addresses: its Support ID isn't known until hana_status says (a login's own result sets
        // it right after this event, which the refresh then confirms).
        if (changed) this.#setSupportId(null);
        this.#setAddresses(next);
        if (next === null) this.#expiresAtMs = null;
        else if (changed) this.#refreshSupportId(next);
        if (this.#status === 'logged_in' || this.#status === 'logged_out') this.#setStatus(e.data.addresses ? 'logged_in' : 'logged_out');
        return;
      }
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
      case 'identityTokenChanged':
        this.#setIdentity(e.data.identityToken === null || e.data.expiresAtMs === null ? null : { token: e.data.identityToken, expiresAtMs: e.data.expiresAtMs });
        return;
      case 'linkChanged':
        this.emit('linkChanged', e.data);
        return;
      case 'mainnetDemoPrices':
        if (!this.#testApp) return;
        this.#mainnetDemoPrices = demoPricesForPage(e.data);
        if (this.#mainnetDemo) this.#setMainnetDemo({ ...this.#mainnetDemo, prices: this.#mainnetDemoPrices });
        return;
      case 'mainnetDemo': {
        // Only a test app's vault may say so (a live app's mainnets need no exception).
        if (!this.#testApp) return;
        const d = e.data;
        if (d === null) this.#mainnetDemoPrices = null;
        this.#setMainnetDemo(d === null ? null : { ...d, evmChains: [...d.evmChains], txCapUsd: (Number(BigInt(d.txCapUsdMicros) / 10_000n) / 100).toFixed(2), prices: this.#mainnetDemoPrices });
        return;
      }
    }
  }

  #setMainnetDemo(next: MainnetDemo | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.#mainnetDemo)) return;
    this.#mainnetDemo = next;
    this.emit('mainnetDemoChanged', next);
  }

  /** Records the current identity token and emits identityTokenChanged when it is a different one. */
  #setIdentity(next: { token: string; expiresAtMs: number } | null): void {
    if ((this.#identity?.token ?? null) === (next?.token ?? null)) return;
    this.#identity = next;
    this.emit('identityTokenChanged', next?.token ?? null);
  }

  #loggedOut(): void {
    this.#setIdentity(null);
    this.#setAddresses(null);
    this.#expiresAtMs = null;
    this.#setSupportId(null);
    if (this.#status === 'logged_in') this.#setStatus('logged_out');
  }

  #onDisconnect(launcherWasVisible: boolean): void {
    this.#vaultDown = true;
    // The connection hid the frame; tell a partner that mirrors the launcher (PART-1).
    if (launcherWasVisible && !this.#destroyed) this.emit('launcher', { visible: false, label: '' });
    this.#attempt?.abort(hanaError(ErrorCode.disconnected));
    this.#attempt = null;
    this.#setIdentity(null);
    this.#setAddresses(null);
    this.#expiresAtMs = null;
    this.#setSupportId(null);
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

  #setSupportId(next: string | null): void {
    if (this.#supportId === next) return;
    this.#supportId = next;
    this.emit('supportIdChanged', next);
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
