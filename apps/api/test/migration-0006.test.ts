// Migration 0006 (docs/batch-c-spec.md §Hot DB "Migration 0006"; tests "Hot DB and gate"): on an empty database in
// order, and on a sandbox-dev-shaped database that is at 0001–0005 + 0008 (as sandbox-dev is), where it is the one
// unapplied file. Row counts are unchanged, every origin is in force from 0, every scope gets first_session_at, each
// app a baseline row; and batch B's gate, preflight and share SQL (copied below as they were before 0006) answer
// exactly what the new reads answer, before and after the migration.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { appSuspended, getAppByKey } from '../src/apps.ts';
import { isDevEnv, originAllowed, preflightAllows } from '../src/origins.ts';
import { servedOrigins } from '../src/vault/origins.ts';

const ALL = env.TEST_MIGRATIONS;
/** sandbox-dev's database before batch C3: 0001–0005 and 0008 (0008 applied on 2026-11-02; later files came after). */
const SANDBOX_DEV = ALL.filter((m) => m.name !== '0006_dashboard_expand.sql' && m.name < '0009');

const accepted = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<boolean> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => true,
      () => false,
    );

// ---- batch B's reads, verbatim as they were before 0006 ----

interface BatchBApp {
  id: string;
  name: string;
  scope_id: string;
  publishable_key: string;
  status: string;
  plan: string;
  google_web_client_id: string | null;
  per_minute: number;
  per_day: number;
  per_ip_minute: number;
  scope_conflict: boolean;
  origins: string[];
}

async function batchBGetAppByKey(db: D1Database, key: string): Promise<BatchBApp | null> {
  const row = await db
    .prepare(
      `SELECT a.id, a.name, a.scope_id, a.publishable_key, a.status, a.plan, a.google_web_client_id, p.per_minute, p.per_day, p.per_ip_minute,
              (a.publishable_key LIKE 'pk\\_test\\_%' ESCAPE '\\'
                AND EXISTS (SELECT 1 FROM apps l WHERE l.scope_id = a.scope_id AND l.publishable_key LIKE 'pk\\_live\\_%' ESCAPE '\\')) AS scope_conflict
         FROM apps a JOIN plans p ON p.id = a.plan
        WHERE a.publishable_key = ?1`,
    )
    .bind(key)
    .first<Omit<BatchBApp, 'origins' | 'scope_conflict'> & { scope_conflict: number }>();
  if (!row) return null;
  const { results } = await db.prepare('SELECT origin FROM app_origins WHERE app_id = ?1').bind(row.id).all<{ origin: string }>();
  return { ...row, scope_conflict: row.scope_conflict === 1, origins: results.map((r) => r.origin) };
}

const LOCALHOST_RE = /^http:\/\/localhost(:\d{1,5})?$/u;
const LOOPBACK_RE = /^https?:\/\/(([a-z0-9-]+\.)*localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d{1,5})?$/u;
const isTestKey = (k: string) => k.startsWith('pk_test_');

function batchBOriginAllowed(app: { publishable_key: string; origins: string[] }, origin: string | null, devEnv: boolean): boolean {
  if (!origin || origin === 'http://localhost:*') return false;
  const loopbackOk = devEnv && isTestKey(app.publishable_key);
  if (LOOPBACK_RE.test(origin) && !loopbackOk) return false;
  if (app.origins.includes(origin)) return true;
  return loopbackOk && LOCALHOST_RE.test(origin) && app.origins.includes('http://localhost:*');
}

