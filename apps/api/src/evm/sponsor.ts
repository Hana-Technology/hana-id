// EVM gas sponsorship (D830–D848; docs/api.md "EVM gas sponsorship"): a Journear user's EVM account runs a batch of
// allowlisted calls through the EIP-7702 delegate (contracts/evm-delegate) while Journear's relayer pays the network
// fee, within daily budgets. Base Sepolia only for now, testnet only, not live until the founder deploys it.
//
// - POST /v1/evm/sponsor/prepare reads what the vault needs to sign: the account's delegation, its transaction nonce
//   and its delegate nonce, the relayer and implementation, the gas floor and deadline window. No signing here.
// - POST /v1/evm/sponsor/send takes the signed batch (and, for an account not yet delegated, its EIP-7702
//   authorization), checks everything in the order below, reserves the worst case, simulates, has the relayer Durable
//   Object send it and waits up to 30 s for the receipt.
//
// Both are the vault's only (D832: the vault submits; the signatures never reach the partner page), through the app
// gate `evm-sponsor` (publishable key, VAULT_ORIGIN acting for an allowed `x-hana-parent-origin`, the cross-app per-IP
// window). Without a readable EVM_SPONSOR, the EVM_RELAYER binding and EVM_RELAY_KEYS every route answers
// `503 sponsorship_unconfigured` before anything else is read (fail closed).
//
// send's order (stop at the first failure; cheap before chain reads, D847): the config and chain; the app has targets
// there; every call allowlisted (value 0, never the account, delegate, relayer or zero address, at most
// maxCallsPerBatch); relayer; minGas window; deadline window; the Execute signature recovers to the account; the
// authorization (chain, pinned delegate, signed by the account); the account's nonce floor and the digest's replay mark
// (a replay is answered from the audit row, never with a chain read); the directory (requireKnownAccount); the minute
// windows (account, app, env); the chain (code, pending nonce, base fee; then nonce() and the L1 fee bound); the
// delegation and both nonces; the gas limit; the fee; the digest's mark; the day windows (user, app, env); the user's
// failure slot; the worst case reserved from the app's and the env's day budget; the simulation at exactly the gas
// limit; the audit row; the relayer; the receipt; the settlement.
//
// SECURITY: nothing here logs an address, a signature, a digest, an authorization or an RPC URL (log() has no field
// for them); the request log has the app, the outcome, the code and phase times. An RPC's own error text is never
// echoed. A response carries only this app's own figures, never another app's or the env's spend.
import { encodeExecuteCalldata, SPONSOR_DELEGATES, type SignedAuthorization } from '@hana-id/core/evm-sponsor';
import { eventId } from '../changes/guard.ts';
import type { App } from '../apps.ts';
import type { Env } from '../env.ts';
import { appGate, type Ctx, done, lap, limiter, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { log } from '../log.ts';
import type { Limit } from '../rate-limiter.ts';
import { L1FeeUnavailable, l1FeeUpperBound, maxMinGasFor, receiptCostWei, sponsorFees, sponsorGasLimit, unsignedTxSizeBound, worstCaseWei } from './op-fee.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, parseEvmSponsorConfig, type PinnedSponsorDelegates, sponsorChain } from './sponsor-config.ts';
import {
  appSponsoredOn,
  authorizationRefusal,
  batchRefusal,
  callRefusal,
  classifyDelegation,
  type Delegation,
  designatorHex,
  EVM_SPONSOR_LIMITS,
  executedIn,
  executeInput,
  NONCE_CALLDATA,
  revertDetails,
  type SendRequest,
  toPrepareRequest,
  toSendRequest,
  uintReturn,
  verifiedDigest,
} from './sponsor-checks.ts';
import {
  type EvmRelayerPort,
  type EvmRelayerSendResult,
  type Hex,
  keccakHex,
  pendingAgeMs,
  relayerBinding,
  relayerRefusal,
  revertOf,
  type SponsorChainPort,
  type SponsorReceipt,
  SponsorRpcError,
  sponsorPorts,
} from './sponsor-ports.ts';

export const EVM_SPONSOR_PREPARE_ENDPOINT = '/v1/evm/sponsor/prepare';
export const EVM_SPONSOR_SEND_ENDPOINT = '/v1/evm/sponsor/send';
export const EVM_SPONSOR_STATUS_ENDPOINT = '/v1/evm/sponsor/status';
export const EVM_SPONSOR_ENDPOINTS: readonly string[] = [EVM_SPONSOR_PREPARE_ENDPOINT, EVM_SPONSOR_SEND_ENDPOINT, EVM_SPONSOR_STATUS_ENDPOINT];

/** 8 calls of 8 KiB of data, as hex, with the rest of the body: well under 140 000 bytes. */
const MAX_BODY = 140_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;

/** The receipt wait (the handler polls; nothing holds a lock meanwhile). Mutable for the tests. */
export const sponsorTiming = { receiptWaitMs: 30_000, receiptPollMs: 1_500 };

type Step<T> = { ok: true; value: T } | { ok: false; response: Response };

// ---- configuration ----

/**
 * The pinned delegate table every chain's `delegate` must match (D834): core's SPONSOR_DELEGATES. Tests of a chain core
 * has no entry for yet (Base Sepolia's OP Stack fee) replace it with a fixture table and put it back; nothing else does.
 */
export const sponsorPins: { table: PinnedSponsorDelegates } = { table: SPONSOR_DELEGATES };

let parsed: { key: string; table: PinnedSponsorDelegates; config: EvmSponsorConfig | null } | null = null;

/** The parsed config (cached per isolate on the var, network, env name and pinned table), or null when absent or refused. */
export function evmSponsorConfig(env: Env): EvmSponsorConfig | null {
  const key = `${env.EVM_SPONSOR ?? ''}\u0000${env.NETWORK}\u0000${env.ENV_NAME}`;
  if (parsed?.key !== key || parsed.table !== sponsorPins.table) {
    const s = parseEvmSponsorConfig(env.EVM_SPONSOR, { network: env.NETWORK, envName: env.ENV_NAME, pinnedDelegates: sponsorPins.table });
    if (s.status === 'unconfigured' && s.reason === 'invalid') log({ event: 'evm_sponsor_config', outcome: 'error', code: 'evm_sponsor_invalid' }, 'error');
    parsed = { key, table: sponsorPins.table, config: s.status === 'configured' ? s.config : null };
  }
  return parsed.config;
}

/**
 * Sponsorship is on when the config parses, the Worker has the relayer binding and the relayer key secret is set (the
 * relayer object checks the key itself; this only reads that it is present). Else every route is
 * `503 sponsorship_unconfigured`.
 */
export function evmSponsorReady(env: Env): EvmSponsorConfig | null {
  if (!relayerBinding(env) || !env.EVM_RELAY_KEYS) return null;
  return evmSponsorConfig(env);
}

export const unconfigured = (ctx: Ctx): Response => reject(ctx, 503, 'sponsorship_unconfigured', 'EVM gas sponsorship is not configured');

// ---- limiter subjects ----

const accountSubject = (chainId: number, account: Hex) => `evm-sponsor:account:${chainId}:${account.toLowerCase()}`;
const appSubject = (app: App) => `app:${app.id}`;
const envSubject = (chainId: number) => `evm-sponsor:global:${chainId}`;
const userSubject = (userId: string) => `evm-sponsor:user:${userId}`;
/** The env's day budget lives on its own object (read by the status route and the admin later). */
export const envBudgetSubject = (chainId: number) => `evm-sponsor:budget:${chainId}`;
/** The day budget's window, on `app:<id>` and on the env's budget object. */
export const budgetWindow = (chainId: number) => `evm-sponsor:${chainId}:wei`;
/** The account's nonce floor: the lowest executeNonce not yet known to be used (RateLimiter.floor). */
const NONCE_FLOOR = 'evm-sponsor:nonce';
const FAILURES = 'evm-sponsor:failures';
/** The failed-send count's object: the user's (across chains), or the account's on the chain without a directory user. */
const failureSubject = (chainId: number, account: Hex, userId: string | null) => (userId ? `evm-sponsor:failures:${userId}` : `evm-sponsor:failures:${chainId}:${account.toLowerCase()}`);

interface Window {
  subject: string;
  limits: Limit[];
  what: string;
}

/** Asks each window in turn; a later refusal takes the hit back from the earlier ones. Null when all accept. */
async function quota(env: Env, ctx: Ctx, windows: Window[], now: number): Promise<Response | null> {
  const taken: Window[] = [];
  try {
    for (const w of windows) {
      const hit = await limiter(env, w.subject).hit(w.limits, now);
      if (!hit.ok) {
        await Promise.all(taken.map((t) => limiter(env, t.subject).unhit(t.limits, now)));
        return done(ctx, 429, { error: `Rate limit exceeded (${w.what})`, code: 'rate_limited', retryAfterS: hit.retryAfterS }, { 'retry-after': String(hit.retryAfterS) });
      }
      taken.push(w);
    }
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  return null;
}

const giveBack = (env: Env, windows: Window[], at: number): Promise<void> =>
  Promise.all(windows.map((w) => limiter(env, w.subject).unhit(w.limits, at))).then(
    () => undefined,
    () => undefined,
  );

// ---- the wallet directory (requireKnownAccount, D847) ----

/**
 * The internal id (`hu_…`) of the one user of `scopeId` whose wallet directory lists `account` as an EVM wallet, or
 * null: none does, or two or more do (ambiguous, logged; never resolved by a time a client chose). The directory is per
 * scope, so a user of another app of the same scope counts (as the NEAR relay's D735); an account known only in another
 * scope is not found. A failed read throws.
 */
export async function evmAccountUser(db: D1Database, scopeId: string, account: Hex): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT w.user_id FROM end_user_wallets w JOIN end_users u ON u.user_id = w.user_id
        WHERE w.address = ?1 AND w.chain = 'evm' AND u.scope_id = ?2 LIMIT 2`,
    )
    .bind(account, scopeId)
    .all<{ user_id: string }>();
  if (results.length > 1) {
    log({ event: 'evm_account_ambiguous', code: 'two_users' }, 'error');
    return null;
  }
  return results[0]?.user_id ?? null;
}

/** Tests may replace the lookup; nothing else does. */
export const evmDirectory: { lookup: typeof evmAccountUser } = { lookup: evmAccountUser };

/** With requireKnownAccount: the account's user, or `409 account_unrecorded` (retryable) / `503 directory_unavailable`. */
async function knownUser(env: Env, ctx: Ctx, app: App, chain: Readonly<EvmSponsorChainConfig>, account: Hex): Promise<Step<string | null>> {
  if (!chain.requireKnownAccount) return { ok: true, value: null };
  let userId: string | null;
  try {
    userId = await evmDirectory.lookup(env.DB, app.scope_id, account);
  } catch {
    return { ok: false, response: reject(ctx, 503, 'directory_unavailable', 'The wallet directory is unavailable, try again') };
  }
  lap(ctx, 'directory');
  if (!userId) return { ok: false, response: done(ctx, 409, { error: 'This account is not recorded for a user of this app (yet): sign in, then retry', code: 'account_unrecorded', retryable: true, retryAfterS: 2 }, { 'retry-after': '2' }) };
  return { ok: true, value: userId };
}

// ---- chain reads ----

const rpcDown = (ctx: Ctx): Response => reject(ctx, 502, 'evm_rpc_unavailable', 'Could not read the chain, try again');

/** The delegate nonce: `nonce()` on the account, run as the delegate (a state override) when it has no code yet. */
async function delegateNonce(chain: SponsorChainPort, account: Hex, delegation: Delegation, cfg: Readonly<EvmSponsorChainConfig>): Promise<bigint | null> {
  if (delegation === 'other') return null;
  const r = await chain.call({ from: account, to: account, data: NONCE_CALLDATA }, delegation === 'none' ? { stateOverride: { [account]: { code: designatorHex(cfg.delegate) } } } : {});
  const n = uintReturn(r.toLowerCase() as Hex);
  if (n === null) throw new SponsorRpcError('bad_response');
  return n;
}

// ---- budgets ----

/** The day's worst case for the cheapest batch this app could send (at the minGas floor, the fee cap, no L1). */
function floorWorstCase(chain: Readonly<EvmSponsorChainConfig>): bigint {
  const limit = sponsorGasLimit({ calldata: '0x', callData: ['0x00000000'], minGas: chain.minGas, authorizations: 0 });
  return limit * chain.maxFeePerGasWei;
}

/** The app's and the env's day spend so far (read only). */
export async function budgetsSpent(env: Env, app: App, chainId: number, now: number): Promise<{ app: bigint; env: bigint }> {
  const [a, e] = await Promise.all([limiter(env, appSubject(app)).spent(budgetWindow(chainId), DAY, now), limiter(env, envBudgetSubject(chainId)).spent(budgetWindow(chainId), DAY, now)]);
  return { app: BigInt(a), env: BigInt(e) };
}

/** Whether a further batch fits in both day budgets (prepare's and status's `budget_exhausted`). */
export function budgetLeft(chain: Readonly<EvmSponsorChainConfig>, spent: { app: bigint; env: bigint }): boolean {
  const need = floorWorstCase(chain);
  return chain.appDailyBudgetWei - spent.app >= need && chain.dailyBudgetWei - spent.env >= need;
}

/**
 * Takes the worst case from the app's day budget, then the env's; a refusal by the env's gives the app's back. Each
 * `spend` is atomic in its object, so concurrent requests can never take more than a budget holds. Writes the day's
 * `evm_relay_budget_high` past budgetAlertPct.
 */
async function reserveBudget(env: Env, ctx: Ctx, app: App, chain: Readonly<EvmSponsorChainConfig>, amount: bigint, now: number): Promise<Step<null>> {
  const name = budgetWindow(chain.chainId);
  let r;
  try {
    const a = await limiter(env, appSubject(app)).spend(name, DAY, chain.appDailyBudgetWei.toString(), amount.toString(), now);
    if (!a.ok) return { ok: false, response: done(ctx, 429, { error: "This app's daily sponsorship budget is used up, try again later", code: 'app_budget_exhausted', retryAfterS: a.retryAfterS }, { 'retry-after': String(a.retryAfterS) }) };
    r = await limiter(env, envBudgetSubject(chain.chainId)).spend(name, DAY, chain.dailyBudgetWei.toString(), amount.toString(), now);
    if (!r.ok) await limiter(env, appSubject(app)).giveBack(name, DAY, amount.toString(), now);
  } catch {
    return { ok: false, response: reject(ctx, 503, 'rate_limiter_unavailable', 'Try again') };
  }
  const spent = BigInt(r.spent);
  if (spent * 100n >= chain.dailyBudgetWei * BigInt(EVM_SPONSOR_LIMITS.budgetAlertPct)) await noteEvent(env, ctx, 'evm_relay_budget_high', [String(chain.chainId), utcDay(now)], { day: utcDay(now), chainId: chain.chainId, spentWei: spent.toString(), budgetWei: chain.dailyBudgetWei.toString(), thresholdPct: EVM_SPONSOR_LIMITS.budgetAlertPct }, now);
  if (!r.ok) return { ok: false, response: done(ctx, 429, { error: 'The daily sponsorship budget is used up, try again later', code: 'budget_exhausted', retryAfterS: r.retryAfterS }, { 'retry-after': String(r.retryAfterS) }) };
  return { ok: true, value: null };
}

/** Settles a reservation: what wasn't spent comes back, a spend above it is charged, on both budgets. Never throws. */
async function settleBudget(env: Env, app: App, chainId: number, reserved: bigint, spent: bigint, at: number): Promise<void> {
  const diff = reserved - spent;
  if (diff === 0n) return;
  const name = budgetWindow(chainId);
  const subjects = [appSubject(app), envBudgetSubject(chainId)];
  try {
    if (diff > 0n) await Promise.all(subjects.map((s) => limiter(env, s).giveBack(name, DAY, diff.toString(), at)));
    else await Promise.all(subjects.map((s) => limiter(env, s).charge(name, DAY, (-diff).toString(), at)));
  } catch {
    // A failed give-back leaves the count high (the budget errs on the side of spending less); a failed charge is lost.
  }
}

const utcDay = (now: number): string => new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10);

/** One security event per fixed id (`kind` and `idParts`). Amounts and chain ids only. Never throws. */
export async function noteEvent(env: Env, ctx: Pick<Ctx, 'requestId' | 'endpoint'> | null, kind: 'evm_relay_budget_high' | 'evm_relay_balance_low' | 'evm_relay_stuck', idParts: string[], detail: Record<string, unknown>, now: number): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, ?3, ?4)')
      .bind(await eventId(kind, ...idParts), now, kind, JSON.stringify(detail))
      .run();
  } catch {
    log({ event: 'evm_sponsor_alert_failed', requestId: ctx?.requestId, endpoint: ctx?.endpoint, code: kind }, 'warn');
  }
}

// ---- the audit row (D848) ----

export type SendStatus = 'sending' | 'sent' | 'executed' | 'reverted' | 'not_executed' | 'timeout' | 'unknown' | 'refused';

interface AuditRow {
  id: string;
  app: App;
  chainId: number;
  account: Hex;
  userId: string | null;
  digest: Hex;
  executeNonce: bigint;
  reservedWei: bigint;
  requestId: string;
  at: number;
}

async function insertAudit(env: Env, r: AuditRow): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT INTO evm_sponsor_sends (id, app_id, chain_id, account, user_id, digest, execute_nonce, reserved_wei, status, request_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'sending', ?9, ?10, ?10)`,
    )
      .bind(r.id, r.app.id, r.chainId, r.account, r.userId, r.digest, r.executeNonce.toString(), r.reservedWei.toString(), r.requestId, r.at)
      .run();
    return true;
  } catch {
    log({ event: 'evm_sponsor_audit_failed', requestId: r.requestId, endpoint: EVM_SPONSOR_SEND_ENDPOINT, code: 'insert' }, 'error');
    return false;
  }
}

