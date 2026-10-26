// Request shape checks (as the legacy relayer did). The contract re-checks everything; these reject junk before it
// costs gas, and make sure only allowlisted methods with well-formed arguments are ever relayed.
import type { ContractCall } from './near/tx.ts';

export const MAX_JWT = 7168;
export const MAX_BODY = 16 * 1024;
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerated between us and the chain when checking expiry windows. */
const SKEW_MS = 5 * 60 * 1000;
export const MAX_USES = 500;

type Obj = Record<string, unknown>;
export type Checked<T> = T | { error: string };
export const isError = <T>(v: Checked<T>): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBytes = (v: unknown, min: number, max: number): v is number[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isU32 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
const isU64 = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isJwt = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_JWT && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(v);
const isPoint = (v: unknown, prefix: string): v is string => typeof v === 'string' && v.startsWith(prefix) && v.length < 300;
/** Provider names and `sub` must not contain `#` (it separates path parts). */
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;
// Limits as in docs/contract-interface.md.
const isProvider = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/u.test(v);
const isSub = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && utf8Len(v) <= 255 && !v.includes('#');
const isAud = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && utf8Len(v) <= 256;
const isScopeId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,64}$/u.test(v);
const isAccountId = (v: unknown): v is string =>
  typeof v === 'string' && /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u.test(v);

/** Exactly these keys (optional ones may be absent or null). */
function onlyKeys(o: Obj, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((k) => k in o) && Object.keys(o).every((k) => allowed.has(k));
}

// ---- App endpoints (camelCase request bodies, as the legacy client sent) ----

export interface CreateSessionRequest {
  jwt: string;
  sessionPublicKey: number[];
  expiresAtMs: number;
  salt: number[];
  keyIndex: number;
  maxUses: number;
}

/**
 * `create_session` for the app's `scopeId` (from D1). The client never chooses the scope: a body with `scopeId` (or
 * `scope_id`) is rejected rather than silently ignored.
 */
export function toCreateSession(body: unknown, scopeId: string, now = Date.now()): Checked<ContractCall & { request: CreateSessionRequest }> {
  if (!isObj(body)) return { error: 'Body must be a JSON object' };
  if ('scopeId' in body || 'scope_id' in body) return { error: 'scopeId is not accepted: the app’s scope is used' };
  const { jwt, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses } = body;
  if (!isJwt(jwt)) return { error: 'jwt must be a Google ID token' };
  if (!isBytes(sessionPublicKey, 32, 32)) return { error: 'sessionPublicKey must be 32 bytes' };
  if (!isBytes(salt, 16, 64)) return { error: 'salt must be 16 to 64 bytes' };
  if (!isCount(expiresAtMs)) return { error: 'expiresAtMs must be a timestamp in ms' };
  if (expiresAtMs <= now || expiresAtMs > now + MAX_SESSION_MS + SKEW_MS) return { error: 'expiresAtMs must be in the next 24 hours' };
  if (!isU32(keyIndex)) return { error: 'keyIndex must be a u32' };
  if (!isCount(maxUses) || maxUses > MAX_USES) return { error: `maxUses must be 1 to ${MAX_USES}` };
  return {
    request: { jwt, sessionPublicKey, expiresAtMs, salt, keyIndex, maxUses },
    method: 'create_session',
    args: { jwt, scope_id: scopeId, session_public_key: sessionPublicKey, expires_at_ms: expiresAtMs, salt, key_index: keyIndex, max_uses: maxUses },
  };
}

export interface SessionSigned {
  sessionPublicKey: number[];
  counter: number;
  signature: number[];
}

export function toDeriveKey(body: unknown): Checked<ContractCall & SessionSigned & { pk1: string; pk2: string }> {
  if (!isObj(body)) return { error: 'Body must be a JSON object' };
  const { sessionPublicKey, counter, signature, pk1, pk2 } = body;
  if (!isBytes(sessionPublicKey, 32, 32) || !isCount(counter) || !isBytes(signature, 64, 64) || !isPoint(pk1, 'bls12381g1:') || !isPoint(pk2, 'bls12381g2:')) {
    return { error: 'Malformed key request' };
  }
  return { sessionPublicKey, counter, signature, pk1, pk2, method: 'derive_key', args: { session_public_key: sessionPublicKey, counter, signature, pk1, pk2 } };
}

export function toRevokeSession(body: unknown): Checked<ContractCall & SessionSigned> {
  if (!isObj(body)) return { error: 'Body must be a JSON object' };
  const { sessionPublicKey, counter, signature } = body;
  if (!isBytes(sessionPublicKey, 32, 32) || !isCount(counter) || !isBytes(signature, 64, 64)) return { error: 'Malformed revoke request' };
  return { sessionPublicKey, counter, signature, method: 'revoke_session', args: { session_public_key: sessionPublicKey, counter, signature } };
}

// ---- Owner actions: `{ method, args }`, args exactly as the contract takes them (snake_case, serde enums) ----

export const OWNER_ACTION_METHODS = ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change'] as const;

