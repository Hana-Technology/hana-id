// NEAR's derivation v1 tuple ("near", "ed25519", account), added 2026-11-11 (D720), FROZEN at the address freeze like
// the rest of derivation v1. It is additive: DERIVATION_V1 and its vectors (test/derivation.test.ts) are untouched, and
// this file is NEAR's own guard: the golden vectors in test/vectors/derivation-v1-near.json
// (scripts/gen-derivation-near-vectors.mjs, an independent implementation) must match the code, and the vectors file
// and DERIVATION_V1_NEAR must hash to the constants below. A failure here means an ADDRESS-CHANGING EDIT: every user's
// NEAR account would change. Before the address freeze such an edit must be called out to the user; after it, never.
import { KeyPair } from '@near-js/crypto';
import { describe, expect, it } from 'vitest';
import { isNearAccountId, isNearImplicitAccountId, isNearPublicKey, nearImplicitAccountId, nearImplicitPublicKey, nearPublicKeyString, parseNearPublicKey } from '../src/addresses.ts';
import { fromHex, sha256, toHex, utf8 } from '../src/bytes.ts';
import {
  DERIVATION_V1,
  DERIVATION_V1_NEAR,
  chainAddress,
  chainPrivateKey,
  derivationInfo,
  deriveAddresses,
  deriveWalletAddresses,
  extractPrk,
  nearPublicKey,
  nearSeed,
  stellarSeed,
  withChainKey,
} from '../src/derivation.ts';
import { addressOfExport, exportKeyString, nearSecretKey } from '../src/export.ts';
import { readText } from './helpers.ts';

/** sha256 of test/vectors/derivation-v1-near.json, byte for byte. */
const NEAR_VECTORS_SHA256 = 'a4dbe7c5e910cfcf063a19f28f59b1e509a2e430d26c742bc10b3f369a77aa68';
/** sha256 of JSON.stringify(DERIVATION_V1_NEAR). */
const NEAR_CONSTANTS_SHA256 = 'f72c6eaf07fd5f28fb77fb468808d44bb3bfb641efe684ff291c685bf57cfa45';

interface NearVector {
  label: string;
  sHex: string;
  prkHex: string;
  accounts: { account: number; near: { infoHex: string; seedHex: string; publicKey: string; accountId: string; exportBase58: string } }[];
}
interface NearVectorFile {
  version: number;
  extractSalt: string;
  expandLabel: string;
  tuple: [string, string, number];
  vectors: NearVector[];
}

const exportOf = (a: { near: { exportBase58: string } }): string => `ed25519:${a.near.exportBase58}`;
const TEXT = readText('vectors/derivation-v1-near.json');
const V = JSON.parse(TEXT) as NearVectorFile;
const BASE = JSON.parse(readText('vectors/derivation-v1.json')) as { vectors: { sHex: string; accounts: { stellar: { address: string }; evm: { address: string } }[] }[] };

describe('derivation v1 NEAR guard', () => {
  it('the frozen NEAR vectors file is unchanged (address-changing edit otherwise)', () => {
    expect(toHex(sha256(utf8(TEXT))), 'address-changing edit: test/vectors/derivation-v1-near.json changed').toBe(NEAR_VECTORS_SHA256);
  });

  it('DERIVATION_V1_NEAR is unchanged and frozen (address-changing edit otherwise)', () => {
    expect(toHex(sha256(utf8(JSON.stringify(DERIVATION_V1_NEAR)))), 'address-changing edit: DERIVATION_V1_NEAR changed').toBe(NEAR_CONSTANTS_SHA256);
    expect(DERIVATION_V1_NEAR).toEqual({ namespace: 'near', curve: 'ed25519', length: 32 });
    expect(Object.isFrozen(DERIVATION_V1_NEAR)).toBe(true);
  });

  it('is additive: DERIVATION_V1 gains no member, and the vectors use its salt and label', () => {
    expect(Object.keys(DERIVATION_V1)).toEqual(['version', 'extractSalt', 'expandLabel', 'stellar', 'evm']);
    expect([V.version, V.extractSalt, V.expandLabel]).toEqual([DERIVATION_V1.version, DERIVATION_V1.extractSalt, DERIVATION_V1.expandLabel]);
    expect(V.tuple).toEqual([DERIVATION_V1_NEAR.namespace, DERIVATION_V1_NEAR.curve, DERIVATION_V1_NEAR.length]);
  });

  it('golden info bytes', () => {
    expect(toHex(derivationInfo('near', 'ed25519', 0))).toBe(
      '1c00000068616e612d69642f636861696e2d6b6579732f76312f657870616e64040000006e656172070000006564323535313900000000',
    );
  });

  it('the vectors use the same S as the Stellar and EVM vectors', () => {
    expect(V.vectors.map((v) => v.sHex)).toEqual(BASE.vectors.map((v) => v.sHex));
  });
});

