// The anvil lane (D868), scenario 9: the relayer's fail-stop halts (evm-relayer.ts header, D851) on REAL chain
// evidence, and the staff tools that resolve them: a transaction sent with the relayer's key outside the relayer
// (`foreign_transactions` → staffAdoptNonce, staffResume); a nonce gap left by someone else's dropped transaction
// (`nonce_gap` → staffFill, staffResume); the relayer's balance drained between the handler's balance read and the
// broadcast (`relayer_cannot_send` / `insufficient_funds`: the user told "paused" and not charged a failure; refilled →
// its cancel lands → staffResume, in a world with no second endpoint, where it never restarts by itself); and D890's one
// automatic restart: refilled with a second endpoint, it restarts by itself and the next action goes through (9d), but
// not when a transaction from its key that it didn't send was seen during the pause (9e). New sends are refused while
// halted.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { evmRelayerStaffAdoptNonce, evmRelayerStaffFill, evmRelayerStaffResume, evmRelayerStaffStatus } from '../src/evm-relayer-staff.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { DEFAULT_SPONSOR_PORTS, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { evmSponsorConfig, forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { reconcileEvmSends } from '../src/evm/sponsor-settle.ts';
import { act, auditRows, balance, clockAhead, clockTo, automine, billingRows, checkInCall, DEV_ACCOUNT, ETH, json, LANE, LANE_FALLBACK, mine, prepare, rawTx, receipt, relayerRun, rpc, send, setBalance, SKIPPED, txCount, untilPooled, vaultSign, world, type World } from './lane.ts';

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
    // A leak-type pause (D843): Resume needs staff to confirm the key is ours again, then the cause must be gone.
    expect((await evmRelayerStaffResume(w.stub, WHO, 'not confirmed')).refused).toBe('key_confirmation_required');
    expect((await evmRelayerStaffResume(w.stub, WHO, 'too early', undefined, true)).refused).toBe('foreign_transactions');
    expect((await evmRelayerStaffAdoptNonce(w.stub, WHO, 3, 'not the chain’s count')).refused).toBe('chain_count_differs');
    expect((await evmRelayerStaffAdoptNonce(w.stub, WHO, 2, 'explorer shows nonce 1 was not ours')).done).toBe(true);
    const resumed = await evmRelayerStaffResume(w.stub, WHO, 'key rotated', undefined, true);
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
      ['resume', false, 'key_confirmation_required', WHO],
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
    // A gap is leak-type and staff filled a slot during the pause (D843): Resume needs the key confirmed.
    expect((await evmRelayerStaffResume(w.stub, WHO, 'gap filled')).refused).toBe('key_confirmation_required');
    const resumed = await evmRelayerStaffResume(w.stub, WHO, 'gap filled, key checked', undefined, true);
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
    // No second endpoint in this world: it never restarted by itself (only staff's Resume is in its log).
    expect((await evmRelayerStaffStatus(w.stub)).staffLog.map((e) => [e.who, e.done, e.auto === true])).toEqual([[WHO, true, false], [WHO, false, false]]);
  });

  /** A world paused for money at its first action (the handler read 1 test ETH, the node then saw 1000 wei). */
  async function pausedForMoney(): Promise<{ w: World; since: number }> {
    const w = await world({ fields: { rpcFallback: LANE_FALLBACK } });
    const p = await prepare(w, [checkInCall]);
    expect(p.body).toMatchObject({ allowed: true });
    await setBalance(w.relayer, 1_000n);
    const res = await send(w, vaultSign(w, [checkInCall], p.body).body);
    expect([res.status, (await json(res)).code]).toEqual([503, 'sponsorship_paused']);
    const halted = (await w.stub.status()).halted;
    expect(halted).toMatchObject({ reason: 'relayer_cannot_send', nonce: 0, code: 'insufficient_funds' });
    // Still out of money: the run's own verdict holds it.
    await relayerRun(w);
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'relayer_cannot_send' });
    return { w, since: halted!.since };
  }

  it('9d. out of money, refilled, with a second endpoint (D890): it restarts by itself once its checks pass, recorded with what it saw; its cancel lands and the next action goes through, no Resume', async () => {
    const { w, since } = await pausedForMoney();
    await setBalance(w.relayer, ETH);
    // A minute into the pause (its first 60 s it never restarts by itself), runs as the alarm makes them.
    clockTo(since + 61_000);
    for (let i = 0; i < 4 && (await w.stub.status()).halted; i++) await relayerRun(w);
    expect((await w.stub.status()).halted).toBeNull();
    const s = await evmRelayerStaffStatus(w.stub);
    expect(s.staffLog).toHaveLength(1);
    expect(s.staffLog[0]).toMatchObject({ who: 'relayer (automatic)', action: 'resume', done: true, refused: null, auto: true });
    expect(s.staffLog[0]!.note).toMatch(/^Restarted by itself after a refill \(D890\)\. Trusted endpoint: balance \d+ wei \(at least \d+ needed\), count 1 \(pending 1, next slot 1\) after block \d+, no code at the wallet\. Second endpoint: count 1 \(pending 1\), balance \d+ wei, no code\.$/u);
    expect(s.autoRestart).toMatchObject({ limit: 3, today: 1, pause: null });
    // The cancel that took slot 0 is on the node; the user's first action was never run and not charged.
    expect(await txCount(w.relayer)).toBe(1);
    await mine(LANE.safeDepth);
    await relayerRun(w);
    await reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
    expect((await auditRows(w.user.address))[0]).toMatchObject({ status: 'not_executed' });
    forgetRelayerStatus();
    forgetRelayerBalances();
    const again = await act(w, [checkInCall]);
    expect([again.res.status, again.body.status], JSON.stringify(again.body)).toEqual([200, 'executed']);
    expect((await auditRows(w.user.address)).at(-1)).toMatchObject({ status: 'executed', relayer_nonce: 1 });
  });

  it('9e. out of money, then a transfer from the relayer’s key that it didn’t send takes the refill: no restart by itself; the pause is marked a leak and Resume needs the engineer (D890)', async () => {
    const { w, since } = await pausedForMoney();
    await setBalance(w.relayer, ETH);
    // Someone with the key, quicker than the relayer's next run: half the refill out, at the relayer's slot 0.
    await rpc('eth_sendRawTransaction', [rawTx(w.relayerKey, { nonce: 0, to: DEV_ACCOUNT, value: ETH / 2n, ...fee })]);
    expect(await txCount(w.relayer)).toBe(1);
    expect(await balance(w.relayer)).toBeGreaterThan(ETH / 4n);
    clockTo(since + 61_000);
    await relayerRun(w);
    // Not at confirmed depth yet: slot 0 used, no receipt of its own (unexplained), so it waits.
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'relayer_cannot_send' });
    await mine(LANE.safeDepth);
    await relayerRun(w);
    await relayerRun(w);
    const s = await evmRelayerStaffStatus(w.stub);
    expect(s.halted).toMatchObject({ reason: 'relayer_cannot_send', code: 'insufficient_funds', leakSeen: true });
    expect(s.staffLog.filter((e) => e.auto)).toEqual([]);
    expect(s.autoRestart.pause).toMatchObject({ blocked: 'leak_seen' });
    expect((await evmRelayerStaffResume(w.stub, WHO, 'refilled')).refused).toBe('key_confirmation_required');
  });
});
