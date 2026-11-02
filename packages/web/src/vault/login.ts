// A pending login, vault side (docs/batch-b-spec.md "Login" steps 2 and 7–10, "Failure handling").
//
//  2. The vault makes a non-extractable Ed25519 session key, salt, expiresAtMs (server-corrected clock), keyIndex 0,
//     maxUses (1 for 'session', 2 for 'none'), the A.2 nonce over the pinned SIGNER and the inlined scopeId, relayKey,
//     relayReadKey and relayId = b64url(sha256(relayReadKey)).
//  3. It answers one hana:auth-hello from authOrigin whose source is the right window for the opener mode (partner:
//     `source.opener === window.parent`; vault: the window its launcher opened) with hana:auth-params.
//  7. It long-polls the relay with the read key, decrypts the slot with relayKey, and checks the token (RS256 against
//     Google's JWKS, iss, aud, nonce, exp/iat on the corrected clock, the claim allow-list, sub).
//     Email login (build plan batch 8a): when the app's `loginMethods` include email and the env has an email issuer,
//     the auth-params offer both methods (the popup's chooser, or `hana.login({method})`); the popup's /login/email
//     relays the issuer's email token (JWS JSON) in the same slot. The vault verifies it against the on-chain email keys
//     and signer policy (`get_issuer_keys` / `get_self_issued("email")`, its own RPC), the pinned `iss`, the scope's
//     `aud` `email:<scopeId>`, the nonce and the time (core email-token.ts), and checks `scope_for_client("email",
//     aud)` is the scope. It never sends a `linkJwt`: batch 8a links nothing.
//  8. It fixes `expectedPath = scopeId#<provider>#sub#keyIndex` (loginPath: `google` exactly as before, or `email`),
//     the only path it ever uses for this session. With no links on chain (none exist while no app enables linking)
//     that is the identity's own path; a linked identity's login would fail the pairing check, never derive another
//     key. Before the
//     chain step it has also checked the inlined scopeId against the on-chain registry (docs/batch-b-spec.md Q7): one
//     view through the manifest RPC, started as soon as GET /v1/app answers so it runs while the user is at Google.
//     Own client: `scope_for_client('google', clientId)` must be the scopeId; shared client: `get_scope(scopeId)` must
//     exist and allow shared login. A mismatch is `config_mismatch` (reason `scope_mismatch`); no answer from either
//     RPC endpoint is `api_unavailable` (reason `scope_unchecked`). Nothing is relayed in either case.
//  9. It runs POST /v1/login and, on failure, recovers exactly as the "Failure handling" table says, re-syncing from
//     NEAR directly (never from the API). A `503 issuer_key_pending` (Google signed with a key still in the contract's
//     issuer-key delay, docs/governance-spec.md "Rotation and logins" step 3) is retried once after the API's
//     `retryAfterS` (at most KEY_PENDING_MAX_WAIT_S), with `loginProgress: key_pending` meanwhile.
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
  isServerTimings,
  newAppKey,
  newSessionKey,
  randomBytes,
  relayIdFor,
  sessionNonce,
  signCreate,
  signDerive,
  type EmailChainKey,
  type EmailSignerPolicy,
  EMAIL_PROVIDER,
  type LoginMethod,
  isJsonFormToken,
  verifyEmailIdToken,
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
/** The longest wait before the one retry of an `issuer_key_pending` login, whatever `retryAfterS` the API sends. */
export const KEY_PENDING_MAX_WAIT_S = 30;
/** The wait when the API's answer carries no usable `retryAfterS` (the API sends 30). */
export const KEY_PENDING_DEFAULT_WAIT_S = 30;

export type LoginMode = 'partner' | 'vault';
export type LoginStage = 'popup_connected' | 'google' | 'email_code' | 'token' | 'chain' | 'key_pending' | 'done';

/** What `hana_login` asked for: a method to open directly, an address to prefill. */
export interface LoginRequest {
  method?: LoginMethod;
  emailHint?: string;
}

/**
 * A login's derivation path, `{scope}#{provider}#{sub}#{key_index}`, for an identity that is not linked (D119: an
 * unlinked identity derives on its own path). `google` gives batch B's path byte for byte.
 */
export const loginPath = (scopeId: string, provider: 'google' | 'email', sub: string, keyIndex: number): string => `${scopeId}#${provider}#${sub}#${keyIndex}`;

