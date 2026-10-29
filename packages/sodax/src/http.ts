// HTTP for the Sodax adapters: JSON-RPC to Soroban RPC and the EVM spoke's RPC, GETs to Horizon, and the poll sleep.
// Everything goes through the page's `fetch` at call time. Failures are HanaError: -32602 for the caller's input,
// -32603 for the network or the node, with the node's own code and message (never a body dump) in `data`.
import { HanaError, RpcCode } from '@hana-id/web';

/** Each HTTP request's own limit (a receipt poll also stops at its overall deadline). */
export const REQUEST_TIMEOUT_MS = 30_000;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const invalid = (message: string): HanaError => new HanaError(RpcCode.invalidParams, message);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `value` as an http(s) URL string, or a TypeError naming `name` (config checks, as createHana does). */
export function httpUrl(value: unknown, name: string): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError(`${name} must be a URL`);
  }
  if (typeof value !== 'string' || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new TypeError(`${name} must be an http(s) URL`);
  return value;
}

let rpcId = 0;

/**
 * One JSON-RPC 2.0 call to `url` (`what` names the service in errors). Resolves with `result`; rejects with -32603 on a
 * transport fault, a non-JSON or malformed body, or the node's error (its code and message in `data`).
 */
export async function jsonRpc(url: string, method: string, params: unknown, what: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  rpcId = (rpcId + 1) % Number.MAX_SAFE_INTEGER;
  const id = rpcId;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HanaError(RpcCode.internal, `${what} request failed: ${e instanceof Error ? e.message : 'network error'}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new HanaError(RpcCode.internal, `${what} returned HTTP ${res.status} without JSON`);
  }
  if (!isObject(body)) throw new HanaError(RpcCode.internal, `${what} returned a malformed response`);
  if (body.error !== undefined) {
    const e = isObject(body.error) ? body.error : {};
    const code = typeof e.code === 'number' && Number.isSafeInteger(e.code) ? e.code : null;
    const message = typeof e.message === 'string' ? e.message.slice(0, 1024) : 'error';
    throw new HanaError(RpcCode.internal, `${what} error: ${message}`, { rpcCode: code, rpcMessage: message });
  }
  if (!('result' in body)) throw new HanaError(RpcCode.internal, `${what} returned HTTP ${res.status} without a result`);
  return body.result;
}

/** A GET of JSON: the parsed body on 200, else the status (0 for a network fault or timeout). */
export async function getJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ ok: true; json: unknown } | { ok: false; status: number }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, status: 0 };
  }
  if (res.status !== 200) return { ok: false, status: res.status };
  try {
    return { ok: true, json: await res.json() };
  } catch {
    // A 200 without JSON is a broken proxy or server, as transient as a 5xx.
    return { ok: false, status: 0 };
  }
}
