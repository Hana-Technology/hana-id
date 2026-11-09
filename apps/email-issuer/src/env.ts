// The email issuer Worker's bindings. Vars come from envs/<env>.json `emailIssuer` through scripts/gen-wrangler.ts;
// secrets are set by the operator (`scripts/email-issuer.ts <env> put`, or `wrangler secret put SENDGRID_API_KEY`)
// and are never logged, printed or returned.
import type { IssuerRpcClient } from '@hana-id/console-core';
import type { Challenge } from './challenge.ts';
import type { Outbox } from './outbox.ts';
import type { RateLimiter } from './rate-limiter.ts';

export interface Env {
  /** The issuer's own D1: email_issuance, email_hints, email_suppressions, email_admin_audit, user_emails, user_email_apps (D269). */
  DB: D1Database;
  /**
   * The API Worker's read-only `IssuerRpc` entrypoint (D434): `pk` or app id → the app's issuer view (scope, status,
   * plan limits, email on), and whether a scope has an email app. The issuer has no binding to the API's D1. Optional
   * in the type only: gen always binds it, and a missing one fails every lookup closed (`503 api_unavailable`).
   */
  API?: IssuerRpcClient;
  EMAIL_CHALLENGE: DurableObjectNamespace<Challenge>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** `local*` envs only (gen refuses it elsewhere): the outbox stub's store, read by tests through this binding. */
  OUTBOX?: DurableObjectNamespace<Outbox>;

  ENV_NAME: string;
  NEAR_RPC: string;
  NEAR_RPC_FALLBACK?: string;
  /** The hana-signer account: every nonce commits to it (`borsh(signer)`). */
  SIGNER_ACCOUNT: string;
  /** The token's `iss` (`{emailIssuer.url}/v1/email`, the URL defaulting to the API's, D230). */
  EMAIL_ISS: string;
  /** JSON array of the public RSA JWKs the JWKS serves (manifest `emailIssuer.publicKeys`). */
  EMAIL_PUBLIC_KEYS: string;
  /** The kid ISSUER_SIGNING_KEY must have (manifest `emailIssuer.signer.activeKid`). */
  EMAIL_ACTIVE_KID: string;
  /** `worker-secret` (testnet); `aws-kms` is refused by gen until batch 10. */
  EMAIL_SIGNER_KIND: string;
  /** `sendgrid` or `outbox` (local* only). */
  EMAIL_SENDER: string;
  /** `From` of user mail. */
  MAIL_FROM: string;
  /** The login popup's origin: CORS for start, resend and verify; named in the code mail. */
  AUTH_ORIGIN: string;
  /** The vault's origin: CORS for google-match (the vault sends it). */
  VAULT_ORIGIN: string;
  /** The env's daily user-mail budget (the breaker). */
  DAILY_SEND_BUDGET?: string;
  /** Cloudflare Access for admin/client-proof: team domain, application AUD tag, staff allowlist (JSON array). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_STAFF_EMAILS?: string;
  /**
   * The admin console's Cloudflare Access application (manifest `admin.accessTeamDomain`, `admin.accessAud`,
   * `admin.staffEmails` as JSON): DirectoryRpc verifies each staff call's JWT against these itself (D275). Absent or
   * unusable: every DirectoryRpc call answers `access_unavailable`.
   */
  ADMIN_ACCESS_TEAM_DOMAIN?: string;
  ADMIN_ACCESS_AUD?: string;
  ADMIN_STAFF_EMAILS?: string;
  /** SendGrid's Event Webhook verification key (base64 SPKI, public). */
  SENDGRID_WEBHOOK_PUBLIC_KEY?: string;
  /**
   * The build id (D384, @hana-id/env/build-id): set only by the `deploy` script (`wrangler deploy --var
   * HANA_BUILD:<id>`), never by `gen`; GET /v1/email/health reports it as `build`.
   */
  HANA_BUILD?: string;

  // ---- secrets ----
  /** RSA private JWK (JSON) of the active `hana` key: testnet only (D121). */
  ISSUER_SIGNING_KEY?: string;
  /** K_sub: base64 of 32 bytes. Feeds every email user's `sub` (frozen; never rotated). */
  EMAIL_SUB_KEY?: string;
  /** K_code: base64 of 32 bytes. Code hashes in the challenge objects. */
  EMAIL_CODE_KEY?: string;
  /** K_rl: base64 of 32 bytes. Mailbox limiter and suppression keys (HMAC of the address without its `+tag`). */
  EMAIL_RL_KEY?: string;
  /** SendGrid API key restricted to Mail Send, used only by this Worker (D194). */
  SENDGRID_API_KEY?: string;
  /**
   * The sealed email's key (D438, docs/email-sharing-spec.md): `<id>:<base64 of 32 bytes>`, id 1..2^32-1, the same value
   * as the API's. google-match, google-record and a `session` verify seal the verified address with it for the API
   * (`sealedEmail`). Absent or malformed: no answer carries `sealedEmail` (logged once as a code), nothing else changes.
   */
  IDENTITY_SEAL_KEY?: string;
}

/** Every secret binding: log lines must never contain their values (tested). */
export const SECRET_NAMES = ['ISSUER_SIGNING_KEY', 'EMAIL_SUB_KEY', 'EMAIL_CODE_KEY', 'EMAIL_RL_KEY', 'SENDGRID_API_KEY', 'IDENTITY_SEAL_KEY'] as const satisfies readonly (keyof Env)[];

/** The daily send budget of a `local*` env whose manifest sets none (every other env must set it, abuse review H1). */
export const DEFAULT_DAILY_SEND_BUDGET = 1000;

/** The env's daily send budget; 0 (every user mail refused, logged `unconfigured`) when a non-`local*` env sets none. */
export function dailySendBudget(env: Env): number {
  if (env.DAILY_SEND_BUDGET === undefined || env.DAILY_SEND_BUDGET === '') return env.ENV_NAME.startsWith('local') ? DEFAULT_DAILY_SEND_BUDGET : 0;
  const n = Number(env.DAILY_SEND_BUDGET);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
