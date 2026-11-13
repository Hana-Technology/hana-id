// The email issuer's manifest block (docs/email-login-spec.md "Issuer configuration", build plan batch 4): the issuer
// URL, its Worker and D1, the signer, the public keys its JWKS serves, the user-mail sender and the optional staff
// access for client proofs. The JWKS is generated from `publicKeys` alone, so what the issuer publishes never depends on
// D1 or on a secret. Public keys only: a private member (`d`, `p`, …) is refused.
import { createHash } from 'node:crypto';
import { z } from './zod.ts';
import { emailFromProblem } from './dashboard.ts';
import { isLocalEnv } from './origins.ts';

/**
 * RFC 7638 thumbprint of an RSA public JWK: b64url(sha256('{"e":…,"kty":"RSA","n":…}')) with `n` and `e` as unpadded
 * base64url of the unsigned big-endian integers without leading zero bytes. The same value as `@hana-id/jwks`
 * `rsaThumbprint` (the watchdog's pin, D190; a test in apps/email-issuer checks the two agree). Throws on a component
 * that isn't base64url.
 */
export function rsaJwkThumbprint(jwk: { n: string; e: string }): string {
  const strip = (s: string): string => {
    if (!/^[A-Za-z0-9_-]+$/u.test(s)) throw new Error('RSA key components are base64url');
    const bytes = Buffer.from(s, 'base64url');
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    return bytes.subarray(i).toString('base64url');
  };
  return createHash('sha256').update(`{"e":"${strip(jwk.e)}","kty":"RSA","n":"${strip(jwk.n)}"}`).digest('base64url');
}

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/u, 'base64url without padding');
const kid = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'A kid is an RFC 7638 thumbprint (43 base64url characters)');
const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, 'A Worker name is 1-63 lowercase letters, digits and inner hyphens');
const lowerEmail = z
  .string()
  .email()
  .refine((e) => e === e.toLowerCase(), 'Email addresses here are lowercased');

/** RSA modulus sizes the contract accepts for issuer keys (`set_issuer_key`: 2048–4096 bits). */
export const EMAIL_KEY_MIN_BITS = 2048;
export const EMAIL_KEY_MAX_BITS = 4096;
/** Keys the JWKS may list (the contract's `key_signer` holds ≤ 8 per self-issued issuer). */
export const MAX_EMAIL_PUBLIC_KEYS = 8;
/** An app id as the API mints it (`app_…`): the keys of `emailIssuer.appShares`. */
export const EMAIL_APP_ID_RE = /^app_[A-Za-z0-9_-]{1,64}$/u;
/** At most this many apps get their own share (D793). */
export const MAX_EMAIL_APP_SHARES = 8;
/** One window's max in `emailIssuer.tighterLimits`. */
const limitMax = z.number().int().min(1).max(10_000);

/** A public RSA key as the issuer's JWKS serves it. `.strict()`: a private member or anything else is refused. */
export const emailPublicKeySchema = z
  .object({ kty: z.literal('RSA'), n: b64url, e: b64url, kid, use: z.literal('sig'), alg: z.literal('RS256') })
  .strict();

/**
 * Testnet and `local*` only (D121): the RSA private key that signs is the Worker secret ISSUER_SIGNING_KEY, and
 * `activeKid` names it. The standby key is published (and posted on chain) but kept off the Worker (D196).
 */
const workerSecretSigner = z.object({ kind: z.literal('worker-secret'), activeKid: kid }).strict();

/**
 * Mainnet (build plan batch 10): AWS KMS `RSA_2048` keys, primary and standby, each named by its kid. The issuer has
 * the adapter (tested against a fake KMS) but `gen` refuses this kind until batch 10 wires it.
 */
const awsKmsSigner = z
  .object({
    kind: z.literal('aws-kms'),
    awsRegion: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u, 'An AWS region such as ap-east-1'),
    keys: z
      .object({
        primary: z.object({ kid, arn: z.string().regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u, 'A KMS key ARN') }).strict(),
        standby: z.object({ kid, arn: z.string().regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u, 'A KMS key ARN') }).strict(),
      })
      .strict(),
  })
  .strict();

export const EMAIL_SENDERS = ['sendgrid', 'outbox'] as const;

