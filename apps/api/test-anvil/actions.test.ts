// The anvil lane (D868), scenarios 1–3: a user's first sponsored action (the one-time setup, type 4), a later one (type
// 2) and batches of several calls (an ERC-20 transfer among them) with a call that reverts, caught by the simulation or
// on chain at inclusion. Each checks the chain itself (receipts, logs, account code, nonces, balances) AND the
// service's records (the audit row, the billing record, the budgets, the relayer's own verdict at confirmed depth).
// anvil can't show the OP Stack's L1 data fee or operator fee: its receipts have neither, so the cost here is
// gasUsed × effectiveGasPrice exactly (the OP parts are unit-tested on the fake chain and owed on Base Sepolia).
import { env } from 'cloudflare:workers';
import { testUser } from '../test/evm-sponsor-helpers.ts';
import { uid } from '../test/helpers.ts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { limiter } from '../src/handlers.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { EXECUTED_TOPIC } from '../src/evm/sponsor-checks.ts';
import { DEFAULT_SPONSOR_PORTS, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { evmSponsorConfig, forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { accountSubject, DAY, failureSubject, FAILURES, NONCE_FLOOR, reconcileEvmSends } from '../src/evm/sponsor-settle.ts';
import {
  act,
  auditRows,
  automine,
  balance,
  billingRows,
  block,
  CHECK_IN,
  checkInCall,
  checkInsOf,
  code,
  DELEGATE,
  designator,
  DEV_ACCOUNT,
  executeNonceOf,
  json,
  keccak,
  LANE,
  mine,
  placeToken,
  prepare,
  receipt,
  relayerRun,
  rpc,
  send,
  setTokenBalance,
  SKIPPED,
  spent,
  TOKEN,
  tokenBalanceOf,
  transferCall,
  txCount,
  untilPooled,
  vaultSign,
  world,
  addressWord,
  word,
  type World,
} from './lane.ts';

const cfgOf = (w: World) => evmSponsorConfig({ ...env, ...w.bindings } as Env)!;
/** The cron's reconciler as it runs a minute later (its confirm step reads rows untouched for a minute). */
const reconcileLater = (w: World) => reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
const floorOf = async (account: string): Promise<bigint> => BigInt(await limiter(env as Env, accountSubject(31337, account)).floor(NONCE_FLOOR));
const failuresOf = async (w: World, userId: string | null): Promise<number> => Number(await limiter(env as Env, failureSubject(31337, w.user.address, userId)).spent(FAILURES, DAY, Date.now()));

beforeAll(async () => {
  if (!SKIPPED) await placeToken();
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
  if (!SKIPPED) await automine(true);
});

describe.skipIf(SKIPPED !== null)(`sponsored actions on a real node (anvil, Prague)${SKIPPED ? `: ${SKIPPED}` : ''}`, () => {
  it('1. the first action: the one-time setup and the batch in one type-4 transaction, paid by the relayer, recorded and billed at its receipt’s cost', async () => {
    const w = await world();
    const relayerBefore = await balance(w.relayer);
    const userBefore = await balance(w.user.address);
    const { res, body, signed, prepared } = await act(w, [checkInCall]);
    expect(prepared).toMatchObject({ delegation: 'none', accountNonce: '0', executeNonce: '0', relayer: w.relayer, implementation: DELEGATE, allowed: true });
    expect([res.status, body.status], JSON.stringify(body)).toEqual([200, 'executed']);
    const hash = String(body.transactionHash);
    const r = (await receipt(hash))!;
    // The chain: a type-4 transaction from the relayer to the account, successful, the account now delegated.
    expect([r.status, r.type, r.from.toLowerCase(), r.to.toLowerCase()]).toEqual(['0x1', '0x4', w.relayer.toLowerCase(), w.user.address.toLowerCase()]);
    expect((await code(w.user.address)).toLowerCase()).toBe(designator(DELEGATE));
    // The authorization used the account's transaction nonce (0 → 1); the delegate's batch nonce moved 0 → 1.
    expect([await txCount(w.user.address), await executeNonceOf(w.user.address)]).toEqual([1, 1n]);
    expect(await checkInsOf(w.user.address)).toBe(1n);
    // Executed(digest, nonce 0, 1 call) logged by the ACCOUNT, and CheckIn's own event with the account as caller.
    const executed = r.logs.find((l) => l.topics[0] === EXECUTED_TOPIC)!;
    expect([executed.address.toLowerCase(), executed.topics[1], executed.data]).toEqual([w.user.address.toLowerCase(), signed.digest, `0x${word(0)}${word(1)}`]);
    const checkedIn = r.logs.find((l) => l.address.toLowerCase() === CHECK_IN.toLowerCase())!;
    expect(checkedIn.topics[1]).toBe(`0x${addressWord(w.user.address)}`);
    // The money: the user's own balance untouched; the relayer paid exactly gasUsed × effectiveGasPrice.
    const cost = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    expect(await balance(w.user.address)).toBe(userBefore);
    expect(relayerBefore - (await balance(w.relayer))).toBe(cost);
    // The service: the audit row and the billing record match the receipt; the budgets hold the cost, not the reservation.
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'executed', tx_hash: hash, settled_wei: cost.toString(), with_setup: 1, call_count: 1, relayer_nonce: 0, confirmed_at: null });
    expect(BigInt(row!.reserved_wei)).toBeGreaterThan(cost);
    const [bill] = await billingRows(row!.id);
    const b = await block(Number(r.blockNumber));
    expect(bill).toMatchObject({ record_key: hash, tx_hash: hash, outcome: 'executed', gas_used: BigInt(r.gasUsed).toString(), effective_gas_price_wei: BigInt(r.effectiveGasPrice).toString(), execution_wei: cost.toString(), l1_fee_wei: '0', operator_fee_wei: '0', total_cost_wei: cost.toString(), settled_wei: cost.toString(), block_number: BigInt(r.blockNumber).toString(), block_timestamp: Number(b.timestamp), call_count: 1, with_setup: 1, corrects: null });
    expect(JSON.parse(bill!.targets_json)).toEqual([{ address: CHECK_IN.toLowerCase(), selector: '0x183ff085' }]);
    expect(await spent(w.app.id)).toMatchObject({ app: cost });
    // Confirmed depth (`safe` = head − 4 here): the relayer's own verdict, then the reconciler confirms the row and only
    // now raises the account's nonce floor past 0.
    expect(await floorOf(w.user.address)).toBe(0n);
    await mine(LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(signed.digest)).toMatchObject({ state: 'mined', minedHash: hash, outcome: 'execute', costWei: cost, relayerNonce: 0 });
    expect(await w.stub.status()).toMatchObject({ unmined: 0, awaitingConfirmation: 0, nextNonce: 1, halted: null });
    expect((await reconcileLater(w)).confirmed).toBe(1);
    expect((await auditRows(w.user.address))[0]!.confirmed_at).not.toBeNull();
    expect(await floorOf(w.user.address)).toBe(1n);
  });

  it('2. a later action: no authorization, a type-2 transaction with the next Execute nonce', async () => {
    const w = await world();
    const first = await act(w, [checkInCall]);
    expect(first.res.status).toBe(200);
    const { res, body, prepared } = await act(w, [checkInCall]);
    expect(prepared).toMatchObject({ delegation: 'journear', accountNonce: '1', executeNonce: '1' });
    expect([res.status, body.status]).toEqual([200, 'executed']);
    const r = (await receipt(String(body.transactionHash)))!;
    expect([r.status, r.type]).toEqual(['0x1', '0x2']);
    // The account's own transaction count stays 1 (only the authorization moved it); its batch nonce 1 → 2.
    expect([await txCount(w.user.address), await executeNonceOf(w.user.address), await checkInsOf(w.user.address)]).toEqual([1, 2n, 2n]);
    expect((await auditRows(w.user.address)).map((x) => [x.status, x.with_setup, x.relayer_nonce])).toEqual([
      ['executed', 1, 0],
      ['executed', 0, 1],
    ]);
  });

  it('3a. a batch with an ERC-20 transfer and a call that would revert: the simulation refuses it, nothing is sent, the attempt counts as a failure', async () => {
    const w = await world();
    const friend = testUser(`anvil friend ${uid()}`).address;
    await setTokenBalance(w.user.address, 100n);
    const nonceBefore = await txCount(w.relayer, 'pending');
    const p = await prepare(w, [checkInCall, transferCall(friend, 10n), transferCall(friend, 1_000n)]);
    const signed = vaultSign(w, [checkInCall, transferCall(friend, 10n), transferCall(friend, 1_000n)], p.body);
    const res = await send(w, signed.body);
    const body = await json(res);
    // The third call (index 2) reverts: CallFailed(2, "") from the delegate, as eth_call reported it.
    expect([res.status, body.code, body.callIndex]).toEqual([422, 'simulation_reverted', 2]);
    expect(String(body.revertData)).toMatch(/^0x5c0dee5d/u);
    expect(await txCount(w.relayer, 'pending')).toBe(nonceBefore);
    expect([await tokenBalanceOf(w.user.address), await tokenBalanceOf(friend), await checkInsOf(w.user.address)]).toEqual([100n, 0n, 0n]);
    const [row] = await auditRows(w.user.address);
    expect(row).toBeUndefined();
    expect(await spent(w.app.id)).toMatchObject({ app: 0n });
    expect(await failuresOf(w, (await env.DB.prepare('SELECT user_id FROM end_user_wallets WHERE address = ?1').bind(w.user.address).first<{ user_id: string }>())!.user_id)).toBe(1);
  });

  it('3b. the same batch that passes the simulation but reverts at inclusion (its token balance taken first): the whole batch reverts, the user is told, the relayer’s cost is charged', async () => {
    const w = await world();
    const friend = testUser(`anvil friend ${uid()}`).address;
    await setTokenBalance(w.user.address, 100n);
    const calls = [checkInCall, transferCall(friend, 10n), transferCall(friend, 50n)];
    const p = await prepare(w, calls);
    const signed = vaultSign(w, calls, p.body);
    await automine(false);
    const pending = send(w, signed.body);
    // The batch is in the pool (the simulation passed); a transaction with a higher tip empties the user's token
    // balance first in the same block, so the batch's transfers revert at inclusion.
    await untilPooled(w.relayer, 0);
    const SET = keccak('setBalance(address,uint256)').slice(0, 10);
    await rpc('eth_sendTransaction', [{ from: DEV_ACCOUNT, to: TOKEN, data: `${SET}${addressWord(w.user.address)}${word(0)}`, maxPriorityFeePerGas: '0x3b9aca00', maxFeePerGas: '0x77359400', gas: '0x186a0' }]);
    await mine(1);
    const res = await pending;
    const body = await json(res);
    expect([res.status, body.code], JSON.stringify(body)).toEqual([422, 'reverted']);
    const r = (await receipt(String(body.transactionHash)))!;
    expect(r.status).toBe('0x0');
    // All or nothing: the delegation itself stays (the authorization is processed before execution), but neither the
    // check-in, nor the transfers, nor the batch nonce moved.
    expect((await code(w.user.address)).toLowerCase()).toBe(designator(DELEGATE));
    expect([await executeNonceOf(w.user.address), await checkInsOf(w.user.address), await tokenBalanceOf(friend)]).toEqual([0n, 0n, 0n]);
    expect(r.logs).toEqual([]);
    const cost = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'reverted', settled_wei: cost.toString() });
    const [bill] = await billingRows(row!.id);
    expect(bill).toMatchObject({ outcome: 'reverted', total_cost_wei: cost.toString(), call_count: 3 });
    expect(JSON.parse(bill!.targets_json)).toEqual([
      { address: CHECK_IN.toLowerCase(), selector: '0x183ff085' },
      { address: TOKEN.toLowerCase(), selector: '0xa9059cbb' },
      { address: TOKEN.toLowerCase(), selector: '0xa9059cbb' },
    ]);
    expect(await spent(w.app.id)).toMatchObject({ app: cost });
    await automine(true);
  });
});
