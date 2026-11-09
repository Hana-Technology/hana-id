// env-secrets against a temp root with .secrets/<env>/ and generated configs, and a mocked spawn: the inventory, a
// missing file listed (never invented), the --yes gate, the account checks, the argv/cwd/stdin of each upload, and
// that no value ever reaches the output.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { type Manifest, loadEnv, p256Thumbprint, rsaJwkThumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { DRY_RUN_LINE, type EnvSecretsDeps, configProblem, envSecrets, secretInventory, workerTargets } from '../lib/env-secrets.ts';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const WATCHDOG_ACCOUNT = 'fedcba9876543210fedcba9876543210';

function rsa() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { jwk, kid: rsaJwkThumbprint({ n: jwk.n!, e: jwk.e! }) };
}
function p256() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };
  return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, kid: p256Thumbprint(jwk) };
}

const issuerKey = rsa();
const identity = p256();
// sandbox-dev without its dashboard blocks (it has them since M4, D414): these tests are about an env without a dashboard.
const { console: _console, files: _files, admin: _admin, usage: _usage, email: _email, ownerGrantDelayMs: _ownerGrant, ...sandboxBare } = loadEnv('sandbox-dev');
const base = sandboxBare as Manifest;
/** sandbox-dev on a new main account, its watchdog on its own, with keys this test generates. */
const m: Manifest = {
  ...base,
  name: 'sandbox-mv',
  cloudflare: { ...base.cloudflare, accountId: ACCOUNT },
  watchdog: { ...base.watchdog!, cloudflare: { ...base.watchdog!.cloudflare, accountId: WATCHDOG_ACCOUNT } },
  identityToken: { ...base.identityToken!, signer: { kind: 'worker-secret', activeKid: identity.kid } },
  emailIssuer: { ...base.emailIssuer!, signer: { kind: 'worker-secret', activeKid: issuerKey.kid } },
} as Manifest;

let root: string;
let out: string[];
let spawned: { argv: string[]; cwd: string; input: string }[];
let failName: string | null;
const values: string[] = [];

const deps = (env: Record<string, string | undefined> = {}): EnvSecretsDeps => ({
  spawn: (argv, opts) => {
    spawned.push({ argv, ...opts });
    return { status: argv[4] === failName ? 1 : 0 };
  },
  log: (l) => out.push(l),
  root,
  loadManifest: (name) => {
    expect(name).toBe(m.name);
    return m;
  },
  env,
});
const run = (argv: string[], env?: Record<string, string | undefined>) => envSecrets([m.name, ...argv], deps(env));

const secret = (name: string, content: string, mode = 0o600) => {
  const p = join(root, '.secrets', m.name, name);
  writeFileSync(p, content, { mode });
  chmodSync(p, mode);
  values.push(content.trim());
  return p;
};
const b64 = () => randomBytes(32).toString('base64');
const ed = () => KeyPair.fromRandom('ed25519').toString();
const config = (dir: string, name: string, accountId?: string) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'wrangler.jsonc'), `// Generated\n${JSON.stringify({ name, ...(accountId ? { account_id: accountId } : {}) })}\n`);
};

