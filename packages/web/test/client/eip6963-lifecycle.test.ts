// @vitest-environment happy-dom
// Turning the wallet off and on in one page (D936): one EIP-6963 announcement per page and wallet slot, its uuid and
// provider kept across destroy() and createHana, so the real mipd store and real wagmi keep exactly one "Journear
// Passport" entry, and it works with the live client; distinct announcements for clients alive at once; a uuid that
// lives in memory for the page only; and a destroyed client's hana.ethereum that is disconnected for good and lets go.
import { connect, createConfig, disconnect, getAccount, getConnectors, http } from '@wagmi/core';
import { type EIP6963ProviderDetail, createStore } from 'mipd';
import { sepolia } from 'viem/chains';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRpcError } from '../../src/client/errors.ts';
import { type EthereumHost, HanaEthereumProvider, announceEip6963, rdnsFor } from '../../src/client/ethereum.ts';
import { EVM, LOGGED_IN, ORIGINS, type Setup, flush, rpcFetch, setup } from './harness.ts';

const SEPOLIA = 11155111;
const EVM_CONFIG = { chains: [{ id: SEPOLIA, rpcUrl: 'https://sepolia.rpc.test' }], defaultChainId: SEPOLIA };
const RDNS = rdnsFor(ORIGINS.authOrigin);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

let alive: Setup[] = [];
let announced: EIP6963ProviderDetail[];
const onAnnounce = (e: Event) => announced.push((e as CustomEvent<EIP6963ProviderDetail>).detail);
beforeEach(() => {
  announced = [];
  window.addEventListener('eip6963:announceProvider', onAnnounce);
});
afterEach(() => {
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  for (const s of alive) s.client.destroy();
  alive = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A client with `evm`, its vault answering eth_accounts as the logged-in user. */
function client(): Setup {
  const s = setup({ config: { evm: EVM_CONFIG }, fetch: rpcFetch({ eth_blockNumber: '0x10' }) });
  s.vault.handle('eth_accounts', () => ({ result: [EVM] }));
  alive.push(s);
  return s;
}

async function refused(p: Promise<unknown>, code: number): Promise<ProviderRpcError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ProviderRpcError);
  expect((e as ProviderRpcError).code).toBe(code);
  return e as ProviderRpcError;
}

/** A host whose every part fails the test if the provider reaches it. */
function strictHost(): EthereumHost & { calls: string[] } {
  const calls: string[] = [];
  const touch = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error(`host.${name} reached`));
  };
  return {
    calls,
    evmAddress: () => {
      calls.push('evmAddress');
      return EVM;
    },
    login: touch('login') as EthereumHost['login'],
    request: touch('request') as EthereumHost['request'],
    fetch: touch('fetch') as EthereumHost['fetch'],
  };
}

describe('one announcement per page and wallet slot', () => {
  it('create → destroy → create ×3: the same detail object, uuid and provider each time, and it forwards to the live client', async () => {
    const first = client();
    await first.vault.connect(LOGGED_IN);
    const detail = first.client.eip6963!;
    expect(detail.info.uuid).toMatch(UUID_V4);
    expect(detail.info.rdns).toBe(RDNS);
    expect(Object.isFrozen(detail) && Object.isFrozen(detail.info)).toBe(true);
    first.client.destroy();
    for (let i = 0; i < 3; i++) {
      const next = client();
      expect(next.client.eip6963).toBe(detail);
      await next.vault.connect(LOGGED_IN);
      expect(await detail.provider.request({ method: 'eth_accounts' })).toEqual([EVM]);
      expect(next.vault.seen('eth_accounts')).toHaveLength(1);
      next.client.destroy();
      await refused(detail.provider.request({ method: 'eth_chainId' }), 4900);
    }
    expect(new Set(announced.map((d) => d.info.uuid))).toEqual(new Set([detail.info.uuid]));
    expect(announced.every((d) => d === detail)).toBe(true);
  });

  it('the announced provider carries the live client events, and none from a destroyed one', async () => {
    const a = client();
    const p = a.client.eip6963!.provider;
    const seen: unknown[] = [];
    p.on('connect', (c) => seen.push(['connect', c]));
    p.on('accountsChanged', (x) => seen.push(['accountsChanged', x]));
    p.on('disconnect', (e) => seen.push(['disconnect', e.code]));
    await a.vault.connect(LOGGED_IN);
    a.client.destroy();
    expect(seen).toEqual([
      ['accountsChanged', [EVM]],
      ['connect', { chainId: '0xaa36a7' }],
      ['accountsChanged', []],
      ['disconnect', 4900],
    ]);
    seen.length = 0;
    a.vault.emit('accountsChanged', { addresses: null });
    await flush();
    expect(seen).toEqual([]);
    const b = client();
    await b.vault.connect(LOGGED_IN);
    expect(seen).toEqual([
      ['accountsChanged', [EVM]],
      ['connect', { chainId: '0xaa36a7' }],
    ]);
    expect(p.chainId).toBe('0xaa36a7');
    expect(p.chainIds).toEqual([SEPOLIA]);
  });

  it('clients alive at once get distinct announcements; a freed slot goes to the next client', () => {
    const host = strictHost();
    const provider = () => new HanaEthereumProvider(host, EVM_CONFIG);
    const a = announceEip6963(window, provider(), RDNS);
    const b = announceEip6963(window, provider(), RDNS);
    const other = announceEip6963(window, provider(), 'example.other.auth');
    expect(new Set([a.detail.info.uuid, b.detail.info.uuid, other.detail.info.uuid]).size).toBe(3);
    expect(new Set([a.detail.provider, b.detail.provider, other.detail.provider]).size).toBe(3);
    expect(other.detail.info.rdns).toBe('example.other.auth');
    a.stop();
    const c = announceEip6963(window, provider(), RDNS);
    expect(c.detail).toBe(a.detail);
    // Every slot held: a new one.
    const d = announceEip6963(window, provider(), RDNS);
    expect([a.detail, b.detail]).not.toContain(d.detail);
    // Another environment never takes this one's slot.
    other.stop();
    const e = announceEip6963(window, provider(), RDNS);
    expect(e.detail).not.toBe(other.detail);
    for (const x of [b, c, d, e]) x.stop();
    expect(host.calls).toEqual([]);
  });

  it('React StrictMode-style mount, unmount, mount: one announcement', () => {
    const a = client();
    a.client.destroy();
    const b = client();
    expect(b.client.eip6963).toBe(a.client.eip6963);
    expect(new Set(announced.map((d) => d.info.uuid)).size).toBe(1);
  });
});

