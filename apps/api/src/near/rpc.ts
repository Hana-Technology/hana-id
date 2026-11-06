// Minimal NEAR JSON-RPC client (ported from legacy/relayer/embed-relayer.ts), over the env's ordered endpoints with
// failover (D432: see Rpc).
import { base64Decode, base64Encode } from '../bytes.ts';
import { log } from '../log.ts';

export interface RpcErrorBody {
  name?: string;
  cause?: { name?: string; info?: unknown };
  data?: unknown;
  message?: string;
  code?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly rpc: RpcErrorBody | null,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function rpcErrorText(e: RpcErrorBody): string {
  const detail = typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? e.cause?.info ?? e.message ?? null);
  return [e.cause?.name ?? e.name, detail].filter(Boolean).join(': ');
}

/** RPC gave up waiting (the tx may still land): poll again. */
export const isTimeout = (err: unknown): boolean => err instanceof Error && /TIMEOUT|UNKNOWN_TRANSACTION|timed out/iu.test(err.message);

/**
 * The node definitely did not accept the tx: it validated and refused it (INVALID_TRANSACTION / InvalidTxError), or
 * could not even parse the request. Anything else after a broadcast (network error, non-JSON 5xx from a proxy,
 * internal errors) says nothing about whether the tx was forwarded, so the caller must poll for its outcome.
 */
export function isDefiniteRejection(err: unknown): boolean {
  if (!(err instanceof RpcError) || !err.rpc) return false;
  return /INVALID_TRANSACTION|InvalidTxError|REQUEST_VALIDATION_ERROR|PARSE_ERROR/u.test(JSON.stringify(err.rpc));
}

/**
 * A transport-level or "not yet" failure while polling (timeouts, unknown tx, network errors, non-JSON or 5xx/408/429
 * answers, node-internal errors): the outcome is still unknown, keep polling.
 */
export function isTransient(err: unknown): boolean {
  if (isTimeout(err)) return true;
  if (!(err instanceof RpcError)) return true;
  if (!err.rpc) return true;
  const s = err.httpStatus;
  if (s === 408 || s === 429 || (s !== undefined && s >= 500)) return true;
  return /INTERNAL_ERROR|NO_SYNCED_BLOCKS|NOT_SYNCED_YET/u.test(JSON.stringify(err.rpc));
}

/** UNKNOWN_TRANSACTION: the node knows nothing about the tx (yet, or ever if it was dropped). */
export const isUnknownTx = (err: unknown): boolean => err instanceof Error && /UNKNOWN_TRANSACTION/u.test(err.message + JSON.stringify((err as RpcError).rpc ?? null));

/** The node rejected the tx because the access key has already used this nonce. Returns ak_nonce when present. */
export function invalidNonce(err: unknown): { akNonce: bigint | null } | null {
  if (!(err instanceof Error) || !/InvalidNonce/u.test(err.message + JSON.stringify((err as RpcError).rpc ?? null))) return null;
  const m = /"ak_nonce":\s*(\d+)/u.exec(JSON.stringify((err as RpcError).rpc ?? null) + err.message);
  return { akNonce: m?.[1] ? BigInt(m[1]) : null };
}

/** The tx's block hash is too old (or from a fork): refresh it and retry. */
export const isExpired = (err: unknown): boolean => err instanceof Error && /\bExpired\b/u.test(err.message + JSON.stringify((err as RpcError).rpc ?? null));

export type TxWaitUntil = 'NONE' | 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'EXECUTED' | 'FINAL';

/**
 * Relayed transactions are answered once every receipt has executed (EXECUTED_OPTIMISTIC), not once the blocks are
 * final (EXECUTED: 1–2 s later, measured on testnet). Nothing the API returns depends on finality: a session or key
 * from a block that were never finalised would only make the next call fail on chain, and the CKD answer is the
 * same for the same request.
 */
export const RELAY_WAIT_UNTIL: TxWaitUntil = 'EXECUTED_OPTIMISTIC';

export interface AccessKeyView {
  nonce: number | string;
  block_hash: string;
  block_height?: number;
}

