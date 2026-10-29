// Derivation v1 is FROZEN (docs/batch-b-spec.md "Derivation v1"). These tests are the CI guard: the golden vectors in
// test/vectors/derivation-v1.json (scripts/gen-derivation-vectors.mjs, an independent implementation) must match the
// code, and the vectors file and the DERIVATION_V1 constants must hash to the guard constants below. A failure here
// means an ADDRESS-CHANGING EDIT: every user's Stellar and EVM address would change. Before the address freeze such an
// edit must be called out to the user; after it, never.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { Keypair } from '@stellar/stellar-base';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.ts';
import { borshString, concatBytes, fromHex, sha256, toHex, u32le, utf8 } from '../src/bytes.ts';
import { ckdAppId, decryptCkd, newAppKey } from '../src/ckd.ts';
import {
  DERIVATION_V1,
  accountDescriptors,
  addressesFromCkdSecret,
  chainAddress,
  derivationInfo,
  deriveAddresses,
  evmPrivateKey,
  extractPrk,
  reduceSecp256k1,
  stellarSeed,
  withChainKey,
} from '../src/derivation.ts';
import { exportKeyString } from '../src/export.ts';
import { mpcNetwork, readText, simulateMpc } from './helpers.ts';

/** sha256 of test/vectors/derivation-v1.json, byte for byte. */
const VECTORS_SHA256 = '3d755d584a198b14e07b2f277ea834216feb3ca9c223c351a3a127921e5a2160';
/** sha256 of JSON.stringify(DERIVATION_V1). */
const CONSTANTS_SHA256 = 'c12f9718cbc49f823b4602f5d218afaa84647f5675ce2d1de4ae712c731b751d';

interface ChainVector {
  infoHex: string;
  address: string;
  export: string;
}
interface Vector {
  label: string;
  path?: string;
  appIdHex?: string;
  sHex: string;
  prkHex: string;
  accounts: { account: number; stellar: ChainVector & { seedHex: string }; evm: ChainVector & { okmHex: string; dHex: string } }[];
}
interface VectorFile {
  version: number;
  extractSalt: string;
  expandLabel: string;
  tuples: { stellar: [string, string, number]; evm: [string, string, number] };
  mpc: { signer: string; mskPreimage: string; networkKey: string };
  vectors: Vector[];
}

const VECTORS_TEXT = readText('vectors/derivation-v1.json');
const V = JSON.parse(VECTORS_TEXT) as VectorFile;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const prkOf = (sHex: string) => extractPrk(fromHex(sHex));

describe('derivation v1 guard', () => {
  it('the frozen vectors file is unchanged (address-changing edit otherwise)', () => {
    expect(toHex(sha256(utf8(VECTORS_TEXT))), 'address-changing edit: test/vectors/derivation-v1.json changed').toBe(VECTORS_SHA256);
  });

  it('the DERIVATION_V1 constants are unchanged (address-changing edit otherwise)', () => {
    expect(toHex(sha256(utf8(JSON.stringify(DERIVATION_V1)))), 'address-changing edit: DERIVATION_V1 changed').toBe(CONSTANTS_SHA256);
    expect(DERIVATION_V1).toEqual({
      version: 1,
      extractSalt: 'hana-id/chain-keys/v1/extract',
      expandLabel: 'hana-id/chain-keys/v1/expand',
      stellar: { namespace: 'stellar', curve: 'ed25519', length: 32 },
      evm: { namespace: 'eip155', curve: 'secp256k1', length: 48 },
    });
    expect(Object.isFrozen(DERIVATION_V1) && Object.isFrozen(DERIVATION_V1.stellar) && Object.isFrozen(DERIVATION_V1.evm)).toBe(true);
  });

  it('the vectors file names the same labels and tuples as the code', () => {
    expect(V.version).toBe(DERIVATION_V1.version);
    expect(V.extractSalt).toBe(DERIVATION_V1.extractSalt);
    expect(V.expandLabel).toBe(DERIVATION_V1.expandLabel);
    expect(V.tuples.stellar).toEqual([DERIVATION_V1.stellar.namespace, DERIVATION_V1.stellar.curve, DERIVATION_V1.stellar.length]);
    expect(V.tuples.evm).toEqual([DERIVATION_V1.evm.namespace, DERIVATION_V1.evm.curve, DERIVATION_V1.evm.length]);
  });

  it('golden salt and info bytes (an extract/expand label swap fails here)', () => {
    expect(toHex(utf8(DERIVATION_V1.extractSalt))).toBe('68616e612d69642f636861696e2d6b6579732f76312f65787472616374');
    expect(toHex(derivationInfo('stellar', 'ed25519', 0))).toBe(
      '1c00000068616e612d69642f636861696e2d6b6579732f76312f657870616e64070000007374656c6c6172070000006564323535313900000000',
    );
    expect(toHex(derivationInfo('eip155', 'secp256k1', 1))).toBe(
      '1c00000068616e612d69642f636861696e2d6b6579732f76312f657870616e640600000065697031353509000000736563703235366b3101000000',
    );
    expect(DERIVATION_V1.extractSalt.endsWith('/extract') && DERIVATION_V1.expandLabel.endsWith('/expand')).toBe(true);
  });
});

