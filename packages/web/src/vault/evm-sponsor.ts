// The vault's sponsored EVM action (`evm_sendSponsored`, docs/decisions.md D855, D856; docs/architecture.md "Gas-free
// EVM actions"): a batch of calls Journear's relayer sends for the user through the pinned EIP-7702 delegate, the
// network fee paid by Journear. The vault builds everything the user signs from its own build manifest and the pinned
// delegate table, treats the API's prepare answer as hints it checks, shows one approval, signs only the bytes that
// approval showed, and posts the signatures to the API itself (D832): they never reach the partner page.
//
//   preflight (no network)  → the build sponsors the chain (HanaEnv.evmSponsor, the pinned non-placeholder delegate,
//                             never a local chain outside a local build, testnets only), the calls are well formed
//   prepare (API)           → delegation, nonces, the API's clock, the gas window; checked, never trusted for the
//                             delegate, the relayer, the chain, the account or the account's setup
//   the account (chain)     → its code and transaction count, read by the vault itself from the build's endpoints:
//                             the only source for whether to sign the one-time setup, and at which nonce
//   subject                 → sponsoredApprovalContent: one approval (kind evm_sponsored, never auto-approved)
//   approved                → the approved bytes decoded again and checked against the build and the request
//   sign                    → one chain-key derivation: the authorization (iff the subject has an authorization nonce)
//                             and the Execute, both through core's guarded signers with the build's chains only
//   send (API)              → `{transactionHash, status: 'executed'}`, nothing else
//
// What a malicious partner page controls: the calls (each shown in the approval, value 0 by the protocol) and when it
// asks. What a lying API controls: the prepare answer's hints (delegation, nonces, its clock, the gas window) and every
// answer. Neither chooses the chain beyond the build's list, the account (the session's), the delegate (the pinned
// one), the relayer (the build's) or anything the approval didn't show; a lying prepare can at worst make the send
// fail or be refused. Every refusal is a VaultError whose message a partner may show its users as it is (the plain
// wording rule): everyday words, nothing about gas, nonces or contracts.
//
// SECURITY: the signatures and the authorization go only into the send body; no message, error or log carries them.
import {
  ApiError,
  type ApprovalSubject,
  ErrorCode,
  type EvmSponsorRequestMethod,
  type EvmSponsorSessionProof,
  IDENTITY_NONCE_BYTES,
  type PortRequest,
  type WalletProof,
  bytesEqual,
  checksumEvmAddress,
  evmSponsorSessionMessage,
  isEvmAddress,
  isTestEvmChain,
  parseEvmAddress,
} from '@hana-id/core';
import {
  type EvmSponsorSubject,
  type SignedAuthorization,
  decodeSponsorSubject,
  delegationTarget,
  signAuthorization,
  signExecute,
  sponsorDelegate,
  sponsorSubjectAuthorization,
  sponsorSubjectExecuteInput,
  sponsoredApprovalContent,
} from '@hana-id/core/evm-sponsor';
import { withChainKey } from '@hana-id/core/derivation';
import type { HanaEnv } from '../hana-env.ts';
import { isLoopbackHost } from '../client/urls.ts';
import type { Locks, Timers } from './runtime.ts';
import { VaultError } from './errors.ts';

export type SponsoredRequest = Extract<PortRequest, { method: 'evm_sendSponsored' }>;

// ---- the words a partner may show its users (D855, the plain-wording rule) ----

export const SPONSOR_TEXT = Object.freeze({
  notOffered: 'Free network fees aren’t offered on this network.',
  notForThis: 'Journear doesn’t pay network fees for this action.',
  delegatedElsewhere: 'Your account was set up by another wallet app, so Journear can’t pay network fees for it. Nothing was sent.',
  budgetUsed: 'Journear’s free network fees for this app are used up for today. Try again tomorrow.',
  notAvailable: 'Free network fees aren’t available for your account right now. Try again later.',
  tooBig: 'This action is too big for free network fees.',
  busy: 'Your last action is still going through. Wait for it to finish, then try again.',
  clockWrong: 'Your device’s clock is wrong. Set it to the right time, then try again.',
  notReady: 'Journear couldn’t get this action ready. Nothing was sent. Try again later.',
  tooSlow: 'This took too long, so nothing was sent. Please try again.',
  noSignIn: 'Journear can’t do this with your current sign-in. Sign in again, then try again.',
  signInEnded: 'Your sign-in has ended. Sign in again, then try again.',
  failed: 'The action didn’t go through, so nothing changed.',
  /** A batch that carried the one-time setup: an applied authorization stays applied even when the batch reverts. */
  failedAfterSetup: 'The action didn’t go through. Your account’s one-time setup may still have been done. Nothing else changed.',
  wouldFail: 'This action would fail, so it wasn’t sent. Nothing changed.',
  notConfirmed: 'Your action was sent but isn’t confirmed yet. Check again in a minute before you try again.',
  unknownOutcome: 'Journear couldn’t tell whether your action went through. Check before you try again.',
  accountChanged: 'Your account changed while this was getting ready. Nothing was sent. Please try again.',
  alreadySending: 'This action is already being sent. Wait a moment, then check before you try again.',
  settingUp: 'Journear is still setting up your account. Try again in a few seconds.',
  tooMany: 'Too many actions right now. Wait a moment and try again.',
  tooManyFailed: 'Too many actions failed today. Try again tomorrow.',
  unavailable: 'Journear couldn’t send this action right now. Try again later.',
  paused: 'Free network fees are paused right now. Try again later.',
  feesHigh: 'Network fees are too high right now. Nothing was sent. Try again in a few minutes.',
  busyNow: 'Journear is busy with other actions right now. Nothing was sent. Try again in a few seconds.',
  wrongAccount: 'This isn’t the account you’re signed in with. Nothing was sent. Sign in again, then try again.',
  signInNotReady: 'Journear is still finishing your sign-in. Try again in a few seconds.',
  signInUnchecked: 'Journear couldn’t check your sign-in, so nothing was sent. Sign in again, then try again.',
});

