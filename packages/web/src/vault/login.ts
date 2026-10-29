// A pending login, vault side (docs/batch-b-spec.md "Login" steps 2 and 7–10, "Failure handling").
//
//  2. The vault makes a non-extractable Ed25519 session key, salt, expiresAtMs (server-corrected clock), keyIndex 0,
//     maxUses (1 for 'session', 2 for 'none'), the A.2 nonce over the pinned SIGNER and the inlined scopeId, relayKey,
//     relayReadKey and relayId = b64url(sha256(relayReadKey)).
//  3. It answers one hana:auth-hello from authOrigin whose source is the right window for the opener mode (partner:
//     `source.opener === window.parent`; vault: the window its launcher opened) with hana:auth-params.
//  7. It long-polls the relay with the read key, decrypts the slot with relayKey, and checks the token (RS256 against
//     Google's JWKS, iss, aud, nonce, exp/iat on the corrected clock, the claim allow-list, sub).
//  8. It fixes `expectedPath = scopeId#google#sub#keyIndex`, the only path it ever uses for this session. Before the
//     chain step it has also checked the inlined scopeId against the on-chain registry (docs/batch-b-spec.md Q7): one
//     view through the manifest RPC, started as soon as GET /v1/app answers so it runs while the user is at Google.
//     Own client: `scope_for_client('google', clientId)` must be the scopeId; shared client: `get_scope(scopeId)` must
//     exist and allow shared login. A mismatch is `config_mismatch` (reason `scope_mismatch`); no answer from either
//     RPC endpoint is `api_unavailable` (reason `scope_unchecked`). Nothing is relayed in either case.
//  9. It runs POST /v1/login and, on failure, recovers exactly as the "Failure handling" table says, re-syncing from
//     NEAR directly (never from the API).
// 10. It decrypts the CKD with the pairing check against the pinned key for ckdAppId(SIGNER, path), extracts PRK
//     (zeroing S) and derives the addresses.
//
// SECURITY: the session key never leaves the vault (non-extractable); relayKey goes only to the authenticated login
// popup on authOrigin; relayReadKey never leaves the vault; the token, S and the BLS scalar `a` live only in this
// function's scope. Nothing is logged.
import {
  ApiError,
  type AppConfig,
  type Bytes,
  type CkdResult,
  type Jwk,
  type LoginBody,
  type SessionKey,
  type SessionView,
  ckdAppId,
  decryptCkd,
  decryptRelayPayload,
  newAppKey,
  newSessionKey,
  randomBytes,
  relayIdFor,
  sessionNonce,
  signDerive,
  verifyGoogleIdToken,
  zero,
} from '@hana-id/core';
import { type Addresses, deriveAddresses, extractPrk } from '@hana-id/core/derivation';
import type { HanaEnv } from '../hana-env.ts';
import type { VaultApi } from './api.ts';
import { type Persistence, SESSION_TTL_CAP_MS, type VaultConfig } from './config.ts';
import { VaultError, apiErrorToVault } from './errors.ts';
import { type NearView, ckdResultOf } from './near.ts';
import { type Clock, type Timers, type WindowMessageEvent, type WindowRef, sleep } from './runtime.ts';

/** The pending login ends after this long without finishing (`login_timeout`, stage 'pending'). */
export const LOGIN_PENDING_MS = 5 * 60_000;
export const KEY_INDEX = 0;
/** The relay long-poll's wait, in seconds (the API's maximum). */
export const RELAY_WAIT_S = 25;
/** How long an unknown-outcome transaction is polled before the vault re-syncs. */
export const TX_POLL_FOR_MS = 120_000;
export const TX_POLL_EVERY_MS = 2_000;
/** 503 relayer_unavailable without a transaction: wait this long, then re-sync. */
export const RELAYER_UNAVAILABLE_WAIT_MS = 3_000;
/** The API's relay codes for "not executed" (apps/api/src/handlers.ts NOT_EXECUTED): safe to resend once. */
export const NOT_EXECUTED: ReadonlySet<string> = new Set(['method_not_allowed', 'relayer_unconfigured', 'near_unavailable', 'near_rejected', 'relayer_busy']);
/** A resend needs the token and the session expiry to stay valid for at least this long. */
const RESEND_MARGIN_MS = 30_000;

export type LoginMode = 'partner' | 'vault';
export type LoginStage = 'popup_connected' | 'google' | 'token' | 'chain' | 'done';

