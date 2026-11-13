// Every stamp's collector against the fake SDK and the fake chain: the bytes it builds, the order of the SDK calls,
// the popup rule (the first signing call or prepareApproval before any await), activation and its retry while the
// account isn't recorded, the relay's timeout with and without a hash (D788), a declined approval, an expired
// delegate, the signature stamp's exact message and recipient, own fare's transaction and balance.
import { describe, expect, it, vi } from 'vitest';
import { base64Decode, decodeNearDelegateAction, decodeNearTransaction } from '@hana-id/core';
import { type CollectorDeps, PREP_MAX_AGE_MS, STAGES, createCollector, newRpc, sendOwnFare } from '../src/collector.ts';
import { plainMessage } from '../src/messages.ts';
import { CONFIG, NEAR_ACCOUNT, STAMPS } from './fixtures.ts';
import { FakeChain, TX_HASH, fakeNear, hanaError } from './fakes.ts';

function setup(o: { key?: { nonce: number } | null; balance?: string } = {}) {
  let t = 1_800_000_000_000;
  const clock = () => t;
  const chain = new FakeChain(STAMPS, clock);
  if (o.key !== undefined) chain.key = o.key;
  if (o.balance !== undefined) chain.balance = o.balance;
  const near = fakeNear(() => NEAR_ACCOUNT, chain);
  const ticket = { cancel: vi.fn() };
  const client = { near, prepareApproval: vi.fn(() => ticket) } as unknown as CollectorDeps['client'];
  const slept: number[] = [];
  const deps: CollectorDeps = {
    config: CONFIG,
    client,
    rpc: newRpc(CONFIG, chain.fetch),
    clock,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    random: (n) => new Uint8Array(n).fill(5),
  };
  const collector = createCollector(deps);
  const stages: string[] = [];
  const stage = (s: string) => stages.push(s);
  return { chain, near, ticket, client: client as unknown as { prepareApproval: ReturnType<typeof vi.fn> }, collector, stages, stage, slept, advance: (ms: number) => (t += ms) };
}

