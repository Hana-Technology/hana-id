// Cross-window protocol (docs/batch-b-spec.md "Protocol", "Login", "Approval flow", "Key export", "Unlock"): the
// message schemas and their validators, shared by the partner client, the vault, the auth pages and the tests.
//
// Every message is a plain object sent by structured clone; bytes travel as Uint8Array. Every receiver checks
// `v === 1`, an allow-list of `t`, `method` or `event` values, the exact field set and types, and a size cap
// (192 KiB for sign requests and approval requests, 8 KiB for everything else). The parse* functions return null for
// anything else, and the receiver drops it without a reply.
//
// SECURITY: no schema here has a field for key bytes, S, PRK, a CKD response, a Google token or a session secret. The
// one session secret that crosses postMessage is `relayKey` (hana:auth-params, vault → login popup on authOrigin).
import { isEvmAddress, isStellarAddress } from './addresses.ts';
import { APPROVAL_KINDS, type ApprovalContext, type ApprovalKind, approvalKindChain, validateApprovalSubject } from './approval.ts';
import { base64Decode, from0xHex, toHex, utf8, utf8Length } from './bytes.ts';
import { isDisplaySafeLine } from './display-safe.ts';
import { IDENTITY_MAX_MAX_AGE_MS, IDENTITY_MIN_MAX_AGE_MS } from './identity.ts';
import { isLogoUrl } from './logo.ts';
import { isSupportId } from './support-id.ts';
import { KEY_INDEX_LIMIT, MAX_USES_LIMIT, RELAY_ID_PATTERN, SALT_MAX_BYTES, SALT_MIN_BYTES, SHARE_ID_BYTES } from './layouts.ts';
import { type FollowProve, isFollowProve } from './relay.ts';
import { type EvmTxRequest, evmTxSigningPayload, parseEvmTxRequest } from './signers/evm.ts';
import { isTimings } from './timings.ts';
import { MAINNET_DEMO_EVM_CHAINS, MAINNET_DEMO_STELLAR_PASSPHRASE } from './demo-config.ts';
import { type MainnetDemoPriceBook, parseMainnetDemoPrices } from './mainnet-demo-prices.ts';

export const PROTOCOL_VERSION = 1;
/** Cap for sign requests (port). */
export const SIGN_MESSAGE_MAX_BYTES = 192 * 1024;
/** Cap for every other message. */
export const MESSAGE_MAX_BYTES = 8 * 1024;
/**
 * Cap for what a sign request turns into: the approval and consent requests (window) and sign-method replies (port).
 * Each carries content up to SIGN_MESSAGE_MAX_BYTES (the request's bytes, or the signed envelope: the input plus a
 * signature) plus fields of its own (app name, origin, address, ids), which MESSAGE_MAX_BYTES of headroom covers, so
 * every sign request the port accepts yields an approval request the popup accepts and a reply the SDK accepts.
 */
export const APPROVAL_MESSAGE_MAX_BYTES = SIGN_MESSAGE_MAX_BYTES + MESSAGE_MAX_BYTES;
const MAX_DEPTH = 24;

// ---- errors ----

/** Numeric codes (EIP-1193 style). */
export const ErrorCode = {
  /** User rejected (approval Reject, popup closed, approval timeout). */
  userRejected: 4001,
  /** Not logged in, address mismatch, or method not allowed for this app (for example raw signing off). */
  unauthorized: 4100,
  unsupportedMethod: 4200,
  /** Vault disconnected (logout, session expired). */
  disconnected: 4900,
  /** EVM chain not configured. */
  chainNotConfigured: 4902,
} as const;

/** String codes. */
export const STRING_ERROR_CODES = [
  'vault_unavailable',
  'popup_blocked',
  'coop_blocks_popup',
  'storage_unavailable',
  'login_timeout',
  'login_cancelled',
  'google_error',
  'no_google_client',
  'token_invalid',
  'token_has_pii',
  'config_mismatch',
  'ckd_failed',
  'derive_failed',
  'pairing_failed',
  'address_mismatch',
  'session_consumed',
  'rate_limited',
  'app_suspended',
  'origin_not_allowed',
  'api_unavailable',
  'busy',
  /** hana_identityToken: the API or its signer is unavailable (retryable). */
  'identity_unavailable',
  /** hana_identityToken: the Hana session ended (the vault also fires sessionExpired) or ends within 30 s. */
  'session_ended',
  /**
   * hana_login: the `method` asked for is not one the app offers here (its `login_methods`, its scope's clients, or an
   * env without an email issuer). Email login, build plan batch 8a.
   */
  'login_method_unavailable',
  /** hana_login (email): the user gave up after a wrong code (the popup handles wrong codes itself). */
  'code_invalid',
  /** hana_login (email): the user gave up after the code expired, was used or ran out of attempts. */
  'challenge_expired',
  /** hana_login: this sign-in method is a pending member of an account (the API's `409 link_pending`). */
  'link_pending',
  /**
   * hana_login, hana_linkAccount: the sign-in methods can't be linked (`data.reason`: `already_linked`,
   * `has_wallet`, `account_full`, `provider_taken`, `unlinked`, `both_wallets`, `link_mismatch`, `links_unavailable`,
   * `same_identity`).
   */
  'link_refused',
  /**
   * hana_requestEmailSharing: Hana can't ask now (`data.reason`: `off`, the app's `identity_email` setting;
   * `no_address`, the session has no address Hana can read, e.g. the issuer was unreachable at login; `unavailable`,
   * the API or its keys).
   */
  'email_sharing_unavailable',
] as const;

export type StringErrorCode = (typeof STRING_ERROR_CODES)[number];
export type HanaErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode] | StringErrorCode;

export interface ProtocolError {
  code: HanaErrorCode;
  message: string;
  data?: unknown;
}

const NUMERIC_CODES: ReadonlySet<unknown> = new Set(Object.values(ErrorCode));
export const isHanaErrorCode = (v: unknown): v is HanaErrorCode => NUMERIC_CODES.has(v) || (STRING_ERROR_CODES as readonly unknown[]).includes(v);

// ---- size and shape helpers ----

/** UTF-8 size of a string, or Infinity when it can't fit in `room` (checked on length first, which is cheaper). */
const stringSize = (s: string, room: number): number => (s.length > room ? Number.POSITIVE_INFINITY : utf8Length(s));

/**
 * An estimate of a structured-clone message's size in bytes (UTF-8 for strings and keys, byte length for
 * Uint8Arrays), or Infinity once it passes `limit`, nests deeper than 24 levels, or holds anything but plain objects,
 * arrays, Uint8Arrays, strings, numbers, booleans, null and undefined (no Map, Date, ArrayBuffer, Blob, prototypes
 * other than Object's, cycles or shared references).
 */
export function messageSize(value: unknown, limit: number): number {
  let total = 0;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (v === null || v === undefined || typeof v === 'boolean') total += 1;
    else if (typeof v === 'number') total += 8;
    else if (typeof v === 'string') total += stringSize(v, limit - total);
    else if (v instanceof Uint8Array) total += v.byteLength;
    else if (typeof v === 'object') {
      if (seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) {
        for (const item of v) if (!walk(item, depth + 1)) return false;
      } else {
        if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
        for (const [k, item] of Object.entries(v)) {
          total += stringSize(k, limit - total);
          if (!walk(item, depth + 1)) return false;
        }
      }
    } else return false;
    return total <= limit;
  };
  return walk(value, 0) ? total : Number.POSITIVE_INFINITY;
}

type Obj = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Exactly the `required` keys plus any of `optional` (an optional key that is present must not be undefined). */
function exactKeys(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(o)) if (!allowed.has(k) || o[k] === undefined) return false;
  return required.every((k) => Object.hasOwn(o, k));
}

const isStr = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isBytes = (v: unknown, min: number, max: number): v is Uint8Array => v instanceof Uint8Array && v.length >= min && v.length <= max;
const isChain = (v: unknown): v is 'stellar' | 'evm' => v === 'stellar' || v === 'evm';
const isHex = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/u.test(v);

/** `scheme://host[:port]` exactly as URL.origin prints it. */
export function isOrigin(v: unknown): v is string {
  if (!isStr(v, 1, 512)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === v;
  } catch {
    return false;
  }
}

export const isPublishableKey = (v: unknown): v is string => typeof v === 'string' && /^pk_(?:test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u.test(v);
export const isScopeId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,64}$/u.test(v);
export const isNearAccountId = (v: unknown): v is string =>
  typeof v === 'string' && /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u.test(v);
/** An app name: 1 to 200 characters, none of them a control, bidi or invisible one (sweep AUTH-2, display-safe.ts). */
const isAppName = (v: unknown): v is string => isStr(v, 1, 200) && isDisplaySafeLine(v);
const isClientId = (v: unknown): v is string => isStr(v, 1, 256);
const isNonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v);
const isRelayId = (v: unknown): v is string => typeof v === 'string' && RELAY_ID_PATTERN.test(v);

