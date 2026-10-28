// `hana.stellar`, the Stellar signer (docs/batch-b-spec.md "Partner client", "Port methods"): the same call shapes as
// the Stellar Wallets Kit module, so the SWK module, the Sodax adapter and partners use one API.
//
// - getAddress() logs in when needed, with the popup opened synchronously (call it from a click; the vault's launcher
//   is the fallback when the browser blocks it), else asks the vault (silent).
// - signTransaction, signAuthEntry: the network passphrase is the call's, else `stellar.networkPassphrase` from
//   createHana; the vault shows it on the approval screen and binds it into the approval digest.
// - signMessage: SEP-53, approval every time.
// - getNetwork(): from `stellar.networkPassphrase`.
import type { PortMethod, PortParamsMap, PortResultMap } from '@hana-id/core';
import { HanaError, RpcCode } from './errors.ts';

export interface StellarConfig {
  networkPassphrase: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
}

export const STELLAR_NETWORKS: Readonly<Record<string, string>> = {
  'Public Global Stellar Network ; September 2015': 'PUBLIC',
  'Test SDF Network ; September 2015': 'TESTNET',
  'Test SDF Future Network ; October 2022': 'FUTURENET',
};

export interface StellarSignOptions {
  networkPassphrase?: string;
  /** If given, must be the vault's address (4100 otherwise). */
  address?: string;
}

export interface StellarHost {
  stellarAddress(): string | null;
  login(): Promise<{ stellar: string }>;
  request<M extends PortMethod>(method: M, params?: PortParamsMap[M]): Promise<PortResultMap[M]>;
}

export function validateStellarConfig(s: StellarConfig): StellarConfig {
  if (typeof s !== 'object' || s === null || typeof s.networkPassphrase !== 'string' || s.networkPassphrase.length === 0 || s.networkPassphrase.length > 256) {
    throw new TypeError('stellar.networkPassphrase must be a non-empty string');
  }
  for (const k of ['horizonUrl', 'sorobanRpcUrl'] as const) {
    const v = s[k];
    if (v === undefined) continue;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new TypeError(`stellar.${k} must be a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`stellar.${k} must be http(s)`);
  }
  return { ...s };
}

export class HanaStellarSigner {
  readonly #host: StellarHost;
  readonly #config: StellarConfig | undefined;

  constructor(host: StellarHost, config: StellarConfig | undefined) {
    this.#host = host;
    this.#config = config;
  }

  /** `{address}`. Not async up to window.open, so a call from a click keeps the browser's user activation. */
  getAddress(): Promise<{ address: string }> {
    if (this.#host.stellarAddress() === null) return this.#host.login().then((a) => ({ address: a.stellar }));
    return this.#host.request('stellar_getAddress');
  }

  async signTransaction(xdr: string, opts: StellarSignOptions = {}): Promise<{ signedTxXdr: string; signerAddress: string }> {
    return this.#host.request('stellar_signTransaction', withAddress({ xdr, networkPassphrase: this.#passphrase(opts) }, opts));
  }

  async signAuthEntry(preimageXdr: string, opts: StellarSignOptions = {}): Promise<{ signedAuthEntry: string; signerAddress: string }> {
    return this.#host.request('stellar_signAuthEntry', withAddress({ preimageXdr, networkPassphrase: this.#passphrase(opts) }, opts));
  }

  async signMessage(message: string | Uint8Array, opts: Pick<StellarSignOptions, 'address'> = {}): Promise<{ signedMessage: string; signerAddress: string }> {
    return this.#host.request('stellar_signMessage', withAddress({ message }, opts));
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const networkPassphrase = this.#config?.networkPassphrase;
    if (networkPassphrase === undefined) throw new HanaError(RpcCode.invalidParams, 'No Stellar network is configured (createHana({stellar}))');
    return { network: STELLAR_NETWORKS[networkPassphrase] ?? 'CUSTOM', networkPassphrase };
  }

  #passphrase(opts: StellarSignOptions): string {
    const p = opts.networkPassphrase ?? this.#config?.networkPassphrase;
    if (p === undefined) throw new HanaError(RpcCode.invalidParams, 'networkPassphrase is required (pass it, or set createHana({stellar}))');
    return p;
  }
}

function withAddress<T extends object>(params: T, opts: { address?: string }): T & { address?: string } {
  return opts.address === undefined ? params : { ...params, address: opts.address };
}
