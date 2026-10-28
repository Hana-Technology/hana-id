// Signing and approval (docs/batch-b-spec.md "Signing and approval", "Approval flow", "What gets signed"; Tests →
// Web unit → Approval, Raw signing). The approval popup is simulated as the auth page runs it: hello, then a result
// with the digest of what it rendered.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base64Decode, base64Encode, recoverEvmAddress, toHex, utf8 } from '@hana-id/core';
import { verifyStellarSignature } from '@hana-id/core/signers/stellar';
import { Browser, ENV, FakeWindow, type Google, PARTNER, type Tab, answer, approveDigest, google, login, makeConfig, openApproval, readyTab, sleepReal } from './harness.ts';
import {
  EVM_VAULT,
  PASSPHRASE,
  POOL,
  addr,
  authPreimage,
  evmTx,
  evmTxSigner,
  invoke,
  payment,
  personalSigner,
  stellarAuthSignedBy,
  stellarMessageSignedBy,
  stellarTx,
  stellarTxSignedBy,
  typedData,
  typedSigner,
} from './chains.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

interface Session {
  t: Tab;
  stellar: string;
  evm: string;
}

async function session(o: Parameters<typeof readyTab>[1] = {}): Promise<Session> {
  const t = await readyTab(new Browser(), { googleJwk: g.jwk, ...o });
  tabs.push(t);
  const { reply } = await login(t, g);
  const a = (reply.result as { addresses: { stellar: string; evm: string } }).addresses;
  return { t, stellar: a.stellar, evm: a.evm };
}

/** Sends a sign request, opens the approval popup from the launcher and returns the request it shows. */
async function shown(s: Session, method: string, params: unknown) {
  const reply = s.t.request(method, params);
  await waitLabel(s.t, 'Review in Hana');
  const popup = openApproval(s.t);
  const m = await popup.next('hana:approve-request');
  return { reply, popup, m };
}

async function waitLabel(t: Tab, label: string): Promise<void> {
  for (let i = 0; i < 200 && t.launcher.label !== label; i++) await sleepReal(5);
  expect(t.launcher.label).toBe(label);
}

