// EVM gas sponsorship's configuration (D834–D836): the Worker var EVM_SPONSOR, a JSON object gen-wrangler writes from
// the manifest's `evm.sponsor`, and the secret EVM_RELAY_KEYS (the relayer EOA's key). Pure: the gen script and the
// tests read the same parser. The manifest schema (packages/env/src/evm-sponsor.ts) checks the block at gen; this
// checks it again at run time with the same bounds, and anything absent, unreadable, out of bounds or off testnet
// turns sponsorship off (fail closed): the result is `unconfigured`, never a partial config. Self-contained (no
// Worker-only types, no @hana-id/core root import), so gen-wrangler runs the same parse in Node.
import { keccak_256 } from '@noble/hashes/sha3';

/** Hard bounds whatever the var says: the manifest schema's EVM_SPONSOR_BOUNDS (a test checks they agree). */
export const EVM_SPONSOR_BOUNDS = Object.freeze({
  chains: 4,
  apps: 8,
  targetsPerApp: 8,
  selectorsPerTarget: 8,
  /** Exact calldata entries per target, and each one's size in bytes. */
  exactCalldataPerTarget: 8,
  exactCalldataBytes: 2048,
  /** A target's `maxDataBytes`: every call's data is at most this long. */
  maxDataBytes: { min: 4, max: 8192 },
  labelChars: 64,
  maxGasPerTx: { min: 50_000, max: 2_000_000 },
  minGas: { min: 10_000, max: 1_000_000 },
  maxFeePerGasGwei: 100,
  maxCallsPerBatch: 8,
  deadlineMaxS: { min: 60, max: 300 },
  dailyBudgetEth: 1,
  lowBalanceEth: 10,
  perUserPerDay: 10_000,
  perAppPerDay: 1_000_000,
  sendsPerDay: 10_000_000,
  sendsPerMinute: 100_000,
});

/**
 * The EVM test chains sponsorship may name: the IDs of @hana-id/core's TEST_EVM_CHAINS, as the schema's
 * SPONSOR_TEST_EVM_CHAIN_IDS (tests check all three agree).
 */
export const SPONSOR_TEST_EVM_CHAIN_IDS: readonly number[] = Object.freeze([11155111, 17000, 84532, 421614, 11155420, 57054, 14601, 560048, 97, 80002, 43113, 31337, 1337]);
/** Local dev chains (anvil, Hardhat, Ganache, geth --dev): only in `local*` envs (as the schema's LOCAL_EVM_CHAIN_IDS). */
export const LOCAL_EVM_CHAIN_IDS: readonly number[] = Object.freeze([31337, 1337]);
/** OP Stack test chains, where `opStack` must be true (and only there): as the schema's OP_STACK_TEST_CHAIN_IDS. */
export const OP_STACK_TEST_CHAIN_IDS: readonly number[] = Object.freeze([84532, 11155420]);

export interface EvmSponsorChainConfig {
  chainId: number;
  rpc: string;
  rpcFallback: string | null;
  /** The pinned delegate's address, EIP-55. */
  delegate: string;
  opStack: boolean;
  maxGasPerTx: bigint;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  maxCallsPerBatch: number;
  deadlineMaxS: number;
  minGas: bigint;
  dailyBudgetWei: bigint;
  appDailyBudgetWei: bigint;
  lowBalanceWei: bigint;
  perUserPerDay: number;
  perAppPerDay: number;
  sendsPerDay: number;
  sendsPerMinute: number;
  requireKnownAccount: boolean;
}

/** A contract an app's users may call with sponsored gas, value 0 (D835). */
export interface EvmSponsorTarget {
  /** EIP-55. */
  address: string;
  /** 4-byte selectors, lowercase `0x` + 8 hex. */
  selectors: readonly string[];
  /** Calldata allowed exactly (lowercase hex); a selector with an entry here matches only these. Empty: none. */
  exactCalldata: readonly string[];
  /** The longest call data allowed, bytes. */
  maxDataBytes: number;
  label: string;
}

