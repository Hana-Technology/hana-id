// Generates apps/watchdog/wrangler.jsonc (gitignored: it can carry a real D1 id and the watchdog's Cloudflare
// account id) from the `watchdog` block of envs/<env>.json. The Worker deploys to that account only (`account_id`),
// never the API's (D86). The tests use wrangler.vitest.jsonc, written by vitest.config.ts with testWranglerConfig().
//
//   pnpm --filter @hana-id/watchdog gen <env> [--d1-id <uuid>] [--dev-vars]
//
// --d1-id     D1 database id (`wrangler d1 create <watchdog.cloudflare.d1Name>` on the watchdog's account prints it).
//             Without it, the id already in wrangler.jsonc is kept only when that file names the same database.
// --dev-vars  Also write apps/watchdog/.dev.vars (0600, gitignored) from .secrets/<env>/watchdog-secrets.json, for
//             `wrangler dev`. Never prints a secret.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, accountIdFields, customDomainPlacement, emailJwksUrl, envAlertLabel, loadEnv, repoRoot } from '@hana-id/env';
import { readWatchdogSecrets, SECRET_FILE } from './secrets.ts';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_D1_ID = '00000000-0000-4000-8000-000000000000';
export const COMPATIBILITY_DATE = '2026-10-01';
/** Every 5 min (W in the spec's delay formula). */
export const CRON = '*/5 * * * *';

/**
 * The email pins (`watchdog.pinnedIssuerKeys.email`) as `EMAIL_PINS` (JSON `{required, signers}`) and Hana's email
 * JWKS URL (`jwksUrl`, else `{issuer URL}/v1/email/jwks.json`: `emailIssuer.url` when the issuer has its own, D230, else
 * the API's URL). No pins: neither var, and the Worker pins nothing.
 */
export function emailVars(m: Manifest): Record<string, string> {
  const pins = m.watchdog?.pinnedIssuerKeys?.email;
  if (!pins) return {};
  const jwksUrl = pins.jwksUrl ?? (m.apiUrl ? emailJwksUrl(m) : undefined);
  return { EMAIL_PINS: JSON.stringify({ required: pins.required, signers: pins.signers }), ...(jwksUrl ? { EMAIL_JWKS_URL: jwksUrl } : {}) };
}

/**
 * The partner identity token's watchdog check (D210): `IDENTITY_ISS` (the manifest's `identityToken.iss`; the JWKS is
 * `{iss}/jwks.json`, the discovery document `{iss}/.well-known/openid-configuration`) and `IDENTITY_PINS` (JSON array
 * of `watchdog.pinnedIdentityKeys`). No `identityToken`: no `IDENTITY_ISS`, and the JWKS check is skipped; no pins: no
 * `IDENTITY_PINS`, and every published identity key is unpinned.
 */
export function identityVars(m: Manifest): Record<string, string> {
  const pins = m.watchdog?.pinnedIdentityKeys;
  return { ...(m.identityToken ? { IDENTITY_ISS: m.identityToken.iss } : {}), ...(pins ? { IDENTITY_PINS: JSON.stringify(pins) } : {}) };
}

