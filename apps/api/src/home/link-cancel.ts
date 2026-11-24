// POST /v1/home/link/cancel (D898 option B, built as D902): Passport Home cancels a link that is still waiting, for a
// wallet on Journear's shared Google client. The same `cancel_link` the sign-in window's "Cancel this link" relays through
// `POST /v1/link/cancel`, without an app: Home has no publishable key and no partner page, and must not borrow one.
//
//   POST /v1/home/link/cancel  {jwt, memberKey, epoch, salt, scopeId}  → cancel_link  200 {result: null, nearTx, sharesRevoked}
//
// What stands in for the app gate is the person, twice: a live Passport Home sign-in (homeGate: `Origin === AUTH_ORIGIN`,
// the per-IP limit, the Home token, its key's signature over this exact body, a counter used once), and a fresh Google
// sign-in of the same account whose nonce is the contract's `link_change` "cancel" nonce over (signer, scope, root,
// member, epoch, salt): one change, of one member, of one account, at one epoch. The contract checks that proof itself;
// nothing weaker can reach `cancel_link` (Home's own token commits to the Home key and the contract never takes it).
//
// Stricter than the contract and the window, in this order (each refusal relays nothing and costs no gas):
//   1. the gate;
//   2. the Home sign-in is a Google one (an email owner cancels in the app's own sign-in window, as before);
//   3. the body's shape, exactly these five fields;
//   4. the proof: genuine and unexpired (login-token.ts, no app), with a nonce; a refused proof answers 403 with its
//      code (never 401, which on a Home route means Home's own sign-in ended);
//   5. the proof is the same identity as Home's sign-in (provider and `sub`), never another account;
//   6. the proof's audience is a shared Google client in force (never a scope's own client, never the exit client, which
//      can't make link changes, D468), admitted for this scope (shared login on), and the contract not paused with the
//      token's key active (chainGate);
//   7. the chain now (link-precheck, the contract's rules in its order): the member is in the proof identity's account,
//      the nonce is that change's, the identity is not the member and not pending (so it already opens the wallet), the
//      epoch is current and the member is still pending (an active member or the root is never cancelled here);
//   8. one relay per proof across isolates and routes (the `link-tokens` claim `/v1/link/cancel` uses too), then the
//      account's own link-change windows, shared with the window's route.
// Then one `cancel_link` from the session pool (the same pool and method as the window's), the account's vault shares
// revoked in every app of the scope (so its devices sign in again), the wallet directory synced, and one usage event
// `home_link_cancel` for Journear's own org (no app, no partner billed).
//
// Not changed by this route: the delay, what a waiting sign-in can do, derivation paths or keys (address impact: none).
//
// SECURITY: `(provider, sub)` comes only from homeGate's verified token and the proof's verified token. Nothing here logs
// or returns a token, a `sub`, an identity key, a path or a path hash; a refusal carries a fixed error and code only.
import { GOOGLE_PROVIDER } from '@hana-id/jwks';
import { hex } from '../bytes.ts';
import { inBackground, syncAccount } from '../directory/sync.ts';
import type { Env } from '../env.ts';
import { type Ctx, NOT_EXECUTED, chainGate, chainGateResponse, checkClientScope, done, hitAll, lap, lapRelay, limiter, loginTokenRefusal, newCtx, reject, relayFailure } from '../handlers.ts';
import type { LinkRefusal } from '../link-precheck.ts';
import { LINK_CLAIM_MS, isEpoch, isMemberKey, isSalt, linkRootWindow, precheckChange, revokeAccountShares } from '../links.ts';
import { log } from '../log.ts';
import { verifyLoginToken } from '../login-token.ts';
import { recalledPanic, requestKey } from '../panic-cache.ts';
import { relay } from '../relayer-pool.ts';
import { identityKey } from '../session-crypto.ts';
import { beginUsage, finishUsageOnThrow } from '../usage/event.ts';
import { isToken } from '../validate.ts';
import { getConfig, isSharedClient } from '../views.ts';
import { hanaOrgId } from './billing.ts';
import { homeGate } from './identity.ts';

