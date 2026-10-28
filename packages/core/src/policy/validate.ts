// validateAutoApprovePolicy: the one validator the CLI (`admin app:settings --auto-approve`), the API and the vault use
// (docs/batch-b-spec.md "Auto-approve policies"). It refuses unknown keys anywhere (so a `raw`, `personalSign` or
// contract-creation entry can't be smuggled in), out-of-range limits, a decoder id the bundle doesn't ship, a missing
// `addressArgs` on an EVM function that takes an address, `addressArgs: 'any'` on an approve/transfer-style function
// (ERC-20, SAC, Sodax `AssetManager.transfer`, `Connection.sendMessage`/`send_message`), and 'self-or-listed' on an EVM
// function with arguments an address could hide in (`bytes`, `string`, `bytes20` to `bytes32`: the address rule can't
// see inside them). It returns the normalized policy that policyId hashes and the matcher reads.
import { StrKey } from '@stellar/stellar-base';
import { abiTypeContains, parseFunctionSignature } from '../decode/abi.ts';
import { DecodeError } from '../decode/errors.ts';
import { parseEvmAddress } from '../decode/hex.ts';
import { JsonNumber, type StrictJson, parseStrictJson } from '../decode/json.ts';
import { PROTOCOL_DECODERS, type ProtocolDecoderRegistry } from './decoders.ts';
import { isOpaqueToAddressRule } from './opaque.ts';
import type {
  AddressArgsRule,
  AutoApprovePolicyV1,
  EvmPolicyChain,
  EvmPolicyContract,
  EvmPolicySelector,
  EvmPolicyTypedData,
  FunctionRule,
  StellarPolicy,
  StellarPolicyContract,
  StellarPolicyFunction,
} from './types.ts';

/** The app setting's upper bound (23 h 50 min), so a consent never outlives a session. */
export const MAX_SESSION_TTL_MS = 23 * 3_600_000 + 50 * 60_000;
export const MIN_CONSENT_MS = 60_000;
export const MAX_PER_DAY_COUNT = 500;
export const POLICY_LABEL_MAX = 80;
export const POLICY_NAME_MAX = 64;
export const POLICY_MAX_CANONICAL_BYTES = 16 * 1024;
const MAX_U32 = 0xffffffffn;
const MAX_U256 = (1n << 256n) - 1n;

export interface PolicyValidationOptions {
  /** The app's session_ttl_ms: maxConsentMs may not exceed it. Defaults to MAX_SESSION_TTL_MS. */
  readonly sessionTtlMs?: number;
  /** The decoders this bundle ships. Defaults to PROTOCOL_DECODERS (empty in batch B). */
  readonly decoders?: ProtocolDecoderRegistry;
}

export type PolicyValidationResult =
  | { readonly ok: true; readonly policy: AutoApprovePolicyV1 }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Function names that move or approve assets, or hand over control of a contract, matched on the name lowercased and
 * without underscores. Matching is by prefix and substring, not exact name, so the ERC-677/1363 `transferAndCall`,
 * `approveAndCall`, ERC-777 `send`/`operatorSend`/`authorizeOperator`, EIP-3009 `transferWithAuthorization`, Permit2
 * `permitTransferFrom`, `transferOwnership`, Soroban `transfer_from`/`set_admin` and Sodax `sendMessage`/`send_message`
 * are all caught. They may never have `addressArgs: 'any'`: with it an injected script could send funds, allowances or
 * ownership to itself. A protocol that genuinely needs one of these names unchecked uses a protocol decoder instead.
 */
const VALUE_MOVING_PREFIXES = [
  'transfer',
  'safetransfer',
  'safebatchtransfer',
  'approve',
  'send',
  'permit',
  'operatorsend',
  'authorizeoperator',
  'setapproval',
  'setowner',
  'changeowner',
  'setadmin',
  'changeadmin',
];
const VALUE_MOVING_SUBSTRINGS = ['allowance', 'transfer', 'ownership'];

export const isValueMovingFunctionName = (name: string): boolean => {
  const n = name.replace(/_/gu, '').toLowerCase();
  return VALUE_MOVING_PREFIXES.some((p) => n.startsWith(p)) || VALUE_MOVING_SUBSTRINGS.some((x) => n.includes(x));
};

