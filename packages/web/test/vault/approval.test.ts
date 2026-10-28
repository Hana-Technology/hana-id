// Signing and approval (docs/batch-b-spec.md "Signing and approval", "Approval flow", "What gets signed"; Tests →
// Web unit → Approval, Raw signing). The approval popup is simulated as the auth page runs it: hello, then a result
// with the digest of what it rendered.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SIGN_MESSAGE_MAX_BYTES, TEST_APP_RAW_RULE, base64Decode, base64Encode, parsePortRequest, recoverEvmAddress, toHex, utf8 } from '@hana-id/core';
import { verifyStellarSignature } from '@hana-id/core/signers/stellar';
import { POLICY_FRESH_MS } from '../../src/vault/vault.ts';
import { Browser, ENV, FakeWindow, type Google, PARTNER, type Tab, answer, apiError, approveDigest, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import {
  CHAIN,
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

/** Event-driven (the launcher view and its `ui` event on the port), so a loaded machine only slows it down. */
const waitLabel = (t: Tab, label: string): Promise<void> => waitLauncher(t, label);

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
    expect(m).toMatchObject({ kind: 'evm_tx', chain: 'evm', address: s.evm, context: { chainId: CHAIN } });
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

  it('the largest sign request the port accepts still reaches the popup (the approval cap leaves room for its other fields)', async () => {
    const s = await session();
    // The port request fits its 192 KiB cap; the approval request adds the app name, origin, address and context,
    // which APPROVAL_MESSAGE_MAX_BYTES has room for. (A message the popup would still drop is refused at once:
    // units.test.ts "Approvals".)
    const message = new Uint8Array(SIGN_MESSAGE_MAX_BYTES - 128).fill(0x61);
    expect(parsePortRequest({ v: 1, id: 'r-big', method: 'stellar_signMessage', params: { message } })).not.toBeNull();
    const reply = s.t.request('stellar_signMessage', { message });
    await waitLabel(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    expect((m.bytes as Uint8Array).length).toBe(message.length);
    answer(s.t, popup, m, true);
    expect((await reply).error).toBeUndefined();
  });

  it('at most 100 requests wait for approval: the next is refused at once (4100 too_many_pending)', async () => {
    const s = await session();
    const waiting = Array.from({ length: 100 }, (_, i) => s.t.request('personal_sign', [`0x${(i + 1).toString(16).padStart(2, '0')}`, s.evm]));
    const approvals = (s.t.vault as unknown as { approvals: { pending: number } }).approvals;
    for (let i = 0; i < 200 && approvals.pending < 100; i++) await sleepReal(5);
    expect(approvals.pending).toBe(100);
    expect((await s.t.request('personal_sign', ['0x6869', s.evm])).error).toMatchObject({ code: 4100, data: { reason: 'too_many_pending' } });
    // The popup shows "1 of 100".
    await waitLabel(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    expect(await popup.next('hana:approve-request')).toMatchObject({ position: 1, queued: 100 });
    await s.t.request('hana_logout');
    for (const r of await Promise.all(waiting)) expect(r.error?.code).toBe(4900);
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
  // Raw signing is for live apps only: a test app's raw request is refused whatever its setting (D39).
  const LIVE = 'pk_live_1111111111111111111111';

  it('a test app (pk_test_) can never sign raw, even with raw signing on: 4100 at once, no popup, no API read', async () => {
    const s = await session({ config: makeConfig({ settings: { rawSign: 'approval' } }) });
    const reads = s.t.browser.backend.count('/v1/app');
    for (const params of [{ chain: 'evm', digest: new Uint8Array(32).fill(1) }, { chain: 'stellar', bytes: new Uint8Array(32).fill(2) }]) {
      const reply = await s.t.request('hana_signRaw', params);
      expect(reply.error).toEqual({ code: 4100, message: TEST_APP_RAW_RULE, data: { reason: 'raw_not_allowed_for_test_apps' } });
    }
    expect(s.t.browser.backend.count('/v1/app')).toBe(reads);
    await sleepReal(20);
    expect(s.t.launcher.label).toBeNull();
  });

  it('is 4100 when the app has raw signing off', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE }) });
    const reply = await s.t.request('hana_signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(1) });
    expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'raw_sign_off' } });
    expect(s.t.launcher.label).toBeNull();
  });

  it('a digest that differs only in the chain produces no signature (4001)', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE, settings: { rawSign: 'approval' } }) });
    // 32 bytes fit a raw request on either chain, so only the chain differs.
    const { reply, popup, m } = await shown(s, 'hana_signRaw', { chain: 'stellar', bytes: new Uint8Array(32).fill(3) });
    answer(s.t, popup, m, true, approveDigest({ ...m, chain: 'evm', address: s.evm }));
    expect((await reply).error?.code).toBe(4001);
  });

  it('needs approval in "approval" mode; the popup gets kind raw (never decoded) and the signature verifies', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE, settings: { rawSign: 'approval' } }) });
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
  /** A session whose API clock moves with the test's, with raw signing on when the page loaded. */
  async function rawSession(): Promise<Session> {
    const browser = new Browser();
    browser.backend.serverNow = () => browser.timers.now;
    const t = await readyTab(browser, { googleJwk: g.jwk, config: makeConfig({ publishableKey: LIVE, settings: { rawSign: 'approval' } }) });
    tabs.push(t);
    const { reply } = await login(t, g);
    const a = (reply.result as { addresses: { stellar: string; evm: string } }).addresses;
    return { t, stellar: a.stellar, evm: a.evm };
  }
  const raw = { chain: 'evm', digest: new Uint8Array(32).fill(0xab) };
  const appReads = (s: Session) => s.t.browser.backend.count('/v1/app');

  it("'off' takes effect in an open tab: a raw request re-reads GET /v1/app once the last check is 10 s old", async () => {
    const s = await rawSession();
    s.t.browser.backend.rawSign = 'off';
    s.t.browser.timers.advance(POLICY_FRESH_MS);
    const before = appReads(s);
    const reply = await s.t.request('hana_signRaw', raw);
    expect(reply.error).toEqual({ code: 4100, message: 'Raw signing is off for this app', data: { reason: 'raw_sign_off' } });
    expect(appReads(s)).toBe(before + 1);
    expect(s.t.launcher.label).toBeNull();
    // It stays off in this tab even if the API serves 'approval' again (enabling waits for a reload).
    s.t.browser.backend.rawSign = 'approval';
    s.t.browser.timers.advance(POLICY_FRESH_MS);
    expect((await s.t.request('hana_signRaw', raw)).error?.data).toEqual({ reason: 'raw_sign_off' });
  });

  it('a check younger than 10 s is reused; an older one is redone before the popup', async () => {
    const s = await rawSession();
    // The login read GET /v1/app just now: no other read for this request.
    let before = appReads(s);
    const first = await shown(s, 'hana_signRaw', raw);
    expect(appReads(s)).toBe(before);
    answer(s.t, first.popup, first.m, true);
    expect((await first.reply).result).toBeDefined();
    s.t.browser.timers.advance(POLICY_FRESH_MS);
    before = appReads(s);
    const second = s.t.request('hana_signRaw', raw);
    const m = await first.popup.next('hana:approve-request', 1);
    expect(appReads(s)).toBe(before + 1);
    answer(s.t, first.popup, m, true);
    expect((await second).result).toBeDefined();
  });

  it('refuses when the re-read fails (raw signing fails closed)', async () => {
    const s = await rawSession();
    s.t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    s.t.browser.timers.advance(POLICY_FRESH_MS);
    const reply = await s.t.request('hana_signRaw', raw);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'raw_sign_unconfirmed' } });
    expect(s.t.launcher.label).toBeNull();
    // Once the API answers again, raw requests go through.
    s.t.browser.backend.overrides.delete('/v1/app');
    const again = s.t.request('hana_signRaw', raw);
    await waitLabel(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    answer(s.t, popup, await popup.next('hana:approve-request'), true);
    expect((await again).result).toBeDefined();
  });
});
