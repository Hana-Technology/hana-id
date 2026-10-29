# `@hana-id/watchdog`

The independent watchdog for `hana-signer`'s issuer keys and governance (`docs/governance-spec.md` "Watchdog
service", `docs/decisions.md` D33, D82–D86). A Cloudflare Worker on **its own Cloudflare account** (separate login and
MFA from the API's, D86), its own NEAR account and key, its own D1, its own Resend key, Slack webhook and paging-app
credentials. It reads the chain through its own RPC (manifest `rpc`, then `rpcFallback`), never through the API.

Not deployed anywhere yet. Testnet only: it checks the RPC's `chain_id` against the manifest's `network` every run and
sends nothing on a mismatch.

## What a run does (every 5 min)

`src/run.ts`, in order:

1. **Config**: is `WATCHDOG_KEY` usable, is each channel (paging app, Slack, email) and the heartbeat configured.
2. **Chain** (`src/near.ts`): `status` (`chain_id`), `get_key_changes`, `get_issuer("google")`,
   `get_issuer_keys("google")`, `get_config`, `get_governance`, and the owner account (`get_config().owner`):
   `view_account` (code hash) and, when it runs a contract, the DAO's `get_policy` (null for a contract without one),
   at final finality.
3. **Google's JWKS**, fetched directly with no cache; every kid's first-seen time and key material go to D1
   (`seen_kids`). RS256 keys only (`usableJwks`, shared with the API in `packages/jwks`).