// Characters a label or name may not contain (controls, bidi and invisible format characters).
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
const SOROBAN_SYMBOL = /^[A-Za-z0-9_]{1,32}$/u;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const ASSET = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/u;

type Obj = Record<string, unknown>;

class Checker {
  readonly problems: string[] = [];

  problem(path: string, message: string): undefined {
    this.problems.push(`${path}: ${message}`);
    return undefined;
  }

  object(v: unknown, path: string, required: readonly string[], optional: readonly string[]): Obj | undefined {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return this.problem(path, 'must be an object');
    const o = v as Obj;
    const allowed = new Set([...required, ...optional]);
    let ok = true;
    for (const k of Object.keys(o)) {
      if (!allowed.has(k)) {
        this.problem(path, `unknown key "${k}"`);
        ok = false;
      }
    }
    for (const k of required) {
      if (o[k] === undefined) {
        this.problem(path, `missing "${k}"`);
        ok = false;
      }
    }
    return ok ? o : undefined;
  }

  array(v: unknown, path: string, min: number, max: number): unknown[] | undefined {
    if (!Array.isArray(v)) return this.problem(path, 'must be an array');
    if (v.length < min || v.length > max) return this.problem(path, `must have ${min} to ${max} entries`);
    return v;
  }

  text(v: unknown, path: string, max: number): string | undefined {
    if (typeof v !== 'string') return this.problem(path, 'must be a string');
    const len = [...v].length;
    if (len === 0 || len > max) return this.problem(path, `must be 1 to ${max} characters`);
    if (v.trim() !== v) return this.problem(path, 'must not start or end with whitespace');
    if (UNSAFE_TEXT.test(v)) return this.problem(path, 'contains control or invisible characters');
    return v;
  }

  integer(v: unknown, path: string, min: number, max: number): number | undefined {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return this.problem(path, 'must be an integer');
    if (v < min || v > max) return this.problem(path, `must be between ${min} and ${max}`);
    return v;
  }

  decimal(v: unknown, path: string, min: bigint, max: bigint): string | undefined {
    if (typeof v !== 'string' || !DECIMAL.test(v)) return this.problem(path, 'must be a decimal string');
    const n = BigInt(v);
    if (n < min || n > max) return this.problem(path, `must be between ${min} and ${max}`);
    return v;
  }

  unique<T>(items: readonly T[], key: (t: T) => string, path: string): void {
    const seen = new Set<string>();
    for (const item of items) {
      const k = key(item);
      if (seen.has(k)) this.problem(path, `duplicate entry ${k}`);
      seen.add(k);
    }
  }
}

function functionRule(
  c: Checker,
  o: Obj,
  path: string,
  chain: 'stellar' | 'evm',
  decoders: ProtocolDecoderRegistry,
): FunctionRule | undefined {
  if (o.addressArgs !== undefined && o.decoder !== undefined) {
    return c.problem(path, 'set either "addressArgs" or "decoder", not both');
  }
  if (o.decoder !== undefined) {
    if (typeof o.decoder !== 'string') return c.problem(`${path}.decoder`, 'must be a string');
    const d = decoders.get(o.decoder);
    if (d === undefined) return c.problem(`${path}.decoder`, `unknown protocol decoder "${o.decoder}"`);
    if (d.chain !== chain) return c.problem(`${path}.decoder`, `decoder "${o.decoder}" is not for ${chain}`);
    return { decoder: o.decoder };
  }
  if (o.addressArgs !== undefined && o.addressArgs !== 'self-or-listed' && o.addressArgs !== 'any') {
    return c.problem(`${path}.addressArgs`, "must be 'self-or-listed' or 'any'");
  }
  return { addressArgs: (o.addressArgs ?? 'self-or-listed') as AddressArgsRule };
}

function stellarAddress(c: Checker, v: unknown, path: string, allowContract: boolean): string | undefined {
  if (typeof v === 'string' && (StrKey.isValidEd25519PublicKey(v) || (allowContract && StrKey.isValidContract(v)))) {
    return v;
  }
  return c.problem(path, allowContract ? 'must be a G… or C… address' : 'must be a G… address');
}

