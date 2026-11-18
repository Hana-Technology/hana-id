// "Free network fees" (D843) in the admin Worker: the plain words of every relayer state and halt reason (the tile's
// and the page's), the detail route (records in words, explorer links only for well-formed hashes, never a tool the
// relayer would certainly refuse), and the staff tools' route over the real console (the audit row before the tool, no
// row no action, the result's row after, the input checked first, a stale page, a refusal and an unknown answer in
// plain words, never retried). The API side is AdminRpc's (apps/api/test/rpc-evm-relay.test.ts), stubbed here.
import type { EvmRelayChainView, EvmRelayDetail, EvmRelayRecordView } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE_LABELS, actWords, evmRelayActRoute, evmRelayDetailRoute, explainChain, haltExplained, recordPlain, testEth, toolsOffered } from '../src/evm-relay.ts';
import type { RouteCtx } from '../src/routes.ts';
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
    lowBalanceWei: (50n * MILLI).toString(),
    dailyBudgetWei: (20n * MILLI).toString(),
    oneSendWorstWei: (6n * 10n ** 14n).toString(),
    relayer: { ok: true, started: true, halted: null, waiting: 0, awaitingConfirmation: 0, oldestWaitingMs: null, oldestNotTakenMs: null, nextSlot: 12, spentTodayWei: (3n * MILLI).toString(), unconfirmedRefusals: null, lastStaffSeq: 0, staffLog: [], ...relayer } as EvmRelayChainView['relayer'],
    budget: { ok: true, spentWei: (3n * MILLI).toString() },
    balance: { ok: true, wei: (112n * MILLI).toString() },
    helper: { address: '0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA', pinnedCodeHash: HASH, ok: true, codeHash: HASH, matches: true },
    ...over,
  };
}
const record = (slot: number, over: Partial<EvmRelayRecordView> = {}): EvmRelayRecordView => ({ slot, kind: 'action', onChain: false, taken: true, cancelling: false, sentAt: NOW - 60_000, deadlineAt: NOW + 240_000, copies: [{ hash: HASH, kind: 'action' }], refusedCode: null, app: { id: 'app_demo', name: 'Journear demo' }, ...over });
const halt = (reason: string, slot: number | null = 7, code: string | null = null) => ({ halted: { reason, since: NOW - 600_000, slot, code } });

describe('the words of each state', () => {
  it('working, not set up, low on money, paused: a plain label, a sentence and numbered steps, the code for engineers apart', () => {
    const working = explainChain(view(), NOW);
    expect([working.label, working.severity, working.explained, working.code]).toEqual(['Working', 'ok', null, null]);
    expect(working.title).toBe('Free network fees (Base Sepolia)');
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
        'Check the wallet’s balance below.',
        'Send at least 0.07 test ETH to the relayer wallet (its address is below) from a Base Sepolia faucet (docs.base.org, “Network faucets”).',
        'When the balance below shows the new amount, press Resume on the Free network fees page.',
        'If it pauses again for the same reason, it still needs more money: send more, then press Resume again.',
      ],
    });
    expect(paused.detail).toBe('Paused since 08:50 UTC (10 min). Nobody gets free network fees until a person fixes it. Nothing is lost.');
    // The low balance is its own problem besides the pause.
    expect(paused.extra.map((x) => x.key)).toEqual(['low']);
    expect(paused.walletUrl).toBe(`https://sepolia.basescan.org/address/${RELAYER}`);
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
        expect(t, `${reason} ${code}`).not.toMatch(/\bnonce\b|\bgas\b|\bRPC\b|\bmempool\b|\bEVM\b|halted|EIP|delegate|_/u);
        expect(t.length, t).toBeLessThan(260);
      }
    }
    // The two ways the key shows as used elsewhere share their words; every other case says something of its own.
    expect(whys.size).toBe(cases.length - 1);
    expect(haltExplained({ reason: 'relayer_cannot_send', slot: 7, code: 'replacement_underpriced' }, w).steps[0]).toBe('Tell an engineer now: treat the relayer’s key as leaked.');
    expect(haltExplained({ reason: 'foreign_transactions', slot: null, code: null }, w).steps).toContain('Under Advanced, use “Set the next slot number” with that number. It can only go up.');
    expect(haltExplained({ reason: 'nonce_gap', slot: 41, code: null }, w).why).toBe('Slot 41 is empty and nothing is waiting to fill it, so every transaction after it is stuck.');
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
    expect(used.extra[0]).toMatchObject({ severity: 'critical', title: 'Free network fees have used up today’s budget (0.02 test ETH): new requests are turned away until 00:00 UTC' });
  });

  it('amounts in test ETH, small ones not hidden', () => {
    expect([testEth(0n), testEth(10n ** 18n), testEth(1234n * 10n ** 14n), testEth(2n * 10n ** 13n), testEth(1n)]).toEqual(['0 test ETH', '1 test ETH', '0.1234 test ETH', '0.00002 test ETH', '0.00000001 test ETH']);
  });
});

