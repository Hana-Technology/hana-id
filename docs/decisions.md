# Decision log

One entry per decision: what was decided, when, why, what was rejected, its status, and where it is written down.
Last verified against code: 2026-10-28 (commit 14e6fc3, `feat/batch-b`); D35–D38 and the amendments against the batch B
fix branches (2026-10-28); D39–D63 against `feat/b-defaults` (2026-10-28).

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
- Date ≤ 2026-10-26 · Status: in force (adapter package scaffolded only) · Source: `docs/context.md` "Decisions"
- Decision: nothing customer-specific. The core SDK exposes standard interfaces (EIP-1193, Stellar Wallets Kit, raw
  sign); Sodax gets a thin optional adapter (`@hana-id/sodax`, `IStellarWalletProvider`). Pilot wallets on
  testnet-MPC keys are disposable.

### D4. Email login later, as its own trust decision
- Date ≤ 2026-10-26 · Status: deferred · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Why: whoever signs email tokens can derive any email user's key. Batch A made the verifier provider-generic
  (`issuers.rs`) so email can be another issuer.

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
  give the same address (Google `sub` confirmed stable across one project's clients, 2026-10-27).

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
- Date 2026-10-27 · Status: in force on `feat/batch-b` (`apps/api/src/vault/`, `packages/web/src/vault/`) ·
  Source: `docs/batch-b-spec.md` "Confirmed by the user", "Key persistence"
- Decision: per-app `persistence: 'session' | 'none'` (default `'session'`). In `'session'` mode the session has
  `max_uses = 1`; the browser stores PRK encrypted under `K_s`; the API returns `K_s` only for a signed, in-order,
  unexpired, unrevoked share request. Idle and absolute limits, revoke and revoke-all.
- Why: a Privy-like experience; and a reload costs nothing on chain instead of ~$0.02 and 6–9 s.
- Rejected: local AES-GCM of S with a session key that still has uses (R5: `derive_key` is permissionless, so the
  server limits would be bypassable on chain).

### D23. Approval popup by default; opt-in auto-approve policies
- Date 2026-10-27 · Status: in force on `feat/batch-b` (`packages/core/src/policy/`, `packages/web/src/vault/`) ·
  Source: `docs/batch-b-spec.md` "Confirmed by the user", "Auto-approve policies"
- Decision: every signature needs a guarded Approve in a Hana popup unless it matches a policy the app owner set
  (delayed) and the user accepted (bound to `policyId`). Off by default; two opt-ins. Batch B covers typed calls only
  (direct calls with typed address arguments, token approvals to listed contracts, listed Stellar `changeTrust`).
  Raw signing, `personal_sign`, `stellar_signMessage` and contract creation are never covered.
- Why: Privy offers a confirmation toggle and delegated-action policies; this is the equivalent without a
  server-side signer (the key exists only in the vault).
- Rejected: "partners can't turn approval off"; server-side delegated signing.

### D24. No protocol decoder in batch B; Sodax uses the popup
- Date 2026-10-27 (Q42) · Status: confirmed · Source: `docs/batch-b-spec.md` "Sodax needs a protocol decoder", Q42
- Decision: Sodax spoke calls carry intents in opaque bytes on EVM and Stellar, so no policy can check them. Batch B
  ships the `ProtocolDecoder` interface with an empty registry; a `sodax-intent-v1` decoder comes later on demand.
  `AssetManager.transfer`, `Connection.sendMessage` and `send_message` may never have `addressArgs: 'any'`.
- Why: an arbitrary `data` on a tiny deposit could empty the user's hub wallet; value limits don't bound that.

### D37. Auto-approve: fees count as spend; opaque arguments always need a decoder
- Date 2026-10-28 · Status: in force on `fix/b-core-policy` (`packages/core/src/policy/`) · Source: conversation
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

### D25. Google Workspace accounts are allowed; openid-only tokens
- Date 2026-10-28 · Status: confirmed, in force (`apps/api/src/claims.ts`, `packages/core/src/id-token.ts`) · Source:
  conversation; `docs/batch-b-spec.md` "Confirmed by the user", Q1, Q32
- Decision: Workspace users log in normally. The claim allow-list stays as a guard against Google adding claims.
- Why: the spike (`apps/smoke/spike.html`, Chrome) showed `scope=openid` tokens for both a personal and a Workspace
  account carry exactly `{aud, azp, exp, iat, iss, jti, nbf, nonce, sub}`: no `hd`, email, name or picture. So
  blocking Workspace accounts is neither possible nor needed, and no domain or PII reaches the chain.
- Rejected: refusing tokens with `hd` (the spec's earlier position, which would have blocked Workspace users).

### D26. One transaction per login, with a ship gate
- Date 2026-10-28 · Status: confirmed; contract and API in force, not yet measured on testnet · Source:
  `docs/batch-b-spec.md` "Confirmed by the user"; `docs/contract-interface.md`
- Decision: `create_session_and_derive`, a literal composition of `create_session` and `derive_key` with counter 1,
  through `POST /v1/login`. If the 10-run testnet median saves less than 1.5 s, the method is removed before the
  audit and the split flow stays.
- Why: measured ~2 s of the ~8.9 s login is the second transaction.

### D27. Export proves freshness by a new login, not `auth_time`
- Date 2026-10-28 (Q33, spike) · Status: confirmed · Source: `docs/batch-b-spec.md` Q33
- Decision: export runs its own fresh login plus a typed confirmation; the `auth_time` check is off
  (`packages/core/src/id-token.ts:113`).
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
- Why: the spec's `pointermove`-only rule never arms on a stationary tap or from the keyboard, so phone and
  keyboard-only users could not approve. Keeping mouse on `pointermove` means clicking in place never approves, and
  keeping Enter and Space out means a held key never approves.
- Residual risk (accepted): on a phone, someone tapping repeatedly for more than 1 s after the popup tab opens can
  still approve in two taps, if the second lands on Approve.
- Rejected: `pointermove` only (unusable on touch and keyboard); any `pointerdown` or `keydown` arming (the deviation
  first coded in `fbdb0ce`: mouse click-spam or a held Enter could approve in two events).

## Batch C (dashboard), decided 2026-10-27

The batch C spec (`docs/batch-c-spec.md`) is a draft; only the entries below were decided with the user.

### D28. A developer dashboard like Privy's
- Date 2026-10-27 · Status: confirmed, not built · Source: `docs/context.md` "Batch C decisions"
- Decision: partners manage orgs, members, apps, origins, keys and on-chain owner actions (`/v1/owner-actions` with a
  console-client token). Replaces `admin app:*` after the pilot.

### D29. Invite-only sign-up
- Date 2026-10-27, reconfirmed 2026-10-28 · Status: confirmed, not built · Source: `docs/context.md` "Batch C
  decisions"; conversation
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
- Date 2026-10-27 · Status: confirmed, not built (delay length open) · Source: `docs/context.md` "Batch C decisions"
- Decision: origin changes need a fresh sign-in, are logged and email the other owners.
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
  the watchdog may approve early when the key matches Google's list. No address change.

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
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`packages/core/src/networks.ts`, `packages/web/src/vault/signing.ts`,
  `packages/web/src/client/ethereum.ts`) · Source: `docs/batch-b-spec.md` Q27; decided by the user; how "mainnet" is
  defined: default approved by the user (2026-10-28)
- Decision: the vault refuses mainnet Stellar passphrases and mainnet EVM chain IDs for `pk_test_` apps (keys from the
  testnet MPC). Sodax integrates and tests on chain testnets; real Sodax swaps through Hana wait for the mainnet launch.
- How: Stellar mainnet is the passphrase `Public Global Stellar Network ; September 2015` (the only one a mainnet
  accepts). EVM uses an **allowlist** of testnet chain IDs (`TEST_EVM_CHAINS`: Sepolia 11155111, Holesky 17000, Base
  Sepolia 84532, Arbitrum Sepolia 421614, OP Sepolia 11155420, Sonic Blaze 57054, BSC testnet 97, Polygon Amoy 80002,
  Avalanche Fuji 43113, local 31337 and 1337); anything else counts as a mainnet. Refused before any popup or policy
  (4100 `mainnet_not_allowed`): transactions and auth entries for those networks, and typed data whose domain
  `chainId` is one. Messages, typed data without a `chainId` and raw requests name no network (D35) and are allowed.
  The EIP-1193 provider refuses `wallet_switchEthereumChain`/`wallet_addEthereumChain` to such a chain and
  `eth_sendTransaction`/`eth_signTransaction` on one. The approval and consent screens of a test app say Hana signs
  only for test networks.
- Rejected: a denylist of known mainnets (a new or unlisted chain would be allowed).
- Why: testnet MPC keys can be stolen (weaker operator and node standards) or lost (a network reset changes every
  address), and testnet-derived addresses differ from production ones.
- Rejected: allowing mainnet with warnings and small amounts.
- Open: the mainnet launch date (not set).

## Defaults approved by the user, 2026-10-28

Each entry below is a default the user approved on 2026-10-28 (source: conversation, "default approved by the user").
The matching question in `docs/batch-b-spec.md` "Open questions" points here.

### D40. Batch B reconciliations R1–R13 and the remaining batch B decisions confirmed (Q30)
- Date 2026-10-28 · Status: in force on `feat/batch-b` · Source: `docs/batch-b-spec.md` "Reconciled conflicts",
  "Decisions (2026-10-27/28)"
- Decision: R1–R13 stand as the spec takes them (two origins; relay-only, end-to-end encrypted token return; vault page
  inlines D1 config and reads `GET /v1/app` lazily; BLS key `a` made after the token arrives; server share plus one
  AES-GCM layer; `max_uses` 1 / 2 / 1; PRK only; export by a fresh login; logout without a transaction; the
  `{v:1,t}` envelope; the encrypted relay plus a defence-in-depth RS256 check; `revoke-all` only within 5 min of a
  fresh login; each tab unlocks itself). Also confirmed as built: the vault iframe plus Hana popups on two origins,
  the token returned only through the encrypted relay, the Google implicit flow, the pinned `signer`/`relayer`/CKD
  key, the vault computing the path, storage partitioning accepted as per-partner isolation, and dev-only privileges
  tied to the env name.

### D41. No silent `app_signed` raw signing in the MVP (Q31)
- Date 2026-10-28 · Status: in force (`raw_sign` is `'off'` or `'approval'` only) · Source: `docs/batch-b-spec.md` Q31
- Decision: raw signing is off or needs an Approve every time. If it comes back, only as requests signed by a
  per-app partner backend key, registered through batch C's fresh-sign-in, logged, notified and delayed process.
- Why: as first specified it was silent signing of chain-valid hashes, controlled by a D1 column.

### D42. A new login supersedes a pending one (Q34)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/vault.ts` `newPending`) · Source: `docs/batch-b-spec.md` Q34
- Decision: `hana_login` while a login is pending ends the old one with `login_cancelled` instead of answering `busy`.

### D43. No local `K_l` wrapping layer (Q35)
- Date 2026-10-28 · Status: in force (the record holds PRK under `K_s` only) · Source: `docs/batch-b-spec.md` Q35
- Why: it stops no named attacker: whoever can read the record and call the API already gets `K_s`.

### D44. Test and live apps never share a scope (Q37)
- Date 2026-10-28 · Status: in force (`scope_conflict`, `apps/api/src/apps.ts`) · Source: `docs/batch-b-spec.md` Q37,
  the "Proposed, not yet confirmed" list
- Decision: loopback origins and partner-origin session endpoints only in `local*`/`sandbox*` envs, and a `pk_test_`
  app on a scope a `pk_live_` app uses is refused. A partner's staging uses its own scope, so different addresses.

### D45. Enabling raw signing uses the origin-change delay (Q38)
- Date 2026-10-28 · Status: in force for raw signing (24 h, `changeDelayMs` in dev envs); batch C reuses it ·
  Source: `docs/batch-b-spec.md` Q38
- Decision: `raw_sign = 'approval'` waits the same 24 h as an origin change (D34); batch C's dashboard puts both
  through the same delayed, logged and notified path. Turning it off is immediate (D61).

### D46. `max_uses = 1` in `'session'` mode (Q14)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/login.ts`) · Source: `docs/batch-b-spec.md` Q14, R6
- Decision: `ckd_failed` or a replayed combined call means a new login. No spare use burnt with `revoke_session`.
- Why: the share precondition ("the session is used up") stays simple; measure the MPC failure rate in the pilot.

### D47. `VAULT_KEK` stays a Worker secret with its copy in `.secrets`; KMS later (Q16)
- Date 2026-10-28 · Status: in force (`scripts/vault-kek.ts` `init`/`rotate`, `VAULT_KEK_PREVIOUS`, the cron re-wrap)
  · Source: `docs/batch-b-spec.md` Q16
- Decision: rotation through `vault-kek rotate`; an HSM/KMS move is revisited with the email issuer (D17).

### D48. The vault zeroes PRK after an in-memory idle period (Q28)
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`packages/web/src/vault/vault.ts` `goIdle`, `wake`) ·
  Source: `docs/batch-b-spec.md` Q28
