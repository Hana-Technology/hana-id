# @hana-id/react

React bindings for Hana ID (`@hana-id/web`): `HanaProvider`, `useHana` and `useWallet`. React 18 and 19.

## Install

The packages aren't on a registry yet. Hana sends you the tarballs with their SHA-256 checksums: check them, then
install them together, next to your React:

```sh
npm install ./hana-id-core-0.2.1.tgz ./hana-id-web-0.2.1.tgz ./hana-id-react-0.2.1.tgz
```

Peer dependency: `react` `^18.0.0 || ^19.0.0` (tested with 18.3.1 and 19.3.1). ESM only, with TypeScript
declarations.

## Use

```tsx
import { HanaProvider, useHana, useIdentityToken, useMainnetDemo, useWallet } from '@hana-id/react';

const config = {
  publishableKey: 'pk_test_…', // your app's page in Hana's partner portal (header: Publishable key)
  environment: 'sandbox-dev',  // a Hana deployment built into @hana-id/web (HANA_ENVIRONMENTS)
  evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 }, // optional
  stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },                         // optional
};

export function Root() {
  return (
    <HanaProvider config={config}>
      <App />
    </HanaProvider>
  );
}

function SignIn() {
  const { status, addresses, error, login, logout, exportKey } = useHana();
  // login must run in the onClick, with no await before it; it takes hana.login()'s options
  return (
    <>
      <button onClick={login}>Sign in</button>
      <button onClick={() => login({ method: 'email' })}>Continue with email</button>
    </>
  );
}

const { address, signer } = useWallet('stellar'); // signer is hana.stellar
const { address, provider } = useWallet('evm');   // provider is hana.ethereum (EIP-1193)
const { identityToken, refresh, error } = useIdentityToken(); // a JWT for your backend, kept fresh while visible
const { demo, known } = useMainnetDemo();                     // Hana's sandbox mainnet demo: off, not known yet, or on
```

- `HanaProvider` creates one client, also under strict mode, and destroys it on unmount. It reads `config` once; to
  switch app or environment, remount it (a `key`). A config `createHana` refuses (unknown environment, malformed
  key) throws from its render, to your error boundary.
- `login(options)` passes `{ method: 'google' | 'email', emailHint }` to `hana.login()`; the event `onClick={login}`
  passes is ignored (SDK releases after 0.2.0; 0.2.0's `login` ignores every argument, so use
  `useHana().client.login({ method })` there).
- A failed login (`4001`, `popup_blocked`, `login_cancelled`, …) lands in `useHana().error` (a `HanaError`; one from
  Hana's API has `error.requestId`, to send Hana with `useHana().supportId`), and the promise
  `login()` returns is already marked handled, so `onClick={login}` never raises an unhandled rejection. `logout()`
  and `exportKey()` reject as usual: handle them.
- `useHana().client` is the underlying `HanaClient`, for what the hooks don't wrap (events, auto-approve,
  `revokeOtherDevices`).
- `useMainnetDemo()` returns `{ demo, known }` for Hana's own sandbox mainnet demo (not available to partner apps):
  `demo` is `hana.mainnetDemo` (its rules and the prices it values with, `demo.prices.assets.ETH.usd` …) or null, and
  `known` is false until the client is ready, so `known && !demo` means off and `!known` means not known yet.
- Server rendering (Next.js): the modules are `'use client'` and the client is created in an effect, so a server
  render shows the initial state (`status: 'unlocking'`, no addresses, `signer`/`provider` null) and never touches
  `window`.

Your page's requirements (origins, CSP `frame-src`, popups, COOP), test-network limits and error codes are in the
`@hana-id/web` README. Hana's partner guide (ask Hana for the current copy) has the rest, the partner portal included.
