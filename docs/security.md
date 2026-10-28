# Security model

Who is trusted for what, every key and secret, the invariants and where each is enforced, auto-approve rules, and
known open issues. Last verified against code: 2026-10-28 (`feat/b-defaults`: `feat/batch-b` with the batch B fix
branches and the defaults the user approved on 2026-10-28).

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
| API Worker logic and D1 (not the pages, not the secrets) | Gating and relaying; holding shares | Deny service; with `VAULT_KEK` plus a device dump, get PRK; point a vault at another scope of the same user only together with a Google client the registry maps to that scope (the vault's login check, Q7, refuses any other combination); set or widen `raw_sign`/policies (the user still approves raw requests and must accept a new `policyId`); make the vault page frameable by another origin (D1 origins) | Substitute the signer, path or CKD key (pinned in the bundles, path computed in the vault); read or swap the relayed token (end-to-end encrypted); sign without the vault |
| Partner (app owner) | Its own app config and, in own-client mode, its Google client | Own-client mode: obtain tokens with any nonce for its client and derive its own users' keys in its scope (inherent: Hana can't see Google client settings). Set an auto-approve policy (delayed; users must accept it) | Anything in another scope. In shared mode: derive keys (no token with a nonce of its choosing) |
| Partner page (incl. XSS, malicious dependency) | Nothing | Start a login (visible popup), read addresses, queue signature requests, drive an unlocked vault within its idle/absolute limits, get requests signed that match an accepted auto-approve policy | Read keys, tokens, nonces; get any other signature without a guarded Approve in a Hana popup |
| User's browser and device | Running Hana's pages; keeping the profile private | Malware or an extension in all frames: everything the user can do, including reading an exported key. A disk dump with a live share: unlock and get PRK | After logout, idle or absolute expiry or revoke: nothing. A derive (the persisted session is used up) |
| NEAR RPC (manifest `rpc`, and `rpcFallback` when set) | Liveness, honest views | Fail derives, report wrong counters or a wrong registry answer (a refused login), delay. The fallback is asked only when the primary fails, so a lying primary is not outvoted | Forge a CKD result (pairing check against the pinned key) |
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
| PRK | 32 bytes | Vault memory; IndexedDB record as AES-GCM under `K_s` | vault | Zeroed at `expiresAtMs` and after the app's `idle_ttl_ms` with no request from the page (each by a timer, and on the first use past it if the timer is late; after the idle limit a `'session'` record can be unlocked again while its share is alive), logout (any tab of the app), a `revoked` broadcast for its share, a newer login. Rotation: new `key_index` |
| Chain keys (Stellar seed, EVM `d`) | ed25519 seed, secp256k1 scalar | Derived per signature, zeroed in `finally` (`withChainKey`, `derivation.ts:98`) | vault; export window shows one on request | Same as PRK |
| BLS app key `a` | BLS12-381 scalar | Memory, one login | vault / export window | Dropped after decrypt (`packages/core/src/ckd.ts:84`) |
| Session key | Ed25519, non-extractable WebCrypto | Vault memory; IndexedDB record in `'session'` mode | vault | ≤ the session (≤ 23 h 50 min app setting, ≤ 24 h on chain) |
| `K_s` | 32-byte AES-GCM key per share | D1 only as `share_enc` under `VAULT_KEK`; vault memory briefly | API generates, vault uses | Ends with the share (idle ≤ `idle_ttl_ms`, absolute ≤ `session_ttl_ms`, revoke) |
| `VAULT_KEK`, `VAULT_KEK_PREVIOUS` | AES-256-GCM, `<id>:<base64>` | Worker secrets; `.secrets/<env>/vault-kek` (and `vault-kek.previous`), 0600, the only copy | Hana | Generated and set by `scripts/vault-kek.ts init` (wrangler stdin, never printed, file never overwritten). Rotate with `vault-kek rotate`: old value → `VAULT_KEK_PREVIOUS`, new id in `VAULT_KEK`; unlocks and the hourly cron re-wrap (`apps/api/src/vault/kek.ts`, `vault/cron.ts`) |
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
- **Hana origins host nothing else.** A request whose URL origin is `VAULT_ORIGIN` or `AUTH_ORIGIN` reaches only
  `{vaultOrigin}/vault` in the API Worker; every other path is a 404 with `frame-ancestors 'none'` and no CORS
  (`apps/api/src/index.ts`), so no API endpoint is ever same-origin with the vault's storage. The manifest schema
  (`packages/env/src/origins.ts`, `schema.ts`) refuses a Hana origin that is an IP address, a bare public suffix, a
  single label or has a trailing dot (any env), loopback (including `localhost.` and IPv4-mapped 127/8) outside
  `local*`, `apiUrl`'s own origin (any env), or `apiUrl`'s site outside dev envs.
