// The vault (docs/batch-b-spec.md "Partner ↔ vault handshake", "Port methods", "Login", "Key persistence",
// "Signing and approval", "Auto-approve policies", "Key export"): a hidden iframe on vaultOrigin that holds the keys.
//
// - It runs only inside a frame and only with the inlined config (boot.ts checks both before constructing it).
// - It accepts exactly one hana:hello: from window.parent, from an origin the app allows (and equal to
//   location.ancestorOrigins[0] where the browser has it), with one MessagePort. It pins that origin and port and drops
//   every later hello and every other window message from the parent.
// - It says `connected` on the port as soon as it takes the hello, before anything that waits on storage or the
//   network, so the SDK can tell a vault that never answered from one that is slow to unlock.
// - After the handshake it unlocks a persisted record (one API call, no chain call), replies `ready`, then fetches
//   GET /v1/app in the background (never on the unlock path).
// - Requests arrive on the port only. Signatures need a guarded Approve in a Hana popup, or a match against an
//   auto-approve policy the user accepted. Key material never crosses postMessage or the BroadcastChannel.
// - The inlined policy is re-checked against GET /v1/app while the vault stays open (every POLICY_REFRESH_MS, and
//   before an auto-sign when the last check is older than POLICY_FRESH_MS): a policy removed or changed since the page
//   loaded no longer auto-signs anything, and the request goes to the approval popup. Raw signing is re-checked the
//   same way before every raw request: once GET /v1/app says 'off', raw requests are refused until a reload.
// - An auto-approve consent exists on the API too (Hana Home): the vault records it before storing it, and auto-signs
//   only with an `'active'` answer for that consent from GET /v1/app younger than POLICY_FRESH_MS (the same read). A
//   consent's id never leaves the vault except to the API.
// - The session's share is checked too (Hana Home's "Sign out this device", D680): about once a minute (STATUS_READ_MS)
//   while a session with a share is live in this tab and the tab is shown, every STATUS_IDLE_READ_MS once the tab has
//   seen no activity for STATUS_IDLE_AFTER_MS, at once when a hidden tab is shown again, and at most every
//   STATUS_READ_BACKOFF_MAX_MS after checks that fail. With a policy it is the policy's own GET /v1/app, never a second
//   request; otherwise the light POST /v1/vault/share-status (D690), each the other's fallback. `'revoked'` ends the
//   session; a check never extends one (no touch, no idle-limit activity). An approval-popup signature and a cached
//   identity token need a `'live'` answer younger than SHARE_FRESH_MS (checked first), or, when the API can't answer,
//   one younger than SHARE_GRACE_MS.
// - A pk_test_ app never signs for a mainnet (docs/decisions.md D39): the request is refused before any popup or
//   policy.
// - PRK is zeroed after the app's idle limit (`idleTtlMs`) without a request that uses the key (a signature, an
//   export, revoke-other-devices, an auto-approve consent request), not only at the session's end. Status, address and
//   auto-approve-status reads don't count, so polling them can't keep the key in memory. In 'session' mode the session
//   stays dormant (addresses known, no key; those reads keep answering) and the next request that uses the key unlocks
//   the record again, which works while the server share is alive; in 'none' mode it ends.
// - One session per app per device: a login replaces the record and revokes the shares it replaces, a logout ends
//   every tab's session, and a `revoked` broadcast ends only the tabs holding that share.
// - A session ended because the API said its share was revoked (a status read's `'revoked'`, a `410 share_revoked`, a
//   newer login on this device, another tab's `signedOut` broadcast) says so (D695): `disconnectReason {signed_out}`
//   just before its `disconnect`, and the requests it refuses carry `data.reason: 'signed_out'` (code still 4900). A
//   session that ended any other way (logout, expiry, a share expired or unknown, a lost record) says nothing more.
import {
  type AccountMethod,
  type AccountResult,
  type AppConfig,
  logoUrlOn,
  type LoginMethod,
  ErrorCode,
  type Jwk,
  isTestPublishableKey,
  mainnetOfRequest,
  type LoginResult,
  NEVER_AUTO_APPROVED_KINDS,
  type DisconnectReason,
  type PortEventMap,
  type PortEventName,
  type PortRequest,
  type PortResultMap,
  type StatusResult,
  type VaultBroadcast,
  type WalletProofs,
  ApiError,
  sha256,
  walletProofMessage,
  type Bytes,
  badCounterExpected,
  bytesEqual,
  ckdKeyHash,
  createShareId,
  fetchGoogleJwks,
  isSignMethod,
  parsePortRequest,
  parseVaultBroadcast,
  parseWindowMessage,
  signVaultMessage,
  unsupportedMethodId,
  SUPPORT_ID_SDK_MIN,
  API_REQUEST_ID_SDK_MIN,
  EMAIL_SHARING_SDK_MIN,
  NEAR_SDK_MIN,
  type PortAddresses,
  TEST_APP_NETWORK_RULE,
  decodeNearDelegateAction,
  decodeNearTransaction,
  nearHashString,
  nearKeyString,
  NEAR_DELEGATE_MAX_BLOCKS,
  NEAR_NONCE_PER_BLOCK,
  nearDelegateNonceFloor,
  base64UrlEncode,
  apiTakesNear,
  fromHex,
  sdkAtLeast,
  toHex,
  vaultPayload,
  walletRecordEvmDigest,
} from '@hana-id/core';
import { chainAddress, deriveAddresses } from '@hana-id/core/derivation';
import { consentRegisterPayload, consentRevokePayload } from '@hana-id/core/home';
import { type AutoApproveResult, matchAutoApprovePolicy, recordAutoApproveUse } from '@hana-id/core/policy';
import type { HanaEnv } from '../hana-env.ts';
import { type ConsentProof, VaultApi } from './api.ts';
import { SHARE_LAUNCHER_HELLO_MS, type ConsentSigner, type SheetOutcome, ShareSheet, consentProof } from './email-share.ts';
import { type CachedIdentity, cacheUsable, copyProofs, demoEventBody, makeWalletProofs, mintBody, tokenIatMs } from './identity.ts';
import { nearRecordedIn, reportWallets, signWalletRecords } from './wallet-record.ts';
import { type ApprovalOutcome, Approvals } from './approvals.ts';
import { autoApproveStatus, consentActive, consentEnd, newConsent, withUsage } from './auto-approve.ts';
import { type Persistence, type PolicyInForce, type RawSign, type VaultConfig, parentAllowed, policyInForce } from './config.ts';
import { VaultError, apiErrorToVault, consentNotRecorded, disconnected, isConsentNotRecorded, notLoggedIn, toProtocolError, userRejected } from './errors.ts';
import { Launcher, type LauncherHandle, type LauncherView } from './launcher.ts';
import { type LoginContext, type LoginMode, type LoginRequest, type LoginStage, type LoginSuccess, PendingLink, PendingLogin, type PopupWatch, type RootPins, isOwnLoginPath, pathOwner, serverDetail } from './login.ts';
import { type IssuerApi, issuerApi } from './issuer.ts';
import type { GoogleEmailFlow } from '../auth/google.ts';
import { NearView } from './near.ts';
import {
  type ConsentV1,
  DERIVATION_VERSION,
  RECORD_VERSION,
  type RecordStore,
  type RecordV1,
  openConsent,
  nearRecordedKey,
  openPrk,
  parseNearRecorded,
  parseRecord,
  parseRootPin,
  recordKey,
  rootPinKey,
  sameSession,
  sealConsent,
  sealPrk,
} from './record.ts';
import { type Channel, Clock, type Locks, type Timers, type WindowMessageEvent, type WindowRef, randomHex128, realTimers, sleep } from './runtime.ts';
import { MAINNET_DEMO_REFUSALS, type SignRequest, approvalSubject, demoRefusalFlash, signRequest } from './signing.ts';
import { type MainnetDemoPriceBook, assessMainnetDemo, fixedMainnetDemoPrices, mainnetDemoState, parseMainnetDemoPrices } from '@hana-id/core/mainnet-demo';

/** performance.now where there is one (browsers, workers), else Date.now. */
const defaultPerfNow = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * The /v1/vault/unlock phases (apps/api vault/endpoints.ts `lap`) behind each unlockServer* detail. The share's own
 * rate limit is asked alongside the gate's, inside `limits` (D78).
 */
const UNLOCK_SERVER_GROUPS = { Gate: ['app', 'limits'], Share: ['share'], Advance: ['advance'] } as const;

/** Consecutive stages from `start` (pk_test_ timings): `mark(name)` adds the time since the previous mark to `name`. */
class Laps {
  readonly timings: Record<string, number> = {};
  /** Breakdowns of a stage (not added to the total). */
  readonly detail: Record<string, number> = {};
  private last: number;

  constructor(
    private readonly now: () => number,
    start: number,
  ) {
    this.last = start;
  }

  mark(name: string): void {
    const t = this.now();
    this.timings[name] = (this.timings[name] ?? 0) + Math.max(0, t - this.last);
    this.last = t;
  }

  has(name: string): boolean {
    return name in this.timings;
  }

  /** The time of the last mark. */
  get at(): number {
    return this.last;
  }
}

/** The vault's surroundings (boot.ts wires the browser's). */
export interface VaultHost {
  /** window.parent. */
  readonly parent: unknown;
  /** location.ancestorOrigins[0] where the browser provides it (Chromium, WebKit), else undefined. */
  ancestorOrigin(): string | undefined;
  /**
   * Every entry of location.ancestorOrigins (parent first) where the browser provides it, else undefined (Firefox:
   * nested framing is then refused by the CSP `frame-ancestors` alone).
   */
  ancestorOrigins?(): readonly string[] | undefined;
  /** Subscribes to the vault window's `message` events. */
  onMessage(listener: (e: WindowMessageEvent) => void): void;
  /** window.open from the vault's browsing context (inside a launcher click). */
  open(url: string, name: string, features: string): WindowRef | null;
  /** This document's navigation timing (ms since its navigation start), when the browser has it. */
  navigationTiming?(): NavigationMarks | null;
  /**
   * document.visibilityState (an iframe's follows its tab: 'hidden' while the tab is in the background or minimised).
   * Without it the vault counts itself as shown.
   */
  visibility?(): 'visible' | 'hidden';
  /** Subscribes to the vault document's `visibilitychange` events. */
  onVisibilityChange?(listener: () => void): void;
  /** Subscribes to the vault window's `pageshow` events of a page restored from the back/forward cache (`persisted`). */
  onPageRestore?(listener: () => void): void;
}

/** What the vault reads from its own PerformanceNavigationTiming: all on the vault document's clock. */
export interface NavigationMarks {
  responseEnd: number;
  /** 0 until the load event has run. */
  loadEventEnd: number;
}

/** entry.ts's mark on the vault document's clock (performance.now): when the bundle started running. */
export interface BootMarks {
  scriptStart: number;
}

export interface VaultOptions {
  env: HanaEnv;
  config: VaultConfig;
  host: VaultHost;
  /** Opens the record store; throwing means storage is unavailable ('none' and `storage_unavailable`). */
  openStore(): Promise<RecordStore>;
  locks: Locks;
  channel(name: string): Channel | null;
  launcherView: LauncherView;
  fetch?: typeof fetch;
  timers?: Timers;
  deviceNow?: () => number;
  /** Monotonic ms for pk_test_ timings; defaults to performance.now. */
  perfNow?: () => number;
  /** boot.ts's marks, for the unlock timings' `vault*` stages (pk_test_ apps). */
  boot?: BootMarks;
  /** Google's key for a kid; defaults to fetching and caching Google's JWKS. */
  jwks?: (kid: string) => Promise<Jwk | null>;
  /** The split login fallback (until the ship gate decides). Default 'combined'. */
  loginFlow?: 'combined' | 'split';
  /** How the popup asks Google for the email scope; default auth/google.ts GOOGLE_EMAIL_FLOW (tests run every flow). */
  googleEmailFlow?: GoogleEmailFlow;
  /** D347: the watch on the login popup's window (vault/login.ts POPUP_WATCH by default; tests shorten it). */
  popupWatch?: Partial<PopupWatch>;
  /** The coarse label a new share names this device by in Hana Home (device-label.ts; boot.ts reads the User-Agent), or none. */
  deviceLabel?: string | null;
}

interface Share {
  shareId: Uint8Array;
  /** The last counter this tab knows (the record's is authoritative while it is this session's). */
  counter: number;
  /** Server-corrected time the share was made by a fresh login in this tab, or null (unlocked from a record). */
  createdAt: number | null;
  /** The share's absolute end as the API last said it (create or unlock), when known: bounds a consent's end. */
  absExpiresAtMs?: number | null;
  /**
   * When the API last said this share is live (its create, an unlock, a touch, or GET /v1/app's `share: 'live'`; the
   * read's send time), server-corrected and on perfNow; unset when it never did. The pre-signature check ages it.
   */
  liveAt?: number;
  livePerf?: number;
}

/** A session key and its share, as a consent call signs for them (a null share is 'none' mode). */
interface ConsentHolder {
  keyPair: CryptoKeyPair;
  sessionPk: Uint8Array;
  share: Share | null;
}

/**
 * A session's addresses: Stellar and EVM (the record's, the wallet proofs' and the wallet record's), and NEAR's
 * implicit account id (D720), derived from PRK at login and unlock, never stored (D725): the record keeps exactly the
 * two addresses older vault bundles read.
 */
interface SessionAddresses {
  stellar: string;
  evm: string;
  near: string;
}

interface Session {
  prk: Bytes;
  addresses: SessionAddresses;
  expiresAtMs: number;
  path: string;
  sessionPk: Uint8Array;
  keyPair: CryptoKeyPair;
  /** 'session' while the share and record are (being) made; 'none' in 'none' mode, or once making them failed. */
  persistence: Persistence;
  share: Share | null;
  /**
   * 'session' mode: the share and record being made in the background after the login was reported (D79), until they
   * are written or the attempt gave up; null otherwise. Share- and record-bound steps wait for it (`persisted`).
   */
  persist: PersistJob | null;
  /**
   * 'none' mode: the consent lives here. 'session' mode: the record holds it (sealed under PRK); this is the last one
   * this tab read or wrote, kept so hana_autoApproveStatus can answer while the session is dormant.
   */
  consent: ConsentV1 | null;
  /** The tail of this session's consent work when it has no record or lock to serialise it (`withConsent`). */
  consentQueue?: Promise<unknown>;
  /**
   * The identity token's proofs of `addresses` for this session key and app (vault/identity.ts), made at login or at
   * the unlock of a format-1 record; null only if making them failed (the session then gets no identity token).
   */
  walletProofs: WalletProofs | null;
  /** The digest of this session's EVM wallet record (D317), once made: never signed as a raw EVM request. */
  recordDigest?: Uint8Array;
  /**
   * The user's Support ID as the API sent it with this session (batch C15, `HANA-XXXX-XXXX`), kept in the record so a
   * reload still has it; null when the API sent none or the record predates it. Never derived here (D346).
   */
  supportId: string | null;
  /**
   * D438: the issuer's sealed address of the identity that signed in, for this session (the vault can't open it; the
   * API puts it in identity tokens once the user shared it, D411), or null.
   */
  sealedEmail: string | null;
  /** D411: the session's consent state as the API last said it (a mint's emailStatus, a state read, a decision), or null. */
  emailState: 'granted' | 'declined' | 'not_asked' | null;
  lastTouchAt: number;
  /** Server-corrected time of the partner page's last request for this session (the in-memory idle limit). */
  lastActivityAt: number;
  expiryTimer: unknown;
  idleTimer: unknown;
  /** Set when the session ended because its share was revoked (D695): its refused requests say `signed_out`. */
  signedOut?: true;
}

/** The background persist of one login (D79). */
interface PersistJob {
  /**
   * Set when the session ends (logout, a newer login, expiry, idle, a revocation) before the job settled: it writes no
   * record, takes back one it wrote, and revokes a share it made.
   */
  cancelled: boolean;
  /** Settles (never rejects) once the share and record are written, or the job gave up or was cancelled. */
  done: Promise<void>;
}

/** Why a background persist gave up (logged as a code only). */
class PersistFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A test app's NEAR delegate action must expire within this many blocks of testnet's height (D726; core's rule). */
export { NEAR_DELEGATE_MAX_BLOCKS } from '@hana-id/core';

/** A failed POST /v1/vault/shares is tried once more after this long (D79). */
export const PERSIST_RETRY_MS = 1_000;
/** A partner's `hana_account` calls within this long of a read share it (W-L4). */
export const ACCOUNT_CACHE_MS = 5_000;

/** A 'session'-mode session whose PRK was zeroed for idleness: the record can unlock it again (same share only). */
interface Dormant {
  addresses: SessionAddresses;
  expiresAtMs: number;
  sessionPk: Uint8Array;
  shareId: Uint8Array;
  /** The derivation path (`hana.account()` reads its account while dormant). */
  path: string;
  /** The consent this tab last read or wrote (not secret: policy id, end time, counters), for hana_autoApproveStatus. */
  consent: ConsentV1 | null;
  /**
   * The session key (non-extractable, as in the record) and the wallet proofs: an identity token needs the session key
   * but no PRK, so it can be refreshed while the session is dormant.
   */
  keyPair: CryptoKeyPair;
  walletProofs: WalletProofs | null;
  /** The session's Support ID (Session.supportId), so hana_status keeps it while dormant. */
  supportId: string | null;
  /** Session.sealedEmail and Session.emailState (D411): identity tokens and the sheet need no PRK. */
  sealedEmail: string | null;
  emailState: 'granted' | 'declined' | 'not_asked' | null;
  /** Ends it at expiresAtMs, as a live session's expiry timer would. */
  expiryTimer: unknown;
  /** When the API last said its share is live (Share.liveAt, carried over), for a cached identity token's check (D692). */
  liveAt?: number;
  livePerf?: number;
}

/** A session whose share the API is asked about (D680, D692): the live one with its share, or the dormant one. */
type ShareHolder = { kind: 'live'; s: Session; share: Share } | { kind: 'dormant'; d: Dormant };

/**
 * Whether an API refusal says the share was revoked (D695): `410 share_revoked`, or `410 session_ended` with reason
 * `share_revoked`. A share that expired, or one the API doesn't know, is not: those say nothing about a sign-out.
 */
function shareRevokedRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status === 410 && (e.code === 'share_revoked' || (e.code === 'session_ended' && e.details.reason === 'share_revoked'));
}

/**
 * The 4900 a request of session `s` gets once `s` has ended: with `data.reason: 'signed_out'` when it ended because its
 * share was revoked (D695), so the page can tell a sign-out from a lost vault. wagmi, viem and ethers see the same 4900.
 */
function sessionEnded(s: Session | null | undefined, message?: string): VaultError {
  if (s?.signedOut) return new VaultError(ErrorCode.disconnected, message ?? 'This session was signed out', { reason: 'signed_out' satisfies DisconnectReason });
  return disconnected(message);
}

/** The session an identity token is minted for (vault.identityTarget). */
interface IdentityTarget {
  sessionPk: Uint8Array;
  keyPair: CryptoKeyPair;
  proofs: WalletProofs | null;
  live: Session | null;
  dormant: Dormant | null;
  hasShare: boolean;
}

interface ExportJob {
  chain: 'stellar' | 'evm' | 'near';
  address: string;
  window: WindowRef | null;
  contextSent: boolean;
  intent: LauncherHandle | null;
  timer: unknown;
  poll: unknown;
  resolve(): void;
  reject(e: VaultError): void;
}

/** A consent's `503 session_not_visible` is tried this many more times, waiting its `Retry-After`. */
export const CONSENT_NOT_VISIBLE_RETRIES = 3;
/** The bounds of that wait, whatever `Retry-After` says. */
export const CONSENT_RETRY_MIN_MS = 1_000;
export const CONSENT_RETRY_MAX_MS = 5_000;
/** After a register fails, a covered request doesn't offer the consent screen again for this long. */
export const CONSENT_ASK_AGAIN_MS = 60_000;
/** A touch slides the server idle limit at most this often, and only after an approved signature. */
export const TOUCH_EVERY_MS = 10 * 60_000;
/** revoke-all needs a share made by a fresh login this recently (R12). */
export const FRESH_LOGIN_MS = 5 * 60_000;
/** An export must start (launcher click) within this long; the export window counts as running up to EXPORT_MAX_MS. */
export const EXPORT_START_MS = 5 * 60_000;
export const EXPORT_MAX_MS = 15 * 60_000;
/** "Signed by Hana under {label}" shows this long. */
export const AUTO_APPROVED_FLASH_MS = 3_000;
/** How long the launcher says why the mainnet demo refused a request (D428). */
export const DEMO_REFUSAL_FLASH_MS = 6_000;
/**
 * The background GET /v1/app: this often while logged in with a policy in force (keeps hana_autoApproveStatus current,
 * hidden or shown), and while a session with a share is live in a shown tab (its share's status: a sign-out from Hana
 * Home ends the tab within about a minute). One timer and one read for both; a read made meanwhile for anything else
 * counts, so the timer then waits out the rest of the interval instead of reading again.
 */
export const STATUS_READ_MS = 60_000;
/** The policy's background read (the same timer). */
export const POLICY_REFRESH_MS = STATUS_READ_MS;
/** After background reads that fail, the interval doubles up to this (60 s, 2, 4, 8 min); an answer resets it. */
export const STATUS_READ_BACKOFF_MAX_MS = 8 * 60_000;
/** The background timer never waits less than this when it re-arms without a read (another read did its job). */
export const STATUS_READ_MIN_MS = 10_000;
/** An approval-popup signature needs a `'live'` answer for the session's share this recent, else it re-reads first. */
export const SHARE_FRESH_MS = 60_000;
/**
 * When that re-read can't get an answer (the API or its D1 down, the device offline), the signature still completes
 * if the share was last said to be live this recently, and is refused (`api_unavailable`, `share_unconfirmed`) after.
 */
export const SHARE_GRACE_MS = 3 * 60_000;
/** A check that got no answer is reused this long: sign requests in a row during an outage make one read, not one each. */
export const SHARE_NO_ANSWER_REUSE_MS = 5_000;
/** A tab with no activity (`noteStatusActivity`) for this long is idle: its background read slows to STATUS_IDLE_READ_MS. */
export const STATUS_IDLE_AFTER_MS = 5 * 60_000;
export const STATUS_IDLE_READ_MS = 5 * 60_000;
/**
 * GET /v1/app and POST /v1/vault/share-status are given up (aborted) after this long, so a fetch that never settles
 * can't hold the one check in flight, and with it every later check and the background timer, for good.
 */
