// Client for the Hana ID API app endpoints (apps/api/README.md "Endpoints"). The browser sets `Origin`; the API
// checks it against the app's allowed origins. Request bodies are camelCase with byte arrays as JSON number arrays.

export type GoogleMode = 'own' | 'shared';

export interface AppConfig {
  scopeId: string;
  signer: string;
  google: { clientId: string; mode: GoogleMode };
  requestId: string;
}

/** Contract Session as create_session returns it. */
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

export interface CreateSessionBody {
  jwt: string;
  sessionPublicKey: number[];
  expiresAtMs: number;
  salt: number[];
  keyIndex: number;
  maxUses: number;
}

export interface DeriveBody {
  sessionPublicKey: number[];
  counter: number;
  signature: number[];
  pk1: string;
  pk2: string;
}

export interface RevokeBody {
  sessionPublicKey: number[];
  counter: number;
  signature: number[];
}

/** An API error: HTTP status, the API's `code` (e.g. `nonce_mismatch`, `contract_rejected`) and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nearTx: string | null,
    readonly requestId: string | null,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = 'ApiError';
  }
}

type Fetch = typeof fetch;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function parse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not the API's JSON (e.g. a proxy error page): report what came back, briefly.
    throw new ApiError(res.status, 'non_json_response', text.slice(0, 200) || res.statusText, null, res.headers.get('x-request-id'));
  }
  if (!isObj(body)) throw new ApiError(res.status, 'bad_response', 'Response is not a JSON object', null, res.headers.get('x-request-id'));
  if (!res.ok) {
    throw new ApiError(res.status, str(body.code) ?? 'error', str(body.error) ?? res.statusText, str(body.nearTx), str(body.requestId) ?? res.headers.get('x-request-id'));
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
    (v.google.mode === 'own' || v.google.mode === 'shared')
  );
}

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
    const body = await parse(res);
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
    const body = await parse(res);
    const nearTx = str(body.nearTx);
    const requestId = str(body.requestId);
    if (!check(body.result)) throw new ApiError(res.status, 'bad_response', `Unexpected ${path} result`, nearTx, requestId);
    return { result: body.result, nearTx, requestId };
  }
}
