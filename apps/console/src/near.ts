// The console's one on-chain read (docs/batch-c-spec.md "On-chain owner actions" step 1, "Owner drift"): hana-signer's
// `get_scope`, always uncached, over the manifest's read-only RPC (`NEAR_RPC`). Optimistic finality, as the API's
// owner-action precheck reads it (apps/api/src/views.ts getScope), so the `action_nonce` the console builds an owner
// action at is the one the API recomputes the nonce from. A node that doesn't answer, answers late or answers something
// that isn't a scope is `NearUnavailable` (the routes answer 503 `near_unavailable`): never a guess.

/** How long the view may take (the API's VIEW_TIMEOUT_MS). */
export const NEAR_VIEW_TIMEOUT_MS = 8_000;
/** The view answer's cap (a scope is a few KiB at most: ≤ 5 owners, ≤ 10 pending changes, a few clients). */
const MAX_VIEW_BYTES = 64 * 1024;

export class NearUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NearUnavailable';
  }
}

/** hana-signer `Owner` as JSON. */
export type OwnerJson = { Near: { account_id: string } } | { Oidc: { provider: string; sub: string } };

export interface PendingChange {
  id: number;
  change: unknown;
  unlock_at_ms: number;
}

/** `get_scope(scope_id)`: the fields the console uses, checked. */
export interface ScopeView {
  id: string;
  owners: OwnerJson[];
  clients: [string, string][];
  allow_shared: boolean;
  pending: PendingChange[];
  action_nonce: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOwner = (o: unknown): o is OwnerJson =>
  isObj(o) &&
  ((isObj(o.Near) && typeof o.Near.account_id === 'string') || (isObj(o.Oidc) && typeof o.Oidc.provider === 'string' && typeof o.Oidc.sub === 'string'));
const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

/** A scope view as the contract returns it, or null when it isn't one (the caller fails closed). */
export function parseScope(raw: unknown): ScopeView | null {
  if (!isObj(raw)) return null;
  const { id, owners, clients, allow_shared: allowShared, pending, action_nonce: actionNonce } = raw;
  if (typeof id !== 'string' || !Array.isArray(owners) || !owners.every(isOwner) || !Array.isArray(clients) || !clients.every(isPair)) return null;
  if (typeof allowShared !== 'boolean' || !Array.isArray(pending) || typeof actionNonce !== 'number' || !Number.isSafeInteger(actionNonce) || actionNonce < 0) return null;
  const ok = pending.every((p) => isObj(p) && Number.isSafeInteger(p.id) && (p.id as number) >= 0 && Number.isSafeInteger(p.unlock_at_ms) && isObj(p.change));
  if (!ok) return null;
  return { id, owners, clients, allow_shared: allowShared, pending: pending as PendingChange[], action_nonce: actionNonce };
}

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** `get_scope(scope_id)` on `signer`, uncached: the scope, or null when the contract has none. */
export async function viewScope(env: { NEAR_RPC: string; SIGNER_ACCOUNT: string }, scopeId: string): Promise<ScopeView | null> {
  let res: Response;
  try {
    res = await fetch(env.NEAR_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'console',
        method: 'query',
        params: { request_type: 'call_function', finality: 'optimistic', account_id: env.SIGNER_ACCOUNT, method_name: 'get_scope', args_base64: b64(JSON.stringify({ scope_id: scopeId })) },
      }),
      signal: AbortSignal.timeout(NEAR_VIEW_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch {
    throw new NearUnavailable('NEAR RPC could not be reached');
  }
  if (res.status !== 200 || Number(res.headers.get('content-length') ?? 0) > MAX_VIEW_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new NearUnavailable(`NEAR RPC answered ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_VIEW_BYTES) throw new NearUnavailable('NEAR RPC answer too large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new NearUnavailable('NEAR RPC answer is not JSON');
  }
  const result = isObj(body) && isObj(body.result) ? body.result.result : undefined;
  if (!Array.isArray(result) || !result.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new NearUnavailable('NEAR RPC answered no view result');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(result as number[])));
  } catch {
    throw new NearUnavailable('The view result is not JSON');
  }
  if (value === null) return null;
  const scope = parseScope(value);
  if (!scope) throw new NearUnavailable('get_scope returned something that is not a scope');
  return scope;
}

/** The scope's `Owner::Oidc` owners as `{provider, sub}`. */
export const oidcOwners = (s: ScopeView): { provider: string; sub: string }[] => s.owners.flatMap((o) => ('Oidc' in o ? [o.Oidc] : []));