/**
 * The parsed config, immutable all the way down: plain frozen objects with no prototype (keys are decimal chain IDs and
 * app ids) and frozen arrays. Look a chain up with `sponsorChain`, a call with `sponsoredTarget`.
 */
export interface EvmSponsorConfig {
  /** The relayer's EOA, EIP-55: the `relayer` every signed batch names and the only sender. */
  readonly relayerAddress: string;
  readonly chains: Readonly<Record<string, Readonly<EvmSponsorChainConfig>>>;
  /** The allowlist: app id → decimal chain ID → targets. */
  readonly apps: Readonly<Record<string, Readonly<Record<string, readonly Readonly<EvmSponsorTarget>[]>>>>;
}

/**
 * The pinned, reviewed delegate table: @hana-id/core/evm-sponsor's SPONSOR_DELEGATES, which the handlers pass in
 * (`address` and `placeholder` are read; a placeholder entry counts only in `local*` envs).
 */
export type PinnedSponsorDelegates = Readonly<Record<number, { readonly address: string; readonly placeholder?: boolean }>>;

/**
 * Where the parse runs: the Worker's NETWORK and ENV_NAME vars, and the pinned delegate table every chain's `delegate`
 * must match. `pinnedDelegates` undefined (no table available) makes a present block `invalid`: fail closed.
 */
export interface EvmSponsorWhere {
  network: string | undefined;
  envName: string;
  pinnedDelegates: PinnedSponsorDelegates | undefined;
}

/**
 * The parse's outcome. `unconfigured` turns every sponsored route off: `absent` (no var: the env has no `evm.sponsor`)
 * or `invalid` (a var the Worker refuses; `problem` names what, never a secret: the var holds none).
 */
export type EvmSponsorSetting = { status: 'configured'; config: EvmSponsorConfig } | { status: 'unconfigured'; reason: 'absent' | 'invalid'; problem: string | null };

/** The manifest-side shape (what gen-wrangler serialises): packages/env's `EvmSponsor`. */
export interface EvmSponsorManifest {
  relayerAddress: string;
  chains: Record<string, EvmSponsorChainManifest>;
  apps: Record<string, Record<string, { address: string; selectors: string[]; exactCalldata?: string[] | undefined; maxDataBytes: number; label: string }[]>>;
}

export interface EvmSponsorChainManifest {
  rpc: string;
  rpcFallback?: string | undefined;
  delegate: string;
  opStack: boolean;
  maxGasPerTx: number;
  maxFeePerGasGwei: number;
  maxPriorityFeePerGasGwei: number;
  maxCallsPerBatch: number;
  deadlineMaxS: number;
  minGas: number;
  dailyBudgetEth: number;
  appDailyBudgetEth: number;
  lowBalanceEth: number;
  perUserPerDay: number;
  perAppPerDay: number;
  sendsPerDay: number;
  sendsPerMinute: number;
  requireKnownAccount?: boolean | undefined;
}

/** The chain fields in the order the var lists them; the optional ones only when set. */
const CHAIN_FIELDS = [
  'rpc',
  'rpcFallback',
  'delegate',
  'opStack',
  'maxGasPerTx',
  'maxFeePerGasGwei',
  'maxPriorityFeePerGasGwei',
  'maxCallsPerBatch',
  'deadlineMaxS',
  'minGas',
  'dailyBudgetEth',
  'appDailyBudgetEth',
  'lowBalanceEth',
  'perUserPerDay',
  'perAppPerDay',
  'sendsPerDay',
  'sendsPerMinute',
  'requireKnownAccount',
] as const;
const OPTIONAL_CHAIN_FIELDS = new Set<string>(['rpcFallback', 'requireKnownAccount']);

