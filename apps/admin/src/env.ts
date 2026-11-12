// The admin Worker's bindings (docs/batch-c-spec.md "Bindings"; written by scripts/gen-wrangler.ts from the manifest's
// dashboard blocks). Vars are public. The four secrets (EMAIL_API_KEY, CANCEL_LINK_KEY, INVITE_LINK_KEY and, from C14,
// WATCHDOG_STATUS_TOKEN) are set with `wrangler secret put` from `.secrets/<env>/` (docs/operations.md "Admin Worker");
// each is optional in the type so a missing one fails closed at the step that needs it (no notice is acked, no email
// leaves, the watchdog shows as not configured) instead of at start-up.
import type {
  LinkStatsRow,
  ApiPurgeAuditResult,
  ApiSystemStatus,
  ConsoleHealth,
  AppNameView,
  ProfileNameRow,
  DirectoryRpcClient,
  AppChange,
  AuditRow,
  ConsolePurgeAuditResult,
  DeletedAppsResult,
  GuardedChange,
  InviteView,
  MemberNotice,
  MemberView,
  OrgView,
  OwnerGrantView,
  PendingUpgradesView,
  PurgeDirectoryResult,
  PurgeUserEventsResult,
  RpcFail,
  RpcOk,
  ScopeRow,
  SecurityEvent,
  StaffUser,
  SupportLookupResult,
  UserShare,
} from '@hana-id/console-core';

export type Answer<T extends object> = Promise<RpcOk<T> | RpcFail>;
/** A pass-through answer: the BFF hands it to the SPA as it came. */
export type Loose = Answer<Record<string, unknown>>;

/** One blocking notice of `AdminRpc.pendingNotices` (apps/api/src/changes/lifecycle.ts `Notice`, D226). */
export interface ChangeNotice {
  change: GuardedChange;
  contacts: string[];
  app: { id: string; name: string; orgId: string; scopeId: string; environment: 'test' | 'live' };
  policy?: unknown;
}

/** One app's origins as `AdminRpc.getApp` describes them (the fields the watcher's SetAllowShared notice reads). */
export interface AppOriginsView {
  id: string;
  name: string;
  scopeId: string;
  origins: { origin: string; display: string; idn: boolean; activeFrom: number | null }[];
}

/**
 * The API's `AdminRpc` entrypoint as the admin Worker calls it over the `API` service binding (apps/api/src/rpc/
 * admin.ts). Inputs are console-core's schemas; the API validates every call. The test suite runs against the real
 * API Worker, so a drift between the two is a failing test.
 */
