// D931 (piece P10 of docs/partner-platform-spec.md, A15): the admin Worker's part of a second person's confirmation of
// web addresses, against the real API (pendingNotices, ackNotice, confirmStaffOrigins, confirmationNotices,
// ackConfirmationNotice) and console (listMembers), with their migrations' triggers:
// - a platform request's email and a staff request's under four eyes (a platform-created app or a shared wallet) go to
//   the alias, every security contact and every owner (not viewers, not disabled owners); each states its real wait
//   ("or sooner if an owner / a second person confirms"), carries the Confirm link to the partner portal's page (text
//   and HTML) beside its cancel links, and never the waiver sentence; owners unreadable: nothing sent or acked;
// - the confirmation's notice: one email per confirmation to the same people, naming who confirmed (a member by their
//   address from the org's current members, "a former member" otherwise; staff as "Journear staff") and, for a staff
//   proposal, who added them; one removal link per web address (HMAC(CANCEL_LINK_KEY, origin-remove ‖ id)), acked with
//   each link's sha256 only after every send was accepted; a retry sends the same links; the budget;
// - the staff route POST /api/platform/confirm-staff-origins: the Access identity as the actor, CSRF and Access as every
//   staff POST, the reason's length, the API's refusals passed through (the proposer, the same email, a platform one).
import { b64url, linkToken, linkTokenHash, newId, newPublishableKey, parsePlatformPublicKey } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeNotice } from '../src/env.ts';
import { Budget } from '../src/mail.ts';
import { runChangeNotices, runConfirmationNotices, runNotices } from '../src/notices.ts';
import { ADMIN, ALIAS, CONSOLE, CSRF, FakeEmail, STAFF_EMAIL, STAFF_SUB, adminRequest, envWith, hotVersion, json, linkIn, overrideBinding, seedConsoleMember, seedConsoleOrg, seedHotApp, sha256Hex, staffJwt, stubNetwork, tokenOf, uid, visibleText } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const big = () => new Budget(1000);
const hot = () => env.HOT_DB;
const KEY = new Uint8Array(32).fill(1);
const SECOND = { email: 'second@hana.example', sub: '22222222-3333-4444-8555-666666666666' };
const REASON = 'Checked with the owner on a call to their listed number';
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/gu)].map((x) => x[1]!);

