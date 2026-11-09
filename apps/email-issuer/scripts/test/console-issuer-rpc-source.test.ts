// ConsoleIssuerRpc's source rules (D447), the pattern of directory-rpc-source.test.ts: src/console-rpc.ts has exactly its
// two methods, reads only `email_daily` and writes nothing itself; `mintPartnerClientProof` writes only its audit row. A
// new method, table or binding has to change this file, so it can't slip in. (gen-wrangler.test.ts holds who binds it.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname;
/** Source text without comments (so a doc comment naming a table or binding isn't a use of it). */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const text = code(readFileSync(join(SRC, 'console-rpc.ts'), 'utf8'));

const MEMBER = /^ {2}(?:(?:private|public|protected|static|readonly)\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(=:]/gmu;
const WRITES = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM|UPSERT)\b/u;
const valueImports = (t: string): string[] => [...t.matchAll(/^import\s+(?!type\s)[^'"]*['"]([^'"]+)['"]/gmu)].map((m) => m[1]!).sort();

describe('src/console-rpc.ts (ConsoleIssuerRpc)', () => {
  it('has exactly its two methods', () => {
    // Every member at the class body's indent, whatever its form (a method, a getter, an arrow-function property).
    const body = text.slice(text.indexOf('class ConsoleIssuerRpc'));
    expect([...body.matchAll(MEMBER)].map((m) => m[1]!)).toEqual(['clientProof', 'deliverability']);
  });

  it('reads only email_daily, only with a SELECT, and only for the one app id it was given', () => {
    const tables = [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gu)].map((m) => m[1]!);
    expect(tables).toEqual(['email_daily']);
    expect(text).not.toMatch(WRITES);
    const statements = [...text.matchAll(/\.prepare\(\s*("[^"]*"|`[^`]*`|'[^']*')/gu)].map((m) => m[1]!.slice(1));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^SELECT\b[\s\S]*WHERE app_id = \?1 AND day >= \?2/u);
    expect(text).toContain('.bind(i.appId, fromDay)');
  });

  it('touches only the DB binding itself, and reaches the rest of the issuer only through the proof mint', () => {
    expect([...new Set([...text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)/gu)].map((m) => m[1]!))]).toEqual(['DB']);
    expect(valueImports(readFileSync(join(SRC, 'console-rpc.ts'), 'utf8'))).toEqual(['./deps.ts', './handlers.ts', './log.ts', '@hana-id/console-core', 'cloudflare:workers']);
    expect([...text.matchAll(/\b(\w+)\(depsFromEnv/gu)].map((m) => m[1])).toEqual(['mintPartnerClientProof']);
  });

  it('logs no org, actor, scope or proof, only its outcome', () => {
    const calls = [...text.matchAll(/log\(\{[^}]*\}/gu)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.replace(/'[^']*'/gu, "''"), c).not.toMatch(/\b(email|sub|token|orgId|actorId|scopeId|jwt)\b\s*[:,}]/u);
  });
});

describe('mintPartnerClientProof (handlers.ts)', () => {
  it('writes only its audit row', () => {
    const handlers = code(readFileSync(join(SRC, 'handlers.ts'), 'utf8'));
    const start = handlers.indexOf('export async function mintPartnerClientProof');
    expect(start).toBeGreaterThan(-1);
    const body = handlers.slice(start, handlers.indexOf('\n}\n', start));
    expect([...body.matchAll(/\bINSERT INTO\s+([a-z_]+)/gu)].map((m) => m[1])).toEqual(['email_admin_audit']);
    expect(body).not.toMatch(/\b(UPDATE [a-z_]+ SET|DELETE FROM|REPLACE INTO)\b/u);
  });
});
