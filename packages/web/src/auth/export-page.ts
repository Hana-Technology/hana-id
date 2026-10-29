// `GET {authOrigin}/export` (docs/batch-b-spec.md "Key export"): a top-level window the vault's launcher opens. It
// takes only public values from the vault (export-context), then, on the user's click, runs a fresh login of its own:
// its own session key (max_uses = 1), nonce and relay keys, a child login popup in export mode (Google with
// max_age=0), its own relay read, token check, /v1/login, CKD decrypt and derivation. It shows the key only if it
// imports as the vault's address, only after a typed confirmation and only while a button is held. The vault's cached
// PRK is never used, and no message in either direction carries key material.
//
// SECURITY: the key exists only in this window's memory, as the chain's private key bytes (PRK is zeroed as soon as
// they are derived). It is zeroed and the export ends (D111) at the first of: EXPORT_KEY_LIFETIME_MS (5 min) after
// it is derived, the vault session's end (the context's `sessionExpiresAtMs`, or `hana:export-end` from the vault on
// logout, revoke, expiry or a newer login), the vault frame going away, and the window closing. Exporting again
// needs a new window and a new Google sign-in. The Google token is dropped after /v1/login.
import {
  ApiError,
  type AppConfig,
  type CkdResult,
  EXPORT_MAX_AUTH_AGE_MS,
  type Jwk,
  type LoginBody,
  RELAY_KEY_BYTES,
  type RelayReadResponse,
  SALT_BYTES,
  type WindowMessage,
  addressOfExport,
  base64UrlEncode,
  chainPrivateKey,
  ckdAppId,
  decryptCkd,
  decryptRelayPayload,
  evmPrivateKeyHex,
  extractPrk,
  fetchGoogleJwks,
  jsonBytes,
  newAppKey,
  newSessionKey,
  parseWindowMessage,
  randomBytes,
  relayIdFor,
  sessionNonce,
  signDerive,
  stellarSecretSeed,
  verifyGoogleIdToken,
} from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { ChainLoginError, loginOnChain } from './chain-login.ts';
import { ServerClock } from './clock.ts';
import { type Dom, dom, errorView } from './dom.ts';
import { PageError, apiErrorCode, errorMessage } from './errors.ts';
import type { NearReader } from './near-rpc.ts';
import { type GestureCheck, type PageWindow, isFramed, isUserGesture, randomName } from './page-window.ts';

/** The export session's lifetime: it is used once, within minutes. */
export const EXPORT_SESSION_TTL_MS = 15 * 60_000;
/** How long the window waits for Google's answer in the relay. */
export const EXPORT_LOGIN_LIMIT_MS = 5 * 60_000;
/** What the user types to confirm. */
export const EXPORT_CONFIRMATION = 'EXPORT';
/** How long the derived key stays in this window (user decision 2026-10-29, D111); never past the session's end. */
export const EXPORT_KEY_LIFETIME_MS = 5 * 60_000;
/** How often the window checks its deadlines and that the vault frame is still there. */
export const EXPORT_CHECK_MS = 1_000;
const RELAY_WAIT_S = 25;
/** How often the child popup's `closed` is checked until it connects. */
const CHILD_WATCH_MS = 500;
const CHAIN_NAMES = { stellar: 'Stellar', evm: 'EVM' } as const;

/** Why an export ended without an error: the key deadline passed, the vault session ended, or the vault went away. */
export type ExportEndReason = 'expired' | 'session_ended' | 'vault_gone';

export const EXPORT_END_TEXT: Readonly<Record<ExportEndReason, string>> = Object.freeze({
  expired: 'Your key was erased from this window: it is kept for 5 minutes only.',
  session_ended: 'Your key was erased from this window because your session in the app ended (you signed out, or it expired).',
  vault_gone: 'Your key was erased from this window because the app’s Hana wallet closed.',
});

export interface ExportPageDeps {
  win: PageWindow;
  env: HanaEnv;
  api: AuthApi;
  near: NearReader;
  /** Google's keys by kid (default: fetched from Google's JWKS, refetched once on an unknown kid). */
  jwks?: (kid: string) => Promise<Jwk | null>;
  deviceNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isGesture?: GestureCheck;
}

