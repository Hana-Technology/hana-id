# Batch C spec: developer dashboard (partner console, Hana admin console, usage reporting)

**Status: DRAFT (2026-10-27).** Written by a multi-agent design workflow (3 proposals + a judge per decision, then security, completeness and implementability reviews). Not yet reviewed or approved by the user: every decision and open question below needs confirmation before implementation.

This is the source of truth for batch C. If the code and this spec disagree, fix the code or raise it; don't silently
diverge. It amends `docs/batch-a-spec.md` and `docs/batch-a2-shared-client.md` where it says so. It was decided with
the user on 2026-10-27 from four decision records: dashboard-auth, batch-c/architecture, data-model-reporting and
origin-change-safety. Where those records disagree, §"Reconciling the decision records" says what this spec does.
A review on 2026-10-27 changed three choices for safety: console audiences move out of `global` into a Hana sink
scope, an origin add also needs an admin-side notice before its clock starts, and second-owner approval is deferred.
Open questions 38 to 40 ask the user to confirm them.
Plan doc: https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi

## Goal

Partners run their own integration from a web console: orgs, members and roles, apps, allowed origins, publishable
and secret keys, own Google client or shared login, suspend and resume, and on-chain owner actions. No Hana engineer
has to run `scripts/admin.ts app:*`. Hana staff use a separate admin console for invites, orgs, suspensions, the audit
log and billing-grade monthly statements.

Two properties hold throughout:

- **Logins don't depend on the dashboard.** Load on the console or admin Worker, or a bug in either, can't stop
  end-user logins. A *compromised* console Worker can use only the kill switches: removing origins, suspending apps
  and revoking keys. The API caps those per org and globally (§RPC interfaces, "Destructive-call breaker"), logs every
  one in `app_changes`, and the admin Worker reports them. Hana can reverse a suspension (any bit) and a key
  revocation from the last 7 days. Removed origins come back through the normal add path. A console compromise is
  therefore a bounded, recoverable DoS. It is listed as a residual in §Security model.
- **No new origin opens a wallet for an app's users unless all three of these happen:**
  1. Either an on-chain `Owner::Oidc` of the app's scope gives a fresh Google assertion bound to that exact change,
     verified by the API, or a Hana staff member adds it through `AdminRpc`.
  2. Two notices are accepted by the email provider. The console sends one to the org's owners and admins. The admin
     Worker sends its own to Hana security and to the org's security contacts. Hana staff set those contacts, and they
     are stored outside `CONSOLE_DB`.
  3. A delay passes, during which any of those people can cancel.

  **The admin Worker guarantees the co-owner notice**, through the security contacts. A compromised console can't
  suppress it, because the API starts the clock only after both notices are acknowledged. The console's own emails
  come on top of that. There are two exceptions to the delay: the `loopback` waiver, and the initial origins of a
  scope created in the same call (`no_session`). Both are still notified.

Done when:

- A Hana admin invites a partner owner. The owner signs in with Google through the console client, enrols a passkey,
  and sees their org. Someone with no accepted invite gets 403 `not_invited`, and no user row is created.
- On sandbox-dev, an origin add on the smoke scope stays inactive until the console notice and the admin notice have
  both been accepted and the delay has passed. It can be cancelled from the console, by a Hana admin, and from the
  emailed link (a POST confirm). The API refuses the add without a step-up token from an on-chain `Owner::Oidc` of
  the scope.
- `propose_change`, `execute_change` and `cancel_change` run through the console on sandbox-dev's smoke scope. The
  relayed args are byte-identical to what the user was shown. The admin Worker emails security about the proposal.
- The API's login tests pass with no console Worker, no admin Worker, no console D1 and no usage D1 present.
- The admin console produces a monthly statement CSV for sandbox-dev's apps. Its gas and yocto totals, owner actions
  included, equal the sum of the per-transaction ledger CSV exactly. Every `near_tx` in the ledger can be checked on
  chain at FINAL.
- All tests pass: `cargo test` (contract unchanged), `pnpm -r test`, `pnpm -r typecheck`.

## Decisions (proposed 2026-10-27; DRAFT until the user confirms them)

- **Three Workers in one Hana-owned Cloudflare account.**
  - `hana-id-api-<env>`: exists; the only Worker on the login path.
  - `hana-id-console-<env>`: new, partner console. It also serves the auth origin.
  - `hana-id-admin-<env>`: new, staff console.
  - Calls go one way over named RPC service bindings. The API never calls the other two.
- **Three D1 databases:** hot `DB`, `CONSOLE_DB` and `USAGE_DB`. No report query and no usage write ever touches the
  hot `DB`, because D1 runs one query at a time per database. The dashboard's reads and writes of app config do reach
  `DB`, but only through `ConsoleRpc` and `AdminRpc`, as bounded, indexed queries of at most 3 statements per call,
  under a hot-DB budget the API enforces (§RPC interfaces).
- **Our own Google OIDC sign-in, not a hosted auth provider.**
  - It uses a server-side authorization-code flow through the console client, which has no JavaScript origins.
  - The callback is on a separate, script-free `auth.` origin.
  - Sessions are server-side.
  - A WebAuthn passkey is a mandatory second factor for every partner member.
- **Invite-only.**
  - Invites are email-bound, single use, valid for 7 days, and stored as sha256.
  - There is no sign-up path.
  - The identity after acceptance is `(provider, sub)`, never the email.
- **Step-up per action.** Each sensitive action needs a passkey assertion and a fresh Google code flow, both bound to
  the digest of that one action. The proof is good for that action only.
- **The API enforces origin safety itself and does not trust the console for it.** The API checks the step-up token
  for an origin add: signature, console audience, freshness, on-chain owner, change-bound nonce and single use. The
  delay lives in `app_origins.active_from`, in the API's database.
- **Every non-loopback origin add is delayed unless the `no_session` waiver applies.** Production uses 24 h, and no
  deployed environment may use 0. The notification fails closed. Any owner, any Hana admin, or the emailed link (POST
  confirm) can cancel during the window. Removals and suspensions take effect at once.
- **On-chain owner actions use the same login.**
  - The server builds the borsh args and computes the owner nonce.
  - The Google token for an owner action asks for `openid` only (subject to open question 1).
  - The relay is byte-identical, over `ConsoleRpc.ownerAction`.
- **The Hana admin console sits behind Worker-level Cloudflare Access** (Hana IdP plus hardware-key MFA), and the
  Worker verifies the Access JWT itself. The admin Worker holds no NEAR keys. `admin_register_scope` and contract
  admin stay in `scripts/`.
- **Billing-grade usage.**
  - A Queue-fed per-request ledger in `USAGE_DB`. It is insert-only except for the two retention writes in §Retention.
  - Daily and monthly totals recomputed from the ledger (never incremented).
  - Exact BigInt gas and yocto.
  - MAU from a keyed per-scope HMAC of the user (`uid`), never the raw `sub`.
  - Analytics Engine for operational metrics only.
- **No per-user list and no wallet addresses in the MVP.** Aggregates only.
- **Billing (Stripe, plans, invoicing) is on hold.** The org row keeps nullable billing fields.
- **`public_registration` stays off.** Hana registers scopes after review. Shared-login-only apps need no client
  proof.
- **No contract change.**

## Reconciling the decision records

The four records overlap, and in places they disagree. Each record governs its own topic:

- dashboard-auth: identity, sign-in, MFA, sessions, step-up and admin auth.
- architecture: Workers, bindings, RPC, and where trust is enforced.
- data-model-reporting: tables, capture, reporting and retention.
- origin-change-safety: origin and key rules, delay, notification, cancel and expedite.

Where a disagreement crosses topics, this spec chooses as below. Open question 37 asks the user to confirm these
choices.

