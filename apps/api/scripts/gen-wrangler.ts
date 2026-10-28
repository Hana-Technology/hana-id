// Generates apps/api/wrangler.jsonc from an environment manifest (envs/<env>.json), plus wrangler.vault.jsonc and
// wrangler.auth.jsonc for the Workers of the two Hana page origins (scripts/pages-wrangler.ts). All three are per env
// and gitignored (they can carry a real D1 id): generate them, never commit them. The API tests use
// wrangler.vitest.jsonc, which vitest.config.ts writes with testWranglerConfig() (also gitignored).
//
//   pnpm --filter @hana-id/api gen <env> [--d1-id <uuid>] [--dev-vars]
//
// --d1-id      D1 database id (`wrangler d1 create <cloudflare.d1Name>` prints it). Without it, the id already in
//              wrangler.jsonc is kept only when that file was generated for the same D1 database (same
//              `database_name`), else a local-only placeholder is written (fine for `wrangler dev` and tests).
// --dev-vars   Also write apps/api/.dev.vars (0600, gitignored) from .secrets/<env>/relayer-keys.json (session pool,
//              JSON array of ed25519 secret keys), .secrets/<env>/owner-relayer-keys.json (owner pool, same format) and
//              .secrets/<env>/keys-updater.json ({account_id, public_key, private_key}), as written by
//              scripts/deploy-contract.ts, when they exist. Never prints secrets.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { writePagesWranglerConfigs } from './pages-wrangler.ts';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_D1_ID = '00000000-0000-4000-8000-000000000000';
export const COMPATIBILITY_DATE = '2026-10-01';

/**
 * Batch B's runtime flags, off in every env until their step (docs/batch-b-spec.md, "Order of work"):
 * REJECT_PII_ON_SESSIONS once apps/smoke is on the vault, BLS_PRECHECK only after its CPU time is measured on the
 * Workers Paid plan.
 */
export const FLAG_DEFAULTS = { BLS_PRECHECK: '0', REJECT_PII_ON_SESSIONS: '0' } as const;

export function wranglerConfig(m: Manifest, d1Id: string): Record<string, unknown> {
  // The API checks callers against both Hana origins (and the login relay serves only them).
  if (!m.vaultOrigin || !m.authOrigin) throw new Error(`envs/${m.name}.json needs vaultOrigin and authOrigin`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: m.cloudflare.workerName,
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    // @near-js/crypto imports secp256k1 (CJS/native, unused: relayer keys are ed25519).
    alias: { secp256k1: './src/shims/secp256k1.ts' },
    observability: { enabled: true },
    vars: {
      NEAR_RPC: m.rpc,
      ...(m.rpcFallback ? { NEAR_RPC_FALLBACK: m.rpcFallback } : {}),
      SIGNER_ACCOUNT: m.signer,
      RELAYER_ACCOUNT: m.relayer,
      ENV_NAME: m.name,
      MPC_ACCOUNT: m.mpc,
      VAULT_ORIGIN: m.vaultOrigin,
      AUTH_ORIGIN: m.authOrigin,
      // The API's own URL, for the vault page's CSP connect-src. VAULT_KEK is a secret.
      API_URL: m.apiUrl,
      ...FLAG_DEFAULTS,
      ...(m.cloudflare.durableObjectLocation ? { DO_LOCATION_HINT: m.cloudflare.durableObjectLocation } : {}),
    },
    d1_databases: [{ binding: 'DB', database_name: m.cloudflare.d1Name, database_id: d1Id, migrations_dir: 'migrations' }],
    durable_objects: {
      bindings: [
        { name: 'RELAYER_KEY', class_name: 'RelayerKey' },
        { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
        { name: 'LOGIN_RELAY', class_name: 'LoginRelay' },
      ],
    },
    migrations: [
      { tag: 'v1', new_sqlite_classes: ['RelayerKey', 'RateLimiter'] },
      { tag: 'v2', new_sqlite_classes: ['LoginRelay'] },
    ],
    // Hourly: sync Google's JWKS into hana-signer.
    triggers: { crons: ['0 * * * *'] },
  };
}

/**
 * The fixed manifest the API tests' wrangler config is generated from: no real account, origin or D1 id, and none of
 * an env's optional settings (such as a Durable Object location hint), so editing envs/*.json never changes the tests.
 * Vars here are placeholders; vitest.config.ts sets the bindings the tests use.
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
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-test', d1Name: 'hana-id-test' },
};

/** The API tests' wrangler config: the generator's output for TEST_MANIFEST, with the local placeholder D1 id. */
export function testWranglerConfig(): Record<string, unknown> {
  return wranglerConfig(TEST_MANIFEST, LOCAL_D1_ID);
}

/**
 * The D1 id in an existing wrangler.jsonc, but only when it was generated for the same database (`d1Name`): an id
 * left over from another environment must never be paired with this env's database name.
 */
export function existingD1Id(path: string, d1Name: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const id = /"database_id"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  const name = /"database_name"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  return id && id !== LOCAL_D1_ID && name === d1Name ? id : null;
}

const SECRET_KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/u;

/** A pool's keys as a single-quoted dotenv value (JSON array of ed25519 keys; base58 never contains a quote). */
function poolLine(name: 'RELAYER_KEYS' | 'OWNER_RELAYER_KEYS', file: string, keys: unknown): string {
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && SECRET_KEY_RE.test(k))) {
    throw new Error(`${file} must be a non-empty JSON array of ed25519:<base58> secret keys`);
  }
  return `${name}='${JSON.stringify(keys)}'`;
}

