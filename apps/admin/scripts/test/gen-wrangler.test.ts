// The admin Worker's generated config and the config rules across Workers (docs/batch-c-spec.md "Tests: Topology and
// config"): only the API and the admin bind Hyperdrive, to different configs; only the admin binds AdminRpc and
// StaffRpc; `preview_urls: false` everywhere, `workers_dev: false` on production manifests; the Worker runs first on
// every request. Plus the source checks: no secret in a log line, no SQL on the hot or console DBs, no HTML sink in
// the SPA, the CSP equal to the console's.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, manifestSchema } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { wranglerConfig as apiConfig } from '../../../api/scripts/gen-wrangler.ts';
import { pagesWranglerConfig } from '../../../api/scripts/pages-wrangler.ts';
import { consoleCsp } from '../../../console/src/headers.ts';
import { wranglerConfig as consoleConfig } from '../../../console/scripts/gen-wrangler.ts';
import { wranglerConfig as issuerConfig, TEST_MANIFEST as ISSUER_MANIFEST } from '../../../email-issuer/scripts/gen-wrangler.ts';
import { wranglerConfig as watchdogConfig, TEST_MANIFEST as WATCHDOG_MANIFEST } from '../../../watchdog/scripts/gen-wrangler.ts';
import { adminCsp } from '../../src/headers.ts';
import { CRON, LOCAL_ADMIN_CONNECTION_STRING, TEST_ADMIN_HYPERDRIVE_ID, TEST_MANIFEST, TEST_WATCHDOG_URL, existingAdminHyperdriveId, main, testWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';

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
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'admin.test', custom_domain: true }],
      vars: {
        ENV_NAME: 'sandbox-test',
        ADMIN_ORIGIN: 'https://admin.test',
        CONSOLE_ORIGIN: 'https://console.test',
        FILES_ORIGIN: 'https://files.test',
        NEAR_RPC: 'https://rpc.test.invalid',
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
      ['ACCESS_AUD', 'ACCESS_TEAM_DOMAIN', 'ADMIN_ORIGIN', 'APP_CHANGE_DELAY_MS', 'CONSOLE_ORIGIN', 'EMAIL_FROM', 'ENV_NAME', 'FILES_ORIGIN', 'NEAR_NETWORK', 'NEAR_RPC', 'OWNER_GRANT_DELAY_MS', 'RELAYER_ACCOUNT', 'SECURITY_ALIAS', 'SIGNER_ACCOUNT', 'STAFF_EMAILS', 'WATCHDOG_URL'].sort(),
    );
    expect(LOCAL_ADMIN_CONNECTION_STRING).toMatch(/\.invalid:/u);
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
    ['email issuer', issuerConfig({ ...m, name: 'local-test' }, LOCAL_D1_ID, LOCAL_D1_ID) as Config],
    ['console', consoleConfig(m, LOCAL_D1_ID) as Config],
    ['admin', wranglerConfig(m, { adminHyperdriveId: TEST_ADMIN_HYPERDRIVE_ID }) as Config],
  ];

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

  it('the SPA writes text only: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or remote URL', () => {
    const spa = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
    expect(spa).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/u);
    const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toMatch(/<script>|style=/u);
    expect(spa).not.toMatch(/style=|\.style\./u);
  });
});
