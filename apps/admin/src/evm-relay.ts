// "Gas sponsorship" (D843, named so for staff by D879): EVM gas sponsorship's relayer (D851) for staff, in plain words. The System status tile
// (status.ts builds it from `explainChain`), the detail page's answer (`GET /api/evm-relay/:chain`) and the staff tools
// (`POST /api/evm-relay/:chain/act`). The words are written for a founder or a support person who is not an engineer
// (D853): what is wrong in one sentence, what to do as numbered steps, and the technical code only as "code for
// engineers". docs/operations.md "The relayer: what it does, when it stops, what to do" has the same table.
//
// The tools: the request is checked here with the API's own schema (console-core `evmRelayActInput`), then recorded in
// the audit log (StaffRpc.recordStaffAction `evm_relay.staff_action`: the tool, the chain, the slot, the note; no row,
// no action), then sent to AdminRpc.evmRelayAct (which acts only while the relayer still shows what the page showed,
// and the relayer's own checks are final), and its answer recorded (`evm_relay.staff_result`). Nothing here retries a
// refused or failed call. Every value from the API is shown as text (plainString); links are built here, only to the
// chain's block explorer, only for well-formed hashes and addresses.
import { type EvmRelayActInput, type EvmRelayChainView, type EvmRelayDetail, type EvmRelayHalt, type EvmRelayRecordView, type EvmRelayTool, evmRelayActInput, isLeakHalt, needsKeyConfirmation } from '@hana-id/console-core';
import { errorResponse, json } from './http.ts';
import { errorName, log } from './log.ts';
import { plainString } from './plain.ts';
import type { RouteCtx } from './routes.ts';
import { staffCtx } from './rpc.ts';

// ---- chains, amounts, addresses ----

interface ChainInfo {
  /** For a sentence: "Base Sepolia". */
  name: string;
  /** Where test ETH comes from, for a step. */
  faucet: string;
  explorer: { name: string; tx: string; address: string } | null;
}
/** The chains sponsorship may run on (core's TEST_EVM_CHAINS and EVM_EXPLORERS, for the two the manifest allows). */
export const EVM_RELAY_CHAINS: Readonly<Record<number, ChainInfo>> = Object.freeze({
  84532: { name: 'Base Sepolia', faucet: 'a Base Sepolia faucet (docs.base.org, “Network faucets”)', explorer: { name: 'Basescan', tx: 'https://sepolia.basescan.org/tx/', address: 'https://sepolia.basescan.org/address/' } },
  31337: { name: 'the local test network', faucet: 'the local node’s funded test account', explorer: null },
});
export const chainInfo = (id: number): ChainInfo => (Object.hasOwn(EVM_RELAY_CHAINS, id) ? EVM_RELAY_CHAINS[id]! : { name: `test network ${id}`, faucet: 'a faucet for that test network', explorer: null });
/** The tile's and the page's title: "Gas sponsorship (Base Sepolia)" (D879: staff say "gas sponsorship"; users keep "free network fees"). */
export const evmRelayTitle = (id: number): string => `Gas sponsorship (${chainInfo(id).name.replace(/^the /u, '')})`;
export const evmRelayPath = (id: number): string => `/gas-sponsorship/${id}`;

const WEI = /^\d{1,78}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const ETH = 10n ** 18n;
export const wei = (v: unknown): bigint | null => (typeof v === 'string' && WEI.test(v) ? BigInt(v) : null);

/** "0.0812 test ETH": 4 decimals, rounded down; a non-zero amount below 0.0001 shows up to 8. */
export function testEth(w: bigint): string {
  const whole = w / ETH;
  const frac = (w % ETH).toString().padStart(18, '0');
  let shown = frac.slice(0, 4).replace(/0+$/u, '');
  if (whole === 0n && !shown && w > 0n) shown = frac.slice(0, 8).replace(/0+$/u, '') || '00000001';
  return `${whole}${shown ? `.${shown}` : ''} test ETH`;
}
/** "0x12ab…cd34": the short form for a sentence (D859); the whole address stays in its own row. */
export const shortAddress = (a: string): string => (ADDRESS.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : plainString(a, 64));

const MIN = 60_000;
export const ageText = (ms: number): string => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : ms < 48 * 60 * MIN ? `${Math.round(ms / (60 * MIN))} h` : `${Math.round(ms / (24 * 60 * MIN))} days`);
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const code = (v: unknown): string => (typeof v === 'string' && /^[a-z_]{1,48}$/u.test(v) ? v : 'unknown');

// ---- why it stopped, and what to do ----

export interface Explained {
  /** One plain sentence (or two): what is wrong. */
  why: string;
  /** What to do, in order. */
  steps: string[];
}

interface Words {
  chain: string;
  faucet: string;
  /** The chain's block explorer by name ("Basescan"), or null when it has none (the local chain): no step names one then. */
  explorer: string | null;
  /** "0.07 test ETH": enough for the low line and a day's budget. */
  refill: string;
}

/**
 * The steps of every halt that means the relayer's key may be used by someone else (console-core `isLeakHalt`): the
 * engineer first, the slot tool (if any) is the engineer's after that, and Resume only when the engineer says so.
 * Never a refill: money sent to a leaked key can be taken.
 */
const leakSteps = (engineerSlotStep: string | null): string[] => [
  'Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.',
  'The engineer follows “A relayer key leaked” in docs/operations.md: gas sponsorship is switched off, the money left in the wallet is moved out, and the key is replaced.',
  ...(engineerSlotStep ? [`After that, the engineer ${engineerSlotStep}`] : []),
  'Don’t press Resume until the engineer says the key is safe or replaced. Resume then asks you to confirm that.',
];

/** A halt as the words need it: `leakSeen` (the relayer's mark) is optional for a refusal's bare reason. */
type HaltWords = Pick<EvmRelayHalt, 'reason' | 'slot' | 'code'> & { leakSeen?: boolean };

