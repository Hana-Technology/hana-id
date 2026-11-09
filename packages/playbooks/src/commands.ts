// Commands the playbooks repeat, exactly as docs/operations.md and the scripts' usage lines give them. Placeholders
// in angle brackets (`<env>`, `<signer>`, `<apiUrl>`, …) come from envs/<env>.json; never a hard-coded account.
// The package test checks every `scripts` command and flag against the scripts' sources.

const SCRIPTS = 'corepack pnpm --filter @hana-id/scripts run';

/**
 * An owner-only call through the manifest's owner (`admin owner:call`): signed by the owner account, or a 2-of-3
 * council proposal (dev envs: add `--approve-with <second member>` to approve it in the same command; elsewhere each
 * member signs the printed `act_proposal` command).
 */
export const ownerCall = (method: string, args?: string): string => `${SCRIPTS} admin <env> owner:call ${method}${args ? ` --args '${args}'` : ''} --yes`;

export const governanceStatus = `${SCRIPTS} admin <env> governance:status`;
export const ownerProposals = `${SCRIPTS} admin <env> owner:proposals`;
export const ownerVote = `${SCRIPTS} admin <env> owner:vote <proposal id> --member <member> --yes`;
/** A `VoteReject` (dev envs: key from .secrets; elsewhere the member's own key). Two rejections close a proposal. */
export const ownerVoteReject = `${SCRIPTS} admin <env> owner:vote <proposal id> --member <member> --reject --yes`;
/**
 * Replace a council member (`docs/operations.md` "Replacing a council member"): RemoveMemberFromRole, then
 * AddMemberToRole. Dev envs add `--approve-with <second member>`; elsewhere it proposes and prints each member's vote.
 */
export const councilReplaceMemberPlan = `${SCRIPTS} admin <env> council:replace-member --remove <old member> --add <new member> --member <member>`;
export const councilReplaceMember = `${SCRIPTS} admin <env> council:replace-member --remove <old member> --add <new member> --member <member> --yes`;
export const deployContractPlan = `${SCRIPTS} deploy-contract <env>`;
export const deployContract = `${SCRIPTS} deploy-contract <env> --yes`;
export const upgradePropose = `${SCRIPTS} deploy-contract <env> --upgrade --yes`;
export const upgradeExecute = `${SCRIPTS} deploy-contract <env> --upgrade --skip-build --yes`;
export const postGoogleKeysDry = `${SCRIPTS} post-google-keys <env> --dry-run`;
export const postGoogleKeys = `${SCRIPTS} post-google-keys <env>`;
export const postGoogleKeysExecute = `${SCRIPTS} post-google-keys <env> --execute`;
export const vaultKekRotate = `${SCRIPTS} vault-kek <env> rotate --yes`;
/** The identity token's signing keys (`docs/operations.md` "Identity token keys", D177). */
export const identityKeyShow = `${SCRIPTS} identity-key <env> show`;
export const identityKeyNext = `${SCRIPTS} identity-key <env> next --yes`;
export const identityKeySwitchStandby = `${SCRIPTS} identity-key <env> switch --to standby --yes`;
export const identityKeySwitchNext = `${SCRIPTS} identity-key <env> switch --to next --yes`;
export const identityKeyRetirePrevious = `${SCRIPTS} identity-key <env> retire --key previous --yes`;
export const identityKeyRetireStandby = `${SCRIPTS} identity-key <env> retire --key standby --yes`;
/** The outside probe of the identity JWKS and discovery document (`scripts/identity-probe.ts`, D210): from outside Cloudflare. */
export const identityProbe = `${SCRIPTS} identity-probe <env>`;
/** The identity token's AWS KMS signer (`docs/operations.md` "Identity token keys on AWS KMS", D215, D219). */
export const identityKmsSwitchStandby = `${SCRIPTS} identity-key <env> kms-switch --to standby --yes`;
export const identityKmsRetirePrevious = `${SCRIPTS} identity-key <env> kms-retire --key previous --yes`;
export const identityKmsAddStandby = `${SCRIPTS} identity-key <env> kms-add --role standby --key <get-public-key.json> --yes`;
export const identityKmsPutAwsKey = `${SCRIPTS} identity-key <env> kms-put-aws-key --yes`;
export const vaultKekPut = `${SCRIPTS} vault-kek <env> put --yes`;
export const appList = `${SCRIPTS} admin <env> app:list --remote`;
export const appSettings = `${SCRIPTS} admin <env> app:settings <app id | publishable key> --remote`;
export const appSuspend = `${SCRIPTS} admin <env> app:suspend --app <app id | publishable key> --remote`;
export const appResume = `${SCRIPTS} admin <env> app:resume --app <app id | publishable key> --remote`;
export const appOriginsRemove = `${SCRIPTS} admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> --remote`;
export const fetchCkdKeyDry = `${SCRIPTS} fetch-ckd-key <env> --dry-run`;