// ---- limits (D855) ----

/** How long a signed batch stays valid: 5 minutes, less where the API's window is shorter. */
export const SPONSOR_LIFETIME_S = 300;
/** Below this lifetime there isn't time to approve and send: the action is refused (`not_available`). */
export const SPONSOR_MIN_LIFETIME_S = 120;
/** The API checks the deadline against its own clock; this much room is kept for the vault's clock being off. */
export const SPONSOR_DEADLINE_MARGIN_S = 60;
/** After the approval, at least this long must remain before the deadline, or nothing is signed (the API needs 30 s). */
export const SPONSOR_SEND_MIN_LEFT_S = 45;
/** The vault's clock (server-corrected) and the API's `serverNow` may differ by at most this much. */
export const SPONSOR_CLOCK_SKEW_MAX_S = 60;
/** The device's own clock (the approval window's) may differ from the API's by at most this much. */
export const SPONSOR_DEVICE_SKEW_MAX_S = 240;
/** The prepare answer's `deadlineMaxS` must be in the manifest's bounds (D836). */
export const SPONSOR_DEADLINE_MAX_BOUNDS = [60, 3600] as const;
/**
 * The gas floor a call gets at the least, whatever the API says: about twice a first check-in (23 899 measured, D845).
 * Before mainnet the floor should come from the vault's own estimate through the build's endpoints (D855).
 */
export const SPONSOR_MIN_GAS_PER_CALL = 50_000;
/** The largest `maxMinGas` the vault accepts (D836's bound on `maxGasPerTx`). */
export const SPONSOR_MAX_MIN_GAS = 2_000_000;
/** Chains a local node uses: sponsored only in a `local*` build. */
export const LOCAL_EVM_CHAINS: readonly number[] = [31337, 1337];
/** How long the vault waits for prepare and for send (the API polls the receipt for up to 30 s). */
export const SPONSOR_PREPARE_TIMEOUT_MS = 15_000;
export const SPONSOR_SEND_TIMEOUT_MS = 60_000;

const U64_MAX = (1n << 64n) - 1n;

// ---- the build's chains ----

export interface SponsorChain {
  readonly chainId: number;
  /** The pinned delegate, EIP-55. */
  readonly delegate: `0x${string}`;
  /** The build's relayer, EIP-55. */
  readonly relayer: `0x${string}`;
  /** The chain's public JSON-RPC endpoints in the build (manifest `rpc`, then `rpcFallback`): 1 or 2. */
  readonly rpcs: readonly string[];
  /** A `local*` build: the only one where the one-time setup may rest on a single configured endpoint. */
  readonly local: boolean;
}

/** An RPC endpoint the vault may read: https, or http to a loopback host in a local build only. */
function rpcUrlOrNull(v: unknown, local: boolean): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.username || u.password) return null;
    if (u.protocol === 'https:') return v;
    return u.protocol === 'http:' && local && isLoopbackHost(u.hostname) ? v : null;
  } catch {
    return null;
  }
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function evmAddressOrNull(v: unknown): `0x${string}` | null {
  if (typeof v !== 'string' || !isEvmAddress(v)) return null;
  try {
    const b = parseEvmAddress(v);
    return b.every((x) => x === 0) ? null : checksumEvmAddress(b);
  } catch {
    return null;
  }
}

/**
 * The chains this build sponsors, ascending: HanaEnv.evmSponsor's entries whose key is a canonical chain ID of a test
 * network (a local chain only in a `local*` build), whose delegate is the pinned, non-placeholder one for that chain,
 * whose relayer is a valid address and whose `rpc` (and `rpcFallback`, when set) is an https URL (http to a loopback
 * host in a local build). Anything else in the table is ignored (fail closed). At most 4 (the manifest's
 * bound, protocol SPONSORED_CHAINS_MAX).
 */
