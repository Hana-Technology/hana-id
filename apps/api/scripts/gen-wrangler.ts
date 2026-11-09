// Generates apps/api/wrangler.jsonc from an environment manifest (envs/<env>.json), plus wrangler.vault.jsonc and
// wrangler.auth.jsonc for the Workers of the two Hana page origins (scripts/pages-wrangler.ts). All three are per env
// and gitignored (they can carry a real D1 id): generate them, never commit them. The API tests use
// wrangler.vitest.jsonc, which vitest.config.ts writes with testWranglerConfig() (also gitignored).
//
//   pnpm --filter @hana-id/api gen <env> [--d1-id <uuid>] [--usage-hyperdrive-id <id>|off] [--dev-vars]
//
// --d1-id      D1 database id (`wrangler d1 create <cloudflare.d1Name>` prints it). Without it, the id already in
//              wrangler.jsonc is kept only when that file was generated for the same D1 database (same
//              `database_name`), else a local-only placeholder is written (fine for `wrangler dev` and tests).
// --d1-name    Rehearsals only (docs/operations.md "Hot DB migration 0006"): point the generated config's D1 binding at a
//              scratch database (its name must contain "rehearsal"; --d1-id required), so `wrangler d1 migrations
//              apply` and the admin CLI (its --d1-name) run on it exactly as they will on the env's database. Run gen
//              again without it afterwards.
// --usage-hyperdrive-id  The usage ledger writer's Hyperdrive config id (`usage-setup <env> hyperdrive` prints it;
//              batch C4): binds USAGE_DB and turns usage capture on. Without the flag, the id already in wrangler.jsonc
//              is kept only when that file was generated for the same Worker and D1 database; `off` drops it.
// --dev-vars   Also write apps/api/.dev.vars (0600, gitignored) from .secrets/<env>/relayer-keys.json (session pool,
//              JSON array of ed25519 secret keys), .secrets/<env>/owner-relayer-keys.json (owner pool, same format) and
//              .secrets/<env>/keys-updater.json ({account_id, public_key, private_key}), as written by
//              scripts/deploy-contract.ts, and the identity token's IDENTITY_SIGNING_KEY and
//              IDENTITY_SUB_KEY from .secrets/<env>/identity-* (scripts/identity-key.ts), when they exist; the signing
//              key must be the manifest's active key, and the offline standby is never written. A KMS env gets the
//              sub key only (no AWS credentials in .dev.vars; a private signing key file there is refused). Never
//              prints secrets.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY_SECRET_FILES, type Manifest, accountIdFields, apiRpcFallbacksOf, customDomainPlacement, emailIssuerUrl, hanaOwnOrigins, isLoopbackHost, loadEnv, p256Thumbprint, repoRoot } from '@hana-id/env';
import { IDENTITY_RATE_LIMITS } from '../src/identity/limits.ts';
import { VAULT_RATE_LIMITS } from '../src/vault/limits.ts';
import { workersDevHost, writePagesWranglerConfigs } from './pages-wrangler.ts';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_D1_ID = '00000000-0000-4000-8000-000000000000';
export const COMPATIBILITY_DATE = '2026-10-01';

/**
 * Batch B's runtime flags, off in every env until their step (docs/batch-b-spec.md, "Order of work"): BLS_PRECHECK
 * only after its CPU time is measured on the Workers Paid plan. (REJECT_PII_ON_SESSIONS is gone: the claim allow-list
 * is always on, D271.)
 */
export const FLAG_DEFAULTS = { BLS_PRECHECK: '0' } as const;

/**
 * The identity token's vars (docs/identity-token-spec.md): its `iss`, the JWKS (public keys only), the signer kind and
 * the kid that signs; for the AWS KMS signer (build step 7, D215) also the active key's ARN, and only that one (the
 * standby, next and previous ARNs stay in the manifest: a switch is a manifest change and a deploy). Empty when the
 * manifest has no `identityToken` (the API then answers 503 identity_unavailable). The AWS credentials are Worker
 * secrets (`identity-key <env> kms-put-aws-key`), never vars.
 */
