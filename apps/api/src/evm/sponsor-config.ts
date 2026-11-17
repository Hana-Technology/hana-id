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
  labelChars: 64,
  maxGasPerTx: { min: 50_000, max: 2_000_000 },
  minGas: { min: 10_000, max: 1_000_000 },
  maxFeePerGasGwei: 100,
  maxCallsPerBatch: 8,
  deadlineMaxS: { min: 60, max: 3600 },
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
  label: string;
}

export interface EvmSponsorConfig {
  /** The relayer's EOA, EIP-55: the `relayer` every signed batch names and the only sender. */
  relayerAddress: string;
  chains: ReadonlyMap<number, EvmSponsorChainConfig>;
  /** The allowlist: app id → chain ID → targets. */
  apps: ReadonlyMap<string, ReadonlyMap<number, readonly EvmSponsorTarget[]>>;
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
  apps: Record<string, Record<string, { address: string; selectors: string[]; label: string }[]>>;
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
    apps[appId] = Object.fromEntries(Object.entries(byChain).map(([id, targets]) => [id, targets.map((t) => ({ address: t.address, selectors: [...t.selectors], label: t.label }))]));
  }
  return JSON.stringify({ relayerAddress: sponsor.relayerAddress, chains, apps });
}

/** Thrown inside the parse; becomes `{ status: 'unconfigured', reason: 'invalid', problem }`. */
class Invalid extends Error {}
const fail = (problem: string): never => {
  throw new Invalid(problem);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], what: string): void {
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

/** Loopback hosts as the URL parser writes them: localhost and its subdomains, 127.0.0.0/8, [::1]. */
const LOOPBACK_HOST_RE = /^(([a-z0-9-]+\.)*localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/u;

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(`${what} is not an integer in ${min}..${max}`);
  return v as number;
}

/** A decimal amount with at most 9 places → integer units of 10^-9 (gwei of ETH, wei of gwei). */
function nano(v: unknown, max: number, zeroOk: boolean, what: string): bigint {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || (!zeroOk && v === 0)) fail(`${what} is out of bounds`);
  const n = v as number;
  const units = Math.round(n * 1e9);
  if (Math.abs(n * 1e9 - units) >= 1e-6) fail(`${what} has more than 9 decimal places`);
  if (!zeroOk && units < 1) fail(`${what} is below the smallest unit`);
  return BigInt(units);
}

const GWEI = 10n ** 9n;

function rpcUrl(v: unknown, localEnv: boolean, what: string): string {
  if (typeof v !== 'string') return fail(`${what} is not a URL`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return fail(`${what} is not a URL`);
  }
  if (url.username || url.password) fail(`${what} carries credentials`);
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && localEnv && LOOPBACK_HOST_RE.test(url.hostname));
  if (!ok) fail(`${what} must be https (http only for a loopback host in local* envs)`);
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
  const requireKnownAccount = v.requireKnownAccount ?? true;
  if (typeof requireKnownAccount !== 'boolean') fail(`${what}.requireKnownAccount is not a boolean`);
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
  onlyKeys(v, ['address', 'selectors', 'label'], what);
  const addr = address(v.address, `${what}.address`);
  const selectors = v.selectors;
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > EVM_SPONSOR_BOUNDS.selectorsPerTarget) return fail(`${what}.selectors has 1 to ${EVM_SPONSOR_BOUNDS.selectorsPerTarget} selectors`);
  if (!selectors.every((s) => typeof s === 'string' && /^0x[0-9a-f]{8}$/u.test(s))) fail(`${what}.selectors are 4-byte lowercase hex`);
  if (new Set(selectors).size !== selectors.length) fail(`${what}.selectors lists one twice`);
  const label = v.label;
  if (typeof label !== 'string' || label.length < 1 || label.length > EVM_SPONSOR_BOUNDS.labelChars || label.trim() !== label || !/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(label)) fail(`${what}.label is not a plain label`);
  return { address: addr, selectors: Object.freeze([...(selectors as string[])]), label: label as string };
}

/**
 * Parses EVM_SPONSOR. `unconfigured` for anything absent, malformed, out of bounds or inconsistent (as the manifest
 * schema refuses it), and off testnet. `where`: the Worker's NETWORK and ENV_NAME vars (local dev chains and loopback
 * RPCs only in a `local*` env).
 */
export function parseEvmSponsorConfig(raw: string | undefined, where: { network: string | undefined; envName: string }): EvmSponsorSetting {
  if (!raw) return { status: 'unconfigured', reason: 'absent', problem: null };
  try {
    return { status: 'configured', config: parseStrict(raw, where) };
  } catch (e) {
    if (e instanceof Invalid) return { status: 'unconfigured', reason: 'invalid', problem: e.message };
    return { status: 'unconfigured', reason: 'invalid', problem: 'EVM_SPONSOR could not be read' };
  }
}

function parseStrict(raw: string, where: { network: string | undefined; envName: string }): EvmSponsorConfig {
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
  const chainEntries = Object.entries(v.chains);
  if (chainEntries.length < 1 || chainEntries.length > EVM_SPONSOR_BOUNDS.chains) fail(`chains has 1 to ${EVM_SPONSOR_BOUNDS.chains} chains`);
  const chains = new Map<number, EvmSponsorChainConfig>();
  for (const [k, c] of chainEntries) {
    const id = chainKey(k, 'chains');
    const chain = parseChain(id, c, localEnv);
    if (chain.delegate.toLowerCase() === relayerAddress.toLowerCase()) fail(`chains.${id}.delegate is relayerAddress`);
    chains.set(id, Object.freeze(chain));
  }
  const delegates = new Set([...chains.values()].map((c) => c.delegate.toLowerCase()));
  if (!isObject(v.apps)) return fail('apps is not an object');
  const appEntries = Object.entries(v.apps);
  if (appEntries.length > EVM_SPONSOR_BOUNDS.apps) fail(`apps lists more than ${EVM_SPONSOR_BOUNDS.apps} apps`);
  const apps = new Map<string, ReadonlyMap<number, readonly EvmSponsorTarget[]>>();
  for (const [appId, byChain] of appEntries) {
    if (!/^app_[A-Za-z0-9]{1,64}$/u.test(appId)) fail('apps has a key that is not an app id');
    if (!isObject(byChain) || Object.keys(byChain).length === 0) fail(`apps.${appId} names no chain`);
    const perChain = new Map<number, readonly EvmSponsorTarget[]>();
    let total = 0;
    for (const [k, list] of Object.entries(byChain as Record<string, unknown>)) {
      const id = chainKey(k, `apps.${appId}`);
      if (!chains.has(id)) fail(`apps.${appId}.${id} is not a configured chain`);
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
      perChain.set(id, Object.freeze(targets.map((t) => Object.freeze(t))));
    }
    apps.set(appId, perChain);
  }
  return Object.freeze({ relayerAddress, chains, apps });
}

/**
 * The allowlisted target an app's call matches (D835), or null: `to` (any case) is one of the app's targets on the
 * chain, and `data` (0x hex) starts with one of its selectors. Value must be 0: the caller checks it (core's subject
 * decoder refuses any other value).
 */
export function sponsoredTarget(config: EvmSponsorConfig, appId: string, chainId: number, to: string, data: string): EvmSponsorTarget | null {
  const targets = config.apps.get(appId)?.get(chainId);
  if (!targets || !/^0x[0-9a-fA-F]{8}/u.test(data)) return null;
  const sel = data.slice(0, 10).toLowerCase();
  const target = targets.find((t) => t.address.toLowerCase() === to.toLowerCase());
  return target && target.selectors.includes(sel) ? target : null;
}
