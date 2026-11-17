// The manifest's `evm.sponsor` block (D834–D836; envs/README.md "evm.sponsor"): EVM gas sponsorship, where Journear's
// own relayer submits a user's signed batch through the EIP-7702 delegate and pays the network fee within daily
// budgets. Optional: absent, the feature is off everywhere (the API's parser, apps/api/src/evm/sponsor-config.ts, then
// answers unconfigured). Testnet only. The API's parser enforces the same bounds again at run time (fail closed).
import { keccak_256 } from '@noble/hashes/sha3';
import { isLocalEnv, siteOf } from './origins.ts';
import { urlString, z } from './zod.ts';

/**
 * The EVM test chains sponsorship may name, by chain ID: the IDs of `TEST_EVM_CHAINS` in @hana-id/core's networks.ts
 * (a test in apps/api checks the two lists agree; this package doesn't depend on core). A chain also needs a pinned
 * delegate (core's evm-sponsor table) before the generators accept it: Base Sepolia only, for now.
 */
export const SPONSOR_TEST_EVM_CHAIN_IDS: readonly number[] = Object.freeze([11155111, 17000, 84532, 421614, 11155420, 57054, 14601, 560048, 97, 80002, 43113, 31337, 1337]);

/** Local dev chains (anvil, Hardhat, Ganache, geth --dev): only in `local*` envs. */
export const LOCAL_EVM_CHAIN_IDS: readonly number[] = Object.freeze([31337, 1337]);

/**
 * OP Stack test chains (Base Sepolia, OP Sepolia): a transaction there also pays an L1 data fee, which the relayer must
 * count against the budget. `opStack` must be true for exactly these.
 */
export const OP_STACK_TEST_CHAIN_IDS: readonly number[] = Object.freeze([84532, 11155420]);

/** Hard bounds whatever the manifest says; the API's parser has the same ones (a test checks they agree). */
export const EVM_SPONSOR_BOUNDS = Object.freeze({
  chains: 4,
  apps: 8,
  /** Targets per app, across its chains. */
  targetsPerApp: 8,
  selectorsPerTarget: 8,
  labelChars: 64,
  maxGasPerTx: { min: 50_000, max: 2_000_000 },
  minGas: { min: 10_000, max: 1_000_000 },
  /** Gwei, at most 9 decimal places (1 wei). */
  maxFeePerGasGwei: 100,
  maxCallsPerBatch: 8,
  deadlineMaxS: { min: 60, max: 3600 },
  /** ETH, at most 9 decimal places (1 gwei). */
  dailyBudgetEth: 1,
  lowBalanceEth: 10,
  perUserPerDay: 10_000,
  perAppPerDay: 1_000_000,
  sendsPerDay: 10_000_000,
  sendsPerMinute: 100_000,
});

const B = EVM_SPONSOR_BOUNDS;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

/** EIP-55 checksummed form of a `0x` + 40 hex address (any case); throws on anything else. */
export function checksumEvmAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error('Not a 0x + 40 hex address');
  const lower = address.slice(2).toLowerCase();
  const hash = Array.from(keccak_256(new TextEncoder().encode(lower)), (b) => b.toString(16).padStart(2, '0')).join('');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

/** An EVM address as the manifest writes it: `0x` + 40 hex in its EIP-55 checksummed form, never the zero address. */
const evmAddress = z
  .string()
  .regex(ADDRESS_RE, 'An EVM address is 0x + 40 hex characters')
  .refine((v) => !ADDRESS_RE.test(v) || checksumEvmAddress(v) === v, 'An EVM address is written in its EIP-55 checksummed form')
  .refine((v) => !/^0x0{40}$/u.test(v), 'The zero address is not an account');

/** A 4-byte function selector, lowercase hex. */
const selector = z.string().regex(/^0x[0-9a-f]{8}$/u, 'A selector is 0x + 8 lowercase hex characters (4 bytes)');

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
// ---- End of the shared part.

const eth = (max: number) =>
  z
    .number()
    .positive()
    .max(max)
    .refine((v) => (sponsorDecimalUnits(v, 9) ?? 0n) >= 1n, 'An ETH amount has at most 9 decimal places (1 gwei) and is at least 1 gwei');

const gwei = (min: 'positive' | 'nonnegative') =>
  (min === 'positive' ? z.number().positive() : z.number().nonnegative())
    .max(B.maxFeePerGasGwei)
    .refine((v) => {
      const units = sponsorDecimalUnits(v, 9);
      return units !== null && (min === 'nonnegative' || units >= 1n);
    }, 'A gwei amount has at most 9 decimal places (1 wei)');

/** A chain ID as a record key: decimal, no leading zero, a safe integer. */
const chainIdKey = z.string().regex(/^[1-9][0-9]{0,15}$/u, 'A chain ID is a decimal number').refine((v) => Number.isSafeInteger(Number(v)), 'A chain ID is a safe integer');

