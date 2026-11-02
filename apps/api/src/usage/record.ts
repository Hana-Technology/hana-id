// The usage ledger writer (docs/batch-c-spec.md "Usage capture": "Write"): sends a UsageEvent v1 to Neon through the
// optional `USAGE_DB` Hyperdrive binding (role `usage_writer`, which may only call `usage.record_event`, D73), after
// the response. Fail open: no binding, a refusing or slow server, a bad event or a missing uid key never changes a
// response or delays it; a lost event is logged (`usage_write_failed`, `usage_write_rejected`) and never replayed. A
// connection error or timeout is retried once after USAGE_RETRY_DELAY_MS with the same event (same request_id and at:
// a duplicate is ignored by the function); a refusal by the server is not.
//
// Nothing here logs the connection string, a driver message (it can name the host), the event's path or the key.
import { LEGACY_ORG_ID, UID_ENDPOINTS, b64url, uidFromPath, usageEventV1, type UsageEventV1 } from '@hana-id/console-core';
import pg from 'pg';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export const USAGE_RETRY_DELAY_MS = 250;
/** Per attempt: Hyperdrive answers from Cloudflare's network; the writer role's statement_timeout is 5 s too. */
export const USAGE_CONNECT_TIMEOUT_MS = 5_000;
export const USAGE_QUERY_TIMEOUT_MS = 5_000;
export const RECORD_EVENT_SQL = 'SELECT usage.record_event($1::jsonb) AS recorded';

/** A ledger connection: one statement over a new connection, closed after it (Hyperdrive pools the real ones). */
export interface UsageTransport {
  query(binding: Hyperdrive, sql: string, params: unknown[]): Promise<void>;
}

/** The pg transport (the property is replaceable so tests can observe or fail the writes without a server). */
export const usageTransport: UsageTransport = {
  async query(binding, sql, params) {
    const client = new pg.Client({ connectionString: binding.connectionString, connectionTimeoutMillis: USAGE_CONNECT_TIMEOUT_MS, query_timeout: USAGE_QUERY_TIMEOUT_MS });
    try {
      await client.connect();
      await client.query(sql, params);
    } finally {
      await client.end().catch(() => undefined);
    }
  },
};

/** An event before the uid and, for an owner action, the org are known. */
export type UsageDraftEvent = Omit<UsageEventV1, 'org_id' | 'uid'> & { org_id: string | null };

const SQLSTATE_RE = /^[0-9A-Z]{5}$/u;
/** SQLSTATE classes worth one more try: connection exception, insufficient resources, operator intervention (a
 * cancelled statement: the 5 s timeout), system error, transaction rollback. */
const TRANSIENT_CLASSES: ReadonlySet<string> = new Set(['08', '53', '57', '58', '40']);

/**
 * How a failed write is handled: `retry` (no answer from the server, or a transient one), `rejected` (the function
 * refused the event's shape: SQLSTATE 22023 from `usage.event_invalid`), or `failed` (any other server refusal, e.g.
 * an event outside every partition, 23514). Only a `pg.DatabaseError` (the server's own answer) is read for a
 * SQLSTATE: any other error, a socket's errno code (`ECONNRESET`) included, is a connection error. `code` is safe to log
 * (a SQLSTATE or `connection`).
 */
