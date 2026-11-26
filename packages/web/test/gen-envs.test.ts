import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEST_EVM_CHAINS } from '@hana-id/core';
import { type Manifest, LOCAL_EVM_CHAIN_IDS, loadEnv, manifestSchema, OP_STACK_TEST_CHAIN_IDS, SPONSOR_TEST_EVM_CHAIN_IDS } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';
import { ckdKeyProblem } from '../scripts/ckd-key.ts';
import { GENERATED_PATH, envsModule, hanaEnv, loadManifests, main, nearReviewedOf, packageEnvsProblem, placeholderProblems, sponsorProblems, writeAtomically } from '../scripts/gen-envs.ts';
import { REVIEWED_NEAR_DEPLOYS } from '@hana-id/core';
import { FIXTURE_DELEGATE, FIXTURE_PINNED_DELEGATES, FIXTURE_RELAYER, fixtureAddress, sponsorFixture } from '../../env/src/evm-sponsor.fixture.ts';
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

const prod = manifest({ name: 'prod', vaultOrigin: 'https://vault.hana.example', authOrigin: 'https://auth.hana-login.example', admin: { ...sandbox.admin!, accessSessionDuration: undefined } });
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
      // Present exactly when the manifest has the dashboard blocks (batch C11).
      ...(sandbox.files ? { filesOrigin: sandbox.files.origin } : {}),
      // D885: the reviewed, locked demo contracts core records for sandbox-dev.
      nearReviewed: { stamps: sandbox.near?.demoStamps, guestbook: sandbox.near?.demoGuestbook },
    });
  });

  it('passes files.origin through as filesOrigin with the dashboard blocks, and leaves it out otherwise (C11)', () => {
    const files = { workerName: 'hana-id-files-x', origin: 'https://files.example', logosBucket: 'logos-x', statementsBucket: 'statements-x', exportsBucket: 'exports-x' };
    expect(hanaEnv({ ...sandbox, files })?.filesOrigin).toBe('https://files.example');
    expect(hanaEnv({ ...sandbox, files: undefined })).not.toHaveProperty('filesOrigin');
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
    expect(hanaEnv(manifest({ name: 'local-dev', apiUrl: 'http://127.0.0.1:8790', vaultOrigin: 'http://localhost:8787', authOrigin: 'http://localhost:8788' }))?.devEnv).toBe(true);
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
    const local = manifest({ name: 'local-dev', apiUrl: 'http://127.0.0.1:8790', vaultOrigin: 'http://localhost:8787', authOrigin: 'http://localhost:8788' });
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

describe('writeAtomically (several packages regenerate the module at once while others read it)', () => {
  it('writes through a temp file renamed over the target, leaves nothing else, and skips an unchanged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hana-gen-envs-'));
    try {
      const out = join(dir, 'envs.generated.ts');
      writeAtomically(out, 'one');
      expect(readFileSync(out, 'utf8')).toBe('one');
      writeAtomically(out, 'two');
      expect(readFileSync(out, 'utf8')).toBe('two');
      expect(readdirSync(dir)).toEqual(['envs.generated.ts']);
      // The same text again: not rewritten (its inode and mtime stay), so no reader can catch a write in progress.
      const before = statSync(out);
      writeAtomically(out, 'two');
      const after = statSync(out);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      // A changed one is a new file put in place (a rename), never the old one truncated.
      writeFileSync(join(dir, 'probe'), '');
      writeAtomically(out, 'three');
      expect(statSync(out).ino).not.toBe(after.ino);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EVM gas sponsorship in the vault build (D834)', () => {
  const sponsored = manifest({ name: 'sandbox-evm', evm: { sponsor: sponsorFixture() } });

  it('the schema’s sponsorship chains are exactly core’s TEST_EVM_CHAINS, local and OP Stack ones among them', () => {
    expect([...SPONSOR_TEST_EVM_CHAIN_IDS].sort((a, b) => a - b)).toEqual(Object.keys(TEST_EVM_CHAINS).map(Number).sort((a, b) => a - b));
    for (const id of [...LOCAL_EVM_CHAIN_IDS, ...OP_STACK_TEST_CHAIN_IDS]) expect(Object.hasOwn(TEST_EVM_CHAINS, id), String(id)).toBe(true);
  });

  it('puts { chainId: { delegate, relayer } } into the env, and nothing without the block', () => {
    expect(hanaEnv(sponsored)?.evmSponsor).toEqual({ '84532': { delegate: FIXTURE_DELEGATE, relayer: FIXTURE_RELAYER, rpc: 'https://sepolia.base.org', rpcFallback: 'https://base-sepolia-rpc.publicnode.com' } });
    expect(hanaEnv(sandbox)).not.toHaveProperty('evmSponsor');
  });

  it('generates it only after checking the delegates against the pinned table', async () => {
    expect(() => envsModule([sandbox, sponsored])).toThrow(/sandbox-evm\.json has evm\.sponsor, but gen-envs was given no pinned delegate table/u);
    expect(() => envsModule([sponsored], { sponsorDelegates: {} })).toThrow(/no pinned delegate for chain 84532/u);
    expect(() => envsModule([sponsored], { sponsorDelegates: { 84532: { address: fixtureAddress('0bad') } } })).toThrow(/is not the pinned delegate/u);
    expect(envsModule([sandbox])).toBe(envsModule([sandbox], { sponsorDelegates: FIXTURE_PINNED_DELEGATES }));
    const dir = mkdtempSync(join(tmpdir(), 'hana-gen-envs-evm-'));
    dirs.push(dir);
    const out = join(dir, 'envs.generated.ts');
    main({ manifests: [sandbox, sponsored], out, sponsorDelegates: FIXTURE_PINNED_DELEGATES });
    const envs = ((await import(pathToFileURL(out).href)) as { HANA_ENVS: Readonly<Record<string, HanaEnv>> }).HANA_ENVS;
    expect(envs['sandbox-evm']?.evmSponsor).toEqual({ '84532': { delegate: FIXTURE_DELEGATE, relayer: FIXTURE_RELAYER, rpc: 'https://sepolia.base.org', rpcFallback: 'https://base-sepolia-rpc.publicnode.com' } });
    expect(envs['sandbox-dev']).not.toHaveProperty('evmSponsor');
  });

  it('main checks against core’s pinned table by default (no Base Sepolia entry yet, so 84532 is refused)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hana-gen-envs-evm-'));
    dirs.push(dir);
    expect(() => main({ manifests: [sandbox, sponsored], out: join(dir, 'envs.generated.ts') })).toThrow(/no pinned delegate for chain 84532/u);
    expect(() => main({ manifests: [sandbox], out: join(dir, 'envs.generated.ts') })).not.toThrow();
  });

  it('skips the check for an env the pages aren’t built for', () => {
    const noPages = manifest({ name: 'sandbox-nopages', vaultOrigin: undefined, authOrigin: undefined, evm: { sponsor: sponsorFixture() } });
    expect(sponsorProblems(noPages, undefined)).toEqual([]);
    expect(sponsorProblems(manifest({ name: 'sandbox-ph', evm: { sponsor: sponsorFixture() } }), { 84532: { address: FIXTURE_DELEGATE, placeholder: true } })).toEqual([`envs/sandbox-ph.json evm.sponsor.chains.84532.delegate ${FIXTURE_DELEGATE} is a placeholder entry of the pinned table, only for local* envs.`]);
    expect(sponsorProblems(sponsored, FIXTURE_PINNED_DELEGATES)).toEqual([]);
  });
});

