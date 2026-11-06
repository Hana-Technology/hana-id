// DirectoryRpc (D275, confirmed by the user 2026-11-05; docs/batch-c-spec.md "Users and Support ID" → "Data path"): the
// staff Users screen's only way into the user directory (D269). A WorkerEntrypoint with no route (the issuer's public
// `fetch` doesn't change), bound only by the admin Worker as `ISSUER`. Its methods only read:
//
//   - `search`: identities by address (a full address exactly, else a substring of ≥ 3 characters), provider, app, sub
//     and "unverified only", keyset-paged newest first (an address search lists Google accounts' unverified claims
//     after the verified rows); a support reference (`ticket`) is required when the search names one identity (a sub
//     or a full address, console-core `searchNamesIdentity`, D410) and optional when it browses;
//   - `get`: one identity and its apps; the ticket is required; audited as `user_view`, or as `support_lookup` for the
//     Support ID lookup's email join (`purpose`, D399);
//   - `auditSince`: the issuer's `email_admin_audit` rows (no directory value in them), for the admin's audit view.
//
// Every call checks the staff member itself: the request's Cloudflare Access JWT (the admin application's AUD tag and
// team domain, `@hana-id/oidc`), and its email on the admin's staff list. That email is the actor. Every `search` and
// `get` writes its audit row in the same D1 batch as the read (a failed audit write returns no rows), and takes its
// rows from the staff member's row budget (DIRECTORY_ROW_LIMITS) first. A source test
// (scripts/test/directory-rpc-source.test.ts) holds this module to SELECTs on user_emails, user_email_apps and
// email_admin_audit, one INSERT into email_admin_audit, the DB and RATE_LIMITER bindings and EMAIL_RL_KEY only, and no
// import of the signer, keys, challenge or mail modules.
//
// Nothing here logs an address, a sub, a ticket, a staff email or the JWT.
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  DIRECTORY_PAGE_DEFAULT,
  DIRECTORY_SUBSTRING_MIN,
  SEARCH_TICKET_REQUIRED,
  type DirectoryAuditRow,
  type DirectoryBudgetRefusal,
  type DirectoryCode,
  type DirectoryFail,
  type DirectoryUserApp,
  type DirectoryUserRow,
  directoryAuditInput,
  directoryGetInput,
  directoryHealthInput,
  directorySearchInput,
  isFullAddress,
} from '@hana-id/console-core';
import { normalizeEmail } from '@hana-id/email';
import { BUILD_ID_RE } from '@hana-id/env/build-id';
import { AccessJwtVerifier, JwksUnavailableError } from '@hana-id/oidc';
import { base64Decode, base64UrlEncode, concatBytes, sha256, toHex, utf8 } from './bytes.ts';
import type { Env } from './env.ts';
import { DIRECTORY_ROW_LIMITS } from './limits.ts';
import { log } from './log.ts';

/** An identity's apps listed in one `get` (newest first; an identity with more is cut, `appsTruncated`). */
export const DIRECTORY_APPS_MAX = 200;
/** The audit `detail` of a search keeps the address term only as this many characters of a keyed hash. */
export const TERM_HASH_CHARS = 12;
const AUD_RE = /^[0-9a-f]{64}$/u;

type Fail = DirectoryFail;
const fail = (code: DirectoryCode, error?: string, budget?: DirectoryBudgetRefusal): Fail => ({ ok: false, code, ...(error ? { error } : {}), ...(budget ? { budget } : {}) });

// ---- the staff check ----

interface StaffConfig {
  verifier: AccessJwtVerifier;
  staff: ReadonlySet<string>;
}

let cached: { key: string; cfg: StaffConfig } | null = null;

