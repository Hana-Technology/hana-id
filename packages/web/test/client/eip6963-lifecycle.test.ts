// @vitest-environment happy-dom
// Turning the wallet off and on in one page (D936): one EIP-6963 entry per page and environment, one uuid for the
// page's lifetime, forwarding to the newest live client (else the next newest, else none), so the real mipd store and
// real wagmi keep exactly one "Journear Passport" entry and it works with the live client; a uuid that lives in memory
// for the page only; a destroyed client's hana.ethereum that refuses everything from its first teardown event and lets
// go; every entry listener hears every event in one order and ends with the bound client's state. Includes the
// reviews' cut-off cases (A, B, C, with real wagmi) and a randomised state machine in three modes (PR 163's reviews).
import { checksumEvmAddress, stellarAddress } from '@hana-id/core';
import { connect, createConfig, disconnect, getAccount, getConnectors, http } from '@wagmi/core';
import { type EIP6963ProviderDetail, createStore } from 'mipd';
import { baseSepolia, sepolia } from 'viem/chains';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRpcError } from '../../src/client/errors.ts';
import { type EthereumHost, HanaEip6963Provider, HanaEthereumProvider, announceEip6963, rdnsFor } from '../../src/client/ethereum.ts';
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
/**
 * The listeners this test (and its wagmi) put on the page's shared entry, so afterEach removes exactly those: the
 * entry outlives a test, and removeAllListeners() on it would also remove other integrations' listeners.
 */