export function identityVars(m: Manifest): Record<string, string> {
  const t = m.identityToken;
  if (!t) return {};
  const common = { IDENTITY_ISS: t.iss, IDENTITY_PUBLIC_KEYS: JSON.stringify(t.publicKeys), IDENTITY_SIGNER: t.signer.kind };
  if (t.signer.kind === 'aws-kms') return { ...common, IDENTITY_ACTIVE_KID: t.signer.keys.active.kid, IDENTITY_KMS_KEY_ARN: t.signer.keys.active.arn };
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json: a Worker-secret identity signing key is testnet only (D127)`);
  return { ...common, IDENTITY_ACTIVE_KID: t.signer.activeKid };
}

/**
 * Email login's vars (docs/email-login-spec.md "API changes"; manifest `emailIssuer`): the email tokens' `iss` and the
 * issuer's public keys (the keys its JWKS serves, D196), which the API checks email tokens against before relaying them.
 * Empty without the block: every email token is then refused, Google logins are unaffected.
 */
export function emailVars(m: Manifest): Record<string, string> {
  const t = m.emailIssuer;
  if (!t) return {};
  // EMAIL_ISSUER_URL: the vault page's connect-src (the vault calls google-match, build plan batch 8b).
  return { EMAIL_ISS: t.iss, EMAIL_PUBLIC_KEYS: JSON.stringify(t.publicKeys), EMAIL_ISSUER_URL: emailIssuerUrl(m) };
}

/**
 * USAGE_DB's `localConnectionString` (`wrangler dev`): `.invalid` never resolves (RFC 6761), so a local login's usage
 * write fails at connect and is logged, as with Neon down. No credential: the password is a placeholder.
 */
export const LOCAL_USAGE_CONNECTION_STRING = 'postgresql://usage_writer:local-dev@usage-ledger.local.invalid:5432/usage';

/** A Hyperdrive config id (`wrangler hyperdrive create` prints it; not a secret: the credentials stay in the config). */
export const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/u;

/**
 * Where the API Worker is reachable, from `apiUrl` (D404): a loopback URL (`local*` envs) or a `workers.dev` URL
 * (`https://<cloudflare.workerName>.<subdomain>.workers.dev`) add nothing (wrangler's default
 * `workers_dev`, as before); any other host is a Custom Domain on a zone of the env's account (`customDomainPlacement`:
 * `apiUrl` is then a bare https origin, and the Worker has no workers.dev URL).
 */
export function apiPlacement(m: Pick<Manifest, 'apiUrl' | 'cloudflare'>): Record<string, unknown> {
  const url = new URL(m.apiUrl);
  if (isLoopbackHost(url.hostname)) return {};
  if (workersDevHost(url.hostname)) return {};
  return customDomainPlacement('apiUrl', m.apiUrl);
}

/**
 * `usageHyperdriveId`: the usage ledger writer's Hyperdrive config (docs/batch-c-spec.md "Bindings"), bound as
 * `USAGE_DB`. Without it the Worker has no binding and capture is off (logins are unaffected either way).
 */
