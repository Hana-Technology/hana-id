// The vault's own NEAR reads (docs/batch-b-spec.md "Failure handling"): it re-syncs a session from the chain with
// `get_session` (optimistic, as apps/smoke's syncCounter), checks the app's scope in the on-chain registry at login
// (`scope_for_client`, `get_scope`; Q7), and polls a login transaction with `EXPERIMENTAL_tx_status`,
// `sender_account_id` the pinned RELAYER. It never takes session state from the API. A lying RPC can fail or delay a
// login, never forge one: every CKD result still passes the pairing check against the pinned key. Each read goes to
// the manifest `rpc`, and to `rpcFallback` only when the primary fails (../near-call.ts), one endpoint per answer.
import { type CkdResult, type EmailChainKey, type EmailSignerPolicy, type SessionView, base64Decode, base64Encode, fromUtf8, isCkdResult, isSessionView, utf8 } from '@hana-id/core';
import { type NearEndpoints, isPendingTxError, nearCall } from '../near-call.ts';

type Fetch = typeof fetch;

/** A transaction's outcome: its decoded SuccessValue (JSON), a failure, or pending (unknown to the node, or not executed yet). */
export type TxOutcome = { kind: 'success'; value: unknown } | { kind: 'failure' } | { kind: 'pending' };

/** The CKD result of a successful login or derive outcome, or null. */
export const ckdResultOf = (o: TxOutcome): CkdResult | null => (o.kind === 'success' && isCkdResult(o.value) ? { big_y: o.value.big_y, big_c: o.value.big_c } : null);

/** The fields of `get_scope` the vault checks. */
export interface ScopeView {
  id: string;
  allow_shared: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const viewAnswered = (body: Record<string, unknown>): boolean => body.error === undefined && isObj(body.result) && Array.isArray(body.result.result);

export class NearView {
  private readonly fetchFn: Fetch;

  constructor(
    private readonly endpoints: NearEndpoints,
    private readonly signer: string,
    private readonly relayer: string,
    fetchFn?: Fetch,
    private readonly timeoutMs?: number,
  ) {
    this.fetchFn = fetchFn ?? ((...args) => fetch(...args));
  }

  private call(method: string, params: unknown, usable?: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    return nearCall(this.endpoints, this.fetchFn, method, params, { id: 'hana-vault', ...(usable ? { usable } : {}), ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) });
  }

  /** A view of the pinned signer contract at optimistic finality, as parsed JSON. Throws when no endpoint answers. */
  async view(methodName: string, args: unknown): Promise<unknown> {
    const body = await this.call(
      'query',
      { request_type: 'call_function', finality: 'optimistic', account_id: this.signer, method_name: methodName, args_base64: base64Encode(utf8(JSON.stringify(args))) },
      viewAnswered,
    );
    const raw = (body.result as { result: number[] }).result;
    return JSON.parse(fromUtf8(Uint8Array.from(raw))) as unknown;
  }

  /** The session of a session key, or null (optimistic finality, so a just-executed login shows up). */
  async getSession(sessionPublicKey: Uint8Array): Promise<SessionView | null> {
    const value = await this.view('get_session', { session_public_key: Array.from(sessionPublicKey) });
    if (value === null) return null;
    if (!isSessionView(value)) throw new Error('NEAR RPC: malformed session');
    return value;
  }

  /** `scope_for_client(provider, aud)`: the scope a client belongs to, or null. */
  async scopeForClient(provider: string, aud: string): Promise<string | null> {
    const value = await this.view('scope_for_client', { provider, aud });
    if (value !== null && typeof value !== 'string') throw new Error('NEAR RPC: malformed scope_for_client');
    return value;
  }

  /** `get_scope(scope_id)`: the scope's id and shared-login flag, or null when it isn't registered. */
  async getScope(scopeId: string): Promise<ScopeView | null> {
    const value = await this.view('get_scope', { scope_id: scopeId });
    if (value === null) return null;
    if (!isObj(value) || typeof value.id !== 'string' || typeof value.allow_shared !== 'boolean') throw new Error('NEAR RPC: malformed scope');
    return { id: value.id, allow_shared: value.allow_shared };
  }

  /** `get_config().shared_clients`: Hana's shared login clients in force, as `[provider, aud]` pairs. */
  async sharedClients(): Promise<readonly (readonly [string, string])[]> {
    const value = await this.view('get_config', {});
    const list = isObj(value) ? value.shared_clients : undefined;
    if (!Array.isArray(list) || !list.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string' && typeof c[1] === 'string')) {
      throw new Error('NEAR RPC: malformed config');
    }
    return list as [string, string][];
  }

  /** `get_issuer_keys(provider)`: the provider's active keys with their material (`{kid, n, e}`), or null for none. */
  async issuerKeys(provider: string): Promise<EmailChainKey[] | null> {
    const value = await this.view('get_issuer_keys', { provider });
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((k) => isObj(k) && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string')) {
      throw new Error('NEAR RPC: malformed get_issuer_keys');
    }
    return value.map((k) => ({ kid: k.kid as string, n: k.n as string, e: k.e as string }));
  }

  /** `get_self_issued(provider)`: the signer policy, or null (not a self-issued provider; a contract before v3 throws). */
  async selfIssued(provider: string): Promise<EmailSignerPolicy | null> {
    const value = await this.view('get_self_issued', { provider });
    if (value === null) return null;
    const signers = isObj(value) ? value.signers : undefined;
    if (
      !isObj(value) ||
      !Number.isSafeInteger(value.required) ||
      !Array.isArray(signers) ||
      !signers.every((s) => isObj(s) && typeof s.id === 'string' && Array.isArray(s.kids) && s.kids.every((k) => typeof k === 'string'))
    ) {
      throw new Error('NEAR RPC: malformed get_self_issued');
    }
    return { required: value.required as number, signers: signers.map((s) => ({ id: s.id as string, kids: [...(s.kids as string[])] })) };
  }

  /** The outcome of a relayed transaction (sender: the pinned RELAYER). Network errors throw. */
  async txOutcome(txHash: string): Promise<TxOutcome> {
    const body = await this.call('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: this.relayer, wait_until: 'EXECUTED_OPTIMISTIC' }, (b) => b.error === undefined || isPendingTxError(b.error));
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
