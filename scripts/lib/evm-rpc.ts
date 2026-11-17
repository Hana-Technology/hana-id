// A small read-only EVM JSON-RPC client for the deploy scripts (deploy-evm-delegate, deploy-check's `evm` group,
// D849): eth_chainId, eth_getCode and eth_getBalance only. It never sends a transaction (cast does that, signing with
// the user's keystore) and never shows its URL: a provider URL can carry an API key in its path or query, so messages
// name the RPC by `rpcLabel` (scheme, host and port).
import { isSponsorLoopbackHost } from '@hana-id/env';

export const EVM_RPC_TIMEOUT_MS = 10_000;
/** The most of an answer read: a contract's code is at most 24 KiB (48 KiB of hex) under EIP-170. */
export const EVM_RPC_BODY_LIMIT = 256 * 1024;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/u;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;

/** The scheme, host and port of an RPC URL, plus `/…` when it has a path or query (never shown: it may hold a key). */
export function rpcLabel(url: string): string {
  try {
    const u = new URL(url);
    const more = (u.pathname !== '/' && u.pathname !== '') || u.search !== '' ? '/…' : '';
    return `${u.protocol}//${u.host}${more}`;
  } catch {
    return '(not a URL)';
  }
}

/**
 * Why `url` can't be an RPC for these scripts, or null: https, or http to a loopback host (a local node); never a
 * user name or password in it. A path and query are allowed (a provider's keyed URL) and never shown. The message
 * never quotes the URL.
 */
export function rpcUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (u.username || u.password) return 'must not carry a user name or password';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && isSponsorLoopbackHost(u.hostname)) return null;
  return 'must be an https URL (http only for a node on this machine)';
}

export class EvmRpcError extends Error {}

export interface EvmRpc {
  /** How messages name this RPC (rpcLabel). */
  readonly label: string;
  chainId(): Promise<number>;
  /** The code at `address`, `0x` for none. */
  code(address: string): Promise<string>;
  /** The balance of `address` in wei at the latest block. */
  balance(address: string): Promise<bigint>;
}

/** A JSON-RPC client over `fetchFn`. Each call times out after `timeoutMs`; errors name the RPC by its label only. */
export function evmRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs: number = EVM_RPC_TIMEOUT_MS): EvmRpc {
  const label = rpcLabel(url);
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'hana-deploy-scripts' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new EvmRpcError(`RPC ${label} is unreachable (${method})`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new EvmRpcError(`RPC ${label} answered HTTP ${res.status} to ${method}`);
    }
    const text = await res.text().catch(() => '');
    if (text.length > EVM_RPC_BODY_LIMIT) throw new EvmRpcError(`RPC ${label} sent too large an answer to ${method}`);
    let body: { result?: unknown; error?: { code?: unknown } } | null;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new EvmRpcError(`RPC ${label} answered ${method} with something that is not JSON`);
    }
    if (body && typeof body === 'object' && body.error !== undefined) {
      const code = typeof body.error?.code === 'number' ? ` ${body.error.code}` : '';
      throw new EvmRpcError(`RPC ${label} refused ${method} (error${code})`);
    }
    if (!body || typeof body !== 'object' || !('result' in body)) throw new EvmRpcError(`RPC ${label} answered ${method} without a result`);
    return body.result;
  };
  const quantity = (v: unknown, method: string): bigint => {
    if (typeof v !== 'string' || !QUANTITY_RE.test(v)) throw new EvmRpcError(`RPC ${label} answered ${method} with a malformed number`);
    return BigInt(v);
  };
  const address = (a: string): string => {
    if (!ADDRESS_RE.test(a)) throw new EvmRpcError('Not an EVM address');
    return a;
  };
  return {
    label,
    async chainId() {
      const n = quantity(await call('eth_chainId', []), 'eth_chainId');
      if (n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new EvmRpcError(`RPC ${label} answered eth_chainId with ${n}`);
      return Number(n);
    },
    async code(a) {
      const v = await call('eth_getCode', [address(a), 'latest']);
      if (typeof v !== 'string' || !HEX_RE.test(v)) throw new EvmRpcError(`RPC ${label} answered eth_getCode with malformed code`);
      return v.toLowerCase();
    },
    async balance(a) {
      return quantity(await call('eth_getBalance', [address(a), 'latest']), 'eth_getBalance');
    },
  };
}