- **CORS**: app endpoints echo only an allowed origin; preflight allows the Hana origins and origins of active apps
  (`origins.ts:105`); vault endpoints only `VAULT_ORIGIN`; the relay only the Hana origins; `/v1/owner-actions` and
  `/v1/health` are `*`.
- **Vault shares**: every lookup is `share_id AND app_id`; one share per session key; a share needs a live, used-up
  session in the app's scope; counter moves by one atomic `UPDATE`; a share whose partner origin was removed is
  revoked on next use; unlock and touch follow the app's settings as they are now (persistence `'none'` revokes the
  share; it never outlives `created_at` + the current `session_ttl_ms`), checked before the update and again inside
  it (`apps/api/src/vault/shares.ts`, `advanceShare`); `revoke-all` needs a share < 5 min old and revokes the other
  shares and moves its counter in one D1 transaction (`revokeAllFrom`), so it does both or neither and a replay
  revokes nothing; `K_s` is wrapped with AAD `share_id ‖ app_id ‖ session_pk`, so a row can't be moved to another
  share, app or key.
- **Login relay**: only `authOrigin` writes, only Hana origins read; write once (409), read once with the read key
  (403 without, slot untouched); 120 s then tombstone; ≤ 8 KiB; ciphertext only.
- **Key exports** (`/v1/login` from `authOrigin`): 3 per hour per `(app, sha256(path))`, counted after the token and
  nonce checks and before the relay (`apps/api/src/login.ts`, Q18), so starting exports can't drain the relayer
  allowance; a limiter that can't be reached refuses (503).
- **No cookies**: no response of the API Worker or the page Workers sets a cookie, and the page Workers drop a
  `Set-Cookie` from their bindings (`src/pages/host.ts` `withoutCookies`). Tests: `apps/api/test/no-cookies.test.ts`,
  `packages/web/test/no-cookies.test.ts`, the Playwright `noCookies` fixture.
- **Rate limits** (fixed windows, `rate-limiter.ts`; IPv6 keyed by /64, `ip.ts`):

  | Window | Limit |
  |---|---|
  | Relay endpoints per IP per app | plan `per_ip_minute` (free: 20/min) |
  | Key exports per user path per app | 3/hour |
  | Relay endpoints per app | plan `per_minute` / `per_day` (free: 60 / 5000) |
  | `GET /v1/app` per IP per app | plan `per_ip_minute`, its own window |
  | Vault endpoints | 60/min per IP per app; 10 × `per_minute` per app; 10/min per share |
  | Login relay per IP | writes 10/min, reads 120/min |
  | Owner actions | 10/min per IP; 20/min and 200/day globally |

- **Bodies and logs**: body caps (`readJson` streams and stops at the cap; vault 4 KiB, relay 8 KiB). Logs never carry
  tokens, `K_s`, `share_enc`, ciphertexts, signatures, relay bodies, keys, CKD responses or relay ids (the OAuth
  `state`: a relay path is logged as `/v1/login-relay`, the top-level error line included).
