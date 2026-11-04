// The admin Worker's NEAR reads (docs/batch-c-spec.md "Hana admin console": "NEAR calls are read-only"): `get_scope`
// on the signer, uncached, for the on-chain watcher (C8); `tx` at FINAL for settlement and `view_access_key` at final
// for the nonce check (C12). No key, no transaction. Errors carry the method only, never the RPC's text.

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

// ---- batch C12: settlement and the nonce check ----

/** How long one `tx` read may wait (wait_until FINAL holds the answer until the block is final). */
export const TX_TIMEOUT_MS = 12_000;

/** What settlement needs from a transaction read at FINAL: its signer, key, nonce, receiver and every step's burn. */
export interface FinalTx {
  hash: string;
  signerId: string;
  publicKey: string;
  /** The transaction's nonce (a u64; a JSON number past 2^53 is refused as malformed). */
  nonce: bigint;
  receiverId: string;
  /** BigInt sums over the transaction outcome and every receipt outcome; null when an amount is malformed. */
  gas: { gasBurnt: bigint; tokensBurnt: bigint } | null;
}

export type TxRead = { kind: 'final'; tx: FinalTx } | { kind: 'not_final'; why: string };

export interface NearReader {
  /** The transaction at FINAL, or why it can't be read as final (not found, pending, RPC down). Never throws. */
  txFinal(hash: string, senderId: string): Promise<TxRead>;
  /** The access key's nonce at final; null when the account has no such key. Throws NearViewError when unreadable. */
  accessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null>;
}

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
/** A u64 (a JSON number or a decimal string) or a u128 (a decimal string), else null. */
function amount(v: unknown, max: bigint): bigint | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,38})$/u.test(v)) return null;
  const n = BigInt(v);
  return n <= max ? n : null;
}

/** BigInt sums of gas_burnt and tokens_burnt over transaction_outcome and every receipts_outcome; null if malformed. */
export function burntOf(result: Record<string, unknown>): { gasBurnt: bigint; tokensBurnt: bigint } | null {
  const txo = result.transaction_outcome as { outcome?: Record<string, unknown> } | undefined;
  const receipts = result.receipts_outcome;
  if (!txo?.outcome || !Array.isArray(receipts)) return null;
  let gasBurnt = 0n;
  let tokensBurnt = 0n;
  for (const step of [txo, ...(receipts as { outcome?: Record<string, unknown> }[])]) {
    const gas = amount(step?.outcome?.gas_burnt, U64_MAX);
    const tokens = amount(step?.outcome?.tokens_burnt, U128_MAX);
    if (gas === null || tokens === null) return null;
    gasBurnt += gas;
    tokensBurnt += tokens;
  }
  return { gasBurnt, tokensBurnt };
}

/** A `tx` answer at wait_until FINAL as settlement compares it; not final unless the RPC says FINAL. */
export function parseTxResult(body: unknown): TxRead {
  const b = body as { result?: Record<string, unknown>; error?: { name?: unknown; cause?: { name?: unknown } } } | null;
  if (!b || typeof b !== 'object') return { kind: 'not_final', why: 'malformed' };
  if (b.error) {
    const cause = typeof b.error.cause?.name === 'string' ? b.error.cause.name : typeof b.error.name === 'string' ? b.error.name : 'error';
    return { kind: 'not_final', why: cause.toLowerCase().replace(/[^a-z0-9_]/gu, '_').slice(0, 40) };
  }
  const r = b.result;
  if (!r || typeof r !== 'object') return { kind: 'not_final', why: 'malformed' };
  if (r.final_execution_status !== 'FINAL') return { kind: 'not_final', why: 'pending' };
  const t = r.transaction as Record<string, unknown> | undefined;
  const nonce = t ? amount(t.nonce, U64_MAX) : null;
  if (!t || typeof t.hash !== 'string' || typeof t.signer_id !== 'string' || typeof t.public_key !== 'string' || typeof t.receiver_id !== 'string' || nonce === null) {
    return { kind: 'not_final', why: 'malformed' };
  }
  return { kind: 'final', tx: { hash: t.hash, signerId: t.signer_id, publicKey: t.public_key, nonce, receiverId: t.receiver_id, gas: burntOf(r) } };
}

async function rpcCall(rpc: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'admin', method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new NearViewError(`${method}: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

/** The NEAR reads over the env's RPC (read-only: no key, no transaction). */
export function nearReader(rpc: string): NearReader {
  return {
    async txFinal(hash, senderId) {
      try {
        return parseTxResult(await rpcCall(rpc, 'tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'FINAL' }, TX_TIMEOUT_MS));
      } catch (err) {
        return { kind: 'not_final', why: err instanceof NearViewError ? 'rpc_http' : 'unreachable' };
      }
    },
    async accessKeyNonce(accountId, publicKey) {
      let body: { result?: { nonce?: unknown }; error?: { cause?: { name?: unknown } } } | null;
      try {
        body = (await rpcCall(rpc, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }, VIEW_TIMEOUT_MS)) as typeof body;
      } catch (err) {
        throw err instanceof NearViewError ? err : new NearViewError('view_access_key: unreachable');
      }
      if (body?.error) {
        if (body.error.cause?.name === 'UNKNOWN_ACCESS_KEY') return null;
        throw new NearViewError('view_access_key: error answer');
      }
      const n = amount(body?.result?.nonce, U64_MAX);
      if (n === null) throw new NearViewError('view_access_key: unexpected shape');
      return n;
    },
  };
}
