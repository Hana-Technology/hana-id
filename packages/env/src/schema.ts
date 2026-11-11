import { urlString, z } from './zod.ts';
import { adminSchema, consoleSchema, dashboardRules, delayMs, emailSchema, filesSchema, usageSchema } from './dashboard.ts';
import { CLOUDFLARE_ACCOUNT_ID_RE } from './cloudflare.ts';
import { emailIssuerRules, emailIssuerSchema } from './email-issuer.ts';
import { identityTokenRules, identityTokenSchema } from './identity.ts';
import { hanaOriginProblem, isDevEnv, isLocalEnv, isLoopbackHost, siteOf } from './origins.ts';

/** Independent RPC providers the pinned CKD network key must be read from, all agreeing (OPER-1, D100). */
export const MIN_CKD_SOURCES = 3;

/** At most this many `apiRpcFallbacks`: each can add a per-endpoint timeout to an API call (D435). */
export const MAX_API_RPC_FALLBACKS = 3;

const nearAccount = z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u, 'Invalid NEAR account id');

/** Cloudflare Durable Object location hints (https://developers.cloudflare.com/durable-objects/reference/data-location/). */
export const DO_LOCATION_HINTS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'] as const;

const clientId = z.string().min(1).max(255).regex(/^\S+$/u, 'Client IDs contain no whitespace');

/** Paging apps the watchdog can page through (D85: chosen at setup). */
export const PAGER_PROVIDERS = ['ntfy', 'pushover', 'pagerduty'] as const;

/** A warning and a critical threshold in NEAR (critical below warn), for the watchdog's relayer funds check. */
const nearThresholds = z
  .object({ warn: z.number().positive().max(100_000), critical: z.number().nonnegative().max(100_000) })
  .strict()
  .refine((t) => t.critical < t.warn, { message: 'critical must be below warn' });

const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, 'A Worker name is 1-63 lowercase letters, digits and inner hyphens');

/** Signers in a self-issued issuer's policy, at most, and its keys (all signers together): the contract's limits. */
export const MAX_PINNED_SIGNERS = 3;
export const MAX_PINNED_KEYS = 8;
/** Identity keys the watchdog pins, at most: the JWKS holds up to 4 (active, standby, next, previous), plus room to pin ahead. */
export const MAX_PINNED_IDENTITY_KEYS = 8;
/** At most as many exit clients as the contract holds (`MAX_EXIT_CLIENTS`). */
export const MAX_PINNED_EXIT_CLIENTS = 4;
const provider = z.string().regex(/^[a-z0-9_-]{1,32}$/u, 'A provider is 1-32 characters of a-z 0-9 _ -');

/** An RSA key's RFC 7638 JWK thumbprint (unpadded base64url SHA-256): the email issuer's `kid` for that key. */
const keyThumbprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'A pinned key is its RFC 7638 JWK thumbprint (43 base64url characters)');
/** A signer id as the contract accepts it (`valid_provider`). */
const signerId = z.string().regex(/^[a-z0-9_-]{1,32}$/u, 'A signer id is 1-32 lowercase letters, digits, _ or -');

/**
 * The signer policy the watchdog expects of a self-issued issuer (`docs/email-login-spec.md` "Watchdog"): every
 * signer's keys by thumbprint, and the number of distinct signers a token needs. 1-of-1 (`hana`) at launch; Level 1
 * adds `cosign` before its upgrade executes.
 */
