// The gas-free check-in card (D867): one button, "Check in", that runs Journear's demo check-in (`checkIn()` on the
// pinned CheckIn program, contracts/evm-delegate, D854) with the network fee paid by Journear, through the SDK's
// `hana.evm.sendSponsored` (D838, D855), the way docs/integration.md "Gas-free actions" tells partners to do it.
//
// When it appears (and otherwise it doesn't exist at all: not disabled, not "coming soon"):
// 1. the env's manifest has an `evm.sponsor` block (config.ts `evmSponsor`, baked in at build time). Without it
//    startGasFreeCard returns null at once: no element, no listener, no call to `hana.evm`, so the page of an env
//    without sponsorship (sandbox-dev today) is exactly what it was before the card;
// 2. a chain of that block is one the vault's build sponsors (`hana.evm.sponsoredChains`) AND Journear has pinned its
//    demo check-in there (@hana-id/core `DEMO_CHECK_IN`): the chain and the program's address come from those two,
//    never from the page, the URL or an API answer;
// 3. signed in, `hana.evm.sponsorship(chain)` says this app is sponsored there: available, or not available today for
//    a reason that passes (the day's budget used up, paused, not available for this account), shown in the SDK's own
//    words with the button off. Any other answer (the chain or the app not sponsored, an unknown reason, no answer)
//    leaves the card out.
//
// What it sends: exactly one call, `{ to: DEMO_CHECK_IN[chain].address, data: '0x183ff085' }`, checked with
// `isDemoCheckInCall` before every send. Nothing a user types, no URL parameter and no API answer reaches it.
// Every refusal is shown in the SDK's own plain sentence (`userMessage`, D861); a rejection in the window is quiet.
// The user's check-in count is read from the program (`checkIns(address)`, a free read through the page's own EVM
// provider) only when the sponsored chain is the demo's configured chain, whose RPC the page's CSP already allows.
import { DEMO_CHECK_IN, DEMO_CHECK_IN_CALLDATA, isDemoCheckInCall } from '@hana-id/core';
import { type SponsorshipStatus, userMessageFor } from '@hana-id/web';
import type { DemoConfig } from './config.ts';
import { type DemoAction, sdkUserMessage } from './errors.ts';
import type { DemoClient } from './page.ts';
import { icon } from './toast.ts';

/** Every word the card shows (D853: plain words; the refusals are the SDK's own). */
export const GAS_FREE_TEXT = Object.freeze({
  title: 'Try an action with no network fee',
  // The first check-in also does the account's one-time setup: said as the approval window's setup note says it.
  intro:
    'Check in to Journear’s demo. It counts your check-ins and doesn’t move any money. The first time, it also turns on free network fees for your account. You approve it in the Journear Passport window first. Journear pays the network fee, so it costs you nothing.',
  button: 'Check in',
  approving: 'Approve the check-in in the Journear Passport window.',
  // Shown once the user is back on the page, approved or not (the SDK reports no approval): true either way.
  finishing: 'If you approved it, your check-in takes a few seconds. If not, go back to the Journear Passport window.',
  done: 'Done. You checked in. Journear paid the network fee, so it cost you nothing.',
  link: 'See it on the public record ↗',
});

/** "You’ve checked in once so far." / "… 3 times so far." */
export const countText = (n: bigint): string => (n === 1n ? 'You’ve checked in once so far.' : `You’ve checked in ${n.toLocaleString('en-US')} times so far.`);

/** `checkIns(address)`'s selector (the public counter of contracts/evm-delegate/src/demo/CheckIn.sol). */
export const CHECK_INS_SELECTOR = '0x1acc9b62';

/**
 * After Done, the count is read once more this long after (and on the next return to the page): the page's RPC node
 * may not have seen the block of the check-in yet.
 */
export const GAS_FREE_RECOUNT_MS = 4_000;

/** How long a sponsorship answer is trusted before the card asks again (on focus). */
export const RECHECK_MS = 60_000;

/** The reasons `sponsorship()` gives for an app that is sponsored but can't be right now: the card shows them. */
const PASSING_REASONS: ReadonlySet<string> = new Set(['budget_exhausted', 'app_budget_exhausted', 'paused', 'sponsorship_paused', 'not_available']);

