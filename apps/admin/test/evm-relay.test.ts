// "Gas sponsorship" (D843) in the admin Worker: the plain words of every relayer state and halt reason (the tile's
// and the page's), the detail route (records in words, explorer links only for well-formed hashes, never a tool the
// relayer would certainly refuse), and the staff tools' route over the real console (the audit row before the tool, no
// row no action, the result's row after, the input checked first, a stale page, a refusal and an unknown answer in
// plain words, never retried). The API side is AdminRpc's (apps/api/test/rpc-evm-relay.test.ts), stubbed here.
import { type EvmRelayChainView, type EvmRelayDetail, type EvmRelayRecordView, SECURITY_EVENT_KINDS } from '@hana-id/console-core';
import { PLAYBOOKS } from '@hana-id/playbooks';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE_LABELS, actWords, evmRelayActRoute, evmRelayDetailRoute, explainChain, haltExplained, recordPlain, testEth, toolsOffered } from '../src/evm-relay.ts';
import type { RouteCtx } from '../src/routes.ts';
import { SECURITY_EVENT_PLAYBOOKS, withWords } from '../src/security.ts';
import { STAFF_EMAIL, STAFF_SUB, adminRequest, downBinding, envWith, overrideBinding, stubNetwork, uid } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 18, 9, 0);
const MILLI = 10n ** 15n;
const RELAYER = '0x7aD3c18E50fB2a6D9e4C31b0F5A7E8c2d1B9f640';
const HASH = `0x${'ab'.repeat(32)}`;

function view(over: Partial<EvmRelayChainView> = {}, relayer: Record<string, unknown> = {}): EvmRelayChainView {
  return {
    chainId: 84532,
    readAt: NOW,
    relayerAddress: RELAYER,
    key: 'ok',
    readEndpoint: 'keyed',
    lowBalanceWei: (50n * MILLI).toString(),
    dailyBudgetWei: (20n * MILLI).toString(),
    oneSendWorstWei: (6n * 10n ** 14n).toString(),
    relayer: { ok: true, started: true, signerAddress: RELAYER, halted: null, waiting: 0, awaitingConfirmation: 0, oldestWaitingMs: null, oldestNotTakenMs: null, nextSlot: 12, spentTodayWei: (3n * MILLI).toString(), unconfirmedRefusals: null, lastStaffSeq: 0, staffLog: [], ...relayer } as EvmRelayChainView['relayer'],
    budget: { ok: true, spentWei: (3n * MILLI).toString() },
    balance: { ok: true, wei: (112n * MILLI).toString() },
    helper: { address: '0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA', pinnedCodeHash: HASH, ok: true, codeHash: HASH, matches: true },
    ...over,
  };
}
const record = (slot: number, over: Partial<EvmRelayRecordView> = {}): EvmRelayRecordView => ({ slot, kind: 'action', onChain: false, taken: true, cancelling: false, sentAt: NOW - 600_000, deadlineAt: NOW - 86_400_000, copies: [{ hash: HASH, kind: 'action' }], refusedCode: null, app: { id: 'app_demo', name: 'Journear demo' }, ...over });
const halt = (reason: string, slot: number | null = 7, code: string | null = null) => ({ halted: { reason, since: NOW - 600_000, slot, code } });

