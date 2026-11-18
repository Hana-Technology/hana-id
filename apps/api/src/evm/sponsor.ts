// EVM gas sponsorship (D830–D848, D856; docs/api.md "EVM gas sponsorship"): a Journear user's EVM account runs a batch
// of allowlisted calls through the EIP-7702 delegate (contracts/evm-delegate) while Journear's relayer pays the network
// fee, within daily budgets. Base Sepolia only for now, testnet only, not live until the founder deploys it.
//
// - POST /v1/evm/sponsor/prepare reads what the vault needs to sign: the account's delegation, its transaction nonce
//   and its delegate nonce, the relayer and implementation, the gas floor and deadline window. No signing here.
// - POST /v1/evm/sponsor/send takes the signed batch (and, for an account not yet delegated, its EIP-7702
//   authorization), checks everything in the order below, reserves the worst case, simulates, has the relayer Durable
//   Object (evm-relayer.ts, D851) send it and waits up to 30 s for the receipt. Everything from the reservation on runs
//   inside the request's `waitUntil`, so a client that goes away doesn't stop the settlement; the cron's reconciler
//   settles what a request still couldn't (sponsor-settle.ts).
//
// Both are the vault's only (D832: the vault submits; the signatures never reach the partner page), through the app
// gate `evm-sponsor` (publishable key, VAULT_ORIGIN acting for an allowed `x-hana-parent-origin`, the cross-app per-IP
// window), and both carry the user's session proof (D856, core sponsor-session.ts): before any window, replay check,
// directory read or chain read, the session key's signature over the route, the partner origin, the app and this very
// body, the session's wallet proof of the account, the proof's single use, and the session live on chain in the app's
// scope; with requireKnownAccount the account's directory user must be the session's own. Without a readable
// EVM_SPONSOR, the EVM_RELAYER binding and EVM_RELAY_KEYS every route answers `503 sponsorship_unconfigured` before
// anything else is read (fail closed).
//
// send's order (stop at the first failure; cheap before chain reads, D847): the body; the session proof's own checks;
// the config and chain; the app has targets there; every call allowlisted (value 0, never the account, delegate,
// relayer or zero address, at most maxCallsPerBatch); relayer; minGas window; deadline window; the Execute signature
// recovers to the account; the authorization (chain, pinned delegate, signed by the account); the proof's single use;
// the session (share and chain); the directory; the account's nonce floor and the digest's replay mark (a replay is
// answered from the audit row, never with a chain read); the account's minute and the user's day of attempts (only
// the session's holder gets here, and only these windows are counted before the chain); the chain (code, both counts,
// base fee, the relayer's balance; then nonce(), the L1 and operator fee bounds); the delegation and both nonces; the
// gas limit; the fee; the relayer's balance against the worst case; the digest's mark; the app's in-flight slot; the
// shared windows (app and env minute, then the user's, app's and env's day), counted only now; the user's failure
// slot; the worst case reserved from the app's and the env's day budget; the simulation; the audit row; the relayer;
// the receipt; the settlement.
//
// SECURITY: nothing here logs an address, a signature, a digest, an authorization, a session key or an RPC URL (log()
// has no field for them); the request log has the app, the outcome, the code and phase times. An RPC's own error text
// is never echoed. A response carries only this app's own figures, never another app's or the env's spend.
import { IDENTITY_PROOF_MARKER_MS, identityRoot } from '@hana-id/core/identity';
import { SPONSOR_DELEGATES, type SignedAuthorization, encodeExecuteCalldata } from '@hana-id/core/evm-sponsor';
import { type EvmSponsorRequestMethod, checkEvmSponsorSessionProof } from '@hana-id/core/sponsor-session';
import type { App } from '../apps.ts';
import { hex } from '../bytes.ts';
import { directoryUser } from '../directory/store.ts';
import type { Env } from '../env.ts';
import { appGate, type Ctx, done, lap, limiter, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { identityProofLimiter } from '../identity/limits.ts';
import { checkChainSession, checkShare, proofMarker } from '../identity/token.ts';
import { log } from '../log.ts';
import type { Limit } from '../rate-limiter.ts';
import { AUTHORIZATION_GAS, L1FeeUnavailable, l1FeeUpperBound, maxMinGasFor, operatorFeeUpperBound, sponsorFees, sponsorGasLimit, unsignedTxSizeBound, worstCaseWei } from './op-fee.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, parseEvmSponsorConfig, type PinnedSponsorDelegates, sponsorChain, sponsoredTarget } from './sponsor-config.ts';
import { lateBilling, mirrorEvmBilling } from './sponsor-billing.ts';
import {
  appSponsoredOn,
  authorizationRefusal,
  batchRefusal,
  callRefusal,
  classifyDelegation,
  type Delegation,
  designatorHex,
  EVM_SPONSOR_LIMITS,
  executeInput,
  NONCE_CALLDATA,
  revertDetails,
  type SendRequest,
  toPrepareRequest,
  toSendRequest,
  uintReturn,
  verifiedDigest,
} from './sponsor-checks.ts';
import { type EvmRelayerPort, type EvmRelayerSent, EvmRpcError, type Hex, keccakHex, relayerBinding, relayerRefusal, revertOf, type SponsorChainPort, type SponsorReceipt, sponsorPorts } from './sponsor-ports.ts';
import {
  accountSubject,
  appSubjectOf,
  budgetWindow,
  DAY,
  envBudgetSubject,
  FAILURES,
  failureSubject,
  freeInflight,
  hashesToPoll,
  inflightWindow,
  lookupHashes,
  persistHashes,
  HOUR,
  lookupDigest,
  MINUTE,
  moveRow,
  NONCE_FLOOR,
  noteEvent,
  pruneEvmSponsorSends,
  readReceipts,
  reconcileEvmSends,
  type SendRow,
  type SendStatus,
  settleBudget,
  settleFromReceipt,
} from './sponsor-settle.ts';

export { budgetWindow, envBudgetSubject, noteEvent };

export const EVM_SPONSOR_PREPARE_ENDPOINT = '/v1/evm/sponsor/prepare';
export const EVM_SPONSOR_SEND_ENDPOINT = '/v1/evm/sponsor/send';
export const EVM_SPONSOR_STATUS_ENDPOINT = '/v1/evm/sponsor/status';
export const EVM_SPONSOR_ENDPOINTS: readonly string[] = [EVM_SPONSOR_PREPARE_ENDPOINT, EVM_SPONSOR_SEND_ENDPOINT, EVM_SPONSOR_STATUS_ENDPOINT];

/** 8 calls of 8 KiB of data, as hex, with the rest of the body: well under 140 000 bytes. */
const MAX_BODY = 140_000;

/** The receipt wait (the handler polls; nothing holds a lock meanwhile). Mutable for the tests. */
export const sponsorTiming = { receiptWaitMs: 30_000, receiptPollMs: 1_500 };

/** TESTS ONLY: a fault injected between the row's move to `sent` and a replay's give-back (a crash there). */
export const sponsorFaults: { afterSentPersisted: (() => Promise<void>) | null } = { afterSentPersisted: null };

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

const appSubject = (app: App) => appSubjectOf(app.id);
const envSubject = (chainId: number) => `evm-sponsor:global:${chainId}`;
const userSubject = (userId: string) => `evm-sponsor:user:${userId}`;

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

const unrecorded = (ctx: Ctx): Response =>
  done(ctx, 409, { error: 'This account is not recorded for a user of this app (yet): sign in, then retry', code: 'account_unrecorded', retryable: true, retryAfterS: 2 }, { 'retry-after': '2' });

// ---- the session proof (D856; docs/api.md "EVM gas sponsorship: the session proof of prepare and send") ----

/** What a checked session proof gives the rest of the route: the session's directory user (requireKnownAccount), or null. */
type Session = { userId: string | null };

/**
 * The stateless part of the session proof (core checkEvmSponsorSessionProof): the proof's shape, its time (±60 s of
 * the API's clock), the session key's Ed25519 signature over this route (`method` from the path, never the body), the
 * partner origin in force, the app and this body, and the session's wallet proof naming the body's account. `body` is
 * the one object parsed from the request: the hash covers exactly what every later check acts on (it is never re-read).
 */
function proofRefusal(ctx: Ctx, method: EvmSponsorRequestMethod, env: Env, app: App, parentOrigin: string, body: Record<string, unknown>, now: number): { ok: true; sessionPk: Uint8Array; nonce: Uint8Array; issuedAtMs: number } | { ok: false; response: Response } {
  const r = checkEvmSponsorSessionProof({ method, body, ctx: { signer: env.SIGNER_ACCOUNT, appId: app.id, parentOrigin }, nowMs: now });
  if (r.ok) return { ok: true, sessionPk: r.sessionPublicKey, nonce: r.nonce, issuedAtMs: r.issuedAtMs };
  const fail = (response: Response) => ({ ok: false as const, response });
  switch (r.reason) {
    case 'missing_session_proof':
      return fail(reject(ctx, 401, 'missing_session_proof', 'The session proof is required'));
    case 'bad_session_proof':
      return fail(reject(ctx, 400, 'bad_session_proof', 'The session proof is malformed'));
    case 'stale_session_proof':
      return fail(done(ctx, 400, { error: 'The session proof is too old or too new', code: 'stale_session_proof', serverTimeMs: now }));
    case 'invalid_session_signature':
      return fail(reject(ctx, 401, 'invalid_session_signature', 'Invalid session signature'));
    case 'bad_wallet_proof':
      return fail(reject(ctx, 400, 'bad_wallet_proof', "The wallet proof is not the account's for this session"));
  }
}

/**
 * The proof's stateful part, in D856's order: its single use (the identity token's marker, `identity-proof:<session
 * key>`, kept until issuedAtMs + 120 s: past the whole ±60 s window), the session (its share in `session` mode, then
 * live on chain in the app's scope: one chain read, D513, as any throwaway key reaches it), then with
 * requireKnownAccount the account's directory user, which must be the session's account root's (`403
 * account_mismatch`). Without requireKnownAccount (local envs only) the wallet proof alone ties the account to the
 * session, and no user is named.
 */
async function sessionBound(env: Env, ctx: Ctx, app: App, parentOrigin: string, chain: Readonly<EvmSponsorChainConfig>, account: Hex, p: { sessionPk: Uint8Array; nonce: Uint8Array; issuedAtMs: number }, now: number): Promise<Step<Session>> {
  try {
    if (!(await limiter(env, identityProofLimiter(hex(p.sessionPk))).reserve(await proofMarker({ sessionPk: p.sessionPk, issuedAtMs: p.issuedAtMs, nonce: p.nonce }), p.issuedAtMs + IDENTITY_PROOF_MARKER_MS, now))) {
      return { ok: false, response: reject(ctx, 409, 'proof_replayed', 'This session proof was already used') };
    }
  } catch {
    return { ok: false, response: reject(ctx, 503, 'rate_limiter_unavailable', 'Try again') };
  }
  const share = await checkShare(env, ctx, app, parentOrigin, p.sessionPk, now);
  if (!share.ok) return share;
  const session = await checkChainSession(env, ctx, app, p.sessionPk, now, { singleRead: true });
  if (!session.ok) return session;
  lap(ctx, 'session');
  if (!chain.requireKnownAccount) return { ok: true, value: { userId: null } };
  const root = identityRoot(session.session.path, app.scope_id);
  if (!root) {
    log({ event: 'evm_sponsor_bad_session_path', requestId: ctx.requestId, appId: app.id }, 'error');
    return { ok: false, response: reject(ctx, 502, 'bad_contract_result', 'The session path is not one this API can read') };
  }
  let listed: string | null;
  let own: Awaited<ReturnType<typeof directoryUser>>;
  try {
    [listed, own] = await Promise.all([evmDirectory.lookup(env.DB, app.scope_id, account), directoryUser(env, app.scope_id, root)]);
  } catch {
    return { ok: false, response: reject(ctx, 503, 'directory_unavailable', 'The wallet directory is unavailable, try again') };
  }
  lap(ctx, 'directory');
  if (typeof own === 'string') {
    log({ event: 'evm_sponsor_directory', requestId: ctx.requestId, appId: app.id, code: own }, 'error');
    return { ok: false, response: reject(ctx, 503, 'directory_unavailable', 'The wallet directory is unavailable, try again') };
  }
  if (!listed) return { ok: false, response: unrecorded(ctx) };
  if (listed !== own.internalId) return { ok: false, response: reject(ctx, 403, 'account_mismatch', "This account is not the signed-in user's") };
  return { ok: true, value: { userId: listed } };
}

// ---- chain reads ----

const rpcDown = (ctx: Ctx): Response => reject(ctx, 502, 'evm_rpc_unavailable', 'Could not read the chain, try again');

/** The delegate nonce: `nonce()` on the account, run as the delegate (a state override) when it has no code yet. */
async function delegateNonce(chain: SponsorChainPort, account: Hex, delegation: Delegation, cfg: Readonly<EvmSponsorChainConfig>): Promise<bigint | null> {
  if (delegation === 'other') return null;
  const r = await chain.call({ from: account, to: account, data: NONCE_CALLDATA }, delegation === 'none' ? { stateOverride: { [account]: { code: designatorHex(cfg.delegate) } } } : {});
  const n = uintReturn(r.toLowerCase() as Hex);
  if (n === null) throw new EvmRpcError('bad_response');
  return n;
}

/**
 * The relayer's balance, per isolate per chain for this long, and forgotten after each send (the audit row's insert
 * compares it with every send already committed, D847).
 */
export const RELAYER_BALANCE_TTL_MS = 3_000;
const balances = new Map<number, { wei: bigint; at: number }>();

/** Forgets the cached balances (tests). */
export function forgetRelayerBalances(): void {
  balances.clear();
}

const forgetRelayerBalance = (chainId: number): void => void balances.delete(chainId);

/** The relayer's balance from the trusted endpoint, cached briefly. Throws when it can't be read. */
async function relayerBalance(rpc: SponsorChainPort, chainId: number, relayer: Hex, now: number): Promise<bigint> {
  const c = balances.get(chainId);
  if (c && now - c.at < RELAYER_BALANCE_TTL_MS && now >= c.at) return c.wei;
  const wei = await rpc.balance(relayer);
  balances.set(chainId, { wei, at: now });
  return wei;
}

/** The relayer is paused for new sends (halted, or short of funds): the same plain answer for both. */
const paused = (ctx: Ctx): Response => done(ctx, 503, { error: 'Free network fees are paused for now, try again later', code: 'sponsorship_paused', retryAfterS: 300 }, { 'retry-after': '300' });

/** The relayer can't cover `need` (wei): the day's `evm_relay_balance_low` (the cron's event), so staff top it up before the relayer itself runs dry. */
async function balanceShort(env: Env, ctx: Ctx, chain: Readonly<EvmSponsorChainConfig>, relayer: string, balance: bigint, need: bigint, now: number): Promise<void> {
  balances.delete(chain.chainId);
  log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'relayer_balance_short' }, 'error');
  await noteEvent(env, ctx, 'evm_relay_balance_low', [String(chain.chainId), utcDay(now)], { day: utcDay(now), chainId: chain.chainId, relayer, balanceWei: balance.toString(), lowBalanceWei: chain.lowBalanceWei.toString(), neededWei: need.toString() }, now);
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

