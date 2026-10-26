// Full-key mode: the user's keys are released once per session by NEAR CKD and then sign in this browser.
// POC: kept in sessionStorage so a reload doesn't need another CKD call. NOT production: any script on the page can
// read them (production: wrap with a non-extractable WebCrypto key or a passkey, see docs/hana-embed-ckd-results.md).
import { Buffer } from 'buffer';
import { Keypair } from '@stellar/stellar-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { deriveKeyWithSession, type EmbedUser } from './auth';
import { ckdAppId, decryptCkd, deriveChainKeys, newAppKey } from './ckd';
import { SIGNER_CONTRACT } from './config';
import { ckdNetworkKey } from './mpc';

const KEY = 'embed.ckd.keys';

export interface LocalKeys {
  stellar: Keypair;
  evmPrivateKey: Hex;
  evmAddress: Hex;
}

interface Stored {
  path: string;
  expiresAtMs: number;
  evmPrivateKey: Hex;
  stellarSeed: string;
}

function toKeys(evmPrivateKey: Hex, stellarSeed: Uint8Array): LocalKeys {
  return { stellar: Keypair.fromRawEd25519Seed(Buffer.from(stellarSeed)), evmPrivateKey, evmAddress: privateKeyToAccount(evmPrivateKey).address };
}

/** This session's keys if they were already released in this tab. */
export function loadLocalKeys(user: EmbedUser): LocalKeys | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Stored | null;
    if (!stored || stored.path !== user.path || stored.expiresAtMs !== user.expiresAtMs) return null;
    return toKeys(stored.evmPrivateKey, Uint8Array.from(Buffer.from(stored.stellarSeed, 'hex')));
  } catch {
    return null;
  }
}

export function clearLocalKeys(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

/** Step 1: one CKD call through hana-signer; returns the encrypted response and what's needed to open it. */
export async function requestKey() {
  const app = newAppKey();
  const { pk1, pk2 } = app.publicKey.AppPublicKeyPV;
  const [{ result, nearTx }, networkKey] = await Promise.all([deriveKeyWithSession(pk1, pk2), ckdNetworkKey()]);
  return { response: result, a: app.a, networkKey, nearTx };
}

/** Step 2: decrypt, check the pairing, derive the chain keys and keep them for this session. */
export function openKey(user: EmbedUser, req: Awaited<ReturnType<typeof requestKey>>): LocalKeys {
  const secret = decryptCkd(req.response, req.a, ckdAppId(SIGNER_CONTRACT, user.path), req.networkKey);
  const derived = deriveChainKeys(secret);
  secret.fill(0);
  const stored: Stored = { path: user.path, expiresAtMs: user.expiresAtMs, evmPrivateKey: derived.evmPrivateKey, stellarSeed: Buffer.from(derived.stellarSeed).toString('hex') };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Without storage the keys live in memory only; a reload releases them again.
  }
  return toKeys(derived.evmPrivateKey, derived.stellarSeed);
}
