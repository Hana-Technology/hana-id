// The admin Worker's generated config and the config rules across Workers (docs/batch-c-spec.md "Tests: Topology and
// config"): only the API and the admin bind Hyperdrive, to different configs; only the admin binds AdminRpc and
// StaffRpc; `preview_urls: false` everywhere, `workers_dev: false` on production manifests; the Worker runs first on
// every request. Plus the source checks: no secret in a log line, no SQL on the hot or console DBs, no HTML sink in
// the SPA, the CSP equal to the console's.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FONT_FILES, MARK_PATHS } from '@hana-id/brand';
import { contrast, hexVars, woff2Names } from '@hana-id/brand/check';
import { SUPPORT_TICKET_RE } from '@hana-id/console-core';
import { ENV_ALERT_LABELS, envAlertLabel, loadEnv, MAX_API_RPC_FALLBACKS, type Manifest, manifestSchema } from '@hana-id/env';
import { BUILD_VAR } from '@hana-id/env/build-id';
import { describe, expect, it } from 'vitest';
import { wranglerConfig as apiConfig } from '../../../api/scripts/gen-wrangler.ts';
import { pagesWranglerConfig } from '../../../api/scripts/pages-wrangler.ts';
import { consoleCsp } from '../../../console/src/headers.ts';
import { wranglerConfig as consoleConfig } from '../../../console/scripts/gen-wrangler.ts';
import { wranglerConfig as consoleAuthConfig } from '../../../console-auth/scripts/gen-wrangler.ts';
import { wranglerConfig as filesConfig } from '../../../files/scripts/gen-wrangler.ts';
import { wranglerConfig as issuerConfig, TEST_MANIFEST as ISSUER_MANIFEST } from '../../../email-issuer/scripts/gen-wrangler.ts';
import { wranglerConfig as watchdogConfig, TEST_MANIFEST as WATCHDOG_MANIFEST } from '../../../watchdog/scripts/gen-wrangler.ts';
import { MAIL_LABELS } from '../../src/labels.ts';
import { MAX_NEAR_BACKUPS } from '../../src/status-probes.ts';
import { adminCsp } from '../../src/headers.ts';
import { BRAND_END, BRAND_FONT_FILES, BRAND_START, brandBlock } from '../sync-brand.ts';
import { CRON, LOCAL_ADMIN_CONNECTION_STRING, TEST_ADMIN_HYPERDRIVE_ID, accountCrons, TEST_MANIFEST, TEST_WATCHDOG_URL, existingAdminHyperdriveId, main, testWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';

const LOCAL_D1_ID = '00000000-0000-4000-8000-000000000000';
const WRITER_ID = 'b'.repeat(32);
const srcDir = new URL('../../src/', import.meta.url).pathname;
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
const sources = files(srcDir).map((f) => ({ f, text: code(readFileSync(f, 'utf8')) }));

type Config = Record<string, unknown> & {
  services?: { binding: string; service: string; entrypoint?: string }[];
  d1_databases?: { binding: string; database_name: string }[];
  hyperdrive?: { binding: string; id: string; localConnectionString?: string }[];
  routes?: { pattern: string; custom_domain?: boolean }[];
  vars?: Record<string, string>;
};

const withAdmin = (over: Partial<NonNullable<Manifest['admin']>>, m: Partial<Manifest> = {}): Manifest => ({ ...TEST_MANIFEST, ...m, admin: { ...TEST_MANIFEST.admin!, ...over } }) as Manifest;

describe('the admin config', () => {
  it('validates as a manifest (the test manifest is a real one)', () => {
    expect(manifestSchema.parse(TEST_MANIFEST)).toBeTruthy();
  });

  it('binds what the spec lists for C8 and C12, runs first on every request, on its two crons', () => {
    const c = wranglerConfig(TEST_MANIFEST, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config;
    expect(c).toMatchObject({
      name: 'hana-id-admin-test',
      main: 'src/index.ts',
      // global_fetch_strictly_public: the watchdog on the same account's workers.dev is reachable (error 1042 otherwise).
      compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'admin.test', custom_domain: true }],
      vars: {
        ENV_NAME: 'sandbox-test',
        ADMIN_ORIGIN: 'https://admin.test',
        CONSOLE_ORIGIN: 'https://console.test',
        FILES_ORIGIN: 'https://files.test',
        NEAR_RPC: 'https://rpc.test.invalid',
        API_URL: 'https://api.test',
        VAULT_ORIGIN: 'https://vault.test',
        AUTH_ORIGIN: 'https://auth.test',
        CONSOLE_AUTH_ORIGIN: 'https://console-auth.test',
        ACCOUNT_CRONS: JSON.stringify([
          { worker: 'hana-id-api-test', crons: 1 },
          { worker: 'hana-id-console-test', crons: 1 },
          { worker: 'hana-id-admin-test', crons: 2 },
          { worker: 'hana-id-watchdog-test', crons: 1 },
        ]),
        SIGNER_ACCOUNT: 'signer.test.near',
        RELAYER_ACCOUNT: TEST_MANIFEST.relayer,
        ACCESS_TEAM_DOMAIN: 'hana-test.cloudflareaccess.com',
        ACCESS_AUD: 'ab'.repeat(32),
        STAFF_EMAILS: '["staff@hana.example"]',
        EMAIL_FROM: 'Hana ID <notices@mail.hana.example>',
        SECURITY_ALIAS: 'security@hana.example',
        APP_CHANGE_DELAY_MS: '60000',
        OWNER_GRANT_DELAY_MS: '60000',
        NEAR_NETWORK: 'testnet',
        WATCHDOG_URL: TEST_WATCHDOG_URL,
      },
      services: [
        { binding: 'API', service: 'hana-id-api-test', entrypoint: 'AdminRpc' },
        { binding: 'CONSOLE', service: 'hana-id-console-test', entrypoint: 'StaffRpc' },
      ],
      hyperdrive: [{ binding: 'USAGE_DB', id: TEST_ADMIN_HYPERDRIVE_ID, localConnectionString: LOCAL_ADMIN_CONNECTION_STRING }],
      assets: { directory: './public', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
      r2_buckets: [
        { binding: 'STATEMENTS', bucket_name: TEST_MANIFEST.files!.statementsBucket },
        { binding: 'EXPORTS', bucket_name: TEST_MANIFEST.files!.exportsBucket },
      ],
      triggers: { crons: ['*/5 * * * *', '*/15 * * * *'] },
      observability: { enabled: true, logs: { invocation_logs: false } },
    });
    expect(CRON).toBe('*/5 * * * *');
    // No D1, no LOGOS (only the console and the files Worker), no secret in vars, no ConsoleRpc.
    expect(c.d1_databases).toBeUndefined();
    expect(JSON.stringify(c.r2_buckets)).not.toContain('LOGOS');
    expect(JSON.stringify(c)).not.toMatch(/ConsoleRpc|EMAIL_API_KEY|CANCEL_LINK_KEY|INVITE_LINK_KEY|WATCHDOG_STATUS_TOKEN|COINGECKO_API_KEY/u);
    expect(Object.keys(c.vars!).sort()).toEqual(
      ['ACCESS_AUD', 'ACCESS_TEAM_DOMAIN', 'ACCOUNT_CRONS', 'ADMIN_ORIGIN', 'API_URL', 'AUTH_ORIGIN', 'CONSOLE_AUTH_ORIGIN', 'VAULT_ORIGIN', 'APP_CHANGE_DELAY_MS', 'CONSOLE_ORIGIN', 'EMAIL_FROM', 'ENV_LABEL', 'ENV_NAME', 'FILES_ORIGIN', 'NEAR_NETWORK', 'NEAR_RPC', 'OWNER_GRANT_DELAY_MS', 'RELAYER_ACCOUNT', 'SECURITY_ALIAS', 'SIGNER_ACCOUNT', 'STAFF_EMAILS', 'WATCHDOG_URL'].sort(),
    );
    expect(LOCAL_ADMIN_CONNECTION_STRING).toMatch(/\.invalid:/u);
  });

  it('writes the subjects\' env label from the manifest (D419), the same labels as @hana-id/env', () => {
    expect((wranglerConfig(TEST_MANIFEST, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }).vars as Record<string, string>).ENV_LABEL).toBe(envAlertLabel(TEST_MANIFEST));
    expect(envAlertLabel(TEST_MANIFEST)).not.toBe('');
    expect((wranglerConfig({ ...TEST_MANIFEST, network: 'mainnet' } as unknown as Manifest, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }).vars as Record<string, string>).ENV_LABEL).toBeUndefined();
    expect([...MAIL_LABELS]).toEqual([...ENV_ALERT_LABELS]);
  });

  it('workers.dev only in a dev env and only under the admin Worker’s own name; production needs a Custom Domain', () => {
    const dev = wranglerConfig(withAdmin({ origin: 'https://hana-id-admin-test.tingtc.workers.dev' }), { adminHyperdriveId: null }) as Config;
    expect(dev).toMatchObject({ name: 'hana-id-admin-test', workers_dev: true, preview_urls: false });
    expect(dev.routes).toBeUndefined();
    expect(() => wranglerConfig(withAdmin({ origin: 'https://other-worker.tingtc.workers.dev' }), { adminHyperdriveId: null })).toThrow(/admin\.workerName/u);
    const prod = withAdmin({ origin: 'https://hana-id-admin-test.tingtc.workers.dev' }, { name: 'staging' });
    expect(() => wranglerConfig(prod, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID })).toThrow(/workers\.dev is for local\*\/sandbox\*/u);
    const prodDomain = wranglerConfig(withAdmin({ origin: 'https://admin.hana.example' }, { name: 'staging' }), { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config;
    expect(prodDomain).toMatchObject({ workers_dev: false, preview_urls: false, routes: [{ pattern: 'admin.hana.example', custom_domain: true }] });
    expect(prodDomain).not.toHaveProperty('account_id');
    // The manifest's account, when it names one (D404).
    const id = '0123456789abcdef0123456789abcdef';
    const pinned = wranglerConfig({ ...TEST_MANIFEST, cloudflare: { ...TEST_MANIFEST.cloudflare, accountId: id } } as Manifest, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID });
    expect(pinned).toMatchObject({ account_id: id });
  });

  it('a production env needs the admin Hyperdrive id; a dev env may go without (feed and watcher off)', () => {
    const prod = withAdmin({ origin: 'https://admin.hana.example' }, { name: 'staging' });
    expect(() => wranglerConfig(prod, { adminHyperdriveId: null })).toThrow(/--admin-hyperdrive-id/u);
    expect((testWranglerConfig() as Config).hyperdrive).toBeUndefined();
    expect(() => wranglerConfig(TEST_MANIFEST, { adminHyperdriveId: 'not-hex' })).toThrow(/32 lowercase hex/u);
  });

  it('the watchdog: its origin is a var from watchdog.url, its bearer is never in the config; production needs the url (C14)', () => {
    const { url: _u, ...noUrl } = TEST_MANIFEST.watchdog!;
    const dev = wranglerConfig({ ...TEST_MANIFEST, watchdog: noUrl } as Manifest, { adminHyperdriveId: null }) as Config;
    expect(dev.vars!.WATCHDOG_URL).toBeUndefined();
    const { watchdog: _w, ...noWatchdog } = TEST_MANIFEST;
    expect((wranglerConfig(noWatchdog as Manifest, { adminHyperdriveId: null }) as Config).vars!.WATCHDOG_URL).toBeUndefined();
    const prod = { ...withAdmin({ origin: 'https://admin.hana.example' }, { name: 'staging' }), watchdog: noUrl } as Manifest;
    expect(() => wranglerConfig(prod, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID })).toThrow(/set watchdog\.url/u);
    const prodOk = wranglerConfig(withAdmin({ origin: 'https://admin.hana.example' }, { name: 'staging' }), { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config;
    expect(prodOk.vars!.WATCHDOG_URL).toBe(TEST_WATCHDOG_URL);
    // No secret of any Worker is written into any generated config.
    expect(JSON.stringify(prodOk)).not.toMatch(/TOKEN|SECRET|_KEY"/u);
  });

  it('refuses a manifest without the dashboard blocks', () => {
    const { console: _c, files: _f, admin: _a, usage: _u, email: _e, ownerGrantDelayMs: _o, ...bare } = TEST_MANIFEST;
    expect(() => wranglerConfig(bare as Manifest)).toThrow(/dashboard blocks/u);
  });

  it('keeps a Hyperdrive id for the same Worker only; `off` drops it; writes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin-gen-'));
    const logs: string[] = [];
    const log = console.log;
    console.log = (s: string) => void logs.push(s);
    try {
      const path = join(dir, 'wrangler.jsonc');
      main(['sandbox-test', '--admin-hyperdrive-id', TEST_ADMIN_HYPERDRIVE_ID], { dir, loadManifest: () => TEST_MANIFEST });
      expect(existingAdminHyperdriveId(path, 'hana-id-admin-test')).toBe(TEST_ADMIN_HYPERDRIVE_ID);
      expect(existingAdminHyperdriveId(path, 'another-worker')).toBeNull();
      main(['sandbox-test'], { dir, loadManifest: () => TEST_MANIFEST });
      expect(readFileSync(path, 'utf8')).toContain(TEST_ADMIN_HYPERDRIVE_ID);
      main(['sandbox-test', '--admin-hyperdrive-id', 'off'], { dir, loadManifest: () => TEST_MANIFEST });
      expect(readFileSync(path, 'utf8')).not.toContain('hyperdrive');
      expect(logs.join('\n')).toMatch(/feed and watcher: off/u);
      writeFileSync(path, readFileSync(path, 'utf8'));
      expect(() => main(['sandbox-test', '--admin-hyperdrive-id', 'nope'], { dir, loadManifest: () => TEST_MANIFEST })).toThrow(/admin Hyperdrive config id/u);
    } finally {
      console.log = log;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the API’s NEAR RPC list for the System status page, only when non-empty (D435), at the manifest’s limit', () => {
    const vars = (m: Manifest) => (wranglerConfig(m) as { vars: Record<string, string> }).vars;
    const urls = ['https://a.invalid', 'https://b.invalid'];
    expect(JSON.parse(vars({ ...TEST_MANIFEST, rpcFallback: 'https://fb.invalid', apiRpcFallbacks: urls }).NEAR_RPC_FALLBACKS!)).toEqual(urls);
    expect(JSON.parse(vars({ ...TEST_MANIFEST, rpcFallback: 'https://fb.invalid', apiRpcFallbacks: undefined }).NEAR_RPC_FALLBACKS!)).toEqual(['https://fb.invalid']);
    expect(vars({ ...TEST_MANIFEST, rpcFallback: undefined, apiRpcFallbacks: undefined }).NEAR_RPC_FALLBACKS).toBeUndefined();
    expect(MAX_NEAR_BACKUPS).toBe(MAX_API_RPC_FALLBACKS);
  });

  it('binds the email issuer’s DirectoryRpc as ISSUER when the env has an issuer, and nothing without one (C8b, D275)', () => {
    const without = wranglerConfig(TEST_MANIFEST, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config;
    expect(without.services!.map((x) => x.binding)).toEqual(['API', 'CONSOLE']);
    const withIssuer = wranglerConfig({ ...TEST_MANIFEST, emailIssuer: ISSUER_MANIFEST.emailIssuer } as Manifest, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config;
    expect(withIssuer.services).toContainEqual({ binding: 'ISSUER', service: ISSUER_MANIFEST.emailIssuer!.cloudflare.workerName, entrypoint: 'DirectoryRpc' });
    // A service binding, never the issuer's D1 (read-write on the whole database, D275 alternative a).
    expect(withIssuer.d1_databases).toBeUndefined();
    expect(JSON.stringify(withIssuer)).not.toMatch(/database_name|database_id/u);
    expect((testWranglerConfig() as Config).services!.map((x) => `${x.binding}:${x.entrypoint}`)).toEqual(['API:AdminRpc', 'CONSOLE:StaffRpc', 'ISSUER:DirectoryRpc']);
  });

  it('its CSP and headers are the console’s (the spec gives both origins the same)', () => {
    expect(adminCsp('https://files.test')).toBe(consoleCsp('https://files.test'));
  });
});

describe('across Workers (config snapshots)', () => {
  const m: Manifest = { ...TEST_MANIFEST, watchdog: WATCHDOG_MANIFEST.watchdog, watchdogs: WATCHDOG_MANIFEST.watchdogs, emailIssuer: ISSUER_MANIFEST.emailIssuer } as Manifest;
  const configs: [string, Config][] = [
    ['api', apiConfig(m, LOCAL_D1_ID, { usageHyperdriveId: WRITER_ID }) as Config],
    ['vault page', pagesWranglerConfig(m, 'vault', '2026-10-01') as Config],
    ['auth page', pagesWranglerConfig(m, 'auth', '2026-10-01') as Config],
    ['watchdog', watchdogConfig(m, LOCAL_D1_ID) as Config],
    ['email issuer', issuerConfig({ ...m, name: 'local-test' }, LOCAL_D1_ID) as Config],
    ['console', consoleConfig(m, LOCAL_D1_ID) as Config],
    ['admin', wranglerConfig(m, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config],
  ];

  it('ACCOUNT_CRONS counts each cron Worker’s own triggers (the System status headroom tile, D425)', () => {
    const triggers = (name: string) => ((configs.find(([n]) => n === name)![1] as { triggers?: { crons?: string[] } }).triggers?.crons ?? []).length;
    const counted = Object.fromEntries(accountCrons(m).map((c) => [c.worker, c.crons]));
    expect(counted).toEqual({ [m.cloudflare.workerName]: triggers('api'), [m.console!.workerName]: triggers('console'), [m.admin!.workerName]: triggers('admin'), [m.watchdog!.cloudflare.workerName]: triggers('watchdog') });
    // A watchdog on another account than the API's (its own, D86) isn't counted; sandbox-dev's (no API account id) is.
    expect(accountCrons({ ...m, cloudflare: { ...m.cloudflare, accountId: 'f'.repeat(32) } } as Manifest).map((c) => c.worker)).not.toContain(m.watchdog!.cloudflare.workerName);
    expect(accountCrons(loadEnv('sandbox-dev')).reduce((a, c) => a + c.crons, 0)).toBe(5);
  });

  it('no generated config carries the build id: only the deploy wrapper stamps it (D384, D406)', () => {
    const all: [string, Config][] = [...configs, ['console-auth', consoleAuthConfig(m) as Config], ['files', filesConfig(m) as Config]];
    for (const [name, c] of all) expect(Object.keys((c.vars as Record<string, string> | undefined) ?? {}), name).not.toContain(BUILD_VAR);
  });

  it('only the API and the admin bind Hyperdrive, to different configs', () => {
    const binders = configs.filter(([, c]) => (c.hyperdrive ?? []).length > 0);
    expect(binders.map(([n]) => n)).toEqual(['api', 'admin']);
    const ids = binders.map(([, c]) => c.hyperdrive![0]!.id);
    expect(new Set(ids).size).toBe(2);
    expect(binders.find(([n]) => n === 'admin')![1].hyperdrive![0]!.localConnectionString).toMatch(/^postgresql:\/\/usage_admin:/u);
    expect(binders.find(([n]) => n === 'api')![1].hyperdrive![0]!.localConnectionString).toMatch(/^postgresql:\/\/usage_writer:/u);
  });

  it('only the admin binds AdminRpc and StaffRpc; only the console binds ConsoleRpc', () => {
    const by = (entrypoint: string) => configs.filter(([, c]) => (c.services ?? []).some((s) => s.entrypoint === entrypoint)).map(([n]) => n);
    expect(by('AdminRpc')).toEqual(['admin']);
    expect(by('StaffRpc')).toEqual(['admin']);
    expect(by('ConsoleRpc')).toEqual(['console']);
    // Nobody binds the admin Worker: nothing calls into it.
    expect(configs.filter(([, c]) => (c.services ?? []).some((s) => s.service === m.admin!.workerName)).map(([n]) => n)).toEqual([]);
  });

  it('only the email issuer binds IssuerRpc; it binds the API at that entrypoint only, and no Worker but the API binds the API’s D1 (D434)', () => {
    const by = (entrypoint: string) => configs.filter(([, c]) => (c.services ?? []).some((s) => s.entrypoint === entrypoint)).map(([n]) => n);
    expect(by('IssuerRpc')).toEqual(['email issuer']);
    const issuer = configs.find(([n]) => n === 'email issuer')![1];
    expect((issuer.services ?? []).filter((s) => s.service === m.cloudflare.workerName)).toEqual([{ binding: 'API', service: m.cloudflare.workerName, entrypoint: 'IssuerRpc' }]);
    const apiD1 = configs.filter(([, c]) => (c.d1_databases ?? []).some((d) => d.database_name === m.cloudflare.d1Name)).map(([n]) => n);
    expect(apiD1).toEqual(['api']);
  });

  it('only the admin binds DirectoryRpc; the console binds only the issuer’s ConsoleIssuerRpc (D447); only the issuer binds its own D1 (partners never see it)', () => {
    const issuer = m.emailIssuer!.cloudflare;
    const bindsIssuer = configs.filter(([, c]) => (c.services ?? []).some((s) => s.service === issuer.workerName || s.entrypoint === 'DirectoryRpc')).map(([n]) => n);
    expect(bindsIssuer.sort()).toEqual(['admin', 'console']);
    expect(configs.find(([n]) => n === 'console')![1].services!.filter((s) => s.service === issuer.workerName).map((s) => s.entrypoint)).toEqual(['ConsoleIssuerRpc']);
    expect(configs.find(([n]) => n === 'admin')![1].services!.find((s) => s.binding === 'ISSUER')!.entrypoint).toBe('DirectoryRpc');
    const issuerD1 = configs.filter(([, c]) => (c.d1_databases ?? []).some((d) => d.database_name === issuer.d1Name)).map(([n]) => n);
    expect(issuerD1).toEqual(['email issuer']);
  });

  it('preview URLs are off on the console and the admin; both run first on every request', () => {
    for (const name of ['console', 'admin']) {
      const c = configs.find(([n]) => n === name)![1];
      expect(c.preview_urls, name).toBe(false);
      expect((c.assets as { run_worker_first: boolean }).run_worker_first, name).toBe(true);
    }
  });
});

describe('source checks', () => {
  it('the admin Worker runs no SQL on a D1 (it has none: every hot-DB and console read goes through an RPC)', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/\.prepare\(|D1Database/u);
    }
  });

  it('the only SQL it runs is in ops.ts (the ops schema), ledger.ts (usage and ops; C12) and retention-store.ts (C13)', () => {
    const ops = sources.find(({ f }) => f.endsWith('/ops.ts'))!.text;
    for (const m of ops.matchAll(/(?:FROM|INTO|UPDATE)\s+([a-z_.]+)/gu)) expect(m[1]!.startsWith('ops.'), m[0]).toBe(true);
    const ledger = sources.find(({ f }) => f.endsWith('/ledger.ts'))!.text;
    for (const m of ledger.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_.]+)/gu)) expect(/^(usage|ops|pg_catalog)\./u.test(m[1]!), m[0]).toBe(true);
    // The admin role never writes events, settlements' existing rows or statements' existing rows: no UPDATE or DELETE of them.
    expect(ledger).not.toMatch(/(UPDATE|DELETE FROM)\s+usage\./u);
    // Retention changes the ledger only through the owner's functions (0007): it reads and writes ops rows, and calls them.
    const retention = sources.find(({ f }) => f.endsWith('/retention-store.ts'))!.text;
    for (const m of retention.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_.]+)/gu)) expect(/^(usage\.(strip_uids|drop_expired_partitions|purge_app_users|retention_due)|ops\.)/u.test(m[1]!), m[0]).toBe(true);
    expect(retention).not.toMatch(/(UPDATE|DELETE FROM|INSERT INTO)\s+usage\./u);
    const sqlFiles = ['/ops.ts', '/ledger.ts', '/retention-store.ts'];
    for (const { f, text } of sources) if (!sqlFiles.some((x) => f.endsWith(x))) expect(text, f).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE)\s+[a-z_]+\./u);
  });

  it('STATEMENTS is written with `put` only (new keys; the bucket lock refuses overwrites) and read with `get`; never deleted', () => {
    for (const { f, text } of sources) {
      for (const m of text.matchAll(/(?:STATEMENTS|EXPORTS|bucket)\??\.(\w+)\(/gu)) expect(['get', 'put'], `${f}: ${m[0]}`).toContain(m[1]);
      expect(text, f).not.toMatch(/(STATEMENTS|EXPORTS|bucket)\??\.delete\(/u);
    }
  });

  it('the directory (ISSUER) is read only by the Users routes, the Support ID lookup and the audit view: never by a cron, the feed or a notice (C8b, D399); the System status page calls its health method only (D425)', () => {
    const readers = sources.filter(({ text }) => /\.ISSUER\b/u.test(text)).map(({ f }) => f.replace(srcDir, '')).sort();
    expect(readers).toEqual(['email-views.ts', 'routes.ts', 'status.ts', 'support.ts', 'users.ts']);
    // The Email issuer page (batch 9, D448) calls only its counts method.
    expect([...sources.find(({ f }) => f.endsWith('/email-views.ts'))!.text.matchAll(/issuer\.(\w+)\(/gu)].map((m) => m[1])).toEqual(['issuerStats']);
    const status = sources.find(({ f }) => f.endsWith('/status.ts'))!.text;
    expect([...status.matchAll(/ISSUER!?\.(\w+)\(/gu)].map((m) => m[1])).toEqual(['health']);
    // The only email it causes is the security alias's directory_budget.
    const users = sources.find(({ f }) => f.endsWith('/users.ts'))!.text;
    expect([...users.matchAll(/recipients\(([^)]*)\)/gu)].map((m) => m[1])).toEqual(['c.env.SECURITY_ALIAS']);
    // The lookup opens identities only (`get`), always as `support_lookup` with the lookup's ticket, and emails through
    // the Users routes' budgetAlert only.
    const support = sources.find(({ f }) => f.endsWith('/support.ts'))!.text;
    expect([...support.matchAll(/\bissuer\.(\w+)\(/gu)].map((m) => m[1])).toEqual(['get']);
    expect(support).toMatch(/issuer\.get\(\{ \.\.\.call, ticket, provider: k\.provider, sub: k\.sub, purpose: 'support_lookup' \}\)/u);
    expect(support).not.toMatch(/recipients\(|sendToAll\(/u);
  });

  it('log lines take allowlisted fields only (no email, sub, token, JWT or body field)', () => {
    const log = readFileSync(join(srcDir, 'log.ts'), 'utf8');
    const allowed = /new Set\(\[([^\]]*)\]\)/u.exec(log)![1]!;
    expect(allowed).not.toMatch(/email|sub|token|jwt|body|ip'/iu);
  });

  it('no link token, key or hash reaches a log call', () => {
    for (const { f, text } of sources) {
      for (const call of text.matchAll(/log\(\{[^}]*\}/gu)) expect(call[0].replace(/'[^']*'/gu, "''"), f).not.toMatch(/\b(token\w*|\w*key|\w*hash|email|jwt)\b/iu);
    }
  });

  it('the watchdog bearer is read only by watchdog.ts, and goes only into the Authorization header (C14, D330)', () => {
    const readers = sources.filter(({ text }) => /\.WATCHDOG_STATUS_TOKEN\b/u.test(text)).map(({ f }) => f.replace(srcDir, ''));
    expect(readers).toEqual(['watchdog.ts']);
    const client = sources.find(({ f }) => f.endsWith('/watchdog.ts'))!.text;
    const uses = [...client.matchAll(/\btoken\b/gu)].length;
    expect(client).toMatch(/authorization: `Bearer \$\{token\}`/u);
    // `token` appears in its declaration, the usable check and the header only: never in a log, a return or an error.
    expect(uses).toBe(3);
    expect(client).not.toMatch(/log\([^)]*token/u);
  });

  it('the SPA’s C14 pages: playbook routes, the "no playbook" error, the ack’s wording, https-only links, no watchdog call', () => {
    const spa = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
    expect(spa).toContain("'/security/playbooks'");
    expect(spa).toMatch(/\^\\\/security\\\/playbooks\\\/\(\[a-z0-9-\]\{1,64\}\)\$/u);
    expect(spa).toMatch(/h\('span', \{ class: 'error' \}, 'no playbook'\)/u);
    expect(spa).toMatch(/This only stops its 15-minute re-sends\. It does not clear the condition/u);
    expect(spa).toMatch(/href\.startsWith\('https:\/\/'\)/u);
    // The browser talks to its own origin only: the watchdog and its bearer stay server-side.
    expect(spa).not.toMatch(/\.workers\.dev|WATCHDOG_/u);
    expect(spa).not.toMatch(/bearer|authorization/iu);
    for (const m of spa.matchAll(/api\('(?:GET|POST)', [`'](\/[^`']*)/gu)) expect(m[1], m[0]).toMatch(/^\/api\//u);
  });

  it('the SPA’s Users pages (C8b): POST reads, the ticket asked to open a user, the warning shown, no export, nothing in the URL', () => {
    const spa = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
    const start = spa.indexOf('// ---- users (C8b');
    const end = spa.indexOf('// ---- router ----');
    expect(start).toBeGreaterThan(0);
    const users = spa.slice(start, end);
    expect(users).toContain("api('POST', '/api/users/search'");
    expect(users).toContain("api('POST', '/api/users/find'");
    expect(users).toContain("api('POST', '/api/users/get', { provider, sub, ticket })");
    expect(users).not.toMatch(/api\('GET', '\/api\/users/u);
    // The detail asks for the support reference (required) before any read.
    expect(users).toMatch(/h\('input', \{ name: 'ticket', required: true/u);
    // No export, select-all or download, and the search never goes into the URL or storage (the audit block's own
    // paging link carries ids and the filters only).
    const pages = users.slice(0, users.indexOf('function directoryAuditBlock'));
    expect(pages).not.toMatch(/csv|download|select all|localStorage|sessionStorage|pushState|location\.search/iu);
    expect(users).toContain('UNVERIFIED claim');
    expect(spa).toContain("{ path: '/users', label: 'Users' }");
    // An opened user's provider and sub never reach a URL (D410): one fixed path, opened from memory, the history entry
    // holding only an opaque number; no path is built from a sub, and the old `/users/<provider>/<sub>` route is gone.
    expect(users).toContain("const USER_OPEN_PATH = '/users/open';");
    expect(users).toContain('go(USER_OPEN_PATH, { user: usersState.seq });');
    expect(spa).not.toMatch(/userPath|`\/users\/\$\{|encodeURIComponent\((provider|sub|u\.sub|i\.sub|m\.sub)\)/u);
    expect(spa).toContain('else if (path === USER_OPEN_PATH) await userPage(main);');
    expect(spa).not.toMatch(/userPage\(main, /u);
    for (const m of users.matchAll(/h\('a', \{([^}]*)\}/gu)) expect(m[1], m[0]).toMatch(/href: (USER_OPEN_PATH|path)/u);
    // Every history write in the SPA carries no state but that number: `null` or go()'s `state`.
    for (const m of spa.matchAll(/history\.(?:pushState|replaceState)\(([^,]*),/gu)) expect(['null', 'state'], m[0]).toContain(m[1]);
    // A search naming one user (an id, a wallet, a sub, a full address) asks for the ticket before any call (D410).
    expect(users).toContain("usersState.result = await api('POST', '/api/users/find', { query: q, ticket });");
    expect(users).toMatch(/if \(!ticket && \(\(q && \(walletQuery\(q\) \|\| fullAddress\(q\)\)\) \|\| \(f\.sub \|\| ''\)\.trim\(\)\)\) \{/u);
  });

  it('the SPA’s Support ID lookup (C15, D399): POST reads, the ticket required in the issuer’s rule, no export or storage, nothing in the URL; Support IDs routed there, /find kept', () => {
    const spa = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
    const start = spa.indexOf('// ---- Support ID lookup (C15');
    const end = spa.indexOf('// ---- router ----');
    expect(start).toBeGreaterThan(0);
    const lookup = spa.slice(start, end);
    expect(lookup).toContain("api('POST', '/api/support/lookup', body)");
    expect(lookup).toContain("api('POST', '/api/users/find', { query: f.query.trim(), ticket: f.ticket.trim() })");
    expect(lookup).not.toMatch(/api\('GET'/u);
    expect(lookup).toMatch(/h\('input', \{ name: 'ticket', required: true, maxlength: 64, pattern: SUPPORT_TICKET_PATTERN/u);
    expect(lookup).not.toMatch(/csv|download|select all|localStorage|sessionStorage|pushState|replaceState|location\.(search|hash)/iu);
    expect(spa).toContain("{ path: '/support', label: 'Support ID lookup' }");
    expect(spa).toContain("else if (path === '/support') await supportPage(main);");
    // The screen moves only to literal paths: a code, id or address never lands in the URL.
    const moves = [...spa.matchAll(/\bgo\(([^)]*)\)/gu)].map((m) => m[1]);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m === 'path, state = null' || m === 'USER_OPEN_PATH, { user: usersState.seq }' || /^'\/[a-z]+'$/u.test(m!), m).toBe(true);
    // The input's pattern accepts exactly what console-core's SUPPORT_TICKET_RE does (the route's and the issuer's rule).
    const raw = /const SUPPORT_TICKET_PATTERN = '([^']+)'/u.exec(lookup)![1]!.replaceAll('\\\\', '\\');
    const html = new RegExp(`^(?:${raw})$`, 'v');
    for (const t of ['ZD-1234', 'T', 'a.b_c#d:e-f', 'x'.repeat(64), '', 'x'.repeat(65), 'ZD 1234', 'a@b.example', 'é', ' T']) expect(html.test(t), t).toBe(SUPPORT_TICKET_RE.test(t));
    // The Users search sends a Support ID to the lookup; User IDs, internal ids and wallets still go to /find.
    expect(spa).toMatch(/if \(q && supportIdQuery\(q\)\) \{\s+openLookup\(q, \(f\.ticket \|\| ''\)\.trim\(\), true\);/u);
    expect(spa).toMatch(/if \(q && walletQuery\(q\)\) \{\s+usersState\.kind = 'wallet';\s+usersState\.result = await api\('POST', '\/api\/users\/find'/u);
  });

  it('the SPA writes text only: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or remote URL', () => {
    const spa = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
    expect(spa).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/u);
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toMatch(/<script>|style=/u);
    expect(spa).not.toMatch(/style=|\.style\./u);
    // Nothing in browser storage (a form waiting for a new sign-in stays in the tab's memory), and every API call is
    // sent with `redirect: 'manual'`, one fetch call only (an Access redirect is seen, never followed: D424).
    expect(spa).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/u);
    expect([...spa.matchAll(/\bfetch\(/gu)]).toHaveLength(1);
    expect(spa).toContain("redirect: 'manual'");
  });

  it('public/ is the SPA alone, plus the brand fonts: the local preview harness and its fake data stay in test-spa/, never served', () => {
    expect(readdirSync(new URL('../../public/', import.meta.url)).sort()).toEqual(['app.css', 'app.js', 'fonts', 'index.html']);
    // public/fonts holds packages/brand's WOFF2 files and their OFL licence, byte for byte, and nothing else (D426).
    expect(readdirSync(new URL('../../public/fonts/', import.meta.url)).sort()).toEqual(BRAND_FONT_FILES);
    for (const f of BRAND_FONT_FILES) {
      const shipped = readFileSync(new URL(`../../public/fonts/${f}`, import.meta.url));
      expect(shipped.equals(readFileSync(new URL(`../../../../packages/brand/fonts/${f}`, import.meta.url))), `${f}: run sync-brand`).toBe(true);
    }
    for (const f of FONT_FILES) {
      const buf = readFileSync(new URL(`../../public/fonts/${f.file}`, import.meta.url));
      expect(createHash('sha256').update(buf).digest('hex'), f.file).toBe(f.sha256);
      expect(woff2Names(buf).get(13), f.file).toContain('SIL Open Font License, Version 1.1');
    }
    expect(readFileSync(new URL('../../public/fonts/OFL.txt', import.meta.url), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it("the stylesheet loads only the brand fonts, from this origin: no import, image or other URL (CSP font-src and img-src 'self')", () => {
    const css = readFileSync(new URL('../../public/app.css', import.meta.url), 'utf8');
    // The brand block is packages/brand's fonts.css and tokens.css as they are (scripts/sync-brand.ts).
    expect(css.includes(brandBlock()), 'public/app.css: run sync-brand').toBe(true);
    expect(css.split(BRAND_START)).toHaveLength(2);
    // Every url() is one of the font files, relative to /app.css (so /fonts/…); nothing else is loaded.
    const urls = [...css.matchAll(/url\(([^)]*)\)/gu)].map((m) => m[1]);
    expect(urls.sort()).toEqual(FONT_FILES.map((f) => `'./fonts/${f.file}'`).sort());
    expect([...css.matchAll(/@font-face\s*\{/gu)]).toHaveLength(FONT_FILES.length);
    expect(css).not.toMatch(/@import|https?:|data:|\/\/[a-z]/iu);
    expect(css).not.toMatch(/proxima|agrandir/iu);
  });

  it('the shell draws the Hana mark inline from packages/brand (no image request, no script, colours from the stylesheet)', () => {
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    const svg = /<svg class="mark"[^>]*>([\s\S]*?)<\/svg>/u.exec(html);
    expect(svg).not.toBeNull();
    expect(svg![0]).toContain('aria-hidden="true"');
    expect([...svg![1]!.matchAll(/ d="([^"]+)"/gu)].map((m) => m[1])).toEqual([...MARK_PATHS]);
    expect(svg![0]).not.toMatch(/href|fill=|style|<script|<image|on\w+=/u);
    expect(html).not.toMatch(/<img\b/u);
  });

  it('the left nav and the env badge keep their own colours at WCAG AA in light and dark', () => {
    const css = readFileSync(new URL('../../public/app.css', import.meta.url), 'utf8');
    const own = css.slice(css.indexOf(BRAND_END));
    const darkAt = own.indexOf('@media (prefers-color-scheme: dark)');
    const light = hexVars(own.slice(0, darkAt));
    const dark = new Map([...light, ...hexVars(own.slice(darkAt, own.indexOf('* { box-sizing')))]);
    const pairs: [string, string, number][] = [
      ['--side-ink', '--side-bg', 7],
      ['--side-ink-2', '--side-bg', 4.5],
      ['--side-ink-2', '--side-hover', 4.5],
      ['--side-muted', '--side-bg', 4.5],
      ['--side-active-ink', '--side-active-bg', 4.5],
      ['--side-focus', '--side-bg', 3],
      ['--side-active-bg', '--side-bg', 3],
      ['--env-ink', '--env-bg', 7],
      ['--env-bg', '--side-bg', 3],
    ];
    for (const [name, v] of [['light', light], ['dark', dark]] as const) {
      for (const [fg, bg, min] of pairs) expect(contrast(v.get(fg)!, v.get(bg)!), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    }
  });
});