export type ExportPageState = 'connecting' | 'ready' | 'signing_in' | 'confirm' | 'reveal' | 'ended' | 'error' | 'closed';

export interface ExportPage {
  readonly state: ExportPageState;
  readonly errorCode: string | null;
  /** Set when the state is `ended`. */
  readonly endReason: ExportEndReason | null;
  /** The child login popup's window name, once opened. */
  readonly childName: string | null;
  /** The export session is prepared and waits for the child popup's hello. */
  readonly awaitingChild: boolean;
  /** Resolves when the page reaches `confirm` or `error` after a sign-in (tests). */
  readonly settled: Promise<ExportPageState>;
}

/** Google's keys with one refetch on an unknown kid (key rotation). */
function googleKeys(): (kid: string) => Promise<Jwk | null> {
  let keys: Jwk[] | null = null;
  return async (kid) => {
    keys ??= await fetchGoogleJwks();
    let k = keys.find((j) => j.kid === kid);
    if (!k) {
      keys = await fetchGoogleJwks();
      k = keys.find((j) => j.kid === kid);
    }
    return k ?? null;
  };
}

/** The export string of a chain private key (StrKey S… or 0x + 64 hex). */
const exportString = (chain: 'stellar' | 'evm', key: Uint8Array): string => (chain === 'stellar' ? stellarSecretSeed(key) : evmPrivateKeyHex(key));