/** An app id as the console makes them. */
const appIdKey = z.string().regex(/^app_[A-Za-z0-9]{1,64}$/u, 'An app id is app_ + 1-64 letters or digits');

/** One chain's settings: endpoints, the pinned delegate, fee caps and limits (D836). */
export const evmSponsorChainSchema = z
  .object({
    /** The chain's JSON-RPC endpoint the relayer sends through (https; http only for a loopback host in `local*` envs). */
    rpc: urlString(),
    /** A second endpoint from another provider, asked when `rpc` gives no answer. */
    rpcFallback: urlString().optional(),
    /** The delegate contract's address: must equal the pinned table's for the chain (evmSponsorDelegateProblems). */
    delegate: evmAddress,
    /** OP Stack chain (an L1 data fee on top of gas): true for exactly OP_STACK_TEST_CHAIN_IDS. */
    opStack: z.boolean(),
    /** Gas limit of one sponsored transaction, the 7702 authorization included. */
    maxGasPerTx: z.number().int().min(B.maxGasPerTx.min).max(B.maxGasPerTx.max),
    /** The highest `maxFeePerGas` the relayer bids, gwei: with maxGasPerTx it caps one transaction's cost. */
    maxFeePerGasGwei: gwei('positive'),
    /** The highest priority fee, gwei; at most maxFeePerGasGwei. */
    maxPriorityFeePerGasGwei: gwei('nonnegative'),
    /** Calls in one signed batch (the approval's subject holds at most 8). */
    maxCallsPerBatch: z.number().int().min(1).max(B.maxCallsPerBatch),
    /** The furthest ahead a signed batch's deadline may be, seconds. */
    deadlineMaxS: z.number().int().min(B.deadlineMaxS.min).max(B.deadlineMaxS.max),
    /** The gas the delegate must still have before the calls (signed by the user as `minGas`); below maxGasPerTx. */
    minGas: z.number().int().min(B.minGas.min).max(B.minGas.max),
    /** ETH the relayer may spend per UTC day on this chain, across the env (D836). */
    dailyBudgetEth: eth(B.dailyBudgetEth),
    /** ETH one app may spend per UTC day; below dailyBudgetEth. */
    appDailyBudgetEth: eth(B.dailyBudgetEth),
    /** Below this balance (ETH) the relayer's check raises a low-balance alert. */
    lowBalanceEth: eth(B.lowBalanceEth),
    /** Sponsored sends per user per UTC day. */
    perUserPerDay: z.number().int().min(1).max(B.perUserPerDay),
    /** Sponsored sends per app per UTC day; below sendsPerDay. */
    perAppPerDay: z.number().int().min(1).max(B.perAppPerDay),
    /** Sponsored sends across the env per UTC day. */
    sendsPerDay: z.number().int().min(1).max(B.sendsPerDay),
    /** Sponsored sends across the env per minute. */
    sendsPerMinute: z.number().int().min(1).max(B.sendsPerMinute),
    /**
     * Sponsor only an account the wallet directory holds for a user of the app's scope (default true). `false`,
     * testnet only: anyone with a publishable key can spend the budget within the limits.
     */
    requireKnownAccount: z.boolean().optional(),
  })
  .strict();

/** A contract an app's users may call with sponsored gas (D835): its address and the functions allowed, value 0. */
export const evmSponsorTargetSchema = z
  .object({
    address: evmAddress,
    selectors: z.array(selector).min(1).max(B.selectorsPerTarget),
    /** Staff-facing name of the target (no control or formatting characters, no outer spaces). */
    label: z
      .string()
      .min(1)
      .max(B.labelChars)
      .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, 'A label has no control or formatting characters')
      .refine((v) => v.trim() === v, 'A label has no leading or trailing spaces'),
  })
  .strict();

/** The first forbidden key in `v` (any depth), as a path, or null. */
function forbiddenKeyPath(v: unknown, path: (string | number)[] = []): (string | number)[] | null {
  if (typeof v !== 'object' || v === null) return null;
  for (const [k, child] of Object.entries(v)) {
    if (FORBIDDEN_SPONSOR_KEYS.includes(k)) return [...path, k];
    const found = forbiddenKeyPath(child, [...path, Array.isArray(v) ? Number(k) : k]);
    if (found) return found;
  }
  return null;
}

const evmSponsorShape = z
  .object({
    /** The relayer's EOA: signs and pays for every sponsored transaction; its key is the Worker secret EVM_RELAY_KEYS. */
    relayerAddress: evmAddress,
    /** Settings per chain, by decimal chain ID. */
    chains: z.record(chainIdKey, evmSponsorChainSchema),
    /** The staff-only allowlist (D835): per app, per chain, the targets its users may call. Empty: nothing sponsored. */
    apps: z.record(appIdKey, z.record(chainIdKey, z.array(evmSponsorTargetSchema).min(1).max(B.targetsPerApp))),
  })
  .strict();