export function classifyWriteError(err: unknown): { kind: 'retry' | 'rejected' | 'failed'; code: string } {
  const sqlstate = err instanceof pg.DatabaseError ? err.code : undefined;
  if (typeof sqlstate !== 'string' || !SQLSTATE_RE.test(sqlstate)) return { kind: 'retry', code: 'connection' };
  if (sqlstate === '22023') return { kind: 'rejected', code: `pg_${sqlstate}` };
  return { kind: TRANSIENT_CLASSES.has(sqlstate.slice(0, 2)) ? 'retry' : 'failed', code: `pg_${sqlstate}` };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Yields to the event loop (`scheduler.wait(0)` in Workers), so the caller returns its response first. */
export const afterResponse = (): Promise<void> => (typeof scheduler !== 'undefined' && typeof scheduler.wait === 'function' ? scheduler.wait(0) : sleep(0));

interface LogCtx {
  requestId: string;
  appId?: string;
  endpoint: string;
}

/** Sends one valid event; at most two attempts. Never rejects. */
async function send(binding: Hyperdrive, e: UsageEventV1, at: LogCtx): Promise<void> {
  const params = [JSON.stringify(e)];
  for (let attempt = 1; ; attempt++) {
    try {
      await usageTransport.query(binding, RECORD_EVENT_SQL, params);
      return;
    } catch (err) {
      const { kind, code } = classifyWriteError(err);
      if (kind === 'rejected') {
        log({ event: 'usage_write_rejected', ...at, code }, 'error');
        return;
      }
      if (kind === 'failed' || attempt >= 2) {
        log({ event: 'usage_write_failed', ...at, code, attempt }, 'error');
        return;
      }
      await sleep(USAGE_RETRY_DELAY_MS);
    }
  }
}

/** USER_ID_KEY (base64 of 32 bytes), parsed once per value; null (and one warning per value) when unusable. */
let uidKey: { raw: string | undefined; key: Uint8Array | null } | null = null;
function userIdKey(env: Pick<Env, 'USER_ID_KEY'>): Uint8Array | null {
  if (uidKey && uidKey.raw === env.USER_ID_KEY) return uidKey.key;
  let key: Uint8Array | null = null;
  try {
    const raw = env.USER_ID_KEY?.trim() ?? '';
    if (/^[A-Za-z0-9+/]{43}=$/u.test(raw)) key = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    key = null;
  }
  if (key?.length !== 32) {
    key = null;
    log({ event: 'usage_uid_unavailable', code: env.USER_ID_KEY === undefined ? 'missing_key' : 'bad_key' }, 'warn');
  }
  uidKey = { raw: env.USER_ID_KEY, key };
  return key;
}

/** The scope's org for an owner action (no gate row): the hot DB's, `org_legacy` for a scope it doesn't hold. */
async function scopeOrg(env: Env, scopeId: string, at: LogCtx): Promise<string> {
  try {
    const row = await env.DB.prepare('SELECT org_id FROM scopes WHERE scope_id = ?1').bind(scopeId).first<{ org_id: string }>();
    return row?.org_id ?? LEGACY_ORG_ID;
  } catch {
    log({ event: 'usage_org_unavailable', ...at, code: 'config_unavailable' }, 'warn');
    return LEGACY_ORG_ID;
  }
}

/**
 * Completes and writes one event (call it in `waitUntil`): the owner action's org, the uid (ok login, session and
 * derive with a path that parses for the event's scope, and a usable USER_ID_KEY), the UsageEvent v1 check (a refusal
 * is `usage_write_rejected`, never sent), then `usage.record_event`. Never rejects. Without `USAGE_DB` nothing is sent.
 */
export async function recordUsage(env: Env, draft: UsageDraftEvent, opts: { path?: string; logEndpoint: string }): Promise<void> {
  // Yield first: everything below (the uid's HMAC, the check, the connection) runs after the response has gone.
  await afterResponse();
  const binding = env.USAGE_DB;
  if (!binding) return;
  const at: LogCtx = { requestId: draft.request_id, appId: draft.app_id ?? undefined, endpoint: opts.logEndpoint };
  try {
    const event: Record<string, unknown> = { ...draft, org_id: draft.org_id ?? (await scopeOrg(env, draft.scope_id, at)) };
    if (draft.outcome === 'ok' && opts.path !== undefined && (UID_ENDPOINTS as readonly string[]).includes(draft.endpoint)) {
      const key = userIdKey(env);
      const uid = key ? await uidFromPath(key, draft.scope_id, opts.path) : null;
      if (uid) event.uid = b64url(uid);
      else if (key) log({ event: 'usage_uid_unavailable', ...at, code: 'bad_path' }, 'warn');
    }
    const checked = usageEventV1.safeParse(event);
    if (!checked.success) {
      const problems = checked.error.issues.slice(0, 5).map((i) => (i.path.length ? i.path.join('.') : i.message).slice(0, 80));
      log({ event: 'usage_write_rejected', ...at, code: 'invalid_event', problems }, 'error');
      return;
    }
    await send(binding, checked.data, at);
  } catch {
    log({ event: 'usage_write_failed', ...at, code: 'internal' }, 'error');
  }
}