export function sponsorChains(env: Pick<HanaEnv, 'name' | 'evmSponsor'>): SponsorChain[] {
  const table = env.evmSponsor;
  if (!table || typeof table !== 'object') return [];
  const local = env.name.startsWith('local');
  const out: SponsorChain[] = [];
  for (const key of Object.keys(table)) {
    if (!/^[1-9][0-9]{0,15}$/u.test(key)) continue;
    const chainId = Number(key);
    if (!Number.isSafeInteger(chainId) || !isTestEvmChain(chainId)) continue;
    if (LOCAL_EVM_CHAINS.includes(chainId) && !local) continue;
    const entry = table[key];
    const pinned = sponsorDelegate(chainId);
    if (!entry || !pinned || pinned.placeholder) continue;
    const delegate = evmAddressOrNull(entry.delegate);
    const relayer = evmAddressOrNull(entry.relayer);
    if (!delegate || !relayer || !sameAddress(delegate, pinned.address) || sameAddress(relayer, delegate)) continue;
    // The vault reads the account's setup itself (D855): no endpoint, no sponsorship.
    const rpc = rpcUrlOrNull(entry.rpc, local);
    if (!rpc) continue;
    const fallback = entry.rpcFallback === undefined ? null : rpcUrlOrNull(entry.rpcFallback, local);
    if (entry.rpcFallback !== undefined && !fallback) continue;
    const rpcs = Object.freeze(fallback && fallback !== rpc ? [rpc, fallback] : [rpc]);
    out.push(Object.freeze({ chainId, delegate, relayer, rpcs, local }));
  }
  return out.sort((a, b) => a.chainId - b.chainId).slice(0, 4);
}

// ---- preflight: before any network or window ----

export interface SponsorPlanInput {
  readonly chain: SponsorChain;
  /** The session's EVM address, EIP-55. */
  readonly account: `0x${string}`;
  /** The calls, as the API and the subject take them: `to` EIP-55, value 0, data lowercase hex. */
  readonly calls: readonly { readonly to: `0x${string}`; readonly value: 0n; readonly data: `0x${string}` }[];
}

const refusal = (message: string, reason: string, extra: Record<string, unknown> = {}): VaultError => new VaultError(ErrorCode.unauthorized, message, { reason, ...extra });

/**
 * The checks that need neither the API nor a window: the chain is one this build sponsors (never chain 0, never a
 * local chain outside a local build, never a mainnet: a test app's or a live app's), and every call is well formed,
 * value 0, with a function, and never to the zero address, the account itself, the delegate or the relayer. Throws
 * VaultError 4100; returns the calls in the form the subject and the API take.
 */
export function sponsorPreflight(request: SponsoredRequest, account: string, chains: readonly SponsorChain[]): SponsorPlanInput {
  const { chainId, calls } = request.params;
  const chain = chains.find((c) => c.chainId === chainId);
  if (!chain) throw refusal(SPONSOR_TEXT.notOffered, 'chain_not_sponsored', { chainId });
  const own = evmAddressOrNull(account);
  if (!own) throw refusal(SPONSOR_TEXT.noSignIn, 'no_evm_account');
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 8) throw refusal(SPONSOR_TEXT.notForThis, 'invalid_request');
  const out = calls.map((c) => {
    const to = evmAddressOrNull(c?.to);
    if (!to || c.value !== '0x0' || typeof c.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,8192}$/u.test(c.data)) throw refusal(SPONSOR_TEXT.notForThis, 'invalid_request');
    if (sameAddress(to, own) || sameAddress(to, chain.delegate) || sameAddress(to, chain.relayer)) throw refusal(SPONSOR_TEXT.notForThis, 'target_not_allowed');
    return Object.freeze({ to, value: 0n as const, data: c.data.toLowerCase() as `0x${string}` });
  });
  return Object.freeze({ chain, account: own, calls: Object.freeze(out) });
}

/** The calls as the API's bodies carry them (`value` a decimal string). */
export const wireCalls = (p: SponsorPlanInput): { to: string; value: string; data: string }[] => p.calls.map((c) => ({ to: c.to, value: '0', data: c.data }));

// ---- the prepare answer: hints, checked ----

