// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://hana-id-demo-local.test/?gasFree=1&chainId=1&to=0x4444444444444444444444444444444444444444#card"}
// The gas-free check-in card (src/gas-free-card.ts, D867): when it exists at all, the one call it sends, its states and
// words, and every refusal in the SDK's own plain sentence. The URL above carries parameters a visitor could add: the
// card reads none of them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_CHECK_IN, DEMO_CHECK_IN_CALLDATA } from '@hana-id/core';
import { jargonIn } from '@hana-id/brand/plain-words';
import { HanaSponsorError, type SponsorshipStatus, userMessageFor } from '@hana-id/web';
import type { DemoConfig } from '../src/config.ts';
import { type DemoAction, plainMessage } from '../src/errors.ts';
import {
  CHECK_INS_SELECTOR,
  GAS_FREE_RECOUNT_MS,
  GAS_FREE_TEXT,
  RECHECK_MS,
  availabilityOf,
  checkInCall,
  checkInsCalldata,
  countText,
  gasFreeChain,
  parseCount,
  startGasFreeCard,
} from '../src/gas-free-card.ts';
import { CONFIG } from './fixtures.ts';

const CHAIN = 31337;
const PINNED = DEMO_CHECK_IN[CHAIN]!.address;
const EVM = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const HASH = `0x${'ab'.repeat(32)}`;
const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** The stack's configuration: the mocked chain, sponsored by the manifest's block, no explorer. */
const LOCAL: DemoConfig = { ...CONFIG, environment: 'local-e2e', evm: { id: CHAIN, name: 'Local test chain', rpcUrl: 'http://127.0.0.1:4460', explorer: null }, evmSponsor: { chainIds: [CHAIN] } };
const WITH_EXPLORER: DemoConfig = { ...LOCAL, evm: { ...LOCAL.evm, explorer: 'https://explorer.test' } };

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string): HTMLElement | null => document.getElementById(id);
const sponsorError = (code: ConstructorParameters<typeof HanaSponsorError>[0], data?: Record<string, unknown>) => new HanaSponsorError(code, 'developer text, never shown', data);

class FakeEvm {
  sponsoredChains: number[] = [CHAIN];
  status: SponsorshipStatus | Error = { available: true, remainingToday: '500000000000000000' };
  readonly sponsorship = vi.fn(async (_chainId: number): Promise<SponsorshipStatus> => {
    if (this.status instanceof Error) throw this.status;
    return this.status;
  });
  settle: { resolve: (v: { transactionHash: `0x${string}`; status: 'executed' }) => void; reject: (e: unknown) => void } | null = null;
  readonly sendSponsored = vi.fn(
    (_p: { chainId: number; calls: readonly { to: string; data: string }[] }) =>
      new Promise<{ transactionHash: `0x${string}`; status: 'executed' }>((resolve, reject) => {
        this.settle = { resolve, reject };
      }),
  );
}

let evm: FakeEvm;
let evmTouched: number;
let count: number;
let ethereum: { request: ReturnType<typeof vi.fn> };
let addresses: { evm: string } | null;
let errors: { action: DemoAction; box: string | undefined; e: unknown }[];
let pending: boolean;
let wall: number;
let card: ReturnType<typeof startGasFreeCard>;
/** This test's window and document events (a card of an earlier test never hears them). */
let win: EventTarget;
/** This test's timers (the card's delayed re-read of the count). */
let timers: { fn: () => void; ms: number }[];
const runTimers = () => {
  const due = timers.splice(0);
  for (const t of due) t.fn();
};
let doc: EventTarget & { visibilityState: DocumentVisibilityState };
const focusBack = () => win.dispatchEvent(new Event('focus'));

