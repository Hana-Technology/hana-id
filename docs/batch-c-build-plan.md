# Batch C build plan

Status: plan (2026-10-30), for review. Splits `docs/batch-c-spec.md` (the source of truth for what is built) into
batches that each merge into `develop` on their own: tests green, the docs they change updated, and nothing a partner,
a user or staff can reach that is half-wired. Ordered by dependency; the spec's "Build order" steps are noted per
batch. This is a plan, not a spec: where it and the spec disagree, the spec wins or gets amended first.

Batches merge one at a time. Deploys happen at the milestones at the end; a merged batch whose code nothing reaches yet
(a new table no code reads, a Worker with no route) is inert in a deployed env until its milestone.

## Conventions for every batch

- Branch `feat/batch-c-<n>` from `develop`, one PR, merged before the next one that depends on it starts its review.
- Tests per behaviour as the spec's "Tests" section lists them; each batch below names the ones it owns.
- Current-state docs (`docs/README.md`) change in the same branch with their "Last verified" line. Decisions go into
  `docs/decisions.md` when they are made.
- Migrations: the hot DB's continue `apps/api/migrations` after the governance batch's `0005_issuer_key_sync.sql`, so
  batch C's are **0006** (expand) and **0007** (drop legacy `usage`); `CONSOLE_DB`'s start at `apps/console/migrations/
  0001`; Neon's start at `apps/api/migrations-usage/0001`. A migration is immutable once merged; later batches add
  files. Another batch that needs a hot-DB migration first takes the next free number and renumbers what is unmerged.
- Setup and deploy steps are instructions for the user. No batch's agent connects to Neon, creates Hyperdrive or D1
  resources, runs wrangler against an account, deploys or sends a chain transaction.
- Neon is Postgres only, reached through Hyperdrive. Neon Auth, Better Auth and Neon's other services are not used
  (D74, D75).

## Batches

| # | Batch | Spec step | Depends on |
|---|---|---|---|
| C1 | Foundation: manifest, `console-core`, `CONSOLE_DB` schema, Neon ledger DDL, `usage-migrate` | 1 (part), 2 (part) | — |
| C2 | `packages/oidc`: RS256 / JWKS / claims moved out of the API, new claims | 1 (part) | — |
| C3 | Hot DB expand (0006), the gate and preflight on it, the CLI on it | 1 (part), 7 (part) | C1 |
| C4 | Usage capture: `recordUsage`, uid, relay key and nonce, gas fields, Hyperdrive writer, D1 counters removed | 1 (part), 2 | C1, C3 |
| C4b | Legacy `usage` export and migration 0007 | 2 (part) | C4, C11's `EXPORTS` bucket |
| C5 | `AdminRpc` and `ConsoleRpc` core: CAS, kill switches, keys, settings, staff proposals, notices ack, cancel, expedite, activation, drift, breaker, budget | 3 | C3 |
| C6 | Owner-verified changes and owner actions: `changeOrigins` / `proposeChange` verification, owner-action precheck, caps, allowance alert, `ConsoleRpc.ownerAction`, the console sink scope | 1 (part), 3 (part) | C2, C5 |
| C7 | Console Worker backend: dispatch, headers, CSRF, `StaffRpc`, invites and owner grants (data path), hourly cron; no public route | 4 (part) | C1, C5 |
| C8 | Admin Worker: Access check, screens, `EmailSender` (Resend), blocking notices, feed, watcher | 6 (part) | C5, C7 |
| C9 | Partner sign-in: console-auth Worker, code flow, sessions, membership rules, read-only console | 4 (part) | C2, C7, C8 |
| C10 | Partner management: fresh sign-in, guarded-change UI with the policy editor, settings, keys, suspend and resume, members and invites, owner actions and the client-proof helper, cancel pages | 4 (part) | C6, C9 |
| C11 | Files Worker, R2 buckets, logos, `logoUrl` in `GET /v1/app` and the auth pages | 5, 7 (part) | C5, C10 |
| C12 | Reports, settlement, rates, nonce check, statements (CSV, PDF, on-screen), exports, rejection-rate alert | 6 (part) | C4, C8, C11 |
| C13 | Retention: monthly purge job and screen, `purgeAudit` RPCs, `uid:erase`, console housekeeping purges | 6 (part) | C12 |
| C14 | Admin "Security & monitoring" view and the pending-upgrades page (governance D83, D86) | — | C8 |
| C15 | Support ID lookup (D96) | — | C4, C8 |
| C16 | CLI completion and cleanup: `scope:register --owners-from-org`, `owner:relay`, `app:*` retirement plan | 7 | C9 |
| C17 | Testnet smoke on sandbox-dev | 8 | all |

