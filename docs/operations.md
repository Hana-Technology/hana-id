# Operations runbook — running a Hana ID environment (testnet only)

Last verified against code: 2026-11-02 (branch `feat/identity-token-7`: "Identity token keys on AWS KMS", the KMS
signer's setup steps, IAM and key policies, alarms, rotations and the planned reconciliation, the `identity-key kms-*`
commands, the AWS access key row in "Secrets: where they live", D215–D219); 2026-11-02 (branch `docs/consistency-pass`: "Watchdog service" channels, "Owner
council" verified on testnet, the `create_session_and_derive` gas pointer); 2026-11-02 (branch `feat/batch-c-3`: "Hot DB migration 0006 and the new gate" (milestone
M1, for the user to run), the admin CLI's `app:*` commands on the 0006 schema with `app:changes:announce`, the demo's
origin add, the D1 restore steps; D205–D209); 2026-11-02 (branch `feat/link-cap`: "Link volume thresholds", D200, and `set_link_thresholds`
through `owner:call`; branch `feat/email-login-5`: the watchdog's email rules, the link alarms and
`unrecorded_wallets` alerts in "Watchdog alerts (runbook)" and "Watchdog service", D190–D193, D200; branch
`feat/email-login-2`: `deploy-contract` refuses a v1 contract, D154; the v2 → v3 upgrade path sandbox-tested,
"Upgrading the governance contract"); 2026-10-30 (branch `fix/watchdog-retired-key-race`: the `retired_key_change` alert, D153;
branch `feat/identity-token-2`: "Identity token keys" rewritten for the
offline standby and `identity-key next / switch / retire` (D177), the identity secrets rows, `gen --dev-vars`;
`feat/identity-token-1`: the identity token secrets, migration 0008; `feat/playbook-gaps`: relayer funds monitoring in the watchdog,
`owner:vote --reject`, `council:replace-member`, the D1 Time Travel restore runbook; `feat/batch-c-1`: "Usage ledger
(Neon, batch C)", the batch C manifest fields; `feat/recovery-playbooks`: the watchdog alerts runbook now points at
`docs/playbooks.md`, `owner:call` takes `set_sessions_valid_from_ms`; `docs/watchdog-hosting`: watchdog hosting, D125;
`gov/sandbox-handover`: sandbox-dev's owner is now its council DAO, council-setup's DAO check, the upgrade drill).

Commands and flags are from `scripts/`, `apps/api/scripts/gen-wrangler.ts`, `apps/api/scripts/pages-wrangler.ts`,
`apps/demo/scripts/gen-wrangler.ts`, the `package.json` scripts and their tests. Endpoints:
`docs/api.md`. Contract methods: `docs/contract-interface.md`. Design and measurements: `docs/context.md`.

**Testnet only.** The manifest schema accepts only `network: "testnet"` and every script refuses an RPC whose
`chain_id` isn't `testnet`. Never point anything at mainnet accounts.

## Secrets: where they live

Never print, log, paste or commit any of these. The scripts never print them either.

