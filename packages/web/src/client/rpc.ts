// JSON-RPC over HTTP to the partner's EVM RPC (docs/batch-b-spec.md "EIP-1193": read-only methods are forwarded to
// the current chain's rpcUrl, and the SDK fills fees and nonces and broadcasts there). The vault never sees this RPC.
import { ProviderRpcError, RpcCode } from './errors.ts';

export const RPC_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let rpcId = 0;

/** One JSON-RPC call. Rejects with the node's error as a ProviderRpcError, or -32603 on a transport fault. */
export async function jsonRpc(fetchImpl: FetchLike, url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  rpcId = (rpcId + 1) % Number.MAX_SAFE_INTEGER;
  const id = rpcId;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderRpcError(RpcCode.internal, `EVM RPC request failed: ${e instanceof Error ? e.message : 'network error'}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderRpcError(RpcCode.internal, `EVM RPC returned HTTP ${res.status} without JSON`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ProviderRpcError(RpcCode.internal, 'EVM RPC returned a malformed response');
  const b = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  if (b.error !== undefined) {
    const code = typeof b.error?.code === 'number' && Number.isSafeInteger(b.error.code) ? b.error.code : RpcCode.internal;
    const message = typeof b.error?.message === 'string' ? b.error.message.slice(0, 1024) : 'EVM RPC error';
    throw new ProviderRpcError(code, message, b.error?.data);
  }
  if (!('result' in b)) throw new ProviderRpcError(RpcCode.internal, `EVM RPC returned HTTP ${res.status} without a result`);
  return b.result;
}
