# Batch C spec: developer dashboard (partner console, Hana admin console, usage and billing)

**Status: being built (2026-11-02: C1–C3 of `docs/batch-c-build-plan.md` merged, not deployed); written 2026-10-29;
decisions confirmed: D28, D29 (as amended by D89), D30 (as
amended by D73), D31, D32, D34, D51, D52, D73, D74, D75, and on 2026-10-29 D87–D93.** Everything else in this file is
a proposal that follows from them; the open questions at the end say what still needs the user (Q1, Q3, Q4's
fallback addresses, Q5; and, added 2026-11-04 for D269, Q26 and Q27: the Users screen and the Support ID, D275 and
D276, to confirm; Q27's derivation answered by D346 on 2026-11-04: the Support ID is the short form of the identity
token's `sub`, which is also the partner's User ID). The 2026-10-27 multi-agent draft (four decision records, a
reconciliation table, passkeys, four roles, two notice channels, a queue, rollups) is superseded by this rewrite; its
history is in git.

This is the source of truth for batch C. If the code and this spec disagree, fix the code or raise it; don't silently
diverge. It amends `docs/batch-a-spec.md`, `docs/batch-a2-shared-client.md` and `docs/batch-b-spec.md` where it says
so. Plan doc: https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi

## Confirmed by the user (2026-10-29)

- **Email (D87).** Resend, from a dedicated sending subdomain with SPF, DKIM and DMARC, behind a small sender
  interface so switching (e.g. to Postmark) is cheap. The fail-closed notices use it.
- **Admin Access (D88).** GitHub team `hana-admins` in `Hana-Technology`, 2FA required org-wide; exact-email Google
  fallback (addresses to come); the admin Worker's own staff allowlist stays as a second check.
- **Invites (D89, amends D29).** Hana creates orgs and invites the first owner; owners then invite viewers and owners
  themselves. Every invite needs a fresh sign-in and notifies every owner and security contact. A new owner is a viewer
  for 24 h, then becomes owner unless cancelled (cancel link). Hana staff add and remove members in the admin portal
  (§Invites and owner grants).
- **Retention (D90).** Statements and settlement records 7 years; raw usage events 24 months, then the uid hash is
  removed and the de-identified rows kept; audit logs 5 years; an automatic monthly purge job shown in the admin
  portal. Periods to be confirmed by the company's accountant before launch (ATO 5-year record keeping, Privacy Act
  APP 11) (§Retention).
- **Rejected-transaction gas (D91).** Not billed by default; its own statement line; an admin alert when a partner's
  rejection rate passes a threshold (provisional 5% of relayed attempts); contract terms may bill partner-caused
  rejections above it.
- **Statements (D92).** CSV, on-screen statement and PDF (`pdf-lib`), all with the same totals and the statement hash;
  tax invoices come from the accounting software and quote the statement.
- **Defaults (D93)**, the spec's recommendations: 24 h production `change_delay_ms`; logos PNG/JPEG/WebP only,
  re-encoded, no SVG; a daily NEAR/USD rate from one source (e.g. CoinGecko) with an audited manual override; seven
  Workers; the console sink scope; the daily nonce cross-check as read; `pg` and `pdf-lib` exact-pinned; the other
  answers listed under §Open questions.
- **Governance (D80–D86, `docs/governance-spec.md`)** adds two admin-console screens built in that batch: "Security &
  monitoring" (D83) and the pending-upgrades page, also in the partner console (D86). "Security & monitoring" also
  renders a recovery playbook for every watchdog alert kind and incident, from `@hana-id/playbooks` (D126).
- **Still open:** Q1 (the code flow's `openid`-only token, to test), Q3 (Hana Cloudflare account, zone, domains), Q4's
  fallback email addresses, Q5 (Neon project setup).
- **Support ID (D96, amended by D269).** The admin portal gets a Support ID lookup: paste a user's `HANA-XXXX-XXXX`
  code to see that user's sessions, logins and errors for the app (the code is the short form of the partner's User
  ID, the identity token's `sub`, D346; the activity via the ledger's uid). Partners see no email or
  Google account for it, anywhere. Staff can go from the code, or from an address, to the user's entry in the email
  issuer's user directory (D269; proposed design: §Users and Support ID, D275, D276). Hana *contacts* only partner
  members, security contacts and billing contacts; end users get only the sign-in codes and link notices their own
  action triggers (D96 as amended). End users' verified addresses are stored only in that directory, for staff.

## Decisions this spec implements

- **Dashboard like Privy's (D28).** Partners manage their org's members, apps, origins, keys, app settings, the
  auto-approve policy and on-chain owner actions. Replaces `admin app:*` after the pilot.
- **Invite-only (D29, amended by D89).** Hana staff create orgs and invite the first owner; owners invite viewers and
  owners to their own org (fresh sign-in, notice to every owner and security contact, a new owner waits 24 h as a
  viewer). Invites are email-bound, single-use, 7-day, stored as sha256. No sign-up path; no accepted invite means 403.
  `public_registration` stays off.
- **MVP cut (D34).** Three main Workers with separate duties and databases, the script-free auth origin, the
  server-side Google code flow, origin safety (change-bound token, 24 h delay, notice, cancel), the on-chain watcher,
  settlement at FINAL, the uid HMAC for MAU and the admin billing reports are kept. Simplified: two roles (owner,
  viewer); one fail-closed notice channel, from the admin Worker to the org's security contacts; direct usage writes
  with a daily nonce cross-check; on-demand reports and frozen monthly statements; compare-and-swap writes;
  publishable keys only, with a fixed 24 h rotation grace; a simpler Hana expedite. Added: the auto-approve policy
  editor, on the same path as origin adds. Deferred: §Deferred.
- **Origins are security-critical (D32), raw signing uses the same delay (D52).** Origin adds, policy sets and changes,
  and `raw_sign = 'approval'` are one mechanism here ("guarded changes"). Removals and turning things off are
  immediate.
- **Test and live apps never share a scope (D51).** Enforced by the `scopes` table.
- **Ledger on Neon Postgres in Sydney through Hyperdrive (D73).** Hot app config and console data stay in D1.
- **Files on R2 (D74).** Partner logos (served from a Hana origin), statements, exports.
- **Three sign-in audiences, no auth service (D75).** Wallet users: batch B. Partners: the console's own Google OIDC
  code flow with PKCE, hashed server sessions, `__Host-` cookies, a fresh sign-in bound to each security-critical
  change. Staff: Cloudflare Access (GitHub team in `Hana-Technology`, org 2FA; exact-email Google rules as fallback),
  verified by the admin Worker on every request.
- **Billing on hold (D31).** No Stripe, plans or invoicing. Sodax is billed under its service contract from the
  monthly statement.
- **No contract change. No user address change** (§Address impact).

## Goal

Partners run their own integration from a web console: members (owner, viewer), apps, allowed origins, publishable
keys, vault settings (persistence, session lengths, raw signing), the auto-approve policy, name and logo, suspend and
resume, own Google client or shared login, and on-chain owner actions. No Hana engineer runs `scripts/admin.ts app:*`.
Hana staff use a separate admin console for invites, orgs, security contacts, suspensions, the audit trail, usage
reports and monthly statements.

Two properties hold throughout:

- **Logins don't depend on the dashboard.** Load on, an outage of, or a bug in the console Worker, the admin Worker,
  `CONSOLE_DB` or Neon can't stop or slow an end-user login: the API reads no console data, and usage writes run after
  the response. A *compromised* console Worker can use only the kill switches: removing origins, removing the policy,
  turning raw signing off, suspending apps, revoking or rotating keys. The API caps those per org and globally
  (§RPC, breaker), records each in `app_changes`, and the admin Worker emails them. Hana can clear any suspension bit.
  Removed origins and policies come back only through the delay, and a revoked key is replaced by a new one (Hana
  restore is deferred). So a console compromise is a bounded DoS, listed in §Security model.
- **No origin, auto-approve policy or raw-signing enable takes effect for an app unless all three happen:**
  1. An on-chain `Owner::Oidc` of the app's scope gives a fresh Google assertion bound to that exact change, verified
     by the API, or a Hana staff member proposes it through `AdminRpc`.
  2. The admin Worker's notice of the change to Hana security and to the org's security contacts is accepted by the
     email provider. Hana staff set the contacts; they live in the hot DB, never in `CONSOLE_DB`.
  3. A delay passes (`appChangeDelayMs`, 24 h in production), during which an owner, Hana staff or anyone holding
     the emailed link can cancel.

  The API starts the clock only after the admin Worker acknowledges the notice, so a compromised console can't
  suppress it. Exceptions to the delay (not to the notice): the `loopback` waiver and the `no_session` waiver
  (§Guarded changes). Users still consent to every new `policyId` (D23).

Done when:

- A Hana admin invites a partner owner. The owner signs in with Google through the console client and sees their
  org. Someone with no accepted invite gets 403 `not_invited`, and no user row is created.
- On sandbox-dev's smoke scope, an origin add stays inactive until the admin notice is accepted and the delay has
  passed. It can be cancelled from the console, from the admin console and from the emailed link (a POST confirm). The
  API refuses the add without a change-bound token from an on-chain `Owner::Oidc` of the scope.
- The same holds for an auto-approve policy set in the console's editor. The vault auto-signs under it only after the
  delay and the user's consent to its `policyId`; removing it stops auto-signing in open tabs within 10 s (D62).
- `propose_change`, `execute_change` and `cancel_change` run through the console on the smoke scope. The relayed
  args are byte-identical to what the user was shown. The admin watcher emails the proposal to the security contacts.
- The API's login tests pass with no console Worker, no admin Worker, no `CONSOLE_DB` and no `USAGE_DB` binding; and
  with `USAGE_DB` failing, logins answer exactly as before.
- The admin console issues a monthly statement for sandbox-dev's org. Its totals equal the ledger CSV for the same
  `as_of`, owner actions included; the CSV in R2 matches the sha256 in Neon; every `near_tx` can be checked at FINAL.
- An SVG logo is refused; a PNG is re-encoded and served from the files origin with the §Response headers.
- All tests pass: `cargo test` (contract unchanged), `pnpm -r test`, `pnpm -r typecheck`.

## Repo layout (additions)

```
apps/api/                    + src/rpc/{console,admin}.ts (WorkerEntrypoints), src/changes/ (guarded changes, CAS,
                               notices, drift), src/usage/ (event, uid, writer), migrations/0006_*.sql, 0007_*.sql,
                               migrations-usage/ (Neon DDL, owned here)
apps/console/                hana-id-console-<env>: partner SPA (React 18.3.1, Vite, React Router, client-only) +
                               /api/* backend-for-frontend, AuthHandler entrypoint, hourly cron, AddClient helper
                               file, migrations/ (CONSOLE_DB, owned here)
apps/console-auth/           hana-id-console-auth-<env>: thin Worker for console.authOrigin (D66 pattern)
apps/files/                  hana-id-files-<env>: thin Worker for files.origin (logos only)
apps/admin/                  hana-id-admin-<env>: staff SPA + /api/*, crons (notices, feed, watcher, settlement,
                               nonce check, rates, retention). No migrations
packages/oidc/               RS256 / JWKS / claims, moved out of apps/api/src/{jwt,jwks}.ts; used by the API, the
                               console and (for the Access JWT) the admin Worker
packages/console-core/       zod schemas and §Types, roles, canonical JSON, nonce layouts (owner action, client proof,
                               step-up, origin change, settings change, cancel link), normaliseOrigin and the loopback
                               rules (moved from scripts/lib/admin-sql.ts), punycode display; vectors from an
                               independent Node script in the gen-fixtures.mjs style
packages/env/                + top-level appChangeDelayMs; console, files, admin, usage, email blocks
scripts/                     gen-wrangler emits every config; admin.ts changes (§CLI); usage-setup.ts (Neon roles,
                               Hyperdrive configs), usage-migrate.ts; uid-erase.ts; deploy-plan's console sink step
```

`legacy/` stays read-only.

## Topology

```
end users ─/v1/*─▶ hana-id-api-<env>  (fetch serves /v1/* only)
                     DB (D1, hot) · USAGE_DB (Hyperdrive → Neon, role usage_writer) · RELAYER_KEY · RATE_LIMITER
                     exports ConsoleRpc, AdminRpc (no route)
                        ▲ ConsoleRpc                          ▲ AdminRpc
partners ─▶ hana-id-console-<env> ─┘                          │
              CONSOLE_DB (D1) · LOGOS, STATEMENTS (R2)        │
              exports StaffRpc, AuthHandler (no route)        │
          ─▶ hana-id-console-auth-<env> ──AuthHandler──▶ console
                        ▲ StaffRpc                            │
staff ─Access─▶ hana-id-admin-<env> ──────────────────────────┘
              USAGE_DB (Hyperdrive → Neon, role usage_admin) · STATEMENTS, EXPORTS (R2) · EMAIL · read-only NEAR RPC
popups, console ─▶ hana-id-files-<env>  LOGOS (R2, read)
```

- **Call directions:** console → API, admin → API, admin → console, console-auth → console; proposed (D275,
  D276): admin → email issuer (`DirectoryRpc`) and email issuer → API (`IssuerRpc`). Nothing calls into the admin
  Worker; the API calls none of the others.
- **Workers.** The three main Workers (API, console, admin) hold the bindings and the trust split D34 keeps. Each
  extra Hana origin gets one thin Worker (D66): `console-auth` forwards `GET /start` and `GET /callback` unchanged to
  the console's `AuthHandler` entrypoint and serves nothing else; `files` serves logos from R2. Neither has a secret,
  a D1 or Neon binding. Production runs seven Workers: these five plus batch B's two page Workers.
- **Origins**, each its own: `console.origin`, `console.authOrigin`, `files.origin`, `admin.origin`, batch B's
  `vaultOrigin` and `authOrigin`, and `apiUrl`. The API refuses all of them as app origins. The console never shares
  an origin with the vault, so a console XSS can't reach key material. D70 (no cookies) covers batch B's origins and
  the API; the console origin and `console.authOrigin` set the `__Host-` cookies below; `files.origin` sets none.
- **Deploy order:** hot-DB migration 0006 (expand-only), Neon migrations, then the API, the console, console-auth,
  files, the admin Worker. RPC changes are additive, so an older console or admin keeps working against a newer API.
- **Static assets.** The console and admin Workers use `assets: {directory, binding: "ASSETS",
  not_found_handling: "single-page-application", run_worker_first: true}`; the Worker runs first on every request,
  dispatches by host (its own origin only, anything else 404), sends `/api/*` to the backend and the rest to
  `env.ASSETS`, and adds the §Response headers to every response. Because it runs first, the admin Worker sees the
  Access header on every request.
- **Admin routes:** production uses a Custom Domain on the Hana zone with a self-hosted Access application;
  `workers_dev: false`, `preview_urls: false`. A dev env with no Hana zone (sandbox-dev today) may run on `workers.dev`
  with Worker-level Access enabled on it and preview URLs disabled (D75).

### Bindings

| Worker | D1 | Hyperdrive | R2 | Services | Vars | Secrets |
|---|---|---|---|---|---|---|
| api | `DB` | `USAGE_DB` (optional; role `usage_writer`) | — | — | existing + `APP_CHANGE_DELAY_MS`, `REFUSED_ORIGINS` (JSON), `NETWORK`, `FILES_ORIGIN` | existing + `USER_ID_KEY` |
| console | `CONSOLE_DB` | — | `LOGOS` (read/write), `STATEMENTS` (read only by code) | `API` → `ConsoleRpc` | `NEAR_RPC`, `SIGNER_ACCOUNT`, origins | `CONSOLE_GOOGLE_CLIENT_SECRET` |
| console-auth | — | — | — | `CONSOLE` → `AuthHandler` | `AUTH_ORIGIN` | — |
| files | — | — | `LOGOS` (read only by code) | — | `FILES_ORIGIN` | — |
| admin | — | `USAGE_DB` (role `usage_admin`) | `STATEMENTS`, `EXPORTS` | `API` → `AdminRpc`, `CONSOLE` → `StaffRpc`, proposed `ISSUER` → `DirectoryRpc` (D275) | `NEAR_RPC`, `SIGNER_ACCOUNT`, `RELAYER_ACCOUNT`, Access ids | `EMAIL_API_KEY` (Resend, D87), `CANCEL_LINK_KEY`, `INVITE_LINK_KEY` |
| email issuer (batch C additions only, proposed) | its own `DB` (unchanged) | — | — | `API` → `IssuerRpc` (D276, C15) | `ADMIN_ACCESS_AUD` (D275) | — |

- **Hyperdrive.** Two configs per env (`hana-id-usage-writer-<env>`, `hana-id-usage-admin-<env>`), each with its own
  Neon role and password. The credentials live in the Hyperdrive config, created by `scripts/usage-setup.ts`, which
  sets each role's password over the owner's direct connection (`.secrets/<env>/neon.json` `DATABASE_URL_DIRECT`) and
  keeps the role URLs in `.secrets/<env>/neon-usage-writer.url` and `neon-usage-admin.url` (0600); a Worker's binding
  carries only the config id (passed to `gen-wrangler` like `--d1-id`, never committed). Query caching is disabled on both (writes, and reports that must be fresh). Driver:
  `pg`, exact-pinned (D93).
- **Only the API's usage writer and the admin Worker bind Neon (D73).** Partner usage views go through `ConsoleRpc`,
  which calls `SECURITY DEFINER` report functions over the writer binding; the writer role has no table privilege.
- `USAGE_DB` is optional in the API's `Env`: when it is absent, capture is a no-op and logins work.

### Crons

- **API, hourly (existing trigger):** JWKS sync, vault maintenance, drift detection, recording activations of guarded
  changes, the owner-pool allowance check.
- **Console, hourly:** invite expiry (`invite.expired` audit rows), recording matured owner grants (§Invites and owner
  grants), short-lived purges (§Retention), logo objects replaced more than 30 days ago.
- **Admin, every 5 min:** blocking notices (`AdminRpc.pendingNotices` → send → `ackNotice`; invites and owner grants:
  `StaffRpc.pendingMemberNotices` → send → `ackMemberNotice`), the security feed
  (`AdminRpc.changesSince`, `StaffRpc.auditSince`, `AdminRpc.securityEvents`), the on-chain watcher.
