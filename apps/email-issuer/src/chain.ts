// hana-signer views through the manifest's RPC (and its fallback), read only: the issuer holds no chain-write key.
// Every answer is size-capped and shape-checked; the scope and config reads are cached 60 s per isolate (spec
// "Endpoints": "its scope must hold the email client (cached chain read, 60 s)"). Identity and account reads are never
// cached: the join an auto_link token commits to is read at minting (D133).
import { base64Encode } from './bytes.ts';
import { readCapped } from './http.ts';

export const RPC_TIMEOUT_MS = 8000;
export const RPC_MAX_RESPONSE_BYTES = 1024 * 1024;
export const VIEW_CACHE_MS = 60_000;

export class ChainUnavailable extends Error {}

export interface ScopeView {
  clients: [string, string][];
  allowShared: boolean;
}

export interface IdentityView {
  key: string;
  status: 'own' | 'member' | 'pending';
  opened: boolean;
  root: { provider: string; sub: string } | null;
  accountEpoch: number;
}

export interface AccountView {
  root: { provider: string; sub: string };
  members: { key: string; provider: string; active: boolean }[];
  epoch: number;
  unlinked: string[];
}

export interface Chain {
  scope(scopeId: string): Promise<ScopeView | null>;
  /** Google clients shared now (`get_config().shared_clients`, matured pending ones included). */
  sharedGoogleClients(): Promise<string[]>;
  /** `get_config().unrecorded_wallets` (D135): links are refused on chain while it is true. */
  unrecordedWallets(): Promise<boolean>;
  identity(scopeId: string, provider: string, sub: string): Promise<IdentityView>;
  account(scopeId: string, provider: string, sub: string): Promise<AccountView | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: unknown): v is { provider: string; sub: string } => isObj(v) && typeof v.provider === 'string' && typeof v.sub === 'string';
const isHex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

export class NearChain implements Chain {
  private readonly scopeCache = new Map<string, { v: ScopeView | null; at: number }>();
  private configCache: { v: Record<string, unknown>; at: number } | null = null;

  constructor(
    private readonly rpcs: string[],
    private readonly signer: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** One view call; tries each RPC in turn on a transport failure. A contract panic is not retried. */
  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'email-issuer',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: this.signer, method_name: method, args_base64: base64Encode(new TextEncoder().encode(JSON.stringify(args))) },
    });
    for (const rpc of this.rpcs) {
      let parsed: unknown;
      try {
        const res = await this.fetcher(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          continue;
        }
        parsed = JSON.parse(new TextDecoder().decode(await readCapped(res.body, RPC_MAX_RESPONSE_BYTES, res.headers.get('content-length'))));
      } catch {
        continue;
      }
      const result = isObj(parsed) && isObj(parsed.result) ? parsed.result : null;
      if (!result) continue;
      if (result.error !== undefined || !Array.isArray(result.result)) throw new ChainUnavailable(`view ${method} failed`);
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(result.result as number[])));
      } catch {
        throw new ChainUnavailable(`view ${method} returned no JSON`);
      }
    }
    throw new ChainUnavailable('no RPC answered');
  }

  async scope(scopeId: string): Promise<ScopeView | null> {
    const hit = this.scopeCache.get(scopeId);
    if (hit && this.now() - hit.at < VIEW_CACHE_MS) return hit.v;
    const raw = await this.view('get_scope', { scope_id: scopeId });
    let v: ScopeView | null = null;
    if (isObj(raw) && Array.isArray(raw.clients)) v = { clients: raw.clients.filter(isPair), allowShared: raw.allow_shared === true };
    else if (raw !== null) throw new ChainUnavailable('get_scope: unexpected answer');
    this.scopeCache.set(scopeId, { v, at: this.now() });
    return v;
  }

  private async config(fresh = false): Promise<Record<string, unknown>> {
    if (!fresh && this.configCache && this.now() - this.configCache.at < VIEW_CACHE_MS) return this.configCache.v;
    const raw = await this.view('get_config', {});
    if (!isObj(raw)) throw new ChainUnavailable('get_config: unexpected answer');
    this.configCache = { v: raw, at: this.now() };
    return raw;
  }

  async sharedGoogleClients(): Promise<string[]> {
    const c = await this.config();
    const now = this.now();
    const out = (Array.isArray(c.shared_clients) ? c.shared_clients.filter(isPair) : []).filter(([p]) => p === 'google').map(([, a]) => a);
    for (const p of Array.isArray(c.pending_shared_clients) ? c.pending_shared_clients : []) {
      if (isObj(p) && p.provider === 'google' && typeof p.aud === 'string' && typeof p.effective_at_ms === 'number' && p.effective_at_ms <= now && !out.includes(p.aud)) out.push(p.aud);
    }
    return out;
  }

  async unrecordedWallets(): Promise<boolean> {
    // Fresh: it is read right before minting a link token, and a stale `false` would only make the chain refuse.
    const c = await this.config(true);
    return c.unrecorded_wallets !== false;
  }

  async identity(scopeId: string, provider: string, sub: string): Promise<IdentityView> {
    const raw = await this.view('get_identity', { scope_id: scopeId, provider, sub });
    if (!isObj(raw) || !isHex32(raw.key) || !['own', 'member', 'pending'].includes(raw.status as string) || typeof raw.opened !== 'boolean' || !Number.isSafeInteger(raw.account_epoch)) {
      throw new ChainUnavailable('get_identity: unexpected answer');
    }
    const root = raw.root === null || raw.root === undefined ? null : isRef(raw.root) ? raw.root : undefined;
    if (root === undefined) throw new ChainUnavailable('get_identity: unexpected root');
    return { key: raw.key, status: raw.status as IdentityView['status'], opened: raw.opened, root, accountEpoch: raw.account_epoch as number };
  }

  async account(scopeId: string, provider: string, sub: string): Promise<AccountView | null> {
    const raw = await this.view('get_account', { scope_id: scopeId, provider, sub });
    if (raw === null) return null;
    if (!isObj(raw) || !isRef(raw.root) || !Array.isArray(raw.members) || !Number.isSafeInteger(raw.epoch)) throw new ChainUnavailable('get_account: unexpected answer');
    const members = raw.members.map((m) => {
      if (!isObj(m) || !isHex32(m.key) || typeof m.provider !== 'string' || typeof m.active !== 'boolean') throw new ChainUnavailable('get_account: unexpected member');
      return { key: m.key, provider: m.provider, active: m.active };
    });
    const unlinked = Array.isArray(raw.unlinked) ? raw.unlinked.filter(isHex32) : [];
    return { root: raw.root, members, epoch: raw.epoch as number, unlinked };
  }
}
