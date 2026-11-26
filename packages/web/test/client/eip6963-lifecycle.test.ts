// @vitest-environment happy-dom
// Turning the wallet off and on in one page (D936): one EIP-6963 entry per page and environment, one uuid for the
// page's lifetime, forwarding to the newest live client (else the next newest, else none), so the real mipd store and
// real wagmi keep exactly one "Journear Passport" entry and it works with the live client; a uuid that lives in memory
// for the page only; a destroyed client's hana.ethereum that refuses everything from its first teardown event and lets
// go; no event delivered after the entry moved on. Includes a randomised state-machine test (adapted from PR 163's
// second review).
import { checksumEvmAddress, stellarAddress } from '@hana-id/core';
import { connect, createConfig, disconnect, getAccount, getConnectors, http } from '@wagmi/core';
import { type EIP6963ProviderDetail, createStore } from 'mipd';
import { baseSepolia, sepolia } from 'viem/chains';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRpcError } from '../../src/client/errors.ts';
import { type EthereumHost, type HanaEip6963Provider, HanaEthereumProvider, announceEip6963, rdnsFor } from '../../src/client/ethereum.ts';
import { FakeVault, LOGGED_IN, ORIGINS, type Setup, flush, rpcFetch, setup } from './harness.ts';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const CHAINS = (defaultChainId: number) => ({
  chains: [
    { id: SEPOLIA, rpcUrl: 'https://sepolia.rpc.test' },
    { id: BASE_SEPOLIA, rpcUrl: 'https://base-sepolia.rpc.test' },
  ],
  defaultChainId,
});
const RDNS = rdnsFor(ORIGINS.authOrigin);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TURNED_OFF = 'Journear Passport is turned off on this page.';

/** User n's EVM address, and their vault's logged-in status. */
const addr = (n: number) => checksumEvmAddress(new Uint8Array(20).fill(0x10 + n));
const loggedIn = (n: number) => ({ ...LOGGED_IN, addresses: { stellar: stellarAddress(new Uint8Array(32).fill(n + 1)), evm: addr(n) } });

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
  // The page's entry outlives a test (module memory): a test's listeners (wagmi's) must not hear the next test.
  for (const d of announced) (d.provider as unknown as HanaEip6963Provider).removeAllListeners();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A client of user n with `evm` (default chain `chain`), its vault on its own (newest) frame answering eth_accounts. */
function client(n = 1, chain = SEPOLIA): Setup {
  const first = document.querySelector('iframe[name^="hana-vault-"]');
  const desc = first ? Object.getOwnPropertyDescriptor(first, 'contentWindow') : undefined;
  const made = setup({ config: { evm: CHAINS(chain) }, fetch: rpcFetch({ eth_blockNumber: '0x10' }) });
  // setup() scripts the first frame; put back the vault already scripted there.
  if (first && desc) Object.defineProperty(first, 'contentWindow', desc);
  const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[name^="hana-vault-"]');
  const frame = frames[frames.length - 1]!;
  const s = frame === made.frame ? made : { ...made, frame, vault: new FakeVault(frame) };
  s.vault.handle('eth_accounts', () => ({ result: [addr(n)] }));
  alive.push(s);
  return s;
}

function wagmi(storage?: 'local') {
  return createConfig({
    chains: [sepolia, baseSepolia],
    transports: { [sepolia.id]: http('https://sepolia.rpc.test'), [baseSepolia.id]: http('https://base-sepolia.rpc.test') },
    ...(storage ? {} : { storage: null }),
  });
}
const oursIn = (config: ReturnType<typeof wagmi>) => getConnectors(config).filter((c) => c.name === 'Journear Passport');
const providerOf = async (c: ReturnType<typeof oursIn>[number]) => (await c.getProvider()) as HanaEip6963Provider;

async function refused(p: Promise<unknown>, code: number): Promise<ProviderRpcError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ProviderRpcError);
  expect((e as ProviderRpcError).code).toBe(code);
  return e as ProviderRpcError;
}

