# Integrating Hana ID (partner guide)

Hana ID gives your users a Stellar and an EVM wallet from a Google login, with no extension or seed phrase. You add
the SDK to your web app, users click your "Sign in" button, and you sign through standard interfaces: an EIP-1193
provider, a Stellar signer and a Stellar Wallets Kit module, with an optional Sodax adapter. Keys and Google tokens
never reach your page. They live in a hidden Hana iframe, and every signature needs the user's Approve in a Hana
popup, unless it falls under an auto-approve policy you set and the user accepted.

> **Testnet pilot.** Keys come from the NEAR **testnet** MPC and stay disposable until the address freeze (final
> accounts, audit, mainnet). Don't keep real funds in pilot wallets, on any chain. The SDK doesn't yet refuse
> mainnet networks for test apps (`docs/batch-b-spec.md` Q27). The specification is `docs/batch-b-spec.md`, and this
> guide follows the code on the batch B branch. Where it describes a part still being built, it says so.

## How it works

```
your page ──iframe──▶ vaultOrigin/vault      holds the key (in memory; on disk only under a server-held share)
    │                      ▲  MessageChannel
    └─ window.open ─▶ authOrigin/login ─▶ Google ─▶ authOrigin/login/callback ─(encrypted relay)─▶ vault
                      authOrigin/approve     approval popup: the user reviews and approves every request
                      authOrigin/export      key export window
```

1. `createHana()` inserts a hidden iframe from Hana's `vaultOrigin`. It answers only your allowed origins.
2. `hana.login()`, called in your click handler, opens Hana's sign-in popup. The user picks a Google account
   (Google asks only for `openid`: no email, name or picture is requested or stored). The vault gets the token over
   an end-to-end encrypted relay, sends one NEAR transaction and decrypts the user's key.
3. A reload or a new tab within the session's limits restores the wallet with one API call and no transaction.
4. A signing request shows a small "Review in Hana" button. The user clicks it, the Hana popup shows the decoded
   request, and the user approves it there.

The address depends on your app's **scope** and the user's Google account, never on the browser. The same user
gets the same addresses on every device, and different addresses in another partner's app.

## 1. Get an app

Hana registers apps during the pilot (the self-serve dashboard comes with batch C). Send Hana:

- the app name your users will see ("Signing in to {name} at {origin}");
- every origin your app runs on, as exact origins (`https://app.example.com`, no path). At most 20. Add
  `http://localhost:<port>` (or `http://localhost:*`) for local development; loopback works only for test keys in
  sandbox envs;
