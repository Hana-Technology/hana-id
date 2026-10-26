// Hana Embed login: Google sign-in on our page, then a browser-held session key does every signature (no popups).
//
// 1. Make a session key: Ed25519, non-extractable (the private half can be used here but never read out).
// 2. Google's `nonce` = base64url(sha256(public key ++ expiry ++ salt)), so Google's signed ID token vouches for
//    this exact key and expiry.
// 3. hana-signer.create_session checks the token on-chain and records the session. The token is then done with:
//    it's public on-chain, but only authorises a key that never leaves this browser.
// 4. Each signature: the session key signs (counter, sha256(envelope)); the contract checks it and asks the MPC.
import { Buffer } from 'buffer';
import { useCallback, useEffect, useState } from 'react';
import { GOOGLE_CLIENT_ID, NEAR_RPC, RELAYER_ENDPOINT, SESSION, SIGNER_CONTRACT } from './config';

export interface EmbedUser {
  /** Google's user id: with the scope, picks the user's MPC keys. */
  sub: string;
  email: string | null;
  /** MPC derivation path, as the contract recorded it: `{scope}#google#{sub}`. */
  path: string;
  expiresAtMs: number;
  maxSignatures: number;
}

interface StoredSession extends EmbedUser {
  keys: CryptoKeyPair;
  publicKey: number[];
  /** Signatures used so far; the next one carries counter = used + 1. */
  used: number;
}

/** A session being set up: key made, waiting for Google. */
export interface PendingSession {
  keys: CryptoKeyPair;
  publicKey: number[];
  expiresAtMs: number;
  salt: number[];
  nonce: string;
}

