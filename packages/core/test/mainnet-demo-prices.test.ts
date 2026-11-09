// The mainnet demo's price book (D436): the band, the margin, the one strict check, and the valuation with a book. The
// book is what the vault re-checks and values with; a price outside the band changes nothing, and the cap holds at any
// price in it.
import { serializeTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ApprovalSubject } from '../src/approval.ts';
import { MAINNET_DEMO, assessMainnetDemo } from '../src/mainnet-demo.ts';
import {
  MAINNET_DEMO_ASSETS,
  MAINNET_DEMO_LIVE_MAX_AGE_MS,
  MAINNET_DEMO_PRICE_BOUNDS,
  type MainnetDemoPriceBook,
  fixedMainnetDemoPrices,
  mainnetDemoPriceFromLive,
  parseMainnetDemoPrices,
  usdMicrosToString,
} from '../src/mainnet-demo-prices.ts';
import { parsePortEvent, parseWindowMessage } from '../src/protocol.ts';

const NOW = Date.UTC(2026, 10, 9, 12);
const AFTER_TABLE = MAINNET_DEMO.validUntilMs + 86_400_000;
const EVM_USER = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
const FRIEND = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const WEI = 10n ** 18n;

/** Today's market, in force: ETH $2,144.57 × 1.05, and the others likewise. */
const LIVE: MainnetDemoPriceBook = {
  atMs: NOW,
  assets: {
    ETH: { usdMicros: '2251798500', source: 'live' },
    XLM: { usdMicros: '155400', source: 'live' },
    USDC: { usdMicros: '1048950', source: 'live' },
    EURC: { usdMicros: '1165500', source: 'live' },
  },
};

const send = (value: bigint): ApprovalSubject => ({
  kind: 'evm_tx',
  chain: 'evm',
  address: EVM_USER,
  context: { chainId: 8453 },
  bytes: Buffer.from(serializeTransaction({ type: 'eip1559', chainId: 8453, nonce: 1, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gas: 21_000n, to: FRIEND, value } as never).slice(2), 'hex'),
});

/** The largest value in wei whose USD value at `priceMicros` is at most the cap. */
const capWei = (priceMicros: bigint) => (MAINNET_DEMO.txCapUsdMicros * WEI) / priceMicros;

describe('the band', () => {
  it('is the reviewed floor and the fixed table, for exactly the four assets', () => {
    expect(MAINNET_DEMO_ASSETS).toEqual(['ETH', 'XLM', 'USDC', 'EURC']);
    expect(MAINNET_DEMO_PRICE_BOUNDS).toEqual({
      ETH: { floorUsdMicros: 1_000_000_000n, ceilingUsdMicros: 8_000_000_000n },
      XLM: { floorUsdMicros: 70_000n, ceilingUsdMicros: 1_000_000n },
      USDC: { floorUsdMicros: 950_000n, ceilingUsdMicros: 1_050_000n },
      EURC: { floorUsdMicros: 1_000_000n, ceilingUsdMicros: 1_350_000n },
    });
  });

  it('its ceiling is the fixed table the valuation has always used', () => {
    expect(MAINNET_DEMO.evm[8453]!.native.priceUsdMicros).toBe(8_000_000_000n);
    expect(MAINNET_DEMO.stellar.native.priceUsdMicros).toBe(1_000_000n);
    expect(Object.values(MAINNET_DEMO.evm[8453]!.tokens).map((t) => t.priceUsdMicros)).toEqual([1_050_000n, 1_350_000n]);
    expect(Object.values(MAINNET_DEMO.stellar.assets).map((t) => t.priceUsdMicros)).toEqual([1_050_000n, 1_350_000n]);
    expect(fixedMainnetDemoPrices()).toEqual({
      atMs: null,
      assets: {
        ETH: { usdMicros: '8000000000', source: 'fixed' },
        XLM: { usdMicros: '1000000', source: 'fixed' },
        USDC: { usdMicros: '1050000', source: 'fixed' },
        EURC: { usdMicros: '1350000', source: 'fixed' },
      },
    });
  });
});