/** A staff request to the admin Worker with a second staff member on its list (the suite's manifest has one). */
async function asStaff(path: string, body: unknown, who: { email: string; sub: string } = SECOND, o: { csrf?: boolean } = {}): Promise<Response> {
  const worker = (await import('../src/index.ts')).default as unknown as { fetch: (r: Request, e: typeof env, c: ExecutionContext) => Promise<Response> };
  const headers = new Headers({ ...(o.csrf === false ? { 'content-type': 'application/json' } : CSRF), 'cf-access-jwt-assertion': await staffJwt({ email: who.email, sub: who.sub }), 'cf-connecting-ip': '198.51.100.9' });
  return worker.fetch(new Request(`${ADMIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), envWith({ STAFF_EMAILS: JSON.stringify([STAFF_EMAIL, SECOND.email]) }), createExecutionContext());
}

/** An org in the console (two owners, a viewer, a disabled owner) and its test app on a shared wallet in the API. */
async function network(o: { shared?: boolean } = {}) {
  const org = await seedConsoleOrg();
  const owner = await seedConsoleMember(org, 'owner');
  const other = await seedConsoleMember(org, 'owner');
  const viewer = await seedConsoleMember(org, 'viewer');
  const disabled = await seedConsoleMember(org, 'owner', { disabled: true });
  const app = await seedHotApp(org);
  if (o.shared !== false) await hot().prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(app.scope).run();
  return { org, owner, other, viewer, disabled, app };
}

/** Staff (the suite's staff member) add these web addresses through the staff route; their change ids, in order. */
async function staffAdds(app: { id: string; org: string }, origins: string[]): Promise<string[]> {
  const res = await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: origins, expectedVersion: (await hotVersion(app.id)).origins } });
  if (res.status !== 200) throw new Error(await res.text());
  const ids: string[] = [];
  for (const origin of origins) ids.push((await hot().prepare("SELECT id FROM guarded_changes WHERE app_id = ?1 AND origin = ?2 AND kind = 'origin_add'").bind(app.id, origin).first<{ id: string }>())!.id);
  return ids;
}

/** A platform key of the org and one request of its web addresses, as P4's proposal writes them. */
async function platformProposal(app: { id: string; org: string; scope: string }, origins: string[]): Promise<{ key: string; ids: string[] }> {
  const key = newId('platformKey');
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const p = await parsePlatformPublicKey(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  if (!p.ok) throw new Error(p.problem);
  await hot()
    .prepare(
      `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
       VALUES (?1, ?2, 'Partner backend', 'ES256', ?3, ?4, ?5, 'pending', 'member', 'usr_test', 'sub-test', 'owner@partner.example', ?6, 0, 86400000, ?7)`,
    )
    .bind(key, app.org, p.key.raw, p.key.thumbprint, JSON.stringify([app.scope]), Date.now(), `r_${key}`)
    .run();
  const request = `pf_${uid()}`;
  const ids: string[] = [];
  for (const origin of origins) {
    const id = newId('guardedChange');
    await hot().prepare('INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, app.id, origin, key, DAY, Date.now()).run();
    await hot()
      .prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', ?3, 'pending', 'platform', ?4, ?5, ?6)")
      .bind(id, app.id, origin, key, Date.now(), request)
      .run();
    await hot().prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)').bind(app.id, origin, id).run();
    ids.push(id);
  }
  return { key, ids };
}

const changeRow = (id: string) => hot().prepare('SELECT notified_at, active_from, waiver FROM guarded_changes WHERE id = ?1').bind(id).first<{ notified_at: number | null; active_from: number | null; waiver: string | null }>();
const confirmationRow = (id: string) =>
  hot()
    .prepare('SELECT confirmed_by_kind, confirmed_by, reason, notice_at, links_at, removal_until, notice_failures, CASE WHEN removal_token_hash IS NULL THEN NULL ELSE hex(removal_token_hash) END AS h, request_id FROM origin_confirmations WHERE change_id = ?1')
    .bind(id)
    .first<{ confirmed_by_kind: string; confirmed_by: string; reason: string | null; notice_at: number | null; links_at: number | null; removal_until: number | null; notice_failures: number; h: string | null; request_id: string }>();

describe('a platform request’s email (D930, with D931’s owners and Confirm link)', () => {
  it('goes to every owner too (not viewers, not disabled owners); “or sooner if an owner … confirms them”; the Confirm link in text and HTML; no waiver', async () => {
    const { owner, other, viewer, disabled, app } = await network({ shared: false });
    const { ids } = await platformProposal(app, [`https://one-${uid().toLowerCase()}.partner.example`, `https://two-${uid().toLowerCase()}.partner.example`]);
    const fake = new FakeEmail();
    await runChangeNotices(env, fake, big());
    const mine = fake.sent.filter((m) => ids.every((id) => m.text.includes(`/cancel/${id}`)));
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, app.contact, owner.email, other.email].sort());
    expect(mine.map((m) => m.to)).not.toContain(viewer.email);
    expect(mine.map((m) => m.to)).not.toContain(disabled.email);
    for (const m of mine) {
      const words = visibleText(m.html);
      for (const text of [m.text.replace(/\s+/gu, ' '), words]) {
        expect(text).toMatch(/They start working no sooner than \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC, at least 24 hours after this email, or sooner if an owner of your organisation confirms them, unless someone cancels them\./u);
        expect(text).toContain('Check and confirm in the partner portal');
        expect(text).toContain('That link only opens the partner portal. An owner of your organisation checks and confirms them there, after signing in again with Google. Opening the link alone changes nothing.');
        expect(text).not.toMatch(/waiver|nothing makes them start sooner|always wait the full time/iu);
      }
      // The request's first change opens the page; the cancel links stay, one per web address.
      const links = hrefs(m.html);
      const first = /\/cancel\/(gc_[^#]+)#/u.exec(links[0]!)![1]!;
      expect(ids).toContain(first);
      expect(links.filter((h) => h === `${CONSOLE}/confirm/${first}`)).toHaveLength(1);
      expect(links.filter((h) => h.startsWith(`${CONSOLE}/cancel/`))).toHaveLength(2);
      expect(links).toHaveLength(3);
      expect(m.text).toContain(`${CONSOLE}/confirm/${first}`);
    }
    for (const id of ids) expect((await changeRow(id))!.notified_at).not.toBeNull();
  });

  it('one web address: “It starts … or sooner if an owner of your organisation confirms it, unless someone cancels it.”', async () => {
    const { app } = await network({ shared: false });
    const { ids } = await platformProposal(app, [`https://solo-${uid().toLowerCase()}.partner.example`]);
    const fake = new FakeEmail();
    await runChangeNotices(env, fake, big());
    const [m] = fake.sent.filter((x) => x.to === ALIAS && x.text.includes(`/cancel/${ids[0]}`));
    expect(m!.text.replace(/\s+/gu, ' ')).toMatch(/It starts working no sooner than .+ UTC, at least 24 hours after this email, or sooner if an owner of your organisation confirms it, unless someone cancels it\./u);
    expect(hrefs(m!.html)).toEqual([expect.stringMatching(new RegExp(`^${CONSOLE}/cancel/${ids[0]}#t=`, 'u')), `${CONSOLE}/confirm/${ids[0]}`]);
  });

  it('owners unreadable: nothing is sent or acked; the next run sends it', async () => {
    const { owner, app } = await network({ shared: false });
    const { ids } = await platformProposal(app, [`https://wait-${uid().toLowerCase()}.partner.example`]);
    const down = overrideBinding(env.CONSOLE, { listMembers: async () => ({ ok: false, code: 'upstream_unavailable' }) });
    const fake = new FakeEmail();
    await runChangeNotices(envWith({ CONSOLE: down }), fake, big());
    expect(fake.attempts.filter((m) => m.text.includes(ids[0]!))).toEqual([]);
    expect((await changeRow(ids[0]!))!.notified_at).toBeNull();
    await runChangeNotices(env, fake, big());
    expect(fake.sent.filter((m) => m.text.includes(ids[0]!)).map((m) => m.to)).toContain(owner.email);
    expect((await changeRow(ids[0]!))!.notified_at).not.toBeNull();
  });
});

