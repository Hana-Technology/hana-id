// Minimal NEAR JSON-RPC client (ported from legacy/relayer/embed-relayer.ts).
import { base64Decode, base64Encode } from '../bytes.ts';

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

export interface FinalOutcome {
  status: { SuccessValue?: string; Failure?: unknown } | string;
  /** Every receipt's outcome; `executor_id` is the account that ran it (the contract, or a contract it called). */
  receipts_outcome?: { outcome: { logs?: string[]; executor_id?: string; status: { Failure?: unknown } | string } }[];
  transaction?: { hash: string };
  final_execution_status?: string;
}

export interface SendTxResult extends Partial<FinalOutcome> {
  final_execution_status?: string;
}

export class Rpc {
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-id-api', method, params }),
      });
    } catch (err) {
      throw new RpcError(`NEAR RPC unreachable: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    let body: { result?: T; error?: RpcErrorBody };
    try {
      body = (await res.json()) as { result?: T; error?: RpcErrorBody };
    } catch {
      // 408/504 from the RPC proxy means it gave up waiting, like the TIMEOUT error.
      throw new RpcError(res.status === 408 || res.status === 504 ? 'TIMEOUT' : `NEAR RPC answered HTTP ${res.status}`, null, res.status);
    }
    if (body.error) throw new RpcError(rpcErrorText(body.error), body.error, res.status);
    if (body.result === undefined) throw new RpcError(`NEAR RPC answered HTTP ${res.status} without a result`, null, res.status);
    return body.result;
  }

  /** View call (`call_function`); decodes the JSON the contract returned. */
  async view<T>(accountId: string, methodName: string, args: unknown, finality: 'optimistic' | 'final' = 'optimistic'): Promise<T> {
    const result = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality,
      account_id: accountId,
      method_name: methodName,
      args_base64: base64Encode(new TextEncoder().encode(JSON.stringify(args))),
    });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
  }

  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView> {
    return this.call<AccessKeyView>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey });
  }

  async latestBlockHash(): Promise<string> {
    const block = await this.call<{ header: { hash: string } }>('block', { finality: 'final' });
    return block.header.hash;
  }

  sendTx(signedTxBytes: Uint8Array, waitUntil: TxWaitUntil): Promise<SendTxResult> {
    return this.call<SendTxResult>('send_tx', { signed_tx_base64: base64Encode(signedTxBytes), wait_until: waitUntil });
  }

  txStatus(txHash: string, senderId: string, waitUntil: TxWaitUntil = RELAY_WAIT_UNTIL): Promise<FinalOutcome> {
    return this.call<FinalOutcome>('tx', { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil });
  }
}

/** Decodes a `SuccessValue` (base64 JSON). Empty → null. */
export function decodeSuccessValue(value: string | undefined): unknown {
  if (!value) return null;
  return JSON.parse(new TextDecoder().decode(base64Decode(value)));
}
