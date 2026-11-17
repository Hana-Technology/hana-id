// EVM gas sponsorship's test kit: derived throwaway keys (never a real account), the EVM_SPONSOR var for a seeded app,
// signed send bodies, and fakes for the two ports (evm/sponsor-ports.ts): a chain that records every read and a
// relayer binding that records every send. Nothing here talks to a network.
import { env } from 'cloudflare:workers';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { authorizationHash, executeDigest, SPONSOR_DELEGATES, type ExecuteInput } from '@hana-id/core/evm-sponsor';
import { checksumEvmAddress } from '../src/evm/sponsor-config.ts';
import { EXECUTED_TOPIC } from '../src/evm/sponsor-checks.ts';
import { type EvmRelayerLookup, type EvmRelayerSendRequest, type EvmRelayerStatus, type Hex, keccakHex, type SponsorCallRequest, type SponsorChainPort, type SponsorReceipt, SponsorRpcError, type SponsorStateOverride } from '../src/evm/sponsor-ports.ts';
import { call, type SeededApp, uid } from './helpers.ts';
import { vaultHeaders } from './vault-helpers.ts';

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The EIP-55 address of a key (an implementation independent of core's signer). */
const evmSignerAddress = (d: Uint8Array): Hex => checksumEvmAddress(`0x${hex(keccak_256(secp256k1.getPublicKey(d, false).subarray(1)).subarray(-20))}`) as Hex;
/** r ‖ s ‖ v (v 27 or 28, low s) over a 32-byte digest. */
function signEvmDigest(d: Uint8Array, digest: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(digest, d, { lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return out;
}

/** A throwaway secp256k1 key derived from a label (sha-256 of a fixed prefix and the label): test only. */
export const testKey = (label: string): Uint8Array => sha256(new TextEncoder().encode(`hana-id api evm-sponsor test key: ${label}`));

export interface TestUser {
  key: Uint8Array;
  address: Hex;
}
export const testUser = (label = uid()): TestUser => {
  const key = testKey(label);
  return { key, address: evmSignerAddress(key) };
};

export const LOCAL_CHAIN = 31337;
export const OP_CHAIN = 84532;
/** Core's pinned delegate on the local chain (the deterministic deployment). */
export const DELEGATE: Hex = SPONSOR_DELEGATES[LOCAL_CHAIN]!.address;
/** A made-up delegate for the OP Stack chain, pinned only by the fixture table the OP tests install. */
export const OP_DELEGATE = checksumEvmAddress(`0x${'d3f1'.repeat(10)}`) as Hex;
export const RELAYER: Hex = testUser('relayer').address;
/** The CheckIn demo's CREATE2 address (contracts/evm-delegate/artifacts/CheckIn.json). */
export const CHECK_IN: Hex = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e';
export const CHECK_IN_DATA: Hex = '0x183ff085';
/** A second allowlisted target, selector-matched (ERC-20 `transfer(address,uint256)`), data at most 68 bytes. */
export const TOKEN = checksumEvmAddress(`0x${'7e57'.repeat(10)}`) as Hex;
export const TRANSFER_SELECTOR = '0xa9059cbb';
export const transferData = (to: Hex, amount: bigint): Hex => `${TRANSFER_SELECTOR}${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as Hex;

export type ChainFields = Record<string, unknown>;

/** The chain's block with D836's numbers; `fields` override. */
export const chainBlock = (chainId: number, fields: ChainFields = {}): ChainFields => ({
  rpc: chainId === LOCAL_CHAIN ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org',
  delegate: chainId === LOCAL_CHAIN ? DELEGATE : OP_DELEGATE,
  opStack: chainId === OP_CHAIN,
  maxGasPerTx: 300_000,
  maxFeePerGasGwei: 1,
  maxPriorityFeePerGasGwei: 0.01,
  maxCallsPerBatch: 4,
  deadlineMaxS: 600,
  minGas: 100_000,
  dailyBudgetEth: 0.02,
  appDailyBudgetEth: 0.01,
  lowBalanceEth: 0.05,
  perUserPerDay: 30,
  perAppPerDay: 2000,
  sendsPerDay: 5000,
  sendsPerMinute: 60,
  requireKnownAccount: true,
  ...fields,
});

const targets = () => [
  { address: CHECK_IN, selectors: ['0x183ff085'], exactCalldata: ['0x183ff085'], maxDataBytes: 4, label: 'Check-in' },
  { address: TOKEN, selectors: [TRANSFER_SELECTOR], maxDataBytes: 68, label: 'Token' },
];

/** EVM_SPONSOR for these apps on one chain. */
export function sponsorVar(appIds: string[], chainId = LOCAL_CHAIN, fields: ChainFields = {}): string {
  return JSON.stringify({ relayerAddress: RELAYER, chains: { [chainId]: chainBlock(chainId, fields) }, apps: Object.fromEntries(appIds.map((id) => [id, { [chainId]: targets() }])) });
}

// ---- the fakes ----

export interface FakeChain extends SponsorChainPort {
  calls: { method: string; args: unknown }[];
  codes: Map<string, Hex>;
  /** The delegate nonce per account (lowercase). */
  executeNonce: Map<string, bigint>;
  pending: Map<string, bigint>;
  baseFeeWei: bigint;
  balanceWei: bigint;
  l1BoundWei: bigint | 'fail';
  /** The oracle's getOperatorFee answer: a bound, `revert` (a chain before Isthmus: no operator fee), or `fail`. */
  operatorBoundWei: bigint | 'revert' | 'fail';
  /** The simulation's answer (default: success, `0x`); throw `revert(data)` for a revert. */
  simulate: (req: SponsorCallRequest, opts: { stateOverride?: SponsorStateOverride }) => Hex;
  receipts: Map<string, SponsorReceipt>;
  /** Every read throws (an RPC outage). */
  down: boolean;
}

export function fakeChain(): FakeChain {
  const f: FakeChain = {
    calls: [],
    codes: new Map(),
    executeNonce: new Map(),
    pending: new Map(),
    baseFeeWei: 100_000_000n,
    balanceWei: 10n ** 18n,
    l1BoundWei: 0n,
    operatorBoundWei: 'revert',
    simulate: () => '0x',
    receipts: new Map(),
    down: false,
    async code(address) {
      f.calls.push({ method: 'code', args: address });
      if (f.down) throw new Error('down');
      return f.codes.get(address.toLowerCase()) ?? '0x';
    },
    async transactionCount(address, tag) {
      f.calls.push({ method: 'transactionCount', args: [address, tag] });
      if (f.down) throw new Error('down');
      return Number(f.pending.get(address.toLowerCase()) ?? 0n);
    },
    async balance(address) {
      f.calls.push({ method: 'balance', args: address });
      if (f.down) throw new Error('down');
      return f.balanceWei;
    },
    async latestBlock() {
      f.calls.push({ method: 'latestBlock', args: null });
      if (f.down) throw new Error('down');
      return { number: 1n, timestamp: 1n, baseFeePerGas: f.baseFeeWei };
    },
    async call(req, opts = {}) {
      f.calls.push({ method: 'call', args: { ...req, ...(opts.stateOverride ? { stateOverride: opts.stateOverride } : {}) } });
      if (f.down) throw new Error('down');
      if (req.data === '0xaffed0e0') return `0x${(f.executeNonce.get(req.to.toLowerCase()) ?? 0n).toString(16).padStart(64, '0')}`;
      if (req.to.toLowerCase() === '0x420000000000000000000000000000000000000f' && req.data.startsWith('0x275aedd2')) {
        if (f.operatorBoundWei === 'revert') throw revert(null);
        if (f.operatorBoundWei === 'fail') throw new Error('down');
        return `0x${f.operatorBoundWei.toString(16).padStart(64, '0')}`;
      }
      if (req.to.toLowerCase() === '0x420000000000000000000000000000000000000f') {
        if (f.l1BoundWei === 'fail') throw revert(null);
        return `0x${f.l1BoundWei.toString(16).padStart(64, '0')}`;
      }
      return f.simulate(req, opts);
    },
    async receipt(hash) {
      f.calls.push({ method: 'receipt', args: hash });
      if (f.down) throw new Error('down');
      return f.receipts.get(hash) ?? null;
    },
  };
  return f;
}

/** A revert as the chain client throws it (`rpc_error`, code 3, its data). */
export const revert = (data: Hex | null): SponsorRpcError => new SponsorRpcError('rpc_error', { rpcCode: 3, nodeMessage: 'execution reverted', data });

/** The chain calls other than receipt polls. */
export const reads = (c: FakeChain): string[] => c.calls.map((x) => x.method);

export interface FakeRelayer {
  sends: EvmRelayerSendRequest[];
  /** What a send does: by default a transaction whose receipt (on `chain`) executed the batch. */
  onSend: (req: EvmRelayerSendRequest) => Promise<{ transactionHash: Hex; relayerNonce: number; raw: Hex; replay: boolean; digest?: Hex }>;
  statusValue: EvmRelayerStatus;
  names: string[];
  /** Extra hashes lookup lists for a digest (a replacement), and the lookups made. */
  replaced: Map<string, Hex[]>;
  lookups: string[];
  /** Replaces the lookup's answer (a relayer that forgot a digest, or one that says what was mined). */
  lookupOverride?: (digest: Hex) => Promise<EvmRelayerLookup | null>;
}

/** The digest the relayer computes for a send (core's, from the Execute input it gets). */
export const digestOf = (req: EvmRelayerSendRequest): Hex => `0x${hex(executeDigest(req.execute))}` as Hex;

/** A raw "transaction" for a send (opaque bytes; the handler checks only that its keccak is the hash). */
export const rawFor = (req: EvmRelayerSendRequest, salt = ''): Hex => `0x02${hex(sha256(new TextEncoder().encode(`${digestOf(req)}${salt}`)))}` as Hex;

export type ReceiptKind = 'executed' | 'reverted' | 'not_executed' | 'none' | 'wrong_log';

export function receiptFor(req: EvmRelayerSendRequest, hash: Hex, kind: ReceiptKind, cost: { gasUsed: bigint; price: bigint; l1Fee?: bigint | null; operatorFee?: bigint | null } = { gasUsed: 60_000n, price: 150_000_000n }): SponsorReceipt {
  const executed = { address: req.execute.account.toLowerCase() as Hex, topics: [EXECUTED_TOPIC, digestOf(req)], data: `0x${'00'.repeat(64)}` as Hex };
  const logs = kind === 'executed' ? [executed] : kind === 'wrong_log' ? [{ ...executed, address: CHECK_IN.toLowerCase() as Hex }] : [];
  return { transactionHash: hash, status: kind === 'reverted' ? 0 : 1, gasUsed: cost.gasUsed, effectiveGasPrice: cost.price, l1Fee: cost.l1Fee ?? null, ...(cost.operatorFee !== undefined ? { operatorFee: cost.operatorFee } : {}), logs };
}

export function fakeRelayer(chain: FakeChain, kind: () => ReceiptKind = () => 'executed', cost?: Parameters<typeof receiptFor>[3]): FakeRelayer & { binding: DurableObjectNamespace } {
  let nonce = 0;
  const r: FakeRelayer = {
    sends: [],
    names: [],
    statusValue: { address: RELAYER, pending: 0, oldestPendingMs: null, nextNonce: 0, blockedReason: null },
    replaced: new Map(),
    lookups: [],
    onSend: async (req) => {
      const raw = rawFor(req);
      const hash = keccakHex(raw);
      const k = kind();
      if (k !== 'none') chain.receipts.set(hash, receiptFor(req, hash, k, cost));
      return { transactionHash: hash, relayerNonce: nonce++, raw, replay: false, digest: digestOf(req) };
    },
  };
  const stub = {
    send: async (req: EvmRelayerSendRequest) => {
      r.sends.push(req);
      return r.onSend(req);
    },
    status: async () => r.statusValue,
    lookup: async (digest: Hex): Promise<EvmRelayerLookup | null> => {
      r.lookups.push(digest);
      if (r.lookupOverride) return r.lookupOverride(digest);
      const req = r.sends.find((x) => digestOf(x) === digest);
      if (!req) return null;
      const first = keccakHex(rawFor(req));
      const hashes = [first, ...(r.replaced.get(digest) ?? [])];
      return { digest, relayerNonce: 0, transactionHash: hashes.at(-1)!, hashes, state: 'pending', reservedWei: req.reservedWei, minedHash: null, outcome: null };
    },
  };
  const binding = {
    idFromName: (name: string) => {
      r.names.push(name);
      return name;
    },
    get: () => stub,
  } as unknown as DurableObjectNamespace;
  return Object.assign(r, { binding });
}

// ---- requests ----

export interface SignedSend {
  body: Record<string, unknown>;
  digest: Hex;
  input: ExecuteInput;
}

export interface SendOptions {
  chainId?: number;
  delegate?: Hex;
  calls?: { to: Hex; value?: string; data: Hex }[];
  executeNonce?: bigint;
  deadline?: bigint;
  relayer?: Hex;
  minGas?: bigint;
  /** Sign the batch with another key. */
  signWith?: Uint8Array;
  /** Attach an authorization for this account nonce (signed by `authWith`, for `authAddress`, `authChainId`). */
  authNonce?: bigint;
  authWith?: Uint8Array;
  authAddress?: Hex;
  authChainId?: number;
}

const nowS = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** A send body for the user's batch, signed by the user's key (or `signWith`). */
export function signedSend(user: TestUser, o: SendOptions = {}): SignedSend {
  const chainId = o.chainId ?? LOCAL_CHAIN;
  const delegate = o.delegate ?? (chainId === LOCAL_CHAIN ? DELEGATE : OP_DELEGATE);
  const calls = o.calls ?? [{ to: CHECK_IN, data: CHECK_IN_DATA }];
  const input: ExecuteInput = {
    chainId,
    account: user.address,
    implementation: delegate,
    calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value ?? '0'), data: c.data })),
    nonce: o.executeNonce ?? 0n,
    deadline: o.deadline ?? nowS() + 300n,
    relayer: o.relayer ?? RELAYER,
    minGas: o.minGas ?? 100_000n,
  };
  const digestBytes = executeDigest(input);
  const signature = `0x${hex(signEvmDigest(o.signWith ?? user.key, digestBytes))}`;
  const body: Record<string, unknown> = {
    chainId,
    account: user.address,
    calls: calls.map((c) => ({ to: c.to, value: c.value ?? '0', data: c.data })),
    executeNonce: input.nonce.toString(),
    deadline: input.deadline.toString(),
    relayer: input.relayer,
    minGas: input.minGas.toString(),
    signature,
  };
  if (o.authNonce !== undefined) {
    const a = { chainId: o.authChainId ?? chainId, address: o.authAddress ?? delegate, nonce: o.authNonce };
    const sig = signEvmDigest(o.authWith ?? user.key, authorizationHash(a));
    body.authorization = { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: sig[64] === 27 ? 0 : 1, r: `0x${hex(sig.subarray(0, 32))}`, s: `0x${hex(sig.subarray(32, 64))}` };
  }
  return { body, digest: `0x${hex(digestBytes)}`, input };
}

/** The bindings a sponsorship request runs with: a local env, the var, the relayer binding and a key secret's presence. */
export const sponsorEnv = (sponsor: string, relayer: { binding: DurableObjectNamespace } | null, extra: Partial<typeof env> & { EVM_RELAYER?: undefined } = {}): Partial<typeof env> =>
  ({
    ENV_NAME: 'local-test',
    EVM_SPONSOR: sponsor,
    EVM_RELAY_KEYS: JSON.stringify([`0x${hex(testKey('relayer'))}`]),
    // The relayer branch types EVM_RELAYER on Env; until then it is an untyped binding here.
    ...(relayer ? { EVM_RELAYER: relayer.binding } : {}),
    ...extra,
  }) as Partial<typeof env>;

export const sponsorCall = (path: string, app: SeededApp, bindings: Partial<typeof env>, o: { body?: unknown; headers?: Record<string, string>; method?: string } = {}) =>
  call(path, { headers: o.headers ?? vaultHeaders(app), body: o.body, method: o.method, env: bindings });

/** Records the account as the user's EVM wallet in the app's scope (the directory's rows); returns the internal id. */
export async function rememberAccount(scope: string, address: Hex, userId = `hu_${uid().padEnd(26, '0').slice(0, 26)}`): Promise<string> {
  const now = Date.now();
  const sub = `u1_${uid().padEnd(22, '0').slice(0, 22)}`;
  await env.DB.prepare('INSERT OR IGNORE INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(userId, sub, 'ABCDEFGH', scope, now).run();
  await env.DB.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'evm', ?2, 0, ?3, ?3)").bind(userId, address, now).run();
  return userId;
}