/** What a listener on `p` believes, from its events alone. */
function observe(p: HanaEip6963Provider) {
  const st = { accounts: [] as string[], connected: false, chainId: null as string | null, log: [] as string[] };
  p.on('accountsChanged', (a) => {
    st.accounts = a;
    st.log.push(`acc:${a.join(',')}`);
  });
  p.on('connect', (i) => {
    if (st.connected) st.log.push('DUP-CONNECT');
    st.connected = true;
    st.chainId = i.chainId;
    st.log.push(`connect:${i.chainId}`);
  });
  p.on('disconnect', () => {
    st.connected = false;
    st.log.push('disconnect');
  });
  p.on('chainChanged', (c) => {
    st.chainId = c;
    st.log.push(`chain:${c}`);
  });
  return st;
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
      return addr(1);
    },
    login: touch('login') as EthereumHost['login'],
    request: touch('request') as EthereumHost['request'],
    fetch: touch('fetch') as EthereumHost['fetch'],
  };
}

describe('one entry per page and environment', () => {
  it('create → destroy → create ×3: the same detail object, uuid and provider each time, forwarding to the live client', async () => {
    const first = client();
    await first.vault.connect(loggedIn(1));
    const detail = first.client.eip6963!;
    expect(detail.info.uuid).toMatch(UUID_V4);
    expect(detail.info.rdns).toBe(RDNS);
    expect(Object.isFrozen(detail) && Object.isFrozen(detail.info)).toBe(true);
    first.client.destroy();
    for (let i = 0; i < 3; i++) {
      const next = client();
      expect(next.client.eip6963).toBe(detail);
      await next.vault.connect(loggedIn(1));
      expect(await detail.provider.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
      expect(next.vault.seen('eth_accounts')).toHaveLength(1);
      next.client.destroy();
      expect((await refused(detail.provider.request({ method: 'eth_chainId' }), 4900)).message).toBe(TURNED_OFF);
    }
    expect(announced.every((d) => d === detail)).toBe(true);
  });

  it('clients alive at once share the entry, which forwards to the newest, then to the next newest', async () => {
    const a = client(1);
    await a.vault.connect(loggedIn(1));
    const b = client(2);
    await b.vault.connect(loggedIn(2));
    const c = client(3);
    await c.vault.connect(loggedIn(3));
    expect(b.client.eip6963).toBe(a.client.eip6963);
    expect(c.client.eip6963).toBe(a.client.eip6963);
    const entry = a.client.eip6963!.provider;
    // C is the newest.
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(3)]);
    expect(c.vault.seen('eth_accounts')).toHaveLength(1);
    c.client.destroy();
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(2)]);
    b.client.destroy();
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
    // The older clients' own providers stay theirs.
    expect(a.vault.seen('eth_accounts')).toHaveLength(1);
    expect(b.vault.seen('eth_accounts')).toHaveLength(1);
  });

  it('another environment (rdns) has an entry of its own', () => {
    const host = strictHost();
    const here = announceEip6963(window, new HanaEthereumProvider(host, CHAINS(SEPOLIA)), RDNS);
    const there = announceEip6963(window, new HanaEthereumProvider(host, CHAINS(SEPOLIA)), 'example.other.auth');
    expect(there.detail).not.toBe(here.detail);
    expect(there.detail.info.uuid).not.toBe(here.detail.info.uuid);
    expect(there.detail.info.rdns).toBe('example.other.auth');
    here.stop();
    there.stop();
    expect(host.calls).toEqual([]);
  });

  it('the entry carries the live client events, and none from a destroyed one', async () => {
    const a = client();
    const st = observe(a.client.eip6963!.provider);
    await a.vault.connect(loggedIn(1));
    a.client.destroy();
    expect(st.log).toEqual([`acc:${addr(1)}`, 'connect:0xaa36a7', 'acc:', 'disconnect']);
    st.log.length = 0;
    a.vault.emit('accountsChanged', { addresses: null });
    await flush();
    expect(st.log).toEqual([]);
    const b = client();
    await b.vault.connect(loggedIn(1));
    expect(st.log).toEqual([`acc:${addr(1)}`, 'connect:0xaa36a7']);
  });

  it('moving to another client says what changed: accounts, then the chain (no second connect)', async () => {
    const a = client(1, SEPOLIA);
    await a.vault.connect(loggedIn(1));
    const st = observe(a.client.eip6963!.provider);
    // B, signed in on Base Sepolia, becomes the newest: the entry moves to it, unready at first.
    const b = client(2, BASE_SEPOLIA);
    expect(st.log).toEqual(['acc:', 'disconnect']);
    await b.vault.connect(loggedIn(2));
    expect(st.log).toEqual(['acc:', 'disconnect', `acc:${addr(2)}`, 'connect:0x14a34']);
    st.log.length = 0;
    // B goes: back to A, both connected, on another chain.
    b.client.destroy();
    expect(st.log).toEqual([`acc:${addr(1)}`, 'chain:0xaa36a7']);
    expect(a.client.eip6963!.provider.chainId).toBe('0xaa36a7');
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
    const here = announceEip6963(window, new HanaEthereumProvider(host, CHAINS(SEPOLIA)), RDNS);
    const otherPage = new HappyWindow({ url: 'https://partner.example/' }) as unknown as Window;
    const there = announceEip6963(otherPage, new HanaEthereumProvider(host, CHAINS(SEPOLIA)), RDNS);
    vi.resetModules();
    const reloaded = (await import('../../src/client/ethereum.ts')) as typeof import('../../src/client/ethereum.ts');
    const afterLoad = reloaded.announceEip6963(window, new reloaded.HanaEthereumProvider(host, CHAINS(SEPOLIA)), RDNS);
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
    await s.vault.connect(loggedIn(1));
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
    announced = [];
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced).toEqual([]);
    expect((await refused(s.client.eip6963!.provider.request({ method: 'eth_accounts' }), 4900)).message).toBe(TURNED_OFF);
    expect(seen).toHaveLength(2);
  });

  it('a call made from inside the teardown events is already refused, through hana.ethereum and through the entry', async () => {
    const a = client();
    await a.vault.connect(loggedIn(1));
    const entry = a.client.eip6963!.provider;
    const got: Promise<unknown>[] = [];
    const ask = (p: { request(x: { method: string; params?: unknown[] }): Promise<unknown> }) => {
      for (const [method, params] of [
        ['eth_requestAccounts', []],
        ['eth_accounts', []],
        ['eth_chainId', []],
        ['eth_blockNumber', []],
        ['personal_sign', ['0x00', addr(1)]],
      ] as const) {
        got.push(p.request({ method, params: [...params] }).then(
          (x) => ['ok', x],
          (e: { code: number }) => ['err', e.code],
        ));
      }
    };
    entry.on('accountsChanged', () => ask(entry));
    entry.on('disconnect', () => ask(entry));
    a.client.ethereum.on('accountsChanged', () => ask(a.client.ethereum));
    a.client.ethereum.on('disconnect', () => ask(a.client.ethereum));
    const seen = a.vault.requests.length;
    a.client.destroy();
    await flush();
    const answers = await Promise.all(got);
    expect(answers).toHaveLength(20);
    expect(answers.every((x) => JSON.stringify(x) === JSON.stringify(['err', 4900]))).toBe(true);
    expect(a.vault.requests).toHaveLength(seen);
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it('a provider that never connected says nothing, and one whose vault died says disconnect once', async () => {
    const never = client();
    const quiet = vi.fn();
    never.client.ethereum.on('disconnect', quiet);
    never.client.ethereum.on('accountsChanged', quiet);
    never.client.destroy();
    expect(quiet).not.toHaveBeenCalled();

    const died = client();
    await died.vault.connect(loggedIn(1));
    const disconnects = vi.fn();
    died.client.ethereum.on('disconnect', disconnects);
    died.vault.load(); // a second load: the vault document was replaced, the connection is gone
    await flush();
    died.client.destroy();
    expect(disconnects).toHaveBeenCalledTimes(1);
  });

  it('a retired provider never reaches its client again: it holds a dead host', async () => {
    const host = strictHost();
    const eth = new HanaEthereumProvider(host, CHAINS(SEPOLIA));
    eth.connected();
    eth.retire();
    host.calls.length = 0;
    for (const method of ['eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'eth_call', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus']) {
      await refused(eth.request({ method, params: [] }), 4900);
    }
    eth.connected();
    eth.accountsChanged(addr(1));
    eth.disconnected();
    expect(host.calls).toEqual([]);
    expect(eth.chainIds).toEqual([SEPOLIA, BASE_SEPOLIA]);
  });

  it("a host that never destroys sees no change: the entry answers as hana.ethereum does, with the client's own checks", async () => {
    const s = client();
    await s.vault.connect(loggedIn(1));
    const p = s.client.eip6963!.provider;
    expect(await p.request({ method: 'eth_chainId' })).toBe(await s.client.ethereum.request({ method: 'eth_chainId' }));
    expect(await p.request({ method: 'eth_requestAccounts' })).toEqual([addr(1)]);
    expect(await p.request({ method: 'eth_blockNumber' })).toBe('0x10');
    await refused(p.request({ method: 'eth_sign', params: [] }), 4200);
    await refused(p.request({ method: 'personal_sign', params: ['0x00', addr(2)] }), 4100);
    await refused(p.request({ method: 'eth_signTypedData_v4', params: [addr(2), '{}'] }), 4100);
    await refused(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), 4100);
    await refused(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x4268' }] }), 4902);
    expect(p.isHanaId).toBe(true);
  });
});

