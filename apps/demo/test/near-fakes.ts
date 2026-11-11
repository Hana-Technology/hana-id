// Fakes for the NEAR card's tests: the SDK's `hana.near` (each method a vi.fn the test can hold open) and the env's NEAR
// JSON-RPC (an access key that may not exist yet, the latest block, a balance, the guestbook's messages, send_tx).
import { vi } from 'vitest';
import { nearImplicitPublicKey, nearPublicKeyString, utf8 } from '@hana-id/core';
import { base58 } from '@scure/base';

export const BLOCK_HASH = base58.encode(new Uint8Array(32).fill(9));
export const TX_HASH = base58.encode(new Uint8Array(32).fill(4));

export function fakeNear(accountId: () => string | null) {
  return {
    get accountId(): string | null {
      return accountId();
    },
    get publicKey(): string | null {
      const id = accountId();
      return id === null ? null : nearPublicKeyString(nearImplicitPublicKey(id));
    },
    activate: vi.fn(async (): Promise<{ created: boolean }> => ({ created: true })),
    signDelegateAction: vi.fn(async (_p: { network: string; delegateAction: Uint8Array | string }) => ({ signature: 'c2ln', signedDelegateAction: 'U0lHTkVEREVMRUdBVEU=' })),
    relay: vi.fn(async (_p: { network: string; signedDelegateAction: Uint8Array | string }) => ({ transactionHash: TX_HASH, status: 'executed' })),
    signTransaction: vi.fn(async (_p: { network: string; transaction: Uint8Array | string }) => ({ signature: 'c2ln', signedTransaction: 'U0lHTkVEVFJBTlNBQ1RJT05TSUdORURUUkFOU0FDVElPTg==', hash: TX_HASH })),
    signMessage: vi.fn(async (_p: { message: string; recipient: string; nonce: Uint8Array | string }) => ({ accountId: accountId()!, publicKey: nearPublicKeyString(nearImplicitPublicKey(accountId()!)), signature: 'TkVQNDEzU0lH' })),
  };
}

export type FakeNear = ReturnType<typeof fakeNear>;

interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

export class FakeNearRpc {
  /** The user's access key, or null: the account doesn't exist on testnet yet. */
  key: { nonce: number } | null = { nonce: 1000 };
  height = 200_000_000;
  /** yoctoNEAR. */
  balance = '0';
  messages: Record<string, unknown>[] = [];
  /** Every endpoint answers 503. */
  down = false;
  readonly calls: { url: string; body: RpcCall }[] = [];
  readonly sent: string[] = [];

  readonly fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(init.body as string) as RpcCall;
    this.calls.push({ url, body });
    if (this.down) return new Response('down', { status: 503 });
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 'hana-demo', result });
    const err = (name: string) => Response.json({ jsonrpc: '2.0', id: 'hana-demo', error: { name: 'HANDLER_ERROR', cause: { name }, code: -32000, message: name } });
    const p = body.params;
    if (body.method === 'block') return ok({ header: { height: this.height, hash: BLOCK_HASH } });
    if (body.method === 'send_tx') {
      this.sent.push(String(p.signed_tx_base64));
      return ok({ status: { SuccessValue: '' }, transaction: { hash: TX_HASH } });
    }
    if (body.method === 'query' && p.request_type === 'view_access_key') return this.key ? ok({ nonce: this.key.nonce, block_height: this.height, block_hash: BLOCK_HASH, permission: 'FullAccess' }) : err('UNKNOWN_ACCOUNT');
    if (body.method === 'query' && p.request_type === 'view_account') return this.key ? ok({ amount: this.balance, locked: '0', storage_usage: 182 }) : err('UNKNOWN_ACCOUNT');
    if (body.method === 'query' && p.request_type === 'call_function' && p.method_name === 'get_messages') return ok({ result: Array.from(utf8(JSON.stringify(this.messages))), logs: [] });
    return err('UNKNOWN');
  });

  count(pred: (c: RpcCall) => boolean): number {
    return this.calls.filter((c) => pred(c.body)).length;
  }
}