## C1. Foundation (this branch, `feat/batch-c-1`)

Shared contracts of data and config that every later batch builds on. Inert in a deployed env: nothing reads the new
manifest blocks, tables or vars yet.

- **Scope**
  - `packages/env`: required top-level `appChangeDelayMs` (60 000 … 7 d; ≥ 24 h and `changeDelayMs ≥
    appChangeDelayMs` on a production network) and the optional dashboard blocks `console`, `files`, `admin`, `usage`,
    `email` and `ownerGrantDelayMs`, present together or not at all, with the spec's refinements (distinct origins and
    names, Hana-origin rules, lowercased non-empty staff list, Access team domain and AUD shape, bucket and Hyperdrive
    names, email `from` header safety). `hanaOwnOrigins(m)`: the `REFUSED_ORIGINS` list. sandbox-dev gets
    `appChangeDelayMs: 60000` (its `changeDelayMs`); it gets the dashboard blocks only once the domains exist (Q3).
  - `packages/console-core` (new): zod schemas and types of §Types and §RPC interfaces (`Actor`, `Ctx`, `RpcCode` and
    the HTTP map, the console-only codes, views of the `CONSOLE_DB` rows), the `UsageEvent` v1 schema, ids
    (prefix + base58 of 12 random bytes), RFC 8785 canonical JSON, every §Nonce layout (console login, generic
    step-up, origin change, settings change, owner action and client proof from pre-encoded args, cancel link, invite
    and owner-grant tokens, uid with path parsing), `normaliseOrigin`, the origin refusal rules, punycode display and
    the mixed-script rule. Vectors from an independent Node script (`scripts/gen-vectors.mjs`, the
    `gen-fixtures.mjs` style) and the contract's `test_fixture.json`.
  - `CONSOLE_DB` schema: `apps/console/migrations/0001_init.sql` (every table of §`CONSOLE_DB`, `org_legacy`, the
    append-only triggers on `audit_log`), in a new `apps/console` package that holds only the migrations and their
    tests until C7.
  - Neon ledger DDL: `apps/api/migrations-usage/0001_ledger.sql` (schemas `usage` and `ops`, every table, monthly
    partitions with `usage.ensure_partitions`, `usage.record_event`, the statement and rate triggers, roles `NOLOGIN`,
    grants with `EXECUTE` revoked from `PUBLIC`). The report, ledger, rejection-rate and retention functions come with
    C12 and C13 as `0002`, `0003`.
  - `scripts/usage-migrate.ts`: applies `migrations-usage` in order as the owner over the direct URL from
    `.secrets/<env>/neon.json`, one transaction per file, recorded with its sha256 in `hana_migrations.applied`;
    refuses a changed applied file, a pooled URL and a non-`postgresql:` URL; dry run by default, `--yes` applies;
    never prints the URL. Uses `pg` (exact-pinned, D93).
  - `gen-wrangler`: the API's config gains `APP_CHANGE_DELAY_MS`, `NETWORK`, `REFUSED_ORIGINS` and, with the dashboard
    blocks, `FILES_ORIGIN`. Not read until C3 (`APP_CHANGE_DELAY_MS`, `REFUSED_ORIGINS`, `NETWORK`) and C11
    (`FILES_ORIGIN`).
