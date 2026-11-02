// The explicit link relays (docs/email-login-spec.md "API changes", "Explicit linking", "Unlink and cancel"): from the
// vault or the auth origin's pages (never a partner page), relayed through the session pool like logins, each with its
// own per-IP and per-app limits (adding and removing apart, so a flood of adds can never block a cancel):
//
//   POST /v1/link         {accountJwt, newJwt, epoch, salt}   → link_identity   200 {result: {effectiveAtMs}, nearTx}
//   POST /v1/link/cancel  {jwt, memberKey, epoch, salt}        → cancel_link     200 {result: null, nearTx}
//   POST /v1/link/unlink  {jwt, memberKey, epoch, salt}        → unlink_identity 200 {result: null, nearTx}
//
// Every token is verified (Google or email, login-token.ts) and must be a client of the app's scope; every nonce and
// state rule the contract checks is prechecked from the API's own chain reads (link-precheck.ts), so a malformed,
// replayed or stale request costs no gas. After a success the account's vault shares in the scope are revoked, so the
// account's other devices sign in again and see the change. No token, sub or identity key is ever logged.
import { appGate, chainGate, chainGateResponse, checkClientScope, done, lap, lapRelay, limiter, newCtx, reject, relayFailure, settle, type Ctx, loginTokenRefusal } from './handlers.ts';
import type { App } from './apps.ts';
import { fromHex, hex, sha256 } from './bytes.ts';
import { countEmailUsage } from './email-usage.ts';
import type { Env } from './env.ts';
import { readJson } from './http.ts';
import { type LinkRefusal, accountRootIk, checkKey, roomFor } from './link-precheck.ts';
import { type AccountView, type IdentityView, getAccount, getIdentity } from './link-views.ts';
import { log } from './log.ts';
import { type LoginToken, verifyLoginToken } from './login-token.ts';
import { relay } from './relayer-pool.ts';
import { identityKey, linkAccountNonce, linkChangeNonce, linkNewNonce } from './session-crypto.ts';
import { MAX_BODY, isToken } from './validate.ts';
import { getConfig } from './views.ts';

export const LINK_ENDPOINT = '/v1/link';
export const LINK_CANCEL_ENDPOINT = '/v1/link/cancel';
export const LINK_UNLINK_ENDPOINT = '/v1/link/unlink';
export const LINK_ENDPOINTS: readonly string[] = [LINK_ENDPOINT, LINK_CANCEL_ENDPOINT, LINK_UNLINK_ENDPOINT];
export type LinkEndpoint = typeof LINK_ENDPOINT | typeof LINK_CANCEL_ENDPOINT | typeof LINK_UNLINK_ENDPOINT;

/**
 * Limits (provisional, to measure on sandbox-dev; D232). Per IP and app, per minute: adds, and removals (cancel,
 * unlink). Per app: adds per minute and day, removals per minute and day, in separate windows. The contract alarms at
 * 50 new links per scope and hour (D200), so a normal app is far below these.
 */
export const LINK_ADDS_PER_IP_MINUTE = 5;
export const LINK_CHANGES_PER_IP_MINUTE = 10;
export const LINK_ADDS_PER_APP_MINUTE = 30;
export const LINK_ADDS_PER_APP_DAY = 1000;
export const LINK_CHANGES_PER_APP_MINUTE = 60;
export const LINK_CHANGES_PER_APP_DAY = 2000;
/**
 * Vault shares revoked after a link change are those of the account root's path at key_index 0..SHARE_KEY_INDEXES-1
 * (`vault_shares.path_hash` is per path, and a path names its key_index): the SDK uses key_index 0. A share at a higher
 * index ends at its absolute limit, as one a direct contract caller leaves (D233).
 */
export const SHARE_KEY_INDEXES = 64;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSalt = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 16 && v.length <= 64 && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const isEpoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isMemberKey = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);

type LinkBody = { kind: 'link'; accountJwt: string; newJwt: string; epoch: number; salt: number[] } | { kind: 'cancel' | 'unlink'; jwt: string; memberKey: string; epoch: number; salt: number[] };

