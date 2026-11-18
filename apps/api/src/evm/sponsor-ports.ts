// The two things EVM gas sponsorship's handlers (evm/sponsor.ts, D847) talk to: the relayer Durable Object (`EvmRelayer`,
// apps/api/src/evm-relayer.ts, D851: `send`, `status` and `lookup`, its types and its error convention) and the chain
// (`SponsorChain`, evm/sponsor-chain.ts: ONE trusted read endpoint). The handlers reach them only through
// `sponsorPorts`, so tests replace both with fakes (put back from DEFAULT_SPONSOR_PORTS).
//
// SECURITY: nothing here logs a URL (a keyed RPC URL from the secret EVM_SPONSOR_RPC_<chainId> carries a provider key),
// a key, a signature or an address. RPC failures are EvmRpcError with a fixed message; the handlers answer them as
// `502 evm_rpc_unavailable` and never echo a node's error text.
import { keccak_256 } from '@noble/hashes/sha3';
import type { Env } from '../env.ts';
import { type EvmRejectionCause, type EvmRelayerErrorCode, type EvmRelayerLookup, type EvmRelayerSendAnswer, type EvmRelayerSendRequest, type EvmRelayerSent, type EvmRelayerStatus, evmRelayerError, evmRelayerName } from '../evm-relayer.ts';
import { type EvmReceipt, type Hex, type SponsorChain, sponsorChainFor } from './sponsor-chain.ts';
import type { EvmSponsorChainConfig } from './sponsor-config.ts';

export type { EvmRejectionCause, EvmRelayerLookup, EvmRelayerSendAnswer, EvmRelayerSendRequest, EvmRelayerSent, EvmRelayerStatus, Hex };
export { EvmRpcError } from './sponsor-chain.ts';

/** The relayer object's RPC methods the handlers call (nothing here reaches its staff tools). */
export interface EvmRelayerPort {
  /** A coded refusal comes back as `{ok: false, refused, reason}` (nothing sent); anything thrown is unknown. */
  send(req: EvmRelayerSendRequest): Promise<EvmRelayerSendAnswer>;
  status(): Promise<EvmRelayerStatus>;
  lookup(digest: Hex): Promise<EvmRelayerLookup | null>;
}

export type RelayerRefusalCode = EvmRelayerErrorCode;

/**
 * A relayer refusal's code and reason (`Error('evm_relayer:<code>[:<reason>]')`: this call sent nothing), or null for
 * any other failure (an object reset, an unreachable stub): then nothing is known about whether it sent. The relayer's
 * own `evmRelayerError`.
 */
export const relayerRefusal = (err: unknown): { code: RelayerRefusalCode; reason: string | null } | null => evmRelayerError(err);

/**
 * The relayer for `chainId`, or null when the Worker has no EVM_RELAYER binding (sponsorship is then unconfigured).
 * Named exactly `evm-relayer-<chainId>-0`, never with a location suffix (placement.ts): the object holds the relayer's
 * nonce sequence, so a second object for the same key would hand out the same nonces.
 */
function relayerFromBinding(env: Env, chainId: number): EvmRelayerPort | null {
  const ns = env.EVM_RELAYER;
  if (!ns) return null;
  return ns.get(ns.idFromName(evmRelayerName(chainId))) as unknown as EvmRelayerPort;
}

/** The `EVM_RELAYER` binding, or undefined. */
export const relayerBinding = (env: Env): Env["EVM_RELAYER"] => env.EVM_RELAYER;

/** The chain reads the handlers make (SponsorChain's methods; `read` for a block's timestamp). */
export type SponsorChainPort = Pick<SponsorChain, 'code' | 'transactionCount' | 'balance' | 'latestBlock' | 'call' | 'receipt' | 'read'>;
export type SponsorReceipt = EvmReceipt;

/**
 * The revert an `eth_call` failure is, with its data (null when the node gave none, e.g. out of gas), or null when it is
 * a node failure (EvmRpcError's `kind`, `rpcCode`, `nodeMessage`, `data`).
 */
export function revertOf(err: unknown): { revertData: Hex | null } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { kind?: unknown; rpcCode?: unknown; nodeMessage?: unknown; data?: unknown };
  if (e.kind !== 'rpc_error') return null;
  const message = typeof e.nodeMessage === 'string' ? e.nodeMessage : '';
  if (e.rpcCode !== 3 && !/revert|out of gas|invalid opcode|gas required exceeds|stack underflow|invalid jump/iu.test(message)) return null;
  const data = typeof e.data === 'string' && /^0x([0-9a-fA-F]{2})*$/u.test(e.data) && e.data.length <= 2 + 4096 ? (e.data.toLowerCase() as Hex) : null;
  return { revertData: data };
}

/** A block's timestamp (unix seconds), for the billing record. */
export function blockTimestamp(chain: SponsorChainPort, blockNumber: bigint): Promise<bigint> {
  return chain.read('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false], (r) => {
    const t = (r as { timestamp?: unknown } | null)?.timestamp;
    if (typeof t !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u.test(t)) throw new Error('not a timestamp');
    return BigInt(t);
  });
}

/** The chain's client (evm/sponsor-chain.ts sponsorChainFor: the keyed secret endpoint, else `rpc`). */
const chainFromConfig = (env: Env, chain: Readonly<EvmSponsorChainConfig>): SponsorChainPort => sponsorChainFor(env, chain);

// ---- The seam ----

/** How the handlers reach the relayer and the chain. Tests replace these (and put them back); nothing else does. */
export const sponsorPorts: {
  relayer: (env: Env, chainId: number) => EvmRelayerPort | null;
  chain: (env: Env, chain: Readonly<EvmSponsorChainConfig>) => SponsorChainPort;
} = { relayer: relayerFromBinding, chain: chainFromConfig };

export const DEFAULT_SPONSOR_PORTS = Object.freeze({ relayer: relayerFromBinding, chain: chainFromConfig });

/** keccak256 of bytes given as `0x` hex, as `0x` hex (a signed transaction's hash). */
export function keccakHex(hex: Hex): Hex {
  const s = hex.slice(2);
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return `0x${Array.from(keccak_256(bytes), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