/**
 * The block. `__proto__`, `constructor` and `prototype` keys are refused anywhere in it before the shape is parsed
 * (zod's records would drop a `__proto__` key without a word).
 */
export const evmSponsorSchema = z.preprocess((v, ctx) => {
  const path = forbiddenKeyPath(v);
  if (path) ctx.addIssue({ code: 'custom', path, message: `evm.sponsor has a forbidden key ${String(path[path.length - 1])} at ${path.join('.')}` });
  return v;
}, evmSponsorShape);

/** EVM wallet settings: gas sponsorship (D834). */
export const evmSchema = z.object({ sponsor: evmSponsorSchema.optional() }).strict();

export type EvmSponsor = z.output<typeof evmSponsorShape>;
export type EvmSponsorChain = z.infer<typeof evmSponsorChainSchema>;

export interface EvmSponsorProblem {
  path: (string | number)[];
  message: string;
}

const safeSite = (url: string): string | null => {
  try {
    return siteOf(new URL(url).origin);
  } catch {
    return null;
  }
};

const lower = (a: string) => a.toLowerCase();

/**
 * The rules of `evm.sponsor` beyond its shape, as a list (empty = fine): testnet only; each chain a test chain (local
 * dev chains in `local*` envs only), `opStack` right for it, endpoints usable, fees and gas consistent, one
 * transaction's worst case inside the app's budget, every per-app limit below the env's (one leaked publishable key
 * must never use up the env's day); the allowlist's apps on configured chains, ≤ 8 apps and ≤ 8 targets each,
 * targets distinct and never the relayer or a delegate; the relayer never a delegate.
 */
export function evmSponsorProblems(m: { name: string; network: string; evm?: { sponsor?: EvmSponsor | undefined } | undefined }): EvmSponsorProblem[] {
  const s = m.evm?.sponsor;
  if (!s) return [];
  const out: EvmSponsorProblem[] = [];
  const at = (path: (string | number)[], message: string) => out.push({ path: ['evm', 'sponsor', ...path], message });
  if (m.network !== 'testnet') at([], `evm.sponsor is testnet only (network ${m.network})`);
  const chainIds = Object.keys(s.chains);
  if (chainIds.length < 1 || chainIds.length > B.chains) at(['chains'], `evm.sponsor.chains has 1 to ${B.chains} chains`);
  const delegates = new Set<string>();
  for (const [id, c] of Object.entries(s.chains)) {
    const n = Number(id);
    const p = (field: string, message: string) => at(['chains', id, field], `evm.sponsor.chains.${id}.${field} ${message}`);
    if (!SPONSOR_TEST_EVM_CHAIN_IDS.includes(n)) at(['chains', id], `evm.sponsor.chains: ${id} is not a known EVM test chain (TEST_EVM_CHAINS)`);
    else if (LOCAL_EVM_CHAIN_IDS.includes(n) && !isLocalEnv(m.name)) at(['chains', id], `evm.sponsor.chains: the local dev chain ${id} is only for local* envs`);
    if (c.opStack !== OP_STACK_TEST_CHAIN_IDS.includes(n)) p('opStack', `must be ${String(OP_STACK_TEST_CHAIN_IDS.includes(n))} for chain ${id}`);
    const rpcProblem = sponsorRpcUrlProblem(c.rpc, isLocalEnv(m.name));
    if (rpcProblem) p('rpc', rpcProblem);
    if (c.rpcFallback !== undefined) {
      const fbProblem = sponsorRpcUrlProblem(c.rpcFallback, isLocalEnv(m.name));
      if (fbProblem) p('rpcFallback', fbProblem);
      else if (c.rpcFallback === c.rpc) p('rpcFallback', 'must be a different endpoint from rpc');
      else if (!isLocalEnv(m.name) && safeSite(c.rpcFallback) !== null && safeSite(c.rpcFallback) === safeSite(c.rpc)) p('rpcFallback', `must be another provider (registrable domain) than rpc outside local* envs (both are ${safeSite(c.rpc)})`);
    }
    if (c.minGas >= c.maxGasPerTx) p('minGas', `(${c.minGas}) must be below maxGasPerTx (${c.maxGasPerTx})`);
    if (c.maxPriorityFeePerGasGwei > c.maxFeePerGasGwei) p('maxPriorityFeePerGasGwei', `(${c.maxPriorityFeePerGasGwei}) must not exceed maxFeePerGasGwei (${c.maxFeePerGasGwei})`);
    // One transaction at its worst case (gas limit × fee cap, before any L1 data fee) must fit the app's day.
    const worstWei = BigInt(c.maxGasPerTx) * (sponsorDecimalUnits(c.maxFeePerGasGwei, 9) ?? 0n);
    if (worstWei > (sponsorDecimalUnits(c.appDailyBudgetEth, 9) ?? 0n) * 10n ** 9n) p('maxGasPerTx', `× maxFeePerGasGwei (one transaction's worst case) must fit in appDailyBudgetEth (${c.appDailyBudgetEth})`);
    const pairs: [string, number, string, number][] = [
      ['appDailyBudgetEth', c.appDailyBudgetEth, 'dailyBudgetEth', c.dailyBudgetEth],
      ['perAppPerDay', c.perAppPerDay, 'sendsPerDay', c.sendsPerDay],
    ];
    for (const [app, appValue, env, envValue] of pairs) if (appValue >= envValue) p(app, `(${appValue}) must be below ${env} (${envValue})`);
    if (c.requireKnownAccount === false && m.network !== 'testnet') p('requireKnownAccount', 'false is testnet only (the relayer then pays for anyone holding a publishable key)');
    if (lower(c.delegate) === lower(s.relayerAddress)) p('delegate', 'must not be relayerAddress');
    delegates.add(lower(c.delegate));
  }
  const apps = Object.entries(s.apps);
  if (apps.length > B.apps) at(['apps'], `evm.sponsor.apps lists at most ${B.apps} apps`);
  for (const [appId, byChain] of apps) {
    const chains = Object.entries(byChain);
    if (chains.length === 0) at(['apps', appId], `evm.sponsor.apps.${appId} names no chain`);
    const total = chains.reduce((n, [, targets]) => n + targets.length, 0);
    if (total > B.targetsPerApp) at(['apps', appId], `evm.sponsor.apps.${appId} has ${total} targets; at most ${B.targetsPerApp}`);
    for (const [id, targets] of chains) {
      const tp = (i: number, message: string) => at(['apps', appId, id, i], `evm.sponsor.apps.${appId}.${id}[${i}] ${message}`);
      if (!Object.hasOwn(s.chains, id)) at(['apps', appId, id], `evm.sponsor.apps.${appId}: chain ${id} is not in evm.sponsor.chains`);
      const seen = new Set<string>();
      for (const [i, t] of targets.entries()) {
        const a = lower(t.address);
        if (seen.has(a)) tp(i, `lists ${t.address} again: one entry per target`);
        seen.add(a);
        if (a === lower(s.relayerAddress)) tp(i, 'must not be relayerAddress');
        if (delegates.has(a)) tp(i, 'must not be a delegate contract');
        if (new Set(t.selectors).size !== t.selectors.length) tp(i, 'lists a selector twice');
      }
    }
  }
  return out;
}

