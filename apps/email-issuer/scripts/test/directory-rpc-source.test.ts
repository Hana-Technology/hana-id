// DirectoryRpc's source rules (D275, confirmed 2026-11-05; spec "Users and Support ID" → "Data path", "What partners
// never see"), the pattern of D251's APP_DB check (now scripts/test/api-read-only.test.ts, D432):
//   - src/directory-rpc.ts runs SELECTs on user_emails, user_email_apps and email_admin_audit and one INSERT into
//     email_admin_audit, nothing else; it touches the DB and RATE_LIMITER bindings, its Access vars and EMAIL_RL_KEY
//     (the audit's keyed hash) only, and imports neither the signer, the keys, the challenge nor the mail modules (nor
//     anything that does);
//   - the issuer's public router never reaches it (no route);
//   - no partner-facing code (the API, the console, console-auth, the SDK packages) names the entrypoint or the
//     directory's tables;
//   - issuer migration 0003 keeps every audit row, takes the new actions, and allows a missing ticket only on a search.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DIRECTORY_AUDIT_ACTIONS } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SRC = join(ROOT, 'apps/email-issuer/src');
const MODULE = join(SRC, 'directory-rpc.ts');
/** Source text without comments (so a doc comment naming a table or binding isn't a use of it). */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const text = code(readFileSync(MODULE, 'utf8'));

