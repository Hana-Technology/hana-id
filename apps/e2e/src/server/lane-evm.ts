// An admin lane's EVM chain (chain 31337, admin-lane-worker.ts): the stack's mocked chain (partner.ts MockEvm: each
// sender's count, the relayer's transactions run as the delegate would, receipts) behind a transaction pool the lane's
// controls drive, so the REAL relayer object meets the evidence each of its pauses is about:
//
//   hold        broadcasts are taken into the pool and not mined (a transaction waiting to go through); `release`
//               mines the pool in nonce order. A transaction is mined only at its sender's next nonce.
//   refuse      the relayer's broadcasts are refused as a node refuses an unfunded sender ("Insufficient funds for gas
//               * price + value", anvil's text); `balanceWei` is what eth_getBalance says the relayer holds.
//   foreign     a transaction signed with the relayer's key that the relayer never sent (someone else has the key),
//               mined at once, replacing a pooled one at the same nonce (`pool` → pooled instead, for a gap).
//   drop        a pooled transaction leaves the pool (a node dropped it).
//
// The pinned delegate's address answers its real runtime code (contracts/evm-delegate's checked-in artifact, its
// immutables filled in), so the admin's "Account helper program" check meets the code hash core pins. `eth_getBalance`
// of any other account is 1 ETH; latest, pending and confirmed counts follow the pool (one block: mined is confirmed).
import { readFileSync } from 'node:fs';
import { type Hex, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { E2E_SPONSOR_DELEGATE, EVM_CHAIN_ID } from '../stack.ts';
import { json } from './http.ts';
import { MockEvm } from './partner.ts';

const ARTIFACT = new URL('../../../../contracts/evm-delegate/artifacts/HanaDelegateExecutor.json', import.meta.url);

/** The delegate's runtime code at its pinned address: the artifact's deployed bytecode with its immutables (the address). */
export function delegateRuntimeCode(): Hex {
  const a = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { deployedBytecode: string; immutableReferences: { start: number; length: number }[]; create2: { address: string } };
  let code = a.deployedBytecode.replace(/^0x/u, '');
  const self = a.create2.address.slice(2).toLowerCase().padStart(64, '0');
  for (const r of a.immutableReferences) code = code.slice(0, r.start * 2) + self + code.slice((r.start + r.length) * 2);
  return `0x${code}`;
}

const ETH = 10n ** 18n;
const rpcError = (id: unknown, code: number, message: string): Response => json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

interface Pooled {
  hash: Hex;
  raw: Hex;
  from: string;
  nonce: number;
  foreign: boolean;
}

export class LaneEvm {
  /** Mined transactions: the stack's mocked chain (its counts, delegate execution and receipts). */
  private readonly chain: MockEvm;
  private readonly inner: ReturnType<MockEvm['handler']>;
  private readonly code = delegateRuntimeCode();
  /** Pooled transactions by sender (lowercase) and nonce. */
  private readonly pool = new Map<string, Map<number, Pooled>>();
  /** Mined counts per sender (lowercase), mirrored from what was handed to the chain. */
  private readonly mined = new Map<string, number>();
  private readonly relayer: string;
  hold = false;
  refuse = false;
  balanceWei = ETH;
  /** Every broadcast the relayer made (hash and nonce), in order: the tests' evidence of what it sent. */
  readonly broadcasts: { hash: Hex; nonce: number; at: number }[] = [];

  constructor(private readonly relayerKey: Hex) {
    this.relayer = privateKeyToAccount(relayerKey).address.toLowerCase();
    this.chain = new MockEvm(this.relayer);
    this.inner = this.chain.handler();
  }

  private count(from: string): number {
    return this.mined.get(from) ?? 0;
  }

  /** The pending count: mined, then each pooled nonce in a row after it. */
  private pending(from: string): number {
    let n = this.count(from);
    const pool = this.pool.get(from);
    while (pool?.has(n)) n += 1;
    return n;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.inner(new Request('http://lane-evm.localhost/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), new AbortController().signal);
    const b = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (b.error) throw new Error(b.error.message);
    return b.result;
  }

  /** Mines one transaction on the chain (its sender's count moves). */
  private async mineNow(p: Pooled): Promise<void> {
    await this.call('eth_sendRawTransaction', [p.raw]);
    this.mined.set(p.from, this.count(p.from) + 1);
    this.pool.get(p.from)?.delete(p.nonce);
  }

  /** Mines every pooled transaction that is at its sender's next nonce, in order. */
  async release(): Promise<number> {
    let n = 0;
    for (const [from, pool] of this.pool) {
      for (let p = pool.get(this.count(from)); p; p = pool.get(this.count(from))) {
        await this.mineNow(p);
        n += 1;
      }
    }
    return n;
  }

  /** A transaction signed with the relayer's key outside the relayer: mined at its nonce now, or only pooled (`pool`). */
  async foreign(nonce: number, opts: { pool?: boolean } = {}): Promise<Hex> {
    const account = privateKeyToAccount(this.relayerKey);
    const raw = await account.signTransaction({ chainId: EVM_CHAIN_ID, type: 'eip1559', nonce, to: account.address, value: 0n, gas: 21_000n, maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const p: Pooled = { hash: keccak256(raw), raw, from: this.relayer, nonce, foreign: true };
    if (opts.pool) {
      this.poolOf(this.relayer).set(nonce, p);
      return p.hash;
    }
    if (nonce !== this.count(this.relayer)) throw new Error(`foreign: the relayer's next nonce on chain is ${this.count(this.relayer)}, not ${nonce}`);
    // Mined at the nonce: whatever the pool held there is gone (the network took the other one).
    this.pool.get(this.relayer)?.delete(nonce);
    await this.mineNow(p);
    return p.hash;
  }

  /** A pooled transaction (by hash) leaves the pool. */
  drop(hash: string): boolean {
    for (const pool of this.pool.values()) {
      for (const [n, p] of pool) {
        if (p.hash === hash.toLowerCase()) {
          pool.delete(n);
          return true;
        }
      }
    }
    return false;
  }

  /** The chain as the tests see it: the relayer's counts and its pooled nonces. */
  view(): { latest: number; pending: number; pooled: { nonce: number; foreign: boolean }[]; hold: boolean; refuse: boolean; balanceWei: string } {
    const pool = [...(this.pool.get(this.relayer)?.values() ?? [])].sort((a, b) => a.nonce - b.nonce);
    return { latest: this.count(this.relayer), pending: this.pending(this.relayer), pooled: pool.map((p) => ({ nonce: p.nonce, foreign: p.foreign })), hold: this.hold, refuse: this.refuse, balanceWei: this.balanceWei.toString() };
  }

  private poolOf(from: string): Map<number, Pooled> {
    let p = this.pool.get(from);
    if (!p) {
      p = new Map();
      this.pool.set(from, p);
    }
    return p;
  }

  private async broadcast(id: unknown, raw: Hex): Promise<Response> {
    let from: string;
    let nonce: number;
    try {
      nonce = Number(parseTransaction(raw).nonce ?? 0);
      from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    } catch {
      return rpcError(id, -32602, 'Failed to decode transaction');
    }
    const hash = keccak256(raw);
    if (from === this.relayer) this.broadcasts.push({ hash, nonce, at: Date.now() });
    if (from === this.relayer && this.refuse) return rpcError(id, -32003, 'Insufficient funds for gas * price + value');
    if ([...(this.pool.get(from)?.values() ?? [])].some((p) => p.hash === hash)) return rpcError(id, -32003, 'transaction already imported');
    if (nonce < this.count(from)) return rpcError(id, -32003, 'nonce too low');
    const p: Pooled = { hash, raw, from, nonce, foreign: false };
    // Into the pool (a replacement at the same nonce takes its place); mined at once unless held.
    this.poolOf(from).set(nonce, p);
    if (!this.hold) await this.release();
    return json(200, { jsonrpc: '2.0', id: id ?? null, result: hash });
  }

  handler(): (request: Request) => Promise<Response> {
    return async (request) => {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const body = (await request.json()) as { id?: unknown; method?: string; params?: unknown[] };
      const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: body.id ?? null, result });
      const p0 = typeof body.params?.[0] === 'string' ? body.params[0].toLowerCase() : '';
      switch (body.method) {
        case 'eth_sendRawTransaction':
          return typeof body.params?.[0] === 'string' && /^0x[0-9a-f]+$/iu.test(body.params[0]) ? this.broadcast(body.id, body.params[0] as Hex) : rpcError(body.id, -32602, 'invalid raw transaction');
        case 'eth_getTransactionCount':
          return ok(`0x${(body.params?.[1] === 'pending' ? this.pending(p0) : this.count(p0)).toString(16)}`);
        case 'eth_getBalance':
          return ok(`0x${(p0 === this.relayer ? this.balanceWei : ETH).toString(16)}`);
        case 'eth_getCode':
          if (p0 === E2E_SPONSOR_DELEGATE.toLowerCase()) return ok(this.code);
          return this.inner(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }), new AbortController().signal);
        default:
          return this.inner(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }), new AbortController().signal);
      }
    };
  }
}