export interface LoginContext {
  env: HanaEnv;
  config: VaultConfig;
  parentOrigin: string;
  /** The vault's effective persistence ('none' when storage is unavailable). */
  persistence: Persistence;
  api: VaultApi;
  near: NearView;
  clock: Clock;
  timers: Timers;
  /** Google's key for a kid (may refetch on an unknown kid); throws when Google can't be reached. */
  jwks(kid: string): Promise<Jwk | null>;
  /** GET /v1/app, cached; throws its ApiError. */
  appConfig(): Promise<AppConfig>;
  /** window.parent (partner mode authenticates the popup by its opener). */
  parentWindow: unknown;
  progress(stage: LoginStage): void;
  /** The split fallback (/v1/sessions then /v1/derive counter 1) until the ship gate decides. */
  flow: 'combined' | 'split';
  /** Device time for per-stage timings (pk_test_ apps only). */
  deviceNow(): number;
}

export interface LoginSuccess {
  /** The caller owns it and must zero it. */
  prk: Bytes;
  addresses: Addresses;
  path: string;
  expiresAtMs: number;
  maxUses: number;
  sessionKey: SessionKey;
  timings: Record<string, number>;
}

type AuthParams = {
  v: 1;
  t: 'hana:auth-params';
  pk: string;
  appName: string;
  parentOrigin: string;
  scopeId: string;
  signer: string;
  clientId: string;
  mode: 'own' | 'shared';
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  salt: Uint8Array;
  keyIndex: number;
  maxUses: number;
  nonce: string;
  relayId: string;
  relayKey: Uint8Array;
};

const fail = (code: ConstructorParameters<typeof VaultError>[0], message: string, data?: Record<string, unknown>) => new VaultError(code, message, data);

export class PendingLogin {
  readonly done: Promise<LoginSuccess>;
  /** Vault mode: the window the vault's launcher opened (set by the click). */
  popup: WindowRef | null = null;
  private readonly abortCtl = new AbortController();
  private abortError: VaultError | null = null;
  private params: AuthParams | null = null;
  private helloAccepted = false;
  private resolveHello: (() => void) | null = null;
  private readonly helloSeen: Promise<void>;
  private readonly pendingTimer: unknown;

  constructor(
    private readonly ctx: LoginContext,
    readonly mode: LoginMode,
    /** The SDK sent `{popupBlocked: true}` (the launcher fallback): hana_cancelLogin then ends it with popup_blocked. */
    readonly popupBlocked = false,
  ) {
    this.helloSeen = new Promise<void>((resolve) => {
      this.resolveHello = resolve;
    });
    this.pendingTimer = ctx.timers.setTimeout(() => this.abort(fail('login_timeout', 'The sign-in took too long', { stage: 'pending' })), LOGIN_PENDING_MS);
    this.done = this.run().finally(() => {
      ctx.timers.clearTimeout(this.pendingTimer);
      this.dropSecrets();
    });
    // The caller may attach its handler later; never an unhandled rejection.
    this.done.catch(() => undefined);
  }

  get aborted(): boolean {
    return this.abortError !== null;
  }

  /** Ends the login (supersession, cancel, timeout): every await after this throws `err`, and the relay poll stops. */
  abort(err: VaultError): void {
    if (this.abortError) return;
    this.abortError = err;
    this.abortCtl.abort();
    this.resolveHello?.();
  }

  private check(): void {
    if (this.abortError) throw this.abortError;
  }

  /**
   * A hana:auth-hello (already parsed). Answers with auth-params only once, only while ready, only from authOrigin and
   * only from the right window for the opener mode. Returns true if it answered.
   */
  acceptHello(e: WindowMessageEvent): boolean {
    if (this.abortError || this.helloAccepted || !this.params) return false;
    if (e.origin !== this.ctx.env.authOrigin || !e.source) return false;
    if (this.mode === 'partner') {
      let opener: unknown;
      try {
        opener = (e.source as { opener?: unknown }).opener;
      } catch {
        return false;
      }
      if (opener === null || opener === undefined || opener !== this.ctx.parentWindow) return false;
    } else if (!this.popup || e.source !== this.popup) {
      return false;
    }
    this.helloAccepted = true;
    const params = this.params;
    // The copies posted are the only ones besides the vault's; structured clone copies them again, so zero after.
    const message: AuthParams = { ...params, sessionPublicKey: Uint8Array.from(params.sessionPublicKey), salt: Uint8Array.from(params.salt), relayKey: Uint8Array.from(params.relayKey) };
    try {
      (e.source as WindowRef).postMessage(message, this.ctx.env.authOrigin);
    } finally {
      zero(message.relayKey, message.salt);
    }
    this.resolveHello?.();
    return true;
  }

