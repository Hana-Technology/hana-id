# @hana-id/email-issuer

The Hana-run email issuer (`docs/email-login-spec.md` "Email issuer (Hana-run)", build plan batch 4): a Cloudflare
Worker, separate from the API, that sends sign-in codes, mints email tokens (JWS General JSON, RS256) whose nonces it
computes per purpose, answers `google-match` for automatic linking, publishes its JWKS and mints staff client proofs.
**Not deployed**; no app enables email yet.

Reference: endpoints, limits, Durable Objects, D1 and logs in `docs/api.md` "Email issuer"; setup and runbook in
`docs/operations.md` "Email issuer"; keys and invariants in `docs/security.md`; decisions D195–D199.

## What it holds

| Secret | What |
|---|---|
| `ISSUER_SIGNING_KEY` | RSA-2048 private JWK of signer `hana` (testnet only; mainnet: AWS KMS, `src/kms.ts`, not wired). The standby key is published but stays offline (D196) |
| `EMAIL_SUB_KEY` (K_sub) | feeds every email user's `sub` (`@hana-id/email` `emailSub`): never rotated |
| `EMAIL_CODE_KEY` (K_code) | code hashes in the challenge objects |
| `EMAIL_RL_KEY` (K_rl) | mailbox limiter keys (the address without its `+tag`) and suppression keys (the exact address) |
| `SENDGRID_API_KEY` | Mail Send only, this Worker's alone (D194) |

It reads hana-signer views over the manifest's RPC and the API's D1 (`apps`, `plans`) read only; it writes nothing on
chain and holds no chain key.

## Layout

| File | Role |
|---|---|
| `src/handlers.ts` | the routes: `start`, `resend`, `verify`, `google-match`, `admin/client-proof`, JWKS, discovery, the SendGrid webhook |
| `src/commitment.ts`, `src/layouts.ts` | purposes, commitments and every nonce (checked against the contract's `email_fixture.json`) |
| `src/decide.ts` | the four cases of automatic linking, judged as the contract's `auto_link` will |
| `src/challenge.ts` | `Challenge` Durable Object: one challenge or link ticket, atomic attempts, single use |
| `src/rate-limiter.ts`, `src/limits.ts` | `RateLimiter` Durable Object and every limit (D198): per (mailbox, requester), per mailbox, the 25-a-day guess ceiling |
| `src/jws.ts`, `src/signer.ts`, `src/kms.ts` | JWS JSON minting with a self-check; the Worker-secret signer; the KMS adapter (aws4fetch) |
| `src/sender.ts`, `src/sendgrid.ts`, `src/outbox.ts`, `src/mail.ts` | the sender interface, SendGrid v3, the `local*`-only outbox stub, mail texts |
| `src/google.ts`, `src/chain.ts`, `src/apps.ts`, `src/access.ts`, `src/webhook.ts` | Google (ID token, tokeninfo, userinfo, revoke), NEAR views, the app lookup, Cloudflare Access, SendGrid's signed events |
| `migrations/0001_init.sql` | the issuer's D1: `email_issuance`, `email_hints`, `email_suppressions`, `email_admin_audit` |

## Commands

```sh
corepack pnpm --filter @hana-id/email-issuer test        # Worker tests (miniflare) and the gen tests
corepack pnpm --filter @hana-id/email-issuer typecheck
corepack pnpm --filter @hana-id/scripts email-issuer <env> init --from "Hana <login@…>" [--yes]   # keys + manifest, uploads nothing
corepack pnpm --filter @hana-id/email-issuer gen <env> [--d1-id <uuid>] [--app-d1-id <uuid>] [--dev-vars]
corepack pnpm --filter @hana-id/scripts email-issuer <env> put [--yes]    # the user uploads the secrets
corepack pnpm --filter @hana-id/email-issuer dev
```

The tests reach no network: Google, NEAR, SendGrid and KMS are fakes (Google's real client code runs against a fake
fetch); the RSA keys and HMAC keys are throwaway values made per run. `test/privacy.test.ts` greps every log line of
every flow for the address, the code, the `sub`, the tokens and the secrets.