- Decision: after the app's `idle_ttl_ms` with no request from the partner page (signing, status, addresses, export,
  auto-approve), PRK is zeroed, not only at the absolute end. In `'session'` mode the next request that needs the key
  unlocks the record again (one API call, same share only), which works while the server share is alive; otherwise,
  and in `'none'` mode, the session ends (`sessionExpired`).
- Why: shortens how long PRK sits in a tab nobody uses, where a renderer bug could reach it (security.md (j)).

### D49. The vault checks its scope against the on-chain registry at login (Q7)
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`packages/web/src/vault/login.ts` `checkScope`) · Source:
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

### D50. Keep `create_session` (Q12)
- Date 2026-10-28 · Status: in force (contract method kept; relayed only for the split fallback and `apps/smoke`) ·
  Source: `docs/batch-b-spec.md` Q12
- Decision: `create_session` stays a public method, not removed before the audit.

### D51. CODEOWNERS on derivation, vectors, the contract and the env schema (Q23)
- Date 2026-10-28 · Status: in force (`.github/CODEOWNERS`; needs "Require review from Code Owners" on `develop` and
  `main`) · Source: `docs/batch-b-spec.md` Q23
- Decision: `@tzechuen` owns `packages/core/src/derivation*`, `packages/core/test/vectors/`, `contracts/hana-signer/`
  and `packages/env/src/`.

