# Decision log

One entry per decision: what was decided, when, why, what was rejected, its status, and where it is written down.
Last verified against code: 2026-10-28 (commit 58edee9); D140–D141 and D150–D152 on 2026-10-30 (branches
`feat/batch-c-1`, `feat/playbook-gaps`); D130–D139 on 2026-10-30 (branches `feat/email-login-1`, `feat/email-login-1-r2`).

Consolidated from `docs/context.md` ("Decisions", "Batch A.2 decisions", "Batch C decisions", "Testnet
measurements"), `docs/batch-a-spec.md` ("Decisions"), `docs/batch-a2-shared-client.md`, `docs/batch-b-spec.md`
("Decisions", "Confirmed by the user", answered questions) and decisions made in conversation with the user that were
not yet written down (source "conversation"). Dates marked "≤ 2026-10-26" come from the design conversation in
wend-widget-demo, before the repo existed. Status: **in force** (in the code), **confirmed** (decided, code in
progress or not started), **deferred**, **superseded**, **proposed** (in a draft spec, not confirmed).

## Product and scope

### D1. Name: Hana ID, repo `hana-id`, npm scope `@hana-id`
- Date ≤ 2026-10-26 · Status: in force (scope still to claim on npm) · Source: `docs/context.md` "Decisions"
- Why: `@hana` is taken on npm; `@hana-id` looked free.
- Rejected: `@hana`.

### D2. Target a production MVP: real users and real funds on mainnet
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; CLAUDE.md
- Decision: production standards and tests for every behaviour from the start. Path: testnet pilot (batches A, A.2,
  B and a testnet smoke test), then production MVP (final accounts and address freeze, external audit, upgrade
  governance, mainnet MPC, key export and rotation, monitoring, legal and Google brand verification).
- Rejected: a throwaway prototype.

### D3. Any app can integrate; Sodax is the first customer, not a special case
- Date ≤ 2026-10-26 · Status: in force (`@hana-id/sodax`: Stellar and EVM wallet-provider adapters) · Source:
  `docs/context.md` "Decisions"
- Decision: nothing customer-specific. The core SDK exposes standard interfaces (EIP-1193, Stellar Wallets Kit, raw
  sign); Sodax gets a thin optional adapter (`@hana-id/sodax`, `IStellarWalletProvider`). Pilot wallets on
  testnet-MPC keys are disposable.

### D4. Email login later, as its own trust decision
- Date ≤ 2026-10-26; confirmed 2026-10-30 · Status: confirmed by the user, not built (before mainnet) · Source:
  `docs/context.md` "Decisions"; `docs/batch-a-spec.md`; `docs/email-login-spec.md` "Confirmed by the user"
- Why: whoever signs email tokens can derive any email user's key. Batch A made the verifier provider-generic
  (`issuers.rs`) so email can be another issuer.
- Decision (2026-10-30): email login through a Hana-run issuer, no vendor (`apps/email-issuer`, its own Worker);
  6-digit codes, not magic links; `sub` = `"e1." ‖ b64url(HMAC-SHA256(K_sub, normalized address))`, frozen at the
  address freeze; per-scope `aud` `email:<scope_id>`; a self-issued provider: owner-posted keys only, governance
  delay, no early confirm, watchdog pins. Signing key and signer policy: D121. Linking: D119, D122. Other details:
  D123.
- Rejected: Auth0, Stytch, Firebase (each a trust root able to mint for any user, none fits the on-chain nonce and
  `sub` rules without a Hana server anyway; `docs/email-login-spec.md` "Vendors considered and rejected").

### D5. Throwaway accounts first; every account name in `envs/<env>.json`
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: no `*.testnet` name hard-coded outside manifests and tests (`packages/env`).
- Why: accounts are replaced before the address freeze; one manifest per env keeps code env-free.

### D6. NEAR account keys use ed25519, not ml-dsa-65
- Date 2026-10-26 · Status: in force · Source: conversation
- Decision: owner, signer and relayer full-access keys and every function-call key are ed25519.
- Why: post-quantum support in NEAR tooling is too new for now.
- Rejected: ml-dsa-65.

## Keys and derivation

### D7. CKD only; no per-transaction MPC signing
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/batch-a-spec.md` "Decisions"; `docs/context.md`
- Decision: the MPC derives a key per user once per login (CKD, domain 2); signing is local in the browser.
- Why: one MPC call per login instead of per signature; local signing takes ~0.25 ms.
- Rejected (removed in batch A): `sign_with_session`, `sign`, `on_verified`, `sign_target`, envelopes, the NEAR
  Auth/FastAuth router and per-chain MPC signing code.

### D8. `key_index` in the path, for rotation after a leak
- Date ≤ 2026-10-26; bound added 2026-10-27 · Status: in force · Source: `docs/batch-a-spec.md`; `docs/batch-b-spec.md`
  "Key rotation hooks"
- Decision: path = `{scope_id}#{provider}#{sub}#{key_index}`. The MVP uses 0 and partners can't set it.
  `key_index ≥ 2^31` is reserved and refused by the contract, API and SDK.
- Not built: the rotation flow itself.

### D9. Derivation v1: `hana-id/chain-keys/v1/extract` and `/expand`, no global recovery phrase
- Date 2026-10-28 (names and structure confirmed by the user; Q36) · Status: in force (`packages/core/src/derivation.ts`)
  · Source: `docs/batch-b-spec.md` "Confirmed by the user", "Derivation v1"
- Decision: one HKDF-Extract of S to PRK, then HKDF-Expand per `(namespace, curve, account)`; tuples
  `("stellar","ed25519")` and `("eip155","secp256k1")`; EVM key by FIPS 186-5 A.2.1 reduction of 48 bytes; export is
  a raw key per chain. Golden vectors and a guard test. This changed every provisional address (allowed before the
  freeze).
- Why: additive for new chains and accounts; the two suffixes make a salt/info swap impossible to miss.
- Rejected: the provisional one-shot HKDF with salt `hana-embed-ckd-v1`; a BIP-39 phrase; keeping S in the vault
  (R7: PRK only).

## Registry and isolation

### D10. Per-partner scope from the token's `(provider, aud)`, via a registry inside `hana-signer`
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: each partner app is a scope; the scope is part of the path, so one app can't derive another app's
  users' keys. A scope may hold several client IDs (web, iOS, Android). The registry is a module of `hana-signer`
  (`registry.rs`).
- Why: the PoC's global client-ID list let any listed app derive every user's key.
- Rejected: a global client list; a separate registry contract.

### D11. Self-serve-ready registry, closed for the pilot
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: `public_registration` is off and one-way; while off, Hana registers scopes (`admin_register_scope`).
  Client ownership is proven by a token for that client; adding clients and changing owners is owner-only and
  timelocked. Owners are NEAR accounts or Google identities. Hana can't move clients; suspension is API-side only.
- Why: self-serve needs client-ownership proofs that hold up; they prove less than they seem (see the contract's
  security notes).
- Amended by D12: Hana can stop logins to a shared-only scope by removing shared clients.

### D12. Shared Google client mode
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"; `docs/batch-a2-shared-client.md`
- Decision: besides its own client, an app can log in through Hana's shared clients (`sharedGoogleClientIds`,
  `set_shared_clients`, ≤ 5). The scope then comes from the session nonce, which commits to `scope_id`; the scope must
  have `allow_shared`. A client is shared or a scope's own, never both. Adding a shared client and enabling
  `allow_shared` are timelocked; removing and `disable_shared_login` are immediate.
- Why: partners can start without their own OAuth client (like Privy's default credentials) and keep per-app
  isolation. Forging a nonce only gets the forger their own key. The path has no client ID, so own and shared logins
  give the same address (Google `sub` confirmed stable across one project's clients, 2026-10-27, and across Cloud
  projects, 2026-10-28: D42).

### D13. Retired shared clients can never join a scope
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"
- Why: anyone able to load Hana's login page could mint tokens for a retired client with a nonce of their choosing.

### D14. Every nonce commits to the signer account; layouts checked twice
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"; `docs/contract-interface.md`
- Decision: all nonces start with borsh(signer account id); the session nonce also commits to `scope_id` and
  `max_uses`; session messages are `"hana-id-session-v1:" ‖ counter ‖ sha256(payload)`. Layouts are checked against an
  independent JS implementation (`gen-fixtures.mjs`) and in the sandbox.
- Why: no token replay across deployments; a front-runner can't change the scope or use cap.

### D15. Fresh deploy for A.2; batch B is a code upgrade
- Date 2026-10-26 (A.2), 2026-10-27 (B) · Status: in force · Source: `docs/context.md` "Batch A.2 decisions";
  `docs/contract-interface.md` "Changed in batch B"
- Why: A.2 changed the state layout; B changed no layout, path or state.

## Infrastructure and API

### D16. App config off-chain in D1; API on Cloudflare Workers and Durable Objects
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: publishable keys, origins, plans, suspension, usage in D1; one Durable Object per relayer key serialises
  nonces.
- Why: built-in DDoS and rate limiting, a free tier, no database credentials.

### D17. Stay on Cloudflare (Workers + DO + D1)
- Date 2026-10-27 · Status: in force · Source: `docs/context.md` "Batch C decisions" (plan doc review); conversation
- Decision: kept after comparing alternatives on security and cost for a cost-sensitive startup.
- Why: cheapest at every volume, DDoS included, no OS to patch, Durable Objects fit the nonce design. Infra is under
  1% of running cost; NEAR gas (~38–40 Tgas, ~$0.02 per login) is the bill, so the lever is fewer on-chain calls per
  login.
- Later: AWS KMS only for HSM-grade keys (email issuer). Revisit at D1 ~5 GB, an HSM or region requirement, or
  ~500 req/s per app.

### D18. No production env or Hana custom domain while in development; sandbox-dev on workers.dev
- Date 2026-10-27 · Status: deferred · Source: conversation; `docs/context.md` (latency notes)
- Decision: sandbox-dev runs on `*.tingtc.workers.dev` (personal account, free plan). The production env, a
  Hana-owned domain and Cloudflare account come later.
- Why: free-plan routing from Malaysia scatters requests to US/EU colos (also seen on a free custom zone); whether a
  paid zone fixes it can only be tested once a Hana domain exists, so that test is deferred too.

### D19. Two relayer key pools
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"
- Decision: session pool (`RELAYER_KEYS`) and owner pool (`OWNER_RELAYER_KEYS`, small allowance), separate keys and
  Durable Objects, per-method gas. `deploy-contract` treats a wrong receiver, wrong or empty methods, or an unlimited
  or too-large allowance as a blocker.
- Why: abuse of `/v1/owner-actions` can't stop logins.

### D20. The API verifies before relaying
- Date 2026-10-26; derive precheck 2026-10-27 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions",
  "Testnet measurements" (`fix/derive-precheck`)
- Decision: RS256, claims and nonce for sessions; Ed25519 session signatures; the scope check;
  `session_key_in_use`; and the contract's counter and `max_uses` rules mirrored off-chain (409 `counter_used`,
  `session_exhausted`, `counter_out_of_range`).
- Why: every relayed transaction is paid even when it fails (~2.2 Tgas for a rejected derive), and signed requests
  are public on chain, so anyone could replay them at Hana's cost.

### D21. Relayer latency design
- Date 2026-10-27 · Status: in force · Source: `docs/context.md` "Testnet measurements" (`perf/api-latency`,
  `perf/relay-dispatch`, `perf/relayer-cold-start`)
- Decision: answer at `EXECUTED_OPTIMISTIC`, not finality; run independent chain reads in parallel; reserve nonces 100
  at a time (one confirmed write per 100 relays, a restart skips ≤ 99); cold starts trust the stored reservation and
  block hash (< 5 min) with no chain read; pin shared Durable Objects with a location hint (sandbox-dev `apac`).
- Why: measured on testnet: the per-tx nonce write held every broadcast behind its storage confirmation, and idle
  objects (evicted after ~10 s) read the chain on every cold start.

## Batch B (SDK), confirmed by the user

### D22. Keep the wallet across reloads with a server-held share
- Date 2026-10-27 · Status: in force (`apps/api/src/vault/`, `packages/web/src/vault/`) ·
  Source: `docs/batch-b-spec.md` "Confirmed by the user", "Key persistence"
- Decision: per-app `persistence: 'session' | 'none'` (default `'session'`). In `'session'` mode the session has
  `max_uses = 1`; the browser stores PRK encrypted under `K_s`; the API returns `K_s` only for a signed, in-order,
  unexpired, unrevoked share request. Idle and absolute limits, revoke and revoke-all.
- Why: a Privy-like experience; and a reload costs nothing on chain instead of ~$0.02 and 6–9 s.
- Rejected: local AES-GCM of S with a session key that still has uses (R5: `derive_key` is permissionless, so the
  server limits would be bypassable on chain).

### D23. Approval popup by default; opt-in auto-approve policies
- Date 2026-10-27 · Status: in force (`packages/core/src/policy/`, `packages/web/src/vault/`) ·
  Source: `docs/batch-b-spec.md` "Confirmed by the user", "Auto-approve policies"
- Decision: every signature needs a guarded Approve in a Hana popup unless it matches a policy the app owner set
  (delayed) and the user accepted (bound to `policyId`). Off by default; two opt-ins. Batch B covers typed calls only
  (direct calls with typed address arguments, token approvals to listed contracts, listed Stellar `changeTrust`).
  Raw signing, `personal_sign`, `stellar_signMessage` and contract creation are never covered.
- Why: Privy offers a confirmation toggle and delegated-action policies; this is the equivalent without a
  server-side signer (the key exists only in the vault).
- Rejected: "partners can't turn approval off"; server-side delegated signing.

### D24. No protocol decoder in batch B; Sodax uses the popup
- Date 2026-10-27 (Q42) · Status: in force (empty decoder registry, `packages/core/src/policy/decoders.ts`) · Source:
  `docs/batch-b-spec.md` "Sodax needs a protocol decoder", Q42
- Decision: Sodax spoke calls carry intents in opaque bytes on EVM and Stellar, so no policy can check them. Batch B
  ships the `ProtocolDecoder` interface with an empty registry; a `sodax-intent-v1` decoder comes later on demand.
  `AssetManager.transfer`, `Connection.sendMessage` and `send_message` may never have `addressArgs: 'any'`.
- Why: an arbitrary `data` on a tiny deposit could empty the user's hub wallet; value limits don't bound that.

### D25. Google Workspace accounts are allowed; openid-only tokens
- Date 2026-10-28 · Status: confirmed, in force (`apps/api/src/claims.ts`, `packages/core/src/id-token.ts`) · Source:
  conversation; `docs/batch-b-spec.md` "Confirmed by the user", Q1, Q32
- Decision: Workspace users log in normally. The claim allow-list stays as a guard against Google adding claims.
- Why: the spike (`apps/smoke/spike.html`, Chrome) showed `scope=openid` tokens for both a personal and a Workspace
  account carry exactly `{aud, azp, exp, iat, iss, jti, nbf, nonce, sub}`: no `hd`, email, name or picture. So
  blocking Workspace accounts is neither possible nor needed, and no domain or PII reaches the chain.
- Rejected: refusing tokens with `hd` (the spec's earlier position, which would have blocked Workspace users).
- Amended 2026-10-30 (email login, D119; not built): the on-chain Google token stays openid-only (allow-list
  unchanged, `token_has_pii` still refuses an ID token with `email`). The Hana login popup also requests Google's
  `email` scope and an access token; the email issuer reads the verified address and `hd` from Google's userinfo
  endpoint **transiently, off chain, at link time**, only to match a Google identity with the same person's email
  identity, keeps only HMACs of it (`sub` under `K_sub`, hints and limits under their own keys), revokes the access
  token, and never logs, stores or puts the address on chain. The consent screen shows the email permission. D120 is
  a separate, per-app opt-in.

### D26. One transaction per login, with a ship gate
- Date 2026-10-28 · Status: confirmed; contract, API and vault in force, not yet measured on testnet · Source:
  `docs/batch-b-spec.md` "Confirmed by the user"; `docs/contract-interface.md`
- Decision: `create_session_and_derive`, a literal composition of `create_session` and `derive_key` with counter 1,
  through `POST /v1/login`. If the 10-run testnet median saves less than 1.5 s, the method is removed before the
  audit and the split flow stays.
- Why: measured ~2 s of the ~8.9 s login is the second transaction.

### D27. Export proves freshness by a new login, not `auth_time`
- Date 2026-10-28 (Q33, spike) · Status: in force (`packages/web/src/auth/export-page.ts`) · Source:
  `docs/batch-b-spec.md` Q33
- Decision: export runs its own fresh login plus a typed confirmation; the `auth_time` check is off
  (`maxAuthAgeMs` unset, `packages/core/src/id-token.ts`).
- Why: with `max_age=0` Google returned no `auth_time`.

### D35. Message, typed-data and raw approvals bind no network; the popup says so
- Date 2026-10-28 · Status: in force (`packages/core/src/approval.ts`, `packages/web/src/auth/render-approval.ts`) ·
  Source: conversation (decided by the user); `docs/security.md` (k)
- Decision: the approval digest's `contextString` is the passphrase for Stellar transactions and auth entries, the
  chain ID for EVM transactions, and empty for `stellar_signMessage`, `personal_sign`, `eth_signTypedData_v4` and
  `hana_signRaw`. The approve popup shows "This signature isn't tied to one network." on message and raw requests;
  typed data shows its domain's chain (or warns that it names none).
- Why: these requests name no network of their own, and the vault never learns the dapp's selected EVM chain (the
  SDK answers `eth_chainId`), so there is nothing true to bind; showing a chain the signature isn't limited to would
  mislead.
- Rejected: binding the SDK's current chain (the vault can't verify it, and the signature is valid on every chain
  anyway).

### D36. The Approve guard arms per input type
- Date 2026-10-28 · Status: in force (`packages/web/src/auth/approve-guard.ts`) · Source: conversation (decided by
  the user); amends `docs/batch-b-spec.md` "Approval flow" step 5
- Decision: Approve and Allow stay disabled until 1 s after the request rendered, 1 s after the window last gained
  focus or became visible, and an arming gesture after both. Mouse: only a `pointermove` that moved arms (a press
  never does, and zero-movement synthetic moves are ignored). Touch and pen: a `pointerdown` arms. Keyboard: only
  Tab, Shift+Tab and the arrow keys arm; Enter, Space and auto-repeated keys never do. The arming gesture never
  approves: Approve acts only on a click whose own pointerdown (or non-repeated keydown) came after it. The page never
  focuses Approve.
- Amended 2026-10-28: a mouse move "moved" when its `movementX`/`movementY` is non-zero or, when
  both are 0, when **both** its client position and its screen position differ from the last pointer event's (move or
  press) recorded in the current request and focus period; every reset of the guard (a new request, a focus, a blur,
  nothing to approve) forgets that position, and missing or non-finite coordinates never arm. WebKit reports 0
  movement on every `pointermove` (found by the Playwright suite: Approve never armed in WebKit, so Safari mouse users
  could not approve). A real cursor move changes both positions; a layout change under a still cursor changes
  neither; a window move changes only the screen position; so neither of the last two arms, nor does the first
  zero-movement move (nothing to compare with). Hardened after a security review of the first version, which compared
  client coordinates only and kept the position across requests.
- Amended 2026-10-29: the screen position is no longer compared, only the client position (still reset on every
  guard reset). WebKit on Linux (CI) reports fixed screen coordinates, so Approve never armed there. The client
  position is what separates the threat: a layout change or scroll under a still cursor leaves it unchanged; it changes
  only when the cursor moves or the user moves the window under it (no other page can move the popup). The earlier
  note that a window move changes only the screen position was backwards.
- Why: the spec's `pointermove`-only rule never arms on a stationary tap or from the keyboard, so phone and
  keyboard-only users could not approve. Keeping mouse on `pointermove` means clicking in place never approves, and
  keeping Enter and Space out means a held key never approves.