  private dropSecrets(): void {
    if (this.params) zero(this.params.relayKey, this.params.salt);
    this.params = null;
  }

  private async run(): Promise<LoginSuccess> {
    const { ctx } = this;
    const { env, config } = ctx;
    const timings: Record<string, number> = {};
    let lap = ctx.deviceNow();
    const mark = (name: string) => {
      const t = ctx.deviceNow();
      timings[name] = Math.max(0, t - lap);
      lap = t;
    };

    // Step 2: the Google client, checked against the pinned SIGNER and the inlined scope.
    let app: AppConfig;
    try {
      app = await ctx.appConfig();
    } catch (e) {
      this.check();
      throw e instanceof ApiError ? apiErrorToVault(e) : fail('api_unavailable', 'Could not read the app configuration');
    }
    this.check();
    if (app.signer !== env.signer || app.scopeId !== config.scopeId) throw fail('config_mismatch', 'The app configuration does not match this vault');
    mark('app');
    // Q7, in the background: settled before the chain step, never an unhandled rejection.
    const scopeStarted = ctx.deviceNow();
    const scopeCheck = this.checkScope(app).then(
      (problem) => ({ problem, ms: ctx.deviceNow() - scopeStarted }),
      () => ({ problem: 'unchecked' as const, ms: ctx.deviceNow() - scopeStarted }),
    );

    const sessionKey = await newSessionKey();
    this.check();
    const salt = randomBytes(32);
    const relayKey = randomBytes(32);
    const relayReadKey = randomBytes(32);
    try {
      const relayId = relayIdFor(relayReadKey);
      const expiresAtMs = Math.floor(ctx.clock.now()) + Math.min(config.settings.sessionTtlMs, SESSION_TTL_CAP_MS);
      const maxUses = ctx.persistence === 'session' ? 1 : 2;
      const nonce = sessionNonce({ signer: env.signer, scopeId: config.scopeId, sessionPublicKey: sessionKey.publicKey, expiresAtMs, keyIndex: KEY_INDEX, maxUses, salt });
      this.params = {
        v: 1,
        t: 'hana:auth-params',
        pk: config.publishableKey,
        appName: config.appName,
        parentOrigin: ctx.parentOrigin,
        scopeId: config.scopeId,
        signer: env.signer,
        clientId: app.google.clientId,
        mode: app.google.mode,
        sessionPublicKey: sessionKey.publicKey,
        expiresAtMs,
        salt: Uint8Array.from(salt),
        keyIndex: KEY_INDEX,
        maxUses,
        nonce,
        relayId,
        relayKey: Uint8Array.from(relayKey),
      };

      // Step 3: wait for the popup.
      await this.helloSeen;
      this.check();
      this.dropSecrets();
      ctx.progress('popup_connected');
      ctx.progress('google');
      mark('popup');

      // Step 7: the token, through the relay.
      const idToken = await this.readRelay(relayId, relayReadKey, relayKey);
      ctx.progress('token');
      mark('google');
      let jwksUnavailable = false;
      const verified = await verifyGoogleIdToken(idToken, {
        clientId: app.google.clientId,
        nonce,
        nowMs: ctx.clock.now(),
        jwks: async (kid) => {
          try {
            return await ctx.jwks(kid);
          } catch {
            jwksUnavailable = true;
            return null;
          }
        },
      });
      this.check();
      if (!verified.ok) {
        if (jwksUnavailable) throw fail('api_unavailable', "Could not read Google's signing keys");
        if (verified.code === 'token_has_pii') throw fail('token_has_pii', 'The Google token carries a claim outside the allow-list', { claim: verified.claim.slice(0, 64) });
        throw fail('token_invalid', 'The Google token was refused');
      }
      const { sub, exp } = verified.token;
      mark('verify');

      // Step 8: the only path this session ever uses, in a scope the registry confirmed.
      const path = `${config.scopeId}#google#${sub}#${KEY_INDEX}`;
      const scope = await scopeCheck;
      this.check();
      timings.scopeCheck = Math.max(0, scope.ms);
      mark('scopeWait');
      if (scope.problem === 'unchecked') throw fail('api_unavailable', 'Could not check the app’s scope on NEAR', { reason: 'scope_unchecked' });
      if (scope.problem === 'mismatch') throw fail('config_mismatch', 'The app’s scope does not match the on-chain registry', { reason: 'scope_mismatch' });

      // Step 9: the chain.
      ctx.progress('chain');
      const appKey = newAppKey();
      const { pk1, pk2 } = appKey.publicKey.AppPublicKeyPV;
      const chain = new LoginChain(ctx, () => this.check(), this.abortCtl.signal, {
        sessionKey,
        path,
        maxUses,
        expiresAtMs,
        tokenExpMs: exp * 1000,
        pk1,
        pk2,
        body: { jwt: idToken, sessionPublicKey: Array.from(sessionKey.publicKey), expiresAtMs, salt: Array.from(salt), keyIndex: KEY_INDEX, maxUses, signature: [], pk1, pk2 },
      });
      const result = ctx.flow === 'split' ? await chain.split() : await chain.combined();
      this.check();
      mark('chain');

      // Step 10: decrypt with the pairing check against the pinned key, for the path the vault computed.
      let s: Bytes;
      try {
        s = decryptCkd(result, appKey.a, ckdAppId(env.signer, path), env.ckdNetworkKey);
      } catch {
        throw fail('pairing_failed', 'The key failed its check against the pinned network key');
      }
      const prk = extractPrk(s);
      try {
        const addresses = deriveAddresses(prk);
        mark('decrypt');
        return { prk, addresses, path, expiresAtMs, maxUses, sessionKey, timings };
      } catch (e) {
        prk.fill(0);
        throw e;
      }
    } finally {
      zero(salt, relayKey, relayReadKey);
    }
  }

