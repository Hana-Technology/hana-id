# Hana ID

Embedded wallets from social login (Google now, email later), keys derived by NEAR MPC Confidential Key Derivation (CKD).
A Privy-style service: partners integrate an SDK; users log in with Google; the NEAR contract `hana-signer` checks the
Google token on-chain and asks the MPC for the user's key, encrypted so only the user's browser can read it.

Start with `docs/context.md` (how it works, decisions so far) and `docs/batch-a-spec.md` (current work).
Plan doc: https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi

## Rules

- Testnet NEAR only. Never deploy to mainnet or use mainnet accounts.
- Derived keys, CKD secrets, relayer keys and owner keys are full private keys: never log them, print them, write them
  outside `.secrets/` (gitignored, 0600), or commit them. Same for Google ID tokens.
- Never commit `.env`, `.dev.vars` or `.secrets/`.
- Account names come from `envs/<env>.json`. Don't hard-code `*.testnet` names in code (tests and manifests excepted).
- Anything that changes how a path or key is derived changes every user's address. Before the address freeze
  (final accounts deployed) that's allowed but must be called out; after it, never.
- `legacy/` is read-only reference code from wend-widget-demo.
- Git: remote `Hana-Technology/hana-id` (private). Work on feature branches, PR into `develop`; `main` = releases.
  A gitleaks pre-commit hook blocks secrets; never bypass it (`--no-verify`).
- Target is a production MVP (mainnet, real funds): production standards everywhere, tests for every behaviour.

## Layout

`contracts/hana-signer` (Rust, near-sdk) · `apps/api` (Cloudflare Worker + Durable Objects + D1) · `packages/env`
(manifest schema) · `envs/` · `scripts/` (deploy, keys, admin CLI) · `docs/`.

## Commands

- Contract: `cd contracts/hana-signer && cargo test`; wasm: `cargo near build non-reproducible-wasm`
- TS: `pnpm install`, `pnpm -r test`, `pnpm -r typecheck`
- API dev: `pnpm --filter @hana-id/api gen <env> [--dev-vars]`, then `pnpm --filter @hana-id/api dev`