async function updateAudit(env: Env, id: string, ctx: Ctx, f: { status: SendStatus; txHash?: Hex; relayerNonce?: number; settledWei?: bigint }): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE evm_sponsor_sends SET status = ?2, tx_hash = COALESCE(?3, tx_hash), relayer_nonce = COALESCE(?4, relayer_nonce),
         settled_wei = COALESCE(?5, settled_wei), updated_at = ?6 WHERE id = ?1`,
    )
      .bind(id, f.status, f.txHash ?? null, f.relayerNonce ?? null, f.settledWei?.toString() ?? null, Date.now())
      .run();
  } catch {
    log({ event: 'evm_sponsor_audit_failed', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'update' }, 'error');
  }
}

/**
 * A replay's answer from its audit row (this app's, this chain's, this digest's latest), never from the chain: executed
 * is the same 200 (idempotent), a mined failure the same 422, a send still waiting its 504 with the hash, one in flight
 * `409 in_progress`. Null when there is no row (or it can't be read): the caller answers as a stale nonce.
 */
async function replayAnswer(env: Env, ctx: Ctx, app: App, chainId: number, digest: Hex): Promise<Response | null> {
  let row: { status: SendStatus; tx_hash: string | null } | null;
  try {
    row = await env.DB.prepare('SELECT status, tx_hash FROM evm_sponsor_sends WHERE chain_id = ?1 AND digest = ?2 AND app_id = ?3 ORDER BY created_at DESC LIMIT 1')
      .bind(chainId, digest, app.id)
      .first<{ status: SendStatus; tx_hash: string | null }>();
  } catch {
    return null;
  }
  if (!row) return null;
  const hash = row.tx_hash && /^0x[0-9a-f]{64}$/u.test(row.tx_hash) ? (row.tx_hash as Hex) : null;
  if (row.status === 'executed' && hash) return done(ctx, 200, { transactionHash: hash, status: 'executed', replay: true });
  if ((row.status === 'reverted' || row.status === 'not_executed') && hash) return failed(ctx, row.status, hash);
  if ((row.status === 'sent' || row.status === 'timeout') && hash) return done(ctx, 504, { error: 'Sent, not confirmed yet: look the transaction up by its hash', code: 'timeout', transactionHash: hash });
  return inProgress(ctx);
}

const inProgress = (ctx: Ctx): Response => done(ctx, 409, { error: 'This batch is being sent, try again shortly', code: 'in_progress', retryable: true, retryAfterS: 2 }, { 'retry-after': '2' });

function failed(ctx: Ctx, code: 'reverted' | 'not_executed', transactionHash: Hex): Response {
  const error = code === 'reverted' ? 'The transaction reverted on chain' : 'The transaction ran but the batch did not execute';
  return done(ctx, 422, { error, code, transactionHash });
}

// ---- the relayer ----

/** A send result the handler can use: a 32-byte hash that is the raw transaction's keccak, a nonce. Else null. */
function checkedResult(r: unknown): EvmRelayerSendResult | null {
  if (typeof r !== 'object' || r === null) return null;
  const v = r as Record<string, unknown>;
  if (typeof v.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(v.transactionHash)) return null;
  if (typeof v.raw !== 'string' || v.raw.length > 2 + 2 * 200_000 || !/^0x([0-9a-fA-F]{2})+$/u.test(v.raw)) return null;
  if (typeof v.relayerNonce !== 'number' || !Number.isSafeInteger(v.relayerNonce) || v.relayerNonce < 0 || typeof v.replay !== 'boolean') return null;
  const hash = v.transactionHash.toLowerCase() as Hex;
  if (keccakHex(v.raw.toLowerCase() as Hex) !== hash) return null;
  return { transactionHash: hash, relayerNonce: v.relayerNonce, raw: v.raw as Hex, replay: v.replay };
}

/** At most this many of a digest's hashes are polled (the newest: the relayer replaces with higher fees, then cancels). */
const POLLED_HASHES = 4;

/**
 * Polls for up to `sponsorTiming.receiptWaitMs` for the receipt of any transaction the relayer signed for this digest:
 * the hash it answered and every later one `lookup` lists (a fee bump or a deadline cancel replaces the transaction at
 * the same nonce). The first receipt found is the one mined. RPC and lookup failures in between are retried. Null on
 * timeout.
 */
async function waitForReceipt(chain: SponsorChainPort, relayer: EvmRelayerPort, digest: Hex, first: Hex): Promise<SponsorReceipt | null> {
  const end = Date.now() + sponsorTiming.receiptWaitMs;
  for (;;) {
    let hashes: Hex[] = [first];
    try {
      const l = await relayer.lookup(digest);
      const listed = Array.isArray(l?.hashes) ? l.hashes.filter((h): h is Hex => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(h)).map((h) => h.toLowerCase() as Hex) : [];
      hashes = [...new Set([first, ...listed.slice(-POLLED_HASHES)])];
    } catch {
      // the answered hash alone
    }
    for (const hash of hashes) {
      try {
        const r = await chain.receipt(hash);
        if (r && r.transactionHash.toLowerCase() === hash) return r;
      } catch {
        // the next hash, the next poll
      }
    }
    if (Date.now() + sponsorTiming.receiptPollMs > end) return null;
    await new Promise((resolve) => setTimeout(resolve, sponsorTiming.receiptPollMs));
  }
}

/** The answer to a relayer refusal (it sent nothing): its code, never its reason text but a known one. */
function refusalAnswer(ctx: Ctx, code: string, reason: string | null): Response {
  switch (code) {
    case 'relayer_unconfigured':
    case 'relayer_misconfigured':
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code }, 'error');
      return unconfigured(ctx);
    case 'relayer_busy':
      return done(ctx, 503, { error: 'The relayer is busy, try again', code: 'relayer_busy', retryAfterS: 2 }, { 'retry-after': '2' });
    case 'rpc_unavailable':
      return rpcDown(ctx);
    case 'deadline_passed':
      return reject(ctx, 400, 'deadline_out_of_range', 'deadline is out of range');
    case 'rejected':
      // insufficient_funds is the relayer's balance: logged for the operator, answered as the relayer's problem.
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code: reason === 'insufficient_funds' ? 'relayer_balance_short' : 'rejected' }, 'error');
      return done(ctx, 503, { error: 'The network refused the transaction, try again later', code: 'relayer_rejected', retryAfterS: 30 }, { 'retry-after': '30' });
    default:
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'relayer_error' }, 'error');
      return reject(ctx, 503, 'relayer_unavailable', 'The relayer is unavailable, try again', { 'retry-after': '2' });
  }
}

// ---- POST /v1/evm/sponsor/prepare ----

export async function handleEvmSponsorPrepare(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, EVM_SPONSOR_PREPARE_ENDPOINT, request);
  const config = evmSponsorReady(env);
  if (!config) return unconfigured(ctx);
  const gate = await appGate(request, env, ctx, 'evm-sponsor');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return reject(ctx, body.status, 'bad_request', body.error);
  const req = toPrepareRequest(body.body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Not a sponsorship prepare request');
  const chain = sponsorChain(config, req.chainId);
  if (!chain) return reject(ctx, 400, 'chain_not_enabled', 'Sponsorship is not enabled on this chain');
  if (!appSponsoredOn(config, app.id, chain.chainId)) return reject(ctx, 403, 'app_not_sponsored', 'This app has no sponsored calls on this chain');
  const refusal = callRefusal(config, chain, app.id, req.account, req.calls);
  if (refusal) return callRefusalAnswer(ctx, refusal);
  lap(ctx, 'checks');

  let userId: string | null = null;
  if (chain.requireKnownAccount) {
    try {
      userId = await evmDirectory.lookup(env.DB, app.scope_id, req.account);
    } catch {
      return reject(ctx, 503, 'directory_unavailable', 'The wallet directory is unavailable, try again');
    }
    lap(ctx, 'directory');
  }
  const now = Date.now();
  const pre = await quota(
    env,
    ctx,
    [
      { subject: accountSubject(chain.chainId, req.account), limits: [{ name: 'evm-sponsor:prepare:minute', windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.preparesPerAccountPerMinute }], what: 'per account per minute' },
      { subject: appSubject(app), limits: [{ name: `evm-sponsor:${chain.chainId}:prepare:minute`, windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.preparesPerAppPerMinute }], what: 'per app' },
    ],
    now,
  );
  if (pre) return pre;

  const rpc = sponsorPorts.chain(env, chain);
  let delegation: Delegation;
  let accountNonce: bigint;
  let executeNonce: bigint | null;
  try {
    const [code, pending] = await Promise.all([rpc.code(req.account), rpc.transactionCount(req.account, 'pending')]);
    delegation = classifyDelegation(code.toLowerCase() as Hex, chain.delegate);
    accountNonce = BigInt(pending);
    executeNonce = await delegateNonce(rpc, req.account, delegation, chain);
  } catch {
    return rpcDown(ctx);
  }
  lap(ctx, 'chain');

  let spent: { app: bigint; env: bigint };
  let failures: bigint;
  try {
    [spent, failures] = await Promise.all([budgetsSpent(env, app, chain.chainId, now), limiter(env, failureSubject(chain.chainId, req.account, userId)).spent(FAILURES, DAY, now).then(BigInt)]);
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const reason =
    delegation === 'other' ? 'delegated_elsewhere' : chain.requireKnownAccount && !userId ? 'account_unrecorded' : failures >= BigInt(EVM_SPONSOR_LIMITS.failuresPerUserPerDay) ? 'too_many_failures' : !budgetLeft(chain, spent) ? 'budget_exhausted' : null;
  // The largest minGas whose gas limit fits maxGasPerTx for these calls (with the authorization when one is needed).
  const shapeCalldata = encodeExecuteCalldata(
    { chainId: chain.chainId, account: req.account, implementation: chain.delegate as Hex, calls: req.calls, nonce: executeNonce ?? 0n, deadline: BigInt(Math.floor(now / 1000) + chain.deadlineMaxS), relayer: config.relayerAddress as Hex, minGas: chain.maxGasPerTx },
    `0x${'11'.repeat(64)}1b`,
  );
  const maxMinGas = maxMinGasFor({ calldata: shapeCalldata, callData: req.calls.map((c) => c.data), authorizations: delegation === 'none' ? 1 : 0 }, chain.maxGasPerTx);
  return done(ctx, 200, {
    delegation,
    accountNonce: accountNonce.toString(),
    executeNonce: executeNonce === null ? null : executeNonce.toString(),
    serverNow: Math.floor(now / 1000),
    relayer: config.relayerAddress,
    implementation: chain.delegate,
    minGasFloor: chain.minGas.toString(),
    maxMinGas: maxMinGas.toString(),
    deadlineMaxS: chain.deadlineMaxS,
    allowed: reason === null && maxMinGas >= chain.minGas,
    ...(reason ? { reason } : maxMinGas < chain.minGas ? { reason: 'gas_too_high' } : {}),
  });
}

function callRefusalAnswer(ctx: Ctx, r: NonNullable<ReturnType<typeof callRefusal>>): Response {
  switch (r.code) {
    case 'too_many_calls':
      return done(ctx, 400, { error: 'Too many calls in one batch', code: 'too_many_calls', maxCalls: r.maxCalls });
    case 'value_not_allowed':
      return done(ctx, 403, { error: 'A sponsored call carries no value', code: 'value_not_allowed', callIndex: r.callIndex });
    case 'target_not_allowed':
      return done(ctx, 403, { error: 'A sponsored call cannot target the account, the delegate, the relayer or the zero address', code: 'target_not_allowed', callIndex: r.callIndex });
    case 'call_not_sponsored':
      return done(ctx, 403, { error: 'This call is not sponsored for this app', code: 'call_not_sponsored', callIndex: r.callIndex });
  }
}

// ---- POST /v1/evm/sponsor/send ----

export async function handleEvmSponsorSend(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, EVM_SPONSOR_SEND_ENDPOINT, request);
  const config = evmSponsorReady(env);
  if (!config) return unconfigured(ctx);
  const gate = await appGate(request, env, ctx, 'evm-sponsor');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return reject(ctx, body.status, 'bad_request', body.error);
  const req = toSendRequest(body.body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Not a sponsorship send request');

  // 1. The chain, the app and every call (the allowlist).
  const chain = sponsorChain(config, req.chainId);
  if (!chain) return reject(ctx, 400, 'chain_not_enabled', 'Sponsorship is not enabled on this chain');
  if (!appSponsoredOn(config, app.id, chain.chainId)) return reject(ctx, 403, 'app_not_sponsored', 'This app has no sponsored calls on this chain');
  const refusal = callRefusal(config, chain, app.id, req.account, req.calls);
  if (refusal) return callRefusalAnswer(ctx, refusal);
  // 2. The relayer, the gas floor, the deadline.
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const batch = batchRefusal(config, chain, req, nowS);
  if (batch?.code === 'wrong_relayer') return reject(ctx, 400, 'wrong_relayer', "relayer must be the sponsorship's relayer");
  if (batch?.code === 'min_gas_out_of_range') return done(ctx, 400, { error: 'minGas is out of range', code: 'min_gas_out_of_range', minGasFloor: batch.minGasFloor.toString(), maxGas: batch.maxGas.toString() });
  if (batch?.code === 'deadline_out_of_range') return done(ctx, 400, { error: 'deadline is out of range', code: 'deadline_out_of_range', serverNow: Number(batch.serverNow), deadlineMaxS: batch.deadlineMaxS });
  // 3. The signatures: the Execute by the account, over the pinned implementation; the authorization, if any.
  const input = executeInput(chain, req);
  const digest = verifiedDigest(input, req.signature);
  if (!digest) return reject(ctx, 401, 'invalid_signature', "The batch's signature is not the account's");
  if (req.authorization) {
    const a = authorizationRefusal(chain, req.account, req.authorization);
    if (a?.code === 'bad_authorization') return reject(ctx, 400, 'bad_authorization', "The authorization is not for this chain");
    if (a?.code === 'authorization_not_pinned') return reject(ctx, 403, 'authorization_not_pinned', 'The authorization must name the pinned delegate');
    if (a?.code === 'invalid_authorization_signature') return reject(ctx, 401, 'invalid_authorization_signature', "The authorization's signature is not the account's");
  }
  lap(ctx, 'checks');
  return sendChecked(env, ctx, app, config, chain, req, digest);
}

async function sendChecked(env: Env, ctx: Ctx, app: App, config: EvmSponsorConfig, chain: Readonly<EvmSponsorChainConfig>, req: SendRequest, digest: Hex): Promise<Response> {
  const relayer = sponsorPorts.relayer(env, chain.chainId);
  if (!relayer) return unconfigured(ctx);
  const account = accountSubject(chain.chainId, req.account);
  // 4. Replays, before any count or chain read: an executeNonce below the account's floor, or a digest marked as sent,
  //    is answered from its audit row (or as stale). A signed batch is public once on chain; re-posting it costs nothing.
  try {
    const floor = BigInt(await limiter(env, account).floor(NONCE_FLOOR));
    if (req.executeNonce < floor) return (await replayAnswer(env, ctx, app, chain.chainId, digest)) ?? done(ctx, 409, { error: 'The batch nonce is already used', code: 'nonce_stale', executeNonce: floor.toString() });
    const t = Date.now();
    if (!(await limiter(env, account).reserve(digest, t, t))) return (await replayAnswer(env, ctx, app, chain.chainId, digest)) ?? inProgress(ctx);
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  // 5. The directory.
  const known = await knownUser(env, ctx, app, chain, req.account);
  if (!known.ok) return known.response;
  const userId = known.value;
  // 6. The minute windows (only a batch signed by the account's key gets here).
  const minute: Window[] = [
    { subject: account, limits: [{ name: 'evm-sponsor:send:minute', windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.sendsPerAccountPerMinute }], what: 'per account per minute' },
    { subject: appSubject(app), limits: [{ name: `evm-sponsor:${chain.chainId}:minute`, windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.sendsPerAppPerMinute }], what: 'per app' },
    { subject: envSubject(chain.chainId), limits: [{ name: 'evm-sponsor:minute', windowMs: MINUTE, max: chain.sendsPerMinute }], what: 'across the env' },
  ];
  const minuteAt = Date.now();
  const m = await quota(env, ctx, minute, minuteAt);
  if (m) return m;

  // 7. The chain: the account's code and pending nonce and the base fee; then its delegate nonce and the L1 fee bound.
  const rpc = sponsorPorts.chain(env, chain);
  let delegation: Delegation;
  let pending: bigint;
  let baseFee: bigint;
  try {
    const [code, p, b] = await Promise.all([rpc.code(req.account), rpc.transactionCount(req.account, 'pending'), rpc.latestBlock()]);
    delegation = classifyDelegation(code.toLowerCase() as Hex, chain.delegate);
    pending = BigInt(p);
    baseFee = b.baseFeePerGas;
  } catch {
    return rpcDown(ctx);
  }
  // 8. The delegation (D840: delegated elsewhere is refused) and the authorization's place.
  if (delegation === 'other') return reject(ctx, 409, 'delegated_elsewhere', 'This account is delegated to another contract: sponsorship is not available for it');
  if (delegation === 'none' && !req.authorization) return reject(ctx, 409, 'delegation_required', 'This account needs the one-time setup: sign the authorization too');
  const authorization: SignedAuthorization | null = delegation === 'journear' ? null : req.authorization;
  if (authorization && authorization.nonce !== pending) return done(ctx, 409, { error: "The authorization's nonce is not the account's", code: 'authorization_nonce_stale', accountNonce: pending.toString() });
  const calldata = encodeExecuteCalldata(executeInput(chain, req), req.signature);
  const authorizations = authorization ? 1 : 0;
  let chainNonce: bigint | null;
  let l1Bound: bigint;
  try {
    [chainNonce, l1Bound] = await Promise.all([delegateNonce(rpc, req.account, delegation, chain), l1FeeUpperBound(rpc, chain.opStack, config.relayerAddress as Hex, unsignedTxSizeBound((calldata.length - 2) / 2, authorizations))]);
  } catch (e) {
    if (e instanceof L1FeeUnavailable) log({ event: 'evm_sponsor_l1_fee', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'l1_fee_unavailable' }, 'error');
    return rpcDown(ctx);
  }
  lap(ctx, 'chain');
  if (chainNonce === null) return rpcDown(ctx);
  if (req.executeNonce !== chainNonce) {
    if (req.executeNonce < chainNonce) {
      // Used on chain: the floor rises to the chain's nonce (this batch and every older one are dropped before any count
      // from now on) and the minute windows come back (a public batch may get this far once).
      try {
        await limiter(env, account).raiseFloor(NONCE_FLOOR, chainNonce.toString());
      } catch {
        return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again', { 'retry-after': '1' });
      }
      await giveBack(env, minute, minuteAt);
    }
    return done(ctx, 409, { error: 'The batch nonce is not the account’s next', code: 'nonce_stale', executeNonce: chainNonce.toString() });
  }

  // 9. Gas and fees.
  const gasLimit = sponsorGasLimit({ calldata, callData: req.calls.map((c) => c.data), minGas: req.minGas, authorizations });
  if (gasLimit > chain.maxGasPerTx) return done(ctx, 403, { error: 'The batch needs more gas than one sponsored transaction may use', code: 'gas_too_high', maxGas: chain.maxGasPerTx.toString() });
  const fees = sponsorFees(baseFee, chain.maxPriorityFeePerGasWei, chain.maxFeePerGasWei);
  if (!fees.ok) return done(ctx, 503, { error: 'Network fees are too high right now, try again later', code: 'gas_price_too_high', retryAfterS: 30 }, { 'retry-after': '30' });
  const reserved = worstCaseWei(gasLimit, fees.maxFeePerGas, l1Bound);

  // 10. The digest's mark: from here on a copy (concurrent or later) is answered from the audit row, never counted twice.
  const markedAt = Date.now();
  const markUntil = Number(req.deadline) * 1000 + 2 * MINUTE;
  try {
    if (!(await limiter(env, account).reserve(digest, markUntil, markedAt))) return (await replayAnswer(env, ctx, app, chain.chainId, digest)) ?? inProgress(ctx);
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const unmark = () => limiter(env, account).release(digest).catch(() => undefined);
  // 11. The day windows (user, app, env), then the user's failure slot (a send that fails keeps it).
  const day: Window[] = [
    ...(userId ? [{ subject: userSubject(userId), limits: [{ name: `evm-sponsor:${chain.chainId}:day`, windowMs: DAY, max: chain.perUserPerDay }], what: 'per user' }] : []),
    { subject: appSubject(app), limits: [{ name: `evm-sponsor:${chain.chainId}:day`, windowMs: DAY, max: chain.perAppPerDay }], what: 'per app' },
    { subject: envSubject(chain.chainId), limits: [{ name: 'evm-sponsor:day', windowMs: DAY, max: chain.sendsPerDay }], what: 'across the env' },
  ];
  const dayAt = Date.now();
  const d = await quota(env, ctx, day, dayAt);
  if (d) {
    await unmark();
    return d;
  }
  const failures = failureSubject(chain.chainId, req.account, userId);
  const failureAt = Date.now();
  let slot;
  try {
    slot = await limiter(env, failures).spend(FAILURES, DAY, String(EVM_SPONSOR_LIMITS.failuresPerUserPerDay), '1', failureAt);
  } catch {
    await Promise.all([unmark(), giveBack(env, day, dayAt)]);
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  if (!slot.ok) {
    await Promise.all([unmark(), giveBack(env, day, dayAt)]);
    return done(ctx, 429, { error: 'Too many failed sponsored actions today, try again tomorrow', code: 'too_many_failures', retryAfterS: slot.retryAfterS }, { 'retry-after': String(slot.retryAfterS) });
  }
  const freeSlot = () => limiter(env, failures).giveBack(FAILURES, DAY, '1', failureAt).catch(() => undefined);
  // 12. The worst case, reserved before anything is sent.
  const reservedAt = Date.now();
  const budget = await reserveBudget(env, ctx, app, chain, reserved, reservedAt);
  if (!budget.ok) {
    await Promise.all([unmark(), giveBack(env, day, dayAt), freeSlot()]);
    return budget.response;
  }
  const notSent = () => Promise.all([unmark(), giveBack(env, day, dayAt), freeSlot(), settleBudget(env, app, chain.chainId, reserved, 0n, reservedAt)]);
  lap(ctx, 'limits');

  // 13. The simulation: the exact call, from the relayer, at exactly the gas limit, with the account's code set to the
  //     delegation designator when the authorization is to be attached. Success means the delegate ran the whole batch
  //     (its only successful path emits Executed); a revert is a failure (the slot is kept) that spent nothing.
  try {
    await rpc.call({ from: config.relayerAddress as Hex, to: req.account, data: calldata, gas: gasLimit }, authorization ? { stateOverride: { [req.account]: { code: designatorHex(chain.delegate) } } } : {});
  } catch (e) {
    lap(ctx, 'simulate');
    const revert = revertOf(e);
    if (!revert) {
      await notSent();
      return rpcDown(ctx);
    }
    await Promise.all([unmark(), settleBudget(env, app, chain.chainId, reserved, 0n, reservedAt)]);
    return done(ctx, 422, { error: 'The batch would revert', code: 'simulation_reverted', ...revertDetails(revert.revertData, req.calls.length) });
  }
  lap(ctx, 'simulate');

  // 14. The audit row, then the relayer. Without the row nothing is sent.
  const auditId = `es_${crypto.randomUUID().replaceAll('-', '')}`;
  if (!(await insertAudit(env, { id: auditId, app, chainId: chain.chainId, account: req.account, userId, digest, executeNonce: req.executeNonce, reservedWei: reserved, requestId: ctx.requestId, at: reservedAt }))) {
    await notSent();
    return reject(ctx, 503, 'audit_unavailable', 'Try again');
  }
  let sent: EvmRelayerSendResult | null;
  let refused: { code: string; reason: string | null } | null = null;
  try {
    sent = checkedResult(
      await relayer.send({
        digest,
        chainId: chain.chainId,
        to: req.account,
        data: calldata,
        gas: gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        ...(authorization ? { authorization } : {}),
        deadline: req.deadline,
        reservedWei: reserved,
      }),
    );
  } catch (e) {
    sent = null;
    refused = relayerRefusal(e);
  }
  lap(ctx, 'relay');
  if (refused) {
    // A coded refusal: the relayer sent nothing. Everything comes back; the row says so.
    await Promise.all([notSent(), updateAudit(env, auditId, ctx, { status: 'refused' })]);
    return refusalAnswer(ctx, refused.code, refused.reason);
  }
  if (!sent) {
    // Unknown: the relayer may have broadcast before failing. The reservation and the counts stay (the budget errs on
    // the side of spending less); the mark is dropped so the same batch can be sent again: the relayer is idempotent
    // per digest (a copy gets the first transaction, `replay`, and its own reservation back).
    await Promise.all([updateAudit(env, auditId, ctx, { status: 'unknown' }), unmark()]);
    return reject(ctx, 503, 'relayer_unavailable', 'The relayer is unavailable, try again', { 'retry-after': '2' });
  }
  await updateAudit(env, auditId, ctx, { status: 'sent', txHash: sent.transactionHash, relayerNonce: sent.relayerNonce });
  // The relayer had sent this digest already: no second transaction; that send carries the reservation and the counts.
  if (sent.replay) await Promise.all([giveBack(env, day, dayAt), freeSlot(), settleBudget(env, app, chain.chainId, reserved, 0n, reservedAt)]);

  // 15. The receipt (no lock is held while waiting), the success rule, the settlement.
  const receipt = await waitForReceipt(rpc, relayer, digest, sent.transactionHash);
  lap(ctx, 'receipt');
  if (!receipt) {
    await updateAudit(env, auditId, ctx, { status: 'timeout' });
    return done(ctx, 504, { error: 'Sent, not confirmed within 30 s: look the transaction up by its hash', code: 'timeout', transactionHash: sent.transactionHash });
  }
  const cost = receiptCostWei(receipt, chain.opStack, l1Bound);
  if (!sent.replay) await settleBudget(env, app, chain.chainId, reserved, cost, reservedAt);
  if (executedIn(receipt, req.account, digest)) {
    if (!sent.replay) await freeSlot();
    try {
      await limiter(env, account).raiseFloor(NONCE_FLOOR, (req.executeNonce + 1n).toString());
    } catch {
      log({ event: 'evm_sponsor_floor_failed', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'rate_limiter_unavailable' }, 'error');
    }
    await updateAudit(env, auditId, ctx, { status: 'executed', settledWei: cost });
    return done(ctx, 200, { transactionHash: sent.transactionHash, status: 'executed' });
  }
  // A revert, or a transaction that ran nothing (e.g. an authorization the network skipped): charged, a failure.
  const status = receipt.status === 0 ? 'reverted' : 'not_executed';
  await updateAudit(env, auditId, ctx, { status, settledWei: cost });
  return failed(ctx, status, sent.transactionHash);
}

// ---- the hourly checks: the relayer's balance and stuck transactions ----

/**
 * For each sponsored chain: the relayer's balance below `lowBalanceEth` writes `evm_relay_balance_low` (once a UTC
 * day), a pending transaction older than 5 min `evm_relay_stuck` (once an hour). Off when sponsorship is unconfigured.
 * Never throws; logs what it couldn't read.
 */
export async function checkEvmSponsorRelay(env: Env, now: number = Date.now()): Promise<void> {
  const config = evmSponsorReady(env);
  if (!config) return;
  for (const chain of Object.values(config.chains)) {
    try {
      const balance = await sponsorPorts.chain(env, chain).balance(config.relayerAddress as Hex);
      if (balance < chain.lowBalanceWei) await noteEvent(env, null, 'evm_relay_balance_low', [String(chain.chainId), utcDay(now)], { day: utcDay(now), chainId: chain.chainId, relayer: config.relayerAddress, balanceWei: balance.toString(), lowBalanceWei: chain.lowBalanceWei.toString() }, now);
    } catch {
      log({ event: 'evm_sponsor_relay_check', outcome: 'error', code: 'evm_rpc_unavailable' }, 'warn');
    }
    try {
      const relayer = sponsorPorts.relayer(env, chain.chainId);
      const s = relayer ? await relayer.status() : null;
      const age = s ? pendingAgeMs(s.oldestPendingMs, now) : null;
      if (s && age !== null && age > EVM_SPONSOR_LIMITS.stuckAfterMs) {
        const hour = String(Math.floor(now / HOUR) * HOUR);
        await noteEvent(env, null, 'evm_relay_stuck', [String(chain.chainId), hour], { chainId: chain.chainId, pending: s.pending, oldestPendingMs: age }, now);
      }
    } catch {
      log({ event: 'evm_sponsor_relay_check', outcome: 'error', code: 'relayer_unavailable' }, 'warn');
    }
  }
}
