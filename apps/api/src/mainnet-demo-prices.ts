// The mainnet demo's live prices (D436, amending D429's table): CoinGecko's price for the demo's four assets, turned
// into a price book for GET /v1/app. Only a request about an app with the demo on, in a dev testnet env, gets here;
// nothing else in the API calls CoinGecko.
//
// Source order, per refresh: with COINGECKO_API_KEY, the Pro API; if CoinGecko says the key isn't one for Pro, the
// public host with it as a Demo key; then, or without a key, or when Pro fails some other way (a Pro key is useless on
// the public host), the public host with no key; then nothing, and the vault's fixed table stands.
//
// Bounded calls: a refreshed book is kept for MAINNET_DEMO_LIVE_FRESH_MS in this isolate and in the Cache API (the
// isolate's copy is what bounds calls where the Cache API does nothing, as on workers.dev), a book from 5 to 15 minutes
// old is still served while a background refresh runs, and an isolate starts at most one refresh per REFRESH_GATE_MS.
// A request never shares another request's refresh promise (a Worker can't wait on another request's I/O).
//
// SECURITY: COINGECKO_API_KEY goes only into its one header on the Pro or public host. Redirects are not followed, so
// the header can't be carried anywhere else. It is never in a URL, a cache key, a log line or an answer, and CoinGecko's
// error text isn't logged in case it echoes what it was sent. The price book is trusted only within the band in
// core's mainnet-demo-prices.ts, which the vault checks again.
import {
  MAINNET_DEMO_ASSETS,
  MAINNET_DEMO_LIVE_FRESH_MS,
  MAINNET_DEMO_LIVE_MAX_AGE_MS,
  type MainnetDemoAsset,
  type MainnetDemoPriceBook,
  type MainnetDemoPriceEntry,
  fixedMainnetDemoPrices,
  mainnetDemoPriceFromLive,
  parseMainnetDemoPrices,
} from '@hana-id/core/mainnet-demo-prices';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { mainnetDemoEnv } from './mainnet-demo-setting.ts';

const COINGECKO_IDS: Readonly<Record<MainnetDemoAsset, string>> = Object.freeze({ ETH: 'ethereum', XLM: 'stellar', USDC: 'usd-coin', EURC: 'euro-coin' });
const QUERY = `/api/v3/simple/price?ids=${Object.values(COINGECKO_IDS).join(',')}&vs_currencies=usd&include_last_updated_at=true&precision=full`;
export const COINGECKO_PRO_URL = `https://pro-api.coingecko.com${QUERY}`;
export const COINGECKO_PUBLIC_URL = `https://api.coingecko.com${QUERY}`;

/** Each attempt's limit: a refresh's worst case is three of these, in the background. */
export const COINGECKO_ATTEMPT_TIMEOUT_MS = 2_500;
/** How long a request with no live price at all waits for a refresh before answering the fixed table. */
export const COLD_WAIT_MS = 1_200;
/** An isolate starts at most one refresh per this long, so a failing CoinGecko isn't asked on every request. */
export const REFRESH_GATE_MS = 60_000;
const MAX_BODY_CHARS = 16_384;
const CACHE_TTL_S = MAINNET_DEMO_LIVE_MAX_AGE_MS / 1000;
/** A fixed name: never derived from the key or anything else. */
const CACHE_KEY_URL = 'https://mainnet-demo-prices.hana-id.invalid/v1';

/** What this module tells the log about a source. Never a URL or a key. */
type PriceSource = 'pro' | 'demo' | 'public';
type Attempt = { kind: 'ok'; body: Record<string, unknown> } | { kind: 'key_rejected' } | { kind: 'failed' };
interface Entry {
  /** When this isolate or colo fetched it: freshness counts from here. */
  fetchedAtMs: number;
  book: MainnetDemoPriceBook;
}

let memo: Entry | null = null;
let lastRefreshAtMs = Number.NEGATIVE_INFINITY;

