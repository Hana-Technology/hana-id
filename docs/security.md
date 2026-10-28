# Security model

Who is trusted for what, every key and secret, the invariants and where each is enforced, auto-approve rules, and
known open issues. Last verified against code: 2026-10-28 (commit 14e6fc3, `feat/batch-b`); browser parts
(`packages/web`) re-verified 2026-10-28 on `fix/b-web` (from `feat/batch-b` 0f0a437).

Component map and flows: `docs/architecture.md`. On-chain layouts and the contract's own security notes:
`docs/contract-interface.md` ("Security notes (for reviewers)"). Browser parts (vault, auth pages, partner client)
are in `packages/web` on `feat/batch-b`; what is still marked **(per spec)** below was not re-checked against it.

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
| API Worker logic and D1 (not the pages, not the secrets) | Gating and relaying; holding shares | Deny service; with `VAULT_KEK` plus a device dump, get PRK; point a vault at another scope of the same user (Q7); set or widen `raw_sign`/policies (the user still approves raw requests and must accept a new `policyId`); make the vault page frameable by another origin (D1 origins) | Substitute the signer, path or CKD key (pinned in the bundles, path computed in the vault); read or swap the relayed token (end-to-end encrypted); sign without the vault |
| Partner (app owner) | Its own app config and, in own-client mode, its Google client | Own-client mode: obtain tokens with any nonce for its client and derive its own users' keys in its scope (inherent: Hana can't see Google client settings). Set an auto-approve policy (delayed; users must accept it) | Anything in another scope. In shared mode: derive keys (no token with a nonce of its choosing) |
| Partner page (incl. XSS, malicious dependency) | Nothing | Start a login (visible popup), read addresses, queue signature requests, drive an unlocked vault within its idle/absolute limits, get requests signed that match an accepted auto-approve policy | Read keys, tokens, nonces; get any other signature without a guarded Approve in a Hana popup |
| User's browser and device | Running Hana's pages; keeping the profile private | Malware or an extension in all frames: everything the user can do, including reading an exported key. A disk dump with a live share: unlock and get PRK | After logout, idle or absolute expiry or revoke: nothing. A derive (the persisted session is used up) |
| NEAR RPC (manifest `rpc`) | Liveness, honest views | Fail derives, report wrong counters, delay | Forge a CKD result (pairing check against the pinned key) |
| Anyone watching the chain or mempool | Nothing | Read used tokens (openid-only claims via the API), replay `create_session` with them (the vault derives with the next counter), replay a whole combined call (burns a `max_uses = 1` login: `session_consumed`; attacker pays gas) | Derive for themselves (needs the session key; the answer is encrypted to `a`) |
| Another website | Nothing | Embed a vault with its own `pk` and log users into its own scope (legitimate) | Frame the vault for app X (`frame-ancestors`), receive `auth-params`, inject a token (per spec) |

## What a compromise gives

