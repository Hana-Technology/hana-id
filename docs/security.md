# Security model

Who is trusted for what, every key and secret, the invariants and where each is enforced, auto-approve rules, and
known open issues. Last verified against code: 2026-11-04 for the console Worker (branch `feat/batch-c-7-merge`, C7 merged onto `develop`; written on `feat/batch-c-7` 2026-11-02: its
invariants, the invite, owner-grant and session token rows, D240–D244; re-checked against `develop`'s D269–D274, which the console's C7 surface doesn't touch: it relays no Google token until C9); 2026-11-04 for `'token_first'` in force (branch
`feat/token-first-on`: the spike passed, "Google's verified email" now describes token_first first and
second_request as the fallback, D270); 2026-11-04 for the user directory's review fixes (branch
`fix/user-emails-review`: order-safe writes, unverified Google rows apart in the CLI, the CLI's statement off the
argv, google-record after `/v1/login`, the record-only login without tokeninfo, the accepted forged rows and
tokeninfo's answer in the popup, D269); 2026-11-04 for Google's email under `'token_first'` (built, off: the
on-chain token stays openid-only under every flow, the callback's claim allow-list and tokeninfo, `google-record`;
branch `feat/google-token-first`, D270, D273); 2026-11-04 for the claim allow-list on every route that relays a Google token (branch `fix/sessions-allow-list`: `/v1/sessions`, `/v1/owner-actions`, no flag, D271, D274); 2026-11-04 for the user directory (branch `feat/user-emails`: the issuer
keeps each verified address for Hana staff, what a reader of its D1 learns, the CLI's wrangler settings, D269);
2026-11-04 for the e2e coverage of the claim allow-list and of a linked member's export on both RPC providers (branch `test/e2e-pii-linked-export`); 2026-11-04 for the export window's Show key toggle, Copy key and clipboard clear (branch `feat/export-copy`, D268); 2026-11-03 for the batch 8b re-review fixes (branch `fix/8b-rereview`:
the pin read's 1 s timeout, failing closed, and the pins' privacy note, D263); 2026-11-03 for the batch 8b review fixes (branch `feat/email-login-8b`:
member paths confirmed on two RPC providers and root pins, D263; the email permission's screens, D264; the access token
never revoked, D265; the issuer's word on the match, D266; relay and google-match limits, D267); 2026-11-03 for
automatic linking (branch `feat/email-login-8b`: the path
through `get_identity`, "Automatic linking in the vault and the popup" (D133, D137, D139 in the vault, the follow-up
channel, Google's email off chain), email export, D248 lifted, D254–D259); 2026-11-03 for the vault's `connected` event
and the SDK's frame retry (branch `fix/demo-polish`, "Browser": no answer before the hello's checks pass, D262);
2026-11-02 for email login in the web (branch `feat/email-login-8a`:
"Email login in the popup and the vault" under "Browser", `/login/email`'s CSP, the device ticket on `authOrigin`,
D245–D249); 2026-11-02 for email login's API part (branch `feat/email-login-6`: the
email-token, proof-of-possession, link-precheck and link-relay invariants under "API", the issuer reached without the
API and its `app_keys` lookup, the share-revocation residual, D230–D234); 2026-11-02 for usage capture (branch `feat/batch-c-4`: the ledger's
writer credential and `USER_ID_KEY` in the inventory and the compromise table, "Usage capture fails open" in the API
invariants, the waiver's session marker, the secret-scan rules for the new files; D220–D224); 2026-11-02 for the RPC budgets (branch `fix/c5-budgets`: the per-org
share of the global reserve, empty kill switches charged to their org, the link cancel's read budget); 2026-11-02 for
batch C's RPC writers (branch `feat/batch-c-5`:
`ConsoleRpc` / `AdminRpc` in "Invariants", the breaker and hot-DB budget, the waivers at the notice ack, drift
detection now built (and what it doesn't cover), the legacy `apps.publishable_key` kept on a valid key, the review
fixes to admission, D225–D229); 2026-11-02 for the watchdog's identity JWKS pin check, the outside probe and the
"identity key on chain" check (branch `feat/identity-token-8`, D210–D214: the compromise rows, the identity
invariants, the watchdog paragraph and open issue (l)); 2026-11-02 for the email issuer (branch `feat/email-login-4`: its keys and secrets rows and "Email issuer"
invariants, D195–D199, with the review fixes and the abuse re-check: K_sup, K_device, per-address device tickets with
revocation, the owner pool, mailed unlock/unsuppress, the growing domain cap, encrypted challenge addresses, the 0.92%
bound); for the identity token's AWS KMS signer (branch
`feat/identity-token-7`, D215–D219: its compromise row, the AWS access key in the inventory, the signer invariants and
open issue (l)); 2026-11-02 for what runs on sandbox-dev (branch `docs/consistency-pass`:
open issue (e) and its watchdog notes, the Q22 note, OPER-3, against `develop` @ 1c6a124 and `docs/operations.md`);
2026-11-02 for the hot DB after migration 0006 (branch
`feat/batch-c-3`: the gate on `app_keys` and `scopes`, origins in force by `active_from`, staff-proposed guarded
changes and their announcement, the `app_changes` ledger, open issue (i) fixed for the CLI); 2026-11-02 for the token
check's move to `packages/oidc` and its optional claims (branch `feat/batch-c-2`, D201, in "Verify before relay"),
for the hourly link counter (branch `feat/link-cap`, D200, in the email-login invariants) and the watchdog's email issuer rules, the link alarms
and the `unrecorded_wallets` alert (branch `feat/email-login-5`, D190–D193, D200); 2026-10-30 for the watchdog's retired-key rule (branch
`fix/watchdog-retired-key-race`, D153), for the partner identity token (branch
`feat/identity-token-2`: the review fixes D176–D179 in the identity rows, invariants and open issue (l); branch
`feat/identity-token-1`: the partner-backend party, its compromise rows, the three identity secrets), for the relayer pool rows (branch `feat/playbook-gaps`: the watchdog's relayer funds
monitoring, D150) and for the `KEYS_UPDATER_KEY` and owner rows and open issue
(e) (governance deployed on sandbox-dev, D126); otherwise 2026-10-29 (branch `perf/login-latency-impl`; the login popup, the
background persist and the vault gate were re-checked, the rest as of 2026-10-28, commit 58edee9; the approval popup
opened by the partner page, branch `feat/approve-in-click`, D99; the API rate limits, owner-action caps, CKD key pin,
secret scan and admin CLI after the 2026-10-29 security sweep, D100; the browser, core and SDK sweep fixes, D110–D118; the contract v3 email-login invariants, 2026-10-30, branches `feat/email-login-1` and `-r2`, D130–D139).

Component map and flows: `docs/architecture.md`. On-chain layouts and the contract's own security notes:
`docs/contract-interface.md` ("Security notes (for reviewers)"). Browser parts (vault, auth pages, partner client)
are in `packages/web`.

## Trust roots in one paragraph

A user's key is `CKD(MPC, signer account, path)` followed by derivation v1 in the browser. Whoever can make
`hana-signer` call the MPC for a path, with an app key they hold, gets that user's key. The contract does that only
for a session opened by a Google ID token whose `sub` is the user's and whose nonce commits to the caller's session
key. So the roots are: the **MPC network** (threshold), **Google** (signs tokens), **whoever controls the signer
contract** (its code, its issuer keys), and **the code the user's browser runs** on `vaultOrigin`/`authOrigin` (Hana
serves it). Hana's API never receives S, PRK, a chain key or the session private key in any designed flow; the MPC
answer is encrypted to the browser's ephemeral BLS key `a`.

## Parties