export const HOME_LINK_CANCEL_ENDPOINT = '/v1/home/link/cancel';
/** Requests a minute per IP, as the window's removals (`LINK_CHANGES_PER_IP_MINUTE`). */
export const HOME_LINK_CANCEL_PER_IP_MINUTE = 10;
/** Requests a minute per Home key: a person cancels one link at a time, each after its own Google sign-in. */
export const HOME_LINK_CANCEL_PER_KEY_MINUTE = 5;

const SCOPE_RE = /^[a-z0-9]{1,64}$/u;
const FIELDS = ['jwt', 'memberKey', 'epoch', 'salt', 'scopeId'] as const;

export interface HomeLinkCancelBody {
  jwt: string;
  memberKey: string;
  epoch: number;
  salt: number[];
  scopeId: string;
}

/** Exactly the five fields, well formed; an error otherwise. */
export function toHomeLinkCancel(bytes: Uint8Array): HomeLinkCancelBody | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { error: 'Body must be JSON' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'Body must be a JSON object' };
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== FIELDS.length || !FIELDS.every((k) => Object.hasOwn(o, k))) return { error: 'Body must be {"jwt", "memberKey", "epoch", "salt", "scopeId"}' };
  const { jwt, memberKey, epoch, salt, scopeId } = o;
  if (!isToken(jwt)) return { error: 'jwt must be an ID token' };
  if (!isMemberKey(memberKey)) return { error: 'memberKey must be an identity key (64 lowercase hex characters)' };
  if (!isEpoch(epoch)) return { error: 'epoch must be a u64' };
  if (!isSalt(salt)) return { error: 'salt must be 16 to 64 bytes' };
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) return { error: 'scopeId must be 1 to 64 lower-case letters or digits' };
  return { jwt, memberKey, epoch, salt, scopeId };
}

export async function handleHomeLinkCancel(request: Request, env: Env, requestId: string, exec?: ExecutionContext, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_LINK_CANCEL_ENDPOINT, request);
  try {
    return await homeLinkCancel(request, env, ctx, exec, now);
  } catch (err) {
    finishUsageOnThrow(ctx);
    throw err;
  }
}

