// Helpers of C10's tests: a signed-in member with a known session cookie (seeded, so a test doesn't run a whole sign-in
// for each role), JSON calls with it, and a fresh sign-in (step-up) driven through the real routes: `POST
// /api/orgs/:org/actions`, `POST /api/actions/:id/google`, the auth origin's `/start` and `/callback` (AuthHandler) with
// the browser's flow cookie, and the mocked Google in between.
import { b64url, randomBytes, sha256 } from '@hana-id/console-core';
import { type ClaimEdits, type GoogleAccount, type MockGoogle, authOrigin, setCookie } from './google.ts';
import { CSRF, db, request, seedOrg, uid } from './helpers.ts';

export interface Member {
  org: string;
  userId: string;
  sub: string;
  email: string;
  /** The session cookie's value. */
  cs: string;
  idHash: Uint8Array;
  account: GoogleAccount;
}

/** A member of `org` (a fresh one by default) with a live session; `hd` is the session's Workspace domain. */
export async function member(role: 'owner' | 'viewer', o: { org?: string; hd?: string | null; status?: 'active' | 'frozen' } = {}): Promise<Member> {
  const org = o.org ?? (await seedOrg({ status: o.status ?? 'active' }));
  const userId = `usr_${b64url(randomBytes(12)).replace(/[^A-Za-z0-9]/gu, 'x')}`;
  const sub = `1${Math.floor(Math.random() * 1e15)}`;
  const email = `m-${uid()}@partner.example`;
  const now = Date.now();
  await db.prepare('INSERT INTO console_users (id, provider, sub, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(userId, 'google', sub, email, now).run();
  await db.prepare('INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').bind(org, userId, role, now, 'test', now).run();
  const cookie = randomBytes(32);
  const cs = b64url(cookie);
  const idHash = await sha256(cookie);
  await db.prepare('INSERT INTO console_sessions (id_hash, user_id, hd, auth_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(idHash, userId, o.hd ?? null, now, now, now + 12 * 3600_000).run();
  return { org, userId, sub, email, cs, idHash, account: { sub, email } };
}

export const cookieOf = (m: Pick<Member, 'cs'>) => `__Host-hana_cs=${m.cs}`;

/** A GET with the member's session. */
export async function getAs<T = Record<string, unknown>>(m: Pick<Member, 'cs'>, path: string): Promise<{ status: number; body: T; res: Response }> {
  const res = await request(path, { headers: { cookie: cookieOf(m) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, res };
}

/**
 * The test API's ConsoleRpc budget is the production one (30 statements a second across orgs, D228), which a suite
 * running back to back can exceed: wait it out, so a test sees its own answer rather than the budget's.
 */
export const breathe = (ms = 1100) => new Promise((r) => setTimeout(r, ms));

/** A POST with the member's session and the CSRF headers (retried while the API's shared budget refuses). */
export async function postAs<T = Record<string, unknown>>(m: Pick<Member, 'cs'>, path: string, body: unknown = {}): Promise<{ status: number; body: T }> {
  for (let i = 0; ; i++) {
    const res = await request(path, { method: 'POST', body, headers: { ...CSRF, cookie: cookieOf(m) } });
    const text = await res.text();
    if (res.status === 429 && i < 8 && text.includes('Too many console calls')) {
      await breathe();
      continue;
    }
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }
}

export interface Created {
  id: string;
  kind: string;
  decoded: Record<string, unknown>;
  expiresAt: number;
}

/** `POST /api/orgs/:org/actions`, expecting 200. */
export async function createAction(m: Member, kind: string, params: unknown): Promise<Created> {
  const r = await postAs<Created & { error?: { code: string; message: string } }>(m, `/api/orgs/${m.org}/actions`, { kind, params });
  if (r.status !== 200) throw new Error(`createAction ${kind}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export interface StepUp {
  start: { status: number; body: Record<string, unknown> };
  toGoogle?: Response;
  nonce?: string;
  scope?: string;
  loginHint?: string | null;
  callback?: Response;
  /** Where the callback sent the browser (`/actions/:id#`), relative. */
  landing?: string | null;
}

/** The fresh sign-in for an action, as `account` at Google (the member's own by default), with claim edits. */
export async function stepUp(google: MockGoogle, m: Member, actionId: string, o: { account?: GoogleAccount; edits?: ClaimEdits; afCookie?: string | null; beforeCallback?: () => Promise<void> } = {}): Promise<StepUp> {
  const start = await postAs(m, `/api/actions/${actionId}/google`, {});
  const out: StepUp = { start };
  if (start.status !== 200) return out;
  const u = new URL(start.body.startUrl as string);
  out.toGoogle = await authOrigin(`${u.pathname}${u.search}`);
  if (out.toGoogle.status !== 303) return out;
  const af = setCookie(out.toGoogle, '__Host-hana_af');
  const { code, auth } = google.authorize(out.toGoogle.headers.get('location')!, o.account ?? m.account, o.edits);
  out.nonce = auth.nonce;
  out.scope = auth.scope;
  out.loginHint = auth.loginHint;
  await o.beforeCallback?.();
  const cookie = o.afCookie === null ? undefined : `__Host-hana_af=${o.afCookie ?? af}`;
  out.callback = await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, cookie ? { cookie } : {});
  out.landing = out.callback.headers.get('location')?.replace('https://console.test', '') ?? null;
  return out;
}

/** `GET /api/actions/:id` as the member. */
export const actionOf = (m: Member, id: string) => getAs<{ status: string; kind: string; decoded: Record<string, unknown>; outcome?: Record<string, unknown> }>(m, `/api/actions/${id}`);

