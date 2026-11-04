// The vault's Hana API client (docs/batch-b-spec.md "API changes"). Every app-gated call carries `x-hana-key` and
// `x-hana-parent-origin` (the parent pinned at the handshake); the browser sets `Origin: vaultOrigin`, which the API
// checks. Bodies are camelCase JSON with bytes as number arrays. Every response is shape-checked before it is used, and
// nothing the API returns ever chooses a path, session or counter for the vault (it re-syncs those from NEAR).
//
// SECURITY: request bodies carry a Google ID token (/v1/login, /v1/sessions) and responses carry K_s (shares, unlock).
// Nothing here logs a body.
import {
  ApiError,
  type AppConfig,
  type CkdResult,
  type CreateSessionBody,
  type CreateShareResponse,
  type DeriveBody,
  type LoginBody,
  type LoginResponse,
  type LinkBody,
  type LinkChangeBody,
  type RelayCiphertext,
  type RevokeBody,
  type RelayReadResponse,
  type RevokeAllResponse,
  type SessionView,
  type ShareActionBody,
  type TouchResponse,
  type UnlockResponse,
  type IdentityTokenBody,
  type IdentityTokenResponse,
  base64UrlEncode,
  isIdentityTokenResponse,
  isAppConfig,
  isCkdResult,
  isCreateShareResponse,
  isLoginResponse,
  isRelayReadResponse,
  isRevokeAllResponse,
  isRevokeShareResponse,
  isSessionView,
  isTouchResponse,
  isUnlockResponse,
  parseApiResponse,
} from '@hana-id/core';

type Fetch = typeof fetch;

export interface Relayed<T> {
  result: T;
  nearTx: string | null;
}

export type RelayRead = { kind: 'value'; value: RelayReadResponse } | { kind: 'empty' };

