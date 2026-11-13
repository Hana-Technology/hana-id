// Fakes for the site's tests: the SDK's `hana.near` (each method a vi.fn a test can hold open or make fail) and the
// env's NEAR JSON-RPC over a stateful fake of contracts/hana-stamps that applies the spec's rules (arrival first, each
// stamp once, sponsored vs own fare, the proof's message and recipient, the note, the layover). The fake signer's
// "signed" bytes are the unsigned bytes in base64, so the fake relay and send_tx can decode what the page built.
import { vi } from 'vitest';
import { base64Decode, base64Encode, decodeNearDelegateAction, decodeNearTransaction, nearImplicitPublicKey, nearPublicKeyString, utf8 } from '@hana-id/core';
import { base58 } from '@scure/base';

export const BLOCK_HASH = base58.encode(new Uint8Array(32).fill(9));
export const TX_HASH = base58.encode(new Uint8Array(32).fill(4));
export const SIG64 = base64Encode(new Uint8Array(64).fill(7));

export interface StoredStamp {
  stamp: string;
  block_timestamp_ms: number;
  sponsored: boolean;
  note?: string;
}

/** The fake contract: the passports, the ring of recent stamps, and the rules. */
export class FakeStamps {
  readonly passports = new Map<string, StoredStamp[]>();
  readonly ring: { account_id: string; stamp: string; block_timestamp_ms: number }[] = [];
  /** Every collect's arguments, as the contract received them. */
  readonly calls: { sender: string; sponsored: boolean; args: Record<string, unknown> }[] = [];

  constructor(
    readonly account: string,
    readonly now: () => number,
  ) {}

  /**
   * Applies `collect` with the real contract's checks in its order (contracts/hana-stamps/src/lib.rs; the e2e model
   * apps/e2e/src/server/stamps-contract.ts, pinned to the wasm by apps/api/test-sandbox/stamps-site.test.ts): returns
   * the panic code, or null when it stored the stamp. The proof is checked for its shape only (the fake signer signs
   * nothing).
   */
  collect(sender: string, sponsored: boolean, args: Record<string, unknown>): string | null {
    this.calls.push({ sender, sponsored, args });
    const stamp = String(args.stamp);
    const held = this.passports.get(sender);
    const none = (v: unknown) => v === undefined || v === null;
    if (!['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover'].includes(stamp)) return 'ERR_UNKNOWN_STAMP';
    if (!none(args.note) && stamp !== 'postcard') return 'ERR_BAD_NOTE';
    if (!none(args.proof) && stamp !== 'signature') return 'ERR_BAD_PROOF';
    if (stamp === 'arrival' && held) return 'ERR_ALREADY';
    if (stamp !== 'arrival' && !held) return 'ERR_NO_ARRIVAL';
    if (held?.some((s) => s.stamp === stamp)) return 'ERR_ALREADY';
    if (stamp === 'sponsored' && !sponsored) return 'ERR_NOT_SPONSORED';
    if (stamp === 'own_fare' && sponsored) return 'ERR_NOT_OWN_FARE';
    let note: string | undefined;
    if (stamp === 'postcard') {
      note = typeof args.note === 'string' ? args.note.trim() : '';
      if ([...note].length < 1 || [...note].length > 140) return 'ERR_BAD_NOTE';
    }
    if (stamp === 'signature') {
      if (!/^[0-9a-f]{64}$/u.test(sender)) return 'ERR_NOT_IMPLICIT';
      const p = args.proof as Record<string, unknown> | undefined;
      const nonceOk = typeof p?.nonce === 'string' && p.nonce.length === 44 && base64Decode(p.nonce).length === 32;
      const sigOk = typeof p?.signature === 'string' && p.signature.length === 88 && base64Decode(p.signature).length === 64;
      if (!p || p.message !== `Stamp my passport: ${sender}` || p.recipient !== this.account || !nonceOk || !sigOk) return 'ERR_BAD_PROOF';
    }
    if (stamp === 'layover') {
      const arrival = held![0]!;
      if (this.now() - arrival.block_timestamp_ms < 120_000) return 'ERR_TOO_SOON';
    }
    const s: StoredStamp = { stamp, block_timestamp_ms: this.now(), sponsored, ...(note !== undefined ? { note } : {}) };
    this.passports.set(sender, [...(held ?? []), s]);
    this.ring.push({ account_id: sender, stamp, block_timestamp_ms: s.block_timestamp_ms });
    if (this.ring.length > 100) this.ring.shift();
    return null;
  }

  view(method: string, args: Record<string, unknown>): unknown {
    if (method === 'get_passport') {
      const stamps = this.passports.get(String(args.account_id));
      return stamps ? { account_id: args.account_id, stamps } : null;
    }
    if (method === 'recent') {
      const from = Number(args.from_index ?? 0);
      const limit = Math.min(Number(args.limit ?? 50), 50);
      return [...this.ring].reverse().slice(from, from + limit);
    }
    if (method === 'totals') return { passports: this.passports.size, stamps: [...this.passports.values()].reduce((n, s) => n + s.length, 0) };
    if (method === 'catalog') return ['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover'];
    return undefined;
  }
}

interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