function stellarSection(c: Checker, v: unknown, decoders: ProtocolDecoderRegistry): StellarPolicy | undefined {
  const o = c.object(
    v,
    'stellar',
    ['networkPassphrases', 'maxFeeStroops', 'contracts'],
    ['changeTrustAssets', 'addresses'],
  );
  if (!o) return undefined;
  const passphrases = c.array(o.networkPassphrases, 'stellar.networkPassphrases', 1, 4)?.map((p, i) => {
    const path = `stellar.networkPassphrases[${i}]`;
    if (typeof p !== 'string' || p.length === 0 || p.length > 256) {
      return c.problem(path, 'must be 1 to 256 characters');
    }
    return p;
  });
  if (passphrases) c.unique(passphrases, (p) => JSON.stringify(p), 'stellar.networkPassphrases');
  const maxFee = c.decimal(o.maxFeeStroops, 'stellar.maxFeeStroops', 1n, MAX_U32);
  const contracts = c.array(o.contracts, 'stellar.contracts', 0, 32)?.map((raw, i) => {
    const path = `stellar.contracts[${i}]`;
    const co = c.object(raw, path, ['id', 'name', 'functions'], []);
    if (!co) return undefined;
    const id =
      typeof co.id === 'string' && StrKey.isValidContract(co.id) ? co.id : c.problem(`${path}.id`, 'must be a C… id');
    const name = c.text(co.name, `${path}.name`, POLICY_NAME_MAX);
    const functions = c.array(co.functions, `${path}.functions`, 1, 32)?.map((rawFn, j) => {
      const fpath = `${path}.functions[${j}]`;
      const fo = c.object(rawFn, fpath, ['name'], ['addressArgs', 'decoder']);
      if (!fo) return undefined;
      if (typeof fo.name !== 'string' || !SOROBAN_SYMBOL.test(fo.name)) {
        return c.problem(`${fpath}.name`, 'must be a Soroban symbol (1 to 32 of A-Z a-z 0-9 _)');
      }
      const rule = functionRule(c, fo, fpath, 'stellar', decoders);
      if (!rule) return undefined;
      if (rule.addressArgs === 'any' && isValueMovingFunctionName(fo.name)) {
        return c.problem(fpath, `"${fo.name}" moves or approves assets and can't have addressArgs 'any'`);
      }
      return Object.freeze({ name: fo.name, ...rule }) as StellarPolicyFunction;
    });
    if (functions) c.unique(functions.filter(Boolean) as StellarPolicyFunction[], (f) => f.name, `${path}.functions`);
    if (id === undefined || name === undefined || !functions || functions.includes(undefined)) return undefined;
    return Object.freeze({ id, name, functions: Object.freeze(functions) }) as StellarPolicyContract;
  });
  if (contracts) c.unique(contracts.filter(Boolean) as StellarPolicyContract[], (k) => k.id, 'stellar.contracts');

  let assets: string[] | undefined;
  if (o.changeTrustAssets !== undefined) {
    assets = c.array(o.changeTrustAssets, 'stellar.changeTrustAssets', 0, 64)?.map((a, i) => {
      const m = typeof a === 'string' ? ASSET.exec(a) : null;
      if (!m || !StrKey.isValidEd25519PublicKey(m[2] as string)) {
        return c.problem(
          `stellar.changeTrustAssets[${i}]`,
          "must be 'CODE:ISSUER' (code 1 to 12 alphanumerics, G… issuer)",
        );
      }
      return a as string;
    }) as string[] | undefined;
    if (assets) c.unique(assets.filter(Boolean), (a) => a, 'stellar.changeTrustAssets');
  }
  let addresses: string[] | undefined;
  if (o.addresses !== undefined) {
    addresses = c
      .array(o.addresses, 'stellar.addresses', 0, 64)
      ?.map((a, i) => stellarAddress(c, a, `stellar.addresses[${i}]`, true)) as string[] | undefined;
    if (addresses) c.unique(addresses.filter(Boolean), (a) => a, 'stellar.addresses');
  }
  if (contracts && contracts.length === 0 && (assets?.length ?? 0) === 0) {
    c.problem('stellar', 'must list at least one contract or changeTrust asset');
  }
  if (
    !passphrases ||
    passphrases.includes(undefined) ||
    maxFee === undefined ||
    !contracts ||
    contracts.includes(undefined) ||
    (o.changeTrustAssets !== undefined && (!assets || assets.includes(undefined as never))) ||
    (o.addresses !== undefined && (!addresses || addresses.includes(undefined as never)))
  ) {
    return undefined;
  }
  return Object.freeze({
    networkPassphrases: Object.freeze(passphrases as string[]),
    maxFeeStroops: maxFee,
    contracts: Object.freeze(contracts as StellarPolicyContract[]),
    ...(assets ? { changeTrustAssets: Object.freeze(assets) } : {}),
    ...(addresses ? { addresses: Object.freeze(addresses) } : {}),
  });
}

