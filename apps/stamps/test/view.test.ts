// Which stamps are available, computed from chain state (D800), and the rest of the PassportView.
import { describe, expect, it } from 'vitest';
import type { ChainStamp, StampId } from '../src/stamps.ts';
import { CONTINUE, FAUCET_NOTICE, LAYOVER_MARGIN_MS, LOCKED, OWN_FARE_HELP, SENT_STAGE, UNVIEWABLE_NOTICE, type ViewInput, buildView, countdownText, layoverCounting } from '../src/view.ts';
import { CONFIG, NEAR_ACCOUNT } from './fixtures.ts';
import { TX_HASH } from './fakes.ts';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://hana-id-stamps-sandbox-dev.tingtc.workers.dev';

function input(patch: Partial<ViewInput> = {}): ViewInput {
  return {
    mode: 'mine',
    accountId: NEAR_ACCOUNT,
    passport: null,
    local: new Map(),
    txs: new Map(),
    sent: new Map(),
    working: null,
    step2: new Set(),
    failed: new Map(),
    fresh: new Set(),
    balance: { yocto: 0n, activated: true },
    recent: [],
    totals: null,
    notice: null,
    busy: false,
    explorer: CONFIG.near.explorer,
    faucet: CONFIG.near.faucet,
    origin: ORIGIN,
    ...patch,
  };
}

const held = (...stamps: [StampId, number?][]) => ({ accountId: NEAR_ACCOUNT, stamps: stamps.map(([stamp, atMs]) => ({ stamp, atMs: atMs ?? NOW - 600_000, sponsored: stamp !== 'own_fare' })) });
const statuses = (v: ReturnType<typeof buildView>) => Object.fromEntries(v.stamps.map((s) => [s.id, s.status === 'locked' ? `locked: ${s.reason}` : s.status]));