/** The admin application's Access check from the issuer's vars, or null when unusable (every call then fails closed). */
export function staffConfig(env: Pick<Env, 'ADMIN_ACCESS_TEAM_DOMAIN' | 'ADMIN_ACCESS_AUD' | 'ADMIN_STAFF_EMAILS'>): StaffConfig | null {
  const team = env.ADMIN_ACCESS_TEAM_DOMAIN ?? '';
  const aud = env.ADMIN_ACCESS_AUD ?? '';
  const raw = env.ADMIN_STAFF_EMAILS ?? '';
  if (!team || !AUD_RE.test(aud) || !raw) return null;
  const key = `${team}\n${aud}\n${raw}`;
  if (cached?.key === key) return cached.cfg;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === 'string' && e.includes('@') && e === e.toLowerCase())) return null;
  let verifier: AccessJwtVerifier;
  try {
    // `fetch` looked up per call, so the certs request goes through whatever the isolate's fetch is.
    verifier = new AccessJwtVerifier({ teamDomain: team, aud, fetch: (url, init) => fetch(url, init) });
  } catch {
    return null;
  }
  cached = { key, cfg: { verifier, staff: new Set(list as string[]) } };
  return cached.cfg;
}

/** Test hook: forget the isolate's verifier (and with it the certs cache). */
export function resetDirectoryAccess(): void {
  cached = null;
}

async function staffOf(env: Env, jwt: string, requestId: string, now: number): Promise<{ ok: true; email: string } | Fail> {
  const cfg = staffConfig(env);
  if (!cfg) {
    log({ event: 'directory_refused', requestId, outcome: 'error', code: 'access_config_missing' }, 'error');
    return fail('access_unavailable', 'The issuer has no usable admin Access config (ADMIN_ACCESS_TEAM_DOMAIN, ADMIN_ACCESS_AUD, ADMIN_STAFF_EMAILS)');
  }
  let r: Awaited<ReturnType<AccessJwtVerifier['verify']>>;
  try {
    r = await cfg.verifier.verify(jwt, now);
  } catch (err) {
    log({ event: 'directory_refused', requestId, outcome: 'error', code: err instanceof JwksUnavailableError ? 'certs_unavailable' : 'verify_error' }, 'error');
    return fail('access_unavailable', 'The Access certs could not be read');
  }
  if (!r.ok) {
    log({ event: 'directory_refused', requestId, outcome: 'rejected', code: r.code }, 'warn');
    return fail('unauthenticated', 'The Access token was refused');
  }
  const email = r.identity.email.trim().toLowerCase();
  if (!cfg.staff.has(email)) {
    log({ event: 'directory_refused', requestId, outcome: 'rejected', code: 'not_staff' }, 'warn');
    return fail('not_staff', 'Not on the admin staff list');
  }
  return { ok: true, email };
}

// ---- the row budget ----

/**
 * The staff member's budget object: `staff-dir:` + hex sha256 of the email (a limiter key never holds an address, as the
 * issuer's other staff bucket, `staff:<sha256 hex>`).
 */
export const budgetObjectName = (envName: string, staff: string): string => `${envName}:staff-dir:${toHex(sha256(utf8(staff)))}`;
const budgetStub = (env: Env, staff: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(budgetObjectName(env.ENV_NAME, staff)));

async function takeRows(env: Env, staff: string, want: number, requestId: string, now: number): Promise<{ ok: true; granted: number; keys: string[] } | Fail> {
  const g = await budgetStub(env, staff).takeRows(DIRECTORY_ROW_LIMITS, want, now);
  if (g.ok) return g;
  // The admin Worker emails the security alias on this answer (a Direct kind, `directory_budget`).
  log({ event: 'directory_budget', requestId, outcome: 'rejected', code: 'rate_limited', limit: g.limit }, 'warn');
  return fail('rate_limited', 'This staff member’s directory row budget is used up', { window: g.limit.endsWith(':1h') ? '1h' : '1d', limit: g.max, retryAfterMs: g.retryAfterMs });
}

async function returnRows(env: Env, staff: string, keys: string[], n: number): Promise<void> {
  if (n > 0) await budgetStub(env, staff).returnRows(keys, n).catch(() => undefined);
}