- **Admin, every 15 min:** gas settlement (and the ledger's alerts and statement notices first; C12, D322).
- **Admin, daily 00:30 UTC:** the nonce cross-check, the NEAR/USD rate (one source, e.g. CoinGecko, named in the
  service contract; audited manual override `PUT /api/rates/:day`; D93), `usage.ensure_partitions`, the rejection-rate
  check (D91). As built (C12, D329), this runs in the 15-minute trigger's 00:30 UTC run, so the admin Worker has two
  cron triggers, and `ensure_partitions(12)` matches the API's hourly keeper (D223).
- **Admin, monthly (the 1st, 01:00 UTC):** the retention purge job (D90, §Retention); its runs show in the admin
  console.

## Data

All D1 times are integer milliseconds UTC; Neon uses `timestamptz`. Ids are a prefix + base58 of 12 random bytes
unless stated. No foreign keys cross databases; `app_id` and `org_id` integrity is enforced in code and tests.

### Hot `DB` (`hana-id-<env>`; API only; migrations in `apps/api/migrations`)

It holds what a login reads. Batch B's 0003 (vault), the lead-time table's 0004 (`issuer_key_observations`) and the
governance batch's 0005 (`issuer_key_sync`) exist, so batch C's migrations are 0006 and 0007 (renumbered 2026-10-30;
the first draft said 0005 and 0006, which collided with the governance batch's 0005).

**Why 0006 rebuilds no table.** 0001 declares `app_origins.app_id` and `usage.app_id`, and 0003 declares
`vault_shares.app_id`, as `REFERENCES apps(id) ON DELETE CASCADE`, and D1 enforces foreign keys. A SQLite rebuild of
`apps` runs an implicit `DELETE FROM apps`, which fires the cascades (`PRAGMA defer_foreign_keys` defers checks, not
actions) and would wipe every origin, legacy usage row and vault share. So 0006 is **expand-only**: `ADD COLUMN` and
new tables with no FK to `apps` (`BEFORE INSERT` triggers check the app exists). `apps.status` and
`apps.publishable_key` stay, kept consistent by triggers; dropping them is deferred (§Deferred).

Migration `0006` (expand):

```sql
CREATE TABLE scopes (
  scope_id TEXT PRIMARY KEY,                  -- contract-assigned
  org_id TEXT NOT NULL,                       -- a scope belongs to exactly one org …
  environment TEXT NOT NULL CHECK (environment IN ('test','live')),  -- … and one environment (D51)
  first_session_at INTEGER,                   -- set once, on the first ok create_session(_and_derive) the API sees
  created_at INTEGER NOT NULL,
  assigned_at INTEGER NOT NULL                -- last org change; staff proposals wait appChangeDelayMs after it
);

ALTER TABLE apps ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_legacy';   -- a trigger keeps it = scopes.org_id
ALTER TABLE apps ADD COLUMN suspended_by INTEGER NOT NULL DEFAULT 0
  CHECK (suspended_by BETWEEN 0 AND 7);                                   -- hana=1, org=2, partner=4
ALTER TABLE apps ADD COLUMN origins_version INTEGER NOT NULL DEFAULT 0;  -- bumped when the set of origin rows changes
ALTER TABLE apps ADD COLUMN settings_version INTEGER NOT NULL DEFAULT 0; -- bumped by every settings write
ALTER TABLE apps ADD COLUMN logo_key TEXT;                               -- R2 key in LOGOS, or NULL
ALTER TABLE apps ADD COLUMN deleted_at INTEGER;                          -- soft delete (AdminRpc.deleteApp)

CREATE TABLE app_keys (                       -- publishable keys only (secret keys: §Deferred)
  id TEXT PRIMARY KEY,                        -- key_…
  app_id TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,                   -- pk_test_|pk_live_ + base58(24 random bytes); public by design
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  revoked_at INTEGER,                         -- may be in the future: rotation grace end (created_at of the new key + 24 h)
  revoked_by TEXT
);

ALTER TABLE app_origins ADD COLUMN active_from INTEGER;  -- NULL = not yet announced (never matches); 0 = migrated
ALTER TABLE app_origins ADD COLUMN change_id TEXT;       -- guarded_changes.id

CREATE TABLE guarded_changes (                -- origin adds, policy sets, raw-signing enables: one lifecycle
  id TEXT PRIMARY KEY,                        -- gc_…
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('origin_add','policy_set','raw_sign_on')),
  origin TEXT,                                -- origin_add: ASCII (punycode) form
  policy_json TEXT, policy_id TEXT,           -- policy_set: canonical JSON (validated) and its policyId (hex)
  status TEXT NOT NULL CHECK (status IN ('pending','active','cancelled','ended')),
                                              -- pending → active (recorded by the cron) | cancelled;
                                              -- active → ended (origin removed, policy removed or replaced, raw off)
  proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('member','hana','system')),
  proposed_by TEXT NOT NULL, proposer_sub TEXT, proposed_at INTEGER NOT NULL, request_country TEXT,
  waiver TEXT CHECK (waiver IN ('loopback','no_session')),
  notified_at INTEGER,                        -- AdminRpc.ackNotice: the admin notice was accepted
  active_from INTEGER,                        -- notified_at + appChangeDelayMs (notified_at under a waiver); NULL before
  cancel_token_hash BLOB UNIQUE,              -- sha256 of the emailed link token (§Nonce layouts)
  activated_recorded_at INTEGER,
  expedited_by TEXT, expedite_reason TEXT,
  ended_at INTEGER, cancelled_by TEXT, cancelled_at INTEGER,
  request_id TEXT NOT NULL,
  CHECK ((kind = 'origin_add') = (origin IS NOT NULL)),
  CHECK ((kind = 'policy_set') = (policy_json IS NOT NULL AND policy_id IS NOT NULL))
);

CREATE TABLE app_changes (                    -- append-only ledger: one row per applied write; the CAS commit point
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, org_id TEXT NOT NULL, app_id TEXT, scope_id TEXT,
  kind TEXT NOT NULL,                         -- app.*|origin.*|policy.*|raw_sign.*|settings.*|key.*|suspension.*|
                                              -- scope.assigned|org.security_contacts|change.*|migration.baseline
  detail_json TEXT NOT NULL,                  -- allowlisted fields only
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','hana','system','link')),
  actor_id TEXT NOT NULL, actor_sub TEXT,     -- the verified step-up sub when there is one
  request_id TEXT NOT NULL UNIQUE
);
-- BEFORE UPDATE on app_changes: RAISE(ABORT). BEFORE DELETE: RAISE(ABORT) unless OLD.at < now − 60 months (D90).

CREATE TABLE security_events (                -- written by the API; the admin Worker emails and marks them
  id TEXT PRIMARY KEY, detected_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('drift','breaker','owner_cap','owner_allowance_low')),
  org_id TEXT, app_id TEXT, scope_id TEXT, detail_json TEXT NOT NULL, notified_at INTEGER
);

CREATE TABLE org_security_contacts (          -- set only through AdminRpc (Hana staff); never by ConsoleRpc
  org_id TEXT NOT NULL, email TEXT NOT NULL,  -- lowercased
  added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, email)
);

CREATE INDEX apps_org_id ON apps (org_id);
CREATE INDEX app_keys_app_id ON app_keys (app_id);
CREATE INDEX guarded_changes_app ON guarded_changes (app_id, status);
CREATE INDEX guarded_changes_unnotified ON guarded_changes (status, notified_at);
CREATE INDEX guarded_changes_due ON guarded_changes (status, active_from);
CREATE INDEX app_changes_org_seq ON app_changes (org_id, seq);
CREATE INDEX security_events_unnotified ON security_events (notified_at);

-- Triggers:
--   apps BEFORE INSERT / BEFORE UPDATE OF org_id, scope_id: abort unless a scopes row with the same org_id exists.
--   scopes AFTER UPDATE OF org_id: UPDATE apps SET org_id = NEW.org_id WHERE scope_id = NEW.scope_id.
--   apps AFTER UPDATE OF suspended_by: SET status = CASE WHEN NEW.suspended_by = 0 THEN 'active' ELSE 'suspended' END.
--   app_keys BEFORE INSERT: abort unless the app exists and the key's prefix matches its scope's environment.
--   app_origins, guarded_changes BEFORE INSERT: abort unless the app exists.
```

Backfill in `0006`, in order:

1. `INSERT INTO scopes` one row per distinct `(apps.scope_id, environment)`, the environment from the key prefix.
   `org_id = 'org_legacy'`; `first_session_at`, `created_at` and `assigned_at` = the migration time, so no existing
   scope gets a waiver. A scope with both prefixes produces a duplicate PK and the migration aborts (batch B's
   `scope_conflict` already refuses that mix).
2. `UPDATE apps SET suspended_by = 1 WHERE status = 'suspended'`.
3. `INSERT INTO app_keys` one row per app (`id = 'key_legacy_' || apps.id`, `key = apps.publishable_key`).
4. `UPDATE app_origins SET active_from = 0`.
5. One `app_changes` row per app, `kind = 'migration.baseline'`, listing its origins, the `policyId` of
   `auto_approve_policy`/`auto_approve_pending` and `raw_sign`/`raw_sign_pending`, so drift detection can explain them.

`0007` drops the legacy `usage` table once `scripts/usage-legacy-export.ts` has written it once to `EXPORTS` as CSV
(row counts verified). Batch C stops writing it (§Usage).

**Order (README):** apply 0006 → deploy the API (it writes `suspended_by` and reads both) → deploy the rest → export
legacy usage → apply 0007. A migration test on a sandbox-dev snapshot asserts unchanged app, origin, key, share and
usage row counts. After 0006 only the new CLI runs (§CLI); the old `app:origins:add` would insert rows with
`active_from` NULL, which never match.

**Invariants (in the RPC and tested):** test and live apps never share a scope (D51); a key's prefix matches its
scope's environment; at most 5 unrevoked keys per app; at most 20 active-or-pending origins per app (the vault
page's `MAX_APP_ORIGINS`; this closes `docs/security.md` (i)); only a Hana-kind caller clears bits 1 or 2 of
`suspended_by`.

**Login-path reads (the only hot-path change).** Still two queries, no new round trip:

```sql
SELECT a.id, a.name, a.scope_id, a.org_id, a.plan, a.suspended_by, a.status, a.logo_key, k.key AS publishable_key,
       s.environment, s.first_session_at, p.per_minute, p.per_day, p.per_ip_minute
  FROM app_keys k JOIN apps a ON a.id = k.app_id JOIN scopes s ON s.scope_id = a.scope_id JOIN plans p ON p.id = a.plan
 WHERE k.key = ?1 AND (k.revoked_at IS NULL OR k.revoked_at > ?2) AND a.deleted_at IS NULL;
SELECT origin FROM app_origins WHERE app_id = ?1 AND active_from <= ?2;   -- NULL never matches
```

- `appGate` step 2 becomes `suspended_by != 0 OR status != 'active'` → 403 `app_suspended`; the `scope_conflict`
  subquery is replaced by `scopes.environment` (one environment per scope).
- A revoked key gives 401 `unknown_app`, the same as an unknown key.
- Loopback origins count only when `environment = 'test'` in a dev env (replaces the `pk_test_` prefix test).
- The preflight query (`preflightAllows`, `apps/api/src/origins.ts`) gets the same filters: `suspended_by = 0`,
  `deleted_at IS NULL`, `active_from <= now`, and `s.environment = 'test'` for loopback.
- The vault page (frame-ancestors, inlined config) and the share checks use `getAppByKey`, so they follow the same
  predicate. Any future app-config cache stores `active_from` and filters at check time, TTL ≤ 10 s.
- `first_session_at`: when the gate row has it NULL and `/v1/sessions` or `/v1/login` succeeds, `waitUntil` runs
  `UPDATE scopes SET first_session_at = ?now WHERE scope_id = ? AND first_session_at IS NULL`. A failure is retried by
  the next login.
- `GET /v1/app` gains `logoUrl` (`<FILES_ORIGIN>/<logo_key>` or null). Batch B's auth pages show it beside the app
  name and add `FILES_ORIGIN` to their `img-src`.

### `CONSOLE_DB` (`hana-id-console-<env>`; console Worker only; migrations in `apps/console/migrations`)

```sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,                        -- org_…; 'org_legacy' is created by the first migration
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'partner' CHECK (kind IN ('partner','internal')),  -- §Deferred: passkey gate
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),  -- frozen: console writes refused
  required_hd TEXT,                           -- optional Workspace domain; the login token's hd must equal it
  created_at INTEGER NOT NULL,
  contract_ref TEXT, billing_email TEXT       -- nullable; statements go to billing_email too
);
CREATE TABLE console_users (
  id TEXT PRIMARY KEY,                        -- usr_…
  provider TEXT NOT NULL, sub TEXT NOT NULL,  -- sub in clear: it must equal the on-chain Owner::Oidc
  email TEXT NOT NULL,                        -- lowercased; display only, never identity
  created_at INTEGER NOT NULL, last_sign_in_at INTEGER, disabled_at INTEGER,
  UNIQUE (provider, sub)
);
CREATE TABLE members (
  org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  role_since INTEGER NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);                                            -- every org with members keeps at least one owner
CREATE TABLE invites (
  id TEXT PRIMARY KEY,                        -- inv_…
  token_hash BLOB UNIQUE,                     -- sha256(T), §Nonce layouts; NULL until the admin notice is accepted
  email_norm TEXT NOT NULL,                   -- lowercased; no dot/plus normalisation
  org_id TEXT, new_org_name TEXT,             -- exactly one; new_org_name creates the org on acceptance (staff only)
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('member','hana')),
  created_by TEXT NOT NULL,                   -- user id (with step_up_id) or staff Access sub
  step_up_id TEXT,                            -- member invites: the pending action that authorised it
  notified_at INTEGER,                        -- the admin notice (invitee, owners, contacts) was accepted
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,   -- + 7 d
  accepted_at INTEGER, accepted_user_id TEXT, accepted_by_sub TEXT,
  revoked_at INTEGER, expired_logged_at INTEGER,
  CHECK ((org_id IS NULL) <> (new_org_name IS NULL)),
  CHECK ((created_by_kind = 'member') = (step_up_id IS NOT NULL)),
  CHECK (created_by_kind = 'hana' OR new_org_name IS NULL)
);
CREATE TABLE owner_grants (                   -- D89: a new owner of an org that has one is a viewer until owner_from
  id TEXT PRIMARY KEY,                        -- og_…
  org_id TEXT NOT NULL,
  user_id TEXT,                               -- NULL until the owner invite is accepted
  invite_id TEXT,                             -- an owner invite; NULL for a promotion of a viewer
  granted_by_kind TEXT NOT NULL CHECK (granted_by_kind IN ('member','hana')),
  granted_by TEXT NOT NULL, step_up_id TEXT, created_at INTEGER NOT NULL,
  notified_at INTEGER,                        -- the blocking notice was accepted
  owner_from INTEGER,                         -- acceptance (invite) or notified_at (promotion) + ownerGrantDelayMs
  cancel_token_hash BLOB UNIQUE,              -- sha256 of the emailed cancel token
  cancelled_at INTEGER, cancelled_by TEXT,
  applied_at INTEGER,                         -- the console cron set members.role = 'owner'
  CHECK (invite_id IS NOT NULL OR user_id IS NOT NULL)   -- a promotion names its user from the start
);
CREATE TABLE auth_flows (
  state_hash BLOB PRIMARY KEY,                -- sha256(state); state is 32 random bytes
  start_hash BLOB NOT NULL UNIQUE,            -- sha256(f), the handle in <authOrigin>/start?f=
  purpose TEXT NOT NULL CHECK (purpose IN ('login','step_up')),
  pre_cookie_hash BLOB,                       -- login: __Host-hana_pre on the console origin
  af_cookie_hash BLOB,                        -- __Host-hana_af on the auth origin, set by /start
  pkce_verifier TEXT NOT NULL,                -- server-side; S256 challenge sent to Google
  nonce TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('openid email','openid')),
  invite_id TEXT, pending_action_id TEXT, login_hint TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,   -- + 5 min
  started_at INTEGER, used_at INTEGER,
  CHECK ((purpose = 'login') = (pre_cookie_hash IS NOT NULL)),
  CHECK ((purpose = 'step_up') = (pending_action_id IS NOT NULL AND scope = 'openid'))
);
CREATE TABLE handoff_codes (
  code_hash BLOB PRIMARY KEY, state_hash BLOB NOT NULL,
  result_json TEXT NOT NULL,                  -- allowlisted: user id, invite outcome; never a token
  expires_at INTEGER NOT NULL, used_at INTEGER                -- + 60 s
);
CREATE TABLE console_sessions (
  id_hash BLOB PRIMARY KEY,                   -- sha256 of the 32-byte cookie value
  user_id TEXT NOT NULL, hd TEXT,
  auth_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,    -- written at most every 5 min
  absolute_expires_at INTEGER NOT NULL,       -- auth_at + 12 h
  revoked_at INTEGER,
  country TEXT, asn INTEGER, ip_prefix TEXT   -- /24 or /48; staff-only forensics, 90 days (D93)
);
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,                        -- act_…
  user_id TEXT NOT NULL, session_hash BLOB NOT NULL, org_id TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- §Fresh sign-in
  action_json TEXT NOT NULL,                  -- canonical JSON; the server applies exactly this
  digest BLOB NOT NULL, google_nonce TEXT NOT NULL,
  scope_id TEXT, near_action_nonce INTEGER, near_args BLOB,   -- owner actions only
  used_at INTEGER, outcome TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,   -- + 5 min
  request_id TEXT NOT NULL
);
CREATE TABLE logo_objects (                   -- every LOGOS object the console wrote, for the 30-day purge
  key TEXT PRIMARY KEY, app_id TEXT NOT NULL, created_at INTEGER NOT NULL, replaced_at INTEGER
);
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','hana','system','link')),
  actor_id TEXT NOT NULL, actor_email TEXT, actor_sub TEXT,
  org_id TEXT, app_id TEXT, action TEXT NOT NULL, target TEXT,
  details_json TEXT NOT NULL,                 -- allowlisted: no tokens, secrets, cookies or full IPs
  step_up_id TEXT, request_id TEXT NOT NULL, near_tx TEXT,
  ip_prefix TEXT, country TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','failed'))
);
CREATE INDEX audit_log_org_seq ON audit_log (org_id, seq);
-- BEFORE UPDATE: RAISE(ABORT). BEFORE DELETE: RAISE(ABORT) unless OLD.at < now − 60 months (D90).
```

No staff table and no org-to-app table: `apps.org_id` (through `scopes.org_id`) in the hot DB is the only source of
which app belongs to which org. The console sends no email (one channel: §Email).

The migration (`apps/console/migrations/0001_init.sql`) also writes the constraints these comments imply, so a bug
can't store them: 32-byte hashes, JSON-valid JSON columns, lowercased emails, `token_hash` set exactly with
`notified_at`, an invite's acceptance columns set together, one grant per invite, `owner_from` only with a user,
never both cancelled and applied, a login flow's `scope = 'openid email'`, invites only on login flows, `used_at` only
after `started_at`, `pending_actions.kind` from the step-up list and owner-action fields exactly on owner actions.

### Usage ledger (Neon Postgres, `aws-ap-southeast-2`; migrations in `apps/api/migrations-usage`)

Postgres 18, point-in-time restore on. The project exists (2026-10-30): `hana-id` in AWS Sydney, branches `production`
and `sandbox-dev`; whether production moves to a project of its own stays open question 5. Migrations run from
`scripts/usage-migrate.ts` with the owner role over a direct connection, never from a Worker. Least privilege is by
role, not convention: the API's writer role can only call functions; nothing but the owner role can update or delete
ledger rows, and retention runs through owner-defined functions.

```sql
CREATE SCHEMA usage;                          -- the ledger and billing tables
CREATE SCHEMA ops;                            -- admin Worker state: cursors, watcher snapshots, nonce checks
REVOKE ALL ON SCHEMA usage, ops FROM PUBLIC;

CREATE TABLE usage.events (                   -- the ledger; insert-only
  request_id     text        NOT NULL,        -- the API's requestId: the idempotency key
  at             timestamptz NOT NULL,        -- request start; sets the UTC day and the partition
  received_at    timestamptz NOT NULL DEFAULT now(),
  org_id         text        NOT NULL,        -- the scope's org when the event was produced (from the gate row)
  app_id         text,                        -- NULL only for owner actions
  scope_id       text        NOT NULL,
  endpoint       text        NOT NULL CHECK (endpoint IN ('login','session','derive','revoke','unlock','owner_action')),
  outcome        text        NOT NULL CHECK (outcome IN ('ok','rejected','error')),
  code           text,
  status         smallint    NOT NULL,
  latency_ms     integer     NOT NULL CHECK (latency_ms >= 0),
  relayed        boolean     NOT NULL,        -- a transaction that can execute was sent (gas may be burnt)
  near_tx        text,
  relayer_pk     text,                        -- 'ed25519:…' of the pool key that signed it
  relayer_nonce  bigint,
  relay_gas_burnt    bigint,                  -- provisional (EXECUTED_OPTIMISTIC); never billed
  relay_tokens_burnt numeric(39,0),
  uid            bytea CHECK (uid IS NULL OR octet_length(uid) = 16),
  PRIMARY KEY (request_id, at),
  CHECK (NOT relayed OR (near_tx IS NOT NULL AND relayer_pk IS NOT NULL AND relayer_nonce IS NOT NULL)),
  CHECK ((endpoint = 'owner_action') = (app_id IS NULL)),
  CHECK (uid IS NULL OR (outcome = 'ok' AND endpoint IN ('login','session','derive')))
) PARTITION BY RANGE (at);                    -- one partition per UTC month: usage.events_2026_11 …
CREATE INDEX ON usage.events (org_id, at);
CREATE INDEX ON usage.events (app_id, at);
CREATE INDEX ON usage.events (scope_id, at) WHERE endpoint = 'owner_action';
CREATE INDEX ON usage.events (at) WHERE relayed;                          -- settlement queue
CREATE INDEX ON usage.events (relayer_pk, relayer_nonce) WHERE relayed;  -- nonce cross-check

CREATE TABLE usage.app_users (                -- first and last day per pseudonymous user: new-user counts
  app_id text NOT NULL, uid bytea NOT NULL CHECK (octet_length(uid) = 16),
  first_seen date NOT NULL, last_seen date NOT NULL,
  PRIMARY KEY (app_id, uid)
);
CREATE INDEX ON usage.app_users (app_id, first_seen);

CREATE TABLE usage.gas_settlements (          -- admin: billed gas of every relayed event, from tx at FINAL
  request_id text PRIMARY KEY, at timestamptz NOT NULL, near_tx text NOT NULL,
  result text NOT NULL CHECK (result IN ('final','unsettled')),
  gas_burnt bigint, tokens_burnt numeric(39,0),         -- BigInt sums over the tx and every receipt
  settled_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((result = 'final') = (gas_burnt IS NOT NULL AND tokens_burnt IS NOT NULL))
);
CREATE INDEX ON usage.gas_settlements (at);

CREATE TABLE usage.near_usd_rates (
  day date PRIMARY KEY, usd_micros bigint NOT NULL CHECK (usd_micros > 0),
  source text NOT NULL, entered_by text,      -- entered_by NULL = fetched
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage.statements (               -- frozen once per org and month
  org_id text NOT NULL, month date NOT NULL CHECK (date_trunc('month', month)::date = month),
  as_of timestamptz NOT NULL,                 -- the statement covers events with received_at <= as_of
  csv_key text NOT NULL, csv_sha256 bytea NOT NULL CHECK (octet_length(csv_sha256) = 32),
  pdf_key text, pdf_sha256 bytea,
  totals jsonb NOT NULL,                      -- the total rows, for the report screens
  issued_by text NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month)
);
-- Triggers (defence behind the grants): statements BEFORE UPDATE OR DELETE → RAISE.
-- near_usd_rates BEFORE UPDATE OR DELETE → RAISE when a statement exists for date_trunc('month', OLD.day).

CREATE TABLE ops.state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ops.scope_snapshot (scope_id text PRIMARY KEY, owners jsonb NOT NULL, clients jsonb NOT NULL,
  allow_shared boolean NOT NULL, seen_at timestamptz NOT NULL);
CREATE TABLE ops.scope_watch (scope_id text NOT NULL, change_id bigint NOT NULL, first_seen_at timestamptz NOT NULL,
  notified_at timestamptz, PRIMARY KEY (scope_id, change_id));
CREATE TABLE ops.nonce_checks (relayer_pk text NOT NULL, checked_at timestamptz NOT NULL, chain_nonce bigint NOT NULL,
  explained boolean NOT NULL, ledger_relayed_since_last bigint NOT NULL, alerted_at timestamptz,
  PRIMARY KEY (relayer_pk, checked_at));
CREATE TABLE ops.retention_runs (id bigserial PRIMARY KEY, started_at timestamptz NOT NULL, finished_at timestamptz,
  rows jsonb NOT NULL DEFAULT '{}', error text);                                   -- D90, shown in the admin console
CREATE TABLE ops.rejection_alerts (org_id text NOT NULL, day date NOT NULL, relayed bigint NOT NULL,
  rejected bigint NOT NULL, alerted_at timestamptz, PRIMARY KEY (org_id, day));    -- D91
```

Functions (owner-defined, `SECURITY DEFINER`, `SET search_path = usage, pg_temp`):

| Function | What | Caller |
|---|---|---|
| `usage.record_event(e jsonb)` | Validates the shape, `INSERT … ON CONFLICT (request_id, at) DO NOTHING`, and for an event with a uid upserts `app_users` (`first_seen = LEAST`, `last_seen = GREATEST`), in one transaction | `usage_writer` |
| `usage.org_report(org text, from_day date, to_day date, by text, app_ids text[])` | The report rows below, for one org; ranges ≤ 400 days, ≤ 100 apps | `usage_writer`, `usage_admin` |
| `usage.org_statements(org text)` | Statement metadata (month, `as_of`, keys, hashes, totals) | `usage_writer`, `usage_admin` |
| `usage.org_ledger(org text, month date, as_of timestamptz, after text, lim int)` | Ledger rows for the ledger CSV, keyset-paged by `request_id` | `usage_writer`, `usage_admin` |
| `usage.ensure_partitions(months_ahead int)` | Creates missing monthly partitions up to N months ahead (3 by default) | `usage_admin` |
| `usage.drop_expired_partitions()` | Detaches and drops partitions whose upper bound is more than 7 years ago, and `gas_settlements` rows of those months (D90) | `usage_admin` |
| `usage.strip_uids()` | Sets `uid = NULL` on events of every month that ended more than 24 months ago (per partition, batches of 10 000), and deletes `app_users` rows whose `last_seen` is more than 24 months ago (D90) | `usage_admin` |
| `usage.purge_app_users(app text)` | Deletes an app's `app_users` rows (app deleted + 30 days) | `usage_admin` |
| `usage.rejection_rates(day date)` | Per org: relayed attempts and relayed-then-rejected ones for the day (D91) | `usage_admin` |
| `usage.erase_uid(app_ids text[], uid bytea)` | `uid:erase`: deletes the user's `app_users` rows and NULLs the uid on their events | `usage_admin` (from the script) |

As built in C12 (`0006_reports.sql`, D320): the report, statement and ledger functions above, plus `usage.classified`
(internal: the one rule for what is billed), `usage.statement_blockers` and `usage.override_rate` (the audited
override; the admin role's direct `UPDATE` on `near_usd_rates` is removed), all `usage_admin`; the retention functions
come with C13 as `0007`.

Roles:

```sql
CREATE ROLE usage_writer NOLOGIN; -- API's Hyperdrive config; usage-setup gives it LOGIN and a password
CREATE ROLE usage_admin  NOLOGIN; -- admin Worker's Hyperdrive config, and scripts/uid-erase.ts; likewise
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA usage FROM PUBLIC;   -- Postgres grants EXECUTE to PUBLIC by default
GRANT USAGE ON SCHEMA usage TO usage_writer, usage_admin;
GRANT EXECUTE ON FUNCTION usage.record_event, usage.org_report, usage.org_statements, usage.org_ledger TO usage_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA usage TO usage_admin;
GRANT INSERT ON usage.gas_settlements, usage.near_usd_rates, usage.statements TO usage_admin;
GRANT UPDATE (usd_micros, source, entered_by, fetched_at) ON usage.near_usd_rates TO usage_admin;
GRANT EXECUTE ON FUNCTION usage.org_report, usage.org_statements, usage.org_ledger, usage.ensure_partitions,
  usage.drop_expired_partitions, usage.strip_uids, usage.purge_app_users, usage.erase_uid, usage.rejection_rates
  TO usage_admin;
GRANT USAGE ON SCHEMA ops TO usage_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO usage_admin;   -- the owner creates every ops table
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ops TO usage_admin;
ALTER ROLE usage_writer SET statement_timeout = '5s';
ALTER ROLE usage_admin  SET statement_timeout = '60s';
```

- The migrations hold no credential (D141). Roles are created `NOLOGIN` (idempotently), so the DDL runs the same on Neon, a
  container and PGlite; `usage-setup` sets `LOGIN` and a generated password per role. Without the `REVOKE … FROM
  PUBLIC`, every role could call `record_event` and the retention functions; a test checks each role's function list.
  The admin role gets table privileges on `ops` rather than `CREATE` on the schema: it never needs to create objects.
- Partitions: the first migration creates the current and next 3 months; the admin's daily cron calls
  `ensure_partitions(3)`. There is no default partition, so an event outside every partition fails loudly
  (`usage_write_failed`), and the admin console alerts when fewer than 2 future partitions exist.
- `org_id` is denormalised into every event, so partner reports never touch the hot DB. When `assignScopeOrg` moves a
  legacy scope, its earlier events keep `org_legacy` (only legacy scopes move; statements are per `org_id` at the
  time).
- No rollup, materialised view or close: reports run on demand over the month partitions. A materialised view comes
  only if a report query passes 2 s at real volume (measured in the smoke).

### R2 (D74; bucket names from the manifest, one set per env)

| Bucket | Holds | Writer | Readers | Rules |
|---|---|---|---|---|
| `LOGOS` | `logos/<app_id>/<sha256 hex>.png`, re-encoded | console | files Worker | Content-addressed, never overwritten; replaced objects deleted after 30 days |
| `STATEMENTS` | `statements/<org_id>/<YYYY-MM>/<as_of>.{csv,pdf}` | admin | admin, console (`get` only) | A bucket lock rule (retention 7 years, D90) blocks overwrite and delete; the sha256s are in Neon |
| `EXPORTS` | on-demand ledger CSVs, the one legacy-usage export | admin | admin | Lifecycle: delete after 30 days, except `legacy/` |

R2 bindings can't be read-only, so "read only by code" is a code rule with a test (no `put`/`delete` call on that
binding in that Worker); the bucket lock and the Neon hash are what make a statement tamper-evident.

## Nonce and digest layouts

`‖` is concatenation. A domain string is its raw UTF-8 bytes with no length prefix, as in the contract.
`borsh(String)` is a u32 LE length then the UTF-8 bytes; `borsh(Vec<String>)` a u32 LE count then the elements.
`b64url` has no padding. JCS is RFC 8785 canonical JSON.

| Purpose | Value | Checked by |
|---|---|---|
| Console login | `b64url(sha256("hana-console/login/v1" ‖ random32))`, stored in `auth_flows` | console |
| Generic step-up | `d = sha256("hana-console/step-up/v1" ‖ sha256(session cookie) ‖ sha256(JCS(action)))`; nonce `b64url(d)` | console |
| Origin change (adds, with any removes sent with them) | `d = sha256("hana-id/origin-change/v1" ‖ borsh(signer) ‖ borsh(app_id) ‖ borsh(sorted add) ‖ borsh(sorted remove) ‖ origins_version u64 LE)`; nonce `b64url(d)` | console **and API** |
| Settings change (`policy_set`, `raw_sign_on`) | `d = sha256("hana-id/settings-change/v1" ‖ borsh(signer) ‖ borsh(app_id) ‖ borsh(kind) ‖ value(32) ‖ settings_version u64 LE)`; `value` = the 32 `policyId` bytes for `policy_set`, 32 zero bytes for `raw_sign_on`; nonce `b64url(d)` | console **and API** |
| Owner action | the contract layout: `"hana-id/owner-action/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(method) ‖ borsh(args without auth) ‖ action_nonce u64 LE` | console, API precheck, contract |
| Client proof | the contract layout: `"hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE` | console, API precheck, contract |
| Cancel link token | `T = HMAC-SHA256(CANCEL_LINK_KEY, "hana-id/cancel-link/v1" ‖ borsh(change_id))`; the hot DB stores `sha256(T)` | API |
| Invite token | `T = HMAC-SHA256(INVITE_LINK_KEY, "hana-console/invite/v1" ‖ borsh(invite_id))`; `CONSOLE_DB` stores `sha256(T)` | console |
| Owner-grant cancel token | `T = HMAC-SHA256(CANCEL_LINK_KEY, "hana-console/owner-grant-cancel/v1" ‖ borsh(grant_id))`; `CONSOLE_DB` stores `sha256(T)` | console |
| uid | `HMAC-SHA256(USER_ID_KEY, "hana-id/uid/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))[0..16]` | API |

- Generic action objects contain `v: 1`, `env` (the manifest `name`) and `org_id`; the origin, settings and on-chain
  layouts commit to the signer account, which is per env. No digest replays across envs or orgs.
- Origins are sorted by byte order after `normaliseOrigin` (ASCII form).
- `d` is deterministic, so the API recomputes the Google nonce from the request. The cancel token is deterministic
  per change, so a notice re-sent after a failed ack carries the same working link.
- The prefixes keep login, step-up, origin, settings and owner-action tokens apart. An on-chain owner token is public;
  it can never satisfy a login, whose nonce is random and server-held.
- `packages/console-core` implements every layout, tested against `test_fixture.json`, the worked examples in
  `docs/contract-interface.md` and fixed vectors from an independent Node script.

## Partner sign-in (console Worker, D75)

### Google client setup

- The console OAuth client (`consoleAudiences`) has **no authorized JavaScript origins**, so GIS, One Tap and FedCM
  can't mint tokens for it. Its only redirect URI is `<console.authOrigin>/callback`.
- The auth origin serves no script and no assets. Every response carries `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; form-action
  'none'; base-uri 'none'`.
- **Why a separate origin.** A console-client token with a chosen nonce authorises owner actions and origin and
  settings changes. Without the separate origin, XSS on the console origin could start an implicit flow for the
  redirect URI and read the fragment.
- **Implicit-flow guard.** Google also accepts `response_type=id_token` for a registered redirect URI, so the callback
  never forwards a fragment: it answers 3xx only for a request with a valid `state` and `code`, and every success
  `Location` ends with an empty fragment (`#`).

### Code flow

1. **Create.** The SPA calls `POST /api/auth/start {purpose: "login", invite?}` (the invite token comes from
   `…/invite#t=<b64url>`, a fragment). The server stores an `auth_flows` row (random `state`, start handle `f`, PKCE
   S256 verifier, the login nonce, `scope = 'openid email'`, `invite_id` if the hash matches a live invite), sets
   `__Host-hana_pre` (32 random bytes; `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`; Lax because Strict
   cookies are withheld across the Google redirects) and returns `{startUrl: "<authOrigin>/start?f=…"}`.
2. **Start.** `GET <authOrigin>/start?f=`: the flow must exist, be unexpired and unstarted (marked `started_at` in
   the same statement). Sets `__Host-hana_af` on the auth origin (same attributes), stores its hash, and 303s to
   Google with `response_type=code`, the flow's `scope`, `prompt=select_account`, `state`, `nonce`,
   `code_challenge`, `code_challenge_method=S256` and `login_hint` (the invite email, or the session sub for a
   step-up). Anything else: the static 400 page.
3. **Callback.** `GET <authOrigin>/callback`.
   - Refused (static 400 page, `no-store`, no `Location`, a plain link to `<console.origin>/signin#`) unless the query
     has `code` and `state`, `sha256(state)` matches a started, unused, unexpired flow, and
     `sha256(__Host-hana_af)` equals its hash. A Google `error=` gets the same page.
   - Marks the flow used in the lookup statement; exchanges the code with `CONSOLE_GOOGLE_CLIENT_SECRET` and the
     verifier; verifies the ID token with `packages/oidc`: RS256 against Google's JWKS, `iss`, `aud` in
     `consoleAudiences`, `nonce`, `exp`, `iat` ≤ 120 s old.
   - Email claims by scope: `openid email` (login) needs `email` and `email_verified === true`; `openid` (every
     step-up) must carry no `email` (open question 1). As built (C9, D290): `openid` exactly the claim allow-list
     (D271; with `at_hash` since D342, which must match the exchange's access token); `openid email` the allow-list
     plus only `email`, `email_verified` and `hd`.
   - **Login:** writes a `handoff_codes` row (60 s) and 303s to `<console.origin>/api/auth/complete?h=…#`.
   - **Step-up:** §Fresh sign-in.
   - The ID token never reaches page JavaScript and is never stored.
4. **Complete.** `GET /api/auth/complete?h=`: the handoff code must be unused, < 60 s old, and its flow's
   `pre_cookie_hash` must equal `sha256(__Host-hana_pre)`. The membership rules below run; on success a
   `console_sessions` row is created, `__Host-hana_cs` set, the pre-flow cookie cleared, and the user sent to `/`.

`verifyIdToken` and `VerifiedToken` gain `email`, `email_verified`, `iat`, `hd`, `azp`, `amr` and `auth_time`;
existing API callers ignore them.

### Membership rules at sign-in

- A user found by `(provider, sub)` with `disabled_at` set gets 403 `user_disabled` (audited); no invite is consumed.
- An invite bound to the flow is always processed, even for an existing member (that is how a member of org A joins
  org B). Already a member of the invite's org: 409 `already_member`, invite left unconsumed.
- No invite: an existing user with at least one usable membership signs in. Memberships in orgs whose `required_hd`
  differs from the token's `hd` are ignored. No usable membership: 403 `not_invited`, audited with the email's sha256
  only, no user row created.
- **Acceptance** is one D1 batch; every id is resolved from `(provider, sub)` inside it, so an existing user row is
  reused, and `?nu` is used only when none exists:

  ```sql
  -- V(i): i.token_hash = ?h AND i.email_norm = ?e AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  --   AND i.expires_at > ?t
  --   AND (i.org_id IS NULL OR EXISTS (SELECT 1 FROM orgs o WHERE o.id = i.org_id AND o.status = 'active'
  --                                    AND (o.required_hd IS NULL OR o.required_hd = ?hd)))
  --   AND NOT EXISTS (SELECT 1 FROM console_users u WHERE u.provider = ?p AND u.sub = ?sub AND u.disabled_at IS NOT NULL)
  INSERT INTO console_users (id, provider, sub, email, created_at)
       SELECT ?nu, ?p, ?sub, ?e, ?t FROM invites i WHERE V(i) ON CONFLICT (provider, sub) DO NOTHING;
  UPDATE invites SET accepted_at = ?t, accepted_by_sub = ?sub,
         accepted_user_id = (SELECT id FROM console_users WHERE provider = ?p AND sub = ?sub)
   WHERE V(invites);
  INSERT INTO orgs (id, name, created_at)
       SELECT ?newOrg, new_org_name, ?t FROM invites
        WHERE token_hash = ?h AND accepted_at = ?t AND accepted_by_sub = ?sub AND new_org_name IS NOT NULL;
  INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at)
       SELECT COALESCE(i.org_id, ?newOrg), i.accepted_user_id, i.role, ?t, i.created_by, ?t FROM invites i
        WHERE i.token_hash = ?h AND i.accepted_at = ?t AND i.accepted_by_sub = ?sub
       ON CONFLICT (org_id, user_id) DO NOTHING;
  INSERT INTO audit_log (…) SELECT … 'invite.accepted' … FROM invites
        WHERE token_hash = ?h AND accepted_at = ?t AND accepted_by_sub = ?sub;
  ```

  For an owner invite with an `owner_grants` row (§Invites and owner grants), the member insert uses `role =
  'viewer'` and one more statement sets the grant's `user_id` and `owner_from`. `V(i)` also needs `i.token_hash IS
  NOT NULL` (the notice was accepted).

  D1 runs a batch as one serialised transaction, so a concurrent second acceptance inserts nothing. Email matching is
  exact after lowercasing. The server then reads the invite and creates a session only if `accepted_by_sub = sub`;
  otherwise 403 `invite_invalid` (one generic code).

### Sessions

- **Cookie:** `__Host-hana_cs`, 32 random bytes, `Secure; HttpOnly; SameSite=Strict; Path=/`, console origin only.
  D1 stores its sha256. A new id at every sign-in.
- **Lifetime:** 2 h idle (`last_seen_at` written at most every 5 min), 12 h absolute.
- **Roles are read from `members` on every request.** Removing a member, changing a role, disabling a user or
  freezing their only org deletes the user's sessions at once.
- **CSRF.** Every non-GET request needs `Sec-Fetch-Site: same-origin`, `Origin` equal to `console.origin`,
  `x-hana-console: 1` and `content-type: application/json`; otherwise 403 `csrf`.
- **Rate limits:** `/api/auth/*` and the auth-origin routes, 10 per minute per IP (IPv6 /64), with the Workers
  rate-limiting binding in the console Worker (the auth origin's requests reach it through `AuthHandler`); the API's
  `RateLimiter` only if the binding isn't available on the account's plan (D93).

## Roles and permissions

`H` is a Hana admin in the admin console. "On-chain" means the member's `sub` must also be an `Owner::Oidc` of the
app's scope, checked by the API (guarded changes) or the contract (owner actions). "Blocking" means the admin
Worker's notice must be accepted before the clock starts; "feed" means the admin Worker emails it after the fact
(§Email). A frozen org refuses every console write except cancels and the kill switches.

| Action | owner | viewer | H | Fresh sign-in | Delay | Notice |
|---|---|---|---|---|---|---|
| View apps, origins, guarded changes, keys, settings, policy, usage, statements, members, audit | ✓ | ✓ | ✓ | — | — | — |
| Add an origin; set or change the policy; enable raw signing | ✓ on-chain | — | ✓ | ✓ API-verified (not H) | ✓ | blocking |
| Cancel a pending guarded change | ✓ | — | ✓ | — | — | feed |
| Expedite a member-proposed guarded change | — | — | ✓ (reason) | — | ends it | feed |
| Remove an origin; remove the policy; turn raw signing off | ✓ | — | ✓ | — | — | feed |
| Suspend an app (owner bit 4, H bit 1) | ✓ | — | ✓ | — | — | feed |
| Resume (owners clear bit 4 only; H any bit) | ✓ | — | ✓ | ✓ (not H) | — | feed |
| Persistence, session and idle lengths (D43), web client | ✓ | — | ✓ | ✓ (not H) | — | feed |
| App name and logo | ✓ | — | ✓ | — | — | feed |
| Create, rotate (24 h grace) or revoke a publishable key | ✓ | — | ✓ | — | — | feed |
| On-chain owner action (propose, cancel, remove_client, disable_shared_login) | ✓ on-chain | — | — | ✓ | contract timelock | watcher |
| `execute_change` (anyone may call it) | ✓ | — | ✓ | — | — | watcher |
| Change a member's role, remove a member | ✓ | — | ✓ | ✓ (not H) | — | feed |
| Org `required_hd` | ✓ | — | ✓ | ✓ (not H) | — | feed |
| Invite an owner or viewer to the org (D89) | ✓ | — | ✓ (any org, or a new org) | ✓ (not H) | a new owner: 24 h as a viewer, unless the org has no owner | blocking: invitee, every owner, security contacts |
| Promote a viewer to owner (D89) | ✓ | — | ✓ | ✓ (not H) | 24 h | blocking: every owner, security contacts |
| Cancel a pending invite or owner grant | ✓ | — | ✓ | — | — | feed |
| Set an org's security contacts | — | — | ✓ | — | — | old and new contacts |
| Create an app; assign a legacy scope; delete an app; freeze an org; suspend an org (bit 2); disable a user | — | — | ✓ | — | — | feed |

- The last owner of an org can't be removed or demoted. A pending owner (inside the 24 h) counts as a viewer.
- Owners who aren't on-chain owners can do everything in the owner column except the "on-chain" rows; for those they
  ask Hana for a staff proposal or add themselves on chain with `SetOwners` (timelocked).

## Invites and owner grants (D89)

- **Who invites.** Hana staff create an org by inviting its first owner (`StaffRpc.issueInvite` with `newOrgName`),
  and may invite to any org. Owners invite viewers and owners to their own org only: step-up kind `member.invite`
  (`{email, role}`), so every owner-issued invite is a fresh Google sign-in bound to that invite. Staff invites are
  authorised by the staffer's Access session (staff have no Google step-up). At most 10 open invites per org
  (`conflict` otherwise). Viewers can't invite.
- **Notice first (fails closed).** An invite is created with `token_hash` NULL, so no link works yet. The admin
  Worker's 5-minute cron reads `StaffRpc.pendingMemberNotices`, computes the invite token `T` (§Nonce layouts), emails
  the invitee the link `<console.origin>/invite#t=<T>`, and emails the notice (who invited whom, which role, request
  country, the cancel instructions) to every owner of the org, its security contacts (`AdminRpc.getSecurityContacts`)
  and the security alias. Only after every send is accepted does it call `ackMemberNotice({inviteId, tokenHash})`,
  which sets `token_hash` and `notified_at`. The invite's 7 days count from creation.
- **New owners wait.** An owner invite to an org that already has an owner also creates an `owner_grants` row. On
  acceptance the member row is written with `role = 'viewer'`, and the grant gets `user_id` and `owner_from =
  accepted_at + ownerGrantDelayMs` (24 h in production) in the same batch. A promotion of a viewer (`member.role` to
  owner, by an owner with a step-up or by staff) creates a grant at once; its notice goes to every owner, the contacts
  and the alias, and `owner_from = notified_at + ownerGrantDelayMs`. Every grant notice carries a cancel link
  `<console.origin>/cancel-owner/<grantId>#t=<T>` (a page with a POST confirm, like guarded-change links).
- **Becoming owner.** A member is an owner when `role = 'owner'`, or by predicate when an uncancelled grant has
  `owner_from <= now`; the console's hourly cron records it (`members.role = 'owner'`, `applied_at`, audit
  `member.owner_granted`). Until then they are a viewer and don't count for the last-owner rule.
- **Cancel.** Any owner (console), Hana staff (`StaffRpc.cancelOwnerGrant`, admin console) or the emailed link, until
  `owner_from`. Cancelling leaves the person a viewer; removing them is a separate, immediate action. Revoking an
  unaccepted owner invite cancels its grant.
- **Exception.** The first owner of an org (no owner exists: a new org, or an org whose owners were all removed by
  Hana) is an owner on acceptance; the notice still goes to the contacts and the alias.
- **Staff membership changes.** Hana staff add and remove members in the admin console (`StaffRpc.setMember`): a
  removal is immediate; adding an owner to an org that has one goes through a grant like any other.
- Every invite, grant, cancel and removal writes `audit_log` and goes to the feed.

## Fresh sign-in (step-up)

Every "fresh sign-in" row above is a Google code flow whose nonce commits to that one action, so the proof is good for
that action only. Without passkeys (§Deferred) it proves that the member's Google account and live Google session
approved this exact digest within 120 s; it doesn't prove presence (Google offers no forced re-authentication, so a
live session confirms in one click).

1. `POST /api/orgs/:org/actions {kind, params}`. The server checks the role, builds the canonical action, computes `d`
   and the Google nonce per §Nonce layouts (the origin or settings layout for guarded changes, the owner layout for
   owner actions, the generic one otherwise), stores `pending_actions` (5 min) and returns
   `{id, kind, decoded, expiresAt}`; the UI shows the decoded action (for a policy, the consent-screen preview).
2. `POST /api/actions/:id/google` creates an `auth_flows` row (`purpose = 'step_up'`, `scope = 'openid'`,
   `login_hint` = the session sub, the action's nonce) and returns `{startUrl}`; the SPA navigates there top-level.
3. **Callback** (auth origin): the callback checks above, including `__Host-hana_af`; `sub` equals the session user's
   sub; `iat` ≤ 120 s; the pending action unused and unexpired; and the session alive (`pending_actions.session_hash`
   matches an unrevoked `console_sessions` row inside both limits; the cookie itself isn't sent to the auth origin).
   It then **executes the stored action inside the callback**, so the token is used once and never stored: for a
   guarded change or an owner action the JWT goes to the API (`ConsoleRpc.proposeChange`, `ConsoleRpc.ownerAction`),
   which verifies it itself. It answers 303 to `<console.origin>/actions/:id#`; the page reads the outcome from
   `GET /api/actions/:id`.

- **Single use.** `UPDATE pending_actions SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?` must
  change one row. For console-DB-only kinds (`member.role`, `member.remove`, `org.policy`) the consumption, the change
  and the audit row are one guarded batch.
- **Kinds:** `origin.add` (with any removes in the same change), `policy.set`, `raw_sign.on`, `app.resume`,
  `app.settings`, `owner_action`, `member.invite`, `member.role`, `member.remove`, `org.policy`. `member.invite` and a
  `member.role` promotion to owner create an `invites` or `owner_grants` row; the notice and the 24 h follow
  (§Invites and owner grants).
- Every step-up action writes an `audit_log` row with `step_up_id`.

## Guarded changes (origin adds, policies, raw signing)

### Origin input rules (`normaliseOrigin`, used by the API, the console and the CLI)

- Origin only: http(s), no credentials, path, query or fragment; lowercased host; default port dropped; trailing dot
  removed.
- Stored and compared in ASCII (punycode) form, as the WHATWG URL parser produces it. An `xn--` label is flagged in the
  console, the notice and the admin console with its decoded form beside it. On `live` scopes a label mixing scripts
  is refused (`origin_refused`, `reason: mixed_script`).
- Production envs (`NETWORK = mainnet`): `https` only, no wildcard, no loopback. Non-production envs: loopback and the
  literal `http://localhost:*` only on `test` scopes; other plain `http` refused.
- Always refused: every origin in `REFUSED_ORIGINS` (§Topology).
- At most 20 active-or-pending origins per app.

### Policy and raw-signing input rules

- A policy is validated by `@hana-id/core/policy` `validateAutoApprovePolicy` against the app's `session_ttl_ms`, in
  the console (as the owner edits) and again in the API, and stored as canonical JSON with its `policyId`. The
  editor shows the consent screen as users will see it (`render-consent.ts`, verified names and "named by {app}"
  labels included, D44).
- At most one pending `policy_set` and one pending `raw_sign_on` per app (`conflict` otherwise; cancel first).
- `raw_sign_on` is refused for a test app (D39: test apps never sign raw).

### Lifecycle

| From | Event | To | Effect in the hot DB | Bumps |
|---|---|---|---|---|
| — | propose (member with an API-verified step-up, or H) | `pending`, not announced | origin: `app_origins` row with `active_from` NULL; policy, raw: nothing yet | origins / settings version |
| pending, not announced | `AdminRpc.ackNotice` (the admin notice was accepted) | `pending`, announced | `notified_at`, `active_from = now + appChangeDelayMs` (or `now` under a waiver) on the change and on `app_origins`; policy: `auto_approve_pending`, `auto_approve_effective_at = active_from`; raw: `raw_sign_pending = 'approval'`, `raw_sign_effective_at = active_from` | — |
| pending | the clock passes `active_from` | in force by predicate (batch B's `matured()` for settings, `active_from <= now` for origins) | the API's hourly cron records it: `status = 'active'`, `activated_recorded_at`, `app_changes *.activated`; policy and raw are promoted (`auto_approve_policy = pending`, pending columns cleared; the previous active `policy_set` → `ended`) | — |
| pending | H expedite | in force now | `active_from = now` (and the matching `*_effective_at`) | — |
| pending | cancel (owner, H, the emailed link) | `cancelled` | origin row deleted; pending settings columns cleared if still `> now` | origins / settings version |
| active | remove the origin, remove the policy, raw signing off | `ended` | row deleted or columns cleared; immediate | origins / settings version |

- Notices, activation and expedite don't bump a version, so they never invalidate an owner's step-up in flight.
- **Removes sent with an origin add** take effect at once, in the same batch as the pending adds.
- **Removal is immediate everywhere:** a removed policy stops auto-signing in open tabs within 10 s (D62), raw
  signing `'off'` the same (D68).
- A change that isn't announced within 7 days is cancelled by the API cron (`system`), so a stuck notice can't leave
  a change waiting to go live much later.

### Waivers (recorded in `waiver`; the notice still blocks)

- `loopback`: a loopback origin on a test-scope app in a non-production env.
- `no_session`: `scopes.first_session_at IS NULL` when the ack lands (no user has a key in the scope), and either the
  proposer is a member with a verified step-up, or the change is one of the initial origins of an `AdminRpc.createApp`
  (or CLI `app:create`) call that created the `scopes` row. Any other staff proposal gets the full delay.

### API verification (`ConsoleRpc.proposeChange`, `changeOrigins`)

In order, failing closed:

1. RS256 signature (`packages/oidc`).
2. `(provider, aud)` is in the on-chain `console_audiences`.
3. `iat` ≤ 300 s old.
4. `nonce` equals the origin-change or settings-change layout recomputed from the request and the stored
   `origins_version`/`settings_version`, which must equal `expectedVersion` (`version_conflict`).
5. `sub` is an `Owner::Oidc` of the app's scope, read with an **uncached** `get_scope` (`near_unavailable` if NEAR RPC
   is down).
6. `sha256(jwt)` is reserved in the `owner-actions:tokens` limiter until `exp` (`token_used`).

### Notice and cancel

- The admin Worker's 5-minute cron reads `AdminRpc.pendingNotices()` (every pending change with `notified_at` NULL,
  with the org's security contacts), computes the change's cancel token `T`, and emails `email.securityAlias` and every
  security contact. Once the provider has accepted every send, it calls `AdminRpc.ackNotice({changeId,
  cancelTokenHash: sha256(T)})`, which sets `notified_at`, `active_from` and the token hash in one CAS batch.
- The notice describes the change as the API stored it: app, kind, origin (ASCII and decoded, IDN warning), or the
  policy (`policyId`, label, contracts with verified/partner names, functions, limits, every `addressArgs: 'any'`),
  proposer email or staff id, request country, unlock time; and when a pending `SetAllowShared` would turn on shared
  login, the scope's active origins.
- It links to `<console.origin>/cancel/<changeId>#t=<T>`: a page with a POST confirm (a GET never cancels, so mail
  scanners cancel nothing). `POST /api/cancel {changeId, token}` → `ConsoleRpc.cancelChangeByLink`; the API checks
  `sha256(token)`, marks the change cancelled, and the token is single use and valid until `active_from`. The email
  also says how to reach Hana security, who can cancel from the admin console if the console page misbehaves.
- An org with no security contacts can't get apps (`createApp` refuses `no_security_contact`); if contacts are later
  emptied, notices still go to the alias and the admin console flags the org.
- A failed send leaves the change unannounced; the cron retries every run. Emails never contain approve links.

### Staff proposals (`AdminRpc.proposeChange`, `addOrigins`)

- No step-up; the full delay and the blocking notice; no waiver except `createApp`'s `no_session` case.
- Refused on a scope whose `assigned_at` is less than `appChangeDelayMs` ago.
- Never expedited.

### Expedite (`AdminRpc.expediteChange({changeId, reason})`)

Allowed only for an announced, pending, member-proposed change. `reason` (≥ 20 characters) names the security
contact, other than the proposer, who confirmed the change out of band and how. Sets `active_from = now`, writes
`app_changes change.expedited` with the staff id, and goes to the feed.

### Drift detection (API hourly cron)

Every origin with `active_from <= now` must be explained by an active `origin_add`, the 0006 baseline or an
`app.created` row; every in-force or pending policy's `policyId` and every `raw_sign`/`raw_sign_pending =
'approval'` by a `policy_set`/`raw_sign_on` change that was announced, or the baseline. A mismatch writes
`security_events` (`drift`), which the admin feed emails. It catches direct D1 writes (manual SQL, a buggy script);
it doesn't catch an insider who also forges `guarded_changes` rows.

## Other app settings, name and logo

- **Settings** (`app.settings`, owner, fresh sign-in, immediate, CAS on `settings_version`): `persistence`,
  `session_ttl_ms`, `idle_ttl_ms` (batch B's ranges, D43), `google_web_client_id` (must be one of the scope's on-chain
  Google clients, read uncached). Batch B's API and share endpoints read them live, so shares follow at once.
- **Name** (≤ 64 characters, the batch B label rules) and **logo**: owner, immediate, feed. Logo upload,
  `POST /api/orgs/:org/apps/:app/logo` (raw body):
  - type by magic bytes: PNG, JPEG or WebP; SVG, GIF, AVIF and everything else refused (`logo_type`);
  - ≤ 512 KiB; decoded size 128 to 2048 px per side; aspect ratio ≤ 1.25;
  - re-encoded to a 256 × 256 PNG (fit contain, transparent padding, no metadata) through the Cloudflare Images
    binding (D93); the output must decode again, be a PNG and be ≤ 128 KiB;
  - stored at `logos/<app_id>/<sha256 hex>.png` (`contentType: image/png`), recorded in `logo_objects`, then
    `ConsoleRpc.setLogo` points `apps.logo_key` at it (CAS). The replaced object is deleted 30 days later.
- **Files Worker** serves only `GET /logos/<app_id>/<64 hex>.png`: the object must exist, have `contentType`
  `image/png` and start with the PNG signature, otherwise 404. Headers: §Response headers. Hana's popups never show
  a partner-hosted image (D74).

## Keys

- Publishable keys only: `pk_test_` or `pk_live_` + base58(24 random bytes), matching the scope's environment.
- **Rotate:** issues a new key; the old one gets `revoked_at = now + 24 h` (fixed grace, D34). **Revoke:** immediate;
  revoking the last active key is allowed (a kill switch) and warns. No step-up for either: keys are public and
  origins gate them; both count in the breaker.
- At most 5 unrevoked keys per app. A revoked key is never restored (§Deferred); the partner ships a new one.

## Apps, scopes and client mode

- **Onboarding** (out of band: email or call; the request queue is deferred). Hana staff create the org by invite,
  set its security contacts (default: every owner's email plus one contact the partner names), register the scope
  with `admin.ts scope:register --owners-from-org <org>` (`admin_register_scope` with the owners' `Oidc{google, sub}`
  captured at invite acceptance; dry run, `--yes`), then create the app.
- **Google client tier (D42).** Standard: shared login (`SetAllowShared`), no client proof. Enterprise: Hana holds the
  partner-branded client and registers it as the scope's own; Hana produces the client proof. Partner-held own client:
  the partner produces the proof with the helper below, after the written warning.
- **`AdminRpc.createApp`** refuses `no_security_contact`; reads `get_scope` uncached and refuses `scope_conflict`
  unless the scope exists and every `Owner::Oidc` is the sub of an owner of the org (the admin Worker passes them from
  `StaffRpc.listMembers`); writes `scopes` (refusing another org or environment, recording whether it created the
  row), `apps` (`publishable_key` = the first key), the first `app_keys` row, and the requested origins as staff
  proposals (the `no_session` waiver only when it created the scope row).
- **`AdminRpc.assignScopeOrg({scopeId, orgId})`**: only while the scope is in `org_legacy`; the same owner check;
  moves every app of the scope in one statement (trigger); sets `assigned_at`; `app_changes scope.assigned`.
- **`AdminRpc.deleteApp`**: `deleted_at`, `suspended_by |= 1`, every key revoked, `app_changes app.deleted`. Never a
  hard delete; ids never reused.
- **Client mode changes are owner actions:** `propose_change(AddClient)` with a client proof; `propose_change
  (SetAllowShared)` (timelocked); `disable_shared_login` and `remove_client` (immediate).
- **Owner drift.** The console compares the org's owners in D1 with the scope's on-chain owners, flags a difference
  and offers a `SetOwners` proposal (timelocked).
- **Suspension bitmask:** hana = 1 (per app, H), org = 2 (every app of an org, H), partner = 4 (owner). Active iff 0.
  Clearing one bit never clears another; H may clear any bit, including bit 4 after a malicious mass suspension.

## On-chain owner actions

1. The console reads `get_scope` uncached for `action_nonce` N, `pending`, `clients` and `allow_shared`.
2. It builds `borsh(args without auth)` with `packages/console-core`, computes the owner nonce, stores the pending
   action (`scope_id`, N, `near_args`) and shows the decoded action.
3. **AddClient only.** The proof must come from the client itself, on an origin that client authorises; the console
   never serves the proof page. It offers a self-contained static HTML helper as a download (`Content-Disposition:
   attachment`) with the client ID, the scope and the proof nonce for N; the partner opens it on one of the client's
   JavaScript origins, it loads GIS with that nonce and shows the JWT to copy. Before accepting the pasted JWT the
   console warns that it carries the staffer's email and name and becomes public on chain, and checks its signature,
   `iss`, `exp`, `aud` (= the client in `AddClient`) and nonce (`invalid_client_proof`). The owner nonce then commits
   to that exact proof string.
4. The step-up flow with nonce = the owner nonce and `scope=openid`; the callback refuses a token with `email`.
5. In the callback the console re-reads `get_scope`: if N moved, the action fails and the user rebuilds (never a
   silent retry with a different action); otherwise `ConsoleRpc.ownerAction({orgId, body, clientIp, actor})` with a
   body byte-identical to what was built. `token_used` or `owner_nonce_mismatch` → rebuild from the new N.

API changes:

- `handleOwnerAction(body, clientIp)`: `ConsoleRpc` passes the client IP to the same per-IP limiter.
- `precheckOwnerAction` recomputes the owner nonce (and the client-proof nonce for AddClient) from an uncached scope
  view before the token is reserved: 409 `owner_nonce_mismatch`, 400 `invalid_client_proof`. A mismatch is refused
  for free instead of burning gas.
- **Limits** below the existing global caps (20/min, 200/day): 20 owner actions per scope per UTC day; a separate
  safety budget for `cancel_change`, `remove_client` and `disable_shared_login` (10/min and 100/day globally, 10 per
  scope per day) that the general caps can't exhaust. Reaching a cap writes `security_events` (`owner_cap`).
- **Allowance alert:** the hourly cron reads each owner-pool key with `view_access_key` and writes
  `owner_allowance_low` below 25% of its initial allowance.
- **Staff relay runbook.** If a safety call is `rate_limited` or the owner pool is drained, the console shows the
  owner the exact signed body to send to Hana security, who relay it with `admin.ts owner:relay --body <file>` from a
  Hana-funded account whose key is in `.secrets/` (dry run, `--yes`, never prints the JWT).

After a relay the console writes the audit row with `near_tx`. `execute_change` needs no token.

**On-chain watcher (admin, every 5 min; one channel).** It pages `AdminRpc.listScopes`, reads `get_scope` uncached,
and emails the security alias and the org's security contacts about each `(scope_id, change_id)` not yet in
`ops.scope_watch` (decoded: for `SetOwners` the new list with added `Owner::Oidc` highlighted; for `AddClient` the
client; with cancel instructions). It diffs owners, clients and `allow_shared` against `ops.scope_snapshot` and emails
any change, covering executed and immediate ones. It catches changes relayed outside the console and makes the event
watching `docs/contract-interface.md` relies on independent of the console.

**What a fresh sign-in doesn't cover.** Anyone holding a victim owner's live Google session can mint console-client
tokens with any nonce outside our console, and so can a compromised console Worker at any routine sign-in (it chooses
the nonce). That gives on-chain owner power and guarded-change proposals, not console power. They are bounded by the
contract timelock, cancel by any owner, the blocking notice and delay, and the watcher's emails, which a compromised
console can't suppress.

## RPC interfaces

All inputs are validated with zod. Every result is `{ok: true, …} | {ok: false, code, error?}`. None of these classes
has a route: the API's public `fetch` serves only `/v1/*`.

```ts
type Actor =
  | { kind: 'member'; id: string; sub: string; email: string; sessionHash: string }
  | { kind: 'hana'; id: string /* Access sub */; email: string }
  | { kind: 'system'; id: string }
  | { kind: 'link'; id: string /* change id */ };
interface Ctx { actor: Actor; requestId: string; clientIp: string }
type RpcCode = 'bad_request' | 'not_found' | 'forbidden' | 'version_conflict' | 'already_applied' | 'not_owner'
  | 'origin_refused' | 'policy_invalid' | 'token_used' | 'near_unavailable' | 'rate_limited' | 'key_limit'
  | 'env_mismatch' | 'scope_conflict' | 'not_pending' | 'conflict' | 'no_security_contact' | 'invalid_client_proof'
  | 'owner_nonce_mismatch' | 'passkeys_required' | 'internal';

// apps/api, bound only by the console. Every org method takes orgId; every query has WHERE org_id = ?.
interface ConsoleRpc {
  listApps(c: Ctx & { orgId }): Rpc<{ apps: AppSummary[] }>;
  getApp(c: Ctx & { orgId; appId }): Rpc<{ app: AppDetail }>;
  changeOrigins(c: Ctx & { orgId; appId; add: string[]; remove: string[]; expectedVersion: number; stepUpJwt: string })
    : Rpc<{ version: number; changes: GuardedChange[] }>;
  removeOrigins(c: Ctx & { orgId; appId; remove: string[]; expectedVersion: number }): Rpc<{ version: number }>;
  proposeChange(c: Ctx & { orgId; appId; kind: 'policy_set' | 'raw_sign_on'; policy?: unknown; expectedVersion: number;
                           stepUpJwt: string }): Rpc<{ version: number; change: GuardedChange }>;
  turnOff(c: Ctx & { orgId; appId; what: 'policy' | 'raw_sign'; expectedVersion: number }): Rpc<{ version: number }>;
  updateSettings(c: Ctx & { orgId; appId; expectedVersion: number; persistence?; sessionTtlMs?; idleTtlMs?;
                            googleWebClientId?: string | null; name?: string }): Rpc<{ version: number }>;
  setLogo(c: Ctx & { orgId; appId; logoKey: string | null; expectedVersion: number }): Rpc<{ version: number }>;
  cancelChange(c: Ctx & { orgId; changeId }): Rpc<{ change: GuardedChange }>;
  cancelChangeByLink(c: Ctx & { changeId; token: string }): Rpc<{ change: GuardedChange }>;
  setSuspended(c: Ctx & { orgId; appId; suspended: boolean }): Rpc<{ suspendedBy: number }>;   // bit 4 only
  createKey(c: Ctx & { orgId; appId }): Rpc<{ key: KeyView }>;
  rotateKey(c: Ctx & { orgId; appId; keyId }): Rpc<{ key: KeyView; oldKeyRevokedAt: number }>;
  revokeKey(c: Ctx & { orgId; appId; keyId }): Rpc<{}>;
  listChanges(c: Ctx & { orgId; beforeSeq?: number; limit: number /* ≤ 200 */ }): Rpc<{ changes: AppChange[] }>;
  usage(c: Ctx & { orgId; appIds?: string[]; from: Day; to: Day; by: 'day' | 'month' }): Rpc<{ rows: UsageRow[] }>;
  statements(c: Ctx & { orgId }): Rpc<{ statements: StatementMeta[] }>;
  ledger(c: Ctx & { orgId; month: string; asOf?: number; after?: string }): Rpc<{ rows: LedgerRow[]; next?: string }>;
  ownerAction(c: Ctx & { orgId; body: OwnerActionBody }): Rpc<{ status: number; result?: unknown; nearTx?: string; code?: string }>;
}
// apps/api, bound only by the admin Worker: the ConsoleRpc org methods for any org (Hana actor, no step-up, no
// breaker; proposals go through proposeChange/addOrigins below), plus:
interface AdminRpc {
  createApp(c: Ctx & { orgId; scopeId; environment: 'test' | 'live'; name; origins: string[]; orgOwnerSubs: string[] })
    : Rpc<{ app: AppDetail; publishableKey: string; createdScope: boolean }>;
  assignScopeOrg(c: Ctx & { scopeId; orgId; orgOwnerSubs: string[] }): Rpc<{ apps: number }>;
  deleteApp(c: Ctx & { appId }): Rpc<{}>;
  setSuspended(c: Ctx & { appId; bit: 1 | 2 | 4; suspended: boolean }): Rpc<{ suspendedBy: number }>;
  suspendOrg(c: Ctx & { orgId; suspended: boolean }): Rpc<{ apps: number }>;
  addOrigins(c: Ctx & { orgId; appId; add: string[]; expectedVersion: number }): Rpc<{ changes: GuardedChange[] }>;
  proposeChange(c: Ctx & { orgId; appId; kind: 'policy_set' | 'raw_sign_on'; policy?: unknown; expectedVersion: number })
    : Rpc<{ change: GuardedChange }>;
  expediteChange(c: Ctx & { changeId; reason: string }): Rpc<{ change: GuardedChange }>;
  pendingNotices(c: Ctx & { limit: number }): Rpc<{ notices: { change: GuardedChange; contacts: string[] }[] }>;
  ackNotice(c: Ctx & { changeId; cancelTokenHash: string /* b64url sha256 */ }): Rpc<{ change: GuardedChange }>;
  setSecurityContacts(c: Ctx & { orgId; emails: string[] /* 1–10, lowercased */ }): Rpc<{ emails: string[] }>;
  getSecurityContacts(c: Ctx & { orgId }): Rpc<{ emails: string[] }>;
  listScopes(c: Ctx & { cursor?: string; limit: number }): Rpc<{ scopes: ScopeRow[]; next?: string }>;
  changesSince(c: Ctx & { seq: number; limit: number }): Rpc<{ changes: AppChange[] }>;
  securityEvents(c: Ctx & { unnotifiedOnly: boolean; limit: number }): Rpc<{ events: SecurityEvent[] }>;
  markSecurityEventNotified(c: Ctx & { ids: string[] }): Rpc<{}>;
  relayerKeys(c: Ctx): Rpc<{ keys: { pool: 'session' | 'owner'; publicKey: string }[] }>;   // public keys only
  purgeAudit(c: Ctx & { before: number; limit: number }): Rpc<{ appChanges: number; guardedChanges: number }>;  // D90
  deletedApps(c: Ctx & { before: number }): Rpc<{ appIds: string[] }>;                       // for app_users purge
}
// apps/console, bound only by the admin Worker. Every method takes a Hana actor.
interface StaffRpc {
  listOrgs(c: Ctx & { cursor?: string; limit: number }): Rpc<{ orgs: OrgView[]; next?: string }>;
  getOrg(c: Ctx & { orgId }): Rpc<{ org: OrgView; members: MemberView[]; invites: InviteView[] }>;
  issueInvite(c: Ctx & { email: string; role: Role; orgId?: string; newOrgName?: string; kind?: 'partner' | 'internal' })
    : Rpc<{ invite: InviteView }>;   // unusable until ackMemberNotice; the admin Worker computes and emails the token
  revokeInvite(c: Ctx & { inviteId }): Rpc<{}>;
  pendingMemberNotices(c: Ctx & { limit: number })
    : Rpc<{ notices: { kind: 'invite' | 'owner_grant'; invite?: InviteView; grant?: OwnerGrantView;
                       owners: { email: string }[] }[] }>;
  ackMemberNotice(c: Ctx & { inviteId?: string; grantId?: string; tokenHash: string /* b64url sha256 */ }): Rpc<{}>;
  cancelOwnerGrant(c: Ctx & { grantId }): Rpc<{}>;
  listMembers(c: Ctx & { orgId }): Rpc<{ members: MemberView[] }>;   // includes sub, for orgOwnerSubs
  setMember(c: Ctx & { orgId; userId; role: Role | null /* null = remove */ }): Rpc<{}>;
  disableUser(c: Ctx & { userId; disabled: boolean }): Rpc<{}>;
  freezeOrg(c: Ctx & { orgId; frozen: boolean }): Rpc<{}>;
  auditSince(c: Ctx & { seq: number; limit: number }): Rpc<{ rows: AuditRow[] }>;
  queryAudit(c: Ctx & { filters: AuditFilters; cursor?: string; limit: number }): Rpc<{ rows: AuditRow[]; next?: string }>;
  purgeAudit(c: Ctx & { before: number; limit: number }): Rpc<{ auditLog: number; ownerGrants: number }>;      // D90
}
```

- **Compare-and-swap writes** (instead of `rpc_results`, a write-ahead audit and a reconciler). Every hot-DB write
  is one D1 batch whose first statement inserts its `app_changes` row, guarded by the expected version:

  ```sql
  INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?rid FROM apps WHERE id = ?app AND org_id = ?org AND origins_version = ?v;
  -- every later statement: … WHERE EXISTS (SELECT 1 FROM app_changes WHERE request_id = ?rid)
  UPDATE apps SET origins_version = ?v + 1 WHERE id = ?app AND EXISTS (SELECT 1 FROM app_changes WHERE request_id = ?rid);
  ```

  A batch is one serialised transaction. A replayed `requestId` violates `app_changes.request_id UNIQUE`, so the
  batch aborts and the API answers `already_applied` with the stored row; a moved version inserts nothing and the
  API answers `version_conflict`; there is never an applied change without its ledger row. Cron writes (activation,
  promotion, ack, expiry) use the same pattern with `system` actors and a fresh id.
- **Trust in the actor.** `ConsoleRpc` trusts its `actor` and `orgId` except where the API verifies a token (guarded
  changes, owner actions). The `orgId` filter is a backstop against console bugs, not against a compromise.
- **Destructive-call breaker.** `setSuspended(true)`, `revokeKey`, `rotateKey` and `removeOrigins` calls through
  `ConsoleRpc` are counted in the `RateLimiter` DO before the write: 5 per org and 20 across orgs per rolling hour (D93:
  counted per call). Over either, `rate_limited` and a `breaker` security event. Cancels and `turnOff` aren't counted: a
  cancel never touches a live origin, and turning the policy or raw signing off only sends signatures back to the popup.
  `AdminRpc` isn't limited.
- **Hot-DB budget.** Each `ConsoleRpc` call runs at most two reads and one batch of ≤ 8 indexed statements
  (multi-row `INSERT … VALUES` for several origins), charged
  to a token bucket in the `RateLimiter` DO (`console-rpc:hotdb`: 30 statements/s, burst 60); over it,
  `rate_limited`. `usage`, `statements` and `ledger` use only Neon and aren't charged.

### Types (`packages/console-core`, zod; TS shown)

```ts
type Day = string;                                       // YYYY-MM-DD, UTC
type Role = 'owner' | 'viewer';
interface AppSummary { id; name; scopeId; environment: 'test' | 'live'; suspendedBy: number; deleted: boolean;
  activeOrigins: number; pendingChanges: number; logoUrl?: string; createdAt: number }
interface AppDetail extends AppSummary { orgId; originsVersion: number; settingsVersion: number;
  origins: { origin: string; display: string; idn: boolean; activeFrom: number | null; changeId?: string }[];
  settings: { persistence; sessionTtlMs; idleTtlMs; googleWebClientId: string | null; rawSign: 'off' | 'approval';
              policy: { policyId: string; label: string; json: unknown } | null };
  changes: GuardedChange[]; keys: KeyView[] }
interface GuardedChange { id; appId; kind: 'origin_add' | 'policy_set' | 'raw_sign_on'; origin?; display?; idn?: boolean;
  policyId?: string; status: 'pending' | 'active' | 'cancelled' | 'ended';
  proposedByKind: 'member' | 'hana' | 'system'; proposedBy; proposedAt: number; requestCountry?: string;
  waiver?: 'loopback' | 'no_session'; notifiedAt?: number; activeFrom?: number | null;
  expeditedBy?: string; cancelledBy?: string; cancelledAt?: number }
interface KeyView { id; prefix; key: string; createdBy; createdAt: number; revokedAt?: number }
interface UsageRow { orgId; appId?: string; scopeId?: string; period: string /* Day or YYYY-MM */;
  logins: number; derives: number; revokes: number; unlocks: number; ownerActions: number;
  activeUsers?: number /* distinct uids in the period; MAU when by = month */; newUsers: number;
  failuresByCode: Record<string, number>; tgas: string; relayedRejectedTgas: string; errorTgas: string;
  burntYocto: string; usdMicros?: string; p50: { login?: number; derive?: number }; p95: { login?: number; derive?: number };
  unsettled: number }
interface StatementMeta { orgId; month: string; asOf: number; csvSha256: string; pdfSha256?: string; issuedBy; issuedAt: number }
interface AppChange { seq: number; at: number; orgId; appId?: string; scopeId?: string; kind: string;
  detail: Record<string, unknown>; actorKind: Actor['kind']; actorId; actorSub?: string; requestId }
interface SecurityEvent { id; detectedAt: number; kind: 'drift' | 'breaker' | 'owner_cap' | 'owner_allowance_low';
  orgId?: string; appId?: string; scopeId?: string; detail: Record<string, unknown>; notifiedAt?: number }
interface ScopeRow { scopeId; orgId; environment: 'test' | 'live'; assignedAt: number }
interface OwnerActionBody { method: 'propose_change' | 'execute_change' | 'cancel_change' | 'remove_client'
  | 'disable_shared_login'; args: Record<string, unknown> /* includes auth.Oidc.jwt where needed */ }
// StaffRpc views mirror their CONSOLE_DB rows with allowlisted columns only: never token_hash, cancel_token_hash or
// cookies. OwnerGrantView: { id; orgId; userId?; inviteId?; grantedByKind; grantedBy; createdAt; notifiedAt?;
//   ownerFrom?; cancelledAt?; appliedAt? } (D89).
```

### RpcCode → HTTP status (console and admin BFFs)

| RpcCode | HTTP |
|---|---|
| `bad_request`, `origin_refused`, `policy_invalid`, `env_mismatch`, `invalid_client_proof` | 400 |
| `forbidden`, `not_owner`, `passkeys_required` (§Deferred: `StaffRpc.issueInvite`) | 403 |
| `not_found` | 404 |
| `version_conflict`, `already_applied`, `token_used`, `scope_conflict`, `not_pending`, `conflict`, `key_limit`, `no_security_contact`, `owner_nonce_mismatch` | 409 |
| `rate_limited` | 429 |
| `internal` | 500 |
| `near_unavailable` | 503 |

Console-only codes: `unauthenticated` 401, `csrf` 403, `not_invited` 403, `invite_invalid` 403, `user_disabled`
403, `org_frozen` 403, `step_up_required` 403, `already_member` 409, `step_up_expired` 409, `logo_type` 400,
`logo_too_large` 413, `rate_limited` 429. Errors are `{error: {code, message}}`.

### Console BFF routes (`console.origin` unless stated)

| Method and path | Role | Step-up kind | Request → response |
|---|---|---|---|
| `POST /api/auth/start` | none | — | `{purpose:'login', invite?}` → `{startUrl}` |
| `GET <authOrigin>/start?f=`, `GET <authOrigin>/callback` | none | — | 303, or the static 400 page |
| `GET /api/auth/complete?h=` | none | — | 303 to `/` |
| `POST /api/auth/logout` | session | — | `{}` |
| `GET /api/me` | session | — | `{user, memberships: {orgId, role}[]}` |
| `GET /api/orgs/:org`, `/apps`, `/apps/:app`, `/members`, `/audit?cursor` | viewer | — | views (`audit` merges `audit_log` and `listChanges`) |
| `GET /api/orgs/:org/scopes/:scope` | viewer | — | decoded on-chain view, pending changes, owner drift |
| `POST /api/orgs/:org/actions` | owner | the kind | `{kind, params}` → `{id, kind, decoded, expiresAt}` |
| `POST /api/actions/:id/google`, `GET /api/actions/:id` | the action's user | — | `{startUrl}`; `{status, outcome, nearTx?}` |
| `POST /api/orgs/:org/apps/:app/origins/remove` | owner | — | `{remove, expectedVersion}` → `{version}` |
| `POST /api/orgs/:org/apps/:app/off` | owner | — | `{what, expectedVersion}` → `{version}` |
| `POST /api/orgs/:org/changes/:id/cancel` | owner | — | `{}` → `GuardedChange` |
| `POST /api/orgs/:org/apps/:app/suspend` | owner | — | `{}` → `{suspendedBy}` (resume is `app.resume`) |
| `POST /api/orgs/:org/apps/:app/profile`, `/logo` | owner | — | `{name, expectedVersion}`; image body → `{logoUrl}` |
| `POST /api/orgs/:org/apps/:app/keys`, `/keys/:key/rotate`, `/keys/:key/revoke` | owner | — | → `KeyView` |
| `POST /api/orgs/:org/scopes/:scope/execute` | owner | — | `{changeId}` → `{nearTx}` |
| `GET /api/orgs/:org/scopes/:scope/client-proof-helper` | owner | — | the helper download |
| `GET /api/orgs/:org/usage?from&to&by&apps` | viewer | — | `UsageRow[]` |
| `GET /api/orgs/:org/statements`, `/statements/:month.csv`, `/statements/:month.pdf`, `/ledger/:month.csv` | viewer | — | metadata; files from `STATEMENTS`; ledger streamed from `ConsoleRpc.ledger` |
| `GET /cancel/:changeId` (SPA), `POST /api/cancel` | none (CSRF rules) | — | `{changeId, token}` → `GuardedChange` |
| `POST /api/orgs/:org/invites/:id/revoke`, `POST /api/orgs/:org/owner-grants/:id/cancel` | owner | — | `{}` (D89; issuing an invite is the `member.invite` action) |
| `GET /cancel-owner/:grantId` (SPA), `POST /api/owner-grants/cancel` | none (CSRF rules) | — | `{grantId, token}` → `{}` |
| `GET /api/orgs/:org/statements/:month` | viewer | — | the on-screen statement (D92) |
| `GET /api/governance/pending-upgrades` | session | — | pending upgrades and owner actions (governance batch, D86) |

### Admin BFF routes (`admin.origin`; every route needs a valid Access JWT and a staff email)

| Method and path | Request → response |
|---|---|
| `GET /api/orgs`, `GET /api/orgs/:org` | `StaffRpc.listOrgs`, `getOrg` + `AdminRpc.getSecurityContacts` |
| `POST /api/orgs/:org/freeze`, `/suspend`; `PUT /api/orgs/:org/security-contacts` | `{frozen}`, `{suspended}`, `{emails}` |
| `POST /api/invites`, `POST /api/invites/:id/revoke` | issue (the Worker emails the token) and revoke |
| `POST /api/orgs/:org/members/:user`, `POST /api/users/:user/disable` | `{role \| null}`, `{disabled}` |
| `POST /api/apps`, `POST /api/scopes/:scope/assign` | `createApp` (owner subs from `listMembers`), `assignScopeOrg` |
| `POST /api/apps/:app/suspend`, `/resume`, `/delete` | `{bit}` → `{suspendedBy}` |
| `POST /api/apps/:app/origins`, `/origins/remove`, `/changes`, `/off` | staff proposals and removals |
| `POST /api/changes/:id/cancel`, `/expedite` | `{}` / `{reason}` |
| `POST /api/apps/:app/keys/:key/revoke` | `{}` |
| `GET /api/audit?filters&cursor`, `GET /api/audit.csv` | `queryAudit` + `changesSince` |
| `GET /api/security` | security events, feed lag, notice backlog, breaker state, nonce checks, watcher state |
| `GET /api/reports?org&from&to&by`, `POST /api/statements/:org/:month/issue`, `GET /api/statements/:org/:month.{csv,pdf}`, `POST /api/exports/:org/:month` | reports, statements, ledger exports |
| `PUT /api/rates/:day` | audited rate override (refused once the month has a statement) |
| `POST /api/owner-grants/:id/cancel`; `GET /api/orgs/:org/members` pending invites and grants | D89 |
| `GET /api/retention` | the monthly purge runs (D90) |
| `GET /api/monitoring`, `POST /api/monitoring/alerts/:id/ack`, `GET /api/governance/pending-upgrades` | governance batch (D83, D86) |
| `POST /api/users/search`, `POST /api/users/get`, `POST /api/support/lookup` | proposed (D275, D276): §Users and Support ID. POST so no address or code lands in a URL |

## Hana admin console (D75)

- **Access (D88).** Production: a self-hosted Access application on `admin.origin` (Custom Domain); a dev env without
  a Hana zone uses Worker-level Access on `workers.dev`. Policy: include members of the `Hana-Technology` GitHub team
  `hana-admins`, the GitHub org requiring 2FA for every member; fallback rule: exact-email Google identities listed in
  the policy (never a domain rule; the addresses are still to come, open question 4). Application session 1 h.
  `workers_dev` off in production, `preview_urls` off everywhere.
- **JWT check on every `/api/*` request** (`packages/oidc`, JWKS from
  `https://<accessTeamDomain>/cdn-cgi/access/certs`): RS256, a `kid` in the set, `iss = https://<accessTeamDomain>`,
  `aud = accessAud`, unexpired, non-empty `sub` (no service tokens), `type = 'app'`, and the lowercased `email` in the
  manifest's `admin.staffEmails` (a second check behind the Access policy, kept by D88; offboarding removes a person
  from both). Otherwise 401/403, fail closed. `ctx.access` isn't relied on.
- The actor `{kind: 'hana', id: sub, email}` travels as an explicit RPC argument into `audit_log` and `app_changes`.
- The console's CSRF rules and CSP apply.
- **Screens:** orgs (invite, freeze, suspend, security contacts, assign legacy scopes, owner/contact mismatch flag);
  members (add, remove, roles, pending invites and owner grants with cancel, disable; D89); apps (create,
  suspend/resume, staff proposals, removals, cancel, expedite, key revoke, delete); audit (filter, CSV); security
  (events, feed lag, notices, breaker, nonce checks, watcher, rejection-rate alerts, D91); reports and statements
  (on-screen statement, D92); rates; retention (each monthly purge run: time, rows per table, failures, next run;
  D90); proposed: Users and the Support ID lookup (§Users and Support ID, D275, D276). Added by the governance
  batch: "Security & monitoring" (watchdog, pending key changes, pause, pending upgrades and owner actions, alert history with acknowledge; D83, `docs/governance-spec.md` "Monitoring in the admin portal")
  and the pending-upgrades page (D86, also in the partner console). Its sources are built: the watchdog's `GET
  /status`, `/alerts`, `/actions` and `POST /alerts/:id/ack` (bearer `WATCHDOG_STATUS_TOKEN`, `apps/watchdog/README.md`
  "Status endpoint"; the check and alert-kind registry for the portal's registry test is `apps/watchdog/src/checks.ts`)
  and the chain views in `docs/contract-interface.md` "Monitoring hand-off" (also served normalised by the API's
  `GET /v1/governance`, `docs/api.md`; the council DAO's open proposals and the `admin <env> governance:status --json`
  reference snapshot: `docs/operations.md` "Governance status for the admin portal").
- **Security & monitoring: recovery playbooks (D126).** Every incident scenario has a step-by-step recovery guide in
  this view, from one source: `@hana-id/playbooks` (`packages/playbooks`; the same data generates
  `docs/playbooks.md`). The admin SPA imports the package at build time (plain data, no dependencies) and renders
  every playbook in `PLAYBOOKS`; nothing is copied by hand, so a playbook edit ships with the next admin deploy.
  Requirements:
  - A **Playbooks page** (`/security/playbooks`, one route per playbook: `/security/playbooks/<id>`) listing every
    playbook, alert and incident, with its severity, title, summary and (alert playbooks) the alert kinds it covers;
    `status: 'planned'` ones are marked "planned: not built yet". Incident playbooks are listed and **searchable**
    (client-side, over title, summary, signals and impact), and filterable by kind (alert / incident) and severity.
  - Each playbook shows, in order: signals, impact, the ordered steps, verify, follow-ups, refs (decision ids and doc
    anchors as links to the repo docs) and the related playbooks (links). **Each step shows who must act** (`who`:
    `council (2 of 3)`, `a founder`, `anyone`, `the watchdog`, `the API cron`, `scope owners`, `the user`; the package's
    `ACTORS`) as a badge, its detail,
    and its commands in copyable code blocks, verbatim (placeholders such as `<env>` are not filled in, and the page
    never renders a secret). The "Before you start" notes (`NOTES`) are shown above every playbook.
  - **Every alert links to its playbook**: each alert in the alert history and the open alerts, and each kind in the
    registry view, links to `/security/playbooks/<playbook>`, the `playbook` id the watchdog serves per kind in `GET
    /status` `alert_kinds` (fallback: `playbookForAlertKind(kind)` from the package). An alert kind whose playbook is
    missing renders a visible "no playbook" error, never a blank link.
  - Read-only: the page sends nothing; owner calls stay in `scripts/` and the council's own signing (no NEAR keys in
    the portal).
- **No NEAR keys.** `admin_register_scope` and contract admin stay in `scripts/`. NEAR calls are read-only: `tx` for
  settlement, `get_scope` for the watcher, `view_access_key` for the nonce check, and (proposed) `get_identity` and
  `get_account` for the Users screen.

## Users and Support ID (staff only; D269, D96, D144)

**Proposed 2026-11-04, to confirm by the user (D275, D276).** Built in build-plan batches C8b (Users) and C15
(Support ID).

D269 keeps each identity's verified address in the email issuer's own D1 (`user_emails`, `user_email_apps`, issuer
migration 0002), for Hana staff only. This section gives staff a Users screen over it and lets the Support ID lookup
reach it. Partners see neither (§What partners never see).

**The wallet directory (D310–D317, D346; merged into `develop`, not deployed).** The API's hot DB keeps each user per
scope with three ids (`end_users`, D346): the **User ID** partners see, the identity token's `sub` (`u1_…`,
`token_sub`); its **Support ID** (`support_code`); and the **internal id** `hu_…` (the ledger's uid, `user_id`, staff
only, D312). Beside it, the account's identities with their subs (`end_user_identities`) and the wallets its logins
reported (`end_user_wallets`), with the read APIs the screens need: `AdminRpc.listUsers` / `getUser` / `findUsers`
(by wallet, User ID, internal id, Support ID or sub; each identity's `directoryKey` is the join with `DirectoryRpc` for
the email) and, for the partner console's Users screen (C10), `ConsoleRpc.listUsers` / `getUser` (the org's own
scopes; `userId` = `u1_…` and `supportId`; never the internal id, a sub or an email; D315, D346; `docs/api.md`). The
Support code is stored and indexed there, so code → user needs neither `IssuerRpc.uid` nor `user_email_apps.uid`
(D276 as amended by D346).

### Data path (D275)

```
staff ─Access─▶ hana-id-admin-<env> ──ISSUER──▶ hana-id-email-issuer-<env>  exports DirectoryRpc (no route)
                      │                            DB (own D1): user_emails, user_email_apps, email_admin_audit
                      ├──API──▶ AdminRpc.userShares, findUsers (C15)
                      └──USAGE_DB──▶ Neon (C15)
```

(D346: code → user goes through the API's wallet directory, `AdminRpc.findUsers`; the issuer's `IssuerRpc.uid` write
and `DirectoryRpc.byUid` that D276 planned are dropped.)

- **`DirectoryRpc`**: a `WorkerEntrypoint` exported by the issuer and bound only by the admin Worker (`ISSUER`). No
  route: the issuer's public `fetch` doesn't change. Its methods are reads. A source test holds its module to
  `SELECT`s on `user_emails` and `user_email_apps` plus its own audit `INSERT`, and to no import of the signer, key,
  challenge or mail modules (the pattern of D251's `APP_DB` test).
- **The issuer checks the staff member itself.** Every call carries the request's Access JWT
  (`Cf-Access-Jwt-Assertion`), and the issuer verifies it with `packages/oidc`: the admin application's `aud`
  (new issuer var `ADMIN_ACCESS_AUD` = the manifest's admin `accessAud`), the team domain, and the email on the
  staff list. The JWT's email is the actor. So a compromised admin Worker can read the directory only while a staff
  member is sending it requests (within that JWT's life), and every read names a real Access identity.
- **Audit before data.** The audit `INSERT` and the read go in one D1 batch, so a failed audit write returns no rows
  (`internal`). Issuer migration 0003 rebuilds `email_admin_audit` with the actions `user_search`, `user_view` and
  `support_lookup` and a `detail` JSON column, keeping its rows. Each row records the staff email, the `ticket`
  (required, 1–64 characters: the support reference or a short reason, as the issuer's staff routes already ask)
  and `detail`. For a search, `detail` holds the filters used, the address term as a 12-character keyed hash (the
  form unlock subjects use) and the row count. For a view it holds `{provider, sub}`, and for a lookup the code.
  Never an address.
- **Row budget.** Each staff email can get 500 identities an hour and 2 000 a day back (provisional constants),
  counted in the issuer's `RateLimiter` object. Over that, the call answers `rate_limited` and logs
  `directory_budget`, and the admin Worker emails the security alias (a Direct kind, §Email). A hijacked staff
  session gets a slice of the directory, not all of it.
- **Not a D1 binding.** A D1 binding is read-write and gives a Worker the whole database. An issuer D1 binding in
  the admin Worker would let a bug or compromise there write `email_hints` (which automatic linking reads, D266),
  `email_suppressions` and the audit, and read without leaving any audit row (D275 has the alternatives).

```ts
// apps/email-issuer, bound only by the admin Worker. Every method verifies accessJwt itself, reads only, audits first.
interface StaffCall { requestId: string; accessJwt: string; ticket: string }
interface DirectoryRpc {
  search(c: StaffCall & { q?: string; provider?: 'email' | 'google'; appId?: string; sub?: string;
                          unverifiedOnly?: boolean; cursor?: string; limit: number /* ≤ 100 */ })
    : Rpc<{ users: UserRow[]; next?: string }>;
  get(c: StaffCall & { provider: 'email' | 'google'; sub: string }): Rpc<{ user: UserRow; apps: UserApp[] }>;
  auditSince(c: StaffCall & { id: number; limit: number }): Rpc<{ rows: DirectoryAuditRow[] }>;
}
interface UserRow { provider; sub; email; emailVerified: boolean; hosted: boolean | null; firstSeenMs; lastSeenMs;
  appCount: number; uids?: { scopeId; uid }[] /* C15 */ }
