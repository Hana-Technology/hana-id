// Generates apps/admin/wrangler.jsonc (gitignored: it carries the admin Hyperdrive config id) from the dashboard blocks
// of envs/<env>.json (docs/batch-c-spec.md "Bindings", "Topology": admin routes). The tests use wrangler.vitest.jsonc,
// written by vitest.config.ts with testWranglerConfig().
//
//   pnpm --filter @hana-id/admin gen <env> [--admin-hyperdrive-id <id>|off]
//
// --admin-hyperdrive-id  The `hana-id-usage-admin-<env>` Hyperdrive config id (`usage-setup <env> hyperdrive` prints
//                        it; not a secret), bound as USAGE_DB: the feed's cursors and the watcher's state. Without the
//                        flag, the id already in wrangler.jsonc is kept when that file is this Worker's; `off` drops the
//                        binding (dev envs only: the feed and the watcher then don't run). A production env needs one.
//
// Where the Worker lives follows from `admin.origin` (D284):
// - `https://<admin.workerName>.<subdomain>.workers.dev`: dev envs only (`local*`/`sandbox*` on a non-mainnet network),
//   `workers_dev: true` with Worker-level Access turned on in the dashboard (D75);
// - any other https host: a Custom Domain route on the Hana zone, `workers_dev: false`, behind a self-hosted Access
//   application;
// - loopback (local* envs): no deployment target; `wrangler dev` listens on it.
// Preview URLs are off everywhere.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, isDevEnv, isLoopbackHost, loadEnv } from '@hana-id/env';
import { workersDevHost } from '../../api/scripts/pages-wrangler.ts';
import { TEST_MANIFEST as CONSOLE_TEST_MANIFEST } from '../../console/scripts/gen-wrangler.ts';
import { CRONS, FIVE_MINUTES } from '../src/crons.ts';
import { TEST_MANIFEST as WATCHDOG_TEST_MANIFEST } from '../../watchdog/scripts/gen-wrangler.ts';
import { TEST_MANIFEST as ISSUER_TEST_MANIFEST } from '../../email-issuer/scripts/gen-wrangler.ts';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COMPATIBILITY_DATE = '2026-10-01';
/** Every 5 minutes: blocking notices, the feed, the watcher (src/cron.ts). */
export const CRON = FIVE_MINUTES;
export const ASSETS_DIR = './public';
export const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/u;
/**
 * USAGE_DB's `localConnectionString` (`wrangler dev`): `.invalid` never resolves (RFC 6761), so a local run's feed and
 * watcher fail at connect and are logged. No credential: the password is a placeholder.
 */
export const LOCAL_ADMIN_CONNECTION_STRING = 'postgresql://usage_admin:local-dev@usage-ledger.local.invalid:5432/usage';

/** A production manifest: not a dev env, or on mainnet. No workers.dev and a Hyperdrive id required. */
export const isProductionManifest = (m: Pick<Manifest, 'name' | 'network'>): boolean => !isDevEnv(m.name) || (m.network as string) === 'mainnet';

/** Name and deployment target of the admin Worker. Throws for an origin it can't be deployed on. */
export function adminPlacement(m: Manifest): Record<string, unknown> {
  const a = m.admin!;
  const url = new URL(a.origin);
  if (isLoopbackHost(url.hostname)) {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return { name: a.workerName, workers_dev: false, preview_urls: false, dev: { ip: url.hostname.replace(/^\[(.*)\]$/u, '$1'), port, local_protocol: url.protocol === 'https:' ? 'https' : 'http' } };
  }
  const dev = workersDevHost(url.hostname);
  if (dev) {
    if (isProductionManifest(m)) throw new Error(`admin.origin ${a.origin}: workers.dev is for local*/sandbox* envs on a test network only; production uses a Custom Domain with an Access application (D75)`);
    if (dev.worker !== a.workerName) throw new Error(`admin.origin ${a.origin} names Worker ${dev.worker}, not admin.workerName ${a.workerName}`);
    return { name: a.workerName, workers_dev: true, preview_urls: false };
  }
  if (url.protocol !== 'https:') throw new Error(`admin.origin ${a.origin} must be https`);
  if (url.port) throw new Error(`admin.origin ${a.origin}: a Custom Domain can't have a port`);
  return { name: a.workerName, workers_dev: false, preview_urls: false, routes: [{ pattern: url.hostname, custom_domain: true }] };
}