- Residual risk (accepted): on a phone, someone tapping repeatedly for more than 1 s after the popup tab opens can
  still approve in two taps, if the second lands on Approve.
- Rejected: `pointermove` only (unusable on touch and keyboard); any `pointerdown` or `keydown` arming (the deviation
  first coded in `fbdb0ce`: mouse click-spam or a held Enter could approve in two events).

### D37. Auto-approve: fees count as spend; opaque arguments always need a decoder
- Date 2026-10-28 · Status: in force (`packages/core/src/policy/`) · Source: conversation
  (security findings (b)–(d), `docs/security.md` "Known open issues")
- Decision: on EVM, `value + maximum fee` counts against `maxValueWei` and `maxValueWeiPerDay` and is recorded as the
  day's spend (`maxFeeWei` still caps the fee alone). Arguments the address rule can't see into (`bytes`, `string`,
  `bytes20`+, exactly-160-bit integers; Soroban `Bytes`/`BytesN`/`String`) are never auto-approved under either
  `addressArgs` rule: such functions need a protocol decoder. `'any'` is also refused on execute/multicall-style
  names. Wider integers stay allowed as amounts.
- Why: the SDK fills gas and fees on the partner page, so an injected script could burn the native balance in fees on
  top of the value limit; under `'any'` a multicall or an `execute(…, bytes)` could carry a transfer to any address;
  a `uint160` is an address in integer form.
- Rejected: treating `uint256` as opaque (it is every amount); a validator check on Stellar argument types (a Stellar
  policy names functions only; the matcher checks each request instead).
- Consequences: a policy with `maxValueWei: "0"` no longer auto-approves EVM transactions; Permit2 typed data and
  Uniswap v3 calls (`uint160` fields) always get the popup until a decoder covers them.

## Batch C (dashboard), decided 2026-10-27

The batch C spec (`docs/batch-c-spec.md`) is a draft; only the entries below were decided with the user.

### D28. A developer dashboard like Privy's
- Date 2026-10-27 · Status: confirmed, not built · Source: `docs/context.md` "Batch C decisions"
- Decision: partners manage orgs, members, apps, origins, keys and on-chain owner actions (`/v1/owner-actions` with a
  console-client token). Replaces `admin app:*` after the pilot.

### D29. Invite-only sign-up
- Date 2026-10-27, reconfirmed 2026-10-28 · Status: confirmed, not built; amended by D89 (owners invite teammates
  too) · Source: `docs/context.md` "Batch C decisions"; conversation
- Decision: no public sign-up. A Hana admin issues email-bound, single-use, expiring invites (stored hashed); sign-in
  with Google through the console client; no accepted invite means refused. `public_registration` stays off.

### D30. Separate Hana admin console behind Cloudflare Access; billing-grade usage in D1
- Date 2026-10-27 · Status: confirmed, not built · Source: `docs/context.md` "Batch C decisions"
- Decision: contract-billing reports per org and app by day and month (logins, derives, MAU, new users, gas and USD,
  failures, latency), CSV statements. Billing-grade totals in D1; Analytics Engine (3 months) for operational metrics
  only.

### D31. Billing on hold; Sodax billed by service contract
- Date 2026-10-27, reconfirmed 2026-10-28 · Status: deferred · Source: `docs/context.md` "Batch C decisions";
  conversation
- Decision: no Stripe, plans or invoicing yet. Sodax is billed under its service contract from the monthly statement.

### D32. Allowed origins are security-critical in shared-login mode
- Date 2026-10-27; delay set 2026-10-28 (D34) · Status: confirmed, not built · Source: `docs/context.md` "Batch C
  decisions"
- Decision: origin changes need a fresh sign-in, are logged and email the other owners; they take effect after 24 h
  and can be cancelled meanwhile (D34).
- Why: in shared mode, origins decide which pages may embed the vault and get nonces for the scope.

## Pre-mainnet and batch C scope, decided 2026-10-28

