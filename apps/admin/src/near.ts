// The admin Worker's NEAR reads (docs/batch-c-spec.md "Hana admin console": "NEAR calls are read-only"): `get_scope`
// on the signer, uncached, for the on-chain watcher (C8); `tx` at FINAL for settlement and `view_access_key` at final
// for the nonce check (C12); `get_identity` and `get_account`, with the block height they were read at, for the Users
// screen's on-chain path (C8b, D275). No key, no transaction. Errors carry the method only, never the RPC's text.

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
  return (await viewAt(rpc, account, method, args)).value;
}

/** A view call's answer and the block it was read at (final). */
async function viewAt(rpc: string, account: string, method: string, args: unknown): Promise<{ value: unknown; blockHeight: number | null }> {
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
  const body = (await res.json().catch(() => null)) as { result?: { result?: number[]; block_height?: unknown }; error?: unknown } | null;
  if (!body || body.error || !Array.isArray(body.result?.result)) throw new NearViewError(`${method}: error answer`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as unknown;
  } catch {
    throw new NearViewError(`${method}: not JSON`);
  }
  const h = body.result.block_height;
  return { value, blockHeight: Number.isSafeInteger(h) ? (h as number) : null };
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

// ---- build plan batch 9: the email signer on chain, for the Email issuer page (D448) ----

/** `get_self_issued("email")`, `get_issuer_keys("email")` and `get_issuer("email")`: the signer policy and the active keys' thumbprints. */
export async function getEmailSignerPolicy(rpc: string, signer: string): Promise<{ required: number; signers: { id: string; kids: string[] }[]; keys: string[]; iss: string[] } | null> {
  const [policy, keys, issuer] = await Promise.all([
    view(rpc, signer, 'get_self_issued', { provider: 'email' }),
    view(rpc, signer, 'get_issuer_keys', { provider: 'email' }),
    view(rpc, signer, 'get_issuer', { provider: 'email' }),
  ]);
  if (policy === null) return null;
  const p = policy as { signers?: unknown; required?: unknown };
  if (!Array.isArray(p.signers) || typeof p.required !== 'number') throw new NearViewError('get_self_issued: unexpected shape');
  const signers = p.signers.map((s: unknown) => {
    const x = s as { id?: unknown; kids?: unknown };
    return { id: String(x.id), kids: Array.isArray(x.kids) ? x.kids.filter((k): k is string => typeof k === 'string') : [] };
  });
  const iss = Array.isArray((issuer as { iss_values?: unknown } | null)?.iss_values) ? ((issuer as { iss_values: unknown[] }).iss_values.filter((i): i is string => typeof i === 'string')) : [];
  return { required: p.required, signers, keys: Array.isArray(keys) ? (keys as { kid?: unknown }[]).flatMap((k) => (typeof k.kid === 'string' ? [k.kid] : [])) : [], iss };
}

// ---- batch C8b: an identity's standing for the Users screen ----

/** `get_identity(scope, provider, sub)` (docs/contract-interface.md "Identity"). */
export interface ChainIdentity {
  /** The identity key, hex. */
  key: string;
  /** `own` opens its own path; `member` its account root's; `pending` will, from `effectiveAtMs`. */
  status: 'own' | 'member' | 'pending';
  /** Its own path was derived ("has a wallet"). */
  opened: boolean;
  /** The account root, for member and pending. */
  root: { provider: string; sub: string } | null;
  effectiveAtMs: number | null;
  /** 0: in no account. */
  accountEpoch: number;
}

/** `get_account(scope, provider, sub)`: the account the identity is in, as root or member. */
export interface ChainAccount {
  root: { provider: string; sub: string };
  members: { key: string; provider: string; active: boolean; effectiveAtMs: number | null }[];
  epoch: number;
}

const isRef = (v: unknown): v is { provider: string; sub: string } => typeof v === 'object' && v !== null && typeof (v as { provider?: unknown }).provider === 'string' && typeof (v as { sub?: unknown }).sub === 'string';
const HEX32 = /^[0-9a-f]{64}$/u;
const msOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The identity's standing and the block it was read at. A malformed answer throws (never a guess). */
export async function getIdentity(rpc: string, signer: string, scopeId: string, provider: string, sub: string): Promise<{ identity: ChainIdentity; blockHeight: number | null }> {
  const { value, blockHeight } = await viewAt(rpc, signer, 'get_identity', { scope_id: scopeId, provider, sub });
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !HEX32.test(raw.key) || !['own', 'member', 'pending'].includes(raw.status as string) || typeof raw.opened !== 'boolean') {
    throw new NearViewError('get_identity: unexpected shape');
  }
  const root = raw.root === null || raw.root === undefined ? null : isRef(raw.root) ? { provider: raw.root.provider, sub: raw.root.sub } : undefined;
  if (root === undefined || (raw.status !== 'own' && root === null)) throw new NearViewError('get_identity: unexpected root');
  const epoch = Number.isSafeInteger(raw.account_epoch) ? (raw.account_epoch as number) : 0;
  return { identity: { key: raw.key, status: raw.status as ChainIdentity['status'], opened: raw.opened, root, effectiveAtMs: msOrNull(raw.effective_at_ms), accountEpoch: epoch }, blockHeight };
}

/** The identity's account (null: in none) and the block it was read at. A malformed answer throws. */
export async function getAccount(rpc: string, signer: string, scopeId: string, provider: string, sub: string): Promise<{ account: ChainAccount | null; blockHeight: number | null }> {
  const { value, blockHeight } = await viewAt(rpc, signer, 'get_account', { scope_id: scopeId, provider, sub });
  if (value === null) return { account: null, blockHeight };
  const raw = value as Record<string, unknown>;
  if (typeof raw !== 'object' || !isRef(raw.root) || !Array.isArray(raw.members) || !Number.isSafeInteger(raw.epoch)) throw new NearViewError('get_account: unexpected shape');
  const members = raw.members.map((m: unknown) => {
    const v = m as Record<string, unknown> | null;
    if (!v || typeof v.key !== 'string' || !HEX32.test(v.key) || typeof v.provider !== 'string' || typeof v.active !== 'boolean') throw new NearViewError('get_account: unexpected member');
    return { key: v.key, provider: v.provider, active: v.active, effectiveAtMs: msOrNull(v.effective_at_ms) };
  });
  return { account: { root: { provider: raw.root.provider, sub: raw.root.sub }, members, epoch: raw.epoch as number }, blockHeight };
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
