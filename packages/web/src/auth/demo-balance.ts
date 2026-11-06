// The mainnet demo's balance line in the approval popup (D426, D427): how much the wallet holds on the request's
// network, in USD at the reviewed (deliberately high) prices, native asset plus the priced tokens. Read from the
// public endpoints Hana pins (core networks.ts MAINNET_DEMO_BALANCE_ENDPOINTS), never the partner's RPC; only public
// data goes out (the address), nothing comes back that the popup acts on except to show a number. Anything that fails,
// times out or doesn't parse is "unknown": the popup then says so rather than guessing. It never blocks a request.
import { type DemoNetwork, MAINNET_DEMO, type UsdMicros, usdOf } from '@hana-id/core/mainnet-demo';

export type DemoBalance = { readonly kind: 'known'; readonly usdMicros: UsdMicros } | { readonly kind: 'unknown' };

/** Each read's limit: the popup shows "Balance unknown" after it. */
export const DEMO_BALANCE_TIMEOUT_MS = 4_000;

export type BalanceFetch = (url: string, init: RequestInit) => Promise<Response>;

const UNKNOWN: DemoBalance = Object.freeze({ kind: 'unknown' });
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/u;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/u;
/** `balanceOf(address)`'s selector. */
const BALANCE_OF = '0x70a08231';

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(fetchFn: BalanceFetch, url: string, method: string, params: unknown[], signal: AbortSignal): Promise<bigint> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error('rpc');
  const body = (await res.json()) as { result?: unknown };
  if (typeof body.result !== 'string' || !QUANTITY.test(body.result)) throw new Error('rpc');
  return BigInt(body.result);
}

/** Stellar's decimal amount (`12.3456789`) in stroops; null when it isn't one. */
function stroops(amount: unknown): bigint | null {
  if (typeof amount !== 'string') return null;
  const m = /^(\d{1,15})(?:\.(\d{1,7}))?$/u.exec(amount);
  if (!m) return null;
  return BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0'));
}

async function evmBalance(fetchFn: BalanceFetch, chainId: number, address: string, signal: AbortSignal): Promise<UsdMicros> {
  const chain = MAINNET_DEMO.evm[chainId];
  if (!chain) throw new Error('chain');
  const word = address.slice(2).toLowerCase().padStart(64, '0');
  const [native, ...tokens] = await Promise.all([
    rpc(fetchFn, chain.balanceRpc, 'eth_getBalance', [address, 'latest'], signal),
    ...Object.keys(chain.tokens).map((token) => rpc(fetchFn, chain.balanceRpc, 'eth_call', [{ to: token, data: `${BALANCE_OF}${word}` }, 'latest'], signal)),
  ]);
  return Object.values(chain.tokens).reduce((sum, t, i) => sum + usdOf(tokens[i]!, t), usdOf(native!, chain.native));
}

async function stellarBalance(fetchFn: BalanceFetch, account: string, signal: AbortSignal): Promise<UsdMicros> {
  const s = MAINNET_DEMO.stellar;
  const res = await fetchFn(`${s.horizon}/accounts/${account}`, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
  // An account that doesn't exist yet holds nothing.
  if (res.status === 404) return 0n;
  if (!res.ok) throw new Error('horizon');
  const body = (await res.json()) as { balances?: unknown };
  if (!Array.isArray(body.balances)) throw new Error('horizon');
  let sum = 0n;
  for (const b of body.balances as Record<string, unknown>[]) {
    const amount = stroops(b?.balance);
    if (amount === null) throw new Error('horizon');
    if (b.asset_type === 'native') sum += usdOf(amount, s.native);
    else if (typeof b.asset_code === 'string' && typeof b.asset_issuer === 'string') {
      const priced = s.assets[`${b.asset_code}:${b.asset_issuer}`];
      // Assets Hana has no price for aren't counted (the line says "priced assets").
      if (priced) sum += usdOf(amount, priced);
    }
  }
  return sum;
}

/** The wallet's priced balance on `network`, or unknown. Never throws. */
export async function readDemoBalance(network: DemoNetwork, address: string, fetchFn: BalanceFetch, timeoutMs = DEMO_BALANCE_TIMEOUT_MS): Promise<DemoBalance> {
  try {
    if (network.chain === 'evm') {
      if (!EVM_ADDRESS.test(address)) return UNKNOWN;
      return { kind: 'known', usdMicros: await withTimeout(timeoutMs, (signal) => evmBalance(fetchFn, network.chainId, address, signal)) };
    }
    if (!STELLAR_ACCOUNT.test(address)) return UNKNOWN;
    return { kind: 'known', usdMicros: await withTimeout(timeoutMs, (signal) => stellarBalance(fetchFn, address, signal)) };
  } catch {
    return UNKNOWN;
  }
}
