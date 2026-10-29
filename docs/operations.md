# Operations runbook — running a Hana ID environment (testnet only)

Last verified against code: 2026-10-28 (commit 58edee9).

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
| Keys-updater key (`KEYS_UPDATER_KEY`) | `.secrets/<env>/keys-updater.json` (`private_key`) | `deploy-contract` |
| `VAULT_KEK` (and, during a rotation, `VAULT_KEK_PREVIOUS`) | `.secrets/<env>/vault-kek` (and `vault-kek.previous`); the only copy, since Cloudflare can't give a secret back | `vault-kek` (below) |
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
| `rpcFallback` (optional) | a second NEAR RPC from another provider, https; the vault and the export window read from it only when `rpc` fails or times out | not `rpc` itself; built into the vault and auth bundles and in the API's and auth Worker's CSP (`NEAR_RPC_FALLBACK`), so a change needs `gen`, a page build and a redeploy of the API and both page Workers (D65) |
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

## Local API (`wrangler dev`)

```sh
corepack pnpm --filter @hana-id/api run gen <env> --dev-vars     # wrangler.jsonc + apps/api/.dev.vars (0600)
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local
corepack pnpm --filter @hana-id/api dev                          # http://localhost:8787
```

`gen` writes the gitignored `apps/api/wrangler.jsonc` for that env (needed by `dev` and `admin app:*`). `--dev-vars`
writes `RELAYER_KEYS`, `OWNER_RELAYER_KEYS` (single-quoted) and `KEYS_UPDATER_KEY` from `.secrets/<env>/`, skipping
missing files, and prints only a count. It rewrites the whole file and has no `VAULT_KEK`; for local vault endpoints
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
admin <env> app:create --name <name> --scope <scope_id> --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:suspend        --app <app id | publishable key> [--remote]
admin <env> app:resume         --app <app id | publishable key> [--remote]
admin <env> app:list [--remote]
admin <env> app:settings <app id | publishable key> [--persistence session|none] [--session-ttl 12h] [--idle-ttl 2h]
             [--raw-sign off|approval] [--google-web-client <client id>|default] [--auto-approve <policy.json>|off] [--remote]
admin <env> scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […] [--yes]
admin <env> issuer-keys:lead-times [--remote]
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

- Suspension is D1-only (the contract has no suspension; D11). Removing an origin also kills that origin's vault
  shares on their next use. Logins, relays, `GET /v1/app` and new vault page loads see a suspension or an origin
  removal at once; the vault endpoints (unlock, touch, revoke, share creation) cache the app per Worker isolate, so
  there it takes up to 30 s (D78).
- `app:*` need `apps/api/wrangler.jsonc` for the env (`gen <env>` first) and run `wrangler d1 execute` from `apps/api`.
- `app:settings` (app positionally or with `--app`, not both; no setting flags: show them): ranges as the migration's
  CHECKs; `--raw-sign approval` and a new `--auto-approve` policy are pending for 24 h (`changeDelayMs` in dev envs),
  `off` is immediate. A relative `--auto-approve` path is resolved against the directory you ran `pnpm` from
  (`INIT_CWD`), and the change log names the resolved file. The UPDATE only applies if every settings column is still
  as the command read it: if someone else changed the app in between, nothing is written and the command fails with
  "The app's settings changed since they were read"; run it again. `--persistence none` revokes existing vault
  shares on their next unlock or touch; a lower `--session-ttl` also shortens live shares (to their creation + the new
  TTL). Plans other than `free` need a manual D1 insert.

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

### Issuer key lead times (D33)

D33's issuer-key delay must stay shorter than the time between Google publishing a signing key and Google signing
the tokens our users bring with it, or logins with a new key fail until the delay ends. The API measures it in D1
`issuer_key_observations` (migration `0004_issuer_key_observations.sql`; kids and timestamps only):

- **First / last seen in the JWKS, removed**: every cron run (every 15 min) fetches Google's JWKS and records each
  kid; the run at :00 does so from the sync's own fetch. The API's verification fetches (on cache expiry, or on an
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
# once per app: the vault loads only on the app's origins (needs apps/api/wrangler.jsonc: `gen sandbox-dev`)
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:add \
  --app pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie --origin https://hana-id-demo-sandbox-dev.tingtc.workers.dev --remote

corepack pnpm --filter @hana-id/demo run deploy      # gen:envs, vite build, gen (apps/demo/wrangler.jsonc), wrangler deploy
corepack pnpm --filter @hana-id/demo run build && corepack pnpm --filter @hana-id/demo run gen \
  && corepack pnpm --filter @hana-id/demo exec wrangler deploy --dry-run   # check without deploying
```

- The Worker sets the page's CSP (`frame-src` exactly `vaultOrigin`, `connect-src` exactly the EVM RPC, no inline
  code, `frame-ancestors 'none'`, Trusted Types) and `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP
  `same-origin-allow-popups` on every response; preview URLs are off and it answers only on its own origin.
- Redeploy after changing `envs/<env>.json` (the vault origin is in the CSP and the bundle) or `@hana-id/web`.
- "Could not load the Hana vault" on the demo: the origin isn't on the app (`app:origins:add` above), or the build is
  for another env. `admin <env> app:list --remote` shows the app's origins.
- Removing the origin (`app:origins:remove`) signs out everyone who used the demo, on their next use.

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

`observability` is on, so the same lines are in the Cloudflare dashboard. Each request logs one
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
- Never commit `.secrets/`, `.env*`, `.dev.vars` or the generated `apps/api/wrangler.jsonc`, `wrangler.vault.jsonc`,
  `wrangler.auth.jsonc`, `wrangler.vitest.jsonc` and `apps/demo/wrangler.jsonc` (all gitignored and untracked;
  `wrangler.jsonc` holds an env's D1 id, the page and demo configs their origins and Worker names). Edit the
  manifest or `gen-wrangler.ts`, never the files. CI needs none of them: the API tests generate
  `wrangler.vitest.jsonc` from a fixed test manifest (`TEST_MANIFEST` in `gen-wrangler.ts`) on every run.
- `legacy/` is read-only reference code.