function boot(config: DemoConfig = LOCAL): void {
  const client = {
    get evm() {
      evmTouched += 1;
      return evm;
    },
    ethereum,
    get addresses() {
      return addresses as never;
    },
  };
  // The page's runner (page.ts run): one request at a time, the task called at once, its failure in `box`.
  const run = (action: DemoAction, task: () => Promise<void>, box?: string) => {
    if (pending) return;
    pending = true;
    card?.render(true, true);
    task()
      .catch((e: unknown) => {
        errors.push({ action, box, e });
        $(`${box}-text`)!.textContent = plainMessage(e, action);
        $(box!)!.hidden = false;
      })
      .finally(() => {
        pending = false;
        card?.render(addresses !== null, false);
      });
  };
  card = startGasFreeCard({ config, client: client as never, after: $('wallet')!, run, clock: () => wall, win: win as never, doc: doc as never, setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms }) });
}

async function signIn(config: DemoConfig = LOCAL): Promise<void> {
  boot(config);
  addresses = { evm: EVM };
  card!.render(true, false);
  await flush();
}

const button = () => $('gas-free-check-in') as HTMLButtonElement;
const visible = (id: string) => $(id) !== null && !$(id)!.hidden;

beforeEach(() => {
  document.body.innerHTML = '<main><section id="wallet"></section><section id="near"></section></main>';
  evm = new FakeEvm();
  evmTouched = 0;
  count = 0;
  ethereum = { request: vi.fn(async (_a: { method: string; params?: unknown }) => word(count)) };
  addresses = null;
  errors = [];
  pending = false;
  wall = Date.UTC(2026, 10, 18, 12);
  card = null;
  timers = [];
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
});

afterEach(() => vi.restoreAllMocks());

describe('the pure parts', () => {
  it('availabilityOf: available, a passing reason in the SDK’s words, or no card', () => {
    expect(availabilityOf({ available: true })).toEqual({ kind: 'ready' });
    for (const reason of ['budget_exhausted', 'app_budget_exhausted', 'paused', 'sponsorship_paused', 'not_available']) {
      expect(availabilityOf({ available: false, reason })).toEqual({ kind: 'unavailable', text: userMessageFor(4100, { reason }) });
    }
    expect(availabilityOf({ available: false, reason: 'budget_exhausted' })).toEqual({ kind: 'unavailable', text: 'Journear’s free network fees for this app are used up for today. Try again tomorrow.' });
    expect(availabilityOf({ available: false, reason: 'paused' })).toEqual({ kind: 'unavailable', text: 'Free network fees are paused right now. Try again later.' });
    for (const reason of ['chain_not_enabled', 'app_not_sponsored', 'something_new', undefined]) expect(availabilityOf({ available: false, ...(reason ? { reason } : {}) })).toEqual({ kind: 'absent' });
  });

  it('gasFreeChain: named by the manifest, sponsored by the build and pinned by Journear; the demo’s own chain first', () => {
    expect(gasFreeChain([CHAIN], [CHAIN], CHAIN)).toBe(CHAIN);
    expect(gasFreeChain([CHAIN], [], CHAIN)).toBeNull();
    expect(gasFreeChain([], [CHAIN], CHAIN)).toBeNull();
    // Base Sepolia is not pinned yet (its line comes with the deploy, D854): no card there until it is.
    expect(Object.hasOwn(DEMO_CHECK_IN, 84532)).toBe(false);
    expect(gasFreeChain([84532], [84532], 84532)).toBeNull();
    expect(gasFreeChain([84532, CHAIN], [84532, CHAIN], 84532)).toBe(CHAIN);
  });

  it('checkInCall: exactly the pinned check-in, nothing else, and only where it is pinned', () => {
    expect(checkInCall(CHAIN)).toEqual({ to: PINNED, data: DEMO_CHECK_IN_CALLDATA });
    expect(DEMO_CHECK_IN_CALLDATA).toBe('0x183ff085');
    expect(() => checkInCall(84532)).toThrow(/No demo check-in is pinned/u);
    expect(() => checkInCall(1)).toThrow(/No demo check-in is pinned/u);
  });

  it('reads the count with checkIns(address) and accepts only one plausible word', () => {
    expect(CHECK_INS_SELECTOR).toBe('0x1acc9b62');
    expect(checkInsCalldata(EVM)).toBe(`0x1acc9b62${'0'.repeat(24)}${EVM.slice(2).toLowerCase()}`);
    expect(() => checkInsCalldata('0x12')).toThrow();
    expect(parseCount(word(3))).toBe(3n);
    for (const bad of ['0x', '0x03', word(3) + '00', 42, null, `0x${'f'.repeat(64)}`]) expect(parseCount(bad), String(bad)).toBeNull();
    expect(countText(1n)).toBe('You’ve checked in once so far.');
    expect(countText(1234n)).toBe('You’ve checked in 1,234 times so far.');
  });

  it('every word is plain (D853) and names Journear, never Hana', () => {
    const texts = [...Object.values(GAS_FREE_TEXT), countText(1n), countText(2n)];
    for (const t of texts) {
      expect(jargonIn(t), t).toEqual([]);
      expect(t).not.toMatch(/\bHana\b|gas|relayer|sponsor|contract|chain/iu);
    }
    expect(GAS_FREE_TEXT.title).toBe('Try an action with no network fee');
    expect(GAS_FREE_TEXT.done).toBe('Done. You checked in. Journear paid the network fee, so it cost you nothing.');
    expect(GAS_FREE_TEXT.link).toBe('See it on the public record ↗');
    // The first check-in also does the one-time setup: the intro says so in the approval window's own words.
    expect(GAS_FREE_TEXT.intro).toBe('Check in to Journear’s demo. It counts your check-ins and doesn’t move any money. The first time, it also turns on free network fees for your account. You approve it in the Journear Passport window first. Journear pays the network fee, so it costs you nothing.');
    expect(GAS_FREE_TEXT.finishing).toBe('If you approved it, your check-in takes a few seconds. If not, go back to the Journear Passport window.');
  });

  it('reads nothing from the URL: no location, query or hash in its code', () => {
    const code = readFileSync(join(import.meta.dirname, '..', 'src', 'gas-free-card.ts'), 'utf8').replace(/\/\/.*$/gmu, '');
    expect(code).not.toMatch(/\blocation\b|URLSearchParams|searchParams|document\.URL|\bhistory\./u);
  });
});