export const emailIssuerSchema = z
  .object({
    /**
     * The origin the issuer Worker is reached at; it serves `{url}/v1/email/*` (D230). Absent: the API's URL, through a
     * route on the API's zone that sends `/v1/email/*` to the issuer Worker (production: the API Worker never sees an
     * address or a code, D199). Required when the API is on `workers.dev` (no zone, so no route): then the issuer's own
     * `workers.dev` URL, `https://<issuer Worker>.<the API's subdomain>.workers.dev` (sandbox-dev).
     */
    url: z.string().optional(),
    /** The token's `iss`: `{url}/v1/email` (`url` defaulting to the API's). Not in any path, so it may change later (`set_issuer` keeps 4 values). */
    iss: z.string(),
    /** The issuer Worker and its own D1 (`email_issuance`, `email_hints`, `email_suppressions`), on Hana's main account. */
    cloudflare: z.object({ workerName, d1Name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u) }).strict(),
    signer: z.discriminatedUnion('kind', [workerSecretSigner, awsKmsSigner]),
    /** Every key of signer `hana` (primary and standby): 1–8, each kid its key's thumbprint. */
    publicKeys: z.array(emailPublicKeySchema).min(1).max(MAX_EMAIL_PUBLIC_KEYS),
    /** `From` of user mail: `Display Name <address>` on the dedicated user-mail sending subdomain (D87, D194). */
    from: z.string(),
    /** User-mail provider: SendGrid (D194); `outbox` (a test-only Durable Object) in `local*` envs only. */
    sender: z.enum(EMAIL_SENDERS),
    /**
     * The env's daily user-mail budget (the breaker): 15% the owner pool, the rest shared out per app. Required outside
     * `local*` envs (no silent default; abuse review H1); a `local*` env without one gets 1000.
     */
    dailySendBudget: z.number().int().min(1).max(10_000_000).optional(),
    /**
     * Testnet only (D793): named apps' daily share of the general pool, in mails, in place of the plan-sized one (2% of
     * the plan's `per_day`). Each at most `dailySendBudget`; the issuer still caps it at the general pool, and the 20%
     * reserve still applies. Absent: every app's share comes from its plan.
     */
    appShares: z.record(z.string().regex(EMAIL_APP_ID_RE, 'appShares keys are app ids (app_…)'), z.number().int().min(1).max(10_000_000)).optional(),
    /**
     * Testnet only (D793): lower maxes for the per-IP `start` and `resend` windows, the per-mailbox-and-requester code
     * windows and the per-prefix (IPv4 /24, IPv6 /56 and /48) `start` day. The issuer applies each only below the env's own limit (it can tighten, never loosen); absent, the
     * env's set (D340) as it is.
     */
    tighterLimits: z
      .object({
        ipStart: z.object({ per10m: limitMax.optional(), perDay: limitMax.optional() }).strict().optional(),
        ipResend: z.object({ per10m: limitMax.optional() }).strict().optional(),
        mailboxIpCodes: z.object({ per15m: limitMax.optional(), perDay: limitMax.optional() }).strict().optional(),
        aggStart: z.object({ perDay: limitMax.optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    /**
     * `POST /v1/email/admin/client-proof` (staff only): the Cloudflare Access application in front of that path and the
     * issuer's own staff allowlist behind it (D88). Absent: the endpoint answers 404.
     */
    access: z
      .object({
        teamDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u, 'teamDomain is <team>.cloudflareaccess.com'),
        aud: z.string().regex(/^[0-9a-f]{64}$/u, 'aud is the Access application’s 64-hex-character AUD tag'),
        staffEmails: z.array(lowerEmail).min(1).max(50),
      })
      .strict()
      .optional(),
    /**
     * SendGrid's Event Webhook verification key (base64 of the ECDSA P-256 SubjectPublicKeyInfo, a public value): bounce
     * and spam-report events feed `email_suppressions`. Absent: the webhook answers 404.
     */
    sendgridWebhookPublicKey: z.string().regex(/^[A-Za-z0-9+/]{80,200}={0,2}$/u, 'base64 of a P-256 public key (SPKI)').optional(),
  })
  .strict();

export type EmailIssuerConfig = z.infer<typeof emailIssuerSchema>;
export type EmailPublicKey = z.infer<typeof emailPublicKeySchema>;

/** The `iss` of an issuer reached at `baseUrl` (it answers `{baseUrl}/v1/email/*`: under the API's URL by a route, Q5, or its own, D230). */
export const emailIssuerFor = (baseUrl: string): string => `${baseUrl.replace(/\/+$/u, '')}/v1/email`;

const WORKERS_DEV = /^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/u;

/**
 * The issuer's own `workers.dev` origin when the API is on `workers.dev` (`https://<workerName>.<the API's
 * subdomain>.workers.dev`, the same Cloudflare account), else undefined (the issuer is then routed under the API's URL).
 */
export function workersDevIssuerUrl(apiUrl: string, workerName: string): string | undefined {
  let host: string;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    return undefined;
  }
  const m = WORKERS_DEV.exec(host);
  return m ? `https://${workerName}.${m[2]}.workers.dev` : undefined;
}

/** Where the env's issuer is reached: `emailIssuer.url`, else the API's origin (a zone route), D230. */
export const emailIssuerUrl = (m: { apiUrl: string; emailIssuer?: { url?: string | undefined } | undefined }): string => (m.emailIssuer?.url ?? m.apiUrl).replace(/\/+$/u, '');

/** The issuer's JWKS URL (`{emailIssuerUrl}/v1/email/jwks.json`): the watchdog's default `jwksUrl`. */
export const emailJwksUrl = (m: { apiUrl: string; emailIssuer?: { url?: string | undefined } | undefined }): string => `${emailIssuerUrl(m)}/v1/email/jwks.json`;

/** Modulus size in bits (leading zero bytes ignored), or 0 when it isn't base64url. */
export function rsaModulusBits(n: string): number {
  if (!/^[A-Za-z0-9_-]+$/u.test(n)) return 0;
  const bytes = Buffer.from(n, 'base64url');
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return 0;
  return (bytes.length - i) * 8 - Math.clz32(bytes[i]!) + 24;
}

/**
 * Cross-field rules: `iss` is the API's `/v1/email`; every kid is its key's thumbprint and appears once; keys are
 * 2048–4096-bit RSA with exponent 65537; the signer names published keys; a Worker-secret signer only on testnet
 * (mainnet keys live in KMS, D121); the outbox stub only in `local*` envs; its own Worker, never the API's or the
 * watchdog's.
 */
export function emailIssuerRules(
  m: {
    name: string;
    network: string;
    apiUrl: string;
    vaultOrigin?: string | undefined;
    authOrigin?: string | undefined;
    cloudflare: { workerName: string; d1Name: string };
    watchdog?: { cloudflare: { workerName: string } } | undefined;
  },
  t: EmailIssuerConfig,
  ctx: z.RefinementCtx,
): void {
  const at = (...path: (string | number)[]) => ['emailIssuer', ...path];
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: at(...path), message });
  // Where the issuer is reached (D230): its own origin, or the API's through a zone route, never a workers.dev API's.
  const ownWorkersDev = workersDevIssuerUrl(m.apiUrl, t.cloudflare.workerName);
  if (t.url !== undefined) {
    let u: URL | null = null;
    try {
      u = new URL(t.url);
    } catch {
      issue(['url'], 'emailIssuer.url is not a URL');
    }
    if (u && (u.protocol !== 'https:' || u.origin !== t.url)) issue(['url'], 'emailIssuer.url must be an https origin (no path, no trailing slash)');
    if (u && [m.vaultOrigin, m.authOrigin].includes(u.origin)) issue(['url'], 'emailIssuer.url must not be a Hana page origin (vaultOrigin, authOrigin)');
    if (ownWorkersDev !== undefined && t.url !== ownWorkersDev) issue(['url'], `emailIssuer.url must be the issuer's own workers.dev URL ${ownWorkersDev} (the API is on workers.dev: no zone route, D230)`);
  } else if (ownWorkersDev !== undefined) {
    issue(['url'], `emailIssuer.url is required when the API is on workers.dev (no zone to route /v1/email/* on): ${ownWorkersDev} (D230)`);
  }
  const base = emailIssuerUrl({ apiUrl: m.apiUrl, emailIssuer: t });
  if (t.iss !== emailIssuerFor(base)) issue(['iss'], `emailIssuer.iss must be ${emailIssuerFor(base)} (the issuer serves /v1/email/*)`);
  const kids = new Set<string>();
  const moduli = new Set<string>();
  t.publicKeys.forEach((k, i) => {
    let thumb: string | null = null;
    try {
      thumb = rsaJwkThumbprint(k);
    } catch {
      issue(['publicKeys', i], 'Malformed RSA key');
    }
    if (thumb !== null && thumb !== k.kid) issue(['publicKeys', i, 'kid'], 'kid must be the key’s RFC 7638 thumbprint');
    if (kids.has(k.kid)) issue(['publicKeys', i, 'kid'], `Duplicate key ${k.kid}`);
    kids.add(k.kid);
    const bits = rsaModulusBits(k.n);
    if (bits < EMAIL_KEY_MIN_BITS || bits > EMAIL_KEY_MAX_BITS) issue(['publicKeys', i, 'n'], `RSA modulus must be ${EMAIL_KEY_MIN_BITS}-${EMAIL_KEY_MAX_BITS} bits (got ${bits})`);
    if (k.e !== 'AQAB') issue(['publicKeys', i, 'e'], 'Exponent must be 65537 (AQAB)');
    const modulus = Buffer.from(k.n, 'base64url').toString('hex').replace(/^(?:00)+/u, '');
    if (moduli.has(modulus)) issue(['publicKeys', i, 'n'], 'The same modulus is listed twice (the contract registers a modulus once)');
    moduli.add(modulus);
  });
  const named = t.signer.kind === 'worker-secret' ? [t.signer.activeKid] : [t.signer.keys.primary.kid, t.signer.keys.standby.kid];
  for (const k of named) if (!kids.has(k)) issue(['signer'], `The signer's key ${k} is not in emailIssuer.publicKeys`);
  if (t.signer.kind === 'aws-kms' && t.signer.keys.primary.kid === t.signer.keys.standby.kid) issue(['signer', 'keys'], 'Primary and standby must be different keys');
  if (t.signer.kind === 'worker-secret' && m.network !== 'testnet') issue(['signer', 'kind'], 'A Worker-secret email signing key is testnet only: mainnet uses AWS KMS (D121)');
  if (t.sender === 'outbox' && !isLocalEnv(m.name)) issue(['sender'], 'The outbox sender is a test stub, for local* envs only');
  if (t.dailySendBudget === undefined && !isLocalEnv(m.name)) issue(['dailySendBudget'], 'emailIssuer.dailySendBudget is required outside local* envs (the daily user-mail budget; no default)');
  if (t.appShares !== undefined) {
    if (m.network !== 'testnet') issue(['appShares'], 'emailIssuer.appShares is testnet only (D793)');
    const entries = Object.entries(t.appShares);
    if (entries.length > MAX_EMAIL_APP_SHARES) issue(['appShares'], `emailIssuer.appShares names at most ${MAX_EMAIL_APP_SHARES} apps`);
    for (const [app, n] of entries) if (t.dailySendBudget !== undefined && n > t.dailySendBudget) issue(['appShares', app], 'An app share must be at most emailIssuer.dailySendBudget');
  }
  if (t.tighterLimits !== undefined && m.network !== 'testnet') issue(['tighterLimits'], 'emailIssuer.tighterLimits is testnet only (D793)');
  const fromProblem = emailFromProblem(t.from);
  if (fromProblem) issue(['from'], `emailIssuer.from ${fromProblem}`);
  if (t.cloudflare.workerName === m.cloudflare.workerName) issue(['cloudflare', 'workerName'], "emailIssuer.cloudflare.workerName must differ from the API's Worker (Q1: a separate Worker)");
  if (m.watchdog && t.cloudflare.workerName === m.watchdog.cloudflare.workerName) issue(['cloudflare', 'workerName'], "emailIssuer.cloudflare.workerName must differ from the watchdog's Worker");
  if (t.cloudflare.d1Name === m.cloudflare.d1Name) issue(['cloudflare', 'd1Name'], "emailIssuer.cloudflare.d1Name must differ from the API's D1 (the issuer's own tables)");
}

/**
 * The email issuer's files in `.secrets/<env>/` (0600, written by scripts/email-issuer.ts init; never printed, never
 * overwritten). The signing keys are RSA private JWKs (JSON): `signingKey` signs (the Worker secret
 * ISSUER_SIGNING_KEY), `standbyKey` is published and posted on chain but kept off the Worker (D196). The three HMAC
 * keys are base64 of 32 random bytes: K_sub (`sub`; losing it locks every email user out, replacing it moves every
 * email address), K_code (code hashes), K_rl (limiter and suppression keys). `sendgridKey` is pasted by hand (a
 * Mail-Send-only SendGrid API key used by the issuer alone, D194).
 */
export const EMAIL_ISSUER_SECRET_FILES = {
  signingKey: 'email-issuer-signing-key.json',
  standbyKey: 'email-issuer-signing-key-standby.json',
  subKey: 'email-sub-key',
  codeKey: 'email-code-key',
  rlKey: 'email-rl-key',
  sendgridKey: 'email-issuer-sendgrid-key',
} as const;