const signerPolicyPins = z
  .object({
    required: z.number().int().min(1).max(MAX_PINNED_SIGNERS),
    signers: z.record(signerId, z.array(keyThumbprint).min(1).max(MAX_PINNED_KEYS)),
    /** Where Hana publishes the issuer's JWKS (compared with the pins, warning only). Default `{emailIssuer.url}/v1/email/jwks.json` (under `apiUrl` without one, D230). */
    jwksUrl: z.string().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = Object.keys(p.signers);
    if (ids.length < 1 || ids.length > MAX_PINNED_SIGNERS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signers'], message: `1 to ${MAX_PINNED_SIGNERS} signers` });
    if (p.required > ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['required'], message: 'required must not exceed the number of signers' });
    const all = Object.values(p.signers).flat();
    if (all.length > MAX_PINNED_KEYS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signers'], message: `at most ${MAX_PINNED_KEYS} pinned keys in all` });
    // One key is one signer: the contract refuses a modulus registered twice, so a thumbprint pinned twice is a typo.
    if (new Set(all).size !== all.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signers'], message: 'A key is pinned once, for one signer' });
  });

/**
 * Why `url` can't be the watchdog's status origin, or null: an https origin exactly (no credentials, port, path, query
 * or fragment), since the admin Worker sends its bearer token there and follows no redirect.
 */
export function watchdogUrlProblem(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'https:') return 'must be https';
  if (u.username || u.password) return 'must not carry credentials';
  if (u.port) return 'must not have a port';
  if (u.origin !== v) return 'must be an origin only (no path, query or trailing slash)';
  return null;
}

const watchdogSchema = z.object({
  /**
   * The watchdog's own NEAR account: one of the contract's watchdogs (`add_watchdog`). Its Worker secret
   * `WATCHDOG_KEY` is a function-call key on it (receiver `signer`, methods `cancel_issuer_key_change`,
   * `confirm_issuer_key_change`, `pause`, `delete_updater_key`).
   */
  account: nearAccount,
  cloudflare: z.object({
    /** The watchdog's own Cloudflare account (separate login and MFA from the API's, D86). `UNSET` until created. */
    accountId: z.string().regex(/^(?:[0-9a-f]{32}|UNSET)$/u, 'A Cloudflare account id is 32 lowercase hex characters (or UNSET)'),
    workerName,
    d1Name: z.string().min(1),
  }),
  /**
   * The watchdog Worker's https origin on its own account (`https://<workerName>.<subdomain>.workers.dev`, or a custom
   * domain), with no path: the admin Worker reads its `/status`, `/alerts`, `/actions` and posts acks there with the
   * bearer `WATCHDOG_STATUS_TOKEN` (batch C14, D330). Not a secret. Optional: without it the admin's "Security &
   * monitoring" view shows the watchdog as not configured; a production admin config requires it.
   */
  url: z
    .string()
    .max(253 + 8)
    .superRefine((v, ctx) => {
      const problem = watchdogUrlProblem(v);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `watchdog.url ${problem}` });
    })
    .optional(),
  /** Who gets warning and critical emails and the daily digest: both founders (D85). */
  alertEmails: z.array(z.string().email()).min(1).max(10),
  /** Sender address on the dedicated sending subdomain (D87). */
  alertFrom: z.string().email(),
  /** The paging app for critical alerts (D85). Its credentials are Worker secrets. */
  pager: z.enum(PAGER_PROVIDERS),
  /** Hour (UTC, 0-23) after which the daily info digest is sent; default 0. */
  digestHourUtc: z.number().int().min(0).max(23).optional(),
  /**
   * Thresholds (NEAR) of the relayer funds check (`relayer` account balance, each pool key's remaining allowance);
   * each pair optional. Defaults (apps/watchdog/src/relayer.ts): balance 5 / 1, session-pool key 0.5 / 0.1 (of its 2 NEAR
   * allowance), owner-pool key 0.1 / 0.02 (of 0.5 NEAR), Home-pool key 1 / 0.2 (of 5 NEAR). Raise the allowance pairs
   * if deploy-contract ran with a larger `--relayer-allowance` / `--owner-relayer-allowance` / `--home-relayer-allowance`.
   */
  relayerFunds: z
    .object({ balance: nearThresholds.optional(), sessionAllowance: nearThresholds.optional(), ownerAllowance: nearThresholds.optional(), homeAllowance: nearThresholds.optional() })
    .strict()
    .optional(),
  /**
   * Pinned keys of self-issued issuers (`docs/email-login-spec.md` "Watchdog"): `email: {required, signers: {hana:
   * [thumbprint, …]}}`. Set on the watchdog's own account: a pin change is a watchdog redeploy by the operator, outside
   * Hana's main account. Absent `email` = nothing pinned: the watchdog then treats every email key as unpinned
   * (cancels pending ones, pauses on an active one) and alerts on any email issuer on chain. Pin before the owner
   * posts the first email key (`docs/email-login-build-plan.md` batch 6).
   */
  pinnedIssuerKeys: z.object({ email: signerPolicyPins.optional() }).strict().optional(),
  /**
   * The partner identity token's public keys the watchdog accepts in the API's JWKS (`docs/identity-token-spec.md`
   * "JWKS and discovery", D210): RFC 7638 thumbprints of the P-256 keys, which are also their kids. Set on the
   * watchdog's own account, so a pin change is a watchdog redeploy by the operator. Absent = nothing pinned: every
   * published identity key is unpinned (critical, no pause). With `identityToken` in the manifest every one of its
   * `publicKeys` must be pinned here (`scripts/identity-key.ts` writes both); extra pins are allowed (a key pinned
   * before the API publishes it warns `identity_key_missing` until it does).
   */
  pinnedIdentityKeys: z.array(keyThumbprint).min(1).max(MAX_PINNED_IDENTITY_KEYS).optional(),
  /**
   * Hana Home's exit clients the watchdog expects on chain (`[provider, aud]`, D468, D493): one on chain that isn't
   * pinned here pages critical, and pauses the contract when it is in force. Pin before the council runs
   * `set_exit_clients` (docs/operations.md). Absent = nothing pinned.
   */
  pinnedExitClients: z.array(z.tuple([provider, z.string().min(1).max(256)])).min(1).max(MAX_PINNED_EXIT_CLIENTS).optional(),
  /** Exit sessions per hour that page `exit_volume_high` (D487, D493; alert only). Default 20 (the watchdog's constant). */
  exitAlertPerHour: z.number().int().min(1).max(100_000).optional(),
});

