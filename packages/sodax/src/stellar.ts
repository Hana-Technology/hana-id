// createSodaxStellarProvider: a Sodax `IStellarWalletProvider` (@sodax/types 2.1.0) over `hana.stellar`
// (docs/batch-b-spec.md "Sodax adapter"):
//
//   const stellar = createSodaxStellarProvider(hana, { networkPassphrase: Networks.PUBLIC, horizonUrl, sorobanRpcUrl });
//   sodax.swaps.swap({ ..., walletProvider: stellar });
//
// | Member | Behaviour |
// |---|---|
// | chainType | 'STELLAR' |
// | getWalletAddress() | hana.stellar.getAddress(): logs in if needed (call it from a click; the launcher is the fallback) |
// | signTransaction(xdr, {address?}) | hana.stellar.signTransaction with this provider's passphrase (approval); the signed envelope XDR. Fee-bump envelopes are signed as given. `address`, if passed, must be the vault's (4100) |
// | sendTransaction(signedXdr) | Soroban RPC `sendTransaction`; the hash when PENDING or DUPLICATE, an error for ERROR and TRY_AGAIN_LATER |
// | signAndSendTransaction(rawTx) | sendTransaction(signTransaction(rawTx.data, {address: rawTx.from})) |
// | waitForTransactionReceipt(hash) | polls Horizon `GET /transactions/{hash}` every 2 s for 60 s; its JSON |
//
// Sodax swaps carry the user's intent in opaque `Bytes` arguments, so in batch B every one of them goes through the
// approval popup (no protocol decoder, Q42). A swap that needs several signatures (`restoreFootprint`, then the call
// again with the next sequence number; a trustline first) runs through one popup: it stays open 15 s for the next.
import type { HanaClient } from '@hana-id/web';
import { HanaError, RpcCode } from '@hana-id/web';
import type { IStellarWalletProvider, StellarRawTransaction, StellarRawTransactionReceipt, XDR } from '@sodax/types';
import { getJson, httpUrl, invalid, isObject, jsonRpc, sleep } from './http.ts';

export const STELLAR_RECEIPT_POLL_MS = 2_000;
export const STELLAR_RECEIPT_TIMEOUT_MS = 60_000;

export interface SodaxStellarConfig {
  /** The network the provider signs for (Sodax: `Public Global Stellar Network ; September 2015`). */
  networkPassphrase: string;
  /** Horizon, for receipts. */
  horizonUrl: string;
  /** Soroban RPC, for sendTransaction. */
  sorobanRpcUrl: string;
}

/** What the adapter needs from the client: `hana.stellar`. */
export type SodaxStellarHana = Pick<HanaClient, 'stellar'>;

/** `IStellarWalletProvider` with its optional broadcast methods present. */
export type SodaxStellarProvider = IStellarWalletProvider & Required<Pick<IStellarWalletProvider, 'sendTransaction' | 'signAndSendTransaction'>>;

const TX_HASH = /^[0-9a-fA-F]{64}$/u;