const utcDay = (now: number): string => new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10);

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

// ---- the audit row (D848) ----

/** The batch's shape for its billing record (D852): the allowlisted target and selector of each call (public chain data). */
interface BatchShape {
  targets: { address: string; selector: string }[];
  withSetup: boolean;
}

/** SQLite's largest integer: a balance above it is compared as this (a sum of reservations never comes near). */
const INT64_MAX = (1n << 63n) - 1n;

/**
 * The audit row, written only if the relayer's balance still covers, `balanceMargin` times over, the worst cases of
 * every send of this chain already committed (rows `sending`, `sent`, `timeout`, `unknown`, `rejected`, not a replay)
 * plus this one's: one INSERT … SELECT … WHERE, so concurrent requests (any isolate) are serialized by D1 and no more of
 * them reach the relayer than its funds can pay for. `short`: refused for funds; `failed`: the row couldn't be written.
 */
async function insertAudit(env: Env, ctx: Ctx, r: SendRow, shape: BatchShape, balanceWei: bigint): Promise<'ok' | 'short' | 'failed'> {
  const balance = balanceWei > INT64_MAX ? INT64_MAX : balanceWei < 0n ? 0n : balanceWei;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO evm_sponsor_sends (id, app_id, chain_id, account, user_id, digest, execute_nonce, reserved_wei, deadline, gas_limit, fee_cap_wei,
         l1_bound_wei, op_bound_wei, call_count, targets_json, with_setup, status, request_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'sending', ?17, ?18, ?18
        WHERE (SELECT COALESCE(SUM(CAST(reserved_wei AS INTEGER)), 0) FROM evm_sponsor_sends
                WHERE chain_id = ?3 AND replay = 0 AND status IN ('sending', 'sent', 'timeout', 'unknown', 'rejected'))
              + CAST(?8 AS INTEGER) <= CAST(?19 AS INTEGER) / ?20`,
    )
      .bind(r.id, r.appId, r.chainId, r.account, r.userId, r.digest, r.executeNonce.toString(), r.reserved.reservedWei.toString(), r.deadline, r.reserved.gasLimit.toString(), r.reserved.feeCap.toString(), r.reserved.l1Bound.toString(), r.reserved.operatorBound.toString(), shape.targets.length, JSON.stringify(shape.targets), shape.withSetup ? 1 : 0, ctx.requestId, r.createdAt, balance.toString(), Number(EVM_SPONSOR_LIMITS.balanceMargin))
      .run();
    return (res.meta.changes ?? 0) === 1 ? 'ok' : 'short';
  } catch {
    log({ event: 'evm_sponsor_audit_failed', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'insert' }, 'error');
    return 'failed';
  }
}

/**
 * A replay's answer from its audit row (this app's, this chain's, this digest's latest), never from the chain: executed
 * is the same 200 (idempotent), a mined failure the same 422, a send still waiting its 504 with the hash, one in flight
 * `409 in_progress`. Null when there is no row (or it can't be read): the caller answers as a stale nonce.
 */

/**
 * A replay's answer from its audit row (this app's, this chain's, this digest's latest), never from the chain: executed
 * is the same 200 (idempotent), a mined failure the same 422, a batch no node took the same answer as its send, a send
 * still waiting its 504 with the hash, one in flight `409 in_progress`. Null when there is no row (or it can't be
 * read): the caller answers as a stale nonce.
 */
async function replayAnswer(env: Env, ctx: Ctx, app: App, chainId: number, digest: Hex): Promise<Response | null> {
  let row: { status: SendStatus; tx_hash: string | null; rejection: string | null } | null;
  try {
    row = await env.DB.prepare('SELECT status, tx_hash, rejection FROM evm_sponsor_sends WHERE chain_id = ?1 AND digest = ?2 AND app_id = ?3 ORDER BY created_at DESC LIMIT 1')
      .bind(chainId, digest, app.id)
      .first<{ status: SendStatus; tx_hash: string | null; rejection: string | null }>();
  } catch {
    return null;
  }
  if (!row) return null;
  if (row.rejection) return rejectionAnswer(ctx, rejectionKind(row.rejection.split(':')[0] ?? ''));
  const hash = row.tx_hash && /^0x[0-9a-f]{64}$/u.test(row.tx_hash) ? (row.tx_hash as Hex) : null;
  if (row.status === 'executed' && hash) return done(ctx, 200, { transactionHash: hash, status: 'executed', replay: true });
  if ((row.status === 'reverted' || row.status === 'not_executed') && hash) return failed(ctx, row.status, hash);
  if ((row.status === 'sent' || row.status === 'timeout' || row.status === 'lost') && hash) return done(ctx, 504, { error: 'Sent, not confirmed yet: look the transaction up by its hash', code: 'timeout', transactionHash: hash });
  return inProgress(ctx);
}

const inProgress = (ctx: Ctx): Response => done(ctx, 409, { error: 'This batch is being sent, try again shortly', code: 'in_progress', retryable: true, retryAfterS: 2 }, { 'retry-after': '2' });

function failed(ctx: Ctx, code: 'reverted' | 'not_executed', transactionHash: Hex): Response {
  const error = code === 'reverted' ? 'The transaction reverted on chain' : 'The transaction ran but the batch did not execute';
  return done(ctx, 422, { error, code, transactionHash });
}

// ---- the relayer ----

/**
 * Whose doing a batch no node took was (the relayer's `rejection.cause`): `request` (its own size or shape: the user's
 * input), `pricing` (turned away over its fees: nobody's fault, try again shortly), anything else `relayer` (our side:
 * funds, nonce, signing, and any cause this API doesn't know yet: no charge to the user, an alert).
 */
export type RejectionKind = 'request' | 'pricing' | 'relayer';
export const rejectionKind = (cause: string): RejectionKind => (cause === 'request' ? 'request' : cause === 'pricing' ? 'pricing' : 'relayer');

/** The answer to a batch no node took (its nonce went to the relayer's cancel at once): nothing ran. */
function rejectionAnswer(ctx: Ctx, kind: RejectionKind): Response {
  if (kind === 'request') return done(ctx, 422, { error: 'The network refused this batch: nothing ran', code: 'not_executed' });
  if (kind === 'pricing') return done(ctx, 503, { error: 'Network fees are moving too fast right now, try again shortly', code: 'gas_price_too_high', retryAfterS: 15 }, { 'retry-after': '15' });
  return paused(ctx);
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/u;
const WORD_RE = /^[a-z][a-z_]{0,31}$/u;

/**
 * A send result the handler can use: a 32-byte hash (the raw transaction's keccak when the raw comes back), a nonce, the
 * same digest the handler computed, a known `broadcast` and, for `rejected`, its `rejection` (a missing or malformed one
 * is read as the relayer's: no charge to the user). Else null (treated as unknown).
 */
function checkedResult(r: unknown, digest: Hex): EvmRelayerSent | null {
  if (typeof r !== 'object' || r === null) return null;
  const v = r as Record<string, unknown>;
  if (typeof v.transactionHash !== 'string' || !HASH_RE.test(v.transactionHash)) return null;
  if (v.raw !== null && (typeof v.raw !== 'string' || v.raw.length > 2 + 2 * 200_000 || !/^0x([0-9a-fA-F]{2})+$/u.test(v.raw))) return null;
  if (typeof v.relayerNonce !== 'number' || !Number.isSafeInteger(v.relayerNonce) || v.relayerNonce < 0 || typeof v.replay !== 'boolean') return null;
  if (v.broadcast !== 'accepted' && v.broadcast !== 'rejected' && v.broadcast !== 'unknown') return null;
  // The relayer computes the digest itself; one that differs from the handler's is an internal error (kept as unknown).
  if (typeof v.digest !== 'string' || v.digest.toLowerCase() !== digest) {
    log({ event: 'evm_sponsor_relayer_refused', code: 'digest_mismatch' }, 'error');
    return null;
  }
  const hash = v.transactionHash.toLowerCase() as Hex;
  const raw = typeof v.raw === 'string' ? (v.raw.toLowerCase() as Hex) : null;
  if (raw !== null && keccakHex(raw) !== hash) return null;
  const j = v.rejection as { cause?: unknown; code?: unknown } | null | undefined;
  const rejection =
    v.broadcast !== 'rejected' ? null : { cause: typeof j?.cause === 'string' && WORD_RE.test(j.cause) ? j.cause : 'relayer', code: typeof j?.code === 'string' && WORD_RE.test(j.code) ? j.code : 'unknown' };
  return { digest, transactionHash: hash, relayerNonce: v.relayerNonce, raw, replay: v.replay, broadcast: v.broadcast, rejection: rejection as EvmRelayerSent['rejection'] };
}

/**
 * Polls for up to `sponsorTiming.receiptWaitMs` for the receipt of any transaction the relayer signed for this digest:
 * the mined one when its lookup says so, else every hash it lists (a fee bump or a deadline cancel replaces the
 * transaction at the same nonce) and the one it answered. RPC and lookup failures in between are retried. Null on
 * timeout. The first receipt of one of its own hashes answers the user (an `Executed(digest)` log at head: a reorg
 * before confirmed depth is the accepted risk of D847; the money follows the receipt, as the relayer's own verdict
 * would).
 */
async function waitForReceipt(env: Env, rowId: string, chain: SponsorChainPort, relayer: EvmRelayerPort, digest: Hex, first: Hex): Promise<{ receipt: SponsorReceipt; cancelled: boolean } | null> {
  const end = Date.now() + sponsorTiming.receiptWaitMs;
  const known = new Set<Hex>([first]);
  for (;;) {
    const l = await lookupDigest(relayer, digest);
    // Every new hash the relayer reports is persisted on the row (the reconciler reads them all later).
    const fresh = lookupHashes(l.value).filter((h) => !known.has(h));
    if (fresh.length) {
      for (const h of fresh) known.add(h);
      await persistHashes(env, rowId, fresh);
    }
    const read = await readReceipts(chain, hashesToPoll([...known], l.value));
    // Only a receipt for one of its own hashes settles it here; anything else is the reconciler's.
    if (read.kind === 'mined') {
      const v = l.value;
      return { receipt: read.receipt, cancelled: v?.state === 'mined' && v.outcome === 'cancel' && v.minedHash?.toLowerCase() === read.receipt.transactionHash.toLowerCase() };
    }
    if (Date.now() + sponsorTiming.receiptPollMs > end) return null;
    await new Promise((resolve) => setTimeout(resolve, sponsorTiming.receiptPollMs));
  }
}

/** A coded refusal the user's own input caused: their attempts stay counted. Any other gives them back. */
const userCaused = (code: string): boolean => code === 'invalid_request' || code === 'deadline_passed';

/** The answer to a relayer refusal (it sent nothing): its code, never its reason text but a known one. */
function refusalAnswer(ctx: Ctx, code: string, reason: string | null): Response {
  switch (code) {
    case 'relayer_unconfigured':
    case 'relayer_misconfigured':
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code }, 'error');
      return unconfigured(ctx);
    case 'relayer_busy': {
      // `account`: this account's previous batch isn't mined yet (one at a time per account); else the relayer is full.
      const retry = reason === 'account' ? 5 : 2;
      return done(ctx, 429, { error: 'Too many actions are being sent right now, try again in a few seconds', code: 'relayer_busy', retryAfterS: retry }, { 'retry-after': String(retry) });
    }
    case 'relayer_halted':
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'relayer_halted' }, 'error');
      return paused(ctx);
    case 'fees_too_high':
      return done(ctx, 503, { error: 'Network fees are too high right now, try again later', code: 'gas_price_too_high', retryAfterS: 30 }, { 'retry-after': '30' });
    case 'fees_too_low':
      return done(ctx, 503, { error: 'Network fees are moving too fast right now, try again shortly', code: 'gas_price_too_high', retryAfterS: 15 }, { 'retry-after': '15' });
    case 'daily_cap':
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'daily_cap' }, 'error');
      return done(ctx, 429, { error: 'The daily sponsorship budget is used up, try again later', code: 'budget_exhausted', retryAfterS: 3600 }, { 'retry-after': '3600' });
    case 'rpc_unavailable':
      return rpcDown(ctx);
    case 'deadline_passed':
      return reject(ctx, 400, 'deadline_out_of_range', 'deadline is out of range');
    default:
      log({ event: 'evm_sponsor_relayer_refused', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'relayer_error' }, 'error');
      return reject(ctx, 503, 'relayer_unavailable', 'The relayer is unavailable, try again', { 'retry-after': '2' });
  }
}

// ---- POST /v1/evm/sponsor/prepare ----

/**
 * Prepare carries the session proof (D856), so only the signed-in session whose wallet proof is the account can read
 * it: the proof first, then the account's prepare minute (per account: only its session reaches it), the app's and
 * the env's prepare minutes, then the chain reads. A user's failure count is never disclosed here (a generic
 * `not_available`); a halted or underfunded relayer is `paused`.
 */
export async function handleEvmSponsorPrepare(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, EVM_SPONSOR_PREPARE_ENDPOINT, request);
  const config = evmSponsorReady(env);
  if (!config) return unconfigured(ctx);
  const gate = await appGate(request, env, ctx, 'evm-sponsor');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const parentOrigin = gate.caller.parentOrigin;
  if (!parentOrigin) return reject(ctx, 403, 'origin_not_allowed', 'Origin not allowed for this app');
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return reject(ctx, body.status, 'bad_request', body.error);
  // One parse: the strict shape (a safe positive chainId among it) and the session proof's hash read the same object.
  const req = toPrepareRequest(body.body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Not a sponsorship prepare request');
  const now = Date.now();
  const proof = proofRefusal(ctx, 'prepare', env, app, parentOrigin, body.body as Record<string, unknown>, now);
  if (!proof.ok) return proof.response;
  lap(ctx, 'proof');
  const chain = sponsorChain(config, req.chainId);
  if (!chain) return reject(ctx, 400, 'chain_not_enabled', 'Sponsorship is not enabled on this chain');
  if (!appSponsoredOn(config, app.id, chain.chainId)) return reject(ctx, 403, 'app_not_sponsored', 'This app has no sponsored calls on this chain');
  const refusal = callRefusal(config, chain, app.id, req.account, req.calls);
  if (refusal) return callRefusalAnswer(ctx, refusal);
  lap(ctx, 'checks');

  const session = await sessionBound(env, ctx, app, parentOrigin, chain, req.account, proof, now);
  if (!session.ok) return session.response;
  const { userId } = session.value;
  const pre = await quota(
    env,
    ctx,
    [
      { subject: accountSubject(chain.chainId, req.account), limits: [{ name: 'evm-sponsor:prepare:minute', windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.preparesPerAccountPerMinute }], what: 'per account per minute' },
      { subject: appSubject(app), limits: [{ name: `evm-sponsor:${chain.chainId}:prepare:minute`, windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.preparesPerAppPerMinute }], what: 'per app' },
      { subject: envSubject(chain.chainId), limits: [{ name: 'evm-sponsor:prepare:minute', windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.preparesPerEnvPerMinute }], what: 'across the env' },
    ],
    now,
  );
  if (pre) return pre;

  const rpc = sponsorPorts.chain(env, chain);
  let delegation: Delegation;
  let accountNonce: bigint;
  let executeNonce: bigint | null;
  let balance: bigint;
  try {
    const [code, pending, b] = await Promise.all([rpc.code(req.account), rpc.transactionCount(req.account, 'pending'), relayerBalance(rpc, chain.chainId, config.relayerAddress as Hex, now)]);
    delegation = classifyDelegation(code.toLowerCase() as Hex, chain.delegate);
    accountNonce = BigInt(pending);
    balance = b;
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
  const halted = delegation === 'other' ? false : await relayerHalted(env, chain.chainId);
  const short = balance < floorWorstCase(chain) * EVM_SPONSOR_LIMITS.balanceMargin;
  const reason =
    delegation === 'other'
      ? 'delegated_elsewhere'
      : halted === true || short
        ? 'paused'
        : failures >= BigInt(EVM_SPONSOR_LIMITS.failuresPerUserPerDay)
          ? 'not_available'
          : !budgetLeft(chain, spent)
            ? 'budget_exhausted'
            : null;
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

/**
 * `exec`: the request's execution context. Everything from the budget reservation on runs inside its `waitUntil`, so
 * the settlement finishes even when the client goes away (the cron's reconciler catches what still doesn't).
 */
export async function handleEvmSponsorSend(request: Request, env: Env, requestId: string, exec?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const ctx = newCtx(env, requestId, EVM_SPONSOR_SEND_ENDPOINT, request);
  const config = evmSponsorReady(env);
  if (!config) return unconfigured(ctx);
  const gate = await appGate(request, env, ctx, 'evm-sponsor');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const parentOrigin = gate.caller.parentOrigin;
  if (!parentOrigin) return reject(ctx, 403, 'origin_not_allowed', 'Origin not allowed for this app');
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return reject(ctx, body.status, 'bad_request', body.error);
  // One parse: the strict shape and the session proof's hash read the same object, and every later check acts on it.
  const req = toSendRequest(body.body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Not a sponsorship send request');
  const now = Date.now();
  const proof = proofRefusal(ctx, 'send', env, app, parentOrigin, body.body as Record<string, unknown>, now);
  if (!proof.ok) return proof.response;
  lap(ctx, 'proof');

  // 1. The chain, the app and every call (the allowlist).
  const chain = sponsorChain(config, req.chainId);
  if (!chain) return reject(ctx, 400, 'chain_not_enabled', 'Sponsorship is not enabled on this chain');
  if (!appSponsoredOn(config, app.id, chain.chainId)) return reject(ctx, 403, 'app_not_sponsored', 'This app has no sponsored calls on this chain');
  const refusal = callRefusal(config, chain, app.id, req.account, req.calls);
  if (refusal) return callRefusalAnswer(ctx, refusal);
  // 2. The relayer, the gas floor, the deadline.
  const nowS = BigInt(Math.floor(now / 1000));
  const batch = batchRefusal(config, chain, req, nowS);
  if (batch?.code === 'wrong_relayer') return reject(ctx, 400, 'wrong_relayer', "relayer must be the sponsorship's relayer");
  if (batch?.code === 'min_gas_out_of_range') return done(ctx, 400, { error: 'minGas is out of range', code: 'min_gas_out_of_range', minGasFloor: batch.minGasFloor.toString(), maxGas: batch.maxGas.toString() });
  if (batch?.code === 'deadline_out_of_range') return done(ctx, 400, { error: 'deadline is out of range', code: 'deadline_out_of_range', serverNow: Number(batch.serverNow), deadlineMaxS: batch.deadlineMaxS });
  // 3. The signatures: the Execute by the account, over the pinned implementation; the authorization, if any, to the
  //    pinned delegate only. The session proof binds the session to this body; these bind the account's key to it.
  const input = executeInput(chain, req);
  const digest = verifiedDigest(input, req.signature);
  if (!digest) return reject(ctx, 401, 'invalid_signature', "The batch's signature is not the account's");
  if (req.authorization) {
    const a = authorizationRefusal(chain, req.account, req.authorization);
    if (a?.code === 'bad_authorization') return reject(ctx, 400, 'bad_authorization', 'The authorization is not for this chain');
    if (a?.code === 'authorization_not_pinned') return reject(ctx, 403, 'authorization_not_pinned', 'The authorization must name the pinned delegate');
    if (a?.code === 'invalid_authorization_signature') return reject(ctx, 401, 'invalid_authorization_signature', "The authorization's signature is not the account's");
  }
  lap(ctx, 'checks');
  // 4. The proof's single use, the session, the directory.
  const session = await sessionBound(env, ctx, app, parentOrigin, chain, req.account, proof, now);
  if (!session.ok) return session.response;
  return sendChecked(env, ctx, app, config, chain, req, digest, session.value.userId, exec);
}

async function sendChecked(env: Env, ctx: Ctx, app: App, config: EvmSponsorConfig, chain: Readonly<EvmSponsorChainConfig>, req: SendRequest, digest: Hex, userId: string | null, exec?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const relayer = sponsorPorts.relayer(env, chain.chainId);
  if (!relayer) return unconfigured(ctx);
  const account = accountSubject(chain.chainId, req.account);
  // 5. Replays, before any count or chain read: an executeNonce below the account's floor, or a digest marked as sent,
  //    is answered from its audit row (or as stale). A signed batch is public once on chain; re-posting it costs nothing.
  try {
    const floor = BigInt(await limiter(env, account).floor(NONCE_FLOOR));
    if (req.executeNonce < floor) return (await replayAnswer(env, ctx, app, chain.chainId, digest)) ?? done(ctx, 409, { error: 'The batch nonce is already used', code: 'nonce_stale', executeNonce: floor.toString() });
    const t = Date.now();
    if (!(await limiter(env, account).reserve(digest, t, t))) return (await replayAnswer(env, ctx, app, chain.chainId, digest)) ?? inProgress(ctx);
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  // 6. Before the chain, only what the session's holder pays for (M1 of the review): the account's minute and the
  //    user's (or, without a directory user, the account's) day of attempts. Nothing shared is counted until the chain
  //    checks pass, so refusals after the reads (a future nonce, no delegation, a stale authorization, too much gas, an
  //    RPC failure) never use up the app's or the env's windows; a refusal that is not the user's doing (the relayer
  //    short of funds, halted or busy, the network's fees) gives these back too.
  const own: Window[] = [
    { subject: account, limits: [{ name: 'evm-sponsor:send:minute', windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.sendsPerAccountPerMinute }], what: 'per account per minute' },
    { subject: userId ? userSubject(userId) : account, limits: [{ name: `evm-sponsor:${chain.chainId}:attempts`, windowMs: DAY, max: chain.perUserPerDay * EVM_SPONSOR_LIMITS.attemptsPerSend }], what: 'attempts per user' },
  ];
  const ownAt = Date.now();
  const o = await quota(env, ctx, own, ownAt);
  if (o) return o;
  const giveBackOwn = () => giveBack(env, own, ownAt);

  // 7. The chain: the account's code, its latest and pending counts, the base fee and the relayer's balance; then its
  //    delegate nonce and the fee bounds.
  const rpc = sponsorPorts.chain(env, chain);
  const relayerAddress = config.relayerAddress as Hex;
  let delegation: Delegation;
  let pending: bigint;
  let latest: bigint;
  let baseFee: bigint;
  let balance: bigint;
  try {
    const [code, p, l, b, wei] = await Promise.all([rpc.code(req.account), rpc.transactionCount(req.account, 'pending'), rpc.transactionCount(req.account, 'latest'), rpc.latestBlock(), relayerBalance(rpc, chain.chainId, relayerAddress, ownAt)]);
    delegation = classifyDelegation(code.toLowerCase() as Hex, chain.delegate);
    pending = BigInt(p);
    latest = BigInt(l);
    baseFee = b.baseFeePerGas;
    balance = wei;
  } catch {
    return rpcDown(ctx);
  }
  // 8. The delegation (D840: delegated elsewhere is refused) and the authorization's place: attached only to an account
  //    with no code, whose pending and latest counts are both its nonce (nothing of the account's own in flight that
  //    would use the nonce first). On an account already delegated to the pinned delegate it is left off.
  if (delegation === 'other') return reject(ctx, 409, 'delegated_elsewhere', 'This account is delegated to another contract: sponsorship is not available for it');
  if (delegation === 'none' && !req.authorization) return reject(ctx, 409, 'delegation_required', 'This account needs the one-time setup: sign the authorization too');
  const authorization: SignedAuthorization | null = delegation === 'journear' ? null : req.authorization;
  if (authorization && (authorization.nonce !== pending || pending !== latest)) return done(ctx, 409, { error: "The authorization's nonce is not the account's", code: 'authorization_nonce_stale', accountNonce: pending.toString() });
  const calldata = encodeExecuteCalldata(executeInput(chain, req), req.signature);
  const authorizations = authorization ? 1 : 0;
  // 9. Gas (the relayer's own intrinsic gas plus the delegate's overhead and minGas) and fees, before anything is reserved.
  const gasLimit = sponsorGasLimit({ calldata, callData: req.calls.map((c) => c.data), minGas: req.minGas, authorizations });
  if (gasLimit > chain.maxGasPerTx) return done(ctx, 403, { error: 'The batch needs more gas than one sponsored transaction may use', code: 'gas_too_high', maxGas: chain.maxGasPerTx.toString() });
  const fees = sponsorFees(baseFee, chain);
  if (!fees.ok) {
    await giveBackOwn();
    return done(ctx, 503, { error: 'Network fees are too high right now, try again later', code: 'gas_price_too_high', retryAfterS: 30 }, { 'retry-after': '30' });
  }
  let chainNonce: bigint | null;
  let l1Bound: bigint;
  let operatorBound: bigint;
  try {
    [chainNonce, l1Bound, operatorBound] = await Promise.all([
      delegateNonce(rpc, req.account, delegation, chain),
      l1FeeUpperBound(rpc, chain.opStack, relayerAddress, unsignedTxSizeBound((calldata.length - 2) / 2, authorizations)),
      operatorFeeUpperBound(rpc, chain.opStack, relayerAddress, gasLimit),
    ]);
  } catch (e) {
    if (e instanceof L1FeeUnavailable) log({ event: 'evm_sponsor_l1_fee', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'l1_fee_unavailable' }, 'error');
    return rpcDown(ctx);
  }
  lap(ctx, 'chain');
  if (chainNonce === null) return rpcDown(ctx);
  if (req.executeNonce !== chainNonce) {
    if (req.executeNonce < chainNonce) {
      // Used on chain: the floor rises past this batch's own nonce (never to the RPC's figure, which a lying node could
      // inflate), so it and every older one are dropped before any count from now on; the account's minute comes back.
      try {
        await limiter(env, account).raiseFloor(NONCE_FLOOR, (req.executeNonce + 1n).toString());
      } catch {
        return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again', { 'retry-after': '1' });
      }
      await giveBack(env, own.slice(0, 1), ownAt);
    }
    return done(ctx, 409, { error: 'The batch nonce is not the account’s next', code: 'nonce_stale', executeNonce: chainNonce.toString() });
  }
  // The reservation is the worst case: gas at the fee cap (the relayer may replace the transaction with fees up to it),
  // plus the L1 data fee's and the operator fee's bounds.
  const reservedFor = { gasLimit, feeCap: chain.maxFeePerGasWei, l1Bound, operatorBound, reservedWei: worstCaseWei(gasLimit, chain.maxFeePerGasWei, l1Bound, operatorBound) };
  const reserved = reservedFor.reservedWei;
  // 10. The relayer's funds, a first look: at least `lowBalanceEth` (so the alert fires while in-flight work can still
  //     finish) and this send's worst case with the margin. The binding check, against every send already committed,
  //     is the audit row's insert (step 15). Short: `sponsorship_paused` and the day's low-balance alert.
  const need = reserved * EVM_SPONSOR_LIMITS.balanceMargin;
  if (balance < chain.lowBalanceWei || balance < need) {
    await Promise.all([balanceShort(env, ctx, chain, config.relayerAddress, balance, need, ownAt), giveBackOwn()]);
    return paused(ctx);
  }

  // 11. The digest's mark: from here on a copy (concurrent or later) is answered from the audit row, never counted twice.
  const markedAt = Date.now();
  const markUntil = Number(req.deadline) * 1000 + 2 * MINUTE;
  try {
    if (!(await limiter(env, account).reserve(digest, markUntil, markedAt))) return (await replayAnswer(env, ctx, app, chain.chainId, digest)) ?? inProgress(ctx);
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const unmark = () => limiter(env, account).release(digest).catch(() => undefined);
  // 12. The app's in-flight slot (at most inflightPerApp of the relayer's 8 unmined), then the shared windows, only now:
  //     the app's and the env's minute, then the user's, the app's and the env's day.
  const sharedAt = Date.now();
  const inflight = { appId: app.id, chainId: chain.chainId, createdAt: sharedAt };
  let slotTaken;
  try {
    slotTaken = await limiter(env, appSubject(app)).spend(inflightWindow(chain.chainId), DAY, String(EVM_SPONSOR_LIMITS.inflightPerApp), '1', sharedAt);
  } catch {
    await unmark();
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  if (!slotTaken.ok) {
    await Promise.all([unmark(), giveBackOwn()]);
    return done(ctx, 429, { error: 'Too many of this app’s actions are being sent right now, try again in a few seconds', code: 'relayer_busy', retryAfterS: 5 }, { 'retry-after': '5' });
  }
  const shared: Window[] = [
    { subject: appSubject(app), limits: [{ name: `evm-sponsor:${chain.chainId}:minute`, windowMs: MINUTE, max: EVM_SPONSOR_LIMITS.sendsPerAppPerMinute }], what: 'per app per minute' },
    { subject: envSubject(chain.chainId), limits: [{ name: 'evm-sponsor:minute', windowMs: MINUTE, max: chain.sendsPerMinute }], what: 'across the env per minute' },
    ...(userId ? [{ subject: userSubject(userId), limits: [{ name: `evm-sponsor:${chain.chainId}:day`, windowMs: DAY, max: chain.perUserPerDay }], what: 'per user' }] : []),
    { subject: appSubject(app), limits: [{ name: `evm-sponsor:${chain.chainId}:day`, windowMs: DAY, max: chain.perAppPerDay }], what: 'per app' },
    { subject: envSubject(chain.chainId), limits: [{ name: 'evm-sponsor:day', windowMs: DAY, max: chain.sendsPerDay }], what: 'across the env' },
  ];
  const d = await quota(env, ctx, shared, sharedAt);
  if (d) {
    await Promise.all([unmark(), freeInflight(env, inflight)]);
    return d;
  }
  const failures = failureSubject(chain.chainId, req.account, userId);
  let slot;
  try {
    slot = await limiter(env, failures).spend(FAILURES, DAY, String(EVM_SPONSOR_LIMITS.failuresPerUserPerDay), '1', sharedAt);
  } catch {
    await Promise.all([unmark(), freeInflight(env, inflight), giveBack(env, shared, sharedAt)]);
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  if (!slot.ok) {
    await Promise.all([unmark(), freeInflight(env, inflight), giveBack(env, shared, sharedAt)]);
    return done(ctx, 429, { error: 'Too many failed sponsored actions today, try again tomorrow', code: 'too_many_failures', retryAfterS: slot.retryAfterS }, { 'retry-after': String(slot.retryAfterS) });
  }
  const freeSlot = () => limiter(env, failures).giveBack(FAILURES, DAY, '1', sharedAt).catch(() => undefined);
  // 13. The worst case, reserved before anything is sent; from here on the rest runs inside waitUntil.
  const budget = await reserveBudget(env, ctx, app, chain, reserved, sharedAt);
  if (!budget.ok) {
    await Promise.all([unmark(), freeInflight(env, inflight), giveBack(env, shared, sharedAt), freeSlot()]);
    return budget.response;
  }
  lap(ctx, 'limits');
  const row: SendRow = {
    id: `es_${crypto.randomUUID().replaceAll('-', '')}`,
    appId: app.id,
    chainId: chain.chainId,
    account: req.account,
    userId,
    digest,
    executeNonce: req.executeNonce,
    txHash: null,
    hashes: [],
    deadline: Number(req.deadline),
    reserved: reservedFor,
    replay: false,
    createdAt: sharedAt,
  };
  const giveBackAll = () => Promise.all([giveBack(env, shared, sharedAt), freeSlot(), freeInflight(env, inflight), settleBudget(env, app.id, chain.chainId, reserved, 0n, sharedAt)]);
  const notSent = () => Promise.all([unmark(), giveBackAll()]);
  const shape: BatchShape = {
    targets: req.calls.map((c) => ({ address: (sponsoredTarget(config, app.id, chain.chainId, c.to, c.data)?.address ?? c.to).toLowerCase(), selector: c.data.slice(0, 10).toLowerCase() })),
    withSetup: authorization !== null,
  };
  const tail = afterReservation(env, ctx, chain, relayerAddress, relayer, rpc, req, row, shape, calldata, authorization, fees, balance, {
    unmark,
    notSent,
    giveBackAll,
    giveBackOwn,
    notTheUsers: () => Promise.all([giveBackOwn(), giveBack(env, shared, sharedAt), freeSlot()]),
  });
  exec?.waitUntil(tail.then(
    () => undefined,
    () => undefined,
  ));
  return tail;
}

interface Undo {
  unmark: () => Promise<unknown>;
  /** Nothing was sent: the mark, the windows, the failure slot, the in-flight slot and the reservation come back. */
  notSent: () => Promise<unknown>;
  /** A replay: this copy's counts, slots and reservation come back (the first send carries them). */
  giveBackAll: () => Promise<unknown>;
  /** The user's own attempts (the account's minute and the user's day of attempts) come back. */
  giveBackOwn: () => Promise<unknown>;
  /** Not the user's doing: their attempts, the shared windows and the failure slot come back (the money settles later). */
  notTheUsers: () => Promise<unknown>;
}

/** Everything after the reservation (inside the request's waitUntil): the simulation, the row, the relayer, the receipt. */
async function afterReservation(
  env: Env,
  ctx: Ctx,
  chain: Readonly<EvmSponsorChainConfig>,
  relayerAddress: Hex,
  relayer: EvmRelayerPort,
  rpc: SponsorChainPort,
  req: SendRequest,
  row: SendRow,
  shape: BatchShape,
  calldata: Hex,
  authorization: SignedAuthorization | null,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  balance: bigint,
  undo: Undo,
): Promise<Response> {
  // 14. The simulation: the exact call, from the relayer, with the account's code set to the delegation designator when
  //     the authorization is to be attached. eth_call carries no authorization list, so its intrinsic cost is 25 000
  //     per authorization lower than the real transaction's: it runs with that much less gas, which leaves the batch
  //     exactly the gas it will have. Success means the delegate ran the whole batch (its only successful path emits
  //     Executed); a revert is a failure (the slot is kept) that spent nothing.
  const simGas = row.reserved.gasLimit - AUTHORIZATION_GAS * BigInt(authorization ? 1 : 0);
  try {
    await rpc.call({ from: relayerAddress, to: req.account, data: calldata, gas: simGas }, authorization ? { stateOverride: { [req.account]: { code: designatorHex(chain.delegate) } } } : {});
  } catch (e) {
    lap(ctx, 'simulate');
    const revert = revertOf(e);
    if (!revert) {
      await undo.notSent();
      return rpcDown(ctx);
    }
    await Promise.all([undo.unmark(), freeInflight(env, row), settleBudget(env, row.appId, chain.chainId, row.reserved.reservedWei, 0n, row.createdAt)]);
    return done(ctx, 422, { error: 'The batch would revert', code: 'simulation_reverted', ...revertDetails(revert.revertData, req.calls.length) });
  }
  lap(ctx, 'simulate');

  // 15. The audit row, written only while the relayer's balance covers every committed send's worst case and this one's
  //     (× the margin), then the relayer. Without the row nothing is sent.
  const audit = await insertAudit(env, ctx, row, shape, balance);
  if (audit === 'failed') {
    await undo.notSent();
    return reject(ctx, 503, 'audit_unavailable', 'Try again');
  }
  if (audit === 'short') {
    await Promise.all([undo.notSent(), undo.giveBackOwn(), balanceShort(env, ctx, chain, relayerAddress, balance, row.reserved.reservedWei * EVM_SPONSOR_LIMITS.balanceMargin, Date.now())]);
    return paused(ctx);
  }
  let sent: EvmRelayerSent | null;
  let refused: { code: string; reason: string | null } | null = null;
  try {
    sent = checkedResult(
      await relayer.send({
        chainId: chain.chainId,
        execute: executeInput(chain, req),
        signature: req.signature,
        gas: row.reserved.gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        ...(authorization ? { authorization } : {}),
        reservedWei: row.reserved.reservedWei,
      }),
      row.digest,
    );
  } catch (e) {
    sent = null;
    refused = relayerRefusal(e);
  }
  // The balance moves with every send: the next request reads it afresh.
  forgetRelayerBalance(chain.chainId);
  lap(ctx, 'relay');
  if (refused) {
    // A coded refusal: the relayer sent nothing. The row says so first; only if this request moved it does everything
    // come back (the caller that moves a row owns its give-back), the user's attempts too unless their input caused it.
    if (await moveRow(env, row.id, ['sending'], 'refused', { settledWei: 0n })) await Promise.all([undo.notSent(), userCaused(refused.code) ? null : undo.giveBackOwn()]);
    else await undo.unmark();
    return refusalAnswer(ctx, refused.code, refused.reason);
  }
  if (!sent) {
    // Unknown: the relayer may have broadcast before failing. The reservation and the counts stay (the reconciler
    // settles them from the relayer's lookup); the mark is dropped so the same batch can be sent again: the relayer is
    // idempotent per digest (a copy gets the first transaction, `replay`, and its own reservation back).
    await Promise.all([moveRow(env, row.id, ['sending'], 'unknown'), undo.unmark()]);
    return reject(ctx, 503, 'relayer_unavailable', 'The relayer is unavailable, try again', { 'retry-after': '2' });
  }
  if (sent.broadcast === 'rejected') return rejectedNow(env, ctx, row, sent, undo);
  // The row records the hash (and, for a replay, that its reservation is given back) before anything is given back: a
  // crash in between leaves a row whose settlement gives nothing back (errs high), never twice. A replay (the relayer
  // had sent this digest already: no second transaction; that send carries its own reservation and counts) gives this
  // copy's back only when this request moved the row.
  const settled: SendRow = { ...row, txHash: sent.transactionHash, replay: sent.replay };
  const moved = await moveRow(env, row.id, ['sending'], 'sent', { txHash: sent.transactionHash, relayerNonce: sent.relayerNonce, replay: sent.replay });
  await sponsorFaults.afterSentPersisted?.();
  if (sent.replay && moved) await undo.giveBackAll();

  // 16. The receipt (no lock is held while waiting), the success rule, the settlement (once: the row moves first).
  await persistHashes(env, row.id, [sent.transactionHash]);
  const receipt = await waitForReceipt(env, row.id, rpc, relayer, row.digest, sent.transactionHash);
  lap(ctx, 'receipt');
  if (!receipt) {
    await moveRow(env, row.id, ['sent'], 'timeout');
    return done(ctx, 504, { error: 'Sent, not confirmed within 30 s: look the transaction up by its hash', code: 'timeout', transactionHash: sent.transactionHash });
  }
  const result = await settleFromReceipt(env, chain, settled, receipt.receipt, ['sent'], { cancelled: receipt.cancelled, chain: rpc });
  const outcome = result?.outcome ?? (await settledOutcome(env, row.id));
  const hash = receipt.receipt.transactionHash.toLowerCase() as Hex;
  if (outcome === 'executed') return done(ctx, 200, { transactionHash: hash, status: 'executed' });
  // A revert, or a transaction that ran nothing (e.g. an authorization the network skipped, or the deadline's cancel).
  return failed(ctx, outcome === 'reverted' ? 'reverted' : 'not_executed', hash);
}

/**
 * No node took the batch (`broadcast: 'rejected'`): the relayer gave its nonce to its own cancel at once, so this is
 * answered now, not after a 30 s wait. The row moves to `rejected` with the cause; the reconciler settles the money to
 * the cancel's cost once the relayer reports it mined. The user is charged a failure only when the batch itself was the
 * cause (`request`); for `pricing` (its fees) and `relayer` (our side, and any cause not known here) their attempts,
 * the shared windows and the failure slot come back, and `relayer` writes `evm_relay_stuck` (the relayer halts itself
 * on such a refusal). The mark stays: a copy is answered the same from the row.
 */
async function rejectedNow(env: Env, ctx: Ctx, row: SendRow, sent: EvmRelayerSent, undo: Undo): Promise<Response> {
  const cause = sent.rejection?.cause ?? 'relayer';
  const code = sent.rejection?.code ?? 'unknown';
  const kind = rejectionKind(cause);
  await persistHashes(env, row.id, [sent.transactionHash]);
  const moved = await moveRow(env, row.id, ['sending'], 'rejected', { txHash: sent.transactionHash, relayerNonce: sent.relayerNonce, replay: sent.replay, rejection: `${cause}:${code}` });
  if (moved && sent.replay) await undo.giveBackAll();
  else if (moved && kind !== 'request') await undo.notTheUsers();
  const now = Date.now();
  log({ event: 'evm_sponsor_rejected', requestId: ctx.requestId, endpoint: ctx.endpoint, code: `${kind}:${code}` }, kind === 'relayer' ? 'error' : 'warn');
  if (kind === 'relayer') await noteEvent(env, ctx, 'evm_relay_stuck', [String(row.chainId), String(Math.floor(now / HOUR) * HOUR)], { chainId: row.chainId, rejected: code }, now);
  return rejectionAnswer(ctx, kind);
}

async function settledOutcome(env: Env, id: string): Promise<'executed' | 'reverted' | 'not_executed'> {
  try {
    const r = await env.DB.prepare('SELECT status FROM evm_sponsor_sends WHERE id = ?1').bind(id).first<{ status: SendStatus }>();
    return r?.status === 'executed' || r?.status === 'reverted' ? r.status : 'not_executed';
  } catch {
    return 'not_executed';
  }
}


/** The relayer's halt reason as plain data (lowercase words and underscores), or null when it isn't halted. */
export function haltedReason(h: unknown): string | null {
  if (typeof h !== 'object' || h === null) return null;
  const r = (h as { reason?: unknown }).reason;
  return typeof r === 'string' && /^[a-z_]{1,40}$/u.test(r) ? r : 'halted';
}

/** The halt's refusal code (`relayer_cannot_send`'s pool refusal), when it is plain data. */
const haltCode = (h: unknown): string | null => {
  const c = typeof h === 'object' && h !== null ? (h as { code?: unknown }).code : undefined;
  return typeof c === 'string' && /^[a-z_]{1,40}$/u.test(c) ? c : null;
};

/** Whether the chain's relayer is halted (for status's and prepare's `paused`); null when it can't be asked. Bounded to 2 s. */
export async function relayerHalted(env: Env, chainId: number): Promise<boolean | null> {
  const relayer = sponsorPorts.relayer(env, chainId);
  if (!relayer) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const s = await Promise.race([relayer.status(), new Promise<null>((r) => (timer = setTimeout(() => r(null), 2_000)))]);
    return s ? haltedReason(s.halted) !== null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- the cron: the relayer's balance and stuck transactions, the reconciler, the retention ----

/**
 * Every cron run, per sponsored chain: the relayer's balance below `lowBalanceEth` writes `evm_relay_balance_low`
 * (once a UTC day); the relayer halted (it takes no new sends until staff resume it, D851), or its oldest unmined
 * transaction older than 10 minutes, writes `evm_relay_stuck` (once an hour); then the reconciler (sponsor-settle.ts)
 * settles what requests couldn't. The audit rows' 24-month retention runs with or without the config. Never throws;
 * logs what it couldn't read.
 */
export async function checkEvmSponsorRelay(env: Env, now: number = Date.now()): Promise<void> {
  await pruneEvmSponsorSends(env, now);
  // The billing records (D852): copied to the usage ledger and checked for lateness with or without the config, since
  // records outlive sponsorship being switched off.
  await mirrorEvmBilling(env, now);
  const late = await lateBilling(env, now);
  if (late && (late.missing > 0 || late.unmirrored > 0)) await noteEvent(env, null, 'evm_billing_late', [String(Math.floor(now / HOUR) * HOUR)], { missing: late.missing, unmirrored: late.unmirrored }, now);
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
      const age = s && typeof s.oldestUnminedMs === 'number' && Number.isFinite(s.oldestUnminedMs) && s.oldestUnminedMs >= 0 ? s.oldestUnminedMs : null;
      const halted = s ? haltedReason(s.halted) : null;
      if (s && ((age !== null && age > EVM_SPONSOR_LIMITS.stuckAfterMs) || halted)) {
        const hour = String(Math.floor(now / HOUR) * HOUR);
        const code = halted ? haltCode(s.halted) : null;
        await noteEvent(env, null, 'evm_relay_stuck', [String(chain.chainId), hour], { chainId: chain.chainId, pending: s.unmined, oldestPendingMs: age, ...(halted ? { halted } : {}), ...(code ? { haltCode: code } : {}) }, now);
      }
    } catch {
      log({ event: 'evm_sponsor_relay_check', outcome: 'error', code: 'relayer_unavailable' }, 'warn');
    }
  }
  await reconcileEvmSends(env, config, now);
}
