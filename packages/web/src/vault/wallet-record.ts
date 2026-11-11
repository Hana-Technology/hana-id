// The vault's side of the wallet directory (D310 point 3, D317): after a login succeeded and its key passed the
// pairing check, the wallet's two addresses (three with NEAR's, D755: an SDK of 0.4.0 or later and an API whose GET
// /v1/app lists `near` in `walletChains`; also once at an unlock until the API said it recorded NEAR for this session)
// go to `POST /v1/wallets/record`, each signed by its own chain key over the
// record statement (@hana-id/core wallet-record.ts) for the session's path, and the whole request signed by the
// session key (only this vault holds it): the active path, so a linked member's login reports its account root's
// wallet.
//
// Never in front of the user and never in the login's way: the body is signed on a 0 ms timer right after the login's
// result is on its way, only while that session is still the vault's (PRK is in memory then; each chain key is derived
// for one signature inside withChainKey and zeroed), and the call
// is started without being awaited. It is sent once, with no retry (a missed record is written at the next login: the
// rows are upserts), and given up after WALLET_RECORD_TIMEOUT_MS. Any failure, a refusal or an outage, is dropped
// silently. Only addresses and signatures leave the vault, never a key.
import {
  WALLET_RECORD_TIMEOUT_MS,
  type WalletRecordBody,
  type WalletRecordChain,
  type WalletRecordContext,
  signWalletRecord,
  signWalletRecordSession,
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

/**
 * The records for account 0 (Stellar and EVM, and NEAR when `addresses.near` is given), signed with PRK (each chain key
 * for its one signature, then zeroed), and the whole request signed by the session key (`sessionPrivateKey`, the
 * session's non-extractable WebCrypto key): without that signature anyone could pair their own address's proof with
 * this session's public key (D311, amended). With NEAR the session signature covers the v2 proofs hash (D755).
 */
export async function signWalletRecords(prk: Uint8Array, sessionPrivateKey: CryptoKey, ctx: WalletRecordContext, addresses: { stellar: string; evm: string; near?: string }): Promise<WalletRecordSigned> {
  const proof = (chain: WalletRecordChain, address: string) => ({
    address,
    signature: withChainKey(prk, chain, 0, (key) => signWalletRecord(chain, key, walletRecordStatement(ctx, chain, address))),
  });
  // Every chain key is used (and zeroed) before the first await: PRK is read only while the caller checked it live.
  const proofs = { stellar: proof('stellar', addresses.stellar), evm: proof('evm', addresses.evm), ...(addresses.near !== undefined ? { near: proof('near', addresses.near) } : {}) };
  const evmDigest = walletRecordEvmDigest(ctx, addresses.evm);
  const sessionSignature = await signWalletRecordSession(sessionPrivateKey, ctx, proofs);
  const wire = (p: { address: string; signature: Uint8Array }) => ({ address: p.address, signature: Array.from(p.signature) });
  return {
    body: {
      sessionPublicKey: Array.from(ctx.sessionPublicKey),
      issuedAtMs: ctx.issuedAtMs,
      path: ctx.path,
      wallets: { stellar: wire(proofs.stellar), evm: wire(proofs.evm), ...(proofs.near ? { near: wire(proofs.near) } : {}) },
      sessionSignature: Array.from(sessionSignature),
    },
    evmDigest,
  };
}

/**
 * Sends the record once: resolves (never rejects) with the API's answer, or null when the call failed or
 * WALLET_RECORD_TIMEOUT_MS passed (the request is aborted then). The caller must not await it in a login.
 */
export function reportWallets(send: (body: WalletRecordBody, signal: AbortSignal) => Promise<unknown>, body: WalletRecordBody, timers: Timers): Promise<unknown> {
  const ctl = new AbortController();
  const timer = timers.setTimeout(() => ctl.abort(), WALLET_RECORD_TIMEOUT_MS);
  return Promise.resolve()
    .then(() => send(body, ctl.signal))
    .then(
      (answer) => answer ?? null,
      () => null,
    )
    .finally(() => timers.clearTimeout(timer));
}

/** True when the API's answer says it recorded the NEAR account (`near: true`, D756). */
export const nearRecordedIn = (answer: unknown): boolean => typeof answer === 'object' && answer !== null && (answer as { near?: unknown }).near === true;

/** The API's `nearCode` when it answered `near: false` (D762, D763), `unknown` for another value, or null otherwise. */
export function nearRefusedIn(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null || (answer as { near?: unknown }).near !== false) return null;
  const code = (answer as { nearCode?: unknown }).nearCode;
  return typeof code === 'string' && /^[a-z0-9_]{1,40}$/u.test(code) ? code : 'unknown';
}
