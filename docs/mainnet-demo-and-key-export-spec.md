# Mainnet demo exception and key export additions: spec

**Status: built on branch `feat/mainnet-demo-key-export`, not merged, not deployed (2026-11-06); self-reviewed (below).** Two security-sensitive features
asked for by the user on 2026-11-06: an exception to D39 for the Sodax demo (a test app may sign small amounts on
Base and Stellar's public network), and additions to key export (D40, D41, D59, D111, D258, D268), already built,
so a user can always take their keys out if the testnet MPC fails. Decisions: D428–D431 (`docs/decisions.md`). This
is a batch spec: once the branch merges it is history, and the reference docs (`architecture.md`, `security.md`,
`api.md`, `integration.md`, `operations.md`, `mainnet-readiness.md`) are the current state.

## Contents

- [Address impact (read first)](#address-impact-read-first)
- [Feature 1: the mainnet demo exception](#feature-1-the-mainnet-demo-exception)
- [Feature 2: key export additions](#feature-2-key-export-additions)
- [Data, endpoints and commands](#data-endpoints-and-commands)
- [Tests](#tests)
- [Security self-review](#security-self-review)
- [Open items for the user](#open-items-for-the-user)

## Address impact (read first)

Nothing here changes how a path, a CKD `app_id`, PRK or a chain key is derived. The demo exception only decides
whether the vault signs a request with the key it already has; the export additions only change what the export
window shows and records after its own, unchanged derivation. The golden vectors
(`packages/core/test/vectors/derivation-v1.json`) and their SHA-256 guard are untouched. The closest anything comes:
the export window now adds a label field (`exportChain`) to its `/v1/login` body. It is not in the session nonce, the
contract call or the CKD payload; the API strips it before the relay.

## Feature 1: the mainnet demo exception

### What the user decided (2026-11-06)

- "Exception for the Sodax demo, also we should limit funds to <$10. warnings are good."
- Then: no per-user daily cap ("they need repeated Sodax swap tests"): **a per-transaction cap only**; when the
  wallet's balance can be read and it is above $10, the approval says so strongly ("keep test funds under $10 — move
  the rest out"); a warning, never a block. Balance unknown is said as such.
- Then: **exactly two mainnets**, Base (8453) and Stellar's public network; Sonic only if the swap needs the user to
  sign on Sonic (it doesn't, below). Prices for ETH, XLM, USDC and EURC on Base and on Stellar (the tokens the sample's
  swap lists), identifiers verified from
  official sources; anything unpriced fails closed.

### What the Sodax swap signs (checked against `@sodax/sdk` 2.2.0, the sample partner's version)

| Direction | What the user signs | Where the money goes |
|---|---|---|
| Base → Stellar (the sample's `SWAP_FROM`/`SWAP_TO`) | one EVM transaction on Base: `assetManager.transfer(address token, bytes to, uint256 amount, bytes data)` on `0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3`, payable, `value = amount` for native ETH (token `0x0…0`); for USDC an ERC-20 `approve(assetManager, amount)` first | the asset manager; `data` is the hub calls `[approve(intents, amount), createIntent(intent)]` (`encodeContractCalls`) that Sodax's relayer executes on Sonic from the user's hub wallet |
| Stellar → Base | one Stellar transaction on the public network: `invokeHostFunction` calling the asset manager contract `CCGF33A4CO6D3BXFEKPXVCFCZBK76I3AQOZK6KIKRPAWAZR3632WHCJ3` `transfer(from: Address, token: Address, amount: u128, to: Bytes, data: Bytes)`, with source-account auth for the root call and the token contract's `transfer(from, assetManager, amount)` | the same hub calls in `data` |
| Receiving (either side) | nothing (a solver delivers); a USDC receive on Stellar needs a `changeTrust` first | — |

The hub (Sonic) is never signed for by the user: `needsRelay` is true whenever the source chain isn't the hub, and the
relayer submits the hub transaction. So Sonic 146 is not in the demo.

### The rule, end to end

The vault (the authority) refuses a `pk_test_` app's mainnet request with 4100 `mainnet_not_allowed`, as D39 says,
**unless all of these hold**, checked before any popup or policy:

1. **The build allows it.** The vault page was built for a dev env (`HanaEnv.devEnv`, `local*`/`sandbox*`) on
   testnet (`HanaEnv.network`). A production manifest's build has the exception compiled out of reach: the check is
   on build constants, not on anything the API or a page sends.
2. **The app has it on, freshly confirmed.** `GET /v1/app` answered `mainnetDemo: true` within the last 10 s
   (`POLICY_FRESH_MS`, as raw signing); older, it is re-read; a re-read that fails refuses (`api_unavailable`,
   `mainnet_demo_unconfirmed`). The API serves `true` only when the D1 column is on, the scope is `test`, and the
   Worker's env is a dev env on testnet. Turning it off takes effect in open tabs within 10 s.
3. **The network is one of the two.** EVM chain 8453, or Stellar's `Public Global Stellar Network ; September 2015`.
   Every other mainnet stays refused (`mainnet_not_allowed`).
4. **The price table is in date.** `MAINNET_DEMO.validUntilMs` (45 days after its review) hasn't passed by the
   server-corrected clock; after that every demo request is refused (`mainnet_demo_prices_stale`) until someone
   reviews the prices and rebuilds.
5. **Hana can value it, and it is under the cap.** The request is one of the shapes below, every asset it can move
   has a configured price, and the sum of everything it can move out, plus its maximum fee, is at most **$9.99**
   (`txCapUsdMicros`). Otherwise 4100 with `mainnet_demo_unknown_call`, `mainnet_demo_unpriced` or
   `mainnet_demo_over_cap` and a plain message ("Hana’s mainnet demo signs at most $9.99 per transaction; this one
   can move about $12.40.").

A demo request is **never auto-approved**, whatever policy the app has: each one opens the approval popup. Typed data
whose domain names 8453 stays refused (a `Permit` can move tokens without a transaction), as does every Stellar auth
entry for the public network (it authorizes a Soroban call Hana can't value). Messages and raw requests are unchanged
(messages name no network, D35; raw is refused for test apps).

### What can be valued (everything else is refused)

**EVM, Base 8453** (`assessMainnetDemo` in `packages/core/src/mainnet-demo.ts`, over the popup's own decoder):

| Shape | Counted |
|---|---|
| any transaction | its maximum fee, `gasLimit × (maxFeePerGas or gasPrice)`, in ETH; plus its `value` in ETH |
| no calldata, `to` set | the `value` (a plain send) |
| `to` = USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `transfer(address,uint256)`, `transferFrom(address,address,uint256)` or `approve(address,uint256)` | the amount in USDC (an approval is valued as what it lets the spender take; an unlimited approval is far over the cap) |
| `to` = the Sodax asset manager, `transfer(address,bytes,uint256,bytes)`, token native with `value == amount`, or token USDC | the amount; `data` empty, or exactly `[approve(intents, g) on the token's hub asset, createIntent(intent) on the intents contract]` with `g ≤ amount`, `intent.inputToken` the hub asset and `intent.inputAmount ≤ g` |
| contract creation (`to` empty), any other selector, any other contract, ERC-20 calls on another token, a native deposit with `value ≠ amount`, a Sodax `data` of another shape | refused |

The hub-call rule bounds what the relayed calls can take from the user's hub wallet on Sonic to the deposited amount
(they can approve and spend at most `amount` of the deposited asset), so a page can't use a $1 deposit to move
earlier hub-wallet funds. The ABI decoder is the approval page's strict one (canonical encoding only), so the vault
and the contract read the same values.

**Stellar public network**:

| Operation | Counted |
|---|---|
| the transaction fee (Soroban resource fee included) | in XLM |
| `payment` of XLM or of `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | the amount |
| `createAccount` | the starting balance in XLM |
| `changeTrust` for that USDC | nothing (it moves no funds; it reserves 0.5 XLM of the user's own balance) |
| `invokeHostFunction` calling the Sodax asset manager's `transfer(from, token, amount, to, data)` with `from` the signing account and `token` the XLM or USDC asset contract | the amount; `data` as for EVM (the token's hub asset); every auth entry must be for exactly that call, with at most one sub-invocation, the token contract's `transfer(from, assetManager, amount)` |
| a fee-bump envelope, any other operation (path payments, offers, `setOptions`, `accountMerge`, other contracts, …) | refused |

### Prices and caps (reviewed config, to confirm: D429)

> **Amended by D436 (2026-11-09, built on `feat/mainnet-demo-live-prices`, not merged):** the vault now values each
> request with live CoinGecko prices from the API (`mainnetDemoPrices` in `GET /v1/app`, live × 1.05 clamped to a band
> per asset), and this table is what stands in, per asset, and the band's ceiling. Its expiry still refuses a request
> that depends on a fixed price past 2026-12-21. Live prices are in `docs/api.md`; the band and worst case in
> `docs/security.md`; the rest of this section still holds for the fixed table.

`packages/core/src/mainnet-demo.ts` `MAINNET_DEMO`, reviewed 2026-11-06, valid until 2026-12-21. Prices are
deliberately **above** the market (a live price couldn't be confirmed on 2026-11-06; ETH was about $3,050 a year
earlier): a higher price makes the cap stricter and the balance warning earlier, so both errors are on the safe side.

| Asset | Identifier (verified) | Decimals | Price used |
|---|---|---|---|
| ETH on Base | native | 18 | $8,000 |
| USDC on Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle's USDC contract addresses page, 2026-11-06; Sodax's `baseSupportedTokens.USDC`) | 6 | $1.05 |
| XLM | native; asset contract `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` | 7 | $1.00 |
| USDC on Stellar | `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Circle's page); asset contract `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | 7 | $1.05 |
| EURC on Base | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` (Circle's EURC contract addresses page, 2026-11-06; Sodax's `baseSupportedTokens.EURC`) | 6 | $1.35 |
| EURC on Stellar | `EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2` (Circle's page); asset contract `CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV` | 7 | $1.35 |

The two Stellar asset contract ids are checked in a unit test against `Asset.contractId(pubnet passphrase)`, so they
can't drift from the classic assets they wrap. Sodax addresses (asset managers, intents contract
`0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef`, hub assets) are copied from `@sodax/sdk` 2.2.0's packaged config and
pinned in a test.

- **Per-transaction cap:** $9.99, fee included, values rounded up to the micro-dollar.
- **Balance warning:** above $10.00 (`balanceWarnUsdMicros`).

### What the page learns (the sample's FRICTION 18, 19, 21)

The SDK's EVM provider used to refuse `wallet_switchEthereumChain` to Base and every transaction on it for a
`pk_test_` key before the vault was asked, and Sodax's EVM adapter switches to 8453 first. Now:

- The vault page inlines `mainnetDemo: true` for an app with the demo on (only then). The vault sends the SDK a
  `mainnetDemo` port event with the rules, `{evmChains: [8453], stellarNetworkPassphrase, txCapUsdMicros: "9990000",
  pricesReviewedAt, pricesValidUntilMs}`, right after the hello (before `ready`), and again when `GET /v1/app` changes it
  (`null` after it was on). A production build never sends it. Older SDKs drop the unknown event.
- The SDK validates it (only Base, only Stellar's public passphrase), keeps it as `hana.mainnetDemo` (with `txCapUsd:
  "9.99"`), emits `mainnetDemoChanged`, and its EVM provider lets exactly `evmChains` through the early check. Nothing
  else in the page relaxes; the vault still decides every request.
- A cap refusal has its own reason, `mainnet_demo_over_cap`, with `data.usd` (the request's value) and `data.capUsd`.
- The Stellar network is per call: the passphrase a signature request names wins (the Sodax Stellar provider's); the
  vault doesn't compare it with `createHana`'s, the approval shows it, and `hana.stellar.getNetwork()` still reports
  `createHana`'s own.
- Valuation is the vault's own reviewed table, not the page's price source: a page that pre-checks with another
  oracle should aim below the cap.

### The approval popup

For a `pk_test_` request whose own decoding names Base or Stellar's public network, the popup shows a red banner
above the request: **"Real funds, test custody: these funds may be lost"**, then "This request can move about $X
(Hana’s limit is $9.99 per transaction)" and the wallet's balance. The popup computes the value itself from the bytes
it decodes (the same `assessMainnetDemo`), never from a number the vault sends.

The balance: the popup reads it from pinned public endpoints, not the partner's RPC (a partner could make it say
anything): Base `https://mainnet.base.org` (`eth_getBalance`, and `eth_call balanceOf` for USDC), Stellar
`https://horizon.stellar.org/accounts/{G…}`. Each read has a 4 s limit; the CSP `connect-src` of `/approve` lists
those two origins only in dev-env builds. Above $10: "This wallet holds about $N: keep test funds under $10 — move
the rest out." Unreadable: "Balance unknown." The balance never blocks anything.

A refused request never reaches the popup: the vault's error says why, and the launcher flashes the reason for a few
seconds ("Refused: over the $9.99 mainnet demo limit"), so the user sees it in Hana's own UI too.

### Who can turn it on

A hot D1 column `apps.mainnet_demo` (migration 0013), only by Hana staff:

- `admin <env> app:settings <app> --mainnet-demo on|off` (scripts), and the admin console's app page ("Mainnet demo"
  on its Signing settings card), through `AdminRpc.setMainnetDemo`.
- Refused unless the manifest's network is testnet **and** the env is a dev env (`isDevEnv`), and the app's scope is
  a test scope; a D1 trigger refuses `mainnet_demo = 1` for an app in a live scope whatever writes it.
- Partners have no way to set it (no ConsoleRpc method, no console control) and their console doesn't show it
  (ConsoleRpc's app view leaves it out, which also keeps its read budget); the app's changes feed shows
  `mainnet_demo.on`/`.off`, and the SDK's `hana.mainnetDemo` tells the partner's page (below). The staff view carries
  it only in an env where it can be set (D420: no control that can't work).
- On and off are immediate, each an `app_changes` row and a `settings_version` bump.

### Usage events

After each demo signature the vault posts `POST /v1/mainnet-demo/events`: the event (`chain, network, kind,
usdMicros`) signed by the session key over the identity message, with the session's wallet proof of the signing
address (the address's own key over this session and app, made at login for the identity token). No key, no
transaction bytes. The API checks the session proof, the wallet proof, the session on chain and single use (as for
identity tokens), then stores a `mainnet_signature` row naming the session's user, when the app has the demo on.
That the signature was made is still the vault's word; rate-limited per app (120 per hour) and best effort: a
failure never fails the signature. Staff see the rows on the admin's Users detail and Support ID lookup, labelled
"reported by the vault", each kind capped on its own so signatures never push an export out of view.

## Feature 2: key export additions

What the user asked (2026-11-06): "an option to let the user export their private key just in case anything goes
wrong i.e. testnet MPC issues etc that causes fund lost cause derivation was no longer possible".

### Already built (unchanged here)

`hana.exportKey(chain)` asks the vault, which shows its launcher ("Export key in Hana"); only a click on that button,
inside the vault's own frame, opens the top-level export window on the auth origin (D59). The SDK method returns
`null`, never a key; no message in either direction carries key material. The export window runs a fresh sign-in of
its own (Google with `max_age=0`, or the email code step: the strongest step-up the vault has), its own session
(`max_uses = 1`), derives only the one chain key (PRK zeroed at once; the CKD output and PRK are never shown), checks it
imports as the vault's address, asks for a typed `EXPORT`, then shows the key on Show/Hide (`S…` seed or `0x` hex),
with Copy (D268). The key is erased 5 min after derivation, at the session's end, when the vault goes away and when
the window closes (D111). The window's CSP allows only the API, NEAR RPCs and Google's JWKS; nothing is stored, sent
or logged.

### Added

1. **Auto-hide.** A shown key hides again 60 s after Show (`EXPORT_SHOW_MS`), as well as on blur, hidden tab and
   pagehide.
2. **The guarded click.** Continue (after `EXPORT`) and Show key are armed by the approval popup's guard
   (`ApproveGuard`: 1 s after render and focus, an arming move or Tab, a click that starts after it, D113's keyboard
   dwell), so a double-click carried from the launcher or a coached Enter can't reveal the key.
3. **Plain warnings** on the first and confirm screens: "Anyone with this key controls your funds", "Hana can’t
   recover it", "Never paste it into a website".
4. **A `key_exported` event.** The API records it when the export window's `/v1/login` succeeds (the moment the key
   can reach the window), server-side, so neither a partner nor a page can skip it: `user_events` row with the user's
   internal id (`hu_…`), app, chain (`exportChain` from the body: `evm`, `stellar`, or null from an older window),
   time and request id. No key, token or path. Staff see it on the admin's Users detail and Support ID lookup.

### Scope and production

On for every app in testnet envs, as it is today. For production, D41 (confirmed by the user) already says export is
mandatory and partners can't switch it off; the manifest schema accepts only `testnet`, so no non-testnet manifest
can exist yet and no gate was added. Whether D41 stands for mainnet (or a Privy-style partner switch is wanted) is
row 1.18 of `docs/mainnet-readiness.md` (D431).

### Not added

- No "account view": Hana has no account page of its own. The entry is the launcher, inside the vault frame, as D59
  decided; a partner shows an "Export private key" button that calls `hana.exportKey`, which only asks for it. A Hana
  account page is Hana Home's (D40), not built.
- No SDK method that returns a key, and none was asked for.

## Data, endpoints and commands

- Migration `apps/api/migrations/0013_mainnet_demo_events.sql`: `apps.mainnet_demo` (0/1, default 0) with insert and
  update triggers refusing 1 for an app outside a test scope; `user_events` (kind `key_exported` |
  `mainnet_signature`, app, scope, user id or address, chain, network, USD micros, request id, time). Applying it is a
  manual step (`docs/operations.md`); until then the API serves `mainnetDemo: false` and records no event (each read
  and write tolerates the missing column or table).
- `GET /v1/app`: `mainnetDemo` (boolean).
- `POST /v1/mainnet-demo/events` (vault page only).
- `POST /v1/login`: optional `exportChain` (`evm` | `stellar`), accepted only from the export window.
- `AdminRpc.setMainnetDemo`, admin route `POST /api/apps/:app/mainnet-demo`; `StaffUser.events`.
- `admin <env> app:settings <app> --mainnet-demo on|off`.

## Tests

- Core (`packages/core/test/mainnet-demo.test.ts`): every allowed and refused shape, cap edges ($9.99 passes, one
  micro-dollar over fails, fee counted), unknown token, unknown selector, contract creation, a Sodax deposit with each
  wrong `data`, Stellar operations (payment, createAccount, changeTrust, path payment, setOptions, accountMerge,
  fee bump, the Sodax invocation with good and bad auth), the price-table expiry, the pinned identifiers.
- Vault (`packages/web/test/vault/mainnet-demo.test.ts`): off → `mainnet_not_allowed`; on → popup with the banner;
  over cap, unpriced and unknown call refused before any popup; a third mainnet refused; a stale or failed
  `GET /v1/app` refuses; turning it off stops it in an open vault; a production build ignores the setting; never
  auto-approved; the usage event posted without key bytes.
- Popup (`approve-page` tests): banner, value, balance above $10, balance unknown; CSP lists the RPCs only in dev
  builds.
- API: `GET /v1/app` serves the flag only in a dev testnet env for a test scope; the events endpoint; the export
  login's `key_exported` row (no key, no token); the trigger; `setMainnetDemo`'s guards (prod env refused, live scope
  refused, a ConsoleRpc caller has no such method).
- CLI: `--mainnet-demo` refused for a production manifest and a live app.
- Export page: auto-hide at 60 s, the guard on Continue and Show, the warnings, `exportChain` sent; a source check that
  the export module never passes the key to `fetch`, `postMessage`, storage, the URL or a console call, and that no
  partner-facing protocol message can carry key bytes.

## Security self-review

Written after the build (2026-11-06), reading the diff of `feat/mainnet-demo-key-export` against `develop` @ ad5f216
for each threat in `docs/security.md` "The mainnet demo and key export". Severity is for a dev testnet env (the only
place the demo exists); "fixed" means changed in this branch.

| # | Finding | Severity | Outcome |
|---|---|---|---|
| R1 | The first client change let Base through the SDK's early D39 check for **every** test app (the vault still refused without the demo), and it never learnt whether the app had the demo (the sample's FRICTION 18, 19) | medium (wrong behaviour, not a bypass) | **fixed**: the vault announces the demo (`mainnetDemo` event) and the provider opens exactly the chains it names; a test without the event refuses Base as before |
| R2 | The early refusal check (D112) assumed the demo on, so an app without it would have got demo reasons ("over the cap") and a stale cached "off" would have refused a request the API allows, with no re-read | medium | **fixed**: in a demo build the mainnet part waits for `sign()`, which reads the setting fresh; consequence accepted: such a request may wake a dormant session before it is refused (dev envs only) |
| R3 | `personal_sign` and `stellar_signMessage` stay allowed for a demo app (they name no network, D35). Most token-moving signatures are EIP-712 (refused on Base), but some protocols accept EIP-191 messages as orders; such a message is not valued or capped | medium | **open, to confirm** (D429): the popup shows the message in full; the option is to refuse messages for a demo app, which would break SIWE-style logins |
| R4 | A signature approved while the demo was on is made even if staff turn it off while the popup is open (the setting is read before the popup, as for raw signing) | low | accepted: at most the one request on screen, still under the cap |
| R5 | A deposit's recipient (the hub wallet in `to`) and the intent's destination aren't checked: a page can send the deposit to anyone | low | accepted by design: the cap bounds what leaves the wallet, whoever receives it; the hub calls are bounded to the deposit (`checkSodaxHubCalls`) |
| R6 | The price table can go stale or be wrong (a live price couldn't be confirmed on 2026-11-06) | medium | mitigated: prices ≈2–3× the market where it was last known, rounded up, a 45-day expiry that refuses everything after; open: review before each demo (security.md (q)) |
| R7 | Usage events are the vault's word that a signature happened | low | accepted (security.md (p)): bound to a live session and the address's own proof (R18), single use, ≤ 120 per app per hour, labelled "reported by the vault", nothing acts on them |
| R18 | (the security review of 2026-11-06, MEDIUM) The report endpoint checked only the app: anyone with an app's key and an allowed parent origin could forge `mainnet_signature` rows for any address | medium | **fixed**: the session key's signature over the event, the wallet proof of the address by its own key for that session and app (another user's address can't be named), the session live on chain in the app's scope, a single-use marker; the row stores the session's user. Tests: forged, wrong key, altered event, no session, replay, stale, another session's or app's wallet proof |
| R19 | (the security review of 2026-11-06, MEDIUM) Key exports and reported signatures shared one LIMIT in the staff view, so a flood of signature rows could hide an export (audit evasion) | medium | **fixed**: each user's rows are capped per kind (`ROW_NUMBER() OVER (PARTITION BY user_id, kind)`), signatures matched by the verified user, never a bare address; the admin labels them "reported by the vault". Test: 60 signature rows leave the export in view |
| R8 | The approval popup now has `connect-src` to two public endpoints (dev builds only); it holds no key, only the request and the address | low | accepted: fixed origins in the build's meta policy and the Worker's header, which must agree (tested); production builds fetch nothing |
| R9 | The balance read tells Base's public RPC and Horizon the user's IP and address | low | accepted: public data, the partner page reads the same; never the partner's RPC (it could lie) |
| R10 | `user_events` holds an internal id or an address with times and isn't in C13's purge or `uid-erase` | medium (privacy) | **open**: `mainnet-readiness.md` 7.17; by hand meanwhile (`operations.md`) |
| R11 | Deploy order: an API with the new reads before migration 0013, or a vault page inlining `mainnetDemo` to an older vault bundle | low | handled: every read of the new column or table falls back to off/empty; the page inlines the key only when on (demo apps in dev envs) |
| R12 | Key material in the export window: the key string reaches only the screen (`textContent`), the clipboard (`writeText`) and the address check; no `fetch`, `postMessage`, storage, console or URL use in the module; the protocol's `hana_export` answers `null` and the export messages refuse any extra field | — | verified by tests (`export-page.test.ts` "the key never leaves this window"); the login body is built from public values and the token only |
| R13 | A click carried from the launcher, a double click or a coached Enter could have revealed the key at once | low | **fixed**: the approval popup's guard on Continue, Show key and Copy key; the reveal screen starts the guard over |
| R14 | A shown key could stay on an unattended screen until the 5 min erase | low | **fixed**: hidden again 60 s after Show |
| R15 | `key_exported` could be skipped by a page | — | not possible: the API writes it at the export login, server-side; it over-reports (a sign-in that never showed the key), which is the safe side |
| R16 | Production reachability of the demo | — | verified: four layers key on the env's own facts (vault build constants, API env, the writers, a D1 trigger for live scopes); tests for each (a production build ignores the inlined flag and sends no event; the API serves false in a production env; the CLI and AdminRpc refuse; the trigger refuses) |
| R17 | Anything that changes a path or a derived key | — | none: no derivation, path, `app_id` or golden-vector change; `exportChain` is a label outside the nonce and the relayed call |

Not reviewed here: the testnet MPC's own custody (D39's reason, unchanged; security.md (o)), and an external review,
which this branch doesn't replace.

## Open items for the user

1. Confirm D429 (prices, the 45-day expiry, the valued shapes, immediate on/off, the balance endpoints) and D430's
   mechanics; decide R3 (messages for a demo app).
2. D431 / `mainnet-readiness.md` 1.18: does D41 (export mandatory, no partner switch) stand for mainnet?
3. Apply migration 0013 on sandbox-dev, deploy (`docs/operations.md` "Mainnet demo and key export events"), then turn
   the demo on for the Sodax demo app only, and off when the demo ends.
4. Review the price table against a live source before the demo, and before 2026-12-21.