/** Only `{"Oidc":{"jwt":"..."}}`: `"Near"` auth would make the relayer the predecessor, which is never an owner. */
function isOidcAuth(v: unknown): boolean {
  return isObj(v) && onlyKeys(v, ['Oidc']) && isObj(v.Oidc) && onlyKeys(v.Oidc, ['jwt']) && isJwt(v.Oidc.jwt);
}

function isOwner(v: unknown): boolean {
  if (!isObj(v)) return false;
  if ('Near' in v) return onlyKeys(v, ['Near']) && isObj(v.Near) && onlyKeys(v.Near, ['account_id']) && isAccountId(v.Near.account_id);
  if ('Oidc' in v) return onlyKeys(v, ['Oidc']) && isObj(v.Oidc) && onlyKeys(v.Oidc, ['provider', 'sub']) && isProvider(v.Oidc.provider) && isSub(v.Oidc.sub);
  return false;
}

function changeKind(v: unknown): 'AddClient' | 'SetOwners' | 'SetAllowShared' | null {
  if (!isObj(v)) return null;
  if ('AddClient' in v) {
    const c = v.AddClient;
    return onlyKeys(v, ['AddClient']) && isObj(c) && onlyKeys(c, ['provider', 'aud']) && isProvider(c.provider) && isAud(c.aud) ? 'AddClient' : null;
  }
  if ('SetOwners' in v) {
    const c = v.SetOwners;
    return onlyKeys(v, ['SetOwners']) && isObj(c) && onlyKeys(c, ['owners']) && Array.isArray(c.owners) && c.owners.length >= 1 && c.owners.length <= 5 && c.owners.every(isOwner)
      ? 'SetOwners'
      : null;
  }
  if ('SetAllowShared' in v) {
    // Only enabling is a (timelocked) change; disabling is disable_shared_login.
    const c = v.SetAllowShared;
    return onlyKeys(v, ['SetAllowShared']) && isObj(c) && onlyKeys(c, ['allow']) && c.allow === true ? 'SetAllowShared' : null;
  }
  return null;
}

export function toOwnerAction(body: unknown): Checked<ContractCall> {
  if (!isObj(body) || !onlyKeys(body, ['method', 'args'])) return { error: 'Body must be {"method", "args"}' };
  const { method, args } = body;
  if (typeof method !== 'string' || !(OWNER_ACTION_METHODS as readonly string[]).includes(method)) return { error: 'Unsupported owner action' };
  if (!isObj(args) || !isScopeId(args.scope_id)) return { error: 'args.scope_id is required' };
  switch (method) {
    case 'propose_change': {
      if (!onlyKeys(args, ['scope_id', 'auth', 'change'], ['client_proof'])) return { error: 'Unexpected or missing arguments' };
      if (!isOidcAuth(args.auth)) return { error: 'auth must be {"Oidc":{"jwt":...}}' };
      const kind = changeKind(args.change);
      if (!kind) return { error: 'Malformed change' };
      const proof = args.client_proof ?? null;
      if (kind === 'AddClient' && !isJwt(proof)) return { error: 'AddClient needs a client_proof token' };
      if (kind !== 'AddClient' && proof !== null) return { error: 'client_proof is only for AddClient' };
      return { method, args: { scope_id: args.scope_id, auth: args.auth, change: args.change, client_proof: proof } };
    }
    case 'cancel_change': {
      if (!onlyKeys(args, ['scope_id', 'auth', 'change_id'])) return { error: 'Unexpected or missing arguments' };
      if (!isOidcAuth(args.auth)) return { error: 'auth must be {"Oidc":{"jwt":...}}' };
      if (!isU64(args.change_id)) return { error: 'change_id must be a u64' };
      return { method, args: { scope_id: args.scope_id, auth: args.auth, change_id: args.change_id } };
    }
    case 'remove_client': {
      if (!onlyKeys(args, ['scope_id', 'auth', 'provider', 'aud'])) return { error: 'Unexpected or missing arguments' };
      if (!isOidcAuth(args.auth)) return { error: 'auth must be {"Oidc":{"jwt":...}}' };
      if (!isProvider(args.provider) || !isAud(args.aud)) return { error: 'Malformed client' };
      return { method, args: { scope_id: args.scope_id, auth: args.auth, provider: args.provider, aud: args.aud } };
    }
    case 'disable_shared_login': {
      if (!onlyKeys(args, ['scope_id', 'auth'])) return { error: 'Unexpected or missing arguments' };
      if (!isOidcAuth(args.auth)) return { error: 'auth must be {"Oidc":{"jwt":...}}' };
      return { method, args: { scope_id: args.scope_id, auth: args.auth } };
    }
    case 'execute_change': {
      if (!onlyKeys(args, ['scope_id', 'change_id'])) return { error: 'Unexpected or missing arguments' };
      if (!isU64(args.change_id)) return { error: 'change_id must be a u64' };
      return { method, args: { scope_id: args.scope_id, change_id: args.change_id } };
    }
    default:
      return { error: 'Unsupported owner action' };
  }
}
