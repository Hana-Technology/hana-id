# Security model

Who is trusted for what, every key and secret, the invariants and where each is enforced, auto-approve rules, and
known open issues. Last verified against code: 2026-10-28 (commit 14e6fc3, `feat/batch-b`); the API, scripts, env
schema and open issues (a), (f) re-verified on branch `fix/b-api` (on `feat/batch-b` 0f0a437).

Component map and flows: `docs/architecture.md`. On-chain layouts and the contract's own security notes:
`docs/contract-interface.md` ("Security notes (for reviewers)"). Browser parts (vault, auth pages, partner client)
are on unmerged branches; they are marked **(per spec)** and described from `docs/batch-b-spec.md` "Security model".

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
| Partner page (incl. XSS, malicious dependency) | Nothing | Start a login (visible popup), read addresses, queue signature requests, drive an unlocked vault within its idle/absolute limits, get requests signed that match an accepted auto-approve policy | Read keys, tokens, nonces; get any other signature without a guarded Approve in a Hana popup (per spec) |
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
| PRK | 32 bytes | Vault memory; IndexedDB record as AES-GCM under `K_s` (per spec) | vault | Zeroed at `expiresAtMs`, logout, revoke broadcast. Rotation: new `key_index` |
| Chain keys (Stellar seed, EVM `d`) | ed25519 seed, secp256k1 scalar | Derived per signature, zeroed in `finally` (`withChainKey`, `derivation.ts:98`) | vault; export window shows one on request | Same as PRK |
| BLS app key `a` | BLS12-381 scalar | Memory, one login | vault / export window | Dropped after decrypt (`packages/core/src/ckd.ts:84`) |
| Session key | Ed25519, non-extractable WebCrypto | Vault memory; IndexedDB record in `'session'` mode (per spec) | vault | ≤ the session (≤ 23 h 50 min app setting, ≤ 24 h on chain) |
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

### Browser (per spec, not yet merged)

- The vault, login and export pages use only the pinned `SIGNER`, `RELAYER` and CKD key; any differing value stops
  the flow (`config_mismatch`).
- The vault computes the path from its own verified token and never uses a path, session or counter from the API; it
  re-syncs from NEAR RPC.
- The vault refuses to run top-level, accepts one hello, pins the parent origin (checked against the inlined origins
  and `ancestorOrigins`) and serves only that port. Popups and the vault authenticate each other by `event.origin` and
  `event.source`.
- No message in any direction carries key bytes, S, PRK, a CKD response, a token or a session secret, except
  `relayKey` from the vault to its authenticated login popup (schemas: `packages/core/src/protocol.ts`).
- Approval binds the whole request through `approvalDigest` (`packages/core/src/approval.ts:179`); Approve is guarded
  (1 s after render, 1 s after focus, a pointer move); the launcher only opens the popup.
- The IndexedDB record is AES-GCM with an AAD over signer, app, path, session key, derivation version, CKD key hash,
  parent origin and expiry (`packages/core/src/layouts.ts:133`); records, Web Lock and BroadcastChannel are per app.
- Time checks use a server-corrected clock (`serverTimeMs`).

## Auto-approve policies

Code: `packages/core/src/policy/` (validator, matcher, `policyId`, usage). The vault that enforces them is per spec.

- **Off by default, two opt-ins.** An app owner sets a policy (D1; set or change is pending until
  `auto_approve_effective_at`, 24 h, or `changeDelayMs` in dev envs; removal is immediate). Each user then accepts
  that exact `policyId` in a Hana consent screen; any change to the policy changes the id and needs a new consent.
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

Findings (a)–(d) were raised after the batch B build; each was checked against commit 14e6fc3. (a) is fixed on
`fix/b-api`; (b)–(d) are in `packages/core` and are being fixed separately.

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
this only in dev envs (`packages/env/src/schema.ts:101`). The spec asked for different sites.

**(k) The approval digest binds no network for messages, typed data and raw requests.** `contextString` is `''` for
those kinds (`approval.ts` header, `approvalContextString`); the spec text says passphrase or chain ID for every
request. Typed data carries its chain in its domain; messages and raw requests name no network.

Open questions in `docs/batch-b-spec.md` that bear on security and are still undecided: Q7 (vault cross-checks
`scopeId` on chain), Q14 (`max_uses` in `'session'` mode), Q16 (KEK rotation / HSM), Q22 (timelock for new origins
in shared mode), Q28 (in-memory idle limit), Q39–Q41 (policy limits and names).