export interface AdminRpcClient {
  listApps(c: unknown): Answer<{ apps: { id: string; name: string; scopeId: string; [k: string]: unknown }[] }>;
  getApp(c: unknown): Answer<{ app: AppOriginsView & Record<string, unknown> }>;
  listChanges(c: unknown): Answer<{ changes: AppChange[] }>;
  removeOrigins(c: unknown): Loose;
  turnOff(c: unknown): Loose;
  /** The mainnet demo exception to D39 (D428): a test app in a dev testnet env only. */
  setMainnetDemo(c: unknown): Loose;
  cancelChange(c: unknown): Loose;
  revokeKey(c: unknown): Loose;
  createApp(c: unknown): Loose;
  assignScopeOrg(c: unknown): Loose;
  deleteApp(c: unknown): Loose;
  setSuspended(c: unknown): Loose;
  suspendOrg(c: unknown): Loose;
  addOrigins(c: unknown): Loose;
  proposeChange(c: unknown): Loose;
  expediteChange(c: unknown): Loose;
  pendingNotices(c: unknown): Answer<{ notices: ChangeNotice[] }>;
  ackNotice(c: unknown): Answer<{ change: GuardedChange }>;
  setSecurityContacts(c: unknown): Answer<{ emails: string[] }>;
  getSecurityContacts(c: unknown): Answer<{ emails: string[] }>;
  listScopes(c: unknown): Answer<{ scopes: ScopeRow[]; next?: string }>;
  changesSince(c: unknown): Answer<{ changes: AppChange[] }>;
  securityEvents(c: unknown): Answer<{ events: SecurityEvent[] }>;
  markSecurityEventNotified(c: unknown): Answer<Record<string, never>>;
  /** Every relayer pool's public keys, the Home pool's included (settlement and the nonce check, C12; readiness 7.4a). */
  relayerKeys(c: unknown): Answer<{ keys: { pool: 'session' | 'owner' | 'home'; publicKey: string }[]; /** Whether the API writes usage events; absent from an older API. */ capture?: boolean; /** Pools whose keys couldn't be listed; absent from an older API. */ unreadablePools?: string[] }>;
  /** The `GET /v1/governance` snapshot (batch C14): the API's normalised chain views, JWKS verdicts and cron state. */
  governance(c: unknown): Answer<{ governance: Record<string, unknown> }>;
  /** The pending-upgrades page's view (D86), the same one partners get from ConsoleRpc. */
  pendingUpgrades(c: unknown): Answer<{ pendingUpgrades: PendingUpgradesView }>;
  /** Retention (C13, the monthly job, a system actor): app_changes and guarded_changes past 60 months. */
  purgeAudit(c: unknown): Answer<ApiPurgeAuditResult>;
  /** The System status page (D425): the API's build, hot DB, crons, notice backlog, pool keys and governance. */
  systemStatus(c: unknown): Answer<ApiSystemStatus>;
  /** Apps deleted 30 days ago or more, for the ledger's app_users purge. */
  deletedApps(c: unknown): Answer<DeletedAppsResult>;
  /** The wallet directory of scopes whose every app was deleted 30 days ago or more. */
  purgeDirectory(c: unknown): Answer<PurgeDirectoryResult>;
  /** user_events (migration 0013) past 24 months, and those of scopes left without apps (readiness 7.17). */
  purgeUserEvents(c: unknown): Answer<PurgeUserEventsResult>;
  /** The wallet directory (D310, D315, D346): users with their three ids, identities (with subs) and wallets. */
  listUsers(c: unknown): Answer<{ users: StaffUser[]; nextCursor: string | null }>;
  getUser(c: unknown): Answer<{ user: StaffUser }>;
  /** By wallet address, User ID, internal id, Support ID or sub (`provider` makes it a sub search). */
  findUsers(c: unknown): Answer<{ users: StaffUser[] }>;
  /** The Users screen's app labels (C8b): names, orgs, scopes, environments of up to 50 app ids. */
  appNames(c: unknown): Answer<{ apps: AppNameView[] }>;
  /** The Users screen's names (D714): the Hana Home names of up to 50 sign-in identities `{provider, sub}`; ones with no name left out. */
  profileNames(c: unknown): Answer<{ names: ProfileNameRow[] }>;
  /** The links view's counts (batch 9, D445): per app and day, the cron's jump check too. */
  linkStats(c: unknown): Answer<{ rows: LinkStatsRow[] }>;
  /** The Support ID lookup's hot-DB part (C15, staff only): matches, their apps, shares and the apps' changes. */
  supportLookup(c: unknown): Answer<SupportLookupResult>;
  /** The vault shares of one path in one app that haven't expired (C15). */
  userShares(c: unknown): Answer<{ shares: UserShare[] }>;
}

/** The console's `StaffRpc` entrypoint (apps/console/src/staff-rpc.ts) over the `CONSOLE` service binding. */
export interface StaffRpcClient {
  listOrgs(c: unknown): Answer<{ orgs: OrgView[]; next?: string }>;
  getOrg(c: unknown): Answer<{ org: OrgView; members: MemberView[]; invites: InviteView[]; grants?: OwnerGrantView[] }>;
  issueInvite(c: unknown): Answer<{ invite: InviteView }>;
  revokeInvite(c: unknown): Loose;
  /** The Organisations page's "Pending invites" (D696): invites to organisations not created yet, open and recently ended. */
  newOrgInvites(c: unknown): Answer<{ invites: InviteView[]; truncated: boolean }>;
  pendingMemberNotices(c: unknown): Answer<{ notices: MemberNotice[] }>;
  ackMemberNotice(c: unknown): Answer<Record<string, never>>;
  cancelOwnerGrant(c: unknown): Loose;
  listMembers(c: unknown): Answer<{ members: MemberView[] }>;
  setMember(c: unknown): Loose;
  disableUser(c: unknown): Loose;
  freezeOrg(c: unknown): Loose;
  auditSince(c: unknown): Answer<{ rows: AuditRow[] }>;
  queryAudit(c: unknown): Answer<{ rows: AuditRow[]; next?: string }>;
  /** The audit row of a statement issued, a ledger export or a rate override (C12, D327). */
  recordStaffAction(c: unknown): Answer<Record<string, never>>;
  /** Retention (C13, the monthly job, a system actor): audit_log rows and closed owner grants past 60 months. */
  purgeAudit(c: unknown): Answer<ConsolePurgeAuditResult>;
  /** The System status page (D425): the console's build, D1, hourly cron, member-notice backlog and LOGOS. */
  health(c: unknown): Answer<ConsoleHealth>;
}

