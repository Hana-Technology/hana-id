# Security model

Who is trusted for what, every key and secret, the invariants and where each is enforced, auto-approve rules, and
known open issues. Last verified against code: 2026-10-29 (branch `perf/login-latency-impl`; the login popup, the
background persist and the vault gate were re-checked, the rest as of 2026-10-28, commit 58edee9; the approval popup
opened by the partner page, branch `feat/approve-in-click`, D99).

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
| User's browser and device | Running Hana's pages; keeping the profile private | Malware or an extension in all frames: everything the user can do, including reading an exported key. A disk dump with a live share: unlock and get PRK | After logout, idle or absolute expiry or revoke: nothing (an open export window erases its key then too, and at most 5 min after deriving it, D111). A derive (the persisted session is used up) |
| NEAR RPC (manifest `rpc`, and `rpcFallback` when set) | Liveness, honest views | Fail derives, report wrong counters or a wrong registry answer (a refused login), delay. The fallback is asked only when the primary fails, so a lying primary is not outvoted | Forge a CKD result (pairing check against the pinned key) |
| Anyone watching the chain or mempool | Nothing | Read used tokens (openid-only claims via the API), replay `create_session` with them (the vault derives with the next counter), replay a whole combined call (burns a `max_uses = 1` login: `session_consumed`; attacker pays gas) | Derive for themselves (needs the session key; the answer is encrypted to `a`) |
| Another website | Nothing | Embed a vault with its own `pk` and log users into its own scope (legitimate) | Frame the vault for app X (`frame-ancestors`), receive `auth-params` (the popup checks `event.origin` and `event.source`), inject a token (the relay slot is written only from `authOrigin`, read only with `relayReadKey`) |

## What a compromise gives

| Compromised | Effect | Limits |
|---|---|---|
| One session-pool relayer key | Burn its allowance (≤ 2 NEAR default); relay session methods | Receiver and method list fixed on chain; every method still needs a token or session signature. DoS only |
| An owner-pool key | Burn ≤ 0.5 NEAR; relay owner methods | Every owner method needs an owner proof on chain; logins unaffected |
| `KEYS_UPDATER_KEY` (Worker secret, function-call key on the signer account) | `set_issuer_key` with an attacker RSA key → mint Google tokens for any `sub` → **derive any user's key** | Visible on chain (`issuer_key_set` events); the hourly cron would not remove a forged kid until it has been missing from Google's JWKS for ≥ 55 min. Open issue (e), D33; fix specified in `docs/governance-spec.md` (D80–D86) |
| Owner account key | Same as above, plus config (shared clients after the delay, sponsors, change-delay increase, `set_owner`) | Can't shorten the timelock at once, can't touch registered clients |
| Signer account full-access key | Redeploy the contract: anything, including MPC requests for any path | No upgrade lock in batch A/A.2/B. Open issue (e), D33; fix specified in `docs/governance-spec.md` |
| D1 | App origins (→ `frame-ancestors`, parent-origin checks), app scope, settings incl. bare writes of `raw_sign`/policy without the pending delay, suspensions; `share_enc` rows | `K_s` needs `VAULT_KEK`; a policy needs the user's consent to its `policyId`; raw requests still need approval |
| `VAULT_KEK` | Unwrap every `K_s` in D1 | Useless without a device's IndexedDB record (PRK is encrypted under `K_s` only on the device) |
| API Worker code or all Worker secrets, or the Cloudflare account | Everything: the API Worker renders the vault page (inlined config, `frame-ancestors`) and holds `KEYS_UPDATER_KEY`; the same account deploys the two page Workers that serve the vault and auth bundles | Single trust root. Mitigations: small vault bundle, strict CSP, no third-party script, narrow `frame-ancestors` |
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
| PRK | 32 bytes | Vault memory; IndexedDB record as AES-GCM under `K_s` | vault | Zeroed at `expiresAtMs` and after the app's `idle_ttl_ms` with no request that uses the key (each by a timer, and on the first use past it if the timer is late; after the idle limit a `'session'` record can be unlocked again while its share is alive), logout (any tab of the app), a `revoked` broadcast for its share, a newer login. Rotation: new `key_index` |
| Chain keys (Stellar seed, EVM `d`) | ed25519 seed, secp256k1 scalar | Derived per signature, zeroed in `finally` (`withChainKey`, `derivation.ts:98`) | vault; export window shows one on request | In the vault, same as PRK. In the export window (D111, sweep AUTH-1): zeroed and taken off the screen at the first of 5 min after it is derived (`EXPORT_KEY_LIFETIME_MS`, a timer plus a server-clock check on every reveal), the vault session's end (`sessionExpiresAtMs` in the context, or `hana:export-end` from the vault on logout, revoke, expiry or a newer login), the vault frame going away, and the window closing; exporting again needs a new window and a new Google sign-in |
| BLS app key `a` | BLS12-381 scalar | Memory, one login | vault / export window | Made by `newAppKey` (`packages/core/src/ckd.ts:84`), dropped after `decryptCkd` (a bigint: dropped, not zeroed) |
| Session key | Ed25519, non-extractable WebCrypto | Vault memory; IndexedDB record in `'session'` mode | vault | ≤ the session (≤ 23 h 50 min app setting, ≤ 24 h on chain) |
| `K_s` | 32-byte AES-GCM key per share | D1 only as `share_enc` under `VAULT_KEK`; vault memory briefly | API generates, vault uses | Ends with the share (idle ≤ `idle_ttl_ms`, absolute ≤ `session_ttl_ms`, revoke) |
| `VAULT_KEK`, `VAULT_KEK_PREVIOUS` | AES-256-GCM, `<id>:<base64>` | Worker secrets; `.secrets/<env>/vault-kek` (and `vault-kek.previous`), 0600, the only copy | Hana | Generated and set by `scripts/vault-kek.ts init` (wrangler stdin, never printed, file never overwritten). Rotate with `vault-kek rotate`: old value → `VAULT_KEK_PREVIOUS`, new id in `VAULT_KEK`; unlocks and the hourly cron re-wrap (`apps/api/src/vault/kek.ts`, `vault/cron.ts`) |
| `relayKey`, `relayReadKey` | 32-byte AES-GCM key / read capability | Vault memory; `relayKey` also in the login popup's `sessionStorage` until `/login/callback` reads it (`packages/web/src/auth/login-storage.ts`) | vault, login popup | One login; slot lives 120 s |
| Session-pool keys `RELAYER_KEYS` | ed25519 function-call keys on `relayer`, receiver `signer` | Worker secret; `.secrets/<env>/relayer-keys.json` | Hana | Default 3 × 2 NEAR. `deploy-contract` deletes and re-adds; mainnet needs allowance monitoring |
| Owner-pool keys `OWNER_RELAYER_KEYS` | same, owner methods | Worker secret; `.secrets/<env>/owner-relayer-keys.json` | Hana | Default 1 × 0.5 NEAR |
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
  nonce (`/v1/sessions`, `/v1/login`), scope check (`checkClientScope`, `handlers.ts:384`), `session_key_in_use`,
  session signature, session-use precheck mirroring the contract's counter and `max_uses` rules (`session-use.ts:29`,
  D20), BLS key shape. The scope is always the app's D1 `scope_id`, never the client's.
