// @vitest-environment happy-dom
// The approval popup opened in the partner's click (docs/batch-b-spec.md "Approval flow" step 1, D99): every signing
// entry point opens `{authOrigin}/approve?from=partner&v=<vault frame>` synchronously when the page has user
// activation (or the browser can't tell), flags the request `popupOpened`, and otherwise leaves the vault's launcher as
// the fallback: no activation, a blocked window.open, or an approval popup that is already open (reused).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_MS, hasUserActivation } from '../../src/client/approval-window.ts';
import { HanaIdModule } from '../../src/stellar-wallets-kit.ts';
import { EVM, LOGGED_IN, LOGGED_OUT, ORIGINS, STELLAR, type Setup, type SetupOptions, flush, rpcFetch, setup } from './harness.ts';

const TESTNET = 'Test SDF Network ; September 2015';
const XDR = 'AAAAAgAAAAA=';
const SIG64 = btoa(String.fromCharCode(...new Uint8Array(64).fill(1)));
const SIG65 = `0x${'11'.repeat(64)}1b`;
const SEPOLIA = 11155111;
const EVM_CONFIG = { chains: [{ id: SEPOLIA, rpcUrl: 'https://sepolia.rpc.test' }], defaultChainId: SEPOLIA };
const TO = '0x00000000000000000000000000000000000000bb';
const CHAIN = { eth_getTransactionCount: '0x3', eth_estimateGas: '0x5208', eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' }, eth_maxPriorityFeePerGas: '0x59682f00', eth_sendRawTransaction: `0x${'ab'.repeat(32)}` };

let s: Setup;
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setActivation('missing');
  document.body.replaceChildren();
});

/** navigator.userActivation as the browser reports it: in a click (true), outside one (false), or no API at all. */
function setActivation(state: boolean | 'missing'): void {
  if (state === 'missing') {
    delete (navigator as unknown as Record<string, unknown>).userActivation;
    return;
  }
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: state, hasBeenActive: true } });
}

async function signedIn(o: SetupOptions = {}): Promise<Setup> {
  s = setup({ config: { stellar: { networkPassphrase: TESTNET }, evm: EVM_CONFIG }, ...o });
  await s.vault.connect(LOGGED_IN);
  s.vault.handle('stellar_signTransaction', () => ({ result: { signedTxXdr: XDR, signerAddress: STELLAR } }));
  s.vault.handle('stellar_signAuthEntry', () => ({ result: { signedAuthEntry: SIG64, signerAddress: STELLAR } }));
  s.vault.handle('stellar_signMessage', () => ({ result: { signedMessage: SIG64, signerAddress: STELLAR } }));
  s.vault.handle('personal_sign', () => ({ result: SIG65 }));
  s.vault.handle('eth_signTypedData_v4', () => ({ result: SIG65 }));
  s.vault.handle('eth_signTransaction', () => ({ result: '0x02f8aa' }));
  s.vault.handle('hana_signRaw', () => ({ result: { signature: new Uint8Array(64) } }));
  s.vault.handle('hana_requestAutoApprove', () => ({ result: { granted: false } }));
  return s;
}

/** The approval-popup window.open calls so far. */
const approvalOpens = () => s.open.mock.calls.filter((c) => String(c[0]).startsWith(`${ORIGINS.authOrigin}/approve`)) as [string, string, string][];
const flagged = (method: Parameters<Setup['vault']['last']>[0]) => s.vault.last(method).raw.popupOpened;

