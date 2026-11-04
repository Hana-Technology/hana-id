// A pending login, vault side (docs/batch-b-spec.md "Login" steps 2 and 7–10, "Failure handling"; email login and
// linking: docs/email-login-spec.md "The four cases", build plan batches 7, 8a and 8b).
//
//  2. The vault makes a non-extractable Ed25519 session key, salt, expiresAtMs (server-corrected clock), keyIndex 0,
//     maxUses (1 for 'session', 2 for 'none'), the A.2 nonce over the pinned SIGNER and the inlined scopeId, relayKey,
//     relayReadKey and relayId = b64url(sha256(relayReadKey)). In a login that offers email it adds `followKey`, the
//     follow-up channel's key (core links.ts `followSlot`): after the token, the vault and the popup talk through
//     write-once relay slots, end-to-end encrypted under relayKey (google-match's screens, link banners).
//  3. It answers one hana:auth-hello from authOrigin whose source is the right window for the opener mode (partner:
//     `source.opener === window.parent`; vault: the window its launcher opened) with hana:auth-params.
//  7. It long-polls the relay with the read key, decrypts the slot with relayKey, and checks the token: Google's (RS256
//     against Google's JWKS, iss, aud, nonce, exp/iat on the corrected clock, the claim allow-list, sub) or the email
//     issuer's (JWS JSON against the on-chain email keys and signer policy, the pinned `iss`, `email:<scopeId>`, the
//     nonce; and `scope_for_client("email", aud)` is the scope).
//     With email on (batch 8b), a Google token goes to the issuer's google-match first, before any chain call, with
//     Google's access token (the popup's second, silent `email` request, or one request: auth/google.ts), never the
//     address: the issuer reads it from Google, answers the case, and mints an `auto_link` token when the case allows
//     it. The four cases (spec "The four cases"; D119, D122):
//       - A, Google-hosted: the token comes at once; the login links silently (no screen; a banner after);
//       - A, not hosted: the popup shows "Link and continue" (a code to a…@domain, then the `auto_link` token) or
//         "Sign in with email" (an email login to that wallet); A that can't link: "Sign in with email" only;
//       - B: only after this popup's own email step (D139): the popup relays `caseB {linkTicket, emailSub}` with Google's
//         token, google-match mints the token, and the vault requires its `sub` to be that `emailSub`;
//       - C and every other answer: a plain Google login. No Google wallet is ever opened on a match (no case D).
//     google-match unreachable, or no access token: a Google identity that has no wallet and no account is refused
//     (`api_unavailable`, `email_match_unavailable`): it might be case A, and a plain login would open a second wallet
//     (D122, D255); one that has a wallet or an account logs in as usual.
//     Under token_first (auth/google.ts GOOGLE_EMAIL_FLOW, D270) an app without email login, in an env with an email
//     issuer, gets the follow-up key too (`emailRecord`): the popup's one Google screen asks for the email, and the
//     vault sends the access token to the issuer's google-record (D269: the user directory only, no match) once the
//     login has succeeded (step 10), in the background and best effort: its failure or slowness never touches the
//     login, and a refused or cancelled login is never recorded. If the popup couldn't check the access token with
//     tokeninfo, it relays a plain openid login (no `access: 'follow'`) and nothing is recorded.
//  8. The path (batch 7): `{scope}#{provider}#{sub}#{keyIndex}` of the identity `get_identity` on the vault's own RPC
//     names: the identity itself when it is "own", its account root when it is an active member; a pending member is
//     refused (`link_pending`, with when it activates). With a link token (D133) the vault reads both identities and
//     their accounts, judges what the contract will do (core links.ts `judgeAutoLink`), verifies the link token's
//     signatures on chain with exactly the `auto_link` nonce that judgement gives (join, joiner, target root, epoch,
//     the issuer's mode), refuses on any mismatch, and fixes the account root's path. An unlinked Google identity's
//     path is batch B's byte for byte (golden tests). Before the chain step it has also checked the inlined scopeId
//     against the on-chain registry (Q7).
//  9. It runs POST /v1/login and, on failure, recovers exactly as the "Failure handling" table says, re-syncing from
//     NEAR directly (never from the API). With a link the session key signs the linked CKD payload, and the recovery
//     is D137's: a session meant to carry a link is never derived on with the plain payload; on `Session key already
//     in use` or any failure after publishing, the vault revokes that session and the user signs in again (D257).
//     A `503 issuer_key_pending` is retried once after the API's `retryAfterS`, with `loginProgress: key_pending`.
// 10. It decrypts the CKD with the pairing check against the pinned key for ckdAppId(SIGNER, path), extracts PRK
//     (zeroing S) and derives the addresses. A pairing failure re-reads the session and the identity once: a link that
//     activated between the vault's read and the transaction moves the path to the root's (spec "Sessions").
// 11. With the follow-up channel, the vault's last word to the popup: `done` (close, or link banners first: a pending
//     method with Cancel, a method this login added, recent ones, from `get_account`), or `stop` with the error.
//     A banner's Cancel or Remove is a fresh sign-in of this login's method over a `link_change` nonce, relayed as
//     `cancel_link` / `unlink_identity` (POST /v1/link/cancel, /unlink).
//
// SECURITY: the session key never leaves the vault (non-extractable); relayKey and followKey go only to the
// authenticated login popup on authOrigin; relayReadKey never leaves the vault; tokens, Google's access token, S and
// the BLS scalar `a` live only in this module's scope. Nothing is logged.
import {
  ApiError,
  type AppConfig,
  type Bytes,
  type CkdResult,
  type EmailChainKey,
  type EmailSignerPolicy,
  type FollowNotice,
  type FollowProve,
  type IdentityRef,
  type IdentityView,
  type Jwk,
  type LinkBanner,
  type LinkSide,
  type LoginBody,
  type LoginMethod,
  type RelayPayload,
  type RelayTokenPayload,
  isRelayToken,
  type SessionKey,
  type SessionView,
  EMAIL_PROVIDER,
  JOIN_SESSION_IDENTITY,
  PATH_PROVIDERS,
  ViewShapeError,
  ckdAppId,
  decryptCkd,
  decryptRelayPayload,
  encryptRelayValue,
  followSlot,
  fromHex,
  identityKey,
  identityKeyHex,
  isJsonFormToken,
  isServerTimings,
  judgeAutoLink,
  linkAccountNonce,
  linkChangeNonce,
  linkNewNonce,
  newAppKey,
  newSessionKey,
  pathIdentity,
  peekEmailTokenSub,
  randomBytes,
  relayIdFor,
  sessionHashOf,
  sessionNonce,
  signCreate,
  signDerive,
  signDeriveLinked,
  signRevoke,
  verifyEmailIdToken,
  verifyGoogleIdToken,
  zero,
} from '@hana-id/core';
import { type Addresses, deriveAddresses, extractPrk } from '@hana-id/core/derivation';
import type { HanaEnv } from '../hana-env.ts';
import type { VaultApi } from './api.ts';
import { type Persistence, SESSION_TTL_CAP_MS, type VaultConfig } from './config.ts';
import { VaultError, apiErrorToVault } from './errors.ts';
import { type GoogleMatch, type IssuerApi, MatchBusy, type MatchRequest } from './issuer.ts';
import { GOOGLE_EMAIL_FLOW, type GoogleEmailFlow } from '../auth/google.ts';
import { type NearView, ckdResultOf } from './near.ts';
import { PathCheckError, confirmPath } from '../path-check.ts';
import { type Clock, type Timers, type WindowMessageEvent, type WindowRef, realTimers, sleep } from './runtime.ts';

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
/** After a login, how long the vault waits for a banner's Cancel or Remove in the popup. */
export const AFTERWORD_MS = 5 * 60_000;
/** An active sign-in method added this recently still gets a banner at login (spec "Notices"). */
export const RECENT_LINK_MS = 7 * 24 * 3_600_000;
/** google-match answered 429 or 503: the longest one wait (its `retry-after`, else a backoff), and all waits together. */
export const MATCH_RETRY_MAX_WAIT_MS = 20_000;
export const MATCH_RETRY_BUDGET_MS = 45_000;
/** The first wait after a 429 or 503 without `retry-after`, doubled each time up to MATCH_RETRY_MAX_WAIT_MS. */
export const MATCH_RETRY_FIRST_MS = 1_000;
/** A login stops retrying google-match this long before its own deadline (LOGIN_PENDING_MS), to finish the chain step. */
const MATCH_DEADLINE_MARGIN_MS = 90_000;
/**
 * How long a login waits for its root pin (IndexedDB). Then, as on a read error, a path that isn't the identity's own
 * is confirmed on both providers (D263: fail closed).
 */
export const PIN_READ_TIMEOUT_MS = 1_000;
/**
 * The most email-consent screens (declined, another account) one login shows (D264: at most 3); a refusal after the
 * last one ends the login with `login_cancelled`.
 */
export const EMAIL_CONSENT_ROUNDS = 3;
/**
 * token_first's google-record (D269, D270): the longest the vault's background record waits, for the access token's
 * slot and the issuer's answer together. It runs beside the login and never delays it.
 */
export const RECORD_TIMEOUT_MS = 30_000;

/**
 * What the login vault remembers per signed-in identity (D263): the identity whose path it last derived, the account
 * root. Absent: never seen (or the app keeps nothing on this device). Both methods may throw (storage); the login then
 * goes on without the pin.
 */
export interface RootPins {
  /** The root's identity key (hex) last derived for this identity, or null. */
  get(identityKeyHex: string): Promise<string | null>;
  set(identityKeyHex: string, rootKeyHex: string): Promise<void>;
}

