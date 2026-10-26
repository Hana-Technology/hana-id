// On-chain views used for the API's early scope checks, with small per-isolate caches.
import { hex } from './bytes.ts';
import type { Env } from './env.ts';
import { Rpc } from './near/rpc.ts';

export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; until: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2000,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.until <= now) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, until: now + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Session as returned by `get_session`. */
export interface SessionView {
  path: string;
  scope_id: string;
  expires_at_ms: number;
  max_uses: number;
  used: number;
}

/** (provider, aud) → scope id (or null), ≤ 60 s. */
const scopeCache = new TtlCache<string | null>(60_000);
/** session public key → session, ≤ 10 s. Misses (null) are not cached: a session may have just been created. */
const sessionCache = new TtlCache<SessionView>(10_000);

/** `get_config()`: only the fields the API uses. */
export interface ConfigView {
  console_audiences: [string, string][];
}

export interface PendingChangeView {
  id: number;
  change: unknown;
  unlock_at_ms: number;
}

/** `get_scope(scope_id)`: only the fields the API uses. */
export interface ScopeView {
  id: string;
  owners: unknown[];
  clients: [string, string][];
  pending: PendingChangeView[];
  action_nonce: number;
}

/** get_config, ≤ 60 s. */
const configCache = new TtlCache<ConfigView>(60_000, 1);
/** scope id → scope (or null), ≤ 10 s; dropped after every owner action relayed for that scope. */
const scopeViewCache = new TtlCache<ScopeView | null>(10_000);

const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

export async function getConfig(env: Env): Promise<ConfigView> {
  const cached = configCache.get('config');
  if (cached) return cached;
  const raw = await new Rpc(env.NEAR_RPC).view<{ console_audiences?: unknown } | null>(env.SIGNER_ACCOUNT, 'get_config', {});
  const audiences = Array.isArray(raw?.console_audiences) ? raw.console_audiences.filter(isPair) : [];
  const value = { console_audiences: audiences };
  configCache.set('config', value);
  return value;
}

export async function getScope(env: Env, scopeId: string): Promise<ScopeView | null> {
  const cached = scopeViewCache.get(scopeId);
  if (cached !== undefined) return cached;
  const raw = await new Rpc(env.NEAR_RPC).view<Record<string, unknown> | null>(env.SIGNER_ACCOUNT, 'get_scope', { scope_id: scopeId });
  let value: ScopeView | null = null;
  if (raw && typeof raw === 'object' && Array.isArray(raw.owners) && Array.isArray(raw.clients) && Array.isArray(raw.pending)) {
    value = {
      id: typeof raw.id === 'string' ? raw.id : scopeId,
      owners: raw.owners,
      clients: raw.clients.filter(isPair),
      pending: raw.pending.filter(
        (p): p is PendingChangeView => typeof p === 'object' && p !== null && Number.isSafeInteger((p as PendingChangeView).id) && typeof (p as PendingChangeView).unlock_at_ms === 'number',
      ),
      action_nonce: typeof raw.action_nonce === 'number' ? raw.action_nonce : 0,
    };
  }
  scopeViewCache.set(scopeId, value);
  return value;
}

export function forgetScope(scopeId: string): void {
  scopeViewCache.delete(scopeId);
}

export async function scopeForClient(env: Env, provider: string, aud: string): Promise<string | null> {
  const key = JSON.stringify([provider, aud]);
  const cached = scopeCache.get(key);
  if (cached !== undefined) return cached;
  const scope = await new Rpc(env.NEAR_RPC).view<string | null>(env.SIGNER_ACCOUNT, 'scope_for_client', { provider, aud });
  const value = typeof scope === 'string' ? scope : null;
  scopeCache.set(key, value);
  return value;
}

export async function getSession(env: Env, sessionPublicKey: number[]): Promise<SessionView | null> {
  const key = hex(new Uint8Array(sessionPublicKey));
  const cached = sessionCache.get(key);
  if (cached) return cached;
  const session = await new Rpc(env.NEAR_RPC).view<SessionView | null>(env.SIGNER_ACCOUNT, 'get_session', { session_public_key: sessionPublicKey });
  if (!isSessionView(session)) return null;
  sessionCache.set(key, session);
  return session;
}

/** After our own create_session succeeds, remember the session so the first derive skips the view call. */
export function rememberSession(sessionPublicKey: number[], session: SessionView): void {
  sessionCache.set(hex(new Uint8Array(sessionPublicKey)), session);
}

export function forgetSession(sessionPublicKey: number[]): void {
  sessionCache.delete(hex(new Uint8Array(sessionPublicKey)));
}

export function isSessionView(v: unknown): v is SessionView {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.path === 'string' && typeof s.scope_id === 'string' && typeof s.expires_at_ms === 'number';
}

/** Tests only. */
export function clearViewCaches(): void {
  scopeCache.clear();
  sessionCache.clear();
  configCache.clear();
  scopeViewCache.clear();
}