/** The module's value imports (not `import type`), as written. */
const valueImports = (t: string): string[] => [...t.matchAll(/^import\s+(?!type\s)[^'"]*['"]([^'"]+)['"]/gmu)].map((m) => m[1]!);

/** Every local module reachable from `file` through value imports. */
function localClosure(file: string, seen = new Set<string>()): Set<string> {
  for (const spec of valueImports(readFileSync(file, 'utf8'))) {
    if (!spec.startsWith('.')) continue;
    const next = resolve(dirname(file), spec);
    if (seen.has(next)) continue;
    seen.add(next);
    localClosure(next, seen);
  }
  return seen;
}

describe('src/directory-rpc.ts (DirectoryRpc) reads only, and only the directory', () => {
  it('imports no signer, key, challenge or mail module, directly or through another', () => {
    const local = [...localClosure(MODULE)].map((f) => f.replace(`${SRC}/`, '')).sort();
    expect(local).toEqual(['bytes.ts', 'limits.ts', 'log.ts']);
    for (const banned of ['signer', 'keys', 'kms', 'challenge', 'challenge-id', 'mail', 'sendgrid', 'sender', 'outbox', 'handlers', 'deps', 'apps', 'jws', 'google']) {
      expect(local, banned).not.toContain(`${banned}.ts`);
    }
    // Packages: the entrypoint base, the shared schemas, normalization (no key), the build-id format (health) and the Access check.
    expect(valueImports(readFileSync(MODULE, 'utf8')).filter((s) => !s.startsWith('.')).sort()).toEqual(['@hana-id/console-core', '@hana-id/email', '@hana-id/env/build-id', '@hana-id/oidc', 'cloudflare:workers']);
  });

  it('its statements: SELECTs on user_emails, user_email_apps and email_admin_audit, one INSERT into email_admin_audit', () => {
    expect(text).not.toMatch(/\b(UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM|UPSERT)\b/u);
    expect(text).not.toMatch(/\bON CONFLICT\b/iu);
    const tables = [...text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gu)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(['user_emails', 'user_email_apps', 'email_admin_audit'], t).toContain(t);
    const inserts = [...text.matchAll(/\bINSERT INTO\s+([a-z_]+)/gu)].map((m) => m[1]!);
    expect(inserts).toEqual(['email_admin_audit']);
    // Every prepared statement is a SELECT or that INSERT (`AUDIT_INSERT` + its detail expression).
    for (const m of text.matchAll(/\.prepare\(\s*(`[^`]*`|'[^']*')/gu)) expect(m[1]!.slice(1).trimStart(), m[0]).toMatch(/^(SELECT\b|\$\{AUDIT_INSERT\})/u);
  });

  it('touches DB, RATE_LIMITER, its Access vars, ENV_NAME, EMAIL_RL_KEY and HANA_BUILD (health, D425) only: never the API (IssuerRpc), APP_DB or another secret', () => {
    const used = new Set([...text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)/gu)].map((m) => m[1]!));
    for (const name of used) expect(['DB', 'RATE_LIMITER', 'ENV_NAME', 'EMAIL_RL_KEY', 'HANA_BUILD', 'ADMIN_ACCESS_TEAM_DOMAIN', 'ADMIN_ACCESS_AUD', 'ADMIN_STAFF_EMAILS'], name).toContain(name);
    for (const name of ['APP_DB', 'IssuerRpc', 'ISSUER_SIGNING_KEY', 'EMAIL_SUB_KEY', 'EMAIL_CODE_KEY', 'SENDGRID_API_KEY', 'EMAIL_CHALLENGE', 'OUTBOX']) expect(text, name).not.toContain(name);
  });

  it('its log lines carry no address, sub, ticket, staff email or token', () => {
    const calls = [...text.matchAll(/log\(\{[^}]*\}/gu)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.replace(/'[^']*'/gu, "''"), c).not.toMatch(/\b(email|sub|ticket|jwt|accessJwt|staff|who|term|q|address)\b\s*[:,}]/u);
  });

  it('is exported as an entrypoint and no route reaches it (the public fetch is the router alone)', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).toMatch(/export \{ DirectoryRpc \} from '\.\/directory-rpc\.ts';/u);
    expect(code(index)).toMatch(/return route\(request, depsFromEnv\(env, \(p\) => ctx\.waitUntil\(p\)\)\);/u);
    for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts') && n !== 'index.ts' && n !== 'directory-rpc.ts')) {
      expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(/directory-rpc/u);
    }
  });
});

describe('partners never see the directory (spec "What partners never see")', () => {
  const files = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : files(join(dir, e.name))) : /\.(ts|tsx|js|mjs)$/u.test(e.name) ? [join(dir, e.name)] : []));
    } catch {
      return [];
    }
  };
  const PARTNER_FACING = ['apps/api/src', 'apps/console/src', 'apps/console/web/src', 'apps/console-auth/src', 'packages/web/src', 'packages/react/src', 'packages/core/src', 'packages/sodax/src'];

  it('no partner-facing Worker or SDK package names DirectoryRpc, its types or the directory’s tables', () => {
    const all = PARTNER_FACING.flatMap((d) => files(join(ROOT, d)));
    expect(all.length).toBeGreaterThan(50);
    for (const f of all) {
      expect(code(readFileSync(f, 'utf8')), f.replace(ROOT, '')).not.toMatch(/\bDirectoryRpc\b|\bDirectoryUserRow\b|\bdirectory(Search|Get|Audit)Input\b|\buser_emails\b|\buser_email_apps\b|\bemail_admin_audit\b/u);
    }
  });
});

describe('issuer migration 0003 (the audit rebuilt for the directory reads)', () => {
  const dir = join(ROOT, 'apps/email-issuer/migrations');
  const migrations = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const apply = (db: DatabaseSync, names: string[]) => {
    for (const n of names) db.exec(readFileSync(join(dir, n), 'utf8'));
  };

  it('keeps every row and id, continues the id sequence, and checks the new actions and the ticket rule', () => {
    expect(migrations).toEqual(['0001_init.sql', '0002_user_emails.sql', '0003_directory_audit.sql']);
    const db = new DatabaseSync(':memory:');
    apply(db, migrations.slice(0, 2));
    db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket, scope_id, action_nonce, jti) VALUES (1, 'a@hana.example', 'client_proof', 'T-1', 's1', 3, 'jti-1')").run();
    db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket, subject) VALUES (2, 'b@hana.example', 'unlock', 'T-2', 'abcdefabcdef')").run();
    db.prepare('DELETE FROM email_admin_audit WHERE id = 2').run();
    db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket) VALUES (3, 'c@hana.example', 'unsuppress', 'T-3')").run();
    apply(db, migrations.slice(2));
    expect(db.prepare('SELECT id, at_ms, staff, action, ticket, scope_id, action_nonce, jti, subject, detail FROM email_admin_audit ORDER BY id').all()).toEqual([
      { id: 1, at_ms: 1, staff: 'a@hana.example', action: 'client_proof', ticket: 'T-1', scope_id: 's1', action_nonce: 3, jti: 'jti-1', subject: null, detail: null },
      { id: 3, at_ms: 3, staff: 'c@hana.example', action: 'unsuppress', ticket: 'T-3', scope_id: null, action_nonce: null, jti: null, subject: null, detail: null },
    ]);
    // The sequence continues past the highest id ever used.
    db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, detail) VALUES (4, 'a@hana.example', 'user_search', '{\"rows\":0}')").run();
    expect(db.prepare('SELECT MAX(id) AS id FROM email_admin_audit').get()).toEqual({ id: 4 });
    // The ticket may be left out on a search only; every action of console-core's list is accepted.
    expect(() => db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action) VALUES (5, 'a@hana.example', 'user_view')").run()).toThrow(/CHECK/u);
    expect(() => db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket) VALUES (5, 'a@hana.example', 'user_view', '')").run()).toThrow(/CHECK/u);
    expect(() => db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket) VALUES (5, 'a@hana.example', 'user_export', 'T')").run()).toThrow(/CHECK/u);
    expect(() => db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket, detail) VALUES (5, 'a@hana.example', 'user_view', 'T', 'not json')").run()).toThrow(/CHECK/u);
    for (const action of DIRECTORY_AUDIT_ACTIONS) db.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket) VALUES (6, 'a@hana.example', ?, 'T-6')").run(action);
    const sql = readFileSync(join(dir, '0003_directory_audit.sql'), 'utf8');
    const list = /action IN \(([^)]*)\)/u.exec(sql)![1]!.split(',').map((s) => s.trim().replace(/'/gu, ''));
    expect(list).toEqual([...DIRECTORY_AUDIT_ACTIONS]);
  });

  it('the directory tables are unchanged by it (no uid column: D346 dropped it)', () => {
    const db = new DatabaseSync(':memory:');
    apply(db, migrations);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('user_email_apps')).toEqual(['provider', 'sub', 'app_id', 'scope_id', 'first_seen_ms', 'last_seen_ms']);
    expect(cols('user_emails')).toEqual(['provider', 'sub', 'email', 'email_verified', 'hosted', 'first_seen_ms', 'last_seen_ms']);
  });
});
