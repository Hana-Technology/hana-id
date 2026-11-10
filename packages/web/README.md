# @hana-id/web

Hana ID's browser SDK. Your users sign in with Google and get a Stellar and an EVM wallet, with no extension or seed
phrase. You sign through standard interfaces: an EIP-1193 provider, a Stellar signer and a Stellar Wallets Kit module.
Keys and Google tokens never reach your page. They stay in a hidden Hana iframe, and every signature needs the user's
Approve in a Hana popup, unless it falls under an auto-approve policy you set and the user accepted.

> **Testnet pilot.** Keys come from the NEAR testnet MPC and are disposable until Hana's address freeze. A test app
> (`pk_test_…`) signs for test networks only. Don't keep real funds in pilot wallets.
>
> NEAR is Hana's own chain (it derives the keys and records the logins): your users get Stellar and EVM wallets, and
> your app never talks to NEAR.

## Install

The packages aren't on a registry yet. Hana sends you the tarballs with their SHA-256 checksums: check them, then
install them together (`@hana-id/core` too, from its tarball, never from a registry):

```sh
npm install ./hana-id-core-0.3.0.tgz ./hana-id-web-0.3.0.tgz
```

ESM only, with TypeScript declarations. Use a bundler (Vite, webpack, esbuild, Next.js) or TypeScript with
`moduleResolution` `bundler`, `node16` or `nodenext`.

## Before you start