async function batchBPreflight(db: D1Database, envName: string, origin: string): Promise<boolean> {
  const loopback = LOOPBACK_RE.test(origin);
  if (loopback && !isDevEnv(envName)) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM app_origins o JOIN apps a ON a.id = o.app_id
        WHERE a.status = 'active'
          AND (?3 = 0 OR a.publishable_key LIKE 'pk\\_test\\_%' ESCAPE '\\')
          AND (o.origin = ?1 OR (?2 = 1 AND o.origin = ?4))
        LIMIT 1`,
    )
    .bind(origin, LOCALHOST_RE.test(origin) ? 1 : 0, loopback ? 1 : 0, 'http://localhost:*')
    .first<{ ok: number }>();
  return !!row;
}

const SAFE_ORIGIN_RE = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/u;
function batchBServedOrigins(envName: string, app: { publishable_key: string; origins: string[] }): string[] {
  const loopbackOk = isTestKey(app.publishable_key) && isDevEnv(envName);
  const loopback = (o: string) => o === 'http://localhost:*' || LOOPBACK_RE.test(o);
  return [...new Set(app.origins)].filter((o) => (o === 'http://localhost:*' || SAFE_ORIGIN_RE.test(o)) && (loopbackOk || !loopback(o))).sort();
}

/** The share-path SQL (vault/shares.ts and vault/settings.ts read the app's settings by id beside each share). */
const SHARE_SQL = `SELECT hex(share_id) AS share, app_id, created_at + (SELECT session_ttl_ms FROM apps WHERE id = vault_shares.app_id) AS capped_abs,
       (SELECT idle_ttl_ms FROM apps WHERE id = vault_shares.app_id) AS idle_ttl, (SELECT persistence FROM apps WHERE id = vault_shares.app_id) AS persistence,
       (SELECT raw_sign || '|' || ifnull(raw_sign_pending, '') || '|' || ifnull(auto_approve_policy, '') || '|' || ifnull(auto_approve_pending, '') FROM apps WHERE id = vault_shares.app_id) AS settings
  FROM vault_shares ORDER BY share_id`;

// ---- a sandbox-dev-shaped database ----

const T = 1_761_000_000_000;
const POLICY = '{"v":1,"label":"Approvals"}';
interface SeedApp {
  id: string;
  key: string;
  scope: string;
  status?: string;
  plan?: string;
  origins: string[];
  settings?: Record<string, string | number | null>;
}
const KEYS = {
  global: 'pk_test_GLobaL1abcdefghijkmnop',
  s1a: 'pk_test_S1a1abcdefghijkmnopq',
  s1b: 'pk_test_S1b1abcdefghijkmnopq',
  suspended: 'pk_test_Susp1abcdefghijkmnop',
  live: 'pk_live_LiVe1abcdefghijkmnopq',
  bare: 'pk_test_Bare1abcdefghijkmnop',
};
const SNAPSHOT: SeedApp[] = [
  { id: 'app_global', key: KEYS.global, scope: 'global', origins: ['https://demo.example.com', 'http://localhost:*', 'http://127.0.0.1:5173', 'https://app.localhost'], settings: { auto_approve_policy: POLICY } },
  { id: 'app_s1a', key: KEYS.s1a, scope: 's1', origins: ['https://smoke.example.com', 'https://shared.example.com'] },
  { id: 'app_s1b', key: KEYS.s1b, scope: 's1', plan: 'pilot', origins: ['https://shared.example.com'], settings: { google_web_client_id: '111-web.apps.googleusercontent.com' } },
  { id: 'app_susp', key: KEYS.suspended, scope: 's2', status: 'suspended', origins: ['https://suspended.example.com', 'http://localhost:*'] },
  {
    id: 'app_live',
    key: KEYS.live,
    scope: 's5',
    origins: ['https://live.example.com', 'http://localhost:*'],
    settings: { raw_sign_pending: 'approval', raw_sign_effective_at: T + 86_400_000, auto_approve_pending: POLICY, auto_approve_effective_at: T + 86_400_000 },
  },
  { id: 'app_bare', key: KEYS.bare, scope: 's6', origins: [] },
];
const CANDIDATE_ORIGINS = [
  'https://demo.example.com',
  'https://smoke.example.com',
  'https://shared.example.com',
  'https://suspended.example.com',
  'https://live.example.com',
  'http://localhost:5173',
  'http://localhost:*',
  'http://127.0.0.1:5173',
  'https://app.localhost',
  'https://evil.example',
];
const ENV_NAMES = ['sandbox-dev', 'prod'];

async function seedSnapshot(db: D1Database): Promise<void> {
  await db.prepare("INSERT INTO plans (id, per_minute, per_day, per_ip_minute) VALUES ('pilot', 120, 10000, 30)").run();
  for (const a of SNAPSHOT) {
    await db.prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, plan, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(a.id, `Name ${a.id}`, a.scope, a.key, a.status ?? 'active', a.plan ?? 'free', T).run();
    for (const o of a.origins) await db.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?1, ?2)').bind(a.id, o).run();
    const settings = Object.entries(a.settings ?? {});
    if (settings.length) {
      await db
        .prepare(`UPDATE apps SET ${settings.map(([k], i) => `${k} = ?${i + 2}`).join(', ')} WHERE id = ?1`)
        .bind(a.id, ...settings.map(([, v]) => v))
        .run();
    }
    await db.prepare("INSERT INTO usage (app_id, day, sessions, derives, unlocks) VALUES (?1, '2026-10-30', 4, 3, 2)").bind(a.id).run();
    await db.prepare("INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, '2026-11-01', 7)").bind(a.id).run();
  }
  let n = 0;
  for (const appId of ['app_global', 'app_s1a', 'app_live']) {
    n++;
    const bytes = (len: number, fill: number) => new Uint8Array(len).fill(fill);
    await db
      .prepare(
        'INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, counter, created_at, idle_until, abs_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 2, ?7, ?8, ?9)',
      )
      .bind(bytes(16, n), appId, bytes(32, n), bytes(32, 100 + n), 'https://demo.example.com', bytes(60, 200 + n), T, T + 3_600_000, T + 43_200_000)
      .run();
  }
  await db.prepare("INSERT INTO identity_issuance_hourly (hour, kid, count) VALUES (?1, 'kid1', 9)").bind(T).run();
}

/** Every table but the migration bookkeeping, with its row count. */
async function rowCounts(db: D1Database, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  return out;
}

async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name").all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Everything batch B's reads answer for the snapshot, at `now`, through the given functions. */
async function answers(
  db: D1Database,
  read: {
    app: (key: string) => Promise<{ verdict: string; fields: Record<string, unknown> | null; allowed: (o: string, dev: boolean) => boolean; partnerDevCalls: boolean; served: (envName: string) => string[] } | null>;
    preflight: (envName: string, origin: string) => Promise<boolean>;
  },
): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...Object.values(KEYS), 'pk_test_Unknown1abcdefghijkm']) {
    const app = await read.app(key);
    if (!app) {
      out[key] = 'unknown_app';
      continue;
    }
    const allowed: Record<string, boolean> = {};
    for (const o of CANDIDATE_ORIGINS) for (const dev of [true, false]) allowed[`${o}|${dev}`] = app.allowed(o, dev);
    out[key] = { verdict: app.verdict, fields: app.fields, allowed, partnerDevCalls: app.partnerDevCalls, served: ENV_NAMES.map((e) => app.served(e)) };
  }
  for (const e of ENV_NAMES) for (const o of CANDIDATE_ORIGINS) out[`preflight|${e}|${o}`] = await read.preflight(e, o);
  out.shares = (await db.prepare(SHARE_SQL).all()).results;
  return out;
}

const batchB = (db: D1Database) =>
  answers(db, {
    app: async (key) => {
      const a = await batchBGetAppByKey(db, key);
      if (!a) return null;
      const verdict = a.status !== 'active' ? 'app_suspended' : a.scope_conflict ? 'scope_conflict' : 'ok';
      const { scope_conflict: _c, origins, ...fields } = a;
      return { verdict, fields: { ...fields, origins: [...origins].sort() }, allowed: (o, dev) => batchBOriginAllowed(a, o, dev), partnerDevCalls: isTestKey(a.publishable_key), served: (e) => batchBServedOrigins(e, a) };
    },
    preflight: (e, o) => batchBPreflight(db, e, o),
  });

const current = (db: D1Database, now: number) =>
  answers(db, {
    app: async (key) => {
      const a = await getAppByKey(db, key, now);
      if (!a) return null;
      const verdict = appSuspended(a) ? 'app_suspended' : a.scope_conflict ? 'scope_conflict' : 'ok';
      const fields = { id: a.id, name: a.name, scope_id: a.scope_id, publishable_key: a.publishable_key, status: a.status, plan: a.plan, google_web_client_id: a.google_web_client_id, per_minute: a.per_minute, per_day: a.per_day, per_ip_minute: a.per_ip_minute, origins: [...a.origins].sort() };
      return { verdict, fields, allowed: (o, dev) => originAllowed(a, o, dev), partnerDevCalls: a.environment === 'test', served: (e) => servedOrigins(e, a) };
    },
    preflight: (e, o) => preflightAllows(db, { ENV_NAME: e }, o, now),
  });

describe('0006 on a sandbox-dev-shaped database (0001–0005 and 0008 applied, then 0006)', () => {
  const db = env.SNAPSHOT_DB;
  let before: Record<string, number>;
  let tables: string[];
  let batchBBefore: unknown;
  let migratedAt: number;

  beforeAll(async () => {
    expect(SANDBOX_DEV.map((m) => m.name)).toEqual(['0001_init.sql', '0002_issuer_key_missing.sql', '0003_vault.sql', '0004_issuer_key_observations.sql', '0005_issuer_key_sync.sql', '0008_identity_token.sql']);
    await applyD1Migrations(db, SANDBOX_DEV);
    await seedSnapshot(db);
    tables = await tableNames(db);
    before = await rowCounts(db, tables);
    batchBBefore = await batchB(db);
    migratedAt = Date.now();
    // wrangler applies the unapplied files in name order: here 0006 alone, after 0008 (as batch C3's deploy did; later
    // files came with later batches).
    await applyD1Migrations(db, ALL.filter((m) => m.name < '0009'));
  });

  it('applies 0006 last and only 0006', async () => {
    const { results } = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...SANDBOX_DEV.map((m) => m.name), '0006_dashboard_expand.sql']);
  });

  it('keeps every row of every existing table (apps, origins, legacy usage, vault shares, identity counts, plans, issuer keys)', async () => {
    expect(before).toMatchObject({ apps: 6, app_origins: 11, usage: 6, vault_shares: 3, identity_usage: 6, identity_issuance_hourly: 1, plans: 2 });
    expect(await rowCounts(db, tables)).toEqual(before);
  });

  it('batch B’s gate, preflight and share SQL answer the same after 0006, and so do the new reads', async () => {
    expect(await batchB(db)).toEqual(batchBBefore);
    expect(await current(db, Date.now())).toEqual(batchBBefore);
  });

  it('backfills: one scope per scope id in org_legacy with the migration time, origins in force from 0, a key per app, the Hana bit for suspended apps', async () => {
    const { results: scopes } = await db.prepare('SELECT * FROM scopes ORDER BY scope_id').all<Record<string, unknown>>();
    expect(scopes.map((s) => [s.scope_id, s.org_id, s.environment])).toEqual([
      ['global', 'org_legacy', 'test'],
      ['s1', 'org_legacy', 'test'],
      ['s2', 'org_legacy', 'test'],
      ['s5', 'org_legacy', 'live'],
      ['s6', 'org_legacy', 'test'],
    ]);
    for (const s of scopes) {
      expect(s.first_session_at).toBe(s.created_at);
      expect(s.assigned_at).toBe(s.created_at);
      expect(Math.abs((s.created_at as number) - migratedAt)).toBeLessThan(60_000);
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM app_origins WHERE active_from IS NOT 0 OR change_id IS NOT NULL').first()).toEqual({ n: 0 });
    const { results: keys } = await db.prepare('SELECT k.id, k.key = a.publishable_key AS same, k.revoked_at FROM app_keys k JOIN apps a ON a.id = k.app_id ORDER BY k.id').all();
    expect(keys).toEqual(SNAPSHOT.map((a) => ({ id: `key_legacy_${a.id}`, same: 1, revoked_at: null })).sort((x, y) => (x.id < y.id ? -1 : 1)));
    const { results: apps } = await db.prepare('SELECT id, org_id, suspended_by, status, origins_version, settings_version, logo_key, deleted_at FROM apps ORDER BY id').all();
    for (const a of apps) expect(a).toMatchObject({ org_id: 'org_legacy', suspended_by: a.id === 'app_susp' ? 1 : 0, origins_version: 0, settings_version: 0, logo_key: null, deleted_at: null });
  });

  it('writes one migration.baseline row per app with its origins, policies and raw-signing values', async () => {
    const { results } = await db.prepare("SELECT app_id, scope_id, org_id, detail_json, actor_kind, actor_id, request_id FROM app_changes WHERE kind = 'migration.baseline' ORDER BY app_id").all<Record<string, string>>();
    expect(results.map((r) => r.app_id)).toEqual(SNAPSHOT.map((a) => a.id).sort());
    const live = results.find((r) => r.app_id === 'app_live')!;
    expect(live).toMatchObject({ scope_id: 's5', org_id: 'org_legacy', actor_kind: 'system', actor_id: 'migration:0006', request_id: 'migration-0006:app_live' });
    expect(JSON.parse(live.detail_json!)).toEqual({
      origins: ['http://localhost:*', 'https://live.example.com'],
      autoApprovePolicy: null,
      autoApprovePending: POLICY,
      autoApproveEffectiveAt: T + 86_400_000,
      rawSign: 'off',
      rawSignPending: 'approval',
      rawSignEffectiveAt: T + 86_400_000,
      suspendedBy: 0,
    });
    expect(JSON.parse(results.find((r) => r.app_id === 'app_bare')!.detail_json!).origins).toEqual([]);
    expect(JSON.parse(results.find((r) => r.app_id === 'app_global')!.detail_json!).autoApprovePolicy).toBe(POLICY);
  });

  it('keeps apps_scope_id and app_origins_origin, and adds the new indexes and triggers', async () => {
    const { results } = await db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all<{ type: string; name: string }>();
    const names = results.map((r) => r.name);
    for (const n of [
      'apps_scope_id',
      'app_origins_origin',
      'apps_org_id',
      'app_keys_app_id',
      'guarded_changes_app',
      'guarded_changes_unnotified',
      'guarded_changes_due',
      'app_changes_org_seq',
      'security_events_unnotified',
      'apps_scope_insert',
      'apps_scope_update',
      'scopes_org_update',
      'scopes_environment_fixed',
      'apps_suspended_by',
      'app_keys_insert',
      'app_origins_insert',
      'guarded_changes_insert',
      'app_changes_no_update',
      'app_changes_no_early_delete',
    ]) {
      expect(names, n).toContain(n);
    }
  });

  it('a suspended_by write shows as status; clearing it shows as active', async () => {
    await db.prepare("UPDATE apps SET suspended_by = 4 WHERE id = 'app_bare'").run();
    expect(await db.prepare("SELECT status FROM apps WHERE id = 'app_bare'").first()).toEqual({ status: 'suspended' });
    expect((await getAppByKey(db, KEYS.bare))!.suspended_by).toBe(4);
    await db.prepare("UPDATE apps SET suspended_by = 0 WHERE id = 'app_bare'").run();
    expect(await db.prepare("SELECT status FROM apps WHERE id = 'app_bare'").first()).toEqual({ status: 'active' });
  });

  // Last in this block: it applies the later files on the same database.
  it('then the later files apply in name order (0009 batch C4, 0010 email login, 0011 the wallet directory, 0012 the last token sighting, 0013 the mainnet demo and user events, 0014 email sharing, 0015 link counts, 0016 the Home list, 0017 vault consents), every app Google-only and sharing no email', async () => {
    await applyD1Migrations(db, ALL);
    const { results } = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    expect(results.map((r) => r.name).slice(-10)).toEqual(['0006_dashboard_expand.sql', '0009_session_markers.sql', '0010_login_methods.sql', '0011_wallet_directory.sql', '0012_issuer_key_last_token.sql', '0013_mainnet_demo_events.sql', '0014_email_sharing.sql', '0015_link_usage.sql', '0016_home_apps.sql', '0017_vault_consents.sql']);
    const sharing = await db.prepare('SELECT DISTINCT identity_email FROM apps').all<{ identity_email: string }>();
    expect(sharing.results.map((r) => r.identity_email)).toEqual(['off']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM email_consents').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM end_users').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM hana_held_clients').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM scopes WHERE home_quiet <> 0').first()).toEqual({ n: 0 });
    const methods = await db.prepare('SELECT DISTINCT login_methods FROM apps').all<{ login_methods: string }>();
    expect(methods.results.map((r) => r.login_methods)).toEqual(['google']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM email_usage').first()).toEqual({ n: 0 });
    // 0013: every existing app starts with the mainnet demo off, and no user event.
    const demo = await db.prepare('SELECT DISTINCT mainnet_demo FROM apps').all<{ mainnet_demo: number }>();
    expect(demo.results.map((r) => r.mainnet_demo)).toEqual([0]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM user_events').first()).toEqual({ n: 0 });
  });
});

describe('0006 refuses a scope that mixes test and live keys', () => {
  it('aborts as a whole: no 0006 table, no 0006 row in d1_migrations, the apps untouched', async () => {
    const db = env.MIX_DB;
    await applyD1Migrations(db, SANDBOX_DEV);
    await db.prepare("INSERT INTO apps (id, name, scope_id, publishable_key) VALUES ('t', 'T', 's9', 'pk_test_Mix1abcdefghijkmnop')").run();
    await db.prepare("INSERT INTO apps (id, name, scope_id, publishable_key) VALUES ('l', 'L', 's9', 'pk_live_Mix1abcdefghijkmnop')").run();
    await expect(applyD1Migrations(db, ALL)).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('scopes', 'app_keys', 'guarded_changes', 'app_changes')").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name = '0006_dashboard_expand.sql'").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('apps') WHERE name = 'suspended_by'").first()).toEqual({ n: 0 });
  });
});

describe('0006 on an empty database, in order', () => {
  const db = env.FRESH_DB;
  const now = Date.now();
  const scope = (id: string, environment: string, org = 'org_legacy') =>
    db.prepare('INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, ?2, ?3, NULL, ?4, ?4)').bind(id, org, environment, now).run();
  const app = (id: string, scopeId: string, key: string, org = 'org_legacy') =>
    accepted(db, 'INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES (?1, ?1, ?2, ?3, ?4)', id, scopeId, org, key);

  beforeAll(async () => {
    expect(ALL.map((m) => m.name)).toEqual(['0001_init.sql', '0002_issuer_key_missing.sql', '0003_vault.sql', '0004_issuer_key_observations.sql', '0005_issuer_key_sync.sql', '0006_dashboard_expand.sql', '0008_identity_token.sql', '0009_session_markers.sql', '0010_login_methods.sql', '0011_wallet_directory.sql', '0012_issuer_key_last_token.sql', '0013_mainnet_demo_events.sql', '0014_email_sharing.sql', '0015_link_usage.sql', '0016_home_apps.sql', '0017_vault_consents.sql']);
    await applyD1Migrations(db, ALL);
    await scope('sa', 'test');
    await scope('sl', 'live');
    await scope('sb', 'test', 'org_b');
  });

  it('creates the tables empty', async () => {
    for (const t of ['scopes', 'app_keys', 'guarded_changes', 'app_changes', 'security_events', 'org_security_contacts']) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first(), t).toEqual({ n: t === 'scopes' ? 3 : 0 });
    }
  });

  it('an app needs its scope row in its org, with the environment its key names', async () => {
    expect(await app('a_none', 'nope', 'pk_test_A1abcdefghijkmnopqr')).toBe(false);
    expect(await app('a_org', 'sa', 'pk_test_A2abcdefghijkmnopqr', 'org_b')).toBe(false);
    expect(await app('a_env', 'sa', 'pk_live_A3abcdefghijkmnopqr')).toBe(false);
    expect(await app('a_env2', 'sl', 'pk_test_A4abcdefghijkmnopqr')).toBe(false);
    expect(await app('a_ok', 'sa', 'pk_test_A5abcdefghijkmnopqr')).toBe(true);
    expect(await app('a_live', 'sl', 'pk_live_A6abcdefghijkmnopqr')).toBe(true);
    expect(await app('b_ok', 'sb', 'pk_test_A7abcdefghijkmnopqr', 'org_b')).toBe(true);
  });

  it('updating one app’s org or scope alone is refused; moving the scope moves every app in one statement', async () => {
    await app('a_two', 'sa', 'pk_test_A8abcdefghijkmnopqr');
    expect(await accepted(db, "UPDATE apps SET org_id = 'org_b' WHERE id = 'a_ok'")).toBe(false);
    expect(await accepted(db, "UPDATE apps SET scope_id = 'sl' WHERE id = 'a_ok'")).toBe(false);
    expect(await accepted(db, "UPDATE scopes SET org_id = 'org_c' WHERE scope_id = 'sa'")).toBe(true);
    const { results } = await db.prepare("SELECT id, org_id FROM apps WHERE scope_id = 'sa' ORDER BY id").all();
    expect(results).toEqual([
      { id: 'a_ok', org_id: 'org_c' },
      { id: 'a_two', org_id: 'org_c' },
    ]);
    expect(await accepted(db, "UPDATE scopes SET environment = 'live' WHERE scope_id = 'sa'")).toBe(false);
    expect(await accepted(db, "UPDATE scopes SET environment = 'test' WHERE scope_id = 'sa'")).toBe(true);
    await db.prepare("UPDATE scopes SET org_id = 'org_legacy' WHERE scope_id = 'sa'").run();
  });

  it('a key needs an existing app and the prefix of its scope’s environment; origins and guarded changes need the app', async () => {
    const key = (id: string, appId: string, k: string) => accepted(db, "INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 't', 1)", id, appId, k);
    expect(await key('k1', 'nope', 'pk_test_K1abcdefghijkmnopqr')).toBe(false);
    expect(await key('k2', 'a_ok', 'pk_live_K2abcdefghijkmnopqr')).toBe(false);
    expect(await key('k3', 'a_live', 'pk_test_K3abcdefghijkmnopqr')).toBe(false);
    expect(await key('k4', 'a_ok', 'pk_test_K4abcdefghijkmnopqr')).toBe(true);
    expect(await key('k5', 'a_ok', 'pk_test_K4abcdefghijkmnopqr')).toBe(false); // unique
    expect(await accepted(db, "INSERT INTO app_origins (app_id, origin, active_from) VALUES ('nope', 'https://x.example', 0)")).toBe(false);
    const gc = (id: string, appId: string, extra = "'origin_add', 'https://x.example', NULL, NULL") =>
      accepted(db, `INSERT INTO guarded_changes (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('${id}', '${appId}', ${extra}, 'pending', 'hana', 's', 1, 'r')`);
    expect(await gc('gc_a', 'nope')).toBe(false);
    expect(await gc('gc_b', 'a_ok')).toBe(true);
    // The kind's own field, and only it.
    expect(await gc('gc_c', 'a_ok', "'origin_add', NULL, NULL, NULL")).toBe(false);
    expect(await gc('gc_d', 'a_ok', "'policy_set', NULL, '{}', NULL")).toBe(false);
    expect(await gc('gc_e', 'a_ok', "'policy_set', NULL, '{}', 'abc'")).toBe(true);
    expect(await gc('gc_f', 'a_ok', "'raw_sign_on', 'https://x.example', NULL, NULL")).toBe(false);
  });

  it('suspended_by holds 0..7 only', async () => {
    expect(await accepted(db, "UPDATE apps SET suspended_by = 8 WHERE id = 'a_ok'")).toBe(false);
    expect(await accepted(db, "UPDATE apps SET suspended_by = -1 WHERE id = 'a_ok'")).toBe(false);
    expect(await accepted(db, "UPDATE apps SET suspended_by = 7 WHERE id = 'a_ok'")).toBe(true);
    await db.prepare("UPDATE apps SET suspended_by = 0 WHERE id = 'a_ok'").run();
  });

  it('app_changes is append-only: no update; delete only once a row is 60 months old', async () => {
    const insert = (rid: string, at: number) =>
      db.prepare("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, 'org_legacy', 'a_ok', 'test', '{}', 'system', 't', ?2)").bind(at, rid).run();
    await insert('r_new', now);
    await insert('r_old', now - 61 * 31 * 86_400_000);
    expect(await accepted(db, "INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'o', 'k', 'not json', 'system', 't', 'r_bad')")).toBe(false);
    expect(await accepted(db, "INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'o', 'k', '{}', 'staff', 't', 'r_kind')")).toBe(false);
    expect(await accepted(db, "UPDATE app_changes SET kind = 'x' WHERE request_id = 'r_new'")).toBe(false);
    expect(await accepted(db, "DELETE FROM app_changes WHERE request_id = 'r_new'")).toBe(false);
    expect(await accepted(db, "DELETE FROM app_changes WHERE request_id = 'r_old'")).toBe(true);
    expect(await accepted(db, "INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'o', 'k', '{}', 'system', 't', 'r_new')")).toBe(false); // unique request id
  });

  it('security contacts are lowercased; security events have a known kind', async () => {
    expect(await accepted(db, "INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES ('o', 'Sec@Example.com', 's', 1)")).toBe(false);
    expect(await accepted(db, "INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES ('o', 'sec@example.com', 's', 1)")).toBe(true);
    expect(await accepted(db, "INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_1', 1, 'drift', '{}')")).toBe(true);
    expect(await accepted(db, "INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_2', 1, 'other', '{}')")).toBe(false);
  });
});
