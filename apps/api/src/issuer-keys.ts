// Hourly cron: copies Google's ID-token signing keys (JWKS) into hana-signer with the keys-updater key, a
// function-call key on SIGNER_ACCOUNT limited to set_issuer_key / remove_issuer_key.
import type { Env } from './env.ts';
import { log } from './log.ts';
import { Rpc, invalidNonce, isDefiniteRejection, type SendTxResult } from './near/rpc.ts';
import { type ContractCall, parseKeyPair, signFunctionCall, waitForOutcome } from './near/tx.ts';

export const GOOGLE_PROVIDER = 'google';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/**
 * A kid missing from the JWKS is removed on chain only once it has been missing this long (first seen missing by
 * one hourly run, still missing at the next), so a single stale or partial JWKS response can't drop a live key.
 */
export const REMOVE_AFTER_MISSING_MS = 55 * 60_000;
/** Ample for an RSA key insert/remove (the old post-google-keys.sh used 30 Tgas). */
const ISSUER_KEY_GAS = 30_000_000_000_000n;

export interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty?: string;
  alg?: string;
  use?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/u;

/** RS256 signing keys only (the contract verifies RS256 today). */
export function usableJwks(body: unknown): Jwk[] {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (k): k is Jwk =>
      typeof k === 'object' &&
      k !== null &&
      typeof k.kid === 'string' &&
      k.kid.length > 0 &&
      k.kid.length <= 128 &&
      k.kty === 'RSA' &&
      (k.alg === undefined || k.alg === 'RS256') &&
      (k.use === undefined || k.use === 'sig') &&
      typeof k.n === 'string' &&
      B64URL.test(k.n) &&
      typeof k.e === 'string' &&
      B64URL.test(k.e),
  );
}

