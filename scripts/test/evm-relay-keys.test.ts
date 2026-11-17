// evm-relay-keys (D849): one fresh secp256k1 key, written once into .secrets/<env>/ (0600, directory 0700) in exactly
// the shape the API's gen reads (its own reader, evmRelayKeysLine, accepts the file), never overwritten, never where
// git would track it; prints only the address and the next steps; --show-address for an existing file. The keys
// here are derived test values (sha256 of a phrase, or 1), never real ones.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';
import { evmRelayKeysLine } from '../../apps/api/scripts/gen-wrangler.ts';
import { sponsorFixture } from '../../packages/env/src/evm-sponsor.fixture.ts';
import { evmKeyAddress, evmRelayKeys, freshEvmKey, gitWouldTrack, readEvmRelayKeys, writeSecretJsonOnce } from '../lib/evm-relay-keys.ts';
import { leftoverTempDirs } from './anvil.ts';

const sandbox = loadEnv('sandbox-dev');
const notGit = () => false;
const withRelayer = (address: string): Manifest => ({ ...sandbox, evm: { sponsor: { ...sponsorFixture(), relayerAddress: address } } }) as Manifest;
/** A derived test key and its address (never a real key). */
const TEST_KEY = Uint8Array.from(createHash('sha256').update('hana-id evm-relay-keys test key').digest());
const FILE_START = Date.now();
const made: string[] = [];
/** A temporary root, removed after each test (it can hold a generated key). */
const tmpRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'hana-evm-relay-'));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('evm-relay-keys', () => {
  it('derives the address the textbook way (private key 1)', () => {
    const one = new Uint8Array(32);
    one[31] = 1;
    expect(evmKeyAddress(one)).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });

  it("writes one key once (0600 in a 0700 directory), in the API gen's shape, and prints only its address and the next steps", async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const address = await evmRelayKeys(['sandbox-dev'], { root, log: (l) => lines.push(l), random: () => TEST_KEY.slice(), gitWouldTrack: notGit });
    expect(address).toBe(evmKeyAddress(TEST_KEY));
    const file = join(root, '.secrets', 'sandbox-dev', 'evm-relay-keys.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.secrets', 'sandbox-dev')).mode & 0o777).toBe(0o700);
    const keys = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    expect(keys).toEqual([`0x${Buffer.from(TEST_KEY).toString('hex')}`]);
    // The API's gen accepts the file for a manifest naming this address, and writes the same secret value.
    expect(evmRelayKeysLine(withRelayer(address), keys)).toBe(`EVM_RELAY_KEYS='${JSON.stringify(keys)}'`);
    expect(readEvmRelayKeys(file).value).toBe(JSON.stringify(keys));
    const out = lines.join('\n');
    expect(out).toContain(`The relayer's address: ${address}`);
    expect(out).toContain('evm.sponsor.relayerAddress');
    expect(out).toContain(`env-secrets sandbox-dev --worker api --secret EVM_RELAY_KEYS --yes`);
    expect(out).not.toContain('node -e');
    const hex = Buffer.from(TEST_KEY).toString('hex');
    for (let i = 0; i + 16 <= hex.length; i += 8) expect(out).not.toContain(hex.slice(i, i + 16));
  });

  it('a real run draws 32 fresh bytes each time (two runs, two keys)', async () => {
    const a = await evmRelayKeys(['sandbox-dev'], { root: tmpRoot(), log: () => undefined, gitWouldTrack: notGit });
    const b = await evmRelayKeys(['sandbox-dev'], { root: tmpRoot(), log: () => undefined, gitWouldTrack: notGit });
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(a).not.toBe(b);
  });

  it('draws again for an invalid scalar, and gives up on a broken random source', () => {
    const draws = [new Uint8Array(32), new Uint8Array(32).fill(0xff), TEST_KEY];
    expect(freshEvmKey(() => draws.shift()!)).toEqual(TEST_KEY);
    expect(() => freshEvmKey(() => new Uint8Array(32))).toThrow(/broken/u);
  });

  it('refuses to overwrite the file, leaving it as it was', async () => {
    const root = tmpRoot();
    await evmRelayKeys(['sandbox-dev'], { root, log: () => undefined, random: () => TEST_KEY.slice(), gitWouldTrack: notGit });
    const file = join(root, '.secrets', 'sandbox-dev', 'evm-relay-keys.json');
    const before = readFileSync(file, 'utf8');
    await expect(evmRelayKeys(['sandbox-dev'], { root, log: () => undefined, gitWouldTrack: notGit })).rejects.toThrow(/already exists: refusing to overwrite it/u);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('--show-address prints the existing key\'s address and whether the manifest names it', async () => {
    const root = tmpRoot();
    const address = await evmRelayKeys(['sandbox-dev'], { root, log: () => undefined, random: () => TEST_KEY.slice(), gitWouldTrack: notGit });
    const lines: string[] = [];
    expect(await evmRelayKeys(['sandbox-dev', '--show-address'], { root, log: (l) => lines.push(l) })).toBe(address);
    expect(lines.join('\n')).toContain('has no evm.sponsor yet: put this address in its relayerAddress');
    lines.length = 0;
    await evmRelayKeys(['sandbox-dev', '--show-address'], { root, log: (l) => lines.push(l), loadManifest: () => withRelayer(address) });
    expect(lines.join('\n')).toContain('evm.sponsor.relayerAddress names it');
    await expect(evmRelayKeys(['sandbox-dev', '--show-address'], { root, log: () => undefined, loadManifest: () => withRelayer(sponsorFixture().relayerAddress) })).rejects.toThrow(/relayerAddress is .*not this key's/u);
    await expect(evmRelayKeys(['sandbox-dev', '--show-address'], { root: tmpRoot(), log: () => undefined })).rejects.toThrow(/doesn't exist/u);
  });

  it('reads only a private file of the right shape, never quoting the key', () => {
    const dir = join(tmpRoot(), '.secrets', 'x');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'evm-relay-keys.json');
    const hex = Buffer.from(TEST_KEY).toString('hex');
    for (const [content, mode, msg] of [
      [JSON.stringify([`0x${hex}`]), 0o644, /must be 0600/u],
      [JSON.stringify([`0x${hex.toUpperCase()}`]), 0o600, /one 0x \+ 64 lowercase hex/u],
      [JSON.stringify([`0x${hex}`, `0x${hex}`]), 0o600, /one 0x \+ 64 lowercase hex/u],
      [JSON.stringify(`0x${hex}`), 0o600, /one 0x \+ 64 lowercase hex/u],
      [JSON.stringify([`0x${'0'.repeat(64)}`]), 0o600, /not a valid secp256k1/u],
      [`[0x${hex}`, 0o600, /not valid JSON/u],
    ] as const) {
      writeFileSync(file, content, { mode });
      chmodSync(file, mode);
      let message = '';
      try {
        readEvmRelayKeys(file);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(msg);
      expect(message).not.toContain(hex.slice(8, 40));
    }
  });

  it('refuses a path git would track; accepts one .gitignore covers (and this repo ignores .secrets/)', async () => {
    const repo = tmpRoot();
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    const file = join(repo, '.secrets', 'sandbox-dev', 'evm-relay-keys.json');
    expect(gitWouldTrack(file)).toBe(true);
    await expect(evmRelayKeys(['sandbox-dev'], { root: repo, log: () => undefined })).rejects.toThrow(/not ignored by git here/u);
    writeFileSync(join(repo, '.gitignore'), '.secrets/\n');
    expect(gitWouldTrack(file)).toBe(false);
    await evmRelayKeys(['sandbox-dev'], { root: repo, log: () => undefined });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(gitWouldTrack(join(tmpRoot(), '.secrets', 'e', 'evm-relay-keys.json'))).toBe(false);
    expect(gitWouldTrack(join(process.cwd(), '..', '.secrets', 'sandbox-dev', 'evm-relay-keys.json'))).toBe(false);
  });

  it('never overwrites, even when the file appears between the check and the write (the link fails; the temp file is removed)', async () => {
    const root = tmpRoot();
    const file = join(root, '.secrets', 'sandbox-dev', 'evm-relay-keys.json');
    const other = JSON.stringify(['someone else']);
    await expect(
      evmRelayKeys(['sandbox-dev'], { root, log: () => undefined, random: () => TEST_KEY.slice(), gitWouldTrack: notGit, beforeLink: () => writeFileSync(file, other, { mode: 0o600 }) }),
    ).rejects.toThrow(/already exists: refusing to overwrite it/u);
    expect(readFileSync(file, 'utf8')).toBe(other);
    expect(readdirSync(join(root, '.secrets', 'sandbox-dev'))).toEqual(['evm-relay-keys.json']);
    // The writer alone: written once, then 'exists', the first content kept.
    const f2 = join(root, '.secrets', 'b', 'k.json');
    expect(writeSecretJsonOnce(f2, ['a'])).toBe('written');
    expect(writeSecretJsonOnce(f2, ['b'])).toBe('exists');
    expect(JSON.parse(readFileSync(f2, 'utf8'))).toEqual(['a']);
    expect(statSync(f2).mode & 0o777).toBe(0o600);
    expect(() => writeSecretJsonOnce(join(root, 'plain', 'k.json'), ['a'])).toThrow(/outside a .secrets directory/u);
  });

  it('a .secrets linked elsewhere is judged where it really is: outside every work tree is fine, a target git would track is refused', async () => {
    const repo = tmpRoot();
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    const outside = tmpRoot();
    symlinkSync(outside, join(repo, '.secrets'));
    const file = join(repo, '.secrets', 'sandbox-dev', 'evm-relay-keys.json');
    expect(gitWouldTrack(file)).toBe(false);
    await evmRelayKeys(['sandbox-dev'], { root: repo, log: () => undefined });
    expect(existsSync(join(outside, 'sandbox-dev', 'evm-relay-keys.json'))).toBe(true);
    // A link to a directory inside the same work tree, not ignored: refused.
    const repo2 = tmpRoot();
    expect(spawnSync('git', ['init', '-q'], { cwd: repo2 }).status).toBe(0);
    mkdirSync(join(repo2, 'keys'));
    symlinkSync(join(repo2, 'keys'), join(repo2, '.secrets'));
    await expect(evmRelayKeys(['sandbox-dev'], { root: repo2, log: () => undefined })).rejects.toThrow(/not ignored by git here/u);
    writeFileSync(join(repo2, '.gitignore'), 'keys/\n');
    expect(gitWouldTrack(join(repo2, '.secrets', 'sandbox-dev', 'evm-relay-keys.json'))).toBe(false);
  });

  it('refuses bad arguments and a non-testnet env', async () => {
    await expect(evmRelayKeys([], { root: tmpRoot() })).rejects.toThrow(/<env>/u);
    await expect(evmRelayKeys(['sandbox-dev', '--count', '2'], { root: tmpRoot() })).rejects.toThrow();
    await expect(evmRelayKeys(['sandbox-dev'], { root: tmpRoot(), loadManifest: () => ({ ...sandbox, network: 'mainnet' }) as unknown as Manifest })).rejects.toThrow(/testnet only/u);
  });
});

describe('cleanup', () => {
  it('leaves no hana-evm-relay-* directory of this run behind (they held generated keys)', () => {
    expect(leftoverTempDirs(['hana-evm-relay-'], FILE_START)).toEqual([]);
  });
});