export interface PrepareAnswer {
  delegation: 'none' | 'journear' | 'other';
  accountNonce: bigint;
  executeNonce: bigint | null;
  serverNow: number;
  relayer: string;
  implementation: string;
  minGasFloor: bigint;
  maxMinGas: bigint;
  deadlineMaxS: number;
  allowed: boolean;
  reason: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const decimal = (v: unknown, max: bigint): bigint | null => (typeof v === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(v) && BigInt(v) <= max ? BigInt(v) : null);
const CODE_WORD = /^[a-z][a-z0-9_]{0,63}$/u;

/** The prepare answer read strictly (docs/api.md); null for any other shape. */
export function parsePrepareAnswer(v: unknown): PrepareAnswer | null {
  if (!isObj(v)) return null;
  const delegation = v.delegation;
  if (delegation !== 'none' && delegation !== 'journear' && delegation !== 'other') return null;
  const accountNonce = decimal(v.accountNonce, U64_MAX - 1n);
  const executeNonce = v.executeNonce === null ? null : decimal(v.executeNonce, U64_MAX);
  const minGasFloor = decimal(v.minGasFloor, U64_MAX);
  const maxMinGas = decimal(v.maxMinGas, U64_MAX);
  if (accountNonce === null || minGasFloor === null || maxMinGas === null) return null;
  if (executeNonce === null && v.executeNonce !== null) return null;
  if (executeNonce === null && delegation !== 'other') return null;
  if (!Number.isSafeInteger(v.serverNow) || (v.serverNow as number) <= 0) return null;
  if (!Number.isSafeInteger(v.deadlineMaxS) || (v.deadlineMaxS as number) <= 0) return null;
  if (typeof v.relayer !== 'string' || !isEvmAddress(v.relayer) || typeof v.implementation !== 'string' || !isEvmAddress(v.implementation)) return null;
  if (typeof v.allowed !== 'boolean') return null;
  if (v.reason !== undefined && (typeof v.reason !== 'string' || !CODE_WORD.test(v.reason))) return null;
  if (!v.allowed && v.reason === undefined) return null;
  return {
    delegation,
    accountNonce,
    executeNonce,
    serverNow: v.serverNow as number,
    relayer: v.relayer,
    implementation: v.implementation,
    minGasFloor,
    maxMinGas,
    deadlineMaxS: v.deadlineMaxS as number,
    allowed: v.allowed,
    reason: typeof v.reason === 'string' ? v.reason : null,
  };
}

/** The refusal for prepare's `allowed: false` (and `delegation: 'other'`, D840), before any window. */
function notAllowed(reason: string): VaultError {
  switch (reason) {
    case 'delegated_elsewhere':
      return refusal(SPONSOR_TEXT.delegatedElsewhere, 'delegated_elsewhere');
    case 'budget_exhausted':
      return refusal(SPONSOR_TEXT.budgetUsed, 'budget_exhausted');
    case 'gas_too_high':
      return refusal(SPONSOR_TEXT.tooBig, 'gas_too_high');
    case 'chain_not_enabled':
      return refusal(SPONSOR_TEXT.notOffered, 'chain_not_enabled');
    case 'app_not_sponsored':
      return refusal(SPONSOR_TEXT.notForThis, 'app_not_sponsored');
    case 'paused':
      return refusal(SPONSOR_TEXT.paused, 'paused');
    default:
      return refusal(SPONSOR_TEXT.notAvailable, 'not_available');
  }
}

const notReady = (why: string): VaultError => new VaultError('api_unavailable', SPONSOR_TEXT.notReady, { reason: 'bad_answer', detail: why });

// ---- the account's setup, read by the vault itself (D855, after the review of PR 76) ----

/** The account as the build's endpoints show it. */
export interface AccountOnChain {
  /** The account's code: empty, the EIP-7702 designator, or anything else. */
  readonly code: string;
  /** Its transaction count, latest and pending. */
  readonly latest: bigint;
  readonly pending: bigint;
  /** How many of the build's endpoints answered (and agreed). */
  readonly answered: number;
}

/** How long one endpoint gets for its four reads. */
export const SPONSOR_RPC_TIMEOUT_MS = 8_000;

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/u;

/** The most of one endpoint answer the vault reads (a contract's code is at most 24 KiB, so 48 KiB of hex). */
export const SPONSOR_RPC_MAX_BODY_BYTES = 64 * 1024;

class TooLarge extends Error {}

/** The body as text, read as a stream and given up past `max` bytes (never buffered whole first). */
async function cappedText(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > max) throw new TooLarge();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * One endpoint's view (its chain checked first); `down` when it gives no answer (network, the 8 s timeout, a non-OK HTTP
 * status, a JSON-RPC error), `bad` when it answers something unusable (another chain, a malformed value, a body over
 * 64 KiB, which is never parsed).
 */
async function readAt(url: string, chainId: number, account: string, fetchFn: typeof fetch, timers: Timers): Promise<AccountOnChain | 'down' | 'bad'> {
  const ctl = new AbortController();
  const timer = timers.setTimeout(() => ctl.abort(), SPONSOR_RPC_TIMEOUT_MS);
  const call = async (method: string, params: unknown[], id: number): Promise<unknown> => {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal });
    if (!res.ok) throw new Error('rpc');
    const body = JSON.parse(await cappedText(res, SPONSOR_RPC_MAX_BODY_BYTES)) as unknown;
    if (!isObj(body) || body.id !== id || body.error !== undefined) throw new Error('rpc');
    return body.result;
  };
  let answers: unknown[];
  try {
    answers = await Promise.all([
      call('eth_chainId', [], 1),
      call('eth_getCode', [account, 'latest'], 2),
      call('eth_getTransactionCount', [account, 'latest'], 3),
      call('eth_getTransactionCount', [account, 'pending'], 4),
    ]);
  } catch (e) {
    // An oversized answer is an endpoint answering something unusable, not one that is down.
    return e instanceof TooLarge ? 'bad' : 'down';
  } finally {
    timers.clearTimeout(timer);
  }
  const [chain, code, latest, pending] = answers;
  if (typeof chain !== 'string' || !QUANTITY.test(chain.toLowerCase()) || BigInt(chain) !== BigInt(chainId)) return 'bad';
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(code) || code.length > 2 + 2 * 24_576) return 'bad';
  if (typeof latest !== 'string' || typeof pending !== 'string' || !QUANTITY.test(latest.toLowerCase()) || !QUANTITY.test(pending.toLowerCase())) return 'bad';
  return { code: code.toLowerCase(), latest: BigInt(latest), pending: BigInt(pending), answered: 1 };
}

