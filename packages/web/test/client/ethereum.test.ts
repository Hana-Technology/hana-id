// @vitest-environment happy-dom
// hana.ethereum, the EIP-1193 provider, and EIP-6963 (docs/batch-b-spec.md "EIP-1193"; Tests → Web unit → "EIP-1193
// and EIP-6963: announce on load, re-announce on eip6963:requestProvider; 4902 for an unknown chain; tx fields cross
// the port as 0x hex strings").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRpcError } from '../../src/client/errors.ts';
import { rdnsFor } from '../../src/client/ethereum.ts';
import { HANA_ID_ICON } from '../../src/client/icon.ts';
import { EVM, LOGGED_IN, LOGGED_OUT, ORIGINS, STELLAR, type Setup, flush, rpcFetch, setup } from './harness.ts';

const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const EVM_CONFIG = {
  chains: [
    { id: SEPOLIA, rpcUrl: 'https://sepolia.rpc.test' },
    { id: BASE_SEPOLIA, rpcUrl: 'https://base-sepolia.rpc.test' },
  ],
  defaultChainId: SEPOLIA,
};
const TO = '0x00000000000000000000000000000000000000bb';
const HASH = `0x${'ab'.repeat(32)}`;
const RAW = '0x02f8aa';
const SIG = `0x${'11'.repeat(64)}1b`;
const CHAIN = { eth_getTransactionCount: '0x3', eth_estimateGas: '0x5208', eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' }, eth_maxPriorityFeePerGas: '0x59682f00', eth_gasPrice: '0x4a817c800', eth_sendRawTransaction: HASH, eth_blockNumber: '0x10' };

let s: Setup;
let announced: CustomEvent[];
const onAnnounce = (e: Event) => announced.push(e as CustomEvent);
beforeEach(() => {
  announced = [];
  window.addEventListener('eip6963:announceProvider', onAnnounce);
});
afterEach(() => {
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function refused(p: Promise<unknown>, code: number): Promise<ProviderRpcError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProviderRpcError);
  expect((e as ProviderRpcError).code).toBe(code);
  return e as ProviderRpcError;
}

async function loggedIn(answers: Record<string, unknown> = CHAIN) {
  const rpc = rpcFetch(answers);
  s = setup({ config: { evm: EVM_CONFIG }, fetch: rpc });
  await s.vault.connect(LOGGED_IN);
  return rpc;
}

describe('EIP-6963', () => {
  it('announces on creation with {uuid, name, icon, rdns} and the provider, and re-announces on requestProvider', async () => {
    s = setup({ config: { evm: EVM_CONFIG } });
    expect(announced).toHaveLength(1);
    const detail = announced[0]!.detail as { info: { uuid: string; name: string; icon: string; rdns: string }; provider: unknown };
    expect(detail.provider).toBe(s.client.ethereum);
    expect(detail.info.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(detail.info.name).toBe('Hana ID');
    expect(detail.info.icon).toBe(HANA_ID_ICON);
    expect(detail.info.icon.startsWith('data:image/svg+xml,')).toBe(true);
    expect(detail.info.rdns).toBe('test.hana.auth');
    expect(Object.isFrozen(detail) && Object.isFrozen(detail.info)).toBe(true);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced).toHaveLength(2);
    expect(announced[1]!.detail).toBe(detail);
  });

  it('stops re-announcing after destroy, and does not announce without evm config', () => {
    s = setup({ config: { evm: EVM_CONFIG } });
    s.client.destroy();
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced).toHaveLength(1);
    announced = [];
    s = setup();
    expect(announced).toHaveLength(0);
  });

  it('rdns is the reverse of the authOrigin host', () => {
    expect(rdnsFor(ORIGINS.authOrigin)).toBe('test.hana.auth');
    expect(rdnsFor('https://hana-id-auth-sandbox-dev.tingtc.workers.dev')).toBe('dev.workers.tingtc.hana-id-auth-sandbox-dev');
  });
});

