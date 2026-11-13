// The Journear Passport stamps contract (contracts/hana-stamps, D796) on a real node through the relay's own code:
// a fresh implicit account, activated by the relay's zero Transfer, collects stamps with delegates that the API's
// decoder, policy (with the stamps contract as a second receiver beside the guestbook, D797) and encoder handle as
// in production; the `signature` stamp's proof is made by @hana-id/core's NEP-413 signer, the vault's own, and
// verified by the contract on chain. The Rust sandbox tests (contracts/integration-tests/tests/stamps.rs) cover every
// rule and the gas; this file pins that the relay path and the SDK's signer fit the contract.
//
// Needs the near-sandbox binary and the stamps wasm (sandbox.ts sandboxBinary, stampsWasm). Skipped without them,
// unless HANA_SANDBOX_REQUIRED=1 (the verify lane: the Rust sandbox tests build the wasm just before).
import { randomBytes } from 'node:crypto';
import { encodeNep413Message, signNep413Message } from '@hana-id/core/near';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeSignedDelegate, nearPublicKeyString, policyRefusal, verifyDelegateSignature } from '../src/near/delegate.ts';
import { nearRelayVar, parseNearRelayConfig } from '../src/near/relay-config.ts';
import { failedExecutor, failureText } from '../src/near/tx.ts';
import { accessKeyNonce, assertSuccess, balanceOf, createAccount, failures, finalBlock, NEAR, relayTx, type Sandbox, sandboxBinary, send, signDelegate, type Signer, stampsWasm, startSandbox, TGAS, type User } from './sandbox.ts';

const bin = sandboxBinary();
const wasm = stampsWasm();
if ((!bin || !wasm) && process.env.HANA_SANDBOX_REQUIRED === '1') throw new Error(`${bin ? 'the stamps wasm' : 'the near-sandbox binary'} not found (run the contract and Rust sandbox tests first)`);

/** The relay's gas cap on sandbox-dev (envs/sandbox-dev.json near.relay.maxGasTgas). */
const CAP_TGAS = 10n;

/** A fresh user whose 32-byte seed is known, as the vault holds it (TEST key, this run only). */
function user(): User & { seed: Uint8Array } {
  const seed = new Uint8Array(randomBytes(32));
  const pub = ed25519.getPublicKey(seed);
  const keyPair = KeyPair.fromString(`ed25519:${baseEncode(new Uint8Array([...seed, ...pub]))}` as KeyPairString);
  return { accountId: Buffer.from(pub).toString('hex'), keyPair, publicKey: keyPair.getPublicKey(), seed };
}

describe.skipIf(!bin || !wasm)('the stamps contract through the relay on near-sandbox (D796)', () => {
  let sb: Sandbox;
  let relayer: Signer;
  let stamps: Signer;

  beforeAll(async () => {
    sb = await startSandbox(bin!);
    relayer = await createAccount(sb, 'relayer', 50n * NEAR);
    stamps = await createAccount(sb, 'stamps', 5n * NEAR, wasm!);
    assertSuccess(await send(sb.rpc, stamps, stamps.accountId, [actionCreators.functionCall('new', {}, 30n * TGAS, 0n)]), 'new()');
  }, 120_000);
  afterAll(() => sb?.stop());

  it('collects arrival, sponsored and signature through the relay; own_fare is refused there; the user never funded', async () => {
    // The relay's config as gen-wrangler writes it: the guestbook and the stamps contract as receivers.
    const config = parseNearRelayConfig(nearRelayVar({ account: relayer.accountId, receivers: [`guestbook.${sb.root.accountId}`, stamps.accountId], maxGasTgas: Number(CAP_TGAS) }));
    expect(config?.receivers).toEqual([`guestbook.${sb.root.accountId}`, stamps.accountId]);
    const u = user();
    expect(failures(await relayTx(sb, relayer, u.accountId, { kind: 'activate', amount: 0n }))).toEqual([]);

    const relay = async (args: Record<string, unknown>, receiverId = stamps.accountId, from: User = u) => {
      const nonce = (await accessKeyNonce(sb.rpc, from.accountId, nearPublicKeyString(from.publicKey.data))) + 1n;
      const b = await finalBlock(sb.rpc);
      const signed = signDelegate(from, receiverId, [actionCreators.functionCall('collect', args, CAP_TGAS * TGAS, 0n)], nonce, BigInt(b.height + 100));
      const d = decodeSignedDelegate(signed);
      if (!d.ok) throw new Error('decode');
      const refusal = policyRefusal(d.value, config!);
      if (refusal) return { refusal };
      expect(await verifyDelegateSignature(d.value)).toBe(true);
      return { out: await relayTx(sb, relayer, from.accountId, { kind: 'delegate', signedDelegate: signed }) };
    };

    for (const stamp of ['arrival', 'sponsored']) {
      const { out } = await relay({ stamp });
      expect(failures(out!), stamp).toEqual([]);
    }
    // own_fare through the relay: the contract refuses it (someone else signed); the relay reads it from the receipts.
    const { out: fare } = await relay({ stamp: 'own_fare' });
    expect(failedExecutor(fare!)).toBe(stamps.accountId);
    expect(failureText(fare!)).toContain('ERR_NOT_OWN_FARE');

    // signature: the vault's NEP-413 signer, verified by the contract on chain.
    const message = `Stamp my passport: ${u.accountId}`;
    const nonce = new Uint8Array(randomBytes(32));
    const signed = signNep413Message(u.seed, encodeNep413Message({ message, nonce, recipient: stamps.accountId, callbackUrl: null }));
    expect(signed.accountId).toBe(u.accountId);
    const proof = { message, nonce: Buffer.from(nonce).toString('base64'), recipient: stamps.accountId, signature: signed.signature };
    const { out: sig } = await relay({ stamp: 'signature', proof });
    expect(failures(sig!)).toEqual([]);
    // Another account replaying it: refused by the contract.
    const other = user();
    expect(failures(await relayTx(sb, relayer, other.accountId, { kind: 'activate', amount: 0n }))).toEqual([]);
    expect(failures((await relay({ stamp: 'arrival' }, stamps.accountId, other)).out!)).toEqual([]);
    expect(failureText((await relay({ stamp: 'signature', proof }, stamps.accountId, other)).out!)).toContain('ERR_BAD_PROOF');

    const passport = await sb.rpc.view<{ account_id: string; stamps: { stamp: string; sponsored: boolean }[] }>(stamps.accountId, 'get_passport', { account_id: u.accountId });
    expect(passport.account_id).toBe(u.accountId);
    expect(passport.stamps.map((s) => [s.stamp, s.sponsored])).toEqual([
      ['arrival', true],
      ['sponsored', true],
      ['signature', true],
    ]);
    expect(await sb.rpc.view(stamps.accountId, 'totals', {})).toEqual({ passports: 2, stamps: 4 });
    expect(await balanceOf(sb.rpc, u.accountId)).toBe(0n);

    // A delegate to any other contract still fails the relay's receiver check.
    const { refusal } = await relay({ stamp: 'arrival' }, `other.${sb.root.accountId}`);
    expect(refusal).toEqual({ code: 'receiver_not_allowed', receiverId: `other.${sb.root.accountId}` });
  }, 120_000);
});