/**
 * The account's code and transaction count from the build's endpoints, each read alone (its chain ID checked). Every
 * endpoint that answers must agree on all three; one down (no answer) is fine; none answering, an endpoint that answers
 * something unusable (another chain, a malformed value) or a disagreement is unreadable (`bad_answer`): the API's word is
 * never the fallback.
 */
export async function readAccount(chain: SponsorChain, account: string, fetchFn: typeof fetch, timers: Timers): Promise<AccountOnChain> {
  const read = await Promise.all(chain.rpcs.map((url) => readAt(url, chain.chainId, account, fetchFn, timers)));
  if (read.includes('bad')) throw notReady('chain_bad_answer');
  const views = read.filter((v): v is AccountOnChain => typeof v === 'object');
  const first = views[0];
  if (!first) throw notReady('chain_unreadable');
  if (views.some((v) => v.code !== first.code || v.latest !== first.latest || v.pending !== first.pending)) throw notReady('chain_disagrees');
  return { ...first, answered: views.length };
}

/**
 * Whether this action signs the one-time setup, and at which nonce, from the account as the vault read it (D855):
 * - no code: the setup, only when two configured endpoints both answered and agreed (one endpoint's word only in a
 *   `local*` build that configures one), the API said `none`, and latest == pending == the API's `accountNonce` (else
 *   not ready: a future nonce would make an authorization usable later, a pending one may not apply);
 * - exactly the pinned delegate's designator: no setup, only when the API said `journear` (else not ready);
 * - any other code: set up by another wallet app (D840), whatever the API said.
 */
export function setupNonce(onChain: AccountOnChain, answer: PrepareAnswer, chain: SponsorChain): bigint | null {
  if (onChain.code === '0x') {
    // An authorization never rests on one provider's word (a lying endpoint and a lying API could otherwise get one
    // signed for an account another wallet set up): both configured endpoints must have answered and agreed.
    const oneAllowed = chain.local && chain.rpcs.length === 1;
    if (!oneAllowed && (chain.rpcs.length < 2 || onChain.answered < 2)) throw notReady('setup_needs_two_endpoints');
    if (answer.delegation !== 'none') throw notReady('delegation');
    if (onChain.latest !== onChain.pending || onChain.latest !== answer.accountNonce) throw notReady('account_nonce');
    return onChain.latest;
  }
  let target: string | null = null;
  try {
    target = delegationTarget(Uint8Array.from(onChain.code.slice(2).match(/../gu) ?? [], (h) => Number.parseInt(h, 16)));
  } catch {
    target = null;
  }
  if (target !== null && sameAddress(target, chain.delegate)) {
    if (answer.delegation !== 'journear') throw notReady('delegation');
    return null;
  }
  throw notAllowed('delegated_elsewhere');
}

/**
 * The checks of the prepare answer that need nothing else (before the vault reads the chain): the build's relayer and
 * implementation, `delegation: 'other'` (D840) and `allowed: false`.
 */
export function precheckAnswer(plan: SponsorPlanInput, answer: PrepareAnswer): void {
  if (!sameAddress(answer.relayer, plan.chain.relayer)) throw notReady('relayer');
  if (!sameAddress(answer.implementation, plan.chain.delegate)) throw notReady('implementation');
  if (answer.delegation === 'other') throw notAllowed('delegated_elsewhere');
  if (!answer.allowed) throw notAllowed(answer.reason ?? 'not_available');
}

export interface SponsorClocks {
  /** The vault's server-corrected clock, ms (runtime.ts Clock). */
  vaultNowMs: number;
  /** The device's own clock, ms (Date.now: the approval window's). */
  deviceNowMs: number;
}

/**
 * The subject the user approves, from the build (chain, delegate, relayer), the session (account), the request (calls)
 * and the prepare answer's checked hints (D855):
 * - the answer's relayer and implementation must be the build's (the subject always names the build's);
 * - `delegation: 'other'`: refused (D840); `allowed: false`: refused with its reason;
 * - the clocks: the device's within SPONSOR_DEVICE_SKEW_MAX_S of `serverNow` (else "your device's clock is wrong"),
 *   the vault's within SPONSOR_CLOCK_SKEW_MAX_S (else not ready); `serverNow` is used for nothing else;
 * - the deadline: the vault's clock + min(5 min, deadlineMaxS − 60 s), refused below 2 minutes;
 * - minGas: the most the transaction cap leaves (`maxMinGas`, D855), refused unless floor ≤ max ≤ 2,000,000 and max ≥
 *   50,000 per call;
 * - the authorization nonce only when the account as the vault read it has no code (setupNonce).
 */