### D52. Key export: only from a Hana window, relayer-paid, rate-limited per user (Q18)
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`apps/api/src/login.ts`) · Source: `docs/batch-b-spec.md` Q18
- Decision: a partner page can only ask (`hana_export` shows the vault's launcher); the export window opens only from
  that click and takes its context only from the vault that opened it. Its `/v1/login` is relayed at Hana's cost and
  limited to 3 per hour per `(app, sha256(path))`, counted after the token check and before the relay.

### D53. Two Google sign-ins are acceptable for a `key_index` move (Q20)
- Date 2026-10-28 · Status: confirmed (rotation not built) · Source: `docs/batch-b-spec.md` Q20
- Decision: a k → k+1 sweep needs one sign-in per `key_index`; no contract change to derive two indices per session.

### D54. Account 0 only in the MVP UI (Q21)
- Date 2026-10-28 · Status: in force (the vault signs and derives addresses with account 0 only, `signing.ts`
  `ACCOUNT`; the export window exports account 0; no port method takes an account) · Source: `docs/batch-b-spec.md` Q21
- Decision: `account > 0` stays unused until there is a discovery story.

### D55. A removed policy stops auto-signing within 10 s
- Date 2026-10-28 · Status: in force (`POLICY_FRESH_MS`, `packages/web/src/vault/vault.ts`) · Source: `docs/security.md`
  "Auto-approve policies"
- Decision: an open vault auto-signs only under a policy `GET /v1/app` confirmed less than 10 s ago.

### D56. Permit2 and Uniswap v3 calls need a protocol decoder
- Date 2026-10-28 · Status: in force (the `uint160` rule of D37) · Source: D37, `docs/security.md` (d)
- Decision: their `uint160` fields keep them out of auto-approve until a decoder covers them; the popup handles them.

### D57. The BLS precheck stays off unless measured cheap (Q8)
- Date 2026-10-28 · Status: in force (`BLS_PRECHECK = "0"` in every env) · Source: `docs/batch-b-spec.md` Q8
- Decision: turned on only if a measurement shows its Worker CPU cost is acceptable (Workers Paid plan); the MPC
  refuses a bad key anyway.

### D58. Optional `rpcFallback` for the vault's NEAR reads (Q9)
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`packages/env/src/schema.ts`, `packages/web/src/near-call.ts`) ·
  Source: `docs/batch-b-spec.md` Q9