describe('the waiting transactions and the tools offered', () => {
  it('each record in words, explorer links only for well-formed hashes, no cancel where the relayer would certainly refuse', () => {
    const r = recordPlain(record(9, { cancelling: true, copies: [{ hash: HASH, kind: 'action' }, { hash: 'javascript:alert(1)', kind: 'cancel' }] }), 84532, true, 'recorded');
    expect(r).toMatchObject({ slot: 9, app: 'Journear demo', state: 'cancelling', stateText: 'Being cancelled: the user’s action won’t happen', canCancel: true, canClose: true });
    expect(r.copies).toEqual([
      { hash: HASH, kind: 'action', url: `https://sepolia.basescan.org/tx/${HASH}` },
      { hash: 'unknown', kind: 'cancel', url: null },
    ]);
    expect(recordPlain(record(9, { onChain: true }), 84532, true, 'recorded')).toMatchObject({ stateText: 'On the network, being confirmed', canCancel: false, canClose: false });
    expect(recordPlain(record(9, { copies: Array.from({ length: 8 }, () => ({ hash: HASH, kind: 'action' as const })) }), 84532, true, 'recorded').canCancel).toBe(false);
    expect(recordPlain(record(9), 84532, false, 'recorded').canCancel).toBe(false);
    expect(recordPlain(record(9, { app: null }), 84532, true, 'unreadable').app).toBe('Can’t check right now');
    expect(recordPlain(record(9, { app: null }), 84532, true, 'recorded').app).toBe('Unknown app');
    expect(recordPlain(record(9, { kind: 'filler', app: null }), 84532, true, 'recorded').app).toBe('Staff gap filler');
    expect(recordPlain(record(9, { taken: false }), 84532, true, 'recorded').stateText).toBe('Not yet picked up by the network');
    // The local chain has no explorer: no link.
    expect(recordPlain(record(9), 31337, true, 'recorded').copies[0]!.url).toBeNull();
  });

  it('Resume only while paused; fill and the next slot only where they can apply; none on a fresh relayer or broken records', () => {
    expect(toolsOffered(view(), [])).toEqual({ resume: false, fill: { suggested: null, max: 11 }, adopt: { min: 12 }, noneBecause: null });
    expect(toolsOffered(view({}, { ...halt('nonce_gap', 9), waiting: 1 }), [record(10)])).toEqual({ resume: true, fill: { suggested: 9, max: 11 }, adopt: null, noneBecause: null });
    expect(toolsOffered(view({ key: 'missing' }, halt('foreign_transactions', null)), []).fill).toBeNull();
    expect(toolsOffered(view({}, { started: false, nextSlot: null }), []).noneBecause).toMatch(/hasn’t sent anything yet/u);
    expect(toolsOffered(view({}, halt('storage_inconsistent', null)), []).noneBecause).toMatch(/ask an engineer/u);
    expect(toolsOffered(view({ relayer: { ok: false, code: 'relayer_unavailable' } }), []).noneBecause).toMatch(/can’t be read/u);
  });

  it('every answer in words: done, each refusal, unknown', () => {
    expect(actWords('resume', null, { done: true, refused: null }, 84532)).toEqual({ tone: 'ok', title: 'Resume: done', text: 'Free network fees are running again.', code: null });
    expect(actWords('cancel', 42, { done: false, refused: 'nonce_mined' }, 84532)).toEqual({ tone: 'warn', title: 'Cancel this slot: the relayer said no. Nothing was changed.', text: 'Slot 42 is already used on the network. Wait: it finishes by itself.', code: 'nonce_mined' });
    expect(actWords('resume', null, { done: false, refused: 'relayer_cannot_send' }, 84532).text).toMatch(/^The problem is still there: the relayer’s wallet still can’t send transactions\./u);
    expect(actWords('resume', null, { done: false, refused: 'unknown' }, 84532)).toMatchObject({ tone: 'error', code: 'unknown' });
    expect(actWords('fill', 4, { done: false, refused: 'something_new' }, 84532).text).toMatch(/doesn’t know yet/u);
    for (const code of ['not_halted', 'incomplete_check', 'rpc_unavailable', 'no_record', 'nonce_not_consumed_at_confirmed_depth', 'receipt_found', 'key_mismatch', 'no_valid_replacement', 'fee_cap_too_low', 'record_exists', 'not_below_next_nonce', 'not_the_chains_next_nonce', 'below_next_nonce', 'unmined_records', 'chain_count_differs', 'no_state'])
      expect(actWords('fill', 4, { done: false, refused: code }, 84532).text, code).not.toMatch(/doesn’t know yet/u);
  });
});

// ---- the routes ----