export function sponsorSubject(plan: SponsorPlanInput, answer: PrepareAnswer, onChain: AccountOnChain, clocks: SponsorClocks): EvmSponsorSubject {
  const { chain } = plan;
  precheckAnswer(plan, answer);
  const authNonce = setupNonce(onChain, answer, chain);
  if (Math.abs(clocks.deviceNowMs / 1000 - answer.serverNow) > SPONSOR_DEVICE_SKEW_MAX_S) throw refusal(SPONSOR_TEXT.clockWrong, 'clock_wrong');
  if (Math.abs(clocks.vaultNowMs / 1000 - answer.serverNow) > SPONSOR_CLOCK_SKEW_MAX_S) throw notReady('clock');
  const [lo, hi] = SPONSOR_DEADLINE_MAX_BOUNDS;
  if (answer.deadlineMaxS < lo || answer.deadlineMaxS > hi) throw notReady('deadline_window');
  const lifetime = Math.min(SPONSOR_LIFETIME_S, answer.deadlineMaxS - SPONSOR_DEADLINE_MARGIN_S);
  if (lifetime < SPONSOR_MIN_LIFETIME_S) throw notAllowed('not_available');
  const deadline = BigInt(Math.floor(clocks.vaultNowMs / 1000) + lifetime);
  const callFloor = BigInt(SPONSOR_MIN_GAS_PER_CALL * plan.calls.length);
  if (answer.minGasFloor > answer.maxMinGas || answer.maxMinGas > BigInt(SPONSOR_MAX_MIN_GAS) || answer.minGasFloor === 0n) throw notReady('gas_window');
  if (answer.maxMinGas < callFloor) throw notAllowed('gas_too_high');
  if (answer.executeNonce === null) throw notReady('nonce');
  return Object.freeze({
    chainId: chain.chainId,
    account: plan.account,
    delegate: chain.delegate,
    authNonce,
    calls: plan.calls,
    executeNonce: answer.executeNonce,
    deadline,
    relayer: chain.relayer,
    minGas: answer.maxMinGas,
  });
}

/** The approval subject (kind evm_sponsored) of a sponsored subject: its bytes and chain, for the popup to decode. */
export function sponsoredApproval(subject: EvmSponsorSubject): ApprovalSubject {
  const content = sponsoredApprovalContent(subject);
  return { kind: 'evm_sponsored', chain: 'evm', address: subject.account, bytes: Uint8Array.from(content.bytes), context: content.context };
}

// ---- after the approval: the approved bytes, decoded and checked again, then signed ----

/**
 * Decodes the approved bytes (never the in-memory subject), first compared with `shown`, a copy taken when the window
 * was built (so a later change to the approval's buffer is caught), and checks them against the build, the session and the
 * request: the chain is the plan's, the delegate the pinned one and the build's, the relayer the build's, the account
 * the session's, the calls exactly the request's, the authorization nonce only with the approval that showed it, at
 * least SPONSOR_SEND_MIN_LEFT_S before the deadline. Throws VaultError; returns the decoded subject.
 */
export function approvedSubject(bytes: Uint8Array, shown: Uint8Array, plan: SponsorPlanInput, vaultNowMs: number): EvmSponsorSubject {
  if (!bytesEqual(bytes, shown)) throw notReady('changed');
  let s: EvmSponsorSubject;
  try {
    s = decodeSponsorSubject(bytes);
  } catch {
    throw notReady('decode');
  }
  const pinned = sponsorDelegate(s.chainId);
  if (s.chainId !== plan.chain.chainId || !pinned || pinned.placeholder || !sameAddress(s.delegate, pinned.address) || !sameAddress(s.delegate, plan.chain.delegate)) throw notReady('delegate');
  if (!sameAddress(s.relayer, plan.chain.relayer) || !sameAddress(s.account, plan.account)) throw notReady('relayer_or_account');
  if (s.calls.length !== plan.calls.length || s.calls.some((c, i) => !sameAddress(c.to, plan.calls[i]!.to) || c.value !== 0n || c.data !== plan.calls[i]!.data)) throw notReady('calls');
  if (s.deadline - BigInt(Math.floor(vaultNowMs / 1000)) < BigInt(SPONSOR_SEND_MIN_LEFT_S)) throw refusal(SPONSOR_TEXT.tooSlow, 'deadline_passed');
  return s;
}

export interface SponsorSignatures {
  /** The Execute's 65-byte r ‖ s ‖ v, `0x` hex. */
  signature: `0x${string}`;
  authorization: SignedAuthorization | null;
}

/**
 * The signatures for an approved subject, with one derivation of the EVM key (withChainKey zeroes it): the
 * authorization only when the subject carries an authorization nonce, then the Execute. Both through core's guarded
 * signers, `enabledChains` the build's (never the test-only placeholder option).
 */
