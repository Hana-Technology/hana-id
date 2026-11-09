// The mainnet demo exception to D39 in the vault (D428, D429; docs/mainnet-demo-and-key-export-spec.md): a pk_test_
// app with `mainnetDemo` on, in a dev testnet build, signs on Base and Stellar's public network through the approval
// popup, under the per-transaction cap; everything else stays refused before any popup. The valuation's own cases
// are in packages/core/test/mainnet-demo.test.ts.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STELLAR_MAINNET_PASSPHRASE, TEST_APP_NETWORK_RULE, identityMessage, mainnetDemoEventPayload } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';
import { Asset, Operation } from '@stellar/stellar-base';
import { APP_ID, Browser, ENV, type Google, HOUR, type Tab, answer, answerConsent, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import { EVM_VAULT, OTHER, SODAX_ASSET_MANAGER_BASE, evmTx, evmTxSigner, sodaxBridgeDeposit, sodaxEmptyDeposit, sodaxSwapDeposit, stellarTx } from './chains.ts';

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

/** Inside the price table's validity (it was reviewed 2026-11-06 and expires 2026-12-21). */
const NOW = Date.UTC(2026, 10, 10);
const BASE = '0x2105';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const word = (n: bigint | string) => (typeof n === 'string' ? n.toLowerCase().replace(/^0x/u, '').padStart(64, '0') : n.toString(16).padStart(64, '0'));
const usdcTransfer = (to: string, amount: bigint) => `${functionSelector('transfer(address,uint256)')}${word(to)}${word(amount)}`;
/** A plain ETH send on Base worth about $8 at the table's $8,000 (and a fee of 100,000 wei). */
const send = (over: Record<string, string> = {}) => evmTx({ chainId: BASE, to: EVM_VAULT, value: `0x${(10n ** 15n).toString(16)}`, data: '0x', ...over });

async function session(o: { demo?: boolean; env?: typeof ENV; policy?: Record<string, unknown> } = {}) {
  const browser = new Browser();
  browser.backend.serverNow = () => NOW;
  if (o.demo !== false) browser.backend.app = { ...browser.backend.app, mainnetDemo: true };
  const t = await readyTab(browser, { googleJwk: g.jwk, config: makeConfig({ serverTimeMs: NOW, ...(o.policy ? { settings: { autoApprovePolicy: o.policy } } : {}) }), ...(o.env ? { env: o.env } : {}) });
  tabs.push(t);
  const { reply } = await login(t, g, { iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600 });
  if (!reply.result) throw new Error(`login failed: ${JSON.stringify(reply.error)}`);
  const a = (reply.result as { addresses: { stellar: string; evm: string } }).addresses;
  return { t, ...a };
}

const approvePopups = (t: Tab) => t.opened.filter((w) => w.url.endsWith('/approve'));
const demoEvents = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/mainnet-demo/events');

describe('the mainnet demo in the vault', () => {
  it("off: a Base transaction is refused at once, as D39 says (the setting is re-read when older than 10 s)", async () => {
    const s = await session({ demo: false });
    s.t.browser.timers.advance(11_000);
    const before = s.t.browser.backend.count("/v1/app");
    const reply = await s.t.request('eth_signTransaction', { tx: send() });
    expect(reply.error).toEqual({ code: 4100, message: TEST_APP_NETWORK_RULE, data: { reason: 'mainnet_not_allowed', chain: 'evm', chainId: 8453 } });
    expect(s.t.browser.backend.count('/v1/app')).toBe(before + 1);
    await sleepReal(20);
    expect(approvePopups(s.t)).toHaveLength(0);
  });

  it('on: a Base send under the cap goes to the approval popup, is signed, and is reported without key material', async () => {
    const s = await session();
    const tx = send();
    const reply = s.t.request('eth_signTransaction', { tx });
    await waitLauncher(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    expect(m).toMatchObject({ context: { chainId: 8453 }, testApp: true });
    answer(s.t, popup, m, true);
    expect(evmTxSigner((await reply).result as string, tx)).toBe(s.evm);
    await sleepReal(20);
    const events = demoEvents(s.t);
    expect(events).toHaveLength(1);
    // The event, signed by the session key with the session's wallet proof of the address (D428 as reviewed): no key,
    // no signature of the signed transaction, no transaction bytes.
    const b = events[0]!.body as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(['chain', 'issuedAtMs', 'kind', 'network', 'nonce', 'sessionPublicKey', 'signature', 'usdMicros', 'walletProof']);
    expect(b).toMatchObject({ chain: 'evm', network: '8453', kind: 'evm_tx', usdMicros: '8000001', walletProof: { address: s.evm } });
    const signedTx = ((await reply).result as string).toLowerCase();
    expect(JSON.stringify(b).toLowerCase()).not.toContain(signedTx.slice(2, 66));
    // It verifies as the API checks it: the session key over identityMessage(mainnetDemoEventPayload).
    const payload = mainnetDemoEventPayload({ chain: 'evm', network: '8453', kind: 'evm_tx', usdMicros: '8000001', walletProof: { address: s.evm, signature: Uint8Array.from((b.walletProof as { signature: number[] }).signature) } });
    const message = identityMessage({ signer: ENV.signer, appId: APP_ID, sessionPublicKey: Uint8Array.from(b.sessionPublicKey as number[]), issuedAtMs: b.issuedAtMs as number, nonce: Uint8Array.from(b.nonce as number[]), payload });
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(b.sessionPublicKey as number[]), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(b.signature as number[]), message)).toBe(true);
  });

  it('on: a Stellar public-network payment under the cap is signed through the popup', async () => {
    const s = await session();
    const xdr = stellarTx(s.stellar, [Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '2' })]);
    const reply = s.t.request('stellar_signTransaction', { xdr, networkPassphrase: STELLAR_MAINNET_PASSPHRASE });
    await waitLauncher(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    expect(m).toMatchObject({ context: { networkPassphrase: STELLAR_MAINNET_PASSPHRASE }, testApp: true });
    answer(s.t, popup, m, true);
    expect((await reply).error).toBeUndefined();
    await sleepReal(20);
    expect(demoEvents(s.t)[0]!.body).toMatchObject({ chain: 'stellar', network: 'pubnet', kind: 'stellar_tx', walletProof: { address: s.stellar } });
  });

  it.each([
    ['over the cap', () => send({ value: `0x${(2n * 10n ** 15n).toString(16)}` }), 'mainnet_demo_over_cap', 'Refused: over Hana’s $9.99 mainnet demo limit per transaction'],
    ['a token with no price', () => send({ to: '0x4200000000000000000000000000000000000006', value: '0x0', data: usdcTransfer(EVM_VAULT, 1n) }), 'mainnet_demo_unpriced', 'Refused: Hana has no price for an asset this moves (mainnet demo)'],
    ['calldata Hana can’t value', () => send({ value: '0x0', data: '0xdeadbeef' }), 'mainnet_demo_unknown_call', 'Refused: Hana can’t tell how much this mainnet request moves'],
  ] as const)('on: refuses %s before any popup, and says so in the launcher', async (_, make, reason, flash) => {
    const s = await session();
    const reply = await s.t.request('eth_signTransaction', { tx: make() });
    expect(reply.error).toMatchObject({ code: 4100, data: { reason, chain: 'evm', chainId: 8453 } });
    expect((reply.error as { message: string }).message).not.toMatch(/0x[0-9a-f]{64}/u);
    if (reason === 'mainnet_demo_over_cap') expect(reply.error).toMatchObject({ message: 'Hana’s mainnet demo signs at most $9.99 per transaction; this one can move about $16.01', data: { usd: '$16.01' } });
    expect(s.t.launcher.history).toContain(flash);
    await sleepReal(20);
    expect(approvePopups(s.t)).toHaveLength(0);
    expect(demoEvents(s.t)).toHaveLength(0);
  });

  describe('a Sodax USDC bridge (D476)', () => {
    const bridge = (recipient: string, signer: string, hubWallet?: string) => send({ to: SODAX_ASSET_MANAGER_BASE, value: '0x0', data: sodaxBridgeDeposit(recipient, signer, hubWallet) });

    it('to the user’s own Stellar wallet: through the popup, reported at the deposit’s value', async () => {
      const s = await session();
      const reply = s.t.request('eth_signTransaction', { tx: bridge(s.stellar, s.evm) });
      await waitLauncher(s.t, 'Review in Hana');
      const popup = openApproval(s.t);
      answer(s.t, popup, await popup.next('hana:approve-request'), true);
      expect((await reply).error).toBeUndefined();
      await sleepReal(20);
      expect(demoEvents(s.t)[0]!.body).toMatchObject({ chain: 'evm', network: '8453', kind: 'evm_tx', usdMicros: '1050001', walletProof: { address: s.evm } });
    });

    it('to another wallet: refused before any popup (the vault compares it with the session’s own address, encoded)', async () => {
      const s = await session();
      const reply = await s.t.request('eth_signTransaction', { tx: bridge(OTHER, s.evm) });
      expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'mainnet_demo_unknown_call', chain: 'evm', chainId: 8453 } });
      await sleepReal(20);
      expect(approvePopups(s.t)).toHaveLength(0);
      expect(demoEvents(s.t)).toHaveLength(0);
    });

    it('with another hub wallet as the spoke `to`: refused before any popup, though the recipient is the user’s own (D476)', async () => {
      const s = await session();
      const reply = await s.t.request('eth_signTransaction', { tx: bridge(s.stellar, s.evm, `0x${'22'.repeat(20)}`) });
      expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'mainnet_demo_unknown_call', chain: 'evm', chainId: 8453 } });
      await sleepReal(20);
      expect(approvePopups(s.t)).toHaveLength(0);
      expect(demoEvents(s.t)).toHaveLength(0);
    });
  });

  describe('a Sodax swap or plain deposit (D492)', () => {
    const swap = (signer: string, hubWallet?: string) => send({ to: SODAX_ASSET_MANAGER_BASE, value: '0x0', data: sodaxSwapDeposit(signer, hubWallet) });
    const empty = (signer: string, hubWallet?: string) => send({ to: SODAX_ASSET_MANAGER_BASE, value: '0x0', data: sodaxEmptyDeposit(signer, hubWallet) });

    it.each([
      ['a swap', swap],
      ['an empty-data deposit', empty],
    ] as const)('%s to the signing address’s own hub wallet: through the popup', async (_name, make) => {
      const s = await session();
      const reply = s.t.request('eth_signTransaction', { tx: make(s.evm) });
      await waitLauncher(s.t, 'Review in Hana');
      const popup = openApproval(s.t);
      answer(s.t, popup, await popup.next('hana:approve-request'), true);
      expect((await reply).error).toBeUndefined();
    });

    it.each([
      ['a swap', swap],
      ['an empty-data deposit', empty],
    ] as const)('%s to another hub wallet: refused before any popup', async (_name, make) => {
      const s = await session();
      const reply = await s.t.request('eth_signTransaction', { tx: make(s.evm, `0x${'22'.repeat(20)}`) });
      expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'mainnet_demo_unknown_call', chain: 'evm', chainId: 8453 } });
      await sleepReal(20);
      expect(approvePopups(s.t)).toHaveLength(0);
      expect(demoEvents(s.t)).toHaveLength(0);
    });
  });

  it('on: a USDC transfer under the cap is allowed; other mainnets and typed data stay refused', async () => {
    const s = await session();
    const usdc = s.t.request('eth_signTransaction', { tx: send({ to: USDC_BASE, value: '0x0', data: usdcTransfer(EVM_VAULT, 5_000_000n) }) });
    await waitLauncher(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    answer(s.t, popup, await popup.next('hana:approve-request'), true);
    expect((await usdc).error).toBeUndefined();
    for (const chainId of ['0x1', '0x92', '0xa']) {
      expect((await s.t.request('eth_signTransaction', { tx: send({ chainId }) })).error).toMatchObject({ code: 4100, message: TEST_APP_NETWORK_RULE, data: { reason: 'mainnet_not_allowed' } });
    }
    const typed = JSON.stringify({ types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', domain: { chainId: 8453 }, message: { a: '1' } });
    expect((await s.t.request('eth_signTypedData_v4', [s.evm, typed])).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_demo_unknown_call' } });
  });

  it('fails closed when the setting can’t be confirmed, and stops within 10 s of being turned off', async () => {
    const s = await session();
    s.t.browser.backend.overrides.set('/v1/app', async () => new Response('{"error":"down","code":"config_unavailable"}', { status: 503 }));
    s.t.browser.timers.advance(11_000);
    expect((await s.t.request('eth_signTransaction', { tx: send() })).error).toMatchObject({ code: "api_unavailable", data: { reason: "mainnet_demo_unconfirmed" } });
    s.t.browser.backend.overrides.delete('/v1/app');
    s.t.browser.backend.app = { ...s.t.browser.backend.app, mainnetDemo: false };
    s.t.browser.timers.advance(11_000);
    expect((await s.t.request('eth_signTransaction', { tx: send() })).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed' } });
  });

  it('a production build never reads or honours the setting', async () => {
    const s = await session({ env: { ...ENV, name: 'production', devEnv: false } });
    const before = s.t.browser.backend.count('/v1/app');
    expect((await s.t.request('eth_signTransaction', { tx: send() })).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed' } });
    expect(s.t.browser.backend.count('/v1/app')).toBe(before);
  });

  it('tells the SDK its state with the rules (before ready when the page inlined it), and again when GET /v1/app changes it', async () => {
    const browser = new Browser();
    browser.backend.serverNow = () => NOW;
    browser.backend.app = { ...browser.backend.app, mainnetDemo: true };
    const t = await readyTab(browser, { googleJwk: g.jwk, config: makeConfig({ serverTimeMs: NOW, settings: { mainnetDemo: true } }) });
    tabs.push(t);
    const names = t.events.map((e) => e.event);
    expect(names.indexOf('mainnetDemo')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('mainnetDemo')).toBeLessThan(names.indexOf('ready'));
    const demoEvents = () => t.events.filter((e) => e.event === 'mainnetDemo').map((e) => e.data);
    expect(demoEvents()).toEqual([{ evmChains: [8453], stellarNetworkPassphrase: STELLAR_MAINNET_PASSPHRASE, txCapUsdMicros: '9990000', pricesReviewedAt: '2026-11-06', pricesValidUntilMs: Date.UTC(2026, 11, 21) }]);
    // Turned off: the next GET /v1/app (here the re-read before a mainnet request) tells the SDK null.
    await login(t, g, { iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600 });
    t.browser.backend.app = { ...t.browser.backend.app, mainnetDemo: false };
    t.browser.timers.advance(11_000);
    expect((await t.request('eth_signTransaction', { tx: send() })).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed' } });
    expect(demoEvents().at(-1)).toBeNull();
    expect(demoEvents()).toHaveLength(2);
  });

  it('a production build never tells the SDK anything about it', async () => {
    const browser = new Browser();
    browser.backend.serverNow = () => NOW;
    browser.backend.app = { ...browser.backend.app, mainnetDemo: true };
    const t = await readyTab(browser, { googleJwk: g.jwk, env: { ...ENV, name: 'production', devEnv: false }, config: makeConfig({ serverTimeMs: NOW, settings: { mainnetDemo: true } }) });
    tabs.push(t);
    expect(t.events.filter((e) => e.event === 'mainnetDemo')).toEqual([]);
  });

  describe('prices from the API (D436)', () => {
    const LIVE = {
      atMs: NOW,
      assets: { ETH: { usdMicros: '2251798500', source: 'live' }, XLM: { usdMicros: '155400', source: 'live' }, USDC: { usdMicros: '1048950', source: 'live' }, EURC: { usdMicros: '1165500', source: 'live' } },
    };
    /** 0.002 ETH: $16 at the fixed table, refused; about $4.50 at the market. */
    const big = () => send({ value: `0x${(2n * 10n ** 15n).toString(16)}` });
    const pricesOf = (t: Tab) => t.events.filter((e) => e.event === 'mainnetDemoPrices').map((e) => e.data);

    async function withPrices(mainnetDemoPrices: unknown) {
      const s = await session();
      s.t.browser.backend.app = { ...s.t.browser.backend.app, mainnetDemoPrices };
      s.t.browser.timers.advance(11_000);
      return s;
    }

    it('values with the book the API sent: what the fixed table refuses goes to the popup, with those prices', async () => {
      const s = await withPrices(LIVE);
      const tx = big();
      const reply = s.t.request('eth_signTransaction', { tx });
      await waitLauncher(s.t, 'Review in Hana');
      const popup = openApproval(s.t);
      const m = await popup.next('hana:approve-request');
      expect(m).toMatchObject({ demoPrices: LIVE });
      answer(s.t, popup, m, true);
      expect(evmTxSigner((await reply).result as string, tx)).toBe(s.evm);
      await sleepReal(20);
      // The report is the value at the prices it was decided with, not the table's.
      expect((demoEvents(s.t)[0]!.body as { usdMicros: string }).usdMicros).toBe('4503598');
    });

    it('still refuses over the cap at the live price, naming the value', async () => {
      const s = await withPrices(LIVE);
      const reply = await s.t.request('eth_signTransaction', { tx: send({ value: `0x${(5n * 10n ** 15n).toString(16)}` }) });
      expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'mainnet_demo_over_cap', usd: '$11.26', capUsd: '$9.99' } });
      await sleepReal(20);
      expect(approvePopups(s.t)).toHaveLength(0);
    });

    it.each<[string, unknown]>([
      ['a price under the floor', { atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: '999999999', source: 'live' } } }],
      ['a price over the ceiling', { atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: '8000000001', source: 'live' } } }],
      ['a book past the age limit', { ...LIVE, atMs: NOW - 16 * 60_000 }],
      ['a missing asset', { atMs: NOW, assets: { XLM: LIVE.assets.XLM, USDC: LIVE.assets.USDC, EURC: LIVE.assets.EURC } }],
      ['something else entirely', 'free money'],
      ['no prices at all (an older API)', undefined],
    ])('uses the fixed table for %s: a lying or old answer changes nothing', async (_name, book) => {
      const s = await withPrices(book);
      const reply = await s.t.request('eth_signTransaction', { tx: big() });
      expect(reply.error).toMatchObject({ code: 4100, data: { reason: 'mainnet_demo_over_cap', usd: '$16.01' } });
    });

    /** A request refused at any price in the band (0.05 ETH), so it never waits on a popup. */
    const refusedAnyway = () => send({ value: `0x${(5n * 10n ** 16n).toString(16)}` });

    it('tells the SDK the prices before the demo’s rules, and again only when they change', async () => {
      const s = await withPrices(LIVE);
      await s.t.request('eth_signTransaction', { tx: refusedAnyway() });
      await sleepReal(20);
      const before = pricesOf(s.t).length;
      expect(pricesOf(s.t).at(-1)).toEqual(LIVE);
      // The same answer again: nothing new.
      s.t.browser.timers.advance(11_000);
      await s.t.request('eth_signTransaction', { tx: refusedAnyway() });
      await sleepReal(20);
      expect(pricesOf(s.t)).toHaveLength(before);
      // A change is told at once; the page's prices follow the vault's.
      const next = { atMs: NOW + 5_000, assets: { ...LIVE.assets, XLM: { usdMicros: '160000', source: 'live' } } };
      s.t.browser.backend.app = { ...s.t.browser.backend.app, mainnetDemoPrices: next };
      s.t.browser.timers.advance(11_000);
      await s.t.request('eth_signTransaction', { tx: refusedAnyway() });
      await sleepReal(20);
      expect(pricesOf(s.t).at(-1)).toEqual(next);
    });

    it('announces the fixed table before ready, then the API’s prices, without waiting for a sign request', async () => {
      const browser = new Browser();
      browser.backend.serverNow = () => NOW;
      browser.backend.app = { ...browser.backend.app, mainnetDemo: true, mainnetDemoPrices: LIVE };
      const t = await readyTab(browser, { googleJwk: g.jwk, config: makeConfig({ serverTimeMs: NOW, settings: { mainnetDemo: true } }) });
      tabs.push(t);
      await sleepReal(20);
      const names = t.events.map((e) => e.event);
      expect(names.indexOf('mainnetDemoPrices')).toBeLessThan(names.indexOf('mainnetDemo'));
      expect(pricesOf(t)[0]).toEqual({ atMs: null, assets: { ETH: { usdMicros: '8000000000', source: 'fixed' }, XLM: { usdMicros: '1000000', source: 'fixed' }, USDC: { usdMicros: '1050000', source: 'fixed' }, EURC: { usdMicros: '1350000', source: 'fixed' } } });
      expect(pricesOf(t).at(-1)).toEqual(LIVE);
    });

    it('re-reads the prices on its own while the demo is on, and stops when it is off', async () => {
      const s = await withPrices(LIVE);
      await s.t.request('eth_signTransaction', { tx: refusedAnyway() });
      const before = s.t.browser.backend.count('/v1/app');
      s.t.browser.timers.advance(5 * 60_000 + 1);
      await sleepReal(20);
      expect(s.t.browser.backend.count('/v1/app')).toBeGreaterThan(before);
      s.t.browser.backend.app = { ...s.t.browser.backend.app, mainnetDemo: false };
      s.t.browser.timers.advance(5 * 60_000 + 1);
      await sleepReal(20);
      const off = s.t.browser.backend.count('/v1/app');
      s.t.browser.timers.advance(30 * 60_000);
      await sleepReal(20);
      expect(s.t.browser.backend.count('/v1/app')).toBe(off);
    });

    it('a production build never uses the prices or asks for them', async () => {
      const browser = new Browser();
      browser.backend.serverNow = () => NOW;
      browser.backend.app = { ...browser.backend.app, mainnetDemo: true, mainnetDemoPrices: LIVE };
      const t = await readyTab(browser, { googleJwk: g.jwk, env: { ...ENV, name: 'production', devEnv: false }, config: makeConfig({ serverTimeMs: NOW, settings: { mainnetDemo: true } }) });
      tabs.push(t);
      await sleepReal(20);
      expect(pricesOf(t)).toEqual([]);
    });
  });

  it('never auto-approves a demo request, even under an accepted policy that covers it', async () => {
    const policy = {
      v: 1,
      label: 'Payments',
      maxConsentMs: 6 * HOUR,
      limits: { perDayCount: 5 },
      evm: {
        chains: [
          {
            chainId: 8453,
            maxValueWei: '1000000000',
            maxValueWeiPerDay: '5000000000',
            maxFeeWei: '1000000000',
            contracts: [{ address: USDC_BASE, name: 'USDC', selectors: [{ selector: functionSelector('transfer(address,uint256)'), signature: 'transfer(address,uint256)', addressArgs: 'self-or-listed' }] }],
            addresses: [EVM_VAULT],
          },
        ],
      },
    };
    const s = await session({ policy });
    const grant = s.t.request("hana_requestAutoApprove");
    await sleepReal(50);
    if (s.t.launcher.label === null) throw new Error(`no consent: ${JSON.stringify(await grant)}`);
    const popup = openApproval(s.t);
    answerConsent(s.t, popup, await popup.next('hana:consent-request'), true);
    expect((await grant).result).toMatchObject({ granted: true });
    const reply = s.t.request('eth_signTransaction', { tx: send({ to: USDC_BASE, value: '0x0', data: usdcTransfer(EVM_VAULT, 1_000_000n) }) });
    const m = await popup.next('hana:approve-request');
    expect(m).toMatchObject({ context: { chainId: 8453 } });
    answer(s.t, popup, m, true);
    expect((await reply).error).toBeUndefined();
    expect(s.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(0);
  });
});