describe.each(V.vectors)('vector: $label', (v) => {
  it('S → PRK (HKDF-Extract)', () => {
    expect(toHex(prkOf(v.sHex))).toBe(v.prkHex);
  });

  it.each(v.accounts)('account $account: info, seed, okm, d, addresses and export strings', (a) => {
    const prk = prkOf(v.sHex);
    expect(toHex(derivationInfo('stellar', 'ed25519', a.account))).toBe(a.stellar.infoHex);
    expect(toHex(derivationInfo('eip155', 'secp256k1', a.account))).toBe(a.evm.infoHex);
    expect(toHex(stellarSeed(prk, a.account))).toBe(a.stellar.seedHex);
    expect(toHex(reduceSecp256k1(fromHex(a.evm.okmHex)))).toBe(a.evm.dHex);
    expect(toHex(evmPrivateKey(prk, a.account))).toBe(a.evm.dHex);
    expect(deriveAddresses(prk, a.account)).toEqual({ stellar: a.stellar.address, evm: a.evm.address });
    expect(exportKeyString(prk, 'stellar', a.account)).toBe(a.stellar.export);
    expect(exportKeyString(prk, 'evm', a.account)).toBe(a.evm.export);
    expect(accountDescriptors(prk, 0, a.account)).toEqual([
      { derivation: 1, keyIndex: 0, namespace: 'stellar', curve: 'ed25519', account: a.account, address: a.stellar.address },
      { derivation: 1, keyIndex: 0, namespace: 'eip155', curve: 'secp256k1', account: a.account, address: a.evm.address },
    ]);
  });

  it.each(v.accounts)('account $account: independent WebCrypto HKDF and BigInt FIPS 186-5 A.2.1 reduction', async (a) => {
    const ikm = await crypto.subtle.importKey('raw', fromHex(v.sHex), 'HKDF', false, ['deriveBits']);
    const derive = (info: string, bits: number) =>
      crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(DERIVATION_V1.extractSalt), info: fromHex(info) }, ikm, bits).then((b) => toHex(new Uint8Array(b)));
    expect(await derive(a.stellar.infoHex, 256)).toBe(a.stellar.seedHex);
    expect(await derive(a.evm.infoHex, 384)).toBe(a.evm.okmHex);
    const d = (BigInt(`0x${a.evm.okmHex}`) % (N - 1n)) + 1n;
    expect(d.toString(16).padStart(64, '0')).toBe(a.evm.dHex);
  });

  it.each(v.accounts)('account $account: stellar-base Keypair and viem import the keys at the same addresses', (a) => {
    expect(Keypair.fromRawEd25519Seed(Buffer.from(a.stellar.seedHex, 'hex')).publicKey()).toBe(a.stellar.address);
    expect(Keypair.fromSecret(a.stellar.export).publicKey()).toBe(a.stellar.address);
    expect(privateKeyToAccount(a.evm.export as `0x${string}`).address).toBe(a.evm.address);
  });
});

