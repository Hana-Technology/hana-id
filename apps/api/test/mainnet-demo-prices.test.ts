// The mainnet demo's live prices (D436): where GET /v1/app gets them, in what order, what it does with each kind of
// failure, how it keeps the calls bounded, and that the CoinGecko key never leaves its header.
import { env } from 'cloudflare:workers';
import { MAINNET_DEMO_LIVE_FRESH_MS, MAINNET_DEMO_LIVE_MAX_AGE_MS, fixedMainnetDemoPrices } from '@hana-id/core/mainnet-demo-prices';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COINGECKO_ATTEMPT_TIMEOUT_MS, COINGECKO_PRO_URL, COINGECKO_PUBLIC_URL, COLD_WAIT_MS, REFRESH_GATE_MS, bookFromCoinGecko, clearMainnetDemoPrices, mainnetDemoPrices } from '../src/mainnet-demo-prices.ts';
import { appHeaders, call, chain, seedApp, uid } from './helpers.ts';

const KEY = 'CG-test-key-do-not-leak-1234567890';
const DEMO_ENV = { ENV_NAME: 'sandbox-test', NETWORK: 'testnet' } as const;

const nowS = () => Math.floor(Date.now() / 1000);
/** CoinGecko's answer at today's market, with every asset updated `ageS` ago. */
const market = (ageS = 30) => ({
  ethereum: { usd: 2144.57, last_updated_at: nowS() - ageS },
  stellar: { usd: 0.148, last_updated_at: nowS() - ageS },
  'usd-coin': { usd: 0.999, last_updated_at: nowS() - ageS },
  'euro-coin': { usd: 1.11, last_updated_at: nowS() - ageS },
});
const LIVE_ASSETS = {
  ETH: { usdMicros: '2251798500', source: 'live' },
  XLM: { usdMicros: '155400', source: 'live' },
  USDC: { usdMicros: '1048950', source: 'live' },
  EURC: { usdMicros: '1165500', source: 'live' },
};
const FIXED = fixedMainnetDemoPrices();

interface Seen {
  url: string;
  headers: Record<string, string>;
}
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rejected = (code: number, status = 400) => answer(status, { status: { error_code: code, error_message: `key ${KEY} rejected` } });

/** Stubs fetch: `route` answers each CoinGecko call (in order); anything else goes to whatever fetch was in place (chain()'s). */
function stub(route: (url: string, attempt: number, headers: Record<string, string>) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  // chain()'s mock, if a test made one: spying again would replace it, so its implementation is called directly.
  const nearMock = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch).getMockImplementation() : undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('coingecko.com')) return nearMock ? nearMock(input, init) : Promise.reject(new Error(`Unexpected fetch to ${url}`));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url, headers });
    return route(url, seen.length - 1, headers);
  });
  return seen;
}

const logs = () => {
  const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  return () => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
};

