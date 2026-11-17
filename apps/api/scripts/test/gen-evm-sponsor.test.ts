// gen-wrangler for EVM gas sponsorship (D834–D836): the EVM_SPONSOR var from the manifest's `evm.sponsor` (checked
// against a pinned delegate table, and parsed back by the Worker's parser), the EVM_RELAY_KEYS .dev.vars line, and the
// Worker parser's bounds and chain lists against the schema's.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVM_SPONSOR_BOUNDS as SCHEMA_BOUNDS, LOCAL_EVM_CHAIN_IDS as SCHEMA_LOCAL, loadEnv, type Manifest, manifestSchema, OP_STACK_TEST_CHAIN_IDS as SCHEMA_OP_STACK, SPONSOR_TEST_EVM_CHAIN_IDS as SCHEMA_CHAINS } from '@hana-id/env';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_DELEGATE, FIXTURE_PINNED_DELEGATES, fixtureAddress, sponsorFixture } from '../../../../packages/env/src/evm-sponsor.fixture.ts';
import { checksumEvmAddress, EVM_SPONSOR_BOUNDS, evmSponsorVar, LOCAL_EVM_CHAIN_IDS, OP_STACK_TEST_CHAIN_IDS, parseEvmSponsorConfig, SPONSOR_TEST_EVM_CHAIN_IDS } from '../../src/evm/sponsor-config.ts';
import { devVarsContent, evmRelayKeysLine, evmSponsorVars, LOCAL_D1_ID, TEST_MANIFEST, writeDevVars, writeWranglerConfig, wranglerConfig } from '../gen-wrangler.ts';

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
    const parsed = parseEvmSponsorConfig(v.EVM_SPONSOR, { network: v.NETWORK, envName: v.ENV_NAME! });
    expect(parsed.status).toBe('configured');
    expect(parsed.status === 'configured' && parsed.config.chains.get(84532)?.dailyBudgetWei).toBe(2n * 10n ** 16n);
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

  it('refuses the block without a pinned delegate table, or with a delegate the table doesn’t pin', () => {
    expect(() => evmSponsorVars(withSponsor(), undefined)).toThrow(/no pinned delegate table/u);
    expect(() => vars(withSponsor())).toThrow(/no pinned delegate table/u);
    expect(() => vars(withSponsor(), { sponsorDelegates: {} })).toThrow(/no pinned delegate for chain 84532/u);
    expect(() => vars(withSponsor(), { sponsorDelegates: { 84532: { address: fixtureAddress('0bad') } } })).toThrow(new RegExp(`delegate ${FIXTURE_DELEGATE} is not the pinned delegate`, 'u'));
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