/** The EVM_SPONSOR var for a manifest's `evm.sponsor` (gen-wrangler): its fields in a fixed order, nothing else. */
export function evmSponsorVar(sponsor: EvmSponsorManifest): string {
  const chains: Record<string, Record<string, unknown>> = {};
  for (const [id, c] of Object.entries(sponsor.chains)) {
    const out: Record<string, unknown> = {};
    for (const k of CHAIN_FIELDS) if (c[k] !== undefined) out[k] = c[k];
    chains[id] = out;
  }
  const apps: Record<string, Record<string, unknown[]>> = {};
  for (const [appId, byChain] of Object.entries(sponsor.apps)) {
    apps[appId] = Object.fromEntries(Object.entries(byChain).map(([id, targets]) => [id, targets.map((t) => ({ address: t.address, selectors: [...t.selectors], ...(t.exactCalldata !== undefined ? { exactCalldata: [...t.exactCalldata] } : {}), maxDataBytes: t.maxDataBytes, label: t.label }))]));
  }
  return JSON.stringify({ relayerAddress: sponsor.relayerAddress, chains, apps });
}

// ---- Shared with the other package's copy, word for word (a test in apps/api/scripts/test/gen-evm-sponsor.test.ts
// checks both give the same answers): exact decimal amounts, loopback hosts, RPC URL rules.

/**
 * `v` in units of 10^-`places` (gwei of ETH, wei of gwei) by exact decimal arithmetic on its shortest round-trip
 * spelling (`String(v)`, exponent forms included), or null when it is not a finite number ≥ 0 or has more decimals.
 */
export function sponsorDecimalUnits(v: unknown, places: number): bigint | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(v));
  if (!m) return null;
  const fraction = m[2] ?? '';
  const exponent = Number(m[3] ?? '0') - fraction.length + places;
  const digits = BigInt(`${m[1]!}${fraction}`);
  if (exponent >= 0) return digits * 10n ** BigInt(exponent);
  const divisor = 10n ** BigInt(-exponent);
  return digits % divisor === 0n ? digits / divisor : null;
}

/**
 * Hostname is loopback, as the URL parser writes it: `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]` and IPv4-mapped
 * 127.0.0.0/8 (`[::ffff:7fxx:xxxx]`), each also with a trailing dot.
 */
export function isSponsorLoopbackHost(hostname: string): boolean {
  const h = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/u.test(h) || h === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(h);
}

const NO_KEYS_IN_URLS = 'no API keys in manifest URLs: a keyed RPC goes in a secret';

/**
 * Why `value` can't be a sponsorship RPC URL, or null: an https URL of a DNS name (with a dot, no trailing dot, not an
 * IP literal, not a link-local `.local` name) with no credentials, path, query or fragment. A loopback host only in a
 * `local*` env (`localEnv`), where http is allowed for it.
 */
export function sponsorRpcUrlProblem(value: string, localEnv: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.username || url.password) return `must not carry credentials (${NO_KEYS_IN_URLS})`;
  if (url.search || url.hash || value.includes('?') || value.includes('#')) return `must have no query or fragment (${NO_KEYS_IN_URLS})`;
  if (url.pathname !== '/') return `must have no path (${NO_KEYS_IN_URLS})`;
  if (isSponsorLoopbackHost(url.hostname)) {
    if (!localEnv) return 'must not be a loopback host outside local* envs';
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'must be an http or https URL';
  }
  if (url.protocol !== 'https:') return 'must be an https URL (http only for a loopback host in local* envs)';
  const host = url.hostname;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return 'must be a DNS name, not an IP address';
  if (host.endsWith('.') || !host.includes('.')) return 'must be a DNS name with a dot and no trailing dot';
  if (host.endsWith('.local')) return 'must not be a link-local (.local) name';
  return null;
}

/** Keys no block may hold anywhere: JSON.parse makes them own properties, which object handling could drop or misread. */
export const FORBIDDEN_SPONSOR_KEYS: readonly string[] = Object.freeze(['__proto__', 'constructor', 'prototype']);
/**
 * Why a target's `exactCalldata` can't be used, or null (absent is fine: selector matching within `maxDataBytes`).
 * 1 to 8 distinct entries, each `0x` + lowercase hex, whole bytes, 4 to 2048 bytes, starting with one of the target's
 * `selectors` and no longer than its `maxDataBytes` (a number the caller has checked).
 */
