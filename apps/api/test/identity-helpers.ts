// Helpers for the identity token tests: a vault's mint body (session proof and wallet proofs), and a verifier of the
// answer (ES256 against the API's own JWKS, as a partner's `jose` would do it).
import { deriveAddresses, withChainKey } from '@hana-id/core/derivation';
import { type IdentityChain, identityMessage, identityTokenPayload, signWalletProof, walletProofMessage, walletProofsHash } from '@hana-id/core/identity';
import { env } from 'cloudflare:workers';
import { base64UrlDecode } from '../src/bytes.ts';
import { ORIGIN, call, sessionKeyPair } from './helpers.ts';
import { vaultHeaders } from './vault-helpers.ts';

export const randomPrk = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export interface MintOptions {
  parent?: string;
  issuedAtMs?: number;
  /** The wallets' PRK (default: a fresh one per call). */
  prk?: Uint8Array;
  /** Sign the session proof for this app id / signer instead of the real ones. */
  signAsApp?: string;
  signAsSigner?: string;
  /** Make the wallet proofs for this session key / app (default: the minting session and app). */
  proofSpk?: number[];
  proofApp?: string;
  sealedEmail?: string;
  /** Changes the body after signing (shape tests, swapped proofs). */
  mutate?: (body: Record<string, unknown>) => void;
  /** Signs the session proof with this key instead of the session key's (another key). */
  signWith?: number[];
  /** Sends the EVM address lowercased (the proofs and the session proof cover it as sent). */
  lowercaseEvm?: boolean;
  /** A fixed proof nonce (16 bytes), e.g. to replay a proof's (key, time, nonce) with another signature. */
  nonce?: Uint8Array;
}

export function walletProofs(prk: Uint8Array, ctx: { signer: string; appId: string; sessionPublicKey: Uint8Array }): Record<IdentityChain, { address: string; signature: number[] }> {
  const addresses = deriveAddresses(prk);
  const proof = (chain: IdentityChain) => ({
    address: addresses[chain],
    signature: [...withChainKey(prk, chain, 0, (key) => signWalletProof(chain, key, walletProofMessage(ctx, chain, addresses[chain])))],
  });
  return { stellar: proof('stellar'), evm: proof('evm') };
}

/** A POST /v1/identity/token body for session key `spk` (a test key from newSessionKey), signed as the vault signs it. */
export async function mintBody(app: { id: string }, spk: number[], o: MintOptions = {}): Promise<Record<string, unknown>> {
  const prk = o.prk ?? randomPrk();
  const sessionPublicKey = Uint8Array.from(spk);
  const proofs = walletProofs(prk, { signer: env.SIGNER_ACCOUNT, appId: o.proofApp ?? app.id, sessionPublicKey: Uint8Array.from(o.proofSpk ?? spk) });
  if (o.lowercaseEvm) proofs.evm.address = proofs.evm.address.toLowerCase();
  const nonce = o.nonce ?? crypto.getRandomValues(new Uint8Array(16));
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const hashed = { stellar: { address: proofs.stellar.address, signature: Uint8Array.from(proofs.stellar.signature) }, evm: { address: proofs.evm.address, signature: Uint8Array.from(proofs.evm.signature) } };
  const payload = identityTokenPayload({ parentOrigin: o.parent ?? ORIGIN, walletProofsHash: walletProofsHash(hashed), sealedEmail: o.sealedEmail ?? null });
  const message = identityMessage({ signer: o.signAsSigner ?? env.SIGNER_ACCOUNT, appId: o.signAsApp ?? app.id, sessionPublicKey, issuedAtMs, nonce, payload });
  const signature = [...sessionKeyPair(o.signWith ?? spk).sign(message).signature];
  const body: Record<string, unknown> = { sessionPublicKey: spk, issuedAtMs, nonce: [...nonce], signature, walletProofs: proofs, ...(o.sealedEmail ? { sealedEmail: o.sealedEmail } : {}) };
  o.mutate?.(body);
  return body;
}

export async function mint(app: { id: string; key: string }, spk: number[], o: MintOptions & { env?: Partial<typeof env>; headers?: Record<string, string>; exec?: ExecutionContext } = {}): Promise<Response> {
  return call('/v1/identity/token', { headers: { ...vaultHeaders(app, o.parent ?? ORIGIN), ...o.headers }, body: await mintBody(app, spk, o), env: o.env, exec: o.exec });
}

export interface Decoded {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

const decodePart = (p: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(base64UrlDecode(p))) as Record<string, unknown>;

/** Verifies `token` (ES256) against the API's JWKS and returns its parts; throws when it doesn't verify. */
export async function verifyToken(token: string, bindings: Partial<typeof env> = {}): Promise<Decoded> {
  const [h, c, s] = token.split('.') as [string, string, string];
  const header = decodePart(h);
  const res = await call('/v1/identity/jwks.json', { method: 'GET', env: bindings });
  const { keys } = (await res.json()) as { keys: { kid: string; x: string; y: string }[] };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid not in the JWKS');
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64UrlDecode(s), new TextEncoder().encode(`${h}.${c}`));
  if (!ok) throw new Error('signature does not verify');
  return { header, claims: decodePart(c) };
}

export const publishedKids = (): string[] => (JSON.parse(env.IDENTITY_PUBLIC_KEYS!) as { kid: string }[]).map((k) => k.kid);

/**
 * Sets a RateLimiter object's sliding window bucket for `now` (subject as `limiter()` names it) to `count`, or deletes
 * it with null: fills a ceiling without thousands of requests, and empties it again for the next test.
 */
export async function setSlidingBucket(subject: string, name: string, windowMs: number, count: number | null, now = Date.now()): Promise<void> {
  const { runInDurableObject } = await import('cloudflare:test');
  const { limiter } = await import('../src/handlers.ts');
  const start = Math.floor(now / windowMs) * windowMs;
  await runInDurableObject(limiter(env, subject), (_i, state) => {
    for (const at of [start, start - windowMs]) {
      const key = `slide:${name}@${at}`;
      if (count === null || at !== start) state.storage.kv.delete(key);
      else state.storage.kv.put(key, count);
    }
  });
}

/** The keys a RateLimiter object holds (`mark:` markers, `slide:` buckets, fixed windows). */
export async function limiterKeys(subject: string): Promise<string[]> {
  const { runInDurableObject } = await import('cloudflare:test');
  const { limiter } = await import('../src/handlers.ts');
  return runInDurableObject(limiter(env, subject), (_i, state) => [...state.storage.kv.list()].map(([k]) => k));
}