function evmAddress(c: Checker, v: unknown, path: string): string | undefined {
  if (typeof v !== 'string') return c.problem(path, 'must be an EVM address');
  try {
    const a = parseEvmAddress(v);
    if (/^0x0{40}$/u.test(a)) return c.problem(path, "can't be the zero address");
    return a;
  } catch (e) {
    return c.problem(path, e instanceof DecodeError ? e.message : 'must be an EVM address');
  }
}

function evmSelector(c: Checker, raw: unknown, path: string, decoders: ProtocolDecoderRegistry) {
  const so = c.object(raw, path, ['selector', 'signature'], ['addressArgs', 'decoder']);
  if (!so) return undefined;
  if (typeof so.signature !== 'string') return c.problem(`${path}.signature`, 'must be a string');
  let fn: ReturnType<typeof parseFunctionSignature>;
  try {
    fn = parseFunctionSignature(so.signature);
  } catch (e) {
    return c.problem(`${path}.signature`, e instanceof DecodeError ? e.message : 'bad signature');
  }
  if (typeof so.selector !== 'string' || !/^0x[0-9a-fA-F]{8}$/u.test(so.selector)) {
    return c.problem(`${path}.selector`, 'must be 0x + 8 hex');
  }
  const selector = so.selector.toLowerCase();
  if (selector !== fn.selector) return c.problem(`${path}.selector`, `doesn't match the signature (${fn.selector})`);
  const rule = functionRule(c, so, path, 'evm', decoders);
  if (!rule) return undefined;
  const takesAddress = fn.params.some((t) => abiTypeContains(t, (x) => x.kind === 'address'));
  const takesOpaque = fn.params.some((t) => abiTypeContains(t, isOpaqueToAddressRule));
  if (rule.decoder === undefined) {
    if (takesAddress && so.addressArgs === undefined) {
      return c.problem(path, `${fn.signature} takes an address: set addressArgs`);
    }
    if (rule.addressArgs === 'any' && isValueMovingFunctionName(fn.name)) {
      return c.problem(path, `"${fn.name}" moves or approves assets and can't have addressArgs 'any'`);
    }
    if (rule.addressArgs === 'self-or-listed' && takesOpaque) {
      return c.problem(
        path,
        `${fn.signature} takes opaque arguments (bytes, string or bytes20 to bytes32) the address rule can't check: ` +
          "it needs a protocol decoder or addressArgs 'any'",
      );
    }
  }
  return Object.freeze({ selector, signature: fn.signature, ...rule }) as EvmPolicySelector;
}