interface UserApp { appId; scopeId; firstSeenMs; lastSeenMs }
// apps/api, bound only by the email issuer (C15; the same entrypoint D251 plans for the issuer's app lookup).
interface IssuerRpc { uid(c: { scopeId: string; provider: string; sub: string }): Promise<{ uid: string }> }
// apps/api AdminRpc addition (C15): live vault shares of one path in one app (no share ids, no counters).
//   userShares(c: Ctx & { appId; path })
//     : Rpc<{ shares: { createdAt; idleUntil; absExpiresAt; revokedAt: number | null }[] }>
```

### Users screen (`/users`, C8b)

- **Search**: one box plus filters, keyset-paged by `last_seen_ms` descending, 50 a page and at most 100.
  - Address: an exact match (indexed) for a full address. Otherwise a case-insensitive substring of at least 3
    characters (`instr` over the stored lowercase form: a scan of `user_emails`, with its time measured in the
    smoke).
  - Provider (`email`, `google`), app (an app id picked from the apps list, `user_email_apps_app`), sub (exact),
    and "unverified claims only".
  - A `HANA-XXXX-XXXX` code goes to the Support ID lookup.
  - Each result shows the address, provider, verified and hosted flags, app count and last seen.
- **Unverified Google claims** (`provider = 'google'`, `email_verified = 0`) carry the CLI's warning on the row and
  the detail: "UNVERIFIED: this Google account claims the address but Google hasn't verified it; don't treat it as
  the owner". An address search lists them after the verified rows, and they are never the default target of an
  address or code match (D269 review fixes).
- **User detail** (`/users/:provider/:sub`):
  - The directory row: address, provider, sub, `email_verified`, `hosted` (Google-hosted, D158; blank for email),
    and first and last seen. These are the times the issuer saw the identity. Writes are best effort, so a lost
    write leaves a gap.
  - The identity's apps (`user_email_apps`): app name and environment (`AdminRpc.getApp`), scope, and first and
    last seen.
  - For each scope, read live from the chain over the admin Worker's read-only RPC, with the block height shown:
    `get_identity(scope, provider, sub)` gives the status (`own`, `member`, or `pending` with `effective_at_ms`) and
    `opened`. The path is `{scope}#{provider}#{sub}#0` for `own` (key_index 0 in the MVP, D8). For `member` it is
    the account root's path, with a link to the root's directory row when there is one, and `get_account` lists
    the members. A failed read shows "chain unavailable", never a guessed path.
  - No wallet address from the issuer's directory. Since D310 the wallet directory holds the proven addresses: the
    detail shows them per scope from `AdminRpc` (with the User ID, Support ID and internal id, D346).
  - For each scope, the Support ID and its activity (§Support ID lookup, from C15).
