// createSodaxEvmProvider: a Sodax `IEvmWalletProvider` (@sodax/types 2.1.0) over `hana.ethereum`, one per spoke chain
// (docs/batch-b-spec.md "Sodax adapter"):
//
//   const base = createSodaxEvmProvider(hana, { chainId: 8453, rpcUrl });   // 8453 must be in createHana's evm.chains
//   sodax.swaps.swap({ ..., walletProvider: base });
//
// | Member | Behaviour |
// |---|---|
// | chainType | 'EVM' |
// | (creation) | throws 4902 if `chainId` isn't in the client's `evm.chains` |
// | getWalletAddress() | eth_requestAccounts: logs in if needed (call it from a click; the launcher is the fallback) |
// | sendTransaction(rawTx) | the SDK's one-argument call `{from, to, value: bigint, data}`, no chain ID: `from` must be the vault's address (4100); pins hana.ethereum to the bound chain, then eth_sendTransaction (fill from the chain's RPC, sign with approval, broadcast) |
// | waitForTransactionReceipt(hash) | polls this provider's `rpcUrl` (eth_getTransactionReceipt) every 2 s for up to 180 s; number fields stringified |
//
// hana.ethereum has one current chain, and eth_sendTransaction pins the chain current when it is called. The adapters
// of one client therefore send one at a time (a per-client queue), each switching to its chain first, so providers
// for two spoke chains never sign for each other's chain. A partner page that switches chains while a transaction is
// being filled still gets hana.ethereum's refusal ("The chain changed…") rather than a transaction on the wrong chain.
//
// Sodax calls carry the user's intent in opaque bytes, so in batch B every one goes through the approval popup (Q42).
import { ErrorCode, isEvmAddress } from '@hana-id/core';
import type { HanaClient } from '@hana-id/web';
import { HanaError, RpcCode } from '@hana-id/web';
import type { Address, EvmRawLog, EvmRawTransaction, EvmRawTransactionReceipt, Hash, IEvmWalletProvider } from '@sodax/types';
import { httpUrl, invalid, isObject, jsonRpc, sleep } from './http.ts';

export const EVM_RECEIPT_POLL_MS = 2_000;
/** viem's waitForTransactionReceipt default, which Sodax's own EvmWalletProvider uses. */
export const EVM_RECEIPT_TIMEOUT_MS = 180_000;

export interface SodaxEvmConfig {
  /** The spoke chain this provider signs for; one of createHana's `evm.chains`. */
  chainId: number;
  /** That chain's RPC, for receipts (filling and broadcasting use createHana's `evm.chains` RPC). */
  rpcUrl: string;
}

/** What the adapter needs from the client: `hana.ethereum` and the logged-in addresses. */
export type SodaxEvmHana = Pick<HanaClient, 'ethereum' | 'addresses'>;

const HASH = /^0x[0-9a-fA-F]{64}$/u;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;
const UINT256_MAX = (1n << 256n) - 1n;

/** Per hana.ethereum, the settled tail of the adapters' sends (see the header). */
const sendQueues = new WeakMap<object, Promise<void>>();
const noop = () => {};

const chainHex = (id: number): `0x${string}` => `0x${id.toString(16)}`;