export function toLinkBody(endpoint: LinkEndpoint, body: unknown): LinkBody | { error: string } {
  if (!isObj(body)) return { error: 'Body must be a JSON object' };
  if (endpoint === LINK_ENDPOINT) {
    if (!onlyKeys(body, ['accountJwt', 'newJwt', 'epoch', 'salt'])) return { error: 'Body must be {"accountJwt", "newJwt", "epoch", "salt"}' };
    const { accountJwt, newJwt, epoch, salt } = body;
    if (!isToken(accountJwt) || !isToken(newJwt)) return { error: 'accountJwt and newJwt must be ID tokens' };
    if (!isEpoch(epoch)) return { error: 'epoch must be a u64' };
    if (!isSalt(salt)) return { error: 'salt must be 16 to 64 bytes' };
    return { kind: 'link', accountJwt, newJwt, epoch, salt };
  }
  if (!onlyKeys(body, ['jwt', 'memberKey', 'epoch', 'salt'])) return { error: 'Body must be {"jwt", "memberKey", "epoch", "salt"}' };
  const { jwt, memberKey, epoch, salt } = body;
  if (!isToken(jwt)) return { error: 'jwt must be an ID token' };
  if (!isMemberKey(memberKey)) return { error: 'memberKey must be an identity key (64 lowercase hex characters)' };
  if (!isEpoch(epoch)) return { error: 'epoch must be a u64' };
  if (!isSalt(salt)) return { error: 'salt must be 16 to 64 bytes' };
  return { kind: endpoint === LINK_CANCEL_ENDPOINT ? 'cancel' : 'unlink', jwt, memberKey, epoch, salt };
}

const refused = (reason: string, error: string): LinkRefusal => ({ status: 422, code: 'link_refused', reason, error });
const unavailable: LinkRefusal = { status: 502, code: 'near_unavailable', error: 'Could not read the sign-in methods on chain' };

interface Who {
  token: LoginToken;
  identity: IdentityView;
  account: AccountView | null;
}

/** Reads `token`'s identity and account; null (502) when the chain can't be read or answers another key than ours. */
async function read(env: Env, scopeId: string, token: LoginToken): Promise<Who | null> {
  const [identity, account] = await Promise.all([getIdentity(env, scopeId, token.provider, token.sub), getAccount(env, scopeId, token.provider, token.sub)]);
  if (!(await checkKey(scopeId, { provider: token.provider, sub: token.sub, identity, account }))) return null;
  return { token, identity, account };
}

/** link_identity's rules in the contract's order (links.rs), from the chain now. Also returns the account root. */
async function precheckLink(env: Env, scopeId: string, a: LoginToken, n: LoginToken, epoch: number, salt: Uint8Array): Promise<LinkRefusal | { root: { provider: string; sub: string } }> {
  const config = await getConfig(env);
  if (!config.links_open) return { status: 409, code: 'links_unavailable', error: 'Links wait until the owner accepts the wallets opened before v3' };
  const [who, added] = await Promise.all([read(env, scopeId, a), read(env, scopeId, n)]);
  if (!who || !added) return unavailable;
  const rootRef = who.identity.root ?? { provider: a.provider, sub: a.sub };
  const rootIk = who.identity.status === 'own' ? fromHex(who.identity.key) : await identityKey(scopeId, rootRef.provider, rootRef.sub);
  const [newNonce, accountNonce] = await Promise.all([
    linkNewNonce(env.SIGNER_ACCOUNT, scopeId, rootIk, n.provider, epoch, salt),
    linkAccountNonce(env.SIGNER_ACCOUNT, scopeId, rootIk, fromHex(added.identity.key), epoch, salt),
  ]);
  if (n.nonce !== newNonce || a.nonce !== accountNonce) return refused('link_mismatch', 'Link nonce doesn’t match');
  if (who.identity.key === added.identity.key) return refused('same_identity', 'Identities must differ');
  if (who.identity.status === 'pending') return { status: 409, code: 'link_pending', error: 'Sign-in method link is pending' };
  if (added.identity.opened) return refused('has_wallet', 'Sign-in method already has a wallet');
  if (added.identity.status !== 'own' || (added.account !== null && added.account.members.length > 0)) return refused('already_linked', 'Sign-in method is already linked');
  const room = roomFor(who.account, who.account?.root.provider ?? a.provider, n.provider);
  if (room) return room;
  if (epoch !== (who.account?.epoch ?? 0)) return refused('stale_epoch', 'Wrong epoch');
  return { root: who.account?.root ?? rootRef };
}