- **Files**: `packages/env/src/{schema,dashboard}.ts` and tests; `envs/sandbox-dev.json`; the three manifest fixtures
  (`apps/api/scripts/gen-wrangler.ts`, `apps/watchdog/scripts/gen-wrangler.ts`, `apps/demo/test/fixtures.ts`);
  `packages/console-core/**`; `apps/console/{package.json,vitest.config.ts,migrations,test}`;
  `apps/api/migrations-usage/0001_ledger.sql`, `apps/api/test-usage/**`, `apps/api/vitest.usage.config.ts`;
  `scripts/usage-migrate.ts`, `scripts/lib/usage-migrate.ts` and test; docs.
- **Tests**: manifest refinements (spec "Topology and config": distinct origins, delay bounds and the production
  minimum, `changeDelayMs ≥ appChangeDelayMs` on production, blocks together, non-empty staff list); `gen-wrangler`
  emits the four vars. `console-core`: JCS (RFC 8785 examples), every layout against the independent vectors and the
  contract fixture, purpose separation (no two layouts give the same digest for the same inputs), `normaliseOrigin`
  shared vectors (IDN, ports, trailing dot, `[::1]`, uppercase), refusal rules, mixed script, punycode against Node's
  `domainToUnicode`, uid path parsing (wrong prefix, part count, `key_index` ignored), zod round trips and refusals.
  `CONSOLE_DB` on local D1 (Miniflare): every CHECK, the invite and auth-flow invariants, `org_legacy`, the
  `audit_log` triggers (UPDATE refused, DELETE refused under 60 months, allowed after), the CHECK lists equal the
  `console-core` enums. Neon on PGlite (D140): the migration applies on an empty database and twice through
  `usage-migrate`; the writer can execute only `record_event` (direct `INSERT`, `SELECT`, `UPDATE`, `DELETE` on every
  table refused); the admin can't update or delete events, statements or settlements and can't call `record_event`;
  `record_event` idempotent on retry, refuses a bad shape, `first_seen` is the minimum out of order, an event outside
  every partition fails; statement UPDATE/DELETE refused; a rate change refused once its month has a statement;
  `ensure_partitions`; every valid `UsageEvent` from `console-core` is accepted and the schema's refusals are refused
  by the function too.
- **Migrations**: none applied anywhere. `CONSOLE_DB` and Neon files exist; the hot DB is untouched.
- **Setup / deploy**: none required. Optional (to prove the DDL on Neon early): `usage-migrate sandbox-dev` (dry run),
  then `--yes`, against the sandbox-dev branch; see "Setup steps" below.
- **Visible after**: nothing in any env. Developers get the shared types, layouts and schemas.

## C2. `packages/oidc`

- **Scope**: move `apps/api/src/{jwt,jwks}.ts` (RS256 verification, the JWKS cache, claim checks) into
  `packages/oidc`, unchanged in behaviour for the API; `verifyIdToken` and `VerifiedToken` gain `email`,
  `email_verified`, `iat`, `hd`, `azp`, `amr`, `auth_time` (API callers ignore them); an Access-JWT verifier (`type`,
  `aud`, `iss`, non-empty `sub`, `email`) for C8.
- **Tests**: the API's existing JWT and JWKS tests pass from the package; new-claim parsing; Access-JWT refusals
  (spec "Admin and email": missing, wrong `aud`/`iss`, expired, unknown `kid`, empty `sub`).
- **Migrations / setup**: none. **Visible**: nothing (refactor).

## C3. Hot DB expand and the gate on it