export function createSodaxEvmProvider(hana: SodaxEvmHana, config: SodaxEvmConfig): IEvmWalletProvider {
  if (!isObject(hana) || !isObject(hana.ethereum)) throw new TypeError('createSodaxEvmProvider takes the Hana client (createHana)');
  if (!isObject(config)) throw new TypeError('createSodaxEvmProvider takes {chainId, rpcUrl}');
  const { chainId } = config;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError('chainId must be a positive integer');
  const rpcUrl = httpUrl(config.rpcUrl, 'rpcUrl');
  const eth = hana.ethereum;
  const target = chainHex(chainId);
  if (!eth.chainIds.includes(chainId)) {
    throw new HanaError(ErrorCode.chainNotConfigured, `Chain ${chainId} is not in createHana's evm.chains`, { chainId: target });
  }

  const send = async (tx: { from: string; to: string; value: string; data: string }): Promise<Hash> => {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
    // eth_sendTransaction pins the chain current at this call, synchronously: check it is still ours right before.
    if (eth.chainId !== target) throw new HanaError(RpcCode.internal, 'The chain changed before the transaction was sent');
    return (await eth.request({ method: 'eth_sendTransaction', params: [tx] })) as Hash;
  };

  const sendTransaction = (evmRawTx: EvmRawTransaction): Promise<Hash> => {
    let tx: { from: string; to: string; value: string; data: string };
    try {
      tx = checkRawTx(evmRawTx, hana.addresses?.evm ?? null);
    } catch (e) {
      return Promise.reject(e);
    }
    const run = (sendQueues.get(eth) ?? Promise.resolve()).then(() => send(tx));
    const tail = run.then(noop, noop);
    sendQueues.set(eth, tail);
    void tail.then(() => {
      if (sendQueues.get(eth) === tail) sendQueues.delete(eth);
    });
    return run;
  };

  const waitForTransactionReceipt = async (txHash: Hash): Promise<EvmRawTransactionReceipt> => {
    if (typeof txHash !== 'string' || !HASH.test(txHash)) throw invalid('waitForTransactionReceipt takes a transaction hash (0x + 64 hex characters)');
    const deadline = Date.now() + EVM_RECEIPT_TIMEOUT_MS;
    let lastError: string | null = null;
    for (;;) {
      let receipt: unknown = null;
      try {
        receipt = await jsonRpc(rpcUrl, 'eth_getTransactionReceipt', [txHash], 'EVM RPC', Math.max(1, Math.min(deadline - Date.now(), EVM_RECEIPT_POLL_MS * 5)));
        lastError = null;
      } catch (e) {
        // A node or network fault says nothing about the transaction: keep polling until the deadline.
        lastError = e instanceof Error ? e.message : 'EVM RPC error';
      }
      if (receipt !== null && receipt !== undefined) return serializeReceipt(receipt, txHash);
      if (Date.now() + EVM_RECEIPT_POLL_MS > deadline) break;
      await sleep(EVM_RECEIPT_POLL_MS);
    }
    throw new HanaError(RpcCode.internal, `Transaction ${txHash} has no receipt on chain ${chainId} after ${EVM_RECEIPT_TIMEOUT_MS / 1000} s`, {
      reason: 'receipt_timeout',
      hash: txHash,
      chainId: target,
      ...(lastError === null ? {} : { lastError }),
    });
  };

  return Object.freeze({
    chainType: 'EVM' as const,
    // Not async up to window.open, so a call from a click keeps the browser's user activation.
    getWalletAddress: (): Promise<Address> =>
      eth.request({ method: 'eth_requestAccounts' }).then((accounts) => {
        const a = Array.isArray(accounts) ? accounts[0] : undefined;
        if (typeof a !== 'string' || !isEvmAddress(a)) throw new HanaError(RpcCode.internal, 'hana.ethereum returned no account');
        return a as Address;
      }),
    sendTransaction,
    waitForTransactionReceipt,
  });
}

/** The SDK's raw transaction as an EIP-1193 transaction, after checking it and that `from` is the vault's address. */
function checkRawTx(raw: EvmRawTransaction, vault: string | null): { from: string; to: string; value: string; data: string } {
  if (!isObject(raw)) throw invalid('sendTransaction takes {from, to, value: bigint, data}');
  const { from, to, value, data } = raw as Record<string, unknown>;
  if (typeof from !== 'string' || !isEvmAddress(from)) throw invalid('rawTx.from must be an address');
  if (vault === null) throw new HanaError(ErrorCode.unauthorized, 'Not logged in to Hana ID');
  if (from.toLowerCase() !== vault.toLowerCase()) throw new HanaError(ErrorCode.unauthorized, 'rawTx.from is not the Hana ID account');
  // Sodax never creates contracts through a wallet provider: `to` is always a contract or token address.
  if (typeof to !== 'string' || !isEvmAddress(to)) throw invalid('rawTx.to must be an address');
  if (typeof value !== 'bigint' || value < 0n || value > UINT256_MAX) throw invalid('rawTx.value must be a uint256 bigint');
  if (typeof data !== 'string' || !HEX_DATA.test(data)) throw invalid('rawTx.data must be 0x hex bytes');
  return { from: vault, to, value: `0x${value.toString(16)}`, data };
}

// ---- receipts ----

