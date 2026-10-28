// Read-only NEAR RPC calls: contract views (get_config, get_scope, get_session) and gas of a relayed transaction.
import { base64Encode, utf8 } from '@hana-id/core';

type Fetch = typeof fetch;

/** get_config().shared_clients and friends (docs/contract-interface.md "Config"). Only the fields the page uses. */
export interface SignerConfig {
  shared_clients: [string, string][];
  pending_shared_clients: { provider: string; aud: string; effective_at_ms: number }[];
  mpc: string;
  ckd_domain_id: number;
}

export interface ScopeView {
  id: string;
  clients: [string, string][];
  allow_shared: boolean;
}

export interface SessionState {
  path: string;
  scope_id: string;
  expires_at_ms: number;
  max_uses: number;
  used: number;
}

export interface TxGas {
  /** Gas burnt by the transaction and every receipt it produced (including the MPC's), in gas units. */
  gasBurnt: number;
  /** NEAR burnt for that gas, yoctoNEAR as a decimal string. */
  tokensBurnt: string;
  /** Number of receipt outcomes summed. */
  receipts: number;
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string; data?: unknown; cause?: { name?: string } };
}

export class NearRpc {
  constructor(
    private readonly url: string,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
  ) {}

  private async call(method: string, params: unknown): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-smoke', method, params }),
    });
    if (!res.ok) throw new Error(`NEAR RPC ${res.status}`);
    const body = (await res.json()) as RpcResponse;
    if (body.error) {
      const detail = typeof body.error.data === 'string' ? body.error.data : (body.error.cause?.name ?? body.error.message ?? 'error');
      throw new Error(`NEAR RPC: ${detail}`);
    }
    return body.result;
  }

  /** A JSON view call (`call_function`, final). */
  async view<T>(account: string, method: string, args: unknown): Promise<T> {
    const result = (await this.call('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: account,
      method_name: method,
      args_base64: base64Encode(utf8(JSON.stringify(args))),
    })) as { result?: number[]; error?: string } | undefined;
    if (!result?.result) throw new Error(`${method}: ${result?.error ?? 'no result'}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
  }

  getConfig(signer: string): Promise<SignerConfig> {
    return this.view<SignerConfig>(signer, 'get_config', {});
  }

  getScope(signer: string, scopeId: string): Promise<ScopeView | null> {
    return this.view<ScopeView | null>(signer, 'get_scope', { scope_id: scopeId });
  }

  /** Optimistic read, so a just-executed derive shows up in `used`. */
  async getSession(signer: string, sessionPublicKey: number[]): Promise<SessionState | null> {
    const result = (await this.call('query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: signer,
      method_name: 'get_session',
      args_base64: base64Encode(utf8(JSON.stringify({ session_public_key: sessionPublicKey }))),
    })) as { result?: number[]; error?: string } | undefined;
    if (!result?.result) throw new Error(`get_session: ${result?.error ?? 'no result'}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as SessionState | null;
  }

  /** Total gas burnt by a relayed transaction (sender = the relayer account) and all its receipts. */
  async txGas(txHash: string, sender: string): Promise<TxGas> {
    const result = await this.call('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'EXECUTED' });
    return sumGas(result);
  }
}

interface Outcome {
  outcome?: { gas_burnt?: number; tokens_burnt?: string };
}

/** Sums gas_burnt / tokens_burnt over transaction_outcome and receipts_outcome of a `tx` RPC result. */
export function sumGas(result: unknown): TxGas {
  const r = result as { transaction_outcome?: Outcome; receipts_outcome?: Outcome[] } | null;
  if (!r?.transaction_outcome) throw new Error('Transaction outcome not available');
  const all = [r.transaction_outcome, ...(r.receipts_outcome ?? [])];
  let gas = 0;
  let tokens = 0n;
  for (const o of all) {
    gas += o.outcome?.gas_burnt ?? 0;
    tokens += BigInt(o.outcome?.tokens_burnt ?? '0');
  }
  return { gasBurnt: gas, tokensBurnt: tokens.toString(), receipts: all.length - 1 };
}

/**
 * Google shared clients in force at `now`: get_config().shared_clients (matured additions included when read) plus
 * pending additions whose time has come since, as the API does (apps/api/src/views.ts effectiveSharedClients).
 */
export function googleSharedClients(config: SignerConfig, now: number = Date.now()): string[] {
  const out = config.shared_clients.filter(([p]) => p === 'google').map(([, aud]) => aud);
  for (const p of config.pending_shared_clients) {
    if (p.provider === 'google' && p.effective_at_ms <= now && !out.includes(p.aud)) out.push(p.aud);
  }
  return out;
}

/** The scope's own Google clients. */
export const googleOwnClients = (scope: ScopeView): string[] => scope.clients.filter(([p]) => p === 'google').map(([, aud]) => aud);

export const formatTgas = (gas: number): string => `${(gas / 1e12).toFixed(2)} Tgas`;

/** yoctoNEAR decimal string → NEAR with 6 decimals. */
export function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const unit = 10n ** 24n;
  const micro = (v * 1_000_000n + unit / 2n) / unit;
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')} NEAR`;
}