async function homeLinkCancel(request: Request, env: Env, ctx: Ctx, exec: ExecutionContext | undefined, now: number): Promise<Response> {
  const { requestId } = ctx;
  // 1. The Home sign-in (identity.ts): Origin, the per-IP minute, the Home token, its key's signature over this body, single use.
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_LINK_CANCEL_PER_IP_MINUTE, keyPerMinute: HOME_LINK_CANCEL_PER_KEY_MINUTE, window: 'link-cancel' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');

  // 2. Google only (D898 option B): the proof must be a Google sign-in of this same account.
  if (gate.identity.provider !== GOOGLE_PROVIDER) return reject(ctx, 403, 'google_only', 'Passport Home cancels a link only for a Google sign-in');

  // 3. Shape.
  const body = toHomeLinkCancel(gate.body);
  if ('error' in body) return reject(ctx, 400, 'bad_request', body.error);

  // 4. A genuine, unexpired token with a nonce (no app to hold it to).
  // A refused proof is 403, never 401: 401 on a Home route means Home's own sign-in has ended, and the page signs the
  // person out of Home for it (an unknown kid after Google rotates its keys must not do that). Its code is kept.
  const verified = await verifyLoginToken(env, body.jwt, now, { anyLoginMethod: true, exec });
  if (!verified.ok) return loginTokenRefusal(ctx, verified.status === 401 ? { ...verified, status: 403 } : verified);
  const token = verified.token;
  if (token.nonce === null) return reject(ctx, 400, 'nonce_mismatch', 'The ID token has no nonce');

  // 5. The same identity as the Home sign-in (`sub` is global): one Home user can never cancel with another's proof.
  if (token.provider !== gate.identity.provider || token.sub !== gate.identity.sub) return reject(ctx, 403, 'home_account_mismatch', 'Sign in as the same account you used in Home');

  // 6. A shared Google client in force, admitted for this scope; the contract not paused, the token's key active.
  let shared: boolean;
  try {
    shared = isSharedClient(await getConfig(env), token.provider, token.aud, now);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the shared clients');
  }
  if (!shared) return reject(ctx, 403, 'not_shared_client', 'Passport Home cancels a link only with the shared Google sign-in');
  let scope: Awaited<ReturnType<typeof checkClientScope>>;
  try {
    scope = await checkClientScope(env, token.provider, token.aud, body.scopeId, now);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the scope');
  }
  if (scope) return reject(ctx, scope.status, scope.code, scope.error);
  const gov = await chainGate(env, token.kid === null ? null : { provider: token.provider, kid: token.kid }, requestId);
  if (gov) return chainGateResponse(ctx, gov);

  // 7. The contract's rules from the chain now, with Home's stricter ones (links.ts `precheckChange`, `activeActor`).
  const salt = Uint8Array.from(body.salt);
  let checked: LinkRefusal | { root: { provider: string; sub: string } };
  try {
    checked = await precheckChange(env, body.scopeId, 'cancel', token, body.memberKey, body.epoch, salt, { activeActor: true });
  } catch {
    checked = { status: 502, code: 'near_unavailable', error: 'Could not read the sign-in methods on chain' };
  }
  if ('status' in checked) return done(ctx, checked.status, { error: checked.error, code: checked.code, ...(checked.reason ? { reason: checked.reason } : {}) });
  lap(ctx, 'checks');

  const call = { method: 'cancel_link', args: { scope_id: body.scopeId, jwt: body.jwt, member_key: body.memberKey, epoch: body.epoch, salt: body.salt } };
  // The same request already panicked for a link state in this isolate (panic-cache.ts): answered from here.
  const panicKey = await requestKey(call.method, call.args);
  const recalled = recalledPanic(panicKey);
  if (recalled) return done(ctx, recalled.status, { error: recalled.error, code: recalled.code });

  // 8. One relay per proof, across isolates and across this route and /v1/link/cancel (the same claim key): a second copy
  // can only fail on chain (the first one moves the epoch the nonce commits to), so it is refused here. Released when the
  // relay certainly didn't execute; kept otherwise, until the token expires.
  const claim = await requestKey('link-tokens', { tokens: [body.jwt] });
  const claims = limiter(env, 'link-tokens');
  try {
    if (!(await claims.reserve(claim, now + LINK_CLAIM_MS))) return reject(ctx, 409, 'link_in_flight', 'This link request was already sent; wait for its answer');
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const unclaim = async (): Promise<void> => {
    try {
      await claims.release(claim);
    } catch {
      log({ event: 'link_claim_release_failed', requestId, endpoint: ctx.endpoint }, 'warn');
    }
  };
  // The account's link changes, the same windows as the window's cancels (a refusal takes earlier windows' hits back).
  const rootIk = hex(await identityKey(body.scopeId, checked.root.provider, checked.root.sub));
  try {
    const refused = await hitAll(env, [linkRootWindow(body.scopeId, rootIk, false)], requestId, HOME_LINK_CANCEL_ENDPOINT, now);
    if (refused) {
      await unclaim();
      return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (${refused.window.label} per ${refused.limit.replace(/^change:/u, '')})`, { 'retry-after': String(refused.retryAfterS) });
    }
  } catch {
    await unclaim();
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }

  // From here on every outcome is one usage event (`lapRelay` notes the transaction, `done` closes it): the gas of a
  // Home cancel is Journear's own (no app, no partner billed), so the nonce check can explain the session key's nonce.
  beginUsage(ctx, { orgId: hanaOrgId(env), appId: null, scopeId: body.scopeId, exec });
  const result = await relay(env, 'session', call, requestId);
  lapRelay(ctx, result);
  if (!result.ok && NOT_EXECUTED.has(result.code)) await unclaim();
  if (!result.ok) return relayFailure(ctx, env, result, panicKey);
  // Whether the account's devices will be asked to sign in again: the page says so only when this is true (D902).
  const sharesRevoked = await revokeAccountShares(env, body.scopeId, checked.root, ctx);
  // The wallet directory (D314): the account as the chain has it now; the member this cancel removed, in case it can't read.
  await inBackground(exec, () => syncAccount(env, body.scopeId, checked.root, [{ provider: token.provider, sub: token.sub }], { requestId, endpoint: ctx.endpoint }, { hint: { memberKey: body.memberKey, action: 'cancel' } }));
  return done(ctx, 200, { result: null, nearTx: result.nearTx, sharesRevoked });
}