describe('the words of each state', () => {
  it('working, not set up, low on money, paused: a plain label, a sentence and numbered steps, the code for engineers apart', () => {
    const working = explainChain(view(), NOW);
    expect([working.label, working.severity, working.explained, working.code]).toEqual(['Working', 'ok', null, null]);
    expect(working.title).toBe('Gas sponsorship (Base Sepolia)');
    expect(working.lines.map((l) => [l.label, l.detail])).toEqual([
      ['Relayer wallet', RELAYER],
      ['Money in the wallet', '0.112 test ETH · low below 0.05 test ETH'],
      ['Spent today', '0.003 test ETH of the 0.02 test ETH daily budget (15%), counting the most each waiting one can cost'],
      ['Waiting to go through', 'None'],
      ['Account helper program', 'The checked version'],
    ]);
    const low = explainChain(view({ balance: { ok: true, wei: (31n * MILLI).toString() } }), NOW);
    expect([low.label, low.severity, low.playbook]).toEqual([STATE_LABELS.low, 'warning', 'evm-relay-balance-low']);
    expect(low.explained!.steps[0]).toBe('Send at least 0.07 test ETH to the relayer wallet (its address is below) from a Base Sepolia faucet (docs.base.org, “Network faucets”).');
    expect(explainChain(view({ balance: { ok: true, wei: '1000' } }), NOW).severity).toBe('critical');
    const missing = explainChain(view({ key: 'missing' }), NOW);
    expect([missing.label, missing.severity]).toEqual(['Not set up', 'warning']);
    expect(explainChain(view({ key: 'wrong' }), NOW)).toMatchObject({ label: 'Not set up', severity: 'critical' });
    const paused = explainChain(view({ balance: { ok: true, wei: '1000' } }, halt('relayer_cannot_send', 42, 'insufficient_funds')), NOW);
    expect([paused.label, paused.severity, paused.code, paused.since]).toEqual(['Paused: needs a person', 'critical', 'relayer_cannot_send · insufficient_funds · slot 42', NOW - 600_000]);
    expect(paused.explained).toEqual({
      why: 'The relayer’s wallet can’t send transactions: it is out of money.',
      steps: [
        'Open the relayer wallet on Basescan (its address is below). If money went out in transfers nobody at Journear made, stop: tell an engineer now and don’t send money.',
        'Check the wallet’s balance below.',
        'Send at least 0.07 test ETH to the relayer wallet (its address is below) from a Base Sepolia faucet (docs.base.org, “Network faucets”).',
        'When the balance below shows the new amount, press Resume on the Gas sponsorship page.',
        'If it pauses again for the same reason, it still needs more money: send more, then press Resume again.',
      ],
    });
    expect(paused.detail).toBe('Paused since 08:50 UTC (10 min). Gas sponsorship is stopped for everyone until a person fixes it. Nothing is lost.');
    // The low balance is its own problem besides the pause.
    expect(paused.extra.map((x) => x.key)).toEqual(['low']);
    expect(paused.walletUrl).toBe(`https://sepolia.basescan.org/address/${RELAYER}`);
  });

  it('a chain with no block explorer (the local one): no step names an explorer; the wallet’s recent transactions instead (D873 finding)', () => {
    const local = { ...view({ balance: { ok: true, wei: '1000' } }, halt('relayer_cannot_send', 0, 'insufficient_funds')), chainId: 31337 };
    const paused = explainChain(local, NOW);
    expect(paused.explained!.steps[0]).toBe('Check the relayer wallet’s recent transactions (ask an engineer if you can’t). If money went out in transfers nobody at Journear made, stop: tell an engineer now and don’t send money.');
    expect(paused.walletUrl).toBeNull();
    const none = { chain: 'the local test network', faucet: 'a faucet', explorer: null, refill: '0.07 test ETH' };
    const all = [haltExplained({ reason: 'relayer_cannot_send', slot: 3, code: 'nonce_too_low' }, none), haltExplained({ reason: 'relayer_cannot_send', slot: 3, code: 'insufficient_funds', leakSeen: true }, none)];
    expect(all[0]!.steps).toContain('After that, the engineer checks the relayer wallet’s recent transactions for any nobody at Journear sent.');
    for (const e of all) for (const step of e.steps) expect(step).not.toMatch(/explorer/iu);
    // With an explorer, as before.
    const base = explainChain(view({ balance: { ok: true, wei: '1000' } }, halt('relayer_cannot_send', 0, 'insufficient_funds')), NOW);
    expect(base.explained!.steps[0]).toMatch(/^Open the relayer wallet on Basescan/u);
  });

  it('every halt reason and refusal code has its own sentence and steps, and none uses a protocol word outside the code', () => {
    const w = { chain: 'Base Sepolia', faucet: 'a faucet', explorer: 'Basescan', refill: '0.07 test ETH' };
    const cases: [string, string | null][] = [
      ['relayer_cannot_send', 'insufficient_funds'],
      ['relayer_cannot_send', 'fee_cap_too_low'],
      ['relayer_cannot_send', 'replacement_underpriced'],
      ['relayer_cannot_send', 'sender_restricted'],
      ['relayer_cannot_send', 'nonce_too_low'],
      ['relayer_cannot_send', 'invalid_transaction'],
      ['nonce_consumed_elsewhere', null],
      ['nonce_gap', null],
      ['foreign_transactions', null],
      ['stuck_past_deadline', null],
      ['key_mismatch', null],
      ['storage_inconsistent', null],
      ['a_future_reason', null],
    ];
    const whys = new Set<string>();
    for (const [reason, code] of cases) {
      const e = haltExplained({ reason, slot: 7, code }, w);
      whys.add(e.why);
      expect(e.steps.length, reason).toBeGreaterThan(0);
      for (const t of [e.why, ...e.steps]) {
        // "Gas" is staff's own word since D879 ("gas sponsorship", "gas prices"); the other protocol words stay out.
        expect(t, `${reason} ${code}`).not.toMatch(/\bnonce\b|\bRPC\b|\bmempool\b|\bEVM\b|halted|EIP|delegate|_|free network fee/iu);
        expect(t.length, t).toBeLessThan(260);
      }
    }
    // The two ways the key shows as used elsewhere share their words; every other case says something of its own.
    expect(whys.size).toBe(cases.length - 1);
    expect(haltExplained({ reason: 'relayer_cannot_send', slot: 7, code: 'fee_cap_too_low' }, w)).toEqual({
      why: 'Gas prices are higher right now than the relayer is allowed to pay, so it can’t even send its own cancel.',
      steps: ['Wait: gas prices usually fall again within an hour.', 'Then press Resume on the Gas sponsorship page.', 'If it is still paused after a few hours, ask an engineer to raise the relayer’s fee limit (maxFeePerGasGwei in the settings).'],
    });
    expect(haltExplained({ reason: 'nonce_gap', slot: 41, code: null }, w).why).toBe('Slot 41 is empty and nothing is waiting to fill it, so every transaction after it is stuck. Only someone else using the relayer’s key leaves a gap like this.');
  });

  it('every halt that means the key may be someone else’s: the engineer first, slot tools are the engineer’s, never a refill, Resume only on the engineer’s word', () => {
    const w = { chain: 'Base Sepolia', faucet: 'a faucet', explorer: 'Basescan', refill: '0.07 test ETH' };
    const leaks: [string, string | null][] = [['nonce_consumed_elsewhere', null], ['nonce_gap', null], ['foreign_transactions', null], ['relayer_cannot_send', 'replacement_underpriced'], ['relayer_cannot_send', 'sender_restricted'], ['relayer_cannot_send', 'nonce_too_low'], ['relayer_cannot_send', 'nonce_too_high']];
    for (const [reason, code] of leaks) {
      const e = haltExplained({ reason, slot: 7, code }, w);
      expect(e.steps[0], reason).toBe('Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.');
      expect(e.steps[1], reason).toMatch(/^The engineer follows “A relayer key leaked” in docs\/operations\.md: .*the key is replaced\.$/u);
      expect(e.steps.at(-1), reason).toBe('Don’t press Resume until the engineer says the key is safe or replaced. Resume then asks you to confirm that.');
      expect(e.steps.join(' '), reason).not.toMatch(/faucet|Send at least|press Resume on the Free/u);
    }
    expect(haltExplained({ reason: 'nonce_consumed_elsewhere', slot: 7, code: null }, w).steps[2]).toBe('After that, the engineer closes slot 7 as “used by something else” on the Gas sponsorship page (under Advanced).');
    expect(haltExplained({ reason: 'nonce_gap', slot: 7, code: null }, w).steps[2]).toBe('After that, the engineer uses “Fill a gap” (under Advanced) for each empty slot, lowest first; the box above updates after each.');
    expect(haltExplained({ reason: 'foreign_transactions', slot: null, code: null }, w).steps[2]).toMatch(/“Set the next slot number” .* with the number the network gives/u);
    // A leak pause with a low wallet: no refill problem is raised beside it.
    const leak = explainChain(view({ balance: { ok: true, wei: '1000' } }, halt('foreign_transactions', null)), NOW);
    expect(leak.extra).toEqual([]);
    // The relayer can tell its key was replaced since the stop: its records' signer isn't the settings' wallet.
    const replaced = explainChain(view({}, { ...halt('nonce_consumed_elsewhere', 7), signerAddress: '0x1111111111111111111111111111111111111111' }), NOW);
    expect(replaced.explained!.why).toMatch(/The relayer’s key has been replaced since it stopped \(its transactions were signed by 0x1111…1111; the settings now name the wallet below\)\.$/u);
    // stuck_past_deadline: the fee limit and the 8-copies case said.
    const stuck = haltExplained({ reason: 'stuck_past_deadline', slot: 7, code: null }, w).steps;
    expect(stuck).toContain('If Cancel is refused because gas prices are above the relayer’s limit, ask an engineer to raise the fee limit.');
    expect(stuck).toContain('If slot 7 has no Cancel button, it already has 8 copies and the relayer can’t send another: ask an engineer.');
  });

  it('D843 re-check M: paused for money, but a sign of a leak seen since (the relayer’s mark) or the network ahead of the relayer: the leak steps, no refill, Resume needs the key confirmed', () => {
    const lowWallet = { balance: { ok: true as const, wei: '1000' } };
    const marked = explainChain(view(lowWallet, { halted: { reason: 'relayer_cannot_send', since: NOW - 600_000, slot: 42, code: 'insufficient_funds', leakSeen: true } }), NOW);
    expect(marked.explained!.why).toBe('The relayer’s wallet can’t send transactions: it is out of money. Since it stopped, the relayer has seen something that may mean someone else is using its key (or a slot was changed by hand on this page).');
    expect(marked.explained!.steps).toEqual([
      'Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.',
      'The engineer follows “A relayer key leaked” in docs/operations.md: gas sponsorship is switched off, the money left in the wallet is moved out, and the key is replaced.',
      'After that, the engineer checks the relayer wallet on Basescan for transactions nobody at Journear sent.',
      'Don’t press Resume until the engineer says the key is safe or replaced. Resume then asks you to confirm that.',
    ]);
    expect(marked.code).toBe('relayer_cannot_send · insufficient_funds · slot 42 · leak_seen');
    expect(marked.extra).toEqual([]);
    // The network's count above the relayer's next slot (the detail page reads it): the same, said as what the network shows.
    const paused = view(lowWallet, halt('relayer_cannot_send', 42, 'insufficient_funds'));
    const ahead = explainChain(paused, NOW, { ok: true, latest: 14, pending: 14 });
    expect(ahead.explained!.why).toMatch(/The network also shows more transactions from the relayer wallet than the relayer sent: someone else may be using its key\.$/u);
    expect(ahead.explained!.steps[0]).toBe('Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.');
    expect([ahead.code, ahead.extra]).toEqual(['relayer_cannot_send · insufficient_funds · slot 42 · chain_ahead', []]);
    // Not ahead (the count equal to the next slot), or unreadable: the money steps, the refill problem beside them.
    for (const count of [{ ok: true as const, latest: 12, pending: 12 }, { ok: false as const, code: 'rpc_unavailable' }]) {
      const plain = explainChain(paused, NOW, count as never);
      expect(plain.explained!.why).toBe('The relayer’s wallet can’t send transactions: it is out of money.');
      expect(plain.extra.map((x) => x.key)).toEqual(['low']);
    }
    // Resume asks for the confirmation in both cases, not in the plain one.
    expect(toolsOffered(view({}, { halted: { reason: 'relayer_cannot_send', since: NOW, slot: 1, code: 'insufficient_funds', leakSeen: true } }), [], { ok: true, latest: 12, pending: 12 }).resumeNeedsKeyConfirmation).toBe(true);
    expect(toolsOffered(paused, [], { ok: true, latest: 13, pending: 13 }).resumeNeedsKeyConfirmation).toBe(true);
    expect(toolsOffered(paused, [], { ok: true, latest: 12, pending: 12 }).resumeNeedsKeyConfirmation).toBe(false);
    // A refused Resume's answer, with the relayer's marked halt: the leak steps.
    const words = actWords('resume', null, { done: false, refused: 'relayer_cannot_send' }, 84532, { reason: 'relayer_cannot_send', slot: 42, code: 'insufficient_funds', leakSeen: true });
    expect(words.steps[0]).toBe('Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.');
  });

  it('the helper not the checked version, unreadable parts, the budget, the waiting time and backup-server refusals', () => {
    expect(explainChain(view({ helper: { address: '0x1', pinnedCodeHash: HASH, ok: true, codeHash: `0x${'cd'.repeat(32)}`, matches: false } }), NOW)).toMatchObject({ label: 'Needs a person', severity: 'critical', code: 'helper_mismatch' });
    expect(explainChain(view({ helper: { address: '0x1', pinnedCodeHash: HASH, ok: true, codeHash: null, matches: false } }), NOW)).toMatchObject({ code: 'helper_missing' });
    expect(explainChain(view({ balance: { ok: false, code: 'rpc_unavailable' } }), NOW)).toMatchObject({ label: 'Can’t check right now', severity: 'unknown' });
    expect(explainChain(view({ relayer: { ok: false, code: 'relayer_timeout' } }), NOW)).toMatchObject({ label: 'Can’t check right now', code: 'relayer_timeout' });
    const busy = explainChain(view({ budget: { ok: true, spentWei: (17n * MILLI).toString() } }, { waiting: 2, oldestWaitingMs: 11 * 60_000, oldestNotTakenMs: 30_000, unconfirmedRefusals: { count: 3, lastAt: NOW - 600_000, slot: 5, code: 'insufficient_funds' } }), NOW);
    expect(busy.label).toBe('Working');
    expect(busy.extra.map((x) => [x.key, x.severity])).toEqual([['budget', 'warning']]);
    expect(busy.lines.find((l) => l.label === 'Waiting to go through')).toEqual({ label: 'Waiting to go through', state: 'warning', detail: '2 · the oldest for 11 min · not yet picked up by the network: the oldest for 30 s' });
    expect(busy.lines.find((l) => l.label === 'Send problems a backup server reported')?.detail).toBe('3 (the last 10 min ago). These don’t pause it. If the number keeps rising, ask an engineer.');
    const used = explainChain(view({ budget: { ok: true, spentWei: (20n * MILLI).toString() } }), NOW);
    expect(explainChain(view({ budget: { ok: false, code: 'rate_limiter_unavailable' } }), NOW).lines.find((l) => l.label === 'Spent today')).toEqual({ label: 'Spent today', state: 'unknown', detail: 'Can’t check right now (rate_limiter_unavailable)' });
    // The API's stuck alert fires at 2 minutes: so does the line, for the oldest waiting or the oldest not taken.
    expect(explainChain(view({}, { waiting: 1, oldestWaitingMs: 150_000, oldestNotTakenMs: null }), NOW).lines.find((l) => l.label === 'Waiting to go through')!.state).toBe('warning');
    expect(explainChain(view({}, { waiting: 1, oldestWaitingMs: 90_000, oldestNotTakenMs: 90_000 }), NOW).lines.find((l) => l.label === 'Waiting to go through')!.state).toBe('ok');
    expect(used.extra[0]).toMatchObject({ severity: 'critical', title: 'Gas sponsorship has used up today’s budget (0.02 test ETH): new requests are turned away until 00:00 UTC' });
  });

  it('amounts in test ETH, small ones not hidden', () => {
    expect([testEth(0n), testEth(10n ** 18n), testEth(1234n * 10n ** 14n), testEth(2n * 10n ** 13n), testEth(1n)]).toEqual(['0 test ETH', '1 test ETH', '0.1234 test ETH', '0.00002 test ETH', '0.00000001 test ETH']);
  });
});

