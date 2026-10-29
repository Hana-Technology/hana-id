// The Hana API calls the auth pages make (docs/batch-b-spec.md "API changes"). Calls on behalf of a partner carry
// `x-hana-key` (the app's publishable key) and `x-hana-parent-origin` (the partner origin the vault pinned), which
// appGate checks against the app's origins; the browser adds `Origin: authOrigin`.
//
// SECURITY: login bodies carry a Google ID token and relay bodies its ciphertext. Nothing here logs a body or puts one
// in an error message.
import {
  ApiError,
  type AppConfig,
  type LoginBody,
  type LoginResponse,
  RELAY_ID_PATTERN,
  type RelayCiphertext,
  type RelayReadResponse,
  isAppConfig,
  isLoginResponse,
  isRelayReadResponse,
  parseApiResponse,
} from '@hana-id/core';

export type Fetch = typeof fetch;

export interface AuthApi {
  /** `GET /v1/app` for the app `pk` serving `parentOrigin`. */
  getApp(pk: string, parentOrigin: string): Promise<AppConfig>;
  /** `POST /v1/login-relay/<relayId>` (callback). Resolves on 204; throws ApiError (409 `relay_used`, …) or a network error. */
  writeRelay(relayId: string, value: RelayCiphertext): Promise<void>;
  /** `GET /v1/login-relay/<relayId>?wait=…` (export window): the value, or null if still empty after `waitS`. */
  readRelay(relayId: string, readKey: string, waitS: number): Promise<RelayReadResponse | null>;
  /** `POST /v1/login` (export window). */
  login(pk: string, parentOrigin: string, body: LoginBody): Promise<LoginResponse>;
}

const bad = (what: string): ApiError => new ApiError(502, 'bad_response', `Unexpected ${what} response`, null, null);

export function authApi(apiUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): AuthApi {
  const base = new URL(apiUrl).origin;
  const init = (extra: RequestInit): RequestInit => ({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...extra });
  const appHeaders = (pk: string, parentOrigin: string) => ({ 'x-hana-key': pk, 'x-hana-parent-origin': parentOrigin });
  const relayUrl = (relayId: string) => {
    if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('Malformed relayId');
    return `${base}/v1/login-relay/${relayId}`;
  };

  return {
    async getApp(pk, parentOrigin) {
      const body = await parseApiResponse(await fetchFn(`${base}/v1/app`, init({ headers: { accept: 'application/json', ...appHeaders(pk, parentOrigin) } })));
      if (!isAppConfig(body)) throw bad('/v1/app');
      return body;
    },

    async writeRelay(relayId, value) {
      // keepalive: the callback closes its window right after this resolves, and a navigation must not cancel it.
      const res = await fetchFn(
        relayUrl(relayId),
        init({ method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ iv: value.iv, ct: value.ct }) }),
      );
      if (res.status === 204) return;
      await parseApiResponse(res);
      throw bad('relay write');
    },

    async readRelay(relayId, readKey, waitS) {
      const wait = Math.min(25, Math.max(1, Math.floor(waitS)));
      const res = await fetchFn(`${relayUrl(relayId)}?wait=${wait}`, init({ headers: { accept: 'application/json', 'x-hana-relay-key': readKey } }));
      if (res.status === 204) return null;
      const body = await parseApiResponse(res);
      if (!isRelayReadResponse(body)) throw bad('relay read');
      return body;
    },

    async login(pk, parentOrigin, body) {
      const res = await fetchFn(
        `${base}/v1/login`,
        init({ method: 'POST', headers: { 'content-type': 'application/json', ...appHeaders(pk, parentOrigin) }, body: JSON.stringify(body) }),
      );
      const out = await parseApiResponse(res);
      if (!isLoginResponse(out)) throw bad('/v1/login');
      return out;
    },
  };
}
