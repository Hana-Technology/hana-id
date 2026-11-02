# @hana-id/email-issuer

The Hana-run email issuer (`docs/email-login-spec.md` "Email issuer (Hana-run)", build plan batch 4): a Cloudflare
Worker, separate from the API, that sends sign-in codes, mints email tokens (JWS General JSON, RS256) whose nonces it
computes per purpose, answers `google-match` for automatic linking, publishes its JWKS and serves the staff routes (client proofs, unlock,
unsuppress) behind Cloudflare Access. It is reached at `{emailIssuer.url}/v1/email/*` (D230): its own `workers.dev`
URL on a `workers.dev` env (sandbox-dev), the API's URL through a zone route in production; never through the API
Worker, so an address or a code never passes through it.
**Not deployed**; no app enables email yet (the sandbox-dev steps: `docs/operations.md` "Email login on sandbox-dev").

Reference: endpoints, limits, Durable Objects, D1 and logs in `docs/api.md` "Email issuer"; setup and runbook in
`docs/operations.md` "Email issuer"; keys and invariants in `docs/security.md`; decisions D195–D199.

## What it holds

| Secret | What |
|---|---|
| `ISSUER_SIGNING_KEY` | RSA-2048 private JWK of signer `hana` (testnet only; mainnet: AWS KMS, `src/kms.ts`, not wired). The standby key is published but stays offline (D196) |
| `EMAIL_SUB_KEY` (K_sub) | feeds every email user's `sub` (`@hana-id/email` `emailSub`): never rotated. K_sup, derived from it, keys the suppressions (the exact address) |
| `EMAIL_CODE_KEY` (K_code) | code MACs in the challenge objects; K_device, derived from it, signs owner device tickets |
| `EMAIL_RL_KEY` (K_rl) | limiter keys: the mailbox (the address without its `+tag`) and the recipient domain |
| `SENDGRID_API_KEY` | Mail Send only, this Worker's alone (D194) |

It reads hana-signer views over the manifest's RPC and the API's D1 (`app_keys`, `apps`, `plans`) read only, finding an
app as the API's gate does (a key in `app_keys` not revoked or in its grace, an undeleted app, active only with
`suspended_by = 0`; `apps.login_methods` for email, D233); it never reads the legacy `apps.publishable_key`, writes
nothing on chain and holds no chain key.

## Layout

| File | Role |
|---|---|
| `src/handlers.ts` | the routes: `start`, `resend`, `verify`, `google-match`, `admin/client-proof`, `admin/unlock`, `admin/unsuppress`, `admin/revoke-tickets`, `confirm`, JWKS, discovery, the SendGrid webhook |
| `src/commitment.ts`, `src/layouts.ts` | purposes, commitments and every nonce (checked against the contract's `email_fixture.json`) |
| `src/decide.ts` | the four cases of automatic linking, judged as the contract's `auto_link` will |
| `src/challenge.ts`, `src/challenge-id.ts` | `Challenge` Durable Object: one challenge or link ticket, atomic attempts, single use; the challengeId's public half (the object's name) and secret half (the address's encryption key) |
| `src/keys.ts` | the HMAC keys, their derived keys (K_sup, K_device), codes, owner device tickets |
| `src/rate-limiter.ts`, `src/limits.ts` | `RateLimiter` Durable Object and every limit (D198): per (mailbox, requester), per mailbox, the device ticket's allowance, the 25-a-day guess ceiling, the budget's per-app shares |
| `src/domain.ts`, `src/ip.ts` | the recipient domain's cap (registrable domain, exempt consumer providers); IP subjects and their /24, /56, /48 prefixes |
| `src/jws.ts`, `src/signer.ts`, `src/kms.ts` | JWS JSON minting with a self-check; the Worker-secret signer; the KMS adapter (aws4fetch) |
| `src/sender.ts`, `src/sendgrid.ts`, `src/outbox.ts`, `src/mail.ts` | the sender interface, SendGrid v3, the `local*`-only outbox stub, the per-purpose mail texts |
| `src/google.ts`, `src/chain.ts`, `src/apps.ts`, `src/access.ts`, `src/webhook.ts` | Google (ID token, tokeninfo, userinfo, revoke), NEAR views, the app lookup, Cloudflare Access, SendGrid's signed events |
| `scripts/gen-contract-fixture.ts` | writes `contracts/hana-signer/src/issuer_tokens_fixture.json` (tokens from this code, for the contract's unit tests), deterministically from a public test seed; `scripts/test/gen-contract-fixture.test.ts` checks the committed file matches |
| `migrations/0001_init.sql` | the issuer's D1: `email_issuance`, `email_hints`, `email_suppressions`, `email_admin_audit` |

## Commands

```sh
corepack pnpm --filter @hana-id/email-issuer test        # Worker tests (miniflare) and the gen tests
corepack pnpm --filter @hana-id/email-issuer typecheck
corepack pnpm --filter @hana-id/scripts email-issuer <env> init --from "Hana <login@…>" --budget <n> [--yes]   # keys + manifest, uploads nothing
corepack pnpm --filter @hana-id/email-issuer gen <env> [--d1-id <uuid>] [--app-d1-id <uuid>] [--dev-vars]
corepack pnpm --filter @hana-id/scripts email-issuer <env> put [--standby] [--yes]    # the user uploads the secrets
corepack pnpm --filter @hana-id/email-issuer exec tsx scripts/gen-contract-fixture.ts   # after a layout or token change
corepack pnpm --filter @hana-id/email-issuer dev
```

The tests reach no network: Google, NEAR, SendGrid and KMS are fakes (Google's real client code runs against a fake
fetch); the RSA keys and HMAC keys are throwaway values made per run. `test/privacy.test.ts` greps every log line of
every flow for the address, the code, the `sub`, the tokens and the secrets.