describe('buildView', () => {
  it('always all six, in catalog order', () => {
    for (const mode of ['cover', 'mine', 'public'] as const) expect(buildView(input({ mode }), NOW).stamps.map((s) => s.id)).toEqual(['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover']);
  });

  it('the cover: every stamp locked behind sign-in, no account', () => {
    const v = buildView(input({ mode: 'cover', accountId: null, passport: undefined, balance: null }), NOW);
    expect(new Set(v.stamps.map((s) => s.status === 'locked' && s.reason))).toEqual(new Set([LOCKED.signIn]));
    expect(v.accountId).toBeUndefined();
    expect(v.shareUrl).toBeUndefined();
    expect(v.balanceNear).toBeUndefined();
  });

  it('no passport yet: Arrival only', () => {
    expect(statuses(buildView(input(), NOW))).toEqual({
      arrival: 'available',
      sponsored: `locked: ${LOCKED.arrivalFirst}`,
      own_fare: `locked: ${LOCKED.arrivalFirst}`,
      signature: `locked: ${LOCKED.arrivalFirst}`,
      postcard: `locked: ${LOCKED.arrivalFirst}`,
      layover: `locked: ${LOCKED.arrivalFirst}`,
    });
    expect(statuses(buildView(input({ passport: undefined }), NOW)).arrival).toBe(`locked: ${LOCKED.reading}`);
  });

  it('D807: a step that needs a click: the signature’s second (kept message), a failure of it, and any approval waiting on the launcher', () => {
    const passport = held(['arrival']);
    const step2 = buildView(input({ passport, step2: new Set(['signature']) }), NOW);
    expect(step2.stamps[3]).toEqual({ id: 'signature', status: 'continue', stage: CONTINUE.signature, action: 'Continue' });
    const failedStep2 = buildView(input({ passport, step2: new Set(['signature']), failed: new Map([['signature', 'Relayer down.']]) }), NOW);
    expect(failedStep2.stamps[3]).toEqual({ id: 'signature', status: 'failed', message: 'Relayer down.' });
    const waiting = buildView(input({ passport, step2: new Set(['signature']), working: { id: 'signature', stage: 'x', waiting: true }, busy: true }), NOW);
    expect(waiting.stamps[3]).toEqual({ id: 'signature', status: 'continue', stage: CONTINUE.signature, action: 'Continue' });
    const other = buildView(input({ passport, working: { id: 'sponsored', stage: 'x', waiting: true }, busy: true }), NOW);
    expect(other.stamps[1]).toEqual({ id: 'sponsored', status: 'continue', stage: CONTINUE.waiting, action: 'Continue' });
    expect(buildView(input({ passport, working: { id: 'sponsored', stage: 'x' } }), NOW).stamps[1]).toEqual({ id: 'sponsored', status: 'working', stage: 'x' });
    // Someone else's passport never shows it.
    expect(buildView(input({ mode: 'public', passport, step2: new Set(['signature']) }), NOW).stamps[3]?.status).toBe('locked');
  });

  it('after Arrival: Own fare needs testnet NEAR (with the faucet), the layover counts down, the rest open', () => {
    const v = buildView(input({ passport: held(['arrival', NOW - 20_000]) }), NOW);
    expect(statuses(v)).toEqual({
      arrival: 'collected',
      sponsored: 'available',
      own_fare: `locked: ${LOCKED.needsNear}`,
      signature: 'available',
      postcard: 'available',
      layover: `locked: ${countdownText(120_000 + LAYOVER_MARGIN_MS - 20_000)}`,
    });
    // D807: the slot itself says what to do, with the faucet (one that takes implicit accounts) and Copy.
    expect(v.stamps[2]).toEqual({ id: 'own_fare', status: 'locked', reason: LOCKED.needsNear, detail: OWN_FARE_HELP.detail, href: 'https://docs.near.org/getting-started/faucet', hrefLabel: 'Get testnet NEAR ↗', copyAccount: true });
    expect(v.balanceLink).toEqual({ href: 'https://docs.near.org/getting-started/faucet', label: 'Get testnet NEAR ↗' });
    // The notice says it too, while nothing else is said; with another notice up, the slot still has it all.
    expect(v.notice).toEqual({ kind: 'info', text: FAUCET_NOTICE, href: 'https://docs.near.org/getting-started/faucet', hrefLabel: 'Get testnet NEAR' });
    const busy = buildView(input({ passport: held(['arrival']), notice: { kind: 'info', text: 'Layover stamped on NEAR testnet. You paid no gas.' } }), NOW);
    expect(busy.notice?.text).toBe('Layover stamped on NEAR testnet. You paid no gas.');
    expect(busy.stamps[2]).toMatchObject({ status: 'locked', href: 'https://docs.near.org/getting-started/faucet', copyAccount: true });
    // Without a faucet (a local stack): the steps and Copy, no link.
    const local = buildView(input({ passport: held(['arrival']), faucet: null }), NOW);
    expect(local.stamps[2]).toEqual({ id: 'own_fare', status: 'locked', reason: LOCKED.needsNear, detail: OWN_FARE_HELP.detail, copyAccount: true });
    expect(local.balanceLink).toBeUndefined();
    expect(buildView(input({ passport: held(['arrival', NOW - 20_000]), notice: { kind: 'info', text: 'Stamped.' } }), NOW).notice).toEqual({ kind: 'info', text: 'Stamped.' });
    expect(v.balanceNear).toBe('0');
  });

  it('Own fare opens from 0.01 NEAR on an activated account; Layover after 2 minutes and the margin', () => {
    const p = held(['arrival', NOW - 120_000 - LAYOVER_MARGIN_MS]);
    expect(statuses(buildView(input({ passport: p, balance: { yocto: 10n ** 22n, activated: true } }), NOW))).toMatchObject({ own_fare: 'available', layover: 'available' });
    expect(statuses(buildView(input({ passport: p, balance: { yocto: 10n ** 22n - 1n, activated: true } }), NOW)).own_fare).toBe(`locked: ${LOCKED.needsNear}`);
    expect(statuses(buildView(input({ passport: p, balance: { yocto: 10n ** 24n, activated: false } }), NOW)).own_fare).toBe(`locked: ${LOCKED.needsNear}`);
    expect(statuses(buildView(input({ passport: p, balance: null }), NOW)).own_fare).toBe(`locked: ${LOCKED.checkingBalance}`);
  });

  it('countdownText', () => {
    expect(countdownText(100_000)).toBe('In 1 min 40 s');
    expect(countdownText(45_000)).toBe('In 45 s');
    expect(countdownText(120_000)).toBe('In 2 min');
    expect(countdownText(1)).toBe('In 1 s');
  });

  it('layoverCounting only while the layover waits', () => {
    expect(layoverCounting(input({ passport: held(['arrival', NOW - 1000]) }), NOW)).toBe(true);
    expect(layoverCounting(input({ passport: held(['arrival', NOW - 1000], ['layover']) }), NOW)).toBe(false);
    expect(layoverCounting(input({ passport: held(['arrival', NOW - 200_000]) }), NOW)).toBe(false);
    expect(layoverCounting(input({ mode: 'public', passport: held(['arrival', NOW - 1000]) }), NOW)).toBe(false);
  });

  it('collected stamps: time, sponsored, note, the session’s transaction link or else the account’s, fresh once', () => {
    const local = new Map<StampId, ChainStamp>([['postcard', { stamp: 'postcard', atMs: NOW, sponsored: true, note: 'hi' }]]);
    const v = buildView(input({ passport: held(['arrival']), local, txs: new Map([['postcard', TX_HASH]]), fresh: new Set(['postcard']) }), NOW);
    expect(v.stamps[0]).toEqual({ id: 'arrival', status: 'collected', atMs: NOW - 600_000, sponsored: true, txUrl: `https://testnet.nearblocks.io/address/${NEAR_ACCOUNT}` });
    expect(v.stamps[4]).toEqual({ id: 'postcard', status: 'collected', atMs: NOW, sponsored: true, note: 'hi', txUrl: `https://testnet.nearblocks.io/txns/${TX_HASH}`, fresh: true });
  });

  it('working, sent (still confirming) and failed', () => {
    const p = held(['arrival']);
    const v = buildView(input({ passport: p, working: { id: 'sponsored', stage: 'Waiting…' }, sent: new Map([['postcard', TX_HASH]]), failed: new Map([['signature', 'Declined.']]), busy: true }), NOW);
    expect(v.stamps[1]).toEqual({ id: 'sponsored', status: 'working', stage: 'Waiting…' });
    expect(v.stamps[4]).toEqual({ id: 'postcard', status: 'working', stage: SENT_STAGE });
    expect(v.stamps[3]).toEqual({ id: 'signature', status: 'failed', message: 'Declined.' });
    expect(v.busy).toBe(true);
  });

  it('public: only what the chain holds, no collect, the share link and explorer, recent links to passports', () => {
    const v = buildView(input({ mode: 'public', passport: held(['arrival']), balance: null, recent: [{ accountId: 'alice.testnet', stamp: 'arrival', atMs: NOW }], totals: { passports: 2, stamps: 5 } }), NOW);
    expect(statuses(v)).toMatchObject({ arrival: 'collected', sponsored: `locked: ${LOCKED.notCollected}` });
    expect(v.shareUrl).toBe(`${ORIGIN}/p/${NEAR_ACCOUNT}`);
    expect(v.explorerUrl).toBe(`https://testnet.nearblocks.io/address/${NEAR_ACCOUNT}`);
    expect(v.recent).toEqual([{ accountId: 'alice.testnet', stamp: 'arrival', atMs: NOW, href: '/p/alice.testnet' }]);
    expect(v.totals).toEqual({ passports: 2, stamps: 5 });
    expect(v.balanceNear).toBeUndefined();
  });

  it('a named account can’t collect Signature', () => {
    expect(statuses(buildView(input({ accountId: 'alice.testnet', passport: { accountId: 'alice.testnet', stamps: [{ stamp: 'arrival', atMs: 1, sponsored: true }] } }), NOW)).signature).toBe(`locked: ${LOCKED.notImplicit}`);
  });
});

describe('an account id the site cannot route', () => {
  it('renders with an error notice and no share link instead of throwing (neither 64-hex nor .testnet)', () => {
    for (const mode of ['mine', 'public'] as const) {
      const v = buildView(input({ mode, accountId: 'bob.near', notice: { kind: 'info', text: 'hidden' } }), NOW);
      expect(v.notice).toEqual({ kind: 'error', text: UNVIEWABLE_NOTICE });
      expect(v.shareUrl).toBeUndefined();
      expect(v.accountId).toBe('bob.near');
    }
    // A recent entry the site can't link is left out, not thrown on.
    const r = buildView(input({ mode: 'cover', accountId: null, recent: [{ accountId: 'Bad Id', stamp: 'arrival', atMs: 1 }] }), NOW);
    expect(r.recent).toEqual([]);
  });
});
