// Generates apps/email-issuer/wrangler.jsonc (gitignored: it carries real D1 ids) from the `emailIssuer` block of
// envs/<env>.json. The tests use wrangler.vitest.jsonc, written by vitest.config.ts with testWranglerConfig().
//
//   pnpm --filter @hana-id/email-issuer gen <env> [--d1-id <uuid>] [--dev-vars]
//
// --d1-id      the issuer's own D1 id (`wrangler d1 create <emailIssuer.cloudflare.d1Name>` prints it). Without it,
//              an id already in wrangler.jsonc is kept only when that file names the same database.
//
// The issuer has no binding to the API's D1: it reads apps through the API Worker's read-only `IssuerRpc` entrypoint
// (service binding `API`, D434), so the old `--app-d1-id` is refused with a pointer here.
// --dev-vars   also write apps/email-issuer/.dev.vars (0600, gitignored) from .secrets/<env>/ (scripts/email-issuer.ts
//              init), for `wrangler dev`. Never prints a secret.
//
// Refuses: an env without `emailIssuer`; a Worker-secret signer outside testnet (mainnet keys live in KMS, D121); the
// `aws-kms` signer until build plan batch 10 wires it; the outbox sender outside `local*` envs; an env without
// vaultOrigin/authOrigin (the CORS origins).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL_ISSUER_SECRET_FILES, IDENTITY_SECRET_FILES, identitySealKeyId, type Manifest, accountIdFields, customDomainPlacement, envAlertLabel, isLocalEnv, loadEnv, repoRoot, rsaJwkThumbprint } from '@hana-id/env';
import { assertPrivate, secretsDir } from '../../../scripts/lib/secrets.ts';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_D1_ID = '00000000-0000-4000-8000-000000000000';
export const COMPATIBILITY_DATE = '2026-10-01';

/**
 * Where the issuer is reachable (D230, D404): its own `workers.dev` URL when `emailIssuer.url` is one; a Custom Domain
 * when `emailIssuer.url` is any other https origin (a dev env on custom domains, e.g. `https://email.id-dev.…`); with
 * no `url`, neither: it is reached through a route `<api host>/v1/email/*` on the API's zone, added by hand
 * (docs/operations.md "Email issuer" step 7), and a workers.dev URL beside the route would be a second way in, around
 * Access and the zone's rules.
 */
export function issuerPlacement(url: string | undefined): Record<string, unknown> {
  if (url !== undefined && /\.workers\.dev$/u.test(new URL(url).hostname)) return { workers_dev: true, preview_urls: false };
  if (url !== undefined) return customDomainPlacement('emailIssuer.url', url);
  return { workers_dev: false, preview_urls: false };
}