/** One entry of `view_access_key_list`. `allowance` is yoctoNEAR (a string), null for an unlimited function-call key. */
export interface AccessKeyListEntry {
  public_key: string;
  access_key: {
    nonce: number | string;
    permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

/**
 * What one execution step burnt: `gas_burnt` (a JSON number; a u64 that stays far below 2^53 per step, ≤ 300 Tgas)
 * and `tokens_burnt` (yoctoNEAR, a u128 as a decimal string). Read with care: sums use BigInt (near/tx.ts burntGas).
 */
export interface BurntGas {
  gas_burnt?: number | string;
  tokens_burnt?: string;
}

export interface FinalOutcome {
  status: { SuccessValue?: string; Failure?: unknown } | string;
  /** The transaction's own conversion step (it creates the first receipt). */
  transaction_outcome?: { outcome: BurntGas };
  /** Every receipt's outcome; `executor_id` is the account that ran it (the contract, or a contract it called). */
  receipts_outcome?: { outcome: BurntGas & { logs?: string[]; executor_id?: string; status: { Failure?: unknown } | string } }[];
  transaction?: { hash: string };
  final_execution_status?: string;
}

export interface SendTxResult extends Partial<FinalOutcome> {
  final_execution_status?: string;
}

/**
 * How long every read (`view`/call_function, the access key views, `block`) waits for one endpoint: a node that
 * stalls fails that endpoint (an RpcError: the next endpoint is asked, and when none answers the endpoints answer
 * 502 near_unavailable and the vault asks GET /v1/app once more) instead of holding the request open. A healthy view
 * answers in ≈ 0.3 s. The same bound as the vault's own RPC calls (packages/web near-call.ts; D261, D432).
 */
export const VIEW_TIMEOUT_MS = 8_000;

/**
 * How long a transaction call (`send_tx`, `tx`) waits for one endpoint (D432). Above the node's own wait (nearcore
 * answers TIMEOUT_ERROR after ~10 s, an answer: the caller polls again), so a healthy node answers first; a node that
 * holds the request past it is treated as down and the next endpoint is asked.
 */
export const TX_TIMEOUT_MS = 20_000;

/** How long an endpoint that failed (network, timeout, 5xx, 429, no JSON-RPC answer) is asked after the others. */
export const RPC_DOWN_MS = 30_000;

/** At most this many fallbacks after NEAR_RPC: each can add a timeout's wait to a call (packages/env caps it too). */
export const MAX_RPC_FALLBACKS = 3;

type RpcEnv = { NEAR_RPC: string; NEAR_RPC_FALLBACKS?: string | undefined };

/**
 * The endpoints the API asks, in order (D432): NEAR_RPC, then NEAR_RPC_FALLBACKS (a JSON array of URLs that
 * gen-wrangler writes from the manifest's `apiRpcFallbacks`, or `rpcFallback` when that is unset). Entries that aren't
 * http(s) URLs or repeat an earlier one are dropped, and only the first MAX_RPC_FALLBACKS are kept; a value that isn't
 * a JSON array means no fallback. The manifest schema refuses all of these, so a generated config never has them.
 */
export function rpcEndpoints(env: RpcEnv): string[] {
  const urls = [env.NEAR_RPC];
  let extra: unknown = [];
  try {
    extra = env.NEAR_RPC_FALLBACKS ? JSON.parse(env.NEAR_RPC_FALLBACKS) : [];
  } catch {
    extra = [];
  }
  if (!Array.isArray(extra)) return urls;
  for (const u of extra) {
    if (urls.length > MAX_RPC_FALLBACKS) break;
    if (typeof u !== 'string' || urls.includes(u) || !isHttpUrl(u)) continue;
    urls.push(u);
  }
  return urls;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** An Rpc over this env's endpoints (rpcEndpoints). Every API read and transaction goes through one. */
export const nearRpc = (env: RpcEnv): Rpc => new Rpc(rpcEndpoints(env));

/**
 * Which endpoints failed lately, per isolate: one that failed within RPC_DOWN_MS is asked after the others, so an
 * outage of the primary costs one timeout per isolate every RPC_DOWN_MS rather than one per call. It never drops an
 * endpoint: when every endpoint is down they are asked in the configured order.
 */
export class RpcHealth {
  private readonly downUntil = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  /** The indexes of `urls`: the ones up, in order, then the ones down, in order. */
  order(urls: readonly string[]): number[] {
    const t = this.now();
    const up: number[] = [];
    const down: number[] = [];
    urls.forEach((u, i) => ((this.downUntil.get(u) ?? 0) > t ? down : up).push(i));
    return [...up, ...down];
  }

  failed(url: string): void {
    this.downUntil.set(url, this.now() + RPC_DOWN_MS);
  }

  ok(url: string): void {
    this.downUntil.delete(url);
  }

  clear(): void {
    this.downUntil.clear();
  }
}

/** The isolate's health record, shared by every Rpc in it (tests clear it). */
export const rpcHealth = new RpcHealth();

/** Why an endpoint was passed over: the `code` of `near_rpc_failover` (never the URL, which can carry an API key). */
export type FailoverReason = 'network' | 'timeout' | 'http_5xx' | 'http_429' | 'not_jsonrpc' | 'not_synced';

/**
 * JSON-RPC errors by which the node says it can't answer at all yet (no synced block): no answer about the chain, like
 * a 503 (the watchdog treats them the same way).
 */
const NOT_SYNCED = new Set(['NO_SYNCED_BLOCKS', 'NOT_SYNCED_YET']);

type Attempt<T> = { ok: true; value: T } | { ok: false; error: RpcError; failover: FailoverReason | null };

export interface RpcOptions {
  /** How long each read gives up after, per endpoint (default VIEW_TIMEOUT_MS). */
  viewTimeoutMs?: number;
  /** How long each `send_tx` and `tx` gives up after, per endpoint (default TX_TIMEOUT_MS). */
  txTimeoutMs?: number;
  /** Default: the isolate's rpcHealth. */
  health?: RpcHealth;
}

/**
 * NEAR JSON-RPC over an ordered list of endpoints (D432). A call goes to one endpoint and moves to the next only when
 * that endpoint gave no JSON-RPC answer: a network error, its timeout, HTTP 5xx or 429, a body that isn't a JSON-RPC
 * response (not JSON, or neither `result` nor `error`), or the node saying it has no synced block. Every other answer
 * is final, a JSON-RPC error included (an unknown account, a contract panic, InvalidNonce, TIMEOUT_ERROR,
 * UNKNOWN_TRANSACTION): an answer is never put to another provider to get a different one.
 *
 * Within one Rpc (one request, relay or cron run) calls stay on the endpoint that answered last, so a transaction's
 * broadcast, its status polls and the relayer's nonce check read one node unless that node fails.
 *
 * A broadcast (`send_tx`) that fails over sends the same signed bytes to the next endpoint. That is safe on chain (one
 * hash, one nonce: it is included at most once), but the first endpoint may have forwarded it, so a later endpoint's
 * JSON-RPC error no longer says anything definite about it (it could answer InvalidNonce because the first broadcast
 * landed). After a failover the broadcast's error is therefore an unknown outcome (an RpcError without a body), which
 * every caller polls by hash, never InvalidNonce, Expired or a rejection, which the callers answer by signing a new
 * transaction (a second execution). A result after a failover is returned: it is the same transaction's.
 */
export class Rpc {
  private readonly urls: readonly string[];
  private readonly viewTimeoutMs: number;
  private readonly txTimeoutMs: number;
  private readonly health: RpcHealth;
  /** The endpoint that answered last (an index into urls): asked first. */
  private current: number | null = null;

  constructor(urls: string | readonly string[], opts: RpcOptions = {}) {
    this.urls = typeof urls === 'string' ? [urls] : [...urls];
    if (this.urls.length === 0) throw new Error('Rpc needs at least one endpoint');
    this.viewTimeoutMs = opts.viewTimeoutMs ?? VIEW_TIMEOUT_MS;
    this.txTimeoutMs = opts.txTimeoutMs ?? TX_TIMEOUT_MS;
    this.health = opts.health ?? rpcHealth;
  }

  /** The order this call asks the endpoints in: the one that answered last, then the rest by health. */
  private order(): number[] {
    const byHealth = this.health.order(this.urls);
    const current = this.current;
    return current === null ? byHealth : [current, ...byHealth.filter((i) => i !== current)];
  }

  /**
   * One JSON-RPC call, failing over as the class comment says; `timeoutMs` is per endpoint, `broadcast` marks a
   * send_tx (its error after a failover is an unknown outcome). Throws the last endpoint's RpcError.
   */
  async call<T>(method: string, params: unknown, timeoutMs: number, broadcast = false): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'hana-id-api', method, params });
    const order = this.order();
    let failedOver = false;
    let last: RpcError = new RpcError('NEAR RPC: no endpoint', null);
    for (const [n, i] of order.entries()) {
      const url = this.urls[i] as string;
      const attempt = await callOne<T>(url, body, timeoutMs);
      if (attempt.ok || attempt.failover === null) {
        this.current = i;
        this.health.ok(url);
        if (attempt.ok) return attempt.value;
        throw broadcast && failedOver ? unknownBroadcast() : attempt.error;
      }
      this.health.failed(url);
      if (this.current === i) this.current = null;
      last = attempt.error;
      const next = order[n + 1];
      if (next !== undefined) {
        failedOver = true;
        log({ event: 'near_rpc_failover', method, code: attempt.failover, rpcEndpoint: i, nextRpcEndpoint: next }, 'warn');
      }
    }
    throw broadcast && failedOver ? unknownBroadcast() : last;
  }