describe('no event after the entry moved on', () => {
  it('a listener that destroys its client inside accountsChanged, while another lives: later listeners hear only the other', async () => {
    const a = client(1);
    await a.vault.connect(loggedIn(1));
    const b = client(2);
    await b.vault.connect(loggedIn(2));
    const entry = a.client.eip6963!.provider;
    // B is the newest: the entry is B's. A listener destroying B when B's account changes.
    entry.on('accountsChanged', () => b.client.destroy());
    const st = observe(entry);
    b.vault.emit('accountsChanged', { addresses: loggedIn(9).addresses });
    await flush();
    expect(st.log).toEqual([`acc:${addr(1)}`]);
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
  });

  it('with one client: later listeners hear [] and disconnect, not the destroyed client’s new account', async () => {
    const a = client(1);
    await a.vault.connect(loggedIn(1));
    const entry = a.client.eip6963!.provider;
    entry.on('accountsChanged', () => a.client.destroy());
    const st = observe(entry);
    const own: string[][] = [];
    a.client.ethereum.on('accountsChanged', (x) => own.push(x));
    a.vault.emit('accountsChanged', { addresses: loggedIn(9).addresses });
    await flush();
    expect(st.log).toEqual(['acc:', 'disconnect']);
    // Its own listeners hear its teardown, and not the account it was given before.
    expect(own).toEqual([[]]);
  });

  it('a request is answered by the client bound when it was made, even if the entry moves on before the answer', async () => {
    const b = client(2);
    await b.vault.connect(loggedIn(2));
    b.vault.handle('eth_accounts', () => 'manual');
    const entry = b.client.eip6963!.provider;
    const pending = entry.request({ method: 'eth_accounts' });
    await flush();
    const asked = b.vault.last('eth_accounts');
    const c = client(3);
    await c.vault.connect(loggedIn(3));
    b.vault.reply(asked.id, [addr(2)]);
    await expect(pending).resolves.toEqual([addr(2)]);
    expect(c.vault.seen('eth_accounts')).toHaveLength(0);
  });
});