// ---- the address term's keyed hash (the audit's `detail`) ----

/**
 * 12 characters of HMAC-SHA256(K_rl, label ‖ 0x00 ‖ value), b64url: the form unlock subjects take (a full address's
 * hash is its mailbox's, `mailbox` ‖ 0 ‖ the normalized address without its `+tag`, so an unlock and a search of the
 * same address carry the same subject); a substring's under its own label. Null without a usable EMAIL_RL_KEY.
 */
export async function termHash(rlKey: string | undefined, term: string): Promise<string | null> {
  if (!rlKey || !/^[A-Za-z0-9+/]{43}=$/u.test(rlKey)) return null;
  const raw = base64Decode(rlKey);
  if (raw.length !== 32) return null;
  let label = 'directory-term';
  let value = term.trim().toLowerCase();
  if (isFullAddress(term)) {
    const n = normalizeEmail(term);
    if (n.ok) {
      label = 'mailbox';
      value = n.mailbox;
    }
  }
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, concatBytes(utf8(label), Uint8Array.of(0), utf8(value))));
    return base64UrlEncode(mac).slice(0, TERM_HASH_CHARS);
  } finally {
    raw.fill(0);
  }
}

// ---- rows ----

interface UserSqlRow {
  provider: 'email' | 'google';
  sub: string;
  email: string;
  email_verified: number;
  hosted: number | null;
  first_seen_ms: number;
  last_seen_ms: number;
  claim: number;
  app_count: number;
}

const USER_COLUMNS = `ue.provider, ue.sub, ue.email, ue.email_verified, ue.hosted, ue.first_seen_ms, ue.last_seen_ms,
  CASE WHEN ue.provider = 'google' AND ue.email_verified = 0 THEN 1 ELSE 0 END AS claim,
  (SELECT COUNT(*) FROM user_email_apps a WHERE a.provider = ue.provider AND a.sub = ue.sub) AS app_count`;
const CLAIM = `CASE WHEN ue.provider = 'google' AND ue.email_verified = 0 THEN 1 ELSE 0 END`;

const userRow = (r: UserSqlRow): DirectoryUserRow => ({
  provider: r.provider,
  sub: r.sub,
  email: r.email,
  emailVerified: r.email_verified === 1,
  hosted: r.hosted === null ? null : r.hosted === 1,
  unverifiedClaim: r.claim === 1,
  firstSeenMs: r.first_seen_ms,
  lastSeenMs: r.last_seen_ms,
  appCount: r.app_count,
});

const cursorOf = (r: UserSqlRow, byClaim: boolean): string => `${byClaim ? r.claim : 0}:${r.last_seen_ms}:${r.provider}:${r.sub}`;

function parseCursor(c: string): { claim: number; seen: number; provider: string; sub: string } {
  const [claim, seen, provider, ...rest] = c.split(':');
  return { claim: Number(claim), seen: Number(seen), provider: provider!, sub: rest.join(':') };
}

/** The audit row's INSERT; `detailSql` is a JSON expression over `?` binds that come after the row's own. */
const AUDIT_INSERT = 'INSERT INTO email_admin_audit (at_ms, staff, action, ticket, detail) VALUES (?, ?, ?, ?, ';

