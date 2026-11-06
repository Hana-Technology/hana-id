# @hana-id/email-issuer

The Hana-run email issuer (`docs/email-login-spec.md` "Email issuer (Hana-run)", build plan batch 4): a Cloudflare
Worker, separate from the API, that sends sign-in codes, mints email tokens (JWS General JSON, RS256) whose nonces it
computes per purpose, answers `google-match` for automatic linking and `google-record` (D270: under the popup's
`'token_first'` flow, a Google login of an app without email login, for the user directory only), keeps the user
directory (D269: each identity's address, for Hana staff only), publishes its JWKS and serves the staff routes (client
proofs, unlock, unsuppress) behind Cloudflare Access. It is reached at `{emailIssuer.url}/v1/email/*` (D230): its own `workers.dev`
URL on a `workers.dev` env (sandbox-dev), the API's URL through a zone route in production; never through the API
Worker, so an address or a code never passes through it. `gen` turns on `workers_dev` only for a `workers.dev` `url`;
a `url` on another host (a dev env on custom domains) becomes the issuer's own Custom Domain (D404).
It binds no D1 of the API's: it reads apps through the API Worker's read-only `IssuerRpc` entrypoint (service binding
`API`, D432; it replaced the read-write `APP_DB` of D251), so the API must serve `IssuerRpc` before this Worker deploys.
**Not deployed**; no app enables email yet (the sandbox-dev steps: `docs/operations.md` "Email login on sandbox-dev").

Reference: endpoints, limits, Durable Objects, D1 and logs in `docs/api.md` "Email issuer"; setup and runbook in
`docs/operations.md` "Email issuer"; keys and invariants in `docs/security.md`; decisions D195–D199.