describe('the waiting transactions and the tools offered', () => {
  it('each record in words, explorer links only for well-formed hashes, no cancel where the relayer would certainly refuse', () => {
    const r = recordPlain(record(9, { cancelling: true, copies: [{ hash: HASH, kind: 'action' }, { hash: 'javascript:alert(1)', kind: 'cancel' }] }), 84532, true, 'recorded', NOW, null);
    expect(r).toMatchObject({ slot: 9, app: 'Journear demo', state: 'cancelling', stateText: 'Being cancelled: the user’s action won’t happen', canCancel: true, canClose: true });
    expect(r.copies).toEqual([
      { hash: HASH, kind: 'action', url: `https://sepolia.basescan.org/tx/${HASH}` },
      { hash: 'unknown', kind: 'cancel', url: null },
    ]);
    expect(recordPlain(record(9, { onChain: true }), 84532, true, 'recorded', NOW, null)).toMatchObject({ stateText: 'On the network, being confirmed', canCancel: false, canClose: false });
    expect(recordPlain(record(9, { copies: Array.from({ length: 8 }, () => ({ hash: HASH, kind: 'action' as const })) }), 84532, true, 'recorded', NOW, null).canCancel).toBe(false);
    expect(recordPlain(record(9), 84532, false, 'recorded', NOW, null).canCancel).toBe(false);
    expect(recordPlain(record(9, { app: null }), 84532, true, 'unreadable', NOW, null).app).toBe('Can’t check right now');
    expect(recordPlain(record(9, { app: null }), 84532, true, 'recorded', NOW, null).app).toBe('Unknown app');
    expect(recordPlain(record(9, { kind: 'filler', app: null }), 84532, true, 'recorded', NOW, null).app).toBe('Staff gap filler');
    expect(recordPlain(record(9, { taken: false }), 84532, true, 'recorded', NOW, null).stateText).toBe('Not yet picked up by the network');
    // The local chain has no explorer: no link.
    expect(recordPlain(record(9), 31337, true, 'recorded', NOW, null).copies[0]!.url).toBeNull();
  });

  it('Cancel only once a slot’s time limit has passed, or during a stuck_past_deadline pause; else why in words', () => {
    const early = record(9, { deadlineAt: NOW + 60_000 });
    expect(recordPlain(early, 84532, true, 'recorded', NOW, null)).toMatchObject({ canCancel: false, noCancelBecause: 'Cancel shows once its time limit has passed.' });
    expect(recordPlain(early, 84532, true, 'recorded', NOW, 'stuck_past_deadline')).toMatchObject({ canCancel: true, noCancelBecause: null });
    expect(recordPlain(record(9), 84532, true, 'recorded', NOW, null)).toMatchObject({ canCancel: true, noCancelBecause: null });
    expect(recordPlain(record(9, { copies: Array.from({ length: 8 }, () => ({ hash: HASH, kind: 'action' as const })) }), 84532, true, 'recorded', NOW, null).noCancelBecause).toBe('No Cancel: it already has 8 copies, the most the relayer sends. Ask an engineer.');
  });

  it('a slot the network shows used by someone else’s transaction (nonce_consumed_elsewhere): said so, no Cancel; Close is the tool (D873 finding)', () => {
    const r = recordPlain(record(9, { deadlineAt: NOW - 60_000 }), 84532, true, 'recorded', NOW, 'nonce_consumed_elsewhere', 9);
    expect(r).toMatchObject({ state: 'used_elsewhere', stateText: 'Used by a transaction Journear didn’t send: it won’t go through', canCancel: false, canClose: true });
    expect(r.noCancelBecause).toBe('No Cancel: the network shows this slot already used. Close it instead (under Advanced), once the engineer says so.');
    // Another slot of the same pause, or the same slot in another pause, reads as before.
    expect(recordPlain(record(10, { deadlineAt: NOW + 60_000 }), 84532, true, 'recorded', NOW, 'nonce_consumed_elsewhere', 9)).toMatchObject({ state: 'sent', stateText: 'Sent, waiting to go through' });
    expect(recordPlain(record(9), 84532, true, 'recorded', NOW, 'nonce_gap', 9)).toMatchObject({ state: 'sent', canCancel: true });
  });

  it('Resume only while paused; fill and the next slot only where they can apply; none on a fresh relayer or broken records', () => {
    const count = (latest: number, pending = latest) => ({ ok: true as const, latest, pending });
    expect(toolsOffered(view(), [], count(14))).toEqual({ resume: false, resumeNeedsKeyConfirmation: false, fill: { suggested: null, max: 11 }, adopt: { suggested: 14, min: 12 }, adoptBecause: null, noneBecause: null });
    expect(toolsOffered(view({}, { ...halt('nonce_gap', 9), waiting: 1 }), [record(10)], count(9))).toEqual({ resume: true, resumeNeedsKeyConfirmation: true, fill: { suggested: 9, max: 11 }, adopt: null, adoptBecause: 'Not possible now: wait until nothing is waiting.', noneBecause: null });
    expect(toolsOffered(view({}, halt('relayer_cannot_send', 3, 'insufficient_funds')), [], count(12)).resumeNeedsKeyConfirmation).toBe(false);
    expect(toolsOffered(view({ key: 'missing' }, halt('foreign_transactions', null)), [], count(12)).fill).toBeNull();
    // The network's own count: read (never the explorer's list, which counts incoming transfers); unreadable or still moving: ask an engineer, or wait.
    expect(toolsOffered(view(), [], { ok: false, code: 'rpc_unavailable' }).adoptBecause).toBe('The network’s count for the relayer wallet can’t be read right now: ask an engineer.');
    expect(toolsOffered(view(), [], count(14, 15)).adoptBecause).toMatch(/still has transactions from the relayer wallet waiting/u);
    expect(toolsOffered(view(), [], count(10)).adoptBecause).toMatch(/below the relayer’s next slot/u);
    expect(toolsOffered(view({}, { started: false, nextSlot: null }), [], count(0)).noneBecause).toMatch(/hasn’t sent anything yet/u);
    expect(toolsOffered(view({}, halt('storage_inconsistent', null)), [], count(0)).noneBecause).toMatch(/ask an engineer/u);
    expect(toolsOffered(view({ relayer: { ok: false, code: 'relayer_unavailable' } }), [], count(0)).noneBecause).toMatch(/can’t be read/u);
  });

  it('every answer in words: done, each refusal, unknown', () => {
    expect(actWords('resume', null, { done: true, refused: null }, 84532)).toEqual({ tone: 'ok', title: 'Resume: done', text: 'Gas sponsorship is running again.', steps: [], code: null });
    expect(actWords('cancel', 42, { done: false, refused: 'nonce_mined' }, 84532)).toEqual({ tone: 'warn', title: 'Cancel this slot: the relayer said no. Nothing was changed.', text: 'Slot 42 is already used on the network. Wait: it finishes by itself.', steps: [], code: 'nonce_mined' });
    expect(actWords('resume', null, { done: false, refused: 'relayer_cannot_send' }, 84532).text).toMatch(/^The problem is still there: the relayer’s wallet still can’t send transactions\./u);
    // After a refused Resume, the relayer's latest condition and its steps (not the first halt's).
    const later = actWords('resume', null, { done: false, refused: 'nonce_gap' }, 84532, { reason: 'nonce_gap', slot: 41, code: null });
    expect(later).toMatchObject({ text: 'The problem is still there: slot 41 is empty and nothing is waiting to fill it, so every transaction after it is stuck. Only someone else using the relayer’s key leaves a gap like this.', code: 'nonce_gap · slot 41' });
    expect(later.steps[0]).toMatch(/^Tell an engineer now/u);
    expect(actWords('cancel', 9, { done: false, refused: 'not_past_deadline' }, 84532).text).toBe('Slot 9’s time limit hasn’t passed yet: it may still go through. Cancel is for a slot past its time limit.');
    expect(actWords('resume', null, { done: false, refused: 'key_confirmation_required' }, 84532).text).toMatch(/confirm that an engineer said the key is safe or replaced/u);
    // Closing a slot says exactly what happens to the books today.
    expect(actWords('close', 7, { done: true, refused: null }, 84532).text).toBe('Slot 7 is closed as used by something else. The user’s action in it is marked as not done. The app is not charged: Journear covers it.');
    expect(actWords('resume', null, { done: false, refused: 'unknown' }, 84532)).toMatchObject({ tone: 'error', code: 'unknown' });
    expect(actWords('fill', 4, { done: false, refused: 'something_new' }, 84532).text).toMatch(/doesn’t know yet/u);
    for (const code of ['not_halted', 'incomplete_check', 'rpc_unavailable', 'no_record', 'nonce_not_consumed_at_confirmed_depth', 'receipt_found', 'key_mismatch', 'no_valid_replacement', 'fee_cap_too_low', 'record_exists', 'not_below_next_nonce', 'not_the_chains_next_nonce', 'below_next_nonce', 'unmined_records', 'chain_count_differs', 'no_state'])
      expect(actWords('fill', 4, { done: false, refused: code }, 84532).text, code).not.toMatch(/doesn’t know yet/u);
  });
});