/**
 * The watchdog is a different party from every account it watches, and a different Worker from the API. Its account
 * is one of the contract's `watchdogs`, so `deploy-contract` adds it on chain (`add_watchdog`); a watchdog service
 * whose account the contract doesn't know can't cancel or pause anything.
 */
function watchdogRules(
  m: {
    name: string;
    signer: string;
    relayer: string;
    owner: string;
    mpc: string;
    watchdogs?: string[] | undefined;
    cloudflare: { workerName: string; accountId?: string | undefined };
    identityToken?: { publicKeys: { kid: string }[] } | undefined;
  },
  w: z.infer<typeof watchdogSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!(m.watchdogs ?? []).includes(w.account)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'account'], message: `watchdog.account ${w.account} must be listed in watchdogs (the contract's watchdog accounts)` });
  }
  // A workers.dev url names the Worker it reaches: it must be the watchdog's own (a typo would send the bearer elsewhere).
  const host = w.url && !watchdogUrlProblem(w.url) ? new URL(w.url).hostname : null;
  if (host?.endsWith('.workers.dev') && /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/u.exec(host)?.[1] !== w.cloudflare.workerName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'url'], message: `watchdog.url on workers.dev must be https://${w.cloudflare.workerName}.<subdomain>.workers.dev` });
  }
  for (const field of ['signer', 'relayer', 'owner', 'mpc'] as const) {
    if (w.account === m[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'account'], message: `watchdog.account must not be the ${field} account` });
  }
  // D86: the watchdog runs on its own Cloudflare account (separate login and MFA), never the env's main one.
  if (m.cloudflare.accountId !== undefined && w.cloudflare.accountId === m.cloudflare.accountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'cloudflare', 'accountId'], message: "watchdog.cloudflare.accountId must be the watchdog's own account, not cloudflare.accountId (D86)" });
  }
  if (w.cloudflare.workerName === m.cloudflare.workerName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'cloudflare', 'workerName'], message: "watchdog.cloudflare.workerName must differ from the API's Worker name" });
  }
  if (new Set(w.alertEmails).size !== w.alertEmails.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'alertEmails'], message: 'Duplicate alert email' });
  const jwksUrl = w.pinnedIssuerKeys?.email?.jwksUrl;
  const problem = jwksUrl === undefined ? null : endpointUrlProblem(jwksUrl, m.name);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'pinnedIssuerKeys', 'email', 'jwksUrl'], message: `watchdog.pinnedIssuerKeys.email.jwksUrl ${problem}` });
  const exitPins = (w.pinnedExitClients ?? []).map(([p, a]) => `${p}/${a}`);
  if (new Set(exitPins).size !== exitPins.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'pinnedExitClients'], message: 'An exit client is pinned once' });
  const identityPins = w.pinnedIdentityKeys ?? [];
  if (new Set(identityPins).size !== identityPins.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'pinnedIdentityKeys'], message: 'An identity key is pinned once' });
  // Pin before publish (D211): a key the API publishes that the watchdog doesn't pin pages as a forgery.
  for (const k of m.identityToken?.publicKeys ?? []) {
    if (!identityPins.includes(k.kid)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['watchdog', 'pinnedIdentityKeys'],
        message: `identityToken key ${k.kid} is not in watchdog.pinnedIdentityKeys: pin every published identity key (docs/operations.md "Identity token keys")`,
      });
    }
  }
}

/**
 * The NEAR meta-transaction relay (D733; docs/api.md "NEAR relay"): the account whose full-access keys
 * (`NEAR_RELAY_KEYS`, a Worker secret) pay for Hana wallets' NEAR transactions, the contracts it relays calls to
 * (empty = nothing is relayed), and its limits. Optional: without it the relay routes answer 503. Bounds as the API's
 * parser (apps/api/src/near/relay-config.ts) enforces them.
 */
