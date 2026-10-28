// The vault's own NEAR reads (docs/batch-b-spec.md "Failure handling"): it re-syncs a session from the chain with
// `get_session` (optimistic, as apps/smoke's syncCounter) and polls a login transaction with `EXPERIMENTAL_tx_status`,
// `sender_account_id` the pinned RELAYER. It never takes session state from the API. A lying RPC can fail or delay a
// login, never forge one: every CKD result still passes the pairing check against the pinned key.
import { type CkdResult, type SessionView, base64Decode, base64Encode, fromUtf8, isCkdResult, isSessionView, utf8 } from '@hana-id/core';

type Fetch = typeof fetch;

/** A transaction's outcome: its decoded SuccessValue (JSON), a failure, or pending (unknown to the node, or not executed yet). */
export type TxOutcome = { kind: 'success'; value: unknown } | { kind: 'failure' } | { kind: 'pending' };

/** The CKD result of a successful login or derive outcome, or null. */
export const ckdResultOf = (o: TxOutcome): CkdResult | null => (o.kind === 'success' && isCkdResult(o.value) ? { big_y: o.value.big_y, big_c: o.value.big_c } : null);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class NearView {
  private readonly fetchFn: Fetch;

  constructor(
    private readonly rpc: string,
    private readonly signer: string,
    private readonly relayer: string,
    fetchFn?: Fetch,
  ) {
    this.fetchFn = fetchFn ?? ((...args) => fetch(...args));
  }

  private async call(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
    const res = await this.fetchFn(this.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-vault', method, params }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isObj(body)) throw new Error('NEAR RPC: malformed response');
    return body;
  }

  /** The session of a session key, or null (optimistic finality, so a just-executed login shows up). */
  async getSession(sessionPublicKey: Uint8Array): Promise<SessionView | null> {
    const body = await this.call('query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: this.signer,
      method_name: 'get_session',
      args_base64: base64Encode(utf8(JSON.stringify({ session_public_key: Array.from(sessionPublicKey) }))),
    });
    if (body.error !== undefined) throw new Error('NEAR RPC: get_session failed');
    const result = body.result;
    if (!isObj(result) || !Array.isArray(result.result)) throw new Error('NEAR RPC: get_session has no result');
    const value: unknown = JSON.parse(fromUtf8(Uint8Array.from(result.result as number[])));
    if (value === null) return null;
    if (!isSessionView(value)) throw new Error('NEAR RPC: malformed session');
    return value;
  }

  /** The outcome of a relayed transaction (sender: the pinned RELAYER). Network errors throw. */
  async txOutcome(txHash: string): Promise<TxOutcome> {
    const body = await this.call('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: this.relayer, wait_until: 'EXECUTED_OPTIMISTIC' });
    if (body.error !== undefined) return { kind: 'pending' };
    const result = body.result;
    const status = isObj(result) ? result.status : undefined;
    if (!isObj(status)) return { kind: 'pending' };
    if ('Failure' in status) return { kind: 'failure' };
    if (typeof status.SuccessValue !== 'string') return { kind: 'pending' };
    if (status.SuccessValue === '') return { kind: 'success', value: null };
    try {
      return { kind: 'success', value: JSON.parse(fromUtf8(base64Decode(status.SuccessValue))) as unknown };
    } catch {
      return { kind: 'failure' };
    }
  }
}