export const STATUS_READ_TIMEOUT_MS = 15_000;
/** After the API showed it lacks POST /v1/vault/share-status, the light read is tried again this much later. */
export const SHARE_STATUS_REPROBE_MS = 30 * 60_000;
/** The pre-signature re-read is waited for this long at most; a slower one counts as no answer (the grace applies). */
export const SHARE_WAIT_MS = 8_000;
/**
 * An auto-sign needs the policy confirmed by GET /v1/app this recently, else it re-reads it first (or, if that fails,
 * asks). This bounds how long a removed policy can still auto-sign in an open tab; a burst of requests within it shares
 * one read, so GET /v1/app stays far below its per-IP limit.
 */
export const POLICY_FRESH_MS = 10_000;
/** While the mainnet demo is on: how often GET /v1/app is re-read so the page sees live prices as they change. */
export const DEMO_PRICE_REFRESH_MS = 5 * 60_000;
/** The same while only the fixed table could be had: a live price may be available shortly. */
export const DEMO_PRICE_RETRY_MS = 60_000;
const SEEN_IDS_MAX = 4096;
const JWKS_REFETCH_MS = 60_000;
export const LOGIN_FEATURES = 'popup,width=480,height=640';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Vault {
  private readonly env: HanaEnv;
  private readonly config: VaultConfig;
  private readonly host: VaultHost;
  private readonly timers: Timers;
  private readonly deviceNow: () => number;
  private readonly perfNow: () => number;
  /** When the constructor finished (perfNow): the end of the `vaultConfig` stage. */
  private readonly constructedAt: number;
  /** When the hello was taken (perfNow): the start of the unlock stages after the handshake. */
  private helloAt = 0;
  private readonly clock: Clock;
  /** The inlined policy while GET /v1/app still serves it; null once removed or changed (until a reload). */
  private policy: PolicyInForce | null;
  /** Server-corrected time of the last GET /v1/app (or page render) that confirmed `policy`. */
  private policyCheckedAt: number;
  /** The same moment on perfNow: `policyFresh` ages the check on both. */
  private policyCheckedPerf: number;
  private policyCheck: Promise<void> | null = null;
  /** The background read's timer (`armStatusRead`), or null. */
  private statusTimer: unknown = null;
  /**
   * The background read's reference point: the send time of the latest GET /v1/app that answered (any caller's), or
   * of the timer's latest read that failed, whichever is later; the page render counts as the first answer.
   */
  private statusMark: { at: number; perf: number };
  /** The timer's reads that failed in a row (the backoff); an answer to any read resets it. */
  private statusFailures = 0;
  /** Whether the armed timer was armed at the idle interval (activity then re-arms it at the minute). */
  private statusTimerIdle = false;
  /** The page's or the user's last activity this vault saw (`noteStatusActivity`), server-corrected and on perfNow. */
  private statusActive: { at: number; perf: number };
  /**
   * The share check in flight (one at a time per share: `key` is the live session's Share or the Dormant), and when the
   * last one got no answer (SHARE_NO_ANSWER_REUSE_MS).
   */
  private shareCheck: { key: object; p: Promise<boolean> } | null = null;
  private shareNoAnswer: { at: number; perf: number } | null = null;
  /** When the API last showed it has no POST /v1/vault/share-status (an API older than it, D693): GET /v1/app only. */
  private shareStatusSkipped: { at: number; perf: number } | null = null;
  /** The raw-signing setting in force: the inlined one until GET /v1/app says 'off' (then 'off' until a reload). */
  private rawSign: RawSign;
  /** Server-corrected time of the last GET /v1/app (or page render) that confirmed `rawSign`. */
  private rawSignCheckedAt: number;
  /**
   * The mainnet demo (D428): whether the last GET /v1/app said `mainnetDemo: true`, and when (server-corrected). Read
   * only for a mainnet request of a test app in a dev testnet build; unknown until then.
   */
  private mainnetDemo = false;
  private mainnetDemoCheckedAt = Number.NEGATIVE_INFINITY;
  /** The prices a demo request is valued with (D436): the latest API answer the vault accepted, else the fixed table. */
  private mainnetDemoPrices: MainnetDemoPriceBook = fixedMainnetDemoPrices();
  /** The prices the SDK was last told about (JSON), so an unchanged book isn't re-sent. */
  private announcedDemoPrices: string | null = null;
  /** While the demo is on: re-reads GET /v1/app so the page sees prices as they change. */
  private demoPriceTimer: unknown = null;
  private readonly testApp: boolean;
  private readonly launcher: Launcher;
  private readonly lockName: string;
  private readonly recordId: string;
  private readonly bundleCkdKeyHash: Uint8Array;

  private parentOrigin: string | null = null;
  /**
   * Whether the SDK on the port takes `supportId` in hana_status, hana_login and `ready` (its hello's `sdk` is
   * SUPPORT_ID_SDK_MIN or later): an older SDK's validators refuse a key they don't know, so it gets the old shapes.
   */
  private sdkTakesSupportId = false;
  /**
   * Whether the SDK on the port takes `data.requestId` in a port error (D405; its hello's `sdk` is
   * API_REQUEST_ID_SDK_MIN or later): an older SDK gets exactly the error shapes it was built against.
   */
  private sdkTakesRequestId = false;
  /** D411: whether the SDK on the port knows `emailSharingChanged` (EMAIL_SHARING_SDK_MIN or later). */
  private sdkTakesEmailSharing = false;
  /**
   * D725: whether the SDK on the port takes `near` in its addresses (NEAR_SDK_MIN or later). SDKs 0.3.x check the
   * address object's exact keys and would drop a hana_status, hana_login, `ready` or `accountsChanged` that had it.
   */
  private sdkTakesNear = false;
  /** D411: the email sharing sheet in progress (one at a time: an `at_login` sign-in's, or requestEmailSharing's). */
  private shareSheet: ShareSheet | null = null;
  private port: MessagePort | null = null;
  private api: VaultApi | null = null;
  private near: NearView | null = null;
  private approvals: Approvals | null = null;
  private channel: Channel | null = null;
  private store: RecordStore | null = null;
  private storageBroken = false;
  private started: Promise<void> | null = null;
  private session: Session | null = null;
  private dormant: Dormant | null = null;
  private waking: Promise<void> | null = null;
  private pending: PendingLogin | null = null;
  /** `hana.linkAccount` in its popup (build plan batch 8b); one at a time, never beside a login. */
  private pendingLink: PendingLink | null = null;
  /** The email issuer's google-match (an env with an email issuer). */
  private issuer: IssuerApi | null = null;
  /** The sign-in methods last reported for the session's wallet (`linkChanged` reports the differences). */
  private methodsSeen: { path: string; methods: AccountMethod[] } | null = null;
  /** The provider the last login linked (already reported), skipped by the first snapshot. */
  private freshLink: LoginMethod | null = null;
  /** `hana_account`'s last answer for a path, reused for ACCOUNT_CACHE_MS (W-L4), and the read in flight. */
  private accountCache: { path: string; atMs: number; result: AccountResult } | null = null;
  private accountRead: { path: string; read: Promise<AccountResult> } | null = null;
  /** Root pins (D263) of this frame's logins, in front of the stored ones (the only ones when nothing is stored). */
  private readonly memoryPins = new Map<string, string>();
  private continueIntent: LauncherHandle | null = null;
  private exportJob: ExportJob | null = null;
  private appConfigPromise: Promise<AppConfig> | null = null;
  /**
   * Batch C11: the app's logo from the latest GET /v1/app, when it is this app's on the build's files origin (core
   * logoUrlOn), for the approval and export windows; null until an answer, or without a logo.
   */
  private logoUrl: string | null = null;
  /** Each GET /v1/app answer's round trip on this clock (pk_test_ login timings: `appRtt`). */
  private readonly appRtts = new WeakMap<AppConfig, number>();
  private declinedPolicyId: string | null = null;
  /** The latest answer about a consent (GET /v1/app, or the register that recorded it), asked at server-corrected `at` and at `sent` on perfNow. */
  private consentRead: { id: string; status: 'active' | 'revoked' | 'unknown'; at: number; sent: number } | null = null;
  /** The consent id the GET /v1/app last sent asked about, or null. */
  private consentAsked: string | null = null;
  /** When a register last failed (server-corrected), so a covered request doesn't re-offer the consent screen at once. */
  private consentRegisterFailedAt = Number.NEGATIVE_INFINITY;
  private readonly seenIds = new Set<string>();
  private jwksCache: { keys: Jwk[]; at: number } | null = null;
  /** The session's current identity token (this tab's mint or another tab's, over the channel), or null. */
  private identity: CachedIdentity | null = null;
  private readonly identityLockName: string;

  constructor(private readonly o: VaultOptions) {
    this.env = o.env;
    this.config = o.config;
    this.host = o.host;
    this.timers = o.timers ?? realTimers;
    this.deviceNow = o.deviceNow ?? (() => Date.now());
    this.perfNow = o.perfNow ?? defaultPerfNow;
    this.clock = new Clock(o.config.serverTimeMs, this.deviceNow);
    this.policy = policyInForce(o.config.settings);
    this.policyCheckedAt = o.config.serverTimeMs;
    this.policyCheckedPerf = this.perfNow();
    this.statusMark = { at: o.config.serverTimeMs, perf: this.policyCheckedPerf };
    this.statusActive = { ...this.statusMark };
    this.rawSign = o.config.settings.rawSign;
    this.rawSignCheckedAt = o.config.serverTimeMs;
    // The page's own render counts as a reading (as for rawSign); GET /v1/app re-confirms it before any mainnet request.
    this.mainnetDemo = o.config.settings.mainnetDemo === true;
    this.mainnetDemoCheckedAt = o.config.serverTimeMs;
    this.testApp = isTestPublishableKey(o.config.publishableKey);
    this.launcher = new Launcher(
      o.launcherView,
      (ui) => {
        // Whether it can be clicked goes first, in its own event: `ui` keeps exactly the fields every SDK reads.
        if (ui.launcher === 'show') this.emit('launcherKind', { clickable: ui.clickable });
        this.emit('ui', { launcher: ui.launcher, label: ui.label });
      },
      this.timers,
    );
    this.lockName = `hana-vault-unlock:${o.config.appId}`;
    // Tabs of the app mint one at a time: the second finds the first's token (shared over the channel).
    this.identityLockName = `hana-identity:${o.config.appId}`;
    this.recordId = recordKey(o.env.signer, o.config.appId, o.config.scopeId, 0);
    this.bundleCkdKeyHash = ckdKeyHash(o.env.ckdNetworkKey);
    o.host.onMessage((e) => this.onWindowMessage(e));
    o.host.onVisibilityChange?.(() => this.onVisibilityChange());
    // A back/forward-cache restore: its timers were frozen, so it is checked as a tab shown again (D681).
    o.host.onPageRestore?.(() => this.onVisibilityChange());
    this.constructedAt = this.perfNow();
  }

  /** The server-corrected time (tests). */
  now(): number {
    return this.clock.now();
  }

  // ---- handshake ----

  private onWindowMessage(e: WindowMessageEvent): void {
    if (this.parentOrigin === null) {
      this.tryHello(e);
      return;
    }
    // After the handshake the parent talks only on its port.
    if (e.source === this.host.parent) return;
    const t = isObj(e.data) ? e.data.t : undefined;
    // A Hana window's message (a popup someone is using) is activity for the background read's pace (D694), from the
    // auth origin only; it is checked again, and may well be dropped, by the handler below.
    if (e.origin === this.env.authOrigin && typeof t === 'string' && t.startsWith('hana:')) this.noteStatusActivity();
    if (t === 'hana:auth-hello') {
      const task = this.pending ?? this.pendingLink;
      if (task && parseWindowMessage(e.data, ['hana:auth-hello'])) task.acceptHello(e);
      return;
    }
    if (t === 'hana:auth-progress') {
      const m = this.pending || this.pendingLink ? parseWindowMessage(e.data, ['hana:auth-progress']) : null;
      if (m && this.pending) this.pending.acceptProgress(e, m.stage);
      // A link task's popup: the close watch's signals only (D347).
      else if (m && this.pendingLink) this.pendingLink.acceptPopupSignal(e, m.stage);
      return;
    }
    if (t === 'hana:export-hello') {
      if (parseWindowMessage(e.data, ['hana:export-hello'])) this.onExportHello(e);
      return;
    }
    if (t === 'hana:email-share-hello' || t === 'hana:email-share-answer') {
      this.shareSheet?.handleMessage(e);
      return;
    }
    this.approvals?.handleMessage(e);
  }

  private tryHello(e: WindowMessageEvent): void {
    const hello = parseWindowMessage(e.data, ['hana:hello']);
    if (!hello) return;
    if (e.source !== this.host.parent || e.ports.length !== 1) return;
    if (!parentAllowed(this.config, e.origin, this.env.devEnv)) return;
    const ancestor = this.host.ancestorOrigin();
    if (ancestor !== undefined && ancestor !== e.origin) return;
    // Every ancestor, not only the parent, must be an origin the app allows (sweep VAUL-6): an allowed page framed by
    // another site is refused here too, on top of the CSP's frame-ancestors (which checks every ancestor as well).
    const ancestors = this.host.ancestorOrigins?.();
    if (ancestors !== undefined && !ancestors.every((o) => parentAllowed(this.config, o, this.env.devEnv))) return;
    const port = e.ports[0]!;
    this.helloAt = this.perfNow();
    this.parentOrigin = e.origin;
    this.sdkTakesSupportId = sdkAtLeast(hello.sdk, SUPPORT_ID_SDK_MIN);
    this.sdkTakesRequestId = sdkAtLeast(hello.sdk, API_REQUEST_ID_SDK_MIN);
    this.sdkTakesEmailSharing = sdkAtLeast(hello.sdk, EMAIL_SHARING_SDK_MIN);
    this.sdkTakesNear = sdkAtLeast(hello.sdk, NEAR_SDK_MIN);
    this.port = port;
    const fetchFn = this.o.fetch;
    this.api = new VaultApi({
      apiUrl: this.env.apiUrl,
      publishableKey: this.config.publishableKey,
      parentOrigin: e.origin,
      ...(fetchFn ? { fetch: fetchFn } : {}),
      onServerTime: (t) => this.clock.refresh(t),
    });
    this.near = new NearView({ rpc: this.env.rpc, rpcFallback: this.env.rpcFallback }, this.env.signer, this.env.relayer, fetchFn);
    this.issuer = this.env.emailIssuerUrl ? issuerApi(this.env.emailIssuerUrl, fetchFn) : null;
    this.approvals = new Approvals({
      authOrigin: this.env.authOrigin,
      parentWindow: this.host.parent,
      appName: this.config.appName,
      logoUrl: () => this.logoUrl,
      supportId: () => this.supportId(),
      emailShared: () => (this.live()?.emailState ?? this.liveDormant()?.emailState) === 'granted',
      onEmailRevoke: () => this.revokeEmailSharing(),
      parentOrigin: e.origin,
      open: (url, name, features) => this.host.open(url, name, features),
      launcher: this.launcher,
      timers: this.timers,
      now: this.deviceNow,
      testApp: this.testApp,
      mainnetDemo: () => this.demoBuild && this.mainnetDemo,
      onStop: () => void this.revokeAutoApprove(),
      onWindow: (open) => this.emit('approvalWindow', { open }),
    });
    port.onmessage = (m) => void this.onPortMessage(m.data);
    // Before storage and the unlock: the SDK's answer deadline only covers the frame's load and this hello.
    this.emit('connected', null);
    // The mainnet demo's state (D428), before `ready`, so the SDK's provider knows it before a page switches chains.
    this.announceMainnetDemo();
    this.started = this.start();
  }

  private async start(): Promise<void> {
    const t = new Laps(this.perfNow, this.helloAt);
    // The per-app channel first: an unlock broadcasts its counter (or a revocation) on it.
    this.channel = this.o.channel(`hana-vault:${this.config.appId}`);
    this.channel?.onMessage((d) => this.onBroadcast(d));
    let warning: 'storage_unavailable' | undefined;
    if (this.config.settings.persistence === 'session') {
      try {
        this.store = await this.o.openStore();
      } catch {
        this.storageBroken = true;
        warning = 'storage_unavailable';
      }
    }
    t.mark('store');
    try {
      await this.unlock(undefined, t);
    } catch {
      // An unlock that fails for any unexpected reason leaves the vault logged out.
    }
    if (this.storageBroken) warning = 'storage_unavailable';
    const status = this.statusResult();
    // An unlock that got as far as PRK ends with the addresses; any other path ends where the record was read.
    t.mark(t.has('unwrap') ? 'addresses' : 'record');
    const timings = this.testApp ? { ...this.bootTimings(), ...t.timings, ...t.detail, vault: t.at - this.helloAt } : null;
    this.emit('ready', { ...status, ...(warning ? { warning } : {}), ...(timings ? { timings } : {}) });
    // The Google client (read from chain by the API) and the policy in force, in the background: never on the unlock
    // path.
    void this.appConfig()
      .catch(() => undefined)
      .then(() => this.scheduleDemoPriceRefresh());
    this.armStatusRead();
  }

  /**
   * The vault document's own load, as unlock stages (pk_test_ apps): `vaultFetch` (navigation start → the vault page's
   * last byte), `vaultScript` (→ vault.js running), `vaultConfig` (→ config read and the vault constructed),
   * `vaultLoad` (→ the load event done, which is when the partner sends its hello). All on this document's clock.
   */
  private bootTimings(): Record<string, number> {
    const nav = this.o.host.navigationTiming?.() ?? null;
    const boot = this.o.boot;
    if (!nav || !boot) return {};
    const loadEnd = nav.loadEventEnd > 0 ? nav.loadEventEnd : this.helloAt;
    return {
      vaultFetch: Math.max(0, nav.responseEnd),
      vaultScript: Math.max(0, boot.scriptStart - nav.responseEnd),
      vaultConfig: Math.max(0, this.constructedAt - boot.scriptStart),
      vaultLoad: Math.max(0, loadEnd - this.constructedAt),
    };
  }

  /** The persistence in force: the app's, unless storage is unavailable. */
  private get persistence(): Persistence {
    return this.config.settings.persistence === 'session' && !this.storageBroken ? 'session' : 'none';
  }

  private statusResult(): StatusResult {
    const s = this.live();
    if (s) return { status: 'logged_in', addresses: this.portAddresses(s.addresses), expiresAtMs: s.expiresAtMs, persistence: s.persistence, ...this.supportIdField(s.supportId) };
    const d = this.liveDormant();
    if (d) return { status: 'logged_in', addresses: this.portAddresses(d.addresses), expiresAtMs: d.expiresAtMs, persistence: 'session', ...this.supportIdField(d.supportId) };
    return { status: 'logged_out', persistence: this.persistence };
  }

  /** The Support ID of the session, live or dormant, or null (the approval popup's account line). */
  private supportId(): string | null {
    return this.live()?.supportId ?? this.liveDormant()?.supportId ?? null;
  }

  /** `{supportId}` for a port answer or event, when there is one and the SDK takes the field; else nothing. */
  private supportIdField(supportId: string | null): { supportId?: string } {
    return supportId && this.sdkTakesSupportId ? { supportId } : {};
  }

  /** The addresses the SDK on the port gets: with `near` only for NEAR_SDK_MIN or later (D725). */
  private portAddresses(a: SessionAddresses): PortAddresses {
    return this.sdkTakesNear ? { stellar: a.stellar, evm: a.evm, near: a.near } : { stellar: a.stellar, evm: a.evm };
  }

  /** The addresses of the session, live or dormant, or null. */
  private addresses(): SessionAddresses | null {
    return this.live()?.addresses ?? this.liveDormant()?.addresses ?? null;
  }

  /**
   * `run` with a signal aborted after `ms` on this vault's timers; it rejects at that deadline (a network-style failure,
   * not an ApiError) even if the fetch ignores the signal.
   */
  private withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    let timer: unknown = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = this.timers.setTimeout(() => {
        ctl.abort();
        reject(new Error('timeout'));
      }, ms);
    });
    return Promise.race([run(ctl.signal), deadline]).finally(() => this.timers.clearTimeout(timer));
  }

  /** GET /v1/app, cached on success. Every fresh answer also re-checks the policy and raw signing in force. */
  private appConfig(): Promise<AppConfig> {
    if (!this.appConfigPromise) {
      const at = this.clock.now();
      const sent = this.perfNow();
      // The consent this read reports on: the session's, as last read. The answer applies to that consent alone.
      const consentId = this.session?.consent?.consentId ?? null;
      this.consentAsked = consentId;
      // The session's share, likewise: a 'revoked' answer ends that session alone (Hana Home's "Sign out this device").
      const asked = this.session;
      const shareId = asked?.share?.shareId ?? null;
      const p = this.withTimeout(STATUS_READ_TIMEOUT_MS, (signal) => this.api!.app(consentId ? base64UrlEncode(fromHex(consentId)) : undefined, shareId ? base64UrlEncode(shareId) : undefined, signal)).then((app) => {
        this.appRtts.set(app, this.perfNow() - sent);
        // Any answer does the background read's job (and ends its backoff).
        this.noteStatusMark(at, sent);
        this.statusFailures = 0;
        this.logoUrl = logoUrlOn(this.env.filesOrigin, app.logoUrl, this.config.appId);
        this.applyServedPolicy(app, at, sent);
        this.applyServedRawSign(app, at);
        this.applyServedConsent(app, consentId, at, sent);
        if (asked && shareId) this.applyServedShare(app, asked, shareId, at, sent);
        this.mainnetDemo = app.mainnetDemo === true;
        this.mainnetDemoCheckedAt = Math.max(this.mainnetDemoCheckedAt, at);
        // The vault's own check, whatever the API sent: anything it refuses (or a missing value) means the fixed table.
        this.mainnetDemoPrices = parseMainnetDemoPrices(app.mainnetDemoPrices, this.clock.now()) ?? fixedMainnetDemoPrices();
        this.announceMainnetDemo();
        this.scheduleDemoPriceRefresh();
        return app;
      });
      this.appConfigPromise = p;
      p.catch(() => {
        if (this.appConfigPromise === p) this.appConfigPromise = null;
      });
    }
    return this.appConfigPromise;
  }

  // ---- the policy in force ----

  /**
   * Keeps the inlined policy only while GET /v1/app (asked at `at`) serves the same policyId. A removal or a change
   * drops it until a reload: the new policy, if any, then needs its own consent.
   */
  private applyServedPolicy(app: AppConfig, at: number, sent: number): void {
    const current = this.policy;
    if (!current) return;
    const served = app.autoApprovePolicy ? policyInForce({ ...this.config.settings, autoApprovePolicy: app.autoApprovePolicy }) : null;
    if (served?.policyId === current.policyId) {
      this.policyCheckedAt = Math.max(this.policyCheckedAt, at);
      this.policyCheckedPerf = Math.max(this.policyCheckedPerf, sent);
      return;
    }
    // The background timer stops by itself when nothing else needs it (`statusReadWanted`).
    this.policy = null;
  }

  /**
   * The status GET /v1/app (asked at `at`) gave for consent `id`, the one it named. Only that consent is touched, so a
   * read sent before a newer consent was granted can't clear it. A missing `consent` (a D1 failure) or a value of another
   * shape is no answer: no auto-sign, and the local consent stays. `'revoked'` and `'unknown'` are recorded here and the
   * consent cleared by `confirmConsent` (a request) or the 60 s read's `dropEndedConsent`, so a request in progress can
   * see the answer and send itself to the popup.
   */
  private applyServedConsent(app: AppConfig, id: string | null, at: number, sent: number): void {
    if (id === null) return;
    const status = app.consent;
    if (status !== 'active' && status !== 'revoked' && status !== 'unknown') return;
    if (this.consentRead?.id === id && this.consentRead.sent > sent) return;
    this.consentRead = { id, status, at, sent };
  }

  /**
   * The share GET /v1/app (sent at `at`) reported on (the session's when the read was sent). `'revoked'` ends that
   * session as a touch's 410 does (`endHolder`). `'live'` is noted for the pre-signature check (`confirmHolder`). Only
   * ever an end: the read slides nothing (D55, D539) and counts as no activity, and anything else, a missing field
   * included, changes nothing.
   */
  private applyServedShare(app: AppConfig, s: Session, shareId: Uint8Array, at: number, sent: number): void {
    if (this.session !== s || !s.share || !bytesEqual(s.share.shareId, shareId)) return;
    if (app.share === 'live') {
      this.noteShareLive(s.share, at, sent);
      return;
    }
    if (app.share === 'revoked') this.endHolder({ kind: 'live', s, share: s.share });
  }

  /** The API said a share is live at `at` (server-corrected) / `sent` (perfNow); an older answer never moves it back. */
  private noteShareLive(share: { liveAt?: number; livePerf?: number }, at: number, sent: number): void {
    share.liveAt = Math.max(share.liveAt ?? Number.NEGATIVE_INFINITY, at);
    share.livePerf = Math.max(share.livePerf ?? Number.NEGATIVE_INFINITY, sent);
  }

  /** The share was said to be live within `ms`, on the larger of two clocks (as `consentConfirmed`). */
  private shareLiveWithin(share: { liveAt?: number; livePerf?: number }, ms: number): boolean {
    if (share.liveAt === undefined || share.livePerf === undefined) return false;
    return Math.max(this.clock.now() - share.liveAt, this.perfNow() - share.livePerf) < ms;
  }

  /** Whether `h` is still this tab's session with that share (an answer for any other applies to nothing). */
  private holderCurrent(h: ShareHolder): boolean {
    return h.kind === 'live' ? this.session === h.s && h.s.share === h.share : this.dormant === h.d;
  }

  private holderLive(h: ShareHolder): { liveAt?: number; livePerf?: number } {
    return h.kind === 'live' ? h.share : h.d;
  }

  private holderShareId(h: ShareHolder): Uint8Array {
    return h.kind === 'live' ? h.share.shareId : h.d.shareId;
  }

  /**
   * The API said the share is revoked: as a touch's 410, the record deleted, other tabs told, the session ended, signed
   * out (D695).
   */
  private endHolder(h: ShareHolder): void {
    if (!this.holderCurrent(h)) return;
    const shareId = Uint8Array.from(this.holderShareId(h));
    if (h.kind === 'live') {
      void this.deleteRecordIf(h.s).catch(() => undefined);
      this.broadcastRevoked(shareId, true);
      this.endSession(true, { reason: 'signed_out' });
      return;
    }
    void this.deleteRecordIf({ sessionPk: h.d.sessionPk, share: { shareId, counter: 0, createdAt: null } }).catch(() => undefined);
    this.broadcastRevoked(shareId, true);
    this.dropDormant(true, 'signed_out');
  }

  /**
   * Asks the API about `h`'s share (D690): POST /v1/vault/share-status, the light read, unless GET /v1/app is wanted
   * first (`appFirst`: an app with a policy, whose minute read carries the share anyway). Whichever was not tried is the
   * fallback when the first gives no answer (an API older than the light read; a NEAR or settings failure behind GET
   * /v1/app). GET /v1/app names only a live session's share, so a dormant one has the light read alone. One check at a
   * time. True when the share got an answer (`'live'` noted, or `'revoked'` and the session ended); a refusal, a 429, a
   * 5xx or a network error is no answer, never `'revoked'`.
   */
  private checkShare(h: ShareHolder, appFirst = false): Promise<boolean> {
    // One check at a time per share: a check for another session's share (a new login meanwhile) never joins it.
    const key = h.kind === 'live' ? h.share : h.d;
    const running = this.shareCheck;
    if (running && running.key === key) return running.p;
    // Assigned below and read in its own `finally` (clears only this check).
    let p!: Promise<boolean>;
    p = (async () => {
      const at = this.clock.now();
      const perf = this.perfNow();
      const answered = (): boolean => !this.holderCurrent(h) || (this.holderLive(h).liveAt ?? Number.NEGATIVE_INFINITY) >= at;
      let lightUnreachable = false;
      const viaApp = async (): Promise<boolean> => {
        if (h.kind !== 'live') return false;
        await this.refreshPolicy().catch(() => undefined);
        return answered();
      };
      const viaLight = async (): Promise<boolean> => {
        if (this.lightSkipped()) return false;
        let status: 'live' | 'revoked';
        try {
          status = await this.withTimeout(STATUS_READ_TIMEOUT_MS, (signal) => this.api!.shareStatus(this.holderShareId(h), signal));
        } catch (e) {
          // An API older than the endpoint answers a readable 404 (same origin, tests) or, in a browser, fails the
          // preflight (no CORS headers on an unknown route). Either way: no answer, never `revoked`.
          if (e instanceof ApiError && e.status === 404 && e.code === 'not_found') this.skipLight(at, perf);
          else if (!(e instanceof ApiError)) lightUnreachable = true;
          return false;
        }
        this.noteStatusMark(at, perf);
        this.statusFailures = 0;
        if (!this.holderCurrent(h)) return true;
        if (status === 'live') this.noteShareLive(this.holderLive(h), at, perf);
        else this.endHolder(h);
        return true;
      };
      try {
        let ok: boolean;
        if (appFirst) ok = (await viaApp()) || (await viaLight());
        else {
          ok = await viaLight();
          if (!ok) {
            ok = await viaApp();
            // The light read failed as a network error while GET /v1/app answered: an API without the endpoint, seen
            // through a failed preflight. GET /v1/app alone for a while, then the light read is tried again (D693).
            if (ok && lightUnreachable) this.skipLight(at, perf);
          }
        }
        this.shareNoAnswer = ok ? null : { at, perf };
        return ok;
      } finally {
        if (this.shareCheck?.p === p) this.shareCheck = null;
      }
    })();
    this.shareCheck = { key, p };
    return p;
  }

  /** The light read is skipped for SHARE_STATUS_REPROBE_MS after the API showed it doesn't have it (D693). */
  private lightSkipped(): boolean {
    const s = this.shareStatusSkipped;
    return s !== null && Math.max(this.clock.now() - s.at, this.perfNow() - s.perf) < SHARE_STATUS_REPROBE_MS;
  }

  private skipLight(at: number, perf: number): void {
    this.shareStatusSkipped = { at, perf };
  }

  /**
   * Before a signature from the approval popup (D682), and before a cached identity token is handed out (D692): the
   * share must have a `'live'` answer younger than SHARE_FRESH_MS, so a device signed out from Hana Home can't complete
   * one. An older one is checked first (`checkShare`, waited for SHARE_WAIT_MS at most; a check that got no answer in the
   * last SHARE_NO_ANSWER_REUSE_MS is reused, not repeated, D691). `'revoked'` ends the session: false (the caller
   * answers as for a session that ended). If no answer can be had, an answer younger than SHARE_GRACE_MS (3 minutes)
   * still lets it through, so a short API outage blocks nothing; past that it is refused (`api_unavailable`, reason
   * `share_unconfirmed`), the session stays, and the next answer lets it through again. A session with no share
   * (`'none'` mode, or a share not made yet) has nothing Hana Home could sign out: nothing to check.
   */
  private async confirmHolder(h: ShareHolder | null): Promise<boolean> {
    if (!h || this.shareLiveWithin(this.holderLive(h), SHARE_FRESH_MS)) return true;
    const last = this.shareNoAnswer;
    const reused = last !== null && Math.max(this.clock.now() - last.at, this.perfNow() - last.perf) < SHARE_NO_ANSWER_REUSE_MS;
    if (!reused) {
      let waited: unknown = null;
      await Promise.race([this.checkShare(h), new Promise<void>((resolve) => (waited = this.timers.setTimeout(resolve, SHARE_WAIT_MS)))]);
      this.timers.clearTimeout(waited);
    }
    if (!this.holderCurrent(h)) return false;
    // Fresh now, or (no answer) still within the grace.
    if (this.shareLiveWithin(this.holderLive(h), SHARE_GRACE_MS)) return true;
    throw new VaultError('api_unavailable', 'Could not confirm with Hana that this device is still signed in', { reason: 'share_unconfirmed' });
  }

  /**
   * confirmHolder for a signature in `s`: a session that ended meanwhile is `disconnected`, with `signed_out` when the
   * check (or anything else) found its share revoked (D695).
   */
  private async shareConfirmed(s: Session): Promise<void> {
    const ok = await this.confirmHolder(s.share ? { kind: 'live', s, share: s.share } : null);
    if (!ok || this.live() !== s) throw sessionEnded(s, 'This session was revoked');
  }

  /** After the 60 s read: a consent found revoked is cleared here, so a tab's status reflects it without any request. */
  private async dropEndedConsent(): Promise<void> {
    const r = this.consentRead;
    const s = this.session;
    if (s && r && r.status !== 'active') await this.clearConsentId(s, r.id).catch(() => undefined);
  }

  /** Raw signing stays on only while GET /v1/app (asked at `at`) serves 'approval'; a missing value counts as 'off'. */
  private applyServedRawSign(app: AppConfig, at: number): void {
    if (this.rawSign !== 'approval') return;
    if (app.rawSign === 'approval') this.rawSignCheckedAt = Math.max(this.rawSignCheckedAt, at);
    else this.rawSign = 'off';
  }

  /**
   * The raw-signing setting a raw request may use: 'approval' only when GET /v1/app confirmed it within POLICY_FRESH_MS
   * (re-read first when older). A re-read that fails refuses the request (raw signing fails closed).
   */
  private async freshRawSign(): Promise<RawSign> {
    if (this.rawSign !== 'approval') return 'off';
    if (this.clock.now() - this.rawSignCheckedAt >= POLICY_FRESH_MS) await this.refreshPolicy().catch(() => undefined);
    if (this.rawSign !== 'approval') return 'off';
    if (this.clock.now() - this.rawSignCheckedAt >= POLICY_FRESH_MS) {
      throw new VaultError('api_unavailable', 'Could not confirm that raw signing is on for this app', { reason: 'raw_sign_unconfirmed' });
    }
    return 'approval';
  }

  /**
   * Whether this build may sign under the mainnet demo at all (D428): a dev env on testnet, from the build's own
   * constants. A production build never reads the app's setting.
   */
  private get demoBuild(): boolean {
    return this.testApp && this.env.devEnv && this.env.network === 'testnet';
  }

  /**
   * The mainnet demo rule for a request the D39 check would refuse: on only when GET /v1/app confirmed it within
   * POLICY_FRESH_MS (re-read first when older). A re-read that fails refuses the request (fail closed), as raw signing.
   */
  private async freshMainnetDemo(): Promise<{ nowMs: number; prices: MainnetDemoPriceBook } | null> {
    if (!this.demoBuild) return null;
    if (this.clock.now() - this.mainnetDemoCheckedAt >= POLICY_FRESH_MS) await this.refreshPolicy().catch(() => undefined);
    if (this.clock.now() - this.mainnetDemoCheckedAt >= POLICY_FRESH_MS) {
      throw new VaultError('api_unavailable', 'Could not confirm that the mainnet demo is on for this app', { reason: 'mainnet_demo_unconfirmed' });
    }
    return this.mainnetDemo ? { nowMs: this.clock.now(), prices: this.mainnetDemoPrices } : null;
  }

  /** What the SDK was last told about the mainnet demo: it assumes off until told, so "off" is sent only after "on". */
  private announcedDemo = false;

  /**
   * Tells the SDK whether this app has the mainnet demo on, with its rules (the `mainnetDemo` port event, D428), when
   * it changes: once after the hello, then whenever GET /v1/app changes it. A dev testnet build only: a production
   * build never sends it. The SDK's EVM provider opens its early check for exactly these chains; this vault still
   * decides every request.
   */
  private announceMainnetDemo(): void {
    if (!this.demoBuild || !this.port) return;
    const on = this.mainnetDemo;
    // The prices first, so an SDK that reads them has them when it learns the demo is on (D436).
    if (on) {
      const book = JSON.stringify(this.mainnetDemoPrices);
      if (book !== this.announcedDemoPrices) {
        this.announcedDemoPrices = book;
        this.emit('mainnetDemoPrices', this.mainnetDemoPrices);
      }
    } else this.announcedDemoPrices = null;
    if (this.announcedDemo !== on) {
      this.announcedDemo = on;
      this.emit('mainnetDemo', on ? mainnetDemoState() : null);
    }
  }

  /**
   * While the demo is on (a dev testnet build only), re-reads GET /v1/app so `hana.mainnetDemo.prices` follows the
   * market: every price refresh on the API, or every minute while only the fixed table could be had.
   */
  private scheduleDemoPriceRefresh(): void {
    if (!this.demoBuild || !this.mainnetDemo || this.demoPriceTimer !== null) return;
    const ms = this.mainnetDemoPrices.atMs === null ? DEMO_PRICE_RETRY_MS : DEMO_PRICE_REFRESH_MS;
    this.demoPriceTimer = this.timers.setTimeout(() => {
      this.demoPriceTimer = null;
      void this.refreshPolicy()
        .catch(() => undefined)
        .then(() => this.scheduleDemoPriceRefresh());
    }, ms);
  }

  /** Whether `request` names a mainnet (D39); false for a request that doesn't parse (approvalSubject refuses it). */
  private static namesMainnet(request: SignRequest): boolean {
    try {
      // NEAR mainnet is never under the demo (D726): refused at once, like any test app mainnet without it.
      const mainnet = mainnetOfRequest(request);
      return mainnet !== null && mainnet.chain !== 'near';
    } catch {
      return false;
    }
  }

  /** A fresh GET /v1/app (one at a time). */
  private refreshPolicy(): Promise<void> {
    this.policyCheck ??= (async () => {
      try {
        this.appConfigPromise = null;
        await this.appConfig();
      } finally {
        this.policyCheck = null;
      }
    })();
    return this.policyCheck;
  }

  // ---- the background read (D62's policy re-check, D680's share check) ----

  /** document.visibilityState, as the host gives it; a host without it counts as shown. */
  private visible(): boolean {
    return this.host.visibility?.() !== 'hidden';
  }

  /**
   * Whether the background timer has work: a policy in force (its re-read runs hidden or shown, as before D680; it only
   * fetches while logged in), or a session with a share in a shown tab. A dormant session has neither (D112: a status
   * read never wakes it), and `'none'` mode has no share.
   */
  private statusReadWanted(): boolean {
    return this.policy !== null || (this.session?.share != null && this.visible());
  }

  /** No activity (`noteStatusActivity`) for STATUS_IDLE_AFTER_MS, on the larger of two clocks (D684, D694). */
  private statusIdle(): boolean {
    return Math.max(this.clock.now() - this.statusActive.at, this.perfNow() - this.statusActive.perf) >= STATUS_IDLE_AFTER_MS;
  }

  /**
   * The background interval now: STATUS_READ_MS, or STATUS_IDLE_READ_MS in an idle tab (D684); after failed reads it
   * doubles from the minute up to STATUS_READ_BACKOFF_MAX_MS (D683), and is never shorter than the idle interval then.
   */
  private statusInterval(): number {
    const base = this.statusIdle() ? STATUS_IDLE_READ_MS : STATUS_READ_MS;
    return Math.max(base, Math.min(STATUS_READ_MS * 2 ** Math.min(this.statusFailures, 8), STATUS_READ_BACKOFF_MAX_MS));
  }

  /** Time since `statusMark`, on the larger of two clocks. */
  private sinceStatusMark(): number {
    return Math.max(this.clock.now() - this.statusMark.at, this.perfNow() - this.statusMark.perf);
  }

  private noteStatusMark(at: number, perf: number): void {
    if (at >= this.statusMark.at) this.statusMark = { at, perf: Math.max(perf, this.statusMark.perf) };
  }

  /**
   * Activity in this tab (D694): any request from the partner page on the port (reads included), and any message from a
   * Hana window this vault opened or answers (the approval, consent, login, export and sharing popups: a person at
   * work). It only sets how often the background read runs: an idle tab reads every STATUS_IDLE_READ_MS, an active one
   * every minute. It never extends a session (the idle limit counts only key requests, D55) and never stands in for
   * the check before a signature or a cached identity token (D682, D692), so a page that sends nothing to slow the reads
   * gains nothing: it can't get a signature without a fresh answer. Leaving the idle state re-arms the timer at once.
   */
  private noteStatusActivity(): void {
    const wasIdle = this.statusIdle();
    this.statusActive = { at: this.clock.now(), perf: this.perfNow() };
    if ((wasIdle || this.statusTimerIdle) && this.statusTimer !== null) {
      this.timers.clearTimeout(this.statusTimer);
      this.statusTimer = null;
      this.armStatusRead();
    }
  }

  /**
   * Arms the background timer for what is left of the interval since the last read (at least STATUS_READ_MIN_MS), if
   * there is work and it isn't armed. Called at start, when a session or its share arrives, after each run, when the
   * tab is shown again, and when an idle tab becomes active.
   */
  private armStatusRead(): void {
    if (this.statusTimer !== null || !this.statusReadWanted()) return;
    this.statusTimerIdle = this.statusIdle();
    const delay = Math.max(STATUS_READ_MIN_MS, this.statusInterval() - this.sinceStatusMark());
    this.statusTimer = this.timers.setTimeout(() => {
      this.statusTimer = null;
      void this.statusRead().then(() => this.armStatusRead());
    }, delay);
  }

  /**
   * One background read, when due: nothing while logged out, dormant or past the session's limits, or when another read
   * answered within the interval. With a policy in force it is the policy's GET /v1/app, which carries the share (one
   * request); without one, the light share read (D690). It changes no activity time and slides nothing (D55, D539): a
   * `'revoked'` share ends the session, anything else leaves it as it was. A failure only backs the timer off.
   */
  private async statusRead(): Promise<void> {
    if (!this.statusReadWanted()) return;
    const s = this.live();
    if (!s) return;
    if (this.sinceStatusMark() < this.statusInterval()) return;
    const at = this.clock.now();
    const perf = this.perfNow();
    let ok: boolean;
    if (s.share && this.visible()) {
      ok = await this.checkShare({ kind: 'live', s, share: s.share }, this.policy !== null);
    } else {
      // A policy's own re-read (a hidden tab, or a session with no share).
      ok = await this.refreshPolicy().then(
        () => true,
        () => false,
      );
    }
    if (!ok) {
      this.statusFailures += 1;
      this.noteStatusMark(at, perf);
    }
    await this.dropEndedConsent();
  }

  /**
   * The tab was hidden or shown (D681). Hidden: the share check pauses (the timer stops unless a policy's re-read needs
   * it). Shown: a check that is due runs at once, else the timer is re-armed for what is left. A page restored from the
   * back/forward cache is shown the same way.
   */
  private onVisibilityChange(): void {
    if (!this.visible()) {
      if (!this.statusReadWanted()) {
        this.timers.clearTimeout(this.statusTimer);
        this.statusTimer = null;
      }
      return;
    }
    if (!this.statusReadWanted()) return;
    this.timers.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    // Being shown again is a person at the tab.
    this.statusActive = { at: this.clock.now(), perf: this.perfNow() };
    if (this.sinceStatusMark() >= this.statusInterval()) void this.statusRead().then(() => this.armStatusRead());
    else this.armStatusRead();
  }

  /**
   * The policy an auto-sign may use: one GET /v1/app confirmed within POLICY_FRESH_MS (re-read first when older), or
   * null, and the request then goes to the approval popup. A failed re-read also gives null for this request.
   */
  private async freshPolicy(): Promise<PolicyInForce | null> {
    if (this.policy && !this.policyFresh()) await this.refreshPolicy().catch(() => undefined);
    const policy = this.policy;
    return policy && this.policyFresh() ? policy : null;
  }

  /** The policy was confirmed within POLICY_FRESH_MS, on the larger of two clocks (as `consentConfirmed`). */
  private policyFresh(): boolean {
    return Math.max(this.clock.now() - this.policyCheckedAt, this.perfNow() - this.policyCheckedPerf) < POLICY_FRESH_MS;
  }

  private async jwks(kid: string): Promise<Jwk | null> {
    if (this.o.jwks) return this.o.jwks(kid);
    const fresh = this.jwksCache && this.deviceNow() - this.jwksCache.at < JWKS_REFETCH_MS;
    const cached = this.jwksCache?.keys.find((k) => k.kid === kid);
    if (cached) return cached;
    if (fresh) return null;
    const fetchFn = this.o.fetch;
    const keys = await fetchGoogleJwks(fetchFn ? (...a) => fetchFn(...a) : undefined);
    this.jwksCache = { keys, at: this.deviceNow() };
    return keys.find((k) => k.kid === kid) ?? null;
  }

  // ---- port ----

  private emit<E extends PortEventName>(event: E, data: PortEventMap[E]): void {
    this.port?.postMessage({ v: 1, event, data });
  }

  private reply(id: string, result: unknown): void {
    this.port?.postMessage({ v: 1, id, result });
  }

  private replyError(id: string, e: unknown): void {
    this.port?.postMessage({ v: 1, id, error: toProtocolError(e, 'api_unavailable', this.sdkTakesRequestId) });
  }

  private async onPortMessage(data: unknown): Promise<void> {
    const request = parsePortRequest(data);
    if (!request) {
      const id = unsupportedMethodId(data);
      if (id !== null && this.claimId(id)) this.replyError(id, new VaultError(ErrorCode.unsupportedMethod, 'Unsupported method'));
      return;
    }
    if (!this.claimId(request.id)) return;
    // Any request from the page is activity for the background read's pace (D694); it extends nothing.
    this.noteStatusActivity();
    // The SDK opened an approval popup for this request in the user's click (D99): hold the launcher for its hello, and
    // close it if the request ends without an approval screen (auto-approved under the policy, or refused).
    const claim = request.popupOpened === true ? (this.approvals?.claim() ?? null) : null;
    try {
      await this.started;
      this.reply(request.id, await this.dispatch(request));
    } catch (e) {
      this.replyError(request.id, e);
    } finally {
      claim?.release();
    }
  }

  /** Ids are unique per port: a repeated id is dropped. */
  private claimId(id: string): boolean {
    if (this.seenIds.has(id)) return false;
    if (this.seenIds.size >= SEEN_IDS_MAX) this.seenIds.delete(this.seenIds.values().next().value as string);
    this.seenIds.add(id);
    return true;
  }

  /**
   * Requests that use the key, besides the sign methods: only these count as activity for the in-memory idle limit, and
   * a dormant session is unlocked before them. Reads (hana_status, eth_accounts, stellar_getAddress,
   * hana_autoApproveStatus) neither keep PRK in memory nor wake a dormant session: polling them can't hold the key.
   * A key request refused by a check that needs no key (refuseEarly) doesn't count either, and neither does an auto-
   * approve consent request answered from a consent already in force (sweep VAUL-1, D112).
   */
  private static readonly KEY_METHODS: ReadonlySet<string> = new Set(['hana_export', 'hana_revokeOtherDevices', 'hana_requestAutoApprove']);

  private async dispatch(r: PortRequest): Promise<unknown> {
    const usesKey = isSignMethod(r.method) || Vault.KEY_METHODS.has(r.method);
    if (usesKey) {
      this.refuseEarly(r);
      if (r.method === 'hana_requestAutoApprove') {
        // Counts as activity only when it shows the consent screen (requestAutoApprove); one already in force that a
        // dormant session knows of is answered without waking it.
        const known = this.dormantConsentInForce();
        if (known) return known;
      } else {
        this.noteActivity();
      }
      await this.wake();
    }
    const sign = isSignMethod(r.method);
    if (sign) return this.sign(r as SignRequest);
    switch (r.method) {
      case 'hana_status':
        return this.statusResult();
      case 'hana_login':
        return this.login(r.params?.popupBlocked === true, {
          ...(r.params?.method ? { method: r.params.method } : {}),
          ...(r.params?.emailHint ? { emailHint: r.params.emailHint } : {}),
        });
      case 'hana_cancelLogin':
        this.pending?.abort(this.pending.popupBlocked ? new VaultError('popup_blocked', 'The sign-in window was blocked') : new VaultError('login_cancelled', 'The sign-in was cancelled'));
        return null;
      case 'hana_logout':
        await this.logout();
        return null;
      case 'hana_export':
        return this.startExport(r.params.chain);
      case 'hana_revokeOtherDevices':
        return this.revokeOtherDevices();
      case 'stellar_getAddress': {
        const a = this.addresses();
        if (!a) throw notLoggedIn();
        return { address: a.stellar } satisfies PortResultMap['stellar_getAddress'];
      }
      case 'eth_accounts': {
        const a = this.addresses();
        return a ? [a.evm] : [];
      }
      case 'hana_requestAutoApprove':
        return this.requestAutoApprove();
      case 'hana_autoApproveStatus':
        return this.autoApproveStatusResult();
      case 'hana_revokeAutoApprove':
        await this.revokeAutoApprove();
        return null;
      case 'hana_identityToken':
        // Silent tier, as hana_status: the session key but never PRK, no approval, and not activity (no wake, no idle
        // restart), so a background tab refreshing its token can't keep the session or the key alive (D55, D112).
        return this.identityToken(r.params?.maxAgeMs);
      case 'hana_account':
        // Silent tier too: one chain view, no key.
        return this.account();
      case 'hana_linkAccount':
        return this.linkAccount(r.params.method, r.params.popupBlocked === true);
      case 'hana_requestEmailSharing':
        return this.requestEmailSharing(r.params?.popupBlocked === true);
      default:
        throw new VaultError(ErrorCode.unsupportedMethod, 'Unsupported method');
    }
  }

  // ---- login ----

  private newPending(mode: LoginMode, popupBlocked: boolean, request: LoginRequest = {}): PendingLogin {
    this.pending?.abort(new VaultError('login_cancelled', 'A newer sign-in replaced this one'));
    this.shareSheet?.cancel();
    this.continueIntent?.remove();
    this.continueIntent = null;
    this.pendingLink?.abort(new VaultError('login_cancelled', 'A sign-in replaced this one'));
    const pending = new PendingLogin(
      this.loginContext((stage: LoginStage) => {
        if (this.pending === pending) this.emit('loginProgress', { stage });
      }),
      mode,
      popupBlocked,
      request,
    );
    this.pending = pending;
    return pending;
  }

  private loginContext(progress: (stage: LoginStage) => void): LoginContext {
    return {
      env: this.env,
      config: this.config,
      parentOrigin: this.parentOrigin!,
      persistence: this.persistence,
      api: this.api!,
      near: this.near!,
      issuer: this.issuer,
      clock: this.clock,
      timers: this.timers,
      jwks: (kid) => this.jwks(kid),
      appConfig: () => this.appConfig(),
      appRtt: (app) => this.appRtts.get(app),
      parentWindow: this.host.parent,
      progress,
      // A banner's Cancel or Remove in the login popup (spec "Notices"): the partner hears it, and the snapshot follows.
      linkRemoved: (provider) => {
        if (provider !== 'google' && provider !== 'email') return;
        this.emit('linkChanged', { provider, status: 'removed', effectiveAtMs: null });
        void this.account(true).catch(() => undefined);
      },
      flow: this.o.loginFlow ?? 'combined',
      perfNow: this.perfNow,
      pins: this.rootPins(),
      ...(this.o.googleEmailFlow ? { googleEmailFlow: this.o.googleEmailFlow } : {}),
      ...(this.o.popupWatch ? { popupWatch: this.o.popupWatch } : {}),
    };
  }

  /**
   * D263: the account root each identity last opened on this device, in this app's record store (an app that keeps the
   * wallet across reloads) and this frame's memory (every app). Pins outlive logouts: they exist to notice a root that
   * changes between sessions.
   */
  private rootPins(): RootPins {
    const key = (ik: string) => rootPinKey(this.env.signer, this.config.appId, this.config.scopeId, ik);
    return {
      get: async (ik) => {
        const mem = this.memoryPins.get(ik);
        if (mem) return mem;
        const store = this.store;
        return store ? parseRootPin(await store.get(key(ik))) : null;
      },
      set: async (ik, root) => {
        this.memoryPins.set(ik, root);
        await this.store?.put(key(ik), { v: 1, t: 'root-pin', root });
      },
    };
  }

  // ---- the wallet's sign-in methods (build plan batches 7 and 8b) ----

  /** The path of the session, live or dormant, or null. */
  private sessionPath(): string | null {
    return this.live()?.path ?? this.liveDormant()?.path ?? null;
  }

  /**
   * hana_account: the wallet's sign-in methods from `get_account` on the vault's own RPC (its root, from the session's
   * path, and its members; no sub, no address). Reports what changed since the last read as `linkChanged`. A partner's
   * calls share one read for ACCOUNT_CACHE_MS (W-L4: a page that polls it can't turn each poll into an RPC call);
   * the vault's own reads after a login, a link or a banner's action are `fresh`.
   */
  private async account(fresh = false): Promise<AccountResult> {
    const path = this.sessionPath();
    if (!path) throw notLoggedIn();
    const copy = (r: AccountResult): AccountResult => ({ methods: r.methods.map((m) => ({ ...m })) });
    const cached = this.accountCache;
    const now = this.deviceNow();
    if (!fresh && cached && cached.path === path && now - cached.atMs >= 0 && now - cached.atMs < ACCOUNT_CACHE_MS) return copy(cached.result);
    const inFlight = this.accountRead;
    if (!fresh && inFlight && inFlight.path === path) return copy(await inFlight.read);
    const read = this.readAccount(path);
    this.accountRead = { path, read };
    try {
      const result = await read;
      this.accountCache = { path, atMs: this.deviceNow(), result: copy(result) };
      return copy(result);
    } finally {
      if (this.accountRead?.read === read) this.accountRead = null;
    }
  }

  private async readAccount(path: string): Promise<AccountResult> {
    const root = pathOwner(path);
    if (!root || !this.near) throw new VaultError('api_unavailable', 'This wallet’s sign-in methods can’t be read');
    let view;
    try {
      view = await this.near.account(this.config.scopeId, root.provider, root.sub);
    } catch {
      throw new VaultError('api_unavailable', 'Could not read the wallet’s sign-in methods on NEAR', { reason: 'identity_unchecked' });
    }
    // The session may have ended meanwhile.
    if (this.sessionPath() !== path) throw notLoggedIn();
    const methods: AccountMethod[] = [{ provider: root.provider as LoginMethod, status: 'active', effectiveAtMs: null, root: true }];
    const now = this.clock.now();
    if (view && view.root.provider === root.provider && view.root.sub === root.sub) {
      for (const m of view.members) {
        if (m.provider !== 'google' && m.provider !== 'email') continue;
        // A pending member past its time is active on its next login (lazy activation): report it as active.
        const active = m.active || m.effectiveAtMs <= now;
        methods.push({ provider: m.provider, status: active ? 'active' : 'pending', effectiveAtMs: m.effectiveAtMs, root: false });
      }
    }
    this.noteMethods(path, methods);
    return { methods };
  }

  /** Emits `linkChanged` for every method added, activated or removed since the last snapshot of this wallet. */
  private noteMethods(path: string, methods: AccountMethod[]): void {
    const before = this.methodsSeen?.path === path ? this.methodsSeen.methods : null;
    this.methodsSeen = { path, methods };
    const members = methods.filter((m) => !m.root);
    if (!before) {
      // First read in this session: partners must show pending methods (spec "Notices"); the login's own new link was
      // reported with its result.
      const fresh = this.freshLink;
      this.freshLink = null;
      for (const m of members) if (m.status === 'pending' && m.provider !== fresh) this.emit('linkChanged', { provider: m.provider, status: 'pending', effectiveAtMs: m.effectiveAtMs });
      return;
    }
    const old = before.filter((m) => !m.root);
    for (const m of members) {
      const was = old.find((o) => o.provider === m.provider);
      if (!was || was.status !== m.status) this.emit('linkChanged', { provider: m.provider, status: m.status, effectiveAtMs: m.effectiveAtMs });
    }
    for (const o of old) if (!members.some((m) => m.provider === o.provider)) this.emit('linkChanged', { provider: o.provider, status: 'removed', effectiveAtMs: null });
  }

  /**
   * hana_linkAccount (spec "Explicit linking"): the login popup, opened by the SDK in the click (or by the vault's
   * launcher), signs in the new method and then the wallet's own; the vault relays `link_identity`. The link is pending
   * for `change_delay_ms`.
   */
  private async linkAccount(method: LoginMethod, popupBlocked: boolean): Promise<PortResultMap['hana_linkAccount']> {
    const s = this.live() ?? null;
    const path = s?.path ?? this.liveDormant()?.path ?? null;
    if (!path) throw notLoggedIn();
    if (this.pending || this.pendingLink) throw new VaultError('busy', 'A sign-in is already running');
    const task = new PendingLink(this.loginContext(() => undefined), popupBlocked ? 'vault' : 'partner', popupBlocked, { method, path });
    this.pendingLink = task;
    let intent: LauncherHandle | null = null;
    if (popupBlocked) {
      intent = this.launcher.push('Add a sign-in method in Hana', () => {
        if (task.aborted) return;
        const popup = this.host.open(`${this.env.authOrigin}/login?from=vault`, `hana-login-${randomHex128()}`, LOGIN_FEATURES);
        if (!popup) return;
        task.popup = popup;
        intent?.remove();
        intent = null;
      });
    }
    try {
      const made = await task.done;
      this.emit('linkChanged', { provider: made.provider, status: made.status, effectiveAtMs: made.effectiveAtMs });
      void this.account(true).catch(() => undefined);
      return { provider: made.provider, status: made.status, effectiveAtMs: made.effectiveAtMs };
    } finally {
      intent?.remove();
      if (this.pendingLink === task) this.pendingLink = null;
    }
  }

  /** Opens `/login?from=vault` inside a launcher click and hands the window to the pending login. */
  private openLoginPopup(pending: PendingLogin): boolean {
    if (pending.aborted) return true;
    const popup = this.host.open(`${this.env.authOrigin}/login?from=vault`, `hana-login-${randomHex128()}`, LOGIN_FEATURES);
    if (!popup) return false;
    pending.popup = popup;
    return true;
  }

  private async login(popupBlocked: boolean, request: LoginRequest = {}): Promise<LoginResult> {
    const pending = this.newPending(popupBlocked ? 'vault' : 'partner', popupBlocked, request);
    let intent: LauncherHandle | null = null;
    if (popupBlocked) {
      intent = this.launcher.push('Sign in with Hana', () => {
        if (this.openLoginPopup(pending)) {
          intent?.remove();
          intent = null;
        }
      });
    }
    try {
      return await this.finishLogin(pending);
    } catch (e) {
      if (e instanceof VaultError && e.code === 'session_consumed') this.offerContinue();
      throw e;
    } finally {
      intent?.remove();
      if (this.pending === pending) this.pending = null;
    }
  }

  /** session_consumed: a "Continue signing in" launcher, whose click starts a fresh login in vault mode. */
  private offerContinue(): void {
    this.continueIntent?.remove();
    const intent = this.launcher.push('Continue signing in', () => {
      const pending = this.newPending('vault', false);
      if (!this.openLoginPopup(pending)) {
        pending.abort(new VaultError('login_cancelled', 'The sign-in window was blocked'));
        if (this.pending === pending) this.pending = null;
        this.offerContinue();
        return;
      }
      void this.finishLogin(pending)
        .catch((e: unknown) => {
          if (e instanceof VaultError && e.code === 'session_consumed') this.offerContinue();
        })
        .finally(() => {
          if (this.pending === pending) this.pending = null;
        });
    });
    this.continueIntent = intent;
  }

  /**
   * Waits for the pending login, switches the vault to the new session and reports it. In 'session' mode the share and
   * record are made afterwards, in the background (D79): the partner gets its addresses one `POST /v1/vault/shares`
   * sooner, and a failure there only means the next reload needs a full login.
   */
  private async finishLogin(pending: PendingLogin): Promise<LoginResult> {
    const success = await pending.done;
    if (pending.aborted) {
      success.prk.fill(0);
      throw new VaultError('login_cancelled', 'A newer sign-in replaced this one');
    }
    const persistence = this.persistence;
    // The app keeps the wallet across reloads but this browser's storage can't: say so with the result too.
    const warning: 'storage_unavailable' | undefined = this.storageBroken ? 'storage_unavailable' : undefined;
    const timings = success.timings;
    const previous = this.session;
    // A new login replaces the app's session on this device: this tab's previous share is revoked now, and the share
    // of the record the new one overwrites (another tab's login) once it is overwritten (persistLogin). The tabs still
    // holding them are told to drop them.
    if (previous) this.endSession(false);
    const revoked: Uint8Array[] = [];
    if (previous?.share) {
      // Its consent ends with the share: the API's status read sees that from the share row.
      revoked.push(Uint8Array.from(previous.share.shareId));
      // The other tabs on it were signed out by this sign-in (D695).
      this.broadcastRevoked(previous.share.shareId, true);
      void this.revokeDetached({ keyPair: previous.keyPair, share: { ...previous.share } }).catch(() => undefined);
    } else if (previous?.consent?.consentId) {
      // 'none' mode has no share to end its consent with.
      this.sendConsentRevoke({ keyPair: previous.keyPair, sessionPk: previous.sessionPk, share: null }, previous.consent.consentId);
    }
    const s: Session = {
      prk: success.prk,
      addresses: { stellar: success.addresses.stellar, evm: success.addresses.evm, near: success.addresses.near },
      expiresAtMs: success.expiresAtMs,
      path: success.path,
      sessionPk: success.sessionKey.publicKey,
      keyPair: success.sessionKey.keyPair,
      persistence,
      share: null,
      persist: null,
      consent: null,
      walletProofs: this.walletProofsFor(success.prk, success.sessionKey.publicKey, { stellar: success.addresses.stellar, evm: success.addresses.evm }),
      supportId: success.supportId,
      sealedEmail: success.sealedEmail,
      emailState: null,
      lastTouchAt: this.clock.now(),
      lastActivityAt: this.clock.now(),
      expiryTimer: null,
      idleTimer: null,
    };
    this.adopt(s);
    if (persistence === 'session') s.persist = this.startPersist(s, success, revoked);
    // The wallet directory (D310, D317): the active path's addresses, in the background, never awaited.
    this.recordWallets(s);
    // D438: token_first's google-record answers the sealed address after the login: the session (and its record) get
    // it when it comes. An `at_login` app waits for it below, before the sheet.
    if (!s.sealedEmail && success.sealedEmailLater) void success.sealedEmailLater.then((blob) => this.attachSealedEmail(s, blob));
    // D411: an `at_login` app asks once per user and app, before the wallet opens. Never fails the login.
    if (success.emailShare) await this.loginEmailShare(s, success);
    if (this.session !== s) throw new VaultError('login_cancelled', 'The sign-in ended');
    if (this.pending === pending) this.emit('loginProgress', { stage: 'done' });
    this.emit('accountsChanged', { addresses: this.portAddresses(s.addresses) });
    // The link this login made (spec "Notices"); the first read of the wallet's methods then reports pending ones.
    if (success.linked) this.emit('linkChanged', { provider: success.linked.provider, status: success.linked.status, effectiveAtMs: success.linked.effectiveAtMs });
    this.methodsSeen = null;
    this.freshLink = success.linked?.provider ?? null;
    this.accountCache = null;
    void this.account(true).catch(() => undefined);
    const result: LoginResult = { addresses: this.portAddresses(s.addresses), expiresAtMs: s.expiresAtMs, persistence, ...this.supportIdField(s.supportId) };
    if (warning) result.warning = warning;
    if (this.testApp) {
      const end = this.perfNow();
      // From the end of `decrypt`, so the vault's stages add up to its `vault` total.
      result.timings = { ...timings, finish: end - success.markedAt, vault: end - pending.startedAt };
    }
    return result;
  }

  /** Waits until `s`'s background persist, if any, has settled (written, given up or cancelled). */
  private async persisted(s: Session): Promise<void> {
    const job = s.persist;
    if (job) await job.done;
  }

  private startPersist(s: Session, success: LoginSuccess, revoked: readonly Uint8Array[]): PersistJob {
    const job: PersistJob = { cancelled: false, done: Promise.resolve() };
    job.done = this.persistLogin(s, success, job, revoked)
      .catch(() => undefined)
      .finally(() => {
        if (s.persist === job) s.persist = null;
      });
    return job;
  }

  /**
   * Share creation and the record (docs/batch-b-spec.md "Share creation"), in the background after the login was
   * reported (D79). `POST /v1/vault/shares` is tried once more after PERSIST_RETRY_MS if it fails. On success the
   * session gets its share, and the record it overwrote (if another session's, not already revoked) has its share
   * revoked. If the session ended meanwhile (`job.cancelled`), no record is left for it and a share made for it is
   * revoked. If it gives up, the session keeps working in memory with persistence 'none' (`persistenceChanged`, hana_status), the
   * share (if made) is revoked, and the record of an older session is cleared too: the next reload is a full login.
   * Logs a reason code only.
   */
  private async persistLogin(s: Session, success: LoginSuccess, job: PersistJob, revoked: readonly Uint8Array[]): Promise<void> {
    const keyPair = success.sessionKey.keyPair;
    const parentOrigin = this.parentOrigin!;
    let share: Share | null = null;
    /** The share of the record stored when this login was reported: the session it replaces on this device. */
    let older: Uint8Array | null = null;
    try {
      const store = this.store;
      if (!store) throw new PersistFailure('storage');
      const before = await this.readRecord().catch(() => null);
      older = before && before !== 'invalid' ? before.shareId : null;
      const signature = await signVaultMessage(keyPair.privateKey, {
        signer: this.env.signer,
        appId: this.config.appId,
        shareId: createShareId(),
        counter: 0,
        payload: vaultPayload.createShare(parentOrigin),
      });
      let created: Awaited<ReturnType<VaultApi['createShare']>> | null = null;
      // The send time of the create that answered: the API's first word that the share is live.
      let sentAt = this.clock.now();
      let sentPerf = this.perfNow();
      for (let attempt = 0; created === null; attempt++) {
        if (job.cancelled) return;
        try {
          sentAt = this.clock.now();
          sentPerf = this.perfNow();
          created = await this.api!.createShare(success.sessionKey.publicKey, signature, this.o.deviceLabel ?? null);
        } catch (e) {
          if (attempt >= 1 || job.cancelled) throw new PersistFailure(`share:${e instanceof ApiError ? e.code.slice(0, 64) : 'network'}`);
          await sleep(this.timers, PERSIST_RETRY_MS);
        }
      }
      const ks = Uint8Array.from(created.ks);
      created.ks.fill(0);
      share = { shareId: Uint8Array.from(created.shareId), counter: 0, createdAt: this.clock.now(), absExpiresAtMs: created.absExpiresAtMs, liveAt: sentAt, livePerf: sentPerf };
      const made = share;
      const binding = {
        signer: this.env.signer,
        appId: this.config.appId,
        path: success.path,
        sessionPk: success.sessionKey.publicKey,
        derivationVersion: DERIVATION_VERSION,
        ckdKeyHash: this.bundleCkdKeyHash,
        parentOrigin,
        expiresAtMs: success.expiresAtMs,
      };
      let sealed: { iv: Uint8Array; ct: Uint8Array };
      try {
        // Checked right before sealing: endSession zeroes PRK and sets `cancelled` in the same turn, and sealPrk copies
        // PRK before its first await, so a zeroed PRK is never sealed.
        if (job.cancelled) throw new PersistFailure('cancelled');
        sealed = await sealPrk(ks, s.prk, binding);
      } finally {
        ks.fill(0);
      }
      const record: RecordV1 = {
        v: s.walletProofs ? RECORD_VERSION : 1,
        ...(s.walletProofs ? { walletProofs: copyProofs(s.walletProofs) } : {}),
        ...(s.supportId ? { supportId: s.supportId } : {}),
        ...(s.sealedEmail ? { sealedEmail: s.sealedEmail } : {}),
        ...binding,
        scopeId: this.config.scopeId,
        keyIndex: 0,
        sessionKeyPair: keyPair,
        shareId: made.shareId,
        counter: 0,
        iv: sealed.iv,
        ct: sealed.ct,
        addresses: { stellar: success.addresses.stellar, evm: success.addresses.evm },
      };
      let replaced: RecordV1 | null = null;
      let outcome: 'written' | 'cancelled';
      try {
        outcome = await this.o.locks.request(this.lockName, async () => {
          if (job.cancelled) return 'cancelled';
          const read = await this.readRecord().catch(() => null);
          replaced = read && read !== 'invalid' && !sameSession(read, { sessionPk: success.sessionKey.publicKey, shareId: made.shareId }) ? read : null;
          await store.put(this.recordId, record);
          if (job.cancelled) {
            // The session ended while the record was written: take it back (still under the lock, so it is ours).
            await this.dropRecordAt(store).catch(() => undefined);
            return 'cancelled';
          }
          s.share = made;
          return 'written';
        });
      } catch {
        throw new PersistFailure('storage');
      }
      // A share to check now (D680): the background read starts if it wasn't running for a policy.
      if (outcome === 'written') this.armStatusRead();
      // The record it overwrote is this device's older session (another tab's login): one session per app per device.
      const old = replaced as RecordV1 | null;
      if (old && !revoked.some((id) => bytesEqual(id, old.shareId))) {
        this.broadcastRevoked(old.shareId, true);
        void this.revokeDetached({ keyPair: old.sessionKeyPair, share: { shareId: old.shareId, counter: old.counter, createdAt: null } }).catch(() => undefined);
      }
      if (outcome === 'cancelled') await this.revokeDetached({ keyPair, share: made }).catch(() => undefined);
    } catch (e) {
      // A share this login can't keep is useless without its record: revoke it (best effort).
      if (share) await this.revokeDetached({ keyPair, share }).catch(() => undefined);
      if (job.cancelled) return;
      const reason = e instanceof PersistFailure ? e.reason : 'internal';
      // A reason code only: never a key, a share id, a body or a token.
      console.warn(`[Hana ID vault] This sign-in will not survive a reload (${reason}); the next page load needs a full sign-in.`);
      if (this.session === s) {
        s.persistence = 'none';
        this.emit('persistenceChanged', { persistence: 'none' });
      }
      if (older) await this.clearOlderRecord(older, revoked);
    }
  }

  /**
   * A background persist gave up: if the record stored is still the one this login replaced (share `older`, not a
   * newer login's from another tab), it is deleted and its share revoked, so the next reload is a full login rather
   * than an unlock of that older session. Best effort.
   */
  private async clearOlderRecord(older: Uint8Array, revoked: readonly Uint8Array[]): Promise<void> {
    const store = this.store;
    if (!store) return;
    await this.o.locks
      .request(this.lockName, async () => {
        const r = await this.readRecord();
        if (r === null || r === 'invalid' || !bytesEqual(r.shareId, older)) return;
        if (!revoked.some((id) => bytesEqual(id, r.shareId))) {
          this.broadcastRevoked(r.shareId, true);
          void this.revokeDetached({ keyPair: r.sessionKeyPair, share: { shareId: r.shareId, counter: r.counter, createdAt: null } }).catch(() => undefined);
        }
        await this.dropRecordAt(store);
      })
      .catch(() => undefined);
  }

  /** Revokes a share this tab no longer uses (best effort; one retry on 409 bad_counter). No record change. */
  private async revokeDetached(s: { keyPair: CryptoKeyPair; share: Share | null }): Promise<void> {
    const share = s.share;
    if (!share) return;
    try {
      await this.callShare(s.keyPair, share.shareId, share.counter + 1, 'revoke');
    } catch (e) {
      const expected = e instanceof ApiError ? badCounterExpected(e) : null;
      if (expected === null) throw e;
      await this.callShare(s.keyPair, share.shareId, expected, 'revoke');
    }
  }

  /**
   * The session, or null once it has passed expiresAtMs: it is then ended here, so a timer delayed by background-tab
   * throttling or device sleep never keeps PRK alive (or signing) after the session's end.
   */
  private live(): Session | null {
    const s = this.session;
    if (s && this.clock.now() >= s.expiresAtMs) {
      void this.expire(s);
      return null;
    }
    // The idle limit, for the same reason: a delayed idle timer never keeps PRK in memory past it.
    if (s && this.clock.now() - s.lastActivityAt >= this.config.settings.idleTtlMs) {
      this.goIdle(s);
      return null;
    }
    return s;
  }

  /** The dormant session, or null (ended here once past its absolute end). */
  private liveDormant(): Dormant | null {
    const d = this.dormant;
    if (d && this.clock.now() >= d.expiresAtMs) {
      this.expireDormant(d);
      return null;
    }
    return d;
  }

  /** A dormant session reached its absolute end: as expire() (record deleted if still its own, sessionExpired). */
  private expireDormant(d: Dormant): void {
    if (this.dormant !== d) return;
    this.clearDormant();
    this.dropIdentity();
    void this.deleteRecordIf({ sessionPk: d.sessionPk, share: { shareId: d.shareId, counter: 0, createdAt: null } }).catch(() => undefined);
    this.emit('sessionExpired', null);
    this.emit('accountsChanged', { addresses: null });
  }

  private clearDormant(): void {
    if (this.dormant) this.timers.clearTimeout(this.dormant.expiryTimer);
    this.dormant = null;
  }

  /**
   * The refusals a key request gets before it may unlock a dormant session or count as activity (sweep VAUL-1, D112):
   * checks that need no key. A sign request is checked as approvalSubject would with raw signing allowed (another
   * address, a malformed request, a mainnet for a test app, a raw request from a test app); a second export is busy;
   * revoke-other-devices on a share that isn't fresh (an unlocked share never is) is share_not_fresh. Logged out, it
   * does nothing: the handler answers.
   */
  private refuseEarly(r: PortRequest): void {
    const addresses = this.addresses();
    if (!addresses) return;
    if (isSignMethod(r.method)) {
      // In a build that may sign under the mainnet demo (D428), a mainnet request's network check waits for sign(),
      // which reads whether the app has the demo on (fresh) before deciding; every other check runs here.
      const deferMainnet = this.demoBuild && Vault.namesMainnet(r as SignRequest);
      approvalSubject(r as SignRequest, addresses, { rawSign: 'approval', testApp: this.testApp && !deferMainnet, reservedEvmDigests: this.reservedEvmDigests(addresses.evm) });
      return;
    }
    if (r.method === 'hana_export' && this.exportJob) throw new VaultError('busy', 'An export is already running');
    if (r.method === 'hana_revokeOtherDevices') {
      const s = this.session;
      const share = s ? s.share : null;
      const stale = s === null || (share !== null && !s.persist && (share.createdAt === null || this.clock.now() - share.createdAt >= FRESH_LOGIN_MS));
      if (stale) throw new VaultError(ErrorCode.unauthorized, 'Only within 5 minutes of a fresh sign-in', { reason: 'share_not_fresh' });
    }
  }

  /** approvalSubject, with a mainnet demo refusal also said in Hana's own UI (the launcher), not only to the page. */
  private subjectOf(request: SignRequest, addresses: Parameters<typeof approvalSubject>[1], rules: Parameters<typeof approvalSubject>[2]): ReturnType<typeof approvalSubject> {
    try {
      return approvalSubject(request, addresses, rules);
    } catch (e) {
      const reason = e instanceof VaultError ? e.data?.reason : undefined;
      if (typeof reason === 'string' && MAINNET_DEMO_REFUSALS.has(reason)) this.launcher.flash(demoRefusalFlash(reason), DEMO_REFUSAL_FLASH_MS);
      throw e;
    }
  }

  /** A dormant session's consent still in force under the policy, as hana_requestAutoApprove answers it. */
  private dormantConsentInForce(): PortResultMap['hana_requestAutoApprove'] | null {
    const d = this.session ? null : this.liveDormant();
    const policy = this.policy;
    if (!d || !policy || !consentActive(d.consent, policy, this.clock.now(), d.expiresAtMs)) return null;
    return { granted: true, policyId: policy.policyId, expiresAtMs: d.consent.expiresAtMs };
  }

  /** A request that uses the key: restarts the in-memory idle limit. */
  private noteActivity(): void {
    const s = this.session;
    if (s && this.live() === s) s.lastActivityAt = this.clock.now();
  }

  /** Arms the idle check for `s` at its current deadline (re-armed on firing while there was activity since). */
  private scheduleIdle(s: Session): void {
    this.timers.clearTimeout(s.idleTimer);
    const delay = Math.max(0, s.lastActivityAt + this.config.settings.idleTtlMs - this.clock.now());
    s.idleTimer = this.timers.setTimeout(() => {
      s.idleTimer = null;
      if (this.session !== s) return;
      if (this.clock.now() - s.lastActivityAt >= this.config.settings.idleTtlMs) this.goIdle(s);
      else this.scheduleIdle(s);
    }, Math.min(delay, 0x7fffffff));
  }

  /**
   * The in-memory idle limit passed (docs/batch-b-spec.md Q28): PRK is zeroed. A 'session'-mode session with its record
   * goes dormant and the next request that needs the key unlocks it again; otherwise it ends as at expiry.
   */
  private goIdle(s: Session): void {
    if (this.session !== s) return;
    if (s.persistence !== 'session' || !s.share || !this.store) {
      void this.expire(s);
      return;
    }
    const dormant: Dormant = {
      addresses: { ...s.addresses },
      expiresAtMs: s.expiresAtMs,
      sessionPk: s.sessionPk,
      shareId: Uint8Array.from(s.share.shareId),
      path: s.path,
      consent: s.consent ? { ...s.consent, valueWeiByChain: { ...s.consent.valueWeiByChain } } : null,
      keyPair: s.keyPair,
      walletProofs: s.walletProofs,
      supportId: s.supportId,
      sealedEmail: s.sealedEmail,
      emailState: s.emailState,
      expiryTimer: null,
      ...(s.share.liveAt !== undefined && s.share.livePerf !== undefined ? { liveAt: s.share.liveAt, livePerf: s.share.livePerf } : {}),
    };
    // The same session goes on, dormant: its identity token stays valid.
    this.endSession(false, { keepIdentity: true });
    this.dormant = dormant;
    const delay = Math.max(0, s.expiresAtMs - this.clock.now());
    dormant.expiryTimer = this.timers.setTimeout(() => this.expireDormant(dormant), Math.min(delay, 0x7fffffff));
  }

  /**
   * Unlocks a dormant session (one signed API call, as on reload) before a request that needs the key. Only the same
   * share is unlocked: if the record is gone, belongs to another session or the API refuses (the server share passed
   * its idle or absolute limit, or was revoked), the session ends.
   */
  private async wake(): Promise<void> {
    if (this.session || !this.liveDormant()) return;
    this.waking ??= (async () => {
      const d = this.dormant!;
      try {
        await this.unlock(d.shareId);
      } catch {
        // As a failed unlock: the session ends below.
      }
      if (this.dormant === d) {
        this.clearDormant();
        this.dropIdentity();
        this.emit('sessionExpired', null);
        this.emit('accountsChanged', { addresses: null });
      }
    })().finally(() => {
      this.waking = null;
    });
    await this.waking;
  }

  /**
   * Drops a dormant session for good (logout, revocation); `announce` tells the partner page, with `reason` when the
   * vault knows why (D695).
   */
  private dropDormant(announce: boolean, reason?: DisconnectReason): void {
    if (!this.dormant) return;
    this.clearDormant();
    this.dropIdentity();
    if (announce) this.announceEnd(reason);
  }

  /** `disconnect` (with `disconnectReason` just before it when the reason is known, D695), then no accounts. */
  private announceEnd(reason: DisconnectReason | undefined): void {
    if (reason) this.emit('disconnectReason', { reason });
    this.emit('disconnect', { code: ErrorCode.disconnected });
    this.emit('accountsChanged', { addresses: null });
  }

  /**
   * Tells this app's other tabs that `shareId` is dead: the ones holding it end their session. `signedOut`: the share
   * was revoked (not expired or unknown), and a `signedOut` message goes first, so a tab of this build ends with
   * `signed_out` (D695); a tab of an older build drops it and ends on `revoked`.
   */
  private broadcastRevoked(shareId: Uint8Array, signedOut = false): void {
    if (signedOut) this.channel?.postMessage({ v: 1, t: 'signedOut', shareId: Uint8Array.from(shareId) });
    this.channel?.postMessage({ v: 1, t: 'revoked', shareId: Uint8Array.from(shareId) });
  }

  private adopt(s: Session): void {
    this.session = s;
    this.clearDormant();
    const delay = Math.max(0, s.expiresAtMs - this.clock.now());
    s.expiryTimer = this.timers.setTimeout(() => void this.expire(s), Math.min(delay, 0x7fffffff));
    this.scheduleIdle(s);
    this.armStatusRead();
  }

  /**
   * Zeroes PRK and drops the session; pending approvals and an export end, and so does its identity token unless the
   * session only goes dormant (`keepIdentity`). `reason` `signed_out`: its share was revoked (D695); the session is
   * marked so its refused requests say so, and `announce` sends `disconnectReason` first.
   */
  private endSession(announce: boolean, o: { keepIdentity?: boolean; reason?: DisconnectReason } = {}): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (o.reason === 'signed_out') s.signedOut = true;
    if (!o.keepIdentity) this.dropIdentity();
    // A share or record still being made for this session must not outlive it (persistLogin checks this).
    if (s.persist) s.persist.cancelled = true;
    this.timers.clearTimeout(s.expiryTimer);
    this.timers.clearTimeout(s.idleTimer);
    s.prk.fill(0);
    this.approvals?.cancelAll('cancelled');
    this.cancelExport(sessionEnded(s));
    if (announce) this.announceEnd(o.reason);
  }

  private async expire(s: Session): Promise<void> {
    if (this.session !== s) return;
    this.endSession(false);
    await this.deleteRecordIf(s).catch(() => undefined);
    this.emit('sessionExpired', null);
    this.emit('accountsChanged', { addresses: null });
  }

  // ---- record ----

  private async readRecord(): Promise<RecordV1 | null | 'invalid'> {
    const raw = await this.store!.get(this.recordId);
    if (raw === undefined || raw === null) return null;
    return parseRecord(raw) ?? 'invalid';
  }

  /** Deletes the record and, with it, its NEAR record mark (D756): what a logout or a dead record leaves is only the root pins. */
  private async dropRecordAt(store: RecordStore): Promise<void> {
    await store.delete(this.recordId);
    await store.delete(nearRecordedKey(this.recordId)).catch(() => undefined);
  }

  private async deleteRecord(): Promise<void> {
    await (this.store ? this.dropRecordAt(this.store) : undefined);
  }

  /** Deletes the record if it is still `s`'s (not a newer login's from another tab). */
  private async deleteRecordIf(s: Pick<Session, 'sessionPk' | 'share'>): Promise<void> {
    const store = this.store;
    const share = s.share;
    if (!store || !share) return;
    await this.o.locks.request(this.lockName, async () => {
      const r = await this.readRecord();
      if (r === 'invalid' || (r && sameSession(r, { sessionPk: s.sessionPk, shareId: share.shareId }))) await this.dropRecordAt(store);
    });
  }

  /** Checks that don't need the API (docs/batch-b-spec.md "Record", "Unlock" step 1). False means delete it. */
  private recordUsable(r: RecordV1): boolean {
    return (
      r.signer === this.env.signer &&
      r.appId === this.config.appId &&
      r.scopeId === this.config.scopeId &&
      r.keyIndex === 0 &&
      r.derivationVersion === DERIVATION_VERSION &&
      bytesEqual(r.ckdKeyHash, this.bundleCkdKeyHash) &&
      isOwnLoginPath(r.path, this.config.scopeId) &&
      this.clock.now() < r.expiresAtMs
    );
  }

  /**
   * Unlock (docs/batch-b-spec.md "Unlock"): one signed API call returns K_s; no chain call. `onlyShare` (waking a
   * dormant session) unlocks the record only if it still holds that share.
   */
  private async unlock(onlyShare?: Uint8Array, t?: Laps): Promise<void> {
    const store = this.store;
    if (!store) return;
    let read: RecordV1 | null | 'invalid';
    try {
      read = await this.readRecord();
    } catch {
      this.storageBroken = true;
      return;
    }
    if (read === null) return;
    if (read === 'invalid' || !this.recordUsable(read)) {
      await this.deleteRecord().catch(() => undefined);
      return;
    }
    const first: RecordV1 = read;
    if (onlyShare && !bytesEqual(first.shareId, onlyShare)) return;
    // Another parent origin on this top-level site: not this parent's record (left alone).
    if (first.parentOrigin !== this.parentOrigin || !parentAllowed(this.config, first.parentOrigin, this.env.devEnv)) return;

    const unlocked = await this.o.locks.request(this.lockName, async () => {
      const r = await this.readRecord();
      if (r === null || r === 'invalid' || !sameSession(r, first) || !this.recordUsable(r)) return null;
      t?.mark('record');
      let counter = r.counter + 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const sent = this.perfNow();
          const sentAt = this.clock.now();
          const res = await this.callShare(r.sessionKeyPair, r.shareId, counter, 'unlock');
          if (t) {
            // Signing (~0.1 ms) and the round trip of the attempt that answered, next to the API's own time for it.
            t.detail.unlockRtt = this.perfNow() - sent;
            Object.assign(t.detail, serverDetail('unlock', res.timings, UNLOCK_SERVER_GROUPS));
            t.mark('unlock');
          }
          const ks = Uint8Array.from(res.ks);
          res.ks.fill(0);
          r.counter = res.counter;
          // The counter is written before the lock is released.
          await store.put(this.recordId, r);
          t?.mark('counter');
          return { record: r, ks, absExpiresAtMs: res.absExpiresAtMs, liveAt: sentAt, livePerf: sent };
        } catch (e) {
          if (!(e instanceof ApiError)) return null;
          const expected = badCounterExpected(e);
          if (expected !== null && attempt === 0) {
            counter = expected;
            continue;
          }
          if (e.status === 404 || e.status === 410 || e.status === 401 || e.code === 'bad_counter') {
            await this.dropRecordAt(store);
            if (e.status === 410) this.broadcastRevoked(r.shareId, shareRevokedRefusal(e));
          }
          return null;
        }
      }
    });
    if (!unlocked) return;
    const { record, ks, absExpiresAtMs, liveAt, livePerf } = unlocked;
    let prk: Bytes;
    try {
      prk = await openPrk(ks, record);
    } catch {
      await this.deleteRecord().catch(() => undefined);
      return;
    } finally {
      ks.fill(0);
    }
    t?.mark('unwrap');
    let consentOk = true;
    // NEAR's account is derived here, never read from the record (D725): a record from before NEAR has the same PRK.
    let near = '';
    try {
      const addresses = deriveAddresses(prk);
      if (addresses.stellar !== record.addresses.stellar || addresses.evm !== record.addresses.evm) consentOk = false;
      else {
        near = chainAddress(prk, 'near');
        await openConsent(prk, record);
      }
    } catch {
      consentOk = false;
    }
    if (!consentOk) {
      prk.fill(0);
      await this.deleteRecord().catch(() => undefined);
      return;
    }
    // A format-1 record gets its identity proofs now (PRK is here), written back if the record is still this session's.
    const walletProofs = record.walletProofs ? copyProofs(record.walletProofs) : this.walletProofsFor(prk, record.sessionPk, { stellar: record.addresses.stellar, evm: record.addresses.evm });
    if (!record.walletProofs && walletProofs) void this.upgradeRecord(record, walletProofs).catch(() => undefined);
    this.adopt({
      prk,
      addresses: { stellar: record.addresses.stellar, evm: record.addresses.evm, near },
      expiresAtMs: record.expiresAtMs,
      path: record.path,
      sessionPk: record.sessionPk,
      keyPair: record.sessionKeyPair,
      persistence: 'session',
      // The unlock that answered says it is live, as of when it was sent.
      share: { shareId: record.shareId, counter: record.counter, createdAt: null, absExpiresAtMs, liveAt, livePerf },
      persist: null,
      consent: null,
      walletProofs,
      supportId: record.supportId ?? null,
      sealedEmail: record.sealedEmail ?? null,
      emailState: null,
      lastTouchAt: this.clock.now(),
      lastActivityAt: this.clock.now(),
      expiryTimer: null,
      idleTimer: null,
    });
    this.channel?.postMessage({ v: 1, t: 'counter', shareId: Uint8Array.from(record.shareId), counter: record.counter });
    // D756: a session from before NEAR (or whose NEAR record was missed) records it now, once (the mark stops it after).
    if (this.session) this.recordWallets(this.session, true);
  }

  /** One signed share call with an explicit counter. */
  private callShare(keyPair: CryptoKeyPair, shareId: Uint8Array, counter: number, action: 'unlock'): Promise<{ ks: number[]; counter: number; absExpiresAtMs: number; timings?: unknown }>;
  private callShare(keyPair: CryptoKeyPair, shareId: Uint8Array, counter: number, action: 'touch' | 'revoke' | 'revoke-all'): Promise<unknown>;
  private async callShare(keyPair: CryptoKeyPair, shareId: Uint8Array, counter: number, action: 'unlock' | 'touch' | 'revoke' | 'revoke-all'): Promise<unknown> {
    const payload = action === 'unlock' ? vaultPayload.unlock() : action === 'touch' ? vaultPayload.touch() : action === 'revoke' ? vaultPayload.revoke() : vaultPayload.revokeAll();
    const signature = await signVaultMessage(keyPair.privateKey, { signer: this.env.signer, appId: this.config.appId, shareId, counter, payload });
    const body = { shareId: Array.from(shareId), counter, signature: Array.from(signature) };
    const api = this.api!;
    switch (action) {
      case 'unlock':
        return api.unlock(body);
      case 'touch':
        return api.touch(body);
      case 'revoke':
        return api.revoke(body);
      case 'revoke-all':
        return api.revokeAll(body);
    }
  }

  /**
   * A signed share action for the current session, under the per-app lock, with the counter re-read from the record
   * (`n + 1`; one retry with the API's `expected` on 409 bad_counter). The new counter is written and broadcast.
   */
  private async shareAction<T>(action: 'touch' | 'revoke' | 'revoke-all', after?: (r: RecordV1 | null) => Promise<void>): Promise<T> {
    const first = this.live();
    if (first) await this.persisted(first);
    const s = this.live();
    if (!s?.share || s !== first) throw notLoggedIn();
    return this.nextCounter(s.sessionPk, s.share, (counter) => this.callShare(s.keyPair, s.share!.shareId, counter, action) as Promise<T>, after);
  }

  /**
   * Runs `call` with the share's next counter, under the per-app lock: the counter re-read from the record (`n + 1`,
   * one retry with the API's `expected` on 409 bad_counter), then written and broadcast.
   */
  private async nextCounter<T>(sessionPk: Uint8Array, share: Share, call: (counter: number) => Promise<T>, after?: (r: RecordV1 | null) => Promise<void>): Promise<T> {
    return this.o.locks.request(this.lockName, async () => {
      const read = this.store ? await this.readRecord().catch(() => null) : null;
      const record = read && read !== 'invalid' && sameSession(read, { sessionPk, shareId: share.shareId }) ? read : null;
      let counter = Math.max(share.counter, record?.counter ?? 0) + 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await call(counter);
          share.counter = counter;
          if (record) {
            record.counter = counter;
            await this.store!.put(this.recordId, record);
          }
          await after?.(record);
          this.channel?.postMessage({ v: 1, t: 'counter', shareId: Uint8Array.from(share.shareId), counter });
          return result;
        } catch (e) {
          const expected = e instanceof ApiError ? badCounterExpected(e) : null;
          if (expected !== null && attempt === 0) {
            counter = expected;
            continue;
          }
          throw e;
        }
      }
    });
  }

  private onBroadcast(data: unknown): void {
    const m = parseVaultBroadcast(data);
    if (!m) return;
    if (m.t === 'identity') {
      this.adoptBroadcastIdentity(m);
      return;
    }
    const s = this.session;
    if (m.t === 'counter') {
      if (s?.share && bytesEqual(s.share.shareId, m.shareId)) s.share.counter = Math.max(s.share.counter, m.counter);
      return;
    }
    if (m.t === 'revoked' || m.t === 'signedOut') {
      // Only the tabs holding that share: a stale tab's 410 must not end a newer session in another tab. `signedOut`
      // comes just before `revoked` when the share was revoked (D695): the session ends on it, with the reason, and
      // the `revoked` then finds nothing to end.
      const reason: DisconnectReason | undefined = m.t === 'signedOut' ? 'signed_out' : undefined;
      if (s?.share && bytesEqual(s.share.shareId, m.shareId)) this.endSession(true, { reason });
      if (this.dormant && bytesEqual(this.dormant.shareId, m.shareId)) this.dropDormant(true, reason);
      return;
    }
    // logout: the user logged out of this app on this device.
    if (s) this.endSession(true);
    this.dropDormant(true);
  }

  // ---- logout and lost device ----

  /**
   * Logout (docs/batch-b-spec.md "Logout") is app-wide on this device. Under the per-app lock: this tab's share is
   * revoked, so is the record's when it belongs to another session (a newer login in another tab, with the record's own
   * session key), and the record is deleted. Then PRK is zeroed and `logout` is broadcast, so every tab of the app ends
   * its session. 404 and 410 mean already revoked; anything else (network) still ends the session here: a share left
   * live dies at its idle limit, and without the record its K_s opens nothing.
   */
  private async logout(): Promise<void> {
    const s = this.live();
    // A share still being made for this login is revoked by its own job once it exists, and no record is written for
    // it (D79): logout doesn't wait for it.
    if (s?.persist) s.persist.cancelled = true;
    this.pending?.abort(new VaultError('login_cancelled', 'Logged out'));
    this.pendingLink?.abort(new VaultError('login_cancelled', 'Logged out'));
    this.shareSheet?.cancel();
    this.methodsSeen = null;
    // This tab's copy is cleared first: in 'none' mode that is the consent itself, which is then stopped on the API. In
    // 'session' mode the record holds the consent until the delete below, and it ends on the API with the share.
    if (s) {
      const id = s.share ? null : (s.consent?.consentId ?? null);
      s.consent = null;
      if (id) this.sendConsentRevoke({ keyPair: s.keyPair, sessionPk: s.sessionPk, share: null }, id);
    }
    const store = this.store;
    const own = s?.share ? { keyPair: s.keyPair, sessionPk: s.sessionPk, share: s.share } : null;
    if (store || own) {
      await this.o.locks
        .request(this.lockName, async () => {
          const read = store ? await this.readRecord().catch(() => null) : null;
          const record = read && read !== 'invalid' ? read : null;
          const mine = own && record && sameSession(record, { sessionPk: own.sessionPk, shareId: own.share.shareId }) ? record : null;
          if (own) await this.revokeDetached({ keyPair: own.keyPair, share: { ...own.share, counter: Math.max(own.share.counter, mine?.counter ?? 0) } }).catch(() => undefined);
          if (record && !mine) {
            await this.revokeDetached({ keyPair: record.sessionKeyPair, share: { shareId: record.shareId, counter: record.counter, createdAt: null } }).catch(() => undefined);
          }
          if (store) await this.dropRecordAt(store).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    if (s && this.session === s) this.endSession(false);
    const wasDormant = this.dormant !== null;
    this.dropDormant(false);
    this.channel?.postMessage({ v: 1, t: 'logout' });
    if (s || wasDormant) this.emit('accountsChanged', { addresses: null });
  }

  private async revokeOtherDevices(): Promise<PortResultMap['hana_revokeOtherDevices']> {
    const first = this.live();
    if (!first) throw notLoggedIn();
    // Right after a login its share may still be in the making: wait for it rather than refuse.
    await this.persisted(first);
    const s = this.live();
    if (s !== first) throw sessionEnded(first);
    const share = s.share;
    if (!share) throw new VaultError(ErrorCode.unauthorized, 'This app does not keep the wallet across reloads', { reason: 'persistence_off' });
    if (share.createdAt === null || this.clock.now() - share.createdAt >= FRESH_LOGIN_MS) {
      throw new VaultError(ErrorCode.unauthorized, 'Only within 5 minutes of a fresh sign-in', { reason: 'share_not_fresh' });
    }
    try {
      const r = await this.shareAction<{ revoked: number }>('revoke-all');
      return { revoked: r.revoked };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'share_not_fresh') throw new VaultError(ErrorCode.unauthorized, 'Only within 5 minutes of a fresh sign-in', { reason: 'share_not_fresh' }).fromRequest(e);
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
        // Signed out only when the API says revoked (D695); an expired or unknown share ends without a reason.
        const signedOut = shareRevokedRefusal(e);
        await this.deleteRecordIf(s).catch(() => undefined);
        this.broadcastRevoked(share.shareId, signedOut);
        if (this.session === s) this.endSession(true, signedOut ? { reason: 'signed_out' } : {});
        throw sessionEnded(s, 'This session was revoked').fromRequest(e);
      }
      throw e instanceof ApiError ? apiErrorToVault(e) : e;
    }
  }

  /** Slides the server idle limit after an approved signature, at most once per 10 min. Best effort. */
  private maybeTouch(): void {
    const s = this.live();
    const share = s?.share;
    if (!s || !share || this.clock.now() - s.lastTouchAt < TOUCH_EVERY_MS) return;
    s.lastTouchAt = this.clock.now();
    const at = this.clock.now();
    const perf = this.perfNow();
    void this.shareAction('touch').then(() => this.noteShareLive(share, at, perf), (e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410) && this.session === s) {
        // Signed out only when the API says revoked (D695); an expired or unknown share ends without a reason.
        const signedOut = shareRevokedRefusal(e);
        void this.deleteRecordIf(s).catch(() => undefined);
        this.broadcastRevoked(share.shareId, signedOut);
        this.endSession(true, signedOut ? { reason: 'signed_out' } : {});
      }
    });
  }

  // ---- wallet directory (D310, D317) ----

  /**
   * Right after the login's result is on its way (a timer, so the signatures never delay it), while the session is
   * still this one and PRK is in memory, signs its wallet records and the session signature over the request and
   * sends them without waiting (wallet-record.ts): one call, a 15 s limit, every failure dropped. The login's result
   * never depends on it. At an unlock (`unlock`), only when NEAR should be recorded and this session's NEAR record
   * isn't marked as recorded yet (D756): how a user who signed in before NEAR, or with an older SDK, gets the row.
   */
  private recordWallets(s: Session, unlock = false): void {
    this.timers.setTimeout(() => void this.sendWalletRecords(s, unlock), 0);
  }

  private async sendWalletRecords(s: Session, unlock: boolean): Promise<void> {
    const api = this.api;
    const live = () => this.api === api && this.session === s && !s.prk.every((b) => b === 0);
    // A session that already ended (or went dormant: PRK zeroed) records nothing; the next login does.
    if (!api || !live()) return;
    // NEAR (D755) only for an SDK of 0.4.0 or later (the partner sees in its console what its SDK hands out, D725) and
    // only to an API that takes it (an older API refuses a three-chain body, which would lose the other two).
    const app = this.sdkTakesNear ? await this.appConfig().catch(() => null) : null;
    const withNear = this.sdkTakesNear && apiTakesNear(app);
    if (unlock && (!withNear || (await this.nearRecorded(s)))) return;
    if (!live()) return;
    const ctx = { env: this.env.name, signer: this.env.signer, appId: this.config.appId, scopeId: this.config.scopeId, path: s.path, sessionPublicKey: s.sessionPk, issuedAtMs: this.clock.now() };
    let signed;
    try {
      // The digest is refused as a raw EVM request from now on, before the next await (D179, D317).
      s.recordDigest = walletRecordEvmDigest(ctx, s.addresses.evm);
      // The chain keys sign synchronously inside (PRK checked live just above); then the session key, asynchronously.
      signed = await signWalletRecords(s.prk, s.keyPair.privateKey, ctx, { stellar: s.addresses.stellar, evm: s.addresses.evm, ...(withNear ? { near: s.addresses.near } : {}) });
    } catch {
      return;
    }
    if (this.session !== s) return;
    void reportWallets((body, signal) => api.recordWallets(body, signal), signed.body, this.timers).then((answer) => {
      if (withNear && nearRecordedIn(answer)) void this.markNearRecorded(s).catch(() => undefined);
    });
  }

  /** Whether the API already recorded this session's NEAR account (the mark beside the record, D756). */
  private async nearRecorded(s: Session): Promise<boolean> {
    const store = this.store;
    if (!store) return false;
    try {
      return parseNearRecorded(await store.get(nearRecordedKey(this.recordId))) === toHex(s.sessionPk);
    } catch {
      return false;
    }
  }

  /** Marks this session's NEAR account as recorded ('session' mode only: a 'none' session has no record to unlock). */
  private async markNearRecorded(s: Session): Promise<void> {
    const store = this.store;
    // Only while the session is still this one: a logout's deletion is never followed by a stale mark.
    if (!store || s.persistence !== 'session' || this.session !== s) return;
    await store.put(nearRecordedKey(this.recordId), { v: 1, t: 'near-recorded', sessionPk: toHex(s.sessionPk) });
  }

  // ---- partner identity token (docs/identity-token-spec.md) ----

  /**
   * The digests the session's EVM wallet proof and wallet record (D317) sign: a raw EVM request for either is refused
   * (signing.ts, D179).
   */
  private reservedEvmDigests(evm: string): Uint8Array[] {
    const pk = (this.session ?? this.dormant)?.sessionPk;
    const record = this.session?.recordDigest;
    return pk ? [sha256(walletProofMessage({ signer: this.env.signer, appId: this.config.appId, sessionPublicKey: pk }, 'evm', evm)), ...(record ? [record] : [])] : [];
  }

  /** The wallet proofs for a session, or null if they can't be made (no identity token then; logged as a code). */
  private walletProofsFor(prk: Uint8Array, sessionPk: Uint8Array, addresses: { stellar: string; evm: string }): WalletProofs | null {
    try {
      return makeWalletProofs(prk, { signer: this.env.signer, appId: this.config.appId, sessionPublicKey: sessionPk }, addresses);
    } catch {
      console.warn('[Hana ID vault] Could not make the identity wallet proofs (wallet_proofs); identity tokens are unavailable for this session.');
      return null;
    }
  }

  /** Writes the proofs into a format-1 record (making it format 2), under the lock, if it is still this session's. */
  private async upgradeRecord(of: RecordV1, walletProofs: WalletProofs): Promise<void> {
    const store = this.store;
    if (!store) return;
    await this.o.locks.request(this.lockName, async () => {
      const r = await this.readRecord();
      if (r === null || r === 'invalid' || !sameSession(r, of) || r.walletProofs) return;
      await store.put(this.recordId, { ...r, v: RECORD_VERSION, walletProofs: copyProofs(walletProofs) });
    });
  }

  // ---- email sharing (D411, D438–D443; email-share.ts) ----

  /** The live or dormant session's consent signer and its sealed address. */
  private consentTarget(): { signer: ConsentSigner; held: { sealedEmail: string | null; emailState: Session['emailState'] }; sessionPk: Uint8Array } | null {
    const s = this.live() ?? this.liveDormant();
    if (!s || !this.parentOrigin) return null;
    return {
      signer: { signer: this.env.signer, appId: this.config.appId, parentOrigin: this.parentOrigin, sessionPublicKey: Uint8Array.from(s.sessionPk), privateKey: s.keyPair.privateKey },
      held: s,
      sessionPk: s.sessionPk,
    };
  }

  /** One consent call, signed now; a stale clock is corrected and the call tried once more (as a mint). */
  private async consentCall<T>(signer: ConsentSigner, action: 'state' | 'granted' | 'declined' | 'revoke', sealedEmail: string | null, call: (proof: Awaited<ReturnType<typeof consentProof>>) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const proof = await consentProof(signer, action, sealedEmail, this.clock.now());
      try {
        return await call(proof);
      } catch (e) {
        if (attempt === 0 && e instanceof ApiError && e.code === 'stale_proof') {
          this.clock.refresh(e.details.serverTimeMs);
          continue;
        }
        if (attempt === 0 && e instanceof ApiError && e.code === 'proof_replayed') continue;
        throw e;
      }
    }
  }

  /** The API's setting and state for the session's address (null sealedEmail: the account's, D441). */
  private consentState(signer: ConsentSigner, sealedEmail: string | null) {
    return this.consentCall(signer, 'state', sealedEmail, (proof) => this.api!.emailConsentState({ ...proof, ...(sealedEmail ? { sealedEmail } : {}) }));
  }

  /** Records an answer and tells the partner (`emailSharingChanged`); the cached identity token is dropped silently. */
  private async recordConsent(signer: ConsentSigner, held: { sealedEmail: string | null; emailState: Session['emailState'] }, answer: 'granted' | 'declined' | 'revoke'): Promise<'granted' | 'declined'> {
    let state: 'granted' | 'declined';
    if (answer === 'revoke') {
      await this.consentCall(signer, 'revoke', null, (proof) => this.api!.emailConsentRevoke(proof));
      state = 'declined';
    } else {
      const sealedEmail = held.sealedEmail;
      if (!sealedEmail) throw new VaultError('email_sharing_unavailable', 'Hana has no address for this session', { reason: 'no_address' });
      state = await this.consentCall(signer, answer, sealedEmail, (proof) => this.api!.emailConsentDecide({ ...proof, sealedEmail, decision: answer }));
    }
    held.emailState = state;
    // The next getIdentityToken() mints with the email or without it. Not identityTokenChanged(null): that means logged out.
    if (this.identity && bytesEqual(this.identity.sessionPk, signer.sessionPublicKey)) this.identity = null;
    if (this.sdkTakesEmailSharing) this.emit('emailSharingChanged', { state });
    return state;
  }

  /** The approval popup's "Stop sharing" (D442): every address of this app and account. */
  private async revokeEmailSharing(): Promise<boolean> {
    const t = this.consentTarget();
    if (!t) return false;
    try {
      await this.recordConsent(t.signer, t.held, 'revoke');
      return true;
    } catch {
      return false;
    }
  }

  /** D438: a sealed address that arrived after the login (google-record): kept with the session and in its record. */
  private attachSealedEmail(s: Session, blob: string | null): void {
    if (!blob || this.session !== s || s.sealedEmail) return;
    s.sealedEmail = blob;
    if (s.persistence !== 'session') return;
    void this.persisted(s)
      .then(() =>
        this.o.locks.request(this.lockName, async () => {
          const store = this.store;
          if (!store || this.session !== s) return;
          const r = await this.readRecord().catch(() => null);
          if (r === null || r === 'invalid' || !bytesEqual(r.sessionPk, s.sessionPk) || r.sealedEmail) return;
          await store.put(this.recordId, { ...r, sealedEmail: blob });
        }),
      )
      .catch(() => undefined);
  }

  private shareRequest(blob: string, state: 'not_asked' | 'declined' | 'granted', signer: ConsentSigner, ownGoogleClient: boolean) {
    return {
      pk: this.config.publishableKey,
      appName: this.config.appName,
      parentOrigin: signer.parentOrigin,
      logoUrl: this.logoUrl,
      ownGoogleClient,
      state,
      sealedEmail: blob,
      previewProof: () => consentProof(signer, 'preview', blob, this.clock.now()),
    };
  }

  private newSheet(expect: WindowRef | 'partner' | null, signer: ConsentSigner, held: { sealedEmail: string | null; emailState: Session['emailState'] }): ShareSheet {
    this.shareSheet?.cancel();
    const sheet = new ShareSheet(
      { authOrigin: this.env.authOrigin, parentWindow: this.host.parent, timers: this.timers, clock: this.clock, record: (answer) => this.recordConsent(signer, held, answer) },
      expect,
    );
    this.shareSheet = sheet;
    return sheet;
  }

  /**
   * D411's `at_login`: after the key passed its check and before the login is answered, the sheet in the login popup
   * (which went to `/share-email?from=login` instead of closing) when this user hasn't answered it for this address. A
   * closed popup, no address, the API's refusal or any failure: the login goes on, asked again next time.
   */
  private async loginEmailShare(s: Session, success: LoginSuccess): Promise<void> {
    const sheet = this.newSheet(success.popup, { signer: this.env.signer, appId: this.config.appId, parentOrigin: this.parentOrigin!, sessionPublicKey: Uint8Array.from(s.sessionPk), privateKey: s.keyPair.privateKey }, s);
    try {
      if (!s.sealedEmail && success.sealedEmailLater) this.attachSealedEmail(s, await success.sealedEmailLater);
      const blob = s.sealedEmail;
      if (!blob || !success.popup || this.session !== s) return sheet.dismiss();
      await this.persisted(s);
      if (this.session !== s) return sheet.dismiss();
      const signer = { signer: this.env.signer, appId: this.config.appId, parentOrigin: this.parentOrigin!, sessionPublicKey: Uint8Array.from(s.sessionPk), privateKey: s.keyPair.privateKey };
      const st = await this.consentState(signer, blob);
      s.emailState = st.state === 'unavailable' ? null : st.state;
      if (st.setting !== 'at_login' || st.state !== 'not_asked' || this.session !== s) return sheet.dismiss();
      const app = await this.appConfig().catch(() => null);
      await sheet.run(this.shareRequest(blob, 'not_asked', signer, app?.google.mode === 'own'));
    } catch {
      sheet.dismiss();
    } finally {
      // A dismissed sheet stays routed until it answered its window's late hello (ShareSheet.dismiss).
      if (this.shareSheet === sheet && sheet.ended) this.shareSheet = null;
    }
  }

  /**
   * hana_requestEmailSharing (D411): the sheet in the window the SDK opened in the partner's click (or, blocked, the
   * one the vault's launcher opens), for the session's address. Already shared: the sheet offers "Stop sharing".
   */
  private async requestEmailSharing(popupBlocked: boolean): Promise<PortResultMap['hana_requestEmailSharing']> {
    const t = this.consentTarget();
    if (!t) throw notLoggedIn();
    if (this.pending || this.pendingLink) throw new VaultError('busy', 'A sign-in is already running');
    const sheet = this.newSheet(popupBlocked ? null : 'partner', t.signer, t.held);
    let intent: LauncherHandle | null = null;
    try {
      if (t.held === this.session) await this.persisted(this.session);
      const blob = t.held.sealedEmail;
      let st;
      try {
        st = await this.consentState(t.signer, blob);
      } catch (e) {
        throw e instanceof ApiError && (e.code === 'session_ended' || e.status === 410)
          ? new VaultError('session_ended', 'The Hana session has ended')
          : new VaultError('email_sharing_unavailable', 'Email sharing is unavailable, try again later', { reason: 'unavailable' });
      }
      t.held.emailState = st.state === 'unavailable' ? null : st.state;
      if (st.setting === 'off') throw new VaultError('email_sharing_unavailable', 'Email sharing is off for this app', { reason: 'off' });
      if (!blob || st.state === 'unavailable') throw new VaultError('email_sharing_unavailable', 'Hana has no address for this session; sign in again', { reason: 'no_address' });
      if (popupBlocked) {
        intent = this.launcher.push('Share your email in Hana', () => {
          const w = this.host.open(`${this.env.authOrigin}/share-email?from=vault`, `hana-share-${randomHex128()}`, LOGIN_FEATURES);
          if (!w) return;
          sheet.adopt(w);
          intent?.remove();
          intent = null;
        });
      }
      const app = await this.appConfig().catch(() => null);
      const outcome: SheetOutcome = await sheet.run(this.shareRequest(blob, st.state, t.signer, app?.google.mode === 'own'), popupBlocked ? SHARE_LAUNCHER_HELLO_MS : undefined);
      if (outcome === 'failed') throw new VaultError('email_sharing_unavailable', 'Hana could not record the answer, try again', { reason: 'unavailable' });
      return { state: outcome === 'kept' ? 'granted' : outcome };
    } catch (e) {
      sheet.dismiss();
      throw e;
    } finally {
      intent?.remove();
      // A dismissed sheet stays routed until it answered its window's late hello (ShareSheet.dismiss).
      if (this.shareSheet === sheet && sheet.ended) this.shareSheet = null;
    }
  }

  /** The session an identity token is for: the live one, or the dormant one (no PRK needed), with its key and proofs. */
  private identityTarget(): IdentityTarget | null {
    const s = this.live();
    if (s) return { sessionPk: s.sessionPk, keyPair: s.keyPair, proofs: s.walletProofs, live: s, dormant: null, hasShare: s.share !== null };
    const d = this.liveDormant();
    if (d) return { sessionPk: d.sessionPk, keyPair: d.keyPair, proofs: d.walletProofs, live: null, dormant: d, hasShare: true };
    return null;
  }

  private cachedIdentity(sessionPk: Uint8Array, maxAgeMs?: number): PortResultMap['hana_identityToken'] | null {
    const c = this.identity;
    if (!c || !bytesEqual(c.sessionPk, sessionPk) || !cacheUsable(c, this.clock.now(), maxAgeMs)) return null;
    return { identityToken: c.token, expiresAtMs: c.expiresAtMs };
  }

  /**
   * The cached token for `t`, handed out only after the share check (D692): a token is a server-verifiable sign-in the
   * partner's backend trusts for up to an hour, so a tab signed out from Hana Home (a hidden one included) must not keep
   * serving it. The same rule as before a signature: a `'live'` answer within a minute, else a check (the light read,
   * which never wakes a dormant session), else the 3-minute grace, else `share_unconfirmed`. Null when nothing usable
   * is cached; `'ended'` when the check ended the session (the caller answers as logged out). A mint needs no check:
   * the API checks the share itself.
   */
  private async checkedCachedIdentity(t: IdentityTarget, maxAgeMs?: number): Promise<PortResultMap['hana_identityToken'] | 'ended' | null> {
    if (!this.cachedIdentity(t.sessionPk, maxAgeMs)) return null;
    const h: ShareHolder | null = t.live ? (t.live.share ? { kind: 'live', s: t.live, share: t.live.share } : null) : t.dormant ? { kind: 'dormant', d: t.dormant } : null;
    if (!(await this.confirmHolder(h))) return 'ended';
    return this.cachedIdentity(t.sessionPk, maxAgeMs);
  }

  /** Drops the identity token (the session ended or was replaced) and tells the partner page. */
  private dropIdentity(): void {
    if (!this.identity) return;
    this.identity = null;
    this.emit('identityTokenChanged', { identityToken: null, expiresAtMs: null });
  }

  /** Another tab's token for this tab's session (live or dormant): cached and reported, if it is newer. */
  private adoptBroadcastIdentity(m: Extract<VaultBroadcast, { t: 'identity' }>): void {
    const s = this.session ?? this.dormant;
    if (!s || !bytesEqual(s.sessionPk, m.sessionPk)) return;
    const c = this.identity;
    if (c && bytesEqual(c.sessionPk, m.sessionPk) && c.iatMs >= m.iatMs) return;
    this.identity = { sessionPk: Uint8Array.from(m.sessionPk), token: m.identityToken, iatMs: m.iatMs, expiresAtMs: m.expiresAtMs };
    this.emit('identityTokenChanged', { identityToken: m.identityToken, expiresAtMs: m.expiresAtMs });
  }

  /**
   * hana_identityToken: the cached token while it is fresh enough (cacheUsable), else a mint under the per-app Web
   * Lock (a tab that waited finds the token another tab just minted). Logged out: nulls, never an error.
   */
  private async identityToken(maxAgeMs?: number): Promise<PortResultMap['hana_identityToken']> {
    const none = { identityToken: null, expiresAtMs: null };
    const first = this.identityTarget();
    if (!first) return none;
    const hit = await this.checkedCachedIdentity(first, maxAgeMs);
    if (hit === 'ended') return none;
    if (hit) return hit;
    // Right after a login the share may still be in the making (D79): the API needs it in 'session' mode.
    if (first.live) await this.persisted(first.live);
    return this.o.locks.request(this.identityLockName, async () => {
      const t = this.identityTarget();
      if (!t) return none;
      const cached = await this.checkedCachedIdentity(t, maxAgeMs);
      if (cached === 'ended') return none;
      if (cached) return cached;
      return this.mintIdentity(t);
    });
  }

  private async mintIdentity(t: IdentityTarget): Promise<PortResultMap['hana_identityToken']> {
    // An app that keeps logins checks the session's share: a session this browser couldn't persist has none (D79).
    if (this.config.settings.persistence === 'session' && !t.hasShare) {
      throw new VaultError('identity_unavailable', 'This browser could not keep the Hana session, so it has no identity token', { reason: 'no_share' });
    }
    const proofs = t.proofs;
    if (!proofs) throw new VaultError('identity_unavailable', 'Identity tokens are unavailable for this session', { reason: 'no_wallet_proofs' });
    const sessionPk = Uint8Array.from(t.sessionPk);
    for (let attempt = 0; ; attempt++) {
      const body = await mintBody(t.keyPair.privateKey, {
        signer: this.env.signer,
        appId: this.config.appId,
        sessionPublicKey: sessionPk,
        parentOrigin: this.parentOrigin!,
        issuedAtMs: this.clock.now(),
        proofs,
        sealedEmail: (t.live ?? t.dormant)?.sealedEmail ?? null,
      });
      let res;
      try {
        res = await this.api!.identityToken(body);
      } catch (e) {
        if (!(e instanceof ApiError)) throw new VaultError('identity_unavailable', 'Identity tokens are unavailable, try again later');
        // A clock that drifted: the API's time comes with the refusal. A replay can only be a nonce collision. Once each.
        if (attempt === 0 && e.code === 'stale_proof') {
          this.clock.refresh(e.details.serverTimeMs);
          continue;
        }
        if (attempt === 0 && e.code === 'proof_replayed') continue;
        throw this.identityError(e, t);
      }
      const now = this.identityTarget();
      // The session ended or changed while the request was in flight: its token is no longer anyone's.
      if (!now || !bytesEqual(now.sessionPk, sessionPk)) return { identityToken: null, expiresAtMs: null };
      const iatMs = tokenIatMs(res.identityToken) ?? this.clock.now();
      // D411: the token says where sharing stands for this session (the approval popup's "Stop sharing" reads it).
      const held = now.live ?? now.dormant;
      if (held) held.emailState = res.emailStatus === 'included' ? 'granted' : res.emailStatus === 'declined' ? 'declined' : res.emailStatus === 'not_asked' ? 'not_asked' : held.emailState;
      this.identity = { sessionPk, token: res.identityToken, iatMs, expiresAtMs: res.expiresAtMs };
      this.channel?.postMessage({ v: 1, t: 'identity', sessionPk: Uint8Array.from(sessionPk), identityToken: res.identityToken, iatMs, expiresAtMs: res.expiresAtMs });
      const state = { identityToken: res.identityToken, expiresAtMs: res.expiresAtMs };
      this.emit('identityTokenChanged', state);
      return state;
    }
  }

  /**
   * A refused mint as a port error. `410 session_ended`: the share or the on-chain session is gone, so the session ends
   * here too (record deleted, other tabs told, `sessionExpired`). `410 session_ending`: less than 30 s left; the session
   * ends on its own timers.
   */
  private identityError(e: ApiError, t: IdentityTarget): VaultError {
    return this.identityRefusal(e, t).fromRequest(e);
  }

  private identityRefusal(e: ApiError, t: IdentityTarget): VaultError {
    if (e.code === 'session_ended') {
      // The share revoked (D695): `data.reason` says signed out; the event stays `sessionExpired`, as before.
      const signedOut = shareRevokedRefusal(e);
      this.endIdentitySession(t, signedOut);
      return new VaultError('session_ended', 'The Hana session has ended', signedOut ? { reason: 'signed_out' satisfies DisconnectReason } : undefined);
    }
    if (e.code === 'session_ending') return new VaultError('session_ended', 'The Hana session ends in less than 30 seconds', { reason: 'session_ending' });
    if (e.status === 429) return new VaultError('rate_limited', 'Too many identity token requests, try again later');
    if (e.code === 'app_suspended' || e.code === 'origin_not_allowed' || e.code === 'scope_conflict') return apiErrorToVault(e);
    return new VaultError('identity_unavailable', 'Identity tokens are unavailable, try again later', { api: `${e.status} ${e.code}`.slice(0, 80) });
  }

  private endIdentitySession(t: IdentityTarget, signedOut: boolean): void {
    const s = t.live;
    if (s && this.session === s) {
      const share = s.share;
      if (share) {
        void this.deleteRecordIf(s).catch(() => undefined);
        this.broadcastRevoked(share.shareId, signedOut);
      }
      this.endSession(false, signedOut ? { reason: 'signed_out' } : {});
    } else if (t.dormant && this.dormant === t.dormant) {
      const d = t.dormant;
      void this.deleteRecordIf({ sessionPk: d.sessionPk, share: { shareId: d.shareId, counter: 0, createdAt: null } }).catch(() => undefined);
      this.broadcastRevoked(d.shareId, signedOut);
      this.dropDormant(false);
    } else return;
    this.emit('sessionExpired', null);
    this.emit('accountsChanged', { addresses: null });
  }

  // ---- signing ----

  private async sign(request: SignRequest): Promise<unknown> {
    const s = this.live();
    if (!s) throw notLoggedIn();
    // Raw signing is re-read before every raw request (setting it to 'off' takes effect in open tabs).
    // A test app's raw request is refused outright (approvalSubject), with no API read.
    const rawSign: RawSign = request.method === 'hana_signRaw' && !this.testApp ? await this.freshRawSign() : 'off';
    if (this.live() !== s) throw sessionEnded(s);
    // A test app's mainnet request (D39) is signed only under the mainnet demo (D428), confirmed fresh.
    const demo = this.testApp && Vault.namesMainnet(request);
    const mainnetDemo = demo ? await this.freshMainnetDemo() : null;
    if (this.live() !== s) throw sessionEnded(s);
    const subject = this.subjectOf(request, s.addresses, { rawSign, testApp: this.testApp, mainnetDemo, reservedEvmDigests: this.reservedEvmDigests(s.addresses.evm) });
    // D726: NEAR's bytes name no network, so the network a request claims is checked on this env's RPC before any
    // popup (a refusal costs no click). A transaction's block hash ties it to one network: every app's testnet claim
    // must name a testnet block (the popup then shows the network as checked), and a mainnet claim must not. A test
    // app's delegate action must be bound to testnet by its key, nonce and expiry (checkNearDelegate).
    if (request.method === 'near_signTransaction') {
      await this.checkNearBlock(subject.bytes, request.params.network);
      if (this.live() !== s) throw sessionEnded(s);
    }
    if (this.testApp && request.method === 'near_signDelegateAction') {
      await this.checkNearDelegate(subject.bytes);
      if (this.live() !== s) throw sessionEnded(s);
    }
    // A mainnet demo request always gets the approval popup and its banner: never auto-approved.
    const eligible = !demo && !NEVER_AUTO_APPROVED_KINDS.has(subject.kind);
    // The policy read below also names the consent, so it is loaded first: one read then answers both.
    if (eligible && this.policy && !s.consent) await this.withConsent(s, async (c) => ({ value: c }));
    if (this.live() !== s) throw sessionEnded(s);
    const policy = eligible ? await this.freshPolicy() : null;
    if (this.live() !== s) throw sessionEnded(s);
    let note: { label: string; active: boolean; reason?: string } | undefined;
    if (policy) {
      const standing = await this.confirmConsent(s, policy);
      if (this.live() !== s) throw sessionEnded(s);
      // 'hold': no answer for this consent, or it was just found revoked: this request goes to the approval popup,
      // with no consent screen and no note.
      if (standing !== 'hold') {
        let auto = await this.tryAutoSign(s, request, subject, policy);
        if (auto.kind === 'signed') return auto.result;
        if (auto.kind === 'no_consent' && this.declinedPolicyId !== policy.policyId && this.clock.now() - this.consentRegisterFailedAt >= CONSENT_ASK_AGAIN_MS) {
          // A request the policy would cover: ask for consent first (the same popup), then sign under it.
          const would = matchAutoApprovePolicy(policy.policy, subject, { usage: null, nowMs: this.clock.now() });
          if (would.ok) {
            let granted: boolean;
            try {
              granted = await this.askConsent(s, policy);
            } catch (e) {
              if (!isConsentNotRecorded(e)) throw e;
              // Fail closed (D98): no consent. The request itself still goes to the approval popup.
              granted = false;
              this.launcher.flash('Auto-approve couldn’t be turned on', AUTO_APPROVED_FLASH_MS);
            }
            if (this.live() !== s) throw sessionEnded(s);
            // The consent screen can stay up for minutes: the policy must still be in force to sign under it.
            if (granted && (await this.freshPolicy())?.policyId === policy.policyId) {
              auto = await this.tryAutoSign(s, request, subject, policy);
              if (auto.kind === 'signed') return auto.result;
            }
          }
        }
        if (auto.kind !== 'unconfirmed') {
          note = { label: policy.policy.label, active: auto.kind === 'miss' };
          if (auto.kind === 'miss') note.reason = auto.reason;
        }
      }
    }
    // D682: a device signed out from Hana Home completes no approval: checked before the popup (so a refusal costs no
    // click; usually the minute's read already answered) and again after it when the popup stayed up past the bound.
    await this.shareConfirmed(s);
    if (this.live() !== s) throw sessionEnded(s);
    const outcome = await this.approvals!.requestApproval(subject, note, mainnetDemo?.prices);
    if (outcome === 'cancelled' || this.live() !== s) throw sessionEnded(s);
    if (outcome !== 'approved') throw userRejected();
    await this.shareConfirmed(s);
    if (this.live() !== s) throw sessionEnded(s);
    const result = signRequest(s.prk, request, subject);
    this.maybeTouch();
    if (demo && mainnetDemo) this.reportDemoSignature(s, subject, mainnetDemo.prices);
    return result;
  }

  /**
   * The network check of a NEAR transaction (D726). A transaction runs only with a recent block hash of the network it
   * is sent to, so its block hash is what binds it to one. This env's RPC (its `network`, testnet) is asked about it:
   * - claimed `testnet`: the block must be a testnet block, else 4100 `near_block_unknown`; when no endpoint answers,
   *   `api_unavailable` (reason `near_rpc_unavailable`): fail closed, the popup shows the network as checked;
   * - claimed `mainnet` (a live app; a test app's was refused before): the block must not be a testnet block, else
   *   4100 `near_network_mismatch`; Hana has no mainnet RPC, so the popup shows mainnet as the app's claim.
   */
  private async checkNearBlock(txBytes: Uint8Array, claimed: 'testnet' | 'mainnet'): Promise<void> {
    if (this.testApp) this.requireIndependentNear();
    const blockHash = nearHashString(decodeNearTransaction(txBytes).blockHash);
    const here = this.env.network;
    let known: boolean;
    let either: boolean;
    try {
      // A test app's answer comes from both providers when the env has two (a lying RPC alone can't vouch for a block).
      const answers = await this.near!.blockExists(blockHash, this.testApp);
      known = answers.every(Boolean);
      either = answers.some(Boolean);
    } catch {
      if (claimed !== here) return;
      throw new VaultError('api_unavailable', `Hana couldn’t check this transaction’s block on NEAR ${here}, try again`, { reason: 'near_rpc_unavailable' });
    }
    if (claimed === here && !known) {
      throw new VaultError(ErrorCode.unauthorized, `This transaction’s block hash is not a NEAR ${here} block: use a recent one from a ${here} RPC${this.testApp ? `. ${TEST_APP_NETWORK_RULE}` : ''}`, {
        reason: 'near_block_unknown',
        chain: 'near',
        blockHash,
      });
    }
    if (claimed !== here && either) {
      throw new VaultError(ErrorCode.unauthorized, `This transaction names NEAR ${claimed}, but its block hash is a NEAR ${here} block`, { reason: 'near_network_mismatch', chain: 'near', blockHash });
    }
  }

  /**
   * A test app's NEAR checks trust no single RPC (D729): outside local* envs the env must have a second, independent
   * provider (`rpcFallback`; sandbox-dev's is rpc.testnet.near.org beside fastnear), else the request fails closed with
   * `api_unavailable`, reason `near_rpc_single_provider`.
   */
  private requireIndependentNear(): void {
    if (this.env.name.startsWith('local') || this.near!.independentProviders()) return;
    throw new VaultError('api_unavailable', 'This Hana environment has one NEAR provider, so it can’t check a test app’s NEAR request', { reason: 'near_rpc_single_provider' });
  }

  /**
   * A test app's delegate action must be bound to testnet (D726). A DelegateAction has no block hash; what ties it to a
   * network is its key, nonce and expiry, read here from this env's (testnet) RPC at final finality, from both providers
   * when the env has two (every answer must pass):
   * - the sender's access key must exist on testnet with this public key (else 4100 `near_key_unknown`: activate the
   *   account first);
   * - nonce > the key's nonce (else `near_delegate_nonce_used`), nonce > (height − NEAR_DELEGATE_MAX_BLOCKS) × 10^6
   *   (else `near_delegate_nonce_stale`), and nonce < height × 10^6, nearcore's upper bound (else
   *   `near_delegate_nonce_too_large`); `nearDelegateNonce` in `@hana-id/core/near` picks such a nonce;
   * - height < max_block_height ≤ height + NEAR_DELEGATE_MAX_BLOCKS (else `near_delegate_expiry`).
   * What this does and doesn't do: nearcore runs a delegate action on any network whose own height H has
   * nonce < H × 10^6 and H ≤ max_block_height (and the sender's key there a lower nonce). These bounds pin that to a
   * fixed window of heights around testnet's height at signing, at most 20,000 blocks wide. Mainnet, ~53 million blocks
   * behind testnet in 2026-11 and growing at the same ~1.7 blocks a second, passes through it about a year later: a
   * test app that keeps the signature could submit it there then, if the user's implicit account exists on mainnet with
   * this key (anyone can create it with a transfer). approvalSubject's rule for test apps' delegate actions
   * (nearTestAppDelegateProblem: calls and transfers to *.testnet accounts only) makes such a replay call an account that
   * doesn't exist on mainnet. For a test app the reads must come from two independent providers outside local* envs
   * (`near_rpc_single_provider` otherwise).
   * RPC down: `api_unavailable` (fail closed).
   */
  private async checkNearDelegate(delegateBytes: Uint8Array): Promise<void> {
    this.requireIndependentNear();
    const da = decodeNearDelegateAction(delegateBytes);
    let keys: ({ nonce: bigint; blockHeight: bigint } | null)[];
    try {
      keys = await this.near!.accessKey(da.senderId, nearKeyString(da.publicKey), true);
    } catch {
      throw new VaultError('api_unavailable', `Hana couldn’t check this delegate action on NEAR ${this.env.network}, try again`, { reason: 'near_rpc_unavailable' });
    }
    const refuse = (reason: string, message: string) => new VaultError(ErrorCode.unauthorized, `${message}. ${TEST_APP_NETWORK_RULE}`, { reason, chain: 'near' });
    for (const key of keys) {
      if (!key) throw refuse('near_key_unknown', `This NEAR account has no such key on ${this.env.network} yet: create (activate) the account first`);
      if (da.nonce <= key.nonce) throw refuse('near_delegate_nonce_used', `This delegate action's nonce is used: build it again with nearDelegateNonce from the key's nonce and height on ${this.env.network}`);
      if (da.nonce <= nearDelegateNonceFloor(key.blockHeight)) throw refuse('near_delegate_nonce_stale', `This delegate action's nonce is too low for ${this.env.network}'s current height: build it with nearDelegateNonce`);
      if (da.nonce >= key.blockHeight * NEAR_NONCE_PER_BLOCK) throw refuse('near_delegate_nonce_too_large', 'This delegate action’s nonce is too large for the current block height');
      if (da.maxBlockHeight <= key.blockHeight || da.maxBlockHeight > key.blockHeight + BigInt(NEAR_DELEGATE_MAX_BLOCKS)) {
        throw refuse('near_delegate_expiry', `This delegate action must expire within ${NEAR_DELEGATE_MAX_BLOCKS} blocks of ${this.env.network}'s current height`);
      }
    }
  }

  /**
   * The mainnet demo's usage event (D428): what was signed, on which network, for how much, from which address; never
   * a key, a signature or the transaction's bytes. Best effort: a failure never touches the signature.
   */
  private reportDemoSignature(s: Session, subject: ReturnType<typeof approvalSubject>, prices: MainnetDemoPriceBook): void {
    // The mainnet demo covers Stellar and EVM only (never NEAR, D726).
    const chain = subject.chain;
    if (chain !== 'stellar' && chain !== 'evm') return;
    const assessed = assessMainnetDemo(subject, this.clock.now(), prices, { wallets: { stellar: s.addresses.stellar, evm: s.addresses.evm } });
    const api = this.api;
    // The session's proof of the signing address (the identity token's): without one there is nothing to report with.
    const proof = s.walletProofs?.[chain];
    if (!assessed.ok || !api || !proof || proof.address !== subject.address) return;
    const network = assessed.network.chain === 'evm' ? String(assessed.network.chainId) : assessed.network.network;
    void demoEventBody(s.keyPair.privateKey, {
      signer: this.env.signer,
      appId: this.config.appId,
      sessionPublicKey: Uint8Array.from(s.sessionPk),
      issuedAtMs: this.clock.now(),
      event: { chain, network, kind: subject.kind, usdMicros: assessed.usdMicros.toString() },
      proof,
    })
      .then((body) => api.mainnetDemoEvent(body))
      .catch(() => undefined);
  }

  /**
   * Signs under the accepted policy if it covers the request: under the per-app lock, with the consent and today's
   * counters re-read (from the record in 'session' mode, so tabs share them), and the counters written back.
   */
  private async tryAutoSign(
    s: Session,
    request: SignRequest,
    subject: ReturnType<typeof approvalSubject>,
    policy: PolicyInForce,
  ): Promise<{ kind: 'signed'; result: unknown } | { kind: 'no_consent' } | { kind: 'miss'; reason: string } | { kind: 'unconfirmed' }> {
    type Outcome = { kind: 'signed'; result: unknown; match: Extract<AutoApproveResult, { ok: true }> } | { kind: 'no_consent' } | { kind: 'miss'; reason: string } | { kind: 'unconfirmed' };
    const outcome = await this.withConsent<Outcome>(s, async (consent) => {
      // A logout or expiry while the lock was awaited zeroed PRK: never sign with it.
      if (this.live() !== s) throw sessionEnded(s);
      const now = this.clock.now();
      // The lock can be slow: the policy must still be this one, confirmed within the bound, when the signature is made.
      if (this.policy?.policyId !== policy.policyId || !this.policyFresh()) return { value: { kind: 'unconfirmed' } };
      if (!consentActive(consent, policy, now, s.expiresAtMs)) return { value: { kind: 'no_consent' } };
      // Under the lock, on the consent actually read: never a consent the API hasn't just confirmed.
      if (!this.consentConfirmed(consent.consentId!)) return { value: { kind: 'unconfirmed' } };
      const match = matchAutoApprovePolicy(policy.policy, subject, { usage: consent, nowMs: now });
      if (!match.ok) return { value: { kind: 'miss', reason: match.reason } };
      const result = signRequest(s.prk, request, subject);
      const usage = recordAutoApproveUse(consent, now, match.spend);
      return { value: { kind: 'signed', result, match }, write: withUsage(consent, usage) };
    });
    if (outcome.kind === 'signed') {
      this.emit('autoApproved', { kind: request.method, chain: outcome.match.chain, contract: outcome.match.contract.slice(0, 128), function: outcome.match.function.slice(0, 128) });
      this.launcher.flash(`Signed by Hana under ${policy.policy.label}`, AUTO_APPROVED_FLASH_MS);
      return { kind: 'signed', result: outcome.result };
    }
    return outcome;
  }

  /**
   * Runs `fn` with the current consent and writes back what it returns (`write`; null clears it). In 'session' mode
   * this holds the per-app lock and reads and seals the consent in the record; a consent that fails to open deletes
   * the record and ends the session.
   */
  private async withConsent<T>(s: Session, fn: (consent: ConsentV1 | null) => Promise<{ value: T; write?: ConsentV1 | null }>): Promise<T> {
    // Right after a login the record may still be in the making: the consent goes to the record once it exists (or to
    // memory if it never will), never to a memory copy that the new record then silently drops.
    if (s.persist) {
      await this.persisted(s);
      if (this.session !== s) throw sessionEnded(s);
    }
    if (!s.share || !this.store) {
      // No record and no per-app lock here: one at a time per session, so parallel requests each see the last one's
      // counters and the daily limits bind.
      const run = async (): Promise<T> => {
        if (this.session !== s) throw sessionEnded(s);
        const out = await fn(s.consent);
        if (out.write !== undefined) s.consent = out.write;
        return out.value;
      };
      const queued = (s.consentQueue ?? Promise.resolve()).then(run);
      s.consentQueue = queued.catch(() => undefined);
      return queued;
    }
    const share = s.share;
    const store = this.store;
    let tampered = false;
    let gone = false;
    const value = await this.o.locks.request(this.lockName, async () => {
      const read = await this.readRecord().catch(() => null);
      // The session ended while the lock or the read was awaited: PRK is zeroed, so a failed open would not be tampering.
      if (this.session !== s) {
        gone = true;
        return null;
      }
      const record = read && read !== 'invalid' && sameSession(read, { sessionPk: s.sessionPk, shareId: share.shareId }) ? read : null;
      let consent: ConsentV1 | null = s.consent;
      if (record) {
        try {
          consent = await openConsent(s.prk, record);
        } catch {
          tampered = true;
          await this.dropRecordAt(store);
          return null;
        }
        // A consent from before registering existed: the API can't see it, so it can't be stopped remotely. It is
        // dropped here and the user is asked again.
        if (consent && !consent.consentId) {
          consent = null;
          delete record.consent;
          await store.put(this.recordId, record).catch(() => undefined);
        }
      }
      s.consent = consent;
      const out = await fn(consent);
      if (out.write !== undefined) {
        // Never seal under a PRK zeroed while `fn` ran. Clearing needs no key.
        if (out.write !== null && this.session !== s) {
          gone = true;
          return null;
        }
        s.consent = out.write;
        if (record) {
          if (out.write === null) delete record.consent;
          else record.consent = await sealConsent(s.prk, record, out.write);
          await store.put(this.recordId, record);
        }
      }
      return { v: out.value };
    });
    if (gone) throw sessionEnded(s);
    if (tampered || value === null) {
      this.endSession(true);
      throw disconnected('The vault record was tampered with');
    }
    return value.v;
  }

  /** True while consent `id` has an `'active'` answer asked within POLICY_FRESH_MS (or the register that recorded it). */
  private consentConfirmed(id: string): boolean {
    const r = this.consentRead;
    if (!r || r.id !== id || r.status !== 'active') return false;
    // The larger of two clocks: the corrected clock holds still after a device clock goes back, and a monotonic timer
    // may not run while the device sleeps. Either alone could stretch the 10 s.
    return Math.max(this.clock.now() - r.at, this.perfNow() - r.sent) < POLICY_FRESH_MS;
  }

  /**
   * Whether this session's consent may auto-sign now: `'none'` (no consent in force: the usual consent path), `'active'`
   * (confirmed `'active'` within POLICY_FRESH_MS), or `'hold'`: the status couldn't be confirmed (the read failed, or
   * gave no answer; the consent stays), or the answer was `'revoked'` or `'unknown'` (the consent is cleared). A `'hold'`
   * request goes to the approval popup. This is the existing read: it re-asks only when the last answer is older.
   */
  private async confirmConsent(s: Session, policy: PolicyInForce): Promise<'none' | 'active' | 'hold'> {
    const consent = await this.withConsent(s, async (c) => ({ value: c }));
    if (!consentActive(consent, policy, this.clock.now(), s.expiresAtMs)) return 'none';
    const id = consent.consentId!;
    if (this.consentConfirmed(id)) return 'active';
    if (!(await this.consentEnded(s, id))) {
      // A read in flight that asked about another consent (or none) answers nothing here: let it finish, then ask.
      if (this.policyCheck && this.consentAsked !== id) await this.policyCheck.catch(() => undefined);
      if (!this.consentConfirmed(id)) await this.refreshPolicy().catch(() => undefined);
    }
    if (this.live() !== s) return 'hold';
    if (await this.consentEnded(s, id)) return 'hold';
    return this.consentConfirmed(id) ? 'active' : 'hold';
  }

  /** True when the last answer about consent `id` was `'revoked'` or `'unknown'`: the local consent is cleared here. */
  private async consentEnded(s: Session, id: string): Promise<boolean> {
    const read = this.consentRead;
    if (read?.id !== id || read.status === 'active') return false;
    await this.clearConsentId(s, id);
    return true;
  }

  /** Clears the local consent if it is still `id` (another tab may have replaced it since). */
  private async clearConsentId(s: Session, id: string): Promise<void> {
    if (this.session !== s) return;
    await this.withConsent(s, async (c) => (c?.consentId === id ? { value: undefined, write: null } : { value: undefined }));
  }

  /** One signed consent call: `'session'` mode under the share's counter (a stale one retried with `expected`), `'none'` with counter 0. */
  private serverConsentCall<T>(who: ConsentHolder, payload: Uint8Array, send: (proof: ConsentProof) => Promise<T>): Promise<T> {
    const proof = async (counter: number): Promise<ConsentProof> => ({
      ...(who.share ? { shareId: Array.from(who.share.shareId) } : {}),
      sessionPublicKey: Array.from(who.sessionPk),
      counter,
      signature: Array.from(await signVaultMessage(who.keyPair.privateKey, { signer: this.env.signer, appId: this.config.appId, shareId: who.share?.shareId ?? new Uint8Array(16), counter, payload })),
    });
    if (!who.share) return proof(0).then(send);
    return this.nextCounter(who.sessionPk, who.share, async (counter) => send(await proof(counter)));
  }

  /**
   * Records a consent on the API (Hana Home, register before use). `503 session_not_visible` (the chain hasn't caught
   * up with a just-made session) is tried a few times, waiting its `Retry-After`; anything else ends it (a stale counter
   * is retried inside `serverConsentCall`; a repeated id is not, and neither is anything else).
   */
  private async registerConsent(s: Session, policy: PolicyInForce, consentId: string, expiresAtMs: number): Promise<void> {
    if (s.persist) await this.persisted(s);
    if (this.live() !== s) throw sessionEnded(s);
    const id = fromHex(consentId);
    const policyBytes = fromHex(policy.policyId);
    const payload = consentRegisterPayload({ consentId: id, policyId: policyBytes, expiresAtMs, parentOrigin: this.parentOrigin! });
    const who: ConsentHolder = { keyPair: s.keyPair, sessionPk: s.sessionPk, share: s.share };
    for (let attempt = 0; ; attempt++) {
      try {
        const at = this.clock.now();
        const sent = this.perfNow();
        await this.serverConsentCall(who, payload, (proof) => this.api!.registerConsent({ ...proof, consentId: Array.from(id), policyId: Array.from(policyBytes), expiresAtMs }));
        this.consentRead = { id: consentId, status: 'active', at, sent };
        return;
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'session_not_visible' || attempt >= CONSENT_NOT_VISIBLE_RETRIES) throw e;
        const retryS = e.details.retryAfterS;
        await sleep(this.timers, Math.max(CONSENT_RETRY_MIN_MS, Math.min(typeof retryS === 'number' ? retryS * 1000 : CONSENT_RETRY_MIN_MS, CONSENT_RETRY_MAX_MS)));
        if (this.live() !== s) throw sessionEnded(s);
      }
    }
  }

  /** Best effort: tells the API the consent `id` is stopped. Only ever for a consent this device holds. */
  private sendConsentRevoke(who: ConsentHolder, id: string): void {
    const api = this.api;
    if (!api) return;
    const consentId = fromHex(id);
    void this.serverConsentCall(who, consentRevokePayload(consentId), (proof) => api.revokeConsent({ ...proof, consentId: Array.from(consentId) })).catch(() => undefined);
  }

  /** The consent screen; on Allow, records the consent with the API and only then stores it. Fails closed. */
  private async askConsent(s: Session, policy: PolicyInForce): Promise<boolean> {
    // The end the Allow is for, bounded by the session and by the share's absolute end (the API's rule).
    const expiresAtMs = Math.min(consentEnd(policy, this.clock.now(), s.expiresAtMs), s.share?.absExpiresAtMs ?? Number.POSITIVE_INFINITY);
    const outcome: ApprovalOutcome = await this.approvals!.requestConsent(policy.policy, policy.policyId, expiresAtMs);
    if (outcome === 'cancelled' || this.live() !== s) throw sessionEnded(s);
    if (outcome !== 'approved') {
      this.declinedPolicyId = policy.policyId;
      return false;
    }
    this.declinedPolicyId = null;
    const consentId = randomHex128();
    try {
      await this.registerConsent(s, policy, consentId, expiresAtMs);
    } catch (e) {
      if (this.live() !== s) throw sessionEnded(s);
      if (e instanceof ApiError && e.status === 410 && (s.share || e.details.reason !== 'unknown_share')) {
        // The session is over on the server: end it here as a touch's 410 does, rather than offer a screen that can't work.
        // A session with no share is told `unknown_share` when the app keeps logins and it has none (its share was never
        // made, or the app switched to 'session' after this tab loaded). That session is fine in memory: it fails closed.
        // Signed out only when the API says revoked (D695).
        const signedOut = shareRevokedRefusal(e);
        void this.deleteRecordIf(s).catch(() => undefined);
        if (s.share) this.broadcastRevoked(s.share.shareId, signedOut);
        this.endSession(true, signedOut ? { reason: 'signed_out' } : {});
        throw sessionEnded(s, 'This session was revoked').fromRequest(e);
      }
      // The API says how late the share may really run (a lowered session TTL): the next Allow asks for that end.
      const cap = e instanceof ApiError && e.code === 'bad_expiry' ? e.details.maxExpiresAtMs : undefined;
      if (s.share && Number.isSafeInteger(cap) && (cap as number) < expiresAtMs) s.share.absExpiresAtMs = cap as number;
      this.consentRegisterFailedAt = this.clock.now();
      throw consentNotRecorded(e);
    }
    // A session that ended during the register: nothing is stored, and the row just made is stopped.
    if (this.live() !== s) {
      this.sendConsentRevoke({ keyPair: s.keyPair, sessionPk: s.sessionPk, share: s.share }, consentId);
      throw sessionEnded(s);
    }
    try {
      await this.withConsent(s, async () => ({ value: null, write: newConsent(policy, this.clock.now(), expiresAtMs, consentId) }));
    } catch (e) {
      this.sendConsentRevoke({ keyPair: s.keyPair, sessionPk: s.sessionPk, share: s.share }, consentId);
      throw e;
    }
    return true;
  }

  private async requestAutoApprove(): Promise<PortResultMap['hana_requestAutoApprove']> {
    const s = this.live();
    if (!s) throw notLoggedIn();
    // The consent first, so the policy read below also asks about it (this tab may hold none in memory after a reload).
    if (this.policy && !s.consent) await this.withConsent(s, async (c) => ({ value: c }));
    // A stale policy is re-read first; if that fails, the consent screen still shows the cached one (signing re-checks).
    const policy = (await this.freshPolicy()) ?? this.policy;
    if (this.live() !== s) throw sessionEnded(s);
    if (!policy) throw new VaultError(ErrorCode.unauthorized, 'This app has no auto-approve policy in force');
    // A consent the API says has ended is cleared before this answers; one it can't confirm stays, and isn't reported as granted.
    const standing = await this.confirmConsent(s, policy);
    if (this.live() !== s) throw sessionEnded(s);
    const active = await this.withConsent(s, async (c) => ({ value: consentActive(c, policy, this.clock.now(), s.expiresAtMs) ? c : null }));
    if (active && standing === 'hold') throw new VaultError('api_unavailable', 'Hana could not confirm auto-approve right now', { granted: false, reason: 'consent_unconfirmed' });
    if (active) return { granted: true, policyId: policy.policyId, expiresAtMs: active.expiresAtMs };
    // Only a consent screen actually shown counts as activity (D112).
    this.noteActivity();
    const granted = await this.askConsent(s, policy);
    if (!granted) return { granted: false };
    const now = await this.withConsent(s, async (c) => ({ value: c }));
    return now ? { granted: true, policyId: policy.policyId, expiresAtMs: now.expiresAtMs } : { granted: false };
  }

  /**
   * The active consent's status. Live: read from the record (it is sealed under PRK, so reading it needs the key in
   * memory). Dormant: this tab's last known consent, without waking the session (a status poll must not bring PRK
   * back); its counters may lag auto-signs made by other tabs since, until the next request that uses the key.
   */
  private async autoApproveStatusResult(): Promise<PortResultMap['hana_autoApproveStatus']> {
    const s = this.live();
    const policy = this.policy;
    if (!policy) return null;
    if (!s) {
      const d = this.liveDormant();
      const now = this.clock.now();
      return d && consentActive(d.consent, policy, now, d.expiresAtMs) ? autoApproveStatus(d.consent, policy, now) : null;
    }
    return this.withConsent(s, async (c) => ({ value: consentActive(c, policy, this.clock.now(), s.expiresAtMs) ? autoApproveStatus(c, policy, this.clock.now()) : null }));
  }

  /**
   * Stops the consent: cleared here first, then the API is told, best effort. With no consent in force there is nothing
   * to tell it: the API is called only for a consent this tab holds (a stray call can't be turned into another's revoke
   * by a hostile page either, as the server keys every row by this session key).
   */
  private async revokeAutoApprove(): Promise<void> {
    const s = this.session;
    if (s) {
      const id = await this.withConsent(s, async (c) => ({ value: c?.consentId ?? null, write: null }));
      this.consentRead = null;
      if (id) this.sendConsentRevoke({ keyPair: s.keyPair, sessionPk: s.sessionPk, share: s.share }, id);
      return;
    }
    await this.revokeDormantConsent();
  }

  /**
   * The same while the session is dormant (no PRK, and a revoke must not wake it): deleting the sealed consent needs no
   * key. The tab's last known consent gives the id, and without one the API isn't called.
   */
  private async revokeDormantConsent(): Promise<void> {
    const d = this.liveDormant();
    if (!d) return;
    const id = d.consent?.consentId ?? null;
    d.consent = null;
    this.consentRead = null;
    const store = this.store;
    if (store) {
      await this.o.locks
        .request(this.lockName, async () => {
          const read = await this.readRecord().catch(() => null);
          if (!read || read === 'invalid' || !sameSession(read, { sessionPk: d.sessionPk, shareId: d.shareId }) || !read.consent) return;
          delete read.consent;
          await store.put(this.recordId, read);
        })
        .catch(() => undefined);
    }
    if (id) this.sendConsentRevoke({ keyPair: d.keyPair, sessionPk: d.sessionPk, share: { shareId: d.shareId, counter: 0, createdAt: null, absExpiresAtMs: null } }, id);
  }

  // ---- export (vault side; docs/batch-b-spec.md "Key export" steps 1–2) ----

  private startExport(chain: 'stellar' | 'evm' | 'near'): Promise<null> {
    const s = this.live();
    if (!s) return Promise.reject(notLoggedIn());
    // The export window signs in again on its own, with Google or (an app with email, batch 8b: D246 lifted) an email
    // code, and resolves the path through `get_identity` itself; it shows the key only if it is this session's address.
    if (!isOwnLoginPath(s.path, this.config.scopeId)) return Promise.reject(new VaultError(ErrorCode.unsupportedMethod, 'Key export is not available for this wallet'));
    if (this.exportJob) return Promise.reject(new VaultError('busy', 'An export is already running'));
    return new Promise<null>((resolve, reject) => {
      const job: ExportJob = {
        chain,
        address: s.addresses[chain],
        window: null,
        contextSent: false,
        intent: null,
        timer: null,
        poll: null,
        resolve: () => resolve(null),
        reject,
      };
      this.exportJob = job;
      job.intent = this.launcher.push('Export key in Hana', () => this.openExportWindow(job));
      job.timer = this.timers.setTimeout(() => {
        if (!job.contextSent) this.finishExport(job, userRejected('The export was not started'));
      }, EXPORT_START_MS);
    });
  }

  /** The launcher click: a top-level window on authOrigin with a random name (no `popup` feature). */
  private openExportWindow(job: ExportJob): void {
    if (this.exportJob !== job || job.window) return;
    const w = this.host.open(`${this.env.authOrigin}/export`, `hana-export-${randomHex128()}`, '');
    if (!w) return;
    job.window = w;
    job.intent?.remove();
    job.intent = null;
    const started = this.deviceNow();
    const tick = () => {
      job.poll = null;
      if (this.exportJob !== job) return;
      let closed = true;
      try {
        closed = w.closed;
      } catch {
        // Treat an unreadable handle as closed.
      }
      if (closed) {
        this.finishExport(job, job.contextSent ? null : userRejected('The export window was closed'));
        return;
      }
      if (this.deviceNow() - started >= EXPORT_MAX_MS) {
        // The job's own limit: the window is told to end too, so it never outlives the vault's view of it (D111).
        this.cancelExport(userRejected('The export window was closed'));
        return;
      }
      job.poll = this.timers.setTimeout(tick, 1_000);
    };
    job.poll = this.timers.setTimeout(tick, 1_000);
  }

  private onExportHello(e: WindowMessageEvent): void {
    const job = this.exportJob;
    if (!job || !job.window || job.contextSent || e.source !== job.window || e.origin !== this.env.authOrigin) return;
    // The session may have ended (expiry with a delayed timer) since the export started: no context for it.
    const s = this.live();
    if (!s) {
      this.cancelExport(disconnected());
      return;
    }
    job.contextSent = true;
    job.window.postMessage(
      {
        v: 1,
        t: 'hana:export-context',
        pk: this.config.publishableKey,
        appName: this.config.appName,
        parentOrigin: this.parentOrigin!,
        scopeId: this.config.scopeId,
        signer: this.env.signer,
        keyIndex: 0,
        chain: job.chain,
        address: job.address,
        sessionExpiresAtMs: s.expiresAtMs,
        ...(this.logoUrl ? { logoUrl: this.logoUrl } : {}),
      },
      this.env.authOrigin,
    );
    // The vault's part is done; the job stays (busy) until the export window closes, and the session's end still
    // reaches the window (cancelExport).
    job.resolve();
  }

  private finishExport(job: ExportJob, error: VaultError | null): void {
    if (this.exportJob !== job) return;
    this.exportJob = null;
    job.intent?.remove();
    this.timers.clearTimeout(job.timer);
    if (job.poll !== null) this.timers.clearTimeout(job.poll);
    if (error) job.reject(error);
  }

  /**
   * Ends a running export with the session (logout, revoke, expiry, a newer login) or at EXPORT_MAX_MS. A window that
   * has its context (it may already hold the key) is told `hana:export-end` and erases the key (D111, sweep AUTH-1);
   * it stays open to say why. One that hasn't is closed.
   */
  private cancelExport(error: VaultError): void {
    const job = this.exportJob;
    if (!job) return;
    if (job.window) {
      try {
        if (job.contextSent) job.window.postMessage({ v: 1, t: 'hana:export-end' }, this.env.authOrigin);
        else job.window.close();
      } catch {
        // Already gone.
      }
    }
    this.finishExport(job, job.contextSent ? null : error);
  }
}