- **No CSV export** (D275). Bulk reads stay with the CLI (`admin user:list --json`, for founders with wrangler
  credentials, printed to the terminal only). The screen has no "select all".
- **Access**: the admin Worker's Access check and staff list (§Hana admin console), plus the issuer's own JWT check.
  The admin audit view adds the issuer's rows (`DirectoryRpc.auditSince`) as a third source beside `queryAudit` and
  `changesSince`, filterable by staff and action. Directory reads never go into the partner feed, and they aren't
  emailed except for the budget alert.

### Support ID lookup (C15, D276)

- **The code (D346).** `HANA-` + `c[0..4]` + `-` + `c[4..8]`, where `c` is the Crockford base32 (alphabet
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, most significant bit first) of the first 5 bytes (40 bits) of the identity
  token's `sub` HMAC: the 16 bytes the User ID `u1_…` encodes (`IDENTITY_SUB_KEY`, `hana-id/idt-sub/v1`,
  `docs/identity-token-spec.md`). Uppercase, no padding. The parser accepts lowercase, `O` for 0, `I` and `L` for 1,
  and missing dashes. No new secret, domain string or table (D96, D144): it is the User ID's short form, and anyone
  holding a User ID (the partner's backend) can compute it without a key. It is per scope and per account: it comes
  from the account root, so a linked member gets its root's code, and every app of a scope shows the same code. Code
  `console-core` `supportIdOf(userId)`; stored as `end_users.support_code`.
- **Shown to the user and the partner** (planned, not built). The API returns `supportId` next to the session in the
  `/v1/login` and `/v1/sessions` answers, computed from the path's root with `supportIdOf(identitySub(…))`, the same
  code as the directory's. The vault keeps it with the session and exposes it in `hana_status` (so the partner page's
  *Copy diagnostics* carries it), the Hana popup's account view and, later, Hana Home. It carries no address and no
  sub. The partner console shows it beside the User ID (`ConsoleRpc`, D346).