let added: { p: HanaEip6963Provider; event: string; listener: (...a: never[]) => void }[];
beforeEach(() => {
  announced = [];
  added = [];
  const on = HanaEip6963Provider.prototype.on;
  vi.spyOn(HanaEip6963Provider.prototype, 'on').mockImplementation(function (this: HanaEip6963Provider, event, listener) {
    added.push({ p: this, event, listener: listener as unknown as (...a: never[]) => void });
    return on.call(this, event, listener);
  });
  window.addEventListener('eip6963:announceProvider', onAnnounce);
});
afterEach(() => {
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  // This test's listeners first: they mustn't react (wagmi's async handlers) to the clean-up below.
  for (const { p, event, listener } of added) p.removeListener(event as 'connect', listener as never);
  for (const s of alive) s.client.destroy();
  alive = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A client of user n with `evm` (default chain `chain`), its vault on its own frame answering eth_accounts. */
const claimed = new WeakSet<Element>();
function client(n = 1, chain = SEPOLIA): Setup {
  const first = document.querySelector('iframe[name^="hana-vault-"]');
  const desc = first ? Object.getOwnPropertyDescriptor(first, 'contentWindow') : undefined;
  const before = new Set(document.querySelectorAll('iframe[name^="hana-vault-"]'));
  const made = setup({ config: { evm: CHAINS(chain) }, fetch: rpcFetch({ eth_blockNumber: '0x10' }) });
  // setup() scripts the first frame; put back the vault already scripted there.
  if (first && desc) Object.defineProperty(first, 'contentWindow', desc);
  // This client's frame: the one it added (a client created inside another's teardown sees that one's frame too).
  const mine = [...document.querySelectorAll<HTMLIFrameElement>('iframe[name^="hana-vault-"]')].filter((f) => !before.has(f) && !claimed.has(f));
  if (mine.length !== 1) throw new Error(`expected one new vault frame, found ${mine.length}`);
  const frame = mine[0]!;
  claimed.add(frame);
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

const switchTo = (id: number) => ({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${id.toString(16)}` }] });

describe('every listener hears every event, in one order (FIFO), and ends with the bound client’s state', () => {
  it('a listener that destroys its client inside accountsChanged, while another lives: all hear it, then the other', async () => {
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
    expect(st.log).toEqual([`acc:${addr(9)}`, `acc:${addr(1)}`]);
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
  });

  it('with one client: all hear its new account, then [] and disconnect; its own listeners hear the teardown last', async () => {
    const a = client(1);
    await a.vault.connect(loggedIn(1));
    const entry = a.client.eip6963!.provider;
    entry.on('accountsChanged', () => a.client.destroy());
    const st = observe(entry);
    const own: string[][] = [];
    a.client.ethereum.on('accountsChanged', (x) => own.push(x));
    a.vault.emit('accountsChanged', { addresses: loggedIn(9).addresses });
    await flush();
    expect(st.log).toEqual([`acc:${addr(9)}`, 'acc:', 'disconnect']);
    expect(own).toEqual([[addr(9)], []]);
  });

  it('A: a chainChanged listener destroys the newest, the entry falls back to an older client on that chain: all end on it', async () => {
    const older = client(1, BASE_SEPOLIA);
    await older.vault.connect(loggedIn(1));
    const entry = older.client.eip6963!.provider;
    let target: Setup | null = null;
    entry.on('chainChanged', () => {
      const t = target;
      target = null;
      t?.client.destroy();
    });
    const st = observe(entry);
    const newer = client(1, SEPOLIA);
    await newer.vault.connect(loggedIn(1));
    expect(st.chainId).toBe('0xaa36a7');
    target = newer;
    await entry.request(switchTo(BASE_SEPOLIA));
    await flush();
    expect(await entry.request({ method: 'eth_chainId' })).toBe('0x14a34');
    expect(st.chainId, st.log.join(' ')).toBe('0x14a34');
    expect(st.connected).toBe(true);
  });

  it('B: a connect listener destroys the newer client, the entry returns to an older connected one: all stay connected', async () => {
    const older = client(1, SEPOLIA);
    await older.vault.connect(loggedIn(1));
    const entry = older.client.eip6963!.provider;
    let target: Setup | null = null;
    entry.on('connect', () => {
      const t = target;
      target = null;
      t?.client.destroy();
    });
    const st = observe(entry);
    const newer = client(1, SEPOLIA);
    target = newer;
    await newer.vault.connect(loggedIn(1));
    await flush();
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
    expect(st.connected, st.log.join(' ')).toBe(true);
    expect(st.log.includes('DUP-CONNECT')).toBe(false);
  });

  it('C: a move’s accountsChanged, and a second move inside it to a client with the same account: all end on that account', async () => {
    const d = client(2);
    await d.vault.connect(loggedIn(2));
    const b = client(2);
    await b.vault.connect(loggedIn(2));
    const a = client(1);
    await a.vault.connect(loggedIn(1));
    const entry = a.client.eip6963!.provider;
    let target: Setup | null = null;
    entry.on('accountsChanged', () => {
      const t = target;
      target = null;
      t?.client.destroy();
    });
    const st = observe(entry);
    target = b;
    a.client.destroy();
    await flush();
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(2)]);
    expect(st.accounts, st.log.join(' ')).toEqual([addr(2)]);
  });

  it('one client whose vault dies, destroyed from a disconnect listener: every listener hears disconnect', async () => {
    const a = client(1);
    await a.vault.connect(loggedIn(1));
    const entry = a.client.eip6963!.provider;
    entry.on('disconnect', () => a.client.destroy());
    const st = observe(entry);
    a.vault.load(); // the vault document was replaced: the connection is gone
    await flush();
    expect(st.log).toEqual(['acc:', 'disconnect']);
    expect(st.connected).toBe(false);
  });

  it('a listener that throws stops neither the delivery nor the queue (rethrown on a fresh task, as the Emitter does)', async () => {
    const later: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    try {
      const older = client(1);
      await older.vault.connect(loggedIn(1));
      const newer = client(2);
      await newer.vault.connect(loggedIn(2));
      const entry = older.client.eip6963!.provider;
      entry.on('accountsChanged', () => {
        newer.client.destroy();
        throw new Error('listener bug');
      });
      const st = observe(entry);
      // The Emitter rethrows a listener's error on a fresh task (setTimeout 0): capture it here.
      vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => (ms === 0 ? (later.push(fn), 0) : realSetTimeout(fn, ms))) as typeof setTimeout);
      newer.vault.emit('accountsChanged', { addresses: loggedIn(9).addresses });
      await flush();
      vi.unstubAllGlobals();
      expect(st.log).toEqual([`acc:${addr(9)}`, `acc:${addr(1)}`]);
      expect(later.length).toBeGreaterThan(0);
      expect(() => later.forEach((f) => f())).toThrow('listener bug');
    } finally {
      vi.stubGlobal('setTimeout', realSetTimeout);
      vi.unstubAllGlobals();
    }
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

  it('wallet_getCapabilities in flight across destroy() rejects with 4900 (not {} or 4100)', async () => {
    for (const params of [[addr(1)], []]) {
      const a = client(1);
      await a.vault.connect(loggedIn(1));
      const p = a.client.ethereum.request({ method: 'wallet_getCapabilities', params });
      a.client.destroy(); // while it awaits `ready` (already resolved: one microtask)
      await refused(p, 4900);
    }
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

  it('wagmi, case A: a chainChanged listener destroys the newest client, the entry falls back to an older one on that chain: wagmi follows', async () => {
    const older = client(1, BASE_SEPOLIA);
    await older.vault.connect(loggedIn(1));
    const entry = older.client.eip6963!.provider;
    let target: Setup | null = null;
    entry.on('chainChanged', () => {
      const t = target;
      target = null;
      t?.client.destroy();
    });
    const config = wagmi();
    const newer = client(1, SEPOLIA);
    await newer.vault.connect(loggedIn(1));
    await flush();
    const [connector] = oursIn(config);
    if (getAccount(config).status !== 'connected') await connect(config, { connector: connector! });
    await flush();
    expect(getAccount(config)).toMatchObject({ status: 'connected', chainId: SEPOLIA });
    target = newer;
    await entry.request(switchTo(BASE_SEPOLIA));
    await flush();
    expect(await entry.request({ method: 'eth_chainId' })).toBe('0x14a34');
    expect(getAccount(config)).toMatchObject({ status: 'connected', chainId: BASE_SEPOLIA });
  });

  it('wagmi, case B: a connect listener destroys the newer client, the entry returns to an older connected one: wagmi stays connected', async () => {
    const older = client(1, SEPOLIA);
    await older.vault.connect(loggedIn(1));
    const entry = older.client.eip6963!.provider;
    let target: Setup | null = null;
    entry.on('connect', () => {
      const t = target;
      target = null;
      t?.client.destroy();
    });
    const config = wagmi();
    await flush();
    await connect(config, { connector: oursIn(config)[0]! });
    expect(getAccount(config)).toMatchObject({ status: 'connected' });
    const newer = client(1, SEPOLIA);
    target = newer;
    await newer.vault.connect(loggedIn(1));
    await flush();
    expect(await entry.request({ method: 'eth_accounts' })).toEqual([addr(1)]);
    expect(getAccount(config)).toMatchObject({ status: 'connected', address: addr(1) });
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

type Ev = 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
const EVS: readonly Ev[] = ['accountsChanged', 'chainChanged', 'connect', 'disconnect'];
const OPS = 10;

/** mulberry32: every bit usable with `% n` (an LCG mod 2^31's low bit alternates). */
function mulberry32(seed0: number): (n: number) => number {
  let seed = seed0 | 0;
  return (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

/**
 * The randomised state machine (PR 163's reviews): up to 4 clients on mixed chains; creates, destroys, chain
 * switches, account changes, vault deaths and requests in flight, with listeners ("triggers") on the entry and on a
 * client's own hana.ethereum that create or destroy clients, registered before the observer, after it, or mixed.
 * Returns the invariant violations and how often each op ran.
 */
async function machine(mode: 'before' | 'after' | 'mixed', seed0: number, rounds: number) {
  const rand = mulberry32(seed0);
  const violations: string[] = [];
  const ops = new Array<number>(OPS).fill(0);
  type C = { s: Setup; n: number; ready: boolean; dead: boolean; down: boolean; reqsAtDeath: number; own: string[]; ownAtDeath: number; settled?: number };
  const all: C[] = [];
  let live: C[] = [];
  const page: { entry: HanaEip6963Provider | null; st: ReturnType<typeof observe> | null; triggers: { before: boolean; ev: Ev; fn: () => void }[] } = { entry: null, st: null, triggers: [] };
  const fire = (before: boolean, ev: Ev) => {
    const mine = page.triggers.filter((t) => t.before === before && t.ev === ev);
    page.triggers = page.triggers.filter((t) => !mine.includes(t));
    for (const t of mine) t.fn();
  };
  const make = (n: number, chain: number): C => {
    const c = { n, ready: false, dead: false, down: false, reqsAtDeath: -1, own: [] as string[], ownAtDeath: -1 } as C;
    all.push(c);
    live.push(c);
    c.s = client(n, chain);
    for (const e of EVS) c.s.client.ethereum.on(e, (x: unknown) => c.own.push(`${e}:${JSON.stringify(x)}`));
    if (!page.entry) {
      page.entry = c.s.client.eip6963!.provider;
      for (const e of EVS) page.entry.on(e, () => fire(true, e));
      page.st = observe(page.entry);
      for (const e of EVS) page.entry.on(e, () => fire(false, e));
    }
    if (c.s.client.eip6963!.provider !== page.entry) violations.push('a second entry');
    return c;
  };
  const kill = (c: C) => {
    // A client still being constructed (a trigger fired from inside its createHana) can't be destroyed yet.
    if (c.dead || !c.s) return;
    live = live.filter((x) => x !== c);
    c.dead = true;
    c.ownAtDeath = c.own.length;
    c.s.client.destroy();
    c.reqsAtDeath = c.s.vault.requests.length;
  };
  const chainOf = () => (rand(3) === 0 ? BASE_SEPOLIA : SEPOLIA);
  const syncOp = (depth: number) => {
    if (depth < 3 && rand(2)) arm(depth + 1);
    const k = rand(5);
    if (k <= 1 && live.length < 4) make(rand(3), chainOf());
    else if (k === 2 && live.length > 0) kill(live[rand(live.length)]!);
    else if (k === 3 && live.length > 0) kill(live.at(-1)!);
    else if (k === 4) for (const c of [...live]) kill(c);
  };
  const arm = (depth: number) => {
    const before = mode === 'before' ? true : mode === 'after' ? false : rand(2) === 0;
    const ev = EVS[rand(4)]!;
    if (rand(3) === 0 && live.length > 0) {
      const c = live[rand(live.length)]!;
      if (!c.s) return;
      let done = false;
      c.s.client.ethereum.on(ev, () => {
        if (done) return;
        done = true;
        syncOp(depth);
      });
      return;
    }
    page.triggers.push({ before, ev, fn: () => syncOp(depth) });
  };
  const connectIt = async (c: C) => {
    await c.s.vault.connect(loggedIn(c.n));
    if (!c.dead) c.ready = true;
  };
  const inflight: { c: C; id: string | null; outcome?: string }[] = [];
  for (let round = 0; round < rounds; round++) {
    for (let step = 0; step < 18; step++) {
      const op = rand(OPS);
      ops[op]!++;
      const where = `[${mode} seed ${seed0}] round ${round} step ${step} op ${op}`;
      if (op === 0 && live.length < 4) {
        const c = make(rand(3), chainOf());
        if (rand(2)) await connectIt(c);
      } else if (op === 1) {
        for (const c of [...live]) kill(c);
        await flush();
        await connectIt(make(rand(3), chainOf()));
      } else if (op === 2) {
        arm(1);
        syncOp(1);
      } else if (op === 3) {
        for (const c of [...live]) if (!c.ready && !c.dead && !c.down) await connectIt(c);
      } else if (op === 4 && page.entry && live.at(-1)?.ready) {
        arm(1);
        await page.entry.request(switchTo(rand(2) ? BASE_SEPOLIA : SEPOLIA)).catch(() => {});
      } else if (op === 5 && live.length > 0) {
        arm(1);
        const c = live[rand(live.length)]!;
        if (c.ready) {
          c.n = rand(4);
          const n = c.n;
          c.s.vault.handle('eth_accounts', () => ({ result: [addr(n)] }));
          c.s.vault.emit('accountsChanged', { addresses: rand(4) === 0 ? null : loggedIn(n).addresses });
        }
      } else if (op === 6 && page.entry && live.at(-1)?.ready) {
        // A request in flight on the bound client.
        const c = live.at(-1)!;
        c.s.vault.handle('eth_accounts', () => 'manual');
        const before = all.map((x) => x.s.vault.seen('eth_accounts').length);
        const rec: (typeof inflight)[number] = { c, id: null };
        page.entry.request({ method: 'eth_accounts' }).then(
          (r) => (rec.outcome = `ok:${JSON.stringify(r)}`),
          (e: { code: number }) => (rec.outcome = `err:${e.code}`),
        );
        inflight.push(rec);
        await flush();
        all.forEach((x, i) => {
          if (x.s.vault.seen('eth_accounts').length - before[i]! !== (x === c ? 1 : 0)) violations.push(`${where}: request delivered to another vault`);
        });
        rec.id = c.dead ? null : c.s.vault.last('eth_accounts').id;
        const n = c.n;
        c.s.vault.handle('eth_accounts', () => ({ result: [addr(n)] }));
      } else if (op === 7 && inflight.length > 0) {
        const rec = inflight.shift()!;
        if (rand(2) && !rec.c.dead && rec.id) rec.c.s.vault.reply(rec.id, [`0xR${rec.c.n}`]);
        else kill(rec.c);
        await flush();
        if (!rec.c.dead && rec.outcome !== `ok:["0xR${rec.c.n}"]`) violations.push(`${where}: in-flight not settled by its own client: ${rec.outcome}`);
        if (rec.c.dead && rec.outcome !== 'err:4900' && !(rec.outcome ?? '').startsWith('ok:["0xR')) violations.push(`${where}: in-flight on a destroyed client: ${rec.outcome}`);
      } else if (op === 8 && live.length > 0) {
        const c = live[rand(live.length)]!;
        if (c.ready) {
          c.s.vault.load(); // its vault connection dies
          await flush();
          c.ready = false;
          c.down = true;
        }
      } else if (op === 9) {
        arm(1);
        if (live.length > 0) kill(live[rand(live.length)]!);
      }
      await flush();
      // ---- invariants, at this quiescent point ----
      const { entry, st } = page;
      if (!entry || !st) continue;
      if (st.log.includes('DUP-CONNECT')) violations.push(`${where}: a second connect`);
      for (const c of all) {
        if (!c.dead) continue;
        // After its destroy(), a client's own hana.ethereum says at most the rest of the event it was delivering (when a
        // listener destroyed it), then its teardown, and nothing after that, ever.
        const tail = c.own.slice(c.ownAtDeath);
        const isTeardown = (x: string) => x === 'accountsChanged:[]' || x.startsWith('disconnect:');
        const firstTeardown = tail.findIndex(isTeardown);
        const afterTeardown = firstTeardown < 0 ? [] : tail.slice(firstTeardown);
        if (tail.length > 3 || afterTeardown.some((x) => !isTeardown(x)) || (firstTeardown < 0 && tail.length > 1)) violations.push(`${where}: a destroyed client spoke after its teardown: ${tail.join(' ')}`);
        c.settled ??= c.own.length;
        if (c.own.length !== c.settled) violations.push(`${where}: a destroyed client spoke again: ${c.own.slice(c.settled).join(' ')}`);
        if (c.s.vault.requests.length !== c.reqsAtDeath) violations.push(`${where}: a destroyed client's vault was reached`);
      }
      const newest = live.at(-1) ?? null;
      if (newest === null) {
        if (st.accounts.length || st.connected) violations.push(`${where}: off, but listeners think ${JSON.stringify(st.accounts)} connected=${st.connected}`);
        const e = await entry.request({ method: 'eth_chainId' }).then(
          () => 'ok',
          (x: { code: number; message: string }) => `${x.code}:${x.message}`,
        );
        if (e !== `4900:${TURNED_OFF}`) violations.push(`${where}: off, but answered ${e}`);
        continue;
      }
      if (entry.chainId !== newest.s.client.ethereum.chainId) violations.push(`${where}: the entry's chainId isn't the newest client's`);
      const acct = newest.s.client.addresses?.evm ?? null;
      const want = newest.ready && acct ? [acct] : [];
      const label = `${where}: ${st.log.slice(-8).join(' ')}`;
      if (JSON.stringify(st.accounts) !== JSON.stringify(want)) violations.push(`${label} :: heard accounts ${JSON.stringify(st.accounts)}, bound ${JSON.stringify(want)}`);
      if (st.connected !== newest.ready) violations.push(`${label} :: heard connected ${st.connected}, bound ${newest.ready}`);
      if (newest.ready && st.chainId !== newest.s.client.ethereum.chainId) violations.push(`${label} :: heard chain ${st.chainId}, bound ${newest.s.client.ethereum.chainId}`);
      if (newest.ready && acct) {
        const before = all.map((x) => x.s.vault.seen('eth_accounts').length);
        const got = await entry.request({ method: 'eth_accounts' });
        if (JSON.stringify(got) !== JSON.stringify([acct])) violations.push(`${where}: the entry answered ${JSON.stringify(got)}`);
        all.forEach((x, i) => {
          if (x.s.vault.seen('eth_accounts').length - before[i]! !== (x === newest ? 1 : 0)) violations.push(`${where}: eth_accounts reached another vault`);
        });
      }
    }
    for (const c of [...live]) kill(c);
    await flush();
    if (page.st?.connected) violations.push(`round ${round}: connected after every client was destroyed`);
    for (const rec of inflight.splice(0)) {
      await flush();
      if (rec.outcome !== 'err:4900') violations.push(`round ${round}: an in-flight request left: ${rec.outcome}`);
    }
    page.triggers = [];
  }
  return { violations, ops };
}

describe('state machine (randomised, three modes)', () => {
  for (const mode of ['before', 'after', 'mixed'] as const) {
    it(`triggers registered ${mode === 'mixed' ? 'before and after' : mode} the observer: every listener ends with the bound client's state at every step`, async () => {
      const ops = new Array<number>(OPS).fill(0);
      const violations: string[] = [];
      for (const seed of [1, 42, 1630]) {
        const r = await machine(mode, seed, 8);
        violations.push(...r.violations);
        r.ops.forEach((n, i) => (ops[i]! += n));
      }
      expect(violations.slice(0, 10)).toEqual([]);
      // Every op code ran (the generator's low bits are usable).
      ops.forEach((n, i) => expect(n, `op ${i}`).toBeGreaterThan(0));
    }, 120_000);
  }
});