/** cancel_link's and unlink_identity's rules (links.rs), from the account the acting identity is in. */
async function precheckChange(env: Env, scopeId: string, action: 'cancel' | 'unlink', j: LoginToken, memberKey: string, epoch: number, salt: Uint8Array): Promise<LinkRefusal | { root: { provider: string; sub: string } }> {
  const who = await read(env, scopeId, j);
  if (!who) return unavailable;
  const account = who.account;
  // The member must be in the acting identity's account: anything else fails on chain (no such member, or a nonce
  // over another root), so it is refused here.
  if (!account) return refused('no_such_member', 'No such member');
  const root = await accountRootIk(scopeId, account);
  const member = account.members.find((m) => m.key === memberKey);
  if (!member && !(action === 'unlink' && memberKey === root)) return refused('no_such_member', 'No such member');
  const expected = await linkChangeNonce(env.SIGNER_ACCOUNT, scopeId, action, fromHex(root), fromHex(memberKey), epoch, salt);
  if (j.nonce !== expected) return refused('link_mismatch', 'Link nonce doesn’t match');
  const self = who.identity.key;
  if (action === 'cancel') {
    if (self !== memberKey) {
      if (who.identity.status === 'pending') return { status: 409, code: 'link_pending', error: 'Sign-in method link is pending' };
    }
    if (epoch !== account.epoch) return refused('stale_epoch', 'Wrong epoch');
    if (!member || member.active) return refused('no_such_member', 'No such member');
  } else {
    if (self !== root && self !== memberKey) return refused('not_allowed', 'Only the root or the member itself can unlink');
    if (epoch !== account.epoch) return refused('stale_epoch', 'Wrong epoch');
    if (memberKey === root) return refused('cannot_unlink_root', 'Cannot unlink the root');
    if (!member?.active) return refused('no_such_member', 'No such member');
  }
  return { root: account.root };
}

/**
 * Revokes every live vault share of `root`'s path in `scopeId`, in every app of the scope (key_index
 * 0..SHARE_KEY_INDEXES-1). Logged with its count only; a failure is logged and never fails the answer (the link
 * change is already on chain, and the shares end at their own limits).
 */
export async function revokeAccountShares(env: Env, scopeId: string, root: { provider: string; sub: string }, ctx: { requestId: string; endpoint: string; appId?: string }, now = Date.now()): Promise<void> {
  try {
    const hashes = await Promise.all(Array.from({ length: SHARE_KEY_INDEXES }, (_, k) => sha256(new TextEncoder().encode(`${scopeId}#${root.provider}#${root.sub}#${k}`))));
    const marks = hashes.map((_, i) => `?${i + 3}`).join(', ');
    const res = await env.DB.prepare(
      `UPDATE vault_shares SET revoked_at = ?1
        WHERE revoked_at IS NULL AND app_id IN (SELECT id FROM apps WHERE scope_id = ?2) AND path_hash IN (${marks})`,
    )
      .bind(now, scopeId, ...hashes)
      .run();
    log({ event: 'link_shares_revoked', requestId: ctx.requestId, appId: ctx.appId, endpoint: ctx.endpoint, removed: res.meta.changes ?? 0 });
  } catch {
    log({ event: 'link_shares_revoke_failed', requestId: ctx.requestId, appId: ctx.appId, endpoint: ctx.endpoint, code: 'internal' }, 'error');
  }
}

