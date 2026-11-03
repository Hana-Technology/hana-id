// Hana ID API request and response types (apps/api; docs/batch-b-spec.md "API changes"), with the response guards a
// client must run before trusting a body. Moved from apps/smoke/src/api.ts (the smoke HTTP client stays there).
// Request bodies are camelCase JSON with bytes as number arrays; errors are `{error, code, ...details}` plus
// `requestId`.
import { isDisplaySafeLine } from './display-safe.ts';

export type GoogleMode = 'own' | 'shared';

/** `GET /v1/app`. `name`, `serverTimeMs`, `autoApprovePolicy` and `rawSign` arrive with batch B; older APIs omit them. */
export interface AppConfig {
  scopeId: string;
  signer: string;
  google: { clientId: string; mode: GoogleMode };
  name?: string;
  serverTimeMs?: number;
  /**
   * The auto-approve policy JSON in force now (as the vault page inlines it, shape-checked only), or null. The vault
   * re-reads it while it stays open, so removing a policy stops auto-approval without a reload.
   */
  autoApprovePolicy?: Record<string, unknown> | null;
  /**
   * The app's raw-signing setting in force now. The vault re-reads it before every raw request (within the same 10 s as
   * the policy), so setting it to 'off' takes effect in open tabs; a vault treats a missing value as 'off'.
   */
  rawSign?: 'off' | 'approval';
  /**
   * Email login (D231): the sign-in methods the app offers and its scope can serve, in the order google, email. Older
   * APIs omit it (Google only). An app with email but no Google (`google: null`) is refused by isAppConfig until the
   * vault supports it (D247).
   */
  loginMethods?: ('google' | 'email')[];
  /** Present when `loginMethods` has email: the scope's email client, `email:<scopeId>`. */
  email?: { aud: string };
  requestId: string;
}

/** Contract Session as create_session and get_session return it. */
export interface SessionView {
  path: string;
  scope_id: string;
  expires_at_ms: number;
  max_uses: number;
  used: number;
}

export interface CkdResult {
  big_y: string;
  big_c: string;
}

export interface Relayed<T> {
  result: T;
  nearTx: string | null;
  requestId: string | null;
}

/** `POST /v1/sessions`. */
export interface CreateSessionBody {
  jwt: string;
  sessionPublicKey: number[];
  expiresAtMs: number;
  salt: number[];
  keyIndex: number;
  maxUses: number;
  /** The session key's proof of possession (D137): `signCreate`, counter 0. Required by the API and by contract v3. */
  signature: number[];
}

/** `POST /v1/derive`. */
export interface DeriveBody {
  sessionPublicKey: number[];
  counter: number;
  signature: number[];
  pk1: string;
  pk2: string;
}

/** `POST /v1/sessions/revoke`. */
export interface RevokeBody {
  sessionPublicKey: number[];
  counter: number;
  signature: number[];
}

/** `POST /v1/login` (create_session_and_derive): CreateSessionBody plus the counter-1 derive signature and app key. */
export interface LoginBody extends CreateSessionBody {
  signature: number[];
  pk1: string;
  pk2: string;
  /**
   * An automatic link (D133, build plan batch 8b): the `auto_link` email token, and its mode. `signature` is then over
   * the linked CKD payload (core links.ts `linkedCkdPayload`).
   */
  linkJwt?: string;
  linkImmediate?: boolean;
}

/** `POST /v1/link` (link_identity). */
export interface LinkBody {
  accountJwt: string;
  newJwt: string;
  epoch: number;
  salt: number[];
}

/** `POST /v1/link/cancel`, `/v1/link/unlink` (cancel_link, unlink_identity). `memberKey`: hex identity key. */
export interface LinkChangeBody {
  jwt: string;
  memberKey: string;
  epoch: number;
  salt: number[];
}

/** `POST /v1/login` 200. `session` is informational only: the vault re-syncs from NEAR, never from this. */
export interface LoginResponse {
  result: CkdResult;
  session: { scope_id: string; expires_at_ms: number; max_uses: number; used: 1 };
  nearTx: string | null;
  requestId: string | null;
  /** pk_test_ apps only: the API's own total and phases (docs/api.md "Timings"); check with isServerTimings. */
  timings?: unknown;
}

/** `POST /v1/login-relay/:relayId` body, and `GET` 200 (plus serverTimeMs). base64url. */
export interface RelayWriteBody {
  iv: string;
  ct: string;
}

export interface RelayReadResponse extends RelayWriteBody {
  serverTimeMs: number;
  /** How long the value sat in the slot before this read answered (API clock, ms). Newer APIs only. */
  heldMs?: number;
}

/** `POST /v1/vault/shares` (the create-share vault message, signed by the session key). */
export interface CreateShareBody {
  sessionPublicKey: number[];
  signature: number[];
}

export interface CreateShareResponse {
  shareId: number[];
  ks: number[];
  absExpiresAtMs: number;
  idleUntilMs: number;
  requestId?: string;
  /** pk_test_ apps only: the API's own total and phases (docs/api.md "Timings"); check with isServerTimings. */
  timings?: unknown;
}

/** `POST /v1/vault/unlock`, `/touch`, `/revoke`, `/revoke-all`. */
export interface ShareActionBody {
  shareId: number[];
  counter: number;
  signature: number[];
}

export interface UnlockResponse {
  ks: number[];
  counter: number;
  idleUntilMs: number;
  absExpiresAtMs: number;
  requestId?: string;
  /** pk_test_ apps only: the API's own total and phases (docs/api.md "Timings"); check with isServerTimings. */
  timings?: unknown;
}

export interface TouchResponse {
  counter: number;
  idleUntilMs: number;
  requestId?: string;
}

