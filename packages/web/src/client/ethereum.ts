// `hana.ethereum`, the EIP-1193 provider (docs/batch-b-spec.md "EIP-1193"), and its EIP-6963 announcement.
//
// | Method | Behaviour |
// |---|---|
// | eth_requestAccounts | [address]. Logged out: opens the login popup synchronously (call it from a click); if the browser blocks it, the vault's launcher appears and the call resolves after the user clicks it and logs in |
// | eth_accounts | [address] or [] (the vault answers) |
// | eth_chainId, wallet_switchEthereumChain | among `evm.chains`, answered here; an unknown chain is 4902; a test app (pk_test_) switching to a chain outside the testnet list (except a mainnet its vault said the app's demo allows, D428) is 4100 `mainnet_not_allowed` (D39) |
// | eth_sendTransaction | fill (evm-tx.ts) from the current chain's RPC → vault eth_signTransaction (approval) → eth_sendRawTransaction, one at a time per chain; a filled nonce is never below one past the last one broadcast here. A test app on a mainnet chain is refused before anything is filled (4100 `mainnet_not_allowed`; the vault refuses it too) |
// | eth_signTransaction, personal_sign, eth_signTypedData_v4 | the vault, with approval (the transaction is filled first) |
// | eth_sign and other signing or wallet methods | 4200 |
// | read-only methods (READ_ONLY_METHODS) | forwarded to the current chain's rpcUrl |
// | eth_sendRawTransaction | forwarded to the current chain's rpcUrl: it broadcasts what the dapp already signed |
//
// Every signing method opens the approval popup synchronously in the call (D99), before any await: called from a click,
// it opens in that click, as login does; otherwise the vault's launcher is the fallback. eth_sendTransaction and
// eth_signTransaction open it before filling the transaction, so the window is up while the RPC answers.
//
// Errors are ProviderRpcError with numeric codes (errors.ts maps Hana's string codes). Events: `connect {chainId}`
// once the vault is ready, `chainChanged`, `accountsChanged`, and `disconnect` (4900) when the vault connection dies.
// Logging out is `accountsChanged []`, as wallets do, not `disconnect`.
import { ErrorCode, type PortMethod, type PortParamsMap, type PortResultMap, TEST_APP_NETWORK_RULE, isEvmAddress, isTestEvmChain, toHex, utf8 } from '@hana-id/core';
import { Emitter } from './emitter.ts';
import { ProviderRpcError, RpcCode, toProviderRpcError } from './errors.ts';
import { type NormalizedTx, fillTransaction, normalizeTxInput, toQuantity } from './evm-tx.ts';
import type { ApprovalTicket } from './approval-window.ts';
import { HANA_ID_ICON, HANA_ID_NAME } from './icon.ts';
import { type FetchLike, jsonRpc } from './rpc.ts';
import { serviceUrl } from './urls.ts';

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
  /** hana.prepareApproval(): opens the approval popup now, for a request sent after an await. */
  prepareApproval?(): ApprovalTicket;
  fetch: FetchLike;
  /** A pk_test_ app: only the testnet chains of @hana-id/core TEST_EVM_CHAINS can be switched to or sent on. */
  testApp?: boolean;
  /**
   * The mainnet demo: the EVM mainnets this test app's vault said it may use (its `mainnetDemo` event), let
   * through the early check too; the vault still decides each request.
   */
  demoEvmChains?: () => readonly number[];
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
  'eth_syncing',
  'eth_uninstallFilter',
  'net_listening',
  'net_peerCount',
  'net_version',
  'web3_clientVersion',
  'web3_sha3',
]);

/**
 * Validates `evm` config: positive unique chain IDs, RPC URLs by the service-URL rule (http(s); https for a live app
 * unless on loopback), a listed default. Throws TypeError.
 */