export interface VaultApiOptions {
  apiUrl: string;
  publishableKey: string;
  parentOrigin: string;
  fetch?: Fetch;
  /** Called with every `serverTimeMs` the API returns (the clock's refresh). */
  onServerTime?: (serverTimeMs: number) => void;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class VaultApi {
  private readonly base: string;
  private readonly fetchFn: Fetch;

  constructor(private readonly o: VaultApiOptions) {
    this.base = o.apiUrl.replace(/\/+$/u, '');
    this.fetchFn = o.fetch ?? ((...args) => fetch(...args));
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { 'x-hana-key': this.o.publishableKey, 'x-hana-parent-origin': this.o.parentOrigin };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  private async request(path: string, init: RequestInit): Promise<{ res: Response; body: Record<string, unknown> }> {
    const res = await this.fetchFn(`${this.base}${path}`, { ...init, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    const body = await parseApiResponse(res);
    return { res, body };
  }

  private async post<T>(path: string, payload: object, check: (v: unknown) => v is T, pick: (body: Record<string, unknown>) => unknown = (b) => b): Promise<{ value: T; nearTx: string | null }> {
    const { res, body } = await this.request(path, { method: 'POST', headers: this.headers(true), body: JSON.stringify(payload) });
    const value = pick(body);
    if (!check(value)) throw new ApiError(res.status, 'bad_response', `Unexpected ${path} response`, str(body.nearTx), str(body.requestId));
    return { value, nearTx: str(body.nearTx) };
  }

  /** GET /v1/app: the scope, signer and Google client (read from chain by the API), plus serverTimeMs. */
  async app(): Promise<AppConfig> {
    const { res, body } = await this.request('/v1/app', { method: 'GET', headers: this.headers(false) });
    if (!isAppConfig(body)) throw new ApiError(res.status, 'bad_response', 'Unexpected /v1/app response', null, str(body.requestId));
    if (body.serverTimeMs !== undefined) this.o.onServerTime?.(body.serverTimeMs);
    return body;
  }

  /** POST /v1/login (create_session_and_derive). */
  async login(payload: LoginBody): Promise<LoginResponse> {
    const { value } = await this.post('/v1/login', payload, isLoginResponse);
    return value;
  }

  /** POST /v1/sessions (the split fallback). */
  async createSession(payload: CreateSessionBody): Promise<Relayed<SessionView>> {
    const { value, nearTx } = await this.post('/v1/sessions', payload, isSessionView, (b) => b.result);
    return { result: value, nearTx };
  }

  /** POST /v1/derive. */
  async derive(payload: DeriveBody): Promise<Relayed<CkdResult>> {
    const { value, nearTx } = await this.post('/v1/derive', payload, isCkdResult, (b) => b.result);
    return { result: value, nearTx };
  }

  /**
   * GET /v1/login-relay/<relayId>?wait=… with the read key. Not app-gated (no x-hana-key). 200 consumes the slot; 204 is
   * "still empty"; 403 relay_forbidden and 410 relay_gone throw ApiError.
   */
  async relayRead(relayId: string, relayReadKey: Uint8Array, waitS: number, signal?: AbortSignal): Promise<RelayRead> {
    const res = await this.fetchFn(`${this.base}/v1/login-relay/${relayId}?wait=${waitS}`, {
      method: 'GET',
      headers: { 'x-hana-relay-key': base64UrlEncode(relayReadKey) },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...(signal ? { signal } : {}),
    });
    if (res.status === 204) return { kind: 'empty' };
    const body = await parseApiResponse(res);
    if (!isRelayReadResponse(body)) throw new ApiError(res.status, 'bad_response', 'Unexpected relay response', null, str(body.requestId));
    this.o.onServerTime?.(body.serverTimeMs);
    return { kind: 'value', value: body };
  }

  /**
   * POST /v1/login-relay/<relayId>: the vault's follow-up notice to its login popup (build plan batch 8b), ciphertext
   * under the login's relayKey. Not app-gated. Throws ApiError (409 relay_used, …) or a network error.
   */
  async relayWrite(relayId: string, value: RelayCiphertext): Promise<void> {
    const res = await this.fetchFn(`${this.base}/v1/login-relay/${relayId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ iv: value.iv, ct: value.ct }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (res.status === 204) return;
    await parseApiResponse(res);
    throw new ApiError(res.status, 'bad_response', 'Unexpected relay write response', null, null);
  }

  /** POST /v1/sessions/revoke (revoke_session; D137's recovery of a session meant to carry a link). */
  async revokeSession(payload: RevokeBody): Promise<void> {
    await this.request('/v1/sessions/revoke', { method: 'POST', headers: this.headers(true), body: JSON.stringify(payload) });
  }

  /** POST /v1/link (link_identity): `effectiveAtMs` of the pending link. */
  async link(payload: LinkBody): Promise<Relayed<{ effectiveAtMs: number }>> {
    const isResult = (v: unknown): v is { effectiveAtMs: number } => typeof v === 'object' && v !== null && Number.isSafeInteger((v as { effectiveAtMs?: unknown }).effectiveAtMs);
    const { value, nearTx } = await this.post('/v1/link', payload, isResult, (b) => b.result);
    return { result: value, nearTx };
  }

  /** POST /v1/link/cancel or /v1/link/unlink (cancel_link, unlink_identity). */
  async linkChange(action: 'cancel' | 'unlink', payload: LinkChangeBody): Promise<void> {
    await this.request(`/v1/link/${action}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(payload) });
  }

  async createShare(sessionPublicKey: Uint8Array, signature: Uint8Array): Promise<CreateShareResponse> {
    const { value } = await this.post('/v1/vault/shares', { sessionPublicKey: Array.from(sessionPublicKey), signature: Array.from(signature) }, isCreateShareResponse);
    return value;
  }

  async unlock(body: ShareActionBody): Promise<UnlockResponse> {
    return (await this.post('/v1/vault/unlock', body, isUnlockResponse)).value;
  }

  async touch(body: ShareActionBody): Promise<TouchResponse> {
    return (await this.post('/v1/vault/touch', body, isTouchResponse)).value;
  }

  async revoke(body: ShareActionBody): Promise<void> {
    await this.post('/v1/vault/revoke', body, isRevokeShareResponse);
  }

  async revokeAll(body: ShareActionBody): Promise<RevokeAllResponse> {
    return (await this.post('/v1/vault/revoke-all', body, isRevokeAllResponse)).value;
  }

  /** POST /v1/identity/token: a partner identity token for the session that signed `body` (identity.ts). */
  async identityToken(body: IdentityTokenBody): Promise<IdentityTokenResponse> {
    return (await this.post('/v1/identity/token', body, isIdentityTokenResponse)).value;
  }
}