const DETAIL: EvmRelayDetail = { chain: view({}, halt('relayer_cannot_send', 42, 'insufficient_funds')), records: [record(42), record(43, { onChain: true })], apps: 'recorded' };
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
    expect(d).toMatchObject({ chainId: 84532, title: 'Free network fees (Base Sepolia)', seen: { haltSince: NOW - 600_000, lastStaffSeq: 0 }, tools: { resume: true }, apps: 'recorded' });
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
  const body = { tool: 'resume', note: 'Sent 0.1 test ETH from the faucet', seen: { haltSince: NOW - 600_000, lastStaffSeq: 4 } };

  it('records the action first, then runs the tool, then records the answer: who, when, what, the note', async () => {
    const calls: Record<string, unknown>[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c as Record<string, unknown>), { ok: true, result: { done: true, refused: null, relayer: null } }) });
    const s = staff();
    const res = await evmRelayActRoute(ctx({ API: api }, body, '84532', s));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { done: true, refused: null }, words: { tone: 'ok', title: 'Resume: done', text: 'Free network fees are running again.', code: null } });
    expect(calls).toEqual([{ ...s, chainId: 84532, tool: 'resume', note: body.note, seen: body.seen }]);
    expect(await audit(s.requestId)).toEqual([
      { action: 'evm_relay.staff_action', org_id: null, actor_kind: 'hana', actor_email: STAFF_EMAIL, target: '84532', details_json: JSON.stringify({ tool: 'resume', chainId: 84532, slot: null, note: body.note }) },
      { action: 'evm_relay.staff_result', org_id: null, actor_kind: 'hana', actor_email: STAFF_EMAIL, target: '84532', details_json: JSON.stringify({ tool: 'resume', chainId: 84532, slot: null, result: 'done' }) },
    ]);
  });

  it('checks the input before anything: no audit row and no call for a bad tool, slot, note, seen or an extra field', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), { ok: true, result: { done: true, refused: null, relayer: null } }) });
    const bad: Record<string, unknown>[] = [
      { ...body, tool: 'drain' },
      { ...body, slot: 3 },
      { ...body, tool: 'cancel' },
      { ...body, tool: 'cancel', slot: -1 },
      { ...body, tool: 'cancel', slot: 2 ** 53 },
      { ...body, tool: 'cancel', slot: '3' },
      { ...body, note: 'too short' },
      { ...body, note: `${'x'.repeat(20)}\n${'y'.repeat(20)}` },
      { ...body, note: 'x'.repeat(301) },
      { ...body, seen: undefined },
      { ...body, actor: { kind: 'system', id: 'admin-cron' } },
      { ...body, chainId: 1 },
    ];
    for (const b of bad) {
      const s = staff();
      expect((await evmRelayActRoute(ctx({ API: api }, b, '84532', s))).status, JSON.stringify(b)).toBe(400);
      expect(await audit(s.requestId)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('no audit row, no action: the console down or refusing stops it before the API', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), { ok: true, result: { done: true, refused: null, relayer: null } }) });
    expect((await evmRelayActRoute(ctx({ API: api, CONSOLE: downBinding() }, body))).status).toBe(503);
    expect((await evmRelayActRoute(ctx({ API: api, CONSOLE: overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'internal' }) }) }, body))).status).toBe(500);
    expect(calls).toEqual([]);
  });

  it('a replayed request (the same request id) is refused by its audit row and does nothing', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { evmRelayAct: async (c: unknown) => (calls.push(c), { ok: true, result: { done: true, refused: null, relayer: null } }) });
    const s = staff();
    expect((await evmRelayActRoute(ctx({ API: api }, body, '84532', s))).status).toBe(200);
    expect((await evmRelayActRoute(ctx({ API: api }, body, '84532', s))).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('a stale page is 409 with plain words; the relayer’s refusal and an unknown answer are said plainly, recorded, and never retried', async () => {
    let answer: () => Promise<unknown> = async () => ({ ok: false, code: 'version_conflict', error: 'stale' });
    let n = 0;
    const api = overrideBinding(env.API, { evmRelayAct: async () => (n++, answer()) });
    let s = staff();
    const stale = await evmRelayActRoute(ctx({ API: api }, body, '84532', s));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { message: string } }).error.message).toMatch(/^The relayer changed since you opened this page/u);
    expect((await audit(s.requestId)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'stale_page']);
    answer = async () => ({ ok: true, result: { done: false, refused: 'relayer_cannot_send', relayer: null } });
    s = staff();
    const refused = await evmRelayActRoute(ctx({ API: api }, body, '84532', s));
    expect(await refused.json()).toMatchObject({ result: { done: false, refused: 'relayer_cannot_send' }, words: { tone: 'warn', code: 'relayer_cannot_send' } });
    expect((await audit(s.requestId)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'relayer_cannot_send']);
    answer = () => Promise.reject(new Error('Network connection lost.'));
    s = staff();
    const unknown = await evmRelayActRoute(ctx({ API: api }, body, '84532', s));
    expect(await unknown.json()).toMatchObject({ result: { done: false, refused: 'unknown' }, words: { tone: 'error' } });
    expect((await audit(s.requestId)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'unknown']);
    expect(n).toBe(3);
  });
});