| Party | Trusted for | Can | Cannot |
|---|---|---|---|
| NEAR MPC network (17 nodes, threshold 11, TEEs) | Holding the CKD master secret; answering only `hana-signer`'s requests for the requested `app_id` | ≥ 11 colluding nodes (or a TEE break of that many): compute any user's S | Below threshold: nothing. It never learns S (the answer is encrypted to `a`) |
| Google | Signing ID tokens only for the real account | Mint a token for any `sub`, client and nonce → open a session and derive that user's key in any scope | Nothing beyond what a token gives; it never sees keys |
| Hana operator (owner, signer, relayer accounts; Cloudflare account) | Running the contract, API and pages honestly | Today, total control: post an issuer key (owner or `KEYS_UPDATER_KEY`) and mint tokens; upgrade the contract (signer full-access key, no lock); serve modified vault/auth bundles. Suspend apps, stop relaying, list or remove shared clients | Move a scope's registered clients or owners, or block derivation for a scope with its own client, **without** those powers above. Read keys in normal operation |
| API Worker logic and D1 (not the pages, not the secrets) | Gating and relaying; holding shares | Deny service; with `VAULT_KEK` plus a device dump, get PRK; point a vault at another scope of the same user only together with a Google client the registry maps to that scope (the vault's login check, D56, refuses any other combination); set or widen `raw_sign`/policies (the user still approves raw requests and must accept a new `policyId`); make the vault page frameable by another origin (D1 origins) | Substitute the signer, path or CKD key (pinned in the bundles, path computed in the vault); read or swap the relayed token (end-to-end encrypted); sign without the vault |
| Partner (app owner) | Its own app config and, in own-client mode, its Google client | Own-client mode: obtain tokens with any nonce for its client and derive its own users' keys in its scope (inherent: Hana can't see Google client settings). Set an auto-approve policy (delayed; users must accept it) | Anything in another scope. In shared mode: derive keys (no token with a nonce of its choosing) |
| Partner page (incl. XSS, malicious dependency) | Nothing | Start a login (visible popup), read addresses, queue signature requests, drive an unlocked vault within its idle/absolute limits, get requests signed that match an accepted auto-approve policy; navigate, close or focus the approval popup it opened (D99, "Approval popup opened by the partner page") | Read keys, tokens, nonces; get any other signature without a guarded Approve in a Hana popup |
| User's browser and device | Running Hana's pages; keeping the profile private | Malware or an extension in all frames: everything the user can do, including reading an exported key (on screen, or from the clipboard after Copy key, D268). A disk dump with a live share: unlock and get PRK | After logout, idle or absolute expiry or revoke: nothing (an open export window erases its key then too, and at most 5 min after deriving it, D111). A derive (the persisted session is used up) |
| NEAR RPC (manifest `rpc`, and `rpcFallback` when set) | Liveness, honest views | Fail derives, report wrong counters or a wrong registry answer (a refused login), delay. For most reads the fallback is asked only when the primary fails, so a lying primary is not outvoted there. One provider alone could also name another identity's path (a forged "member of account R" view) and forge a CKD answer for it when it knows R's secret (R's owner), which the pairing check would pass: so every path that isn't the signed-in identity's own is read on `rpc` and `rpcFallback` separately and must agree, or the login (or export) is refused (D263) | Forge a CKD result for the user's own path (pairing check against the pinned key, which was read from ≥ 3 independent providers that all agreed at one final block, D100); steer a login to another identity's path unless both providers lie the same way |
| Email issuer (`apps/email-issuer`: its Worker, `K_sub`, its signing key) | Which email identity an address is (only it holds `K_sub`), sending codes, minting email tokens only after a code or for a Google-verified address | Everything its signing key gives (log into email-rooted wallets, D200). With its Worker: answer google-match wrongly. Case A, Google-hosted: mint an `auto_link` token joining a **new** Google user silently to an email wallet it controls, so the user's Google login opens the attacker's wallet; answer `none` for a user who has an email wallet, so their Google login opens a second wallet (D266, accepted: the vault can't check the match without the address) | Attach an email identity in a plain Google login (D139: case B needs this popup's own email step); reuse a link token for another session, join or epoch (D133); link without the contract's link counter seeing it (D200, the watchdog alerts on bursts) |
| Anyone watching the chain or mempool | Nothing | Read used tokens (openid-only claims via the API), replay `create_session` with them (the vault derives with the next counter), replay a whole combined call (burns a `max_uses = 1` login: `session_consumed`; attacker pays gas) | Derive for themselves (needs the session key; the answer is encrypted to `a`) |
| Partner backend (identity tokens) | Verifying identity tokens as `docs/integration.md` section 15 says (`aud`, `iss`, `typ`, ES256) | Hold its users' tokens (≤ 1 h each) and what they say: `sub`, `sid`, addresses; act as a user **at itself** with a stolen token until `exp` | Use a token at Hana or another partner (`aud`, no Hana API accepts one), reach a key, map its `sub`s to another partner's or to a Google account (keyed HMAC per scope) |
| Another website | Nothing | Embed a vault with its own `pk` and log users into its own scope (legitimate) | Frame the vault for app X (`frame-ancestors`), receive `auth-params` (the popup checks `event.origin` and `event.source`), inject a token (the relay slot is written only from `authOrigin`, read only with `relayReadKey`) |

## What a compromise gives

| Compromised | Effect | Limits |
|---|---|---|
| One session-pool relayer key | Burn its allowance (≤ 2 NEAR default); relay session methods | Receiver and method list fixed on chain; every method still needs a token or session signature. DoS only |
| An owner-pool key | Burn ≤ 0.5 NEAR; relay owner methods | Every owner method needs an owner proof on chain; logins unaffected |
| `KEYS_UPDATER_KEY` (Worker secret, function-call key on the signer account) | Governance contract (sandbox-dev since 2026-10-30): **propose** an attacker RSA key (`set_issuer_key`), which waits `issuer_key_delay_ms` (mainnet 2 h) in public. v1 contract: set it at once → mint Google tokens for any `sub` → derive any user's key | The watchdog cancels a pending key Google doesn't publish within one run and deletes every updater key; an active one (the watchdog was down) makes it pause and delete every updater key (D82, D126). Full table: `docs/governance-spec.md` "What a compromise gives"; recovery: `docs/playbooks.md` `updater-key-stolen`, `forged-active-key` |
| The email issuer's D1 (a Cloudflare account member or token that can read it, or the Worker) | The user directory (D269): every recorded user's verified address, joined to their `sub`, so to their on-chain path, balance and history, and the apps they use (accepted by the user, D269) | Log in as anyone or mint a token (no key is in the D1) |
| The email issuer's Worker (code or secrets) | Its signing key's powers (D121, D200), and google-match's answers: join new Google users to email wallets it controls (case A, Google-hosted, silent), or answer `none` (a second wallet) (D266) | Never a case-B join without the popup's own email step (D139); every link bound to its session and the chain's state (D133); the link counter and the watchdog see link bursts (D200); custody: KMS and a second signer before mainnet (D121) |
| Owner key (governance contract: the council DAO, 2 of 3) | Two council keys: issuer keys (delayed like the updater's), config, pause/unpause, upgrades and owner transfer (after `governance_delay_ms`, mainnet 72 h), surplus withdrawal | Every delayed action is public and cancellable by the owner; the watchdog alerts on each (`governance_change`). See `docs/governance-spec.md` and `docs/playbooks.md` `unexpected-owner-action` |
| Signer account full-access key | Redeploy the contract: anything, including MPC requests for any path | No upgrade lock in batch A/A.2/B. Open issue (e), D33; fix specified in `docs/governance-spec.md` |
| D1 | App origins (→ `frame-ancestors`, parent-origin checks; a bare write of an `app_origins` row with `active_from` set skips the guarded-change delay), app scope, settings incl. bare writes of `raw_sign`/policy without the pending delay, suspensions; `share_enc` rows. The API's hourly drift detection (`changes/drift.ts`) flags such writes of origins, policies and raw signing against `guarded_changes` and the 0006 baseline (only while no later `app_changes` row ended a baseline value) as `drift` security events; it can't catch an insider who also forges those rows, and doesn't cover keys, suspension bits or deletion (a bare write of `app_keys`, `suspended_by` or `deleted_at` goes unflagged; `app_changes` has no row for it) | `K_s` needs `VAULT_KEK`; a policy needs the user's consent to its `policyId`; raw requests still need approval |
| `VAULT_KEK` | Unwrap every `K_s` in D1 | Useless without a device's IndexedDB record (PRK is encrypted under `K_s` only on the device) |
| API Worker code or all Worker secrets, or the Cloudflare account | Everything: the API Worker renders the vault page (inlined config, `frame-ancestors`) and holds `KEYS_UPDATER_KEY`; the same account deploys the two page Workers that serve the vault and auth bundles | Single trust root. Mitigations: small vault bundle, strict CSP, no third-party script, narrow `frame-ancestors` |
| `vaultOrigin` | Every key of every user that loads it (PRK in memory) | — |
| `authOrigin` | Tokens of logins it handles; approve anything it shows; export keys | Must still go through the vault for PRK (export does its own login) |
| Partner origin | As "Partner page" above | Bounded by approval and the accepted policy |
| A partner's Google client (own-client mode) | Tokens with chosen nonces for that scope → that scope's users' keys | Other scopes |
| Hana's shared Google client or its Cloud project | Break isolation of every `allow_shared` scope | Own-client-only scopes |
| Leaked in-memory PRK | Every v1 chain and account under that `key_index` | Other `key_index` values; rotation is the only remedy |
| An identity signing key (the active one on the Worker, or a published standby or next key from `.secrets/`) | Forge identity tokens for any user of any app: be anyone at every partner that uses them as login evidence, while partners trust the key | No key, no signature, nothing at Hana or on chain (no Hana API accepts the token). The standby is never on the Worker (D177), so a Worker or Cloudflare leak exposes the active key only. Testnet only: staging and mainnet sign with a non-exportable AWS KMS key (next row). Recovery (playbook `identity-signing-key-compromised`): switch to a key the incident didn't touch (the standby, or a fresh one when both may be exposed), unpublish the exposed ones (partners reject them within 10 min), tell partners. A key of the attacker's own put in the JWKS (through the API Worker or the Cloudflare account) pages critical from the watchdog's pin check within one run, and fails the outside probe within 15 min, **if** it is served to them too: the same attacker can serve the watchdog and the probe a clean JWKS, or publish for less than a run (D210). Partners trusting the JWKS URL accept it until it is removed; partners pinning thumbprints never. A stolen key of Hana's own is invisible to both (its kid is pinned) |
| The KMS signer's AWS access key (`IDENTITY_AWS_*`, or the API Worker itself on a KMS env; none yet) | Have KMS sign forged identity tokens for any user of any app while the access key is active. The key itself can't be read or exported | Only `kms:Sign` on the active key with `ECDSA_SHA_256` and `DIGEST` (IAM policy; the key policy refuses `Sign` by any other principal, grants to everyone, key changes to all but the break-glass role). The standby isn't in the IAM policy (which also denies `Sign` on any other key), so it stays clean for the switch (D219). Only long-term credentials sign: the key policy denies `Sign` to session credentials, because the holder can always call `GetSessionToken` (no policy can deny it), its sessions keep the user's live permissions, and deactivating the access key isn't proven to end them (confirm on staging). Every signature is in CloudTrail, matched by `userIdentity.arn` (the planned reconciliation and alarms find unexplained ones; `GetSessionToken` by the signer user is an alarm). Recovery (planned playbook `identity-kms-signer-compromised`): deactivate the access key, check the `NoSessionCredentials` deny is on every key, switch to the standby, unpublish the suspect key, tell partners with CloudTrail's window and count |
| `IDENTITY_SUB_KEY` | Map partners' `sub`s back to on-chain paths, so to the Google `sub` (privacy) | Funds and keys unaffected. Never rotated: a new key changes every user's `sub` at every partner (a `u2_` scheme with a 90-day `legacy_sub` window if it ever leaks) |
| The ledger writer's credential (`usage_writer`: the Hyperdrive config, `.secrets/<env>/neon-usage-writer.url`) | Insert made-up usage events (any org, app, uid) and identity counts; call the report functions (C12) for any org | No read or change of any table (functions only, D141); events can't be altered or deleted, so real ones stay. Billed gas comes from settlement, which reads each `near_tx` at FINAL from chain (C12): a made-up hash never settles, and C12 must also refuse a real transaction that isn't the event's own (a `near_tx` already in the ledger, or a transaction whose signer key and nonce differ from the event's `relayer_pk` and `relayer_nonce`; `docs/batch-c-build-plan.md` C12). Rotate with `usage-setup roles` after deleting the role files, then update the Hyperdrive config |
| `USER_ID_KEY` | Link a known Google `sub` to its ledger uid in a scope (and so its activity); with the ledger, re-identify users | No funds, keys or logins. Never rotated within a contract term (a new key makes every user new in MAU); API only, never logged |
| One identity token (a partner's log, transit) | Act as that user at that partner's backend until `exp` (≤ 1 h) | That partner only (`aud`); never at Hana or on chain |
| A session key (with its vault record) | Also: mint identity tokens while the session is live | The same session's limits, its app only; a logout or revoke stops new tokens in every app of the scope (the share check, D178: a share is kept 24 h after it dies), the 1 h `exp` bounds the old ones |

## Key and secret inventory

| Key / secret | Type | Lives in | Held by | Lifetime and rotation |
|---|---|---|---|---|
| CKD master secret | BLS12-381, threshold-shared | MPC nodes (TEEs) | NEAR MPC network | Not Hana's. A new network changes every address |
| CKD network public key | BLS12-381 G2, public | manifest `ckdNetworkKey`; build constant of vault/login/export bundles | public | Pinned with `scripts/fetch-ckd-key.ts` from ≥ 3 independent RPC providers that must agree, with the block recorded (`ckdNetworkKeySource`, D100); never read at runtime by the pages |
| S (CKD secret) | 48-byte G1 point | Browser memory only | vault / export window | Zeroed by `extractPrk` (`packages/core/src/derivation.ts:46`) |
| PRK | 32 bytes | Vault memory; IndexedDB record as AES-GCM under `K_s` | vault | Zeroed at `expiresAtMs` and after the app's `idle_ttl_ms` with no request that uses the key (each by a timer, and on the first use past it if the timer is late; after the idle limit a `'session'` record can be unlocked again while its share is alive), logout (any tab of the app), a `revoked` broadcast for its share, a newer login. Rotation: new `key_index` |
| Chain keys (Stellar seed, EVM `d`) | ed25519 seed, secp256k1 scalar | Derived per signature, zeroed in `finally` (`withChainKey`, `derivation.ts:98`) | vault; export window shows one on request, or copies it to the clipboard on the user's click (D268: out of Hana's control from then on, a best-effort blank after 60 s) | In the vault, same as PRK. In the export window (D111, sweep AUTH-1): zeroed and taken off the screen at the first of 5 min after it is derived (`EXPORT_KEY_LIFETIME_MS`, a timer plus a server-clock check on every reveal and copy), the vault session's end (`sessionExpiresAtMs` in the context, or `hana:export-end` from the vault on logout, revoke, expiry or a newer login), the vault frame going away, and the window closing; exporting again needs a new window and a new Google sign-in |
| BLS app key `a` | BLS12-381 scalar | Memory, one login | vault / export window | Made by `newAppKey` (`packages/core/src/ckd.ts:84`), dropped after `decryptCkd` (a bigint: dropped, not zeroed) |
| Session key | Ed25519, non-extractable WebCrypto | Vault memory; IndexedDB record in `'session'` mode | vault | ≤ the session (≤ 23 h 50 min app setting, ≤ 24 h on chain) |
| `K_s` | 32-byte AES-GCM key per share | D1 only as `share_enc` under `VAULT_KEK`; vault memory briefly | API generates, vault uses | Ends with the share (idle ≤ `idle_ttl_ms`, absolute ≤ `session_ttl_ms`, revoke) |
| `VAULT_KEK`, `VAULT_KEK_PREVIOUS` | AES-256-GCM, `<id>:<base64>` | Worker secrets; `.secrets/<env>/vault-kek` (and `vault-kek.previous`), 0600, the only copy | Hana | Generated and set by `scripts/vault-kek.ts init` (wrangler stdin, never printed, file never overwritten). Rotate with `vault-kek rotate`: old value → `VAULT_KEK_PREVIOUS`, new id in `VAULT_KEK`; unlocks and the hourly cron re-wrap (`apps/api/src/vault/kek.ts`, `vault/cron.ts`) |
| `relayKey`, `relayReadKey` | 32-byte AES-GCM key / read capability | Vault memory; `relayKey` also in the login popup's `sessionStorage` until `/login/callback` reads it (`packages/web/src/auth/login-storage.ts`) | vault, login popup | One login; slot lives 120 s |
| Session-pool keys `RELAYER_KEYS` | ed25519 function-call keys on `relayer`, receiver `signer` | Worker secret; `.secrets/<env>/relayer-keys.json` | Hana | Default 3 × 2 NEAR. `deploy-contract` deletes and re-adds. The watchdog alerts on each key's remaining allowance and the account's balance (D150, read-only) |
| Owner-pool keys `OWNER_RELAYER_KEYS` | same, owner methods | Worker secret; `.secrets/<env>/owner-relayer-keys.json` | Hana | Default 1 × 0.5 NEAR; allowance monitored like the session pool (D150) |
| `KEYS_UPDATER_KEY` | ed25519 function-call key on `signer`. v1 contract: `set_issuer_key`, `remove_issuer_key`. Governance contract: exactly `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`, installed only by the contract (`add_updater_key`); the API signs nothing else (`apps/api/src/relayer-config.ts` `UPDATER_METHODS`) | Worker secret; `.secrets/<env>/keys-updater.json` | Hana | 1 NEAR allowance. On the governance contract it can only propose (delayed, cancellable) and execute matured changes; a watchdog deletes it when it proposes a key Google doesn't publish. See open issue (e) and D33 |
| `WATCHDOG_KEY` | ed25519 function-call key on the watchdog's account (manifest `watchdog.account`), receiver `signer`, methods `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key`, 1 NEAR | Watchdog Worker secret (its own Cloudflare account); `.secrets/<env>/watchdog-secrets.json` | Hana (operator) | Created by `watchdog secrets <env> init`; rotate by adding a new key, then deleting the old (`docs/operations.md` "Watchdog service"). DoS power only (cancel, confirm a proposed change, pause, delete updater keys) |
| `WATCHDOG_STATUS_TOKEN` | random bearer token (32 bytes, base64url) | Watchdog and admin Worker secrets; same file | Hana | Read and acknowledge only: a holder can stop re-sends of an alert already paged, never a first alert or a check |
| Watchdog alert credentials (`RESEND_API_KEY`, `SLACK_WEBHOOK_URL`, paging app, `HEARTBEAT_URL`) | API keys / capability URLs | Watchdog Worker secrets; same file | Hana | The watchdog's own, not the admin Worker's (D87). Losing one channel leaves two (D85) |
| Watchdog's Cloudflare account | account credentials | the operator | the user | Separate login and MFA from the API's account (D86); a compromise gives the watchdog key and its alerting, caught by the dead-man's switch |
| Owner, signer, relayer account keys | ed25519 full-access (not ml-dsa-65: `docs/decisions.md`) | `~/.near-credentials/testnet/` on the operator's machine | the user (Hana admin) | Manual. Agents never ask for or handle them |
| Google ID tokens | RS256 JWT | Transient; public on chain once used | user's browser, relay (ciphertext), API (in transit) | Never logged or stored; openid-only claims |
| Google RSA public keys | JWKS | On chain (issuers); API isolate cache (≤ 6 h stale on fetch failure) | public | v1 contract: hourly cron sync. Governance contract: the 15-min cron proposes and executes delayed changes, the watchdog checks them against its own JWKS copy |
| Console owner-action tokens | RS256 JWT (console audience) | Transient; `sha256` marker in a `RateLimiter` until `exp` | partner owner | Single use (nonce bound to `action_nonce`) |
| Publishable keys | `pk_test_` / `pk_live_` + base58 | D1, partner pages | public | Not secrets |
| Invite link tokens | T = HMAC-SHA256(`INVITE_LINK_KEY`, "hana-console/invite/v1" ‖ borsh(invite id)), 32 bytes | The invitee's mailbox (`<console.origin>/invite#t=…`, a fragment); `CONSOLE_DB` holds only sha256(T), set by the admin Worker's ack | the invitee | 7 days from creation, single use, email-bound; works only after every notice send was accepted. `INVITE_LINK_KEY` is the admin Worker's secret (C8), never the console's (D240) |
| Owner-grant cancel tokens | T = HMAC-SHA256(`CANCEL_LINK_KEY`, "hana-console/owner-grant-cancel/v1" ‖ borsh(grant id)) | The grant notice's recipients (every owner, the security contacts, the alias); `CONSOLE_DB` holds only sha256(T) | them | Cancels one owner grant once, by POST, until `owner_from` |
| Console session cookies (`__Host-hana_cs`) | 32 random bytes, b64url | The member's browser (`HttpOnly`, `SameSite=Strict`, console origin); `CONSOLE_DB` holds only sha256 | the member | 2 h idle, 12 h absolute; revoked on removal, role change, disable or a freeze of the member's only org. Created by sign-in from C9 |
| Identity signing keys (Worker slots `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY`) | P-256 private JWKs (ES256), testnet and `local*` only | The active key: a Worker secret and `.secrets/<env>/identity-signing-key.json`. The standby: `identity-signing-key-standby.json` only, kept offline, never uploaded until a switch (D177). During a rotation a `next` and a `previous` key. 0600, the only copies | Hana | `scripts/identity-key.ts`: `init`, `next`, `switch --to next|standby`, `retire --key previous|standby` (wrangler stdin, never printed, files never overwritten); public halves in the manifest's `identityToken.publicKeys` (the JWKS). `activeKid` picks the signer. Staging and mainnet: AWS KMS (next row) |
| Identity KMS keys (`identityToken.signer.keys`: `active`, `standby`, during a rotation `next`, `previous`); none yet | AWS KMS `ECC_NIST_P256` `SIGN_VERIFY`, origin `AWS_KMS`, single-region; the standby in another region (D219) | AWS KMS in D121's dedicated account; never exportable, never on the Worker. The manifest holds their ARNs and public keys only | Hana (break-glass role with MFA administers; the key policy in `docs/operations.md` "Identity token keys on AWS KMS") | Created in AWS by the operator; published with `identity-key kms-init / kms-add`, switched with `kms-switch`, unpublished with `kms-retire` (then disabled and deleted in KMS, 30 days); scheduled rotation every 12 months |
| KMS signer's AWS access key (`IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY`) | Long-term IAM user key (`AKIA…`) of the env's signer user (`identityToken.signer.credentials.iamUser`) | API Worker secrets; `.secrets/<env>/identity-aws-access-key.json` (0600) only between `aws iam create-access-key` and the checked upload, then deleted | Hana | `identity-key kms-put-aws-key` (one `wrangler secret bulk`, never printed); rotated every 90 days and on suspicion; the user can only `kms:Sign` the active key (D215, D219); never logged |
| `IDENTITY_SUB_KEY` | 32 random bytes (base64) | API Worker secret; `.secrets/<env>/identity-sub-key` (0600), with an offline backup alongside the council backup (D81) | Hana | Never rotated (it fixes every user's `sub` at every partner); never logged |
| Identity tokens | ES256 JWT, ≤ 1 h | Vault memory (and its per-app channel), the partner page, the partner backend | the user's session, the partner | Not stored by Hana: no per-token record, never logged; refused by every Hana API (`bad_token`) |
| Email issuer signing key `ISSUER_SIGNING_KEY` (signer `hana`) | RSA-2048 private JWK (RS256), testnet and `local*` only | The primary: an issuer Worker secret and `.secrets/<env>/email-issuer-signing-key.json`. The standby: `email-issuer-signing-key-standby.json` only, offline, never uploaded (D196). 0600, the only copies | Hana | `scripts/email-issuer.ts init` / `put` (wrangler stdin, never printed, never overwritten); public halves in `emailIssuer.publicKeys` (the JWKS, kid = RFC 7638 thumbprint, the watchdog's pin). On chain owner-posted only, after `governance_delay_ms`, pinned by the watchdog. **Whoever can read the Worker's secrets can mint any email user's token** (1-of-1, D121); mainnet: AWS KMS (adapter built, not wired, batch 10) |
| `EMAIL_SUB_KEY` (K_sub) | 32 random bytes | Issuer Worker secret; `.secrets/<env>/email-sub-key` (0600) plus two offline backups (D81) | Hana | **Never rotated**: it fixes every email user's `sub` and so their address; losing it locks them all out. A leak lets the holder test guessed addresses against on-chain subs (privacy), never mint. K_sup = HMAC(K_sub, "hana-id/suppression-key/v1") keys the suppressions, so they last as long as K_sub (D199) |
| `EMAIL_CODE_KEY` (K_code), `EMAIL_RL_KEY` (K_rl) | 32 random bytes each | Issuer Worker secrets; `.secrets/<env>/email-code-key`, `email-rl-key` | Hana | K_code MACs the codes in the challenge objects; K_device = HMAC(K_code, "hana-id/device-ticket-key/v1") signs owner device tickets. K_rl keys the limiters (mailbox and recipient domain). Rotating K_code kills live challenges and every device ticket; rotating K_rl resets the limit windows; neither touches suppressions |
| Owner device tickets | `dt2.` + b64url(expiry ‖ nonce ‖ HMAC(K_device, address key ‖ nonce ‖ expiry)) | The user's browser (batch 8: the popup on `authOrigin`) | the user | 30 days, bound to one exact normalized address (its K_sup HMAC); returned only by a correct code. Grants the address's owner allowance (3 code mails a day per address, all its tickets together; the ticket slot of 3 checks; ≤ 10 ticket challenges per address a day; per mailbox 9 mails and 30 owner challenges) and skips the prefix limits, app quotas, domain caps and the general pool, never a token. At most 5 live per address (a 6th revokes the oldest); revocable per address by staff (`admin/revoke-tickets`). Not stored by Hana, never logged (D198) |
| Unlock and confirmation tokens | `ug1.` / `uc1.` + 32 random bytes | The address's mailbox only (mailed by `admin/unlock`, `admin/unsuppress`); the issuer keeps only sha256 | the user | One use, 24 h. An unlock token is one owner start (ticket slot, then 2 checks of its own); a confirmation removes the address's suppression. Staff never see them; never logged (D198, D199) |
| `SENDGRID_API_KEY` | SendGrid API key, Mail Send only (D194) | Issuer Worker secret; `.secrets/<env>/email-issuer-sendgrid-key` | Hana | Its own key, not Hana Wallet's or Wend's; rotate in SendGrid, then `put`. A leak sends mail as Hana's user-mail subdomain (phishing, reputation), not tokens |
| Sign-in codes | 6 digits | The user's mailbox and SendGrid while it delivers (and in SendGrid's Email Activity for its retention period); the challenge object holds only HMAC(K_code, challengeId ‖ code) | the user | ≤ 10 min, single use, 5 attempts; never logged |
| Challenge id secret half | 16 random bytes, the second half of the challengeId | The client only; the object is named by sha256 of the public half | the user's session | Decrypts the address in the challenge record (AES-256-GCM, D197); the issuer holds it only during a `resend` or `verify` |
| Ledger role passwords (`usage_writer`, `usage_admin`, batch C4) | 32 random bytes (base64url) each | Their Hyperdrive configs (writer: the API's `USAGE_DB`; admin: the admin Worker's, C8); `.secrets/<env>/neon-usage-writer.url`, `neon-usage-admin.url` (0600). Neon holds only SCRAM verifiers | Hana | Generated by `usage-setup <env> roles` (never printed; sent to Neon as a verifier, never as plain text). Roles can only call their functions and read what D141 grants |
| `USER_ID_KEY` (batch C4) | 32 random bytes (base64) | API Worker secret; `.secrets/<env>/user-id-key` (0600) with an offline backup | Hana | `usage-setup <env> user-id-key` (wrangler stdin, never printed, file never replaced). Not rotated within a contract term; never logged; the uid is `HMAC(key, scope ‖ provider ‖ sub)[0..16]` |
| Cloudflare account / `wrangler login` | account credentials | operator's machine | the user | Deploys the Worker: a trust root |

Rule (CLAUDE.md): derived keys, CKD secrets, relayer keys, owner keys and Google tokens are never logged, printed,
written outside `.secrets/` (gitignored, 0600) or committed; a gitleaks pre-commit hook blocks secrets. Its config
has rules for every secret shape above (NEAR secret keys, `VAULT_KEK`, `.dev.vars` lines, private JWKs (`"d"`),
Postgres URLs with a password, the secret files by name, `user-id-key` and the ledger's URL files included),
proved on generated fakes by `scripts/secret-scan-selftest.mjs` in the tests and in CI (security sweep OPER-2).

## Invariants and where they are enforced

### On chain (`contracts/hana-signer`)

- Tokens: RS256 against on-chain issuer keys, known `iss` and `kid`, `exp` against block time, `sub` without `#`,
  ≤ 7168 bytes (`oidc.rs`, `issuers.rs`). No claim allow-list on chain (deliberate).
- Nonce commitments: the session nonce binds the signer account, `scope_id`, session key, expiry, `key_index`,
  `max_uses` and salt; register proofs, client proofs and owner-action nonces bind their action and the deployment.
  Layouts: `docs/contract-interface.md` "Byte layouts".
- Scope isolation: a scope's own client resolves only to that scope (`Token is for another app`); a shared client
  only into a scope with `allow_shared`; anything else is refused. Path = `scope#provider#sub#key_index`.
- Clients are globally unique; shared and scope clients are disjoint; removed clients are quarantined for
  `change_delay_ms`; dropped shared clients are retired forever.
- Timelocks: `AddClient`, `SetOwners`, `SetAllowShared` and shared-client additions wait `change_delay_ms`; a delay
  decrease waits the current delay; removals and `disable_shared_login` are immediate. `public_registration` is
  one-way.
- Sessions: expiry ≤ 24 h, `max_uses` 1..=500, `key_index < 2^31`, one unexpired session per key (revoked ones keep a
  tombstone), `counter == used + 1`, Ed25519 over `"hana-id-session-v1:" ‖ counter ‖ sha256(payload)`; the off-chain
  vault prefix `hana-id-vault-v1:` can never verify as a session message.
- `create_session_and_derive` is atomic up to the MPC receipt: any signer-side panic reverts the session.
- Email login, contract v3 (merged on `develop`, not deployed; `docs/email-login-build-plan.md` batch 1):
  - Self-issued issuers (email): keys owner-posted only (never the updater key), each change waits ≥
    `governance_delay_ms`, never confirmed early; one RSA modulus once per issuer (no key counts as two signers);
    tokens are JWS JSON with ≤ 3 signatures, every one valid, from ≥ `required` distinct signers (1-of-1 `hana` at
    launch); the signer list and `required` change only by a governed upgrade, with a 10-minute overlap. Google and
    every other issuer stay compact-only. Trust: whoever makes the `hana` key sign can mint any email token, so reach
    every email wallet and every account linked to one (`docs/email-login-spec.md` "Trust statement"). Taking over a
    Google wallet with no email member needs a new link (D119); the contract counts new links per scope and in all per
    UTC hour and flags a scope (or the total) past its alarm threshold (D200; default 50 / 500, raising waits
    `governance_delay_ms`), and the watchdog pages `link_threshold_reached`. These are alarm levels: nothing is
    refused, the links go through, and the council decides whether to pause. With the email key alone a thief can also
    log into email-rooted wallets, and into Google wallets that already have an email member, without making any link:
    the counter can't see that, and the only defence is the key's custody (KMS, a second signer, D121).
  - Accounts: a member opens its root's path; an identity in no account opens the v2 path unchanged. Automatic links
    only inside a login and bound both ways (D133): the issuer's `auto_link` nonce binds the token to that session
    and to one join (session preimage hash, session identity, join, joiner, target root, target epoch, mode), and the
    session key's counter-1 signature covers the link token and its mode, so whoever submits a published login can't
    add, swap, change or strip a link. Case B (email joining a Google wallet) pending `change_delay_ms` unless the
    issuer's mode says at once; case A must be immediate; both-have-a-wallet is never merged; unlinked pairs are never
    re-matched (a cancel keeps the match, D132). Explicit links need fresh proofs of both identities and wait
    `change_delay_ms` (and the unpause floor). Every link change bumps the account epoch, which every link nonce
    commits to.
  - `opened` ("has a wallet") is set at derivation, so a copied token in a bare `create_session` can't create a
    wallet (D130); a linked identity's own path never derives (D136); after a migration from pre-v3 state every link
    waits for the owner's `accept_unrecorded_wallets` (D135). Unlinking stops future sessions only; open ones run to
    their end.
  - Only `email` can be self-issued (D134); keys a governed upgrade adds to a signer policy are checked like
    `set_issuer_key`'s (no padded duplicate as a second signer), and a "replace the signer" upgrade can drop the old
    signer's keys with no overlap (D136).
  - A bare `create_session` needs the session key's proof of possession, bound to that call's session parameters
    (D137), so a published token can't be used to occupy its session key; a replacing signer-policy upgrade must use
    new signer ids and cancels dropped signers' pending keys (D138).
  - Off-chain obligations (later batches): the vault verifies a link token and recomputes its `auto_link` nonce before
    signing the linked CKD payload; it signs a case-B join (`join = 2`) only when this same popup ran the user's
    email-code step and the link token's `sub` is the address verified there (D139), so a compromised issuer service
    can't attach an email identity to a Google wallet during a plain Google login. It can still, in case A, join a new
    Google user to an email wallet it controls, or say "no match" (a second wallet): the vault can't check which email
    identity an address is (D266, accepted; the link counter below alarms on the first). A session it meant to link is
    revoked and restarted,
    never derived with the plain payload (D137). The issuer mints the nonce with the join it decided; the API
    prechecks both and relays the split path's proof of possession (built in batch 6, "API" below); the watchdog alerts critical if
    `unrecorded_wallets` is ever true outside dev envs (D139; built, D193).
  - **Link volume counter (D200).** With a stolen email signing key alone (1-of-1 at launch) a thief can log into
    every email-rooted wallet, log into every Google-rooted wallet that already has an email member, and link their own Google account into victims' email
    wallets (case A, one Google account per victim and scope). Since D133 a link also needs the session key's signature,
    so the key alone can't join an email identity to someone else's Google wallet. Only the last of the three makes new
    links. The defence against a stolen key is its custody (KMS, a second signer, D121); the counter only detects bursts: the
    contract counts every new link (a combined login with a `link_jwt`, `link_identity`) per UTC hour, per scope
    and in total, records when a count reaches its alarm threshold (50 per scope, 500 in total per hour), and never
    refuses a link. The watchdog reads `get_link_stats` each run and alerts; the owner then pauses and removes the key.
    A refusing cap was rejected: it bounded little and anyone could burn it with one Google account and one email
    (review H2), locking real users out. The owner lowers a threshold at once; a raise waits `governance_delay_ms`, so
    a compromised owner can't quietly blind the alarm (the watchdog alerts on the scheduled raise). Fixed hours: a burst
    across a boundary splits between two windows (the view keeps the previous one).
  - Contract security notes: `docs/contract-interface.md` "Security notes (for reviewers)"; readings made in the build:
    D130, D131; review fixes D133–D138, off-chain obligations D139.

### API (`apps/api`)

- **Verify before relay.** Nothing reaches the chain unless the off-chain checks pass: RS256 + claims + recomputed
  nonce (`/v1/sessions`, `/v1/login`; `verifyIdToken` in `packages/oidc`, which also returns `email`,
  `email_verified`, `iat`, `hd`, `azp`, `amr` and `auth_time` when present and well typed, dropping a wrongly typed
  one, D201; the API reads none of them and never logs, returns or stores them, on logins and owner actions alike,
  D25, D96, checked by `apps/api/test/session-flags.test.ts` and `owner-actions.test.ts`), scope check (`checkClientScope`, `handlers.ts:384`), `session_key_in_use`,
  session signature, session-use precheck mirroring the contract's counter and `max_uses` rules (`session-use.ts:29`,
  D20), BLS key shape. The scope is always the app's D1 `scope_id`, never the client's.
- **Usage capture fails open and carries no PII** (batch C4, `src/usage/`). The ledger event is built at the response
  and written after it (`waitUntil`); a missing binding, a refusing, slow or hanging server, a refused event or a
  missing uid key never changes a status, body or header or delays an answer (`apps/api/test/usage.test.ts`). A lost
  event is logged (`usage_write_failed`) without the connection string or the driver's message. An event holds no
  sub, JWT, email, IP, session key, share id or path: the user is the uid, a keyed pseudonym (D96) computed after the
  response from the path the request already holds. The writer role can only call `usage.record_event`,
  `usage.record_identity_tokens`, `usage.record_email_counts` (D233) and `usage.ensure_partitions` (bounded, creates missing months only); nothing on the login path, and nothing the `no_session` waiver decides, reads Neon.
- **Replay precheck.** A cached session view never refuses on its own: it is re-read fresh first. A second request
  for the same `(session key, counter)` in the same isolate waits for the first (`session-use.ts:76`).
- **Claim allow-list** `{iss, azp, aud, sub, iat, exp, nonce, nbf, jti, auth_time}` (`apps/api/src/claims.ts:8`):
  always on, with no flag or option, for every Google token the API relays: `/v1/login`, `/v1/sessions`, the link
  routes (`verifyLoginToken`, D271) and `/v1/owner-actions`'s owner tokens and client proofs (D274). A token with any
  other claim is `400 token_has_pii` and nothing is relayed (`apps/api/test/session-flags.test.ts`,
  `email-login.test.ts`, `owner-actions.test.ts`; `scripts/test/relayed-tokens.test.ts` fails on a new
  `verifyIdToken` caller). The vault and the login popup apply the same list (`@hana-id/core`), and the smoke direct
  page refuses to send such a token. End to end, a Google token carrying `email` is refused by
  the login popup's callback before it is relayed (D273: only `{error: 'token_has_pii', claim}` crosses the relay),
  and the vault answers `token_has_pii` with the claim before any `/v1/login` call; nothing reaches the chain
  (`apps/e2e/tests/login.spec.ts`). A direct contract caller is still not bound by it.
- **Relayer allowlists** per pool in the Worker and in the object; gas only from `gas.ts`; receiver always
  `SIGNER_ACCOUNT`. The session pool also relays the three link methods (batch 6); no pool relays an owner,
  governance or updater method (`GOVERNANCE_METHODS`, tested).
- **Email tokens** (batch 6, `email-token.ts`, D231): checked against the manifest's email keys (never fetched, so a
  compromised issuer Worker can't change what the API accepts) and the on-chain signer policy (`get_self_issued`:
  every kid a listed signer's active key, `required` distinct signers), in the issuer's exact serialization, with
  exactly the issuer's claims (no address claim can reach the chain through the API), and only for an app whose
  `login_methods` lists `email` (`403 login_method_disabled`): until a partner turns email on, no email token is
  relayed for its app. The contract re-checks all of it.
- **Proof of possession on `/v1/sessions`** (D137): the session key's signature over `sessionMessage(0,
  "hana-id-create-v1:" ‖ sha256(session nonce preimage))` is required and verified before relaying, so a token copied
  from a published login can't occupy its session key through the API; contract v3 enforces it for direct callers too
  (v2 ignores the argument: `v2_ignores_the_create_session_proof_that_v3_requires`).
- **Link precheck** (`/v1/login` with `linkJwt`, D133, D232): the signature must be over the linked CKD payload
  (whoever relays can't attach, swap or strip a link), and the link token's `auto_link` nonce must match the join the
  contract would make from fresh chain reads; links stay closed while `unrecorded_wallets` is true or absent (pre-v3).
  The panics that remain are answered as their own errors (`panics.ts`), the text never logged.
- **Link relays** (`/v1/link*`, D232, D250, D252): from Hana pages only (never a partner page), every token verified
  and in the scope, every nonce and state rule prechecked; one relay per set of tokens across isolates
  (`link_in_flight`); adds and removals in separate windows per IP, per account root and per app, the app-wide removal
  windows only alarming, so neither a flood of adds nor another account's traffic can block a cancel of a malicious
  pending link; a global daily cap on adds bounds what links can spend of the session pool; cancel and unlink work
  whatever `unrecorded_wallets` or the app's `login_methods` say.
- **Share revocation after a link change is a convenience, not a security boundary** (review L4, D233): every success
  revokes the account's vault shares in the scope (the root path at `key_index` 0..63) so the account's other devices
  sign in again and see the change. It never protects a wallet: a share at `key_index` ≥ 64, or one left by a direct
  contract call that skips the API, keeps working until its absolute limit (≤ 12 h by default), and a device that
  already holds the derived key keeps it (D41: export is the user's). What protects a wallet is the contract (a pending
  link's delay, a cancel, an unlink stops future sessions) and, after a compromise, a `key_index` move.
- **Requests bound to fail aren't relayed twice** (D250): a pending member's session is refused before relaying (once
  links exist), and a request the chain refused for `link_pending` or `identity_linked` is answered from the isolate
  for 60 s, so a replayed doomed request can't drain the session pool.
- **Addresses never through the API** (D230): the email issuer is reached at its own URL (sandbox-dev) or by a zone
  route (production); the API serves nothing under `/v1/email/` and never forwards those bodies.
- **Owner actions**: OIDC auth only, console audience, a current owner of the scope, change exists / unlocked, client
  proof matches; the token is reserved single-use before relaying and released only if the tx certainly didn't
  execute; caps per owner identity (5/min, 30/day), per scope (10/min, 50/day) and global (20/min, 200/day), asked in
  that order and taken back from the earlier windows when a later one refuses (`hitAll`, `RateLimiter.unhit`);
  unauthenticated `execute_change` has its own per-scope window, never the owners'; `cancel_change` is outside all of
  these: 5/min, 20/day per owner identity, then 25/min, 100/day per target scope (only that scope's on-chain owners,
  verified before counting, reach it; sized for the contract's `MAX_OWNERS` = 5 at their cap), then a spend-bound
  ceiling of 100/min, 1000/day for all cancels; refused without an owner identity (D100; `handlers.ts`
  `ownerActionWindows`, `handleOwnerAction`, `owner-actions.ts`). Remaining starvation limits: in a scope, only all 5
  owners together can fill its cancel window; the global one needs ≥ 20 identities at their cap per minute (≥ 4
  attacker-owned scopes) or ≥ 50 per day plus 1000 cancellable changes (≥ 100 scopes' `MAX_PENDING`); an owner can
  always cancel on chain directly (`docs/operations.md`). The owner pool's allowance is the hard spend bound. The off-chain check doesn't recompute `owner_action_nonce`: a token with a wrong nonce is
  relayed and fails on chain, at the cost of its owner's own windows only.
- **Origin rules** (`apps/api/src/origins.ts:81`): a Hana page (`Origin` = `VAULT_ORIGIN`/`AUTH_ORIGIN`) may call only
  its endpoints, and only for an `x-hana-parent-origin` the app allows. Partner origins: `GET /v1/app` always; the
  session endpoints only for test-scope apps in dev envs. Loopback origins and `http://localhost:*` only for
  test-scope apps (`scopes.environment = 'test'`) in dev envs. Only origins in force count (`app_origins.active_from
  <= now`; NULL, not yet announced, never matches), in the gate, the vault page and the preflight alike. Test and
  live apps never share a scope (D51): `scopes` holds one environment per scope, and migration 0006's triggers refuse
  an app or key whose prefix names the other one (the gate still refuses such a key, `scope_conflict`, after a direct
  edit). A revoked key is `unknown_app`, the same as an unknown one. These checks bind browsers only (a script can
  send any `Origin`); they never replace a token or signature.
- **Hana origins host nothing else.** Each Hana origin is its own thin Worker (D66, `apps/api/src/pages/host.ts`): the
  vault Worker forwards only `GET /vault` to the API Worker, the auth Worker serves only its four pages, both serve
  static assets otherwise and answer only GET/HEAD on their own host. In the API Worker, a request whose URL origin is
  `VAULT_ORIGIN` or `AUTH_ORIGIN` reaches only `{vaultOrigin}/vault`; every other path is a 404 with `frame-ancestors
  'none'` and no CORS (`apps/api/src/index.ts`), so no API endpoint is ever same-origin with the vault's storage. The
  manifest schema (`packages/env/src/origins.ts`, `schema.ts`) refuses a Hana origin that is an IP address, a bare
  public suffix, a single label or has a trailing dot (any env), loopback (including `localhost.` and IPv4-mapped
  127/8) outside `local*`, `apiUrl`'s own origin (any env), or `apiUrl`'s site outside dev envs.
- **CORS**: app endpoints echo only an allowed origin; preflight allows the Hana origins and the origins in force of
  active (no suspension bit), undeleted apps (`origins.ts` `preflightAllows`); vault endpoints only `VAULT_ORIGIN`; the relay only the Hana origins; `/v1/owner-actions` and
  `/v1/health` are `*`.
- **Vault shares**: every lookup is `share_id AND app_id`; one share per session key; a share needs a live, used-up
  session in the app's scope; counter moves by one atomic `UPDATE`; a share whose partner origin was removed is
  revoked on next use; unlock and touch follow the app's settings as they are now (persistence `'none'` revokes the
  share; it never outlives `created_at` + the current `session_ttl_ms`), checked before the update and again inside
  it (`apps/api/src/vault/shares.ts`, `advanceShare`); `revoke-all` needs a share < 5 min old and revokes the other
  shares and moves its counter in one D1 transaction (`revokeAllFrom`), so it does both or neither and a replay
  revokes nothing; `K_s` is wrapped with AAD `share_id ‖ app_id ‖ session_pk`, so a row can't be moved to another
  share, app or key.
- **Login relay**: only `authOrigin` (and, for the follow-up slots, `vaultOrigin`) writes, only Hana origins read;
  write once (409), read once with the read key (403 without, slot untouched); 120 s then tombstone; ≤ 12 KiB, every
  plaintext ≤ 9000 bytes so one-request mode's largest payload fits (D267); ciphertext only.
- **Key exports** (`/v1/login` from `authOrigin`): 3 per hour per `(app, sha256(path))`, counted after the token and
  nonce checks and before the relay (`apps/api/src/login.ts`, D59), so starting exports can't drain the relayer
  allowance; a limiter that can't be reached refuses (503).
- **No cookies**: no response of the API Worker or the page Workers sets a cookie, and the page Workers drop a
  `Set-Cookie` from their bindings (`src/pages/host.ts` `withoutCookies`; D70). Tests:
  `apps/api/test/no-cookies.test.ts`, `packages/web/test/no-cookies.test.ts`, the Playwright `noCookies` fixture
  (`apps/e2e/tests/fixtures.ts`).
- **Rate limits** (fixed windows in `RateLimiter` objects, `rate-limiter.ts`, global and exact, unless marked *per
  location*; IPv6 keyed by /64, `ip.ts`):

  | Window | Limit |
  |---|---|
  | Relay endpoints per IP per app | plan `per_ip_minute` (free: 20/min) |
  | Key exports per user path per app | 3/hour |
  | Relay endpoints per app | plan `per_minute` / `per_day` (free: 60 / 5000), counted only after every off-chain check (D100) |
  | `GET /v1/app` per IP per app | plan `per_ip_minute`, its own window |
  | Vault endpoints | 60/min per IP per app (*per location*); 10 × `per_minute` per app; 10/min per share (share actions, *per location*) |
  | Login relay per IP | writes 40/min, reads 120/min (a Google login of an app with email writes about 5 slots: the token, the access token, a notice, an answer, the last word; a consent, code or proof round 2 more; so about eight such logins a minute behind one NAT, D267) |
  | Owner actions | 10/min per IP; per owner 5/min, 30/day; per scope 10/min, 50/day; global 20/min, 200/day; `execute_change` its own 10/min, 50/day per scope; `cancel_change` only 5/min, 20/day per owner, 25/min, 100/day per scope and 100/min, 1000/day for all cancels (D100) |

  Each request's windows are asked in turn: per IP first, and the per-app window only once the IP window accepted,
  so a request the IP window refuses never uses (or holds) any of the app's shared quota. On the relay endpoints the
  app's quota is asked last, after the token, nonce, session-signature, scope and session checks and right before
  the relay (`appQuota`, D100): the key and the `Origin` headers are public, so junk that fails a check never spends
  the quota every user of the app shares (security sweep APIW-1); the per-IP window bounds what junk can make the
  checks cost. On the vault endpoints the
  per-share limit comes last, after the body check, so it counts only requests both others accepted. A limiter that
  fails refuses the request (`503 rate_limiter_unavailable`); none fails open.

  **Per-location limits (D95).** The vault's per-IP and per-share limits are Cloudflare Rate Limiting bindings
  (`apps/api/src/vault/limits.ts`): each Cloudflare location counts on its own from a cached count that syncs in the
  background, so they cost no network hop but are approximate. Trade-off: a client can pass them by up to the
  sync lag, and gets the limit once per location it reaches (an IP usually reaches one; with Smart Placement, D94,
  most requests run in the placed location anyway). That is acceptable because they are flood limits only: every
  share action also needs the session key's signature over a fresh counter (a flood can't unlock anything), and the
  limit that protects other users, the app's shared vault quota, stays exact and global on the object. If one
  client exceeding its per-IP share of that quota becomes a real problem, move the per-IP limit back to an object
  (one extra round trip per vault request). Every limit that needs an exact count (relay quotas, key exports,
  owner actions, the login relay, owner-token single-use markers) stays on the objects.
- **App cache (vault endpoints only, D78).** `/v1/vault/*` takes the app row (status, key, origins, scope conflict,
  plan) from a per-isolate cache whose entries live 30 s from their D1 read (`apps/api/src/app-cache.ts`; unknown keys
  and failed reads never cached; at most 256 apps). Nothing in the Worker writes `apps`, so the staleness bound is the
  TTL: a suspension, a revoked key, a removed origin (its shares are revoked on the first use after) or a scope
  conflict reaches unlock, touch, revoke and share creation within 30 s per isolate. It caches the origins in force at
  its read, so it never serves a pending origin early (D208). The app's
  settings (persistence, TTLs), the share rows and the signature are read fresh on every request. The relay endpoints,
  `GET /v1/app` and the vault page never use the cache, so a suspension stops logins, relays and new vault loads at
  once (tests: `apps/api/test/app-cache.test.ts`).
- **Bodies and logs**: body caps (`readJson` streams and stops at the cap; vault 4 KiB, relay 12 KiB). Logs never carry
  tokens, `K_s`, `share_enc`, ciphertexts, signatures, relay bodies, keys, CKD responses or relay ids (the OAuth
  `state`: a relay path is logged as `/v1/login-relay`, the top-level error line included). The platform's invocation
  records, which carry the request URL, are off on the API Worker (`observability.logs.invocation_logs: false`, D100,
  security sweep APIV-3). Relay errors never return the RPC's or the runtime's error text (it can name the RPC URL,
  which can carry an API key): `near_unavailable`, `near_rejected` and `relayer_unavailable` answer a fixed message
  and log a code.
- **Admin CLI writes** (`scripts/lib/admin-apps.ts`, `admin-settings.ts`, `admin-sql.ts`; batch C3): every write is
  a compare-and-swap. Its first statement inserts its `app_changes` row only while the version the command read still
  holds (`origins_version`, `settings_version`, or for settings also every settings column as read); the version bump
  and every other statement run only if that row exists; the CLI reads the row back. The CAS is safe because D1 runs
  each query (one `--command` with all its statements) as one implicit transaction, so nothing else writes between the
  predicate and the bump and a failing statement aborts the whole write; the M1 rehearsal checks it on remote D1 (D207).
  A change made in between
  (another operator's `--auto-approve off`) is never overwritten with values planned from the old row, even when the
  other writer moved the version to the same number. Re-setting the policy in force keeps a matured pending policy as
  the stored one before clearing the pending columns, and an announcement keeps a matured pending policy or raw-signing
  value in force, so neither ever brings an older value back. The `no_session` waiver is decided inside the
  announcement's SQL from the database as it is then, and fails closed on any sign of a user in the scope
  (`first_session_at`, written at every session-pool relay attempt; the app's session marker, written once that relay
  settled (batch C4, D220); another origin ever in force; a vault share or identity row). It reads only the hot DB,
  never the usage ledger. Proposals and announcements are refused with `--remote` until the deployed API reports the batch
  C3 reads (`GET /v1/health` `hotDb` ≥ 6): an older API would treat a proposed origin as in force; announcements also
  need ≥ 9, the batch C4 API that writes the session markers the waiver reads. The CLI never puts a guarded change in force:
  origin adds, policies and raw-signing enables are staff proposals (`hana`, full `appChangeDelayMs`, refused within
  `appChangeDelayMs` of the scope's org assignment); `app:changes:announce` (only without an admin Worker, never on
  a production network) starts the clock and records that nobody was emailed. Raw signing is refused for test apps
  (D39 as amended 2026-10-28). Removals, turn-offs and suspensions are immediate. `app:resume` refuses a deleted
  app, which keeps Hana's bit for good (D225).
- **RPC writers** (`apps/api/src/rpc/`, `src/changes/`; batch C5; tests `apps/api/test/rpc-*.test.ts`), unbound until
  the console (C7) and admin (C8) Workers bind them, never reachable through `fetch`:
  - every input is validated with its strict console-core schema before anything is read; `ConsoleRpc` takes only a
    `member` actor (the emailed-link cancel only `link`), `AdminRpc` only `hana` (its cron methods also `system`);
  - every org method filters `org_id`, so another org's app or change is `not_found` and nothing is written;
  - every write is one D1 batch with its `app_changes` row first, inserted only while the compare-and-swap predicate
    holds or when its request id was used before (which then fails on `request_id UNIQUE` and rolls the batch back);
    every other statement runs only if that row exists. A replay is `already_applied`, a moved state
    `version_conflict`, and no applied change lacks its ledger row (fault injection on every statement);
  - a member never touches suspension bits 1 or 2; `deleteApp` revokes every key and leaves the app suspended for
    good; staff proposals get the full delay, no waiver but `createApp`'s `no_session`, and are refused within
    `appChangeDelayMs` of a scope assignment; expedite only for an announced member proposal, with a reason;
  - the `no_session` waiver is decided inside the acking statements and fails closed exactly as the CLI's does (a
    member candidate also needs an API-verified `proposer_sub`); `loopback` only for a member's loopback origin on a
    test scope in a dev env on a non-production network;
  - the cancel link is checked as `sha256(token)` against the stored hash, single use, until `active_from`;
  - a compromised console is bounded: destructive calls (`setSuspended(true)`, `revokeKey`, `rotateKey`,
    `removeOrigins`, a `googleWebClientId` change) at 5 per org and 20 across orgs per rolling hour (`rate_limited`,
    and one `breaker` event per limit and hour; a call that changed nothing gets its slot back). Every call fits a
    hot-DB budget: per-org buckets (10/s, burst 40) under the global one (30/s, burst 60), with the last 10 and 20
    tokens kept for the kill switches. One org takes at most 12 tokens of the global reserve a minute, and a kill
    switch that changed nothing is charged to its org's own bucket, not the reserve. Every call is also held to two
    reads and one batch of ≤ 8 statements;
  - emailed-link cancels (unauthenticated) have their own limits, never the members' budget: per client IP (IPv6 by
    /64), then a link-read budget sized for D1 (50/s, burst 100), both before the token is read. A cancel whose token
    verifies on a pending change is never refused after that. Residual: denying a valid link cancel takes a sustained
    50 bogus reads a second from at least 600 IPv4 addresses or IPv6 /64s (5 a minute each); the owner and Hana staff
    can still cancel in the console;
  - a replayed request id is `already_applied` only for the same write (kind, app, actor), otherwise `conflict`;
    `ackNotice` takes only the admin Worker's cron (`system`); the console never acts for `org_legacy`;
  - `relayerKeys` returns public keys only; RPC logs carry the method, request id, outcome and code, never the input;
  - the legacy `apps.publishable_key` is kept on the app's oldest unrevoked key or an unusable tombstone, so a reader
    of the column and `status` (`apps/email-issuer` until it moves to `app_keys`, D206) never accepts a revoked,
    rotating or deleted app's key (D225).

