// The mainnet demo's prices (D429 as amended by D436): the fixed table, the band a live price must stay in, how a
// market price becomes the price used, and the one strict check of a price book. No imports, so the API Worker takes
// it without the rest of core; the valuation that uses a book is `@hana-id/core/mainnet-demo`.
//
// SECURITY: the band is the whole trust placed in the price feed. A book is what the API answers, what the vault
// re-checks and values requests with, and what the approval popup shows; each of them runs parseMainnetDemoPrices, so
// a feed, a cache or an API that says anything outside the band changes nothing. The fixed table is the band's
// ceiling: the highest price, and so the strictest cap.

/** The assets the mainnet demo can value, by the symbol the vault's config uses. */
export const MAINNET_DEMO_ASSETS = Object.freeze(['ETH', 'XLM', 'USDC', 'EURC'] as const);
export type MainnetDemoAsset = (typeof MAINNET_DEMO_ASSETS)[number];

/**
 * The USD price a demo asset may be valued at, in micros (millionths of a dollar). The ceiling is the reviewed fixed
 * table; the floor is what a price feed can at worst talk the valuation down to.
 */
export const MAINNET_DEMO_PRICE_BOUNDS: Readonly<Record<MainnetDemoAsset, { readonly floorUsdMicros: bigint; readonly ceilingUsdMicros: bigint }>> = Object.freeze({
  ETH: Object.freeze({ floorUsdMicros: 1_000_000_000n, ceilingUsdMicros: 8_000_000_000n }),
  XLM: Object.freeze({ floorUsdMicros: 70_000n, ceilingUsdMicros: 1_000_000n }),
  USDC: Object.freeze({ floorUsdMicros: 950_000n, ceilingUsdMicros: 1_050_000n }),
  EURC: Object.freeze({ floorUsdMicros: 1_000_000n, ceilingUsdMicros: 1_350_000n }),
});

/** A live price is used at this percentage of the market (above it: the cap errs on the strict side). */
export const MAINNET_DEMO_LIVE_MARGIN_PERCENT = 105n;
/** A live price is refreshed once it is this old. */
export const MAINNET_DEMO_LIVE_FRESH_MS = 5 * 60_000;
/** A live price older than this is never used: the asset falls back to the fixed table. */
export const MAINNET_DEMO_LIVE_MAX_AGE_MS = 15 * 60_000;
/** How far ahead of the reader's clock a book's time may be (clock skew between Workers and the vault). */
const FUTURE_SKEW_MS = 60_000;

export type MainnetDemoPriceSource = 'live' | 'fixed';

export interface MainnetDemoPriceEntry {
  /** USD per whole unit, in micros, in decimal. */
  readonly usdMicros: string;
  readonly source: MainnetDemoPriceSource;
}

/** The prices in force for every demo asset: what `GET /v1/app` answers as `mainnetDemoPrices`. */
export interface MainnetDemoPriceBook {
  /** The oldest live price's time (ms), or null when every asset is on the fixed table. */
  readonly atMs: number | null;
  readonly assets: Readonly<Record<MainnetDemoAsset, MainnetDemoPriceEntry>>;
}

/** The fixed table as a book: what is used when no live price can be, and the strictest valuation. */
export function fixedMainnetDemoPrices(): MainnetDemoPriceBook {
  const assets = Object.fromEntries(MAINNET_DEMO_ASSETS.map((a) => [a, Object.freeze({ usdMicros: MAINNET_DEMO_PRICE_BOUNDS[a].ceilingUsdMicros.toString(), source: 'fixed' as const })]));
  return Object.freeze({ atMs: null, assets: Object.freeze(assets) as MainnetDemoPriceBook['assets'] });
}

/** Whether a price is within the band for `asset`. */
export const withinMainnetDemoBand = (asset: MainnetDemoAsset, usdMicros: bigint): boolean =>
  usdMicros >= MAINNET_DEMO_PRICE_BOUNDS[asset].floorUsdMicros && usdMicros <= MAINNET_DEMO_PRICE_BOUNDS[asset].ceilingUsdMicros;

/**
 * `ceil(usd × margin × 10^6)` in exact decimal arithmetic: a float multiplication could round a price down. `usd` is
 * positive and finite; its shortest decimal form is exactly what the JSON said.
 */
