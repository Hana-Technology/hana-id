// The anvil lane (D868), scenarios 10 and 11. (10) A reorg after the handler settled a batch at head (evm_snapshot /
// evm_revert: the block with the batch is gone and the pool emptied, as a reorg that leaves it out): the relayer's
// confirmed-depth logic sees the nonce unmined again; its deadline passed, its cancel takes the nonce; the reconciler's
// reorg check (D847) corrects the row with a correction billing record (never an edit), the budgets follow, and the
// account's nonce floor never ends above the chain's nonce. Also the plain case: reorged out, sent again, the same
// transaction mined again: confirmed, nothing corrected. (11) Refusals before any spend: an account delegated to a
// DIFFERENT implementation; a replayed Execute (the service answers from its audit row, the chain refuses it); a
// signature for another chain, for another relayer, past its deadline. Nothing reaches the pool in any of them.
import { env } from 'cloudflare:workers';
import { executeDigest } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { limiter } from '../src/handlers.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { DEFAULT_SPONSOR_PORTS, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { evmSponsorConfig, forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { accountSubject, NONCE_FLOOR, reconcileEvmSends } from '../src/evm/sponsor-settle.ts';
import { testKey } from '../test/evm-sponsor-helpers.ts';
import { uid } from '../test/helpers.ts';
import {
  act,
  addressOf,
  auditRows,
  automine,
  billingRows,
  CHAIN,
  CHECK_IN,
  checkInCall,
  checkInsOf,
  clockTo,
  code,
  DELEGATE,
  DEV_ACCOUNT,
  designator,
  ETH,
  executeNonceOf,
  json,
  keccak,
  LANE,
  mine,
  prepare,
  rawAuthorization,
  rawType4,
  receipt,
  relayerRun,
  rpc,
  rpcRaw,
  send,
  setBalance,
  SKIPPED,
  spent,
  toHex,
  txCount,
  vaultSign,
  world,
  type World,
} from './lane.ts';

const cfgOf = (w: World) => evmSponsorConfig({ ...env, ...w.bindings } as Env)!;
const reconcileLater = (w: World) => reconcileEvmSends({ ...env, ...w.bindings } as Env, cfgOf(w), Date.now() + 61_000);
const floorOf = async (account: string): Promise<bigint> => BigInt(await limiter(env as Env, accountSubject(CHAIN, account)).floor(NONCE_FLOOR));
const selector = (sig: string) => keccak(sig).slice(0, 10);
/** The account's Execute nonce on chain: 0 for an account with no code (it has never run a batch). */
const chainNonceOf = async (a: string): Promise<bigint> => ((await code(a)) === '0x' ? 0n : executeNonceOf(a));

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