/** `get_issuer(provider)` → kids. Accepts `{kids: [...]}`, `{keys: [...]}` or a bare array; null when unknown. */
export function issuerKids(view: unknown): string[] | null {
  const list = Array.isArray(view) ? view : (view as { kids?: unknown; keys?: unknown } | null)?.kids ?? (view as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return null;
  return list.filter((k): k is string => typeof k === 'string');
}

/**
 * What to change on chain. Adds come before removes so there is never a moment without Google's current keys, and
 * nothing is removed when the JWKS has no usable key (a broken fetch must not wipe the registry).
 */
export function diffIssuerKeys(jwks: Jwk[], onChainKids: string[]): { add: Jwk[]; remove: string[] } {
  const current = new Set(jwks.map((k) => k.kid));
  const onChain = new Set(onChainKids);
  const add = jwks.filter((k, i) => !onChain.has(k.kid) && jwks.findIndex((o) => o.kid === k.kid) === i);
  const remove = current.size === 0 ? [] : [...onChain].filter((kid) => !current.has(kid));
  return { add, remove };
}

export interface SyncResult {
  added: string[];
  removed: string[];
  failed: string[];
  skipped?: string;
}

/**
 * Applies the removal grace period: records when each kid in `missing` was first seen missing, forgets kids that are
 * no longer missing, and returns the kids missing for at least REMOVE_AFTER_MISSING_MS. Returns [] (remove nothing)
 * when D1 can't be used.
 */
export async function dueForRemoval(db: D1Database, provider: string, missing: string[], now: number): Promise<string[]> {
  try {
    const rows = await db.prepare('SELECT kid, first_missing_at FROM issuer_key_missing WHERE provider = ?1').bind(provider).all<{ kid: string; first_missing_at: number }>();
    const since = new Map(rows.results.map((r) => [r.kid, r.first_missing_at]));
    const stmts: D1PreparedStatement[] = [];
    for (const kid of since.keys()) {
      if (!missing.includes(kid)) stmts.push(db.prepare('DELETE FROM issuer_key_missing WHERE provider = ?1 AND kid = ?2').bind(provider, kid));
    }
    for (const kid of missing) {
      if (!since.has(kid)) stmts.push(db.prepare('INSERT OR IGNORE INTO issuer_key_missing (provider, kid, first_missing_at) VALUES (?1, ?2, ?3)').bind(provider, kid, now));
    }
    if (stmts.length) await db.batch(stmts);
    return missing.filter((kid) => {
      const first = since.get(kid);
      return first !== undefined && now - first >= REMOVE_AFTER_MISSING_MS;
    });
  } catch {
    log({ event: 'jwks_sync_failed', code: 'missing_kids_unavailable' }, 'error');
    return [];
  }
}

export async function syncIssuerKeys(env: Env, provider = GOOGLE_PROVIDER, jwksUrl = GOOGLE_JWKS_URL, now: number = Date.now()): Promise<SyncResult> {
  const result: SyncResult = { added: [], removed: [], failed: [] };
  if (!env.KEYS_UPDATER_KEY) {
    log({ event: 'jwks_sync_skipped', code: 'no_keys_updater_key' }, 'warn');
    return { ...result, skipped: 'no_keys_updater_key' };
  }
  const rpc = new Rpc(env.NEAR_RPC);

  let jwks: Jwk[];
  try {
    const res = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    jwks = usableJwks(await res.json());
  } catch {
    log({ event: 'jwks_sync_failed', code: 'jwks_fetch_failed' }, 'error');
    return { ...result, skipped: 'jwks_fetch_failed' };
  }
  if (jwks.length === 0) {
    log({ event: 'jwks_sync_failed', code: 'jwks_empty' }, 'error');
    return { ...result, skipped: 'jwks_empty' };
  }

  let onChain: string[] | null;
  try {
    onChain = issuerKids(await rpc.view<unknown>(env.SIGNER_ACCOUNT, 'get_issuer', { provider }));
  } catch {
    log({ event: 'jwks_sync_failed', code: 'get_issuer_failed' }, 'error');
    return { ...result, skipped: 'get_issuer_failed' };
  }
  if (onChain === null) {
    log({ event: 'jwks_sync_failed', code: 'issuer_not_configured' }, 'error');
    return { ...result, skipped: 'issuer_not_configured' };
  }

  const diff = diffIssuerKeys(jwks, onChain);
  const add = diff.add;
  const remove = await dueForRemoval(env.DB, provider, diff.remove, now);
  if (add.length === 0 && remove.length === 0) {
    log({ event: 'jwks_sync', outcome: 'ok', added: 0, removed: 0 });
    return result;
  }

  let sender: KeySender;
  try {
    sender = new KeySender(env, rpc);
  } catch {
    log({ event: 'jwks_sync_failed', code: 'bad_keys_updater_key' }, 'error');
    return { ...result, skipped: 'bad_keys_updater_key' };
  }
  for (const key of add) {
    const ok = await sender.call({ method: 'set_issuer_key', args: { provider, kid: key.kid, n: key.n, e: key.e }, gas: ISSUER_KEY_GAS });
    (ok ? result.added : result.failed).push(key.kid);
  }
  // Only drop old keys once every current key is on chain.
  if (result.failed.length === 0) {
    for (const kid of remove) {
      const ok = await sender.call({ method: 'remove_issuer_key', args: { provider, kid }, gas: ISSUER_KEY_GAS });
      (ok ? result.removed : result.failed).push(kid);
      if (ok) await env.DB.prepare('DELETE FROM issuer_key_missing WHERE provider = ?1 AND kid = ?2').bind(provider, kid).run().catch(() => undefined);
    }
  }
  log(
    { event: 'jwks_sync', outcome: result.failed.length ? 'error' : 'ok', added: result.added.length, removed: result.removed.length, kids: [...result.added, ...result.removed] },
    result.failed.length ? 'error' : 'info',
  );
  return result;
}

/** Sends txs one by one from the keys-updater key (signer == receiver == SIGNER_ACCOUNT). */
class KeySender {
  private nonce: bigint | null = null;
  private blockHash = '';
  private readonly keyPair;
  private readonly publicKey: string;

  constructor(
    private readonly env: Env,
    private readonly rpc: Rpc,
  ) {
    this.keyPair = parseKeyPair(env.KEYS_UPDATER_KEY ?? '');
    this.publicKey = this.keyPair.getPublicKey().toString();
  }

  private async refresh(): Promise<void> {
    const ak = await this.rpc.viewAccessKey(this.env.SIGNER_ACCOUNT, this.publicKey);
    this.nonce = BigInt(ak.nonce);
    this.blockHash = ak.block_hash;
  }

  async call(call: ContractCall): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (this.nonce === null) await this.refresh();
        const nonce = (this.nonce ?? 0n) + 1n;
        this.nonce = nonce;
        const signed = await signFunctionCall({ keyPair: this.keyPair, signerId: this.env.SIGNER_ACCOUNT, receiverId: this.env.SIGNER_ACCOUNT, nonce, blockHash: this.blockHash, call });
        let initial: SendTxResult | null = null;
        try {
          initial = await this.rpc.sendTx(signed.bytes, 'EXECUTED');
        } catch (err) {
          if (invalidNonce(err) && attempt === 0) {
            this.nonce = null;
            continue;
          }
          // Not a definite rejection: the tx may have been forwarded, so poll its outcome.
          if (isDefiniteRejection(err)) throw err;
        }
        const outcome = await waitForOutcome(this.rpc, signed.hash, this.env.SIGNER_ACCOUNT, initial);
        log({ event: 'jwks_tx', method: call.method, nearTx: signed.hash, outcome: outcome.ok ? 'ok' : 'error' }, outcome.ok ? 'info' : 'error');
        return outcome.ok;
      } catch {
        log({ event: 'jwks_tx', method: call.method, outcome: 'error', code: 'send_failed' }, 'error');
        return false;
      }
    }
    return false;
  }
}