export function signSponsored(prk: Uint8Array, s: EvmSponsorSubject, enabledChains: readonly number[]): SponsorSignatures {
  try {
    return withChainKey(prk, 'evm', 0, (d) => {
      const auth = sponsorSubjectAuthorization(s);
      const authorization = auth === null ? null : signAuthorization(d, auth, { enabledChains });
      const signature = signExecute(d, sponsorSubjectExecuteInput(s), { enabledChains });
      return { signature, authorization };
    });
  } catch {
    // The signers' refusals carry no input value, but the message is ours here.
    throw notReady('signer');
  }
}

/** The send body (without its session proof): every value from the decoded, approved subject. */
export function sendBody(s: EvmSponsorSubject, sig: SponsorSignatures): Record<string, unknown> {
  const a = sig.authorization;
  return {
    chainId: s.chainId,
    account: s.account,
    calls: s.calls.map((c) => ({ to: c.to, value: '0', data: c.data })),
    executeNonce: s.executeNonce.toString(),
    deadline: s.deadline.toString(),
    relayer: s.relayer,
    minGas: s.minGas.toString(),
    signature: sig.signature,
    ...(a ? { authorization: { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s } } : {}),
  };
}

/** The send answer: exactly `{transactionHash, status: 'executed'}` (lowercase hash), or null for any other shape. */
export function parseSendAnswer(v: unknown): { transactionHash: `0x${string}`; status: 'executed' } | null {
  if (!isObj(v) || v.status !== 'executed' || typeof v.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(v.transactionHash)) return null;
  if (v.replay !== undefined && v.replay !== true) return null;
  return { transactionHash: v.transactionHash.toLowerCase() as `0x${string}`, status: 'executed' };
}

// ---- the session binding (D856) ----

export interface SponsorProofContext {
  signer: string;
  appId: string;
  parentOrigin: string;
  sessionPublicKey: Uint8Array;
  issuedAtMs: number;
  /** The session's wallet proof of its EVM address (identity.ts), made at login while PRK was in memory. */
  walletProof: WalletProof;
}

/** `body` with its `sessionProof`: the session key's Ed25519 signature over the route, origin, app and body (D856). */
export async function withSessionProof(privateKey: CryptoKey, method: EvmSponsorRequestMethod, body: Record<string, unknown>, ctx: SponsorProofContext): Promise<Record<string, unknown>> {
  const nonce = crypto.getRandomValues(new Uint8Array(IDENTITY_NONCE_BYTES));
  const walletProof = { address: ctx.walletProof.address, signature: Uint8Array.from(ctx.walletProof.signature) };
  const message = evmSponsorSessionMessage(
    { signer: ctx.signer, appId: ctx.appId, parentOrigin: ctx.parentOrigin },
    { method, body, sessionPublicKey: ctx.sessionPublicKey, issuedAtMs: ctx.issuedAtMs, nonce, walletProof },
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message));
  const sessionProof: EvmSponsorSessionProof = {
    sessionPublicKey: Array.from(ctx.sessionPublicKey),
    issuedAtMs: ctx.issuedAtMs,
    nonce: Array.from(nonce),
    signature: Array.from(signature),
    walletProof: { address: walletProof.address, signature: Array.from(walletProof.signature) },
  };
  return { ...body, sessionProof };
}

// ---- the API's refusals, as port errors (D788's style: only exact-shape fields) ----

const MAX_RETRY_AFTER_S = 86_400;

/** The fields of an API refusal the page may see, each only in its exact shape. */
function refusalData(e: ApiError): Record<string, unknown> {
  const d = e.details;
  const retry = d.retryAfterS;
  const hash = d.transactionHash;
  const index = d.callIndex;
  return {
    status: e.status,
    ...(CODE_WORD.test(e.code) ? { reason: e.code } : {}),
    ...(Number.isSafeInteger(retry) && (retry as number) >= 0 && (retry as number) <= MAX_RETRY_AFTER_S ? { retryAfterS: retry } : {}),
    ...(typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(hash) ? { transactionHash: hash.toLowerCase() } : {}),
    ...(Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < 8 ? { callIndex: index } : {}),
    ...(d.retryable === true ? { retryable: true } : {}),
  };
}