  /**
   * The registry's view of the app's scope (Q7): 'mismatch' when the Google client the API named belongs to another
   * scope (own client) or the scope can't take shared logins (shared client), else null. Throws when the RPC can't
   * answer.
   */
  private async checkScope(app: AppConfig): Promise<'mismatch' | null> {
    const { near, config } = this.ctx;
    if (app.google.mode === 'own') return (await near.scopeForClient('google', app.google.clientId)) === config.scopeId ? null : 'mismatch';
    const scope = await near.getScope(config.scopeId);
    return scope && scope.id === config.scopeId && scope.allow_shared ? null : 'mismatch';
  }

  /** Long-polls the relay until it holds Google's answer; returns the ID token. */
  private async readRelay(relayId: string, relayReadKey: Uint8Array, relayKey: Uint8Array): Promise<string> {
    const { api, timers } = this.ctx;
    let backoff = 500;
    for (;;) {
      this.check();
      let read;
      try {
        read = await api.relayRead(relayId, relayReadKey, RELAY_WAIT_S, this.abortCtl.signal);
      } catch (e) {
        this.check();
        if (e instanceof ApiError && (e.status === 403 || e.status === 410)) throw fail('token_invalid', 'The sign-in answer is gone');
        // Rate limit, network or 5xx: try again until the pending limit.
        await sleep(timers, backoff, this.abortCtl.signal);
        backoff = Math.min(backoff * 2, 5_000);
        continue;
      }
      this.check();
      if (read.kind === 'empty') {
        backoff = 500;
        continue;
      }
      let payload;
      try {
        payload = await decryptRelayPayload(relayKey, relayId, read.value);
      } catch {
        throw fail('token_invalid', 'The sign-in answer does not decrypt');
      }
      this.check();
      if ('error' in payload) throw fail('google_error', 'Google returned an error', { error: payload.error });
      return payload.idToken;
    }
  }
}

interface ChainInput {
  sessionKey: SessionKey;
  path: string;
  maxUses: number;
  expiresAtMs: number;
  tokenExpMs: number;
  pk1: string;
  pk2: string;
  body: LoginBody;
}

/**
 * The chain step and its recovery (docs/batch-b-spec.md "Failure handling"). The vault re-syncs from NEAR
 * (`get_session`, optimistic) and accepts a re-synced session only with its own scope and path; it polls a known
 * transaction with sender RELAYER. It never takes a path, session or counter from the API.
 */
export class LoginChain {
  private readonly nearTxs: string[] = [];
  private resent = false;

  constructor(
    private readonly ctx: LoginContext,
    private readonly check: () => void,
    private readonly signal: AbortSignal,
    private readonly i: ChainInput,
  ) {}

