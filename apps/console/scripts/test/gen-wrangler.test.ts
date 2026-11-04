// The console's generated config and the config rules across Workers (docs/batch-c-spec.md "Tests: Topology and
// config"): no public route in C7; only the console binds ConsoleRpc and CONSOLE_DB; the console runs first on every
// request; R2, rate-limit and cron as the spec's bindings table says; and source checks (no put/delete on STATEMENTS,
// no hash column read into a view, no `SELECT *` on the token-holding tables).
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_APP_CHANGE_DELAY_MS, MIN_APP_CHANGE_DELAY_MS, type Manifest, manifestSchema } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { wranglerConfig as apiConfig } from '../../../api/scripts/gen-wrangler.ts';
import { pagesWranglerConfig } from '../../../api/scripts/pages-wrangler.ts';
import { wranglerConfig as issuerConfig, TEST_MANIFEST as ISSUER_MANIFEST } from '../../../email-issuer/scripts/gen-wrangler.ts';
import { wranglerConfig as watchdogConfig, TEST_MANIFEST as WATCHDOG_MANIFEST } from '../../../watchdog/scripts/gen-wrangler.ts';
import { MAX_OWNER_GRANT_DELAY_MS, MIN_OWNER_GRANT_DELAY_MS } from '../../src/config.ts';
import { CONSOLE_RATE_LIMITS } from '../../src/limits.ts';
import { CRON, LOCAL_D1_ID, TEST_MANIFEST, existingD1Id, main, testWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';
import { VAULT_RATE_LIMITS } from '../../../api/src/vault/limits.ts';
import { IDENTITY_RATE_LIMITS } from '../../../api/src/identity/limits.ts';

const srcDir = new URL('../../src/', import.meta.url).pathname;
/** Each source file's code without its comments (so a comment can name what the code must not do). */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
const sources = readdirSync(srcDir).filter((f) => f.endsWith('.ts')).map((f) => ({ f, text: code(readFileSync(join(srcDir, f), 'utf8')) }));

type Config = Record<string, unknown> & {
  services?: { binding: string; service: string; entrypoint?: string }[];
  d1_databases?: { binding: string; database_name: string }[];
  routes?: unknown;
  route?: unknown;
};

describe('the console config', () => {
  it('validates as a manifest with every dashboard block (the test manifest is a real one)', () => {
    expect(manifestSchema.parse(TEST_MANIFEST)).toBeTruthy();
  });

  it('has no public route in C7: not on workers.dev, no preview URLs, no routes', () => {
    const c = testWranglerConfig() as Config;
    expect(c.workers_dev).toBe(false);
    expect(c.preview_urls).toBe(false);
    expect(c.routes).toBeUndefined();
    expect(c.route).toBeUndefined();
  });

  it('binds what the spec lists, and runs first on every request', () => {
    const c = testWranglerConfig() as Config;
    expect(c).toMatchObject({
      name: 'hana-id-console-test',
      main: 'src/index.ts',
      vars: { ENV_NAME: 'sandbox-test', CONSOLE_ORIGIN: 'https://console.test', CONSOLE_AUTH_ORIGIN: 'https://console-auth.test', FILES_ORIGIN: 'https://files.test', NEAR_RPC: 'https://rpc.test.invalid', SIGNER_ACCOUNT: 'signer.test.near', OWNER_GRANT_DELAY_MS: '60000' },
      d1_databases: [{ binding: 'CONSOLE_DB', database_name: 'hana-id-console-test', database_id: LOCAL_D1_ID, migrations_dir: 'migrations' }],
      services: [{ binding: 'API', service: 'hana-id-api-test', entrypoint: 'ConsoleRpc' }],
      r2_buckets: [
        { binding: 'LOGOS', bucket_name: 'hana-id-logos-test' },
        { binding: 'STATEMENTS', bucket_name: 'hana-id-statements-test' },
      ],
      ratelimits: [{ name: 'CONSOLE_IP_LIMIT', namespace_id: '95101', simple: { limit: 10, period: 60 } }],
      assets: { directory: './public', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
      triggers: { crons: ['0 * * * *'] },
      observability: { enabled: true, logs: { invocation_logs: false } },
    });
    expect(CRON).toBe('0 * * * *');
    // No secret, Hyperdrive or other Worker's database: the console never binds Neon (D73) or the hot DB.
    expect(JSON.stringify(c)).not.toMatch(/hyperdrive|"DB"|USAGE_DB|AdminRpc/iu);
  });

  it('refuses a manifest without the dashboard blocks', () => {
    const { console: _c, files: _f, admin: _a, usage: _u, email: _e, ownerGrantDelayMs: _o, ...bare } = TEST_MANIFEST;
    expect(() => wranglerConfig(bare as Manifest, LOCAL_D1_ID)).toThrow(/dashboard blocks/u);
  });

  it('keeps a D1 id only for the same database, and writes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-gen-'));
    try {
      const id = '12345678-1234-4234-8234-123456789abc';
      main(['sandbox-test', '--d1-id', id], { dir, loadManifest: () => TEST_MANIFEST });
      const path = join(dir, 'wrangler.jsonc');
      expect(existingD1Id(path, 'hana-id-console-test')).toBe(id);
      expect(existingD1Id(path, 'another-db')).toBeNull();
      main(['sandbox-test'], { dir, loadManifest: () => TEST_MANIFEST });
      expect(readFileSync(path, 'utf8')).toContain(id);
      writeFileSync(path, readFileSync(path, 'utf8').replace('"database_name": "hana-id-console-test"', '"database_name": "other"'));
      main(['sandbox-test'], { dir, loadManifest: () => TEST_MANIFEST });
      expect(readFileSync(path, 'utf8')).toContain(LOCAL_D1_ID);
      expect(() => main(['sandbox-test', '--d1-id', 'nope'], { dir, loadManifest: () => TEST_MANIFEST })).toThrow(/uuid/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the owner-grant delay bounds equal the manifest’s', () => {
    expect([MIN_OWNER_GRANT_DELAY_MS, MAX_OWNER_GRANT_DELAY_MS]).toEqual([MIN_APP_CHANGE_DELAY_MS, MAX_APP_CHANGE_DELAY_MS]);
  });

  it('its rate-limit namespace is its own (account-wide ids)', () => {
    const others = [...VAULT_RATE_LIMITS, ...IDENTITY_RATE_LIMITS].map((r) => r.namespace_id);
    for (const r of CONSOLE_RATE_LIMITS) expect(others).not.toContain(r.namespace_id);
  });
});

describe('across Workers (config snapshots)', () => {
  const m: Manifest = { ...TEST_MANIFEST, watchdog: WATCHDOG_MANIFEST.watchdog, watchdogs: WATCHDOG_MANIFEST.watchdogs, emailIssuer: ISSUER_MANIFEST.emailIssuer } as Manifest;
  const configs: [string, Config][] = [
    ['api', apiConfig(m, LOCAL_D1_ID) as Config],
    ['vault page', pagesWranglerConfig(m, 'vault', '2026-10-01') as Config],
    ['auth page', pagesWranglerConfig(m, 'auth', '2026-10-01') as Config],
    ['watchdog', watchdogConfig(m, LOCAL_D1_ID) as Config],
    // The issuer's outbox sender (its test manifest's) is for local* envs only.
    ['email issuer', issuerConfig({ ...m, name: 'local-test' }, LOCAL_D1_ID, LOCAL_D1_ID) as Config],
    ['console', wranglerConfig(m, LOCAL_D1_ID) as Config],
  ];

  it('only the console binds ConsoleRpc', () => {
    const binders = configs.filter(([, c]) => (c.services ?? []).some((s) => s.entrypoint === 'ConsoleRpc')).map(([n]) => n);
    expect(binders).toEqual(['console']);
  });

  it('only the console binds CONSOLE_DB (by binding or by database name)', () => {
    const binders = configs.filter(([, c]) => (c.d1_databases ?? []).some((d) => d.binding === 'CONSOLE_DB' || d.database_name === m.console!.d1Name)).map(([n]) => n);
    expect(binders).toEqual(['console']);
  });

  it('no Worker binds the console in C7: StaffRpc gets its only caller, the admin Worker, in C8', () => {
    const binders = configs
      .filter(([, c]) => (c.services ?? []).some((s) => s.service === m.console!.workerName || s.entrypoint === 'StaffRpc' || s.entrypoint === 'AuthHandler'))
      .map(([n]) => n);
    expect(binders).toEqual([]);
  });

  it('the console binds no other Worker’s database', () => {
    const console = configs.find(([n]) => n === 'console')![1];
    expect((console.d1_databases ?? []).map((d) => d.database_name)).toEqual([m.console!.d1Name]);
  });
});

describe('source checks', () => {
  it('no put or delete on STATEMENTS (read only by code, D74)', () => {
    for (const { f, text } of sources) {
      for (const m of text.matchAll(/STATEMENTS(\??\.|\]|\s*[,)])(\w*)/gu)) {
        expect(['get', 'head'], `${f}: STATEMENTS${m[1]}${m[2]}`).toContain(m[2]);
      }
      expect(text, f).not.toMatch(/STATEMENTS\s*[,;)]/u);
    }
  });

  it('no SELECT * and no hash column into a view on the token-holding tables', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/SELECT\s+\*/iu);
    }
    const views = readFileSync(join(srcDir, 'views.ts'), 'utf8');
    for (const columns of views.matchAll(/_COLUMNS = '([^']*)'/gu)) expect(columns[1]).not.toMatch(/hash/u);
  });

  it('the console never holds a link key or the client secret yet (D240: the admin Worker computes link tokens)', () => {
    for (const { f, text } of sources) expect(text, f).not.toMatch(/\b(INVITE_LINK_KEY|CANCEL_LINK_KEY|CONSOLE_GOOGLE_CLIENT_SECRET)\b/u);
  });
});