describe('mainnetDemoPriceFromLive', () => {
  it('is the market × 1.05, rounded up to the micro, exactly', () => {
    expect(mainnetDemoPriceFromLive('ETH', 2144.57)).toEqual({ usdMicros: 2_251_798_500n, clamped: null });
    expect(mainnetDemoPriceFromLive('XLM', 0.148)).toEqual({ usdMicros: 155_400n, clamped: null });
    expect(mainnetDemoPriceFromLive('USDC', 0.999)).toEqual({ usdMicros: 1_048_950n, clamped: null });
    expect(mainnetDemoPriceFromLive('EURC', 1.11)).toEqual({ usdMicros: 1_165_500n, clamped: null });
    // One part per billion above a micro boundary rounds up: never under the market × 1.05.
    expect(mainnetDemoPriceFromLive('XLM', 0.14000000095)).toEqual({ usdMicros: 147_001n, clamped: null });
    expect(mainnetDemoPriceFromLive('XLM', 1.5e-7)).toEqual({ usdMicros: 70_000n, clamped: 'floor' });
  });

  it('clamps to the band and says which end', () => {
    expect(mainnetDemoPriceFromLive('ETH', 7_999)).toEqual({ usdMicros: 8_000_000_000n, clamped: 'ceiling' });
    expect(mainnetDemoPriceFromLive('ETH', 1e20)).toEqual({ usdMicros: 8_000_000_000n, clamped: 'ceiling' });
    expect(mainnetDemoPriceFromLive('ETH', 1)).toEqual({ usdMicros: 1_000_000_000n, clamped: 'floor' });
    expect(mainnetDemoPriceFromLive('USDC', 0.5)).toEqual({ usdMicros: 950_000n, clamped: 'floor' });
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['2144.57'], [null], [undefined]])('refuses %s', (usd) => {
    expect(mainnetDemoPriceFromLive('ETH', usd)).toBeNull();
  });
});

describe('parseMainnetDemoPrices', () => {
  it('accepts a live book, a mixed book and the fixed book', () => {
    expect(parseMainnetDemoPrices(LIVE, NOW)).toEqual(LIVE);
    const mixed = { atMs: NOW, assets: { ...LIVE.assets, XLM: { usdMicros: '1000000', source: 'fixed' } } };
    expect(parseMainnetDemoPrices(mixed, NOW)).toEqual(mixed);
    expect(parseMainnetDemoPrices(fixedMainnetDemoPrices(), NOW)).toEqual(fixedMainnetDemoPrices());
  });

  const withAsset = (asset: string, entry: unknown) => ({ atMs: NOW, assets: { ...LIVE.assets, [asset]: entry } });
  it.each<[string, unknown]>([
    ['not an object', 'x'],
    ['no assets', { atMs: NOW }],
    ['an extra key', { ...LIVE, extra: 1 }],
    ['an extra asset', { atMs: NOW, assets: { ...LIVE.assets, BTC: { usdMicros: '1', source: 'live' } } }],
    ['a missing asset', { atMs: NOW, assets: { ETH: LIVE.assets.ETH, XLM: LIVE.assets.XLM, USDC: LIVE.assets.USDC } }],
    ['a live price above the band', withAsset('ETH', { usdMicros: '8000000001', source: 'live' })],
    ['a live price below the band', withAsset('ETH', { usdMicros: '999999999', source: 'live' })],
    ['a fixed price that isn’t the table’s', withAsset('XLM', { usdMicros: '900000', source: 'fixed' })],
    ['an unknown source', withAsset('XLM', { usdMicros: '155400', source: 'oracle' })],
    ['a number price', withAsset('XLM', { usdMicros: 155400, source: 'live' })],
    ['a non-canonical price', withAsset('XLM', { usdMicros: '0155400', source: 'live' })],
    ['a negative price', withAsset('XLM', { usdMicros: '-1', source: 'live' })],
    ['a price with a decimal point', withAsset('XLM', { usdMicros: '155400.5', source: 'live' })],
    ['a live book with no time', { atMs: null, assets: LIVE.assets }],
    ['a fixed book with a time', { atMs: NOW, assets: fixedMainnetDemoPrices().assets }],
    ['a time in the future', { atMs: NOW + 120_000, assets: LIVE.assets }],
    ['a time past the age limit', { atMs: NOW - MAINNET_DEMO_LIVE_MAX_AGE_MS - 1, assets: LIVE.assets }],
    ['a non-integer time', { atMs: NOW + 0.5, assets: LIVE.assets }],
  ])('refuses %s', (_name, raw) => {
    expect(parseMainnetDemoPrices(raw, NOW)).toBeNull();
  });

  it('skips only the time checks with nowMs null, for the approval popup', () => {
    const old = { atMs: NOW - MAINNET_DEMO_LIVE_MAX_AGE_MS - 1, assets: LIVE.assets };
    expect(parseMainnetDemoPrices(old, null)).toEqual(old);
    expect(parseMainnetDemoPrices({ atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: '9000000000', source: 'live' } } }, null)).toBeNull();
  });

  it('accepts the age limit itself', () => {
    expect(parseMainnetDemoPrices({ atMs: NOW - MAINNET_DEMO_LIVE_MAX_AGE_MS, assets: LIVE.assets }, NOW)).not.toBeNull();
  });
});

describe('usdMicrosToString', () => {
  it('shows every significant digit, at least two decimals, and rounds nothing', () => {
    expect(usdMicrosToString(2_251_798_500n)).toBe('2251.7985');
    expect(usdMicrosToString(1_050_000n)).toBe('1.05');
    expect(usdMicrosToString(155_400n)).toBe('0.1554');
    expect(usdMicrosToString(9_990_000n)).toBe('9.99');
    expect(usdMicrosToString(1_000_000n)).toBe('1.00');
    expect(usdMicrosToString(1_000_001n)).toBe('1.000001');
  });
});