describe('chains', () => {
  it('eth_chainId is the default chain; wallet_switchEthereumChain moves among evm.chains and emits chainChanged', async () => {
    await loggedIn();
    const p = s.client.ethereum;
    expect(await p.request({ method: 'eth_chainId' })).toBe('0xaa36a7');
    const changed: string[] = [];
    p.on('chainChanged', (c) => changed.push(c));
    await expect(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] })).resolves.toBeNull();
    expect(await p.request({ method: 'eth_chainId' })).toBe('0x14a34');
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    expect(changed).toEqual(['0x14a34']);
  });

  it('an unknown chain gives 4902, and the chain stays', async () => {
    await loggedIn();
    const p = s.client.ethereum;
    const e = await refused(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), 4902);
    expect(e.data).toEqual({ chainId: '0x1' });
    expect(await p.request({ method: 'eth_chainId' })).toBe('0xaa36a7');
    await refused(p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1' }] }), 4902);
    await expect(p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xaa36a7' }] })).resolves.toBeNull();
    await refused(p.request({ method: 'wallet_switchEthereumChain', params: [{}] }), -32602);
  });

  it('without evm config, chain methods give 4902', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    await refused(s.client.ethereum.request({ method: 'eth_chainId' }), 4902);
    await refused(s.client.ethereum.request({ method: 'eth_blockNumber' }), 4902);
  });

  it('createHana validates evm config', () => {
    expect(() => setup({ config: { evm: { chains: [], defaultChainId: 1 } } })).toThrow(TypeError);
    expect(() => setup({ config: { evm: { chains: [{ id: 1, rpcUrl: 'https://a.test' }], defaultChainId: 2 } } })).toThrow(/defaultChainId/u);
    expect(() => setup({ config: { evm: { chains: [{ id: 1, rpcUrl: 'ftp://a.test' }], defaultChainId: 1 } } })).toThrow(/http/u);
    expect(() => setup({ config: { evm: { chains: [{ id: 1, rpcUrl: 'https://a.test' }, { id: 1, rpcUrl: 'https://b.test' }], defaultChainId: 1 } } })).toThrow(/twice/u);
    expect(() => setup({ config: { evm: { chains: [{ id: 0, rpcUrl: 'https://a.test' }], defaultChainId: 0 } } })).toThrow(/positive/u);
  });
});