export function wranglerConfig(m: Manifest, d1Id: string, opts: { usageHyperdriveId?: string } = {}): Record<string, unknown> {
  if (opts.usageHyperdriveId !== undefined && !HYPERDRIVE_ID_RE.test(opts.usageHyperdriveId)) throw new Error('A Hyperdrive id is 32 lowercase hex characters');
  // The API checks callers against both Hana origins (and the login relay serves only them).
  if (!m.vaultOrigin || !m.authOrigin) throw new Error(`envs/${m.name}.json needs vaultOrigin and authOrigin`);
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: m.cloudflare.workerName,
    // The env's Cloudflare account, when the manifest names it (D404).
    ...accountIdFields(m.cloudflare.accountId, 'cloudflare.accountId'),
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    ...apiPlacement(m),
    // @near-js/crypto imports secp256k1 (CJS/native, unused: relayer keys are ed25519).
    alias: { secp256k1: './src/shims/secp256k1.ts' },
    // Workers Logs keeps the Worker's own JSON log lines (src/log.ts: no tokens, keys, signatures or relay ids), but
    // not the platform's per-request invocation records, which carry the request URL: the login relay's URL path is
    // `/v1/login-relay/<relayId>`, a live capability for its 120 s slot (security sweep APIV-3, D100).
    observability: { enabled: true, logs: { invocation_logs: false } },
    // Run next to D1 and the Durable Objects rather than where the request lands: workers.dev routing from
    // Malaysia lands many requests in Europe (MRS), and each serial D1 query then crosses continents.
    // A fixed region next to D1 (APAC) and the Durable Objects: Smart Placement only moves requests from locations it
    // has learned, so requests landing in Paris or Marseille kept running there after each deploy.
    placement: { region: 'aws:ap-east-1' },
    vars: {
      NEAR_RPC: m.rpc,
      ...(m.rpcFallback ? { NEAR_RPC_FALLBACK: m.rpcFallback } : {}),
      // The API's own failover list after NEAR_RPC (D435): apiRpcFallbacks, else rpcFallback; none, no var.
      ...(apiRpcFallbacksOf(m).length ? { NEAR_RPC_FALLBACKS: JSON.stringify(apiRpcFallbacksOf(m)) } : {}),
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
      // Batch C (docs/batch-c-spec.md "Bindings"): the guarded-change delay, the network for the production origin
      // rules, and every Hana origin, which no app may list as its own. Read from batch C3 on.
      APP_CHANGE_DELAY_MS: String(m.appChangeDelayMs),
      NETWORK: m.network,
      REFUSED_ORIGINS: JSON.stringify(hanaOwnOrigins(m)),
      // The logo origin for `GET /v1/app`'s logoUrl (batch C11); only with the dashboard blocks.
      ...(m.files ? { FILES_ORIGIN: m.files.origin } : {}),
      // The partner identity token (its secrets come from scripts/identity-key.ts).
      ...identityVars(m),
      // Email login: the email issuer's iss and public keys (no secret).
      ...emailVars(m),
    },
    d1_databases: [{ binding: 'DB', database_name: m.cloudflare.d1Name, database_id: d1Id, migrations_dir: 'migrations' }],
    // The usage ledger's writer (role usage_writer, caching disabled on the config), batch C4; optional. `wrangler dev`
    // needs a local connection string for a Hyperdrive binding: an unroutable placeholder, so local capture fails open
    // (usage_write_failed in the dev log) and never reaches a real ledger.
    ...(opts.usageHyperdriveId ? { hyperdrive: [{ binding: 'USAGE_DB', id: opts.usageHyperdriveId, localConnectionString: LOCAL_USAGE_CONNECTION_STRING }] } : {}),
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
    // The vault's per-IP and per-share flood limits and the identity token's per-session one, counted where the
    // request runs with no network hop (D95).
    ratelimits: [...VAULT_RATE_LIMITS, ...IDENTITY_RATE_LIMITS].map((r) => ({ name: r.name, namespace_id: r.namespace_id, simple: { ...r.simple } })),
    // Every 15 min, one trigger (the free plan allows 5 per account): every run syncs Google's JWKS with hana-signer
    // (proposals and matured executions, src/issuer-keys.ts) and records the JWKS kids; the run at :00 also does
    // vault maintenance (src/index.ts isHourlyRun).
    triggers: { crons: ['*/15 * * * *'] },
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
  appChangeDelayMs: 60_000,
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-test', d1Name: 'hana-id-test' },
};

