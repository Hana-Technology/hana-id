// The vault's side of the wallet directory (D310 point 3, D317): after a login succeeded and its key passed the
// pairing check, the wallet's two addresses go to `POST /v1/wallets/record`, each signed by its own chain key over the
// record statement (@hana-id/core wallet-record.ts) for the session's path: the active path, so a linked member's
// login reports its account root's wallet.
//
// Never in front of the user and never in the login's way: the body is signed in the same turn as the login's result
// (PRK is in memory then; each chain key is derived for one signature inside withChainKey and zeroed), and the call
// is started without being awaited. It is sent once, with no retry (a missed record is written at the next login: the
// rows are upserts), and given up after WALLET_RECORD_TIMEOUT_MS. Any failure, a refusal or an outage, is dropped
// silently. Only addresses and signatures leave the vault, never a key.
import {
  WALLET_RECORD_TIMEOUT_MS,
  type WalletRecordBody,
  type WalletRecordChain,
  type WalletRecordContext,
  signWalletRecord,
  walletRecordEvmDigest,
  walletRecordStatement,
} from '@hana-id/core';
import { withChainKey } from '@hana-id/core/derivation';
import type { Timers } from './runtime.ts';

export interface WalletRecordSigned {
  body: WalletRecordBody;
  /** The EVM record's digest: a raw EVM request for it is refused for this session (signing.ts, D179). */
  evmDigest: Uint8Array;
}

/** Both records for account 0, signed with PRK (each chain key for its one signature, then zeroed). */
export function signWalletRecords(prk: Uint8Array, ctx: WalletRecordContext, addresses: { stellar: string; evm: string }): WalletRecordSigned {
  const record = (chain: WalletRecordChain) => ({
    address: addresses[chain],
    signature: Array.from(withChainKey(prk, chain, 0, (key) => signWalletRecord(chain, key, walletRecordStatement(ctx, chain, addresses[chain])))),
  });
  return {
    body: { sessionPublicKey: Array.from(ctx.sessionPublicKey), issuedAtMs: ctx.issuedAtMs, path: ctx.path, wallets: { stellar: record('stellar'), evm: record('evm') } },
    evmDigest: walletRecordEvmDigest(ctx, addresses.evm),
  };
}

/**
 * Sends the record once and forgets it: resolves (never rejects) when the API answered, the call failed, or
 * WALLET_RECORD_TIMEOUT_MS passed (the request is aborted then). The caller must not await it in a login.
 */
export function reportWallets(send: (body: WalletRecordBody, signal: AbortSignal) => Promise<unknown>, body: WalletRecordBody, timers: Timers): Promise<void> {
  const ctl = new AbortController();
  const timer = timers.setTimeout(() => ctl.abort(), WALLET_RECORD_TIMEOUT_MS);
  return Promise.resolve()
    .then(() => send(body, ctl.signal))
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => timers.clearTimeout(timer));
}
