// The admin portal's "Gas sponsorship" (D843): what the API's AdminRpc answers about the EVM relayer (D851) and what
// a staff tool call takes. The API reads its relayer object through apps/api/src/evm-relayer-staff.ts only; the admin
// Worker turns these views into plain words (apps/admin/src/evm-relay.ts). Every view holds public data only: the
// relayer's address, slot numbers, transaction hashes, amounts, times, app ids and names, the staff log (staff emails,
// shown to staff only). Never a key, a raw transaction, calldata, a signature or a user's account.
import { z } from '@hana-id/env/zod';
import { ctx } from './types.ts';

/** The staff tools, in the relayer's own names (`staffResume`, `staffCancel`, `staffClose`, `staffFill`, `staffAdoptNonce`). */
export const EVM_RELAY_TOOLS = ['resume', 'cancel', 'close', 'fill', 'adopt_nonce'] as const;
export type EvmRelayTool = (typeof EVM_RELAY_TOOLS)[number];

/** A staff note: one line of plain text (trimmed), at least this many characters... */
export const EVM_RELAY_NOTE_MIN = 10;
/** ...and at most this many (the relayer keeps 500, the audit row keeps this many). */
export const EVM_RELAY_NOTE_MAX = 300;
/**
 * Control characters (line breaks included), the C1 range, the Arabic letter mark, the zero-width space, joiners and
 * marks, the line and paragraph separators, the bidirectional overrides and isolates, the invisible operators and the
 * byte-order mark: a note is shown as text beside who wrote it, so nothing in it may move, join or hide other text.
 */
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
export const isPlainNote = (s: string): boolean => !NOT_PLAIN.test(s);

