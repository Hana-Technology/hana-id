// Minimal NEAR JSON-RPC client for the scripts: view calls, account/key queries, and signed transactions.
// Secret keys stay inside KeyPair objects and are never printed; errors carry RPC text only.
import { createHash } from 'node:crypto';
import type { KeyPair, PublicKey } from '@near-js/crypto';
import { type Action, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode, parseNearAmount } from '@near-js/utils';

export const TGAS = 1_000_000_000_000n;
/** Code hash NEAR reports for an account with no contract. */
export const EMPTY_CODE_HASH = '11111111111111111111111111111111';
/** Storage staking cost: 1e19 yoctoNEAR per byte (0.00001 NEAR). */
export const STORAGE_YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;

interface RpcErrorBody {
  name?: string;
  cause?: { name?: string; info?: unknown };
  data?: unknown;
  message?: string;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly rpc: RpcErrorBody,
  ) {
    super(message);
  }
}

function rpcErrorText(e: RpcErrorBody): string {
  return [e.cause?.name ?? e.name, typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? e.cause?.info ?? e.message)].filter(Boolean).join(': ');
}

export interface AccountView {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

export interface AccessKeyView {
  nonce: number;
  permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
}

export interface AccessKeyListEntry {
  public_key: string;
  access_key: AccessKeyView;
}

/** One receipt's logs and the account that executed it. */
export interface ReceiptLogs {
  executor: string;
  logs: string[];
}

export interface FinalOutcome {
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: { outcome: { logs: string[]; status: { Failure?: unknown }; executor_id?: string } }[];
  transaction: { hash: string };
}

/** The first failure anywhere in the receipt tree, as readable text (ported from the legacy relayer). */
export function failureText(outcome: FinalOutcome): string | null {
  const failed = outcome.receipts_outcome.find((r) => r.outcome.status.Failure);
  const failure = outcome.status.Failure ?? failed?.outcome.status.Failure;
  if (!failure) return null;
  const text = JSON.stringify(failure);
  const panic = /"panic_msg":"([^"]+)"/u.exec(text)?.[1] ?? /ExecutionError":"([^"]+)"/u.exec(text)?.[1];
  return panic ?? text;
}

/** Decodes a `SuccessValue` (base64 JSON) or returns null for an empty value. */
export function successValue(outcome: FinalOutcome): unknown {
  const v = outcome.status.SuccessValue;
  if (!v) return null;
  const text = Buffer.from(v, 'base64').toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** NEAR's account `code_hash` of a wasm: base58(sha256(code)). */
export function codeHashOf(code: Uint8Array): string {
  return baseEncode(new Uint8Array(createHash('sha256').update(code).digest()));
}

/** NEAR amount string ("1", "0.5") → yoctoNEAR. */
export function nearToYocto(amount: string): bigint {
  if (!/^\d+(\.\d+)?$/u.test(amount)) throw new Error(`Invalid NEAR amount: ${amount}`);
  const yocto = parseNearAmount(amount);
  if (yocto === null) throw new Error(`Invalid NEAR amount: ${amount}`);
  return BigInt(yocto);
}

/** yoctoNEAR → "1.2345 NEAR" (4 decimals, rounded down). */
export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = ((yocto % 10n ** 24n) / 10n ** 20n).toString().padStart(4, '0');
  return `${whole}.${frac} NEAR`;
}

const isTimeout = (err: unknown) => /TIMEOUT|UNKNOWN_TRANSACTION/u.test((err as Error).message);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TxSigner {
  accountId: string;
  keyPair: KeyPair;
}