export interface RevokeShareResponse {
  revoked: true;
  requestId?: string;
}

export interface RevokeAllResponse {
  revoked: number;
  requestId?: string;
}

/** Error codes the batch B endpoints add (docs/batch-b-spec.md "Vault endpoints", "/v1/login", "Relay"). */
export type VaultApiErrorCode =
  | 'persistence_off'
  | 'invalid_signature'
  | 'unknown_session'
  | 'scope_mismatch'
  | 'session_not_spent'
  | 'origin_not_allowed'
  | 'share_exists'
  | 'near_unavailable'
  | 'unknown_share'
  | 'bad_counter'
  | 'share_expired'
  | 'share_revoked'
  | 'share_not_fresh'
  | 'scope_conflict'
  | 'token_has_pii'
  | 'session_exists'
  | 'contract_rejected'
  | 'ckd_failed'
  | 'near_error'
  | 'timeout'
  | 'invalid_app_key'
  | 'bad_relay_id'
  | 'relay_used'
  | 'relay_forbidden'
  | 'relay_gone';

/** An API error: HTTP status, the API's `code` and message, plus the body's other fields (`expected`, `claim`, …). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nearTx: string | null,
    readonly requestId: string | null,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = 'ApiError';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isByteArray = (v: unknown, len: number): v is number[] => Array.isArray(v) && v.length === len && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);

/**
 * Reads an API response: the JSON object for a 2xx, else throws ApiError (non-JSON bodies, e.g. a proxy error page,
 * become `non_json_response` with a short excerpt).
 */
export async function parseApiResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const headerId = res.headers.get('x-request-id');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, 'non_json_response', text.slice(0, 200) || res.statusText, null, headerId);
  }
  if (!isObj(body)) throw new ApiError(res.status, 'bad_response', 'Response is not a JSON object', null, headerId);
  if (!res.ok) {
    const { error, code, nearTx, requestId, ...details } = body;
    throw new ApiError(res.status, str(code) ?? 'error', str(error) ?? res.statusText, str(nearTx), str(requestId) ?? headerId, details);
  }
  return body;
}

export function isAppConfig(v: unknown): v is AppConfig {
  return (
    isObj(v) &&
    typeof v.scopeId === 'string' &&
    typeof v.signer === 'string' &&
    isObj(v.google) &&
    typeof v.google.clientId === 'string' &&
    (v.google.mode === 'own' || v.google.mode === 'shared') &&
    // A name with a control, bidi or invisible character is refused (sweep AUTH-2): the export page shows it.
    (v.name === undefined || (typeof v.name === 'string' && isDisplaySafeLine(v.name))) &&
    (v.serverTimeMs === undefined || isMs(v.serverTimeMs)) &&
    (v.autoApprovePolicy === undefined || v.autoApprovePolicy === null || isObj(v.autoApprovePolicy)) &&
    (v.rawSign === undefined || v.rawSign === 'off' || v.rawSign === 'approval') &&
    (v.loginMethods === undefined || isLoginMethodList(v.loginMethods)) &&
    // `email` comes exactly with the email method, and names this scope's client.
    (Array.isArray(v.loginMethods) && v.loginMethods.includes('email')
      ? isObj(v.email) && v.email.aud === `email:${v.scopeId}`
      : v.email === undefined)
  );
}

/** `loginMethods`: distinct, known, in the order google, email, and Google among them (isAppConfig needs `google`). */
const isLoginMethodList = (v: unknown): v is ('google' | 'email')[] =>
  Array.isArray(v) && (JSON.stringify(v) === '["google"]' || JSON.stringify(v) === '["google","email"]');

export function isSessionView(v: unknown): v is SessionView {
  return (
    isObj(v) &&
    typeof v.path === 'string' &&
    typeof v.scope_id === 'string' &&
    typeof v.expires_at_ms === 'number' &&
    typeof v.max_uses === 'number' &&
    typeof v.used === 'number'
  );
}

export const isCkdResult = (v: unknown): v is CkdResult => isObj(v) && typeof v.big_y === 'string' && typeof v.big_c === 'string';

export const isLoginResponse = (v: unknown): v is LoginResponse =>
  isObj(v) &&
  isCkdResult(v.result) &&
  isObj(v.session) &&
  typeof v.session.scope_id === 'string' &&
  isMs(v.session.expires_at_ms) &&
  isMs(v.session.max_uses) &&
  v.session.used === 1 &&
  (v.nearTx === null || typeof v.nearTx === 'string');

export const isRelayReadResponse = (v: unknown): v is RelayReadResponse => isObj(v) && typeof v.iv === 'string' && typeof v.ct === 'string' && isMs(v.serverTimeMs);

export const isCreateShareResponse = (v: unknown): v is CreateShareResponse =>
  isObj(v) && isByteArray(v.shareId, 16) && isByteArray(v.ks, 32) && isMs(v.absExpiresAtMs) && isMs(v.idleUntilMs);

export const isUnlockResponse = (v: unknown): v is UnlockResponse => isObj(v) && isByteArray(v.ks, 32) && isMs(v.counter) && isMs(v.idleUntilMs) && isMs(v.absExpiresAtMs);

export const isTouchResponse = (v: unknown): v is TouchResponse => isObj(v) && isMs(v.counter) && isMs(v.idleUntilMs);

export const isRevokeShareResponse = (v: unknown): v is RevokeShareResponse => isObj(v) && v.revoked === true;

export const isRevokeAllResponse = (v: unknown): v is RevokeAllResponse => isObj(v) && isMs(v.revoked);

/** `409 bad_counter` carries `{expected}`: the counter the API wants next. */
export const badCounterExpected = (err: ApiError): number | null => (err.code === 'bad_counter' && isMs(err.details.expected) ? err.details.expected : null);
