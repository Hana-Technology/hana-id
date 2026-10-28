# Operations runbook — running a Hana ID environment (testnet only)

Last verified against code: 2026-10-28 (commit 14e6fc3, `feat/batch-b`)

Commands and flags are from `scripts/`, `apps/api/scripts/gen-wrangler.ts` and their tests. Endpoints:
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
| Keys-updater key (`KEYS_UPDATER_KEY`) | `.secrets/<env>/keys-updater.json` (`private_key`) | `deploy-contract` |
| `VAULT_KEK` | `.secrets/<env>/vault-kek` (this runbook's convention; no script reads it) | you, below |
| Worker copies of the above | Cloudflare Worker secrets | `wrangler secret put` |
| Local dev copies | `apps/api/.dev.vars` (0600) | `gen --dev-vars` |

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
| `owner` | contract admin (`new(owner, …)`), signs `scope:register` | ≈ 1 NEAR |
| `mpc` | the NEAR MPC contract (exists already; not ours) | — |
| `ckdDomainId`, `ckdNetworkKey` | CKD domain and the pinned MPC public key | pin with `fetch-ckd-key` |
| `rpc`, `apiUrl` | NEAR RPC; the deployed Worker URL | `apiUrl` is known only after the first deploy |
| `vaultOrigin`, `authOrigin` | Hana page origins (batch B) | both or neither; `gen` refuses an env without them |
| `googleClientIds` | Hana's own app clients → reserved `global` scope | |
| `sharedGoogleClientIds` | Hana's shared login clients (≤ 5) | never also in `googleClientIds` / `consoleAudiences` |
| `consoleAudiences` | `[provider, aud]` accepted for OIDC owner actions | set before the first deploy |
| `changeDelayMs` | contract timelock (0..7 days) | sandbox-dev: 60 s |
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
| Partner test client(s) | `scope:register --client` | for own-client tests; for the own-vs-shared address test use a separate Google Cloud project (batch B spec) |

Register on each client:

| Entry | Value | On which clients | Why |
|---|---|---|---|
| Authorized JavaScript origins | `http://localhost:5173` (Google also suggests `http://localhost`) | every client `apps/smoke` signs in with | smoke uses Google Identity Services in the page |
| Authorized redirect URIs | `{authOrigin}/login/callback`, exact (scheme, host, no trailing slash) | the shared client, and every partner's own client used through Hana's login page | batch B login popup (`response_type=id_token`, `redirect_uri={authOrigin}/login/callback`; pages on `b/web-auth`) |

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
3. **Pin the MPC key** (writes `ckdNetworkKey`; `--dry-run` only prints):

   ```sh
   corepack pnpm --filter @hana-id/scripts run fetch-ckd-key <env>
   ```

4. **Deploy the contract.** Prints the plan and changes nothing without `--yes`; re-running plans only what's
   missing. What each step does and why it blocks: root `README.md`, "deploy-contract".

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>        # read the plan
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

   Flags: `--relayer-keys N` (1..20, default 3), `--relayer-allowance <NEAR>` (2), `--owner-relayer-keys N` (1..5,
   default 1), `--owner-relayer-allowance <NEAR>` (0.5), `--updater-allowance <NEAR>` (1), `--upgrade` (code only, no
   `new`), `--wasm <file>`, `--skip-build`. Pass the same allowance flags on every re-run if you raised them (a key
   with a larger allowance than the flag is a blocker). Shared clients take effect `changeDelayMs` after this.

5. **Post Google's keys** once (the hourly cron keeps them in sync afterwards):

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> [--dry-run] [--as-owner]
   ```

6. **D1 and Worker config**:

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 create <cloudflare.d1Name>      # prints the database id
   corepack pnpm --filter @hana-id/api run gen <env> --d1-id <uuid>             # writes apps/api/wrangler.jsonc
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote
   ```

   Without `--d1-id`, `gen` keeps the id already in `wrangler.jsonc` only if that file names the same
   `database_name`, else it writes the local placeholder `00000000-0000-4000-8000-000000000000`.

7. **Worker secrets** (from the repo root; values go through a pipe, never the terminal):

   ```sh
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' \
     | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   (umask 077; printf '1:%s' "$(openssl rand -base64 32)" > .secrets/<env>/vault-kek)
   corepack pnpm --dir apps/api exec wrangler secret put VAULT_KEK < .secrets/<env>/vault-kek
   ```

   Keep `.secrets/<env>/vault-kek`: a KEK rotation needs the current value, and Cloudflare can't give it back.

8. **Deploy the API**, then put the Worker URL in `apiUrl` and re-run `gen` + deploy if it changed (the vault page's
   CSP uses it):

   ```sh
   corepack pnpm --filter @hana-id/api run deploy
   curl -s https://<worker-url>/v1/health          # {"ok":true,"env":"<env>","signer":"<signer>",…}
   ```

9. **Register apps** (next section), then **smoke test**.

### Upgrading an env deployed from `develop` to batch B

The contract change is a code upgrade (`deploy-contract <env> --upgrade`, plan first). The session-pool allowlist
gains `create_session_and_derive`, and access-key permissions can't be edited: the plan blocks on every session key
with the old method list and prints `near account delete-keys …` per key; delete them, re-run (it re-adds them from
`.secrets/<env>/relayer-keys.json`); the secret is unchanged (same keys). A re-added key starts at a new on-chain
nonce, so expect one `relay_retry` `invalid_nonce` per key on its first relay. Also: set `vaultOrigin` / `authOrigin`,
re-run `gen`, apply migration `0003_vault.sql` (`migrations apply … --remote`), set `VAULT_KEK`, deploy.

## Local API (`wrangler dev`)

```sh
corepack pnpm --filter @hana-id/api run gen <env> --dev-vars     # wrangler.jsonc + apps/api/.dev.vars (0600)
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local
corepack pnpm --filter @hana-id/api dev                          # http://localhost:8787
```

`--dev-vars` writes `RELAYER_KEYS`, `OWNER_RELAYER_KEYS` (single-quoted) and `KEYS_UPDATER_KEY` from
`.secrets/<env>/`, skipping missing files, and prints only a count. It rewrites the whole file and has no `VAULT_KEK`;
for local vault endpoints append a throwaway one after each `gen --dev-vars`:

```sh
printf 'VAULT_KEK=1:%s\n' "$(openssl rand -base64 32)" >> apps/api/.dev.vars
```

`admin app:*` without `--remote` act on this local D1 (`apps/api/.wrangler/state`).

## Admin CLI (`scripts/admin.ts`)

```text
admin <env> app:create --name <name> --scope <scope_id> --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:suspend        --app <app id | publishable key> [--remote]
admin <env> app:resume         --app <app id | publishable key> [--remote]
admin <env> app:list [--remote]
admin <env> scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […] [--yes]
```

Run as `corepack pnpm --filter @hana-id/scripts run admin <env> <command> …`. Unknown flags are errors.

- `scope:register`: `admin_register_scope` signed by `owner`'s keychain key; prints the call and stops without
  `--yes`. 1..5 owners, ≤ 10 clients; `--client` required unless `--allow-shared`; a shared client ID is refused as
  `--client`. Prints the contract-assigned id (`s1`, `s2`, …).

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin <env> scope:register --client <id>.apps.googleusercontent.com --allow-shared --owner-near <account> --yes
  corepack pnpm --filter @hana-id/scripts run admin <env> scope:register --allow-shared --owner-near <account> --yes   # shared only
  ```

- `app:create`: the scope must exist on chain and the plan in D1; refuses a scope already used by an app with the
  other key type. Generates `app_<base58>` and a **`pk_test_`** key (there is no command for `pk_live_` keys) and
  prints it (public). Origins are normalised to `scheme://host[:port]`; plain `http` only for `localhost`,
  `127.0.0.1`, `[::1]`; the literal `http://localhost:*` is accepted.

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin <env> app:create --name smoke-a --scope s1 --origin http://localhost:5173 --remote
  ```

- Suspension is D1-only (the contract can't block derivation). Removing an origin also kills that origin's vault
  shares on their next use.
- `app:*` need `apps/api/wrangler.jsonc` for the env (`gen <env>` first) and run `wrangler d1 execute` from `apps/api`.
- Not on `feat/batch-b`: per-app vault settings (`persistence`, TTLs, `raw_sign`, `google_web_client_id`,
  auto-approve). `admin app:settings` is on `b/settings-cli`. Until it merges the migration defaults apply
  (`session`, 12 h, 2 h, `off`, first Google client, no policy). Plans other than `free` need a manual D1 insert.

Owner actions on a registered scope (add a client, change owners, enable shared login) go through
`POST /v1/owner-actions` with a console-client token (`docs/api.md`); there is no CLI for them yet.

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

### Keys-updater key

Same steps with `.secrets/<env>/keys-updater.json` (key on `signer`), then re-upload `KEYS_UPDATER_KEY`. The plan
blocks on any other function-call key on `signer` that can call `set_issuer_key` / `remove_issuer_key`.

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

Scope owners (`--owner-near` / `--owner-google`) are separate: they change by a timelocked `SetOwners` owner action.

### Google signing keys (JWKS)

The hourly cron adds new kids and removes kids missing from Google's JWKS for ≥ 55 min. To sync now (after a deploy,
or when the cron has no `KEYS_UPDATER_KEY`):

```sh
corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --dry-run
corepack pnpm --filter @hana-id/scripts run post-google-keys <env>              # or --as-owner
```

It adds before it removes, and refuses to sync if Google returns no usable RS256 key.

### `VAULT_KEK`

```sh
corepack pnpm --dir apps/api exec wrangler secret put VAULT_KEK_PREVIOUS < .secrets/<env>/vault-kek
mv .secrets/<env>/vault-kek .secrets/<env>/vault-kek.previous
(umask 077; printf '2:%s' "$(openssl rand -base64 32)" > .secrets/<env>/vault-kek)     # a new id
corepack pnpm --dir apps/api exec wrangler secret put VAULT_KEK < .secrets/<env>/vault-kek
```

Unlocks and the hourly cron re-wrap old rows (≤ 2000 per run). When `vault_maintenance` logs no rows left under the
old id, `corepack pnpm --dir apps/api exec wrangler secret delete VAULT_KEK_PREVIOUS` and delete
`vault-kek.previous`. Rows under an id neither secret
has show as `unknownKek` (error level): they can't be unlocked until that key is back.

### A user's leaked key (`key_index`)

The path is `{scope_id}#{provider}#{sub}#{key_index}`, so a new `key_index` is a new key and new addresses. Rotation
is not built (`docs/batch-b-spec.md`, "Key rotation hooks"): the vault fixes `keyIndex = 0`, nothing on chain marks an
index retired, and the old key stays derivable by whoever can sign in as that user. Today: the user moves funds
using a session at the old index and logs in with another `keyIndex` (`apps/smoke` has a `key_index` field). Values
≥ 2^31 are reserved and refused.

## Smoke test (`apps/smoke`)

Needs a deployed env (contract, Google keys, API with secrets, `apiUrl` and `ckdNetworkKey` set), an app whose
origins include `http://localhost:5173` with a `pk_test_` key in a `sandbox*` / `local*` env (partner pages may only
call the session endpoints there), and `http://localhost:5173` on the clients' JavaScript origins.

```sh
corepack pnpm --filter @hana-id/smoke dev                                   # envs/sandbox-dev.json
VITE_HANA_ENV=<env> corepack pnpm --filter @hana-id/smoke dev
VITE_HANA_API_URL=http://localhost:8787 corepack pnpm --filter @hana-id/smoke dev   # local wrangler dev
```

Restart it after editing the manifest. The checklist (real MPC, app A vs B, key index, own vs shared client, revoke,
replays, `max_uses`, gas and latency) is in `apps/smoke/README.md`. Smoke still uses `/v1/sessions` + `/v1/derive`
with Google Identity Services tokens (they carry `email`), which is why `REJECT_PII_ON_SESSIONS` stays `"0"`.

## Logs and latency

```sh
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format pretty
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format json --search '"endpoint":"/v1/login"'
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
```

`observability` is on, so the same lines are in the Cloudflare dashboard. Each request logs one
`{"event":"request", …}` line with `status`, `code`, `latencyMs`, `colo`, `phases` and, for relays, `relayInstance`
(fields and phases: `docs/api.md`, "Logs"). Reading a slow request:

| Look at | Means |
|---|---|
| `colo` not near the user (e.g. US/EU for Malaysia) | Cloudflare routing (free-plan `workers.dev`); not fixable in code |
| `app`, `limits` large | D1 or limiter objects far away (`durableObjectLocation`) |
| `checks` large | chain reads (scope, `session_key_in_use`, `get_session`) or a JWKS fetch |
| `relayQueue` | waiting behind other txs of the same key |
| `relayChainRead` with `relayInstance.coldChainRead` | object started without a stored reservation (new or replaced key) |
| `relayChainRead` with `blockRefresh` only | stored block hash older than 5 min |
| `relayPersist` | a new 100-nonce reservation (~3–30 ms) |
| `relayOutcome` | the chain: execution, and on derive the MPC (~4.5 s) |

Measured on sandbox-dev (2026-10-27, real MPC, `docs/context.md` "Testnet measurements"):

| Call | Gas | Cost | Latency (median) |
|---|---|---|---|
| `create_session` | 19.98–20.15 Tgas | 0.0020 NEAR | 2.5 s after the latency work (was 4.3 s) |
| `derive_key` | 19.61–19.88 Tgas | 0.0019 NEAR | 6.4 s (6.0–6.7) after (was 7.1 s) |
| login (create + derive) | ~40 Tgas | ~$0.021 | ~8.9 s |
| `revoke_session` | 2.68 Tgas | 0.00025 NEAR | |
| rejected derive on chain | 2.21 Tgas | 0.0002 NEAR | |

Warm stage split: create = checks 0.2 s + relay 2.2 s (chain ~0.6 s); derive = relay ~6.0 s (MPC ~4.5 s).
`create_session_and_derive` (`/v1/login`) is not measured yet (estimate ~38 Tgas, 100 Tgas attached).

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
| cron logs `jwks_sync_skipped` | no `KEYS_UPDATER_KEY` | upload it |
| `503 vault_key_unavailable` | no `VAULT_KEK` (or the row's old key missing in `VAULT_KEK_PREVIOUS`) | set it |
| `GET /vault` 503, log code `misconfigured` | `API_URL` missing: a `wrangler.jsonc` generated before `apiUrl` reached `gen` (the tracked file has none) | `gen <env>` and redeploy |
| `403 origin_not_allowed` from a loopback origin | `pk_live_` key or a non-dev env name; or no `x-hana-parent-origin` from a Hana page | use `pk_test_` in `sandbox*`/`local*`; list the origin |
| `403 scope_conflict` | a `pk_test_` app shares its scope with a `pk_live_` app | separate scopes |
| `409 no_google_client` on `/v1/app` | scope has no Google client and no usable shared client (or shared client still in its timelock) | add a client, or `--allow-shared` + wait `changeDelayMs` |
| `admin`: "No wrangler config in apps/api" | `wrangler.jsonc` missing | `corepack pnpm --filter @hana-id/api run gen <env>` |
| `deploy-contract` "Cannot deploy until these are fixed" | a key with the wrong receiver, methods, empty method list or too-large/unlimited allowance | run the printed `near account delete-keys …`, re-run |
| A test fails after someone filled in `envs/sandbox-dev.json` | the test read the real manifest and expected `UNSET` placeholders | tests pin their own fixture manifest (see `scripts/test/deploy-plan.test.ts`, commit fdde123); never depend on live manifest values |
| API tests behave differently after `gen` (e.g. owner-action limiter tests) | `vitest.config.ts` loads `apps/api/wrangler.jsonc`, so a generated var such as `DO_LOCATION_HINT` leaks into tests | `vitest.config.ts` overrides it (`DO_LOCATION_HINT: ''`, commit 1fa72d9); override any new manifest-derived var there too |
| smoke refuses to derive: "UNSET placeholder" | `ckdNetworkKey` not pinned | `fetch-ckd-key <env>`, restart the dev server |

## CI and git

- Branches: feature branch → PR into `develop` (an org ruleset needs one approving review; the user merges);
  `main` = releases. Remote `Hana-Technology/hana-id` (private).
- CI (`.github/workflows/ci.yml`, on PRs and pushes to `develop` / `main`): gitleaks over the full history;
  `cargo test --locked` + `cargo near build non-reproducible-wasm`; `pnpm install --frozen-lockfile`, `pnpm -r
  typecheck`, `pnpm -r test`; sandbox e2e (`contracts/integration-tests`).
- The pre-commit hook runs `gitleaks git --staged` with `.gitleaks.toml`. Never bypass it (`--no-verify`). Scan
  locally with `corepack pnpm secrets:scan`.
- Never commit `.secrets/`, `.env*`, `.dev.vars` (all gitignored) or a regenerated `apps/api/wrangler.jsonc`. That
  file is tracked as the sandbox-dev version with the local placeholder D1 id; after `gen <env> --d1-id …` for a
  deploy, `git restore apps/api/wrangler.jsonc`. Edit the manifest or `gen-wrangler.ts`, never the file.
- `legacy/` is read-only reference code.