describe.skipIf(SKIPPED !== null)('reorgs (anvil, evm_snapshot / evm_revert)', () => {
  it('10. settled at head, then reorged out and its deadline passed: the cancel takes the nonce; the reconciler corrects the row and writes a correction record; the floor stays at the chain’s nonce', async () => {
    const w = await world();
    const snap = await rpc<string>('evm_snapshot');
    const { res, body, signed } = await act(w, [checkInCall]);
    expect([res.status, body.status]).toEqual([200, 'executed']);
    const a = String(body.transactionHash);
    const ra = (await receipt(a))!;
    const costA = BigInt(ra.gasUsed) * BigInt(ra.effectiveGasPrice);
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'executed', tx_hash: a, settled_wei: costA.toString(), confirmed_at: null });
    // The reorg: the block with the batch is gone, and nothing puts it back (the pool emptied).
    await rpc('evm_revert', [snap]);
    await rpc('anvil_dropAllTransactions');
    expect(await receipt(a)).toBeNull();
    expect([await code(w.user.address), await txCount(w.relayer)]).toEqual(['0x', 0]);
    await mine(2);
    // The relayer's run: its nonce is unmined at head again; past the deadline it sends the cancel (same nonce).
    clockTo(Number(signed.input.deadline) * 1000 + 1_000);
    await relayerRun(w);
    const looked = (await w.stub.lookup(signed.digest))!;
    expect(looked.state).toBe('cancelling');
    const c = looked.hashes.at(-1)!;
    const rc = (await receipt(c))!;
    expect(rc.status).toBe('0x1');
    const costC = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
    await mine(LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(signed.digest)).toMatchObject({ state: 'mined', minedHash: c, outcome: 'cancel', costWei: costC });
    // The reorg check: the row said executed (A); the relayer's verdict at depth is the cancel (C).
    expect(await reconcileLater(w)).toMatchObject({ corrected: 1 });
    expect((await auditRows(w.user.address))[0]).toMatchObject({ status: 'not_executed', tx_hash: c, settled_wei: costC.toString() });
    expect((await auditRows(w.user.address))[0]!.confirmed_at).not.toBeNull();
    const bills = await billingRows(row!.id);
    expect(bills.map((b) => [b.record_key, b.outcome, b.tx_hash, b.corrects, b.total_cost_wei])).toEqual([
      [a, 'executed', a, null, costA.toString()],
      [`fix:${row!.id}`, 'cancelled', c, a, costC.toString()],
    ]);
    expect((await spent(w.app.id, Date.now())).app).toBe(costC);
    // The chain: nothing of the batch ran; the floor (0) is not above the account's nonce on chain (0).
    expect([await code(w.user.address), await checkInsOf(w.user.address), await txCount(w.user.address)]).toEqual(['0x', 0n, 0]);
    expect(await floorOf(w.user.address)).toBeLessThanOrEqual(await chainNonceOf(w.user.address));
  });

  it('10b. reorged out before its deadline: the relayer sends the same raw again, the same transaction is mined again: confirmed, nothing corrected; the floor rises to the chain’s nonce', async () => {
    const w = await world();
    const snap = await rpc<string>('evm_snapshot');
    const { body, signed } = await act(w, [checkInCall]);
    const a = String(body.transactionHash);
    await rpc('evm_revert', [snap]);
    await rpc('anvil_dropAllTransactions');
    await mine(2);
    await relayerRun(w);
    expect((await receipt(a))?.status).toBe('0x1');
    await mine(LANE.safeDepth);
    await relayerRun(w);
    expect(await w.stub.lookup(signed.digest)).toMatchObject({ state: 'mined', minedHash: a, outcome: 'execute' });
    expect(await reconcileLater(w)).toMatchObject({ confirmed: 1, corrected: 0 });
    const [row] = await auditRows(w.user.address);
    expect(row).toMatchObject({ status: 'executed', tx_hash: a });
    expect((await billingRows(row!.id)).length).toBe(1);
    expect([await floorOf(w.user.address), await chainNonceOf(w.user.address)]).toEqual([1n, 1n]);
  });
});