const decodeArgs = (bytes: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe('relayed stamps (arrival, sponsored, postcard, layover)', () => {
  it('with a fresh read, signs synchronously in the click: no prepareApproval, the delegate calls collect on the stamps contract', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    const p = s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    // Before any await: the signing call is already made.
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(1);
    expect(s.client.prepareApproval).not.toHaveBeenCalled();
    expect(await p).toEqual({ status: 'done', txHash: TX_HASH, created: false });
    const bytes = s.near.signDelegateAction.mock.calls[0]![0].delegateAction as Uint8Array;
    const d = decodeNearDelegateAction(bytes);
    expect(d.senderId).toBe(NEAR_ACCOUNT);
    expect(d.receiverId).toBe(STAMPS);
    expect(d.maxBlockHeight).toBe(200_000_000n + 600n);
    expect(d.actions).toHaveLength(1);
    const call = d.actions[0] as { type: string; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
    expect([call.type, call.methodName, call.gas, call.deposit]).toEqual(['functionCall', 'collect', 10_000_000_000_000n, 0n]);
    expect(decodeArgs(call.args)).toEqual({ stamp: 'arrival' });
    expect(s.near.signDelegateAction.mock.calls[0]![0].network).toBe('testnet');
    expect(s.near.relay).toHaveBeenCalledWith({ network: 'testnet', signedDelegateAction: expect.any(String) });
    expect(s.stages).toEqual([STAGES.approving, STAGES.relaying]);
    expect(s.chain.stamps.passports.get(NEAR_ACCOUNT)?.map((x) => x.stamp)).toEqual(['arrival']);
  });

  it('without a fresh read, opens the window first (prepareApproval in the click), then reads, then signs into it', async () => {
    const s = setup();
    const p = s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    expect(s.client.prepareApproval).toHaveBeenCalledTimes(1);
    expect(s.near.signDelegateAction).not.toHaveBeenCalled();
    await p;
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(1);
    expect(s.ticket.cancel).not.toHaveBeenCalled();
    expect(s.stages[0]).toBe(STAGES.reading);
  });

  it('a read older than PREP_MAX_AGE_MS is not fresh', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.advance(PREP_MAX_AGE_MS + 1);
    void s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch(() => {});
    expect(s.client.prepareApproval).toHaveBeenCalledTimes(1);
  });

  it('a new account: activates it (once), uses the relayer’s nonce and height, and says it was created', async () => {
    const s = setup({ key: null });
    const r = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    expect(s.near.activate).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ status: 'done', txHash: TX_HASH, created: true });
    expect(s.stages).toContain(STAGES.activating);
    const d = decodeNearDelegateAction(s.near.signDelegateAction.mock.calls[0]![0].delegateAction as Uint8Array);
    // nearDelegateNonce: above the relayer's key nonce ((height − 1) × 10^6).
    expect(d.nonce).toBeGreaterThan(BigInt((200_000_000 - 1) * 1_000_000));
    // The next stamp doesn't say it again, and doesn't activate again.
    const r2 = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'sponsored' }, s.stage);
    expect(r2).toMatchObject({ status: 'done', created: false });
    expect(s.near.activate).toHaveBeenCalledTimes(1);
  });

  it('retries activate and relay while the API answers near_account_unrecorded (409), then succeeds', async () => {
    const s = setup({ key: null });
    const unrecorded = hanaError(4100, { status: 409, reason: 'near_account_unrecorded', retryable: true });
    s.near.activate.mockRejectedValueOnce(unrecorded).mockRejectedValueOnce(unrecorded);
    const relay = s.near.relay.getMockImplementation()!;
    s.near.relay.mockRejectedValueOnce(unrecorded).mockImplementation(relay);
    const r = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    expect(r.status).toBe('done');
    expect(s.near.activate).toHaveBeenCalledTimes(3);
    expect(s.near.relay).toHaveBeenCalledTimes(2);
    // One approval only: the relay is retried with the same signed request.
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(1);
    expect(s.slept).toEqual([500, 1000, 500]);
  });

  it('gives up on near_account_unrecorded after about 20 s, and the refusal is in plain words', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.near.relay.mockRejectedValue(hanaError(4100, { status: 409, reason: 'near_account_unrecorded', retryable: true }));
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch((x: unknown) => x);
    expect(s.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
    expect(plainMessage(e, 'collect')).toMatch(/still setting up your NEAR account/u);
  });

  it('a relay timeout with the transaction sent is no error: `sent`, with its hash (D788)', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.near.relay.mockRejectedValueOnce(hanaError('api_unavailable', { status: 504, reason: 'timeout', transactionHash: TX_HASH }));
    expect(await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage)).toEqual({ status: 'sent', txHash: TX_HASH });
  });

  it('a relay timeout without a hash is an error that says it may still land', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.near.relay.mockRejectedValueOnce(hanaError('api_unavailable', { status: 504, reason: 'timeout' }));
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch((x: unknown) => x);
    expect(plainMessage(e, 'collect')).toBe('NEAR testnet hasn’t confirmed the transaction yet: it may still land. Refresh in a moment to see.');
  });

  it('a declined approval (4001) relays nothing', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.near.signDelegateAction.mockRejectedValueOnce(hanaError(4001));
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch((x: unknown) => x);
    expect(s.near.relay).not.toHaveBeenCalled();
    expect(plainMessage(e, 'collect')).toBe('Declined in the Journear Passport window: nothing was signed, no stamp was collected.');
  });

  it('an expired delegate (the relayer’s delegate_expired) drops the read, so the next click reads afresh', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.near.relay.mockRejectedValueOnce(hanaError(4100, { status: 400, reason: 'delegate_expired' }));
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch((x: unknown) => x);
    expect(plainMessage(e, 'collect')).toBe('The signed request expired before the relayer sent it. Try again.');
    void s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch(() => {});
    // The background re-read may have landed; the dropped read itself is never reused for a synchronous sign.
    expect(s.near.signDelegateAction.mock.calls.length + s.client.prepareApproval.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a nonce the relayer already used: reads again, builds above the relayer’s nonce, asks once more', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    const relay = s.near.relay.getMockImplementation()!;
    s.near.relay.mockRejectedValueOnce(hanaError(4100, { status: 409, reason: 'delegate_nonce_used', accessKeyNonce: '199999999000777' })).mockImplementation(relay);
    const r = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    expect(r.status).toBe('done');
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(2);
    const second = decodeNearDelegateAction(s.near.signDelegateAction.mock.calls[1]![0].delegateAction as Uint8Array);
    expect(second.nonce).toBeGreaterThan(199_999_999_000_777n);
    expect(s.stages).toContain(STAGES.retrying);
  });

  it('postcard: the note as the contract counts it (trimmed), and refused before any approval when empty or too long', async () => {
    const s = setup();
    await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'postcard', note: '  Greetings from 東京 👩‍💻  ' }, s.stage);
    const d = decodeNearDelegateAction(s.near.signDelegateAction.mock.calls[1]![0].delegateAction as Uint8Array);
    expect(decodeArgs((d.actions[0] as { args: Uint8Array }).args)).toEqual({ stamp: 'postcard', note: 'Greetings from 東京 👩‍💻' });
    for (const note of ['', '   ', 'x'.repeat(141)]) {
      const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'postcard', note }, s.stage).catch((x: unknown) => x);
      expect(plainMessage(e, 'collect')).toBe('The postcard needs a note of 1 to 140 characters.');
    }
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(2);
  });

  it('the contract’s refusal (relay 422 contract_rejected) is its ERR_* code in plain words', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'sponsored' }, s.stage).catch((x: unknown) => x);
    expect(plainMessage(e, 'collect')).toBe('Collect your Arrival stamp first: every passport starts with it.');
    await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    const e2 = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'layover' }, s.stage).catch((x: unknown) => x);
    expect(plainMessage(e2, 'collect')).toMatch(/^Not yet: the layover needs 2 minutes/u);
  });

  it('a failed read cancels the window prepareApproval opened', async () => {
    const s = setup();
    s.chain.down = true;
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage).catch((x: unknown) => x);
    expect(s.ticket.cancel).toHaveBeenCalledTimes(1);
    expect(plainMessage(e, 'collect')).toMatch(/couldn’t read NEAR testnet/u);
  });
});

