# Batch C build plan

Status (2026-11-04, branches `feat/batch-c-9`, `feat/batch-c-14` and `feat/batch-c-12`, on `develop`; `feat/batch-c-13`; 2026-11-05, `feat/batch-c-15`): C1–C5 merged into `develop` and running in the
sandbox-dev API as far as `develop` includes them (migrations 0006, 0009 and 0010 applied, usage capture off;
`docs/operations.md`); C6 (the claim allow-list on its tokens, D277), C7 (the console Worker backend; D240–D244), C8
(the admin Worker; D278–D285) and C11 (the files Worker and logos; D300–D308) merged into `develop`, not deployed (M3
not run; their setup is steps 4, 5 and 7–10 below, at M4 and M5); C9 (partner sign-in, D290–D297) merged into
`develop`, not deployed (its setup is steps 11 and 12, at M4); C14 (Security & monitoring and the pending-upgrades
page; D330–D338, D344) and C12 (reports and statements; D320–D329) merged, not deployed; C10 (partner management, D342,
D343, D350–D358) merged into `develop`, not deployed; the partner screens over C12's and C14's routes (usage,
statements, pending upgrades; D370–D374) built on `feat/console-reports-upgrades`, not merged; C13 (retention; D360–D369) built on `feat/batch-c-13`, tests green, not merged, not deployed (its setup is
`docs/operations.md` "Retention", at M6); C15 (the Support ID lookup's backend, the session answers' `supportId`, the vault's
`hana.supportId` and the approval popup; D394–D397, D393, D276 confirmed and amended) built on `feat/batch-c-15`, tests green, not merged,
not deployed, its admin screen left for after C8b; C8b (the Users screen; D275 confirmed 2026-11-05, D388–D392) built on
`feat/batch-c-8b`, tests green, not merged, not deployed (the Support ID lookup's screen over C15's route is not in it);
C16–C17 not built. Plan of 2026-10-30. Splits `docs/batch-c-spec.md` (the source of truth for what is built) into
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
  Taken outside batch C: **0008** (`0008_identity_token.sql`, the partner identity token, `feat/identity-token-1`,
  D172): its own tables only, so 0006 and 0007 keep their numbers and apply before or after it; batch C's usage
  ledger (C4) should also count `identity_tokens` per app and day (today `identity_usage` in D1). Taken by C4:
  hot-DB **0009** (`0009_session_markers.sql`, D220; 0007 stays C4b's) and Neon **0002**
  (`0002_identity_tokens.sql`, D223) and **0003** (`0003_writer_partitions.sql`, the writer keeps partitions
  ahead). The email work then took Neon **0004** (`0004_email_counts.sql`) and **0005** (`0005_link_events.sql`), so
  C12's functions are **0006** (`0006_reports.sql`, D320) and C13's retention functions take **0007**; C15 needs no Neon
  migration (0007 has its indexes, D362).
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
| C8b | Users screen (D275, confirmed 2026-11-05): `DirectoryRpc` on the email issuer, issuer migration 0003, the admin screen | — | C8 |
| C9 | Partner sign-in: console-auth Worker, code flow, sessions, membership rules, read-only console | 4 (part) | C2, C7, C8 |
| C10 | Partner management: fresh sign-in, guarded-change UI with the policy editor, settings, keys, suspend and resume, members and invites, owner actions and the client-proof helper, cancel pages | 4 (part) | C6, C9 |
| C11 | Files Worker, R2 buckets, logos, `logoUrl` in `GET /v1/app` and the auth pages | 5, 7 (part) | C5, C10 |
| C12 | Reports, settlement, rates, nonce check, statements (CSV, PDF, on-screen), exports, rejection-rate alert | 6 (part) | C4, C8, C11 |
| C13 | Retention: monthly purge job and screen, `purgeAudit` RPCs, `uid:erase`, console housekeeping purges | 6 (part) | C12 |
| C14 | Admin "Security & monitoring" view and the pending-upgrades page (governance D83, D86) | — | C8 |
| C15 | Support ID lookup (D96; D276 confirmed and amended, D394–D397) | — | C4 (the screen: C8b) |
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
    C12 and C13 (planned as `0002`, `0003`; now `0006` and `0007`, see "Conventions").
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

Built on `feat/batch-c-4` (2026-11-02; D220–D224, to confirm). Beyond the scope below: hot-DB migration 0009
(`session_markers`, the C3 obligation), Neon 0002 (identity tokens per app and day, copied hourly from D1),
`usage-setup` as subcommands (`roles`, `hyperdrive`, `user-id-key`), gitleaks rules for the new secret files.
Setup for the user: `docs/operations.md` "Usage capture (batch C4, milestone M2)".

- **Scope**: `apps/api/src/usage/` (UsageEvent v1 from `console-core`, `recordUsage` in `waitUntil` with one retry
  after 250 ms, the uid from the request's path with `USER_ID_KEY`); relay results carry the signing key's public key
  and nonce; `FinalOutcome` gains typed gas fields with BigInt sums; the D1 `usage` counters stop being written
  (`countUsage`, `incrementUsage` removed); optional `USAGE_DB` binding (`gen --usage-hyperdrive-id`); `pg`
  exact-pinned in the API; `scripts/usage-setup.ts` (role passwords and the two Hyperdrive configs) and
  `USER_ID_KEY` generation in `.secrets/<env>/user-id-key` (0600, never printed).
- **Carried over from C3 (forward obligation, D205):** the `no_session` waiver (`scripts/lib/admin-sql.ts`
  `noSessionWaiver`; the same rule in `AdminRpc.ackNotice` from C5) treats a D1 `usage` row of any app of the scope
  as a sign of a user. Once C4 stops writing those counters, and before C4b's 0007 drops the table, replace that
  check with one that still sees new sessions: e.g. a hot-DB marker the API writes beside the relay (as it already
  does for `scopes.first_session_at`), not a Neon read (the hot path and the waiver must not depend on Neon). Its test
  rows move with it. **Done** (D220): `session_markers` (migration 0009), written once the first session-pool relay
  settled; the CLI's waiver and C5's `AdminRpc.ackNotice` (`changes/lifecycle.ts`) both read it.
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
  is deployed (nothing writes `usage` any more) and after the one-off `usage` → `session_markers` statement of
  `docs/operations.md` "Usage capture" step 7 (D220), run again right before 0007. Needs the `EXPORTS` bucket (setup step 7). Nothing reads `usage`
  any more (`apps/api/scripts/test/hot-db-reads.test.ts` checks it).

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

Status (2026-11-04): built (`feat/batch-c-6`, D235–D239), merged with current `develop` on `feat/batch-c-6-merge`:
the owner tokens, client proofs and step-up tokens it verifies are held to the claim allow-list on every path (D274,
D277). Not merged into `develop`; M3 not run (the API not deployed with it, no sink-scope plan run on sandbox-dev).

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
- **Status** (2026-11-04): merged (`feat/batch-c-7-merge`), not deployed. Independent of C6: the console calls only
  `ConsoleRpc.listApps` and `cancelChangeByLink` (C5). Whichever of C6 and C7 merges second re-runs `apps/console`'s
  tests (they run against the real API Worker, so C6's `ConsoleRpc` too) and merges the shared docs and
  `packages/console-core/src/index.ts`'s export list.

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
- **Status** (2026-11-04): built on `feat/batch-c-8`, not merged, not deployed (D278–D285). Additive changes outside
  `apps/admin`: `AdminRpc.listApps` / `getApp` take the cron's `system` actor (the watcher's SetAllowShared notice),
  `StaffRpc.getOrg` returns the live owner grants. Not in C8, as planned: the R2 bindings, settlement, the daily and
  monthly jobs (C12, C13), the Users screen (C8b), Security & monitoring (C14). The setup is `docs/operations.md` "Admin
  Worker" (setup steps 4, 8, 9, 10).

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
- **Status** (2026-11-04): built on `feat/batch-c-9`, not merged, not deployed (D290–D297). `apps/console-auth`, the code
  flow with PKCE and the implicit-flow guard, handoff codes, sessions, the membership rules through `acceptInvite`,
  `GET /api/me`, the read-only routes and the SPA (`apps/console/web`), the route config (D294). The console's tokens
  are held to the claim allow-list by scope (D290; the sign-in token keeps `openid email`, to confirm). Open question
  1's harness is `scripts/console-code-flow-spike.ts`, not run (D295; Google's `at_hash` on server-flow tokens is the
  expected finding, to decide before C10). Playwright sign-in under the CSP is left for C17 (D297). Setup step 11 is
  `docs/operations.md` "Partner console Worker" → "Setup step 11".

## C10. Partner management

- **Scope**: fresh sign-in (`pending_actions`, step-up flows, every kind), the guarded-change screens (origins with
  IDN flags, the policy editor with the consent preview, raw signing), settings, name, keys, suspend/resume, members
  and invites (D89), on-chain owner actions with the downloadable client-proof helper and the PII warning, owner drift,
  the cancel and cancel-owner pages (POST confirm), `GET /api/governance/pending-upgrades` stays for C14.
- **Tests**: spec "Fresh sign-in"; "Settings, keys"; the role matrix; owner-action rows that need the console.
- **Visible**: the console's write paths; the spec's "Done when" bullets 2–4 on the smoke scope.
- **Status** (2026-11-04): built on `feat/batch-c-10`, merged into `develop` (6220f33), not deployed (D342, D343, D350–D358). Fresh sign-in
  for every kind (`apps/console/src/actions.ts`), the write routes and the role matrix (`writes.ts`), the on-chain view,
  owner drift and the client-proof helper (`scopes.ts`, `near.ts`), C11's logo routes behind the session, the cancel
  pages, the SPA's write screens with the consent preview. The Users screen (D310, D346) is built on top
  of `ConsoleRpc.listUsers` / `getUser` (the wallet directory) with D346's `u1_…` User ID, both merged, behind
  `USERS_SCREEN` (off, D357) until an env's API runs D346. C12's report routes and
  C14's `GET /api/orgs/:org/governance/pending-upgrades` are routed (any member); their SPA screens (usage,
  statements with the downloads, pending upgrades) are built on `feat/console-reports-upgrades`, not merged
  (D370–D374).
  Setup: none new (the console's two new vars come from the manifest through `gen`). The owner-action relay itself
  isn't exercised in the tests (no owner-pool key in the test API); C17's smoke covers it on sandbox-dev.
- **Users screen** (D310 point 5): over `ConsoleRpc.listUsers` / `getUser` (built on `feat/wallet-directory`, D315):
  user id, Support ID, created and last seen, account kinds and wallets, the org's own scopes only, no email or sub.
  Since D346 (`feat/user-id-identity-sub`): `userId` is the identity token's `sub` (`u1_…`, label it "User ID"),
  `supportId` its short form; `getUser({userId})` takes `u1_…`; the cursor is `lastSeenAt:u1_…`; the internal id
  `hu_…` never reaches the console.

## C11. Files Worker and logos

- **Scope**: `apps/files` (only `GET /logos/<app_id>/<64 hex>.png`, §Response headers), logo upload through the
  Images binding, `logo_objects`, the 30-day replaced-logo purge, `logoUrl` in `GET /v1/app`, `FILES_ORIGIN` in the
  auth pages' `img-src`; R2 buckets and rules.
- **Tests**: spec "Settings, keys, logos" logo rows; no `put`/`delete` on `LOGOS` in the files Worker; headers.
- **Setup**: R2 buckets with the `STATEMENTS` lock and `EXPORTS` lifecycle (setup step 7); Images binding on the
  account.
- **Status** (2026-11-04): built on `feat/batch-c-11`, not merged, not deployed (D300–D308). Built: `apps/files`, the
  console's upload backend (`apps/console/src/logo.ts`, `logo-format.ts`) with the CSRF exception for its raw body,
  the purge reordered, `logoUrl` in `GET /v1/app`, the logo on `/login`, `/login/email`, `/approve`, `/export` with
  `FILES_ORIGIN` in both of their CSPs, the `IMAGES` binding in the console's config. Left for C10: the session route
  that checks the owner and calls `logoUploadRoute` (and `logoRemoveRoute`), the upload screen. The setup is in
  `docs/operations.md` "Files Worker and logos". C12 must write its on-demand exports under `exports/` (D308).

## C12. Reports and statements

- **Scope**: Neon `0006_reports.sql` (`org_report`, `org_statements`, `org_ledger`, `rejection_rates`; 0004 and 0005
  were taken by the email work, so C13's retention functions are `0007`, D320); admin crons (settlement every 15 min, the daily nonce check, rate fetch with the
  audited override, `ensure_partitions` as a second keeper beside the API's hourly one (C4), rejection-rate alert); `ConsoleRpc.usage`/`statements`/`ledger`; report screens (console and admin); statement issue
  with CSV, PDF (`pdf-lib`, exact-pinned) and on-screen views, the ledger CSV and exports.
- **Obligation from C4 (review L7, D222):** settlement bills a relayed event only when its transaction is its own:
  `near_tx` unique among the ledger's relayed events, and the transaction read at FINAL signed by `relayer_pk` (one of
  the env's relayer pool keys) with nonce `relayer_nonce`. A duplicate or a mismatch is not billed (`unsettled`,
  listed) and alerts staff: a leaked writer credential could otherwise attach a real transaction to an org it isn't
  for. Test it with a duplicated `near_tx` and a wrong key and nonce.
- **Tests**: spec "Usage ledger" report, settlement, nonce-check, statement, golden-CSV, rejection-rate and D92 rows.
- **Status** (2026-11-04): built on `feat/batch-c-12`, tests green, not merged, not deployed (D320–D329). Built: Neon
  `0006_reports.sql` (the report, ledger and statement functions over one billing rule, `usage.classified`; the
  settlement columns and alert tables; the audited rate override); `ConsoleRpc.usage` / `statements` / `ledger`
  (`apps/api/src/usage/reports.ts`); the admin Worker's settlement with the C4 obligation (a duplicate `near_tx`, a key
  outside the pools, and a signer, key, nonce or receiver mismatch at FINAL are unsettled and alerted, D321), the daily
  nonce check, rejection-rate check, partitions and CoinGecko rate in the 15-minute trigger's 00:30 UTC run (two
  triggers, D329), statement issue with CSV, `pdf-lib` PDF and the on-screen view (D326), exports under `exports/`,
  the rate override, the report, statement and rate screens and the security screen's ledger part in the admin SPA;
  `StaffRpc.recordStaffAction` for their audit rows (D327); the console's report backend (`apps/console/src/reports.ts`).
  **Left for C10**: the partner report screens and the session routes that call the console's report handlers
  (`usageRoute`, `statementsRoute`, `statementViewRoute`, `statementFileRoute`, `ledgerCsvRoute`); C10 routed them, the
  screens are built on `feat/console-reports-upgrades` (D370–D374), not merged. The setup is
  `docs/operations.md` "Reports and statements".

