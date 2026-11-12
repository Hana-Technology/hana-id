// The persisted vault record (docs/batch-b-spec.md "Record"): IndexedDB `hana-vault` on vaultOrigin (partitioned by
// top-level site), object store `records`, one record per `<signer>|<appId>|<scopeId>|<keyIndex>`, so two apps on one
// scope and one site never see each other's record.
//
//   ct  = AES-GCM(K_s, iv, PRK32, aad)
//   aad = recordAad(signer, appId, path, sessionPk, derivationVersion, ckdKeyHash, parentOrigin, expiresAtMs)
//
// PRK is stored, never S; the BLS scalar `a` never. There is no local wrapping key (Q35): K_s, the server share, is the
// only protection, and the vault zeroes it as soon as it has used it. A record that fails any check is deleted.
//
// The auto-approve consent (docs/batch-b-spec.md "Consent") lives in the same record, AES-GCM-sealed so it can't be
// edited on disk. K_s is gone by the time a consent changes, so its key is derived from PRK (HKDF-SHA-256, info
// "hana-id/vault/consent/v1"; a non-extractable WebCrypto key, never a chain key: the chain keys' info is a borsh tuple
// that starts with a length prefix, never with this text), and its AAD is the record's AAD under its own domain, so a
// consent can't be moved to another record. A consent that fails to open deletes the record like any other tamper.
//
// Record format 2 (docs/identity-token-spec.md "D1 schema, manifest and secrets") adds `walletProofs`: the identity
// token's proofs of the two addresses, made once per session with PRK (vault/identity.ts), so a token refresh while the
// session is dormant needs no PRK. They are not secret (bound to this session key and app). A format-1 record is read
// as is and gets its proofs at its next unlock, which has PRK.
//
// Batch C15 adds an optional plaintext `supportId` (the API's Support ID for the session), in either format. D438 adds
// an optional `sealedEmail`: the issuer's sealed address for this session, which the vault can't open (only the API
// can), kept so a reload still has it for identity tokens and the email sharing sheet; not in the AAD either.
//
// SECURITY: PRK and K_s are full private-key material. Every buffer here is zeroed by its owner; nothing is logged.
import { type Bytes, type WalletProofs, bytesEqual, concatBytes, isSealedEmailText, isSupportId, recordAad, toBytes, utf8 } from '@hana-id/core';
import { proofsMatch } from './identity.ts';
import type { AutoApproveUsage } from '@hana-id/core/policy';

export const DB_NAME = 'hana-vault';
export const STORE_NAME = 'records';
export const DERIVATION_VERSION = 1;
const CONSENT_AAD_DOMAIN = 'hana-id/vault/consent/v1';
const CONSENT_KEY_INFO = 'hana-id/vault/consent/v1';
const IV_BYTES = 12;

export interface RecordAddresses {
  stellar: string;
  evm: string;
}

/** The sealed consent: AES-GCM over the consent JSON. */
export interface SealedConsent {
  iv: Uint8Array;
  ct: Uint8Array;
}

/** The stored record: format 1, or 2 with `walletProofs` (written from now on). */
export interface RecordV1 {
  v: 1 | 2;
  signer: string;
  appId: string;
  path: string;
  scopeId: string;
  keyIndex: number;
  derivationVersion: number;
  ckdKeyHash: Uint8Array;
  parentOrigin: string;
  sessionPk: Uint8Array;
  /** Non-extractable Ed25519, stored as is (signs vault messages). */
  sessionKeyPair: CryptoKeyPair;
  shareId: Uint8Array;
  counter: number;
  iv: Uint8Array;
  ct: Uint8Array;
  addresses: RecordAddresses;
  expiresAtMs: number;
  consent?: SealedConsent;
  /** Format 2: the identity token's wallet proofs for `addresses`, bound to `sessionPk` and `appId`. */
  walletProofs?: WalletProofs;
  /**
   * Batch C15: the user's Support ID as the API sent it with this session (`HANA-XXXX-XXXX`), shown in hana_status and
   * the approval popup after a reload. Not secret and not in the AAD (only displayed: nothing is decided by it), so a
   * record of either format may carry it or not; a malformed one is dropped on read, never a reason to delete the
   * record.
   */
  supportId?: string;
  /**
   * D438: the session's sealed address (`se1.…`, the email issuer's, opened only by the API). Optional in either
   * format; a malformed one is dropped on read, never a reason to delete the record.
   */
  sealedEmail?: string;
}