/** The API's public governance snapshot (`docs/api.md` "GET /v1/governance"). */
export const apiGovernance = "curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'";
export const apiGovernanceUpdater = "curl -s <apiUrl>/v1/governance | jq '.updater'";
export const apiGovernancePending = "curl -s <apiUrl>/v1/governance | jq '{paused, delays, keyChanges, pendingUpgrade, pendingOwner, pendingWithdrawal}'";
export const apiHealth = 'curl -s https://<worker-url>/v1/health';

const WATCHDOG_AUTH = 'curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)"';
const WATCHDOG_URL = 'https://<workerName>.<subdomain>.workers.dev';
/** The watchdog's read-only status (`apps/watchdog/README.md` "Status endpoint"). */
export const watchdogStatus = `${WATCHDOG_AUTH} ${WATCHDOG_URL}/status`;
export const watchdogAlerts = `${WATCHDOG_AUTH} '${WATCHDOG_URL}/alerts?severity=critical'`;
export const watchdogActions = `${WATCHDOG_AUTH} ${WATCHDOG_URL}/actions`;
export const watchdogSecretsInit = 'corepack pnpm --filter @hana-id/watchdog secrets <env> init';
export const watchdogSecretsCheck = 'corepack pnpm --filter @hana-id/watchdog secrets <env> check';
export const watchdogGen = 'corepack pnpm --filter @hana-id/watchdog gen <env>';
export const watchdogSecretBulk = 'corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json';
export const watchdogDeploy = 'corepack pnpm --filter @hana-id/watchdog run deploy';

/** Updater key rotation (`docs/operations.md` "Keys-updater key"): the old file aside, a new key through the owner. */
export const moveUpdaterKeyAside = 'mv .secrets/<env>/keys-updater.json .secrets/<env>/keys-updater.revoked-<yyyymmdd>.json';
/** `docs/operations.md` "Create an environment" step 7 (from the repo root, with apps/api/wrangler.jsonc for <env>). */
export const uploadUpdaterKey =
  'node -e \'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)\' | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY';
export const uploadRelayerKeys =
  'node -e \'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))\' | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS';
export const uploadOwnerRelayerKeys =
  'node -e \'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))\' | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS';

export const apiGen = 'corepack pnpm --filter @hana-id/api run gen <env>';
export const apiDeploy = 'corepack pnpm --filter @hana-id/api run deploy';
export const webBuild = 'corepack pnpm --filter @hana-id/web build';
export const pagesDeploy = 'corepack pnpm --filter @hana-id/api run deploy:pages';
export const apiTailErrors = 'corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error';
export const apiTail = 'corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format pretty';
/** The API's RPC failovers (D435): `near_rpc_failover` lines name the endpoint indexes and the reason, never a URL. */
export const apiTailRpcFailover = 'corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --search near_rpc_failover';
export const d1Migrate = 'corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote';

/** D1 Time Travel (`docs/operations.md` "Restoring a D1 database (Time Travel)"): the API's `DB`. */
export const apiD1Bookmark = 'corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name>';
export const apiD1BookmarkAt = 'corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>';
export const apiD1Export = 'corepack pnpm --dir apps/api exec wrangler d1 export <cloudflare.d1Name> --remote --output=../../.secrets/<env>/d1-before-restore-<yyyymmdd>.sql';
export const apiD1Restore = 'corepack pnpm --dir apps/api exec wrangler d1 time-travel restore <cloudflare.d1Name> --bookmark=<bookmark>';
/** The same for the watchdog's D1, from apps/watchdog on the watchdog's Cloudflare account. */
export const watchdogD1Bookmark = 'corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name>';
export const watchdogD1BookmarkAt = 'corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>';
export const watchdogD1Restore = 'corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel restore <watchdog.cloudflare.d1Name> --bookmark=<bookmark>';

/** Revoke every live vault share (`docs/operations.md` "`VAULT_KEK`", KEK compromised). */
export const revokeAllShares =
  "corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command \"UPDATE vault_shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE revoked_at IS NULL\"";
export const countOldKekRows =
  'corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = <old id>"';
export const deletePreviousKek = 'corepack pnpm --dir apps/api exec wrangler secret delete VAULT_KEK_PREVIOUS --name <cloudflare.workerName>';

/** Fund the relayer account (`docs/operations.md` "Relayer keys (either pool)"); testnet only. */
export const fundRelayer = "near tokens <funded testnet account> send-near <relayer> '<amount> NEAR' network-config testnet sign-with-legacy-keychain send";
export const deleteRelayerKey = 'near account delete-keys <relayer> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send';
export const deleteWatchdogKey = 'near account delete-keys <watchdog.account> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send';
export const executeIssuerKeyChange =
  "near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{\"id\":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send";
