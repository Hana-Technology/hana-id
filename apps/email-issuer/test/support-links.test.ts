// The support pages' presses (D866): `POST /v1/email/unlock` and `POST /v1/email/confirm`, the second half of the
// staff unlock and unsuppress mails. Each press needs the mailed token, of its own action, live, for the exact address
// it was mailed to; it is the only thing that changes state (a GET, a scanner opening the link, does nothing); it is
// limited per IP and per token, audited without the token, and answers no more than the token's holder knows.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LINK_PRESS_STAFF, STAFF_NOTES } from '../src/handlers.ts';
import { suppressionKey } from '../src/keys.ts';
import { IP_LINK_LIMITS, LINK_TOKEN_LIMITS, LINK_TOMBSTONE_MS, UNLOCK_GRANT_TTL_MS } from '../src/limits.ts';
import { supportLinkName, tokenHash } from '../src/support-link.ts';
import { AUTH, captureLogs, env, mailboxObject, seedApp, sessionCommitment, staffHarness, uid, type Harness, type TestApp } from './helpers.ts';

const DAY = 86_400_000;
const unlockTokenIn = (text: string): string => /#(ug1\.[A-Za-z0-9_-]{43})/u.exec(text)![1]!;
const confirmTokenIn = (text: string): string => /#(uc1\.[A-Za-z0-9_-]{43})/u.exec(text)![1]!;
const codeOf = async (r: Response): Promise<string> => ((await r.json()) as { code: string }).code;

/** 18 failed checks from four requesters trip the mailbox's backstop: a new requester is refused (D198). */
async function lockOut(h: Harness, app: TestApp, email: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const ip = `203.0.113.${100 + i}`;
    const s = (await (await h.call('/v1/email/start', { pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json }, { ip })).json()) as { challengeId: string };
    const wrong = h.sender.codeFor(email) === '000000' ? '111111' : '000000';
    for (let k = 0; k < 5; k++) await h.call('/v1/email/verify', { challengeId: s.challengeId, code: wrong }, { ip });
  }
}

const startAs = (h: Harness, app: TestApp, email: string, extra: Record<string, unknown> = {}, ip = '198.18.0.9') =>
  h.call('/v1/email/start', { pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json, ...extra }, { ip });

async function suppress(h: Harness, email: string, reason: 'bounce' | 'complaint' = 'complaint'): Promise<void> {
  await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await suppressionKey(await h.deps.keys(), email), reason, h.clock.now).run();
}

const fresh = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;