describe('when the card exists', () => {
  it('without the manifest’s evm.sponsor block: nothing at all (no element, no hana.evm, no read)', async () => {
    const before = document.body.innerHTML;
    boot(CONFIG);
    expect(CONFIG.evmSponsor).toBeUndefined();
    expect(card).toBeNull();
    await flush();
    expect(document.body.innerHTML).toBe(before);
    expect(evmTouched).toBe(0);
    expect(ethereum.request).not.toHaveBeenCalled();
  });

  it('signed out: no card and no question', async () => {
    boot();
    card!.render(false, false);
    await flush();
    expect($('gas-free')).toBeNull();
    expect(evm.sponsorship).not.toHaveBeenCalled();
  });

  it('the app not sponsored, the chain not enabled, an unknown reason or no answer: no card (not a disabled one)', async () => {
    for (const status of [{ available: false, reason: 'app_not_sponsored' }, { available: false, reason: 'chain_not_enabled' }, { available: false, reason: 'later_reason' }, sponsorError('api_unavailable')] as const) {
      document.body.innerHTML = '<main><section id="wallet"></section></main>';
      evm = new FakeEvm();
      evm.status = status as never;
      await signIn();
      expect(evm.sponsorship).toHaveBeenCalledWith(CHAIN);
      expect($('gas-free'), JSON.stringify(status)).toBeNull();
    }
  });

  it('a chain the vault’s build doesn’t sponsor, or a manifest chain without Journear’s check-in: no card, no question', async () => {
    evm.sponsoredChains = [];
    await signIn();
    expect($('gas-free')).toBeNull();
    expect(evm.sponsorship).not.toHaveBeenCalled();
    document.body.innerHTML = '<main><section id="wallet"></section></main>';
    evm = new FakeEvm();
    evm.sponsoredChains = [84532];
    await signIn({ ...CONFIG, evmSponsor: { chainIds: [84532] } });
    expect($('gas-free')).toBeNull();
    expect(evm.sponsorship).not.toHaveBeenCalled();
  });

  it('allowed: the card after the addresses, its words, the button on, and the count when there is one', async () => {
    count = 2;
    await signIn();
    const section = $('gas-free')!;
    expect(section.previousElementSibling?.id).toBe('wallet');
    expect(section.querySelector('h2')!.textContent).toBe('Try an action with no network fee');
    expect($('gas-free-intro')!.textContent).toBe(GAS_FREE_TEXT.intro);
    expect(button().textContent).toBe('Check in');
    expect(button().disabled).toBe(false);
    expect(visible('gas-free-note')).toBe(false);
    expect(ethereum.request).toHaveBeenCalledWith({ method: 'eth_call', params: [{ to: PINNED, data: checkInsCalldata(EVM) }, 'latest'] });
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in 2 times so far.');
    for (const id of ['gas-free-stage', 'gas-free-done', 'gas-free-quiet']) expect(visible(id), id).toBe(false);
  });

  it('no count line before the first check-in, or when the read fails; no read on another chain than the demo’s', async () => {
    await signIn();
    expect(visible('gas-free-count')).toBe(false);
    document.body.innerHTML = '<main><section id="wallet"></section></main>';
    ethereum.request.mockRejectedValue(new Error('rpc down'));
    await signIn();
    expect(visible('gas-free')).toBe(true);
    expect(visible('gas-free-count')).toBe(false);
    document.body.innerHTML = '<main><section id="wallet"></section></main>';
    ethereum.request.mockClear();
    await signIn({ ...LOCAL, evm: { id: 84532, name: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' } });
    expect(visible('gas-free')).toBe(true);
    expect(ethereum.request).not.toHaveBeenCalled();
  });

  it('allowed but not right now (budget used up, paused, not for this account): the SDK’s sentence, the button off, asked again later', async () => {
    evm.status = { available: false, reason: 'paused' };
    await signIn();
    expect(visible('gas-free')).toBe(true);
    expect($('gas-free-note')!.className).toBe('jp-alert jp-alert-info');
    expect($('gas-free-note-text')!.textContent).toBe('Free network fees are paused right now. Try again later.');
    expect(button().disabled).toBe(true);
    button().click();
    expect(evm.sendSponsored).not.toHaveBeenCalled();
    // Back on the page within a minute: the answer stands. After it: asked again.
    evm.status = { available: true };
    focusBack();
    await flush();
    expect(evm.sponsorship).toHaveBeenCalledTimes(1);
    // The tab shown again counts as coming back too.
    wall += RECHECK_MS / 2;
    doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(evm.sponsorship).toHaveBeenCalledTimes(1);
    wall += RECHECK_MS / 2;
    doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(evm.sponsorship).toHaveBeenCalledTimes(2);
    expect(visible('gas-free-note')).toBe(false);
    expect(button().disabled).toBe(false);
  });
});

describe('Check in', () => {
  it('sends exactly the pinned check-in, in the click; approving, then finishing, then done with the count', async () => {
    count = 4;
    await signIn(WITH_EXPLORER);
    button().click();
    // Synchronously in the click: the approval window opens in it.
    expect(evm.sendSponsored).toHaveBeenCalledTimes(1);
    expect(evm.sendSponsored).toHaveBeenCalledWith({ chainId: CHAIN, calls: [{ to: PINNED, data: '0x183ff085' }] });
    expect($('gas-free-stage')!.textContent).toBe('Approve the check-in in the Journear Passport window.');
    expect(button().disabled).toBe(true);
    // A second click while it runs does nothing.
    button().click();
    expect(evm.sendSponsored).toHaveBeenCalledTimes(1);
    // The user comes back to the page.
    focusBack();
    expect($('gas-free-stage')!.textContent).toBe('If you approved it, your check-in takes a few seconds. If not, go back to the Journear Passport window.');
    count = 5;
    evm.settle!.resolve({ transactionHash: HASH as `0x${string}`, status: 'executed' });
    await flush();
    expect(visible('gas-free-stage')).toBe(false);
    expect(visible('gas-free-done')).toBe(true);
    expect($('gas-free-done-text')!.textContent).toBe('Done. You checked in. Journear paid the network fee, so it cost you nothing.');
    const link = $('gas-free-link') as HTMLAnchorElement;
    expect(link.hidden).toBe(false);
    expect(link.textContent).toBe('See it on the public record ↗');
    expect(link.href).toBe(`https://explorer.test/tx/${HASH}`);
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.target).toBe('_blank');
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in 5 times so far.');
    expect(button().disabled).toBe(false);
    expect(errors).toEqual([]);
  });

  it('the count after Done: read at once, again after a short delay and on the next return, never lower than before', async () => {
    count = 4;
    await signIn();
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in 4 times so far.');
    button().click();
    // The node behind the page hasn't seen the check-in yet: it still says 4, then (wrongly) 3.
    count = 3;
    evm.settle!.resolve({ transactionHash: HASH as `0x${string}`, status: 'executed' });
    await flush();
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in 4 times so far.');
    expect(timers.map((t) => t.ms)).toEqual([GAS_FREE_RECOUNT_MS]);
    const reads = ethereum.request.mock.calls.length;
    count = 5;
    runTimers();
    await flush();
    expect(ethereum.request.mock.calls.length).toBe(reads + 1);
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in 5 times so far.');
    // The next return to the page reads it once more (within the minute: no new sponsorship question).
    count = 6;
    focusBack();
    await flush();
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in 6 times so far.');
    expect(evm.sponsorship).toHaveBeenCalledTimes(2);
    // Only once: a later return within the minute reads nothing.
    focusBack();
    await flush();
    expect(ethereum.request.mock.calls.length).toBe(reads + 2);
  });

  it('a delayed re-read for an account that has since changed is dropped', async () => {
    count = 1;
    await signIn();
    button().click();
    evm.settle!.resolve({ transactionHash: HASH as `0x${string}`, status: 'executed' });
    await flush();
    addresses = { evm: OTHER };
    card!.render(true, false);
    await flush();
    // The new account's own read (its own call data).
    expect(ethereum.request.mock.calls.at(-1)![0]).toEqual({ method: 'eth_call', params: [{ to: PINNED, data: checkInsCalldata(OTHER) }, 'latest'] });
    const reads = ethereum.request.mock.calls.length;
    count = 9;
    runTimers();
    await flush();
    expect(ethereum.request.mock.calls.length).toBe(reads);
    expect($('gas-free-count')!.textContent).toBe('You’ve checked in once so far.');
  });

  it('no link without an explorer (the local stack)', async () => {
    await signIn();
    button().click();
    evm.settle!.resolve({ transactionHash: HASH as `0x${string}`, status: 'executed' });
    await flush();
    expect(visible('gas-free-done')).toBe(true);
    expect(visible('gas-free-link')).toBe(false);
    expect($('gas-free-link')!.hasAttribute('href')).toBe(false);
  });

  it('a rejection in the window is quiet: the SDK’s sentence as a plain line, no error, ready again', async () => {
    await signIn();
    button().click();
    evm.settle!.reject(sponsorError(4001));
    await flush();
    expect(visible('gas-free-quiet')).toBe(true);
    expect($('gas-free-quiet')!.textContent).toBe('You rejected this in Journear Passport, or closed it. Nothing was approved.');
    expect($('gas-free-quiet')!.className).toBe('card-hint');
    expect(errors).toEqual([]);
    expect(visible('gas-free-error')).toBe(false);
    expect(button().disabled).toBe(false);
  });

  const REFUSALS: [string, HanaSponsorError, string][] = [
    ['budget used up today', sponsorError(4100, { reason: 'budget_exhausted' }), 'Journear’s free network fees for this app are used up for today. Try again tomorrow.'],
    ['the app’s budget, at send', sponsorError('rate_limited', { reason: 'app_budget_exhausted', retryAfterS: 3600 }), 'Journear’s free network fees for this app are used up for today. Try again tomorrow.'],
    ['paused (prepare)', sponsorError(4100, { reason: 'paused' }), 'Free network fees are paused right now. Try again later.'],
    ['paused (send)', sponsorError('api_unavailable', { status: 503, reason: 'sponsorship_paused' }), 'Free network fees are paused right now. Try again later.'],
    ['not available for this account', sponsorError(4100, { reason: 'not_available' }), 'Free network fees aren’t available for your account right now. Try again later.'],
    ['busy', sponsorError('busy', { reason: 'sponsor_in_flight' }), 'Your last action is still going through. Wait for it to finish, then try again.'],
    ['outcome unknown', sponsorError('api_unavailable', { reason: 'unknown_outcome' }), 'Journear couldn’t tell whether your action went through. Check before you try again.'],
    ['set up by another wallet app', sponsorError(4100, { reason: 'delegated_elsewhere' }), 'Your account was set up by another wallet app, so Journear can’t pay network fees for it. Nothing was sent.'],
  ];

  for (const [what, e, text] of REFUSALS) {
    it(`a refusal (${what}): the SDK’s own sentence in the card’s red box`, async () => {
      await signIn();
      button().click();
      evm.settle!.reject(e);
      await flush();
      expect(e.userMessage).toBe(text);
      expect(errors).toEqual([{ action: 'gasFree', box: 'gas-free-error', e }]);
      expect(visible('gas-free-error')).toBe(true);
      expect($('gas-free-error-text')!.textContent).toBe(text);
      expect(visible('gas-free-done')).toBe(false);
      expect(visible('gas-free-error-link')).toBe(false);
      // Asked again, so a budget used up meanwhile shows before the next click.
      expect(evm.sponsorship).toHaveBeenCalledTimes(2);
    });
  }

  it('a send that may still land (timeout with its transaction): the SDK’s sentence and the link to look it up', async () => {
    await signIn(WITH_EXPLORER);
    button().click();
    evm.settle!.reject(sponsorError('api_unavailable', { reason: 'timeout', transactionHash: HASH }));
    await flush();
    expect($('gas-free-error-text')!.textContent).toBe('Your action was sent but isn’t confirmed yet. Check again in a minute before you try again.');
    expect(($('gas-free-error-link') as HTMLAnchorElement).href).toBe(`https://explorer.test/tx/${HASH}`);
  });

  it('an error without a userMessage still gets the SDK’s sentence for its code and reason', async () => {
    await signIn();
    button().click();
    evm.settle!.reject(Object.assign(new Error('x'), { code: 4100, data: { reason: 'budget_exhausted' } }));
    await flush();
    expect($('gas-free-error-text')!.textContent).toBe('Journear’s free network fees for this app are used up for today. Try again tomorrow.');
  });

  it('another account, or signing out, starts over; signed out the card is hidden', async () => {
    await signIn();
    button().click();
    evm.settle!.resolve({ transactionHash: HASH as `0x${string}`, status: 'executed' });
    await flush();
    expect(visible('gas-free-done')).toBe(true);
    addresses = { evm: OTHER };
    card!.render(true, false);
    await flush();
    expect(visible('gas-free-done')).toBe(false);
    expect(evm.sponsorship).toHaveBeenCalledTimes(3);
    addresses = null;
    card!.render(false, false);
    expect($('gas-free')!.hidden).toBe(true);
  });
});