**The user directory (D269).** The issuer keeps each identity's verified address in its own D1 (`user_emails`,
`user_email_apps`, migration 0002), for Hana staff only: written after the answer at every successful `verify`
(`src/directory.ts`, best effort: a failure logs `directory_write_failed` and never fails a login; writes may land
out of order, and a row keeps the newest write's address, `email_verified`, `hosted` and scope), read with
`admin <env> user:list` / `user:find` (`docs/operations.md` "User directory (D269)") and by the admin console's Users
screen through **`DirectoryRpc`** (C8b, D275): a named entrypoint with no route, bound only by the admin Worker as
`ISSUER`, with three reads (`search`, `get`, `auditSince`; a `get` is audited `user_view`, or `support_lookup` for
the admin's Support ID lookup, D399). Every call carries the staff request's Access JWT, which
the issuer verifies itself against the admin application (`ADMIN_ACCESS_TEAM_DOMAIN`, `ADMIN_ACCESS_AUD`,
`ADMIN_STAFF_EMAILS`, written by `gen` from the manifest's `admin` block); each read takes its rows from the staff
member's budget (500 identities an hour, 2 000 a day) and writes its `email_admin_audit` row in the same D1 batch
(migration 0003); the ticket is required to open one identity and optional to search. No route serves the directory;
partners never see it. Logs still never carry an address.

## What it holds

| Secret | What |
|---|---|
| `ISSUER_SIGNING_KEY` | RSA-2048 private JWK of signer `hana` (testnet only; mainnet: AWS KMS, `src/kms.ts`, not wired). The standby key is published but stays offline (D196) |
| `EMAIL_SUB_KEY` (K_sub) | feeds every email user's `sub` (`@hana-id/email` `emailSub`): never rotated. K_sup, derived from it, keys the suppressions (the exact address) |
| `EMAIL_CODE_KEY` (K_code) | code MACs in the challenge objects; K_device, derived from it, signs owner device tickets |
| `EMAIL_RL_KEY` (K_rl) | limiter keys: the mailbox (the address without its `+tag`) and the recipient domain |
| `SENDGRID_API_KEY` | Mail Send only, this Worker's alone (D194) |

It reads hana-signer views over the manifest's RPC and the API's apps through `IssuerRpc` (`src/apps.ts`; the API runs
the lookups in `apps/api/src/issuer-apps.ts`), finding an app as the API's gate does (a key in `app_keys` not revoked or in its grace, an undeleted app, active only with
`suspended_by = 0`; `apps.login_methods` for email, D233); it never reads the legacy `apps.publishable_key`, writes
nothing on chain and holds no chain key.

## Layout

| File | Role |
|---|---|
| `src/directory.ts` | the user directory's writer (D269): one upsert per identity and per (identity, app), after the answer, never throwing |
| `src/directory-rpc.ts` | `DirectoryRpc` (C8b, D275, D388–D392): the admin Users screen's reads; the staff check, the row budget, the audit in the read's batch, the address term's keyed hash. A source check holds it to its SELECTs and one audit INSERT, its bindings and its imports (`scripts/test/directory-rpc-source.test.ts`) |
| `src/handlers.ts` | the routes: `start`, `resend`, `verify`, `google-match` and `google-record` (one set of Google checks, `checkGoogleSignIn`; both write the Google identity to the directory after the answer), `admin/client-proof`, `admin/unlock`, `admin/unsuppress`, `admin/revoke-tickets`, `confirm`, JWKS, discovery, `health` (the deployed build id, D384), the SendGrid webhook |
| `run deploy` | the shared wrapper `packages/env/src/stamped-deploy.ts` (D406): `wrangler deploy --var HANA_BUILD:<build id>` (this checkout's commit, `-dirty` for uncommitted changes), which `GET /v1/email/health` reports and `deploy-check <env>` compares |
| `src/commitment.ts`, `src/layouts.ts` | purposes, commitments and every nonce (checked against the contract's `email_fixture.json`) |
| `src/decide.ts` | the four cases of automatic linking, judged as the contract's `auto_link` will |
| `src/challenge.ts`, `src/challenge-id.ts` | `Challenge` Durable Object: one challenge or link ticket, atomic attempts, single use; the challengeId's public half (the object's name) and secret half (the address's encryption key) |
| `src/keys.ts` | the HMAC keys, their derived keys (K_sup, K_device), codes, owner device tickets |
| `src/rate-limiter.ts`, `src/limits.ts` | `RateLimiter` Durable Object and every limit (D198): per (mailbox, requester), per mailbox, the device ticket's allowance, the 25-a-day guess ceiling, the budget's per-app shares. Dev envs (`local*`, `sandbox*`) get higher code, wrong-code and per-IP limits (D340): `limitsFor(ENV_NAME)` picks the set once per request and the mailbox object gets it with each call, so a change applies to the counters already stored |
| `src/domain.ts`, `src/ip.ts` | the recipient domain's cap (registrable domain, exempt consumer providers); IP subjects and their /24, /56, /48 prefixes |
| `src/jws.ts`, `src/signer.ts`, `src/kms.ts` | JWS JSON minting with a self-check; the Worker-secret signer; the KMS adapter (aws4fetch) |
| `src/sender.ts`, `src/sendgrid.ts`, `src/outbox.ts`, `src/mail.ts` | the sender interface, SendGrid v3, the `local*`-only outbox stub, the per-purpose mail texts |
| `src/google.ts`, `src/chain.ts`, `src/apps.ts`, `src/access.ts`, `src/webhook.ts` | Google (ID token, tokeninfo, userinfo; the access token is never revoked, D265), NEAR views, the app lookup, Cloudflare Access, SendGrid's signed events |
| `scripts/gen-contract-fixture.ts` | writes `contracts/hana-signer/src/issuer_tokens_fixture.json` (tokens from this code, for the contract's unit tests), deterministically from a public test seed; `scripts/test/gen-contract-fixture.test.ts` checks the committed file matches |
| `migrations/0001_init.sql` | the issuer's D1: `email_issuance`, `email_hints`, `email_suppressions`, `email_admin_audit` |
| `migrations/0003_directory_audit.sql` | `email_admin_audit` rebuilt with every row (C8b, D392): the actions `user_search`, `user_view`, `support_lookup`, the ticket optional on a search only, `detail` JSON |
| `migrations/0002_user_emails.sql` | the user directory (D269): `user_emails`, `user_email_apps`; written after the answer, best effort (`src/directory.ts` `recordUserEmailLater`: a failure logs `directory_write_failed` with the app and scope only) |

## Commands

```sh
corepack pnpm --filter @hana-id/email-issuer test        # Worker tests (miniflare) and the gen tests
corepack pnpm --filter @hana-id/email-issuer typecheck
corepack pnpm --filter @hana-id/scripts email-issuer <env> init --from "Hana <login@…>" --budget <n> [--yes]   # keys + manifest, uploads nothing
corepack pnpm --filter @hana-id/email-issuer gen <env> [--d1-id <uuid>] [--dev-vars]     # binds the API's IssuerRpc; no API D1
corepack pnpm --filter @hana-id/scripts email-issuer <env> put [--standby] [--yes]    # the user uploads the secrets
corepack pnpm --filter @hana-id/email-issuer run deploy                               # stamped with the build id (never a raw wrangler deploy)
corepack pnpm --filter @hana-id/scripts run deploy-check <env> --d1                   # the issuer on the API's and the pages' commit (D384)
corepack pnpm --filter @hana-id/email-issuer exec tsx scripts/gen-contract-fixture.ts   # after a layout or token change
corepack pnpm --filter @hana-id/email-issuer dev
```

The tests reach no network: Google, NEAR, SendGrid and KMS are fakes; the `API` binding reaches the real API Worker
(bundled by `vitest.config.ts` with wrangler's dry run) and its `IssuerRpc`, on a D1 the tests seed as `API_TEST_DB`
(`test/apps-client.test.ts`, and `scripts/test/api-read-only.test.ts` for the binding rules, D432) (Google's real client code runs against a fake
fetch); the RSA keys and HMAC keys are throwaway values made per run. `test/privacy.test.ts` greps every log line of
every flow for the address, the code, the `sub`, the tokens and the secrets (google-record and the directory's failure
line included), and checks that a verified address is in `user_emails` and no other table;
`test/directory-verify.test.ts` covers which `verify` answers record, `test/google-record.test.ts` google-record and
google-match's directory write, `test/directory.test.ts` the upserts in both arrival orders, `test/directory-rpc.test.ts`
DirectoryRpc (the staff check, the searches, the ticket rule, the audit's atomicity and `detail`, the row budget, no
address in a log line).

Last verified: 2026-11-06 (branch `feat/issuer-readonly-rpc`: the `API` → `IssuerRpc` binding instead of `APP_DB`, `gen` without `--app-d1-id`, the tests' auxiliary API Worker, D432); 2026-11-05 (branch `feat/deploy-check-all-workers`: `run deploy` is the shared wrapper, D406); 2026-11-05 (branch `feat/batch-c-15-screen`: `DirectoryRpc.get`'s `purpose`, D399); 2026-11-05 (branch
`feat/batch-c-8b`: `DirectoryRpc`, migration 0003, the `ADMIN_*` vars, D388–D392);
2026-11-05 (branch `feat/deploy-build-check`: `GET /v1/email/health`, `scripts/deploy.ts`, D384);
2026-11-04 (branch `fix/dev-email-limits`: dev envs' limit set, D340, `test/dev-limits.test.ts`; every
other test runs under production's, its harness env names `t-…` not being dev names); 2026-11-04 (branch `fix/user-emails-review`: the directory's order-safe upserts, D269); 2026-11-04
(branch `feat/google-token-first`: `google-record`, google-match's directory write, D269,
D270).