describe.each(V.vectors)('NEAR vector: $label', (v) => {
  it.each(v.accounts)('account $account: info, seed, account id, public key and export string', (a) => {
    const prk = extractPrk(fromHex(v.sHex));
    expect(toHex(prk)).toBe(v.prkHex);
    expect(toHex(derivationInfo('near', 'ed25519', a.account))).toBe(a.near.infoHex);
    expect(toHex(nearSeed(prk, a.account))).toBe(a.near.seedHex);
    expect(toHex(chainPrivateKey(prk, 'near', a.account))).toBe(a.near.seedHex);
    expect(chainAddress(prk, 'near', a.account)).toBe(a.near.accountId);
    expect(nearPublicKeyString(nearPublicKey(prk, a.account))).toBe(a.near.publicKey);
    expect(exportKeyString(prk, 'near', a.account)).toBe(exportOf(a));
    expect(addressOfExport('near', exportOf(a))).toBe(a.near.accountId);
  });

  it.each(v.accounts)('account $account: @near-js/crypto imports the export string at the same key', (a) => {
    const kp = KeyPair.fromString(exportOf(a) as `ed25519:${string}`);
    expect(kp.getPublicKey().toString()).toBe(a.near.publicKey);
    expect(toHex(kp.getPublicKey().data)).toBe(a.near.accountId);
    // A signature by the imported key verifies under the vault's public key.
    const msg = utf8('hana near vector');
    expect(kp.verify(msg, kp.sign(msg).signature)).toBe(true);
  });

  it('the Stellar and EVM addresses of this S are unchanged; deriveWalletAddresses adds NEAR only', () => {
    const prk = extractPrk(fromHex(v.sHex));
    const base = BASE.vectors.find((b) => b.sHex === v.sHex)!.accounts[0]!;
    expect(deriveAddresses(prk)).toEqual({ stellar: base.stellar.address, evm: base.evm.address });
    expect(deriveWalletAddresses(prk)).toEqual({ stellar: base.stellar.address, evm: base.evm.address, near: v.accounts[0]!.near.accountId });
  });
});

describe('NEAR separation and zeroisation', () => {
  it('the NEAR seed is not the Stellar seed (same curve, other namespace)', () => {
    const prk = extractPrk(fromHex(V.vectors[0]!.sHex));
    expect(toHex(nearSeed(prk, 0))).not.toBe(toHex(stellarSeed(prk, 0)));
    const all = V.vectors.flatMap((v) => v.accounts.map((a) => a.near.accountId));
    expect(new Set(all).size).toBe(all.length);
  });

  it('withChainKey zeroes the NEAR seed after use', () => {
    const prk = extractPrk(fromHex(V.vectors[0]!.sHex));
    let seen: Uint8Array | null = null;
    withChainKey(prk, 'near', 0, (k) => {
      seen = k;
    });
    expect([...seen!].every((b) => b === 0)).toBe(true);
  });

  it('nearSecretKey takes a 32-byte seed', () => {
    expect(() => nearSecretKey(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe('NEAR address helpers', () => {
  const id = V.vectors[0]!.accounts[0]!.near.accountId;
  const pk = V.vectors[0]!.accounts[0]!.near.publicKey;

  it('implicit account id ⇄ public key', () => {
    expect(nearImplicitAccountId(nearImplicitPublicKey(id))).toBe(id);
    expect(nearPublicKeyString(nearImplicitPublicKey(id))).toBe(pk);
    expect(toHex(parseNearPublicKey(pk).bytes)).toBe(id);
    expect(() => nearImplicitAccountId(new Uint8Array(31))).toThrow();
    expect(() => nearImplicitPublicKey(id.toUpperCase())).toThrow();
  });

  it.each([
    [id, true],
    ['0'.repeat(64), true],
    [id.toUpperCase(), false],
    [id.slice(1), false],
    [`${id}0`, false],
    ['alice.testnet', false],
  ])('isNearImplicitAccountId(%j) = %j', (v, ok) => {
    expect(isNearImplicitAccountId(v)).toBe(ok);
  });

  it.each([
    ['alice.testnet', true],
    ['hana-id-signer-dev1.testnet', true],
    ['a_b-c.d', true],
    ['ab', true],
    [id, true],
    ['0x' + 'ab'.repeat(20), true],
    ['a', false],
    ['a'.repeat(65), false],
    ['Alice.testnet', false],
    ['alice..testnet', false],
    ['.alice', false],
    ['alice.', false],
    ['al--ice', false],
    ['alice_.near', false],
    ['al ice', false],
    ['alice@near', false],
    ['аlice.near', false], // Cyrillic а
    [12, false],
  ])('isNearAccountId(%j) = %j', (v, ok) => {
    expect(isNearAccountId(v)).toBe(ok);
  });

  it('parses NEAR public keys strictly', () => {
    expect(isNearPublicKey(pk)).toBe(true);
    expect(isNearPublicKey(pk.slice('ed25519:'.length))).toBe(false);
    expect(isNearPublicKey(`ED25519:${pk.slice(8)}`)).toBe(false);
    expect(isNearPublicKey(`${pk}1`)).toBe(false);
    expect(isNearPublicKey(`secp256k1:${pk.slice(8)}`)).toBe(false);
    expect(isNearPublicKey('ed25519:0OIl')).toBe(false);
    expect(isNearPublicKey(null)).toBe(false);
    // Leading zero bytes are '1's in base58: a key of all zeros round-trips.
    expect(isNearPublicKey(nearPublicKeyString(new Uint8Array(32)))).toBe(true);
  });

  it('addressOfExport refuses malformed NEAR secret keys', () => {
    const exp = exportOf(V.vectors[0]!.accounts[0]!);
    expect(() => addressOfExport('near', exp.slice(8))).toThrow();
    expect(() => addressOfExport('near', `${exp}1`)).toThrow();
    // The halves of another vector's key, swapped in: the public half no longer matches the seed.
    const other = KeyPair.fromString(exportOf(V.vectors[1]!.accounts[0]!) as `ed25519:${string}`);
    const mine = KeyPair.fromString(exp as `ed25519:${string}`);
    const mixed = nearSecretKey(fromHex(V.vectors[0]!.accounts[0]!.near.seedHex));
    expect(addressOfExport('near', mixed)).toBe(toHex(mine.getPublicKey().data));
    const forged = `ed25519:${exp.slice(8, 30)}${other.toString().slice(30)}`;
    expect(() => addressOfExport('near', forged)).toThrow();
  });
});