/** viem's transaction type names (what Sodax's own EvmWalletProvider returns); an unknown type stays as hex. */
const TX_TYPES: Readonly<Record<string, string>> = { '0x0': 'legacy', '0x1': 'eip2930', '0x2': 'eip1559', '0x3': 'eip4844', '0x4': 'eip7702' };

const malformed = (what: string) => new HanaError(RpcCode.internal, `EVM RPC returned a malformed receipt (${what})`);

/** A `0x` quantity field as a decimal string. */
function decimal(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== 'string' || !QUANTITY.test(v)) throw malformed(key);
  return BigInt(v).toString(10);
}

const hexOrNull = (r: Record<string, unknown>, key: string, pattern: RegExp): string | null => {
  const v = r[key];
  if (v === null) return null;
  if (typeof v !== 'string' || !pattern.test(v)) throw malformed(key);
  return v;
};

function serializeLog(l: unknown): EvmRawLog {
  if (!isObject(l)) throw malformed('logs');
  if (typeof l.address !== 'string' || !isEvmAddress(l.address)) throw malformed('log address');
  if (!Array.isArray(l.topics) || !l.topics.every((t) => typeof t === 'string' && HASH.test(t))) throw malformed('log topics');
  if (typeof l.data !== 'string' || !HEX_DATA.test(l.data)) throw malformed('log data');
  return {
    address: l.address as Address,
    topics: l.topics as EvmRawLog['topics'],
    data: l.data as Hash,
    blockHash: hexOrNull(l, 'blockHash', HASH) as Hash | null,
    blockNumber: hexOrNull(l, 'blockNumber', QUANTITY) as Hash | null,
    logIndex: hexOrNull(l, 'logIndex', QUANTITY) as Hash | null,
    transactionHash: hexOrNull(l, 'transactionHash', HASH) as Hash | null,
    transactionIndex: hexOrNull(l, 'transactionIndex', QUANTITY) as Hash | null,
    removed: l.removed === true,
  };
}

/**
 * The RPC receipt in Sodax's shape (EvmRawTransactionReceipt), as Sodax's own EvmWalletProvider serialises viem's:
 * quantities (transactionIndex, blockNumber, cumulativeGasUsed, gasUsed, effectiveGasPrice, and the blob fields when
 * present) as decimal strings, `status` 'success' or 'reverted', `type` by name. Logs keep the RPC's `0x` hex, which is
 * what the type declares for them. Other fields the node returns pass through.
 */
function serializeReceipt(receipt: unknown, txHash: string): EvmRawTransactionReceipt {
  if (!isObject(receipt)) throw malformed('not an object');
  if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) throw malformed('transactionHash');
  if (typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash)) throw malformed('blockHash');
  if (typeof receipt.from !== 'string' || !isEvmAddress(receipt.from)) throw malformed('from');
  if (receipt.to !== null && (typeof receipt.to !== 'string' || !isEvmAddress(receipt.to))) throw malformed('to');
  const contractAddress = receipt.contractAddress ?? null;
  if (contractAddress !== null && (typeof contractAddress !== 'string' || !isEvmAddress(contractAddress))) throw malformed('contractAddress');
  if (!Array.isArray(receipt.logs)) throw malformed('logs');
  if (typeof receipt.logsBloom !== 'string' || !HEX_DATA.test(receipt.logsBloom)) throw malformed('logsBloom');
  const out: Record<string, unknown> = {
    ...receipt,
    transactionIndex: decimal(receipt, 'transactionIndex'),
    blockNumber: decimal(receipt, 'blockNumber'),
    cumulativeGasUsed: decimal(receipt, 'cumulativeGasUsed'),
    gasUsed: decimal(receipt, 'gasUsed'),
    contractAddress,
    logs: receipt.logs.map(serializeLog),
  };
  for (const key of ['effectiveGasPrice', 'blobGasUsed', 'blobGasPrice']) if (receipt[key] !== undefined) out[key] = decimal(receipt, key);
  if (receipt.status !== undefined) {
    if (receipt.status !== '0x1' && receipt.status !== '0x0') throw malformed('status');
    out.status = receipt.status === '0x1' ? 'success' : 'reverted';
  }
  if (receipt.type !== undefined) {
    if (typeof receipt.type !== 'string' || !QUANTITY.test(receipt.type)) throw malformed('type');
    out.type = TX_TYPES[receipt.type] ?? receipt.type;
  }
  return out as unknown as EvmRawTransactionReceipt;
}