export type LoginMode = 'partner' | 'vault';
export type LoginStage = 'popup_connected' | 'google' | 'email_code' | 'token' | 'linking' | 'chain' | 'key_pending' | 'done';

/** What `hana_login` asked for: a method to open directly, an address to prefill. */
export interface LoginRequest {
  method?: LoginMethod;
  emailHint?: string;
}

/** A derivation path: `{scope}#{provider}#{sub}#{key_index}`, unchanged since batch B (`google` byte for byte). */
export const loginPath = (scopeId: string, provider: 'google' | 'email', sub: string, keyIndex: number): string => `${scopeId}#${provider}#${sub}#${keyIndex}`;

/** The identity whose own path `path` is (`{scope}#{provider}#{sub}#{key_index}`), or null for another form. */
export function pathOwner(path: string): IdentityRef | null {
  const m = /^[a-z0-9]{1,64}#(google|email)#([^#]{1,255})#(\d{1,10})$/u.exec(path);
  return m ? { provider: m[1] as string, sub: m[2] as string } : null;
}

/**
 * Whether a stored record's path is one this vault opens in `scopeId`: a Google or email identity's own path, which
 * is also the path of every member of an account that identity roots (the record check, docs/batch-b-spec.md
 * "Record"). Google paths are checked exactly as before.
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
  /** The email issuer's google-match (null in an env without an email issuer). */
  issuer: IssuerApi | null;
  clock: Clock;
  timers: Timers;
  /** Google's key for a kid (may refetch on an unknown kid); throws when Google can't be reached. */
  jwks(kid: string): Promise<Jwk | null>;
  /** GET /v1/app, cached (a failed request is dropped, so the next call asks again); throws its ApiError. */
  appConfig(): Promise<AppConfig>;
  /** pk_test_ timings: the round trip of the GET /v1/app request that answered `app`, on the vault's clock. */
  appRtt?(app: AppConfig): number | undefined;
  /** window.parent (partner mode authenticates the popup by its opener). */
  parentWindow: unknown;
  progress(stage: LoginStage): void;
  /** A banner's Cancel or Remove went through after the login (the vault tells the partner, `linkChanged`). */
  linkRemoved?(provider: string): void;
  /** The split fallback (/v1/sessions then /v1/derive counter 1) until the ship gate decides. */
  flow: 'combined' | 'split';
  /** Monotonic ms (performance.now) for per-stage timings (pk_test_ apps only). */
  perfNow(): number;
  /** The account root each identity last opened (D263); none: no pin is kept or checked. */
  pins?: RootPins;
  /** How the popup asks Google for the email scope (auth/google.ts GOOGLE_EMAIL_FLOW; tests run every flow). */
  googleEmailFlow?: GoogleEmailFlow;
}

/** A link this login made: the method that joined, and when it opens the wallet (now, or after the delay). */
export interface MadeLink {
  provider: LoginMethod;
  status: 'active' | 'pending';
  effectiveAtMs: number;
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
  /** The identity that signed in (its token opened the session; the path may be its account root's). */
  identity: IdentityRef;
  /** The automatic link this login made, if any. */
  linked: MadeLink | null;
}

/**
 * The login popup's stages that ride in the relay slot (pk_test_ apps), each a part of the vault's hello → token:
 * /login's, then the callback's (Google) or the email step's (email-page.ts EMAIL_STEP_STAGES).
 */
export const POPUP_STAGES = [
  'authCheck',
  'choose',
  'callbackRedirect',
  'callbackFetch',
  'callbackBoot',
  'callbackPrep',
  'emailLoad',
  'emailEntry',
  'emailStart',
  'emailCode',
  'emailVerify',
] as const;

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

/** The GET /v1/app phases (apps/api handlers.ts handleAppConfig) behind each appServer* detail. */
export const APP_SERVER_GROUPS = { Gate: ['app', 'limits'], Settings: ['settings'], Chain: ['chain'] } as const;

/** The /v1/login phases (apps/api handlers.ts `lap`, `lapRelay`) behind each loginServer* detail. */
export const LOGIN_SERVER_GROUPS = { Gate: ['app', 'limits'], Checks: ['checks'], Relay: ['relay'], Broadcast: ['relayDispatch'], Wait: ['relayOutcome'] } as const;

/** The relay read's answer: the payload, the popup's timings and how long the slot held it. */
interface Relayed {
  payload: RelayTokenPayload;
  popupTimings: Record<string, number> | null;
  heldMs: number | null;
}