describe('Journear’s reviewed NEAR contracts in the build (D885)', () => {
  // Each deployment record in core was checked by a person against exactly these accounts: deployed from the reviewed
  // source and locked (no access key left). A manifest that names another account fails here until that account is
  // reviewed (docs/operations.md "Adding a reviewed NEAR call"): never move a record to an account nobody checked.
  const REVIEWED_ACCOUNTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'sandbox-dev': { stamps: 'hana-id-stamps-dev1.testnet', guestbook: 'hana-id-guestbook-dev1.testnet' },
  };

  it('every record is pinned to the account its manifest names, which is the one that was checked', () => {
    expect(Object.keys(REVIEWED_NEAR_DEPLOYS).sort()).toEqual(Object.keys(REVIEWED_ACCOUNTS).sort());
    for (const [env, record] of Object.entries(REVIEWED_NEAR_DEPLOYS)) {
      const m = loadEnv(env);
      expect(m.near?.demoStamps, `${env} near.demoStamps`).toBe(record.stamps ? REVIEWED_ACCOUNTS[env]?.stamps : undefined);
      expect(m.near?.demoGuestbook, `${env} near.demoGuestbook`).toBe(record.guestbook ? REVIEWED_ACCOUNTS[env]?.guestbook : undefined);
      expect(hanaEnv(m)?.nearReviewed).toEqual(REVIEWED_ACCOUNTS[env]);
    }
  });

  it('only an env with a record gets them, and only the contracts its record names that its manifest has', () => {
    expect(nearReviewedOf(manifest({ name: 'sandbox-other' }))).toEqual({});
    expect(hanaEnv(prod)).not.toHaveProperty('nearReviewed');
    const near = sandbox.near!;
    expect(nearReviewedOf({ ...sandbox, near: { ...near, demoStamps: undefined } })).toEqual({ nearReviewed: { guestbook: near.demoGuestbook } });
    expect(nearReviewedOf({ ...sandbox, near: undefined })).toEqual({});
  });

  it('the build refuses a manifest that names another account than the one checked, or an env off testnet', () => {
    const near = sandbox.near!;
    const moved = { ...sandbox, near: { ...near, demoStamps: 'hana-id-stamps-dev2.testnet' } };
    expect(() => nearReviewedOf(moved)).toThrow(/near\.demoStamps hana-id-stamps-dev2\.testnet is not the account core's REVIEWED_NEAR_DEPLOYS was checked against/u);
    expect(() => hanaEnv(moved)).toThrow(/not the account/u);
    expect(() => nearReviewedOf({ ...sandbox, near: { ...near, demoGuestbook: 'hana-id-guestbook-dev1.testnet.evil.testnet' } })).toThrow(/near\.demoGuestbook/u);
    expect(() => nearReviewedOf({ ...sandbox, network: 'mainnet' as never })).toThrow(/reviewed calls are testnet only/u);
    // Each record holds the sha256 of the account it was checked against, never the name.
    for (const [env, record] of Object.entries(REVIEWED_NEAR_DEPLOYS)) {
      for (const [c, d] of Object.entries(record)) expect(d!.accountSha256, `${env} ${c}`).toBe(createHash('sha256').update(REVIEWED_ACCOUNTS[env]![c]!, 'utf8').digest('hex'));
    }
  });
});
