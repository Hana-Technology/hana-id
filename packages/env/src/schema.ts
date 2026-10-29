import { z } from 'zod';
import { hanaOriginProblem, isDevEnv, siteOf } from './origins.ts';

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

/** The watchdog is a different party from every account it watches, and a different Worker from the API. */
function watchdogRules(m: { signer: string; relayer: string; owner: string; mpc: string; cloudflare: { workerName: string } }, w: z.infer<typeof watchdogSchema>, ctx: z.RefinementCtx): void {
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
    rpc: z.string().url(),
    /**
     * Optional second NEAR RPC (https only, not `rpc` itself), from an independent provider. The vault and the export
     * window read from it only when `rpc` errors or times out (get_session re-syncs, registry views, tx polling), and
     * each read's answer comes from one endpoint. It joins `rpc` in those pages' CSP `connect-src`.
     */
    rpcFallback: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'rpcFallback must be an https URL')
      .optional(),
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
    hanaOrigins(m, ctx);
    if (m.watchdog) watchdogRules(m, m.watchdog, ctx);
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
