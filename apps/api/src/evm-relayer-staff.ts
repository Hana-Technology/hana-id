// The EVM relayer's staff tools (D851) and their admin view (D843), reached only through AdminRpc (rpc/admin.ts: staff
// actors only, the admin portal's "Free network fees"); no route reaches them. Any holder of the EVM_RELAYER binding
// could call the object's staff methods, so their guard lives here, and a test (scripts/test/evm-relayer-staff.test.ts)
// keeps every file in apps/api/src but this one, the object and rpc/admin.ts (the sponsorship handlers under src/evm/
// and the public routes included) from importing this file or naming the guard, a staff method or these functions.
// Each tool re-reads the chain inside the object, refuses unsafe use, and is recorded there (who, when, what, note,
// outcome); the admin Worker also writes its own audit rows around each call. What each halt means and which tool
// resolves it: docs/operations.md "EVM sponsorship relay".
//
// The admin view reads, per sponsored chain and only when the env has `evm.sponsor`: the object's staff status (its
// storage, no chain read), today's reservations on the env's day budget (the handlers' RateLimiter, read only), the
// relayer's balance and the account helper program's code (two reads of the trusted read endpoint, plus its chain-id
// check per isolate). Nothing is read without the block. The view holds public data
// only: no key, raw transaction, calldata, signature or user's account (records are reduced to slots, hashes, times).
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { type EvmRelayActInput, type EvmRelayActResult, type EvmRelayChainView, type EvmRelayDetail, type EvmRelayRecordView, type EvmRelayRelayerView, type EvmRelayStatus, isLeakHalt } from '@hana-id/console-core';
import { keccak_256 } from '@noble/hashes/sha3';
import { RpcRefusal } from './changes/cas.ts';
import type { Env } from './env.ts';
import { EVM_RELAYER_STAFF_GUARD, type EvmRelayer, type EvmRelayerStaffExpect, type EvmRelayerStaffResult, type EvmRelayerStaffStatus, evmRelayKeyAddress, evmRelayerError, evmRelayerName } from './evm-relayer.ts';
import { limiter } from './handlers.ts';
import { log } from './log.ts';
import { EvmRpcError, type Hex, keyedSponsorRpc, sponsorChainFor } from './evm/sponsor-chain.ts';
import { DAY, budgetWindow, envBudgetSubject } from './evm/sponsor-settle.ts';
import { type EvmSponsorChainConfig, type EvmSponsorConfig, parseEvmSponsorConfig, sponsorChain } from './evm/sponsor-config.ts';

type Stub = DurableObjectStub<EvmRelayer>;

/** Every record (hashes, no raw transactions), the halt, the day's backstop and the last 50 staff actions. */
export const evmRelayerStaffStatus = (stub: Stub): Promise<EvmRelayerStaffStatus> => stub.staffStatus(EVM_RELAYER_STAFF_GUARD) as Promise<EvmRelayerStaffStatus>;

