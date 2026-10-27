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

  /** `ttlMs` overrides the cache's TTL for this entry. */
  set(key: string, value: V, now = Date.now(), ttlMs = this.ttlMs): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, until: now + ttlMs });
  }

  /** Replaces an unexpired entry's value, keeping its expiry. Does nothing if there is none. */
  update(key: string, change: (value: V) => V, now = Date.now()): void {
    const hit = this.map.get(key);
    if (hit && hit.until > now) hit.value = change(hit.value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Drops every entry whose value matches. */
  deleteWhere(match: (value: V) => boolean): void {
    for (const [key, hit] of this.map) if (match(hit.value)) this.map.delete(key);
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

/**
 * (provider, aud) → scope id, ≤ 60 s; "no scope" (null) only ≤ 10 s, like the scope view, so a client added by an
 * executed AddClient is usable as soon as /v1/app reports it. Entries for a scope (and all nulls) are dropped after
 * every owner action relayed in this isolate.
 */
const scopeCache = new TtlCache<string | null>(60_000);
const NO_SCOPE_TTL_MS = 10_000;
/**
 * session public key → session, ≤ 10 s. Misses (null) are not cached: a session may have just been created. `used` is
 * kept in step with this isolate's own successful derives (recordSessionUse); other isolates' uses are not seen.
 */
const sessionCache = new TtlCache<SessionView>(10_000);

/** A shared-client addition still in its timelock (`set_shared_clients` additions wait `change_delay_ms`). */
export interface PendingSharedClient {
  client: [string, string];
  effective_at_ms: number;
}

/** `get_config()`: only the fields the API uses. */
export interface ConfigView {
  console_audiences: [string, string][];
  /** Hana's shared login clients `[provider, aud]` in force when read (matured pending additions included). */
  shared_clients: [string, string][];
  /** Additions not in force when read; one counts as shared once `effective_at_ms` has passed (the view may be cached). */
  pending_shared_clients: PendingSharedClient[];
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
  /** Users may log in through Hana's shared clients into this scope. */
  allow_shared: boolean;
}

/** get_config, ≤ 60 s. */
const configCache = new TtlCache<ConfigView>(60_000, 1);
/** scope id → scope (or null), ≤ 10 s; dropped after every owner action relayed for that scope. */
const scopeViewCache = new TtlCache<ScopeView | null>(10_000);

const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

/**
 * `get_config().pending_shared_clients`: `[{provider, aud, effective_at_ms}]`, additions still in their timelock.
 * Malformed entries are ignored (fail closed: an unreadable addition is not treated as shared).
 */
export function parsePendingShared(raw: unknown): PendingSharedClient[] {
  const list = (raw as { pending_shared_clients?: unknown } | null)?.pending_shared_clients;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e: unknown) => {
    const o = e as { provider?: unknown; aud?: unknown; effective_at_ms?: unknown } | null;
    return o && typeof o.provider === 'string' && typeof o.aud === 'string' && typeof o.effective_at_ms === 'number'
      ? [{ client: [o.provider, o.aud] as [string, string], effective_at_ms: o.effective_at_ms }]
      : [];
  });
}

export async function getConfig(env: Env): Promise<ConfigView> {
  const cached = configCache.get('config');
  if (cached) return cached;
  const raw = await new Rpc(env.NEAR_RPC).view<{ console_audiences?: unknown; shared_clients?: unknown } | null>(env.SIGNER_ACCOUNT, 'get_config', {});
  const value: ConfigView = {
    console_audiences: Array.isArray(raw?.console_audiences) ? raw.console_audiences.filter(isPair) : [],
    shared_clients: Array.isArray(raw?.shared_clients) ? raw.shared_clients.filter(isPair) : [],
    pending_shared_clients: parsePendingShared(raw),
  };
  configCache.set('config', value);
  return value;
}

/** Shared clients in force at `now`: the listed ones plus pending additions that matured since the (cached) read. */
export function effectiveSharedClients(config: ConfigView, now: number = Date.now()): [string, string][] {
  const out = [...config.shared_clients];
  for (const p of config.pending_shared_clients) {
    if (p.effective_at_ms <= now && !out.some(([a, b]) => a === p.client[0] && b === p.client[1])) out.push(p.client);
  }
  return out;
}

export const isSharedClient = (config: ConfigView, provider: string, aud: string, now: number = Date.now()): boolean =>
  effectiveSharedClients(config, now).some(([p, a]) => p === provider && a === aud);

/** Shared now or still pending (a client being added as shared can't also be a scope's own client). */
export const isSharedOrPending = (config: ConfigView, provider: string, aud: string): boolean =>
  config.shared_clients.some(([p, a]) => p === provider && a === aud) || config.pending_shared_clients.some(({ client: [p, a] }) => p === provider && a === aud);

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
      allow_shared: raw.allow_shared === true,
    };
  }
  scopeViewCache.set(scopeId, value);
  return value;
}

