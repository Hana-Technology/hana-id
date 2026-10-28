// The auto-approve matcher (docs/batch-b-spec.md "Matching"). The vault calls it for every request before deciding
// between signing silently and opening the approval popup; it uses the same decoders the popup uses
// (decodeApprovalRequest). A request is auto-approved only if every check passes; any failed check, decode error or
// limit reached returns a reason, and the popup shows why it wasn't auto-approved. Consent (policyId accepted by the
// user, not expired) is the vault's check, made before this one.
import { type ApprovalSubject, NEVER_AUTO_APPROVED_KINDS } from '../approval.ts';
import { type AbiValue, abiValuesOfKind, decodeFunctionData, parseFunctionSignature } from '../decode/abi.ts';
import type { DecodedEvmTx } from '../decode/evm.ts';
import { DecodeError } from '../decode/errors.ts';
import { parseHex0x } from '../decode/hex.ts';
import { type DecodedApproval, decodeApprovalRequest } from '../decode/request.ts';
import type { StellarInvocation, StellarScVal, StellarTransaction } from '../decode/stellar.ts';
import {
  type NormalizedTypedData,
  type ParsedTypedDataType,
  type TypedDataStruct,
  type TypedDataValue,
  parseTypedDataType,
  typedDataChainId,
} from '../typed-data.ts';
import { PROTOCOL_DECODERS, type ProtocolCall, type ProtocolDecoderRegistry } from './decoders.ts';
import type { AutoApprovePolicyV1, EvmPolicyChain, FunctionRule, StellarPolicy } from './types.ts';
import { type AutoApproveUsage, usageToday } from './usage.ts';

export type AutoApproveReason =
  | 'never_covered' // raw, personal_sign, stellar_signMessage: no policy can cover them
  | 'no_policy_section' // the policy has no section for this chain
  | 'decode_failed'
  | 'network_not_listed'
  | 'chain_not_listed'
  | 'fee_bump'
  | 'unsupported_envelope' // v0 envelopes
  | 'fee_too_high'
  | 'source_not_self'
  | 'operation_not_allowed' // a classic op other than a listed changeTrust, a contract creation or upload, …
  // … or a restore/extend footprint outside the listed contracts
  | 'asset_not_listed'
  | 'contract_creation'
  | 'contract_not_listed'
  | 'function_not_listed'
  | 'selector_not_listed'
  | 'calldata_mismatch'
  | 'address_not_allowed'
  | 'opaque_bytes' // bytes arguments the address rule can't see into
  | 'unsupported_argument'
  | 'decoder_unavailable'
  | 'decoder_refused'
  | 'typed_data_not_listed'
  | 'value_too_high'
  | 'daily_value_exceeded'
  | 'daily_count_reached';

export type AutoApproveResult =
  | {
      readonly ok: true;
      readonly chain: 'stellar' | 'evm';
      /** For the `autoApproved` event and the launcher: the (first) contract and function signed for. */
      readonly contract: string;
      readonly function: string;
      /** Pass to recordAutoApproveUse after signing (EVM native value; absent on Stellar). */
      readonly spend?: { readonly chainId: number; readonly valueWei: bigint };
    }
  | { readonly ok: false; readonly reason: AutoApproveReason; readonly detail: string };

export interface AutoApproveContext {
  /** Today's (or an older) usage from the consent record; null for none yet. */
  readonly usage: AutoApproveUsage | null;
  readonly nowMs: number;
  /** Defaults to PROTOCOL_DECODERS (empty in batch B). */
  readonly decoders?: ProtocolDecoderRegistry;
}