// The browser `buffer` polyfill has no 'base64url' encoding: convert from/to plain base64.
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const fromB64url = (text: string) => Buffer.from(text.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** What the contract recomputes: base64url(sha256(public key ++ expiry as u64 LE ++ salt)). */
export async function sessionNonce(publicKey: Uint8Array, expiresAtMs: number, salt: Uint8Array): Promise<string> {
  const expiry = new Uint8Array(8);
  new DataView(expiry.buffer).setBigUint64(0, BigInt(expiresAtMs), true);
  return b64url(await sha256(Uint8Array.from([...publicKey, ...expiry, ...salt])));
}

/** The bytes the session key signs for request `counter`: domain ++ counter (u64 LE) ++ sha256(envelope). */
export async function sessionMessage(counter: number, envelope: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const domain = new TextEncoder().encode('hana-embed-session-v1:');
  const count = new Uint8Array(8);
  new DataView(count.buffer).setBigUint64(0, BigInt(counter), true);
  return Uint8Array.from([...domain, ...count, ...(await sha256(envelope))]);
}

export async function newPendingSession(): Promise<PendingSession> {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const expiresAtMs = Date.now() + SESSION.lifetimeMs;
  return { keys, publicKey: [...publicKey], expiresAtMs, salt: [...salt], nonce: await sessionNonce(publicKey, expiresAtMs, salt) };
}

// ---- Persistence: the CryptoKeyPair is stored as-is (IndexedDB keeps it non-extractable). ----

const DB = 'hana-embed';
const STORE = 'session';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeOp<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = op(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const loadSession = () => storeOp<StoredSession | undefined>('readonly', (s) => s.get('current') as IDBRequest<StoredSession | undefined>).catch(() => undefined);
const saveSession = (session: StoredSession) => storeOp('readwrite', (s) => s.put(session, 'current'));
const clearSession = () => storeOp('readwrite', (s) => s.delete('current')).catch(() => undefined);

// ---- Relayer ----

async function relay<T>(body: Record<string, unknown>): Promise<{ result: T; nearTx?: string }> {
  const res = await fetch(RELAYER_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: { result?: T; nearTx?: string; error?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // Not our JSON: the platform answered (e.g. the function crashed). Show what it said.
  }
  if (!res.ok) throw new Error(json.error ?? `Relayer ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  return { result: json.result as T, nearTx: json.nearTx };
}

/** The contract's view of a session (null once revoked or never opened). */
async function onChainSession(publicKey: number[]): Promise<{ used: number } | null> {
  const args = Buffer.from(JSON.stringify({ session_public_key: publicKey })).toString('base64');
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'embed', method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: SIGNER_CONTRACT, method_name: 'get_session', args_base64: args } }),
  });
  const body = (await res.json()) as { result?: { result?: number[] } };
  if (!body.result?.result) throw new Error('Couldn’t read the session from NEAR');
  return JSON.parse(Buffer.from(body.result.result).toString()) as { used: number } | null;
}

// ---- Google ----

let gisLoaded: Promise<void> | null = null;
function loadGoogle(): Promise<void> {
  gisLoaded ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Couldn’t load Google sign-in'));
    document.head.appendChild(script);
  });
  return gisLoaded;
}

/** Renders Google's sign-in button with the pending session's nonce; calls back with Google's ID token. */
export async function renderGoogleButton(el: HTMLElement, pending: PendingSession, onToken: (jwt: string) => void): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Set VITE_GOOGLE_CLIENT_ID to a Google OAuth web client id');
  await loadGoogle();
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, nonce: pending.nonce, callback: (r) => onToken(r.credential), auto_select: false });
  google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with', width: 320 });
}

const claimsOf = (jwt: string) => JSON.parse(fromB64url(jwt.split('.')[1]!).toString()) as { sub: string; email?: string; nonce?: string };

/** Opens the session on-chain with Google's token. The contract checks Google's signature and the nonce. */
export async function openSession(jwt: string, pending: PendingSession): Promise<EmbedUser> {
  const claims = claimsOf(jwt);
  if (claims.nonce !== pending.nonce) throw new Error('Google returned a token for a different session');
  const { result } = await relay<{ path: string; expires_at_ms: number; max_signatures: number }>({
    method: 'create_session',
    jwt,
    sessionPublicKey: pending.publicKey,
    expiresAtMs: pending.expiresAtMs,
    salt: pending.salt,
    maxSignatures: SESSION.maxSignatures,
    scope: SESSION.scope,
  });
  const session: StoredSession = {
    sub: claims.sub,
    email: claims.email ?? null,
    path: result.path,
    expiresAtMs: result.expires_at_ms,
    maxSignatures: result.max_signatures,
    keys: pending.keys,
    publicKey: pending.publicKey,
    used: 0,
  };
  await saveSession(session);
  return session;
}

/** Signs an envelope with the session: no popup. Returns the MPC's signature and the NEAR tx. */
export async function signWithSession(envelope: number[]): Promise<{ result: unknown; nearTx?: string }> {
  const session = await loadSession();
  if (!session || session.expiresAtMs <= Date.now()) throw new Error('Your session has ended: sign in again');
  if (session.used >= session.maxSignatures) throw new Error('Session signature limit reached: sign in again');
  const counter = session.used + 1;
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', session.keys.privateKey, await sessionMessage(counter, Uint8Array.from(envelope))));
  // Count it before sending: a lost response must not let the same counter be reused for different bytes.
  await saveSession({ ...session, used: counter });
  try {
    return await relay({ method: 'sign_with_session', sessionPublicKey: session.publicKey, counter, signature: [...signature], envelope });
  } catch (err) {
    // The contract may or may not have counted it: take its number so the next signature lines up.
    const chain = await onChainSession(session.publicKey).catch(() => undefined);
    if (chain) await saveSession({ ...session, used: chain.used });
    throw err;
  }
}

/**
 * Full-key mode: asks hana-signer to release this session's key from the MPC (CKD), encrypted to the browser's BLS key
 * (`pk1`, `pk2`). The session key signs that exact key, so the contract won't send the secret anywhere else.
 */
export async function deriveKeyWithSession(pk1: string, pk2: string): Promise<{ result: { big_y: string; big_c: string }; nearTx?: string }> {
  const session = await loadSession();
  if (!session || session.expiresAtMs <= Date.now()) throw new Error('Your session has ended: sign in again');
  if (session.used >= session.maxSignatures) throw new Error('Session limit reached: sign in again');
  const counter = session.used + 1;
  const request = new TextEncoder().encode(`hana-embed-ckd-v1:${pk1}:${pk2}`);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', session.keys.privateKey, await sessionMessage(counter, request)));
  await saveSession({ ...session, used: counter });
  try {
    return await relay({ method: 'derive_key', sessionPublicKey: session.publicKey, counter, signature: [...signature], pk1, pk2 });
  } catch (err) {
    const chain = await onChainSession(session.publicKey).catch(() => undefined);
    if (chain) await saveSession({ ...session, used: chain.used });
    throw err;
  }
}

export async function logout(): Promise<void> {
  const session = await loadSession();
  await clearSession();
  if (!session || session.expiresAtMs <= Date.now()) return;
  const counter = session.used + 1;
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', session.keys.privateKey, await sessionMessage(counter, new TextEncoder().encode('revoke'))));
  // Best effort: the session expires on its own anyway.
  await relay({ method: 'revoke_session', sessionPublicKey: session.publicKey, counter, signature: [...signature] }).catch(() => undefined);
}

/** The signed-in user (a live session in this browser), null, or undefined while loading. */
export function useEmbedUser(): [EmbedUser | null | undefined, (u: EmbedUser | null) => void] {
  const [user, setUser] = useState<EmbedUser | null | undefined>(undefined);
  useEffect(() => {
    loadSession().then((s) => setUser(s && s.expiresAtMs > Date.now() && s.used < s.maxSignatures ? s : null));
  }, []);
  return [user, useCallback((u: EmbedUser | null) => setUser(u), [])];
}