/** The sign-in methods (`GET /v1/app` `loginMethods`, migration 0010 `apps.login_methods`), in their fixed order. */
export const LOGIN_METHODS = ['google', 'email'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];
export const isLoginMethod = (v: unknown): v is LoginMethod => v === 'google' || v === 'email';
/** Longest `emailHint` (RFC 5321's path limit): the popup only prefills its field with it, the issuer checks it. */
export const EMAIL_HINT_MAX = 254;
/**
 * An `emailHint`: one line of 3 to 254 characters with an `@`, no space, control, bidi or invisible character. Only a
 * prefill: the issuer normalizes and checks whatever the user sends.
 */
export const isEmailHint = (v: unknown): v is string => isStr(v, 3, EMAIL_HINT_MAX) && v.includes('@') && !/\s/u.test(v) && isDisplaySafeLine(v);
/** The methods offered in auth-params: distinct, in LOGIN_METHODS order. */
const isOfferedMethods = (v: unknown): v is LoginMethod[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= LOGIN_METHODS.length && v.every(isLoginMethod) && v.every((m, i) => i === 0 || LOGIN_METHODS.indexOf(m) > LOGIN_METHODS.indexOf(v[i - 1] as LoginMethod));
const isMs = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const isAddressFor = (chain: 'stellar' | 'evm', v: unknown): v is string => typeof v === 'string' && (chain === 'stellar' ? isStellarAddress(v) : isEvmAddress(v));

// ---- port: requests ----

export const PORT_METHODS = [
  'hana_status',
  'hana_login',
  'hana_cancelLogin',
  'hana_logout',
  'hana_export',
  'hana_revokeOtherDevices',
  'stellar_getAddress',
  'stellar_signTransaction',
  'stellar_signAuthEntry',
  'stellar_signMessage',
  'eth_accounts',
  'eth_signTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'hana_signRaw',
  'hana_requestAutoApprove',
  'hana_autoApproveStatus',
  'hana_revokeAutoApprove',
  'hana_identityToken',
  /** The wallet's sign-in methods (build plan batch 7, spec "SDK": `hana.account()`). */
  'hana_account',
  /** Add a sign-in method to the wallet (`hana.linkAccount({method})`, from a click). */
  'hana_linkAccount',
  /**
   * Show the email sharing sheet (`hana.requestEmailSharing()`, from a click: the SDK opens `/share-email` first,
   * `popupBlocked: true` when it couldn't, and the vault's launcher opens it).
   */
  'hana_requestEmailSharing',
] as const;

export type PortMethod = (typeof PORT_METHODS)[number];

/** Methods that produce a signature (192 KiB cap; approval or an accepted auto-approve policy). */
export const SIGN_METHODS = [
  'stellar_signTransaction',
  'stellar_signAuthEntry',
  'stellar_signMessage',
  'eth_signTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'hana_signRaw',
] as const satisfies readonly PortMethod[];

export type SignMethod = (typeof SIGN_METHODS)[number];
export const isSignMethod = (m: unknown): m is SignMethod => (SIGN_METHODS as readonly unknown[]).includes(m);

/**
 * Methods that may show the approval popup: the sign methods and the consent screen. Only these may carry
 * `popupOpened` (the partner page opened the approval popup in the user's click for this request).
 */
export const APPROVAL_POPUP_METHODS = [...SIGN_METHODS, 'hana_requestAutoApprove'] as const satisfies readonly PortMethod[];
export type ApprovalPopupMethod = (typeof APPROVAL_POPUP_METHODS)[number];
export const isApprovalPopupMethod = (m: unknown): m is ApprovalPopupMethod => (APPROVAL_POPUP_METHODS as readonly unknown[]).includes(m);

export interface PortParamsMap {
  hana_status: undefined;
  /**
   * `{popupBlocked: true}` when window.open returned null. `method`: open that sign-in method directly instead of the
   * chooser (`hana.login({method})`); `emailHint` prefills the email field (never with `method: 'google'`).
   */
  hana_login: { popupBlocked?: boolean; method?: LoginMethod; emailHint?: string } | undefined;
  hana_cancelLogin: undefined;
  hana_logout: undefined;
  hana_export: { chain: 'stellar' | 'evm' };
  hana_revokeOtherDevices: undefined;
  stellar_getAddress: undefined;
  stellar_signTransaction: { xdr: string; networkPassphrase: string; address?: string };
  stellar_signAuthEntry: { preimageXdr: string; networkPassphrase: string; address?: string };
  stellar_signMessage: { message: string | Uint8Array; address?: string };
  eth_accounts: undefined;
  eth_signTransaction: { tx: EvmTxRequest };
  personal_sign: [message: `0x${string}`, address: string];
  eth_signTypedData_v4: [address: string, typedData: string];
  hana_signRaw: { chain: 'stellar'; bytes: Uint8Array } | { chain: 'evm'; digest: Uint8Array };
  hana_requestAutoApprove: undefined;
  hana_autoApproveStatus: undefined;
  hana_revokeAutoApprove: undefined;
  /** `maxAgeMs`: a token minted at most this long ago (IDENTITY_MIN_MAX_AGE_MS..IDENTITY_MAX_MAX_AGE_MS). */
  hana_identityToken: { maxAgeMs?: number } | undefined;
  hana_account: undefined;
  /** `popupBlocked: true` when window.open returned null (the vault's launcher opens the popup instead). */
  hana_linkAccount: { method: LoginMethod; popupBlocked?: boolean };
  hana_requestEmailSharing: { popupBlocked?: boolean } | undefined;
}

/**
 * `popupOpened: true` (only on APPROVAL_POPUP_METHODS): the SDK opened `{authOrigin}/approve?from=partner&v=…` in the
 * user's click for this request, so the vault waits briefly for that popup's hello before it shows its launcher, and
 * tells the popup to close if the request ends without an approval screen.
 */
export type PortRequest = { [M in PortMethod]: { v: 1; id: string; method: M; params: PortParamsMap[M]; popupOpened?: true } }[PortMethod];

/** No params: absent, undefined, or an empty array (EIP-1193 callers send `[]`). Parsed as undefined. */
const noParams = (p: unknown): boolean => p === undefined || (Array.isArray(p) && p.length === 0);
const PASSPHRASE_MAX = 256;
const XDR_MAX = SIGN_MESSAGE_MAX_BYTES;

function isBase64(v: unknown, max: number): v is string {
  if (!isStr(v, 4, max)) return false;
  try {
    base64Decode(v);
    return true;
  } catch {
    return false;
  }
}

function isEvmTxRequest(v: unknown): v is EvmTxRequest {
  if (!isPlainObject(v)) return false;
  try {
    parseEvmTxRequest(v);
    return true;
  } catch {
    return false;
  }
}

/** Params validators by method. Each returns the params to use (undefined for none), or null if invalid. */
const PARAMS: { [M in PortMethod]: (p: unknown) => PortParamsMap[M] | null } = {
  hana_status: (p) => (noParams(p) ? undefined : null),
  hana_login: (p) => {
    if (noParams(p)) return undefined;
    if (
      isPlainObject(p) &&
      exactKeys(p, [], ['popupBlocked', 'method', 'emailHint']) &&
      (p.popupBlocked === undefined || typeof p.popupBlocked === 'boolean') &&
      (p.method === undefined || isLoginMethod(p.method)) &&
      (p.emailHint === undefined || (isEmailHint(p.emailHint) && p.method !== 'google'))
    ) {
      return p as { popupBlocked?: boolean; method?: LoginMethod; emailHint?: string };
    }
    return null;
  },
  hana_cancelLogin: (p) => (noParams(p) ? undefined : null),
  hana_logout: (p) => (noParams(p) ? undefined : null),
  hana_export: (p) => (isPlainObject(p) && exactKeys(p, ['chain']) && isChain(p.chain) ? { chain: p.chain } : null),
  hana_revokeOtherDevices: (p) => (noParams(p) ? undefined : null),
  stellar_getAddress: (p) => (noParams(p) ? undefined : null),
  stellar_signTransaction: (p) =>
    isPlainObject(p) && exactKeys(p, ['xdr', 'networkPassphrase'], ['address']) && isBase64(p.xdr, XDR_MAX) && isStr(p.networkPassphrase, 1, PASSPHRASE_MAX) && (p.address === undefined || isAddressFor('stellar', p.address))
      ? (p as PortParamsMap['stellar_signTransaction'])
      : null,
  stellar_signAuthEntry: (p) =>
    isPlainObject(p) && exactKeys(p, ['preimageXdr', 'networkPassphrase'], ['address']) && isBase64(p.preimageXdr, XDR_MAX) && isStr(p.networkPassphrase, 1, PASSPHRASE_MAX) && (p.address === undefined || isAddressFor('stellar', p.address))
      ? (p as PortParamsMap['stellar_signAuthEntry'])
      : null,
  stellar_signMessage: (p) =>
    isPlainObject(p) && exactKeys(p, ['message'], ['address']) && (isStr(p.message, 0, SIGN_MESSAGE_MAX_BYTES) || isBytes(p.message, 0, SIGN_MESSAGE_MAX_BYTES)) && (p.address === undefined || isAddressFor('stellar', p.address))
      ? (p as PortParamsMap['stellar_signMessage'])
      : null,
  eth_accounts: (p) => (noParams(p) ? undefined : null),
  eth_signTransaction: (p) => (isPlainObject(p) && exactKeys(p, ['tx']) && isEvmTxRequest(p.tx) ? { tx: p.tx } : null),
  personal_sign: (p) => (Array.isArray(p) && p.length === 2 && isHex(p[0]) && isAddressFor('evm', p[1]) ? [p[0], p[1]] : null),
  eth_signTypedData_v4: (p) => (Array.isArray(p) && p.length === 2 && isAddressFor('evm', p[0]) && isStr(p[1], 2, SIGN_MESSAGE_MAX_BYTES) ? [p[0], p[1]] : null),
  hana_signRaw: (p) => {
    if (!isPlainObject(p)) return null;
    if (p.chain === 'stellar' && exactKeys(p, ['chain', 'bytes']) && isBytes(p.bytes, 1, 4096)) return { chain: 'stellar', bytes: p.bytes };
    if (p.chain === 'evm' && exactKeys(p, ['chain', 'digest']) && isBytes(p.digest, 32, 32)) return { chain: 'evm', digest: p.digest };
    return null;
  },
  hana_requestAutoApprove: (p) => (noParams(p) ? undefined : null),
  hana_autoApproveStatus: (p) => (noParams(p) ? undefined : null),
  hana_revokeAutoApprove: (p) => (noParams(p) ? undefined : null),
  hana_identityToken: (p) => {
    if (noParams(p)) return undefined;
    if (isPlainObject(p) && exactKeys(p, [], ['maxAgeMs']) && (p.maxAgeMs === undefined || isInt(p.maxAgeMs, IDENTITY_MIN_MAX_AGE_MS, IDENTITY_MAX_MAX_AGE_MS))) return p as { maxAgeMs?: number };
    return null;
  },
  hana_account: (p) => (noParams(p) ? undefined : null),
  hana_requestEmailSharing: (p) => {
    if (noParams(p)) return undefined;
    return isPlainObject(p) && exactKeys(p, [], ['popupBlocked']) && (p.popupBlocked === undefined || typeof p.popupBlocked === 'boolean') ? (p as { popupBlocked?: boolean }) : null;
  },
  hana_linkAccount: (p) =>
    isPlainObject(p) && exactKeys(p, ['method'], ['popupBlocked']) && isLoginMethod(p.method) && (p.popupBlocked === undefined || typeof p.popupBlocked === 'boolean')
      ? (p as { method: LoginMethod; popupBlocked?: boolean })
      : null,
};

/** The size cap for a port request with `method`. */
export const portRequestCap = (method: unknown): number => (isSignMethod(method) ? SIGN_MESSAGE_MAX_BYTES : MESSAGE_MAX_BYTES);

/** Validates a port request (vault side). Unknown methods are null here; the vault answers them 4200 only if `id` is valid. */
export function parsePortRequest(data: unknown): PortRequest | null {
  if (!isPlainObject(data) || messageSize(data, portRequestCap(data.method)) === Number.POSITIVE_INFINITY) return null;
  if (!exactKeys(data, ['v', 'id', 'method'], ['params', 'popupOpened']) || data.v !== PROTOCOL_VERSION || !isStr(data.id, 1, 64)) return null;
  const method = data.method;
  if (!(PORT_METHODS as readonly unknown[]).includes(method)) return null;
  if (data.popupOpened !== undefined && (data.popupOpened !== true || !isApprovalPopupMethod(method))) return null;
  const params = PARAMS[method as PortMethod](data.params);
  if (params === null) return null;
  return { v: 1, id: data.id, method, params, ...(data.popupOpened === true ? { popupOpened: true } : {}) } as PortRequest;
}

/**
 * For a request parsePortRequest refused: the id to answer 4200 to if it is a well-formed request for an unknown
 * method (so EIP-1193 callers get "unsupported method" instead of a hang), else null (drop silently).
 */
export function unsupportedMethodId(data: unknown): string | null {
  if (!isPlainObject(data) || messageSize(data, MESSAGE_MAX_BYTES) === Number.POSITIVE_INFINITY) return null;
  if (!exactKeys(data, ['v', 'id', 'method'], ['params']) || data.v !== PROTOCOL_VERSION || !isStr(data.id, 1, 64)) return null;
  if (!isStr(data.method, 1, 64) || (PORT_METHODS as readonly unknown[]).includes(data.method)) return null;
  return data.id;
}

// ---- port: results, replies and events ----

export type VaultStatus = 'logged_in' | 'logged_out';
export type Persistence = 'session' | 'none';

export interface PortAddresses {
  stellar: string;
  evm: string;
}

export interface StatusResult {
  status: VaultStatus;
  addresses?: PortAddresses;
  expiresAtMs?: number;
  persistence: Persistence;
  /**
   * The logged-in user's Support ID (`HANA-XXXX-XXXX`, support-id.ts), the code to give Hana with request
   * IDs when escalating. Only while logged in, only when the API sent one with the session, and only to an SDK of
   * SUPPORT_ID_SDK_MIN or later (the vault reads the hello's `sdk`).
   */
  supportId?: string;
}

export interface LoginResult {
  addresses: PortAddresses;
  expiresAtMs: number;
  persistence: Persistence;
  /** The user's Support ID, as in StatusResult. */
  supportId?: string;
  /** Informational (`storage_unavailable`: persistence fell back to 'none'). */
  warning?: 'storage_unavailable';
  /** pk_test_ apps only: per-stage ms, no secrets (timings.ts, LOGIN_TIMING_STAGES). */
  timings?: Record<string, number>;
}

/** A partner identity token and when it expires, or nulls while logged out (hana_identityToken, identityTokenChanged). */
export interface IdentityTokenState {
  identityToken: string | null;
  expiresAtMs: number | null;
}

export interface AutoApproveStatus {
  policyId: string;
  label: string;
  expiresAtMs: number;
  used: { count: number; native: string };
}

/**
 * One sign-in method of the wallet's account (`hana.account()`; no `sub`, no address): the root (`root: true`, always
 * active) or a member, pending until `effectiveAtMs` or active since then.
 */
export interface AccountMethod {
  provider: LoginMethod;
  status: 'active' | 'pending';
  /** When the method could (or can) open the wallet; null for the wallet's own method (the root). */
  effectiveAtMs: number | null;
  root: boolean;
}

export interface AccountResult {
  methods: AccountMethod[];
}

/** A sign-in method added, activated or removed (`linkChanged`); `effectiveAtMs` for pending and active ones. */
export interface LinkChange {
  provider: LoginMethod;
  status: 'pending' | 'active' | 'removed';
  effectiveAtMs: number | null;
}

const isAccountMethod = (v: unknown): v is AccountMethod =>
  isPlainObject(v) &&
  exactKeys(v, ['provider', 'status', 'effectiveAtMs', 'root']) &&
  isLoginMethod(v.provider) &&
  (v.status === 'active' || v.status === 'pending') &&
  (v.effectiveAtMs === null || isMs(v.effectiveAtMs)) &&
  typeof v.root === 'boolean';
const isLinkChange = (v: unknown): v is LinkChange =>
  isPlainObject(v) &&
  exactKeys(v, ['provider', 'status', 'effectiveAtMs']) &&
  isLoginMethod(v.provider) &&
  (v.status === 'pending' || v.status === 'active' || v.status === 'removed') &&
  (v.effectiveAtMs === null || isMs(v.effectiveAtMs));

export interface PortResultMap {
  hana_status: StatusResult;
  hana_login: LoginResult;
  hana_cancelLogin: null;
  hana_logout: null;
  hana_export: null;
  hana_revokeOtherDevices: { revoked: number };
  stellar_getAddress: { address: string };
  stellar_signTransaction: { signedTxXdr: string; signerAddress: string };
  stellar_signAuthEntry: { signedAuthEntry: string; signerAddress: string };
  stellar_signMessage: { signedMessage: string; signerAddress: string };
  eth_accounts: string[];
  eth_signTransaction: `0x${string}`;
  personal_sign: `0x${string}`;
  eth_signTypedData_v4: `0x${string}`;
  hana_signRaw: { signature: Uint8Array };
  hana_requestAutoApprove: { granted: boolean; policyId?: string; expiresAtMs?: number };
  hana_autoApproveStatus: AutoApproveStatus | null;
  hana_revokeAutoApprove: null;
  hana_identityToken: IdentityTokenState;
  hana_account: AccountResult;
  hana_linkAccount: LinkChange;
  /** Where sharing stands after the sheet: shared, not shared ("Not now", or stopped), or the window closed. */
  hana_requestEmailSharing: { state: EmailSharingResult };
}

/**
 * The first SDK version that knows `hana_requestEmailSharing` and the `emailSharingChanged` event. The vault sends
 * the event only to an SDK whose `hana:hello` names this version or later.
 */
export const EMAIL_SHARING_SDK_MIN = '0.3.0';

/** hana_requestEmailSharing's answer: `dismissed` = the sheet was closed, nothing recorded. */
export type EmailSharingResult = 'granted' | 'declined' | 'dismissed';

/** A compact ES256 JWS as the API mints it (core identity.ts isIdentityTokenResponse's shape), at most ~4 KiB. */
const isIdentityJwt = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096 && /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{86}$/u.test(v);
const isIdentityTokenState = (v: unknown): v is IdentityTokenState =>
  isPlainObject(v) &&
  exactKeys(v, ['identityToken', 'expiresAtMs']) &&
  ((v.identityToken === null && v.expiresAtMs === null) || (isIdentityJwt(v.identityToken) && isMs(v.expiresAtMs)));

const isPersistence = (v: unknown): v is Persistence => v === 'session' || v === 'none';
const isPortAddresses = (v: unknown): v is PortAddresses => isPlainObject(v) && exactKeys(v, ['stellar', 'evm']) && isAddressFor('stellar', v.stellar) && isAddressFor('evm', v.evm);
const isPolicyId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const isSig65 = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-fA-F]{130}$/u.test(v);
const isSignedBy = (v: unknown, key: string): boolean => isPlainObject(v) && exactKeys(v, [key, 'signerAddress']) && isAddressFor('stellar', v.signerAddress);