- **Identity token** (`src/identity/`; `docs/identity-token-spec.md` "Invariants"; tests in
  `apps/api/test/identity.test.ts`):
  - a token is minted only for a session live on chain (`get_session`, a refusal re-read fresh) and, in an app that
    keeps logins, whose share is live (judged as unlock judges it), in the app's scope, while the contract isn't
    paused (an unreadable config refuses), with a fresh (±60 s), single-use session-key signature over the identity
    message, which binds the signer, the app, the parent origin and the wallet proofs. The single-use marker is
    `sha256(sessionPk ‖ issuedAtMs ‖ nonce)`, reserved only once the session is known live (D176);
  - a session key whose share belongs to another app never mints, whatever this app's persistence, and dead shares stay
    as tombstones for 24 h (the longest on-chain session), so a revocation in one app of a scope reaches all (D178);
  - no tenant can use up what others share: per session key, per account root, per app (its own windows, never the
    vault endpoints' quota) and per scope before a global breaker set ≥ 10 × any app's ceiling; the global soft line
    only alerts (D176);
  - a mint writes nothing to the share: no counter moves, `idle_until` doesn't slide, and the vault doesn't count it as
    activity (D55, D112);
  - `exp ≤ iat + 3600` and never past the on-chain expiry, the share's idle limit or its absolute cap; less than 30 s
    left mints nothing;
  - every address in `wallets` is proven by a signature of its own key over a message bound to this session key and
    app: the session's holder controls it (not proof that it is the Hana-derived wallet of that `sub`; D179). The vault
    never raw-signs bytes starting `hana-id` or its own wallet-proof digest, so an approved raw signature can't serve
    as a proof; the claim set is exactly the spec's (`buildIdentityClaims` throws on anything else);
  - `sub` depends only on (scope, root provider, root sub): never the login method, client, device or `key_index`, and
    never the Google `sub` in the clear;
  - the signature is checked against the published key for its `kid` before the token is answered, whichever signer
    made it; the JWKS comes from the manifest's public keys alone and refuses a private member; every key it publishes must
    be pinned in `watchdog.pinnedIdentityKeys` (the schema, D211), and the watchdog, on its own account, pages critical
    for a published key it doesn't pin, any private member, a discovery document whose `issuer` or `jwks_uri` differs, or
    an answer it can't judge (`packages/jwks/src/identity.ts`, shared with the outside probe; D210, D213, D214). This
    detects a key served to everyone; it can't see one cloaked from the watchdog and the probe (D210);
  - the KMS signer (`src/identity/kms.ts`, `signers.ts`; tests in `apps/api/test/identity-kms.test.ts`) sends only the
    32-byte digest (no claim reaches AWS), one `Sign` per mint with no retry, under a 3 s deadline and a 4 KiB answer
    cap; it accepts only an answer for its own key ARN and algorithm and a strict DER signature (D216–D218); any other
    outcome, and any missing or malformed configuration, is `503 identity_signer_unavailable`, never a fallback to a
    Worker-secret key; AWS credentials, requests and signatures are never logged;
  - no Hana API accepts an identity token: `verifyIdToken` refuses `typ: hana-identity+jwt` or `iss` =
    `IDENTITY_ISS` first (`400 bad_token`), and the contract takes RS256 issuer keys only;
  - logs carry the app id, outcome, code, kid and timings, never a token, `sub`, `sid`, address or body.

### Console Worker (`apps/console`, batch C7, no route; tests `apps/console/test/*.test.ts`)

- **No public route** (`workers_dev: false`, `preview_urls: false`, no `routes`; a config test). Until C9 only the admin
  Worker's `StaffRpc` binding (C8) and the cron reach it.
- **Its own origin only**: any other host is 404. Every response, assets included (the Worker runs first), carries the
  spec's CSP (`default-src 'none'`, `script-src`/`style-src`/`connect-src`/`font-src 'self'`, `img-src 'self' data:
  <files.origin>`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`),
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `X-Content-Type-Options: nosniff` and HSTS
  (2 years, subdomains); `/api/*` also `Cache-Control: no-store`. No cookie is set in C7.