describe('the uuid is per page, in memory only', () => {
  it('another page (window) or a page load (a fresh module) gets a fresh random uuid; nothing is stored', async () => {
    const host = strictHost();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const here = announceEip6963(window, new HanaEthereumProvider(host, EVM_CONFIG), RDNS);
    const otherPage = new HappyWindow({ url: 'https://partner.example/' }) as unknown as Window;
    const there = announceEip6963(otherPage, new HanaEthereumProvider(host, EVM_CONFIG), RDNS);
    vi.resetModules();
    const reloaded = (await import('../../src/client/ethereum.ts')) as typeof import('../../src/client/ethereum.ts');
    const afterLoad = reloaded.announceEip6963(window, new reloaded.HanaEthereumProvider(host, EVM_CONFIG), RDNS);
    const uuids = [here.detail.info.uuid, there.detail.info.uuid, afterLoad.detail.info.uuid];
    for (const u of uuids) expect(u).toMatch(UUID_V4);
    expect(new Set(uuids).size).toBe(3);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    for (const x of [here, there, afterLoad]) x.stop();
    await (otherPage as unknown as HappyWindow).happyDOM.close();
  });
});

describe('after destroy()', () => {
  it('hana.ethereum emits accountsChanged [] and disconnect 4900 once, then rejects every method with 4900 and keeps no listener', async () => {
    const s = client();
    await s.vault.connect(LOGGED_IN);
    const eth = s.client.ethereum;
    const seen: unknown[] = [];
    eth.on('accountsChanged', (x) => seen.push(['accountsChanged', x]));
    eth.on('disconnect', (e) => seen.push(['disconnect', e.code, e instanceof ProviderRpcError]));
    eth.on('chainChanged', (c) => seen.push(['chainChanged', c]));
    const destroyed = vi.fn();
    s.client.on('destroyed', destroyed);
    expect(s.client.destroyed).toBe(false);
    s.client.destroy();
    s.client.destroy();
    expect(seen).toEqual([
      ['accountsChanged', []],
      ['disconnect', 4900, true],
    ]);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(s.client.destroyed).toBe(true);
    for (const e of ['connect', 'disconnect', 'chainChanged', 'accountsChanged'] as const) expect(eth.listenerCount(e)).toBe(0);
    const requests = s.vault.requests.length;
    for (const method of ['eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_blockNumber', 'eth_sendRawTransaction', 'personal_sign', 'wallet_switchEthereumChain', 'eth_sign']) {
      await refused(eth.request({ method, params: [] }), 4900);
    }
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.vault.requests).toHaveLength(requests);
    expect(document.querySelector('iframe')).toBeNull();
    // It no longer answers requestProvider; its announced provider is disconnected until a new client takes it.
    announced = [];
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced).toEqual([]);
    await refused(s.client.eip6963!.provider.request({ method: 'eth_accounts' }), 4900);
    expect(seen).toHaveLength(2);
  });

  it('a provider that never connected says only what changed (no disconnect), and one whose vault died says disconnect once', async () => {
    const never = client();
    const quiet = vi.fn();
    never.client.ethereum.on('disconnect', quiet);
    never.client.ethereum.on('accountsChanged', quiet);
    never.client.destroy();
    expect(quiet).not.toHaveBeenCalled();

    const died = client();
    await died.vault.connect(LOGGED_IN);
    const disconnects = vi.fn();
    died.client.ethereum.on('disconnect', disconnects);
    // A second load: the vault document was replaced, so the connection is gone (and said so).
    died.vault.load();
    await flush();
    died.client.destroy();
    expect(disconnects).toHaveBeenCalledTimes(1);
  });

  it('a retired provider never reaches its client again: it holds a dead host, so nothing of the client stays alive through it', async () => {
    const host = strictHost();
    const eth = new HanaEthereumProvider(host, EVM_CONFIG);
    eth.connected();
    eth.retire();
    host.calls.length = 0;
    for (const method of ['eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_call', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus']) {
      await refused(eth.request({ method, params: [] }), 4900);
    }
    eth.connected();
    eth.accountsChanged(EVM);
    eth.disconnected();
    expect(host.calls).toEqual([]);
    expect(eth.chainIds).toEqual([SEPOLIA]);
  });

  it('a host that never destroys sees no change: the announced provider answers as hana.ethereum does', async () => {
    const s = client();
    await s.vault.connect(LOGGED_IN);
    const p = s.client.eip6963!.provider;
    expect(await p.request({ method: 'eth_chainId' })).toBe(await s.client.ethereum.request({ method: 'eth_chainId' }));
    expect(await p.request({ method: 'eth_requestAccounts' })).toEqual([EVM]);
    expect(await p.request({ method: 'eth_blockNumber' })).toBe('0x10');
    await refused(p.request({ method: 'eth_sign', params: [] }), 4200);
    expect(p.isHanaId).toBe(true);
  });
});

