// gen-wrangler for EVM gas sponsorship (D834–D836): the EVM_SPONSOR var from the manifest's `evm.sponsor` (checked
// against a pinned delegate table, and parsed back by the Worker's parser), the EVM_RELAY_KEYS .dev.vars line, and the
// Worker parser's bounds and chain lists against the schema's.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVM_SPONSOR_BOUNDS as SCHEMA_BOUNDS, isSponsorLoopbackHost as schemaLoopback, LOCAL_EVM_CHAIN_IDS as SCHEMA_LOCAL, loadEnv, type Manifest, manifestSchema, OP_STACK_TEST_CHAIN_IDS as SCHEMA_OP_STACK, sponsorDecimalUnits as schemaDecimal, sponsorRpcUrlProblem as schemaRpcProblem, SPONSOR_TEST_EVM_CHAIN_IDS as SCHEMA_CHAINS, evmSponsorDelegateProblems, repoRoot } from '@hana-id/env';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_APP, FIXTURE_DELEGATE, FIXTURE_PINNED_DELEGATES, fixtureAddress, sponsorFixture } from '../../../../packages/env/src/evm-sponsor.fixture.ts';
import { checksumEvmAddress, EVM_SPONSOR_BOUNDS, evmSponsorVar, isSponsorLoopbackHost, LOCAL_EVM_CHAIN_IDS, OP_STACK_TEST_CHAIN_IDS, parseEvmSponsorConfig, sponsorDecimalUnits, sponsorRpcUrlProblem, SPONSOR_TEST_EVM_CHAIN_IDS } from '../../src/evm/sponsor-config.ts';
import { cli, devVarsContent, EVM_RELAYER_BINDING, EVM_RELAYER_MIGRATION, evmRelayKeysLine, evmSponsorVars, LOCAL_D1_ID, main, TEST_MANIFEST, testWranglerConfig, writeDevVars, writeWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';

/** dotenv's single-quoted value, as wrangler reads .dev.vars (the full parser is in gen-wrangler.test.ts). */
const devVar = (content: string, name: string): string | undefined => new RegExp(`^${name}='([^']*)'$`, 'mu').exec(content)?.[1];

// sandbox-dev's API-only shape (as gen-wrangler.test.ts strips it), plus the fixture block, in memory only.
const { identityToken: _i, emailIssuer: _e, console: _c, files: _f, admin: _a, usage: _u, email: _m, ownerGrantDelayMs: _o, ...base } = loadEnv('sandbox-dev');
const withSponsor = (sponsor: unknown = sponsorFixture(), m: Record<string, unknown> = base): Manifest => manifestSchema.parse({ ...m, evm: { sponsor } });
const vars = (m: Manifest, opts: Parameters<typeof wranglerConfig>[2] = {}) => (wranglerConfig(m, LOCAL_D1_ID, opts) as { vars: Record<string, string> }).vars;

/** A test-only key derived at run time (never a literal), and its EIP-55 address. */
const TEST_KEY = `0x${createHash('sha256').update('hana-id gen-wrangler EVM relay test key').digest('hex')}`;
const TEST_KEY_ADDRESS = checksumEvmAddress(`0x${Buffer.from(keccak_256(secp256k1.getPublicKey(Buffer.from(TEST_KEY.slice(2), 'hex'), false).subarray(1)).subarray(-20)).toString('hex')}`);
const sponsorFor = (relayerAddress: string) => ({ ...sponsorFixture(), relayerAddress });

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hana-gen-evm-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the Worker parser agrees with the schema', () => {
  it('has the same hard bounds and chain lists', () => {
    expect(EVM_SPONSOR_BOUNDS).toEqual(SCHEMA_BOUNDS);
    expect(SPONSOR_TEST_EVM_CHAIN_IDS).toEqual(SCHEMA_CHAINS);
    expect(LOCAL_EVM_CHAIN_IDS).toEqual(SCHEMA_LOCAL);
    expect(OP_STACK_TEST_CHAIN_IDS).toEqual(SCHEMA_OP_STACK);
  });

  it('computes the same EIP-55 checksums', async () => {
    const { checksumEvmAddress: schemaChecksum } = await import('@hana-id/env');
    for (const p of ['a1c3', 'def1', '0bad', '12', 'ffff']) expect(checksumEvmAddress(`0x${p.repeat(40).slice(0, 40)}`)).toBe(schemaChecksum(`0x${p.repeat(40).slice(0, 40)}`));
  });
});