/** The API tests' wrangler config: the generator's output for TEST_MANIFEST, with the local placeholder D1 id. */
export function testWranglerConfig(): Record<string, unknown> {
  // Local only: no Custom Domain route for the placeholder apiUrl (vitest's workers pool never deploys).
  const { routes: _r, workers_dev: _w, preview_urls: _p, ...config } = wranglerConfig(TEST_MANIFEST, LOCAL_D1_ID);
  return config;
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
export interface IdentityDevSecrets {
  /** The key that signs now (`identity-signing-key.json`). The standby stays offline, never in .dev.vars (D177). */
  signingKey?: unknown;
  subKey?: string;
}

const COORD_RE = /^[A-Za-z0-9_-]{43}$/u;
const SUB_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;

/** A P-256 private JWK as a single-quoted dotenv value (its JSON has no quote of the single kind). */
function identityKeyLine(name: 'IDENTITY_SIGNING_KEY', file: string, jwk: unknown): { line: string; kid: string } {
  const k = jwk as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown; d?: unknown } | null;
  if (!k || k.kty !== 'EC' || k.crv !== 'P-256' || ![k.x, k.y, k.d].every((v) => typeof v === 'string' && COORD_RE.test(v))) {
    throw new Error(`${file} must be a P-256 private JWK {kty: "EC", crv: "P-256", x, y, d}`);
  }
  const value = JSON.stringify({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y, d: k.d });
  return { line: `${name}='${value}'`, kid: p256Thumbprint({ kty: 'EC', crv: 'P-256', x: k.x as string, y: k.y as string }) };
}

/**
 * The identity token's .dev.vars lines: the key that signs now and the sub key. The signing key must be the manifest's
 * active key (`identityToken.signer.activeKid`, in `publicKeys`): a key the JWKS doesn't publish would sign tokens no
 * partner can verify. The standby is never written: it stays off the Worker until a switch (D177).
 */
export function identityDevVarsLines(m: Pick<Manifest, 'name' | 'identityToken'>, secrets: IdentityDevSecrets): string[] {
  const lines: string[] = [];
  if (secrets.signingKey !== undefined) {
    const { line, kid } = identityKeyLine('IDENTITY_SIGNING_KEY', IDENTITY_SECRET_FILES.signingKey, secrets.signingKey);
    const t = m.identityToken;
    if (!t) throw new Error(`.secrets/${m.name} has an identity signing key but envs/${m.name}.json has no identityToken (run scripts/identity-key.ts ${m.name} init)`);
    // A KMS env signs in KMS only: a private key file next to it is a leftover to remove, never a key to run with.
    if (t.signer.kind === 'aws-kms') throw new Error(`.secrets/${m.name}/${IDENTITY_SECRET_FILES.signingKey} exists but envs/${m.name}.json signs with AWS KMS: move the file out of .secrets/${m.name}`);
    if (!t.publicKeys.some((k) => k.kid === kid)) throw new Error(`The identity signing key in .secrets/${m.name} doesn't match envs/${m.name}.json identityToken.publicKeys`);
    if (t.signer.kind === 'worker-secret' && kid !== t.signer.activeKid) throw new Error(`The identity signing key in .secrets/${m.name} doesn't have the active kid ${t.signer.activeKid}`);
    lines.push(line);
  }
  if (secrets.subKey !== undefined) {
    const v = secrets.subKey.trim();
    if (!SUB_KEY_RE.test(v) || Buffer.from(v, 'base64').length !== 32) throw new Error(`${IDENTITY_SECRET_FILES.subKey} must be base64 of 32 bytes`);
    lines.push(`IDENTITY_SUB_KEY='${v}'`);
  }
  return lines;
}

