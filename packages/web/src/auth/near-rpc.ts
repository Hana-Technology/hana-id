// The NEAR RPC reads a login needs (docs/batch-b-spec.md "Failure handling"): get_session to re-sync a session from
// chain (never from the API) and EXPERIMENTAL_tx_status to recover the CKD result of a transaction whose outcome the
// API could not report. Both go to the manifest `rpc`, a build constant; tx polling uses the pinned RELAYER as
// `sender_account_id`.
import { type CkdResult, type SessionView, base64Decode, base64Encode, fromUtf8, isCkdResult, isSessionView, utf8 } from '@hana-id/core';

export type TxOutcome = { readonly status: 'success'; readonly result: CkdResult } | { readonly status: 'failed' } | { readonly status: 'pending' };

export interface NearReader {
  /** get_session(session_public_key) at optimistic finality; null when there is no live session. */
  getSession(signer: string, sessionPublicKey: Uint8Array): Promise<SessionView | null>;
  /** The CKD result of a relayed transaction, a failure, or pending (unknown yet, or not executed). */
  txOutcome(txHash: string, sender: string): Promise<TxOutcome>;
}

interface RpcBody {
  result?: unknown;
  error?: { name?: string; cause?: { name?: string }; message?: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The transaction's final status → outcome. `SuccessValue` is base64 JSON `{big_y, big_c}` (the MPC's answer). */
export function txOutcomeOf(result: unknown): TxOutcome {
  const status = isObj(result) ? result.status : undefined;
  if (!isObj(status)) return { status: 'pending' };
  if ('Failure' in status) return { status: 'failed' };
  if (typeof status.SuccessValue === 'string') {
    try {
      const v: unknown = JSON.parse(fromUtf8(base64Decode(status.SuccessValue)));
      return isCkdResult(v) ? { status: 'success', result: { big_y: v.big_y, big_c: v.big_c } } : { status: 'failed' };
    } catch {
      return { status: 'failed' };
    }
  }
  return { status: 'pending' };
}

export function nearReader(rpcUrl: string, fetchFn: typeof fetch = (...args) => fetch(...args)): NearReader {
  const call = async (method: string, params: unknown): Promise<RpcBody> => {
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-auth', method, params }),
    });
    if (!res.ok) throw new Error(`NEAR RPC ${res.status}`);
    return (await res.json()) as RpcBody;
  };

  return {
    async getSession(signer, sessionPublicKey) {
      const body = await call('query', {
        request_type: 'call_function',
        finality: 'optimistic',
        account_id: signer,
        method_name: 'get_session',
        args_base64: base64Encode(utf8(JSON.stringify({ session_public_key: Array.from(sessionPublicKey) }))),
      });
      if (body.error) throw new Error('NEAR RPC: get_session failed');
      const raw = isObj(body.result) ? body.result.result : undefined;
      if (!Array.isArray(raw)) throw new Error('NEAR RPC: get_session returned no result');
      const v: unknown = JSON.parse(fromUtf8(Uint8Array.from(raw as number[])));
      if (v === null) return null;
      if (!isSessionView(v)) throw new Error('NEAR RPC: malformed session');
      return v;
    },

    async txOutcome(txHash, sender) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/u.test(txHash)) throw new Error('Malformed transaction hash');
      const body = await call('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' });
      // UNKNOWN_TRANSACTION and TIMEOUT_ERROR: not (yet) known or not final; anything else is also "try again".
      if (body.error) return { status: 'pending' };
      return txOutcomeOf(body.result);
    },
  };
}