function isStatusResult(v: unknown, extra: readonly string[] = []): v is StatusResult {
  if (!isPlainObject(v) || !exactKeys(v, ['status', 'persistence'], ['addresses', 'expiresAtMs', 'supportId', ...extra])) return false;
  if (!isPersistence(v.persistence)) return false;
  if (v.status === 'logged_out') return v.addresses === undefined && v.expiresAtMs === undefined && v.supportId === undefined;
  return v.status === 'logged_in' && isPortAddresses(v.addresses) && isMs(v.expiresAtMs) && (v.supportId === undefined || isSupportId(v.supportId));
}


const RESULTS: { [M in PortMethod]: (r: unknown) => boolean } = {
  hana_status: (r) => isStatusResult(r),
  hana_login: (r) =>
    isPlainObject(r) &&
    exactKeys(r, ['addresses', 'expiresAtMs', 'persistence'], ['warning', 'timings', 'supportId']) &&
    isPortAddresses(r.addresses) &&
    isMs(r.expiresAtMs) &&
    isPersistence(r.persistence) &&
    (r.warning === undefined || r.warning === 'storage_unavailable') &&
    (r.timings === undefined || isTimings(r.timings)) &&
    (r.supportId === undefined || isSupportId(r.supportId)),
  hana_cancelLogin: (r) => r === null,
  hana_logout: (r) => r === null,
  hana_export: (r) => r === null,
  hana_revokeOtherDevices: (r) => isPlainObject(r) && exactKeys(r, ['revoked']) && isInt(r.revoked, 0, 1_000_000),
  stellar_getAddress: (r) => isPlainObject(r) && exactKeys(r, ['address']) && isAddressFor('stellar', r.address),
  stellar_signTransaction: (r) => isSignedBy(r, 'signedTxXdr') && isBase64((r as Obj).signedTxXdr, APPROVAL_MESSAGE_MAX_BYTES),
  stellar_signAuthEntry: (r) => isSignedBy(r, 'signedAuthEntry') && isBase64((r as Obj).signedAuthEntry, 88) && base64Decode((r as Obj).signedAuthEntry as string).length === 64,
  stellar_signMessage: (r) => isSignedBy(r, 'signedMessage') && isBase64((r as Obj).signedMessage, 88) && base64Decode((r as Obj).signedMessage as string).length === 64,
  eth_accounts: (r) => Array.isArray(r) && r.length <= 1 && r.every((a) => isAddressFor('evm', a)),
  eth_signTransaction: (r) => isHex(r) && r.length > 2,
  personal_sign: isSig65,
  eth_signTypedData_v4: isSig65,
  hana_signRaw: (r) => isPlainObject(r) && exactKeys(r, ['signature']) && (isBytes(r.signature, 64, 64) || (isBytes(r.signature, 65, 65) && (r.signature[64] === 27 || r.signature[64] === 28))),
  hana_requestAutoApprove: (r) =>
    isPlainObject(r) &&
    exactKeys(r, ['granted'], ['policyId', 'expiresAtMs']) &&
    typeof r.granted === 'boolean' &&
    (r.policyId === undefined || isPolicyId(r.policyId)) &&
    (r.expiresAtMs === undefined || isMs(r.expiresAtMs)),
  hana_autoApproveStatus: (r) =>
    r === null ||
    (isPlainObject(r) &&
      exactKeys(r, ['policyId', 'label', 'expiresAtMs', 'used']) &&
      isPolicyId(r.policyId) &&
      isStr(r.label, 1, 80) &&
      isMs(r.expiresAtMs) &&
      isPlainObject(r.used) &&
      exactKeys(r.used, ['count', 'native']) &&
      isInt(r.used.count, 0, 1_000_000) &&
      typeof r.used.native === 'string' &&
      /^[0-9]{1,78}$/u.test(r.used.native)),
  hana_revokeAutoApprove: (r) => r === null,
  hana_identityToken: isIdentityTokenState,
  hana_account: (r) => isPlainObject(r) && exactKeys(r, ['methods']) && Array.isArray(r.methods) && r.methods.length >= 1 && r.methods.length <= 4 && r.methods.every(isAccountMethod),
  hana_linkAccount: (r) => isLinkChange(r) && r.status !== 'removed',
  hana_requestEmailSharing: (r) => isPlainObject(r) && exactKeys(r, ['state']) && (r.state === 'granted' || r.state === 'declined' || r.state === 'dismissed'),
};