describe('the two packages’ shared rules are the same functions', () => {
  it('the shared block is word for word the same in both files', () => {
    const block = (path: string) => {
      const text = readFileSync(join(repoRoot, path), 'utf8');
      const start = text.indexOf('// ---- Shared with the other package');
      const end = text.indexOf('// ---- End of the shared part.');
      expect(start, path).toBeGreaterThan(0);
      expect(end, path).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(block('apps/api/src/evm/sponsor-config.ts')).toBe(block('packages/env/src/evm-sponsor.ts'));
  });

  it('decimal amounts: the same answer on edge and random values', () => {
    const values: unknown[] = [0, 1, 1e-9, 1e-10, 1.5e-7, 0.01, 0.02, 33.999997859, 64.999995906, 1.0000000001, 100, 1e21, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', null];
    for (let i = 0; i < 2000; i++) values.push(Math.random() * 100, Math.floor(Math.random() * 1e11) / 1e9, Math.floor(Math.random() * 1e13) / 1e12);
    for (const v of values) for (const places of [6, 9]) expect(sponsorDecimalUnits(v, places), `${String(v)} ${places}`).toBe(schemaDecimal(v, places));
  });

  it('RPC URLs and loopback hosts: the same verdict, word for word, in and outside local* envs', () => {
    const urls = [
      'https://sepolia.base.org', 'https://sepolia.base.org/', 'http://sepolia.base.org', 'https://rpc', 'https://node.local', 'https://rpc.example.org.',
      'https://rpc.example.org/v2/key', 'https://rpc.example.org/?k=1', 'https://rpc.example.org/?', 'https://rpc.example.org/#x', 'https://u:p@rpc.example.org',
      'http://127.0.0.1:8545', 'https://127.0.0.1', 'http://localhost.', 'http://a_b.localhost:8545', 'http://[::ffff:127.0.0.1]:8545', 'http://[::1]:8545', 'http://0x7f.1',
      'https://169.254.1.1', 'https://[fe80::1]', 'https://10.0.0.1', 'ftp://x.example', 'ws://127.0.0.1', 'not a url', '',
    ];
    for (const url of urls) for (const local of [true, false]) expect(sponsorRpcUrlProblem(url, local), `${url} ${local}`).toBe(schemaRpcProblem(url, local));
    for (const host of ['localhost', 'localhost.', 'a_b.localhost', 'x.localhost.', '127.1.2.3', '[::1]', '[::ffff:7f00:1]', '[::ffff:7f01:203]', 'example.org', '128.0.0.1', '[::2]']) {
      expect(isSponsorLoopbackHost(host), host).toBe(schemaLoopback(host));
    }
  });

  it('the schema accepts a block exactly when the Worker parses it (for every rule both can check)', () => {
    const c = sponsorFixture().chains['84532']!;
    const text = (s: unknown) => JSON.stringify(s);
    const withChain = (fields: Record<string, unknown>) => text({ ...sponsorFixture(), chains: { '84532': { ...c, ...fields } } });
    const cases: string[] = [
      text(sponsorFixture()),
      withChain({ requireKnownAccount: null }),
      withChain({ rpcFallback: null }),
      withChain({ requireKnownAccount: false }),
      withChain({ maxFeePerGasGwei: 33.999997859, maxGasPerTx: 100_000, minGas: 50_000 }),
      withChain({ maxFeePerGasGwei: 1.0000000001 }),
      withChain({ appDailyBudgetEth: 1e-9 }),
      withChain({ appDailyBudgetEth: 1e-10 }),
      withChain({ rpc: 'https://localhost.' }),
      withChain({ rpc: 'https://a_b.localhost' }),
      withChain({ rpc: 'https://[::ffff:127.0.0.1]' }),
      withChain({ rpc: 'https://169.254.1.1' }),
      withChain({ rpc: 'https://rpc.example.org/v2/key' }),
      withChain({ rpc: 'https://rpc.example.org/?k=1' }),
      withChain({ rpc: 'https://sepolia.base.org/' }),
      ...[
        { exactCalldata: undefined, maxDataBytes: 36 },
        { exactCalldata: [], maxDataBytes: 4 },
        { exactCalldata: null, maxDataBytes: 4 },
        { exactCalldata: ['0x183FF085'], maxDataBytes: 4 },
        { exactCalldata: ['0x183ff08500'], maxDataBytes: 4 },
        { exactCalldata: ['0x183ff08500'], maxDataBytes: 5 },
        { exactCalldata: ['0xa9059cbb'], maxDataBytes: 4 },
        { exactCalldata: ['0x183ff085', '0x183ff085'], maxDataBytes: 4 },
        { exactCalldata: ['0x183ff085'], maxDataBytes: 3 },
        { exactCalldata: ['0x183ff085'], maxDataBytes: 8193 },
        { exactCalldata: ['0x183ff085'], maxDataBytes: undefined },
        { exactCalldata: ['0x183ff085'], maxDataBytes: null },
      ].map((fields) => text({ ...sponsorFixture(), apps: { [FIXTURE_APP]: { '84532': [{ ...sponsorFixture().apps[FIXTURE_APP]!['84532']![0]!, ...fields }] } } })),
      ...['__proto__', 'constructor', 'prototype'].flatMap((key) => [
        text(sponsorFixture()).replace('"chains":{', `"chains":{"${key}":{},`),
        text(sponsorFixture()).replace('"apps":{', `"apps":{"${key}":{"84532":[]},`),
        text(sponsorFixture()).replace(`"${FIXTURE_APP}":{`, `"${FIXTURE_APP}":{"${key}":[],`),
        text(sponsorFixture()).replace('"rpc":', `"${key}":1,"rpc":`),
      ]),
    ];
    for (const json of cases) {
      const schemaOk = manifestSchema.safeParse({ ...base, evm: { sponsor: JSON.parse(json) as unknown } }).success;
      const workerOk = parseEvmSponsorConfig(json, { network: 'testnet', envName: base.name, pinnedDelegates: FIXTURE_PINNED_DELEGATES }).status === 'configured';
      expect(workerOk, json).toBe(schemaOk);
    }
    // requireKnownAccount false: refused by both outside local* envs, accepted by both in one.
    const off = withChain({ requireKnownAccount: false });
    for (const name of [base.name, 'local-dev']) {
      const schemaOk = manifestSchema.safeParse({ ...base, name, evm: { sponsor: JSON.parse(off) as unknown } }).success;
      const workerOk = parseEvmSponsorConfig(off, { network: 'testnet', envName: name, pinnedDelegates: FIXTURE_PINNED_DELEGATES }).status === 'configured';
      expect([name, workerOk], off).toEqual([name, schemaOk]);
      expect(workerOk).toBe(name === 'local-dev');
    }
  });
});

describe('EVM_SPONSOR (D834)', () => {
  it('is not written without the block (sponsorship off), and the tests’ config has none', () => {
    expect(base.evm).toBeUndefined();
    expect(vars(manifestSchema.parse(base))).not.toHaveProperty('EVM_SPONSOR');
    expect(vars(manifestSchema.parse(base), { sponsorDelegates: FIXTURE_PINNED_DELEGATES })).not.toHaveProperty('EVM_SPONSOR');
    expect(vars(TEST_MANIFEST)).not.toHaveProperty('EVM_SPONSOR');
  });

  it('writes the block as exact JSON, which the Worker parses back to the same settings', () => {
    const v = vars(withSponsor(), { sponsorDelegates: FIXTURE_PINNED_DELEGATES });
    expect(v.EVM_SPONSOR).toBe(evmSponsorVar(sponsorFixture()));
    expect(JSON.parse(v.EVM_SPONSOR!)).toEqual(sponsorFixture());
    const parsed = parseEvmSponsorConfig(v.EVM_SPONSOR, { network: v.NETWORK, envName: v.ENV_NAME!, pinnedDelegates: FIXTURE_PINNED_DELEGATES });
    expect(parsed.status).toBe('configured');
    expect(parsed.status === 'configured' && parsed.config.chains['84532']?.dailyBudgetWei).toBe(2n * 10n ** 16n);
    // Never a key: the relayer's is the secret EVM_RELAY_KEYS.
    expect(JSON.stringify(v)).not.toMatch(/EVM_RELAY_KEYS|privateKey/u);
  });

  it('writes it into wrangler.jsonc through writeWranglerConfig', () => {
    const dir = tmp();
    const { path } = writeWranglerConfig(withSponsor(), undefined, dir, undefined, FIXTURE_PINNED_DELEGATES);
    const text = readFileSync(path, 'utf8');
    const config = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { vars: Record<string, string> };
    expect(JSON.parse(config.vars.EVM_SPONSOR!)).toEqual(sponsorFixture());
  });

  it('gen’s command line checks against core’s pinned table (no Base Sepolia entry yet, so 84532 is refused)', async () => {
    expect(SPONSOR_DELEGATES[84532]).toBeUndefined();
    await expect(cli(['sandbox-dev'], { dir: tmp(), loadManifest: () => withSponsor() })).rejects.toThrow(/no pinned delegate for chain 84532/u);
    await expect(cli(['sandbox-dev'], { dir: tmp(), loadManifest: () => base as Manifest })).resolves.toBeUndefined();
    expect(() => main(['sandbox-dev'], { dir: tmp(), loadManifest: () => withSponsor() })).toThrow(/no pinned delegate table/u);
    expect(() => main(['sandbox-dev'], { dir: tmp(), loadManifest: () => withSponsor(), sponsorDelegates: FIXTURE_PINNED_DELEGATES })).not.toThrow();
  });

  it('core’s 31337 pin (the delegate’s deterministic deployment, no placeholder) is accepted in a local* env; chain 31337 only there', () => {
    const pinned = SPONSOR_DELEGATES[31337]!;
    expect(pinned.placeholder).toBe(false);
    const s = sponsorFixture();
    const local = { ...s, chains: { '31337': { ...s.chains['84532']!, opStack: false, delegate: pinned.address, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} };
    expect(evmSponsorDelegateProblems(local, SPONSOR_DELEGATES, 'local-dev')).toEqual([]);
    const raw = evmSponsorVar(local);
    expect(parseEvmSponsorConfig(raw, { network: 'testnet', envName: 'local-dev', pinnedDelegates: SPONSOR_DELEGATES }).status).toBe('configured');
    // Not a placeholder, but chain 31337 itself is a local chain: the schema and the Worker refuse it elsewhere.
    expect(() => withSponsor(local)).toThrow(/31337/u);
    expect(parseEvmSponsorConfig(raw, { network: 'testnet', envName: 'sandbox-dev', pinnedDelegates: SPONSOR_DELEGATES }).status).toBe('unconfigured');
  });

  it('a placeholder entry of the pinned table is accepted in a local* env and refused anywhere else (fixture table)', () => {
    const s = sponsorFixture();
    const local = { ...s, chains: { '31337': { ...s.chains['84532']!, opStack: false, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} };
    const table = { 31337: { address: FIXTURE_DELEGATE, placeholder: true } };
    expect(evmSponsorDelegateProblems(local, table, 'local-dev')).toEqual([]);
    expect(evmSponsorDelegateProblems(local, table, 'sandbox-dev')).toEqual([`evm.sponsor.chains.31337.delegate ${FIXTURE_DELEGATE} is a placeholder entry of the pinned table, only for local* envs`]);
    const raw = evmSponsorVar(local);
    expect(parseEvmSponsorConfig(raw, { network: 'testnet', envName: 'local-dev', pinnedDelegates: table }).status).toBe('configured');
  });

  it('refuses the block without a pinned delegate table, or with a delegate the table doesn’t pin', () => {
    expect(() => evmSponsorVars(withSponsor(), undefined)).toThrow(/no pinned delegate table/u);
    expect(() => vars(withSponsor())).toThrow(/no pinned delegate table/u);
    expect(() => vars(withSponsor(), { sponsorDelegates: {} })).toThrow(/no pinned delegate for chain 84532/u);
    expect(() => vars(withSponsor(), { sponsorDelegates: { 84532: { address: fixtureAddress('0bad') } } })).toThrow(new RegExp(`delegate ${FIXTURE_DELEGATE} is not the pinned delegate`, 'u'));
  });
});

describe('the EVM relayer Durable Object (D851)', () => {
  type DoConfig = { durable_objects: { bindings: { name: string; class_name: string }[] }; migrations: { tag: string; new_sqlite_classes: string[] }[] };
  const base3 = [
    { name: 'RELAYER_KEY', class_name: 'RelayerKey' },
    { name: 'RATE_LIMITER', class_name: 'RateLimiter' },
    { name: 'LOGIN_RELAY', class_name: 'LoginRelay' },
  ];
  const v1v2 = [
    { tag: 'v1', new_sqlite_classes: ['RelayerKey', 'RateLimiter'] },
    { tag: 'v2', new_sqlite_classes: ['LoginRelay'] },
  ];

  it('is not bound, and no migration creates it, in an env without evm.sponsor (sandbox-dev and the test manifest unchanged)', () => {
    for (const m of [manifestSchema.parse(base), TEST_MANIFEST, loadEnv('sandbox-dev')]) {
      const c = wranglerConfig(m, LOCAL_D1_ID, { sponsorDelegates: FIXTURE_PINNED_DELEGATES }) as unknown as DoConfig;
      expect(c.durable_objects.bindings).toEqual(base3);
      expect(c.migrations).toEqual(v1v2);
    }
  });

  it('with evm.sponsor: bound as EVM_RELAYER, created by a v3 SQLite migration after v1 and v2 (which stay as they were)', () => {
    const c = wranglerConfig(withSponsor(), LOCAL_D1_ID, { sponsorDelegates: FIXTURE_PINNED_DELEGATES }) as unknown as DoConfig;
    expect(c.durable_objects.bindings).toEqual([...base3, { name: 'EVM_RELAYER', class_name: 'EvmRelayer' }]);
    expect(c.migrations).toEqual([...v1v2, { tag: 'v3', new_sqlite_classes: ['EvmRelayer'] }]);
    expect(EVM_RELAYER_BINDING).toEqual({ name: 'EVM_RELAYER', class_name: 'EvmRelayer' });
    expect(EVM_RELAYER_MIGRATION.tag).toBe('v3');
  });

  it('the API tests’ config binds it (so the tests run the object) while its vars stay those of an env without the block', () => {
    const c = testWranglerConfig() as unknown as DoConfig & { vars: Record<string, string> };
    expect(c.durable_objects.bindings.map((b) => b.name)).toEqual(['RELAYER_KEY', 'RATE_LIMITER', 'LOGIN_RELAY', 'EVM_RELAYER']);
    expect(c.migrations.map((m) => m.tag)).toEqual(['v1', 'v2', 'v3']);
    expect(c.vars).not.toHaveProperty('EVM_SPONSOR');
  });

  it('the Worker exports the class in every env (a binding needs it; an export without a binding is inert)', () => {
    const index = readFileSync(join(repoRoot, 'apps/api/src/index.ts'), 'utf8');
    expect(index).toMatch(/^export \{ EvmRelayer \} from '\.\/evm-relayer\.ts';$/mu);
  });
});

describe('EVM_RELAY_KEYS in .dev.vars (D834)', () => {
  const m = withSponsor(sponsorFor(TEST_KEY_ADDRESS));

  it('writes one key whose address is relayerAddress, single-quoted', () => {
    const line = evmRelayKeysLine(m, [TEST_KEY]);
    expect(devVar(devVarsContent({ evmRelayKeysLine: line }), 'EVM_RELAY_KEYS')).toBe(JSON.stringify([TEST_KEY]));
  });

  it('refuses a key for another address, malformed keys, and a key file for an env without the block, never quoting the key', () => {
    const errors: string[] = [];
    const attempt = (f: () => unknown) => {
      try {
        f();
        errors.push('no error');
      } catch (e) {
        errors.push((e as Error).message);
      }
    };
    attempt(() => evmRelayKeysLine(withSponsor(), [TEST_KEY]));
    attempt(() => evmRelayKeysLine(m, [TEST_KEY.toUpperCase().replace('0X', '0x')]));
    attempt(() => evmRelayKeysLine(m, [TEST_KEY.slice(2)]));
    attempt(() => evmRelayKeysLine(m, [TEST_KEY, TEST_KEY]));
    attempt(() => evmRelayKeysLine(m, []));
    attempt(() => evmRelayKeysLine(m, TEST_KEY));
    attempt(() => evmRelayKeysLine(m, [`0x${'0'.repeat(64)}`]));
    attempt(() => evmRelayKeysLine(m, [`0x${'f'.repeat(64)}`]));
    attempt(() => evmRelayKeysLine(manifestSchema.parse(base), [TEST_KEY]));
    expect(errors[0]).toMatch(new RegExp(`the key's address is ${TEST_KEY_ADDRESS}, not evm\\.sponsor\\.relayerAddress`, 'u'));
    for (const e of errors.slice(1, 6)) expect(e).toMatch(/must be a JSON array of one 0x \+ 64 lowercase hex secp256k1 private key/u);
    for (const e of errors.slice(6, 8)) expect(e).toMatch(/not a valid secp256k1 private key/u);
    expect(errors[8]).toMatch(/has no evm\.sponsor/u);
    for (const e of errors) expect(e).not.toContain(TEST_KEY.slice(10, 40));
  });

  it('writeDevVars reads .secrets/<env>/evm-relay-keys.json (0600) and counts it', () => {
    const root = tmp();
    const dir = join(root, '.secrets', m.name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'evm-relay-keys.json');
    writeFileSync(file, JSON.stringify([TEST_KEY]), { mode: 0o600 });
    const out = tmp();
    const { path, count } = writeDevVars(m.name, root, out, m);
    expect(count).toBe(1);
    expect(devVar(readFileSync(path, 'utf8'), 'EVM_RELAY_KEYS')).toBe(JSON.stringify([TEST_KEY]));
    // No block in the manifest: the key file is refused, not written.
    expect(() => writeDevVars(m.name, root, tmp(), manifestSchema.parse(base))).toThrow(/has no evm\.sponsor/u);
    chmodSync(file, 0o644);
    expect(() => writeDevVars(m.name, root, tmp(), m)).toThrow(/secret files must be 0600/u);
  });
});