type AuthParams = {
  v: 1;
  methods?: LoginMethod[];
  method?: LoginMethod;
  emailHint?: string;
  followKey?: Uint8Array;
  emailRecord?: true;
  task?: { kind: 'link'; provider: LoginMethod; prove: FollowProve };
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
const sameRef = (a: IdentityRef, b: IdentityRef): boolean => a.provider === b.provider && a.sub === b.sub;

/** A verified sign-in: who, its token, and when the token expires. */
interface Who {
  ref: IdentityRef & { provider: 'google' | 'email' };
  token: string;
  expMs: number;
}

/** A link token the vault will carry (verified later, against its own judgement). */
interface LinkPlan {
  token: string;
  immediate: boolean;
  /** The join the case implies (1: case A, 2: case B); the judgement must give exactly this one. */
  join: 1 | 2;
}

/** What the vault reads from the chain for email tokens. */
interface EmailChain {
  /** `scope_for_client("email", "email:<scopeId>")`. */
  scope: string | null;
  keys: EmailChainKey[];
  policy: EmailSignerPolicy | null;
}

/**
 * The follow-up channel of one login (core links.ts `followSlot`): the vault writes its notices in slots 2, 4, 6, …
 * and reads the popup's answer to a notice in the next slot; slot 1 carries Google's access token (the popup's second
 * request). Keys are copies the channel owns and zeroes in `close()`.
 */
export class FollowChannel {
  private next = 2;
  private closed = false;

  constructor(
    private readonly api: VaultApi,
    private readonly timers: Timers,
    private readonly relayKey: Uint8Array,
    private readonly followKey: Uint8Array,
  ) {}

  /** Writes `n` at the next notice slot; returns that slot number. Best effort unless `strict`. */
  async notice(n: FollowNotice, strict = false): Promise<number> {
    const slot = this.next;
    this.next += 2;
    if (this.closed) return slot;
    const { id } = followSlot(this.followKey, slot);
    try {
      await this.api.relayWrite(id, await encryptRelayValue(this.relayKey, id, n));
    } catch (e) {
      if (strict) throw e;
    }
    return slot;
  }

  /** The popup's answer to the notice in `slot` (read from slot + 1), or slot 1's access token for `slot` 0. */
  async answer(slot: number, signal: AbortSignal): Promise<RelayPayload> {
    const { id, readKey } = followSlot(this.followKey, slot + 1);
    return readSlot(this.api, this.timers, this.relayKey, id, readKey, signal, () => (this.closed ? fail('login_cancelled', 'The sign-in ended') : null));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    zero(this.relayKey, this.followKey);
  }
}

/** Long-polls one relay slot until it holds a value; returns the decrypted payload. */
async function readSlot(
  api: VaultApi,
  timers: Timers,
  relayKey: Uint8Array,
  relayId: string,
  readKey: Uint8Array,
  signal: AbortSignal,
  check: () => VaultError | null,
): Promise<RelayPayload & { _heldMs?: number }> {
  let backoff = 500;
  for (;;) {
    const stop = check();
    if (stop) throw stop;
    let read;
    try {
      read = await api.relayRead(relayId, readKey, RELAY_WAIT_S, signal);
    } catch (e) {
      const again = check();
      if (again) throw again;
      if (e instanceof ApiError && (e.status === 403 || e.status === 410)) throw fail('token_invalid', 'The sign-in answer is gone');
      // Rate limit, network or 5xx: try again until the pending limit.
      await sleep(timers, backoff, signal);
      backoff = Math.min(backoff * 2, 5_000);
      continue;
    }
    const after = check();
    if (after) throw after;
    if (read.kind === 'empty') {
      backoff = 500;
      continue;
    }
    let payload: RelayPayload;
    try {
      payload = await decryptRelayPayload(relayKey, relayId, read.value);
    } catch {
      throw fail('token_invalid', 'The sign-in answer does not decrypt');
    }
    const held = read.value.heldMs;
    return typeof held === 'number' && Number.isFinite(held) && held >= 0 ? { ...payload, _heldMs: held } : payload;
  }
}

/**
 * What a login and a link task share: the login popup's handshake (auth-params to one authenticated window), the
 * 5-minute limit, abort, and the follow-up channel.
 */
abstract class PopupTask<T> {
  done!: Promise<T>;
  /** Vault mode: the window the vault's launcher opened (set by the click). */
  popup: WindowRef | null = null;
  protected readonly abortCtl = new AbortController();
  protected abortError: VaultError | null = null;
  protected params: AuthParams | null = null;
  protected helloAccepted = false;
  protected resolveHello: (() => void) | null = null;
  protected readonly helloSeen: Promise<void>;
  private pendingTimer: unknown = null;
  /** The popup whose hello was answered: the only window whose `hana:auth-progress` counts. */
  protected helloSource: unknown = null;
  /** Email is offered in this login (set once the app config is read). */
  protected emailOffered = false;
  /** token_first's record-only login (an app without email login, D270): the token may say `access: 'follow'`. */
  protected recordOffered = false;
  /** token_first's background google-record, once started (tests wait for it); it never rejects. */
  recorded: Promise<void> | null = null;
  /** The popup's progress stages already reported (each once). */
  protected readonly progressed = new Set<string>();
  /** The follow-up channel (a login that offers email). Survives the login for its banners (`afterword`). */
  protected follow: FollowChannel | null = null;
  /** When the vault took the request (perfNow), for the `vault` total. */
  readonly startedAt: number;

  constructor(
    protected readonly ctx: LoginContext,
    readonly mode: LoginMode,
    /** The SDK sent `{popupBlocked: true}` (the launcher fallback): hana_cancelLogin then ends it with popup_blocked. */
    readonly popupBlocked: boolean,
  ) {
    this.startedAt = ctx.perfNow();
    this.helloSeen = new Promise<void>((resolve) => {
      this.resolveHello = resolve;
    });
  }

  /** Called by the subclass constructor, once its own fields are set. */
  protected start(): void {
    this.pendingTimer = this.ctx.timers.setTimeout(() => this.abort(fail('login_timeout', 'The sign-in took too long', { stage: 'pending' })), LOGIN_PENDING_MS);
    this.done = this.run().finally(() => {
      this.ctx.timers.clearTimeout(this.pendingTimer);
      this.dropSecrets();
    });
    // The caller may attach its handler later; never an unhandled rejection.
    this.done.catch(() => undefined);
  }

  protected abstract run(): Promise<T>;

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

  protected check(): void {
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
    const message: AuthParams = {
      ...params,
      sessionPublicKey: Uint8Array.from(params.sessionPublicKey),
      salt: Uint8Array.from(params.salt),
      relayKey: Uint8Array.from(params.relayKey),
      ...(params.followKey ? { followKey: Uint8Array.from(params.followKey) } : {}),
    };
    try {
      (e.source as WindowRef).postMessage(message, this.ctx.env.authOrigin);
    } finally {
      zero(message.relayKey, message.salt, message.followKey);
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

  protected dropSecrets(): void {
    if (this.params) zero(this.params.relayKey, this.params.salt, this.params.followKey);
    this.params = null;
  }

  /** Runs `body`; on failure the popup, which waits for the vault's last word, hears why (best effort). */
  protected async withStop<R>(body: () => Promise<R>): Promise<R> {
    try {
      return await body();
    } catch (e) {
      const follow = this.follow;
      if (follow) {
        const err = e instanceof VaultError ? e : null;
        void follow.notice(stopNotice(err)).finally(() => follow.close());
        this.follow = null;
      }
      throw e;
    }
  }
}

/** The popup's `stop` notice for a flow that ends with `err`. */
function stopNotice(err: VaultError | null): FollowNotice {
  const code = err && /^[a-z_]{1,64}$/u.test(String(err.code)) ? String(err.code) : 'api_unavailable';
  const at = err?.data?.effectiveAtMs;
  return { t: 'stop', code, ...(typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? { effectiveAtMs: at } : {}) };
}

export class PendingLogin extends PopupTask<LoginSuccess> {
  constructor(
    ctx: LoginContext,
    mode: LoginMode,
    popupBlocked = false,
    /** `hana.login({method, emailHint})`. */
    private readonly request: LoginRequest = {},
  ) {
    super(ctx, mode, popupBlocked);
    this.start();
  }

  protected run(): Promise<LoginSuccess> {
    return this.withStop(() => this.runLogin());
  }

  private async runLogin(): Promise<LoginSuccess> {
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
      app = await this.appConfigWithRetry();
    } catch (e) {
      this.check();
      throw e instanceof ApiError ? apiErrorToVault(e) : fail('api_unavailable', 'Could not read the app configuration');
    }
    this.check();
    if (app.signer !== env.signer || app.scopeId !== config.scopeId) throw fail('config_mismatch', 'The app configuration does not match this vault');
    // Email is offered only when the app enables it, its scope serves it (the API's `email.aud`, this scope's client)
    // and this env's bundle pins an email issuer. Otherwise the login is batch B's Google login, message for message.
    const emailAud = `email:${config.scopeId}`;
    const emailOn = !!(env.emailIssuerUrl && env.emailIss && ctx.issuer && app.loginMethods?.includes('email') && app.email?.aud === emailAud);
    if (this.request.method === 'email' && !emailOn) throw fail('login_method_unavailable', 'Email sign-in is not available for this app');
    this.emailOffered = emailOn;
    // D269, D270: under token_first every Google login of an env with an email issuer asks for the email; an app
    // without email login sends it to the issuer's directory only (google-record), never to google-match.
    const recordOn = !emailOn && (ctx.googleEmailFlow ?? GOOGLE_EMAIL_FLOW) === 'token_first' && !!(env.emailIssuerUrl && ctx.issuer);
    this.recordOffered = recordOn;
    mark('app');
    const appRtt = ctx.appRtt?.(app);
    if (appRtt !== undefined) timings.appRtt = Math.max(0, appRtt);
    Object.assign(timings, serverDetail('app', app.timings, APP_SERVER_GROUPS));
    // Q7, in the background: settled before the chain step, never an unhandled rejection.
    const scopeStarted = ctx.perfNow();
    const scopeCheck = this.checkScope(app).then(
      (problem) => ({ problem, ms: ctx.perfNow() - scopeStarted }),
      () => ({ problem: 'unchecked' as const, ms: ctx.perfNow() - scopeStarted }),
    );
    // Email: the scope's email client and the on-chain email keys and policy (email tokens and link tokens), read
    // while the user is at Google or types the code.
    const emailChain: Promise<EmailChain | 'unchecked'> | null = emailOn ? this.readEmailChain(emailAud).catch(() => 'unchecked' as const) : null;

    const sessionKey = await newSessionKey();
    this.check();
    const salt = randomBytes(32);
    const relayKey = randomBytes(32);
    const relayReadKey = randomBytes(32);
    const followKey = emailOn || recordOn ? randomBytes(32) : null;
    try {
      const relayId = relayIdFor(relayReadKey);
      const expiresAtMs = Math.floor(ctx.clock.now()) + Math.min(config.settings.sessionTtlMs, SESSION_TTL_CAP_MS);
      const maxUses = ctx.persistence === 'session' ? 1 : 2;
      const session = { signer: env.signer, scopeId: config.scopeId, sessionPublicKey: sessionKey.publicKey, expiresAtMs, keyIndex: KEY_INDEX, maxUses, salt };
      const nonce = sessionNonce(session);
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
              followKey: Uint8Array.from(followKey as Uint8Array),
            }
          : {}),
        ...(recordOn ? { followKey: Uint8Array.from(followKey as Uint8Array), emailRecord: true as const } : {}),
      };
      if (followKey && emailOn) this.follow = new FollowChannel(ctx.api, ctx.timers, Uint8Array.from(relayKey), Uint8Array.from(followKey));
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
      // An email login never went to Google: the same residual is the relay's network legs (timings.ts `emailRelay`).
      if (isJsonFormToken(relayed.payload.idToken) && timings.google !== undefined) {
        timings.emailRelay = timings.google;
        delete timings.google;
      }

      const commitment = { scopeId: config.scopeId, sessionPublicKey: Array.from(sessionKey.publicKey), expiresAtMs, keyIndex: KEY_INDEX, maxUses, salt: Array.from(salt) };
      const verify = new TokenCheck(ctx, app, emailChain, () => this.check());
      // Step 7: who signed in (never the API's word), then (email on, a Google token) google-match and its case.
      let who = await verify.first(relayed.payload, nonce);
      let link: LinkPlan | null = null;
      if (who.ref.provider === 'google' && emailOn && this.follow) {
        const decided = await this.matchGoogle(who, relayed.payload, commitment, verify, nonce);
        who = decided.who;
        link = decided.link;
      }
      mark('verify');

      // Step 8: the only path this session ever uses, in a scope the registry confirmed.
      const scope = await scopeCheck;
      this.check();
      timings.scopeCheck = Math.max(0, scope.ms);
      mark('scopeWait');
      if (scope.problem === 'unchecked') throw fail('api_unavailable', 'Could not check the app’s scope on NEAR', { reason: 'scope_unchecked' });
      if (scope.problem === 'mismatch') throw fail('config_mismatch', 'The app’s scope does not match the on-chain registry', { reason: 'scope_mismatch' });
      const sessionHash = sessionHashOf(session);
      let path: string;
      let linkedRef: IdentityRef | null = null;
      if (link) {
        ctx.progress('linking');
        const judged = await this.judgeLink(who, link, sessionHash, verify);
        path = loginPath(config.scopeId, judged.pathIdentity.provider as 'google' | 'email', judged.pathIdentity.sub, KEY_INDEX);
        linkedRef = judged.joiner;
      } else {
        path = await this.ownPath(who.ref);
      }
      // D263: a silent change of the root this device last opened for this identity, other than a link activating
      // (own → member, confirmed on both providers above), is confirmed on both providers again.
      await this.checkPin(who.ref, pathOwner(path) as IdentityRef);

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
        tokenExpMs: who.expMs,
        pk1,
        pk2,
        link: link ? { jwt: link.token, immediate: link.immediate } : null,
        body: {
          jwt: who.token,
          sessionPublicKey: Array.from(sessionKey.publicKey),
          expiresAtMs,
          salt: Array.from(salt),
          keyIndex: KEY_INDEX,
          maxUses,
          signature: [],
          pk1,
          pk2,
          ...(link ? { linkJwt: link.token, linkImmediate: link.immediate } : {}),
        },
      });
      const result = ctx.flow === 'split' && !link ? await chain.split() : await chain.combined();
      this.check();
      mark('chain');

      // Step 10: decrypt with the pairing check against the pinned key, for the path the vault computed (a link that
      // activated meanwhile moved the session to the root's path: re-read once, D-spec "Sessions").
      let s: Bytes;
      try {
        s = decryptCkd(result, appKey.a, ckdAppId(env.signer, path), env.ckdNetworkKey);
      } catch {
        const moved = link ? null : await this.movedPath(sessionKey, who.ref, path);
        if (!moved) throw fail('pairing_failed', 'The key failed its check against the pinned network key');
        try {
          s = decryptCkd(result, appKey.a, ckdAppId(env.signer, moved), env.ckdNetworkKey);
          path = moved;
        } catch {
          throw fail('pairing_failed', 'The key failed its check against the pinned network key');
        }
      }
      const prk = extractPrk(s);
      try {
        const addresses = deriveAddresses(prk);
        mark('decrypt');
        const linked = linkedRef ? await this.madeLink(linkedRef, link as LinkPlan) : null;
        // In the background (memory at once, storage after): the login never waits on IndexedDB for it.
        void this.writePin(who.ref, pathOwner(path) as IdentityRef);
        // token_first in an app without email login: the access token is in slot 1, for the directory only (D269).
        // Only once /v1/login has opened the session and the key passed its check, so a refused, failed or cancelled
        // login is never recorded as a login to this app; in the background, never awaited by the login.
        if (recordOn && followKey && who.ref.provider === 'google' && relayed.payload.access === 'follow') this.recordGoogle(who, commitment, relayKey, followKey);
        this.afterword(who, path, linked);
        return { prk, addresses, path, expiresAtMs, maxUses, sessionKey, timings, markedAt: lap, identity: { provider: who.ref.provider, sub: who.ref.sub }, linked };
      } catch (e) {
        prk.fill(0);
        throw e;
      }
    } finally {
      zero(salt, relayKey, relayReadKey, followKey);
    }
  }

  /**
   * A Google login of an app with email (step 7, batch 8b): google-match before any chain call, then the case's
   * screen through the follow-up channel. Returns who opens the session (Google, or the email identity when the user
   * chose "Sign in with email") and the link token to carry, if any.
   */
  private async matchGoogle(
    google: Who,
    first: RelayTokenPayload,
    commitment: { scopeId: string; sessionPublicKey: number[]; expiresAtMs: number; keyIndex: number; maxUses: number; salt: number[] },
    verify: TokenCheck,
    sessionNonceValue: string,
  ): Promise<{ who: Who; link: LinkPlan | null }> {
    const follow = this.follow as FollowChannel;
    let accessToken: string | null = first.accessToken ?? null;
    /** Slot 1's (or a consent answer's) Google error instead of an access token. */
    let accessError: string | null = null;
    if (!accessToken && first.access === 'follow') {
      const a = await follow.answer(0, this.abortCtl.signal);
      this.check();
      if ('accessToken' in a && !('idToken' in a)) accessToken = a.accessToken;
      else if ('error' in a) accessError = a.error;
    }
    let match: GoogleMatch | null = null;
    for (let round = 1; ; round++) {
      // The popup couldn't keep the login's keys for its next page (G-L2): it shows the error; the login ends.
      if (accessError === 'storage_unavailable') throw fail('storage_unavailable', 'This browser blocked the storage the sign-in needs');
      let problem: 'declined' | 'account_mismatch' | 'unavailable' = accessError === 'access_denied' ? 'declined' : 'unavailable';
      if (accessToken) {
        const got = await this.googleMatch(google, accessToken, commitment, first.caseB?.linkTicket);
        accessToken = null;
        if (got === 'account_mismatch') problem = 'account_mismatch';
        else match = got;
      }
      if (match) break;
      // No answer: only an identity that can't be case A logs in (it has a wallet, or is in an account), D255.
      const g = await this.identityOf(google.ref);
      const known = g.status !== 'own' || g.opened || (await this.accountHasMembers(google.ref));
      if (known) return { who: google, link: null };
      if (problem === 'unavailable') throw fail('api_unavailable', 'Hana could not check this Google account against email sign-ins; try again', { reason: 'email_match_unavailable' });
      const reason = problem === 'declined' ? 'email_consent_declined' : 'google_account_mismatch';
      // `round` screens shown so far: `round - 1`; this would be screen `round`.
      if (round > EMAIL_CONSENT_ROUNDS) throw fail('login_cancelled', 'Google’s email address is needed to open a new wallet with Google here', { reason });
      // D264: the popup explains why the address is needed and offers email instead, or Google's screen again.
      const slot = await follow.notice({ t: 'email_consent', reason: problem, loginHint: google.ref.sub }, true);
      const a = await follow.answer(slot, this.abortCtl.signal);
      this.check();
      if ('accessToken' in a && !('idToken' in a)) {
        accessToken = a.accessToken;
        accessError = null;
        continue;
      }
      if ('error' in a) {
        if (a.error === 'access_denied' || a.error === 'storage_unavailable') {
          accessError = a.error;
          continue;
        }
        const err = this.emailAnswerError(a.error);
        throw err.code === 'login_cancelled' ? fail('login_cancelled', 'The sign-in was cancelled', { reason }) : err;
      }
      if (!isRelayToken(a) || a.as !== 'session' || !isJsonFormToken(a.idToken)) throw fail('token_invalid', 'The sign-in answer was refused');
      // "Sign in with email instead": an email login (Google's token is dropped unused).
      return { who: await verify.email(a.idToken, sessionNonceValue), link: null };
    }
    if (!match) throw fail('api_unavailable', 'Hana could not check this Google account against email sign-ins; try again', { reason: 'email_match_unavailable' });

    if (match.decision === 'case_a') {
      if (match.emailToken) {
        // Only the Google-hosted silent rule mints at google-match (D119, D139); anything else is the issuer's error.
        if (!match.googleHosted || match.linkImmediate !== true) throw fail('token_invalid', 'The email issuer’s link token was refused', { reason: 'link_mismatch' });
        return { who: google, link: { token: match.emailToken, immediate: true, join: 1 } };
      }
      // Not hosted (a code first), or a case A that can't link: the popup's screen, then its answer.
      const notice: FollowNotice = match.challenge && match.linkable ? { t: 'link_code', ...match.challenge } : { t: 'use_email', reason: match.linkable ? 'unavailable' : 'provider_taken' };
      const slot = await follow.notice(notice, true);
      const answer = await follow.answer(slot, this.abortCtl.signal);
      this.check();
      if ('error' in answer) throw this.emailAnswerError(answer.error);
      if (!isRelayToken(answer) || !isJsonFormToken(answer.idToken)) throw fail('token_invalid', 'The sign-in answer was refused');
      if (answer.as === 'link' && notice.t === 'link_code') {
        // The code step's own `auto_link` token (case A after this popup's code, D139): judged and verified below.
        return { who: google, link: { token: answer.idToken, immediate: true, join: 1 } };
      }
      if (answer.as !== 'session') throw fail('token_invalid', 'The sign-in answer was refused');
      // "Sign in with email": an email login to the wallet that address opens; Google's token is dropped unused.
      return { who: await verify.email(answer.idToken, sessionNonceValue), link: null };
    }

    if (match.decision === 'case_b' && match.emailToken) {
      // D139: a case-B join only after this popup's own email step, for the address verified there.
      const proof = first.caseB;
      if (!proof || match.linkImmediate === null || peekEmailTokenSub(match.emailToken) !== proof.emailSub) {
        throw fail('token_invalid', 'The email issuer’s link token was refused', { reason: 'link_mismatch' });
      }
      return { who: google, link: { token: match.emailToken, immediate: match.linkImmediate, join: 2 } };
    }
    // C, linked, pending, unlinked, both wallets, a plain Google login in case B: no link, the login's own path.
    return { who: google, link: null };
  }

  /**
   * One google-match (the access token is never revoked, D265, so it can be sent again), retried after a 429 or 503
   * while the login has time (G-M3): the issuer's `retry-after` when it gives one (no retry when that is longer than
   * MATCH_RETRY_MAX_WAIT_MS), else a doubling backoff, at most MATCH_RETRY_BUDGET_MS of waits in all, and never past
   * MATCH_DEADLINE_MARGIN_MS before the login's own deadline. Null when the issuer can't answer; `account_mismatch`
   * when the access token is another Google account's (the user picked another one on Google's screen).
   */
  private async googleMatch(
    google: Who,
    accessToken: string,
    commitment: { scopeId: string; sessionPublicKey: number[]; expiresAtMs: number; keyIndex: number; maxUses: number; salt: number[] },
    linkTicket: string | undefined,
  ): Promise<GoogleMatch | 'account_mismatch' | null> {
    const { ctx } = this;
    const issuer = ctx.issuer as IssuerApi;
    let waited = 0;
    let backoff = MATCH_RETRY_FIRST_MS;
    for (;;) {
      try {
        const m = await issuer.googleMatch({ pk: ctx.config.publishableKey, accessToken, googleIdToken: google.token, commitment, link: true, ...(linkTicket ? { linkTicket } : {}) }, this.abortCtl.signal);
        this.check();
        return m;
      } catch (e) {
        this.check();
        if (e instanceof ApiError && e.code === 'google_account_mismatch') return 'account_mismatch';
        if (!(e instanceof MatchBusy)) return null;
        if (e.retryAfterMs !== null && e.retryAfterMs > MATCH_RETRY_MAX_WAIT_MS) return null;
        const wait = Math.min(e.retryAfterMs ?? backoff, MATCH_RETRY_MAX_WAIT_MS);
        backoff = Math.min(backoff * 2, MATCH_RETRY_MAX_WAIT_MS);
        if (waited + wait > MATCH_RETRY_BUDGET_MS || ctx.perfNow() + wait > this.startedAt + LOGIN_PENDING_MS - MATCH_DEADLINE_MARGIN_MS) return null;
        waited += wait;
        await sleep(ctx.timers, wait, this.abortCtl.signal);
        this.check();
      }
    }
  }

  /**
   * token_first's record (D269, D270), in the background: slot 1's access token, then the issuer's google-record with
   * the login's verified Google token and session commitment. Best effort: nothing it does (a missing slot, the
   * issuer down or slow, a refusal) reaches the login, and it gives up after RECORD_TIMEOUT_MS. A missed record is
   * written at the user's next login (the directory's rows are upserts). No retry: it would only hold the access
   * token longer for a row the next login writes anyway.
   */
  private recordGoogle(google: Who, commitment: MatchRequest['commitment'], relayKey: Uint8Array, followKey: Uint8Array): void {
    const { ctx } = this;
    const issuer = ctx.issuer as IssuerApi;
    const keys = { relayKey: Uint8Array.from(relayKey), followKey: Uint8Array.from(followKey) };
    const ctl = new AbortController();
    const timer = ctx.timers.setTimeout(() => ctl.abort(), RECORD_TIMEOUT_MS);
    const run = async (): Promise<void> => {
      const { id, readKey } = followSlot(keys.followKey, 1);
      const a = await readSlot(ctx.api, ctx.timers, keys.relayKey, id, readKey, ctl.signal, () => (ctl.signal.aborted ? fail('login_timeout', 'The record took too long') : null));
      if (!('accessToken' in a) || 'idToken' in a) return;
      await issuer.googleRecord({ pk: ctx.config.publishableKey, accessToken: a.accessToken, googleIdToken: google.token, commitment }, ctl.signal);
    };
    this.recorded = run()
      .catch(() => undefined)
      .finally(() => {
        ctx.timers.clearTimeout(timer);
        zero(keys.relayKey, keys.followKey);
      });
  }

  /**
   * D133: judge the link from fresh reads of both identities and their accounts, verify the link token against the
   * chain's email keys with exactly the nonce that judgement gives, and refuse on any mismatch. Returns the path's
   * identity (the account root) and the joining identity.
   */
  private async judgeLink(who: Who, link: LinkPlan, sessionHash: Uint8Array, verify: TokenCheck): Promise<{ pathIdentity: IdentityRef; joiner: IdentityRef }> {
    const { ctx } = this;
    const scopeId = ctx.config.scopeId;
    const eSub = peekEmailTokenSub(link.token);
    if (!eSub) throw fail('token_invalid', 'The link token was refused', { reason: 'link_mismatch' });
    const eRef: IdentityRef = { provider: EMAIL_PROVIDER, sub: eSub };
    let open: boolean;
    let x: LinkSide;
    let e: LinkSide;
    try {
      const [o, xi, xa, ei, ea] = await Promise.all([
        ctx.near.linksOpen(),
        ctx.near.identity(scopeId, who.ref.provider, who.ref.sub),
        ctx.near.account(scopeId, who.ref.provider, who.ref.sub),
        ctx.near.identity(scopeId, eRef.provider, eRef.sub),
        ctx.near.account(scopeId, eRef.provider, eRef.sub),
      ]);
      open = o;
      x = { ref: who.ref, identity: xi, account: xa };
      e = { ref: eRef, identity: ei, account: ea };
    } catch {
      this.check();
      throw fail('api_unavailable', 'Could not read the sign-in methods on NEAR', { reason: 'identity_unchecked' });
    }
    this.check();
    if (!open) throw fail('link_refused', 'Linking is not open on this network yet', { reason: 'links_unavailable' });
    let judged;
    try {
      judged = judgeAutoLink({ signer: ctx.env.signer, scopeId, sessionHash, session: x, link: e, immediate: link.immediate });
    } catch (err) {
      if (err instanceof ViewShapeError) throw fail('api_unavailable', 'The NEAR RPC answered another identity', { reason: 'identity_unchecked' });
      throw err;
    }
    if (!judged.ok) {
      if (judged.reason === 'pending') throw fail('link_pending', 'This sign-in method’s link to an account is pending');
      throw fail('link_refused', 'The sign-in methods can’t be linked', { reason: judged.reason === 'not_immediate' ? 'link_mismatch' : judged.reason });
    }
    if (judged.join !== link.join) throw fail('link_refused', 'The link no longer matches the chain', { reason: 'link_mismatch' });
    const target = judged.pathIdentity;
    if (!PATH_PROVIDERS.includes(target.provider)) throw fail('login_method_unavailable', 'This wallet’s sign-in method isn’t supported here', { reason: 'root_unsupported' });
    // D263: the account root's path, unless it is the session identity's own, on both providers (the target side's
    // view named it: the email identity's in case A, the session identity's in case B).
    if (!sameRef(target, who.ref)) {
      const via = link.join === JOIN_SESSION_IDENTITY ? e : x;
      await this.confirmed(via.ref, via.identity, target);
    }
    const checked = await verify.emailWithNonce(link.token, judged.nonce);
    if (checked.sub !== eSub) throw fail('token_invalid', 'The link token was refused', { reason: 'link_mismatch' });
    return { pathIdentity: judged.pathIdentity, joiner: link.join === 1 ? who.ref : eRef };
  }

  /**
   * GET /v1/app for this login, asked once more after a network error or a 5xx (the failed request was dropped from
   * the cache, so the second call is a fresh request): a cold or briefly failing API shouldn't end the sign-in. A
   * refusal (4xx) is final.
   */
  private async appConfigWithRetry(): Promise<AppConfig> {
    try {
      return await this.ctx.appConfig();
    } catch (e) {
      this.check();
      if (e instanceof ApiError && e.status > 0 && e.status < 500) throw e;
      return this.ctx.appConfig();
    }
  }

  /**
   * The path a session of `self` derives (batch 7): its own, or its account root's, which must then be confirmed on
   * both providers (D263); a pending member is refused.
   */
  private async ownPath(self: IdentityRef): Promise<string> {
    const view = await this.identityOf(self);
    let p;
    try {
      p = pathIdentity(this.ctx.config.scopeId, self, view);
    } catch {
      throw fail('api_unavailable', 'The NEAR RPC answered another identity', { reason: 'identity_unchecked' });
    }
    if (p.kind === 'pending') {
      throw fail('link_pending', 'This sign-in method’s link to an account is pending', p.effectiveAtMs === null ? undefined : { effectiveAtMs: p.effectiveAtMs });
    }
    if (p.kind === 'unsupported') throw fail('login_method_unavailable', 'This wallet’s sign-in method isn’t supported here', { reason: 'root_unsupported' });
    if (p.linked) await this.confirmed(self, view, p.identity);
    return loginPath(this.ctx.config.scopeId, p.identity.provider, p.identity.sub, KEY_INDEX);
  }

  /** `get_identity` of `self` on the vault's RPC, its key checked against the one computed here (W-L2). */
  private async identityOf(self: IdentityRef): Promise<IdentityView> {
    let v: IdentityView;
    try {
      v = await this.ctx.near.identity(this.ctx.config.scopeId, self.provider, self.sub);
    } catch (e) {
      this.check();
      if (e instanceof VaultError) throw e;
      throw fail('api_unavailable', 'Could not read the sign-in method on NEAR', { reason: 'identity_unchecked' });
    }
    this.check();
    if (v.key !== identityKeyHex(this.ctx.config.scopeId, self.provider, self.sub)) throw fail('api_unavailable', 'The NEAR RPC answered another identity', { reason: 'identity_unchecked' });
    return v;
  }

  /** D263: `path`, named by `via`'s view, confirmed on both providers; refused (`api_unavailable`) otherwise. */
  private async confirmed(via: IdentityRef, viaView: IdentityView, path: IdentityRef): Promise<void> {
    try {
      await confirmPath({ scopeId: this.ctx.config.scopeId, via, viaView, path, views: this.ctx.near.independent(this.abortCtl.signal) });
    } catch (e) {
      this.check();
      if (e instanceof PathCheckError) {
        throw fail('api_unavailable', e.reason === 'path_disputed' ? 'NEAR providers disagree about the wallet this sign-in opens; try again later' : 'The wallet this sign-in opens could not be confirmed on NEAR; try again', {
          reason: e.reason,
        });
      }
      throw e;
    }
    this.check();
  }

  /**
   * D263: the root this device last opened for `self`. The same, none yet, or `self` (own → member: a link activated,
   * already confirmed on both providers): nothing more. Any other change (unlinked: member → own; another account)
   * is confirmed on both providers now, or refused. A read that fails or doesn't answer within PIN_READ_TIMEOUT_MS (a
   * stuck IndexedDB) fails closed: the path is confirmed on both providers unless it is `self`'s own (which only the
   * MPC can answer for: the pairing check covers it).
   */
  private async checkPin(self: IdentityRef, now: IdentityRef): Promise<void> {
    const pins = this.ctx.pins;
    if (!pins) return;
    const scopeId = this.ctx.config.scopeId;
    const selfKey = identityKeyHex(scopeId, self.provider, self.sub);
    const nowKey = identityKeyHex(scopeId, now.provider, now.sub);
    const pinned = await new Promise<string | null | 'unknown'>((resolve) => {
      // Real time, not the injected clock: what it races is real I/O (a test clock that skips ahead would let it win
      // against a read that is merely slow).
      const timer = realTimers.setTimeout(() => resolve('unknown'), PIN_READ_TIMEOUT_MS);
      pins.get(selfKey).then(
        (v) => {
          realTimers.clearTimeout(timer);
          resolve(v);
        },
        () => {
          realTimers.clearTimeout(timer);
          resolve('unknown');
        },
      );
    });
    this.check();
    if (pinned === 'unknown') {
      if (nowKey !== selfKey) await this.confirmed(self, await this.identityOf(self), now);
      return;
    }
    if (!pinned || pinned === nowKey || pinned === selfKey) return;
    await this.confirmed(self, await this.identityOf(self), now);
  }

  /** After a derivation that passed its pairing check: the root `self` opened, for the next login's checkPin. */
  private async writePin(self: IdentityRef, root: IdentityRef): Promise<void> {
    try {
      const scopeId = this.ctx.config.scopeId;
      await this.ctx.pins?.set(identityKeyHex(scopeId, self.provider, self.sub), identityKeyHex(scopeId, root.provider, root.sub));
    } catch {
      // Storage: the next login has no pin to compare, as on a new device.
    }
  }

  private async accountHasMembers(self: IdentityRef): Promise<boolean> {
    try {
      const a = await this.ctx.near.account(this.ctx.config.scopeId, self.provider, self.sub);
      return a !== null && a.members.length > 0;
    } catch {
      this.check();
      throw fail('api_unavailable', 'Could not read the sign-in method on NEAR', { reason: 'identity_unchecked' });
    }
  }

  /**
   * After a pairing failure: the path the contract gave the session, if `get_identity` now names it for this
   * identity (a link activated between the read and the transaction); else null.
   */
  private async movedPath(sessionKey: SessionKey, self: IdentityRef, used: string): Promise<string | null> {
    let s: SessionView | null;
    let view: IdentityView;
    let p;
    try {
      [s, view] = await Promise.all([this.ctx.near.getSession(sessionKey.publicKey), this.ctx.near.identity(this.ctx.config.scopeId, self.provider, self.sub)]);
      p = pathIdentity(this.ctx.config.scopeId, self, view);
    } catch {
      return null;
    }
    this.check();
    if (!s || p.kind !== 'path' || s.scope_id !== this.ctx.config.scopeId) return null;
    const now = loginPath(this.ctx.config.scopeId, p.identity.provider, p.identity.sub, KEY_INDEX);
    if (now === used || s.path !== now) return null;
    // The session and the view come from one provider: a root's path is taken only once both providers confirm it.
    if (p.linked) await this.confirmed(self, view, p.identity);
    return now;
  }

  /** The link this login made, from the joiner's view (pending: when it activates). */
  private async madeLink(joiner: IdentityRef, link: LinkPlan): Promise<MadeLink> {
    const now = Math.floor(this.ctx.clock.now());
    if (link.immediate) return { provider: joiner.provider as LoginMethod, status: 'active', effectiveAtMs: now };
    try {
      const v = await this.ctx.near.identity(this.ctx.config.scopeId, joiner.provider, joiner.sub);
      return { provider: joiner.provider as LoginMethod, status: v.status === 'member' ? 'active' : 'pending', effectiveAtMs: v.effectiveAtMs ?? now };
    } catch {
      return { provider: joiner.provider as LoginMethod, status: 'pending', effectiveAtMs: now };
    }
  }

  /** An email step's `{error}` answer as the login's error (D245). */
  private emailAnswerError(error: string): VaultError {
    // The popup couldn't store its next page's keys (G-L2): it says so itself.
    if (error === 'storage_unavailable') return fail('storage_unavailable', 'This browser blocked the storage the sign-in needs');
    const email = Object.hasOwn(EMAIL_RELAY_ERRORS, error) ? EMAIL_RELAY_ERRORS[error] : undefined;
    if (email === 'rate_limited') return fail('rate_limited', 'Too many attempts, try again later');
    if (email === 'login_method_unavailable') return fail('login_method_unavailable', 'Email sign-in is not available for this app');
    if (email === 'code_invalid') return fail('code_invalid', 'The sign-in code was wrong');
    if (email === 'challenge_expired') return fail('challenge_expired', 'The sign-in code expired');
    return fail('login_cancelled', 'The sign-in was cancelled');
  }

  /**
   * Step 11 (background): the vault's last word to the popup, `done` with the account's link banners, and a banner's
   * Cancel or Remove when the user picks one. Never fails the login (it already succeeded).
   */
  private afterword(who: Who, path: string, linked: MadeLink | null): void {
    const follow = this.follow;
    this.follow = null;
    if (!follow) return;
    void new Afterword(this.ctx, follow, who, path, linked).run().finally(() => follow.close());
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

  /** Long-polls the relay until it holds the popup's answer; returns it (and, pk_test_ apps, the popup's timings). */
  private async readRelay(relayId: string, relayReadKey: Uint8Array, relayKey: Uint8Array): Promise<Relayed> {
    const { api, timers } = this.ctx;
    const payload = await readSlot(api, timers, relayKey, relayId, relayReadKey, this.abortCtl.signal, () => this.abortError);
    if ('error' in payload) {
      // The email step's cancel (D245), only in a login that offered email; anything else is Google's answer.
      if (this.emailOffered && Object.hasOwn(EMAIL_RELAY_ERRORS, payload.error)) throw this.emailAnswerError(payload.error);
      // The popup refused an ID token with a claim outside the allow-list before relaying it (D270).
      if (payload.error === 'token_has_pii') {
        const claim = 'claim' in payload && typeof payload.claim === 'string' ? { claim: payload.claim.slice(0, 64) } : undefined;
        throw fail('token_has_pii', 'The Google token carries a claim outside the allow-list', claim);
      }
      throw fail('google_error', 'Google returned an error', { error: payload.error });
    }
    if (!isRelayToken(payload)) throw fail('token_invalid', 'The sign-in answer was refused');
    // The follow-up fields count only in a login that offered them (a Google-only popup never sends them); a
    // record-only login's token may only say its access token follows.
    const extras = payload.accessToken !== undefined || payload.caseB !== undefined || payload.as !== undefined;
    if (!this.emailOffered && (extras || (payload.access !== undefined && !this.recordOffered))) {
      throw fail('token_invalid', 'The sign-in answer was refused');
    }
    const held = payload._heldMs;
    const { _heldMs, ...clean } = payload;
    void _heldMs;
    return { payload: clean as RelayTokenPayload, popupTimings: payload.timings ?? null, heldMs: held ?? null };
  }
}

