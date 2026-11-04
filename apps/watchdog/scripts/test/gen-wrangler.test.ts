import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { isDevEnv, loadEnv, type Manifest, PAGER_PROVIDERS, manifestSchema, WATCHDOG_INTERVAL_MS } from '@hana-id/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_INTERVAL_MS } from '../../src/checks.ts';

import { identityDiscoveryUrl, parseIdentityPins } from '../../src/identity.ts';
import { parsePins } from '../../src/pins.ts';
import { isDevEnvName, PAGER_PROVIDERS as WORKER_PAGERS, SECRET_NAMES } from '../../src/names.ts';
import { relayerThresholds } from '../../src/relayer.ts';
import { CRON, LOCAL_D1_ID, TEST_MANIFEST, devVarsContent, existingD1Id, identityVars, main, testWranglerConfig, wranglerConfig, writeWranglerConfig } from '../gen-wrangler.ts';
import { SECRET_RULES } from '../secrets.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hana-watchdog-gen-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const D1 = '11111111-2222-4333-8444-555555555555';

describe('wranglerConfig', () => {
  it('targets the watchdog’s own Cloudflare account, every 5 min, with the manifest’s accounts and RPCs', () => {
    const c = wranglerConfig(TEST_MANIFEST, D1);
    expect(c).toMatchObject({
      name: 'hana-id-watchdog-test',
      account_id: '0'.repeat(32),
      main: 'src/index.ts',
      workers_dev: true,
      preview_urls: false,
      triggers: { crons: [CRON] },
      d1_databases: [{ binding: 'DB', database_name: 'hana-id-watchdog-test', database_id: D1, migrations_dir: 'migrations' }],
      vars: {
        ENV_NAME: 'sandbox-test',
        NEAR_NETWORK: 'testnet',
        NEAR_RPC: 'https://rpc.test.invalid',
        NEAR_RPC_FALLBACK: 'https://rpc.fallback-provider.invalid',
        SIGNER_ACCOUNT: 'signer.test.near',
        WATCHDOG_ACCOUNT: 'watchdog.test.near',
        RELAYER_ACCOUNT: 'relayer.test.near',
        PAGER_PROVIDER: 'ntfy',
        ALERT_EMAILS: 'founder-a@example.com,founder-b@example.com',
        ALERT_FROM: 'alerts@notify.example.com',
        DIGEST_HOUR_UTC: '0',
      },
    });
    expect(CRON).toBe('*/5 * * * *');
    // The interval the deploy-contract delay floor assumes (W in issuer_key_delay_ms ≥ 3·(W + T), @hana-id/env).
    expect(RUN_INTERVAL_MS).toBe(5 * 60_000);
    expect(WATCHDOG_INTERVAL_MS).toBe(RUN_INTERVAL_MS);
  });

  it('puts no secret in the config: secrets are Worker secrets', () => {
    const text = JSON.stringify(testWranglerConfig());
    for (const name of SECRET_NAMES) expect(text).not.toContain(name);
  });

  it('refuses an env without a watchdog block, or with an UNSET Cloudflare account', () => {
    const { watchdog: _, ...noWatchdog } = TEST_MANIFEST;
    expect(() => wranglerConfig(noWatchdog as Manifest, D1)).toThrow(/no watchdog block/u);
    const unset = { ...TEST_MANIFEST, watchdog: { ...TEST_MANIFEST.watchdog!, cloudflare: { ...TEST_MANIFEST.watchdog!.cloudflare, accountId: 'UNSET' } } };
    expect(() => wranglerConfig(unset, D1)).toThrow(/UNSET/u);
  });

  it('passes the relayer funds thresholds only when the manifest overrides them, in a form the Worker reads', () => {
    expect((wranglerConfig(TEST_MANIFEST, D1).vars as Record<string, string>).RELAYER_FUNDS).toBeUndefined();
    const relayerFunds = { balance: { warn: 10, critical: 2 }, ownerAllowance: { warn: 0.2, critical: 0.05 } };
    const m = { ...TEST_MANIFEST, watchdog: { ...TEST_MANIFEST.watchdog!, relayerFunds } };
    expect(manifestSchema.safeParse(m).success).toBe(true);
    const json = (wranglerConfig(m, D1).vars as Record<string, string>).RELAYER_FUNDS;
    const { thresholds, problems } = relayerThresholds(json);
    expect(problems).toEqual([]);
    expect(thresholds.balance).toEqual({ warn: 10n * 10n ** 24n, critical: 2n * 10n ** 24n });
    expect(thresholds.owner).toEqual({ warn: 2n * 10n ** 23n, critical: 5n * 10n ** 22n });
    expect(thresholds.session).toEqual(relayerThresholds(undefined).thresholds.session);
  });

  it('passes no email pins when the manifest has none (the Worker then pins nothing), and no indexer var (D200)', () => {
    const vars = wranglerConfig(TEST_MANIFEST, D1).vars as Record<string, string>;
    for (const k of ['EMAIL_PINS', 'EMAIL_JWKS_URL', 'LINK_INDEXER_URL', 'LINK_VOLUME']) expect(vars[k], k).toBeUndefined();
    expect(parsePins(vars.EMAIL_PINS)).toEqual({ pins: null, problems: [] });
  });

  it('passes the email pins and the JWKS URL (default under apiUrl) in a form the Worker reads', () => {
    const tp = (c: string) => c.repeat(43);
    const email = { required: 1, signers: { hana: [tp('a'), tp('b')] } };
    const m = { ...TEST_MANIFEST, watchdog: { ...TEST_MANIFEST.watchdog!, pinnedIssuerKeys: { email } } };
    expect(manifestSchema.safeParse(m).success).toBe(true);
    const vars = wranglerConfig(m, D1).vars as Record<string, string>;
    expect(parsePins(vars.EMAIL_PINS)).toEqual({ pins: email, problems: [] });
    expect(vars.EMAIL_JWKS_URL).toBe('https://api.test/v1/email/jwks.json');
    const own = { ...m, watchdog: { ...m.watchdog, pinnedIssuerKeys: { email: { ...email, jwksUrl: 'https://issuer.example.com/jwks.json' } } } };
    expect((wranglerConfig(own, D1).vars as Record<string, string>).EMAIL_JWKS_URL).toBe('https://issuer.example.com/jwks.json');
    expect(JSON.parse((wranglerConfig(own, D1).vars as Record<string, string>).EMAIL_PINS!)).not.toHaveProperty('jwksUrl');
    // An issuer on its own URL (emailIssuer.url, D230): the default follows it.
    const issuerUrl = { ...m, emailIssuer: { url: 'https://hana-id-email-issuer-x.sub.workers.dev' } } as unknown as typeof m;
    expect((wranglerConfig(issuerUrl, D1).vars as Record<string, string>).EMAIL_JWKS_URL).toBe('https://hana-id-email-issuer-x.sub.workers.dev/v1/email/jwks.json');
  });

  it('passes the identity issuer and pins in a form the Worker reads; none without them (D210)', () => {
    const none = wranglerConfig(TEST_MANIFEST, D1).vars as Record<string, string>;
    expect(none.IDENTITY_ISS).toBeUndefined();
    expect(none.IDENTITY_PINS).toBeUndefined();
    expect(parseIdentityPins(none.IDENTITY_PINS)).toEqual({ pins: null, problems: [] });
    const sandbox = loadEnv('sandbox-dev');
    const vars = identityVars(sandbox);
    expect(vars.IDENTITY_ISS).toBe(sandbox.identityToken!.iss);
    expect(parseIdentityPins(vars.IDENTITY_PINS)).toEqual({ pins: sandbox.identityToken!.publicKeys.map((k) => k.kid), problems: [] });
    expect(identityDiscoveryUrl(vars.IDENTITY_ISS!)).toBe(`${sandbox.apiUrl}/v1/identity/.well-known/openid-configuration`);
  });

  it("decides a dev env as @hana-id/env does (D139's unrecorded_wallets alert is for other envs)", () => {
    for (const name of ['sandbox-dev', 'sandbox-test', 'local', 'local-2', 'staging', 'prod', 'mainnet', 'x-sandbox']) expect(isDevEnvName(name), name).toBe(isDevEnv(name));
  });

  it('omits the fallback RPC when the manifest has none', () => {
    const { rpcFallback: _, ...m } = TEST_MANIFEST;
    expect((wranglerConfig(m as Manifest, D1).vars as Record<string, string>).NEAR_RPC_FALLBACK).toBeUndefined();
  });

  it('uses a valid test manifest', () => {
    expect(manifestSchema.safeParse(TEST_MANIFEST).success).toBe(true);
  });

  it('knows the same paging apps as the manifest schema, and a check for every secret', () => {
    expect([...WORKER_PAGERS]).toEqual([...PAGER_PROVIDERS]);
    expect(Object.keys(SECRET_RULES).sort()).toEqual([...SECRET_NAMES].sort());
  });
});

