// The one NEAR read the admin Worker makes in C8: `get_scope` on the signer, uncached, for the on-chain watcher
// (docs/batch-c-spec.md "Hana admin console": "NEAR calls are read-only"). No key, no transaction. Errors carry the
// method only, never the RPC's text.

export const VIEW_TIMEOUT_MS = 8_000;

export class NearViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NearViewError';
  }
}

export interface ChainScope {
  owners: unknown[];
  clients: [string, string][];
  allowShared: boolean;
  pending: { id: number; change: unknown; unlockAtMs: number }[];
}

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function view(rpc: string, account: string, method: string, args: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'admin', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: b64(JSON.stringify(args)) } }),
      signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
    });
  } catch {
    throw new NearViewError(`${method}: unreachable`);
  }
  if (!res.ok) throw new NearViewError(`${method}: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { result?: { result?: number[] }; error?: unknown } | null;
  if (!body || body.error || !Array.isArray(body.result?.result)) throw new NearViewError(`${method}: error answer`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as unknown;
}

const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

/** `get_scope(scope_id)`, or null for a scope the contract doesn't have. A malformed answer throws. */
export async function getScope(rpc: string, signer: string, scopeId: string): Promise<ChainScope | null> {
  const raw = (await view(rpc, signer, 'get_scope', { scope_id: scopeId })) as Record<string, unknown> | null;
  if (raw === null) return null;
  if (typeof raw !== 'object' || !Array.isArray(raw.owners) || !Array.isArray(raw.clients) || !Array.isArray(raw.pending)) throw new NearViewError('get_scope: unexpected shape');
  return {
    owners: raw.owners,
    clients: raw.clients.filter(isPair),
    allowShared: raw.allow_shared === true,
    pending: raw.pending.flatMap((p: unknown) => {
      const v = p as { id?: unknown; change?: unknown; unlock_at_ms?: unknown } | null;
      return v && Number.isSafeInteger(v.id) && typeof v.unlock_at_ms === 'number' ? [{ id: v.id as number, change: v.change, unlockAtMs: v.unlock_at_ms }] : [];
    }),
  };
}
