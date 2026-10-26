# Hana ID

Embedded wallets from social login. A partner app integrates the Hana ID SDK; its users sign in with Google; the
NEAR contract `hana-signer` checks the Google ID token on-chain and asks the NEAR MPC network for the user's key via
Confidential Key Derivation (CKD), encrypted so only the user's browser can read it. Signing then happens locally.

Each partner app has its own **scope**, chosen by the token's `(provider, aud)` through a registry inside the
contract, so one app can never derive another app's users' keys. The user's key path is
`{scope_id}#{provider}#{sub}#{key_index}`.

**Testnet only.** Every account is a throwaway, and wallets derived on them are disposable.

More: [`docs/context.md`](docs/context.md) (how it works, decisions), [`docs/batch-a-spec.md`](docs/batch-a-spec.md)
(current work), [`docs/contract-interface.md`](docs/contract-interface.md) (contract methods and byte layouts).

## Layout

```
contracts/hana-signer/   Rust NEAR contract (near-sdk 5): OIDC verification, scope registry, sessions, CKD
apps/api/                Cloudflare Worker + Durable Objects + D1: the relayer partners call (publishable keys)
packages/env/            Environment manifest schema (zod) + loadEnv()
envs/                    One manifest per environment (sandbox-dev.json): every account name and endpoint
scripts/                 Deploy, Google key sync, CKD key pinning, admin CLI (TypeScript, run with tsx)
legacy/                  Read-only reference: the earlier PoC client and relayer
docs/                    Spec, context, contract interface
```

## Setup

Needs Node 22+, pnpm 11, Rust (the toolchain in `contracts/hana-signer/rust-toolchain.toml` with the
`wasm32-unknown-unknown` target), ideally `cargo-near` (`cargo install cargo-near`), and near CLI
(near-cli-rs 3.x) for creating accounts.

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
| Sync Google keys once | `pnpm --filter @hana-id/scripts run post-google-keys <env> [--dry-run]` |
| Pin the MPC CKD key | `pnpm --filter @hana-id/scripts run fetch-ckd-key <env> [--dry-run]` |
| Admin (apps, scopes) | `pnpm --filter @hana-id/scripts run admin <env> <command> …` |

All scripts take the environment name (`envs/<env>.json`) first and print `--help`.

### deploy-contract

```
deploy-contract <env> [--yes] [--relayer-keys 3] [--relayer-allowance 2] [--updater-allowance 1]
                      [--upgrade] [--wasm <file>] [--skip-build]
```

Reads what is already on chain, prints a plan, and changes nothing without `--yes`. Re-running plans only what is
missing, so it is safe to resume after a failure. Steps:

1. Build the wasm (`cargo near build non-reproducible-wasm`, or plain `cargo build --target wasm32-unknown-unknown`
   if cargo-near is missing).
2. Deploy to `signer` and call `new(owner, mpc, ckd_domain_id, change_delay_ms)` in the same transaction.
   (`--upgrade` redeploys code to an initialised contract without calling `new`.)
3. Add N function-call keys (default 3) on `relayer`, receiver = `signer`, limited to `create_session`,
   `derive_key`, `revoke_session`, `prune_sessions`, `register_scope`, `propose_change`, `cancel_change`,
   `remove_client`, `execute_change`, with a gas allowance per key (default 2 NEAR).
4. Add the keys-updater function-call key on `signer` itself (receiver = `signer`, methods `set_issuer_key`,
   `remove_issuer_key`, default allowance 1 NEAR), which lets the API cron rotate Google keys without the owner key.
5. `set_issuer("google", ["https://accounts.google.com", "accounts.google.com"])`, `set_sponsors([relayer])`,
   `set_console_audiences` if the manifest lists any, and `admin_register_scope` for the reserved `global` scope
   with `googleClientIds` plus the `consoleAudiences` (skipped with a warning while `googleClientIds` are still
   `UNSET…` placeholders). Console audiences go into `global` so no scope owner can claim them with
   `propose_change(AddClient)`. Set `consoleAudiences` before the first deploy: once `global` exists, a missing
   console audience is only a warning, and adding it later takes a timelocked `propose_change` by the owner.

It does not create accounts. If one is missing, or its key is not in the keychain, the plan says so and shows the
near CLI command to fix it.

An allowance is charged each call's full prepaid gas (300 Tgas ≈ 0.03 NEAR at testnet prices), and refunds go to
the account, not back to the allowance. So 2 NEAR covers roughly 60 calls per key. Pass a larger
`--relayer-allowance` for heavier testing. To replace a used-up key, delete it on chain with near CLI, remove it from
`.secrets/<env>/relayer-keys.json`, and re-run.

If you switch an env to a new `signer` account, the keys in `.secrets/<env>/relayer-keys.json` are still on the
relayer as function-call keys for the old signer. NEAR can't add the same key twice, so the plan stops and lists them.
Either move `relayer-keys.json` aside (fresh keys are generated, and you then re-upload `RELAYER_KEYS`) or delete
those keys from the relayer with near CLI, then re-run.

### Keys: where they come from and where they go