/** The plain message for an API code (`setup`: the sent batch carried the one-time setup). */
function apiMessage(e: ApiError, setup: boolean): string {
  switch (e.code) {
    case 'reverted':
    case 'not_executed':
      return setup ? SPONSOR_TEXT.failedAfterSetup : SPONSOR_TEXT.failed;
    case 'simulation_reverted':
      return SPONSOR_TEXT.wouldFail;
    case 'timeout':
      return SPONSOR_TEXT.notConfirmed;
    case 'delegated_elsewhere':
      return SPONSOR_TEXT.delegatedElsewhere;
    case 'nonce_stale':
    case 'authorization_nonce_stale':
    case 'delegation_required':
      return SPONSOR_TEXT.accountChanged;
    case 'in_progress':
      return SPONSOR_TEXT.alreadySending;
    case 'account_unrecorded':
      return SPONSOR_TEXT.settingUp;
    case 'app_budget_exhausted':
    case 'budget_exhausted':
      return SPONSOR_TEXT.budgetUsed;
    case 'too_many_failures':
      return SPONSOR_TEXT.tooManyFailed;
    case 'rate_limited':
      return SPONSOR_TEXT.tooMany;
    case 'chain_not_enabled':
      return SPONSOR_TEXT.notOffered;
    case 'app_not_sponsored':
    case 'call_not_sponsored':
    case 'target_not_allowed':
    case 'value_not_allowed':
    case 'too_many_calls':
      return SPONSOR_TEXT.notForThis;
    case 'gas_too_high':
      return SPONSOR_TEXT.tooBig;
    case 'deadline_out_of_range':
      return SPONSOR_TEXT.tooSlow;
    case 'session_ended':
      return SPONSOR_TEXT.signInEnded;
    case 'sponsorship_paused':
      return SPONSOR_TEXT.paused;
    case 'gas_price_too_high':
      return SPONSOR_TEXT.feesHigh;
    case 'relayer_busy':
      return SPONSOR_TEXT.busyNow;
    case 'account_mismatch':
      return SPONSOR_TEXT.wrongAccount;
    case 'session_not_visible':
      return SPONSOR_TEXT.signInNotReady;
    case 'stale_session_proof':
      return SPONSOR_TEXT.tooSlow;
    case 'proof_replayed':
      return SPONSOR_TEXT.alreadySending;
    case 'missing_session_proof':
    case 'bad_session_proof':
    case 'invalid_session_signature':
    case 'bad_wallet_proof':
    case 'scope_mismatch':
      return SPONSOR_TEXT.signInUnchecked;
    case 'sponsorship_unconfigured':
      return SPONSOR_TEXT.notOffered;
    case 'relayer_unavailable':
    case 'evm_rpc_unavailable':
    case 'near_unavailable':
    case 'audit_unavailable':
    case 'directory_unavailable':
    case 'rate_limiter_unavailable':
    case 'config_unavailable':
      return SPONSOR_TEXT.unavailable;
    default:
      return e.status >= 500 ? SPONSOR_TEXT.unavailable : SPONSOR_TEXT.notReady;
  }
}

/**
 * An API failure of prepare or send as the port's error: 429 `rate_limited`, 410 `session_ended`, any other 4xx 4100,
 * a 5xx `api_unavailable`; `data` carries the HTTP status, the API's code as `reason`, and only in their exact shapes
 * `retryAfterS`, `transactionHash` (a sent batch's), `callIndex` and `retryable`; the request ID is added by the port
 * (D405). A failure with no answer (the network, the vault's timeout): for send the outcome is unknown, for prepare
 * nothing was sent. `setup`: the sent batch carried the one-time setup (a revert can't undo an applied authorization).
 */
export function sponsorApiError(e: unknown, method: EvmSponsorRequestMethod, setup = false): VaultError {
  if (!(e instanceof ApiError) || e.code === 'non_json_response' || e.code === 'bad_response') {
    if (method === 'send') return new VaultError('api_unavailable', SPONSOR_TEXT.unknownOutcome, { reason: 'unknown_outcome' }).fromRequest(e instanceof ApiError ? e : null);
    return new VaultError('api_unavailable', SPONSOR_TEXT.unavailable, { reason: 'api_unavailable' }).fromRequest(e instanceof ApiError ? e : null);
  }
  const data = refusalData(e);
  const message = apiMessage(e, setup);
  const code = e.status === 429 ? 'rate_limited' : e.code === 'session_ended' || e.status === 410 ? 'session_ended' : e.status >= 400 && e.status < 500 ? ErrorCode.unauthorized : 'api_unavailable';
  return new VaultError(code, message, data).fromRequest(e);
}

// ---- one sponsored action at a time per account ----

/** The cross-tab lock of one account's sponsored actions on one chain (the vault origin's Web Locks). */
export const sponsorLockName = (chainId: number, account: string): string => `hana-evm-sponsor:${chainId}:${account.toLowerCase()}`;

const busy = (): VaultError => new VaultError('busy', SPONSOR_TEXT.busy, { reason: 'sponsor_in_flight' });

/**
 * One sponsored action per account and chain at a time (D855): from the prepare to the send's answer, in this vault
 * (a set, checked before anything) and across the app's tabs and the vault origin's other frames (the shared lock,
 * `requestIfAvailable`). A second is refused (`busy`), not queued: the batch nonce is sequential, so a queued one would
 * be built on a nonce the first is about to use, and a page could stack approvals the user didn't ask for.
 */
export class SponsorFlights {
  readonly #accounts = new Set<string>();

  constructor(private readonly locks: Locks) {}

  has(chainId: number, account: string): boolean {
    return this.#accounts.has(sponsorLockName(chainId, account));
  }

  /** Runs `fn` holding the slot, or throws `busy`. */
  async run<T>(chainId: number, account: string, fn: () => Promise<T>): Promise<T> {
    const name = sponsorLockName(chainId, account);
    if (this.#accounts.has(name)) throw busy();
    this.#accounts.add(name);
    try {
      return await this.locks.requestIfAvailable(name, async (held) => {
        if (!held) throw busy();
        return fn();
      });
    } finally {
      this.#accounts.delete(name);
    }
  }
}