| # | Topic | The records say | This spec | Why |
|---|---|---|---|---|
| 1 | Partner sign-in | architecture §5 and origin-change §2: GIS in the page. dashboard-auth: server-side code flow, GIS rejected | Code flow. CSP `script-src 'self'` with no Google entries, and COOP `same-origin` | It is the auth record, and its rejection of GIS (XSS chooses nonces, tokens in page JS, email on chain) is specific |
| 2 | Login nonce | architecture: `"hana-id/console-login/v1" ‖ random32`, HMAC-bound to a cookie. dashboard-auth: `hana-console/login/v1`, stored in `auth_flows` | `b64url(sha256("hana-console/login/v1" ‖ random32))`, stored in `auth_flows` and bound to a pre-flow cookie and an auth-origin flow cookie | With the code flow the server holds the nonce. The domain separation that architecture wanted is kept |
| 3 | Session idle timeout | architecture: 1 h. dashboard-auth: 2 h | 2 h idle, 12 h absolute | Auth record. Every sensitive action needs step-up anyway |
| 4 | "Fresh sign-in" | data-model: a session `reauth_at` window from `prompt=login`/`max_age`. origin-change: a random `step_ups` row as the GIS nonce, iat ≤ 300 s. dashboard-auth: passkey plus code flow per action digest, iat ≤ 120 s. architecture: the API re-verifies an origin-change nonce, iat ≤ 5 min | Per-action step-up (dashboard-auth) everywhere, with no `reauth_at`. For origin adds, the action digest is architecture's origin-change layout, so the API can recompute it. The console requires iat ≤ 120 s and the API ≤ 300 s | dashboard-auth says Google offers no `prompt=login`/`max_age` re-auth. Architecture's API-side check is what stops a compromised console |
| 5 | Number of D1 databases | architecture: 2, with usage tables in the API DB. data-model: 3 | 3: `DB`, `CONSOLE_DB`, `USAGE_DB` | Usage writes and report reads must not queue behind `getAppByKey` |
| 6 | Who binds `CONSOLE_DB` | dashboard-auth and data-model: the console and admin Workers. architecture: the console only, with `StaffRpc` for admin | The console only. The admin Worker uses `StaffRpc` | One writer and one migration owner (architecture's rejection is explicit) |
| 7 | `USAGE_DB` writers | data-model: the API writes, the admin Worker reads and runs rollups. architecture: one writer per database | Two writers on disjoint tables. The API owns the migrations and writes `usage_events` and `app_users`, including their retention (uid NULLing and the 400-day purge, from a daily API cron in small batches). The admin Worker writes only the derived tables and its own state tables, including `gas_settlements`, so the ledger is never updated except by the retention writes | Keeps rollups off the API (data-model) and gives one migration owner (architecture). The retention writes are small, bounded batches on the table the API owns. A deliberate exception to "one writer", covered by a test |
| 8 | Staff allowlist | dashboard-auth: an `admins` table in the console D1. architecture: a manifest var on the admin Worker | Manifest `admin.staffEmails`. The Access `sub` is recorded per action | The partner-exposed Worker must not be able to write the staff list |
| 9 | Latency percentiles | architecture: D1 histogram buckets. data-model: exact nearest-rank from raw events | Exact, from events, in JS | Reporting record. The totals already need a pass over the events with BigInt |
| 10 | Origin activation | architecture and data-model: `effective_at`. origin-change: `active_from`, NULL until announced. dashboard-auth: `apply_at` plus a cron | `app_origins.active_from` (NULL = not yet announced), checked by a predicate. An hourly API cron only records activations for the audit trail and emails | The predicate costs nothing on the login path, and NULL makes failed notification safe |
| 11 | Delay length | architecture: suggests 0 for pk_test. data-model: open. dashboard-auth: 24 h in production. origin-change: 60 s to 7 d, never 0 when deployed, production 24 h | Top-level manifest `originAddDelayMs` (required): 60 000 to 7 d, production ≥ 24 h, never 0. The exceptions are in row 12 | A delay of 0 leaves the compromised-console phishing attack open (architecture trade-off 6). Top-level, because the API enforces it even in an env with no console |
| 12 | Delay exceptions | dashboard-auth: waive when the scope has never opened a session; Hana "apply now". origin-change: loopback on pk_test at once; `app:create` origins at once if no other app ever mapped to the scope; second-owner approval; Hana expedite of member-proposed adds only | (a) Loopback on a test-environment app in a non-production env: at once. (b) Waiver while `scopes.first_session_at IS NULL`. For a Hana-kind actor, it applies only to the initial origins of a `createApp` that creates the `scopes` row. (c) Second-owner approval is **deferred** (open question 39). (d) Hana expedite (= dashboard-auth's "apply now"), for member-proposed adds only | "No session ever" is the direct test for "no keys to steal". Expedite stays a two-party path. Approval has no pilot user and is a second API token path |
| 13 | Roles | data-model: `owner\|developer\|viewer`. origin-change: refers to owner and admin roles | `owner\|admin\|developer\|viewer`. The matrix is in §Roles | origin-change gives the admin role real duties (cancel, emergency removal, notices). Open question 22 confirms |
| 14 | Removing an origin | architecture: an `app_origins.removed_at` column. origin-change: an `origin_changes` lifecycle | The row is deleted from `app_origins`. The history is in `origin_changes` and `app_changes` | Keeps the PK `(app_id, origin)` free for re-adds. The history is still append-only |
| 15 | `audit_log` | three shapes; origin-change places it with migration 0003; architecture has a status column that is updated | One table in `CONSOLE_DB` with the union of the columns. Append-only: the outcome is an appended row (`parent_seq`), never an update. DELETE only past retention | The append-only triggers forbid UPDATE, so a status column can't be updated in place |
| 16 | Who may add origins | origin-change: owner or admin role. architecture: the step-up `sub` must be an on-chain `Owner::Oidc` | Both: a console role check and the API's on-chain owner check | Defence in depth. A compromised console can't lift the API's check |
| 17 | Invite acceptance SQL | dashboard-auth: UPDATE requiring changes=1, then INSERT. data-model: a conditional `INSERT…SELECT` | Conditional `INSERT…SELECT`, with every id resolved from `(provider, sub)` inside the batch | A D1 batch can't branch on `changes`, and a 0-row UPDATE is not an error |
| 18 | Admin actions while the console is down | architecture: the admin Worker depends on the console for org and invite operations, but AdminRpc suspension still works | AdminRpc writes `app_changes` in the same batch as the hot-DB change. If `StaffRpc` is down, emergency actions go ahead, and the console reconciler mirrors those rows into `audit_log` later | The kill switch must not depend on the console. There is still never an unlogged change |
| 19 | Drift detection | origin-change: check against "a creation audit row" in the console DB | The API's hourly cron checks against `origin_changes` and `app_changes` in the hot DB and writes `security_events`. The admin Worker emails the security alias | The API can't read `CONSOLE_DB` |
| 20 | Step-up for origin removal and suspension | dashboard-auth: step-up. origin-change and architecture: none (kill switch) | No step-up, for removal, suspension and cancel by an owner or admin. The API caps their rate | Two records, plus the kill-switch rationale. These actions only reduce exposure |
| 21 | Manifest names | dashboard-auth: `console.originAddDelayMs`, `adminAccess`, `email.from`. architecture: `originDelayMs`, `admin{…}`, `emailFrom` | The merged blocks in §Manifest, with `originAddDelayMs` at the top level | One schema |

## Repo layout (additions)

```
apps/api/                    + src/rpc/{console,admin}.ts (WorkerEntrypoints), src/usage/ (event, queue consumer,
                               uid, gas, retention), migrations/0003_*.sql…, migrations-usage/ (USAGE_DB, owned here)
apps/console/                hana-id-console-<env>: partner SPA (React 18.3.1, Vite, React Router, client-only) +
                               /api/* backend-for-frontend, auth-origin handler (/start, /callback), StaffRpc
                               entrypoint, crons, static AddClient helper file, migrations/ (CONSOLE_DB, owned here)
apps/admin/                  hana-id-admin-<env>: staff SPA + /api/*, rollup/statement/settlement/notice/watcher
                               crons. No migrations.
packages/oidc/               RS256 / JWKS / claims, moved out of apps/api/src/{jwt,jwks}.ts; used by the API and console
packages/console-core/       zod schemas and §Types, roles and the permission matrix, canonical JSON, nonce layouts
                               (owner action, client proof, step-up, origin change), normaliseOrigin, LOCALHOST_WILDCARD
                               and the loopback regexes (moved from scripts/lib/admin-sql.ts), punycode display,
                               ported from gen-fixtures.mjs. Imported by the API, the console, the admin Worker and scripts/
packages/env/                + top-level originAddDelayMs; console, admin, usage, email blocks
scripts/                     gen-wrangler emits three configs; admin.ts changes (§CLI); usage-backfill.ts; uid-erase.ts;
                               deploy-plan's console sink scope step
```

`legacy/` stays read-only.

## Topology

```
end users ──/v1/*──▶ hana-id-api-<env>   fetch serves /v1/* only
                       DB (hot) · USAGE_DB (ledger) · USAGE_Q · ANALYTICS · RELAYER_KEY · RATE_LIMITER
                       exports ConsoleRpc, AdminRpc (no route)
                          ▲ ConsoleRpc                      ▲ AdminRpc
partners ──▶ hana-id-console-<env> ───────┘                         │
  (console origin + auth origin)                                    │
               CONSOLE_DB · EMAIL                                   │
               exports StaffRpc (no route)                          │
                          ▲ StaffRpc                                │
staff ──Access──▶ hana-id-admin-<env> ──────────────────────────────┘
               USAGE_DB (derived + admin state tables) · EXPORTS (R2) · EMAIL · read-only NEAR RPC
```

- **Allowed call directions:** console → API, admin → API, admin → console. Nothing calls into the admin Worker, and
  the API calls neither of the others.
- **Origins.** Each of these is its own origin:
  - console (`console.origin`);
  - console auth (`console.authOrigin` = `https://auth.` + the console host);
  - admin (`admin.origin`);
  - the batch B login/vault page;
  - the API (`apiUrl`).

  The console must never share an origin with the vault, so that a console XSS can't reach key material. The API
  refuses all five as app origins.
- **Deploy order:** run the hot-DB migration (expand-only, §Data), then deploy the API, then the console, then the
  admin Worker, because a binding target must exist first. RPC changes are additive only, so an older console or admin
  keeps working against a newer API.
- **Static assets and hostname dispatch.** The console and admin Workers use
  `assets: {directory, binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true}`.
  `run_worker_first` matches paths, not hostnames, so the Worker runs first on every request and dispatches itself:
  - **Auth host** (`console.authOrigin`): only `GET /start` and `GET /callback` are handled. Every other path gets 404
    with the strict auth CSP and no body script. `env.ASSETS` is never called on this host.
  - **Console host:** `/api/*` goes to the backend. Everything else goes to `env.ASSETS.fetch(request)`.
  - **Any other host:** 404.
  - The Worker adds the §Response headers to every response, assets included.
  - The admin Worker does the same for `admin.origin`. Because the Worker runs first, it also sees the Access header
    on every request (this answers part of open question 3).
- **Admin Worker:** `workers_dev: false`, `preview_urls: false`, and Worker-level Access on all its hostnames.

### Bindings

| Worker | D1 | Services | Other | Vars | Secrets |
|---|---|---|---|---|---|
| api | `DB`, `USAGE_DB` (optional) | — | `USAGE_Q` (producer + consumer, DLQ; optional), `ANALYTICS` (Analytics Engine; optional), `RELAYER_KEY`, `RATE_LIMITER` | existing + `ORIGIN_ADD_DELAY_MS`, `REFUSED_ORIGINS` (JSON list of the five origins), `NETWORK` | existing + `USER_ID_KEY` |
| console | `CONSOLE_DB` | `API` → `{service: api, entrypoint: "ConsoleRpc"}` | `EMAIL`, `ASSETS` | `NEAR_RPC`, `SIGNER_ACCOUNT` | `CONSOLE_GOOGLE_CLIENT_SECRET`, `EMAIL_API_KEY` (if an external provider) |
| admin | `USAGE_DB` | `API` → `AdminRpc`, `CONSOLE` → `StaffRpc` | `EXPORTS` (R2), `EMAIL`, `ASSETS` | `NEAR_RPC`, `SIGNER_ACCOUNT` | `CF_ANALYTICS_TOKEN` (Account Analytics: Read, for the AE cross-check), `EMAIL_API_KEY` |

`USAGE_DB`, `USAGE_Q` and `ANALYTICS` are optional in the API's `Env`. When they are absent, capture is a no-op, so
an env without the `usage` manifest block still deploys and logins work.

Crons:

- **API:**
  - hourly (existing trigger): JWKS sync, drift detection, recording origin activations, and the owner-pool allowance
    check;
  - daily at 03:00 UTC (a new trigger): the `usage_events` and `app_users` retention batches (§Retention).
- **Console, every minute:**
  - the on-chain pending-change watcher (owners' emails);
  - the outbox;
  - origin announcements;
  - the audit reconciler;
  - invite expiry and retention.
- **Admin:**
  - every 5 min: the origin-notice sender (`AdminRpc.pendingNotices`, then `ackOriginNotice`), the on-chain scope
    watcher, and the `app_changes` and `security_events` alerting;
  - every 15 min: gas settlement;
  - hourly: rollups;
  - daily: the rate fetch, and the day and month close;
  - monthly: the R2 export.

## Data

All times are integer milliseconds UTC. All ids are a prefix + base58 of 12 random bytes unless stated. There are no
foreign keys across databases; `app_id` and `org_id` integrity is enforced in code and tests.

### Hot `DB` (`hana-id-<env>`; API only; migrations in `apps/api/migrations`)

It holds what a login reads.

**Why 0003 rebuilds no table.** 0001 declares `app_origins.app_id` and `usage.app_id` as
`REFERENCES apps(id) ON DELETE CASCADE`, and D1 enforces foreign keys. A SQLite rebuild of `apps` (create, copy,
`DROP TABLE apps`, rename) runs an implicit `DELETE FROM apps`, and that fires the cascades.
`PRAGMA defer_foreign_keys` defers only the violation checks, not the cascade actions, so such a rebuild would wipe
every origin and every legacy `usage` row. 0003 is therefore **expand-only**: `ALTER TABLE … ADD COLUMN` plus new
tables. The old `status` and `publishable_key` columns stay, so the running API keeps working between the migration
and the deploy. New tables declare no foreign key to `apps`; `BEFORE INSERT` triggers check that the app exists
instead. That way the later contract migration (0005) has nothing to cascade or violate.

Migration `0003` (expand):

```sql
CREATE TABLE scopes (
  scope_id TEXT PRIMARY KEY,                  -- contract-assigned
  org_id TEXT NOT NULL,                       -- a scope belongs to exactly one org …
  environment TEXT NOT NULL CHECK (environment IN ('test','live')),  -- … and one environment
  first_session_at INTEGER,                   -- set once, on the first ok create_session the API sees
  created_at INTEGER NOT NULL,
  assigned_at INTEGER NOT NULL                -- last org change; staff origin adds wait originAddDelayMs after it
);

ALTER TABLE apps ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_legacy';   -- a trigger keeps it = scopes.org_id
ALTER TABLE apps ADD COLUMN suspended_by INTEGER NOT NULL DEFAULT 0
  CHECK (suspended_by BETWEEN 0 AND 7);                                   -- hana=1, org=2, partner=4
ALTER TABLE apps ADD COLUMN origins_version INTEGER NOT NULL DEFAULT 0;  -- bumped when the set of origin rows changes
ALTER TABLE apps ADD COLUMN deleted_at INTEGER;                          -- soft delete (AdminRpc.deleteApp)
-- kept until 0005: apps.status (kept in sync by a trigger), apps.publishable_key (the app's first key; never updated)

CREATE TABLE app_keys (                       -- no FK to apps (see above); a BEFORE INSERT trigger checks the app
  id TEXT PRIMARY KEY,                        -- key_…
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('publishable','secret')),
  key TEXT UNIQUE,                            -- publishable only (public by design)
  key_hash BLOB UNIQUE,                       -- secret only: sha256 of 32 random bytes; shown once
  prefix TEXT NOT NULL,                       -- pk_test_ | pk_live_ | sk_test_ | sk_live_ (must match the scope's environment)
  last4 TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  revoked_at INTEGER,                         -- may be in the future: the rotation grace end
  revoked_by_kind TEXT, revoked_by TEXT,      -- for AdminRpc.restoreKey
  restored_at INTEGER, restored_by TEXT,
  CHECK ((kind = 'publishable' AND key IS NOT NULL AND key_hash IS NULL)
      OR (kind = 'secret' AND key IS NULL AND key_hash IS NOT NULL))
);

ALTER TABLE app_origins ADD COLUMN active_from INTEGER;  -- NULL = added, not yet announced (never matches); 0 = migrated
ALTER TABLE app_origins ADD COLUMN change_id TEXT;       -- origin_changes.id
ALTER TABLE app_origins ADD COLUMN added_by TEXT;
ALTER TABLE app_origins ADD COLUMN added_at INTEGER;

CREATE TABLE origin_changes (
  id TEXT PRIMARY KEY,                        -- oc_…
  app_id TEXT NOT NULL, origin TEXT NOT NULL, -- origin in ASCII (punycode) form
  op TEXT NOT NULL CHECK (op IN ('add','remove')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','cancelled','removed','done')),
                                              -- add: pending → active | cancelled; active add → removed when its origin
                                              -- is later removed. remove: always 'done' (applied in its own batch)
  proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('member','hana','system')),
  proposed_by TEXT NOT NULL, proposer_sub TEXT, proposed_at INTEGER NOT NULL, request_country TEXT,
  waiver TEXT CHECK (waiver IN ('loopback','no_session')),
  console_notified_at INTEGER,                -- ConsoleRpc.markOriginsNotified
  admin_notified_at INTEGER,                  -- AdminRpc.ackOriginNotice
  notified_at INTEGER, unlock_at INTEGER,     -- set when the second ack lands; unlock_at = active_from
  activated_recorded_at INTEGER,              -- the API cron wrote origin.activated
  approved_by_sub TEXT, approved_at INTEGER,  -- reserved for second-owner approval (deferred)
  expedited_by TEXT, expedite_reason TEXT, expedite_contact TEXT,
  cancelled_by TEXT, cancelled_at INTEGER,
  step_up_token_hash BLOB, request_id TEXT NOT NULL
);

CREATE TABLE origin_cancel_tokens (           -- one token per change per channel; every recipient of a channel shares it
  change_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('console','admin')),
  token_hash BLOB NOT NULL UNIQUE,            -- sha256 of 32 random bytes minted by that channel's Worker
  used_at INTEGER,
  PRIMARY KEY (change_id, channel)
);

CREATE TABLE app_changes (                    -- append-only ledger of every app, origin, key and status change
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, org_id TEXT NOT NULL, app_id TEXT, scope_id TEXT,
  kind TEXT NOT NULL,                         -- app.created|app.deleted|origin.*|key.*|suspension.*|scope.assigned|
                                              -- org.security_contacts
  detail_json TEXT NOT NULL,                  -- allowlisted fields only
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','hana','system','link')),
  actor_id TEXT NOT NULL,
  actor_sub TEXT,                             -- the verified step-up sub when there is one
  request_id TEXT NOT NULL, audit_seq INTEGER -- CONSOLE_DB audit_log.seq when known
);
-- BEFORE UPDATE on app_changes: RAISE(ABORT).
-- BEFORE DELETE on app_changes: RAISE(ABORT) unless OLD.at < (now − 36 months), the retention constant (§Retention).

CREATE TABLE rpc_results (                    -- idempotency: written in the same batch as the change; purged after 24 h
  request_id TEXT PRIMARY KEY, method TEXT NOT NULL, result_json TEXT NOT NULL, at INTEGER NOT NULL
);

CREATE TABLE security_events (                -- written by the API; the admin Worker emails and marks them
  id TEXT PRIMARY KEY, detected_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('drift','breaker','owner_cap','owner_allowance_low')),
  org_id TEXT, app_id TEXT, scope_id TEXT, origin TEXT,
  detail_json TEXT NOT NULL, notified_at INTEGER
);

CREATE TABLE org_security_contacts (          -- set only through AdminRpc (Hana staff, at onboarding); never by ConsoleRpc
  org_id TEXT NOT NULL, email TEXT NOT NULL,  -- lowercased
  added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, email)
);

CREATE INDEX apps_org_id ON apps (org_id);
CREATE INDEX app_keys_app_id ON app_keys (app_id);
CREATE INDEX origin_changes_app_status ON origin_changes (app_id, status);
CREATE INDEX origin_changes_unannounced ON origin_changes (status, notified_at);
CREATE INDEX app_changes_request_id ON app_changes (request_id);
CREATE INDEX app_changes_org_seq ON app_changes (org_id, seq);
CREATE INDEX security_events_unnotified ON security_events (notified_at);
-- 0001's apps_scope_id and app_origins_origin are untouched (no rebuild).

-- Triggers:
--   apps BEFORE INSERT / BEFORE UPDATE OF org_id, scope_id: abort unless a scopes row exists with the same org_id.
--   scopes AFTER UPDATE OF org_id: UPDATE apps SET org_id = NEW.org_id WHERE scope_id = NEW.scope_id.
--   apps AFTER UPDATE OF suspended_by: SET status = CASE WHEN NEW.suspended_by = 0 THEN 'active' ELSE 'suspended' END.
--   app_keys, app_origins, origin_changes BEFORE INSERT: abort unless the app exists.
```

Backfill in `0003`, in this order:

1. `INSERT INTO scopes` one row per distinct `(apps.scope_id, environment)`, where the environment comes from the key
   prefix (`pk_live_` → `live`, otherwise `test`). `org_id = 'org_legacy'`, and `first_session_at`, `created_at` and
   `assigned_at` are set to the migration time, so no existing scope gets a waiver. It is a plain `INSERT`: a scope
   with both `pk_test_` and `pk_live_` apps produces two rows with the same PK, and the migration aborts.
   sandbox-dev's `s1` and `s2` are both test apps.
2. `UPDATE apps SET suspended_by = 1 WHERE status = 'suspended'`.
3. `INSERT INTO app_keys` one row per app (`id = 'key_legacy_' || apps.id`, `key = apps.publishable_key`).
4. `UPDATE app_origins SET active_from = 0`.

`org_legacy` exists as a row in `CONSOLE_DB` (created by the console's first migration). The legacy `usage` table is
untouched by 0003. `scripts/usage-backfill.ts` copies it into `USAGE_DB` after 0003, and `0004` drops it once the
copied row counts have been verified.

**Migration and deploy order (stated in the README):**

1. `d1 migrations apply --remote` with 0003 (expand).
2. Deploy the API. The new API writes `suspended_by` (the trigger keeps `status` in step) and reads both.
3. Deploy the console, then the admin Worker.
4. After the backfill has been verified, apply 0004 (drop `usage`).
5. Once a release has run with no need to roll back, apply 0005 (contract). 0005 does these steps in this order:
   1. `CREATE app_origins_new` with no FK, copy the rows into it, `DROP TABLE app_origins` (a child, so nothing
      cascades), and rename it. Recreate `app_origins_origin` and the `(app_id, active_from)` index.
   2. `CREATE apps_new` without `status` and `publishable_key`, and copy the rows into it. Then `DROP TABLE apps`,
      which is safe because nothing references `apps` by FK any more. Rename it, then recreate `apps_scope_id`,
      `apps_org_id` and the `apps` triggers.

   A migration test on a sandbox-dev snapshot asserts that the app, origin, key and usage row counts are unchanged
   after 0003 and after 0005.

After 0003, run only the new CLI (§CLI). The old `app:origins:add` would insert rows with `active_from` NULL, which
never match.

Hana staff move the legacy apps to real orgs with `AdminRpc.assignScopeOrg`.

**Invariants (enforced in the RPC and tested):**

- Test and live apps never share a scope. Otherwise a test app with `http://localhost:*` would be an origin for live
  users' wallets in shared mode, because derivation is per scope.
- A key's prefix matches its scope's environment.
- At most 5 unrevoked keys per app.
- Only a Hana-kind caller may clear bit 1 or bit 2 of `suspended_by`. A Hana-kind caller may clear any bit.

**Login-path reads (the only hot-path change).** Still two queries, no new round trip:

```sql
SELECT a.id, a.name, a.scope_id, a.org_id, a.plan, a.suspended_by, a.status, k.key AS publishable_key,
       s.environment, s.first_session_at, p.per_minute, p.per_day, p.per_ip_minute
  FROM app_keys k JOIN apps a ON a.id = k.app_id JOIN scopes s ON s.scope_id = a.scope_id JOIN plans p ON p.id = a.plan
 WHERE k.key = ?1 AND k.kind = 'publishable' AND (k.revoked_at IS NULL OR k.revoked_at > ?2) AND a.deleted_at IS NULL;
SELECT origin FROM app_origins WHERE app_id = ?1 AND active_from <= ?2;   -- NULL never matches
```

- `appGate` step 3 becomes `suspended_by != 0 OR status != 'active'` → 403 `app_suspended`. The `status` term is
  dropped in 0005.
- A revoked key gives 401 `unknown_app`, the same as an unknown or malformed key (`handlers.ts` `appGate`, batch A).
- Loopback origins are allowed only when `environment = 'test'` (this replaces the `pk_test_` prefix test).
- The OPTIONS preflight `anyActiveAppAllowsOrigin` gets the same filters:

```sql
SELECT 1 FROM app_origins o JOIN apps a ON a.id = o.app_id JOIN scopes s ON s.scope_id = a.scope_id
 WHERE a.suspended_by = 0 AND a.status = 'active' AND a.deleted_at IS NULL AND o.active_from <= ?5
   AND (?3 = 0 OR s.environment = 'test') AND (o.origin = ?1 OR (?2 = 1 AND o.origin = ?4)) LIMIT 1;
```

The batch B login page must use the same `active_from <= now` predicate before it computes a shared-login nonce for an
opener origin. Any app-config cache (there is none today; batch B may add one) stores rows with `active_from` and
filters at check time, with a TTL of at most 10 s.

`first_session_at`: when the gate row has `first_session_at IS NULL` and `create_session` succeeds, the handler runs
`UPDATE scopes SET first_session_at = ?now WHERE scope_id = ? AND first_session_at IS NULL` in `waitUntil`. If the
write fails, the next login retries it. In steady state this costs nothing.

### `CONSOLE_DB` (`hana-id-console-<env>`; console Worker only; migrations in `apps/console/migrations`)

```sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,                        -- org_…; 'org_legacy' is created by the first migration
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),  -- frozen: every console write refused
  required_hd TEXT,                           -- optional Google Workspace domain; the hd claim must equal it
  max_pending_invites INTEGER NOT NULL DEFAULT 20,
  created_at INTEGER NOT NULL,
  plan TEXT, contract_ref TEXT, billing_email TEXT, stripe_customer_id TEXT   -- nullable, ready for billing
);
CREATE TABLE console_users (
  id TEXT PRIMARY KEY,                        -- usr_…
  provider TEXT NOT NULL, sub TEXT NOT NULL,  -- sub in clear: it must equal the on-chain Owner::Oidc
  email TEXT NOT NULL,                        -- lowercased; display and notices only, never identity
  created_at INTEGER NOT NULL, last_sign_in_at INTEGER,
  mfa_enrolled_at INTEGER,                    -- NULL = pending_mfa: can do nothing but enrol
  disabled_at INTEGER,
  UNIQUE (provider, sub)
);
CREATE TABLE passkeys (
  credential_id BLOB PRIMARY KEY,
  user_id TEXT NOT NULL, public_key BLOB NOT NULL, alg INTEGER NOT NULL,  -- COSE: -7 ES256, -8 EdDSA
  sign_count INTEGER NOT NULL, transports TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);                                            -- at most 5 unrevoked per user
CREATE TABLE members (
  org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','developer','viewer')),
  role_since INTEGER NOT NULL,
  added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);                                            -- every org keeps at least one owner
CREATE TABLE invites (
  id TEXT PRIMARY KEY,                        -- inv_…
  token_hash BLOB NOT NULL UNIQUE,            -- sha256 of 32 random bytes
  kind TEXT NOT NULL CHECK (kind IN ('member','reenrol')),
  email_norm TEXT NOT NULL,                   -- lowercased; no dot/plus normalisation
  bound_sub TEXT,                             -- reenrol: required, must equal the token's sub
  org_id TEXT, new_org_name TEXT,             -- exactly one (CHECK); new_org_name creates the org on acceptance
  role TEXT NOT NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('hana','member')), created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,  -- member: +7 d; reenrol: +24 h
  accepted_at INTEGER, accepted_user_id TEXT, accepted_by_sub TEXT,
  revoked_at INTEGER, expired_logged_at INTEGER,
  CHECK ((org_id IS NULL) <> (new_org_name IS NULL)),
  CHECK (kind <> 'reenrol' OR bound_sub IS NOT NULL)
);
CREATE TABLE auth_flows (
  state_hash BLOB PRIMARY KEY,                -- sha256(state); state is 32 random bytes
  start_hash BLOB NOT NULL UNIQUE,            -- sha256(f), the handle in <authOrigin>/start?f=
  purpose TEXT NOT NULL CHECK (purpose IN ('login','step_up')),
  pre_cookie_hash BLOB,                       -- login: __Host-hana_pre on the console origin (checked at /api/auth/complete)
  af_cookie_hash BLOB,                        -- __Host-hana_af on the auth origin, set by /start (checked at /callback)
  pkce_verifier TEXT NOT NULL,                -- server-side; S256 challenge sent to Google
  nonce TEXT NOT NULL,                        -- server-chosen, see §Nonce layouts
  scope TEXT NOT NULL CHECK (scope IN ('openid email','openid')),
  invite_id TEXT, pending_action_id TEXT, login_hint TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,   -- +5 min
  started_at INTEGER, used_at INTEGER,
  CHECK (purpose <> 'login' OR pre_cookie_hash IS NOT NULL)
);
CREATE TABLE handoff_codes (
  code_hash BLOB PRIMARY KEY,                 -- sha256 of 32 random bytes
  state_hash BLOB NOT NULL, result_json TEXT NOT NULL,       -- allowlisted: user id, purpose, outcome; never a token
  expires_at INTEGER NOT NULL,                -- +60 s
  used_at INTEGER
);
CREATE TABLE webauthn_challenges (
  challenge_hash BLOB PRIMARY KEY,
  user_id TEXT NOT NULL, session_hash BLOB, pending_action_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','enrol','step_up')),
  expires_at INTEGER NOT NULL,                -- +60 s (step_up: the pending action's expiry)
  used_at INTEGER
);
CREATE TABLE console_sessions (
  id_hash BLOB PRIMARY KEY,                   -- sha256 of the 32-byte cookie value
  user_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('pre_mfa','enrol','active')),
  hd TEXT, google_amr TEXT, google_auth_time INTEGER,  -- recorded when present, never relied on
  auth_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,  -- written at most every 5 min
  absolute_expires_at INTEGER NOT NULL,       -- auth_at + 12 h (pre_mfa/enrol: + 10 min)
  revoked_at INTEGER,
  country TEXT, asn INTEGER, ip_prefix TEXT   -- /24 or /48; staff-only forensics, kept 90 days
);
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,                        -- act_…
  user_id TEXT NOT NULL, session_hash BLOB NOT NULL, org_id TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- see §Step-up
  action_json TEXT NOT NULL,                  -- canonical JSON; the server applies exactly this
  digest BLOB NOT NULL,                       -- d (32 bytes), see §Nonce layouts
  passkey_salt BLOB NOT NULL,                 -- 16 random bytes; challenge = sha256(domain ‖ d ‖ salt)
  google_nonce TEXT NOT NULL,                 -- the nonce the Google flow must carry (deterministic from d)
  scope_id TEXT, near_action_nonce INTEGER, near_args BLOB,  -- owner actions only
  passkey_ok_at INTEGER, used_at INTEGER, outcome TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,  -- +5 min
  request_id TEXT NOT NULL
);
CREATE TABLE app_requests (                   -- partner asks; Hana reviews and registers
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, requested_by TEXT NOT NULL,
  name TEXT NOT NULL, environment TEXT NOT NULL CHECK (environment IN ('test','live')),
  mode TEXT NOT NULL CHECK (mode IN ('own','shared','both')),
  client_ids_json TEXT NOT NULL, origins_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  reviewed_by TEXT, reviewed_at INTEGER, review_note TEXT, app_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE scope_watch (                    -- console pending-change watcher state (owners' emails)
  scope_id TEXT NOT NULL, change_id INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, notified_at INTEGER,
  PRIMARY KEY (scope_id, change_id)
);
CREATE TABLE console_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- e.g. the changesSince cursor
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  parent_seq INTEGER,                         -- outcome rows point at their write-ahead row
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','hana','system','link')),
  actor_id TEXT NOT NULL, actor_email TEXT, actor_sub TEXT,
  org_id TEXT, app_id TEXT,
  action TEXT NOT NULL, target TEXT,
  details_json TEXT NOT NULL,                 -- allowlisted fields only: no tokens, secrets, cookies or full IPs
  step_up_id TEXT, request_id TEXT NOT NULL, near_tx TEXT,
  ip_prefix TEXT, country TEXT, colo TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','ok','failed'))
);
CREATE INDEX audit_log_org_seq ON audit_log (org_id, seq);
CREATE INDEX audit_log_request_id ON audit_log (request_id);
-- BEFORE UPDATE: RAISE(ABORT). BEFORE DELETE: RAISE(ABORT) unless OLD.at < (now − 36 months), the retention constant.
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY, audit_seq INTEGER NOT NULL, template TEXT NOT NULL,
  to_email TEXT,                              -- cleared 30 days after a final status
  to_hash BLOB NOT NULL, params_json TEXT NOT NULL,   -- may hold a cancel token until sent; cleared with to_email
  blocking_change_id TEXT,                    -- origin add whose clock waits for this send
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  provider_message_id TEXT, error_code TEXT
);
```

There is no staff table and no org-to-app table. `apps.org_id` (through `scopes.org_id`) in the hot DB is the single
source of truth for which app belongs to which org.

### `USAGE_DB` (`hana-id-usage-<env>`; migrations in `apps/api/migrations-usage`)

- **API-owned tables:** `usage_events` and `app_users`. The API writes them through the queue consumer and the
  direct-write fallback, and runs their retention batches from its daily cron.
- **Admin-owned tables:** the admin Worker writes every derived table plus its own state tables (`admin_state`,
  `admin_scope_snapshot`, `admin_scope_watch`).
- **Exemption:** `scripts/uid-erase.ts` is an operator script. It goes through the same trigger-allowed statements.
- **Test:** each Worker's SQL may touch only its own tables, with the retention and erase statements as the only
  writes to `usage_events` after insert.

```sql
CREATE TABLE usage_events (                   -- the ledger; insert-only apart from the retention writes
  request_id TEXT PRIMARY KEY, v INTEGER NOT NULL,
  at_ms INTEGER NOT NULL, day TEXT NOT NULL,  -- day = UTC date of at_ms (request start)
  received_at INTEGER NOT NULL,
  org_id TEXT NOT NULL,                       -- the app's (or scope's) org when the event was produced
  app_id TEXT, scope_id TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('session','derive','revoke','owner_action')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','rejected','error')),
  code TEXT, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
  relayed INTEGER NOT NULL, near_tx TEXT,
  relay_gas_burnt INTEGER, relay_tokens_burnt TEXT,  -- provisional (EXECUTED_OPTIMISTIC); never billed
  gas_status TEXT NOT NULL CHECK (gas_status IN ('pending','none')),   -- billed gas comes from gas_settlements
  uid BLOB                                    -- 16 bytes; ok session/derive only; NULLed at month close + 35 d
);
CREATE INDEX usage_events_app_day ON usage_events (app_id, day, endpoint, outcome);
CREATE INDEX usage_events_scope_day ON usage_events (scope_id, day);
CREATE INDEX usage_events_gas ON usage_events (gas_status, at_ms);
CREATE INDEX usage_events_received ON usage_events (received_at);
-- BEFORE UPDATE on usage_events: RAISE(ABORT) unless the only change is uid from a value to NULL.
-- BEFORE DELETE on usage_events: RAISE(ABORT) unless OLD.day < date('now', '-400 days').
CREATE TABLE app_users (
  app_id TEXT NOT NULL, uid BLOB NOT NULL, first_seen_day TEXT NOT NULL, last_seen_day TEXT NOT NULL,
  PRIMARY KEY (app_id, uid)
) WITHOUT ROWID;
CREATE TABLE gas_settlements (                -- admin: the billed gas of every relayed event, from tx at FINAL
  request_id TEXT PRIMARY KEY, near_tx TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('final','unsettled')),
  gas_burnt INTEGER, tokens_burnt TEXT, settled_at INTEGER NOT NULL
);
CREATE TABLE usage_daily (
  org_id TEXT NOT NULL, app_id TEXT NOT NULL, day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ledger','legacy')),
  -- {session,derive,revoke} × {ok, rejected_relayed, rejected_unrelayed, error}: 12 INTEGER columns, e.g.
  session_ok INTEGER, session_rejected_relayed INTEGER, session_rejected_unrelayed INTEGER, session_error INTEGER,
  -- … derive_*, revoke_* …
  gas_ok TEXT, gas_rejected TEXT, gas_error TEXT,                       -- exact decimal TEXT
  burnt_yocto_ok TEXT, burnt_yocto_rejected TEXT, burnt_yocto_error TEXT,
  new_users INTEGER, session_p50_ms INTEGER, session_p95_ms INTEGER, derive_p50_ms INTEGER, derive_p95_ms INTEGER,
  unsettled INTEGER, computed_at INTEGER NOT NULL, closed_at INTEGER,
  PRIMARY KEY (app_id, day, source)
);
CREATE INDEX usage_daily_org_day ON usage_daily (org_id, day);
CREATE TABLE usage_daily_failures (org_id TEXT, app_id TEXT, day TEXT, endpoint TEXT, code TEXT, n INTEGER,
  PRIMARY KEY (app_id, day, endpoint, code));
CREATE TABLE usage_daily_scope (              -- owner actions (app_id NULL in the ledger)
  org_id TEXT NOT NULL, scope_id TEXT, day TEXT, ok INTEGER, rejected_relayed INTEGER, rejected_unrelayed INTEGER,
  error INTEGER, gas_ok TEXT, gas_rejected TEXT, gas_error TEXT,
  burnt_yocto_ok TEXT, burnt_yocto_rejected TEXT, burnt_yocto_error TEXT,
  unsettled INTEGER, closed_at INTEGER, PRIMARY KEY (scope_id, day));
CREATE TABLE usage_monthly (
  org_id TEXT NOT NULL, app_id TEXT, month TEXT,   -- YYYY-MM
  mau INTEGER, new_users INTEGER, totals_json TEXT,   -- same counters as daily, exact TEXT sums
  session_p50_ms INTEGER, session_p95_ms INTEGER, derive_p50_ms INTEGER, derive_p95_ms INTEGER,
  closed_at INTEGER, PRIMARY KEY (app_id, month));
CREATE INDEX usage_monthly_org ON usage_monthly (org_id, month);
CREATE TABLE usage_adjustments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, app_id TEXT, scope_id TEXT, day TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('late_event','correction','legacy')),
  delta_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, applied_month TEXT);
CREATE TABLE near_usd_rates (
  day TEXT PRIMARY KEY, usd_micros INTEGER NOT NULL, source TEXT NOT NULL,
  entered_by TEXT,                            -- NULL = fetched
  fetched_at INTEGER NOT NULL);
CREATE TABLE ae_reconcile (app_id TEXT, day TEXT, ledger_n INTEGER, ae_n REAL, gap_ok INTEGER, alerted_at INTEGER,
  PRIMARY KEY (app_id, day));
CREATE TABLE statements (
  org_id TEXT, month TEXT, csv BLOB NOT NULL, sha256 BLOB NOT NULL,
  issued_by TEXT NOT NULL, issued_at INTEGER NOT NULL, PRIMARY KEY (org_id, month));
CREATE TABLE admin_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- changesSince cursor, last-run markers
CREATE TABLE admin_scope_snapshot (           -- last seen on-chain owners/clients/allow_shared per scope
  scope_id TEXT PRIMARY KEY, owners_json TEXT NOT NULL, clients_json TEXT NOT NULL, allow_shared INTEGER NOT NULL,
  seen_at INTEGER NOT NULL);
CREATE TABLE admin_scope_watch (              -- admin pending-change watcher state (security emails)
  scope_id TEXT NOT NULL, change_id INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, notified_at INTEGER,
  PRIMARY KEY (scope_id, change_id));
-- Triggers: UPDATE/DELETE on usage_daily / usage_daily_scope / usage_monthly rows with closed_at NOT NULL abort.
-- statements: UPDATE and DELETE always abort (rows are inserted once, after the month closes).
-- near_usd_rates: UPDATE and DELETE abort when the day's month has a closed usage_monthly row.
```

`org_id` is denormalised into the events and derived rows, so `ConsoleRpc.usage` and statements never touch the hot
DB. The API stamps `org_id` on each event from the gate row. The admin rollup copies it. When `assignScopeOrg` moves
a scope, the admin cron rewrites `org_id` on that scope's rows that are not closed yet. Closed rows keep the org they
closed under.

## Nonce and digest layouts

`‖` is concatenation. A domain string is its raw UTF-8 bytes with no length prefix, as in the contract.
`borsh(String)` is a u32 LE length followed by the UTF-8 bytes. `borsh(Vec<String>)` is a u32 LE count followed by
the elements. `b64url` has no padding.

| Purpose | Value | Checked by |
|---|---|---|
| Console login | `b64url(sha256("hana-console/login/v1" ‖ random32))`, stored in `auth_flows` | console |
| Generic step-up | `d = sha256("hana-console/step-up/v1" ‖ sha256(session cookie) ‖ sha256(JCS(action)))`. The Google nonce is `b64url(d)` | console |
| Origin change (adds, and the removes sent with them) | `d = sha256("hana-id/origin-change/v1" ‖ borsh(signer) ‖ borsh(app_id) ‖ borsh(sorted add) ‖ borsh(sorted remove) ‖ origins_version u64 LE)`. The Google nonce is `b64url(d)` | console **and API** |
| Origin approve | Reserved: `hana-id/origin-approve/v1`. Not built in batch C (approval is deferred) | — |
| Owner action | the contract layout: `"hana-id/owner-action/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(method) ‖ borsh(args without auth) ‖ action_nonce u64 LE`. The step-up `d` is the generic one over `{kind:"owner_action", scope_id, method, args_b64, action_nonce}` | console, API precheck, contract |
| Client proof | the contract layout: `"hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE` | console, API precheck, contract |
| Passkey challenge (every step-up) | `sha256("hana-console/passkey-step-up/v1" ‖ d ‖ passkey_salt)`, where `passkey_salt` is 16 random bytes stored per `pending_actions` row. It is single use and marked used on `passkey/verify` | console |

- `JCS` is RFC 8785 canonical JSON.
- Every action object contains `v: 1`, `env` (the manifest `name`) and `org_id`, so a digest can't be replayed across
  environments or orgs.
- Origins are sorted by byte order after `normaliseOrigin` (ASCII form).
- `d` is deterministic, so the API can recompute the Google nonce. The passkey challenge is random per pending action,
  so a retried action gets a fresh challenge, and an assertion captured for one pending action can't satisfy another.
- The prefixes keep login, step-up, origin and owner-action tokens apart. An on-chain owner token is public, and it
  can never satisfy a login flow, because the login nonce is random and server-held.
- `packages/console-core` implements every layout. It is tested against `test_fixture.json` and the worked examples
  in `docs/contract-interface.md`, and against fixed vectors for the new layouts that an independent Node script in
  the `gen-fixtures.mjs` style produces.

## Partner sign-in (console Worker)

### Google client setup

- The console OAuth client (`consoleAudiences`) has **no authorized JavaScript origins**, so GIS, One Tap and FedCM
  can't mint tokens for it.
- Its only redirect URI is `console.redirectUri` = `<authOrigin>/callback`.
- The auth origin serves no script and no assets. It sends `Referrer-Policy: no-referrer`, `Cache-Control: no-store`
  and the CSP `default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`.
- **Why the separate origin.** A console-client token with a chosen nonce can authorise owner actions. Before this
  spec it could also open a session in `global`; §Address impact moves the console audiences to a sink scope. Without
  the separate origin, XSS on the console origin could start an implicit flow and read the fragment.
- **Implicit-flow guard.** Google also accepts `response_type=id_token` for any registered redirect URI. So the
  callback must never forward a fragment: it sends a 3xx only for a request that has a valid `state` and `code` (see
  Callback below). Every success Location ends with an explicit empty fragment (`#`), so the browser can't carry an
  inherited fragment onto the next page.

### Code flow

1. **Create.** The SPA calls `POST /api/auth/start {purpose: "login", invite?: "<b64url token>"}`.
   - The SPA reads the invite token from `…/invite#t=<b64url>` (a fragment, so it stays out of logs and Referer).
   - The server creates an `auth_flows` row:
     - a random `state`, a random start handle `f`, and a PKCE S256 verifier;
     - the login nonce and `scope = 'openid email'`;
     - `invite_id` if the invite hash matches a live invite.
   - It sets `__Host-hana_pre` on the console origin (32 random bytes;
     `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`). The cookie is Lax because Strict cookies are withheld
     across the Google redirect chain.
   - It returns `{startUrl: "<authOrigin>/start?f=<b64url f>"}`. The SPA navigates there top-level.
2. **Start.** `GET <authOrigin>/start?f=`.
   - The flow must exist, be unexpired and not yet started. It is marked `started_at` in the same statement.
   - The server sets `__Host-hana_af` on the auth origin (32 random bytes;
     `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`) and stores its hash in `af_cookie_hash`.
   - It 303s to Google with:
     - `response_type=code`, `scope` from the flow, `prompt=select_account`;
     - `state`, `nonce`, `code_challenge` and `code_challenge_method=S256`;
     - `login_hint`: the invite email or, on a re-login or step-up, the session sub.
   - Anything else gets the static 400 page.
3. **Callback.** `GET <authOrigin>/callback`.
   - **Refusals first.** The request is refused unless every one of these holds:
     - the query has both `code` and `state`;
     - `sha256(state)` matches a started, unused, unexpired flow;
     - `sha256(__Host-hana_af)` equals its `af_cookie_hash`.

     A refusal is a static 400 page (`Cache-Control: no-store`, the auth CSP, no `Location`) with a plain link back to
     `<console.origin>/signin#`. A Google `error=` response gets the same page. The callback never redirects on an
     error.
   - Marks the flow used in the same statement as the lookup.
   - Exchanges the code at Google's token endpoint with `CONSOLE_GOOGLE_CLIENT_SECRET` and the PKCE verifier.
   - Verifies the ID token with `packages/oidc`:
     - RS256 against Google's JWKS;
     - `iss`, and `aud` in `consoleAudiences`;
     - `nonce` equals the flow's nonce;
     - `exp`;
     - `iat` no more than 120 s old.
   - **Email claims, by scope.**
     - When the flow's scope is `openid email` (login and generic step-ups), `email` must be present and
       `email_verified === true`.
     - When the scope is `openid` (owner actions), the token must have no `email` claim, so that no email reaches the
       chain. This also catches Google ignoring the scope (open question 1).
   - **Login:** it writes a `handoff_codes` row (60 s) and answers 303 to
     `<console.origin>/api/auth/complete?h=<b64url code>#`.
   - **Step-up:** see §Step-up.
   - The ID token never reaches page JavaScript and is not stored.
4. **Complete.** `GET /api/auth/complete?h=`.
   - The handoff code must be unused, under 60 s old, and its flow's `pre_cookie_hash` must equal
     `sha256(__Host-hana_pre)`.
   - The server then applies the membership rules below.
   - It creates a `console_sessions` row with `stage = pre_mfa` (or `enrol`), sets `__Host-hana_cs`, clears the
     pre-flow cookie, and 303s to `/signin/passkey`.
5. **Passkey.** `POST /api/auth/passkey/options` returns a random 32-byte challenge (60 s, single use).
   `POST /api/auth/passkey/verify` checks:
   - `userVerification` required;
   - the RP ID (the console host) and its hash;
   - the origin equals `console.origin`;
   - the credential belongs to the user and is unrevoked;
   - the signature;
   - the sign counter must increase when either value is non-zero.

   On success the pre-MFA row is deleted and a new session id is issued with `stage = active` (rotation at sign-in).

`verifyIdToken` and `VerifiedToken` gain `email`, `email_verified`, `iat`, `hd`, `azp`, `amr` and `auth_time`. Existing
API callers ignore them.

### Membership rules at sign-in

- **Before any batch,** the server looks up `console_users` by `(provider, sub)`. If the user exists and
  `disabled_at IS NOT NULL`, the response is 403 `user_disabled` (audited), and no invite is consumed.
- **An invite token bound to this flow is always processed,** even when the user already has memberships. That is
  how an existing member accepts an invite into a second org: they open the invite link and sign in. If the user is
  already a member of the invite's org, the response is 409 `already_member`, and the invite is left unconsumed.
- **No invite:** an existing user with at least one membership signs in. Memberships in orgs whose `required_hd`
  doesn't equal the token's `hd` are ignored for the session. A user with no usable membership gets 403
  `not_invited`. The refusal is written to `audit_log` (actor `system`, the email's sha256 only), and no user row is
  created.
- **`member` invite acceptance** is one D1 batch. Every user id is resolved from `(provider, sub)` inside the batch,
  so an existing `console_users` row is reused and never orphaned. `?nu` is a fresh `usr_` id, used only when the row
  doesn't exist yet.

  ```sql
  -- V(i) = the validity predicate on invites row i:
  --   i.token_hash = ?h AND i.kind = 'member' AND i.email_norm = ?e AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  --   AND i.expires_at > ?t
  --   AND (i.org_id IS NULL OR EXISTS (SELECT 1 FROM orgs o WHERE o.id = i.org_id AND o.status = 'active'
  --                                    AND (o.required_hd IS NULL OR o.required_hd = ?hd)))
  --   AND NOT EXISTS (SELECT 1 FROM console_users u WHERE u.provider = ?p AND u.sub = ?sub AND u.disabled_at IS NOT NULL)
  INSERT INTO console_users (id, provider, sub, email, created_at)
       SELECT ?nu, ?p, ?sub, ?e, ?t FROM invites i WHERE V(i)
       ON CONFLICT (provider, sub) DO NOTHING;
  UPDATE invites SET accepted_at = ?t, accepted_by_sub = ?sub,
         accepted_user_id = (SELECT id FROM console_users WHERE provider = ?p AND sub = ?sub)
   WHERE V(invites);
  INSERT INTO orgs (id, name, status, created_at)
       SELECT ?newOrg, new_org_name, 'active', ?t FROM invites
        WHERE token_hash = ?h AND accepted_at = ?t AND accepted_by_sub = ?sub AND new_org_name IS NOT NULL;
  INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at)
       SELECT COALESCE(i.org_id, ?newOrg), i.accepted_user_id, i.role, ?t, i.created_by, ?t FROM invites i
        WHERE i.token_hash = ?h AND i.accepted_at = ?t AND i.accepted_by_sub = ?sub
       ON CONFLICT (org_id, user_id) DO NOTHING;
  INSERT INTO audit_log (…) SELECT … 'invite.accepted' … FROM invites
        WHERE token_hash = ?h AND accepted_at = ?t AND accepted_by_sub = ?sub;
  ```

  D1 runs a batch as one serialised transaction. A second concurrent acceptance therefore sees `accepted_at` set, and
  inserts nothing: no user, org, member or audit row. The `console_users` insert is guarded by the same predicate as
  the UPDATE, so a refused acceptance creates no user row. Email matching is an exact match after lowercasing, with no
  Gmail dot or plus normalisation. After the batch, the server reads the invite. A session is created only if
  `accepted_by_sub = sub`. Otherwise the response is 403 `invite_invalid`, with one generic code that doesn't say
  why.
- **`reenrol` invite acceptance** is its own batch. The user must exist, and `bound_sub` must equal the token's `sub`.

  ```sql
  UPDATE invites SET accepted_at = ?t, accepted_by_sub = ?sub,
         accepted_user_id = (SELECT id FROM console_users WHERE provider = ?p AND sub = ?sub AND disabled_at IS NULL)
   WHERE token_hash = ?h AND kind = 'reenrol' AND email_norm = ?e AND bound_sub = ?sub AND accepted_at IS NULL
     AND revoked_at IS NULL AND expires_at > ?t
     AND EXISTS (SELECT 1 FROM console_users WHERE provider = ?p AND sub = ?sub AND disabled_at IS NULL);
  INSERT INTO audit_log (…) SELECT … 'invite.accepted' … FROM invites
        WHERE token_hash = ?h AND accepted_at = ?t AND accepted_by_sub = ?sub;
  ```

  It inserts no member. On success the server starts a session with `stage = enrol` (10 min).
- **Passkey enrolment.**
  - A first passkey can be registered only in a session created by consuming an invite: a `member` invite for a user
    with no passkey, or a `reenrol` invite. Such a session has `stage = enrol` and lasts 10 min.
  - Further passkeys need a step-up. Removing a passkey also needs a step-up, and a user can't remove their last one.
  - Members are prompted to register a second passkey.
  - If enrolment is abandoned, a new invite is needed: a `reenrol` invite from a Hana admin, or from an org owner with
    step-up, the latter only for a member who has never enrolled.

### Sessions

- **Cookie:** `__Host-hana_cs`, 32 random bytes, `Secure; HttpOnly; SameSite=Strict; Path=/`. D1 stores only its
  sha256. It exists only on the console origin, never on the auth origin.
- **Lifetime:** 2 h idle, with `last_seen_at` written at most every 5 min, and 12 h absolute. `pre_mfa` and `enrol`
  sessions last 10 min and can reach only the passkey and enrolment routes and `GET /api/me`.
- **Roles are read from `members` on every request.** These delete the user's sessions at once:
  - removing a member;
  - changing a role;
  - resetting passkeys;
  - disabling a user;
  - freezing their only org.
- **CSRF.** Every non-GET request needs `Sec-Fetch-Site: same-origin`, `Origin` exactly equal to `console.origin`,
  the header `x-hana-console: 1`, and `content-type: application/json`. Otherwise the response is 403 `csrf`.
- **Rate limits:** `/api/auth/*` and the auth-origin routes, 10 per minute per IP (IPv6 /64), and 20 failed passkey
  assertions per user per hour. See open question 34.

## Roles and permissions

`H` is a Hana admin through the admin console. "On-chain" means the member's `sub` must also be an `Owner::Oidc` of
the app's scope, checked by the API or the contract. "Email" means the console's email to every org owner and admin
(proposer included) unless stated. "+sec" adds the admin Worker's notice to Hana's security alias and the org's
security contacts.

| Action | owner | admin | developer | viewer | H | Step-up | Delay | Email |
|---|---|---|---|---|---|---|---|---|
| View apps, origins, pending changes, publishable keys, usage, statements | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| View the audit log and members | ✓ | ✓ | ✓ | — | ✓ | — | — | — |
| Submit an app request | ✓ | ✓ | ✓ | — | — | — | — | +sec |
| Create an app (after review) | — | — | — | — | ✓ | — | — | ✓ +sec |
| Add an origin | ✓ on-chain | ✓ on-chain | — | — | ✓ (no step-up) | ✓ (not H) | ✓ | ✓ +sec, both fail closed |
| Expedite a member-proposed add | — | — | — | — | ✓ (reason + out-of-band contact) | — | ends it | ✓ +sec |
| Cancel a pending add | ✓ | ✓ | — | — | ✓ | — | — | ✓ +sec |
| Remove an origin | ✓ | ✓ | — | — | ✓ | — | — | ✓ +sec |
| Suspend an app (bit 4 / bit 1) | ✓ | ✓ | — | — | ✓ | — | — | ✓ +sec |
| Resume an app (members clear bit 4 only) | ✓ | ✓ | — | — | ✓ (bits 1, 2, 4) | ✓ (not H) | — | ✓ +sec |
| Create or rotate a publishable key | ✓ | ✓ | — | — | ✓ | ✓ (not H) | — | ✓ |
| Create a secret key | ✓ | ✓ | — | — | — | ✓ | — | ✓ +sec |
| Revoke a key | ✓ | ✓ | — | — | ✓ | — | — | ✓ +sec |
| Restore a key revoked in the last 7 days | — | — | — | — | ✓ | — | — | ✓ +sec |
| On-chain owner action (propose, cancel, remove_client, disable_shared_login; includes own vs shared client mode) | ✓ on-chain | ✓ on-chain | — | — | — | ✓ | contract timelock | ✓ +sec |
| `execute_change` (anyone may call it) | ✓ | ✓ | — | — | ✓ | — | — | ✓ +sec |
| Invite (role ≤ own; owners only) | ✓ | — | — | — | ✓ any org, any role | ✓ (not H) | — | ✓ to other owners |
| Revoke an invite | ✓ | — | — | — | ✓ | — | — | — |
| Change a role, remove a member, grant ownership | ✓ | — | — | — | ✓ | ✓ (not H) | — | ✓ |
| Org policy (`required_hd`, notification settings) | ✓ | — | — | — | ✓ | ✓ (not H) | — | ✓ |
| Set the org's security contacts | — | — | — | — | ✓ | — | — | ✓ to old and new contacts |
| Add or remove one's own passkey | self | self | self | self | — | ✓ | — | ✓ to self |
| Reset a member's passkeys, issue a reenrol invite | — | — | — | — | ✓ (out-of-band check) | — | — | ✓ to the member + owners |
| Freeze or unfreeze an org; suspend an org (bit 2) | — | — | — | — | ✓ | — | — | ✓ +sec |
| Assign a legacy scope to an org; delete an app | — | — | — | — | ✓ | — | — | ✓ +sec |

- The last owner of an org can't be removed or demoted.
- A frozen org refuses every console write except cancel, origin removal and suspension.
- Secret keys are refused on every management route. They are never a console credential.

## Step-up

- **Flow.**
  1. `POST /api/orgs/:org/actions {kind, params}`. The server checks the role, then builds the canonical action. It
     computes `digest`, `google_nonce` and a fresh `passkey_salt` per §Nonce layouts and stores `pending_actions`
     (5 min). It returns `{id, kind, decoded, expiresAt}`, and the UI shows the decoded action.
  2. **Passkey.** `POST /api/actions/:id/passkey/options` gives the salted challenge. It is single use, tracked in
     `webauthn_challenges` with `purpose = step_up`. `POST /api/actions/:id/passkey/verify` marks the challenge used
     and sets `passkey_ok_at`, at most once.
  3. **Google.** `POST /api/actions/:id/google` creates an `auth_flows` row with `purpose = step_up`,
     `pending_action_id`, `nonce = google_nonce`, `login_hint = session sub` and `prompt=select_account`. The scope
     is `openid` for owner actions and `openid email` for every other kind. The response is
     `{startUrl: "<authOrigin>/start?f=…"}`, and the SPA navigates there top-level. `/start` sets `__Host-hana_af` on
     the auth origin, exactly as for login.
  4. **Callback.** On the auth origin, the server checks:
     - the callback checks above, including the `__Host-hana_af` cookie, so a flow started in one browser can't be
       completed in another;
     - the email claims for the flow's scope;
     - `sub` equals the session user's sub;
     - `iat` no more than 120 s old;
     - the `pending_actions` row has `passkey_ok_at` set, `used_at IS NULL`, and is unexpired;
     - **session liveness:** `pending_actions.session_hash` matches a `console_sessions` row with `stage = 'active'`,
       `revoked_at IS NULL`, `absolute_expires_at > now` and `last_seen_at > now − 2 h`. The session cookie itself is
       not available on the auth origin; the hash stored at step 1 stands in for it.

     It then **executes the stored action inside the callback request**, so the token is used once and never stored.
     It answers 303 to `<console.origin>/actions/:id#`, and the page reads the outcome from `GET /api/actions/:id`.
- **Single use.** `UPDATE pending_actions SET used_at = ? WHERE id = ? AND used_at IS NULL AND passkey_ok_at IS NOT NULL
  AND expires_at > ?` must change one row.
  - For console-DB-only actions (invites, roles, members, policy, passkeys), the consumption, the change and the audit
    row are one guarded batch. A lost race writes nothing.
  - For hot-DB and on-chain actions, see §Audit (write-ahead).
- **What the fresh Google token proves.** That the Google account still exists and that this Google session approved
  this exact digest, for example that the partner hasn't offboarded the staffer from Workspace. It doesn't prove the
  person is present: Google offers no forced re-authentication, so a live Google session confirms in one click. The
  passkey is what adds presence.
- **Audit and email.** Every step-up action writes an audit row with `step_up_id` and emails the other org owners.
- **Step-up kinds:**
  - `origin.add` (with any removes in the same change);
  - `app.resume`;
  - `key.create_publishable`, `key.rotate_publishable`, `key.create_secret`;
  - `owner_action`;
  - `invite.create`, `invite.reenrol`;
  - `member.role`, `member.remove`;
  - `org.policy`;
  - `passkey.add`, `passkey.remove`.

## Allowed origins

### Input rules (`normaliseOrigin` in `packages/console-core`, used by the API, the console and the CLI)

- **Origin only:** http(s), no credentials, path, query or fragment, lowercased host, default port dropped, trailing
  dot removed.
- **ASCII form only.** The host is stored and compared in its ASCII (punycode) form, as the WHATWG URL parser
  produces it. Any `xn--` label is flagged with a warning in the console, in both notices and in the admin console,
  with the decoded Unicode form shown beside the ASCII form. On `live` scopes, a label that mixes scripts (for
  example Latin and Cyrillic) is refused with `origin_refused` (`reason: mixed_script`).
- **Production envs** (`NETWORK = mainnet`): `https` only, no wildcards, no loopback.
- **Non-production envs:**
  - Loopback (`localhost`, `127.x`, `[::1]`) and the literal `http://localhost:*` are allowed only on apps in a
    `test` scope.
  - Other plain `http` is refused.
  - `*` appears nowhere except in that literal.
- **Always refused:** every origin in `REFUSED_ORIGINS` (`console.origin`, `console.authOrigin`, `admin.origin`, the
  batch B login/vault origin and `apiUrl`). The code is `origin_refused` with a reason.
- At most 50 active-or-pending origins per app.
- **Delay config.** The API refuses every origin add with `internal` when `ORIGIN_ADD_DELAY_MS` is missing or out of
  range (60 000 to 7 d; ≥ 24 h when `NETWORK = mainnet`).

### Lifecycle

| From | Event | To | `active_from` | Bumps `origins_version` |
|---|---|---|---|---|
| — | add (member, with step-up verified by the API; or H) | `pending`, not announced | NULL | yes |
| pending (not announced) | the console notice is accepted (`markOriginsNotified`) | `pending` | NULL, or set if the admin ack is already there | no |
| pending (not announced) | the admin notice is accepted (`ackOriginNotice`) | `pending` | NULL, or set if the console ack is already there | no |
| pending | the second ack lands | `pending`, announced | `now + originAddDelayMs`, or `now` if a waiver applies at this moment | no |
| pending | the clock passes `active_from` | `active` by predicate. The API's hourly cron records it (`status = 'active'`, `activated_recorded_at`, `app_changes origin.activated`) | unchanged | no |
| pending | H expedite | `active` | `now` | no |
| pending | cancel (owner, admin, H, or an emailed link) | `cancelled`, row deleted from `app_origins` | — | yes |
| active | remove | the add's change becomes `removed`, a `remove` change with status `done` is written, row deleted | — | yes |
| removed | re-add | a new `add` | NULL | yes |

- `origins_version` changes only when the set of `app_origins` rows changes (add, remove, cancel). Notices,
  activation and expedite don't bump it, so they never invalidate another owner's step-up in flight with
  `version_conflict`.
- Every row in the table writes `app_changes` in the same batch, including the activation that the cron records.
- **Combined changes.** Removes sent in the same `origin.add` change take effect at once, in the same batch as the
  pending adds.
- **Activation emails.** The console's audit reconciler reads `origin.activated` rows through
  `ConsoleRpc.changesSince`, writes the `origin.activated` audit row and queues `origin_activated` (best effort).

**Waivers.** Each is recorded in `origin_changes.waiver` and still notified through both channels.

- `loopback`: a loopback origin on a test-scope app in a non-production env.
- `no_session`: `scopes.first_session_at IS NULL` when `active_from` is set, and either:
  - the proposer is a member (the add was verified with a step-up), or
  - the actor is Hana-kind, and the origin is one of the initial origins of an `AdminRpc.createApp` (or CLI
    `app:create`) call that created the `scopes` row in the same batch.

  A staff add on an existing scope always gets the full delay.

**API verification of an add (`ConsoleRpc.changeOrigins`).** In order, failing closed:

1. RS256 signature, through `packages/oidc`.
2. `(provider, aud)` is in the on-chain `console_audiences`.
3. `iat` is no more than 300 s old.
4. `nonce` equals the origin-change layout recomputed from the request's `appId`, `add`, `remove` and the stored
   `origins_version`, which must equal `expectedVersion`.
5. `sub` is an `Owner::Oidc` of the app's scope, read with an **uncached** `get_scope`. If NEAR RPC is down the
   answer is `near_unavailable`.
6. `sha256(jwt)` is reserved in the `owner-actions:tokens` limiter until `exp`. A reuse gets `token_used`.

**Notify, failing closed on both channels.**

- **Console channel.**
  - The console mints one 32-byte cancel token per change.
  - It writes outbox rows with `blocking_change_id` to every org owner and admin, proposer included. The token goes
    in `params_json` and is cleared with `to_email`.
  - Once the provider has accepted every send for the change, the console calls
    `ConsoleRpc.markOriginsNotified({changeId, cancelTokenHash})`. The API stores the hash as the `console` channel in
    `origin_cancel_tokens` and sets `console_notified_at`.
- **Admin channel.**
  - The admin Worker's 5-minute cron reads `AdminRpc.pendingNotices()`: every pending add with
    `admin_notified_at IS NULL`, plus the org's security contacts.
  - It mints its own cancel token per change, and emails `email.securityAlias` and every security contact.
  - Once every send is accepted, it calls `AdminRpc.ackOriginNotice({changeId, cancelTokenHash})`, which stores the
    `admin` channel hash and sets `admin_notified_at`.
  - An org with no security contacts can't get apps (`createApp` refuses `no_security_contact`). If the contacts are
    later emptied, the notice still goes to the alias, and the admin console flags the org.
- **Starting the clock.** Whichever ack lands second sets `notified_at`, `unlock_at` and `active_from` in the API.
  Neither Worker sets `active_from` itself.
- **What the emails say.** Both describe the change as the API stored it: app, origin (ASCII and decoded forms, with
  the IDN warning), proposer email or staff id, request country and unlock time.
- **Cancel instructions.**
  - The console's email links to `<console.origin>/cancel/<changeId>#t=<token>`.
  - The admin notice carries the same link with its own token, and tells the reader how to reach Hana security. Hana
    security can cancel from the admin console if the console page is unavailable or doesn't behave as expected.
- **Failures and retries.** A failed send on either channel leaves the origin inactive, and each Worker's cron
  retries with backoff.
- **Announcements for adds the console didn't start.** Staff adds, `createApp` origins and CLI adds produce pending
  changes with no console notice. The console's every-minute cron reads `ConsoleRpc.pendingAnnouncements()` (pending
  adds with `console_notified_at IS NULL`, across all orgs, paginated), queues the console notices and calls
  `markOriginsNotified`. Every add takes the same path.
- **Other notices.** Removals, suspensions, cancels and expedites take effect first and then notify on both channels
  on a best-effort basis with retry. Their delivery failures show in the admin console.
- Emails never contain approve links.

**Cancel link.** The link opens a page with a POST confirm button. A GET never cancels, so mail scanners that fetch
links cancel nothing. `POST /api/cancel {changeId, token}` calls `ConsoleRpc.cancelOriginChangeByLink`. The API checks
the token's hash against either channel's row and marks that row used. A token is single use and valid until
`active_from`.

**Staff adds (`AdminRpc.addOrigins`).**

- No step-up.
- They get the full delay, the same two notices, and no waiver.
- They are refused on a scope whose `assigned_at` is less than `originAddDelayMs` ago.
- A Hana expedite never shortens a staff add.
- The only staff-only path that makes an origin live before a delay ends is the `no_session` waiver on the initial
  origins of a scope created by that same `createApp` call. Such a scope has no sessions the API has seen. Those
  origins are still notified on both channels.

**Expedite (`AdminRpc.expediteOriginChange`).** Allowed only when `proposed_by_kind = 'member'` and the change is
announced. It needs a typed reason and a record of the out-of-band contact (who, how, and a contact on file other
than the proposer's account). It is audited, and the owners and security are emailed.

**SetAllowShared.** When a pending or executed `SetAllowShared` would turn on shared login for a scope, the console
shows that scope's active origins on the proposal and lists them in the email. The admin notice lists them too.

**Drift detection (API hourly cron).** It checks that every row with `active_from <= now` is explained by one of:

- an `origin_changes` row that activated it;
- a migrated origin with `active_from = 0`;
- an `app_changes` `app.created` row.

Any mismatch writes a `security_events` row (`kind = 'drift'`). The admin Worker's 5-minute cron emails the security
alias about it and sets `notified_at`. This catches direct D1 writes such as manual SQL. It doesn't catch an insider
who also forges ledger rows.

**Independent security feed.** The admin Worker's 5-minute cron also does two things, keeping its cursor in
`admin_state`:

- It reads new rows from `app_changes` through `AdminRpc.changesSince(seq)`. It emails the security alias and the
  org's security contacts about origin removals, suspensions, key revocations, staff actions and scope assignments.
- It emails every `security_events` row that has no `notified_at` yet.

## Keys

- **Publishable keys:** `pk_test_` or `pk_live_` + base58(24 random bytes), matching the scope's environment.
  - Rotation needs step-up but no delay.
  - It issues a new key, and the old one keeps working until `revoked_at = now + grace`, with a grace of 0 to 7 days
    (default: open question 30).
  - Revoking is immediate and needs no step-up. Revoking the last active publishable key is allowed (it is a kill
    switch) and warns.
  - `AdminRpc.restoreKey` clears `revoked_at` on a key revoked in the last 7 days, so partners don't have to ship a new
    key after a malicious or mistaken revocation. It is audited (`key.restored`) and sent to both channels. It is
    refused for a rotation's planned grace end.
- **Secret keys:** `sk_test_` or `sk_live_` + base58(32 random bytes).
  - Creation needs step-up and is emailed to the owners and security.
  - The key is shown once, and only `key_hash` (sha256) and `last4` are stored.
  - Revoking is immediate.
  - No `/v1` endpoint accepts a secret key in batch C (open question 36).
- At most 5 unrevoked keys per app, counting both kinds.

## Apps, scopes and client mode

- **App request.** A member submits `app_requests` with a name, environment, mode, the partner client IDs for own
  mode, and origins. Security is emailed.
- **Review.** Hana staff review it. For own-client mode they confirm out of band that the partner controls the
  client.
- **Security contacts.** Before the first app, Hana staff set the org's security contacts with
  `AdminRpc.setSecurityContacts`. The default suggestion is every owner's email plus one contact the partner names
  out of band.
- **Scope registration (CLI).** `admin.ts scope:register --owners-from-org <org>` runs `admin_register_scope`. Its
  owners are the `Oidc{google, sub}` values captured when the org's owners accepted their invites. It prints a dry run
  and needs `--yes`.
- **App creation.** `AdminRpc.createApp` refuses `no_security_contact` if the org has none. Otherwise it does this:
  - It reads the scope uncached with `get_scope`, then checks that the scope exists on chain and that every
    `Owner::Oidc` of the scope is the sub of an owner of the target org. The admin Worker passes the org's owner subs
    from `StaffRpc.listMembers`. Any other result is refused with `scope_conflict`.
  - It writes `scopes` (refusing a scope that already belongs to another org or environment) and records whether this
    call created the row.
  - It writes `apps` (with `publishable_key` = the first key, during the expand phase) and the first `app_keys` row.
  - It writes the requested origins through the normal add path. The `no_session` waiver applies only if this call
    created the `scopes` row.
- **Moving a legacy scope (`AdminRpc.assignScopeOrg({scopeId, orgId})`).**
  - It is allowed only while the scope's `org_id = 'org_legacy'`. Moving a scope between two real orgs is refused.
  - It runs the same on-chain-owner check as `createApp`.
  - It updates `scopes.org_id`. A trigger moves every app of the scope in the same statement, so a multi-app scope
    can't be split.
  - It sets `assigned_at`, writes `app_changes scope.assigned` per app, and notifies the new org's owners and security
    contacts and the alias. `org_legacy` has no members, so there is no old org to notify.
- **Deleting an app (`AdminRpc.deleteApp`).** Sets `deleted_at` and `suspended_by |= 1`, and revokes every key. It
  writes `app_changes app.deleted`. It is never a hard delete, and app ids are never reused.
- **Shared-login-only apps** need no client proof.
- **Client mode changes are on-chain owner actions:**
  - add the app's own client: `propose_change(AddClient)` with a client proof;
  - turn on shared login: `propose_change(SetAllowShared)`, timelocked;
  - `disable_shared_login`, immediate;
  - `remove_client`, immediate.
- **Owner drift.** The console compares the org's owners in D1 with the scope's on-chain owners. It flags any
  difference and offers a `SetOwners` proposal, which is timelocked.
- **Suspension bitmask:**
  - hana = 1, set per app by a Hana admin;
  - org = 2, set by a Hana admin on every app of an org in one batch;
  - partner = 4, set by an owner or admin.

  An app is active if and only if the value is 0. Resuming one bit never clears another. A Hana admin may clear any
  bit, including bit 4 after a malicious mass suspension.

## On-chain owner actions

1. The console reads `get_scope` over NEAR RPC, uncached, to get `action_nonce` N, `pending`, `clients` and
   `allow_shared`.
2. It builds `borsh(args without auth)` with `packages/console-core` and computes the owner nonce. It stores
   `pending_actions` with `scope_id`, `near_action_nonce = N` and `near_args`, and shows the decoded action.
3. **AddClient only.** The client proof must come from the partner's own client, on an origin that client
   authorises. The console never serves the proof page from its own origin: its CSP has no Google entries, and adding
   the console origin to a partner's client would defeat the separation.
   - **The helper.** The console offers a downloadable, self-contained static HTML file (`Content-Disposition:
     attachment`), parameterised with the client ID, the scope and the proof nonce for the same N. The partner hosts
     or opens it on one of their client's authorised JavaScript origins. It loads GIS with that nonce and shows the
     resulting JWT for the partner to copy.
   - **Paste.** The partner pastes the JWT into the console. Before accepting it, the console warns that the proof
     token includes the partner staffer's email and name and becomes public on chain.
   - **Checks.** The console checks the proof's signature, `iss`, `exp`, that its `aud` equals the client in the
     `AddClient`, and its nonce. It refuses a mismatch with `invalid_client_proof`. Only then does it compute the
     owner nonce, which commits to the exact proof JWT string.
4. Passkey step-up, then the Google code flow with `nonce` = the owner nonce, `login_hint` = the sub and
   `scope=openid` only, so that no email or name goes into a token that becomes public. The callback refuses a token
   that carries an `email` claim. This depends on open question 1.
5. In the callback, the console checks the sub and the nonce, then re-reads `get_scope`.
   - If N has moved, it marks the action failed and asks the user to rebuild. It never retries silently with a
     different action.
   - Otherwise it calls `ConsoleRpc.ownerAction({orgId, body, clientIp, actor})`. The body is
     `{"method", "args": {…, "auth": {"Oidc": {"jwt"}}}}`, byte-identical to what was built.
6. On `token_used` or `owner_nonce_mismatch` it rebuilds from the new N and asks again.

API changes:

- `handleOwnerAction` is refactored to take `(body, clientIp)`. `ipKey` currently reads `cf-connecting-ip`
  (`handlers.ts:108`), so `ConsoleRpc` passes the client IP explicitly, and it feeds the same per-IP limiter.
- `precheckOwnerAction` recomputes the owner nonce from the scope view. On a mismatch it re-reads `get_scope`
  uncached once, then refuses with 409 `owner_nonce_mismatch`. The precheck runs before the token is reserved, so
  there is nothing to release. The release path stays only for `NOT_EXECUTED` relay failures, as today.
- For `AddClient` it also recomputes the client-proof nonce (400 `invalid_client_proof`).
- A mismatch is therefore refused for free instead of burning gas and returning 422.
- The relay still uses the owner relayer pool.
- **Limits.** Below the existing global caps (`OWNER_ACTIONS_GLOBAL_MINUTE = 20`, `OWNER_ACTIONS_GLOBAL_DAY = 200`),
  there are two new limits:
  - **Per-scope cap:** 20 owner actions per scope per UTC day, all methods.
  - **Reserved safety budget:** `cancel_change`, `remove_client` and `disable_shared_login` don't count against the
    general global caps. They use their own global bucket (`owner-actions:safety`: 10 per minute, 100 per day) and
    their own per-scope bucket (10 per scope per day). One scope can't exhaust another scope's safety budget, and the
    general caps can't block a cancel.
  - Reaching any cap logs `owner_cap_reached` and writes a `security_events` row (`kind = 'owner_cap'`).
- **Allowance alert.** The API's hourly cron reads each owner-pool key's allowance with `view_access_key`. It writes
  `security_events` (`kind = 'owner_allowance_low'`) below 25% of the key's initial allowance.
- **Staff relay runbook.** If a safety call is refused with `rate_limited`, or the owner pool is drained, the console
  shows the owner the exact signed body and tells them to send it to Hana security. The token inside is single use
  and becomes public on chain anyway. Staff relay it with `admin.ts owner:relay --body <file>` from a Hana-funded NEAR
  account whose key is in `.secrets/`, before the token's `exp`. OIDC owner auth doesn't depend on the predecessor
  account. The command prints a dry run, needs `--yes`, never prints the JWT, and is audited by hand in the admin
  console.

After a relay, the console writes the audit outcome with `near_tx` and emails the owners. `execute_change` needs no
token: the console relays it with a session only.

**Pending-change watchers (two, independent).**

- **Console (every minute; owners' emails).**
  - One paginated `ConsoleRpc.listScopes({cursor})` per run gives every `(scope_id, org_id)`.
  - The watcher reads `get_scope.pending` for each scope, and emails every owner of the org about each
    `(scope_id, change_id)` not yet in `scope_watch`, with a cancel action.
  - This also catches changes relayed outside the console.
- **Admin (every 5 min; security alias and security contacts).**
  - It pages `AdminRpc.listScopes`, then reads `get_scope` uncached over its own read-only NEAR RPC.
  - It emails about each `(scope_id, change_id)` not yet in `admin_scope_watch`. The email decodes the change (for
    `SetOwners`, the new owner list with any added `Owner::Oidc` highlighted; for `AddClient`, the client) and carries
    the cancel instructions.
  - It diffs owners, clients and `allow_shared` against `admin_scope_snapshot` and emails about any change. That
    covers executed changes and immediate ones such as `remove_client`.
  - It runs whether or not the console's outbox works. This makes the event watching that `docs/contract-interface.md`
    ("OIDC owners trust the console code") relies on independent of the console.

**What the passkey doesn't cover.** Anyone holding a victim owner's live Google session can mint console-client tokens
with any nonce in their own browser, outside our console. So can a compromised console Worker, at any routine sign-in
or step-up, because it chooses the nonce. That gives on-chain owner power, but not console power. On chain we rely on:

- the timelock (AddClient, SetOwners, SetAllowShared);
- cancel by any owner;
- the console watcher's emails, and the admin watcher's emails, which a compromised console can't suppress.

## RPC interfaces

All inputs are validated with zod. Every result is `{ok: true, …} | {ok: false, code, error?}`. None of these classes
has a route: the API's public `fetch` serves only `/v1/*`.

```ts
type Actor =
  | { kind: 'member'; id: string; sub: string; email: string; sessionHash: string }
  | { kind: 'hana'; id: string /* Access sub */; email: string }
  | { kind: 'system'; id: string }
  | { kind: 'link'; id: string /* change id */ };
interface Ctx { actor: Actor; requestId: string; clientIp: string; auditSeq?: number }
type RpcCode = 'bad_request' | 'not_found' | 'forbidden' | 'version_conflict' | 'step_up_invalid' | 'not_owner'
  | 'origin_refused' | 'token_used' | 'near_unavailable' | 'rate_limited' | 'key_limit' | 'env_mismatch'
  | 'scope_conflict' | 'not_pending' | 'conflict' | 'no_security_contact' | 'invalid_client_proof'
  | 'owner_nonce_mismatch' | 'internal';

// apps/api: bound only by the console. Every org method takes orgId, and every query has WHERE org_id = ?.
// The three system methods marked (all orgs) take a system actor and no orgId.
interface ConsoleRpc {
  listApps(c: Ctx & { orgId }): Rpc<{ apps: AppSummary[] }>;
  getApp(c: Ctx & { orgId; appId }): Rpc<{ app: AppDetail }>;
  changeOrigins(c: Ctx & { orgId; appId; add: string[]; remove: string[]; expectedVersion: number; stepUpJwt: string })
    : Rpc<{ version: number; changes: OriginChange[] }>;
  removeOrigins(c: Ctx & { orgId; appId; remove: string[]; expectedVersion: number }): Rpc<{ version: number }>;
  markOriginsNotified(c: Ctx & { orgId; changeId: string; cancelTokenHash: string /* b64url sha256 */ })
    : Rpc<{ change: OriginChange }>;
  cancelOriginChange(c: Ctx & { orgId; changeId }): Rpc<{ change: OriginChange }>;
  cancelOriginChangeByLink(c: Ctx & { changeId; token: string }): Rpc<{ change: OriginChange }>;
  setSuspended(c: Ctx & { orgId; appId; suspended: boolean }): Rpc<{ suspended_by: number }>; // bit 4 only
  createKey(c: Ctx & { orgId; appId; kind: 'publishable' | 'secret' }): Rpc<{ key: KeyView; secret?: string }>;
  rotateKey(c: Ctx & { orgId; appId; keyId; graceMs: number }): Rpc<{ key: KeyView }>;
  revokeKey(c: Ctx & { orgId; appId; keyId }): Rpc<{}>;
  usage(c: Ctx & { orgId; appIds?: string[] /* ≤ 100 */; from: Day; to: Day /* ≤ 400 days */; by: 'day' | 'month' })
    : Rpc<{ rows: UsageRow[] }>;                 // USAGE_DB only (org_id is denormalised); per-member rate limit
  statements(c: Ctx & { orgId; month?: string }): Rpc<{ statements: StatementMeta[]; csv?: string }>;  // USAGE_DB only
  ownerAction(c: Ctx & { orgId; body: OwnerActionBody }): Rpc<{ status: number; result?: unknown; nearTx?: string; code?: string }>;
  listScopes(c: Ctx & { cursor?: string; limit: number /* ≤ 200 */ }): Rpc<{ scopes: ScopeRow[]; next?: string }>; // all orgs
  changesSince(c: Ctx & { seq: number; limit: number /* ≤ 200 */ }): Rpc<{ changes: AppChange[] }>;           // all orgs
  pendingAnnouncements(c: Ctx & { cursor?: string; limit: number }): Rpc<{ changes: OriginChange[]; next?: string }>; // all orgs
}
// apps/api: bound only by the admin Worker. The ConsoleRpc org methods across all orgs (Hana actor; no breaker), plus:
interface AdminRpc {
  createApp(c: Ctx & { orgId; scopeId; environment: 'test' | 'live'; name; origins: string[]; plan?: string;
                       orgOwnerSubs: string[] }): Rpc<{ app: AppDetail; publishableKey: string; createdScope: boolean }>;
  assignScopeOrg(c: Ctx & { scopeId; orgId; orgOwnerSubs: string[] }): Rpc<{ apps: number }>;
  deleteApp(c: Ctx & { appId }): Rpc<{}>;
  setSuspended(c: Ctx & { appId; bit: 1 | 2 | 4; suspended: boolean }): Rpc<{ suspended_by: number }>;
  suspendOrg(c: Ctx & { orgId; suspended: boolean }): Rpc<{ apps: number }>;
  restoreKey(c: Ctx & { appId; keyId }): Rpc<{ key: KeyView }>;   // revoked ≤ 7 d ago, not a rotation grace end
  addOrigins(c: Ctx & { orgId; appId; add: string[]; expectedVersion: number }): Rpc<{ changes: OriginChange[] }>;
  expediteOriginChange(c: Ctx & { changeId; reason: string; contact: string }): Rpc<{ change: OriginChange }>;
  pendingNotices(c: Ctx & { limit: number }): Rpc<{ notices: { change: OriginChange; contacts: string[] }[] }>;
  ackOriginNotice(c: Ctx & { changeId; cancelTokenHash: string }): Rpc<{ change: OriginChange }>;
  setSecurityContacts(c: Ctx & { orgId; emails: string[] /* 1–10, lowercased */ }): Rpc<{ emails: string[] }>;
  getSecurityContacts(c: Ctx & { orgId }): Rpc<{ emails: string[] }>;
  listScopes(c: Ctx & { cursor?: string; limit: number }): Rpc<{ scopes: ScopeRow[]; next?: string }>;
  changesSince(c: Ctx & { seq: number; limit: number }): Rpc<{ changes: AppChange[] }>;
  securityEvents(c: Ctx & { unnotifiedOnly: boolean; limit: number }): Rpc<{ events: SecurityEvent[] }>;
  markSecurityEventNotified(c: Ctx & { ids: string[] }): Rpc<{}>;
}
// apps/console: bound only by the admin Worker. Every method takes Ctx with a Hana actor.
interface StaffRpc {
  listOrgs(c: Ctx & { cursor?: string; limit: number }): Rpc<{ orgs: OrgView[]; next?: string }>;
  getOrg(c: Ctx & { orgId }): Rpc<{ org: OrgView; members: MemberView[]; invites: InviteView[] }>;
  issueInvite(c: Ctx & { kind: 'member' | 'reenrol'; email: string; role: Role; orgId?: string; newOrgName?: string;
                         boundSub?: string }): Rpc<{ invite: InviteView }>;   // the token is emailed, never returned
  revokeInvite(c: Ctx & { inviteId }): Rpc<{}>;
  listInvites(c: Ctx & { orgId?: string; status?: InviteStatus; cursor?: string }): Rpc<{ invites: InviteView[]; next?: string }>;
  listMembers(c: Ctx & { orgId }): Rpc<{ members: MemberView[] }>;   // includes sub, for orgOwnerSubs
  resetPasskeys(c: Ctx & { userId; oobCheck: { method: string; contact: string; note: string } }): Rpc<{ inviteId: string }>;
  freezeOrg(c: Ctx & { orgId; frozen: boolean }): Rpc<{}>;
  listAppRequests(c: Ctx & { status?: 'pending' | 'approved' | 'rejected'; cursor?: string }): Rpc<{ requests: AppRequestView[]; next?: string }>;
  reviewAppRequest(c: Ctx & { requestId; decision: 'approved' | 'rejected'; note: string; appId?: string }): Rpc<{}>;
  queryAudit(c: Ctx & { filters: AuditFilters; cursor?: string; limit: number }): Rpc<{ rows: AuditRow[]; next?: string }>;
  appendAudit(c: Ctx & { row: AuditAppend }): Rpc<{ seq: number }>;
  outboxFailures(c: Ctx & { cursor?: string }): Rpc<{ rows: OutboxFailure[]; next?: string }>;
}
```

- **Writes that touch two databases** follow the write-ahead order in §Audit.
- **Idempotency.** Every RPC write carries a `requestId`. The API writes `rpc_results(request_id, method,
  result_json)` in the same batch as the change. A repeated `requestId` for the same method returns the stored result
  without writing again. Rows are purged after 24 h. Writes that change origin rows also carry `expectedVersion`.
- **Trust in the actor.** `ConsoleRpc` trusts its `actor` and `orgId` arguments except where the API verifies a
  token: origin adds and owner actions. The `orgId` filter is a backstop against console authorisation bugs, not
  against a compromise.
- **Destructive-call breaker.** These `ConsoleRpc` calls are counted in the `RateLimiter` DO before the API writes:
  - each app `setSuspended(true)`;
  - each `revokeKey`;
  - each `removeOrigins` call.

  The limits are 5 per org per rolling hour and 20 across all orgs per rolling hour. Above either limit, the call is
  refused with `rate_limited`, and the API writes `security_events` (`kind = 'breaker'`), which the admin Worker
  emails. Cancels of pending adds aren't counted, because they never affect a live origin. `AdminRpc` isn't limited.
  Thresholds: open question 41.
- **Hot-DB budget.** Each `ConsoleRpc` method runs at most 3 hot-DB statements, each on an index. Before running them,
  the API charges a token bucket in the `RateLimiter` DO (`console-rpc:hotdb`: 30 statements per second, burst 60).
  Over the budget, it refuses with `rate_limited`. `usage` and `statements` read only `USAGE_DB` and aren't charged.
  The watchers use one paginated `listScopes` per run instead of a per-org `listApps`.

### Types (`packages/console-core`, zod schemas; TS shown)

```ts
type Day = string;                                       // YYYY-MM-DD, UTC
type Role = 'owner' | 'admin' | 'developer' | 'viewer';
interface AppSummary { id; name; scopeId; environment: 'test' | 'live'; suspendedBy: number; deleted: boolean;
  activeOrigins: number; pendingOrigins: number; createdAt: number }
interface AppDetail extends AppSummary { orgId; plan; originsVersion: number;
  origins: { origin: string; display: string /* decoded IDN */; idn: boolean; activeFrom: number | null; changeId?: string }[];
  pending: OriginChange[]; keys: KeyView[] }
interface OriginChange { id; appId; origin; display; idn: boolean; op: 'add' | 'remove';
  status: 'pending' | 'active' | 'cancelled' | 'removed' | 'done';
  proposedByKind: 'member' | 'hana' | 'system'; proposedBy; proposedAt: number; requestCountry?: string;
  waiver?: 'loopback' | 'no_session'; consoleNotifiedAt?: number; adminNotifiedAt?: number; activeFrom?: number | null;
  expeditedBy?: string; cancelledBy?: string; cancelledAt?: number }
interface KeyView { id; kind: 'publishable' | 'secret'; prefix; last4; key?: string /* publishable only */;
  createdBy; createdAt: number; revokedAt?: number; restoredAt?: number }
interface UsageRow { orgId; appId?: string; scopeId?: string; period: string /* Day or YYYY-MM */; source: 'ledger' | 'legacy';
  logins: number; derives: number; revokes: number; ownerActions: number; mau?: number; newUsers: number;
  failuresByCode: Record<string, number>; tgas: string; relayedRejectedTgas: string; errorTgas: string;
  burntYocto: string; usdMicros?: string; p50: { session?: number; derive?: number }; p95: { session?: number; derive?: number };
  unsettled: number }
interface StatementMeta { orgId; month: string; sha256: string /* hex */; issuedBy; issuedAt: number }
interface AppChange { seq: number; at: number; orgId; appId?: string; scopeId?: string; kind: string;
  detail: Record<string, unknown>; actorKind: Actor['kind']; actorId; actorSub?: string; requestId; auditSeq?: number }
interface SecurityEvent { id; detectedAt: number; kind: 'drift' | 'breaker' | 'owner_cap' | 'owner_allowance_low';
  orgId?: string; appId?: string; scopeId?: string; origin?: string; detail: Record<string, unknown>; notifiedAt?: number }
interface ScopeRow { scopeId; orgId; environment: 'test' | 'live'; assignedAt: number }
interface OwnerActionBody { method: 'propose_change' | 'execute_change' | 'cancel_change' | 'remove_client'
  | 'disable_shared_login'; args: Record<string, unknown> /* includes auth.Oidc.jwt where needed */ }
// StaffRpc views (OrgView, MemberView, InviteView, AppRequestView, AuditRow, AuditAppend, AuditFilters, OutboxFailure)
// mirror their CONSOLE_DB rows with the allowlisted columns only: never token_hash, to_email after clearing, or cookies.
```

### RpcCode → HTTP status (console and admin BFFs)

| RpcCode | HTTP |
|---|---|
| `bad_request`, `origin_refused`, `env_mismatch`, `invalid_client_proof` | 400 |
| `step_up_invalid` | 401 |
| `forbidden`, `not_owner` | 403 |
| `not_found` | 404 |
| `version_conflict`, `token_used`, `scope_conflict`, `not_pending`, `conflict`, `key_limit`, `no_security_contact`, `owner_nonce_mismatch` | 409 |
| `rate_limited` | 429 |
| `internal` | 500 |
| `near_unavailable` | 503 |

Console-only error codes: `unauthenticated` 401 (no or expired session), `mfa_required` 403, `csrf` 403,
`not_invited` 403, `invite_invalid` 403, `user_disabled` 403, `org_frozen` 403, `already_member` 409,
`step_up_expired` 409, `step_up_required` 403, `rate_limited` 429. Errors are `{error: {code, message}}`.

### Console BFF routes (`console.origin` unless stated)

| Method and path | Role | Step-up kind | Request → response |
|---|---|---|---|
| `POST /api/auth/start` | none | — | `{purpose:'login', invite?}` → `{startUrl}` |
| `GET <authOrigin>/start?f=` | none | — | 303 to Google, or the static 400 page |
| `GET <authOrigin>/callback` | none | — | 303 (login: `/api/auth/complete?h=…#`; step-up: `/actions/:id#`), or the static 400 page |
| `GET /api/auth/complete?h=` | none | — | 303 to `/signin/passkey` |
| `POST /api/auth/passkey/options`, `…/verify` | pre_mfa | — | WebAuthn options → `{ok}` |
| `POST /api/auth/enrol/options`, `…/verify` | enrol | — | WebAuthn options → `{ok}` |
| `POST /api/auth/logout` | any session | — | `{}` |
| `GET /api/me` | any session | — | `{user, stage, memberships: {orgId, role}[]}` |
| `GET /api/orgs/:org` | viewer | — | `{org}` |
| `GET /api/orgs/:org/apps`, `/apps/:app` | viewer | — | `AppSummary[]`, `AppDetail` |
| `GET /api/orgs/:org/scopes/:scope` | viewer | — | the decoded on-chain view, pending changes, owner drift |
| `POST /api/orgs/:org/actions` | per kind | the kind | `{kind, params}` → `{id, kind, decoded, expiresAt}` |
| `POST /api/actions/:id/passkey/options`, `…/verify` | the action's user | — | options → `{ok}` |
| `POST /api/actions/:id/google` | the action's user | — | `{}` → `{startUrl}` |
| `GET /api/actions/:id` | the action's user | — | `{status, outcome, nearTx?}` |
| `POST /api/orgs/:org/apps/:app/origins/remove` | admin | — | `{remove, expectedVersion}` → `{version}` |
| `POST /api/orgs/:org/origin-changes/:id/cancel` | admin | — | `{}` → `OriginChange` |
| `POST /api/orgs/:org/apps/:app/suspend` | admin | — | `{}` → `{suspendedBy}` (resume is `app.resume`) |
| `POST /api/orgs/:org/apps/:app/keys/:key/revoke` | admin | — | `{}` → `{}` |
| `POST /api/orgs/:org/scopes/:scope/execute` | admin | — | `{changeId}` → `{nearTx}` |
| `GET /api/orgs/:org/scopes/:scope/client-proof-helper` | admin | — | the downloadable helper file |
| `POST /api/orgs/:org/app-requests` | developer | — | `{name, environment, mode, clientIds, origins}` → `{id}` |
| `POST /api/orgs/:org/invites/:id/revoke` | owner | — | `{}` → `{}` |
| `GET /api/orgs/:org/members`, `/invites` | developer | — | lists |
| `GET /api/orgs/:org/audit?cursor` | developer | — | `{rows, next}` |
| `GET /api/orgs/:org/usage?from&to&by&apps` | viewer | — | `UsageRow[]` |
| `GET /api/orgs/:org/statements`, `/statements/:month.csv`, `/ledger/:month.csv` | viewer | — | `StatementMeta[]`, CSV |
| `GET /cancel/:changeId` (SPA page), `POST /api/cancel` | none (CSRF rules apply) | — | `{changeId, token}` → `OriginChange` |

"admin" in the role column means owner or admin; "developer" means developer and above; "viewer" means any member.

### Admin BFF routes (`admin.origin`; every route needs a valid Access JWT and a staff email)

| Method and path | Request → response |
|---|---|
| `GET /api/orgs`, `GET /api/orgs/:org` | `StaffRpc.listOrgs`, `getOrg` + `AdminRpc.getSecurityContacts` |
| `POST /api/orgs/:org/freeze`, `/suspend` | `{frozen}` / `{suspended}` → `{}` |
| `PUT /api/orgs/:org/security-contacts` | `{emails}` → `{emails}` |
| `POST /api/invites`, `POST /api/invites/:id/revoke` | `StaffRpc.issueInvite`, `revokeInvite` |
| `POST /api/users/:id/reset-passkeys` | `{oobCheck}` → `{inviteId}` |
| `GET /api/app-requests`, `POST /api/app-requests/:id/review` | queue; `{decision, note}` |
| `POST /api/apps` | `AdminRpc.createApp` (the Worker fills `orgOwnerSubs` from `StaffRpc.listMembers`) |
| `POST /api/scopes/:scope/assign` | `{orgId}` → `AdminRpc.assignScopeOrg` |
| `POST /api/apps/:app/suspend`, `/resume`, `/delete` | `{bit}` → `{suspendedBy}` |
| `POST /api/apps/:app/origins`, `/origins/remove` | `{add, expectedVersion}` / `{remove, expectedVersion}` |
| `POST /api/origin-changes/:id/cancel`, `/expedite` | `{}` / `{reason, contact}` |
| `POST /api/apps/:app/keys/:key/revoke`, `/restore` | `{}` → `KeyView` |
| `GET /api/audit?filters&cursor`, `GET /api/audit.csv` | `StaffRpc.queryAudit` |
| `GET /api/security` | security events, outbox failures, DLQ depth, backlog, breaker state |
| `GET /api/reports?org&from&to&by`, `POST /api/statements/:org/:month/issue`, `GET /api/statements/:org/:month.csv` | reports and statements |
| `POST /api/rates/:day`, `POST /api/adjustments` | audited overrides |

## Hana admin console

- **Access.**
  - Worker-level Cloudflare Access covers every hostname. `workers_dev` and preview URLs are disabled.
  - The policy requires the Hana IdP plus hardware-key MFA (open question 2).
  - The application session lasts 1 h.
- **JWT check.** Every `/api/*` request verifies `Cf-Access-Jwt-Assertion` with `jose`:

  ```ts
  createRemoteJWKSet(new URL(`https://${accessTeamDomain}/cdn-cgi/access/certs`));
  jwtVerify(jwt, jwks, { issuer: `https://${accessTeamDomain}`, audience: accessAud, algorithms: ['RS256'] });
  ```

  It requires a `kid`, rejects an empty `sub` (a service token), requires `type = 'app'`, and requires the lowercased
  `email` to be in `admin.staffEmails`. Otherwise it fails closed with 401 or 403.
- `ctx.access` is not relied on. It isn't passed to a Worker with static assets and doesn't cross service bindings.
- The actor `{kind: 'hana', id: sub, email}` travels as an explicit RPC argument and is written to `audit_log` and
  `app_changes`.
- The same CSRF rules and CSP as the console apply.
- **Screens:**
  - orgs (create by invite, freeze, suspend, security contacts, assign legacy scopes);
  - invites (issue, revoke, reenrol);
  - members (view, passkey reset with a recorded out-of-band check);
  - the app-request review queue;
  - apps (suspend and resume, staff origin add, remove, cancel, expedite, key revoke and restore, delete);
  - the audit log (filter and CSV export);
  - security (security events, breaker state, outbox failures, DLQ depth, backlog, on-chain watcher state);
  - reports and statements.
- **No NEAR keys.** `admin_register_scope` and contract admin stay in `scripts/`. The admin Worker makes only
  read-only NEAR RPC calls: `tx` for settlement, and `get_scope` for the watcher.

## Usage capture and reporting

### Capture (API Worker; nothing added before the response)

- **Analytics Engine:** one `writeDataPoint` per request, including gate rejections and `GET /v1/app`. Layout:
  - `indexes: [app_id ?? '-']`
  - `blobs: [endpoint, outcome, code ?? '', colo ?? '', scope_id ?? '', env, ledger]`, where `ledger` is `'1'` when a
    UsageEvent was sent for this request and `'0'` otherwise
  - `doubles: [latency_ms, phases.app, phases.limits, phases.checks, phases.relay, phases.relayDispatch,
    phases.relayOutcome, relay_gas_burnt, status]`, with -1 for an absent value.

  It is operational only: sampled, and kept 3 months.
- **UsageEvent v1.** Sent only for requests that passed `appGate` on `/v1/sessions`, `/v1/derive` and
  `/v1/sessions/revoke`, and for `/v1/owner-actions` after the owner check:

  ```ts
  { v: 1, request_id, at_ms /* request start; sets the UTC day */, org_id, app_id: string | null, scope_id,
    endpoint: 'session' | 'derive' | 'revoke' | 'owner_action', outcome: 'ok' | 'rejected' | 'error',
    code: string | null, status, latency_ms, relayed: boolean, near_tx?, relay_gas_burnt?: string,
    relay_tokens_burnt_yocto?: string, gas_status: 'pending' | 'none', uid?: string /* b64url 16 bytes */ }
  ```

  Phases and colo go only to AE and the logs. The event never contains a sub, JWT, email, IP or session key.
- **Sending.** `exec.waitUntil(env.USAGE_Q.send(e))`. If the send fails, the API falls back to a direct
  `INSERT OR IGNORE` into `USAGE_DB` and logs the error `usage_enqueue_failed`. If the bindings are absent, nothing is
  sent.
- **Consumer.** Runs in the API Worker: batches of 100, retries, a DLQ, and 14-day message retention. It validates the
  schema and writes one `db.batch`: `INSERT OR IGNORE usage_events`, plus an `app_users` upsert of
  `first_seen_day = min(...)` and `last_seen_day = max(...)`. This replaces `countUsage`/`incrementUsage`.
- **Gas.**
  - **Billable gas** of a transaction is the BigInt sum of `gas_burnt` (and of `tokens_burnt`) over
    `transaction_outcome` and every entry of `receipts_outcome`, read with `tx` at `wait_until: 'FINAL'`. The relay
    answers at `EXECUTED_OPTIMISTIC` (`apps/api/src/near/rpc.ts`, `RELAY_WAIT_UNTIL`), which is neither final nor
    inclusive of refund receipts. So relay-time gas is recorded only as provisional `relay_gas_burnt`, and the admin
    settlement provides the billed figure for every relayed transaction.
  - `FinalOutcome` gains typed `transaction_outcome.outcome` and `receipts_outcome[].outcome.{gas_burnt,
    tokens_burnt}`. Sums use BigInt. `apps/smoke/src/near.ts` sums them as Numbers and is not the model.
  - `relayed = near_tx present AND code ≠ 'relayer_busy'`.
  - **gas_status by result:**

    | Result | `relayed` | `gas_status` |
    |---|---|---|
    | `ok`, `contract_rejected` (a rejected call burns about 2.2 Tgas) | true | `pending` |
    | `timeout`, `near_error` with a `near_tx` | true | `pending` |
    | `relayer_busy` (invalid nonce, or dropped: a later nonce landed, so it can never execute) | false | `none` |
    | `near_rejected`, `near_unavailable`, `relayer_unavailable`, `relayer_unconfigured`, `method_not_allowed` | false | `none` |
    | Any refusal before the relay (`bad_request`, `invalid_signature`, `token_used`, `owner_nonce_mismatch`, post-gate `rate_limited`, …) | false | `none` |
    | Anything without a `near_tx` | false | `none`, 0 gas |
- **uid.**

  ```
  uid = HMAC-SHA256(USER_ID_KEY, "hana-id/uid/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))[0..16]
  ```

  - It is computed from the on-chain session path: `create_session`'s returned `SessionView.path`, or derive's
    `getSession().path`.
  - Parsing strips the known `${app.scope_id}#` prefix and then requires exactly 3 `#`-separated parts. The contract
    forbids `#` in provider and sub.
  - `key_index` is excluded, so rotating a key doesn't count as a new user.
  - It is sent only on ok session and derive events.
  - `USER_ID_KEY` is a 32-byte Worker secret per environment, on the API Worker only. It is kept in `.secrets/` (0600)
    with an offline backup, never in D1, and never logged. It is not rotated within a contract term; v1 leaves room
    for a new key later.

### Aggregation (admin Worker crons on `USAGE_DB`)

- **Hourly recompute.** For the days that aren't closed (today and yesterday), the cron recomputes the
  `source = 'ledger'` rows of `usage_daily`, plus `usage_daily_failures` and `usage_daily_scope`, from the ledger. It
  works by DELETE then INSERT, with paginated reads, BigInt sums, and exact nearest-rank p50 and p95 over the server
  latency of ok events. A re-run never double counts, and it never touches `legacy` rows.
  - The counters per endpoint keep apart: relayed ok (gas paid), rejected but relayed (gas paid, for example
    third-party replays of public signed derives), rejected before relay (no gas), and error.
  - Gas comes only from `gas_settlements`. An event that is relayed but not yet settled counts in `unsettled`.
  - Gas buckets: `gas_ok` for `outcome = ok`, `gas_rejected` for `outcome = rejected`, `gas_error` for
    `outcome = error` (a settled timeout or near_error). The same split applies to yocto.
- **Settlement (every 15 min).** Every relayed event without a `gas_settlements` row gets RPC `tx` at `FINAL`, for up
  to 24 h after `at_ms`. The row is written with `result = 'final'` and the billable sums. Non-archival RPC
  garbage-collects after about 2.5 days. After 24 h without a final result, the row is written as `unsettled`, and the
  count appears on the statement. Load: one `tx` per relayed event (open question 44).
- **Close.**
  - A day closes at D+2 00:00 UTC.
  - A month closes on the 3rd of the next month, 00:00 UTC. `usage_monthly` gets
    `mau = COUNT(DISTINCT uid)` over ok session or derive events in the UTC calendar month (a session that crosses
    midnight on the 1st counts in both months), `new_users` = the `app_users.first_seen_day` values in the month, and
    exact p50/p95 from the raw events.
  - Closed rows are immutable.
  - A month can't close while any day lacks a `near_usd_rates` row.
- **Late events and corrections.** An event whose `received_at` is after its day's `closed_at` becomes a
  `usage_adjustments` row, as do Hana corrections. They are audited and shown on the next statement.
- **AE cross-check (alert only).** Before a statement is issued, the admin Worker compares, for each app-day, the
  ledger count with `SUM(_sample_interval)` from AE `WHERE index1 = app_id AND blob7 = '1'` for that UTC day. The
  result is written to `ae_reconcile`. AE is sampled, so this is an estimate: a gap beyond the threshold (open
  question 20) raises a security-screen alert and an email to the security alias, but it doesn't block the statement.
  The exact cross-check against the relayer's on-chain transactions is open question 35.
- **Rates.** A daily cron fetches `near_usd_rates` from the one source the service contract names. A Hana admin may
  enter or override a rate, which is audited.
  - `usd_micros(day) = round_half_up(burnt_yocto(day) × rate_usd_micros(day) / 10^24)`, in BigInt.
  - The month's USD is the sum of the days.
  - Testnet figures are valued at the mainnet price and labelled as such.
  - Amounts are the **gross** `tokens_burnt` paid by the relayer. The 30% function-call reward credited to the signer
    is not netted off, and the statement says so.

### Statements and export

- **Freezing.** `statements(org_id, month)` is frozen once, with its `sha256`, `issued_by` and `issued_at`. It is
  audited (`statement.issued`). Partners download the same frozen file read-only from the console, through
  `ConsoleRpc.statements`, which re-checks org membership.
- **CSV.** RFC 4180, UTF-8, LF line endings, decimal strings.
  - **Injection guard.** A cell that matches `^-?\d+(\.\d+)?$` is numeric and left as is. Any other cell that starts
    with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`.
  - **Rows.** There is one row per app per day per source. Then there is one row per scope per day for owner actions
    (`app_id` empty, `scope_id` set). Then there is one total row per app and one per scope (`day = total`, with MAU
    filled for apps).
  - **Columns, in order:**

    `month,org_id,org_name,scope_id,app_id,app_name,environment,day,source,logins,derives,revokes,owner_actions,mau,new_users,failures_by_code,tgas,relayed_rejected_tgas,error_tgas,near,near_usd_rate,rate_source,usd,session_p50_ms,session_p95_ms,derive_p50_ms,derive_p95_ms,unsettled,adjustments,generated_at`

  - **Column formulas:**
    - `logins` = ok `create_session`; `derives` and `revokes` = ok derive and revoke; `owner_actions` = ok owner
      actions (scope rows only).
    - `failures_by_code` is `code=n;…`, sorted by code.
    - `tgas` = all settled gas of the row: ok + rejected + error, as an exact decimal of Tgas (gas / 10^12).
    - `relayed_rejected_tgas` and `error_tgas` are the parts of `tgas` from rejected and error events.
    - `near` = all settled `tokens_burnt` of the row (ok + rejected + error), as an exact decimal of NEAR.
    - `usd` follows the rate rule above.
    - `adjustments` is `field=signed_decimal;…`, sorted by field, for adjustments applied to this row's month (for
      example `tgas=-2.21;derives=-1`).
    - `legacy` rows carry counts only, with empty gas columns.
- **Ledger CSV, on demand:**
  `request_id,at,org_id,scope_id,app_id,endpoint,outcome,relayed,gas_status,near_tx,gas_burnt,tokens_burnt`.
  `gas_burnt` and `tokens_burnt` come from `gas_settlements`. `gas_status` is the settlement's `result` (`final` or
  `unsettled`) when there is one, and otherwise the event's (`pending` or `none`; empty gas). Sodax can check every
  charge on chain at FINAL. The ledger's `final` gas summed per org-month equals the statement's `tgas` and `near`,
  owner actions included, before adjustments.
- **Monthly R2 export (`EXPORTS`):** statements, the audit log (through `StaffRpc.queryAudit`) and `app_changes`.

### Reports (admin; partners see their own org)

Per org and per app, by day and by month:

- logins (ok `create_session`), derives, revokes;
- MAU and new users;
- gas burnt (Tgas, NEAR) and USD with the rate source;
- the relayed/rejected/error splits;
- failures by code;
- p50 and p95 latency;
- unsettled counts and adjustments.

Owner-action gas is reported per scope and attributed to the scope's org.

### User lists

The MVP has no per-user list and shows no wallet addresses, only aggregates. An opaque HMAC tells a partner nothing,
an SDK-reported address is unauthenticated and can be poisoned, and uid-to-address pairs would re-identify users
through chain activity. Opt-in address reporting signed by the derived key is a later option.

## Audit

- **Scope.** Every auth event (sign-in, refusal, passkey enrol or reset, session revoke) and every step-up action
  writes `audit_log`. So does every invite issue, accept, refuse, revoke and expire (the console cron writes
  `invite.expired` once per invite).
- **Action names:**
  - `auth.*`, `invite.created|accepted|refused|revoked|expired`;
  - `member.*`, `passkey.*`, `app.*`, `app_request.*`;
  - `origin.added|notified|expedited|activated|cancelled|removed`;
  - `key.*` (including `key.restored`), `suspension.*`, `owner_action.*`, `scope.assigned`;
  - `hana.*`, `rate.set`, `adjustment.*`, `statement.issued`, `report.exported`.
- **Write-ahead across databases.** No transaction spans two databases. For a hot-DB or on-chain change:
  1. The console inserts a `pending` audit row.
  2. It calls the RPC only if that insert succeeded.
  3. It appends an `ok` or `failed` row with `parent_seq`.

  The API writes `app_changes` in the same batch as the hot-DB change, so a logged change can fail, but there is never
  an unlogged change.
- **Reconciler (console, every minute).**
  - For `pending` rows older than 10 min with no outcome row, it looks up `app_changes` by `request_id` (indexed),
    through `ConsoleRpc.changesSince`, and appends the outcome.
  - It mirrors `app_changes` rows that have no audit row as `system` rows that carry the original actor. Examples are
    admin emergency actions taken while `StaffRpc` was down, and cron-recorded activations.
  - Its cursor is kept in `console_state`.
- **Allowlist.** `details_json` holds allowlisted fields only. Tokens, secrets, cookies and full IPs are never
  written.
- **Tamper evidence.** The append-only triggers, D1 Time Travel, the monthly R2 export and the partner-held statement
  hashes. This is not cryptographic (open question 25).

## Email

- **Provider:** open question 7. It needs SPF, DKIM and DMARC on the Hana domain. Invite and alert emails are part of
  the security model.
- **Senders.** Both the console and the admin Worker send through the same provider and domain. The admin Worker's
  origin notices are a separate send, with their own provider message ids.
- **Templates:**
  - `invite`, `invite_notice_owners`, `reenrol`;
  - `origin_add_pending` (with the cancel link), `origin_activated`, `origin_cancelled`, `origin_removed`,
    `origin_expedited`;
  - `suspension`, `resume`, `key_created`, `secret_key_created`, `key_revoked`, `key_restored`;
  - `member_changed`, `passkey_reset`, `owner_action_relayed`, `scope_pending_change`, `security_alert`;
  - admin-side: `security_origin_add_pending` (with its own cancel link), `security_scope_change`,
    `security_event`, `security_contacts_changed`.
- Emails are plain text plus simple HTML with no remote images. Links point only to `console.origin`.
- Delivery failures are retried with backoff and alerted on in the admin console after 3 attempts. Only the two
  origin-add notices block anything (each holds the origin's clock).

## Response headers (console and admin, on asset and Worker responses alike)

The Worker runs first on every request (`run_worker_first: true`) and adds these headers to every response, including
the ones `env.ASSETS.fetch` returns.

- **CSP:** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';
  font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`.
- **Other headers:** `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
  `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=63072000; includeSubDomains`.
- No third-party scripts.
- The auth origin sends the stricter CSP and `Cache-Control: no-store` above.

## Manifest (`packages/env`)

```jsonc
"originAddDelayMs": 86400000,                          // required, top level: 60 000 … 7 d; never 0
"console": {
  "workerName": "hana-id-console-<env>", "d1Name": "hana-id-console-<env>",
  "origin": "https://console.<domain>",
  "authOrigin": "https://auth.console.<domain>",       // must be "https://auth." + console host
  "redirectUri": "https://auth.console.<domain>/callback"  // must equal authOrigin + "/callback"
},
"admin": {
  "workerName": "hana-id-admin-<env>", "origin": "https://admin.<domain>",
  "accessTeamDomain": "<team>.cloudflareaccess.com", "accessAud": "<aud tag>",
  "staffEmails": ["…"]                                 // lowercased, non-empty
},
"usage": { "d1Name": "hana-id-usage-<env>", "queueName": "hana-id-usage-<env>", "dlqName": "hana-id-usage-dlq-<env>",
           "analyticsDataset": "hana_id_<env>", "exportsBucket": "hana-id-exports-<env>" },
"email": { "from": "Hana ID <no-reply@…>", "securityAlias": "security@…" },
"loginOrigin": "https://login.<domain>"                // batch B; optional until then
```

Refinements:

- All origins are distinct from each other and from `apiUrl`.
- `originAddDelayMs` is between 60 000 and 7 d. It is ≥ 24 h when `network` is a production network. That refinement
  is added with the mainnet network value.
- On a production network, `changeDelayMs ≥ originAddDelayMs` (a refinement, not a "should").
- The `console`, `admin` and `usage` blocks are optional, so an env without a dashboard still validates and deploys
  the API alone. `email` is required whenever `console` or `admin` is present. `console` and `admin` are present
  together or not at all, because origin adds need both notice channels.
- sandbox-dev uses `originAddDelayMs: 60000`, the same as its `changeDelayMs`.

`gen-wrangler` emits all three Worker configs and their `.dev.vars` placeholders. For the API it emits
`ORIGIN_ADD_DELAY_MS`, `NETWORK` (the manifest's `network`) and `REFUSED_ORIGINS` (a JSON list of whichever of
`console.origin`, `console.authOrigin`, `admin.origin`, `loginOrigin` and `apiUrl` are set). The passkey RP ID is the
console host. Secrets come only from `.secrets/<env>/`.

## CLI (`scripts/admin.ts`)

| Command | Change |
|---|---|
| `app:create` | Needs `--org`. It writes `scopes` (refusing a scope owned by another org or environment) and issues `pk_test_` or `pk_live_` by environment. Origins are written as pending `origin_changes` with `active_from` NULL and an `app_changes` row, exactly like `AdminRpc.createApp`. The `no_session` waiver applies only if this command created the `scopes` row |
| `app:origins:add` | Writes pending `origin_changes`, `app_origins` with `active_from` NULL, `app_changes`, and bumps `origins_version`. Never sets `active_from`. In an env with a console and admin Worker, both notice channels announce it |
| new `app:origins:announce <changeId>` | Only for an env with no `console`/`admin` block, and refused on a production network. Sets `notified_at` and `active_from = now + originAddDelayMs` (or now under a waiver), and writes `app_changes origin.notified` with `detail: {channel: "cli", emailed: "none"}`. Prints that no partner or security contact was emailed |
| `app:origins:remove`, `app:suspend`, `app:resume` | Immediate, with `app_changes`. Suspension writes `suspended_by` bit 1 (the trigger keeps `status` in step). `setStatusSql` is replaced |
| `app:list` | Shows pending origins, keys and `suspended_by` |
| `scope:register` | Gains `--owners-from-org <org>`, which reads the subs of the org's owners from `CONSOLE_DB` |
| new `owner:relay --body <file>` | The staff relay runbook (§On-chain owner actions): dry run, `--yes`, never prints the JWT |
| new `usage:backfill` | Copies legacy `usage` into `usage_daily` with `source='legacy'` (counts only), with `closed_at` set |
| new `uid:erase --scope --provider --sub` | Recomputes the uid with `USER_ID_KEY` from `.secrets/`, deletes `app_users` rows and NULLs the uid on events (the trigger allows exactly that). Never prints the key |

The `app:*` commands are removed once the admin console covers them after the pilot. `scope:register`, `owner:relay`
and the contract-admin commands stay.

## Security model

Trust boundaries, from most to least trusted:

1. The Cloudflare account: its members, API tokens and anyone with D1 write access. Any Worker deployed in the
   account can bind `AdminRpc`.
2. The API Worker.
3. The admin Worker (Access plus hardware keys).
4. The console Worker. It is in the trusted base for anything the API doesn't verify itself.
5. The partner browser.
6. Email.

| Threat | What it gets | Controls | Residual |
|---|---|---|---|
| XSS on the console origin | Requests with the victim's session: reads, removals, suspensions, cancels | CSP `'self'`; no JS origins on the console client; callback on a script-free origin that never redirects without a valid `state` and `code` and always ends its Location with `#`; server-chosen nonces; step-up needs a passkey tap and a Google click; the vault is on another origin | It can submit its own action for step-up and phish the taps. Then only the delay, both notices and the API ledger protect |
| Stolen console cookie | The same as XSS, from elsewhere | HttpOnly, Strict, 2 h idle / 12 h absolute; step-up; the destructive-call breaker | DoS by removing origins or suspending (a deliberate kill switch); recoverable the same day |
| Phished Google password (no session) | Nothing in the console | A mandatory passkey; enrolment only through a consumed invite | — |
| Hijacked live Google session of an on-chain owner | On-chain owner tokens with any nonce, outside our console | The timelock (AddClient, SetOwners, SetAllowShared), cancel by any owner, the console and admin watchers' emails | It can cancel its own removal (open question 4). Immediate `remove_client` and `disable_shared_login` give a DoS on its own scope. The per-scope caps limit its spam; the safety budget is separate |
| Compromised console Worker | It chooses the Google nonce at every routine owner sign-in and step-up, so it can mint an owner-action token (for example `SetOwners` adding an attacker `Oidc`, or `AddClient`) or an origin-change token from an ordinary sign-in, with no phishing. It can suppress console emails, show change A and request change B, and call every `ConsoleRpc` operation the API doesn't verify | The API verifies origin adds against on-chain owners and the exact change; an origin's clock starts only after the admin Worker's own notice to security and the org's security contacts (stored in the hot DB, settable only by Hana); the admin watcher emails every on-chain pending change, owner change and client change independently; the timelock lets owners or Hana cancel; console audiences are clients of a sink scope only, so console tokens can't open a session in any used scope; the destructive-call breaker; Hana can clear any suspension bit and restore keys; `app_changes` | During `change_delay_ms`, someone must read the admin notice and cancel. Mainnet needs ≥ 24 h (manifest refinement). Kill switches up to the breaker limits are a DoS; origins it removed come back only through the delay |
| Compromised Hana staff account | Staff powers | Access with hardware keys; staff adds always get the full delay and both notices; staff can't move a scope out of a real org; `createApp` and `assignScopeOrg` check the on-chain owners against the org; staff adds are refused for `originAddDelayMs` after a move; expedite only for member-proposed adds; audited and emailed to owners and security contacts | Social engineering of passkey resets and expedites (out-of-band check, notices). A staffer can set an org's security contacts, which is notified to the old and new contacts |
| Insider with Cloudflare account or D1 write access | Can insert active origin rows, drop triggers, edit security contacts | Drift detection; R2 exports; partner-held statement hashes | The trust root is Cloudflare account hygiene. Not cryptographic |
| Mail scanners | Fetch links | A GET never cancels; no approve links | — |
| Lookalike origins | An IDN homograph or a confusable host passes human review during the delay | ASCII-only storage; `xn--` labels flagged with the decoded form in every notice; mixed-script labels refused on live scopes | Same-script confusables (for example `rn` and `m`) rely on the reader |
| Replay of a public on-chain owner token | Login or a step-up | Random server-held login nonces; domain-separated layouts; token reservation | — |
| Cross-environment replay | — | `env` in every digest; the signer in on-chain layouts | — |
| Owner-action quota exhaustion | One partner looping propose and cancel to block others' safety calls | Per-scope caps; a reserved safety budget; the staff relay runbook | — |
| Usage inflation | Billable-looking usage | Only post-gate events reach D1, capped by `per_day`; the splits | Relayed-rejected gas is real cost (open question 17) |
| Re-identifying users from `uid` | Linking uid to on-chain paths | Keyed HMAC; the key only on the API; uid stripped after month close + 35 d; no user list | Hana, holding the key, can always re-identify. A key leak re-links uids |
| Dashboard load or bug | Logins | Separate databases and Workers; RPC-only access; at most 3 indexed hot-DB statements per call under an API-enforced budget; usage reads never touch the hot DB | RPC runs in the API's isolate (logical, not physical, isolation) |

## Trade-offs accepted

| Trade-off | Mitigation |
|---|---|
| We own security-critical auth code (OIDC client, sessions, WebAuthn, recovery) | The test list; a maintained WebAuthn library if it works on workerd; the external audit |
| A client secret must be managed | A Worker secret, kept only in `.secrets/` |
| If Google is down, the dashboard is down | End-user logins are unaffected |
| Partners wait 24 h for a new origin | The `no_session` waiver on new scopes; the audited expedite |
| Origin adds wait for the admin Worker as well as the console (up to 5 min more, and none while the admin Worker is down) | Fail closed is the point; removals and suspensions don't wait |
| Single-owner orgs depend on Hana for same-day origin changes | The expedite procedure (open question 26) |
| Passkey resets are a social-engineering target | An out-of-band check, notices to all owners, a 24 h reenrol invite, an audit row |
| The `no_session` waiver relies on the API seeing the first session. `create_session` can be called on the contract directly, bypassing the API | Such sessions still needed an allowed origin or the partner's own client. Staff-only adds get the waiver only on a scope the same call created. Waived adds are still notified |
| No atomic writes across the three databases | Write-ahead audit, `app_changes` in the same batch, idempotent RPCs with stored results, the reconciler |
| More to deploy (three Workers, three databases, a Queue, a consumer, crons) | Additive-only RPC; expand-only migrations; the API deploys first |
| Origin adds depend on on-chain owners and NEAR RPC | Fails closed; removals still work; non-owners or NEAR-only scopes get a staff add (open question 12) |
| Staff origin adds skip owner step-up (a power that exists today in the CLI) | Full delay, both notices, audited (open question 13) |
| Billing counters depend on a Queue (a consumer outage over 14 days loses events) | The direct-write fallback; DLQ and backlog alerts; the AE cross-check alert |
| Settlement makes one `tx` RPC call per relayed transaction | Bounded batches every 15 min; open question 44 |
| `USER_ID_KEY` is a single point: losing it breaks new-user continuity, and a leak re-links users | Offline backup; API-only; never logged |
| `app_users` is a lasting per-user pseudonymous record | Needed for new-user counts; deleted with the app + 30 days |
| uid is per scope, so two apps in one scope share pseudonyms | Same partner, same wallets |
| MAU misses users who reuse a cached key (batch B) without any call | Stated on the statement |
| Gas that can't be settled within 24 h stays `unsettled` | Shown, never estimated |
| Statements are gross (the signer's 30% gas reward isn't netted) | Stated on the statement |
| Partners can't look up an individual user | Aggregates only, by design |
| Passkey RP ID = the console domain; changing it invalidates every passkey | Pick the domain before onboarding (open question 6) |

## Rejected (don't reopen without new facts)

- **A hosted auth provider (WorkOS, Clerk, Auth0).** None can issue a console-client token bound to our owner-action
  nonce, so we would run two identity systems.
- **Cloudflare Access for partners.** Seats beyond 50 cost money, partner IdPs are messy to federate, and it can't
  produce console-client tokens.
- **GIS in-page sign-in, or the browser computing nonces.**
- **Google-only MFA, passkey-only step-up, Google-only step-up.**
- **Stateless JWT sessions; a 30-minute idle timeout; 12 h idle / 7 d absolute.**
- **One Worker serving the partner and admin consoles.**
- **A shared D1 for console and hot data.**
- **The API trusting the binding for origin adds.**
- **The origin delay held in the console DB.**
- **A `verifyConsoleToken` RPC.**
- **The admin Worker binding `CONSOLE_DB`; a staff table in a partner-writable database.**
- **Latency from Analytics Engine.**
- **Extending the `usage` counters; a bare `waitUntil` billing write.**
- **Rounded pNEAR/Mgas totals; SQL OFFSET percentiles; HyperLogLog MAU.**
- **Unkeyed `sha256(sub)`; MAU from `create_session` only; MAU from an indexer.**
- **User lists or SDK-reported addresses.**
- **Recording gate rejections in D1.**
- **Hash-chained audit rows.**
- **Recomputing a closed day.**
- **Ledger retention of 40 or 100 days.**
- **Delay rules per mode or key type; exempting own-client or test-key apps.**
- **Applying a change when its email fails; rolling back with a 503.**
- **GET cancel links; approve links in email.**
- **Step-up for removal or suspension.**
- **Hana proposing and expediting the same add; banning all shortening.**
- **Origins on chain as a timelocked change.** It needs a contract change and a chain read on every login.
- **NEAR keys or `admin_register_scope` in the admin Worker.**
- **Rebuilding `apps` in 0003.** The 0001 cascades would delete origins and usage (§Data).

## Retention

| Data | Kept for | Who purges |
|---|---|---|
| `usage_events` (the ledger) | 400 days (the dispute window, open question 15). The uid is NULLed at month close + 35 days | API daily cron, batches of at most 500 rows per statement: `UPDATE usage_events SET uid = NULL WHERE day < ? AND uid IS NOT NULL` (on a `LIMIT`ed rowid subquery), and the same for the `DELETE` past 400 days. The triggers allow exactly these two writes |
| `app_users` | Life of the app + 30 days | API daily cron (it knows `apps.deleted_at`) |
| Daily and monthly totals, failures, adjustments, statements, `near_usd_rates` | Contract term + 24 months | Admin, by hand after review (the closed-row triggers block it otherwise) |
| `audit_log`, `app_changes`, `origin_changes` | 36 months (the retention constant in the triggers: at least the longest contract term + 24 months; a migration changes it) | Console (`audit_log`) and API (`app_changes`, `origin_changes`) monthly, in batches |
| `invites` | 90 days after acceptance, revocation or expiry | Console cron |
| `console_sessions` | 30 days after expiry; network data (country, ASN, IP prefix) 90 days | Console cron |
| `auth_flows`, `handoff_codes`, `webauthn_challenges`, `pending_actions` | 24 h after expiry | Console cron |
| `rpc_results` | 24 h | API hourly cron |
| `email_outbox` | `to_email` and any cancel token cleared 30 days after a final status; rows kept with the audit log | Console cron |
| Analytics Engine | 3 months | — |
| Queue messages | 14 days | — |
| D1 Time Travel | 30 days | — |

Purges run in batches that stay under the per-invocation query limit and never touch totals.

## Tests (one per behaviour)

Use `@cloudflare/vitest-plugin` (`cloudflareTest`, as in `apps/api/vitest.config.ts`), with its auxiliary-worker
config for the multi-Worker tests over real service bindings (Miniflare). Google's token endpoint, the JWKS, WebAuthn
authenticators, the Access JWKS, NEAR RPC and the email provider are mocked with fixed keys.

**Topology and config**

- The API's login tests pass with no console or admin Worker, and with no `CONSOLE_DB`, `USAGE_DB`, `USAGE_Q` or
  `ANALYTICS` (capture is a no-op).
- `ConsoleRpc` and `AdminRpc` can't be reached through the public `fetch`.
- `ConsoleRpc` can't call `AdminRpc` methods.
- Config snapshots:
  - the console binds only `ConsoleRpc`;
  - the admin config has `workers_dev: false` and `preview_urls: false`;
  - only the console binds `CONSOLE_DB`;
  - the console and admin configs have `run_worker_first: true`.
- Hostname dispatch:
  - On the auth host, `/`, `/index.html`, `/assets/*` and any unknown path return 404 with no HTML script and no JS,
    and `env.ASSETS` is never called.
  - On the console host, `/api/*` reaches the backend and other paths are served from assets.
  - An unknown host gets 404.
- Each package's migrations apply only from that package. The admin Worker's SQL touches only the derived and admin
  state tables in `USAGE_DB`. The API's SQL touches only `usage_events` and `app_users`, whose only post-insert writes
  are the two retention statements.
- The manifest refinements:
  - distinct origins, and the `authOrigin` and `redirectUri` form;
  - `originAddDelayMs` required, with its bounds and the production minimum;
  - `changeDelayMs ≥ originAddDelayMs` on production;
  - `console` and `admin` present together;
  - a non-empty staff list.
- `gen-wrangler` emits `ORIGIN_ADD_DELAY_MS`, `NETWORK` and `REFUSED_ORIGINS` for the API. The API refuses origin adds
  with `internal` when the delay var is missing or out of range.
- An integration test calls across the service bindings.

**Code flow**

- `state`, the start handle, PKCE and nonce are single use.
- Each of these is refused: bad `iss`, bad `aud`, expired `exp`, wrong nonce, `iat` over 120 s, and, for
  `openid email` flows, a missing `email` or `email_verified: false`.
- An `openid`-only owner-action flow is refused when the token carries an `email` claim, and accepted without one.
- `GET /callback` with no query (fragment only), with `code` but no `state`, with an unknown or used `state`, or
  without the `__Host-hana_af` cookie: each answers 400 with no `Location` header and `Cache-Control: no-store`.
- `GET /callback?error=access_denied&state=…` answers the static 400 page, not a redirect.
- A success redirect's Location ends with `#`.
- A handoff code works once, expires after 60 s, and is refused without the matching pre-flow cookie.
- A flow started in one browser (cookie jar) and completed in another is refused at `/callback`.
- The ID token is never in a response body, a log line or D1.
- The auth origin serves no script and sends `no-referrer`.
- A replayed on-chain owner token, and a step-up or origin token, are each refused for login.
- Sign-in completes through the Google redirect chain in Chromium, Firefox and WebKit (Playwright, staging).

**Invites**

- Each of these is refused: expired, revoked, reused, wrong email, wrong `hd`, an owner inviting above their own role,
  an owner inviting into another org, and a reenrol invite with the wrong sub.
- Two concurrent acceptances produce exactly one member.
- A 0-row UPDATE inserts no member, org, user or audit row.
- An existing user with no membership (a removed member re-invited) accepts with their existing user id, and no second
  `console_users` row is created.
- A disabled user's acceptance is refused (`user_disabled`), and the invite stays unconsumed.
- An existing member of org A accepts an invite to org B at sign-in and gets both memberships. An invite into an org
  the user is already in gets `already_member`.
- A reenrol invite inserts no member, starts an `enrol` session, and is refused when `bound_sub` doesn't match.
- A new-org invite creates the org, and the member row uses the new org id.
- Not invited gives 403 with no user row, and the refusal is audited.
- The invite hash is never returned.
- The pending-invite cap applies.
- Every issue, accept, refuse, revoke and expire writes `audit_log`.

**MFA**

- `pending_mfa` and `pre_mfa` sessions can reach only the enrol and passkey routes.
- Each of these is refused: a replayed challenge, wrong RP ID, wrong origin, UV not set, a counter going backwards,
  another user's credential, and a revoked credential.
- A first passkey can be registered only in an invite-consumed session.
- A sixth passkey is refused. Removing the last passkey is refused.
- A reset revokes passkeys and sessions, emails the member and the owners, and needs the 24 h reenrol invite.
- `amr` and `auth_time` are recorded but not used.

**Sessions**

- Idle (2 h) and absolute (12 h) expiry.
- `last_seen_at` is written at most every 5 min.
- The id rotates at sign-in and at the MFA upgrade.
- Revocation on member removal, role change, passkey reset, user disable and org freeze.
- CSRF refusals for each missing piece: `Sec-Fetch-Site`, `Origin`, `x-hana-console`, `content-type`.
- The role matrix: every action × role cell, including `required_hd` filtering.
- Rate limits on `/api/auth/*` and the auth-origin routes.

**Step-up**

- Each of these is refused: a digest for another action, another session, a stale `iat`, a sub mismatch, reuse, an
  expired pending action, and a Google proof without a prior passkey proof.
- A step-up completed in another browser is refused (no `__Host-hana_af`).
- A step-up whose session was revoked, or has passed its idle or absolute limit, between the passkey and the callback
  is refused.
- Retrying the same action creates a new pending action with a different passkey challenge, and succeeds. The old
  challenge and its assertion are refused for the new pending action.
- Each purpose's nonces are refused for the others (login, step-up, origin change, owner action).
- Console-only actions consume, change and audit atomically, and a lost race writes nothing.
- Every step-up action writes an audit row and emails the other owners.
- The canonical-JSON and digest vectors match the independent implementation.

**Origins**

- `changeOrigins` is refused for each of: bad signature, aud not in `console_audiences`, `iat` over 300 s, wrong
  nonce, a non-owner sub, a reused token, a version mismatch, a refused origin, and NEAR RPC down (fails closed).
- An add stays inactive (`active_from` NULL) until both `markOriginsNotified` and `ackOriginNotice` have landed, in
  either order. With only one of them, it stays inactive. A failed send on either channel keeps it inactive, and a
  retry starts the clock.
- With the console outbox stopped and `markOriginsNotified` called by a simulated compromised console without sending,
  the admin notice still goes to the alias and every security contact, and the clock starts only after it.
- A pending origin is refused by both `getAppByKey`/`originAllowed` and `anyActiveAppAllowsOrigin`, and becomes
  allowed by predicate once the clock passes, with no executor.
- The hourly cron records the activation (`status = 'active'`, `app_changes origin.activated`) once, and the console
  reconciler writes the audit row and queues `origin_activated`.
- `origins_version` bumps on add, remove and cancel. It doesn't bump on either notice, on activation or on expedite.
  A step-up in flight survives another change's notice and activation.
- Removes sent with an add apply at once, in the same batch.
- A cancel works for each of: owner, admin, Hana admin, the console-channel link and the admin-channel link. The link
  GET doesn't cancel. Each link token is single use and refused after `active_from`. A token from another change is
  refused.
- The `no_session` waiver applies only while `first_session_at` is NULL. For a Hana actor, it applies only to the
  initial origins of a `createApp` that created the scope row. A staff add on an existing scope with
  `first_session_at` NULL gets the full delay. `first_session_at` is set once and is repaired after a failed write.
- The `loopback` waiver applies only to test scopes in non-production envs.
- Expedite:
  - refused for a Hana-proposed add, for an unannounced change, and without a reason or contact;
  - audited and emailed.
- A staff add gets the full delay, and is refused within `originAddDelayMs` of a scope assignment.
- Removals, suspensions and cancels are immediate and need no step-up.
- In production, wildcard, non-https and localhost origins are refused. The console, auth, admin, login and API
  origins are refused everywhere.
- `normaliseOrigin` shared vectors: IDN to punycode, default ports, trailing dot, `[::1]`, uppercase. The API, the
  console and the CLI give byte-identical results. An `xn--` origin is flagged in the console view and in both
  notices with its decoded form. A mixed-script label is refused on a live scope.
- Drift detection flags a directly inserted active row in `security_events`, and the admin cron emails security once.
- The admin security feed emails removals, suspensions and revocations from `changesSince` even when the console
  outbox is stopped.
- When a `SetAllowShared` proposal is shown, its email lists the active origins.

**Destructive-call breaker and recovery**

- The sixth suspension, revocation or removal through `ConsoleRpc` for one org within an hour is refused with
  `rate_limited` and writes a `breaker` security event. So is the 21st across all orgs.
- `AdminRpc` is not limited.
- Cancels of pending adds aren't counted.
- `AdminRpc.setSuspended` clears bit 4. A member's resume never clears bits 1 or 2.
- `AdminRpc.restoreKey` restores a key revoked 6 days ago, which then passes the gate again. It is refused for a key
  revoked 8 days ago and for a rotation's grace end. It is audited and emailed.

**Hot-DB budget**

- Each `ConsoleRpc` method issues at most 3 hot-DB statements (counted by a D1 wrapper in tests).
- Over budget, the call is refused with `rate_limited`.
- `usage` and `statements` issue no hot-DB statement.
- Load test (staging): the median and p95 of `getAppByKey` don't change by more than 10% under a sustained console
  load at the budget ceiling.

**Keys**

- pk rotation keeps the old key valid until the grace ends.
- A revoked key is refused at the gate with 401 `unknown_app`.
- A secret key is shown once, and only its hash is stored.
- A prefix that doesn't match the scope's environment is refused. The key limit applies.
- A secret key is refused on every management route.

**Apps and scopes**

- `createApp` is refused when the org has no security contacts, and when any `Owner::Oidc` of the scope isn't an owner
  sub of the target org.
- `assignScopeOrg` is refused for a scope not in `org_legacy` and for the owner mismatch. It moves every app of a
  two-app scope in one statement. It emails the new org's owners and security contacts.
- Updating one app's `org_id` alone violates the trigger.
- `deleteApp` sets `deleted_at` and bit 1, and revokes every key. The app's key then gets 401 at the gate.
- `setSecurityContacts` is reachable only through `AdminRpc`, writes `app_changes org.security_contacts`, and emails
  the old and new contacts.

**Owner actions**

- The TS port matches `test_fixture.json` and the worked examples.
- The token request is `openid` only.
- A sub mismatch is refused.
- The relay over `ConsoleRpc` is byte-identical to the built body.
- `clientIp` feeds the per-IP limiter.
- A moved N aborts and asks for a rebuild (no silent retry).
- The API precheck refuses an owner-nonce mismatch with 409 `owner_nonce_mismatch` before any token reservation and
  without relaying. It re-reads an uncached scope before refusing. A `NOT_EXECUTED` relay failure still releases the
  reservation.
- The AddClient proof's `aud` and nonce are checked by the console and by the precheck. A proof with the wrong `aud`
  or nonce is refused with `invalid_client_proof`.
- The helper is served only as a download (`Content-Disposition: attachment`), never as a console page, and the paste
  step shows the PII warning.
- The per-scope cap: the 21st action of a scope in a day is refused. One scope looping propose and cancel can't make
  another scope's `cancel_change`, `remove_client` or `disable_shared_login` fail. The safety budget is separate from
  the general global caps. Reaching a cap writes a security event.
- The allowance check writes `owner_allowance_low` below the threshold.
- The console pending-change watcher emails owners once per change, including changes relayed outside the console.
- The admin watcher emails security and the security contacts about a `SetOwners` adding an `Oidc` and about an
  `AddClient`, each relayed directly while the console outbox is stopped. It emails an owner-set or client-set
  change found by the snapshot diff once.
- The owner-drift flag appears when the D1 owners differ from the on-chain owners.

**Admin**

- Each of these Access JWTs is refused: missing header, wrong `aud`, wrong `iss`, expired, unknown `kid`, a service
  token (empty `sub`), and an email not on the allowlist (local JWKS).
- The actor is written to `audit_log` and `app_changes`.
- An AdminRpc suspension works with the console Worker down, and the reconciler mirrors it into `audit_log` later.
- Only a Hana actor clears bits 1 and 2. An org resume doesn't clear a Hana suspension.

**Audit and email**

- A failed RPC leaves a `pending` row plus a `failed` outcome row.
- The reconciler resolves stale `pending` rows.
- The triggers abort UPDATE and in-window DELETE on `audit_log` and `app_changes`, and allow DELETE past the 36-month
  constant.
- The write-ahead row exists before any hot-DB change.
- A repeated `requestId` returns the stored `rpc_results` row and writes nothing new.
- `details_json` allowlist snapshots.
- Outbox retry with backoff; the alert after 3 failures; `to_email` and cancel tokens are cleared.

**Hot DB and gate**

- Migration 0003 on an empty DB, and on a sandbox-dev snapshot that has origin rows and legacy `usage` rows:
  - the row counts of `apps`, `app_origins` and `usage` are unchanged;
  - legacy apps keep working;
  - existing origins have `active_from = 0`;
  - every existing scope gets `first_session_at` set;
  - the indexes `apps_scope_id` and `app_origins_origin` still exist.
- The old (batch A) gate SQL and `anyActiveAppAllowsOrigin` SQL run against the post-0003 schema and give the same
  answers. A suspension written as `suspended_by` shows as `status = 'suspended'` through the trigger.
- Migration 0005 on a post-0004 snapshot keeps the app, origin and key counts and the indexes, and recreates the
  triggers.
- A test/live mix in one scope is rejected, by the migration and by the RPC.
- The `org_id` triggers.
- Org A asking for org B's app gets `not_found` on every `ConsoleRpc` org method.

**Usage**

- uid:
  - vectors cross-checked with an independent Node implementation;
  - scope separation; `key_index` ignored;
  - path parsing rejects a wrong scope prefix and wrong part counts;
  - the same uid from the `create_session` path and from the derive path.
- Gas:
  - a BigInt sum over a recorded sandbox-dev `tx` response at FINAL (about 20 Tgas), including every receipt;
  - relay-time gas is stored only as `relay_gas_burnt`, and every relayed event is `pending` until settled;
  - each RelayResult code maps to the `relayed` and `gas_status` in the table; a dropped `relayer_busy` is `none` and
    is never polled.
- Events:
  - one per post-gate outcome on every endpoint, and none for gate rejections or `GET /v1/app`;
  - an allowlist snapshot shows no sub, JWT, email, IP or session key;
  - a queue-send failure falls back to D1;
  - `org_id` is stamped from the gate row.
- AE: one data point per request, including rejections, with the documented layout. `ledger` is `'1'` exactly when a
  UsageEvent was sent.
- The AE cross-check, on a mix of gate rejections and post-gate events, compares only `ledger = '1'` points and
  alerts, without blocking, on a gap.
- Consumer:
  - redelivery is idempotent;
  - a malformed message goes to the DLQ;
  - `first_seen_day` is the minimum when events arrive out of order.
- Rollup (Miniflare D1):
  - a recompute is idempotent, and touches only `source = 'ledger'` rows;
  - on the deploy day, a legacy row and a ledger row for the same app-day coexist, and both survive the recompute;
  - p50 and p95 with 1 and 2 samples, and random sets, match brute force;
  - UTC boundaries at 23:59:59.999;
  - MAU is distinct across days and endpoints, and a session crossing the 1st counts in both months;
  - closed rows are immutable; late events become adjustments;
  - settlement against mocked RPC at FINAL, including `unsettled` after 24 h;
  - settled timeout gas lands in `gas_error`;
  - a missing rate blocks the month close;
  - USD rounding vectors;
  - after `assignScopeOrg`, rows not yet closed move to the new org and closed rows keep theirs.
- Retention:
  - the uid is NULL on events after month close + 35 d;
  - events older than 400 days are deleted;
  - `app_users` rows go 30 days after `deleted_at`;
  - each batch stays under the per-invocation query limit and never touches totals;
  - any other UPDATE or DELETE on `usage_events` aborts;
  - `uid:erase` NULLs the uid through the allowed statement.
- Golden CSV, byte-stable:
  - quoting cases;
  - injection cases (`=cmd`, `@x`, `-x` prefixed);
  - a negative adjustment (`-2.21`) left unprefixed;
  - the `adjustments` format;
  - owner-action scope rows;
  - `legacy` rows.
- The ledger CSV `final` gas, summed per org-month, equals the statement's `tgas` and `near` exactly, owner actions
  included.
- The legacy backfill rows are marked `source='legacy'` and closed.
- `ConsoleRpc.usage` refuses ranges over 400 days and more than 100 apps.

**Headers**

- The CSP and the other headers are present on asset responses and Worker responses for the console and admin.
- The auth origin's stricter CSP and `no-store`.

**Testnet smoke (sandbox-dev, after deploy)**

Prerequisites, before the smoke:

- Open questions 1, 3, 6, 7, 8 and 11 are answered.
- The console sink scope exists (§Address impact).
- A partner org exists with an accepted owner and at least one security contact.
- A new test scope is registered with `admin.ts scope:register --owners-from-org <org>`, so its owners include that
  owner's `Owner::Oidc`.
- A test app is created on that scope with `AdminRpc.createApp`.

`s1` and `s2` are owned only by `Owner::Near` (the env's owner account), so the origin and owner-action criteria
can't pass on them. They stay as the batch A smoke references.

Steps:

- Invite, sign-in, passkey.
- On the smoke scope: an origin add with the delay (both notices received), and cancel by link from each channel.
- On the smoke scope: propose, execute and cancel through the console. The admin notice arrives for the proposal.
- On `s1`: an origin removal and a suspension, and their resume. The admin feed emails them.
- A statement for the month whose ledger CSV totals match.
- Staging Playwright on a Hana account: the Access header reaches the admin Worker, and the code flow completes under
  the CSP.

## Build order

1. **API prerequisites:**
   - `packages/oidc` (with the new claims);
   - `packages/console-core` layouts, fixtures, `normaliseOrigin` (moved), and §Types;
   - the precheck nonce checks;
   - the `handleOwnerAction(body, clientIp)` refactor and the per-scope and safety caps;
   - gas fields;
   - migration 0003 (expand), the gate SQL and the status trigger;
   - `first_session_at`;
   - the new API vars and the `NETWORK` checks.
2. **Usage pipeline:** `USAGE_DB`, the Queue, the consumer, AE (with `ledger`), uid, the retention cron; remove
   `countUsage`.
3. **`ConsoleRpc` and `AdminRpc`:** the origin rules, both notice acks, drift detection, `security_events`, the
   breaker, the hot-DB budget and `rpc_results`. Deploy-plan's console sink scope step.
4. **Console Worker:** hostname dispatch, auth origin, code flow, invites, passkeys, sessions, step-up, features,
   outbox, announcements, crons. Blocked by open questions 1 (owner actions), 6 (domain and auth host), 7 (email),
   8 (WebAuthn) and 11 (account).
5. **Admin Worker:** Access, `StaffRpc`, screens, security contacts, the notice sender, the on-chain watcher, rollups,
   settlement, rates, statements, R2. Blocked by open questions 2 and 3 (Access), 6, 7 and 11.
6. **CLI changes;** backfill; `owner:relay`.
7. **Testnet smoke** (its prerequisites above).

## Out of scope for batch C

- Stripe, plans, invoicing and self-serve billing. The data model is ready: nullable org billing fields and per-plan
  rows.
- Public registration and self-serve scope registration (`public_registration` stays off).
- Per-user lists, wallet addresses, opt-in address reporting.
- A `/v1` API that accepts secret keys.
- **Second-owner approval of a pending origin add** (`origin.approve`, `ConsoleRpc.approveOriginChange`, the
  `hana-id/origin-approve/v1` layout). The `approved_by_sub` and `approved_at` columns stay. If it ships, these rules
  apply:
  - The API itself enforces the approver's tenure. Its hourly cron records `(scope_id, provider, sub, first_seen_at)`
    in a hot-DB `scope_owner_seen` table from uncached `get_scope` reads.
  - It refuses an approver first seen on chain less than `originAddDelayMs` ago.
  - The console's `members.role_since` check is never the only check.
- An org policy "a second owner must approve every add"; timelocking role grants (open question 27).
- Hash-chained or externally anchored audit (open question 25).
- Origins on chain.
- NEAR events from `create_session`/`derive_key` as a billing cross-check. That is a contract change and needs the
  external audit.
- SAML/SSO for partners, mobile app identifiers, webhooks.
- Email login.
- Mainnet deploy.
- Contract governance changes (open question 4).

## Address impact

**No user address changes.** One change to client registration is called out here.

- **Unchanged:** no path (`scope#provider#sub#key_index`), key index, HKDF salt, CKD domain, signer account,
  session-layout or contract nonce-layout change.
- **The console client moves from `global` to a Hana console sink scope** (changed by this review; open question 38).
  - **Why.** Today `consoleAudiences` are registered as clients of `global` (`scripts/lib/deploy-plan.ts`,
    `register-global`, and README step 117), and `global` is Hana's own app scope, with real wallets. Through
    `session_scope`, a console-client token whose nonce follows the session layout would open a `global` session for
    that user, and `derive_key` would then give their `global` wallet key. A compromised console chooses the nonce for
    every partner and staff sign-in.
  - **The sink.** A dedicated `sN` scope:
    - owned by `Owner::Near` (the manifest's `owner`);
    - with only the console audiences as clients and `allow_shared = false`;
    - with no app and no origins.

    Registering the audiences there still stops a partner from claiming them with `AddClient`. A console token can
    then only reach a scope nobody uses.
  - **deploy-plan** gains a step that runs before `register-global` on a fresh env. On an existing env such as
    sandbox-dev, it runs in one plan:
    1. `remove_client` of each console audience from `global` (an owner action by the NEAR owner; immediate).
    2. `admin_register_scope` for the sink, straight after.

    For the seconds between the two, an `AddClient` claim would still be timelocked and seen by the watchers. The plan
    finds the sink afterwards with the same client-to-scope lookup it uses for shared clients. `register-global` no
    longer adds console audiences to `global`, and its 10-client check counts only `googleClientIds`. The README
    changes to match.
  - **Who it affects.** No `global` user's address changes, because the path contains no client ID. Only
    console-client tokens lose the ability to open `global` sessions, and no one uses that.
- **Off-chain only:** the new nonce domains (`hana-console/*`, `hana-id/origin-change/v1`, the reserved
  `hana-id/origin-approve/v1`, `hana-id/uid/v1`) and the uid. Rotating `USER_ID_KEY` affects only MAU and new-user
  continuity.
- **Owners are identified by Google `sub`.** Testnet showed it is stable across clients in one Google Cloud project.
  Before ever moving the console client to another Google Cloud project, confirm that `sub` stays the same across
  projects. Otherwise every OIDC owner would have to be re-registered; owners change, not user addresses.
- **The test/live invariant** decides which scope new apps are registered under. It doesn't change any existing
  derivation, and sandbox-dev's `s1` and `s2` comply.

## Contract changes

None.

- **What already exists:** `console_audiences`, `Owner::Oidc`/`OwnerAuth::Oidc` (console audience plus the
  `hana-id/owner-action/v1` nonce), `get_scope`/`action_nonce`, `remove_client`, `admin_register_scope`, the timelock
  (AddClient, SetOwners, SetAllowShared) and the `change_proposed` events cover this design.
- **Operational requirement:** on mainnet, `changeDelayMs ≥ originAddDelayMs` (≥ 24 h), enforced as a manifest
  refinement.
- **Flagged for the contract and governance spec:** a compromised OIDC owner can cancel any pending change, including
  a `SetOwners` that would remove them (open question 4). Fixing it before the address freeze has no address impact.

## Open questions

**Identity and auth**

1. Does Google's code flow accept `scope=openid` alone for the console client and return an ID token without email
   or name? Google's docs say `profile` or `email` must be included. Test this on sandbox-dev before freezing (it is
   shared with batch B's openid-only item). The callback refuses an owner-action token that carries `email`, so if
   Google always includes it, owner actions stop working until this is decided. The fallback is to accept the email
   after an explicit partner disclosure, and ideally a dedicated no-PII Google account per owner. **Blocks build
   step 4 (owner actions).**
2. Can Cloudflare Access enforce hardware keys with Hana's IdP? The rule depends on `amr`, which Google Workspace may
   not send, and the "Security keys only" option may not be offered for Worker-level apps. Fallbacks: Workspace 2SV
   with security keys only for the staff group, or Access's own MFA. Verify on the Hana account. **Blocks step 5.**
3. Does `Cf-Access-Jwt-Assertion` reach a Worker that has static assets under Worker-level Access? With
   `run_worker_first: true` the Worker sees every request first, which should settle it; confirm on the Hana account.
   Fallback: a hostname-based Access app on the Hana zone. **Blocks step 5.**
4. Contract governance: should cancel be limited to the proposer, need a second owner, or have a NEAR-owner veto, or
   should a Hana-admin freeze of the owner set be possible after verification? Decide in the contract spec before the
   address freeze.
5. Should production `change_delay_ms` be 24 or 48 h? (It must be ≥ the origin delay; that is now a refinement.)
   Should partners be able to raise their own delays but never lower them?
6. Which Hana-owned domain hosts the console, auth and admin origins? The `__Host-` cookies, the `auth.` origin and
   the passkey RP ID depend on it, and changing it invalidates every passkey. On dev envs on workers.dev, one Worker
   can't serve two hostnames. Should the auth origin be a tiny separate Worker forwarding over a binding (a fourth
   Worker, which would change a decision), or should every deployed env, sandbox-dev included, need a Hana zone?
   **Blocks steps 4 and 5 and the smoke.**
7. Email provider: Cloudflare Email Sending (beta, needs Workers Paid, possibly limited to verified destinations
   until the domain is onboarded) or Resend, Postmark or SES. Check sending to arbitrary addresses and the real cost,
   and set up SPF/DKIM/DMARC. (Origin notices now also come from the admin Worker, which fails closed.) **Blocks steps
   4 and 5.**
8. WebAuthn on workerd: does `@simplewebauthn/server` (current version) work, or do we write a minimal ES256/EdDSA
   verifier? Use fixed-vector tests either way. **Blocks step 4.**
9. When an org has more than one owner, should a Hana passkey reset also need another org owner's approval in the
   console?
10. Should the console offer a NEAR-account owner during onboarding, as a non-Google recovery and cancel path?
11. Prerequisite: a Hana-owned Cloudflare account and zone (sandbox-dev runs on a personal account). Who holds member
    and API-token access, given that any Worker in the account can bind `AdminRpc`? **Blocks steps 4 and 5 and the
    smoke.**

**Origins and keys**

12. Developers who are not owners, and scopes owned only by NEAR accounts: the MVP rule is a staff add, or adding an
    OIDC owner on chain. Later, should members propose and an OIDC owner approve through step-up?
13. Should staff origin adds through `AdminRpc` need two staff approvals for shared-login live apps?
14. Should the batch B Hana login page be in the loop for own-client mode too? If so, the partner's Google origin
    list stops being a second gate, and batch B must use the same `active_from` predicate.
26. The exact expedite procedure: which contact on file counts as out-of-band, and should a second Hana admin
    co-sign? This matters most for single-owner pilot orgs such as Sodax, now that second-owner approval is deferred.
27. Should granting the owner or admin role (and invites with those roles) be timelocked as well as emailed?
30. The default pk rotation grace (0 to 7 days), and whether a grace above 0 needs a reason.
33. Where do partners test locally once production envs refuse loopback: a Hana-run testnet env with its own
    console, or loopback allowed on test scopes in production?
36. Should secret-key management ship in batch C, before any `/v1` endpoint accepts secret keys, or wait for its
    first consumer?

**Reporting and billing**

15. The ledger retention and dispute window should be named in the service contract. 400 days is the default, and
    the statement-hash scheme assumes the partner keeps its copy.
16. Which NEAR/USD source the service contract names, and whether it prices daily (as designed) or at a monthly rate.
17. Is gas burnt by relayed-then-rejected calls billable to the partner? Third parties can trigger it (about
    2.2 Tgas each). Related: pre-check the session counter with a view call before relaying.
18. Are testnet pilot statements billed to Sodax at the mainnet price? Should the legacy `usage` backfill appear on
    them?
19. Confirm on the target accounts: Queues availability and limits (sandbox-dev's personal account may be on the
    Free plan), 14-day retention, that D1 enforces `BEFORE UPDATE/DELETE` triggers (a migration test covers it), and
    the AE sampling behaviour.
20. The AE cross-check alert threshold (for example a gap above 0.5% or 5 events per app-day), and the alerting on
    DLQ depth and consumer backlog.
21. Use the D1 read-replica Sessions API (beta) for reports, or only bounded queries against the primary?
23. `/v1/owner-actions` called directly by a partner is recorded in usage, and both watchers email about it, but
    `audit_log` sees only console actions. Should the API also emit an owner-action event that the console mirrors
    into the audit log?

**Data and governance**

22. Confirm the role set `owner|admin|developer|viewer` and the matrix, especially what developers may do. A SQLite
    CHECK change needs a table rebuild.
24. Keep coarse network data (country, ASN, IP prefix) on console sessions for 90 days, or store nothing?
25. Tamper evidence for `audit_log` beyond the triggers: a hash chain anchored outside Cloudflare (a daily signed head
    emailed to security, or R2 with a retention lock), or accept D1 plus the Cloudflare account as the trust root.
34. Is the Cloudflare rate-limiting binding available on the account for the console's `/api/auth/*` limits?
    Otherwise, use a D1 counter or a `ConsoleRpc` hit on the API's `RateLimiter`.
35. The exact billing-grade reconciliation: compare the ledger's relayed count per day with the relayer pool's
    on-chain transaction count (exact), in addition to the AE alert?
37. Confirm the reconciliation choices in §"Reconciling the decision records", especially #4 (step-up layout and the
    two iat windows), #7 (two writers on `USAGE_DB`, with the API's retention writes), #12 (the `no_session` waiver,
    narrowed for staff) and #20 (no step-up for removal and suspension, with the API breaker).

**Changed by the 2026-10-27 review (confirm)**

38. **Console audiences move from `global` to a Hana sink scope** (§Address impact). As written, a compromised console
    could derive the `global` wallet key of everyone who signs in to the console. Confirm the sink, and its rollout on
    sandbox-dev before the address freeze.
39. **Second-owner approval is deferred** (§Out of scope). It had no pilot user, and its tenure rule was checked only
    by the console. Confirm, or ship it with the API-side tenure check described there.
40. **An origin add's clock also waits for the admin Worker's notice** to security and the org's security contacts
    (stored in the hot DB, settable only by Hana). Without it, a compromised console could start the clock without
    telling anyone but the alias. Confirm the contacts model: who is listed by default, and whether a partner can ask
    for changes only through Hana.
41. The destructive-call breaker thresholds: 5 per org per hour and 20 globally, as drafted. Should origin removals
    count per origin rather than per call?
42. Should Hana be able to restore origins that a compromised console removed (immediately, with both notices), or
    is re-adding them through the delay acceptable?
43. The per-scope owner-action cap (20 per day) and the safety budget (10 per scope per day, 100 globally): are they
    right for partners with several apps on one scope?
44. Settlement calls `tx` at FINAL once per relayed transaction. At pilot volume that is fine. At scale, should it
    sample, or batch through an archival provider?

**Closed by this spec** (raised in a record, answered by another):

- Origin-change-safety's "should step-up need a passkey before GA?": yes, a passkey is mandatory (dashboard-auth).
- Data-model's "fresh sign-in window and `prompt=login`": per-action step-up instead, with console iat ≤ 120 s.
- Architecture's and data-model's "origin delay value": 24 h in production, never 0, with the waivers above.
- Open question 7's "should origin-change notices also come from outside the console?": yes, from the admin Worker,
  failing closed.