/** `hana.linkAccount({method})`'s input: the logged-in wallet (its path names the account root). */
export interface LinkTaskInput {
  method: LoginMethod;
  path: string;
}

/**
 * `hana.linkAccount({method})` (spec "Explicit linking"; build plan batch 8b): in the login popup, a fresh sign-in of
 * the new method N over the `link_new` nonce, then (follow-up `prove`) a fresh sign-in of the account's root over
 * `link_account`, then `POST /v1/link` (`link_identity`, pending for `change_delay_ms`). Every precondition the
 * contract checks is judged first from the vault's own reads (room, N without a wallet or an account), so a refused link
 * costs no gas. The popup's last word is the pending banner.
 */
export class PendingLink extends PopupTask<MadeLink> {
  constructor(
    ctx: LoginContext,
    mode: LoginMode,
    popupBlocked: boolean,
    private readonly task: LinkTaskInput,
  ) {
    super(ctx, mode, popupBlocked);
    this.start();
  }

  protected run(): Promise<MadeLink> {
    return this.withStop(() => this.runLink());
  }

  private async runLink(): Promise<MadeLink> {
    const { ctx, task } = this;
    const { env, config } = ctx;
    const scopeId = config.scopeId;
    const root = pathOwner(task.path);
    if (!root) throw fail('link_refused', 'This wallet can’t take another sign-in method', { reason: 'unsupported' });
    let app: AppConfig;
    try {
      app = await ctx.appConfig();
    } catch (e) {
      this.check();
      throw e instanceof ApiError ? apiErrorToVault(e) : fail('api_unavailable', 'Could not read the app configuration');
    }
    this.check();
    if (app.signer !== env.signer || app.scopeId !== scopeId) throw fail('config_mismatch', 'The app configuration does not match this vault');
    const emailAud = `email:${scopeId}`;
    const emailOn = !!(env.emailIssuerUrl && env.emailIss && app.loginMethods?.includes('email') && app.email?.aud === emailAud);
    if (task.method === 'email' && !emailOn) throw fail('login_method_unavailable', 'Email sign-in is not available for this app');
    if (root.provider === 'email' && !emailOn) throw fail('login_method_unavailable', 'Email sign-in is not available for this app');
    this.emailOffered = emailOn;
    const emailChain = emailOn ? this.readEmailChain(emailAud) : null;

    // The account as it is now: room for a member of this provider, links open.
    let open: boolean;
    let account;
    try {
      [open, account] = await Promise.all([ctx.near.linksOpen(), ctx.near.account(scopeId, root.provider, root.sub)]);
    } catch {
      this.check();
      throw fail('api_unavailable', 'Could not read the wallet’s sign-in methods on NEAR', { reason: 'identity_unchecked' });
    }
    this.check();
    if (!open) throw fail('link_refused', 'Linking is not open on this network yet', { reason: 'links_unavailable' });
    if (account && (account.root.provider !== root.provider || account.root.sub !== root.sub)) throw fail('link_refused', 'This wallet’s sign-in methods changed; sign in again', { reason: 'link_mismatch' });
    const members = account?.members ?? [];
    if (members.length >= MAX_ACCOUNT_MEMBERS) throw fail('link_refused', 'This wallet already has the most sign-in methods it can', { reason: 'account_full' });
    if (root.provider === task.method || members.some((m) => m.provider === task.method)) throw fail('link_refused', 'This wallet already has a sign-in method of this kind', { reason: 'provider_taken' });
    const epoch = account?.epoch ?? 0;
    const rootIk = identityKey(scopeId, root.provider, root.sub);

    const sessionKey = await newSessionKey();
    this.check();
    const salt = randomBytes(32);
    const relayKey = randomBytes(32);
    const relayReadKey = randomBytes(32);
    const followKey = randomBytes(32);
    const sessionSalt = randomBytes(32);
    try {
      const relayId = relayIdFor(relayReadKey);
      const newNonce = linkNewNonce(env.signer, scopeId, rootIk, task.method, epoch, salt);
      const prove: FollowProve =
        task.method === 'google'
          ? { method: 'google', nonce: newNonce, loginHint: null }
          : { method: 'email', purpose: 'link_new', commitment: { scopeId, rootIk: identityKeyHex(scopeId, root.provider, root.sub), epoch, salt: Array.from(salt) } };
      // The session fields are unused by a link task, but well formed (the popup checks the nonce over them).
      const expiresAtMs = Math.floor(ctx.clock.now()) + LOGIN_PENDING_MS;
      const nonce = sessionNonce({ signer: env.signer, scopeId, sessionPublicKey: sessionKey.publicKey, expiresAtMs, keyIndex: KEY_INDEX, maxUses: 1, salt: sessionSalt });
      this.params = {
        v: 1,
        t: 'hana:auth-params',
        pk: config.publishableKey,
        appName: config.appName,
        parentOrigin: ctx.parentOrigin,
        scopeId,
        signer: env.signer,
        clientId: app.google.clientId,
        mode: app.google.mode,
        sessionPublicKey: sessionKey.publicKey,
        expiresAtMs,
        salt: Uint8Array.from(sessionSalt),
        keyIndex: KEY_INDEX,
        maxUses: 1,
        nonce,
        relayId,
        relayKey: Uint8Array.from(relayKey),
        ...(emailOn ? { methods: ['google', 'email'] as LoginMethod[] } : {}),
        followKey: Uint8Array.from(followKey),
        task: { kind: 'link', provider: task.method, prove },
      };
      this.follow = new FollowChannel(ctx.api, ctx.timers, Uint8Array.from(relayKey), Uint8Array.from(followKey));

      await this.helloSeen;
      this.check();
      this.dropSecrets();

      // N's proof, in the login's first slot.
      const first = await readSlot(ctx.api, ctx.timers, relayKey, relayId, relayReadKey, this.abortCtl.signal, () => this.abortError);
      if ('error' in first) {
        if (Object.hasOwn(EMAIL_RELAY_ERRORS, first.error)) throw fail('login_cancelled', 'The sign-in was cancelled');
        throw fail('google_error', 'Google returned an error', { error: first.error });
      }
      if (!isRelayToken(first) || first.as !== undefined || first.accessToken !== undefined || first.access !== undefined || first.caseB !== undefined) throw fail('token_invalid', 'The sign-in answer was refused');
      const verify = new TokenCheck(ctx, app, emailChain, () => this.check());
      const fresh = task.method === 'google' ? await verify.google(first.idToken, newNonce) : await verify.email(first.idToken, newNonce);
      const newRef = fresh.ref;
      // N may not have a wallet, nor be in an account (the contract's `Sign-in method already has a wallet`, `… is
      // already linked`).
      let nView: IdentityView;
      let nAccount;
      try {
        [nView, nAccount] = await Promise.all([ctx.near.identity(scopeId, newRef.provider, newRef.sub), ctx.near.account(scopeId, newRef.provider, newRef.sub)]);
      } catch {
        this.check();
        throw fail('api_unavailable', 'Could not read the sign-in method on NEAR', { reason: 'identity_unchecked' });
      }
      this.check();
      const newIkHex = identityKeyHex(scopeId, newRef.provider, newRef.sub);
      if (nView.key !== newIkHex) throw fail('api_unavailable', 'The NEAR RPC answered another identity', { reason: 'identity_unchecked' });
      if (nView.status !== 'own' || (nAccount !== null && nAccount.members.length > 0)) throw fail('link_refused', 'This sign-in method is already linked to a wallet', { reason: 'already_linked' });
      if (nView.opened) throw fail('link_refused', 'This sign-in method already has a wallet of its own', { reason: 'has_wallet' });

      // The account's proof: a fresh sign-in of the root over `link_account`.
      const accountNonce = linkAccountNonce(env.signer, scopeId, rootIk, fromHex(newIkHex), epoch, salt);
      const rootProve: FollowProve =
        root.provider === 'google'
          ? { method: 'google', nonce: accountNonce, loginHint: root.sub }
          : {
              method: 'email',
              purpose: 'link_account',
              commitment: { scopeId, rootIk: identityKeyHex(scopeId, root.provider, root.sub), newIk: newIkHex, epoch, salt: Array.from(salt) },
            };
      const follow = this.follow as FollowChannel;
      const slot = await follow.notice({ t: 'prove', why: 'link_account', prove: rootProve, provider: root.provider }, true);
      const answer = await follow.answer(slot, this.abortCtl.signal);
      this.check();
      if ('error' in answer) throw fail('login_cancelled', 'The sign-in was cancelled');
      if (!isRelayToken(answer) || answer.as !== 'proof') throw fail('token_invalid', 'The sign-in answer was refused');
      const acct = root.provider === 'google' ? await verify.google(answer.idToken, accountNonce) : await verify.email(answer.idToken, accountNonce);
      if (acct.ref.provider !== root.provider || acct.ref.sub !== root.sub) throw fail('link_refused', 'Sign in with the method that opened this wallet', { reason: 'wrong_account' });

      let effectiveAtMs: number;
      try {
        effectiveAtMs = (await ctx.api.link({ accountJwt: answer.idToken, newJwt: first.idToken, epoch, salt: Array.from(salt) })).result.effectiveAtMs;
      } catch (e) {
        this.check();
        if (e instanceof ApiError) throw linkedApiError(e);
        throw fail('api_unavailable', 'The link could not be sent');
      }
      const made: MadeLink = { provider: task.method, status: 'pending', effectiveAtMs };
      this.follow = null;
      void follow.notice({ t: 'done', banners: [{ provider: task.method, status: 'pending', effectiveAtMs, fresh: true }] }).finally(() => follow.close());
      return made;
    } finally {
      zero(salt, relayKey, relayReadKey, followKey, sessionSalt);
    }
  }