export function sponsorCalldataProblem(selectors: readonly string[], exactCalldata: unknown, maxDataBytes: number): string | null {
  if (exactCalldata === undefined) return null;
  if (!Array.isArray(exactCalldata) || exactCalldata.length < 1 || exactCalldata.length > 8) return 'exactCalldata lists 1 to 8 entries';
  for (const entry of exactCalldata as unknown[]) {
    if (typeof entry !== 'string' || !/^0x(?:[0-9a-f]{2}){4,2048}$/u.test(entry)) return 'exactCalldata entries are 0x + lowercase hex, whole bytes, 4 to 2048 bytes';
  }
  const entries = exactCalldata as string[];
  if (new Set(entries).size !== entries.length) return 'exactCalldata lists an entry twice';
  if (entries.some((e) => !selectors.includes(e.slice(0, 10)))) return "exactCalldata: an entry's first 4 bytes are not one of selectors";
  if (entries.some((e) => (e.length - 2) / 2 > maxDataBytes)) return 'exactCalldata: an entry is longer than maxDataBytes';
  return null;
}
/** The most calldata a batch's calls may carry, bytes: the relayer's own limit is 32 KiB, the rest is their encoding. */
export const SPONSOR_BATCH_DATA_MAX_BYTES = 30 * 1024;

/**
 * Why a chain's tip cap leaves the relayer no starting tip, or null. A send must start at or below the cap after two
 * × 1.125 bumps (the relayer's `maxStartingFees`), and that starting tip must be at least 1 wei: a cap of 3 wei or more.
 */
export function sponsorTipCapProblem(tipCapWei: bigint): string | null {
  const bump = (x: bigint): bigint => (x * 9n + 7n) / 8n;
  return bump(bump(1n)) <= tipCapWei ? null : 'is too small: after the two fee bumps the relayer must leave room for, the starting tip would be below 1 wei (use at least 0.000000003)';
}

/** Why a chain's batches could pass the relayer's calldata limit, or null: maxCallsPerBatch × the largest maxDataBytes. */
export function sponsorBatchSizeProblem(maxCallsPerBatch: number, largestMaxDataBytes: number): string | null {
  const n = maxCallsPerBatch * largestMaxDataBytes;
  return n <= SPONSOR_BATCH_DATA_MAX_BYTES ? null : `× the largest target maxDataBytes is ${n} bytes; the relayer sends at most ${SPONSOR_BATCH_DATA_MAX_BYTES} bytes of calls in one batch (30 KiB)`;
}

// ---- End of the shared part.