export const nearRelaySchema = z
  .object({
    account: nearAccount,
    receivers: z.array(nearAccount).max(16),
    /** Gas all inner calls of one delegate may attach together, Tgas (default 50). */
    maxGasTgas: z.number().int().min(1).max(300).optional(),
    /** NEAR the relay may spend per UTC day across the env (default 5). */
    dailyBudgetNear: z.number().positive().max(1000).optional(),
    /** Relays per sender account per UTC day (default 100). */
    perSenderPerDay: z.number().int().min(1).max(10_000).optional(),
    /** Relays per app per UTC day (default 5000). */
    perAppPerDay: z.number().int().min(1).max(1_000_000).optional(),
    /** Below this balance (NEAR) the hourly check writes `near_relay_balance_low` (default 2). */
    lowBalanceNear: z.number().positive().max(1000).optional(),
    /** The activation's Transfer in yocto (default "0": a zero Transfer creates an implicit account); at most 0.01 NEAR. */
    activationYocto: z
      .string()
      .regex(/^(0|[1-9]\d{0,22})$/u, 'activationYocto is a decimal yocto amount')
      .refine((v) => BigInt(v) <= 10n ** 22n, 'activationYocto is at most 0.01 NEAR')
      .optional(),
  })
  .strict();

/** NEAR wallet settings (D733, D740): the demo guestbook contract and the meta-transaction relay. */
export const nearSchema = z
  .object({
    /** The demo guestbook contract (contracts/hana-guestbook). */
    demoGuestbook: nearAccount.optional(),
    relay: nearRelaySchema.optional(),
  })
  .strict();

/**
 * The relay account is its own (never the signer, relayer, owner, MPC, a watchdog or the guestbook: its keys are
 * full-access and pay any deposit a delegate attaches, which the API refuses); receivers are distinct, never the relay
 * account, the signer or the relayer (a relayed call into hana-signer would act as the user's implicit account there).
 */
function nearRules(m: { signer: string; relayer: string; owner: string; mpc: string; watchdogs?: string[] | undefined; near?: z.infer<typeof nearSchema> | undefined }, ctx: z.RefinementCtx): void {
  const relay = m.near?.relay;
  if (!relay) return;
  const taken: [string, string][] = [['signer', m.signer], ['relayer', m.relayer], ['owner', m.owner], ['mpc', m.mpc], ...(m.watchdogs ?? []).map((w): [string, string] => ['watchdog', w])];
  if (m.near?.demoGuestbook) taken.push(['near.demoGuestbook', m.near.demoGuestbook]);
  for (const [what, account] of taken) {
    if (relay.account === account) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['near', 'relay', 'account'], message: `near.relay.account must be its own account, not the ${what}` });
  }
  if (new Set(relay.receivers).size !== relay.receivers.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['near', 'relay', 'receivers'], message: 'near.relay.receivers must be distinct' });
  for (const r of relay.receivers) {
    if (r === relay.account || r === m.signer || r === m.relayer) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['near', 'relay', 'receivers'], message: `near.relay.receivers must not list ${r} (the relay account, the signer or the relayer)` });
    }
  }
}

