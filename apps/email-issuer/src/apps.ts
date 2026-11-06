// The app behind a publishable key, read from the API through its read-only `IssuerRpc` entrypoint (service binding
// `API`, D432; it replaced the read-write `APP_DB` binding of the API's D1, D251). The issuer has no binding to the
// API's D1 and can't write it; the API runs the lookups by its gate's model (apps/api/src/issuer-apps.ts: an
// `app_keys` key not revoked or in its rotation grace, an undeleted app, active only with no suspension bit, email on
// only when `login_methods` lists `email`) and answers each app's issuer view only (console-core `IssuerApp`).
//
// A failed call (no binding, the API not yet serving IssuerRpc, a refusal or an error) throws ApiUnavailable: the
// request answers `503 api_unavailable` and nothing is minted or sent.
import type { IssuerAnswer, IssuerApp, IssuerRpcClient } from '@hana-id/console-core';

export type { IssuerApp } from '@hana-id/console-core';

const PK_RE = /^pk_(?:test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u;
export const isPublishableKey = (v: unknown): v is string => typeof v === 'string' && PK_RE.test(v);

/** The API couldn't answer an app lookup; `reason` is logged (a method and a code, never the key or id). */
export class ApiUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`IssuerRpc ${reason}`);
    this.reason = reason;
  }
}

async function call<T extends object>(method: string, run: () => Promise<IssuerAnswer<T>>): Promise<T> {
  let answer: IssuerAnswer<T>;
  try {
    answer = await run();
  } catch {
    throw new ApiUnavailable(`${method}:unreachable`);
  }
  if (typeof answer !== 'object' || answer === null || answer.ok !== true) {
    throw new ApiUnavailable(`${method}:${typeof answer === 'object' && answer !== null && 'code' in answer ? String(answer.code) : 'malformed'}`);
  }
  return answer;
}

/** A well-formed issuer view (the API's answer is checked, not trusted to be the right shape). */
function checked(method: string, app: unknown): IssuerApp | null {
  if (app === null) return null;
  if (typeof app !== 'object' || app === undefined) throw new ApiUnavailable(`${method}:malformed`);
  const a = app as Partial<IssuerApp>;
  const ok =
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    typeof a.scopeId === 'string' &&
    typeof a.active === 'boolean' &&
    typeof a.emailOn === 'boolean' &&
    Number.isSafeInteger(a.perMinute) &&
    Number.isSafeInteger(a.perDay) &&
    (a.googleWebClientId === null || typeof a.googleWebClientId === 'string');
  if (!ok) throw new ApiUnavailable(`${method}:malformed`);
  return a as IssuerApp;
}

/**
 * The app behind `pk`: a key not revoked (or still in its rotation grace, on the API's clock) of an app not deleted.
 * Null for an unknown, revoked or deleted app's key (the caller answers 401 invalid_key); a suspended app comes back
 * with `active` false.
 */
export async function appByKey(api: IssuerRpcClient | undefined, pk: string): Promise<IssuerApp | null> {
  const r = await call('appByKey', () => (api ? api.appByKey({ pk }) : Promise.reject(new Error('no API binding'))));
  return checked('appByKey', r.app);
}

/** The app by id (verify: the challenge names its app; a suspended or deleted app's challenges mint nothing). */
export async function appById(api: IssuerRpcClient | undefined, appId: string): Promise<IssuerApp | null> {
  const r = await call('appById', () => (api ? api.appById({ appId }) : Promise.reject(new Error('no API binding'))));
  return checked('appById', r.app);
}

/**
 * Whether `scopeId` has an active (no suspension bit, legacy status active), undeleted app with email on (a staff
 * client proof is only for such a scope, tokens review L6).
 */
export async function scopeHasEmailApp(api: IssuerRpcClient | undefined, scopeId: string): Promise<boolean> {
  const r = await call('scopeHasEmailApp', () => (api ? api.scopeHasEmailApp({ scopeId }) : Promise.reject(new Error('no API binding'))));
  if (typeof r.hasEmailApp !== 'boolean') throw new ApiUnavailable('scopeHasEmailApp:malformed');
  return r.hasEmailApp;
}