/** Thrown inside the parse; becomes `{ status: 'unconfigured', reason: 'invalid', problem }`. */
class Invalid extends Error {}
const fail = (problem: string): never => {
  throw new Invalid(problem);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function noForbiddenKeys(v: Record<string, unknown>, what: string): void {
  for (const k of Object.keys(v)) if (FORBIDDEN_SPONSOR_KEYS.includes(k)) fail(`${what} has a forbidden key ${k}`);
}

function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], what: string): void {
  noForbiddenKeys(v, what);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${what} has an unknown field ${k}`);
}

/** EIP-55 checksummed form of a `0x` + 40 hex address (any case). */
export function checksumEvmAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = Array.from(keccak_256(new TextEncoder().encode(lower)), (b) => b.toString(16).padStart(2, '0')).join('');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

/** An EIP-55 checksummed, non-zero address. */
function address(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(v)) return fail(`${what} is not an address`);
  if (checksumEvmAddress(v) !== v) fail(`${what} is not EIP-55 checksummed`);
  if (/^0x0{40}$/u.test(v)) fail(`${what} is the zero address`);
  return v;
}

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(`${what} is not an integer in ${min}..${max}`);
  return v as number;
}

/** A decimal amount with at most 9 places → integer units of 10^-9 (gwei of ETH, wei of gwei), exactly. */
function nano(v: unknown, max: number, zeroOk: boolean, what: string): bigint {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || (!zeroOk && v === 0)) fail(`${what} is out of bounds`);
  const units = sponsorDecimalUnits(v, 9);
  if (units === null) return fail(`${what} has more than 9 decimal places`);
  if (!zeroOk && units < 1n) fail(`${what} is below the smallest unit`);
  return units;
}

const GWEI = 10n ** 9n;

function rpcUrl(v: unknown, localEnv: boolean, what: string): string {
  if (typeof v !== 'string') return fail(`${what} is not a URL`);
  const problem = sponsorRpcUrlProblem(v, localEnv);
  if (problem) fail(`${what} ${problem}`);
  return v;
}

const chainKey = (k: string, what: string): number => {
  if (!/^[1-9][0-9]{0,15}$/u.test(k) || !Number.isSafeInteger(Number(k))) fail(`${what} has a key that is not a chain ID`);
  return Number(k);
};

function parseChain(id: number, v: unknown, localEnv: boolean): EvmSponsorChainConfig {
  const what = `chains.${id}`;
  if (!isObject(v)) return fail(`${what} is not an object`);
  onlyKeys(v, CHAIN_FIELDS, what);
  for (const k of CHAIN_FIELDS) if (!OPTIONAL_CHAIN_FIELDS.has(k) && v[k] === undefined) fail(`${what}.${k} is missing`);
  if (!SPONSOR_TEST_EVM_CHAIN_IDS.includes(id)) fail(`${what}: not a known EVM test chain`);
  if (LOCAL_EVM_CHAIN_IDS.includes(id) && !localEnv) fail(`${what}: a local dev chain outside a local* env`);
  if (v.opStack !== OP_STACK_TEST_CHAIN_IDS.includes(id)) fail(`${what}.opStack is wrong for the chain`);
  const rpc = rpcUrl(v.rpc, localEnv, `${what}.rpc`);
  // D855: required outside local* envs (the vault reads the account from two providers before it signs the setup).
  if (v.rpcFallback === undefined && !localEnv) fail(`${what}.rpcFallback is required outside local* envs`);
  const rpcFallback = v.rpcFallback === undefined ? null : rpcUrl(v.rpcFallback, localEnv, `${what}.rpcFallback`);
  if (rpcFallback === rpc) fail(`${what}.rpcFallback is rpc`);
  const delegate = address(v.delegate, `${what}.delegate`);
  const b = EVM_SPONSOR_BOUNDS;
  const maxGasPerTx = int(v.maxGasPerTx, b.maxGasPerTx.min, b.maxGasPerTx.max, `${what}.maxGasPerTx`);
  const minGas = int(v.minGas, b.minGas.min, b.minGas.max, `${what}.minGas`);
  if (minGas >= maxGasPerTx) fail(`${what}.minGas is not below maxGasPerTx`);
  const maxFeePerGasWei = nano(v.maxFeePerGasGwei, b.maxFeePerGasGwei, false, `${what}.maxFeePerGasGwei`);
  const maxPriorityFeePerGasWei = nano(v.maxPriorityFeePerGasGwei, b.maxFeePerGasGwei, true, `${what}.maxPriorityFeePerGasGwei`);
  if (maxPriorityFeePerGasWei > maxFeePerGasWei) fail(`${what}.maxPriorityFeePerGasGwei exceeds maxFeePerGasGwei`);
  const tipProblem = sponsorTipCapProblem(maxPriorityFeePerGasWei);
  if (tipProblem) fail(`${what}.maxPriorityFeePerGasGwei ${tipProblem}`);
  const maxCallsPerBatch = int(v.maxCallsPerBatch, 1, b.maxCallsPerBatch, `${what}.maxCallsPerBatch`);
  const deadlineMaxS = int(v.deadlineMaxS, b.deadlineMaxS.min, b.deadlineMaxS.max, `${what}.deadlineMaxS`);
  const dailyBudgetWei = nano(v.dailyBudgetEth, b.dailyBudgetEth, false, `${what}.dailyBudgetEth`) * GWEI;
  const appDailyBudgetWei = nano(v.appDailyBudgetEth, b.dailyBudgetEth, false, `${what}.appDailyBudgetEth`) * GWEI;
  const lowBalanceWei = nano(v.lowBalanceEth, b.lowBalanceEth, false, `${what}.lowBalanceEth`) * GWEI;
  const perUserPerDay = int(v.perUserPerDay, 1, b.perUserPerDay, `${what}.perUserPerDay`);
  const perAppPerDay = int(v.perAppPerDay, 1, b.perAppPerDay, `${what}.perAppPerDay`);
  const sendsPerDay = int(v.sendsPerDay, 1, b.sendsPerDay, `${what}.sendsPerDay`);
  const sendsPerMinute = int(v.sendsPerMinute, 1, b.sendsPerMinute, `${what}.sendsPerMinute`);
  // One app (one leaked publishable key) must never be able to use up the env's day.
  if (appDailyBudgetWei >= dailyBudgetWei) fail(`${what}.appDailyBudgetEth is not below dailyBudgetEth`);
  if (perAppPerDay >= sendsPerDay) fail(`${what}.perAppPerDay is not below sendsPerDay`);
  if (BigInt(maxGasPerTx) * maxFeePerGasWei > appDailyBudgetWei) fail(`${what}: one transaction's worst case exceeds appDailyBudgetEth`);
  // Absent means the default; null is a value, and not a boolean (as the schema refuses it).
  const requireKnownAccount = v.requireKnownAccount === undefined ? true : v.requireKnownAccount;
  if (typeof requireKnownAccount !== 'boolean') fail(`${what}.requireKnownAccount is not a boolean`);
  // Off, anyone holding a publishable key could make the relayer pay from accounts they make up: local* envs only (as
  // the manifest schema rules).
  if (requireKnownAccount === false && !localEnv) fail(`${what}.requireKnownAccount false is only for local* envs`);
  return {
    chainId: id,
    rpc,
    rpcFallback,
    delegate,
    opStack: v.opStack as boolean,
    maxGasPerTx: BigInt(maxGasPerTx),
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
    maxCallsPerBatch,
    deadlineMaxS,
    minGas: BigInt(minGas),
    dailyBudgetWei,
    appDailyBudgetWei,
    lowBalanceWei,
    perUserPerDay,
    perAppPerDay,
    sendsPerDay,
    sendsPerMinute,
    requireKnownAccount: requireKnownAccount as boolean,
  };
}

