// The vault's own NEAR reads (docs/batch-b-spec.md "Failure handling"): it re-syncs a session from the chain with
// `get_session` (optimistic, as apps/smoke's syncCounter), checks the app's scope in the on-chain registry at login
// (`scope_for_client`, `get_scope`; Q7), and polls a login transaction with `EXPERIMENTAL_tx_status`,
// `sender_account_id` the pinned RELAYER. It never takes session state from the API. Each read goes to the manifest
// `rpc`, and to `rpcFallback` only when the primary fails (../near-call.ts), one endpoint per answer.
//
// What a lying RPC can do: fail or delay a login, refuse one with a wrong registry answer, and forge a CKD answer for a
// path whose secret S the liar knows. The pairing check against the pinned key catches a forgery for the identity's
// own path (only the MPC can answer that one), but not for a path a `get_identity` view of the liar's chose (a
// "member" of the liar's own account): so a path that is not the signed-in identity's own is confirmed on both
// providers separately (`independent()`, ../path-check.ts, D263) before the vault derives it.
import {
  type AccountView,
  type CkdResult,
  type EmailChainKey,
  type EmailSignerPolicy,
  type IdentityView,
  type SessionView,
  base64Decode,
  base64Encode,
  fromUtf8,
  isCkdResult,
  isSessionView,
  parseAccountView,
  parseIdentityView,
  parseIssuerKeysView,
  parseSelfIssuedView,
  utf8,
} from '@hana-id/core';
import { type NearEndpoints, independentEndpoints, isPendingTxError, nearCall, nearCallAt } from '../near-call.ts';
import type { IndependentViews, ViewRead } from '../path-check.ts';

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

  private viewParams(methodName: string, args: unknown): Record<string, unknown> {
    return { request_type: 'call_function', finality: 'optimistic', account_id: this.signer, method_name: methodName, args_base64: base64Encode(utf8(JSON.stringify(args))) };
  }

  /** A view of the pinned signer contract at optimistic finality, as parsed JSON. Throws when no endpoint answers. */
  async view(methodName: string, args: unknown): Promise<unknown> {
    const body = await this.call('query', this.viewParams(methodName, args), viewAnswered);
    const raw = (body.result as { result: number[] }).result;
    return JSON.parse(fromUtf8(Uint8Array.from(raw))) as unknown;
  }

  /**
   * The env's two providers, each read alone (no fallback from one to the other), for confirming a path that isn't
   * the signed-in identity's own (D263); null without a second provider. `signal` (the login's) ends the reads early.
   */
  independent(signal?: AbortSignal): IndependentViews | null {
    const ends = independentEndpoints(this.endpoints);
    if (!ends) return null;
    const at =
      (url: string): ViewRead =>
      async (method, args) => {
        const body = await nearCallAt(url, this.fetchFn, 'query', this.viewParams(method, args), { id: 'hana-vault', usable: viewAnswered, ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}), ...(signal ? { signal } : {}) });
        return JSON.parse(fromUtf8(Uint8Array.from((body.result as { result: number[] }).result))) as unknown;
      };
    return { primary: at(ends[0]), second: at(ends[1]) };
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
    return parseIssuerKeysView(await this.view('get_issuer_keys', { provider }));
  }

  /** `get_self_issued(provider)`: the signer policy, or null (not a self-issued provider; a contract before v3 throws). */
  async selfIssued(provider: string): Promise<EmailSignerPolicy | null> {
    return parseSelfIssuedView(await this.view('get_self_issued', { provider }));
  }

  /**
   * `get_identity(scope_id, provider, sub)` (contract v3): where the identity stands, for the path it derives (batch 7)
   * and the link judgements. Throws when no endpoint answers or the answer isn't the v3 shape (a v2 contract has no
   * such view).
   */
  async identity(scopeId: string, provider: string, sub: string): Promise<IdentityView> {
    return parseIdentityView(await this.view('get_identity', { scope_id: scopeId, provider, sub }));
  }

  /** `get_account(scope_id, provider, sub)`: the account the identity is in (as root or member), or null. */
  async account(scopeId: string, provider: string, sub: string): Promise<AccountView | null> {
    return parseAccountView(await this.view('get_account', { scope_id: scopeId, provider, sub }));
  }

  /**
   * Whether links are open on chain: `get_config().unrecorded_wallets` is exactly `false` (D135; a pre-v3 contract has
   * no field, so links stay closed there, as at the API, D232).
   */
  async linksOpen(): Promise<boolean> {
    const value = await this.view('get_config', {});
    return isObj(value) && value.unrecorded_wallets === false;
  }

  /** Whether the env has two independent providers (`rpc` and a different `rpcFallback`). */
  independentProviders(): boolean {
    return independentEndpoints(this.endpoints) !== null;
  }

  /**
   * One read, from the primary with the fallback (`independent` false), or from each of the env's two providers
   * separately (`independent` true, when the env has two; D263's rule for answers a lying provider could forge): every
   * provider must answer, and the caller gets each answer to check them all.
   */
  private async reads(method: string, params: unknown, usable: (b: Record<string, unknown>) => boolean, independent: boolean): Promise<Record<string, unknown>[]> {
    const ends = independent ? independentEndpoints(this.endpoints) : null;
    if (!ends) return [await this.call(method, params, usable)];
    const o = { id: 'hana-vault', usable, ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) };
    return Promise.all(ends.map((url) => nearCallAt(url, this.fetchFn, method, params, o)));
  }

  /**
   * Whether `blockHash` (base58) is a block of this env's network (D726), as each provider asked says (one answer per
   * provider; see `reads`): a NEAR transaction is valid only with a recent block hash of the network it is sent to, so
   * the block hash is what ties it to one. True when the node returns that block, false when it says it doesn't know it
   * (UNKNOWN_BLOCK); throws when a provider gives neither answer. A block is unknown to a node once it has
   * garbage-collected it (after about five epochs, longer than a transaction's validity), so a valid one never is.
   *
   * What a lying RPC can do here: say a mainnet block is a testnet one (the user is then shown "checked on testnet"
   * for a transaction valid on mainnet), or refuse a good one. For a test app the vault asks both providers
   * (`independent`), so one lying provider alone can't do the first.
   */
  async blockExists(blockHash: string, independent = false): Promise<boolean[]> {
    const unknown = (b: Record<string, unknown>) => isObj(b.error) && isObj(b.error.cause) && b.error.cause.name === 'UNKNOWN_BLOCK';
    const bodies = await this.reads('block', { block_id: blockHash }, (b) => (b.error === undefined && isObj(b.result)) || unknown(b), independent);
    return bodies.map((body) => {
      if (unknown(body)) return false;
      const header = isObj(body.result) ? body.result.header : undefined;
      return isObj(header) && header.hash === blockHash;
    });
  }

  /**
   * `view_access_key` at final finality, one answer per provider asked (see `reads`): the key's nonce and the height it
   * was read at, or null when the account or the key doesn't exist on this env's network. Throws when a provider gives
   * neither answer. A lying provider could report a height or nonce that lets a test app's delegate action through on
   * mainnet: for test apps the vault asks both providers and checks every answer.
   */
  async accessKey(accountId: string, publicKey: string, independent = false): Promise<({ nonce: bigint; blockHeight: bigint } | null)[]> {
    const missing = (b: Record<string, unknown>) =>
      (isObj(b.error) && isObj(b.error.cause) && (b.error.cause.name === 'UNKNOWN_ACCESS_KEY' || b.error.cause.name === 'UNKNOWN_ACCOUNT')) ||
      // Older nodes answer a missing key inside `result`.
      (isObj(b.result) && typeof b.result.error === 'string' && /does not exist/u.test(b.result.error));
    const answered = (b: Record<string, unknown>) => b.error === undefined && isObj(b.result) && Number.isSafeInteger(b.result.nonce) && Number.isSafeInteger(b.result.block_height);
    const bodies = await this.reads('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }, (b) => answered(b) || missing(b), independent);
    return bodies.map((body) => {
      if (missing(body)) return null;
      const r = body.result as { nonce: number; block_height: number };
      return { nonce: BigInt(r.nonce), blockHeight: BigInt(r.block_height) };
    });
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