- Decision: the manifest may name a second https NEAR RPC. The vault and the export window read from it only when the
  primary errors or times out (8 s), for `get_session` re-syncs, registry views and tx polling; each read's answer
  comes from one endpoint, never a mix. It joins `rpc` in the pages' CSP. sandbox-dev sets none yet.

### D59. One thin Worker per Hana origin (R19)
- Date 2026-10-28 · Status: in force (`apps/api/scripts/pages-wrangler.ts`, `apps/api/src/pages/`) · Source: review
  finding R19 (moved from "Proposed")
- Decision: every env serves `vaultOrigin` and `authOrigin` from one thin Worker each (`workers.dev` in dev envs,
  Custom Domains in production), not from routes on the API Worker, so neither origin can serve the other's files.
  Production runs three Workers.

### D60. The Sodax Stellar adapter signs as `rawTx.from` only (R51)
- Date 2026-10-28 · Status: in force (`packages/sodax/src/stellar.ts`) · Source: review finding R51; the
  "Superseded or amended" row below
- Decision: `signAndSendTransaction(p)` signs with `{address: p.from}`, so a raw transaction built for another account
  (a muxed `M…` address included) is 4100 before any popup.

### D61. Raw signing `'off'` takes effect in open tabs
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`GET /v1/app` `rawSign`; `packages/web/src/vault/vault.ts`
  `freshRawSign`) · Source: `docs/security.md` "Auto-approve policies"
