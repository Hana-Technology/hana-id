// The page's derive step end to end against a simulated MPC. The CKD client itself (ported from legacy) is tested in
// packages/core/test/ckd.test.ts, and derivation v1 in packages/core/test/derivation.test.ts.
import { CKD_DST, ckdAppId, ckdPayload, sessionMessage, toHex } from '@hana-id/core';
import { addressesFromCkdSecret } from '@hana-id/core/derivation';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import type { DeriveBody } from '../src/api.ts';
import { deriveOnce } from '../src/flow.ts';
import { newPendingSession } from '../src/session.ts';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;

/** A fixed MPC master key so a network key can be pinned across calls. */
function mpcNetwork() {
  const msk = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const pkBytes = G2.BASE.multiply(msk).toRawBytes(true);
  return { msk, pkBytes, networkKey: `bls12381g2:${base58.encode(pkBytes)}` };
}

/** Plays the MPC side, as near/mpc's ckd-example-cli test does: (Y, C) = (y·G1, msk·H + y·A). */
function simulateMpc(appPk1: string, appId: Uint8Array, net = mpcNetwork()) {
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...net.pkBytes, ...appId]), { DST: CKD_DST }).toAffine());
  const y = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const a1 = G1.fromHex(base58.decode(appPk1.slice('bls12381g1:'.length)));
  const response = {
    big_y: `bls12381g1:${base58.encode(G1.BASE.multiply(y).toRawBytes(true))}`,
    big_c: `bls12381g1:${base58.encode(h.multiply(net.msk).add(a1.multiply(y)).toRawBytes(true))}`,
  };
  return { response, networkKey: net.networkKey, expected: h.multiply(net.msk).toRawBytes(true) };
}

describe('deriveOnce (page derive step)', () => {
  const signer = 'hana-id-signer-dev1.testnet';
  const path = 's1#google#110248495921238986420#0';

  async function setup() {
    const net = mpcNetwork();
    const session = await newPendingSession({ signer, scopeId: 's1', keyIndex: 0, maxUses: 5 });
    const sent: DeriveBody[] = [];
    let expectedSecret: Uint8Array | null = null;
    const api = {
      derive: vi.fn(async (body: DeriveBody) => {
        sent.push(body);
        const sim = simulateMpc(body.pk1, ckdAppId(signer, path), net);
        expectedSecret = sim.expected;
        return { result: sim.response, nearTx: 'TxHash111', requestId: 'req-1' };
      }),
    };
    return { net, session, api, sent, secret: () => expectedSecret };
  }

  it('signs the CKD payload with the session key, verifies the response and returns only public results', async () => {
    const { net, session, api, sent, secret } = await setup();
    const out = await deriveOnce({ api, signer, ckdNetworkKey: net.networkKey, privateKey: session.privateKey, sessionPublicKey: session.publicKey, path, counter: 1 });

    const body = sent[0]!;
    expect(body.counter).toBe(1);
    expect(body.sessionPublicKey).toEqual([...session.publicKey]);
    const key = await crypto.subtle.importKey('raw', session.publicKey, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(body.signature), sessionMessage(1, ckdPayload(body.pk1, body.pk2)))).toBe(true);

    expect(out.appIdHex).toBe(toHex(ckdAppId(signer, path)));
    expect(out).toMatchObject(addressesFromCkdSecret(Uint8Array.from(secret()!)));
    expect(out.nearTx).toBe('TxHash111');
    expect(Object.keys(out).sort()).toEqual(['appIdHex', 'body', 'decryptVerifyMs', 'deriveMs', 'evm', 'nearTx', 'requestId', 'stellar']);
    // Nothing secret in what comes back.
    expect(JSON.stringify(out)).not.toContain(toHex(secret()!));
  });

  it('uses a fresh BLS key per derive', async () => {
    const { net, session, api, sent } = await setup();
    const input = { api, signer, ckdNetworkKey: net.networkKey, privateKey: session.privateKey, sessionPublicKey: session.publicKey, path };
    const a = await deriveOnce({ ...input, counter: 1 });
    const b = await deriveOnce({ ...input, counter: 2 });
    expect(sent[0]!.pk1).not.toBe(sent[1]!.pk1);
    expect(b.stellar).toBe(a.stellar);
    expect(b.evm).toBe(a.evm);
  });

  it('fails the pairing check against a different pinned network key', async () => {
    const { session, api } = await setup();
    await expect(
      deriveOnce({ api, signer, ckdNetworkKey: mpcNetwork().networkKey, privateKey: session.privateKey, sessionPublicKey: session.publicKey, path, counter: 1 }),
    ).rejects.toThrow(/pairing/);
  });

  it('fails when the response is for another path (app_id) or signer', async () => {
    const { net, session, api } = await setup();
    const input = { api, ckdNetworkKey: net.networkKey, privateKey: session.privateKey, sessionPublicKey: session.publicKey, counter: 1 };
    await expect(deriveOnce({ ...input, signer, path: 's2#google#110248495921238986420#0' })).rejects.toThrow(/pairing/);
    await expect(deriveOnce({ ...input, signer: 'hana-signer-other.testnet', path })).rejects.toThrow(/pairing/);
  });
});
