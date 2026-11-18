// The anvil lane (D868), scenario 9: the relayer's fail-stop halts (evm-relayer.ts header, D851) on REAL chain
// evidence, and the staff tools that resolve them: a transaction sent with the relayer's key outside the relayer
// (`foreign_transactions` → staffAdoptNonce, staffResume); a nonce gap left by someone else's dropped transaction
// (`nonce_gap` → staffFill, staffResume); the relayer's balance drained between the handler's balance read and the
// broadcast (`relayer_cannot_send` / `insufficient_funds`: the user told "paused" and not charged a failure; refilled →
// its cancel lands → staffResume). New sends are refused while halted; nothing restarts it by itself.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { evmRelayerStaffAdoptNonce, evmRelayerStaffFill, evmRelayerStaffResume, evmRelayerStaffStatus } from '../src/evm-relayer-staff.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { DEFAULT_SPONSOR_PORTS, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { evmSponsorConfig, forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { reconcileEvmSends } from '../src/evm/sponsor-settle.ts';
import { act, auditRows, clockAhead, automine, billingRows, checkInCall, ETH, json, LANE, mine, prepare, rawTx, receipt, relayerRun, rpc, send, setBalance, SKIPPED, txCount, untilPooled, vaultSign, world, type World } from './lane.ts';

const WHO = 'anvil-lane';
const fee = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n };
const cfgOf = (w: World) => evmSponsorConfig({ ...env, ...w.bindings } as Env)!;

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
    await automine(true);
    await mine(1);
  }
});

