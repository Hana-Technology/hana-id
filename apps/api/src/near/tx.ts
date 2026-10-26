// Transaction building, signing and outcome decoding (ported from legacy/relayer/embed-relayer.ts).
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { type FinalOutcome, type Rpc, decodeSuccessValue, isTransient, isUnknownTx } from './rpc.ts';

/** 300 Tgas, as the legacy relayer (derive_key waits on the MPC through a yield/resume). */
export const RELAY_GAS = 300_000_000_000_000n;
/** How long to wait for an outcome (the MPC answers a few blocks after the request). */
export const OUTCOME_TIMEOUT_MS = 60_000;
const POLL_MS = 400;

export interface ContractCall {
  method: string;
  args: Record<string, unknown>;
  gas?: bigint;
}

export function parseKeyPair(secret: string): KeyPair {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/u.test(secret)) throw new Error('Relayer keys must be ed25519:<base58> secret keys');
  return KeyPair.fromString(secret as KeyPairString);
}

export interface SignedTx {
  bytes: Uint8Array;
  /** base58 sha256 of the borsh-encoded transaction. */
  hash: string;
}

export async function signFunctionCall(opts: {
  keyPair: KeyPair;
  signerId: string;
  receiverId: string;
  nonce: bigint;
  blockHash: string;
  call: ContractCall;
}): Promise<SignedTx> {
  const publicKey = opts.keyPair.getPublicKey();
  const tx = createTransaction(
    opts.signerId,
    publicKey,
    opts.receiverId,
    opts.nonce,
    [actionCreators.functionCall(opts.call.method, opts.call.args, opts.call.gas ?? RELAY_GAS, 0n)],
    baseDecode(opts.blockHash),
  );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(tx))));
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({ keyType: publicKey.keyType, data: opts.keyPair.sign(hash).signature }),
  });
  return { bytes: signed.encode(), hash: baseEncode(hash) };
}

const statusObject = (s: FinalOutcome['status'] | undefined): { SuccessValue?: string; Failure?: unknown } | null =>
  s && typeof s === 'object' ? s : null;

/** Settled = the tx has a final SuccessValue or Failure. */
export function isSettled(o: Partial<FinalOutcome> | null | undefined): o is FinalOutcome {
  const s = statusObject(o?.status);
  return !!s && ('SuccessValue' in s || 'Failure' in s);
}

/** The first failure anywhere in the receipt tree, as readable text. */
export function failureText(outcome: FinalOutcome): string | null {
  const failed = outcome.receipts_outcome?.find((r) => {
    const s = r.outcome.status;
    return typeof s === 'object' && s !== null && 'Failure' in s && s.Failure;
  });
  const failedStatus = failed?.outcome.status;
  const failure = statusObject(outcome.status)?.Failure ?? (typeof failedStatus === 'object' ? failedStatus.Failure : undefined);
  if (!failure) return null;
  const text = JSON.stringify(failure);
  const panic = /"panic_msg":"((?:[^"\\]|\\.)+)"/u.exec(text)?.[1] ?? /ExecutionError":"((?:[^"\\]|\\.)+)"/u.exec(text)?.[1];
  return (panic ?? text).slice(0, 500);
}

export type Outcome = { ok: true; value: unknown } | { ok: false; kind: 'failure' | 'rpc' | 'timeout' | 'dropped'; error: string };

/** How often (at most) to ask `superseded` while the tx is unknown, and how many answers in a row count. */
export const DROP_CHECK_MS = 2_000;
const DROP_CHECKS = 2;

export interface WaitOptions {
  timeoutMs?: number;
  /**
   * Asked while the node reports the tx as unknown: true when it can no longer be included (the access key's nonce
   * has already reached the tx's nonce through other txs). Two answers in a row, DROP_CHECK_MS apart, end the wait
   * with `dropped` (never executed: safe to send again with a new nonce).
   */
  superseded?: () => Promise<boolean>;
}

/**
 * Waits for a broadcast tx's outcome by polling `tx` (EXECUTED). Starts from `initial` if send_tx already settled.
 * Transient errors (see isTransient) keep polling until the deadline. Never holds any lock: callers run this outside
 * the nonce critical section.
 */
export async function waitForOutcome(rpc: Rpc, txHash: string, senderId: string, initial?: Partial<FinalOutcome> | null, opts: WaitOptions | number = {}): Promise<Outcome> {
  const { timeoutMs = OUTCOME_TIMEOUT_MS, superseded } = typeof opts === 'number' ? { timeoutMs: opts } : opts;
  let outcome: Partial<FinalOutcome> | null = initial ?? null;
  const deadline = Date.now() + timeoutMs;
  let first = true;
  let lastCheck = -Infinity;
  let supersededSeen = 0;
  while (!isSettled(outcome)) {
    if (Date.now() > deadline) return { ok: false, kind: 'timeout', error: 'Timed out waiting for the transaction outcome' };
    if (!first) await new Promise((r) => setTimeout(r, POLL_MS));
    first = false;
    try {
      outcome = await rpc.txStatus(txHash, senderId);
    } catch (err) {
      if (!isTransient(err)) return { ok: false, kind: 'rpc', error: err instanceof Error ? err.message : String(err) };
      if (superseded && isUnknownTx(err) && Date.now() - lastCheck >= DROP_CHECK_MS) {
        lastCheck = Date.now();
        let gone = false;
        try {
          gone = await superseded();
        } catch {
          gone = false;
        }
        supersededSeen = gone ? supersededSeen + 1 : 0;
        if (supersededSeen >= DROP_CHECKS) return { ok: false, kind: 'dropped', error: 'The transaction was dropped (its nonce was superseded)' };
      }
    }
  }
  const failure = failureText(outcome);
  if (failure) return { ok: false, kind: 'failure', error: failure };
  try {
    return { ok: true, value: decodeSuccessValue(statusObject(outcome.status)?.SuccessValue) };
  } catch {
    return { ok: false, kind: 'rpc', error: 'The contract returned a value that is not JSON' };
  }
}