describe('derivation v1: CKD to address (key_index variants)', () => {
  const msk = BigInt(`0x${toHex(sha256(utf8(V.mpc.mskPreimage)))}`) % bls.fields.Fr.ORDER;
  const net = mpcNetwork(msk);

  it('the test MPC network key is the one in the vectors', () => {
    expect(net.networkKey).toBe(V.mpc.networkKey);
  });

  it.each(V.vectors.filter((v) => v.path))('$label: path → app_id → decryptCkd(S) → addresses', (v) => {
    const key = newAppKey();
    const appId = ckdAppId(V.mpc.signer, v.path!);
    expect(toHex(appId)).toBe(v.appIdHex);
    const { response } = simulateMpc(key.publicKey.AppPublicKeyPV.pk1, appId, net);
    const s = decryptCkd(response, key.a, appId, net.networkKey);
    expect(toHex(s)).toBe(v.sHex);
    expect(addressesFromCkdSecret(s)).toEqual({ stellar: v.accounts[0]!.stellar.address, evm: v.accounts[0]!.evm.address });
    expect([...s].every((b) => b === 0)).toBe(true);
  });

  it('key_index 0 and 1 of the same user and scope give different addresses', () => {
    const [k0, k1] = V.vectors;
    expect(k0!.path!.endsWith('#0') && k1!.path!.endsWith('#1')).toBe(true);
    expect(k1!.accounts[0]!.stellar.address).not.toBe(k0!.accounts[0]!.stellar.address);
    expect(k1!.accounts[0]!.evm.address).not.toBe(k0!.accounts[0]!.evm.address);
  });
});

describe('reduceSecp256k1 (FIPS 186-5 A.2.1)', () => {
  const okm = (n: bigint): Uint8Array => fromHex(n.toString(16).padStart(96, '0'));
  const d = (n: bigint): string => ((n % (N - 1n)) + 1n).toString(16).padStart(64, '0');

  it.each([
    ['0', 0n, 1n],
    ['n − 2', N - 2n, N - 1n],
    ['n − 1', N - 1n, 1n],
    ['n', N, 2n],
    ['2^384 − 1', (1n << 384n) - 1n, null],
  ] as const)('okm = %s', (_, input, expected) => {
    const out = toHex(reduceSecp256k1(okm(input)));
    expect(out).toBe(d(input));
    if (expected !== null) expect(out).toBe(expected.toString(16).padStart(64, '0'));
    const k = BigInt(`0x${out}`);
    expect(k >= 1n && k <= N - 1n).toBe(true);
  });

  it('takes exactly 48 bytes', () => {
    expect(() => reduceSecp256k1(new Uint8Array(32))).toThrow(/48 bytes/);
    expect(() => reduceSecp256k1(new Uint8Array(64))).toThrow(/48 bytes/);
  });
});