export type Availability = { kind: 'absent' } | { kind: 'ready' } | { kind: 'unavailable'; text: string };

/** What a `sponsorship()` answer means for the card. */
export function availabilityOf(s: SponsorshipStatus): Availability {
  if (s.available === true) return { kind: 'ready' };
  const reason = typeof s.reason === 'string' ? s.reason : '';
  // The SDK's sentence for that reason (the same one a refused send would carry).
  return PASSING_REASONS.has(reason) ? { kind: 'unavailable', text: userMessageFor(4100, { reason }) } : { kind: 'absent' };
}

/**
 * The chain the card runs on: one the manifest's block names, the vault's build sponsors and Journear's check-in is
 * pinned on; the demo's own EVM chain first (its RPC gives the count, its explorer the link). Null: no card.
 */
export function gasFreeChain(manifestChains: readonly number[], sponsored: readonly number[], configured: number): number | null {
  const ok = manifestChains.filter((id) => Number.isSafeInteger(id) && sponsored.includes(id) && Object.hasOwn(DEMO_CHECK_IN, id));
  return ok.includes(configured) ? configured : (ok[0] ?? null);
}

/** The one call the card sends: Journear's pinned check-in on `chainId`, exactly. Throws for any other chain. */
export function checkInCall(chainId: number): { to: string; data: string } {
  const pinned = Object.hasOwn(DEMO_CHECK_IN, chainId) ? DEMO_CHECK_IN[chainId] : undefined;
  if (!pinned) throw new Error(`No demo check-in is pinned on chain ${chainId}`);
  const call = { to: pinned.address, data: DEMO_CHECK_IN_CALLDATA };
  if (!isDemoCheckInCall(chainId, call.to, call.data, 0n)) throw new Error('Not the pinned check-in');
  return call;
}

