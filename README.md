# Hana ID

Embedded wallets from social login. A partner app integrates the Hana ID SDK; its users sign in with Google; the
NEAR contract `hana-signer` checks the Google ID token on-chain and asks the NEAR MPC network for the user's key via
Confidential Key Derivation (CKD), encrypted so only the user's browser can read it. Signing then happens locally.

Each partner app has its own **scope** in a registry inside the contract, so one app can never derive another app's
users' keys. The user's key path is `{scope_id}#{provider}#{sub}#{key_index}`. An app logs users in either through its
own Google OAuth client (the token's `aud` picks the scope) or through Hana's shared client (the token's nonce commits
to the scope); see [Shared vs own Google client](#shared-vs-own-google-client).

**Testnet only.** Every account is a throwaway, and wallets derived on them are disposable.

More: [`docs/README.md`](docs/README.md) (index). Current state: [`docs/context.md`](docs/context.md) (background,
status, next steps), [`docs/architecture.md`](docs/architecture.md), [`docs/security.md`](docs/security.md),
[`docs/api.md`](docs/api.md), [`docs/contract-interface.md`](docs/contract-interface.md) (contract methods and byte
layouts), [`docs/operations.md`](docs/operations.md) (runbook), [`docs/decisions.md`](docs/decisions.md),
[`docs/integration.md`](docs/integration.md) (partner integration guide). The batch specs (`docs/batch-*.md`) are
history; the reference docs and the code win where they differ.

## Shared vs own Google client

A partner app can log its users in two ways. Both land in the app's own scope, so keys stay isolated per app.

| | Own client | Shared client |
|---|---|---|
| Google OAuth client | The partner creates one in its Google Cloud project | Hana's, from `sharedGoogleClientIds` in the manifest |
| Consent screen shows | The partner's app name | Hana's |
| How the contract finds the scope | The token's `aud` is registered to exactly one scope | `aud` is a shared client, so the API passes the app's `scope_id`, and the token's nonce commits to it. The scope must allow shared login. |
| Who checks the app may use the scope | Google (only the redirect URIs and origins registered on the partner's client can get its tokens) | Hana's vault (batch B), which computes a nonce for scope X only for a parent page whose origin app X allows; the login page checks it before relaying it to Google |
| Register with | `admin scope:register --client <id>` | `admin scope:register --allow-shared` (no `--client` needed) |

A scope can have both: its own client(s) and `allow_shared`. The path doesn't include the client ID, so a user gets the
same address either way, as long as Google returns the same `sub` for both clients. It does: the same account got
the same `sub` through clients of one Cloud project (testnet smoke, 2026-10-27) and of two projects (spike,
2026-10-28; `docs/decisions.md` D42). That also lets an app start on the
shared client and add its own client later with a timelocked `propose_change(AddClient)`, without users' addresses
changing. Forging a shared-client nonce gains nothing: it can only get the forger their own key for a scope, which
they could get anyway.

Rules the contract enforces:
- A client ID is either shared or a scope's own client, never both. The manifest schema rejects an ID that is in both
  `sharedGoogleClientIds` and `googleClientIds` (or `consoleAudiences`). `scope:register` refuses a shared ID as
  `--client`.
- Shared clients are added after `change_delay_ms` (pending until then, shown by `get_config`) and removed at once.
- Enabling shared login on an existing scope is a timelocked `propose_change(SetAllowShared)`. Disabling it with
  `disable_shared_login` takes effect at once, but only if the scope has its own client.

## Layout

```
contracts/hana-signer/   Rust NEAR contract (near-sdk 5): OIDC verification, scope registry, sessions, CKD
contracts/mock-mpc/      Test MPC contract for the sandbox tests
contracts/integration-tests/  near-workspaces sandbox tests (CI job "Sandbox e2e")
apps/api/                Cloudflare Worker + Durable Objects + D1: the relayer partners call (publishable keys)
apps/smoke/              Local smoke-test pages (Vite, http://localhost:5173): login through the vault, plus the direct flow
apps/e2e/                Playwright suite (Chromium, WebKit, Firefox) against a local stack: no testnet, no secrets
apps/demo/               Hosted testnet demo for colleagues (Vite page + Worker): https://hana-id-demo-sandbox-dev.tingtc.workers.dev
packages/env/            Environment manifest schema (zod) + loadEnv()
packages/core/           SDK core (batch B, pure TS): layouts, CKD, derivation v1, signers, decoders, token checks
packages/web/            Partner client (createHana) and the Hana pages (vault, login, approve, export), built per env
packages/react/          React bindings (HanaProvider, useHana, useWallet)
packages/sodax/          Optional Sodax wallet-provider adapters
packages/playbooks/      Recovery playbooks for every watchdog alert and incident (D126): docs/playbooks.md, admin portal
envs/                    One manifest per environment (sandbox-dev.json): every account name and endpoint
contracts/sputnik/       The pinned Sputnik DAO v2 code and the owner-council policy (2 of 3, D81)
scripts/                 Deploy, owner council, Google key sync, CKD key pinning, admin CLI (TypeScript, run with tsx)
legacy/                  Read-only reference: the earlier PoC client and relayer
docs/                    Reference docs (current state) and batch specs (history): docs/README.md
```

## Setup

Install [gitleaks](https://github.com/gitleaks/gitleaks) first (`brew install gitleaks`): `pnpm install` turns on a
pre-commit hook (`.githooks/pre-commit`) that refuses commits containing secrets, and CI scans the full history
(`.gitleaks.toml`). Run `pnpm secrets:scan` to scan locally.

Needs Node 22+, pnpm 11, Rust (the toolchain in `contracts/hana-signer/rust-toolchain.toml` with the
`wasm32-unknown-unknown` target), ideally `cargo-near` (`cargo install cargo-near`; CI uses 0.22.0), and near CLI
(near-cli-rs) for creating accounts. Versions: `docs/operations.md` "Prerequisites".

```sh
pnpm install          # pnpm refuses packages younger than 7 days (minimumReleaseAge); pin older versions if needed
pnpm -r typecheck
pnpm -r test
cd contracts/hana-signer && cargo test
```

## Commands

| What | Command |
|---|---|
| Contract tests / wasm | `cd contracts/hana-signer && cargo test` · `cargo near build non-reproducible-wasm` |
| TS tests / types | `pnpm -r test` · `pnpm -r typecheck` |
| API dev server | `pnpm --filter @hana-id/api dev` |
| Deploy the contract | `pnpm --filter @hana-id/scripts run deploy-contract <env> [--yes]` |
| Migrate / upgrade it (propose, then execute) | `pnpm --filter @hana-id/scripts run deploy-contract <env> --upgrade [--yes]` |
| Create the dev owner council (Sputnik DAO) | `pnpm --filter @hana-id/scripts run council-setup <env> [--yes]` |
| Owner call through the owner or the council | `pnpm --filter @hana-id/scripts run admin <env> owner:call <method> --args '<json>' [--approve-with <member>] [--yes]` |
| Sync Google keys once | `pnpm --filter @hana-id/scripts run post-google-keys <env> [--dry-run] [--execute]` |
| Pin the MPC CKD key (≥ 3 RPC providers must agree) | `pnpm --filter @hana-id/scripts run fetch-ckd-key <env> [--rpc <url>]... [--dry-run]` |
| Admin (apps, scopes, app settings) | `pnpm --filter @hana-id/scripts run admin <env> <command> …` |
| API Worker config | `pnpm --filter @hana-id/api run gen <env> [--d1-id <uuid>] [--dev-vars]` |
| `VAULT_KEK` | `pnpm --filter @hana-id/scripts run vault-kek <env> init\|put\|rotate [--yes]` |
| Identity token keys (`IDENTITY_SIGNING_KEY`, `…_STANDBY`, `IDENTITY_SUB_KEY`) | `pnpm --filter @hana-id/scripts run identity-key <env> init [--local]\|put\|show [--yes]` (`docs/operations.md` "Identity token keys") |
| Hana pages (vault, auth) | `pnpm --filter @hana-id/web build` · `pnpm --filter @hana-id/api run deploy:pages` |
| Recovery playbooks doc | `pnpm --filter @hana-id/playbooks gen-docs` (writes `docs/playbooks.md`; edit `packages/playbooks`) |
| SDK tarballs: build, check, install outside the repo | `pnpm run pack:check` · version: `pnpm --filter @hana-id/scripts run sdk-version <x.y.z>` (`docs/operations.md` "Releasing the SDK packages") |
| Browser tests | `pnpm --filter @hana-id/e2e e2e` (`HANA_E2E_PORT_BASE` for a second worktree; `apps/e2e/README.md`) |
| Hosted demo | `pnpm --filter @hana-id/demo run deploy` (`apps/demo/README.md`; its origin must be on the app first) |

The `@hana-id/scripts` commands take the environment name (`envs/<env>.json`) first and print `--help`.

### deploy-contract

```
deploy-contract <env> [--yes] [--relayer-keys 3] [--relayer-allowance 2]
                      [--owner-relayer-keys 1] [--owner-relayer-allowance 0.5]
                      [--upgrade] [--wasm <file>] [--skip-build]
                      [--transfer-owner] [--member <council member>] [--approve-with <council member>]
deploy-contract <env> --creation-plan [--wasm <reproducible build>] [--updater-public-key <pk>] [--creation-public-key <pk>]
```

Reads what is already on chain, prints a plan, and changes nothing without `--yes`. Re-running plans only what is
missing, so it is safe to resume after a failure. Owner steps go through the manifest's owner (`ownerKind`): signed by
the owner's keychain key, or proposed to the council DAO (`--member`; `--approve-with` on dev envs approves them in the
same run). Steps:

1. Build the wasm (`cargo near build non-reproducible-wasm`, or plain `cargo build --target wasm32-unknown-unknown`
   if cargo-near is missing).
2. Deploy to `signer` and call `new(owner, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms,
   governance_delay_ms, watchdogs, updater_keys)` in the same transaction (only where `allowSignerFullAccessKey`
   allows the signer a full-access key; other envs are created with the `--creation-plan` batch). On an initialised
   contract `--upgrade` changes the code in place, same account, so no address changes: `propose_upgrade(<code_hash>)`
   by the owner and, on a re-run once `governance_delay_ms` has passed, `execute_upgrade` with the raw wasm (never a
   raw `DeployContract`). A v1 (pre-governance) contract is refused: current code has no v1 migration (D154).
   Details and the sandbox-dev migration: `docs/operations.md` "Governance".
3. Add two pools of function-call keys on `relayer`, both with receiver = `signer`, one transaction per pool:
   - **Session pool** (the API's `RELAYER_KEYS`, logins): `--relayer-keys` keys (default 3), limited to
     `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `prune_sessions`, allowance
     `--relayer-allowance` each (default 2 NEAR). A key already on chain with another method list (an earlier
     allowlist) stops the plan with the commands to delete it; re-running then re-adds it with the current list.
   - **Owner pool** (the API's `OWNER_RELAYER_KEYS`, `/v1/owner-actions`): `--owner-relayer-keys` keys (default 1),
     limited to `propose_change`, `cancel_change`, `remove_client`, `disable_shared_login`, `execute_change`,
     `register_scope`, `apply_pending_config`, allowance `--owner-relayer-allowance` each (default 0.5 NEAR).

   The pools never share a key, so abuse of the public owner-actions endpoint can only drain the owner pool. It can
   never stop logins.
4. The keys-updater key (the API's `KEYS_UPDATER_KEY`, so the cron can propose Google keys without the owner): generated
   into `.secrets/<env>/keys-updater.json` and installed on `signer` by the owner's `add_updater_key`. The contract
   gives it exactly `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`, receiver `signer`,
   1 NEAR; nobody adds keys to the signer by hand any more. A pre-governance updater key (with `remove_issuer_key`)
   still on the signer is deleted once the contract's own is in (the v1 → v2 migration did this on sandbox-dev
   on 2026-10-30). Then `add_watchdog` for each `watchdogs` account that exists,
   and `set_issuer_key_delay_ms` / `set_governance_delay_ms` if the contract's delays differ from the manifest.
   `--transfer-owner` adds `propose_owner(<council DAO>)` and, once due, the DAO's `accept_owner` (then the script sets
   `owner` / `ownerKind` in the manifest).
5. `set_issuer("google", ["https://accounts.google.com", "accounts.google.com"])`, `set_sponsors([relayer])`,
   `set_console_audiences` if the manifest lists any, `set_shared_clients` with `sharedGoogleClientIds`, and
   `admin_register_scope` for the reserved `global` scope with `googleClientIds` plus the `consoleAudiences` and
   `allow_shared: false` (Hana's own app uses its own client). Each of the last two is skipped with a warning while
   its manifest field is still an `UNSET…` placeholder. Console audiences go into `global` so no scope owner can claim
   them with `propose_change(AddClient)`. Set `consoleAudiences` before the first deploy: once `global` exists, a
   missing console audience is only a warning, and adding it later takes a timelocked `propose_change` by the owner.

   `set_shared_clients` replaces the whole list. Clients that are new take effect after `changeDelayMs`, and until
   then the plan reports them as pending, with their unlock time. Clients no longer in the manifest are removed at
   once. The plan stops if a shared ID is already registered as some scope's client.

It does not create accounts. If one is missing, or its key is not in the keychain, the plan says so and shows the
near CLI command to fix it.

An allowance drops by the gas each call burns, not the gas attached (refunds restore it; measured on testnet,
`docs/context.md`). The API attaches per-method gas (`apps/api/src/gas.ts`: `create_session` 50 Tgas,
`create_session_and_derive` 100, `derive_key` 60, `revoke_session` 20, `prune_sessions` 50, `register_scope` 30 + 25
per client proof, other owner-pool methods 50). A split login burns ~40 Tgas (~0.004 NEAR), so 3 keys × 2 NEAR cover
~1,500 logins. Pass larger allowances for heavier testing. To replace a used-up key,
delete it on chain with near CLI, remove it from its `.secrets` file, and re-run.

**Existing keys are checked, not trusted.** For every key in a pool file (and the keys-updater key), the plan
compares the on-chain key's `receiver_id`, `method_names` and `allowance` with the intended permission. The plan
stops instead of passing the key as in place if:
- the key is full-access,
- the key is for another receiver,
- the key has a different method set, such as a batch A key that mixes session and owner methods,
- the key has an **empty method list**, which NEAR treats as "any method",
- the key has an **unlimited allowance**, or an allowance above the pool's `--…-allowance` flag (1 NEAR for an
  updater key). A lower allowance is fine, since NEAR lowers it as the key spends gas. If you deployed with a larger
  allowance than the default, pass the same flag on every re-run.

It also stops on:
- a key for `signer` on the relayer that is in neither pool file and has an empty method list, or methods of both
  pools (for example a batch A key left on chain after its file was moved aside),
- any function-call key on the signer that isn't in `get_governance().updater_keys` (the v1 updater key excepted: the
  migration deletes it). Such a key could propose a forged Google key,
- a full-access key on the signer in any env without `allowSignerFullAccessKey` (sandbox-dev only, D86): with it,
  anyone holding it could replace the code at once,
- a v1 contract without `--upgrade`, a missing council DAO or one with other code than the pin (for `--transfer-owner`
  or a council owner), and `--approve-with` outside dev envs.

Other stray keys are only listed as warnings, each with the command to delete it. The fix the plan prints for a
blocked key: delete it on chain (`near account delete-keys …`, printed per key) and re-run, which re-adds the key from
`.secrets` with the right permission. Or move the `.secrets` file aside, which generates fresh keys, and re-upload the
API secret. Delete the old keys on chain in that case too: left there, they keep their permission and allowance.

The same check covers switching an env to a new `signer` account. The keys in the pool files are then still
function-call keys for the old signer. NEAR can't add the same key twice, so the plan stops and lists them.

### Keys: where they come from and where they go

- **Full-access keys** for `owner`, `signer` and `relayer` are read from the near CLI **legacy keychain**:
  `~/.near-credentials/testnet/<account>.json` (`{"account_id","public_key","private_key"}`), or the per-key files in
  `~/.near-credentials/testnet/<account>/`. near-cli-rs writes these when you choose `save-to-legacy-keychain`
  (`near account create-account … save-to-legacy-keychain …` or `near account import-account … save-to-legacy-keychain`).
  The scripts only read them; they are never copied or printed.
- **Generated keys** go to `.secrets/<env>/` (gitignored; directory 0700, files 0600). Nothing generated is printed:
  - `relayer-keys.json`: JSON array of `ed25519:…` secret keys (session pool), the API's `RELAYER_KEYS` secret.
  - `owner-relayer-keys.json`: same format (owner pool), the API's `OWNER_RELAYER_KEYS` secret.
  - `keys-updater.json`: `{"account_id","public_key","private_key"}`, whose `private_key` is the API's
    `KEYS_UPDATER_KEY` secret.
  - `council/<member>.json` (dev envs only, `council-setup`): the full-access keys of the throwaway council member
    accounts, same format. Other envs' members keep their own keys (Ledgers on mainnet); the scripts never read a
    council key from disk outside testnet.

  Each key is saved before it is added on chain (or before its account is created), so a key that lands on chain is
  never lost.

### council-setup

```
council-setup <env> [--yes] [--funder <account>] [--member-balance 2]
```

Dev envs (`local*`, `sandbox*`) on testnet only. Creates the three `council.members` accounts (keys into
`.secrets/<env>/council/`) and the `council.dao` Sputnik DAO v2 from the `council.factory`, with
`contracts/sputnik/policy.json`: 2 of 3 for every proposal kind, only council members propose (D81). It first checks
that the factory deploys the pinned DAO code (`contracts/sputnik/pin.json`). A re-run checks what exists and stops on
a DAO with other code or another policy. `docs/operations.md` "Owner council".

### admin owner:* and governance:status

`admin <env> owner:call <method> --args '<json>'` sends one owner-only method through the manifest's owner: the owner's
keychain key signs it, or (`ownerKind: "sputnik"`) it becomes a DAO `FunctionCall` proposal by `--member`. On dev envs
`--approve-with <second member>` approves it with both members in the same command, so it executes; elsewhere the
command only proposes and prints the vote each member signs. `owner:vote <id> --member <m>` approves one proposal
(`--reject`: rejects it), `council:replace-member --remove <old> --add <new>` proposes replacing a council member
(remove, then add; 2 of 3 kept; it writes `council.members` in the manifest once the DAO has the new council),
`owner:proposals` lists them decoded, `governance:status [--json]` prints the contract's governance state, the
signer's keys against the updater keys, the council's open proposals and the findings (the source batch C's admin
portal reads; `docs/operations.md` "Governance status for the admin portal").

### post-google-keys

Fetches Google's JWKS and compares it with `get_issuer("google")` and `get_key_changes()`. On the governance contract
it proposes new kids (`set_issuer_key`) and the removal of retired ones (`propose_issuer_key_removal`, never the last
key), and with `--execute` runs `execute_issuer_key_change` for due changes that match Google's JWKS. Keys go live
when the watchdog confirms them or after `issuer_key_delay_ms`. On a v1 contract it sets and removes directly. It
signs with the keys-updater key from `.secrets/<env>/keys-updater.json` (there is no owner path: an owner post waits
the same delay, D86) and refuses to sync if Google returns no usable RS256 key.

### fetch-ckd-key

Reads `state` from the MPC contract (`manifest.mpc`) at one final block from at least three independent RPC providers
(`rpc`, `rpcFallback`, each `--rpc <https url>`, then built-in public endpoints), takes the BLS12-381 G2 public key of
`ckdDomainId`, and refuses unless every provider reports the same block hash and key. It writes the key to
`ckdNetworkKey` and the block and provider hosts to `ckdNetworkKeySource` in `envs/<env>.json`, leaving the rest of
the file as it was (D100). Clients pin this key. If it ever changes, every derived key changes with it.

### admin

```
admin <env> app:create --name <name> --scope <scope_id> --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | pk_test_…> --origin <origin> […] [--remote]
admin <env> app:origins:remove --app <app id | pk_test_…> --origin <origin> […] [--remote]
admin <env> app:suspend|app:resume --app <app id | pk_test_…> [--remote]
admin <env> app:list [--remote]
admin <env> app:settings <app id | pk_test_…> [--persistence session|none] [--session-ttl 12h] [--idle-ttl 2h]
             [--raw-sign off|approval] [--google-web-client <client id>|default] [--auto-approve <policy.json>|off] [--remote]
admin <env> scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […]
             [--member <council member>] [--approve-with <council member>] [--yes]
admin <env> owner:call <method> [--args '<json>'] [--gas <Tgas>] [--member <m>] [--approve-with <m>] [--yes]
admin <env> owner:vote <proposal id> --member <m> [--reject] [--yes]
admin <env> owner:proposals [--limit 20] [--json]
admin <env> governance:status [--json]
admin <env> council:replace-member --remove <old member> --add <new member> [--member <m>] [--approve-with <m>] [--yes]
```

- `app:*` commands write the env's D1 database with `wrangler d1 execute`, run from `apps/api`. They use the local
  database (`apps/api/.wrangler/state`, the one `wrangler dev` uses) by default, and the deployed one with
  `--remote`. They need `apps/api/wrangler.jsonc` (generate it with `apps/api/scripts/gen-wrangler.ts`) and the
  migrations applied. Values are escaped (wrangler has no bind parameters), and origins are normalised to
  `scheme://host[:port]`. Plain `http` is accepted only for localhost, plus the literal `http://localhost:*` for test
  keys.
- `app:create` checks that the scope exists on chain and the plan exists in D1. It generates the app id and a
  publishable key (`pk_test_` + base58 of 24 random bytes) and prints the key. Publishable keys are public: origins
  are what gate them.
- `app:settings` sets the app's vault settings (`docs/batch-b-spec.md` "App settings"); without setting flags it
  prints them. It checks every range (session TTL 1 h to 23 h 50 min, idle TTL 15 min to the session TTL), checks
  `--google-web-client` against the scope's Google clients on chain (`default` unpins it: the scope's first one), and
  validates `--auto-approve` with `@hana-id/core`'s `validateAutoApprovePolicy`, storing its normalized form and
  printing its `policyId`. Loosening is delayed: `--raw-sign approval` and a new policy are written as pending, in
  force after 24 h (the manifest's `changeDelayMs` in `local*`/`sandbox*` envs), and re-running doesn't restart the
  delay. `--raw-sign off` and `--auto-approve off` are immediate. Every change is printed with its time. A relative
  `--auto-approve` path is relative to where you ran `pnpm`, and the write applies only if nobody changed the app's
  settings since the command read them (else it fails and writes nothing). `docs/operations.md` has the details.
- `scope:register` calls `admin_register_scope(owners, clients, null, allow_shared)` through the owner: the owner's
  keychain key, or a council proposal (`--member`, `--approve-with` on dev envs) once the DAO owns the contract.
  Without `--yes` it prints the call and stops. It works only while `public_registration` is false, and the contract
  assigns the id (`s1`, `s2`, …), which the command prints (through the council: read it from `get_scope` or the
  `scope_registered` event). `--allow-shared` lets the app log in through Hana's
  shared Google client. With it, `--client` is optional, so a partner without its own Google client needs none.
  Without it, at least one `--client` is required. A client ID from `sharedGoogleClientIds` is refused as `--client`.

## Deploying a sandbox environment end to end

Use `sandbox-dev` as written or copy it to a new manifest (see [`envs/README.md`](envs/README.md)), with fresh
throwaway names. The signer account is part of every user's derived key, so changing it changes every address.

1. **Create and fund three testnet accounts** (the faucet gives each about 10 NEAR) and save their keys to the
   legacy keychain:
   ```sh
   near account create-account sponsor-by-faucet-service <signer>  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <relayer> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <owner>   autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```
   `signer` holds the contract and pays its storage, including scope registrations, so keep a few NEAR on it.
   `relayer` pays gas for the API. `owner` is the Hana admin.
2. **Create the Google OAuth clients** (Google Cloud console → APIs & Services → Credentials → OAuth client ID, type
   "Web application"). You need one for Hana's own app, and a separate one as the shared login client. They must be
   two different client IDs. Hana's pages (batch B) use the redirect flow: the shared client's only Authorized
   redirect URI is `{authOrigin}/login/callback` (step 7), never a partner origin. `apps/smoke`'s `direct.html`
   still signs in with Google Identity Services, so a client it uses also needs `http://localhost:5173` as an
   authorised JavaScript origin ([`apps/smoke/README.md`](apps/smoke/README.md)).
3. **Fill in the manifest**: account names, `googleClientIds` (Hana's own app's client IDs, which become the `global`
   scope), `sharedGoogleClientIds` (the shared login client), `consoleAudiences` if any, `changeDelayMs`, and the
   Cloudflare names. Fill these in before the first deploy. Changing them later works, but adding a shared client
   then waits out the timelock again.
4. **Pin the MPC key**: `pnpm --filter @hana-id/scripts run fetch-ckd-key <env>`.
5. **Deploy**: `pnpm --filter @hana-id/scripts run deploy-contract <env>`, read the plan, then re-run with `--yes`.
   Shared clients become effective `changeDelayMs` after this (60 s in `sandbox-dev`). Re-run without `--yes` to see
   their status.
6. **Post Google's keys**: `pnpm --filter @hana-id/scripts run post-google-keys <env>` (proposes them; they go live
   when a watchdog confirms them or after `issuerKeyDelayMs`: re-run with `--execute`).
7. **API**:
   ```sh
   pnpm --dir apps/api exec wrangler d1 create <cloudflare.d1Name>            # once; deployed envs only: prints the database id
   pnpm --filter @hana-id/api run gen <env> --d1-id <id>                      # writes apps/api/wrangler.jsonc, gitignored (omit --d1-id for local only)
   pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local   # or --remote
   # Upload secrets without echoing them (run from the repo root):
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' \
     | pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' \
     | pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' \
     | pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   pnpm --filter @hana-id/api run deploy
   pnpm --filter @hana-id/scripts run vault-kek <env> init --yes             # VAULT_KEK: kept in .secrets/<env>/vault-kek, set via stdin
   ```
   For local `wrangler dev`, the same three values go in `apps/api/.dev.vars` (gitignored, 0600):
   `pnpm --filter @hana-id/api run gen <env> --dev-vars` writes it from `.secrets/<env>/` without printing them.
   Then the vault and auth pages (`vaultOrigin`, `authOrigin`), each a thin Worker with its built pages; the vault
   Worker reaches the API through a service binding, so deploy the API first
   ([`apps/api/README.md`](apps/api/README.md#page-workers)):
   ```sh
   pnpm --filter @hana-id/web build              # packages/web/dist/pages/<env>/{vault,auth}
   pnpm --filter @hana-id/api run deploy:pages   # wrangler.vault.jsonc and wrangler.auth.jsonc, written by gen above
   ```
   Google redirects logins to `{authOrigin}/login/callback`: add it as an Authorized redirect URI on the shared client
   and on every own client that logs in through the Hana pages.
8. **Register a partner**, with its own Google client, or with Hana's shared one, or both:
   ```sh
   # own client
   pnpm --filter @hana-id/scripts run admin <env> scope:register --client <partner>.apps.googleusercontent.com --owner-near <partner-or-owner>.testnet --yes
   # shared client only (no Google setup on the partner's side)
   pnpm --filter @hana-id/scripts run admin <env> scope:register --allow-shared --owner-near <partner-or-owner>.testnet --yes
   pnpm --filter @hana-id/scripts run admin <env> app:create --name "Partner" --scope s1 --origin https://partner.example --origin http://localhost:5173 [--remote]
   ```
   Give the partner the printed `pk_test_…` key and [`docs/integration.md`](docs/integration.md). With its own
   client, the partner adds `{authOrigin}/login/callback` as that client's only Authorized redirect URI, with no
   JavaScript origins.

## Safety

- Testnet only. The manifest schema accepts only `testnet`, and the scripts refuse an RPC whose `chain_id` is not
  `testnet`.
- Never print, log or commit private keys, CKD outputs or Google ID tokens. Generated keys live only in
  `.secrets/<env>/` (0600). Full-access keys stay in `~/.near-credentials`. `.env`, `.dev.vars` and `.secrets/` are
  gitignored.
- Anything that changes how a path or key is derived changes every user's address: the MPC network, the signer
  account, the path format, or the local derivation. That is allowed before the address freeze, but must be called
  out. After the freeze, never.
- The relayer's keys can only call their pool's `hana-signer` methods, and only up to their allowance.
  `deploy-contract` checks this on every run. A leaked relayer key can burn gas, but it cannot derive anyone's key,
  because every session needs a Google token committing to the user's own session key and scope. Session and owner
  keys are separate pools, so draining the owner pool can't stop logins.
- On the governance contract, Google keys and code change only after public delays (`issuer_key_delay_ms`,
  `governance_delay_ms`), the owner is a 2-of-3 Sputnik DAO council, and outside sandbox-dev the signer has no
  full-access key: `deploy-contract` blocks on one, and on any signer key the contract didn't install
  (`docs/governance-spec.md`, `docs/operations.md` "Governance").
- Hana cannot change a scope's client IDs or owners after registration. On chain it can block derivation only for a
  shared-only scope, by removing the shared clients (`docs/decisions.md` D11, D12). App suspension happens only in D1,
  through the API.