describe('the entry itself', () => {
  it('is frozen: a page script can neither replace request nor add a field', async () => {
    const a = client();
    await a.vault.connect(loggedIn(1));
    const p = a.client.eip6963!.provider as unknown as Record<string, unknown>;
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      p.request = () => Promise.resolve(['0xevil']);
    }).toThrow(TypeError);
    expect(() => {
      p.extra = 1;
    }).toThrow(TypeError);
    a.client.destroy();
    const b = client();
    await b.vault.connect(loggedIn(1));
    expect(await b.client.eip6963!.provider.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
  });

  it("keeps hearing hana.ethereum's events after the host calls hana.ethereum.removeAllListeners()", async () => {
    const a = client();
    const heard: unknown[] = [];
    a.client.eip6963!.provider.on('accountsChanged', (x) => heard.push(x));
    a.client.eip6963!.provider.on('connect', (x) => heard.push(x));
    a.client.ethereum.removeAllListeners();
    await a.vault.connect(loggedIn(1));
    a.vault.emit('accountsChanged', { addresses: null });
    await flush();
    expect(heard).toEqual([[addr(1)], { chainId: '0xaa36a7' }, []]);
  });
});

describe('real wallet lists', () => {
  it("mipd: one entry after off/on ×3 and after create-first sequences, always reaching the newest client", async () => {
    const store = createStore();
    const ours = () => store.getProviders().filter((d) => d.info.rdns === RDNS);
    try {
      for (let i = 0; i < 3; i++) {
        const s = client();
        await s.vault.connect(loggedIn(1));
        expect(ours()).toEqual([s.client.eip6963]);
        s.client.destroy();
      }
      const a = client(1);
      await a.vault.connect(loggedIn(1));
      const b = client(2); // created first: A still lives
      await b.vault.connect(loggedIn(2));
      a.client.destroy();
      const c = client(3);
      await c.vault.connect(loggedIn(3));
      expect(ours()).toHaveLength(1);
      expect(await ours()[0]!.provider.request({ method: 'eth_accounts' })).toEqual([addr(3)]);
      c.client.destroy();
      expect(await ours()[0]!.provider.request({ method: 'eth_accounts' })).toEqual([addr(2)]);
      b.client.destroy();
      store.reset(); // a store that asks again while the wallet is off sees nothing; once on, the one entry
      expect(ours()).toHaveLength(0);
      const live = client();
      store.reset();
      expect(ours()).toEqual([live.client.eip6963]);
    } finally {
      store.destroy();
    }
  });

  it('wagmi: off and on three times, one connector, connected to the live client, no store reset or connector removal', async () => {
    const config = wagmi();
    let first: unknown;
    for (let i = 0; i < 3; i++) {
      const s = client();
      await s.vault.connect(loggedIn(1));
      await flush();
      expect(oursIn(config)).toHaveLength(1);
      const connector = oursIn(config)[0]!;
      first ??= connector;
      expect(connector).toBe(first);
      expect(connector.id).toBe(s.client.eip6963!.info.rdns);
      expect(await providerOf(connector)).toBe(s.client.eip6963!.provider);
      // The session was restored and its accountsChanged reached wagmi: wagmi connects on its own.
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(1), chainId: SEPOLIA, connector });
      await disconnect(config);
      await expect(connect(config, { connector })).resolves.toMatchObject({ accounts: [addr(1)], chainId: SEPOLIA });
      s.client.destroy();
      await flush();
      expect(getAccount(config).status).toBe('disconnected');
      expect(oursIn(config)).toHaveLength(1);
      await expect(connect(config, { connector })).rejects.toMatchObject({ code: 4900, message: expect.stringContaining('turned off') });
    }
  });

  it('wagmi: create B before destroying A (another app, another chain): the one connector follows B, then A again', async () => {
    const config = wagmi();
    const a = client(1, SEPOLIA);
    await a.vault.connect(loggedIn(1));
    await flush();
    const [connector] = oursIn(config);
    expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(1), chainId: SEPOLIA });
    const b = client(2, BASE_SEPOLIA);
    await b.vault.connect(loggedIn(2));
    await flush();
    expect(oursIn(config)).toEqual([connector]);
    expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(2), chainId: BASE_SEPOLIA, connector });
    const seenByA = a.vault.seen('eth_accounts').length;
    await disconnect(config);
    await expect(connect(config, { connector: connector! })).resolves.toMatchObject({ accounts: [addr(2)] });
    expect(a.vault.seen('eth_accounts')).toHaveLength(seenByA);
    b.client.destroy();
    await flush();
    expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(1), chainId: SEPOLIA, connector });
    a.client.destroy();
    await flush();
    expect(getAccount(config).status).toBe('disconnected');
  });

  it('wagmi: off/on ×3, each new client created inside a listener of the old one’s teardown', async () => {
    const config = wagmi();
    let cur = client();
    await cur.vault.connect(loggedIn(1));
    await flush();
    const [connector] = oursIn(config);
    const uuid = cur.client.eip6963!.info.uuid;
    for (let i = 0; i < 3; i++) {
      let next: Setup | undefined;
      cur.client.ethereum.on(i % 2 ? 'disconnect' : 'accountsChanged', () => {
        next ??= client();
      });
      cur.client.destroy();
      expect(next!.client.eip6963!.info.uuid).toBe(uuid);
      await flush();
      expect(getAccount(config).status).toBe('disconnected');
      await next!.vault.connect(loggedIn(1));
      await flush();
      expect(oursIn(config)).toEqual([connector]);
      expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(1), connector });
      await disconnect(config);
      await expect(connect(config, { connector: connector! })).resolves.toMatchObject({ accounts: [addr(1)] });
      cur = next!;
    }
    expect(new Set(announced.map((d) => d.info.uuid))).toEqual(new Set([uuid]));
  });

  it('wagmi with real storage: a user who disconnected, then the wallet off and on, is connected again by wagmi once the session is restored', async () => {
    localStorage.clear();
    const config = wagmi('local');
    await flush();
    const a = client();
    await a.vault.connect(loggedIn(1));
    await flush();
    const [connector] = oursIn(config);
    if (getAccount(config).status !== 'connected') await connect(config, { connector: connector! });
    await disconnect(config);
    await flush();
    expect(getAccount(config).status).toBe('disconnected');
    expect(Object.keys(localStorage).some((k) => k.includes('disconnected'))).toBe(true);
    a.client.destroy();
    const b = client();
    await b.vault.connect(loggedIn(1));
    await flush();
    // Observed: wagmi's own accountsChanged handling connects again, its "disconnected" mark notwithstanding (as a
    // reload of the page does). A host that must honour the user's choice keeps its own flag.
    expect(oursIn(config)).toEqual([connector]);
    expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(1) });
    localStorage.clear();
  });
});