// ---- the routes ----

const DETAIL: EvmRelayDetail = { chain: view({}, halt('relayer_cannot_send', 42, 'insufficient_funds')), records: [record(42), record(43, { onChain: true })], apps: 'recorded', chainCount: { ok: true, latest: 12, pending: 12 } };
const staff = () => ({ actor: { kind: 'hana' as const, id: STAFF_SUB, email: STAFF_EMAIL }, requestId: `req_${uid()}`, clientIp: '198.51.100.9' });
const ctx = (over: Partial<typeof env>, body: Record<string, unknown> = {}, chain = '84532', s = staff()): RouteCtx => ({
  request: new Request(`https://admin.test/api/evm-relay/${chain}/act`, { method: 'POST' }),
  env: envWith(over),
  staff: s,
  url: new URL(`https://admin.test/api/evm-relay/${chain}/act`),
  params: { chain },
  body,
});
const audit = (requestId: string) =>
  env.CONSOLE_TEST_DB.prepare("SELECT action, org_id, actor_kind, actor_email, target, details_json FROM audit_log WHERE request_id = ? AND action LIKE 'evm_relay.%' ORDER BY seq").bind(requestId).all<Record<string, unknown>>().then((r) => r.results);

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/evm-relay/:chain', () => {
  it('needs a staff Access JWT; the act needs the CSRF headers too', async () => {
    expect((await adminRequest('/api/evm-relay/84532', { jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/evm-relay/84532/act', { body: { tool: 'resume' }, jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/evm-relay/84532/act', { body: { tool: 'resume' }, csrf: false })).status).toBe(403);
    expect((await adminRequest('/api/evm-relay/84532/act', { method: 'GET' })).status).toBe(405);
  });

  it('answers the page in words, with what the page must send back (`seen`) and the tools that may apply', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayDetail: async (c: unknown) => (calls.push(c), { ok: true, detail: DETAIL }) });
    const res = await evmRelayDetailRoute(ctx({ API: api }));
    const d = (await res.json()) as Record<string, unknown> & { records: { slot: number; canCancel: boolean }[]; plain: { label: string } };
    expect(res.status).toBe(200);
    expect(calls).toEqual([expect.objectContaining({ chainId: 84532, actor: expect.objectContaining({ kind: 'hana' }) })]);
    expect(d).toMatchObject({ chainId: 84532, title: 'Gas sponsorship (Base Sepolia)', seen: { haltSince: NOW - 600_000, lastStaffSeq: 0 }, tools: { resume: true }, apps: 'recorded', token: expect.stringMatching(/^evmact_[A-Za-z0-9_-]{22}$/u) });
    expect(d.plain.label).toBe('Paused: needs a person');
    expect(d.records.map((r) => [r.slot, r.canCancel])).toEqual([
      [42, true],
      [43, false],
    ]);
  });

  it('a malformed chain is not found without a call; the API’s refusal and its absence are said', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayDetail: async (c: unknown) => (calls.push(c), { ok: false, code: 'not_found', error: 'EVM sponsorship is not set up in this environment' }) });
    for (const chain of ['0', '-1', '84532.0', 'x', '1'.repeat(17)]) expect((await evmRelayDetailRoute(ctx({ API: api }, {}, chain))).status, chain).toBe(404);
    expect(calls).toEqual([]);
    expect((await evmRelayDetailRoute(ctx({ API: api }))).status).toBe(404);
    expect((await evmRelayDetailRoute(ctx({ API: downBinding() }))).status).toBe(503);
  });
});

