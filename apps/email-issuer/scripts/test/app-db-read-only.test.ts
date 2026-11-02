// The issuer's APP_DB binding is the API's D1, bound as an ordinary (read-write) D1 binding: Cloudflare has no
// read-only D1 binding. Until it is replaced by a read-only RPC on the API (docs/decisions.md D236), this source check
// keeps the issuer's code to reads: APP_DB is used only through src/apps.ts, whose statements are SELECTs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM)\b/iu;

describe('APP_DB is read only in the issuer’s code (D236)', () => {
  it('every use of APP_DB outside apps.ts hands it to apps.ts’s readers', () => {
    const uses = files(SRC)
      .filter((f) => !f.endsWith('/apps.ts') && !f.endsWith('/env.ts'))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i, l })))
      .filter(({ l }) => l.includes('APP_DB'));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u.l, `${u.f}:${u.i + 1}`).toMatch(/\b(appByKey|appById|scopeHasEmailApp)\(\S*APP_DB/u);
  });

  it('apps.ts prepares only SELECT statements', () => {
    const text = readFileSync(join(SRC, 'apps.ts'), 'utf8');
    const statements = [...text.matchAll(/prepare\(\s*(?:sql\([^)]*\)|[`'"]([^`'"]*)[`'"])/gu)].map((m) => m[1]).filter((x): x is string => x !== undefined);
    const templates = [...text.matchAll(/`(SELECT[^`]*)`/gu)].map((m) => m[1]!);
    expect(templates.length).toBeGreaterThan(0);
    for (const sql of [...statements, ...templates]) expect(WRITE.test(sql), sql).toBe(false);
    for (const sql of statements) expect(sql.trimStart().toUpperCase().startsWith('SELECT'), sql).toBe(true);
  });
});
