# @hana-id/react

React bindings for Hana ID (`@hana-id/web`): `HanaProvider`, `useHana` and `useWallet`. React 18 and 19.

## Install

The packages aren't on a registry yet. Hana sends you the tarballs; install them together, next to your React:

```sh
npm install ./hana-id-core-0.1.0.tgz ./hana-id-web-0.1.0.tgz ./hana-id-react-0.1.0.tgz
```

Peer dependency: `react` `^18.0.0 || ^19.0.0` (tested with 18.3.1 and 19.3.1). ESM only, with TypeScript
declarations.

## Use

```tsx
import { HanaProvider, useHana, useWallet } from '@hana-id/react';

const config = {
  publishableKey: 'pk_test_…', // from Hana
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
  return <button onClick={login}>Sign in</button>; // login must run in the onClick, with no await before it
}

const { address, signer } = useWallet('stellar'); // signer is hana.stellar
const { address, provider } = useWallet('evm');   // provider is hana.ethereum (EIP-1193)
```

- `HanaProvider` creates one client, also under strict mode, and destroys it on unmount. It reads `config` once; to
  switch app or environment, remount it (a `key`). A config `createHana` refuses (unknown environment, malformed
  key) throws from its render, to your error boundary.
- A failed login (`4001`, `popup_blocked`, `login_cancelled`, …) lands in `useHana().error`, and the promise
  `login()` returns is already marked handled, so `onClick={login}` never raises an unhandled rejection. `logout()`
  and `exportKey()` reject as usual: handle them.
- `useHana().client` is the underlying `HanaClient`, for what the hooks don't wrap (events, auto-approve,
  `revokeOtherDevices`).
- Server rendering (Next.js): the modules are `'use client'` and the client is created in an effect, so a server
  render shows the initial state (`status: 'unlocking'`, no addresses, `signer`/`provider` null) and never touches
  `window`.

Your page's requirements (origins, CSP `frame-src`, popups, COOP), test-network limits and error codes are in the
`@hana-id/web` README. Hana's partner guide (`docs/integration.md` in the private Hana ID repository; ask Hana for a
copy) has the rest.
