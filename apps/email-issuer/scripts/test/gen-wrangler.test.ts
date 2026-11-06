// gen for apps/email-issuer: what it writes, and what it refuses (a Worker-secret signer outside testnet, the aws-kms
// signer before batch 10, the outbox outside local* envs, an env without the block or the Hana origins), plus
// .dev.vars from .secrets/<env>/ without ever printing a value.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { type Manifest, loadEnv, rsaJwkThumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_DOMAIN, customDomainManifest } from '../../../../packages/env/src/custom-domain.fixture.ts';
import { LOCAL_D1_ID, devVarsContent, existingD1Id, main, testWranglerConfig, wranglerConfig, writeWranglerConfig } from '../gen-wrangler.ts';

function rsa() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { jwk, pub: { kty: 'RSA' as const, n: jwk.n!, e: jwk.e!, kid: rsaJwkThumbprint({ n: jwk.n!, e: jwk.e! }), use: 'sig' as const, alg: 'RS256' as const } };
}
const primary = rsa();
const standby = rsa();
const base = loadEnv('sandbox-dev');
const manifest = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Manifest =>
  ({
    ...base,
    ...top,
    emailIssuer: {
      iss: `${base.apiUrl}/v1/email`,
      cloudflare: { workerName: 'hana-id-email-issuer-sandbox-dev', d1Name: 'hana-id-email-issuer-sandbox-dev' },
      signer: { kind: 'worker-secret', activeKid: primary.pub.kid },
      publicKeys: [primary.pub, standby.pub],
      from: 'Hana <login@mail.example.com>',
      sender: 'sendgrid',
      ...over,
    },
  }) as Manifest;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hana-eigen-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('wranglerConfig', () => {
  it('a workers.dev URL only when emailIssuer.url names one; a zone-routed issuer has none (review L5)', () => {
    const own = 'https://hana-id-email-issuer-sandbox-dev.tingtc.workers.dev';
    expect((wranglerConfig(manifest({ url: own, iss: `${own}/v1/email` }), LOCAL_D1_ID, LOCAL_D1_ID) as { workers_dev: boolean }).workers_dev).toBe(true);
    expect((wranglerConfig(manifest(), LOCAL_D1_ID, LOCAL_D1_ID) as { workers_dev: boolean }).workers_dev).toBe(false);
    expect((wranglerConfig(manifest({ url: 'https://email.hana.example' }), LOCAL_D1_ID, LOCAL_D1_ID) as { workers_dev: boolean }).workers_dev).toBe(false);
    expect(wranglerConfig(manifest(), LOCAL_D1_ID, LOCAL_D1_ID)).not.toHaveProperty('routes');
  });

  it('an emailIssuer.url on another host is a Custom Domain, on the manifest account (D404)', () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    const m = customDomainManifest();
    expect(wranglerConfig(m, LOCAL_D1_ID, LOCAL_D1_ID)).toMatchObject({
      account_id: CUSTOM_DOMAIN.accountId,
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'email.id-dev.hanawallet.io', custom_domain: true }],
      vars: { EMAIL_ISS: `${CUSTOM_DOMAIN.emailIssuerUrl}/v1/email` },
    });
    expect(wranglerConfig(manifest(), LOCAL_D1_ID, LOCAL_D1_ID)).not.toHaveProperty('account_id');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'ffffffffffffffffffffffffffffffff');
    expect(() => wranglerConfig(m, LOCAL_D1_ID, LOCAL_D1_ID)).toThrow(/CLOUDFLARE_ACCOUNT_ID is f+/u);
    vi.unstubAllEnvs();
  });

  it('writes the issuer’s Worker, both D1s, the Durable Objects and the public vars (no secret)', () => {
    const c = wranglerConfig(manifest({ dailySendBudget: 500 }), 'a'.repeat(8) + '-0000-4000-8000-000000000001', LOCAL_D1_ID) as Record<string, any>;
    expect(c.name).toBe('hana-id-email-issuer-sandbox-dev');
    expect(c.main).toBe('src/index.ts');
    expect(c.placement).toEqual({ region: 'aws:ap-east-1' });
    expect(c.observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
    expect(c.vars).toMatchObject({
      ENV_NAME: 'sandbox-dev',
      SIGNER_ACCOUNT: base.signer,
      EMAIL_ISS: `${base.apiUrl}/v1/email`,
      EMAIL_ACTIVE_KID: primary.pub.kid,
      EMAIL_SIGNER_KIND: 'worker-secret',
      EMAIL_SENDER: 'sendgrid',
      AUTH_ORIGIN: base.authOrigin,
      VAULT_ORIGIN: base.vaultOrigin,
      DAILY_SEND_BUDGET: '500',
    });
    expect(JSON.parse(c.vars.EMAIL_PUBLIC_KEYS)).toEqual([primary.pub, standby.pub]);
    expect(JSON.stringify(c)).not.toContain(primary.jwk.d);
    expect(c.d1_databases.map((d: { binding: string; database_name: string }) => [d.binding, d.database_name])).toEqual([
      ['DB', 'hana-id-email-issuer-sandbox-dev'],
      ['APP_DB', base.cloudflare.d1Name],
    ]);
    expect(c.durable_objects.bindings.map((b: { name: string }) => b.name)).toEqual(['EMAIL_CHALLENGE', 'RATE_LIMITER']);
  });

  it('DirectoryRpc’s staff check: the admin application’s Access vars only with a dashboard block; no service binding of its own (D275)', () => {
    // An env without a dashboard (sandbox-dev's manifest has one since M4: dropped here).
    const none = wranglerConfig({ ...manifest(), admin: undefined } as Manifest, LOCAL_D1_ID, LOCAL_D1_ID) as Record<string, any>;
    expect(Object.keys(none.vars).filter((k) => k.startsWith('ADMIN_'))).toEqual([]);
    // sandbox-dev's own block passes its AUD through as is (access-setup wrote it, D409).
    const sandbox = wranglerConfig(manifest(), LOCAL_D1_ID, LOCAL_D1_ID) as Record<string, any>;
    expect(sandbox.vars).toMatchObject({ ADMIN_ACCESS_AUD: base.admin!.accessAud, ADMIN_STAFF_EMAILS: JSON.stringify(base.admin!.staffEmails) });
    // A placeholder AUD passes through too: the issuer's staffConfig refuses `UNSET`, so every staff call fails closed
    // until the Access application exists (test/directory-rpc.test.ts, "fails closed").
    const unset = wranglerConfig({ ...manifest(), admin: { ...base.admin!, accessAud: 'UNSET' } } as Manifest, LOCAL_D1_ID, LOCAL_D1_ID) as Record<string, any>;
    expect(unset.vars).toMatchObject({ ADMIN_ACCESS_AUD: 'UNSET' });
    const admin = { workerName: 'hana-id-admin-sandbox-dev', origin: 'https://admin.example.test', accessTeamDomain: 'hana.cloudflareaccess.com', accessAud: 'e'.repeat(64), staffEmails: ['a@hana.example', 'b@hana.example'] };
    const c = wranglerConfig(manifest({}, { admin }), LOCAL_D1_ID, LOCAL_D1_ID) as Record<string, any>;
    expect(c.vars).toMatchObject({ ADMIN_ACCESS_TEAM_DOMAIN: 'hana.cloudflareaccess.com', ADMIN_ACCESS_AUD: 'e'.repeat(64), ADMIN_STAFF_EMAILS: '["a@hana.example","b@hana.example"]' });
    // The issuer binds nothing new: the admin Worker binds it (the entrypoint has no route here).
    expect(c.services).toBeUndefined();
    expect(c.routes).toBeUndefined();
  });

  it('the outbox binding only in local* envs (and the test config)', () => {
    expect(() => wranglerConfig(manifest({ sender: 'outbox' }), LOCAL_D1_ID, LOCAL_D1_ID)).toThrow('local* envs only');
    const local = wranglerConfig(manifest({ sender: 'outbox' }, { name: 'local-dev' }), LOCAL_D1_ID, LOCAL_D1_ID) as Record<string, any>;
    expect(local.durable_objects.bindings.map((b: { name: string }) => b.name)).toContain('OUTBOX');
    const t = testWranglerConfig([primary.pub], primary.pub.kid) as Record<string, any>;
    expect(t.vars.EMAIL_SENDER).toBe('outbox');
  });

  it('refuses a Worker-secret signer outside testnet, the aws-kms signer (not wired), a missing block or origin', () => {
    expect(() => wranglerConfig({ ...manifest(), network: 'mainnet' } as unknown as Manifest, LOCAL_D1_ID, LOCAL_D1_ID)).toThrow('testnet only');
    const kms = { kind: 'aws-kms', awsRegion: 'ap-east-1', keys: { primary: { kid: primary.pub.kid, arn: 'x' }, standby: { kid: standby.pub.kid, arn: 'y' } } };
    expect(() => wranglerConfig(manifest({ signer: kms }), LOCAL_D1_ID, LOCAL_D1_ID)).toThrow('not wired yet');
    const { emailIssuer: _committed, ...noIssuer } = base;
    expect(() => wranglerConfig(noIssuer as Manifest, LOCAL_D1_ID, LOCAL_D1_ID)).toThrow('no emailIssuer');
    expect(() => wranglerConfig({ ...manifest(), authOrigin: undefined } as Manifest, LOCAL_D1_ID, LOCAL_D1_ID)).toThrow('vaultOrigin and authOrigin');
  });

  it('keeps D1 ids from an existing file only for the same databases', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const app = '66666666-7777-4888-8999-000000000000';
    writeWranglerConfig(manifest(), { d1: id, appD1: app }, dir);
    expect(existingD1Id(join(dir, 'wrangler.jsonc'), 'DB', 'hana-id-email-issuer-sandbox-dev')).toBe(id);
    expect(existingD1Id(join(dir, 'wrangler.jsonc'), 'APP_DB', base.cloudflare.d1Name)).toBe(app);
    expect(existingD1Id(join(dir, 'wrangler.jsonc'), 'DB', 'another-db')).toBeNull();
    const again = writeWranglerConfig(manifest(), {}, dir);
    expect([again.d1Id, again.appD1Id]).toEqual([id, app]);
  });
});