During the pilot Hana creates your app (send Hana the app name users will see, your first origins, whether you use
Hana's shared Google client or your own, the Google address of each person who manages it, and a security contact).
Those people accept their invite email first (**Sign in with Google**): their Google accounts become your scope's
on-chain owners, the only ones who can add origins or set a policy. You then manage the app in Hana's **partner
portal** (sandbox-dev: `https://hana-id-console-sandbox-dev.tingtc.workers.dev`). On your app's page:

- the header shows the **Publishable key** (`pk_test_…`, public: ship it in your page) and the **App ID** (`app_…`,
  for your backend's identity-token check), each with a Copy button;
- **Origins** lists the exact origins (scheme, host and port, no path; at most 20) your page may run on. An added
  origin takes effect after it is announced to your security contacts and a delay (60 s on sandbox-dev, 24 h in
  production; `http://localhost:<port>` on a test app as soon as it is announced), and you can cancel it until then;
  removing one is immediate;
- **Keys**, **Login & sessions**, **Signing**, **Branding** and **Suspend** hold the rest; **Members** invites your
  team.

Hana's partner guide describes every screen.

## Use

```ts
import { createHana } from '@hana-id/web';

const hana = createHana({
  publishableKey: 'pk_test_…',
  environment: 'sandbox-dev',
  evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 }, // optional
  stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },                         // optional
});

await hana.ready;  // the vault is up; a reload has already been restored
hana.status;       // 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error'
hana.addresses;    // { stellar: 'G…', evm: '0x…' } or null

button.addEventListener('click', async () => {
  const { stellar, evm } = await hana.login(); // call it directly in the click handler, before any await
});
await hana.logout();
```

Create one client per page and keep it; `hana.destroy()` removes it.

### Environments

`environment` names a Hana deployment. Its Hana origins, NEAR accounts, RPC and pinned MPC key are built into this
package, so no configuration can point the client at another vault. `HANA_ENVIRONMENTS` lists the names this build
knows. This release ships:

| `environment` | Hana runs on | Vault origin | Auth origin |
|---|---|---|---|
| `sandbox-dev` | NEAR testnet (Hana's side only: your users' wallets are Stellar and EVM) | `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` | `https://hana-id-auth-sandbox-dev.tingtc.workers.dev` |

### Signing

```ts
// EVM: an EIP-1193 provider (EIP-6963 name "Hana ID")
const wallet = createWalletClient({ chain: baseSepolia, transport: custom(hana.ethereum) }); // viem
const provider = new BrowserProvider(hana.ethereum);                                       // ethers

// Stellar
const { address } = await hana.stellar.getAddress();
const { signedTxXdr } = await hana.stellar.signTransaction(xdr, { networkPassphrase });

// Stellar Wallets Kit (1.9.x and 2.x)
import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';
const kit = new StellarWalletsKit({ network, modules: [new HanaIdModule(hana), ...otherModules] });
```

Call the signing methods directly in your click handler, before any `await`: the Hana approval popup opens in that
click, as `login()` does, and the user approves there; the popup decodes the request itself. Without a click (or
when Safari blocks the popup after an `await`) the vault shows a "Review in Hana" button that opens the same popup.
`hana.prepareApproval()` opens it early for a handler that must await something first. You build, simulate and submit transactions; Hana only signs (`eth_sendTransaction` fills and
broadcasts through your `evm.chains` RPC).

### Sign-in methods (apps with email)

Google and email with the same verified address open the same wallet; Hana's popup handles every case. Show pending
methods to the user, with a way to sign in and cancel:

```ts
const { methods } = await hana.account(); // [{ provider: 'google' | 'email', status: 'active' | 'pending', effectiveAtMs, root }]
hana.on('linkChanged', ({ provider, status, effectiveAtMs }) => { /* 'pending' | 'active' | 'removed' */ });
button.onclick = () => hana.linkAccount({ method: 'email' }); // in a click; pending for 24 h, then it opens the wallet
```

### Identity token (for your backend)

```ts
const token = await hana.getIdentityToken(); // ES256 JWT, or null while logged out; no popup, call it anywhere
await fetch('/api/session', { headers: { authorization: `Bearer ${token}` } });
hana.on('identityTokenChanged', (t) => { /* a fresh token, or null after logout or expiry */ });
```

Your backend verifies it against Hana's JWKS (`{iss}/jwks.json`) with any JOSE library, pinned to ES256, checking
`iss`, `aud` (your app id) and `typ: hana-identity+jwt`. It says who the user is in your app (`sub`), which session
this is (`sid`) and which wallets they hold (`wallets`, each proven by its key). Lifetime ≤ 1 h; the SDK caches it
across tabs and refreshes it 5 min before `exp` (`{ maxAgeMs }` for a fresher one). Hana's partner guide has the
verification code.

### Email sharing (0.3.0)

```ts
// In a click handler, synchronously (it opens Hana's window, like login()).
const state = await hana.requestEmailSharing(); // 'granted' | 'declined' | 'dismissed'
hana.on('emailSharingChanged', (s) => { /* 'granted' or 'declined': get a new identity token */ });
```

You see a user's email only after they share it with your app on Hana's sheet (your app's name and their exact
address). Your app's email sharing setting says when Hana asks: off (default), only from `requestEmailSharing()`, or
once at the first login. Once shared, identity tokens carry `email` and `email_verified: true`. The user can stop
sharing on the same sheet or in the approval window; new tokens then have no email. Rejects with
`email_sharing_unavailable` (`data.reason`: `off`, `no_address`, `unavailable`).

## Your page must

| Requirement | If not |
|---|---|
| Run on one of your app's origins, exactly (pin your dev server's port: Vite `server: { strictPort: true }`) | `vault_unavailable` (`no_answer`, naming the page's origin) |
| Allow the vault origin in CSP `frame-src` | `vault_unavailable` |
| Allow your own EVM / Stellar RPCs in CSP `connect-src` | your RPC calls fail |
| Call `login()` and `eth_requestAccounts` from a click | one extra click (Hana's fallback button) |
| Not send `Cross-Origin-Opener-Policy: same-origin` | `coop_blocks_popup` |
| Leave Hana's 320×72 px button (bottom right) uncovered | users can't approve |

Not supported: Google Identity Services (One Tap, the Sign in with Google button) on the same page, and in-app
browsers (Instagram, TikTok webviews), where Google refuses to sign in.

## Test keys

A `pk_test_…` app signs only for test networks: any Stellar network but the public one, and the EVM testnets in
`TEST_EVM_CHAINS` (Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Sonic testnets, BNB testnet, Amoy, Fuji,
Holesky, Hoodi, local 31337/1337). Anything a mainnet would accept is refused with `4100`
(`data.reason: 'mainnet_not_allowed'`) before any popup. Raw signing is never available to test apps.

Hana's own sandbox mainnet demo (not available to partner apps) shows on the client as `hana.mainnetDemo` (its rules
and the prices it values with, `null` when off or not known yet) and `hana.mainnetDemoKnown` (true once `hana.ready`
resolved, so a null then means off); `mainnetDemoChanged` tells you when either changes. See the partner guide's
section 12.

## Errors

Methods reject with `HanaError { code, message, data? }`; the EIP-1193 provider uses `ProviderRpcError` with numeric
codes (the Hana code in `data.code`). An error from Hana's API carries its request ID (`error.requestId`,
`data.requestId`): send it to Hana with the user's Support ID (`hana.supportId`) when you report a problem. The common ones: `4001` the user rejected or closed the popup; `4100` not
logged in or not allowed (`data.reason`); `4900` the vault is gone; `4902` chain not in `evm.chains`;
`vault_unavailable` (`data.reason`; `no_answer` when the page's origin isn't one of your app's origins), `popup_blocked`,
`login_timeout`, `rate_limited`.

## More

Hana's partner guide (ask Hana for the current copy) covers the partner portal, events, sessions, key export,
auto-approve policies, your own Google client, the identity token's verification and every error code. React bindings:
`@hana-id/react`. Sodax wallet providers: `@hana-id/sodax`.