- **Admin settings writes** (`scripts/lib/admin-settings.ts`): the UPDATE is guarded by every settings column as the
  command read it, so a change made in between (another operator's `--auto-approve off`) can't be overwritten with
  values planned from the old row; a delayed setting is never put in force by the CLI.

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
- Auth pages: `frame-ancestors 'none'`, page-specific `connect-src`, no COOP header (`apps/api/src/pages/host.ts`
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
- Before relaying a login the vault checks its inlined `scopeId` against the registry with one view (Q7,
  `packages/web/src/vault/login.ts` `checkScope`): own client `scope_for_client('google', aud) == scopeId`, shared
  client `get_scope(scopeId)` with `allow_shared`. A mismatch or no answer refuses the login. Limit: the app→scope
  binding itself lives only in D1, so an API that substitutes another scope **and** that scope's own client passes
  the check (it then gets that scope's key for the user, still only in the user's own vault).
- Test apps (`pk_test_`) never sign for a mainnet (D39, `packages/core/src/networks.ts`): the Stellar public network,
  EVM chains outside the testnet allowlist (`TEST_EVM_CHAINS`), typed data whose domain names such a chain; refused
  before any popup or policy (4100 `mainnet_not_allowed`). Messages, chainless typed data and raw requests name no
  network and pass. The partner client refuses switching to or sending on such a chain too (not a security boundary).
- PRK leaves memory after the app's idle limit without a request from the page (Q28, `goIdle`); a `'session'` record
  is unlocked again before the next request that needs the key, only for the same share.
- The vault refuses to run top-level, accepts one hello, pins the parent origin (checked against the inlined origins
  and `ancestorOrigins`) and serves only that port. Popups and the vault authenticate each other by `event.origin` and
  `event.source`.
- No message in any direction carries key bytes, S, PRK, a CKD response, a token or a session secret, except
  `relayKey` from the vault to its authenticated login popup (schemas: `packages/core/src/protocol.ts`).
- Approval binds the whole request through `approvalDigest` (`packages/core/src/approval.ts:179`). Its network
  context is the passphrase or chain ID for transactions and auth entries, and empty for messages, typed data and raw
  requests (D35); the popup says those signatures aren't tied to one network. The launcher only opens the popup.
- The Approve guard (`packages/web/src/auth/approve-guard.ts`, D36): disabled until 1 s after render and 1 s after
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
  until a reload. Raw signing is re-read the same way before every raw request (`GET /v1/app` `rawSign`): `'off'`
  refuses raw requests in every open tab within 10 s, and a failed re-read refuses too (fails closed).
- **Never covered**: `hana_signRaw`, `personal_sign`, `stellar_signMessage` (`NEVER_AUTO_APPROVED_KINDS`), EVM
  contract creation, fee-bump and v0 Stellar envelopes, Stellar classic operations other than a listed `changeTrust`,
  contract creation or upload host functions, anything that fails to decode.
- **Validator** (`validateAutoApprovePolicy`, `validate.ts:454`): strict JSON, unknown keys refused at every level,
  `perDayCount` 1..500, `maxConsentMs` ≤ the app's `session_ttl_ms`, safe label and names, selector must equal the
  signature's, `addressArgs` required on an EVM function that takes an address, decoder ids must be shipped (none in
  batch B), and an EVM chain's `maxValueWei` may not be below its `maxFeeWei` (value plus fees counts against it, so
  such a rule could never auto-approve at its fee cap). `addressArgs: 'any'` is refused on value-moving names (`isValueMovingFunctionName`, `validate.ts:112`)
  and execute/multicall-style names (`isExecutionStyleFunctionName`, `validate.ts:117`) on both chains. An EVM
  function with an opaque argument (`policy/opaque.ts`: `bytes`, `string`, `bytes20`–`bytes32`, `uint160`/`int160`, at
  any depth of arrays and tuples) is refused under either rule (`validate.ts:359`): it needs a protocol decoder.
- **Matcher** (`matchAutoApprovePolicy`, `match.ts:95`), every check must pass:
  - Opaque arguments are refused under either rule, on every request (defence in depth on EVM, the only check on
    Stellar, where a policy names functions without argument types): Soroban `Bytes`/`BytesN`/`String` at any depth
    of `Vec`/`Map` (`match.ts:204`), ABI values as above (`match.ts:393`), EIP-712 fields of those types.
  - Address rule `'self-or-listed'`: every typed address at any depth (Soroban invocation tree including auth
    entries, ABI-decoded calldata, EIP-712 structs) is the user, a listed contract or a policy `addresses` entry.
    `'any'` skips only this check.
  - Stellar: passphrase listed; fee ≤ `maxFeeStroops`; tx and op sources are the user; footprint operations only on
    listed contracts' data.
  - EVM (`match.ts:405`): chain listed; `to` and selector listed; calldata decodes against the listed signature; max
    fee (`gasLimit × maxFeePerGas`, or `gasLimit × gasPrice`) ≤ `maxFeeWei` (`fee_too_high`); `value` ≤
    `maxValueWei` (`value_too_high`); `value + max fee` ≤ `maxValueWei` (`value_plus_fee_too_high`); today's
    auto-signed spend + `value + max fee` ≤ `maxValueWeiPerDay` (`daily_value_exceeded`). The recorded spend is
    `value + max fee` (`usage.ts`), an upper bound on what the transaction can take from the native balance.
  - EIP-712: `(verifyingContract, primaryType)` listed for a listed chain.
  - Every match counts against `perDayCount` (UTC day, per device).
