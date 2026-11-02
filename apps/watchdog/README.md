# `@hana-id/watchdog`

The independent watchdog for `hana-signer`'s issuer keys and governance (`docs/governance-spec.md` "Watchdog
service", `docs/decisions.md` D33, D82–D86; the email issuer's rules: `docs/email-login-spec.md` "Watchdog",
D190–D193). A Cloudflare Worker on **its own Cloudflare account** (separate login and
MFA from the API's, D86), its own NEAR account and key, its own D1, its own Resend key, Slack webhook and paging-app
credentials. It reads the chain through its own RPC (manifest `rpc`, then `rpcFallback`), never through the API.

Deployed on sandbox-dev (2026-10-30, on the API's Cloudflare account for the drills only, D125; `docs/operations.md`
"Watchdog service"); no other env yet. Testnet only: it checks the RPC's `chain_id` against the manifest's `network`
every run and sends nothing on a mismatch.

## What a run does (every 5 min)

`src/run.ts`, in order:

1. **Config**: is `WATCHDOG_KEY` usable, is each channel (paging app, Slack, email) and the heartbeat configured.
2. **Chain** (`src/near.ts`): `status` (`chain_id`), `get_key_changes`, `get_issuer` and `get_issuer_keys` for
   `google` and `email` (the email keys only when the email issuer exists), `get_self_issued("email")`, `get_config`,
   `get_governance`, and the owner account (`get_config().owner`): `view_account` (code hash) and, when it runs a
   contract, the DAO's `get_policy` (null for a contract without one), at final finality. A contract without
   `get_self_issued` (v2, sandbox-dev today) reads as "no email issuer is self-issued", never as an error; v2's
   `get_issuer("email")` answers null.
3. **Google's JWKS**, fetched directly with no cache; every kid's first-seen time and key material go to D1
   (`seen_kids`). RS256 keys only (`usableJwks`, shared with the API in `packages/jwks`).
4. **Pending additions**: a kid in the JWKS with equal `n`, `e` (leading zeros stripped) → `confirm_issuer_key_change`
   (once this watchdog's `confirm_from_ms` has passed). A kid with other key material, or absent from two fetches at
   least 60 s apart (the run re-fetches after 60 s; or the absence recorded by an earlier run counts) →
   `cancel_issuer_key_change`, then `delete_updater_key` for every updater key when the signer account (the updater)
   proposed it, then one critical alert with the results. Except (D153): an Add by the updater whose `n`/`e` equal what
   this watchdog fetched from Google within the last 24 h (`seen_kids`, not a baseline kid) is Google retiring the kid
   while the API cron still saw it: cancelled, the updater keys kept, one `retired_key_change` warning. A cancel that panics `No such key change` re-reads the
   chain: gone without effect (someone else cancelled it) is fine; **executed** (an Add's kid is now active) raises
   `protective_action_failed` and step 6 judges the re-read active set, so it pauses in the same run. The alert's
   title and `details.outcome` (`cancelled`, `gone`, `executed`, `unknown`, `failed`, `not_sent`) never claim a cancel
   that didn't happen.
5. **Pending removals**: kid absent from two fetches → confirm. Kid still published → critical alert, nothing called.
5a. **The email issuer** (`src/pins.ts`; judged against the manifest's pins, so it runs even when Google's JWKS
   can't be fetched). Pins: `watchdog.pinnedIssuerKeys.email` = `{required, signers: {<id>: [thumbprint, …]}}`, each
   key by its RFC 7638 JWK thumbprint (`rsaThumbprint`, `packages/jwks`), which is also the kid Hana's issuer gives
   it. **No pins = nothing pinned** (D190): every email key is unpinned.
   - Pending changes: by the updater (the signer account) → `updater_other_provider` as for any non-Google provider
     (cancel, delete every updater key). An Add whose key isn't pinned for its `signer`, whose kid isn't its
     thumbprint, or that names no signer → `cancel_issuer_key_change` + critical `forged_key_change` (`reason`
     `not_pinned`, `other_signer`, `kid_not_thumbprint`, `no_signer`; `bad_material` when its `n`/`e` can't be hashed,
     never judged by kid; `pins_unreadable` while `EMAIL_PINS` is malformed, which also pages `pins_invalid` from the
     `config` check). A pinned Add, and any email removal → info
     `self_issued_key_change`; **never confirmed** (self-issued keys wait `governance_delay_ms`; the contract refuses).
   - Active keys (`get_issuer_keys("email")`, signer from `get_self_issued`): one that isn't pinned (for the signer
     that lists it, kid = thumbprint) → `pause` + delete every updater key + critical `forged_active_key`
     (`forged_active_key:email:<kid>`), as for Google, **also at the first run** (pins are configuration, not history).
   - Signer policy (check `signer_policy`): `get_issuer("email")` and `get_self_issued("email")` (signers,
     `required`, `overlap_until_ms`) against the pins, one condition per chain policy state. **Weaker** (D191: a lower
     `required` than pinned, a signer the pins don't list, active email keys with no signer policy, an overlap with
     the previous policy longer than the contract's 10 min + 5 min) → `pause` + critical `signer_policy_mismatch`. An
     email issuer with nothing pinned, or a pre-v3 one → the same critical, no pause. What a planned change passes
     through, none of it weaker (a pinned signer not in the policy yet, the `set_issuer` → `mark_self_issued` gap, a
     higher `required` on chain, a normal overlap) → warning `signer_policy_transition`, no pause: pin a new signer's
     keys before its upgrade executes, raise the pinned `required` after.
   - `get_config().unrecorded_wallets` true on an env that isn't `local*` or `sandbox*` → critical condition
     `unrecorded_wallets` (D139, D193; alert only; check `links`).
6. **Active keys**: a kid this watchdog never saw in Google's JWKS, or whose on-chain material (`get_issuer_keys`)
   differs from Google's → `pause`, then `delete_updater_key` for every updater key (whoever proposed it: the change
   record is gone by then, and only the updater or the owner can post keys; D126), + critical alert. **The only
   automatic pause.** An updater key re-added while such a key is still active is deleted again at the next run. A kid Google published and later
   dropped is the normal rotation tail: a warning after 3 h. On the **first run** (empty D1) the current JWKS is
   recorded as known and any active kid not in it raises a critical alert, without pausing; such kids are kept as
   `baseline` so later runs never pause on that history. (An active kid that Google *does* publish but with other
   material is alerted at the first run and paused at the next one unless the owner removes it: that is a present
   forgery, not history.)
7. **Governance diff** against the last run (alert only): any upgrade proposal or execution, owner or pending owner,
   withdrawal, watchdog, updater-key, delay or console-audience change, pause and unpause (`unpaused_at_ms` also
   catches both between two runs), a raised session floor (`sessions_valid_from_ms`), the owner DAO's code or policy
   (`owner_code_hash`, `owner_policy`: a `ChangePolicy`, `AddMember` or `RemoveMember` reshapes the council without
   touching hana-signer), the owner's immediate issuer actions, which leave no pending state (`issuer`: `set_issuer`
   changed Google's iss values; `issuer_keys`: an active kid gone without a pending removal of it leaving the queue,
   i.e. `remove_issuer_key`; the snapshot keeps `get_issuer("google")` for this), and `mpc`, `ckd_domain_id`,
   `state_version` → critical; shared clients, sponsors, public registration → warning; a scheduled
   delay decrease or audience addition coming into force as scheduled → info. Its own pause and updater-key deletions
   are not alerted twice. At the first run anything already pending is alerted.
   The email issuer's immediate owner actions are diffed the same way: `email_issuer` (`set_issuer("email")`),
   `email_issuer_keys` (an active email kid gone without a queued removal), `email_signer_policy` (`mark_self_issued`,
   or an upgrade's `migrate` changing signers or `required`), and `unrecorded_wallets` (D193).
8. Key changes executable for more than 1 h that nobody executed → warning. Changes that left the queue without
   this watchdog (executed after the delay, cancelled by the owner) → info (Google's and the email issuer's tell
   executed from cancelled).
9. **Relayer funds** (`src/relayer.ts`, read-only, D150): `view_account` and `view_access_key_list` of the relayer
   account (`RELAYER_ACCOUNT`, the manifest's `relayer`) at final finality. Its available balance (`amount` minus
   `storage_usage` × 10^19 yocto) and the remaining allowance of each pool key (function-call keys for the signer,
   by methods: `derive_key` → session pool, `propose_change` → owner pool; other keys are listed, never judged; an
   unlimited allowance is bounded by the balance only) against the thresholds: balance below 5 NEAR → warning
   `relayer_balance_low`, below 1 NEAR (or no account) → critical `relayer_balance_critical`; a session-pool key below
   0.5 / 0.1 NEAR and an owner-pool key below 0.1 / 0.02 NEAR → `relayer_allowance_low` / `relayer_allowance_critical`
   (one alert per key); a pool with no key → critical `relayer_pool_empty`. Conditions: raised once, the warning
   replaced by the critical when it drops further, resolved by the first run after a refill or a replaced key. The
   watchdog never tops anything up (it holds no key on the relayer account). A failed read marks the check `error`
   and the run `degraded`, and resolves nothing. Thresholds: manifest `watchdog.relayerFunds` (below).
10. **Alerts out** (`src/alerts.ts`), the daily digest (`src/digest.ts`), the **dead-man's switch** ping, and the run
   record (`runs`, each check's outcome).
11. **Advisory checks** (warning only), after every protective step, the snapshot, the first delivery and the
   heartbeat, each guarded (a throw marks its check `error`, resolves nothing and leaves the run `degraded`, never
   `error`); what they raise goes out in a second delivery. Their reads are third-party (Hana's API is a party the
   watchdog must survive, D86), so they can't hold back a cancel, a pause, an alert or the heartbeat.
   - Hana's JWKS (check `email_jwks`, only with pins and a URL): `EMAIL_JWKS_URL` (manifest `jwksUrl`, default
     `{apiUrl}/v1/email/jwks.json`), fetched with no cache; a published key not pinned (or kid ≠ thumbprint) or an
     active email key not published → warning `email_jwks_mismatch`; 3 failed fetches while an email key is active →
     the same warning (`:fetch`). Never trusted, never acted on.
   - Link volume (`src/links.ts`, check `links`, D192): skipped in a run that took protective actions (subrequests).
     While an email issuer is on chain (links need one), the signer's transactions since the last scan are read from
     the transactions indexer (`LINK_INDEXER_URL`, manifest `watchdog.linkVolume.indexerUrl`: FastNear's `/status`,
     `/v0/account` at most 100 per run, `/v0/transactions` 20 at a time, 60 blocks behind its head, which is clamped
     to the RPC's final block) and every `EVENT_JSON` `identity_link_*` / `identity_linked` / `identity_unlinked`
     event the signer emitted in a receipt that succeeded goes to D1 `link_events` (scope, provider, auto, block
     time; 8 days; deduplicated by receipt and log; at most 2 000 per scan; receipt ids must be NEAR ids; events dated
     in the future are dropped). New links (`identity_linked`, `identity_link_proposed`) in the last hour above
     `perScopePerHour` (default 20) in a scope, or `perHour` (100) in all → warning `link_volume_high`. No indexer
     while email is on chain, 3 failed reads, a scan more than 1 h behind, or a full page that is all one block (the
     cursor then holds before that block, never skipping its rest: `:truncated`) → warning `link_events_unavailable`.
     The first scan after the email issuer appears starts at the chain's head (no backfill: no link can precede its
     first key). The indexer can hide or invent events (a missed or false warning), never make the watchdog act.

Every third-party body the watchdog parses is size-capped before parsing (`src/http.ts`: both JWKS 64 KB, an RPC
answer 4 MB, the indexer 16 KB / 512 KB / 2 MB), by `Content-Length` and while streaming: over the cap is a failed
fetch (an RPC answer then tries the fallback).

Everything not listed in steps 4–6 is alert-only (D82). Actions use exactly four methods, the permission of the
watchdog's function-call key: `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key`.
Other providers' pending changes the owner proposed (neither Google nor email) get a critical alert and no action (no JWKS URL or pins known for them).
One the updater (the signer account) proposed is cancelled like a forged Google key, and every updater key deleted:
the updater only serves Google, so such a proposal means its key is stolen. `delete_updater_key` goes only to keys in
`get_governance().updater_keys` (confirmed by the contract's `AddKey` callback; `pending_updater_keys` are never
touched, and the contract refuses them to a watchdog).

On-chain strings in alerts (kids, providers, proposers, public keys) are attacker-chosen (any 1–128 bytes for a kid).
`src/sanitize.ts`: titles and texts show an identifier as is only if it is `[A-Za-z0-9._:-]` and ≤ 80 characters,
else JSON-quoted with control and non-ASCII characters escaped (`\n`, `\u00e9`), cut to 80; every other value in a
text is escaped the same way, one line per field, and a `changes` list one line per change (`updater_keys: removed
ed25519:…; added ed25519:…`, `paused: false -> true`). Every subject is `SEVERITY: title [Hana ID <env>]`: severity
and title first, because a phone's lock screen shows only the first ~30 characters (sandbox-dev drill, 2026-10-30). Each channel then makes the whole message safe for its format: the
ntfy title header, the Pushover and PagerDuty titles and the email subject drop CR, LF and non-ASCII (a header fetch
can't refuse to page); Slack gets `&`, `<`, `>` as entities (no `<!channel>`, mention or link injection). The stored
alert details keep the exact on-chain value for the portal.

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

Every alert kind with its severity is in `src/checks.ts` `ALERT_KINDS`, and every kind has a recovery playbook in
`@hana-id/playbooks` (`packages/playbooks`, D126; rendered as `docs/playbooks.md` and in the admin portal):
`alertPlaybook(kind)` gives its id, each alert text ends with `Playbook: <id> (admin portal "Security & monitoring" >
Playbooks; docs/playbooks.md#<id>)`, and `test/registry.test.ts` fails when a kind has none, when a playbook names a
kind the watchdog doesn't raise, or when a playbook's severity isn't the highest of its kinds. A condition alert (e.g. `rpc_failing`) is
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
| `GET /status` | `env`, `network`, `signer`, `watchdog_account`, `now`, `run_interval_ms` (300000), `resend_ms`, `initialized_at`, `email` (`{pinned, jwks_url, last}`: the pins in force and, at the last run, `{at, pinned, chain: {issuer, pre_v3, self_issued, active_kids}, differences, weaker}`), `link_volume` (`{indexer, last}`: `{cursor, failures, at, latest_height, behind_ms, last_hour: {new_links, by_scope, by_event}, thresholds}`), `last_run` (`{id, started_at, finished_at, outcome, first_run, checks: [{id, outcome, detail?}]}`), `silent` (no finished run within two intervals: the portal's warning banner), `heartbeat` (`{configured, last_ping_at, last_ok_at, ok, failures}`), `channels` (configured or not, pager provider), `seen_kids` (`{provider, kid, n, e, source, first_seen_at, last_seen_at}`), `relayer_funds` (the last relayer reading or null: `{account, exists, amount, locked, storage_usage, available, keys: [{public_key, pool, allowance}], other_keys, at, thresholds: {balance, session, owner: {warn, critical}}}`, amounts in yoctoNEAR as decimal strings, `allowance` null = unlimited), `actions` (last 50), `open_alerts` (unacknowledged critical and open conditions), `checks` and `alert_kinds` (the registry: per kind `{severity, check, description, playbook}`, `playbook` = the id of its `@hana-id/playbooks` playbook, the portal's link target) |
| `GET /alerts?cursor=<id>&limit=<1..200>&severity=<critical\|warning\|info>` | `{alerts: [{id, kind, severity, title, details, created_at, resolved_at, acked_at, acked_by, acked_via, last_sent_at, send_count, pending_channels, channels, resends_until_ack, deliveries: [{channel, kind, at, ok, error}]}], next_cursor}`, newest first |
| `GET /actions?cursor=<id>&limit=<1..200>` | `{actions: [{id, run_id, at, method, args, reason, ok, tx_hash, error}], next_cursor}`, newest first (`tx_hash` for transaction links) |
| `POST /alerts/:id/ack` `{"by": "<who>"}` | Records the acknowledgement once (`acked_via: "portal"`, `acked_by` 1–200 characters: the Access identity), `200 {alert}`; `409` if already acknowledged (the first ack is kept); `404`, `400`, `413`, `415` |

Nothing else is writable: the endpoint can't change a check, stop a first delivery or call the chain. The portal's
registry test (batch C, not built yet) imports `CHECK_IDS` and `ALERT_KINDS` from `src/checks.ts` and fails when one
has no rendering (D83's standing rule); the portal links each alert to its playbook by the kind's `playbook` id.

## Configuration

Manifest block (`envs/<env>.json`, schema `packages/env/src/schema.ts`, optional):

```json
"watchdog": {
  "account": "hana-id-watchdog-dev1.testnet",
  "cloudflare": { "accountId": "<32 hex: the watchdog's own Cloudflare account>", "workerName": "hana-id-watchdog-sandbox-dev", "d1Name": "hana-id-watchdog-sandbox-dev" },
  "alertEmails": ["founder-a@…", "founder-b@…"],
  "alertFrom": "alerts@<sending subdomain>",
  "pager": "ntfy",
  "digestHourUtc": 0,
  "relayerFunds": { "balance": { "warn": 5, "critical": 1 }, "sessionAllowance": { "warn": 0.5, "critical": 0.1 }, "ownerAllowance": { "warn": 0.1, "critical": 0.02 } },
  "pinnedIssuerKeys": { "email": { "required": 1, "signers": { "hana": ["<primary thumbprint>", "<standby thumbprint>"] } } },
  "linkVolume": { "indexerUrl": "https://tx.test.fastnear.com", "perScopePerHour": 20, "perHour": 100 }
}
```

`pinnedIssuerKeys.email` (optional, D190): `gen` passes `{required, signers}` as `EMAIL_PINS` (JSON) and the JWKS URL
(`jwksUrl`, else `{apiUrl}/v1/email/jwks.json`) as `EMAIL_JWKS_URL`. Absent (sandbox-dev until batch 4 creates the
key): nothing is pinned, so it must be set, generated and deployed before the owner posts the first email key; an
unreadable `EMAIL_PINS` is read as nothing pinned and named in the `config` check. `linkVolume` (optional, D192): `gen`
passes `LINK_INDEXER_URL` and any threshold override as `LINK_VOLUME`; absent, the link check is skipped (a warning
once an email issuer is on chain). Both need migration `0002_link_events.sql` applied before the deploy.

`relayerFunds` is optional, and so is each pair (NEAR, `critical` below `warn`): the values above are the defaults
(`src/relayer.ts` `DEFAULT_RELAYER_FUNDS`). Raise the allowance pairs when `deploy-contract` ran with a larger
`--relayer-allowance` / `--owner-relayer-allowance`. `gen` passes the manifest's `relayer` as `RELAYER_ACCOUNT` and an
override as `RELAYER_FUNDS` (JSON); a Worker without `RELAYER_ACCOUNT` (generated before this check) skips it, and an
unreadable `RELAYER_FUNDS` pair falls back to its default and is named in the `config` check's detail.

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
corepack pnpm --filter @hana-id/watchdog pin <public key file>   # the pin (RFC 7638 thumbprint) of a JWK, JWKS or PEM public key; refuses private keys
corepack pnpm --filter @hana-id/watchdog gen <env> [--d1-id <uuid>] [--dev-vars]   # writes wrangler.jsonc (gitignored)
corepack pnpm --filter @hana-id/watchdog dev                    # wrangler dev --test-scheduled (GET /__scheduled runs the cron)
corepack pnpm --filter @hana-id/watchdog test
```

Setup and deploy steps are in `docs/operations.md` "Watchdog service".

## Tests

`test/` runs in workerd with a real (local) D1: `run.test.ts` covers every rule above against a stub chain, a scripted
JWKS and recording channels; `email.test.ts` the email issuer's rules (pinned and unpinned keys per signer, no
confirm, the signer-policy diff and its pauses, Hana's JWKS, link volume, `unrecorded_wallets`, a v2 contract read as
no email issuer, D153 unchanged beside it, the review hardening: advisory order, guarded link check, `pins_invalid`,
`bad_material`); `http.test.ts` the body caps on every third-party read; `scripts/test/pin.test.ts` the pin command
(RFC 7638 vector, leading zeros, PEM, private keys refused); `links.test.ts` the indexer source (request shapes, failed receipts and
other executors ignored, a full page) and the pin parsing; `alerts.test.ts` routing, re-sends, acks and failing channels; `channels.test.ts` each
adapter's request; `registry.test.ts` that every alert kind has exactly one playbook (and its line in the alert text);
`sanitize.test.ts` hostile kids (line breaks, `<!channel>`, 128 bytes, non-ASCII) through every
channel and a full run; `status.test.ts` the endpoints; `relayer.test.ts` the relayer funds check (thresholds, escalation, resolution, a missing account or pool, a failed read, escaped key strings); `near.test.ts` the RPC client (fallback, the relayer reads) and the signed
transactions; `worker.test.ts` the cron handler end to end with the real wiring behind one stubbed `fetch`, and that
no secret value appears in any log line or stored row. `scripts/test/` covers the config generator and the secrets
file; `relayer-pools.test.ts` that the pool classification matches the API's allowlists.
