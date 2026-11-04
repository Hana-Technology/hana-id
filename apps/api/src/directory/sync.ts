// Keeping each user's identities current (D310 point 4, D314). After a link change the API relayed (`/v1/link`,
// `/v1/link/cancel`, `/v1/link/unlink`) and after a linked login it reads the account fresh from the chain
// (`get_account` of the account root) and rewrites the account's rows from that answer: the chain decides who is in
// the account, the request only lends the subs its verified tokens carried (the chain lists a member by key and
// provider, never by sub). A plain login reuses the identity read the login already made (session-standing.ts), with
// no read of its own. Everything runs after the answer (`waitUntil`) and never fails or slows the request it follows.
//
// An identity is in at most one account of a scope, so its row (keyed by scope and identity key) moves to the account
// it is in now: a member that leaves one account and joins another moves cleanly, and the account it left shows it
// `unlinked` or `cancelled` until then. A root never moves (a root has a wallet, and an identity with a wallet can't
// join an account, links.rs), but the rule needs no exception for it.
//
// SECURITY: tokens are only ever passed as their verified (provider, sub); nothing here logs a sub or a key.
import type { Env } from '../env.ts';
import { type AccountView, getAccount, getIdentity } from '../link-views.ts';
import { log } from '../log.ts';
import type { SessionStanding } from '../session-standing.ts';
import {
  type IdentityRef,
  directoryUser,
  identityKeyHex,
  markRemovedMembers,
  noteDirectoryUnavailable,
  upsertIdentity,
  upsertUser,
  writeDirectory,
} from './store.ts';

export interface SyncAt {
  requestId: string;
  endpoint: string;
  appId?: string;
}

/** Runs `p` after the response when an execution context is there, else awaits it. Never rejects. */
export async function inBackground(exec: ExecutionContext | undefined, p: () => Promise<unknown>): Promise<void> {
  const run = Promise.resolve()
    .then(p)
    .then(() => undefined)
    .catch(() => undefined);
  if (exec) exec.waitUntil(run);
  else await run;
}

/**
 * Rewrites the account rooted at `root` from a fresh `get_account` read. `known`: identities whose sub the request's
 * verified tokens gave. `hint`: the member a cancel or unlink just removed. Returns false when nothing could be
 * written.
 */
export async function syncAccount(env: Env, scopeId: string, root: IdentityRef, known: readonly IdentityRef[], at: SyncAt, opts: { hint?: { memberKey: string; action: 'cancel' | 'unlink' } } = {}): Promise<boolean> {
  let account: AccountView | null;
  const readAt = Date.now();
  try {
    account = await getAccount(env, scopeId, root.provider, root.sub);
  } catch {
    log({ event: 'directory_sync_failed', requestId: at.requestId, endpoint: at.endpoint, appId: at.appId, code: 'near_unavailable' }, 'warn');
    return false;
  }
  // The account the chain names is the truth (`root` was the caller's reading of it).
  const truth = account?.root ?? root;
  const user = await directoryUser(env, scopeId, truth);
  if (typeof user === 'string') {
    noteDirectoryUnavailable(at, user);
    return false;
  }
  const keyed = new Map<string, IdentityRef>();
  for (const k of [truth, ...known]) keyed.set(await identityKeyHex(scopeId, k), k);
  const rootKey = await identityKeyHex(scopeId, truth);
  const members = account?.members ?? [];
  // Every caller follows a fresh sign-in of the account (a login, or a link change's tokens): the user was seen now.
  const stmts: D1PreparedStatement[] = [upsertUser(env.DB, user, scopeId, readAt)];
  stmts.push(upsertIdentity(env.DB, { scopeId, identityKey: rootKey, internalId: user.internalId, provider: truth.provider, sub: truth.sub, role: 'root', status: 'active', effectiveAt: null }, readAt));
  for (const m of members) {
    stmts.push(
      upsertIdentity(
        env.DB,
        {
          scopeId,
          identityKey: m.key,
          internalId: user.internalId,
          provider: m.provider,
          sub: keyed.get(m.key)?.sub ?? null,
          role: 'member',
          status: m.active ? 'active' : 'pending',
          effectiveAt: m.effectiveAtMs,
        },
        readAt,
      ),
    );
  }
  stmts.push(markRemovedMembers(env.DB, scopeId, user.internalId, members.map((m) => m.key), readAt, opts.hint));
  return writeDirectory(env, stmts, at);
}

/**
 * After a successful /v1/login. With a link, the chain changed in that transaction: the session identity's account is
 * read fresh (`get_identity`, then the account). Without one, the login's own standing read is enough: the user's
 * last seen moves, the root's row is written, and for a member its own row (a member that logs in is active). A
 * standing that is only the fail-open guess writes nothing (D314).
 */
export async function syncAfterLogin(env: Env, scopeId: string, token: IdentityRef, link: IdentityRef | null, standing: SessionStanding, at: SyncAt): Promise<boolean> {
  if (link) {
    let root: IdentityRef;
    try {
      const view = await getIdentity(env, scopeId, token.provider, token.sub);
      root = view.root ?? token;
    } catch {
      log({ event: 'directory_sync_failed', requestId: at.requestId, endpoint: at.endpoint, appId: at.appId, code: 'near_unavailable' }, 'warn');
      return false;
    }
    return syncAccount(env, scopeId, root, [token, link], at);
  }
  if (!standing.confirmed || standing.pending) return false;
  const root = standing.member?.root ?? token;
  const user = await directoryUser(env, scopeId, root);
  if (typeof user === 'string') {
    noteDirectoryUnavailable(at, user);
    return false;
  }
  const now = Date.now();
  const stmts = [
    upsertUser(env.DB, user, scopeId, now),
    upsertIdentity(env.DB, { scopeId, identityKey: await identityKeyHex(scopeId, root), internalId: user.internalId, provider: root.provider, sub: root.sub, role: 'root', status: 'active', effectiveAt: null }, now),
  ];
  if (standing.member) {
    stmts.push(
      upsertIdentity(
        env.DB,
        { scopeId, identityKey: await identityKeyHex(scopeId, token), internalId: user.internalId, provider: token.provider, sub: token.sub, role: 'member', status: 'active', effectiveAt: standing.member.effectiveAtMs },
        now,
      ),
    );
  }
  return writeDirectory(env, stmts, at);
}