  /** View call (`call_function`); decodes the JSON the contract returned. */
  async view<T>(accountId: string, methodName: string, args: unknown, finality: 'optimistic' | 'final' = 'optimistic'): Promise<T> {
    const result = await this.call<{ result: number[] }>(
      'query',
      {
        request_type: 'call_function',
        finality,
        account_id: accountId,
        method_name: methodName,
        args_base64: base64Encode(new TextEncoder().encode(JSON.stringify(args))),
      },
      this.viewTimeoutMs,
    );
    return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
  }

  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView> {
    return this.call<AccessKeyView>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey }, this.viewTimeoutMs);
  }

  /** Every access key on `accountId` (`view_access_key_list`), as the RPC returns them. */
  viewAccessKeyList(accountId: string): Promise<{ keys: AccessKeyListEntry[] }> {
    return this.call<{ keys: AccessKeyListEntry[] }>('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: accountId }, this.viewTimeoutMs);
  }

  async latestBlockHash(): Promise<string> {
    const block = await this.call<{ header: { hash: string } }>('block', { finality: 'final' }, this.viewTimeoutMs);
    return block.header.hash;
  }

  /** The broadcast: see the class comment for what a failover does to its errors. */
  sendTx(signedTxBytes: Uint8Array, waitUntil: TxWaitUntil): Promise<SendTxResult> {
    return this.call<SendTxResult>('send_tx', { signed_tx_base64: base64Encode(signedTxBytes), wait_until: waitUntil }, this.txTimeoutMs, true);
  }

  /** A status read by hash: fails over like any read (asking another node about one hash can't run anything). */
  txStatus(txHash: string, senderId: string, waitUntil: TxWaitUntil = RELAY_WAIT_UNTIL): Promise<FinalOutcome> {
    return this.call<FinalOutcome>('tx', { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil }, this.txTimeoutMs);
  }
}

