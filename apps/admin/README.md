# @hana-id/admin

The Hana staff console (`hana-id-admin-<env>`, `docs/batch-c-spec.md` "Hana admin console"): a Cloudflare Worker on
`admin.origin` behind Cloudflare Access, serving a plain-JavaScript SPA (`public/`) and its `/api/*` backend. Every
`/api/*` request needs a valid Access JWT of an email on `admin.staffEmails` (checked in the Worker too, D88), then the
CSRF checks. It holds no D1 and no NEAR key: it calls the API's `AdminRpc` (`API`), the console's `StaffRpc`
(`CONSOLE`) and, for the Users screen, the email issuer's `DirectoryRpc` (`ISSUER`, C8b); it keeps its own state in the
usage ledger's `ops` schema (`USAGE_DB`, Hyperdrive, role `usage_admin`) and sends every email through SendGrid
(`@hana-id/sendgrid`, its own Mail-Send-only key `EMAIL_API_KEY`, D401).
**Not deployed** (milestone M4).

Reference: routes and crons in `docs/api.md` "Admin Worker"; setup, the crons' call budget, the Users screen's deploy
order and the runbooks in `docs/operations.md` "Admin Worker"; invariants in `docs/security.md` "Admin Worker";
decisions D278–D285 (C8), D320–D329 (C12), D330–D338 (C14), D360–D369 (C13), D380 (the call budget), D388–D392 (C8b).

## Screens

Organisations (members, invites, owner grants, apps, changes, keys), Users (C8b), Support ID lookup (C15), Audit (the
console's rows, an org's app changes, the issuer's directory reads), Feed and notices, Security & monitoring, Pending
upgrades, Playbooks (C14), Reports, Statements, Rates (C12), Retention (C13).

**Users (C8b; D275 as confirmed 2026-11-05).** Search the email issuer's user directory by address (a full address
exactly, else ≥ 3 characters of one), account kind, app, sub or "unverified only" (`POST /api/users/search`; a support
reference optional), or the wallet directory by wallet address, User ID or internal id (`POST /api/users/find`); a
Support ID goes to the Support ID lookup. Opening a user needs a support reference (`POST /api/users/get`): the directory row and its apps,
the wallet directory's users holding the identity (User ID, Support ID, internal id, wallets), and each scope's
on-chain path read live (`get_identity`, `get_account`). The issuer verifies the staff JWT itself, audits every read
and caps each staff member at 500 identities an hour and 2 000 a day; past that the read is refused and the security
alias is emailed. No export.

**Support ID lookup (C15; D394–D396, D399).** A Support ID, User ID or internal id, a support reference (required),
optional request IDs (≤ 20) and a window (1–731 days, 30 by default) → `POST /api/support/lookup`: every user the code
names (a collision lists each, `truncated` past 10), their ids, identities with each one's address from the issuer's
directory (read as `support_lookup` under the same ticket; unverified Google claims marked), wallets, the scope's apps,
the vault shares not yet expired, the apps' changes, the ok ledger events, and the request IDs' events with their
errors; "ledger unavailable" with its reason when the ledger can't be read. Reached from the nav, from the Users search
(a Support ID, run at once with a support reference) and from any wallet-directory user's block (by User ID). Audited
first in the console's audit log (`support.lookup`). The query and the answer stay in memory: no URL, no storage, no
export.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | host dispatch, the Access check, CSRF, the headers, the two crons |
| `src/access.ts`, `src/csrf.ts`, `src/headers.ts`, `src/http.ts` | the staff check (`@hana-id/oidc`), CSRF, CSP and headers, error codes and body limits |
| `src/routes.ts` | the staff BFF route table (the audit view's three sources) |
| `src/users.ts` | the Users screen (C8b): search, find, the joined detail, the `directory_budget` email |
| `src/support.ts` | the Support ID lookup (C15): the audit row, `AdminRpc.supportLookup`, the ledger part, the email join (D399) |
| `src/near.ts` | read-only NEAR views: `get_scope`, `tx`, `view_access_key`, `get_identity`, `get_account` |
| `src/notices.ts`, `src/feed.ts`, `src/watcher.ts`, `src/cron.ts`, `src/mail.ts` | the 5-minute cron's jobs and the call budget (D380) |
| `src/ledger*.ts`, `src/settlement.ts`, `src/statement*.ts`, `src/rates.ts`, `src/report-routes.ts`, `src/alerts.ts` | C12's ledger work and routes |
| `src/monitoring*.ts`, `src/watchdog.ts`, `src/playbooks.ts`, `src/plain.ts` | C14's Security & monitoring |
| `src/retention*.ts` | C13's monthly job and screen |
| `src/email/` | the `EmailSender` (SendGrid, `sendgridSender`) and every message; `src/mail.ts` `sendToAll` skips a message this isolate saw accepted (SendGrid has no idempotency key, D401) |
| `public/` | the SPA (no build, text only: a source check forbids HTML sinks) |
| `scripts/gen-wrangler.ts` | `wrangler.jsonc` from the manifest's dashboard blocks (`ISSUER` when the env has an email issuer) |

## Commands

```sh
corepack pnpm --filter @hana-id/admin test        # Worker tests over the real API, console and email issuer Workers, the config and source checks, the ops store on PGlite, the SPA in happy-dom
corepack pnpm --filter @hana-id/admin typecheck
corepack pnpm --filter @hana-id/admin gen <env> [--admin-hyperdrive-id <id>|off]
corepack pnpm --dir apps/admin exec wrangler deploy   # after the API, the console and (for Users) the email issuer
```

The Worker tests reach no network: the Access certs, SendGrid, NEAR and the watchdog are stubbed in the test isolate,
and the email issuer (an auxiliary Worker, so `DirectoryRpc` runs for real) gets the suite's Access certs from a fake
team (`test/fake-access.js`). The SPA's tests (`test-spa/`, `vitest.spa.config.ts`) run `public/app.js` as the browser
does, in a fresh happy-dom window per test with the API answered at `fetch`: the Support ID lookup screen and the Users
screen's ways into it.

Last verified: 2026-11-05 (branch `feat/sandbox-dev-dashboard-blocks`: email through SendGrid, D401); 2026-11-05 (branch `feat/batch-c-15-screen`: the Support ID lookup screen, `src/support.ts`'s email join,
the SPA tests, D399); 2026-11-05 (branch `feat/batch-c-8b`: written with the Users screen, D388–D392).
