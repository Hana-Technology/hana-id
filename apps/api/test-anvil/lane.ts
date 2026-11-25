// The anvil lane's kit (D868), in the Workers test pool: the node the global setup started (`inject('anvil')`), JSON-RPC
// to it with the REAL fetch (the NEAR session mock stubs fetch for everything else), a "world" per test (an app, a
// user recorded in the wallet directory, a fresh relayer key funded on the node, a fresh relayer object configured
// for it, the handlers' relayer port pointed at that object; the chain port is the handlers' own default, the real
// SponsorChain client over anvil), and the vault's own sequence for a sponsored action: prepare, then the authorization
// (only for an account with no code) and the Execute signed by core's guarded signers exactly as the vault signs them
// (packages/web/src/vault/evm-sponsor.ts sponsorSubject/signSponsored/sendBody: the deadline the vault picks, minGas
// = the prepare answer's maxMinGas), then send. Every key is derived here from a label (never a literal) and never
// leaves the test; the node is a local anvil that no public network can see.
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { type ExecuteInput, type SignedAuthorization, type SponsorTx, SPONSOR_DELEGATES, authorizationHash, encodeExecuteCalldata, executeDigest, signAuthorization, signExecute, signSponsorTx } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { inject, vi } from 'vitest';
import './provided.ts';
import type { Env } from '../src/env.ts';
import { type EvmRelayer, evmRelayerName } from '../src/evm-relayer.ts';
import { limiter } from '../src/handlers.ts';
import { checksumEvmAddress } from '../src/evm/sponsor-config.ts';
import { type EvmRelayerPort, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { EVM_SPONSOR_PREPARE_ENDPOINT as PREPARE, EVM_SPONSOR_SEND_ENDPOINT as SEND } from '../src/evm/sponsor.ts';
import { appSubjectOf, budgetWindow, DAY, envBudgetSubject } from '../src/evm/sponsor-settle.ts';
import { CHECK_IN, CHECK_IN_DATA, type ChainFields, LOCAL_CHAIN, nearMock, rememberAccount, sessionsInMemory, sponsorCall, sponsorEnv, sponsorVar, testKey, testUser, type TestUser, TOKEN, TRANSFER_SELECTOR, transferData } from '../test/evm-sponsor-helpers.ts';
import { seedApp, type SeededApp, uid } from '../test/helpers.ts';

export type Hex = `0x${string}`;
export const LANE = inject('anvil');
/** Why the lane is skipped here (no anvil), or null. */
export const SKIPPED = LANE.skipped;
export const CHAIN = LOCAL_CHAIN;
export const DELEGATE = SPONSOR_DELEGATES[CHAIN]!.address as Hex;
export const ETH = 10n ** 18n;
export const GWEI = 10n ** 9n;
export { CHECK_IN, CHECK_IN_DATA, PREPARE, SEND, TOKEN, TRANSFER_SELECTOR, transferData };

const REAL_FETCH = globalThis.fetch;
/**
 * A second name for the same node (a loopback host, as a `local*` env allows): a world given it as `rpcFallback` has
 * the second endpoint the relayer's automatic restart after a refill asks (D890). Fetched as the node itself.
 */
export const LANE_FALLBACK: string | null = LANE.url ? LANE.url.replace(/^http:\/\/[^:/]+/u, 'http://anvil-fallback.localhost') : null;

export const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
export const fromHex = (h: string): Uint8Array<ArrayBuffer> => {
  const s = h.slice(2);
  const out = new Uint8Array(new ArrayBuffer(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
export const keccak = (b: Uint8Array | string): Hex => toHex(keccak_256(typeof b === 'string' ? new TextEncoder().encode(b) : b));
export const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
export const addressWord = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');
export const q = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}`;
export const addressOf = (key: Uint8Array): Hex => checksumEvmAddress(toHex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(-20))) as Hex;

// ---- JSON-RPC to the node ----

export interface RpcAnswer<T = unknown> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}
let rpcId = 0;
/** One JSON-RPC call to anvil, its answer as is (result or error). */
export async function rpcRaw<T = unknown>(method: string, params: unknown[] = []): Promise<RpcAnswer<T>> {
  if (!LANE.url) throw new Error('anvil lane skipped');
  const res = await REAL_FETCH(LANE.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return (await res.json()) as RpcAnswer<T>;
}
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const a = await rpcRaw<T>(method, params);
  if (a.error) throw new Error(`${method}: ${a.error.code} ${a.error.message}`);
  return a.result as T;
}

export const mine = (blocks = 1): Promise<unknown> => rpc('anvil_mine', [q(blocks)]);
export const automine = (on: boolean): Promise<unknown> => rpc('evm_setAutomine', [on]);
export const setBalance = (a: string, wei: bigint): Promise<unknown> => rpc('anvil_setBalance', [a, q(wei)]);
export const balance = async (a: string): Promise<bigint> => BigInt(await rpc<string>('eth_getBalance', [a, 'latest']));
export const code = (a: string): Promise<string> => rpc<string>('eth_getCode', [a, 'latest']);
export const txCount = async (a: string, tag: 'latest' | 'pending' = 'latest'): Promise<number> => Number(await rpc<string>('eth_getTransactionCount', [a, tag]));
export const headNumber = async (): Promise<number> => Number(await rpc<string>('eth_blockNumber'));
export interface Receipt {
  transactionHash: Hex;
  status: Hex;
  type: Hex;
  from: Hex;
  to: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  logs: { address: Hex; topics: Hex[]; data: Hex }[];
}
export const receipt = (h: string): Promise<Receipt | null> => rpc<Receipt | null>('eth_getTransactionReceipt', [h]);
export const block = (tag: string | number): Promise<{ number: Hex; timestamp: Hex; baseFeePerGas: Hex; transactions: Hex[] }> => rpc('eth_getBlockByNumber', [typeof tag === 'number' ? q(tag) : tag, false]);
/** The delegate's Execute nonce of an account (its `nonce()`), as the handlers read it. */
export const executeNonceOf = async (a: string): Promise<bigint> => BigInt(await rpc<string>('eth_call', [{ to: a, data: '0xaffed0e0' }, 'latest']));
/** CheckIn's `checkIns(account)`. */
export const checkInsOf = async (a: string): Promise<bigint> => BigInt(await rpc<string>('eth_call', [{ to: CHECK_IN, data: `0x${keccak('checkIns(address)').slice(2, 10)}${addressWord(a)}` }, 'latest']));
/** The test token's balance of an account. */
export const tokenBalanceOf = async (a: string): Promise<bigint> => BigInt(await rpc<string>('eth_call', [{ to: TOKEN, data: `0x70a08231${addressWord(a)}` }, 'latest']));
/** The designator an account delegated to `impl` carries (EIP-7702). */
export const designator = (impl: string): string => `0xef0100${impl.slice(2).toLowerCase()}`;

/** anvil's first published development account: unlocked on every anvil (eth_sendTransaction), funded with test ETH. */
export const DEV_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Waits (polling the node, not sleeping on a guess) until `pred` holds, at most `ms`. */
export async function until(pred: () => Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
/**
 * Sends a signed transaction and waits for its receipt (automine on), so what the test reads next sees it mined: under
 * load anvil can answer the send before the block with it is the latest (D924).
 */
export async function sendMined(raw: string): Promise<string> {
  const hash = await rpc<string>('eth_sendRawTransaction', [raw]);
  await until(async () => (await receipt(hash)) !== null, 15_000, `the receipt of ${hash}`);
  return hash;
}
/** Until the node's pool holds a transaction of `from` at nonce `nonce` (its pending count past it). */
export const untilPooled = (from: string, nonce: number): Promise<void> => until(async () => (await txCount(from, 'pending')) > nonce, 15_000, `a pooled transaction of ${from} at ${nonce}`);

// ---- the test token (placed at the helpers' TOKEN address with anvil_setCode) ----

/**
 * A minimal ERC-20-shaped token, hand-assembled (no compiler at test time): balances in storage slot = the holder's
 * address. `transfer(address,uint256)` moves the amount from the caller, reverting with no data when it has less, logs
 * `Transfer` and returns true; `balanceOf(address)`; `setBalance(address,uint256)` (test-only, anyone may call it).
 */
export function tokenRuntime(): Hex {
  const SET = keccak('setBalance(address,uint256)').slice(2, 10);
  const TRANSFER_TOPIC = keccak('Transfer(address,address,uint256)').slice(2);
  type Op = string | { label: string } | { jump: string };
  const ops: Op[] = [
    '6000', '35', '60e0', '1c', // selector = calldata[0:4]
    '80', '63a9059cbb', '14', { jump: 'transfer' }, '57',
    '80', '6370a08231', '14', { jump: 'balanceOf' }, '57',
    '80', `63${SET}`, '14', { jump: 'setBalance' }, '57',
    '6000', '80', 'fd', // no such function: revert
    { label: 'balanceOf' }, '5b', '6004', '35', '54', '6000', '52', '6020', '6000', 'f3',
    { label: 'setBalance' }, '5b', '6024', '35', '6004', '35', '55', '00',
    { label: 'transfer' }, '5b',
    '6024', '35', // amt
    '33', '54', // amt bal
    '81', '81', '10', { jump: 'fail' }, '57', // bal < amt → fail
    '81', '90', '03', '33', '55', // sstore(caller, bal - amt); amt
    '6004', '35', '80', '54', '82', '01', '90', '55', // sstore(to, sload(to) + amt); amt
    '6000', '52', // mem[0] = amt
    '6004', '35', '33', `7f${TRANSFER_TOPIC}`, '6020', '6000', 'a3', // log3(0, 32, Transfer, caller, to)
    '6001', '6000', '52', '6020', '6000', 'f3', // return true
    { label: 'fail' }, '5b', '6000', '80', 'fd',
  ];
  // Two passes: the labels' offsets, then the bytes (each jump is PUSH2 <offset>).
  const at = new Map<string, number>();
  let pc = 0;
  for (const o of ops) {
    if (typeof o === 'string') pc += o.length / 2;
    else if ('label' in o) at.set(o.label, pc);
    else pc += 3;
  }
  let out = '';
  for (const o of ops) {
    if (typeof o === 'string') out += o;
    else if ('jump' in o) out += `61${at.get(o.jump)!.toString(16).padStart(4, '0')}`;
  }
  return `0x${out}`;
}

export async function placeToken(): Promise<void> {
  await rpc('anvil_setCode', [TOKEN, tokenRuntime()]);
}
export const setTokenBalance = (holder: string, amount: bigint): Promise<unknown> => rpc('anvil_setStorageAt', [TOKEN, `0x${addressWord(holder)}`, `0x${word(amount)}`]);

// ---- fetch: the node through the real fetch, everything else to the NEAR session mock ----

/** After nearMock(): anvil's URL goes to the real fetch, any other to the mock installed before. */
export function routeAnvil(): void {
  const before = vi.isMockFunction(globalThis.fetch) ? (globalThis.fetch as unknown as { getMockImplementation(): ((i: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined }).getMockImplementation() : undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (LANE.url && (url === LANE.url || url === `${LANE.url}/`)) return REAL_FETCH(input, init);
    if (LANE_FALLBACK && (url === LANE_FALLBACK || url === `${LANE_FALLBACK}/`)) return REAL_FETCH(LANE.url!, init);
    if (before) return before(input, init);
    throw new Error('Unexpected fetch');
  });
}

// ---- the world ----

type Stub = DurableObjectStub<EvmRelayer>;
export interface World {
  app: SeededApp;
  user: TestUser;
  relayerKey: Uint8Array;
  relayer: Hex;
  bindings: Partial<Env>;
  sponsor: string;
  stub: Stub;
}

/** The EVM_SPONSOR var for these apps with this relayer, the chain's rpc the node (D836's numbers; `fields` override). */
export function laneSponsorVar(appIds: string[], relayer: Hex, fields: ChainFields = {}): string {
  const v = JSON.parse(sponsorVar(appIds, CHAIN, { rpc: LANE.url, sendsPerMinute: 100_000, ...fields })) as { relayerAddress: string };
  v.relayerAddress = relayer;
  return JSON.stringify(v);
}

export async function configureRelayer(stub: Stub, over: Partial<Env>): Promise<void> {
  await runInDurableObject(stub, (instance: EvmRelayer) => {
    const self = instance as unknown as { env: Env };
    self.env = { ...self.env, ...over } as Env;
  });
}

/** A fresh world on the node: app, user (1 test ETH of its own), a relayer key funded with `relayerWei`, its object. */
export async function world(o: { fields?: ChainFields; relayerWei?: bigint; userWei?: bigint } = {}): Promise<World> {
  nearMock();
  routeAnvil();
  const app = await seedApp();
  await sessionsInMemory(app.id);
  const user = testUser(`anvil user ${uid()}`);
  await rememberAccount(app.scope, user.address);
  await setBalance(user.address, o.userWei ?? ETH);
  const relayerKey = testKey(`anvil relayer ${uid()}`);
  const relayer = addressOf(relayerKey);
  await setBalance(relayer, o.relayerWei ?? ETH);
  const sponsor = laneSponsorVar([app.id], relayer, o.fields);
  const bindings = sponsorEnv(sponsor, null, { EVM_RELAY_KEYS: JSON.stringify([toHex(relayerKey)]) } as never) as Partial<Env>;
  const stub = env.EVM_RELAYER!.get(env.EVM_RELAYER!.idFromName(`${evmRelayerName(CHAIN)}-anvil-${uid()}`));
  await configureRelayer(stub, bindings);
  sponsorPorts.relayer = () => stub as unknown as EvmRelayerPort;
  return { app, user, relayerKey, relayer, bindings, sponsor, stub };
}

export const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

export interface Call {
  to: Hex;
  data: Hex;
}
export const checkInCall: Call = { to: CHECK_IN as Hex, data: CHECK_IN_DATA as Hex };
export const transferCall = (to: Hex, amount: bigint): Call => ({ to: TOKEN as Hex, data: transferData(to, amount) as Hex });

export interface Prepared {
  status: number;
  body: Record<string, unknown>;
}
export async function prepare(w: World, calls: Call[]): Promise<Prepared> {
  const r = await sponsorCall(PREPARE, w.app, w.bindings, { body: { chainId: CHAIN, account: w.user.address, calls: calls.map((c) => ({ to: c.to, value: '0', data: c.data })) } });
  return { status: r.status, body: await json(r) };
}

export interface Signed {
  body: Record<string, unknown>;
  input: ExecuteInput;
  digest: Hex;
  calldata: Hex;
  withAuthorization: boolean;
}

/**
 * The vault's signatures for a prepare answer (sponsorSubject + signSponsored + sendBody): the deadline the vault's
 * clock plus min(5 min, deadlineMaxS − 60 s), minGas the answer's maxMinGas, the authorization only for an account with
 * no code (at its pending count), both through core's guarded signers with the build's enabled chain. `over` changes
 * the Execute input before signing (refusal tests).
 */
export function vaultSign(w: World, calls: Call[], p: Record<string, unknown>, over: Partial<ExecuteInput> = {}): Signed {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.min(300, Number(p.deadlineMaxS) - 60));
  const input: ExecuteInput = { chainId: CHAIN, account: w.user.address, implementation: DELEGATE, calls: calls.map((c) => ({ to: c.to, value: 0n, data: c.data })), nonce: BigInt(String(p.executeNonce)), deadline, relayer: w.relayer, minGas: BigInt(String(p.maxMinGas)), ...over };
  const signature = signExecute(w.user.key, input, { enabledChains: [CHAIN] });
  const a = p.delegation === 'none' ? signAuthorization(w.user.key, { chainId: CHAIN, address: DELEGATE, nonce: BigInt(String(p.accountNonce)) }, { enabledChains: [CHAIN] }) : null;
  const body: Record<string, unknown> = {
    chainId: CHAIN,
    account: w.user.address,
    calls: calls.map((c) => ({ to: c.to, value: '0', data: c.data })),
    executeNonce: input.nonce.toString(),
    deadline: input.deadline.toString(),
    relayer: input.relayer,
    minGas: input.minGas.toString(),
    signature,
    ...(a ? { authorization: { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s } } : {}),
  };
  return { body, input, digest: toHex(executeDigest(input)), calldata: encodeExecuteCalldata(input, signature).toLowerCase() as Hex, withAuthorization: a !== null };
}

export const send = (w: World, body: Record<string, unknown>): Promise<Response> => sponsorCall(SEND, w.app, w.bindings, { body });

/** Prepare, sign as the vault, send: the response, the signed batch and the prepare answer. */
export async function act(w: World, calls: Call[], over: Partial<ExecuteInput> = {}): Promise<{ res: Response; body: Record<string, unknown>; signed: Signed; prepared: Record<string, unknown> }> {
  const p = await prepare(w, calls);
  if (p.status !== 200) throw new Error(`prepare answered ${p.status} ${JSON.stringify(p.body)}`);
  const signed = vaultSign(w, calls, p.body, over);
  const res = await send(w, signed.body);
  return { res, body: await json(res), signed, prepared: p.body };
}

// ---- the service's records ----

export interface AuditRow {
  id: string;
  status: string;
  tx_hash: string | null;
  tx_hashes: string;
  relayer_nonce: number | null;
  reserved_wei: string;
  gas_limit: string;
  settled_wei: string | null;
  rejection: string | null;
  with_setup: number;
  call_count: number;
  confirmed_at: number | null;
}
export const auditRows = async (account: string): Promise<AuditRow[]> => (await env.DB.prepare('SELECT * FROM evm_sponsor_sends WHERE account = ?1 ORDER BY created_at').bind(account).all<AuditRow>()).results;
export interface BillingRow {
  record_key: string;
  send_id: string;
  corrects: string | null;
  tx_hash: string | null;
  block_number: string | null;
  block_timestamp: number | null;
  outcome: string;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  execution_wei: string | null;
  l1_fee_wei: string | null;
  operator_fee_wei: string | null;
  total_cost_wei: string | null;
  settled_wei: string;
  call_count: number;
  targets_json: string;
  with_setup: number;
}
export const billingRows = async (sendId: string): Promise<BillingRow[]> => (await env.DB.prepare('SELECT * FROM evm_sponsor_billing WHERE send_id = ?1 ORDER BY created_at, record_key').bind(sendId).all<BillingRow>()).results;
/** The app's and the env's day spend in wei (the budgets the handlers reserve from). */
export async function spent(appId: string, now = Date.now()): Promise<{ app: bigint; env: bigint }> {
  const [a, e] = await Promise.all([limiter(env as Env, appSubjectOf(appId)).spent(budgetWindow(CHAIN), DAY, now), limiter(env as Env, envBudgetSubject(CHAIN)).spent(budgetWindow(CHAIN), DAY, now)]);
  return { app: BigInt(a), env: BigInt(e) };
}

/** Runs the relayer's alarm now (its run: receipts, finalisation, bumps, cancels, halts). */
export const relayerRun = (w: World): Promise<boolean> => runDurableObjectAlarm(w.stub);

/** A transaction from `key` signed by core's relayer signer (type 2), for raw-pool tests. */
export function rawTx(key: Uint8Array, t: { nonce: number; to?: string; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas?: bigint; data?: Hex; chainId?: number; value?: bigint }): Hex {
  const tx: SponsorTx = { type: 'eip1559', chainId: BigInt(t.chainId ?? CHAIN), nonce: BigInt(t.nonce), maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, gas: t.gas ?? 21_000n, to: fromHex(t.to ?? addressOf(key)), value: t.value ?? 0n, data: fromHex(t.data ?? '0x'), accessList: [] };
  return signSponsorTx(key, tx);
}

/** An EIP-7702 authorization signed by `key` with no signer-side checks (core's signer refuses any but the pinned delegate). */
export function rawAuthorization(key: Uint8Array, a: { chainId: number; address: Hex; nonce: bigint }): SignedAuthorization {
  const sig = secp256k1.sign(authorizationHash(a), key, { lowS: true });
  return { ...a, yParity: sig.recovery as 0 | 1, r: `0x${sig.r.toString(16).padStart(64, '0')}`, s: `0x${sig.s.toString(16).padStart(64, '0')}` };
}

/** A type-4 transaction from `key` carrying `authorizations`. */
export function rawType4(key: Uint8Array, t: { nonce: number; to: string; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas?: bigint; data?: Hex; authorizations: SignedAuthorization[] }): Hex {
  return signSponsorTx(key, { type: 'eip7702', chainId: BigInt(CHAIN), nonce: BigInt(t.nonce), maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, gas: t.gas ?? 100_000n, to: fromHex(t.to), value: 0n, data: fromHex(t.data ?? '0x'), accessList: [], authorizationList: t.authorizations });
}

const REAL_NOW = Date.now.bind(Date);
let aheadMs = 0;
/** Date.now runs `ms` ahead of the wall clock from now on (the relayer object runs in this isolate too). */
export function clockAhead(ms: number): void {
  aheadMs = ms;
  if (!vi.isMockFunction(Date.now)) vi.spyOn(Date, 'now').mockImplementation(() => REAL_NOW() + aheadMs);
}
/** Date.now reads `atMs` now (and runs on from there with the wall clock). */
export const clockTo = (atMs: number): void => clockAhead(atMs - REAL_NOW());
