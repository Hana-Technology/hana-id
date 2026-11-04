// Sign-in's last step and logout (docs/batch-c-spec.md "Code flow" step 4, "Membership rules at sign-in", "Sessions").
//
// `GET /api/auth/complete?h=` (console origin): the handoff code must be unused, inside its 60 s, and its flow's
// `__Host-hana_pre` must be this browser's (so a flow started in one browser can't be finished in another: a link to
// someone else's handoff signs nobody in). The code is used and its identity scrubbed in the same request. Then the
// membership rules run, here and not in the callback, so an invite is consumed only by a chain bound to one browser
// from start to finish:
//   - a user found by (provider, sub) with `disabled_at` set: `user_disabled` (audited), no invite consumed;
//   - an invite bound to the flow is always processed, even for an existing member (that is how a member of org A joins
//     org B): one D1 batch (invites.ts acceptInvite); already a member of its org: `already_member`, unconsumed;
//   - no invite: an existing user with a usable membership (an active org whose `required_hd`, if set, is the token's
//     `hd`) signs in; otherwise `not_invited`, audited with the address's sha256 only and no user row.
// A sign-in creates a session with a new id (`__Host-hana_cs`), clears the pre-flow cookie and 303s to `/`. A refusal
// clears the pre-flow cookie and 303s to `/signin#error=<code>` (D292): this is a top-level navigation, so the code goes
// in a fragment, never into a URL a server or a log sees.
import { type Actor, type SignInError, b64url, fromB64url, fromHex, hex, sha256, utf8 } from '@hana-id/console-core';
import { type Writer, auditInsert, entry } from './audit.ts';
import { PRE_COOKIE, type HandoffResult, authLimited, clearFlowCookie } from './auth-flow.ts';
import { ownerGrantDelayMs } from './config.ts';
import type { Env } from './env.ts';
import { RpcRefusal } from './errors.ts';
import { json } from './http.ts';
import { acceptInvite } from './invites.ts';
import { ipPrefix } from './ip.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { type Session, clearSessionCookie, cookieHash, readCookie, revokeSession, sessionCookie, sessionInsert } from './sessions.ts';
import { lit } from './sql.ts';

const B64URL32 = /^[A-Za-z0-9_-]{43}$/u;

/** A 303 for a top-level navigation, with the cookies to set. */
function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
}

const failed = (env: Env, code: SignInError): Response => redirect(`${env.CONSOLE_ORIGIN}/signin#error=${code}`, [clearFlowCookie(PRE_COOKIE)]);

/** Parses the handoff row's identity (written by auth-flow.ts callback); anything else is null. */
function handoffResult(text: string): HandoffResult | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v.provider !== 'string' || typeof v.sub !== 'string' || typeof v.email !== 'string' || !(v.hd === null || typeof v.hd === 'string')) return null;
    return { provider: v.provider, sub: v.sub, email: v.email, hd: v.hd };
  } catch {
    return null;
  }
}

type SignInOutcome = { ok: true; userId: string; viaInvite: boolean } | { ok: false; code: SignInError };

/** The membership rules (above), for a verified identity at `now`. */
async function membershipRules(env: Env, info: RequestInfo, id: HandoffResult, inviteId: string | null, now: number): Promise<SignInOutcome> {
  const db = env.CONSOLE_DB;
  const w = (actor: Actor): Writer => ({ actor, requestId: info.requestId, now, ipPrefix: ipPrefix(info.clientIp), country: info.country });
  const system: Actor = { kind: 'system', id: 'console-sign-in' };
  const refused = async (code: 'user_disabled' | 'not_invited', target: string | null): Promise<SignInOutcome> => {
    const details: Record<string, string> = code === 'not_invited' ? { code, emailSha256: hex(await sha256(utf8(id.email))) } : { code };
    try {
      await auditInsert(db, entry(w(system), 'signin.refused', { target, details, outcome: 'failed' })).run();
    } catch (err) {
      log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
    }
    return { ok: false, code };
  };
  const user = await db.prepare('SELECT id, disabled_at FROM console_users WHERE provider = ? AND sub = ?').bind(id.provider, id.sub).first<{ id: string; disabled_at: number | null }>();
  if (user && user.disabled_at !== null) return refused('user_disabled', user.id);
  if (inviteId !== null) {
    // The invite's token hash (read here, never returned): acceptance re-checks every condition against it.
    const inv = await db.prepare('SELECT hex(token_hash) AS h FROM invites WHERE id = ?').bind(inviteId).first<{ h: string | null }>();
    if (!inv?.h) return { ok: false, code: 'invite_invalid' };
    const tokenHash = fromHex(inv.h.toLowerCase());
    const r = await acceptInvite(
      db,
      { tokenHash, email: id.email, provider: id.provider, sub: id.sub, hd: id.hd, requestId: info.requestId, now, ipPrefix: ipPrefix(info.clientIp), country: info.country },
      () => ownerGrantDelayMs(env),
    );
    if (!r.ok) {
      log({ event: 'invite_accept', requestId: info.requestId, outcome: 'rejected', code: r.code });
      return r.code === 'user_disabled' ? refused('user_disabled', user?.id ?? null) : { ok: false, code: r.code };
    }
    log({ event: 'invite_accept', requestId: info.requestId, outcome: 'ok', orgId: r.orgId });
    return { ok: true, userId: r.userId, viaInvite: true };
  }
  if (!user) return refused('not_invited', null);
  const usable = await db
    .prepare(`SELECT 1 AS x FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND o.status = 'active' AND (o.required_hd IS NULL OR o.required_hd = ?) LIMIT 1`)
    .bind(user.id, id.hd)
    .first();
  if (!usable) return refused('not_invited', user.id);
  return { ok: true, userId: user.id, viaInvite: false };
}