| Compromised | Effect | Limits |
|---|---|---|
| One session-pool relayer key | Burn its allowance (≤ 2 NEAR default); relay session methods | Receiver and method list fixed on chain; every method still needs a token or session signature. DoS only |
| An owner-pool key | Burn ≤ 0.5 NEAR; relay owner methods | Every owner method needs an owner proof on chain; logins unaffected |
| `KEYS_UPDATER_KEY` (Worker secret, function-call key on the signer account) | `set_issuer_key` with an attacker RSA key → mint Google tokens for any `sub` → **derive any user's key** | Visible on chain (`issuer_key_set` events); the hourly cron would not remove a forged kid until it has been missing from Google's JWKS for ≥ 55 min. Open issue (e) |
| Owner account key | Same as above, plus config (shared clients after the delay, sponsors, change-delay increase, `set_owner`) | Can't shorten the timelock at once, can't touch registered clients |
| Signer account full-access key | Redeploy the contract: anything, including MPC requests for any path | No upgrade lock in batch A/A.2/B. Open issue (e) |
| D1 | App origins (→ `frame-ancestors`, parent-origin checks), app scope, settings incl. bare writes of `raw_sign`/policy without the pending delay, suspensions; `share_enc` rows | `K_s` needs `VAULT_KEK`; a policy needs the user's consent to its `policyId`; raw requests still need approval |
| `VAULT_KEK` | Unwrap every `K_s` in D1 | Useless without a device's IndexedDB record (PRK is encrypted under `K_s` only on the device) |
| API Worker code or all Worker secrets, or the Cloudflare account | Everything: it serves the vault page and (per `b/pages-hosting`) the bundles, and holds `KEYS_UPDATER_KEY` | Single trust root. Mitigations: small vault bundle, strict CSP, no third-party script, narrow `frame-ancestors` |
| `vaultOrigin` | Every key of every user that loads it (PRK in memory) | — |
| `authOrigin` | Tokens of logins it handles; approve anything it shows; export keys | Must still go through the vault for PRK (export does its own login) |
| Partner origin | As "Partner page" above | Bounded by approval and the accepted policy |
| A partner's Google client (own-client mode) | Tokens with chosen nonces for that scope → that scope's users' keys | Other scopes |
| Hana's shared Google client or its Cloud project | Break isolation of every `allow_shared` scope | Own-client-only scopes |
| Leaked in-memory PRK | Every v1 chain and account under that `key_index` | Other `key_index` values; rotation is the only remedy |

## Key and secret inventory

| Key / secret | Type | Lives in | Held by | Lifetime and rotation |
|---|---|---|---|---|
| CKD master secret | BLS12-381, threshold-shared | MPC nodes (TEEs) | NEAR MPC network | Not Hana's. A new network changes every address |
| CKD network public key | BLS12-381 G2, public | manifest `ckdNetworkKey`; build constant of vault/login/export bundles | public | Pinned with `scripts/fetch-ckd-key.ts`; never read at runtime by the pages |
| S (CKD secret) | 48-byte G1 point | Browser memory only | vault / export window | Zeroed by `extractPrk` (`packages/core/src/derivation.ts:46`) |
| PRK | 32 bytes | Vault memory; IndexedDB record as AES-GCM under `K_s` | vault | Zeroed at `expiresAtMs` (by a timer, and on the first use past it if the timer is late), logout (any tab of the app), a `revoked` broadcast for its share, a newer login. Rotation: new `key_index` |
| Chain keys (Stellar seed, EVM `d`) | ed25519 seed, secp256k1 scalar | Derived per signature, zeroed in `finally` (`withChainKey`, `derivation.ts:98`) | vault; export window shows one on request | Same as PRK |
| BLS app key `a` | BLS12-381 scalar | Memory, one login | vault / export window | Dropped after decrypt (`packages/core/src/ckd.ts:84`) |
| Session key | Ed25519, non-extractable WebCrypto | Vault memory; IndexedDB record in `'session'` mode | vault | ≤ the session (≤ 23 h 50 min app setting, ≤ 24 h on chain) |
| `K_s` | 32-byte AES-GCM key per share | D1 only as `share_enc` under `VAULT_KEK`; vault memory briefly | API generates, vault uses | Ends with the share (idle ≤ `idle_ttl_ms`, absolute ≤ `session_ttl_ms`, revoke) |
| `VAULT_KEK`, `VAULT_KEK_PREVIOUS` | AES-256-GCM, `<id>:<base64>` | Worker secrets | Hana | Rotate: old value → `VAULT_KEK_PREVIOUS`, new id in `VAULT_KEK`; unlocks and the hourly cron re-wrap (`apps/api/src/vault/kek.ts`, `vault/cron.ts`) |
| `relayKey`, `relayReadKey` | 32-byte AES-GCM key / read capability | Vault memory; `relayKey` also in the login popup's `sessionStorage` (per spec) | vault, login popup | One login; slot lives 120 s |
| Session-pool keys `RELAYER_KEYS` | ed25519 function-call keys on `relayer`, receiver `signer` | Worker secret; `.secrets/<env>/relayer-keys.json` | Hana | Default 3 × 2 NEAR. `deploy-contract` deletes and re-adds; mainnet needs allowance monitoring |
| Owner-pool keys `OWNER_RELAYER_KEYS` | same, owner methods | Worker secret; `.secrets/<env>/owner-relayer-keys.json` | Hana | Default 1 × 0.5 NEAR |
| `KEYS_UPDATER_KEY` | ed25519 function-call key on `signer` (`set_issuer_key`, `remove_issuer_key`) | Worker secret; `.secrets/<env>/keys-updater.json` | Hana | Default 1 NEAR allowance; see open issue (e) |
| Owner, signer, relayer account keys | ed25519 full-access (not ml-dsa-65: `docs/decisions.md`) | `~/.near-credentials/testnet/` on the operator's machine | the user (Hana admin) | Manual. Agents never ask for or handle them |
| Google ID tokens | RS256 JWT | Transient; public on chain once used | user's browser, relay (ciphertext), API (in transit) | Never logged or stored; openid-only claims |
| Google RSA public keys | JWKS | On chain (issuers); API isolate cache (≤ 6 h stale on fetch failure) | public | Hourly cron sync |
| Console owner-action tokens | RS256 JWT (console audience) | Transient; `sha256` marker in a `RateLimiter` until `exp` | partner owner | Single use (nonce bound to `action_nonce`) |
| Publishable keys | `pk_test_` / `pk_live_` + base58 | D1, partner pages | public | Not secrets |
| Cloudflare account / `wrangler login` | account credentials | operator's machine | the user | Deploys the Worker: a trust root |

