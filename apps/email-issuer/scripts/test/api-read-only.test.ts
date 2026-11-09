// The issuer can't write the API's D1 (D434, replacing D251's source check on the read-write APP_DB binding): it
// binds no D1 but its own, and reaches the API only through the read-only IssuerRpc entrypoint, through apps.ts.
//   - the generated config (every committed manifest with an issuer, and the tests') binds its own D1 only, and the
//     API only at IssuerRpc;
//   - the Worker's Env declares one D1 binding (DB) and no APP_DB;
//   - every use of the API binding goes through apps.ts's three readers, which call only IssuerRpc's three methods.
// The API side (IssuerRpc prepares SELECTs only) is apps/api/scripts/test/issuer-rpc-source.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUER_RPC_METHODS } from '@hana-id/console-core';
import { loadEnv, repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { LOCAL_D1_ID, testWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';

const SRC = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
/** Source without comments (a doc comment naming the old binding isn't a use of it). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

interface Config {
  d1_databases?: { binding: string; database_name: string }[];
  services?: { binding: string; service: string; entrypoint?: string }[];
}

/** The committed manifests that have an email issuer. */
const issuerEnvs = readdirSync(join(repoRoot, 'envs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/u, ''))
  .flatMap((name) => {
    try {
      const m = loadEnv(name);
      return m.emailIssuer && m.vaultOrigin && m.authOrigin && m.emailIssuer.signer.kind === 'worker-secret' && m.network === 'testnet' ? [m] : [];
    } catch {
      return [];
    }
  });

describe('the issuer binds no API D1 (D434)', () => {
  it('every generated config binds its own D1 only and the API at IssuerRpc only', () => {
    expect(issuerEnvs.length).toBeGreaterThan(0);
    const configs: [string, Config, string, string][] = [
      ...issuerEnvs.map((m): [string, Config, string, string] => [m.name, wranglerConfig(m, LOCAL_D1_ID) as Config, m.cloudflare.workerName, m.cloudflare.d1Name]),
      ['tests', testWranglerConfig([], 'UNSET') as Config, 'hana-id-api-test', 'hana-id-test'],
    ];
    for (const [name, c, apiWorker, apiD1] of configs) {
      expect(c.d1_databases!.map((d) => d.binding), name).toEqual(['DB']);
      expect(c.d1_databases!.map((d) => d.database_name), name).not.toContain(apiD1);
      expect(c.services, name).toEqual([{ binding: 'API', service: apiWorker, entrypoint: 'IssuerRpc' }]);
      expect(JSON.stringify(c), name).not.toContain('APP_DB');
    }
  });

  it('the Worker’s Env has one D1 binding, DB', () => {
    const env = code(readFileSync(join(SRC, 'env.ts'), 'utf8'));
    expect([...env.matchAll(/^\s*([A-Z_]+)\??:\s*D1Database\b/gmu)].map((m) => m[1])).toEqual(['DB']);
    expect(env).not.toContain('APP_DB');
  });

  it('no source names APP_DB; every use of the API binding hands it to apps.ts’s readers', () => {
    const sources = files(SRC).map((f) => ({ f, text: code(readFileSync(f, 'utf8')) }));
    for (const { f, text } of sources) expect(text, f).not.toContain('APP_DB');
    const uses = sources
      .filter(({ f }) => !f.endsWith('/apps.ts') && !f.endsWith('/env.ts'))
      .flatMap(({ f, text }) => text.split('\n').map((l, i) => ({ f, i, l })))
      .filter(({ l }) => /\benv\??\.API\b/u.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u.l, `${u.f}:${u.i + 1}`).toMatch(/\b(appByKey|appById|scopeHasEmailApp)\(\S*env\.API\b/u);
  });

  it('apps.ts calls IssuerRpc’s three methods and nothing else on the binding', () => {
    const text = code(readFileSync(join(SRC, 'apps.ts'), 'utf8'));
    const called = new Set([...text.matchAll(/\bapi\.([A-Za-z]+)\(/gu)].map((m) => m[1]));
    expect([...called].sort()).toEqual([...ISSUER_RPC_METHODS].sort());
    expect(text).not.toMatch(/\.prepare\(|D1Database/u);
  });
});