export function validateEvmConfig(evm: EvmConfig, live = true): EvmConfig {
  if (typeof evm !== 'object' || evm === null || !Array.isArray(evm.chains) || evm.chains.length === 0) throw new TypeError('evm.chains must be a non-empty array');
  const ids = new Set<number>();
  const chains = evm.chains.map((c, i) => {
    if (typeof c !== 'object' || c === null || !Number.isSafeInteger(c.id) || c.id <= 0) throw new TypeError(`evm.chains[${i}].id must be a positive integer`);
    if (ids.has(c.id)) throw new TypeError(`evm.chains lists chain ${c.id} twice`);
    ids.add(c.id);
    return { id: c.id, rpcUrl: serviceUrl(c.rpcUrl, `evm.chains[${i}].rpcUrl`, live) };
  });
  if (!ids.has(evm.defaultChainId)) throw new TypeError('evm.defaultChainId must be one of evm.chains');
  return { chains, defaultChainId: evm.defaultChainId };
}

const chainHex = (id: number): Hex => `0x${id.toString(16)}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (code: number, message: string, data?: unknown) => new ProviderRpcError(code, message, data);
const noop = () => {};
const nonceKey = (chainId: number, from: string) => `${chainId}:${from.toLowerCase()}`;

/** A validated transaction call, pinned to the signer and chain current when the dapp made it. */
interface TxCall {
  input: NormalizedTx;
  from: string;
  chain: EvmChainConfig;
}

export class HanaEthereumProvider extends Emitter<EthereumEvents> {
  /** Lets dapps and connectors recognise the provider when they read flags. */
  readonly isHanaId = true;
  readonly #host: EthereumHost;
  readonly #chains: ReadonlyMap<number, EvmChainConfig>;
  #chainId: number | null;
  #lastAccounts: string[] = [];
  /**
   * Per chain ID, the settled tail of the eth_sendTransaction queue. Each one fills its nonce from the RPC's 'pending'
   * count only after the one before it was broadcast or failed, so back-to-back sends (approve, then swap) get
   * consecutive nonces instead of the same one.
   */
  readonly #sendQueue = new Map<number, Promise<void>>();
  /**
   * Per `<chainId>:<from>`, one past the highest nonce this provider has broadcast. A filled nonce is never below it:
   * a load-balanced RPC can answer the next 'pending' count from a node that hasn't seen the last broadcast yet.
   */
  readonly #nextNonce = new Map<string, bigint>();

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

  /** The chain IDs of `evm.chains`, in config order (empty without evm config). The Sodax adapter checks against it. */
  get chainIds(): number[] {
    return [...this.#chains.keys()];
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
      case 'eth_sendTransaction':
        return this.#sendTransaction(params);
      case 'eth_signTransaction':
        return (await this.#signTransaction(this.#txCall(params))).raw;
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
      case 'eth_sendRawTransaction':
        // Not a read (sweep PART-6): it broadcasts a transaction the dapp already holds signed, on the current chain.
        // Hana signs nothing here, so it is passed to the RPC as is.
        return this.#rpc(method, Array.isArray(params) ? params : [params]);
      default:
        if (READ_ONLY_METHODS.has(method)) return this.#rpc(method, Array.isArray(params) ? params : [params]);
        throw err(ErrorCode.unsupportedMethod, `Journear Passport does not support ${method}`);
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
    this.#testnetOnly(id, p.chainId);
    const chain = this.#chains.get(id);
    if (!chain) throw err(ErrorCode.chainNotConfigured, `Chain ${p.chainId} is not configured`, { chainId: p.chainId });
    return chain;
  }

  /**
   * A test app's keys come from the testnet MPC: a chain outside the testnet list is refused, unless the app's
   * vault said the mainnet demo lets it use that chain; the vault still decides every request.
   */
  #testnetOnly(id: number, chainId: string = chainHex(id)): void {
    if (this.#host.testApp && !isTestEvmChain(id) && !(this.#host.demoEvmChains?.() ?? []).includes(id)) throw err(ErrorCode.unauthorized, TEST_APP_NETWORK_RULE, { reason: 'mainnet_not_allowed', chainId });
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
    if (mine === null) throw err(ErrorCode.unauthorized, 'Not logged in to Journear Passport');
    if (typeof address !== 'string' || !isEvmAddress(address) || address.toLowerCase() !== mine.toLowerCase()) {
      throw err(ErrorCode.unauthorized, 'The address is not the Journear Passport account');
    }
    return mine;
  }

  /** Checks `[transaction]` and the signer, and pins the current chain. */
  #txCall(params: unknown): TxCall {
    if (!Array.isArray(params) || params.length !== 1) throw err(RpcCode.invalidParams, 'Expected [transaction]');
    const input = normalizeTxInput(params[0]);
    const from = this.#host.evmAddress();
    if (from === null) throw err(ErrorCode.unauthorized, 'Not logged in to Journear Passport');
    const chain = this.#current();
    this.#testnetOnly(chain.id);
    return { input, from, chain };
  }

  /** Fills the transaction from its chain's RPC and has the vault sign it (approval). Returns the raw tx and its nonce. */
  async #signTransaction(call: TxCall): Promise<{ raw: Hex; nonce: bigint }> {
    const { input, from, chain } = call;
    // Before the fill's first await: the approval popup opens in the caller's click (D99).
    const ticket = this.#prepare();
    const minNonce = this.#nextNonce.get(nonceKey(chain.id, from));
    let tx: Awaited<ReturnType<typeof fillTransaction>>;
    try {
      tx = await fillTransaction(input, {
        from,
        chainId: chain.id,
        rpc: (m, p) => jsonRpc(this.#host.fetch, chain.rpcUrl, m, p),
        ...(minNonce !== undefined ? { minNonce } : {}),
      });
    } catch (e) {
      ticket.cancel();
      throw e;
    }
    // The chain may have been switched since the call (while queued or filling): sign only for the chain the dapp
    // asked on, and only while it is still the current one.
    if (this.#chainId !== chain.id) {
      ticket.cancel();
      throw err(RpcCode.invalidParams, 'The chain changed while the transaction was being prepared');
    }
    const raw = await this.#host.request('eth_signTransaction', { tx });
    return { raw, nonce: BigInt(tx.nonce) };
  }

  /** Queues the call behind earlier eth_sendTransaction calls on its chain (see #sendQueue). */
  #sendTransaction(params: unknown): Promise<Hex> {
    const call = this.#txCall(params);
    // Now, in the caller's click, not after the queue ahead of it (D99). A window no request used closes on failure.
    const ticket = this.#prepare();
    const id = call.chain.id;
    const run = (this.#sendQueue.get(id) ?? Promise.resolve()).then(() => this.#signAndBroadcast(call));
    run.catch(() => ticket.cancel());
    const tail = run.then(noop, noop);
    this.#sendQueue.set(id, tail);
    void tail.then(() => {
      if (this.#sendQueue.get(id) === tail) this.#sendQueue.delete(id);
    });
    return run;
  }

  async #signAndBroadcast(call: TxCall): Promise<Hex> {
    const { raw, nonce } = await this.#signTransaction(call);
    // Broadcast on the chain it was filled and signed for, even if the dapp switched chains during the approval:
    // another chain's RPC would refuse it (EIP-155), and the approved transaction would be lost.
    const hash = await jsonRpc(this.#host.fetch, call.chain.rpcUrl, 'eth_sendRawTransaction', [raw]);
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) throw err(RpcCode.internal, 'EVM RPC returned a malformed transaction hash');
    const key = nonceKey(call.chain.id, call.from);
    const next = nonce + 1n;
    if ((this.#nextNonce.get(key) ?? 0n) < next) this.#nextNonce.set(key, next);
    return hash as Hex;
  }

  #prepare(): ApprovalTicket {
    return this.#host.prepareApproval?.() ?? { cancel: noop };
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
    this.emit('disconnect', err(ErrorCode.disconnected, 'The Journear Passport vault is disconnected'));
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