  private noteTx(tx: string | null | undefined): void {
    if (tx && !this.nearTxs.includes(tx)) this.nearTxs.push(tx);
  }

  /** True while the token and the session expiry stay valid long enough for a resend. */
  private resendable(): boolean {
    const now = this.ctx.clock.now();
    return this.i.tokenExpMs > now + RESEND_MARGIN_MS && this.i.expiresAtMs > now + RESEND_MARGIN_MS;
  }

  private async body(): Promise<LoginBody> {
    const signature = await signDerive(this.i.sessionKey.keyPair.privateKey, 1, this.i.pk1, this.i.pk2);
    return { ...this.i.body, signature: Array.from(signature) };
  }

  /** POST /v1/login with recovery. */
  async combined(): Promise<CkdResult> {
    const body = await this.body();
    for (;;) {
      this.check();
      try {
        const r = await this.ctx.api.login(body);
        this.noteTx(r.nearTx);
        return r.result;
      } catch (e) {
        this.check();
        const outcome = await this.onRelayError(e, 'login');
        if (outcome === 'resend') continue;
        return outcome;
      }
    }
  }

  /** The split fallback: POST /v1/sessions, then /v1/derive with counter 1, with the same path rule and re-sync. */
  async split(): Promise<CkdResult> {
    const { jwt, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses } = this.i.body;
    for (;;) {
      this.check();
      try {
        const r = await this.ctx.api.createSession({ jwt, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses });
        this.noteTx(r.nearTx);
        break;
      } catch (e) {
        this.check();
        const outcome = await this.onRelayError(e, 'session');
        if (outcome === 'resend') continue;
        return outcome;
      }
    }
    return this.derive(1);
  }

  /**
   * One row of the failure table: a CKD result, 'resend' (the same body once more), or a thrown VaultError.
   * `step` is 'login' (the combined call, which returns the CKD) or 'session' (split create_session, which doesn't).
   */
  private async onRelayError(e: unknown, step: 'login' | 'session'): Promise<CkdResult | 'resend'> {
    if (!(e instanceof ApiError)) {
      // The request may or may not have reached the relayer: as 503 relayer_unavailable without a transaction.
      await sleep(this.ctx.timers, RELAYER_UNAVAILABLE_WAIT_MS, this.signal);
      return this.unknownOutcome(null, step);
    }
    this.noteTx(e.nearTx);
    const reason = e.details.reason;
    if (e.code === 'session_exists' || (e.code === 'contract_rejected' && reason === 'session_key_in_use')) return this.recoverExisting();
    if (e.code === 'contract_rejected') throw fail('derive_failed', 'The contract refused the sign-in');
    if (e.code === 'ckd_failed') {
      // The session was committed with used = 1 and the MPC side failed. Only 'none' mode has a spare use.
      if (this.ctx.persistence !== 'none') throw fail('ckd_failed', 'The key derivation failed; sign in again');
      const session = await this.resync();
      if (session && session.used < session.max_uses) return this.derive(session.used + 1);
      throw fail('ckd_failed', 'The key derivation failed; sign in again');
    }
    if ((e.code === 'timeout' || e.code === 'near_error' || e.code === 'bad_contract_result') && e.nearTx) return this.unknownOutcome(e.nearTx, step);
    if (NOT_EXECUTED.has(e.code)) {
      if (!this.resent && this.resendable()) {
        this.resent = true;
        return 'resend';
      }
      throw fail('api_unavailable', 'The Hana relayer is unavailable');
    }
    if (e.code === 'relayer_unavailable') {
      if (e.nearTx) return this.unknownOutcome(e.nearTx, step);
      await sleep(this.ctx.timers, RELAYER_UNAVAILABLE_WAIT_MS, this.signal);
      return this.unknownOutcome(null, step);
    }
    throw apiErrorToVault(e);
  }

  /** Outcome unknown: poll the transaction for up to 120 s, then re-sync and act on what the chain shows. */
  private async unknownOutcome(nearTx: string | null, step: 'login' | 'session'): Promise<CkdResult | 'resend'> {
    if (nearTx) {
      const settled = await this.poll(nearTx, TX_POLL_FOR_MS);
      if (settled && step === 'login') {
        const result = ckdResultOf(settled);
        if (result) return result;
      }
    }
    const session = await this.resync();
    if (!session) {
      if (!this.resent && this.resendable()) {
        this.resent = true;
        return 'resend';
      }
      throw fail('api_unavailable', 'The sign-in transaction did not land');
    }
    if (session.used < session.max_uses) return this.derive(session.used + 1);
    // Every use is spent: only a known transaction of ours can still hold the result.
    for (const tx of this.nearTxs) {
      const result = ckdResultOf((await this.poll(tx, 0)) ?? { kind: 'pending' });
      if (result) return result;
    }
    throw fail('derive_failed', 'The session was used up without a key');
  }

