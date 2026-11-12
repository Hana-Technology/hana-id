// Errors the vault answers on the port (docs/batch-b-spec.md "Envelope" error table), and the mapping from API errors.
// A VaultError's message and data never carry key material, tokens or session secrets: they go to the partner page.
//
// D405: an error that came from a Hana API answer keeps that answer's request ID (`requestId`, the ApiError's, checked
// against API_REQUEST_ID_RE), and the port reply adds it as `data.requestId` for an SDK of API_REQUEST_ID_SDK_MIN or
// later. An error that never reached the API (a check in the vault, the user's cancel, a network failure) has none.
import { ApiError, ErrorCode, type HanaErrorCode, type ProtocolError, apiRequestIdOf, sessionKeyFailure } from '@hana-id/core';

export class VaultError extends Error {
  /** The API request this failure came from (D405), or null: only ever a well-formed request ID. */
  private apiRequestId: string | null = null;

  constructor(
    readonly code: HanaErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VaultError';
  }

  get requestId(): string | null {
    return this.apiRequestId;
  }

  /**
   * Marks this error as the outcome of the API answer `from` (an ApiError, or its request ID) and returns it. The first
   * mark stays (the answer closest to the failure); a value that isn't a request ID marks nothing.
   */
  fromRequest(from: ApiError | string | null | undefined): this {
    if (this.apiRequestId === null) this.apiRequestId = apiRequestIdOf(from instanceof ApiError ? from.requestId : from);
    return this;
  }

  /** The port error; `withRequestId` (the SDK takes the field, D405) adds `data.requestId` when there is one. */
  toProtocol(withRequestId = false): ProtocolError {
    const data = withRequestId && this.apiRequestId !== null ? { ...this.data, requestId: this.apiRequestId } : this.data;
    return data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data };
  }
}

export const notLoggedIn = (): VaultError => new VaultError(ErrorCode.unauthorized, 'Not logged in');
export const userRejected = (message = 'The user rejected the request'): VaultError => new VaultError(ErrorCode.userRejected, message);
export const disconnected = (message = 'The vault is disconnected'): VaultError => new VaultError(ErrorCode.disconnected, message);

const CONSENT_NOT_RECORDED = 'consent_not_recorded';

/** Allow was pressed but the API couldn't record the consent: nothing is stored (`e`, the failure, marks the request ID). */
export const consentNotRecorded = (e: unknown): VaultError =>
  new VaultError('api_unavailable', 'Auto-approve could not be turned on: Journear could not record it', { granted: false, reason: CONSENT_NOT_RECORDED }).fromRequest(e instanceof ApiError ? e : null);

export const isConsentNotRecorded = (e: unknown): boolean => e instanceof VaultError && e.data?.reason === CONSENT_NOT_RECORDED;

/**
 * newSessionKey's failure as the login's error (D385): `derive_failed` with `data.reason` `webcrypto_unsupported`
 * (this browser has no Ed25519 WebCrypto: update it or use another) or `webcrypto_failed` (the browser refused to make
 * the key: D381's OperationError four times in a row, or anything else; trying again can help), and `data.error`, the
 * platform error's name. Before D385 this fell through to `api_unavailable`, which blamed the network.
 */
export function sessionKeyError(e: unknown): VaultError {
  const f = sessionKeyFailure(e);
  const message = f.reason === 'webcrypto_unsupported' ? 'This browser cannot create the sign-in key (no Ed25519 in WebCrypto)' : 'This browser failed to create the sign-in key';
  return new VaultError('derive_failed', message, { ...f });
}

/**
 * Any thrown value as a port error. Unknown errors get a generic message (their text may come from a dependency).
 * `withRequestId`: the SDK on the port takes `data.requestId` (D405); an API error's own request ID is then added.
 */
export function toProtocolError(e: unknown, fallback: HanaErrorCode = 'api_unavailable', withRequestId = false): ProtocolError {
  if (e instanceof VaultError) return e.toProtocol(withRequestId);
  if (e instanceof ApiError) return apiErrorToVault(e).toProtocol(withRequestId);
  return { code: fallback, message: 'The request failed' };
}

/**
 * An API error that ends a flow, as a port error: gate and token problems keep their meaning, anything else is
 * `api_unavailable`. The API's own message is not forwarded; only its code (and, for token_has_pii, the claim name),
 * and its request ID (D405).
 */
export function apiErrorToVault(e: ApiError): VaultError {
  return apiErrorAsVault(e).fromRequest(e);
}

function apiErrorAsVault(e: ApiError): VaultError {
  const status = `${e.status} ${e.code}`;
  switch (e.code) {
    case 'token_has_pii': {
      // The API sends `{code: 'token_has_pii', data: {claim}}`.
      const data = e.details.data;
      const claim = typeof data === 'object' && data !== null && typeof (data as { claim?: unknown }).claim === 'string' ? (data as { claim: string }).claim : undefined;
      return new VaultError('token_has_pii', 'The Google token carries a claim outside the allow-list', claim === undefined ? undefined : { claim: claim.slice(0, 64) });
    }
    case 'no_google_client':
      return new VaultError('no_google_client', 'This app has no usable Google client');
    case 'app_suspended':
      return new VaultError('app_suspended', 'This app is suspended');
    // Email login (D231): the app turned email off between GET /v1/app and the login.
    case 'login_method_disabled':
      return new VaultError('login_method_unavailable', 'This sign-in method is not available for this app', { api: status });
    // The email-login refusals (D232, D250), which batch 8a's plain login meets only once links exist: a pending
    // member, an identity linked to an account (its own path no longer derives, D136), a token signed by a key no
    // current signer holds (sign in again for a fresh one).
    case 'link_pending':
      return new VaultError('link_pending', 'This sign-in method’s link to an account is pending', { api: status });
    case 'identity_linked':
      return new VaultError('login_method_unavailable', 'This sign-in method is linked to an account; sign in with that account’s method', { api: status, reason: 'identity_linked' });
    case 'token_stale':
      return new VaultError('token_invalid', 'The sign-in token is signed by a retired key; sign in again', { api: status });
    case 'origin_not_allowed':
    case 'scope_conflict':
      return new VaultError('origin_not_allowed', 'This site is not allowed for this app', { api: status });
    case 'rate_limited':
      return new VaultError('rate_limited', 'Too many requests, try again later');
    case 'ckd_failed':
      return new VaultError('ckd_failed', 'The key derivation failed');
    case 'invalid_token':
    case 'nonce_mismatch':
    case 'token_expired':
    case 'unsupported_issuer':
      return new VaultError('token_invalid', 'The Google token was refused', { api: status });
    default:
      if (e.status === 401) return new VaultError('token_invalid', 'The Google token was refused', { api: status });
      if (e.status === 429) return new VaultError('rate_limited', 'Too many requests, try again later');
      return new VaultError('api_unavailable', 'The Journear API could not complete the request', { api: status });
  }
}