export type PortReply<M extends PortMethod = PortMethod> = { v: 1; id: string; result: PortResultMap[M] } | { v: 1; id: string; error: ProtocolError };

function isProtocolError(v: unknown): v is ProtocolError {
  return isPlainObject(v) && exactKeys(v, ['code', 'message'], ['data']) && isHanaErrorCode(v.code) && isStr(v.message, 0, 1024);
}

/** The mainnet demo's rules as the vault states them (core mainnet-demo.ts `mainnetDemoState`). */
export interface MainnetDemoState {
  /** The EVM mainnets the app may sign for: a subset of MAINNET_DEMO_EVM_CHAINS (Base). */
  evmChains: number[];
  /** Stellar's public network passphrase: the one Stellar mainnet the demo signs for. */
  stellarNetworkPassphrase: string;
  /** The per-transaction cap, fee included, USD micros in decimal ("9990000" = $9.99). */
  txCapUsdMicros: string;
  /** When Hana's fixed price table was reviewed (YYYY-MM-DD), and until when it may be used (ms). */
  pricesReviewedAt: string;
  pricesValidUntilMs: number;
}

function isMainnetDemoState(d: unknown): d is MainnetDemoState {
  if (!isPlainObject(d) || !exactKeys(d, ['evmChains', 'stellarNetworkPassphrase', 'txCapUsdMicros', 'pricesReviewedAt', 'pricesValidUntilMs'])) return false;
  const chains = d.evmChains;
  return (
    Array.isArray(chains) &&
    chains.length <= MAINNET_DEMO_EVM_CHAINS.length &&
    new Set(chains).size === chains.length &&
    chains.every((c) => typeof c === 'number' && MAINNET_DEMO_EVM_CHAINS.includes(c)) &&
    d.stellarNetworkPassphrase === MAINNET_DEMO_STELLAR_PASSPHRASE &&
    typeof d.txCapUsdMicros === 'string' &&
    /^\d{1,12}$/u.test(d.txCapUsdMicros) &&
    typeof d.pricesReviewedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(d.pricesReviewedAt) &&
    isMs(d.pricesValidUntilMs)
  );
}

/** Validates a reply (SDK side) to a request it sent with `method`, or null. */
export function parsePortReply<M extends PortMethod>(data: unknown, method: M): PortReply<M> | null {
  const cap = isSignMethod(method) ? APPROVAL_MESSAGE_MAX_BYTES : MESSAGE_MAX_BYTES;
  if (!isPlainObject(data) || messageSize(data, cap) === Number.POSITIVE_INFINITY) return null;
  if (data.v !== PROTOCOL_VERSION || !isStr(data.id, 1, 64)) return null;
  if (exactKeys(data, ['v', 'id', 'error'])) return isProtocolError(data.error) ? { v: 1, id: data.id, error: data.error } : null;
  if (!exactKeys(data, ['v', 'id', 'result']) || !RESULTS[method](data.result)) return null;
  return { v: 1, id: data.id, result: data.result as PortResultMap[M] };
}

/**
 * `key_pending`: the token is signed with a Google key that isn't active on chain yet (the API's `503
 * issuer_key_pending`): the vault waits the API's `retryAfterS` (at most 30 s) and tries once more, then reports
 * `chain` again. An SDK that predates it drops the event (the stage list is validated).
 */
export const LOGIN_STAGES = ['popup_connected', 'google', 'email_code', 'token', 'linking', 'chain', 'key_pending', 'done'] as const;