- **CSRF on every non-GET request**, whatever the path: `Sec-Fetch-Site: same-origin`, `Origin` exactly
  `console.origin`, `x-hana-console: 1` and `content-type: application/json`, else `403 csrf`. A GET never changes
  anything (the emailed links' pages only POST).
- **Emailed-link confirms** (no session, `link` actor): the guarded-change cancel goes to `ConsoleRpc.cancelChangeByLink`
  (the API checks the token, D228, D229); the owner-grant cancel compares sha256(token) with the stored
  `cancel_token_hash` inside the write's guard: single use, refused once `owner_from` passed, a wrong token, an unknown
  or unannounced grant all `forbidden` alike. Both are limited per IP (10 a minute, IPv6 by /64) before the body is
  read, with bodies capped at 4 KiB (1 KiB when chunked), counted as a stream and cut off at the cap, never buffered whole.
- **Invites fail closed** (D240, D241): created with no token hash, so no link works until the admin Worker's ack
  (`system` actor only) after every notice send was accepted; an owner invite to an existing org also needs its
  grant's notice (with the cancel link) acked before acceptance. The console never holds `INVITE_LINK_KEY` or
  `CANCEL_LINK_KEY` and no answer carries a token or a token hash (source check and tests).
- **The passkey gate** (spec §Deferred, D242): a second partner org is refused (`passkeys_required`) while passkeys
  haven't shipped, counting open new-partner-org invites; checked inside the insert, so concurrent issues can't race
  past it.
- **Every write is one D1 batch with its audit row first** (D243), inserted only while the write's guard holds, every
  other statement gated on it; a replayed request id fails on `audit_log (request_id, action)` UNIQUE and writes
  nothing. Acceptance is one batch the same way: two concurrent acceptances give one member, and a refused one writes
  no user, org, member or audit row.
- **Roles**: the last usable owner can't be removed or demoted; a pending owner (inside the grant's wait) is a viewer;
  a new owner of an org with an owner waits `ownerGrantDelayMs` (missing or out of range: grant writes refuse); removals,
  demotions, disables and freezes of a member's only active org revoke sessions at once.
- **Sessions** (model only until C9): looked up by sha256 of a 32-byte cookie (`__Host-hana_cs`, `Secure; HttpOnly;
  SameSite=Strict; Path=/`), a doubled cookie name refused, 2 h idle and 12 h absolute, its user not disabled.
- **What it keeps about people**: members' and staff emails (display), Google subs (owner match), invitees' addresses
  on the invite row only (deleted 90 days after the invite ends; never in `audit_log`, whose details are allowlisted per
  action), sessions' /24 or /48 network data (90 days). Logs carry ids and codes only. `STATEMENTS` is read only by
  code (no `put`/`delete`, a source check).

### Email issuer (`apps/email-issuer`, not deployed)

