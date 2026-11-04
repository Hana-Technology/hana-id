// The admin Worker's bindings (docs/batch-c-spec.md "Bindings"; written by scripts/gen-wrangler.ts from the manifest's
// dashboard blocks). Vars are public. The four secrets (EMAIL_API_KEY, CANCEL_LINK_KEY, INVITE_LINK_KEY and, from C14,
// WATCHDOG_STATUS_TOKEN) are set with `wrangler secret put` from `.secrets/<env>/` (docs/operations.md "Admin Worker");
// each is optional in the type so a missing one fails closed at the step that needs it (no notice is acked, no email
// leaves, the watchdog shows as not configured) instead of at start-up.
import type {
  AppChange,
  AuditRow,
  GuardedChange,
  InviteView,
  MemberNotice,
  MemberView,
  OrgView,
  OwnerGrantView,
  PendingUpgradesView,
  RpcFail,
  RpcOk,
  ScopeRow,
  SecurityEvent,
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
  /** The `GET /v1/governance` snapshot (batch C14): the API's normalised chain views, JWKS verdicts and cron state. */
  governance(c: unknown): Answer<{ governance: Record<string, unknown> }>;
  /** The pending-upgrades page's view (D86), the same one partners get from ConsoleRpc. */
  pendingUpgrades(c: unknown): Answer<{ pendingUpgrades: PendingUpgradesView }>;
}

/** The console's `StaffRpc` entrypoint (apps/console/src/staff-rpc.ts) over the `CONSOLE` service binding. */
export interface StaffRpcClient {
  listOrgs(c: unknown): Answer<{ orgs: OrgView[]; next?: string }>;
  getOrg(c: unknown): Answer<{ org: OrgView; members: MemberView[]; invites: InviteView[]; grants?: OwnerGrantView[] }>;
  issueInvite(c: unknown): Answer<{ invite: InviteView }>;
  revokeInvite(c: unknown): Loose;
  pendingMemberNotices(c: unknown): Answer<{ notices: MemberNotice[] }>;
  ackMemberNotice(c: unknown): Answer<Record<string, never>>;
  cancelOwnerGrant(c: unknown): Loose;
  listMembers(c: unknown): Answer<{ members: MemberView[] }>;
  setMember(c: unknown): Loose;
  disableUser(c: unknown): Loose;
  freezeOrg(c: unknown): Loose;
  auditSince(c: unknown): Answer<{ rows: AuditRow[] }>;
  queryAudit(c: unknown): Answer<{ rows: AuditRow[]; next?: string }>;
}

export interface Env {
  /** The manifest's `name` (in subjects and log lines). */
  ENV_NAME: string;
  /** `admin.origin`: the only host this Worker serves, and the `Origin` every non-GET request must carry. */
  ADMIN_ORIGIN: string;
  /** `console.origin`: the only origin an email links to (cancel pages, invite links). */
  CONSOLE_ORIGIN: string;
  /** `files.origin`: partner logos, the CSP's only `img-src` besides `'self'` and `data:`. */
  FILES_ORIGIN: string;
  /** Read-only NEAR RPC and the signer account: `get_scope` for the on-chain watcher. */
  NEAR_RPC: string;
  SIGNER_ACCOUNT: string;
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
  /** Resend's API key (D87): only this Worker holds one. Missing: no email leaves, so no blocking notice is acked. */
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
  /** NEAR network (`testnet`/`mainnet`): the explorer links of the watchdog's transactions. */
  NEAR_NETWORK?: string;
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
  /** The SPA's static files (assets with `run_worker_first`). */
  ASSETS: Fetcher;
}
