// Generates apps/files/wrangler.jsonc (gitignored) from the `files` block of envs/<env>.json (docs/batch-c-spec.md
// "Bindings": `LOGOS` read only by code, the `FILES_ORIGIN` var; no secret, D1 or Hyperdrive). The tests use
// wrangler.vitest.jsonc, written by vitest.config.ts with testWranglerConfig().
//
//   pnpm --filter @hana-id/files gen <env>
//
// Where the Worker lives follows from `files.origin`, as for batch B's page Workers (apps/api scripts/pages-wrangler.ts):
// - `https://<worker>.<subdomain>.workers.dev` (local*/sandbox* envs only): served on workers.dev, and the hostname's
//   first label must be `files.workerName` (that is the Worker's workers.dev name);
// - any other https hostname: a Custom Domain route on it;
// - loopback (local* envs): no deployment target; `wrangler dev` listens on the origin's host and port.
// Preview URLs are off in every case, so logos exist on their origin only.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, accountIdFields, isDevEnv, isLoopbackHost, loadEnv } from '@hana-id/env';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COMPATIBILITY_DATE = '2026-10-01';

const WORKERS_DEV_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workers\.dev$/u;

/** Name and deployment target. Throws for an origin the Worker can't be deployed on. */
export function filesPlacement(m: Manifest): Record<string, unknown> {
  const f = m.files;
  if (!f) throw new Error(`envs/${m.name}.json has no files block (the dashboard blocks: console, files, admin, usage, email, ownerGrantDelayMs)`);
  const url = new URL(f.origin);
  if (isLoopbackHost(url.hostname)) {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return {
      workers_dev: false,
      preview_urls: false,
      dev: { ip: url.hostname.replace(/^\[(.*)\]$/u, '$1'), port, local_protocol: url.protocol === 'https:' ? 'https' : 'http' },
    };
  }
  const dev = WORKERS_DEV_RE.exec(url.hostname);
  if (dev) {
    if (!isDevEnv(m.name)) throw new Error(`files.origin ${f.origin}: workers.dev hostnames are for local*/sandbox* envs only; use a Hana-owned domain`);
    if (dev[1] !== f.workerName) throw new Error(`files.origin ${f.origin} must be the files Worker's own workers.dev hostname (${f.workerName}.<subdomain>.workers.dev)`);
    return { workers_dev: true, preview_urls: false };
  }
  if (url.port) throw new Error(`files.origin ${f.origin}: a Custom Domain can't have a port`);
  return { workers_dev: false, preview_urls: false, routes: [{ pattern: url.hostname, custom_domain: true }] };
}

export function wranglerConfig(m: Manifest): Record<string, unknown> {
  const f = m.files;
  if (!f) throw new Error(`envs/${m.name}.json has no files block (the dashboard blocks: console, files, admin, usage, email, ownerGrantDelayMs)`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: f.workerName,
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    // The env's Cloudflare account, when the manifest names it (D404).
    ...accountIdFields(m.cloudflare.accountId, 'cloudflare.accountId'),
    ...filesPlacement(m),
    // The Worker's own log lines only (codes, never a key or an app id); the platform's per-request records would add
    // the URL, which is public anyway, so they stay on.
    observability: { enabled: true },
    vars: { FILES_ORIGIN: f.origin },
    // Read only by code (a source test): the console writes logos, the files Worker only gets them.
    r2_buckets: [{ binding: 'LOGOS', bucket_name: f.logosBucket }],
  };
}

/**
 * The fixed manifest the files tests' config is generated from: every dashboard block (so it validates), no real
 * account, origin or id.
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
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-test', d1Name: 'hana-id-test' },
  console: { workerName: 'hana-id-console-test', d1Name: 'hana-id-console-test', origin: 'https://console.test', authWorkerName: 'hana-id-console-auth-test', authOrigin: 'https://console-auth.test' },
  files: { workerName: 'hana-id-files-test', origin: 'https://files.test', logosBucket: 'hana-id-logos-test', statementsBucket: 'hana-id-statements-test', exportsBucket: 'hana-id-exports-test' },
  admin: { workerName: 'hana-id-admin-test', origin: 'https://admin.test', accessTeamDomain: 'hana-test.cloudflareaccess.com', accessAud: 'UNSET', staffEmails: ['staff@hana.example'] },
  usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'hana-id-usage-writer-test', adminHyperdrive: 'hana-id-usage-admin-test' },
  email: { from: 'Hana ID <notices@mail.hana.example>', securityAlias: 'security@hana.example' },
};

export function testWranglerConfig(): Record<string, unknown> {
  return wranglerConfig(TEST_MANIFEST);
}

export function writeWranglerConfig(m: Manifest, dir: string = appDir): string {
  const config = wranglerConfig(m);
  const path = join(dir, 'wrangler.jsonc');
  const header = `// Generated by apps/files/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(config, null, 2) + '\n');
  return path;
}

export function main(argv: string[], opts: { dir?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  const envName = argv.find((a) => !a.startsWith('--'));
  if (!envName || argv.length !== 1) {
    console.error('usage: gen-wrangler <env>');
    process.exit(2);
  }
  const manifest = (opts.loadManifest ?? loadEnv)(envName);
  const path = writeWranglerConfig(manifest, opts.dir);
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.files!.workerName}, origin ${manifest.files!.origin})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