| Invariant | Where |
|---|---|
| **The issuer's `APP_DB` is a read-write binding of the API's D1** (Cloudflare has no read-only D1 binding): a compromised issuer Worker, or a bug in it, could write the API's tables (an app's origins, keys, settings). Held to reads by a source check (every use goes through `src/apps.ts`, SELECTs only); before mainnet replaced by a read-only RPC on the API (D251, `docs/mainnet-readiness.md`) | `apps/email-issuer/scripts/test/app-db-read-only.test.ts` |
| The app gate reads the API's D1 by the API gate's model (D233): a key in `app_keys` not revoked or still in its grace, an undeleted app, active only with no suspension bit; the legacy `apps.publishable_key` is never read (source check `apps/api/scripts/test/hot-db-reads.test.ts`, no allowlist) | `src/apps.ts`; `test/codes.test.ts` |
| Only the issuer computes `sub` (`@hana-id/email` `emailSub` over `normalizeEmail().email`, `+tag` kept, D159); mail goes to that normalized address, byte for byte | `src/handlers.ts` `handleStart`, `handleVerify`, `handleGoogleMatch` |
| Every token's nonce is computed by the issuer from the commitment with the pinned signer, so a token serves only its purpose (never a register proof or another app's client proof); the commitment's scope must be the app's | `src/commitment.ts`, `src/layouts.ts` (checked against `email_fixture.json`) |
| An `auto_link` token commits to the join read from the chain at minting (D133); it is minted only for Google-hosted case A with `link`, case B with a `linkTicket` bound to the same `sub` and this Google identity, or a case-A code challenge google-match prepared with Google's verified address (D195); never while `unrecorded_wallets` | `src/decide.ts` (the contract's `auto_link` rules), `handleGoogleMatch`, `handleVerify` |
| Every signature verifies against the published key before the token leaves; every token is an `email_issuance` row before it is signed | `src/jws.ts` `mintJws`, `handlers.ts` `mint` |
| Codes: 6 digits by rejection sampling; stored only as an HMAC; compared in constant time; 5 attempts and single use counted atomically in the challenge object; each check reserved in the mailbox limiter before the comparison (refused while locked, refunded on success), so parallel guesses can't outrun a lock (D198) | `src/keys.ts`, `src/challenge.ts`, `src/rate-limiter.ts` `reserveGuess` |
| Brute force is bounded per mailbox whatever the number of requesters: ≤ 25 failed checks per UTC day (18 open to anyone + an owner slot of 4 + a ticket slot of 3; ≈ 0.91% a year against a 6-digit code), ≤ 35 challenges a day; worst case W ≤ min(5·C, 25). Unlocks add at most 2 checks each (≤ 3 in 30 days): ≈ 9,199 a year, ≈ 9,273 in the worst case, ≈ 0.92%. A targeted owner without a device ticket is locked out at most until the UTC day ends (the accepted trade-off); one with a ticket keeps 3 codes a day and the ticket slot; the trip is logged, and staff can unlock (`admin/unlock`: ticket-referenced, audited first, 1 a day and 3 in 30 days per mailbox; mails a one-time grant to the address and clears nothing, so neither the asker nor an attacker gains anything) (D198) | `src/rate-limiter.ts` `reserveGuess`, `admit`, `trySend`, `issueGrant`; `test/limits.test.ts` (many requesters), `test/review.test.ts` (device tickets) |
| Mail volume: per mailbox (and per requester inside it), per recipient registrable domain (100 + 2 per distinct verified mailbox a day over 7 days, at most 2,000 a day, a verified challenge's places given back, at most 20% per requester prefix, listed consumer providers exempt, ticketed and unlock-grant starts not counted, so a few requesters can't lock a company's domain out), per app (plan `per_minute` and `per_day`), per IP and IP prefix (IPv4 /24, IPv6 /56 and /48: 200 starts a day each), and a global budget split into a staff pool (1%, ≥ 5) and a general pool, with an owner pool of 30% of the budget beside them (fresh tickets below its half and ≤ 20% of it per app; aged tickets and grants uncapped per app; refusals fall back to the app's general share), in which an app's share follows its plan (2% of `per_day`), with the last 20% only for apps under half their share; `dailySendBudget` required outside `local*`. The requester's limits are counted first, so refused mailboxes can't spend a partner's quota or the budget. **A valid device ticket or unlock grant never waits on the IP prefix limits, an app's quota, a recipient domain's cap or the general budget pool**; owner allowances are counted per address and per mailbox (3 / 9 mails, 10 / 30 challenges a day; the mailbox totals never block the untagged address or a grant); fresh tickets fill the owner pool only to half and 20% per app; a stock of 7-day-old sock-puppet tickets can still use it up for a day, at most 0.3 × the budget (the residuals, D198) | `handleStart`, `src/rate-limiter.ts` `reserveBudget`, `src/domain.ts`, `src/ip.ts` `ipAggregates`; `test/limits.test.ts`, `test/review.test.ts` |
| A request without a usable client address is refused (`400 missing_client_ip`, logged), never pooled into one bucket | `handlers.ts` `route`; `test/review.test.ts` |
| Enumeration: `start` answers the same 202 (or the same 429, always `retry-after: 900` for a mailbox-level refusal) for every valid address; a suppressed address takes the same limiter path, only the mail is skipped; an invalid device ticket is ignored | `handleStart`, `handleResend`, `tryLater`; `test/limits.test.ts` |
| No address, code, `sub`, token, device or link ticket, unlock or confirmation token, access token or key in any log line (typed fields only). The verified address is stored readably in one place, on purpose: the user directory (`user_emails`, D269), written after a successful `verify` and after google-match's and google-record's checks (best effort, never failing a login; its failure logs the app and scope only; a write that lands late never restores an older address, `email_verified`, `hosted` or scope: the newest `last_seen_ms` wins), read only by Hana staff through `admin user:list` / `user:find` (no route serves it; the CLI never puts the statement, which can hold the searched address, in a process argument: a 0600 file in `.secrets/tmp/` passed as `--file` for the local D1, D1's REST API with the operator's wrangler credentials for the remote one; wrangler's log file, metrics and error reports off; the rows go to the terminal only); partners never see it. A Google row with `email_verified = 0` is only that account's claim to the address (anyone can put any address on a Google account), so the CLI lists it apart under an UNVERIFIED warning, never as the owner. Accepted (D269): anyone can make google-record or google-match write rows for their own Google account and any active app, including apps it never logged in to (`Origin` is forgeable server to server); harmless to matching and linking, which read `email_hints` and never the directory, it affects only the accuracy of the staff view. No other table holds an address; a live challenge (≤ 10 min) holds it encrypted under the challengeId's secret half, which only the client holds (D197). SendGrid also keeps addresses (outside Hana's control): its activity feed for its retention period, and its suppression lists until an address is removed | `src/log.ts`, `src/directory.ts`, `src/challenge-id.ts`, `scripts/lib/d1.ts` `issuerD1Execute`, `PRIVATE_WRANGLER_ENV`, `scripts/lib/admin-users.ts`; `test/privacy.test.ts` greps every flow and checks the address is in `user_emails` and no other table; `test/directory-verify.test.ts`, `test/directory.test.ts` (both arrival orders); `scripts/test/d1-private.test.ts`, `scripts/test/admin-users.test.ts` |
| Suppressions per exact address (keyed by K_sup, from K_sub), limits per mailbox (address without `+tag`): a bounce on `victim+x@` never suppresses `victim@`. Only signed events of the issuer's own categories count; a bounce lapses after 30 days, a complaint stays until the address's holder confirms a staff `admin/unsuppress` from a mailed link (audited, capped); more than 5 complaints in 24 h is logged (D199) | `src/keys.ts` `suppressionKey`, `mailboxKey`; `src/webhook.ts`; `handleUnsuppress` |
| Webhook: headers (timestamp ≤ 10 min, signature shape) checked before the body is read; ECDSA P-256 over timestamp ‖ body with a key imported once; 120 per 10 min per IP | `src/webhook.ts`, `handleWebhook` |
| The Google access token is checked (tokeninfo aud/azp and sub = the ID token's; another account's token is `google_account_mismatch`), used for userinfo, never stored, logged or revoked (D265: revocation would end the user's whole grant to the client, and on the shared client other apps' too; the token is email-scope only and expires within the hour); tokens never in a URL. google-match per IP: 120 per 10 min (D267); google-record runs the same checks (`checkGoogleSignIn`), 120 per 10 min in a window of its own, and answers no match data (D270) | `src/google.ts`, `handleGoogleMatch`, `handleGoogleRecord` |
| CORS: `start`/`resend`/`verify` only from `authOrigin`, `google-match` and `google-record` only from `vaultOrigin`, no credentials. Staff routes only behind Cloudflare Access plus the staff allowlist (D88), JSON only, any `Origin` refused (with the Access cookie SameSite=Strict, no cross-site request reaches them), a support `ticket` in every audit row, the row written before the action; certs failures negatively cached 30 s (D199) | `handlers.ts` `route`, `staffGate`, `src/access.ts`; `test/adapters.test.ts` |
| Client proofs only for a scope read from `get_scope` now, at its current `action_nonce`, with an active email app | `handleClientProof`; `test/adapters.test.ts` |
| Case B: `verify` returns no `idToken` when a hinted Google identity has the wallet (no second wallet even if the popup misbehaves); a non-Google-hosted hint counts only within 180 days of that Google identity's last login with the address (older ones pruned), and its case B joins only after 24 h, with link notices (D119; the stale-account residual risk and the alternative in D199); a `linkTicket` binds the app, the `sub` and the hinted Google identities (D199) | `handleVerify`, `handleGoogleMatch`; `test/google-match.test.ts` |
| Each purpose's mail says what the code does (sign in, add this email, allow another sign-in method, remove one, link Google), so a code phished for one action doesn't read as a sign-in (D199) | `src/mail.ts`; `test/review.test.ts` |
| The issuer's token layouts are checked in the real contract: tokens minted by the issuer's code (session, auto_link case A and B, link_account) pass `hana-signer`'s unit tests | `scripts/gen-contract-fixture.ts`, `contracts/hana-signer/src/tests/email/issuer_tokens.rs` |

### Vault page (`apps/api/src/vault/page.ts`)

- Rendered from D1 only (no chain RPC). 403 for an unknown, suspended or conflicting app or more than 20 served
  origins; 503 if D1 fails; no config script on either, so the vault does nothing.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri
  'none'; form-action 'none'`, plus `frame-ancestors <app origins>` and `connect-src {apiUrl} {rpc} [{rpcFallback}]
  https://www.googleapis.com`; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`,
  `Cross-Origin-Resource-Policy: cross-origin`. Error pages send `frame-ancestors 'none'`.
- Config escaping: `<script type="application/json">` with `<`, `>`, `&`, U+2028, U+2029 escaped (`jsonForHtml`,
  `page.ts:42`); origins that aren't a bare lowercase origin are dropped before they reach the header or the config
  (`apps/api/src/vault/origins.ts:11`). `signer` is not in the config (the bundle's constant is used).
- Auth pages: `frame-ancestors 'none'`, page-specific `connect-src` (none at all for `/login`, which fetches nothing:
  D77), no COOP header (`apps/api/src/pages/host.ts`
  sets the headers; the build adds a `<meta>` CSP).
- Static assets on both Hana origins (`host.ts`, `staticAsset`): never HTML, and every one carries `default-src
  'none'; frame-ancestors 'none'; sandbox`, `nosniff`, `no-referrer` and a same-origin CORP, so an SVG or XML file in
  the build opened directly or framed runs and frames nothing.

### Browser (`packages/web`)

- The vault, login and export pages use only the pinned `SIGNER`, `RELAYER` and CKD key; any differing value stops
  the flow (`config_mismatch`).
- The vault computes the path from its own verified token and never uses a path, session or counter from the API; it
  re-syncs from NEAR RPC (the manifest `rpc`, or `rpcFallback` only when `rpc` fails; each read answered by one
  endpoint, `packages/web/src/near-call.ts`).
- Before relaying a login the vault checks its inlined `scopeId` against the registry with one view (D56,
  `packages/web/src/vault/login.ts` `checkScope`): own client `scope_for_client('google', aud) == scopeId`, shared
  client `get_scope(scopeId)` with `allow_shared` and the client one of `get_config().shared_clients` in force (the
  two views in parallel; D117, sweep VAUL-4). A mismatch or no answer refuses the login. Limit: the app→scope
  binding itself lives only in D1, so an API that substitutes another scope **and** that scope's own client passes
  the check (it then gets that scope's key for the user, still only in the user's own vault).
- Test apps (`pk_test_`) never sign for a mainnet (D39, `packages/core/src/networks.ts`): the Stellar public network,
  EVM chains outside the testnet allowlist (`TEST_EVM_CHAINS`), typed data whose domain names such a chain; refused
  before any popup or policy (4100 `mainnet_not_allowed`). Messages and chainless typed data name no network and
  pass. Raw requests are refused for test apps whatever `raw_sign` says (4100 `raw_not_allowed_for_test_apps`): a
  raw digest could be a mainnet transaction's hash. The partner client refuses switching to or sending on such a chain
  too (not a security boundary).
- PRK leaves memory after the app's idle limit without a request that uses the key (signing, export,
  revoke-other-devices, an auto-approve consent request; D55, `goIdle`). Status, address and auto-approve-status reads
  don't count and don't unlock a dormant session, so a page polling them can't keep the key in memory. Neither do key
  requests refused by a check that needs no key (another address, a malformed request, a mainnet for a test app, a
  second export, revoke-other-devices on a share that isn't fresh), nor an auto-approve consent request answered from
  a consent already in force (D112, sweep VAUL-1; `vault.ts` `refuseEarly`). A `'session'` record is unlocked again
  before the next request that uses the key, only for the same share. Residual: a hostile partner page can still
  keep PRK in memory with requests it can get signed (an accepted policy) or by reloading the vault frame, which
  unlocks a `'session'` record like any reload; the absolute expiry always holds.
- The vault refuses to run top-level, accepts one hello, pins the parent origin (checked against the inlined origins
  and `ancestorOrigins[0]`; every other `ancestorOrigins` entry must be an allowed origin too, sweep VAUL-6) and serves
  only that port. Where the browser has no `ancestorOrigins` (Firefox), nested framing is refused by the CSP
  `frame-ancestors` alone, which every current browser enforces for every ancestor. Popups and the vault authenticate each other by `event.origin` and
  `event.source`. The vault's first message, `connected` (no data), goes only on the port of the hello it took, after
  every one of those checks; a hello it refuses, and its 403/503 page (framed nowhere, no script), get no answer at
  all, so a page that frames it learns nothing from the handshake (D262). The SDK's one retry inserts the same frame
  (same name and `src`) after removing the first, closes the first's port and ignores its late events; a failed
handshake removes the frame and closes its port, as `destroy()` does.
- No message in any direction carries key bytes, S, PRK, a CKD response, a token or a session secret, except
  `relayKey` from the vault to its authenticated login popup (schemas: `packages/core/src/protocol.ts`).
- **The export window's key on screen and in the clipboard** (D268, `packages/web/src/auth/export-page.ts`
  `showReveal`, `clearClipboard`): after the typed `EXPORT`, "Show key" / "Hide key" toggles the key on screen
  (selectable only while shown; hidden again on window blur, a hidden tab and pagehide; taken off for good at the
  erase, D111), and "Copy key" writes it with `navigator.clipboard.writeText` inside the click, shown or not (a hidden
  key never enters the page). Both act only on trusted events (`isGesture`). No `execCommand('copy')` fallback: it
  would need the key in a hidden selected text field; without the Clipboard API the page says to copy by hand.
  **Accepted risk:** a copied key leaves Hana's control: clipboard history, synced clipboards, other apps and
  extensions can read it, until the user copies something else. The page tells the user so and tries to blank it
  (an empty `writeText`, never a read, so no permission prompt) 60 s after the last copy, at the erase and at pagehide,
  only while it has focus and only if it hasn't blanked it since. That works on Chromium; Firefox and Safari want a
  user gesture for each write and likely refuse it, and a closing page may not finish it anywhere.
- One display-safety rule (`packages/core/src/display-safe.ts`, D118, sweep AUTH-5/CORE-4 and AUTH-2): text with a
  control (other than tab and newlines in messages), format, bidi, private-use, separator or other default-ignorable
  code point (variation selectors and tag characters included) is shown as hex (messages, decoded strings) or
  refused (policy labels and names, app names in the vault config, `GET /v1/app` and every popup message). App
  names, origins and decoded values are also bidi-isolated in the popups' CSS. Check-mark look-alikes are stripped
  from partner contract names.
- The approval popup decodes every Stellar operation field by field (`packages/core/src/decode/stellar.ts`; no
  operation is shown as raw XDR only). Account-control operations (a `setOptions` signer, threshold or master-weight
  change, `accountMerge`) get a red banner at the top of the transaction and a warning per operation naming the new
  signer and weight, the thresholds, the master weight or the merge destination, in a style stronger than the
  routine `danger` notice (`render-approval.ts` `ACCOUNT_CONTROL_BANNER`, `accountControlWarnings`; D110, sweep
  finding CORE-1).
- Approval binds the whole request through `approvalDigest` (`packages/core/src/approval.ts:179`). Its network
  context is the passphrase or chain ID for transactions and auth entries, and empty for messages, typed data and raw
  requests (D35); the popup says those signatures aren't tied to one network. The launcher only opens the popup. A
  signing call from a click opens the popup from the partner page instead (D99); see "Approval popup opened by the
  partner page" below.
- The Approve guard (`packages/web/src/auth/approve-guard.ts`, D36): disabled until 1 s after render and 1 s after
  the window last gained focus or became visible, then an arming gesture: a mouse `pointermove` that moved (non-zero
  `movementX`/`Y`; or, as WebKit always reports 0, a client position other than that of the last pointer event in the
  same request and focus period, so a layout change or scroll under a still cursor never arms), a touch or
  pen `pointerdown`, or Tab/Shift+Tab/an arrow key (never Enter, Space or a repeated key). Approve acts only on a click
  whose own pointerdown or keydown came after the arming gesture, and the page never focuses it; a keyboard click
  also needs Approve to have held focus for 500 ms before its keydown (`KEYBOARD_DWELL_MS`, D113, sweep AUTH-3). So a
  double-click across the opening, clicking in place, a held Enter, "Tab, Tab, Enter" typed in one go and a request
  slipped in at a click never approve. Residual risk (accepted): tap-spam on a phone for more than 1 s after the popup
  tab opens can approve in two taps; a desktop user coached to Tab to Approve, pause and press Enter approves, as one
  coached to click Approve does.
- The vault's approval queue holds at most 100 requests (`4100 too_many_pending`), and refuses at once
  (`4100 invalid_request`) a request whose popup message the popup's own validator would drop, so nothing waits out
  the 5 min timeout unseen (`packages/web/src/vault/approvals.ts`). A popup that gets a new request while one is
  unanswered rejects the old one first.