describe('a staff request under four eyes (D931)', () => {
  it('a shared wallet: one email to the alias, every contact and every owner; its real wait, “or sooner if a second person confirms them”; the Confirm link; “Journear staff”; no waiver; acked with the full day', async () => {
    const { owner, other, viewer, app } = await network();
    const ids = await staffAdds(app, [`https://a-${uid().toLowerCase()}.partner.example`, 'https://xn--bcher-kva.example']);
    const fake = new FakeEmail();
    await runChangeNotices(env, fake, big());
    const mine = fake.sent.filter((m) => ids.every((id) => m.text.includes(`/cancel/${id}`)));
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, app.contact, owner.email, other.email].sort());
    expect(mine.map((m) => m.to)).not.toContain(viewer.email);
    // One email for the request, never one per web address.
    expect(fake.sent.filter((m) => ids.some((id) => m.text.includes(`/cancel/${id}`)))).toHaveLength(4);
    for (const m of mine) {
      expect(m.subject).toContain('New web addresses added by Journear staff for');
      for (const text of [m.text.replace(/\s+/gu, ' '), visibleText(m.html)]) {
        expect(text).toContain('Journear staff added 2 new web addresses for');
        // After PR 159's review: "Journear staff", never a staff member's Access id.
        expect(text).toContain('Journear staff');
        expect(text).not.toContain(STAFF_SUB);
        expect(text).toMatch(/They start working no sooner than .+ UTC, at least 24 hours after this email, or sooner if a second person confirms them, unless someone cancels them\. The second person is another Journear staff member, or an owner of your organisation in the partner portal\./u);
        expect(text).toContain('Check and confirm in the partner portal');
        expect(text).not.toMatch(/waiver|at once|loopback|no user has used/iu);
        expect(text).toContain('international letters');
        expect(text).toContain('https://bücher.example');
      }
      const links = hrefs(m.html);
      expect(links.filter((h) => h.startsWith(`${CONSOLE}/cancel/`))).toHaveLength(2);
      expect(links.filter((h) => h.startsWith(`${CONSOLE}/confirm/`))).toEqual([`${CONSOLE}/confirm/${/\/cancel\/(gc_[^#]+)#/u.exec(links[0]!)![1]}`]);
    }
    for (const id of ids) {
      const row = (await changeRow(id))!;
      expect(row.waiver).toBeNull();
      expect(row.active_from! - row.notified_at!).toBeGreaterThanOrEqual(DAY);
      const token = tokenOf(linkIn(mine[0]!.text, `/cancel/${id}`));
      expect([...token]).toEqual([...(await linkToken('cancelLink', KEY, id))]);
    }
  });

  it('a staff proposal on an app with no shared wallet keeps its own email (alias and contacts only, the env’s delay)', async () => {
    const { owner, app } = await network({ shared: false });
    const [id] = await staffAdds(app, [`https://plain-${uid().toLowerCase()}.partner.example`]);
    const fake = new FakeEmail();
    await runChangeNotices(env, fake, big());
    const mine = fake.sent.filter((m) => m.text.includes(`/cancel/${id}`));
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, app.contact].sort());
    expect(mine.map((m) => m.to)).not.toContain(owner.email);
    expect(mine[0]!.text).not.toContain('/confirm/');
  });
});