function parseTarget(v: unknown, what: string): EvmSponsorTarget {
  if (!isObject(v)) return fail(`${what} is not an object`);
  onlyKeys(v, ['address', 'selectors', 'exactCalldata', 'maxDataBytes', 'label'], what);
  const addr = address(v.address, `${what}.address`);
  const selectors = v.selectors;
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > EVM_SPONSOR_BOUNDS.selectorsPerTarget) return fail(`${what}.selectors has 1 to ${EVM_SPONSOR_BOUNDS.selectorsPerTarget} selectors`);
  if (!selectors.every((s) => typeof s === 'string' && /^0x[0-9a-f]{8}$/u.test(s))) fail(`${what}.selectors are 4-byte lowercase hex`);
  if (new Set(selectors).size !== selectors.length) fail(`${what}.selectors lists one twice`);
  const maxDataBytes = int(v.maxDataBytes, EVM_SPONSOR_BOUNDS.maxDataBytes.min, EVM_SPONSOR_BOUNDS.maxDataBytes.max, `${what}.maxDataBytes`);
  const calldataProblem = sponsorCalldataProblem(selectors as string[], v.exactCalldata, maxDataBytes);
  if (calldataProblem) fail(`${what}.${calldataProblem}`);
  const exactCalldata = Object.freeze(v.exactCalldata === undefined ? [] : [...(v.exactCalldata as string[])]);
  const label = v.label;
  if (typeof label !== 'string' || label.length < 1 || label.length > EVM_SPONSOR_BOUNDS.labelChars || label.trim() !== label || !/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(label)) fail(`${what}.label is not a plain label`);
  return Object.freeze({ address: addr, selectors: Object.freeze([...(selectors as string[])]), exactCalldata, maxDataBytes, label: label as string });
}