- **Consent** ends at `min(grantedAt + maxConsentMs, session expiry)`, logout, `hana_revokeAutoApprove` or "Stop
  auto-approving"; counters live inside the encrypted record.
- **Residual risk (accepted):** within a policy, partner-page XSS can submit allowed calls at bad prices to the
  user's own address; token amounts other than native value aren't capped (Q39); contract names on the consent screen
  are partner-supplied (Q41); Sodax calls carry intents in opaque bytes and always get the popup until a
  `sodax-intent-v1` decoder exists (Q42). Under `'any'`, a value-moving or execute-style function with another name
  (`withdraw(to,…)`, `claim`, `bridge`, `swap(…, recipient)`) can't be recognised by name, and its typed addresses
  aren't checked; only partner-listed contracts and functions are ever auto-approved, and the consent screen warns
  about every `'any'`. A contract that casts a `uint256` (or a Soroban `u256`) argument to an address isn't caught:
  only exactly 160-bit integers are treated as opaque, so that wider integers stay usable as amounts.

## Known open issues

Findings (a)–(d) were raised after the batch B build: (a) is fixed on `fix/b-api`, (b)–(d) on `fix/b-core-policy`
(both merged into `feat/batch-b`).

**(a) Unlock and touch don't re-check the app's current settings. Fixed on `fix/b-api`.** Unlock and touch now
read the app's settings: `persistence = 'none'` revokes the share (`410 share_revoked`), and the share ends at
`min(abs_expires_at, created_at + current session_ttl_ms)` (`410 share_expired`, stored expiry lowered); the counter
`UPDATE` applies both rules in the same statement, so a change made after the first read still holds
(`apps/api/src/vault/endpoints.ts` `settingsRefusal`, `shares.ts` `advanceShare`; tests in `apps/api/test/vault.test.ts`
"unlock and touch follow the app's current settings"). As found:
- An app switched to `persistence = 'none'` keeps unlocking existing shares until each expires (up to 23 h 50 min).
  Only share creation checks `persistence` (`endpoints.ts:194`).
- `abs_expires_at` is fixed at creation (`endpoints.ts:216`); a lowered `session_ttl_ms` doesn't shorten live
  shares. `idle_until` does follow the current `idle_ttl_ms` on each slide (`apps/api/src/vault/shares.ts:104`), but
  stays capped by the old `abs_expires_at`.

**(b) EVM max fee isn't counted in the value limits.** Fixed (`fix/b-core-policy`). Besides the per-transaction fee
cap (`fee_too_high`), the matcher counts `value + max fee` against `maxValueWei` (`value_plus_fee_too_high`) and
against `maxValueWeiPerDay`, and records `value + max fee` as the day's spend (`packages/core/src/policy/match.ts:405`,
`usage.ts`). Fees can no longer be burnt on top of `maxValueWeiPerDay`. What remains: the recorded spend is the
maximum fee, not the fee actually paid, so the daily limit is conservative; and a policy whose `maxValueWei` is below
the fees its calls pay (`"0"` included) never auto-approves an EVM transaction; since 2026-10-28 (default approved by
the user) the validator refuses `maxValueWei < maxFeeWei` (`validate.ts`), and the consent screen labels the limits
"Maximum value plus network fees".