describe('signature', () => {
  it('signs NEP-413 in the click with the exact message and the contract as recipient, then relays collect with the proof', async () => {
    const s = setup();
    await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    s.near.signDelegateAction.mockClear();
    s.stages.length = 0;
    const p = s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'signature' }, s.stage);
    // The first approval opens in the click: it needs no read.
    expect(s.near.signMessage).toHaveBeenCalledTimes(1);
    const arg = s.near.signMessage.mock.calls[0]![0];
    expect(arg.message).toBe(`Stamp my passport: ${NEAR_ACCOUNT}`);
    expect(arg.recipient).toBe(STAMPS);
    expect(arg.nonce).toEqual(new Uint8Array(32).fill(5));
    expect(arg.callbackUrl).toBeUndefined();
    expect(await p).toMatchObject({ status: 'done', txHash: TX_HASH });
    // The second approval: the relayed collect with the proof.
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(1);
    const d = decodeNearDelegateAction(s.near.signDelegateAction.mock.calls[0]![0].delegateAction as Uint8Array);
    const args = decodeArgs((d.actions[0] as { args: Uint8Array }).args);
    expect(args).toEqual({ stamp: 'signature', proof: { message: `Stamp my passport: ${NEAR_ACCOUNT}`, nonce: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=', recipient: STAMPS, signature: expect.any(String) } });
    expect(base64Decode((args.proof as { signature: string }).signature)).toHaveLength(64);
    expect(s.stages[0]).toBe(STAGES.signMessage);
    expect(s.chain.stamps.passports.get(NEAR_ACCOUNT)?.map((x) => x.stamp)).toEqual(['arrival', 'signature']);
  });

  it('a declined signature asks for nothing more', async () => {
    const s = setup();
    s.near.signMessage.mockRejectedValueOnce(hanaError(4001));
    await expect(s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'signature' }, s.stage)).rejects.toMatchObject({ code: 4001 });
    expect(s.near.signDelegateAction).not.toHaveBeenCalled();
    expect(s.near.relay).not.toHaveBeenCalled();
  });

  it('refuses a named account before any approval (its id is no public key)', async () => {
    const s = setup();
    const e = await s.collector.collect({ accountId: 'alice.testnet', stamp: 'signature' }, s.stage).catch((x: unknown) => x);
    expect(plainMessage(e, 'collect')).toMatch(/Only an account whose name is its own key/u);
    expect(s.near.signMessage).not.toHaveBeenCalled();
  });
});