/** The app's link quota (adds and removals in their own windows), asked once every check has passed. */
async function linkQuota(env: Env, ctx: Ctx, app: App, add: boolean): Promise<Response | null> {
  try {
    const hit = await limiter(env, `app:${app.id}:${add ? 'link-adds' : 'link-changes'}`).hit([
      { name: 'minute', windowMs: MINUTE, max: add ? LINK_ADDS_PER_APP_MINUTE : LINK_CHANGES_PER_APP_MINUTE },
      { name: 'day', windowMs: DAY, max: add ? LINK_ADDS_PER_APP_DAY : LINK_CHANGES_PER_APP_DAY },
    ]);
    if (!hit.ok) return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (app ${add ? 'links' : 'link changes'} per ${hit.limit})`, { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  return null;
}

export async function handleLinkEndpoint(request: Request, env: Env, endpoint: LinkEndpoint, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  const now = Date.now();
  const add = endpoint === LINK_ENDPOINT;
  const gate = await appGate(request, env, ctx, add ? 'link' : 'link-change');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const body = toLinkBody(endpoint, parsed.body);
  if ('error' in body) return reject(ctx, 400, 'bad_request', body.error);

  // Every token genuine, unexpired and a client of the app's scope.
  const jwts = body.kind === 'link' ? [body.accountJwt, body.newJwt] : [body.jwt];
  const tokens: LoginToken[] = [];
  for (const jwt of jwts) {
    const v = await verifyLoginToken(env, jwt, now, { claimAllowList: true, appId: app.id, exec });
    if (!v.ok) return loginTokenRefusal(ctx, v);
    if (v.token.nonce === null) return reject(ctx, 400, 'nonce_mismatch', 'The ID token has no nonce');
    tokens.push(v.token);
  }
  const checks = await Promise.all([
    ...tokens.map((t) => settle(checkClientScope(env, t.provider, t.aud, app.scope_id, now))),
    ...tokens.map((t) => chainGate(env, t.kid === null ? null : { provider: t.provider, kid: t.kid }, requestId).then((g) => ({ ok: true as const, value: g }))),
  ]);
  for (const c of checks.slice(0, tokens.length)) {
    if (!c.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (c.value) return reject(ctx, c.value.status, c.value.code, c.value.error);
  }
  for (const c of checks.slice(tokens.length)) {
    if (c.ok && c.value && 'retryAfterS' in c.value) return chainGateResponse(ctx, c.value);
  }

  // The contract's own rules, from the chain now.
  const salt = Uint8Array.from(body.salt);
  let checked: LinkRefusal | { root: { provider: string; sub: string } };
  try {
    checked =
      body.kind === 'link'
        ? await precheckLink(env, app.scope_id, tokens[0]!, tokens[1]!, body.epoch, salt)
        : await precheckChange(env, app.scope_id, body.kind, tokens[0]!, body.memberKey, body.epoch, salt);
  } catch {
    checked = unavailable;
  }
  if ('status' in checked) return done(ctx, checked.status, { error: checked.error, code: checked.code, ...(checked.reason ? { reason: checked.reason } : {}) });
  lap(ctx, 'checks');
  const quota = await linkQuota(env, ctx, app, add);
  if (quota) return quota;

  const call =
    body.kind === 'link'
      ? { method: 'link_identity', args: { scope_id: app.scope_id, account_jwt: body.accountJwt, new_jwt: body.newJwt, epoch: body.epoch, salt: body.salt } }
      : { method: body.kind === 'cancel' ? 'cancel_link' : 'unlink_identity', args: { scope_id: app.scope_id, jwt: body.jwt, member_key: body.memberKey, epoch: body.epoch, salt: body.salt } };
  const result = await relay(env, 'session', call, requestId);
  lapRelay(ctx, result);
  if (!result.ok) return relayFailure(ctx, env, result);
  await revokeAccountShares(env, app.scope_id, checked.root, ctx);
  if (body.kind === 'link') {
    await countEmailUsage(env, app.id, 'links', ctx, exec);
    const at = result.result;
    if (!Number.isSafeInteger(at)) return done(ctx, 502, { error: 'The contract returned no activation time', code: 'bad_contract_result', nearTx: result.nearTx });
    return done(ctx, 200, { result: { effectiveAtMs: at }, nearTx: result.nearTx });
  }
  return done(ctx, 200, { result: null, nearTx: result.nearTx });
}

/** Tests only: the path hashes revokeAccountShares covers, hex. */
export async function accountShareHashes(scopeId: string, root: { provider: string; sub: string }): Promise<string[]> {
  return Promise.all(Array.from({ length: SHARE_KEY_INDEXES }, async (_, k) => hex(await sha256(new TextEncoder().encode(`${scopeId}#${root.provider}#${root.sub}#${k}`)))));
}