/** One environment's accounts and endpoints. Every account name the code uses comes from here. */
export const manifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/u),
    network: z.enum(['testnet']),
    /** hana-signer contract account: the MPC predecessor, so it is part of every user's address. */
    signer: nearAccount,
    /** Account whose function-call keys the API uses to pay gas. */
    relayer: nearAccount,
    /** Contract admin (`owner` in hana-signer). */
    owner: nearAccount,
    mpc: nearAccount,
    ckdDomainId: z.number().int().nonnegative(),
    /** The MPC's CKD public key, pinned (fetch with scripts/fetch-ckd-key.ts). */
    ckdNetworkKey: z.string(),
    /**
     * Where `ckdNetworkKey` was read (scripts/fetch-ckd-key.ts writes it): the final block every source answered at,
     * and the hosts of the ≥ MIN_CKD_SOURCES RPC endpoints of independent providers (distinct registrable domains)
     * that all returned the same key and block hash there. Hosts only, never a URL that could carry an API key.
     * Optional until each env re-pins with the multi-source fetch.
     */
    ckdNetworkKeySource: z
      .object({
        blockHeight: z.number().int().nonnegative(),
        blockHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u, 'blockHash is a base58 block hash'),
        rpcs: z
          .array(z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/u, 'rpcs are host names (no scheme, path or query)'))
          .min(MIN_CKD_SOURCES)
          .max(10),
      })
      .strict()
      .optional(),
    /** NEAR RPC: https outside `local*` envs (there, http only for a loopback host). */
    rpc: urlString(),
    /**
     * Second NEAR RPC (https, not `rpc` itself), from an independent provider (another registrable domain outside
     * `local*` envs). The vault and the export window read from it when `rpc` errors or times out (get_session
     * re-syncs, registry views, tx polling), each read's answer from one endpoint; and they confirm on both, read
     * separately, any path that isn't the signed-in identity's own (an account member's, D263). Required with
     * `emailIssuer` outside `local*` envs (linking makes members). It joins `rpc` in those pages' CSP `connect-src`.
     */
    rpcFallback: urlString().optional(),
    /**
     * The API's own NEAR RPC fallbacks (D435), asked in this order after `rpc` when an endpoint gives no JSON-RPC
     * answer (a network error, a timeout, HTTP 5xx or 429, a body that isn't JSON-RPC, a node with no synced block);
     * never for a JSON-RPC answer, an error answer included. 1–MAX_API_RPC_FALLBACKS https URLs (http only for a
     * loopback host in `local*` envs), distinct, none of them `rpc`. Unset: the API falls back to `rpcFallback` alone
     * (apiRpcFallbacksOf). Each one is trusted like `rpc` for the API's views whenever the earlier ones fail. Only the
     * API reads it (`NEAR_RPC_FALLBACKS`): the pages, the watchdog and the admin Worker keep `rpc` and `rpcFallback`.
     */
    apiRpcFallbacks: z.array(urlString()).min(1).max(MAX_API_RPC_FALLBACKS).optional(),
    /** The API's base URL: https outside `local*` envs (there, http only for a loopback host). */
    apiUrl: urlString(),
    /**
     * Origin of the key vault page (`GET /vault`, a hidden iframe in partner pages). Optional until every deployed env
     * has it; requires `authOrigin`. Rules (both origins): see origins.ts `hanaOriginProblem`, and the two must be
     * different sites outside dev envs.
     */
    vaultOrigin: z.string().optional(),
    /**
     * Origin of the login, callback, approval and export pages. Google redirects to `{authOrigin}/login/callback`, so
     * changing it breaks own-client partners' redirect registrations (not addresses).
     */
    authOrigin: z.string().optional(),
    /** Timelock for adding client IDs / changing owners, in ms (contract allows 0..7 days). */
    changeDelayMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000),
    /**
     * Batch C's delay for guarded changes (origin adds, auto-approve policies, raw-signing enables), in ms: 60 s to
     * 7 days; at least 24 h on a production network, where `changeDelayMs` must be no shorter (docs/batch-c-spec.md
     * "Manifest"). It replaces batch B's raw-sign/policy delay rule for the API and the CLI (from batch C3).
     */
    appChangeDelayMs: delayMs,
    /** Hana Home derives per UTC day across the env; 0 turns them off. Absent: the API's default (500). */
    homeDerivesPerDay: z.number().int().min(0).max(9_999_999).optional(),
    /**
     * Hana's own org in the usage ledger (an internal org staff made in the admin console): Hana Home derives that no
     * partner pays for are recorded for it. Absent: they are recorded for the legacy org.
     */
    hanaOrgId: z.string().regex(/^org_[A-Za-z0-9]{1,60}$/u).optional(),
    /**
     * Batch C's dashboard (docs/batch-c-spec.md "Manifest"): set together with `files`, `admin`, `usage`, `email` and
     * `ownerGrantDelayMs`, or none of them (`dashboard.ts`). Without them the env runs the API only.
     */
    console: consoleSchema.optional(),
    files: filesSchema.optional(),
    admin: adminSchema.optional(),
    usage: usageSchema.optional(),
    email: emailSchema.optional(),
    /** How long a new owner stays a viewer (D89), in ms; same bounds as `appChangeDelayMs`. */
    ownerGrantDelayMs: delayMs.optional(),
    /** Hana's own Google client IDs, registered to the reserved `global` scope at deploy. */
    googleClientIds: z.array(clientId),
    /**
     * Hana's shared Google login client(s) (`set_shared_clients` at deploy; the contract allows 5). Apps without their
     * own Google client log in through one of these into a scope registered with `allow_shared`. A client ID can't be
     * both shared and a scope's own client.
     */
    sharedGoogleClientIds: z.array(clientId).max(5),
    /** Client IDs of the Hana console, accepted for OIDC owner actions: [provider, aud]. */
    consoleAudiences: z.array(z.tuple([z.string(), z.string()])),
    /**
     * Who `owner` is (docs/governance-spec.md "Owner = multisig", D81): `account` = a plain NEAR account whose
     * full-access key the scripts read from ~/.near-credentials; `sputnik` = a Sputnik DAO v2 council (`council.dao`,
     * which `owner` must then equal), driven through proposals (scripts/lib/owner-tx.ts).
     */
    ownerKind: z.enum(['account', 'sputnik']).optional(),
    /**
     * The owner council: a Sputnik DAO v2 created by `factory` (the DAO account is `<name>.<factory>`) with exactly
     * three members, 2 of 3 for every proposal kind (contracts/sputnik/policy.json). Present before it becomes the
     * owner (migration: the old owner proposes it, the DAO accepts).
     */
    council: z
      .object({
        factory: nearAccount,
        dao: nearAccount,
        members: z.array(nearAccount).length(3),
      })
      .optional(),
    /** Watchdog accounts (≤ 3) the contract lets cancel, confirm and pause (docs/governance-spec.md "Watchdogs"). */
    watchdogs: z.array(nearAccount).max(3).optional(),
    /**
     * `issuer_key_delay_ms` for `new` (contract allows 0..7 days; D80). deploy-contract refuses less
     * than the security bound 3·(W + T) = 18 min outside dev envs (`delays.ts` `governanceDelayProblems`).
     */
    issuerKeyDelayMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
    /**
     * `governance_delay_ms` for `new` (contract allows 0..30 days; D80). deploy-contract refuses less
     * than 24 h outside dev envs (72 h on mainnet).
     */
    governanceDelayMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000).optional(),
    /**
     * The signer account may keep a full-access key (D86): sandbox-dev only. Refused here on any network but testnet;
     * deploy-contract also refuses it on a non-dev env (`local*`, `sandbox*` only), and a test keeps every committed
     * manifest but sandbox-dev's from setting it. Every other env's signer has only the updater keys the contract
     * installed; deploy-contract blocks on any other key.
     */
    allowSignerFullAccessKey: z.boolean().optional(),
    cloudflare: z.object({
      /**
       * The Cloudflare account every Worker of the env except the watchdog deploys to (the API, its two page Workers,
       * the email issuer, the dashboard Workers and the demo): every `gen` writes it as the config's `account_id`, and
       * refuses a `CLOUDFLARE_ACCOUNT_ID` in the shell that names another account (`cloudflare.ts` accountIdFields,
       * D404). Optional: without it wrangler deploys to `CLOUDFLARE_ACCOUNT_ID` or the login's account. Not a secret.
       */
      accountId: z.string().regex(CLOUDFLARE_ACCOUNT_ID_RE, 'A Cloudflare account id is 32 lowercase hex characters').optional(),
      workerName: z.string().min(1),
      d1Name: z.string().min(1),
      /**
       * Region for the Durable Objects every request shares (relayer keys, per-app and owner-action limiters), passed
       * as a location hint when they are first created. Per-IP limiters stay near their client. Optional: without it
       * Cloudflare places each object near the first request that uses it. Changing it creates new objects there.
       */
      durableObjectLocation: z.enum(DO_LOCATION_HINTS).optional(),
    }),
    /**
     * The watchdog service (apps/watchdog, docs/governance-spec.md "Watchdog service"). Optional: an env without it
     * has no watchdog Worker (`gen` for apps/watchdog refuses it). It runs on its own Cloudflare account (D86).
     */
    watchdog: watchdogSchema.optional(),
    /**
     * The partner identity token (docs/identity-token-spec.md, D127): issuer, signer and the public keys of the JWKS.
     * Optional: without it the API answers `/v1/identity/*` with 503 identity_unavailable.
     * `scripts/identity-key.ts <env> init` writes it.
     */
    identityToken: identityTokenSchema.optional(),
    /**
     * The email issuer (apps/email-issuer, docs/email-login-spec.md "Issuer configuration"): iss, Worker and D1, signer,
     * the JWKS's public keys, the user-mail sender. Optional: without it there is no issuer Worker (its `gen` refuses).
     * `scripts/email-issuer.ts <env> init` writes it.
     */
    emailIssuer: emailIssuerSchema.optional(),
    /** NEAR wallet settings: the demo guestbook and the meta-transaction relay (nearSchema). Optional. */
    near: nearSchema.optional(),
  })
  .superRefine((m, ctx) => {
    nearRules(m, ctx);
    for (const field of ['rpc', 'rpcFallback', 'apiUrl'] as const) {
      const value = m[field];
      const problem = value === undefined ? null : endpointUrlProblem(value, m.name);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} ${problem}` });
    }
    if (m.ckdNetworkKeySource) ckdSourceRules(m.ckdNetworkKeySource, ctx);
    hanaOrigins(m, ctx);
    if (m.watchdog) watchdogRules(m, m.watchdog, ctx);
    if (m.identityToken) identityTokenRules(m, m.identityToken, ctx);
    if (m.emailIssuer) emailIssuerRules(m, m.emailIssuer, ctx);
    governance(m, ctx);
    dashboardRules(m, ctx);
    if (m.rpcFallback !== undefined && m.rpcFallback === m.rpc) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rpcFallback'], message: 'rpcFallback must be a different endpoint from rpc' });
    } else if (m.rpcFallback !== undefined && !isLocalEnv(m.name) && safeSite(m.rpcFallback) !== null && safeSite(m.rpcFallback) === safeSite(m.rpc)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rpcFallback'], message: `rpcFallback must be another provider (registrable domain) than rpc outside local* envs (both are ${safeSite(m.rpc)})` });
    }
    for (const [i, url] of (m.apiRpcFallbacks ?? []).entries()) {
      const problem = endpointUrlProblem(url, m.name);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiRpcFallbacks', i], message: `apiRpcFallbacks[${i}] ${problem}` });
      else if (url === m.rpc) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiRpcFallbacks', i], message: 'apiRpcFallbacks must not repeat rpc (it is always asked first)' });
      else if (m.apiRpcFallbacks?.indexOf(url) !== i) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiRpcFallbacks', i], message: `apiRpcFallbacks lists ${url} twice` });
    }
    if (m.emailIssuer && m.rpcFallback === undefined && !isLocalEnv(m.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rpcFallback'], message: 'an env with emailIssuer needs rpcFallback outside local* envs: a linked identity’s path is confirmed on two providers (D263)' });
    }
    const dup = (list: string[]) => list.find((v, i) => list.indexOf(v) !== i);
    for (const field of ['googleClientIds', 'sharedGoogleClientIds'] as const) {
      const d = dup(m[field]);
      if (d !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `Duplicate client ID ${d}` });
    }
    // The contract rejects a (provider, aud) that is both a shared client and a scope's client; googleClientIds and
    // the console audiences become clients of the `global` scope.
    const scopeClients = new Set([...m.googleClientIds, ...m.consoleAudiences.filter(([p]) => p === 'google').map(([, a]) => a)]);
    for (const id of m.sharedGoogleClientIds) {
      if (scopeClients.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sharedGoogleClientIds'], message: `${id} is also in googleClientIds or consoleAudiences; a client is either shared or a scope's own` });
      }
    }
  });