describe.skipIf(SKIPPED !== null)('refused before any spend (anvil)', () => {
  /** Nothing of the relayer's reached the pool, no audit row, nothing reserved. */
  async function nothingSpent(w: World): Promise<void> {
    expect(await txCount(w.relayer, 'pending')).toBe(0);
    expect(await auditRows(w.user.address)).toEqual([]);
    expect((await spent(w.app.id)).app).toBe(0n);
  }

  it('11a. an account delegated to a different implementation (a real EIP-7702 delegation on chain): prepare says delegated_elsewhere, send is 409, nothing spent', async () => {
    const w = await world();
    // The user's own authorization to another contract (CheckIn), carried by someone else's type-4 transaction.
    const other = testKey(`anvil other sender ${uid()}`);
    await setBalance(addressOf(other), ETH);
    const auth = rawAuthorization(w.user.key, { chainId: CHAIN, address: CHECK_IN as `0x${string}`, nonce: 0n });
    await rpc('eth_sendRawTransaction', [rawType4(other, { nonce: 0, to: w.user.address, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n, authorizations: [auth] })]);
    expect((await code(w.user.address)).toLowerCase()).toBe(designator(CHECK_IN));
    const p = await prepare(w, [checkInCall]);
    expect(p.body).toMatchObject({ delegation: 'other', allowed: false, reason: 'delegated_elsewhere', executeNonce: null });
    // A caller that sends anyway (the vault would not): refused before any reservation.
    const signed = vaultSign(w, [checkInCall], { ...p.body, executeNonce: '0', delegation: 'journear' });
    const res = await send(w, signed.body);
    expect([res.status, (await json(res)).code]).toEqual([409, 'delegated_elsewhere']);
    await nothingSpent(w);
  });

  it('11b. a replayed Execute: the service answers from its audit row (no second transaction); on chain the same calldata is refused (InvalidNonce from the relayer, WrongRelayer from anyone else)', async () => {
    const w = await world();
    const { body, signed } = await act(w, [checkInCall]);
    expect(body.status).toBe('executed');
    const before = await txCount(w.relayer, 'pending');
    const again = await send(w, signed.body);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ transactionHash: body.transactionHash, status: 'executed', replay: true });
    expect(await txCount(w.relayer, 'pending')).toBe(before);
    expect((await auditRows(w.user.address)).length).toBe(1);
    // The chain: the very calldata again, from the relayer and from another sender.
    const fromRelayer = await rpcRaw('eth_call', [{ from: w.relayer, to: w.user.address, data: signed.calldata }, 'latest']);
    expect(fromRelayer.error?.data).toBe(selector('InvalidNonce()'));
    const fromOther = await rpcRaw('eth_call', [{ from: DEV_ACCOUNT, to: w.user.address, data: signed.calldata }, 'latest']);
    expect(fromOther.error?.data).toBe(selector('WrongRelayer()'));
    expect(await executeNonceOf(w.user.address)).toBe(1n);
  });

  it('11c. signatures that are not for this batch: another chain id, another relayer, a deadline past: refused, nothing spent', async () => {
    const w = await world();
    const p = await prepare(w, [checkInCall]);
    const base = vaultSign(w, [checkInCall], p.body);
    // Signed over chain 1 (core's signer refuses it; a hostile client signs the digest itself): not the account's.
    const chain1 = executeDigest({ ...base.input, chainId: 1 });
    const sig = secp256k1.sign(chain1, w.user.key, { lowS: true });
    const wrongChain = `${toHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
    const r1 = await send(w, { ...base.body, signature: wrongChain });
    expect([r1.status, (await json(r1)).code]).toEqual([401, 'invalid_signature']);
    // Another relayer named in the body (and signed): refused as such.
    const otherRelayer = vaultSign(w, [checkInCall], p.body, { relayer: DEV_ACCOUNT as `0x${string}` });
    const r2 = await send(w, otherRelayer.body);
    expect([r2.status, (await json(r2)).code]).toEqual([400, 'wrong_relayer']);
    // The right relayer in the body, but the signature over another: not the account's signature of this batch.
    const r3 = await send(w, { ...base.body, signature: otherRelayer.body.signature });
    expect([r3.status, (await json(r3)).code]).toEqual([401, 'invalid_signature']);
    // An authorization for another chain (the account has no code, so the setup is needed): refused as such.
    const auth1 = rawAuthorization(w.user.key, { chainId: 1, address: DELEGATE, nonce: 0n });
    const r5 = await send(w, { ...base.body, authorization: { chainId: 1, address: DELEGATE, nonce: '0', yParity: auth1.yParity, r: auth1.r, s: auth1.s } });
    expect([r5.status, (await json(r5)).code]).toEqual([400, 'bad_authorization']);
    // A deadline already past.
    const late = vaultSign(w, [checkInCall], p.body, { deadline: BigInt(Math.floor(Date.now() / 1000) - 5) });
    const r4 = await send(w, late.body);
    expect([r4.status, (await json(r4)).code]).toEqual([400, 'deadline_out_of_range']);
    await nothingSpent(w);
    // On chain the delegate refuses the expired one as well (simulated as the account would run it).
    const sim = await rpcRaw('eth_call', [{ from: w.relayer, to: w.user.address, data: late.calldata }, 'latest', { [w.user.address]: { code: designator(DELEGATE) } }]);
    expect(sim.error?.data).toBe(selector('Expired()'));
  });
});