export function devVarsContent(secrets: { relayerKeys?: unknown; ownerRelayerKeys?: unknown; keysUpdaterKey?: string; identity?: string[] }): string {
  const lines: string[] = [];
  if (secrets.relayerKeys !== undefined) lines.push(poolLine('RELAYER_KEYS', 'relayer-keys.json', secrets.relayerKeys));
  if (secrets.ownerRelayerKeys !== undefined) lines.push(poolLine('OWNER_RELAYER_KEYS', 'owner-relayer-keys.json', secrets.ownerRelayerKeys));
  if (secrets.keysUpdaterKey !== undefined) {
    if (!SECRET_KEY_RE.test(secrets.keysUpdaterKey)) throw new Error('keys-updater.json has no ed25519 private_key');
    lines.push(`KEYS_UPDATER_KEY=${secrets.keysUpdaterKey}`);
  }
  lines.push(...(secrets.identity ?? []));
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * A secret JSON file from .secrets/, or undefined when absent, as scripts/lib/secrets.ts reads them (OPER-5): refused
 * when group or others can read it, and a parse error names the file only (Node's SyntaxError quotes the text around
 * the error, i.e. the end of a key).
 */
function readSecretJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} has mode ${mode.toString(8)}; secret files must be 0600 (chmod 600 ${path})`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`${path} is not valid JSON (check for a missing or trailing comma)`);
  }
}

/** A secret text file from .secrets/, or undefined when absent (0600 enforced as for the JSON ones). */
function readSecretTextIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} has mode ${mode.toString(8)}; secret files must be 0600 (chmod 600 ${path})`);
  return readFileSync(path, 'utf8');
}

/** Writes <apiDir>/.dev.vars (0600) from <root>/.secrets/<env>/. Returns the number of secrets; never their values. */
export function writeDevVars(envName: string, root: string = repoRoot, dir: string = apiDir, manifest?: Pick<Manifest, 'name' | 'identityToken'>): { path: string; count: number } {
  const secrets = join(root, '.secrets', envName);
  const relayerKeys = readSecretJsonIfExists(join(secrets, 'relayer-keys.json'));
  const ownerRelayerKeys = readSecretJsonIfExists(join(secrets, 'owner-relayer-keys.json'));
  const updaterFile = join(secrets, 'keys-updater.json');
  let keysUpdaterKey: string | undefined;
  const updater = readSecretJsonIfExists(updaterFile) as { private_key?: unknown } | undefined;
  if (updater !== undefined) {
    if (typeof updater?.private_key !== 'string') throw new Error(`${updaterFile} has no ed25519 private_key`);
    keysUpdaterKey = updater.private_key;
  }
  const identity = identityDevVarsLines(manifest ?? { name: envName, identityToken: undefined }, {
    signingKey: readSecretJsonIfExists(join(secrets, IDENTITY_SECRET_FILES.signingKey)),
    subKey: readSecretTextIfExists(join(secrets, IDENTITY_SECRET_FILES.subKey)),
  });
  const content = devVarsContent({ relayerKeys, ownerRelayerKeys, keysUpdaterKey, identity });
  const path = join(dir, '.dev.vars');
  // A fresh 0600 file renamed over the old one: an existing world-readable .dev.vars never holds the new secrets.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { path, count: [relayerKeys, ownerRelayerKeys, keysUpdaterKey].filter((v) => v !== undefined).length + identity.length };
}

/**
 * The usage writer's Hyperdrive id in an existing wrangler.jsonc, but only when it was generated for the same Worker
 * (`name`) and D1 database: an id left over from another environment must never bind this env's API to that ledger.
 */
export function existingUsageHyperdriveId(path: string, m: Pick<Manifest, 'cloudflare'>): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  let config: { name?: unknown; d1_databases?: { database_name?: unknown }[]; hyperdrive?: { binding?: unknown; id?: unknown }[] };
  try {
    config = JSON.parse(text.replace(/^\/\/.*\n/u, '')) as typeof config;
  } catch {
    return null;
  }
  if (config.name !== m.cloudflare.workerName || config.d1_databases?.[0]?.database_name !== m.cloudflare.d1Name) return null;
  const id = config.hyperdrive?.find((h) => h.binding === 'USAGE_DB')?.id;
  return typeof id === 'string' && HYPERDRIVE_ID_RE.test(id) ? id : null;
}

/**
 * Writes <dir>/wrangler.jsonc for the env. `usageArg`: a Hyperdrive id, `off` (no binding), or undefined (keep the
 * existing file's, for the same Worker and database).
 */