export function wranglerConfig(m: Manifest, d1Id: string): Record<string, unknown> {
  const t = m.emailIssuer;
  if (!t) throw new Error(`envs/${m.name}.json has no emailIssuer block (run scripts/email-issuer.ts ${m.name} init)`);
  if (!m.vaultOrigin || !m.authOrigin) throw new Error(`envs/${m.name}.json needs vaultOrigin and authOrigin (the issuer's CORS origins)`);
  if (t.signer.kind === 'worker-secret' && m.network !== 'testnet') throw new Error(`envs/${m.name}.json: a Worker-secret email signing key is testnet only (D121)`);
  if (t.signer.kind !== 'worker-secret') throw new Error(`envs/${m.name}.json: emailIssuer.signer.kind "${t.signer.kind}" is not wired yet (build plan batch 10)`);
  if (t.sender === 'outbox' && !isLocalEnv(m.name)) throw new Error(`envs/${m.name}.json: the outbox sender is for local* envs only`);
  const outbox = t.sender === 'outbox';
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: t.cloudflare.workerName,
    // The env's account (a service binding reaches only a Worker on its own account: it lives beside the API), D404.
    ...accountIdFields(m.cloudflare.accountId, 'cloudflare.accountId'),
    main: 'src/index.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    // No platform invocation logs (URLs and headers); the Worker's own lines carry no address, code, sub or token.
    observability: { enabled: true, logs: { invocation_logs: false } },
    // Next to the API, its D1 and (before mainnet) KMS in ap-east-1 (spec "Region and latency").
    placement: { region: 'aws:ap-east-1' },
    ...issuerPlacement(t.url),
    vars: {
      ENV_NAME: m.name,
      // The env label the HTML part of user mail opens with (D419, D670); none on any network but testnet.
      NEAR_NETWORK: m.network,
      ...(envAlertLabel(m) ? { ENV_LABEL: envAlertLabel(m) } : {}),
      // The designed mails' logo comes from the files Worker (D685); without a files block, the text wordmark.
      ...(m.files ? { FILES_ORIGIN: m.files.origin } : {}),
      NEAR_RPC: m.rpc,
      ...(m.rpcFallback ? { NEAR_RPC_FALLBACK: m.rpcFallback } : {}),
      SIGNER_ACCOUNT: m.signer,
      EMAIL_ISS: t.iss,
      EMAIL_PUBLIC_KEYS: JSON.stringify(t.publicKeys),
      EMAIL_ACTIVE_KID: t.signer.activeKid,
      EMAIL_SIGNER_KIND: t.signer.kind,
      EMAIL_SENDER: t.sender,
      MAIL_FROM: t.from,
      AUTH_ORIGIN: m.authOrigin,
      VAULT_ORIGIN: m.vaultOrigin,
      ...(t.dailySendBudget ? { DAILY_SEND_BUDGET: String(t.dailySendBudget) } : {}),
      // Testnet only (D793): named apps' shares of the budget, and lower per-IP and per-requester windows.
      ...(t.appShares ? { EMAIL_APP_SHARES: JSON.stringify(t.appShares) } : {}),
      ...(t.tighterLimits ? { EMAIL_TIGHTER_LIMITS: JSON.stringify(t.tighterLimits) } : {}),
      ...(t.access ? { ACCESS_TEAM_DOMAIN: t.access.teamDomain, ACCESS_AUD: t.access.aud, ACCESS_STAFF_EMAILS: JSON.stringify(t.access.staffEmails) } : {}),
      ...(t.sendgridWebhookPublicKey ? { SENDGRID_WEBHOOK_PUBLIC_KEY: t.sendgridWebhookPublicKey } : {}),
      // The issuer's alert mails (D446): the security alias of the dashboard's `email` block.
      ...(m.email ? { SECURITY_ALIAS: m.email.securityAlias } : {}),
      // DirectoryRpc's own staff check (D275): the admin console's Access application and staff list. Without a
      // dashboard (`admin`) block there is no admin Worker to bind the entrypoint, and every call fails closed.
      ...(m.admin ? { ADMIN_ACCESS_TEAM_DOMAIN: m.admin.accessTeamDomain, ADMIN_ACCESS_AUD: m.admin.accessAud, ADMIN_STAFF_EMAILS: JSON.stringify(m.admin.staffEmails) } : {}),
    },
    // Its own D1 only: no binding to the API's (D434, replacing D251's read-write APP_DB).
    d1_databases: [{ binding: 'DB', database_name: t.cloudflare.d1Name, database_id: d1Id, migrations_dir: 'migrations' }],
    // The API's read-only app lookups (apps/api/src/rpc/issuer.ts): the issuer is the entrypoint's only caller, and
    // the API must serve it before this Worker deploys (docs/operations.md "Email issuer").
    services: [{ binding: 'API', service: m.cloudflare.workerName, entrypoint: 'IssuerRpc' }],
    durable_objects: {
      bindings: [
        { name: 'EMAIL_CHALLENGE', class_name: 'Challenge' },
        { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
        ...(outbox ? [{ name: 'OUTBOX', class_name: 'Outbox' }] : []),
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Challenge', 'RateLimiter', 'Outbox'] }],
  };
}

/** The fixed manifest the Worker tests' config comes from: no real account or D1. */
export const TEST_MANIFEST = {
  name: 'local-test',
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
  vaultOrigin: 'https://vault.test',
  authOrigin: 'https://auth.test',
  changeDelayMs: 60_000,
  appChangeDelayMs: 60_000,
  googleClientIds: [],
  sharedGoogleClientIds: [],
  consoleAudiences: [],
  cloudflare: { workerName: 'hana-id-api-test', d1Name: 'hana-id-test' },
  emailIssuer: {
    iss: 'https://api.test/v1/email',
    cloudflare: { workerName: 'hana-id-email-issuer-test', d1Name: 'hana-id-email-issuer-test' },
    // Replaced per run by vitest.config.ts with throwaway keys.
    signer: { kind: 'worker-secret', activeKid: 'UNSET' },
    publicKeys: [],
    from: 'Hana <login@mail.example.com>',
    sender: 'outbox',
  },
} as unknown as Manifest;

export function testWranglerConfig(publicKeys: unknown[], activeKid: string): Record<string, unknown> {
  const m = { ...TEST_MANIFEST, emailIssuer: { ...TEST_MANIFEST.emailIssuer!, publicKeys, signer: { kind: 'worker-secret', activeKid }, dailySendBudget: 1000 } } as Manifest;
  return wranglerConfig(m, LOCAL_D1_ID);
}

/** A D1 id in an existing wrangler.jsonc, only when it was generated for the same database (binding and name). */
export function existingD1Id(path: string, binding: string, d1Name: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const re = new RegExp(`"binding"\\s*:\\s*"${binding}"\\s*,\\s*"database_name"\\s*:\\s*"([^"]+)"\\s*,\\s*"database_id"\\s*:\\s*"([^"]+)"`, 'u');
  const m = re.exec(text);
  return m && m[1] === d1Name && m[2] !== LOCAL_D1_ID ? m[2]! : null;
}

export function writeWranglerConfig(m: Manifest, ids: { d1?: string | undefined }, dir: string = appDir): { path: string; d1Id: string } {
  if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer block`);
  const path = join(dir, 'wrangler.jsonc');
  const d1Id = ids.d1 ?? existingD1Id(path, 'DB', m.emailIssuer.cloudflare.d1Name) ?? LOCAL_D1_ID;
  const config = wranglerConfig(m, d1Id);
  const header = `// Generated by apps/email-issuer/scripts/gen-wrangler.ts from envs/${m.name}.json: edit the manifest, not this file.\n`;
  writeFileSync(path, header + JSON.stringify(config, null, 2) + '\n');
  return { path, d1Id };
}

const B64_32 = /^[A-Za-z0-9+/]{43}=$/u;
const SENDGRID_KEY = /^SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}$/u;

/**
 * .dev.vars lines from .secrets/<env>/: the active signing key (its thumbprint must be the manifest's active kid; the
 * standby is never written), the three HMAC keys, the SendGrid key and the sealed email's IDENTITY_SEAL_KEY (D438,
 * `identity-seal-key`, the API's same value) when their files exist. Values single-quoted
 * (taken literally by wrangler's dotenv). Never printed.
 */
export function devVarsContent(m: Manifest, root: string = repoRoot): { content: string; names: string[] } {
  const t = m.emailIssuer;
  if (!t || t.signer.kind !== 'worker-secret') throw new Error(`envs/${m.name}.json has no Worker-secret emailIssuer`);
  const dir = secretsDir(m.name, root);
  const read = (name: keyof typeof EMAIL_ISSUER_SECRET_FILES): string | null => {
    const file = join(dir, EMAIL_ISSUER_SECRET_FILES[name]);
    if (!existsSync(file)) return null;
    assertPrivate(file);
    return readFileSync(file, 'utf8').trim();
  };
  const lines: string[] = [];
  const names: string[] = [];
  const add = (name: string, value: string) => {
    if (value.includes("'") || /[\r\n]/u.test(value)) throw new Error(`${name} contains a quote or a newline`);
    lines.push(`${name}='${value}'`);
    names.push(name);
  };
  const signing = read('signingKey');
  if (signing !== null) {
    let jwk: { n?: string; e?: string; d?: string };
    try {
      jwk = JSON.parse(signing) as typeof jwk;
    } catch {
      throw new Error(`${EMAIL_ISSUER_SECRET_FILES.signingKey} is not JSON`);
    }
    if (!jwk.n || !jwk.e || !jwk.d) throw new Error(`${EMAIL_ISSUER_SECRET_FILES.signingKey} is not an RSA private JWK`);
    if (rsaJwkThumbprint({ n: jwk.n, e: jwk.e }) !== t.signer.activeKid) throw new Error(`${EMAIL_ISSUER_SECRET_FILES.signingKey} is not the manifest's active key`);
    add('ISSUER_SIGNING_KEY', JSON.stringify(JSON.parse(signing)));
  }
  for (const [file, name] of [['subKey', 'EMAIL_SUB_KEY'], ['codeKey', 'EMAIL_CODE_KEY'], ['rlKey', 'EMAIL_RL_KEY']] as const) {
    const v = read(file);
    if (v === null) continue;
    if (!B64_32.test(v)) throw new Error(`${EMAIL_ISSUER_SECRET_FILES[file]} is not base64 of 32 bytes`);
    add(name, v);
  }
  const sg = read('sendgridKey');
  if (sg !== null) {
    if (!SENDGRID_KEY.test(sg)) throw new Error(`${EMAIL_ISSUER_SECRET_FILES.sendgridKey} is not a SendGrid API key`);
    add('SENDGRID_API_KEY', sg);
  }
  const sealFile = join(dir, IDENTITY_SECRET_FILES.sealKey);
  if (existsSync(sealFile)) {
    assertPrivate(sealFile);
    const seal = readFileSync(sealFile, 'utf8').trim();
    if (identitySealKeyId(seal) === null) throw new Error(`${IDENTITY_SECRET_FILES.sealKey} is not <id>:<base64 of 32 bytes>`);
    add('IDENTITY_SEAL_KEY', seal);
  }
  return { content: lines.length ? `${lines.join('\n')}\n` : '', names };
}

export function main(argv: string[], opts: { root?: string; dir?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  if (argv.includes('--app-d1-id')) {
    throw new Error('--app-d1-id is gone: the issuer reads apps through the API\'s IssuerRpc (service binding API, D434) and binds no API D1. Drop the flag.');
  }
  const flagsWithValue = new Set(['--d1-id']);
  const envName = argv.find((a, i) => !a.startsWith('--') && !flagsWithValue.has(argv[i - 1] ?? ''));
  if (!envName) {
    console.error('usage: gen-wrangler <env> [--d1-id <uuid>] [--dev-vars]');
    process.exit(2);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || !/^[0-9a-f-]{36}$/u.test(v)) throw new Error(`${name} needs a D1 database uuid`);
    return v;
  };
  const manifest = (opts.loadManifest ?? loadEnv)(envName);
  const { path, d1Id } = writeWranglerConfig(manifest, { d1: flag('--d1-id') }, opts.dir);
  const placeholder = d1Id === LOCAL_D1_ID;
  console.log(`wrote ${path} (env ${manifest.name}, worker ${manifest.emailIssuer?.cloudflare.workerName}, API ${manifest.cloudflare.workerName}:IssuerRpc${placeholder ? ', local D1 placeholder id' : ''})`);
  if (argv.includes('--dev-vars')) {
    const { content, names } = devVarsContent(manifest, opts.root);
    const devVars = join(opts.dir ?? appDir, '.dev.vars');
    writeFileSync(devVars, content, { mode: 0o600 });
    chmodSync(devVars, 0o600);
    console.log(`wrote ${devVars} (${names.join(', ') || 'no secrets'}; values not shown)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