  private async readEmailChain(aud: string): Promise<EmailChain | 'unchecked'> {
    const { near } = this.ctx;
    try {
      const [scope, keys, policy] = await Promise.all([near.scopeForClient(EMAIL_PROVIDER, aud), near.issuerKeys(EMAIL_PROVIDER), near.selfIssued(EMAIL_PROVIDER)]);
      return { scope, keys: keys ?? [], policy };
    } catch {
      return 'unchecked';
    }
  }
}

/** The contract's `MAX_MEMBERS`. */
const MAX_ACCOUNT_MEMBERS = 3;

/** The token checks of one login: Google's against its JWKS, email tokens against the chain's keys and policy. */
class TokenCheck {
  constructor(
    private readonly ctx: LoginContext,
    private readonly app: AppConfig,
    private readonly emailChain: Promise<EmailChain | 'unchecked'> | null,
    private readonly check: () => void,
  ) {}

  /** The login's first token: Google's (`as` absent) or an email token from /login/email. */
  async first(payload: RelayTokenPayload, nonce: string): Promise<Who> {
    if (payload.as !== undefined) throw fail('token_invalid', 'The sign-in answer was refused');
    if (isJsonFormToken(payload.idToken)) {
      if (payload.accessToken !== undefined || payload.access !== undefined || payload.caseB !== undefined) throw fail('token_invalid', 'The sign-in token was refused');
      return this.email(payload.idToken, nonce);
    }
    return this.google(payload.idToken, nonce);
  }