Rule (CLAUDE.md): derived keys, CKD secrets, relayer keys, owner keys and Google tokens are never logged, printed,
written outside `.secrets/` (gitignored, 0600) or committed; a gitleaks pre-commit hook blocks secrets.

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

### API (`apps/api`)

- **Verify before relay.** Nothing reaches the chain unless the off-chain checks pass: RS256 + claims + recomputed
  nonce (`/v1/sessions`, `/v1/login`), scope check (`handlers.ts:370`), `session_key_in_use`, session signature,
  session-use precheck mirroring the contract's counter and `max_uses` rules (`session-use.ts:29`), BLS key shape.
  The scope is always the app's D1 `scope_id`, never the client's.
- **Replay precheck.** A cached session view never refuses on its own: it is re-read fresh first. A second request
  for the same `(session key, counter)` in the same isolate waits for the first (`session-use.ts:76`).
- **Claim allow-list** `{iss, azp, aud, sub, iat, exp, nonce, nbf, jti, auth_time}` (`apps/api/src/claims.ts:8`):
  always on `/v1/login`; on `/v1/sessions` only with `REJECT_PII_ON_SESSIONS = "1"` (off today).
- **Relayer allowlists** per pool in the Worker and in the object; gas only from `gas.ts`; receiver always
  `SIGNER_ACCOUNT`.
- **Owner actions**: OIDC auth only, console audience, a current owner of the scope, change exists / unlocked, client
  proof matches; the token is reserved single-use before relaying and released only if the tx certainly didn't
  execute; global caps 20/min, 200/day (`handlers.ts:382`, `owner-actions.ts:31`).
- **Origin rules** (`apps/api/src/origins.ts:81`): a Hana page (`Origin` = `VAULT_ORIGIN`/`AUTH_ORIGIN`) may call only
  its endpoints, and only for an `x-hana-parent-origin` the app allows. Partner origins: `GET /v1/app` always; the
  session endpoints only for `pk_test_` in dev envs. Loopback origins and `http://localhost:*` only for `pk_test_` in
  dev envs. A `pk_test_` app on a scope a `pk_live_` app uses is refused (`scope_conflict`, `apps/api/src/apps.ts:29`).
  These checks bind browsers only (a script can send any `Origin`); they never replace a token or signature.
- **CORS**: app endpoints echo only an allowed origin; preflight allows the Hana origins and origins of active apps
  (`origins.ts:105`); vault endpoints only `VAULT_ORIGIN`; the relay only the Hana origins; `/v1/owner-actions` and
  `/v1/health` are `*`.
