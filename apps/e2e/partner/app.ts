// The partner test app: what a partner page does with @hana-id/web, driven by the Playwright tests through
// `window.e2e`. It integrates the way the docs say: createHana once per page, login() synchronously in a click
// handler, hana.stellar / hana.ethereum through Stellar Wallets Kit (1.9.x and 2.x, with HanaIdModule), viem and wagmi.
//
// Query: `pk` (publishable key, required), `blockPopups=1` (window.open returns null, as a browser popup blocker does,
// so the SDK falls back to the vault's launcher), `env=local-e2e-live` (live mode, src/stack.ts: LIVE_ENV and its EVM
// RPC; the default is the e2e env). The page holds no secret: everything it sees is what any partner
// page sees.
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-base';
import { connect, createConfig, getConnectors, http, signMessage as wagmiSignMessage } from '@wagmi/core';
import { StellarWalletsKit as Kit1 } from 'swk1/stellar-wallets-kit.mjs';
import { StellarWalletsKit as Kit2 } from 'swk2/sdk';
import { createWalletClient, custom, defineChain, toHex, verifyMessage } from 'viem';
import { HanaError, createHana } from '@hana-id/web';
import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';
import { ENV_NAME, EVM_CHAIN_ID, EVM_RPC, LIVE_ENV_NAME, LIVE_EVM_RPC } from '../src/stack.ts';

const q = new URLSearchParams(location.search);
/** The browser's own window.open, for tests that open another window from the page (the foreign-site cases). */
const browserOpen = window.open.bind(window);
// Playwright's browsers never block popups; this is what a blocker does (Safari after an await, for example).
if (q.get('blockPopups') === '1') window.open = () => null;
const live = q.get('env') === LIVE_ENV_NAME;
const evmRpc = live ? LIVE_EVM_RPC : EVM_RPC;

const chain = defineChain({
  id: EVM_CHAIN_ID,
  name: 'E2E',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [evmRpc] } },
});
const PASSPHRASE = Networks.TESTNET;

const hana = createHana({
  publishableKey: q.get('pk') ?? '',
  environment: live ? LIVE_ENV_NAME : ENV_NAME,
  evm: { chains: [{ id: EVM_CHAIN_ID, rpcUrl: evmRpc }], defaultChainId: EVM_CHAIN_ID },
  stellar: { networkPassphrase: PASSPHRASE },
});

type Result = { state: 'pending' } | { state: 'ok'; value: unknown } | { state: 'error'; code: unknown; message: string };

const results: Record<string, Result> = {};
const events: { name: string; data: unknown }[] = [];
let ready: 'pending' | 'ok' | 'error' = 'pending';
let readyError: unknown = null;

hana.ready.then(
  () => {
    ready = 'ok';
  },
  (e: unknown) => {
    ready = 'error';
    readyError = e instanceof HanaError ? e.code : String(e);
  },
);
for (const name of ['statusChanged', 'accountsChanged', 'sessionExpired', 'disconnect', 'launcher', 'loginProgress'] as const) {
  hana.on(name, (...args: unknown[]) => events.push({ name, data: args[0] ?? null }));
}

/**
 * Errors as plain data (HanaError, ProviderRpcError and SWK's `{code, message}` all carry `code`), with the vault's
 * `data.reason` where there is one (`raw_sign_off`, `raw_not_allowed_for_test_apps`, …).
 */
function errorOf(e: unknown): { code: unknown; message: string; reason: unknown } {
  if (typeof e === 'object' && e !== null) {
    const o = e as { code?: unknown; message?: unknown; data?: unknown };
    const reason = typeof o.data === 'object' && o.data !== null ? ((o.data as { reason?: unknown }).reason ?? null) : null;
    return { code: o.code ?? null, message: String(o.message ?? e), reason };
  }
  return { code: null, message: String(e), reason: null };
}

/** Structured-clone-safe for page.evaluate: bytes become hex, bigints strings. */
function plain(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? toHex(x) : typeof x === 'bigint' ? x.toString() : x)) ?? 'null');
}

function track(name: string, start: () => Promise<unknown>): void {
  results[name] = { state: 'pending' };
  let p: Promise<unknown>;
  try {
    p = start();
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then(
    (value) => {
      results[name] = { state: 'ok', value: plain(value) };
    },
    (e: unknown) => {
      results[name] = { state: 'error', ...errorOf(e) };
    },
  );
}

// ---- Stellar ----

const OTHER_STELLAR = Keypair.random().publicKey();

/** A payment from the user's account: a real transaction the approval popup decodes. */
function paymentXdr(source: string): string {
  return new TransactionBuilder(new Account(source, '100'), { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: OTHER_STELLAR, asset: Asset.native(), amount: '1.5' }))
    .setTimeout(300)
    .build()
    .toXDR();
}

/** Whether `signedTxXdr` carries a valid signature by `address` over the transaction. */
function stellarSignedBy(signedTxXdr: string, address: string): boolean {
  const tx = TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE);
  const kp = Keypair.fromPublicKey(address);
  return tx.signatures.some((s) => kp.verify(tx.hash(), s.signature()));
}

const stellarAddress = (): string => {
  const a = hana.addresses?.stellar;
  if (!a) throw new Error('not logged in');
  return a;
};

// ---- Stellar Wallets Kit ----

const kit1 = new Kit1({ network: PASSPHRASE as never, selectedWalletId: 'hana-id', modules: [new HanaIdModule(hana) as never] });
Kit2.init({ network: PASSPHRASE as never, selectedWalletId: 'hana-id', modules: [new HanaIdModule(hana) as never] });

