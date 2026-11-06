// The vault's side of the partner identity token (docs/identity-token-spec.md "Minting", "Wallet addresses", "Lifetime,
// refresh and caching"): the wallet proofs made once per session while PRK is in memory, the session proof of a mint,
// and the cache rule. vault.ts runs the flow (lock, cache, broadcast, errors).
//
// SECURITY: the chain keys exist only inside withChainKey, for one signature each, and are zeroed there. The proofs and
// the token are not secret to the vault's partner (the proofs are bound to this session and app; the token is what the
// partner page asks for), but neither is ever logged.
import {
  IDENTITY_NONCE_BYTES,
  IDENTITY_REFRESH_MARGIN_MS,
  type IdentityChain,
  type IdentityTokenBody,
  type WalletProofs,
  identityMessage,
  identityTokenPayload,
  signWalletProof,
  walletProofMessage,
  walletProofsHash,
} from '@hana-id/core';
import { withChainKey } from '@hana-id/core/derivation';

export interface ProofContext {
  signer: string;
  appId: string;
  sessionPublicKey: Uint8Array;
}

/** Both wallet proofs for account 0, made with PRK (each chain key derived for its one signature, then zeroed). */
export function makeWalletProofs(prk: Uint8Array, ctx: ProofContext, addresses: { stellar: string; evm: string }): WalletProofs {
  const proof = (chain: IdentityChain) => ({
    address: addresses[chain],
    signature: withChainKey(prk, chain, 0, (key) => signWalletProof(chain, key, walletProofMessage(ctx, chain, addresses[chain]))),
  });
  return { stellar: proof('stellar'), evm: proof('evm') };
}

/** A copy (the record and the session never share buffers). */
export const copyProofs = (p: WalletProofs): WalletProofs => ({
  stellar: { address: p.stellar.address, signature: Uint8Array.from(p.stellar.signature) },
  evm: { address: p.evm.address, signature: Uint8Array.from(p.evm.signature) },
});

/** True for stored proofs of these addresses with signatures of the right lengths (the API checks the signatures). */
export function proofsMatch(p: unknown, addresses: { stellar: string; evm: string }): p is WalletProofs {
  const w = p as WalletProofs | null;
  return (
    !!w &&
    typeof w === 'object' &&
    w.stellar?.address === addresses.stellar &&
    w.evm?.address === addresses.evm &&
    w.stellar.signature instanceof Uint8Array &&
    w.stellar.signature.length === 64 &&
    w.evm.signature instanceof Uint8Array &&
    w.evm.signature.length === 65
  );
}

/**
 * The POST /v1/identity/token body, signed by the session key over the identity message. `sealedEmail` (D420): the
 * session's sealed address, sent (and covered by the proof) when it has one, so the API can put the shared address in
 * the token.
 */
export async function mintBody(
  privateKey: CryptoKey,
  i: ProofContext & { parentOrigin: string; issuedAtMs: number; proofs: WalletProofs; sealedEmail?: string | null },
): Promise<IdentityTokenBody> {
  const nonce = crypto.getRandomValues(new Uint8Array(IDENTITY_NONCE_BYTES));
  const sealedEmail = i.sealedEmail ?? null;
  const payload = identityTokenPayload({ parentOrigin: i.parentOrigin, walletProofsHash: walletProofsHash(i.proofs), sealedEmail });
  const message = identityMessage({ signer: i.signer, appId: i.appId, sessionPublicKey: i.sessionPublicKey, issuedAtMs: i.issuedAtMs, nonce, payload });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message));
  return {
    sessionPublicKey: Array.from(i.sessionPublicKey),
    issuedAtMs: i.issuedAtMs,
    nonce: Array.from(nonce),
    signature: Array.from(signature),
    walletProofs: {
      stellar: { address: i.proofs.stellar.address, signature: Array.from(i.proofs.stellar.signature) },
      evm: { address: i.proofs.evm.address, signature: Array.from(i.proofs.evm.signature) },
    },
    ...(sealedEmail ? { sealedEmail } : {}),
  };
}

export interface CachedIdentity {
  /** The session the token was minted for (a token of another session is never handed out). */
  sessionPk: Uint8Array;
  token: string;
  iatMs: number;
  expiresAtMs: number;
}

/**
 * Whether a cached token may be handed out at `now`: more than the refresh margin left (5 min, or half its lifetime
 * for a token the session's end made short, so a session ending soon doesn't mint on every call), and, with
 * `maxAgeMs`, minted at most that long ago.
 */
export function cacheUsable(c: CachedIdentity, now: number, maxAgeMs?: number): boolean {
  const margin = Math.min(IDENTITY_REFRESH_MARGIN_MS, (c.expiresAtMs - c.iatMs) / 2);
  return c.expiresAtMs - now > margin && (maxAgeMs === undefined || now - c.iatMs <= maxAgeMs);
}

/** The token's `iat` in ms (the API set it; the vault only reads it, it never trusts a token for anything). */
export function tokenIatMs(token: string): number | null {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (part.length % 4)) % 4))) as { iat?: unknown };
    return Number.isSafeInteger(json.iat) ? (json.iat as number) * 1000 : null;
  } catch {
    return null;
  }
}