/** The record format written now. */
export const RECORD_VERSION = 2;

export interface ConsentV1 extends AutoApproveUsage {
  /**
   * The id the API recorded this consent under (32 hex characters, 16 random bytes). Never given to the partner page.
   * Absent on a consent made before registering existed: never honoured, cleared at its first read.
   */
  consentId?: string;
  policyId: string;
  grantedAt: number;
  expiresAtMs: number;
}

export const recordKey = (signer: string, appId: string, scopeId: string, keyIndex: number): string => `${signer}|${appId}|${scopeId}|${keyIndex}`;

// ---- storage ----

// ---- root pins (D263) ----
//
// Beside the record, one small entry per identity this app's vault signed in on this device: the identity key of the
// account root whose path it last derived (after the pairing check passed). A later login whose root changed other
// than by a link activating (own → member) is confirmed on both NEAR providers first (vault/login.ts `checkPin`). It
// outlives a logout on purpose, and holds only identity keys (scope-bound hashes, public in the chain's views), never
// a `sub` or a path.

/** A root pin as stored. */
export interface RootPinRecord {
  v: 1;
  t: 'root-pin';
  /** The root's identity key, 64 hex. */
  root: string;
}

export const rootPinKey = (signer: string, appId: string, scopeId: string, identityKeyHex: string): string => `pin|${signer}|${appId}|${scopeId}|${identityKeyHex}`;

/** The stored pin's root identity key, or null (none, or a value of another shape: ignored, then overwritten). */
export function parseRootPin(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return r.v === 1 && r.t === 'root-pin' && typeof r.root === 'string' && /^[0-9a-f]{64}$/u.test(r.root) ? r.root : null;
}

// ---- the NEAR wallet record's mark (D756) ----
//
// Beside the record, one entry saying the API recorded this session's NEAR account in the wallet directory
// (POST /v1/wallets/record answered `near: true`), so an unlock sends the record only until then: a user who signed in
// before NEAR (or whose record was missed) gets the row at the next unlock, without a call at every page load. Only the
// session public key (public on chain) and a time, never an address. When the API answered `near: false` (migration
// 0019 not applied, the account listed under another user, D762) the entry says `near-deferred` until `untilMs`: no
// unlock resends before then (D763).

export interface NearRecordedMark {
  v: 1;
  t: 'near-recorded' | 'near-deferred';
  /** The session public key, 64 hex. */
  sessionPk: string;
  /** `near-deferred` only: no unlock sends the NEAR record again before this (the vault's clock, ms). */
  untilMs?: number;
}

export const nearRecordedKey = (recordId: string): string => `near|${recordId}`;

/** The entry as stored, or null (none, or a value of another shape). */
export function parseNearRecorded(v: unknown): { sessionPk: string; deferredUntilMs: number | null } | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.sessionPk !== 'string' || !/^[0-9a-f]{64}$/u.test(r.sessionPk)) return null;
  if (r.t === 'near-recorded') return { sessionPk: r.sessionPk, deferredUntilMs: null };
  if (r.t === 'near-deferred' && Number.isSafeInteger(r.untilMs) && (r.untilMs as number) >= 0) return { sessionPk: r.sessionPk, deferredUntilMs: r.untilMs as number };
  return null;
}

/** How long an unlock waits after `near: false` before sending the NEAR record again (D763). */
export const NEAR_RECORD_DEFER_MS = 30 * 60_000;
/** The same after the API said another user lists the account, or this user another one: only a new login changes it. */
export const NEAR_RECORD_CONFLICT_DEFER_MS = 24 * 3_600_000;

