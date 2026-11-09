// IssuerRpc (D434, readiness row 7.1d): the API's read-only entrypoint for the email issuer, bound only by it (`API`)
// and reachable through no route. It replaces the issuer's read-write `APP_DB` binding of the API's D1 (D251), so a
// compromised issuer Worker can neither write the API's tables nor read any of them beyond these three lookups:
//
//   - `appByKey`: the app behind a publishable key (the start, resend and google-* gates);
//   - `appById`: an app by id (verify: the challenge names its app);
//   - `scopeHasEmailApp`: whether a scope has an active, undeleted app with email on (the staff client proof).
//
// The API answers with the app's issuer view only (no origin, key, setting or user data), by the API gate's model
// (apps/api/src/issuer-apps.ts). Inputs are strict: an unknown field is `bad_request`.
import { z } from 'zod';

/** A publishable key as the issuer accepts one (`pk_test_` / `pk_live_` + base58). */
export const issuerPkInput = z.string().regex(/^pk_(?:test|live)_[1-9A-HJ-NP-Za-km-z]{16,64}$/u);
/**
 * An app id as the challenge recorded it (the API's own id for the app, from `appByKey`): `app_<base58>` today, but any
 * id an `apps` row can hold is accepted (older and test rows carry `_`), since it is only ever a bound parameter.
 */
export const issuerAppIdInput = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/u);
/** A scope id as the issuer's commitments carry one (a scope this doesn't match has no app: the answer is false). */
export const issuerScopeIdInput = z.string().regex(/^[a-z0-9]{1,64}$/u);

export const issuerAppByKeyInput = z.object({ pk: issuerPkInput }).strict();
export const issuerAppByIdInput = z.object({ appId: issuerAppIdInput }).strict();
export const issuerScopeInput = z.object({ scopeId: issuerScopeIdInput }).strict();

/** What the issuer learns of an app: enough for its gates, nothing else. */
export interface IssuerApp {
  id: string;
  name: string;
  scopeId: string;
  /** No suspension bit, the legacy `status` active, and (by key) the key's prefix names the scope's environment. */
  active: boolean;
  /** `login_methods` lists `email` (false for every app before the API's migration 0010). */
  emailOn: boolean;
  /** The app's plan limits (the issuer's per-app mail limits). */
  perMinute: number;
  perDay: number;
  /** The app's own Google web client, when it set one (API migration 0003): google-match then accepts only it. */
  googleWebClientId: string | null;
}

export type IssuerRpcCode = 'bad_request' | 'internal';
export type IssuerRpcFail = { ok: false; code: IssuerRpcCode; error?: string };
export type IssuerAnswer<T extends object> = ({ ok: true } & T) | IssuerRpcFail;

/** The entrypoint's methods, exactly (the API's tests compare its prototype with this list). */
export const ISSUER_RPC_METHODS = ['appByKey', 'appById', 'scopeHasEmailApp'] as const;

/** The entrypoint as the issuer calls it over its `API` service binding. */
export interface IssuerRpcClient {
  appByKey(input: { pk: string }): Promise<IssuerAnswer<{ app: IssuerApp | null }>>;
  appById(input: { appId: string }): Promise<IssuerAnswer<{ app: IssuerApp | null }>>;
  scopeHasEmailApp(input: { scopeId: string }): Promise<IssuerAnswer<{ hasEmailApp: boolean }>>;
}
