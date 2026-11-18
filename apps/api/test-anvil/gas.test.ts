// The anvil lane (D868), scenario 4: the handlers' gas formula (evm/op-fee.ts sponsorGasLimit, D847) against what the
// REAL delegate costs on a real Prague node, for a first batch (the one-time setup: cold, the nonce slot 0 → 1) and a
// later one, with 1, 3 and 8 calls (CheckIn's checkIn() and token transfers to fresh holders: every slot cold). For
// each: the receipt's gasUsed; the least gas limit with which the very same signed batch runs (a binary search with
// eth_call at the batch's own minGas, + 25 000 for the authorization eth_call can't carry); from it the gas the
// transaction spends before the delegate's `gasleft() >= minGas` check, which the formula budgets as the delegated-code
// access (2 600) plus the pre-loop overhead (29 800 + 1 400 per further call + 2 per byte of the calls' data). The
// formula must be an upper bound of it on its own, before its × 1.1; the table is printed and copied into
// docs/operations.md ("measured on anvil, Prague": EVM execution gas only, no OP Stack L1 or operator fee).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { intrinsicGas } from '../src/evm-relayer.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { DEFAULT_SPONSOR_PORTS, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { DELEGATION_ACCESS_GAS, EVENT_GAS, PRE_LOOP_GAS, PRE_LOOP_GAS_PER_DATA_BYTE, PRE_LOOP_GAS_PER_EXTRA_CALL, sponsorGasLimit } from '../src/evm/op-fee.ts';
import { testUser } from '../test/evm-sponsor-helpers.ts';
import { uid } from '../test/helpers.ts';
import { auditRows, automine, type Call, checkInCall, designator, DELEGATE, fromHex, json, placeToken, prepare, receipt, rpcRaw, send, setTokenBalance, SKIPPED, transferCall, vaultSign, world, type World } from './lane.ts';

const MAX_GAS = 1_000_000n;
const FIELDS = { maxCallsPerBatch: 8, maxGasPerTx: Number(MAX_GAS) };

interface Measured {
  batch: string;
  calls: number;
  dataBytes: number;
  auth: boolean;
  gasUsed: bigint;
  gasLimit: bigint;
  minGas: bigint;
  intrinsic: bigint;
  floorApplies: boolean;
  leastLimit: bigint;
  preCheck: bigint;
  allowance: bigint;
}
const table: Measured[] = [];

/**
 * The intrinsic gas a node deducts BEFORE execution: 21 000 + 4 a calldata token (EIP-7623's floor of 10 a token only
 * bounds the final charge, it is not taken from the execution's gas), + 25 000 per authorization.
 */
function upfrontIntrinsic(data: Uint8Array, authorizations: number): bigint {
  let tokens = 0n;
  for (const b of data) tokens += b === 0 ? 1n : 4n;
  return 21_000n + 4n * tokens + 25_000n * BigInt(authorizations);
}

/** `n` calls: a check-in, then token transfers of 1 to fresh holders (each a cold, zero storage slot). */
const callsOf = (n: number): Call[] => [checkInCall, ...Array.from({ length: n - 1 }, () => transferCall(testUser(`anvil holder ${uid()}`).address, 1n))];