/**
 * Parses EVM_SPONSOR. `unconfigured` for anything absent, malformed, out of bounds or inconsistent (as the manifest
 * schema refuses it), off testnet, and for a delegate that isn't the pinned one or no pinned table at all. `where`:
 * see EvmSponsorWhere (local dev chains and loopback RPCs only in a `local*` env).
 */
export function parseEvmSponsorConfig(raw: string | undefined, where: EvmSponsorWhere): EvmSponsorSetting {
  if (!raw) return { status: 'unconfigured', reason: 'absent', problem: null };
  try {
    return { status: 'configured', config: parseStrict(raw, where) };
  } catch (e) {
    if (e instanceof Invalid) return { status: 'unconfigured', reason: 'invalid', problem: e.message };
    return { status: 'unconfigured', reason: 'invalid', problem: 'EVM_SPONSOR could not be read' };
  }
}

/** A frozen object with no prototype, from entries (so no key is ever read through Object.prototype). */
function frozenRecord<T>(entries: Iterable<readonly [string, T]>): Readonly<Record<string, T>> {
  const out = Object.create(null) as Record<string, T>;
  for (const [k, v] of entries) out[k] = v;
  return Object.freeze(out);
}

function parseStrict(raw: string, where: EvmSponsorWhere): EvmSponsorConfig {
  if (where.network !== 'testnet') fail('EVM sponsorship is testnet only');
  const localEnv = /^local/u.test(where.envName);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail('EVM_SPONSOR is not JSON');
  }
  if (!isObject(v)) return fail('EVM_SPONSOR is not an object');
  onlyKeys(v, ['relayerAddress', 'chains', 'apps'], 'EVM_SPONSOR');
  const relayerAddress = address(v.relayerAddress, 'relayerAddress');
  if (!isObject(v.chains)) return fail('chains is not an object');
  noForbiddenKeys(v.chains, 'chains');
  const chainEntries = Object.entries(v.chains);
  if (chainEntries.length < 1 || chainEntries.length > EVM_SPONSOR_BOUNDS.chains) fail(`chains has 1 to ${EVM_SPONSOR_BOUNDS.chains} chains`);
  const pinned = where.pinnedDelegates;
  if (!pinned) fail('no pinned delegate table to check the delegates against');
  const chains: [string, Readonly<EvmSponsorChainConfig>][] = [];
  for (const [k, c] of chainEntries) {
    const id = chainKey(k, 'chains');
    const chain = parseChain(id, c, localEnv);
    if (chain.delegate.toLowerCase() === relayerAddress.toLowerCase()) fail(`chains.${id}.delegate is relayerAddress`);
    const entry = Object.hasOwn(pinned!, id) ? pinned![id] : undefined;
    if (!entry) fail(`chains.${id}.delegate: no pinned delegate for the chain`);
    else if (entry.address.toLowerCase() !== chain.delegate.toLowerCase()) fail(`chains.${id}.delegate is not the pinned delegate`);
    else if (entry.placeholder === true && !localEnv) fail(`chains.${id}.delegate is a placeholder entry of the pinned table, only for local* envs`);
    chains.push([String(id), Object.freeze(chain)]);
  }
  const chainIds = new Set(chains.map(([id]) => id));
  const delegates = new Set(chains.map(([, c]) => c.delegate.toLowerCase()));
  if (!isObject(v.apps)) return fail('apps is not an object');
  noForbiddenKeys(v.apps, 'apps');
  const appEntries = Object.entries(v.apps);
  if (appEntries.length > EVM_SPONSOR_BOUNDS.apps) fail(`apps lists more than ${EVM_SPONSOR_BOUNDS.apps} apps`);
  const apps: [string, Readonly<Record<string, readonly Readonly<EvmSponsorTarget>[]>>][] = [];
  for (const [appId, byChain] of appEntries) {
    if (!/^app_[A-Za-z0-9]{1,64}$/u.test(appId)) fail('apps has a key that is not an app id');
    if (!isObject(byChain)) return fail(`apps.${appId} names no chain`);
    noForbiddenKeys(byChain, `apps.${appId}`);
    if (Object.keys(byChain).length === 0) fail(`apps.${appId} names no chain`);
    const perChain: [string, readonly Readonly<EvmSponsorTarget>[]][] = [];
    let total = 0;
    for (const [k, list] of Object.entries(byChain)) {
      const id = chainKey(k, `apps.${appId}`);
      if (!chainIds.has(String(id))) fail(`apps.${appId}.${id} is not a configured chain`);
      if (!Array.isArray(list) || list.length < 1) return fail(`apps.${appId}.${id} lists no target`);
      total += list.length;
      if (total > EVM_SPONSOR_BOUNDS.targetsPerApp) fail(`apps.${appId} has more than ${EVM_SPONSOR_BOUNDS.targetsPerApp} targets`);
      const targets = list.map((t, i) => parseTarget(t, `apps.${appId}.${id}[${i}]`));
      const seen = new Set<string>();
      for (const t of targets) {
        const a = t.address.toLowerCase();
        if (seen.has(a)) fail(`apps.${appId}.${id} lists ${t.address} twice`);
        seen.add(a);
        if (a === relayerAddress.toLowerCase()) fail(`apps.${appId}.${id}: a target is relayerAddress`);
        if (delegates.has(a)) fail(`apps.${appId}.${id}: a target is a delegate`);
      }
      perChain.push([String(id), Object.freeze(targets)]);
    }
    apps.push([appId, frozenRecord(perChain)]);
  }
  for (const [id, chain] of chains) {
    const largest = Math.max(0, ...apps.flatMap(([, byChain]) => (byChain[id] ?? []).map((t) => t.maxDataBytes)));
    const batchProblem = sponsorBatchSizeProblem(chain.maxCallsPerBatch, largest);
    if (batchProblem) fail(`chains.${id}.maxCallsPerBatch ${batchProblem}`);
  }
  return Object.freeze({ relayerAddress, chains: frozenRecord(chains), apps: frozenRecord(apps) });
}