/** The object store, as the vault uses it. Every method may throw (storage blocked, quota, private mode). */
export interface RecordStore {
  get(key: string): Promise<unknown>;
  put(key: string, record: RecordV1 | RootPinRecord | NearRecordedMark): Promise<void>;
  delete(key: string): Promise<void>;
}

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/** Opens `hana-vault` (creating `records`). Throws if IndexedDB is missing or blocked. */
export async function openRecordStore(factory: IDBFactory | undefined): Promise<RecordStore> {
  if (!factory) throw new Error('IndexedDB is not available');
  const open = factory.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE_NAME)) open.result.createObjectStore(STORE_NAME);
  };
  const db = await promisify(open);
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = db.transaction(STORE_NAME, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const result = await promisify(op(tx.objectStore(STORE_NAME)));
    await done;
    return result;
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: async (key, record) => {
      await run('readwrite', (s) => s.put(record, key));
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key));
    },
  };
}

// ---- shape ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBytes = (v: unknown, len?: number): v is Uint8Array => v instanceof Uint8Array && (len === undefined || v.length === len);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isKeyPair = (v: unknown): v is CryptoKeyPair =>
  isObj(v) && v.privateKey instanceof CryptoKey && v.publicKey instanceof CryptoKey && (v.privateKey as CryptoKey).extractable === false;

/** The stored value as a RecordV1, or null when its shape is wrong (the caller deletes it). */
export function parseRecord(v: unknown): RecordV1 | null {
  if (!isObj(v) || (v.v !== 1 && v.v !== 2)) return null;
  if (!isStr(v.signer) || !isStr(v.appId) || !isStr(v.path) || !isStr(v.scopeId) || !isStr(v.parentOrigin)) return null;
  if (!Number.isSafeInteger(v.keyIndex) || !Number.isSafeInteger(v.derivationVersion) || !isMs(v.counter) || !isMs(v.expiresAtMs)) return null;
  if (!isBytes(v.ckdKeyHash, 32) || !isBytes(v.sessionPk, 32) || !isBytes(v.shareId, 16) || !isBytes(v.iv, IV_BYTES) || !isBytes(v.ct)) return null;
  if (!isKeyPair(v.sessionKeyPair)) return null;
  if (!isObj(v.addresses) || !isStr(v.addresses.stellar) || !isStr(v.addresses.evm)) return null;
  if (v.consent !== undefined && !(isObj(v.consent) && isBytes(v.consent.iv, IV_BYTES) && isBytes(v.consent.ct))) return null;
  // Format 2 always has proofs, of the record's own addresses; format 1 never has them.
  if (v.v === 2 ? !proofsMatch(v.walletProofs, v.addresses as unknown as RecordAddresses) : v.walletProofs !== undefined) return null;
  let r: Record<string, unknown> = v;
  if (r.supportId !== undefined && !isSupportId(r.supportId)) {
    const { supportId: _dropped, ...rest } = r;
    r = rest;
  }
  if (r.sealedEmail !== undefined && !isSealedEmailText(r.sealedEmail)) {
    const { sealedEmail: _dropped, ...rest } = r;
    r = rest;
  }
  return r as unknown as RecordV1;
}

// ---- PRK under K_s ----

export interface RecordBinding {
  signer: string;
  appId: string;
  path: string;
  sessionPk: Uint8Array;
  derivationVersion: number;
  ckdKeyHash: Uint8Array;
  parentOrigin: string;
  expiresAtMs: number;
}

const aadOf = (b: RecordBinding): Bytes =>
  recordAad({
    signer: b.signer,
    appId: b.appId,
    path: b.path,
    sessionPublicKey: b.sessionPk,
    derivationVersion: b.derivationVersion,
    ckdKeyHash: b.ckdKeyHash,
    parentOrigin: b.parentOrigin,
    expiresAtMs: b.expiresAtMs,
  });