4. **Pending additions**: a kid in the JWKS with equal `n`, `e` (leading zeros stripped) → `confirm_issuer_key_change`
   (once this watchdog's `confirm_from_ms` has passed). A kid with other key material, or absent from two fetches at
   least 60 s apart (the run re-fetches after 60 s; or the absence recorded by an earlier run counts) →
   `cancel_issuer_key_change`, then `delete_updater_key` for every updater key when the signer account (the updater)
   proposed it, then one critical alert with the results.
5. **Pending removals**: kid absent from two fetches → confirm. Kid still published → critical alert, nothing called.
6. **Active keys**: a kid this watchdog never saw in Google's JWKS, or whose on-chain material (`get_issuer_keys`)
   differs from Google's → `pause` + critical alert. **The only automatic pause.** A kid Google published and later
   dropped is the normal rotation tail: a warning after 3 h. On the **first run** (empty D1) the current JWKS is
   recorded as known and any active kid not in it raises a critical alert, without pausing; such kids are kept as
   `baseline` so later runs never pause on that history. (An active kid that Google *does* publish but with other
   material is alerted at the first run and paused at the next one unless the owner removes it: that is a present
   forgery, not history.)
7. **Governance diff** against the last run (alert only): any upgrade proposal or execution, owner or pending owner,
   withdrawal, watchdog, updater-key, delay or console-audience change, pause and unpause (`unpaused_at_ms` also
   catches both between two runs), a raised session floor (`sessions_valid_from_ms`), the owner DAO's code or policy
   (`owner_code_hash`, `owner_policy`: a `ChangePolicy`, `AddMember` or `RemoveMember` reshapes the council without
   touching hana-signer), and `mpc`, `ckd_domain_id`, `state_version` → critical; shared clients, sponsors, public registration → warning; a scheduled
   delay decrease or audience addition coming into force as scheduled → info. Its own pause and updater-key deletions
   are not alerted twice. At the first run anything already pending is alerted.
8. Key changes executable for more than 1 h that nobody executed → warning. Changes that left the queue without
   this watchdog (executed after the delay, cancelled by the owner) → info.
9. **Alerts out** (`src/alerts.ts`), the daily digest (`src/digest.ts`), the **dead-man's switch** ping, and the run
   record (`runs`, each check's outcome).

Everything not listed in steps 4–6 is alert-only (D82). Actions use exactly four methods, the permission of the
watchdog's function-call key: `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key`.
Other providers' pending changes get a critical alert and no action (no JWKS URL known for them).

A run holds a D1 lock (`meta.run_lock`, taken over after 10 min), so an overlapping cron tick skips instead of
racing; a cancel or delete that fails because the target is already gone isn't counted as a failed protection. A run
that fails outside the chain and JWKS reads (e.g. D1 down) still delivers what it raised, records `error`, and skips
the heartbeat so the dead-man's switch pages.

## Alerts (D85)

| Severity | Channels | Re-send |
|---|---|---|
| critical | paging app (ntfy, Pushover or PagerDuty, manifest `watchdog.pager`) + Slack + email to `watchdog.alertEmails` | every 15 min until acknowledged (status endpoint ack, or a Pushover acknowledgement) |
| warning | Slack + email | no |
| info | status endpoint + daily digest email (after `watchdog.digestHourUtc`, UTC) | no |

Every alert kind with its severity is in `src/checks.ts` `ALERT_KINDS`. A condition alert (e.g. `rpc_failing`) is
raised once while its condition lasts and resolved when a run no longer sees it; an event alert (e.g. a cancelled
forgery) once ever. A first delivery is retried on each run until every channel accepted it, **also after an
acknowledgement**: an ack stops only the re-sends, never the first alert. A failing channel never blocks the others.
Provider adapters are in `src/channels.ts` behind `Sender` / `Pager` / `Email` / `Heartbeat` interfaces; tests use
doubles and stubbed `fetch`, never a real send. Pushover pages use emergency priority (Pushover repeats every 5 min
for 15 min, then the watchdog re-pages); PagerDuty re-sends fold into one incident (same dedup key) and are
acknowledged in PagerDuty; ntfy has no acknowledgement.

The dead-man's switch is a third-party heartbeat check (e.g. healthchecks.io, Better Stack, Cronitor) that pages on
its own when pings stop: configure it for a 5-min period with a grace of ~10 min, alerting both founders.

## Status endpoint: the hand-off to batch C's admin portal (D83)

The portal ("Security & monitoring", `docs/batch-c-spec.md`) reads this Worker with `WATCHDOG_STATUS_TOKEN` (the
admin Worker holds the other copy) and the chain itself (`docs/contract-interface.md` "Monitoring hand-off"). Every
request needs `Authorization: Bearer <WATCHDOG_STATUS_TOKEN>`; without a configured token (≥ 32 characters) every
route answers 503. Responses are JSON, `cache-control: no-store`.

| Route | Returns |
|---|---|
| `GET /status` | `env`, `network`, `signer`, `watchdog_account`, `now`, `run_interval_ms` (300000), `resend_ms`, `initialized_at`, `last_run` (`{id, started_at, finished_at, outcome, first_run, checks: [{id, outcome, detail?}]}`), `silent` (no finished run within two intervals: the portal's warning banner), `heartbeat` (`{configured, last_ping_at, last_ok_at, ok, failures}`), `channels` (configured or not, pager provider), `seen_kids` (`{provider, kid, n, e, source, first_seen_at, last_seen_at}`), `actions` (last 50), `open_alerts` (unacknowledged critical and open conditions), `checks` and `alert_kinds` (the registry) |
| `GET /alerts?cursor=<id>&limit=<1..200>&severity=<critical\|warning\|info>` | `{alerts: [{id, kind, severity, title, details, created_at, resolved_at, acked_at, acked_by, acked_via, last_sent_at, send_count, pending_channels, channels, resends_until_ack, deliveries: [{channel, kind, at, ok, error}]}], next_cursor}`, newest first |
| `GET /actions?cursor=<id>&limit=<1..200>` | `{actions: [{id, run_id, at, method, args, reason, ok, tx_hash, error}], next_cursor}`, newest first (`tx_hash` for transaction links) |
| `POST /alerts/:id/ack` `{"by": "<who>"}` | Records the acknowledgement once (`acked_via: "portal"`, `acked_by` 1–200 characters: the Access identity), `200 {alert}`; `409` if already acknowledged (the first ack is kept); `404`, `400`, `413`, `415` |

Nothing else is writable: the endpoint can't change a check, stop a first delivery or call the chain. The portal's
registry test imports `CHECK_IDS` and `ALERT_KINDS` from `src/checks.ts` and fails when one has no rendering (D83's
standing rule).

## Configuration

Manifest block (`envs/<env>.json`, schema `packages/env/src/schema.ts`, optional):

```json
"watchdog": {
  "account": "hana-id-watchdog-dev1.testnet",
  "cloudflare": { "accountId": "<32 hex: the watchdog's own Cloudflare account>", "workerName": "hana-id-watchdog-sandbox-dev", "d1Name": "hana-id-watchdog-sandbox-dev" },
  "alertEmails": ["founder-a@…", "founder-b@…"],
  "alertFrom": "alerts@<sending subdomain>",
  "pager": "ntfy",
  "digestHourUtc": 0
}
```

Worker secrets, all in `.secrets/<env>/watchdog-secrets.json` (0600, a flat `{NAME: value}` object):

| Secret | What |
|---|---|
| `WATCHDOG_KEY` | ed25519 function-call key on `watchdog.account`, receiver `signer`, the four methods, 1 NEAR allowance |
| `WATCHDOG_STATUS_TOKEN` | bearer token of the status endpoint (the admin Worker's copy comes from the same file) |
| `RESEND_API_KEY` | the watchdog's own Resend key (D87) |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook |
| `NTFY_TOPIC_URL` (+ optional `NTFY_TOKEN`) / `PUSHOVER_TOKEN` + `PUSHOVER_USER` / `PAGERDUTY_ROUTING_KEY` | the paging app's credentials |
| `HEARTBEAT_URL` | the dead-man's switch ping URL |

## Commands

```sh
corepack pnpm --filter @hana-id/watchdog secrets <env> init     # creates WATCHDOG_KEY + WATCHDOG_STATUS_TOKEN, prints the public key and the add-key command
corepack pnpm --filter @hana-id/watchdog secrets <env> check    # names of the secrets set and missing (never values)
corepack pnpm --filter @hana-id/watchdog gen <env> [--d1-id <uuid>] [--dev-vars]   # writes wrangler.jsonc (gitignored)
corepack pnpm --filter @hana-id/watchdog dev                    # wrangler dev --test-scheduled (GET /__scheduled runs the cron)
corepack pnpm --filter @hana-id/watchdog test
```

Setup and deploy steps are in `docs/operations.md` "Watchdog service".

## Tests

`test/` runs in workerd with a real (local) D1: `run.test.ts` covers every rule above against a stub chain, a scripted
JWKS and recording channels; `alerts.test.ts` routing, re-sends, acks and failing channels; `channels.test.ts` each
adapter's request; `status.test.ts` the endpoints; `near.test.ts` the RPC client (fallback) and the signed
transactions; `worker.test.ts` the cron handler end to end with the real wiring behind one stubbed `fetch`, and that
no secret value appears in any log line or stored row. `scripts/test/` covers the config generator and the secrets
file.
