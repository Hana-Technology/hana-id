// A local NEAR node for the meta-transaction tests (D730): near-sandbox, the binary near-workspaces downloads for the
// contract lane (contracts/integration-tests), started on loopback ports with a fresh home per run. Its genesis
// account `test.near` (key in <home>/validator_key.json) funds every account a test makes. Throwaway keys only:
// nothing here ever reaches testnet or mainnet.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair, type KeyPairString, PublicKey } from '@near-js/crypto';
import { type Action, actionCreators, buildDelegateAction, createTransaction, encodeDelegateAction, encodeSignedDelegate, encodeTransaction, Signature, SignedDelegate, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { encodeRelayTransaction, encodeSignedTransaction, type RelayAction } from '../src/near/delegate.ts';
import { type FinalOutcome, Rpc, RpcHealth } from '../src/near/rpc.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The near-sandbox binary: NEAR_SANDBOX_BIN_PATH (the near-workspaces variable), else the one the contract lane's build downloaded. Null when neither. */
export function sandboxBinary(): string | null {
  const fromEnv = process.env.NEAR_SANDBOX_BIN_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const build = join(ROOT, 'contracts/integration-tests/target/debug/build');
  if (!existsSync(build)) return null;
  for (const dir of readdirSync(build).filter((d) => d.startsWith('near-sandbox-')).sort().reverse()) {
    const near = join(build, dir, 'out/.near');
    if (!existsSync(near)) continue;
    for (const v of readdirSync(near).sort().reverse()) {
      const bin = join(near, v, 'near-sandbox');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * The stamps contract's wasm (contracts/hana-stamps, D796): the build the Rust sandbox tests make as deploy-stamps
 * does (`--no-abi`, run just before this lane in `pnpm verify`'s sandbox step), else the contract lane's build. Null
 * when neither exists.
 */
export function stampsWasm(): Uint8Array | null {
  for (const p of ['contracts/integration-tests/target/wasm-stamps/near/hana_stamps.wasm', 'contracts/hana-stamps/target/near/hana_stamps.wasm']) {
    const path = join(ROOT, p);
    if (existsSync(path)) return new Uint8Array(readFileSync(path));
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

export interface Signer {
  accountId: string;
  keyPair: KeyPair;
}

export interface Sandbox {
  rpcUrl: string;
  rpc: Rpc;
  root: Signer;
  stop(): void;
}

/** Starts a node and waits until it answers `status` with a block. */
export async function startSandbox(bin: string): Promise<Sandbox> {
  const home = mkdtempSync(join(tmpdir(), 'hana-meta-sandbox-'));
  const init = spawn(bin, ['--home', home, 'init'], { stdio: 'ignore' });
  await new Promise<void>((res, rej) => init.on('exit', (code) => (code === 0 ? res() : rej(new Error(`near-sandbox init exited ${code}`)))));
  const rpcPort = await freePort();
  const netPort = await freePort();
  const node: ChildProcess = spawn(bin, ['--home', home, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${netPort}`], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const stop = () => {
    node.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }) });
      const j = (await r.json()) as { result?: { header?: { height?: number } } };
      if ((j.result?.header?.height ?? 0) > 1) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error('near-sandbox did not start');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const vk = JSON.parse(readFileSync(join(home, 'validator_key.json'), 'utf8')) as { account_id: string; secret_key: string };
  const rpc = new Rpc(rpcUrl, { health: new RpcHealth() });
  return { rpcUrl, rpc, root: { accountId: vk.account_id, keyPair: KeyPair.fromString(vk.secret_key as KeyPairString) }, stop };
}

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

export interface Block {
  hash: string;
  height: number;
  gasPrice: bigint;
}

export async function finalBlock(rpc: Rpc): Promise<Block> {
  const b = await rpc.call<{ header: { hash: string; height: number; gas_price: string } }>('block', { finality: 'final' }, 8_000);
  return { hash: b.header.hash, height: b.header.height, gasPrice: BigInt(b.header.gas_price) };
}

export async function accessKeyNonce(rpc: Rpc, accountId: string, publicKey: string): Promise<bigint> {
  return BigInt((await rpc.viewAccessKey(accountId, publicKey)).nonce);
}

/** The account's balance (yocto), or null when it doesn't exist. */
export async function balanceOf(rpc: Rpc, accountId: string): Promise<bigint | null> {
  try {
    const a = await rpc.call<{ amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId }, 8_000);
    return BigInt(a.amount);
  } catch (e) {
    if (/UNKNOWN_ACCOUNT|does not exist/u.test(String((e as Error).message))) return null;
    throw e;
  }
}

export async function viewAccount(rpc: Rpc, accountId: string): Promise<{ amount: string; storage_usage: number }> {
  return rpc.call('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId }, 8_000);
}

/** The contract's storage as key → value (utf8), from `view_state`. */
export async function viewState(rpc: Rpc, accountId: string): Promise<Record<string, string>> {
  const r = await rpc.call<{ values: { key: string; value: string }[] }>('query', { request_type: 'view_state', finality: 'optimistic', account_id: accountId, prefix_base64: '' }, 8_000);
  const out: Record<string, string> = {};
  for (const { key, value } of r.values) out[Buffer.from(key, 'base64').toString('utf8')] = Buffer.from(value, 'base64').toString('utf8');
  return out;
}

/** Signs and sends a transaction from `signer` (its next nonce, a final block), waiting for every receipt. */
export async function send(rpc: Rpc, signer: Signer, receiverId: string, actions: Action[]): Promise<FinalOutcome & { hash: string }> {
  const pk = signer.keyPair.getPublicKey();
  const [nonce, block] = await Promise.all([accessKeyNonce(rpc, signer.accountId, pk.toString()), finalBlock(rpc)]);
  const signed = signTx(signer, receiverId, nonce + 1n, block.hash, actions);
  const out = await rpc.sendTx(signed.bytes, 'EXECUTED');
  return { ...(out as FinalOutcome), hash: signed.hash };
}

export function signTx(signer: Signer, receiverId: string, nonce: bigint, blockHash: string, actions: Action[]): { bytes: Uint8Array; hash: string } {
  const pk = signer.keyPair.getPublicKey();
  const tx = createTransaction(signer.accountId, pk, receiverId, nonce, actions, baseDecode(blockHash));
  const hash = new Uint8Array(sha256(encodeTransaction(tx)));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pk.keyType, data: signer.keyPair.sign(hash).signature }) });
  return { bytes: signed.encode(), hash: baseEncode(hash) };
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/** A sub-account of the root with `amount` and one full-access key (returned), optionally with a contract. */
export async function createAccount(sb: Sandbox, name: string, amount: bigint, code?: Uint8Array): Promise<Signer> {
  const keyPair = KeyPair.fromRandom('ed25519');
  const accountId = `${name}.${sb.root.accountId}`;
  const actions: Action[] = [actionCreators.createAccount(), actionCreators.transfer(amount), actionCreators.addKey(keyPair.getPublicKey(), actionCreators.fullAccessKey())];
  if (code) actions.push(actionCreators.deployContract(code));
  const out = await send(sb.rpc, sb.root, accountId, actions);
  assertSuccess(out, `create ${accountId}`);
  return { accountId, keyPair };
}

/** Throws with the failure when any step of the outcome failed. */
export function assertSuccess(out: Partial<FinalOutcome>, what: string): void {
  const failed = failures(out);
  if (failed.length) throw new Error(`${what} failed: ${JSON.stringify(failed)}`);
}

/** Every Failure in the transaction's status and its receipts. */
export function failures(out: Partial<FinalOutcome>): unknown[] {
  const list: unknown[] = [];
  if (typeof out.status === 'object' && out.status && 'Failure' in out.status && out.status.Failure) list.push(out.status.Failure);
  for (const r of out.receipts_outcome ?? []) {
    const s = r.outcome.status;
    if (typeof s === 'object' && s && 'Failure' in s && s.Failure) list.push(s.Failure);
  }
  return list;
}

/** A fresh Ed25519 key and its implicit account id (lowercase hex of the public key). */
export function implicitAccount(): Signer & { publicKey: PublicKey } {
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey();
  return { accountId: Buffer.from(publicKey.data).toString('hex'), keyPair, publicKey };
}

export type User = Signer & { publicKey: PublicKey };

/** A delegate signed as a wallet would: @near-js's encoder, NEP-461 prefix, the user's own key. */
export function signDelegate(user: User, receiverId: string, actions: Action[], nonce: bigint, maxBlockHeight: bigint): Uint8Array {
  const da = buildDelegateAction({ senderId: user.accountId, receiverId, actions, nonce, maxBlockHeight, publicKey: user.publicKey });
  const hash = sha256(encodeDelegateAction(da));
  const signed = new SignedDelegate({ delegateAction: da, signature: new Signature({ keyType: 0, data: user.keyPair.sign(new Uint8Array(hash)).signature }) });
  return encodeSignedDelegate(signed);
}

/** The relay's own transaction (near/delegate.ts encoder), signed by the relay account's key and sent. */
export async function relayTx(sb: Sandbox, relayer: Signer, receiverId: string, action: RelayAction): Promise<FinalOutcome & { hash: string }> {
  const pk = relayer.keyPair.getPublicKey();
  const [nonce, block] = await Promise.all([accessKeyNonce(sb.rpc, relayer.accountId, pk.toString()), finalBlock(sb.rpc)]);
  const tx = encodeRelayTransaction({ signerId: relayer.accountId, publicKey: pk.data, nonce: nonce + 1n, receiverId, blockHash: block.hash, action });
  const bytes = encodeSignedTransaction(tx, relayer.keyPair.sign(new Uint8Array(sha256(tx))).signature);
  const out = await sb.rpc.sendTx(bytes, 'EXECUTED');
  return out as FinalOutcome & { hash: string };
}

// ---- a tiny test contract, assembled by hand (no toolchain needed) ----

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const name = (s: string): number[] => [...uleb(s.length), ...Buffer.from(s, 'utf8')];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const I64 = 0x7e;

/**
 * A contract with one method, `note()`: it stores the caller (`predecessor_account_id`) under the key `p`. Zero
 * deposit, no arguments, no panics: the stand-in for the guestbook's `add_message` in these tests.
 *
 *   (import "env" "predecessor_account_id" (func (param i64)))
 *   (import "env" "read_register" (func (param i64 i64)))
 *   (import "env" "register_len" (func (param i64) (result i64)))
 *   (import "env" "storage_write" (func (param i64 i64 i64 i64 i64) (result i64)))
 *   (memory 1) (export "memory") (data (i32.const 0) "p")
 *   (func (export "note") predecessor(0); read_register(0, 16); drop(storage_write(1, 0, register_len(0), 16, 1)))
 */
export function noteContractWasm(): Uint8Array {
  const types = vec([
    [0x60, ...vec([[I64]]), ...vec([])],
    [0x60, ...vec([[I64], [I64]]), ...vec([])],
    [0x60, ...vec([[I64]]), ...vec([[I64]])],
    [0x60, ...vec([[I64], [I64], [I64], [I64], [I64]]), ...vec([[I64]])],
    [0x60, ...vec([]), ...vec([])],
  ]);
  const imports = vec([
    [...name('env'), ...name('predecessor_account_id'), 0x00, 0],
    [...name('env'), ...name('read_register'), 0x00, 1],
    [...name('env'), ...name('register_len'), 0x00, 2],
    [...name('env'), ...name('storage_write'), 0x00, 3],
  ]);
  const funcs = vec([[4]]);
  const memory = vec([[0x00, 0x01]]);
  const exports = vec([
    [...name('memory'), 0x02, 0],
    [...name('note'), 0x00, 4],
  ]);
  const c = (n: number) => [0x42, n]; // i64.const (n < 64)
  const call = (f: number) => [0x10, f];
  const body = [0x00, ...c(0), ...call(0), ...c(0), ...c(16), ...call(1), ...c(1), ...c(0), ...c(0), ...call(2), ...c(16), ...c(1), ...call(3), 0x1a, 0x0b];
  const code = vec([[...uleb(body.length), ...body]]);
  const data = vec([[0x00, 0x41, 0x00, 0x0b, ...vec([[0x70]])]]);
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, funcs),
    ...section(5, memory),
    ...section(7, exports),
    ...section(10, code),
    ...section(11, data),
  ]);
}