- Session end: every use (sign, before and after approval and inside the auto-sign lock, status, accounts, export
  start and the export window's hello, share actions, revoke-all) checks `expiresAtMs` against the server-corrected
  clock and ends the session there, so a timer delayed by a throttled tab or a sleeping device never keeps PRK
  signing (`live()`, `packages/web/src/vault/vault.ts`).
- One session per app per device. A login revokes this tab's previous share and the share of the record it
  overwrites, and broadcasts `revoked {shareId}` for each; only tabs holding that share end.
- The share and record are made after the login reply (D79, `packages/web/src/vault/vault.ts` `persistLogin`), and
  can never outlive the session they are for: a session that ends first (logout, a newer login, expiry, idle, a
  revocation) marks the job cancelled in the same turn that zeroes PRK; the job then writes no record (checked before
  sealing, under the per-app lock before the write, and again after it, taking the record back), and revokes a share
  made for it. Logout doesn't wait; it revokes the record's share if the job won the lock first. Share- and
  record-bound steps (revoke-other-devices, touch, consent reads and writes) wait for the job, so a consent is never
  written to a memory copy the new record then drops. If the job gives up (share creation tried twice, or IndexedDB),
  the session stays in memory with `persistence: 'none'` (event `persistenceChanged`), and the older session's record it replaced is deleted and
  its share revoked, so a reload never unlocks a session older than the newest login. Logged: a reason code only. Logout, under the per-app
  lock, revokes this tab's share and the stored record's (with that record's session key) if it is another session's,
  deletes the record and broadcasts `logout`, which ends every tab of the app. A stale tab's 410 ends only that tab.
- The partner client broadcasts an approved `eth_sendTransaction` on the chain it was filled and signed for, one at
  a time per chain, with a filled nonce never below one past its last broadcast.
- The IndexedDB record is AES-GCM with an AAD over signer, app, path, session key, derivation version, CKD key hash,
  parent origin and expiry (`recordAad`, `packages/core/src/layouts.ts:143`); records, Web Lock and BroadcastChannel
  are per app.
- Time checks use a server-corrected clock (`serverTimeMs`) that never goes back (`packages/web/src/vault/runtime.ts`
  `Clock`, sweep VAUL-2): a device clock set back, or an older server time, holds it until real time catches up, so
  idle limits, expiries, consents and the policy re-read can't be stretched; and the daily auto-approve counters keep
  a later day's usage when the clock says an earlier day (`usageToday`), so a backwards step never resets the caps.
  Not done: a cap on how far one server answer may move the clock forward (an API that lies is already a total
  compromise; a forward step only ends things early).

### Email login in the popup and the vault (build plan batches 8a and 8b)

- **The vault checks the email token itself, against the chain** (`packages/core/src/email-token.ts`, called from
  `vault/login.ts`): the issuer's exact JWS JSON form (no whitespace, unknown or duplicate member, no unprotected
  header, ≤ 7168 bytes, 1–3 signatures with distinct kids, each header exactly `{alg: RS256, kid}`), RS256 with an
  active key from `get_issuer_keys("email")`, each kid under a signer of `get_self_issued("email")` with at least
  `required` signers, `iss` equal to the bundle's pinned `emailIss` (manifest `emailIssuer.iss`), `aud` exactly
  `email:<scopeId>`, the pending login's nonce, `exp`/`iat` within 60 s skew, exactly the issuer's claims (no
  address), `sub` 1–255 bytes without `#`. Its keys come from its own RPC, never the API or the issuer's JWKS; a kid
  the chain doesn't list refuses the login ("try again later"). It also requires `scope_for_client("email",
  "email:<scopeId>")` to be its scope (the email side of D56). The path then comes from `get_identity` (below); the
  pairing check against the pinned CKD key still guards the result.
- **Email is accepted only where it was offered**: a JWS JSON token in a login whose auth-params didn't offer email
  (a Google-only app, an env without `emailIssuer`) is `token_invalid`; the `email_*` relay errors (D245) count only
  in such a login, and are Google's answer otherwise. So are the follow-up fields of the relay payload
  (`accessToken`, `access`, `caseB`, `as`): refused in a login that didn't offer email.
- **The path is the contract's, read on the vault's own RPC** (batch 7, D249 superseded): `get_identity` of the
  signed-in identity, its `key` checked against the identity key the vault computes (`packages/core/src/links.ts`
  `pathIdentity`); own → its own path, active member → its account root's, pending → refused (`link_pending`), a
  root of a provider without a path here → refused (`root_unsupported`). The pairing check proves only that a CKD
  answer is the key of the path the vault asked about: a lying RPC that named another identity's path (a forged
  member view) and knew that path's secret could forge an answer that passes it. So any path that isn't the signed-in
  identity's own is confirmed first on `rpc` and `rpcFallback`, each read alone: both must agree on the view's status,
  root and key, and show the root as an account root (`own`, its computed key); a provider down or missing refuses
  (`path_unconfirmed`), a disagreement too (`path_disputed`), never a fallback to the own path (D263,
  `packages/web/src/path-check.ts`). The export window resolves its path the same way (its CSP must list both
providers; a linked member's export on both is e2e-tested, `apps/e2e/tests/linking.spec.ts`). A pairing failure re-reads the
  session and the identity once, and decrypts only for the path both name (a link that activated between the read and
  the transaction), confirmed on both providers when it is a root's. **Root pins**: the vault remembers, per
  identity and app on this device (memory, and IndexedDB beside the record when the app keeps the wallet; identity
  keys only, no `sub`; it outlives logouts), the root it last derived; a root that changed other than by a link
  activating (own → member) is confirmed on both providers again, or refused. A pin read that fails or doesn't answer
  within 1 s (`PIN_READ_TIMEOUT_MS`, a stuck IndexedDB) fails closed: a path that isn't the identity's own is
  confirmed on both providers again, as on a pin mismatch, or refused; the own path goes on (the pairing check covers
  it). **Privacy**: on a shared device the pins (an identity-key hash per scope, the root it opened)
  outlive logout, so the next user of that browser profile can tell which identity keys signed in to that app there,
  and whether they are linked; they hold no `sub`, address or key.
- **Email logins of real scopes (D248 lifted for scopes whose Google logins write hints).** Every Google login of an
  app with email goes to google-match first, which writes the `email_hints` row for its Google-verified address; so an
  email login of an address with a Google wallet reaches case B (no token, "Link and continue" or "Sign in with
  Google") instead of a second wallet. Residual: a Google wallet opened *before* its app turned email on has no hint
  until its owner's next Google login there; until then an email login of that address opens its own wallet. So turn
  email on for a scope with existing Google users only after its users' Google logins have run google-match, or accept
  that window (`docs/operations.md` "Turning linking on (batch 8b)", `docs/mainnet-readiness.md` row 7.1g).

### Automatic linking in the vault and the popup (build plan batch 8b)

- **D133, before the linked CKD payload is signed** (`vault/login.ts` `judgeLink`): fresh reads of
  `get_config().unrecorded_wallets` (links only when exactly `false`), and `get_identity` / `get_account` of both
  identities on the vault's own RPC; `judgeAutoLink` (the contract's `auto_link` order) gives the join, the target
  root and epoch; the join must be the case's (1 for A, 2 for B); the link token must verify against the chain's email
  keys and signer policy with exactly the `auto_link` nonce for that join, this session's nonce preimage, and the mode
  the issuer said. Any mismatch refuses before anything is relayed. Only then does the session key sign
  `"hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode ‖ pk1 ‖ ":" ‖ pk2`. The API re-checks (D232); the contract decides.
- **D139, case B only after this popup's own email step**: the vault signs `join = 2` only when the first relay slot
  carries `caseB {linkTicket, emailSub}`, which only `/login/email` writes, after `verify` answered a ticket and the
  address's `sub` (the user typed that address's code in this popup), and the link token's `sub` is that `emailSub`. A
  case-B token at a plain Google login (no `caseB`), or for another `sub`, is `token_invalid`. **Case A** is signed
  only when google-match minted it for a Google-hosted address (`googleHosted`, immediate), or when it is the answer to
  this popup's `link_code` screen (the code step's own `auto_link` token): a case-A token google-match answers for an
  address Google doesn't host is refused as the issuer's error. Both "Google-hosted" and which email identity matched
  are the issuer's word: a compromised issuer can join a new Google user to an email wallet it controls (D266, the
  "Email issuer" row of "Parties").
- **D137, a linked session never derives plainly**: a linked login resends only "not executed" answers and takes a
  known transaction's key; everything else after a possible publish revokes the session (`revoke_session` at
  `used + 1`) and ends the login (`derive_failed`, `link_restart`): the next login has a fresh session key, Google
  token and link token (D257). A resynced own-path session whose identity joined an account meanwhile is refused by
  the contract (D136) and ends `session_consumed` (sign in again).
- **No second wallet when google-match can't answer** (D255): a Google identity with no wallet and no account
  (`get_identity`: own, not opened, its key checked; `get_account`: no members) is refused (`email_match_unavailable`),
  since it might be case A; an identity that has a wallet or an account logs in as before. A `429` or `503` is
  retried within the login first (D265). Declined consent or another Google account picked on Google's screen gets
  the popup's consent screen instead ("Sign in with email instead", "Try Google again"), then `login_cancelled`
  with `email_consent_declined` / `google_account_mismatch` (D264). A popup that can't store its next leg writes
  `storage_unavailable` to the slot the vault waits on, so the vault stops at once.
- **Google's verified email stays off chain and off the partner page** (D25, D254, D270): the ID token that goes on
  chain is always from an openid-only request; the access token for the `email` scope rides in an encrypted
  follow-up slot to the vault, and goes only to the issuer's google-match (CORS `vaultOrigin`) or google-record,
  which never log or revoke it (D265; it expires within the hour). The vault never sees the address; it relays only
  case A's masked hint (`a…@domain`) to the popup. The vault page's CSP adds only the issuer's origin. Under the
  fallback `'second_request'` the access token comes from a second request after the openid login, and before
  Google's interactive email prompt the popup says what it is for (D264).
- **Under `'token_first'`** (D270, in force since the spike passed on 2026-11-04; `packages/web/src/auth/google.ts`;
  every leg on real Google for a Gmail, a Workspace and an outside-address account: the ID tokens carried exactly the
  openid claim set, Workspace's `hd` only in userinfo, `docs/context.md`): the email is asked on
  Google's first screen with `response_type=token` only, so no ID token of that request exists to relay; the ID token
  that goes on chain comes from a second, `scope=openid` request (`googleAuthUrl` builds no other ID token request,
  tested for every flow). The callback reads the access token's `sub` from Google's tokeninfo (a POST body; its CSP
  lists `oauth2.googleapis.com` for the callback page only, in an env with an email issuer, in both the header and
  the `<meta>` policy). tokeninfo's answer includes the address: the popup, on Hana's auth origin, parses it in
  memory and keeps only `sub` (and checks `aud`, `azp`, `expires_in`); nothing of it is relayed, stored or logged
  (D269, accepted). In an app with email login the callback ends the login on another client's token, no answer or
  another account's ID token, never asking without the hint (D255). Every ID token the callback relays is checked
  against the claim allow-list first: one with `email`, `hd` or any other claim is never relayed (`token_has_pii`),
  and the vault and the API refuse it too, so a Google change locks logins out, never leaks the address on chain. An
  app without email login sends the access token only to google-record (the directory, D269), in the background and
  only after `/v1/login` has succeeded, so a refused or cancelled login is never recorded; a failure never touches the
  login. There tokeninfo is not needed: when it can't answer or refuses the token, the popup drops the access token
  (nothing in slot 1) and makes batch B's openid request with the account chooser and the login's nonce, and the
  login goes on with nothing recorded; another client's token still ends it.
- **The follow-up channel** (D256): the popup and the vault talk after Google's answer through relay slots derived
  from `followKey` (32 random bytes, in auth-params only for an app with email, stored in the popup's
  `sessionStorage` entry beside `relayKey` and zeroed after use), every value AES-GCM under `relayKey` with its slot's
  AAD. The API accepts the vault's relay writes; a writer without `relayKey` can only fill a slot with garbage (refused,
  `token_invalid`) or block it, never forge a notice or an answer. A notice the popup shows is display-only text built
  with `textContent`; a banner's action is a proof the vault checks itself (the `link_change` nonce it computed, the
  signed-in identity's `sub`).
- **Banners' Cancel and Remove** (D259): a fresh sign-in of this login's own method over a `link_change` nonce with a
  fresh salt and the account's current epoch, relayed by the API's `/v1/link/cancel` / `/unlink` (which revoke the
  account's shares, D233). Cancel is offered to any active identity of the account, Remove only to its root.
- **`hana.linkAccount`**: two fresh sign-ins (the new method over `link_new`, the account root over `link_account`,
  one salt and the epoch the vault read), the new identity checked to have no wallet and no account before the second;
  pending for `change_delay_ms` on chain.
- **`/login/email` reaches only the issuer and the API** (CSP `connect-src {issuer origin} {api}`; the auth Worker's
  `EMAIL_ISSUER_URL`, `packages/web/src/auth/pages.ts`); `/login` stays fetch-free (D77). The address goes only to
  the issuer's `start`, the code only to `verify`; neither is stored or logged. The token is held only until
  encrypted under `relayKey`, which is taken (single use) at that moment. The email context in `sessionStorage`
  (`hana.email.<relayId>`, 10 min) holds public facts and the `challengeId` (spec: kept in the popup), and the
  partner's `emailHint` only until `/login/email` loads (then in memory only); never the relay key, a typed address,
  a code or a token. A step that can't go on tells the vault at once (`email_unavailable`), and the page stops at the
  vault's deadline, so no relay key outlives the login.
- **Device tickets on `authOrigin`**: `localStorage` `hana.dt.<b64url(sha256(trimmed lowercased address))>`, at
  most 5, 30 days. A ticket only lets its owner's code mail past the shared limits (D198); it can't sign anyone in.
  Residual: anyone with script on `authOrigin` (or the device) can read them, and the hash of a guessable address can
  be confirmed by guessing.
- **The progress message** (`hana:auth-progress`, `email_code`) carries nothing; the vault takes it only from the
  window whose hello it answered, on `authOrigin`, in a login that offered email.
- **Key export of an email wallet** (D246 lifted by batch 8b, D258): the export window re-authenticates with
  Google or with a new email code over its own session (purpose `session`, `max_uses = 1`), checks an email token
  against the chain exactly as the vault does, and resolves the path through `get_identity`; a pending identity
  exports nothing (`link_pending`), and the key is shown only if it is the vault session's address.
- **Enumeration**: the popup shows one generic "Too many attempts. Try again later." for every limit and says
  nothing about whether an address has a wallet; case B's screen appears only after the user proved the address with
  its code.

### The login popup trusts the vault's app facts

`/login` (D77) gets the app's name, parent origin, scope and Google client from `hana:auth-params` and makes no API
call. What its own `GET /v1/app` used to give, and why that is not needed:

- **Against a forged message**: nothing. The popup accepts `auth-params` only from `vaultOrigin` (or `/export` on its
  own origin) and only from the exact window of its opener mode (`opener.frames[v]` whose parent is the opener, or the
  opener itself); `vaultOrigin` serves only Hana's vault bundle (D66). These checks are unchanged.
- **Against a compromised vault origin or API**: nothing. Code on `vaultOrigin` already holds every key of every user
  who loads it, and the popup's read went to the same API Worker that renders the vault page and answers the vault's
  own `GET /v1/app` (the spec said so: "not a defence against a compromised Worker").
- **Against a stale vault config** (an app suspended, an origin removed, a Google client changed since the vault
  page loaded): an earlier error, before Google instead of after. `POST /v1/login` still refuses every such case
  before relaying anything: the app gate reads the current D1 row (status, key, `x-hana-parent-origin`), the API
  checks the token's client against the app's scope (`checkClientScope`), the contract checks the scope again, and
  the vault checks its scope against the registry (D56). The token Google issued in between is openid-only, bound by
  its nonce to a session key that never reached the chain, and relayed end to end encrypted to the user's own vault.
- **The name shown**: the vault's inlined config (read from D1 on the vault page's load) instead of the API's
  current one; a rename shows after the partner page reloads.

What the popup still checks on its own: the pinned `SIGNER`, the nonce recomputed over the message's session
(signer, scope, session key, expiry, key index, max uses, salt), the message schema, and that it is not framed. With
no API call its CSP has no `connect-src` at all.

### Approval popup opened by the partner page

A signing call made in a user's click opens `{authOrigin}/approve?from=partner&v=<vault frame>` from the partner page,
in that click (D99, `packages/web/src/client/approval-window.ts`), as login opens `/login`. The vault's launcher opens
it only as the fallback. So the partner page, and any script on it, holds a WindowProxy to the real approval popup.

- **What users trust is the popup's address bar.** The window is a top-level popup whose address bar shows
  `authOrigin`. That is the only thing that tells a user a window is Hana's; the window's position, size or how it
  opened never did.
- **What the handle allows.** A cross-origin WindowProxy exposes only `location` (set, to navigate), `close()`,
  `focus()`, `blur()`, `closed`, `frames`, `length`, `opener`, `parent`, `top` and `postMessage`. The page can't read
  the popup, move or resize it, or click in it. It can:
  - navigate it to a page of its own that imitates Hana: the address bar then shows the partner's origin, and the
    imitation can't post as `authOrigin`, so the vault never takes an answer from it. A malicious page could already
    open its own fake popup at any time; holding this handle adds nothing to that. The request in the vault waits
    until the window closes or 5 min pass (4001), as when a user walks away;
  - close it: the vault sees the window closed and rejects the request on show (4001), as when the user closes it;
  - focus or blur it: each focus and blur resets the Approve guard (D36), so this can only delay an approval;
  - post messages to it: the popup takes none (below).
- **The popup accepts nothing from the partner page.** It accepts requests, consent screens and `hana:approve-close`
  only from the authenticated vault: `event.origin === vaultOrigin` and `event.source === opener.frames[v]` whose
  parent is the opener, exactly the login popup's partner-mode check; it posts only to that frame, with
  `targetOrigin = vaultOrigin`, never to the partner page. A request the partner page posts is neither shown nor
  answered (`packages/web/test/auth/approve-page.test.ts`, `apps/e2e/tests/approve-in-click.spec.ts`). A page can
  only name a frame it embeds, and a vault frame answers only the origins of its own app (`frame-ancestors`, the
  parent-origin pin), so a page can't steer the popup to another app's vault.