export class DirectoryRpc extends WorkerEntrypoint<Env> {
  /** Identities matching the filters, newest first (an address search: verified rows first), at most `limit` (≤ 100). */
  async search(c: unknown): Promise<({ ok: true; users: DirectoryUserRow[]; next?: string }) | Fail> {
    const parsed = directorySearchInput.safeParse(c);
    // A search naming one identity without a ticket (D410) says so; anything else malformed is just that.
    if (!parsed.success) return fail('bad_request', parsed.error.issues.some((x) => x.message === SEARCH_TICKET_REQUIRED) ? SEARCH_TICKET_REQUIRED : 'Malformed search');
    const i = parsed.data;
    const now = Date.now();
    const who = await staffOf(this.env, i.accessJwt, i.requestId, now);
    if (!who.ok) return who;

    const where: string[] = [];
    const binds: unknown[] = [];
    const filters: Record<string, unknown> = {};
    let q: { match: 'exact' | 'substring'; hash: string } | null = null;
    const byClaim = i.q !== undefined;
    if (i.q !== undefined) {
      const term = i.q.trim();
      const exact = isFullAddress(term);
      if (!exact && term.length < DIRECTORY_SUBSTRING_MIN) return fail('bad_request', `An address search needs a full address or at least ${DIRECTORY_SUBSTRING_MIN} characters`);
      const hash = await termHash(this.env.EMAIL_RL_KEY, term);
      if (hash === null) {
        log({ event: 'directory_unavailable', requestId: i.requestId, outcome: 'error', code: 'no_rl_key' }, 'error');
        return fail('internal', 'The issuer cannot record an address search (EMAIL_RL_KEY)');
      }
      q = { match: exact ? 'exact' : 'substring', hash };
      if (exact) {
        // As typed and lowercased (Google rows) and normalized (email rows), as the CLI's `user:find --email`.
        const typed = term.toLowerCase();
        const n = normalizeEmail(term);
        const candidates = [...new Set([typed, ...(n.ok ? [n.email] : [])])];
        where.push(`ue.email IN (${candidates.map(() => '?').join(', ')})`);
        binds.push(...candidates);
      } else {
        where.push('instr(lower(ue.email), ?) > 0');
        binds.push(term.toLowerCase());
      }
    }
    if (i.provider !== undefined) {
      where.push('ue.provider = ?');
      binds.push(i.provider);
      filters.provider = i.provider;
    }
    if (i.sub !== undefined) {
      where.push('ue.sub = ?');
      binds.push(i.sub);
      filters.sub = i.sub;
    }
    if (i.appId !== undefined) {
      where.push('EXISTS (SELECT 1 FROM user_email_apps a WHERE a.provider = ue.provider AND a.sub = ue.sub AND a.app_id = ?)');
      binds.push(i.appId);
      filters.appId = i.appId;
    }
    if (i.unverifiedOnly) {
      where.push(`ue.provider = 'google' AND ue.email_verified = 0`);
      filters.unverifiedOnly = true;
    }
    if (i.cursor !== undefined) {
      const k = parseCursor(i.cursor);
      const after = '(ue.last_seen_ms < ? OR (ue.last_seen_ms = ? AND (ue.provider > ? OR (ue.provider = ? AND ue.sub > ?))))';
      if (byClaim) {
        where.push(`(${CLAIM} > ? OR (${CLAIM} = ? AND ${after}))`);
        binds.push(k.claim, k.claim, k.seen, k.seen, k.provider, k.provider, k.sub);
      } else {
        where.push(after);
        binds.push(k.seen, k.seen, k.provider, k.provider, k.sub);
      }
    }
    const order = `ORDER BY ${byClaim ? `${CLAIM} ASC, ` : ''}ue.last_seen_ms DESC, ue.provider ASC, ue.sub ASC`;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limit = i.limit ?? DIRECTORY_PAGE_DEFAULT;
    const grant = await takeRows(this.env, who.email, limit, i.requestId, now);
    if (!grant.ok) return grant;

    // `detail`: the filters, the address term only as its keyed hash, whether this is a later page, and (in SQL, from
    // the same query) the number of rows the read returns. Never the address.
    const detail = JSON.stringify({ filters, ...(q ? { q } : {}), page: i.cursor !== undefined ? 'next' : 'first', ...(grant.granted < limit ? { budgetCut: grant.granted } : {}) });
    const pageSql = `SELECT ${USER_COLUMNS} FROM user_emails ue ${whereSql} ${order} LIMIT ?`;
    const db = this.env.DB;
    let rows: UserSqlRow[];
    try {
      const [, read] = await db.batch<UserSqlRow>([
        db
          .prepare(`${AUDIT_INSERT}json_set(?, '$.rows', (SELECT COUNT(*) FROM (SELECT 1 FROM user_emails ue ${whereSql} LIMIT ?))))`)
          .bind(now, who.email, 'user_search', i.ticket ?? null, detail, ...binds, grant.granted),
        db.prepare(pageSql).bind(...binds, grant.granted),
      ]);
      rows = read!.results;
    } catch {
      await returnRows(this.env, who.email, grant.keys, grant.granted);
      log({ event: 'directory_read_failed', requestId: i.requestId, outcome: 'error', code: 'user_search' }, 'error');
      return fail('internal', 'The directory read or its audit row failed');
    }
    await returnRows(this.env, who.email, grant.keys, grant.granted - rows.length);
    log({ event: 'directory_read', requestId: i.requestId, outcome: 'ok', code: 'user_search', count: rows.length });
    const last = rows[rows.length - 1];
    return { ok: true, users: rows.map(userRow), ...(rows.length === grant.granted && last ? { next: cursorOf(last, byClaim) } : {}) };
  }