function microsWithMargin(usd: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(usd));
  if (!m) throw new RangeError('not a decimal');
  const fraction = m[2] ?? '';
  // value = digits × 10^exponent; micros × 100 = value × margin × 10^6 × 100 / 100
  const digits = BigInt(`${m[1]}${fraction}`) * MAINNET_DEMO_LIVE_MARGIN_PERCENT;
  const exponent = Number(m[3] ?? 0) - fraction.length + 4;
  if (exponent >= 0) return digits * 10n ** BigInt(exponent);
  const scale = 10n ** BigInt(-exponent);
  return (digits + scale - 1n) / scale;
}

export interface LiveMainnetDemoPrice {
  readonly usdMicros: bigint;
  /** Which end of the band the value was pulled to, or null when it was inside. */
  readonly clamped: 'floor' | 'ceiling' | null;
}

/**
 * The price used for a market price: live × 1.05, rounded up to the micro, clamped to the asset's band. Null when
 * `usd` isn't a positive finite number (the caller then uses the fixed price for that asset).
 */
export function mainnetDemoPriceFromLive(asset: MainnetDemoAsset, usd: unknown): LiveMainnetDemoPrice | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const { floorUsdMicros: floor, ceilingUsdMicros: ceiling } = MAINNET_DEMO_PRICE_BOUNDS[asset];
  const micros = microsWithMargin(usd);
  if (micros < floor) return { usdMicros: floor, clamped: 'floor' };
  if (micros > ceiling) return { usdMicros: ceiling, clamped: 'ceiling' };
  return { usdMicros: micros, clamped: null };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const sameKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(v);
  return present.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
};

/**
 * A price book, exactly as it may be, or null. Refused as a whole for any odd field: an unknown or missing asset or
 * key, a price that isn't a canonical positive decimal string, a live price outside the band, a fixed price that isn't
 * the table's, a live book with no time, a time ahead of `nowMs` or older than MAINNET_DEMO_LIVE_MAX_AGE_MS. `nowMs`
 * null skips the time checks (the approval popup: its clock is the device's, and the vault re-checks the age).
 */
export function parseMainnetDemoPrices(raw: unknown, nowMs: number | null): MainnetDemoPriceBook | null {
  if (!isRecord(raw) || !sameKeys(raw, ['atMs', 'assets']) || !isRecord(raw.assets) || !sameKeys(raw.assets, MAINNET_DEMO_ASSETS)) return null;
  let live = 0;
  const assets = {} as Record<MainnetDemoAsset, MainnetDemoPriceEntry>;
  for (const asset of MAINNET_DEMO_ASSETS) {
    const e = raw.assets[asset];
    if (!isRecord(e) || !sameKeys(e, ['usdMicros', 'source']) || typeof e.usdMicros !== 'string' || !/^[1-9]\d{0,15}$/u.test(e.usdMicros)) return null;
    const micros = BigInt(e.usdMicros);
    if (e.source === 'live') {
      if (!withinMainnetDemoBand(asset, micros)) return null;
      live += 1;
    } else if (e.source !== 'fixed' || micros !== MAINNET_DEMO_PRICE_BOUNDS[asset].ceilingUsdMicros) return null;
    assets[asset] = Object.freeze({ usdMicros: e.usdMicros, source: e.source });
  }
  const { atMs } = raw;
  if (live === 0) {
    if (atMs !== null) return null;
  } else {
    if (!Number.isSafeInteger(atMs) || (atMs as number) <= 0) return null;
    if (nowMs !== null && ((atMs as number) > nowMs + FUTURE_SKEW_MS || nowMs - (atMs as number) > MAINNET_DEMO_LIVE_MAX_AGE_MS)) return null;
  }
  return Object.freeze({ atMs: atMs as number | null, assets: Object.freeze(assets) });
}

/** Micros in dollars for a person or a page: `"2251.7985"`, `"1.05"`, at least two decimals, nothing rounded. */
export function usdMicrosToString(usdMicros: bigint): string {
  const whole = usdMicros / 1_000_000n;
  const fraction = (usdMicros % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/u, '');
  return `${whole.toString()}.${fraction.padEnd(2, '0')}`;
}