function evmChain(c: Checker, raw: unknown, path: string, decoders: ProtocolDecoderRegistry) {
  const o = c.object(
    raw,
    path,
    ['chainId', 'maxValueWei', 'maxValueWeiPerDay', 'maxFeeWei', 'contracts'],
    ['typedData', 'addresses'],
  );
  if (!o) return undefined;
  const chainId = c.integer(o.chainId, `${path}.chainId`, 1, Number.MAX_SAFE_INTEGER);
  const maxValue = c.decimal(o.maxValueWei, `${path}.maxValueWei`, 0n, MAX_U256);
  const maxPerDay = c.decimal(o.maxValueWeiPerDay, `${path}.maxValueWeiPerDay`, 0n, MAX_U256);
  const maxFee = c.decimal(o.maxFeeWei, `${path}.maxFeeWei`, 1n, MAX_U256);
  if (maxValue !== undefined && maxPerDay !== undefined && BigInt(maxValue) > BigInt(maxPerDay)) {
    c.problem(`${path}.maxValueWei`, 'must not exceed maxValueWeiPerDay');
  }
  const contracts = c.array(o.contracts, `${path}.contracts`, 0, 32)?.map((rawC, i) => {
    const cpath = `${path}.contracts[${i}]`;
    const co = c.object(rawC, cpath, ['address', 'name', 'selectors'], []);
    if (!co) return undefined;
    const address = evmAddress(c, co.address, `${cpath}.address`);
    const name = c.text(co.name, `${cpath}.name`, POLICY_NAME_MAX);
    const selectors = c
      .array(co.selectors, `${cpath}.selectors`, 1, 32)
      ?.map((s, j) => evmSelector(c, s, `${cpath}.selectors[${j}]`, decoders));
    if (selectors) c.unique(selectors.filter(Boolean) as EvmPolicySelector[], (s) => s.selector, `${cpath}.selectors`);
    if (address === undefined || name === undefined || !selectors || selectors.includes(undefined)) return undefined;
    return Object.freeze({ address, name, selectors: Object.freeze(selectors) }) as EvmPolicyContract;
  });
  if (contracts) c.unique(contracts.filter(Boolean) as EvmPolicyContract[], (k) => k.address, `${path}.contracts`);
  let typedData: (EvmPolicyTypedData | undefined)[] | undefined;
  if (o.typedData !== undefined) {
    typedData = c.array(o.typedData, `${path}.typedData`, 0, 32)?.map((rawT, i) => {
      const tpath = `${path}.typedData[${i}]`;
      const to = c.object(rawT, tpath, ['verifyingContract', 'primaryType'], []);
      if (!to) return undefined;
      const verifyingContract = evmAddress(c, to.verifyingContract, `${tpath}.verifyingContract`);
      if (typeof to.primaryType !== 'string' || !IDENTIFIER.test(to.primaryType) || to.primaryType === 'EIP712Domain') {
        return c.problem(`${tpath}.primaryType`, 'must be a struct type name other than EIP712Domain');
      }
      if (verifyingContract === undefined) return undefined;
      return Object.freeze({ verifyingContract, primaryType: to.primaryType });
    });
    if (typedData) {
      c.unique(
        typedData.filter(Boolean) as EvmPolicyTypedData[],
        (t) => `${t.verifyingContract}/${t.primaryType}`,
        `${path}.typedData`,
      );
    }
  }
  let addresses: (string | undefined)[] | undefined;
  if (o.addresses !== undefined) {
    addresses = c
      .array(o.addresses, `${path}.addresses`, 0, 64)
      ?.map((a, i) => evmAddress(c, a, `${path}.addresses[${i}]`));
    if (addresses) c.unique(addresses.filter(Boolean) as string[], (a) => a, `${path}.addresses`);
  }
  if (contracts && contracts.length === 0 && (typedData?.length ?? 0) === 0) {
    c.problem(path, 'must list at least one contract or typedData entry');
  }
  if (
    chainId === undefined ||
    maxValue === undefined ||
    maxPerDay === undefined ||
    maxFee === undefined ||
    !contracts ||
    contracts.includes(undefined) ||
    (o.typedData !== undefined && (!typedData || typedData.includes(undefined))) ||
    (o.addresses !== undefined && (!addresses || addresses.includes(undefined)))
  ) {
    return undefined;
  }
  return Object.freeze({
    chainId,
    maxValueWei: maxValue,
    maxValueWeiPerDay: maxPerDay,
    maxFeeWei: maxFee,
    contracts: Object.freeze(contracts as EvmPolicyContract[]),
    ...(typedData ? { typedData: Object.freeze(typedData as EvmPolicyTypedData[]) } : {}),
    ...(addresses ? { addresses: Object.freeze(addresses as string[]) } : {}),
  }) as EvmPolicyChain;
}