- **Staff: code → user (D346).**
  1. The wallet directory: `AdminRpc.findUsers({query: code})` over `end_users.support_code` (indexed, D312), which
     gives the User ID, the internal id `hu_…` (the ledger's uid, for the activity below) and each identity's
     `directoryKey` for its address. No issuer `uid` column or `IssuerRpc.uid` is needed.
  2. Without a directory row (a user who hasn't logged in since the directory's deploy, or a lost write), the code
     can't be resolved: it is no longer a prefix of a ledger uid. Staff ask the partner for the User ID (`u1_…`) or a
     wallet address, which `findUsers` also takes.
  3. Every match is listed; two identities can share 40 bits (about 45 pairs among 10 M identities). The app named
     in the partner's escalation tells them apart. A code isn't a credential: staff change nothing on a code alone.
- **Staff: address → user**: the Users search, then the detail's Support ID.
- **What the lookup shows for a uid**, all from data Hana already keeps (D144):
  - Logins and sessions: the ledger's ok `login`, `session` and `derive` events by uid (the same migration
    adds `events (uid, at) WHERE uid IS NOT NULL`). They show the time, app, endpoint, latency and `near_tx` (an
    explorer link), over the last 30 days by default and at most 400.
  - Live sessions: `AdminRpc.userShares` over `vault_shares` by `(app_id, sha256(path))`, for persistence apps.
  - Errors: by the request IDs the escalation gives (`usage.events` by `request_id`, every outcome with its
    `code`). The ledger keeps uids only on ok events (its CHECK), so it can't list errors per user, by design.
  - The app's policy and setting changes (`app_changes`). Consents aren't shown: they live only in the vault's
    browser storage (D23).