### D33. Bound issuer-key and upgrade power before mainnet
- Date 2026-10-28 · Status: confirmed by the user, to spec as a pre-mainnet batch · Source: `docs/security.md` open issue (e)
- Decision: a newly posted issuer key becomes usable only after a delay, during which an independent watchdog (own
  key, own service, checks Google's published JWKS) can cancel it; alert on any `issuer_key_set` for a kid Google
  doesn't publish; the owner account becomes a multisig; the signer account's full-access key is removed and
  upgrades go only through the owner multisig with a timelock and public notice. Later, optionally, k-of-n
  independent key posters.
- Why: today `KEYS_UPDATER_KEY` (a Worker secret), the owner account or the signer's full-access key can each forge
  Google tokens or swap the contract and so derive any user's key.
- Open: the delay length. Measure Google's key lead time first (record when each kid first appears in the JWKS);
  the watchdog may approve early when the key matches Google's list. No address change. Measurement is running
  (migration 0004 `issuer_key_observations`, 15-min cron; read with `admin <env> issuer-keys:lead-times --remote`,
  `docs/operations.md` "Issuer key lead times").
- 2026-10-29: specified in `docs/governance-spec.md`; delays D80 (mainnet issuer-key delay provisional until the
  lead-time measurement is in), multisig D81, watchdog D82–D83, no upgrade guardian D84, alerts D85, the rest D86.

### D34. Batch C MVP cut
- Date 2026-10-28 · Status: confirmed by the user · Source: batch C MVP trim proposal (to be folded into
  `docs/batch-c-spec.md`)
- Decision: keep three Workers and three D1s, the script-free auth origin, the server-side Google code flow,
  invite-only sign-up, origin safety (change-bound token, 24 h delay, notice, cancel), the on-chain watcher,
  settlement at FINAL, uid HMAC for MAU and the admin billing reports. Add the auto-approve policy editor (same path
  as origin changes; removal immediate). Simplify: two roles (owner, viewer), one fail-closed notice channel from the
  admin Worker, direct usage inserts with a daily nonce cross-check, on-demand reports with frozen monthly
  statements, compare-and-swap writes instead of the reconciler, publishable keys with a fixed 24 h grace. Defer:
  mandatory passkeys (required before a second partner joins), second-owner approval, Hana restore of revoked keys
  and removed origins, the partner app-request queue, secret keys, R2/AE copies, Stripe.
- Why: about 40% of the draft's size with every security property kept or its loss stated.
- Blocked on: a Hana Cloudflare account and zone, an email provider, Cloudflare Access with MFA.

### D38. Vault and auth popups on two registrable domains
- Date 2026-10-28 · Status: confirmed by the user; domain names not chosen · Source: `docs/batch-b-spec.md` "Origins
  and pages", `docs/security.md` (j)
- Decision: production `vaultOrigin` and `authOrigin` sit on different registrable domains. The auth domain is the only
  one users see (popup address bar), so it is an official, recognisable Hana domain; whether that is `hanawallet.io` or
  another domain is undecided. The vault domain is never shown and hosts nothing else.
- Why: desktop Chrome/Edge/Firefox guarantee separate processes per site, so content shown in the popups can't share a
  process with the vault's PRK. Costs one extra domain (~$12/yr); no code change, the schema already refuses a
  same-site pair outside `local*`/`sandbox*` envs.
- Rejected: one dedicated domain with `vault.`/`auth.` subdomains (matches Privy/Turnkey practice, origin isolation
  only); a separate user-visible auth domain that looks unofficial.
- Limits: no process guarantee on Chrome Android or WebKit. If the auth domain also hosts other Hana sites: no
  domain-wide cookies, restricted DNS zone access.

### D39. Test apps can't sign for mainnet chains
- Date 2026-10-28 · Status: in force (`packages/core/src/networks.ts`, `packages/web/src/vault/signing.ts`,
  `packages/web/src/client/ethereum.ts`) · Source: `docs/batch-b-spec.md` Q27; decided by the user; how "mainnet" is
  defined: default approved by the user (2026-10-28)
- Decision: the vault refuses mainnet Stellar passphrases and mainnet EVM chain IDs for `pk_test_` apps (keys from the
  testnet MPC). Sodax integrates and tests on chain testnets; real Sodax swaps through Hana wait for the mainnet launch.
- How: Stellar mainnet is the passphrase `Public Global Stellar Network ; September 2015` (the only one a mainnet
  accepts). EVM uses an **allowlist** of testnet chain IDs (`TEST_EVM_CHAINS`: Sepolia 11155111, Holesky 17000, Base
  Sepolia 84532, Arbitrum Sepolia 421614, OP Sepolia 11155420, Sonic Blaze 57054, BSC testnet 97, Polygon Amoy 80002,
  Avalanche Fuji 43113, local 31337 and 1337; Hoodi 560048 and Sonic testnet 14601 added 2026-10-28, see the
  amendment below); anything else counts as a mainnet. Refused before any popup or policy
  (4100 `mainnet_not_allowed`): transactions and auth entries for those networks, and typed data whose domain
  `chainId` is one. Messages, typed data without a `chainId` and raw requests name no network (D35) and are allowed.
  The EIP-1193 provider refuses `wallet_switchEthereumChain`/`wallet_addEthereumChain` to such a chain and
  `eth_sendTransaction`/`eth_signTransaction` on one. The approval and consent screens of a test app say Hana signs
  only for test networks.
- Rejected: a denylist of known mainnets (a new or unlisted chain would be allowed).
- Amended 2026-10-28 (default decided for the user): test apps can't use raw signing at all.
  `hana_signRaw` from a `pk_test_` app is 4100 `raw_not_allowed_for_test_apps` whatever `raw_sign` says, before any
  API read or popup (`packages/web/src/vault/signing.ts`), because a raw digest can be a mainnet transaction's hash.
  Messages stay allowed. The allowlist gains Ethereum Hoodi 560048 and Sonic testnet 14601 (IDs checked against
  ethereum-lists/chains and each chain's official RPC, `eth_chainId` 0x88bb0 and 0x3909).
- Why: testnet MPC keys can be stolen (weaker operator and node standards) or lost (a network reset changes every
  address), and testnet-derived addresses differ from production ones.
- Rejected: allowing mainnet with warnings and small amounts.
- Open: the mainnet launch date (not set).

### D40. Leaving Hana: per-chain key export and Hana Home, no seed phrase
- Date 2026-10-28 · Status: confirmed by the user; Hana Home to build before mainnet · Source: `docs/batch-b-spec.md`
  Q19
- Decision: users leave by exporting each chain's private key (fresh Google sign-in plus typed confirmation). No seed
  phrase, global or per chain, for EVM or Stellar. Before mainnet, Hana runs "Hana Home" on the auth domain: a user
  signs in with Google and can export their keys for any app that uses Hana's shared Google login, so a partner app
  shutting down doesn't strand them. Apps on their own Google client can't be covered (only their origins can get
  tokens for that client).
- Why: private keys import into every major EVM and Stellar wallet (Privy exports keys the same way); a phrase would
  change EVM derivation and add little for these users.
- Rejected: EVM seed phrase export. Deferred (future): a standalone open-source recovery tool that works without
  Hana's servers.

### D41. Key export stays available and mandatory
- Date 2026-10-28 · Status: confirmed by the user · Source: conversation on lock-in
- Decision: export lives in account settings behind its security checks (fresh Google sign-in, typed confirmation);
  it is never removed, hidden behind support, or switchable off by partners. Retention comes from Hana Home as a
  cross-app destination, features (auto-approve, gas sponsorship, no seed phrase) and partner switching cost
  (addresses come from Hana's contract).
- Why: a working exit underpins the non-custodial claim (get legal advice before mainnet) and partner due diligence.
- Rejected: letting partners disable export (Privy allows it); extra delays or friction beyond the security checks.

### D42. Google client tiers: shared by default, Hana-held branded client for Enterprise
- Date 2026-10-28 · Status: confirmed by the user; cross-project `sub` test passed (Workspace and personal accounts) · Source:
  `docs/batch-b-spec.md` Q3, Q37
- Decision:
  - Standard (default): Hana's shared Google client; Google's screen names Hana. Sodax pilots on this.
  - Enterprise: Hana creates and holds a Google Cloud project and client per partner, branded with the partner's name
    and logo, allowing only Hana's popup pages; registered as the scope's own client. Manual onboarding.
  - Partner-held own client: only if a partner insists, with the client locked down (only Hana's popup pages as
    origins and redirect, no native clients) and a written warning that whoever controls that Google project can
    derive its users' keys.
  - Staging uses its own scope (and test keys), so staging wallet addresses differ from production.
- Why: branding never weakens custody. In Hana the Google token unlocks derivation, so a partner holding the client
  could derive its users' keys silently (unlike Privy, where the token only logs in to Privy). A partner moves from
  Standard to Enterprise with the same addresses, since the path has no client ID.
- Condition, met 2026-10-28: the same Google account through clients in two different Cloud projects got the same
  `sub` (`apps/smoke/spike.html` `subFingerprint`; `docs/context.md` spike notes).

### D43. Session lengths: 12 h absolute, 2 h idle by default
- Date 2026-10-28 · Status: confirmed by the user · Source: `docs/batch-b-spec.md` Q5
- Decision: defaults stay 12 h absolute and 2 h idle; partners tune both within the allowed range (≤ 23 h 50 min
  absolute) through app settings. Review after a month of pilot data (logout frequency, re-login cost ≈ 9 s and
  $0.021 each).

### D44. Consent screen: partner names labelled, Hana-verified names marked
- Date 2026-10-28 · Status: confirmed by the user; in force · Source:
  `docs/batch-b-spec.md` Q41
- Decision: the auto-approve consent screen shows a policy's contract names as "named by {app}" with the short address
  and an explorer link. Contracts on Hana's verified list (per chain address → name, starting with Sodax's contracts)
  show a ✓ and the verified name instead. The list is built into the vault and popup bundles (a code release changes
  it, never D1 or the API), and an entry is added only after Hana confirms the address from the protocol's official
  sources.
- Why: partner-chosen names can mislead ("USDC", "Uniswap Router"); addresses alone mean nothing to most users.
- Rejected: partner names as-is; addresses only.
- Built: `packages/core/src/verified-contracts.ts` (frozen list keyed by EVM `chainId` + lowercase address or Stellar
  passphrase + exact contract ID; each entry has its name, sources and date added; explorer URL per chain, test
  networks included) and `packages/web/src/auth/render-consent.ts`. A partner name that reads as a verified name or
  mentions a verified protocol on another contract is flagged ("— not the verified …"); check marks are stripped
  from partner names. Initial entries: Sodax mainnet contracts confirmed by both `@sodax/types@2.1.0` and
  docs.sodax.com/developers/deployments/mainnet (Sonic hub contracts; asset manager and bnUSD on 13 EVM spokes and
  Stellar; Connection on Hedera, Kaia and Robinhood Chain). Addresses only one source lists, or where they disagree,
  are left out.

### D45. Granting auto-approve needs no fresh Google sign-in
- Date 2026-10-28 · Status: confirmed by the user · Source: `docs/batch-b-spec.md` Q40
- Decision: consent stays a guarded click in the Hana popup, per device, ending with the session. Hana Home (D40) will
  list active consents per device and let the user revoke them from any device. A consent that outlives a session,
  if ever added, needs a fresh sign-in.
- Why: whoever can click Allow can already click Approve on any single request, which is more powerful than a capped
  consent; a fresh sign-in would add ~9 s and $0.021 for little protection.

### D46. No token amount caps in auto-approve for the pilot
- Date 2026-10-28 · Status: confirmed by the user · Source: `docs/batch-b-spec.md` Q39
- Decision: policies limit counts, native value plus fees, recipients (address rule) and contracts/functions; token
  amounts aren't capped. Revisit with the Sodax decoder, which can cap per token per day once it decodes token and
  amount.
- Why: in batch B Sodax swaps and bridges always use the popup; `approve` to an unlisted spender is refused; auto-approve
  is off by default, delayed 24 h and needs user consent.
- Rejected for now: per-token caps from generic `transfer`/`approve`/swap decoding.

## Defaults approved by the user, 2026-10-28

Each entry below is a default the user approved on 2026-10-28 (source: conversation, "default approved by the user").
The matching question in `docs/batch-b-spec.md` "Open questions" points here.

### D47. Batch B reconciliations R1–R13 and the remaining batch B decisions confirmed (Q30)
- Date 2026-10-28 · Status: in force · Source: `docs/batch-b-spec.md` "Reconciled conflicts",
  "Decisions (2026-10-27/28)"
- Decision: R1–R13 stand as the spec takes them (two origins; relay-only, end-to-end encrypted token return; vault page
  inlines D1 config and reads `GET /v1/app` lazily; BLS key `a` made after the token arrives; server share plus one
  AES-GCM layer; `max_uses` 1 / 2 / 1; PRK only; export by a fresh login; logout without a transaction; the
  `{v:1,t}` envelope; the encrypted relay plus a defence-in-depth RS256 check; `revoke-all` only within 5 min of a
  fresh login; each tab unlocks itself). Also confirmed as built: the vault iframe plus Hana popups on two origins,
  the token returned only through the encrypted relay, the Google implicit flow, the pinned `signer`/`relayer`/CKD
  key, the vault computing the path, storage partitioning accepted as per-partner isolation, and dev-only privileges
  tied to the env name.

### D48. No silent `app_signed` raw signing in the MVP (Q31)
- Date 2026-10-28 · Status: in force (`raw_sign` is `'off'` or `'approval'` only) · Source: `docs/batch-b-spec.md` Q31
- Decision: raw signing is off or needs an Approve every time. If it comes back, only as requests signed by a
  per-app partner backend key, registered through batch C's fresh-sign-in, logged, notified and delayed process.
- Why: as first specified it was silent signing of chain-valid hashes, controlled by a D1 column.

### D49. A new login supersedes a pending one (Q34)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/vault.ts` `newPending`) · Source: `docs/batch-b-spec.md` Q34
- Decision: `hana_login` while a login is pending ends the old one with `login_cancelled` instead of answering `busy`.

### D50. No local `K_l` wrapping layer (Q35)
- Date 2026-10-28 · Status: in force (the record holds PRK under `K_s` only) · Source: `docs/batch-b-spec.md` Q35
- Why: it stops no named attacker: whoever can read the record and call the API already gets `K_s`.

### D51. Test and live apps never share a scope (Q37)
- Date 2026-10-28 · Status: in force (`scope_conflict`, `apps/api/src/apps.ts`) · Source: `docs/batch-b-spec.md` Q37,
  the "Proposed, not yet confirmed" list
- Decision: loopback origins and partner-origin session endpoints only in `local*`/`sandbox*` envs, and a `pk_test_`
  app on a scope a `pk_live_` app uses is refused. A partner's staging uses its own scope, so different addresses.

### D52. Enabling raw signing uses the origin-change delay (Q38)
- Date 2026-10-28 · Status: in force for raw signing (24 h, `changeDelayMs` in dev envs); batch C reuses it ·
  Source: `docs/batch-b-spec.md` Q38
- Decision: `raw_sign = 'approval'` waits the same 24 h as an origin change (D34); batch C's dashboard puts both
  through the same delayed, logged and notified path. Turning it off is immediate (D68).

### D53. `max_uses = 1` in `'session'` mode (Q14)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/login.ts`) · Source: `docs/batch-b-spec.md` Q14, R6
- Decision: `ckd_failed` or a replayed combined call means a new login. No spare use burnt with `revoke_session`.
- Why: the share precondition ("the session is used up") stays simple; measure the MPC failure rate in the pilot.

### D54. `VAULT_KEK` stays a Worker secret with its copy in `.secrets`; KMS later (Q16)
- Date 2026-10-28 · Status: in force (`scripts/vault-kek.ts` `init`/`rotate`, `VAULT_KEK_PREVIOUS`, the cron re-wrap)
  · Source: `docs/batch-b-spec.md` Q16
- Decision: rotation through `vault-kek rotate`; an HSM/KMS move is revisited with the email issuer (D17).

### D55. The vault zeroes PRK after an in-memory idle period (Q28)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/vault.ts` `goIdle`, `wake`) ·
  Source: `docs/batch-b-spec.md` Q28
- Decision: after the app's `idle_ttl_ms` with no request from the partner page (signing, status, addresses, export,
  auto-approve), PRK is zeroed, not only at the absolute end. In `'session'` mode the next request that needs the key
  unlocks the record again (one API call, same share only), which works while the server share is alive; otherwise,
  and in `'none'` mode, the session ends (`sessionExpired`).
- Why: shortens how long PRK sits in a tab nobody uses, where a renderer bug could reach it (security.md (j)).
- Amended 2026-10-28 (default decided for the user): only requests that use the key count as
  activity (the sign methods, `hana_export`, `hana_revokeOtherDevices`, `hana_requestAutoApprove`). `hana_status`,
  `eth_accounts`, `stellar_getAddress` and `hana_autoApproveStatus` don't, and they keep answering while the session
  is dormant without unlocking it, so a page that polls them can't keep PRK in memory. `hana_autoApproveStatus` would
  need PRK to open the consent in the record (it is sealed under a PRK-derived key), so a dormant session answers it
  from this tab's last known consent (not secret: policy id, end time, counters); its counters can lag auto-signs made
  in other tabs until the next request that uses the key.

### D56. The vault checks its scope against the on-chain registry at login (Q7)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/login.ts` `checkScope`) · Source:
  `docs/batch-b-spec.md` Q7
- Decision: one view through the manifest RPC, started as soon as `GET /v1/app` answers and awaited before anything
  is relayed: own client `scope_for_client('google', aud)` must be the inlined `scopeId`; shared client
  `get_scope(scopeId)` must exist and allow shared login. Mismatch: `config_mismatch` (`scope_mismatch`); no answer:
  `api_unavailable` (`scope_unchecked`).
- Cost: it runs while the user is at Google, so it adds no time to a normal login (estimated 0 ms waited; the view
  itself is one optimistic `query`, ~0.1–0.3 s on testnet RPC). pk_test_ logins report `timings.scopeCheck` (the
  view) and `timings.scopeWait` (time the login actually waited on it), to measure on testnet.
- Limit: the app→scope binding lives only in D1, so an API that names another scope together with that scope's own
  client passes.

### D57. Keep `create_session` (Q12)
- Date 2026-10-28 · Status: in force (contract method kept; relayed only for the split fallback and `apps/smoke`) ·
  Source: `docs/batch-b-spec.md` Q12
- Decision: `create_session` stays a public method, not removed before the audit.

### D58. CODEOWNERS on derivation, vectors, the contract and the env schema (Q23)
- Date 2026-10-28 · Status: in force, paths widened by D100 (`.github/CODEOWNERS`; needs "Require review from Code
  Owners" on `develop` and `main`) · Source: `docs/batch-b-spec.md` Q23
- Decision: `@tzechuen` owns `packages/core/src/derivation*`, `packages/core/test/vectors/`, `contracts/hana-signer/`
  and `packages/env/src/`.

### D59. Key export: only from a Hana window, relayer-paid, rate-limited per user (Q18)
- Date 2026-10-28 · Status: in force (`apps/api/src/login.ts`) · Source: `docs/batch-b-spec.md` Q18
- Decision: a partner page can only ask (`hana_export` shows the vault's launcher); the export window opens only from
  that click and takes its context only from the vault that opened it. Its `/v1/login` is relayed at Hana's cost and
  limited to 3 per hour per `(app, sha256(path))`, counted after the token check and before the relay.

### D60. Two Google sign-ins are acceptable for a `key_index` move (Q20)
- Date 2026-10-28 · Status: confirmed (rotation not built) · Source: `docs/batch-b-spec.md` Q20
- Decision: a k → k+1 sweep needs one sign-in per `key_index`; no contract change to derive two indices per session.

### D61. Account 0 only in the MVP UI (Q21)
- Date 2026-10-28 · Status: in force (the vault signs and derives addresses with account 0 only, `signing.ts`
  `ACCOUNT`; the export window exports account 0; no port method takes an account) · Source: `docs/batch-b-spec.md` Q21
- Decision: `account > 0` stays unused until there is a discovery story.

### D62. A removed policy stops auto-signing within 10 s
- Date 2026-10-28 · Status: in force (`POLICY_FRESH_MS`, `packages/web/src/vault/vault.ts`) · Source: `docs/security.md`
  "Auto-approve policies"
- Decision: an open vault auto-signs only under a policy `GET /v1/app` confirmed less than 10 s ago.

### D63. Permit2 and Uniswap v3 calls need a protocol decoder
- Date 2026-10-28 · Status: in force (the `uint160` rule of D37) · Source: D37, `docs/security.md` (d)
- Decision: their `uint160` fields keep them out of auto-approve until a decoder covers them; the popup handles them.

### D64. The BLS precheck stays off unless measured cheap (Q8)
- Date 2026-10-28 · Status: in force (`BLS_PRECHECK = "0"` in every env) · Source: `docs/batch-b-spec.md` Q8
- Decision: turned on only if a measurement shows its Worker CPU cost is acceptable (Workers Paid plan); the MPC
  refuses a bad key anyway.

### D65. Optional `rpcFallback` for the vault's NEAR reads (Q9)
- Date 2026-10-28 · Status: in force (`packages/env/src/schema.ts`, `packages/web/src/near-call.ts`) ·
  Source: `docs/batch-b-spec.md` Q9
- Decision: the manifest may name a second https NEAR RPC. The vault and the export window read from it only when the
  primary errors or times out (8 s), for `get_session` re-syncs, registry views and tx polling; each read's answer
  comes from one endpoint, never a mix. It joins `rpc` in the pages' CSP.
- Amended 2026-10-28 (decided for the user): sandbox-dev's `rpcFallback` is
  `https://rpc.testnet.near.org` (probed: 200, ~3.5 s); the primary stays `test.rpc.fastnear.com`. Takes effect on the
  next `gen`, page build and deploy.

### D66. One thin Worker per Hana origin (R19)
- Date 2026-10-28 · Status: in force (`apps/api/scripts/pages-wrangler.ts`, `apps/api/src/pages/`) · Source: review
  finding R19 (moved from "Proposed")
- Decision: every env serves `vaultOrigin` and `authOrigin` from one thin Worker each (`workers.dev` in dev envs,
  Custom Domains in production), not from routes on the API Worker, so neither origin can serve the other's files.
  Production runs three Workers.

### D67. The Sodax Stellar adapter signs as `rawTx.from` only (R51)
- Date 2026-10-28 · Status: in force (`packages/sodax/src/stellar.ts`) · Source: review finding R51; the
  "Superseded or amended" row below
- Decision: `signAndSendTransaction(p)` signs with `{address: p.from}`, so a raw transaction built for another account
  (a muxed `M…` address included) is 4100 before any popup.

### D68. Raw signing `'off'` takes effect in open tabs
- Date 2026-10-28 · Status: in force (`GET /v1/app` `rawSign`; `packages/web/src/vault/vault.ts`
  `freshRawSign`) · Source: `docs/security.md` "Auto-approve policies"
- Decision: the vault re-reads `rawSign` before every raw request on the same 10 s bound as the policy; `'off'`
  refuses until a reload, and a failed re-read refuses (fails closed).

### D69. An EVM policy rule needs `maxValueWei ≥ maxFeeWei`
- Date 2026-10-28 · Status: in force (`packages/core/src/policy/validate.ts`) · Source:
  `docs/security.md` (b)
- Decision: the validator refuses a rule whose `maxValueWei` is below its `maxFeeWei` (value plus fees counts
  against it since D37, so it could never auto-approve at its fee cap). The consent screen labels the limits
  "Maximum value plus network fees, per transaction / per day".

### D70. No cookies on Hana origins
- Date 2026-10-28 · Status: in force (`apps/api/src/pages/host.ts` `withoutCookies`; tests in apps/api, packages/web
  and the Playwright suite) · Source: D38 ("no domain-wide cookies")
- Decision: no response from the vault origin, the auth origin or the API sets a cookie; the page Workers drop one a
  binding returns.

### D71. SDK packages ship as built ESM with their envs built in
- Date 2026-10-29 · Status: in force (`packages/*/tsconfig.build.json`, `scripts/lib/sdk-build.ts`,
  `scripts/pack-check.ts`; CI job `packages`) · Source: Sodax needs to install the SDK outside this monorepo
- Decision: `@hana-id/core`, `web`, `react` and `sodax` build with `tsc` (no bundler, no new dependency) to ESM,
  `.d.ts` and source maps with inlined sources (web into `dist/lib`, since `dist/pages` is the page build). The
  workspace keeps `exports` at `src/`; `pnpm pack` swaps in `publishConfig.exports` and rewrites `workspace:^` to
  `^<version>`. `@hana-id/web` carries exactly the `envs/*.json` that set both Hana origins (today `sandbox-dev`);
  its package build fails on an UNSET value, on a local (loopback) env, or on no env. Partners pick one with
  `createHana({ environment })`. Every change is checked by packing, installing with npm into a project outside the
  workspace, type-checking and importing in Node.
- Rejected: tsup or another bundler (not in the lockfile, and per-file output keeps `sideEffects: false` tree-shaking
  and readable stack traces); a runtime env config (would let a page point the client at another vault).

### D72. One lockstep SDK version, set by script; no Changesets
- Date 2026-10-29 · Status: in force (`scripts/sdk-version.ts`, `.github/workflows/publish-sdk.yml`) · Source: SDK
  packaging (D71)
- Decision: the four packages share one version (`0.1.0` first), set with `pnpm --filter @hana-id/scripts
  sdk-version <v>`, which also updates the `VERSION` constants (web's goes to the vault as `sdk`). Publishing is a
  manual-dispatch workflow from `main` with npm provenance, inert until an `NPM_TOKEN` secret exists and the packages
  drop `"private": true`. Not decided: the registry (public npm under an `@hana-id` org, or private) and the licence
  (`UNLICENSED` until then).
- Rejected for now: Changesets. With four packages always released together and one consumer, per-package bump
  files add a dependency tree and a review step without information, and it wouldn't update the `VERSION` constants.
  Revisit if the packages start versioning independently.
### D73. Usage and billing ledger on Neon Postgres in Sydney
- Date 2026-10-29 · Status: confirmed by the user, for batch C · Source: `docs/batch-c-spec.md` "Confirmed by the user"
- Decision: the usage and billing ledger (batch C's `USAGE_DB`) is a Neon Postgres project in `aws-ap-southeast-2`
  (Sydney), reached from Workers through Cloudflare Hyperdrive. Hot app config and console data stay in D1.
- Why: the ledger only grows and must be kept for years (D1 caps a database at 10 GB); reports need percentiles,
  time buckets and materialised views; staff and finance can use standard SQL tools; point-in-time restore is
  included. Sydney because the company is incorporated there (Privacy Act cross-border rules) and a team member is
  there. Neon over Supabase: plain Postgres with no auto-exposed data API to lock down, usage-based pricing, branching
  and restore included.
- Rejected: D1 for the ledger (fine for the pilot, but rollups and archiving would be needed); Supabase (its login,
  storage and data API go unused and add attack surface).

### D74. Files on Cloudflare R2
- Date 2026-10-29 · Status: confirmed by the user, for batch C · Source: `docs/batch-c-spec.md` "Confirmed by the user"
- Decision: partner logos, monthly statements and ledger exports live in R2 in the Hana Cloudflare account. Logos are
  served from a Hana origin with strict headers; Hana never shows a partner-hosted image in its popups.
- Rejected: Supabase Storage (a second place to secure for no gain).

### D75. Three sign-in audiences; no third-party auth service
- Date 2026-10-29 · Status: confirmed by the user, for batch C · Source: `docs/batch-c-spec.md` "Confirmed by the user"
- Decision: wallet users sign in with Google in Hana's popup, verified on chain. Partners use the console's own Google
  OIDC code flow (PKCE), invite-only, owner/viewer roles, server sessions stored as hashes, and a fresh sign-in bound
  to each security-critical change. Hana staff reach the admin console through Cloudflare Access (members of a
  `Hana-Technology` GitHub team with org 2FA required; exact-email Google rules as fallback), and the admin Worker
  verifies the Access JWT on every request.
- Why: the Google ID token is the on-chain owner proof, so an auth service in between adds a party that could
  impersonate partner owners while we still handle Google's token; Access keeps the admin console off the internet and
  hands MFA and offboarding to GitHub/Google.
- Rejected: Supabase Auth (used for Wend's admin portal), Clerk, Auth0, WorkOS; Access for partners (no self-service
  invites, branding or on-chain proofs; per-seat cost past 50 users).

### D76. Keep the one-transaction login (ship gate passed)
- Date 2026-10-29 · Status: confirmed by measurement under the rule set in D26 · Source: `docs/context.md` "Login
  timings with stage breakdown"
- Decision: `create_session_and_derive` stays. Over 10 interleaved runs each, it saved 2.44 s of chain time at the
  median against `create_session` + `derive_key`, above the 1.5 s bar.

### D77. The login popup makes no API call; it trusts the vault's app facts
- Date 2026-10-29 · Status: in force (`packages/web/src/auth/login-page.ts`; `/login` CSP without `connect-src`,
  `packages/web/src/auth/pages.ts`, `apps/api/src/pages/host.ts`) · Source: `docs/context.md` "Login timings with
  stage breakdown" (`authCheck` 1.05 s); reasoning in `docs/security.md` "The login popup trusts the vault's app facts"
- Decision: `/login` no longer calls `GET /v1/app` before going to Google. It uses the app name, parent origin, scope
  and Google client from `hana:auth-params`, which it accepts only from the authenticated preparer (the vault on
  `vaultOrigin` by `event.origin` and `event.source`, or `/export` on `authOrigin`), and still checks the pinned
  `SIGNER` and recomputes the nonce. Its CSP drops `connect-src` (it fetches nothing).
- Why: its own read added nothing a malicious party could not already get around. A compromised `vaultOrigin` or API
  Worker already has every key (`docs/security.md` "What a compromise gives"), and the popup's read went to the same
  API. The only things it caught were a vault config gone stale since the page loaded (app suspended, origin removed,
  Google client changed), and `POST /v1/login` refuses all of those anyway before anything is relayed (app gate on the
  current D1 row, `x-hana-parent-origin`, `checkClientScope`, the contract's scope check, the vault's registry check
  D56). So such a login now fails after Google rather than before it. Measured cost removed: about 1.05 s per login.
- Rejected: keeping the read but running it in parallel (the popup navigates to Google at once, which cancels it, and
  moving it to the callback would put it back on the critical path for no added check).

### D78. The vault endpoints cache the app per isolate for 30 s; the share limit runs alongside the gate's
- Date 2026-10-29 · Status: the app cache in force (`apps/api/src/app-cache.ts`, `apps/api/src/vault/endpoints.ts`
  `vaultApp`); the share limit alongside the gate's, with its refund, superseded by D95 · Source: `docs/context.md`
  "Login timings with stage breakdown" (unlock gate 0.24 s)
- Decision: `/v1/vault/*` reads the app (`getAppByKey`, two D1 queries) from an in-isolate cache whose entries live
  30 s from the D1 read (at most 256 apps; unknown keys and failed reads never cached). Nothing in the Worker writes
  `apps`, so the bound is the TTL: a suspension, a removed or changed publishable key, a removed origin, a scope
  conflict or a plan change reaches the vault endpoints within 30 s per isolate. The relay endpoints, `GET /v1/app`
  and the vault page still read D1 every time, so a suspension stops logins (gas) and new vault loads at once. Rate
  limits keep their order and counts: the IP window, then the app window only once the IP window accepted (so a
  request the IP refuses never holds any of the app's shared quota); the share window (`share:<id>`, 10/min) is asked
  alongside them and refunded when the IP or app window refuses, so it counts exactly as before.
- Why: a reload's unlock paid the D1 reads and three limiter round trips one after another; a warm unlock now pays two
  limiter round trips. Suspension and key removal are operator actions where 30 s is acceptable; nothing on the vault
  endpoints spends gas.
- Rejected: asking the IP and app windows in parallel with a refund (a client the IP window refuses would hold app
  quota while its requests are in flight, so one client with many requests open could lock out every user); caching
  for the relay endpoints (a suspension must stop spending at once); an invalidation signal (no Worker code changes
  apps today; revisit with batch C's console).

### D79. Login success is reported before the share is made
- Date 2026-10-29 · Status: in force (`packages/web/src/vault/vault.ts` `finishLogin`, `persistLogin`) · Source:
  `docs/context.md` "Login timings with stage breakdown" (`persist` 0.48 s); amends `docs/batch-b-spec.md` "Login"
  steps 11–12
- Decision: in `'session'` mode the vault replies to `hana_login` (and emits `accountsChanged`) as soon as PRK and the
  addresses exist, with `persistence: 'session'`, then makes the share (`POST /v1/vault/shares`, tried once more after
  1 s) and the IndexedDB record in the background. If that gives up, the session keeps working in memory,
  `hana_status` reports `persistence: 'none'` and the vault emits `persistenceChanged {persistence: 'none'}` (the
  client's `hana.persistence` and `useHana()` follow), the share (if made) is revoked, the older session's record this login
  replaces is deleted and its share revoked (the next reload is a full login), and the vault logs a reason code
  (`console.warn`, no ids or keys). A session that ends first (logout, a newer login, expiry, idle, a revocation)
  cancels it: no record is left and a share made for it is revoked; logout doesn't wait. Revoke-other-devices, touch
  and every consent read or write wait for it to settle.
- Why: about 0.48 s off every login, and the share only matters at the next page load.
- Given up: a reload within that window (about one API round trip after the login reply) is a full login; the login
  result's `persistence` is the mode intended, and `persistenceChanged` / `hana_status` say if it didn't happen. Share timings are no
  longer in the login's timings (`persist`, `shareRtt`, `shareServer*` removed); the API's request log still has them.
## Governance and batch C, confirmed by the user 2026-10-29

Each entry below was decided by the user on 2026-10-29 (source: conversation, "confirmed by the user"). D80–D86
answer `docs/governance-spec.md` "Open questions" and D87–D93 answer `docs/batch-c-spec.md` "Open questions"; each
answered question there points here.

### D80. Governance delays: issuer keys 2 h (provisional), governance 72 h on mainnet
- Date 2026-10-29 · Status: confirmed by the user (mainnet issuer-key delay provisional), not built · Source:
  `docs/governance-spec.md` "Delay length", open question 1
- Decision: mainnet `issuer_key_delay_ms` = 2 h, provisional: it is set by the spec's formula from the lead-time
  measurement now running (`admin issuer-keys:lead-times`) once two Google rotations are recorded.
  `governance_delay_ms` = 72 h on mainnet (upgrades, owner transfer, a new watchdog's confirm power, delay decreases,
  surplus withdrawals). sandbox-dev: 2 min and 60 s.
- Why: 72 h gives partners and users time to see an upgrade and export keys (D41). A paused contract waiting up to
  72 h for a fix is accepted: fast emergency response comes from pause (owner or watchdog, at once; the owner unpauses
  at once), not from short delays.
- Rejected: a governance delay short enough to ship fixes fast (it shortens everyone's reaction window; pause covers
  emergencies); fixing the issuer-key delay before Google's lead time is measured.

### D81. Owner multisig: Sputnik DAO v2, 2-of-3 for every proposal kind
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/governance-spec.md` "Owner = multisig",
  open question 2
- Decision: the contract owner is a Sputnik DAO v2 council: 2 of 3 votes for **every** proposal kind (function calls,
  policy, member changes, the DAO's own upgrades); only council members propose. Mainnet council: the two founders
  (each on a Ledger) and one offline backup key that neither founder can reach alone, held by a third party (e.g. the
  company's lawyer or accountant, under written instructions) or in a dual-control safe deposit box; where it is held
  is decided before mainnet. The backup is replaced by an independent member later. sandbox-dev: Sputnik 2-of-3 with
  three throwaway testnet member accounts whose keys live in `.secrets/sandbox-dev/` (0600) and that scripts drive
  (propose and approve in one command); `near-workspaces` sandbox tests cover the full flow.
- Why: 3-of-3 for policy would freeze the council if one Ledger is lost; the contract's 72 h governance delay (D80)
  and the watchdog's alerts (D85) already guard every owner action.
- Rejected: 3-of-3 for policy and member changes (the draft); `multisig2` on the owner account (no named audit, no UI,
  little maintenance); a backup key either founder can reach alone (that founder would hold 2 of 3).

### D82. The watchdog acts alone only on clear forgeries; the owner unpauses at once
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/governance-spec.md` "Watchdog service",
  open question 4
- Decision: on its own the watchdog cancels any pending issuer key Google doesn't publish (kid absent from two
  fetches ≥ 60 s apart, or other key material), deletes every updater key when the updater proposed such a key, and
  pauses **only** when a key Google doesn't publish is active on chain. It also confirms keys that match Google's JWKS
  (D86). Everything else is alert-only (D85), including a pending removal of a kid Google still publishes. The owner
  multisig can unpause at once, with no governance delay.
- Why: these responses are unambiguous and DoS-only; anything that needs judgment waits for a human, so a buggy or
  rogue watchdog can at most delay a rotation or stop logins until the owner unpauses.
- Rejected: an alert-only watchdog (a forged key goes live if nobody answers within the delay); pausing on any anomaly
  (too much DoS power for one service).

### D83. Every watchdog check and alert surfaces in the admin portal (standing rule)
- Date 2026-10-29 · Status: confirmed by the user (requirement and standing rule), not built · Source: conversation;
  `docs/governance-spec.md` "Monitoring in the admin portal"
- Decision: the admin console gets a "Security & monitoring" view: watchdog heartbeat and last check, with a warning
  when it has been silent past its interval; pending issuer-key changes with a countdown and whether each matches
  Google's JWKS; the watchdog's actions log; pause state and the updater keys; pending upgrades and owner actions with
  countdowns; alert history with acknowledge. **Standing rule:** every future watchdog check or alert must surface in
  the admin portal; a check without its portal view isn't done. The watchdog still sends its own alerts (D85), so a
  compromised Hana Cloudflare account can't silence it; the portal reads the watchdog's status and on-chain state and
  events.
- Why: one place for staff to see governance state; the portal is a view, never the alert path.
- Rejected: alerts only through the portal (it runs in the account an attacker would want); a watchdog with no status
  surface.

### D84. No independent upgrade guardian at launch
- Date 2026-10-29 · Status: confirmed by the user · Source: `docs/governance-spec.md` open question 8
- Decision: only the owner can cancel a pending upgrade. The watchdog sends a critical alert on every upgrade
  proposal. Revisit when an independent party exists (the auditor, a partner).
- Why: a guardian helps only if it is independent of the founders; none exists yet. The 72 h delay, the public event,
  the alerts and key export (D41) remain.
- Rejected: the watchdog as guardian (run by Hana, so not independent; a compromised watchdog could block every fix).

### D85. Alert severities: critical, warning, info
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/governance-spec.md` "Alerts", open
  question 15
- Decision: **critical** goes to a phone paging app (PagerDuty, Pushover or ntfy, chosen at setup), Slack and email,
  to both founders, and is re-sent every 15 min until acknowledged; acknowledgements are recorded in the admin portal.
  **Warning** goes to Slack and email. **Info** goes to the admin portal and a daily digest. The watchdog sends them
  itself.
- Why: a forged key or an upgrade needs a human within the delay, at any hour; two people and three channels mean one
  outage or one person asleep doesn't hide it.
- Rejected: email only; one severity for everything.

### D86. Governance spec: the remaining open questions take the spec's proposals
- Date 2026-10-29 · Status: defaults approved by the user, not built · Source: `docs/governance-spec.md` open
  questions 3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 16
- Decision, by question:
  - Q3: the watchdog runs on its own Cloudflare account (separate login and MFA); one watchdog at launch.
  - Q5: one watchdog may confirm (activate early) a key that matches Google's JWKS; k-of-n confirmers later.
  - Q6: removing a watchdog slows key changes to `governance_delay_ms` unless another watchdog confirms; accepted.
  - Q7: pause blocks derivation and new sessions: every token path (sessions, scope registration, token-authenticated
    owner actions), `derive_key`, and the executors (`execute_change`, `execute_issuer_key_change`); never
    governance, revocation, cancels or views.
  - Q9: sandbox-dev keeps the signer's full-access key (speed); any staging env and mainnet never have one.
  - Q10: an owner-only withdrawal of surplus NEAR from the signer (above storage plus a reserve), timelocked by
    `governance_delay_ms`.
  - Q11: public notice of an upgrade or owner change = the on-chain event, an email to every partner (the orgs'
    security contacts), and a pending-upgrades page in the admin and partner consoles.
  - Q12: owner-posted issuer keys wait the same `issuer_key_delay_ms` as the updater's.
  - Q13: `set_console_audiences` additions wait `change_delay_ms`; removals stay immediate.
  - Q14: every mainnet `propose_upgrade` needs a reproducible build, its hash published before the proposal.
  - Q16: events version `1.1.0`, additive.
- Rejected: the alternatives each question listed.

### D87. Email: Resend, from a dedicated sending subdomain
- Date 2026-10-29 · Status: confirmed by the user, provisional: to re-confirm with the colleague (2026-10-29), not built · Source: `docs/batch-c-spec.md` "Email", open question 2
- Decision: Resend, sending from a dedicated subdomain of the Hana domain with SPF, DKIM and DMARC, behind a small
  sender interface (send one message → accepted or an error) so switching (e.g. to Postmark) is one adapter. The
  admin Worker's fail-closed notices count a send as done only when Resend accepts it. The watchdog sends its alert
  emails with its own Resend API key, not the admin Worker's.
- Why: sends to any address from a Worker over HTTPS; the subdomain keeps notice reputation apart from the main
  domain's mail.
- Rejected for now: Cloudflare Email Sending, Postmark (the fallback behind the interface), SES.

### D88. Admin access: GitHub team `hana-admins`, exact-email fallback, staff allowlist kept
- Date 2026-10-29 · Status: confirmed by the user (fallback addresses to come), not built · Source:
  `docs/batch-c-spec.md` "Hana admin console", open question 4
- Decision: the Cloudflare Access policy includes the GitHub team `hana-admins` in `Hana-Technology`, with 2FA
  required org-wide, and a fallback rule of exact Google email addresses (the user provides them later; never a domain
  rule). The admin Worker keeps its own `admin.staffEmails` allowlist as a second check on every request.
- Why: GitHub carries MFA and offboarding; with the allowlist, one mistaken Access edit alone lets nobody in. The cost
  is offboarding in two places.
- Rejected: dropping the Worker allowlist; a domain rule; the draft's assumed team name `hana-id-staff`.

### D89. Owners invite teammates; a new owner is a viewer for 24 h (amends D29)
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/batch-c-spec.md` "Invites", open
  question 6
- Decision: still invite-only, no sign-up. Hana creates orgs and invites the first owner. Owners can then invite
  viewers and owners to their own org. Every invite needs a fresh Google sign-in and notifies every owner and security
  contact of the org. A new owner is a viewer for 24 h, then becomes an owner unless cancelled (by an owner, Hana
  staff, or the cancel link in the notice). Hana staff can add and remove members in the admin portal.
- Why: partner self-service for teammates without a Hana ticket; the wait and the notice give the other owners and
  contacts the same window as guarded changes, so a hijacked owner account can't quietly add a co-owner.
- Rejected: Hana-issued invites only (D29 as first written); owner invites without the 24 h wait.

### D90. Retention: statements 7 years, raw usage 24 months, audit 5 years
- Date 2026-10-29 · Status: confirmed by the user; periods to be confirmed by the company's accountant before launch;
  not built · Source: `docs/batch-c-spec.md` "Retention", open question 10
- Decision: monthly statements and settlement records (statement files, `usage.statements`, `near_usd_rates`,
  `gas_settlements`) 7 years. Raw usage events 24 months; then the uid hash is removed and the de-identified rows are
  kept. Audit logs (`audit_log`, `app_changes`, `guarded_changes`) 5 years. An automatic monthly purge job applies it,
  and the admin portal shows its runs.
- Why: Hana is an Australian company: the ATO requires business records for 5 years, and APP 11 (Privacy Act) requires
  personal information to be destroyed or de-identified once no longer needed. 7 years leaves room for disputes over
  billed periods.
- Rejected: the draft's 400-day ledger and 36-month audit (shorter than the ATO's 5 years); keeping uids for good.

### D91. Gas of relayed-then-rejected calls isn't billed by default
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/batch-c-spec.md` open question 11
- Decision: not billed by default; shown as its own statement line. The admin portal alerts when a partner's
  rejection rate exceeds a threshold (provisional: 5% of relayed attempts). Contract terms may bill partner-caused
  rejections above it.
- Why: third parties can trigger rejections (~2.2 Tgas each, e.g. replays of public signed derives), so billing them
  by default charges partners for others' traffic; the alert catches a partner bug that causes them.
- Rejected: billing every rejected call; hiding the cost inside the gas total.

### D92. Statements: CSV, on-screen and PDF with the same totals and hash
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/batch-c-spec.md` "Monthly statements",
  open questions 14 and 16
- Decision: each frozen monthly statement is a CSV, an on-screen statement (admin and partner consoles) and a PDF
  generated with `pdf-lib`; all three carry the same totals and the statement hash (the CSV's sha256). Tax invoices
  come from the accounting software and quote the statement.
- Why: finance teams want a PDF; one hash ties the three together; Hana ID doesn't invoice (D31).
- Rejected: CSV only; invoices issued by Hana ID.

### D93. Batch C spec: the remaining open questions take the spec's recommendations
- Date 2026-10-29 · Status: defaults approved by the user, not built · Source: `docs/batch-c-spec.md` open
  questions 7, 8, 12, 13, 14, 15, 17–25 and part of 3
- Decision, by question:
  - Q3 (part): sandbox-dev runs on `workers.dev` with the thin-Worker origins until the Hana account exists.
  - Q7: the console sink scope, rolled out on sandbox-dev before the address freeze.
  - Q8: seven Workers (console-auth and files as thin Workers, D66).
  - Q12: production `change_delay_ms` 24 h (= `appChangeDelayMs`); partners don't set their own delays in batch C.
  - Q13: the daily nonce cross-check as read (each relayer key's latest landed nonce must have a ledger row); daily,
    no indexer.
  - Q14: `pg` and `pdf-lib` as runtime dependencies, exact-pinned.
  - Q15: logos PNG, JPEG or WebP only, re-encoded (Cloudflare Images binding), never SVG.
  - Q17: a daily NEAR/USD rate from a single source (e.g. CoinGecko) named in the service contract, with an audited
    manual override; testnet pilot statements valued at the mainnet price and labelled.
  - Q18: no hash chain in the MVP; the accounts are the trust root.
  - Q19: coarse network data on console sessions for 90 days.
  - Q20: Cloudflare's Workers rate-limiting binding in the console Worker; the API's `RateLimiter` only if the binding
    isn't available on the account's plan.
  - Q21: breaker 5 per org and 20 across orgs per hour, counted per call.
  - Q22: settlement reads `tx` once per relayed transaction; revisit at scale.
  - Q23: owner-action caps as designed (20 per scope per day; safety budget 10 per scope per day, 100 global).
  - Q24: no two-staff rule for staff proposals in the MVP.
  - Q25: partners test locally against a Hana-run testnet env with its own console; production keeps refusing
    loopback.
- Still open: Q1 (the console code flow's `openid`-only token, to test), Q3 (Hana Cloudflare account, zone, domains,
  who holds access), Q4's fallback email addresses, Q5 (Neon project setup), Q9 (moved to `docs/governance-spec.md`
  open question 17).
- Rejected: the alternatives each question listed.

### D94. Smart Placement for the API Worker
- Date 2026-10-29 · Status: superseded by D97 (fixed region) · Source: `docs/operations.md` "Logs and
  latency"
- Decision: the API Worker's generated config sets `placement: { mode: "smart" }`, so Cloudflare runs it near D1
  and the Durable Objects (APAC) rather than at the request's location.
- Why: from Malaysia, about 60% of workers.dev requests were served from Marseille; with D1 in APAC every serial
  query crossed continents, taking reload unlock from about 0.9 s to 2–3 s.
- Next if not enough: D1 read replicas (Sessions API); a custom domain once the Hana domain exists.

### D95. The vault's per-IP and per-share flood limits use Cloudflare's Rate Limiting binding
- Date 2026-10-29 · Status: in force on branch `perf/native-ratelimit`, not yet deployed (`apps/api/src/vault/limits.ts`,
  `apps/api/src/vault/endpoints.ts` `vaultLimits`, `shareLimit`; `ratelimits` written by
  `apps/api/scripts/gen-wrangler.ts`) · Source: sandbox-dev re-measure after D94 (`unlockServerGate` 0.12–0.13 s in
  some runs, 0.60–0.73 s in most: the limiter object round trips)
- Decision: on `/v1/vault/*` the per-IP limit (60/min per IP per app) and the per-share limit (10/min per share) move
  from `RateLimiter` objects to two Workers Rate Limiting bindings, `VAULT_IP_LIMIT` (namespace `95001`, 60 per 60 s)
  and `VAULT_SHARE_LIMIT` (namespace `95002`, 10 per 60 s). Keys are `<env>:vault-ip:<appId>:<ipSubject>` and
  `<env>:vault-share:<appId>:<shareIdHex>`. The order is the one before D78, with no refund: IP limit, then the
  app's vault quota (still the `app:<id>` object, 10 × `per_minute`), then the body, then the share limit, so a
  request the IP limit refuses never touches the app quota and the share limit counts only requests that passed
  both. `RateLimiter.refund` is removed. A refusal is still `429 rate_limited` with the same messages; its
  `retry-after` is the binding's period (60), since the binding doesn't say when its window ends. A binding that
  throws refuses (`503 rate_limiter_unavailable`). An unlock now makes one limiter object call (the app's), not two.
- Effective change: nominal limits and periods are the same (both were per minute; the binding allows 10 or 60 s).
  The bindings count per Cloudflare location and are approximate (eventually consistent, can admit more than the
  limit while counts sync), where the objects counted globally and exactly. That is acceptable for flood limits:
  a share action still needs the session key's signature over a fresh counter, and the app quota, which bounds what
  one client can take from every other user of the app, stays exact. With Smart Placement (D94) most requests run in
  the placed location, so per-location counting is close to global in practice.
- Stays on the `RateLimiter` object (exact, global): the vault's per-app quota; the relay endpoints' and
  `GET /v1/app`'s limits (per IP, per app minute and day); key exports (3/hour per user path, D59); the login
  relay's per-IP limits; owner actions (per IP and global) and the owner-token single-use markers. These are either
  quotas other users share, limits small enough that drift matters, or test-and-set state the binding can't hold.
- Plan and tests: Cloudflare's docs (bindings page, Workers pricing and limits) list no plan restriction for the
  binding and no charge beyond Worker requests; GA since 2025-09-19, wrangler ≥ 4.36. It can't be confirmed on the
  free sandbox-dev account without a deploy: a deploy the plan refused would fail as a whole, never run without the
  limits. Miniflare simulates it locally (`wrangler dev`, `@cloudflare/vitest-plugin`), counting exactly, so the
  tests exercise the real limits.
- Rejected: asking the IP and share objects in parallel and the app after (D78's shape, still one extra hop and
  the refund); moving the app quota to the binding (it is shared by every user of the app and must be exact);
  a 10 s period (60 per minute as 10 per 10 s would refuse bursts the minute limit allows, such as several users
  behind one address reloading at once).

### D96. Support ID for end users; Hana contacts only partners
- Date 2026-10-29 · Status: confirmed by the user, for batch C and Hana Home · Source: conversation on support
- Decision: Hana keeps contact details only for partners and their staff (members, security contacts, billing
  contact). End users are never contacted by Hana and no user email is stored. For support, users get a **Support
  ID**: a short code (e.g. `HANA-7F3K-92QD`) derived from the app's hashed user id (HMAC with a Hana secret), shown in
  the Hana popup and Hana Home and included in "Copy diagnostics". Staff paste it into the admin portal to see that
  user's sessions, logins, errors and consents; it reveals no email or Google account and only works with Hana's
  secret. Partners escalate with the Support ID plus request IDs.
- Rejected: an opt-in user contact email (partners own user communication).
- Amended 2026-10-30 (email login, D119; not built): Hana still stores no end-user email address (the Google email
  is handled transiently off chain at link time, only its HMAC kept, D25). It still never contacts users except for
  two kinds of message the user's own action triggered: sign-in codes and link notices, sent to the address while
  the issuer holds it in that call. No encrypted address is kept for security notices; those are in-product only.

### D97. The API Worker runs in a fixed region next to D1 (replaces D94's Smart Placement)
- Date 2026-10-29 · Status: deployed to sandbox-dev · Source: `docs/operations.md` "Logs and latency"
- Decision: `placement: { region: "aws:ap-east-1" }` (Hong Kong, where Smart Placement had put it beside D1 APAC).
- Why: Smart Placement only forwards from locations it has learned (up to 15 min of steady traffic after each
  deploy); requests entering in CDG or MRS ran there and paid a Europe–Asia trip per D1 query. With the pin every
  response showed `cf-placement: remote-HKG`.
- Remaining: from Malaysia most workers.dev requests enter in FRA/CDG, so each request still crosses to Asia once
  (about 1–1.7 s for `GET /v1/app`, 0.36 s when it enters in SIN). Fix by routing: a custom domain on a Hana zone,
  tested on the free and a paid plan.

### D98. Hana Home: the spec's open questions answered
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/hana-home-spec.md` "Confirmed by the
  user"
- User decisions: Enterprise branded clients kept alive ≥ 2 years after a partner leaves, with a contract right to
  enable shared login at exit (Q3); no opt-out from Home access, Enterprise may choose a quieter listing (Q8); Home
  derives billed to an active partner as their own statement line, Hana pays after exit (Q12).
- Defaults approved: directory only; partner-held clients best effort; `disable_shared_login` delayed (contract
  change); keep a shared client in force; one login opens both chains' export for ≤ 5 min; no re-auth to view;
  "Sign out this device"; coarse device labels; the proposed limits; consent recording fails closed; Home signs in
  with the first shared client; `/home` on `authOrigin`; legal review before mainnet.

### D99. The approval popup opens in the partner's click; the launcher is the fallback
- Date 2026-10-29 · Status: in force (`packages/web/src/client/approval-window.ts`, `src/auth/approve-page.ts`,
  `src/vault/approvals.ts`; `hana:approve-close`, `popupOpened` and `approvalWindow` in
  `packages/core/src/protocol.ts`) · Source: conversation (decided by the user); amends `docs/batch-b-spec.md`
  "Approval flow" steps 1–3
- Decision: when a partner calls a signing method (the EIP-1193 signing methods, `hana.stellar` and the Stellar
  Wallets Kit module, `signRaw`, `requestAutoApprove`, the Sodax adapters) from a user's click, the SDK opens
  `{authOrigin}/approve?from=partner&v=<vault frame name>` (`hana-approve-<32 hex>`, `popup,width=420,height=680`)
  synchronously in that click, as login does, and flags the request `popupOpened`. It does so only with transient
  user activation (`navigator.userActivation.isActive`; when the API is missing it tries anyway), and opens nothing
  while an approval popup is already open (its own, or the vault's, reported by `approvalWindow`), which is reused.
  The popup finds the vault through `window.opener.frames[v]` and accepts messages only from it, authenticated as the
  login popup does (origin `vaultOrigin`, that exact frame, whose parent is the opener); the vault accepts the
  popup's hello only from `authOrigin` and a window whose opener is its parent. From then on the protocol, the digest,
  the guard and the 15 s reuse are unchanged. The vault adopts the popup for the head of its queue (requests already
  queued keep their order), holds its launcher up to 3 s for the hello of a flagged request, tells a second window
  to close while one is in use, and tells a popup that has shown nothing to close (`hana:approve-close`) when its
  request ends without an approval screen (auto-approved or refused), on arrival if its hello comes later (within
  8 s). The popup stays blank for 0.6 s and closes itself after 8 s if no request reaches it.
  `hana.prepareApproval()` opens the window early for a signing call made after an await (a quote fetch). Without
  activation, or when `window.open` returns null (Safari after an await, a popup blocker), the vault's "Review in
  Hana" launcher works as before.
- Why: one click less on every signature, the same as login, and no small button to find; Safari keeps working
  through the fallback.
- Security: the partner page holds a WindowProxy to the popup and can navigate or close it; that is no more than a
  malicious page opening its own fake popup, since users trust the popup's address bar (`authOrigin`), and the popup
  never shows or answers anything but the authenticated vault. The guard (D36) is unchanged. `docs/security.md`
  "Approval popup opened by the partner page".
- Rejected: opening the popup only from the vault's launcher (an extra click per signature); having the partner page
  relay requests to the popup (the popup would have to trust the partner page).

### D100. Security sweep fixes (API, operator tooling, CI): quotas after verification, owner-action caps per owner and scope, CKD key from three providers
- Date 2026-10-29 · Status: in force (branch `fix/sweep-api`) · Source: security sweep 2026-10-29 (OPER-1, APIW-1,
  APIW-3, OPER-2, OPER-3, APIW-4, APIV-3, APIV-7, OPER-5, OPER-6, OPER-11; `docs/security.md` "Security sweep
  2026-10-29"); owner answers of the same day; amends D58
- Decision:
  - **CKD network key pin (OPER-1).** `fetch-ckd-key` reads the MPC key at one final block from at least three
    independent RPC providers (distinct registrable domains: the manifest's `rpc`, `rpcFallback`, each `--rpc`, then
    built-in public endpoints) and writes nothing unless every one reports the env's chain, the same block hash and
    the same key; the block height, hash and provider hosts are recorded as `ckdNetworkKeySource`. The manifest
    schema requires https for `rpc`, `rpcFallback` and `apiUrl` outside `local*` envs (there, http only for a loopback
    host). Before a mainnet pin the key is also compared with NEAR's published MPC key material.
  - **Relay quota (APIW-1).** The app's `per_minute` / `per_day` quota is counted only for a request that passed
    every off-chain check, right before the relay; only the per-IP window is asked before verification.
  - **Owner actions (APIW-3).** Caps per owner identity (5/min, 30/day), per scope (10/min, 50/day) and global
    (20/min, 200/day) for authenticated actions; `execute_change` (no auth) has its own per-scope window (10/min,
    50/day) and the global one; `cancel_change` counts against none of these, only 5/min, 20/day per owner identity,
    25/min, 100/day per target scope (the contract's `MAX_OWNERS` at their cap) and a spend-bound ceiling of 100/min,
    1000/day. Windows are asked from the most specific in and a refusal takes back the earlier hits. A cancel or any
    authenticated action without an owner identity is refused.
  - **Secret scan (OPER-2).** `.gitleaks.toml` has rules for NEAR secret keys, `VAULT_KEK` values, Worker-secret
    lines and Hana's secret files by name; `scripts/secret-scan-selftest.mjs` proves them on generated fakes in the
    tests and in CI.
  - **CODEOWNERS (OPER-1, OPER-3; amends D58).** Also `/envs/`, the API, web, core and watchdog sources, `scripts/`,
    the lockfiles, `.gitleaks.toml`, `.githooks/` and `.github/`. A second owner is decided; their handle is a TODO
    until known.
  - **Smaller fixes.** `/v1/derive` checks the app key's shape always (APIW-4). The API Worker's Workers Logs keep its
    own lines but not invocation records, which carry relay ids in the URL (APIV-3). Relay errors never return RPC or
    runtime error text. The admin CLI refuses origins the API drops, Hana's own origins and loopback origins for
    `pk_live_` apps or outside dev envs, and app names with control, bidi or zero-width characters (OPER-6, OPER-11);
    the API never treats the literal `http://localhost:*` as an origin (APIV-7). `gen-wrangler --dev-vars` refuses
    readable secret files and writes `.dev.vars` fresh (OPER-5).
- Why: each closed a way to break a trust anchor (a lying RPC at pin time), deny service with public inputs (junk
  against a shared quota, one owner starving another scope's cancel window), or leak a secret past the controls
  meant to stop it (gitleaks missing every Hana secret shape, relay ids in platform logs).
- No address or key derivation changes: sandbox-dev's pinned key was re-read from three providers and is unchanged.
- Rejected: a per-app pre-verification flood window (junk could still lock the app out); one global cancel ceiling
  (any scope's owners could starve another's cancels); recomputing `owner_action_nonce` off chain now (needs a borsh
  port of `Change`; the caps already confine a wrong-nonce flood to its owner's own windows; still worth doing).

## Security sweep fixes: core, web and SDK (2026-10-29)

From the security sweep of `develop` @ 91609c4 (findings CORE-*, AUTH-*, VAUL-*, PART-*). Numbered from D110 so they
can't collide with the entries the parallel API, contract and watchdog fixes add from D100.

### D110. Stellar classic operations are decoded; account-control operations get a red warning and are never auto-approved
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/core/src/decode/stellar.ts`
  `stellarAccountControl`, `src/policy/match.ts`, `src/policy/validate.ts`; `packages/web/src/auth/render-approval.ts`)
  · Source: user decision on sweep finding CORE-1; amends `docs/batch-b-spec.md` "Approval flow" step 4
- Decision: the decoder reads every operation type the XDR defines, field by field: `setOptions` (signer key,
  type and weight, added or removed; master weight; low, medium and high thresholds; set and clear flags by name;
  home domain, shown as hex when it isn't display-safe; inflation destination), `accountMerge` (destination), path
  payments strict send and receive (send asset and exact or maximum amount, destination, destination asset and
  exact or minimum amount, path), offers, `allowTrust`, `manageData`, `bumpSequence`, claimable balances,
  sponsorship, `clawback`, `setTrustLineFlags` and liquidity pools. An operation type the library doesn't know is a
  decode error (the popup refuses the request) instead of a raw-XDR line.
- Account control: a `setOptions` that touches a signer (any weight, 0 included), a threshold or the master weight,
  and every `accountMerge`, is an account-control operation. The popup puts a red, bordered banner at the top of the
  transaction ("Danger: this transaction changes who controls a Stellar account…") and one warning per operation
  that names the new signer and its weight, the thresholds, the master weight (weight 0: "you lose control of it")
  or the merge destination ("It can't be undone"). The matcher refuses them first, whatever the policy lists
  (`account_control`); the validator refuses a Stellar section with a key naming classic operations
  (`operations`, `setOptions`, `accountMerge`, `signers`, `payment`, path payments, …) on top of the unknown-key
  refusal. Everything is still rendered with `textContent`.
- Not done: an extra confirmation step on top of the warning (the Approve guard, D36, still applies).
- Rejected: keeping "shown by type with raw XDR" for classic operations (a compromised partner page plus one click
  could add a signer or merge the account away).

### D111. The export window keeps the key 5 minutes at most, and never past the session
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/auth/export-page.ts`
  `EXPORT_KEY_LIFETIME_MS`, `end`; `packages/web/src/vault/vault.ts` `cancelExport`, `onExportHello`;
  `hana:export-end` and `export-context.sessionExpiresAtMs` in `packages/core/src/protocol.ts`) · Source: user
  decision on sweep finding AUTH-1 (merged with VAUL-5); amends `docs/batch-b-spec.md` "Key export" step 5
- Decision: the export window erases the derived key from memory and from the screen at the first of: 5 min after
  it is derived; the vault session's end, from the context's `sessionExpiresAtMs` (server-corrected) or a
  `{v:1, t:"hana:export-end"}` the vault posts from `cancelExport` (logout, revoke, expiry, a newer login, and the
  vault's 15 min job limit, now also for a window that already has its context); its vault frame going away
  (`opener.closed`); and the window closing. The deadline is a timer (which a device clock change can't move) plus a
  server-clock check before every confirm and reveal and when the tab becomes visible again. The window then shows
  "Export ended" with the reason and no button: exporting again needs a new export from the app, so a new window and
  a new Google sign-in. `hana:export-end` is accepted only from the opener with origin `vaultOrigin`.
- Also (sweep AUTH-6, AUTH-4): the revealed key is no longer in an `aria-live` region, so a screen reader reads it
  only when the user moves to it; the key element and every auth page are `translate="no"` (plus
  `<meta name="google" content="notranslate">`), so a page translator neither rewords a request nor sends a key out.
- Not changed: idle (D55) dims the vault's PRK but doesn't end the session, so it doesn't end an export; the
  5 min limit bounds that case.
- Rejected: closing the window from the vault (no explanation for the user; the message does the same and the page
  says why); keeping the key for as long as the tab is open (an unattended tab would hand the key to anyone at the
  device).

### D112. Refused key requests don't count as activity for the in-memory idle limit
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/vault/vault.ts` `dispatch`,
  `refuseEarly`, `dormantConsentInForce`) · Source: sweep finding VAUL-1 (Low); refines D55
- Decision: before a key request counts as activity or unlocks a dormant session, the vault runs the checks that
  need no key: a sign request goes through `approvalSubject` with raw signing allowed (another address, a malformed
  request, a mainnet for a test app, a raw request from a test app), a second `hana_export` is `busy`, and
  `hana_revokeOtherDevices` on a share that isn't fresh (a reload-unlocked share never is) is `share_not_fresh`. A
  refused request changes nothing. `hana_requestAutoApprove` counts only when it shows the consent screen; with a
  consent in force it answers without counting, and a dormant session answers it from its last known consent
  without an unlock.
- Threat model for D55, written down: the idle limit bounds an abandoned tab and stops a page from keeping PRK
  in memory with requests that fail. It doesn't bound a hostile page that gets requests signed under an accepted
  policy, or that reloads the vault frame (a reload unlocks a `'session'` record, as designed); the absolute expiry
  bounds both.

### D113. A keyboard Approve needs Approve to hold focus for 500 ms first
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/auth/approve-guard.ts`
  `KEYBOARD_DWELL_MS`, `primaryFocused`, `mayActivate`; `approve-page.ts`) · Source: sweep finding AUTH-3 (Low);
  extends D36
- Decision: on top of D36 (1 s after render and focus, an arming gesture, a click whose own keydown came after it), a
  keyboard click on Approve or Allow acts only if its keydown came at least 500 ms after the button gained focus. A
  blur of the button, and every new request or consent screen, restarts the wait. Pointer and touch clicks are
  unchanged.
- Why: on a plain screen the focus order is Reject, then Approve, so a partner page could coach a user into a
  "Tab, Tab, Enter" rhythm and then trigger a request; typed in one go, Enter now lands too soon and does nothing.
- Residual (accepted, as D36's tap-spam case): a user coached to Tab to Approve, pause and press Enter still
  approves, as a user coached to click Approve does.
- Not done: the guard's marks still use the page clock (`Date.now`), not `performance.now()`; a device clock change
  during the 1 s or 500 ms waits can only shorten them by that change, and needs local access.

### D114. Public entries trimmed: one EIP-712 hasher, no public HanaClient constructor
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/core/src/index.ts`,
  `src/signers/evm.ts` `signTypedData`; `packages/web/src/index.ts`) · Source: sweep findings CORE-5, PART-5 (Info)
- Decision: `@hana-id/core` signs typed data only with `typed-data.ts`'s `hashTypedData` over
  `normalizeTypedData`'s output (`signTypedData(d, NormalizedTypedData)`), the same parser the popup renders from.
  The second, looser hasher (`signers/eip712.ts`) and its root exports (`encodeType`, `typeHash`, `hashStruct`,
  `domainSeparator`, `TypedDataForHashing`) are gone from the package; it lives on as a test-only reference
  (`packages/core/test/eip712-reference.ts`) that the tests check against `typed-data.ts` and viem. `@hana-id/web`
  exports `HanaClient` as a type only: its constructor takes Hana origins, so `createHana`, which resolves them from
  the build's pinned envs, is the only way to build a client.
- Effect on partners: none in the documented API (`createHana` returns the same `HanaClient`).

### D115. A live app's RPC, Horizon and Soroban URLs must be https (loopback excepted)
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/client/urls.ts` `serviceUrl`, used by
  `validateEvmConfig`, `validateStellarConfig` and `packages/sodax/src/http.ts` `httpUrl`; `HanaClient.testApp`) ·
  Source: sweep finding PART-3 (Low)
- Decision: for a `pk_live_` key, createHana and the Sodax adapters refuse an `http://` RPC, Horizon or Soroban RPC URL
  unless its host is loopback (`localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`). `pk_test_` keys keep accepting
  `http://` anywhere (local and LAN test stacks). Every key refuses other schemes and URLs with credentials (which
  `fetch` refuses anyway). The adapters read the new `hana.testApp` getter; a client object without it gets the
  strict rule.
- Why: over plaintext http an on-path attacker fills fees and nonces, answers every read (balances, quotes) and sees
  every broadcast; for real funds that is never acceptable, while test stacks often run a node on another machine.

### D116. Auto-approved signatures outlive the consent: said on the consent screen; the ledger cap waits for a trusted ledger source
- Date 2026-10-29 · Status: partly in force on branch `fix/sweep-web` (`packages/web/src/auth/render-consent.ts`
  `lingeringSignaturesNote`); the cap is proposed, not built · Source: sweep finding CORE-3 (Low)
- In force: every consent screen says that stopping auto-approving doesn't cancel signatures the app already has (a
  transaction until it expires, a Stellar authorization until the ledger it names, typed data until its own
  deadline).
- Proposed default for the cap: refuse to auto-approve a Soroban authorization (`stellar_signAuthEntry`, and address
  credentials the user signs) whose `signatureExpirationLedger` is more than 720 ledgers (about 1 h at 5 s) past the
  current ledger, and send it to the popup instead. Not built, because the vault has no trusted current ledger: it
  reaches no Stellar node (its CSP allows the API, NEAR RPC and Google only), the partner page's Soroban RPC is the
  party this guards against, and an estimate from the clock drifts (close times vary) and breaks on testnet resets.
  It needs the API (or a pinned Soroban RPC in the vault's CSP, with a manifest field) to give the vault the latest
  ledger per network: a change in `apps/api` and `packages/env`, for the API side of the sweep fixes. EIP-712
  deadlines have no standard field; a policy-declared deadline field with a maximum horizon is the follow-up there.

### D117. The vault's shared-mode login check also confirms the client is a shared client
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/vault/login.ts` `checkScope`,
  `src/vault/near.ts` `sharedClients`) · Source: sweep finding VAUL-4 (Info); extends D56
- Decision: in shared mode the vault checks, in parallel with `get_scope` (`allow_shared`), that the Google client
  the API named is one of `get_config().shared_clients` in force; otherwise the login is refused
  (`config_mismatch`, `scope_mismatch`) before Google's answer is relayed. A compromised API can no longer run a
  shared-mode sign-in through a client of its choosing (the chain would refuse that session anyway; this stops it
  before the user signs in and before gas).
- Cost: one more optimistic view per shared-mode login, in parallel, while the user is at Google.

### D118. One property-based display-safety rule, app names included
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/core/src/display-safe.ts`
  `isDisplaySafeText`, `isDisplaySafeLine`; used by `decode/message.ts`, `policy/validate.ts`, `protocol.ts`
  `isAppName`, `api-types.ts`, `packages/web/src/vault/config.ts`) · Source: sweep findings AUTH-5 (merged with
  CORE-4) and AUTH-2 (Low)
- Decision: the hand-written range lists are replaced by one rule: refuse `\p{Cc}` (multi-line text keeps tab, LF,
  CR), `\p{Cf}`, `\p{Co}`, `\p{Zl}`, `\p{Zp}` and the other default-ignorable code points (U+034F, the Hangul
  fillers, U+17B4/U+17B5, U+180B–U+180F, every variation selector). Messages and decoded strings that fail are shown
  as hex; policy labels and names fail validation; an app name that fails makes the vault config, `GET /v1/app`'s
  answer and every popup message carrying it invalid, so a bad name stops the app's Hana pages rather than spoofing
  them (the admin CLI should refuse such names at write time: OPER-11, for the scripts side). `CHECK_MARKS` also
  strips U+10102 and U+1FBB1. App names, origins and decoded values are bidi-isolated in the auth pages' CSS.
- Trade-off: an emoji written with U+FE0F (❤️) makes a message show as hex and a label invalid. Unassigned code
  points stay allowed, so the validator gives the same answer on every engine.

### D120. Partner identity token, with opt-in verified email per app
- Date 2026-10-29 · Status: confirmed by the user, on the roadmap after governance, alongside email login · Source:
  conversation; `wend-api` (`src/auth/privy.ts`, `src/user/privy-identity.ts`) as the reference use
- Decision: Hana issues a short-lived (≤ 1 h) JWT a partner's backend can verify against Hana's published keys,
  obtained by the SDK without a popup (`hana.getIdentityToken()`; the vault proves its session with the session key).
  Claims: `aud` = the app, a stable per-app pseudonymous user id, the wallet addresses, `iat`/`exp`, and a session id
  hash (`sid`) so partners can keep one session per device. **Opt-in per app: a verified email claim**: when a partner
  enables it, Hana asks Google for the email for that app only (Google's screen shows the extra consent), puts it in
  the identity token off chain, never on chain, and doesn't store it; for email-login users the address comes from
  the login. The token can't unlock wallets or sign, and Hana's own APIs never accept it.
- Why: partners' backends need a trusted user identity tied to the wallet (Wend verifies Privy's identity token for
  verified email + wallets: whitelist, credit programs, referrals, retargeting; and Privy's `sid` for one session per
  browser). Hana's session model has no bearer token to reuse, by design.
- Rejected: JWT-based login sessions (bearer tokens; the session key + server share model stays).
- Amends: D25 and D96 for apps that opt in (Hana handles the Google email transiently and passes it to that partner).

## Email login and account linking, confirmed by the user 2026-10-29/30

From `docs/email-login-spec.md` (its 22 open questions, all answered). D119 is the number the spec reserved; D120 was
taken in the meantime, so the rest start at D121. D4, D25 and D96 are amended above.

### D119. Automatic account linking, Privy-style, decided by whether Google hosts the mailbox
- Date 2026-10-29/30 · Status: confirmed by the user, not built · Source: conversation (the user's `demo.privy.io`
  test); `docs/email-login-spec.md` "The four cases", Q14–Q16, Q19, Q21
- Decision: per scope, identities form accounts (a root whose path is the wallet, ≤ 3 members, one per provider);
  the on-chain records hold pseudonymous ids only. A Google identity and an email identity with the same verified
  address match. **Google-hosted** = an `@gmail.com` / `@googlemail.com` address, or a Workspace account whose `hd`
  equals the email's domain; `hd` absent or different = not Google-hosted.
  - Case A (an email-login wallet exists, a Google login with the same email joins): Google-hosted → linked at once,
    silently (no screen or click, as Privy; decided 2026-10-30); otherwise a one-time code to the address first, then
    linked at once. Always a notice.
  - Case B (a Google wallet exists, an email login joins): the user continues with Google and reaches the wallet at
    once; the email → wallet link is created from that Google sign-in (never silently at a Google login).
    Google-hosted → linked at once; otherwise it takes effect after `change_delay_ms` (24 h in production) with a
    notice in the wallet and in the partner app (not only by mail: the mailbox may be the attacker's), cancellable
    within the window.
  - Explicit `hana.linkAccount()` for different emails: proofs of both identities, `change_delay_ms`, a notice.
  - Links are per scope; an `unlinked` pair is never re-matched automatically. The link mode (at once or delayed) is
    in the issuer-computed `auto_link` nonce.
- Why: Google-hosted means whoever passes Google's sign-in can already read the mailbox, so the link adds no power.
  Otherwise Google's `email_verified` only says the address was verified once (recycled or administrator-made
  accounts), so a fresh code (case A) or a cancellable delay (case B, the direction that lets the email issuer reach
  a Google wallet) is needed.
- Accepted: a Google-hosted case B link lets a compromised email issuer reach that Google wallet at once.
- Rejected: Gmail-only linking (Workspace with a matching `hd` is as safe); silent pre-linking at every Google login
  (would hand the email issuer every Google wallet); a delay instead of a code in case A; global links; a separate
  `link_delay_ms`.

### D121. Email issuer signing key: Worker secret on testnet, AWS KMS before mainnet, two-signer-ready
- Date 2026-10-30 · Status: confirmed by the user, not built · Source: conversation; `docs/email-login-spec.md`
  "Signing key (staged)", Q2, Q11–Q13
- Decision: testnet now: the RSA-2048 signing key is a Cloudflare Worker secret of the issuer (`ISSUER_SIGNING_KEY`,
  backed up in `.secrets/<env>/`). Before mainnet: AWS KMS `RSA_2048` in a dedicated AWS account; root access held by
  both founders with hardware security keys, recovery details offline; the issuer Worker's IAM access key limited to
  `kms:Sign` on the issuer's keys with the algorithm (and `DIGEST`) pinned, rotated every 90 days and on suspicion;
  CloudTrail; an hourly reconciliation of the KMS `Sign` count against the issuer's own login log; volume and budget
  alarms; alerts on any IAM or KMS policy change. A standby key in a second region. Mainnet never takes a
  Worker-secret key.
- **Two-signer-ready from day one:** the contract's email issuer config is a signer policy (signers with their keys,
  plus a required count of distinct signers; 1-of-1 at launch); email tokens use the JWS General JSON Serialization,
  which carries one or more signatures; the watchdog pins every signer's key fingerprints and the policy. Signer keys
  rotate through owner-posted `set_issuer_key` (72 h, pinned); the signer list and count change only through a
  governed contract upgrade. Adding a signer (going to 2-of-2) is one such upgrade, with a ~10-minute overlap
  (the token lifetime) accepting 1-signature tokens, and changes no address (`sub` doesn't depend on any signing
  key).
- Staged plan: **Level 1**, an independent audit-and-throttle co-signer on another cloud (e.g. Google Cloud KMS in a
  separate project and account), enforcing per-email (per-`sub`) hourly and global daily caps with its own log, once
  email users hold meaningful funds. **Level 2**, the code split between two senders, only if "no single Hana
  compromise" becomes a product promise. **Level 3**, a TEE issuer, later.
- Why: an exportable key is acceptable without real funds; on mainnet a stolen credential must be revocable and every
  signature logged. A multi-signer format from the start makes Level 1 an upgrade, not a token-format or address
  change.
- Rejected: KMS on testnet now (setup cost before it protects anything); Cloudflare Secrets Store (still
  exportable); CloudHSM (cost); Google Cloud KMS for the primary key (keeps the email key off the cloud that signs
  Google tokens; it fits the co-signer); a single-signature compact JWT for email tokens.

### D122. A matched person never gets a second wallet; no switcher
- Date 2026-10-30 · Status: confirmed by the user, not built · Source: conversation; `docs/email-login-spec.md`
  "The four cases", Q18
- Decision: when a match is detected, Google-hosted case A links silently (D119); every other match offers only
  "Link and continue" (D119's rules) or "Sign in with {the other method}"; the identity without a wallet never opens a session on its own path. No switcher: the contract has
  no `wallets` list or `wallet` argument, and its build step is removed. Case D (both already have a wallet) can't
  arise: sandbox-dev wallets opened before v3 are test data discarded at the address freeze, mainnet starts with v3,
  and different emails or different apps are separate wallets by design. Email hints don't expire while the scope
  exists (an expired hint would let a second wallet appear). If two wallets ever exist anyway (a Google account's
  address changed between logins), nothing merges them; each method opens its own.
- Rejected: merging two funded wallets; the switcher (one account, two wallets, chosen at login); a "create a new
  wallet" option on a match.

### D123. Email login spec: the remaining open questions take the spec's recommendations
- Date 2026-10-30 · Status: defaults approved by the user, not built · Source: `docs/email-login-spec.md` open
  questions 1, 3–14, 17, 19–22
- Decision, by question:
  - Q1: the issuer is its own Worker, `apps/email-issuer`, separate from the API Worker.
  - Q3: user mail via Resend (D87, still provisional until the colleague confirms), behind one sender adapter, on its
    own sending subdomain; the provider's message-log retention at the minimum.
  - Q4: per-scope `aud` (`email:<scope_id>`, a scope client): a partner turns email off on chain with
    `remove_client`.
  - Q5: the issuer under `{apiUrl}/v1/email`.
  - Q6: `sub` = HMAC with `K_sub`; `K_sub` a Worker secret with two offline backups, never rotated.
  - Q7: the Gmail canonical form (dots and `+tag` ignored); Google's help pages cited in the guard test before the
    freeze.
  - Q8: the code never in the mail subject.
  - Q9: no Turnstile on `authOrigin`; rate limits instead.
  - Q10: disposable-address domains blocked (a pinned list, `email_domain_not_allowed`).
  - Q11: the standby KMS key in a second region.
  - Q12: trust spread: Google signs Google tokens, AWS holds the email key (D121).
  - Q13: email issuer keys wait `governance_delay_ms` (72 h on mainnet).
  - Q14: links per scope.
  - Q17: no stored user email addresses, encrypted or not (D96): in-product notices only.
  - Q19: explicit and delayed case-B links wait `change_delay_ms` (24 h in production, D93).
  - Q20: partners enable email per app (partner console toggle plus the on-chain client).
  - Q21: one method per provider per account, 3 members.
  - Q22: the proposed rate limits (codes per address 3 per 15 min and 10 per day, wrong codes 10 per hour → 1 h lock,
    per-IP, per-app and a global daily send budget with a breaker), provisional until sandbox-dev measurements.
- Rejected: the alternatives each question listed.

### D124. Sign in with Apple on the roadmap, after email login
- Date 2026-10-30 · Status: confirmed by the user (roadmap); specced (`docs/apple-login-spec.md`), paused 2026-11-02 (D160) · Source: conversation
- Decision: Apple is the next login method after email login and the partner identity token. It plugs into the
  provider-neutral core: the wallet path `scope#provider#sub#key_index` (provider `apple`, so no existing address
  changes), `set_issuer("apple", ["https://appleid.apple.com"])` with its keys through the same delayed, cancellable
  key changes (D33), RS256 (already the contract's one algorithm), and accounts with one member per provider (D119).
  New per provider: the popup flow, client lookup in the API, manifest and partner-console client fields, the
  watchdog's JWKS check, and a Hana Home export path.
- Constraints for the spec:
  - Apple's `sub` is stable per Apple developer **team**, not globally (Google's is the same in every project). Every
    Apple client must sit in Hana's team: a partner's own team would give its users other subs and other wallets.
    Branded Apple clients only as Hana-held Services IDs (the D42 Enterprise tier).
  - Hide My Email (`…@privaterelay.appleid.com`) never matches by email; such users link by hand (`linkAccount`).
  - Requesting `email` makes Apple answer with `response_mode=form_post`, so the callback needs a POST route (today's
    `/login/callback` is a static page reading the fragment).
  - Automatic linking gets an "Apple-hosted" twin of D119's Google-hosted rule (`icloud.com`, `me.com`, `mac.com`),
    to be checked against Apple's documentation when specced.
- Why: the App Store generally expects iOS apps that offer a third-party login such as Google to also offer Sign in
  with Apple, so partners with native apps will ask for it.

### D125. Watchdog hosting: its own Cloudflare account in production; sandbox-dev shares the API's account
- Date 2026-10-30 · Status: confirmed by the user · Source: conversation (hosting options researched and ranked)
- Decision: production watchdogs run on their own Cloudflare account, separate login and MFA from the API's (D86 Q3
  stands). sandbox-dev's watchdog runs on the same Cloudflare account as its API and page Workers (the personal
  account, `tingtc.workers.dev`), for the drills only: on that env a compromise of the API's account can also silence
  the watchdog. The watchdog is deployed by hand from a founder's machine, never from CI (a GitHub compromise must not
  be able to ship watchdog code).
- Options considered (ranked 2026-10-30):
  1. **AWS Lambda + EventBridge Scheduler in a dedicated AWS account**: the strongest single option. Another
     provider than the API, security-key root login, CloudTrail and IAM, a reliable scheduler, free (EventBridge
     Scheduler 14M invocations/month and Lambda's 1M requests/month free tiers). Its own account, not the email
     issuer's KMS account (D121). Port: the Worker's platform code is ~425 of ~2,420 lines (`src/index.ts`,
     `src/store.ts`, `src/env.ts`); `store.ts` moves from D1's SQL to DynamoDB, the cron handler becomes a Lambda
     handler on a 5-min EventBridge schedule, `/status` and `/alerts` a Lambda function URL, the secrets Secrets
     Manager or encrypted environment variables, plus a deploy script. Everything else (checks, chain, channels,
     alerts) is `fetch`-based and moves unchanged.
  2. **A separate Cloudflare account** (chosen): no port, free, reliable; the residual risk is a Cloudflare-wide
     outage taking down the API and the watchdog together, which the heartbeat (dead-man's switch) on a third
     provider reports.
  3. Deno Deploy: the smallest port off Cloudflare (Workers-like runtime, Deno KV), free; `Deno.cron` is still marked
     unstable, at-least-once with up to 1 min drift, a younger platform with fewer account controls.
  4. Google Cloud Run jobs + Cloud Scheduler: workable, a container build, a fourth cloud for no gain over AWS.
  5. Fly.io (one always-on machine, SQLite on a volume, ~$2/month) and 6. a VPS: our own uptime and patching.
  - Rejected: GitHub Actions schedules (best-effort, often 15–30+ min late or dropped, and GitHub also hosts the
    code), Vercel cron (Hobby runs once a day; per-minute needs Pro at $20/month), Netlify scheduled functions
    (unclear cadence, short runtimes).
- Later option: a second watchdog on another provider (the contract takes up to 3, D86 launches with one), e.g. the
  Cloudflare one plus AWS Lambda, so one provider's outage or breach silences neither. The code is shared, so it is
  the port above plus a second NEAR watchdog account.
- Why: the separate Cloudflare account gives the independence that matters (separate credentials) with no new
  platform to learn or port to; AWS Lambda is kept documented in case provider diversity is wanted before mainnet.

### D126. The watchdog's pause for an active forged key also deletes every updater key
- Date 2026-10-30 · Status: confirmed by the user, built · Source: conversation (sandbox-dev pause drill)
- Decision: when the watchdog pauses because a key Google doesn't publish is active, it then deletes every updater key
  in `updater_keys`, whoever proposed the key (the executed change record is gone, and only the updater or the owner
  can post keys). An updater key added while such a key is still active is deleted at the next run, so recovery runs
  in order: remove the key, raise the session floor, install a fresh updater key, unpause (`docs/operations.md`
  "Watchdog alerts"). The pending path is unchanged (cancel, and delete the updater keys when the updater proposed).
- Why: in the drill the pause left the proposing updater key installed. A stolen updater key could then fill the
  6-slot pending-change queue (blocking Google's real rotations) and post again after an unpause if the council forgot
  to rotate it. A needless deletion costs one council vote in a recovery that needs council votes anyway.
- Also decided: every incident scenario gets a step-by-step recovery guide in the admin portal's "Security &
  monitoring" view (D83), from one source that a test keeps complete for every watchdog alert kind. Built (branch
  `feat/recovery-playbooks`): the source is `packages/playbooks` (`@hana-id/playbooks`), rendered as
  `docs/playbooks.md` by `gen-docs` (a test fails when it is stale); `apps/watchdog/test/registry.test.ts` fails when
  an alert kind has no playbook; `GET /status` serves each kind's `playbook` id and every alert text names it; the
  portal's Playbooks page is specified in `docs/batch-c-spec.md` (batch C, not built). `admin owner:call` now also
  sends `set_sessions_valid_from_ms` (the `forged_active_key` recovery needs it; it was missing from
  `OWNER_METHODS`).

### D127. Partner identity token: the spec's recommendations, all 16 questions
- Date 2026-10-30 · Status: confirmed by the user; build steps 1–4 (no email claim) built on `feat/identity-token-1`
  (D170–D175) · Source: `docs/identity-token-spec.md` open questions
- Decision: `sub` per scope (`"u1_"` + HMAC with a separate, never-rotated `IDENTITY_SUB_KEY`); ES256; minted by the
  API Worker; mainnet key in AWS KMS (non-exportable, own IAM user, D121's account; a Worker secret on testnet and
  `local*` only); lifetime 1 h capped at the session's end, `maxAgeMs` for fresher proof; email asked once per app at
  the first login in the Hana popup, always optional (no mandatory setting in v1), `requestEmailSharing()` to ask
  again; wallet addresses proven by a signature from each address's key once per session (no server registry);
  tokens on for every app (the email claim opt-in); no introspection endpoint; no cookie on the partner's domain;
  `login_methods` only (no `amr`/`auth_time` yet); trust by JWKS URL with optional pinned thumbprints and a watchdog
  pin check; `iss` = `{apiUrl}/v1/identity` on sandbox-dev and a stable Hana hostname in production, fixed before
  any partner goes live; a new `sid` at every interactive login.
- Why: each question's trade-offs are in the spec. Optional email sharing never affects which wallet a person gets
  (linking is D119/D122, from Google's verified address read transiently inside Hana).

### D140. The ledger's Postgres tests run on PGlite
- Date 2026-10-30 · Status: in force on `feat/batch-c-1` (`apps/api/test-usage`, `scripts/test/usage-migrate.test.ts`)
  · Source: batch C1 (`docs/batch-c-build-plan.md`); the spec's "Tests" said a real Postgres 17 (a Neon branch in CI
  or a local container)
- Decision: the usage ledger's DDL, roles, grants, functions and the migration runner are tested on PGlite
  (`@electric-sql/pglite` 0.5.11, exact-pinned: Postgres 18.6 compiled to WASM, in process), so `pnpm -r test` needs no
  network, container or Neon branch, locally and in CI. The same suite runs against a real Postgres 18 through `pg`
  when `USAGE_TEST_DATABASE_URL` names a superuser connection to a local server (a container); never Neon. Tests switch
  roles with `SET ROLE`, as the Hyperdrive connections of each role would run.
- Why: PGlite is the same server code as Neon's Postgres 18, so privileges, partitioning, PL/pgSQL and triggers behave
  the same; a Neon branch per CI run would put a Neon credential in CI and a network dependency in every test run.
- Not covered by PGlite: Neon's own role rules (the owner is `neon_superuser`, not a superuser) and Hyperdrive. The
  first `usage-migrate` on sandbox-dev and C4's capture smoke check those.
- Rejected: a Neon branch per CI run; a Postgres container as the default (needs Docker locally and in CI).

### D141. Ledger roles: created without login, no credential in the DDL, nothing for PUBLIC
- Date 2026-10-30 · Status: in force on `feat/batch-c-1` (`apps/api/migrations-usage/0001_ledger.sql`) · Source:
  batch C1; amends `docs/batch-c-spec.md` "Usage ledger" roles
- Decision: the migration creates `usage_writer` and `usage_admin` `NOLOGIN` if they don't exist; `usage-setup` (C4)
  gives each `LOGIN` and a generated password. Every migration ends with `REVOKE EXECUTE ON ALL FUNCTIONS … FROM
  PUBLIC` (Postgres grants EXECUTE on new functions to PUBLIC, which would have let the admin role call `record_event`
  and any role call the retention functions); a test checks each role's exact function list and that a role with no
  grants has none. The admin role gets `SELECT, INSERT, UPDATE, DELETE` on the `ops` tables instead of `CREATE` on the
  schema (it never creates objects, and owner-created tables weren't writable by it).
- Why: no secret in a committed file; the DDL runs unchanged on Neon, a container and PGlite; least privilege as the
  spec intended.

### D150. The watchdog monitors the relayer's funds (read-only), with default thresholds and manifest overrides
- Date 2026-10-30 · Status: built (branch `feat/playbook-gaps`), defaults for review · Source: conversation (closing
  the recovery playbooks' "not built yet" steps)
- Decision: every run reads the relayer account (`view_account`, `view_access_key_list`, final) and raises condition
  alerts: available balance (`amount` minus storage) below 5 NEAR → warning `relayer_balance_low`, below 1 NEAR or no
  account → critical `relayer_balance_critical`; each pool key's remaining allowance below its pool's thresholds
  (session 0.5 / 0.1 NEAR of 2 NEAR, owner 0.1 / 0.02 NEAR of 0.5 NEAR) → `relayer_allowance_low` /
  `relayer_allowance_critical`; a pool with no key → critical `relayer_pool_empty`. Keys are assigned to a pool by a
  marker method (`derive_key` session, `propose_change` owner), so the session pool's planned allowlist states keep
  working. Thresholds can be overridden per pair in the manifest's `watchdog.relayerFunds` (NEAR). The watchdog never
  tops anything up: it holds no key on the relayer account, and funding stays a founder's manual step. Playbook:
  `relayer-out-of-funds` (now an alert playbook).
- Why: `docs/security.md` listed allowance monitoring as a mainnet requirement, and the relayer playbook could only
  say "you notice from failed logins". The watchdog already reads the chain every 5 min through its own RPC and pages
  both founders; a second monitor would duplicate that. Critical for the balance and per key, because a used-up key
  stops the logins of every app routed to it.
- Rejected: a total-allowance-per-pool threshold (one key running out still fails its apps); auto top-up from a
  funded account (it would put a spending key on the watchdog's account, against D82's minimal powers); thresholds as
  code constants only (a busier env or raised allowances need their own).

### D151. Council member replacement: remove first, then add, through the admin CLI; reject votes in the scripts
- Date 2026-10-30 · Status: built (branch `feat/playbook-gaps`), for review · Source: conversation (closing the
  recovery playbooks' "not built yet" steps)
- Decision: `admin <env> council:replace-member --remove <old> --add <new>` makes two Sputnik proposals on the
  council DAO, `RemoveMemberFromRole(<old>, council)` then `AddMemberToRole(<new>, council)`, signed and approved only
  by remaining members. It refuses unless the DAO's group is the manifest's council (or a half-done replacement it
  carries on from) with otherwise exactly the 2-of-3 council policy, the new account exists, and the manifest still
  validates with the new member in the old one's place. Dev envs may `--approve-with` (both execute in one command);
  elsewhere it proposes and prints each remaining member's `act_proposal`. Once the DAO has the new council, `--yes`
  writes `council.members` in `envs/<env>.json` (only that list; without `--yes` it prints the edit). `owner:vote
  --reject` casts a `VoteReject`.
- Why: removing first cuts a lost or stolen key off at once. Sputnik recomputes the threshold from the group's size
  (2 members: 2 of 2), so the window needs both remaining members, which the replacement needs anyway; adding first
  instead makes the removal 3 of 4, which needs the new member's vote too. Writing the manifest only after the chain
  shows the new council keeps `deploy-contract`'s policy check (`policyProblems`) meaningful.
- Rejected: one `ChangePolicy` proposal with the whole new policy (it can change anything else in the policy at the
  same time, which is harder to review than a member change); add first (needs three votes for the removal).

### D152. D1 recovery is D1 Time Travel, with a runbook for both databases
- Date 2026-10-30 · Status: documented (branch `feat/playbook-gaps`), not rehearsed · Source: conversation (closing
  the recovery playbooks' "not built yet" steps)
- Decision: a lost or damaged D1 (the API's `DB` or the watchdog's) is restored in place with `wrangler d1
  time-travel restore --bookmark` (30 days on the paid plan), after noting the current bookmark (the undo) and, for
  the API, exporting the damaged state to `.secrets/` (it holds wrapped vault shares). The runbook
  (`docs/operations.md` "Restoring a D1 database (Time Travel)") lists what a restore loses and what to re-run, in
  order: migrations, then security writes made since the point (suspensions, origin removals, a revoke-all) before
  anything else, then a KEK rotated since, then other app changes. For the watchdog it spells out the first-run
  baseline caveat (a point after the first run keeps the pause; before it, or no restore, means a first run that
  only alerts) and the gap caveat (a kid published and dropped inside the gap looks never published and pauses).
  The `d1-data-loss`, `watchdog-down`, `watchdog-compromised` and `watchdog-first-run` playbooks use it.
- Why: Time Travel is on by default for production-backend D1 databases and needs no code; the dangerous part of a
  restore is silently undoing a security response, so the runbook orders that first.
- Still open: a rehearsal on sandbox-dev (no wrangler or chain actions were run for this), and a backup kept beyond
  30 days and outside Cloudflare (an export of the apps tables, or batch C's Neon ledger, D73).

### D153. A key Google just retired isn't a forgery: cancel, keep the updater key, warn
- Date 2026-10-30 · Status: built (branch `fix/watchdog-retired-key-race`) · Source: a false
  positive on sandbox-dev (watchdog alert #10)
- What happened: at 16:30:07 (UTC+8) the API cron's JWKS fetch still listed Google kid `f10f8740…`, which wasn't on
  chain, so it proposed adding it (change 2). Google dropped the kid at about that time: the watchdog's next two
  fetches didn't list it, so it cancelled the change as forged and deleted the updater key. The proposed `n`/`e` were
  byte-for-byte what the watchdog itself had fetched from Google at 16:10. No attack: the two services saw Google's
  JWKS a few minutes apart, across a key retirement.
- Decision: an Add **by the updater** of a kid Google doesn't publish now, whose `n`/`e` equal what this watchdog
  fetched from Google (`seen_kids`, source `jwks`, not a first-run baseline) within the last 24 h
  (`RETIRED_KEY_GRACE_MS`), is a `retired_key_change`: the watchdog cancels it (a retired key has no use), keeps the
  updater keys, and raises a **warning** (Slack, email; no page). Everything else that was forged stays forged: a kid
  Google never published, other key material, a kid last seen more than 24 h ago, an owner proposal (the owner path
  never deletes updater keys), and any non-Google change from the updater. If the watchdog can't read `seen_kids` the
  change is treated as forged (fail safe).
- Why: a stolen updater key gains nothing from it. It can only re-propose Google's own key material, which is useless
  without Google's private key, and it would be cancelled anyway. Deleting the updater key on every retirement race
  stops Google key sync until a council member reprovisions it, and pages someone for nothing.
- Playbook: `retired-key-change`. The incident's alert #10 was acknowledged; the deleted updater key is reprovisioned
  through the council (`forged-key-change` step 5).

### D142. Loopback origins only in `sandbox-*` environments
- Date 2026-10-30 · Status: confirmed by the user · Source: batch C1 open question 1 (`docs/batch-c-build-plan.md`)
- Decision: `localhost` / loopback origins are accepted only in dev environments (`sandbox-*`, `local*`), both when an
  origin is registered and at the login gate; partners develop locally against Hana's sandbox environment. This
  replaces the spec's "any test scope in any non-production network" rule for origin input.
- Why: one rule enforced the same way in both places; otherwise a partner could register an origin that silently
  fails at login.

### D143. Production's usage ledger gets its own Neon project before mainnet
- Date 2026-10-30 · Status: confirmed by the user · Source: batch C1 open question 2
- Decision: the current Neon project (`hana-id`, branches `production` and `sandbox-dev`) serves dev and test; before
  mainnet a separate Neon project (AWS Sydney) holds the production ledger, with its own credentials, restore window
  and access list. The `production` branch of the current project is not used for mainnet.
- Why: a sandbox credential leak or a project-level mistake can never reach production billing data.

### D144. Support ID lookup is built from data Hana already keeps
- Date 2026-10-30 · Status: confirmed by the user, not built · Source: batch C1 open question 4 (D96)
- Decision: staff resolve a user's Support ID in the admin console from the usage ledger's pseudonymous user id plus
  each app's change history (`app_changes`): which apps it used, recent logins, errors and app setting changes. No
  dedicated support table and no email or name stored. A short spec section, reviewed by the user, comes before
  batch C15.
- Why: no new store of user data to protect or keep under retention rules.
- Rejected: a dedicated support table with more detail per user.

### D145. The owner-invite waiting period has its own setting
- Date 2026-10-30 · Status: confirmed by the user, built in batch C1 · Source: batch C1 open question 5 (D89)
- Decision: manifest `ownerGrantDelayMs` (a new owner is a viewer until it passes; owners can cancel) is separate
  from `appChangeDelayMs`, with the same bounds (at least 24 h on mainnet).
- Why: the two waits can be tuned independently; changing one never silently changes the other.

## Partner identity token, build steps 1–4 (2026-10-30)

Choices made while building `docs/identity-token-spec.md` steps 1–4 on `feat/identity-token-1`, where the spec left a
detail open or a safer reading was needed. Each follows the spec's intent; the user can revisit any of them.

### D160. Sign in with Apple paused; the initial build is Google and email
- Date 2026-11-02 · Status: confirmed by the user · Source: conversation (Apple spec questions)
- Decision: Sign in with Apple is not built for the initial launch; it is built when partners ask for it. The spec
  (`docs/apple-login-spec.md`) stays as the starting point. Answers given so far:
  - Q1 = B: Apple users' emails through a second, email-only Apple client whose tokens never go on chain (like Privy:
    partners get the email), at the cost of a second Apple prompt at an identity's first login in an app.
  - Q2, provisional: the Apple developer team of the company that publishes Hana Wallet and Wend, for testnet. To be
    confirmed or changed at the production-readiness check, before the address freeze.
  - Q3 = A: every Apple client in Hana's team; partner-held Apple accounts only if customers ask, for partners that
    start on them.
  - Q4 = A: the shared client in a Hana app group, each Enterprise client in its own group.
  - Q5 = A: partners' native iOS apps use the web flow (`ASWebAuthenticationSession`). A native-sheet
    "partner-managed Apple" tier only if customers ask: with the native sheet the partner's app receives the Apple
    token and can open sessions for its own users' wallets (partner custody within its scope), and those wallets
    differ from the same users' wallets in Hana's team.
  - Q6–Q18: open, asked again when the work resumes.
- Why: focus the initial build on Google and email; Apple adds an issuer, a second client, a POST route, watchdog
  and playbook work for a method no partner has asked for yet. Nothing built so far depends on Apple: the path format
  and the issuer model already take a new provider without moving any address (D124).

### D170. Identity token layout details the spec left open
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`packages/core/src/identity.ts`, frozen in
  `packages/core/test/vectors/identity-v1.json`) · Source: build step 1
- Decision: the session proof's prefix is the spec's `"hana-id-identity-v1:"` (the build brief said
  `hana-identity-v1:`; the spec wins). `wallet_proofs_hash`, which the spec names but doesn't define, is
  `sha256("hana-id/identity-wallet-proofs/v1" ‖ 0x00 ‖ for stellar then evm: borsh(chain) ‖ borsh(address) ‖
  borsh(Vec<u8> signature))`. The EVM address in a wallet-proof message is EIP-55; the API accepts any valid case in
  the body and canonicalizes before checking. `sub`'s root identity is the session path after the app's `scope#`:
  exactly `provider#sub#key_index` with a lowercase provider, a non-empty sub and a decimal `key_index`, else no token
  (`502 bad_contract_result`). `login_methods` is `[root provider]` until account linking exists (email login, D119).
  The claims are built in the spec's order and the builder throws on anything off-spec.
- Why: a frozen, unambiguous layout before any vault signs one; the proofs hash commits to the chain names, addresses
  and signatures so a session proof can't be paired with other proofs.

### D171. A mint in an app that keeps logins needs the session's live share
- Date 2026-10-30 · Status: in force; amended by D178 (other apps' shares, tombstones) · Source: build step 2; the
  spec's "Minting" step 2 (`apps/api/src/identity/token.ts` `checkShare`, `packages/web/src/vault/vault.ts`
  `mintIdentity`)
- Decision: when the app's persistence is `session`, `/v1/identity/token` requires a share for the session key, made
  for the requesting parent, judged as unlock judges it without writing anything (`410 session_ended` with `reason`
  `unknown_share`, `share_revoked`, `persistence_off`, `share_expired`); a session key with no share passes on the
  chain check alone only while the app's persistence is `none`. The vault answers `identity_unavailable` with
  `reason: no_share` (no API call) for a session in a `session` app that has no share (storage blocked, or the
  background persist gave up, D79), and waits for a login's persist before minting. A `410 session_ended` from the
  mint ends the vault session as a revoked share does (`sessionExpired`). A missing on-chain session is re-read every
  300 ms for up to 2 s before the refusal (a node a block behind the login would otherwise log the user out).
- Why: the share is what a logout, `revokeOtherDevices()` or a removed origin kills; the hourly cron deletes revoked
  shares, so "no share" can't be told from "revoked" and must refuse in a `session` app. Accepted: a browser that
  can't store the session gets no identity token in such an app (`docs/security.md` open issue (l)).

### D172. Identity counts in their own tables, migration 0008
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`apps/api/migrations/0008_identity_token.sql`) ·
  Source: build step 2; `docs/batch-c-build-plan.md` reserves 0006 and 0007
- Decision: migration 0008 creates `identity_issuance_hourly (hour, kid, count)` and `identity_usage (app_id, day,
  tokens)` (the spec's `usage.identity_tokens`), both kept 24 months by the hourly cron. It doesn't touch the legacy
  `usage` table (batch C's 0007 drops it) and holds no user data. The email claim's `apps.identity_email`,
  `identity_email_consents` and `identity_emails` count come with build step 5's migration.
- Why: 0008 applies the same before or after batch C's 0006/0007; an `ALTER TABLE usage` would fail on a fresh
  database once 0007 drops `usage`.

### D173. Identity signing configuration: `activeKid` in the manifest, `iss` under the API
- Date 2026-10-30 · Status: in force; the global ceiling amended by D176, the standby slot by D177 · Was on `feat/identity-token-1` (`packages/env/src/identity.ts`,
  `apps/api/scripts/gen-wrangler.ts`, `scripts/lib/identity-key.ts`) · Source: build step 2; the spec's "Manifest"
- Decision: the Worker-secret signer is `{kind: "worker-secret", activeKid}`: the API signs with whichever of
  `IDENTITY_SIGNING_KEY` / `IDENTITY_SIGNING_KEY_STANDBY` has that RFC 7638 thumbprint, so the rotation playbook's
  "switch to the standby" is a manifest change and a deploy. The schema requires every `publicKeys` kid to be its
  key's thumbprint, refuses any private member, requires the signer's kids in the list and refuses a Worker-secret
  signer off testnet; `identityToken.iss` must be `{apiUrl}/v1/identity` until the production hostname exists (D127
  Q14). `gen` refuses the `aws-kms` shape until build step 7 and, with `--dev-vars`, signing keys the manifest
  doesn't publish. The API verifies each signature with the published key before answering, and serves the JWKS from
  the manifest's list alone. The global hourly ceiling is 100 000 mints (var `IDENTITY_GLOBAL_HOURLY_MAX` overrides).
- Why: the standby switch must not need a secret upload in an incident, and a secret that doesn't match the published
  key must never produce a token.

### D174. Identity token cache rule and SDK surface details
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`packages/web/src/vault/identity.ts`,
  `packages/web/src/client/client.ts`, `packages/react/src/identity.ts`) · Source: build step 3
- Decision: the vault hands out its cached token while more than `min(5 min, half the token's life)` remains (a token
  the session's end made short doesn't cause a mint per call) and, with `maxAgeMs`, it is at most that old. The SDK
  clamps `maxAgeMs` to 30 s–1 h (the port refuses anything else) and rejects a non-positive one with `-32602`. The
  port result and `identityTokenChanged` carry `{identityToken, expiresAtMs}`; the client exposes
  `hana.identityToken` and `hana.identityTokenExpiresAtMs`. `410 session_ending` (< 30 s left) is `session_ended` with
  `data.reason: 'session_ending'`, without ending the session (its own timers do). `useIdentityToken` retries a failed
  refresh after 60 s. The record format 2 stores the proofs; the session key stays with a dormant session so it can
  mint without PRK.
- Why: the spec's 5-minute margin alone would mint on every call near a session's end; the rest fills in shapes the
  spec named but didn't fix.

### D175. A tested partner example, quoted exactly by the guide
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`examples/identity-verify`, a workspace member) ·
  Source: build step 4; the spec's "Example verifier"
- Decision: `examples/identity-verify/src/verify.ts` is the guide's verifier (`jose` 6.2.13, ES256 pinned); its tests
  run it against a local issuer (expired, stale, wrong `aud`/`iss`/`typ`/key, `alg: none`, HS256) and fail when
  `docs/integration.md` section 15 doesn't quote the file exactly. The Playwright suite verifies real tokens from the
  local stack with `jose` against its JWKS.
- Why: the published guide always runs.

## Email login build, batch 1 (contract v3), 2026-10-30

Made while building `docs/email-login-build-plan.md` batch 1 (branch `feat/email-login-1`), where the spec was silent,
ambiguous or unsafe as written. Each takes the safest reading and is listed for the user under the plan's "Open
points for the user"; none changes an address.

### D130. A wallet is recorded when its path is derived, not when a session opens
- Date 2026-10-30 · Status: confirmed by the user (2026-11-02); in contract v3 on develop, not deployed · Source: build of
  `docs/email-login-spec.md` "Sessions" step 3 and "Model" ("the contract records that in `opened` at every
  `create_session*`")
- Decision: `opened` (an identity "has a wallet") is set by `derive_key` and `create_session_and_derive` for the
  session's path identity, not by a bare `create_session`.
- Why: tokens are public in the mempool and in failed transactions. Copying a Google token that was sent for a case-A
  link into a bare `create_session` would open a session nobody can use but mark the Google identity as having a
  wallet, so the user's retry hits "both have a wallet" and the person ends up with two wallets, which D122 forbids.
  Nobody can derive without the session key, so marking at derivation can't be forged. For every real login (the
  combined call) the result is the same as the spec's.
- Rejected: the spec's wording (marking in `create_session`).

### D131. Contract readings of the email login spec (batch 1)
- Date 2026-10-30 · Status: confirmed by the user (2026-11-02), every reading; in contract v3 on develop, not deployed · Source: build of
  `docs/email-login-spec.md` "Contract changes", "Sessions", "Link methods"
- Decision:
  - `mark_self_issued` refuses an issuer that already has keys, active or pending (`Issuer already has keys`), and a
    second call (`Issuer is already self-issued`), so it can never reset an upgraded policy.
  - The updater key ("self") can't propose **any** key change of a self-issued issuer, removals included.
  - One RSA modulus is registered once per self-issued issuer, whatever its kid, exponent or signer (`Key is already
    registered`), including keys a future `migrate` installs: one stolen key never counts as two signers.
  - A self-issued key change waits `max(the usual rule, now + governance_delay_ms)`.
  - JWS JSON is parsed strictly: no flattened form, no unprotected `header`, no `crit`, no duplicate members; every
    signature must verify and every kid must be a counting signer's active key (an unknown extra signature fails the
    token rather than being ignored).
  - Case A (Google joining an email wallet) must carry `link_immediate = true` (`This link must be immediate`): a
    delayed case A would have to open the Google identity's own path, a second wallet.
  - `cancel_link` doesn't mark the pair `unlinked` (the spec names unlink only; confirmed by the user, D132); lazy activation of a pending member
    doesn't bump the epoch; an account record is never deleted (its epoch must not restart).
  - `get_account` also returns `unlinked` (hex keys), so the issuer can apply "an unlinked pair is not a match".
  - The panic for an unlisted kid stays today's `Unknown signing key` (the spec writes `Unknown key`); a
    `link_immediate` without `link_jwt` panics `link_immediate needs a link_jwt`; unlinking by another member panics
    `Only the root or the member itself can unlink`.
  - `migrate_v1` stays (now v1 → v3) until the sandbox suite moves to v2 → v3 (build-plan batch 2).
- Why: each is the stricter of the readings the spec allows, or fills a gap without a product choice.
- Rejected: the looser readings (accepting a delayed case A, ignoring unknown extra signatures, letting the updater
  propose email key removals).

### D132. A cancelled link keeps the match (open point 3 → A)
- Date 2026-10-30 · Status: confirmed by the user, built (`feat/email-login-1`) · Source: conversation
  (`docs/email-login-build-plan.md` open point 3)
- Decision: `cancel_link` does **not** mark the pair `unlinked`. After a user cancels a pending link, the next login
  with the other method still sees the match and offers only "Link and continue" or "Sign in with {the other
  method}": no second wallet. Only `unlink_identity` marks a pair.
- Rejected: marking cancelled pairs (an email login would then make its own wallet after a cancel).

### D133. The user's session signature binds the link, and the auto_link nonce binds the join
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the independent security review (HIGH-1, MEDIUM-1) ·
  Source: review of contract v3 at ba45b91
- Decision:
  - In `create_session_and_derive` with `link_jwt`, the session key's counter-1 signature is over the **linked CKD
    payload** `"hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode u8 ‖ pk1 ‖ ":" ‖ pk2` instead of the plain one. The
    plain payload is unchanged for logins without a link. The vault verifies the link token and recomputes its
    `auto_link` nonce before signing.
  - The `auto_link` nonce also commits to the join the issuer decided: `join` (1 = the session identity joins the link
    identity's account, case A; 2 = the link identity joins the session identity's, cases B/C), `joiner_ik` and
    `target_root_ik`, before the epoch and mode. The contract recomputes the join from chain state and checks it.
- Why: before, nothing the user signed bound the link. Whoever submitted a published login chose whether and which
  link was attached: a stolen email-issuer key could replay a failed Google login with its own case-B token and join
  its email identity to the Google wallet (against D119 and the spec's trust statement), and anyone could strip the
  link from a case-A login so the Google identity derived its own path (two wallets, against D122). A token minted for
  case A could also execute as case B after the chain state changed at the same epoch. Its own domain keeps the linked
  payload from ever reading as a plain CKD payload (a suffix on the plain payload could collide with a crafted `pk2`).
- No path, CKD request, derivation or existing layout changes; the `auto_link` layout was never deployed.
- Rejected: the reviewer's suffix form (`plain payload ‖ ":link:" ‖ …`), for the collision above.

### D134. Only the email provider can be self-issued
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the review (LOW-3)
- Decision: `mark_self_issued` accepts only `SELF_ISSUABLE = ["email"]` (`Only the email issuer can be self-issued`).
  Another provider needs a governed upgrade.
- Why: marking is one way. An owner could remove Google's keys and mark `google` self-issued, which would stop every
  Google login until a governed upgrade. The email provider name is frozen anyway (it is in every email path).
- Rejected: a governance delay on marking (more machinery for a provider list that is one name).

### D135. Links wait for the owner after a migration from pre-v3 state
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the review (LOW-4)
- Decision: `migrate` (v2 → v3) and `migrate_v1` set `unrecorded_wallets = true`; while it is set every link, automatic
  or explicit, panics `Links wait until the owner accepts the wallets opened before v3`. The owner's
  `accept_unrecorded_wallets()` (one way, event) clears it. `new` starts with `false`. sandbox-dev accepts after its
  v3 upgrade (its pre-v3 wallets are test data, D122); the mainnet runbook creates the signer with `new` on v3 and
  checks `get_config().unrecorded_wallets == false`.
- Why: wallets derived before v3 aren't in `opened`, so "has a wallet" would be wrong for them and a funded pre-v3
  Google wallet could be silently joined to an email account in case A. A migration argument isn't possible: v2's
  `execute_upgrade` calls `migrate` with empty input.
- Rejected: documenting it only (the review's point); a migrate argument (above).

### D136. A linked identity's own path never derives; signer-policy keys are checked like any key
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the review (LOW-1, LOW-2, info)
- Decision:
  - `derive_key` (and the derive half of `create_session_and_derive`) refuses a session whose path identity is a
    member of an account, pending or active (`Sign-in method is linked to an account`): a session an identity opened
    on its own path before it joined can't make a second wallet.
  - `set_signer_policy` (a governed upgrade's `migrate` only) checks every new key with `set_issuer_key`'s rules
    (leading zeros stripped, 2048–4096 bits, odd exponent other than 1), so a zero-padded copy of hana's modulus can't
    pass as a co-signer's key.
  - `set_signer_policy` takes `overlap`: `true` (adding a signer) keeps the 10-minute overlap and leaves dropped
    signers' keys until the owner removes them (they can't count once it ends; `get_issuer_keys` still lists them);
    `false` (replacing a compromised signer) opens no overlap and removes the dropped signers' keys at once.
- Why: each closes a path the review reproduced; none changes an address.

### D137. A bare create_session needs the session key's proof of possession; linked logins never recover unlinked
- Date 2026-10-30 · Status: built (`feat/email-login-1-r2`), from the second review (N1) and the automated review of
  its first form · Source: review of e225d2e
- Decision:
  - `create_session` takes `signature`: Ed25519 by the session key over `session_message(0, "hana-id-create-v1:" ‖
    sha256(session nonce preimage))`. Only the key holder can open a session, and the proof is bound to that call's
    parameters (signer, scope, key, expiry, key_index, max_uses, salt), so a proof seen in one transaction can't open
    the key with any other parameters. Counter 0 is never accepted by `derive_key` or `revoke_session`, and the domain
    differs from every other signed payload. `create_session_and_derive` is unchanged (its counter-1 signature already
    proves possession).
  - Recovery rule for the vault (batch 8): a session it meant to carry a link is never derived on with the plain
    payload; on `Session key already in use` (or any failure after publishing) it revokes that session and restarts
    with a fresh session key, Google token and link token.
- Why: a front-runner could copy the Google token of a published case-A linked login into a bare `create_session`
  with the same session key and no link. The user's call then failed `Session key already in use`, and the documented
  recovery (derive with counter `used + 1`, plain payload) derived the Google identity's own path, splitting the person
  into two wallets (D122). A constant proof (the first form of this fix) would still have been replayable for that key
  with other parameters.
- Interface: the one change to an existing method. The API's split-path relay, `packages/web`'s split path and the
  smoke page's direct flow must send `signature` before the v3 upgrade lands (v2 ignores the extra field); batch 6.
  No path, CKD request or derivation changes.
- Rejected: relying on the vault rule alone (the contract can make the bad recovery impossible to set up).

### D138. A replacing signer policy needs new signer ids and cancels dropped signers' pending keys
- Date 2026-10-30 · Status: built (`feat/email-login-1-r2`), from the second review (N3)
- Decision: in `set_signer_policy` with `overlap = false`, new keys may only go to signer ids the previous policy
  didn't list (`A replacing policy adds keys only for new signer ids`); in either mode, pending `AddForSigner`
  changes of signers that leave the policy are cancelled (event `issuer_key_change_cancelled`, `by` = the contract).
- Why: a replacing upgrade that kept the id `cosign` with a new key left the compromised old `cosign` key counting
  (keys were dropped by signer id only); and a dropped signer's owner-posted pending key would revive, executable by
  anyone, if a later upgrade listed the id again.
- Rejected: an explicit list of kids to remove (the owner can already remove any key at once with
  `remove_issuer_key`; a new id makes the replacement visible in the policy itself).

### D139. Off-chain guards from the second review: case-B signing only after the popup's own email step; a watchdog alert
- Date 2026-10-30 · Status: obligations for later batches (`docs/email-login-build-plan.md` batches 5 and 8), from
  the second review (N2, N4)
- Decision:
  - The vault signs a linked payload with `join = 2` (an email identity joining the Google identity's account) only
    when this same popup ran the user's email-code step for this login (`verify` → `linkTicket`) and the link token's
    `sub` equals the `sub` of the address verified there. A case-B token offered during a plain Google login is
    refused.
  - The watchdog raises a critical alert whenever `get_config().unrecorded_wallets` is `true` on an env that isn't a
    dev env.
- Why: since D133 a case-B join happens only when the vault signs the linked payload, so the vault is the last check
  that the user really proved the email address in this flow; without it a compromised issuer service could serve a
  case-B token during a plain Google login. The flag must never be true on mainnet (D135); a runbook check alone can be
  skipped.

### D176. Identity mint limits: narrow to wide, sliding, none shared with the vault; the replay marker last
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`apps/api/src/identity/limits.ts`, `token.ts`
  `identityQuota`, `rate-limiter.ts` `hitSliding`) · Source: the identity token's security review (M1, L2, L3, L5)
- Decision: `/v1/identity/token` asks, in turn: the vault gate's per-IP binding (only: the app's `vault:minute` quota
  is no longer used, so mints can't starve unlocks) → … → the session proof's signature → per session key 10/min
  (binding) → not paused → share → chain session → wallet proofs → the single-use marker → per account root 30/min
  (binding `IDENTITY_ROOT_LIMIT`, keyed by the HMAC `sub` bytes) → per app `identity:minute` (10 × plan `per_minute`)
  and `identity:hour` (plan `per_day`, at most 100 000) → per scope `identity:hour` (2 × the app's) → global: a hard
  breaker of 1 000 000/h (≥ 10 × any app's ceiling, so no one tenant can trip it) and a soft line at 100 000/h that
  logs `identity_volume_alert` (critical) without refusing. The app, scope and global windows are sliding (the
  previous bucket weighted by its overlap) and counted only for a request that passed every other check; a refusal by
  a later window takes the hit back from the earlier ones. The marker is reserved only once the proof is known to be a
  live session's (random keys create none), keyed `sha256(sessionPk ‖ u64le(issuedAtMs) ‖ nonce)` (independent of the
  signature's encoding), and an alarm on the marker object deletes expired markers.
- Why: the global hourly breaker was reachable by one tenant (three free apps at 600/min) and then refused every app
  for up to an hour. Amends D173's global ceiling (100 000/h, refusing).
- Rejected: one exact per-root object (a Durable Object per user per hour; the binding is a flood limit anyway).

### D177. Testnet identity keys: the standby stays off the Worker; rotation and retirement commands
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`scripts/lib/identity-key.ts`,
  `packages/playbooks` `identity-signing-key-compromised`) · Source: the identity token's security review (M2)
- Decision: `identity-key init` uploads only the active key and the sub key; the standby is published in the JWKS
  but never uploaded (operators move its file offline), so a leak of the Worker's secrets or the Cloudflare account
  doesn't reach it. New commands: `next` (generate and publish a rotation key, upload nothing), `switch --to
  next|standby` (upload it into the Worker slot the active key isn't in, make it the manifest's `activeKid`; the old
  active key becomes `previous`, still published), `retire --key previous|standby` (unpublish, delete its Worker
  secret if it has one, set its file aside). `.secrets/<env>/identity-slots.json` records which slot holds which kid.
  `gen --dev-vars` writes only the active key. The compromise playbook (operations.md, `docs/playbooks.md`): treat
  both keys as exposed unless the incident provably touches only the active one; then retire the standby too and
  rotate to a fresh key.
- Why: two keys side by side on one Worker and uploaded together made "switch to the standby" keep a compromised
  key. Amends D173 (the standby slot is now a rotation slot) and the spec's rotation playbook.

### D178. A dead or other app's share stops mints in every app of the scope; shares kept as tombstones for 24 h
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`apps/api/src/identity/token.ts` `checkShare`,
  `vault/cron.ts` `pruneShares`) · Source: the identity token's security review (L1)
- Decision: the mint looks a session key's share up in any app: a share that belongs to another app refuses the mint
  (`410 session_ended`, `reason: unknown_share`) whatever this app's persistence, so a session revoked (or simply
  persisted) in a `session` app of a scope never mints in a `none` app of the same scope. The hourly cron deletes a
  revoked or absolutely expired share only once it is older than 24 h (the contract's `MAX_SESSION_MS`), so the row
  outlives any on-chain session it could stand for.
- Why: `getShareBySessionPk` was per app and the cron deleted revoked rows within the hour, so a revoked session kept
  minting in a `none` app until its on-chain expiry, against D171 and `docs/security.md`. Amends D171.

### D179. Raw signing never covers Hana's signing domains; `wallets` proves control, not derivation
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`packages/web/src/vault/signing.ts`
  `refuseReservedRaw`, `docs/integration.md` section 15) · Source: the identity token's security review (L4, L6)
- Decision: in apps with raw signing on, the vault refuses (4100, `reason: raw_reserved_domain`, before any popup) a
  Stellar raw request whose bytes start with `hana-id`, and an EVM raw digest equal to the session's own identity
  wallet-proof digest, so an approved raw signature can't serve as a wallet proof. The guide says what `wallets`
  proves: the session's holder controls each address's key, not that it is the Hana-derived wallet of that `sub`; one
  address can appear under several `sub`s (an exported or reused key, an old `key_index`), so partners must not treat
  wallet → `sub` as unique (per-wallet credits).
- Why: defence in depth for the wallet proof; the guide overstated the claim.
- Accepted residual (automated review, 2026-10-30): the EVM check covers only this session's own proof digest. A raw
  EVM digest is opaque, so a user who approves a raw signature over another session's wallet-proof digest lets that
  session list their address. Not fixable at the source: raw signing signs any digest, whatever structure (EIP-191,
  EIP-712) the proof used, and the API can't check that an address is the account's Hana-derived wallet (CKD output
  is never on chain). The approval already authorizes arbitrary signatures (transactions included, with the popup's
  warning), and partners must not treat wallet → `sub` as unique, so the impact is within what the guide states.
  Revisit if addresses are ever recorded on chain.

## Superseded or amended

| Was | Now | Source |
|---|---|---|
| Local git only, branch `develop`, no remotes (batch A) | Remote `Hana-Technology/hana-id`; feature branches, PRs into `develop`, `main` for releases | `docs/batch-a-spec.md`; CLAUDE.md |
| One relayer key pool, 300 Tgas for everything (batch A) | Two pools, per-method gas (D19) | `docs/batch-a2-shared-client.md` |
| Hana can never block derivation for a scope (batch A) | True for scopes with their own client; Hana can stop a shared-only scope by removing shared clients | `docs/contract-interface.md` security notes |
| Provisional HKDF salt `hana-embed-ckd-v1` | Derivation v1 (D9) | `docs/batch-b-spec.md` "Address impact" |
| PoC keys in plaintext `sessionStorage` | Vault iframe on a Hana origin (D22, D47) | `docs/context.md` "Known issues for batch B" |
| CKD network key read over RPC | Pinned per env (`ckdNetworkKey`) | same |
| Full Google token with email on chain | `scope=openid` and the claim allow-list (D25) | same |
| Login page computes the shared-mode nonce (A.2) | The vault computes it; the login page only checks and relays it (D47) | `docs/batch-b-spec.md` "Amends" |
| Contract upgradeable with no lock (batch A, PoC) | Still so on testnet; upgrade governance before mainnet (D2, D33) | `docs/batch-a-spec.md` |
| Partners build the SDK from this repository and compile its TypeScript sources | Built tarballs (`pnpm pack`), installed with npm; no registry yet (D71, D72) | `docs/integration.md` "Install" |
| Only Hana staff issue invites (D29) | Hana invites each org's first owner; owners invite viewers and owners, a new owner waits 24 h as a viewer (D89) | `docs/batch-c-spec.md` "Invites" |
| Governance draft: owner DAO 3-of-3 for policy and member changes; sandbox-dev signer full-access key deleted | 2-of-3 for every kind (D81); sandbox-dev keeps the key, staging and mainnet never have one (D86) | `docs/governance-spec.md` |
| Vault per-IP and per-share limits on `RateLimiter` objects, the share hit sent alongside the IP one and refunded (D78) | Rate Limiting bindings `VAULT_IP_LIMIT` and `VAULT_SHARE_LIMIT`, per location and approximate, asked in turn with no refund; the app quota stays on the object (D95) | `docs/api.md` "Rate limits" |
| Batch C draft retention: ledger 400 days, uid stripped 35 days after the month, audit 36 months | Statements and settlements 7 years, raw usage 24 months then de-identified, audit 5 years (D90) | `docs/batch-c-spec.md` "Retention" |
| Sodax Stellar `signAndSendTransaction(p)` is `sendTransaction(signTransaction(p.data))` | It signs as `p.from`: `sendTransaction(signTransaction(p.data, {address: p.from}))`, so a raw transaction built for another account (a muxed `M…` address included) is 4100 before any popup. Sodax builds every raw transaction for `getWalletAddress()`'s `G…` address. Confirmed (D67) | `docs/batch-b-spec.md` "Sodax adapter"; `packages/sodax/src/stellar.ts` |
| `/login` calls `GET /v1/app` itself and cross-checks the vault's signer, scope and client before Google (batch B "Login" step 4) | It checks the pinned signer and the nonce only, makes no API call, and shows the vault's app name (D77) | `docs/security.md` "The login popup trusts the vault's app facts" |
| Every approval popup opens from the vault's "Review in Hana" launcher (batch B "Approval flow" steps 1–2) | A signing call from a click opens it in that click (`/approve?from=partner&v=…`); the launcher is the fallback without user activation or when `window.open` returns null (D99) | `docs/batch-b-spec.md` "Approval flow" |
| CODEOWNERS on derivation, vectors, the contract and the env schema (D58) | Also `/envs/`, the API, web, core and watchdog sources, `scripts/`, lockfiles, `.gitleaks.toml`, `.githooks/`, `.github/`; a second owner to add (D100) | `.github/CODEOWNERS` |
| One global owner-action cap (20/min, 200/day); the relay quota counted in the gate, before verification | Caps per owner, per scope and global, `execute_change` and `cancel_change` on windows of their own; the relay quota counted right before the relay (D100) | `docs/api.md` "Rate limits" |
| `fetch-ckd-key` reads the CKD key from the manifest's `rpc` | From ≥ 3 independent providers at one final block, all agreeing, with the block recorded (D100) | `docs/operations.md` "Create an environment" step 3 |
| Stellar classic operations other than changeTrust, payment and createAccount shown by type with their raw XDR (batch B "Approval flow" step 4) | Every operation decoded field by field; account-control operations get a red banner and per-operation warning and are never auto-approved (D110) | `packages/core/src/decode/stellar.ts` |
| The export window shows the key while a button is held until the window closes (batch B "Key export" step 5) | The key is erased 5 min after it is derived or when the session ends, whichever is first; a new export needs a new sign-in (D111) | `packages/web/src/auth/export-page.ts` |
| The vault persists (share, record) before it replies to `hana_login` (batch B "Login" steps 11–12) | It replies first; the share and record follow in the background, and a failure turns `persistence` to `'none'` (`persistenceChanged`, D79) | `packages/web/src/vault/vault.ts` `persistLogin` |
| Email login deferred (D4) | Confirmed: a Hana-run issuer (D4, D119, D121–D123), not built | `docs/email-login-spec.md` |
| Hana requests only `scope=openid` from Google (D25) | The on-chain token stays openid-only; the popup also requests `email`, which the issuer handles transiently off chain at link time, keeping only an HMAC (D25 amended) | `docs/email-login-spec.md` "How the popup gets Google's verified email" |
| End users are never contacted by Hana (D96) | Still no stored address; Hana sends only sign-in codes and link notices the user's action triggered (D96 amended) | `docs/email-login-spec.md` "Notices" |
| Email spec draft: AWS KMS key from the start, single-signature tokens | Worker-secret key on testnet, AWS KMS before mainnet; a signer policy and multi-signature JWS JSON tokens from day one (D121) | `docs/email-login-spec.md` "Signing key (staged)" |
| Email spec draft: Gmail-only immediate linking, case B always 24 h, a switcher for two wallets (case D) | Google-hosted (Gmail or matching `hd`) links at once in cases A and B, others need a code (A) or 24 h (B) (D119); never a second wallet, no switcher (D122) | `docs/email-login-spec.md` "The four cases" |
| Email spec draft: disposable-address domains allowed | Blocked (D123) | `docs/email-login-spec.md` "Rate limits and abuse" |
| Email spec: `opened` recorded at every `create_session*` | Recorded at derivation (D130) | `docs/contract-interface.md` "Accounts and links" |
| Email spec: `auto_link` nonce over the session, the session identity, the target epoch and the mode; the combined login signed over the plain CKD payload | The nonce also commits to the join (who joins which account), and with a link the session key signs the linked CKD payload (D133) | `docs/email-login-spec.md` "Byte layouts (new)", "Sessions" |
| Email spec: `mark_self_issued(provider)` for any issuer | Only `email` (D134) | `docs/contract-interface.md` "Self-issued issuers" |
| `create_session` opens a session for anyone holding the token; after a front-run `create_session` the key holder derives with counter `used + 1` | A bare `create_session` needs the session key's proof of possession bound to its parameters; a session meant to carry a link is revoked and restarted, never derived plainly (D137) | `docs/contract-interface.md` "Sessions and CKD" |

## Proposed, not yet confirmed

Still open in `docs/batch-b-spec.md` "Open questions": Q2 (near-zero-click returning login), Q4 (partitioned IndexedDB
retention, to measure), Q6 (a "remember this device" option), Q10 (the ship gate's 1.5 s threshold), Q11 (the real
MPC's timeout and failure behaviour), Q13 (dropping partner-origin CORS for `pk_test_` in sandbox envs), Q15 (the
production domain names and Cloudflare account; only "two registrable domains" is decided, D38), Q17 (approval popup
lifetime and mobile behaviour), Q24 (mobile and in-app webviews), Q25 (SWK 1.9.x and 2.x), Q26 (the EIP-6963 `rdns`,
after Q15), Q29 (runtime dependencies and bundle budget). Also open: the mainnet launch date (D39); the mainnet
issuer-key delay is provisional until the lead-time measurement is in (D80).

Still open in `docs/governance-spec.md`: where the mainnet backup council key is held (D81, before mainnet), the
paging app (D85, at setup), and open question 17 (cancel by a compromised OIDC owner, from batch C Q9). Still open in
`docs/batch-c-spec.md`: Q1, Q3, Q4's fallback addresses, Q5 (D93). Everything else in both specs follows D80–D93 or
is a proposal there.

Still open from `docs/email-login-spec.md`: the user-mail provider (Resend unless the colleague picks another,
D87). Everything else follows D4, D119 and D121–D123. The contract readings made while building it, D130 and D131,
wait for the user's confirmation (`docs/email-login-build-plan.md` "Open points for the user"; point 3 is confirmed, D132);
D133–D138 are the security reviews' fixes, D139 their off-chain obligations.