/** `env`: where CLOUDFLARE_ACCOUNT_ID is read (the tests' config passes none). */
export function wranglerConfig(m: Manifest, d1Id: string, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, unknown> {
  const w = m.watchdog;
  if (!w) throw new Error(`envs/${m.name}.json has no watchdog block`);
  if (w.cloudflare.accountId === 'UNSET') throw new Error(`envs/${m.name}.json watchdog.cloudflare.accountId is UNSET: set the watchdog's own Cloudflare account id first`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: w.cloudflare.workerName,
    // Its own Cloudflare account (D86): `wrangler deploy` refuses to deploy anywhere else (and gen refuses a
    // CLOUDFLARE_ACCOUNT_ID naming another account, D404).
    ...accountIdFields(w.cloudflare.accountId, 'watchdog.cloudflare.accountId', env),
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    // @near-js/crypto imports secp256k1 (CJS/native, unused: the watchdog key is ed25519).
    alias: { secp256k1: './src/shims/secp256k1.ts' },
    // Its workers.dev URL, or a Custom Domain on a zone of its own account when `watchdog.url` names another host (D404).
    ...(w.url !== undefined && !new URL(w.url).hostname.endsWith('.workers.dev') ? customDomainPlacement('watchdog.url', w.url) : { workers_dev: true, preview_urls: false }),
    observability: { enabled: true },
    vars: {
      ENV_NAME: m.name,
      // The alert titles' label (D419): `[SANDBOX]` etc. on testnet, none on a production network (then no var at all).
      ...(envAlertLabel(m) ? { ENV_LABEL: envAlertLabel(m) } : {}),
      NEAR_NETWORK: m.network,
      NEAR_RPC: m.rpc,
      ...(m.rpcFallback ? { NEAR_RPC_FALLBACK: m.rpcFallback } : {}),
      SIGNER_ACCOUNT: m.signer,
      WATCHDOG_ACCOUNT: w.account,
      // Relayer funds check (read-only): the account and, when the manifest overrides them, the thresholds.
      RELAYER_ACCOUNT: m.relayer,
      ...(w.relayerFunds ? { RELAYER_FUNDS: JSON.stringify(w.relayerFunds) } : {}),
      PAGER_PROVIDER: w.pager,
      ALERT_EMAILS: w.alertEmails.join(','),
      ALERT_FROM: w.alertFrom,
      DIGEST_HOUR_UTC: String(w.digestHourUtc ?? 0),
      ...emailVars(m),
      ...identityVars(m),
    },
    d1_databases: [{ binding: 'DB', database_name: w.cloudflare.d1Name, database_id: d1Id, migrations_dir: 'migrations' }],
    triggers: { crons: [CRON] },
  };
}

/** The fixed manifest the Worker tests' config comes from: no real account, so editing envs/*.json never changes the tests. */
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
  rpcFallback: 'https://rpc.fallback-provider.invalid',
  apiUrl: 'https://api.test',
  changeDelayMs: 60_000,
  appChangeDelayMs: 60_000,
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-test', d1Name: 'hana-id-test' },
  watchdogs: ['watchdog.test.near'],
  watchdog: {
    account: 'watchdog.test.near',
    cloudflare: { accountId: '0'.repeat(32), workerName: 'hana-id-watchdog-test', d1Name: 'hana-id-watchdog-test' },
    alertEmails: ['founder-a@example.com', 'founder-b@example.com'],
    alertFrom: 'alerts@notify.example.com',
    pager: 'ntfy',
  },
};

export function testWranglerConfig(): Record<string, unknown> {
  return wranglerConfig(TEST_MANIFEST, LOCAL_D1_ID, {});
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
  if (!m.watchdog) throw new Error(`envs/${m.name}.json has no watchdog block`);
  const path = join(dir, 'wrangler.jsonc');
  const d1Id = d1Arg ?? existingD1Id(path, m.watchdog.cloudflare.d1Name) ?? LOCAL_D1_ID;
  const config = wranglerConfig(m, d1Id);
  const header = `// Generated by apps/watchdog/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(config, null, 2) + '\n');
  return { path, d1Id };
}

/** dotenv lines; every value single-quoted (taken literally by wrangler's dotenv). */
export function devVarsContent(secrets: Record<string, string>): string {
  const lines = Object.entries(secrets).map(([k, v]) => {
    if (v.includes("'") || /[\r\n]/u.test(v)) throw new Error(`${k} contains a quote or a newline`);
    return `${k}='${v}'`;
  });
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function writeDevVars(envName: string, root: string = repoRoot, dir: string = appDir): { path: string; count: number } {
  const secrets = readWatchdogSecrets(envName, root) ?? {};
  const path = join(dir, '.dev.vars');
  writeFileSync(path, devVarsContent(secrets), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, count: Object.keys(secrets).length };
}

export function main(argv: string[], opts: { root?: string; dir?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  const envName = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--d1-id');
  if (!envName) {
    console.error('usage: gen-wrangler <env> [--d1-id <uuid>] [--dev-vars]');
    process.exit(2);
  }
  const idFlag = argv.indexOf('--d1-id');
  const d1Arg = idFlag >= 0 ? argv[idFlag + 1] : undefined;
  if (idFlag >= 0 && (!d1Arg || !/^[0-9a-f-]{36}$/u.test(d1Arg))) throw new Error('--d1-id needs a D1 database uuid');
  const manifest = (opts.loadManifest ?? loadEnv)(envName);
  const { path, d1Id } = writeWranglerConfig(manifest, d1Arg, opts.dir);
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.watchdog?.cloudflare.workerName}${d1Id === LOCAL_D1_ID ? ', local D1 placeholder id' : ''})`);
  if (argv.includes('--dev-vars')) {
    const { path: devVars, count } = writeDevVars(manifest.name, opts.root, opts.dir);
    console.log(`wrote ${devVars} (${count} secret(s) from .secrets/${manifest.name}/${SECRET_FILE}, values not shown)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