- **Partner side**: the User ID and its Support ID (the Users screen, D346), never the internal id. The partner
  console's Users search takes a Support ID or a User ID for the org's own scopes; there is no activity lookup in
  batch C; partners escalate with the code (or the User ID) and request IDs (D96).
- **Retention.** C15 keeps the audit rows, 5 years (D90). A code resolves while its `end_users` row exists; the
  activity behind it while the ledger holds the uid: 24 months after the month ends, and while `app_users` keeps the
  row (D90). D269 sets no expiry for the directory itself (its `K_sub`-loss reason argues for none). An erasure request
  deletes the identity's directory rows with a CLI command (`user:erase`, beside `uid:erase`, through D1's REST API
  as the operator), so `DirectoryRpc` stays read-only.

### What partners never see

- **Partner console**: no binding to the issuer, `DirectoryRpc` or `IssuerRpc` (config snapshot). No `ConsoleRpc`
  method returns a directory field, and the screens show aggregates only (§User lists).
- **SDK**: `hana_status`, `hana.account()`, events and errors carry no address (the Support ID, yes).
- **API**: no binding to the issuer's D1 and no route that reads it. A user-approved share to a partner (the
  identity token's opt-in email claim, D120 steps 5–6) is later work with its own consent UX, not part of this.
- **Emails to partner contacts**: the feed has no directory rows.

## Usage capture and reporting

### Capture (API Worker; nothing before the response)

- **UsageEvent v1**, for requests that passed `appGate` on `/v1/login`, `/v1/sessions`, `/v1/derive`,
  `/v1/sessions/revoke` and `/v1/vault/unlock`, and for `/v1/owner-actions` after the owner check:

  ```ts
  { v: 1, request_id, at_ms /* request start */, org_id, app_id: string | null, scope_id,
    endpoint: 'login' | 'session' | 'derive' | 'revoke' | 'unlock' | 'owner_action', outcome: 'ok' | 'rejected' | 'error',
    code: string | null, status, latency_ms, relayed: boolean, near_tx?, relayer_pk?, relayer_nonce?: string,
    relay_gas_burnt?: string, relay_tokens_burnt_yocto?: string, uid?: string /* b64url 16 bytes */ }
  ```

  Never a sub, JWT, email, IP, session key or share id. Gate rejections and `GET /v1/app` aren't recorded (logs only).
  The relay result gains the signing key's public key and nonce (the `RelayerKey` DO already has both).
- **Write:** `ctx.waitUntil(recordUsage(env, e))` opens a Hyperdrive connection and calls `usage.record_event`. On a
  connection error or timeout it retries once after 250 ms with the same event (same `request_id` and `at`, so a
  duplicate is ignored); never on a validation error (`usage_write_rejected`). After the second failure it logs
  `usage_write_failed {requestId, appId, endpoint}`. Without the binding nothing is sent. This replaces
  `countUsage`/`incrementUsage` and the D1 `usage` counters (`unlocks` included).
- **Gas.**
  - Billed gas of a transaction is the BigInt sum of `gas_burnt` (and `tokens_burnt`) over `transaction_outcome` and
    every `receipts_outcome`, read with `tx` at `wait_until: 'FINAL'`. The relay answers at `EXECUTED_OPTIMISTIC`
    (not final, refunds not included), so relay-time figures are only provisional and settlement gives the billed
    figure.
  - `FinalOutcome` gains typed `transaction_outcome.outcome` and `receipts_outcome[].outcome.{gas_burnt,
    tokens_burnt}`; sums use BigInt (`apps/smoke/src/near.ts` sums Numbers and is not the model).
  - `relayed = near_tx present AND code ≠ 'relayer_busy'`:

    | Result | `relayed` |
    |---|---|
    | `ok`, `contract_rejected` (a rejected call burns about 2.2 Tgas) | true |
    | `timeout`, `near_error` with a `near_tx` | true |
    | `relayer_busy` (invalid nonce, or dropped twice: it can never execute) | false |
    | `near_rejected`, `near_unavailable`, `relayer_unavailable`, `relayer_unconfigured`, `method_not_allowed` | false |
    | any refusal before the relay, and `unlock` | false |
- **uid** (§Nonce layouts): computed from the path the request already has (`/v1/login`'s path, `create_session`'s
  `SessionView.path`, derive's `getSession().path`): strip the known `${scope_id}#` prefix, require exactly 3
  `#`-separated parts, drop `key_index` (rotation is not a new user). Only on ok `login`, `session` and `derive`.
  `USER_ID_KEY` is a 32-byte secret per env on the API only, kept in `.secrets/<env>/` (0600) with an offline backup,
  never logged; not rotated within a contract term (v1 leaves room).

### Settlement (admin, every 15 min)

Relayed events from the last 3 days without a `gas_settlements` row (≤ 500 per run) get `tx` at FINAL; the row is
written with `result = 'final'` and the sums (`INSERT … ON CONFLICT DO NOTHING`). After 24 h without a final result
it is written as `unsettled` and counted on the statement, never estimated. Non-archival RPC keeps about 2.5 days.

As built (C12; D321, D322): an event is billed only for **its own transaction**: its `near_tx` carried by no other
relayed event (a duplicate bills neither, also when the report reads it: `usage.classified`), its `relayer_pk` one of
the env's pool keys, and the transaction at FINAL signed by the relayer account with that key at that nonce, to the
signer contract; anything else is `unsettled` with a `reason` (`duplicate_tx`, `signer_mismatch`; `not_final` after
24 h) and an alert to the security alias. The queue is every relayed event without a settlement row, of any age,
oldest first, within the run's 40-call budget (D280), each not-yet-final transaction read at most once an hour.

### Rejection-rate check (admin, 00:30 UTC; D91)

For the previous UTC day, `usage.rejection_rates` gives each org's relayed attempts and relayed-then-rejected ones.
An org with ≥ 100 relayed attempts and a rejected share above 5% (provisional, a constant until real traffic sets
it) gets one `ops.rejection_alerts` row and one `rejection_rate` email to the security alias, and shows in the admin
security screen. The partner isn't billed for it by default (D91); the service contract may bill partner-caused
rejections above the threshold.

### Daily nonce cross-check (admin, 00:30 UTC; D34)

For each relayer key (`AdminRpc.relayerKeys`, both pools): read `view_access_key` at `finality: final`; its nonce N
is the nonce of the key's last landed transaction. Every API relay writes a ledger row with `(relayer_pk,
relayer_nonce)`, so:

- N unchanged since the last check: idle, explained.
- A relayed row with `relayer_nonce = N` exists: explained.
- Otherwise: `nonce_unexplained`, emailed to the security alias at once. Either a usage write was lost, or something
  other than the API signed with a relayer key (a leaked key).
- As built (C12, D323): a key's first check when the ledger has no relayed row of that key is its baseline
  (explained, as the watcher's first sight, D282).

The check also records the ledger's relayed rows since the last check against `N − N_prev` (shown, not alerted: nonce
reservations skip up to 99 nonces per cold start, D21). It proves the newest transaction of each key is billed and
detects foreign use that ends a day; it doesn't prove that no row in the middle of a day is missing. A missing row
under-bills Hana; it never over-bills a partner. Confirmed as read, daily, no indexer count (D93).

### Reports (on demand; admin for any org, partners for their own)

`usage.org_report` groups by `date_trunc(by, at AT TIME ZONE 'UTC')` and app (owner actions by scope), over
`usage.events e LEFT JOIN usage.gas_settlements g USING (request_id)`:

```sql
count(*) FILTER (WHERE endpoint IN ('login','session') AND outcome = 'ok')            AS logins,
count(*) FILTER (WHERE endpoint = 'derive' AND outcome = 'ok')                         AS derives,
count(*) FILTER (WHERE endpoint = 'revoke' AND outcome = 'ok')                         AS revokes,
count(*) FILTER (WHERE endpoint = 'unlock' AND outcome = 'ok')                         AS unlocks,
count(*) FILTER (WHERE endpoint = 'owner_action' AND outcome = 'ok')                   AS owner_actions,
count(DISTINCT uid)                                                                    AS active_users,  -- MAU by month
percentile_disc(0.5)  WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE endpoint = 'login'  AND outcome = 'ok') AS login_p50_ms,
percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE endpoint = 'login'  AND outcome = 'ok') AS login_p95_ms,
-- same for derive
sum(g.gas_burnt)    FILTER (WHERE g.result = 'final')                                  AS gas,          -- + by outcome
sum(g.tokens_burnt) FILTER (WHERE g.result = 'final')                                  AS burnt_yocto,  -- + by outcome
count(*) FILTER (WHERE e.relayed AND (g.request_id IS NULL OR g.result = 'unsettled')) AS unsettled
```

- Failures by code: the same groups over `outcome <> 'ok'`, by `code`.
- `percentile_disc` is exact nearest-rank. Latency is server latency of ok requests.
- New users: `app_users` rows whose `first_seen` falls in the period.
- USD per day: `round(burnt_yocto(day) × usd_micros(day) / 10^24)` (numeric, half away from zero); a period's USD is
  the sum of its days; testnet figures are valued at the mainnet price and labelled. Amounts are the **gross**
  `tokens_burnt` paid by the relayer; the 30% function-call reward credited to the signer isn't netted off.
- The gas split: relayed ok (paid), rejected but relayed (paid, for example third-party replays of public signed
  derives), refused before relay (no gas), and error (a settled timeout or `near_error`).
- Uids are stripped 24 months after a month ends (D90), so MAU for older months comes from the frozen statements.
- Partners see only their org (the function filters by `org_id`); `ConsoleRpc.usage` refuses ranges over 400 days or
  more than 100 apps and is rate-limited per member.

### Monthly statements (frozen)

- **Issue** (`POST /api/statements/:org/:month/issue`, staff), allowed from the 3rd of the next month 00:00 UTC once no
  relayed event of the month lacks a settlement and every day has a rate. The admin Worker computes the rows with
  `received_at <= as_of` (`as_of` = now), renders the CSV and a PDF (`pdf-lib`) of the same totals that prints the
  CSV's sha256 (the statement hash, D92), uploads both to `STATEMENTS` under new keys, then inserts
  `usage.statements` with both sha256s and the totals. The insert
  is the commit point: the PK refuses a second statement for the org and month. It is audited (`statement.issued`)
  and the feed emails the security contacts and `billing_email` with the CSV's sha256.
- **Late events** (`received_at > as_of`, an event delayed past the issue) stay in the ledger and show in the admin
  report as "after statement" for that month; Hana handles them under the service contract. Nothing is recomputed.
- Partners download the same files read-only from the console (`STATEMENTS`, `get` only) with the sha256 beside them.
- **On-screen statement** (console and admin, D92): rendered from `usage.statements.totals`, the same numbers as the
  CSV and PDF, with the statement hash. A test renders all three from one statement and compares the totals.
- **Rejected gas (D91)** is its own line on all three (Tgas, NEAR, USD), marked "not billed" by default; the billed
  line excludes it unless the service contract says otherwise.
- **Tax invoices** come from the accounting software and quote the statement (org, month, hash); Hana ID issues none.
- **CSV:** RFC 4180, UTF-8, LF, decimal strings. Injection guard: a cell matching `^-?\d+(\.\d+)?$` is left as is; any
  other cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`. Rows: one per app per day, then one per
  scope per day for owner actions (`app_id` empty), then one total per app and per scope (`day = total`, MAU on app
  totals). Columns:

  `month,org_id,org_name,scope_id,app_id,app_name,environment,day,logins,derives,revokes,unlocks,owner_actions,link_actions,identity_tokens,mau,new_users,failures_by_code,tgas,relayed_rejected_tgas,error_tgas,near,relayed_rejected_near,near_usd_rate,rate_source,usd,relayed_rejected_usd,login_p50_ms,login_p95_ms,derive_p50_ms,derive_p95_ms,unsettled,as_of`

  (`link_actions` and `identity_tokens` added in C12, D324: the email login's link relays and the identity tokens
  minted, D223.)

  `tgas` is all settled gas of the row (ok + rejected + error) as an exact decimal of Tgas; `relayed_rejected_tgas`
  and `error_tgas` are parts of it; `near` is all settled `tokens_burnt` as exact NEAR; `failures_by_code` is
  `code=n;…` sorted by code.
- **Ledger CSV** (on demand, console or admin; admin exports go to `EXPORTS`):
  `request_id,at,org_id,scope_id,app_id,endpoint,outcome,relayed,near_tx,gas_status,gas_burnt,tokens_burnt`, where
  `gas_status` is the settlement's `final`/`unsettled`, or `pending`/`none` without one. Summing its `final` gas for
  the org and month with the same `as_of` gives the statement's `tgas` and `near` exactly, owner actions included.
  Every charge can be checked on chain at FINAL.

### User lists