describe('accounts', () => {
  it('eth_accounts asks the vault; eth_requestAccounts returns [address] at once when logged in', async () => {
    await loggedIn();
    s.vault.handle('eth_accounts', () => ({ result: [EVM] }));
    await expect(s.client.ethereum.request({ method: 'eth_accounts' })).resolves.toEqual([EVM]);
    await expect(s.client.ethereum.request({ method: 'eth_requestAccounts' })).resolves.toEqual([EVM]);
    expect(s.open).not.toHaveBeenCalled();
  });

  it('eth_requestAccounts while logged out opens the login popup synchronously and resolves after login', async () => {
    s = setup({ config: { evm: EVM_CONFIG } });
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.ethereum.request({ method: 'eth_requestAccounts' });
    expect(s.open).toHaveBeenCalledTimes(1);
    await flush();
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    s.vault.reply(s.vault.last('hana_login').id, { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' });
    await expect(p).resolves.toEqual([EVM]);
  });

  it('eth_requestAccounts after a blocked popup goes through the launcher (hana_login {popupBlocked: true})', async () => {
    s = setup({ config: { evm: EVM_CONFIG }, popup: 'blocked' });
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_login', () => ({ result: { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' } }));
    await expect(s.client.ethereum.request({ method: 'eth_requestAccounts' })).resolves.toEqual([EVM]);
    expect(s.vault.last('hana_login').params).toEqual({ popupBlocked: true });
  });

  it('a sign-in that does not complete is 4001 with the Hana code in data', async () => {
    vi.useFakeTimers();
    s = setup({ config: { evm: EVM_CONFIG } });
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    const p = s.client.ethereum.request({ method: 'eth_requestAccounts' });
    p.catch(() => {});
    await flush();
    s.popups[0]!.closed = true;
    await vi.advanceTimersByTimeAsync(100);
    const e = await refused(p, 4001);
    expect(e.data).toEqual({ code: 'coop_blocks_popup' });
  });

  it('emits connect when the vault is ready, accountsChanged on login and logout, and disconnect when the vault dies', async () => {
    s = setup({ config: { evm: EVM_CONFIG } });
    const events: unknown[] = [];
    const p = s.client.ethereum;
    p.on('connect', (c) => events.push(['connect', c]));
    p.on('accountsChanged', (a) => events.push(['accounts', a]));
    p.on('disconnect', (e) => events.push(['disconnect', e.code]));
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_logout', () => ({ result: null }));
    await s.client.logout();
    s.vault.emit('accountsChanged', { addresses: { stellar: STELLAR, evm: EVM } });
    await flush();
    s.vault.load(); // the vault document was replaced
    await flush();
    expect(events).toEqual([['accounts', [EVM]], ['connect', { chainId: '0xaa36a7' }], ['accounts', []], ['accounts', [EVM]], ['accounts', []], ['disconnect', 4900]]);
  });

  it('supports removeListener and once (EventEmitter-compatible)', async () => {
    s = setup({ config: { evm: EVM_CONFIG } });
    const p = s.client.ethereum;
    const a = vi.fn();
    const b = vi.fn();
    p.on('chainChanged', a);
    p.once('chainChanged', b);
    p.removeListener('chainChanged', a);
    await s.vault.connect(LOGGED_IN);
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('signing', () => {
  it('eth_sendTransaction fills from the RPC, sends eth_signTransaction with 0x hex strings, and broadcasts', async () => {
    const rpc = await loggedIn();
    s.vault.handle('eth_signTransaction', () => ({ result: RAW }));
    const hash = await s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: EVM, to: TO, value: '0x1', data: '0x' }] });
    expect(hash).toBe(HASH);
    const req = s.vault.last('eth_signTransaction');
    const tx = (req.raw.params as { tx: Record<string, unknown> }).tx;
    expect(tx).toEqual({ type: '0x2', from: EVM, chainId: '0xaa36a7', nonce: '0x3', gas: '0x5208', to: TO, value: '0x1', data: '0x', maxFeePerGas: '0xd09dc300', maxPriorityFeePerGas: '0x59682f00' });
    for (const v of Object.values(tx)) expect(typeof v).toBe('string');
    for (const k of ['chainId', 'nonce', 'gas', 'value', 'data', 'maxFeePerGas', 'maxPriorityFeePerGas']) expect(tx[k]).toMatch(/^0x[0-9a-f]*$/u);
    expect(rpc.calls.map((c) => c.method)).toContain('eth_sendRawTransaction');
    expect(rpc.calls.find((c) => c.method === 'eth_sendRawTransaction')?.params).toEqual([RAW]);
    expect(s.fetch.mock.calls.every(([url]) => url === 'https://sepolia.rpc.test')).toBe(true);
  });

  it('broadcasts on the switched chain, with its chainId in the tx', async () => {
    await loggedIn();
    s.vault.handle('eth_signTransaction', () => ({ result: RAW }));
    await s.client.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    await s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    expect((s.vault.last('eth_signTransaction').params as { tx: { chainId: string } }).tx.chainId).toBe('0x14a34');
    expect(s.fetch.mock.calls.every(([url]) => url === 'https://base-sepolia.rpc.test')).toBe(true);
  });

  it('a chain switch during the approval still broadcasts on the chain the transaction was filled and signed for', async () => {
    await loggedIn();
    s.vault.handle('eth_signTransaction', () => 'manual');
    const p = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    await flush();
    const req = s.vault.last('eth_signTransaction');
    expect((req.params as { tx: { chainId: string } }).tx.chainId).toBe('0xaa36a7');
    await s.client.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    s.vault.reply(req.id, RAW);
    await expect(p).resolves.toBe(HASH);
    const broadcasts = s.fetch.mock.calls.filter(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { method: string }).method === 'eth_sendRawTransaction');
    expect(broadcasts.map(([url]) => url)).toEqual(['https://sepolia.rpc.test']);
  });

  it('a chain switch while the transaction is still being filled refuses it before the approval', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const rpc = rpcFetch(CHAIN);
    // The nonce lookup is held until the switch has happened.
    const fetch = async (url: string, init: RequestInit) => {
      if ((JSON.parse(String(init.body)) as { method: string }).method === 'eth_getTransactionCount') await held;
      return rpc(url, init);
    };
    s = setup({ config: { evm: EVM_CONFIG }, fetch });
    await s.vault.connect(LOGGED_IN);
    const p = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    await flush();
    await s.client.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    release();
    await refused(p, -32602);
    expect(s.vault.seen('eth_signTransaction')).toEqual([]);
  });

  it('back-to-back eth_sendTransaction calls on one chain run one at a time and get consecutive nonces', async () => {
    let broadcast = 0;
    const rpc = await loggedIn({
      ...CHAIN,
      // The node's 'pending' count includes every transaction broadcast so far.
      eth_getTransactionCount: () => `0x${(3 + broadcast).toString(16)}`,
      eth_sendRawTransaction: () => {
        broadcast += 1;
        return HASH;
      },
    });
    s.vault.handle('eth_signTransaction', () => 'manual');
    const approve = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO, data: '0x095ea7b3' }] });
    const swap = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO, data: '0x38ed1739' }] });
    await flush();
    // The second is not filled until the first has been broadcast.
    expect(s.vault.seen('eth_signTransaction')).toHaveLength(1);
    expect(rpc.calls.filter((c) => c.method === 'eth_getTransactionCount')).toHaveLength(1);
    s.vault.reply(s.vault.last('eth_signTransaction').id, RAW);
    await expect(approve).resolves.toBe(HASH);
    await flush();
    const signs = s.vault.seen('eth_signTransaction');
    expect(signs).toHaveLength(2);
    s.vault.reply(signs[1]!.id, RAW);
    await expect(swap).resolves.toBe(HASH);
    const txs = signs.map((r) => (r.params as { tx: { nonce: string; data: string } }).tx);
    expect(txs.map((t) => [t.data, t.nonce])).toEqual([
      ['0x095ea7b3', '0x3'],
      ['0x38ed1739', '0x4'],
    ]);
    expect(broadcast).toBe(2);
  });

  it('a rejected or failed send does not block the next one in the queue', async () => {
    const rpc = await loggedIn();
    s.vault.handle('eth_signTransaction', () => 'manual');
    const first = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    first.catch(() => {});
    const second = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    await flush();
    s.vault.replyError(s.vault.last('eth_signTransaction').id, 4001, 'User rejected');
    await refused(first, 4001);
    await flush();
    const signs = s.vault.seen('eth_signTransaction');
    expect(signs).toHaveLength(2);
    s.vault.reply(signs[1]!.id, RAW);
    await expect(second).resolves.toBe(HASH);
    expect(rpc.calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('sends on different chains do not wait for each other', async () => {
    await loggedIn();
    s.vault.handle('eth_signTransaction', () => 'manual');
    const onSepolia = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    await flush();
    await s.client.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    const onBase = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] });
    await flush();
    const signs = s.vault.seen('eth_signTransaction');
    expect(signs.map((r) => (r.params as { tx: { chainId: string } }).tx.chainId)).toEqual(['0xaa36a7', '0x14a34']);
    s.vault.reply(signs[1]!.id, RAW);
    await expect(onBase).resolves.toBe(HASH);
    s.vault.reply(signs[0]!.id, RAW);
    await expect(onSepolia).resolves.toBe(HASH);
  });

  it('a rejected approval is 4001 and nothing is broadcast', async () => {
    const rpc = await loggedIn();
    s.vault.handle('eth_signTransaction', () => ({ error: { code: 4001, message: 'User rejected' } }));
    await refused(s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] }), 4001);
    expect(rpc.calls.map((c) => c.method)).not.toContain('eth_sendRawTransaction');
  });

  it('eth_signTransaction fills and returns the raw signed tx without broadcasting', async () => {
    const rpc = await loggedIn();
    s.vault.handle('eth_signTransaction', () => ({ result: RAW }));
    await expect(s.client.ethereum.request({ method: 'eth_signTransaction', params: [{ to: TO, gas: '0x5208' }] })).resolves.toBe(RAW);
    expect(rpc.calls.map((c) => c.method)).not.toContain('eth_sendRawTransaction');
    expect(rpc.calls.map((c) => c.method)).not.toContain('eth_estimateGas');
  });

  it('refuses another from (4100), a logged-out signer (4100) and bad params (-32602) before any RPC call', async () => {
    const rpc = await loggedIn();
    await refused(s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: TO, to: TO }] }), 4100);
    await refused(s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO, foo: 1 }] }), -32602);
    await refused(s.client.ethereum.request({ method: 'eth_sendTransaction', params: [] }), -32602);
    expect(rpc.calls).toEqual([]);
    s.vault.emit('accountsChanged', { addresses: null });
    await flush();
    await refused(s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ to: TO }] }), 4100);
    await refused(s.client.ethereum.request({ method: 'personal_sign', params: ['0x68', EVM] }), 4100);
  });

  it('personal_sign: hex goes as is, text as its UTF-8 hex; the address must be the vault account', async () => {
    await loggedIn();
    s.vault.handle('personal_sign', () => ({ result: SIG }));
    await expect(s.client.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', EVM.toLowerCase()] })).resolves.toBe(SIG);
    expect(s.vault.last('personal_sign').params).toEqual(['0x68656c6c6f', EVM]);
    await s.client.ethereum.request({ method: 'personal_sign', params: ['hello', EVM] });
    expect(s.vault.last('personal_sign').params).toEqual(['0x68656c6c6f', EVM]);
    await refused(s.client.ethereum.request({ method: 'personal_sign', params: ['0x68', TO] }), 4100);
  });

  it('eth_signTypedData_v4 sends the JSON string (an object is stringified)', async () => {
    await loggedIn();
    s.vault.handle('eth_signTypedData_v4', () => ({ result: SIG }));
    const typed = { types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', domain: {}, message: {} };
    await s.client.ethereum.request({ method: 'eth_signTypedData_v4', params: [EVM, JSON.stringify(typed)] });
    expect(s.vault.last('eth_signTypedData_v4').params).toEqual([EVM, JSON.stringify(typed)]);
    await s.client.ethereum.request({ method: 'eth_signTypedData_v4', params: [EVM, typed] });
    expect(s.vault.last('eth_signTypedData_v4').params).toEqual([EVM, JSON.stringify(typed)]);
    await refused(s.client.ethereum.request({ method: 'eth_signTypedData_v4', params: [EVM, 5] }), -32602);
  });

  it('eth_sign and other signing or wallet methods are 4200, and never reach the vault or the RPC', async () => {
    const rpc = await loggedIn();
    for (const method of ['eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'wallet_sendCalls', 'eth_sendUserOperation', 'wallet_requestPermissions', 'eth_coinbase']) {
      await refused(s.client.ethereum.request({ method, params: [] }), 4200);
    }
    expect(s.vault.requests).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });

  it('forwards read-only methods to the current chain RPC, passing RPC errors through', async () => {
    const rpc = await loggedIn();
    await expect(s.client.ethereum.request({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    expect(rpc.calls).toEqual([{ method: 'eth_blockNumber', params: [] }]);
    await refused(s.client.ethereum.request({ method: 'eth_getBalance', params: [EVM, 'latest'] }), -32601);
    await refused(s.client.ethereum.request(null as never), -32602);
  });
});