/**
 * Whether a stored record's path is one this vault opens in `scopeId`: an unlinked Google or email identity's path
 * (the record check, docs/batch-b-spec.md "Record"). Google paths are checked exactly as before.
 */
export const isOwnLoginPath = (path: string, scopeId: string): boolean => path.startsWith(`${scopeId}#google#`) || path.startsWith(`${scopeId}#email#`);

/**
 * What /login/email relays as `{error}` when the user cancels the email step (D245), and the code the login ends with.
 * Google's own error codes (OAuth's) never start with `email_`.
 */
export const EMAIL_RELAY_ERRORS: Readonly<Record<string, 'login_cancelled' | 'code_invalid' | 'challenge_expired' | 'rate_limited' | 'login_method_unavailable'>> = Object.freeze({
  email_cancelled: 'login_cancelled',
  email_code_invalid: 'code_invalid',
  email_challenge_expired: 'challenge_expired',
  email_rate_limited: 'rate_limited',
  /** The step can't go on here (email unavailable for the app or this env, case B without Google). */
  email_unavailable: 'login_method_unavailable',
});

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
  /** Monotonic ms (performance.now) for per-stage timings (pk_test_ apps only). */
  perfNow(): number;
}

export interface LoginSuccess {
  /** The caller owns it and must zero it. */
  prk: Bytes;
  addresses: Addresses;
  path: string;
  expiresAtMs: number;
  maxUses: number;
  sessionKey: SessionKey;
  /** Stage and detail ms (timings.ts LOGIN_TIMING_*), up to `decrypt`; the vault adds `finish` and `vault`. */
  timings: Record<string, number>;
  /** perfNow at the end of `decrypt`, where `finish` starts. */
  markedAt: number;
}

/** The login popup's stages that ride in the relay slot (pk_test_ apps), each a part of the vault's hello → token. */
export const POPUP_STAGES = ['authCheck', 'callbackRedirect', 'callbackFetch', 'callbackBoot', 'callbackPrep'] as const;

/**
 * The API's own timings from a pk_test_ response, as detail entries `<prefix>Server` (its total) and
 * `<prefix>Server<Name>` for each `name: [phases…]` (summed). Nothing when the response has none or a malformed one.
 */
export function serverDetail(prefix: string, raw: unknown, groups: Record<string, readonly string[]>): Record<string, number> {
  if (!isServerTimings(raw)) return {};
  const out: Record<string, number> = { [`${prefix}Server`]: raw.totalMs };
  for (const [name, phases] of Object.entries(groups)) {
    const present = phases.filter((p) => typeof raw.phases[p] === 'number');
    if (present.length > 0) out[`${prefix}Server${name}`] = present.reduce((sum, p) => sum + (raw.phases[p] as number), 0);
  }
  return out;
}

/** The /v1/login phases (apps/api handlers.ts `lap`, `lapRelay`) behind each loginServer* detail. */
export const LOGIN_SERVER_GROUPS = { Gate: ['app', 'limits'], Checks: ['checks'], Relay: ['relay'], Broadcast: ['relayDispatch'], Wait: ['relayOutcome'] } as const;

/** The relay read's answer: the token (or Google's error), the popup's timings and how long the slot held it. */
interface Relayed {
  idToken: string;
  popupTimings: Record<string, number> | null;
  heldMs: number | null;
}