async function swkSign(kit: { signTransaction(xdr: string, o: { networkPassphrase: string; address: string }): Promise<{ signedTxXdr: string; signerAddress?: string }> }, address: string) {
  const r = await kit.signTransaction(paymentXdr(address), { networkPassphrase: PASSPHRASE, address });
  return { signerAddress: r.signerAddress, valid: stellarSignedBy(r.signedTxXdr, address) };
}

// ---- EVM: viem and wagmi ----

const wallet = createWalletClient({ chain, transport: custom(hana.ethereum) });
const wagmi = createConfig({ chains: [chain], transports: { [EVM_CHAIN_ID]: http(evmRpc) }, multiInjectedProviderDiscovery: true });

/** The connector wagmi discovered through EIP-6963. */
function hanaConnector() {
  const c = getConnectors(wagmi).find((x) => x.name === 'Hana ID');
  if (!c) throw new Error('wagmi did not discover Hana ID (EIP-6963)');
  return c;
}

const actions: Record<string, (...args: never[]) => Promise<unknown>> = {
  login: () => hana.login(),
  logout: () => hana.logout(),
  cancelLogin: async () => hana.cancelLogin(),
  exportKey: (chainName: 'stellar' | 'evm') => hana.exportKey(chainName),
  revokeOtherDevices: () => hana.revokeOtherDevices(),
  requestAutoApprove: () => hana.requestAutoApprove(),
  signRaw: (params: Parameters<typeof hana.signRaw>[0]) => hana.signRaw(params),
  stellarSignMessage: (message: string) => hana.stellar.signMessage(message),
  stellarSignTx: async () => {
    const address = stellarAddress();
    const r = await hana.stellar.signTransaction(paymentXdr(address));
    return { signerAddress: r.signerAddress, valid: stellarSignedBy(r.signedTxXdr, address) };
  },
  ethRequestAccounts: () => hana.ethereum.request({ method: 'eth_requestAccounts' }),
  personalSign: async (message: string) => {
    const address = hana.addresses?.evm as `0x${string}`;
    const signature = (await hana.ethereum.request({ method: 'personal_sign', params: [toHex(message), address] })) as `0x${string}`;
    return { signature, valid: await verifyMessage({ address, message, signature }) };
  },
  viemSignMessage: async (message: string) => {
    const [account] = await wallet.requestAddresses();
    const signature = await wallet.signMessage({ account: account as `0x${string}`, message });
    return { account, valid: await verifyMessage({ address: account as `0x${string}`, message, signature }) };
  },
  viemSendTx: async () => {
    const [account] = await wallet.requestAddresses();
    const hash = await wallet.sendTransaction({ account: account as `0x${string}`, to: '0x000000000000000000000000000000000000dEaD', value: 1000n, chain });
    return { account, hash };
  },
  wagmiConnect: async () => {
    const r = await connect(wagmi, { connector: hanaConnector() });
    return { accounts: r.accounts, chainId: r.chainId };
  },
  wagmiSignMessage: async (message: string) => {
    const signature = await wagmiSignMessage(wagmi, { message });
    const address = hana.addresses?.evm as `0x${string}`;
    return { valid: await verifyMessage({ address, message, signature }) };
  },
  swk1Connect: () => kit1.getAddress(),
  swk1SignTx: () => swkSign(kit1, stellarAddress()),
  swk2Connect: () => Kit2.fetchAddress(),
  swk2SignTx: () => swkSign(Kit2, stellarAddress()),
};

let armed: (() => void) | null = null;
document.getElementById('act')?.addEventListener('click', () => {
  const a = armed;
  armed = null;
  a?.();
});

const run = (name: string, action: string, args: unknown[]) => {
  const fn = actions[action];
  if (!fn) throw new Error(`unknown action ${action}`);
  track(name, () => (fn as (...a: unknown[]) => Promise<unknown>)(...args));
};

const e2e = {
  hana,
  results,
  events,
  get ready() {
    return ready;
  },
  get readyError() {
    return readyError;
  },
  status: () => hana.status,
  addresses: () => hana.addresses,
  persistence: () => hana.persistence,
  warning: () => hana.warning,
  /** The next click on #act runs `action` synchronously inside the click handler (user activation). */
  arm(name: string, action: string, ...args: unknown[]) {
    armed = () => run(name, action, args);
  },
  /** Runs `action` now (no user gesture). */
  run(name: string, action: string, ...args: unknown[]) {
    run(name, action, args);
  },
  /** The vault iframe, made invisible (opacity 0) by the page: the clickjacking case. */
  hideLauncher() {
    const f = document.querySelector<HTMLIFrameElement>('iframe[name^="hana-vault-"]');
    f?.style.setProperty('opacity', '0');
  },
  /** An invisible element on top of the launcher that takes the clicks. */
  coverLauncher() {
    const d = document.createElement('div');
    d.id = 'cover';
    for (const [k, v] of Object.entries({ position: 'fixed', right: '0', bottom: '0', width: '400px', height: '120px', opacity: '0', 'z-index': '2147483647', background: 'red' })) d.style.setProperty(k, v);
    document.body.append(d);
  },
  /** Opens another window from this page (it gets this page as its opener), whatever `blockPopups` says. */
  openWindow(url: string): boolean {
    return browserOpen(url, '_blank') !== null;
  },
  /** The vault iframe's window name (the login popup looks the vault up by it). */
  vaultFrameName: () => document.querySelector<HTMLIFrameElement>('iframe[name^="hana-vault-"]')?.name ?? null,
};

(window as unknown as { e2e: typeof e2e }).e2e = e2e;