class Miss extends Error {
  constructor(
    readonly reason: AutoApproveReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const miss = (reason: AutoApproveReason, detail: string): never => {
  throw new Miss(reason, detail);
};

/**
 * Matches `request` against `policy` (a policy returned by validateAutoApprovePolicy). The user's own address is
 * `request.address`. Never throws.
 */
export function matchAutoApprovePolicy(
  policy: AutoApprovePolicyV1,
  request: ApprovalSubject,
  ctx: AutoApproveContext,
): AutoApproveResult {
  try {
    if (NEVER_AUTO_APPROVED_KINDS.has(request.kind)) {
      miss('never_covered', `${request.kind} always needs approval`);
    }
    let decoded: DecodedApproval;
    try {
      decoded = decodeApprovalRequest(request);
    } catch (e) {
      return miss('decode_failed', e instanceof DecodeError ? e.message : 'Request could not be decoded');
    }
    const decoders = ctx.decoders ?? PROTOCOL_DECODERS;
    const usage = usageToday(ctx.usage, ctx.nowMs);
    let result: AutoApproveResult;
    switch (decoded.kind) {
      case 'stellar_tx':
      case 'stellar_auth_entry':
        result = matchStellar(
          policy.stellar ?? miss('no_policy_section', 'Policy has no Stellar section'),
          decoded,
          request.address,
          decoders,
        );
        break;
      case 'evm_tx':
        result = matchEvmTx(policy, decoded.tx, request.address, usage, decoders);
        break;
      case 'eip712':
        result = matchTypedData(policy, decoded.typedData, request.address);
        break;
      default:
        return miss('never_covered', `${request.kind} always needs approval`);
    }
    if (usage.count + 1 > policy.limits.perDayCount) {
      miss('daily_count_reached', `Daily limit of ${policy.limits.perDayCount} auto-approved requests reached`);
    }
    return result;
  } catch (e) {
    if (e instanceof Miss) return { ok: false, reason: e.reason, detail: e.detail };
    return { ok: false, reason: 'decode_failed', detail: 'Request could not be checked' };
  }
}

// --- Stellar ---

function stellarRule(p: StellarPolicy, contract: string, fn: string): FunctionRule {
  const c =
    p.contracts.find((x) => x.id === contract) ?? miss('contract_not_listed', `Contract ${contract} is not listed`);
  return c.functions.find((f) => f.name === fn) ?? miss('function_not_listed', `${fn} on ${contract} is not listed`);
}

function checkScVals(values: readonly StellarScVal[], allowed: ReadonlySet<string>, where: string): void {
  const walk = (v: StellarScVal) => {
    switch (v.type) {
      case 'address':
        if (!allowed.has(v.address)) {
          miss('address_not_allowed', `${where}: ${v.address} is not you or a listed address`);
        }
        return;
      case 'bytes':
        return miss('opaque_bytes', `${where}: bytes arguments can't be checked by the address rule`);
      case 'vec':
        v.items.forEach(walk);
        return;
      case 'map':
        for (const e of v.entries) {
          walk(e.key);
          walk(e.value);
        }
        return;
      case 'error':
      case 'contractInstance':
      case 'ledgerKeyContractInstance':
      case 'ledgerKeyNonce':
        return miss('unsupported_argument', `${where}: ${v.type} argument`);
      default:
        return;
    }
  };
  values.forEach(walk);
}

function checkStellarCall(
  p: StellarPolicy,
  call: { contract: string; function: string; args: readonly StellarScVal[] },
  self: string,
  passphrase: string,
  allowed: ReadonlySet<string>,
  decoders: ProtocolDecoderRegistry,
): void {
  const rule = stellarRule(p, call.contract, call.function);
  const where = `${call.function} on ${call.contract}`;
  if (rule.decoder !== undefined) {
    const pc: ProtocolCall = { chain: 'stellar', ...call };
    runDecoder(rule.decoder, pc, { user: self, networkPassphrase: passphrase }, allowed, decoders, where);
    return;
  }
  if (rule.addressArgs === 'self-or-listed') checkScVals(call.args, allowed, where);
}

function checkInvocation(
  p: StellarPolicy,
  inv: StellarInvocation,
  self: string,
  passphrase: string,
  allowed: ReadonlySet<string>,
  decoders: ProtocolDecoderRegistry,
): void {
  if (inv.function.type !== 'contractFn') miss('operation_not_allowed', 'Authorization creates a contract');
  checkStellarCall(
    p,
    inv.function as Extract<StellarInvocation['function'], { type: 'contractFn' }>,
    self,
    passphrase,
    allowed,
    decoders,
  );
  for (const sub of inv.subInvocations) checkInvocation(p, sub, self, passphrase, allowed, decoders);
}

function matchStellar(
  p: StellarPolicy,
  decoded: Extract<DecodedApproval, { kind: 'stellar_tx' | 'stellar_auth_entry' }>,
  self: string,
  decoders: ProtocolDecoderRegistry,
): AutoApproveResult {
  const passphrase = decoded.networkPassphrase;
  if (!p.networkPassphrases.includes(passphrase)) miss('network_not_listed', 'Network is not listed');
  const allowed = new Set<string>([self, ...p.contracts.map((c) => c.id), ...(p.addresses ?? [])]);

  if (decoded.kind === 'stellar_auth_entry') {
    const root = decoded.preimage.invocation;
    checkInvocation(p, root, self, passphrase, allowed, decoders);
    const fn = root.function as Extract<StellarInvocation['function'], { type: 'contractFn' }>;
    return { ok: true, chain: 'stellar', contract: fn.contract, function: fn.function };
  }

  const env = decoded.envelope;
  if (env.envelope === 'fee_bump') miss('fee_bump', 'Fee-bump transactions always need approval');
  if (env.envelope !== 'tx') miss('unsupported_envelope', 'Legacy (v0) envelopes always need approval');
  const tx: StellarTransaction = env.tx;
  if (BigInt(tx.fee) > BigInt(p.maxFeeStroops)) {
    miss('fee_too_high', `Fee ${tx.fee} is over ${p.maxFeeStroops} stroops`);
  }
  if (tx.source !== self) miss('source_not_self', 'Transaction source is not you');
  if (tx.operations.length === 0) miss('operation_not_allowed', 'Transaction has no operations');
  let first: { contract: string; function: string } | null = null;
  for (const op of tx.operations) {
    if (op.source !== null && op.source !== self) miss('source_not_self', `${op.type} has another source`);
    switch (op.type) {
      case 'invokeHostFunction': {
        const o = op as Extract<typeof op, { type: 'invokeHostFunction' }>;
        if (o.hostFunction.type !== 'invokeContract') {
          miss('operation_not_allowed', `${o.hostFunction.type} always needs approval`);
        }
        const call = o.hostFunction as Extract<typeof o.hostFunction, { type: 'invokeContract' }>;
        checkStellarCall(p, call, self, passphrase, allowed, decoders);
        for (const entry of o.auth) checkInvocation(p, entry.rootInvocation, self, passphrase, allowed, decoders);
        first ??= { contract: call.contract, function: call.function };
        break;
      }
      case 'restoreFootprint':
      case 'extendFootprintTtl': {
        const keys = [...(tx.soroban?.readOnly ?? []), ...(tx.soroban?.readWrite ?? [])];
        if (!tx.soroban || keys.length === 0) miss('operation_not_allowed', `${op.type} without a footprint`);
        // Restoring or extending only spends fees (bounded by maxFeeStroops); still, every data entry must belong to a
        // listed contract. Code entries are keyed by wasm hash and can't be tied to a contract offline.
        const listed = new Set(p.contracts.map((c) => c.id));
        let contract: string | null = null;
        for (const k of keys) {
          if (k.type === 'contractCode') continue;
          if (k.type === 'contractData' && listed.has(k.contract)) {
            contract ??= k.contract;
            continue;
          }
          miss('operation_not_allowed', `${op.type} touches entries outside the listed contracts`);
        }
        first ??= { contract: contract ?? '', function: op.type };
        break;
      }
      case 'changeTrust': {
        const asset = (op as Extract<typeof op, { type: 'changeTrust' }>).asset;
        if (!(p.changeTrustAssets ?? []).includes(asset)) {
          miss('asset_not_listed', `changeTrust for ${asset} is not listed`);
        }
        first ??= { contract: asset, function: 'changeTrust' };
        break;
      }
      default:
        miss('operation_not_allowed', `${op.type} always needs approval`);
    }
  }
  const f = first as { contract: string; function: string };
  return { ok: true, chain: 'stellar', contract: f.contract, function: f.function };
}

// --- decoders ---

function runDecoder(
  id: string,
  call: ProtocolCall,
  ctx: { user: string; chainId: number } | { user: string; networkPassphrase: string },
  allowed: ReadonlySet<string>,
  decoders: ProtocolDecoderRegistry,
  where: string,
): void {
  const d = decoders.get(id);
  if (!d || d.chain !== call.chain) miss('decoder_unavailable', `${where}: decoder ${id} is not available`);
  const decoder = d as NonNullable<typeof d>;
  let out: ReturnType<typeof decoder.decode>;
  try {
    if (!decoder.matches(call)) miss('decoder_refused', `${where}: ${id} does not handle this call`);
    out = decoder.decode(call, ctx);
  } catch (e) {
    if (e instanceof Miss) throw e;
    return miss('decoder_refused', `${where}: ${id} failed`);
  }
  if (!out.ok) miss('decoder_refused', `${where}: ${out.reason}`);
  const effects = (out as Extract<typeof out, { ok: true }>).effects;
  for (const a of [...effects.recipients, ...effects.targets]) {
    if (!allowed.has(call.chain === 'evm' ? a.toLowerCase() : a)) {
      miss('address_not_allowed', `${where}: ${a} is not you or a listed address`);
    }
  }
}

// --- EVM ---

function evmChain(policy: AutoApprovePolicyV1, chainId: number): EvmPolicyChain {
  if (!policy.evm) miss('no_policy_section', 'Policy has no EVM section');
  return (
    (policy.evm as NonNullable<AutoApprovePolicyV1['evm']>).chains.find((c) => c.chainId === chainId) ??
    miss('chain_not_listed', `Chain ${chainId} is not listed`)
  );
}

/** Allowed addresses on an EVM chain, lowercased: the user, listed contracts and typed-data verifiers, `addresses`. */
function evmAllowed(chain: EvmPolicyChain, self: string): Set<string> {
  return new Set(
    [
      self,
      ...chain.contracts.map((c) => c.address),
      ...(chain.typedData ?? []).map((t) => t.verifyingContract),
      ...(chain.addresses ?? []),
    ].map((a) => a.toLowerCase()),
  );
}

function matchEvmTx(
  policy: AutoApprovePolicyV1,
  tx: DecodedEvmTx,
  self: string,
  usage: AutoApproveUsage,
  decoders: ProtocolDecoderRegistry,
): AutoApproveResult {
  const chainId = Number(tx.chainId);
  const chain = evmChain(policy, chainId);
  if (tx.to === null) miss('contract_creation', 'Contract creation always needs approval');
  const to = tx.to as string;
  const contract =
    chain.contracts.find((c) => c.address === to) ?? miss('contract_not_listed', `Contract ${to} is not listed`);
  if (tx.selector === null) miss('selector_not_listed', `Call to ${to} has no function selector`);
  const entry =
    contract.selectors.find((s) => s.selector === tx.selector) ??
    miss('selector_not_listed', `Function ${tx.selector} on ${to} is not listed`);
  const fn = parseFunctionSignature(entry.signature);
  let args: AbiValue[];
  try {
    args = decodeFunctionData(fn, parseHex0x(tx.data));
  } catch {
    return miss('calldata_mismatch', `Calldata doesn't decode as ${entry.signature}`);
  }
  const allowed = evmAllowed(chain, self);
  const where = `${fn.name} on ${to}`;
  if (entry.decoder !== undefined) {
    const call: ProtocolCall = {
      chain: 'evm',
      contract: to,
      selector: entry.selector,
      signature: entry.signature,
      args,
      valueWei: tx.value,
    };
    runDecoder(entry.decoder, call, { user: self, chainId }, allowed, decoders, where);
  } else if (entry.addressArgs === 'self-or-listed') {
    if (abiValuesOfKind(args, 'bytes').some((b) => b.type === 'bytes')) {
      miss('opaque_bytes', `${where}: bytes arguments can't be checked by the address rule`);
    }
    for (const a of abiValuesOfKind(args, 'address')) {
      if (!allowed.has(a.value.toLowerCase())) {
        miss('address_not_allowed', `${where}: ${a.value} is not you or a listed address`);
      }
    }
  }
  if (tx.value > BigInt(chain.maxValueWei)) miss('value_too_high', `Value is over ${chain.maxValueWei} wei`);
  const today = BigInt(usage.valueWeiByChain[String(chainId)] ?? '0');
  if (today + tx.value > BigInt(chain.maxValueWeiPerDay)) {
    miss('daily_value_exceeded', `Daily value limit of ${chain.maxValueWeiPerDay} wei reached`);
  }
  return { ok: true, chain: 'evm', contract: to, function: entry.signature, spend: { chainId, valueWei: tx.value } };
}

// --- EIP-712 ---

function matchTypedData(policy: AutoApprovePolicyV1, data: NormalizedTypedData, self: string): AutoApproveResult {
  let chainId: number | null;
  try {
    chainId = typedDataChainId(data);
  } catch {
    return miss('typed_data_not_listed', 'Typed data domain has no usable chainId');
  }
  if (chainId === null) miss('typed_data_not_listed', 'Typed data domain has no chainId');
  const chain = evmChain(policy, chainId as number);
  const verifyingContract = data.domain.verifyingContract;
  if (typeof verifyingContract !== 'string') {
    miss('typed_data_not_listed', 'Typed data domain has no verifyingContract');
  }
  const vc = verifyingContract as string;
  if (!(chain.typedData ?? []).some((t) => t.verifyingContract === vc && t.primaryType === data.primaryType)) {
    miss('typed_data_not_listed', `${data.primaryType} for ${vc} is not listed`);
  }
  const allowed = evmAllowed(chain, self);
  const structs = new Set(Object.keys(data.types));
  const walk = (t: ParsedTypedDataType, v: TypedDataValue, where: string): void => {
    switch (t.kind) {
      case 'address':
        if (!allowed.has((v as string).toLowerCase())) {
          miss('address_not_allowed', `${where}: ${v as string} is not you or a listed address`);
        }
        return;
      case 'bytes':
        return miss('opaque_bytes', `${where}: bytes fields can't be checked by the address rule`);
      case 'array':
        (v as readonly TypedDataValue[]).forEach((e, i) => walk(t.element, e, `${where}[${i}]`));
        return;
      case 'struct':
        for (const f of data.types[t.name] ?? []) {
          walk(
            parseTypedDataType(f.type, structs),
            (v as TypedDataStruct)[f.name] as TypedDataValue,
            `${where}.${f.name}`,
          );
        }
        return;
      default:
        return;
    }
  };
  walk({ kind: 'struct', name: data.primaryType }, data.message, data.primaryType);
  return { ok: true, chain: 'evm', contract: vc, function: data.primaryType };
}