  /** 409 session_exists or session_key_in_use: someone (or an earlier attempt of ours) created this session first. */
  private async recoverExisting(): Promise<CkdResult> {
    let session = await this.resync();
    // A load-balanced RPC may answer from a node a block behind the API's: give it a few seconds.
    for (let i = 0; !session && i < 3; i++) {
      await sleep(this.ctx.timers, 1_000, this.signal);
      this.check();
      session = await this.resync();
    }
    if (!session) throw fail('derive_failed', 'The session could not be read back');
    if (session.used < session.max_uses) return this.derive(session.used + 1);
    for (const tx of this.nearTxs) {
      const result = ckdResultOf((await this.poll(tx, TX_POLL_FOR_MS)) ?? { kind: 'pending' });
      if (result) return result;
    }
    throw fail('session_consumed', "This sign-in's only use was taken by someone else; continue signing in");
  }

  /** The session from NEAR, which must be this vault's scope and path (else derive_failed). */
  private async resync(): Promise<SessionView | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check();
      try {
        const session = await this.ctx.near.getSession(this.i.sessionKey.publicKey);
        this.check();
        if (session && (session.scope_id !== this.ctx.config.scopeId || session.path !== this.i.path)) throw fail('derive_failed', 'The session on chain is not this sign-in');
        return session;
      } catch (e) {
        if (e instanceof VaultError) throw e;
        // An RPC error: try again shortly.
        await sleep(this.ctx.timers, 1_000, this.signal);
      }
    }
    throw fail('api_unavailable', 'Could not read the session from NEAR');
  }

  /** Polls a transaction until it settles or `forMs` passes (0: one query). Null when it never settled. */
  private async poll(nearTx: string, forMs: number) {
    const deadline = this.ctx.clock.now() + forMs;
    for (;;) {
      this.check();
      try {
        const outcome = await this.ctx.near.txOutcome(nearTx);
        this.check();
        if (outcome.kind !== 'pending') return outcome;
      } catch (e) {
        if (e instanceof VaultError) throw e;
        // An RPC error says nothing about the transaction: keep polling.
      }
      if (this.ctx.clock.now() + TX_POLL_EVERY_MS > deadline) return null;
      await sleep(this.ctx.timers, TX_POLL_EVERY_MS, this.signal);
    }
  }

  /** POST /v1/derive with `counter`, resending once if not executed; an unknown outcome is polled. */
  private async derive(counter: number): Promise<CkdResult> {
    const signature = await signDerive(this.i.sessionKey.keyPair.privateKey, counter, this.i.pk1, this.i.pk2);
    const body = { sessionPublicKey: Array.from(this.i.sessionKey.publicKey), counter, signature: Array.from(signature), pk1: this.i.pk1, pk2: this.i.pk2 };
    let resent = false;
    for (;;) {
      this.check();
      try {
        const r = await this.ctx.api.derive(body);
        this.noteTx(r.nearTx);
        return r.result;
      } catch (e) {
        this.check();
        if (!(e instanceof ApiError)) throw fail('api_unavailable', 'The key derivation could not be sent');
        this.noteTx(e.nearTx);
        if (NOT_EXECUTED.has(e.code) && !resent && this.resendable()) {
          resent = true;
          continue;
        }
        if ((e.code === 'timeout' || e.code === 'near_error' || e.code === 'relayer_unavailable') && e.nearTx) {
          const result = ckdResultOf((await this.poll(e.nearTx, TX_POLL_FOR_MS)) ?? { kind: 'pending' });
          if (result) return result;
          throw fail('derive_failed', 'The key derivation did not complete');
        }
        if (e.code === 'ckd_failed') throw fail('ckd_failed', 'The key derivation failed; sign in again');
        if (NOT_EXECUTED.has(e.code)) throw fail('api_unavailable', 'The Hana relayer is unavailable');
        if (e.status === 400 || e.status === 409 || e.status === 422) throw fail('derive_failed', 'The key derivation was refused', { api: `${e.status} ${e.code}` });
        throw apiErrorToVault(e);
      }
    }
  }
}
