// The console Worker's bindings (docs/batch-c-spec.md "Bindings"; written by scripts/gen-wrangler.ts from the manifest's
// `console` and `files` blocks). Vars are public; the one secret (CONSOLE_GOOGLE_CLIENT_SECRET) comes with sign-in in
// batch C9.
import type { AppDetail, AppSummary, CancelChangeByLinkInput, GetAppInput, GuardedChange, ListAppsInput, PendingUpgradesInput, PendingUpgradesView, RpcFail, RpcOk, SetLogoInput } from '@hana-id/console-core';

type Answer<T extends object> = Promise<RpcOk<T> | RpcFail>;

/**
 * The API's `ConsoleRpc` entrypoint as the console calls it over the `API` service binding (apps/api/src/rpc/
 * console.ts). Only the methods the console calls so far; the binding's real-API test (test/api-binding.test.ts) runs
 * each against the API itself, so a drift between the two is a failing test, not a silent mismatch.
 */
export interface ConsoleRpcClient {
  listApps(c: ListAppsInput): Answer<{ apps: AppSummary[] }>;
  cancelChangeByLink(c: CancelChangeByLinkInput): Answer<{ change: GuardedChange }>;
  /** The logo upload (batch C11, logo.ts): the app's settings version and current logo, then the pointer. */
  getApp(c: GetAppInput): Answer<{ app: AppDetail }>;
  setLogo(c: SetLogoInput): Answer<{ version: number }>;
  /** The pending-upgrades page (batch C14, D86; governance.ts): contract-wide, charged to the member's org. */
  pendingUpgrades(c: PendingUpgradesInput): Answer<{ pendingUpgrades: PendingUpgradesView }>;
}

export interface Env {
  /** The manifest's `name`: the env every generic step-up action commits to, and the rate-limit key prefix. */
  ENV_NAME: string;
  /** `console.origin`: the only host this Worker serves, and the `Origin` every non-GET request must carry. */
  CONSOLE_ORIGIN: string;
  /** `console.authOrigin`: the thin console-auth Worker's origin (sign-in, batch C9). */
  CONSOLE_AUTH_ORIGIN: string;
  /** `files.origin`: partner logos, the CSP's only `img-src` besides `'self'` and `data:`. */
  FILES_ORIGIN: string;
  /** Read-only NEAR RPC and the signer account (the on-chain scope views, batch C10). */
  NEAR_RPC: string;
  SIGNER_ACCOUNT: string;
  /** Manifest `ownerGrantDelayMs` (D145): how long a new owner stays a viewer. Missing or out of range: grants refuse. */
  OWNER_GRANT_DELAY_MS?: string;
  CONSOLE_DB: D1Database;
  /** The API Worker's `ConsoleRpc` entrypoint (service binding; the console is its only caller). */
  API: Fetcher & ConsoleRpcClient;
  /** The SPA's static files (assets with `run_worker_first`: this Worker sees every request first). */
  ASSETS: Fetcher;
  /**
   * Partner logos: the console writes them (batch C11) and its hourly cron deletes replaced ones after 30 days.
   * Optional so a test or a config without R2 still runs; the cron then skips the logo purge.
   */
  LOGOS?: R2Bucket;
  /**
   * The Cloudflare Images binding (batch C11, D93): every uploaded logo is decoded and re-encoded through it to a
   * 256 × 256 PNG (logo.ts). Optional so a config without it still runs; uploads then answer `internal`.
   */
  IMAGES?: ImagesBinding;
  /** Monthly statements: read only by code (`get`/`head`; a source check forbids `put` and `delete`, D74). */
  STATEMENTS?: R2Bucket;
  /** Workers rate-limiting binding: per-IP flood limits of the session-less routes (limits.ts). */
  CONSOLE_IP_LIMIT: RateLimit;
}