  /** One identity and its apps; the support reference is required. */
  async get(c: unknown): Promise<({ ok: true; user: DirectoryUserRow; apps: DirectoryUserApp[]; appsTruncated?: true }) | Fail> {
    const parsed = directoryGetInput.safeParse(c);
    if (!parsed.success) return fail('bad_request', 'Malformed lookup (a support reference is required to open a user)');
    const i = parsed.data;
    const now = Date.now();
    const who = await staffOf(this.env, i.accessJwt, i.requestId, now);
    if (!who.ok) return who;
    const grant = await takeRows(this.env, who.email, 1, i.requestId, now);
    if (!grant.ok) return grant;
    // The row's action says why the identity was read: the Users detail (`user_view`) or a Support ID lookup's email
    // join (`support_lookup`, D399), whose `lookup` is the admin request's id: the console's `support.lookup` row of the
    // same request.
    const action = i.purpose ?? 'user_view';
    const detail = action === 'support_lookup' ? { provider: i.provider, sub: i.sub, lookup: i.requestId } : { provider: i.provider, sub: i.sub };
    const db = this.env.DB;
    let user: UserSqlRow | undefined;
    let apps: { app_id: string; scope_id: string; first_seen_ms: number; last_seen_ms: number }[];
    try {
      const [, u, a] = await db.batch<Record<string, unknown>>([
        db
          .prepare(`${AUDIT_INSERT}json_set(?, '$.found', (SELECT COUNT(*) FROM user_emails WHERE provider = ? AND sub = ?)))`)
          .bind(now, who.email, action, i.ticket, JSON.stringify(detail), i.provider, i.sub),
        db.prepare(`SELECT ${USER_COLUMNS} FROM user_emails ue WHERE ue.provider = ? AND ue.sub = ?`).bind(i.provider, i.sub),
        db
          .prepare('SELECT app_id, scope_id, first_seen_ms, last_seen_ms FROM user_email_apps WHERE provider = ? AND sub = ? ORDER BY last_seen_ms DESC, app_id ASC LIMIT ?')
          .bind(i.provider, i.sub, DIRECTORY_APPS_MAX + 1),
      ]);
      user = u!.results[0] as unknown as UserSqlRow | undefined;
      apps = a!.results as unknown as typeof apps;
    } catch {
      await returnRows(this.env, who.email, grant.keys, grant.granted);
      log({ event: 'directory_read_failed', requestId: i.requestId, outcome: 'error', code: action }, 'error');
      return fail('internal', 'The directory read or its audit row failed');
    }
    if (!user) {
      await returnRows(this.env, who.email, grant.keys, grant.granted);
      log({ event: 'directory_read', requestId: i.requestId, outcome: 'rejected', code: 'not_found' });
      return fail('not_found', 'No directory row for this identity');
    }
    log({ event: 'directory_read', requestId: i.requestId, outcome: 'ok', code: action, count: 1 });
    const truncated = apps.length > DIRECTORY_APPS_MAX;
    return {
      ok: true,
      user: userRow(user),
      apps: apps.slice(0, DIRECTORY_APPS_MAX).map((r) => ({ appId: r.app_id, scopeId: r.scope_id, firstSeenMs: r.first_seen_ms, lastSeenMs: r.last_seen_ms })),
      ...(truncated ? { appsTruncated: true as const } : {}),
    };
  }