describe('the valuation with a book', () => {
  it('values with the book: what the fixed table refuses passes at the market, and the cap still holds', () => {
    const atLive = capWei(2_251_798_500n);
    // $9.99 of ETH at the market is about four times what the fixed table allows.
    const ok = assessMainnetDemo(send(atLive), NOW, LIVE);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.usdMicros).toBeLessThanOrEqual(MAINNET_DEMO.txCapUsdMicros);
    expect(assessMainnetDemo(send(atLive), NOW)).toMatchObject({ ok: false, reason: 'mainnet_demo_over_cap' });
    // One wei over the live cap is refused with that value.
    expect(assessMainnetDemo(send(atLive + 1n), NOW, LIVE)).toMatchObject({ ok: false, reason: 'mainnet_demo_over_cap', usdMicros: 9_990_001n });
  });

  it('holds the cap at the band’s edges: a feed can move the price within it, not the cap', () => {
    const floor: MainnetDemoPriceBook = { atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: MAINNET_DEMO_PRICE_BOUNDS.ETH.floorUsdMicros.toString(), source: 'live' } } };
    expect(assessMainnetDemo(send(capWei(1_000_000_000n)), NOW, floor).ok).toBe(true);
    expect(assessMainnetDemo(send(capWei(1_000_000_000n) + 1n), NOW, floor)).toMatchObject({ reason: 'mainnet_demo_over_cap' });
    expect(assessMainnetDemo(send(capWei(8_000_000_000n)), NOW, fixedMainnetDemoPrices()).ok).toBe(true);
    expect(assessMainnetDemo(send(capWei(8_000_000_000n) + 1n), NOW, fixedMainnetDemoPrices())).toMatchObject({ reason: 'mainnet_demo_over_cap' });
  });

  it('a request valued only with live prices doesn’t depend on the table’s expiry', () => {
    expect(assessMainnetDemo(send(10n ** 15n), AFTER_TABLE, LIVE).ok).toBe(true);
  });

  it('refuses with prices_stale when the whole table is in use and expired, or when a fixed price it needs has expired', () => {
    expect(assessMainnetDemo(send(1n), AFTER_TABLE, fixedMainnetDemoPrices())).toMatchObject({ ok: false, reason: 'mainnet_demo_prices_stale' });
    expect(assessMainnetDemo(send(1n), AFTER_TABLE)).toMatchObject({ ok: false, reason: 'mainnet_demo_prices_stale' });
    // ETH on the fixed table (a partial answer): a Base request leans on it for its fee and value.
    const mixed: MainnetDemoPriceBook = { atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: '8000000000', source: 'fixed' } } };
    expect(assessMainnetDemo(send(1n), AFTER_TABLE, mixed)).toMatchObject({ ok: false, reason: 'mainnet_demo_prices_stale' });
  });

  it('a mixed book before the table’s expiry is still valued', () => {
    const mixed: MainnetDemoPriceBook = { atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: '8000000000', source: 'fixed' } } };
    expect(assessMainnetDemo(send(10n ** 15n), NOW, mixed)).toMatchObject({ ok: true, usdMicros: 8_000_000n });
  });
});

describe('the wire', () => {
  it('the prices event carries a valid book and drops anything else', () => {
    expect(parsePortEvent({ v: 1, event: 'mainnetDemoPrices', data: LIVE })).toEqual({ v: 1, event: 'mainnetDemoPrices', data: LIVE });
    expect(parsePortEvent({ v: 1, event: 'mainnetDemoPrices', data: { atMs: NOW, assets: { ...LIVE.assets, ETH: { usdMicros: '9000000000', source: 'live' } } } })).toBeNull();
  });

  it('a mainnet demo event with extra keys stays refused, so a vault can’t change that event’s shape under an old SDK', () => {
    expect(parsePortEvent({ v: 1, event: 'mainnetDemo', data: { evmChains: [8453], stellarNetworkPassphrase: 'Public Global Stellar Network ; September 2015', txCapUsdMicros: '9990000', pricesReviewedAt: '2026-11-06', pricesValidUntilMs: 1, prices: LIVE } })).toBeNull();
  });

  it('the approval request carries the book only as an object: its contents are the popup’s to check', () => {
    const request = (extra: Record<string, unknown>) => ({
      v: 1,
      t: 'hana:approve-request',
      id: 'ab'.repeat(16),
      appName: 'App',
      parentOrigin: 'https://app.test',
      kind: 'evm_tx',
      chain: 'evm',
      address: EVM_USER,
      bytes: Uint8Array.from(send(1n).bytes),
      context: { chainId: 8453 },
      position: 1,
      queued: 1,
      ...extra,
    });
    expect(parseWindowMessage(request({ demoPrices: LIVE }), ['hana:approve-request'])).not.toBeNull();
    expect(parseWindowMessage(request({}), ['hana:approve-request'])).not.toBeNull();
    expect(parseWindowMessage(request({ demoPrices: 'nope' }), ['hana:approve-request'])).toBeNull();
  });
});