**(c) The `addressArgs: 'any'` denylist is weak.** Fixed as far as a validator can (`fix/b-core-policy`). `'any'` is
now also refused on EVM functions with an opaque argument (`multicall(bytes[])`, `execute(address,uint256,bytes)`,
`aggregate((address,bytes)[])`, routers with a `bytes` path) and on execute/multicall/aggregate/delegatecall/call/
batch/invoke/relay/upgrade-style names on both chains (`isExecutionStyleFunctionName`, `validate.ts:117`); such
functions need a protocol decoder. Because a Stellar policy names functions without argument types, the matcher
refuses Soroban `Bytes`/`BytesN`/`String` arguments under `'any'` as under `'self-or-listed'` (`match.ts:204`), and on
EVM it refuses opaque values under `'any'` too, as defence in depth (`match.ts:393`). Residual risk (accepted, see
"Auto-approve policies"): a value-moving or execute-style function under a name the lists don't cover
(`withdraw(to,…)`, `redeem`, `claim`, `bridge`, `swap(…, recipient)`) still passes with `'any'`, and its typed
address arguments are not checked; only partner-listed contracts are ever auto-approved, and the consent screen
warns about each `'any'`.

**(d) 160-bit integers aren't treated as opaque under `'self-or-listed'`.** Fixed (`fix/b-core-policy`).
`isOpaqueToAddressRule` and `isOpaqueAbiValue` (`packages/core/src/policy/opaque.ts`) treat any integer exactly 160
bits wide (`uint160`, `int160`) as opaque, at any depth, in calldata (validator and matcher) and in EIP-712 fields.
Soroban has no 160-bit integer type, so the Soroban check is unchanged. Wider integers (`uint256` and the like) stay
allowed as amounts. Residual risk: a contract that casts a `uint256` (or a Soroban `u256`) argument to an address
isn't caught. Side effect: Permit2 typed data (`PermitDetails.amount` is `uint160`) and calls with a `uint160`
argument (Uniswap v3 `sqrtPriceLimitX96`) can no longer be auto-approved; they need a decoder.

Other issues and doubts found while verifying:

**(e) Issuer keys are a hot path to every user's key.** `KEYS_UPDATER_KEY` is a Worker secret that can call
`set_issuer_key` (`apps/api/src/issuer-keys.ts`), and the owner account can too. Either can add an RSA key, mint a
"Google" token for any `sub`, and derive any user's key in any scope. The contract account's full-access key can
upgrade the contract (no lock). `docs/contract-interface.md` already calls the owner and contract account total
control; the point here is that one of those powers sits in the API Worker's secrets. Needed before mainnet: upgrade
governance, and a way to bound issuer-key changes (for example a delay, or alerting on `issuer_key_set` for a kid
Google doesn't publish).

**(f) The API serves a stored auto-approve policy unvalidated. Fixed** (`b/settings-cli`, merged): `effectiveSettings`
serves a stored policy only if `parseAutoApprovePolicy` accepts it against the app's `session_ttl_ms`, and logs
`auto_approve_policy_invalid` otherwise (`apps/api/src/vault/settings.ts`); `admin app:settings` validates before
writing. As found: at 14e6fc3, `effectiveSettings` only checked that the policy was a JSON object and the vault page
inlined it. A bare D1 write can still set a policy without the pending delay (see "What a compromise gives", D1); the
vault validates again (per spec), and the user must accept the `policyId`.

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
this only in dev envs (`packages/env/src/schema.ts:101`). Production envs must use two registrable domains (D38).
Why: Chrome/Edge and Firefox desktop always put different sites in different processes, so a renderer bug triggered
by content the auth popup shows (transactions, messages, app names) can't reach the vault's PRK. Not guaranteed on
Chrome Android (partial Site Isolation, ≥ 2 GB RAM) or WebKit (Safari, every iOS browser), where the vault iframe may
also share a process with the partner page; there, short unlock windows and zeroing PRK are the mitigation.

**(k) The approval digest binds no network for messages, typed data and raw requests.** Accepted by the user
(2026-10-28, `docs/decisions.md` D35): `contextString` is `''` for those kinds (`approval.ts` header,
`approvalContextString`). Typed data carries its chain in its domain; messages and raw requests name no network, and
the approve popup now says "This signature isn't tied to one network." on them.

Open questions in `docs/batch-b-spec.md` that bear on security and are still undecided: Q22 (timelock for new
origins in shared mode), Q39–Q41 (policy limits and names). Decided on 2026-10-28 (`docs/decisions.md`): Q7 (D49,
registry check at login), Q14 (D46, `max_uses = 1`), Q16 (D47, KEK in `.secrets`, KMS later), Q18 (D52, export
limits), Q28 (D48, in-memory idle limit), Q9 (D58, `rpcFallback`), Q27 (D39, test apps refuse mainnets).
