import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Manifest, loadEnv, manifestSchema } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';
import { ckdKeyProblem } from '../scripts/ckd-key.ts';
import { GENERATED_PATH, envsModule, hanaEnv, loadManifests, main, packageEnvsProblem, placeholderProblems } from '../scripts/gen-envs.ts';
import type { HanaEnv } from '../src/hana-env.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sandbox = loadEnv('sandbox-dev');

/** A validated manifest: sandbox-dev with overrides (undefined drops a field). */
function manifest(overrides: Record<string, unknown>): Manifest {
  const m: Record<string, unknown> = { ...sandbox, ...overrides };
  // A moved apiUrl would no longer match sandbox-dev's identity issuer; this test isn't about the identity token.
  if ('apiUrl' in overrides && !('identityToken' in overrides)) delete m.identityToken;
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete m[k];
  return manifestSchema.parse(m);
}

const prod = manifest({ name: 'prod', vaultOrigin: 'https://vault.hana.example', authOrigin: 'https://auth.hana-login.example' });
const noOrigins = manifest({ name: 'sandbox-old', vaultOrigin: undefined, authOrigin: undefined });

/** Writes the module for `manifests` to a temp file and imports it. */
async function generated(manifests: Manifest[]): Promise<Readonly<Record<string, HanaEnv>>> {
  const dir = mkdtempSync(join(tmpdir(), 'hana-gen-envs-'));
  dirs.push(dir);
  const out = join(dir, 'envs.generated.ts');
  main({ manifests, out });
  return ((await import(pathToFileURL(out).href)) as { HANA_ENVS: Readonly<Record<string, HanaEnv>> }).HANA_ENVS;
}

describe('hanaEnv', () => {
  it('takes exactly the page constants from the manifest', () => {
    expect(hanaEnv(sandbox)).toEqual({
      name: 'sandbox-dev',
      network: 'testnet',
      apiUrl: sandbox.apiUrl,
      vaultOrigin: sandbox.vaultOrigin,
      authOrigin: sandbox.authOrigin,
      signer: sandbox.signer,
      relayer: sandbox.relayer,
      rpc: sandbox.rpc,
      rpcFallback: sandbox.rpcFallback,
      ckdNetworkKey: sandbox.ckdNetworkKey,
      devEnv: true,
      // Present exactly when the manifest has an emailIssuer block.
      ...(sandbox.emailIssuer ? { emailIssuerUrl: sandbox.emailIssuer.url, emailIss: sandbox.emailIssuer.iss } : {}),
    });
  });

  it('passes rpcFallback through when the manifest sets it, and leaves it out otherwise', async () => {
    expect(sandbox.rpcFallback).toBe('https://rpc.testnet.near.org');
    // With an emailIssuer block rpcFallback is required (D263), so the no-fallback case drops the block too.
    expect(hanaEnv(manifest({ name: 'sandbox-nofb', rpcFallback: undefined, emailIssuer: undefined }))).not.toHaveProperty('rpcFallback');
    const withFallback = manifest({ name: 'sandbox-fb', rpcFallback: 'https://rpc.fallback.example' });
    expect(hanaEnv(withFallback)?.rpcFallback).toBe('https://rpc.fallback.example');
    expect((await generated([withFallback]))['sandbox-fb']?.rpcFallback).toBe('https://rpc.fallback.example');
  });

  it('mirrors isDevEnv as devEnv', () => {
    expect(hanaEnv(prod)?.devEnv).toBe(false);
    expect(hanaEnv(manifest({ name: 'local-dev', vaultOrigin: 'http://localhost:8787', authOrigin: 'http://localhost:8788' }))?.devEnv).toBe(true);
  });

  it('skips a manifest without the Hana origins', () => {
    expect(hanaEnv(noOrigins)).toBeNull();
  });
});