| Secret | Where | Written by |
|---|---|---|
| Full-access keys of `signer`, `relayer`, `owner` | `~/.near-credentials/testnet/<account>.json` (or `<account>/*.json`) | near CLI `save-to-legacy-keychain`; scripts only read them |
| Session-pool relayer keys (`RELAYER_KEYS`) | `.secrets/<env>/relayer-keys.json` | `deploy-contract` |
| Owner-pool relayer keys (`OWNER_RELAYER_KEYS`) | `.secrets/<env>/owner-relayer-keys.json` | `deploy-contract` |
| Keys-updater key (`KEYS_UPDATER_KEY`) | `.secrets/<env>/keys-updater.json` (`private_key`) | `deploy-contract` (generated, then installed on `signer` by the contract's `add_updater_key`) |
| Council member keys (dev envs only, D81) | `.secrets/<env>/council/<member>.json` (`{account_id, public_key, private_key}`), full-access keys of throwaway testnet accounts | `council-setup`; other envs' members hold their own keys (mainnet: Ledgers, never on disk) |
| `VAULT_KEK` (and, during a rotation, `VAULT_KEK_PREVIOUS`) | `.secrets/<env>/vault-kek` (and `vault-kek.previous`); the only copy, since Cloudflare can't give a secret back | `vault-kek` (below) |
| Identity token signing keys (Worker slots `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY`; testnet and `local*` only) | `.secrets/<env>/identity-signing-key.json` (active), `identity-signing-key-standby.json` (published, **never uploaded**: keep it offline), and during a rotation `identity-signing-key-next.json` / `-previous.json` (P-256 private JWKs); `identity-slots.json` says which slot holds which kid; the only copies | `identity-key <env> init`, `next`, `switch`, `retire` ("Identity token keys" below); `put --yes` uploads the active key again |
| Identity token KMS signer's AWS access key (`IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY`; `aws-kms` envs only, none yet) | `.secrets/<env>/identity-aws-access-key.json` (`aws iam create-access-key`'s JSON for the signer's IAM user), only until it is uploaded and checked: then delete it (a lost key is replaced, never recovered) | the operator, with the AWS CLI as the break-glass role; `identity-key <env> kms-put-aws-key --yes` uploads it ("Identity token keys on AWS KMS" below) |
| Identity token sub key (`IDENTITY_SUB_KEY`) | `.secrets/<env>/identity-sub-key` (base64 of 32 bytes); never rotated, also backed up offline with the council backup (D81) | `identity-key <env> init`; upload again with `identity-key <env> put --yes` |
| Neon Postgres connection strings (batch C ledger, D73): pooled `DATABASE_URL` and `DATABASE_URL_DIRECT` of the env's Neon branch | `.secrets/<env>/neon.json` (`{project_id, branch, DATABASE_URL, DATABASE_URL_DIRECT, …}`); role `neondb_owner` until batch C creates least-privilege roles | `neon connection-string <branch> --project-id <id> [--pooled]` (Neon CLI, `neon login`) |
| Watchdog secrets (`WATCHDOG_KEY`, `WATCHDOG_STATUS_TOKEN`, its Resend key, Slack webhook, paging-app credentials, `HEARTBEAT_URL`) | `.secrets/<env>/watchdog-secrets.json` (flat `{NAME: value}`) | `watchdog secrets <env> init` (the key and token); the rest by hand ("Watchdog service" below) |
| Worker copies of the above | Cloudflare Worker secrets (the watchdog's on its own Cloudflare account) | `wrangler secret put` (watchdog: `wrangler secret bulk`) |
| Local dev copies | `apps/api/.dev.vars`, `apps/watchdog/.dev.vars` (0600) | `gen --dev-vars` |

`.secrets/` is gitignored, directories 0700, files 0600 (`scripts/lib/secrets.ts` refuses to read a file that group
or others can read). Google ID tokens, CKD outputs and derived keys are never stored anywhere.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | ≥ 22 | `engines` in `package.json` |
| pnpm | 11.3.0 via corepack | `corepack pnpm …` (the `packageManager` field pins it) |
| Rust | 1.85.1 + `wasm32-unknown-unknown` | from `contracts/hana-signer/rust-toolchain.toml` |
| cargo-near | 0.22.0 (CI) | `cargo install cargo-near`; `deploy-contract` falls back to `cargo build --target wasm32-unknown-unknown --release` without it |
| near CLI | near-cli-rs ≥ 0.30 | account creation and key changes |
| wrangler | 4.151.1 | a devDependency of `@hana-id/api`: run it as `corepack pnpm --dir apps/api exec wrangler …` |
| gitleaks | 8.30.1 (CI) | `brew install gitleaks`; commits are blocked without it |

```sh
corepack pnpm install          # also sets core.hooksPath=.githooks (gitleaks pre-commit)
corepack pnpm -r typecheck
corepack pnpm -r test
(cd contracts/hana-signer && cargo test)
corepack pnpm --dir apps/api exec wrangler login
```

`pnpm install` refuses packages published less than 7 days ago (`minimumReleaseAge`).

## Accounts and services per environment

Every name comes from `envs/<env>.json` (schema: `packages/env/src/schema.ts`; notes: `envs/README.md`).

| Manifest field | What | Funding / notes |
|---|---|---|
| `signer` | holds `hana-signer`; part of every user's address | ≥ 6 NEAR (contract storage, scope registrations) |
| `relayer` | function-call keys that pay the API's gas (both pools) | ≈ 7 NEAR |
| `owner` | contract admin (`new(owner, …)`): a plain account, or the council DAO once it accepted ownership | ≈ 1 NEAR (an account owner) |
| `ownerKind` | `account` (the owner's keychain key signs) or `sputnik` (`owner` is `council.dao`; owner calls are DAO proposals) | default `account`; `deploy-contract --transfer-owner` switches it after the DAO accepts |
| `council` (optional) | `{factory, dao, members}`: the owner council, a Sputnik DAO v2 `<name>.<factory>` with exactly three members, 2 of 3 for every proposal kind (D81) | sandbox-dev: `sputnikv2.testnet`, members funded by `council-setup` (2 NEAR each), DAO 6 NEAR |
| `watchdogs` | watchdog accounts (≤ 3) the contract lets cancel, confirm and pause | default none; `add_watchdog` is skipped until the account exists |
| `issuerKeyDelayMs`, `governanceDelayMs` | `new` delays (D80; also the delays the done v1 → v2 migration started with) | sandbox-dev: 120 000 and 60 000; mainnet 2 h (provisional) and 72 h. Outside dev envs `deploy-contract` (and `--creation-plan`) refuses an issuer-key delay below the security bound 3·(W + T) = 18 min and a governance delay below 24 h (mainnet: 72 h); `@hana-id/env` `governanceDelayProblems`. sandbox-dev's 2 min deliberately violates the bound for fast drills (D80): its plans carry a warning, never copy its delays to another env |
| `allowSignerFullAccessKey` | the signer may keep a full-access key (D86) | only `local*` / `sandbox*` testnet envs; sandbox-dev only among committed manifests |
| `mpc` | the NEAR MPC contract (exists already; not ours) | — |
| `ckdDomainId`, `ckdNetworkKey` | CKD domain and the pinned MPC public key | pin with `fetch-ckd-key` |
| `ckdNetworkKeySource` | where the pin was read: `{blockHeight, blockHash, rpcs}`, the final block and the hosts of the ≥ 3 independent providers that agreed (D100) | written by `fetch-ckd-key`; hosts only, never a URL |
| `rpc`, `apiUrl` | NEAR RPC; the deployed Worker URL | https (the schema allows http only for a loopback host in `local*` envs); `apiUrl` is known only after the first deploy |
| `rpcFallback` (optional) | a second NEAR RPC from another provider, https; the vault and the export window read from it only when `rpc` fails or times out | not `rpc` itself; built into the vault and auth bundles and in the API's and auth Worker's CSP (`NEAR_RPC_FALLBACK`), so a change needs `gen`, a page build and a redeploy of the API and both page Workers (D65) |
| `vaultOrigin`, `authOrigin` | Hana page origins (batch B) | both or neither; `gen` refuses an env without them |
| `googleClientIds` | Hana's own app clients → reserved `global` scope | |
| `sharedGoogleClientIds` | Hana's shared login clients (≤ 5) | never also in `googleClientIds` / `consoleAudiences` |
| `consoleAudiences` | `[provider, aud]` accepted for OIDC owner actions | set before the first deploy |
| `changeDelayMs` | contract timelock (0..7 days) | sandbox-dev: 60 s |
| `appChangeDelayMs` | batch C guarded-change delay (60 s..7 days; ≥ 24 h and ≤ `changeDelayMs` on a production network) | sandbox-dev: 60 s; read by the API and CLI from batch C3 |
| `console`, `files`, `admin`, `usage`, `email`, `ownerGrantDelayMs` | batch C dashboard: console, files and admin Workers and origins, R2 buckets, Access, Hyperdrive names, sender (`envs/README.md`) | all or none; sandbox-dev has none yet (`docs/batch-c-build-plan.md` "Setup steps") |
| `cloudflare.workerName`, `cloudflare.d1Name` | Worker and D1 names | |
| `cloudflare.durableObjectLocation` | optional DO region hint (`apac`, `weur`, …) | changing it creates new objects |

Also needed: a Cloudflare account with a `workers.dev` subdomain (production needs a Hana-owned account), and a
Google Cloud project.

Values containing `UNSET` are placeholders: `deploy-contract` skips the step that needs them (with a warning),
`scope:register --allow-shared` warns, and `@hana-id/core`'s `ckdKeyProblem` makes smoke and the web build refuse an
`UNSET` `ckdNetworkKey`.

**Address impact.** `signer`, `mpc`, `ckdDomainId` / the MPC key, the path format and the local derivation are part of
every user's address. Changing any of them before the address freeze is allowed but must be called out; after it,
never.

## Google Cloud OAuth

Console → APIs & Services → Credentials → Create OAuth client ID, type "Web application". Consent screen in Testing
mode with test users.

| Client | Manifest field | Notes |
|---|---|---|
| Hana's own app | `googleClientIds` | becomes a client of `global` |
| Shared login client | `sharedGoogleClientIds` | a different client ID from the above |
| Hana console | `consoleAudiences` (`["google", "<id>"]`) | batch C signs in with it |
| Partner test client(s) | `scope:register --client` | for own-client tests; for the own-vs-shared address test use a separate Google Cloud project (the cross-project `sub` match was confirmed 2026-10-28, D42) |

Register on each client:

| Entry | Value | On which clients | Why |
|---|---|---|---|
| Authorized JavaScript origins | `http://localhost:5173` (Google also suggests `http://localhost`) | every client `apps/smoke` signs in with | smoke uses Google Identity Services in the page |
| Authorized redirect URIs | `{authOrigin}/login/callback`, exact (scheme, host, no trailing slash) | the shared client, and every partner's own client used through Hana's login page | the login popup (`response_type=id_token`, `redirect_uri={authOrigin}/login/callback`) |

Changes in Google Cloud can take a few minutes to apply. Changing `authOrigin` later breaks every own-client
partner's redirect registration (not addresses).

## Create an environment from scratch

Copy `envs/sandbox-dev.json` to `envs/<env>.json`; `name` must equal the file name. Use fresh throwaway account names:
the signer is part of every address. Dev-only privileges (loopback origins, partner calls to the session endpoints with
`pk_test_` keys, same-site Hana origins) follow from the name: `local*` / `sandbox*`.

1. **Accounts** (each ~10 NEAR from the faucet, key saved to the legacy keychain):

   ```sh
   near account create-account sponsor-by-faucet-service <signer>  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <relayer> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <owner>   autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```

2. **Manifest**: accounts, Google client IDs, `consoleAudiences`, `changeDelayMs`, Cloudflare names, `vaultOrigin` /
   `authOrigin`. Fill the client lists before the first deploy (a shared client added later waits out the timelock;
   a console audience added after `global` exists needs a timelocked `propose_change`).
3. **Pin the MPC key** (writes `ckdNetworkKey` and `ckdNetworkKeySource`; `--dry-run` only prints):

   ```sh
   corepack pnpm --filter @hana-id/scripts run fetch-ckd-key <env> [--rpc https://<another provider>]
   ```

   It reads the key at one final block from at least three independent providers (distinct registrable domains: the
   manifest's `rpc` and `rpcFallback`, each `--rpc`, then the built-in public endpoints `rpc.testnet.near.org`,
   `test.rpc.fastnear.com`, `near-testnet.drpc.org`) and refuses to write unless every one reports the env's chain,
   the same block hash and the same key (D100, security sweep OPER-1). A provider that is down or disagrees stops it:
   find out why before pinning, never drop the disagreeing source. Different domains are only a proxy for different
   operators; before a mainnet pin also compare the key with the MPC key material NEAR publishes and record that in
   the PR. The manifest change goes through a code-owner review (`/envs/` in `.github/CODEOWNERS`).

4. **Deploy the contract.** Prints the plan and changes nothing without `--yes`; re-running plans only what's
   missing. What each step does and why it blocks: root `README.md`, "deploy-contract".

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>        # read the plan
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

   Flags: `--relayer-keys N` (1..20, default 3), `--relayer-allowance <NEAR>` (2), `--owner-relayer-keys N` (1..5,
   default 1), `--owner-relayer-allowance <NEAR>` (0.5), `--upgrade` (see [Governance](#governance-owner-council-upgrades-migration)),
   `--wasm <file>`, `--skip-build`, `--transfer-owner`, `--member <m>`, `--approve-with <m>`, `--creation-plan`. Pass
   the same allowance flags on every re-run if you raised them (a key with a larger allowance than the flag is a
   blocker). Shared clients take effect `changeDelayMs` after this. A plain deploy calls `new(owner, mpc,
   ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs, updater_keys: [])` and needs
   the signer's full-access key, so only envs with `allowSignerFullAccessKey` deploy this way; any other env is
   created with the one-batch creation transaction (`--creation-plan`, below). The updater key is then installed by
   the owner's `add_updater_key`.

5. **Post Google's keys** once (the API cron keeps them in sync afterwards). On the governance contract this proposes
   them; they go live when the watchdog confirms them or after `issuer_key_delay_ms` (re-run with `--execute`):

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> [--dry-run] [--execute]
   ```

6. **D1 and Worker config**:

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 create <cloudflare.d1Name>      # prints the database id
   corepack pnpm --filter @hana-id/api run gen <env> --d1-id <uuid>             # writes apps/api/wrangler.jsonc (+ the page Workers' configs)
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote
   ```

   Without `--d1-id`, `gen` keeps the id already in `wrangler.jsonc` only if that file names the same
   `database_name`, else it writes the local placeholder `00000000-0000-4000-8000-000000000000`. The generated files
   are gitignored (`wrangler.jsonc` holds the env's D1 id): re-run `gen <env>` whenever you switch envs, and never commit them.

   `gen` also writes the two Rate Limiting bindings of the vault's per-IP and per-share limits (`ratelimits`:
   `VAULT_IP_LIMIT` namespace `95001`, `VAULT_SHARE_LIMIT` namespace `95002`; D95). They need no setup in the
   dashboard and aren't shown there. A namespace id is shared across the whole Cloudflare account: don't give
   another Worker on the account a binding with these ids (it would share counters for equal keys; this API's keys
   start with the env name, so two Hana ID envs on one account stay apart). The first deploy of an account
   confirms the plan accepts the binding: a refusal fails that deploy as a whole.

7. **Worker secrets** (from the repo root; values go through a pipe, never the terminal):

   ```sh
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' \
     | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   corepack pnpm --filter @hana-id/scripts run vault-kek <env> init           # read the plan
   corepack pnpm --filter @hana-id/scripts run vault-kek <env> init --yes
   ```

   `vault-kek init` generates `VAULT_KEK` (key id 1), writes it to `.secrets/<env>/vault-kek` (0600) before anything
   else, and sets the secret on `cloudflare.workerName` through wrangler's stdin; it prints no key and refuses to
   overwrite an existing file. If the secret step fails, `vault-kek <env> put --yes` sets it again from the file. Keep
   the file: a rotation needs the current value.

   The identity token's keys (optional; without them `/v1/identity/*` answers 503 `identity_unavailable`):
   `identity-key <env> init --yes`, commit the manifest's new `identityToken` block, re-run `gen` ("Identity token
   keys" under "Key rotation").

8. **Deploy the API**, then put the Worker URL in `apiUrl` and re-run `gen` + deploy if it changed (the vault page's
   CSP and the page bundles use it):

   ```sh
   corepack pnpm --filter @hana-id/api run deploy
   curl -s https://<worker-url>/v1/health          # {"ok":true,"env":"<env>","signer":"<signer>",…}
   ```

9. **Deploy the two page Workers** (`vaultOrigin`, `authOrigin`; one thin Worker each, D66), after the API: the vault
   Worker reaches it through a service binding. `gen` (step 6) already wrote their configs; the web build writes the
   per-env bundles they serve (`apps/api/README.md`, "Page Workers"):

   ```sh
   corepack pnpm --filter @hana-id/web build          # packages/web/dist/pages/<env>/{vault,auth}, every env with both origins
   corepack pnpm --filter @hana-id/api run deploy:pages   # wrangler deploy -c wrangler.vault.jsonc, then -c wrangler.auth.jsonc
   ```

   Rebuild and redeploy them whenever the manifest's `signer`, `relayer`, `rpc`, `rpcFallback`, `apiUrl`,
   `ckdNetworkKey` or origins change: the bundles inline them.
10. **Google redirect URI**: add `{authOrigin}/login/callback` on the shared client and on every partner's own client
    that logs in through Hana's pages (table above).
11. **Register apps** (next section), then **smoke test**.

### Upgrading an env deployed from `develop` to batch B

The contract change is a code upgrade (`deploy-contract <env> --upgrade`, plan first). The session-pool allowlist
gains `create_session_and_derive`, and access-key permissions can't be edited: the plan blocks on every session key
with the old method list and prints `near account delete-keys …` per key; delete them, re-run (it re-adds them from
`.secrets/<env>/relayer-keys.json`); the secret is unchanged (same keys). A re-added key starts at a new on-chain
nonce, so expect one `relay_retry` `invalid_nonce` per key on its first relay. This is allowlist state 1 (the session
pool's methods in `apps/api/src/relayer-config.ts`). Then: set `vaultOrigin` / `authOrigin`, re-run `gen`, apply
migration `0003_vault.sql` (`migrations apply … --remote`), `vault-kek <env> init` (step 7), deploy the API (step 8),
build and deploy the page Workers (step 9), and register `{authOrigin}/login/callback` (step 10).

## Governance (owner council, upgrades, migration)

The governance contract (`docs/governance-spec.md`, D33, D80–D86; methods in `docs/contract-interface.md`) puts
issuer keys and code changes behind public delays and makes the owner a 2-of-3 Sputnik DAO v2 council. The scripts:

| What | Command |
|---|---|
| Create the dev council (accounts + DAO) | `council-setup <env> [--yes] [--funder <account>] [--member-balance 2]` |
| Any owner call through the owner | `admin <env> owner:call <method> --args '<json>' [--member <m>] [--approve-with <m>] [--yes]` |
| Vote / list council proposals | `admin <env> owner:vote <id> --member <m> [--reject] [--yes]` · `admin <env> owner:proposals [--json]` |
| Replace a council member | `admin <env> council:replace-member --remove <old> --add <new> [--member <m>] [--approve-with <m>] [--yes]` |
| Governance state and findings | `admin <env> governance:status [--json]` |
| Upgrade (propose, then execute once due), hand the contract to the DAO | `deploy-contract <env> --upgrade` · `--transfer-owner [--approve-with <m>]` |
| Print the mainnet-style signer creation batch | `deploy-contract <env> --creation-plan [--wasm <reproducible build>]` |

All are `corepack pnpm --filter @hana-id/scripts run …`. Each prints its plan and sends nothing without `--yes`
(`--creation-plan` never sends).

### Owner council (Sputnik DAO v2, D81)

The DAO code and policy are pinned in `contracts/sputnik/` (`pin.json`: v3.31, `code_hash`
`AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, 539 647 bytes; `policy.json`: one `council` role with exactly the
manifest's three members, `RoleWeight` threshold `[1, 2]` for every proposal kind = 2 of 3, no `Everyone` role, no
`RemoveProposal`, bond 0.1 NEAR, 7-day proposals). The sandbox test `sputnik_dao_owner_2_of_3` checks that wasm with
that policy; the scripts read the same files. `deploy-contract` checks the DAO's `get_policy` against it (not only
its code hash) before `--transfer-owner` and on every run of a council-owned env, and blocks on any role, member,
permission or vote-policy difference (`sputnik.ts` `policyProblems`): a staging or mainnet DAO is created by hand, so
this is the check that it really is 2 of 3 for every kind. The watchdog alerts critical on any later change of the
owner DAO's policy or code (`owner_policy`, `owner_code_hash`).

**What was verified (2026-10-29), and how.** From the pinned commit of near-daos/sputnik-dao-contract: the factory's
`create(name, args)` takes base64 JSON `{config, policy}`, needs a deposit of at least (code bytes + 32) × 10¹⁹ yocto
(`ERR_NOT_ENOUGH_DEPOSIT`; 5.397 NEAR for the pinned wasm, council-setup sends 6) and refunds it if `new` fails;
`add_proposal({proposal: {description, kind}})` needs the bond and isn't a vote; `act_proposal(id, action, memo)`
executes on the vote that reaches the threshold; `to_weight` is min(⌊a·n/b⌋ + 1, n). By read-only RPC views of
testnet: `sputnikv2.testnet` exists, `get_default_code_hash` = the pinned `code_hash`, `get_default_version` = [3, 31].
From near-cli-rs's `create-account fund-myself` source: a top-level `<name>.testnet` account is created by the
`testnet` registrar's `create_account({new_account_id, new_public_key})` with the initial balance attached, 30 Tgas.
**Verified on testnet 2026-10-30** (sandbox-dev): `council-setup sandbox-dev --yes` created the
DAO `hana-id-council-dev1.sputnikv2.testnet` with the pinned policy, and proposal round trips behaved as in the
sandbox: the owner handover (`accept_owner`, proposal #0), the upgrade drill (contract 0.1.1), and the drills'
updater-key install, `remove_issuer_key` and unpause (#2–#4) ([Governance migration (sandbox-dev)](#governance-migration-sandbox-dev),
[Watchdog service](#watchdog-service-appswatchdog)); `governance:status` shows no findings. Not recorded: the gas
`create` really burns (council-setup attaches 300 Tgas).

**sandbox-dev** (dev envs only: `local*` / `sandbox*` on testnet):

```sh
corepack pnpm --filter @hana-id/scripts run council-setup sandbox-dev          # plan
corepack pnpm --filter @hana-id/scripts run council-setup sandbox-dev --yes    # 3 × create_account + factory create
```

It generates each member key into `.secrets/sandbox-dev/council/<member>.json` (0600) **before** the account exists,
creates the accounts from the funder (default the manifest `owner`, from the keychain; ~12.4 NEAR in all; once the
owner is the DAO, pass `--funder`), then the DAO, and checks it exists and its stored policy. The factory's `create`
doesn't return its promise, so its transaction value is always empty: the script checks the DAO account instead. Re-running checks what exists: a factory whose default code isn't the pin (re-pin
and re-run the sandbox test first), a member that exists without its key file, or a DAO with other code or another
council, threshold, roles or permissions stops the plan.

**Other envs**: council-setup refuses them. Each member creates their own account and keeps their own key (mainnet:
the founders' Ledgers and the offline backup key, D81); the DAO is created once by hand with the same factory call
(`scripts/lib/sputnik.ts` `factoryCreateArgs`, the same `policy.json`). The scripts never read a council key from
disk for mainnet.

### Owner actions through the council

`owner:call` sends one owner-only method (the list is `OWNER_METHODS` in `scripts/lib/contract.ts`, kept a superset of
the contract's owner-only methods by `scripts/test/contract-constants.test.ts`, so every recovery playbook's owner call
goes through it, `set_sessions_valid_from_ms` included) through the manifest's owner:

- `ownerKind: "account"`: the owner's keychain key signs it.
- `ownerKind: "sputnik"`: a `FunctionCall` proposal (receiver `signer`, the JSON args, no deposit, 100 Tgas or
  `--gas`) by `--member` (dev envs: default the first member). On dev envs `--approve-with <second member>` also casts
  the proposer's and that member's approvals, so the call executes in the same command. Elsewhere the command only
  proposes and prints, per member, the `near contract call-function as-transaction <dao> act_proposal … sign-with-ledger`
  command to sign. `--approve-with` is refused outside dev envs.
- `accept_owner` always goes through the council (the account accepting is the proposed owner, the DAO).
- An open proposal for exactly the same call is reused, so a re-run never duplicates one: same receiver, method,
  args, deposit (none) and gas, and a description starting `hana-id <env>: ` (the scripts' own). An open proposal for
  the same method and args that differs in gas, deposit or description is never reused: the command prints `WARNING:
  open proposal #N … a different gas / deposit / description; not reusing it`, then proposes anew. Reject the stray one
  (or let it expire) if nobody wants it. A call the contract refuses leaves the proposal `Failed` and the command fails.

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:call unpause --approve-with hana-id-council-b-dev1.testnet --yes
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:proposals
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:vote 4 --member hana-id-council-c-dev1.testnet --yes
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:vote 5 --member hana-id-council-c-dev1.testnet --reject --yes
```

`owner:vote` casts one vote per member (the DAO refuses a second: it says what the member already voted):
`VoteApprove`, or `VoteReject` with `--reject`. Two rejections (2 of 3) close the proposal as `Rejected`: it never
executes, and the proposer's bond is refunded. `owner:proposals` shows approvals and rejections. Off dev envs a member
rejects with the same `act_proposal` command as an approval, `"action":"VoteReject"`. Reject every proposal nobody
explained, rather than letting it sit open for its 7 days.

`deploy-contract` and `admin scope:register` route their owner steps the same way (both take `--member` /
`--approve-with`). With a council owner and no `--approve-with`, `deploy-contract` stops after the first step that
was only proposed; re-run it once that proposal is approved.

### Replacing a council member

`admin <env> council:replace-member --remove <old> --add <new>` (D151) replaces one member and keeps the policy the
scripts verify (one `council` Group of three, 2 of 3 for every kind: `policyProblems`). Sputnik has no swap, so it
makes two proposals on the council DAO, in this order: `RemoveMemberFromRole(<old>, council)`, then
`AddMemberToRole(<new>, council)`. Between the two the council is 2 of 2 (the threshold follows the group's size), so
both remaining members approve the addition; removing first cuts a lost or stolen key off at once. The old member
never proposes or approves (`--member` and `--approve-with` refuse it). Before sending anything it checks that the new
member's account exists, that `envs/<env>.json` still validates with the new `council.members` (the new member in the
old one's place), and that the DAO's group is the manifest's council (or a half-done replacement: removed only, or
added only, which it carries on from) with otherwise exactly the council policy. Open identical proposals are reused.

- Without `--yes`: the plan, including the exact manifest edit (`"council": "members": [...] -> [...]`).
- Dev envs on testnet, `--approve-with <second remaining member>`: both proposals are approved in the same command,
  so they execute; then it writes `council.members` in the manifest.
- Elsewhere: it only proposes, and prints the `act_proposal` `VoteApprove` command for each remaining member and
  each proposal (approve the removal first). After both executed, run it again with `--yes`: it finds the new council
  on chain and writes `council.members`.

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev council:replace-member --remove hana-id-council-c-dev1.testnet --add hana-id-council-d-dev1.testnet --approve-with hana-id-council-b-dev1.testnet          # plan
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev council:replace-member --remove hana-id-council-c-dev1.testnet --add hana-id-council-d-dev1.testnet --approve-with hana-id-council-b-dev1.testnet --yes
corepack pnpm --filter @hana-id/scripts run admin <env> council:replace-member --remove <old member> --add <new member> --member <member> --yes
```

Each executed change raises the watchdog's critical `governance_change` (`owner_policy`): expected, acknowledge it.
On a dev env the new member's key belongs in `.secrets/<env>/council/<new member>.json` for the scripts to sign as it
(the command notes when it is missing). Commit the manifest edit (code-owner review), then check `governance:status`
(no findings) and a `deploy-contract <env>` dry run (no council blocker).

### Governance migration (sandbox-dev)

`docs/governance-spec.md` "Migration plan → sandbox-dev", as commands. Same signer account, migrated in place: no
address changes (the signer id, the path and the CKD request are untouched). **Done on sandbox-dev 2026-10-30; kept as
the record.** It can't be repeated with current code: contract v3 has no `migrate_v1`, and `deploy-contract` refuses
a v1 contract (D154; a v1 contract would first need the v2 code, develop 26fb70a).

1. Merge the contract, API (sync with the new updater methods) and script changes; tests pass.
2. `council-setup sandbox-dev --yes` (above). Create the watchdog account (`watchdogs[0]`) with near CLI when the
   watchdog service is ready; until it exists `deploy-contract` skips `add_watchdog` with a warning.
3. `deploy-contract sandbox-dev --upgrade` (read the plan), then `--yes`. One run:
   1. `DeployContract` + `migrate_v1(issuer_key_delay_ms, governance_delay_ms)` from the manifest, **one
      transaction** signed by the signer's full-access key (a panicking `migrate_v1` rolls the deploy back);
   2. `add_updater_key(<new key>)` by the owner; the new key is generated into `.secrets/sandbox-dev/keys-updater.json`
      first (replacing the v1 key's file: that key is deleted next);
   3. `DeleteKey(<v1 updater key>)` with the signer's full-access key (left in place it could still propose keys);
   4. `add_watchdog(<watchdog>)` by the owner (its confirm power starts after `governance_delay_ms`).

   Then upload the new `KEYS_UPDATER_KEY` (create step 7) and deploy the API: until then the API's JWKS sync fails
   (safe: keys only change by proposal). Check `get_scope("global")`, `get_issuer("google")`, a live session and a
   smoke wallet's addresses.
4. Watchdog service, alerts and the rotation and pause drills: the watchdog batch (`apps/watchdog`).
5. `deploy-contract sandbox-dev --transfer-owner --yes`: `propose_owner(<council DAO>)` by the old owner. After
   `governance_delay_ms` (60 s): `deploy-contract sandbox-dev --transfer-owner --approve-with <member> --yes`: the DAO's
   `accept_owner` proposal, approved by two members. On success the script sets `"owner": "<dao>"` and
   `"ownerKind": "sputnik"` in `envs/sandbox-dev.json`; commit that change.
6. Upgrade drill: rebuild with a no-op change (a patch bump of `contracts/hana-signer/Cargo.toml` `version` changes
   the hash: cargo-near embeds it in the wasm), `deploy-contract sandbox-dev --upgrade --approve-with <member> --yes`
   (the DAO's `propose_upgrade(hash)`), wait `governance_delay_ms`, then `deploy-contract sandbox-dev --upgrade
   --skip-build --yes` (`execute_upgrade`). Check `view_account.code_hash`.
7. The signer keeps its full-access key (D86, `allowSignerFullAccessKey: true`); `deploy-contract sandbox-dev` must
   show no blockers, and `admin sandbox-dev governance:status` no findings.

### Upgrading the governance contract

`deploy-contract <env> --upgrade` never sends a raw `DeployContract` to a v2 contract:

- No pending upgrade, or a different one: build (or `--wasm` / `--skip-build`), then `propose_upgrade(<code_hash>)`
  through the owner (`code_hash` = base58 sha256 of the wasm, NEAR's `view_account.code_hash` format). A different
  pending hash is replaced, with a warning.
- The same hash pending and not yet due: nothing to do; the plan prints when it is executable.
- Due: `execute_upgrade` with the raw wasm as the input (not JSON), 300 Tgas, signed by the relayer's full-access key
  (anyone may execute). The deploy and the new code's `migrate` are one receipt: if `migrate` fails the old code stays,
  the pending upgrade is consumed, and the script fails with "its migrate failed"; propose a fixed build.

Re-run with `--skip-build` (or the same `--wasm`) to execute, so the hash is the proposed one. For a mainnet manifest
the build must be reproducible (`cargo near build reproducible-wasm`) and its hash, commit and command published
before the proposal (D86); the scripts refuse every non-testnet manifest today.

**v2 → v3 (email login, sandbox-dev in build-plan batch 6).** Before proposing it, both must be live:

1. The API, `packages/web` (the vault's split path) and `apps/smoke/src/direct.ts` sending the `create_session`
   proof of possession (`signature` over session_message(0, "hana-id-create-v1:" ‖ sha256(session nonce
   preimage)), D137), deployed. v2 ignores the extra field; v3 requires it, so without it every split-path session
   (`/v1/sessions`) fails from the moment the upgrade executes (the one-transaction `/v1/login` is unaffected).
2. The watchdog with the email pins (build-plan batch 5) deployed, so the email keys posted after the upgrade aren't
   read as an attack (`unverifiable_key_change`).

The full order is build-plan batch 6's "Deploy (sandbox-dev), in order" (watchdog pins → upgrade →
`accept_unrecorded_wallets` → email issuer on chain → issuer Worker → email clients → D1 → API). The upgrade itself
is the same path as any other; the sandbox suite runs it end to end
from the v2 code sandbox-dev runs (`contracts/integration-tests/tests/governance.rs`
`v2_to_v3_upgrade_through_the_dao_keeps_every_view_and_path`): the DAO's `propose_upgrade`, `execute_upgrade` once
due (`state_migrated {2, 3}`, ≈ 100 Tgas of the 300 attached), every view and path unchanged, then the DAO's
`accept_unrecorded_wallets` before any link works (D135). Check `get_governance().state_version == 3` and
`get_config().unrecorded_wallets` (`true` until that call). The v2 code can't come back by upgrade (its `migrate`
refuses v3 state; the deploy reverts). sandbox-dev's v2 code (`3TSDwkMqPUhZtzFCvvaJ39nQWXUQK4LExPhsaS9tScoz`) is
`contracts/hana-signer` at develop 26fb70a built with `cargo near build non-reproducible-wasm --no-abi` (what
`deploy-contract` runs) on the machine that deployed it; another machine embeds other cargo registry paths and
gets another hash.

### Creating a signer with governance in place (mainnet-style)

`deploy-contract <env> --creation-plan [--wasm <reproducible build>] [--updater-public-key <pk>]
[--creation-public-key <pk>]` prints, and never sends, the signer account's first transaction: `DeployContract` +
`new(owner = council.dao, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs,
updater_keys: [<updater key>])` + `DeleteKey(<creation key>)`, signed by the creation key. It has **no `AddKey`**:
`new` installs the updater key itself with exactly `UPDATER_METHODS` and tracks it (an `AddKey` of the same key in
the batch would make that promise fail and leave the key untracked, which `deploy-contract` blocks on;
`docs/contract-interface.md` "new"). The mainnet run is the user's alone (`docs/governance-spec.md` "Migration plan →
Mainnet"); afterwards `deploy-contract <env>` must show no blockers.

### Blockers on the signer's keys

On a governance contract `deploy-contract` compares `view_access_key_list(<signer>)` with
`get_governance().updater_keys`:

- a full-access key on the signer stops every env without `allowSignerFullAccessKey` (only `local*` / `sandbox*`
  testnet manifests may set it; a test keeps it to sandbox-dev among committed ones). The fix is a `DeleteKey` signed
  by that key; afterwards code changes only through `propose_upgrade` / `execute_upgrade`;
- every function-call key that isn't a tracked updater key stops the plan (the fix: `DeleteKey` with the full-access
  key where one is allowed, else the owner's `delete_updater_key`, which may delete any key). The exception is the v1
  updater key, which the plan deletes itself;
- a tracked key with other methods, another receiver or more than 1 NEAR of allowance stops it; a tracked key missing
  from the account is a warning.

### Governance status for the admin portal (batch C hand-off)

The admin portal (batch C) doesn't exist yet. Its "Security & monitoring" view (D83) and pending-upgrades page (D86)
read these sources, all read-only:

- **Contract** (through the portal's own RPC): the views and NEP-297 events in `docs/contract-interface.md`
  "Monitoring hand-off".
- **Council DAO**: `get_policy`, `get_last_proposal_id` and `get_proposals({from_index, limit})` on `council.dao` (=
  `owner` once `ownerKind` is `sputnik`): pending owner actions with their approvals (`votes`); expiry =
  `submission_time` + `proposal_period` (ns). A `FunctionCall` proposal's calls are `kind.FunctionCall.actions[i]`
  with base64 JSON `args`; `admin <env> owner:proposals --json` prints them decoded.
- **One snapshot**: `admin <env> governance:status --json` prints `{env, signer, owner: {account, kind},
  observedAtMs, contract: {codeHash, stateVersion}, config, governance, keyChanges, activeKids, signerKeys:
  [{publicKey, permission, tracked}], council: {dao, policy, openProposals}, findings: [string]}`. `findings` are the
  checks the portal must show as problems: untracked signer keys, a full-access key where none is allowed, a tracked
  key with the wrong permission or missing, paused, a pending upgrade / owner transfer / withdrawal, no watchdog, a
  due key change nobody executed, a contract owner other than the manifest's, a missing DAO, a council DAO whose
  `get_policy` isn't exactly the manifest's council at 2 of 3 for every kind (or can't be read), on-chain
  delays below the non-dev floors, and any active google key or pending google Add that Google's JWKS doesn't
  publish (or a JWKS it couldn't read; fetched only when there is a google key to check). The portal's Worker
  makes the same reads itself (`scripts/lib/admin-owner.ts` `governanceStatus` is the reference implementation).
- **API**: `GET /v1/governance` serves the contract part already normalised, with JWKS verdicts and the cron's last
  run ([below](#governance-status-get-v1governance)); not independent of Hana's main Cloudflare account.
- **Watchdog**: its own status (heartbeat, verdicts, actions, alerts, acks) from its `GET /status`, `/alerts`,
  `/actions` and `POST /alerts/:id/ack` (`apps/watchdog/README.md` "Status endpoint").

## Usage ledger (Neon, batch C)

The ledger's schema is `apps/api/migrations-usage/` (Postgres; D73), applied by `scripts/usage-migrate.ts`. Nothing
writes to it yet: capture starts in batch C4 (`docs/batch-c-build-plan.md`). Neon Auth and Neon's other services
aren't used, only Postgres.

```sh
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev         # lists the pending files, changes nothing
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev --yes   # applies them
```

- It connects as the owner role with `DATABASE_URL_DIRECT` from `.secrets/<env>/neon.json` (0600), and refuses a URL
  that isn't a direct (non-`-pooler`) endpoint in `aws-ap-southeast-2` with `sslmode=require` (or `verify-full`). It
  never prints the URL or its password.
- Each file runs in its own transaction with its sha256 recorded in `hana_migrations.applied`, under an advisory lock.
  A file changed after it was applied, or an applied file the repo doesn't have, stops the run: add a new file instead.
- The schema creates the roles `usage_writer` (the API) and `usage_admin` (the admin Worker) `NOLOGIN`, with no
  password; giving them `LOGIN` and passwords, and the Hyperdrive configs, is batch C4's `usage-setup`
  (`docs/batch-c-build-plan.md` "Setup steps").
- The first migration creates the monthly partitions of `usage.events` for the current month and the next three;
  `usage.ensure_partitions(3)` adds the rest (the admin Worker's daily cron, from C12; until then by hand as the owner
  if the ledger is in use).
- Tests run on PGlite in process (`apps/api/test-usage`, D140); set `USAGE_TEST_DATABASE_URL` to a superuser URL of a
  local Postgres 18 (a container, never Neon) to run the same suite there.

## Hot DB migration 0006 and the new gate (batch C3, milestone M1)

Migration `0006_dashboard_expand.sql` adds batch C's hot-DB tables and columns (`docs/api.md` "D1 schema") without
rebuilding a table, and backfills them: one `scopes` row per scope (in `org_legacy`, with the environment its keys
name), one `app_keys` row per app (its key), every origin in force from 0, Hana's suspension bit for suspended apps and
one `migration.baseline` row per app. The API built on it reads keys from `app_keys`, origins only once in force,
the suspension bits, and `scopes.environment` for the loopback rules. Existing apps answer exactly as before (tested on
a sandbox-dev-shaped database: `apps/api/test/migration-0006.test.ts`). On sandbox-dev it is the only unapplied file
(0008 is applied); wrangler applies unapplied files in name order. Run from the main checkout, logged in to the API's
Cloudflare account, with `corepack pnpm --filter @hana-id/api run gen sandbox-dev` done. Nothing here touches the chain.

1. **Check the data first** (reads only). Every scope must have one key prefix and every key one of the two, and no
   column the baseline copies into JSON may hold a BLOB (`json_object` refuses one); the migration aborts otherwise
   (as a whole on Miniflare; the rehearsal in step 3 shows what remote D1 does):

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT name FROM d1_migrations ORDER BY id"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT scope_id, COUNT(*) AS apps, COUNT(DISTINCT substr(publishable_key, 1, 8)) AS prefixes FROM apps GROUP BY scope_id"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT id FROM apps WHERE substr(publishable_key, 1, 8) NOT IN ('pk_test_', 'pk_live_')"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT id FROM apps WHERE 'blob' IN (typeof(auto_approve_policy), typeof(auto_approve_pending), typeof(auto_approve_effective_at), typeof(raw_sign), typeof(raw_sign_pending), typeof(raw_sign_effective_at), typeof(publishable_key)) UNION ALL SELECT app_id FROM app_origins WHERE typeof(origin) = 'blob'"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT (SELECT COUNT(*) FROM apps) AS apps, (SELECT COUNT(*) FROM app_origins) AS origins, (SELECT COUNT(*) FROM usage) AS usage, (SELECT COUNT(*) FROM vault_shares) AS shares, (SELECT COUNT(*) FROM identity_usage) AS identity"
   ```

   Expected: the migrations end with `0008_identity_token.sql` and have no `0006`; `prefixes` is 1 on every row; the
   third and fourth queries return nothing. Note the counts.

2. **Back up** (the export holds `vault_shares`, so it goes under `.secrets/`, 0600):

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 time-travel info hana-id-sandbox-dev        # note the bookmark: it undoes the migration
   corepack pnpm --dir apps/api exec wrangler d1 export hana-id-sandbox-dev --remote --output=../../.secrets/sandbox-dev/d1-before-0006-<yyyymmdd>.sql
   chmod 600 .secrets/sandbox-dev/d1-before-0006-<yyyymmdd>.sql
   ```

3. **Rehearse on a scratch remote D1** restored from that export, through the same path as the real apply (`wrangler
   d1 migrations apply` on the generated config's D1 binding) and the CLI. Note sandbox-dev's own `database_id` first
   (in `apps/api/wrangler.jsonc`, or `wrangler d1 info hana-id-sandbox-dev`): step d puts it back.

   ```sh
   # a. a scratch database holding the export (it prints the scratch id)
   corepack pnpm --dir apps/api exec wrangler d1 create hana-id-sandbox-dev-rehearsal-0006
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev-rehearsal-0006 --remote --file=../../.secrets/sandbox-dev/d1-before-0006-<yyyymmdd>.sql
   # b. the config's D1 binding on the scratch database, then the real command (it lists 0006 alone)
   corepack pnpm --filter @hana-id/api run gen sandbox-dev --d1-name hana-id-sandbox-dev-rehearsal-0006 --d1-id <scratch id>
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev-rehearsal-0006 --remote
   # c. D1's implicit transaction per query (D207): the second statement fails, so the first must not be there (expect 0)
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev-rehearsal-0006 --remote --command "INSERT INTO plans (id, per_minute, per_day) VALUES ('rehearsal', 1, 1); INSERT INTO plans (id, per_minute, per_day) VALUES ('rehearsal', 1, 1)"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev-rehearsal-0006 --remote --command "SELECT COUNT(*) AS n FROM plans WHERE id = 'rehearsal'"
   #    and one CLI compare-and-swap write each way, read back by the CLI (any app id from app:list)
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:list --remote --d1-name hana-id-sandbox-dev-rehearsal-0006
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:suspend --app <app id> --remote --d1-name hana-id-sandbox-dev-rehearsal-0006
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:resume --app <app id> --remote --d1-name hana-id-sandbox-dev-rehearsal-0006
   # d. the config back on sandbox-dev's own database (before anything else, above all a deploy), then drop the scratch one
   corepack pnpm --filter @hana-id/api run gen sandbox-dev --d1-id <sandbox-dev database id>
   corepack pnpm --dir apps/api exec wrangler d1 delete hana-id-sandbox-dev-rehearsal-0006
   ```

   Between b and d, run step 1's counts and step 5's checks against `hana-id-sandbox-dev-rehearsal-0006`: the counts
   equal, the step 5 numbers as expected, the count in c is 0, and each CLI write prints its new state (a stale or
   lost write would say "nothing was written"). If the migration fails, stop: nothing touched sandbox-dev; read the
   error (step 1's checks name the usual causes) and note whether the scratch database kept any new table. If the count
   in c is 1, D1 didn't run that query as one transaction: stop and report it (D207). Delete the scratch database either
   way (it holds the export's vault shares), after step d.

4. **Apply 0006**: `corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote`
   (it lists `0006_dashboard_expand.sql` alone; confirm).

5. **Verify**: the counts of step 1 are unchanged, and

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT (SELECT COUNT(*) FROM scopes) AS scopes, (SELECT COUNT(*) FROM app_keys) AS keys, (SELECT COUNT(*) FROM app_changes WHERE kind = 'migration.baseline') AS baselines, (SELECT COUNT(*) FROM app_origins WHERE active_from IS NOT 0) AS not_in_force"
   ```

   gives one scope per distinct `scope_id`, `keys` = `baselines` = the apps count, and `not_in_force` 0.

6. **Deploy the API** (`corepack pnpm --filter @hana-id/api run deploy`), then check that it reports the new reads
   (`curl -s https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/health` shows `"hotDb":6`), a login on sandbox-dev
   (the demo, or `apps/smoke`) and `admin sandbox-dev app:list --remote` (every app `active` or `suspended(hana)` as
   before, its key, its origins).

7. **From now on use only this CLI** (below). It refuses proposals and announcements with `--remote` until
   `/v1/health` reports `hotDb` ≥ 6, so a proposal can't be made between steps 4 and 6. A checkout from before batch C3
   must not run `app:*` against sandbox-dev: its `app:origins:add` writes rows with `active_from` NULL, which never
   match, and its `app:create` is refused by the new triggers.

### Rolling the API back below batch C3 (rollback floor)

**The rollback floor is batch C3**: on a database with 0006 applied, run an API from before batch C3 only after
parking the pending origins. Such an API reads every `app_origins` row, so an origin that is only proposed (not yet
announced, or announced and still in its delay) would be in force for it. Its other reads work unchanged on the 0006
schema (new apps carry their key in `apps.publishable_key` too). Mandatory, in this order:

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:park --remote          # lists the rows not in force
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:park --remote --yes    # deletes them (origin.parked rows in app_changes)
corepack pnpm --dir apps/api exec wrangler rollback                                               # or deploy the older build
```

Park again right before the rollback if anyone proposed since. While the older API runs, make no proposals (the CLI
refuses them: `/v1/health` reports no `hotDb`). When batch C3 or later is deployed again,
`admin sandbox-dev app:origins:unpark --remote --yes` restores exactly the rows the park listed (`origin.parked` in
`app_changes`), each with its change's `active_from`, and only while that change is still open: an origin removed
while parked (`app:origins:remove` closes its change even with no row) or cancelled stays gone, and a row deleted any
other way is never brought back. Proposals not announced within 7 days are cancelled by the cron as usual, parked or not.

**Undo of the migration**: it only adds; a restore to the bookmark of step 2 (`time-travel restore`, "Restoring a D1
database" below) returns the database to before it, and the API from before batch C3 then works as it did. Writes
made after step 4 are lost with it.

## Local API (`wrangler dev`)

```sh
corepack pnpm --filter @hana-id/api run gen <env> --dev-vars     # wrangler.jsonc + apps/api/.dev.vars (0600)
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local
corepack pnpm --filter @hana-id/api dev                          # http://localhost:8787
```

`gen` writes the gitignored `apps/api/wrangler.jsonc` for that env (needed by `dev` and `admin app:*`). `--dev-vars`
writes `RELAYER_KEYS`, `OWNER_RELAYER_KEYS` (single-quoted), `KEYS_UPDATER_KEY` and the identity token's
`IDENTITY_SIGNING_KEY` (the active key only; the standby stays offline) and `IDENTITY_SUB_KEY` (refused when the signing key isn't the
manifest's active key) from `.secrets/<env>/`, skipping missing files, and prints only a count. It rewrites the whole file and has no `VAULT_KEK`; for local vault endpoints
append a throwaway one (never a deployed env's) after each `gen --dev-vars`:

```sh
printf 'VAULT_KEK=1:%s\n' "$(openssl rand -base64 32)" >> apps/api/.dev.vars
```

`admin app:*` without `--remote` act on this local D1 (`apps/api/.wrangler/state`).

The page Workers run locally only for a `local*` env (loopback `vaultOrigin`/`authOrigin`; none is in `envs/` today,
`apps/e2e` starts its own stack), each in its own process: `wrangler dev` (the API), then `wrangler dev -c
wrangler.vault.jsonc` and `wrangler dev -c wrangler.auth.jsonc` in other terminals (they find each other through
wrangler's dev registry). A single `wrangler dev -c a -c b` serves only its first config over HTTP, so the vault page
couldn't reach the API; with a sandbox env's configs every page answers 404 (the local URL isn't the configured
origin).

## Admin CLI (`scripts/admin.ts`)

```text
admin <env> app:create --org org_legacy --name <name> --scope <scope_id> [--environment test|live] --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:suspend        --app <app id | publishable key> [--remote]
admin <env> app:resume         --app <app id | publishable key> [--remote]
admin <env> app:list [--remote]
admin <env> app:changes:announce <change id> [--remote]
admin <env> app:origins:park [--yes] [--remote]      # before running an API from before batch C3 (rollback floor)
admin <env> app:origins:unpark [--yes] [--remote]    # after redeploying batch C3 or later
admin <env> <app:* command> … --d1-name <name containing "rehearsal">   # on a rehearsal database (M1 step 3)
admin <env> app:settings <app id | publishable key> [--persistence session|none] [--session-ttl 12h] [--idle-ttl 2h]
             [--raw-sign off|approval] [--google-web-client <client id>|default] [--auto-approve <policy.json>|off] [--remote]
admin <env> scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […]
             [--member <council member>] [--approve-with <council member>] [--yes]
admin <env> issuer-keys:lead-times [--remote]
admin <env> owner:call <method> [--args '<json>'] [--gas <Tgas>] [--member <m>] [--approve-with <m>] [--yes]
admin <env> owner:vote <proposal id> --member <m> [--reject] [--yes]
admin <env> owner:proposals [--limit 20] [--json]
admin <env> governance:status [--json]
admin <env> council:replace-member --remove <old member> --add <new member> [--member <m>] [--approve-with <m>] [--yes]
```

The `owner:*`, `council:*` and `governance:status` commands: [Governance](#governance-owner-council-upgrades-migration)
("Owner actions through the council", "Replacing a council member").

Run as `corepack pnpm --filter @hana-id/scripts run admin <env> <command> …`. Unknown flags are errors.

- `scope:register`: `admin_register_scope` through the owner (`owner`'s keychain key, or a council proposal with
  `--member` / `--approve-with`); prints the call and stops without `--yes`. 1..5 owners, ≤ 10 clients; `--client` required unless `--allow-shared`; a shared client ID is refused as
  `--client`. Prints the contract-assigned id (`s1`, `s2`, …).

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin <env> scope:register --client <id>.apps.googleusercontent.com --allow-shared --owner-near <account> --yes
  corepack pnpm --filter @hana-id/scripts run admin <env> scope:register --allow-shared --owner-near <account> --yes   # shared only
  ```

The `app:*` commands work on the hot DB after migration 0006 (`docs/api.md` "D1 schema"; batch C3). Every write is a
Hana staff action recorded in `app_changes` (actor `cli:<your login>`) and a compare-and-swap on the version the
command read: if someone changed the app in between, nothing is written and the command says so; run it again.
**Origin adds, auto-approve policies and raw signing on are staff proposals**: each gets a `gc_…` id and goes live only
once announced plus the manifest's `appChangeDelayMs` (sandbox-dev: 60 s). In an env with an admin Worker (batch C8)
its notice announces them; in an env without one (sandbox-dev today) `app:changes:announce <gc id>` does, and nobody
is emailed. A proposal not announced within 7 days is cancelled by the API's hourly cron. Removals, turn-offs and
suspensions are immediate. With `--remote`, proposals and announcements are refused until the deployed API reports the
batch C3 reads (`GET /v1/health` `hotDb` ≥ 6); `app:origins:park` / `unpark`: "Rolling the API back below batch C3"
above.

- `app:create`: `--org` is required and must be `org_legacy` until the console database exists (batch C7). The scope
  must exist on chain and the plan in D1. A scope with no app yet needs `--environment test|live`, fixed for the scope
  from then on (its `scopes` row); an existing scope keeps its own (another environment or org is refused, D51).
  Generates `app_<base58>`, `key_<base58>` and a `pk_test_` or `pk_live_` key by the environment and prints the key
  (public). The origins are staff proposals; when this call created the scope row they skip the delay at their
  announcement if the scope then still shows no sign of a user (the `no_session` waiver, decided inside the
  announcement's SQL: no `first_session_at`, no other origin of the scope ever in force, no vault share, usage or
  identity row). On an existing scope it is refused
  within `appChangeDelayMs` of the scope's org assignment. Origins are normalised by `@hana-id/console-core`
  `normaliseOrigin` (the form the API and the console share: lowercase ASCII/punycode host, default port and trailing
  dot dropped) and checked by its `originProblem` (`app:create` and `app:origins:add`; never `app:origins:remove`, so
  a bad entry can always be removed; D100, security sweep OPER-6): Hana's own origins (`REFUSED_ORIGINS`: the vault,
  auth and API origins and the dashboard's), wildcards, plain `http` other than loopback, IP addresses, public
  suffixes and single labels, a mixed-script label on a live scope; loopback origins (`http://localhost:<port>`,
  `127.0.0.1`, `[::1]`) and the literal `http://localhost:*` only on a test scope in a dev env (`local*`, `sandbox*`,
  D142). At most 20 active-or-pending origins per app. App names are NFC-normalised and may not contain control, bidi,
  zero-width, separator or unassigned characters; `app:list` prints stored values with such characters escaped
  (OPER-11).

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin <env> app:create --org org_legacy --name smoke-a --scope s1 --origin http://localhost:5173 --remote
  ```

- `app:origins:add`: a staff proposal per new origin (one already listed or pending is reported and skipped); prints
  each `gc_…` id. `app:origins:remove`: immediate; an origin in force ends its change, a pending one is cancelled.
- `app:changes:announce <gc id>`: only in an env with no `admin` block, never on a production network. Sets the
  change's `notified_at` and `active_from` (now + `appChangeDelayMs`, or now under the `no_session` waiver), on its
  origin row too, or writes the policy or raw-signing value as pending until `active_from`; records
  `{channel: "cli", emailed: "none"}`. Once per change.

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:add --app <app> --origin https://new.example.com --remote   # prints gc_…
  corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:changes:announce <gc id> --remote                                # in force 60 s later
  ```

- `app:suspend` / `app:resume` set and clear Hana's suspension bit (1) only; the org (2) and partner (4) bits belong to
  the admin and partner consoles (batch C), and an app stays suspended while any bit is set. Suspension is D1-only (the
  contract has no suspension; D11). Removing an origin also kills that origin's vault shares on their next use.
  Logins, relays, `GET /v1/app` and new vault page loads see a suspension or an origin removal at once; the vault
  endpoints (unlock, touch, revoke, share creation) cache the app per Worker isolate, so there it takes up to 30 s
  (D78).
- `app:list`: each app's org, environment, suspension bits, keys (revoked ones marked), origins in force and pending
  changes.
- `app:*` need `apps/api/wrangler.jsonc` for the env (`gen <env>` first) and run `wrangler d1 execute` from `apps/api`.
- `app:settings` (app positionally or with `--app`, not both; no setting flags: show them, with any proposals): ranges
  as the migration's CHECKs; `--raw-sign approval` (refused for a test app: test apps never sign raw, D39 as amended 2026-10-28) and a new
  `--auto-approve` policy are staff proposals (above; at most one pending policy per app); `off` and the other
  settings are immediate. A relative `--auto-approve` path is resolved against the directory you ran `pnpm` from
  (`INIT_CWD`), and the change log names the resolved file. The write only applies if `settings_version` and every
  settings column are still as the command read them: if someone else changed the app in between, nothing is written
  and the command fails with "The app's settings changed since they were read"; run it again. `--persistence none` revokes existing vault
  shares on their next unlock or touch; a lower `--session-ttl` also shortens live shares (to their creation + the new
  TTL). Plans other than `free` need a manual D1 insert.

Owner actions on a registered scope (add a client, change owners, enable shared login) go through
`POST /v1/owner-actions` with a console-client token (`docs/api.md`); there is no CLI for them yet. The endpoint caps
each owner identity, each scope and all owners together (D100); `cancel_change` has its own small allowance per owner
(5/min, 20/day) and a cancel-only ceiling outside those caps, so another owner or a flood can't use up a timelock's
cancel window.

**Cancelling a change when the API refuses (runbook).** OIDC owner auth doesn't depend on who sends the transaction:
if `/v1/owner-actions` is down or answers 429 while a change you didn't make is in its timelock, call the contract
directly from any funded testnet account with the same args (`{scope_id, auth: {"Oidc": {"jwt": "<fresh console
token>"}}, change_id}`), e.g. `near contract call-function as-transaction <signer> cancel_change json-args '…'
prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as <your account> network-config testnet sign-with-keychain
send`. The token is the same one the API would take: a console-audience Google token whose nonce commits to this call and
the scope's current `action_nonce` (`docs/contract-interface.md` "Owner-action nonce"). Never paste it anywhere it is
logged.

## Key rotation

### Relayer keys (either pool)

A leaked relayer key can burn its allowance but can't derive anyone's key.

1. Delete it on chain (the plan prints this command for blocked keys):

   ```sh
   near account delete-keys <relayer> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send
   ```

2. Remove it from `.secrets/<env>/relayer-keys.json` (or `owner-relayer-keys.json`), or move the file aside to get a
   whole new pool (then delete every old key on chain too: left there they keep their allowance).
3. `deploy-contract <env>`, then `--yes`: generates and adds the missing keys (saved before they go on chain).
4. Re-upload `RELAYER_KEYS` / `OWNER_RELAYER_KEYS` (step 7 above). A replaced key at an index makes its Durable Object
   ignore the old stored reservation and read the nonce from chain once.

A used-up allowance is replaced the same way. Allowances drop by gas burnt (refunds restore them; `docs/context.md`):
3 × 2 NEAR covered ~1,500 logins on testnet. Don't use pool keys outside the API: the objects assume they are the
only sender (another sender costs an `InvalidNonce` retry).

**Monitoring (D150).** The watchdog reads the relayer account every 5 min (check `relayer_funds`, read-only) and
alerts on its available balance (warning `relayer_balance_low` below 5 NEAR, critical `relayer_balance_critical`
below 1 NEAR) and on each pool key's remaining allowance (`relayer_allowance_low` / `relayer_allowance_critical`:
session pool below 0.5 / 0.1 NEAR, owner pool below 0.1 / 0.02 NEAR), and pages when a pool has no key
(`relayer_pool_empty`). The thresholds are the manifest's `watchdog.relayerFunds` (`apps/watchdog/README.md`
"Configuration"; raise the allowance pairs together with `--relayer-allowance` / `--owner-relayer-allowance`).
`/status` `relayer_funds` shows the last reading. The watchdog never tops anything up; a low balance is funded by
hand from a funded testnet account (never a mainnet one):

```sh
near tokens <funded testnet account> send-near <relayer> '<amount> NEAR' network-config testnet sign-with-legacy-keychain send
```

Recovery for each alert: [`relayer-out-of-funds`](playbooks.md#relayer-out-of-funds).

### Keys-updater key

On the governance contract (layout v2) the key's methods are exactly `set_issuer_key`, `propose_issuer_key_removal`,
`execute_issuer_key_change` (receiver `signer`, allowance ≤ 1 NEAR), and only the contract adds it
(`add_updater_key`, owner; on a DAO owner, a 2-of-3 `FunctionCall` proposal; ≤ 2 tracked at a time, so rotation has an
overlap). Access-key permissions can't be edited, so the v1 key (with `remove_issuer_key`) is deleted, not changed.
The API refuses to sign any other method with it (`apps/api/src/relayer-config.ts` `UPDATER_METHODS`);
`GET /v1/governance` shows `signerAccessKeys` with `updaterKey` / `updaterPermission` for the check.

To rotate: move `.secrets/<env>/keys-updater.json` aside, run `deploy-contract <env>` (plans `add_updater_key` of a
new key generated into the file), upload the new `KEYS_UPDATER_KEY`, then delete the old key with the owner's
`admin <env> owner:call delete_updater_key --args '{"public_key":"<old>"}'`.

If a watchdog deleted the key (it does when it sees a proposal from the signer that Google doesn't publish), the
cron's sends fail (`jwks_tx` `send_failed`) until the owner adds a new one: find out why first (the watchdog's alert
has the change). A deleted key is re-added from the file only if you leave the file in place: the plan warns, and a
key that may be compromised gets the move-aside rotation instead. The plan blocks on every function-call key on
`signer` the contract didn't install ([Blockers on the signer's keys](#blockers-on-the-signers-keys)).

v1 contract: the key was added by hand with `set_issuer_key` / `remove_issuer_key` (rotate: same steps as the relayer
keys with `.secrets/<env>/keys-updater.json`, then re-upload `KEYS_UPDATER_KEY`); the migration replaces it.

### Owner

- **Its key**: add a new full-access key, then delete the old one; make sure the keychain file the scripts read
  (`~/.near-credentials/testnet/<owner>.json`, else the first `<owner>/*.json`) is the new key. The `deploy-contract`
  dry run prints each role's local key and whether it is full access on chain.

  ```sh
  near account add-key <owner> grant-full-access autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send
  near account delete-keys <owner> public-keys <old ed25519:…> network-config testnet sign-with-legacy-keychain send
  ```

- **The account**: `set_owner(owner)` (immediate, owner only), then change `owner` in the manifest and check with a
  `deploy-contract` dry run:

  ```sh
  near contract call-function as-transaction <signer> set_owner json-args '{"owner":"<new owner>"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-legacy-keychain send
  ```

  This is the v1 contract. On the governance contract `set_owner` no longer exists: the owner calls
  `propose_owner(owner)` and, after `governance_delay_ms`, the new owner calls `accept_owner()`
  (`docs/contract-interface.md` "Owner transfer"). For the council DAO that is `deploy-contract <env>
  --transfer-owner` (twice: propose, then accept through a 2-of-3 proposal; [Governance
  migration](#governance-migration-sandbox-dev) step 5), which also rewrites `owner` / `ownerKind` in the manifest.
- **A council member**: `admin <env> council:replace-member --remove <old> --add <new>` ([Replacing a council
  member](#replacing-a-council-member)): a `RemoveMemberFromRole` and an `AddMemberToRole` proposal (2 of 3, then
  2 of 2), and the `council.members` edit in the manifest once both executed; then check with `admin <env>
  governance:status` and a `council-setup <env>` dry run (dev envs), which compares the DAO's policy with the manifest.

Scope owners (`--owner-near` / `--owner-google`) are separate: they change by a timelocked `SetOwners` owner action.

### Google signing keys (JWKS)

**Governance contract (layout v2).** Issuer keys change only through a public, cancellable delay
(`docs/governance-spec.md` "Rotation and logins"). The API cron (every 15 min, `apps/api/src/issuer-keys.ts`,
`docs/api.md` "Cron") proposes each new Google kid (`set_issuer_key` queues it), proposes the removal of a kid
missing from the JWKS for ≥ 55 min (never the last key), and executes matured changes that agree with Google's JWKS.
A watchdog normally confirms a new key within minutes; without one it goes live `issuer_key_delay_ms` after the
proposal, at the next cron run (or whoever executes it). Until then a token signed with it gets `503
issuer_key_pending` with `retry-after: 30` on `/v1/login` and `/v1/sessions`, and nothing is relayed. The cron never
cancels: a pending change it disagrees with (`jwks_sync_note` `unpublished_change` / `pending_mismatch` /
`removal_of_published_kid`) is the watchdog's and the owner's (`cancel_issuer_key_change`). A proposal of ours that
is cancelled logs `issuer_key_change_cancelled` once and is held for 1 h before the cron proposes it again.
The vault retries an `issuer_key_pending` login (`/v1/login`, or `/v1/sessions` in the split flow) once, after the
API's `retryAfterS` capped at 30 s, telling the partner page `loginProgress: key_pending` meanwhile; a second refusal
ends the login with `api_unavailable` ("try signing in again in a few minutes", `data.api: "503 issuer_key_pending"`).

To see the state: `curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'` (below). To execute
a matured change now (anyone may, the contract checks the delay):

```sh
near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send
```

**Syncing by hand.** To sync now (after a deploy, on a v1 contract, whose cron proposes nothing
(`key_changes_unavailable`), or when the cron has no `KEYS_UPDATER_KEY`):

```sh
corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --dry-run
corepack pnpm --filter @hana-id/scripts run post-google-keys <env>              # propose
corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --execute    # also execute due changes
```

It signs with the keys-updater key only (`--as-owner` is gone: an owner post waits the same delay, D86). On the
governance contract it proposes kids Google publishes that are neither active nor pending (`set_issuer_key`), proposes
removing active kids Google no longer publishes (`propose_issuer_key_removal`, never the last active key), and with
`--execute` runs `execute_issuer_key_change` for due changes, additions first. It never executes a pending add Google
doesn't publish (or with other key material), nor a removal of a kid Google still publishes: it prints those for the
watchdog or the owner to cancel. It never calls `remove_issuer_key` (owner-only now). On a v1 contract it still sets
and removes directly. It refuses to sync if Google returns no usable RS256 key.

### Governance status (`GET /v1/governance`)

A read-only JSON snapshot of the contract's governance state (`docs/api.md` "GET /v1/governance"): pause state,
delays and pending decreases, pending issuer-key changes with `executableAtMs`, `due` and Google's JWKS verdict
(`match` / `mismatch` / `absent` / `present`), watchdogs and their confirm power, updater keys against the signer's
access-key list, pending upgrade / owner transfer / withdrawal / console-audience and shared-client additions, and the
JWKS cron's last run and tracked proposals. Public, no key, cached 10 s.

```sh
curl -s <apiUrl>/v1/governance | jq '{paused, delays, keyChanges, pendingUpgrade, pendingOwner, pendingWithdrawal}'
curl -s <apiUrl>/v1/governance | jq '.signerAccessKeys[] | select(.updaterPermission | not)'   # outside sandbox-dev: must be empty
curl -s <apiUrl>/v1/governance | jq '.updater'                                                # the cron's last run
```

**Hand-off to batch C.** The admin portal's "Security & monitoring" view and the admin and partner consoles'
pending-upgrades page (D83, D86) don't exist yet. Their contract-side items read this endpoint (one request, already
normalised, with countdown inputs and JWKS verdicts), or the same views through the admin Worker's own RPC
(`docs/contract-interface.md` "Monitoring hand-off"); the portal should warn when a snapshot is older than
`readAtMs + 20 s` and must not treat the API as independent (it runs on Hana's main Cloudflare account). The council's
open proposals and the full list of sources are in [Governance status for the admin portal](#governance-status-for-the-admin-portal-batch-c-hand-off).
The watchdog's heartbeat, verdicts, actions log, alerts and acks come only from the watchdog service's `GET /status`,
`/alerts`, `/actions` and `POST /alerts/:id/ack` ([Watchdog service](#watchdog-service-appswatchdog)). Nothing here
alerts: alerts are the watchdog's (D85).

### Deploying the governance API

Order for an env moving to the governance contract (`docs/governance-spec.md` "Migration plan"):

1. Apply D1 migration `0005_issuer_key_sync.sql` (`wrangler d1 migrations apply <cloudflare.d1Name> --remote`), then
   deploy the API. It is safe on a v1 contract: logins work as before (v1 has no `paused`, and its `get_issuer` lists
   the same keys `verify_token` uses), the cron fetches and records the JWKS but proposes nothing
   (`key_changes_unavailable`, sync by hand meanwhile), and `/v1/governance` answers `502 near_unavailable`.
   Deployed before the migration, the cron logs `proposals_unavailable` / `proposal_record_failed` /
   `run_record_failed` (it still proposes, without the cancel hold) and `/v1/governance` has `updater: null`.
2. Upgrade the contract (`migrate_v1`, done on sandbox-dev; current code has no v1 migration, D154). From then on the
   v1 updater key can still call `set_issuer_key` (it now queues) but not the new methods: executions fail (`jwks_tx`
   `send_failed`) until step 3.
3. `add_updater_key(<new key>)`, upload it as `KEYS_UPDATER_KEY`, delete the v1 key ("Keys-updater key" above).
4. Check: `curl -s <apiUrl>/v1/governance | jq '{stateVersion, updaterKeys, signerAccessKeys, updater}'`.

### Pause

While `get_config().paused`, `/v1/sessions`, `/v1/login` and `/v1/derive` answer `503 paused` with `retry-after: 60`
and relay nothing (the contract would panic `Paused`); `/v1/sessions/revoke` and the vault's share endpoints are
unaffected, and the cron keeps proposing (executions wait). `/v1/owner-actions` isn't gated: its console-token
actions and `execute_change` fail on chain while paused (`422 contract_rejected`, paid from the small owner pool). The API reads the
pause state with `get_config`, cached 60 s (10 s while paused), so logins resume within 10 s of `unpause()`. Who
pauses and unpauses, and what each watchdog alert means, is the watchdog runbook (`docs/governance-spec.md`
"Alerts"); the API raises no alert.

### Link volume thresholds (D200)

The contract counts new links (a combined login with a `link_jwt`, or `link_identity`) per UTC hour, per scope and in
total, and records when a count reaches its alarm threshold (defaults 50 per scope and 500 in total). It never refuses
a link: the thresholds only decide when the watchdog alerts. A burst of links usually means a stolen email key
(`docs/security.md`); a large partner launch can look the same.

- **Check:** `near contract call-function as-read-only <signer> get_link_stats json-args '{}' network-config testnet
  now`: `thresholds`, `pending_thresholds`, and for the current and previous hour `total`, `total_threshold_reached`,
  `flagged_scopes`. On an alert, compare the flagged scope with the partner's plans and the email issuer's issuance for
  that app; if it isn't a launch, pause (the watchdog runbook).
- **Change:** `admin <env> owner:call set_link_thresholds --args '{"per_scope_per_hour":<n>,"total_per_hour":<m>}'
  [--approve-with <member>] --yes` (a council proposal; each value 1–100000). A lower value applies at once; a raise
  waits `governance_delay_ms` (`pending_thresholds` shows it) and the watchdog alerts on it.

### Issuer key lead times (D33)

D33's issuer-key delay must stay shorter than the time between Google publishing a signing key and Google signing
the tokens our users bring with it, or logins with a new key fail until the delay ends. The API measures it in D1
`issuer_key_observations` (migration `0004_issuer_key_observations.sql`; kids and timestamps only):

- **First / last seen in the JWKS, removed**: every cron run (every 15 min) fetches Google's JWKS for the sync and
  records each kid from that fetch. The API's verification fetches (on cache expiry, or on an
  unknown kid at most once a minute per isolate) add sightings. "Removed" is the first fetch without the kid after
  its last sighting; it is cleared if a later fetch lists the kid again (a stale Google frontend).
- **First token**: the first token with a valid signature by that kid on `/v1/sessions` or `/v1/login`, written after
  the response, at most once per kid per Worker isolate (the earliest write wins).
- **max-age**: the JWKS response's Cache-Control max-age the last time the kid was listed.

To turn it on in an env: apply the migration first (`wrangler d1 migrations apply <cloudflare.d1Name> --remote`), then
`gen <env>` (the cron trigger becomes `*/15 * * * *`) and deploy the API. Deployed the other way round, writes fail
with `key_observation_failed` warnings until the migration lands; logins are unaffected.

```sh
corepack pnpm --filter @hana-id/api run gen <env>        # wrangler.jsonc for the env, if not already
corepack pnpm --filter @hana-id/scripts run admin <env> issuer-keys:lead-times --remote
```

It prints, per kid, first seen in the JWKS, first token, the lead time (first token − first seen), the lifetime in
the JWKS (removed − first seen, or `…+ (listed)` while still published) and the last max-age, then the shortest lead
time. Reading it:

- A first sighting is up to 15 min after Google published the kid, so a lead time can read up to 15 min short.
- The first token is the first one *we* saw, not Google's first use; logins are sparse on sandbox envs, so a lead
  time there can read long. A rotation with no login in its window gives no lead time.
- A negative lead time (token before any sighting) or a row with no first sighting means a token arrived before any
  fetch listed the kid: Google used it within 15 min of publishing, and any delay longer than that breaks logins.
- The kid present when measurement started has its first sighting at that point, not at Google's publication: ignore
  its lead time. Collect several rotations (Google doesn't publish its schedule) before choosing the delay; set it
  well under the shortest lead time seen.

### `VAULT_KEK`

```sh
corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate          # read the plan
corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate --yes
```

`rotate` copies `.secrets/<env>/vault-kek` to `vault-kek.previous` and writes a new key with the next id to
`vault-kek.next` (both 0600) before touching the Worker, then sets `VAULT_KEK_PREVIOUS` (the current key) and
`VAULT_KEK` (the new one) through wrangler's stdin, then makes the new key `vault-kek`. If it stops part way, run it
again: it resumes with the same new key. It refuses while a previous rotation's `vault-kek.previous` is still there,
and needs `vault-kek` to hold the key the Worker has now (Cloudflare can't be asked).

Unlocks and the hourly cron re-wrap old rows (≤ 2000 per run). When no row is left under the old id:

```sh
corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = <old id>"
corepack pnpm --dir apps/api exec wrangler secret delete VAULT_KEK_PREVIOUS --name <cloudflare.workerName>   # once n is 0
rm .secrets/<env>/vault-kek.previous
```

Rows under an id neither secret has show as `unknownKek` (error level): they can't be unlocked until that key is back
(`vault-kek <env> put --yes` sets both secrets again from the files).

**KEK compromised (runbook, security sweep APIV-5).** Rotation alone doesn't help: it re-wraps the same `K_s` under
the new key, so whoever holds the old KEK and a D1 copy still has every live share's `K_s`. Revoke every share first,
then rotate:

```sh
corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "UPDATE vault_shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE revoked_at IS NULL"
corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate --yes
```

Every user with a persisted login signs in with Google again on their next visit (their device records can no longer
be unlocked). D1 backups and Time Travel still hold the old rows under the old KEK for their retention: treat them as
exposed for that long.

### Identity token keys

The partner identity token (`docs/identity-token-spec.md`, D127; `docs/api.md` "Identity token") needs a manifest block
and API Worker secrets, all made by `scripts/identity-key.ts` (D177). Files in `.secrets/<env>/` are 0600 and never
overwritten (Cloudflare can't give a secret back); values go to the Worker through wrangler's stdin; no command prints
a private value. Testnet and `local*` only: staging and mainnet sign with AWS KMS ("Identity token keys on AWS KMS"
below; `gen` and the schema refuse a Worker-secret key off testnet).

| File | Role | On the Worker |
|---|---|---|
| `identity-signing-key.json` | P-256 private JWK that signs now (`identityToken.signer.activeKid`) | yes, in the slot `identity-slots.json` names (`IDENTITY_SIGNING_KEY` or `IDENTITY_SIGNING_KEY_STANDBY`) |
| `identity-signing-key-standby.json` | published in the JWKS, the emergency switch | **no**: never uploaded until `switch --to standby`, so a leak of the Worker's secrets or the Cloudflare account doesn't reach it. Move the file offline (with the council backup, D81) and bring it back only to switch |
| `identity-signing-key-next.json` | a rotation's incoming key (`next`), published | no, until `switch --to next` |
| `identity-signing-key-previous.json` | the key a switch replaced, still published so its tokens keep verifying | yes, until `retire --key previous` deletes its slot |
| `identity-slots.json` | which Worker slot holds which kid (public data) | — |
| `identity-sub-key` | `IDENTITY_SUB_KEY`, base64 of 32 bytes. **Never rotated** (a new key changes every user's `sub` at every partner); back it up offline with the council backup (D81) | yes |

Every command below prints its plan without `--yes`. After `init`, `next`, `switch` and `retire`, put the changed
`envs/<env>.json` in the repo, run `gen` and deploy the API: the JWKS and the active kid come from the manifest.

```sh
S="corepack pnpm --filter @hana-id/scripts run identity-key <env>"
$S show                                   # the published kids, their roles and Worker slots (public values only)
```

**First setup (once per env):**

```sh
$S init --yes        # active + standby + sub key files; identityToken in envs/<env>.json; uploads the active key and IDENTITY_SUB_KEY
corepack pnpm --filter @hana-id/api run gen <env> --d1-id <id>   # IDENTITY_ISS, IDENTITY_PUBLIC_KEYS, IDENTITY_ACTIVE_KID, the bindings
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote   # 0008_identity_token.sql
corepack pnpm --filter @hana-id/api run deploy
curl -s <apiUrl>/v1/identity/jwks.json             # {"keys":[{…active…},{…standby…}]}, no "d"
```

Then move `identity-signing-key-standby.json` offline. `init` refuses when any identity file exists or the manifest
already has `identityToken`. `init --local --yes` uploads nothing (a `local*` env, or to upload later with `put --yes`,
which sets the active key in its slot and the sub key again). `gen --dev-vars` writes the active key and the sub key
into `apps/api/.dev.vars`, never the standby, and refuses a key that isn't the manifest's active one.

**Scheduled rotation** (every 12 months; 14 days' notice to partners that pin thumbprints, 24 h on testnet):

```sh
$S next --yes                 # a new key, published (manifest), uploaded nowhere → gen, deploy
# … wait the notice period …
$S switch --to next --yes     # uploads it into the free slot, makes it the active kid; the old key becomes "previous" → gen, deploy
# … ≥ 2 h later (tokens signed by the old key expire within 1 h) …
$S retire --key previous --yes   # unpublishes the old key, deletes its Worker secret, sets its file aside → gen, deploy
```

`switch` leaves both keys on the Worker until `retire`, so whichever manifest is deployed, a key with its active kid
is there. Run `retire` only after the switch's deploy. Retired key files are kept as
`identity-signing-key-retired-<kid prefix>.json` for a post-mortem; never commit them.

**Suspected compromise** (playbook `identity-signing-key-compromised` in `docs/playbooks.md`):

1. Decide what is exposed. A leak of the API Worker's secrets or the Cloudflare account exposes the active key only
   (the standby was never uploaded). A leak of `.secrets/<env>/` or the operator's machine exposes every key whose
   file was there, the standby too unless it was offline. **Unless the incident provably touches only the active key,
   treat both as exposed.**
2. Only the active key exposed: `$S switch --to standby --yes`, gen, deploy, then at once `$S retire --key previous
   --yes`, gen, deploy (no 2 h wait). Make a new standby with `$S next --yes` and move its file offline.
3. Both exposed: `$S retire --key standby --yes`, `$S next --yes`, `$S switch --to next --yes`, gen, deploy, then
   `$S retire --key previous --yes`, gen, deploy. Partners using the JWKS URL pick up the new kid at once and reject
   the removed ones within 10 minutes; tokens with up to 1 h left die then too.
4. Tell partners (security contacts): the `kid`, the window in which forged tokens may have been accepted, what to
   re-check. Pinning partners update their pins.

**Sub key leak.** Privacy, not funds: the holder can map partners' `sub`s to on-chain paths. Not rotatable without a
`u2_` scheme and a 90-day `legacy_sub` window (spec "`sub`").

### Identity token keys on AWS KMS

**Status: code only (build step 7, branch `feat/identity-token-7`), no env uses it.** The API's KMS signer
(`apps/api/src/identity/kms.ts`), the manifest's `aws-kms` signer, `gen`'s vars and the `identity-key kms-*` commands
are built and tested against a fake KMS. The AWS side below is the operator's setup, in D121's dedicated AWS account,
before staging's rehearsal and mainnet. sandbox-dev stays on the Worker-secret key. Moving an existing Worker-secret
env to KMS isn't scripted (it must keep `IDENTITY_SUB_KEY` and needs a rotation window), so KMS envs start with
`kms-init`.

How it signs (`docs/api.md` "Identity token"): the Worker hashes the token's signing input and sends one
`TrentService.Sign` (`MessageType: DIGEST`, `ECDSA_SHA_256`, SigV4) for the active key's ARN to
`kms.<that key's region>.amazonaws.com`, with no retry, a 3 s deadline and a 4 KiB answer cap. The DER answer is
converted to JOSE and verified with the published key before any token is answered (D216–D218). Every failure is
`503 identity_signer_unavailable`, logged `identity_sign_failed` with a `kms_*` code.

| What | Where | Notes |
|---|---|---|
| Identity keys: `active` and `standby`, during a rotation `next` and `previous` | AWS KMS, D121's account | `ECC_NIST_P256`, `SIGN_VERIFY`, origin `AWS_KMS` (generated in KMS, non-exportable), single-region (no `mrk-` keys: a replica shares its key material). The standby in another region than the active key (D219, the schema checks it). The same key policy on every key (below) |
| IAM user `hana-identity-signer` (one per env: the manifest's `credentials.iamUser`) | IAM, same account | No console password. Its only permission: `kms:Sign` on the **active** key's ARN, `ECDSA_SHA_256` and `DIGEST` only (D219). One access key in use (two during a rotation) |
| `IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY` | API Worker secrets | Set together by `kms-put-aws-key` (one `wrangler secret bulk`); rotated every 90 days and on suspicion |
| `identityToken.signer` | `envs/<env>.json` | `{kind: "aws-kms", credentials: {kind: "worker-secret", iamUser}, keys: {active: {kid, arn}, standby?: {kid, arn}, next?, previous?}}`; every published key has a role, all keys in one account (D215). `gen` writes `IDENTITY_SIGNER=aws-kms`, `IDENTITY_ACTIVE_KID` and `IDENTITY_KMS_KEY_ARN` (the active key's ARN only) |
| `IDENTITY_SUB_KEY` | Worker secret, `.secrets/<env>/identity-sub-key` | As on testnet: never rotated, backed up offline (D81). `kms-init` makes it |

Every `kms-*` command prints its plan without `--yes`, never calls AWS and never prints a credential.
`<key.json>` is the public data `aws kms get-public-key --key-id <arn> --output json` prints. After each manifest
change: commit `envs/<env>.json`, `gen`, deploy.

```sh
S="corepack pnpm --filter @hana-id/scripts run identity-key <env>"
$S show            # roles, kids and ARNs (public values only); warns when there is no standby
```

**Key policy** (every identity key; `<signer>` is `arn:aws:iam::<account>:user/<iamUser>`, `<admin>` the break-glass
role's ARN). It delegates `kms:Sign` to the signer user's IAM policy only, so the key the Worker can sign with is set
in one place, the IAM policy (D219). It denies signing to every other principal, grants to everyone, and key changes
to everyone but the break-glass role:

```json
{
  "Version": "2012-10-17",
  "Id": "hana-id-identity-key",
  "Statement": [
    {
      "Sid": "BreakGlassAdministers",
      "Effect": "Allow",
      "Principal": { "AWS": "<admin>" },
      "Action": ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetPublicKey", "kms:ListResourceTags", "kms:PutKeyPolicy",
                 "kms:EnableKey", "kms:DisableKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
                 "kms:TagResource", "kms:UntagResource", "kms:UpdateKeyDescription"],
      "Resource": "*",
      "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
    },
    {
      "Sid": "SignerSignsThroughItsIamPolicy",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<account>:root" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": {
        "ArnEquals": { "aws:PrincipalArn": "<signer>" },
        "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" },
        "Null": { "aws:TokenIssueTime": "true" }
      }
    },
    {
      "Sid": "NoOtherSigner",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<signer>" } }
    },
    {
      "Sid": "NoSessionCredentials",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "Null": { "aws:TokenIssueTime": "false" } }
    },
    { "Sid": "NoGrants", "Effect": "Deny", "Principal": "*", "Action": "kms:CreateGrant", "Resource": "*" },
    {
      "Sid": "OnlyBreakGlassChangesTheKey",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DisableKey",
                 "kms:EnableKey", "kms:UpdateKeyDescription", "kms:TagResource", "kms:UntagResource"],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<admin>" } }
    }
  ]
}
```

Never drop the `BreakGlassAdministers` statement: a key policy nobody can change can only be repaired by AWS Support.

**Only the long-term access key signs (D219).** Anyone holding the signer's access key can call
`sts:GetSessionToken`, which needs no permission and can't be denied by any policy, and get session credentials that
carry the user's permissions as they are at each call, including after a switch has put the standby in the IAM policy.
Deactivating or deleting the access key isn't proven to end such sessions (up to 36 h). So `Sign` is allowed only to
requests without `aws:TokenIssueTime` (long-term `AKIA…` credentials, which is what the Worker uses), and
`NoSessionCredentials` denies `Sign` to every request made with temporary credentials, the signer's sessions included.
**Confirm on staging** (a drill): a `GetSessionToken` session of the signer user is refused `Sign` (`AccessDenied`), and
the Worker's own `AKIA…` key still signs.

**The break-glass role.** `<admin>` is an IAM role in this account that operators reach with `sts:AssumeRole` and MFA
(its trust policy requires `aws:MultiFactorAuthPresent`; `aws configure` a profile with `role_arn` and `mfa_serial`).
Not an IAM Identity Center (SSO) permission set: those sessions don't carry `aws:MultiFactorAuthPresent`, so the
`Bool` condition fails and nobody can administer the key. Never delete or rename the role: a key policy names the role
by its unique id, so a recreated role of the same name isn't the same principal, and the keys lose their administrator
(repair: AWS Support). To bound a stale MFA session as well, add `"NumericLessThan": { "aws:MultiFactorAuthAge":
"3600" }` next to the `Bool` condition.

**The signer user's IAM policy** (inline, the user's only policy). The `Resource` lists the active key alone, and
during a switch the active and the incoming key; `NoOtherKey` lists the same ARNs, so even a policy attached to the user
by mistake can't let it sign with another key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignWithTheActiveIdentityKey",
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": ["arn:aws:kms:<region>:<account>:key/<active key id>"],
      "Condition": {
        "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" },
        "Bool": { "aws:SecureTransport": "true" },
        "Null": { "aws:TokenIssueTime": "true" }
      }
    },
    { "Sid": "NoOtherKey", "Effect": "Deny", "Action": "kms:Sign", "NotResource": ["arn:aws:kms:<region>:<account>:key/<active key id>"] },
    { "Sid": "NothingElse", "Effect": "Deny", "NotAction": "kms:Sign", "Resource": "*" }
  ]
}
```

There is no source-IP condition: Workers have no fixed egress addresses. The user can't manage its own access keys
(`NothingElse`); the break-glass role does.

**One-time setup (the operator, per env, as the break-glass role with MFA):**

1. **CloudTrail.** A multi-region trail in the account (or the organization trail) delivering to the log-archive
   account (D121), with management events **Read and Write** (`Sign` is a read event) and KMS events **not**
   excluded. Check that a `Sign` shows up (step 7).
2. **Keys.** One in the active region (for example `ap-east-1`) and one in a second region (for example
   `ap-southeast-1`), with the key policy above in `key-policy.json`:
   `aws kms create-key --region <region> --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --origin AWS_KMS --policy file://key-policy.json --description "hana-id identity <env> <role>" --tags TagKey=env,TagValue=<env>`.
   Then for each: `aws kms get-public-key --region <region> --key-id <arn> --output json > <role>.json` (public data).
3. **IAM user.** `aws iam create-user --user-name <iamUser>`, then `aws iam put-user-policy --user-name <iamUser>
   --policy-name identity-sign --policy-document file://signer-policy.json` (the active key's ARN).
4. **Manifest and sub key.** `$S kms-init --active active.json --standby standby.json --iam-user <iamUser> --yes`
   writes `identityToken` (refused unless the two keys are in two regions of one account), creates
   `.secrets/<env>/identity-sub-key` and sets `IDENTITY_SUB_KEY`. Commit the manifest; add both thumbprints to the
   watchdog's pins (build step 8).
5. **Access key.** `(umask 077; aws iam create-access-key --user-name <iamUser> > .secrets/<env>/identity-aws-access-key.json)`,
   then `$S kms-put-aws-key --yes`. It checks that the file is 0600, that the key belongs to the manifest's user, and
   that it is an active `AKIA…` key.
6. **Deploy.** `gen <env> --d1-id <id>` (writes `IDENTITY_SIGNER=aws-kms`, `IDENTITY_ACTIVE_KID`,
   `IDENTITY_KMS_KEY_ARN`), apply the migrations, deploy. The Worker must have no `IDENTITY_SIGNING_KEY*` secrets
   (`wrangler secret list`; delete leftovers).
7. **Check.** Mint a token from a test app: it verifies against the JWKS with the active kid, and the request's `sign`
   timing phase fits the 100 ms p95 budget (measure on staging). CloudTrail shows one `Sign` by the signer user on the
   active key. Then delete `.secrets/<env>/identity-aws-access-key.json`.
8. **Alarms** (EventBridge rules on CloudTrail events, to the paging app). Where and how:
   - Rule state **`ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS`**: a rule in the default `ENABLED` state doesn't
     receive read-only management events, and `Sign` and `GetSessionToken` are read-only.
   - The same KMS and STS rules in **both key regions** (KMS events are regional; a `GetSessionToken` on a regional
     STS endpoint is logged in that region), and the IAM and STS rules in **`us-east-1`** (IAM and the global STS
     endpoint log there).
   - The events: `PutKeyPolicy`, `DisableKey`, `ScheduleKeyDeletion` or `CreateGrant` on an identity key; any IAM
     change that could widen or reuse the signer user: `PutUserPolicy`, `DeleteUserPolicy`, `AttachUserPolicy`,
     `DetachUserPolicy`, `AddUserToGroup`, `PutUserPermissionsBoundary`, `DeleteUserPermissionsBoundary`,
     `CreateAccessKey`, `UpdateAccessKey`, `DeleteAccessKey`, `CreateLoginProfile`, and `PutGroupPolicy` /
     `AttachGroupPolicy` on any group the signer user is in (it should be in none); **`GetSessionToken` by the signer
     user** (`userIdentity.arn` = `<signer>`; the Worker never calls it, so any is a leaked key in use); any `Sign` on
     an identity key by another principal or with session credentials (the key policy refuses it, but the attempt
     matters).
   - **`Sign` volume per key:** KMS publishes no per-key request metric, so send the trail to a CloudWatch Logs log
     group (in each key region) and add a metric filter per key, e.g.
     `{ ($.eventSource = "kms.amazonaws.com") && ($.eventName = "Sign") && ($.resources[0].ARN = "<key arn>") }`, with an
     alarm on its hourly sum (a few times the API's `identity_issuance_hourly` peak). Plus an AWS Budgets alarm on
     KMS spend.
   Every planned change below fires one of them: acknowledge it.

`wrangler dev` doesn't run a KMS env: no AWS credentials go into `.dev.vars` (`gen --dev-vars` writes the sub key only
and refuses a leftover private signing key file). Local development uses a `local*` env with a Worker-secret key.

**Scheduled key rotation** (every 12 months; 14 days' notice to partners that pin thumbprints):

1. Create the new key in the **active key's region** (the standby keeps the other one), with the same key policy;
   `get-public-key` → `next.json`; `$S kms-add --role next --key next.json --yes` → gen, deploy (the JWKS lists it,
   nothing signs with it). Add its thumbprint to the watchdog's pins.
2. Wait the notice period.
3. IAM: list both ARNs (active and next) in the signer user's policy, in `SignWithTheActiveIdentityKey` and
   `NoOtherKey`.
4. **Pre-switch check** (below) on the next key.
5. `$S kms-switch --to next --yes` → gen, deploy. The old key is now `previous`, still published.
6. After ≥ 2 h: `$S kms-retire --key previous --yes` → gen, deploy. IAM: the new active ARN alone. KMS: `aws kms
   disable-key` and `aws kms schedule-key-deletion --pending-window-in-days 30` on the old key. Remove its pin.

**Pre-switch check** (before any `kms-switch`, once the IAM policy lists the target key): prove that the signer user
can sign with the target and that its signature verifies against the public key the manifest publishes for it. Only
the signer user may sign (`NoOtherSigner`), so this needs its access key: run it while
`.secrets/<env>/identity-aws-access-key.json` exists (right after creating an access key; a scheduled switch is a good
time to rotate it too). The credentials go into the AWS CLI's environment for one command and are never printed:

```sh
F=.secrets/<env>/identity-aws-access-key.json
printf 'hana-id pre-switch check %s' "$(date -u +%FT%TZ)" | openssl dgst -sha256 -binary > /tmp/check.digest
AWS_ACCESS_KEY_ID="$(jq -r .AccessKey.AccessKeyId "$F")" AWS_SECRET_ACCESS_KEY="$(jq -r .AccessKey.SecretAccessKey "$F")" \
  aws kms sign --region <target region> --key-id <target arn> --message fileb:///tmp/check.digest --message-type DIGEST \
  --signing-algorithm ECDSA_SHA_256 --output text --query Signature | base64 -d > /tmp/check.sig
jq -r .PublicKey <target>.json | base64 -d | openssl pkey -pubin -inform DER -out /tmp/target.pem
openssl pkeyutl -verify -pubin -inkey /tmp/target.pem -in /tmp/check.digest -sigfile /tmp/check.sig   # "Signature Verified Successfully"
```

`<target>.json` is the `get-public-key` file `kms-add` published (its kid is in the manifest). This `Sign` is in
CloudTrail with no token behind it: note its time for the reconciliation.

**Access key rotation** (every 90 days, and at once on suspicion):

1. `(umask 077; aws iam create-access-key --user-name <iamUser> > .secrets/<env>/identity-aws-access-key.json)`. IAM
   allows two keys per user: delete an old inactive one first if there are two.
2. `$S kms-put-aws-key --yes`: one request sets both secrets, so the Worker never pairs the new id with the old secret.
3. Mint a token; CloudTrail shows a `Sign` with the new access key id.
4. `aws iam update-access-key --user-name <iamUser> --access-key-id <old id> --status Inactive`; after a day with no
   use (`aws iam get-access-key-last-used`), `aws iam delete-access-key`. Delete the `.secrets` file.

**Suspected compromise** (a leaked access key or Worker secrets, an API Worker or Cloudflare account incident, an
unexplained `Sign` in CloudTrail, a forged token reported by a partner; planned playbook
`identity-kms-signer-compromised`):

1. **Stop the signatures:** `aws iam update-access-key … --status Inactive` for every access key of the signer user.
   Mints answer 503 from then on, and partners fall back to no token. Deactivating a key alone isn't proven to end
   session credentials made from it with `GetSessionToken`: what stops those signing is the key policy's
   `NoSessionCredentials` deny (confirm it is in every identity key's policy, `aws kms get-key-policy`), not the
   deactivation.
2. **Measure:** the CloudTrail events whose `userIdentity.arn` is the signer user (every credential it has, sessions
   included; not by access key id, which misses session keys): `GetSessionToken` calls, refused `Sign` attempts, and
   successful `Sign`s by key, window and count. With D219 the standby can't have been used (the IAM policy never
   listed it, sessions can't sign); confirm it has no successful `Sign` events.
3. **Switch:** the IAM policy → the standby's ARN (both statements); a new access key → the pre-switch check →
   `$S kms-put-aws-key --yes`; `$S kms-switch --to standby --yes` → gen, deploy.
4. **Unpublish:** `$S kms-retire --key previous --yes` → gen, deploy (no 2 h wait); disable the old key and schedule
   its deletion; remove its pin.
5. **New standby:** a new key in another region than the new active key; `$S kms-add --role standby --key <file>
   --yes` → gen, deploy; pin it.
6. **Tell partners:** the `kid`, the window and count from CloudTrail, what to re-check. Post-mortem (D83).

A KMS outage in the active region (`kms_unreachable`, `kms_internal` or `kms_timeout` in the logs, mints at 503) isn't
a compromise. Either wait it out (partners fall back to no token), or switch to the standby as in step 3 without
revoking anything. To make the old key the standby again later: `kms-retire --key previous`, then `kms-add --role
standby` with its `get-public-key` file.

**Reconciliation (planned, not built; before mainnet).** An hourly job counts the CloudTrail `Sign` events per identity
key and UTC hour (`userIdentity.arn` = the signer user, no `errorCode`) and compares them with `identity_issuance_hourly` (the tokens the
API answered, per kid and hour). Each answered token is one `Sign`, so CloudTrail's count is at least the API's. The
difference must be explained by `Sign` calls that succeeded at KMS but produced no token (a timeout after KMS signed,
a garbled or unverifiable answer), which today are only in the logs (`identity_sign_failed` with `kms_timeout`,
`kms_bad_answer`, `kms_bad_signature` or `self_verify_failed`). A gap beyond that, any `Sign` by another principal or with session credentials, or any
`GetSessionToken` by the signer user, is a critical alert: a signature Hana's API didn't make. To make the check exact, the job's build adds a per-hour,
per-kid count of the `Sign` requests the API sent (D218). Where it runs (the watchdog's account, D125, with a
read-only principal on the log-archive bucket or `cloudtrail:LookupEvents`) is decided with it.

### A user's leaked key (`key_index`)

The path is `{scope_id}#{provider}#{sub}#{key_index}`, so a new `key_index` is a new key and new addresses. Rotation
is not built (`docs/batch-b-spec.md`, "Key rotation hooks"): the vault fixes `keyIndex = 0`, nothing on chain marks an
index retired, and the old key stays derivable by whoever can sign in as that user. Today: the user moves funds
using a session at the old index and logs in with another `keyIndex` (`apps/smoke` has a `key_index` field). Values
≥ 2^31 are reserved and refused.

## Smoke test (`apps/smoke`)

Needs a deployed env (contract, Google keys, API with secrets and `VAULT_KEK`, the vault and auth page Workers,
`apiUrl`, `vaultOrigin`, `authOrigin` and `ckdNetworkKey` set), an app whose origins include `http://localhost:5173`
with a `pk_test_` key in a `sandbox*` / `local*` env, `{authOrigin}/login/callback` on the clients' redirect URIs and,
for the direct page, `http://localhost:5173` on their JavaScript origins.

```sh
corepack pnpm --filter @hana-id/smoke dev                                   # envs/sandbox-dev.json
VITE_HANA_ENV=<env> corepack pnpm --filter @hana-id/smoke dev
VITE_HANA_API_URL=http://localhost:8787 corepack pnpm --filter @hana-id/smoke dev   # local wrangler dev (the pages' own calls only)
```

Restart it after editing the manifest. Two pages: `/` logs in through the vault (`@hana-id/web`, `POST /v1/login`), as a
partner would; `/direct.html` is the in-page `/v1/sessions` + `/v1/derive` flow, kept as the ship gate's split-flow
baseline and for what the vault can't do (`key_index` ≠ 0, replays). The direct page uses Google Identity Services
tokens (they carry `email`), so it works only while `REJECT_PII_ON_SESSIONS` is `"0"`. The checklist (login, isolation,
own vs shared client, persistence and unlock, Safari/WebKit retention, logout, revoke, export, approval and
auto-approve, the ship gate, the BLS precheck CPU time, replays, gas) is in `apps/smoke/README.md`.

- The ship gate compares vault logins with direct-page sessions **against the same API**: the vault always calls the
  manifest's `apiUrl`, so direct-page runs made with a `VITE_HANA_API_URL` override are left out (the panel says how
  many). Measure the split side without the override.
- The demo auto-approve policy path is relative to `scripts/` (pnpm runs the admin script there):
  `admin <env> app:settings <app> --auto-approve ../apps/smoke/policies/demo-auto-approve.json --remote`.
- A replayed derive is refused by the API (`409 counter_used`) before anything is relayed: no transaction, no gas.

## Browser tests (`apps/e2e`, Playwright)

The real vault, login, approval and export bundles and the partner client in Chromium, WebKit and Firefox, against a
local stack: apps/api's Worker run in Node (only `/v1/login` and `/v1/derive` mocked), a mocked NEAR RPC, MPC and EVM
RPC, and an OIDC stub for Google. No testnet, no secrets. Details: `apps/e2e/README.md`.

```sh
corepack pnpm --filter @hana-id/e2e e2e:install          # once: the browsers
corepack pnpm --filter @hana-id/e2e e2e                  # build, start the stack, run all three browsers
HANA_E2E_PORT_BASE=4510 corepack pnpm --filter @hana-id/e2e e2e   # a second worktree at the same time
```

- Ports are `HANA_E2E_PORT_BASE` (default 4410) to base + 50. Outside CI Playwright reuses a stack already listening
  there; the global setup fails the run unless it is this checkout's current stack (fingerprint on
  `/__e2e/health`). On "not this checkout's current e2e stack": stop the other stack or use another base.
- A base that puts a port on one of the Fetch standard's blocked ports (5060/5061 SIP, 6000, 6665–6669, 10080, …) is
  refused at once: browsers never connect there. 5010 is one (its EVM RPC would be 5060); use 5110, for example.
- CI (`.github/workflows/ci.yml`, job "Playwright") retries a failed test once to keep its trace, but a test that
  passes only on the retry fails the job (`failOnFlakyTests`). The report and traces are uploaded on failure.

## Hosted demo (`apps/demo`)

A partner-style page on `@hana-id/web` so colleagues can try Hana ID on testnet from a URL: login, addresses with
explorer links, `personal_sign` / Stellar message / a Base Sepolia test transaction (signed, never broadcast), export,
logout, "log out other devices", login timings and a *Copy diagnostics* report (no tokens, keys, signatures or relay
ids). Details: `apps/demo/README.md`.

| | sandbox-dev |
|---|---|
| URL | `https://hana-id-demo-sandbox-dev.tingtc.workers.dev` (Worker `hana-id-demo-<env>` on the subdomain of the manifest's `apiUrl`) |
| App | Smoke B, `pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie` (shared Google client); `HANA_DEMO_PUBLISHABLE_KEY` overrides it |
| Env | `HANA_DEMO_ENV` (default `sandbox-dev`); only testnet `sandbox*`/`local*` envs whose API is on workers.dev |

```sh
# once per app: the vault loads only on the app's origins (needs apps/api/wrangler.jsonc: `gen sandbox-dev`); a staff
# proposal: announce the gc_… id it prints, and the origin is in force 60 s later (appChangeDelayMs)
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:add \
  --app pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie --origin https://hana-id-demo-sandbox-dev.tingtc.workers.dev --remote
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:changes:announce <gc id> --remote

corepack pnpm --filter @hana-id/demo run deploy      # gen:envs, vite build, gen (apps/demo/wrangler.jsonc), wrangler deploy
corepack pnpm --filter @hana-id/demo run build && corepack pnpm --filter @hana-id/demo run gen \
  && corepack pnpm --filter @hana-id/demo exec wrangler deploy --dry-run   # check without deploying
```

- The Worker sets the page's CSP (`frame-src` exactly `vaultOrigin`, `connect-src` exactly the EVM RPC, no inline
  code, `frame-ancestors 'none'`, Trusted Types) and `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP
  `same-origin-allow-popups` on every response; preview URLs are off and it answers only on its own origin.
- Redeploy after changing `envs/<env>.json` (the vault origin is in the CSP and the bundle) or `@hana-id/web`.
- "Could not load the Hana vault" on the demo: the origin isn't in force on the app (`app:origins:add` and
  `app:changes:announce` above, then 60 s), or the build is for another env. `admin <env> app:list --remote` shows the
  app's origins in force and its pending changes.
- Removing the origin (`app:origins:remove`) signs out everyone who used the demo, on their next use.

## Watchdog service (`apps/watchdog`)

The independent watchdog of the governance batch (`docs/governance-spec.md` "Watchdog service", D82–D86): every
5 min it compares the contract's pending and active issuer keys with Google's JWKS, cancels a pending key Google
doesn't publish (and deletes the updater keys if the updater proposed it), pauses only when such a key is **active**,
confirms keys that match, alerts on every governance change, and serves a read-only status for the admin portal.
What it checks and its status API: `apps/watchdog/README.md`. **Deployed on sandbox-dev (2026-10-30; redeployed 2026-11-02
with batch 5's email rules and link alarms, version b156e1b5, no new migration: on the v2 contract it reads "no email
issuer" and skips the link check)**:
`https://hana-id-watchdog-sandbox-dev.tingtc.workers.dev`, cron `*/5 * * * *`, on the API's Cloudflare account
(D125), D1 `hana-id-watchdog-sandbox-dev`. First deployed with no channel and no heartbeat; first run
2026-10-30 04:50 UTC, every check ok; the cron trigger started ~10 min after the first deploy (two slots skipped).
Since the drills the same day, the pager is a random ntfy.sh topic and the heartbeat a healthchecks.io check (both
secrets only). Slack and email are still not set up (no Slack webhook; the manifest's alert addresses are
`example.com` placeholders), so every run reports those channels as `channel_not_configured` (`/status` `channels`
shows which are configured). **ntfy.sh's public server rate-limits
publishers per IP, and Workers send from shared IPs**: in the forged-key drill (2026-10-30) the critical page got
HTTP 429 at 05:06 and 05:40 and went through at 05:10 and 05:25, so it is not a production pager (the choice is
open: `docs/context.md` "Next steps" 8). Forged-key drill: change #0 posted 05:01:17, cancelled and the updater
key deleted at 05:06 (one run); a new updater key was installed through the council (proposal #2) and uploaded as
`KEYS_UPDATER_KEY`; the old key file is kept as `.secrets/sandbox-dev/keys-updater.revoked-20261030-drill.json`.
Pause drill (same day): the cron trigger removed, a forged key posted 05:51:58 and executed 05:54:25 (active);
the trigger removal hadn't propagated, so a run at 05:55:05 found it and paused within 40 s; the council removed it
(`owner:call remove_issuer_key`, proposal #3) and unpaused (#4). Heartbeat: last ping 05:55:15, healthchecks.io
reported the check down at 06:10:15 (period 5 min + grace 10 min) by email. **Cron trigger changes take minutes to
apply** (start ~10 min after the first deploy; one run after removal): stop a watchdog by deleting the Worker's
trigger and checking `/status` `last_run`, not by assuming. Other envs: not
deployed; each is created with `new` on current code.

### Setting it up (once per env)

It runs on **its own Cloudflare account** (separate login and MFA from the API's account, D86, D125); `gen` writes
that account's id into the config, so `wrangler deploy` lands it only on that account. **sandbox-dev is the
exception** (D125): its watchdog uses the same Cloudflare account as its API, for the drills only. Deploy it by hand
from a founder's machine, never from CI. The alternative host kept on file is AWS Lambda in a dedicated AWS account
(D125, with what the port changes). Run every `wrangler` command
below logged in to the watchdog's account (`wrangler login` there, or `CLOUDFLARE_API_TOKEN` for it).

1. Create the watchdog's NEAR account (`watchdog.account`, e.g. `hana-id-watchdog-dev1.testnet`, ≈ 2 NEAR; its
   full-access key stays in `~/.near-credentials`, like the other accounts) and add the `watchdog` block to
   `envs/<env>.json` (`envs/README.md`), with `watchdog.account` also in `watchdogs` (the schema requires it).
2. The owner adds it: `deploy-contract <env>` plans `add_watchdog(<watchdog.account>)` for every `watchdogs` entry
   that exists on chain (on a DAO owner, as a proposal; cancel and pause powers at once, confirm power after
   `governance_delay_ms`).
3. Secrets: `corepack pnpm --filter @hana-id/watchdog secrets <env> init` writes `WATCHDOG_KEY` and
   `WATCHDOG_STATUS_TOKEN` to `.secrets/<env>/watchdog-secrets.json` (0600) and prints the public key with the near
   CLI command that installs it (function-call key on `watchdog.account`, receiver `signer`, methods
   `cancel_issuer_key_change, confirm_issuer_key_change, pause, delete_updater_key`, 1 NEAR allowance). Run that
   command. Then paste into the same file the watchdog's own `RESEND_API_KEY` (D87), `SLACK_WEBHOOK_URL`, the paging
   app's credentials (`NTFY_TOPIC_URL` [+ `NTFY_TOKEN`], or `PUSHOVER_TOKEN` + `PUSHOVER_USER` for a group of both
   founders, or `PAGERDUTY_ROUTING_KEY`) and `HEARTBEAT_URL`; `secrets <env> check` lists what is missing (names
   only).
4. Dead-man's switch: a check on a third provider (healthchecks.io, Better Stack, Cronitor) with a 5-min period and
   ~10-min grace, alerting both founders on its own; its ping URL is `HEARTBEAT_URL`.
5. D1 and deploy (from `apps/watchdog`, logged in to the watchdog's account):

   ```sh
   corepack pnpm --dir apps/watchdog exec wrangler d1 create <watchdog.cloudflare.d1Name>    # prints the id
   corepack pnpm --filter @hana-id/watchdog gen <env> --d1-id <uuid>                          # apps/watchdog/wrangler.jsonc
   corepack pnpm --dir apps/watchdog exec wrangler d1 migrations apply <d1Name> --remote
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

6. Check: `curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)"
   https://<workerName>.<subdomain>.workers.dev/status` shows `last_run.outcome: "ok"`, `first_run: true` on the
   first run, `heartbeat.ok`, every channel `configured`. The first run alerts critical on any active kid not in
   Google's JWKS (no pause) and on anything already pending: acknowledge after checking. Then send a test critical
   page to both founders (the forced-rotation drill of the migration plan does this for real).
7. The admin Worker (batch C) gets the same `WATCHDOG_STATUS_TOKEN` and the watchdog's URL.

Local: `gen <env> --dev-vars` writes `apps/watchdog/.dev.vars` (0600) from the secrets file; `corepack pnpm --filter
@hana-id/watchdog dev` runs `wrangler dev --test-scheduled` (`curl localhost:8787/__scheduled` runs one cron). Use a
test Slack channel and ntfy topic: local runs send real alerts and, with a real `WATCHDOG_KEY`, real testnet
transactions.

Rotating its secrets: `WATCHDOG_KEY`: add a new function-call key (as in step 3), put it in the file, `wrangler secret
put WATCHDOG_KEY`, then delete the old key on chain. `WATCHDOG_STATUS_TOKEN`: change it on both Workers. The others:
replace in the file and `wrangler secret put`.

### Email login: pins, link alarms, unrecorded wallets

The watchdog also checks Hana's email issuer (`docs/email-login-spec.md` "Watchdog", D190–D193), against the
manifest's `watchdog.pinnedIssuerKeys.email` (`envs/README.md`). The pins are public thumbprints, not secrets; they
come only from the watchdog's own manifest, never from the chain or Hana's JWKS.

- **Pins before keys.** With no pins, every email key is unpinned: the watchdog cancels a pending one and pauses on an
  active one. So the order on an env is: write the thumbprints of the issuer's keys (primary, standby: batch 4's
  `scripts/email-issuer.ts init` prints them; `corepack pnpm --filter @hana-id/watchdog pin <public key file>` prints
  the pin of any public JWK, JWKS or PEM with the Worker's own function, and says whether a JWKS kid matches) under `pinnedIssuerKeys.email.signers.hana` with `required: 1`, then
  `corepack pnpm --filter @hana-id/watchdog gen <env>` and `corepack pnpm --dir apps/watchdog exec wrangler deploy`
  (no new D1 migration), and check `/status` `email.pinned`; only then does the council run `set_issuer("email", …)`,
  `mark_self_issued("email")` and `set_issuer_key(…, signer: "hana")` (build plan batch 6). Between `set_issuer` and
  `mark_self_issued` a `signer_policy_transition` warning and the `governance_change` alerts are expected.
  A v2 contract (sandbox-dev today) reads as "no email issuer": nothing is alerted, pins or not.
- **Rotating an email key**: pin the new thumbprint first (redeploy), then the council posts it; it waits
  `governance_delay_ms` and is never confirmed early (info `self_issued_key_change`); anyone executes it after.
- **A signer-policy upgrade** (Level 1 co-signer, or replacing a signer): pin the new signer's keys before the upgrade
  executes with the current `required`; raise the pinned `required` (or drop the old signer) after it executed (D191).
  The reverse order reads as a weaker policy and pauses. The upgrade's 10-minute overlap shows as a
  `signer_policy_transition` warning; a longer one pauses (D191).
- **Link alarms** (D200): the contract counts new links per scope and in all per UTC hour and flags a scope (or the
  total) whose links reach its alarm threshold (default 50 per scope, 500 in all; `set_link_thresholds` by the council:
  lowering applies at once, raising waits `governance_delay_ms`). Nothing is refused. The watchdog reads
  `get_link_stats()` each run: a threshold reached pages `link_threshold_reached`, half the total threshold warns
  `link_volume_high`, a raise is a critical `governance_change`. A partner launch needs no action; change a threshold
  only if the alarm level is wrong for real traffic. `/status`
  `link_stats` shows both windows. A contract without the view warns `link_stats_unavailable` once an email issuer is on
  chain, so the D200 contract must be deployed before email goes live.
- **`unrecorded_wallets`** (D135, D139): sandbox-dev accepts after its v3 upgrade (`admin <env> owner:call
  accept_unrecorded_wallets`); on any env that isn't `local*` or `sandbox*` the watchdog pages while it is true.

### Watchdog alerts (runbook)

Critical alerts page both founders (paging app + Slack + email) and are re-sent every 15 min until someone
acknowledges them in the admin portal (or in Pushover). Acknowledging stops only the re-sends. Every alert's text
names its id, its kind and its playbook (`Playbook: <id>`); the full details are in `GET /alerts`, and `GET /status`
`alert_kinds` gives each kind's `playbook`.

**What to do is in the playbooks**: [`docs/playbooks.md`](playbooks.md), generated from `packages/playbooks` (D126),
the same source the admin portal's "Security & monitoring" view renders. Each one has the signals, the impact, the
ordered steps with who acts (the council, a founder, anyone, the watchdog, the API cron, scope owners, the user) and the real commands, how
to verify, and the follow-ups. A test fails when an alert kind has no playbook (`apps/watchdog/test/registry.test.ts`).
This table only says what each kind means:

| Kind | What it means | Playbook |
|---|---|---|
| `forged_key_change` | A pending issuer key Google doesn't publish (or with other material; not one Google published with the same material in the last 24 h, which is a `retired_key_change`), a pending email key whose RFC 7638 thumbprint isn't pinned for its signer in `watchdog.pinnedIssuerKeys.email` (`reason`: `not_pinned`, `other_signer`, `kid_not_thumbprint`, `no_signer`; with no pins at all every email key is unpinned, D190), or any change the updater (the signer account) proposed for a provider other than Google (`reason: updater_other_provider`: the updater only serves Google). The watchdog cancelled it and, if the updater proposed it, deleted every updater key. The title and `details.outcome` say what happened: `cancelled`; `gone` (someone else cancelled it first); `executed` (it took effect before the cancel: also a `protective_action_failed`, and the run pauses on the now-active key); `unknown` (gone, and the re-read failed); `failed`; `not_sent` (the watchdog couldn't act) | [`forged-key-change`](playbooks.md#forged-key-change) |
| `retired_key_change` | Warning, not a page (D153): the updater proposed a kid Google no longer publishes but published with the same `n`/`e` within 24 h (`details.last_seen_jwks_at`): the API cron's fetch raced Google's retirement of the kid. Cancelled, the updater keys kept | [`retired-key-change`](playbooks.md#retired-key-change) |
| `forged_active_key` | A key Google doesn't publish, or an email key that isn't pinned (`details.provider: email`; also at the first run: pins are configuration, D190), is **active**: the contract is paused (logins and derivation stop) and every updater key deleted (D126). While it was active, anyone holding its private key could open sessions for any user's path and post OIDC-owner tokens and client proofs. Recovery runs in a fixed order: remove the key, raise the session floor past the pause (`set_sessions_valid_from_ms`), a fresh updater key, unpause; the watchdog pauses again (and deletes any new updater key) while the key stays active | [`forged-active-key`](playbooks.md#forged-active-key) |
| `published_key_removal` | A pending removal of a kid Google still publishes (logins with it would break). Alert only: the owner decides and cancels | [`published-key-removal`](playbooks.md#published-key-removal) |
| `unknown_active_key_first_run` | First run only: an active kid not in Google's JWKS today (often an old kid Google dropped), or with other material (then the next run pauses) | [`unknown-active-key-first-run`](playbooks.md#unknown-active-key-first-run) |
| `unverifiable_key_change` | A pending change the owner proposed for an issuer other than Google and email (the watchdog has neither a JWKS nor pins for it; one the updater proposed is a `forged_key_change`) | [`unverifiable-key-change`](playbooks.md#unverifiable-key-change) |
| `signer_policy_mismatch`; warning `signer_policy_transition` | The email issuer on chain (`get_issuer("email")`, `get_self_issued("email")`) differs from the pins. Critical and **paused** when the chain's policy is weaker (a lower `required`, a signer the pins don't list, active email keys with no signer policy, an overlap with the previous policy longer than the contract's 10 min + 5 min, D191); critical, no pause, for an email issuer nobody pinned or a pre-v3 one. Warning, no pause, for what a planned change passes through: a pinned signer not in the policy yet, the `set_issuer("email")` → `mark_self_issued("email")` gap, a higher `required` on chain, a normal overlap | [`signer-policy-mismatch`](playbooks.md#signer-policy-mismatch) |
| `unrecorded_wallets` | `get_config().unrecorded_wallets` is true on an env that isn't a dev env (D139): links are refused until the owner calls `accept_unrecorded_wallets`; it must never show on mainnet. Alert only | [`unrecorded-wallets`](playbooks.md#unrecorded-wallets) |
| `governance_change` | An upgrade proposal or execution, owner transfer, withdrawal, watchdog, updater-key, delay or console-audience change, pause or unpause (`unpaused_at_ms` shows one that fell between two runs), a raised session floor (`sessions_valid_from_ms`), a change of the owner DAO's code or policy (`owner_code_hash`, `owner_policy`: a `ChangePolicy`, `AddMember` or `RemoveMember`), `mpc`, `ckd_domain_id` or `state_version`, `unrecorded_wallets`, or the owner's immediate issuer actions, which leave no pending state: `issuer` (`set_issuer` changed Google's iss values) and `issuer_keys` (an active kid disappeared without a pending removal leaving the queue: `remove_issuer_key`; also a removal proposed and confirmed by another watchdog between two runs), and the same for the email issuer (`email_issuer`, `email_issuer_keys`) and its signer policy (`email_signer_policy`: `mark_self_issued`, or an upgrade's `migrate`). Alert only. Nobody but the owner can cancel an upgrade (D84) | [`governance-change`](playbooks.md#governance-change) |
| `automatic_action` | The watchdog acted again for an incident it already alerted (e.g. paused again after an unpause, or deleted an updater key added while a forged key is still active) | [`watchdog-acted-again`](playbooks.md#watchdog-acted-again) |
| `protective_action_failed` | A cancel, pause or updater-key deletion the watchdog sent failed, or a forged change it tried to cancel was executed first (or it couldn't tell) | [`protective-action-failed`](playbooks.md#protective-action-failed) |
| `not_a_watchdog`, `watchdog_key_missing`, `wrong_network`, `pins_invalid` | The watchdog can't act: its account isn't a contract watchdog, its key is missing or bad, or its RPC is on another chain; until fixed nothing cancels forged keys. `pins_invalid`: `EMAIL_PINS` is unreadable, so every email key counts as unpinned (cancelled, paused on; their alerts say `pins_unreadable`) | [`watchdog-cannot-act`](playbooks.md#watchdog-cannot-act) |
| warning `rpc_failing`, `jwks_failing`, `heartbeat_failing`, `channel_not_configured` | The watchdog is partly blind or mute (a dead watchdog is caught by the dead-man's switch: [`watchdog-down`](playbooks.md#watchdog-down)) | [`watchdog-degraded`](playbooks.md#watchdog-degraded) |
| warning `unexecuted_key_change`, `stale_active_key` | A matured key change nobody executed (> 1 h), or an active kid Google dropped > 3 h ago | [`key-sync-stalled`](playbooks.md#key-sync-stalled) |
| warning `active_key_material_unavailable` | The contract has no `get_issuer_keys` (older code): active keys are checked by kid only | [`active-key-material-unavailable`](playbooks.md#active-key-material-unavailable) |
| warning `config_change` | Shared clients, sponsors or public registration changed | [`config-change`](playbooks.md#config-change) |
| `relayer_balance_critical`, `relayer_allowance_critical`, `relayer_pool_empty`; warning `relayer_balance_low`, `relayer_allowance_low` | The relayer account's available balance, or a pool key's remaining allowance, is below its threshold (defaults: balance 5 / 1 NEAR; session key 0.5 / 0.1; owner key 0.1 / 0.02; manifest `watchdog.relayerFunds`), or a pool has no key: relays from it fail once it runs out. Read-only: the watchdog never tops up | [`relayer-out-of-funds`](playbooks.md#relayer-out-of-funds) |
| warning `confirm_failed` | A confirmation of a key that matches Google's JWKS failed: it goes live only after the full delay | [`confirm-failed`](playbooks.md#confirm-failed) |
| warning `email_jwks_mismatch` | Hana's published email JWKS lists a key that isn't pinned (or whose kid isn't its thumbprint), lacks an active email key, or failed 3 fetches while email keys are active. Informational: the contract never reads it | [`email-jwks-mismatch`](playbooks.md#email-jwks-mismatch) |
| `link_threshold_reached`; warning `link_volume_high`, `link_stats_unavailable` | `get_link_stats()` (D200): links reached an alarm threshold in the current or previous UTC hour, in one scope or in all; they went through (the contract refuses nothing): a partner launch, or a stolen email key taking over Google wallets by linking (alert only; the council decides whether to pause); the current hour at half the total threshold; or the view is missing with an email issuer on chain, malformed or failing (`link_stats_unavailable:missing` / `:malformed` / `:read_failed`; only the link check is affected, every protective step still runs) | [`link-volume`](playbooks.md#link-volume) |
| info `key_change_confirmed`, `key_change_executed`, `key_change_cancelled` | Routine key-change events | [`key-change-lifecycle`](playbooks.md#key-change-lifecycle) |
| info `self_issued_key_change` | A pending email key pinned for its signer, or a pending email key removal: never confirmed (self-issued keys wait `governance_delay_ms`) | [`self-issued-key-change`](playbooks.md#self-issued-key-change) |
| info `config_matured` | A scheduled delay decrease or console-audience addition came into force | [`config-matured`](playbooks.md#config-matured) |
| info `first_run` | The first run recorded Google's current JWKS as known | [`watchdog-first-run`](playbooks.md#watchdog-first-run) |

Incidents the watchdog doesn't raise (a stolen updater or relayer key, `VAULT_KEK`, a compromised API, origin,
watchdog or council member, a pause, Google, RPC, MPC or D1 outages, compromised Google clients, a leaked user key,
and the planned email issuer) have their playbooks in the same file.

A paused contract: only the owner unpauses (`unpause`, no delay, D82). An unpause re-arms the scope-change timelock:
no `execute_change` before `unpause time + change_delay_ms` (`changes_unlock_floor_ms`, also in `get_scope` as each
pending change's `unlock_at_ms`), since OIDC owners couldn't cancel while paused. A fix that needs new code waits
`governance_delay_ms` (the upgrade path works while paused). Removing a rogue watchdog (`remove_watchdog`) is
immediate but slows every key change to `governance_delay_ms` unless another watchdog confirms (D86). Likewise a key
change proposed while no watchdog may confirm yet (none, or only ones added less than `governance_delay_ms` ago)
waits `governance_delay_ms`: after adding the first watchdog, rotations go slow until its `confirm_from_ms`.

## Restoring a D1 database (Time Travel)

Both D1 databases, the API's `DB` (`cloudflare.d1Name`) and the watchdog's (`watchdog.cloudflare.d1Name`, on the
watchdog's Cloudflare account), are restored with **D1 Time Travel**
(<https://developers.cloudflare.com/d1/reference/time-travel/>; commands:
<https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-time-travel-info>, checked 2026-10-30). What
Cloudflare guarantees: a restore to any minute of the last 30 days on the Workers Paid plan (7 days on Free); a
timestamp is Unix seconds or RFC 3339 with an offset (UTC); `time-travel` commands always act on the remote
database (no `--remote`); a restore is **destructive and in place** (queries in flight are cancelled and fail) and
prints a bookmark that undoes it; there is no restore into a new database (no fork). Bookmarks older than 30 days are
invalid: past that only an export kept elsewhere helps. Wrangler ≥ 3.4 (the repo pins 4.x). Not rehearsed on
sandbox-dev yet (D152): do that once before relying on it.

### The API's `DB`

From the repo root, with `apps/api/wrangler.jsonc` generated for the env (`gen <env>`) and logged in to the API's
Cloudflare account:

```sh
corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name>                                        # the current bookmark: note it (it undoes everything below)
corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>   # the bookmark to restore
corepack pnpm --dir apps/api exec wrangler d1 export <cloudflare.d1Name> --remote --output=../../.secrets/<env>/d1-before-restore-<yyyymmdd>.sql
chmod 600 .secrets/<env>/d1-before-restore-<yyyymmdd>.sql
corepack pnpm --dir apps/api exec wrangler d1 time-travel restore <cloudflare.d1Name> --bookmark=<bookmark>
```

The export keeps the damaged state for the investigation and for re-applying later writes; it holds `vault_shares`
(wrapped under `VAULT_KEK`), so it lives under `.secrets/` (0600) and is deleted with the KEK's retention rules in
mind (`VAULT_KEK` above). Skip it only when the database is gone altogether.

**What is lost**: every write after the restore point. Apps created then (their publishable keys stop working), origin
and settings changes (a pending `raw_sign` / `auto_approve` change scheduled then is gone: the partner asks again),
**suspensions and revocations made then are undone**, usage counters, `vault_shares` created then (those users sign
in with Google again; their addresses are on chain and unchanged), and the issuer-key cron's state
(`issuer_key_observations`, `issuer_key_missing`, `issuer_key_proposals`, `issuer_key_sync_runs`). The cron rebuilds
the last from chain: a pending change by the signer account it has no row for is adopted, a missing kid's 55-min
timer starts again (its removal proposal comes up to 55 min later), and D33's lead-time data loses the gap.

**Re-run afterwards**, in this order:

1. `corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote`: a point before a
   later migration has the older schema (its `d1_migrations` table comes back with it, so only the missing ones run).
2. Security writes made after the point: `admin <env> app:suspend` for every app suspended since, `app:origins:remove`
   for every origin removed since (and for every origin, policy or raw-signing value still pending in the restored
   rows that was cancelled since: `app:list` shows the pending changes), and, if every share was revoked since (a KEK compromise), the revoke-all command in
   "`VAULT_KEK`" above **before** anything else touches the database. Never leave a restored database un-revoking
   what a security response revoked.
3. A KEK rotated after the point: the restored rows are under the old key id. While `VAULT_KEK_PREVIOUS` still holds
   it they unlock and get re-wrapped; if the rotation already finished (`VAULT_KEK_PREVIOUS` deleted), those rows are
   `unknownKek` (the users sign in again) unless the old key file is still there: `vault-kek <env> put --yes` sets
   both secrets from the files.
4. Other app changes since the point (new apps with `app:create`, which issues new publishable keys the partners
   must use; origins and settings, which are proposals again and wait for their announcement and delay), from what
   partners and the audit trail say (the `app_changes` rows in the export of step 1 list every app write).
5. Check: `admin <env> app:list --remote` against the known apps, `GET /v1/governance` `.updater` (the cron's next
   run), a smoke login and a reload unlock.

### The watchdog's D1

From `apps/watchdog`, logged in to the **watchdog's** Cloudflare account (`gen <env>` first, for its
`wrangler.jsonc`). Until it runs again, watch the issuer-key queue by hand (playbook `watchdog-down`).

```sh
corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name>
corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>
corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel restore <watchdog.cloudflare.d1Name> --bookmark=<bookmark>
```

**What is lost**: runs, alerts (and their acks), deliveries and the actions log after the point; kids first seen
since, and the `last_seen_at` updates (`seen_kids`); absences; the stored chain snapshot, failure counters, heartbeat
and digest state go back to the point. A run lock held at the point is taken over after 10 min (one or two runs skip).
**What the next runs do**: diff the chain against the older snapshot, so every governance change since the point is
alerted again (critical `governance_change`, its own pauses and updater-key deletions included: check them against
`owner:proposals` and the actions you know, then acknowledge); alerts that were open at the point and are no longer
true resolve; conditions still true are raised again (critical ones page until acknowledged); a second digest may go
out.

**The first-run baseline caveat.** A restore to a point **after** the first run keeps `initialized_at`: no first run,
and the pause on a forged active key still works. Before restoring, compare the active kids
(`admin <env> governance:status`) with Google's JWKS today: an active kid that Google published and stopped publishing
entirely **inside the gap** is missing from the restored `seen_kids`, and the next run takes it for never published
and pauses (Google keeps a kid published for weeks, so only a long gap can hit this; the API cron proposes removing a
dropped kid after 55 min). A restore to a point **before** the first run, or no restore at all (past 30 days, a new
database): the next run is a first run. It records Google's current JWKS as known and only **alerts**, never pauses,
on an active kid not in it, so a forged key active at that moment is not paused: check every
`unknown_active_key_first_run` alert by hand (playbook `unknown-active-key-first-run`) and the pending queue
(`GET /v1/governance` `.keyChanges`) before acknowledging.

After either restore: `/status` shows `last_run.outcome: "ok"`, the expected `first_run` and `initialized_at`, and
`heartbeat.ok` within two runs.

## Logs and latency

**Routing from Malaysia (2026-10-29).** `curl <apiUrl>/cdn-cgi/trace` shows which Cloudflare location served a
request: from Malaysia, workers.dev requests land in Marseille (MRS) about 60% of the time, otherwise HKG or SIN,
while D1 (`running_in_region: APAC`) and the Durable Objects are in APAC. The API Worker therefore runs in a fixed region next to D1
(`placement: { region: "aws:ap-east-1" }`, written by `gen`, D97; it replaced Smart Placement, D94, which only moved
requests from locations it had learned and reset after each deploy). Every response's `cf-placement` header shows
where it ran (`remote-HKG`). The trip from the user to the entry location (often FRA or CDG from Malaysia on
workers.dev) is not affected: only different routing (a custom domain, plan) changes that.

```sh
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format pretty
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format json --search '"endpoint":"/v1/login"'
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
```

`observability` is on, so the same lines are in the Cloudflare dashboard. Invocation logs are off on the API Worker
(`observability.logs.invocation_logs: false`, D100): the platform's per-request records carry the URL, and the login
relay's path holds a live `relayId`. The `request` lines below replace them; for status and CPU per request use the
Worker's metrics. Check once after a deploy that no relay URL appears in the Workers Logs view. Each request logs one
`{"event":"request", …}` line with `status`, `code`, `latencyMs`, `colo`, `phases` and, for relays, `relayInstance`
(fields and phases: `docs/api.md`, "Logs"). Reading a slow request:

| Look at | Means |
|---|---|
| `colo` not near the user (e.g. US/EU for Malaysia) | Cloudflare routing (free-plan `workers.dev`); not fixable in code |
| `app`, `limits` large | D1 or limiter objects far away (`durableObjectLocation`); on a vault endpoint `app` is only paid when this isolate hasn't read the app in the last 30 s (D78), and `limits` holds one object call (the app quota; the IP and share limits are local bindings, D95) |
| `checks` large | chain reads (scope, `session_key_in_use`, `get_session`) or a JWKS fetch |
| `relayQueue` | waiting behind other txs of the same key |
| `relayChainRead` with `relayInstance.coldChainRead` | object started without a stored reservation (new or replaced key) |
| `relayChainRead` with `blockRefresh` only | stored block hash older than 5 min |
| `relayPersist` | a new 100-nonce reservation (~3–30 ms) |
| `relayOutcome` | the chain: execution, and on derive the MPC (~4.5 s) |
| `session` large on `/v1/vault/shares` | the RPC node behind `/v1/login`'s optimistic answer: `get_session` re-read every 300 ms (up to 2 s) |
| `settings`, `insert`, `share`, `advance` large | D1 round trips (each is one or two queries) |
| `vault_page` `latencyMs` | the vault page's D1 reads (app, origins, settings) that every page load waits for |

**Stage timings (`pk_test_` apps).** The smoke page's *Timings* table (`apps/smoke/README.md` "Timings") splits a
login and a reload unlock into consecutive stages that add up to the page's total (with `other`), measured where they
happen: the partner page, the vault, the login popup and callback (navigation timing), the relay object
(`relayHeld`) and the API (`timings` on `/v1/login`, `/v1/vault/shares`, `/v1/vault/unlock`, `docs/api.md`
"Timings"). For a request, `<name>Rtt − <name>Server` is what the API never sees: the network, a CORS preflight and
Cloudflare's routing to the Worker; set the `colo` of the same request's log line next to it. *Copy results as JSON*
exports them (results version 3). `pk_live_` apps never get timings; production latency comes from the log lines
above.

Measured on sandbox-dev (2026-10-27, real MPC, `docs/context.md` "Testnet measurements"):

| Call | Gas | Cost | Latency (median) |
|---|---|---|---|
| `create_session` | 19.98–20.15 Tgas | 0.0020 NEAR | 2.5 s after the latency work (was 4.3 s) |
| `derive_key` | 19.61–19.88 Tgas | 0.0019 NEAR | 6.4 s (6.0–6.7) after (was 7.1 s) |
| login (create + derive) | ~40 Tgas | ~$0.021 | ~8.9 s |
| `revoke_session` | 2.68 Tgas | 0.00025 NEAR | |
| rejected derive on chain | 2.21 Tgas | 0.0002 NEAR | |

Warm stage split: create = checks 0.2 s + relay 2.2 s (chain ~0.6 s); derive = relay ~6.0 s (MPC ~4.5 s).
`create_session_and_derive` (`/v1/login`): its latency on testnet is D76 (the ship gate); its gas is measured in the
sandbox with the mock MPC, not yet on testnet: ≈ 20.5 Tgas in the signer's receipt and 22–23 Tgas in all with a
Google token (`docs/contract-interface.md` "Gas of the email login calls" and "Upgrades"; 100 Tgas attached).

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Google `Error 400: redirect_uri_mismatch` in the login popup | `{authOrigin}/login/callback` isn't an Authorized redirect URI of the client in use (shared, or the partner's own) | add it exactly in Google Cloud; wait a few minutes |
| Smoke's Google button: origin not allowed for the client | `http://localhost:5173` missing from Authorized JavaScript origins | add it on every client smoke uses |
| `409 counter_used` (with `nextCounter`) | a replayed or reused session counter; refused before the chain, no gas | send `nextCounter`; for a replay it is the expected answer |
| `409 session_exhausted` / `counter_out_of_range` | `max_uses` reached / counter past it | open a new session |
| `409 session_exists` | session key already holds a session (replay, or a retry that landed) | new session key |
| First relay after a quiet spell is slower; `relayInstance.cold: true` | the key's object was evicted (~10 s idle) | expected; costs no chain read while a reservation is stored. A repeated `coldChainRead: true` means the key has no stored reservation (new key, or a `RELAYER_KEYS` reorder) |
| `relay_retry` `invalid_nonce` warnings | a pool key was used outside its object, or was deleted and re-added on chain (new nonce) | one per re-added key is expected; otherwise don't use pool keys elsewhere |
| `503 relayer_unconfigured` | `RELAYER_KEYS` (or `OWNER_RELAYER_KEYS` for owner actions) not set | `wrangler secret put` |
| `422 contract_rejected` on every login after a deploy | contract has no Google keys, or keys out of date | `post-google-keys <env>`; check `KEYS_UPDATER_KEY` |
| `503 issuer_key_pending` on logins (with `retry-after: 30`) | the token's kid is in Google's JWKS but still in its issuer-key delay on chain (a rotation), or the contract has no Google issuer | expected for minutes after a rotation; check `/v1/governance` `keyChanges` (a pending Add with `jwks: match`): the watchdog confirms it, or it goes live at `executableAtMs` and the next cron run. No pending change for the kid: check the cron (`updater.lastRuns`) and `KEYS_UPDATER_KEY` |
| `503 paused` on logins and derives | the contract is paused (owner or a watchdog) | see "Pause"; only the owner multisig unpauses |
| cron logs `jwks_sync_skipped` | no `KEYS_UPDATER_KEY` | upload it |
| cron logs `jwks_sync_failed` `key_changes_unavailable` | `get_key_changes` failed or is malformed, or the contract is still v1 | v1: sync by hand (`post-google-keys`); v2: check the RPC |
| cron logs `issuer_key_change_cancelled` (error) | a change the cron proposed was cancelled on chain (the watchdog's alert says why) | if the watchdog cancelled, it also deleted the updater key: see "Keys-updater key". The cron holds that kid for 1 h |
| cron logs `jwks_sync_note` `unpublished_change` / `pending_mismatch` (error) | a pending Add for a kid Google doesn't publish, or with other key material | the cron won't execute it; the watchdog cancels it (critical alert). If no watchdog: the owner cancels it now (`cancel_issuer_key_change`) |
| cron logs `jwks_sync_note` `removal_of_published_kid` | a pending Remove of a kid Google still publishes | the owner decides and cancels (the watchdog alerts, D82) |
| cron logs `jwks_sync_note` `last_key_kept` / `queue_full` / `issuer_full` | removing the issuer's last key, or the contract's caps (6 pending, 10 per issuer) | `last_key_kept` clears once the new key is active; caps clear as changes execute or are cancelled |
| cron logs `jwks_tx` `send_failed` for `execute_issuer_key_change` / `propose_issuer_key_removal` | the updater key lacks the v2 methods (still the v1 key), was deleted, or its allowance is spent | "Keys-updater key" |
| `key_observation_failed` warnings (`code` `jwks` / `token`) | a lead-time write to D1 failed (logins unaffected), often `issuer_key_observations` missing | apply migration 0004 (`migrations apply … --remote`) |
| `503 vault_key_unavailable` | no `VAULT_KEK` (or the row's old key missing in `VAULT_KEK_PREVIOUS`) | set it |
| `GET /vault` 503, log code `misconfigured` | `API_URL` missing: a `wrangler.jsonc` generated before `apiUrl` reached `gen` | `gen <env>` and redeploy |
| `admin app:settings`: "The app's settings changed since they were read" | another `app:settings` or a D1 edit changed the app between the command's read and its write; nothing was written | run it again (it shows and plans from the current row) |
| `vault-kek init`: "already exists: refusing to overwrite a key" | `.secrets/<env>/vault-kek` exists | `vault-kek <env> put --yes` to set it again, or `rotate` to replace it |
| `410 share_revoked` / `share_expired` on every reload after a settings change | `persistence` set to `none` (shares revoked), or `session_ttl_ms` lowered below the shares' age | expected: users log in again |
| `403 origin_not_allowed` from a loopback origin | `pk_live_` key or a non-dev env name; or no `x-hana-parent-origin` from a Hana page | use `pk_test_` in `sandbox*`/`local*`; list the origin |
| `403 scope_conflict` | a `pk_test_` app shares its scope with a `pk_live_` app | separate scopes |
| 4100 `raw_not_allowed_for_test_apps` / `mainnet_not_allowed` from the vault | a `pk_test_` app asked for a raw signature (whatever `raw_sign` says), or for a mainnet Stellar passphrase or an EVM chain outside the testnet allowlist (D39) | expected for test apps; use a test network |
| `429 rate_limited` "(per IP per minute)" or "(share per minute)" on `/v1/vault/*` with `retry-after: 60` | the vault's per-location flood limits (60/min per IP per app, 10/min per share; D95), counted per Cloudflare location and approximate | wait; not visible in the dashboard, so count the 429s in the request logs |
| `429 rate_limited` "Too many key exports" on `/v1/login` from the export window | more than 3 exports in an hour for one user path in one app (D59) | wait for `retry-after` |
| `409 no_google_client` on `/v1/app` | scope has no Google client and no usable shared client (or shared client still in its timelock) | add a client, or `--allow-shared` + wait `changeDelayMs` |
| `admin`: "No wrangler config in apps/api" | `wrangler.jsonc` missing | `corepack pnpm --filter @hana-id/api run gen <env>` |
| `deploy-contract` "Cannot deploy until these are fixed" | a key with the wrong receiver, methods, empty method list or too-large/unlimited allowance | run the printed `near account delete-keys …`, re-run |
| A test fails after someone filled in `envs/sandbox-dev.json` | the test read the real manifest and expected `UNSET` placeholders | tests pin their own fixture manifest (see `scripts/test/deploy-plan.test.ts`, commit fdde123); never depend on live manifest values |
| smoke refuses to derive: "UNSET placeholder" | `ckdNetworkKey` not pinned | `fetch-ckd-key <env>`, restart the dev server |
| `build:lib` / `pack:check`: "Can't build the @hana-id/web package" | an env with both origins is a `local*` env, or none has both origins | keep loopback envs out of `envs/` (apps/e2e builds its own); set the origins |
| `build:lib` / `pack:check` / page build: "… is still an UNSET placeholder" | an included env (both origins set) has an `UNSET` value | fill it in, or leave the env's origins out until it is deployed |
| `pack:check`: "npm install … failed" | the registry is unreachable, or a pinned peer is younger than 7 days (`--before`) | retry; check the network or the pin |

## Releasing the SDK packages

`@hana-id/core`, `@hana-id/web`, `@hana-id/react` and `@hana-id/sodax` are built for installation outside this
repository (D71) but **not published**: they are still `"private": true`, and the registry and licence are open
decisions (below). Until then a partner gets tarballs.

**How the build works.** Each package's `build:lib` runs `tsc -p tsconfig.build.json` through `scripts/sdk-build.ts`:
ESM, `.d.ts` and source maps with inlined sources, into `dist/` (`@hana-id/web`: `dist/lib/`, since `dist/pages/` is
the Hana pages build and is never packed). Inside the workspace, `exports` still point at `src/` (tests, the API, the
pages and the apps import sources); `pnpm pack` replaces them with `publishConfig.exports` (dist), rewrites
`workspace:^` to `^<version>`, and runs `prepack` (= `build:lib`) first, so a tarball is always freshly built. Only
`dist`, `package.json` and `README.md` are packed (`files`). `@hana-id/web`'s `build:lib` first runs
`gen-envs.ts --package`: the client knows every `envs/*.json` that sets both `vaultOrigin` and `authOrigin`, and the
build fails if one of them has an `UNSET` value, if one is a `local*` env, or if there is none. Build a package's
dependencies first (`corepack pnpm --filter @hana-id/react... run build:lib`): its build reads their `.d.ts`.

**The check.** `corepack pnpm run pack:check` (also the CI job `packages`) packs the four into a temp dir, checks
each tarball (only dist JS / `.d.ts` / maps plus `package.json` and `README.md`; no tests, fixtures, sources,
`.secrets`, env files, raw `envs/*.json` or page bundles; relative, inlined map sources; no local absolute path in any
file; packed `exports`, version and `@hana-id/*` ranges), installs them with plain npm into a fresh project in the
system temp dir with the peer versions this repo tests, type-checks `scripts/pack-smoke/` there (NodeNext and Bundler
resolution, `skipLibCheck` off) and runs `scripts/pack-smoke/run.mjs` in Node. `--keep` leaves the temp dir.

**Tarballs for a partner (today).**

```sh
corepack pnpm run pack:check                         # must pass
mkdir -p /tmp/hana-sdk && for p in core web react sodax; do
  (cd packages/$p && corepack pnpm pack --pack-destination /tmp/hana-sdk)
done                                                  # hana-id-{core,web,react,sodax}-<version>.tgz
```

Send the four files with their SHA-256 (`shasum -a 256 /tmp/hana-sdk/*.tgz`) and the release commit.

**A release.**

1. On a branch from `develop`: `corepack pnpm --filter @hana-id/scripts sdk-version <x.y.z>` (one version for all
   four: each `package.json` and `VERSION` constant; D72). Say what changed for partners in the PR. Merge to
   `develop`, then `develop` into `main`.
2. Tag the release commit on `main` as `sdk-v<x.y.z>` and push the tag.
3. Tarballs: as above, from the tag. Publishing (once enabled): Actions → "Publish SDK packages" → run on `main`
   with the version, a dist-tag (`next` until a release should be the default install) and **dry run** first; check
   the listing, then run again without dry run.

**Publishing: what is left to enable it** (`.github/workflows/publish-sdk.yml`, manual dispatch only; its `gate` job
skips everything while the `NPM_TOKEN` secret is missing, and npm refuses `"private": true` packages):

- **Registry** (decision): public npm under an `@hana-id` org (anyone can install), or private (a paid npm org with
  restricted access, or GitHub Packages). Then add to each package's `publishConfig` (which today holds only the
  dist `exports`, `main` and `types`): `"access": "public"` (or `"restricted"`), and `"registry": "<url>"` if not
  npmjs.org; set `NPM_ACCESS` and `registry-url` in the workflow to match.
- **Licence** (decision): `license` is `UNLICENSED` (no rights granted) in all four. Set the SPDX id (and add a
  `LICENSE` file to each package's `files`) before a public release.
- **Provenance**: the workflow publishes with `--provenance` (`id-token: write`). npm accepts provenance only from a
  public source repository; while `Hana-Technology/hana-id` is private, publish from a public mirror, or drop
  `--provenance` for a private registry. npm trusted publishing (OIDC, no token) is the alternative to a token once
  the repository is public.
- **Token**: a granular npm token that can only publish the `@hana-id` packages, as the repository secret
  `NPM_TOKEN`, ideally in a protected GitHub environment with required reviewers.
- Remove `"private": true` from the four `package.json` files (`@hana-id/env`, `@hana-id/scripts` and the apps stay
  private).

## CI and git

- Branches: feature branch → PR into `develop` (an org ruleset needs one approving review; the user merges);
  `main` = releases. Remote `Hana-Technology/hana-id` (private).
- CI (`.github/workflows/ci.yml`, on PRs and pushes to `develop` / `main`): gitleaks over the full history;
  `cargo test --locked` + `cargo near build non-reproducible-wasm`; `pnpm install --frozen-lockfile`, `pnpm -r
  typecheck`, `pnpm -r test` (this includes `@hana-id/react`'s suite on React 18, `packages/react/react18`); the
  Playwright suite (`apps/e2e`, three browsers); sandbox e2e (`contracts/integration-tests`); the SDK pack check
  (`pnpm run pack:check`, [Releasing the SDK packages](#releasing-the-sdk-packages)).
- The pre-commit hook runs `gitleaks git --staged` with `.gitleaks.toml`. Never bypass it (`--no-verify`). Scan
  locally with `corepack pnpm secrets:scan`.
- `.gitleaks.toml` adds rules for this repo's own secrets, which gitleaks' defaults miss (security sweep OPER-2):
  NEAR ed25519 secret keys (`ed25519:` + 87-88 base58 characters; public keys are too short to match),
  `VAULT_KEK` values (`<id>:<base64 of 32 bytes>`), Worker-secret lines as in `.dev.vars` (`RELAYER_KEYS=…`,
  `KEYS_UPDATER_KEY=…`, `VAULT_KEK=…`, the watchdog's), and the secret files by name wherever they are (anything
  under `.secrets/`, the council key files included, `.dev.vars`, `relayer-keys.json`, `owner-relayer-keys.json`,
  `keys-updater.json`, `watchdog-secrets.json`, `vault-kek*`). `scripts/secret-scan-selftest.mjs` generates a fake of
  each at run time (never committed) and checks the rules catch it and pass the public look-alikes (public keys,
  placeholders, `pk_test_`, BLS keys); `scripts/test/secret-scan.test.ts` runs it in `pnpm -r test` when gitleaks is
  installed, and the CI `secrets` job runs it with the pinned binary after the history scan. Adding a secret shape
  means a rule here and a case in the self-test.
- Never commit `.secrets/`, `.env*`, `.dev.vars` or the generated `apps/api/wrangler.jsonc`, `wrangler.vault.jsonc`,
  `wrangler.auth.jsonc`, `wrangler.vitest.jsonc` and `apps/demo/wrangler.jsonc` (all gitignored and untracked;
  `wrangler.jsonc` holds an env's D1 id, the page and demo configs their origins and Worker names). Edit the
  manifest or `gen-wrangler.ts`, never the files. CI needs none of them: the API tests generate
  `wrangler.vitest.jsonc` from a fixed test manifest (`TEST_MANIFEST` in `gen-wrangler.ts`) on every run.
- `legacy/` is read-only reference code.