describe('approval flow', () => {
  it('queues the request, shows the launcher, and the launcher click opens /approve; the popup sees the whole request', async () => {
    const s = await session();
    const message = 'Sign in to Partner';
    const reply = s.t.request('stellar_signMessage', { message });
    await waitLabel(s.t, 'Review in Hana');
    expect(s.t.events.filter((e) => e.event === 'ui').at(-1)!.data).toEqual({ launcher: 'show', label: 'Review in Hana' });
    s.t.launcher.click();
    const popup = s.t.opened.at(-1)!;
    expect(popup.url).toBe(`${ENV.authOrigin}/approve`);
    expect(popup.name).toMatch(/^hana-approve-[0-9a-f]{32}$/u);
    expect(popup.features).toBe('popup,width=420,height=680');
    // Nothing is sent before the popup's hello.
    expect(popup.posted).toHaveLength(0);
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: popup });
    const m = await popup.next('hana:approve-request');
    expect(popup.posted[0]!.targetOrigin).toBe(ENV.authOrigin);
    expect(m).toMatchObject({ appName: 'Partner', parentOrigin: PARTNER, kind: 'stellar_message', chain: 'stellar', address: s.stellar, context: {}, position: 1, queued: 1 });
    expect(m.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(toHex(m.bytes as Uint8Array)).toBe(toHex(utf8(message)));
    answer(s.t, popup, m, true);
    const r = (await reply).result as { signedMessage: string; signerAddress: string };
    expect(r.signerAddress).toBe(s.stellar);
    expect(stellarMessageSignedBy(message, r.signedMessage, s.stellar)).toBe(true);
    // The launcher is gone once nothing waits.
    expect(s.t.launcher.label).toBeNull();
  });

  it('a digest mismatch, including one where only the context differs, produces no signature (4001)', async () => {
    const s = await session();
    const xdr = stellarTx(s.stellar, [payment()]);
    const { reply, popup, m } = await shown(s, 'stellar_signTransaction', { xdr, networkPassphrase: PASSPHRASE });
    // The popup rendered another network: the digest over that context doesn't match.
    answer(s.t, popup, m, true, approveDigest({ ...m, context: { networkPassphrase: 'Public Global Stellar Network ; September 2015' } }));
    expect((await reply).error?.code).toBe(4001);
  });

  it('ignores a result from a wrong source or origin, and a stale or unknown id; the request stays pending', async () => {
    const s = await session();
    const { reply, popup, m } = await shown(s, 'personal_sign', ['0x68656c6c6f', s.evm]);
    const digest = approveDigest(m);
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-result', id: m.id, approved: true, digest }, origin: ENV.authOrigin, source: new FakeWindow() });
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-result', id: m.id, approved: true, digest }, origin: 'https://evil.test', source: popup });
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-result', id: m.id, approved: true, digest }, origin: ENV.vaultOrigin, source: popup });
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-result', id: 'ab'.repeat(16), approved: true, digest }, origin: ENV.authOrigin, source: popup });
    await sleepReal(40);
    expect(s.t.replies.find((r) => r.result !== undefined && typeof r.result === 'string' && r.result.length === 132)).toBeUndefined();
    answer(s.t, popup, m, true);
    const sig = (await reply).result as string;
    expect(personalSigner('0x68656c6c6f', sig)).toBe(s.evm);
  });

  it('a request older than 5 min gives 4001, and its late approval signs nothing', async () => {
    const s = await session();
    const { reply, popup, m } = await shown(s, 'personal_sign', ['0x68656c6c6f', s.evm]);
    s.t.browser.timers.advance(5 * 60_000);
    expect((await reply).error?.code).toBe(4001);
    answer(s.t, popup, m, true);
    await sleepReal(30);
    expect(s.t.replies.filter((r) => typeof r.result === 'string')).toHaveLength(0);
  });

  it('Reject gives 4001', async () => {
    const s = await session();
    const { reply, popup, m } = await shown(s, 'stellar_signMessage', { message: 'x' });
    answer(s.t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
  });

  it('a popup closed while a request is on show gives 4001; the rest of the queue waits for the launcher', async () => {
    const s = await session();
    const { reply, popup } = await shown(s, 'stellar_signMessage', { message: 'one' });
    const second = s.t.request('stellar_signMessage', { message: 'two' });
    popup.closed = true;
    expect((await reply).error?.code).toBe(4001);
    await waitLabel(s.t, 'Review in Hana');
    const popup2 = openApproval(s.t);
    const m2 = await popup2.next('hana:approve-request');
    expect(toHex(m2.bytes as Uint8Array)).toBe(toHex(utf8('two')));
    answer(s.t, popup2, m2, true);
    expect((await second).result).toHaveProperty('signedMessage');
  });

  it('keeps the queue order and positions, and reuses the open popup within 15 s (focus, no launcher)', async () => {
    const s = await session();
    const first = s.t.request('stellar_signMessage', { message: 'one' });
    const second = s.t.request('stellar_signMessage', { message: 'two' });
    await waitLabel(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m1 = await popup.next('hana:approve-request');
    expect(m1).toMatchObject({ position: 1, queued: 2 });
    expect(toHex(m1.bytes as Uint8Array)).toBe(toHex(utf8('one')));
    answer(s.t, popup, m1, true);
    const m2 = await popup.next('hana:approve-request', 1);
    expect(m2).toMatchObject({ position: 2, queued: 2 });
    expect(m2.id).not.toBe(m1.id);
    answer(s.t, popup, m2, true);
    await first;
    await second;
    // A follow-up within 15 s goes straight to the same popup, focused, without the launcher.
    s.t.browser.timers.advance(10_000);
    const focused = popup.focused;
    const third = s.t.request('stellar_signMessage', { message: 'three' });
    const m3 = await popup.next('hana:approve-request', 2);
    expect(m3).toMatchObject({ position: 3, queued: 3 });
    expect(popup.focused).toBeGreaterThan(focused);
    expect(s.t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(1);
    answer(s.t, popup, m3, true);
    await third;
  });

  it('after 15 s idle the popup is not reused: the launcher shows again and a new popup opens', async () => {
    const s = await session();
    const { reply, popup, m } = await shown(s, 'stellar_signMessage', { message: 'one' });
    answer(s.t, popup, m, true);
    await reply;
    s.t.browser.timers.advance(16_000);
    const next = s.t.request('stellar_signMessage', { message: 'two' });
    await waitLabel(s.t, 'Review in Hana');
    expect(popup.closed).toBe(true);
    const popup2 = openApproval(s.t);
    expect(popup2).not.toBe(popup);
    const m2 = await popup2.next('hana:approve-request');
    expect(m2).toMatchObject({ position: 1, queued: 1 });
    answer(s.t, popup2, m2, true);
    await next;
  });

  it('approve-bye ends the popup: the next request needs the launcher', async () => {
    const s = await session();
    const { reply, popup, m } = await shown(s, 'stellar_signMessage', { message: 'one' });
    answer(s.t, popup, m, true);
    await reply;
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-bye' }, origin: ENV.authOrigin, source: popup });
    const next = s.t.request('stellar_signMessage', { message: 'two' });
    await waitLabel(s.t, 'Review in Hana');
    const popup2 = openApproval(s.t);
    answer(s.t, popup2, await popup2.next('hana:approve-request'), true);
    await next;
  });

  it('a hello from a window the vault did not open is ignored', async () => {
    const s = await session();
    const reply = s.t.request('stellar_signMessage', { message: 'x' });
    await waitLabel(s.t, 'Review in Hana');
    const foreign = new FakeWindow();
    s.t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: foreign });
    await sleepReal(30);
    expect(foreign.posted).toHaveLength(0);
    const popup = openApproval(s.t);
    answer(s.t, popup, await popup.next('hana:approve-request'), true);
    await reply;
  });

  it('logout while requests wait gives 4900 and closes the popup', async () => {
    const s = await session();
    const { reply, popup } = await shown(s, 'stellar_signMessage', { message: 'x' });
    await s.t.request('hana_logout');
    expect((await reply).error?.code).toBe(4900);
    expect(popup.closed).toBe(true);
  });
});