- **Full-access keys** for `owner`, `signer` and `relayer` are read from the near CLI **legacy keychain**:
  `~/.near-credentials/testnet/<account>.json` (`{"account_id","public_key","private_key"}`), or the per-key files in
  `~/.near-credentials/testnet/<account>/`. near-cli-rs writes these when you choose `save-to-legacy-keychain`
  (`near account create-account … save-to-legacy-keychain …` or `near account import-account … save-to-legacy-keychain`).
  The scripts only read them; they are never copied or printed.
- **Generated keys** go to `.secrets/<env>/` (gitignored; directory 0700, files 0600). Nothing generated is printed:
  - `relayer-keys.json`: JSON array of `ed25519:…` secret keys, the API's `RELAYER_KEYS` secret.
  - `keys-updater.json`: `{"account_id","public_key","private_key"}`, whose `private_key` is the API's
    `KEYS_UPDATER_KEY` secret.

  Each key is saved before it is added on chain, so a key that lands on chain is never lost.

### post-google-keys

Fetches Google's JWKS, compares it with `get_issuer("google")`, and calls `set_issuer_key` for new kids, then
`remove_issuer_key` for retired ones. This is the same diff the API's hourly cron runs. It signs with the keys-updater
key from `.secrets/<env>/keys-updater.json` (`--as-owner` uses the owner's keychain key instead). It refuses to sync
if Google returns no usable RS256 key.

### fetch-ckd-key

Reads `state` from the MPC contract (`manifest.mpc`), takes the BLS12-381 G2 public key of `ckdDomainId`, and writes
it to `ckdNetworkKey` in `envs/<env>.json`, leaving the rest of the file as it was. Clients pin this key. If it ever
changes, every derived key changes with it.

### admin

```
admin <env> app:create --name <name> --scope <scope_id> --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | pk_test_…> --origin <origin> […] [--remote]
admin <env> app:origins:remove --app <app id | pk_test_…> --origin <origin> […] [--remote]
admin <env> app:suspend|app:resume --app <app id | pk_test_…> [--remote]
admin <env> app:list [--remote]
admin <env> scope:register --client <google client id> […] (--owner-near <account> | --owner-google <sub>) […] [--yes]
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
- `scope:register` calls `admin_register_scope(owners, clients, null)` with the owner's keychain key. Without `--yes`
  it prints the call and stops. It works only while `public_registration` is false, and the contract assigns the id
  (`s1`, `s2`, …), which the command prints.

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
2. **Fill in the manifest**: account names, `googleClientIds` (Hana's own Google OAuth client IDs, which become the
   `global` scope), `consoleAudiences` if any, `changeDelayMs`, and the Cloudflare names.
3. **Pin the MPC key**: `pnpm --filter @hana-id/scripts run fetch-ckd-key <env>`.
4. **Deploy**: `pnpm --filter @hana-id/scripts run deploy-contract <env>`, read the plan, then re-run with `--yes`.
5. **Post Google's keys**: `pnpm --filter @hana-id/scripts run post-google-keys <env>`.
6. **API**:
   ```sh
   pnpm --dir apps/api exec wrangler d1 create <cloudflare.d1Name>            # once; deployed envs only: prints the database id
   pnpm --filter @hana-id/api run gen <env> --d1-id <id>                      # writes apps/api/wrangler.jsonc (omit --d1-id for local only)
   pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local   # or --remote
   # Upload secrets without echoing them (run from the repo root):
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' \
     | pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' \
     | pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   pnpm --filter @hana-id/api run deploy
   ```
   For local `wrangler dev`, the same two values go in `apps/api/.dev.vars` (gitignored, 0600):
   `pnpm --filter @hana-id/api run gen <env> --dev-vars` writes it from `.secrets/<env>/` without printing them.
7. **Register a partner**:
   ```sh
   pnpm --filter @hana-id/scripts run admin <env> scope:register --client <partner>.apps.googleusercontent.com --owner-near <partner-or-owner>.testnet --yes
   pnpm --filter @hana-id/scripts run admin <env> app:create --name "Partner" --scope s1 --origin https://partner.example --origin http://localhost:5173 [--remote]
   ```
   Give the partner the printed `pk_test_…` key.

## Safety

- Testnet only. The manifest schema accepts only `testnet`, and the scripts refuse an RPC whose `chain_id` is not
  `testnet`.
- Never print, log or commit private keys, CKD outputs or Google ID tokens. Generated keys live only in
  `.secrets/<env>/` (0600). Full-access keys stay in `~/.near-credentials`. `.env`, `.dev.vars` and `.secrets/` are
  gitignored.
- Anything that changes how a path or key is derived changes every user's address: the MPC network, the signer
  account, the path format, or the local derivation. That is allowed before the address freeze, but must be called
  out. After the freeze, never.
- The relayer's keys can only call the listed `hana-signer` methods, and only up to their allowance. A leaked
  relayer key can burn gas, but it cannot derive anyone's key, because every session needs a Google token
  committing to the user's own session key.
- Hana cannot change a scope's client IDs or owners after registration, or block derivation on chain. App suspension
  happens only in D1, through the API.