describe('envs.generated.ts', () => {
  it('holds every env with both origins, frozen, with signer, relayer and origins pinned', async () => {
    const envs = await generated([prod, noOrigins, sandbox]);
    expect(Object.keys(envs)).toEqual(['prod', 'sandbox-dev']);
    expect(envs['sandbox-dev']).toEqual(hanaEnv(sandbox));
    expect(envs.prod).toMatchObject({ signer: prod.signer, relayer: prod.relayer, vaultOrigin: 'https://vault.hana.example', authOrigin: 'https://auth.hana-login.example', devEnv: false });
    expect(Object.isFrozen(envs)).toBe(true);
    expect(Object.isFrozen(envs.prod)).toBe(true);
  });

  it('is empty when no env sets the origins', async () => {
    expect(await generated([noOrigins])).toEqual({});
  });

  it('carries only public manifest fields', () => {
    const text = envsModule([sandbox]);
    for (const secretish of ['owner', 'mpc', 'googleClientIds', 'consoleAudiences', 'cloudflare', sandbox.owner]) expect(text).not.toContain(secretish);
  });

  it('fails the build when an included env has an unusable CKD key', () => {
    const unset = manifest({ name: 'sandbox-x', ckdNetworkKey: 'UNSET-run-scripts/fetch-ckd-key.ts' });
    expect(() => envsModule([sandbox, unset])).toThrow(/sandbox-x\.json ckdNetworkKey is still the UNSET placeholder/u);
    expect(() => envsModule([manifest({ name: 'sandbox-y', ckdNetworkKey: 'ed25519:abc' })])).toThrow(/sandbox-y\.json ckdNetworkKey is not a valid bls12381g2 point/u);
    // An env without origins gets no pages, so its key doesn't block the others.
    expect(() => envsModule([sandbox, manifest({ name: 'sandbox-z', vaultOrigin: undefined, authOrigin: undefined, ckdNetworkKey: 'UNSET' })])).not.toThrow();
  });

  it('fails the build when an included env still has an UNSET placeholder value', () => {
    const unsetApi = manifest({ name: 'sandbox-u', apiUrl: 'https://UNSET.example' });
    expect(placeholderProblems(hanaEnv(unsetApi)!)).toEqual(['envs/sandbox-u.json apiUrl is still an UNSET placeholder.']);
    expect(() => envsModule([sandbox, unsetApi])).toThrow(/sandbox-u\.json apiUrl is still an UNSET placeholder/u);
    const unsetFallback = manifest({ name: 'sandbox-v', rpcFallback: 'https://UNSET-rpc.example' });
    expect(() => envsModule([unsetFallback])).toThrow(/sandbox-v\.json rpcFallback is still an UNSET placeholder/u);
    // Lower-case "unset" is part of real names (sunset.testnet), not the placeholder convention.
    expect(placeholderProblems(hanaEnv(manifest({ name: 'sandbox-s', signer: 'sunset.testnet' }))!)).toEqual([]);
    expect(placeholderProblems(hanaEnv(sandbox)!)).toEqual([]);
    // An env without origins isn't built, so its placeholders don't block the others.
    expect(() => envsModule([sandbox, manifest({ name: 'sandbox-w', vaultOrigin: undefined, authOrigin: undefined, apiUrl: 'https://UNSET.example' })])).not.toThrow();
  });

  it('the package build (--package) refuses no envs and local envs, and accepts the deployed ones', async () => {
    const local = manifest({ name: 'local-dev', vaultOrigin: 'http://localhost:8787', authOrigin: 'http://localhost:8788' });
    expect(() => envsModule([noOrigins], { forPackage: true })).toThrow(/Can't build the @hana-id\/web package: no envs\/<env>\.json sets both/u);
    expect(() => envsModule([sandbox, local], { forPackage: true })).toThrow(/local-dev is a local \(loopback\) env/u);
    expect(envsModule([sandbox, local])).toContain('"local-dev"'); // the dev build keeps it
    expect(packageEnvsProblem([hanaEnv(sandbox)!, hanaEnv(prod)!])).toBeNull();
    expect(envsModule([sandbox, noOrigins], { forPackage: true })).toBe(envsModule([sandbox, noOrigins]));
    const dir = mkdtempSync(join(tmpdir(), 'hana-gen-envs-'));
    dirs.push(dir);
    expect(main({ manifests: [prod, noOrigins, sandbox], out: join(dir, 'envs.generated.ts'), forPackage: true })).toEqual(['prod', 'sandbox-dev']);
  });

  it('is generated from the real manifests by build, typecheck and test', async () => {
    expect(loadManifests().map((m) => m.name)).toContain('sandbox-dev');
    expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(envsModule(loadManifests()));
    const { HANA_ENVS } = (await import('../src/envs.generated.ts')) as { HANA_ENVS: Readonly<Record<string, HanaEnv>> };
    expect(HANA_ENVS['sandbox-dev']).toEqual(hanaEnv(sandbox));
  });
});

describe('ckdKeyProblem (@hana-id/core)', () => {
  it('accepts the pinned sandbox-dev key', () => {
    expect(ckdKeyProblem(sandbox)).toBeNull();
  });

  it('refuses a bls12381g2:<base58> key that is not a valid G2 point', () => {
    expect(ckdKeyProblem({ name: 'sandbox-w', ckdNetworkKey: 'bls12381g2:abc' })).toMatch(/sandbox-w\.json ckdNetworkKey is not a valid bls12381g2 point/u);
  });
});