- **Scope**
  - `apps/api/migrations/0006_dashboard_expand.sql`: everything in spec §Hot DB "Migration 0006", its triggers and
    the five-step backfill.
  - The two login-path reads, `appGate` (`suspended_by`, `scopes.environment`), `preflightAllows`, the vault page and
    share checks on `app_keys` and `active_from`; loopback by `environment = 'test'` in a dev env; `first_session_at`
    in `waitUntil`; revoked key = `unknown_app`.
  - The API reads `APP_CHANGE_DELAY_MS` (and refuses guarded changes with `internal` when it is missing or out of
    range), `REFUSED_ORIGINS`, `NETWORK`. The hourly cron records activations of guarded changes, promotes policies
    and raw signing, ends replaced policies, and cancels changes not announced within 7 days.
  - CLI (spec §CLI, the hot-DB rows): `app:create --org` (writes `scopes`, `app_keys`, `app_changes`, origins as
    staff proposals, the `no_session` waiver when it created the scope), `app:origins:add` and `app:settings` as staff
    proposals, new `app:changes:announce <id>` (envs without an `admin` block only; refused on a production network;
    prints that nobody was emailed), `app:origins:remove`/`app:suspend`/`app:resume` with `app_changes` and bit 1,
    `app:list` with pending changes, keys and `suspended_by`. `normaliseOrigin` and the origin rules come from
    `console-core`; `scripts/lib/admin-sql.ts`'s copies are removed. `--org` accepts `org_legacy` until C7 creates
    `CONSOLE_DB` (then any org the console DB holds).
  - Every API test seed writes `scopes` and `app_keys`.
- **Tests**: spec "Hot DB and gate" (0006 on an empty DB and on a sandbox-dev-shaped snapshot with row counts
  unchanged, `active_from = 0`, `first_session_at` set, baseline rows, indexes kept; the batch B gate, preflight and
  share SQL answer the same; `suspended_by` → `status`; test/live mix refused; no code reads `apps.publishable_key`);
  "Guarded changes" rows that need no RPC (a pending origin refused everywhere until `active_from`, allowed by
  predicate after; a pending policy not returned until effective; activation recorded once; 7-day expiry); the CLI's
  new SQL against local D1.
- **Migrations**: hot DB 0006.
- **Setup / deploy (milestone M1)**: back up sandbox-dev's D1 (`wrangler d1 export`), apply 0006 remotely, deploy the
  API, then use only the new CLI. Pending origin adds on sandbox-dev go live after `app:changes:announce` plus
  `appChangeDelayMs` (60 s).
- **Visible after**: on sandbox-dev, CLI origin adds and policy or raw-signing enables are delayed and announced by
  hand; existing apps behave as before.

## C4. Usage capture