/**
 * Why an RPC or API URL can't be used in env `envName`, or null: https everywhere; plain http only for a loopback host
 * in a `local*` env (a local sandbox). Over http anyone on the path answers every view, the pinned CKD key's fetch
 * included (OPER-1).
 */
export function endpointUrlProblem(value: string, envName: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLocalEnv(envName) && isLoopbackHost(url.hostname)) return null;
  return 'must be an https URL (http only for a loopback host in local* envs)';
}

/**
 * The API's NEAR RPC fallbacks, in order after `rpc` (D435): `apiRpcFallbacks`, or `rpcFallback` alone when that is
 * unset, or none. The API's gen writes them as `NEAR_RPC_FALLBACKS`.
 */
export function apiRpcFallbacksOf(m: Pick<Manifest, 'apiRpcFallbacks' | 'rpcFallback'>): string[] {
  if (m.apiRpcFallbacks) return [...m.apiRpcFallbacks];
  return m.rpcFallback ? [m.rpcFallback] : [];
}

/** The registrable domain of a URL, or null when it doesn't parse (endpointUrlProblem reports that). */
function safeSite(url: string): string | null {
  try {
    return siteOf(new URL(url).origin);
  } catch {
    return null;
  }
}

/**
 * A recorded CKD key source names distinct hosts on ≥ MIN_CKD_SOURCES registrable domains. (A key reset to a
 * placeholder by hand may leave a stale source; fetch-ckd-key rewrites both together, and the build refuses the
 * placeholder anyway.)
 */
