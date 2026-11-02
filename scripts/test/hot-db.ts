// A hot DB for the CLI tests: node:sqlite with every apps/api migration applied in name order (as a fresh D1 gets
// them), and a `d1` function that runs a command as `wrangler d1 execute --command` would. Deliberately without a
// transaction around a command (each statement commits on its own): the CLI's commit protocol (admin-sql.ts "writes")
// must hold whether or not D1 runs a multi-statement command atomically (D207).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '@hana-id/env';

export const MIGRATIONS_DIR = join(repoRoot, 'apps', 'api', 'migrations');

export function newHotDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  return db;
}

const COMMIT_READ = ';\nSELECT COUNT(*) AS committed FROM app_changes WHERE request_id = ';

export function d1Of(db: DatabaseSync): (command: string) => Record<string, unknown>[] {
  return (command) => {
    const at = command.lastIndexOf(COMMIT_READ);
    if (at >= 0) {
      // No BEGIN: statements run one after another, each in autocommit (a failing one stops the rest).
      db.exec(`${command.slice(0, at)};`);
      return db.prepare(command.slice(at + 2).replace(/;\s*$/u, '')).all() as Record<string, unknown>[];
    }
    if (/^\s*SELECT/iu.test(command) || /\bRETURNING\b/iu.test(command)) return db.prepare(command).all() as Record<string, unknown>[];
    db.exec(command);
    return [];
  };
}

/** A scope, an app on it and its key, as migration 0006 leaves an existing app (origins in force from 0). */
export function seedHotApp(
  db: DatabaseSync,
  a: { id: string; key: string; scope: string; name?: string; origins?: string[]; firstSessionAt?: number | null; assignedAt?: number; orgId?: string },
): void {
  const environment = a.key.startsWith('pk_live_') ? 'live' : 'test';
  const org = a.orgId ?? 'org_legacy';
  db.prepare('INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?, ?, ?, ?, 0, ?)').run(
    a.scope,
    org,
    environment,
    a.firstSessionAt === undefined ? 1 : a.firstSessionAt,
    a.assignedAt ?? 0,
  );
  db.prepare('INSERT INTO apps (id, name, scope_id, org_id, publishable_key, created_at) VALUES (?, ?, ?, ?, ?, 1)').run(a.id, a.name ?? 'Settings test', a.scope, org, a.key);
  db.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?, ?, ?, 'test', 1)").run(`key_legacy_${a.id}`, a.id, a.key);
  for (const o of a.origins ?? []) db.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?, ?, 0)').run(a.id, o);
}

/** Fixed ids for a test run: req_1, gc_1, app_1, key_1 … in order. */
export function testIds(): { request: () => string; change: () => string; app: () => string; key: () => string; publishableKey: (e: 'test' | 'live') => string } {
  const n = { request: 0, change: 0, app: 0, key: 0, pk: 0 };
  return {
    request: () => `req_${++n.request}`,
    change: () => `gc_${++n.change}`,
    app: () => `app_${++n.app}`,
    key: () => `key_${++n.key}`,
    publishableKey: (e) => `pk_${e}_${'Pk'.repeat(8)}${++n.pk}`,
  };
}