type AuthParams = {
  v: 1;
  methods?: LoginMethod[];
  method?: LoginMethod;
  emailHint?: string;
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
  /** The popup whose hello was answered: the only window whose `hana:auth-progress` counts. */
  private helloSource: unknown = null;
  /** Email is offered in this login (set once the app config is read). */
  private emailOffered = false;
  /** The popup's progress stages already reported (each once). */
  private readonly progressed = new Set<string>();
  /** When the vault took the hana_login request (perfNow), for the `vault` total. */
  readonly startedAt: number;

  constructor(
    private readonly ctx: LoginContext,
    readonly mode: LoginMode,
    /** The SDK sent `{popupBlocked: true}` (the launcher fallback): hana_cancelLogin then ends it with popup_blocked. */
    readonly popupBlocked = false,
    /** `hana.login({method, emailHint})`. */
    private readonly request: LoginRequest = {},
  ) {
    this.startedAt = ctx.perfNow();
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
    this.helloSource = e.source;
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

  /**
   * A hana:auth-progress (already parsed) from /login/email: the code was sent. Taken only in a login that offered email,
   * after its hello was answered, from authOrigin and from that same window (a navigation keeps the window). Only a
   * progress event follows; nothing else depends on it.
   */
  acceptProgress(e: WindowMessageEvent, stage: 'google' | 'email_code'): boolean {
    if (this.abortError || !this.helloAccepted || !this.emailOffered) return false;
    if (e.origin !== this.ctx.env.authOrigin || !e.source || e.source !== this.helloSource) return false;
    if (this.progressed.has(stage)) return false;
    this.progressed.add(stage);
    this.ctx.progress(stage);
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
    let lap = this.startedAt;
    const mark = (name: string) => {
      const t = ctx.perfNow();
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
    // Email is offered only when the app enables it, its scope serves it (the API's `email.aud`, this scope's client)
    // and this env's bundle pins an email issuer. Otherwise the login is batch B's Google login, message for message.
    const emailAud = `email:${config.scopeId}`;
    const emailOn = !!(env.emailIssuerUrl && env.emailIss && app.loginMethods?.includes('email') && app.email?.aud === emailAud);
    if (this.request.method === 'email' && !emailOn) throw fail('login_method_unavailable', 'Email sign-in is not available for this app');
    this.emailOffered = emailOn;
    mark('app');
    // Q7, in the background: settled before the chain step, never an unhandled rejection.
    const scopeStarted = ctx.perfNow();
    const scopeCheck = this.checkScope(app).then(
      (problem) => ({ problem, ms: ctx.perfNow() - scopeStarted }),
      () => ({ problem: 'unchecked' as const, ms: ctx.perfNow() - scopeStarted }),
    );
    // Email: the scope's email client and the on-chain email keys and policy, read while the user types the code.
    // Not for `method: 'google'`: that popup never takes the email path.
    const emailChain: Promise<EmailChain | 'unchecked'> | null =
      emailOn && this.request.method !== 'google' ? this.readEmailChain(emailAud).catch(() => 'unchecked' as const) : null;

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
        ...(emailOn
          ? {
              methods: ['google', 'email'] as LoginMethod[],
              ...(this.request.method ? { method: this.request.method } : {}),
              ...(this.request.emailHint && this.request.method !== 'google' ? { emailHint: this.request.emailHint } : {}),
            }
          : {}),
      };
      mark('keygen');

      // Step 3: wait for the popup.
      await this.helloSeen;
      this.check();
      this.dropSecrets();
      ctx.progress('popup_connected');
      // With email offered the user may not go to Google: the popup says so itself (hana:auth-progress), except for
      // `method: 'google'`, which goes straight there.
      if (!emailOn || this.request.method === 'google') ctx.progress('google');
      mark('popup');

      // Step 7: the token, through the relay.
      const relayed = await this.readRelay(relayId, relayReadKey, relayKey);
      const { idToken } = relayed;
      ctx.progress('token');
      mark('google');
      // The popup's and the relay's own parts of hello → token, each measured on one clock and passed as a duration.
      for (const stage of POPUP_STAGES) {
        const ms = relayed.popupTimings?.[stage];
        if (ms === undefined) continue;
        timings[stage] = ms;
        timings.google = Math.max(0, (timings.google ?? 0) - ms);
      }
      if (relayed.heldMs !== null) {
        timings.relayHeld = relayed.heldMs;
        timings.google = Math.max(0, (timings.google ?? 0) - relayed.heldMs);
      }
      // Step 7 (email): the issuer's token, checked against the chain's keys, never the API's word.
      let provider: 'google' | 'email' = 'google';
      let sub: string;
      let exp: number;
      if (isJsonFormToken(idToken)) {
        if (!emailChain) throw fail('token_invalid', 'The sign-in token was refused');
        const chain = await emailChain;
        this.check();
        if (chain === 'unchecked') throw fail('api_unavailable', 'Could not read the email sign-in keys on NEAR', { reason: 'email_unchecked' });
        if (chain.scope !== config.scopeId) throw fail('config_mismatch', 'The app’s email client does not match the on-chain registry', { reason: 'scope_mismatch' });
        const checked = await verifyEmailIdToken(idToken, { iss: env.emailIss as string, aud: emailAud, nonce, nowMs: ctx.clock.now(), keys: chain.keys, policy: chain.policy });
        this.check();
        if (!checked.ok) {
          if (checked.code === 'key_pending') throw fail('api_unavailable', 'The email sign-in key is not active yet; try signing in again in a few minutes');
          throw fail('token_invalid', 'The email token was refused');
        }
        provider = EMAIL_PROVIDER;
        sub = checked.token.sub;
        exp = checked.token.exp;
      } else {
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
        ({ sub, exp } = verified.token);
      }
      mark('verify');

      // Step 8: the only path this session ever uses, in a scope the registry confirmed.
      const path = loginPath(config.scopeId, provider, sub, KEY_INDEX);
      const scope = await scopeCheck;
      this.check();
      timings.scopeCheck = Math.max(0, scope.ms);
      mark('scopeWait');
      if (scope.problem === 'unchecked') throw fail('api_unavailable', 'Could not check the app’s scope on NEAR', { reason: 'scope_unchecked' });
      if (scope.problem === 'mismatch') throw fail('config_mismatch', 'The app’s scope does not match the on-chain registry', { reason: 'scope_mismatch' });

      // Step 9: the chain.
      ctx.progress('chain');
      const prepStarted = ctx.perfNow();
      const appKey = newAppKey();
      const { pk1, pk2 } = appKey.publicKey.AppPublicKeyPV;
      timings.chainPrep = ctx.perfNow() - prepStarted;
      const chain = new LoginChain(ctx, () => this.check(), this.abortCtl.signal, timings, {
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
        return { prk, addresses, path, expiresAtMs, maxUses, sessionKey, timings, markedAt: lap };
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
   * scope (own client), or, in shared mode, the scope can't take shared logins or the client isn't one of the
   * contract's shared clients in force (sweep VAUL-4), else null. Throws when the RPC can't answer.
   */
  private async checkScope(app: AppConfig): Promise<'mismatch' | null> {
    const { near, config } = this.ctx;
    if (app.google.mode === 'own') return (await near.scopeForClient('google', app.google.clientId)) === config.scopeId ? null : 'mismatch';
    const [scope, shared] = await Promise.all([near.getScope(config.scopeId), near.sharedClients()]);
    const isShared = shared.some(([provider, aud]) => provider === 'google' && aud === app.google.clientId);
    return scope && scope.id === config.scopeId && scope.allow_shared && isShared ? null : 'mismatch';
  }

  /** The email side of the registry check and the token check's keys, from the vault's own RPC. */
  private async readEmailChain(aud: string): Promise<EmailChain> {
    const { near } = this.ctx;
    const [scope, keys, policy] = await Promise.all([near.scopeForClient(EMAIL_PROVIDER, aud), near.issuerKeys(EMAIL_PROVIDER), near.selfIssued(EMAIL_PROVIDER)]);
    return { scope, keys: keys ?? [], policy };
  }

  /** Long-polls the relay until it holds Google's answer; returns the ID token (and, pk_test_ apps, the popup's timings). */
  private async readRelay(relayId: string, relayReadKey: Uint8Array, relayKey: Uint8Array): Promise<Relayed> {
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
      if ('error' in payload) {
        // The email step's cancel (D245), only in a login that offered email; anything else is Google's answer.
        const email = this.emailOffered && Object.hasOwn(EMAIL_RELAY_ERRORS, payload.error) ? EMAIL_RELAY_ERRORS[payload.error] : undefined;
        if (email === 'login_cancelled') throw fail('login_cancelled', 'The sign-in was cancelled');
        if (email === 'rate_limited') throw fail('rate_limited', 'Too many attempts, try again later');
        if (email === 'login_method_unavailable') throw fail('login_method_unavailable', 'Email sign-in is not available for this app');
        if (email) throw fail(email, email === 'code_invalid' ? 'The sign-in code was wrong' : 'The sign-in code expired');
        throw fail('google_error', 'Google returned an error', { error: payload.error });
      }
      const held = read.value.heldMs;
      return {
        idToken: payload.idToken,
        popupTimings: payload.timings ?? null,
        heldMs: typeof held === 'number' && Number.isFinite(held) && held >= 0 ? held : null,
      };
    }
  }
}

/** What the email token check reads from the chain. */
interface EmailChain {
  /** `scope_for_client("email", "email:<scopeId>")`. */
  scope: string | null;
  keys: EmailChainKey[];
  policy: EmailSignerPolicy | null;
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
  /** The one retry of an `issuer_key_pending` answer is spent (separate from the not-executed resend). */
  private keyPendingRetried = false;

  constructor(
    private readonly ctx: LoginContext,
    private readonly check: () => void,
    private readonly signal: AbortSignal,
    /** The login's timings: the chain adds its details (`chainPrep`, `loginRtt`, `loginServer*`). */
    private readonly timings: Record<string, number>,
    private readonly i: ChainInput,
  ) {}

  private noteTx(tx: string | null | undefined): void {
    if (tx && !this.nearTxs.includes(tx)) this.nearTxs.push(tx);
  }

  /** True while the token and the session expiry stay valid long enough for a resend (after waiting `afterMs`). */
  private resendable(afterMs = 0): boolean {
    const now = this.ctx.clock.now() + afterMs;
    return this.i.tokenExpMs > now + RESEND_MARGIN_MS && this.i.expiresAtMs > now + RESEND_MARGIN_MS;
  }

  /**
   * 503 issuer_key_pending: nothing was relayed (the API refused before the relayer). Google rotated and its new key
   * is still in the contract's issuer-key delay, normally confirmed by the watchdog within minutes. Waits the API's
   * `retryAfterS` (1 to KEY_PENDING_MAX_WAIT_S s) while telling the page (`key_pending`), then resends the same body
   * once. A second refusal, or a token that wouldn't outlive the wait, ends the login with a "try again" error.
   */
  private async keyPending(e: ApiError): Promise<'resend'> {
    const raw = e.details.retryAfterS;
    const waitS = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.ceil(raw), KEY_PENDING_MAX_WAIT_S) : KEY_PENDING_DEFAULT_WAIT_S;
    if (this.keyPendingRetried || !this.resendable(waitS * 1000)) {
      throw fail('api_unavailable', 'Google just changed its signing key and Hana ID has not activated it yet; try signing in again in a few minutes', { api: `${e.status} ${e.code}` });
    }
    this.keyPendingRetried = true;
    this.ctx.progress('key_pending');
    await sleep(this.ctx.timers, waitS * 1000, this.signal);
    this.check();
    this.ctx.progress('chain');
    return 'resend';
  }

  private async body(): Promise<LoginBody> {
    const started = this.ctx.perfNow();
    const signature = await signDerive(this.i.sessionKey.keyPair.privateKey, 1, this.i.pk1, this.i.pk2);
    this.timings.chainPrep = (this.timings.chainPrep ?? 0) + (this.ctx.perfNow() - started);
    return { ...this.i.body, signature: Array.from(signature) };
  }

  /** POST /v1/login with recovery. */
  async combined(): Promise<CkdResult> {
    const body = await this.body();
    for (;;) {
      this.check();
      try {
        const sent = this.ctx.perfNow();
        const r = await this.ctx.api.login(body);
        // The successful attempt's round trip next to the API's own time for it (pk_test_ responses carry it).
        this.timings.loginRtt = this.ctx.perfNow() - sent;
        Object.assign(this.timings, serverDetail('login', r.timings, LOGIN_SERVER_GROUPS));
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

  /**
   * The split fallback: POST /v1/sessions, then /v1/derive with counter 1, with the same path rule and re-sync. The
   * create_session carries the session key's proof of possession (D137: required by contract v3, ignored by v2).
   */
  async split(): Promise<CkdResult> {
    const { jwt, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses } = this.i.body;
    const proof = await signCreate(this.i.sessionKey.keyPair.privateKey, {
      signer: this.ctx.env.signer,
      scopeId: this.ctx.config.scopeId,
      sessionPublicKey: Uint8Array.from(sessionPublicKey),
      expiresAtMs,
      keyIndex,
      maxUses,
      salt: Uint8Array.from(salt),
    });
    const signature = Array.from(proof);
    for (;;) {
      this.check();
      try {
        const r = await this.ctx.api.createSession({ jwt, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses, signature });
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
    if (e.code === 'issuer_key_pending') return this.keyPending(e);
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
