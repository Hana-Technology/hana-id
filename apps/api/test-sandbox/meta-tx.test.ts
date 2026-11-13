// NEP-366 meta transactions on a real node (near-sandbox 2.13.x, protocol 86; D730, D731): what NEAR requires of a
// fresh implicit account, who pays what, and the relay's own decoder, policy and transaction encoder end to end.
// fresh key → activation (the relay's zero Transfer) → a delegate signed by an independent encoder (@near-js, as a
// wallet would) → decoded, checked and wrapped by apps/api's code → state changed, the user never funded.
//
// Needs the near-sandbox binary (sandbox.ts sandboxBinary). Skipped without it, unless HANA_SANDBOX_REQUIRED=1 (the
// verify lane sets it, after the contract lane's build has downloaded the binary).
import { type Action, actionCreators, buildDelegateAction, Signature, SignedDelegate } from '@near-js/transactions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVATE_GAS, decodeSignedDelegate, innerGas, nearPublicKeyString, policyRefusal, RELAY_OVERHEAD_GAS, verifyDelegateSignature } from '../src/near/delegate.ts';
import { burntGas, failedExecutor, failureText } from '../src/near/tx.ts';
import { accessKeyState, headBlock, implicitAccountKey } from '../src/near/relay-chain.ts';
import type { FinalOutcome } from '../src/near/rpc.ts';
import {
  accessKeyNonce,
  balanceOf,
  createAccount,
  failures,
  finalBlock,
  implicitAccount,
  NEAR,
  noteContractWasm,
  relayTx,
  type Sandbox,
  sandboxBinary,
  send,
  signDelegate,
  type Signer,
  startSandbox,
  TGAS,
  type User,
  viewAccount,
  viewState,
} from './sandbox.ts';

const bin = sandboxBinary();
if (!bin && process.env.HANA_SANDBOX_REQUIRED === '1') throw new Error('near-sandbox binary not found (build contracts/integration-tests first, or set NEAR_SANDBOX_BIN_PATH)');

