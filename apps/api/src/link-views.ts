// hana-signer v3 views for email login and links (docs/contract-interface.md "Self-issued issuers", "Link methods"):
// the email signer policy (cached like the issuer kids) and the identity and account reads the link prechecks make.
// Identity and account reads are never cached: a link nonce commits to the chain state at the time of the call, and
// the contract re-checks every one of them.
import type { Env } from './env.ts';
import { Rpc } from './near/rpc.ts';
import { TtlCache } from './views.ts';

/** `get_self_issued(provider)`: the signer policy (signer ids with their active kids) and `required`. */
export interface SelfIssuedView {
  signers: { id: string; kids: string[] }[];
  required: number;
  /** While a policy change's overlap lasts: until when tokens of the previous policy still pass on chain. */
  overlapUntilMs: number | null;
}

/** `get_identity`: where an identity stands in a scope. */
export interface IdentityView {
  /** Its identity key, hex. */
  key: string;
  status: 'own' | 'member' | 'pending';
  /** Its own path was derived once: it "has a wallet". */
  opened: boolean;
  /** The account root, for `member` and `pending`. */
  root: { provider: string; sub: string } | null;
  effectiveAtMs: number | null;
  /** The epoch of its account (its root's), 0 without one. */
  accountEpoch: number;
}

/** `get_account`: the account an identity is in (as root or member). */
export interface AccountView {
  root: { provider: string; sub: string };
  members: { key: string; provider: string; effectiveAtMs: number; active: boolean; auto: boolean }[];
  epoch: number;
  /** Identity keys (hex) unlinked from it: automatic linking never re-adds them. */
  unlinked: string[];
}

/** A view answer that doesn't have the documented shape (a contract older than v3, or a broken RPC). */
export class ViewShapeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const isRef = (v: unknown): v is { provider: string; sub: string } => isObj(v) && typeof v.provider === 'string' && typeof v.sub === 'string';
const isU64 = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function parseSelfIssued(raw: unknown): SelfIssuedView | null {
  if (raw === null) return null;
  if (!isObj(raw) || !Array.isArray(raw.signers) || !isU64(raw.required)) throw new ViewShapeError('get_self_issued');
  const signers = raw.signers.map((s) => {
    if (!isObj(s) || typeof s.id !== 'string' || !Array.isArray(s.kids) || !s.kids.every((k) => typeof k === 'string')) throw new ViewShapeError('get_self_issued signer');
    return { id: s.id, kids: s.kids as string[] };
  });
  const overlap = raw.overlap_until_ms;
  return { signers, required: raw.required, overlapUntilMs: isU64(overlap) ? overlap : null };
}

export function parseIdentity(raw: unknown): IdentityView {
  if (!isObj(raw) || !isHex32(raw.key) || !['own', 'member', 'pending'].includes(raw.status as string) || typeof raw.opened !== 'boolean' || !isU64(raw.account_epoch)) {
    throw new ViewShapeError('get_identity');
  }
  const root = raw.root === null || raw.root === undefined ? null : isRef(raw.root) ? { provider: raw.root.provider, sub: raw.root.sub } : undefined;
  if (root === undefined) throw new ViewShapeError('get_identity root');
  const status = raw.status as IdentityView['status'];
  if ((status === 'own') !== (root === null)) throw new ViewShapeError('get_identity root');
  return { key: raw.key, status, opened: raw.opened, root, effectiveAtMs: isU64(raw.effective_at_ms) ? raw.effective_at_ms : null, accountEpoch: raw.account_epoch };
}

export function parseAccount(raw: unknown): AccountView | null {
  if (raw === null) return null;
  if (!isObj(raw) || !isRef(raw.root) || !Array.isArray(raw.members) || !isU64(raw.epoch) || !Array.isArray(raw.unlinked)) throw new ViewShapeError('get_account');
  const members = raw.members.map((m) => {
    if (!isObj(m) || !isHex32(m.key) || typeof m.provider !== 'string' || !isU64(m.effective_at_ms) || typeof m.active !== 'boolean' || typeof m.auto !== 'boolean') {
      throw new ViewShapeError('get_account member');
    }
    return { key: m.key, provider: m.provider, effectiveAtMs: m.effective_at_ms, active: m.active, auto: m.auto };
  });
  if (!raw.unlinked.every(isHex32)) throw new ViewShapeError('get_account unlinked');
  return { root: { provider: raw.root.provider, sub: raw.root.sub }, members, epoch: raw.epoch, unlinked: raw.unlinked as string[] };
}

/**
 * provider → its signer policy, ≤ 60 s. A kid the cached policy doesn't list re-reads it, at most once per
 * SELF_ISSUED_REFETCH_MS per provider and isolate (concurrent misses share one read), so an email key that just became
 * active is seen within seconds while a burst of tokens with a pending kid costs one view call.
 */
const policyCache = new TtlCache<{ policy: SelfIssuedView | null; readAt: number }>(60_000, 4);
const policyReads = new Map<string, Promise<SelfIssuedView | null>>();
export const SELF_ISSUED_REFETCH_MS = 10_000;

async function readPolicy(env: Env, provider: string): Promise<SelfIssuedView | null> {
  const inFlight = policyReads.get(provider);
  if (inFlight) return inFlight;
  const read = (async () => {
    const policy = parseSelfIssued(await new Rpc(env.NEAR_RPC).view<unknown>(env.SIGNER_ACCOUNT, 'get_self_issued', { provider }));
    policyCache.set(provider, { policy, readAt: Date.now() });
    return policy;
  })();
  policyReads.set(provider, read);
  try {
    return await read;
  } finally {
    policyReads.delete(provider);
  }
}

/**
 * The signer policy of `provider`, re-read when a token names kids the cached one doesn't list (`kids`). Null when the
 * provider isn't self-issued on chain. Throws when the view can't be read (a v2 contract has no such view).
 */
export async function getSelfIssued(env: Env, provider: string, kids: readonly string[] = [], now: number = Date.now()): Promise<SelfIssuedView | null> {
  const cached = policyCache.get(provider, now);
  const listed = (p: SelfIssuedView | null): boolean => !!p && kids.every((k) => p.signers.some((s) => s.kids.includes(k)));
  if (cached && (listed(cached.policy) || now - cached.readAt < SELF_ISSUED_REFETCH_MS)) return cached.policy;
  return readPolicy(env, provider);
}

export async function getIdentity(env: Env, scopeId: string, provider: string, sub: string): Promise<IdentityView> {
  return parseIdentity(await new Rpc(env.NEAR_RPC).view<unknown>(env.SIGNER_ACCOUNT, 'get_identity', { scope_id: scopeId, provider, sub }));
}

export async function getAccount(env: Env, scopeId: string, provider: string, sub: string): Promise<AccountView | null> {
  return parseAccount(await new Rpc(env.NEAR_RPC).view<unknown>(env.SIGNER_ACCOUNT, 'get_account', { scope_id: scopeId, provider, sub }));
}

/** Tests only. */
export function clearLinkViewCaches(): void {
  policyCache.clear();
  policyReads.clear();
}
