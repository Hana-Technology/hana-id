// The email issuer Worker's bindings. Vars come from envs/<env>.json `emailIssuer` through scripts/gen-wrangler.ts;
// secrets are set by the operator (`scripts/email-issuer.ts <env> put`, or `wrangler secret put SENDGRID_API_KEY`)
// and are never logged, printed or returned.
import type { Challenge } from './challenge.ts';
import type { Outbox } from './outbox.ts';
import type { RateLimiter } from './rate-limiter.ts';

export interface Env {
  /** The issuer's own D1: email_issuance, email_hints, email_suppressions, email_admin_audit. */
  DB: D1Database;
  /**
   * The API's D1, read only (apps, plans): `pk` → app, scope, status, plan and `login_methods`. The issuer never
   * writes to it.
   */
  APP_DB: D1Database;
  EMAIL_CHALLENGE: DurableObjectNamespace<Challenge>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** `local*` envs only (gen refuses it elsewhere): the outbox stub's store, read by tests through this binding. */
  OUTBOX?: DurableObjectNamespace<Outbox>;

  ENV_NAME: string;
  NEAR_RPC: string;
  NEAR_RPC_FALLBACK?: string;
  /** The hana-signer account: every nonce commits to it (`borsh(signer)`). */
  SIGNER_ACCOUNT: string;
  /** The token's `iss` (`{apiUrl}/v1/email`). */
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
  /** SendGrid's Event Webhook verification key (base64 SPKI, public). */
  SENDGRID_WEBHOOK_PUBLIC_KEY?: string;

  // ---- secrets ----
  /** RSA private JWK (JSON) of the active `hana` key: testnet only (D121). */
  ISSUER_SIGNING_KEY?: string;
  /** K_sub: base64 of 32 bytes. Feeds every email user's `sub` (frozen; never rotated). */
  EMAIL_SUB_KEY?: string;
  /** K_code: base64 of 32 bytes. Code hashes in the challenge objects. */
  EMAIL_CODE_KEY?: string;
  /** K_rl: base64 of 32 bytes. Limiter and suppression keys (`email_key`). */
  EMAIL_RL_KEY?: string;
  /** SendGrid API key restricted to Mail Send, used only by this Worker (D194). */
  SENDGRID_API_KEY?: string;
}

/** Every secret binding: log lines must never contain their values (tested). */
export const SECRET_NAMES = ['ISSUER_SIGNING_KEY', 'EMAIL_SUB_KEY', 'EMAIL_CODE_KEY', 'EMAIL_RL_KEY', 'SENDGRID_API_KEY'] as const satisfies readonly (keyof Env)[];

/** Default daily send budget when the manifest sets none. */
export const DEFAULT_DAILY_SEND_BUDGET = 1000;

export function dailySendBudget(env: Env): number {
  const n = Number(env.DAILY_SEND_BUDGET ?? DEFAULT_DAILY_SEND_BUDGET);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DAILY_SEND_BUDGET;
}