export interface PortEventMap {
  /**
   * The vault took the hello (every check passed) and is starting: opening its storage and unlocking a stored session,
   * which can wait on the network. `ready` follows. The SDK then gives `ready` longer, and tells "the vault never
   * answered" from "the vault was slow to start". An SDK that predates it drops it.
   */
  connected: null;
  /** `timings`: pk_test_ apps only, the vault's boot and unlock stages (timings.ts, UNLOCK_TIMING_STAGES). */
  ready: StatusResult & { warning?: 'storage_unavailable'; timings?: Record<string, number> };
  /**
   * The mainnet demo: the vault of an app Hana staff switched to it says so, with its rules (sent by a dev
   * testnet build only, after the hello and whenever GET /v1/app changes it; null once off). The SDK's EVM provider
   * then lets exactly `evmChains` through its early test-networks check; the vault still decides every request. An SDK that
   * predates it drops it.
   */
  mainnetDemo: MainnetDemoState | null;
  /**
   * The prices the vault values requests with: sent before `mainnetDemo` when the demo turns on, and whenever they
   * change. A separate event so that an SDK that predates it keeps the `mainnetDemo` event it can read, and simply
   * drops this one.
   */
  mainnetDemoPrices: MainnetDemoPriceBook;
  accountsChanged: { addresses: PortAddresses | null };
  disconnect: { code: number };
  sessionExpired: null;
  loginProgress: { stage: (typeof LOGIN_STAGES)[number] };
  ui: { launcher: 'show' | 'hide'; label: string };
  /**
   * Whether the launcher the next `ui {launcher: 'show'}` announces has a click action: true for a button that opens
   * a Hana window ("Review in Hana", "Sign in with Hana", an export), false for a short notice that does nothing
   * when clicked ("Signed by Hana under …"). Sent just before that `ui` event. A separate event because `ui` takes
   * exactly its two fields: an SDK that predates this one keeps the `ui` event it can read, and simply drops this.
   */
  launcherKind: { clickable: boolean };
  /**
   * Whether the vault has an approval popup open (one its launcher opened, or one the partner page opened that it
   * adopted). The SDK then reuses it instead of opening another in the next click.
   */
  approvalWindow: { open: boolean };
  autoApproved: { kind: SignMethod; chain: 'stellar' | 'evm'; contract: string; function: string };
  /**
   * The session's persistence changed after it was reported: today only to 'none', when the share and record made
   * after a login could not be made, so the next page load needs a full login.
   */
  persistenceChanged: { persistence: Persistence };
  /**
   * The current identity token changed: minted in this tab or another tab of the session (the per-app channel), or
   * null once the session ended (logout, expiry, revocation, a newer login).
   */
  identityTokenChanged: IdentityTokenState;
  /**
   * A sign-in method of the logged-in wallet was added (pending or active), became active, or was removed (spec
   * "Notices"): partners show pending ones with a way to cancel.
   */
  linkChanged: LinkChange;
  /**
   * The user shared their email with the app or stopped sharing it, on this device (the sheet, the approval
   * popup's account line). The vault dropped its cached identity token: the next getIdentityToken() has the email or
   * not. Sent only to an SDK of EMAIL_SHARING_SDK_MIN or later.
   */
  emailSharingChanged: { state: 'granted' | 'declined' };
}

export type PortEventName = keyof PortEventMap;
export type PortEvent = { [E in PortEventName]: { v: 1; event: E; data: PortEventMap[E] } }[PortEventName];

const EVENTS: { [E in PortEventName]: (d: unknown) => boolean } = {
  connected: (d) => d === null,
  mainnetDemo: (d) => d === null || isMainnetDemoState(d),
  mainnetDemoPrices: (d) => parseMainnetDemoPrices(d, null) !== null,
  ready: (d) =>
    isPlainObject(d) && (d.warning === undefined || d.warning === 'storage_unavailable') && (d.timings === undefined || isTimings(d.timings)) && isStatusResult(d, ['warning', 'timings']),
  accountsChanged: (d) => isPlainObject(d) && exactKeys(d, ['addresses']) && (d.addresses === null || isPortAddresses(d.addresses)),
  disconnect: (d) => isPlainObject(d) && exactKeys(d, ['code']) && isInt(d.code, 0, 9999),
  sessionExpired: (d) => d === null,
  loginProgress: (d) => isPlainObject(d) && exactKeys(d, ['stage']) && (LOGIN_STAGES as readonly unknown[]).includes(d.stage),
  ui: (d) => isPlainObject(d) && exactKeys(d, ['launcher', 'label']) && (d.launcher === 'show' || d.launcher === 'hide') && isStr(d.label, 0, 80),
  launcherKind: (d) => isPlainObject(d) && exactKeys(d, ['clickable']) && typeof d.clickable === 'boolean',
  approvalWindow: (d) => isPlainObject(d) && exactKeys(d, ['open']) && typeof d.open === 'boolean',
  autoApproved: (d) =>
    isPlainObject(d) && exactKeys(d, ['kind', 'chain', 'contract', 'function']) && isSignMethod(d.kind) && isChain(d.chain) && isStr(d.contract, 1, 128) && isStr(d.function, 1, 128),
  persistenceChanged: (d) => isPlainObject(d) && exactKeys(d, ['persistence']) && isPersistence(d.persistence),
  identityTokenChanged: isIdentityTokenState,
  linkChanged: isLinkChange,
  emailSharingChanged: (d) => isPlainObject(d) && exactKeys(d, ['state']) && (d.state === 'granted' || d.state === 'declined'),
};

/** Validates a vault → SDK event, or null. */
export function parsePortEvent(data: unknown): PortEvent | null {
  if (!isPlainObject(data) || messageSize(data, MESSAGE_MAX_BYTES) === Number.POSITIVE_INFINITY) return null;
  if (!exactKeys(data, ['v', 'event'], ['data']) || data.v !== PROTOCOL_VERSION || typeof data.event !== 'string' || !Object.hasOwn(EVENTS, data.event)) return null;
  const event = data.event as PortEventName;
  const payload = Object.hasOwn(data, 'data') ? data.data : null;
  return EVENTS[event](payload) ? ({ v: 1, event, data: payload } as PortEvent) : null;
}

/** True if `data` is a port message from the vault that is an event (has `event`), so the SDK routes it there. */
export const isPortEventShape = (data: unknown): boolean => isPlainObject(data) && Object.hasOwn(data, 'event');

// ---- window messages ----

export type GoogleClientMode = 'own' | 'shared';

// Approval request kinds and contexts are approval.ts's (ApprovalKind, ApprovalContext): the digest binds the kind,
// and the popup's decoders and the auto-approve matcher switch on it. APPROVAL_KIND maps each sign method to its kind.