- **Scope**: `apps/api/src/usage/` (UsageEvent v1 from `console-core`, `recordUsage` in `waitUntil` with one retry
  after 250 ms, the uid from the request's path with `USER_ID_KEY`); relay results carry the signing key's public key
  and nonce; `FinalOutcome` gains typed gas fields with BigInt sums; the D1 `usage` counters stop being written
  (`countUsage`, `incrementUsage` removed); optional `USAGE_DB` binding (`gen --usage-hyperdrive-id`); `pg`
  exact-pinned in the API; `scripts/usage-setup.ts` (role passwords and the two Hyperdrive configs) and
  `USER_ID_KEY` generation in `.secrets/<env>/user-id-key` (0600, never printed).
- **Tests**: spec "Topology and config" first two rows (logins with no binding; logins identical with a refusing
  server, `usage_write_failed` once after one retry); "Usage ledger" capture rows (one event per post-gate outcome,
  none for gate rejections or `GET /v1/app`, allowlist snapshot, `org_id` from the gate row, `relayer_pk`/
  `relayer_nonce` on relayed events, the relay-code → `relayed` table, uid vectors and path refusals, gas BigInt sum
  over a recorded `tx`).
- **Setup / deploy (milestone M2)**: see "Setup steps" 1–4 and 6; then `gen --usage-hyperdrive-id <writer id>` and
  deploy the API.
- **Visible after**: usage rows in Neon for every login on sandbox-dev (staff can query them with SQL as the owner).

## C4b. Legacy usage export and 0007

- `scripts/usage-legacy-export.ts`: writes the D1 `usage` table once to `EXPORTS` (`legacy/usage-<env>.csv`) with
  row counts verified; then `apps/api/migrations/0007_drop_legacy_usage.sql`. Applied only after the export, after C4
  is deployed (nothing writes `usage` any more). Needs the `EXPORTS` bucket (setup step 7).

## C5. `AdminRpc` and `ConsoleRpc` core

- **Scope**: `apps/api/src/rpc/{console,admin}.ts` as `WorkerEntrypoint`s with zod-validated inputs (`console-core`),
  `src/changes/` (the CAS batch helper with `app_changes` as commit point, versions, the `requestId` replay rule), every
  method of both interfaces except the member-proposed guarded changes and owner actions (C6) and the Neon-backed
  `usage`/`statements`/`ledger` (C12): listing and views with `WHERE org_id = ?`, `removeOrigins`, `turnOff`,
  `updateSettings`, `setLogo` (pointer only), keys (create, rotate with 24 h grace, revoke, 5-key limit), suspension
  bits, `createApp`/`assignScopeOrg`/`deleteApp`/`suspendOrg`, security contacts, staff `addOrigins`/`proposeChange`,
  `pendingNotices`/`ackNotice` with the deterministic cancel-link token, `cancelChange`/`cancelChangeByLink`,
  `expediteChange`, `listScopes`, `changesSince`, `securityEvents`, `relayerKeys`; drift detection in the hourly cron;
  the destructive-call breaker and the hot-DB budget on the `RateLimiter` object.
- **Tests**: spec "CAS, breaker, budget"; "Guarded changes" for staff proposals, ack, cancel (owner, staff, link),
  waivers, expedite, versions, drift, the 20-origin and one-pending rules; "Apps, scopes" for `createApp`,
  `assignScopeOrg`, `deleteApp`, contacts; `ConsoleRpc`/`AdminRpc` unreachable from `fetch`; org A → org B is
  `not_found` on every org method.
- **Setup / deploy**: none of its own (deploy with C6 or later; the entrypoints have no route).
- **Visible**: nothing until a Worker binds the entrypoints.

## C6. Owner-verified changes, owner actions, sink scope

- **Scope**: `ConsoleRpc.changeOrigins`/`proposeChange` with the API's six-step verification (`packages/oidc`,
  on-chain `console_audiences`, `iat` ≤ 300 s, the recomputed layout nonce and version, uncached `get_scope` owner
  check, token reservation); `handleOwnerAction` refactor (`clientIp` from RPC), `precheckOwnerAction`
  (`owner_nonce_mismatch`, `invalid_client_proof` before reservation), per-scope cap and the separate safety budget
  with `owner_cap` events, the `owner_allowance_low` check, `ConsoleRpc.ownerAction`; owner-action args borsh
  encoding in `console-core`; `deploy-plan` steps for the console sink scope (fresh env: before `register-global`;
  existing env: `remove_client` of each console audience from `global`, then `admin_register_scope` for the sink),
  and `register-global` stops counting console audiences.
- **Tests**: spec "Guarded changes" verification refusals; "Apps, scopes, owner actions" TS port vs
  `test_fixture.json`, precheck, caps, allowance; deploy-plan tests for both sink paths.
- **Setup / deploy (milestone M3, before the address freeze)**: deploy the API, then run the sink-scope plan on
  sandbox-dev (`deploy-contract`, dry run then `--yes`). No user address changes (spec "Address impact").
- **Visible**: console audiences no longer clients of `global` on sandbox-dev.

## C7. Console Worker backend

- **Scope**: `apps/console` Worker: host dispatch, §Response headers, assets with `run_worker_first`, CSRF rules,
  the Workers rate-limiting binding, `StaffRpc` (orgs, members, invites issue/revoke with `token_hash` NULL until
  `ackMemberNotice`, owner grants, `pendingMemberNotices`, `setMember`, `disableUser`, `freezeOrg`, `auditSince`,
  `queryAudit`), the passkey gate on `issueInvite`, the hourly cron (invite expiry, owner grants recorded, short-lived
  purges, replaced logos). `gen-wrangler` writes `apps/console/wrangler.jsonc` (`CONSOLE_DB`, `API` → `ConsoleRpc`,
  `workers_dev: false` and no route until C9).
