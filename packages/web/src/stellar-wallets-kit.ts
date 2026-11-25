// `@hana-id/web/stellar-wallets-kit`: HanaIdModule, a Stellar Wallets Kit `ModuleInterface` for SWK 1.9.x (the version
// Sodax's wallet-sdk-react uses) and 2.x (docs/batch-b-spec.md "Stellar Wallets Kit module"):
//
//   import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';
//   const kit = new StellarWalletsKit({ network, modules: [new HanaIdModule(hana), ...] });
//
// | Field or method | Value |
// |---|---|
// | moduleType | HOT_WALLET |
// | productId | 'hana-id' ('hana' is already Hana Wallet's module), or the host's `productId` option (D923) |
// | productName, productUrl, productIcon | 'Journear Passport', the env's authOrigin, the Journear mark (data: URI) |
// | isAvailable() | true within 1000 ms when the handshake is done, false otherwise |
// | getAddress() | {address}; logs in if needed, with the launcher fallback when the popup is blocked |
// | signTransaction, signAuthEntry, signMessage | through hana.stellar (approval; synchronous up to it, so the approval popup opens in SWK's click where SWK itself doesn't await first, D99) |
// | getNetwork() | from createHana's stellar.networkPassphrase |
// | disconnect() | hana.logout() |
//
// Errors are SWK's `{code, message, ext?}`: 4001 for a rejection, the Hana string code in `ext`. SWK itself isn't a
// dependency: the shapes below are structural copies of both versions' interfaces.
import type { HanaClient } from './client/client.ts';
import { HanaError, RpcCode, toSwkError } from './client/errors.ts';
import { HANA_ID_ICON, HANA_ID_NAME } from './client/icon.ts';

export const HANA_ID_MODULE_ID = 'hana-id';
/**
 * The id a host that matches wallets by substring should pass as `productId` (D923): `'hana-id'` contains "hana", so
 * Sodax's wallet kit's brand calls for Hana Wallet (`['hana']`) catch it. The default stays `'hana-id'`: hosts and
 * partner code that stored or named it keep working.
 */
export const JOURNEAR_PASSPORT_MODULE_ID = 'journear-passport';
/** A `productId` option: lower-case letters and digits, single `-` or `.` between them, 3 to 64 characters. */
const PRODUCT_ID_PATTERN = /^(?=.{3,64}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** Ids that name Hana Wallet (the browser extension) in the kits we know of; never ours. */
const OTHER_WALLET_IDS: readonly string[] = ['hana', 'io.hana.wallet'];

export interface HanaIdModuleOptions {
  /**
   * The module's `productId`, which the kit and its host use as the wallet's id (and may store, to restore the user's
   * choice). Default `'hana-id'`. Pick it once: changing it later makes returning users choose the wallet again in
   * hosts that stored the old id. Use `JOURNEAR_PASSPORT_MODULE_ID` in a host that finds Hana Wallet by "hana".
   */
  productId?: string;
}
/** SWK's `ModuleType.HOT_WALLET` (the same string in 1.9.x and 2.x). */
export const HOT_WALLET = 'HOT_WALLET';
export const IS_AVAILABLE_TIMEOUT_MS = 1000;

export interface SwkSignOptions {
  networkPassphrase?: string;
  address?: string;
  /** Hardware-wallet derivation path: not used by Hana ID. */
  path?: string;
  /** SWK's "submit after signing": Hana ID only signs, so `true` is refused. */
  submit?: boolean;
  submitUrl?: string;
}

/** Wraps a call so every failure is SWK's error shape. */
const swk = <T>(p: () => Promise<T>): Promise<T> => {
  let promise: Promise<T>;
  try {
    promise = p();
  } catch (e) {
    return Promise.reject(toSwkError(e));
  }
  return promise.catch((e: unknown) => {
    throw toSwkError(e);
  });
};

export class HanaIdModule {
  /**
   * SWK's `ModuleType` is a TypeScript string enum, which no literal type is assignable to, so the field is typed
   * `any` to fit both kits' `ModuleInterface`; its value is always 'HOT_WALLET'.
   */
  readonly moduleType: any = HOT_WALLET;
  readonly productId: string;
  readonly productName = HANA_ID_NAME;
  readonly productUrl: string;
  readonly productIcon = HANA_ID_ICON;
  readonly #hana: HanaClient;

  constructor(hana: HanaClient, options: HanaIdModuleOptions = {}) {
    const productId = options.productId ?? HANA_ID_MODULE_ID;
    if (typeof productId !== 'string' || !PRODUCT_ID_PATTERN.test(productId) || OTHER_WALLET_IDS.includes(productId)) {
      throw new HanaError(RpcCode.invalidParams, 'productId must be 3 to 64 lower-case letters, digits, "-" or "." and not another wallet\'s id');
    }
    this.#hana = hana;
    this.productId = productId;
    this.productUrl = hana.authOrigin;
  }

  isAvailable(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), IS_AVAILABLE_TIMEOUT_MS);
      this.#hana.ready.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  /** Not async up to window.open, so SWK's click handler keeps the browser's user activation where it can. */
  getAddress(_params?: { path?: string }): Promise<{ address: string }> {
    return swk(() => this.#hana.stellar.getAddress());
  }

  signTransaction(xdr: string, opts: SwkSignOptions = {}): Promise<{ signedTxXdr: string; signerAddress: string }> {
    return swk(async () => {
      if (opts.submit === true) throw new HanaError(RpcCode.invalidParams, 'Journear Passport only signs; submit the signed transaction yourself');
      return this.#hana.stellar.signTransaction(xdr, pick(opts));
    });
  }

  signAuthEntry(authEntry: string, opts: SwkSignOptions = {}): Promise<{ signedAuthEntry: string; signerAddress: string }> {
    return swk(() => this.#hana.stellar.signAuthEntry(authEntry, pick(opts)));
  }

  signMessage(message: string, opts: SwkSignOptions = {}): Promise<{ signedMessage: string; signerAddress: string }> {
    return swk(() => this.#hana.stellar.signMessage(message, opts.address === undefined ? {} : { address: opts.address }));
  }

  getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    return swk(() => this.#hana.stellar.getNetwork());
  }

  disconnect(): Promise<void> {
    return swk(() => this.#hana.logout());
  }
}

function pick(opts: SwkSignOptions): { networkPassphrase?: string; address?: string } {
  const out: { networkPassphrase?: string; address?: string } = {};
  if (opts.networkPassphrase !== undefined) out.networkPassphrase = opts.networkPassphrase;
  if (opts.address !== undefined) out.address = opts.address;
  return out;
}