describe('the staff route POST /api/platform/confirm-staff-origins', () => {
  it('a second staff member confirms with a reason: in force at once, the Access identity as the actor', async () => {
    const { app } = await network();
    const ids = await staffAdds(app, [`https://c-${uid().toLowerCase()}.partner.example`]);
    await runChangeNotices(env, new FakeEmail(), big());
    const res = await asStaff('/api/platform/confirm-staff-origins', { orgId: app.org, appId: app.id, changeIds: ids, reason: REASON });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{ confirmedAt: number; changes: { changeId: string }[] }>(res);
    expect(body.changes.map((c) => c.changeId)).toEqual(ids);
    expect((await changeRow(ids[0]!))!.active_from).toBe(body.confirmedAt);
    expect(await confirmationRow(ids[0]!)).toMatchObject({ confirmed_by_kind: 'hana', confirmed_by: SECOND.sub, reason: REASON, notice_at: null });
    const ledger = await hot().prepare("SELECT actor_kind, actor_id FROM app_changes WHERE app_id = ?1 AND kind = 'origin.confirmed'").bind(app.id).all<{ actor_kind: string; actor_id: string }>();
    expect(ledger.results).toEqual([{ actor_kind: 'hana', actor_id: SECOND.sub }]);
  });

  it('refuses the proposer (by Access identity, and by email under another identity), passing the API’s words; a short reason; a platform proposal', async () => {
    const { app } = await network();
    const ids = await staffAdds(app, [`https://r-${uid().toLowerCase()}.partner.example`]);
    await runChangeNotices(env, new FakeEmail(), big());
    const body = { orgId: app.org, appId: app.id, changeIds: ids, reason: REASON };
    const own = await adminRequest('/api/platform/confirm-staff-origins', { body });
    expect(own.status).toBe(403);
    expect(await json(own)).toMatchObject({ error: { code: 'forbidden', message: expect.stringMatching(/can’t confirm it/u) } });
    const twin = await asStaff('/api/platform/confirm-staff-origins', body, { email: STAFF_EMAIL, sub: SECOND.sub });
    expect(twin.status).toBe(403);
    expect(await json(twin)).toMatchObject({ error: { code: 'forbidden', message: expect.stringMatching(/a second staff member, or an owner of the organisation, must/u) } });
    const short = await asStaff('/api/platform/confirm-staff-origins', { ...body, reason: 'too short' });
    expect(short.status).toBe(400);
    expect((await confirmationRow(ids[0]!))).toBeNull();
    // Staff never confirm what a platform key asked for: an owner does, in the partner portal.
    const p = await platformProposal(app, [`https://pf-${uid().toLowerCase()}.partner.example`]);
    await runChangeNotices(env, new FakeEmail(), big());
    const platform = await asStaff('/api/platform/confirm-staff-origins', { ...body, changeIds: p.ids });
    expect(platform.status).toBe(403);
    expect(await json(platform)).toMatchObject({ error: { code: 'forbidden', message: expect.stringMatching(/Only an owner of the organisation/u) } });
    // Fields the route doesn't take never reach the API (the actor is the Access identity, whatever the body says).
    const spoof = await asStaff('/api/platform/confirm-staff-origins', { ...body, actor: { kind: 'hana', id: 'someone-else', email: 'x@hana.example' } });
    expect(spoof.status).toBe(200);
    expect(await confirmationRow(ids[0]!)).toMatchObject({ confirmed_by: SECOND.sub });
  });

  it('as every staff POST: without the CSRF headers 403 csrf; without an Access sign-in 401; nothing confirmed', async () => {
    const { app } = await network();
    const ids = await staffAdds(app, [`https://x-${uid().toLowerCase()}.partner.example`]);
    await runChangeNotices(env, new FakeEmail(), big());
    const body = { orgId: app.org, appId: app.id, changeIds: ids, reason: REASON };
    const csrf = await asStaff('/api/platform/confirm-staff-origins', body, SECOND, { csrf: false });
    expect(csrf.status).toBe(403);
    expect(await json(csrf)).toMatchObject({ error: { code: 'csrf' } });
    expect((await adminRequest('/api/platform/confirm-staff-origins', { body, jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/platform/confirm-staff-origins', { method: 'GET' })).status).toBe(405);
    expect(await confirmationRow(ids[0]!)).toBeNull();
  });
});

describe('the confirmation’s notice (origin_confirmed)', () => {
  /** A staff request on a shared wallet, announced, then confirmed by the second staff member. */
  async function confirmedByStaff(origins: string[]) {
    const net = await network();
    const ids = await staffAdds(net.app, origins);
    await runChangeNotices(env, new FakeEmail(), big());
    const res = await asStaff('/api/platform/confirm-staff-origins', { orgId: net.app.org, appId: net.app.id, changeIds: ids, reason: REASON });
    if (res.status !== 200) throw new Error(await res.text());
    return { ...net, ids };
  }

  it('one email to the alias, every contact and every owner; both people named; one removal link per web address (7 days), acked with each link’s hash, once', async () => {
    const { owner, other, viewer, disabled, app, ids } = await confirmedByStaff([`https://d-${uid().toLowerCase()}.partner.example`, 'https://xn--bcher-kva.example']);
    const fake = new FakeEmail();
    const r = await runConfirmationNotices(env, fake, big());
    expect(r.acked).toBeGreaterThanOrEqual(1);
    const mine = fake.sent.filter((m) => ids.every((id) => m.text.includes(`/remove/${id}`)));
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, app.contact, owner.email, other.email].sort());
    expect(mine.map((m) => m.to)).not.toContain(viewer.email);
    expect(mine.map((m) => m.to)).not.toContain(disabled.email);
    for (const m of mine) {
      expect(m.subject).toContain(`Web addresses confirmed for Test ${app.id}`);
      for (const text of [m.text.replace(/\s+/gu, ' '), visibleText(m.html)]) {
        expect(text).toContain(`A second Journear staff member confirmed 2 web addresses for Test ${app.id}. They work there now. If this wasn’t meant to happen, remove them here: each stops at once.`);
        // Both people, as "Journear staff" (never their Access ids: after PR 159's review).
        expect(text).toContain('A Journear staff member added them. On this app, a web address Journear staff add needs a second person to confirm it: a second Journear staff member did.');
        expect(text).not.toContain(STAFF_SUB);
        expect(text).not.toContain(SECOND.sub);
        expect(text).toContain('Each link removes one web address and works for 7 days.');
        expect(text).toContain('international letters');
        expect(text).toContain('https://bücher.example');
        expect(text).toContain('Remove https://xn--bcher-kva.example');
        expect(text).not.toContain('Remove https://bücher.example');
        expect(text).not.toContain(SECOND.email);
      }
      const links = hrefs(m.html);
      expect(links).toHaveLength(2);
      for (const h of links) expect(h.startsWith(`${CONSOLE}/remove/`)).toBe(true);
    }
    for (const id of ids) {
      const token = tokenOf(linkIn(mine[0]!.text, `/remove/${id}`));
      expect([...token]).toEqual([...(await linkToken('originRemove', KEY, id))]);
      const row = (await confirmationRow(id))!;
      expect(row.h).toBe((await sha256Hex(token)).toUpperCase());
      expect(row.removal_until! - row.links_at!).toBe(7 * DAY);
      expect(row.notice_at).not.toBeNull();
    }
    // Once only.
    const again = new FakeEmail();
    await runConfirmationNotices(env, again, big());
    expect(again.sent.filter((m) => m.text.includes(ids[0]!))).toEqual([]);
  });

  it('a send refused for one recipient acks nothing; the retry goes to that recipient only, with the same links, and acks', async () => {
    const { app, ids } = await confirmedByStaff([`https://e-${uid().toLowerCase()}.partner.example`]);
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await runConfirmationNotices(env, fake, big());
    const first = (await confirmationRow(ids[0]!))!;
    expect(first.notice_at).toBeNull();
    // After PR 159's review: the link already works (armed before the first send), and the refused run is noted.
    expect(first.h).not.toBeNull();
    expect(first.notice_failures).toBe(1);
    const firstLink = linkIn(fake.attempts.find((m) => m.to === app.contact && m.text.includes(ids[0]!))!.text, `/remove/${ids[0]}`);
    expect(first.h).toBe((await sha256Hex(tokenOf(firstLink))).toUpperCase());
    // Not offered again within 5 minutes; then retried, to the refusing recipient only.
    await runConfirmationNotices(env, fake, big());
    expect(fake.attempts.filter((m) => m.to === app.contact && m.text.includes(ids[0]!))).toHaveLength(1);
    await hot().prepare('UPDATE origin_confirmations SET notice_failed_at = notice_failed_at - 600000 WHERE change_id = ?1').bind(ids[0]!).run();
    fake.failFor.clear();
    await runConfirmationNotices(env, fake, big());
    const row = (await confirmationRow(ids[0]!))!;
    expect(row.notice_at).not.toBeNull();
    expect(fake.attempts.filter((m) => m.to === ALIAS && m.text.includes(ids[0]!))).toHaveLength(1);
    const toContact = fake.attempts.filter((m) => m.to === app.contact && m.text.includes(ids[0]!));
    expect(toContact).toHaveLength(2);
    expect(linkIn(toContact[1]!.text, `/remove/${ids[0]}`)).toBe(firstLink);
    expect(row.h).toBe((await sha256Hex(tokenOf(firstLink))).toUpperCase());
  });

  it('a member confirmer is named by their address from the org’s members; one who left reads “a former member”; a platform proposal names its key', async () => {
    const { owner, app } = await network({ shared: false });
    const base = {
      app: { id: app.id, name: 'Coffee Club', orgId: app.org, scopeId: app.scope, environment: 'test' as const },
      contacts: [app.contact],
      confirmedByKind: 'member' as const,
      confirmedAt: Date.now(),
      proposedByKind: 'platform' as const,
      keyId: 'pkc_Wk7Hq2Lm9Xc4Pz',
      keyLabel: 'Production backend',
      changes: [{ changeId: newId('guardedChange'), origin: 'https://order.coffeeclub.example', display: 'https://order.coffeeclub.example', idn: false }],
    };
    const notices = [
      { ...base, requestId: `rq_${uid()}`, confirmedBy: owner.id },
      { ...base, requestId: `rq_${uid()}`, confirmedBy: newId('user'), changes: [{ ...base.changes[0]!, changeId: newId('guardedChange') }] },
    ];
    const acks: unknown[] = [];
    const arms: unknown[] = [];
    const api = overrideBinding(env.API, {
      confirmationNotices: async () => ({ ok: true, notices: notices.map((n) => ({ ...n, failures: 0 })) }),
      armConfirmationLinks: async (c: unknown) => {
        arms.push(c);
        return { ok: true, removalUntil: Date.now() + 7 * DAY };
      },
      ackConfirmationNotice: async (c: unknown) => {
        acks.push(c);
        return { ok: true };
      },
    });
    const fake = new FakeEmail();
    const r = await runConfirmationNotices(envWith({ API: api }), fake, big());
    expect(r).toEqual({ acked: 2, failed: 0, skipped: 0 });
    const [named] = fake.to(ALIAS).filter((m) => m.text.includes(notices[0]!.changes[0]!.changeId));
    expect(named!.subject).toContain('Web address confirmed for Coffee Club');
    expect(named!.text.replace(/\s+/gu, ' ')).toContain(`${owner.email} confirmed https://order.coffeeclub.example for Coffee Club. It works there now. If this wasn’t meant to happen, remove it here: it stops at once.`);
    expect(named!.text).toContain('your platform key “Production backend” (pkc_Wk7Hq2Lm9Xc4Pz)');
    expect(named!.text).toContain('The link works for 7 days.');
    const [gone] = fake.to(ALIAS).filter((m) => m.text.includes(notices[1]!.changes[0]!.changeId));
    expect(gone!.text).toContain('A former member confirmed https://order.coffeeclub.example');
    // Each arming (before the sends) names exactly its confirmation's web addresses, with the hash of the link that went
    // out; each ack then names the confirmation.
    expect(arms).toHaveLength(2);
    expect(acks).toHaveLength(2);
    const arm = arms[0] as { actor: { kind: string }; requestId: string; removals: { changeId: string; removalTokenHash: string }[] };
    expect(arm.actor.kind).toBe('system');
    expect(arm.requestId).toBe(notices[0]!.requestId);
    expect((acks[0] as { requestId: string }).requestId).toBe(notices[0]!.requestId);
    const token = tokenOf(linkIn(named!.text, `/remove/${notices[0]!.changes[0]!.changeId}`));
    expect(arm.removals).toEqual([{ changeId: notices[0]!.changes[0]!.changeId, removalTokenHash: b64url(await linkTokenHash(token)) }]);
    // Never the token itself in an arming or an ack.
    expect(JSON.stringify([...arms, ...acks])).not.toContain(/#t=([^\s]+)/u.exec(linkIn(named!.text, '/remove/'))![1]);
  });

  it('a failing one doesn’t hold back the next; owners unreadable or an ack refused leave it for the next run', async () => {
    const { app } = await network({ shared: false });
    const mk = (n: number) => ({
      requestId: `rq_${uid()}`,
      app: { id: app.id, name: `App ${n}`, orgId: n === 0 ? 'org_unreadable' : app.org, scopeId: app.scope, environment: 'test' as const },
      contacts: [app.contact],
      confirmedByKind: 'hana' as const,
      confirmedBy: SECOND.sub,
      confirmedAt: Date.now(),
      proposedByKind: 'hana' as const,
      proposedBy: STAFF_SUB,
      changes: [{ changeId: newId('guardedChange'), origin: `https://n${n}.partner.example`, display: `https://n${n}.partner.example`, idn: false }],
    });
    const notices = [mk(0), mk(1), mk(2)];
    const acked: string[] = [];
    const api = overrideBinding(env.API, {
      confirmationNotices: async () => ({ ok: true, notices: notices.map((n) => ({ ...n, failures: 0 })) }),
      armConfirmationLinks: async () => ({ ok: true, removalUntil: 0 }),
      ackConfirmationNotice: async (c: unknown) => {
        const id = (c as { requestId: string }).requestId;
        if (id === notices[1]!.requestId) return { ok: false, code: 'not_pending' };
        acked.push(id);
        return { ok: true };
      },
    });
    const members = overrideBinding(env.CONSOLE, { listMembers: async (c: unknown) => ((c as { orgId: string }).orgId === 'org_unreadable' ? { ok: false, code: 'upstream_unavailable' } : env.CONSOLE.listMembers(c)) });
    const fake = new FakeEmail();
    const r = await runConfirmationNotices(envWith({ API: api, CONSOLE: members }), fake, big());
    expect(r).toEqual({ acked: 1, failed: 2, skipped: 0 });
    expect(acked).toEqual([notices[2]!.requestId]);
    expect(fake.attempts.filter((m) => m.text.includes('n0.partner.example'))).toEqual([]);
  });

  it('without room for the lookup, every email and the ack, it waits whole: nothing sent, nothing acked', async () => {
    const { ids } = await confirmedByStaff([`https://f-${uid().toLowerCase()}.partner.example`]);
    const all = (await env.API.confirmationNotices({ actor: { kind: 'system', id: 'test' }, requestId: `rq_${uid()}`, clientIp: '127.0.0.1', limit: 50 })) as { ok: true; notices: { changes: { changeId: string }[] }[] };
    const page = all.notices.filter((n) => n.changes.some((c) => c.changeId === ids[0]));
    const api = overrideBinding(env.API, { confirmationNotices: async () => ({ ok: true, notices: page }) });
    const fake = new FakeEmail();
    // The page (1), the members (1), then the arming, 4 emails (alias, contact, two owners) and the ack: 6 calls aren't enough.
    const r = await runConfirmationNotices(envWith({ API: api }), fake, new Budget(6));
    expect(r.skipped).toBe(1);
    expect(fake.attempts).toEqual([]);
    expect((await confirmationRow(ids[0]!))!.notice_at).toBeNull();
    // With room (8 calls) it goes out and is acked.
    const r2 = await runConfirmationNotices(envWith({ API: api }), fake, new Budget(8));
    expect(r2.acked).toBe(1);
    expect((await confirmationRow(ids[0]!))!.notice_at).not.toBeNull();
  });

  it('runs in the notice run beside the other steps; an API without the method fails only its own step', async () => {
    const { ids } = await confirmedByStaff([`https://g-${uid().toLowerCase()}.partner.example`]);
    const fake = new FakeEmail();
    const out = await runNotices(env, fake, big());
    expect(out.confirmations?.acked).toBeGreaterThanOrEqual(1);
    expect((await confirmationRow(ids[0]!))!.notice_at).not.toBeNull();
    const old = overrideBinding(env.API, { confirmationNotices: async () => ({ ok: false, code: 'not_found' }) });
    const r = await runNotices(envWith({ API: old }), new FakeEmail(), big());
    expect(r.confirmations).toEqual({ acked: 0, failed: 0, skipped: 0 });
    expect(r.changes).not.toBeNull();
    expect(r.platformKeys).not.toBeNull();
  });
});

describe('pendingNotices’ secondPerson (the contract this Worker reads)', () => {
  it('a staff proposal on a platform-created app carries its request and its wait', async () => {
    const { app: site } = await network({ shared: false });
    // An app the platform created on the org's scope (as a create leaves it, less its ledger row).
    const app = { ...site, id: `app_${uid()}` };
    const key = newPublishableKey('test');
    await hot()
      .prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan, created_at, origins_version, user_ids, created_by_kind) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free', ?6, 0, 'scope', 'platform')")
      .bind(app.id, `Test ${app.id}`, app.scope, app.org, key, Date.now())
      .run();
    await hot().prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${uid()}`, app.id, key, Date.now()).run();
    const ids = await staffAdds(app, [`https://h-${uid().toLowerCase()}.partner.example`]);
    const page = (await env.API.pendingNotices({ actor: { kind: 'system', id: 'test' }, requestId: `rq_${uid()}`, clientIp: '127.0.0.1', limit: 100 })) as { ok: true; notices: ChangeNotice[] };
    const n = page.notices.find((x) => x.change.id === ids[0])!;
    expect(n.secondPerson).toMatchObject({ requestId: expect.any(String), waitMs: DAY });
    expect(n.platform).toBeUndefined();
  });
});
