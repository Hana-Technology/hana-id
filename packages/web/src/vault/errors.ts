// Errors the vault answers on the port (docs/batch-b-spec.md "Envelope" error table), and the mapping from API errors.
// A VaultError's message and data never carry key material, tokens or session secrets: they go to the partner page.
import { ApiError, ErrorCode, type HanaErrorCode, type ProtocolError } from '@hana-id/core';

export class VaultError extends Error {
  constructor(
    readonly code: HanaErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VaultError';
  }

  toProtocol(): ProtocolError {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }
}

export const notLoggedIn = (): VaultError => new VaultError(ErrorCode.unauthorized, 'Not logged in');
export const userRejected = (message = 'The user rejected the request'): VaultError => new VaultError(ErrorCode.userRejected, message);
export const disconnected = (message = 'The vault is disconnected'): VaultError => new VaultError(ErrorCode.disconnected, message);

/** Any thrown value as a port error. Unknown errors get a generic message (their text may come from a dependency). */
export function toProtocolError(e: unknown, fallback: HanaErrorCode = 'api_unavailable'): ProtocolError {
  if (e instanceof VaultError) return e.toProtocol();
  if (e instanceof ApiError) return apiErrorToVault(e).toProtocol();
  return { code: fallback, message: 'The request failed' };
}

/**
 * An API error that ends a flow, as a port error: gate and token problems keep their meaning, anything else is
 * `api_unavailable`. The API's own message is not forwarded; only its code (and, for token_has_pii, the claim name).
 */
export function apiErrorToVault(e: ApiError): VaultError {
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
      return new VaultError('api_unavailable', 'The Hana API could not complete the request', { api: status });
  }
}