Superseded by D310 and D346 (2026-11-04): partners get a **Users screen** (C10) over `ConsoleRpc.listUsers` /
`getUser`, for their own org's scopes only. Each user shows its **User ID**, which is the identity token's `sub`
(`u1_…`, the value the partner's backend already stores, like Privy's DID), its **Support ID** `HANA-XXXX-XXXX` (the
User ID's short form), created and last seen, the connected account kinds ("Google", "Email") and the wallet
addresses, each proven by its own key and the session key (D311). The search takes a wallet address, a User ID or a
Support ID. Never shown: the internal id `hu_…` (the ledger's uid, staff only), a sub, an identity key or an email
(the email only once a user approves, UX later). Hana staff get the Users screen over the email issuer's directory
and the wallet directory (D269, D275; §Users and Support ID), with all three ids.

## Audit

- **`app_changes` (hot DB) is authoritative for every app, origin, setting, key, suspension and scope change**,
  whoever made it (console, admin, CLI, cron): one row per applied write, in the same batch (CAS above).
- **`audit_log` (console) records console-side events:** sign-in, refusal, logout, invite accept/refuse/expire,
  member and org-policy changes, every step-up (with `step_up_id`), owner actions (with `near_tx`), and the outcome of
  each console-initiated RPC (`ok`/`failed`) written after the RPC returns. Invite issue and revoke are written by
  `StaffRpc` with the Hana actor.
- If the console dies between an RPC and its audit row, the change is still in `app_changes`; the console's and the
  admin's audit views merge both sources by `request_id`. There is no write-ahead row and no reconciler.
- Owner actions sent to `/v1/owner-actions` directly (not through the console) appear in the ledger and the watcher's
  emails, not in `audit_log`.
- **Allowlist:** `details_json`/`detail_json` hold allowlisted fields only; tokens, secrets, cookies and full IPs are
  never written.
- **Tamper evidence:** the append-only triggers, D1 Time Travel (30 days), Neon point-in-time restore, the R2 bucket
  lock and partner-held statement hashes. Not cryptographic; no hash chain in the MVP (D93).

## Email (one channel: the admin Worker)

- **Provider (D87):** Resend, from a dedicated sending subdomain of the Hana domain (`email.from`) with SPF, DKIM and
  DMARC. Code calls a small `EmailSender` interface (one message in; accepted with the provider's id, or an error),
  with a Resend adapter and a test fake; switching provider (e.g. to Postmark) is a new adapter. Only the admin Worker
  holds `EMAIL_API_KEY`; the governance watchdog has its own key.
- **Blocking (fails closed):** `change_pending` for every guarded change, to the security alias and the org's security
  contacts, with the cancel link. The change's clock starts only after every send is accepted. Likewise
  `member_invite` (the link to the invitee; the notice to every owner, the security contacts and the alias) and
  `owner_grant` (every owner, the contacts and the alias, with the cancel link): the invite works, and the grant's
  24 h starts, only after every send is accepted (§Invites and owner grants).
- **Feed (best effort, at least once):** the 5-minute cron walks `AdminRpc.changesSince`, `StaffRpc.auditSince`
  and `AdminRpc.securityEvents` from cursors in `ops.state` and emails the security contacts (and the alias for
  security events): origin and policy removals, raw signing off, cancels, activations, expedites, suspensions and
  resumes, key create/rotate/revoke, settings, name and logo changes, member and role changes, scope assignments,
  security contacts changes (to old and new contacts), refused sign-ins in bulk once per hour, statements issued. A
  cursor advances only after a row's sends are accepted; the admin console shows the lag.
- **Watcher:** `scope_pending_change`, `scope_changed` (§On-chain owner actions).
- **Direct:** `nonce_unexplained`, `rejection_rate` (D91), `retention_failed` (D90), and (proposed, D275)
  `directory_budget`, to the security alias. The invite
  link (`<console.origin>/invite#t=…`) goes in the blocking `member_invite` send.
- Plain text plus simple HTML, no remote images; links only to `console.origin`; never approve links.

## Response headers

- **Console and admin** (every response, assets included, since the Worker runs first): `Content-Security-Policy:
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: <files.origin>; connect-src 'self';
  font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `X-Content-Type-Options: nosniff`,
  `Strict-Transport-Security: max-age=63072000; includeSubDomains`. No third-party scripts.
- **Console auth origin:** the stricter CSP and `no-store` above.
- **Files origin (logos):** `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
  default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Disposition: inline;
  filename="logo.png"`, `Cache-Control: public, max-age=31536000, immutable`, `Referrer-Policy: no-referrer`; no
  cookies; only GET and HEAD.

## Manifest (`packages/env`)

```jsonc
"appChangeDelayMs": 86400000,                          // required: 60 000 … 7 d; ≥ 24 h on a production network
"console": {
  "workerName": "hana-id-console-<env>", "d1Name": "hana-id-console-<env>",
  "origin": "https://console.<domain>",
  "authWorkerName": "hana-id-console-auth-<env>",
  "authOrigin": "https://auth.console.<domain>"        // redirect URI = authOrigin + "/callback"
},
"files": { "workerName": "hana-id-files-<env>", "origin": "https://files.<domain>",
           "logosBucket": "…", "statementsBucket": "…", "exportsBucket": "…" },
"admin": { "workerName": "hana-id-admin-<env>", "origin": "https://admin.<domain>",
           "accessTeamDomain": "<team>.cloudflareaccess.com", "accessAud": "<aud tag>",
           "staffEmails": ["…"] },                     // lowercased, non-empty
"usage": { "neonRegion": "aws-ap-southeast-2", "writerHyperdrive": "hana-id-usage-writer-<env>",
           "adminHyperdrive": "hana-id-usage-admin-<env>" },
"email": { "from": "Hana ID <no-reply@mail.…>", "securityAlias": "security@…" },  // sending subdomain (D87)
"ownerGrantDelayMs": 86400000                          // D89; = appChangeDelayMs (60 000 on sandbox-dev)
```

- All origins are distinct from each other, from `vaultOrigin`, `authOrigin` and `apiUrl`; `https` outside
  `local*` envs.
- `appChangeDelayMs` replaces batch B's raw-sign/policy delay rule (24 h, or `changeDelayMs` in dev envs) for the API
  and the CLI; sandbox-dev uses 60 000 (its `changeDelayMs`). On a production network `changeDelayMs ≥
  appChangeDelayMs` (a refinement, added with the mainnet network value); production `changeDelayMs` is 24 h (D93).
- `console`, `files`, `admin`, `usage` and `email` are present together or not at all (guarded changes need the
  admin notice; the console needs the files origin), so an env without a dashboard still validates and deploys the API.
- `gen-wrangler` emits every Worker config and `.dev.vars` placeholders; for the API `APP_CHANGE_DELAY_MS`, `NETWORK`,
  `FILES_ORIGIN` and `REFUSED_ORIGINS`. Hyperdrive and D1 ids are flags, never committed. Secrets come only from
  `.secrets/<env>/`.

## CLI (`scripts/admin.ts`)

| Command | Change |
|---|---|
| `app:create` | Needs `--org`. Writes `scopes` (refusing another org or environment), issues `pk_test_`/`pk_live_` by environment, writes origins as staff proposals (`active_from` NULL) with `app_changes`, exactly like `AdminRpc.createApp`; `no_session` waiver only if it created the scope row |
| `app:origins:add` | A staff proposal: `guarded_changes`, `app_origins` (`active_from` NULL), `app_changes`, version bump. Never sets `active_from`; the admin Worker announces it |
| `app:settings` | `--raw-sign approval` and a new `--auto-approve` policy become staff proposals (announced by the admin Worker, delayed by `appChangeDelayMs`); `off` and the other settings are immediate; all with `app_changes` |
| new `app:changes:announce <id>` | Only for an env with no `admin` block; refused on a production network. Sets `notified_at`/`active_from` and writes `app_changes` with `detail: {channel: "cli", emailed: "none"}`; prints that nobody was emailed |
| `app:origins:remove`, `app:suspend`, `app:resume` | Immediate, with `app_changes`; suspension writes bit 1 |
| `app:list` | Shows pending changes, keys, `suspended_by` |
| `scope:register` | Gains `--owners-from-org <org>` (reads the owners' subs from `CONSOLE_DB`) |
| new `owner:relay --body <file>` | The staff relay runbook: dry run, `--yes`, never prints the JWT |
| new `uid:erase --scope --provider --sub` | Recomputes the uid with `USER_ID_KEY` from `.secrets/`, calls `usage.erase_uid` as `usage_admin`; never prints the key |
| proposed `user:erase --provider --sub` (D276) | Deletes the identity's `user_emails` and `user_email_apps` rows in the issuer's D1 through D1's REST API as the operator (the `user:*` path); asks for the ticket; prints no address |
| new `usage:setup`, `usage:migrate`, `usage:legacy-export` | Neon roles and Hyperdrive configs from `.secrets/`; Neon migrations; the one-off export of D1 `usage` |

The `app:*` commands are removed once the admin console covers them after the pilot; `scope:register`,
`owner:relay`, `uid:erase`, `usage:*` and contract admin stay.

## Security model

Trust boundaries, most to least trusted:

1. The Cloudflare account (members, API tokens, D1 write access; any Worker in it can bind `AdminRpc`) and the Neon
   project's owner role.
2. The API Worker.
3. The admin Worker (Access: GitHub team with org 2FA).
4. The console Worker: trusted for everything the API doesn't verify itself.
5. The partner browser.
6. Email.

| Threat | What it gets | Controls | Residual |
|---|---|---|---|
| XSS on the console origin | Requests with the victim's session: reads, kill switches, settings proposals for step-up | CSP `'self'`; no JS origins on the console client; script-free auth origin that never redirects without `state` and `code` and ends Locations with `#`; server-chosen nonces; the vault on another origin | It can submit its own action and phish one Google click; then the API's change binding, the blocking notice, the delay and `app_changes` protect |
| Stolen console cookie | As XSS, from elsewhere | HttpOnly, Strict, 2 h idle / 12 h absolute; fresh sign-in per security-critical change; the breaker | DoS by kill switches, recoverable through the delay (origins, policy) or a new key |
| Phished Google password of a member (no 2SV), or a hijacked Google session | Console access as that member, and fresh sign-ins | `required_hd` per org; invites only; the delay and blocking notice on guarded changes; the watcher; the breaker | **No second factor** (passkeys deferred): the console is as strong as the member's Google account. For an on-chain owner this also gives owner-action and guarded-change tokens. Accepted for the single-partner pilot only (§Deferred) |
| Hijacked live Google session of an on-chain owner | Owner tokens with any nonce, outside our console | The contract timelock, cancel by any owner, the watcher's emails; guarded changes need the notice and delay | It can cancel its own removal (`docs/governance-spec.md` open question 17). Immediate `remove_client`/`disable_shared_login` give a DoS on its own scope; per-scope caps limit spam; the safety budget is separate |
| Compromised console Worker | It chooses the nonce at every sign-in, so it can mint owner-action and guarded-change tokens from a routine sign-in; show A and request B; call every `ConsoleRpc` the API doesn't verify; overwrite logos; read every org's usage | The API verifies guarded changes against on-chain owners and the exact change; their clock starts only after the admin Worker's notice to security contacts the console can't edit; the watcher emails every on-chain change independently; the timelock; console audiences are clients of a sink scope only; the breaker; Hana clears suspension bits; `app_changes`; logos are re-checked by the files Worker and served sandboxed; statements are bucket-locked | Someone must read the notice and cancel within the delay (≥ 24 h on mainnet). Kill switches up to the breaker limits are a DoS; removed origins and policies come back only through the delay; revoked keys need a new key |
| Compromised Hana staff account | Staff powers | Access with GitHub team + org 2FA and the staff allowlist; staff proposals always get the full delay and notice; staff can't move a scope out of a real org; owner checks in `createApp`/`assignScopeOrg`; staff proposals refused for `appChangeDelayMs` after a move; expedite only for member proposals; everything in `app_changes` and the feed | Social engineering of expedites (reason names the confirming contact). A staffer can set an org's security contacts, notified to old and new contacts |
| Insider with Cloudflare account, D1 write or Neon owner access | Insert active origin rows or policies, drop triggers, edit contacts or ledger rows | Drift detection; partner-held statement hashes; R2 bucket lock; Neon PITR | The trust root is account hygiene. Not cryptographic |
| Leaked relayer key | Burn its allowance; relay pool methods | Contract allowlists (D19); the nonce cross-check flags its transactions when they end a day | Mid-day foreign use isn't flagged (accepted, D93) |
| Mail scanners | Fetch links | A GET never cancels; no approve links | — |
| Lookalike origins | An IDN homograph passes human review | ASCII-only storage; `xn--` flagged with the decoded form; mixed-script refused on live scopes | Same-script confusables rely on the reader |
| Malicious logo upload | Script on a Hana origin; brand impersonation in popups | Type by magic bytes, SVG banned, re-encoding, a separate files origin with `sandbox` CSP and `nosniff`; logo changes in the feed | Impersonating another brand's logo is caught only by review of the feed |
| Replay of a public on-chain owner token | Login or a step-up | Random server-held login nonces; domain-separated layouts; token reservation | — |
| Cross-environment replay | — | `env` and the signer in every digest | — |
| Usage inflation | Billable-looking usage | Only post-gate events; plan `per_day`; the splits | Relayed-rejected gas is real cost, borne by Hana by default (D91); the rejection-rate alert |
| Re-identifying users from `uid` | Linking uids to paths | Keyed HMAC on the API only; stripped after month + 24 months (D90); no partner user list; the writer role can't read the ledger; (proposed, D276) the directory's stored uid is reached only through `DirectoryRpc` with a staff JWT, and the API's `IssuerRpc` is bound only by the issuer, which can't read the ledger | Hana, holding the key, can always re-identify within 24 months; a key leak re-links uids; staff can go from an address to ledger rows by design (D269) |
| Reading the user directory (proposed, D275) | Every user's verified address joined to its public `sub` and so its on-chain activity (D269's accepted cost) | Only the admin Worker binds `DirectoryRpc`; the issuer verifies the staff Access JWT itself; each read audited in the issuer's D1 in the same batch; a per-staff row budget with an alert; no export route; no D1 binding outside the issuer | A compromised admin Worker reads what staff requests it sees, within a JWT's life, up to the budget; a staff member can read up to the budget, audited; Cloudflare account members can read the D1 directly (trust root) |
| Hijacked owner account adds a co-owner | A second owner identity in the org | Fresh sign-in per invite; blocking notice to every owner and security contact; 24 h as a viewer with cancel by any owner, Hana or the link (D89) | Someone must read the notice within 24 h; console ownership alone isn't on-chain ownership |
| Dashboard load or bug | Logins | Separate Workers and databases; RPC-only access; bounded hot-DB budget; usage writes after the response; Neon failure is a logged no-op | RPC runs in the API's isolate (logical, not physical, isolation) |

## Trade-offs accepted

| Trade-off | What it costs | Mitigation |
|---|---|---|
| No second factor for partner members (passkeys deferred) | A phished or hijacked Google account of a member is full console access; of an on-chain owner, also guarded-change and owner-action tokens | Blocking notice and delay on everything that widens access; the watcher; `required_hd`; a hard gate: no second partner org before passkeys ship (§Deferred) |
| Two roles only | No "developer" who can work without owner powers; every operator is an owner or a read-only viewer | Viewers for read access; staff proposals for non-owner needs |
| One notice channel (admin Worker) | Owners hear about changes only as security contacts; the notice depends on Hana staff keeping contacts current; up to 5 min more per change; no notice (and no new change) while the admin Worker or email is down | Contacts default to every owner; the admin console flags owners missing from contacts; fail closed is the point; removals don't wait |
| Single-owner orgs depend on Hana for same-day changes (no second-owner approval) | A 24 h wait unless Hana expedites | The `no_session` waiver for new scopes; the simplified expedite |
| No Hana restore of revoked keys or removed origins | A malicious mass revocation or removal costs the partner a new key deploy and a 24 h wait for origins | The breaker (5 per org per hour); the feed shows it at once |
| Direct usage writes (no queue) | Events are lost when Neon is unreachable for both tries or the isolate dies first; nothing replays them | Retry once; `usage_write_failed` logs; the daily nonce cross-check; losses under-bill Hana, never over-bill partners |
| On-demand reports, no rollups or close | Report cost grows with the range; late events after a statement are handled by hand | Monthly partitions and indexes; 400-day range cap; statements freeze `as_of` |
| No adjustments | Corrections aren't machine-recorded on statements | Handled under the service contract; the ledger stays the record |
| CAS instead of write-ahead audit and a reconciler | The console's `audit_log` can miss the outcome row of an applied change | `app_changes` is authoritative and always written with the change; views merge by `request_id` |
| Fixed 24 h key grace | Partners can't choose a longer overlap | Revoke and re-create if they need a different timing |
| No partner request queue | Apps are requested by email or call | Hana creates apps from the admin console |
| No secret keys | No server-side partner API | None needed in batch C (no `/v1` endpoint takes one) |
| A new owner waits 24 h (D89) | A partner's new co-owner can't act as owner the same day | Viewer access at once; Hana staff can add members directly |
| Stale `apps.status`/`publishable_key` columns kept | Schema clutter; a future reader could trust them | Triggers keep `status` in step; a test fails if code reads `publishable_key` |
| We own security-critical auth code (OIDC client, sessions) | Bugs are ours | The test list; the external audit; no passkey code yet |
| A console client secret | One more secret | Worker secret, kept only in `.secrets/` |
| Google down = console down | Partners can't manage apps | End-user logins are unaffected; staff use the admin console |
| Guarded changes depend on on-chain owners and NEAR RPC | Fail closed when RPC is down | Removals still work; staff proposals for NEAR-only scopes |
| Staff proposals skip owner sign-in (a power the CLI has today) | Staff can propose any guarded change | Full delay, blocking notice, refused after a scope move |
| The `no_session` waiver relies on the API seeing the first session | `create_session` can be called on the contract directly | Such sessions still needed an allowed origin or the partner's own client; staff get the waiver only on a scope the same call created; waived changes are still notified |
| Settlement calls `tx` per relayed transaction | RPC load at scale | Bounded batches; revisit at scale (D93) |
| `USER_ID_KEY` is a single point | Losing it breaks new-user continuity; a leak re-links users | Offline backup; API-only; never logged |
| `app_users` is a lasting pseudonymous per-user record | Needed for new-user counts | Deleted with the app + 30 days; `uid:erase` |
| (Proposed, D275) Directory reads through an RPC on the issuer, which holds the signing keys and `K_sub` | More code in the key-holding Worker; the issuer deploys before the Users screen | No route; a source test holds the module to directory reads and forbids key-module imports; additive methods |
| (Proposed, D275) No CSV export of users | Staff can't hand a list to anyone from the console | `admin user:list --json` for founders, terminal only |
| (D346) The Support ID is 40 bits of the identity token's `sub`, the partner's User ID | The partner can compute it from the `sub` it stores; rare collisions; a code resolves only through a wallet-directory row (no ledger fallback) | No address or sub in it; every match listed; staff act on nothing by code alone |
| uid is per scope | Two apps in one scope share pseudonyms | Same partner, same wallets |
| MAU counts only login, session and derive events | A user whose only activity in a month is unlocking a share made the previous month isn't counted | Shares live ≤ 23 h 50 min, so only month-boundary users are missed; stated on the statement |
| Statements are gross | The signer's 30% gas reward isn't netted | Stated on the statement |
| Seven Workers instead of three | More to deploy | The four extra are thin, bindingless origin Workers (D66); RPC additive-only; the API deploys first |
| Ledger in a second provider (Neon) | Another account, region and failure domain | Off the login path; PITR; least-privilege roles; Sydney for the Privacy Act (D73) |

## Deferred (with what each deferral gives up)

- **Mandatory passkeys for partner members.** Gives up a second factor on console sign-in and on every fresh
  sign-in (presence, phishing resistance). **Required before a second partner joins:** `StaffRpc.issueInvite` with
  `newOrgName` and `kind = 'partner'` refuses `passkeys_required` while a partner org already exists and the build's
  `PASSKEYS_SHIPPED` is false (`org_legacy` and `internal` orgs don't count). The draft's WebAuthn design (enrol via a
  consumed invite, salted per-action challenge, reenrol invites with an out-of-band check) is in git history.
- **Second-owner approval of guarded changes.** Gives up a two-person rule on the partner side; a single owner's
  change goes live after the delay unless someone cancels. If it ships, the API itself enforces approver tenure (an
  approver first seen on chain at least `appChangeDelayMs` ago, from a hot-DB `scope_owner_seen` table) and the
  layout `hana-id/change-approve/v1` is reserved.
- **Hana restore of revoked keys and removed origins.** Gives up same-day recovery from a malicious or mistaken
  revocation or removal (see Trade-offs).
- **Partner app-request queue.** Gives up self-service app requests and their review trail in the console.
- **Secret keys** (`sk_…`). Gives up server-to-server partner auth; needed only once a `/v1` endpoint accepts them
  (and for D48's backend-signed raw requests).
- **R2 and Analytics Engine copies.** Gives up the monthly R2 export of the audit log and `app_changes` (off-Cloudflare
  tamper evidence beyond Time Travel and PITR) and the AE operational metrics with their sampled cross-check.
- **Stripe, plans, invoicing.** Billing stays manual under the service contract (D31).
- **Dropping `apps.status` and `apps.publishable_key`.** Needs rebuilding `app_origins`, `vault_shares` and legacy
  `usage` without their `ON DELETE CASCADE` first; no gain in batch C.

## Rejected (don't reopen without new facts)

- **A third-party auth service** (Supabase Auth, Clerk, Auth0, WorkOS): the Google token is the on-chain owner proof,
  and another token issuer could impersonate owners (D75).
- **Cloudflare Access for partners:** no self-service invites, branding or on-chain proofs; per-seat cost past 50.
- **GIS in-page sign-in, or the browser computing nonces.**
- **Stateless JWT sessions; a 30-minute idle timeout; 12 h idle / 7 d absolute.**
- **One Worker serving the partner and admin consoles; a shared D1 for console and hot data.**
- **The API trusting the binding for guarded changes; the delay held in the console DB; a `verifyConsoleToken` RPC.**
- **The admin Worker binding `CONSOLE_DB`; a staff table in a partner-writable database.**
- **D1 or Supabase for the ledger** (D73); **Supabase Storage** (D74).
- **Extending the D1 `usage` counters; rounded pNEAR/Mgas totals; HyperLogLog MAU; MAU from an indexer.**
- **Unkeyed `sha256(sub)`; user lists for partners or SDK-reported addresses; recording gate rejections in the
  ledger.**
- **Ledger retention of 40 or 100 days, or 400 days** (D90).
- **Delay rules per mode or key type; exempting own-client or test-key apps.**
- **Applying a change when its notice fails; GET cancel links; approve links in email.**
- **Step-up for removal, suspension or turning things off.**
- **Hana proposing and expediting the same change.**
- **Origins or policies on chain as a timelocked change** (a contract change and a chain read on every login).
- **NEAR keys or `admin_register_scope` in the admin Worker.**
- **Rebuilding `apps` in a batch C migration** (the cascades would delete origins, usage and vault shares).
- **SVG logos; partner-hosted images in Hana's popups** (D74).

## Retention

Confirmed by the user (D90); **the periods are to be confirmed by the company's accountant before launch** (Hana is
an Australian company: ATO 5-year record keeping; Privacy Act APP 11, destroy or de-identify personal information no
longer needed). The service contract names the same periods.

| Data | Kept for | Who purges |
|---|---|---|
| `usage.events` | Raw (with uid) 24 months after the month ends; then the uid is NULLed and the de-identified rows kept with the settlement records, 7 years (whole monthly partitions) | Monthly job: `strip_uids`, `drop_expired_partitions` |
| `usage.app_users` | Until `last_seen` is 24 months old, or the app is deleted + 30 days | Monthly job: `strip_uids`, `purge_app_users` for `AdminRpc.deletedApps` |
| `usage.gas_settlements` | 7 years (settlement records) | Monthly job (with the partitions) |
| `usage.statements`, `near_usd_rates`, statement files | 7 years (bucket lock 7 years) | Monthly job lists what is due; deleted by hand after review |
| `audit_log`, `app_changes`, `guarded_changes`, `owner_grants` | 5 years (the triggers' constant, 60 months) | Monthly job: console (`audit_log`, `owner_grants`), API (`app_changes`, `guarded_changes`), in batches |
| `ops.*` | Snapshots and cursors: current; `nonce_checks` 400 days | Monthly job |
| `invites` | 90 days after acceptance, revocation or expiry | Console hourly |
| `console_sessions` | 30 days after expiry; network data 90 days | Console hourly |
| `auth_flows`, `handoff_codes`, `pending_actions` | 24 h after expiry | Console hourly |
| Replaced logos | 30 days | Console hourly |
| `EXPORTS` | 30 days (`legacy/` kept) | R2 lifecycle |
| Issuer `user_emails`, `user_email_apps` (D269), with the proposed `uid` column (D276) | No expiry set by D269; deleted on an erasure request | `user:erase` (proposed, D276), by the operator |
| Issuer `email_admin_audit`, directory reads included (proposed, D275) | 5 years, as the other audit logs (D90; not set for this table until now) | Not specified yet: an issuer purge to add with C13 |
| D1 Time Travel / Neon PITR | 30 days / the plan's window | — |

- **Monthly purge job (D90).** The admin Worker's monthly cron runs the Neon functions above and calls
  `AdminRpc.purgeAudit` and `StaffRpc.purgeAudit` for the hot-DB and console tables (5-year rows). Each run is
  recorded in `ops.retention_runs` (started, finished, rows per table, error) and shown in the admin console's
  retention screen with the next run; a failed or skipped run emails `retention_failed` to the security alias and
  shows as a warning until a run succeeds. The hourly console purges (sessions, flows, invites, logos) are
  housekeeping, not retention, and stay hourly.
- Purges run in batches under the per-invocation limits and never delete statements.

## Tests (one per behaviour)

`@cloudflare/vitest-plugin` (`cloudflareTest`, as in `apps/api/vitest.config.ts`) with auxiliary Workers over real
service bindings (Miniflare). Neon tests run in Node against PGlite (Postgres compiled to WASM, in process, no network
or container; D140); the same suite runs against a real Postgres 18 through `pg` when `USAGE_TEST_DATABASE_URL` points
at a superuser connection (a local container, never Neon); Hyperdrive is replaced by a direct connection string in tests. Google's token
endpoint, the JWKS, the Access JWKS, NEAR RPC, the Images binding and the email provider are mocked with fixed keys.

**Topology and config**

- The API's login tests pass with no console or admin Worker and no `CONSOLE_DB` or `USAGE_DB` binding.
- With `USAGE_DB` pointing at a refusing server, every login endpoint answers the same status, body and headers, and
  `usage_write_failed` is logged once after one retry.
- `ConsoleRpc` and `AdminRpc` can't be reached through the public `fetch`; `ConsoleRpc` can't call `AdminRpc` methods.
- Config snapshots: only the console binds `ConsoleRpc` and `CONSOLE_DB`; only the API and admin bind Hyperdrive, to
  different configs; the console-auth and files Workers have no secret, D1 or Hyperdrive; admin has
  `preview_urls: false` (and `workers_dev: false` on production manifests); console and admin have
  `run_worker_first: true`.
- Host dispatch: console-auth serves only `/start` and `/callback` (every other path 404, no script); the console and
  admin answer 404 for any other host; files serves only the logo path pattern.
- No `put`/`delete` call on `STATEMENTS` in the console or on `LOGOS` in the files Worker (source check).
- Manifest refinements: distinct origins; `appChangeDelayMs` bounds and production minimum; `changeDelayMs ≥
  appChangeDelayMs` on production; the dashboard blocks present together; non-empty staff list.
- `gen-wrangler` emits `APP_CHANGE_DELAY_MS`, `NETWORK`, `FILES_ORIGIN` and `REFUSED_ORIGINS`; the API refuses
  guarded changes with `internal` when the delay var is missing or out of range.

**Code flow and sessions**

- `state`, the start handle, PKCE and the nonce are single use.
- Refused: bad `iss`, bad `aud`, expired, wrong nonce, `iat` over 120 s; for login a missing `email` or
  `email_verified: false`; for a step-up a token carrying `email`.
- `/callback` with no query, `code` without `state`, an unknown or used `state`, or no `__Host-hana_af`: 400 with no
  `Location` and `no-store`. `error=access_denied` gets the static page. A success Location ends with `#`.
- A handoff code works once, expires after 60 s and needs the pre-flow cookie. A flow started in one cookie jar and
  finished in another is refused.
- The ID token is never in a response body, a log line or D1.
- A replayed on-chain owner token, a step-up token and a guarded-change token are each refused for login.
- Sessions: idle and absolute expiry; `last_seen_at` at most every 5 min; a new id per sign-in; revocation on member
  removal, role change, user disable and org freeze; CSRF refusal for each missing piece; rate limits.
- Playwright (staging): sign-in completes in Chromium, Firefox and WebKit under the CSP.

**Invites and roles**

- Refused: expired, revoked, reused, wrong email, wrong `hd`, not yet notified (`token_hash` NULL).
- Owner invites (D89): need the `member.invite` step-up; a viewer can't invite; an owner can't invite to another org
  or create one; the 11th open invite is refused; the link works only after every notice send is accepted (invitee,
  every owner, contacts, alias), and a failed send leaves it unusable.
- Owner grants: an accepted owner invite to an org with an owner is a viewer until `owner_from`, then an owner by
  predicate and recorded once by the cron; a promotion likewise from its notice; cancel by an owner, by staff and by
  the link (POST only, single use, refused after `owner_from`) leaves a viewer; a pending owner doesn't count for the
  last-owner rule; the first owner of a new org is an owner at once.
- Two concurrent acceptances give exactly one member; a refused acceptance inserts no user, org, member or audit row.
- A removed member re-invited keeps their user id; a disabled user's acceptance is refused and the invite stays
  unconsumed; a member of org A joins org B; `already_member`.
- A new-org invite creates the org with the member row on its id. Not invited: 403, no user row, audited.
- `issueInvite` returns the token once; it is never stored, logged or returned again.
- The passkey gate: a second `partner` org invite is refused with `passkeys_required`; `internal` orgs pass.
- The role matrix: every action × role cell, including `required_hd` filtering and the last-owner rule.

**Fresh sign-in**

- Refused: a digest for another action or session, a stale `iat`, a sub mismatch, reuse, an expired pending action, a
  revoked or expired session between creation and callback, and a flow finished in another browser.
- Each purpose's nonces are refused for the others (login, step-up, origin change, settings change, owner action).
- Console-only kinds consume, change and audit atomically; a lost race writes nothing.
- The canonical-JSON and digest vectors match the independent implementation.

**Guarded changes**

- `changeOrigins` and `proposeChange` are refused for: bad signature, aud not in `console_audiences`, `iat` over
  300 s, wrong nonce, a non-owner sub, a reused token, a version mismatch, a refused origin, an invalid policy, raw
  signing on a test app, NEAR RPC down.
- A change stays inactive until `ackNotice`; a failed send keeps it inactive; a retry acks with the same link token.
- A pending origin is refused by `getAppByKey`/`originAllowed`, the vault page and `preflightAllows`, and becomes
  allowed by predicate once the clock passes, with no executor.
- A pending policy isn't returned by `GET /v1/app` or inlined until `auto_approve_effective_at`; then it is, and a
  user is asked to consent to its new `policyId`. Raw signing likewise.
- The hourly cron records each activation once (`app_changes *.activated`), promotes policies and raw signing, and
  ends the replaced policy; an unannounced change older than 7 days is cancelled.
- Versions bump on propose, remove, cancel and turn-off, never on ack, activation or expedite; a step-up in flight
  survives another change's ack.
- Removes sent with an add apply at once in the same batch. Origin removal, policy removal and raw-signing off are
  immediate and need no step-up; a removed policy stops auto-signing within 10 s (D62).
- Cancel works for an owner, a Hana admin and the emailed link; the link GET doesn't cancel; the token is single use,
  refused after `active_from` and refused for another change.
- Waivers: `no_session` only while `first_session_at` is NULL, and for staff only on a scope the same `createApp`
  created; `loopback` only for test scopes in non-production envs.
- Expedite: refused for a staff proposal, an unannounced change, or a short reason; recorded and in the feed.
- A staff proposal gets the full delay and is refused within `appChangeDelayMs` of a scope assignment.
- At most one pending `policy_set` and one `raw_sign_on` per app; at most 20 active-or-pending origins.
- Origin rules: production refuses wildcard, non-https and loopback; the refused origins everywhere;
  `normaliseOrigin` shared vectors (IDN, ports, trailing dot, `[::1]`, uppercase) byte-identical in API, console and
  CLI; `xn--` flagged in views and notices; mixed-script refused on live scopes.
- Drift detection flags a directly inserted active origin, policy or raw-signing value once.
- The notice of a `SetAllowShared` lists the scope's active origins.

**CAS, breaker, budget**

- A replayed `requestId` answers `already_applied` and writes nothing; a moved version answers `version_conflict` and
  writes nothing; no applied change lacks its `app_changes` row (fault injection on each statement).
- The sixth suspension, revocation, rotation or removal through `ConsoleRpc` for one org within an hour is refused
  with a `breaker` event; so is the 21st across orgs. `AdminRpc`, cancels and turn-offs aren't counted.
- `AdminRpc.setSuspended` clears bit 4; a member's resume never clears bits 1 or 2.
- Each `ConsoleRpc` method stays within two reads and one batch of ≤ 8 statements (a D1 wrapper counts); over budget
  is `rate_limited`; `usage`, `statements` and `ledger` issue no hot-DB statement.
- Load test (staging): `getAppByKey` median and p95 change by ≤ 10% under console load at the budget ceiling.

**Settings, keys, logos**

- Settings ranges match batch B's CHECKs; `google_web_client_id` must be an on-chain client of the scope; shares
  follow a lowered TTL or `persistence = 'none'` at once.
- Rotation keeps the old key valid for exactly 24 h; revoke is immediate (401 `unknown_app`); the prefix must match
  the scope's environment; the 5-key limit.
- Logos: SVG, GIF, polyglot and oversized files refused; a JPEG becomes a 256 × 256 PNG without metadata; the files
  Worker refuses a non-PNG object and sends exactly the §Response headers; `GET /v1/app` returns `logoUrl`; the auth
  pages' `img-src` includes the files origin.

**Apps, scopes, owner actions**

- `createApp` refuses `no_security_contact` and an on-chain owner not among the org's owners; `assignScopeOrg`
  refuses a non-legacy scope and moves every app of a two-app scope in one statement; updating one app's `org_id`
  alone violates the trigger; `deleteApp` revokes every key; `setSecurityContacts` is reachable only through
  `AdminRpc` and is emailed to old and new contacts.
- The TS port matches `test_fixture.json` and the worked examples; the owner-action token is `openid` only; the relay
  is byte-identical; `clientIp` feeds the per-IP limiter; a moved N aborts.
- The precheck refuses `owner_nonce_mismatch` before any reservation, after an uncached re-read; a `NOT_EXECUTED`
  failure still releases the reservation; AddClient proofs with the wrong `aud` or nonce are `invalid_client_proof`.
- The helper is only a download; the paste step shows the PII warning.
- Per-scope cap and the separate safety budget; caps write security events; the allowance alert.
- The watcher emails a `SetOwners` adding an `Oidc` and an `AddClient` relayed directly, once each, and an owner or
  client diff once; owner drift is flagged in the console.

**Admin and email**

- Refused Access JWTs: missing, wrong `aud` or `iss`, expired, unknown `kid`, empty `sub`, an email not on the list.
- The actor lands in `audit_log` and `app_changes`. An `AdminRpc` suspension works with the console Worker down.
- Blocking notices go to the alias and every contact and ack only after every send is accepted; a provider failure
  leaves the change unannounced.
- The feed emails each `app_changes`, `audit_log` and `security_events` row once, advances its cursor only after
  success, and works with the console Worker down.
- `details_json` allowlist snapshots; the append-only triggers on `audit_log` and `app_changes`.
- Playbooks (D126): every playbook in `@hana-id/playbooks` `PLAYBOOKS` has a page that shows each step's `who`,
  detail and commands; every watchdog alert kind (`ALERT_KINDS` from `apps/watchdog/src/checks.ts`) and every alert in
  the history links to its playbook's page; the search finds an incident playbook by a word of its signals; a kind
  with no playbook renders the "no playbook" error (the watchdog's `test/registry.test.ts` already forbids one).

**Users and Support ID (proposed, D275, D276)**

- Config snapshots: only the admin Worker binds `DirectoryRpc`; only the email issuer binds `IssuerRpc`; the console
  binds neither; no Worker but the issuer binds the issuer's D1. Neither entrypoint is reachable through any
  Worker's public `fetch`.
- Source checks: `DirectoryRpc`'s module issues only `SELECT`s on `user_emails` and `user_email_apps` and the audit
  `INSERT`, and imports none of the signer, key, challenge or mail modules.
- Access: every `DirectoryRpc` method refuses a missing, expired, wrong-`aud`, wrong-`iss` or unknown-`kid` JWT and an
  email not on the staff list (`forbidden`), reading no row and writing no audit row; the audit's `staff` is the
  JWT's email even when the `Ctx` names someone else; a missing or over-long `ticket` is `bad_request`.
- Audit: each method writes its row in the same batch as its read; a failing audit insert answers `internal` with no
  rows; no audit row or log line of any flow contains an address (the grep of the issuer's `test/privacy.test.ts`,
  extended); the admin audit view shows the issuer's rows beside `queryAudit` and `changesSince`.
- Budget: the 501st identity in an hour (the 2 001st in a day) for one staff email is `rate_limited` and emails the
  alias once; another staff email is unaffected.
- Search: exact address, substring (3 characters accepted, 2 refused), provider, app, sub and unverified-only filters
  against fixture rows; keyset paging stable while rows are written; at most 100 a page; the address and the code
  never in a URL or a log line (the BFF routes are POST; log snapshot).
- Unverified claims: a Google row with `email_verified = 0` shows the warning on the row and the detail, sorts after
  verified rows, and is never the default target of an address or code match.
- Detail: `get_identity` mocked as own, member (the root's path and the root's row linked), pending
  (`effective_at_ms`) and failing ("chain unavailable", no path); every path is `{scope}#{provider}#{sub}#0`.
- No export: the admin BFF route table has no user export (snapshot).
- Partners: over a fixture user with a directory row, no `ConsoleRpc` answer, console route, `/v1` answer, SDK
  status or event carries the address (response snapshots).
- Support ID (D346): pinned against the identity token's `sub` vectors (`sub` → code, built on
  `feat/user-id-identity-sub`); the Crockford alphabet; the parser's lowercase, `O`, `I`, `L` and missing-dash cases;
  the directory's User ID equals the `sub` of a token the same session mints (built); the code in the `/v1/login` and
  `/v1/sessions` answers equals `supportIdOf` of the token's `sub` for the same path (a linked member gets its
  root's); `hana_status.supportId` set at login and cleared at logout.
- Lookup: a code finds the user through `end_users.support_code` (`AdminRpc.findUsers`, built); two identities
  sharing 40 bits are both listed; the ledger activity is found by the row's internal id (`hu_…`); a uid stripped
  from the ledger (month + 24 months) shows no activity; request IDs find rejected and error events, which carry no
  uid.
- Migrations: issuer 0003 on a 0002 database keeps every `email_admin_audit` row and its CHECK accepts the new
  actions and nothing else; C15's Neon migration adds the two indexes.

**Hot DB and gate**

- 0006 on an empty DB and on a sandbox-dev snapshot (origins, legacy usage, vault shares): row counts unchanged;
  legacy apps keep working; origins get `active_from = 0`; every scope gets `first_session_at`; baseline rows exist;
  `apps_scope_id` and `app_origins_origin` still exist.
- The batch B gate, preflight and share SQL give the same answers on the post-0006 schema; a `suspended_by` write
  shows as `status = 'suspended'`.
- A test/live mix in one scope is refused by the migration and by the RPC. Org A asking for org B's app gets
  `not_found` on every `ConsoleRpc` org method.
- No code reads `apps.publishable_key` outside the migration and the trigger.

**Usage ledger (Postgres)**

- Migrations apply on an empty database; the writer role can execute only its functions (direct `INSERT`, `SELECT`,
  `UPDATE` and `DELETE` on every table are refused); the admin role can't update or delete events, statements or
  settlements.
- `record_event`: idempotent on retry; refuses a bad shape; `first_seen` is the minimum when events arrive out of
  order; an event outside every partition fails.
- uid vectors against an independent Node implementation; scope separation; `key_index` ignored; path parsing
  refuses a wrong prefix or part count; the same uid from the login, session and derive paths.
- Events: one per post-gate outcome on every endpoint, none for gate rejections or `GET /v1/app`; the allowlist
  snapshot shows no sub, JWT, email, IP or session key; `org_id` from the gate row; `relayer_pk`/`relayer_nonce` on
  every relayed event; each relay code maps to `relayed` as in the table.
- Gas: a BigInt sum over a recorded sandbox-dev `tx` at FINAL including every receipt; settlement against mocked RPC
  including `unsettled` after 24 h; settled timeout gas counts as error gas.
- Reports: percentiles with 1, 2 and random samples match brute force; UTC boundaries at 23:59:59.999; MAU distinct
  across days and endpoints; USD rounding vectors; ranges over 400 days and more than 100 apps refused; another
  org's rows never returned.
- Nonce check: explained by a matching row, explained when idle, `nonce_unexplained` for a nonce with no row.
- Statements: refused before the 3rd, with an unsettled event or a missing rate; a second issue refused; UPDATE and
  DELETE refused; a rate change refused once the month has a statement; late events excluded by `as_of` and listed.
- Golden CSV, byte-stable: quoting, injection cases (`=cmd`, `@x`, `-x`), negative numbers unprefixed, scope rows,
  totals; the ledger CSV's `final` gas for the same `as_of` equals the statement's `tgas` and `near`.
- Retention (D90): uids NULL after month + 24 months, the rows kept; partitions and settlements past 7 years
  dropped; `app_users` rows with `last_seen` past 24 months and 30 days after app deletion purged; audit rows
  deletable only after 60 months (trigger); each monthly run recorded in `ops.retention_runs`, a failure alerted and
  shown; `uid:erase` through its function only.
- Rejection rate (D91): an org over 5% relayed-then-rejected (with ≥ 100 relayed attempts that day) raises one
  `rejection_rate` alert per org per day, shown in the security screen; below it, nothing.
- Statements (D92): the CSV, the PDF and the on-screen statement show identical totals and the CSV's sha256; the
  rejected line is separate and marked not billed.

**Headers**

- The CSPs and headers on console, admin (assets and Worker responses), console-auth and files responses.

**Testnet smoke (sandbox-dev, after deploy)**

Prerequisites: open questions 1, 3 (sandbox-dev's workers.dev fallback is accepted, D93) and 5 answered, Resend set
up (D87); the console
sink scope exists (§Address impact); a partner org with an accepted owner and a security contact; a new test scope
registered with `scope:register --owners-from-org`; a test app on it via `AdminRpc.createApp`. `s1` and `s2` are owned
only by `Owner::Near`, so they stay as batch A references.

- Invite and sign-in; an owner invites a second owner, who is a viewer until the grant matures; a cancel by link.
- On the smoke scope: an origin add (notice received, delay, activation) and a cancel by link; a policy set, the
  consent prompt for its `policyId`, and its removal.
- Propose, execute and cancel through the console; the watcher's email arrives.
- On `s1`: an origin removal, a suspension and resume; the feed emails them.
- A statement for the month whose ledger CSV totals match; the nonce check runs clean for a day.
- Staging: the Access header reaches the admin Worker; the code flow completes under the CSP; a report query over a
  full month finishes under 2 s.

## Build order (rough sizes: lines of code with tests, engineer-days)

1. **Shared and API prerequisites** (~2.5k, 5 d): `packages/oidc` (new claims), `packages/console-core` (layouts,
   vectors, `normaliseOrigin`, types), the owner-action refactor and caps, relay results with key and nonce, gas
   fields, migration 0006 with the gate and preflight SQL and triggers, `first_session_at`, the new vars.
2. **Usage ledger** (~1.5k, 3 d): Neon project, roles and Hyperdrive configs (`usage:setup`), DDL and functions,
   `recordUsage` with one retry, uid, removal of the D1 counters, `usage:legacy-export`, the monthly retention
   functions. Blocked by open question 5.
3. **`ConsoleRpc` and `AdminRpc`** (~3k, 6 d): guarded changes (origins, policy, raw signing) with CAS, ack,
   activation and promotion, cancel links, waivers, expedite, drift, settings, keys, logo pointer, `security_events`,
   the breaker, the hot-DB budget, the sink-scope deploy step.
4. **Console Worker and console-auth** (~4.5k, 9 d): dispatch, code flow, invites, sessions, CSRF, fresh sign-in,
   screens (apps, origins, policy editor with consent preview, settings, keys, members, usage, statements, owner
   actions and the helper, cancel page), logo upload. Blocked by open questions 1, 3 and 5.
5. **Files Worker and R2** (~0.3k, 1 d): buckets, lock and lifecycle rules, the logo route.
6. **Admin Worker** (~3.5k, 7 d): Access check, `StaffRpc`, screens, security contacts, blocking notices, the feed,
   the watcher, settlement, the nonce check, rates, reports, statements (CSV, PDF, on-screen), exports, the monthly
   retention job and its screen, the rejection-rate alert, invite and owner-grant notices, the Resend adapter. Blocked
   by open question 5 and the Access fallback addresses (4).
7. **CLI** (~0.6k, 2 d) and batch B page touches (`logoUrl`, `img-src`) (~0.1k, 0.5 d).
8. **Testnet smoke** (2 d).

About 16k lines and 35 engineer-days; steps 2–3 and 5 can run beside 4 once step 1 lands.

## Out of scope for batch C

- Everything in §Deferred.
- Public registration and self-serve scope registration (`public_registration` stays off).
- Per-user lists for partners, wallet addresses, opt-in address reporting. A user-approved share of the address to a
  partner (D269: UX not designed). Staff get the Users screen (proposed, §Users and Support ID).
- Hash-chained or externally anchored audit (D93).
- Origins or policies on chain; NEAR events from `create_session`/`derive_key` as a billing cross-check (contract
  change, needs the external audit).
- SAML/SSO for partners, mobile app identifiers, webhooks.
- Email login (D4). Mainnet deploy. Contract governance changes (`docs/governance-spec.md`, D33, D80–D86; batch C's
  open question 9 moved there as its open question 17). The governance batch adds two screens to the consoles built
  here (§Hana admin console).
- Hana Home (D40, D45): its own batch before mainnet.

## Address impact

**No user address changes.** One change to client registration is called out here.

- **Unchanged:** no path (`scope#provider#sub#key_index`), key index, HKDF salt or info, CKD domain, signer account,
  session layout or contract nonce layout changes.
- **The console client moves from `global` to a Hana console sink scope** (confirmed, D93; rolled out on sandbox-dev
  before the address freeze).
  - **Why.** Today `consoleAudiences` are clients of `global` (`scripts/lib/deploy-plan.ts` `register-global`), Hana's
    own app scope with real wallets. Through `session_scope`, a console-client token whose nonce follows the session
    layout would open a `global` session and `derive_key` would give that user's `global` wallet key; a compromised
    console chooses the nonce at every partner and staff sign-in.
  - **The sink:** a dedicated `sN` scope owned by `Owner::Near` (the manifest's `owner`), with only the console
    audiences as clients, `allow_shared = false`, no app and no origins. Registering the audiences there still stops a
    partner claiming them with `AddClient`.
  - **deploy-plan** gains a step before `register-global` on a fresh env; on an existing env (sandbox-dev) one plan
    runs `remove_client` of each console audience from `global` (immediate) then `admin_register_scope` for the sink.
    In the seconds between, an `AddClient` claim would still be timelocked and seen by the watcher. `register-global`
    stops adding console audiences and its 10-client check counts only `googleClientIds`.
  - **Who it affects:** no `global` user's address changes (the path has no client ID); console tokens lose the
    unused ability to open `global` sessions.
- **Off-chain only:** the new domains (`hana-console/*`, `hana-id/origin-change/v1`, `hana-id/settings-change/v1`,
  `hana-id/cancel-link/v1`, `hana-id/uid/v1`, the reserved `hana-id/change-approve/v1`) and the uid. Rotating
  `USER_ID_KEY` affects only MAU and new-user continuity.
- **Owners are identified by Google `sub`,** stable across clients and Cloud projects (D42), so moving the console
  client to another project changes no owner.

## Contract changes

None. `console_audiences`, `Owner::Oidc`/`OwnerAuth::Oidc`, `get_scope`/`action_nonce`, `remove_client`,
`admin_register_scope`, the timelock (AddClient, SetOwners, SetAllowShared) and the `change_proposed` events cover this
design. Operational requirement: on mainnet `changeDelayMs ≥ appChangeDelayMs` (≥ 24 h), a manifest refinement.
Flagged for the governance spec: a compromised OIDC owner can cancel any pending change, including a `SetOwners` that
would remove them (moved to `docs/governance-spec.md` open question 17); fixing it before the address freeze has no
address impact.

## Open questions

Answered since the first draft (not repeated): roles (D34: owner, viewer), passkeys and their WebAuthn library (D34:
deferred), second-owner approval (D34: deferred), Hana restore of keys and origins (D34: deferred), secret keys (D34:
deferred), key grace (D34: 24 h), the request queue (D34: deferred), the second notice channel and its contacts model
(D34: one channel from the admin Worker), the AE threshold and D1 read replicas (D34, D73: AE deferred, ledger on
Neon), hardware keys for staff (D75: GitHub team with org 2FA), the batch B login page and own-client origins (D47: the
vault page and parent-origin checks already use D1 origins in both modes), the reconciliation of the four decision
records (superseded by this rewrite).

Answered on 2026-10-29 (`docs/decisions.md` D87–D93), applied above; the numbers are kept so references stay valid.

**Blocking implementation or the smoke**

1. **Still open (to test).** Does Google's code flow return an ID token without `email` for `scope=openid` with the
   console client? D25 showed it for Hana's clients in the implicit flow; confirm for the code flow on sandbox-dev. If
   Google always adds email, step-ups and owner actions stop until decided; fallback: accept the email after an
   explicit partner disclosure. **Blocks steps 4 and the smoke.** The test is built in C9 (2026-11-04,
   `scripts/console-code-flow-spike.ts`, D295; `docs/operations.md` "Console code-flow spike"), not yet run. Expected
   besides: Google documents `at_hash` on every server-flow ID token. **Decided (D342, confirmed 2026-11-04):**
   `at_hash` joins the claim allow-list everywhere (core, the API, the console).
2. Email provider. **Answered (D87):** Resend, dedicated sending subdomain with SPF/DKIM/DMARC, behind a sender
   interface.
3. **Still open:** the Hana-owned Cloudflare account and zone, and the console, console-auth, files and admin domains
   (D18, D38; the console auth host and the passkey RP ID later depend on it); who holds member and API-token access,
   given any Worker in the account can bind `AdminRpc`. **Answered in part (D93):** until then sandbox-dev runs on
   `workers.dev` with the thin-Worker origins. **Blocks steps 4–6 on production envs.**
4. Access team and allowlist. **Answered (D88):** team `hana-admins` in `Hana-Technology`, org-wide 2FA; the Worker's
   `admin.staffEmails` allowlist stays. **Still open:** the exact Google fallback addresses (the user provides them).
5. **Still open:** Neon: one project per env and plan (PITR window, compute always on in production or scale-to-zero
   with the retry), who holds the owner role, and Hyperdrive availability on the target account's plan. **Blocks step
   2.**

**Confirm**

6. Owner invites. **Answered (D89, amends D29):** owners invite viewers and owners with a fresh sign-in and a notice
   to every owner and security contact; a new owner is a viewer for 24 h unless cancelled; staff add and remove
   members (§Invites and owner grants).
7. The console sink scope. **Answered (D93):** yes, rolled out on sandbox-dev before the address freeze.
8. Seven Workers. **Answered (D93):** accepted.

**Policy and contract**

9. Contract governance (cancel by a compromised OIDC owner). **Moved** to `docs/governance-spec.md` open question 17;
   decide there before the address freeze.
10. Ledger retention. **Answered (D90):** statements and settlements 7 years, raw usage 24 months then de-identified,
    audit 5 years, a monthly purge job; to be confirmed by the company's accountant before launch.
11. Relayed-then-rejected gas. **Answered (D91):** not billed by default, its own statement line, an admin alert above
    5% of relayed attempts; contract terms may bill partner-caused rejections above it.
12. Production `change_delay_ms`. **Answered (D93):** 24 h (= `appChangeDelayMs`); partners don't set their own delays
    in batch C.

**Reporting and billing**

13. The daily nonce cross-check. **Answered (D93):** as read here (each relayer key's latest landed nonce must have a
    ledger row); daily; no indexer.
14. Runtime dependencies. **Answered (D93):** `pg` and `pdf-lib`, exact-pinned.
15. Logo re-encoding. **Answered (D93):** PNG, JPEG or WebP only, re-encoded through the Cloudflare Images binding; no
    SVG.
16. PDF statements. **Answered (D92):** CSV + on-screen + PDF with the same totals and hash; tax invoices from the
    accounting software.
17. NEAR/USD source. **Answered (D93):** daily, one source (e.g. CoinGecko) named in the service contract, audited
    manual override; testnet pilot statements at the mainnet price, labelled.

**Data and governance**

18. Tamper evidence. **Answered (D93):** no hash chain in the MVP; the accounts are the trust root.
19. Network data on console sessions. **Answered (D93):** coarse data (country, ASN, IP prefix) for 90 days.
20. Auth rate limiting. **Answered (D93):** the Workers rate-limiting binding in the console Worker; the API's
    `RateLimiter` only if the binding isn't available.
21. Breaker thresholds. **Answered (D93):** 5 per org and 20 across orgs per hour, per call.
22. Settlement at scale. **Answered (D93):** one `tx` per relayed transaction for now; revisit at scale.
23. Owner-action caps. **Answered (D93):** as designed.
24. Two staff for shared-login live-app proposals. **Answered (D93):** no, not in the MVP.
25. Local testing. **Answered (D93):** against a Hana-run testnet env with its own console; production keeps refusing
    loopback.

**Users and Support ID (added 2026-11-04 after D269; to confirm by the user)**

26. **The Users screen (D275).** Recommended: the admin Worker reads the directory through `DirectoryRpc`, a read-only
    entrypoint on the issuer that verifies the staff Access JWT and audits each read itself, with a per-staff row
    budget and no CSV export. Alternatives in D275: an issuer D1 binding in the admin Worker, a separate directory D1
    bound to both, the issuer's Access HTTP routes; a capped, audited export.
27. **The Support ID (D276).** Recommended: the uid's first 40 bits (`USER_ID_KEY`, no new secret), returned by the API
    with the session; resolved through a `uid` column the issuer fills from the API's `IssuerRpc`, with a ledger-only
    fallback; errors by request ID; no partner lookup. Alternatives in D276: a separate key, the identity token's
    `sub`, recomputing uids at lookup, uids on error events, an org-scoped partner lookup. **Answered 2026-11-04 by
    D346: the identity token's `sub`** (the partner's User ID), resolved through the wallet directory; no issuer uid
    column, no ledger fallback.