describe('own_fare', () => {
  it('signs a collect transaction the account pays for and sends it with send_tx', async () => {
    const s = setup({ balance: String(5n * 10n ** 23n) });
    await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    await s.collector.refresh(NEAR_ACCOUNT);
    const p = s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'own_fare' }, s.stage);
    expect(s.near.signTransaction).toHaveBeenCalledTimes(1);
    expect(await p).toEqual({ status: 'done', txHash: TX_HASH, created: false });
    const tx = decodeNearTransaction(s.near.signTransaction.mock.calls[0]![0].transaction as Uint8Array);
    expect([tx.signerId, tx.receiverId]).toEqual([NEAR_ACCOUNT, STAMPS]);
    expect(decodeArgs((tx.actions[0] as { args: Uint8Array }).args)).toEqual({ stamp: 'own_fare' });
    expect(s.chain.count((c) => c.method === 'send_tx')).toBe(1);
    expect(s.chain.stamps.passports.get(NEAR_ACCOUNT)?.find((x) => x.stamp === 'own_fare')?.sponsored).toBe(false);
  });

  it('refuses without testnet NEAR for the fee, before any approval, and closes a window it opened', async () => {
    const s = setup({ balance: '0' });
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'own_fare' }, s.stage).catch((x: unknown) => x);
    expect(s.near.signTransaction).not.toHaveBeenCalled();
    expect(s.ticket.cancel).toHaveBeenCalledTimes(1);
    expect(plainMessage(e, 'collect')).toMatch(/enough testnet NEAR for the fee/u);
  });

  it('maps NEAR’s failure to the contract’s ERR_* and an RPC with no answer to `sent`', async () => {
    const s = setup({ balance: String(10n ** 24n) });
    await s.collector.refresh(NEAR_ACCOUNT);
    const e = await s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'own_fare' }, s.stage).catch((x: unknown) => x);
    expect(plainMessage(e, 'collect')).toBe('Collect your Arrival stamp first: every passport starts with it.');
    const rpc = newRpc(CONFIG, s.chain.fetch);
    s.chain.down = true;
    expect(await sendOwnFare(rpc, 'AAAA')).toBe('sent');
    s.chain.down = false;
    s.chain.sendTxAnswer = () => Response.json({ jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: { NotEnoughBalance: {} } } } });
    await expect(sendOwnFare(rpc, 'AAAA')).rejects.toMatchObject({ code: 'near_not_enough_balance' });
    s.chain.sendTxAnswer = () => Response.json({ jsonrpc: '2.0', id: 'x', result: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: <script>ERR_NOPE' } } } } } } });
    const odd = await sendOwnFare(rpc, 'AAAA').catch((x: unknown) => x);
    expect(plainMessage(odd, 'collect')).toBe('NEAR testnet refused or failed the transaction. Refresh to check, then try again.');
    // The contract's receipt out of storage balance: the storage notice, not "your account lacks NEAR".
    s.chain.sendTxAnswer = () => Response.json({ jsonrpc: '2.0', id: 'x', result: { status: { Failure: { ActionError: { index: 0, kind: { LackBalanceForState: { account_id: STAMPS, amount: '1' } } } } } } });
    await expect(sendOwnFare(rpc, 'AAAA')).rejects.toMatchObject({ code: 'stamps_contract_storage' });
  });
});

describe('background preparation', () => {
  it('reads, activates a new account, and starts at most once per 5 s', async () => {
    const s = setup({ key: null });
    s.collector.prepare(NEAR_ACCOUNT, true);
    s.collector.prepare(NEAR_ACCOUNT, true);
    await vi.waitFor(() => expect(s.near.activate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(s.collector.latest(NEAR_ACCOUNT)?.key).not.toBeNull());
    // Now a click signs at once.
    void s.collector.collect({ accountId: NEAR_ACCOUNT, stamp: 'arrival' }, s.stage);
    expect(s.near.signDelegateAction).toHaveBeenCalledTimes(1);
    expect(s.client.prepareApproval).not.toHaveBeenCalled();
  });

  it('reset forgets the read, the activation and the nonces', async () => {
    const s = setup();
    await s.collector.refresh(NEAR_ACCOUNT);
    s.collector.reset();
    expect(s.collector.latest(NEAR_ACCOUNT)).toBeNull();
  });
});