/** After an owner action for `scopeId`: its view, its clients and every cached "no scope" may have changed. */
export function forgetScope(scopeId: string): void {
  scopeViewCache.delete(scopeId);
  scopeCache.deleteWhere((s) => s === null || s === scopeId);
}

export async function scopeForClient(env: Env, provider: string, aud: string): Promise<string | null> {
  const key = JSON.stringify([provider, aud]);
  const cached = scopeCache.get(key);
  if (cached !== undefined) return cached;
  const scope = await new Rpc(env.NEAR_RPC).view<string | null>(env.SIGNER_ACCOUNT, 'scope_for_client', { provider, aud });
  const value = typeof scope === 'string' ? scope : null;
  scopeCache.set(key, value, Date.now(), value === null ? NO_SCOPE_TTL_MS : undefined);
  return value;
}

/** A `get_session` answer, and whether it came from this isolate's cache rather than the chain. */
export interface SessionRead {
  session: SessionView | null;
  cached: boolean;
}

/**
 * `get_session`, from the cache unless `fresh`. A fresh read replaces the cached entry (or drops it when the session is
 * gone), except that a higher `used` cached for the same session is kept: it counts a derive this isolate saw
 * executed, which the node that answered may not show yet (`used` only grows).
 */
export async function getSession(env: Env, sessionPublicKey: number[], opts: { fresh?: boolean } = {}): Promise<SessionRead> {
  const key = hex(new Uint8Array(sessionPublicKey));
  const cached = sessionCache.get(key);
  if (cached && !opts.fresh) return { session: cached, cached: true };
  const view = await new Rpc(env.NEAR_RPC).view<unknown>(env.SIGNER_ACCOUNT, 'get_session', { session_public_key: sessionPublicKey });
  if (!isSessionView(view)) {
    sessionCache.delete(key);
    return { session: null, cached: false };
  }
  const session = cached && sameSession(cached, view) && cached.used > view.used ? { ...view, used: cached.used } : view;
  sessionCache.set(key, session);
  return { session, cached: false };
}

/** The same session, not a newer one for the same key (a key is reusable once its session expired). */
const sameSession = (a: SessionView, b: SessionView): boolean => a.path === b.path && a.scope_id === b.scope_id && a.expires_at_ms === b.expires_at_ms && a.max_uses === b.max_uses;

/**
 * Whether create_session would refuse this key ("Session key already in use"): an unexpired session holds it, revoked
 * or not. A cached unexpired session answers yes without a view call; "no" is always read fresh from chain.
 */
export async function sessionKeyInUse(env: Env, sessionPublicKey: number[], now: number): Promise<boolean> {
  const cached = sessionCache.get(hex(new Uint8Array(sessionPublicKey)));
  if (cached && cached.expires_at_ms > now) return true;
  const inUse = await new Rpc(env.NEAR_RPC).view<boolean>(env.SIGNER_ACCOUNT, 'session_key_in_use', { session_public_key: sessionPublicKey });
  return inUse === true;
}

/** After our own create_session succeeds, remember the session so the first derive skips the view call. */
export function rememberSession(sessionPublicKey: number[], session: SessionView): void {
  sessionCache.set(hex(new Uint8Array(sessionPublicKey)), session);
}

/**
 * After our own derive_key with `counter` succeeded: the cached session (if still cached) has used it. Its expiry is
 * kept, so a revocation from elsewhere is still seen within 10 s of the read. `used` never goes down, so derives that
 * complete out of order leave the highest.
 */
export function recordSessionUse(sessionPublicKey: number[], counter: number): void {
  sessionCache.update(hex(new Uint8Array(sessionPublicKey)), (s) => ({ ...s, used: Math.max(s.used, counter) }));
}

export function forgetSession(sessionPublicKey: number[]): void {
  sessionCache.delete(hex(new Uint8Array(sessionPublicKey)));
}

export function isSessionView(v: unknown): v is SessionView {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.path === 'string' && typeof s.scope_id === 'string' && typeof s.expires_at_ms === 'number' && Number.isSafeInteger(s.max_uses) && Number.isSafeInteger(s.used);
}

/** Tests only. */
export function clearViewCaches(): void {
  scopeCache.clear();
  sessionCache.clear();
  configCache.clear();
  scopeViewCache.clear();
}