- **Replay precheck.** A cached session view never refuses on its own: it is re-read fresh first. A second request
  for the same `(session key, counter)` in the same isolate waits for the first (`session-use.ts:76`).
- **Claim allow-list** `{iss, azp, aud, sub, iat, exp, nonce, nbf, jti, auth_time}` (`apps/api/src/claims.ts:8`):
  always on `/v1/login`; on `/v1/sessions` only with `REJECT_PII_ON_SESSIONS = "1"` (off today).
- **Relayer allowlists** per pool in the Worker and in the object; gas only from `gas.ts`; receiver always
  `SIGNER_ACCOUNT`.
- **Owner actions**: OIDC auth only, console audience, a current owner of the scope, change exists / unlocked, client
  proof matches; the token is reserved single-use before relaying and released only if the tx certainly didn't
  execute; global caps 20/min, 200/day (`handlers.ts:30`, `handleOwnerAction` `:396`, `owner-actions.ts:31`).
- **Origin rules** (`apps/api/src/origins.ts:81`): a Hana page (`Origin` = `VAULT_ORIGIN`/`AUTH_ORIGIN`) may call only
  its endpoints, and only for an `x-hana-parent-origin` the app allows. Partner origins: `GET /v1/app` always; the
  session endpoints only for `pk_test_` in dev envs. Loopback origins and `http://localhost:*` only for `pk_test_` in
  dev envs. A `pk_test_` app on a scope a `pk_live_` app uses is refused (`scope_conflict`, `getAppByKey`,
  `apps/api/src/apps.ts:29`; D51). These checks bind browsers only (a script can send any `Origin`); they never
  replace a token or signature.