/**
 * A broadcast whose first endpoint failed: whatever a later endpoint said, the first may have forwarded it and it may
 * still execute. No body and no node text, so isDefiniteRejection, invalidNonce and isExpired never match it and
 * isTransient does: the caller polls the hash (D432).
 */
function unknownBroadcast(): RpcError {
  return new RpcError('NEAR RPC: the broadcast failed over to another endpoint; its outcome is not known yet', null);
}

/** One endpoint's answer; or its error, with why the call moves on (`failover`) or null when the error is final. */
async function callOne<T>(url: string, body: string, timeoutMs: number): Promise<Attempt<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, error: new RpcError(`NEAR RPC unreachable: ${err instanceof Error ? err.message : String(err)}`, null), failover: timedOut ? 'timeout' : 'network' };
  }
  const status = res.status;
  const transport: FailoverReason | null = status === 429 ? 'http_429' : status >= 500 ? 'http_5xx' : null;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // 408/504 from the RPC proxy means it gave up waiting, like the TIMEOUT error.
    return { ok: false, error: new RpcError(status === 408 || status === 504 ? 'TIMEOUT' : `NEAR RPC answered HTTP ${status}`, null, status), failover: transport ?? 'not_jsonrpc' };
  }
  const answer = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { result?: T; error?: RpcErrorBody };
  if (answer.error) {
    const notSynced = NOT_SYNCED.has(answer.error.cause?.name ?? '') || NOT_SYNCED.has(answer.error.name ?? '');
    return { ok: false, error: new RpcError(rpcErrorText(answer.error), answer.error, status), failover: transport ?? (notSynced ? 'not_synced' : null) };
  }
  if (answer.result === undefined) return { ok: false, error: new RpcError(`NEAR RPC answered HTTP ${status} without a result`, null, status), failover: transport ?? 'not_jsonrpc' };
  if (transport) return { ok: false, error: new RpcError(`NEAR RPC answered HTTP ${status}`, null, status), failover: transport };
  return { ok: true, value: answer.result };
}

/** Decodes a `SuccessValue` (base64 JSON). Empty → null. */
export function decodeSuccessValue(value: string | undefined): unknown {
  if (!value) return null;
  return JSON.parse(new TextDecoder().decode(base64Decode(value)));
}