export function wranglerConfig(m: Manifest, opts: { adminHyperdriveId?: string | null } = {}): Record<string, unknown> {
  const { console: c, files: f, admin: a, email: e } = m;
  if (!c || !f || !a || !m.usage || !e || m.ownerGrantDelayMs === undefined) throw new Error(`envs/${m.name}.json has no dashboard blocks (console, files, admin, usage, email, ownerGrantDelayMs)`);
  const id = opts.adminHyperdriveId ?? null;
  if (id !== null && !HYPERDRIVE_ID_RE.test(id)) throw new Error('A Hyperdrive id is 32 lowercase hex characters');
  if (id === null && isProductionManifest(m)) throw new Error(`envs/${m.name}.json is a production env: pass --admin-hyperdrive-id (the ${m.usage.adminHyperdrive} config; the feed and the watcher need it)`);
  // "Security & monitoring" (C14, D330): the watchdog's origin is a var; its bearer WATCHDOG_STATUS_TOKEN is a secret,
  // never written here. A production admin without the watchdog would show no monitoring, so it is refused.
  const watchdogUrl = m.watchdog?.url ?? null;
  if (watchdogUrl === null && isProductionManifest(m)) throw new Error(`envs/${m.name}.json is a production env: set watchdog.url (the watchdog Worker's https origin) so the admin's Security & monitoring view can read it`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    ...adminPlacement(m),
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    // pg (the ops store over Hyperdrive) needs the Node built-ins.
    compatibility_flags: ['nodejs_compat'],
    // The Worker's own JSON log lines (src/log.ts: no email, sub, JWT or token), not the per-request invocation records
    // (their URLs can carry an audit filter with a staff or member id).
    observability: { enabled: true, logs: { invocation_logs: false } },
    vars: {
      ENV_NAME: m.name,
      ADMIN_ORIGIN: a.origin,
      CONSOLE_ORIGIN: c.origin,
      FILES_ORIGIN: f.origin,
      NEAR_RPC: m.rpc,
      SIGNER_ACCOUNT: m.signer,
      // C12: settlement checks each transaction's signer against the relayer account; the nonce check reads its keys.
      RELAYER_ACCOUNT: m.relayer,
      ACCESS_TEAM_DOMAIN: a.accessTeamDomain,
      ACCESS_AUD: a.accessAud,
      STAFF_EMAILS: JSON.stringify(a.staffEmails),
      EMAIL_FROM: e.from,
      SECURITY_ALIAS: e.securityAlias,
      APP_CHANGE_DELAY_MS: String(m.appChangeDelayMs),
      OWNER_GRANT_DELAY_MS: String(m.ownerGrantDelayMs),
      NEAR_NETWORK: m.network,
      ...(watchdogUrl ? { WATCHDOG_URL: watchdogUrl } : {}),
    },
    // AdminRpc on the API, StaffRpc on the console and (C8b, D275) DirectoryRpc on the email issuer: the admin Worker
    // is the only caller of each. An env without an email issuer has no directory: no ISSUER, and the Users screen says so.
    services: [
      { binding: 'API', service: m.cloudflare.workerName, entrypoint: 'AdminRpc' },
      { binding: 'CONSOLE', service: c.workerName, entrypoint: 'StaffRpc' },
      ...(m.emailIssuer ? [{ binding: 'ISSUER', service: m.emailIssuer.cloudflare.workerName, entrypoint: 'DirectoryRpc' }] : []),
    ],
    // The ledger's admin role (usage_admin): its own Hyperdrive config, never the API's writer one (D73).
    ...(id ? { hyperdrive: [{ binding: 'USAGE_DB', id, localConnectionString: LOCAL_ADMIN_CONNECTION_STRING }] } : {}),
    // C12: statements (written once under new keys; the bucket lock keeps them, D308) and the ledger exports.
    r2_buckets: [
      { binding: 'STATEMENTS', bucket_name: f.statementsBucket },
      { binding: 'EXPORTS', bucket_name: f.exportsBucket },
    ],
    // The Worker runs first on every request (host dispatch, the Access check, headers on assets too).
    assets: { directory: ASSETS_DIR, binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
    triggers: { crons: [...CRONS] },
  };
}

/** The watchdog origin of the admin tests (answered by the tests' fetch stub; test/helpers.ts WATCHDOG). */
export const TEST_WATCHDOG_URL = 'https://hana-id-watchdog-test.watchdog-test.workers.dev';

/**
 * The admin tests' manifest: the console's, with a real-looking AUD tag (64 hex) so the Access check can pass, and the
 * watchdog test manifest's block with a `url` (the "Security & monitoring" view's source).
 */
export const TEST_MANIFEST: Manifest = {
  ...CONSOLE_TEST_MANIFEST,
  admin: { ...CONSOLE_TEST_MANIFEST.admin!, accessAud: 'ab'.repeat(32) },
  watchdogs: WATCHDOG_TEST_MANIFEST.watchdogs,
  watchdog: { ...WATCHDOG_TEST_MANIFEST.watchdog!, url: TEST_WATCHDOG_URL },
};
/** Fixed fake Hyperdrive ids for the config snapshots (no real config). */
export const TEST_ADMIN_HYPERDRIVE_ID = 'a'.repeat(32);

/**
 * The workerd tests' config: no Hyperdrive (the tests swap in an in-memory ops store), and the email issuer test
 * manifest's Worker as the ISSUER binding's service (the suite runs that Worker beside this one, vitest.config.ts).
 */
export function testWranglerConfig(): Record<string, unknown> {
  return wranglerConfig({ ...TEST_MANIFEST, emailIssuer: ISSUER_TEST_MANIFEST.emailIssuer } as Manifest, { adminHyperdriveId: null });
}

/** The admin Hyperdrive id in an existing wrangler.jsonc, only when it was generated for the same Worker. */
export function existingAdminHyperdriveId(path: string, workerName: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\/\/.*\n/u, '')) as { name?: unknown; hyperdrive?: { binding?: unknown; id?: unknown }[] };
    const id = config.hyperdrive?.find((h) => h.binding === 'USAGE_DB')?.id;
    return config.name === workerName && typeof id === 'string' && HYPERDRIVE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function writeWranglerConfig(m: Manifest, hyperdriveArg: string | undefined, dir: string = appDir): { path: string; adminHyperdriveId: string | null } {
  if (!m.admin) throw new Error(`envs/${m.name}.json has no admin block`);
  const path = join(dir, 'wrangler.jsonc');
  const adminHyperdriveId = hyperdriveArg === 'off' ? null : (hyperdriveArg ?? existingAdminHyperdriveId(path, m.admin.workerName));
  const config = wranglerConfig(m, { adminHyperdriveId });
  const header = `// Generated by apps/admin/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(config, null, 2) + '\n');
  return { path, adminHyperdriveId };
}

export function main(argv: string[], opts: { dir?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  const envName = argv.find((x, i) => !x.startsWith('--') && argv[i - 1] !== '--admin-hyperdrive-id');
  if (!envName) {
    console.error('usage: gen-wrangler <env> [--admin-hyperdrive-id <id>|off]');
    process.exit(2);
  }
  const flag = argv.indexOf('--admin-hyperdrive-id');
  const arg = flag >= 0 ? argv[flag + 1] : undefined;
  if (flag >= 0 && (!arg || (arg !== 'off' && !HYPERDRIVE_ID_RE.test(arg)))) throw new Error('--admin-hyperdrive-id needs the admin Hyperdrive config id (32 hex characters; `usage-setup <env> hyperdrive` prints it) or `off`');
  const manifest = (opts.loadManifest ?? loadEnv)(envName);
  const { path, adminHyperdriveId } = writeWranglerConfig(manifest, arg, opts.dir);
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.admin!.workerName})`);
  console.log(adminHyperdriveId ? `feed and watcher: on (USAGE_DB → Hyperdrive ${adminHyperdriveId})` : 'feed and watcher: off (no USAGE_DB binding; pass --admin-hyperdrive-id <id> to turn them on)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
