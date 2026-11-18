// The sponsorship routes against the REAL relayer object (evm-relayer.ts, D851) and the REAL chain client
// (evm/sponsor-chain.ts) over the fake chain (test/evm-mock.ts): what the handlers send is what the object verifies and
// signs, its broadcast reaches the chain, the handler reads the receipt itself and settles. The first action with the
// one-time setup (type 4), a later one (type 2), the relayer's one-batch-per-account rule, a batch no node takes (the
// cause decides who pays), and a halted relayer. The user's session (D856) is on the mock NEAR chain (its fetch stub
// sits under the EVM one). No time is faked: the object's alarm is 15 s out and never fires within a test.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { type EvmRelayer, evmRelayerName } from '../src/evm-relayer.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { EXECUTED_TOPIC } from '../src/evm/sponsor-checks.ts';
import { DEFAULT_SPONSOR_PORTS, type EvmRelayerPort, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { EVM_SPONSOR_SEND_ENDPOINT as SEND, EVM_SPONSOR_STATUS_ENDPOINT as STATUS, forgetRelayerBalances, forgetRelayerStatus, sponsorTiming } from '../src/evm/sponsor.ts';
import { EvmMock, type Hex, type MockTx, PRIMARY_RPC, decodeRawTx } from './evm-mock.ts';
import { signSponsorTx } from '@hana-id/core/evm-sponsor';
import { evmRelayerStaffClose } from '../src/evm-relayer-staff.ts';
import { evmSponsorConfig } from '../src/evm/sponsor.ts';
import { reconcileEvmSends } from '../src/evm/sponsor-settle.ts';
import { DELEGATE, LOCAL_CHAIN, RELAYER, nearMock, testKey, rememberAccount, sessionsInMemory, signedSend, sponsorCall, sponsorEnv, sponsorVar, testUser, type TestUser } from './evm-sponsor-helpers.ts';
import { seedApp, type SeededApp, uid } from './helpers.ts';

type Stub = DurableObjectStub<EvmRelayer>;
const body = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const DESIGNATOR = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;
const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;

interface World {
  app: SeededApp;
  user: TestUser;
  bindings: Partial<Env>;
  chain: EvmMock;
  stub: Stub;
  /** The account's code and delegate nonce as the mock chain answers them. */
  codes: Map<string, string>;
  executeNonce: Map<string, bigint>;
  /** Digest of each batch by its account, for the Executed log. */
  digests: Map<string, Hex>;
}

let world: World;

/** The app, its user (recorded for the session's user), the chain and a fresh relayer object configured for them. */
async function setup(o: { delegated?: boolean } = {}): Promise<World> {
  nearMock();
  const chain = new EvmMock({ chainId: LOCAL_CHAIN, urls: [PRIMARY_RPC] }).install();
  const app = await seedApp();
  await sessionsInMemory(app.id);
  const user = testUser();
  await rememberAccount(app.scope, user.address);
  const sponsor = sponsorVar([app.id], LOCAL_CHAIN, { rpc: PRIMARY_RPC, sendsPerMinute: 100_000 });
  const bindings = sponsorEnv(sponsor, null);
  const codes = new Map<string, string>();
  const executeNonce = new Map<string, bigint>();
  const digests = new Map<string, Hex>();
  if (o.delegated) codes.set(user.address.toLowerCase(), DESIGNATOR);
  // The account's reads the handlers make: its code, its delegate nonce (nonce()), the simulation.
  chain.answer = (method, params) => {
    if (method === 'eth_getCode') return { result: codes.get(String(params[0]).toLowerCase()) ?? '0x' };
    if (method === 'eth_call') {
      const tx = params[0] as { to: string; data: string };
      if (tx.data === '0xaffed0e0') return { result: word(executeNonce.get(tx.to.toLowerCase()) ?? 0n) };
      return { result: '0x' };
    }
    return undefined;
  };
  // What the delegate does when a batch is mined: the designator set (type 4), the nonce used, Executed(digest).
  chain.receiptLogs = (tx: MockTx) => {
    const d = digests.get(tx.to.toLowerCase());
    if (!d || tx.data === '0x') return [];
    return [{ address: tx.to.toLowerCase(), topics: [EXECUTED_TOPIC, d], data: `0x${'00'.repeat(64)}` }];
  };
  const stub = env.EVM_RELAYER!.get(env.EVM_RELAYER!.idFromName(`${evmRelayerName(LOCAL_CHAIN)}-routes-${uid()}`));
  await runInDurableObject(stub, (instance: EvmRelayer) => {
    const self = instance as unknown as { env: Env };
    self.env = { ...self.env, ...bindings } as Env;
  });
  sponsorPorts.relayer = () => stub as unknown as EvmRelayerPort;
  world = { app, user, bindings, chain, stub, codes, executeNonce, digests };
  return world;
}

/** Mines the relayer's pool shortly after each accepted broadcast, applying what the batch did to the account. */
function minesSoon(w: World): void {
  w.chain.onSend = (tx) => {
    setTimeout(() => {
      for (const m of w.chain.mine(RELAYER)) {
        const a = m.to.toLowerCase();
        if (m.data === '0x') continue;
        if (m.authorizations > 0) w.codes.set(a, DESIGNATOR);
        w.executeNonce.set(a, (w.executeNonce.get(a) ?? 0n) + 1n);
      }
    }, 30);
    return tx ? 'accept' : undefined;
  };
}

const sendFor = (w: World, signed: { body: Record<string, unknown>; digest: Hex }) => {
  w.digests.set(String(signed.body.account).toLowerCase(), signed.digest);
  return sponsorCall(SEND, w.app, w.bindings, { body: signed.body });
};

beforeEach(() => {
  forgetVerifiedChains();
  forgetRelayerBalances();
  forgetRelayerStatus();
  sponsorTiming.receiptWaitMs = 3_000;
  sponsorTiming.receiptPollMs = 50;
});
afterEach(() => {
  vi.restoreAllMocks();
  sponsorPorts.relayer = DEFAULT_SPONSOR_PORTS.relayer;
  sponsorPorts.chain = DEFAULT_SPONSOR_PORTS.chain;
  sponsorTiming.receiptWaitMs = 30_000;
  sponsorTiming.receiptPollMs = 1_500;
});

describe('the routes and the relayer object, end to end over the fake chain', () => {
  it('the first action with the one-time setup (type 4), then a later one (type 2): executed, settled from the receipts', async () => {
    const w = await setup();
    minesSoon(w);
    const first = await sendFor(w, signedSend(w.user, { authNonce: 0n }));
    const a = await body(first);
    expect([first.status, a.status]).toEqual([200, 'executed']);
    const [tx1] = w.chain.minedTxs;
    expect([tx1!.type, tx1!.authorizations, tx1!.nonce, tx1!.to.toLowerCase()]).toEqual([4, 1, 0, w.user.address.toLowerCase()]);
    expect(a.transactionHash).toBe(tx1!.hash);
    // The relayer's record and the audit row agree.
    const looked = await w.stub.lookup(w.digests.get(w.user.address.toLowerCase())!);
    expect(looked?.hashes).toContain(tx1!.hash);
    const row = await env.DB.prepare('SELECT status, tx_hash, settled_wei FROM evm_sponsor_sends WHERE account = ?1').bind(w.user.address).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'executed', tx_hash: tx1!.hash, settled_wei: String(21_000n * 1_000_000_000n) });
    // A later action: the account is set up, no authorization, its delegate nonce 1. The relayer takes a second batch of
    // an account once its run saw the first mined (its alarm, 15 s after a change; run here at once).
    await runDurableObjectAlarm(w.stub);
    const second = await sendFor(w, signedSend(w.user, { executeNonce: 1n }));
    expect([second.status, (await body(second)).status]).toEqual([200, 'executed']);
    const tx2 = w.chain.minedTxs[1]!;
    expect([tx2.type, tx2.authorizations, tx2.nonce]).toEqual([2, 0, 1]);
  });

  it('one unmined batch per account (the relayer’s rule): a second while the first waits is 429 relayer_busy, retry in 5 s', async () => {
    const w = await setup({ delegated: true });
    sponsorTiming.receiptWaitMs = 200;
    const first = await sendFor(w, signedSend(w.user));
    expect([first.status, (await body(first)).code]).toEqual([504, 'timeout']);
    const r = await sendFor(w, signedSend(w.user, { executeNonce: 0n, minGas: 100_001n }));
    const b = await body(r);
    expect([r.status, b.code, b.retryAfterS]).toEqual([429, 'account_busy', 5]);
  });

  it('a batch the node refuses for its own shape (intrinsic gas): 422 at once, the user charged a failure; the relayer keeps running', async () => {
    const w = await setup({ delegated: true });
    w.chain.onSend = (tx) => (tx.data === '0x' ? 'accept' : { error: 'intrinsic gas too low' });
    const r = await sendFor(w, signedSend(w.user));
    expect([r.status, (await body(r)).code]).toEqual([422, 'not_executed']);
    const row = await env.DB.prepare('SELECT status, rejection FROM evm_sponsor_sends WHERE account = ?1').bind(w.user.address).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'rejected', rejection: 'request:gas_limit' });
    // Its nonce went to the relayer's own cancel, which the node took.
    expect(w.chain.broadcasts.some((b) => b.tx.data === '0x' && b.outcome === 'accepted')).toBe(true);
    expect((await w.stub.status()).halted).toBeNull();
  });

  it('a refusal only the relayer causes (its funds): 503 sponsorship_paused, nothing charged to the user, the relayer halted and status paused', async () => {
    const w = await setup({ delegated: true });
    w.chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    const r = await sendFor(w, signedSend(w.user));
    expect([r.status, (await body(r)).code]).toEqual([503, 'sponsorship_paused']);
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'relayer_cannot_send', code: 'insufficient_funds' });
    const st = await sponsorCall(`${STATUS}?chainId=${LOCAL_CHAIN}`, w.app, w.bindings, { method: 'GET' });
    expect(await body(st)).toMatchObject({ available: false, reason: 'paused' });
    // The next send is the relayer's halt: paused again, nothing broadcast.
    const before = w.chain.broadcasts.length;
    const again = await sendFor(w, signedSend(w.user, { minGas: 100_001n }));
    expect([again.status, (await body(again)).code]).toEqual([503, 'sponsorship_paused']);
    expect(w.chain.broadcasts.length).toBe(before);
  });

  it('D869: the relayer’s own detection, then staff closing the slot, leads to “not charged”: the app’s and the env’s budgets back, the record at 0', async () => {
    const w = await setup({ delegated: true });
    sponsorTiming.receiptWaitMs = 200;
    w.chain.onSend = () => 'accept';
    const r = await sendFor(w, signedSend(w.user));
    expect([r.status, (await body(r)).code]).toEqual([504, 'timeout']);
    const spent = async (subject: string) => BigInt(await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(subject)).spent(`evm-sponsor:${LOCAL_CHAIN}:wei`, 86_400_000));
    expect(await spent(`app:${w.app.id}`)).toBeGreaterThan(0n);
    // Someone else uses the relayer's key: their transaction takes slot 0 instead of ours.
    w.chain.pool.get(RELAYER.toLowerCase())?.clear();
    const foreign = signSponsorTx(testKey('relayer'), { type: 'eip1559', chainId: BigInt(LOCAL_CHAIN), nonce: 0n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 7n, gas: 21_000n, to: new Uint8Array(20).fill(0xee), value: 0n, data: new Uint8Array(), accessList: [] });
    w.chain.admit(decodeRawTx(foreign));
    w.chain.mine(RELAYER, 1);
    w.chain.blockNumber += 20;
    await runDurableObjectAlarm(w.stub);
    expect((await w.stub.status()).halted).toMatchObject({ reason: 'nonce_consumed_elsewhere', nonce: 0 });
    // Staff close the slot (the admin portal's Close, through the staff module).
    expect(await evmRelayerStaffClose(w.stub as never, 'staff@hana.example', 0, 'consumed_elsewhere', 'a foreign transaction took slot 0')).toMatchObject({ done: true });
    await env.DB.prepare('UPDATE evm_sponsor_sends SET updated_at = created_at - 120000, created_at = created_at - 120000').run();
    const cron = { ...env, ...w.bindings } as Env;
    expect(await reconcileEvmSends(cron, evmSponsorConfig(cron)!)).toMatchObject({ settled: 1 });
    expect(await spent(`app:${w.app.id}`)).toBe(0n);
    expect(await spent(`evm-sponsor:budget:${LOCAL_CHAIN}`)).toBe(0n);
    expect(await env.DB.prepare('SELECT status, settled_wei FROM evm_sponsor_sends WHERE account = ?1').bind(w.user.address).first()).toEqual({ status: 'consumed_elsewhere', settled_wei: '0' });
    expect(await env.DB.prepare('SELECT outcome, settled_wei, total_cost_wei FROM evm_sponsor_billing').first()).toEqual({ outcome: 'consumed_elsewhere', settled_wei: '0', total_cost_wei: null });
  });
});