- **The vault accepts only Hana's popup.** It adopts a popup only on a hello from `authOrigin` whose window's opener
  is the vault's parent (the partner page itself), as for a partner-mode login popup, and posts to it with
  `targetOrigin = authOrigin`, so a popup navigated elsewhere receives nothing. Once adopted, results are accepted
  only from that window, with the digest check unchanged.
- **Nothing else changes.** The digest binding, the Approve guard (1 s after render, 1 s after focus, an arming
  gesture that never approves, D36), the queue limit and the 15 s reuse are the same for both kinds of popup. The
  click that opened the popup can't approve in it: the guard needs 1 s and a new gesture inside the window.
- **Auto-approved and refused requests.** The popup opens before the vault has decided, so for a request the vault
  signs under the user's accepted policy, or refuses, it is told to close (`hana:approve-close`); it shows nothing for
  its first 0.6 s and nothing to approve at any time, since only the vault's requests render an Approve button. A
  popup no request reaches closes itself after 8 s.
- **COOP.** Unchanged and the same as for `/login`: the auth pages send no `Cross-Origin-Opener-Policy` header, so
  the popup keeps its opener; the partner page must not use COOP `same-origin` (`same-origin-allow-popups` is fine).
  A severed popup reaches no vault and shows an error; the SDK sees its handle closed and leaves the request to the
  launcher.

## Auto-approve policies

Code: `packages/core/src/policy/` (validator, matcher, `policyId`, usage); the vault enforces them
(`packages/web/src/vault/vault.ts`, `auto-approve.ts`).

- **Off by default, two opt-ins.** An app owner sets a policy (D1; set or change is pending until
  `auto_approve_effective_at`, 24 h, or `changeDelayMs` in dev envs; removal is immediate in D1). Each user then
  accepts that exact `policyId` in a Hana consent screen; any change to the policy changes the id and needs a new
  consent.
- **Removal in an open tab.** The vault page inlines the policy at load; `GET /v1/app` also returns the policy in
  force. An open vault auto-signs only under a policy that a `GET /v1/app` confirmed less than 10 s ago
  (`POLICY_FRESH_MS`, D62), re-reading it first when the last check is older (also every 60 s in the background). A
  removed or changed policy, or a failed re-read, sends the request to the popup. So a removal stops auto-signing in
  every open tab within 10 s, plus the API's own read of D1 (no isolate cache on that read). A changed policy counts
  as none until a reload. Raw signing is re-read the same way before every raw request (`GET /v1/app` `rawSign`):
  `'off'` refuses raw requests in every open tab within 10 s, and a failed re-read refuses too (fails closed, D68).
- **Never covered**: `hana_signRaw`, `personal_sign`, `stellar_signMessage` (`NEVER_AUTO_APPROVED_KINDS`), EVM
  contract creation, fee-bump and v0 Stellar envelopes, Stellar classic operations other than a listed `changeTrust`,
  contract creation or upload host functions, anything that fails to decode. Stellar account-control operations
  (`stellarAccountControl`, `packages/core/src/decode/stellar.ts`: a `setOptions` that adds, re-weights or removes a
  signer, changes a threshold or the master weight, and `accountMerge`) are refused first, before any other check,
  as `account_control`, and the validator refuses a Stellar section that names classic operations (D110).
- **Validator** (`validateAutoApprovePolicy`, `validate.ts:459`): strict JSON, unknown keys refused at every level,
  `perDayCount` 1..500, `maxConsentMs` ≤ the app's `session_ttl_ms`, safe label and names, selector must equal the
  signature's, `addressArgs` required on an EVM function that takes an address, decoder ids must be shipped (none in
  batch B), and an EVM chain's `maxValueWei` may not be below its `maxFeeWei` (value plus fees counts against it, so
  such a rule could never auto-approve at its fee cap; D69). `addressArgs: 'any'` is refused on value-moving names
  (`isValueMovingFunctionName`, `validate.ts:112`) and execute/multicall-style names (`isExecutionStyleFunctionName`,
  `validate.ts:117`) on both chains. An EVM function with an opaque argument (`policy/opaque.ts`: `bytes`, `string`,
  `bytes20`–`bytes32`, `uint160`/`int160`, at any depth of arrays and tuples) is refused under either rule
  (`validate.ts:359`): it needs a protocol decoder.
- **Matcher** (`matchAutoApprovePolicy`, `match.ts:95`), every check must pass:
  - Opaque arguments are refused under either rule, on every request (defence in depth on EVM, the only check on
    Stellar, where a policy names functions without argument types): Soroban `Bytes`/`BytesN`/`String` at any depth
    of `Vec`/`Map` (`match.ts:165`), ABI values as above (`match.ts:393`), EIP-712 fields of those types.
  - Address rule `'self-or-listed'`: every typed address at any depth (Soroban invocation tree including auth
    entries, ABI-decoded calldata, EIP-712 structs) is the user, a listed contract or a policy `addresses` entry.
    `'any'` skips only this check.
  - Stellar: passphrase listed; fee ≤ `maxFeeStroops`; tx and op sources are the user; footprint operations only on
    listed contracts' data.
  - EVM (`matchEvmTx`, `match.ts:355`): chain listed; `to` and selector listed; calldata decodes against the listed
    signature; max fee (`gasLimit × maxFeePerGas`, or `gasLimit × gasPrice`) ≤ `maxFeeWei` (`fee_too_high`); `value` ≤
    `maxValueWei` (`value_too_high`); `value + max fee` ≤ `maxValueWei` (`value_plus_fee_too_high`); today's
    auto-signed spend + `value + max fee` ≤ `maxValueWeiPerDay` (`daily_value_exceeded`). The recorded spend is `value
    + max fee` (`usage.ts`), an upper bound on what the transaction can take from the native balance.
  - EIP-712: `(verifyingContract, primaryType)` listed for a listed chain.
  - Every match counts against `perDayCount` (UTC day, per device).
- **Consent** ends at `min(grantedAt + maxConsentMs, session expiry)`, logout, `hana_revokeAutoApprove` or "Stop
  auto-approving"; counters live inside the encrypted record.
- **Contract names on the consent screen (D44).** Each policy contract shows "✓ {verified name}" when `(chain,
  address)` is on Hana's verified list (`packages/core/src/verified-contracts.ts`: EVM by `chainId` and address
  compared lowercase, Stellar by passphrase and exact contract ID, and for Stellar on every listed passphrase);
  otherwise "{partner name} · named by {app}". A partner name whose skeleton (NFKC, accents dropped, case folded,
  Cyrillic/Greek/digit look-alikes folded, punctuation removed: `nameSkeleton`) equals a verified name, or contains a
  verified protocol's name, on a contract that isn't that entry is flagged inline ("— not the verified …", "— not a
  verified {protocol} contract") and with a warning at the top (`nameCollision`, `render-consent.ts`). Check marks are
  stripped from partner names, so only Hana's mark shows one. Every contract shows its short address (full one in the
  title) and an explorer link from the same pinned table (none for an unknown chain). The list is built into the popup
  bundle and never read from D1 or the API, so a D1 or API compromise can't verify a contract; an entry is added in a
  code release only after Hana confirms the address from the protocol's official sources, recorded in the entry
  (`test/verified-contracts.test.ts` requires sources, well-formed and unique addresses;
  `packages/sodax/test/verified-contracts.test.ts` checks the Sodax entries against the pinned `@sodax/types`).
  Everything is rendered with `textContent` (`dom.ts`). A verified mark says which contract it is, not that the listed
  functions or limits are safe.
- **Residual risk (accepted):** signatures the partner page received under a consent stay usable after it ends or is
  stopped (a transaction until its time bounds, a Soroban authorization until its `signatureExpirationLedger`, typed
  data until its own deadline); the consent screen says so (D116, sweep CORE-3), and a ledger cap on auto-approved
  authorizations waits for a trusted current-ledger source. Within a policy, partner-page XSS can submit allowed
  calls at bad prices to the user's own address; token amounts other than native value aren't capped (D46); names of contracts not on the verified list
  are partner-supplied, labelled "named by {app}" (D44), and a look-alike outside the skeleton's folding (a
  misspelling, another script's look-alikes) isn't flagged; Sodax calls carry intents in opaque bytes and always get
  the popup until a `sodax-intent-v1` decoder exists (D24). Under `'any'`, a value-moving or execute-style function
  with another name (`withdraw(to,…)`, `claim`, `bridge`, `swap(…, recipient)`) can't be recognised by name, and its
  typed addresses aren't checked; only partner-listed contracts and functions are ever auto-approved, and the consent
  screen warns about every `'any'`. A contract that casts a `uint256` (or a Soroban `u256`) argument to an address
  isn't caught: only exactly 160-bit integers are treated as opaque, so that wider integers stay usable as amounts.

## Security sweep of 2026-10-29: core, web, SDK, demo and smoke findings

The sweep of `develop` @ 91609c4 (`security-sweep-hana-id-2026-10-29.md`, kept outside the repo). Status of the
findings in `packages/core`, `packages/web`, `packages/react`, `packages/sodax`, `apps/demo` and `apps/smoke`, on
branch `fix/sweep-web` (re-verified against `feat/governance` first). The API, scripts, env, contract and watchdog
findings are tracked with their own fixes.

| Finding | Status |
|---|---|
| CORE-1 (Medium) Stellar account-control operations shown as raw XDR | **Fixed** (D110): every operation decoded; red banner and per-operation warning for signer, threshold and master-weight changes and `accountMerge`; never auto-approved |
| AUTH-1 (Medium, with VAUL-5) export window keeps the key with no timeout | **Fixed** (D111): erased 5 min after deriving, at the session's end, or when the vault frame goes away |
| VAUL-1 refused key requests refresh the idle limit | **Fixed** (D112) |
| AUTH-2 app names unfiltered; AUTH-5/CORE-4 filters miss code points | **Fixed** (D118); the admin CLI's write-time check is OPER-11 (scripts) |
| AUTH-3 Tab, Tab, Enter approves | **Fixed** (D113): a keyboard Approve needs 500 ms of focus |
| AUTH-4 auto-translation on the approve and export pages | **Fixed**: `translate="no"` and `notranslate` on every auth page and the key |
| AUTH-6 revealed key in an `aria-live` region | **Fixed** (D111) |
| AUTH-7 export re-auth relies on Google honouring `max_age=0` | **Accepted** (D27), unchanged: with a live Google session one click in the chooser re-authenticates; the 5 min key lifetime (D111) bounds what an unattended window exposes |
| CORE-2 4+4 address display and narrow name-collision check | **Open**: deferred (consent-screen layout and its tests; no signing impact) |
| CORE-3 auto-approved signatures outlive the consent | **Partly fixed** (D116): said on the consent screen; the ledger cap waits for a trusted current-ledger source (API side) |
| CORE-5 looser EIP-712 hasher exported | **Fixed** (D114) |
| CORE-6 base64 decoders accept non-canonical input | **Open**: deferred (no caller depends on uniqueness; a stricter decoder risks breaking stored values) |
| CORE-8 CKD scalar and copies can't be zeroed | **Partly fixed**: the random bytes are zeroed; bigints and noble's copies can't be |
| PART-1 vault frame stays visible after the port dies | **Fixed**: the frame is hidden and `launcher {visible: false}` emitted; the guide says to sandbox third-party iframes |
| PART-2 `eth_sendTransaction` returns the RPC's hash unchecked | **Open**: deferred; the broadcast RPC is documented as trusted for liveness and ordering, and must be https for live apps (D115) |
| PART-3 plaintext http RPC URLs | **Fixed** (D115) |
| PART-4 Sodax EVM adapter switches the shared chain | **Open**: deferred (needs a send queue or chain restore in the adapter, and a chain name on the approval screen) |
| PART-5 `HanaClient` constructor public | **Fixed** (D114) |
| PART-6 `eth_sendRawTransaction` listed as read-only | **Fixed** |
| VAUL-2 clock can go backwards; counters reset | **Fixed** (monotonic clock; usage kept on a backwards day) |
| VAUL-3 consent counters can be rolled back from an old record | **Accepted**: needs write access to the browser profile (the device-compromise model) |
| VAUL-4 shared-mode check doesn't confirm a shared client | **Fixed** (D117) |
| VAUL-6 `ancestorOrigins` beyond the parent unchecked | **Fixed** |
| OPER-10 `spike.html` puts the `error` fragment into `innerHTML` | **Fixed**: state checked first, `textContent` only |

## Known open issues

Status: **fixed** (a), (b), (c), (d), (f); **fixed on sandbox-dev** (e) (the governance contract and watchdog run there
since 2026-10-30; mainnet ships with them once its delay, council and watchdog account are set up: D80, D81, D86);
**accepted** (k), and the residual risks named under (b)–(d) and
"Auto-approve policies"; **fixed for the CLI** (i); **open** (g), (h), (j) (sandbox-dev only; production envs
need D38's two domains), (l) (pre-mainnet: the identity token's KMS signer; the JWKS pin check is built as detection only, D210). The 2026-10-29 security sweep's items in the API, tooling and CI: "Security sweep
2026-10-29" below.

**(a) Unlock and touch don't re-check the app's current settings. Fixed.** Unlock and touch now read the app's
settings: `persistence = 'none'` revokes the share (`410 share_revoked`), and the share ends at `min(abs_expires_at,
created_at + current session_ttl_ms)` (`410 share_expired`, stored expiry lowered); the counter `UPDATE` applies both
rules in the same statement, so a change made after the first read still holds (`apps/api/src/vault/endpoints.ts`
`settingsRefusal`, `shares.ts` `advanceShare`; tests in `apps/api/test/vault.test.ts` "unlock and touch follow the
app's current settings"). As found:
- An app switched to `persistence = 'none'` keeps unlocking existing shares until each expires (up to 23 h 50 min).
  Only share creation checks `persistence` (`endpoints.ts:194`).
- `abs_expires_at` is fixed at creation (`endpoints.ts:216`); a lowered `session_ttl_ms` doesn't shorten live
  shares. `idle_until` does follow the current `idle_ttl_ms` on each slide (`apps/api/src/vault/shares.ts:104`), but
  stays capped by the old `abs_expires_at`.

**(b) EVM max fee isn't counted in the value limits.** Fixed (D37). Besides the per-transaction fee cap
(`fee_too_high`), the matcher counts `value + max fee` against `maxValueWei` (`value_plus_fee_too_high`) and against
`maxValueWeiPerDay`, and records `value + max fee` as the day's spend (`packages/core/src/policy/match.ts:405`,
`usage.ts`). Fees can no longer be burnt on top of `maxValueWeiPerDay`. What remains: the recorded spend is the
maximum fee, not the fee actually paid, so the daily limit is conservative; and a policy whose `maxValueWei` is below
the fees its calls pay (`"0"` included) never auto-approves an EVM transaction; the validator refuses `maxValueWei <
maxFeeWei` (`validate.ts`, D69), and the consent screen labels the limits "Maximum value plus network fees".

**(c) The `addressArgs: 'any'` denylist is weak.** Fixed as far as a validator can (D37). `'any'` is now also refused
on EVM functions with an opaque argument (`multicall(bytes[])`, `execute(address,uint256,bytes)`,
`aggregate((address,bytes)[])`, routers with a `bytes` path) and on execute/multicall/aggregate/delegatecall/call/
batch/invoke/relay/upgrade-style names on both chains (`isExecutionStyleFunctionName`, `validate.ts:117`); such
functions need a protocol decoder. Because a Stellar policy names functions without argument types, the matcher
refuses Soroban `Bytes`/`BytesN`/`String` arguments under `'any'` as under `'self-or-listed'` (`match.ts:165`), and on
EVM it refuses opaque values under `'any'` too, as defence in depth (`match.ts:393`). Residual risk (accepted, see
"Auto-approve policies"): a value-moving or execute-style function under a name the lists don't cover
(`withdraw(to,…)`, `redeem`, `claim`, `bridge`, `swap(…, recipient)`) still passes with `'any'`, and its typed address
arguments are not checked; only partner-listed contracts are ever auto-approved, and the consent screen warns about
each `'any'`.

**(d) 160-bit integers aren't treated as opaque under `'self-or-listed'`.** Fixed (D37, D63).
`isOpaqueToAddressRule` and `isOpaqueAbiValue` (`packages/core/src/policy/opaque.ts`) treat any integer exactly 160
bits wide (`uint160`, `int160`) as opaque, at any depth, in calldata (validator and matcher) and in EIP-712 fields.
Soroban has no 160-bit integer type, so the Soroban check is unchanged. Wider integers (`uint256` and the like) stay
allowed as amounts. Residual risk: a contract that casts a `uint256` (or a Soroban `u256`) argument to an address
isn't caught. Side effect: Permit2 typed data (`PermitDetails.amount` is `uint160`) and calls with a `uint160`
argument (Uniswap v3 `sqrtPriceLimitX96`) can no longer be auto-approved; they need a decoder.

Other issues and doubts found while verifying:

**(e) Issuer keys are a hot path to every user's key. Fixed by the governance contract (D33, D80–D86): built, and
deployed on sandbox-dev 2026-10-30 (migration, council DAO owner, watchdog, forged-key and pause drills); mainnet ships
with it. The text below is the original analysis.** `KEYS_UPDATER_KEY` is a
Worker secret that can call `set_issuer_key` (`apps/api/src/issuer-keys.ts`), and the owner account can too. Either
can add an RSA key, mint a "Google" token for any `sub`, and derive any user's key in any scope. The contract
account's full-access key can upgrade the contract (no lock). `docs/contract-interface.md` already calls the owner and
contract account total control; the point here is that one of those powers sits in the API Worker's secrets. Confirmed
plan (D33; built, and deployed on sandbox-dev 2026-10-30), specified in `docs/governance-spec.md` and confirmed by the user on 2026-10-29 (D80–D86):