/** `GET /api/auth/complete?h=` → 303 to `/` with a session, or to `/signin#error=<code>`. */
export async function completeSignIn(request: Request, env: Env, info: RequestInfo): Promise<Response> {
  if (await authLimited(env, info)) return failed(env, 'rate_limited');
  const url = new URL(request.url);
  const h = url.searchParams.getAll('h');
  const preHash = await cookieHash(readCookie(request.headers.get('cookie'), PRE_COOKIE));
  if (h.length !== 1 || !B64URL32.test(h[0]!) || !preHash) {
    log({ event: 'auth_complete', requestId: info.requestId, outcome: 'rejected', code: preHash ? 'bad_query' : 'no_flow_cookie' });
    return failed(env, 'expired');
  }
  const db = env.CONSOLE_DB;
  const now = Date.now();
  const codeHash = await sha256(fromB64url(h[0]!));
  // Used in the statement that finds it, only with the flow's own pre-flow cookie (a wrong cookie consumes nothing).
  const row = await db
    .prepare(
      `UPDATE handoff_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ${lit(now)}
          AND EXISTS (SELECT 1 FROM auth_flows f WHERE f.state_hash = handoff_codes.state_hash AND f.pre_cookie_hash = ? AND f.purpose = 'login')
        RETURNING result_json, hex(state_hash) AS state_hex`,
    )
    .bind(now, codeHash, preHash)
    .first<{ result_json: string; state_hex: string }>();
  if (!row) {
    log({ event: 'auth_complete', requestId: info.requestId, outcome: 'rejected', code: 'unknown_handoff' });
    return failed(env, 'expired');
  }
  // The identity is needed once: scrub it now rather than leave it for the daily purge.
  const [, flow] = await db.batch<{ invite_id: string | null }>([
    db.prepare("UPDATE handoff_codes SET result_json = '{}' WHERE code_hash = ?").bind(codeHash),
    db.prepare('SELECT invite_id FROM auth_flows WHERE state_hash = ?').bind(fromHex(row.state_hex.toLowerCase())),
  ]);
  const inviteId = flow?.results[0]?.invite_id ?? null;
  const id = handoffResult(row.result_json);
  if (!id) {
    log({ event: 'auth_complete', requestId: info.requestId, outcome: 'error', code: 'bad_handoff' }, 'error');
    return failed(env, 'internal');
  }
  let outcome: SignInOutcome;
  try {
    outcome = await membershipRules(env, info, id, inviteId, now);
  } catch (err) {
    log({ event: 'auth_complete', requestId: info.requestId, outcome: 'error', code: err instanceof RpcRefusal ? err.code : 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    return failed(env, 'internal');
  }
  if (!outcome.ok) {
    log({ event: 'auth_complete', requestId: info.requestId, outcome: 'rejected', code: outcome.code });
    return failed(env, outcome.code);
  }
  // One batch: the session, the user's sign-in time and current verified address (display only; notices go to it), and
  // the audit row.
  const s = await sessionInsert(db, { userId: outcome.userId, hd: id.hd, now, country: info.country, ipPrefix: ipPrefix(info.clientIp) });
  const actor: Actor = { kind: 'member', id: outcome.userId, sub: id.sub, email: id.email, sessionHash: b64url(s.idHash) };
  const w: Writer = { actor, requestId: info.requestId, now, ipPrefix: ipPrefix(info.clientIp), country: info.country };
  await db.batch([
    s.stmt,
    db.prepare('UPDATE console_users SET last_sign_in_at = ?, email = ? WHERE id = ?').bind(now, id.email, outcome.userId),
    auditInsert(db, entry(w, 'session.signed_in', { target: outcome.userId, details: { invite: outcome.viaInvite } })),
  ]);
  log({ event: 'auth_complete', requestId: info.requestId, outcome: 'ok' });
  return redirect(`${env.CONSOLE_ORIGIN}/`, [sessionCookie(s.cookieValue), clearFlowCookie(PRE_COOKIE)]);
}

/** `POST /api/auth/logout` → `{}`: revokes this session and clears its cookie. */
export async function logout(_request: Request, env: Env, info: RequestInfo, session: Session): Promise<Response> {
  const now = Date.now();
  await revokeSession(env.CONSOLE_DB, session.idHash, now);
  const actor: Actor = { kind: 'member', id: session.userId, sub: session.sub, email: session.email, sessionHash: b64url(session.idHash) };
  try {
    await auditInsert(env.CONSOLE_DB, entry({ actor, requestId: info.requestId, now, ipPrefix: ipPrefix(info.clientIp), country: info.country }, 'session.signed_out', { target: session.userId })).run();
  } catch (err) {
    log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
  }
  return json(200, {}, { 'set-cookie': clearSessionCookie() });
}
