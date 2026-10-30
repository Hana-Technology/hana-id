# @hana-id/web

Hana ID's browser SDK. Your users sign in with Google and get a Stellar and an EVM wallet, with no extension or seed
phrase. You sign through standard interfaces: an EIP-1193 provider, a Stellar signer and a Stellar Wallets Kit module.
Keys and Google tokens never reach your page. They stay in a hidden Hana iframe, and every signature needs the user's
Approve in a Hana popup, unless it falls under an auto-approve policy you set and the user accepted.

> **Testnet pilot.** Keys come from the NEAR testnet MPC and are disposable until Hana's address freeze. A test app
> (`pk_test_…`) signs for test networks only. Don't keep real funds in pilot wallets.

## Install

The packages aren't on a registry yet. Hana sends you the tarballs; install them together:

```sh
npm install ./hana-id-core-0.1.0.tgz ./hana-id-web-0.1.0.tgz
```

ESM only, with TypeScript declarations. Use a bundler (Vite, webpack, esbuild, Next.js) or TypeScript with
`moduleResolution` `bundler`, `node16` or `nodenext`.

## Before you start

Hana registers your app and gives you a **publishable key** (`pk_test_…`, public: ship it in your page). Send Hana
the app name users will see, every origin your app runs on (exact origins such as `https://app.example.com`, at most
20; `http://localhost:<port>` works for test keys), and whether you use Hana's shared Google client (the default, no
setup on your side) or your own.

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

| `environment` | Network | Vault origin | Auth origin |
|---|---|---|---|
| `sandbox-dev` | NEAR testnet | `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` | `https://hana-id-auth-sandbox-dev.tingtc.workers.dev` |

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

## Your page must

| Requirement | If not |
|---|---|
| Run on one of your app's origins, exactly | `vault_unavailable` |
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

## Errors

Methods reject with `HanaError { code, message, data? }`; the EIP-1193 provider uses `ProviderRpcError` with numeric
codes (the Hana code in `data.code`). The common ones: `4001` the user rejected or closed the popup; `4100` not
logged in or not allowed (`data.reason`); `4900` the vault is gone; `4902` chain not in `evm.chains`;
`vault_unavailable`, `popup_blocked`, `login_timeout`, `rate_limited`.

## More

Hana's partner guide (`docs/integration.md` in the private Hana ID repository; ask Hana for a copy) covers events,
sessions, key export, auto-approve policies, your own Google client and every error code. React bindings:
`@hana-id/react`. Sodax wallet providers: `@hana-id/sodax`.