export function createSodaxStellarProvider(hana: SodaxStellarHana, config: SodaxStellarConfig): SodaxStellarProvider {
  if (!isObject(hana) || !isObject(hana.stellar)) throw new TypeError('createSodaxStellarProvider takes the Hana client (createHana)');
  if (!isObject(config)) throw new TypeError('createSodaxStellarProvider takes {networkPassphrase, horizonUrl, sorobanRpcUrl}');
  const { networkPassphrase } = config;
  if (typeof networkPassphrase !== 'string' || networkPassphrase.length === 0 || networkPassphrase.length > 256) {
    throw new TypeError('networkPassphrase must be a non-empty string');
  }
  const horizon = httpUrl(config.horizonUrl, 'horizonUrl');
  const sorobanRpcUrl = httpUrl(config.sorobanRpcUrl, 'sorobanRpcUrl');
  // A base with a path (https://host/horizon) keeps it: resolve against it with a trailing slash.
  const horizonBase = horizon.endsWith('/') ? horizon : `${horizon}/`;
  const signer = hana.stellar;

  const signTransaction = async (tx: XDR, options?: { address?: string }): Promise<XDR> => {
    if (typeof tx !== 'string' || tx.length === 0) throw invalid('signTransaction takes a transaction envelope XDR (base64)');
    const address = isObject(options) ? options.address : undefined;
    if (address !== undefined && typeof address !== 'string') throw invalid('options.address must be a Stellar address');
    const { signedTxXdr } = await signer.signTransaction(tx, address === undefined ? { networkPassphrase } : { networkPassphrase, address });
    return signedTxXdr;
  };

  const sendTransaction = async (signedTx: XDR): Promise<string> => {
    if (typeof signedTx !== 'string' || signedTx.length === 0) throw invalid('sendTransaction takes a signed transaction envelope XDR (base64)');
    const r = await jsonRpc(sorobanRpcUrl, 'sendTransaction', { transaction: signedTx }, 'Soroban RPC');
    if (!isObject(r) || typeof r.status !== 'string' || typeof r.hash !== 'string' || !TX_HASH.test(r.hash)) {
      throw new HanaError(RpcCode.internal, 'Soroban RPC returned a malformed sendTransaction result');
    }
    const hash = r.hash.toLowerCase();
    switch (r.status) {
      case 'PENDING':
      case 'DUPLICATE':
        return hash;
      case 'TRY_AGAIN_LATER':
        // Not accepted: the node is congested. The signed envelope is still good until its time bound; resending is safe.
        throw new HanaError(RpcCode.internal, 'Soroban RPC did not accept the transaction (TRY_AGAIN_LATER); send it again', { status: r.status, hash });
      case 'ERROR': {
        const errorResultXdr = typeof r.errorResultXdr === 'string' ? r.errorResultXdr.slice(0, 4096) : undefined;
        throw new HanaError(RpcCode.internal, 'Soroban RPC refused the transaction', errorResultXdr === undefined ? { status: r.status, hash } : { status: r.status, hash, errorResultXdr });
      }
      default:
        throw new HanaError(RpcCode.internal, 'Soroban RPC returned an unknown sendTransaction status', { status: r.status.slice(0, 64), hash });
    }
  };

  const signAndSendTransaction = async (params: StellarRawTransaction): Promise<string> => {
    if (!isObject(params) || typeof params.data !== 'string') throw invalid('signAndSendTransaction takes {from, to, value, data: XDR}');
    // `from` is the account the transaction was built for: the vault refuses to sign it as anyone else (4100).
    const from = typeof params.from === 'string' && params.from.length > 0 ? params.from : undefined;
    return sendTransaction(await signTransaction(params.data, from === undefined ? undefined : { address: from }));
  };

  const waitForTransactionReceipt = async (txHash: string): Promise<StellarRawTransactionReceipt> => {
    if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) throw invalid('waitForTransactionReceipt takes a transaction hash (64 hex characters)');
    const hash = txHash.toLowerCase();
    const url = new URL(`transactions/${hash}`, horizonBase).href;
    const deadline = Date.now() + STELLAR_RECEIPT_TIMEOUT_MS;
    let lastStatus = 0;
    for (;;) {
      const r = await getJson(url, Math.max(1, Math.min(deadline - Date.now(), STELLAR_RECEIPT_POLL_MS * 5)));
      if (r.ok) return horizonReceipt(r.json, hash);
      lastStatus = r.status;
      // 404: not in a ledger yet. 0 (network, timeout), 429 and 5xx are transient. Anything else won't change.
      if (r.status !== 404 && r.status !== 0 && r.status !== 429 && r.status < 500) {
        throw new HanaError(RpcCode.internal, `Horizon returned HTTP ${r.status} for transaction ${hash}`, { status: r.status, hash });
      }
      if (Date.now() + STELLAR_RECEIPT_POLL_MS > deadline) break;
      await sleep(STELLAR_RECEIPT_POLL_MS);
    }
    throw new HanaError(RpcCode.internal, `Transaction ${hash} was not found on Horizon within ${STELLAR_RECEIPT_TIMEOUT_MS / 1000} s`, {
      reason: 'receipt_timeout',
      hash,
      lastStatus,
    });
  };

  return Object.freeze({
    chainType: 'STELLAR' as const,
    // Not async up to window.open, so a call from a click keeps the browser's user activation.
    getWalletAddress: (): Promise<string> => signer.getAddress().then((r) => r.address),
    signTransaction,
    sendTransaction,
    signAndSendTransaction,
    waitForTransactionReceipt,
  });
}

/** Horizon's transaction JSON, checked to be the one asked for; `_links.transaction` defaults to `_links.self`. */
function horizonReceipt(json: unknown, hash: string): StellarRawTransactionReceipt {
  if (!isObject(json) || typeof json.hash !== 'string' || json.hash.toLowerCase() !== hash || !isObject(json._links) || typeof json.successful !== 'boolean') {
    throw new HanaError(RpcCode.internal, 'Horizon returned a malformed transaction', { hash });
  }
  const links = json._links;
  return { ...json, _links: { ...links, transaction: links.transaction ?? links.self } } as unknown as StellarRawTransactionReceipt;
}