describe('what gets signed', () => {
  it('Stellar transaction: a signature over the network hash, appended to the envelope', async () => {
    const s = await session();
    const xdr = stellarTx(s.stellar, [invoke(POOL, 'swap', [addr(s.stellar)])]);
    const { reply, popup, m } = await shown(s, 'stellar_signTransaction', { xdr, networkPassphrase: PASSPHRASE, address: s.stellar });
    expect(m).toMatchObject({ kind: 'stellar_tx', context: { networkPassphrase: PASSPHRASE } });
    expect(base64Encode(m.bytes as Uint8Array)).toBe(xdr);
    answer(s.t, popup, m, true);
    const r = (await reply).result as { signedTxXdr: string; signerAddress: string };
    expect(r.signerAddress).toBe(s.stellar);
    expect(stellarTxSignedBy(r.signedTxXdr, s.stellar)).toBe(true);
  });

  it('Stellar auth entry: Ed25519 over sha256(HashIdPreimage)', async () => {
    const s = await session();
    const preimageXdr = authPreimage(POOL, 'swap', [addr(s.stellar)]);
    const { reply, popup, m } = await shown(s, 'stellar_signAuthEntry', { preimageXdr, networkPassphrase: PASSPHRASE });
    expect(m.kind).toBe('stellar_auth_entry');
    answer(s.t, popup, m, true);
    const r = (await reply).result as { signedAuthEntry: string };
    expect(stellarAuthSignedBy(preimageXdr, r.signedAuthEntry, s.stellar)).toBe(true);
  });

  it('EVM EIP-1559 transaction: signed by the vault key; fields crossed the port as 0x hex', async () => {
    const s = await session();
    const tx = evmTx();
    const { reply, popup, m } = await shown(s, 'eth_signTransaction', { tx });
    expect(m).toMatchObject({ kind: 'evm_tx', chain: 'evm', address: s.evm, context: { chainId: 8453 } });
    answer(s.t, popup, m, true);
    expect(evmTxSigner((await reply).result as string, tx)).toBe(s.evm);
  });

  it('eth_signTypedData_v4: EIP-712 over the normalized object', async () => {
    const s = await session();
    const json = typedData(EVM_VAULT, 'Order', { owner: s.evm, amount: '5' }, [
      { name: 'owner', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ]);
    const { reply, popup, m } = await shown(s, 'eth_signTypedData_v4', [s.evm, json]);
    expect(m.kind).toBe('eip712');
    answer(s.t, popup, m, true);
    expect(typedSigner(json, (await reply).result as string)).toBe(s.evm);
  });

  it('refuses malformed typed data before anything is shown', async () => {
    const s = await session();
    const reply = await s.t.request('eth_signTypedData_v4', [s.evm, '{"types":{},"primaryType":"X","domain":{},"message":{}}']);
    expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'invalid_request' } });
    expect(s.t.launcher.label).toBeNull();
  });

  it.each([
    ['stellar_signMessage', (_: Session) => ({ message: 'x', address: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ' })],
    ['personal_sign', (_: Session) => ['0x00', '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23']],
    ['eth_signTypedData_v4', (_: Session) => ['0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', '{}']],
    ['eth_signTransaction', (_: Session) => ({ tx: evmTx({ from: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23' }) })],
  ] as const)('%s naming another address is 4100', async (method, params) => {
    const s = await session();
    const reply = await s.t.request(method, params(s));
    expect(reply.error?.code).toBe(4100);
  });
});

describe('raw signing', () => {
  it('is 4100 when the app has raw signing off', async () => {
    const s = await session();
    expect((await s.t.request('hana_signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(1) })).error?.code).toBe(4100);
    expect(s.t.launcher.label).toBeNull();
  });

  it('needs approval in "approval" mode; the popup gets kind raw (never decoded) and the signature verifies', async () => {
    const s = await session({ config: makeConfig({ settings: { rawSign: 'approval' } }) });
    const digest = new Uint8Array(32).fill(0xab);
    const evm = await shown(s, 'hana_signRaw', { chain: 'evm', digest });
    expect(evm.m).toMatchObject({ kind: 'raw', chain: 'evm', context: {} });
    answer(s.t, evm.popup, evm.m, true);
    const sig = ((await evm.reply).result as { signature: Uint8Array }).signature;
    expect(sig).toHaveLength(65);
    expect([27, 28]).toContain(sig[64]);
    expect(recoverEvmAddress(digest, sig)).toBe(s.evm);

    // A raw Stellar request whose bytes are a valid transaction's hash is still shown as raw.
    const txHashLike = new Uint8Array(base64Decode(stellarTx(s.stellar, [payment()])).subarray(0, 32));
    const st = s.t.request('hana_signRaw', { chain: 'stellar', bytes: txHashLike });
    const m = await evm.popup.next('hana:approve-request', 1);
    expect(m).toMatchObject({ kind: 'raw', chain: 'stellar' });
    answer(s.t, evm.popup, m, true);
    const ssig = ((await st).result as { signature: Uint8Array }).signature;
    expect(verifyStellarSignature(s.stellar, txHashLike, ssig)).toBe(true);
  });
});
