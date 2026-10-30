import { z } from 'zod';
import { adminSchema, consoleSchema, dashboardRules, delayMs, emailSchema, filesSchema, usageSchema } from './dashboard.ts';
import { hanaOriginProblem, isDevEnv, isLocalEnv, isLoopbackHost, siteOf } from './origins.ts';

/** Independent RPC providers the pinned CKD network key must be read from, all agreeing (OPER-1, D100). */
export const MIN_CKD_SOURCES = 3;

const nearAccount = z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u, 'Invalid NEAR account id');

/** Cloudflare Durable Object location hints (https://developers.cloudflare.com/durable-objects/reference/data-location/). */
export const DO_LOCATION_HINTS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'] as const;

const clientId = z.string().min(1).max(255).regex(/^\S+$/u, 'Client IDs contain no whitespace');

/** Paging apps the watchdog can page through (D85: chosen at setup). */
export const PAGER_PROVIDERS = ['ntfy', 'pushover', 'pagerduty'] as const;

const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, 'A Worker name is 1-63 lowercase letters, digits and inner hyphens');

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
  /** Who gets warning and critical emails and the daily digest: both founders (D85). */
  alertEmails: z.array(z.string().email()).min(1).max(10),
  /** Sender address on the dedicated sending subdomain (D87). */
  alertFrom: z.string().email(),
  /** The paging app for critical alerts (D85). Its credentials are Worker secrets. */
  pager: z.enum(PAGER_PROVIDERS),
  /** Hour (UTC, 0-23) after which the daily info digest is sent; default 0. */
  digestHourUtc: z.number().int().min(0).max(23).optional(),
});

/**
 * The watchdog is a different party from every account it watches, and a different Worker from the API. Its account
 * is one of the contract's `watchdogs`, so `deploy-contract` adds it on chain (`add_watchdog`); a watchdog service
 * whose account the contract doesn't know can't cancel or pause anything.
 */
function watchdogRules(
  m: { signer: string; relayer: string; owner: string; mpc: string; watchdogs?: string[] | undefined; cloudflare: { workerName: string } },
  w: z.infer<typeof watchdogSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!(m.watchdogs ?? []).includes(w.account)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'account'], message: `watchdog.account ${w.account} must be listed in watchdogs (the contract's watchdog accounts)` });
  }
  for (const field of ['signer', 'relayer', 'owner', 'mpc'] as const) {
    if (w.account === m[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'account'], message: `watchdog.account must not be the ${field} account` });
  }
  if (w.cloudflare.workerName === m.cloudflare.workerName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'cloudflare', 'workerName'], message: "watchdog.cloudflare.workerName must differ from the API's Worker name" });
  }
  if (new Set(w.alertEmails).size !== w.alertEmails.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['watchdog', 'alertEmails'], message: 'Duplicate alert email' });
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
    rpc: z.string().url(),
    /**
     * Optional second NEAR RPC (https, not `rpc` itself), from an independent provider. The vault and the export
     * window read from it only when `rpc` errors or times out (get_session re-syncs, registry views, tx polling), and
     * each read's answer comes from one endpoint. It joins `rpc` in those pages' CSP `connect-src`.
     */
    rpcFallback: z.string().url().optional(),
    /** The API's base URL: https outside `local*` envs (there, http only for a loopback host). */
    apiUrl: z.string().url(),
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
     * `issuer_key_delay_ms` for `new` / `migrate_v1` (contract allows 0..7 days; D80). deploy-contract refuses less
     * than the security bound 3·(W + T) = 18 min outside dev envs (`delays.ts` `governanceDelayProblems`).
     */
    issuerKeyDelayMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
    /**
     * `governance_delay_ms` for `new` / `migrate_v1` (contract allows 0..30 days; D80). deploy-contract refuses less
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
  })
  .superRefine((m, ctx) => {
    for (const field of ['rpc', 'rpcFallback', 'apiUrl'] as const) {
      const value = m[field];
      const problem = value === undefined ? null : endpointUrlProblem(value, m.name);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} ${problem}` });
    }
    if (m.ckdNetworkKeySource) ckdSourceRules(m.ckdNetworkKeySource, ctx);
    hanaOrigins(m, ctx);
    if (m.watchdog) watchdogRules(m, m.watchdog, ctx);
    governance(m, ctx);
    dashboardRules(m, ctx);
    if (m.rpcFallback !== undefined && m.rpcFallback === m.rpc) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rpcFallback'], message: 'rpcFallback must be a different endpoint from rpc' });
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