export interface WindowMessageMap {
  /** SDK → vault, with the MessageChannel port transferred. */
  'hana:hello': { sdk: string };
  /** Login popup (or export-mode child) → vault (or export window). */
  'hana:auth-hello': Record<string, never>;
  /** Vault (or export window) → login popup. Carries relayKey, the one session secret that crosses postMessage. */
  'hana:auth-params': {
    pk: string;
    appName: string;
    parentOrigin: string;
    scopeId: string;
    signer: string;
    clientId: string;
    mode: GoogleClientMode;
    sessionPublicKey: Uint8Array;
    expiresAtMs: number;
    salt: Uint8Array;
    keyIndex: number;
    maxUses: number;
    nonce: string;
    relayId: string;
    relayKey: Uint8Array;
    /**
     * Email login: the methods the popup offers, present only when email is among them (a
     * Google-only app's message is exactly the one older pages take); `method` skips the chooser; `emailHint` prefills the address.
     */
    methods?: LoginMethod[];
    method?: LoginMethod;
    emailHint?: string;
    /**
     * Linking: the follow-up channel's key (core links.ts `followSlot`), sent only in a login
     * that offers email (or a link task): after Google's answer the popup waits for the vault's follow-up notices
     * (google-match's screens, link banners) and answers them through the relay, end-to-end encrypted under relayKey.
     */
    followKey?: Uint8Array;
    /**
     * token_first: a login of an app without email login, in an env with an email issuer. The popup asks Google
     * for the email in the login's own request and relays the access token in follow-up slot 1, for the issuer's user
     * directory only: no google-match, no follow-up notices; the popup closes once the ID token is relayed.
     * Only with `followKey`, never with `methods` or `task`.
     */
    emailRecord?: true;
    /**
     * `hana.linkAccount({method})`: this popup signs in the new method with `prove` (its nonce or email commitment)
     * instead of a login; the session fields are unused. Then the vault asks (follow-up `prove`) for the account's.
     */
    task?: { kind: 'link'; provider: LoginMethod; prove: FollowProve };
    /**
     * The app's logo (logo.ts), shown beside its name; present only when the app has one on the files origin
     * the vault's build pins, so an app without a logo sends exactly the message older pages take.
     */
    logoUrl?: string;
    /**
     * An app whose `identity_email` is `at_login`: the popup doesn't close at the end of the sign-in; it goes to
     * `/share-email?from=login`, where the vault shows the email sharing sheet if this user hasn't answered it yet.
     */
    emailShare?: true;
  };
  /**
   * Hana Home page → its own sign-in child (`/login?mode=home`), in answer to the child's `hana:auth-hello`. The nonce
   * commits to the Home key, its end and salt (home.ts `homeNonce`), never to a session, so the token Google answers can
   * open nothing on chain. Carries relayKey, as `hana:auth-params` does. The child takes it only from its same-origin
   * opener on the Home page.
   */
  'hana:home-params': {
    signer: string;
    clientId: string;
    homePublicKey: Uint8Array;
    expiresAtMs: number;
    salt: Uint8Array;
    nonce: string;
    relayId: string;
    relayKey: Uint8Array;
  };
  /**
   * Hana Home page → its own sign-in child (`/login?mode=home`), for opening one app's wallet: a session of exactly one
   * use and key index 0 in `scopeId`, whose nonce (`sessionNonce`) the child recomputes from these fields. The child
   * asks Google to sign the user in again (`max_age=0`). Carries relayKey; taken only from the same-origin opener on
   * the Home page. It names no app and carries no partner string.
   */
  'hana:home-derive-params': {
    signer: string;
    clientId: string;
    scopeId: string;
    sessionPublicKey: Uint8Array;
    expiresAtMs: number;
    salt: Uint8Array;
    nonce: string;
    relayId: string;
    relayKey: Uint8Array;
  };
  /**
   * Login popup → vault: the popup is about to navigate to Google (`google`, from any Hana page, every time), it is
   * back from Google on Hana's callback with its opener (`back`), the code was sent (`email_code`, from
   * `/login/email`), or the popup relayed its answer and is closing itself (`relayed`). A signal only: it carries nothing, and the vault takes it only from the window its pending login answered.
   * In a login that offered email `google` and `email_code` are also the partner's `loginProgress`; `google` and
   * `back` and `relayed` tell the vault's watch on the popup's window a navigation or a self-close from a
   * user's close.
   */
  'hana:auth-progress': { stage: 'google' | 'email_code' | 'relayed' | 'back' };
  /**
   * Vault → login popup: the vault took the popup's `hana:auth-progress` of that stage (from the popup it
   * answered). A page that signals and then navigates or closes waits for it, up to the web package's
   * SIGNAL_ACK_WAIT_MS, so Chromium's null `event.source` on a message posted just before a navigation can't drop the
   * signal. Carries nothing but the stage; the popup takes it only from vaultOrigin and a window it signalled.
   */
  'hana:auth-progress-ack': { stage: 'google' | 'email_code' | 'relayed' | 'back' };
  'hana:approve-hello': Record<string, never>;
  'hana:approve-request': {
    id: string;
    appName: string;
    parentOrigin: string;
    kind: ApprovalKind;
    chain: 'stellar' | 'evm';
    address: string;
    bytes: Uint8Array;
    context: ApprovalContext;
    position: number;
    queued: number;
    /**
     * Present when the app has an auto-approve policy in force: its label, whether the user's consent to it is active
     * (the popup then offers "Stop auto-approving"), and why this request wasn't auto-approved (a matcher reason).
     */
    autoApprove?: AutoApproveNote;
    /** A pk_test_ app: the popup says that Hana signs only for test networks for it. */
    testApp?: true;
    /**
     * A pk_test_ app with Hana's mainnet demo on, as the vault last read it: the popup's test-app note then says what
     * the demo allows. Absent otherwise, so the message is exactly the older one.
     */
    mainnetDemo?: true;
    /**
     * The app's logo (logo.ts), shown beside its name; present only when the app has one on the files origin
     * the vault's build pins, so an app without a logo sends exactly the message older pages take.
     */
    logoUrl?: string;
    /**
     * The session's Support ID (`HANA-XXXX-XXXX`), shown on the account line; present only when the
     * session has one, so a session without it sends exactly the message older pages take.
     */
    supportId?: string;
    /**
     * The session's address is shared with this app: the account line offers "Stop sharing"
     * (`hana:email-revoke`). Present only then, so other requests send exactly the message older pages take.
     */
    emailShared?: true;
    /**
     * The mainnet demo's price book: present only on a demo request, so every other request sends the message
     * older pages take. The popup checks it itself with parseMainnetDemoPrices and shows the fixed table's value when
     * it refuses it; the vault has already decided the request with the same book.
     */
    demoPrices?: unknown;
  };
  'hana:approve-result': { id: string; approved: boolean; digest: Uint8Array };
  'hana:approve-bye': Record<string, never>;
  /**
   * Vault → approval popup: close now, without answering. Sent when the request a partner-opened popup was
   * opened for ended without an approval screen (auto-approved under the accepted policy, or refused), when the vault
   * already has a popup in use, and when the vault drops its popup (logout, a stale window).
   */
  'hana:approve-close': Record<string, never>;
  'hana:export-hello': Record<string, never>;
  'hana:export-context': {
    pk: string;
    appName: string;
    parentOrigin: string;
    scopeId: string;
    signer: string;
    keyIndex: number;
    chain: 'stellar' | 'evm';
    address: string;
    /**
     * The vault session's end (server-corrected ms): the export window erases the key and ends no later than this
     *. Optional so an older vault bundle's context still parses.
     */
    sessionExpiresAtMs?: number;
    /**
     * The app's logo (logo.ts), shown beside its name; present only when the app has one on the files origin
     * the vault's build pins, so an app without a logo sends exactly the message older pages take.
     */
    logoUrl?: string;
  };
  /**
   * Vault → export window: the session ended (logout, revoke, expiry, a newer login) or the vault's export job did;
   * the window erases the key and ends the export.
   */
  'hana:export-end': Record<string, never>;
  /** Vault → approval popup: the consent screen for the app's auto-approve policy. */
  'hana:consent-request': {
    id: string;
    appName: string;
    parentOrigin: string;
    /** The normalized policy; the popup validates it and recomputes policyId itself before display. */
    policy: Record<string, unknown>;
    policyId: string;
    /** When the consent would end: min(now + maxConsentMs, session expiry). */
    expiresAtMs: number;
    position: number;
    queued: number;
    /** A pk_test_ app (as in hana:approve-request). */
    testApp?: true;
    /** The mainnet demo is on for it (as in hana:approve-request). */
    mainnetDemo?: true;
    /**
     * The app's logo (logo.ts), shown beside its name; present only when the app has one on the files origin
     * the vault's build pins, so an app without a logo sends exactly the message older pages take.
     */
    logoUrl?: string;
  };
  /** Approval popup → vault: Allow (guarded like Approve) or Decline, with consentDigest of what it rendered. */
  'hana:consent-result': { id: string; allowed: boolean; digest: Uint8Array };
  /** Approval popup → vault: "Stop auto-approving". */
  'hana:auto-approve-stop': Record<string, never>;
  /**
   * The email sharing sheet (`/share-email`) → vault, from the login popup at the end of an `at_login` sign-in
   * or from the window `requestEmailSharing()` opened. The vault answers only a window it expects.
   */
  'hana:email-share-hello': Record<string, never>;
  /**
   * Vault → the sheet: what to ask. `state` is the session's for its address (`granted`: the sheet offers "Stop
   * sharing"). The address isn't here: the sheet reads it from the API (`POST /v1/identity/email-consent/preview`) with
   * `sealedEmail` and `proof`, a single-use session proof the vault made for that, so the vault never sees it.
   */
  'hana:email-share-request': {
    pk: string;
    appName: string;
    parentOrigin: string;
    /** The app signs users in with its own Google client: the sheet says Google may give it the address anyway. */
    ownGoogleClient: boolean;
    state: 'not_asked' | 'declined' | 'granted';
    sealedEmail: string;
    proof: { sessionPublicKey: Uint8Array; issuedAtMs: number; nonce: Uint8Array; signature: Uint8Array };
    logoUrl?: string;
  };
  /** Vault → the sheet: nothing to ask (already answered, sharing off, no address): the window closes. */
  'hana:email-share-close': Record<string, never>;
  /**
   * The sheet → vault: the user's answer. `granted` (Share email), `declined` (Not now), `revoke` (Stop sharing, on an
   * already shared address), `keep` (Done, on an already shared address).
   */
  'hana:email-share-answer': { answer: 'granted' | 'declined' | 'revoke' | 'keep' };
  /** Vault → the sheet: the answer was recorded (`state`) or couldn't be (`failed`); the sheet closes. */
  'hana:email-share-done': { state: 'granted' | 'declined' | 'failed' };
  /**
   * The approval popup's account line → vault: "Stop sharing" (the request carried `emailShared`). The
   * vault revokes every address of this app and account, then answers `hana:email-revoked`.
   */
  'hana:email-revoke': Record<string, never>;
  'hana:email-revoked': { ok: boolean };
}

/** hana:approve-request's note on the app's auto-approve policy. */
export interface AutoApproveNote {
  label: string;
  active: boolean;
  /** The matcher's reason (policy/match.ts AutoApproveReason) when an active consent didn't cover this request. */
  reason?: string;
}

export type WindowMessageType = keyof WindowMessageMap;
export type WindowMessage<T extends WindowMessageType = WindowMessageType> = { [K in T]: { v: 1; t: K } & WindowMessageMap[K] }[T];

/** 128-bit random request id, 32 lowercase hex characters (approval requests). */
export const newRequestId = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)));
const isRequestId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/u.test(v);