- **Tests**: spec "Invites and roles" rows that need no sign-in (11th open invite, notice-first token, grant timing,
  cancel, passkey gate, `issueInvite` returns the token once); config snapshots (only the console binds `ConsoleRpc`
  and `CONSOLE_DB`); host dispatch; headers; no `put`/`delete` on `STATEMENTS`.
- **Setup**: create the console D1 (setup step 5), apply `apps/console/migrations`.
- **Visible**: nothing (no route).

## C8. Admin Worker

- **Scope**: `apps/admin` Worker and SPA: Access JWT check on every `/api/*` with `admin.staffEmails`, host
  dispatch, headers, the staff screens over `AdminRpc` and `StaffRpc` (orgs, members, invites, contacts, apps,
  changes, keys, audit with CSV), `EmailSender` with the Resend adapter and a test fake, blocking notices
  (`change_pending`, `member_invite`, `owner_grant`) acked only after every send is accepted, the feed with cursors in
  `ops.state`, the on-chain watcher (`ops.scope_snapshot`, `ops.scope_watch`). `gen-wrangler` writes its config
  (`USAGE_DB` admin binding, `preview_urls: false`, `workers_dev: false` on production manifests).
- **Tests**: spec "Admin and email"; the watcher rows of "Apps, scopes, owner actions"; config snapshots (only the
  API and admin bind Hyperdrive, to different configs).
- **Setup / deploy (milestone M4, with C9)**: Access application (setup step 8), Resend domain and key (step 9),
  `EMAIL_API_KEY`, `CANCEL_LINK_KEY`, `INVITE_LINK_KEY` secrets (step 10), the admin Hyperdrive id.
- **Visible after M4**: staff console on sandbox-dev; notices emailed; CLI staff proposals announced by email instead
  of `app:changes:announce`.

## C9. Partner sign-in

