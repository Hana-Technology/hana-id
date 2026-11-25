// D927 (after PR 156's review, F2 and F5): which platform key ids this env has announced and not stopped, held in each
// isolate and read again from D1 at most every 30 s. The platform API's request check asks it before anything costs a
// D1 read or a key object's call: a key id it doesn't list (a random one, a stopped one, one of another env) gets the
// one 401 without reaching D1, and only a listed id may use the overflow past a full per-IP window. It is a filter in
// front of check 5, never the decision: a listed id is still read from D1 (in force now, its public key, its org).
//
// Listed: `pending` or `active`, announced (`notified_at`), not revoked (expired keys drop out when the hourly job marks
// them; until then check 5's own read refuses them). A newly announced key is listed within 30 s (the cache's age), so a
// network's first request after its key's announcement may get a 401 for up to 30 s; nothing else waits on it. At most
// two keys per org count (A5), so the list stays small; it is capped at 10 000 ids all the same.
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export const KNOWN_KEYS_REFRESH_MS = 30_000;
const MAX_IDS = 10_000;

let held: { at: number; ids: Set<string> } | null = null;
let loading: Promise<Set<string>> | null = null;

async function load(env: Pick<Env, 'DB'>): Promise<Set<string>> {
  const at = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id FROM platform_keys WHERE status IN ('pending', 'active') AND notified_at IS NOT NULL AND revoked_at IS NULL ORDER BY id LIMIT ?1",
  )
    .bind(MAX_IDS)
    .all<{ id: string }>();
  if (results.length >= MAX_IDS) log({ event: 'platform', outcome: 'error', code: 'known_keys_capped' }, 'error');
  const ids = new Set(results.map((r) => r.id));
  held = { at, ids };
  return ids;
}

/** The listed key ids (refreshed when older than 30 s; a failed refresh keeps the last list, else throws). */
export async function knownKeyIds(env: Pick<Env, 'DB'>): Promise<Set<string>> {
  const t = Date.now();
  if (held && t >= held.at && t - held.at < KNOWN_KEYS_REFRESH_MS) return held.ids;
  loading ??= load(env).finally(() => {
    loading = null;
  });
  try {
    return await loading;
  } catch (err) {
    if (held) {
      log({ event: 'platform', outcome: 'error', code: 'known_keys_refresh_failed' }, 'error');
      return held.ids;
    }
    throw err;
  }
}

/** Tests: forget the list (a key written by a bare D1 write is listed at the next request). */
export function clearKnownKeyIds(): void {
  held = null;
  loading = null;
}

/**
 * Key ids whose failed-signature alert already fired in a given minute (F5): their failures stop calling the key's
 * object until the minute ends. In this isolate only, at most 1 000 entries (cleared when full).
 */
const alerted = new Map<string, number>();
export const alertedThisMinute = (keyId: string, minute: number): boolean => alerted.get(keyId) === minute;
export function noteAlerted(keyId: string, minute: number): void {
  if (alerted.size >= 1000) alerted.clear();
  alerted.set(keyId, minute);
}
export const clearAlerted = (): void => alerted.clear();
