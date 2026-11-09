// The console Worker's bindings (docs/batch-c-spec.md "Bindings"; written by scripts/gen-wrangler.ts from the manifest's
// `console` and `files` blocks and `consoleAudiences`). Vars are public; the one secret is CONSOLE_GOOGLE_CLIENT_SECRET
// (sign-in's code exchange, batch C9; `wrangler secret put`, docs/operations.md setup step 11).
import type {
  ConsoleIssuerRpcClient,
  AppChange,
  AppDetail,
  AppSummary,
  CancelChangeByLinkInput,
  CancelChangeInput,
  ChangeOriginsInput,
  ConsoleProposeChangeInput,
  ConsoleSetSuspendedInput,
  CreateKeyInput,
  GetAppInput,
  GuardedChange,
  KeyView,
  LedgerInput,
  LedgerRow,
  ListAppsInput,
  ListChangesInput,
  OwnerActionInput,
  PendingUpgradesInput,
  PendingUpgradesView,
  RemoveOriginsInput,
  RevokeKeyInput,
  RotateKeyInput,
  RpcFail,
  RpcOk,
  SetLogoInput,
  StatementsInput,
  StatementWithTotals,
  TurnOffInput,
  UpdateSettingsInput,
  UsageInput,
  UsageRow,
} from '@hana-id/console-core';
import type { ConsoleUsersClient } from './users.ts';

type Answer<T extends object> = Promise<RpcOk<T> | RpcFail>;

/**
 * The API's `ConsoleRpc` entrypoint as the console calls it over the `API` service binding (apps/api/src/rpc/
 * console.ts). Only the methods the console calls so far; the binding's real-API test (test/api-binding.test.ts) runs
 * each against the API itself, so a drift between the two is a failing test, not a silent mismatch.
 */
export interface ConsoleRpcClient {
  listApps(c: ListAppsInput): Answer<{ apps: AppSummary[] }>;
  /** The app view (batch C9) and the logo upload's read of its settings version and current logo (batch C11). */
  getApp(c: GetAppInput): Answer<{ app: AppDetail }>;
  listChanges(c: ListChangesInput): Answer<{ changes: AppChange[] }>;
  cancelChangeByLink(c: CancelChangeByLinkInput): Answer<{ change: GuardedChange }>;
  /** The logo upload (batch C11, logo.ts): the pointer. */
  setLogo(c: SetLogoInput): Answer<{ version: number }>;
  // Batch C10: the write paths. Guarded changes carry the member's step-up token, which the API verifies itself.
  changeOrigins(c: ChangeOriginsInput): Answer<{ version: number; changes: GuardedChange[] }>;
  proposeChange(c: ConsoleProposeChangeInput): Answer<{ version: number; change: GuardedChange }>;
  removeOrigins(c: RemoveOriginsInput): Answer<{ version: number }>;
  turnOff(c: TurnOffInput): Answer<{ version: number }>;
  updateSettings(c: UpdateSettingsInput): Answer<{ version: number }>;
  cancelChange(c: CancelChangeInput): Answer<{ change: GuardedChange }>;
  setSuspended(c: ConsoleSetSuspendedInput): Answer<{ suspendedBy: number }>;
  createKey(c: CreateKeyInput): Answer<{ key: KeyView }>;
  rotateKey(c: RotateKeyInput): Answer<{ key: KeyView; oldKeyRevokedAt: number }>;
  revokeKey(c: RevokeKeyInput): Answer<object>;
  /** An on-chain owner action, relayed by the API's owner pool (`status` and the relay's answer once relayed). */
  ownerAction(c: OwnerActionInput): Answer<{ status: number; result?: unknown; nearTx?: string; code?: string; error?: string }>;
  /** The pending-upgrades page (batch C14, D86; governance.ts): contract-wide, charged to the member's org. */
  pendingUpgrades(c: PendingUpgradesInput): Answer<{ pendingUpgrades: PendingUpgradesView }>;
  /** Reports, statements and the ledger (batch C12, reports.ts): Neon only on the API side. */
  usage(c: UsageInput): Answer<{ rows: UsageRow[] }>;
  statements(c: StatementsInput): Answer<{ statements: StatementWithTotals[] }>;
  ledger(c: LedgerInput): Answer<{ rows: LedgerRow[]; next?: string; asOf: number }>;
}

export interface Env {
  /**
   * The email issuer's `ConsoleIssuerRpc` (build plan batch 9, D447): the Email login page's client proof and
   * deliverability. Absent on an env without an email issuer: the page says email isn't offered there.
   */
  ISSUER?: ConsoleIssuerRpcClient;
  /** The manifest's `name`: the env every generic step-up action commits to, and the rate-limit key prefix. */
  ENV_NAME: string;
  /** `console.origin`: the only host this Worker serves, and the `Origin` every non-GET request must carry. */
  CONSOLE_ORIGIN: string;
  /**
   * `console.authOrigin`: the thin console-auth Worker's origin. The only host `AuthHandler` answers for; the Google
   * client's only redirect URI is `<authOrigin>/callback`.
   */
  CONSOLE_AUTH_ORIGIN: string;
  /** The console's Google OAuth client (the manifest's one `google` entry of `consoleAudiences`): `client_id` and `aud`. */
  CONSOLE_GOOGLE_CLIENT_ID: string;
  /**
   * Secret: that client's secret, for the server-side code exchange. Missing: every callback answers 503 (fail closed);
   * nothing else needs it. Never logged.
   */
  CONSOLE_GOOGLE_CLIENT_SECRET?: string;
  /** `files.origin`: partner logos, the CSP's only `img-src` besides `'self'` and `data:`. */
  FILES_ORIGIN: string;
  /**
   * The build id (D406), served at `/.well-known/hana-build`: set only by `run deploy` (the shared wrapper's
   * `wrangler deploy --var HANA_BUILD:<id>`), never by `gen`. Absent or malformed: reported as null.
   */
  HANA_BUILD?: string;
  /** Read-only NEAR RPC and the signer account (the on-chain scope views, batch C10). */
  NEAR_RPC: string;
  SIGNER_ACCOUNT: string;
  /**
   * The manifest network and Hana's own origins (the API's `NETWORK` and `REFUSED_ORIGINS`): the console checks an
   * origin add against the same rules before it asks for a fresh sign-in (C10). Missing: the console only normalises,
   * and the API's own check (always made) answers `origin_refused` after the sign-in.
   */
  NETWORK?: string;
  REFUSED_ORIGINS?: string;
  /**
   * `"1"`: the partner Users screen (D310) is on. Off until the wallet directory's ConsoleRpc reads
   * (`listUsers`, `getUser`, branch `feat/wallet-directory`) are on `develop` and deployed (D357).
   */
  USERS_SCREEN?: string;
  /** Manifest `ownerGrantDelayMs` (D145): how long a new owner stays a viewer. Missing or out of range: grants refuse. */
  OWNER_GRANT_DELAY_MS?: string;
  CONSOLE_DB: D1Database;
  /** The API Worker's `ConsoleRpc` entrypoint (service binding; the console is its only caller). */
  API: Fetcher & ConsoleRpcClient & Partial<ConsoleUsersClient>;
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
