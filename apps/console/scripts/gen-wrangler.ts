// Generates apps/console/wrangler.jsonc (gitignored: it can carry the real CONSOLE_DB id) from the dashboard blocks of
// envs/<env>.json (docs/batch-c-spec.md "Bindings"). The tests use wrangler.vitest.jsonc, written by vitest.config.ts
// with testWranglerConfig().
//
//   pnpm --filter @hana-id/console gen <env> [--d1-id <uuid>]
//
// --d1-id  CONSOLE_DB's id (`wrangler d1 create <console.d1Name>` prints it). Without it, the id already in
//          wrangler.jsonc is kept only when that file names the same database, else a local-only placeholder.
//
// Batch C9: the console's route is on (`placement` below): `https://<console.workerName>.<subdomain>.workers.dev` in a
// dev env (sandbox-dev, D93), else a Custom Domain on `console.origin`'s host; never preview URLs. The console's Google
// client id comes from `consoleAudiences` (exactly one `google` entry, D294); its secret is a `wrangler secret`, never
// in this file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, accountIdFields, hanaOwnOrigins, isDevEnv, isLoopbackHost, loadEnv } from '@hana-id/env';
import { CONSOLE_RATE_LIMITS } from '../src/limits.ts';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_D1_ID = '00000000-0000-4000-8000-000000000000';
export const COMPATIBILITY_DATE = '2026-10-01';
/** Hourly: invite expiry, owner grants, housekeeping purges, replaced logos (src/cron.ts). */
export const CRON = '0 * * * *';
/** The SPA's Vite build (`pnpm --filter @hana-id/console build`; `deploy` builds first). */
export const ASSETS_DIR = './dist';
/** The tests' stand-in for the build (a fixed index.html), so the Worker tests need no SPA build. */
export const TEST_ASSETS_DIR = './test/assets';

const WORKERS_DEV_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workers\.dev$/u;

/**
 * Where a Worker serving `origin` is reachable (apps/api/scripts/pages-wrangler.ts's rule): its workers.dev hostname in
 * a dev env, which must name the Worker itself; a Custom Domain on any other https host; nowhere public for a loopback
 * origin (`wrangler dev`). Preview URLs are off everywhere.
 */
export function placement(m: Manifest, field: string, origin: string, workerName: string): Record<string, unknown> {
  const url = new URL(origin);
  if (isLoopbackHost(url.hostname)) return { workers_dev: false, preview_urls: false };
  const dev = WORKERS_DEV_RE.exec(url.hostname);
  if (dev) {
    if (!isDevEnv(m.name)) throw new Error(`${field} ${origin}: workers.dev hostnames are for local*/sandbox* envs only; use a Hana-owned domain`);
    if (dev[1] !== workerName) throw new Error(`${field} ${origin}: a workers.dev origin must be the Worker's own (${workerName}.<subdomain>.workers.dev)`);
    return { workers_dev: true, preview_urls: false };
  }
  if (url.port) throw new Error(`${field} ${origin}: a Custom Domain can't have a port`);
  return { workers_dev: false, preview_urls: false, routes: [{ pattern: url.hostname, custom_domain: true }] };
}

/** The console's Google OAuth client: the manifest's one `google` console audience (D294). */
export function consoleGoogleClientId(m: Manifest): string {
  const google = m.consoleAudiences.filter(([p]) => p === 'google').map(([, a]) => a);
  if (google.length !== 1) {
    throw new Error(`envs/${m.name}.json: consoleAudiences must have exactly one google client (the console's sign-in client, setup step 11); it has ${google.length}`);
  }
  return google[0]!;
}