describe('.dev.vars', () => {
  it('writes the active key and the HMAC keys from .secrets (never the standby), 0600, values not printed', () => {
    const root = dir;
    const s = join(root, '.secrets', 'sandbox-dev');
    mkdirSync(s, { recursive: true, mode: 0o700 });
    const put = (f: string, v: string) => {
      writeFileSync(join(s, f), v);
      chmodSync(join(s, f), 0o600);
    };
    put('email-issuer-signing-key.json', JSON.stringify(primary.jwk));
    put('email-issuer-signing-key-standby.json', JSON.stringify(standby.jwk));
    const k = [randomBytes(32), randomBytes(32), randomBytes(32)].map((b) => b.toString('base64'));
    put('email-sub-key', `${k[0]}\n`);
    put('email-code-key', `${k[1]}\n`);
    put('email-rl-key', `${k[2]}\n`);
    const { content, names } = devVarsContent(manifest(), root);
    expect(names).toEqual(['ISSUER_SIGNING_KEY', 'EMAIL_SUB_KEY', 'EMAIL_CODE_KEY', 'EMAIL_RL_KEY']);
    expect(content).not.toContain(standby.jwk.d);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
    main(['sandbox-dev', '--dev-vars'], { root, dir, loadManifest: () => manifest() });
    spy.mockRestore();
    expect(statSync(join(dir, '.dev.vars')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.dev.vars'), 'utf8')).toBe(content);
    for (const v of [primary.jwk.d!, ...k]) expect(logs.join('\n')).not.toContain(v);
    // The standby in the signing slot is refused.
    put('email-issuer-signing-key.json', JSON.stringify(standby.jwk));
    expect(() => devVarsContent(manifest(), root)).toThrow('active key');
    chmodSync(join(s, 'email-sub-key'), 0o644);
    put('email-issuer-signing-key.json', JSON.stringify(primary.jwk));
    expect(() => devVarsContent(manifest(), root)).toThrow('0600');
  });

  it('adds the sealed email’s IDENTITY_SEAL_KEY when identity-seal-key exists (D418): checked, 0600, never printed', () => {
    const root = dir;
    const s = join(root, '.secrets', 'sandbox-dev');
    mkdirSync(s, { recursive: true, mode: 0o700 });
    const put = (f: string, v: string, mode = 0o600) => {
      writeFileSync(join(s, f), v);
      chmodSync(join(s, f), mode);
    };
    for (const f of ['email-sub-key', 'email-code-key', 'email-rl-key']) put(f, `${randomBytes(32).toString('base64')}\n`);
    expect(devVarsContent(manifest(), root).names).not.toContain('IDENTITY_SEAL_KEY');
    const seal = `3:${randomBytes(32).toString('base64')}`;
    put('identity-seal-key', `${seal}\n`);
    const { content, names } = devVarsContent(manifest(), root);
    expect(names).toEqual(['EMAIL_SUB_KEY', 'EMAIL_CODE_KEY', 'EMAIL_RL_KEY', 'IDENTITY_SEAL_KEY']);
    expect(content).toContain(`IDENTITY_SEAL_KEY='${seal}'\n`);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
    main(['sandbox-dev', '--dev-vars'], { root, dir, loadManifest: () => manifest() });
    spy.mockRestore();
    expect(logs.join('\n')).toContain('IDENTITY_SEAL_KEY');
    expect(logs.join('\n')).not.toContain(seal.slice(2));
    put('identity-seal-key', `${randomBytes(32).toString('base64')}\n`);
    expect(() => devVarsContent(manifest(), root)).toThrow('identity-seal-key is not <id>:<base64 of 32 bytes>');
    put('identity-seal-key', `${seal}\n`, 0o644);
    expect(() => devVarsContent(manifest(), root)).toThrow('0600');
  });
});