const TYPED = JSON.stringify({ types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', domain: {}, message: {} });
const ENTRY_POINTS: [string, (x: Setup) => Promise<unknown>, Parameters<Setup['vault']['last']>[0]][] = [
  ['hana.stellar.signTransaction', (x) => x.client.stellar.signTransaction(XDR), 'stellar_signTransaction'],
  ['hana.stellar.signAuthEntry', (x) => x.client.stellar.signAuthEntry(XDR), 'stellar_signAuthEntry'],
  ['hana.stellar.signMessage', (x) => x.client.stellar.signMessage('hi'), 'stellar_signMessage'],
  ['personal_sign', (x) => x.client.ethereum.request({ method: 'personal_sign', params: ['0x6869', EVM] }), 'personal_sign'],
  ['eth_signTypedData_v4', (x) => x.client.ethereum.request({ method: 'eth_signTypedData_v4', params: [EVM, TYPED] }), 'eth_signTypedData_v4'],
  ['hana.signRaw', (x) => x.client.signRaw({ chain: 'evm', digest: new Uint8Array(32) }), 'hana_signRaw'],
  ['hana.requestAutoApprove', (x) => x.client.requestAutoApprove(), 'hana_requestAutoApprove'],
  ['SWK HanaIdModule.signTransaction', (x) => new HanaIdModule(x.client).signTransaction(XDR, { networkPassphrase: TESTNET }), 'stellar_signTransaction'],
  ['SWK HanaIdModule.signAuthEntry', (x) => new HanaIdModule(x.client).signAuthEntry(XDR, { networkPassphrase: TESTNET }), 'stellar_signAuthEntry'],
  ['SWK HanaIdModule.signMessage', (x) => new HanaIdModule(x.client).signMessage('hi'), 'stellar_signMessage'],
];

describe('hasUserActivation', () => {
  it('reads navigator.userActivation.isActive, and is true when the browser has no such API', () => {
    setActivation(true);
    expect(hasUserActivation(window)).toBe(true);
    setActivation(false);
    expect(hasUserActivation(window)).toBe(false);
    setActivation('missing');
    expect(hasUserActivation(window)).toBe(true);
  });
});

describe('with user activation (a call from a click)', () => {
  it.each(ENTRY_POINTS)('%s opens the approval popup synchronously, before any await, and flags the request', async (_, call, method) => {
    await signedIn();
    setActivation(true);
    const p = call(s);
    // Synchronously in the call: no await between it and window.open.
    expect(approvalOpens()).toHaveLength(1);
    const [url, name, features] = approvalOpens()[0]!;
    expect(url).toBe(`${ORIGINS.authOrigin}/approve?from=partner&v=${s.frame.name}`);
    expect(name).toMatch(/^hana-approve-[0-9a-f]{32}$/u);
    expect(features).toBe('popup,width=420,height=680');
    await p;
    expect(flagged(method)).toBe(true);
  });

  it('eth_sendTransaction opens it before filling (no RPC call yet) and flags the eth_signTransaction', async () => {
    const rpc = rpcFetch(CHAIN);
    await signedIn({ fetch: rpc });
    setActivation(true);
    const p = s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: EVM, to: TO, value: '0x1' }] });
    expect(approvalOpens()).toHaveLength(1);
    expect(rpc.calls).toHaveLength(0);
    await p;
    expect(flagged('eth_signTransaction')).toBe(true);
  });

  it('eth_signTransaction opens it before filling too', async () => {
    const rpc = rpcFetch(CHAIN);
    await signedIn({ fetch: rpc });
    setActivation(true);
    const p = s.client.ethereum.request({ method: 'eth_signTransaction', params: [{ from: EVM, to: TO, value: '0x1' }] });
    expect(approvalOpens()).toHaveLength(1);
    // The fill's first RPC call may start in the same turn, but only after window.open.
    expect(s.open.mock.invocationCallOrder.at(-1)!).toBeLessThan(s.fetch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    await p;
    expect(flagged('eth_signTransaction')).toBe(true);
  });

  it('a fill that fails closes the window no request used', async () => {
    const rpc = rpcFetch({});
    await signedIn({ fetch: rpc });
    setActivation(true);
    await expect(s.client.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: EVM, to: TO, value: '0x1' }] })).rejects.toBeTruthy();
    expect(s.popups[0]!.close).toHaveBeenCalled();
    expect(s.vault.seen('eth_signTransaction')).toHaveLength(0);
  });

  it('a request the vault answers after it claimed the window never closes the window from here (the vault decides)', async () => {
    await signedIn();
    setActivation(true);
    s.vault.handle('personal_sign', () => ({ error: { code: 4001, message: 'User rejected' } }));
    await expect(s.client.ethereum.request({ method: 'personal_sign', params: ['0x6869', EVM] })).rejects.toBeTruthy();
    expect(s.popups[0]!.close).not.toHaveBeenCalled();
  });

  it('when the browser has no userActivation API it tries anyway', async () => {
    await signedIn();
    setActivation('missing');
    await s.client.stellar.signMessage('hi');
    expect(approvalOpens()).toHaveLength(1);
    expect(flagged('stellar_signMessage')).toBe(true);
  });

  it('logged out: no approval popup (there is nothing to sign)', async () => {
    s = setup({ config: { stellar: { networkPassphrase: TESTNET } } });
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('stellar_signMessage', () => ({ error: { code: 4100, message: 'Not logged in' } }));
    setActivation(true);
    await expect(s.client.stellar.signMessage('hi')).rejects.toBeTruthy();
    expect(approvalOpens()).toHaveLength(0);
    expect(s.vault.last('stellar_signMessage').raw.popupOpened).toBeUndefined();
  });

  it('methods that never show the popup never open one', async () => {
    await signedIn();
    setActivation(true);
    s.vault.handle('eth_accounts', () => ({ result: [EVM] }));
    s.vault.handle('stellar_getAddress', () => ({ result: { address: STELLAR } }));
    s.vault.handle('hana_autoApproveStatus', () => ({ result: null }));
    await s.client.ethereum.request({ method: 'eth_accounts' });
    await s.client.ethereum.request({ method: 'eth_chainId' });
    await s.client.stellar.getAddress();
    await s.client.autoApproveStatus();
    expect(approvalOpens()).toHaveLength(0);
    expect(s.vault.requests.some((r) => r.raw.popupOpened !== undefined)).toBe(false);
  });
});