/**
 * The halt table of docs/operations.md, in plain words, per reason (and for `relayer_cannot_send`, per code). A pause
 * that isn't a leak type by its reason but where the relayer has since seen a sign of one (`leakSeen`), or where the
 * network counts more of the wallet's transactions than the relayer sent (`chainAhead`, the detail page's read), takes
 * the leak steps instead (D843 re-check M): the engineer first, never a refill.
 */
export function haltExplained(h: HaltWords, w: Words, o: { chainAhead?: boolean } = {}): Explained {
  const base = haltReasonExplained(h, w);
  if (isLeakHalt(h) || !(h.leakSeen || o.chainAhead)) return base;
  const seen = o.chainAhead
    ? 'The network also shows more transactions from the relayer wallet than the relayer sent: someone else may be using its key.'
    : 'Since it stopped, the relayer has seen something that may mean someone else is using its key (or a slot was changed by hand on this page).';
  return { why: `${base.why} ${seen}`, steps: leakSteps(engineerWalletCheck(w)) };
}

function haltReasonExplained(h: HaltWords, w: Words): Explained {
  const n = h.slot === null ? 'the slot shown below' : `slot ${h.slot}`;
  switch (h.reason) {
    case 'relayer_cannot_send':
      if (h.code === 'insufficient_funds')
        return {
          why: 'The relayer’s wallet can’t send transactions: it is out of money.',
          steps: [`${w.explorer ? `Open the relayer wallet on ${w.explorer} (its address is below).` : 'Check the relayer wallet’s recent transactions (ask an engineer if you can’t).'} If money went out in transfers nobody at Journear made, stop: tell an engineer now and don’t send money.`, 'Check the wallet’s balance below.', `Send at least ${w.refill} to the relayer wallet (its address is below) from ${w.faucet}.`, 'When the balance below shows the new amount, press Resume on the Gas sponsorship page.', 'If it pauses again for the same reason, it still needs more money: send more, then press Resume again.'],
        };
      if (h.code === 'fee_cap_too_low')
        return {
          why: 'Gas prices are higher right now than the relayer is allowed to pay, so it can’t even send its own cancel.',
          steps: ['Wait: gas prices usually fall again within an hour.', 'Then press Resume on the Gas sponsorship page.', 'If it is still paused after a few hours, ask an engineer to raise the relayer’s gas price limit (maxFeePerGasGwei in the settings).'],
        };
      if (h.code === 'replacement_underpriced' || h.code === 'sender_restricted') return { why: `Another transaction is using the relayer wallet’s ${n}: the relayer’s key is being used somewhere else.`, steps: leakSteps(null) };
      if (h.code === 'nonce_too_low' || h.code === 'nonce_too_high')
        return { why: 'The relayer’s slot numbers don’t match the network’s: someone else may be using its key.', steps: leakSteps(engineerWalletCheck(w)) };
      return { why: 'The network refused a transaction the relayer built. This is probably a bug.', steps: ['Ask an engineer to look.', 'Don’t use the tools on the Gas sponsorship page meanwhile.'] };
    case 'nonce_consumed_elsewhere':
      return {
        why: `${cap(n)} was used up on the network by a transaction the relayer didn’t send: someone else used the relayer’s key.`,
        steps: leakSteps(`closes ${n} as “used by something else” on the Gas sponsorship page (under Advanced).`),
      };
    case 'nonce_gap':
      return {
        why: `${cap(n)} is empty and nothing is waiting to fill it, so every transaction after it is stuck. Only someone else using the relayer’s key leaves a gap like this.`,
        steps: leakSteps('uses “Fill a gap” (under Advanced) for each empty slot, lowest first; the box above updates after each.'),
      };
    case 'foreign_transactions':
      return {
        why: 'The network shows more transactions from the relayer’s wallet than the relayer sent: someone else is using its key.',
        steps: leakSteps('waits until nothing is waiting, then uses “Set the next slot number” (under Advanced) with the number the network gives, shown there.'),
      };
    case 'stuck_past_deadline':
      return {
        why: `${cap(n)} still isn’t on the network 30 minutes after the user’s time limit, although its cancel keeps being sent.`,
        steps: [
          'Check the wallet’s balance below. If it is low, send test ETH to the relayer wallet.',
          `If the balance is fine, press Cancel on ${n} to send a cancel with a higher fee.`,
          'If Cancel is refused because gas prices are above the relayer’s gas price limit, ask an engineer to raise that limit.',
          `If ${n} has no Cancel button, it already has 8 copies and the relayer can’t send another: ask an engineer.`,
          'Once the slot shows as on the network, press Resume.',
        ],
      };
    case 'key_mismatch':
      return { why: 'The relayer’s key changed while transactions signed with the old key were still waiting. It signs nothing new.', steps: ['Ask an engineer to put the old key back until nothing is waiting.', 'Then the engineer changes the key.', 'Then press Resume.'] };
    case 'storage_inconsistent':
      return { why: 'The relayer’s own records disagree with each other. This is a bug.', steps: ['Ask an engineer.', 'Don’t use any of the tools on the Gas sponsorship page.'] };
    default:
      return { why: 'The relayer stopped for a reason this page doesn’t know yet.', steps: ['Ask an engineer.', 'This console and the API may be on different versions: deploy both from the same checkout.'] };
  }
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** The engineer's look at the wallet: on the chain's block explorer, or (none, the local chain: D873) its recent transactions. */
const engineerWalletCheck = (w: Words): string =>
  w.explorer ? `checks the relayer wallet on ${w.explorer} for transactions nobody at Journear sent.` : 'checks the relayer wallet’s recent transactions for any nobody at Journear sent.';

/** The code for engineers: the reason, the code, the slot, and the relayer's leak mark or the network's count ahead. */
export const haltCode = (h: HaltWords, o: { chainAhead?: boolean } = {}): string =>
  [code(h.reason), h.code ? code(h.code) : null, h.slot !== null ? `slot ${h.slot}` : null, h.leakSeen ? 'leak_seen' : null, o.chainAhead ? 'chain_ahead' : null].filter(Boolean).join(' · ');

/** The network counts more of the relayer wallet's transactions than the relayer sent (the detail page's read only). */
export function chainAhead(v: EvmRelayChainView, chainCount: EvmRelayDetail['chainCount'] | undefined): boolean {
  const r = v.relayer.ok ? v.relayer : null;
  return !!(r && chainCount?.ok && r.nextSlot !== null && Math.max(chainCount.latest, chainCount.pending) > r.nextSlot);
}

// ---- one chain, as the tile and the page header show it ----

export type PlainState = 'working' | 'paused' | 'low' | 'not_set_up' | 'needs_person' | 'unknown';
export const STATE_LABELS: Readonly<Record<PlainState, string>> = Object.freeze({
  working: 'Working',
  paused: 'Paused: needs a person',
  low: 'Low on money',
  not_set_up: 'Not set up',
  needs_person: 'Needs a person',
  unknown: 'Can’t check right now',
});
export type Severity = 'ok' | 'warning' | 'critical' | 'unknown' | 'not_measured';
/** A part's state in plain words, where it isn't fine (the same words on the detail page). */
export const LINE_LABELS: Readonly<Record<string, string>> = Object.freeze({ warning: 'Needs a look', critical: 'Problem', unknown: 'Can’t check' });

export interface PlainLine {
  label: string;
  state: Severity;
  detail: string;
}
/** A problem besides the main one (a budget nearly used, a low balance while paused): its own issue on the status page. */
export interface ExtraProblem {
  key: string;
  severity: 'warning' | 'critical';
  title: string;
  steps: string[];
  playbook: string;
}
export interface ChainPlain {
  chainId: number;
  title: string;
  state: PlainState;
  label: string;
  severity: Severity;
  /** One line under the title: since when, or what was seen. */
  detail: string;
  explained: Explained | null;
  /** The code for engineers (a small detail), or null. */
  code: string | null;
  /** The playbook that covers the main problem. */
  playbook: string | null;
  since: number | null;
  lines: PlainLine[];
  extra: ExtraProblem[];
  /** The relayer wallet on the block explorer (null without one). */
  walletUrl: string | null;
}

/** At this share of today's budget an amber issue (the API's alert uses the same share). */
export const BUDGET_WARN_PCT = 80;
/** Waiting longer than this is amber: the API's `evm_relay_stuck` alert fires when the oldest unmined or untaken one passes it. */
export const WAITING_WARN_MS = 2 * MIN;
const pct = (part: bigint, whole: bigint): number => (whole > 0n ? Number((part * 1000n) / whole) / 10 : 0);

/** The tile's words for one chain's view: its plain state, why and what to do, and a line per part. */
export function explainChain(v: EvmRelayChainView, now: number, chainCount?: EvmRelayDetail['chainCount']): ChainPlain {
  const info = chainInfo(v.chainId);
  const low = wei(v.lowBalanceWei) ?? 0n;
  const budget = wei(v.dailyBudgetWei) ?? 0n;
  const oneSend = wei(v.oneSendWorstWei) ?? 0n;
  const w: Words = { chain: info.name, faucet: info.faucet, explorer: info.explorer?.name ?? null, refill: testEth(low + budget) };
  const address = ADDRESS.test(v.relayerAddress) ? v.relayerAddress : plainString(v.relayerAddress, 64);
  const walletUrl = info.explorer && ADDRESS.test(v.relayerAddress) ? `${info.explorer.address}${v.relayerAddress}` : null;
  const lines: PlainLine[] = [];
  const extra: ExtraProblem[] = [];
  const out = (state: PlainState, severity: Severity, detail: string, explained: Explained | null, c: string | null, playbook: string | null, since: number | null = null): ChainPlain => ({
    chainId: v.chainId,
    title: evmRelayTitle(v.chainId),
    state,
    label: STATE_LABELS[state],
    severity,
    detail,
    explained,
    code: c,
    playbook,
    since,
    lines,
    extra,
    walletUrl,
  });

  // The wallet and its balance.
  const balance = v.balance.ok ? wei(v.balance.wei) : null;
  const balanceState: Severity = balance === null ? 'unknown' : balance < oneSend ? 'critical' : balance < low ? 'warning' : 'ok';
  lines.push({ label: 'Relayer wallet', state: 'ok', detail: address });
  lines.push({ label: 'Money in the wallet', state: balanceState, detail: balance === null ? `Can’t check right now (${v.balance.ok ? 'unreadable' : code(v.balance.code)})` : `${testEth(balance)} · low below ${testEth(low)}` });

  // Today's spend: the handlers' own count on the env's day budget (the one the budget alert and the refusals use).
  const spent = v.budget?.ok ? wei(v.budget.spentWei) : null;
  if (spent === null) lines.push({ label: 'Spent today', state: 'unknown', detail: `Can’t check right now (${v.budget && !v.budget.ok ? code(v.budget.code) : 'unreadable'})` });
  else {
    const share = pct(spent, budget);
    const spentState: Severity = spent >= budget ? 'critical' : share >= BUDGET_WARN_PCT ? 'warning' : 'ok';
    lines.push({ label: 'Spent today', state: spentState, detail: `${testEth(spent)} of the ${testEth(budget)} daily budget (${share}%), counting the most each waiting one can cost` });
    if (spentState !== 'ok')
      extra.push({
        key: 'budget',
        severity: spentState === 'critical' ? 'critical' : 'warning',
        title: spentState === 'critical' ? `Gas sponsorship has used up today’s budget (${testEth(spent)}): new requests are turned away until 00:00 UTC` : `Gas sponsorship has used ${share}% of today’s budget (${testEth(spent)} of ${testEth(budget)})`,
        steps: ['If this is real use (a demo, a busy day), it is fine: the budget starts again at 00:00 UTC.', 'If you can’t explain it, follow the playbook to find which app is using it.'],
        playbook: 'evm-relay-budget-high',
      });
  }

  // The relayer object.
  const r = v.relayer.ok ? v.relayer : null;
  if (r) {
    const waitingState: Severity = Math.max(r.oldestWaitingMs ?? 0, r.oldestNotTakenMs ?? 0) > WAITING_WARN_MS ? 'warning' : 'ok';
    const waiting = r.waiting === 0 ? 'None' : `${r.waiting} · the oldest for ${ageText(r.oldestWaitingMs ?? 0)}${r.oldestNotTakenMs !== null ? ` · not yet picked up by the network: the oldest for ${ageText(r.oldestNotTakenMs)}` : ''}`;
    lines.push({ label: 'Waiting to go through', state: waitingState, detail: `${waiting}${r.awaitingConfirmation ? ` · ${r.awaitingConfirmation} on the network, being confirmed` : ''}` });
    if (r.unconfirmedRefusals) {
      const u = r.unconfirmedRefusals;
      lines.push({ label: 'Send problems a backup server reported', state: 'warning', detail: `${u.count} (the last ${ageText(Math.max(0, now - u.lastAt))} ago). These don’t pause it. If the number keeps rising, ask an engineer.` });
    }
  } else {
    lines.push({ label: 'The relayer', state: 'unknown', detail: `Can’t check right now (${v.relayer.ok ? 'unknown' : code(v.relayer.code)})` });
  }

  // The account helper program: the pinned delegate's code on the chain.
  const h = v.helper;
  const helperState: Severity = !h.ok ? 'unknown' : h.matches ? 'ok' : 'critical';
  lines.push({ label: 'Account helper program', state: helperState, detail: !h.ok ? `Can’t check right now (${code(h.code)})` : h.matches ? 'The checked version' : h.codeHash === null ? 'Not on the network' : 'Not the checked version' });

  // The latest staff action.
  const last = r?.staffLog[0];
  if (last) lines.push({ label: 'Last staff action', state: last.done ? 'ok' : 'warning', detail: `${TOOL_NAMES[last.tool] ?? 'A tool'} by ${plainString(last.who, 128)}, ${ageText(Math.max(0, now - last.at))} ago: ${last.done ? 'done' : `refused (${code(last.refused)})`}` });

  // The main state, most urgent first.
  if (r?.halted) {
    const ahead = chainAhead(v, chainCount);
    const leak = needsKeyConfirmation(r.halted) || ahead;
    let e = haltExplained(r.halted, w, { chainAhead: ahead });
    // A key replaced since the stop: the records' signer is no longer the settings' wallet (the relayer tells us so).
    if (leak && ADDRESS.test(r.signerAddress) && r.signerAddress.toLowerCase() !== v.relayerAddress.toLowerCase())
      e = { ...e, why: `${e.why} The relayer’s key has been replaced since it stopped (its transactions were signed by ${shortAddress(r.signerAddress)}; the settings now name the wallet below).` };
    // Never a refill while the key may be someone else's: money sent to it can be taken.
    if (!leak && (balanceState === 'critical' || balanceState === 'warning')) extra.push(lowProblem(balance!, low, w, balanceState));
    return out('paused', 'critical', `Paused since ${utc(r.halted.since)} (${ageText(Math.max(0, now - r.halted.since))}). Gas sponsorship is stopped for everyone until a person fixes it. Nothing is lost.`, e, haltCode(r.halted, { chainAhead: ahead }), 'evm-relay-paused', r.halted.since);
  }
  if (v.key === 'wrong')
    return out('not_set_up', 'critical', 'The relayer sends nothing new.', { why: 'The relayer’s key doesn’t belong to the relayer wallet named in the settings, so it sends nothing new.', steps: ['Ask an engineer: the key file or relayerAddress in the settings is wrong.', 'Don’t change keys while transactions are waiting.'] }, 'key_wrong', 'evm-relay-paused');
  if (v.key === 'missing')
    return out(
      'not_set_up',
      'warning',
      'Switched off: the relayer’s key isn’t loaded.',
      { why: 'The relayer’s key isn’t loaded, so gas sponsorship is off for everyone. Removing the key is also how it is switched off on purpose.', steps: ['If someone switched gas sponsorship off on purpose, leave it.', 'If not, ask an engineer to upload the relayer key again (docs/operations.md “EVM sponsorship relay”, step 9).'] },
      'key_missing',
      'evm-relay-paused',
    );
  if (v.readEndpoint === 'missing')
    return out(
      'not_set_up',
      'warning',
      'Off: the relayer’s read endpoint isn’t set.',
      {
        why: `The relayer’s own read endpoint for ${info.name} isn’t set, so gas sponsorship is off here. The public endpoint isn’t trusted for this outside local test setups.`,
        steps: [
          `Get the https address of a ${info.name} endpoint from a provider account (Alchemy, QuickNode, Infura or similar).`,
          `Ask an engineer to upload it as the API’s secret EVM_SPONSOR_RPC_${v.chainId} (docs/operations.md “EVM sponsorship relay”, step 9). It is never shown anywhere.`,
          'Press Check again: the tile says “Working” once it is in.',
        ],
      },
      'read_endpoint_missing',
      'evm-relay-paused',
    );
  if (h.ok && !h.matches)
    return out(
      'needs_person',
      'critical',
      h.codeHash === null ? 'The account helper program isn’t on the network.' : 'The account helper program on the network isn’t the checked version.',
      { why: h.codeHash === null ? `The account helper program isn’t on ${info.name}, so gas sponsorship can’t work.` : `The program at the account helper’s address on ${info.name} isn’t the version Journear checked.`, steps: ['Ask an engineer now.', 'The engineer switches gas sponsorship off until it is explained (docs/operations.md “EVM sponsorship relay”, the off switch).'] },
      h.codeHash === null ? 'helper_missing' : 'helper_mismatch',
      null,
    );
  if (balanceState === 'critical' || balanceState === 'warning') {
    const p = lowProblem(balance!, low, w, balanceState);
    return out('low', balanceState, `${testEth(balance!)} left in the relayer wallet.`, { why: p.title, steps: p.steps }, null, 'evm-relay-balance-low');
  }
  if (!r || balanceState === 'unknown' || helperState === 'unknown') {
    const what = !r ? 'the relayer' : balanceState === 'unknown' ? 'the wallet’s balance' : 'the account helper program';
    return out('unknown', 'unknown', `Can’t check ${what} right now.`, { why: `This page couldn’t read ${what} just now. That alone doesn’t stop gas sponsorship.`, steps: ['Press Check again in a minute.', 'If it stays like this for more than an hour, ask an engineer to look at the network provider.'] }, !r ? (v.relayer.ok ? null : code(v.relayer.code)) : null, null);
  }
  return out('working', 'ok', r.started ? `Sending normally · the next transaction gets slot ${r.nextSlot ?? '?'}` : 'Ready · nothing sent yet', null, null, null);
}

function lowProblem(balance: bigint, low: bigint, w: Words, s: Severity): ExtraProblem {
  return {
    key: 'low',
    severity: s === 'critical' ? 'critical' : 'warning',
    title: s === 'critical' ? `The relayer’s wallet has almost no money left (${testEth(balance)}): it can’t pay for another transaction.` : `The relayer’s wallet is running low (${testEth(balance)}). When it runs out, gas sponsorship pauses.`,
    steps: [`Send at least ${w.refill} to the relayer wallet (its address is below) from ${w.faucet}.`, `Aim to keep it above ${testEth(low)}.`],
    playbook: 'evm-relay-balance-low',
  };
}

// ---- the detail page: the records and the tools ----

export const TOOL_NAMES: Readonly<Record<EvmRelayTool, string>> = Object.freeze({ resume: 'Resume', cancel: 'Cancel this slot', close: 'Close as “used by something else”', fill: 'Fill a gap', adopt_nonce: 'Set the next slot number' });

/** What closing a slot does to the books (the founder's decision D869: the partner is not charged for a slot lost to Journear's own key). */
export const CLOSE_BILLING = 'The user’s action in it is marked as not done. The app is not charged: Journear covers it.';

export interface RecordPlain {
  slot: number;
  kind: 'action' | 'filler';
  app: string;
  sentAt: number;
  deadlineAt: number;
  stateText: string;
  state: 'on_chain' | 'cancelling' | 'not_taken' | 'sent' | 'refused' | 'used_elsewhere';
  refusedCode: string | null;
  copies: { hash: string; kind: 'action' | 'cancel'; url: string | null }[];
  canCancel: boolean;
  /** Why there is no Cancel button on a slot not yet on the network, in words; null otherwise. */
  noCancelBecause: string | null;
  canClose: boolean;
}

/**
 * One transaction in words. The app from the sponsorship's own records. Cancel only once its time limit has passed (or
 * during a `stuck_past_deadline` pause: the API refuses it otherwise, `not_past_deadline`), never on a slot already on
 * the network, past 8 copies or without the key. The slot of a `nonce_consumed_elsewhere` pause (`haltSlot`) is used on
 * the network by a transaction the relayer didn't send: none of its own can go through and Cancel can't take it (the
 * relayer would refuse, `nonce_mined`), so it says so and offers no Cancel; Close is its tool (D873's finding: it read
 * "Sent, waiting to go through" with "Cancel shows once its time limit has passed").
 */
export function recordPlain(r: EvmRelayRecordView, chainId: number, keyOk: boolean, apps: EvmRelayDetail['apps'], now: number, haltReason: string | null, haltSlot: number | null = null): RecordPlain {
  const ex = chainInfo(chainId).explorer;
  const usedElsewhere = !r.onChain && haltReason === 'nonce_consumed_elsewhere' && haltSlot === r.slot;
  const state: RecordPlain['state'] = r.onChain ? 'on_chain' : usedElsewhere ? 'used_elsewhere' : r.cancelling ? 'cancelling' : r.refusedCode ? 'refused' : r.taken ? 'sent' : 'not_taken';
  const STATE: Record<RecordPlain['state'], string> = {
    used_elsewhere: 'Used by a transaction Journear didn’t send: it won’t go through',
    on_chain: 'On the network, being confirmed',
    cancelling: r.kind === 'filler' ? 'Being sent (a harmless empty transfer)' : 'Being cancelled: the user’s action won’t happen',
    refused: 'Turned away by the network',
    sent: 'Sent, waiting to go through',
    not_taken: 'Not yet picked up by the network',
  };
  const past = r.deadlineAt <= now || haltReason === 'stuck_past_deadline';
  const noCancelBecause = r.onChain ? null : usedElsewhere ? 'No Cancel: the network shows this slot already used. Close it instead (under Advanced), once the engineer says so.' : r.copies.length >= 8 ? 'No Cancel: it already has 8 copies, the most the relayer sends. Ask an engineer.' : !keyOk ? 'No Cancel: the relayer’s key isn’t loaded.' : !past ? 'Cancel shows once its time limit has passed.' : null;
  return {
    slot: r.slot,
    kind: r.kind,
    app: r.kind === 'filler' ? 'Staff gap filler' : r.app ? plainString(r.app.name ?? r.app.id, 128) : apps === 'recorded' ? 'Unknown app' : 'Can’t check right now',
    sentAt: r.sentAt,
    deadlineAt: r.deadlineAt,
    state,
    stateText: STATE[state],
    refusedCode: r.refusedCode ? code(r.refusedCode) : null,
    copies: r.copies.slice(0, 8).map((c) => ({ hash: HASH.test(c.hash) ? c.hash.toLowerCase() : 'unknown', kind: c.kind === 'cancel' ? 'cancel' : 'action', url: ex && HASH.test(c.hash) ? `${ex.tx}${c.hash.toLowerCase()}` : null })),
    canCancel: !r.onChain && noCancelBecause === null,
    noCancelBecause,
    canClose: !r.onChain,
  };
}

export interface ToolsOffered {
  resume: boolean;
  /** The pause means the key may be someone else's: Resume isn't the primary action and needs the engineer's confirmation. */
  resumeNeedsKeyConfirmation: boolean;
  /** "Fill a gap": the slot to suggest (the halt's), the highest allowed; null when it can't apply. */
  fill: { suggested: number | null; max: number } | null;
  /**
   * "Set the next slot number": the network's own next slot for the wallet (its count, as the relayer reads it) to
   * pre-fill, the lowest allowed; null when it can't apply, with why in `adoptBecause`.
   */
  adopt: { suggested: number | null; min: number } | null;
  adoptBecause: string | null;
  /** The reason every tool is hidden, in words, or null. */
  noneBecause: string | null;
}

/** Which tools may apply now (never one the relayer would certainly refuse: it still checks every one). */
export function toolsOffered(v: EvmRelayChainView, records: EvmRelayRecordView[], chainCount: EvmRelayDetail['chainCount']): ToolsOffered {
  const none = (why: string): ToolsOffered => ({ resume: false, resumeNeedsKeyConfirmation: false, fill: null, adopt: null, adoptBecause: null, noneBecause: why });
  if (!v.relayer.ok) return none('The relayer can’t be read right now, so no tool is offered. Reload the page in a minute.');
  const r = v.relayer;
  if (!r.started) return none('The relayer hasn’t sent anything yet, so there is nothing to fix.');
  if (r.halted?.reason === 'storage_inconsistent') return none('The relayer’s records disagree with each other (a bug): ask an engineer, and don’t use the tools.');
  const keyOk = v.key === 'ok';
  const unmined = records.some((x) => !x.onChain);
  const min = r.nextSlot ?? 0;
  let adopt: ToolsOffered['adopt'] = null;
  let adoptBecause: string | null = null;
  if (unmined || r.waiting > 0) adoptBecause = 'Not possible now: wait until nothing is waiting.';
  else if (!chainCount.ok) adoptBecause = 'The network’s count for the relayer wallet can’t be read right now: ask an engineer.';
  else if (chainCount.latest !== chainCount.pending) adoptBecause = 'The network still has transactions from the relayer wallet waiting: wait until they are on the network, then reload.';
  else if (chainCount.latest < min) adoptBecause = `The network’s count (${chainCount.latest}) is below the relayer’s next slot (${min}): nothing to set. Ask an engineer.`;
  else adopt = { suggested: chainCount.latest, min };
  return {
    resume: r.halted !== null,
    resumeNeedsKeyConfirmation: r.halted !== null && (needsKeyConfirmation(r.halted) || chainAhead(v, chainCount)),
    fill: keyOk && r.nextSlot !== null && r.nextSlot > 0 ? { suggested: r.halted?.reason === 'nonce_gap' ? r.halted.slot : null, max: r.nextSlot - 1 } : null,
    adopt,
    adoptBecause,
    noneBecause: null,
  };
}

// ---- a tool's answer in words ----

const HALT_CODES = ['nonce_consumed_elsewhere', 'nonce_gap', 'foreign_transactions', 'relayer_cannot_send', 'stuck_past_deadline', 'key_mismatch', 'storage_inconsistent'];

/** What the relayer's (or the API's) refusal means, in words. Nothing was changed by a refusal. */
export function refusalWords(refused: string, slot: number | null, w: Words): string {
  const n = slot === null ? 'that slot' : `slot ${slot}`;
  if (refused === 'relayer_cannot_send') return 'The problem is still there: the relayer’s wallet still can’t send transactions.';
  if (HALT_CODES.includes(refused)) return `The problem is still there: ${lowerFirst(haltExplained({ reason: refused, slot, code: null }, w).why)}`;
  const WORDS: Record<string, string> = {
    not_halted: 'It wasn’t paused, so there was nothing to resume.',
    incomplete_check: 'It couldn’t finish checking the network this time. Try again in a minute.',
    rpc_unavailable: 'It couldn’t reach the network to check. Try again in a minute.',
    no_record: `There is no waiting transaction in ${n}.`,
    nonce_not_consumed_at_confirmed_depth: `The network doesn’t show ${n} as used yet, or not for long enough. Wait a few minutes and try again.`,
    receipt_found: `${cap(n)}’s own transaction did reach the network. There is nothing to do: it finishes by itself.`,
    key_mismatch: 'The relayer’s key doesn’t match the one these transactions were signed with, so it can’t sign anything.',
    nonce_mined: `${cap(n)} is already used on the network. Wait: it finishes by itself.`,
    no_valid_replacement: 'It can’t send another copy: it has already sent 8, or its gas price limit leaves no room for a higher fee. Ask an engineer.',
    fee_cap_too_low: 'Gas prices are above the relayer’s gas price limit right now. Try again later, or ask an engineer to raise that limit.',
    record_exists: `${cap(n)} already has a transaction. Use Cancel on that slot instead.`,
    not_below_next_nonce: `${cap(n)} isn’t one of the relayer’s earlier slots, so there is no gap there.`,
    not_the_chains_next_nonce: `The network’s next slot for the relayer isn’t ${slot ?? 'that number'}. Fill the lowest empty slot first.`,
    below_next_nonce: `The relayer already counts past ${slot ?? 'that number'}. The number can only go up.`,
    unmined_records: 'Transactions are still waiting. Wait until none are waiting, then try again.',
    chain_count_differs: `The network’s own count for the relayer wallet isn’t ${slot ?? 'that number'}. Reload the page: it shows the network’s number.`,
    no_state: 'The relayer hasn’t sent anything yet, so there is nothing to do.',
    not_past_deadline: `${cap(n)}’s time limit hasn’t passed yet: it may still go through. Cancel is for a slot past its time limit.`,
    key_confirmation_required: 'During this pause the relayer saw signs that its key may be used by someone else. Resume needs you to confirm that an engineer said the key is safe or replaced.',
    invalid_request: 'The relayer refused the request as malformed. Reload the page and try again.',
    relayer_unbound: 'This API has no relayer for this network. Ask an engineer.',
    relayer_unavailable: 'The relayer didn’t answer. Try again in a minute.',
    relayer_timeout: 'The relayer took too long to answer. Try again in a minute.',
    internal: 'Something went wrong inside the relayer. Ask an engineer.',
  };
  return WORDS[refused] ?? 'The relayer said no for a reason this page doesn’t know yet. Ask an engineer.';
}
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** What a done tool did. */
export function doneWords(tool: EvmRelayTool, slot: number | null): string {
  const n = slot === null ? 'the slot' : `slot ${slot}`;
  switch (tool) {
    case 'resume':
      return 'Gas sponsorship is running again.';
    case 'cancel':
      return `A cancel for ${n} was sent. The user’s action in that slot won’t happen. Whichever copy the network takes first ends the slot.`;
    case 'close':
      return `${cap(n)} is closed as used by something else. ${CLOSE_BILLING}`;
    case 'fill':
      return `A harmless empty transfer was sent for ${n}. Once it is on the network, fill the next empty slot if there is one, then press Resume when the engineer says so.`;
    case 'adopt_nonce':
      return `The relayer’s next slot is now ${slot ?? 'the number you gave'}. Press Resume when the engineer says so.`;
  }
}

export interface ActWords {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  text: string;
  /** What to do now, when the relayer is (still) paused: its latest condition's steps (L3). */
  steps: string[];
  code: string | null;
}

/** A tool's answer in words. After a refusal, the relayer's latest condition (`halt`, from its answer) says why and what to do. */
export function actWords(tool: EvmRelayTool, slot: number | null, result: { done: boolean; refused: string | null }, chainId: number, halt: HaltWords | null = null, refill = 'the amount the box above names'): ActWords {
  const info = chainInfo(chainId);
  const w: Words = { chain: info.name, faucet: info.faucet, explorer: info.explorer?.name ?? null, refill };
  if (result.done) return { tone: 'ok', title: `${TOOL_NAMES[tool]}: done`, text: doneWords(tool, slot), steps: [], code: null };
  if (result.refused === 'unknown')
    return { tone: 'error', title: `${TOOL_NAMES[tool]}: no clear answer`, text: 'The relayer didn’t answer clearly, so we can’t tell whether it did it. Look at “Recent staff actions” below before you try again.', steps: [], code: 'unknown' };
  const refused = code(result.refused);
  // A refused Resume names the condition that holds now, which may not be the first one (L3).
  if (halt && HALT_CODES.includes(refused)) {
    const e = haltExplained(halt, w);
    return { tone: 'warn', title: `${TOOL_NAMES[tool]}: the relayer said no. Nothing was changed.`, text: `The problem is still there: ${lowerFirst(e.why)}`, steps: e.steps, code: haltCode(halt) };
  }
  return { tone: 'warn', title: `${TOOL_NAMES[tool]}: the relayer said no. Nothing was changed.`, text: refusalWords(refused, slot, w), steps: [], code: refused };
}

// ---- the routes ----

const CHAIN_PARAM = /^[1-9]\d{0,15}$/u;
const chainOf = (c: RouteCtx): number | null => (CHAIN_PARAM.test(c.params.chain ?? '') && Number.isSafeInteger(Number(c.params.chain)) ? Number(c.params.chain) : null);
/** The one-time token a detail page carries for one tool use: the audit rows' request id, so a re-submitted form is `already_applied`. */
const TOKEN = /^evmact_[A-Za-z0-9_-]{22}$/u;
const newActToken = (): string => `evmact_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
/** An RPC method the other Worker doesn't have yet (it is older than this one). */
const missingMethod = (err: unknown): boolean => /does not implement|is not a function|not a function|no such method|does not exist/iu.test(err instanceof Error ? err.message : String(err));
export const API_OUTDATED = 'This page is newer than the API: deploy the API first (then this admin console). Nothing was done.';
export const CONSOLE_OUTDATED = 'This page is newer than the partner console’s Worker, which keeps the audit log: deploy it first. Nothing was done.';

/** `GET /api/evm-relay/:chain`: the detail page (the API's view, in words, with the tools that may apply and a one-time token for a tool). */
export async function evmRelayDetailRoute(c: RouteCtx): Promise<Response> {
  const route = 'GET /api/evm-relay/:chain';
  const chainId = chainOf(c);
  if (chainId === null) return errorResponse('not_found');
  let r: Awaited<ReturnType<RouteCtx['env']['API']['evmRelayDetail']>>;
  try {
    r = await c.env.API.evmRelayDetail({ ...staffCtx(c.staff), chainId });
  } catch (err) {
    if (missingMethod(err)) return errorResponse('api_outdated', API_OUTDATED);
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable');
  }
  if (!r.ok) {
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
    return errorResponse(r.code as Parameters<typeof errorResponse>[0], r.error);
  }
  const d = r.detail;
  const now = Date.now();
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', count: d.records.length });
  const relayer = d.chain.relayer.ok ? d.chain.relayer : null;
  const haltReason = relayer?.halted?.reason ?? null;
  const haltSlot = relayer?.halted?.slot ?? null;
  return json(200, {
    chainId,
    title: evmRelayTitle(chainId),
    chainName: chainInfo(chainId).name,
    plain: explainChain(d.chain, now, d.chainCount),
    readAt: d.chain.readAt,
    relayerAddress: d.chain.relayerAddress,
    nextSlot: relayer?.nextSlot ?? null,
    seen: { haltSince: relayer?.halted?.since ?? null, lastStaffSeq: relayer?.lastStaffSeq ?? 0 },
    token: newActToken(),
    apps: d.apps,
    records: d.records.map((x) => recordPlain(x, chainId, d.chain.key === 'ok', d.apps, now, haltReason, haltSlot)),
    tools: toolsOffered(d.chain, d.records, d.chainCount),
    closeBilling: CLOSE_BILLING,
    staffLog: (relayer?.staffLog ?? []).map((e) => ({ seq: e.seq, at: e.at, who: plainString(e.who, 128), tool: TOOL_NAMES[e.tool] ?? 'A tool', slot: e.slot, note: plainString(e.note, 500), done: e.done, refused: e.refused ? code(e.refused) : null })),
  });
}

/**
 * `POST /api/evm-relay/:chain/act` `{token, tool, slot?, note, seen, keyConfirmed?}`: one staff tool. Checked here with
 * the API's schema; then the API's capability (an older API: nothing done, no audit row); then the audit row, keyed by
 * the page's one-time token (no row, no action; a re-submitted form is `already_applied`); then the API; then the
 * result's row. The answer: the result and its words.
 */
export async function evmRelayActRoute(c: RouteCtx): Promise<Response> {
  const route = 'POST /api/evm-relay/:chain/act';
  const chainId = chainOf(c);
  if (chainId === null) return errorResponse('not_found');
  const b = c.body;
  if (Object.keys(b).some((k) => !['token', 'tool', 'slot', 'note', 'seen', 'keyConfirmed'].includes(k))) return errorResponse('bad_request', 'body: only token, tool, slot, note, seen and keyConfirmed');
  if (typeof b.token !== 'string' || !TOKEN.test(b.token)) return errorResponse('bad_request', 'token: the page’s one-time token (reload the page)');
  // The token is this tool use's request id: the audit rows' idempotency key and the API call's id.
  const ctx = { ...staffCtx(c.staff), requestId: b.token };
  const parsed = evmRelayActInput.safeParse({ ...ctx, chainId, tool: b.tool, ...(b.slot !== undefined ? { slot: b.slot } : {}), note: b.note, seen: b.seen, ...(b.keyConfirmed !== undefined ? { keyConfirmed: b.keyConfirmed } : {}) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResponse('bad_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  const input: EvmRelayActInput = parsed.data;
  const slot = input.slot ?? null;
  const target = String(chainId);

  // 0. The API must have the tool (an older API: nothing done, nothing recorded).
  try {
    const v = await c.env.API.evmRelayVersion({ ...staffCtx(c.staff) });
    if (!v.ok) return errorResponse(v.code as Parameters<typeof errorResponse>[0], v.error);
  } catch (err) {
    if (missingMethod(err)) return errorResponse('api_outdated', API_OUTDATED);
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable', 'The API didn’t answer. Nothing was done.');
  }

  // 1. The audit row first: no row, no action.
  try {
    const a = await c.env.CONSOLE.recordStaffAction({ ...ctx, action: 'evm_relay.staff_action', target, details: { tool: input.tool, chainId, slot, note: input.note, ...(input.keyConfirmed ? { keyConfirmed: true } : {}) } });
    if (!a.ok) {
      log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: a.code }, 'error');
      if (a.code === 'already_applied') return errorResponse('already_applied', 'This form was already sent once. Reload the page to see what happened, then act again if it is still needed.');
      if (a.code === 'bad_request') return errorResponse('console_outdated', CONSOLE_OUTDATED);
      return errorResponse('internal', 'The action could not be recorded, so nothing was done');
    }
  } catch (err) {
    if (missingMethod(err)) return errorResponse('console_outdated', CONSOLE_OUTDATED);
    log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable', 'The action could not be recorded, so nothing was done');
  }

  // 2. The tool. A failed call is not retried: whether it acted is in the relayer's own log.
  let outcome: string;
  let res: Response;
  try {
    const r = await c.env.API.evmRelayAct(input);
    if (!r.ok) {
      outcome = r.code === 'version_conflict' ? 'stale_page' : `rpc_${r.code}`;
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
      res = r.code === 'version_conflict' ? errorResponse('version_conflict', 'The relayer changed since you opened this page (someone may have acted, or it paused again). Nothing was done. Reload the page and look again.') : errorResponse(r.code as Parameters<typeof errorResponse>[0], r.error);
    } else {
      const result = r.result;
      outcome = result.done ? 'done' : code(result.refused);
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', code: outcome });
      res = json(200, { result: { done: result.done, refused: result.refused ? code(result.refused) : null }, words: actWords(input.tool, slot, result, chainId, result.relayer?.halted ?? null) });
    }
  } catch (err) {
    outcome = 'unknown';
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    res = json(200, { result: { done: false, refused: 'unknown' }, words: actWords(input.tool, slot, { done: false, refused: 'unknown' }, chainId) });
  }

  // 3. The result's row (the relayer's own log has it too: a failure here is logged, not the staffer's problem).
  try {
    const a = await c.env.CONSOLE.recordStaffAction({ ...ctx, action: 'evm_relay.staff_result', target, details: { tool: input.tool, chainId, slot, result: outcome.slice(0, 64) } });
    if (!a.ok) log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: a.code }, 'error');
  } catch (err) {
    log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: 'upstream_unavailable', error: errorName(err) }, 'error');
  }
  return res;
}