describe('real wallet lists', () => {
  it("mipd's store: create → destroy → create ×3 leaves one entry, pointing at the live client", async () => {
    const store = createStore();
    try {
      for (let i = 0; i < 3; i++) {
        const s = client();
        await s.vault.connect(LOGGED_IN);
        const ours = store.getProviders().filter((d) => d.info.rdns === RDNS);
        expect(ours).toHaveLength(1);
        expect(ours[0]).toBe(s.client.eip6963);
        expect(await ours[0]!.provider.request({ method: 'eth_accounts' })).toEqual([EVM]);
        s.client.destroy();
      }
      // A store created later (another library) or reset asks again, and sees the one entry only while a client lives.
      store.reset();
      expect(store.getProviders().filter((d) => d.info.rdns === RDNS)).toHaveLength(0);
      const live = client();
      store.reset();
      expect(store.getProviders().filter((d) => d.info.rdns === RDNS)).toEqual([live.client.eip6963]);
    } finally {
      store.destroy();
    }
  });

  it("mipd's store: StrictMode's create, destroy, create in one go leaves one entry", async () => {
    const store = createStore();
    try {
      client().client.destroy();
      const s = client();
      await s.vault.connect(LOGGED_IN);
      const ours = store.getProviders().filter((d) => d.info.rdns === RDNS);
      expect(ours).toHaveLength(1);
      expect(await ours[0]!.provider.request({ method: 'eth_accounts' })).toEqual([EVM]);
    } finally {
      store.destroy();
    }
  });

  it('wagmi: off and on three times, one Journear Passport connector, connected to the live client, with no store reset or connector removal', async () => {
    const config = createConfig({ chains: [sepolia], transports: { [sepolia.id]: http('https://sepolia.rpc.test') }, storage: null });
    const ours = () => getConnectors(config).filter((c) => c.name === 'Journear Passport');
    let first: unknown;
    for (let i = 0; i < 3; i++) {
      const s = client();
      await s.vault.connect(LOGGED_IN);
      await flush();
      expect(ours()).toHaveLength(1);
      const connector = ours()[0]!;
      first ??= connector;
      expect(connector).toBe(first);
      // wagmi's id for an EIP-6963 wallet is its rdns: what a host matches to hide the entry while the wallet is off.
      expect(connector.id).toBe(s.client.eip6963!.info.rdns);
      expect(await connector.getProvider()).toBe(s.client.eip6963!.provider);
      // The vault restored the session, and its accountsChanged reached wagmi through the same connector: wagmi
      // connects on its own, as it does for an unlocked extension. (Each time, so also after a destroy().)
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: EVM, chainId: SEPOLIA });
      expect(getAccount(config).connector).toBe(connector);
      // The page's own disconnect and connect go through it to the live client (eth_requestAccounts there).
      await disconnect(config);
      expect(getAccount(config).status).toBe('disconnected');
      await expect(connect(config, { connector })).resolves.toMatchObject({ accounts: [EVM], chainId: SEPOLIA });
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: EVM });
      s.client.destroy();
      await flush();
      // Destroying ends wagmi's connection (accountsChanged [] and disconnect reach it); wagmi keeps listing the entry,
      // and connecting through it while the wallet is off is refused with 4900.
      expect(getAccount(config).status).toBe('disconnected');
      expect(ours()).toHaveLength(1);
      await expect(connect(config, { connector })).rejects.toMatchObject({ code: 4900 });
    }
  });
});