export function wranglerConfig(m: Manifest, d1Id: string, opts: { assetsDir?: string } = {}): Record<string, unknown> {
  const c = m.console;
  const f = m.files;
  if (!c || !f || m.ownerGrantDelayMs === undefined) throw new Error(`envs/${m.name}.json has no dashboard blocks (console, files, admin, usage, email, ownerGrantDelayMs)`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: c.workerName,
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    // The env's Cloudflare account, when the manifest names it (D404).
    ...accountIdFields(m.cloudflare.accountId, 'cloudflare.accountId'),
    ...placement(m, 'console.origin', c.origin, c.workerName),
    // The Worker's own JSON log lines (src/log.ts: no email, sub, token or cookie), not the platform's per-request
    // invocation records, which carry the URL (sign-in's handoff code `?h=`, a live capability for 60 s, and the auth
    // origin's `code` and `state` reaching AuthHandler).
    observability: { enabled: true, logs: { invocation_logs: false } },
    // Next to the console's D1 and the API (which the console calls for every app view), as the API runs.
    placement: { region: 'aws:ap-east-1' },
    vars: {
      ENV_NAME: m.name,
      CONSOLE_ORIGIN: c.origin,
      CONSOLE_AUTH_ORIGIN: c.authOrigin,
      CONSOLE_GOOGLE_CLIENT_ID: consoleGoogleClientId(m),
      FILES_ORIGIN: f.origin,
      NEAR_RPC: m.rpc,
      SIGNER_ACCOUNT: m.signer,
      OWNER_GRANT_DELAY_MS: String(m.ownerGrantDelayMs),
      // Batch C10: the origin rules the API applies (the same vars it gets), checked before an origin add's sign-in.
      NETWORK: m.network,
      REFUSED_ORIGINS: JSON.stringify(hanaOwnOrigins(m)),
    },
    d1_databases: [{ binding: 'CONSOLE_DB', database_name: c.d1Name, database_id: d1Id, migrations_dir: 'migrations' }],
    // The API's ConsoleRpc entrypoint: the console is its only caller (the admin Worker binds AdminRpc).
    services: [{ binding: 'API', service: m.cloudflare.workerName, entrypoint: 'ConsoleRpc' }],
    // LOGOS: the console writes logos (C11) and deletes replaced ones; STATEMENTS: read only by code (a source check).
    r2_buckets: [
      { binding: 'LOGOS', bucket_name: f.logosBucket },
      { binding: 'STATEMENTS', bucket_name: f.statementsBucket },
    ],
    // Batch C11: every uploaded logo is decoded and re-encoded through the Cloudflare Images binding (D93).
    images: { binding: 'IMAGES' },
    ratelimits: CONSOLE_RATE_LIMITS.map((r) => ({ name: r.name, namespace_id: r.namespace_id, simple: { ...r.simple } })),
    // The Worker runs first on every request (host dispatch, CSRF, headers on assets too).
    assets: { directory: opts.assetsDir ?? ASSETS_DIR, binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
    triggers: { crons: [CRON] },
  };
}

/**
 * The fixed manifest the console tests' config is generated from: no real account, origin or id. Its API Worker name
 * is the one the tests' auxiliary API Worker runs under (vitest.config.ts), so the `API` binding reaches it.
 */
export const TEST_MANIFEST: Manifest = {
  name: 'sandbox-test',
  network: 'testnet',
  signer: 'signer.test.near',
  relayer: 'relayer.test.near',
  owner: 'owner.test.near',
  mpc: 'mpc.test.near',
  ckdDomainId: 2,
  ckdNetworkKey: 'UNSET',
  rpc: 'https://rpc.test.invalid',
  apiUrl: 'https://api.test',
  vaultOrigin: 'https://vault.test',
  authOrigin: 'https://auth.test',
  changeDelayMs: 60_000,
  appChangeDelayMs: 60_000,
  ownerGrantDelayMs: 60_000,
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [['google', 'console-client.apps.googleusercontent.com']],
  cloudflare: { workerName: 'hana-id-api-test', d1Name: 'hana-id-test' },
  console: { workerName: 'hana-id-console-test', d1Name: 'hana-id-console-test', origin: 'https://console.test', authWorkerName: 'hana-id-console-auth-test', authOrigin: 'https://console-auth.test' },
  files: { workerName: 'hana-id-files-test', origin: 'https://files.test', logosBucket: 'hana-id-logos-test', statementsBucket: 'hana-id-statements-test', exportsBucket: 'hana-id-exports-test' },
  admin: { workerName: 'hana-id-admin-test', origin: 'https://admin.test', accessTeamDomain: 'hana-test.cloudflareaccess.com', accessAud: 'UNSET', staffEmails: ['staff@hana.example'] },
  usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'hana-id-usage-writer-test', adminHyperdrive: 'hana-id-usage-admin-test' },
  email: { from: 'Hana ID <notices@mail.hana.example>', securityAlias: 'security@hana.example' },
};

export function testWranglerConfig(): Record<string, unknown> {
  return wranglerConfig(TEST_MANIFEST, LOCAL_D1_ID, { assetsDir: TEST_ASSETS_DIR });
}

/** The D1 id in an existing wrangler.jsonc, only when it was generated for the same database. */
export function existingD1Id(path: string, d1Name: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const id = /"database_id"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  const name = /"database_name"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  return id && id !== LOCAL_D1_ID && name === d1Name ? id : null;
}

export function writeWranglerConfig(m: Manifest, d1Arg: string | undefined, dir: string = appDir): { path: string; d1Id: string } {
  if (!m.console) throw new Error(`envs/${m.name}.json has no console block`);
  const path = join(dir, 'wrangler.jsonc');
  const d1Id = d1Arg ?? existingD1Id(path, m.console.d1Name) ?? LOCAL_D1_ID;
  const config = wranglerConfig(m, d1Id);
  const header = `// Generated by apps/console/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(config, null, 2) + '\n');
  return { path, d1Id };
}

export function main(argv: string[], opts: { dir?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  const envName = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--d1-id');
  if (!envName) {
    console.error('usage: gen-wrangler <env> [--d1-id <uuid>]');
    process.exit(2);
  }
  const idFlag = argv.indexOf('--d1-id');
  const d1Arg = idFlag >= 0 ? argv[idFlag + 1] : undefined;
  if (idFlag >= 0 && (!d1Arg || !/^[0-9a-f-]{36}$/u.test(d1Arg))) throw new Error('--d1-id needs a D1 database uuid');
  const manifest = (opts.loadManifest ?? loadEnv)(envName);
  const { path, d1Id } = writeWranglerConfig(manifest, d1Arg, opts.dir);
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.console!.workerName}${d1Id === LOCAL_D1_ID ? ', local D1 placeholder id' : ''}; served on ${manifest.console!.origin})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
