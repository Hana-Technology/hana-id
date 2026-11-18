// The anvil lane (D868), scenarios 5–8: the relayer's pool-facing rules on a real node's pool (anvil with its automine
// off, so transactions wait): (5) a batch whose deadline passes unmined is replaced by the relayer's 0-value cancel at
// the same nonce, and the chain and the service's records agree; (6) a batch held by a rising base fee is bumped × 1.125
// until it is mined, never above the fee cap, and a cap below the base fee halts the relayer `fee_cap_too_low`; (7) the
// two "checks owed" (docs/operations.md), rehearsed: the pending count rises while a transaction waits, and the same
// raw transaction sent again is answered as known; (8) the node's own refusal texts for each pool rule, and how
// sponsor-chain.ts classifyRejection and the relayer's REJECTION_CAUSE read them. anvil is not op-geth or reth: its
// wording differs, and some of their pool rules it doesn't have at all; what it can't show is listed for the Base
// Sepolia measurement (docs/go-live-after-freeze.md phase 4).
import { env } from 'cloudflare:workers';
import { SPONSOR_DELEGATES, signAuthorization } from '@hana-id/core/evm-sponsor';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { REJECTION_CAUSE } from '../src/evm-relayer.ts';
import { evmRelayerStaffResume, evmRelayerStaffStatus } from '../src/evm-relayer-staff.ts';
import { type EvmRejection, SponsorChain, classifyRejection, forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { DEFAULT_SPONSOR_PORTS, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { evmSponsorConfig, forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { reconcileEvmSends } from '../src/evm/sponsor-settle.ts';
import { sponsorFees, sponsorGasLimit } from '../src/evm/op-fee.ts';
import { testKey } from '../test/evm-sponsor-helpers.ts';
import { uid } from '../test/helpers.ts';
import {
  act,
  addressOf,
  auditRows,
  automine,
  balance,
  billingRows,
  block,
  CHAIN,
  checkInCall,
  clockAhead,
  clockTo,
  code,
  DELEGATE,
  ETH,
  GWEI,
  json,
  LANE,
  mine,
  prepare,
  q,
  rawTx,
  rawType4,
  receipt,
  relayerRun,
  rpc,
  rpcRaw,
  send,
  setBalance,
  SKIPPED,
  spent,
  txCount,
  untilPooled,
  vaultSign,
  world,
  type World,
} from './lane.ts';

const cfgOf = (w: World) => evmSponsorConfig({ ...env, ...w.bindings } as Env)!;
const WHO = 'anvil-lane';

/** Sends the vault's batch with automine off: answered 504 `timeout` (nothing mined), the batch in the node's pool. */
async function stuckSend(w: World): Promise<{ hash: string; digest: string; deadline: number }> {
  const p = await prepare(w, [checkInCall]);
  const signed = vaultSign(w, [checkInCall], p.body);
  await automine(false);
  sponsorTiming.receiptWaitMs = 1_500;
  const res = await send(w, signed.body);
  const body = await json(res);
  expect([res.status, body.code], JSON.stringify(body)).toEqual([504, 'timeout']);
  await untilPooled(w.relayer, 0);
  return { hash: String(body.transactionHash), digest: signed.digest, deadline: Number(signed.input.deadline) };
}

const versionsOf = async (w: World) => (await evmRelayerStaffStatus(w.stub)).records.flatMap((r) => r.versions.map((v) => ({ hash: v.hash, kind: v.kind, maxFeePerGas: BigInt(v.maxFeePerGas), maxPriorityFeePerGas: BigInt(v.maxPriorityFeePerGas) })));
const setNextBaseFee = (wei: bigint) => rpc('anvil_setNextBlockBaseFeePerGas', [q(wei)]);

beforeAll(async () => {
  if (!SKIPPED) await automine(true);
});
beforeEach(async () => {
  forgetVerifiedChains();
  forgetRelayerBalances();
  forgetRelayerStatus();
  sponsorTiming.receiptWaitMs = 20_000;
  sponsorTiming.receiptPollMs = 50;
  if (!SKIPPED) await automine(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  sponsorPorts.relayer = DEFAULT_SPONSOR_PORTS.relayer;
  sponsorPorts.chain = DEFAULT_SPONSOR_PORTS.chain;
  sponsorTiming.receiptWaitMs = 30_000;
  sponsorTiming.receiptPollMs = 1_500;
  if (!SKIPPED) {
    // Nothing left waiting for the next test: mine what is pooled, put the base fee back near the start.
    await setNextBaseFee(10_000_000n);
    await automine(true);
    await mine(1);
  }
});

describe.skipIf(SKIPPED !== null)('the relayer against a real pool (anvil, automine off)', () => {
  it('5. the deadline passes unmined: the relayer’s cancel takes the nonce; the account is untouched; the row is not_executed and billed as cancelled at the cancel’s cost', async () => {
    const w = await world();
    const { hash, digest, deadline } = await stuckSend(w);
    expect(await txCount(w.relayer, 'pending')).toBe(1);
    // Past the deadline (the object's clock; nothing mined): its run replaces the batch at nonce 0 with the cancel.
    clockTo(deadline * 1000 + 1_000);
    await relayerRun(w);
    const looked = (await w.stub.lookup(digest as `0x${string}`))!;
    expect(looked).toMatchObject({ state: 'cancelling', relayerNonce: 0 });
    expect(looked.hashes[0]).toBe(hash);
    const cancel = looked.hashes[1]!;
    await mine(1);
    // The node took the replacement: the cancel is mined, the batch never will be.
    const rc = (await receipt(cancel))!;
    expect([rc.status, rc.to.toLowerCase(), rc.from.toLowerCase()]).toEqual(['0x1', w.relayer.toLowerCase(), w.relayer.toLowerCase()]);
    expect(await receipt(hash)).toBeNull();
    expect([await txCount(w.relayer), await txCount(w.relayer, 'pending')]).toEqual([1, 1]);
    // The account: no delegation (the cancel carries no authorization), its own nonce unchanged.
    expect([await code(w.user.address), await txCount(w.user.address)]).toEqual(['0x', 0]);
    // The relayer's verdict at confirmed depth, then the reconciler settles the row from the cancel's receipt.
    await mine(LANE.safeDepth);
    await relayerRun(w);
    const cost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
    expect(await w.stub.lookup(digest as `0x${string}`)).toMatchObject({ state: 'mined', minedHash: cancel, outcome: 'cancel', costWei: cost });
    await reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'not_executed', tx_hash: cancel, settled_wei: cost.toString() });
    expect(JSON.parse(row!.tx_hashes)).toEqual(expect.arrayContaining([hash, cancel]));
    const [bill] = await billingRows(row!.id);
    expect(bill).toMatchObject({ outcome: 'cancelled', tx_hash: cancel, gas_used: '21000', total_cost_wei: cost.toString() });
    expect((await spent(w.app.id, Date.now())).app).toBe(cost);
  });

  it('6. a rising base fee holds the batch: bumped × 1.125 (both fees) each 60 s until mined, within the cap; executed and settled from the version that was mined', async () => {
    const w = await world();
    const before = await balance(w.relayer);
    const { hash, digest } = await stuckSend(w);
    const [v1] = await versionsOf(w);
    expect(v1!.hash).toBe(hash);
    // Each block from now on has a base fee of 1.2 × the batch's max fee: the first version can't be included, nor the
    // first bump (× 1.125); the second (× 1.265625) can.
    const held = (v1!.maxFeePerGas * 12n) / 10n;
    await setNextBaseFee(held);
    await mine(1);
    expect(await receipt(hash)).toBeNull();
    clockAhead(61_000);
    await relayerRun(w);
    await setNextBaseFee(held);
    await mine(1);
    clockAhead(122_000);
    await relayerRun(w);
    await setNextBaseFee(held);
    await mine(1);
    const versions = await versionsOf(w);
    expect(versions.map((v) => v.kind)).toEqual(['execute', 'execute', 'execute']);
    const ceil98 = (x: bigint) => (x * 9n + 7n) / 8n;
    expect(versions[1]).toMatchObject({ maxFeePerGas: ceil98(v1!.maxFeePerGas), maxPriorityFeePerGas: ceil98(v1!.maxPriorityFeePerGas) });
    expect(versions[2]).toMatchObject({ maxFeePerGas: ceil98(versions[1]!.maxFeePerGas), maxPriorityFeePerGas: ceil98(versions[1]!.maxPriorityFeePerGas) });
    const cap = 1n * GWEI;
    for (const v of versions) expect(v.maxFeePerGas).toBeLessThanOrEqual(cap);
    const mined = (await receipt(versions[2]!.hash))!;
    expect(mined.status).toBe('0x1');
    expect(await receipt(versions[1]!.hash)).toBeNull();
    // What the node charged: min(max fee, base fee + tip) per gas, here the max fee (it binds: base 1.2 × f1).
    const paid = before - (await balance(w.relayer));
    expect(paid).toBe(BigInt(mined.gasUsed) * versions[2]!.maxFeePerGas);
    await mine(LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(digest as `0x${string}`)).toMatchObject({ state: 'mined', minedHash: versions[2]!.hash, outcome: 'execute' });
    await reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
    // The settlement follows the receipt (gasUsed × effectiveGasPrice, D847). anvil 1.5.1's receipt reports base + tip
    // even when the max fee binds (see the it.fails below), so here the billed cost is above what was paid.
    const billed = BigInt(mined.gasUsed) * BigInt(mined.effectiveGasPrice);
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'executed', tx_hash: versions[2]!.hash, settled_wei: billed.toString() });
    expect((await billingRows(row!.id))[0]).toMatchObject({ outcome: 'executed', tx_hash: versions[2]!.hash, total_cost_wei: billed.toString(), effective_gas_price_wei: BigInt(mined.effectiveGasPrice).toString() });
    bound.push({ reported: BigInt(mined.effectiveGasPrice), charged: paid / BigInt(mined.gasUsed), maxFee: versions[2]!.maxFeePerGas });
  });

  // FINDING (anvil, not the product): when a transaction's max fee binds (base fee + tip above it), anvil 1.5.1 charges
  // the max fee per gas but its receipt's effectiveGasPrice says base fee + tip. EIP-1559 nodes report min(max fee,
  // base + tip); the settlement (receiptCost) trusts the field, bounded only by the chain's fee cap. Passes while anvil
  // misreports; fails (remove `.fails`) once it doesn't.
  it.fails('6 (anvil receipt). the receipt’s effectiveGasPrice is the price the node charged when the max fee binds', () => {
    expect(bound.length).toBe(1);
    expect(bound[0]!.reported).toBe(bound[0]!.charged);
  });

  it('6b. a base fee above the fee cap with the batch in the pool: bumps stop at the cap, no cancel is possible past the deadline, so it waits (no halt) until 30 minutes past the deadline → stuck_past_deadline; once fees fall the cancel lands and staffResume works', async () => {
    const w = await world();
    const { digest, deadline } = await stuckSend(w);
    const cap = 1n * GWEI;
    await setNextBaseFee(10n * GWEI);
    await mine(1);
    expect(BigInt((await block('latest')).baseFeePerGas)).toBe(10n * GWEI);
    clockTo(deadline * 1000 + 1_000);
    await relayerRun(w);
    // The batch was taken by the node (accepted): a cancel the cap can't price is no halt (the header's rule: only a
    // REQUIRED cancel of a batch nothing took halts `fee_cap_too_low`); the latest version is sent again.
    let s = await evmRelayerStaffStatus(w.stub);
    expect(s.halted).toBeNull();
    expect(s.records[0]!.versions.map((v) => v.kind)).toEqual(['execute']);
    for (const v of s.records[0]!.versions) expect(BigInt(v.maxFeePerGas)).toBeLessThanOrEqual(cap);
    // 30 minutes past the deadline, still unmined: stuck_past_deadline.
    clockTo(deadline * 1000 + 31 * 60_000);
    await relayerRun(w);
    s = await evmRelayerStaffStatus(w.stub);
    expect(s.halted).toMatchObject({ reason: 'stuck_past_deadline', nonce: 0 });
    expect((await evmRelayerStaffResume(w.stub, WHO, 'fees still high')).refused).toBe('stuck_past_deadline');
    // Fees fall: the next run's cancel is priced from the fresh base fee and replaces the batch.
    await setNextBaseFee(10_000_000n);
    await mine(1);
    await relayerRun(w);
    expect((await evmRelayerStaffStatus(w.stub)).records[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    await mine(1 + LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(digest as `0x${string}`)).toMatchObject({ state: 'mined', outcome: 'cancel' });
    const resumed = await evmRelayerStaffResume(w.stub, WHO, 'fees back below the cap');
    expect([resumed.done, resumed.refused, resumed.status.halted]).toEqual([true, null, null]);
  });

  it('6c. fee_cap_too_low at send: the base fee jumps above the cap within the object’s 5 s base-fee cache, the node refuses the batch (cause pricing) and no cancel can be priced → halted relayer_cannot_send fee_cap_too_low', async () => {
    const w = await world();
    // A first action caches the base fee in the object (EVM_RELAYER_BASE_FEE_TTL_MS).
    expect((await act(w, [checkInCall])).res.status).toBe(200);
    const p = await prepare(w, [checkInCall]);
    const signed = vaultSign(w, [checkInCall], p.body);
    // The handler's figures from the base fee it read just now (below the cap)…
    const base = BigInt((await block('latest')).baseFeePerGas);
    const fees = sponsorFees(base, { maxFeePerGasWei: GWEI, maxPriorityFeePerGasWei: GWEI / 100n });
    if (!fees.ok) throw new Error('fees');
    const gas = sponsorGasLimit({ calldata: signed.calldata, callData: [checkInCall.data], minGas: signed.input.minGas, authorizations: 0 });
    // …then the chain's base fee jumps to 10 gwei (10 × the cap) before the relayer sends.
    await setNextBaseFee(10n * GWEI);
    await mine(1);
    const answer = await w.stub.send({ chainId: CHAIN, execute: signed.input, signature: String(signed.body.signature) as `0x${string}`, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, reservedWei: gas * GWEI });
    expect(answer).toMatchObject({ ok: true, broadcast: 'rejected', rejection: { cause: 'pricing', code: 'fee_below_base_fee' }, relayerNonce: 1 });
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'relayer_cannot_send', nonce: 1, code: 'fee_cap_too_low' });
    // Nothing of nonce 1 is in the pool: the batch was refused and no cancel was signed.
    expect([await txCount(w.relayer), await txCount(w.relayer, 'pending')]).toEqual([1, 1]);
    expect((await evmRelayerStaffStatus(w.stub)).records.find((r) => r.nonce === 1)!.versions.map((v) => v.kind)).toEqual(['execute']);
    // Fees fall: the run prices the cancel, the node takes it, nonce 1 is used; staffResume then works.
    await setNextBaseFee(10_000_000n);
    await mine(1);
    await relayerRun(w);
    await mine(1 + LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(signed.digest)).toMatchObject({ state: 'mined', outcome: 'cancel' });
    expect((await evmRelayerStaffResume(w.stub, WHO, 'fees fell')).done).toBe(true);
  });

  it('7. the two checks owed, rehearsed: the pending count rises while a transaction waits; the same raw transaction again is answered as known', async () => {
    const key = testKey(`anvil probe ${uid()}`);
    const from = addressOf(key);
    await setBalance(from, ETH);
    await automine(false);
    const raw = rawTx(key, { nonce: 0, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1n });
    expect([await txCount(from, 'latest'), await txCount(from, 'pending')]).toEqual([0, 0]);
    const first = await rpcRaw<string>('eth_sendRawTransaction', [raw]);
    expect(first.error).toBeUndefined();
    // Check 1: while it waits, the pending count is past the latest one (what the relayer's nonce_gap and
    // replacement-underpriced rules rely on).
    expect([await txCount(from, 'latest'), await txCount(from, 'pending')]).toEqual([0, 1]);
    // Check 2: the same bytes again. The relayer reads "already known" (or the hash) as taken.
    const again = await rpcRaw<string>('eth_sendRawTransaction', [raw]);
    captured.push({ case: 'the same raw transaction again (check 2)', code: again.error?.code ?? null, message: again.error?.message ?? `result ${again.result}` });
    // anvil: -32003 "transaction already imported", which the classifier reads as already known (taken).
    expect(again.result === first.result || classifyRejection(again.error?.message ?? '') === 'already_known').toBe(true);
    const chain = new SponsorChain(CHAIN, { read: LANE.url!, broadcast: [LANE.url!] });
    expect(await chain.broadcast(raw)).toEqual({ kind: 'accepted', hash: first.result });
    await mine(1);
    expect([await txCount(from, 'latest'), await txCount(from, 'pending')]).toEqual([1, 1]);
  });

  it('8. the node’s refusal texts, as captured, and how the relayer classifies each', async () => {
    const fee = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n };
    /** A fresh funded sender for each case (no case's nonce depends on another's). */
    const funded = async (label: string) => {
      const k = testKey(`anvil refusals ${label} ${uid()}`);
      await setBalance(addressOf(k), ETH);
      return k;
    };
    const cases: Refusal[] = [
      {
        case: 'replacement, same fees (same nonce)',
        expected: 'replacement_underpriced',
        raw: async () => {
          const k = await funded('same fee');
          await automine(false);
          await rpc('eth_sendRawTransaction', [rawTx(k, { nonce: 0, ...fee })]);
          return rawTx(k, { nonce: 0, ...fee, to: DELEGATE });
        },
      },
      {
        case: 'replacement, both fees + 5 % (geth/op-geth need + 10 %)',
        expected: 'replacement_underpriced',
        raw: async () => {
          const k = await funded('plus 5');
          await automine(false);
          await rpc('eth_sendRawTransaction', [rawTx(k, { nonce: 0, ...fee })]);
          return rawTx(k, { nonce: 0, maxFeePerGas: (fee.maxFeePerGas * 105n) / 100n, maxPriorityFeePerGas: (fee.maxPriorityFeePerGas * 105n) / 100n, to: DELEGATE });
        },
      },
      {
        case: 'nonce too low (nonce 0 already mined)',
        expected: 'nonce_too_low',
        raw: async () => {
          const k = await funded('low');
          await rpc('eth_sendRawTransaction', [rawTx(k, { nonce: 0, ...fee })]);
          return rawTx(k, { nonce: 0, ...fee, to: DELEGATE });
        },
      },
      { case: 'nonce too high (nonce 5, count 0: a gap)', expected: 'nonce_too_high', raw: async () => rawTx(await funded('gap'), { nonce: 5, ...fee }) },
      { case: 'insufficient funds (an unfunded sender)', expected: 'insufficient_funds', raw: async () => rawTx(testKey(`anvil unfunded ${uid()}`), { nonce: 0, ...fee }) },
      { case: 'intrinsic gas too low (gas 20 000)', expected: 'gas_limit', raw: async () => rawTx(await funded('intrinsic'), { nonce: 0, ...fee, gas: 20_000n }) },
      { case: 'gas limit above the block’s (40 000 000)', expected: 'gas_limit', raw: async () => rawTx(await funded('block gas'), { nonce: 0, ...fee, gas: 40_000_000n }) },
      { case: 'max fee below the base fee (1 wei)', expected: 'fee_below_base_fee', raw: async () => rawTx(await funded('below base'), { nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }) },
      { case: 'signed for another chain (1)', expected: 'invalid_transaction', raw: async () => rawTx(await funded('chain'), { nonce: 0, ...fee, chainId: 1 }) },
      { case: 'not a transaction (bytes 0x02c0)', expected: 'invalid_transaction', raw: async () => '0x02c0' },
      { case: 'oversized: 128 KiB of calldata (geth/op-geth refuse a transaction above 128 KiB)', expected: 'oversized', raw: async () => rawTx(await funded('size'), { nonce: 0, ...fee, gas: 6_000_000n, data: `0x${'01'.repeat(128 * 1024)}` }) },
      {
        case: 'type 4 whose authority has its own transaction waiting (geth/op-geth: authority already reserved)',
        expected: 'authority_reserved',
        raw: async () => {
          const k = await funded('relayer of type 4');
          const user = await funded('authority');
          await automine(false);
          await rpc('eth_sendRawTransaction', [rawTx(user, { nonce: 0, ...fee })]);
          const auth = signAuthorization(user, { chainId: CHAIN, address: SPONSOR_DELEGATES[CHAIN]!.address, nonce: 1n }, { enabledChains: [CHAIN] });
          return rawType4(k, { nonce: 0, to: addressOf(user), ...fee, authorizations: [auth] });
        },
      },
    ];
    const chain = new SponsorChain(CHAIN, { read: LANE.url!, broadcast: [LANE.url!] });
    for (const c of cases) {
      const raw = (await c.raw()) as `0x${string}`;
      const a = await rpcRaw<string>('eth_sendRawTransaction', [raw]);
      const classified = a.error ? (classifyRejection(a.error.message) ?? 'unknown') : 'taken';
      // The relayer's own client on the same bytes right after (for a taken one: the same raw again).
      const b = await chain.broadcast(raw);
      refusals.push({ ...c, code: a.error?.code ?? null, message: a.error ? a.error.message : 'accepted into the pool', classified, broadcast: b.kind === 'rejected' ? `rejected: ${b.reason}` : b.kind });
      await automine(true);
      await mine(1);
    }
    printRefusals();
    // What anvil refuses, the classifier must read as the same condition the geth-family text names (or, for a text it
    // does not recognise, `unknown`, which the relayer treats as "maybe taken": never a halt, never a reassignment).
    for (const r of refusals) if (r.classified !== 'taken' && r.classified !== 'unknown') expect([r.case, r.classified]).toEqual([r.case, r.expected]);
    expect(refusals.filter((r) => r.classified === 'unknown').map((r) => r.case)).toEqual([]);
  });

  it('8 (pool rules anvil does not have). anvil takes what geth-family pools refuse: these stay owed to the Base Sepolia measurement', () => {
    const taken = refusals.filter((r) => r.classified === 'taken').map((r) => r.case);
    expect(taken).toEqual(['replacement, both fees + 5 % (geth/op-geth need + 10 %)', 'nonce too high (nonce 5, count 0: a gap)', 'oversized: 128 KiB of calldata (geth/op-geth refuse a transaction above 128 KiB)', 'type 4 whose authority has its own transaction waiting (geth/op-geth: authority already reserved)']);
  });
});

interface Refusal {
  case: string;
  expected: EvmRejection;
  raw: () => Promise<string>;
}
const refusals: (Omit<Refusal, 'raw'> & { code: number | null; message: string; classified: string; broadcast: string })[] = [];
function printRefusals(): void {
  const cause = (c: string) => (Object.hasOwn(REJECTION_CAUSE, c) ? REJECTION_CAUSE[c as EvmRejection] : '-');
  console.log(['| case | anvil’s code | anvil’s message | classifyRejection | cause (REJECTION_CAUSE) | broadcast() |', '|---|---|---|---|---|---|', ...refusals.map((r) => `| ${r.case} | ${r.code ?? '-'} | ${r.message.replaceAll('|', '\\|').slice(0, 160)} | ${r.classified} | ${cause(r.classified)} | ${r.broadcast} |`)].join('\n'));
  if (captured.length) console.log(captured.map((c) => `${c.case}: ${c.code ?? '-'} ${c.message}`).join('\n'));
}

const captured: { case: string; code: number | null; message: string }[] = [];
const bound: { reported: bigint; charged: bigint; maxFee: bigint }[] = [];