describe('POST /v1/email/unlock (the unlock page’s button, D866)', () => {
  it('nothing happens until the press; the press lets the one start through; the page learns the address and the end', async () => {
    const { h, ask } = await staffHarness();
    h.clock.now = Date.UTC(2027, 2, 2, 8);
    const app = await seedApp(h);
    const a = fresh('ul');
    await lockOut(h, app, a);
    expect((await startAs(h, app, a)).status).toBe(429);
    const staff = await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-100' });
    expect(await staff.json()).toEqual({ mailed: true, note: STAFF_NOTES.unlockMailed });
    const token = unlockTokenIn(h.sender.to(a).at(-1)!.text);
    // A link scanner or a preview opening the page (GET, any method but POST) changes nothing.
    for (const method of ['GET', 'HEAD', 'PUT']) expect((await h.call('/v1/email/unlock', method === 'GET' || method === 'HEAD' ? undefined : { token }, { method })).status).toBe(405);
    expect((await startAs(h, app, a, { unlockToken: token })).status).toBe(429);
    // The press.
    const { result, lines } = await captureLogs(() => h.call('/v1/email/unlock', { token }));
    expect(result.status).toBe(200);
    expect(result.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ unlocked: true, email: a, expiresAtMs: h.clock.now + UNLOCK_GRANT_TTL_MS });
    for (const l of lines) {
      expect(l).not.toContain(token);
      expect(l).not.toContain(a);
    }
    expect(lines.some((l) => l.includes('"event":"unlock_link_pressed"'))).toBe(true);
    // Pressing again before signing in answers the same (a second browser, a reload), with one audit row.
    expect((await h.call('/v1/email/unlock', { token })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT staff, action, ticket, subject, detail FROM email_admin_audit WHERE ticket = 'SUP-100' ORDER BY id").all<Record<string, string>>();
    expect(rows.results.map((r) => [r.staff, r.action, r.ticket, r.detail])).toEqual([
      ['staff@example.com', 'unlock', 'SUP-100', null],
      [LINK_PRESS_STAFF, 'unlock', 'SUP-100', '{"step":"link_pressed"}'],
    ]);
    expect(rows.results[1]!.subject).toBe(rows.results[0]!.subject);
    expect(JSON.stringify(rows.results)).not.toContain(a);
    // Anyone else is still refused; the token's start passes and signs in; then the link is used.
    expect((await startAs(h, app, a)).status).toBe(429);
    const s = await startAs(h, app, a, { unlockToken: token });
    expect(s.status).toBe(202);
    const cid = ((await s.json()) as { challengeId: string }).challengeId;
    expect((await h.call('/v1/email/verify', { challengeId: cid, code: h.sender.codeFor(a) }, { ip: '198.18.0.9' })).status).toBe(200);
    const used = await h.call('/v1/email/unlock', { token });
    expect([used.status, await codeOf(used)]).toEqual([410, 'link_used']);
    expect((await startAs(h, app, a, { unlockToken: token })).status).toBe(429);
  });

  it('clears no lock and no counter: the unlock lets the token’s one start through, nothing else (D198)', async () => {
    const { h, ask } = await staffHarness();
    h.clock.now = Date.UTC(2027, 2, 3, 8);
    const app = await seedApp(h);
    const a = fresh('uc');
    await lockOut(h, app, a);
    const box = await mailboxObject(h, a);
    const before = await runInDurableObject(box, (_o, state) => [...state.storage.kv.list<unknown>()].filter(([k]) => k.startsWith('wrong:') || k.startsWith('trip@') || k.startsWith('lock:')));
    await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-101' });
    expect((await h.call('/v1/email/unlock', { token: unlockTokenIn(h.sender.to(a).at(-1)!.text) })).status).toBe(200);
    const after = await runInDurableObject(box, (_o, state) => [...state.storage.kv.list<unknown>()].filter(([k]) => k.startsWith('wrong:') || k.startsWith('trip@') || k.startsWith('lock:')));
    expect(after).toEqual(before);
    expect((await startAs(h, app, a, {}, '198.18.0.10')).status).toBe(429);
  });

  it('bound to the exact address it was mailed to: another +tag of the same mailbox gets nothing from it', async () => {
    const { h, ask } = await staffHarness();
    h.clock.now = Date.UTC(2027, 2, 4, 8);
    const app = await seedApp(h);
    const local = `ut${uid().replace(/[^a-z0-9]/gu, '')}`;
    const a = `${local}@example.com`;
    await lockOut(h, app, a);
    await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-102' });
    const token = unlockTokenIn(h.sender.to(a).at(-1)!.text);
    expect((await h.call('/v1/email/unlock', { token })).status).toBe(200);
    expect((await startAs(h, app, `${local}+other@example.com`, { unlockToken: token })).status).toBe(429);
    // Still there for the address itself.
    expect((await startAs(h, app, a, { unlockToken: token })).status).toBe(202);
  });

  it('a wrong-action, malformed, tampered or unknown token is not valid; expired after 24 h, then gone after a week', async () => {
    const { h, ask } = await staffHarness();
    h.clock.now = Date.UTC(2027, 2, 5, 8);
    const app = await seedApp(h);
    const a = fresh('ux');
    await lockOut(h, app, a);
    await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-103' });
    const token = unlockTokenIn(h.sender.to(a).at(-1)!.text);
    const press = async (body: unknown, path = '/v1/email/unlock') => {
      const r = await h.call(path, body);
      return [r.status, await codeOf(r)];
    };
    // The other action's endpoint, a token of the other action's form, a changed character, an unknown token.
    expect(await press({ token }, '/v1/email/confirm')).toEqual([400, 'link_invalid']);
    expect(await press({ token: `uc1.${token.slice(4)}` })).toEqual([400, 'link_invalid']);
    expect(await press({ token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` })).toEqual([400, 'link_invalid']);
    expect(await press({ token: `ug1.${'C'.repeat(43)}` })).toEqual([400, 'link_invalid']);
    expect(await press({ token: 'ug1.short' })).toEqual([400, 'link_invalid']);
    expect(await press({ token, extra: 1 })).toEqual([400, 'bad_request']);
    expect(await press('ug1')).toEqual([400, 'bad_request']);
    // A record whose sealed address was changed opens to nothing.
    const stub = env.EMAIL_CHALLENGE.get(env.EMAIL_CHALLENGE.idFromName(supportLinkName('unlock', token)));
    const saved = await runInDurableObject(stub, (_o, state) => state.storage.kv.get<Record<string, unknown>>('support'));
    expect(JSON.stringify(saved)).not.toContain(a);
    await runInDurableObject(stub, (_o, state) => state.storage.kv.put('support', { ...saved, emailEnc: `${(saved!.emailEnc as string).slice(0, -2)}AA` }));
    expect(await press({ token })).toEqual([400, 'link_invalid']);
    await runInDurableObject(stub, (_o, state) => state.storage.kv.put('support', saved));
    // Past 24 h: expired (the press and the grant), and the start gets nothing from it.
    h.clock.now += UNLOCK_GRANT_TTL_MS + 1;
    expect(await press({ token })).toEqual([410, 'link_expired']);
    // (The UTC day has turned, so the lock itself is over; the grant would no longer count for a start anyway.)
    expect(await (await mailboxObject(h, a)).activateGrant(tokenHash(token), await suppressionKey(await h.deps.keys(), a), h.clock.now)).toBe('expired');
    // The alarm keeps only a tombstone (no address, no keys, no reference), still "expired"; a week later nothing.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const tomb = await runInDurableObject(stub, (_o, state) => state.storage.kv.get<Record<string, unknown>>('support'));
    expect(Object.keys(tomb!).sort()).toEqual(['action', 'expiresAtMs', 'usedAtMs']);
    expect(await press({ token })).toEqual([410, 'link_expired']);
    // A tombstone older than LINK_TOMBSTONE_MS is deleted by its alarm: the token is then simply unknown.
    await runInDurableObject(stub, (_o, state) => state.storage.kv.put('support', { ...tomb, expiresAtMs: Date.now() - LINK_TOMBSTONE_MS - 1 }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await press({ token })).toEqual([400, 'link_invalid']);
  });

  it('limited per IP and per token (the token’s window counts every presser)', async () => {
    const { h, ask } = await staffHarness();
    const app = await seedApp(h);
    const a = fresh('ur');
    await lockOut(h, app, a);
    await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-104' });
    const token = unlockTokenIn(h.sender.to(a).at(-1)!.text);
    const ip = '192.0.2.77';
    for (let i = 0; i < IP_LINK_LIMITS[0]!.max; i++) expect((await h.call('/v1/email/unlock', { token: `ug1.${String(i).padStart(43, 'Z')}` }, { ip })).status).toBe(400);
    const limited = await h.call('/v1/email/unlock', { token }, { ip });
    expect([limited.status, await codeOf(limited)]).toEqual([429, 'rate_limited']);
    // The same token from many IPs: its own window.
    for (let i = 0; i < LINK_TOKEN_LIMITS[0]!.max; i++) expect((await h.call('/v1/email/unlock', { token }, { ip: `192.0.2.${10 + i}` })).status).toBe(200);
    expect((await h.call('/v1/email/unlock', { token }, { ip: '192.0.2.99' })).status).toBe(429);
    // A press needs the sign-in site's origin and a client address.
    expect((await h.call('/v1/email/unlock', { token }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.call('/v1/email/unlock', { token }, { origin: null })).status).toBe(403);
    expect((await h.call('/v1/email/unlock', { token }, { ip: null })).status).toBe(400);
  });

  it('staff: a suppressed address gets no mail and keeps the day’s place; a refused mail gives the place back', async () => {
    const { h, ask } = await staffHarness();
    h.clock.now = Date.UTC(2027, 2, 6, 8);
    const a = fresh('us');
    await suppress(h, a);
    expect(await (await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-105' })).json()).toEqual({ mailed: false, reason: 'suppressed', note: STAFF_NOTES.suppressed });
    await env.DB.prepare('DELETE FROM email_suppressions WHERE email_key = ?1').bind(await suppressionKey(await h.deps.keys(), a)).run();
    h.sender.next = { ok: false, reason: 'unavailable', providerStatus: 503 };
    expect(await (await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-106' })).json()).toEqual({ mailed: false, note: STAFF_NOTES.notMailed });
    h.sender.next = { ok: true };
    expect(await (await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-107' })).json()).toEqual({ mailed: true, note: STAFF_NOTES.unlockMailed });
    expect((await ask('/v1/email/admin/unlock', { email: a, ticket: 'SUP-108' })).status).toBe(429);
  });
});

describe('POST /v1/email/confirm (the confirm page’s button, D866)', () => {
  it('resumes mail to that exact address only, once; audited with the staff row’s ticket; GET does nothing', async () => {
    const { h, ask } = await staffHarness();
    const app = await seedApp(h);
    const local = `cf${uid().replace(/[^a-z0-9]/gu, '')}`;
    const a = `${local}@example.com`;
    const tagged = `${local}+x@example.com`;
    await suppress(h, a);
    await suppress(h, tagged, 'bounce');
    expect((await ask('/v1/email/admin/unsuppress', { email: a, ticket: 'SUP-200' })).status).toBe(200);
    const token = confirmTokenIn(h.sender.to(a).at(-1)!.text);
    expect((await h.call('/v1/email/confirm', undefined, { method: 'GET' })).status).toBe(405);
    await startAs(h, app, a);
    expect(h.sender.to(a).filter((m) => m.kind === 'code')).toHaveLength(0);
    const { result, lines } = await captureLogs(() => h.call('/v1/email/confirm', { token }));
    expect(await result.json()).toEqual({ confirmed: 'unsuppress', email: a });
    for (const l of lines) {
      expect(l).not.toContain(token);
      expect(l).not.toContain(a);
    }
    await startAs(h, app, a);
    expect(h.sender.to(a).filter((m) => m.kind === 'code')).toHaveLength(1);
    // Only that address: the +tag stays suppressed.
    await startAs(h, app, tagged);
    expect(h.sender.to(tagged)).toHaveLength(0);
    const again = await h.call('/v1/email/confirm', { token });
    expect([again.status, await codeOf(again)]).toEqual([410, 'link_used']);
    const rows = await env.DB.prepare("SELECT staff, action, detail FROM email_admin_audit WHERE ticket = 'SUP-200' ORDER BY id").all<Record<string, string>>();
    expect(rows.results).toEqual([
      { staff: 'staff@example.com', action: 'unsuppress', detail: null },
      { staff: LINK_PRESS_STAFF, action: 'unsuppress', detail: '{"step":"confirmed"}' },
    ]);
  });

  it('an unlock token, a tampered or unknown one is not valid; expired after 24 h; limited per token', async () => {
    const { h, ask } = await staffHarness();
    const a = fresh('cx');
    await suppress(h, a);
    await ask('/v1/email/admin/unsuppress', { email: a, ticket: 'SUP-201' });
    const token = confirmTokenIn(h.sender.to(a).at(-1)!.text);
    const press = async (t: string, path = '/v1/email/confirm', ip?: string) => {
      const r = await h.call(path, { token: t }, ip ? { ip } : {});
      return [r.status, await codeOf(r)];
    };
    expect(await press(token, '/v1/email/unlock')).toEqual([400, 'link_invalid']);
    expect(await press(`ug1.${token.slice(4)}`)).toEqual([400, 'link_invalid']);
    expect(await press(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toEqual([400, 'link_invalid']);
    // One well-formed token pressed from ten IPs uses its own window: the eleventh press is refused.
    const unknown = `uc1.${'D'.repeat(43)}`;
    for (let i = 0; i < LINK_TOKEN_LIMITS[0]!.max; i++) expect(await press(unknown, '/v1/email/confirm', `192.0.2.${120 + i}`)).toEqual([400, 'link_invalid']);
    expect(await press(unknown, '/v1/email/confirm', '192.0.2.140')).toEqual([429, 'rate_limited']);
    h.clock.now += DAY + 1;
    expect(await press(token)).toEqual([410, 'link_expired']);
    // Still suppressed.
    expect(await env.DB.prepare('SELECT 1 AS x FROM email_suppressions WHERE email_key = ?1').bind(await suppressionKey(await h.deps.keys(), a)).first('x')).toBe(1);
  });

  it('a D1 failure after the press gives the link back: the user can press again', async () => {
    const { h, ask } = await staffHarness();
    const a = fresh('cd');
    await suppress(h, a);
    await ask('/v1/email/admin/unsuppress', { email: a, ticket: 'SUP-202' });
    const token = confirmTokenIn(h.sender.to(a).at(-1)!.text);
    const db = h.deps.env.DB;
    h.deps.env = { ...h.deps.env, DB: { ...db, prepare: db.prepare.bind(db), batch: async () => Promise.reject(new Error('d1 down')) } as unknown as typeof db };
    expect((await h.call('/v1/email/confirm', { token })).status).toBe(500);
    h.deps.env = { ...h.deps.env, DB: db };
    expect(await (await h.call('/v1/email/confirm', { token })).json()).toEqual({ confirmed: 'unsuppress', email: a });
  });
});
