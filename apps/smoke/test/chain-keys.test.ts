import { secp256k1 } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8 } from '../src/bytes.ts';
import { PROVISIONAL_HKDF, deriveAddresses, evmAddress, stellarAddress } from '../src/chain-keys.ts';

describe('PROVISIONAL chain-key derivation', () => {
  it('keeps the legacy HKDF salt and info strings (legacy/client/ckd.ts)', () => {
    expect(PROVISIONAL_HKDF).toEqual({
      salt: 'hana-embed-ckd-v1',
      info: { evm: 'hana-embed evm secp256k1 v1', stellar: 'hana-embed stellar ed25519 v1' },
    });
  });

  // Reference values from the legacy pipeline itself: @noble/hashes hkdf → viem privateKeyToAccount and
  // @stellar/stellar-sdk Keypair.fromRawEd25519Seed (computed once outside this repo).
  it.each([
    [7, 'GABXAXT6QEPA75WEYQ6ESY6A3CCLAEJMEHGZVWD3UW3SE6MC4UKX6GGA', '0xB5270FFceE0235F9221d9115116b9d6Cfed63db0'],
    [8, 'GDYPPJY5ZJXCPIMYX6XTDL52REKJLNDETPYT22UCFE4UDXAZHSIZMBLO', '0xc6D4B8D5FDC15E365B19ec8Ed5e2C27793A5FA43'],
  ])('secret [%i; 48] gives the legacy addresses', (fill, stellar, evm) => {
    expect(deriveAddresses(new Uint8Array(48).fill(fill))).toEqual({ stellar, evm });
  });

  it('HKDF matches WebCrypto HKDF-SHA256 (independent implementation)', async () => {
    const secret = new Uint8Array(48).fill(7);
    const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(PROVISIONAL_HKDF.salt), info: utf8(PROVISIONAL_HKDF.info.evm) }, key, 256);
    const evm = new Uint8Array(bits);
    expect(evmAddress(secp256k1.getPublicKey(evm, false))).toBe(deriveAddresses(secret).evm);
  });
});

describe('address encodings', () => {
  it('EVM: EIP-55 address of a known key (web3.js accounts example)', () => {
    const pub = secp256k1.getPublicKey(fromHex('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'), false);
    expect(evmAddress(pub)).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    expect(evmAddress(secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(true))).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  });

  it('Stellar: StrKey of a known Ed25519 public key (SEP-23 vector)', () => {
    expect(stellarAddress(fromHex('3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a'))).toBe('GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ');
    expect(() => stellarAddress(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('round-trips hex', () => {
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
    expect(() => fromHex('0')).toThrow();
  });
});