describe('separation', () => {
  const S = () => fromHex(V.vectors[0]!.sHex);

  it('namespace, curve, account, version (salt) and S each change the key', async () => {
    const prk = extractPrk(S());
    const base = toHex(stellarSeed(prk, 0));
    const expand = async (salt: string, info: Uint8Array) => {
      const ikm = await crypto.subtle.importKey('raw', S(), 'HKDF', false, ['deriveBits']);
      return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: Uint8Array.from(info) }, ikm, 256)));
    };
    expect(await expand(DERIVATION_V1.extractSalt, derivationInfo('stellar', 'ed25519', 0))).toBe(base);
    expect(await expand(DERIVATION_V1.extractSalt, derivationInfo('stellar', 'ed25519', 1))).not.toBe(base);
    expect(await expand(DERIVATION_V1.extractSalt, derivationInfo('stellarx', 'ed25519', 0))).not.toBe(base);
    expect(await expand(DERIVATION_V1.extractSalt, derivationInfo('stellar', 'sr25519', 0))).not.toBe(base);
    expect(await expand('hana-id/chain-keys/v2/extract', derivationInfo('stellar', 'ed25519', 0))).not.toBe(base);
    const v2Info = concatBytes(borshString('hana-id/chain-keys/v2/expand'), borshString('stellar'), borshString('ed25519'), u32le(0));
    expect(await expand(DERIVATION_V1.extractSalt, v2Info)).not.toBe(base);
    const s2 = S();
    s2[47] = s2[47]! ^ 1;
    expect(toHex(stellarSeed(extractPrk(s2), 0))).not.toBe(base);
    // One PRK, two chains: unrelated keys.
    expect(toHex(evmPrivateKey(prk, 0))).not.toBe(base);
  });

  it('the per-chain addresses of distinct vectors never collide', () => {
    const all = V.vectors.flatMap((v) => v.accounts.flatMap((a) => [a.stellar.address, a.evm.address]));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('grammar', () => {
  it.each([
    ['ab', 'ed25519', 0],
    ['abcdefghi', 'ed25519', 0],
    ['Stellar', 'ed25519', 0],
    ['eip_155', 'secp256k1', 0],
    ['stellar', '', 0],
    ['stellar', 'Ed25519', 0],
    ['stellar', 'a'.repeat(17), 0],
    ['stellar', 'ed-25519', 0],
  ])('refuses namespace %j, curve %j', (ns, curve, account) => {
    expect(() => derivationInfo(ns, curve, account)).toThrow(/namespace|curve/);
  });

  it('refuses an account outside u32', () => {
    expect(() => derivationInfo('stellar', 'ed25519', -1)).toThrow(/u32/);
    expect(() => derivationInfo('stellar', 'ed25519', 2 ** 32)).toThrow(/u32/);
    expect(() => derivationInfo('stellar', 'ed25519', 0.5)).toThrow(/u32/);
  });

  it('accepts CAIP-2 style namespaces', () => {
    expect(() => derivationInfo('cosmos', 'secp256k1', 0)).not.toThrow();
    expect(() => derivationInfo('bip122', 'secp256k1', 0)).not.toThrow();
    expect(() => derivationInfo('near-x', 'ed25519', 4294967295)).not.toThrow();
  });

  it('refuses an S that is not 48 bytes and a PRK that is not 32 bytes', () => {
    expect(() => extractPrk(new Uint8Array(32))).toThrow(/48 bytes/);
    expect(() => stellarSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe('zeroisation', () => {
  it('extractPrk zeroes S, also when it throws', () => {
    const s = fromHex(V.vectors[0]!.sHex);
    extractPrk(s);
    expect([...s].every((b) => b === 0)).toBe(true);
    const short = new Uint8Array(47).fill(9);
    expect(() => extractPrk(short)).toThrow();
    expect([...short].every((b) => b === 0)).toBe(true);
  });

  it('withChainKey zeroes the key after use, also when the callback throws', () => {
    const prk = prkOf(V.vectors[0]!.sHex);
    let seen: Uint8Array | null = null;
    const len = withChainKey(prk, 'evm', 0, (k) => {
      seen = k;
      return k.length;
    });
    expect(len).toBe(32);
    expect([...seen!].every((b) => b === 0)).toBe(true);
    expect(() =>
      withChainKey(prk, 'stellar', 0, (k) => {
        seen = k;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect([...seen!].every((b) => b === 0)).toBe(true);
    expect(() => withChainKey(prk, 'stellar', 0, async () => 1)).toThrow(/synchronous/);
  });

  it('addressesFromCkdSecret zeroes S; chainAddress leaves PRK intact for the caller', () => {
    const s = fromHex(V.vectors[1]!.sHex);
    addressesFromCkdSecret(s);
    expect([...s].every((b) => b === 0)).toBe(true);
    const prk = prkOf(V.vectors[1]!.sHex);
    chainAddress(prk, 'stellar');
    expect(toHex(prk)).toBe(V.vectors[1]!.prkHex);
  });
});

describe('the PROVISIONAL derivation is gone', () => {
  it('no PROVISIONAL constant or legacy salt is exported', () => {
    expect(Object.keys(core).filter((k) => /provisional/i.test(k))).toEqual([]);
    expect(JSON.stringify(Object.values(core).filter((v) => typeof v === 'string' || (typeof v === 'object' && v !== null && !ArrayBuffer.isView(v))))).not.toContain('hana-embed');
  });
});