  /**
   * The issuer's staff audit (`email_admin_audit`: the directory reads above and the issuer's own staff routes): after
   * `id` oldest first, or before `before` newest first; by staff email and action. Its rows hold no end user's address,
   * so the read takes no row budget and writes no audit row of its own.
   */
  async auditSince(c: unknown): Promise<({ ok: true; rows: DirectoryAuditRow[] }) | Fail> {
    const parsed = directoryAuditInput.safeParse(c);
    if (!parsed.success) return fail('bad_request', 'Malformed audit query');
    const i = parsed.data;
    const who = await staffOf(this.env, i.accessJwt, i.requestId, Date.now());
    if (!who.ok) return who;
    const where: string[] = [];
    const binds: unknown[] = [];
    if (i.id !== undefined) {
      where.push('id > ?');
      binds.push(i.id);
    } else {
      where.push('id < ?');
      binds.push(i.before);
    }
    if (i.staff !== undefined) {
      where.push('staff = ?');
      binds.push(i.staff.toLowerCase());
    }
    if (i.action !== undefined) {
      where.push('action = ?');
      binds.push(i.action);
    }
    let rows: Record<string, unknown>[];
    try {
      rows = (
        await this.env.DB.prepare(
          `SELECT id, at_ms, staff, action, ticket, scope_id, action_nonce, jti, subject, detail FROM email_admin_audit WHERE ${where.join(' AND ')} ORDER BY id ${i.id !== undefined ? 'ASC' : 'DESC'} LIMIT ?`,
        )
          .bind(...binds, i.limit)
          .all()
      ).results;
    } catch {
      log({ event: 'directory_read_failed', requestId: i.requestId, outcome: 'error', code: 'audit' }, 'error');
      return fail('internal', 'The audit read failed');
    }
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: r.id as number,
        atMs: r.at_ms as number,
        staff: r.staff as string,
        action: r.action as string,
        ticket: (r.ticket as string | null) ?? null,
        scopeId: (r.scope_id as string | null) ?? null,
        actionNonce: (r.action_nonce as number | null) ?? null,
        jti: (r.jti as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        detail: parseDetail(r.detail),
      })),
    };
  }

  /**
   * The admin console's System status page (D425): the build this issuer runs and a timed `SELECT 1` on its D1. The
   * same staff check as every other method first (nothing is read before it); it reads no directory row, writes no
   * audit row, takes nothing from the row budget and answers no user data.
   */
  async health(c: unknown): Promise<{ ok: true; build: string | null; db: { ok: boolean; latencyMs: number } } | Fail> {
    const parsed = directoryHealthInput.safeParse(c);
    if (!parsed.success) return fail('bad_request', 'Malformed health call');
    const who = await staffOf(this.env, parsed.data.accessJwt, parsed.data.requestId, Date.now());
    if (!who.ok) return who;
    const build = this.env.HANA_BUILD;
    const start = Date.now();
    let dbOk = true;
    try {
      await this.env.DB.prepare('SELECT 1 AS one').first();
    } catch {
      dbOk = false;
      log({ event: 'directory_health', requestId: parsed.data.requestId, outcome: 'error', code: 'd1' }, 'error');
    }
    return { ok: true, build: build !== undefined && BUILD_ID_RE.test(build) ? build : null, db: { ok: dbOk, latencyMs: Date.now() - start } };
  }
}

function parseDetail(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}