## C13. Retention

- **Scope**: Neon `0007_retention.sql` (`drop_expired_partitions`, `strip_uids`, `purge_app_users`, `erase_uid`; the
  number after C12's 0006, D320),
  `AdminRpc.purgeAudit`/`deletedApps`, `StaffRpc.purgeAudit`, the monthly job with `ops.retention_runs`, its screen
  and the `retention_failed` email, `scripts/uid-erase.ts`.
- **Tests**: spec "Usage ledger" retention rows (D90).
- **Status** (2026-11-04): built on `feat/batch-c-13`, tests green, not merged, not deployed (D360–D369). Built: Neon
  `0007_retention.sql` (the four functions, `usage.erase_uid` by uid alone (D362), `usage.retention_due`,
  `ops.purge_expired`, the runs' status and one-running index, `ops.erasures`, the uid indexes C15 planned); the monthly
  job in the 15-minute trigger from the 1st 01:00 UTC until a run of the month completes, at most 12 of the run's 40
  calls (D360), with `retention_failed` (failed, overdue, skipped; D367) and the read-only Retention screen
  (`GET /api/retention`); `AdminRpc.purgeAudit` / `deletedApps` and, for the wallet directory of scopes left without
  apps, `AdminRpc.purgeDirectory` (D363); `StaffRpc.purgeAudit`; the drift check's rows kept (D364). **The new stores**
  (D269, D310): the erasure is one script, `uid-erase`, per scope across the ledger, the wallet directory and the
  issuer directory, the account read from the chain (D361; it answers D276's open point: `user:erase` lands here); the
  issuer's monthly part is `admin <env> retention:issuer` (its app rows of deleted apps, `email_admin_audit` past 60
  months; D365), since the admin Worker has no issuer binding. The setup is `docs/operations.md` "Retention" (Neon 0007,
  deploy API and console before the admin Worker), at M6. Not in C13: the console housekeeping purges were C7's (they
  stay hourly); a narrow issuer entrypoint for the job (revisit with C8b, D365).

## C14. Security & monitoring and pending upgrades

- The admin "Security & monitoring" view (D83, D126; `docs/governance-spec.md` "Monitoring in the admin portal") and
  the pending-upgrades page in both consoles (D86). The view **must render the incident playbooks from the
  `@hana-id/playbooks` package** (being specified separately: spec §Hana admin console and `docs/operations.md`
  "Watchdog alerts" are owned by that work); this batch consumes the package and its completeness test rather than
  writing playbook text. Sources: the watchdog's status endpoint, `GET /v1/governance`, the security screen's events.
- **Status** (2026-11-04): built on `feat/batch-c-14`, not merged, not deployed (D330–D338; also D344, the feed's
  silent first run, user-confirmed). Built: the admin's `GET /api/monitoring`, `/api/monitoring/alerts`, `/actions`,
  `POST /api/monitoring/alerts/:id/ack`, `GET /api/governance/pending-upgrades`, `GET /api/playbooks[/:id]` and the
  SPA's Security & monitoring, Pending upgrades and Playbooks screens; the watchdog called server-side with the new
  admin secret `WATCHDOG_STATUS_TOKEN` (size caps, 8 s deadline, plain text); `AdminRpc.governance`,
  `AdminRpc.pendingUpgrades`, `ConsoleRpc.pendingUpgrades` over the `GET /v1/governance` snapshot; the release registry
  `CONTRACT_RELEASES` (console-core); manifest `watchdog.url` → `WATCHDOG_URL`; the partner console's
  `pendingUpgradesRoute` (`apps/console/src/governance.ts`) for C10 to route under `GET
  /api/orgs/:org/governance/pending-upgrades` (D335). Not in C14 (D334, to confirm): the portal's own chain and council
  DAO reads. Setup: with the admin Worker at M4, `docs/operations.md` "Admin Worker" → "Security & monitoring" (then
  acknowledge sandbox-dev's alert #11).

## C8b. Users screen (D275, confirmed by the user 2026-11-05; spec §Users and Support ID)

- **Scope**: `DirectoryRpc` (a `WorkerEntrypoint` in `apps/email-issuer`, no route: `search`, `get`, `auditSince`),
  the issuer's own check of the staff Access JWT (`ADMIN_ACCESS_AUD`), the audit row in the same batch as each read,
  the per-staff row budget on the issuer's `RateLimiter`; issuer migration `0003` (`email_admin_audit` rebuilt with
  the new actions and `detail`; ~~`user_email_apps.uid`, nullable, filled from C15~~ dropped by D346, D392); the admin
  Worker's `ISSUER` binding, the `/users` screens and BFF routes, the issuer rows in the audit view, the
  `directory_budget` email. `gen-wrangler` for both Workers.
- **Status** (2026-11-05): built on `feat/batch-c-8b`, tests green, not merged, not deployed (D388–D392). Built:
  `apps/email-issuer/src/directory-rpc.ts` (the three reads, the staff check with `@hana-id/oidc` against the admin
  application, the audit in the read's batch, the keyed hash of an address term), `RateLimiter.takeRows` /
  `returnRows` with `DIRECTORY_ROW_LIMITS` (500 an hour, 2 000 a day, provisional), migration
  `0003_directory_audit.sql`, the issuer vars `ADMIN_ACCESS_TEAM_DOMAIN` / `ADMIN_ACCESS_AUD` / `ADMIN_STAFF_EMAILS`;
  console-core `directory.ts`; the admin's `POST /api/users/search`, `/find`, `/get` (`src/users.ts`), the audit
  view's issuer rows, `directory_budget`, the SPA's Users pages, `ISSUER` in `gen`; `AdminRpc.appNames` on the API
  (D391). The ticket is required to open a user and optional to search (the user's amendment). Not built here:
  `DirectoryRpc.byUid` (dropped by D346); the issuer retention entrypoint D365 suggested revisiting (`retention:issuer`
  stays the CLI's: `DirectoryRpc` stays read-only). Setup: `docs/operations.md` "Users screen (C8b)".
- **Tests**: spec "Users and Support ID" rows except the Support ID ones.
- **Setup / deploy**: apply issuer migration 0002 (if not yet) and 0003 on the env, deploy the issuer (with the
  manifest's `admin` block, so `gen` writes its `ADMIN_*` vars), then the API (`AdminRpc.appNames`), then the admin
  Worker.
- **Visible after**: staff search users and see a user's apps and on-chain path in the admin console; the CLI's
  `user:*` keep working.
- **Already built for it** (D310–D317, `feat/wallet-directory`): `AdminRpc.listUsers` / `getUser` / `findUsers` over
  the API's wallet directory (user ids, Support IDs, identities with subs, wallets); the screen joins each identity's
  `directoryKey` with `DirectoryRpc` for the email.
- **Since C15** (D276 as amended 2026-11-05, D394): nothing fills `user_email_apps.uid` (code → user is the wallet
  directory), so issuer migration 0003 needn't add it, and `DirectoryRpc` needs no `byUid`. The lookup screen is C8b's
  follow-up over C15's `POST /api/support/lookup` (C15 "Screen: after C8b merges").

## C15. Support ID lookup (D96; D276 confirmed and amended 2026-11-05, D394–D397; spec §Users and Support ID)

- **Status** (2026-11-05): built on `feat/batch-c-15`, tests green, not merged, not deployed; the admin screen waits
  for C8b. The design the user confirmed ("yes go ahead with C15") is D276's 2026-11-05 amendment: code → user through
  the wallet directory (`end_users.support_code`, `token_sub`, `user_id`), so `IssuerRpc.uid`, `user_email_apps.uid`
  and `DirectoryRpc.byUid` are dropped; every match listed; no Neon migration (0007's indexes, D362); erasure is
  `uid-erase` (D361); partners get the code only.
- **Built**:
  - console-core `support.ts`: `parseSupportQuery` (a Support ID any way it is typed, a User ID, an internal id),
    `supportLookupInput`, `userSharesInput`, `supportLookupBody` (with the required `ticket`), the answer types, the
    two ledger reads (`SUPPORT_ACTIVITY_SQL`, `SUPPORT_REQUESTS_SQL`) and `withSupportLedger` ("ledger unavailable").
  - API: `AdminRpc.supportLookup({query, days?})` and `AdminRpc.userShares({appId, path})`
    (`apps/api/src/directory/support.ts`, D394); `supportId` in the `/v1/login` and `/v1/sessions` answers
    (`directory/store.ts` `sessionSupportId`, the directory's own derivation; `link-precheck.ts` `autoLinkRoot` for a
    linked login, D395).
  - Vault and SDK: the code kept with the session (its IndexedDB record) across reloads; `hana_status`,
    `hana_login` and `ready` carry it for an SDK of 0.2.0 or later (`hana.supportId`, `supportIdChanged`,
    `useHana().supportId`; the lockstep SDK version moved to 0.2.0, D393); the approval popup's account line; the
    demo's "Copy diagnostics" (`docs/integration.md`).
  - Admin Worker: `POST /api/support/lookup` (`apps/admin/src/support.ts`): the audit row first through
    `StaffRpc.recordStaffAction` (`support.lookup`, org-less, never emailed; D396), then `AdminRpc.supportLookup`, then
    the ledger over `USAGE_DB` (`LedgerStore.support`), degrading to `ledger: {available: false, reason}`.
  - CLI: `admin <env> support:lookup <HANA-XXXX-XXXX | u1_… | hu_… | -> [--request-id …] [--days 30] [--json]
    [--remote]` (`scripts/lib/admin-support.ts`, D397): the same report from the API's D1, the issuer's D1 and the
    ledger as `usage_admin` (`.secrets/<env>/neon-usage-admin.url`).
- **Tests**: `apps/api/test/support-lookup.test.ts` (the answers' `supportId` equals the stored code and the identity
  token sub's short form; a member's and a linked login's root; left out without a key or a confirmed standing; the
  lookup by every query form, collisions, shares, changes, refusals, staff only, no `ConsoleRpc` method),
  `email-login.test.ts` (cases A and B), `apps/admin/test/support.test.ts` (Access, CSRF, POST only, the body rules,
  audit before data, the ledger part and its degradation), `apps/admin/test-ops/support.test.ts` (the two reads as
  `usage_admin` on the real migrations, the uid index), `apps/console/test/staff-actions.test.ts` (the org-less row),
  `packages/console-core/test/support.test.ts`, `scripts/test/admin-support.test.ts`, `scripts/test/uid-erase.test.ts`
  (after an erasure the lookup finds nothing), and the vault's and e2e's (`docs/integration.md`).
- **Setup / deploy**: none of its own. The API part goes live with the next API deploy (no migration); the admin
  route with the admin Worker (M4; its ledger part needs `USAGE_DB`, M2/M6); the CLI's ledger part needs
  `.secrets/<env>/neon-usage-admin.url` (`usage-setup <env> roles`). Until then each says "ledger unavailable".
- **Screen: after C8b merges** (left for it; nothing in C15 builds UI in the admin SPA):
  - The lookup screen calls `POST /api/support/lookup` with `{query, ticket, requestIds?, days?}` (console-core
    `supportLookupBody`) and renders `SupportLookupView` (console-core `support.ts`): the matches (each with `user`,
    `apps`, `shares`, `changes`), `activity[i]` per match (null when `ledger.available` is false: show
    `ledger.reason`), `requests` and `requestsNotFound`, `truncated`. A code the Users search box recognises
    (`parseSupportQuery`) goes here.
  - Emails: for each identity's `directoryKey`, `DirectoryRpc.get({provider, sub})` with the staff JWT and the same
    ticket, recorded by the issuer as `support_lookup` (D275), in the BFF route or a second route; unverified Google
    claims marked as on the Users screen.
  - The Users detail's "Support ID and its activity" links to the lookup by User ID.
- **Not in C15**: a partner lookup (D96, D276 (e): deferred); consents (browser-only, D23); Hana Home's display of the
  code (later, with Hana Home). **Open follow-up:** the SDK's errors (`HanaError`) carry no API request ID, so a
  partner has none to escalate with unless it reads the vault's network calls; carrying `requestId` in the vault's
  errors needs the same SDK-version gate as D393. Until then staff look up by the code, the time and the app, and the
  user's activity by uid.

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
| M6 | C12–C13 | Reports, statements, retention (C12's setup: `docs/operations.md` "Reports and statements": Neon 0006, the admin's buckets and vars, the optional CoinGecko key; C13's: "Retention": Neon 0007, the API and console before the admin Worker) |

## Setup steps (for the user, when each milestone deploys)

Run from the main checkout; every file in `.secrets/` is 0600 in a 0700 directory and never printed.

1. **Neon project** (exists, 2026-10-30): `hana-id`, AWS Sydney (`aws-ap-southeast-2`), Postgres 18, branches
   `production` and `sandbox-dev`; sandbox-dev's owner connection strings are in `.secrets/sandbox-dev/neon.json`.
   Turn on point-in-time restore for the window the plan allows (open question 5).
2. **Ledger schema** (C1 onwards): `corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev` (dry run: lists
   pending files), then the same with `--yes`. Uses `DATABASE_URL_DIRECT` (the owner role over a direct, non-pooled
   connection).
3. **Roles' credentials** (C4): `corepack pnpm --filter @hana-id/scripts usage-setup sandbox-dev roles` (dry run)
   then `--yes`: generates a password per role, writes `.secrets/sandbox-dev/neon-usage-writer.url` and
   `neon-usage-admin.url` (pooled host is not used: Hyperdrive pools), then runs `ALTER ROLE usage_writer|usage_admin
   LOGIN PASSWORD '<SCRAM verifier>'` as the owner (D224).
4. **Hyperdrive** (C4 writer, C8 admin): `usage-setup sandbox-dev hyperdrive --yes` creates
   `hana-id-usage-writer-sandbox-dev` and `hana-id-usage-admin-sandbox-dev` with caching disabled and prints their ids
   (not secret); pass them to `gen` (`--usage-hyperdrive-id`, `--admin-hyperdrive-id` from C8). Confirm Hyperdrive is
   available on the account's plan first (open question 5).
5. **Console D1** (C7, at M4): `corepack pnpm --dir apps/console exec wrangler d1 create <console.d1Name> --location
   apac`, then `corepack pnpm --filter @hana-id/console gen <env> --d1-id <uuid>` and `corepack pnpm --dir apps/console
   exec wrangler d1 migrations apply <console.d1Name> --remote`; the R2 buckets of step 7 must exist before the
   console's first deploy (it binds `LOGOS` and `STATEMENTS`). Needs the manifest blocks of step 12 first. The whole
   sequence is `docs/operations.md` "Partner console Worker".
6. **`USER_ID_KEY`** (C4): `usage-setup sandbox-dev user-id-key --yes` writes 32 random bytes (base64) to
   `.secrets/sandbox-dev/user-id-key` (never replaced) and sets the API's `USER_ID_KEY` through wrangler's stdin; an
   offline backup is made by hand. Also for C4: hot-DB migration 0009 and its one-off `usage` → `session_markers`
   statement after the deploy (`docs/operations.md` "Usage capture" steps 5 and 7).
7. **R2** (C11, C4b): buckets from the `files` block; `STATEMENTS` with a 7-year bucket lock, `EXPORTS` with a 30-day
   lifecycle rule except `legacy/`.
8. **Cloudflare Access** (C8): the admin application on `admin.origin` (Custom Domain on production; Worker-level
   Access on `workers.dev` for sandbox-dev, D75); policy: GitHub team `hana-admins` in `Hana-Technology` plus the
   exact-email Google fallback (open question 4); copy the team domain and AUD tag into the manifest.
9. **Resend** (C8, D87): the sending subdomain with SPF, DKIM and DMARC; an API key for the admin Worker only.
10. **Admin secrets** (C8): `EMAIL_API_KEY` (the Resend key of step 9), `CANCEL_LINK_KEY`, `INVITE_LINK_KEY` (32 random
    bytes each, base64, generated into `.secrets/<env>/`, then `wrangler secret put` from stdin; `docs/operations.md`
    "Admin Worker" step 3). From C14: `WATCHDOG_STATUS_TOKEN` (the watchdog's own, from
    `.secrets/<env>/watchdog-secrets.json`) and the manifest's `watchdog.url` ("Admin Worker" → "Security & monitoring").
11. **Console Google client** (C9): a Web client with no JavaScript origins and one redirect URI,
    `<console.authOrigin>/callback`; its id in `consoleAudiences` (the only `google` entry, D294), its downloaded JSON
    in `.secrets/<env>/console-google-client.json` (0600), `CONSOLE_GOOGLE_CLIENT_SECRET` as a console secret through
    a pipe; then the open-question-1 spike (`console-code-flow-spike <env>`, D295). Steps: `docs/operations.md`
    "Partner console Worker" → "Setup step 11".
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
   for the app; no new store; a short spec section before C15. **Confirmed as D144; the section is written
   (2026-11-04, proposed D276, spec §Users and Support ID):** logins and sessions by uid, errors by request ID (the
   ledger has no uid on failures), live shares from `vault_shares`, and, after D269, the directory reached through
   a `uid` column. **Built in C15 (2026-11-05, D276 as amended, D394–D397)**, through the wallet directory instead of
   a `uid` column (D346).
5. **`ownerGrantDelayMs`**: kept as its own manifest field (the spec's), with `appChangeDelayMs`'s bounds and the
   same production minimum, rather than reusing `appChangeDelayMs`. Recommended as built in C1.