export function writeWranglerConfig(manifest: Manifest, d1Arg: string | undefined, dir: string = apiDir, usageArg?: string): { path: string; d1Id: string; usageHyperdriveId: string | null } {
  const path = join(dir, 'wrangler.jsonc');
  const d1Id = d1Arg ?? existingD1Id(path, manifest.cloudflare.d1Name) ?? LOCAL_D1_ID;
  const usageHyperdriveId = usageArg === 'off' ? null : (usageArg ?? existingUsageHyperdriveId(path, manifest));
  const header = `// Generated by apps/api/scripts/gen-wrangler.ts from envs/${manifest.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(wranglerConfig(manifest, d1Id, { usageHyperdriveId: usageHyperdriveId ?? undefined }), null, 2) + '\n');
  return { path, d1Id, usageHyperdriveId };
}

/** `root`/`dir` override the repo root (for .secrets/) and the output directory; `loadManifest` the manifest (tests). */
export function main(argv: string[], opts: { root?: string; dir?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  const valueFlags = ['--d1-id', '--d1-name', '--usage-hyperdrive-id'];
  const envName = argv.find((a, i) => !a.startsWith('--') && !valueFlags.includes(argv[i - 1] ?? ''));
  if (!envName) {
    console.error('usage: gen-wrangler <env> [--d1-id <uuid>] [--d1-name <rehearsal db> --d1-id <uuid>] [--usage-hyperdrive-id <id>|off] [--dev-vars]');
    process.exit(2);
  }
  const usageFlag = argv.indexOf('--usage-hyperdrive-id');
  const usageArg = usageFlag >= 0 ? argv[usageFlag + 1] : undefined;
  if (usageFlag >= 0 && (!usageArg || (usageArg !== 'off' && !HYPERDRIVE_ID_RE.test(usageArg)))) {
    throw new Error('--usage-hyperdrive-id needs the writer Hyperdrive config id (32 hex characters; `usage-setup <env> hyperdrive` prints it) or `off`');
  }
  const idFlag = argv.indexOf('--d1-id');
  const d1Arg = idFlag >= 0 ? argv[idFlag + 1] : undefined;
  if (idFlag >= 0 && (!d1Arg || !/^[0-9a-f-]{36}$/u.test(d1Arg))) throw new Error('--d1-id needs a D1 database uuid');

  const nameFlag = argv.indexOf('--d1-name');
  const d1Name = nameFlag >= 0 ? argv[nameFlag + 1] : undefined;
  if (nameFlag >= 0 && (!d1Name || !/^[a-z0-9-]{1,64}$/u.test(d1Name) || !d1Name.includes('rehearsal'))) {
    throw new Error('--d1-name is for rehearsal databases: a D1 name containing "rehearsal"');
  }
  if (d1Name && !d1Arg) throw new Error("--d1-name needs --d1-id (the scratch database's uuid)");
  const loaded = (opts.loadManifest ?? loadEnv)(envName);
  const manifest: Manifest = d1Name ? { ...loaded, cloudflare: { ...loaded.cloudflare, d1Name } } : loaded;
  if (d1Name) console.log(`The D1 binding points at the rehearsal database ${d1Name}: run gen ${loaded.name} again (with the env's own --d1-id) before any deploy or admin command on the env`);
  // The page Workers first: they refuse more envs (workers.dev outside dev envs), and a refusal then writes nothing.
  const pages = writePagesWranglerConfigs(manifest, COMPATIBILITY_DATE, opts.dir);
  const { path, d1Id, usageHyperdriveId } = writeWranglerConfig(manifest, d1Arg, opts.dir, usageArg);
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.cloudflare.workerName}${d1Id === LOCAL_D1_ID ? ', local D1 placeholder id' : ''})`);
  console.log(usageHyperdriveId ? `usage capture: on (USAGE_DB → Hyperdrive ${usageHyperdriveId})` : 'usage capture: off (no USAGE_DB binding; pass --usage-hyperdrive-id <id> to turn it on)');
  for (const p of pages) console.log(`wrote ${p}`);

  if (argv.includes('--dev-vars')) {
    const { path: devVars, count } = writeDevVars(manifest.name, opts.root, opts.dir, manifest);
    console.log(`wrote ${devVars} (${count} secret(s), values not shown)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
