// Client for the Hana ID API app endpoints (apps/api/README.md "Endpoints"). The browser sets `Origin`; the API
// checks it against the app's allowed origins. Request bodies are camelCase with byte arrays as JSON number arrays. The
// request/response types and guards live in @hana-id/core (api-types.ts).
import {
  ApiError,
  type AppConfig,
  type CkdResult,
  type CreateSessionBody,
  type DeriveBody,
  type Relayed,
  type RevokeBody,
  type SessionView,
  isAppConfig,
  isCkdResult,
  isSessionView,
  parseApiResponse,
} from '@hana-id/core';

export {
  ApiError,
  type AppConfig,
  type CkdResult,
  type CreateSessionBody,
  type DeriveBody,
  type GoogleMode,
  type Relayed,
  type RevokeBody,
  type SessionView,
  isAppConfig,
  isCkdResult,
  isSessionView,
} from '@hana-id/core';

type Fetch = typeof fetch;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class HanaApi {
  private readonly base: string;

  constructor(
    apiUrl: string,
    private readonly publishableKey: string,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
  ) {
    this.base = apiUrl.replace(/\/+$/u, '');
  }

  /** GET /v1/app → scope, signer and which Google client to use. */
  async app(): Promise<AppConfig> {
    const res = await this.fetchFn(`${this.base}/v1/app`, { method: 'GET', headers: { 'x-hana-key': this.publishableKey } });
    const body = await parseApiResponse(res);
    if (!isAppConfig(body)) throw new ApiError(res.status, 'bad_response', 'Unexpected /v1/app response', null, str(body.requestId));
    return body;
  }

  createSession(body: CreateSessionBody): Promise<Relayed<SessionView>> {
    return this.post('/v1/sessions', body, isSessionView);
  }

  derive(body: DeriveBody): Promise<Relayed<CkdResult>> {
    return this.post('/v1/derive', body, isCkdResult);
  }

  revoke(body: RevokeBody): Promise<Relayed<null>> {
    return this.post('/v1/sessions/revoke', body, (v): v is null => v === null);
  }

  private async post<T>(path: string, payload: object, check: (v: unknown) => v is T): Promise<Relayed<T>> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hana-key': this.publishableKey },
      body: JSON.stringify(payload),
    });
    const body = await parseApiResponse(res);
    const nearTx = str(body.nearTx);
    const requestId = str(body.requestId);
    if (!check(body.result)) throw new ApiError(res.status, 'bad_response', `Unexpected ${path} result`, nearTx, requestId);
    return { result: body.result, nearTx, requestId };
  }
}