- **Scope**: `apps/console-auth` (thin Worker: `/start` and `/callback` to the console's `AuthHandler`), the code flow
  with PKCE and the implicit-flow guard, handoff codes, `console_sessions` with `__Host-` cookies, idle and absolute
  expiry, membership rules and invite acceptance as one batch, `GET /api/me`, read-only screens (apps, origins,
  changes, keys, settings, members, audit merged with `listChanges`). Console route on.
- **Tests**: spec "Code flow and sessions"; "Invites and roles" acceptance rows; Playwright sign-in under the CSP on
  staging.
- **Setup**: the console Google OAuth client (no JavaScript origins; redirect `<console.authOrigin>/callback`) and
  `CONSOLE_GOOGLE_CLIENT_SECRET` (setup step 11); open question 1 tested here.
- **Visible after M4**: invited partners sign in and see their org read-only.

## C10. Partner management

- **Scope**: fresh sign-in (`pending_actions`, step-up flows, every kind), the guarded-change screens (origins with
  IDN flags, the policy editor with the consent preview, raw signing), settings, name, keys, suspend/resume, members
  and invites (D89), on-chain owner actions with the downloadable client-proof helper and the PII warning, owner drift,
  the cancel and cancel-owner pages (POST confirm), `GET /api/governance/pending-upgrades` stays for C14.
- **Tests**: spec "Fresh sign-in"; "Settings, keys"; the role matrix; owner-action rows that need the console.
- **Visible**: the console's write paths; the spec's "Done when" bullets 2–4 on the smoke scope.

## C11. Files Worker and logos

- **Scope**: `apps/files` (only `GET /logos/<app_id>/<64 hex>.png`, §Response headers), logo upload through the
  Images binding, `logo_objects`, the 30-day replaced-logo purge, `logoUrl` in `GET /v1/app`, `FILES_ORIGIN` in the
  auth pages' `img-src`; R2 buckets and rules.
- **Tests**: spec "Settings, keys, logos" logo rows; no `put`/`delete` on `LOGOS` in the files Worker; headers.
- **Setup**: R2 buckets with the `STATEMENTS` lock and `EXPORTS` lifecycle (setup step 7); Images binding on the
  account.

## C12. Reports and statements

- **Scope**: Neon `0002_reports.sql` (`org_report`, `org_statements`, `org_ledger`, `rejection_rates`); admin crons
  (settlement every 15 min, the daily nonce check, rate fetch with the audited override, `ensure_partitions`,
  rejection-rate alert); `ConsoleRpc.usage`/`statements`/`ledger`; report screens (console and admin); statement issue
  with CSV, PDF (`pdf-lib`, exact-pinned) and on-screen views, the ledger CSV and exports.
- **Tests**: spec "Usage ledger" report, settlement, nonce-check, statement, golden-CSV, rejection-rate and D92 rows.

## C13. Retention

- **Scope**: Neon `0003_retention.sql` (`drop_expired_partitions`, `strip_uids`, `purge_app_users`, `erase_uid`),
  `AdminRpc.purgeAudit`/`deletedApps`, `StaffRpc.purgeAudit`, the monthly job with `ops.retention_runs`, its screen
  and the `retention_failed` email, `scripts/uid-erase.ts`.
- **Tests**: spec "Usage ledger" retention rows (D90).

## C14. Security & monitoring and pending upgrades

- The admin "Security & monitoring" view (D83, D126; `docs/governance-spec.md` "Monitoring in the admin portal") and
  the pending-upgrades page in both consoles (D86). The view **must render the incident playbooks from the
  `@hana-id/playbooks` package** (being specified separately: spec §Hana admin console and `docs/operations.md`
  "Watchdog alerts" are owned by that work); this batch consumes the package and its completeness test rather than
  writing playbook text. Sources: the watchdog's status endpoint, `GET /v1/governance`, the security screen's events.

## C15. Support ID lookup (D96)

- The spec names the screen but not its data path. Needs a short spec addition first (open question below): which
  Hana secret derives the code, where sessions and errors for a uid come from (the ledger has per-request rows by
  uid; the vault has none), retention.

## C16. CLI completion

- `scope:register --owners-from-org`, `owner:relay --body`, `app:*` retirement once the admin console covers them
  after the pilot (spec §CLI).

## C17. Testnet smoke

- The spec's "Testnet smoke" list on sandbox-dev, then staging when the Hana account exists.

## Milestones (deploys)

| Milestone | After | What goes live on sandbox-dev |
|---|---|---|
| M1 | C3 | Hot DB 0006, the new gate, the new CLI |
| M2 | C4 | Usage capture into Neon |
| M3 | C6 | RPC entrypoints (unbound), owner-action precheck and caps, the console sink scope |
| M4 | C7–C9 | Console (sign-in, read-only), admin console, notices by email |
| M5 | C10–C11 | Console write paths, logos |
| M6 | C12–C13 | Reports, statements, retention |

## Setup steps (for the user, when each milestone deploys)

Run from the main checkout; every file in `.secrets/` is 0600 in a 0700 directory and never printed.

1. **Neon project** (exists, 2026-10-30): `hana-id`, AWS Sydney (`aws-ap-southeast-2`), Postgres 18, branches
   `production` and `sandbox-dev`; sandbox-dev's owner connection strings are in `.secrets/sandbox-dev/neon.json`.
   Turn on point-in-time restore for the window the plan allows (open question 5).
2. **Ledger schema** (C1 onwards): `corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev` (dry run: lists
   pending files), then the same with `--yes`. Uses `DATABASE_URL_DIRECT` (the owner role over a direct, non-pooled
   connection).
3. **Roles' credentials** (C4): `corepack pnpm --filter @hana-id/scripts usage-setup sandbox-dev` (dry run) then
   `--yes`: generates a password per role, runs `ALTER ROLE usage_writer|usage_admin LOGIN PASSWORD …` as the owner,
   writes `.secrets/sandbox-dev/neon-usage-writer.url` and `neon-usage-admin.url` (pooled host is not used: Hyperdrive
   pools).
4. **Hyperdrive** (C4 writer, C8 admin): `usage-setup … --hyperdrive --yes` creates `hana-id-usage-writer-sandbox-dev`
   and `hana-id-usage-admin-sandbox-dev` with caching disabled and prints their ids (not secret); pass them to `gen`
   (`--usage-hyperdrive-id`, `--admin-hyperdrive-id`). Confirm Hyperdrive is available on the account's plan first
   (open question 5).
5. **Console D1** (C7): `corepack pnpm --dir apps/api exec wrangler d1 create hana-id-console-sandbox-dev`, then
   apply `apps/console/migrations` remotely; pass the id to `gen` (`--console-d1-id`).
6. **`USER_ID_KEY`** (C4): `usage-setup … --user-id-key` writes 32 random bytes to `.secrets/sandbox-dev/user-id-key`
   and an offline backup is made by hand; `wrangler secret put USER_ID_KEY` on the API only.
7. **R2** (C11, C4b): buckets from the `files` block; `STATEMENTS` with a 7-year bucket lock, `EXPORTS` with a 30-day
   lifecycle rule except `legacy/`.
8. **Cloudflare Access** (C8): the admin application on `admin.origin` (Custom Domain on production; Worker-level
   Access on `workers.dev` for sandbox-dev, D75); policy: GitHub team `hana-admins` in `Hana-Technology` plus the
   exact-email Google fallback (open question 4); copy the team domain and AUD tag into the manifest.
9. **Resend** (C8, D87): the sending subdomain with SPF, DKIM and DMARC; an API key for the admin Worker only.
10. **Admin secrets** (C8): `EMAIL_API_KEY`, `CANCEL_LINK_KEY`, `INVITE_LINK_KEY` (32 random bytes each, generated
    into `.secrets/<env>/`, then `wrangler secret put`).
11. **Console Google client** (C9): a Web client with no JavaScript origins and one redirect URI,
    `<console.authOrigin>/callback`; its id in `consoleAudiences`, `CONSOLE_GOOGLE_CLIENT_SECRET` as a console secret.
12. **Manifest**: add the `console`, `files`, `admin`, `usage`, `email` blocks and `ownerGrantDelayMs` to
    `envs/sandbox-dev.json` once the origins exist (workers.dev for sandbox-dev, D93).

## Open questions this plan raises (with the recommended answer)

1. **Loopback origins: dev env or non-production network?** Spec §Origin input rules allows loopback on test scopes
   in any non-production env (by `NETWORK`), while §Login-path reads counts them only in a dev env (`local*`,
   `sandbox*`), as batch B does. Recommended: the dev-env rule in both places (C1's `originProblem` implements it);
   the Hana-run testnet env partners test against (D93 Q25) is named `sandbox-*`.
2. **Production ledger: its own Neon project?** The spec said one project per env with production in its own; the
   project created on 2026-10-30 holds both `production` and `sandbox-dev` as branches. Recommended: a separate
   project for production before mainnet (own credentials, PITR window, deletion protection and member access), keep
   the branch for staging-style rehearsals until then. Part of open question 5.
3. **Hyperdrive on the account's plan** (open question 5): confirm before M2; without it the API keeps capture off
   (the binding is optional) and logins are unaffected.
4. **Support ID data path** (C15): the spec names the admin screen but not where a user's sessions, logins and
   errors come from. Recommended: derive the lookup from the ledger's `uid` (requests by the user) plus `app_changes`
   for the app; no new store; a short spec section before C15.
5. **`ownerGrantDelayMs`**: kept as its own manifest field (the spec's), with `appChangeDelayMs`'s bounds and the
   same production minimum, rather than reusing `appChangeDelayMs`. Recommended as built in C1.