- **Hana origins host nothing else.** Each Hana origin is its own thin Worker (D66, `apps/api/src/pages/host.ts`): the
  vault Worker forwards only `GET /vault` to the API Worker, the auth Worker serves only its four pages, both serve
  static assets otherwise and answer only GET/HEAD on their own host. In the API Worker, a request whose URL origin is
  `VAULT_ORIGIN` or `AUTH_ORIGIN` reaches only `{vaultOrigin}/vault`; every other path is a 404 with `frame-ancestors
  'none'` and no CORS (`apps/api/src/index.ts`), so no API endpoint is ever same-origin with the vault's storage. The
  manifest schema (`packages/env/src/origins.ts`, `schema.ts`) refuses a Hana origin that is an IP address, a bare
  public suffix, a single label or has a trailing dot (any env), loopback (including `localhost.` and IPv4-mapped
  127/8) outside `local*`, `apiUrl`'s own origin (any env), or `apiUrl`'s site outside dev envs.
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
  | Relay endpoints per app | plan `per_minute` / `per_day` (free: 60 / 5000) |
  | `GET /v1/app` per IP per app | plan `per_ip_minute`, its own window |
  | Vault endpoints | 60/min per IP per app (*per location*); 10 × `per_minute` per app; 10/min per share (share actions, *per location*) |
  | Login relay per IP | writes 10/min, reads 120/min |
  | Owner actions | 10/min per IP; 20/min and 200/day globally |

  Each request's windows are asked in turn: per IP first, and the per-app window only once the IP window accepted,
  so a request the IP window refuses never uses (or holds) any of the app's shared quota. On the vault endpoints the
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
  TTL: a suspension, a removed or changed publishable key, a removed origin (its shares are revoked on the first use
  after) or a scope conflict reaches unlock, touch, revoke and share creation within 30 s per isolate. The app's
  settings (persistence, TTLs), the share rows and the signature are read fresh on every request. The relay endpoints,
  `GET /v1/app` and the vault page never use the cache, so a suspension stops logins, relays and new vault loads at
  once (tests: `apps/api/test/app-cache.test.ts`).
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
  and `ancestorOrigins`) and serves only that port. Popups and the vault authenticate each other by `event.origin` and
  `event.source`.
- No message in any direction carries key bytes, S, PRK, a CKD response, a token or a session secret, except
  `relayKey` from the vault to its authenticated login popup (schemas: `packages/core/src/protocol.ts`).
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
- Time checks use a server-corrected clock (`serverTimeMs`).

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

## Known open issues

Status: **fixed** (a), (b), (c), (d), (f); **accepted** (k), and the residual risks named under (b)–(d) and
"Auto-approve policies"; **open** (e) (pre-mainnet, D33), (g), (h), (i), (j) (sandbox-dev only; production envs
need D38's two domains).

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

**(e) Issuer keys are a hot path to every user's key. Open; to fix before mainnet (D33).** `KEYS_UPDATER_KEY` is a
Worker secret that can call `set_issuer_key` (`apps/api/src/issuer-keys.ts`), and the owner account can too. Either
can add an RSA key, mint a "Google" token for any `sub`, and derive any user's key in any scope. The contract
account's full-access key can upgrade the contract (no lock). `docs/contract-interface.md` already calls the owner and
contract account total control; the point here is that one of those powers sits in the API Worker's secrets. Confirmed
plan (D33; built on branch `feat/governance`, not deployed), specified in `docs/governance-spec.md` and confirmed by the user on 2026-10-29 (D80–D86):

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
  deletes the updater key that proposed one, and pauses only when such a key is active on chain; everything else is
  alert-only. The owner unpauses at once. Pause stops derivation and every token path, never governance. Built in
  `apps/watchdog` (branch `feat/governance`), not deployed. Pause stops derivation only for as long as it lasts:
  sessions a forged key opened before the pause would derive again after it (up to 24 h, any `max_uses`), so the
  runbook raises the owner's session floor (`set_sessions_valid_from_ms`) past the pause before unpausing, which
  retires every older session. Scope changes proposed with a forged key's owner tokens or client proofs can't be
  cancelled by OIDC owners while paused, so each unpause gives every pending change a full `change_delay_ms` again
  (`changes_unlock_floor_ms`) before anyone may execute it.
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

**(i) The 20-origin cap is enforced only by the vault page. Open.** `admin app:origins:add` doesn't cap the count; an
app over 20 gets 403 `too_many_origins` on its vault page (availability, not safety).

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

Open questions in `docs/batch-b-spec.md` that bear on security: Q22 (a timelock for new origins in shared mode) is
decided for batch C (D32, D34: 24 h delay, notice, cancel) but not built, so `admin app:origins:add` still applies at
once; Q15 (production domains) is decided only as far as two registrable domains (D38). Decided on 2026-10-28
(`docs/decisions.md`): Q7 (D56, registry check at login), Q9 (D65, `rpcFallback`), Q14 (D53, `max_uses = 1`), Q16
(D54, KEK in `.secrets`, KMS later), Q18 (D59, export limits), Q27 (D39, test apps refuse mainnets), Q28 (D55,
in-memory idle limit), Q39 (D46, no token caps), Q40 (D45, consent without a fresh sign-in), Q41 (D44, verified
contract names, built).