describe('writeWranglerConfig and the D1 id', () => {
  it('keeps an existing id only for the same database', () => {
    const dir = tmp();
    writeWranglerConfig(TEST_MANIFEST, D1, dir);
    const path = join(dir, 'wrangler.jsonc');
    expect(readFileSync(path, 'utf8')).toMatch(/^\/\/ Generated by apps\/watchdog\/scripts\/gen-wrangler.ts from envs\/sandbox-test.json/u);
    expect(existingD1Id(path, 'hana-id-watchdog-test')).toBe(D1);
    expect(existingD1Id(path, 'other-db')).toBeNull();
    expect(writeWranglerConfig(TEST_MANIFEST, undefined, dir).d1Id).toBe(D1);
    expect(writeWranglerConfig({ ...TEST_MANIFEST, watchdog: { ...TEST_MANIFEST.watchdog!, cloudflare: { ...TEST_MANIFEST.watchdog!.cloudflare, d1Name: 'other' } } }, undefined, dir).d1Id).toBe(LOCAL_D1_ID);
  });
});

describe('main', () => {
  it('writes the config and, with --dev-vars, a 0600 .dev.vars from .secrets without printing values', () => {
    const root = tmp();
    const dir = tmp();
    const key = KeyPair.fromRandom('ed25519').toString();
    const secretDir = join(root, '.secrets', 'sandbox-test');
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(secretDir, 'watchdog-secrets.json'), JSON.stringify({ WATCHDOG_KEY: key, WATCHDOG_STATUS_TOKEN: 'x'.repeat(40) }), { mode: 0o600 });
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    main(['sandbox-test', '--d1-id', D1, '--dev-vars'], { root, dir, loadManifest: () => TEST_MANIFEST });
    expect(existsSync(join(dir, 'wrangler.jsonc'))).toBe(true);
    const devVars = join(dir, '.dev.vars');
    expect(statSync(devVars).mode & 0o777).toBe(0o600);
    expect(readFileSync(devVars, 'utf8')).toBe(`WATCHDOG_KEY='${key}'\nWATCHDOG_STATUS_TOKEN='${'x'.repeat(40)}'\n`);
    expect(out.join('\n')).not.toContain(key);
    expect(out.join('\n')).toContain('2 secret(s)');
  });

  it('refuses a bad --d1-id', () => {
    expect(() => main(['sandbox-test', '--d1-id', 'nope'], { dir: tmp(), loadManifest: () => TEST_MANIFEST })).toThrow(/uuid/u);
  });

  it('refuses a value that dotenv could not carry', () => {
    expect(() => devVarsContent({ A: "it's" })).toThrow(/quote/u);
    expect(devVarsContent({})).toBe('');
  });
});
