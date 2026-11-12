// vault/signing.ts's NEAR checks, called directly (the review's L8: two checks the flow tests didn't pin): the mainnet
// demo never covers NEAR mainnet, and a NEP-413 signature must be the session account's own.
import { type PortRequest, type SignMethod, base64Encode, chainAddress, encodeNearTransaction, extractPrk, nearImplicitPublicKey, parsePortRequest, sha256, utf8 } from '@hana-id/core';
import { fixedMainnetDemoPrices } from '@hana-id/core/mainnet-demo';
import { describe, expect, it, vi } from 'vitest';

// The demo's own assessment would refuse NEAR too; it answers "ok" here so the test sees signing.ts's own guard
// (NEAR mainnet refused before the demo is consulted), not the demo's.
vi.mock('@hana-id/core/mainnet-demo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@hana-id/core/mainnet-demo')>();
  return { ...real, assessMainnetDemo: () => ({ ok: true, network: { chain: 'evm', chainId: 8453 }, usdMicros: 1n }) };
});
import { type SignRequest, approvalSubject, signRequest } from '../../src/vault/signing.ts';
import { VaultError } from '../../src/vault/errors.ts';

const prk = () => extractPrk(Uint8Array.from([...sha256(utf8('s1')), ...sha256(utf8('s2')).slice(0, 16)]));
const NEAR = chainAddress(prk(), 'near');
const ADDRESSES = { stellar: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ', evm: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', near: NEAR };

const req = (method: SignMethod, params: unknown): SignRequest => parsePortRequest({ v: 1, id: 'r1', method, params }) as Extract<PortRequest, { method: SignMethod }>;

const tx = () =>
  base64Encode(encodeNearTransaction({ signerId: NEAR, publicKey: { type: 'ed25519', bytes: nearImplicitPublicKey(NEAR) }, nonce: 1n, receiverId: 'guestbook.testnet', blockHash: sha256(utf8('b')), actions: [{ type: 'transfer', deposit: 1n }] }));

describe('approvalSubject: NEAR mainnet for a test app', () => {
  it('is refused even with the mainnet demo on (it covers Base and Stellar only)', () => {
    const rules = { rawSign: 'off' as const, testApp: true, mainnetDemo: { nowMs: Date.UTC(2026, 10, 11), prices: fixedMainnetDemoPrices() } };
    let e: unknown;
    try {
      approvalSubject(req('near_signTransaction', { network: 'mainnet', transaction: tx() }), ADDRESSES, rules);
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).data).toMatchObject({ reason: 'mainnet_not_allowed', chain: 'near', network: 'mainnet' });
  });
});

describe('signRequest: near_signMessage', () => {
  const message = { message: 'Sign in', recipient: 'guestbook.example', nonce: base64Encode(new Uint8Array(32).fill(1)) };

  it('signs as the session account', () => {
    const r = req('near_signMessage', message);
    const subject = approvalSubject(r, ADDRESSES, { rawSign: 'off', testApp: true });
    expect((signRequest(prk(), r, subject) as { accountId: string }).accountId).toBe(NEAR);
  });

  it('refuses when the key it derives is not the subject’s account (a PRK or address mix-up signs nothing)', () => {
    const r = req('near_signMessage', message);
    const subject = { ...approvalSubject(r, ADDRESSES, { rawSign: 'off', testApp: true }), address: 'ab'.repeat(32) };
    expect(() => signRequest(prk(), r, subject)).toThrow(VaultError);
  });
});
