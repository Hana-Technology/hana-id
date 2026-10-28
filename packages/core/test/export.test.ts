// Key export encodings and address encodings: SEP-23 StrKeys (G…, S…) and EIP-55, checked against stellar-base and viem.
import { secp256k1 } from '@noble/curves/secp256k1';
import { Keypair, StrKey } from '@stellar/stellar-base';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { STRKEY_VERSION, checksumEvmAddress, decodeStrKey, encodeStrKey, evmAddress, isEvmAddress, isStellarAddress, parseEvmAddress, stellarAddress } from '../src/addresses.ts';
import { fromHex, toHex } from '../src/bytes.ts';
import { extractPrk } from '../src/derivation.ts';
import { addressOfExport, evmPrivateKeyHex, exportKeyString, stellarSecretSeed } from '../src/export.ts';

const S = fromHex('b87c634c70a33c5422dbb6d2bd0384004dcda96c209f2da747c79070afa83bace1da710748d27c4721ce358eacef1453');

describe('Stellar StrKey', () => {
  it('G…: StrKey of a known Ed25519 public key (SEP-23 vector)', () => {
    expect(stellarAddress(fromHex('3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a'))).toBe('GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ');
    expect(() => stellarAddress(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('S…: matches stellar-base for random seeds and re-imports to the same G…', () => {
    for (let i = 0; i < 8; i++) {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const kp = Keypair.fromRawEd25519Seed(Buffer.from(seed));
      expect(stellarSecretSeed(seed)).toBe(kp.secret());
      expect(stellarAddress(kp.rawPublicKey())).toBe(kp.publicKey());
      expect(toHex(decodeStrKey(STRKEY_VERSION.ed25519SecretSeed, kp.secret()))).toBe(toHex(seed));
    }
  });

  it('refuses a bad checksum, the wrong version and malformed text', () => {
    const g = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
    const flipped = `${g.slice(0, 10)}${g[10] === 'A' ? 'B' : 'A'}${g.slice(11)}`;
    expect(() => decodeStrKey(STRKEY_VERSION.ed25519PublicKey, flipped)).toThrow(/checksum/);
    expect(() => decodeStrKey(STRKEY_VERSION.ed25519SecretSeed, g)).toThrow(/version/);
    expect(() => decodeStrKey(STRKEY_VERSION.ed25519PublicKey, g.toLowerCase())).toThrow(/Malformed/);
    expect(() => decodeStrKey(STRKEY_VERSION.ed25519PublicKey, g.slice(1))).toThrow(/Malformed/);
    expect(isStellarAddress(g)).toBe(true);
    expect(isStellarAddress(flipped)).toBe(false);
    expect(StrKey.isValidEd25519PublicKey(flipped)).toBe(false);
  });

  it('encodes contracts (C…) like stellar-base', () => {
    const id = crypto.getRandomValues(new Uint8Array(32));
    expect(encodeStrKey(STRKEY_VERSION.contract, id)).toBe(StrKey.encodeContract(Buffer.from(id)));
  });
});

describe('EVM EIP-55', () => {
  it('address of a known key (web3.js accounts example), compressed or not', () => {
    const pub = secp256k1.getPublicKey(fromHex('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'), false);
    expect(evmAddress(pub)).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    expect(evmAddress(secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(true))).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  });

  it('checksums like viem getAddress', () => {
    for (let i = 0; i < 8; i++) {
      const a = crypto.getRandomValues(new Uint8Array(20));
      expect(checksumEvmAddress(a)).toBe(getAddress(`0x${toHex(a)}`));
    }
  });

  it('parses lower, upper and valid checksummed case, and refuses a broken checksum', () => {
    const a = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
    expect(toHex(parseEvmAddress(a))).toBe('2c7536e3605d9c16a7a3d7b1898e529396a65c23');
    expect(isEvmAddress(a.toLowerCase())).toBe(true);
    expect(isEvmAddress(`0x${a.slice(2).toUpperCase()}`)).toBe(true);
    expect(isEvmAddress(a.replace('E', 'e'))).toBe(false);
    expect(isEvmAddress('0x2c75')).toBe(false);
    expect(isEvmAddress('2c7536E3605D9C16a7a3D7b1898e529396a65c23')).toBe(false);
  });
});

describe('export strings', () => {
  it('Stellar S… and EVM 0x hex re-import to the addresses derived from the same PRK', () => {
    const prk = extractPrk(Uint8Array.from(S));
    for (const account of [0, 1]) {
      const st = exportKeyString(prk, 'stellar', account);
      const ev = exportKeyString(prk, 'evm', account);
      expect(st).toMatch(/^S[A-Z2-7]{55}$/u);
      expect(ev).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(Keypair.fromSecret(st).publicKey()).toBe(addressOfExport('stellar', st));
      expect(privateKeyToAccount(ev as `0x${string}`).address).toBe(addressOfExport('evm', ev));
    }
  });

  it('addressOfExport refuses a bad StrKey checksum, uppercase or out-of-range EVM keys', () => {
    const prk = extractPrk(Uint8Array.from(S));
    const st = exportKeyString(prk, 'stellar');
    const bad = `${st.slice(0, 20)}${st[20] === 'A' ? 'B' : 'A'}${st.slice(21)}`;
    expect(() => addressOfExport('stellar', bad)).toThrow();
    expect(() => addressOfExport('stellar', stellarAddress(new Uint8Array(32)))).toThrow(/version/);
    const ev = exportKeyString(prk, 'evm');
    expect(() => addressOfExport('evm', ev.toUpperCase().replace('0X', '0x'))).toThrow(/Malformed/);
    expect(() => addressOfExport('evm', `0x${'0'.repeat(64)}`)).toThrow(/range/);
    expect(() => addressOfExport('evm', `0x${'f'.repeat(64)}`)).toThrow(/range/);
  });

  it('encoders refuse wrong lengths', () => {
    expect(() => stellarSecretSeed(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => evmPrivateKeyHex(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});