/** Every source file sandbox-mv's API, issuer and watchdog need. */
function seedAll(): void {
  secret('relayer-keys.json', JSON.stringify([ed(), ed()]));
  secret('owner-relayer-keys.json', JSON.stringify([ed()]));
  const updater = ed();
  writeFileSync(join(root, '.secrets', m.name, 'keys-updater.json'), JSON.stringify({ account_id: m.signer, public_key: 'ed25519:x', private_key: updater }), { mode: 0o600 });
  values.push(updater);
  secret('vault-kek', `1:${b64()}`);
  secret('identity-signing-key.json', JSON.stringify(identity.jwk));
  values.push(identity.jwk.d);
  secret('identity-sub-key', b64());
  secret('user-id-key', b64());
  secret('email-issuer-signing-key.json', JSON.stringify(issuerKey.jwk));
  values.push(issuerKey.jwk.d!, issuerKey.jwk.p!);
  for (const f of ['email-sub-key', 'email-code-key', 'email-rl-key']) secret(f, `${b64()}\n`);
  secret('email-issuer-sendgrid-key', `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`);
  const wd = {
    WATCHDOG_KEY: KeyPair.fromRandom('ed25519').toString(),
    WATCHDOG_STATUS_TOKEN: 't'.repeat(40),
    SENDGRID_API_KEY: `SG.${'c'.repeat(22)}.${'d'.repeat(43)}`,
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/xyz',
    NTFY_TOPIC_URL: 'https://ntfy.sh/abcdefghijklmnopqrst',
    HEARTBEAT_URL: 'https://hc-ping.com/uuid',
  };
  secret('watchdog-secrets.json', JSON.stringify(wd));
  values.push(...Object.values(wd));
  config('apps/api', m.cloudflare.workerName, ACCOUNT);
  config('apps/email-issuer', m.emailIssuer!.cloudflare.workerName, ACCOUNT);
  config('apps/watchdog', m.watchdog!.cloudflare.workerName, WATCHDOG_ACCOUNT);
}