  async google(idToken: string, nonce: string): Promise<Who> {
    let jwksUnavailable = false;
    const verified = await verifyGoogleIdToken(idToken, {
      clientId: this.app.google.clientId,
      nonce,
      nowMs: this.ctx.clock.now(),
      jwks: async (kid) => {
        try {
          return await this.ctx.jwks(kid);
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
    return { ref: { provider: 'google', sub: verified.token.sub }, token: idToken, expMs: verified.token.exp * 1000 };
  }

  /** An email token for this scope with `nonce` (a session's), against the chain's keys and the scope's client. */
  async email(token: string, nonce: string): Promise<Who> {
    const checked = await this.emailWithNonce(token, nonce);
    return { ref: { provider: EMAIL_PROVIDER, sub: checked.sub }, token, expMs: checked.exp * 1000 };
  }

  async emailWithNonce(token: string, nonce: string): Promise<{ sub: string; exp: number }> {
    if (!this.emailChain) throw fail('token_invalid', 'The sign-in token was refused');
    const chain = await this.emailChain;
    this.check();
    const { config, env } = this.ctx;
    if (chain === 'unchecked') throw fail('api_unavailable', 'Could not read the email sign-in keys on NEAR', { reason: 'email_unchecked' });
    if (chain.scope !== config.scopeId) throw fail('config_mismatch', 'The app’s email client does not match the on-chain registry', { reason: 'scope_mismatch' });
    const checked = await verifyEmailIdToken(token, { iss: env.emailIss as string, aud: `email:${config.scopeId}`, nonce, nowMs: this.ctx.clock.now(), keys: chain.keys, policy: chain.policy });
    this.check();
    if (!checked.ok) {
      if (checked.code === 'key_pending') throw fail('api_unavailable', 'The email sign-in key is not active yet; try signing in again in a few minutes');
      throw fail('token_invalid', 'The email token was refused');
    }
    return { sub: checked.token.sub, exp: checked.token.exp };
  }
}

/** One banner action the vault offered: what it changes, and the nonce its proof must carry. */
interface OfferedAction {
  kind: 'cancel' | 'unlink';
  provider: string;
  memberKey: string;
  epoch: number;
  salt: Uint8Array;
  nonce: string;
}

/**
 * Step 11: the link banners of the logged-in wallet (spec "Notices"), from `get_account` on the vault's own RPC: a
 * pending method (Cancel, by any active identity), the method this login added, and methods added in the last 7 days
 * (Remove, by the root). A Cancel or Remove is proved by a fresh sign-in of this login's method over the
 * `link_change` nonce, then relayed.
 */
class Afterword {
  private readonly signal = new AbortController();

  constructor(
    private readonly ctx: LoginContext,
    private readonly follow: FollowChannel,
    private readonly who: Who,
    private readonly path: string,
    private readonly linked: MadeLink | null,
  ) {}

  async run(): Promise<void> {
    const timer = this.ctx.timers.setTimeout(() => this.signal.abort(), AFTERWORD_MS);
    const offered: OfferedAction[] = [];
    try {
      const banners = await this.banners(offered).catch(() => [] as LinkBanner[]);
      const slot = await this.follow.notice({ t: 'done', banners });
      if (offered.length === 0) return;
      const answer = await this.follow.answer(slot, this.signal.signal).catch(() => null);
      if (!answer || !isRelayToken(answer) || answer.as !== 'proof') return;
      const action = await this.match(answer.idToken, offered);
      if (!action) {
        await this.follow.notice({ t: 'stop', code: 'token_invalid' });
        return;
      }
      try {
        await this.ctx.api.linkChange(action.kind, { jwt: answer.idToken, memberKey: action.memberKey, epoch: action.epoch, salt: Array.from(action.salt) });
      } catch (e) {
        const code = e instanceof ApiError && /^[a-z_]{1,64}$/u.test(e.code) ? (e.code === 'contract_rejected' ? 'link_refused' : e.code) : 'api_unavailable';
        await this.follow.notice({ t: 'stop', code });
        return;
      }
      this.ctx.linkRemoved?.(action.provider);
      await this.follow.notice({ t: 'done', banners: [] });
    } finally {
      this.ctx.timers.clearTimeout(timer);
      for (const a of offered) zero(a.salt);
    }
  }

  private async banners(offered: OfferedAction[]): Promise<LinkBanner[]> {
    const { ctx, who } = this;
    const scopeId = ctx.config.scopeId;
    const [, provider, sub] = this.path.split('#') as [string, string, string];
    const account = await ctx.near.account(scopeId, provider, sub);
    if (!account) return [];
    const now = ctx.clock.now();
    const rootIk = identityKey(scopeId, account.root.provider, account.root.sub);
    const whoKey = identityKeyHex(scopeId, who.ref.provider, who.ref.sub);
    const whoIsRoot = account.root.provider === who.ref.provider && account.root.sub === who.ref.sub;
    const out: LinkBanner[] = [];
    for (const m of account.members) {
      if (m.provider !== 'google' && m.provider !== 'email') continue;
      const fresh = !!this.linked && this.linked.provider === m.provider;
      const recent = m.active && m.effectiveAtMs > now - RECENT_LINK_MS;
      if (m.active && !fresh && !recent) continue;
      // The method this login used is named only when this login added it ("your Google sign-in now opens this wallet").
      const self = m.key === whoKey;
      if (self && !fresh) continue;
      const banner: LinkBanner = { provider: m.provider, status: m.active ? 'active' : 'pending', effectiveAtMs: m.effectiveAtMs, fresh };
      // Cancel: any active identity of the account; Remove: the root (the member itself would be signing in with it).
      const kind = self ? null : m.active ? (whoIsRoot ? 'unlink' : null) : 'cancel';
      if (kind && out.length < 4) {
        const salt = randomBytes(32);
        const nonce = linkChangeNonce(ctx.env.signer, scopeId, kind, rootIk, fromHex(m.key), account.epoch, salt);
        const prove: FollowProve =
          who.ref.provider === 'google'
            ? { method: 'google', nonce, loginHint: who.ref.sub }
            : { method: 'email', purpose: 'link_change', commitment: { scopeId, action: kind, rootIk: identityKeyHex(scopeId, account.root.provider, account.root.sub), memberIk: m.key, epoch: account.epoch, salt: Array.from(salt) } };
        banner.action = { kind, prove };
        offered.push({ kind, provider: m.provider, memberKey: m.key, epoch: account.epoch, salt, nonce });
      }
      if (out.length < 4) out.push(banner);
    }
    return out;
  }

  /** The offered action whose `link_change` nonce the proof carries, signed in as this login's identity. */
  private async match(token: string, offered: OfferedAction[]): Promise<OfferedAction | null> {
    const { ctx, who } = this;
    let app: AppConfig;
    try {
      app = await ctx.appConfig();
    } catch {
      return null;
    }
    const check = new TokenCheck(ctx, app, who.ref.provider === 'email' ? this.emailChain() : null, () => undefined);
    for (const a of offered) {
      try {
        const got = who.ref.provider === 'google' ? await check.google(token, a.nonce) : await check.email(token, a.nonce);
        if (got.ref.sub === who.ref.sub) return a;
      } catch {
        // Not this action's nonce: try the next.
      }
    }
    return null;
  }

  private emailChain(): Promise<EmailChain | 'unchecked'> {
    const { near, config } = this.ctx;
    return Promise.all([near.scopeForClient(EMAIL_PROVIDER, `email:${config.scopeId}`), near.issuerKeys(EMAIL_PROVIDER), near.selfIssued(EMAIL_PROVIDER)]).then(
      ([scope, keys, policy]) => ({ scope, keys: keys ?? [], policy }),
      () => 'unchecked' as const,
    );
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
  /** An automatic link (D133): the counter-1 signature is over the linked CKD payload, and the recovery is D137's. */
  link: { jwt: string; immediate: boolean } | null;
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
    const key = this.i.sessionKey.keyPair.privateKey;
    const signature = this.i.link ? await signDeriveLinked(key, this.i.pk1, this.i.pk2, this.i.link.jwt, this.i.link.immediate) : await signDerive(key, 1, this.i.pk1, this.i.pk2);
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
        const outcome = this.i.link ? await this.onLinkedError(e) : await this.onRelayError(e, 'login');
        if (outcome === 'resend') continue;
        return outcome;
      }
    }
  }

  /**
   * A linked login's failure (D137): only "not executed" answers are resent, and a known transaction that already
   * returned the key is used. Anything else that may have published (the session key in use, a timeout, an MPC
   * failure, an unknown outcome) revokes the session, which is never derived on with the plain payload, and the user
   * signs in again with a fresh session, Google token and link token (D257).
   */
  private async onLinkedError(e: unknown): Promise<CkdResult | 'resend'> {
    if (e instanceof ApiError) {
      this.noteTx(e.nearTx);
      if (e.code === 'issuer_key_pending') return this.keyPending(e);
      if (NOT_EXECUTED.has(e.code)) {
        if (!this.resent && this.resendable()) {
          this.resent = true;
          return 'resend';
        }
        throw fail('api_unavailable', 'The Hana relayer is unavailable');
      }
      // Refused before relaying (the API's precheck): nothing published.
      if (e.status === 409 || e.status === 422 || e.status === 400 || e.status === 401 || e.status === 403) {
        if (!(e.code === 'session_exists' || (e.code === 'contract_rejected' && e.details.reason === 'session_key_in_use') || e.code === 'ckd_failed')) {
          throw linkedApiError(e);
        }
      }
      if (e.nearTx && (e.code === 'timeout' || e.code === 'near_error' || e.code === 'bad_contract_result' || e.code === 'relayer_unavailable')) {
        const result = ckdResultOf((await this.poll(e.nearTx, TX_POLL_FOR_MS)) ?? { kind: 'pending' });
        if (result) return result;
      }
    }
    await this.revoke();
    throw fail('derive_failed', 'The linked sign-in could not finish; sign in again', { reason: 'link_restart' });
  }

  /** revoke_session at the next counter, best effort (no live session: nothing to revoke). */
  private async revoke(): Promise<void> {
    try {
      const session = await this.ctx.near.getSession(this.i.sessionKey.publicKey);
      if (!session) return;
      const counter = session.used + 1;
      const signature = await signRevoke(this.i.sessionKey.keyPair.privateKey, counter);
      await this.ctx.api.revokeSession({ sessionPublicKey: Array.from(this.i.sessionKey.publicKey), counter, signature: Array.from(signature) });
    } catch {
      // Unreachable now: the session expires on its own, and it is never derived on.
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
        // D136: a session opened on this identity's own path before it joined an account never derives; a new sign-in
        // opens a session on the account's path.
        if (e.code === 'identity_linked') throw fail('session_consumed', 'This sign-in method now opens its account’s wallet; continue signing in', { reason: 'identity_linked' });
        if (e.status === 400 || e.status === 409 || e.status === 422) throw fail('derive_failed', 'The key derivation was refused', { api: `${e.status} ${e.code}` });
        throw apiErrorToVault(e);
      }
    }
  }
}

/** A linked login's refusal before relaying, as the login's error (the precheck's codes, D232). */
function linkedApiError(e: ApiError): VaultError {
  if (e.code === 'link_refused') {
    const reason = typeof e.details.reason === 'string' && /^[a-z_]{1,32}$/u.test(e.details.reason) ? e.details.reason : 'link_mismatch';
    return fail('link_refused', 'The sign-in methods can’t be linked', { reason });
  }
  if (e.code === 'links_unavailable') return fail('link_refused', 'Linking is not open on this network yet', { reason: 'links_unavailable' });
  return apiErrorToVault(e);
}