/** Forgets the isolate's prices and the cached entry, or only the former (`keepCache`: another isolate's view). Tests. */
export async function clearMainnetDemoPrices(o: { keepCache?: boolean } = {}): Promise<void> {
  memo = null;
  lastRefreshAtMs = Number.NEGATIVE_INFINITY;
  if (!o.keepCache) await cacheDelete();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** CoinGecko's own error code, from `{status: {error_code}}` or `{error_code}`. */
function errorCode(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const inner = isRecord(body.status) ? body.status.error_code : body.error_code;
  return typeof inner === 'number' ? inner : null;
}

/** 400, 401 and 403, or CoinGecko's "key missing, or for the other root URL" codes: this key isn't one for this host. */
const KEY_REJECTED_CODES: ReadonlySet<number> = new Set([10002, 10010, 10011]);

async function attempt(source: PriceSource, url: string, headers: Record<string, string>): Promise<Attempt> {
  const failed = (status?: number, code?: string): Attempt => {
    log({ event: 'mainnet_demo_prices_attempt', outcome: 'error', priceSource: source, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}) }, 'warn');
    return { kind: 'failed' };
  };
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(COINGECKO_ATTEMPT_TIMEOUT_MS) });
  } catch {
    return failed(undefined, 'unreachable');
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return failed(res.status, 'unreadable');
  }
  let parsed: unknown = null;
  try {
    parsed = text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const code = errorCode(parsed);
  if (res.status === 400 || res.status === 401 || res.status === 403 || (code !== null && KEY_REJECTED_CODES.has(code))) {
    log({ event: 'mainnet_demo_prices_attempt', outcome: 'rejected', priceSource: source, status: res.status, ...(code === null ? {} : { code: `coingecko_${code}` }) }, 'warn');
    return { kind: 'key_rejected' };
  }
  if (!res.ok || code !== null || !isRecord(parsed)) return failed(res.status, code === null ? 'bad_response' : `coingecko_${code}`);
  return { kind: 'ok', body: parsed };
}

/**
 * The first answer in source order, with where it came from. Only `key` reaches the two keyed headers, and a `failed`
 * Pro answer goes straight to the keyless attempt: a real Pro key isn't valid on the public host.
 */
async function fetchPrices(key: string | null): Promise<{ source: PriceSource; body: Record<string, unknown> } | null> {
  if (key) {
    const pro = await attempt('pro', COINGECKO_PRO_URL, { 'x-cg-pro-api-key': key });
    if (pro.kind === 'ok') return { source: 'pro', body: pro.body };
    if (pro.kind === 'key_rejected') {
      const demo = await attempt('demo', COINGECKO_PUBLIC_URL, { 'x-cg-demo-api-key': key });
      if (demo.kind === 'ok') return { source: 'demo', body: demo.body };
    }
  }
  const open = await attempt('public', COINGECKO_PUBLIC_URL, {});
  return open.kind === 'ok' ? { source: 'public', body: open.body } : null;
}

/**
 * A book from CoinGecko's answer: per asset, live × 1.05 clamped to its band, or the fixed price when the asset is
 * missing, malformed or older than the limit. Null when no asset has a live price. `atMs` is the oldest live price's own
 * time, so the 15-minute rule covers CoinGecko's age as well as ours.
 */
export function bookFromCoinGecko(body: Record<string, unknown>, nowMs: number): MainnetDemoPriceBook | null {
  const fixed = fixedMainnetDemoPrices().assets;
  const assets = {} as Record<MainnetDemoAsset, MainnetDemoPriceEntry>;
  let atMs = nowMs;
  let live = 0;
  for (const asset of MAINNET_DEMO_ASSETS) {
    const row = body[COINGECKO_IDS[asset]];
    const usd = isRecord(row) ? row.usd : undefined;
    const updatedS = isRecord(row) ? row.last_updated_at : undefined;
    const updatedMs = typeof updatedS === 'number' && Number.isFinite(updatedS) ? Math.min(updatedS * 1000, nowMs) : Number.NaN;
    const price = mainnetDemoPriceFromLive(asset, usd);
    if (price === null || !(nowMs - updatedMs <= MAINNET_DEMO_LIVE_MAX_AGE_MS)) {
      log({ event: 'mainnet_demo_price_unusable', outcome: 'error', what: asset }, 'warn');
      assets[asset] = fixed[asset];
      continue;
    }
    if (price.clamped) log({ event: 'mainnet_demo_price_clamped', outcome: 'error', what: asset, code: price.clamped }, 'warn');
    assets[asset] = { usdMicros: price.usdMicros.toString(), source: 'live' };
    atMs = Math.min(atMs, updatedMs);
    live += 1;
  }
  return live === 0 ? null : { atMs: Math.floor(atMs), assets };
}

const cacheRequest = (): Request => new Request(CACHE_KEY_URL);