/** evmSponsorProblems as zod issues (the manifest schema's superRefine). */
export function evmSponsorRules(m: Parameters<typeof evmSponsorProblems>[0], ctx: z.RefinementCtx): void {
  for (const { path, message } of evmSponsorProblems(m)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

/** The pinned delegate table's shape, as @hana-id/core/evm-sponsor's `SPONSOR_DELEGATES` has it (only `address` is read). */
export type PinnedSponsorDelegates = Readonly<Record<number, { readonly address: string }>>;

/**
 * Why the block's delegates don't match the pinned, reviewed table (D834), one message each (empty = they match): every
 * chain needs a pinned entry, and its `delegate` must be that entry's address (compared case-insensitively). The
 * generators run it with core's table (apps/api gen-wrangler, packages/web gen-envs); the table is a parameter so this
 * package needs no dependency on core.
 */
export function evmSponsorDelegateProblems(sponsor: Pick<EvmSponsor, 'chains'>, pinned: PinnedSponsorDelegates): string[] {
  const out: string[] = [];
  for (const [id, c] of Object.entries(sponsor.chains)) {
    const entry = Object.hasOwn(pinned, Number(id)) ? pinned[Number(id)] : undefined;
    if (!entry) out.push(`evm.sponsor.chains.${id}: no pinned delegate for chain ${id}: sponsorship needs a reviewed delegate there first`);
    else if (lower(entry.address) !== lower(c.delegate)) out.push(`evm.sponsor.chains.${id}.delegate ${c.delegate} is not the pinned delegate ${entry.address}`);
  }
  return out;
}

/** What the vault build needs per chain (packages/web gen-envs): the delegate to authorize and the relayer to name. */
export function evmSponsorPageChains(sponsor: EvmSponsor): Record<string, { delegate: string; relayer: string }> {
  return Object.fromEntries(Object.entries(sponsor.chains).map(([id, c]) => [id, { delegate: c.delegate, relayer: sponsor.relayerAddress }]));
}