export function startExportPage(deps: ExportPageDeps): ExportPage {
  const { win, env, api, near } = deps;
  const clock = new ServerClock(deps.deviceNow);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isGesture = deps.isGesture ?? isUserGesture;
  const jwks = deps.jwks ?? googleKeys();
  const d: Dom = dom(win.document);
  const opener = win.opener;

  let state: ExportPageState = 'connecting';
  let errorCode: string | null = null;
  let context: WindowMessage<'hana:export-context'> | null = null;
  let app: AppConfig | null = null;
  let child: Window | null = null;
  let childName: string | null = null;
  /** The pending sign-in's secrets (memory only). */
  let pending: {
    relayId: string;
    relayKey: Uint8Array;
    relayReadKey: Uint8Array;
    params: WindowMessage<'hana:auth-params'>;
    keyPair: CryptoKeyPair;
    helloAccepted: boolean;
  } | null = null;
  /** The chain's private key bytes, after a verified login. */
  let key: Uint8Array | null = null;
  /** Server-clock ms past which the key is erased (D111): derivation + EXPORT_KEY_LIFETIME_MS, capped by the session. */
  let keyDeadline = Number.POSITIVE_INFINITY;
  let keyTimer: ReturnType<typeof setTimeout> | null = null;
  let checker: ReturnType<typeof setInterval> | null = null;
  let endReason: ExportEndReason | null = null;
  /** Blanks the revealed key on screen (set while the reveal step shows). */
  let blank: (() => void) | null = null;
  let settle: (s: ExportPageState) => void = () => {};
  const settled = new Promise<ExportPageState>((r) => {
    settle = r;
  });

  const stopTimers = () => {
    if (keyTimer !== null) clearTimeout(keyTimer);
    if (checker !== null) clearInterval(checker);
    keyTimer = null;
    checker = null;
  };

  const wipe = () => {
    key?.fill(0);
    key = null;
    if (pending) {
      pending.relayKey.fill(0);
      pending.relayReadKey.fill(0);
      pending.params.relayKey.fill(0);
      pending.params.salt.fill(0);
    }
    pending = null;
  };

  const finished = () => state === 'ended' || state === 'error' || state === 'closed';

  const fail = (code: string | number, message: string) => {
    if (finished()) return;
    wipe();
    stopTimers();
    state = 'error';
    errorCode = String(code);
    d.show(errorView(d, 'Export stopped', message, String(code)));
    settle(state);
  };

  /** Erases the key and ends the export for good (D111): a new export needs a new window and a new sign-in. */
  function end(reason: ExportEndReason): void {
    if (finished()) return;
    wipe();
    blank?.();
    blank = null;
    stopTimers();
    try {
      child?.close();
    } catch {
      // Already closed.
    }
    state = 'ended';
    endReason = reason;
    d.show(
      d.h(
        'section',
        { class: 'panel export', attrs: { role: 'status' } },
        d.h('h1', {}, 'Export ended'),
        d.h('p', {}, EXPORT_END_TEXT[reason]),
        d.h('p', { class: 'muted' }, 'To export again, start again from the app; you will sign in with Google again. You can close this window.'),
      ),
    );
    settle(state);
  }

  /** The session's end from the vault's context (server-corrected ms), when it sent one. */
  const sessionEnd = () => context?.sessionExpiresAtMs ?? Number.POSITIVE_INFINITY;

  /** Ends the export if a deadline passed or the vault frame is gone; true if it ended. */
  function check(): boolean {
    if (finished()) return true;
    const now = clock.now();
    if (key !== null && now >= keyDeadline) {
      end(now >= sessionEnd() ? 'session_ended' : 'expired');
      return true;
    }
    if (now >= sessionEnd()) {
      end('session_ended');
      return true;
    }
    let gone = false;
    try {
      gone = opener?.closed === true;
    } catch {
      gone = false;
    }
    if (gone) {
      end('vault_gone');
      return true;
    }
    return false;
  }

  function onMessage(event: Event): void {
    const e = event as MessageEvent;
    if (e.origin === env.vaultOrigin && e.source === opener && parseWindowMessage(e.data, ['hana:export-end'])) {
      end('session_ended');
      return;
    }
    if (state === 'connecting' && context === null) {
      if (e.origin !== env.vaultOrigin || e.source !== opener) return;
      const msg = parseWindowMessage(e.data, ['hana:export-context']);
      if (!msg) return;
      context = msg;
      void checkContext(msg);
      return;
    }
    if (pending && !pending.helloAccepted && child !== null && e.source === child && e.origin === env.authOrigin) {
      if (!parseWindowMessage(e.data, ['hana:auth-hello'])) return;
      pending.helloAccepted = true;
      try {
        child.postMessage(pending.params, env.authOrigin);
      } catch {
        fail('login_cancelled', 'The sign-in window closed. Try again.');
        return;
      } finally {
        // postMessage cloned it; this window keeps only pending.relayKey, for the decrypt.
        pending?.params.relayKey.fill(0);
      }
      void awaitToken();
    }
  }

  async function checkContext(msg: WindowMessage<'hana:export-context'>): Promise<void> {
    try {
      if (msg.signer !== env.signer) throw new PageError('config_mismatch', 'The vault named another signer.');
      try {
        app = await api.getApp(msg.pk, msg.parentOrigin);
      } catch (err) {
        const code = apiErrorCode(err);
        throw new PageError(code, errorMessage(code));
      }
      if (app.signer !== env.signer || app.scopeId !== msg.scopeId) throw new PageError('config_mismatch', 'The export request does not match this app’s settings.');
      clock.sync(app.serverTimeMs);
      if (finished()) return;
      checker = setInterval(check, EXPORT_CHECK_MS);
      if (check()) return;
      showReady();
    } catch (err) {
      const e = err instanceof PageError ? err : new PageError('config_mismatch', 'The export request could not be checked.');
      fail(e.code, e.message);
    }
  }

  function showReady(): void {
    const ctx = context as WindowMessage<'hana:export-context'>;
    state = 'ready';
    const start = d.h('button', { class: 'primary', attrs: { type: 'button' } }, 'Sign in with Google to continue');
    start.addEventListener('click', (e) => {
      if (!isGesture(e) || state !== 'ready') return;
      begin();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel export' },
        d.h('h1', {}, `Export your ${CHAIN_NAMES[ctx.chain]} key`),
        d.h('p', {}, 'For your wallet in ', d.h('strong', {}, app?.name ?? ctx.appName), ' at ', d.h('span', { class: 'origin' }, ctx.parentOrigin)),
        d.h('p', { class: 'account' }, 'Address ', d.h('code', { class: 'mono' }, ctx.address)),
        d.h(
          'p',
          { class: 'warn' },
          'Anyone with this key controls this address on every app and can take its funds. Hana never shows it anywhere else and can’t recover it for you if it leaks.',
        ),
        d.h('p', { class: 'muted' }, 'To be sure it’s you, sign in with Google again first.'),
        start,
      ),
    );
  }

  /**
   * The click: opens the child login popup synchronously, before any await (a popup opened after one loses the user
   * activation in some browsers), then prepares the session while the child loads. The child repeats its hello every
   * 100 ms, so a hello that arrives before the session is ready is simply answered by a later one.
   */
  function begin(): void {
    state = 'signing_in';
    childName = randomName('hana-login-');
    child = win.open(`${env.authOrigin}/login?mode=export`, childName, 'popup,width=480,height=640');
    if (!child) {
      state = 'ready';
      d.show(errorView(d, 'Sign-in window blocked', errorMessage('popup_blocked'), 'popup_blocked'));
      showRetry();
      return;
    }
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'Finish signing in with Google in the other window.')));
    const opened = child;
    // A child closed before it connected (the user closed it): offer a new attempt. After the hello the handle is not
    // watched, because Google's pages may make it report `closed` (COOP).
    const watch = setInterval(() => {
      if (child !== opened || state !== 'signing_in' || pending?.helloAccepted) {
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
        wipe();
        child = null;
        state = 'ready';
        d.show(errorView(d, 'Sign-in window closed', 'The sign-in window closed before it finished. Try again.', 'login_cancelled'));
        showRetry();
      }
    }, CHILD_WATCH_MS);
    void prepare(opened);
  }

  /** This window's own session for the export login: max_uses = 1, its own nonce and relay keys. */
  async function prepare(opened: Window): Promise<void> {
    const ctx = context as WindowMessage<'hana:export-context'>;
    const a = app as AppConfig;
    try {
      const sessionKey = await newSessionKey();
      const salt = randomBytes(SALT_BYTES);
      const relayKey = randomBytes(RELAY_KEY_BYTES);
      const relayReadKey = randomBytes(32);
      const relayId = relayIdFor(relayReadKey);
      const expiresAtMs = clock.now() + EXPORT_SESSION_TTL_MS;
      const nonceInput = { signer: env.signer, scopeId: ctx.scopeId, sessionPublicKey: sessionKey.publicKey, expiresAtMs, keyIndex: ctx.keyIndex, maxUses: 1, salt };
      const params: WindowMessage<'hana:auth-params'> = {
        v: 1,
        t: 'hana:auth-params',
        pk: ctx.pk,
        appName: a.name ?? ctx.appName,
        parentOrigin: ctx.parentOrigin,
        scopeId: ctx.scopeId,
        signer: env.signer,
        clientId: a.google.clientId,
        mode: a.google.mode,
        sessionPublicKey: sessionKey.publicKey,
        expiresAtMs,
        salt,
        keyIndex: ctx.keyIndex,
        maxUses: 1,
        nonce: sessionNonce(nonceInput),
        relayId,
        relayKey: Uint8Array.from(relayKey),
      };
      if (child !== opened || state !== 'signing_in') {
        relayKey.fill(0);
        relayReadKey.fill(0);
        salt.fill(0);
        return;
      }
      pending = { relayId, relayKey, relayReadKey, params, keyPair: sessionKey.keyPair, helloAccepted: false };
    } catch {
      fail('derive_failed', 'The export could not start.');
    }
  }

  function showRetry(): void {
    const again = d.h('button', { class: 'primary', attrs: { type: 'button' } }, 'Try again');
    again.addEventListener('click', (e) => {
      if (isGesture(e) && state === 'ready') begin();
    });
    (win.document.getElementById('app') ?? win.document.body).append(again);
  }

  /** Long-polls the relay with the read key, then checks the token and runs the login. */
  async function awaitToken(): Promise<void> {
    const p = pending;
    if (!p) return;
    const ctx = context as WindowMessage<'hana:export-context'>;
    const deadline = clock.now() + EXPORT_LOGIN_LIMIT_MS;
    const readKey = base64UrlEncode(p.relayReadKey);
    let value: RelayReadResponse | null = null;
    while (value === null) {
      if (pending !== p) return;
      if (clock.now() > deadline) return fail('login_timeout', errorMessage('login_timeout'));
      try {
        value = await api.readRelay(p.relayId, readKey, RELAY_WAIT_S);
      } catch (err) {
        // 410 relay_gone (consumed or expired) and 403 relay_forbidden never recover; anything else is retried.
        if (err instanceof ApiError && (err.status === 410 || err.status === 403)) return fail('token_invalid', errorMessage('token_invalid'));
        await sleep(1000);
      }
    }
    if (pending !== p) return;
    clock.sync(value.serverTimeMs);
    try {
      child?.close();
    } catch {
      // Already closed.
    }

    let idToken: string | null = null;
    try {
      const payload = await decryptRelayPayload(p.relayKey, p.relayId, value).catch(() => {
        throw new PageError('token_invalid', errorMessage('token_invalid'));
      });
      if ('error' in payload) throw new PageError('google_error', `${errorMessage('google_error')} (${payload.error})`);
      idToken = payload.idToken;
      const checked = await verifyGoogleIdToken(idToken, { clientId: p.params.clientId, nonce: p.params.nonce, nowMs: clock.now(), jwks }).catch(() => {
        throw new PageError('api_unavailable', 'Google’s keys could not be read. Try again.');
      });
      if (!checked.ok) throw new PageError(checked.code, errorMessage(checked.code));
      // Google sends no auth_time today even with max_age=0 (Q33), so its absence is accepted; when present it must be
      // fresh, which is what max_age=0 asks for.
      if (checked.token.authTime !== null && checked.token.authTime * 1000 < clock.now() - EXPORT_MAX_AUTH_AGE_MS) {
        throw new PageError('token_invalid', 'Google did not ask you to sign in again. Try again.');
      }
      const path = `${ctx.scopeId}#google#${checked.token.sub}#${ctx.keyIndex}`;

      const appKey = newAppKey();
      const { pk1, pk2 } = appKey.publicKey.AppPublicKeyPV;
      const signature = await signDerive(p.keyPair.privateKey, 1, pk1, pk2);
      const body: LoginBody = {
        jwt: idToken,
        sessionPublicKey: jsonBytes(p.params.sessionPublicKey),
        expiresAtMs: p.params.expiresAtMs,
        salt: jsonBytes(p.params.salt),
        keyIndex: p.params.keyIndex,
        maxUses: 1,
        signature: jsonBytes(signature),
        pk1,
        pk2,
      };
      idToken = null;
      let result: CkdResult;
      try {
        result = await loginOnChain(body, {
          login: (b) => api.login(ctx.pk, ctx.parentOrigin, b),
          near,
          signer: env.signer,
          relayer: env.relayer,
          scopeId: ctx.scopeId,
          expectedPath: path,
          sessionPublicKey: p.params.sessionPublicKey,
          maxUses: 1,
          resendableUntil: checked.token.exp * 1000,
          now: () => clock.now(),
          sleep,
        });
      } catch (err) {
        if (err instanceof ChainLoginError) throw new PageError(err.code, errorMessage(err.code));
        throw err;
      } finally {
        body.jwt = '';
      }
      if (pending !== p) return;

      let s: Uint8Array;
      try {
        s = decryptCkd(result, appKey.a, ckdAppId(env.signer, path), env.ckdNetworkKey);
      } catch {
        throw new PageError('pairing_failed', errorMessage('pairing_failed'));
      }
      const prk = extractPrk(s);
      let chainKey: Uint8Array;
      try {
        chainKey = chainPrivateKey(prk, ctx.chain, 0);
      } finally {
        prk.fill(0);
      }
      let address: string;
      try {
        address = addressOfExport(ctx.chain, exportString(ctx.chain, chainKey));
      } catch {
        chainKey.fill(0);
        throw new PageError('derive_failed', errorMessage('derive_failed'));
      }
      if (address !== ctx.address) {
        chainKey.fill(0);
        throw new PageError('address_mismatch', errorMessage('address_mismatch'));
      }
      if (finished()) {
        chainKey.fill(0);
        return;
      }
      key = chainKey;
      p.relayKey.fill(0);
      p.relayReadKey.fill(0);
      // The key's deadline (D111): a timer, which device clock changes can't move, and the server-clock check.
      keyDeadline = Math.min(clock.now() + EXPORT_KEY_LIFETIME_MS, sessionEnd());
      keyTimer = setTimeout(() => end(clock.now() >= sessionEnd() ? 'session_ended' : 'expired'), Math.max(0, keyDeadline - clock.now()));
      if (check()) return;
      showConfirm();
    } catch (err) {
      idToken = null;
      const e = err instanceof PageError ? err : new PageError('derive_failed', errorMessage('derive_failed'));
      fail(e.code, e.message);
    }
  }

  function showConfirm(): void {
    state = 'confirm';
    const input = d.h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${EXPORT_CONFIRMATION}` } });
    const go = d.h('button', { class: 'primary', attrs: { type: 'button' } }, 'Continue');
    go.disabled = true;
    input.addEventListener('input', () => {
      go.disabled = input.value !== EXPORT_CONFIRMATION;
    });
    go.addEventListener('click', (e) => {
      if (isGesture(e) && input.value === EXPORT_CONFIRMATION && key && !check()) showReveal();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel export' },
        d.h('h1', {}, 'Signed in'),
        d.h('p', {}, 'Your key is ready. Make sure nobody can see your screen, and never paste the key into a site or share it with anyone, including Hana.'),
        d.h('label', {}, `Type ${EXPORT_CONFIRMATION} to continue`, input),
        go,
      ),
    );
    settle(state);
  }

  function showReveal(): void {
    const ctx = context as WindowMessage<'hana:export-context'>;
    state = 'reveal';
    // No aria-live (AUTH-6): a screen reader reads the key only when the user moves to it, never on its own; and
    // translate="no", so a page translator never sends it anywhere (AUTH-4).
    const out = d.h('code', { class: 'secret mono', attrs: { translate: 'no' } }, '••••••••');
    const hold = d.h('button', { class: 'primary hold', attrs: { type: 'button' } }, 'Hold to show the key');
    const hide = () => {
      out.textContent = '••••••••';
    };
    blank = hide;
    const reveal = (e: Event) => {
      if (!isGesture(e) || !key || check()) return;
      out.textContent = exportString(ctx.chain, key);
    };
    hold.addEventListener('pointerdown', reveal);
    for (const t of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(t, hide);
    hold.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === ' ' || (e as KeyboardEvent).key === 'Enter') reveal(e);
    });
    hold.addEventListener('keyup', hide);
    win.addEventListener('blur', hide);
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'hidden') hide();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel export' },
        d.h('h1', {}, `Your ${CHAIN_NAMES[ctx.chain]} key`),
        d.h('p', { class: 'account' }, 'For ', d.h('code', { class: 'mono' }, ctx.address)),
        out,
        hold,
        d.h('p', { class: 'muted' }, 'Close this window when you are done. The key is erased when it closes, 5 minutes after you signed in, or when your session in the app ends.'),
      ),
    );
  }

  // A tab coming back from the background checks at once (its interval may have been throttled while hidden).
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') check();
  });

  win.addEventListener('pagehide', () => {
    stopTimers();
    wipe();
    try {
      child?.close();
    } catch {
      // Already closed.
    }
    state = 'closed';
  });

  if (isFramed(win)) {
    fail('config_mismatch', 'The Hana export window can’t run inside another page.');
  } else if (!opener) {
    fail('config_mismatch', 'Open the export from the Hana prompt in the app.');
  } else {
    win.addEventListener('message', onMessage);
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Export your key'), d.h('p', { class: 'muted' }, 'Connecting to your wallet…')));
    try {
      opener.postMessage({ v: 1, t: 'hana:export-hello' }, env.vaultOrigin);
    } catch {
      fail('vault_unavailable', 'The app’s Hana vault is gone. Close this window and start again from the app.');
    }
  }

  return {
    get state() {
      return state;
    },
    get errorCode() {
      return errorCode;
    },
    get endReason() {
      return endReason;
    },
    get childName() {
      return childName;
    },
    get awaitingChild() {
      return pending !== null && !pending.helloAccepted;
    },
    settled,
  };
}