const chainIdInput = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** A slot (the relayer's transaction number, a nonce): a safe integer, 0 or more. */
export const evmRelaySlot = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const evmRelayNote = z
  .string()
  .trim()
  .min(EVM_RELAY_NOTE_MIN, `A note of at least ${EVM_RELAY_NOTE_MIN} characters`)
  .max(EVM_RELAY_NOTE_MAX, `A note of at most ${EVM_RELAY_NOTE_MAX} characters`)
  .refine(isPlainNote, 'One line of plain text: no line breaks or control characters');

/** `AdminRpc.evmRelayDetail`: one sponsored chain's relayer, its waiting transactions and its staff log. */
export const evmRelayDetailInput = ctx.extend({ chainId: chainIdInput }).strict();

/**
 * `AdminRpc.evmRelayAct`: one staff tool. `slot` for every tool but `resume` (which takes none). `seen` is what the
 * page showed when the staffer chose the tool: the halt's start (null: running) and the newest staff action's number
 * (0: none). The API acts only when the relayer still shows both, so a stale page, a second tab or a double submit
 * does nothing (`version_conflict`); the relayer's own checks come after that, and are final.
 */
export const evmRelayActInput = ctx
  .extend({
    chainId: chainIdInput,
    tool: z.enum(EVM_RELAY_TOOLS),
    slot: evmRelaySlot.optional(),
    note: evmRelayNote,
    seen: z.object({ haltSince: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), lastStaffSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
    /** Resume after a halt that means the key may be used by someone else: the staffer confirms an engineer said the key is safe or replaced. */
    keyConfirmed: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => (v.tool === 'resume') === (v.slot === undefined), { message: 'resume takes no slot; every other tool takes one', path: ['slot'] })
  .refine((v) => v.keyConfirmed === undefined || v.tool === 'resume', { message: 'keyConfirmed is for resume only', path: ['keyConfirmed'] });

export type EvmRelayDetailInput = z.infer<typeof evmRelayDetailInput>;
export type EvmRelayActInput = z.infer<typeof evmRelayActInput>;

/** Why the relayer stopped (D851; the relayer's `EvmRelayerHaltReason`). An API newer than the admin may add one. */
export const EVM_RELAY_HALT_REASONS = ['nonce_consumed_elsewhere', 'nonce_gap', 'foreign_transactions', 'relayer_cannot_send', 'stuck_past_deadline', 'key_mismatch', 'storage_inconsistent'] as const;

/** `relayer_cannot_send` codes that mean another sender with the relayer's key (D851 items 16, 18). */
const LEAK_CODES: ReadonlySet<string> = new Set(['replacement_underpriced', 'sender_restricted', 'nonce_too_low', 'nonce_too_high']);
/**
 * Whether a halt means the relayer's key may be used by someone else (D843 as amended after review): a slot used by a
 * transaction it didn't send, a gap only another sender leaves, more transactions than it sent, or a refusal that says
 * another sender holds its numbers. Such a halt is handled by an engineer first (the leaked-key runbook), and Resume
 * needs the staffer to confirm an engineer said the key is safe or replaced.
 */
export function isLeakHalt(h: { reason: string; code?: string | null } | null | undefined): boolean {
  if (!h) return false;
  if (h.reason === 'nonce_consumed_elsewhere' || h.reason === 'nonce_gap' || h.reason === 'foreign_transactions') return true;
  return h.reason === 'relayer_cannot_send' && typeof h.code === 'string' && LEAK_CODES.has(h.code);
}

/**
 * Whether Resume needs the staffer to confirm an engineer said the key is safe or replaced (D843 after its re-check):
 * the halt itself is a leak type, or the relayer marked it `leakSeen` (a leak-type condition seen during the pause, or
 * a staff Close, Fill or Set the next slot number done during it). The relayer refuses such a Resume on its own too.
 */
export function needsKeyConfirmation(h: { reason: string; code?: string | null; leakSeen?: boolean } | null | undefined): boolean {
  return isLeakHalt(h) || h?.leakSeen === true;
}

export interface EvmRelayHalt {
  reason: string;
  since: number;
  /** The slot concerned, when the reason names one. */
  slot: number | null;
  /** `relayer_cannot_send`'s refusal code (`insufficient_funds`, `fee_cap_too_low`, …), else null. */
  code: string | null;
  /** The relayer saw a sign of a leaked key during this pause (or staff changed a slot): see `needsKeyConfirmation`. */
  leakSeen: boolean;
}

/** One staff action as the relayer recorded it (who: the staff email). `refused`: the relayer's reason, or null when done. */
export interface EvmRelayStaffEntry {
  seq: number;
  at: number;
  who: string;
  tool: EvmRelayTool;
  slot: number | null;
  note: string;
  done: boolean;
  refused: string | null;
}

/** The relayer object's own state (its storage: no chain read). */
export interface EvmRelayRelayerView {
  /** It has sent something at least once (it keeps a slot count); before that every tool answers `no_state`. */
  started: boolean;
  /** The address its records were signed by (the key it holds them for); differs from `relayerAddress` after a key change. */
  signerAddress: string;
  halted: EvmRelayHalt | null;
  /** Transactions not yet on the chain, and those on it but not yet final (12 blocks or the `safe` block). */
  waiting: number;
  awaitingConfirmation: number;
  oldestWaitingMs: number | null;
  /** The age of the oldest transaction no network server has taken yet, or null. */
  oldestNotTakenMs: number | null;
  /** The slot the next transaction gets; null before the first send. */
  nextSlot: number | null;
  /** Today's spend (UTC day) as the relayer counts it: final costs, plus the most each waiting one can cost (wei). */
  spentTodayWei: string;
  /** Refusals heard only from a backup server (no pause): how many, the last time, slot and code. */
  unconfirmedRefusals: { count: number; lastAt: number; slot: number; code: string } | null;
  /** The newest staff action's number (0: none): the `seen.lastStaffSeq` a tool call sends back. */
  lastStaffSeq: number;
  /** Newest first: the last 5 in a status answer, the last 50 on the detail page. */
  staffLog: EvmRelayStaffEntry[];
}

/** One sponsored chain, for the System status tile and the detail page's header. Amounts are wei (decimal strings). */
export interface EvmRelayChainView {
  chainId: number;
  /** When the API read it (ms). */
  readAt: number;
  /** The manifest's `relayerAddress` (EIP-55). */
  relayerAddress: string;
  /** EVM_RELAY_KEYS: set and the manifest's address (`ok`), unset (`missing`: the off switch), or unreadable or another address (`wrong`). */
  key: 'ok' | 'missing' | 'wrong';
  /**
   * The trusted read endpoint: the secret `EVM_SPONSOR_RPC_<chainId>` set (`keyed`), unset in a `local*` env (`public`:
   * the manifest's `rpc`), or unset elsewhere (`missing`: sponsorship is off there, D851 as amended).
   */
  readEndpoint: 'keyed' | 'public' | 'missing';
  lowBalanceWei: string;
  dailyBudgetWei: string;
  /** One sponsored transaction's most it can cost (gas cap × fee cap, doubled on an OP Stack chain for the L1 data fee). */
  oneSendWorstWei: string;
  relayer: ({ ok: true } & EvmRelayRelayerView) | { ok: false; code: string };
  /**
   * Today's reservations against `dailyBudgetWei` as the sponsorship handlers count them (the env's day budget, D836;
   * the same count `evm_relay_budget_high` fires on at 80%): worst cases reserved, settled to the real cost once mined.
   */
  budget: { ok: true; spentWei: string } | { ok: false; code: string };
  balance: { ok: true; wei: string } | { ok: false; code: string };
  /** The account helper program (the pinned EIP-7702 delegate): its code on the chain against the pinned hash. */
  helper: { address: string; pinnedCodeHash: string | null } & ({ ok: true; codeHash: string | null; matches: boolean } | { ok: false; code: string });
}

/**
 * `ApiSystemStatus.evmRelay`, always present from an API that knows it (D843 as amended: a missing field means an API
 * older than the admin): `absent` when the env has no `evm.sponsor` (nothing is read); `bad_config` when the API
 * refuses the block (sponsorship off; nothing is read); `timeout` when the reads didn't finish in time (the rest of
 * the status stands); `on` with one view per sponsored chain.
 */
export type EvmRelayStatus = { state: 'absent'; chains: [] } | { state: 'bad_config'; chains: [] } | { state: 'timeout'; chains: [] } | { state: 'on'; chains: EvmRelayChainView[] };

/** One transaction the relayer holds. `app` comes from the sponsorship's own send records (null when unknown). */
export interface EvmRelayRecordView {
  slot: number;
  /** A user's action, or a staff gap filler. */
  kind: 'action' | 'filler';
  /** A receipt of one of its copies is on the chain (not yet final). */
  onChain: boolean;
  /** A network server took one of its copies. */
  taken: boolean;
  /** Its newest copy is the cancel (a 0-value transfer to the relayer itself). */
  cancelling: boolean;
  sentAt: number;
  /** The user's time limit (ms); a filler's signing time. */
  deadlineAt: number;
  /** Every copy signed for this slot, oldest first: hashes only. */
  copies: { hash: string; kind: 'action' | 'cancel' }[];
  /** The refusal the relayer recorded for it (`insufficient_funds`, `gas_limit`, …), or null. */
  refusedCode: string | null;
  app: { id: string; name: string | null } | null;
}

/**
 * `AdminRpc.evmRelayDetail`. `apps`: `recorded` when the app of each user action was read from the sponsorship's send
 * records (`evm_sponsor_sends`, by chain and digest), `unreadable` when that read failed (the records still show).
 */
export interface EvmRelayDetail {
  chain: EvmRelayChainView;
  records: EvmRelayRecordView[];
  apps: 'recorded' | 'unreadable';
  /** The network's own count of the relayer's transactions (the trusted endpoint, as the relayer reads it): the next slot it expects. */
  chainCount: { ok: true; latest: number; pending: number } | { ok: false; code: string };
}

/** `AdminRpc.evmRelayAct`: done, or the relayer's (or the API's) reason for doing nothing, and the relayer afterwards. */
export interface EvmRelayActResult {
  done: boolean;
  refused: string | null;
  relayer: EvmRelayRelayerView | null;
}