/** The env's NEAR RPC over FakeStamps, and the user's account (its key's nonce and balance). */
export class FakeChain {
  /** The user's access key, or null: the account doesn't exist on testnet yet. */
  key: { nonce: number } | null = { nonce: 1000 };
  height = 200_000_000;
  /** yoctoNEAR. */
  balance = '0';
  /** Every endpoint answers 503. */
  down = false;
  /** Overrides a view's answer (hostile RPC tests). */
  override: ((method: string, args: Record<string, unknown>) => unknown) | null = null;
  /** send_tx's answer instead of applying the transaction. */
  sendTxAnswer: (() => Response | Promise<Response>) | null = null;
  readonly calls: { url: string; body: RpcCall }[] = [];
  readonly stamps: FakeStamps;

  constructor(contract: string, now: () => number) {
    this.stamps = new FakeStamps(contract, now);
  }

  readonly fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(init.body as string) as RpcCall;
    this.calls.push({ url, body });
    if (this.down) return new Response('down', { status: 503 });
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 'x', result });
    const err = (name: string) => Response.json({ jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', cause: { name }, code: -32000, message: name } });
    const p = body.params;
    if (body.method === 'block') return ok({ header: { height: this.height, hash: BLOCK_HASH } });
    if (body.method === 'send_tx') {
      if (this.sendTxAnswer) return this.sendTxAnswer();
      const tx = decodeNearTransaction(base64Decode(String(p.signed_tx_base64)));
      const call = tx.actions[0] as { methodName: string; args: Uint8Array };
      const panic = this.stamps.collect(tx.signerId, false, JSON.parse(new TextDecoder().decode(call.args)) as Record<string, unknown>);
      if (this.key) this.key.nonce = Number(tx.nonce);
      if (panic) return ok({ status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } } }, transaction: { hash: TX_HASH } });
      return ok({ status: { SuccessValue: '' }, transaction: { hash: TX_HASH } });
    }
    if (body.method === 'query' && p.request_type === 'view_access_key') return this.key ? ok({ nonce: this.key.nonce, block_height: this.height, block_hash: BLOCK_HASH, permission: 'FullAccess' }) : err('UNKNOWN_ACCOUNT');
    if (body.method === 'query' && p.request_type === 'view_account') return this.key ? ok({ amount: this.balance, locked: '0', storage_usage: 182 }) : err('UNKNOWN_ACCOUNT');
    if (body.method === 'query' && p.request_type === 'call_function' && p.account_id === this.stamps.account) {
      const args = JSON.parse(new TextDecoder().decode(base64Decode(String(p.args_base64)))) as Record<string, unknown>;
      const method = String(p.method_name);
      const value = this.override ? this.override(method, args) : this.stamps.view(method, args);
      if (value === undefined) return err('MethodResolveError');
      return ok({ result: Array.from(utf8(JSON.stringify(value))), logs: [] });
    }
    return err('UNKNOWN');
  });

  count(pred: (c: RpcCall) => boolean): number {
    return this.calls.filter((c) => pred(c.body)).length;
  }
}

/** The SDK's `hana.near` for `accountId()`, with the fake relay applying the delegate action to `chain`. */
export function fakeNear(accountId: () => string | null, chain: FakeChain) {
  const near = {
    get accountId(): string | null {
      return accountId();
    },
    get publicKey(): string | null {
      const id = accountId();
      return id === null ? null : nearPublicKeyString(nearImplicitPublicKey(id));
    },
    activate: vi.fn(async (): Promise<{ created: boolean; accountId: string; accessKeyNonce?: string; blockHeight?: number }> => {
      const created = chain.key === null;
      if (created) chain.key = { nonce: (chain.height - 1) * 1_000_000 };
      return { created, accountId: accountId()!, accessKeyNonce: String(chain.key!.nonce), blockHeight: chain.height };
    }),
    signDelegateAction: vi.fn(async (p: { network: string; delegateAction: Uint8Array | string }) => ({ signature: SIG64, signedDelegateAction: base64Encode(p.delegateAction as Uint8Array) })),
    relay: vi.fn(async (p: { network: string; signedDelegateAction: Uint8Array | string }) => {
      const d = decodeNearDelegateAction(base64Decode(p.signedDelegateAction as string));
      const call = d.actions[0] as { methodName: string; args: Uint8Array };
      const panic = chain.stamps.collect(d.senderId, true, JSON.parse(new TextDecoder().decode(call.args)) as Record<string, unknown>);
      if (chain.key) chain.key.nonce = Number(d.nonce);
      if (panic) throw Object.assign(new Error(`Smart contract panicked: ${panic}`), { code: 4100, data: { status: 422, reason: 'contract_rejected', transactionHash: TX_HASH } });
      return { transactionHash: TX_HASH, status: 'executed' };
    }),
    signTransaction: vi.fn(async (p: { network: string; transaction: Uint8Array | string }) => ({ signature: SIG64, signedTransaction: base64Encode(p.transaction as Uint8Array), hash: TX_HASH })),
    signMessage: vi.fn(async (_p: { message: string; recipient: string; nonce: Uint8Array | string; callbackUrl?: string }) => ({ accountId: accountId()!, publicKey: nearPublicKeyString(nearImplicitPublicKey(accountId()!)), signature: SIG64 })),
  };
  return near;
}

export type FakeNear = ReturnType<typeof fakeNear>;

export const hanaError = (code: unknown, data?: Record<string, unknown>, message = String(code)) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