- **Vault shares**: every lookup is `share_id AND app_id`; one share per session key; a share needs a live, used-up
  session in the app's scope; counter moves by one atomic `UPDATE`; a share whose partner origin was removed is
  revoked on next use; `revoke-all` needs a share < 5 min old; `K_s` is wrapped with AAD `share_id ‖ app_id ‖
  session_pk`, so a row can't be moved to another share, app or key.
- **Login relay**: only `authOrigin` writes, only Hana origins read; write once (409), read once with the read key
  (403 without, slot untouched); 120 s then tombstone; ≤ 8 KiB; ciphertext only.
- **Rate limits** (fixed windows, `rate-limiter.ts`; IPv6 keyed by /64, `ip.ts`):

  | Window | Limit |
  |---|---|
  | Relay endpoints per IP per app | plan `per_ip_minute` (free: 20/min) |
  | Relay endpoints per app | plan `per_minute` / `per_day` (free: 60 / 5000) |
  | `GET /v1/app` per IP per app | plan `per_ip_minute`, its own window |
  | Vault endpoints | 60/min per IP per app; 10 × `per_minute` per app; 10/min per share |
  | Login relay per IP | writes 10/min, reads 120/min |
  | Owner actions | 10/min per IP; 20/min and 200/day globally |

- **Bodies and logs**: body caps (`readJson` streams and stops at the cap; vault 4 KiB, relay 8 KiB). Logs never carry
  tokens, `K_s`, `share_enc`, ciphertexts, signatures, relay bodies, keys or CKD responses.

### Vault page (`apps/api/src/vault/page.ts`)

- Rendered from D1 only (no chain RPC). 403 for an unknown, suspended or conflicting app or more than 20 served
  origins; 503 if D1 fails; no config script on either, so the vault does nothing.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri
  'none'; form-action 'none'`, plus `frame-ancestors <app origins>` and `connect-src {apiUrl} {rpc}
  https://www.googleapis.com`; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`,
  `Cross-Origin-Resource-Policy: cross-origin`. Error pages send `frame-ancestors 'none'`.