/** Validates and normalizes a policy (a parsed JSON value). Never throws. */
export function validateAutoApprovePolicy(
  input: unknown,
  options: PolicyValidationOptions = {},
): PolicyValidationResult {
  const c = new Checker();
  const decoders = options.decoders ?? PROTOCOL_DECODERS;
  const ttl = options.sessionTtlMs ?? MAX_SESSION_TTL_MS;
  const o = c.object(input, 'policy', ['v', 'label', 'maxConsentMs', 'limits'], ['stellar', 'evm']);
  if (!o) return { ok: false, problems: c.problems };
  if (o.v !== 1) c.problem('policy.v', 'must be 1');
  const label = c.text(o.label, 'policy.label', POLICY_LABEL_MAX);
  const maxConsentMs = c.integer(
    o.maxConsentMs,
    'policy.maxConsentMs',
    MIN_CONSENT_MS,
    Math.min(ttl, MAX_SESSION_TTL_MS),
  );
  const lo = c.object(o.limits, 'policy.limits', ['perDayCount'], []);
  const perDayCount = lo ? c.integer(lo.perDayCount, 'policy.limits.perDayCount', 1, MAX_PER_DAY_COUNT) : undefined;
  if (o.stellar === undefined && o.evm === undefined) c.problem('policy', 'must have a stellar or an evm section');
  const stellar = o.stellar === undefined ? undefined : stellarSection(c, o.stellar, decoders);
  let evm: { chains: readonly EvmPolicyChain[] } | undefined;
  if (o.evm !== undefined) {
    const eo = c.object(o.evm, 'evm', ['chains'], []);
    const chains = eo
      ? c.array(eo.chains, 'evm.chains', 1, 16)?.map((ch, i) => evmChain(c, ch, `evm.chains[${i}]`, decoders))
      : undefined;
    if (chains) c.unique(chains.filter(Boolean) as EvmPolicyChain[], (ch) => String(ch.chainId), 'evm.chains');
    if (chains && !chains.includes(undefined)) {
      evm = Object.freeze({ chains: Object.freeze(chains as EvmPolicyChain[]) });
    }
  }
  if (c.problems.length > 0) return { ok: false, problems: c.problems };
  const policy: AutoApprovePolicyV1 = Object.freeze({
    v: 1,
    label: label as string,
    maxConsentMs: maxConsentMs as number,
    limits: Object.freeze({ perDayCount: perDayCount as number }),
    ...(stellar ? { stellar } : {}),
    ...(evm ? { evm } : {}),
  });
  if (new TextEncoder().encode(canonicalJson(policy)).length > POLICY_MAX_CANONICAL_BYTES) {
    return { ok: false, problems: [`policy: canonical JSON is over ${POLICY_MAX_CANONICAL_BYTES} bytes`] };
  }
  return { ok: true, policy };
}

/**
 * Canonical JSON (RFC 8785 for the values a policy holds: strings, safe integers, booleans, arrays, objects): object
 * keys sorted by UTF-16 code units, no whitespace, strings escaped as JSON.stringify does.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('canonicalJson: only safe integers');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Obj;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v}`);
}

function plain(v: StrictJson): unknown {
  if (v instanceof JsonNumber) {
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(v.raw)) return Number.NaN; // refused by the validator as "must be an integer"
    const n = Number(v.raw);
    return Number.isSafeInteger(n) ? n : Number.NaN;
  }
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object' && v !== null) {
    const out = Object.create(null) as Obj;
    for (const [k, x] of Object.entries(v)) out[k] = plain(x);
    return out;
  }
  return v;
}

/** Parses policy JSON strictly (duplicate keys refused) and validates it. Never throws. */
export function parseAutoApprovePolicy(json: string, options: PolicyValidationOptions = {}): PolicyValidationResult {
  let parsed: StrictJson;
  try {
    parsed = parseStrictJson(json);
  } catch (e) {
    return { ok: false, problems: [`policy: ${e instanceof Error ? e.message : 'invalid JSON'}`] };
  }
  return validateAutoApprovePolicy(plain(parsed), options);
}