describe.skipIf(SKIPPED !== null)('the relayer’s halts on real chain evidence (anvil)', () => {
  it('9a. a transaction from the relayer’s key outside the relayer: halted foreign_transactions; sends refused (paused); staffResume refused until staffAdoptNonce; then it sends again', async () => {
    const w = await world();
    expect((await act(w, [checkInCall])).res.status).toBe(200);
    // Someone else with the key: a plain transfer at nonce 1, mined.
    await rpc('eth_sendRawTransaction', [rawTx(w.relayerKey, { nonce: 1, ...fee })]);
    expect(await txCount(w.relayer)).toBe(2);
    await relayerRun(w);
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'foreign_transactions', nonce: 1 });
    // The user is told "paused"; nothing is sent.
    forgetRelayerStatus();
    const p = await prepare(w, [checkInCall]);
    expect(p.body).toMatchObject({ allowed: false, reason: 'paused' });
    const refused = await send(w, vaultSign(w, [checkInCall], p.body).body);
    expect([refused.status, (await json(refused)).code]).toEqual([503, 'sponsorship_paused']);
    expect(await txCount(w.relayer, 'pending')).toBe(2);
    expect((await evmRelayerStaffResume(w.stub, WHO, 'too early')).refused).toBe('foreign_transactions');
    expect((await evmRelayerStaffAdoptNonce(w.stub, WHO, 3, 'not the chain’s count')).refused).toBe('chain_count_differs');
    expect((await evmRelayerStaffAdoptNonce(w.stub, WHO, 2, 'explorer shows nonce 1 was not ours')).done).toBe(true);
    const resumed = await evmRelayerStaffResume(w.stub, WHO, 'key rotated');
    expect([resumed.done, resumed.status.nextNonce, resumed.status.halted]).toEqual([true, 2, null]);
    forgetRelayerStatus();
    const again = await act(w, [checkInCall]);
    expect([again.res.status, again.body.status]).toEqual([200, 'executed']);
    expect((await auditRows(w.user.address)).at(-1)).toMatchObject({ status: 'executed', relayer_nonce: 2 });
    const log = (await evmRelayerStaffStatus(w.stub)).staffLog.map((e) => [e.action, e.done, e.refused, e.who]);
    expect(log).toEqual([
      ['resume', true, null, WHO],
      ['adopt_nonce', true, null, WHO],
      ['adopt_nonce', false, 'chain_count_differs', WHO],
      ['resume', false, 'foreign_transactions', WHO],
    ]);
  });

  it('9b. a nonce gap (someone else’s transaction at the relayer’s next nonce, then dropped): halted nonce_gap on two runs; staffFill fills it, the batch behind it lands; staffResume', async () => {
    const w = await world();
    await automine(false);
    // The foreign transaction is in the pool when the fresh object reads its starting nonce (the pending count, 1)…
    const foreign = await rpc<string>('eth_sendRawTransaction', [rawTx(w.relayerKey, { nonce: 0, ...fee })]);
    sponsorTiming.receiptWaitMs = 1_500;
    const { res, signed } = await act(w, [checkInCall]);
    expect(res.status).toBe(504);
    expect((await auditRows(w.user.address))[0]).toMatchObject({ status: 'timeout', relayer_nonce: 1 });
    // …then it is dropped: nonce 0 is empty and nothing of ours fills it.
    await rpc('anvil_dropTransaction', [foreign]);
    // The pool drops what depended on it too; the pending count is the contiguous one (0), as geth's.
    expect([await txCount(w.relayer), await txCount(w.relayer, 'pending')]).toEqual([0, 0]);
    // A gap is a halt only when two runs in a row see it (each run sends the batch again: the node queues it).
    await relayerRun(w);
    expect([(await w.stub.status()).halted, (await evmRelayerStaffStatus(w.stub)).gapSeen]).toEqual([null, 0]);
    // (The node holds it, but not at the next nonce: the pending count stays 0.)
    expect(await txCount(w.relayer, 'pending')).toBe(0);
    await relayerRun(w);
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'nonce_gap', nonce: 0 });
    expect((await evmRelayerStaffFill(w.stub, WHO, 1, 'wrong nonce')).refused).toBe('record_exists');
    const filled = await evmRelayerStaffFill(w.stub, WHO, 0, 'the gap left by a dropped foreign transaction');
    expect([filled.done, filled.refused]).toEqual([true, null]);
    await untilPooled(w.relayer, 1);
    await mine(1);
    expect([await txCount(w.relayer), await txCount(w.relayer, 'pending')]).toEqual([2, 2]);
    const batch = (await w.stub.lookup(signed.digest))!;
    expect((await receipt(batch.transactionHash))?.status).toBe('0x1');
    await mine(LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(signed.digest)).toMatchObject({ state: 'mined', outcome: 'execute' });
    expect(await w.stub.status()).toMatchObject({ unmined: 0, awaitingConfirmation: 0 });
    const resumed = await evmRelayerStaffResume(w.stub, WHO, 'gap filled');
    expect([resumed.done, resumed.status.halted]).toEqual([true, null]);
    // The batch's row settles from its own receipt (the reconciler: the request had timed out).
    await reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
    expect((await auditRows(w.user.address))[0]).toMatchObject({ status: 'executed', tx_hash: batch.transactionHash });
  });

  it('9c. the relayer drained between the handler’s balance read and the broadcast: the node refuses (insufficient funds), halted relayer_cannot_send, the user told paused and not charged; refilled, its cancel lands, staffResume, it sends again', async () => {
    const w = await world();
    // prepare reads (and caches for 3 s) the relayer's balance: 1 test ETH, plenty.
    const p = await prepare(w, [checkInCall]);
    expect(p.body).toMatchObject({ allowed: true });
    await setBalance(w.relayer, 1_000n);
    const res = await send(w, vaultSign(w, [checkInCall], p.body).body);
    expect([res.status, (await json(res)).code]).toEqual([503, 'sponsorship_paused']);
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'relayer_cannot_send', nonce: 0, code: 'insufficient_funds' });
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'rejected', rejection: 'relayer:insufficient_funds' });
    expect(await txCount(w.relayer, 'pending')).toBe(0);
    expect((await evmRelayerStaffResume(w.stub, WHO, 'not funded yet')).refused).toBe('relayer_cannot_send');
    // Funded again: the run sends the stored cancel again, the node takes it, nonce 0 is used by it.
    await setBalance(w.relayer, ETH);
    await relayerRun(w);
    await mine(LANE.safeDepth);
    await relayerRun(w);
    const looked = (await evmRelayerStaffStatus(w.stub)).halted;
    expect(looked).toMatchObject({ reason: 'relayer_cannot_send' });
    const resumed = await evmRelayerStaffResume(w.stub, WHO, 'funded');
    expect([resumed.done, resumed.refused, resumed.status.halted]).toEqual([true, null, null]);
    await reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
    const settled = (await auditRows(w.user.address))[0]!;
    expect(settled).toMatchObject({ status: 'not_executed' });
    const [bill] = await billingRows(settled.id);
    expect(bill).toMatchObject({ outcome: 'cancelled', gas_used: '21000' });
    forgetRelayerStatus();
    forgetRelayerBalances();
    // A second later (else the vault's re-signed batch is the same digest, answered from the rejected row: paused).
    clockAhead(2_000);
    const again = await act(w, [checkInCall]);
    expect([again.res.status, again.body.status], JSON.stringify(again.body)).toEqual([200, 'executed']);
  });
});
