// IssuerRpc reads only (D432, replacing D251's issuer-side check): the entrypoint and its readers prepare SELECT
// statements only, never run a batch, an exec or a write, and touch the DB binding only (no secret, no Durable
// Object, no other service), so the email issuer's binding to it can't change anything in the API.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
const rpc = read('rpc/issuer.ts');
const readers = read('issuer-apps.ts');
const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM|UPSERT)\b/u;
/** The source without comments (they may name what isn't done). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

describe('IssuerRpc reads only (D432)', () => {
  it('its readers prepare only SELECTs, with no batch, exec or run', () => {
    const text = code(readers);
    const literals = [...text.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/gu)].map((m) => m[1] ?? m[2] ?? m[3]!).filter((s) => /\b(SELECT|FROM|WHERE)\b/u.test(s));
    expect(literals.length).toBeGreaterThan(2);
    for (const sql of literals) expect(WRITE.test(sql), sql).toBe(false);
    for (const sql of literals) expect(sql.trimStart().startsWith('SELECT '), sql).toBe(true);
    expect(text).not.toMatch(/\.(batch|exec|run)\(/u);
    expect(text).toMatch(/\.prepare\(/u);
  });

  it('the entrypoint runs no SQL itself and touches only this.env.DB', () => {
    const text = code(rpc);
    expect(text).not.toMatch(/\.prepare\(|\.batch\(|\.exec\(/u);
    const bindings = new Set([...text.matchAll(/this\.env\.([A-Z_]+)/gu)].map((m) => m[1]));
    expect([...bindings]).toEqual(['DB']);
    // It imports nothing that writes: only its readers, the logger, the shared input type and console-core's schemas.
    const imports = [...text.matchAll(/from '([^']+)'/gu)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../env.ts', '../issuer-apps.ts', '../log.ts', './common.ts', '@hana-id/console-core', 'cloudflare:workers'].sort());
  });
});