describe('the launcher stays the fallback', () => {
  it('without activation (a call outside a click, or after Safari dropped it) nothing opens and the request is not flagged', async () => {
    await signedIn();
    setActivation(false);
    await s.client.stellar.signMessage('hi');
    expect(approvalOpens()).toHaveLength(0);
    expect(flagged('stellar_signMessage')).toBeUndefined();
  });

  it('window.open returning null (a popup blocker): not flagged, the vault shows its launcher', async () => {
    await signedIn({ popup: 'blocked' });
    setActivation(true);
    await s.client.ethereum.request({ method: 'personal_sign', params: ['0x6869', EVM] });
    expect(approvalOpens()).toHaveLength(1);
    expect(flagged('personal_sign')).toBeUndefined();
  });

  it('window.open throwing, or returning a handle that is already closed (COOP-severed), counts as blocked', async () => {
    await signedIn();
    setActivation(true);
    s.open.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    await s.client.stellar.signMessage('a');
    expect(flagged('stellar_signMessage')).toBeUndefined();
    s.open.mockImplementationOnce(() => ({ closed: true, close: vi.fn(), focus: vi.fn() }));
    await s.client.stellar.signMessage('b');
    expect(flagged('stellar_signMessage')).toBeUndefined();
  });
});

describe('reuse: one approval window at a time', () => {
  it('a second request while the window it opened is open opens nothing, focuses it and is not flagged', async () => {
    await signedIn();
    setActivation(true);
    await s.client.stellar.signMessage('one');
    const popup = s.popups[0]!;
    const focus = vi.spyOn(popup, 'focus');
    await s.client.stellar.signMessage('two');
    expect(approvalOpens()).toHaveLength(1);
    expect(focus).toHaveBeenCalled();
    expect(flagged('stellar_signMessage')).toBeUndefined();
    // Two calls in one click (approve, then swap): one window.
    const a = s.client.ethereum.request({ method: 'personal_sign', params: ['0x01', EVM] });
    const b = s.client.ethereum.request({ method: 'personal_sign', params: ['0x02', EVM] });
    await Promise.all([a, b]);
    expect(approvalOpens()).toHaveLength(1);
  });

  it('once the window closed, the next click opens a new one', async () => {
    await signedIn();
    setActivation(true);
    await s.client.stellar.signMessage('one');
    s.popups[0]!.closed = true;
    await s.client.stellar.signMessage('two');
    expect(approvalOpens()).toHaveLength(2);
    expect(flagged('stellar_signMessage')).toBe(true);
  });

  it('while the vault reports its own approval window open (approvalWindow), nothing opens; once it is closed, one does', async () => {
    await signedIn();
    setActivation(true);
    s.vault.emit('approvalWindow', { open: true });
    await flush();
    await s.client.stellar.signMessage('one');
    expect(approvalOpens()).toHaveLength(0);
    expect(flagged('stellar_signMessage')).toBeUndefined();
    s.vault.emit('approvalWindow', { open: false });
    await flush();
    await s.client.stellar.signMessage('two');
    expect(approvalOpens()).toHaveLength(1);
  });

  it(`a window older than ${CLAIM_MS} ms is no longer claimed by a new request`, async () => {
    let now = 0;
    await signedIn({ now: () => now });
    setActivation(true);
    const ticket = s.client.prepareApproval();
    now = CLAIM_MS + 1;
    setActivation(false);
    await s.client.stellar.signMessage('late');
    expect(flagged('stellar_signMessage')).toBeUndefined();
    ticket.cancel();
  });
});

describe('hana.prepareApproval()', () => {
  it('opens the window now for a signing call made after an await, which then claims it', async () => {
    await signedIn();
    setActivation(true);
    const ticket = s.client.prepareApproval();
    expect(approvalOpens()).toHaveLength(1);
    setActivation(false); // the activation is gone after the partner's await (Safari)
    await Promise.resolve();
    await s.client.stellar.signTransaction(XDR);
    expect(approvalOpens()).toHaveLength(1);
    expect(flagged('stellar_signTransaction')).toBe(true);
    ticket.cancel(); // claimed: nothing to close
    expect(s.popups[0]!.close).not.toHaveBeenCalled();
  });

  it('cancel() closes a window no request used; opening nothing gives a no-op ticket', async () => {
    await signedIn();
    setActivation(true);
    s.client.prepareApproval().cancel();
    expect(s.popups[0]!.close).toHaveBeenCalled();
    setActivation(false);
    expect(() => s.client.prepareApproval().cancel()).not.toThrow();
    expect(approvalOpens()).toHaveLength(1);
  });
});