/**
 * .dev.vars content (dotenv syntax, as wrangler parses it). RELAYER_KEYS and OWNER_RELAYER_KEYS are single-quoted:
 * dotenv takes single-quoted values literally, whereas inside double quotes it does not unescape `\"`, so a JSON
 * string there would not parse.
 */
export function devVarsContent(secrets: { relayerKeys?: unknown; ownerRelayerKeys?: unknown; keysUpdaterKey?: string }): string {
  const lines: string[] = [];
  if (secrets.relayerKeys !== undefined) lines.push(poolLine('RELAYER_KEYS', 'relayer-keys.json', secrets.relayerKeys));
  if (secrets.ownerRelayerKeys !== undefined) lines.push(poolLine('OWNER_RELAYER_KEYS', 'owner-relayer-keys.json', secrets.ownerRelayerKeys));
  if (secrets.keysUpdaterKey !== undefined) {
    if (!SECRET_KEY_RE.test(secrets.keysUpdaterKey)) throw new Error('keys-updater.json has no ed25519 private_key');
    lines.push(`KEYS_UPDATER_KEY=${secrets.keysUpdaterKey}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

const readJsonIfExists = (path: string): unknown => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined);

/** Writes <apiDir>/.dev.vars (0600) from <root>/.secrets/<env>/. Returns the number of secrets; never their values. */
export function writeDevVars(envName: string, root: string = repoRoot, dir: string = apiDir): { path: string; count: number } {
  const secrets = join(root, '.secrets', envName);
  const relayerKeys = readJsonIfExists(join(secrets, 'relayer-keys.json'));
  const ownerRelayerKeys = readJsonIfExists(join(secrets, 'owner-relayer-keys.json'));
  const updaterFile = join(secrets, 'keys-updater.json');
  let keysUpdaterKey: string | undefined;
  if (existsSync(updaterFile)) {
    const { private_key: key } = JSON.parse(readFileSync(updaterFile, 'utf8')) as { private_key?: unknown };
    if (typeof key !== 'string') throw new Error(`${updaterFile} has no ed25519 private_key`);
    keysUpdaterKey = key;
  }
  const content = devVarsContent({ relayerKeys, ownerRelayerKeys, keysUpdaterKey });
  const path = join(dir, '.dev.vars');
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, count: [relayerKeys, ownerRelayerKeys, keysUpdaterKey].filter((v) => v !== undefined).length };
}

/** Writes <dir>/wrangler.jsonc for the env. */
export function writeWranglerConfig(manifest: Manifest, d1Arg: string | undefined, dir: string = apiDir): { path: string; d1Id: string } {
  const path = join(dir, 'wrangler.jsonc');
  const d1Id = d1Arg ?? existingD1Id(path, manifest.cloudflare.d1Name) ?? LOCAL_D1_ID;
  const header = `// Generated by apps/api/scripts/gen-wrangler.ts from envs/${manifest.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(wranglerConfig(manifest, d1Id), null, 2) + '\n');
  return { path, d1Id };
}

/** `root`/`dir` override the repo root (for .secrets/) and the output directory; `loadManifest` the manifest (tests). */
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
  // The page Workers first: they refuse more envs (workers.dev outside dev envs), and a refusal then writes nothing.
  const pages = writePagesWranglerConfigs(manifest, COMPATIBILITY_DATE, opts.dir);
  const { path, d1Id } = writeWranglerConfig(manifest, d1Arg, opts.dir);
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.cloudflare.workerName}${d1Id === LOCAL_D1_ID ? ', local D1 placeholder id' : ''})`);
  for (const p of pages) console.log(`wrote ${p}`);

  if (argv.includes('--dev-vars')) {
    const { path: devVars, count } = writeDevVars(manifest.name, opts.root, opts.dir);
    console.log(`wrote ${devVars} (${count} secret(s), values not shown)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