beforeEach(async () => {
  await clearMainnetDemoPrices();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** One refresh for a request with no background context: the result is the book it answered. */
const run = (e: Partial<typeof env> = {}) => mainnetDemoPrices({ ...DEMO_ENV, COINGECKO_API_KEY: KEY, ...e } as Parameters<typeof mainnetDemoPrices>[0]);

describe('the source order', () => {
  it('a Pro key: the Pro host, with the key in its header only', async () => {
    const seen = stub(() => answer(200, market()));
    const book = await run();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(COINGECKO_PRO_URL);
    expect(seen[0]!.headers['x-cg-pro-api-key']).toBe(KEY);
    expect(seen[0]!.headers['x-cg-demo-api-key']).toBeUndefined();
    expect(book.assets).toEqual(LIVE_ASSETS);
  });

  it.each([
    ['401, the real answer for a key CoinGecko doesn’t know', () => rejected(10002, 401)],
    ['400 with 10010', () => rejected(10010)],
    ['400 with 10011 (a Demo key on the Pro host)', () => rejected(10011)],
    ['403', () => answer(403, { error: 'forbidden' })],
  ])('a key the Pro host refuses (%s): the public host, with it as a Demo key', async (_name, proAnswer) => {
    const seen = stub((_u, n) => (n === 0 ? proAnswer() : answer(200, market())));
    const book = await run();
    expect(seen.map((s) => s.url)).toEqual([COINGECKO_PRO_URL, COINGECKO_PUBLIC_URL]);
    expect(seen[1]!.headers['x-cg-demo-api-key']).toBe(KEY);
    expect(seen[1]!.headers['x-cg-pro-api-key']).toBeUndefined();
    expect(book.assets).toEqual(LIVE_ASSETS);
  });

  it('a key refused as Pro and as Demo: the public host with no key', async () => {
    const seen = stub((_u, n) => (n < 2 ? rejected(10002, 401) : answer(200, market())));
    const book = await run();
    expect(seen.map((s) => s.url)).toEqual([COINGECKO_PRO_URL, COINGECKO_PUBLIC_URL, COINGECKO_PUBLIC_URL]);
    expect(seen[2]!.headers['x-cg-demo-api-key']).toBeUndefined();
    expect(seen[2]!.headers['x-cg-pro-api-key']).toBeUndefined();
    expect(book.assets).toEqual(LIVE_ASSETS);
  });

  it('no key: straight to the public host, with no key header', async () => {
    const seen = stub(() => answer(200, market()));
    await run({ COINGECKO_API_KEY: undefined });
    expect(seen).toEqual([{ url: COINGECKO_PUBLIC_URL, headers: { accept: 'application/json' } }]);
  });

  it.each([
    ['429', () => answer(429, { status: { error_code: 429 } })],
    ['503', () => answer(503, {})],
    ['200 that isn’t JSON', () => new Response('<html>', { status: 200 })],
    ['200 with an error code', () => answer(200, { status: { error_code: 1020 } })],
  ])('Pro failing some other way (%s) goes to the keyless attempt, not the Demo one', async (_name, proAnswer) => {
    const seen = stub((_u, n) => (n === 0 ? proAnswer() : answer(200, market())));
    const book = await run();
    expect(seen.map((s) => s.url)).toEqual([COINGECKO_PRO_URL, COINGECKO_PUBLIC_URL]);
    expect(seen[1]!.headers['x-cg-demo-api-key']).toBeUndefined();
    expect(book.assets).toEqual(LIVE_ASSETS);
  });

  it('every attempt failing: the fixed table', async () => {
    const seen = stub((_u, n) => (n < 2 ? rejected(10002, 401) : answer(429, {})));
    expect(await run()).toEqual(FIXED);
    expect(seen).toHaveLength(3);
  });

  it('a timeout counts as a failure of that attempt, and each attempt has its own limit', async () => {
    const seen: (AbortSignal | undefined | null)[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push(init?.signal);
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(await run()).toEqual(FIXED);
    expect(seen).toHaveLength(2); // Pro, then keyless
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(COINGECKO_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it('a redirect isn’t followed, so the key can’t be carried elsewhere', async () => {
    const seen = stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect(await run()).toEqual(FIXED);
    expect(seen.every((s) => s.url.includes('coingecko.com'))).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });
});

describe('the key stays in its header', () => {
  it('never appears in a URL, a log line, a cached entry or the answer, even when CoinGecko echoes it', async () => {
    const getLogs = logs();
    const app = await seedApp();
    chain({ [`${uid()}.apps.googleusercontent.com`]: app.scope });
    await env.DB.prepare('UPDATE apps SET mainnet_demo = 1 WHERE id = ?1').bind(app.id).run();
    const seen = stub((_u, n) => (n === 0 ? rejected(10011) : answer(200, market())));
    const res = await call('/v1/app', { method: 'GET', headers: appHeaders(app), env: { COINGECKO_API_KEY: KEY } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(KEY);
    for (const s of seen) expect(s.url).not.toContain(KEY);
    expect(getLogs()).not.toContain(KEY);
    const cached = await caches.default.match(new Request('https://mainnet-demo-prices.hana-id.invalid/v1'));
    if (cached) expect(await cached.text()).not.toContain(KEY);
  });

  it('a key with a control character counts as no key and is logged without its value', async () => {
    const getLogs = logs();
    const seen = stub(() => answer(200, market()));
    const bad = 'CG-bad\nkey';
    await run({ COINGECKO_API_KEY: bad });
    expect(seen).toEqual([{ url: COINGECKO_PUBLIC_URL, headers: { accept: 'application/json' } }]);
    expect(getLogs()).toContain('mainnet_demo_prices_key_malformed');
    expect(getLogs()).not.toContain('CG-bad');
  });
});

describe('caching', () => {
  it('serves a fresh book without another call', async () => {
    const seen = stub(() => answer(200, market()));
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(seen).toHaveLength(1);
  });

  it('keeps it in the Cache API too, for another isolate of the colo', async () => {
    const seen = stub(() => answer(200, market()));
    await run();
    expect(seen).toHaveLength(1);
    // A new isolate: the memo is gone, the Cache API entry isn't.
    await clearMainnetDemoPrices({ keepCache: true });
    const second = await run();
    expect(second.assets).toEqual(LIVE_ASSETS);
    expect(seen).toHaveLength(1);
  });

  it('after five minutes, serves the old book and refreshes in the background', async () => {
    const seen = stub(() => answer(200, market()));
    const first = await run();
    const later = Date.now() + MAINNET_DEMO_LIVE_FRESH_MS + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const waited: Promise<unknown>[] = [];
    const served = await mainnetDemoPrices({ ...DEMO_ENV, COINGECKO_API_KEY: KEY } as Parameters<typeof mainnetDemoPrices>[0], { waitUntil: (p) => void waited.push(p) });
    expect(served).toEqual(first);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('after fifteen minutes the old book isn’t used: the fixed table, unless a fresh one arrives in time', async () => {
    stub(() => answer(200, market()));
    await run();
    const later = Date.now() + MAINNET_DEMO_LIVE_MAX_AGE_MS + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('down'));
    expect(await run()).toEqual(FIXED);
  });

  it('a request with nothing cached waits at most COLD_WAIT_MS, then answers the table while the refresh goes on', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect(await run()).toEqual(FIXED);
    expect(Date.now() - started).toBeLessThan(COLD_WAIT_MS + 1000);
    expect(COLD_WAIT_MS).toBeLessThanOrEqual(1500);
  });

  it('a failing CoinGecko isn’t asked on every request: one attempt per REFRESH_GATE_MS', async () => {
    const seen = stub(() => answer(503, {}));
    await run({ COINGECKO_API_KEY: undefined });
    await run({ COINGECKO_API_KEY: undefined });
    await run({ COINGECKO_API_KEY: undefined });
    expect(seen).toHaveLength(1);
    expect(REFRESH_GATE_MS).toBe(60_000);
    const later = Date.now() + REFRESH_GATE_MS + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await run({ COINGECKO_API_KEY: undefined });
    expect(seen).toHaveLength(2);
  });
});

describe('what a price becomes', () => {
  const body = (over: Record<string, unknown>) => ({ ...market(), ...over });

  it('clamps an out-of-range price and logs a warning naming the asset and the end, with no key or value', () => {
    const getLogs = logs();
    const book = bookFromCoinGecko(body({ ethereum: { usd: 9_000, last_updated_at: nowS() }, stellar: { usd: 0.001, last_updated_at: nowS() } }), Date.now());
    expect(book?.assets.ETH).toEqual({ usdMicros: '8000000000', source: 'live' });
    expect(book?.assets.XLM).toEqual({ usdMicros: '70000', source: 'live' });
    const out = getLogs();
    expect(out).toContain('mainnet_demo_price_clamped');
    expect(out).toContain('"what":"ETH"');
    expect(out).toContain('"code":"ceiling"');
    expect(out).toContain('"code":"floor"');
    expect(out).not.toContain('9000');
  });

  it('a partial or malformed answer: the fixed price for that asset, live for the rest', () => {
    const book = bookFromCoinGecko(
      {
        ethereum: { usd: 2144.57, last_updated_at: nowS() },
        stellar: { usd: 'free', last_updated_at: nowS() },
        'usd-coin': { usd: 0.999 }, // no time
        // euro-coin missing
      },
      Date.now(),
    );
    expect(book?.assets).toEqual({ ETH: LIVE_ASSETS.ETH, XLM: FIXED.assets.XLM, USDC: FIXED.assets.USDC, EURC: FIXED.assets.EURC });
  });

  it('a stale asset (CoinGecko’s own time is too old) is treated as missing, and the book’s time is the oldest used', () => {
    const now = Date.now();
    const old = Math.floor(now / 1000) - 16 * 60;
    const fresh = Math.floor(now / 1000) - 120;
    const book = bookFromCoinGecko({ ethereum: { usd: 2144.57, last_updated_at: old }, stellar: { usd: 0.148, last_updated_at: fresh }, 'usd-coin': { usd: 0.999, last_updated_at: fresh }, 'euro-coin': { usd: 1.11, last_updated_at: fresh } }, now);
    expect(book?.assets.ETH).toEqual(FIXED.assets.ETH);
    expect(book?.assets.XLM.source).toBe('live');
    expect(book?.atMs).toBe(fresh * 1000);
  });

  it('nothing usable is no book at all', () => {
    expect(bookFromCoinGecko({}, Date.now())).toBeNull();
    expect(bookFromCoinGecko({ ethereum: 'x' }, Date.now())).toBeNull();
  });

  it('every book the API answers passes the vault’s own check', async () => {
    const { parseMainnetDemoPrices } = await import('@hana-id/core/mainnet-demo-prices');
    stub(() => answer(200, body({ ethereum: { usd: 90_000, last_updated_at: nowS() }, stellar: { usd: 'x' } })));
    const book = await run();
    expect(parseMainnetDemoPrices(book, Date.now())).toEqual(book);
  });
});

describe('where it fetches at all', () => {
  const demoApp = async (over: Partial<Parameters<typeof seedApp>[0]> = {}, on = true) => {
    const app = await seedApp(over);
    chain({ [`${uid()}.apps.googleusercontent.com`]: app.scope });
    if (on) await env.DB.prepare('UPDATE apps SET mainnet_demo = 1 WHERE id = ?1').bind(app.id).run();
    return app;
  };
  const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

  it('an app with the demo on: GET /v1/app carries the book, live', async () => {
    const app = await demoApp();
    stub(() => answer(200, market()));
    const res = await call('/v1/app', { method: 'GET', headers: appHeaders(app) });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.mainnetDemo).toBe(true);
    expect((b.mainnetDemoPrices as { assets: unknown }).assets).toEqual(LIVE_ASSETS);
  });

  it('every source down: the book is the fixed table and GET /v1/app is still 200', async () => {
    const app = await demoApp();
    stub(() => answer(503, {}));
    const res = await call('/v1/app', { method: 'GET', headers: appHeaders(app) });
    expect(res.status).toBe(200);
    expect((await body(res)).mainnetDemoPrices).toEqual(FIXED);
  });

  it('an app with the demo off: no field and no CoinGecko call', async () => {
    const app = await demoApp({}, false);
    const seen = stub(() => answer(200, market()));
    const b = await body(await call('/v1/app', { method: 'GET', headers: appHeaders(app) }));
    expect(b.mainnetDemo).toBe(false);
    expect(b).not.toHaveProperty('mainnetDemoPrices');
    expect(seen).toEqual([]);
  });

  it.each([
    ['a production env', { ENV_NAME: 'production' }],
    ['a dev env on mainnet', { ENV_NAME: 'sandbox-test', NETWORK: 'mainnet' }],
  ])('%s: no CoinGecko call, whatever the D1 switch says', async (_name, bindings) => {
    const app = await demoApp();
    const seen = stub(() => answer(200, market()));
    const b = await body(await call('/v1/app', { method: 'GET', headers: appHeaders(app), env: bindings }));
    expect(b.mainnetDemo).toBe(false);
    expect(b).not.toHaveProperty('mainnetDemoPrices');
    expect(seen).toEqual([]);
  });

  it('mainnetDemoPrices itself returns the table without a fetch outside a dev testnet env', async () => {
    const seen = stub(() => answer(200, market()));
    expect(await run({ ENV_NAME: 'production' } as never)).toEqual(FIXED);
    expect(seen).toEqual([]);
  });

  it('a request that never reaches this code (GET /v1/health) costs no call', async () => {
    const seen = stub(() => answer(200, market()));
    await call('/v1/health', { method: 'GET' });
    expect(seen).toEqual([]);
  });
});