function ckdSourceRules(source: { rpcs: string[] }, ctx: z.RefinementCtx): void {
  if (new Set(source.rpcs).size !== source.rpcs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ckdNetworkKeySource', 'rpcs'], message: 'ckdNetworkKeySource.rpcs must be distinct' });
  }
  const sites = new Set(source.rpcs.map((h) => siteOf(`https://${h}`)));
  if (sites.size < MIN_CKD_SOURCES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ckdNetworkKeySource', 'rpcs'],
      message: `ckdNetworkKeySource.rpcs must span at least ${MIN_CKD_SOURCES} providers (registrable domains), got ${sites.size}`,
    });
  }
}

interface GovernanceFields {
  name: string;
  network: string;
  signer: string;
  relayer: string;
  owner: string;
  ownerKind?: 'account' | 'sputnik' | undefined;
  council?: { factory: string; dao: string; members: string[] } | undefined;
  watchdogs?: string[] | undefined;
  allowSignerFullAccessKey?: boolean | undefined;
}

/**
 * Governance fields (docs/governance-spec.md): a council's DAO is `<one label>.<factory>`, its members are three
 * distinct accounts other than the env's own; `ownerKind: "sputnik"` means `owner` is the council's DAO; watchdogs are
 * distinct and none of the env's accounts; a signer full-access key is allowed only in a testnet dev env (D86).
 */