/** Polls the balance until it stops moving (refund receipts land a few blocks after EXECUTED). */
async function settledBalance(sb: Sandbox, accountId: string): Promise<bigint> {
  let last = await balanceOf(sb.rpc, accountId);
  for (let i = 0, same = 0; i < 30 && same < 3; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await balanceOf(sb.rpc, accountId);
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return last ?? 0n;
}

const fc = (method: string, gasTgas: bigint, deposit = 0n): Action => actionCreators.functionCall(method, {}, gasTgas * TGAS, deposit);

describe.skipIf(!bin)('NEAR meta transactions on near-sandbox (D731)', () => {
  let sb: Sandbox;
  let relayer: Signer;
  let contract: Signer;
  let attacker: Signer;

  beforeAll(async () => {
    sb = await startSandbox(bin!);
    relayer = await createAccount(sb, 'relayer', 50n * NEAR);
    contract = await createAccount(sb, 'note', 5n * NEAR, noteContractWasm());
    attacker = await createAccount(sb, 'attacker', 1n * NEAR);
  }, 120_000);
  afterAll(() => sb?.stop());

  it('the end-to-end flow: fresh key, activation, a relayed call, state changed, the user never funded', async () => {
    const user = implicitAccount();
    expect(user.accountId).toMatch(/^[0-9a-f]{64}$/u);
    expect(await balanceOf(sb.rpc, user.accountId)).toBeNull();

    // A delegate from an account that doesn't exist fails (AccountDoesNotExist): activation is needed first.
    let b = await finalBlock(sb.rpc);
    const early = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, contract.accountId, [fc('note', 30n)], BigInt(b.height) * 1_000_000n, BigInt(b.height + 100)) });
    expect(JSON.stringify(failures(early))).toContain('AccountDoesNotExist');

    // Activation: a Transfer of 0 yocto creates the implicit account, balance 0 (zero-balance account, NEP-448: 182
    // bytes of storage, under the 770-byte allowance), its key's nonce = the creation block's height × 10^6.
    const before = await settledBalance(sb, relayer.accountId);
    const act = await relayTx(sb, relayer, user.accountId, { kind: 'activate', amount: 0n });
    expect(failures(act)).toEqual([]);
    const activationCost = before - (await settledBalance(sb, relayer.accountId));
    const account = await viewAccount(sb.rpc, user.accountId);
    expect([account.amount, account.storage_usage]).toEqual(['0', 182]);
    const ak = await accessKeyNonce(sb.rpc, user.accountId, nearPublicKeyString(user.publicKey.data));
    expect(ak % 1_000_000n).toBe(0n);
    expect(ak / 1_000_000n).toBeGreaterThan(0n);

    // The delegate: decoded, checked and verified by the relay's code, wrapped by its encoder, sent.
    b = await finalBlock(sb.rpc);
    const signed = signDelegate(user, contract.accountId, [fc('note', 30n)], ak + 1n, BigInt(b.height + 100));
    const decoded = decodeSignedDelegate(signed);
    expect(decoded.ok).toBe(true);
    const d = (decoded as { ok: true; value: Parameters<typeof policyRefusal>[0] }).value;
    expect([d.senderId, d.receiverId, d.nonce, d.actions.length, d.actions[0]?.methodName]).toEqual([user.accountId, contract.accountId, ak + 1n, 1, 'note']);
    expect(policyRefusal(d, { receivers: [contract.accountId], maxGas: 100n * TGAS })).toBeNull();
    expect(await verifyDelegateSignature(d)).toBe(true);
    const beforeRelay = await settledBalance(sb, relayer.accountId);
    const out = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signed });
    expect(failures(out)).toEqual([]);
    // State changed by the user's account (the contract stores its caller), the user still holds nothing.
    expect(await viewState(sb.rpc, contract.accountId)).toEqual({ p: user.accountId });
    expect(await balanceOf(sb.rpc, user.accountId)).toBe(0n);
    // Who ran what: the user's account (the Delegate action), the contract, and the gas refund to the relayer.
    expect(out.receipts_outcome?.map((r) => r.outcome.executor_id)).toEqual([user.accountId, contract.accountId, relayer.accountId]);
    const relayCost = beforeRelay - (await settledBalance(sb, relayer.accountId));
    // The relay's budget reserves (inner gas + overhead) × gas price, and ACTIVATE_GAS × gas price for an activation:
    // always above what they cost. An activation costs far more than a relay (the implicit account's creation fee).
    const block = await finalBlock(sb.rpc);
    expect(relayCost).toBeLessThan((innerGas(d) + RELAY_OVERHEAD_GAS) * block.gasPrice);
    expect(activationCost).toBeLessThan(ACTIVATE_GAS * block.gasPrice);
    expect(activationCost).toBeGreaterThan(relayCost);
    // The relayer's balance moved by gas only: exactly what the transaction and its receipts burnt, no deposit.
    expect(relayCost).toBe(burntGas(out)!.tokensBurnt);
    // Recorded for the docs (operations.md "NEAR relay"): what an activation and a relay cost on this node.
    console.info(JSON.stringify({ activationCostYocto: activationCost.toString(), relayCostYocto: relayCost.toString(), gasPrice: block.gasPrice.toString() }));
  }, 120_000);

  it("the relay's chain reads on a real node: the head block, a missing account, a missing key, a key's nonce", async () => {
    const head = await headBlock(sb.rpc);
    expect(head.height).toBeGreaterThan(0n);
    expect(head.gasPrice).toBeGreaterThan(0n);
    const user = implicitAccount();
    expect(await implicitAccountKey(sb.rpc, user.accountId)).toEqual({ kind: 'no_account' });
    expect(failures(await relayTx(sb, relayer, user.accountId, { kind: 'activate', amount: 0n }))).toEqual([]);
    const key = await implicitAccountKey(sb.rpc, user.accountId);
    expect(key.kind === 'key' && key.nonce % 1_000_000n === 0n && key.height > 0n).toBe(true);
    // A key the account doesn't hold, and an account that doesn't exist, on a named account too.
    expect(await accessKeyState(sb.rpc, relayer.accountId, implicitAccount().publicKey.toString())).toEqual({ kind: 'no_key' });
    expect(await accessKeyState(sb.rpc, `nobody.${sb.root.accountId}`, implicitAccount().publicKey.toString())).toEqual({ kind: 'no_account' });
  }, 60_000);

  describe('who pays what, and what a relayer must refuse', () => {
    let user: User;
    const nextNonce = async () => (await accessKeyNonce(sb.rpc, user.accountId, nearPublicKeyString(user.publicKey.data))) + 1n;
    beforeAll(async () => {
      user = implicitAccount();
      expect(failures(await relayTx(sb, relayer, user.accountId, { kind: 'activate', amount: 0n }))).toEqual([]);
    }, 60_000);

    it('a delegated Transfer from a zero-balance account is paid by the RELAYER: the attacker gains 1 NEAR', async () => {
      const b = await finalBlock(sb.rpc);
      const atk = await balanceOf(sb.rpc, attacker.accountId);
      const rel = await settledBalance(sb, relayer.accountId);
      const out = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, attacker.accountId, [actionCreators.transfer(NEAR)], await nextNonce(), BigInt(b.height + 100)) });
      expect(failures(out)).toEqual([]);
      expect((await balanceOf(sb.rpc, attacker.accountId))! - atk!).toBe(NEAR);
      expect(rel - (await settledBalance(sb, relayer.accountId))).toBeGreaterThan(NEAR);
      expect(await balanceOf(sb.rpc, user.accountId)).toBe(0n);
      // The relay's policy refuses it before anything is sent.
      const d = decodeSignedDelegate(signDelegate(user, attacker.accountId, [actionCreators.transfer(NEAR)], 1n, 1n));
      expect(d.ok && policyRefusal(d.value, { receivers: [attacker.accountId], maxGas: 100n * TGAS })).toEqual({ code: 'action_not_allowed', index: 0, action: 'Transfer' });
    }, 60_000);

    it("a delegated call's deposit is paid by the relayer too: refused by policy", async () => {
      const b = await finalBlock(sb.rpc);
      const before = await balanceOf(sb.rpc, contract.accountId);
      const rel = await settledBalance(sb, relayer.accountId);
      const signed = signDelegate(user, contract.accountId, [fc('note', 30n, NEAR)], await nextNonce(), BigInt(b.height + 100));
      expect(failures(await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signed }))).toEqual([]);
      expect((await balanceOf(sb.rpc, contract.accountId))! - before!).toBeGreaterThanOrEqual(NEAR);
      expect(rel - (await settledBalance(sb, relayer.accountId))).toBeGreaterThan(NEAR);
      const d = decodeSignedDelegate(signed);
      expect(d.ok && policyRefusal(d.value, { receivers: [contract.accountId], maxGas: 100n * TGAS })).toEqual({ code: 'deposit_not_allowed', index: 0 });
    }, 60_000);

    it('NEAR refuses an expired, a reused and a too-large nonce in the sender’s receipt; the relayer pays the failed receipt', async () => {
      let b = await finalBlock(sb.rpc);
      const n = await nextNonce();
      const expired = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, contract.accountId, [fc('note', 30n)], n, BigInt(b.height - 1)) });
      expect(JSON.stringify(failures(expired))).toContain('DelegateActionExpired');
      expect(failedExecutor(expired)).toBe(user.accountId);
      expect(failureText(expired)).toContain('DelegateActionExpired');
      b = await finalBlock(sb.rpc);
      const used = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, contract.accountId, [fc('note', 30n)], n - 1n, BigInt(b.height + 100)) });
      expect(JSON.stringify(failures(used))).toContain('DelegateActionInvalidNonce');
      b = await finalBlock(sb.rpc);
      const large = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, contract.accountId, [fc('note', 30n)], BigInt(b.height + 1000) * 1_000_000n, BigInt(b.height + 100)) });
      expect(JSON.stringify(failures(large))).toContain('DelegateActionNonceTooLarge');
    }, 60_000);

    it("NEAR accepts any max_block_height ahead (the relay caps it), and a failed inner call leaves the transaction's own status a success", async () => {
      let b = await finalBlock(sb.rpc);
      const far = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, contract.accountId, [fc('note', 30n)], await nextNonce(), BigInt(b.height + 100_000_000)) });
      expect(failures(far)).toEqual([]);
      b = await finalBlock(sb.rpc);
      const missing = await relayTx(sb, relayer, user.accountId, { kind: 'delegate', signedDelegate: signDelegate(user, contract.accountId, [fc('nope', 30n)], await nextNonce(), BigInt(b.height + 100)) });
      expect(missing.status).toEqual({ SuccessValue: '' });
      expect(JSON.stringify(failures(missing))).toContain('MethodNotFound');
      // near/tx.ts reads the failure from the receipts, so the relay answers it as a failed call of the contract.
      expect(failedExecutor(missing)).toBe(contract.accountId);
    }, 60_000);

    it('activation and the delegate cannot share one transaction (the account must exist before the delegate is applied)', async () => {
      const fresh = implicitAccount();
      const b = await finalBlock(sb.rpc);
      const signed = signDelegate(fresh, contract.accountId, [fc('note', 30n)], BigInt(b.height + 5) * 1_000_000n, BigInt(b.height + 100));
      const out = await send(sb.rpc, relayer, fresh.accountId, [actionCreators.transfer(0n), actionCreators.signedDelegate(new SignedDelegate(decodeForNearJs(signed, fresh)))]);
      expect(JSON.stringify(failures(out))).toContain('AccountDoesNotExist');
    }, 60_000);
  });
});

/** @near-js's SignedDelegate for raw bytes (re-signed: only the shape matters for this test). */
function decodeForNearJs(signed: Uint8Array, user: User): { delegateAction: ReturnType<typeof buildDelegateAction>; signature: Signature } {
  const d = decodeSignedDelegate(signed);
  if (!d.ok) throw new Error('decode');
  const da = buildDelegateAction({ senderId: d.value.senderId, receiverId: d.value.receiverId, actions: [fc('note', 30n)], nonce: d.value.nonce, maxBlockHeight: d.value.maxBlockHeight, publicKey: user.publicKey });
  return { delegateAction: da, signature: new Signature({ keyType: 0, data: d.value.signature }) };
}