- Decision: the vault re-reads `rawSign` before every raw request on the same 10 s bound as the policy; `'off'`
  refuses until a reload, and a failed re-read refuses (fails closed).

### D62. An EVM policy rule needs `maxValueWei ≥ maxFeeWei`
- Date 2026-10-28 · Status: in force on `feat/b-defaults` (`packages/core/src/policy/validate.ts`) · Source:
  `docs/security.md` (b)
- Decision: the validator refuses a rule whose `maxValueWei` is below its `maxFeeWei` (value plus fees counts
  against it since D37, so it could never auto-approve at its fee cap). The consent screen labels the limits
  "Maximum value plus network fees, per transaction / per day".

### D63. No cookies on Hana origins
- Date 2026-10-28 · Status: in force (`apps/api/src/pages/host.ts` `withoutCookies`; tests in apps/api, packages/web
  and the Playwright suite) · Source: D38 ("no domain-wide cookies")
- Decision: no response from the vault origin, the auth origin or the API sets a cookie; the page Workers drop one a
  binding returns.

## Superseded or amended

| Was | Now | Source |
|---|---|---|
| Local git only, branch `develop`, no remotes (batch A) | Remote `Hana-Technology/hana-id`; feature branches, PRs into `develop`, `main` for releases | `docs/batch-a-spec.md`; CLAUDE.md |
| One relayer key pool, 300 Tgas for everything (batch A) | Two pools, per-method gas (D19) | `docs/batch-a2-shared-client.md` |
| Hana can never block derivation for a scope (batch A) | True for scopes with their own client; Hana can stop a shared-only scope by removing shared clients | `docs/contract-interface.md` security notes |
| Provisional HKDF salt `hana-embed-ckd-v1` | Derivation v1 (D9) | `docs/batch-b-spec.md` "Address impact" |
| PoC keys in plaintext `sessionStorage` | Vault iframe on a Hana origin (in progress) | `docs/context.md` "Known issues for batch B" |
| CKD network key read over RPC | Pinned per env (`ckdNetworkKey`) | same |
| Full Google token with email on chain | `scope=openid` and the claim allow-list (D25) | same |
| Login page computes the shared-mode nonce (A.2) | The vault computes it; the login page only checks and relays it (proposed in batch B, below) | `docs/batch-b-spec.md` "Amends" |
| Contract upgradeable with no lock (batch A, PoC) | Still so on testnet; upgrade governance is a production MVP item (D2) | `docs/batch-a-spec.md` |
| Sodax Stellar `signAndSendTransaction(p)` is `sendTransaction(signTransaction(p.data))` | It signs as `p.from`: `sendTransaction(signTransaction(p.data, {address: p.from}))`, so a raw transaction built for another account (a muxed `M…` address included) is 4100 before any popup. Sodax builds every raw transaction for `getWalletAddress()`'s `G…` address. Confirmed (D60) | `docs/batch-b-spec.md` "Sodax adapter"; `packages/sodax/src/stellar.ts` |
## Proposed, not yet confirmed

The batch B items listed here before 2026-10-28 were confirmed as built that day (D40–D45, D59). Still open in
`docs/batch-b-spec.md` "Open questions": Q2–Q6, Q10, Q11, Q13, Q15, Q17, Q19, Q22, Q24–Q26, Q29, Q39–Q41. Every
decision in `docs/batch-c-spec.md` beyond D28–D32 and D34 is a draft.