/** The chain's settings, or null when sponsorship doesn't cover it. */
export function sponsorChain(config: EvmSponsorConfig, chainId: number): Readonly<EvmSponsorChainConfig> | null {
  if (!Number.isSafeInteger(chainId) || chainId < 1) return null;
  const key = String(chainId);
  return Object.hasOwn(config.chains, key) ? config.chains[key]! : null;
}

/**
 * The allowlisted target an app's call matches (D835), or null: `to` (any case) is one of the app's targets on the
 * chain, `data` (well-formed `0x` hex, whole bytes, at least 4, at most the target's maxDataBytes) starts with one of its
 * selectors, and, when that selector has exactCalldata entries, `data` is exactly one of them (any case). Value must be 0:
 * the caller checks it (core's subject decoder refuses any other value).
 */
export function sponsoredTarget(config: EvmSponsorConfig, appId: string, chainId: number, to: string, data: string): Readonly<EvmSponsorTarget> | null {
  if (!/^0x(?:[0-9a-fA-F]{2}){4,}$/u.test(data) || !Object.hasOwn(config.apps, appId)) return null;
  const byChain = config.apps[appId]!;
  const key = String(chainId);
  if (!Object.hasOwn(byChain, key)) return null;
  const sel = data.slice(0, 10).toLowerCase();
  const target = byChain[key]!.find((t) => t.address.toLowerCase() === to.toLowerCase());
  if (!target || !target.selectors.includes(sel) || (data.length - 2) / 2 > target.maxDataBytes) return null;
  // A selector with exact entries matches only them: no trailing bytes the sponsor would pay for.
  const exact = target.exactCalldata.filter((e) => e.startsWith(sel));
  return exact.length === 0 || exact.includes(data.toLowerCase()) ? target : null;
}
