// The watchdog's own NEAR access: JSON-RPC reads (NEAR_RPC, then NEAR_RPC_FALLBACK when it errors or times out) and
// function calls signed with WATCHDOG_KEY. Never through the API (docs/governance-spec.md "Watchdog service").
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import type { ChainReader, ChainSnapshot, ChainWriter, ConfigView, GovernanceView, IssuerKey, IssuerView, KeyChange, OwnerAccount, TxResult, WatchdogMethod } from './chain.ts';
import { WATCHDOG_METHODS } from './chain.ts';
import { log } from './log.ts';

/** Per RPC request. */
export const RPC_TIMEOUT_MS = 8_000;
/** Each watchdog call is a small state change (cancel/confirm/pause) or one DeleteKey promise. */
export const WATCHDOG_GAS = 30_000_000_000_000n;
const OUTCOME_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

export class RpcError extends Error {
  constructor(
    message: string,
    /** True when the request may not have reached a node (network, timeout, 5xx): try the fallback, or poll. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};


export class Rpc {
  constructor(
    private readonly urls: string[],
    private readonly timeoutMs: number = RPC_TIMEOUT_MS,
  ) {}

  /** Tries each URL in turn while the error is transient; a node's own error answer is final. */
  async call<T>(method: string, params: unknown): Promise<T> {
    let last: RpcError = new RpcError('No RPC configured', true);
    for (const url of this.urls) {
      try {
        return await this.callOne<T>(url, method, params);
      } catch (err) {
        last = err instanceof RpcError ? err : new RpcError(String(err), true);
        if (!last.transient) throw last;
      }
    }
    throw last;
  }

  private async callOne<T>(url: string, method: string, params: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-id-watchdog', method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RpcError('NEAR RPC unreachable or timed out', true);
    }
    let body: { result?: T; error?: { name?: string; cause?: { name?: string }; data?: unknown; message?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RpcError(`NEAR RPC answered HTTP ${res.status}`, true);
    }
    if (body.error) {
      const text = JSON.stringify(body.error);
      const transient = res.status >= 500 || /INTERNAL_ERROR|NO_SYNCED_BLOCKS|NOT_SYNCED_YET|TIMEOUT/u.test(text);
      throw new RpcError(text.slice(0, 500), transient);
    }
    if (body.result === undefined) throw new RpcError(`NEAR RPC answered HTTP ${res.status} without a result`, true);
    // A view whose contract call failed comes back as a result with an `error` string.
    const viewError = (body.result as { error?: unknown } | null)?.error;
    if (typeof viewError === 'string') throw new RpcError(viewError.slice(0, 500), false);
    return body.result;
  }

  /** View call at final finality; decodes the JSON the contract returned. */
  async view<T>(accountId: string, methodName: string, args: unknown): Promise<T> {
    const result = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: methodName,
      args_base64: b64(new TextEncoder().encode(JSON.stringify(args))),
    });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
  }
}

const isMethodNotFound = (err: unknown): boolean => err instanceof Error && /MethodNotFound|MethodResolveError/u.test(err.message);

/** `view_account` code hash of an account without a contract. */
export const EMPTY_CODE_HASH = '11111111111111111111111111111111';

export class NearChain implements ChainReader {
  constructor(
    private readonly rpc: Rpc,
    private readonly signer: string,
  ) {}

  async chainId(): Promise<string> {
    const status = await this.rpc.call<{ chain_id?: unknown }>('status', []);
    return typeof status.chain_id === 'string' ? status.chain_id : '';
  }

  async snapshot(provider: string): Promise<ChainSnapshot> {
    const [keyChanges, issuer, config, governance] = await Promise.all([
      this.rpc.view<KeyChange[]>(this.signer, 'get_key_changes', {}),
      this.rpc.view<IssuerView | null>(this.signer, 'get_issuer', { provider }),
      this.rpc.view<ConfigView>(this.signer, 'get_config', {}),
      this.rpc.view<GovernanceView>(this.signer, 'get_governance', {}),
    ]);
    let issuerKeys: IssuerKey[] | null;
    try {
      issuerKeys = await this.rpc.view<IssuerKey[] | null>(this.signer, 'get_issuer_keys', { provider });
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
      issuerKeys = null;
    }
    if (!Array.isArray(keyChanges) || typeof config !== 'object' || config === null || typeof governance !== 'object' || governance === null) {
      throw new RpcError('Unexpected view shape', false);
    }
    const owner = typeof config.owner === 'string' ? await this.ownerAccount(config.owner) : null;
    return { keyChanges, issuer, issuerKeys, config, governance, owner };
  }

  /** The owner's code hash and, if it runs a contract with `get_policy` (a Sputnik DAO), its policy. */
  private async ownerAccount(accountId: string): Promise<OwnerAccount> {
    const account = await this.rpc.call<{ code_hash?: unknown }>('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
    if (typeof account?.code_hash !== 'string') throw new RpcError('Unexpected view_account shape', false);
    let policy: unknown = null;
    if (account.code_hash !== EMPTY_CODE_HASH) {
      try {
        policy = await this.rpc.view<unknown>(accountId, 'get_policy', {});
      } catch (err) {
        if (!isMethodNotFound(err)) throw err;
      }
    }
    return { account_id: accountId, code_hash: account.code_hash, policy };
  }
}

export function parseWatchdogKey(secret: string): KeyPair {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/u.test(secret)) throw new Error('WATCHDOG_KEY must be an ed25519:<base58> secret key');
  return KeyPair.fromString(secret as KeyPairString);
}

