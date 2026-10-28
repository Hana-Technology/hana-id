// `hana.ethereum`, the EIP-1193 provider (docs/batch-b-spec.md "EIP-1193"), and its EIP-6963 announcement.
//
// | Method | Behaviour |
// |---|---|
// | eth_requestAccounts | [address]. Logged out: opens the login popup synchronously (call it from a click); if the browser blocks it, the vault's launcher appears and the call resolves after the user clicks it and logs in |
// | eth_accounts | [address] or [] (the vault answers) |
// | eth_chainId, wallet_switchEthereumChain | among `evm.chains`, answered here; an unknown chain is 4902 |
// | eth_sendTransaction | fill (evm-tx.ts) from the current chain's RPC → vault eth_signTransaction (approval) → eth_sendRawTransaction |
// | eth_signTransaction, personal_sign, eth_signTypedData_v4 | the vault, with approval (the transaction is filled first) |
// | eth_sign and other signing or wallet methods | 4200 |
// | read-only methods (READ_ONLY_METHODS) | forwarded to the current chain's rpcUrl |
//
// Errors are ProviderRpcError with numeric codes (errors.ts maps Hana's string codes). Events: `connect {chainId}`
// once the vault is ready, `chainChanged`, `accountsChanged`, and `disconnect` (4900) when the vault connection dies.
// Logging out is `accountsChanged []`, as wallets do, not `disconnect`.
import { ErrorCode, type PortMethod, type PortParamsMap, type PortResultMap, isEvmAddress, toHex, utf8 } from '@hana-id/core';
import { Emitter } from './emitter.ts';
import { ProviderRpcError, RpcCode, toProviderRpcError } from './errors.ts';
import { fillTransaction, normalizeTxInput, toQuantity } from './evm-tx.ts';
import { HANA_ID_ICON, HANA_ID_NAME } from './icon.ts';
import { type FetchLike, jsonRpc } from './rpc.ts';

type Hex = `0x${string}`;

export interface EvmChainConfig {
  id: number;
  rpcUrl: string;
}

export interface EvmConfig {
  chains: EvmChainConfig[];
  defaultChainId: number;
}

export interface RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

export interface ProviderConnectInfo {
  readonly chainId: Hex;
}

export interface EthereumEvents {
  connect: [ProviderConnectInfo];
  disconnect: [ProviderRpcError];
  chainChanged: [Hex];
  accountsChanged: [string[]];
}

/** What the provider needs from the client. */
export interface EthereumHost {
  /** The vault's EVM address while logged in, else null. */
  evmAddress(): string | null;
  /** hana.login(): opens the popup synchronously. */
  login(): Promise<{ evm: string }>;
  request<M extends PortMethod>(method: M, params?: PortParamsMap[M]): Promise<PortResultMap[M]>;
  fetch: FetchLike;
}

