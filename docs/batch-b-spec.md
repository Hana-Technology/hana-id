# Batch B spec: SDK (vault, login pages, packages)

**Status: DRAFT (2026-10-27).** Written by a multi-agent design workflow (3 proposals + a judge per decision, then security, completeness and implementability reviews). Not yet reviewed or approved by the user: every decision and open question below needs confirmation before implementation.

This file is the source of truth for batch B. If code and this spec disagree, fix the code or raise the problem; don't diverge quietly.

Plan doc: https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi. The decision records this spec implements are vault-architecture, B-key-persistence, single-tx-login, google-flow and derivation-freeze, all dated 2026-10-27. Where this spec departs from one of them for safety, the change is marked and listed under [Open questions → Changes to the 2026-10-27 decisions](#changes-to-the-2026-10-27-decisions).

## Amends

Everything in A, A.2 and `docs/contract-interface.md` stands except:

| Document | Amendment |
|---|---|
| `batch-a2-shared-client.md`, `context.md` (A.2 decisions), `contract-interface.md` security notes ("Hana's login page computes a nonce…") | The **vault** computes the session nonce, not the login page. The login page only relays it after checking it (see [Login](#login)). |
| `batch-a2-shared-client.md`, `context.md` (two relayer pools) | The session pool's method list changes in three planned states (see [Relayer allowlists](#relayer-allowlists)). A.2 lists four methods. |
| `batch-a-spec.md`, `batch-a2-shared-client.md`, `contract-interface.md` | `key_index` is `u32` with `key_index ≥ 2^31` reserved (contract, API and SDK refuse it). |
| `batch-a2-shared-client.md` (`/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` callers) | Partner origins may call them only for `pk_test_` keys and only in `local*`/`sandbox*` envs. Elsewhere only Hana origins call them. |
| `batch-a2-shared-client.md` (`GET /v1/app`) | Adds `name` and `serverTimeMs` to the response, accepts `x-hana-parent-origin` from Hana origins, and uses the app's `google_web_client_id` when it is set. |
| `batch-a2-shared-client.md` (`/v1/sessions` checks) | Adds the claim allow-list (`token_has_pii`), behind `REJECT_PII_ON_SESSIONS` until smoke moves (see [Order of work](#order-of-work)). |
| `contract-interface.md` | New method `create_session_and_derive`, the `key_index` bound, the off-chain `hana-id-vault-v1:` prefix, and the note that the contract itself does not refuse PII claims. |

## Goal

Any web app can add Hana ID wallets with a few lines of code. A user logs in with Google with one click on the partner's own button plus Google's account chooser (Q2 tracks removing the chooser), and gets a Stellar and an EVM address. The partner signs through standard interfaces. Keys and Google tokens never reach the partner page. Testnet NEAR only. The work is built to production standards, because it runs on mainnet with real funds after the audit.

Batch B is done when:
- `@hana-id/core`, `@hana-id/web`, `@hana-id/react` and `@hana-id/sodax` build, and every behaviour listed under [Tests](#tests) has a passing test.
- A partner page on an allowed origin logs in through the shared client and through its own client (in a separate Google Cloud project) and gets the same addresses for the same Google account. Google uses `scope=openid` only, and the token on chain carries only allow-listed claims.
- A reload within the app's limits restores the wallet with zero `/v1/derive` calls, no chain transaction and no chain RPC.
- Every signature needs an Approve click in a Hana popup, bound to the whole request (bytes, chain, address, network context), unless it matches an auto-approve policy that the app owner set and the user accepted in a Hana popup (see [Auto-approve policies](#auto-approve-policies)). Raw signing always needs an Approve click.
- Derivation v1 is frozen in `@hana-id/core`, with test vectors and a CI guard. Key export works for both chains.
- `create_session_and_derive` is measured on testnet against the ship gate, and the result is recorded in `docs/context.md`.
- `apps/smoke` runs on `@hana-id/web` (the vault) instead of deriving keys in the page.

## Address impact (read first)

**Batch B changes every provisional address on both chains.** Derivation v1 replaces the provisional HKDF:

| | Today (`apps/smoke/src/chain-keys.ts`, PROVISIONAL) | v1 (this spec) |
|---|---|---|
| Salt (HKDF-Extract) | `hana-embed-ckd-v1` | `hana-id/chain-keys/v1/extract` |
| Structure | one-shot HKDF per chain | one HKDF-Extract to PRK, then HKDF-Expand per (namespace, curve, account) |
| Stellar info | `hana-embed stellar ed25519 v1` | borsh tuple `("hana-id/chain-keys/v1/expand", "stellar", "ed25519", 0)` |
| EVM info | `hana-embed evm secp256k1 v1` | borsh tuple `("hana-id/chain-keys/v1/expand", "eip155", "secp256k1", 0)` |
| EVM key | 32-byte output, throws if out of range | 48-byte output reduced with `mapHashToField` |

The salt and info prefix differ by their `/extract` and `/expand` suffixes on purpose, so neither can be mistaken for the other in a port. The golden info-bytes test and the salt constant test catch a swap.

These stay the same: the MPC network, the signer account, the path `scope#provider#sub#key_index`, the CKD `app_id`, the A.2 nonce layout and the CKD request. This is allowed because the address freeze has not happened, and sandbox-dev smoke wallets are disposable. From the address freeze on, `DERIVATION_V1` can't change. A later scheme would be a new opt-in version, and v1 stays derivable.

Nothing else in batch B changes an address. That covers `create_session_and_derive`, the `key_index ≥ 2^31` reservation (nobody uses those indices), the vault, `authOrigin`/`vaultOrigin`, the openid-only flow, `google_web_client_id` and key persistence. `authOrigin` is still effectively frozen once own-client partners register its callback URL. Changing it later breaks their redirect registrations, though not their addresses.

## Decisions (2026-10-27/28)

**Confirmed by the user:** keeping the wallet across reloads through the server-held share (Privy-like experience); approval by default with opt-in auto-approve policies (typed calls only in batch B, no protocol decoder yet); Workspace accounts allowed (the spike showed no `hd` with `scope=openid`); one-transaction login with its ship gate; derivation v1 names and structure, no global recovery phrase. Everything else below is still proposed and needs the user's review.


- **Vault iframe plus Hana popups** (vault-architecture). Keys live in a hidden iframe on `vaultOrigin`. Login, approval and export run in popups on a second Hana origin, `authOrigin`. Both origins host only Hana code.
- **The partner opens the login popup** synchronously in its own click handler. The popup finds the vault through `opener.frames[name]` and authenticates it by origin and source. When the browser blocks that (Safari after an `await`), the vault's launcher opens it instead (see [Login step 1](#login)).
- **The token comes back only through a server relay** (vault-architecture), end-to-end encrypted between the popup and the vault, so the Hana API never sees the relayed token. This is a write-once, read-once Durable Object slot that lasts 120 s. The design never relies on `window.opener` surviving Google's pages.
- **Google OIDC implicit flow** (google-flow): `response_type=id_token`, `response_mode=fragment`, `scope=openid`, `prompt=select_account`, plus `nonce` and `state`. The redirect URI is `{authOrigin}/login/callback` in both client modes. Google Identity Services is not used anywhere.
- **Claim allow-list** (changed from a PII deny-list). The vault and the API accept only tokens whose claims are all in `{iss, azp, aud, sub, iat, exp, nonce, nbf, jti, auth_time}` (final list from the spike). Anything else, named explicitly including `hd` (the Workspace domain, which identifies an employer), `email`, `email_verified`, `name`, `picture`, `given_name`, `family_name`, `locale` and `profile`, gives 400 `token_has_pii` with `data: {claim}`. This covers API-relayed tokens only: the contract itself parses claims with unknown fields ignored and accepts any token on a direct call (see [Invariants](#invariants-each-has-a-test)). Spike result (2026-10-28, `apps/smoke/spike.html`, Chrome): with `scope=openid` a personal and a Workspace account both got exactly `{aud, azp, exp, iat, iss, jti, nbf, nonce, sub}`: no email, name, picture and no `hd`. So Workspace accounts are allowed; the allow-list still refuses any other claim, which would only trigger if Google changed this.
- **The key survives reloads only through a server-held share** (B-key-persistence; confirmed by the user 2026-10-27 for a Privy-like experience). Each app has a `persistence: 'session' | 'none'` setting, default `'session'`. In `'session'` mode the session has `max_uses = 1`. The API stores a share only for a session that is used up, so the share is the only path back to the key. The share has idle and absolute limits and can be revoked.
- **Approval in a Hana popup by default; auto-approve only under a policy the user accepted** (user decision, 2026-10-27). An app owner may set an auto-approve policy (allowed contracts and functions, address rules, per-transaction and daily limits). Matching requests are signed without a popup only after the user accepts that exact policy once in a Hana popup; anything outside it gets the normal popup. Policies never cover raw signing, `personal_sign`, contract creation or classic Stellar operations other than listed trustlines. This replaces "partners can't turn it off", and is Hana's equivalent of Privy's confirmation toggle plus delegated-action policies, without a server-side signer (the key exists only in the vault). Raw signing has two states: off (default) or approval required, with a warning that raw signing can authorize any transaction on that chain. **The silent `app_signed` mode is removed from the MVP** (Q31). Approval is bound to the whole request, Approve is guarded against window-timing attacks, and the popup stays open for up to 15 s for follow-up requests.
- **One transaction per login** (single-tx-login; confirmed by the user 2026-10-28). A new contract method `create_session_and_derive` is a literal composition of `create_session` and `derive_key`, called through a new `POST /v1/login`. There is a ship gate: if the 10-run testnet median saves less than 1.5 s, the method is removed before the audit.
- **The vault computes the path itself** (single-tx-login, mandatory) as `scope#google#<sub from its own token>#<its key_index>`. It never uses a path, session or counter returned by the API.
- **Pinned per env, never read at runtime:** the CKD network key (manifest `ckdNetworkKey`), the **signer account** (manifest `signer`) and the relayer account (manifest `relayer`, used only as `sender_account_id` for tx polling). They are build constants in the vault, login and export bundles. Any inlined or API-supplied `signer` that differs from the constant stops the flow.
- **Derivation v1** (derivation-freeze; names and structure confirmed by the user 2026-10-28): `hana-id/chain-keys/v1/extract` + `/expand` as defined below. There is no BIP-39 phrase. Export is a raw key per chain, from a fresh login, in a top-level Hana window. No key material ever crosses `postMessage`.
- **Key rotation hooks.** `key_index` stays in the path. The MVP fixes `keyIndex = 0`, and partners can't set it. `key_index ≥ 2^31` is reserved in the contract, the API and the SDK.
- **Storage partitioning is accepted** as per-partner isolation. The Storage Access API is not used. Within one top-level site, records, the BroadcastChannel and the Web Lock are also scoped per app.
- **Dev-only privileges are tied to the env name.** Loopback origins (for partner pages, in `frame-ancestors` and `originAllowed`) and partner-origin calls to `/v1/sessions`, `/v1/derive` and `/v1/sessions/revoke` exist only in envs whose name starts with `local` or `sandbox`. A scope used by any `pk_live_` app can never be the scope of a `pk_test_` app.

## Reconciled conflicts (confirm with the user)

The decision records disagree in the places below. This spec takes one side each time. Each row is open for the user to overturn, and none of them affects an address.

| # | Topic | Records | This spec | Why |
|---|---|---|---|---|
| R1 | Origins | vault-architecture: `vaultOrigin` and `authOrigin`. google-flow: one `authOrigin` that also serves `/vault`. | Two origins. The vault page is `GET {vaultOrigin}/vault?pk=…`. Auth pages are `{authOrigin}/login`, `/login/callback`, `/approve`, `/export`. | Keeps the key-holding frame apart from the pages that handle tokens and UI. Popups authenticate the vault by `event.origin === vaultOrigin`. The callback path is google-flow's (exact redirect-URI match), not `/cb`. |
| R2 | Token return | vault-architecture: relay only. google-flow: `window.opener` in the MVP, rendezvous as a later hook. | Relay only, end-to-end encrypted (`relayKey`), with a read capability (`relayReadKey`) only the vault holds, plus google-flow's `state` check in first-party `sessionStorage` and its COOP canary. | Google already sends `cross-origin-opener-policy-report-only: same-origin`. One return path means one path to test. Encryption keeps the API from reading or replacing the token. |
| R3 | App config in the vault | vault-architecture: vault calls `GET /v1/app` with `x-hana-parent-origin`. google-flow: config inlined into the no-store vault page; it rejected the header. | The vault page inlines D1-only config (origins, settings, `scopeId`, `appName`, `serverTimeMs`), so a reload needs no chain RPC. The vault fetches `GET /v1/app` (Google client, read from chain) lazily, in the background after `ready`. The login popup also calls `GET /v1/app` for what it displays. API calls from Hana origins carry `x-hana-parent-origin`, which `appGate` checks with `originAllowed`. | The header is no weaker than today's `Origin` check, which only browsers enforce. It keeps per-app origin enforcement and lets removing an origin kill that origin's shares. The browser-enforced bindings are still `frame-ancestors` plus `event.origin`. |
| R4 | When the BLS key `a` is made | vault-architecture and google-flow: before the click, with `sig1` pre-signed. single-tx-login: after the token arrives. | After the token arrives. The session key, salt, nonce, `relayKey` and `relayReadKey` are made when `hana_login` arrives. | `a` lives as briefly as possible, and making it costs a few ms. |
| R5 | Persistence mechanism | vault-architecture §4: local AES-GCM of S, a session key with uses left, 8 h default. B-key-persistence: server share, `max_uses = 1`, 12 h absolute and 2 h idle. | B-key-persistence, with one AES-GCM layer under the server share (no local `K_l`, see Q35). vault-architecture §4 is superseded. | `derive_key` is permissionless, so a persisted session key with uses left makes the server limits bypassable on chain. |
| R6 | `max_uses` | single-tx-login: SDK requires `maxUses ≥ 2` (default 500) so it can retry after `ckd_failed`. B-key-persistence: `max_uses = 1` in `'session'` mode. | `'session'`: `max_uses = 1`, and `ckd_failed` means a new login. `'none'`: `max_uses = 2` (one retry). Export: `max_uses = 1`. | single-tx-login itself calls `max_uses ≥ 2` "SDK policy, not a security property". The share precondition is a security property. See Q14. |
| R7 | What the vault holds | B-key-persistence: S (48 bytes) in memory and in the record. derivation-freeze: only PRK, never S. | PRK only, in memory and in the record. S is zeroed straight after HKDF-Extract. | PRK still covers new v1 chains without a re-derive, which was B-key-persistence's reason for keeping S. A PRK leak exposes v1 keys only. |
| R8 | Export proof | B-key-persistence: purpose-bound nonce verified off-chain, no derive. vault-architecture and derivation-freeze: a fresh login and derive in a Hana window. | Fresh login and derive (`max_uses = 1`, Google `max_age=0` and `auth_time` under 5 min, if the spike confirms Google honours it; Q33) in a top-level `authOrigin` window. | Two of three records agree. An unlocked vault alone can't export. `iat` alone proves nothing (a fresh token always has a fresh `iat`). |
| R9 | Logout | vault-architecture: best-effort `revoke_session`. B-key-persistence: API share revoke, no transaction. | `POST /v1/vault/revoke`, no transaction. `revoke_session` is not sent by default. | In `'session'` mode the session can no longer derive. In `'none'` mode the session key dies with the vault's memory. |
| R10 | Message envelope | vault-architecture: `{v:1,t:"hana:hello"}`. google-flow: `{hana:1,t:'hello'}`. | vault-architecture's form. | Chosen for consistency only. |
| R11 | Token integrity in the vault | single-tx-login assumed the token never passes the API before the vault checks it. | The relay is end-to-end encrypted and authenticated (AES-GCM under `relayKey`), so the API can't read the nonce or `sub`, or put any token in the slot. The vault also verifies RS256 against Google's JWKS, as defence in depth only. | An RS256 check alone does not stop substitution: an API that saw the nonce could obtain a *genuine* Google token for an attacker's account with that nonce. Only keeping the token and nonce away from the API before the vault fixes `expectedPath` stops that. |
| R12 | Lost-device `revoke-all` | B-key-persistence: needs "a fresh Google login: a new live session signature, no derive". | Allowed only with a share created by a fresh login less than 5 min ago. It is offered right after login. | `create_session` leaves the relayer (single-tx-login), so a create-only session would cost a combined login. A just-made share proves the same thing. |
| R13 | Tabs | B-key-persistence: "a BroadcastChannel shares the result". | Each tab unlocks itself, serialised by the per-app Web Lock. The per-app BroadcastChannel carries only outcomes (new counter, logout, revoked), never key material. | Each unlock still slides the server idle limit, and no key crosses the channel. |

## Architecture

### Origins and pages

Two new manifest fields, `vaultOrigin` and `authOrigin`, for example `https://vault.<vault-domain>` and `https://auth.<auth-domain>`. They must be `https`, on different sites (registrable domains) from each other, from `apiUrl`'s dashboard and from any partner (user decision 2026-10-28, `docs/decisions.md` D38: on desktop browsers different sites always run in different processes, so content shown by the popups can't share a process with the vault's PRK). Only `authOrigin` is ever visible to users (popup address bar), so it is the one on an official, recognisable Hana domain (not yet chosen); the vault domain is never shown. `http://localhost` or `http://127.0.0.1` is allowed for them only in envs whose name starts with `local`. A deployed env such as sandbox-dev never uses loopback for them.

In the schema both fields are optional, with a refine that requires both or neither. `gen-wrangler`, the page routes and the per-env web build refuse an env without them. They become required in the schema once every deployed env has them (after [step 0](#order-of-work)).

The Worker serves both through their own routes (or, for sandbox-dev on `workers.dev`, the arrangement chosen in step 0). The vault domain hosts nothing else. The auth origin hosts nothing else on its hostname; if its domain also carries other Hana sites (for example a brand domain with a marketing site), no cookie may be set for the whole domain and access to that DNS zone is restricted like the vault's. No `workers.dev` in production. `workers.dev` is on the Public Suffix List, but hostnames under one account's subdomain (`<name>.<account>.workers.dev`) are one site, so sandbox-dev's two hostnames are the same site; that is allowed only for `local*`/`sandbox*` envs.

**Base policy on every Hana page:** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'`, plus `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Per page:

| Page | Origin | Added to the base policy | Other headers | Purpose |
|---|---|---|---|---|
| `GET /vault?pk=<publishable key>` | `vaultOrigin` | `frame-ancestors <app's allowed origins>` (loopback only for `pk_test_` and only in `local*`/`sandbox*` envs, by the same rules as `originAllowed`; at most 20 origins per app); `connect-src {apiUrl} {rpc} https://www.googleapis.com` | `Cross-Origin-Resource-Policy: cross-origin` | Key vault (hidden iframe) and the launcher |
| `GET /login` | `authOrigin` | `frame-ancestors 'none'; connect-src {apiUrl}` | No COOP header (`unsafe-none`) | Login popup start |
| `GET /login/callback` | `authOrigin` | `frame-ancestors 'none'; connect-src {apiUrl}` | same | Google redirect target |
| `GET /approve` | `authOrigin` | `frame-ancestors 'none'` | same | Approval popup |
| `GET /export` | `authOrigin` | `frame-ancestors 'none'; connect-src {apiUrl} {rpc} https://www.googleapis.com` | same | Key export window |

**Vault page responses.** 200 with the config script for an active app. 403 (no config script) for an unknown or suspended app. 503 (no config script) if D1 is unavailable. The vault script, finding no config, does nothing, so the SDK's handshake times out and raises `vault_unavailable`. A scope without a usable Google client is reported at login (`no_google_client`), not at page load.

**Inlined config.** The vault page HTML is rendered per request. It carries a non-executable `<script type="application/json" id="hana-config">` with `{v:1, appId, appName, scopeId, origins, settings:{persistence, sessionTtlMs, idleTtlMs, rawSign}, publishableKey, serverTimeMs}`. It reads only D1, never the chain. It is serialised with `JSON.stringify`, then `<`, `>`, `&`, U+2028 and U+2029 are replaced with `<`, `>`, `&`, ` `, ` `, so no partner-controlled string (`appName`, origins) can close the element. Every page renders partner strings only with `textContent`, never `innerHTML`. `signer` is not in the config: the bundle's pinned constant is used.

All JavaScript and CSS are static assets served by the Worker's static-assets binding and loaded with `'self'`. There are no third-party scripts and no inline script or style. Origin removals and suspensions take effect on the next vault load.

### Packages

| Package | Published | Contents |
|---|---|---|
| `@hana-id/core` | yes | Pure TS (WebCrypto, `@noble/*`, `@scure/base`), no DOM. Layouts: session nonce (A.2), session message, CKD payload, vault message, approval digest, relay AAD. CKD: `newAppKey`, `ckdAppId`, `decryptCkd` with the pairing check, `parseNetworkKey`, `isValidNetworkKey`, `ckdKeyProblem` (moved from `apps/smoke/src/config.ts` and `ckd.ts`; smoke imports them from core). Derivation v1 and export encodings. Signers: Stellar (tx, auth entry, SEP-53 message), EVM (EIP-1559/155 tx, EIP-191, EIP-712). `normalizeTypedData` (the single EIP-712 parser, see [Approval](#approval-flow)). Decoders for the approval page (Stellar XDR, EIP-1559, EIP-712). RS256 ID-token check and the claim allow-list. Protocol message schemas and validators. API request/response types. Ported from `apps/smoke/src/{layouts,session,ckd,bytes,api}.ts`; `chain-keys.ts` is replaced by derivation v1. |
| `@hana-id/web` | yes (client); pages are built assets | `createHana` partner client (iframe mount, handshake, port, login popup opener, EIP-1193 provider, Stellar signer, raw signer, SWK module at `@hana-id/web/stellar-wallets-kit`). Vault app and auth apps (login, callback, approve, export), built to `packages/web/dist/pages/<env>` and served by the Worker. |
| `@hana-id/react` | yes | `HanaProvider`, `useHana`, `useWallet`. |
| `@hana-id/sodax` | yes, optional | `IStellarWalletProvider` and `IEvmWalletProvider` adapters over `@hana-id/web`, typed against `@sodax/types` 2.1.0. |

Every place that derives keys (the vault, the export window and the tests) imports one shared derivation module, `@hana-id/core/derivation`. `@hana-id/env` stays Node-only, but its env-name helper `isDevEnv(name)` (`/^(local|sandbox)/`) is mirrored as a constant in the generated file. A build step in `packages/web` generates `envs.generated.ts` with `{name, network, apiUrl, vaultOrigin, authOrigin, signer, relayer, rpc, ckdNetworkKey, devEnv}` for each manifest that has both origins. The vault, login and export bundles are built per env with these as constants. The build fails if `ckdKeyProblem()` (now in `@hana-id/core`) reports a problem.

### App settings (D1, per app)

| Setting | Values | Default | Used by |
|---|---|---|---|
| `persistence` | `'session'`, `'none'` | `'session'` | vault; API refuses shares when `'none'` |
| `session_ttl_ms` | absolute limit, 1 h to 23 h 50 min | 12 h | on-chain session expiry and share `abs_expires_at` |
| `idle_ttl_ms` | 15 min to `session_ttl_ms` | 2 h | share `idle_until`, enforced by the server |
| `raw_sign` | `'off'`, `'approval'` | `'off'` | vault |
| `auto_approve_policy` | null, or an `AutoApprovePolicyV1` (JSON, see [Auto-approve policies](#auto-approve-policies)) | null | vault (inlined in the vault page) |
| `google_web_client_id` | null, or one of the scope's own Google clients | null | vault (via `GET /v1/app`) and `GET /v1/app` in own-client mode |

The 23 h 50 min cap leaves a 10 min margin under the contract's `expires_at_ms ≤ block_now + 24 h`.

`admin app:settings <app> --persistence … --session-ttl … --idle-ttl … --raw-sign … --google-web-client … --auto-approve <policy.json | off>` sets them until the batch C dashboard takes over. It validates every range, and checks `--google-web-client` against the scope's on-chain Google clients. When unset, `GET /v1/app` uses the first Google client of the scope, as today. The setting exists because a scope may also hold iOS and Android clients, which can't do the web implicit flow.

**`raw_sign` and `auto_approve_policy` changes are delayed.** Removing an auto-approve policy takes effect at once, like setting `raw_sign` to `'off'`; setting or changing a policy follows the same pending + `effective_at` rule as `raw_sign = 'approval'` (columns `auto_approve_pending`, `auto_approve_effective_at`). Setting `raw_sign` to `'off'` takes effect at once. Setting it to `'approval'` writes `raw_sign_pending = 'approval'` and `raw_sign_effective_at = now + RAW_SIGN_DELAY_MS` (24 h; `changeDelayMs` from the manifest in `local*`/`sandbox*` envs). The vault page uses the pending value only once `now ≥ raw_sign_effective_at`. The CLI prints the warning that raw signing can authorize any transaction on that chain and logs the change. Batch C moves this into the dashboard's fresh-sign-in, logged, owner-notified and delayed process for origin changes. A bare D1 update must never be the way to change it.

## Protocol

### Envelope

Every cross-window message is a plain object sent by structured clone. Bytes travel as `Uint8Array`, never as number arrays or strings. Every receiver checks `v === 1`, an allow-list of `t` or `method` values, the exact field set and types, and a size cap: 192 KiB for sign requests, 200 KiB (192 + 8) for what a sign request turns into (the approval and consent requests, and sign-method replies, which carry its content plus their own fields, so every sign request the port accepts can be shown and answered), 8 KiB for everything else. Anything else is dropped without a reply.

| Kind | Shape |
|---|---|
| Request (partner → vault, on the port) | `{v:1, id: string (1–64 chars, unique per port), method, params}` |
| Reply | `{v:1, id, result}` or `{v:1, id, error:{code: number \| string, message, data?}}` |
| Event (vault → partner) | `{v:1, event, data}` |

| Error code | Meaning |
|---|---|
| `4001` | User rejected (approval Reject, popup closed, approval timeout) |
| `4100` | Not logged in, address mismatch, or method not allowed for this app (for example raw signing off) |
| `4200` | Unsupported method |
| `4900` | Vault disconnected (logout, session expired) |
| `4902` | EVM chain not configured (`wallet_switchEthereumChain`, Sodax provider) |
| `vault_unavailable` | The vault handshake did not finish within 5 s (CSP `frame-src`, 403/503 vault page, network) |
| `popup_blocked` | `window.open` returned null. The vault shows its "Sign in with Hana" launcher as a fallback. |
| `coop_blocks_popup` | The login popup reported `closed` before it connected (partner COOP `same-origin`, or the user closed it before it loaded) |
| `storage_unavailable` | Informational, as `ready`/login `data.warning`: persistence fell back to `'none'` |
| `login_timeout` | No popup hello within 15 s of opening (`data.stage: 'connect'`), or the 5 min pending limit passed (`data.stage: 'pending'`) |
| `login_cancelled` | The SDK sent `hana_cancelLogin`, or a newer `hana_login` superseded this one |
| `google_error` | Google returned `#error` (`data.error` is Google's code) |
| `no_google_client` | `GET /v1/app` returned 409 `no_google_client` |
| `token_invalid`, `token_has_pii` | Token failed vault or API checks (`token_has_pii` carries `data.claim`) |
| `config_mismatch` | Inlined, API-supplied or opener-supplied `signer`, scope or client differs from the pinned or expected value |
| `ckd_failed`, `derive_failed`, `pairing_failed`, `address_mismatch` | Key could not be produced |
| `session_consumed` | The login's only use was burnt by someone else (front-run replay). The vault shows a "Continue signing in" launcher. |
| `rate_limited`, `app_suspended`, `origin_not_allowed`, `api_unavailable` | Mapped from API errors |
| `busy` | An export is already running |

### Partner ↔ vault handshake

1. The SDK inserts `<iframe name="hana-vault-<32 hex chars, 128-bit random>" src="{vaultOrigin}/vault?pk=…" hidden>`. The iframe has no `sandbox` attribute and no `allow`.
2. The vault does nothing if `window.parent === window` (top-level), or if the inlined config is missing.
3. On `load`, the SDK creates a `MessageChannel` and posts `{v:1, t:"hana:hello", sdk: "<version>"}` to the iframe with `targetOrigin = vaultOrigin`, transferring `port2`. If `ready` hasn't arrived within 5 s of insertion, the SDK raises `vault_unavailable`.
4. The vault accepts exactly one hello. All of these must hold:
   - `event.source === window.parent`;
   - `event.origin` is allowed by the inlined `origins` (same matching rules as `originAllowed`, including the dev-env rule);
   - `event.origin === location.ancestorOrigins[0]` where the browser provides `ancestorOrigins` (Chromium, WebKit).
5. The vault pins `parentOrigin = event.origin` and serves only the transferred port from then on. Later `hana:hello` messages and any `window` message from the parent are dropped.
6. The vault replies on the port with the event `ready` `{status, addresses?, expiresAtMs?, persistence}`, after any unlock (see [Key persistence](#key-persistence)). It then fetches `GET /v1/app` in the background; that call is never on the unlock path.

**Clock.** The vault computes `offset = config.serverTimeMs − Date.now()` at start and uses `now() = Date.now() + offset` for every time check and expiry it computes. It refreshes `offset` from `serverTimeMs` in every `/v1/app` and relay response. A device clock that is minutes or hours off therefore can't break token checks or produce an expiry the contract refuses.

### Port methods

| Method | Params | Result | Needs |
|---|---|---|---|
| `hana_status` | none | `{status, addresses?, expiresAtMs?, persistence}` | silent |
| `hana_login` | none (the SDK has just opened the popup, or has `popupBlocked: true`) | `{addresses, expiresAtMs, persistence}` | login popup |
| `hana_cancelLogin` | none | `null` | silent |
| `hana_logout` | none | `null` | silent |
| `hana_export` | `{chain: 'stellar' \| 'evm'}` | `null` (the key is shown only in the export window) | launcher click, export window |
| `hana_revokeOtherDevices` | none | `{revoked: number}` | silent, only within 5 min of a fresh login |
| `stellar_getAddress` | none | `{address}` | silent |
| `stellar_signTransaction` | `{xdr: string, networkPassphrase: string, address?: string}` | `{signedTxXdr, signerAddress}` | approval |
| `stellar_signAuthEntry` | `{preimageXdr: string, networkPassphrase: string, address?}` | `{signedAuthEntry (base64, 64 bytes), signerAddress}` | approval |
| `stellar_signMessage` | `{message: string \| Uint8Array, address?}` | `{signedMessage (base64), signerAddress}` | approval |
| `eth_accounts` | none | `[address]` or `[]` | silent |
| `eth_signTransaction` | `{tx}`: EIP-1559 or EIP-155 legacy fields, fully filled; every quantity (`chainId`, `nonce`, `gas`, `value`, fees) is a `0x` hex string as in JSON-RPC (`chainId` at most `Number.MAX_SAFE_INTEGER`, as the approval context carries it), `data` is `0x` hex | `0x` raw signed tx | approval |
| `personal_sign` | `[message hex, address]` | `0x` signature | approval |
| `eth_signTypedData_v4` | `[address, typedData JSON string]` | `0x` signature | approval |
| `hana_signRaw` | `{chain: 'stellar', bytes: Uint8Array (≤ 4 KiB)}` or `{chain: 'evm', digest: Uint8Array(32)}` | `{signature: Uint8Array}`: Ed25519 64 bytes, or secp256k1 `r‖s‖v` 65 bytes with `v ∈ {27, 28}` | `raw_sign = 'off'` → `4100`; `'approval'` → approval with the raw warning |
| `hana_requestAutoApprove` | none | `{granted: boolean, policyId?, expiresAtMs?}` | consent screen in the approval popup; `4100` if the app has no policy in force |
| `hana_autoApproveStatus` | none | `{policyId, label, expiresAtMs, used: {count, native}} \| null` | silent |
| `hana_revokeAutoApprove` | none | `null` | silent (the user can also revoke from any approval popup) |

The SDK answers some calls itself without the vault: `eth_chainId`, `wallet_switchEthereumChain`, `getNetwork` and read-only RPC methods. It also handles fee and nonce filling and broadcasting, using the partner's RPC.

Events: `accountsChanged {addresses}`, `disconnect {code}`, `sessionExpired`, `loginProgress {stage: 'popup_connected' | 'google' | 'token' | 'chain' | 'done'}`, `ui {launcher: 'show' | 'hide', label}`. For `pk_test_` apps only, the login result also carries `timings` (per-stage ms, no secrets) for `apps/smoke`.

## Login

The flow is the same in shared and own-client mode. `/login` runs in one of three opener modes:

| Mode | URL | Opened by | Talks to |
|---|---|---|---|
| partner (default) | `/login?v=<vault frame name>` | partner page, in its click handler | the vault at `window.opener.frames[v]` |
| vault | `/login?from=vault` | the vault iframe, from its launcher | the vault at `window.opener` |
| export | `/login?mode=export` | the export window on `authOrigin` | the export window at `window.opener` (see [Key export](#key-export)) |

Steps:

1. **Click.** The partner calls `hana.login()` synchronously in its click handler. Before any `await`, the SDK calls `window.open('{authOrigin}/login?v=<vault frame name>', 'hana-login-<32 hex chars, 128-bit random>', 'popup,width=480,height=640')`, without `noopener`. Then:
   - If `window.open` returns null, the SDK sends `hana_login {popupBlocked: true}`. The vault shows its launcher with the label "Sign in with Hana" and keeps the login pending. A click on the launcher opens `/login?from=vault` from the vault iframe. If the user never clicks, the call ends with `login_timeout` after 5 min, or `popup_blocked` if the partner calls `hana_cancelLogin`.
   - Otherwise the SDK sends `hana_login` on the port and polls `popup.closed` every 100 ms until `loginProgress: popup_connected`. If the popup reports `closed` first, it rejects with `coop_blocks_popup`. If 15 s pass with no `popup_connected`, it sends `hana_cancelLogin`, closes the popup and rejects with `login_timeout`. After `popup_connected` the SDK stops looking at `popup.closed`, because Google's COOP may make the handle report `closed`.
2. **The vault prepares the pending login.** A new `hana_login` supersedes a pending one: the old request is rejected with `login_cancelled`, and its session key, salt, nonce, `relayKey`, `relayReadKey` and relay poll are dropped, so a later relay write for the old `relayId` is never read. (`busy` applies only to export.) The vault makes:
   - a non-extractable Ed25519 session key (`sessionPublicKey`, 32 bytes);
   - `salt` = 32 random bytes;
   - `expiresAtMs = now() + min(session_ttl_ms, 24 h − 10 min)`, using the server-corrected clock;
   - `keyIndex = 0`;
   - `maxUses` = 1 for `'session'`, 2 for `'none'`;
   - `nonce = sessionNonce(SIGNER, scopeId, sessionPublicKey, expiresAtMs, keyIndex, maxUses, salt)`, the A.2 preimage `"hana-id/session/v1" ‖ borsh(SIGNER) ‖ borsh(scopeId) ‖ sessionPublicKey ‖ u64le(expiresAtMs) ‖ u32le(keyIndex) ‖ u32le(maxUses) ‖ salt`, where `SIGNER` is the pinned build constant and `scopeId` the inlined one, never values from the partner;
   - `relayKey` = 32 random bytes (AES-GCM-256, encrypts the relay payload);
   - `relayReadKey` = 32 random bytes, which never leaves the vault;
   - `relayId = b64url(sha256(relayReadKey))` (43 chars), also used as the OAuth `state`.

   Before preparing, the vault needs the Google client from `GET /v1/app` (already fetched in the background after `ready`, or fetched now). It refuses with `config_mismatch` if that response's `signer` differs from `SIGNER` or its `scopeId` from the inlined one, and with `no_google_client` on 409.

   The pending login ends on success, error, `hana_cancelLogin`, supersession, or after 5 min (`login_timeout`). The vault does not cancel on `popup.closed`, because a COOP switch makes the vault's WindowProxy report `closed`.
3. **The popup finds the vault.** If `window.opener === null`, `/login` shows "This site's settings block the Hana sign-in window (COOP)" and stops. Otherwise it posts `{v:1, t:"hana:auth-hello"}` with `targetOrigin = vaultOrigin` every 100 ms for up to 15 s, to `window.opener.frames[v]` (partner mode) or `window.opener` (vault mode). The vault answers only if all of these hold:
   - a login is pending and no hello has been accepted for it;
   - `event.origin === authOrigin`;
   - partner mode: `event.source.opener === window.parent`; vault mode: `event.source` is the WindowProxy the vault's launcher opened.

   It pins `event.source` and replies to it with `targetOrigin = authOrigin`:
   `{v:1, t:"hana:auth-params", pk, appName, parentOrigin, scopeId, signer: SIGNER, clientId, mode, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses, nonce, relayId, relayKey}`. Here `pk` is the publishable key; the session public key is always `sessionPublicKey`.
4. **The popup checks the vault.** It accepts the reply only if `event.origin === vaultOrigin` and, in partner mode, `event.source === window.opener.frames[v]` and `event.source.parent === window.opener`, or, in vault mode, `event.source === window.opener`. It refuses (`config_mismatch`) if `signer !== SIGNER` (its own pinned constant). It then calls `GET /v1/app` itself (`x-hana-key: pk`, `x-hana-parent-origin: parentOrigin`, `Origin: authOrigin`), refuses if that response's `signer` isn't `SIGNER`, its `scopeId` isn't the vault's or its `clientId` isn't the vault's, recomputes the nonce with the same preimage and refuses on a mismatch. This call checks the vault's values against the API's view of the parent origin and supplies what the popup displays; it is not a defence against a compromised Worker. Otherwise it stores `{v, createdAt, relayKey}` under `hana.login.<relayId>` in its own `sessionStorage`, deletes any `hana.login.*` entry older than 10 min, and shows "Signing in to {appName} at {parentOrigin}" (via `textContent`).
5. **Google.** The popup navigates to `https://accounts.google.com/o/oauth2/v2/auth` with:
   - `client_id`
   - `redirect_uri={authOrigin}/login/callback`
   - `response_type=id_token`
   - `response_mode=fragment`
   - `scope=openid`
   - `nonce`
   - `state=<relayId>`
   - `prompt=select_account`
6. **Callback.** `/login/callback` reads `#id_token&state` or `#error`, then clears the fragment at once with `history.replaceState`. It checks that `sessionStorage` holds `hana.login.<state>` and deletes it, so the state is single-use. With no entry it shows an error and posts nothing. With an entry it builds `payload = utf8(JSON.stringify({idToken}))` or `{error}` (Google's code, `^[a-z_]{1,64}$`), encrypts `ct = AES-GCM(relayKey, iv (12 random bytes), payload, aad = utf8("hana-id/relay/v1") ‖ utf8(relayId))`, and sends `POST /v1/login-relay/<state>` with `{iv, ct}` (base64url) using `fetch(…, {keepalive: true})`. It waits for the response and only then calls `window.close()`. On 409 or a network error it shows an error and stays open. It zeroes `relayKey` and never logs or stores the token.
7. **The vault receives the token.** From the moment the hello is accepted, the vault long-polls `GET /v1/login-relay/<relayId>?wait=25` with `x-hana-relay-key: b64url(relayReadKey)`. It decrypts the slot with `relayKey` and the same AAD; a decryption failure ends the login with `token_invalid`. `{error}` ends it with `google_error`. It accepts a token only if all of these hold:
   - the RS256 signature verifies against Google's JWKS, fetched from `https://www.googleapis.com/oauth2/v3/certs` (defence in depth, R11);
   - `iss` is `https://accounts.google.com` or `accounts.google.com`;
   - `aud === clientId`;
   - `nonce === pending.nonce`;
   - `exp*1000 > now() − 60 s` and `iat*1000 ≤ now() + 60 s` (server-corrected clock; the same 60 s as the API's `TOKEN_EXP_SKEW_MS`);
   - every claim is in the allow-list (otherwise `token_has_pii` with the claim name);
   - `sub` is 1–255 bytes with no `#`.
8. **Path.** The vault sets `expectedPath = scopeId + "#google#" + sub + "#" + keyIndex`. It is the only path the vault ever uses for this session.
9. **Chain.** The vault runs `newAppKey()` to get `a`, `pk1` and `pk2`, signs `sig1 = Ed25519(sessionMessage(1, ckdPayload(pk1, pk2)))`, and sends `POST /v1/login` (see [API changes](#api-changes-appsapi)).
10. **Decrypt.** `S = decryptCkd(result, a, ckdAppId(SIGNER, expectedPath), pinnedKey)`, including the pairing check. Then `PRK = HKDF-Extract(...)`, S is zeroed, and the reference to `a` is dropped. Addresses come from PRK.
11. **Persist.** In `'session'` mode the vault creates a share and writes the record (see [Key persistence](#key-persistence)). If storage fails it drops to `'none'` and reports `storage_unavailable`.
12. **Result.** The vault replies `{addresses:{stellar, evm}, expiresAtMs, persistence}` and emits `accountsChanged`.

### Failure handling

The vault re-syncs from NEAR directly: `get_session(sessionPublicKey)` on the manifest `rpc` with `finality: optimistic`, the same way as `apps/smoke` `syncCounter`. It never takes session state from the API. A re-synced session must have `scope_id === scopeId` and `path === expectedPath`; otherwise the login fails `derive_failed`. Tx polling uses `EXPERIMENTAL_tx_status {tx_hash, sender_account_id: RELAYER, wait_until: 'EXECUTED_OPTIMISTIC'}`, with `RELAYER` the pinned build constant; a success yields `{big_y, big_c}`. The vault keeps the `nearTx` of every attempt of this login.

| `/v1/login` outcome | Meaning | Vault action |
|---|---|---|
| 200 | Session made, `used = 1` | Decrypt (step 10) |
| 409 `session_exists`, or 422 `contract_rejected` with `reason: 'session_key_in_use'` | Someone else's `create_session` or full-call replay with the public token landed first (before or after the API's precheck), or an earlier attempt of ours landed | Re-sync. If `used < max_uses`: `/v1/derive` with counter `used + 1`. Else if an earlier attempt's `nearTx` is known: poll it for `{big_y, big_c}`. Else fail `session_consumed` (a replay burnt the only use) and show the "Continue signing in" launcher, whose click starts a fresh login (new session key, BLS key and relay keys) in vault mode. Never reuse this token. |
| 422 `contract_rejected` (any other reason) | Signer receipt failed, atomic revert, no session | Fail with the mapped code. A new login is needed. |
| 422 `ckd_failed` | Session committed with `used = 1`, MPC side failed | `'none'`: re-sync, then `/v1/derive` with counter 2. `'session'` and export: fail `ckd_failed`; the user logs in again (about $0.021). |
| 504 `timeout` with `nearTx`, or 502 `near_error` with `nearTx` | Outcome unknown | Poll that transaction for up to 120 s. Failing that, re-sync: no session → resend the same `/v1/login` body once; session with `used < max_uses` → derive; `used === max_uses` → poll the known `nearTx` once more, then fail. |
| 400 `method_not_allowed`, 502 `near_unavailable`, 502 `near_rejected`, 503 `relayer_busy`, 503 `relayer_unconfigured` | Not executed (the API's `NOT_EXECUTED` set) | Resend the same body once, if the token's `exp` and `expiresAtMs` are still valid; then fail `api_unavailable` |
| 503 `relayer_unavailable` | Outcome unknown (the relayer object may have failed after broadcasting) | With `nearTx`: as 504. Without: wait 3 s, re-sync, then as in the 504 row. |
| 400 `token_has_pii`, 401, 403, 409 `no_google_client`, 429, other 503 | Gate or token problem | Fail with the mapped code |

The split flow (`/v1/sessions` then `/v1/derive` with counter 1) stays in the vault behind an env flag until the ship gate decides. It uses the same path rule and re-sync.

## Key persistence

### Modes

- **`'session'`** (default). The record below is written after login. A reload or a new tab unlocks it with one API call and no chain calls.
- **`'none'`.** Nothing goes to disk, including the session key, and every page load is a full login. The vault falls back to `'none'` and reports `storage_unavailable` if IndexedDB or WebCrypto throws, or if share creation fails.

### Record

IndexedDB database `hana-vault` on `vaultOrigin`, partitioned by top-level site, object store `records`. There is one record per key `<signer>|<appId>|<scopeId>|<keyIndex>`, so two apps on the same scope and the same top-level site never see each other's records. The path is inside the record, because the vault doesn't know `sub` before it unlocks.

```
RecordV1 {
  v: 1, signer, appId, path, scopeId, keyIndex, derivationVersion: 1,
  ckdKeyHash: sha256(pinned ckdNetworkKey, 96-byte compressed G2),
  parentOrigin,                  // the pinned parent (B-key-persistence's topOrigin)
  sessionPk: Uint8Array(32),
  sessionKeyPair: CryptoKeyPair, // non-extractable Ed25519, stored as is (signs vault messages)
  shareId: Uint8Array(16), counter: number,
  iv: Uint8Array(12), ct: Uint8Array,
  addresses: {stellar, evm}, expiresAtMs
}
ct  = AES-GCM(K_s, iv, PRK32, aad)
aad = utf8("hana-id/vault/v1") ‖ borsh(signer) ‖ borsh(appId) ‖ borsh(path) ‖ sessionPk ‖ u32le(derivationVersion)
      ‖ ckdKeyHash ‖ borsh(parentOrigin) ‖ u64le(expiresAtMs)
```

PRK is stored, not S (R7). The BLS scalar `a` is never stored. `K_s` is zeroed once the record is written. There is no local wrapping key: a non-extractable key stored in the same record stops no disk thief (Chrome stores its bytes unprotected at rest), so the server share is the only protection (Q35). A record whose AAD fails, whose `derivationVersion` or `ckdKeyHash` differs from the bundle's, whose `signer` differs from `SIGNER`, or whose `expiresAtMs` has passed is deleted.

### Vault message layout (off-chain only)

```
vaultMessage(shareId, counter, payload) =
  utf8("hana-id-vault-v1:") ‖ borsh(signer) ‖ borsh(appId) ‖ shareId(16) ‖ u64le(counter) ‖ sha256(payload)
```

`appId` is the D1 `apps.id`. It is not the CKD `app_id`. The API always verifies with the gate app's id, so a signature made for app A never verifies for app B. The prefix differs from `"hana-id-session-v1:"`, so a vault signature can never be relayed as a derive or a revoke.

| Action | `shareId` | `counter` | `payload` |
|---|---|---|---|
| create share | 16 zero bytes | 0 | `utf8("share") ‖ borsh(parentOrigin)` |
| unlock | the share | n + 1 | `utf8("unlock")` |
| touch | the share | n + 1 | `utf8("touch")` |
| revoke | the share | n + 1 | `utf8("revoke")` |
| revoke-all | the share | n + 1 | `utf8("revoke-all")` |

### Share creation

After a successful login the vault sends `POST /v1/vault/shares` (see [Vault endpoints](#vault-endpoints)). The API checks, in order:
1. `appGate` (kind `'vault'`) with the Hana-origin rule; the app's `persistence` must be `'session'`.
2. The signature, verified against `sessionPublicKey` with the gate app's id.
3. An uncached optimistic `get_session`: live, `scope_id` equal to the app's scope, `used === max_uses`. `/v1/login` returns at `EXECUTED_OPTIMISTIC`, and a load-balanced RPC may answer from a node a block behind, so if the session is missing or `used < max_uses` the API retries every 300 ms for up to 2 s before refusing.
4. That `originAllowed(app, x-hana-parent-origin)` holds (wildcard and loopback rules included).
5. That no share exists for this `session_pk`.

It generates `K_s` (32 bytes) and `shareId` (16 bytes) and stores the row with `path_hash = sha256(utf8(session.path))`, the path taken from `get_session`. `abs_expires_at = min(session.expires_at_ms, now + session_ttl_ms)` and `idle_until = now + idle_ttl_ms`.

### Unlock (reload, new tab)

1. After the handshake, the vault looks up the record for `<SIGNER>|<appId>|<scopeId>|0`. Before it calls the API, it checks:
   - `record.parentOrigin === parentOrigin`;
   - `parentOrigin` is allowed by the inlined origins (read from D1 on this load);
   - `now() < expiresAtMs`.
2. It takes the Web Lock `hana-vault-unlock:<appId>`, re-reads the record's `counter` (call it n), and sends `POST /v1/vault/unlock {shareId, counter: n + 1, signature}`.
3. The API loads the share `WHERE share_id = ? AND app_id = :gateAppId` (another app's share gives 404 `unknown_share`), checks `originAllowed(app, share.partner_origin)` using the app row `appGate` already loaded (410 `share_revoked` if the origin was removed), verifies the signature with the row's `session_pk`, then runs one atomic `UPDATE vault_shares SET counter = n + 1, idle_until = min(now + idle_ttl_ms, abs_expires_at) WHERE share_id = ? AND app_id = ? AND counter = n AND now < idle_until AND now < abs_expires_at AND revoked_at IS NULL`. If no row changed it re-reads the row to pick 409, 410 `share_expired` or 410 `share_revoked`. It returns `K_s` and counts one `unlocks` usage. It makes no chain RPC.
4. Errors:
   - 404 `unknown_share`: delete the record, logged out.
   - 410 `share_expired` or `share_revoked`: delete the record, then a full login. Never a derive.
   - 409 `bad_counter`: the response carries `{expected}`. Store it and retry once with `expected`; a second 409 deletes the record.
5. The vault writes `counter = n + 1` and releases the lock. It decrypts `ct` to get PRK and zeroes `K_s`. It recomputes the addresses; a mismatch deletes the record and falls back to a full login. It posts `{v:1, t:'counter', shareId, counter}` on BroadcastChannel `hana-vault:<appId>`.

**Idle slide while active.** `idle_until` also moves on a signed `touch` (`POST /v1/vault/touch`, same counter rule, no `K_s` returned). The vault sends one at most once per 10 min, and only after an approved signature in that window, so a user who keeps one tab open and keeps signing is not logged out at the next reload.

PRK is zeroed in memory at `expiresAtMs`, on logout, or on a `revoked` broadcast. The vault does not enforce an idle limit in memory (Q28).

### Logout and lost device

- **Logout:**
  1. `POST /v1/vault/revoke`, signed;
  2. delete the record;
  3. zero PRK;
  4. broadcast `{t:'logout'}` on `hana-vault:<appId>` so this app's other tabs zero PRK and emit `disconnect`. Other apps' vaults on the same site don't listen on this channel.

  No chain transaction is sent.
- **Lost device:** `hana_revokeOtherDevices` sends `POST /v1/vault/revoke-all`, signed with the current share. The API accepts it only if that share was created less than 5 min ago, which proves a fresh Google login (R12). It revokes every other live share for `(app_id, path_hash)`.

## Signing and approval

| Tier | Methods |
|---|---|
| Silent | `hana_status`, `stellar_getAddress`, `eth_accounts`, `eth_chainId`, `getNetwork`, `hana_logout` |
| Hana popup approval, unless an accepted auto-approve policy matches | `stellar_signTransaction`, `stellar_signAuthEntry`, `eth_signTransaction` (and `eth_sendTransaction` through it), `eth_signTypedData_v4` |
| Hana popup approval, every time | `stellar_signMessage`, `personal_sign` |
| Per `raw_sign` | `hana_signRaw`: off (`4100`) or approval with the raw warning |

### Approval flow

1. The vault queues the request and emits `ui {launcher: 'show', label: 'Review in Hana'}`. The SDK makes the iframe visible as a fixed 320×72 px element. Clicking the launcher only opens the popup, so clickjacking it can't produce a signature.
2. The launcher click opens `window.open('{authOrigin}/approve', 'hana-approve-<32 hex chars, random>', 'popup,width=420,height=680')`. If an approval popup from the last 15 s is still open, the vault reuses it, calls `popup.focus()` and skips the launcher.
3. The popup posts `{v:1, t:"hana:approve-hello"}` to `window.opener` with `targetOrigin = vaultOrigin`. The vault accepts it only from the window it opened, with `event.origin === authOrigin`.
4. The vault sends `{v:1, t:"hana:approve-request", id (128-bit random), appName, parentOrigin, kind, chain, address, bytes: Uint8Array, context, position, queued, autoApprove?}`. `context` is `{networkPassphrase}` for a Stellar transaction or auth entry, `{chainId}` for an EVM transaction, and `{}` for a Stellar message, `personal_sign`, `eth_signTypedData_v4` and raw requests, which name no network of their own (user decision 2026-10-28, `docs/decisions.md` D35; typed data carries its chain in its domain). The popup decodes `bytes` itself, without using any summary from the vault, and shows "Request {position} of {queued} from {appName}" plus the lines below. Message and raw requests also show "This signature isn't tied to one network.":
   - Stellar tx: network passphrase, source, sequence, every operation (Soroban contract and function with decoded args, classic ops by type), maximum fee, time bounds. Unknown operations are shown by type with their raw XDR.
   - Stellar auth entry: network ID, nonce, expiration ledger, invocation tree.
   - Stellar message: the text (or hex).
   - EVM tx: `chainId`, `to`, value, decoded 4-byte selector where known (otherwise the raw data), gas, fees, nonce.
   - EVM `personal_sign`: the text.
   - `eth_signTypedData_v4`: the popup and the vault both call `@hana-id/core` `normalizeTypedData(json)`. It rejects duplicate JSON keys, fields not declared in their type, missing fields, undeclared or cyclic types, a `primaryType` not in `types`, and an `EIP712Domain` that doesn't match its declared fields. The popup renders the normalized struct tree walked from `primaryType` (and the domain); the vault hashes that same normalized object. Malformed typed data is refused before display.
   - Raw: a red warning, "Raw signing can authorize any transaction, authorization or message on {chain}. Hana can't tell what this is. Only approve if you trust {appName} completely.", plus hex. The popup never tries to decode raw bytes as a transaction, even when they are a valid transaction hash.
5. **Approve is guarded.** The Approve button stays disabled until all of these have happened: at least 1 s since this request rendered, at least 1 s since the window last gained focus or became visible, and an arming gesture inside the window after both. What arms it depends on the input (user decision 2026-10-28, `docs/decisions.md` D36): with a mouse, only a `pointermove` that moved; with touch or a pen, a `pointerdown`; from the keyboard, only Tab, Shift+Tab or an arrow key (never Enter, Space or an auto-repeated key). The arming gesture never approves: Approve acts only on a click whose own pointerdown (or non-repeated keydown) came after it, so a tap needs a second tap. The page never focuses Approve. This resets on every new request in a reused popup, on focus and on blur. It stops a double-click across the launcher→popup opening, a request slipped in at the moment of a click, clicking in place and a held Enter. Residual risk (accepted): tapping repeatedly on a phone for more than 1 s after the popup tab opens can still approve in two taps.
6. On Approve or Reject the popup sends `{v:1, t:"hana:approve-result", id, approved, digest}`, where
   ```
   digest = sha256(utf8("hana-id/approve/v1") ‖ borsh(id) ‖ borsh(kind) ‖ borsh(chain) ‖ borsh(address)
                   ‖ borsh(parentOrigin) ‖ borsh(contextString) ‖ u32le(len(bytes)) ‖ bytes)
   ```
   with `contextString` the network passphrase (Stellar transactions and auth entries), the decimal chain ID (EVM transactions) or `''` (an empty `context`), computed from exactly what the popup rendered. The vault recomputes it from the queued request and signs only if all of these hold:
   - `event.source` is its popup;
   - `event.origin === authOrigin`;
   - `id` is pending and less than 5 min old;
   - `digest` matches.

   Reject, a popup closed while pending, or the 5 min timeout returns `4001`.
7. After a result, the popup shows "Waiting for the next request from {appName}" for up to 15 s. A follow-up request (`restoreFootprint`, trustline, re-sign) appears there without another launcher click, with its position in the queue, and each one still needs its own guarded Approve. After 15 s idle the popup sends `hana:approve-bye` and closes.

What gets signed:
- **Stellar tx:** sign `sha256(sha256(passphrase) ‖ envelopeType ‖ tx XDR)` with the approved passphrase and append a `DecoratedSignature` (hint = the last 4 bytes of the public key). Fee-bump envelopes are signed as given. `address`, if passed, must equal the vault's address, otherwise `4100`.
- **Auth entry:** Ed25519 over `sha256(HashIdPreimage XDR)`, which must be of type `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION` with the given network ID.
- **Stellar message:** SEP-53, Ed25519 over `sha256("Stellar Signed Message:\n" ‖ message)`.
- **EVM:** EIP-1559 type 2, or legacy with an EIP-155 `chainId`. `personal_sign` uses EIP-191 and `eth_signTypedData_v4` uses EIP-712 over the normalized object. `eth_sign` is `4200`.
- **Raw:** Ed25519 over `bytes`, or secp256k1 over `digest` (`v ∈ {27, 28}`). Both can produce a valid signature on any transaction of that chain.

The SDK, not the vault, fills fees and nonces and broadcasts, using the partner's RPC. The approval screen shows the final fields. Each chain key is derived from PRK per signature with HKDF-Expand and zeroed in `finally`.

### Auto-approve policies

Decided by the user on 2026-10-27, after comparing with Privy (which lets an app switch confirmation modals off, or grant its server a policy-limited signer the user consents to). Approval stays the default. An app may skip the popup only for requests that match a policy its owner set, and only after the user accepted that exact policy in a Hana popup. The vault enforces the policy; the partner page can't.

**Off by default, two opt-ins (user decision, 2026-10-27).** Every signature gets the approval popup until both happen:
1. The app owner sets a policy (`auto_approve_policy` is null by default). It takes effect after the delay (24 h; the manifest's `changeDelayMs` in `local*`/`sandbox*` envs); in batch C with the origin-change safeguards (fresh sign-in, audit, other owners emailed). Removal is immediate.
2. Each user accepts that exact policy in a Hana popup. Any policy change asks every user again.

**Batch B scope (user decision, 2026-10-27).** Auto-approve covers only direct calls whose address arguments are all typed (so the address rule can check them), token approvals to listed contracts, and Stellar `changeTrust` for listed assets. Protocols that carry instructions in opaque bytes (Sodax's `transfer`/`sendMessage`, DEX routers, bridges, aggregators) always get the popup in batch B. `@hana-id/core` ships the decoder interface below, with no protocol decoder registered yet.

**Protocol decoders (interface only in batch B).** `@hana-id/core` defines `ProtocolDecoder { id: string; chain: 'stellar' | 'evm'; matches(call): boolean; decode(call, ctx: {user, chainId | networkPassphrase}): {ok: true, effects: {recipients: Address[], targets: Address[], tokens: {asset, amount}[]}} | {ok: false, reason} }` and a registry the vault consults when a listed function has opaque `bytes` arguments. A policy entry may name a decoder (`decoder: 'sodax-intent-v1'`) instead of `addressArgs`; the validator refuses a decoder id the bundle doesn't ship. The address rule then applies to the decoder's `recipients` and `targets`. Adding a decoder later (Sodax first, on demand) changes neither the policy format nor existing consents' meaning, since a policy that names it gets a new `policyId`. Simulation-based policies (allow if all asset flows go to the user or listed contracts) are a later option for same-chain protocols; they can't cover cross-chain intents.

**Policy (set per app; `admin app:settings --auto-approve` now, batch C dashboard later):**

```
AutoApprovePolicyV1 {
  v: 1,
  label: string,                       // ≤ 80 chars, shown to the user ("Swaps on Sodax")
  maxConsentMs: number,                // ≤ the app's session_ttl_ms; the consent ends earlier with the session
  limits: { perDayCount: number },     // auto-signed requests per user per day (UTC), ≤ 500
  stellar?: {
    networkPassphrases: string[],
    maxFeeStroops: string,             // per transaction, decimal
    contracts: [{ id: 'C…', name: string, functions: [{ name: string, addressArgs?: 'self-or-listed' | 'any' }] }],
    changeTrustAssets?: string[],      // 'CODE:ISSUER'; the only classic operation a policy may cover
    addresses?: string[],              // extra G…/C… addresses allowed as call arguments
  },
  evm?: {
    chains: [{
      chainId: number,
      maxValueWei: string,             // per transaction: value + maximum fee (gasLimit × maxFeePerGas, or gasPrice)
      maxValueWeiPerDay: string,       // per UTC day: auto-signed value + maximum fees on this chain
      maxFeeWei: string,               // per transaction, ≥ 1: the maximum fee alone
      contracts: [{ address: '0x…', name: string, selectors: [{ selector: '0x12345678', signature: string, addressArgs?: 'self-or-listed' | 'any' }] }],
      typedData?: [{ verifyingContract: '0x…', primaryType: string }],
      addresses?: string[],
    }],
  },
}
policyId = sha256(utf8("hana-id/auto-approve/v1") ‖ canonical JSON of the policy)
```

**What a policy can never cover:** `hana_signRaw`, `personal_sign`, `stellar_signMessage`, EVM contract creation (`to` empty), `eth_sign`, Stellar classic operations other than `changeTrust` for a listed asset (so never `setOptions`, `payment`, `accountMerge` or signer changes), fee-bump envelopes, and any request the vault can't fully decode. The validator (`@hana-id/core` `validateAutoApprovePolicy`, used by the CLI, the API and the vault) refuses a policy that lists an ERC-20 or SAC `approve`/`transfer`/`transferFrom`-style function (matched by name prefix and substring, so `transferAndCall`, `send`, `permit…`, `…Ownership` and the like too) or an execute/multicall-style function (`execute…`, `exec…`, `multicall`, `aggregate…`, `delegatecall`, `call…`, `batch…`, `invoke`, `forward`, `relay`, `dispatch`, `handleOps`, `upgrade…`, `proxy…`) with `addressArgs: 'any'`, refuses an EVM function with an opaque argument (below) under either rule, and requires `addressArgs` on every listed function that takes an address. Functions refused this way need a protocol decoder.

**Address rule (the main defence against partner-page XSS).** With `addressArgs: 'self-or-listed'` (the default), every address-typed argument of an auto-approved call, at any depth of the Soroban invocation tree or ABI-decoded EVM calldata, must be the user's own address, a listed contract, or a policy `addresses` entry. So an injected script can't make an allowed function send funds or allowances to itself. `'any'` must be set explicitly per function and is shown to the user as "can send to any address"; it skips only the check on typed addresses.

**Opaque arguments are never auto-approved without a decoder (fix/b-core-policy, 2026-10-28).** A recipient or a call can hide in arguments the address rule can't see into: EVM `bytes`, `string`, `bytes20`–`bytes32` and 160-bit integers (`uint160`/`int160`, an address as an integer), at any depth of arrays and tuples, in calldata and in EIP-712 fields; Soroban `Bytes`, `BytesN` and `String` at any depth of `Vec`/`Map`. Under either rule such a request goes to the popup (`opaque_bytes`). The validator refuses EVM signatures that have them; a Stellar policy names functions without argument types, so for Stellar the matcher refuses them in each request. Shorter fixed bytes (selectors, flags), Soroban `Symbol`s and integers of other widths pass. Residual risks: a contract that casts a `uint256` (or `u256`) argument to an address isn't caught; a value-moving or execute-style function under a name the lists don't cover can still be listed with `'any'`. Only partner-listed contracts are ever auto-approved. Treating `uint160` as opaque also keeps Permit2 typed data (`uint160` amounts) and Uniswap v3 calls (`uint160 sqrtPriceLimitX96`) out of auto-approval until a decoder covers them.

**Matching (in the vault, with the same decoders the approval popup uses, moved to `@hana-id/core`):**
- Stellar transaction: the network passphrase is listed; the fee is within `maxFeeStroops`; every operation is an `invokeHostFunction` calling a listed contract function (including `restoreFootprint`/`extendFootprintTtl` for those contracts' footprints) or a listed `changeTrust`; the whole authorization tree uses only listed contracts and functions; the address rule holds.
- Stellar auth entry: its whole invocation tree passes the same contract, function and address checks.
- EVM transaction: `chainId` listed; `to` a listed contract and the selector listed for it; calldata decodes against the listed signature and passes the address rule; the maximum fee (`gasLimit × maxFeePerGas`, or `gasLimit × gasPrice`) `≤ maxFeeWei` (`fee_too_high`); `value ≤ maxValueWei` (`value_too_high`) and `value + maximum fee ≤ maxValueWei` (`value_plus_fee_too_high`); the day's auto-signed spend plus this one's `value + maximum fee` `≤ maxValueWeiPerDay` (`daily_value_exceeded`). The SDK fills gas and fees on the partner page, so fees count as spend: the vault records `value + maximum fee`. A policy whose calls send no value still needs `maxValueWei` at least the fee they may pay.
- EIP-712: `domain.verifyingContract` and `primaryType` are listed pairs, `domain.chainId` is a listed chain, and address fields in the message pass the address rule.
- Every match also counts against `perDayCount`. Any failed check, decode error or limit reached sends the request to the normal approval popup, which shows why it wasn't auto-approved.

**Consent.** The first matching request (or `hana_requestAutoApprove`) opens the approval popup with a consent screen: the app name and verified origin, the label, every contract with its partner-supplied name and its address, the functions, the address rule (with a warning for any `'any'`), the limits and the duration. Allow uses the same guard as Approve. The consent is stored in the vault record as `consent {policyId, grantedAt, expiresAtMs, day, count, valueWeiByChain}`, inside the AES-GCM record (so it can't be edited on disk), and in memory.
- It is bound to `policyId`: any change to the policy, including one by Hana or a compromised dashboard, needs a new consent, after the change delay.
- It ends at `min(grantedAt + maxConsentMs, session expiry)`, on logout, on `hana_revokeAutoApprove`, or when the user clicks "Stop auto-approving" in any approval popup.
- Counters are per device (the record is per device). Tabs share them through the per-app Web Lock and BroadcastChannel.

**Visibility.** After each auto-signed request the vault emits `autoApproved {kind, chain, contract, function}` to the SDK, and the launcher shows "Signed by Hana under {label}" for 3 s. The partner page can hide the launcher, so this is a courtesy, not a security control.

**Chain support.** Policies apply only where the vault can fully decode a request:

| Chain | Auto-approve | Fit |
|---|---|---|
| Stellar, Soroban invocations | yes | Strong for typed arguments: the address rule sees every typed address, including in nested authorizations. Not for `Bytes` arguments (Sodax, below) |
| Stellar classic | `changeTrust` for listed assets only | Everything else always needs approval |
| Any EVM chain (listed by `chainId`) | yes, direct calls to listed contracts with a listed function signature | Weak for functions with opaque arguments (routers, multicall, cross-chain messages): the address rule can't see inside them, so they need a protocol-specific decoder in `@hana-id/core` (`addressArgs: 'any'` is refused for them) |
| EVM EIP-712 | listed `(verifyingContract, primaryType)` pairs only | Permit-style signatures never by default |
| ERC-4337 user operations, zkSync-native transactions | no | Always approval |
| Other chains (Solana, Sui, Bitcoin, NEAR, …) | no | Batch B derives no keys for them; a later chain needs a new derivation namespace (additive, no address change), a signer and a decoder |

**Sodax needs a protocol decoder (checked against `@sodax/sdk` 2.1.0, 2026-10-27).** On every spoke, a swap is one call to Sodax's AssetManager, `transfer(token, to: bytes, amount, data: bytes)` (EVM ABI; on Stellar a Soroban `transfer(from, token, amount: u128, to: Bytes, data: Bytes)`). `to` is the user's hub wallet on Sonic, and `data` is an ABI-encoded list of calls that wallet executes: for a swap, `[ERC20.approve(hubAsset, intentsContract, amount), Intents.createIntent(Intent)]`, where `Intent.dstAddress` is the real recipient (encoded per destination chain) and `Intent.data` carries the partner fee and optional delivery hook. Other hub actions use `Connection.sendMessage(dstChainId, dstAddress: bytes, payload: bytes)` / `send_message`. The hub wallet holds the user's hub positions, so an arbitrary `data` on a tiny deposit could empty it: per-transaction value limits don't bound this. Therefore:
- `AssetManager.transfer`, `Connection.sendMessage` and `send_message` may **never** have `addressArgs: 'any'`; the validator refuses them like raw signing.
- A future `sodax-intent-v1` decoder (not in batch B, see Q42) would auto-approve a swap only when `to` is exactly the user's hub wallet (computed with the factory's CREATE3 rule, or read once from the hub factory and pinned in the vault record, with test vectors), `data` is not a 32-byte hash, it decodes to exactly the approve + `createIntent` pair with allowlisted targets and matching amounts, `Intent.creator` is the hub wallet, `srcAddress` is the user, `dstAddress` is the user's own address on the destination chain (or a listed hook whose delivery recipient is the user), `solver` is zero or listed, and `Intent.data` holds only a fee entry (receiver listed) and/or a delivery entry.
- ERC-20 `approve` to the listed AssetManager and Stellar `changeTrust` for listed assets work under the address rule as written. Cancel, withdraw, borrow and bridge payloads go to the popup until decoded as further templates.
- Still unverified (the spike records real calldata): the deployed contract sources, the exact `Intent` ABI types, and the factory's CREATE3 variant. `minOutputAmount` can't be judged by a policy, so a script on the partner page could still submit swaps at a poor price to the user's own address, within the count limit (Q39).

**Sodax pilot policy (example):** Stellar mainnet passphrase and the Sodax spoke/hub contracts with their swap and deposit functions, `addressArgs: 'self-or-listed'`, `changeTrustAssets` for the assets Sodax swaps, `perDayCount: 50`, `maxConsentMs` = 12 h, small `maxFeeStroops`; EVM chains Sodax uses, its spoke contracts and selectors, `maxFeeWei` sized for the chain's fees, `maxValueWei` and `maxValueWeiPerDay` sized for pilot amounts plus those fees.

## Derivation v1

`DERIVATION_V1` lives in `@hana-id/core/derivation` and is called only inside the vault and the export window.

1. **IKM.** `S` is the 48-byte compressed G1 point that `decryptCkd` returns after the pairing check against the pinned key.
2. **PRK.** `PRK = HKDF-Extract(SHA-256, salt = utf8("hana-id/chain-keys/v1/extract"), IKM = S)`. Zero S straight after.
3. **info.** `info(ns, curve, account) = borshString("hana-id/chain-keys/v1/expand") ‖ borshString(ns) ‖ borshString(curve) ‖ u32le(account)`. `ns` must match `^[-a-z0-9]{3,8}$` (CAIP-2) and `curve` must match `^[a-z0-9]{1,16}$`; anything else throws.
4. **Frozen tuples:** `("stellar", "ed25519")` and `("eip155", "secp256k1")`. `account = 0` in the MVP, with other values reserved.
5. **Stellar.** `seed = HKDF-Expand(PRK, info("stellar","ed25519",0), 32)` is used as the RFC 8032 seed, the same as `Keypair.fromRawEd25519Seed`. The address is StrKey `G…` (version `6<<3`), using `stellarAddress`.
6. **EVM.** `okm = HKDF-Expand(PRK, info("eip155","secp256k1",0), 48)`. Then `d = (int_be(okm) mod (n − 1)) + 1`, as 32 bytes big-endian. This is `@noble/curves` `mapHashToField`, FIPS 186-5 A.2.1: it can't fail and its bias is ≤ 2^-128. One key covers every EVM chain. The address is EIP-55.
7. **Zeroing.** S, PRK, okm, seeds and `d` are zeroed in `finally` on every path. Only addresses and signatures leave the vault.

**New chains and key types are additive.** HKDF-Expand gives any number of uniform bytes per label, and almost every signature scheme can make its private key from such bytes: ed25519 and sr25519 from a 32-byte seed, secp256k1 and P-256 by the same reduction as EVM, BLS12-381 by its standard KeyGen, ML-DSA and SLH-DSA from their standard seeds, and schemes without a seeded KeyGen (Falcon, RSA) from a deterministic generator seeded by the bytes. Each new chain is a new `(namespace, curve)` tuple plus its key rule, fixed at that chain's launch. For ecosystems whose wallets import only a mnemonic (parts of Cardano and Cosmos), that chain's key can be defined as "BIP-39 entropy from its tuple, then the chain's standard wallet path", so a per-chain phrase export opens the same address; there is still no global recovery phrase. Fixed forever at the address freeze: the MPC network, the extract label, and each launched chain's tuple and key rule.

Every account descriptor carries `{derivation: 1, keyIndex, namespace, curve, account, address}`. Adding a chain means adding a tuple, and adding accounts means a new `account` value; neither changes an existing output. A real scheme change would use salt `hana-id/chain-keys/v2/extract`, opted into explicitly, and v1 stays derivable.

## Key export

1. `hana_export {chain}` queues the export (`busy` if one is running) and shows the launcher. The launcher click opens `{authOrigin}/export` with the window name `hana-export-<32 hex chars, 128-bit random>` as a top-level window. That window refuses to run if it is framed (it also sends `frame-ancestors 'none'`).
2. The export window posts `{v:1, t:"hana:export-hello"}` to `window.opener` with `targetOrigin = vaultOrigin`. It authenticates the vault only by a reply with `event.origin === vaultOrigin && event.source === window.opener`. The vault answers only the window it opened, with `event.origin === authOrigin`: `{v:1, t:"hana:export-context", pk, appName, parentOrigin, scopeId, signer: SIGNER, keyIndex, chain, address}`. These are public values only. The window refuses `signer !== SIGNER`, and checks `scopeId` and the client against `GET /v1/app` with `x-hana-parent-origin`.
3. On a click inside the export window, the window makes its own session key (`max_uses = 1`), salt, nonce (same preimage, its own server-corrected clock from `GET /v1/app`'s `serverTimeMs`), `relayKey`, `relayReadKey` and `relayId`. It opens a child popup `/login?mode=export` with the name `hana-login-<random>`. In export mode `/login`:
   - posts `{v:1, t:"hana:auth-hello"}` to `window.opener` with `targetOrigin = authOrigin`;
   - accepts `hana:auth-params` only when `event.origin === authOrigin`, `event.source === window.opener` and `window.opener.location.pathname === '/export'` (readable: same origin);
   - calls `GET /v1/app`, recomputes the nonce and checks `signer`, `scopeId` and `clientId` exactly as in step 4 of [Login](#login);
   - then follows steps 5–6 unchanged, adding `max_age=0` to the Google request.

   The export window answers `auth-hello` only from the child it opened (`event.source === child`, `event.origin === authOrigin`). It long-polls the relay itself with its read key. Its keys stay in memory across the Google navigation, which happens in the child.
4. The window verifies the token the same way the vault does, plus `auth_time*1000 ≥ now() − 5 min` (`max_age=0` forces Google to re-authenticate). If the spike shows Google doesn't honour `max_age` or omit `auth_time`, this check is dropped and the spec no longer claims a fresh authentication (Q33). It runs `/v1/login`, decrypts against its own computed path, derives PRK, and aborts if the address differs from the vault's `address`.
5. After a typed confirmation, the window shows the key while a button is held. Stellar uses SEP-23 `S…` (version `18<<3`) and EVM uses `0x` plus 64 lowercase hex characters. One (chain, account, keyIndex) is exported per run, shown next to its address. Nothing is copied to the clipboard automatically. Closing the window zeroes everything.
6. No message type in either direction carries key material. The vault's cached PRK is never used for export. The cost is one login: about $0.02 and about 7–9 s plus Google.

## Key rotation hooks

- The vault fixes `keyIndex = 0` in the MVP. `login()` has no `keyIndex` parameter. Records, nonces and descriptors already carry it.
- `key_index ≥ 2^31` is reserved. The contract asserts `key_index < 0x8000_0000` ("key_index ≥ 2^31 is reserved"), `apps/api/src/validate.ts` replaces `isU32` with the same bound, and the SDK and smoke use `KEY_INDEX_LIMIT = 0x7fffffff`.
- Not built: rotation itself (derive n+1, sweep funds, keep the current index), `set_active_key_index`, and the Hana UI for it. A sweep needs two sessions and therefore two Google sign-ins, because the path is fixed per session. A new `key_index` means a new path, so old records fail their AAD check and are dropped.

## Standard interfaces

### Partner client (`@hana-id/web`)

```ts
const hana = createHana({
  publishableKey: 'pk_test_…',
  environment: 'sandbox-dev',
  evm?: { chains: { id: number; rpcUrl: string }[]; defaultChainId: number },
  stellar?: { networkPassphrase: string; horizonUrl?: string; sorobanRpcUrl?: string },
  container?: HTMLElement,          // where the vault iframe and launcher go (default document.body)
});
await hana.ready;                   // handshake done; status known (an unlock has run); rejects vault_unavailable after 5 s
hana.status;                        // 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error'
hana.on('statusChanged' | 'accountsChanged' | 'sessionExpired' | 'disconnect', cb);
hana.login(): Promise<{ stellar: string; evm: string }>;   // call synchronously in a click handler
hana.logout(); hana.exportKey(chain); hana.revokeOtherDevices();
hana.stellar   // { getAddress, signTransaction, signAuthEntry, signMessage, getNetwork }
hana.ethereum  // EIP-1193 provider
hana.signRaw(params)
```

A second `hana.login()` while one is pending supersedes it (the first rejects with `login_cancelled`).

### EIP-1193 (`hana.ethereum`)

`request({method, params})` rejects with `ProviderRpcError {code, message, data?}`. It emits `connect`, `disconnect`, `chainChanged` and `accountsChanged` through a Node EventEmitter-compatible `on` / `removeListener`.

| Method | Behaviour |
|---|---|
| `eth_requestAccounts` | `[address]`. If logged out, tries to open the login popup synchronously. If the browser blocks it (for example Safari after the connector's own `await`s), the vault's "Sign in with Hana" launcher appears and the call resolves after the user clicks it and logs in. |
| `eth_accounts` | `[address]` or `[]` (no accounts by default) |
| `eth_chainId` / `wallet_switchEthereumChain` | Among `evm.chains`; an unknown chain gives `4902` |
| `eth_sendTransaction` | The SDK fills `nonce`, `gas`, `maxFeePerGas` and `maxPriorityFeePerGas` from the chain RPC, gets `eth_signTransaction` from the vault (approval), and broadcasts `eth_sendRawTransaction` |
| `eth_signTransaction`, `personal_sign`, `eth_signTypedData_v4` | Vault, with approval |
| `eth_sign` and other signing methods | `4200` |
| Read-only methods | Forwarded to the current chain's `rpcUrl` |

The SDK announces the provider through EIP-6963 with `{uuid, name: 'Hana ID', icon, rdns}` (rdns open, Q26) and re-announces on `eip6963:requestProvider`. It works with wagmi (`injected` / EIP-6963), viem `custom(provider)` and ethers `BrowserProvider`.

### Stellar Wallets Kit module (`@hana-id/web/stellar-wallets-kit`)

`HanaIdModule` implements `ModuleInterface` for SWK 1.9.x (the version Sodax's `wallet-sdk-react` uses) and 2.x:

| Field or method | Value |
|---|---|
| `moduleType` | `HOT_WALLET` |
| `productId` | `'hana-id'` (`'hana'` is already Hana Wallet, `src/sdk/modules/hana.module.ts`) |
| `productName`, `productUrl`, `productIcon` | `'Hana ID'`, plus a URL and an icon |
| `isAvailable()` | resolves `true` within 1000 ms when the handshake is done, `false` otherwise |
| `getAddress()` | `{address}`; logs in if needed, with the same launcher fallback as `eth_requestAccounts` |
| `signTransaction(xdr, {networkPassphrase, address})` | `{signedTxXdr, signerAddress}` |
| `signAuthEntry`, `signMessage` | `{signedAuthEntry, signerAddress}`, `{signedMessage, signerAddress}` |
| `getNetwork()` | from `stellar.networkPassphrase` |
| `disconnect()` | `hana.logout()` |

Errors map to `{code, message}`, with `4001` for a rejection.

### React (`@hana-id/react`)

- `<HanaProvider config={…}>` creates one client and destroys it on unmount.
- `useHana()` returns `{status, addresses, persistence, error, login, logout, exportKey}`.
- `useWallet('stellar')` returns `{address, signer}`, where `signer` is `hana.stellar`. `useWallet('evm')` returns `{address, provider}`, where `provider` is `hana.ethereum`.
- `login` must be called from an `onClick`.

### Sodax adapter (`@hana-id/sodax`)

Typed against `@sodax/types` 2.1.0 (`IEvmWalletProvider = {chainType:'EVM', getWalletAddress(), sendTransaction(evmRawTx: {from, to, value: bigint, data}), waitForTransactionReceipt(hash)}`; the SDK calls `sendTransaction(rawTx)` with one argument and no chain ID). CI type-checks the adapter against that exact version.

| Export | Implements | Behaviour |
|---|---|---|
| `createSodaxStellarProvider(hana, {networkPassphrase, horizonUrl, sorobanRpcUrl})` | `IStellarWalletProvider` | `chainType: 'STELLAR'`. `getWalletAddress` uses `hana.stellar`. `signTransaction(xdr, {address?})` returns the signed envelope XDR (fee-bump allowed). `waitForTransactionReceipt(hash)` polls Horizon every 2 s for 60 s and returns its JSON. `sendTransaction` goes to Soroban RPC. `signAndSendTransaction(p)` is `sendTransaction(signTransaction(p.data))`. |
| `createSodaxEvmProvider(hana, {chainId, rpcUrl})` | `IEvmWalletProvider` | One provider per spoke chain, bound at creation; throws if `chainId` isn't in the client's `evm.chains`. `chainType: 'EVM'`. `sendTransaction(rawTx)` checks `rawTx.from` is the vault's address, pins `hana.ethereum` to the bound chain, fills, signs with approval and broadcasts. `waitForTransactionReceipt` stringifies number fields. |

Sodax supports mainnet only, so the adapter is tested against mocks of the `@sodax/sdk` 2.1.0 call patterns, not end to end on testnet. A Sodax swap can need several signatures (`restoreFootprint`, a re-sign with the next sequence number, a trustline); the 15 s keep-open approval popup covers them, and with the pilot's auto-approve policy (see [Auto-approve policies](#auto-approve-policies)) they need no popup at all once the user has accepted it.

## Contract changes (`contracts/hana-signer`)

1. **`create_session_and_derive(jwt, scope_id, session_public_key, expires_at_ms, salt, key_index, max_uses, signature, pk1, pk2) -> Promise`**, a literal composition:
   ```rust
   self.create_session(jwt, scope_id, session_public_key.clone(), expires_at_ms, salt, key_index, max_uses);
   self.derive_key(session_public_key, 1, signature, pk1, pk2)
   ```
   - There is no callback and no counter argument.
   - The transaction result is the MPC's `{big_y, big_c}`.
   - Any signer-receipt panic reverts the session insert.
   - `create_session` and `derive_key` stay unchanged.
   - The state layout is unchanged, so this is a code upgrade.
2. **`create_session` asserts `key_index < 0x8000_0000`.**
3. **`contracts/mock-mpc` gets a failure switch,** so that a failed MPC receipt with a committed session can be tested.
4. **No PII check in the contract.** The contract's `Claims` parse ignores unknown fields, and console owner-action tokens (batch C) may legitimately carry `email`. The claim allow-list is an API and vault rule; the docs say so.
5. **Docs and ABI.** `docs/contract-interface.md` and the ABI record the new method, the `key_index` range, the off-chain `hana-id-vault-v1:` prefix and item 4.

Nothing is deployed by this batch's agents. Deploying is the user's step, after `deploy-contract` shows the plan. Each change to the session relayer keys' method list is a delete-and-re-add of every session-pool key (NEAR access-key permissions can't be edited); see [Relayer allowlists](#relayer-allowlists).

## API changes (`apps/api`)

### Endpoints

| Endpoint | Caller (`Origin`) | Effect |
|---|---|---|
| `POST /v1/login` | `vaultOrigin`, `authOrigin` (export) | Relays `create_session_and_derive` |
| `POST /v1/login-relay/:relayId` | `authOrigin` only | Writes the slot once (see [Relay](#relay-durable-object-loginrelay)) |
| `GET /v1/login-relay/:relayId?wait=1..25` | `vaultOrigin`, `authOrigin` (export) | Reads and consumes the slot, with the read key |
| `POST /v1/vault/shares`, `/unlock`, `/touch`, `/revoke`, `/revoke-all` | `vaultOrigin` | See [Vault endpoints](#vault-endpoints) |
| `POST /v1/derive` | `vaultOrigin`; partner origins only for `pk_test_` in dev envs | Unchanged, plus the optional BLS precheck |
| `POST /v1/sessions` | partner origins only for `pk_test_` in dev envs; vault only in the split fallback | Plus the claim allow-list behind `REJECT_PII_ON_SESSIONS`. Retired once `apps/smoke` uses `/v1/login` and the ship gate passes. |
| `POST /v1/sessions/revoke` | `vaultOrigin`; partner origins only for `pk_test_` in dev envs | Unchanged (not used by default) |
| `GET /v1/app` | `vaultOrigin`, `authOrigin`; partner origins | Adds `name` and `serverTimeMs`; uses `google_web_client_id` when set |
| HTML pages | | As in [Origins and pages](#origins-and-pages) |

"Dev envs" means `ENV_NAME` starts with `local` or `sandbox`.

**`POST /v1/login`.** The body is `CreateSessionBody` plus `{signature: number[64], pk1, pk2}`. Checks run in this order:
1. `appGate` (kind `'relay'`);
2. size and shape (`toCreateSession` plus `toDeriveKey` rules);
3. `keyIndex < 2^31`;
4. RS256 and claims, the claim allow-list (always on for `/v1/login`) and nonce recompute;
5. in parallel: `checkClientScope` and `session_key_in_use` (409 `session_exists`);
6. `verifySessionSignature(sessionPublicKey, 1, sig, ckdPayload(pk1, pk2))`;
7. the pk1/pk2 prefix and length checks;
8. only if `BLS_PRECHECK = "1"`: the pairing precheck as one multi-pairing with a single final exponentiation, `e(pk1, −g2) · e(g1, pk2) = 1` (400 `invalid_app_key`).

Then it relays with `DEFAULT_GAS_TGAS.create_session_and_derive = 100`. The response is `{result:{big_y, big_c}, session:{scope_id, expires_at_ms, max_uses, used: 1}, nearTx, requestId}`; `session` is informational only.

**Failure mapping** uses the failing receipt's `executor_id`:
- `executor_id === SIGNER_ACCOUNT` → 422 `contract_rejected`, with `reason: 'session_key_in_use'` when the panic text is `Session key already in use` (other panics: `reason` omitted);
- `executor_id === MPC_ACCOUNT` → 422 `ckd_failed` with `{session:{used: 1}}`;
- any other executor, or none found → 502 `near_error` with `nearTx`.

A timeout gives 504 `timeout` with `nearTx`. Relayer errors keep their codes (`NOT_EXECUTED` set unchanged). On success, usage counts `sessions` and `derives`; on `ckd_failed`, only `sessions`.

**BLS precheck (`BLS_PRECHECK` var, default off).** It is on in an env only after Q8 has measured its CPU time on the Worker and recorded it in `docs/context.md`, and only on the Workers Paid plan (the free plan's 10 ms CPU limit is too small for pure-JS pairings; sandbox-dev is on a free personal account). When it is off, a bad pk2 reaches the chain and the MPC rejects it: 422 `ckd_failed`, with the session committed. Only a misbehaving client sends a bad pk2; each attempt needs a fresh valid Google token and is rate-limited. The same var gates the precheck on `/v1/derive`.

**Origin rule (`appGate`).**
- If `Origin` is `VAULT_ORIGIN` or `AUTH_ORIGIN`, the gate checks `x-hana-parent-origin` with `originAllowed` (403 `origin_not_allowed`), and the response echoes the Hana origin in CORS.
- Otherwise, partner-origin requests are accepted only for `pk_test_` keys, only in dev envs, and only on `/v1/sessions`, `/v1/derive` and `/v1/sessions/revoke`. Everywhere else the partner origin is refused there (403 `origin_not_allowed`) for every key type.
- `originAllowed` accepts loopback origins and the `http://localhost:*` wildcard only for `pk_test_` keys in dev envs.
- A `pk_test_` app whose scope is also the scope of any `pk_live_` app is refused (403 `scope_conflict`); `getAppByKey` reads this in the same query. `admin app:create` and `app:update` refuse to create the conflict.
- `GET /v1/app` keeps partner-origin CORS for both key types.
- Preflight allows the two Hana origins. `x-hana-parent-origin` and `x-hana-relay-key` are added to the allowed headers.
- Rate limits keep keying on the app and the client IP.

**`appGate` kinds.** `'relay'` (`/v1/login`, `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke`) and `'config'` (`GET /v1/app`) are unchanged. A new kind `'vault'` covers the vault endpoints with its own windows, and never touches the `relay` per-IP, per-app minute or per-app day counters:
- per IP: window `${app.id}:vault:minute`, max 60;
- per app: window `vault:minute`, max 10 × the plan's `per_minute`;
- per share (unlock, touch, revoke, revoke-all): 10 per minute, on a limiter named `share:<shareId hex>`.

These are starting values. Page reloads therefore never use up the login quota.

### Vault endpoints

All take `x-hana-key` and `x-hana-parent-origin`, `Origin: vaultOrigin`, JSON bodies with bytes as number arrays (as in the existing API), and return `requestId`. Every endpoint can also return 401 `missing_key`/`unknown_app`, 403 `app_suspended`/`origin_not_allowed`/`scope_conflict`, 400 `bad_request` (shape, sizes), 429 `rate_limited` (with `retry-after`) and 503 `config_unavailable`/`rate_limiter_unavailable`. Signatures are 64-byte Ed25519 over the vault message with the gate app's id; `shareId` is 16 bytes; `sessionPublicKey` 32 bytes.

| Endpoint | Request | 2xx response | Errors |
|---|---|---|---|
| `POST /v1/vault/shares` | `{sessionPublicKey: number[32], signature: number[64]}` (create-share message) | 201 `{shareId: number[16], ks: number[32], absExpiresAtMs, idleUntilMs}` | 409 `persistence_off`; 401 `invalid_signature`; 404 `unknown_session` (no live session after the retries); 403 `scope_mismatch`; 409 `session_not_spent` (`used < max_uses` after the retries); 403 `origin_not_allowed` (parent); 409 `share_exists`; 502 `near_unavailable` |
| `POST /v1/vault/unlock` | `{shareId: number[16], counter, signature}` | 200 `{ks: number[32], counter, idleUntilMs, absExpiresAtMs}` | 404 `unknown_share` (missing, or another app's); 401 `invalid_signature` (counter not consumed); 409 `bad_counter {expected}`; 410 `share_expired`; 410 `share_revoked` (revoked, or its origin removed) |
| `POST /v1/vault/touch` | `{shareId, counter, signature}` | 200 `{counter, idleUntilMs}` | as unlock |
| `POST /v1/vault/revoke` | `{shareId, counter, signature}` | 200 `{revoked: true}` | as unlock; the vault treats 404 and 410 as already revoked |
| `POST /v1/vault/revoke-all` | `{shareId, counter, signature}` | 200 `{revoked: number}` (other live shares for `(app_id, path_hash)`) | as unlock; 403 `share_not_fresh` (share older than 5 min) |

`path_hash = sha256(utf8(path))`, with `path` taken from `get_session` at share creation.

### Relay Durable Object (`LoginRelay`)

- One object per `relayId` (`idFromName`), with no location hint. `relayId` must match `^[A-Za-z0-9_-]{43}$`, else 400 `bad_relay_id`.
- `GET /v1/login-relay/*` is not app-gated and carries no `x-hana-key`; it is rate-limited per IP (writes 10 per minute, reads 120 per minute).
- **Write** (`POST`, `authOrigin` only): body `{iv, ct}` (base64url), at most 8 KiB, else 413. The slot holds at most one value. A first write stores it with `writtenAt` and sets an alarm for 120 s; it returns 204. A second write returns 409 `relay_used`.
- **Read** (`GET`, `vaultOrigin` or `authOrigin`): requires `x-hana-relay-key`; the object checks `b64url(sha256(key)) === relayId` before looking at the slot. A missing or wrong key returns 403 `relay_forbidden` and does not consume the slot. With the right key: 200 `{iv, ct, serverTimeMs}` and the value is replaced by a tombstone `{consumedAt}`; 204 if still empty after `wait` s; 410 `relay_gone` for a tombstone or an expired slot.
- The alarm deletes the value 120 s after the write and keeps a tombstone `{expiredAt}` until 120 s after that, then deletes everything. A slot never written answers 204 until the reader gives up.
- Only ciphertext is stored, which the API can't decrypt (the key is `relayKey`, held by the vault and the popup only). The Worker never logs relay bodies.

### Relayer allowlists

`POOL_METHODS.session` in `relayer-config.ts` and `SESSION_RELAYER_METHODS` in `scripts/lib/contract.ts` (`deploy-plan.ts` imports it) move through three states, with the equality test updated each time. Each state change is a `deploy-contract` step for the user that deletes and re-adds every session-pool access key:

1. **At the contract upgrade** (order of work step 2): `[create_session, create_session_and_derive, derive_key, revoke_session, prune_sessions]`.
2. **Ship gate passes and smoke is on `/v1/login`** (step 7): drop `create_session` → `[create_session_and_derive, derive_key, revoke_session, prune_sessions]`.
3. **Ship gate fails** (step 7): drop `create_session_and_derive` and keep the split flow → `[create_session, derive_key, revoke_session, prune_sessions]`; `create_session_and_derive` is removed from the contract before the audit.

### Data, secrets, code

- **Migration `0003_vault.sql`:**
  - `apps` gets `persistence TEXT NOT NULL DEFAULT 'session' CHECK (persistence IN ('session','none'))`, `session_ttl_ms INTEGER NOT NULL DEFAULT 43200000 CHECK (session_ttl_ms BETWEEN 3600000 AND 85800000)`, `idle_ttl_ms INTEGER NOT NULL DEFAULT 7200000 CHECK (idle_ttl_ms >= 900000 AND idle_ttl_ms <= session_ttl_ms)`, `raw_sign TEXT NOT NULL DEFAULT 'off' CHECK (raw_sign IN ('off','approval'))`, `raw_sign_pending TEXT CHECK (raw_sign_pending IN ('approval'))`, `raw_sign_effective_at INTEGER`, `auto_approve_policy TEXT` (JSON, validated), `auto_approve_pending TEXT`, `auto_approve_effective_at INTEGER`, and `google_web_client_id TEXT`. The admin CLI and the API validate the same ranges.
  - `usage` gets `unlocks INTEGER NOT NULL DEFAULT 0`.
  - A new table: `vault_shares(share_id BLOB PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, session_pk BLOB NOT NULL UNIQUE, path_hash BLOB NOT NULL, partner_origin TEXT NOT NULL, share_enc BLOB NOT NULL, kek_id INTEGER NOT NULL, counter INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, idle_until INTEGER NOT NULL, abs_expires_at INTEGER NOT NULL, revoked_at INTEGER)`, indexed on `(app_id, path_hash)`.
- **Secrets.** `VAULT_KEK` is 32 bytes, base64, with an id. `share_enc = AES-GCM(KEK, iv, K_s, aad = share_id ‖ app_id ‖ session_pk)`. During a rotation `VAULT_KEK_PREVIOUS` is also read, and rows are re-wrapped on unlock and by the cron.
- **`gen-wrangler.ts` additions** (and its test): vars `MPC_ACCOUNT` (manifest `mpc`), `VAULT_ORIGIN`, `AUTH_ORIGIN`, `BLS_PRECHECK` (default `"0"`) and `REJECT_PII_ON_SESSIONS` (default `"0"`); a `LOGIN_RELAY` Durable Object binding with migration `{tag: 'v2', new_sqlite_classes: ['LoginRelay']}` after the existing `v1`; an `assets` binding for `packages/web/dist/pages/<env>`; routes for both hostnames (or the step 0 arrangement). `Env` gains the same fields.
- **Cron (the existing hourly trigger).** Also prunes `vault_shares` rows with `abs_expires_at < now` or `revoked_at` set, and re-wraps rows still under the previous KEK.
- **NEAR code.** `near/rpc.ts` adds `executor_id` to `receipts_outcome`, and `near/tx.ts` returns the failing receipt's executor and panic text.
- **Logging.** Never log tokens, `K_s`, `share_enc`, ciphertexts, signatures, relay bodies or keys, or CKD responses.

## Security model

### Chain of trust for a shared-client login

1. Google delivers shared-client tokens only to `{authOrigin}/login/callback`. The production shared client has exactly that redirect URI and no JavaScript origins; this is a manual deploy-checklist item.
2. The callback forwards a token only for a `state` that its own `/login` stored in first-party `sessionStorage`, and only encrypted under the `relayKey` stored with that state.
3. `/login` built that state from a vault reply it authenticated by `event.origin === vaultOrigin` and the opener-mode source check. It cross-checked the reply's nonce, `signer` and `scopeId` against its pinned `SIGNER` and `GET /v1/app` for `parentOrigin`.
4. The vault serves only a parent that `frame-ancestors` (from the app's origins) and `event.origin` both allow. It computes the nonce from the pinned `SIGNER` and its inlined `scopeId`, over a session key that can't leave it.
5. The vault reads only a relay slot it can decrypt, accepts only a token with its own nonce and a valid Google signature, and uses only the path it computed. The CKD result must pass the pairing check against the pinned key for `ckdAppId(SIGNER, path)`.

### Threats

| Attacker | Can | Cannot |
|---|---|---|
| Another site (evil.test) | Frame a vault with its own `pk`, and so log users into its own scope (legitimate) | Frame the vault for app X (CSP); get `auth-params` (source/origin checks); use a popup it opened (no vault in its frames); inject a token (state, nonce, relay encryption and source checks) |
| XSS or a malicious dependency on the partner page | Start a login (the popup is visible), read addresses, queue signature requests, navigate the login popup | Read keys, tokens or nonces; get any signature, raw or decodable, without a guarded Approve in a Hana popup, except requests matching an auto-approve policy the user accepted (bounded by its contracts, functions, address rule and limits); clickjack the approval (the popup can't be overlaid, the launcher only opens it, and Approve needs 1 s after render and after focus plus an arming gesture: a mouse move, a tap, or Tab/arrow) |
| A malicious extension in all frames | Everything the user can do, including reading an exported key | Nothing: no browser design stops it. Stated here so integrators know. |
| Disk thief or malware in the same profile | With a live share: call unlock and get PRK permanently. | Anything after logout, idle expiry, absolute expiry or revoke. A derive (the session is used up). |
| Compromised Hana API logic or D1 (not the pages or bundles) | Deny service; with `VAULT_KEK` plus a device dump, get PRK; point a vault at another scope of the same user (Q7); turn `raw_sign` to `'approval'` (the user still sees the raw warning and must approve); set or widen an auto-approve policy (delayed, and the user must accept the new `policyId` before it signs anything) | Substitute a signer, path or key (pinned `SIGNER` and CKD key, vault-computed path, end-to-end encrypted relay so it never sees the nonce before the path is fixed); swap the token; sign without approval |
| Compromised Hana Worker, vault or auth origin, or Cloudflare account | Everything (single trust root): it serves the bundles. Mitigated by a tiny vault bundle, strict CSP, no third-party script and a narrow `frame-ancestors`. | |
| Lying NEAR RPC | Fail derives, give wrong counters, delay | Forge a CKD (pairing check against the pinned key) |
| Someone who sees the token (the API at `/v1/login`, mempool, chain) | Front-run `create_session` with the vault's public key (the vault derives with the next counter); replay the whole combined call, which in `'session'` mode burns the only use and costs the user one re-login (`session_consumed`; the attacker pays gas) | Derive for themselves (needs the session key; the MPC result is encrypted to the vault's `a`) |
| Own-client partner, or XSS on its origins if its Google client lists JS origins or native clients | Get tokens with any nonce and derive users' keys for that scope | Anything in other scopes. Inherent: Hana can't see Google client settings, so the dashboard recommends shared mode. |
| A process serving localhost (malicious dev server, local malware) | In dev envs only: frame a `pk_test_` vault and call partner-origin endpoints for test scopes | Anything in a non-dev env (loopback refused), or in a scope used by a `pk_live_` app (`scope_conflict`) |
| Compromise of Google or of the shared-client project | Break isolation for every shared-mode scope (A.2 note) | |
| Leaked in-memory PRK | Every v1 chain and account under that `key_index` | Other `key_index` values. Rotation is the only remedy. |

### Invariants (each has a test)

- No message to the partner page, and no message in any direction, carries key bytes, S, PRK, a CKD response, a Google token or a session secret. The one session secret that crosses `postMessage` is `relayKey`: vault → login popup (`authOrigin`), and export window → its child popup, never to or from the partner.
- The vault refuses to run top-level, accepts one hello, and serves only the pinned port.
- The vault, login and export pages use only the pinned `SIGNER`, `RELAYER` and CKD key.
- Every signature is preceded either by a guarded approval whose digest matches the whole signed request, or by a full match against an auto-approve policy whose `policyId` the user accepted and whose consent and limits are still valid. Raw, `personal_sign`, `stellar_signMessage` and contract-creation requests are never auto-approved.
- The vault never uses a path, session or counter from the API.
- A 410 from unlock leads to a full login, never to a derive.
- In `'session'` mode a persisted session key can never derive on chain (`used === max_uses`).
- Tokens relayed by the API (`/v1/login`, and `/v1/sessions` once `REJECT_PII_ON_SESSIONS` is on) carry only allow-listed claims. The contract does not enforce this for direct callers.
- One app's vault never reads, unlocks or broadcasts to another app's records, even on the same scope and site.

### Properties given up (named)

1. Something about the key is on disk: a PRK wrapped under the server share, useless without the live API share.
2. A page load doesn't need a fresh Google login. Partner-page XSS can drive an unlocked vault within the idle and absolute limits, bounded by per-signature approval.
3. A new coupling: Hana's API (with `VAULT_KEK`) plus a device dump yields the key. Neither does alone.
4. In `'session'` mode an MPC failure, or a replay of the combined call, means a new login.
5. A new authenticated surface: five vault endpoints, the relay, `/v1/login` and a D1 table, all audit items.
6. Without an auto-approve policy, every signature costs at least a launcher click and an Approve (on mobile, popups open as tabs). With one, partner-page XSS can sign requests inside the accepted policy up to its limits, for example swaps with poor prices on allowed contracts; token amounts other than native value are not capped yet (Q39).
7. Safari and iOS may drop partitioned storage early, which means more full logins.
8. The relay holds an encrypted token for up to 120 s and adds about 0.1–0.3 s.
9. No single recovery phrase: export is one key per chain.
10. Google Workspace accounts can't log in until Q32 is decided (`hd` is refused).

## Partner requirements (documented, detected where possible)

- CSP `frame-src` must allow `vaultOrigin`. The SDK raises `vault_unavailable` if the handshake fails within 5 s.
- Popups must be allowed. The SDK raises `popup_blocked` and falls back to the vault's launcher.
- COOP must not be `same-origin`; `same-origin-allow-popups` and `unsafe-none` are fine. The SDK raises `coop_blocks_popup` when the popup reports `closed` before it connects.
- `login()` should run synchronously in a user click; if it can't (`eth_requestAccounts` or SWK `getAddress` after `await`s), the launcher fallback costs the user one more click.
- Unsupported: Google Identity Services on the partner page, in-app webviews (Google returns `disallowed_useragent`), partner pages with COOP `same-origin`, and (for now) Google Workspace accounts.
- Own-client mode: add `{authOrigin}/login/callback` as the only Authorized redirect URI, with no JavaScript origins, and add the Hana domain as an authorized domain on the consent screen. Set `google_web_client_id` if the scope also holds native clients. The dashboard shows the exact strings.

## Cost and latency

| Event | Chain | Gas | Cost | Latency |
|---|---|---|---|---|
| First login, combined call | 1 tx | ~38 Tgas (estimate, to measure) | ~$0.02 | ~6.5–7 s (to measure) plus Google UI |
| First login, split fallback | 2 tx | ~40 Tgas | ~$0.021 | ~8.9 s plus Google UI |
| Reload or new tab, `'session'` within limits | none | 0 | one D1 read + one D1 write | vault page render + one unlock, ~0.1–0.3 s (to measure from SIN, render included) |
| Reload in `'none'` mode, or share expired or revoked | full login | as above | ~$0.02 | as above |
| Logout, touch or revoke-all | none | 0 | one D1 write | one API call |
| Export | 1 login | ~38–40 Tgas | ~$0.02 | ~7–9 s plus Google UI |
| Rejected derive (replay) | 1 tx | 2.21 Tgas | ~$0.0011 | |

Batch C's cost lever is the reload: about $0.01–0.021 and 6–9 s each today, and zero in `'session'` mode.

## Tests

The production standard applies: every behaviour below has a test, and CI runs all of them except the spike and the testnet runs.

### Go/no-go spike (before any SDK code)

Run live logins with the real sandbox shared client and an openid-only implicit request, redirecting to the temporary `http://localhost:5173/spike-callback` (registered in step 0, removed afterwards). Use a consumer Google account and a Workspace account. Confirm and record in `docs/context.md`:
- the exact claim set for each account (expected `iss, azp, aud, sub, iat, exp, nonce`, possibly `nbf`/`jti`; whether the Workspace token carries `hd` with `scope=openid`). The allow-list is fixed from this record;
- whether `max_age=0` forces re-authentication and adds `auth_time` (Q33);
- that `create_session` accepts the consumer token;
- that `sub` and the path equal the GIS-era smoke run for the same account and scope.

### Contract (`contracts/hana-signer/src/tests.rs`; `contracts/integration-tests/tests/{layouts,e2e}.rs`)

- Combined call (unit tests in `src/tests.rs`):
  - stores `used == 1` and the same path as `create_session`;
  - the MPC promise carries the right path, domain, 1 yocto and 20 Tgas;
  - every create panic reverts with no session and no queue entry;
  - a bad signature, a 63-byte signature, a signature over counter 2, and an oversize pk1 or pk2 each revert everything;
  - replaying the same args fails with "Session key already in use";
  - `max_uses = 1`: a later `derive_key` fails "use limit reached";
  - `max_uses = 2`: counter 2 works and counter 1 fails "Wrong counter";
  - prune still runs.
- e2e (mock MPC):
  - through `relayer_fc` with `api_gas("create_session_and_derive")`, the result is unchanged;
  - the key equals the create-then-derive key;
  - a replayed transaction fails;
  - a front-run `create_session` by another account, then recovery with counter 1 (`max_uses = 1`) and counter 2 (`max_uses = 2`);
  - a front-run replay of the whole combined call by another account: in `max_uses = 1` the vault's call fails "Session key already in use" with `used == max_uses` (the `session_consumed` case); in `max_uses = 2` counter 2 recovers;
  - the mock-mpc failure switch leaves `used = 1`, and a counter-2 retry succeeds;
  - the allowlists are equal in each of the three states.
- `key_index = 0x8000_0000` and `u32::MAX` are rejected, and `0x7fff_ffff` is accepted (unit and sandbox).
- A vault-prefixed signature (fixture) is rejected as a `derive_key` and as a `revoke_session`.

### API (vitest, miniflare D1 and Durable Objects, `fetchMock` RPC)

- The `Origin` × `x-hana-parent-origin` matrix:
  - each Hana origin with an allowed, wildcard-matched, unlisted or missing parent;
  - partner origin with `pk_test_` vs `pk_live_` on each endpoint, in a dev env and a non-dev env (refused for every key type outside dev envs);
  - loopback origins refused outside dev envs, in `originAllowed` and `frame-ancestors`;
  - a `pk_test_` app on a scope that a `pk_live_` app uses gets 403 `scope_conflict`; the admin CLI refuses to create it;
  - preflight, including `x-hana-relay-key`.
- The vault page:
  - `frame-ancestors` per `pk`, with loopback only for `pk_test_` in dev envs;
  - 403 for an unknown or suspended app, 503 when D1 fails, neither with a config script;
  - the full CSP and other headers;
  - the inlined config is JSON, not executable, carries no `signer`, and reads no chain RPC;
  - an `appName` of `</script><base href=//x>` stays inside the JSON (escaping of `<`, `>`, `&`, U+2028, U+2029);
  - the 20-origin cap;
  - `raw_sign` uses the pending value only after `raw_sign_effective_at`.
- The auth pages' full CSP and headers, per page.
- `GET /v1/app`: `name`, `serverTimeMs`; `google_web_client_id` used when set, first client when unset.
- `/v1/login`:
  - every validation and precheck code; the BLS precheck rejection with `BLS_PRECHECK = "1"`, and no precheck with `"0"` (a bad pk2 is relayed and maps to `ckd_failed`);
  - the claim allow-list: each refused claim (`email`, `email_verified`, `name`, `picture`, `given_name`, `family_name`, `hd`, `locale`, `profile`, an unknown one) gives `token_has_pii` with the claim; each allowed claim passes; on `/v1/sessions` only when `REJECT_PII_ON_SESSIONS = "1"`;
  - executor mapping: signer failure gives `contract_rejected`, with `reason: 'session_key_in_use'` for that panic; MPC failure gives `ckd_failed`; another executor gives `near_error` with `nearTx`; timeout with `nearTx`;
  - usage counting on success and on `ckd_failed`;
  - the gas default of 100 as a parsed literal.
- Relay:
  - write once (409 on a second write); 8 KiB cap; `relayId` format (400);
  - read with the right key consumes once (410 after, from the tombstone); no key or a wrong key gives 403 and leaves the slot readable;
  - 120 s TTL, then tombstone, then full delete;
  - only `authOrigin` writes; only `vaultOrigin` and `authOrigin` read;
  - the long-poll returns on write;
  - rate limits;
  - nothing from the body is ever in logs.
- Shares:
  - refused unless persistence is `'session'`, the signature verifies, the session is live, the scope matches, `used === max_uses` and the parent origin is allowed (wildcard app included); each with its code;
  - one share per session key (`share_exists`);
  - the uncached `get_session`, retried while a lagging RPC returns null or `used = 0`, then succeeding.
- Unlock, touch, revoke, revoke-all:
  - counter replay, out-of-order and concurrent unlocks (exactly one wins; 409 returns the expected counter);
  - an unlock with another app's `pk` (same scope) returns 404 and doesn't move the counter; a signature made with another app's id fails;
  - a share from a wildcard-registered localhost origin still unlocks;
  - idle and absolute expiry; touch slides `idle_until` without returning `K_s`;
  - revoke; revoke-all within 5 min, `share_not_fresh` after;
  - removing an origin kills its shares (410 `share_revoked`);
  - the `'vault'` limiter windows; unlocks never use up the `relay` per-IP, minute or day counters.
- Migration 0003: the defaults on existing rows and every CHECK (TTL ranges, `raw_sign` values).
- `gen-wrangler`: the new vars, the `LOGIN_RELAY` binding and `v2` migration, the assets binding and routes.
- D1 never holds a plaintext `K_s`. KEK rotation re-wraps rows. The cron prunes. Nothing secret appears in logs.

### Scripts

- `admin app:settings`: every range accepted at its bounds and refused outside; `--raw-sign approval` writes the pending value and effective time, `--raw-sign off` is immediate; `--google-web-client` refused unless it is one of the scope's Google clients; `--auto-approve` validates the policy, writes it as pending with its effective time, and `--auto-approve off` is immediate.
- Manifest schema: `vaultOrigin`/`authOrigin` both or neither; `https` required; loopback only for `local*` env names; same-site pairs refused.
- `envs.generated.ts`: generated with `signer`, `relayer` and the origins; the build fails when `ckdKeyProblem()` reports a problem.

### Core (`@hana-id/core`)

- Layouts: session nonce, session message, CKD payload, vault message, approval digest and relay AAD against `test_fixture.json` and new fixtures from `gen-fixtures.mjs`.
- CKD: decrypt and pairing check against legacy vectors; a substituted attacker path or CKD fails; a CKD for another signer's `app_id` fails against `ckdAppId(SIGNER, path)`; the identity point is rejected; `parseNetworkKey` rejects an invalid G2; `ckdKeyProblem` and `isValidNetworkKey` as moved from smoke.
- Derivation v1:
  - frozen vectors in `packages/core/test/vectors/derivation-v1.json`, covering S → PRK → info bytes → seed, okm and `d` → both addresses → both export strings, for several S values, account 0 and 1, and key_index variants;
  - a SHA-256 guard constant that fails with "address-changing edit";
  - independent checks: WebCrypto HKDF plus a BigInt FIPS A.2.1 reduction; `stellar-sdk` `Keypair.fromRawEd25519Seed`/`fromSecret`; viem `privateKeyToAccount` (devDependencies only);
  - `reduce()` at okm = 0, n−2, n−1, n and 2^384−1;
  - separation: changing namespace, curve, account, version or S changes the key;
  - a golden test of the salt and info bytes (a salt/info swap fails); the grammar validator rejects bad input;
  - zeroisation of S, PRK, okm and seeds, including when an error is thrown;
  - the legacy PROVISIONAL vectors and constants are deleted.
- Signers: Stellar tx (v1 and fee-bump), auth entry, SEP-53 message, EVM type 2 and legacy, EIP-191 and EIP-712, raw (both chains, `v ∈ {27, 28}`), against fixtures checked with stellar-sdk and viem. Export strings re-import to the same address, with the StrKey CRC and EIP-55 checksum verified.
- Decoders: XDR, EIP-1559 and EIP-712 fixtures, including unknown operations and malformed input.
- `normalizeTypedData`: fixtures for duplicate keys, an extra field, a missing field, an undeclared type, a cyclic type, a `primaryType` not in `types`, and a mismatched domain each refused; the normalized object hashes to viem's result for valid input.
- RS256 check and allow-list: bad signature, unknown `kid`, wrong `iss`, wrong `aud`, expired, each refused claim, `auth_time` freshness.
- The message schema rejects unknown types, extra fields and oversize messages.

### Web unit (`@hana-id/web`, happy-dom or jsdom plus fake-indexeddb)

- Vault:
  - refuses to run top-level, or with no config;
  - one hello only;
  - checks `event.source`, the origin allow-list and `ancestorOrigins`;
  - answers `auth-hello` only while a login is pending, once, only from `authOrigin` with the right opener-mode source;
  - a `GET /v1/app` (or an inlined config) with a different `signer` produces no `auth-params` and no derive (`config_mismatch`);
  - the server-corrected clock: with the device clock 2 min slow, 3 h fast and 3 h slow, a fresh token is accepted and `expiresAtMs` stays within the contract's bound;
  - `ready` reports `storage_unavailable` when IndexedDB throws.
- Login popup:
  - refuses a reply from the wrong origin or source, in each opener mode;
  - refuses on a nonce, signer, scope or client mismatch;
  - shows the COOP error when `window.opener === null`;
  - export mode refuses `auth-params` from a non-`/export` opener, from another origin, or from a source other than `window.opener`.
- Callback: refuses an unknown or reused `state`, clears the fragment, encrypts with the stored `relayKey`, awaits the POST before closing, stays open on 409 or a network error.
- Login (vault):
  - rejects a relay payload it can't decrypt, and a token with the wrong nonce, aud, iss, exp or iat, or a refused claim;
  - rejects any API-supplied path;
  - `session_exists` and `contract_rejected`/`session_key_in_use` recovery: derive when uses remain, poll the earlier `nearTx` when known, `session_consumed` otherwise;
  - RPC re-sync before a retry;
  - the timeout and `near_error` tx-poll path, with `sender_account_id = RELAYER`;
  - each not-executed code resends once; `relayer_unavailable` re-syncs;
  - `ckd_failed` handling per mode; `max_uses` per mode;
  - `busy` only for export; a second `hana_login` supersedes the first (`login_cancelled`) and a late relay write for the old `relayId` is ignored; `hana_cancelLogin`; the 5 min pending limit gives `login_timeout`; Google `#error` gives `google_error`;
  - the SDK: popup `closed` before connect gives `coop_blocks_popup`; no hello within 15 s gives `login_timeout`; `popup_blocked` shows the launcher, and a launcher click opens `/login?from=vault`.
- Approval:
  - a digest mismatch (including one where only `context` differs), a wrong source or origin, a stale or unknown id each produce no signature;
  - Approve stays disabled before 1 s since render, before 1 s since focus, and without an arming gesture (mouse move, touch/pen press, Tab or arrow key; never a mouse press in place, Enter, Space or a held key, and the arming gesture never approves; Approve is never autofocused); the guard resets for a new request in a reused popup;
  - the queue position is shown;
  - Reject and close give `4001`;
  - the queue order;
  - keep-open reuse within 15 s and close after.
- Auto-approve:
  - the policy validator refuses `addressArgs: 'any'` on approve/transfer-style and execute/multicall-style functions, EVM functions with opaque arguments (`bytes`, `string`, `bytes20`+, `uint160`/`int160`) under either rule, a missing `addressArgs` on a function taking an address, raw/`personal_sign`/creation entries, and limits out of range; `policyId` is stable under key reordering;
  - no consent: a matching request opens the consent screen, then signs; Allow is guarded like Approve;
  - with consent: a matching request signs with no popup and emits `autoApproved`; each mismatch (unlisted contract, function, selector, chain or passphrase; an address argument that isn't self or listed, at any depth of the auth tree or calldata; fee, value, value plus fee or daily value plus fees over the limit; an opaque argument under either rule; `perDayCount` reached; an undecodable request; a classic op other than a listed `changeTrust`; a fee-bump) goes to the approval popup with the reason;
  - raw, `personal_sign`, `stellar_signMessage` and contract creation always need approval, whatever the policy;
  - a changed policy (new `policyId`) ignores the old consent; removal is immediate; setting or changing waits for the delay;
  - consent ends at its expiry, at session expiry, on logout, on `hana_revokeAutoApprove` and on "Stop auto-approving"; counters survive reload (inside the encrypted record), reset per UTC day, and are shared across tabs; a record with tampered consent fails the AAD check;
- Raw signing: off gives `4100`; approval mode needs approval and shows the raw warning; a raw request whose bytes are a valid transaction hash is shown as raw, never decoded, and needs the same approval.
- Persistence:
  - AAD tamper on each field (including `appId`) fails and deletes the record;
  - two apps on one scope and one site see only their own record, lock (`hana-vault-unlock:<appId>`) and channel (`hana-vault:<appId>`); a logout in one doesn't touch the other;
  - an address mismatch deletes the record;
  - a 404 `unknown_share` deletes the record; a 410 deletes the record and starts a login; a 409 `bad_counter` retries once with `expected`;
  - storage throwing falls back to `'none'`;
  - the counter is written before release;
  - touch is sent at most once per 10 min and only after an approved signature;
  - logout wipes the record and broadcasts;
  - a `derivationVersion` or `ckdKeyHash` change drops the record;
  - buffers are zeroed.
- A `postMessage` and BroadcastChannel spy plus a fuzz test show that no message ever carries key bytes or a token, and that `relayKey` goes only to the authenticated login popup.
- Export: refused when framed, without a gesture, with a vault reply from the wrong source, with `auth_time` older than 5 min, or on an address mismatch; the window name is random.
- EIP-1193 and EIP-6963: announce on load, re-announce on `eip6963:requestProvider`; `4902` for an unknown chain; tx fields cross the port as `0x` hex strings.
- SWK module: `isAvailable()` resolves `true` within 1000 ms after the handshake and `false` without one.

### React (`@hana-id/react`, testing-library)

- `HanaProvider` creates exactly one client (also under React strict mode) and destroys it on unmount.
- `useHana` reflects `status`, `addresses`, `persistence` and `error` through login, logout, `sessionExpired` and `disconnect`.
- `useWallet('stellar')` and `useWallet('evm')` return the address and `hana.stellar` / `hana.ethereum`, and update on `accountsChanged`.
- `login` called from `onClick` opens the popup synchronously.

### Sodax (`@hana-id/sodax`, mocked `@sodax/sdk` 2.1.0)

- The adapters type-check against `@sodax/types` 2.1.0.
- Stellar: `signTransaction` with and without `address`, fee-bump, `sendTransaction`, `signAndSendTransaction`, `waitForTransactionReceipt` polling and its 60 s timeout.
- EVM: one provider per chain; creating one for an unconfigured chain throws; `sendTransaction(rawTx)` with the SDK's one-argument call pins the bound chain, fills, approves and broadcasts; a `from` other than the vault's address is refused; receipt number fields are stringified.
- A multi-signature swap (`restoreFootprint`, re-sign, trustline) runs through one keep-open popup.

### Playwright (Chromium, WebKit, Firefox)

The partner runs on `http://localhost:<p>`, the vault on `http://127.0.0.1:<v>` and auth on `http://127.0.0.1:<a>` (a `local` env), so partner and vault are different sites. A local OIDC stub stands in for Google. It is selectable only in local test builds, and production bundles hard-code `accounts.google.com`. Cases:
- Embedding from an unlisted site is blocked.
- A forged `auth-hello`, `auth-params` or approval from evil.test is refused.
- A popup opened by a foreign page gets no params.
- An opacity-0 overlay over the launcher produces no signature.
- A scripted double-click across the launcher→popup opening produces no signature.
- A request injected into a reused approval popup and clicked within 1 s produces no signature.
- A login with one click on the partner's button (plus the stub's chooser) works.
- Closing the login popup and clicking login again works (supersede).
- Two partner tabs logging in at once each complete.
- A reload restores the key with zero `/v1/derive` calls.
- A second tab unlocks.
- Another top-level site sees no record; another app on the same site and scope sees no record.
- Logout wipes all tabs of that app.
- A 410 leads to a full login, never a derive.
- Blocked storage falls back to `'none'`.
- COOP `same-origin` gives `coop_blocks_popup`, and `same-origin-allow-popups` works.
- An IdP stub that enforces COOP `same-origin` still completes the login through the relay. This also checks that `sessionStorage` survives the browsing-context switch.
- The callback closing right after its POST still delivers the token.
- A follow-up request appears in the same open popup.
- Rejection returns `4001`.
- Export completes for both chains through the export-mode child popup.
- wagmi/viem with the EIP-1193 provider, and SWK 1.9.x and 2.x with the module, each sign through approval. In WebKit, the wagmi and SWK connect paths (popup after `await`) complete through the launcher fallback.

### Testnet (sandbox-dev, results recorded in `docs/context.md`)

- An openid-only token carries only allow-listed claims.
- A front-run of the token: a `create_session` landing first gives a 409 or `session_key_in_use` and the vault recovers; a full combined-call replay landing after the API's precheck gives `session_consumed` in `'session'` mode and recovers with counter 2 in `'none'` mode.
- 10 runs of `create_session_and_derive`: gas across all receipts and the latency median, for the ship gate.
- One forced MPC-side failure from a scratch account calling the contract directly, recording the receipt shape and the yield timeout.
- The BLS precheck's CPU time on the Worker (Q8), measured before `BLS_PRECHECK` is turned on anywhere.
- Unlock latency from SIN, vault page render included.
- Safari/WebKit retention of partitioned IndexedDB.
- `key_index` 0 vs 1 gives different addresses; own vs shared client gives the same addresses, with the own client in a **separate Google Cloud project** from the shared client (the sandbox partner client is in the same project, so it does not prove the A.2 promise; record this in `docs/context.md`).
- One live derivation vector (fixed testnet path to address), re-checked on each deploy.

### Other

- Fuzzing: the port protocol and the window messages (property tests on the schemas plus the vault handler).
- A scheduled COOP canary: alert when `accounts.google.com/o/oauth2/v2/auth` sends an enforced COOP, or when the openid-only `id_token` request starts failing.

## Order of work

0. **User setup (before step 1).**
   - Choose the sandbox-dev hostnames for `vaultOrigin` and `authOrigin`: a Hana-owned custom zone with routes on the API Worker, or two more `workers.dev` hostnames (thin Workers that serve the static pages and forward `/vault` rendering to the API Worker through a service binding). Fill both fields in `envs/sandbox-dev.json`.
   - Google Cloud: add `{authOrigin}/login/callback` as an Authorized redirect URI on the sandbox shared client and the partner client, and the temporary `http://localhost:5173/spike-callback` on the shared client for the spike (removed after step 1). Create an own-client test client in a separate Google Cloud project for the own-vs-shared test. Have a Workspace test account for the spike.
1. Go/no-go spike (openid-only, consumer and Workspace accounts). If it fails, stop and decide Q1 with the user. Fix the claim allow-list from the result.
2. Contract: combined call, `key_index` reservation, mock-mpc switch, tests. The deploy plan goes to the user, including session-key rotation to allowlist state 1.
3. `@hana-id/core`: port from smoke (including `ckdKeyProblem`), derivation v1, vectors, signers, decoders, `normalizeTypedData`.
4. API: origin and dev-env rules, `/v1/login`, relay, vault endpoints, migration, pages, gen-wrangler, tests. `REJECT_PII_ON_SESSIONS` stays `"0"` and `BLS_PRECHECK` stays `"0"` in every env, so `apps/smoke` (still on Google Identity Services, whose tokens carry `email`) keeps working on `/v1/sessions`.
5. `@hana-id/web`: vault, auth pages, partner client; Playwright.
6. Interfaces: EIP-1193, SWK, React, Sodax.
7. Move `apps/smoke` to the vault; set `REJECT_PII_ON_SESSIONS = "1"`; measure the ship gate, the unlock latency and the BLS precheck CPU time; then rotate the session keys to allowlist state 2 (gate passes) or 3 (gate fails), as a user deploy step.
8. Docs: `docs/context.md`, the A.2 nonce wording, `docs/contract-interface.md`, `apps/smoke/README.md`, and a new partner integration guide `docs/integration.md`.

## Out of scope for batch B

- Dashboard and settings UI (batch C); `admin app:settings` is the stopgap.
- Silent (`app_signed`) raw signing (Q31).
- Email login.
- Rotation flow and `set_active_key_index`.
- "Remember this device" beyond the on-chain session.
- Inline confirmation via IntersectionObserver v2.
- Token-amount caps in auto-approve policies (Q39), cross-device limits, and server-side delegated signing (Privy-style session signers: the key exists only in the vault).
- Storage Access API.
- A full-page redirect login mode.
- Native mobile SDKs.
- Chains beyond Stellar and EVM.
- A BIP-39 phrase.
- HSM/KMS for `VAULT_KEK`.
- ZK-JWT.
- Mainnet deploy, final accounts and the address freeze (production MVP).

## Open questions

### Changes to the 2026-10-27 decisions

These changes were made for safety or because a decision could not work as written. Each needs the user's confirmation.

- **Q31.** `app_signed` raw signing is removed from the MVP: as specified it was silent signing of chain-valid hashes, controllable from a D1 column. Bring it back later only as requests signed by a per-app partner backend Ed25519 key over `hana-id/raw-request/v1 ‖ appId ‖ chain ‖ sha256(bytes) ‖ expiry ‖ nonce`, registered through batch C's fresh-sign-in, logged, owner-notified and delayed process? **Answered 2026-10-28 (default approved by the user): confirmed (`docs/decisions.md` D48).**
- **Q32.** Answered by the spike (2026-10-28): an openid-only token carries no `hd`, so Workspace users log in normally and no domain reaches the chain. The allow-list stays as a guard against Google adding claims (`docs/decisions.md` D25).
- **Q33.** Answered by the spike (2026-10-28): with `max_age=0` Google returned no `auth_time`. Export relies on a fresh login plus the typed confirmation; the `auth_time` check is dropped (`docs/decisions.md` D27).
- **Q34.** `hana_login` now supersedes a pending login instead of answering `busy`. Confirm. **Answered 2026-10-28 (default approved by the user): confirmed (`docs/decisions.md` D49).**
- **Q35.** The local `K_l` wrapping layer is dropped (it stops no named attacker). Confirm, or name the attacker it should stop. **Answered 2026-10-28 (default approved by the user): confirmed (`docs/decisions.md` D50).**
- **Q36.** Confirmed by the user (2026-10-28): `hana-id/chain-keys/v1/extract` and `hana-id/chain-keys/v1/expand` (`docs/decisions.md` D9).
- **Q37.** Loopback origins and partner-origin `/v1/sessions`/`/v1/derive`/`/v1/sessions/revoke` are limited to `local*`/`sandbox*` envs, and test and live apps may not share a scope. Confirm that a partner's staging uses its own scope (and therefore different addresses) from production. **Answered 2026-10-28 (default approved by the user): confirmed (`docs/decisions.md` D51).**
- **Q38.** `raw_sign` enabling is delayed 24 h. Is that the right delay, and should batch C reuse the origin-change delay instead? **Answered 2026-10-28 (default approved by the user): the same 24 h as origin changes; batch C reuses it (`docs/decisions.md` D52).**
- **Q39.** Auto-approve limits cover counts and native value only. Add per-token amount caps (decoding token amounts from known swap/transfer calls), or rely on counts, the address rule and small pilot limits? **Answered 2026-10-28 (decided by the user): no token caps for the pilot; revisit with the Sodax decoder (`docs/decisions.md` D46).**
- **Q40.** Auto-approve consent is per device and lasts up to the session (12 h default). Should it also require a fresh Google login (not a reload unlock) to grant, and should batch C let users see and revoke consents across devices? **Answered 2026-10-28 (decided by the user): no fresh sign-in; Hana Home will list and revoke consents per device (`docs/decisions.md` D45).**
- **Q41.** Contract names on the consent screen come from the partner's policy. Should Hana verify or curate names for known protocols (Sodax first) before they are shown to users? **Answered 2026-10-28 (decided by the user): partner names are labelled "named by {app}", Hana-verified contracts get a ✓ and their verified name; built (`docs/decisions.md` D44).**
- **Q42.** Answered 2026-10-27 (user): Sodax calls carry intents in opaque bytes on EVM and Stellar. Batch B ships no protocol decoder: Sodax swaps, bridges and hub actions use the approval popup; the decoder interface ships so a Sodax decoder can be added later on demand (`docs/decisions.md` D24).

### Google and privacy

- **Q1.** Answered by the spike (2026-10-28): Google accepts `scope=openid` alone with the implicit flow, and the token carries no email or profile claims. The popup kept `window.opener` through Google's pages in Chrome (Safari untested); the spec still returns the token through the relay (R2; `docs/decisions.md` D25).
- **Q2.** Does `prompt=select_account`, or a `login_hint`, give a near-zero-click full login for returning users? That would shrink the UX gap between the modes, though not the cost gap.
- **Q3.** Own-client policy: require that a partner's client has no JavaScript origins and no native clients, or only warn? Steer Sodax to shared-only? Confirm that adding Hana's domain to a verified consent screen doesn't trigger a re-verification delay. **Answered 2026-10-28 (decided by the user): Hana's shared client by default; a Hana-held branded client per partner for Enterprise; a partner-held client only if insisted on, locked down and with a written warning (`docs/decisions.md` D42).**

### Persistence and storage

- **Q4.** How long does partitioned third-party IndexedDB survive in Safari macOS and iOS, Brave and Firefox strict mode? Measure in the pilot before deciding on IntersectionObserver-v2 inline confirmation or a popup-only vault.
- **Q5.** Default limits: absolute 12 h (vault-architecture proposed 8 h; the contract allows 24 h, the setting 23 h 50 min) and idle 2 h. Each forced re-login costs about $0.021 and about 9 s. Tune from pilot data. **Answered 2026-10-28 (decided by the user): keep 12 h and 2 h; review after a month of pilot data (`docs/decisions.md` D43).**
- **Q6.** Should a later per-app "remember this device" option let the cache outlive the on-chain session? That needs the session public key to stay the share's authenticator after expiry.
- **Q14.** `max_uses` in `'session'` mode: accept 1 (`ckd_failed` or a combined-call replay means a new login; measure the MPC failure rate), or use 2 and burn the spare use with `revoke_session`? The second option needs the share precondition to become "spent or revoked", but `get_session` returns null once a session is revoked. **Answered 2026-10-28 (default approved by the user): `max_uses = 1` (`docs/decisions.md` D53).**
- **Q16.** `VAULT_KEK` rotation procedure, and whether to move it to an HSM/KMS alongside the email issuer. **Answered 2026-10-28 (default approved by the user): `VAULT_KEK` stays a Worker secret with its copy in `.secrets` (`vault-kek` script); KMS later (`docs/decisions.md` D54).**
- **Q28.** Should the vault also zero PRK after an in-memory idle period, not only at absolute expiry? **Answered 2026-10-28 (default approved by the user): yes, after the app's idle TTL; a later request unlocks again (`docs/decisions.md` D55).**

### API and trust

- **Q7.** Should the vault cross-check `scopeId` against the on-chain registry before signing, since a compromised API or Worker could point it at another scope of the same user? **Answered 2026-10-28 (default approved by the user): yes: one registry view at login, before anything is relayed (`docs/decisions.md` D56).**
- **Q8.** How much Worker CPU does the BLS multi-pairing precheck take? Turn `BLS_PRECHECK` on only on the Paid plan and only after measuring; or drop it, since the MPC rejects a bad pk anyway. **Answered 2026-10-28 (default approved by the user): the precheck stays off unless a measurement shows it is cheap (`docs/decisions.md` D64).**
- **Q9.** Which NEAR RPC does the vault use for `get_session` re-sync and tx polling: the manifest `rpc`, or a second independent endpoint? **Answered 2026-10-28 (default approved by the user): the manifest `rpc`, plus an optional `rpcFallback` used only when it fails (`docs/decisions.md` D65).**
- **Q13.** When can partner-origin CORS for `pk_test_` be removed in sandbox envs too, now that it is already refused elsewhere?
- **Q22.** Should a newly allowed origin take effect only after a timelock in shared mode, now that origins directly control the vault's `frame-ancestors`? **Answered for batch C (decided by the user): origin changes take effect after 24 h, with notice and cancel (`docs/decisions.md` D32, D34); not built, so `admin app:origins:add` applies at once.**

### Contract

- **Q10.** Ship gate: is "median saving < 1.5 s → remove before audit" the right threshold, now that persistence makes logins rarer?
- **Q11.** What exactly does the real MPC do on a yield timeout or failure? The roughly 113 s is computed from 200 blocks at 0.567 s and not yet observed.
- **Q12.** Remove `create_session` from the contract before the audit, or keep it as an unrelayed public method (this spec keeps it)? **Answered 2026-10-28 (default approved by the user): keep `create_session` (`docs/decisions.md` D57).**

### Domains and hosting

- **Q15.** The production Hana-owned domain and Cloudflare account for `vaultOrigin` and `authOrigin` (sandbox-dev's are chosen in step 0). Should they sit on a registrable domain separate from the dashboard and marketing site? Should `authOrigin` equal `apiUrl`? Should the static bundles be deployed from a separate origin with different deploy credentials from the API Worker, so a compromised API deploy can't change them? **Partly answered 2026-10-28 (decided by the user): `vaultOrigin` and `authOrigin` sit on two registrable domains (`docs/decisions.md` D38), each served by its own thin Worker (D66); the domain names and the Cloudflare account are open.**
- **Q26.** The EIP-6963 `rdns` value, which depends on Q15.

### Signing UX

- **Q17.** How long the approval popup stays open (15 s proposed), and how it behaves on mobile, where popups open as tabs, for Sodax's `restoreFootprint` and trustline sequences.
- **Q24.** Mobile: does the opener and launcher flow work on iOS Safari, Android Chrome and Firefox with strict tracking protection? What should in-app webviews show?
- **Q27.** Should a `pk_test_` app's vault refuse mainnet Stellar passphrases and mainnet EVM chain IDs? Sodax is mainnet-only, and pilot keys come from testnet MPC. **Answered 2026-10-28: yes (decided by the user): Stellar mainnet and EVM chains outside a testnet allowlist are refused (`docs/decisions.md` D39).**
- **Q29.** Runtime dependencies of the approval page and the signers (for example `@stellar/stellar-base` for XDR, and an EVM RLP/EIP-712 library): which, and what is their audit and bundle-size budget?

### Export

- **Q18.** Who may start an export from a partner page? Should Hana's relayer pay for it, and should it be rate-limited per user so it can't drain the allowance? **Answered 2026-10-28 (default approved by the user): only from a Hana window, relayer-paid, 3 per hour per user path per app (`docs/decisions.md` D59).**

### Derivation and rotation (product owner, before the freeze)

- **Q19.** Confirm that raw per-chain export is enough to leave Hana and that there will be no BIP-39 phrase. Ask Sodax and early partners. **Answered 2026-10-28 (decided by the user): per-chain key export and Hana Home before mainnet, no seed phrase (`docs/decisions.md` D40, D41).**
- **Q20.** Is two Google sign-ins acceptable for a k→k+1 sweep, or should a later contract change let one session derive at two `key_index` values? **Answered 2026-10-28 (default approved by the user): two sign-ins are acceptable (`docs/decisions.md` D60).**
- **Q21.** Show `account > 0` in the MVP UI, or keep it at 0 until there is a discovery story? **Answered 2026-10-28 (default approved by the user): account 0 only (`docs/decisions.md` D61).**
- **Q23.** Add a CODEOWNERS rule on `packages/core/src/derivation*` and `packages/core/test/vectors/derivation-v1.json`? **Answered 2026-10-28 (default approved by the user): yes, `.github/CODEOWNERS` (`docs/decisions.md` D58).**

### Interfaces

- **Q25.** Support both SWK 1.9.x (Sodax `wallet-sdk-react`) and 2.x with one module, or ship two?

### Reconciliation

- **Q30.** Confirm or overturn R1–R13. **Answered 2026-10-28 (default approved by the user): R1–R13 confirmed (`docs/decisions.md` D47).**