/** The public key of WATCHDOG_KEY (`ed25519:…`), or null when it is missing or malformed. */
export function watchdogPublicKey(secret: string | undefined): string | null {
  if (!secret) return null;
  try {
    return parseWatchdogKey(secret).getPublicKey().toString();
  } catch {
    return null;
  }
}

/** Sends the watchdog's transactions one at a time from its function-call key (signer = WATCHDOG_ACCOUNT). */
export class NearWriter implements ChainWriter {
  private nonce: bigint | null = null;
  private blockHash = '';
  private readonly keyPair: KeyPair;
  private readonly publicKey: string;

  constructor(
    private readonly rpc: Rpc,
    private readonly account: string,
    private readonly receiver: string,
    secret: string,
    private readonly outcomeTimeoutMs: number = OUTCOME_TIMEOUT_MS,
  ) {
    this.keyPair = parseWatchdogKey(secret);
    this.publicKey = this.keyPair.getPublicKey().toString();
  }

  private async refresh(): Promise<void> {
    const ak = await this.rpc.call<{ nonce: number | string; block_hash: string }>('query', {
      request_type: 'view_access_key',
      finality: 'optimistic',
      account_id: this.account,
      public_key: this.publicKey,
    });
    this.nonce = BigInt(ak.nonce);
    this.blockHash = ak.block_hash;
  }

  async call(method: WatchdogMethod, args: Record<string, unknown>): Promise<TxResult> {
    if (!(WATCHDOG_METHODS as readonly string[]).includes(method)) return { ok: false, txHash: null, error: 'not a watchdog method' };
    let hash: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (this.nonce === null) await this.refresh();
        const nonce = (this.nonce ?? 0n) + 1n;
        this.nonce = nonce;
        const publicKey = this.keyPair.getPublicKey();
        const tx = createTransaction(
          this.account,
          publicKey,
          this.receiver,
          nonce,
          [actionCreators.functionCall(method, args, WATCHDOG_GAS, 0n)],
          baseDecode(this.blockHash),
        );
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(tx))));
        hash = baseEncode(digest);
        const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: publicKey.keyType, data: this.keyPair.sign(digest).signature }) });
        let outcome: unknown = null;
        try {
          outcome = await this.rpc.call('send_tx', { signed_tx_base64: b64(signed.encode()), wait_until: 'EXECUTED_OPTIMISTIC' });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          if (/InvalidNonce|Expired/u.test(text) && attempt === 0) {
            this.nonce = null;
            continue;
          }
          if (!(err instanceof RpcError) || !err.transient) return { ok: false, txHash: hash, error: text.slice(0, 300) };
        }
        outcome = await this.waitForOutcome(hash, outcome);
        const result = settle(outcome, hash);
        log({ event: 'watchdog_tx', method, nearTx: hash, outcome: result.ok ? 'ok' : 'error' }, result.ok ? 'info' : 'error');
        return result;
      } catch (err) {
        log({ event: 'watchdog_tx', method, outcome: 'error', code: 'send_failed' }, 'error');
        return { ok: false, txHash: hash, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
    }
    return { ok: false, txHash: hash, error: 'nonce retry exhausted' };
  }

  private async waitForOutcome(hash: string, initial: unknown): Promise<unknown> {
    let outcome = initial;
    const deadline = Date.now() + this.outcomeTimeoutMs;
    while (!isSettled(outcome)) {
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        outcome = await this.rpc.call('tx', { tx_hash: hash, sender_account_id: this.account, wait_until: 'EXECUTED_OPTIMISTIC' });
      } catch (err) {
        if (err instanceof RpcError && !err.transient && !/UNKNOWN_TRANSACTION|TIMEOUT/u.test(err.message)) return null;
      }
    }
    return outcome;
  }
}

type Status = { SuccessValue?: string; Failure?: unknown } | string | undefined;
interface Outcome {
  status?: Status;
  receipts_outcome?: { outcome: { status?: Status } }[];
}

function isSettled(o: unknown): o is Outcome {
  const s = (o as Outcome | null)?.status;
  return typeof s === 'object' && s !== null && ('SuccessValue' in s || 'Failure' in s);
}

/** Outcome → result: a failure anywhere in the receipt tree (the DeleteKey promise included) fails the call. */
function settle(outcome: unknown, hash: string): TxResult {
  if (!isSettled(outcome)) return { ok: false, txHash: hash, error: 'timed out waiting for the outcome' };
  const failed = [outcome.status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome.status)].find((s) => typeof s === 'object' && s !== null && 'Failure' in s && s.Failure);
  if (!failed || typeof failed !== 'object') return { ok: true, txHash: hash };
  const text = JSON.stringify(failed.Failure);
  const panic = /"panic_msg":"((?:[^"\\]|\\.)+)"/u.exec(text)?.[1] ?? /ExecutionError":"((?:[^"\\]|\\.)+)"/u.exec(text)?.[1];
  return { ok: false, txHash: hash, error: (panic ?? text).slice(0, 300) };
}