const expectNoValuePrinted = () => {
  const text = out.join('\n');
  for (const v of values) expect(text).not.toContain(v);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-env-secrets-'));
  mkdirSync(join(root, '.secrets', m.name), { recursive: true, mode: 0o700 });
  out = [];
  spawned = [];
  failName = null;
  values.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('env-secrets: the inventory', () => {
  it("lists each Worker's secrets and sources, the API's on its own account and the watchdog's on the watchdog's", () => {
    seedAll();
    run([]);
    const text = out.join('\n');
    expect(text).toContain(`Worker ${m.cloudflare.workerName} (apps/api; account ${ACCOUNT}):`);
    expect(text).toContain(`Worker ${m.watchdog!.cloudflare.workerName} (apps/watchdog; account ${WATCHDOG_ACCOUNT}):`);
    for (const line of [
      `RELAYER_KEYS <- .secrets/${m.name}/relayer-keys.json: ok`,
      `OWNER_RELAYER_KEYS <- .secrets/${m.name}/owner-relayer-keys.json: ok`,
      `KEYS_UPDATER_KEY <- .secrets/${m.name}/keys-updater.json (private_key): ok`,
      `VAULT_KEK <- .secrets/${m.name}/vault-kek: ok`,
      `IDENTITY_SIGNING_KEY <- .secrets/${m.name}/identity-signing-key.json: ok (active kid ${identity.kid}`,
      `IDENTITY_SUB_KEY <- .secrets/${m.name}/identity-sub-key: ok`,
      `USER_ID_KEY <- .secrets/${m.name}/user-id-key: ok`,
      `ISSUER_SIGNING_KEY <- .secrets/${m.name}/email-issuer-signing-key.json: ok (active kid ${issuerKey.kid})`,
      `EMAIL_SUB_KEY <- .secrets/${m.name}/email-sub-key: ok`,
      `EMAIL_CODE_KEY <- .secrets/${m.name}/email-code-key: ok`,
      `EMAIL_RL_KEY <- .secrets/${m.name}/email-rl-key: ok`,
      `SENDGRID_API_KEY <- .secrets/${m.name}/email-issuer-sendgrid-key: ok`,
      `WATCHDOG_KEY <- .secrets/${m.name}/watchdog-secrets.json (WATCHDOG_KEY): ok`,
      `NTFY_TOPIC_URL <- .secrets/${m.name}/watchdog-secrets.json (NTFY_TOPIC_URL): ok`,
      `NTFY_TOKEN <- .secrets/${m.name}/watchdog-secrets.json (NTFY_TOKEN): not set (optional)`,
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain('VAULT_KEK_PREVIOUS');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(spawned).toEqual([]);
    expectNoValuePrinted();
  });

  it('lists a missing file as MISSING, never invents it, and a malformed or readable one as INVALID', () => {
    seedAll();
    rmSync(join(root, '.secrets', m.name, 'vault-kek'));
    secret('identity-sub-key', 'zz!!-bad-subkey-zz');
    secret('relayer-keys.json', JSON.stringify([ed()]), 0o644);
    run([]);
    const text = out.join('\n');
    expect(text).toContain(`VAULT_KEK <- .secrets/${m.name}/vault-kek: MISSING`);
    expect(text).toMatch(/IDENTITY_SUB_KEY <- .*: INVALID \(.*is not base64 of 32 bytes\)/u);
    expect(text).toMatch(/RELAYER_KEYS <- .*: INVALID \(.*must be 0600/u);
    expect(text).toContain('3 required secret(s) missing or invalid: api RELAYER_KEYS, api VAULT_KEK, api IDENTITY_SUB_KEY.');
    expectNoValuePrinted();
  });

  it('the identity key goes back into the slot identity-slots.json names; a key of another kid is refused', () => {
    seedAll();
    secret('identity-slots.json', JSON.stringify({ IDENTITY_SIGNING_KEY: null, IDENTITY_SIGNING_KEY_STANDBY: identity.kid }));
    expect(secretInventory(m, root, 'api').find((i) => i.name.startsWith('IDENTITY_SIGNING'))).toMatchObject({ name: 'IDENTITY_SIGNING_KEY_STANDBY', status: 'ok' });
    secret('identity-signing-key.json', JSON.stringify(p256().jwk));
    expect(secretInventory(m, root, 'api').find((i) => i.name.startsWith('IDENTITY_SIGNING'))).toMatchObject({ status: 'invalid', note: expect.stringContaining("doesn't have the manifest's active kid") });
  });

  it('refuses equal HMAC keys, a half-finished KEK rotation, and lists VAULT_KEK_PREVIOUS during one', () => {
    seedAll();
    const k = b64();
    for (const f of ['email-sub-key', 'email-code-key', 'email-rl-key']) secret(f, k);
    secret('vault-kek.previous', `2:${b64()}`);
    let inv = secretInventory(m, root);
    expect(inv.filter((i) => i.worker === 'issuer' && i.name.startsWith('EMAIL_')).map((i) => i.status)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(inv.find((i) => i.name === 'VAULT_KEK_PREVIOUS')).toMatchObject({ status: 'ok', note: 'a rotation in progress' });
    secret('vault-kek.next', `3:${b64()}`);
    inv = secretInventory(m, root);
    expect(inv.find((i) => i.name === 'VAULT_KEK')).toMatchObject({ status: 'invalid', note: expect.stringContaining('a rotation stopped part way') });
  });

  it('a dashboard env adds the console and admin secrets; files has none', () => {
    const dash = { ...m, console: { workerName: 'c', d1Name: 'c', origin: 'https://c.example', authWorkerName: 'ca', authOrigin: 'https://ca.example' }, admin: { workerName: 'a' }, files: { workerName: 'f' }, watchdog: { ...m.watchdog!, url: 'https://w.example' } } as unknown as Manifest;
    expect(workerTargets(dash).map((t) => t.id)).toEqual(['api', 'issuer', 'console', 'admin', 'files', 'watchdog']);
    const names = secretInventory(dash, root).filter((i) => i.worker === 'console' || i.worker === 'admin').map((i) => `${i.worker} ${i.name}${i.required ? '' : '?'}`);
    expect(names).toEqual(['console CONSOLE_GOOGLE_CLIENT_SECRET', 'admin EMAIL_API_KEY', 'admin CANCEL_LINK_KEY', 'admin INVITE_LINK_KEY', 'admin WATCHDOG_STATUS_TOKEN', 'admin COINGECKO_API_KEY?']);
  });
});

describe('env-secrets --yes', () => {
  it('uploads every secret of each Worker from its app directory, the value on stdin only', () => {
    seedAll();
    run(['--worker', 'api', '--yes'], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(spawned.map((s) => s.argv[4])).toEqual(['RELAYER_KEYS', 'OWNER_RELAYER_KEYS', 'KEYS_UPDATER_KEY', 'VAULT_KEK', 'IDENTITY_SIGNING_KEY', 'IDENTITY_SUB_KEY', 'USER_ID_KEY']);
    for (const s of spawned) {
      expect(s.argv).toEqual(['exec', 'wrangler', 'secret', 'put', s.argv[4], '--name', m.cloudflare.workerName]);
      expect(s.cwd).toBe(join(root, 'apps/api'));
      expect(s.input.length).toBeGreaterThan(0);
      // The value never in the argv.
      expect(s.argv.join(' ')).not.toContain(s.input);
    }
    expect(JSON.parse(spawned[0]!.input)).toHaveLength(2);
    expect(JSON.parse(spawned[4]!.input)).toEqual(identity.jwk);
    expect(out).toContain(`Set VAULT_KEK on Worker ${m.cloudflare.workerName}.`);
    expectNoValuePrinted();
  });

  it('uploads the issuer and the watchdog to their own Workers and accounts', () => {
    seedAll();
    run(['--worker', 'issuer', '--yes']);
    expect(spawned.map((s) => `${s.cwd.slice(root.length + 1)} ${s.argv[6]} ${s.argv[4]}`)).toEqual([
      `apps/email-issuer ${m.emailIssuer!.cloudflare.workerName} ISSUER_SIGNING_KEY`,
      `apps/email-issuer ${m.emailIssuer!.cloudflare.workerName} EMAIL_SUB_KEY`,
      `apps/email-issuer ${m.emailIssuer!.cloudflare.workerName} EMAIL_CODE_KEY`,
      `apps/email-issuer ${m.emailIssuer!.cloudflare.workerName} EMAIL_RL_KEY`,
      `apps/email-issuer ${m.emailIssuer!.cloudflare.workerName} SENDGRID_API_KEY`,
    ]);
    spawned = [];
    run(['--worker', 'watchdog', '--yes'], { CLOUDFLARE_ACCOUNT_ID: WATCHDOG_ACCOUNT });
    expect(spawned.map((s) => s.argv[4])).toEqual(['WATCHDOG_KEY', 'WATCHDOG_STATUS_TOKEN', 'SENDGRID_API_KEY', 'SLACK_WEBHOOK_URL', 'NTFY_TOPIC_URL', 'HEARTBEAT_URL']);
    expect(new Set(spawned.map((s) => s.cwd))).toEqual(new Set([join(root, 'apps/watchdog')]));
    expectNoValuePrinted();
  });

  it('refuses while a required secret is missing: nothing is uploaded', () => {
    seedAll();
    rmSync(join(root, '.secrets', m.name, 'keys-updater.json'));
    expect(() => run(['--yes'])).toThrow(/Refusing to upload while a required secret is missing/u);
    expect(spawned).toEqual([]);
  });

  it("refuses a config generated for another account or Worker, a missing one, and a shell account that isn't the manifest's", () => {
    seedAll();
    config('apps/api', m.cloudflare.workerName, 'ffffffffffffffffffffffffffffffff');
    expect(() => run(['--worker', 'api', '--yes'])).toThrow(/deploys to f+, not cloudflare.accountId 0123/u);
    config('apps/api', 'hana-id-api-other', ACCOUNT);
    expect(() => run(['--worker', 'api', '--yes'])).toThrow(/is for Worker hana-id-api-other/u);
    rmSync(join(root, 'apps/api/wrangler.jsonc'));
    expect(() => run(['--worker', 'api', '--yes'])).toThrow(/no apps\/api\/wrangler.jsonc: run its gen first/u);
    config('apps/api', m.cloudflare.workerName, ACCOUNT);
    // The watchdog's account in the shell while uploading the main account's Workers.
    expect(() => run(['--worker', 'api', '--yes'], { CLOUDFLARE_ACCOUNT_ID: WATCHDOG_ACCOUNT })).toThrow(/CLOUDFLARE_ACCOUNT_ID is fedcba.* but cloudflare.accountId/u);
    expect(spawned).toEqual([]);
    expect(configProblem(workerTargets(m)[0]!, root)).toBeNull();
  });

  it('stops at the first failed upload, naming the secret but not its value', () => {
    seedAll();
    failName = 'KEYS_UPDATER_KEY';
    expect(() => run(['--worker', 'api', '--yes'])).toThrow(`wrangler secret put KEYS_UPDATER_KEY on ${m.cloudflare.workerName} failed (exit 1)`);
    expect(spawned.map((s) => s.argv[4])).toEqual(['RELAYER_KEYS', 'OWNER_RELAYER_KEYS', 'KEYS_UPDATER_KEY']);
    expectNoValuePrinted();
  });

  it('checks its arguments', () => {
    expect(() => envSecrets([], deps())).toThrow(CliError);
    expect(() => run(['--worker', 'pages'])).toThrow(/--worker must be one of/u);
    expect(() => run(['extra'])).toThrow(/Unexpected argument/u);
    expect(() => run(['--worker', 'console'])).toThrow(/has no console Worker/u);
  });
});

describe('env-secrets: email sharing keys (D438, D439)', () => {
  it('optional: listed as not set without their files, nothing blocked, nothing uploaded for them', () => {
    seedAll();
    run([]);
    const text = out.join('\n');
    expect(text).toContain(`IDENTITY_SEAL_KEY <- .secrets/${m.name}/identity-seal-key: not set (optional)`);
    expect(text).toContain(`EMAIL_CONSENT_KEY <- .secrets/${m.name}/email-consent-key: not set (optional)`);
    expect(secretInventory(m, root, 'issuer').find((i) => i.name === 'IDENTITY_SEAL_KEY')).toMatchObject({ required: false, status: 'missing' });
    expect(text).not.toContain('required secret(s) missing');
    run(['--worker', 'api', '--yes'], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(spawned.map((s) => s.argv[4])).not.toContain('IDENTITY_SEAL_KEY');
    expect(spawned.map((s) => s.argv[4])).not.toContain('EMAIL_CONSENT_KEY');
  });

  it('with their files: the API gets both, the issuer the seal key only, each on its own Worker, values on stdin only', () => {
    seedAll();
    const seal = `1:${b64()}`;
    const consent = b64();
    secret('identity-seal-key', `${seal}\n`);
    secret('email-consent-key', `${consent}\n`);
    run(['--worker', 'api', '--yes'], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    const api = spawned.filter((s) => ['IDENTITY_SEAL_KEY', 'EMAIL_CONSENT_KEY'].includes(s.argv[4]!));
    expect(api.map((s) => [s.argv[4], s.argv[6], s.cwd.slice(root.length + 1), s.input])).toEqual([
      ['IDENTITY_SEAL_KEY', m.cloudflare.workerName, 'apps/api', seal],
      ['EMAIL_CONSENT_KEY', m.cloudflare.workerName, 'apps/api', consent],
    ]);
    spawned = [];
    run(['--worker', 'issuer', '--yes']);
    const issuer = spawned.filter((s) => ['IDENTITY_SEAL_KEY', 'EMAIL_CONSENT_KEY'].includes(s.argv[4]!));
    expect(issuer.map((s) => [s.argv[4], s.argv[6], s.cwd.slice(root.length + 1), s.input])).toEqual([['IDENTITY_SEAL_KEY', m.emailIssuer!.cloudflare.workerName, 'apps/email-issuer', seal]]);
    for (const s of spawned) expect(s.argv.join(' ')).not.toContain(s.input);
    expectNoValuePrinted();
  });

  it('a malformed or readable file is listed INVALID (never uploaded), its value never printed', () => {
    seedAll();
    secret('identity-seal-key', `0:${b64()}`);
    secret('email-consent-key', b64(), 0o644);
    run([]);
    const text = out.join('\n');
    expect(text).toMatch(/IDENTITY_SEAL_KEY <- .*identity-seal-key: INVALID \(.*is not an IDENTITY_SEAL_KEY value/u);
    expect(text).toMatch(/EMAIL_CONSENT_KEY <- .*email-consent-key: INVALID \(.*must be 0600/u);
    run(['--worker', 'api', '--yes'], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(spawned.map((s) => s.argv[4])).not.toContain('IDENTITY_SEAL_KEY');
    expectNoValuePrinted();
  });
});