/** Imports `raw` (K_s or PRK) through a copy that is zeroed straight after: importKey keeps its own copy. */
async function importRaw(raw: Uint8Array, algorithm: AlgorithmIdentifier, usage: KeyUsage): Promise<CryptoKey> {
  const bytes = toBytes(raw);
  try {
    return await crypto.subtle.importKey('raw', bytes, algorithm, false, [usage]);
  } finally {
    bytes.fill(0);
  }
}

const aesKey = (raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> => importRaw(raw, { name: 'AES-GCM' }, usage);

/** Encrypts PRK under K_s for the record. The caller zeroes K_s and PRK. */
export async function sealPrk(ks: Uint8Array, prk: Uint8Array, binding: RecordBinding): Promise<{ iv: Bytes; ct: Bytes }> {
  if (ks.length !== 32 || prk.length !== 32) throw new Error('K_s and PRK are 32 bytes');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = toBytes(prk);
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(binding) }, await aesKey(ks, 'encrypt'), plain));
    return { iv, ct };
  } finally {
    plain.fill(0);
  }
}

/** Decrypts the record's PRK with K_s, its AAD built from the record's own fields. Throws on any tamper. */
export async function openPrk(ks: Uint8Array, record: RecordV1): Promise<Bytes> {
  let plain: Bytes;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBytes(record.iv), additionalData: aadOf(record) }, await aesKey(ks, 'decrypt'), toBytes(record.ct)));
  } catch {
    throw new Error('The vault record does not decrypt');
  }
  if (plain.length !== 32) {
    plain.fill(0);
    throw new Error('The vault record does not decrypt');
  }
  return plain;
}

// ---- consent under a PRK-derived key ----

async function consentKey(prk: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const base = await importRaw(prk, 'HKDF', 'deriveKey');
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(CONSENT_KEY_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

const consentAad = (b: RecordBinding): Bytes => concatBytes(utf8(CONSENT_AAD_DOMAIN), aadOf(b));

export async function sealConsent(prk: Uint8Array, binding: RecordBinding, consent: ConsentV1): Promise<SealedConsent> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = utf8(JSON.stringify(consent));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: consentAad(binding) }, await consentKey(prk, 'encrypt'), plain));
  return { iv, ct };
}

const isConsent = (v: unknown): v is ConsentV1 =>
  isObj(v) &&
  (v.consentId === undefined || (typeof v.consentId === 'string' && /^[0-9a-f]{32}$/u.test(v.consentId))) &&
  typeof v.policyId === 'string' &&
  /^[0-9a-f]{64}$/u.test(v.policyId) &&
  isMs(v.grantedAt) &&
  isMs(v.expiresAtMs) &&
  isMs(v.day) &&
  isMs(v.count) &&
  isObj(v.valueWeiByChain) &&
  Object.entries(v.valueWeiByChain).every(([k, w]) => /^[0-9]{1,20}$/u.test(k) && typeof w === 'string' && /^[0-9]{1,78}$/u.test(w));

/** Opens the record's consent. Throws if it was tampered with (the caller deletes the record). */
export async function openConsent(prk: Uint8Array, record: RecordV1): Promise<ConsentV1 | null> {
  if (!record.consent) return null;
  let parsed: unknown;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBytes(record.consent.iv), additionalData: consentAad(record) }, await consentKey(prk, 'decrypt'), toBytes(record.consent.ct));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new Error('The vault consent does not decrypt');
  }
  if (!isConsent(parsed)) throw new Error('The vault consent is malformed');
  return parsed;
}

/** True if two records are the same session (same session key and share): a tab's record wasn't replaced by a newer login. */
export const sameSession = (a: Pick<RecordV1, 'sessionPk' | 'shareId'>, b: Pick<RecordV1, 'sessionPk' | 'shareId'>): boolean =>
  bytesEqual(a.sessionPk, b.sessionPk) && bytesEqual(a.shareId, b.shareId);