function governance(m: GovernanceFields, ctx: z.RefinementCtx): void {
  const own = new Set([m.signer, m.relayer]);
  if (m.council) {
    const { factory, dao, members } = m.council;
    const name = dao.endsWith(`.${factory}`) ? dao.slice(0, -factory.length - 1) : '';
    if (!name || name.includes('.')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['council', 'dao'], message: `council.dao must be <name>.${factory} (one label, created by the factory)` });
    }
    if (new Set(members).size !== members.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['council', 'members'], message: 'council.members must be distinct' });
    for (const a of members) {
      if (a === dao || own.has(a) || a === m.owner) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['council', 'members'], message: `council member ${a} must not be the DAO, the signer, the relayer or the owner` });
      }
    }
    if (own.has(dao)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['council', 'dao'], message: 'council.dao must not be the signer or the relayer' });
  }
  if (m.ownerKind === 'sputnik') {
    if (!m.council) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerKind'], message: 'ownerKind "sputnik" needs a council' });
    else if (m.owner !== m.council.dao) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['owner'], message: `ownerKind "sputnik": owner must be council.dao (${m.council.dao})` });
  }
  const watchdogs = m.watchdogs ?? [];
  if (new Set(watchdogs).size !== watchdogs.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdogs'], message: 'watchdogs must be distinct' });
  for (const w of watchdogs) {
    if (own.has(w) || w === m.owner || w === m.council?.dao || m.council?.members.includes(w)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdogs'], message: `watchdog ${w} must be its own account (not the signer, relayer, owner or a council account)` });
    }
  }
  // The network enum is testnet-only today; this keeps the rule when mainnet manifests become possible. The dev-env
  // rule is deploy-contract's (a schema refusal would break every fixture that renames sandbox-dev).
  if (m.allowSignerFullAccessKey && m.network !== 'testnet') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowSignerFullAccessKey'],
      message: 'allowSignerFullAccessKey is refused outside testnet: a mainnet signer never has a full-access key (D86)',
    });
  }
}

/**
 * `vaultOrigin`/`authOrigin`: both or neither, each a valid Hana origin for the env, distinct, never `apiUrl`'s origin,
 * and outside dev envs on different sites from each other and from `apiUrl` (the Hana origins host nothing else).
 */
function hanaOrigins(m: { name: string; apiUrl: string; vaultOrigin?: string | undefined; authOrigin?: string | undefined }, ctx: z.RefinementCtx): void {
  const { vaultOrigin, authOrigin } = m;
  if (vaultOrigin === undefined && authOrigin === undefined) return;
  if (vaultOrigin === undefined || authOrigin === undefined) {
    const missing = vaultOrigin === undefined ? 'vaultOrigin' : 'authOrigin';
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [missing], message: 'vaultOrigin and authOrigin are set together or not at all' });
    return;
  }
  let valid = true;
  for (const [field, origin] of [['vaultOrigin', vaultOrigin], ['authOrigin', authOrigin]] as const) {
    const problem = hanaOriginProblem(origin, m.name);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} ${problem}` });
      valid = false;
    }
  }
  if (!valid) return;
  // Popups authenticate the vault by origin and the vault authenticates the popups the same way: one origin for both
  // would let either page pose as the other.
  if (vaultOrigin === authOrigin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authOrigin'], message: 'vaultOrigin and authOrigin must be different origins' });
  } else if (!isDevEnv(m.name) && siteOf(vaultOrigin) === siteOf(authOrigin)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authOrigin'],
      message: `vaultOrigin and authOrigin must be different sites outside local*/sandbox* envs (both are ${siteOf(vaultOrigin)})`,
    });
  }
  // The partner-callable API on a Hana origin would be same-origin with the vault's storage or the token pages.
  let api: string | null = null;
  try {
    api = new URL(m.apiUrl).origin;
  } catch {
    return; // apiUrl's own check reports it
  }
  for (const [field, origin] of [['vaultOrigin', vaultOrigin], ['authOrigin', authOrigin]] as const) {
    if (origin === api) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must not be apiUrl's origin (${api})` });
    else if (!isDevEnv(m.name) && siteOf(origin) === siteOf(api)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be a different site from apiUrl outside local*/sandbox* envs (both are ${siteOf(api)})` });
    }
  }
}

export type Manifest = z.infer<typeof manifestSchema>;