/** `checkIns(account)`'s call data. */
export function checkInsCalldata(account: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(account)) throw new Error('Not an EVM address');
  return `${CHECK_INS_SELECTOR}${account.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** A `checkIns` answer (one 32-byte word), or null for anything else or an implausible count. */
export function parseCount(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(v)) return null;
  const n = BigInt(v);
  return n <= 1_000_000_000n ? n : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A refusal's transaction (the SDK's `data.transactionHash`, a `timeout` or a failed send), only in its exact shape. */
export function refusalTransaction(e: unknown): string | null {
  const h = isObj(e) && isObj(e.data) ? e.data.transactionHash : undefined;
  return typeof h === 'string' && /^0x[0-9a-f]{64}$/u.test(h) ? h : null;
}

export interface GasFreeCardDeps {
  config: DemoConfig;
  client: Pick<DemoClient, 'evm' | 'ethereum' | 'addresses'>;
  /** The card goes right after this element (the addresses card). */
  after: HTMLElement;
  /** The page's one-request-at-a-time runner (synchronous up to the task's first await); errors go to `box`. */
  run: (action: DemoAction, task: () => Promise<void>, box?: string) => void;
  /** Wall-clock ms. */
  clock: () => number;
  /** Where focus and visibility come from (window and document by default). */
  win?: Pick<Window, 'addEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'visibilityState'>;
  /** The delayed re-read's timer (setTimeout by default). */
  setTimeout?: (fn: () => void, ms: number) => void;
}

export interface GasFreeCard {
  /** Shows, hides or updates the card for the session's EVM account; `pending`: a request is running. */
  render(loggedIn: boolean, pending: boolean): void;
}

type Phase = 'idle' | 'approving' | 'finishing';
type Outcome = { kind: 'done'; hash: string } | { kind: 'error'; hash: string | null } | { kind: 'quiet'; text: string } | null;

function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** The card, or null when the env's manifest has no `evm.sponsor` block (then nothing at all is added to the page). */
export function startGasFreeCard(deps: GasFreeCardDeps): GasFreeCard | null {
  const { config, client: c, clock } = deps;
  if (config.evmSponsor === undefined) return null;
  const manifestChains: readonly number[] = config.evmSponsor.chainIds;
  const win = deps.win ?? window;
  const doc = deps.doc ?? document;
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));

  let account: string | null = null;
  let chainId: number | null = null;
  let availability: Availability | null = null;
  let checkedAt = -Infinity;
  let checking: { account: string | null; promise: Promise<void> } | null = null;
  let phase: Phase = 'idle';
  let outcome: Outcome = null;
  /** The account's check-ins: only ever raised (a node behind the last one may answer less). */
  let count: bigint | null = null;
  /** Read the count again on the next return to the page (set by a Done). */
  let recountOnReturn = false;
  let loggedIn = false;
  let pending = false;
  let card: HTMLElement | null = null;

  const explorerFor = (id: number): string | null => (id === config.evm.id ? config.evm.explorer : null);

  // ---- the element, built the first time it is shown ----

  function build(): HTMLElement {
    const button = h('button', { id: 'gas-free-check-in', type: 'button', class: 'jp-btn jp-btn-primary' }, icon('i-bolt'), GAS_FREE_TEXT.button);
    button.addEventListener('click', checkIn);
    const link = (id: string) => h('a', { id, target: '_blank', rel: 'noopener noreferrer', hidden: '' }, GAS_FREE_TEXT.link);
    const section = h(
      'section',
      { id: 'gas-free', class: 'jp-card gas-free', 'aria-labelledby': 'h-gas-free' },
      h('h2', { id: 'h-gas-free' }, GAS_FREE_TEXT.title),
      h('p', { class: 'card-hint', id: 'gas-free-intro' }, GAS_FREE_TEXT.intro),
      h('div', { id: 'gas-free-note', class: 'jp-alert jp-alert-info', role: 'status', 'aria-live': 'polite', hidden: '' }, icon('i-info'), h('div', { class: 'body', id: 'gas-free-note-text' })),
      h('div', { class: 'row' }, button),
      h('p', { id: 'gas-free-stage', class: 'stage', role: 'status', 'aria-live': 'polite', hidden: '' }),
      h('div', { id: 'gas-free-error', class: 'jp-alert jp-alert-danger', role: 'alert', hidden: '' }, icon('i-x-c'), h('div', { class: 'body' }, h('span', { id: 'gas-free-error-text' }), ' ', link('gas-free-error-link'))),
      h('p', { id: 'gas-free-quiet', class: 'card-hint', role: 'status', hidden: '' }),
      h('div', { id: 'gas-free-done', class: 'jp-alert jp-alert-success', role: 'status', hidden: '' }, icon('i-check-c'), h('div', { class: 'body' }, h('span', { id: 'gas-free-done-text' }, GAS_FREE_TEXT.done), ' ', link('gas-free-link'))),
      h('p', { id: 'gas-free-count', class: 'card-hint', hidden: '' }),
    );
    deps.after.after(section);
    return section;
  }

  const part = <T extends HTMLElement = HTMLElement>(id: string): T => card!.querySelector(`#${id}`) as T;

  function setLink(a: HTMLAnchorElement, hash: string | null): void {
    const explorer = chainId === null ? null : explorerFor(chainId);
    a.hidden = hash === null || explorer === null;
    if (hash !== null && explorer !== null) a.href = `${explorer}/tx/${encodeURIComponent(hash)}`;
    else a.removeAttribute('href');
  }

  function draw(): void {
    const av = availability;
    if (!loggedIn || account === null || chainId === null || av === null || av.kind === 'absent') {
      if (card) card.hidden = true;
      return;
    }
    card ??= build();
    card.hidden = false;
    const note = av.kind === 'unavailable' ? av.text : null;
    part('gas-free-note').hidden = note === null;
    part('gas-free-note-text').textContent = note ?? '';
    part<HTMLButtonElement>('gas-free-check-in').disabled = pending || phase !== 'idle' || av.kind !== 'ready';
    const stage = part('gas-free-stage');
    stage.hidden = phase === 'idle';
    stage.textContent = phase === 'approving' ? GAS_FREE_TEXT.approving : phase === 'finishing' ? GAS_FREE_TEXT.finishing : '';
    part('gas-free-done').hidden = outcome?.kind !== 'done';
    setLink(part<HTMLAnchorElement>('gas-free-link'), outcome?.kind === 'done' ? outcome.hash : null);
    setLink(part<HTMLAnchorElement>('gas-free-error-link'), outcome?.kind === 'error' ? outcome.hash : null);
    const quiet = part('gas-free-quiet');
    quiet.hidden = outcome?.kind !== 'quiet';
    quiet.textContent = outcome?.kind === 'quiet' ? outcome.text : '';
    const n = part('gas-free-count');
    n.hidden = count === null || count === 0n;
    n.textContent = count !== null && count > 0n ? countText(count) : '';
  }

  // ---- reads ----

  /** Asks `sponsorship()` for the chain (one question at a time); a failed answer keeps what was known, or no card. */
  function check(): Promise<void> {
    if (checking && checking.account === account) return checking.promise;
    const forAccount = account;
    const p = (async () => {
      const chain = gasFreeChain(manifestChains, c.evm.sponsoredChains, config.evm.id);
      if (chain === null) {
        availability = { kind: 'absent' };
        return;
      }
      let s: SponsorshipStatus;
      try {
        s = await c.evm.sponsorship(chain);
      } catch {
        if (account === forAccount) availability ??= { kind: 'absent' };
        return;
      }
      if (account !== forAccount) return;
      checkedAt = clock();
      chainId = chain;
      availability = availabilityOf(s);
      if (availability.kind !== 'absent') void readCount();
    })().finally(() => {
      if (checking?.promise === p) checking = null;
      draw();
    });
    checking = { account: forAccount, promise: p };
    return p;
  }

  async function readCount(): Promise<void> {
    const forAccount = account;
    if (forAccount === null || chainId === null || chainId !== config.evm.id) return;
    const pinned = DEMO_CHECK_IN[chainId];
    if (!pinned) return;
    try {
      const v = await c.ethereum.request({ method: 'eth_call', params: [{ to: pinned.address, data: checkInsCalldata(forAccount) }, 'latest'] });
      if (account !== forAccount) return;
      const n = parseCount(v);
      if (n !== null && (count === null || n > count)) count = n;
      draw();
    } catch {
      // The count is a nice-to-have: without it the card says nothing about it.
    }
  }

  // ---- the action ----

  /** The click: synchronous up to sendSponsored, so Journear Passport's window opens in it (D99). */
  function checkIn(): void {
    if (pending || phase !== 'idle' || availability?.kind !== 'ready' || chainId === null || account === null) return;
    const chain = chainId;
    const call = checkInCall(chain);
    deps.run(
      'gasFree',
      async () => {
        phase = 'approving';
        outcome = null;
        draw();
        try {
          const r = await c.evm.sendSponsored({ chainId: chain, calls: [call] });
          outcome = { kind: 'done', hash: r.transactionHash };
          // The count once more after a moment, and on the next return, for the account it was for.
          recountOnReturn = true;
          const forAccount = account;
          later(() => {
            if (account === forAccount) void readCount();
          }, GAS_FREE_RECOUNT_MS);
        } catch (e) {
          // A rejection in the window is the user's choice: said quietly, not as an error.
          if (isObj(e) && e.code === 4001) {
            outcome = { kind: 'quiet', text: sdkUserMessage(e) };
            return;
          }
          outcome = { kind: 'error', hash: refusalTransaction(e) };
          throw e;
        } finally {
          phase = 'idle';
          draw();
          // The count after a check-in (or a send whose outcome isn't known), and whether the next one is still free.
          void readCount();
          if (outcome?.kind !== 'quiet') void check();
        }
      },
      'gas-free-error',
    );
  }

  /** The user came back to the page: the window was approved (or not yet); and an old answer is asked again. */
  function back(): void {
    if (phase === 'approving') {
      phase = 'finishing';
      draw();
      return;
    }
    if (phase !== 'idle' || !loggedIn || account === null || pending) return;
    if (recountOnReturn) {
      recountOnReturn = false;
      void readCount();
    }
    if (clock() - checkedAt >= RECHECK_MS) void check();
  }
  win.addEventListener('focus', back);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') back();
  });

  return {
    render(isLoggedIn: boolean, isPending: boolean): void {
      loggedIn = isLoggedIn;
      pending = isPending;
      const a = isLoggedIn ? (c.addresses?.evm ?? null) : null;
      if (a !== account) {
        // Another account (or none): nothing known about it yet.
        account = a;
        chainId = null;
        availability = null;
        checkedAt = -Infinity;
        phase = 'idle';
        outcome = null;
        count = null;
        recountOnReturn = false;
        if (a !== null) void check();
      }
      draw();
    },
  };
}