describe('POST /api/evm-relay/:chain/act', () => {
  /** A detail page's one-time token (the audit rows' request id). */
  const token = () => `evmact_${uid().replace(/[^A-Za-z0-9]/gu, 'x').padEnd(22, 'x').slice(0, 22)}`;
  const body = (over: Record<string, unknown> = {}) => ({ token: token(), tool: 'resume', note: 'Sent 0.1 test ETH from the faucet', seen: { haltSince: NOW - 600_000, lastStaffSeq: 4 }, ...over });
  const ok = { ok: true, result: { done: true, refused: null, relayer: null } };

  it('records the action first (keyed by the page’s token), then runs the tool, then records the answer: who, when, what, the note', async () => {
    const calls: Record<string, unknown>[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c as Record<string, unknown>), ok) });
    const s = staff();
    const b = body();
    const res = await evmRelayActRoute(ctx({ API: api }, b, '84532', s));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { done: true, refused: null }, words: { tone: 'ok', title: 'Resume: done', text: 'Gas sponsorship is running again.', steps: [], code: null } });
    expect(calls).toEqual([{ ...s, requestId: b.token, chainId: 84532, tool: 'resume', note: b.note, seen: b.seen }]);
    expect(await audit(b.token)).toEqual([
      { action: 'evm_relay.staff_action', org_id: null, actor_kind: 'hana', actor_email: STAFF_EMAIL, target: '84532', details_json: JSON.stringify({ tool: 'resume', chainId: 84532, slot: null, note: b.note }) },
      { action: 'evm_relay.staff_result', org_id: null, actor_kind: 'hana', actor_email: STAFF_EMAIL, target: '84532', details_json: JSON.stringify({ tool: 'resume', chainId: 84532, slot: null, result: 'done' }) },
    ]);
  });

  it('a Resume confirmed by the engineer keeps that confirmation in the audit row', async () => {
    const calls: Record<string, unknown>[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c as Record<string, unknown>), ok) });
    const b = body({ keyConfirmed: true });
    expect((await evmRelayActRoute(ctx({ API: api }, b))).status).toBe(200);
    expect(calls[0]).toMatchObject({ keyConfirmed: true });
    expect(JSON.parse(String((await audit(b.token))[0]!.details_json))).toMatchObject({ keyConfirmed: true });
    expect((await evmRelayActRoute(ctx({ API: api }, body({ tool: 'cancel', slot: 3, keyConfirmed: true })))).status).toBe(400);
  });

  it('checks the input before anything: no audit row and no call for a bad token, tool, slot, note, seen or an extra field', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), ok) });
    const bad: Record<string, unknown>[] = [
      body({ token: undefined }),
      body({ token: 'req_not_a_page_token' }),
      body({ tool: 'drain' }),
      body({ slot: 3 }),
      body({ tool: 'cancel' }),
      body({ tool: 'cancel', slot: -1 }),
      body({ tool: 'cancel', slot: 2 ** 53 }),
      body({ tool: 'cancel', slot: '3' }),
      body({ note: 'too short' }),
      body({ note: `${'x'.repeat(20)}\n${'y'.repeat(20)}` }),
      body({ note: `A note with a zero-width​join inside it` }),
      body({ note: 'x'.repeat(301) }),
      body({ seen: undefined }),
      body({ keyConfirmed: false }),
      body({ actor: { kind: 'system', id: 'admin-cron' } }),
      body({ chainId: 1 }),
    ];
    for (const b of bad) {
      expect((await evmRelayActRoute(ctx({ API: api }, b))).status, JSON.stringify(b)).toBe(400);
      if (typeof b.token === 'string') expect(await audit(b.token)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('no audit row, no action: the console down or refusing stops it before the API', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), ok) });
    expect((await evmRelayActRoute(ctx({ API: api, CONSOLE: downBinding() }, body()))).status).toBe(503);
    expect((await evmRelayActRoute(ctx({ API: api, CONSOLE: overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'internal' }) }) }, body()))).status).toBe(500);
    expect(calls).toEqual([]);
  });

  it('an older API or console: the plain message, nothing recorded, nothing done', async () => {
    const calls: unknown[] = [];
    // An API before this release has no evmRelayVersion (nor the tool): asked first, so no audit row is written.
    const oldApi = { evmRelayAct: async (c: unknown) => (calls.push(c), ok) } as unknown as typeof env.API;
    const b = body();
    const res = await evmRelayActRoute(ctx({ API: oldApi }, b));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'api_outdated', message: 'This page is newer than the API: deploy the API first (then this admin console). Nothing was done.' } });
    expect(await audit(b.token)).toEqual([]);
    // A console before this release refuses the new audit action (bad_request): nothing done.
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), ok) });
    const oldConsole = overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'bad_request', error: 'action: Invalid enum value' }) });
    expect(((await (await evmRelayActRoute(ctx({ API: api, CONSOLE: oldConsole }, body()))).json()) as { error: { code: string } }).error.code).toBe('console_outdated');
    expect(calls).toEqual([]);
    // The detail page on an older API: the same plain message.
    const page = await evmRelayDetailRoute(ctx({ API: {} as typeof env.API }));
    expect(page.status).toBe(503);
    expect(((await page.json()) as { error: { code: string } }).error.code).toBe('api_outdated');
  });

  it('a re-submitted form (the same page token) is already_applied and does nothing a second time', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), ok) });
    const b = body();
    // Two requests (two cf-ray ids), one form: the second finds its audit row.
    expect((await evmRelayActRoute(ctx({ API: api }, b, '84532', staff()))).status).toBe(200);
    const again = await evmRelayActRoute(ctx({ API: api }, b, '84532', staff()));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'already_applied', message: expect.stringMatching(/^This form was already sent once/u) });
    expect(calls).toHaveLength(1);
  });

  it('a stale page is 409 with plain words; the relayer’s refusal and an unknown answer are said plainly, recorded, and never retried', async () => {
    let answer: () => Promise<unknown> = async () => ({ ok: false, code: 'version_conflict', error: 'stale' });
    let n = 0;
    const api = overrideBinding(env.API, { evmRelayAct: async () => (n++, answer()) });
    let b = body();
    const stale = await evmRelayActRoute(ctx({ API: api }, b));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { message: string } }).error.message).toMatch(/^The relayer changed since you opened this page/u);
    expect((await audit(b.token)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'stale_page']);
    // A refused Resume: the words come from the relayer's condition now (its answer's halt), with its steps.
    answer = async () => ({ ok: true, result: { done: false, refused: 'nonce_gap', relayer: { halted: { reason: 'nonce_gap', since: NOW, slot: 41, code: null } } } });
    b = body();
    const refused = await evmRelayActRoute(ctx({ API: api }, b));
    expect(await refused.json()).toMatchObject({ result: { done: false, refused: 'nonce_gap' }, words: { tone: 'warn', code: 'nonce_gap · slot 41', steps: expect.arrayContaining([expect.stringMatching(/^Tell an engineer now/u)]) } });
    expect((await audit(b.token)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'nonce_gap']);
    answer = () => Promise.reject(new Error('Network connection lost.'));
    b = body();
    const unknown = await evmRelayActRoute(ctx({ API: api }, b));
    expect(await unknown.json()).toMatchObject({ result: { done: false, refused: 'unknown' }, words: { tone: 'error' } });
    expect((await audit(b.token)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'unknown']);
    expect(n).toBe(3);
  });
});

describe('the security page’s events', () => {
  it('every gas sponsorship and billing-late event kind links to a playbook that exists (D843; D869’s evm_relay_closed_slot_mined included)', () => {
    const kinds = SECURITY_EVENT_KINDS.filter((k) => k.startsWith('evm_') || k.endsWith('_billing_late'));
    expect(kinds).toEqual(expect.arrayContaining(['evm_relay_nonce_taken', 'evm_relay_closed_slot_mined', 'evm_billing_late', 'near_billing_late']));
    const ids = new Set(PLAYBOOKS.map((p) => p.id));
    for (const k of kinds) {
      expect(Object.hasOwn(SECURITY_EVENT_PLAYBOOKS, k), k).toBe(true);
      expect(ids.has(SECURITY_EVENT_PLAYBOOKS[k]!), k).toBe(true);
      expect(withWords({ kind: k } as never).playbook?.id, k).toBe(SECURITY_EVENT_PLAYBOOKS[k]);
    }
    expect(withWords({ kind: 'evm_relay_closed_slot_mined' } as never)).toMatchObject({ title: 'Gas sponsorship: a slot staff closed went through after all', playbook: { id: 'evm-relay-closed-slot-mined' } });
  });
});