function isApprovalContext(v: unknown): v is ApprovalContext {
  if (!isPlainObject(v)) return false;
  if (Object.keys(v).length === 0) return true;
  if (exactKeys(v, ['networkPassphrase'])) return isStr(v.networkPassphrase, 1, PASSPHRASE_MAX);
  if (exactKeys(v, ['chainId'])) return isInt(v.chainId, 1, Number.MAX_SAFE_INTEGER);
  return false;
}

/** The approval kind of each sign method (the `kind` of hana:approve-request and of the approval digest). */
export const APPROVAL_KIND: Readonly<Record<SignMethod, ApprovalKind>> = {
  stellar_signTransaction: 'stellar_tx',
  stellar_signAuthEntry: 'stellar_auth_entry',
  stellar_signMessage: 'stellar_message',
  eth_signTransaction: 'evm_tx',
  personal_sign: 'personal_sign',
  eth_signTypedData_v4: 'eip712',
  hana_signRaw: 'raw',
};
const isApprovalKind = (v: unknown): v is ApprovalKind => (APPROVAL_KINDS as readonly unknown[]).includes(v);

/** approval.ts's check that kind, chain, context and bytes fit together, as a predicate. */
function isApprovalSubject(m: Obj): boolean {
  try {
    validateApprovalSubject(m as never);
    return true;
  } catch {
    return false;
  }
}

const FIELDS: { [K in WindowMessageType]: (m: Obj) => boolean } = {
  'hana:hello': (m) => exactKeys(m, ['v', 't', 'sdk']) && typeof m.sdk === 'string' && /^[0-9A-Za-z.+-]{1,32}$/u.test(m.sdk),
  'hana:auth-hello': (m) => exactKeys(m, ['v', 't']),
  'hana:auth-params': (m) =>
    exactKeys(m, ['v', 't', 'pk', 'appName', 'parentOrigin', 'scopeId', 'signer', 'clientId', 'mode', 'sessionPublicKey', 'expiresAtMs', 'salt', 'keyIndex', 'maxUses', 'nonce', 'relayId', 'relayKey'], ['methods', 'method', 'emailHint', 'followKey', 'task', 'emailRecord', 'logoUrl', 'emailShare']) &&
    (m.logoUrl === undefined || isLogoUrl(m.logoUrl)) &&
    (m.emailShare === undefined || (m.emailShare === true && m.task === undefined)) &&
    (m.followKey === undefined || (isBytes(m.followKey, 32, 32) && (Array.isArray(m.methods) || m.task !== undefined || m.emailRecord === true))) &&
    (m.emailRecord === undefined || (m.emailRecord === true && m.followKey !== undefined && m.methods === undefined && m.task === undefined)) &&
    (m.task === undefined ||
      (m.followKey !== undefined &&
        isPlainObject(m.task) &&
        exactKeys(m.task, ['kind', 'provider', 'prove']) &&
        m.task.kind === 'link' &&
        isLoginMethod(m.task.provider) &&
        isFollowProve(m.task.prove) &&
        m.task.prove.method === m.task.provider &&
        m.method === undefined &&
        m.emailHint === undefined)) &&
    (m.methods === undefined || (isOfferedMethods(m.methods) && m.methods.includes('email'))) &&
    (m.method === undefined || (Array.isArray(m.methods) && m.methods.includes(m.method as LoginMethod))) &&
    (m.emailHint === undefined || (isEmailHint(m.emailHint) && m.method !== 'google' && Array.isArray(m.methods))) &&
    isPublishableKey(m.pk) &&
    isAppName(m.appName) &&
    isOrigin(m.parentOrigin) &&
    isScopeId(m.scopeId) &&
    isNearAccountId(m.signer) &&
    isClientId(m.clientId) &&
    (m.mode === 'own' || m.mode === 'shared') &&
    isBytes(m.sessionPublicKey, 32, 32) &&
    isMs(m.expiresAtMs) &&
    isBytes(m.salt, SALT_MIN_BYTES, SALT_MAX_BYTES) &&
    isInt(m.keyIndex, 0, KEY_INDEX_LIMIT) &&
    isInt(m.maxUses, 1, MAX_USES_LIMIT) &&
    isNonce(m.nonce) &&
    isRelayId(m.relayId) &&
    isBytes(m.relayKey, 32, 32),
  'hana:home-params': (m) =>
    exactKeys(m, ['v', 't', 'signer', 'clientId', 'homePublicKey', 'expiresAtMs', 'salt', 'nonce', 'relayId', 'relayKey']) &&
    isNearAccountId(m.signer) &&
    isClientId(m.clientId) &&
    isBytes(m.homePublicKey, 32, 32) &&
    isMs(m.expiresAtMs) &&
    isBytes(m.salt, 32, 32) &&
    isNonce(m.nonce) &&
    isRelayId(m.relayId) &&
    isBytes(m.relayKey, 32, 32),
  'hana:home-derive-params': (m) =>
    exactKeys(m, ['v', 't', 'signer', 'clientId', 'scopeId', 'sessionPublicKey', 'expiresAtMs', 'salt', 'nonce', 'relayId', 'relayKey']) &&
    isNearAccountId(m.signer) &&
    isClientId(m.clientId) &&
    isScopeId(m.scopeId) &&
    isBytes(m.sessionPublicKey, 32, 32) &&
    isMs(m.expiresAtMs) &&
    isBytes(m.salt, SALT_MIN_BYTES, SALT_MAX_BYTES) &&
    isNonce(m.nonce) &&
    isRelayId(m.relayId) &&
    isBytes(m.relayKey, 32, 32),
  'hana:auth-progress': (m) => exactKeys(m, ['v', 't', 'stage']) && (m.stage === 'email_code' || m.stage === 'google' || m.stage === 'relayed' || m.stage === 'back'),
  'hana:auth-progress-ack': (m) => exactKeys(m, ['v', 't', 'stage']) && (m.stage === 'email_code' || m.stage === 'google' || m.stage === 'relayed' || m.stage === 'back'),
  'hana:approve-hello': (m) => exactKeys(m, ['v', 't']),
  'hana:approve-request': (m) => {
    if (!exactKeys(m, ['v', 't', 'id', 'appName', 'parentOrigin', 'kind', 'chain', 'address', 'bytes', 'context', 'position', 'queued'], ['autoApprove', 'testApp', 'mainnetDemo', 'logoUrl', 'supportId', 'emailShared', 'demoPrices'])) return false;
    if (m.mainnetDemo !== undefined && (m.mainnetDemo !== true || m.testApp !== true)) return false;
    if (m.demoPrices !== undefined && !isPlainObject(m.demoPrices)) return false;
    if (m.logoUrl !== undefined && !isLogoUrl(m.logoUrl)) return false;
    if (m.emailShared !== undefined && m.emailShared !== true) return false;
    if (m.supportId !== undefined && !isSupportId(m.supportId)) return false;
    if (m.autoApprove !== undefined && !isAutoApproveNote(m.autoApprove)) return false;
    if (m.testApp !== undefined && m.testApp !== true) return false;
    if (!isRequestId(m.id) || !isAppName(m.appName) || !isOrigin(m.parentOrigin) || !isApprovalKind(m.kind) || !isChain(m.chain)) return false;
    const expected = approvalKindChain(m.kind);
    if (expected !== null && expected !== m.chain) return false;
    return (
      isAddressFor(m.chain, m.address) &&
      isBytes(m.bytes, 0, SIGN_MESSAGE_MAX_BYTES) &&
      isApprovalContext(m.context) &&
      isApprovalSubject(m) &&
      isInt(m.queued, 1, 1000) &&
      isInt(m.position, 1, m.queued as number)
    );
  },
  'hana:approve-result': (m) => exactKeys(m, ['v', 't', 'id', 'approved', 'digest']) && isRequestId(m.id) && typeof m.approved === 'boolean' && isBytes(m.digest, 32, 32),
  'hana:approve-bye': (m) => exactKeys(m, ['v', 't']),
  'hana:approve-close': (m) => exactKeys(m, ['v', 't']),
  'hana:export-hello': (m) => exactKeys(m, ['v', 't']),
  'hana:export-end': (m) => exactKeys(m, ['v', 't']),
  'hana:export-context': (m) =>
    exactKeys(m, ['v', 't', 'pk', 'appName', 'parentOrigin', 'scopeId', 'signer', 'keyIndex', 'chain', 'address'], ['sessionExpiresAtMs', 'logoUrl']) &&
    (m.sessionExpiresAtMs === undefined || isMs(m.sessionExpiresAtMs)) &&
    (m.logoUrl === undefined || isLogoUrl(m.logoUrl)) &&
    isPublishableKey(m.pk) &&
    isAppName(m.appName) &&
    isOrigin(m.parentOrigin) &&
    isScopeId(m.scopeId) &&
    isNearAccountId(m.signer) &&
    isInt(m.keyIndex, 0, KEY_INDEX_LIMIT) &&
    isChain(m.chain) &&
    isAddressFor(m.chain, m.address),
  'hana:consent-request': (m) =>
    exactKeys(m, ['v', 't', 'id', 'appName', 'parentOrigin', 'policy', 'policyId', 'expiresAtMs', 'position', 'queued'], ['testApp', 'mainnetDemo', 'logoUrl']) &&
    (m.testApp === undefined || m.testApp === true) &&
    (m.mainnetDemo === undefined || (m.mainnetDemo === true && m.testApp === true)) &&
    (m.logoUrl === undefined || isLogoUrl(m.logoUrl)) &&
    isRequestId(m.id) &&
    isAppName(m.appName) &&
    isOrigin(m.parentOrigin) &&
    isPlainObject(m.policy) &&
    isPolicyId(m.policyId) &&
    isMs(m.expiresAtMs) &&
    isInt(m.queued, 1, 1000) &&
    isInt(m.position, 1, m.queued as number),
  'hana:consent-result': (m) => exactKeys(m, ['v', 't', 'id', 'allowed', 'digest']) && isRequestId(m.id) && typeof m.allowed === 'boolean' && isBytes(m.digest, 32, 32),
  'hana:auto-approve-stop': (m) => exactKeys(m, ['v', 't']),
  'hana:email-share-hello': (m) => exactKeys(m, ['v', 't']),
  'hana:email-share-request': (m) =>
    exactKeys(m, ['v', 't', 'pk', 'appName', 'parentOrigin', 'ownGoogleClient', 'state', 'sealedEmail', 'proof'], ['logoUrl']) &&
    isPublishableKey(m.pk) &&
    isAppName(m.appName) &&
    isOrigin(m.parentOrigin) &&
    typeof m.ownGoogleClient === 'boolean' &&
    (m.state === 'not_asked' || m.state === 'declined' || m.state === 'granted') &&
    isStr(m.sealedEmail, 5, 1024) &&
    (m.sealedEmail as string).startsWith('se1.') &&
    isPlainObject(m.proof) &&
    exactKeys(m.proof, ['sessionPublicKey', 'issuedAtMs', 'nonce', 'signature']) &&
    isBytes(m.proof.sessionPublicKey, 32, 32) &&
    isMs(m.proof.issuedAtMs) &&
    isBytes(m.proof.nonce, 16, 16) &&
    isBytes(m.proof.signature, 64, 64) &&
    (m.logoUrl === undefined || isLogoUrl(m.logoUrl)),
  'hana:email-share-close': (m) => exactKeys(m, ['v', 't']),
  'hana:email-share-answer': (m) => exactKeys(m, ['v', 't', 'answer']) && (m.answer === 'granted' || m.answer === 'declined' || m.answer === 'revoke' || m.answer === 'keep'),
  'hana:email-share-done': (m) => exactKeys(m, ['v', 't', 'state']) && (m.state === 'granted' || m.state === 'declined' || m.state === 'failed'),
  'hana:email-revoke': (m) => exactKeys(m, ['v', 't']),
  'hana:email-revoked': (m) => exactKeys(m, ['v', 't', 'ok']) && typeof m.ok === 'boolean',
};