describe('state machine (randomised)', () => {
  it('up to 4 clients, created and destroyed (also inside the entry’s and hana.ethereum’s listeners), on mixed chains: every invariant holds at every step', async () => {
    let seed = 0x1630;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    // Set from inside make() (a closure), so held in an object TypeScript doesn't narrow.
    const page: { entry: HanaEip6963Provider | null; st: ReturnType<typeof observe> | null } = { entry: null, st: null };
    for (let round = 0; round < 40; round++) {
      const live: { s: Setup; n: number; ready: boolean }[] = [];
      const make = (n: number) => {
        const e = { s: client(n, rand(2) ? SEPOLIA : BASE_SEPOLIA), n, ready: false };
        live.push(e);
        if (!page.entry) {
          page.entry = e.s.client.eip6963!.provider;
          page.st = observe(page.entry);
        }
        expect(e.s.client.eip6963!.provider).toBe(page.entry);
        return e;
      };
      for (let step = 0; step < 14; step++) {
        const op = rand(6);
        const where = `round ${round} step ${step} op ${op}`;
        if (op <= 1 && live.length < 4) {
          const e = make(rand(4));
          if (rand(2)) {
            await e.s.vault.connect(loggedIn(e.n));
            e.ready = true;
          }
        } else if (op === 2 && live.length > 0) {
          const [e] = live.splice(rand(live.length), 1);
          e!.s.client.destroy();
        } else if ((op === 3 || op === 4) && live.length > 0) {
          // Destroy, creating a client from inside a listener (the entry's, or the client's own hana.ethereum's).
          const [e] = live.splice(rand(live.length), 1);
          const target = op === 3 ? page.entry! : e!.s.client.ethereum;
          const ev = rand(2) ? 'accountsChanged' : 'disconnect';
          let made = false;
          const l = () => {
            if (!made && live.length < 4) {
              made = true;
              make(rand(4));
            }
          };
          target.on(ev as 'disconnect', l);
          e!.s.client.destroy();
          target.removeListener(ev as 'disconnect', l);
        } else if (op === 5) {
          for (const e of live) {
            if (e.ready) continue;
            await e.s.vault.connect(loggedIn(e.n));
            e.ready = true;
          }
        }
        await flush();
        const { entry, st: s } = page;
        if (!entry || !s) continue;
        expect(s.log.includes('DUP-CONNECT'), `${where}: ${s.log.join(' ')}`).toBe(false);
        const newest = live.at(-1) ?? null;
        if (newest === null) {
          expect(s.accounts, `${where}: unbound`).toEqual([]);
          expect(s.connected, `${where}: unbound`).toBe(false);
          expect((await refused(entry.request({ method: 'eth_chainId' }), 4900)).message).toBe(TURNED_OFF);
          continue;
        }
        // Bound to the newest live client: what the listeners heard is that client's state.
        expect(entry.chainId, where).toBe(newest.s.client.ethereum.chainId);
        expect(s.accounts, `${where}: ${s.log.join(' ')}`).toEqual(newest.ready ? [addr(newest.n)] : []);
        expect(s.connected, `${where}: ${s.log.join(' ')}`).toBe(newest.ready);
        if (newest.ready) expect(s.chainId, `${where}: ${s.log.join(' ')}`).toBe(newest.s.client.ethereum.chainId);
        // A request reaches that client's vault only (an unready client's waits for its vault: skipped).
        if (!newest.ready) continue;
        const before = live.map((e) => e.s.vault.seen('eth_accounts').length);
        await expect(entry.request({ method: 'eth_accounts' })).resolves.toEqual([addr(newest.n)]);
        live.forEach((e, i) => expect(e.s.vault.seen('eth_accounts').length - before[i]!, where).toBe(e === newest ? 1 : 0));
      }
      for (const e of live.splice(0)) e.s.client.destroy();
      await flush();
      expect(page.st?.connected ?? false).toBe(false);
    }
    // Keep the entry's observers out of the next tests.
    page.entry?.removeAllListeners();
  }, 60_000);
});