- Delays (D80): a newly posted issuer key waits `issuer_key_delay_ms` (mainnet 2 h, provisional until Google's lead
  time is measured with `admin issuer-keys:lead-times`); upgrades, owner transfer and surplus withdrawals wait
  `governance_delay_ms` (mainnet 72 h). Emergencies are handled by pause, not short delays. Outside dev envs
  `deploy-contract` refuses an issuer-key delay below the security bound 3·(W + T) = 18 min (below it a stolen updater
  key proposes and executes a forged key before the watchdog's first run) and a governance delay below 24 h (mainnet
  72 h). sandbox-dev's 2 min / 60 s deliberately violate them for fast drills (D80) and warn.
- Owner (D81): a Sputnik DAO v2 council, 2-of-3 for every proposal kind; on mainnet the two founders' Ledgers and an
  offline backup key neither founder can reach alone. The DAO's code hash alone doesn't prove that: `deploy-contract`
  checks its `get_policy` against the manifest's council before an owner transfer and on every run once the DAO owns
  the contract, and the watchdog alerts critical on any later change of the owner DAO's policy or code (a
  `ChangePolicy`, `AddMember` or `RemoveMember`).
- Watchdog (D82, D86): its own service, key and Cloudflare account. It cancels a pending key Google doesn't publish,
  deletes the updater key that proposed one (not when it is Google's own material from the last 24 h, a retirement race:
  D153), and pauses only when such a key is active on chain; everything else is
  alert-only. The owner unpauses at once. Pause stops derivation and every token path, never governance. Built in
  `apps/watchdog`, deployed on sandbox-dev 2026-10-30. Pause stops derivation only for as long as it lasts:
  sessions a forged key opened before the pause would derive again after it (up to 24 h, any `max_uses`), so the
  runbook raises the owner's session floor (`set_sessions_valid_from_ms`) past the pause before unpausing, which
  retires every older session. Scope changes proposed with a forged key's owner tokens or client proofs can't be
  cancelled by OIDC owners while paused, so each unpause gives every pending change a full `change_delay_ms` again
  (`changes_unlock_floor_ms`) before anyone may execute it. *Review follow-ups (branch `gov/followups`):* a key change
  waits `governance_delay_ms` while no watchdog **may confirm** yet, not only while there is none, so a compromised
  owner adding its own fresh watchdog to an empty list gains nothing for `governance_delay_ms`; a watchdog can delete
  only updater keys whose `AddKey` the contract saw succeed (`pending_updater_keys` until then), so it can never delete a
  key that was already on the account with another permission (e.g. a full-access key); the watchdog cancels any change
  the updater proposes for a provider other than Google (the updater only serves Google) and deletes the updater keys;
  it re-reads the chain when its cancel finds the change gone and pages `protective_action_failed` if the forged change
  was executed instead (then pauses in the same run); it alerts critical on the owner's immediate `remove_issuer_key`
  and `set_issuer` (no pending state to see); and every on-chain string in an alert (kid, provider, proposer) goes
  through an allow-list or an escaped form, with header-safe titles and Slack-escaped text, so a hostile kid can't
  break a page, inject headers or `<!channel>`.
- Watchdog and the email issuer (email login, `docs/email-login-spec.md` "Watchdog", D190–D193; batch 5,
  deployed on sandbox-dev 2026-11-02, where the v2 contract has no email issuer yet): self-issued keys have no outside JWKS, so the watchdog trusts only the pins in
  its own manifest (`watchdog.pinnedIssuerKeys.email`, set on its own account: a pin change is the operator's
  redeploy, outside Hana's main account). A pending email key whose RFC 7638 thumbprint isn't pinned for its signer
  (or whose kid isn't that thumbprint) is cancelled; an active one pauses and deletes every updater key, also at the
  first run; it never confirms an email key (the contract refuses too). No pins means nothing is pinned, never "not
  checked" (D190); unreadable pins page `pins_invalid`, and unhashable on-chain key material fails closed.
  `get_issuer("email")` / `get_self_issued("email")` against the pins (D191): a **weaker** policy pauses with a
  critical alert: a lower `required`, an unpinned signer, active keys with no policy, or an overlap with the previous
  policy longer than the contract's 10 minutes plus one run (a `migrate` setting a long overlap to a weaker previous
  policy would otherwise keep, say, 1-of-1 tokens valid indefinitely; `get_self_issued` shows only the overlap's end,
  not the previous policy, so its length is what the watchdog can judge). An email issuer nobody pinned is critical
  without a pause. Differences a planned change passes through and that aren't weaker (a pinned signer not in the
  policy yet, the `set_issuer` → `mark_self_issued` gap, a higher `required` on chain, a normal-length overlap) are a
  warning, and every overlap is reported. So a compromised owner DAO can't install its own email key, and an upgrade
  weakening the policy is paused on as it executes (it was already public and alerted for `governance_delay_ms`).
  Hana's published email JWKS is compared with the pins as a warning only (Hana controls it), and is read only after
  every protective step, the alert delivery, the heartbeat, the run record and the lock release, with its body
  capped: Hana's API can't stall the watchdog's cancel or pause, or hold its lock (D86). Every third-party answer
  the watchdog parses (RPC, both JWKS) is size-capped. The **use of Hana's real key** by a compromised issuer isn't
  prevented on chain at 1-of-1. Takeovers by linking are counted there (D200): the watchdog reads `get_link_stats()`
  with the chain each run (current and previous hour, so nothing falls between runs) and pages
  `link_threshold_reached`; half the total threshold warns, a threshold raise is a critical governance change. These
  are alarms, not limits: the links went through. Logins into email-rooted wallets, or Google wallets that already
  have an email member, need no link and aren't seen; custody is their defence (D121). No third party is involved (the FastNear indexer scan of D192 is gone). A v2 contract
  reads as "no email issuer", and as "no link stats".
- Watchdog and the partner identity token (D210–D214; branch `feat/identity-token-8`, not deployed): Hana's identity
  JWKS is served by Hana's Cloudflare account, so the watchdog pins the keys' RFC 7638 thumbprints in its own manifest
  block (`watchdog.pinnedIdentityKeys`, a redeploy on its own account to change; no pins = nothing pinned) and reads
  the JWKS and the discovery document every run, after every protective step, with bodies capped and no redirect
  followed. Each key is judged by its material, never its kid, and only the public members are allowed. Unpinned keys,
  private members, a wrong `issuer` or `jwks_uri`, and any answer that can't be judged (a redirect, padding, not JSON,
  duplicate members, the wrong shape, 3 failed fetches) are critical, so content can't be shaped to downgrade a
  finding; nothing is paused (partners verify the token; the contract never holds or accepts an identity key: it
  stores RSA keys only). The schema refuses a manifest that publishes an unpinned key, and `identity-key` pins with
  `next` and unpins with `retire`, so a retired, possibly leaked key can't be republished silently.
  **Detection against a non-cloaking attacker only.** Whoever controls Hana's Cloudflare account can recognise the
  watchdog's fetches (Cloudflare's network, the watchdog's Worker) and serve them a clean JWKS while partners get
  another, or publish a key between two runs. A scheduled GitHub Actions probe (`scripts/identity-probe.ts`, every
  15 min, same rules, no secrets) reads from outside Cloudflare like a partner's `jose` verifier, which narrows the
  first; neither stops an attacker who singles out partners' traffic or times the key. Residual: partners that trust
  the JWKS URL can accept a forged key without Hana being alerted. Partner-side thumbprint pinning
  (`docs/integration.md`, the recommended default for anything of value) is the only prevention.
- Monitoring (D83): every watchdog check, action and alert surfaces in the admin portal's "Security & monitoring"
  view (a standing rule for future checks); the watchdog sends its own alerts, so a compromised Hana Cloudflare
  account can't silence them.
- Alerts (D85): critical (paging app + Slack + email to both founders, re-sent every 15 min until acknowledged),
  warning (Slack + email), info (portal + daily digest). Every upgrade proposal is critical; no independent upgrade
  guardian at launch (D84).
- Signer full-access key: removed on staging and mainnet (mainnet: deleted in the creation batch); kept on sandbox-dev
  for speed (D86). Mainnet upgrades need a reproducible build with its hash published first (D86).
- Lead-time measurement (running): the API records when each Google kid first appears in the JWKS (every 15 min),
  when a token signed with it first arrives, and when it leaves the JWKS (D1 `issuer_key_observations`, migration
  0004, `apps/api/src/key-observations.ts`; kids and timestamps only); `admin <env> issuer-keys:lead-times --remote`
  prints the lead times (`docs/operations.md` "Issuer key lead times"). It changes nothing the contract trusts.

**(f) The API serves a stored auto-approve policy unvalidated. Fixed.** `effectiveSettings` serves a stored policy
only if `parseAutoApprovePolicy` accepts it against the app's `session_ttl_ms`, and logs `auto_approve_policy_invalid`
otherwise (`apps/api/src/vault/settings.ts`); `admin app:settings` validates before writing. As found: at 14e6fc3,
`effectiveSettings` only checked that the policy was a JSON object and the vault page inlined it. A bare D1 write can
still set a policy without the pending delay (see "What a compromise gives", D1); the vault validates again
(`validateAutoApprovePolicy`, `packages/web/src/vault/config.ts`), and the user must accept the `policyId`.

**(g) Replays across isolates still reach the chain. Open.** The counter hold is per isolate (`session-use.ts:76`);
copies of one signed request arriving in different isolates are all relayed and all but one fail on chain (~2.2 Tgas
each). Known (`docs/context.md`).

**(h) Allowlists are wider than the API's use. Open.** The session pool allows `prune_sessions`, and the owner pool
`register_scope` and `apply_pending_config`, but no endpoint relays them. Harmless (the Worker refuses them), but a
leaked key can call them directly within its allowance.

**(i) The 20-origin cap is enforced only by the vault page. Fixed for the CLI (batch C3).** `admin app:create` and
`app:origins:add` refuse more than 20 active-or-pending origins per app (`MAX_APP_ORIGINS`, `@hana-id/console-core`);
`AdminRpc.addOrigins` applies the same cap (batch C5; the member path, `changeOrigins`, comes with C6). A direct D1 write can still exceed it; the vault page then answers
403 `too_many_origins` (availability, not safety).

**(j) sandbox-dev's two Hana origins are one site. Open (sandbox-dev only; outside dev envs the schema refuses a
same-site pair).** `hana-id-vault-sandbox-dev.tingtc.workers.dev` and `hana-id-auth-sandbox-dev.tingtc.workers.dev`
share the registrable domain `tingtc.workers.dev`; the schema allows this only in dev envs
(`packages/env/src/schema.ts:117`). Production envs must use two registrable domains (D38). Why: Chrome/Edge and
Firefox desktop always put different sites in different processes, so a renderer bug triggered by content the auth
popup shows (transactions, messages, app names) can't reach the vault's PRK. Not guaranteed on Chrome Android (partial
Site Isolation, ≥ 2 GB RAM) or WebKit (Safari, every iOS browser), where the vault iframe may also share a process
with the partner page; there, short unlock windows and zeroing PRK are the mitigation.

**(k) The approval digest binds no network for messages, typed data and raw requests. Accepted** by the user
(2026-10-28, `docs/decisions.md` D35): `contextString` is `''` for those kinds (`approval.ts` header,
`approvalContextString`). Typed data carries its chain in its domain; messages and raw requests name no network, and
the approve popup now says "This signature isn't tied to one network." on them.

**(l) Identity token: testnet signing key. Open (pre-mainnet).** Build steps 1–4 sign with
a Worker-secret P-256 key (`IDENTITY_SIGNING_KEY`): anyone who can read the API Worker's secrets once can forge any
user's identity at every partner until the key is removed from the JWKS. Step 7's code is built (branch
`feat/identity-token-7`, D215–D219): the AWS KMS signer, the manifest's `aws-kms` signer and the `identity-key kms-*`
commands, tested against a fake KMS. Still open before mainnet: the AWS account's keys, IAM user and policies,
CloudTrail and alarms, and the hourly reconciliation of `Sign` events against `identity_issuance_hourly` (not built;
`docs/operations.md` "Identity token keys on AWS KMS"). A KMS credential still lets its holder forge tokens until it is
revoked; KMS makes the key unexportable and every signature visible, not misuse impossible. `gen` and the schema
already refuse a Worker-secret key outside testnet. Step 8 is built (branch `feat/identity-token-8`, D210–D214): the
watchdog pages critical for an unpinned or private key in the JWKS and a wrong discovery `issuer` or `jwks_uri`, an
answer it can't judge, and an identity key's thumbprint as an issuer kid on chain; it never pauses for them (the chain
isn't involved), and an outside probe from GitHub Actions applies the same rules every 15 min. Both detect, neither
prevents, and only an attacker who serves everyone the same JWKS: one who controls Hana's Cloudflare account can cloak a
key from both or publish it between reads, and partners that trust the JWKS URL accept it until it is removed (≤ 10 min
of cache after). Partner-side thumbprint pinning is the recommended default for anything of value
(`docs/integration.md`). Until the KMS signer runs in production partners must not use identity tokens for anything
of value. The testnet standby is kept off the Worker, and `identity-key next / switch /
retire` rotate or replace keys (D177; playbook `identity-signing-key-compromised`). Also accepted for now: in an app that keeps logins, a browser that can't
store the session (no share) gets `identity_unavailable` (`data.reason: 'no_share'`): the share check is what makes a
logout or a revocation stop new tokens, and a missing share can't be told from a revoked and pruned one.

### Security sweep 2026-10-29: API, operator tooling and CI

The sweep of develop @ 91609c4 (report kept outside the repo) found 63 issues; those in `apps/api`, `scripts/`,
`packages/env`, `envs/`, the secret scan and CI were re-checked against `feat/governance` and handled on branch
`fix/sweep-api` (D100). The other areas (contract, vault, auth popups, core, SDK) are tracked separately.

Fixed:
- **OPER-1 (High)**: the pinned CKD network key came from the one RPC it is meant to protect against. Now read from ≥ 3
  independent providers at one final block, all agreeing, with the block recorded (`ckdNetworkKeySource`); https RPC
  and API URLs outside `local*` envs; `/envs/` under CODEOWNERS. sandbox-dev's key was re-read this way: unchanged.
- **APIW-1 (Medium)**: the per-app relay quota was spent before any check. Counted only before the relay now.
- **APIW-3 (Medium)**: one global owner-action cap let any invited owner starve `cancel_change`. Caps per owner,
  scope and global, `cancel_change` on windows of its own (see "Owner actions" above for the remaining limit).
- **OPER-2 (Medium)**: gitleaks caught none of this repo's secret shapes. Custom rules plus a self-test on fakes.
- **OPER-3 (Low)**: CODEOWNERS widened (D100), with the second owner `@mj-hana` on every owned path (2026-10-30);
  "Require review from Code Owners" on `develop` and `main` is still to do (a GitHub setting, not in the repo).
- **APIW-4, APIV-3, APIV-7, OPER-5, OPER-6, OPER-11 (Low/Info)**: as in D100. APIV-5: a "KEK compromised" runbook
  (`docs/operations.md` "`VAULT_KEK`"). Relay errors no longer echo RPC or fetch error text (sweep question 14).

Deferred, with the reason:
- **APIW-2** (cron reconciles issuer keys by kid only): needs a per-kid n‖e fingerprint view on the contract; the
  governance watchdog already checks proposed keys' n/e against Google's JWKS.
- **APIW-5** (dropped-tx detection may resend an executed call): changes the relayer's nonce/outcome logic; needs a
  runtime test against a lagging RPC first. Cost: wasted gas, a burned `max_uses = 1` login.
- **APIW-6** (export limit keyed on a client-chosen `keyIndex`, browsers only): a D59 change (per user, all
  origins); cost and availability only.
- **APIW-7** (D1 reads before any limit): needs a new Rate Limiting binding namespace ahead of the app lookup.
- **APIV-1** (re-created share after prune gets around revoke-all freshness): needs a `session_pk` tombstone
  (migration) or binding to the session's creation time. Availability only.
- **APIV-2** (vault app quota spent before the signature check): needs the share endpoints reordered around the
  per-location bindings; same shape as APIW-1, next.
- **APIV-4, APIV-8, APIV-9** (relay writer capability, relay polls before the key check, share-action check order):
  APIV-4 needs a client protocol change in `packages/web`; the others are cheap reorderings left for the vault pass.
- **APIW-8, APIW-9, APIV-6** (PII flag default, updater block hash, share partner origin on the server): small; next
  API pass.
- **(h) wide relayer allowlists**: narrowing changes the on-chain key permissions, which makes `deploy-contract`
  block until every relayer key is deleted and re-added; folded into batch B's allowlist step.
- **OPER-4, OPER-7, OPER-8, OPER-9** (publish workflow environment, deploy wasm hash and extra full-access keys,
  near-sandbox checksum, dependency scanning): CI and deploy hardening that needs GitHub settings or new tooling;
  before mainnet.
- **`owner_action_nonce` recompute** (APIW-3's second recommendation): needs a borsh port of `Change`; the caps
  confine a wrong-nonce flood to its owner's own windows.
- **OPER-5's doc pipelines** (`node -e require(...)` in `docs/operations.md` "Create an environment"): still print a
  key fragment on a malformed file; replace with a script.

Open questions in `docs/batch-b-spec.md` that bear on security: Q22 (a timelock for new origins in shared mode) is
decided for batch C (D32, D34: 24 h delay, notice, cancel) and built in batch C3 (merged, not deployed on sandbox-dev):
`admin app:origins:add` is a staff proposal that waits `appChangeDelayMs` (≥ 24 h on a production network; see
"Admin CLI writes" above), and the CLI refuses remote proposals until the API reports the 0006 reads (`hotDb` ≥ 6),
so a pre-C3 API never sees a proposed origin as in force; Q15 (production domains) is decided only as far as two registrable domains (D38). Decided on 2026-10-28
(`docs/decisions.md`): Q7 (D56, registry check at login), Q9 (D65, `rpcFallback`), Q14 (D53, `max_uses = 1`), Q16
(D54, KEK in `.secrets`, KMS later), Q18 (D59, export limits), Q27 (D39, test apps refuse mainnets), Q28 (D55,
in-memory idle limit), Q39 (D46, no token caps), Q40 (D45, consent without a fresh sign-in), Q41 (D44, verified
contract names, built).