function isAutoApproveNote(v: unknown): v is AutoApproveNote {
  return (
    isPlainObject(v) &&
    exactKeys(v, ['label', 'active'], ['reason']) &&
    isStr(v.label, 1, 80) &&
    typeof v.active === 'boolean' &&
    (v.reason === undefined || (typeof v.reason === 'string' && /^[a-z_]{1,40}$/u.test(v.reason)))
  );
}

/**
 * Validates a window message whose `t` is in `allowed` (each receiver passes only the types it expects at that point),
 * or null. The origin and source checks are the receiver's (event.origin, event.source); this checks only the data.
 */
export function parseWindowMessage<T extends WindowMessageType>(data: unknown, allowed: readonly T[]): WindowMessage<T> | null {
  if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || typeof data.t !== 'string' || !(allowed as readonly string[]).includes(data.t) || !Object.hasOwn(FIELDS, data.t)) return null;
  const cap = data.t === 'hana:approve-request' || data.t === 'hana:consent-request' ? APPROVAL_MESSAGE_MAX_BYTES : MESSAGE_MAX_BYTES;
  if (messageSize(data, cap) === Number.POSITIVE_INFINITY) return null;
  return FIELDS[data.t as WindowMessageType](data) ? (data as WindowMessage<T>) : null;
}

// ---- approval request content ----

/** The approval `chain` of a sign request. */
export function approvalChain(request: Extract<PortRequest, { method: SignMethod }>): 'stellar' | 'evm' {
  return request.method === 'hana_signRaw' ? request.params.chain : (approvalKindChain(APPROVAL_KIND[request.method]) as 'stellar' | 'evm');
}

/**
 * The `bytes` and `context` of the approval request for a sign request: exactly what gets signed (or hashed into what
 * gets signed), which the popup decodes itself.
 * - stellar_signTransaction: the envelope XDR bytes, context {networkPassphrase}
 * - stellar_signAuthEntry: the HashIdPreimage XDR bytes, context {networkPassphrase}
 * - stellar_signMessage: the message bytes (UTF-8 for a string), no context
 * - eth_signTransaction: the EIP-1559 (0x02 ‖ rlp) or EIP-155 legacy signing payload, context {chainId}
 * - personal_sign: the message bytes, no context
 * - eth_signTypedData_v4: the UTF-8 of the typed-data JSON string, no context (the domain carries the chain)
 * - hana_signRaw: the raw bytes or the 32-byte digest, no context
 */
export function approvalContent(request: Extract<PortRequest, { method: SignMethod }>): { bytes: Uint8Array; context: ApprovalContext } {
  switch (request.method) {
    case 'stellar_signTransaction':
      return { bytes: base64Decode(request.params.xdr), context: { networkPassphrase: request.params.networkPassphrase } };
    case 'stellar_signAuthEntry':
      return { bytes: base64Decode(request.params.preimageXdr), context: { networkPassphrase: request.params.networkPassphrase } };
    case 'stellar_signMessage': {
      const m = request.params.message;
      return { bytes: typeof m === 'string' ? utf8(m) : Uint8Array.from(m), context: {} };
    }
    case 'eth_signTransaction': {
      // parseEvmTxRequest bounds chainId to a safe integer, so the port refuses a larger one up front.
      const tx = parseEvmTxRequest(request.params.tx);
      return { bytes: evmTxSigningPayload(tx), context: { chainId: Number(tx.chainId) } };
    }
    case 'personal_sign':
      return { bytes: from0xHex(request.params[0]), context: {} };
    case 'eth_signTypedData_v4':
      return { bytes: utf8(request.params[1]), context: {} };
    case 'hana_signRaw':
      return { bytes: Uint8Array.from(request.params.chain === 'stellar' ? request.params.bytes : request.params.digest), context: {} };
  }
}

// ---- BroadcastChannel `hana-vault:<appId>` (outcomes only, never key material) ----

/**
 * - `counter`: a tab advanced this share's counter (unlock, touch).
 * - `revoked`: this share is dead (the API said 410, or a newer login on this device replaced it); only the tabs
 *   holding that share end their session.
 * - `logout`: the user logged out of this app on this device; every tab of the app ends its session.
 * - `identity`: an identity token minted for a session; the tabs of that session share it (no key material: the token
 *   is what the partner page gets anyway).
 */
export type VaultBroadcast =
  | { v: 1; t: 'counter'; shareId: Uint8Array; counter: number }
  | { v: 1; t: 'logout' }
  | { v: 1; t: 'revoked'; shareId: Uint8Array }
  /** A tab minted an identity token for the session of `sessionPk`: the tabs of that session cache it too. */
  | { v: 1; t: 'identity'; sessionPk: Uint8Array; identityToken: string; iatMs: number; expiresAtMs: number };

/** Validates a per-app BroadcastChannel message, or null. */
export function parseVaultBroadcast(data: unknown): VaultBroadcast | null {
  if (!isPlainObject(data) || data.v !== PROTOCOL_VERSION || messageSize(data, MESSAGE_MAX_BYTES) === Number.POSITIVE_INFINITY) return null;
  if (data.t === 'counter') {
    return exactKeys(data, ['v', 't', 'shareId', 'counter']) && isBytes(data.shareId, SHARE_ID_BYTES, SHARE_ID_BYTES) && isMs(data.counter) ? (data as VaultBroadcast) : null;
  }
  if (data.t === 'revoked') return exactKeys(data, ['v', 't', 'shareId']) && isBytes(data.shareId, SHARE_ID_BYTES, SHARE_ID_BYTES) ? (data as VaultBroadcast) : null;
  if (data.t === 'logout') return exactKeys(data, ['v', 't']) ? (data as VaultBroadcast) : null;
  if (data.t === 'identity') {
    return exactKeys(data, ['v', 't', 'sessionPk', 'identityToken', 'iatMs', 'expiresAtMs']) &&
      isBytes(data.sessionPk, 32, 32) &&
      isIdentityJwt(data.identityToken) &&
      isMs(data.iatMs) &&
      isMs(data.expiresAtMs) &&
      (data.iatMs as number) < (data.expiresAtMs as number)
      ? (data as VaultBroadcast)
      : null;
  }
  return null;
}