- whether you use Hana's shared Google client or your own ([section 6](#6-google-client-shared-or-your-own));
- any [settings](#7-app-settings) other than the defaults.

You get a **publishable key** (`pk_test_…`). It is public: ship it in your page. Your origins are what protect it.

## 2. Install

The packages are not on npm yet; `@hana-id/*` is the reserved scope. Until they are, build from the Hana ID
repository (`corepack pnpm install`, then `corepack pnpm --filter @hana-id/web gen:envs`) and depend on the
workspace packages. They ship TypeScript sources, so your bundler must compile TypeScript (Vite, esbuild and webpack
with a TS loader all do).

| Package | What |
|---|---|
| `@hana-id/web` | `createHana`, the EIP-1193 provider, the Stellar signer; `@hana-id/web/stellar-wallets-kit` for SWK |
| `@hana-id/react` | `HanaProvider`, `useHana`, `useWallet` |
| `@hana-id/sodax` | Optional Sodax wallet-provider adapters |

## 3. Create the client

```ts
import { createHana } from '@hana-id/web';

const hana = createHana({
  publishableKey: 'pk_test_…',
  environment: 'sandbox-dev',
  // optional: only if you use EVM chains
  evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
  // optional: only if you use Stellar
  stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
  // optional: where the vault iframe goes (default document.body)
  container: document.body,
});

await hana.ready; // the vault is up and the status is known (a reload has already been restored)
hana.status;      // 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error'
hana.addresses;   // { stellar: 'G…', evm: '0x…' } or null
```

Create one client per page and keep it. `hana.destroy()` removes the iframe and its listeners (for example on an SPA
unmount).

`environment` names the Hana deployment. The client takes the Hana origins from its own build, so no configuration
can point it at another vault. `sandbox-dev` (testnet) uses:

| | Origin |
|---|---|
| `vaultOrigin` | `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` |
| `authOrigin` | `https://hana-id-auth-sandbox-dev.tingtc.workers.dev` |

Events:

```ts
hana.on('statusChanged', (status) => {});
hana.on('accountsChanged', (addresses) => {}); // { stellar, evm } or null
hana.on('sessionExpired', () => {});            // the session reached its limit: log in again
hana.on('disconnect', ({ code }) => {});        // 4900: the vault connection is gone
hana.on('loginProgress', ({ stage }) => {});    // 'popup_connected' | 'google' | 'token' | 'chain' | 'done'
hana.on('launcher', ({ visible, label }) => {}); // Hana's button is shown or hidden ("Review in Hana", …)
hana.on('autoApproved', ({ kind, chain, contract, function: fn }) => {});
```

`hana.ready` rejects with `vault_unavailable` if the vault doesn't answer within 5 s: usually your CSP's
`frame-src`, an origin Hana hasn't allowed for your app, or the network ([section 5](#5-your-page-origins-csp-popups)).

## 4. Log in, log out

```ts
button.addEventListener('click', async () => {
  try {
    const { stellar, evm } = await hana.login(); // call it directly in the click handler, before any await
  } catch (e) {
    // e is a HanaError: e.code is a number (4001, …) or a string ('login_cancelled', 'google_error', …)
  }
});
```

- **Call `login()` synchronously in a user click.** It opens the popup before anything else, while the browser
  still allows popups. If the browser blocks it anyway, the vault shows a "Sign in with Hana" button (bottom right)
  and the call resolves once the user clicks it and signs in. That costs the user one more click.
- Already logged in: `login()` resolves at once. A second `login()` while one is pending replaces it (the first
  rejects with `login_cancelled`). `hana.cancelLogin()` ends a pending one.
- A first login takes several seconds after the Google account choice (one NEAR transaction plus the MPC; estimated
  6.5–7 s, to be measured on testnet). Show progress with `loginProgress`. A reload needs one API call (estimated
  0.1–0.3 s).
- **Sessions.** With the default `'session'` persistence the wallet survives reloads and new tabs for up to 12 h,
  or until it has been idle for 2 h. Then `sessionExpired` fires and the user signs in again. With `'none'`, every
  page load is a new login. If the browser blocks storage (some private modes), the vault falls back to `'none'` and
  `hana.warning` is `storage_unavailable`.
- `await hana.logout()` signs this app out on this device, in every tab. It sends no transaction.
- `await hana.revokeOtherDevices()` signs the user out of your app everywhere else. It works only within 5 min of a
  fresh login, so offer it right after one.
- `await hana.exportKey('stellar' | 'evm')` lets the user take their key elsewhere. Hana shows a button; the key
  appears only in a top-level Hana window, after a fresh Google sign-in and a typed confirmation, and never reaches
  your page. Stellar keys export as `S…`, EVM keys as `0x…` hex. There is no recovery phrase.

## 5. Your page: origins, CSP, popups

| Requirement | If not met |
|---|---|
| The page's origin is one of your app's origins, exactly | the vault doesn't load (`vault_unavailable`) |
| CSP `frame-src` (or `child-src`/`default-src`) allows `vaultOrigin` | `vault_unavailable` at once (an enforced violation is detected; report-only is fine) |
| CSP `connect-src` allows your own EVM RPC (and Horizon / Soroban RPC for Sodax) | your RPC calls fail; the SDK calls them from your page |
| Popups allowed for your site | the "Sign in with Hana" button fallback (`popup_blocked` if you cancel) |
| `Cross-Origin-Opener-Policy` is not `same-origin` (`same-origin-allow-popups` and `unsafe-none` are fine) | `coop_blocks_popup` |
| Every page that frames yours is also one of your origins (`frame-ancestors` checks all ancestors) | `vault_unavailable` |
| `login()` and `eth_requestAccounts` run in a click | one extra click (the fallback button) |

Not supported: Google Identity Services (the "Sign in with Google" button or One Tap) on the same page, which the
SDK warns about in the console; in-app browsers (Instagram, TikTok, … webviews), where Google refuses to sign in
(`disallowed_useragent`); pages with COOP `same-origin`. A page with `Cross-Origin-Embedder-Policy: require-corp` is
untested: the vault frame sends no COEP header, so such a page may refuse to embed it.

The vault's button (sign-in fallback, "Review in Hana", export) is a fixed 320×72 px Hana frame at the bottom right
of the viewport. Don't cover it: users can't approve anything without it. The `launcher` event tells you when it
shows, if you want to point at it.

Removing an origin from your app signs out the users who signed in there.

## 6. Google client: shared or your own

| | Shared (default) | Your own |
|---|---|---|
| Setup on your side | none | a Web OAuth client in **your** Google Cloud project |
| Google's consent screen shows | Hana | your app |
| Who can obtain tokens that open your users' wallets | only Hana's pages, for your origins | also anyone your client trusts (see below) |
| Addresses | the same in both modes, for the same scope and Google account | |

Both modes put users in your app's own scope, so another app never gets your users' keys. The path holds no client
ID, so you can start shared and move to your own client later without changing anyone's address. Google gives one
account the same `sub` across clients of one Google Cloud project, as measured on testnet. The test with clients in
separate projects is still to run.

**Your own client.** In Google Cloud console → APIs & Services → Credentials, create an OAuth client ID of type "Web
application":

- **Authorized redirect URIs**: exactly `{authOrigin}/login/callback`, and nothing else. For sandbox-dev that is
  `https://hana-id-auth-sandbox-dev.tingtc.workers.dev/login/callback`.
- **Authorized JavaScript origins**: none.
- On the OAuth consent screen, add Hana's domain as an authorized domain.

Send Hana the client ID. Hana registers it as your scope's client; the token's audience then picks your scope.
If your scope also holds iOS or Android clients, which can't run Hana's web flow, Hana pins the web one for you
(`--google-web-client`). A scope with a client of its own always signs in through it.

Hana can't see your Google client's settings. Any JavaScript origin, extra redirect URI or native app on your client
can obtain tokens for it with any nonce, and so derive your users' keys, so an XSS on one of those origins puts your
users' wallets at risk. Keep the client exactly as above, or use the shared client.

## 7. App settings

Hana sets these per app on request (`admin app:settings` now, the dashboard in batch C):

| Setting | Values | Default |
|---|---|---|
| Persistence | `'session'` (the wallet survives reloads under a server-held share) or `'none'` (every page load logs in) | `'session'` |
| Session limit | 1 h to 23 h 50 min | 12 h |
| Idle limit | 15 min to the session limit | 2 h |
| Raw signing | `'off'` or `'approval'` | `'off'` |
| Auto-approve policy | none, or a policy ([section 9](#9-auto-approve-policies)) | none |
| Google web client | your scope's web client, when it has several | the first one |

Loosening takes effect after a delay (24 h in production; 60 s on sandbox-dev): raw signing `'approval'`, and setting
or changing a policy. Tightening takes effect at once for new page loads: raw signing `'off'`, and removing a policy.
In a tab that is already open, a removed policy stops auto-signing within 10 s ([section 9](#9-auto-approve-policies));
raw signing `'off'` reaches an open tab only on its next load.

## 8. Signing

Every signing request goes through the user. The SDK shows "Review in Hana", the user clicks it, and the Hana popup
decodes the request bytes itself, so your page can't misdescribe them. The popup stays open for 15 s after an answer,
so a follow-up request (`restoreFootprint`, a re-sign, a trustline) needs no second click on the button. Each one
still needs its own Approve. Reject, closing the popup, or 5 min without an answer gives `4001`.

The Approve button arms only after the request has been on screen for 1 s and the window has had focus for 1 s, then
a mouse move, a tap, or Tab or an arrow key. The gesture that arms it doesn't approve, so a tap-only user taps twice;
clicking in place without moving the mouse, Enter and Space never arm it. That stops clickjacking and double-click
tricks. Message and raw requests (`personal_sign`, `stellar_signMessage`, `signRaw`) carry a line that the signature
isn't tied to one network: they are valid wherever the key is.

### Stellar

```ts
const { address } = await hana.stellar.getAddress();           // logs in if needed (call it from a click)
const { signedTxXdr, signerAddress } = await hana.stellar.signTransaction(xdr, {
  networkPassphrase, // optional: defaults to createHana({ stellar })
  address,           // optional: must be the user's address (4100 otherwise)
});
const { signedAuthEntry } = await hana.stellar.signAuthEntry(preimageXdr); // base64, 64 bytes
const { signedMessage } = await hana.stellar.signMessage('hello');        // SEP-53, approval every time
await hana.stellar.getNetwork();                                          // from createHana({ stellar })
```

You build, simulate and submit transactions yourself. Hana only signs. Fee-bump envelopes are signed as given.

**Stellar Wallets Kit** (1.9.x, which Sodax's `wallet-sdk-react` uses, and 2.x):

```ts
import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';

const kit = new StellarWalletsKit({ network, modules: [new HanaIdModule(hana), ...otherModules] });
```

The module's `productId` is `'hana-id'`. `isAvailable()` is true once the vault is up, `getAddress()` logs in when
needed (with the button fallback when SWK's own awaits cost the popup), `disconnect()` is `hana.logout()`. Errors are
SWK's `{code, message, ext}`, with `4001` for a rejection and the Hana code in `ext`. Hana only signs, so
`submit: true` is refused.

### EVM (EIP-1193)

`hana.ethereum` is an EIP-1193 provider, announced through EIP-6963 as "Hana ID" when you pass `evm` to
`createHana`:

```ts
// viem
const wallet = createWalletClient({ chain: baseSepolia, transport: custom(hana.ethereum) });
// ethers
const provider = new BrowserProvider(hana.ethereum);
// wagmi: the injected connector discovers it through EIP-6963 (name "Hana ID")
```

| Method | Behaviour |
|---|---|
| `eth_requestAccounts` | logs in if needed (from a click; the button fallback otherwise) |
| `eth_accounts` | `[address]` or `[]` |
| `eth_chainId`, `wallet_switchEthereumChain` | among `evm.chains`; another chain is `4902` |
| `eth_sendTransaction` | the SDK fills nonce, gas and fees from your RPC, the user approves, and the SDK broadcasts through the RPC of the chain it was filled on (even if the chain is switched during the approval). Sends run one at a time per chain, and a filled nonce is never below one past the last one this page broadcast, so back-to-back sends get consecutive nonces |
| `eth_signTransaction`, `personal_sign`, `eth_signTypedData_v4` | approval |
| `eth_sign` and other signing or wallet methods | `4200` |
| read-only methods (`eth_call`, `eth_getBalance`, …) | forwarded to the current chain's `rpcUrl` |

One key covers every EVM chain. Contract creation (an empty `to`) works with approval, but no policy ever
auto-approves it. Errors are `ProviderRpcError` with numeric codes. A sign-in that didn't complete is `4001`, and the
Hana code is in `error.data.code`. Logging out emits `accountsChanged []`, as wallets do.

### Raw signing

Off by default. With raw signing set to `'approval'` for your app:

```ts
await hana.signRaw({ chain: 'stellar', bytes });   // Ed25519 over ≤ 4 KiB → { signature } (64 bytes)
await hana.signRaw({ chain: 'evm', digest });      // secp256k1 over 32 bytes → { signature } (r‖s‖v, v ∈ {27, 28})
```

The user always approves raw requests, under a red warning that raw signing can authorize any transaction on that
chain. No policy ever covers them. Ask for it only if a standard method can't do the job. With raw signing off,
`signRaw` is `4100`.

## 9. Auto-approve policies

By default every signature needs the popup. An auto-approve policy lets matching requests be signed without one, for
example repeated deposits into your contract. It needs two opt-ins:

1. **You** set a policy for your app. It takes effect after the delay (24 h; 60 s on sandbox-dev).
2. **Each user** accepts that exact policy once, in a Hana popup that shows your app, your verified origin, the
   policy's label, every contract (with the name you gave it and its address), the functions, the address rule and
   the limits. A changed policy asks every user again.

Until both happen, matching requests simply get the normal popup. The vault, not your page, checks every request
against the policy, so an injected script on your page can do no more than the policy allows.

**How to request one.** Write the policy as JSON (below) and send it to Hana with your app's id or key. Hana runs it
through the same validator the vault uses (`admin app:settings <app> --auto-approve policy.json`), which lists any
problem and prints the `policyId` your users will accept. You can run the validator yourself first:

```ts
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
const r = validateAutoApprovePolicy(JSON.parse(text), { sessionTtlMs: 12 * 3_600_000 }); // { ok, policy } or { ok: false, problems }
```

Removing a policy (`--auto-approve off`) is immediate for new page loads. A tab that is already open re-reads the
policy in force (`GET /v1/app`) before an auto-sign whenever its last check is 10 s old or more, and every 60 s in the
background, so a removed or changed policy auto-signs nothing more within 10 s; if that re-read fails, the request
gets the popup. A changed policy is treated as no policy until the page reloads, and then needs the users' consent.

**Example** (validated against `@hana-id/core`; the addresses are placeholders):

```json
{
  "v": 1,
  "label": "Deposits on Example Vault",
  "maxConsentMs": 43200000,
  "limits": { "perDayCount": 20 },
  "stellar": {
    "networkPassphrases": ["Test SDF Network ; September 2015"],
    "maxFeeStroops": "200000",
    "contracts": [
      {
        "id": "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        "name": "Example Vault",
        "functions": [{ "name": "deposit" }, { "name": "withdraw", "addressArgs": "self-or-listed" }]
      },
      {
        "id": "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
        "name": "USDC",
        "functions": [{ "name": "approve" }]
      }
    ],
    "changeTrustAssets": ["USDC:GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"]
  },
  "evm": {
    "chains": [
      {
        "chainId": 84532,
        "maxValueWei": "50000000000000",
        "maxValueWeiPerDay": "1000000000000000",
        "maxFeeWei": "50000000000000",
        "contracts": [
          {
            "address": "0x1111111111111111111111111111111111111111",
            "name": "USDC",
            "selectors": [{ "selector": "0x095ea7b3", "signature": "approve(address,uint256)", "addressArgs": "self-or-listed" }]
          },
          {
            "address": "0x2222222222222222222222222222222222222222",
            "name": "Example Vault",
            "selectors": [
              { "selector": "0xb6b55f25", "signature": "deposit(uint256)" },
              { "selector": "0x00f714ce", "signature": "withdraw(uint256,address)", "addressArgs": "self-or-listed" }
            ]
          }
        ]
      }
    ]
  }
}
```

| Field | Rule |
|---|---|
| `label` | ≤ 80 characters, shown to the user |
| `maxConsentMs` | how long one acceptance lasts: 1 min up to your session limit (it also ends with the session, on logout, or when the user stops it) |
| `limits.perDayCount` | auto-signed requests per user per UTC day, 1 to 500, counted per device |
| `stellar.networkPassphrases`, `maxFeeStroops` | the networks, and the most fee one transaction may pay |
| `stellar.contracts[].functions[]` | Soroban functions by name; the whole authorization tree must stay inside listed contracts and functions |
| `stellar.changeTrustAssets` | `CODE:ISSUER`: `changeTrust` is the only classic operation a policy can cover |
| `evm.chains[]` | per `chainId`: `maxValueWei` per transaction and `maxValueWeiPerDay` of native spend, where spend is the value **plus the maximum fee** (gas limit × max fee per gas, or gas price); `maxFeeWei` caps the fee alone per transaction. So `maxValueWei` must be at least the fee your calls may pay even if they send no value (the example allows fees only: 20 calls at up to 0.00005 ETH) |
| `evm.chains[].contracts[].selectors[]` | the 4-byte `selector` and its canonical `signature`; calldata must decode against it |
| `evm.chains[].typedData` | `(verifyingContract, primaryType)` pairs for EIP-712 (permit-style signatures are never covered by default) |
| `addresses` (either chain) | extra addresses allowed as call arguments |

**The address rule.** With `addressArgs: 'self-or-listed'` (the default), every address argument, at any depth of the
Soroban call tree or the ABI-decoded calldata, must be the user's own address, a listed contract or an `addresses`
entry. That is what stops an injected script from sending funds or allowances to itself through an allowed
function. `'any'` must be set explicitly, and the user sees "can send to any address". The validator refuses
`'any'` on approve-, transfer-, send-, permit- and ownership-style functions, and on execute-style ones (`execute`,
`multicall`, `aggregate`, `call`, `batch…`, `delegatecall`, `upgradeTo` and the like), which run calls described in
their arguments. It also requires `addressArgs` on every EVM function that takes an address. Arguments where an
address could hide unseen (`bytes`, `string`, `bytes20`–`bytes32`, `uint160`/`int160`, at any depth of arrays and
tuples; on Stellar `Bytes`, `BytesN` and `String`) are never auto-approved under either rule: the validator refuses
such EVM functions, and the vault sends any Stellar call carrying them to the popup. They need a protocol decoder.
Note that 160-bit integers include Permit2's `uint160` amounts, so Permit2 `PermitSingle`/`PermitBatch` typed data
and calls with a `uint160` argument (Uniswap v3's `sqrtPriceLimitX96`) always get the popup. Wider integers
(`uint256`) are treated as amounts.

**Never covered, whatever the policy says:** raw signing, `personal_sign`, Stellar messages, EVM contract creation,
`eth_sign`, Stellar classic operations other than a listed `changeTrust`, fee-bump envelopes, and anything the
vault can't fully decode. **Not covered in the pilot:** calls whose instructions travel in opaque bytes, such as
routers, multicall, bridges and Sodax swaps (`AssetManager.transfer`, `sendMessage`). Those always get the popup until
a protocol decoder for them ships. Token amounts other than native value are not capped yet (Q39), so keep
`perDayCount` small.

Your page can use:

```ts
await hana.requestAutoApprove();   // opens the consent screen now → { granted, policyId?, expiresAtMs? }; 4100 without a policy
await hana.autoApproveStatus();    // { policyId, label, expiresAtMs, used: { count, native } } or null
await hana.revokeAutoApprove();    // the user can also stop it from any Hana popup
```

Without `requestAutoApprove()`, the first matching request shows the consent screen. A request that doesn't match
gets the normal popup, which tells the user why it wasn't auto-approved. After each auto-signed request the vault
emits `autoApproved` and its button briefly shows "Signed by Hana under {label}".

## 10. React

`@hana-id/react`:

```tsx
import { HanaProvider, useHana, useWallet } from '@hana-id/react';

<HanaProvider config={{ publishableKey: 'pk_test_…', environment: 'sandbox-dev', evm, stellar }}>
  <App />
</HanaProvider>;

function SignIn() {
  const { status, addresses, persistence, error, login, logout, exportKey } = useHana();
  return <button onClick={login}>Sign in</button>; // login must run in the onClick, with no await before it
}

const { address, signer } = useWallet('stellar'); // signer is hana.stellar
const { address, provider } = useWallet('evm');   // provider is hana.ethereum (EIP-1193)
```

- `HanaProvider` creates one client, also under strict mode, and destroys it on unmount. It reads `config` once; to
  switch app or environment, remount it (a `key`).
- A failed login (popup closed, `4001`, `popup_blocked`, `login_cancelled`) is in `useHana().error`. The promise
  `login()` returns is already marked handled, so `onClick={login}` never raises an unhandled rejection; if you
  `await` or `.catch` it, you still get the rejection. `logout()` and `exportKey()` reject as usual and their
  failures aren't in `error`: handle them (`onClick={() => logout().catch(report)}`).
- Server rendering (Next.js): the modules are `'use client'`, and the client is created in an effect, so a server
  render shows the initial state (`status: 'unlocking'`, no addresses, `signer` / `provider` null) and never touches
  `window`.
- React 18 and 19 are both supported (peer dependency `^18 || ^19`); the test suite runs on both, and the source
  typechecks against `@types/react` 18 and 19.

## 11. Sodax adapter

`@hana-id/sodax` (optional), typed against `@sodax/types` 2.1.0:

```ts
import { createSodaxEvmProvider, createSodaxStellarProvider } from '@hana-id/sodax';

const stellarProvider = createSodaxStellarProvider(hana, { networkPassphrase, horizonUrl, sorobanRpcUrl }); // IStellarWalletProvider
const evmProvider = createSodaxEvmProvider(hana, { chainId: 8453, rpcUrl });                              // IEvmWalletProvider, one per spoke chain
```

- The Stellar provider signs through `hana.stellar` (fee-bump allowed) and sends to Soroban RPC.
  `signAndSendTransaction(rawTx)` signs as `rawTx.from`: a transaction built for another account is refused (4100)
  before any popup. `waitForTransactionReceipt` polls Horizon every 2 s for 60 s.
- The EVM provider is bound to one chain, which must be in your `evm.chains` (it throws otherwise). It refuses a
  `from` other than the user's address, fills, gets the user's approval and broadcasts. Filling and broadcasting use
  the `evm.chains` RPC; `rpcUrl` is for receipts and must be the same chain: the provider checks its `eth_chainId`
  once, before the first transaction is signed, and refuses another chain with `4902` (`data.reason:
  'receipt_rpc_wrong_chain'`). If that RPC can't be reached for the check, the send fails with nothing signed
  (`-32603`, `receipt_rpc_unreachable`); the next send checks again.
- `waitForTransactionReceipt` (EVM) polls `rpcUrl` every 2 s for 180 s. RPC faults and receipts that don't parse
  are retried until the deadline, never reported as a failed transaction, since the transaction is already
  broadcast; only `receipt_timeout` ends it. The receipt is passed through leniently, as viem does (a null `type`,
  an unknown `status` or missing optional fields stay as the node sent them).
- A Sodax swap can need several signatures (`restoreFootprint`, a re-sign, a trustline). The approval popup's 15 s
  keep-open covers them in one session of clicks. Sodax swaps can't be auto-approved yet (see section 9).
- Sodax runs on mainnet only, while pilot keys are testnet-MPC keys: the adapter is tested against mocks of the
  `@sodax/sdk` 2.1.0 call patterns, not end to end. Don't move real funds with pilot wallets.

## 12. Test and live keys

| | `pk_test_…` | `pk_live_…` |
|---|---|---|
| Where | sandbox envs (testnet), the pilot | the production MVP (mainnet), after the audit; not issued yet |
| Loopback origins (`http://localhost:…`) | allowed, in `local*`/`sandbox*` envs only | never |
| Login result | carries per-stage `timings` (`hana.lastLogin.timings`) | no timings |
| Direct API calls from your page (`/v1/sessions`, `/v1/derive`) | only in sandbox envs, for test tooling such as `apps/smoke` | never |

A test app and a live app never share a scope. Your staging and production apps therefore give the same Google
account **different addresses** (Q37). Wallets made with test keys are disposable.

## 13. Errors

`hana.*` methods reject with a `HanaError {code, message, data?}`. The EIP-1193 provider maps string codes to numbers
(the Hana code stays in `data.code`), and the SWK module maps them to SWK's shape.

| Code | Meaning | What to do |
|---|---|---|
| `4001` | The user rejected, closed the popup, or let it time out | nothing; let them retry |
| `4100` | Not logged in, wrong address, or not allowed for this app (raw signing off, no policy) | log in, or check the call |
| `4200` | Unsupported method (`eth_sign`, …) | use a supported method |
| `4900` | The vault is gone (logged out, session ended, frame replaced) | create the client again, or log in |
| `4902` | EVM chain not in `evm.chains` | add it to `createHana` |
| `vault_unavailable` | The vault didn't load in 5 s | check `frame-src`, your origins, the network |
| `popup_blocked` | The browser blocked the popup and the sign-in was cancelled | call `login()` in a click |
| `coop_blocks_popup` | The popup closed before it connected (COOP `same-origin`, or the user closed it at once) | fix COOP |
| `login_timeout` | The popup never connected (15 s), or the sign-in took over 5 min | retry |
| `login_cancelled` | `cancelLogin()`, or a newer `login()` | nothing |
| `google_error` | Google returned an error (`data.error`) | retry; `access_denied` means the user declined |
| `no_google_client` | Your scope has no usable Google client | ask Hana |
| `token_invalid`, `token_has_pii` | The Google token failed Hana's checks | retry; report it if it persists |
| `config_mismatch` | Hana's pages disagree about the signer, scope or client | report it to Hana; never retry around it |
| `ckd_failed`, `derive_failed`, `pairing_failed`, `address_mismatch` | The key couldn't be produced | the user logs in again |
| `session_consumed` | Someone replayed the login transaction first | the vault offers "Continue signing in" |
| `rate_limited`, `app_suspended`, `origin_not_allowed`, `api_unavailable` | From Hana's API | back off, or contact Hana |
| `busy` | An export is already running | wait |

## 14. Security notes for integrators

- Your page never holds a key, a CKD secret or a Google token, and no message to it carries one. Don't try to get
  them; build on addresses and signatures.
- An XSS on your page can start a login, read addresses and queue signature requests. It can't sign anything without
  the user's Approve, except requests inside a policy the user accepted, up to its limits. Keep policies tight.
- A malicious browser extension can do anything the user can, including reading an exported key. No web wallet
  design prevents that.
- With your own Google client, your client's settings are part of your users' security ([section 6](#6-google-client-shared-or-your-own)).
- Testnet pilot keys are disposable. Until the address freeze, Hana may still change what a key derives from, and
  each such change gives every user new addresses.