/** Clears the halt after a fresh check of the chain finds no halt condition; refused while one holds. */
export const evmRelayerStaffResume = (stub: Stub, who: string, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> => stub.staffResume(EVM_RELAYER_STAFF_GUARD, who, note, expect) as Promise<EvmRelayerStaffResult>;

/** Closes the record at `nonce` as consumed elsewhere: only when the chain's confirmed count is past it and none of its versions has a receipt. */
export const evmRelayerStaffClose = (stub: Stub, who: string, nonce: number, verdict: 'consumed_elsewhere', note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> =>
  stub.staffClose(EVM_RELAYER_STAFF_GUARD, who, nonce, verdict, note, expect) as Promise<EvmRelayerStaffResult>;

/** Signs a 0-value self-transfer at the SAME nonce for a record with no receipt (its earlier versions kept; a nonce is never freed). */
export const evmRelayerStaffCancel = (stub: Stub, who: string, nonce: number, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> => stub.staffCancel(EVM_RELAYER_STAFF_GUARD, who, nonce, note, expect) as Promise<EvmRelayerStaffResult>;

/** Sends a 0-value self-transfer at a gap nonce (no record, below nextNonce, the chain's next nonce). */
export const evmRelayerStaffFill = (stub: Stub, who: string, nonce: number, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> => stub.staffFill(EVM_RELAYER_STAFF_GUARD, who, nonce, note, expect) as Promise<EvmRelayerStaffResult>;

/** Sets nextNonce to `nonce`, only with nothing unmined and the chain's latest and pending counts both `nonce`. */
export const evmRelayerStaffAdoptNonce = (stub: Stub, who: string, nonce: number, note: string, expect?: EvmRelayerStaffExpect): Promise<EvmRelayerStaffResult> => stub.staffAdoptNonce(EVM_RELAYER_STAFF_GUARD, who, nonce, note, expect) as Promise<EvmRelayerStaffResult>;

// ---- the admin view (D843): AdminRpc's systemStatus, evmRelayDetail and evmRelayAct ----

/** How long a status read waits for the object and for each chain read (the status page waits for the slowest part). Mutable for the tests. */
export const evmRelayerStaffTiming = { relayerMs: 4_000, chainMs: 4_000, budgetMs: 2_500, overviewMs: 6_000 };
/** The account helper program's code hash, per isolate: it changes only by a deploy (D843 review L6). */
const HELPER_TTL_MS = 10 * 60_000;
const helperCache = new Map<string, { at: number; codeHash: string | null }>();
/** Tests only. */
export const forgetHelperCodes = (): void => helperCache.clear();
/** Staff actions a status answer carries (the detail page carries the object's 50). */
const STATUS_LOG = 5;
const DAY_MS = DAY;
const EMPTY_CODE = '0x';

type Setup = { state: 'absent' } | { state: 'bad_config' } | { state: 'on'; config: EvmSponsorConfig };

/** The env's sponsorship block as the relayer object reads it (the same parse, the same pinned delegates). */
function setupOf(env: Env): Setup {
  if (!env.EVM_SPONSOR) return { state: 'absent' };
  const s = parseEvmSponsorConfig(env.EVM_SPONSOR, { network: env.NETWORK, envName: env.ENV_NAME, pinnedDelegates: SPONSOR_DELEGATES });
  return s.status === 'configured' ? { state: 'on', config: s.config } : { state: 'bad_config' };
}

const stubOf = (env: Env, chainId: number): Stub | null => (env.EVM_RELAYER ? env.EVM_RELAYER.get(env.EVM_RELAYER.idFromName(evmRelayerName(chainId))) : null);

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The object's staff status reduced to what staff are shown (no record list: see `recordsOf`). */
export function relayerViewOf(s: EvmRelayerStaffStatus, now: number, logLimit: number): EvmRelayRelayerView {
  const today = Math.floor(now / DAY_MS);
  const u = s.unconfirmedRefusal;
  return {
    started: s.chainId !== null,
    signerAddress: s.address,
    halted: s.halted ? { reason: s.halted.reason, since: s.halted.since, slot: s.halted.nonce ?? null, code: s.halted.code ?? null } : null,
    waiting: s.unmined,
    awaitingConfirmation: s.awaitingConfirmation,
    oldestWaitingMs: s.oldestUnminedMs,
    oldestNotTakenMs: s.oldestUnacceptedMs,
    nextSlot: s.nextNonce,
    // The backstop counts a UTC day: an earlier day's count is not today's spend.
    spentTodayWei: s.day === today ? s.dayWei.toString() : '0',
    unconfirmedRefusals: u ? { count: u.count, lastAt: u.lastAt, slot: u.nonce, code: u.code } : null,
    lastStaffSeq: s.staffLog[0]?.seq ?? 0,
    staffLog: s.staffLog.slice(0, logLimit).map((e) => ({ seq: e.seq, at: e.at, who: e.who, tool: e.action, slot: e.nonce, note: e.note, done: e.done, refused: e.refused })),
  };
}

type RelayerRead = { ok: true; status: EvmRelayerStaffStatus } | { ok: false; code: string };

async function readRelayer(env: Env, chainId: number): Promise<RelayerRead> {
  const stub = stubOf(env, chainId);
  if (!stub) return { ok: false, code: 'relayer_unbound' };
  try {
    return { ok: true, status: await within(evmRelayerStaffTiming.relayerMs, evmRelayerStaffStatus(stub)) };
  } catch (e) {
    return { ok: false, code: evmRelayerError(e)?.code ?? (e instanceof Error && e.message === 'timeout' ? 'relayer_timeout' : 'relayer_unavailable') };
  }
}

const rpcCode = (e: unknown): string => (e instanceof EvmRpcError ? `rpc_${e.kind}` : e instanceof Error && e.message === 'timeout' ? 'rpc_timeout' : 'rpc_unavailable');

/** One chain's view: the object's state, the relayer's balance and the helper's code, each failing on its own. */
async function chainViewOf(env: Env, config: EvmSponsorConfig, chain: Readonly<EvmSponsorChainConfig>, now: number, logLimit: number, relayer?: RelayerRead): Promise<EvmRelayChainView> {
  const keyAddress = evmRelayKeyAddress(env.EVM_RELAY_KEYS);
  const pinned = Object.hasOwn(SPONSOR_DELEGATES, chain.chainId) ? SPONSOR_DELEGATES[chain.chainId]! : null;
  const pinnedCodeHash = pinned && !pinned.placeholder ? pinned.runtimeCodeHash.toLowerCase() : null;
  const rpc = sponsorChainFor(env, chain, { timeoutMs: evmRelayerStaffTiming.chainMs, maxRequests: 4 });
  const [r, budget, balance, code] = await Promise.all([
    relayer ? Promise.resolve(relayer) : readRelayer(env, chain.chainId),
    within(evmRelayerStaffTiming.budgetMs, Promise.resolve().then(() => limiter(env, envBudgetSubject(chain.chainId)).spent(budgetWindow(chain.chainId), DAY, now))).then(
      (spent): EvmRelayChainView['budget'] => (typeof spent === 'string' && /^\d{1,78}$/u.test(spent) ? { ok: true, spentWei: spent } : { ok: false, code: 'rate_limiter_unavailable' }),
      (): EvmRelayChainView['budget'] => ({ ok: false, code: 'rate_limiter_unavailable' }),
    ),
    within(evmRelayerStaffTiming.chainMs, rpc.balance(config.relayerAddress as Hex)).then(
      (wei): EvmRelayChainView['balance'] => ({ ok: true, wei: wei.toString() }),
      (e: unknown): EvmRelayChainView['balance'] => ({ ok: false, code: rpcCode(e) }),
    ),
    helperCode(rpc, chain, now),
  ]);
  if (!(r.ok && budget.ok && balance.ok && code.ok)) log({ event: 'system_status', outcome: 'error', code: 'evm_relay_unreadable', chainId: chain.chainId }, 'warn');
  let helper: EvmRelayChainView['helper'];
  if (!code.ok) helper = { address: chain.delegate, pinnedCodeHash, ok: false, code: code.code };
  else helper = { address: chain.delegate, pinnedCodeHash, ok: true, codeHash: code.codeHash, matches: code.codeHash !== null && code.codeHash === pinnedCodeHash };
  return {
    chainId: chain.chainId,
    readAt: now,
    relayerAddress: config.relayerAddress,
    key: !env.EVM_RELAY_KEYS ? 'missing' : keyAddress === config.relayerAddress ? 'ok' : 'wrong',
    readEndpoint: keyedSponsorRpc(env, chain.chainId) !== null ? 'keyed' : /^local/u.test(env.ENV_NAME) ? 'public' : 'missing',
    lowBalanceWei: chain.lowBalanceWei.toString(),
    dailyBudgetWei: chain.dailyBudgetWei.toString(),
    // deploy-check's floor: one transaction's worst execution cost, doubled on an OP Stack chain for its L1 data fee.
    oneSendWorstWei: (chain.maxGasPerTx * chain.maxFeePerGasWei * (chain.opStack ? 2n : 1n)).toString(),
    relayer: r.ok ? { ok: true, ...relayerViewOf(r.status, now, logLimit) } : r,
    budget,
    balance,
    helper,
  };
}

/** The helper's code hash (null: no code), from the isolate's cache when read in the last 10 minutes. */
async function helperCode(rpc: ReturnType<typeof sponsorChainFor>, chain: Readonly<EvmSponsorChainConfig>, now: number): Promise<{ ok: true; codeHash: string | null } | { ok: false; code: string }> {
  const key = `${chain.chainId}:${chain.delegate.toLowerCase()}`;
  const hit = helperCache.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < HELPER_TTL_MS) return { ok: true, codeHash: hit.codeHash };
  try {
    const c = await within(evmRelayerStaffTiming.chainMs, rpc.code(chain.delegate as Hex));
    const codeHash = c === EMPTY_CODE ? null : `0x${Array.from(keccak_256(hexBytes(c)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (helperCache.size > 16) helperCache.clear();
    helperCache.set(key, { at: now, codeHash });
    return { ok: true, codeHash };
  } catch (e) {
    return { ok: false, code: rpcCode(e) };
  }
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

/**
 * `AdminRpc.systemStatus`'s `evmRelay`, always an explicit state: `absent` without `evm.sponsor` (nothing read),
 * `bad_config` when the API refuses the block (nothing read), `timeout` when the reads didn't finish within
 * `overviewMs` (only this part degrades), else one view per sponsored chain. Never throws.
 */
export async function evmRelayerStaffOverview(env: Env, now: number = Date.now()): Promise<EvmRelayStatus> {
  const setup = setupOf(env);
  if (setup.state === 'absent') return { state: 'absent', chains: [] };
  if (setup.state === 'bad_config') return { state: 'bad_config', chains: [] };
  const chains = Object.values(setup.config.chains).sort((a, b) => a.chainId - b.chainId);
  try {
    return { state: 'on', chains: await within(evmRelayerStaffTiming.overviewMs, Promise.all(chains.map((c) => chainViewOf(env, setup.config, c, now, STATUS_LOG)))) };
  } catch {
    log({ event: 'system_status', outcome: 'error', code: 'evm_relay_timeout' }, 'warn');
    return { state: 'timeout', chains: [] };
  }
}

function configuredChain(env: Env, chainId: number): { config: EvmSponsorConfig; chain: Readonly<EvmSponsorChainConfig> } {
  const setup = setupOf(env);
  if (setup.state !== 'on') throw new RpcRefusal('not_found', 'EVM sponsorship is not set up in this environment');
  const chain = sponsorChain(setup.config, chainId);
  if (!chain) throw new RpcRefusal('not_found', `Chain ${chainId} is not a sponsored chain here`);
  return { config: setup.config, chain };
}

/** The app of each user action, from the sponsorship's send records (`evm_sponsor_sends`, by chain and digest), or null when the read failed. */
async function appsOf(db: D1Database, chainId: number, digests: string[]): Promise<Map<string, { id: string; name: string | null }> | null> {
  const list = digests.map((d) => d.toLowerCase()).slice(0, 64);
  const marks = list.map((_d, i) => `?${i + 2}`).join(', ');
  try {
    const rows = await db
      .prepare(
        `SELECT s.digest AS digest, s.app_id AS app_id, a.name AS name FROM evm_sponsor_sends s LEFT JOIN apps a ON a.id = s.app_id
          WHERE s.chain_id = ?1 AND ${list.length ? `s.digest IN (${marks})` : '0'} ORDER BY s.created_at`,
      )
      .bind(chainId, ...list)
      .all<{ digest: string; app_id: string; name: string | null }>();
    // The newest row per digest wins (a replay row names the same app).
    return new Map(rows.results.map((r) => [r.digest.toLowerCase(), { id: r.app_id, name: r.name ?? null }]));
  } catch {
    log({ event: 'evm_relay_detail', outcome: 'error', code: 'apps_unreadable' }, 'warn');
    return null;
  }
}

/** The object's records as staff see them: slot, kind, where it stands, its copies' hashes, the app. Oldest slot first. */
export function recordsOf(s: EvmRelayerStaffStatus, apps: Map<string, { id: string; name: string | null }> | null): EvmRelayRecordView[] {
  return [...s.records]
    .sort((a, b) => a.nonce - b.nonce)
    .map((r) => ({
      slot: r.nonce,
      kind: r.digest ? 'action' : 'filler',
      onChain: r.seen !== null,
      taken: r.accepted,
      cancelling: r.versions[r.versions.length - 1]?.kind === 'cancel',
      sentAt: r.sentAt,
      deadlineAt: r.deadline * 1000,
      copies: r.versions.map((v) => ({ hash: v.hash, kind: v.kind === 'cancel' ? 'cancel' : 'action' })),
      refusedCode: r.batchRejected ?? r.cannotSend ?? null,
      app: r.digest ? (apps?.get(r.digest.toLowerCase()) ?? null) : null,
    }));
}

/** `AdminRpc.evmRelayDetail`: one chain's view with its whole staff log, and every transaction the relayer holds. */
export async function evmRelayerStaffDetail(env: Env, db: D1Database, chainId: number, now: number = Date.now()): Promise<EvmRelayDetail> {
  const { config, chain } = configuredChain(env, chainId);
  const relayer = await readRelayer(env, chainId);
  const rpc = sponsorChainFor(env, chain, { timeoutMs: evmRelayerStaffTiming.chainMs, maxRequests: 4 });
  // The network's own count for the relayer's address (as the relayer reads it: the trusted endpoint), for "Set the next slot number".
  const count = Promise.all([rpc.transactionCount(config.relayerAddress as Hex, 'latest'), rpc.transactionCount(config.relayerAddress as Hex, 'pending')]);
  const [view, apps, chainCount] = await Promise.all([
    chainViewOf(env, config, chain, now, 50, relayer),
    relayer.ok ? appsOf(db, chainId, relayer.status.records.flatMap((r) => (r.digest ? [r.digest] : []))) : Promise.resolve(null),
    within(evmRelayerStaffTiming.chainMs, count).then(
      ([latest, pending]): EvmRelayDetail['chainCount'] => ({ ok: true, latest, pending }),
      (e: unknown): EvmRelayDetail['chainCount'] => ({ ok: false, code: rpcCode(e) }),
    ),
  ]);
  return { chain: view, records: relayer.ok ? recordsOf(relayer.status, apps) : [], apps: apps ? 'recorded' : 'unreadable', chainCount };
}

/** Prefixed to a Resume's note in the relayer's own log when the staffer confirmed the key (a leak-type halt). */
export const KEY_CONFIRMED_NOTE = '[An engineer confirmed the key is safe or replaced] ';

/**
 * `AdminRpc.evmRelayAct`: one staff tool, as `who` (the staff email). Refused here before the relayer is called, as a
 * value: a Cancel of a slot whose time limit hasn't passed outside a `stuck_past_deadline` halt (`not_past_deadline`),
 * a Resume after a halt that means the key may be used by someone else without the staffer's confirmation that an
 * engineer said it is safe or replaced (`key_confirmation_required`). Then the tool, given what the page showed
 * (`seen`): the relayer checks it inside its queue (`version_conflict`, answered as RpcRefusal), checks the chain and
 * refuses unsafe use itself, and its answer is final (never retried or worked around). A coded error from the object:
 * it refused before doing anything. Anything else thrown: unknown whether it acted (`refused: 'unknown'`).
 */
export async function evmRelayerStaffAct(env: Env, input: EvmRelayActInput, who: string, now: number = Date.now()): Promise<EvmRelayActResult> {
  configuredChain(env, input.chainId);
  const stub = stubOf(env, input.chainId);
  if (!stub) return { done: false, refused: 'relayer_unbound', relayer: null };
  const before = await readRelayer(env, input.chainId);
  if (!before.ok) return { done: false, refused: before.code, relayer: null };
  const s = before.status;
  // A cheap early answer for a stale page; the relayer checks the same again inside its queue (the one that counts).
  if ((s.halted?.since ?? null) !== input.seen.haltSince || (s.staffLog[0]?.seq ?? 0) !== input.seen.lastStaffSeq) {
    throw new RpcRefusal('version_conflict', 'The relayer changed since the page was read: nothing was done');
  }
  const slot = input.slot ?? 0;
  if (input.tool === 'cancel') {
    const rec = s.records.find((r) => r.nonce === slot);
    if (rec && rec.deadline * 1000 > now && s.halted?.reason !== 'stuck_past_deadline') return { done: false, refused: 'not_past_deadline', relayer: null };
  }
  if (input.tool === 'resume' && isLeakHalt(s.halted) && input.keyConfirmed !== true) return { done: false, refused: 'key_confirmation_required', relayer: null };
  const note = input.tool === 'resume' && input.keyConfirmed === true ? `${KEY_CONFIRMED_NOTE}${input.note}` : input.note;
  const expect: EvmRelayerStaffExpect = { haltSince: input.seen.haltSince, lastStaffSeq: input.seen.lastStaffSeq };
  let r: EvmRelayerStaffResult;
  try {
    switch (input.tool) {
      case 'resume':
        r = await evmRelayerStaffResume(stub, who, note, expect);
        break;
      case 'cancel':
        r = await evmRelayerStaffCancel(stub, who, slot, note, expect);
        break;
      case 'close':
        r = await evmRelayerStaffClose(stub, who, slot, 'consumed_elsewhere', note, expect);
        break;
      case 'fill':
        r = await evmRelayerStaffFill(stub, who, slot, note, expect);
        break;
      case 'adopt_nonce':
        r = await evmRelayerStaffAdoptNonce(stub, who, slot, note, expect);
        break;
      default: {
        // Exhaustive: a tool this code doesn't know is refused, never mapped to another one.
        const unknownTool: never = input.tool;
        void unknownTool;
        return { done: false, refused: 'invalid_request', relayer: null };
      }
    }
  } catch (e) {
    const c = evmRelayerError(e);
    if (c) return { done: false, refused: c.code, relayer: null };
    log({ event: 'evm_relayer_staff_call', outcome: 'error', code: 'unknown', chainId: input.chainId }, 'error');
    return { done: false, refused: 'unknown', relayer: null };
  }
  if (r.refused === 'version_conflict') throw new RpcRefusal('version_conflict', 'The relayer changed since the page was read: nothing was done');
  return { done: r.done, refused: r.refused, relayer: relayerViewOf(r.status, now, 50) };
}