export class NearRpc {
  constructor(readonly url: string) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-id-scripts', method, params }),
    });
    if (!res.ok && res.status !== 400 && res.status !== 500) throw new Error(`NEAR RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T & { error?: string }; error?: RpcErrorBody };
    if (body.error) throw new RpcError(rpcErrorText(body.error), body.error);
    // Query errors (e.g. contract panic in a view) come back as result.error.
    if (body.result && typeof body.result === 'object' && typeof body.result.error === 'string') {
      throw new RpcError(body.result.error, { message: body.result.error });
    }
    return body.result as T;
  }

  async chainId(): Promise<string> {
    const status = await this.call<{ chain_id: string }>('status', []);
    return status.chain_id;
  }

  /** Calls a view method; returns the parsed JSON result. */
  async view<T>(accountId: string, method: string, args: unknown = {}): Promise<T> {
    const result = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    const text = Buffer.from(result.result).toString('utf8');
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The account, or null if it doesn't exist. */
  async account(accountId: string): Promise<AccountView | null> {
    try {
      return await this.call<AccountView>('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
    } catch (err) {
      if (/UNKNOWN_ACCOUNT|does not exist/u.test((err as Error).message)) return null;
      throw err;
    }
  }

  async accessKeys(accountId: string): Promise<AccessKeyListEntry[]> {
    const res = await this.call<{ keys: AccessKeyListEntry[] }>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId });
    return res.keys;
  }

  async accessKey(accountId: string, publicKey: string): Promise<(AccessKeyView & { block_hash: string }) | null> {
    try {
      return await this.call<AccessKeyView & { block_hash: string }>('query', {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: accountId,
        public_key: publicKey,
      });
    } catch (err) {
      if (/UNKNOWN_ACCESS_KEY|does not exist/u.test((err as Error).message)) return null;
      throw err;
    }
  }

  /**
   * Signs and sends one transaction, waits for it to be final, throws on any failure in the receipt tree.
   * `receiptLogs`: each receipt's executor and logs, in the order the RPC lists them (a DAO vote's executed call logs
   * its events there; a reader trusts an event only from the contract it expects, never any receipt's).
   */
  async sendTx(signer: TxSigner, receiverId: string, actions: Action[], timeoutMs = 120_000): Promise<{ hash: string; value: unknown; receiptLogs?: ReceiptLogs[] }> {
    const publicKey: PublicKey = signer.keyPair.getPublicKey();
    const key = await this.accessKey(signer.accountId, publicKey.toString());
    if (!key) throw new Error(`Key ${publicKey.toString()} is not an access key of ${signer.accountId}`);
    const tx = createTransaction(signer.accountId, publicKey, receiverId, BigInt(key.nonce) + 1n, actions, baseDecode(key.block_hash));
    const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest());
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: publicKey.keyType, data: signer.keyPair.sign(digest).signature }) });
    const hash = baseEncode(digest);

    let outcome: FinalOutcome | null = null;
    try {
      outcome = await this.call<FinalOutcome>('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'FINAL' });
    } catch (err) {
      if (!isTimeout(err)) throw new Error(`NEAR rejected transaction ${hash}: ${(err as Error).message}`);
    }
    const deadline = Date.now() + timeoutMs;
    const settled = (o: FinalOutcome | null): o is FinalOutcome => !!o && ('SuccessValue' in o.status || 'Failure' in o.status);
    while (!settled(outcome)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for transaction ${hash}`);
      await sleep(1000);
      try {
        outcome = await this.call<FinalOutcome>('tx', { tx_hash: hash, sender_account_id: signer.accountId, wait_until: 'FINAL' });
      } catch (err) {
        if (!isTimeout(err)) throw err;
      }
    }
    const failure = failureText(outcome);
    if (failure) throw new Error(`Transaction ${hash} failed: ${failure}`);
    return { hash, value: successValue(outcome), receiptLogs: outcome.receipts_outcome.map((r) => ({ executor: r.outcome.executor_id ?? '', logs: r.outcome.logs ?? [] })) };
  }
}

/** True if the key list grants `publicKey` full access. */
export function hasFullAccess(keys: AccessKeyListEntry[], publicKey: string): boolean {
  return keys.some((k) => k.public_key === publicKey && k.access_key.permission === 'FullAccess');
}

/** What an access key may do, for messages: "a full-access key", "a function-call key for x (methods a, b)". */
export function describePermission(permission: AccessKeyView['permission']): string {
  if (permission === 'FullAccess') return 'a full-access key';
  const fc = permission.FunctionCall;
  const methods = fc.method_names.length ? `methods ${fc.method_names.join(', ')}` : 'ANY method';
  return `a function-call key for ${fc.receiver_id} (${methods})`;
}

export function explorerTx(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}