/** Methods with no side effect on the user's account, forwarded to the chain RPC as they are. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'eth_blobBaseFee',
  'eth_blockNumber',
  'eth_call',
  'eth_createAccessList',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getUncleByBlockHashAndIndex',
  'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash',
  'eth_getUncleCountByBlockNumber',
  'eth_maxPriorityFeePerGas',
  'eth_newBlockFilter',
  'eth_newFilter',
  'eth_newPendingTransactionFilter',
  'eth_protocolVersion',
  'eth_sendRawTransaction',
  'eth_syncing',
  'eth_uninstallFilter',
  'net_listening',
  'net_peerCount',
  'net_version',
  'web3_clientVersion',
  'web3_sha3',
]);

/** Validates `evm` config: positive unique chain IDs, http(s) RPC URLs, a listed default. Throws TypeError. */
export function validateEvmConfig(evm: EvmConfig): EvmConfig {
  if (typeof evm !== 'object' || evm === null || !Array.isArray(evm.chains) || evm.chains.length === 0) throw new TypeError('evm.chains must be a non-empty array');
  const ids = new Set<number>();
  const chains = evm.chains.map((c, i) => {
    if (typeof c !== 'object' || c === null || !Number.isSafeInteger(c.id) || c.id <= 0) throw new TypeError(`evm.chains[${i}].id must be a positive integer`);
    if (ids.has(c.id)) throw new TypeError(`evm.chains lists chain ${c.id} twice`);
    ids.add(c.id);
    let url: URL;
    try {
      url = new URL(c.rpcUrl);
    } catch {
      throw new TypeError(`evm.chains[${i}].rpcUrl must be a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`evm.chains[${i}].rpcUrl must be http(s)`);
    return { id: c.id, rpcUrl: c.rpcUrl };
  });
  if (!ids.has(evm.defaultChainId)) throw new TypeError('evm.defaultChainId must be one of evm.chains');
  return { chains, defaultChainId: evm.defaultChainId };
}

const chainHex = (id: number): Hex => `0x${id.toString(16)}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (code: number, message: string, data?: unknown) => new ProviderRpcError(code, message, data);

export class HanaEthereumProvider extends Emitter<EthereumEvents> {
  /** Lets dapps and connectors recognise the provider when they read flags. */
  readonly isHanaId = true;
  readonly #host: EthereumHost;
  readonly #chains: ReadonlyMap<number, EvmChainConfig>;
  #chainId: number | null;
  #lastAccounts: string[] = [];

  constructor(host: EthereumHost, evm: EvmConfig | undefined) {
    super();
    this.#host = host;
    this.#chains = new Map((evm?.chains ?? []).map((c) => [c.id, c]));
    this.#chainId = evm?.defaultChainId ?? null;
  }

  /** The current chain as `0x` hex, or null when no EVM chain is configured. */
  get chainId(): Hex | null {
    return this.#chainId === null ? null : chainHex(this.#chainId);
  }

  request(args: RequestArguments): Promise<unknown> {
    if (!isObject(args) || typeof args.method !== 'string' || args.method.length === 0) {
      return Promise.reject(err(RpcCode.invalidParams, 'request() takes {method, params?}'));
    }
    const params = (args.params ?? []) as unknown;
    // Synchronous up to window.open, so a call from a click keeps the browser's user activation.
    if (args.method === 'eth_requestAccounts') return this.#requestAccounts();
    return this.#dispatch(args.method, params).catch((e: unknown) => {
      throw toProviderRpcError(e);
    });
  }

  #requestAccounts(): Promise<string[]> {
    const address = this.#host.evmAddress();
    if (address !== null) return Promise.resolve([address]);
    return this.#host.login().then(
      (a) => [a.evm],
      (e: unknown) => {
        throw toProviderRpcError(e);
      },
    );
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'eth_accounts':
        return this.#host.request('eth_accounts');
      case 'eth_chainId':
        return chainHex(this.#current().id);
      case 'wallet_switchEthereumChain':
        return this.#switchChain(params);
      case 'wallet_addEthereumChain':
        // Only the partner's configured chains exist here: "adding" one of them is a no-op, anything else is 4902.
        this.#chainParam(params);
        return null;
      case 'eth_sendTransaction': {
        const raw = await this.#signTransaction(params);
        const hash = await this.#rpc('eth_sendRawTransaction', [raw]);
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) throw err(RpcCode.internal, 'EVM RPC returned a malformed transaction hash');
        return hash;
      }
      case 'eth_signTransaction':
        return this.#signTransaction(params);
      case 'personal_sign': {
        if (!Array.isArray(params) || params.length < 2 || typeof params[0] !== 'string') throw err(RpcCode.invalidParams, 'personal_sign takes [message, address]');
        const address = this.#own(params[1]);
        // As other wallets do: a 0x hex string is the message bytes, anything else is UTF-8 text.
        const message: Hex = /^0x(?:[0-9a-fA-F]{2})*$/u.test(params[0]) ? (params[0] as Hex) : `0x${toHex(utf8(params[0]))}`;
        return this.#host.request('personal_sign', [message, address]);
      }
      case 'eth_signTypedData_v4': {
        if (!Array.isArray(params) || params.length !== 2) throw err(RpcCode.invalidParams, 'eth_signTypedData_v4 takes [address, typedData]');
        const address = this.#own(params[0]);
        const typed = typeof params[1] === 'string' ? params[1] : isObject(params[1]) ? JSON.stringify(params[1]) : null;
        if (typed === null) throw err(RpcCode.invalidParams, 'typedData must be a JSON string or object');
        return this.#host.request('eth_signTypedData_v4', [address, typed]);
      }
      default:
        if (READ_ONLY_METHODS.has(method)) return this.#rpc(method, Array.isArray(params) ? params : [params]);
        throw err(ErrorCode.unsupportedMethod, `Hana ID does not support ${method}`);
    }
  }

  #current(): EvmChainConfig {
    const chain = this.#chainId === null ? undefined : this.#chains.get(this.#chainId);
    if (!chain) throw err(ErrorCode.chainNotConfigured, 'No EVM chain is configured (createHana({evm}))');
    return chain;
  }

  #chainParam(params: unknown): EvmChainConfig {
    const p = Array.isArray(params) ? params[0] : undefined;
    if (!isObject(p) || typeof p.chainId !== 'string') throw err(RpcCode.invalidParams, 'Expected [{chainId}]');
    let id: number;
    try {
      const n = BigInt(toQuantity(p.chainId, 'chainId'));
      id = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : -1;
    } catch {
      throw err(RpcCode.invalidParams, 'chainId must be a 0x hex quantity');
    }
    const chain = this.#chains.get(id);
    if (!chain) throw err(ErrorCode.chainNotConfigured, `Chain ${p.chainId} is not configured`, { chainId: p.chainId });
    return chain;
  }

  #switchChain(params: unknown): null {
    const chain = this.#chainParam(params);
    if (chain.id !== this.#chainId) {
      this.#chainId = chain.id;
      this.emit('chainChanged', chainHex(chain.id));
    }
    return null;
  }

  /** `address` must be the vault's (any case); returns the vault's form. */
  #own(address: unknown): string {
    const mine = this.#host.evmAddress();
    if (mine === null) throw err(ErrorCode.unauthorized, 'Not logged in to Hana ID');
    if (typeof address !== 'string' || !isEvmAddress(address) || address.toLowerCase() !== mine.toLowerCase()) {
      throw err(ErrorCode.unauthorized, 'The address is not the Hana ID account');
    }
    return mine;
  }

  async #signTransaction(params: unknown): Promise<Hex> {
    if (!Array.isArray(params) || params.length !== 1) throw err(RpcCode.invalidParams, 'Expected [transaction]');
    const input = normalizeTxInput(params[0]);
    const from = this.#host.evmAddress();
    if (from === null) throw err(ErrorCode.unauthorized, 'Not logged in to Hana ID');
    const chain = this.#current();
    const tx = await fillTransaction(input, { from, chainId: chain.id, rpc: (m, p) => jsonRpc(this.#host.fetch, chain.rpcUrl, m, p) });
    // The chain may have been switched while filling: sign only for the chain the fields were filled on.
    if (this.#chainId !== chain.id) throw err(RpcCode.invalidParams, 'The chain changed while the transaction was being prepared');
    return this.#host.request('eth_signTransaction', { tx });
  }

  #rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    return jsonRpc(this.#host.fetch, this.#current().rpcUrl, method, params);
  }

  // ---- called by the client ----

  /** The vault became ready. */
  connected(): void {
    if (this.#chainId !== null) this.emit('connect', { chainId: chainHex(this.#chainId) });
  }

  /** The vault's addresses changed (null: logged out). Emits only on a change. */
  accountsChanged(evm: string | null): void {
    const next = evm === null ? [] : [evm];
    if (next.length === this.#lastAccounts.length && next.every((a, i) => a === this.#lastAccounts[i])) return;
    this.#lastAccounts = next;
    this.emit('accountsChanged', next);
  }

  /** The vault connection died. */
  disconnected(): void {
    this.accountsChanged(null);
    this.emit('disconnect', err(ErrorCode.disconnected, 'The Hana vault is disconnected'));
  }
}

// ---- EIP-6963 ----

export interface Eip6963ProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

/**
 * The provider's `rdns`: the reverse-DNS name of the env's authOrigin host (Q26 is open until the production domain,
 * Q15, is chosen; deriving it from a host Hana controls keeps it truthful meanwhile).
 */
export function rdnsFor(authOrigin: string): string {
  return new URL(authOrigin).hostname.split('.').reverse().join('.');
}

/**
 * Announces `provider` (`eip6963:announceProvider`) now and on every `eip6963:requestProvider`. Returns the function
 * that stops re-announcing. The uuid is a fresh v4 per client, as EIP-6963 asks.
 */
export function announceEip6963(win: Window, provider: HanaEthereumProvider, rdns: string): () => void {
  const info: Eip6963ProviderInfo = Object.freeze({ uuid: crypto.randomUUID(), name: HANA_ID_NAME, icon: HANA_ID_ICON, rdns });
  const detail = Object.freeze({ info, provider });
  const announce = () => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  win.addEventListener('eip6963:requestProvider', announce);
  announce();
  return () => win.removeEventListener('eip6963:requestProvider', announce);
}