- Config escaping: `<script type="application/json">` with `<`, `>`, `&`, U+2028, U+2029 escaped (`jsonForHtml`,
  `page.ts:42`); origins that aren't a bare lowercase origin are dropped before they reach the header or the config
  (`apps/api/src/vault/origins.ts:11`). `signer` is not in the config (the bundle's constant is used).
- Auth pages: `frame-ancestors 'none'`, page-specific `connect-src`, no COOP header. `packages/web` builds them
  with a `<meta>` CSP (`scripts/build-auth-pages.ts`) and the auth Worker sends the headers
  (`apps/api/src/pages/host.ts`).

### Browser (`packages/web`)

- The vault, login and export pages use only the pinned `SIGNER`, `RELAYER` and CKD key; any differing value stops
  the flow (`config_mismatch`).
- The vault computes the path from its own verified token and never uses a path, session or counter from the API; it
  re-syncs from NEAR RPC.
- The vault refuses to run top-level, accepts one hello, pins the parent origin (checked against the inlined origins
  and `ancestorOrigins`) and serves only that port. Popups and the vault authenticate each other by `event.origin` and
  `event.source`.
- No message in any direction carries key bytes, S, PRK, a CKD response, a token or a session secret, except
  `relayKey` from the vault to its authenticated login popup (schemas: `packages/core/src/protocol.ts`).
- Approval binds the whole request through `approvalDigest` (`packages/core/src/approval.ts:179`). Its network
  context is the passphrase or chain ID for transactions and auth entries, and empty for messages, typed data and raw
  requests (D33); the popup says those signatures aren't tied to one network. The launcher only opens the popup.
- The Approve guard (`packages/web/src/auth/approve-guard.ts`, D34): disabled until 1 s after render and 1 s after
  the window last gained focus or became visible, then an arming gesture: a mouse `pointermove` that moved, a touch or
  pen `pointerdown`, or Tab/Shift+Tab/an arrow key (never Enter, Space or a repeated key). Approve acts only on a click
  whose own pointerdown or keydown came after the arming gesture, and the page never focuses it. So a double-click
  across the opening, clicking in place, a held Enter and a request slipped in at a click never approve. Residual
  risk (accepted): tap-spam on a phone for more than 1 s after the popup tab opens can approve in two taps.
- The vault's approval queue holds at most 100 requests (`4100 too_many_pending`), and refuses at once
  (`4100 invalid_request`) a request whose popup message the popup's own validator would drop, so nothing waits out
  the 5 min timeout unseen (`packages/web/src/vault/approvals.ts`). A popup that gets a new request while one is
  unanswered rejects the old one first.
- Session end: every use (sign, before and after approval and inside the auto-sign lock, status, accounts, export
  start and the export window's hello, share actions, revoke-all) checks `expiresAtMs` against the server-corrected
  clock and ends the session there, so a timer delayed by a throttled tab or a sleeping device never keeps PRK
  signing (`live()`, `packages/web/src/vault/vault.ts`).
- One session per app per device. A login revokes this tab's previous share and the share of the record it
  overwrites, and broadcasts `revoked {shareId}` for each; only tabs holding that share end. Logout, under the per-app
  lock, revokes this tab's share and the stored record's (with that record's session key) if it is another session's,
  deletes the record and broadcasts `logout`, which ends every tab of the app. A stale tab's 410 ends only that tab.
- The partner client broadcasts an approved `eth_sendTransaction` on the chain it was filled and signed for, one at
  a time per chain, with a filled nonce never below one past its last broadcast.
- The IndexedDB record is AES-GCM with an AAD over signer, app, path, session key, derivation version, CKD key hash,
  parent origin and expiry (`packages/core/src/layouts.ts:133`); records, Web Lock and BroadcastChannel are per app.
- Time checks use a server-corrected clock (`serverTimeMs`).

## Auto-approve policies

Code: `packages/core/src/policy/` (validator, matcher, `policyId`, usage); the vault enforces them
(`packages/web/src/vault/vault.ts`, `auto-approve.ts`).

- **Off by default, two opt-ins.** An app owner sets a policy (D1; set or change is pending until
  `auto_approve_effective_at`, 24 h, or `changeDelayMs` in dev envs; removal is immediate in D1). Each user then
  accepts that exact `policyId` in a Hana consent screen; any change to the policy changes the id and needs a new
  consent.
- **Removal in an open tab.** The vault page inlines the policy at load; `GET /v1/app` also returns the policy in
  force. An open vault auto-signs only under a policy that a `GET /v1/app` confirmed less than 10 s ago
  (`POLICY_FRESH_MS`), re-reading it first when the last check is older (also every 60 s in the background). A removed
  or changed policy, or a failed re-read, sends the request to the popup. So a removal stops auto-signing in every
  open tab within 10 s, plus the API's own read of D1 (no isolate cache on that read). A changed policy counts as none
  until a reload. Raw signing `'off'` is not re-read: an open tab keeps `'approval'` until its next load (every raw
  request still needs an Approve).
- **Never covered**: `hana_signRaw`, `personal_sign`, `stellar_signMessage` (`NEVER_AUTO_APPROVED_KINDS`), EVM
  contract creation, fee-bump and v0 Stellar envelopes, Stellar classic operations other than a listed `changeTrust`,
  contract creation or upload host functions, anything that fails to decode.
- **Validator** (`validateAutoApprovePolicy`, `validate.ts:404`): strict JSON, unknown keys refused at every level,
  `perDayCount` 1..500, `maxConsentMs` ≤ the app's `session_ttl_ms`, safe label and names, selector must equal the
  signature's, `addressArgs` required on an EVM function that takes an address, `addressArgs: 'any'` refused on
  value-moving names (`isValueMovingFunctionName`, `validate.ts:74`), `'self-or-listed'` refused on EVM functions with
  `bytes`, `string` or `bytes20`–`bytes32` arguments, decoder ids must be shipped (none in batch B).
- **Matcher** (`matchAutoApprovePolicy`, `match.ts:91`), every check must pass:
  - Address rule `'self-or-listed'`: every typed address at any depth (Soroban invocation tree including auth
    entries, ABI-decoded calldata, EIP-712 structs) is the user, a listed contract or a policy `addresses` entry;
    opaque arguments (Soroban `Bytes`/`String`, ABI `bytes`/`string`/`bytes20`+) are refused.
  - Stellar: passphrase listed; fee ≤ `maxFeeStroops`; tx and op sources are the user; footprint operations only on
    listed contracts' data.
  - EVM: chain listed; `to` and selector listed; calldata decodes against the listed signature; max fee
    (`gasLimit × maxFeePerGas`) ≤ `maxFeeWei`; `value` ≤ `maxValueWei`; today's auto-signed value + `value` ≤
    `maxValueWeiPerDay`.
  - EIP-712: `(verifyingContract, primaryType)` listed for a listed chain.
  - Every match counts against `perDayCount` (UTC day, per device).
- **Consent** ends at `min(grantedAt + maxConsentMs, session expiry)`, logout, `hana_revokeAutoApprove` or "Stop
  auto-approving"; counters live inside the encrypted record.
- **Residual risk (accepted):** within a policy, partner-page XSS can submit allowed calls at bad prices to the
  user's own address; token amounts other than native value aren't capped (Q39); contract names on the consent screen
  are partner-supplied (Q41); Sodax calls carry intents in opaque bytes and always get the popup until a
  `sodax-intent-v1` decoder exists (Q42).

## Known open issues

Findings (a)–(d) were raised after the batch B build and are being fixed; each is checked against commit 14e6fc3.

**(a) Unlock and touch don't re-check the app's current settings.** `shareAction` and `unlock`
(`apps/api/src/vault/endpoints.ts:256`, `:308`) load no settings. Confirmed:
- An app switched to `persistence = 'none'` keeps unlocking existing shares until each expires (up to 23 h 50 min).
  Only share creation checks `persistence` (`endpoints.ts:194`).
- `abs_expires_at` is fixed at creation (`endpoints.ts:216`); a lowered `session_ttl_ms` doesn't shorten live
  shares. `idle_until` does follow the current `idle_ttl_ms` on each slide (`apps/api/src/vault/shares.ts:104`), but
  stays capped by the old `abs_expires_at`.
- Planned fix: unlock and touch refuse and revoke the share when `persistence` is `'none'`, and cap the absolute
  expiry at `created_at + current session_ttl_ms`.

**(b) EVM max fee isn't counted in the value limits.** Partly fixed. Since 879ac55 the matcher caps the fee per
transaction (`tx.maxFeeWei ≤ chain.maxFeeWei`, `packages/core/src/policy/match.ts:392`). But `maxValueWei` compares
`tx.value` alone (`match.ts:395`), the daily check adds `tx.value` alone (`match.ts:396`), and the recorded spend is
`tx.value` (`match.ts:400`, `usage.ts:26`). So per day an injected script can burn up to `perDayCount × maxFeeWei` in
fees on top of `maxValueWeiPerDay`. Fix: count `value + maxFee` in the per-transaction and daily limits.

**(c) The `addressArgs: 'any'` denylist is weak.** Partly fixed. Since 879ac55 the name check matches prefixes and
substrings (`validate.ts:57`–`77`), so `transferAndCall`, `safeTransferFrom`, `send`, `operatorSend` and
`authorizeOperator` are now refused. Still open:
- `'any'` is accepted on every function whose name isn't on the list, including those with opaque arguments:
  `multicall(bytes[])`, `execute(address,uint256,bytes)`, `aggregate((address,bytes)[])`, routers with a `bytes` path.
  The matcher skips all address and opaque checks under `'any'` (`match.ts:382`), so such a call can carry a
  transfer or approval to any address.
- Renamed or non-standard value-moving functions (`withdraw(to,…)`, `redeem`, `claim`, `bridge`, `swap(…, recipient)`)
  also pass; a name denylist can't be complete.
- The same applies to Stellar functions (`validate.ts`, Stellar section).
- Fix direction: refuse `'any'` on functions with opaque arguments or execute/multicall-style names, and require a
  protocol decoder for them.

**(d) 160-bit integers aren't treated as opaque under `'self-or-listed'`.** Confirmed, not fixed.
`isOpaqueToAddressRule` (`packages/core/src/policy/opaque.ts:13`) and `isOpaqueAbiValue` (`opaque.ts:18`) cover only
`bytes`, `string` and `bytes20`+, and the matcher checks only `address`-typed values (`match.ts:386`). A function
taking `uint160`/`int160` (an address as an integer) passes the address rule unchecked. Planned fix: treat 160-bit
integers as opaque; keep wider integers allowed as amounts. Residual risk, to document with the fix: a contract that
casts a `uint256` to an address isn't caught.

Other issues and doubts found while verifying:

**(e) Issuer keys are a hot path to every user's key.** `KEYS_UPDATER_KEY` is a Worker secret that can call
`set_issuer_key` (`apps/api/src/issuer-keys.ts`), and the owner account can too. Either can add an RSA key, mint a
"Google" token for any `sub`, and derive any user's key in any scope. The contract account's full-access key can
upgrade the contract (no lock). `docs/contract-interface.md` already calls the owner and contract account total
control; the point here is that one of those powers sits in the API Worker's secrets. Needed before mainnet: upgrade
governance, and a way to bound issuer-key changes (for example a delay, or alerting on `issuer_key_set` for a kid
Google doesn't publish).

**(f) The API serves a stored auto-approve policy unvalidated.** On `feat/batch-b`, `effectiveSettings` only checks
that the policy is a JSON object (`apps/api/src/vault/settings.ts:48`) and the vault page inlines it. There is no
`admin app:settings` yet, so a policy can only arrive through a direct D1 write, which also skips the pending delay.
`b/settings-cli` (unmerged) adds the CLI and runs `parseAutoApprovePolicy` before serving. The vault validates again
(per spec), and the user must accept the `policyId`.

**(g) Replays across isolates still reach the chain.** The counter hold is per isolate (`session-use.ts:76`); copies
of one signed request arriving in different isolates are all relayed and all but one fail on chain (~2.2 Tgas each).
Known (`docs/context.md`).

**(h) Allowlists are wider than the API's use.** The session pool allows `prune_sessions`, and the owner pool
`register_scope` and `apply_pending_config`, but no endpoint relays them. Harmless (the Worker refuses them), but a
leaked key can call them directly within its allowance.

**(i) The 20-origin cap is enforced only by the vault page.** `admin app:origins:add` doesn't cap the count; an app
over 20 gets 403 `too_many_origins` on its vault page (availability, not safety).

**(j) sandbox-dev's two Hana origins are one site.** `hana-id-vault-sandbox-dev.tingtc.workers.dev` and
`hana-id-auth-sandbox-dev.tingtc.workers.dev` share the registrable domain `tingtc.workers.dev`; the schema allows
this only in dev envs (`packages/env/src/schema.ts:101`). The spec asked for different sites.

**(k) The approval digest binds no network for messages, typed data and raw requests.** Accepted by the user
(2026-10-28, `docs/decisions.md` D33): `contextString` is `''` for those kinds (`approval.ts` header,
`approvalContextString`). Typed data carries its chain in its domain; messages and raw requests name no network, and
the approve popup now says "This signature isn't tied to one network." on them.

Open questions in `docs/batch-b-spec.md` that bear on security and are still undecided: Q7 (vault cross-checks
`scopeId` on chain), Q14 (`max_uses` in `'session'` mode), Q16 (KEK rotation / HSM), Q22 (timelock for new origins
in shared mode), Q28 (in-memory idle limit), Q39–Q41 (policy limits and names).