/** The least gas limit with which `data` from the relayer to the account succeeds (eth_call, at latest). */
async function leastGas(w: World, data: string, override: boolean, lo: bigint, hi: bigint): Promise<bigint> {
  const ok = async (gas: bigint) => {
    const a = await rpcRaw('eth_call', [{ from: w.relayer, to: w.user.address, data, gas: `0x${gas.toString(16)}` }, 'latest', ...(override ? [{ [w.user.address]: { code: designator(DELEGATE) } }] : [])]);
    return a.error === undefined;
  };
  if (!(await ok(hi))) throw new Error('the batch does not run even at the formula’s limit');
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

async function measure(w: World, batch: string, calls: Call[]): Promise<Measured> {
  const p = await prepare(w, calls);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const signed = vaultSign(w, calls, p.body);
  const auth = signed.withAuthorization;
  const minGas = signed.input.minGas;
  const dataBytes = calls.reduce((n, c) => n + (c.data.length - 2) / 2, 0);
  const callIntrinsic = upfrontIntrinsic(fromHex(signed.calldata), 0);
  const formula = sponsorGasLimit({ calldata: signed.calldata, callData: calls.map((c) => c.data), minGas, authorizations: auth ? 1 : 0 });
  // eth_call carries no authorization list: the same simulation the handler makes (the account's code overridden).
  const leastCall = await leastGas(w, signed.calldata, auth, intrinsicGas(fromHex(signed.calldata), 0), formula);
  const res = await send(w, signed.body);
  const body = await json(res);
  expect([res.status, body.status], JSON.stringify(body)).toEqual([200, 'executed']);
  const r = (await receipt(String(body.transactionHash)))!;
  const row = (await auditRows(w.user.address)).at(-1)!;
  expect(BigInt(row.gas_limit)).toBe(formula);
  const m: Measured = {
    batch,
    calls: calls.length,
    dataBytes,
    auth,
    gasUsed: BigInt(r.gasUsed),
    gasLimit: formula,
    minGas,
    intrinsic: intrinsicGas(fromHex(signed.calldata), auth ? 1 : 0),
    floorApplies: intrinsicGas(fromHex(signed.calldata), auth ? 1 : 0) > upfrontIntrinsic(fromHex(signed.calldata), auth ? 1 : 0),
    leastLimit: leastCall + (auth ? 25_000n : 0n),
    preCheck: leastCall - callIntrinsic - minGas,
    allowance: DELEGATION_ACCESS_GAS + PRE_LOOP_GAS + PRE_LOOP_GAS_PER_EXTRA_CALL * BigInt(calls.length - 1) + PRE_LOOP_GAS_PER_DATA_BYTE * BigInt(dataBytes),
  };
  table.push(m);
  return m;
}

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
afterEach(() => {
  vi.restoreAllMocks();
  sponsorPorts.relayer = DEFAULT_SPONSOR_PORTS.relayer;
  sponsorPorts.chain = DEFAULT_SPONSOR_PORTS.chain;
  sponsorTiming.receiptWaitMs = 30_000;
  sponsorTiming.receiptPollMs = 1_500;
});

describe.skipIf(SKIPPED !== null)('the gas formula against the real delegate (anvil, Prague)', () => {
  it.each([1, 3, 8])('4. %i call(s): first batch (with the setup) and a later one; the formula bounds what runs before the minGas check, the limit stays within maxGasPerTx', async (n) => {
    const w = await world({ fields: FIELDS });
    await setTokenBalance(w.user.address, 1_000n);
    for (const [batch, calls] of [['first', callsOf(n)], ['later', callsOf(n)]] as const) {
      const m = await measure(w, batch, calls);
      expect(m.auth).toBe(batch === 'first');
      // The formula's parts before minGas cover the real pre-check spend on their own (before the × 1.1 margin).
      expect(m.preCheck, `${batch} batch, ${n} call(s): pre-check gas ${m.preCheck} vs the formula's ${m.allowance}`).toBeLessThanOrEqual(m.allowance);
      expect(m.leastLimit).toBeLessThanOrEqual(m.gasLimit);
      expect(m.gasUsed).toBeLessThanOrEqual(m.gasLimit);
      // maxMinGas (prepare): the largest minGas whose limit fits maxGasPerTx for this shape, so the limit is at most it.
      expect(m.gasLimit).toBeLessThanOrEqual(MAX_GAS);
    }
  });

  it('prints the table (docs/operations.md "Gas measured on anvil")', () => {
    const rows = table.map((m) => `| ${m.batch} | ${m.calls} | ${m.dataBytes} | ${m.auth ? 'yes' : 'no'} | ${m.gasUsed} | ${m.preCheck} | ${m.allowance} | ${m.allowance - m.preCheck} | ${m.minGas} | ${m.leastLimit} | ${m.gasLimit} | ${m.gasLimit - m.leastLimit} |`);
    console.log(['| batch | calls | call data bytes | setup | receipt gasUsed | spent before the minGas check | formula’s allowance (2 600 + pre-loop) | headroom | minGas (vault: maxMinGas) | least gas limit that runs | formula’s gas limit | formula − least |', '|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
    console.log(`(intrinsic as the relayer counts it, incl. the EIP-7623 floor where it is higher: ${table.map((m) => `${m.intrinsic}${m.floorApplies ? ' (floor)' : ''}`).join(', ')}; EVENT_GAS ${EVENT_GAS})`);
    expect(table.length).toBe(SKIPPED ? 0 : 6);
  });
});