import { MAIL_LABELS as LABELS } from './labels.ts';

export interface Env {
  /** The manifest's `name` (in subjects and log lines). */
  ENV_NAME: string;
  /**
   * The label every email subject starts with on a non-production env (`[SANDBOX]`, `[STAGING]`, `[LOCAL]`,
   * `[TESTNET]`; D419), written by `gen` from the manifest (`@hana-id/env` `envAlertLabel`). `mailLabel` uses it only
   * with `NEAR_NETWORK` `testnet`.
   */
  ENV_LABEL?: string;
  /** `admin.origin`: the only host this Worker serves, and the `Origin` every non-GET request must carry. */
  ADMIN_ORIGIN: string;
  /** `console.origin`: the only origin an email links to (cancel pages, invite links). */
  CONSOLE_ORIGIN: string;
  /** `files.origin`: partner logos, the CSP's only `img-src` besides `'self'` and `data:`. */
  FILES_ORIGIN: string;
  /**
   * The build id (D406): set only by `run deploy` (the shared wrapper's `wrangler deploy --var HANA_BUILD:<id>`), never
   * by `gen`. No route serves it (the whole origin is behind Cloudflare Access): `deploy-check` reads it from the
   * deployed version's metadata (`wrangler versions view`). Nothing in the Worker reads it.
   */
  HANA_BUILD?: string;
  /** Read-only NEAR RPC and the signer account: `get_scope` for the on-chain watcher. */
  NEAR_RPC: string;
  /**
   * The System status page (D425; all public, written by `gen` from the manifest; each absent one's tile is "not
   * configured"): the manifest's `rpcFallback` and `apiRpcFallbacksOf` (NEAR_RPC_FALLBACKS, a JSON array: the API's
   * backups, D435; both probed beside NEAR_RPC, none shown on the page), `apiUrl`, `vaultOrigin`, `authOrigin`, the
   * email issuer's URL and `console.authOrigin`, whose public build reads the page makes (as `deploy-check` does).
   */
  NEAR_RPC_FALLBACK?: string;
  NEAR_RPC_FALLBACKS?: string;
  API_URL?: string;
  VAULT_ORIGIN?: string;
  AUTH_ORIGIN?: string;
  EMAIL_ISSUER_URL?: string;
  /** The issuer's signer kind (manifest `emailIssuer.signer.kind`) and the watchdog's pins, JSON (the Email issuer page, D448). */
  EMAIL_SIGNER_KIND?: string;
  EMAIL_PINNED_KEYS?: string;
  CONSOLE_AUTH_ORIGIN?: string;
  /**
   * JSON `[{worker, crons}]`: the cron triggers the manifest puts on this Worker's Cloudflare account (the API, the
   * console, this Worker and, when it shares the account, the watchdog; D417), against the Free plan's 5 per account.
   * Counted by `gen`, not read from Cloudflare.
   */
  ACCOUNT_CRONS?: string;
  SIGNER_ACCOUNT: string;
  /**
   * The relayer account whose pool keys sign every relay (C12): settlement checks each transaction's signer against it
   * and the nonce check reads its keys. Missing: settlement and the nonce check don't run (logged every run).
   */
  RELAYER_ACCOUNT?: string;
  /** Cloudflare Access (D88): the team domain (`<team>.cloudflareaccess.com`) and the application's AUD tag. */
  ACCESS_TEAM_DOMAIN: string;
  /** 64 hex characters; `UNSET` (the manifest's value before the application exists) refuses every /api/* request. */
  ACCESS_AUD: string;
  /** JSON array of lowercased emails: the manifest's `admin.staffEmails`, checked behind the Access policy. */
  STAFF_EMAILS: string;
  /** `email.from` and `email.securityAlias`. */
  EMAIL_FROM: string;
  SECURITY_ALIAS: string;
  /** Manifest `appChangeDelayMs` and `ownerGrantDelayMs`: only the notices' wording ("takes effect about … after"). */
  APP_CHANGE_DELAY_MS: string;
  OWNER_GRANT_DELAY_MS: string;
  /**
   * The admin Worker's own SendGrid API key, restricted to Mail Send (D87, D401): only this Worker holds it. Missing:
   * no email leaves, so no blocking notice is acked.
   */
  EMAIL_API_KEY?: string;
  /** 32 bytes, base64: the guarded-change cancel links and the owner-grant cancel links (spec "Nonce layouts"). */
  CANCEL_LINK_KEY?: string;
  /** 32 bytes, base64: the invite links. */
  INVITE_LINK_KEY?: string;
  /**
   * The watchdog Worker's https origin (manifest `watchdog.url`, batch C14): the "Security & monitoring" view reads its
   * `/status`, `/alerts` and `/actions` and forwards acks to it. Absent or malformed: the view shows the watchdog as not
   * configured (the governance part still renders).
   */
  WATCHDOG_URL?: string;
  /**
   * NEAR network (`testnet`/`mainnet`): the explorer links of the watchdog's transactions (C14), and a statement's
   * network (C12: on a test network it is labelled as valued at the mainnet price, D93; issuing refuses without it).
   */
  NEAR_NETWORK?: string;
  /**
   * What the organisation page's "Register a scope" panel needs to write the exact `admin <env> scope:register` command
   * (D651): JSON `{ownerKind, owner, councilMembers, devCouncilKeys, sharedClientIds}` from the manifest (all public;
   * `devCouncilKeys`: a dev env on testnet, where the council's keys are in `.secrets/` and one command casts both
   * votes). The Worker only reads it into `GET /api/me`; nothing here sends a transaction. Absent or malformed: the
   * panel says the command can't be prepared until `gen` has run.
   */
  SCOPE_REGISTRATION?: string;
  /**
   * The watchdog status endpoint's bearer token (≥ 32 characters; the watchdog holds the other copy, D83). Secret: sent
   * only in the `Authorization` header of this Worker's calls to WATCHDOG_URL, never logged, never in a response.
   */
  WATCHDOG_STATUS_TOKEN?: string;
  /** The API Worker's `AdminRpc` (the admin Worker is its only caller). */
  API: Fetcher & AdminRpcClient;
  /** The console Worker's `StaffRpc` (the admin Worker is its only caller). */
  CONSOLE: Fetcher & StaffRpcClient;
  /**
   * The usage ledger through Hyperdrive (role `usage_admin`): the feed's cursors and the watcher's state in `ops`.
   * Optional: without it the feed and the watcher don't run (logged every run); the blocking notices and the staff
   * screens don't need it.
   */
  USAGE_DB?: Hyperdrive;
  /**
   * Monthly statements (C12): the admin writes each statement's CSV and PDF under new keys (`put` only; a whole-bucket
   * lock keeps them 7 years, D308) and serves them to staff. Optional so a config without R2 runs: issuing refuses.
   */
  STATEMENTS?: R2Bucket;
  /** On-demand ledger exports under `exports/` (the 30-day lifecycle rule, D308). Optional: exports refuse without it. */
  EXPORTS?: R2Bucket;
  /** CoinGecko's demo API key for the daily rate (optional; sent as a header, never logged). */
  COINGECKO_API_KEY?: string;
  /**
   * The email issuer's `DirectoryRpc` (D275, C8b): the user directory's read path for the Users screen. Each call
   * carries the staff request's Access JWT, which the issuer verifies itself. Optional: an env without an email issuer
   * has no directory, and the Users screen answers `directory_unavailable`.
   */
  ISSUER?: Fetcher & DirectoryRpcClient;
  /** The SPA's static files (assets with `run_worker_first`). */
  ASSETS: Fetcher;
}

export { MAIL_LABELS } from './labels.ts';

/**
 * The label of this env's email subjects (D419): `ENV_LABEL` when it is one of the labels and the network is testnet;
 * none otherwise, so production mail never carries one, whatever a config says.
 */
export function mailLabel(env: Pick<Env, 'ENV_LABEL' | 'NEAR_NETWORK'>): string {
  return env.NEAR_NETWORK === 'testnet' && env.ENV_LABEL !== undefined && (LABELS as readonly string[]).includes(env.ENV_LABEL) ? env.ENV_LABEL : '';
}