async function cacheRead(nowMs: number): Promise<Entry | null> {
  try {
    const hit = await caches.default.match(cacheRequest());
    if (!hit) return null;
    const stored = (await hit.json()) as { fetchedAtMs?: unknown; book?: unknown };
    const book = parseMainnetDemoPrices(stored?.book, nowMs);
    return book !== null && book.atMs !== null && Number.isSafeInteger(stored.fetchedAtMs) ? { fetchedAtMs: stored.fetchedAtMs as number, book } : null;
  } catch {
    return null;
  }
}

async function cacheWrite(entry: Entry): Promise<void> {
  try {
    await caches.default.put(cacheRequest(), new Response(JSON.stringify(entry), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_TTL_S}` } }));
  } catch {
    // The Cache API is a nicety: the isolate's copy still bounds the calls.
  }
}

async function cacheDelete(): Promise<void> {
  try {
    await caches.default.delete(cacheRequest());
  } catch {
    // Nothing to clear.
  }
}

/** A key usable as a header value, trimmed; anything else counts as no key and is logged without its value. */
function usableKey(env: Pick<Env, 'COINGECKO_API_KEY'>): string | null {
  const key = env.COINGECKO_API_KEY?.trim();
  if (!key) return null;
  if (!/^[\x21-\x7e]{1,200}$/u.test(key)) {
    log({ event: 'mainnet_demo_prices_key_malformed', outcome: 'error' }, 'warn');
    return null;
  }
  return key;
}

async function refresh(env: Pick<Env, 'COINGECKO_API_KEY'>): Promise<Entry | null> {
  const answer = await fetchPrices(usableKey(env)).catch(() => null);
  if (!answer) {
    log({ event: 'mainnet_demo_prices_unavailable', outcome: 'error' }, 'warn');
    return null;
  }
  const now = Date.now();
  const book = bookFromCoinGecko(answer.body, now);
  if (!book) {
    log({ event: 'mainnet_demo_prices_unavailable', outcome: 'error', priceSource: answer.source, code: 'no_usable_price' }, 'warn');
    return null;
  }
  const entry: Entry = { fetchedAtMs: now, book };
  memo = entry;
  await cacheWrite(entry);
  log({ event: 'mainnet_demo_prices_refreshed', outcome: 'ok', priceSource: answer.source });
  return entry;
}

/** A book a request may be answered with: not older than the limit (parseMainnetDemoPrices keeps the rule in one place). */
const usable = (entry: Entry | null, nowMs: number): entry is Entry => entry !== null && parseMainnetDemoPrices(entry.book, nowMs) !== null;

/** A refresh in this isolate, unless one was started within REFRESH_GATE_MS. */
function startRefresh(env: Pick<Env, 'COINGECKO_API_KEY'>, nowMs: number): Promise<Entry | null> | null {
  if (nowMs - lastRefreshAtMs < REFRESH_GATE_MS) return null;
  lastRefreshAtMs = nowMs;
  return refresh(env);
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The prices in force for GET /v1/app, for an app with the demo on (the caller has checked `mainnetDemoOn`); the fixed
 * table anywhere else, without any fetch. Never throws, and stalls only when no live price exists at all, for at most
 * COLD_WAIT_MS: a price from 5 to 15 minutes old is served as it is while the refresh runs in the background.
 */
export async function mainnetDemoPrices(env: Pick<Env, 'ENV_NAME' | 'NETWORK' | 'COINGECKO_API_KEY'>, exec?: Pick<ExecutionContext, 'waitUntil'>): Promise<MainnetDemoPriceBook> {
  const fixed = fixedMainnetDemoPrices();
  if (!mainnetDemoEnv(env)) return fixed;
  try {
    const now = Date.now();
    let entry: Entry | null = memo;
    if (!usable(entry, now) || now - entry.fetchedAtMs >= MAINNET_DEMO_LIVE_FRESH_MS) {
      const cached = await cacheRead(now);
      if (cached && (!usable(entry, now) || cached.fetchedAtMs > entry.fetchedAtMs)) entry = memo = cached;
    }
    if (usable(entry, now) && now - entry.fetchedAtMs < MAINNET_DEMO_LIVE_FRESH_MS) return entry.book;
    const running = startRefresh(env, now);
    if (running) exec?.waitUntil(running.catch(() => null));
    if (usable(entry, now)) return entry.book;
    if (!running) return fixed;
    return (await withDeadline(running, COLD_WAIT_MS))?.book ?? fixed;
  } catch {
    return fixed;
  }
}
