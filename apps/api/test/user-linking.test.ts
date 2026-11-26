// Linking one person's IDs across a network's apps (D925; docs/partner-platform-spec.md piece P7, B6, L9): the API's
// half. `ConsoleRpc.linkUser` (the owners' panel and per-app search; the console's role check and audit row are tested
// in apps/console test/user-linking.test.ts), its limits and volume alert, and the staff Support ID lookup resolving an
// app's own codes. Seeded through the directory's own writes (`upsertUser`, `upsertUserApp`) with the env's real keys,
// so every User ID and Support ID here is the one the mint would give.
import { LINK_ALERT_MEMBER_PER_HOUR, LINK_ALERT_ORG_PER_DAY, LINK_ALERT_ORG_PER_WEEK, linkAuditRef, LINK_APPS_MAX, LINK_MEMBER_PER_DAY, LINK_MEMBER_PER_HOUR, LINK_ORG_PER_DAY, formatSupportId, newId, supportCodeOf } from '@hana-id/console-core';
import { appSub, identitySub, identitySubBytes } from '@hana-id/core/identity';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepare } from '../src/changes/sql.ts';
import { admitLinkLookup, linkStatement } from '../src/directory/link.ts';
import { userAppsStatement } from '../src/directory/support.ts';
import { directoryUser, upsertUser, upsertUserApp, userAppIds } from '../src/directory/store.ts';
import { identitySubKey } from '../src/identity/signer.ts';
import { call, seedApp, uid } from './helpers.ts';
import { adminRpc, consoleRpc, hana, member, newOrg, ownClock } from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const KEY = identitySubKey(env) as Uint8Array;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface App {
  id: string;
  scope: string;
}

/** Signs `sub` in on `app` as the directory records it: the person's row and, on a marked scope, the app's row. */
async function signIn(app: App, sub: string, at = Date.now()): Promise<{ internalId: string; userId: string; supportId: string }> {
  const root = { provider: 'google', sub };
  const user = await directoryUser(env, app.scope, root);
  if (typeof user === 'string') throw new Error(user);
  await upsertUser(env.DB, user, app.scope, at).run();
  await upsertUserApp(env.DB, user.internalId, { id: app.id, scope_id: app.scope }, userAppIds(env, { id: app.id, scope_id: app.scope }, root)!, at).run();
  return { internalId: user.internalId, userId: user.userId, supportId: formatSupportId(user.supportCode) };
}

const own = (app: App, sub: string) => appSub(KEY, app.scope, app.id, identitySubBytes(KEY, app.scope, { provider: 'google', sub }));
const ownSupport = (app: App, sub: string) => formatSupportId(supportCodeOf(own(app, sub)));

/**
 * A network: an org whose marked scope has an app of before ('scope'), two apps made after the mark ('app'), a
 * suspended one and a deleted one; one person signed in on all of them (the app of before again after the mark). Plus
 * another org's marked scope with the same person (another wallet, other IDs), and an unmarked scope of the same org.
 */
async function network() {
  const org = newOrg();
  const before = await seedApp();
  await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(before.scope).run();
  const own1 = await seedApp({ scope: before.scope });
  const own2 = await seedApp({ scope: before.scope });
  const paused = await seedApp({ scope: before.scope });
  const gone = await seedApp({ scope: before.scope });
  const plain = await seedApp();
  await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id IN (?1, ?3)').bind(before.scope, org, plain.scope).run();
  const sub = `g-${uid()}`;
  const t0 = Date.now() - 10 * HOUR;
  const person = await signIn(before, sub, t0);
  await signIn(own1, sub, t0 + HOUR);
  await signIn(own2, sub, t0 + 2 * HOUR);
  await signIn(paused, sub, t0 + 3 * HOUR);
  await signIn(gone, sub, t0 + 4 * HOUR);
  await env.DB.prepare('UPDATE apps SET suspended_by = 1 WHERE id = ?1').bind(paused.id).run();
  await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(gone.id, Date.now()).run();
  const onPlain = await signIn(plain, sub, t0);
  // Another org's network, the same Google account.
  const otherOrg = newOrg();
  const theirs = await seedApp({ sharedScope: true });
  await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(theirs.scope, otherOrg).run();
  const elsewhere = await signIn(theirs, sub, t0);
  // Someone else on the network, so a query must pick the right person.
  const other = await signIn(own1, `g-${uid()}`, t0);
  return { org, otherOrg, sub, before, own1, own2, paused, gone, plain, theirs, person, onPlain, elsewhere, other };
}

const link = (orgId: string, query: string, o: { purpose?: 'panel' | 'search'; actor?: ReturnType<typeof member>; clock?: { advance: (ms: number) => void } } = {}) =>
  consoleRpc(o.clock).linkUser({ ...(o.actor ?? member()), orgId, query, purpose: o.purpose ?? 'search' }) as Promise<{ ok: boolean; code?: string; error?: string; link?: Record<string, unknown> }>;

describe('ConsoleRpc.linkUser: one person across the org’s apps', () => {
  it('the panel, by the person’s scope-level User ID: every live app of the org on the scope, in both modes, with each app’s own IDs, newest first; nothing else', async () => {
    const clock = ownClock();
    const n = await network();
    const r = await link(n.org, n.person.userId, { purpose: 'panel', clock });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const v = r.link as Record<string, unknown> & { apps: Record<string, unknown>[] };
    // Exactly the listed fields, at every level.
    expect(Object.keys(v).sort()).toEqual(['apps', 'match', 'scopeId', 'supportId', 'truncated', 'userId']);
    for (const a of v.apps) expect(Object.keys(a).sort()).toEqual(['appId', 'appName', 'firstSeenAt', 'lastSeenAt', 'supportId', 'userId']);
    expect(v).toMatchObject({ userId: n.person.userId, supportId: n.person.supportId, scopeId: n.before.scope, match: { kind: 'userId', of: 'scope', appId: null }, truncated: false });
    // The suspended app is listed (still the network's), the deleted one is not; the app of before gives the scope's IDs.
    expect(v.apps.map((a) => a.appId)).toEqual([n.paused.id, n.own2.id, n.own1.id, n.before.id]);
    const byApp = new Map(v.apps.map((a) => [a.appId, a]));
    expect(byApp.get(n.before.id)).toMatchObject({ userId: n.person.userId, supportId: n.person.supportId });
    for (const app of [n.own1, n.own2, n.paused]) expect(byApp.get(app.id)).toMatchObject({ userId: own(app, n.sub), supportId: ownSupport(app, n.sub), appName: `Test ${app.id}` });
    expect(new Set(v.apps.map((a) => a.userId)).size).toBe(4);
    // No internal id, sub, identity key, email or address anywhere in the answer.
    const text = JSON.stringify(r);
    for (const s of [n.person.internalId, 'hu_', n.sub, 'identity', '@', 'address', 'wallet', n.elsewhere.userId, n.onPlain.userId]) expect(text, s).not.toContain(s);
  });

  it('the search, by any code the person holds: each app’s own User ID and Support ID, and the scope’s; it says which kind matched', async () => {
    const clock = ownClock();
    const n = await network();
    const cases: [string, Record<string, unknown>][] = [
      [own(n.own1, n.sub), { kind: 'userId', of: 'app', appId: n.own1.id }],
      [ownSupport(n.own2, n.sub), { kind: 'supportId', of: 'app', appId: n.own2.id }],
      // As a person reads it out: lower case, no prefix, no dash, O for 0 and L for 1 (Crockford's look-alikes).
      [ownSupport(n.own2, n.sub).slice(5).replace('-', '').toLowerCase(), { kind: 'supportId', of: 'app', appId: n.own2.id }],
      [n.person.supportId, { kind: 'supportId', of: 'scope', appId: null }],
      [n.person.userId, { kind: 'userId', of: 'scope', appId: null }],
      // A suspended app's own code still finds the person.
      [own(n.paused, n.sub), { kind: 'userId', of: 'app', appId: n.paused.id }],
    ];
    for (const [query, match] of cases) {
      const r = await link(n.org, query, { clock });
      expect(r.ok, `${query}: ${JSON.stringify(r)}`).toBe(true);
      expect(r.link).toMatchObject({ userId: n.person.userId, match });
    }
    const looks = ownSupport(n.own1, n.sub).replace(/0/gu, 'O').replace(/1/gu, 'l');
    expect((await link(n.org, looks, { clock })).link).toMatchObject({ match: { kind: 'supportId', of: 'app', appId: n.own1.id } });
  });

  it('another org’s person, an unmarked scope, a deleted app’s own ID and a code nobody holds: the same not_found, the same words', async () => {
    const clock = ownClock();
    const n = await network();
    const misses = [n.elsewhere.userId, n.elsewhere.supportId, own(n.theirs, n.sub), n.onPlain.userId, n.onPlain.supportId, own(n.gone, n.sub), ownSupport(n.gone, n.sub), `u1_${'A'.repeat(21)}A`, 'HANA-ZZZZ-ZZZZ'];
    const answers = new Set<string>();
    for (const q of misses) {
      const r = await link(n.org, q, { clock });
      answers.add(JSON.stringify(r));
    }
    expect([...answers]).toEqual([JSON.stringify({ ok: false, code: 'not_found', error: 'No such user' })]);
    // The other org finds its own person by that same Google account's IDs there, and never this org's.
    expect((await link(n.otherOrg, n.elsewhere.userId, { clock })).ok).toBe(true);
    expect((await link(n.otherOrg, n.person.userId, { clock })).code).toBe('not_found');
    expect((await link(n.otherOrg, own(n.own1, n.sub), { clock })).code).toBe('not_found');
  });

  it('whole values only: a prefix, a part, a pattern or another kind of id is refused before anything is read', async () => {
    const clock = ownClock();
    const n = await network();
    const id = own(n.own1, n.sub);
    for (const q of [id.slice(0, -1), id.slice(0, 10), `${id}x`, n.person.supportId.slice(0, 9), 'HANA-%', '%', 'u1_%', n.person.internalId, n.sub, '0x52908400098527886E0F7030069857D2E4169EE7', 'person@example.com'])
      expect(await link(n.org, q, { clock }), q).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('a Support ID two people of the org hold is refused (ambiguous), never resolved; the same code held once here and once in another org resolves', async () => {
    const clock = ownClock();
    const n = await network();
    // A second person of the org whose scope-level code is the first person's app's own code (40 bits do collide).
    const code = supportCodeOf(own(n.own1, n.sub));
    const twin = `hu_${(uid() + '2'.repeat(26)).slice(0, 26)}`;
    await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(twin, `u1_${uid().padEnd(21, 'x').slice(0, 21)}A`, code, n.before.scope).run();
    expect(await link(n.org, formatSupportId(code), { clock })).toEqual({ ok: false, code: 'ambiguous', error: 'More than one person has this Support ID: ask for their User ID' });
    // Their User IDs still tell them apart.
    expect((await link(n.org, own(n.own1, n.sub), { clock })).link).toMatchObject({ userId: n.person.userId });
    // Another org holding the same code doesn't make it ambiguous here (and isn't revealed).
    const code2 = supportCodeOf(own(n.own2, n.sub));
    const outside = `hu_${(uid() + '3'.repeat(26)).slice(0, 26)}`;
    await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(outside, `u1_${uid().padEnd(21, 'y').slice(0, 21)}A`, code2, n.theirs.scope).run();
    expect((await link(n.org, formatSupportId(code2), { clock })).link).toMatchObject({ userId: n.person.userId, match: { of: 'app', appId: n.own2.id } });
  });

  it(`at most ${LINK_APPS_MAX} apps, the most recently used, and says it was cut`, async () => {
    const clock = ownClock();
    const org = newOrg();
    const first = await seedApp({ sharedScope: true });
    const apps = [first];
    for (let i = 1; i <= LINK_APPS_MAX; i++) apps.push(await seedApp({ scope: first.scope }));
    await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(first.scope, org).run();
    const sub = `g-${uid()}`;
    const t0 = Date.now() - DAY;
    let person = '';
    for (const [i, a] of apps.entries()) person = (await signIn(a, sub, t0 + i * 1000)).userId;
    const r = await link(org, person, { purpose: 'panel', clock });
    const v = r.link as { apps: { appId: string }[]; truncated: boolean };
    expect([v.apps.length, v.truncated]).toEqual([LINK_APPS_MAX, true]);
    expect(v.apps[0]!.appId).toBe(apps.at(-1)!.id);
    expect(v.apps.some((a) => a.appId === first.id)).toBe(false);
  });

  it('takes a member actor only, and an org id: staff, the system and an emailed link are refused', async () => {
    const n = await network();
    const rpc = consoleRpc();
    for (const actor of [hana().actor, { kind: 'system', id: 'admin-cron' }, { kind: 'link', id: 'gc_x' }])
      expect(await rpc.linkUser({ actor, requestId: `req_${uid()}`, clientIp: '203.0.113.1', orgId: n.org, query: n.person.userId, purpose: 'panel' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc.linkUser({ ...member(), query: n.person.userId, purpose: 'panel' })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('is reachable through no public route: the API’s fetch answers 404 for anything that looks like it', async () => {
    for (const path of ['/v1/users/link', '/v1/users/lookup', '/linkUser'])
      for (const method of ['GET', 'POST']) expect((await call(path, { method, headers: { origin: 'https://wallet.example.com' }, ...(method === 'POST' ? { body: {} } : {}) })).status, `${method} ${path}`).toBe(404);
    // Under /v1/platform the platform API answers (D927): a browser is refused, and the path is no route of its.
    for (const method of ['GET', 'POST']) {
      expect((await call('/v1/platform/users/lookup', { method, headers: { origin: 'https://wallet.example.com' }, ...(method === 'POST' ? { body: {} } : {}) })).status).toBe(403);
      expect((await call('/v1/platform/users/lookup', { method, ...(method === 'POST' ? { body: {} } : {}) })).status).toBe(404);
    }
  });
});

describe('the limits and the volume alert (counted before the read)', () => {
  // A Wednesday 01:00 UTC, whole weeks ahead of now (D935: the limiter's objects ignore times behind their own clock).
  const T = Date.UTC(2026, 10, 25, 1, 0, 0) + Math.ceil((Date.now() - Date.UTC(2026, 10, 25, 1, 0, 0)) / (7 * DAY) + 1) * 7 * DAY;
  const allEvents = () => env.DB.prepare("SELECT id, org_id, detail_json FROM security_events WHERE kind = 'link_lookup_volume' ORDER BY detected_at, id").all<{ id: string; org_id: string | null; detail_json: string }>().then((r) => r.results);
  const events = (orgId: string) => env.DB.prepare("SELECT id, org_id, detail_json FROM security_events WHERE kind = 'link_lookup_volume' AND org_id = ?1 ORDER BY detected_at, id").bind(orgId).all<{ id: string; org_id: string; detail_json: string }>().then((r) => r.results);
  const admit = async (memberId: string, orgId: string, now: number) => {
    try {
      await admitLinkLookup(env, { memberId, orgId }, now);
      return 'ok';
    } catch (err) {
      return (err as { code?: string }).code ?? 'threw';
    }
  };

  it(`a member: ${LINK_MEMBER_PER_HOUR} an hour, then rate_limited until the next clock hour; ${LINK_MEMBER_PER_DAY} a UTC day`, async () => {
    const m = `usr_${uid()}`;
    const org = newOrg();
    for (let i = 0; i < LINK_MEMBER_PER_HOUR; i++) expect(await admit(m, org, T + i)).toBe('ok');
    expect(await admit(m, org, T + 100)).toBe('rate_limited');
    expect(await admit(m, org, T + HOUR - 1)).toBe('rate_limited');
    expect(await admit(m, org, T + HOUR)).toBe('ok');
    // The day: fill the rest of it, an hour at a time.
    let used = LINK_MEMBER_PER_HOUR + 1;
    for (let h = 1; used < LINK_MEMBER_PER_DAY; h++) for (let i = h === 1 ? 1 : 0; i < LINK_MEMBER_PER_HOUR && used < LINK_MEMBER_PER_DAY; i++, used++) expect(await admit(m, org, T + h * HOUR + i)).toBe('ok');
    expect(await admit(m, org, T + 10 * HOUR)).toBe('rate_limited');
    expect(await admit(m, org, T + DAY)).toBe('ok');
  });

  it(`an org: ${LINK_ORG_PER_DAY} a UTC day across its members; a refusal by the org gives the member its count back`, async () => {
    const org = newOrg();
    let k = 0;
    for (let mi = 0; k < LINK_ORG_PER_DAY; mi++) for (let i = 0; i < LINK_MEMBER_PER_HOUR && k < LINK_ORG_PER_DAY; i++, k++) expect(await admit(`usr_o${org}${mi}`, org, T + i)).toBe('ok');
    const fresh = `usr_${uid()}`;
    expect(await admit(fresh, org, T + 1000)).toBe('rate_limited');
    // The fresh member's own hour wasn't spent by the refusal: a lookup for another org still has all 60.
    const other = newOrg();
    for (let i = 0; i < LINK_MEMBER_PER_HOUR; i++) expect(await admit(fresh, other, T + 2000 + i)).toBe('ok');
    expect(await admit(fresh, other, T + 3000)).toBe('rate_limited');
    expect(await admit(`usr_${uid()}`, org, T + DAY)).toBe('ok');
  });

  it(`the alert: one event per member past ${LINK_ALERT_MEMBER_PER_HOUR} in a clock hour (under no org, naming the member and the org that crossed it), one per org past ${LINK_ALERT_ORG_PER_DAY} in a UTC day and ${LINK_ALERT_ORG_PER_WEEK} in a week; only the crossing writes; never a refusal`, async () => {
    const org = newOrg();
    const m = `usr_${uid()}`;
    const memberEvents = () => allEvents().then((r) => r.filter((e) => JSON.parse(e.detail_json).memberId === m));
    for (let i = 0; i < LINK_ALERT_MEMBER_PER_HOUR; i++) await admit(m, org, T + i);
    expect(await memberEvents()).toEqual([]);
    const spy = vi.spyOn(env.DB, 'prepare');
    expect(await admit(m, org, T + 100)).toBe('ok');
    expect(await memberEvents()).toHaveLength(1);
    // Later look-ups in the window write nothing at all (no INSERT OR IGNORE per look-up).
    const writes = () => spy.mock.calls.filter(([sql]) => String(sql).includes('security_events')).length;
    const before = writes();
    for (let i = 0; i < 10; i++) expect(await admit(m, org, T + 200 + i)).toBe('ok');
    expect(writes()).toBe(before);
    spy.mockRestore();
    const [ev] = await memberEvents();
    expect(ev!.org_id).toBeNull();
    expect(JSON.parse(ev!.detail_json)).toEqual({ limit: 'member_hour', windowStart: T, windowMs: HOUR, threshold: LINK_ALERT_MEMBER_PER_HOUR, memberId: m, crossedInOrg: org });
    // The next hour is another window: another event once past it again (in another org: the member's own count).
    const other = newOrg();
    for (let i = 0; i <= LINK_ALERT_MEMBER_PER_HOUR; i++) await admit(m, other, T + HOUR + i);
    expect((await memberEvents()).map((e) => JSON.parse(e.detail_json).crossedInOrg)).toEqual([org, other]);
    // The org's day: past 200 (the member made 41 here today; others make the rest, under their own 30).
    let k = LINK_ALERT_MEMBER_PER_HOUR + 11;
    for (let mi = 0; k < LINK_ALERT_ORG_PER_DAY; mi++) for (let i = 0; i < 20 && k < LINK_ALERT_ORG_PER_DAY; i++, k++) await admit(`usr_a${org}${mi}`, org, T + 2 * HOUR + i);
    expect(await events(org)).toEqual([]);
    await admit(`usr_${uid()}`, org, T + 3 * HOUR);
    expect((await events(org)).map((e) => JSON.parse(e.detail_json))).toEqual([{ limit: 'org_day', windowStart: T - (T % DAY), windowMs: DAY, threshold: LINK_ALERT_ORG_PER_DAY }]);
    for (let i = 0; i < 5; i++) await admit(`usr_${uid()}`, org, T + 4 * HOUR + i);
    expect(await events(org)).toHaveLength(1);
  });

  it('an alert whose write fails is written by the next look-up past the threshold; once written, no further writes in that window (the member’s hour, the org’s day and week)', async () => {
    const org = newOrg();
    const m = `usr_${uid()}`;
    const real = env.DB.prepare.bind(env.DB);
    let failNext = 0;
    let writes = 0;
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INTO security_events')) {
        writes++;
        if (failNext > 0) {
          failNext--;
          return { bind: () => ({ run: () => Promise.reject(new Error('D1_ERROR: storage write failed')) }) } as unknown as D1PreparedStatement;
        }
      }
      return real(sql);
    });
    const memberEvents = () => allEvents().then((r) => r.filter((e) => JSON.parse(e.detail_json).memberId === m));
    for (let i = 0; i < LINK_ALERT_MEMBER_PER_HOUR; i++) await admit(m, org, T + i);
    // The crossing look-up's write fails: no event, and the look-up itself still answers.
    failNext = 1;
    expect(await admit(m, org, T + 100)).toBe('ok');
    expect(await memberEvents()).toEqual([]);
    // The next one writes it.
    expect(await admit(m, org, T + 101)).toBe('ok');
    expect(await memberEvents()).toHaveLength(1);
    // Then nothing more in the window.
    const after = writes;
    for (let i = 0; i < 5; i++) await admit(m, org, T + 200 + i);
    expect(writes).toBe(after);
    // The org's week (fixed 7-day windows): its crossing write fails, the next look-up writes it, then no more.
    const WEEK = 7 * DAY;
    const weekStart = Math.floor(T / WEEK) * WEEK + 2 * WEEK;
    const o2 = newOrg();
    for (let n = 0; n < LINK_ALERT_ORG_PER_WEEK; n++) await admit(`usr_f${o2}${Math.floor(n / 20)}`, o2, weekStart + Math.floor(n / 150) * DAY + HOUR + (n % 150));
    failNext = 1;
    await admit(`usr_${uid()}`, o2, weekStart + 4 * DAY);
    expect(await events(o2)).toEqual([]);
    await admit(`usr_${uid()}`, o2, weekStart + 4 * DAY + 1);
    expect((await events(o2)).map((e) => JSON.parse(e.detail_json).limit)).toEqual(['org_week']);
    const w2 = writes;
    for (let i = 0; i < 3; i++) await admit(`usr_${uid()}`, o2, weekStart + 5 * DAY + i);
    expect(writes).toBe(w2);
    spy.mockRestore();
  });

  it(`the week: an org that stays under ${LINK_ALERT_ORG_PER_DAY} a day but passes ${LINK_ALERT_ORG_PER_WEEK} in a week alerts once`, async () => {
    const org = newOrg();
    const WEEK = 7 * DAY;
    const weekStart = Math.floor(T / WEEK) * WEEK;
    let n = 0;
    // 150 a day (no daily alert), from the week's first day, by many members under their own thresholds.
    for (let d = 0; n < LINK_ALERT_ORG_PER_WEEK; d++)
      for (let i = 0; i < 150 && n < LINK_ALERT_ORG_PER_WEEK; i++, n++) expect(await admit(`usr_w${org}${d}_${Math.floor(i / 20)}`, org, weekStart + d * DAY + HOUR + i)).toBe('ok');
    expect(await events(org)).toEqual([]);
    await admit(`usr_${uid()}`, org, weekStart + 4 * DAY);
    expect((await events(org)).map((e) => JSON.parse(e.detail_json))).toEqual([{ limit: 'org_week', windowStart: weekStart, windowMs: WEEK, threshold: LINK_ALERT_ORG_PER_WEEK }]);
  });

  it('through the RPC: a lookup that finds nothing counts like one that does; the 61st in an hour is rate_limited before the read', async () => {
    const clock = ownClock();
    const n = await network();
    const actor = member();
    for (let i = 0; i < LINK_MEMBER_PER_HOUR; i++) expect((await link(n.org, i % 2 ? n.person.userId : 'HANA-ZZZZ-ZZZZ', { actor, clock })).code ?? 'ok').toMatch(/^(ok|not_found)$/u);
    expect(await link(n.org, n.person.userId, { actor, clock })).toEqual({ ok: false, code: 'rate_limited', error: 'Too many look-ups this hour: try again later' });
    // Another member of the same org still has its own hour.
    expect((await link(n.org, n.person.userId, { clock })).ok).toBe(true);
  });
});

describe('the reads’ D1 cost (rows read, pinned)', () => {
  it('the lookup reads a bounded number of rows whatever else the tables hold: a hit by each kind of code, a miss, another org’s', async () => {
    const n = await network();
    // Others in the tables: more people on the network and elsewhere.
    for (let i = 0; i < 5; i++) await signIn(n.own2, `g-${uid()}`);
    const rowsRead = async (orgId: string, query: Parameters<typeof linkStatement>[1]) => (await prepare(env.DB, linkStatement(orgId, query)).all()).meta.rows_read;
    const measure = async () => ({
      scopeUserId: await rowsRead(n.org, { kind: 'userId', userId: n.person.userId }),
      appUserId: await rowsRead(n.org, { kind: 'userId', userId: own(n.own1, n.sub) }),
      scopeSupport: await rowsRead(n.org, { kind: 'supportId', code: n.person.supportId.replace(/HANA-|-/gu, '') }),
      appSupport: await rowsRead(n.org, { kind: 'supportId', code: supportCodeOf(own(n.own2, n.sub)) }),
      miss: await rowsRead(n.org, { kind: 'userId', userId: `u1_${'B'.repeat(21)}A` }),
      otherOrg: await rowsRead(n.otherOrg, { kind: 'userId', userId: n.person.userId }),
    });
    const first = await measure();
    // Twenty more people on the network's apps and on the other org's: the person's cost doesn't move.
    for (let i = 0; i < 10; i++) {
      await signIn(n.own1, `g-${uid()}`);
      await signIn(n.theirs, `g-${uid()}`);
    }
    const second = await measure();
    // Measured alone: { scopeUserId: 31, appUserId: 26, scopeSupport: 32, appSupport: 26, miss: 3, otherOrg: 8 }. The
    // budget each read is held to, before and after the tables grow (a few rows of headroom: the full suite's other files
    // write the same tables meanwhile).
    const BUDGET = { scopeUserId: 36, appUserId: 32, scopeSupport: 36, appSupport: 32, miss: 6, otherOrg: 12 };
    for (const m of [first, second]) for (const [k, v] of Object.entries(m)) expect(v, k).toBeLessThanOrEqual(BUDGET[k as keyof typeof BUDGET]);
  });
});

describe('after PR 153’s review', () => {
  it('the panel opens only by the person’s User ID for all the apps: an app’s User ID or any Support ID is refused (bad_request), so the audit can’t say “panel” for a search', async () => {
    const clock = ownClock();
    const n = await network();
    const refused = { ok: false, code: 'bad_request', error: 'purpose: the panel opens by the person’s User ID for all your apps; an app’s code is a search' };
    expect(await link(n.org, own(n.own1, n.sub), { purpose: 'panel', clock })).toEqual(refused);
    expect(await link(n.org, ownSupport(n.own2, n.sub), { purpose: 'panel', clock })).toEqual(refused);
    expect(await link(n.org, n.person.supportId, { purpose: 'panel', clock })).toEqual(refused);
    expect((await link(n.org, n.person.userId, { purpose: 'panel', clock })).ok).toBe(true);
    expect((await link(n.org, own(n.own1, n.sub), { purpose: 'search', clock })).ok).toBe(true);
  });

  it('the answer carries the audit reference of the person (for the console’s row, never shown): a keyed hash of the scope-level User ID, not the ID', async () => {
    const clock = ownClock();
    const n = await network();
    const r = (await link(n.org, own(n.own1, n.sub), { clock })) as unknown as { auditRef: string };
    expect(r.auditRef).toBe(await linkAuditRef(KEY, n.person.userId));
    expect(r.auditRef).toMatch(/^lr1_[A-Za-z0-9_-]{21}[AQgw]$/u);
    expect(r.auditRef).not.toContain(n.person.userId.slice(3));
  });

  it('a scope moved to another org: the new org’s owners find its people (the whole history), the old org finds no one', async () => {
    const clock = ownClock();
    const n = await network();
    const next = newOrg();
    await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(n.before.scope, next).run();
    expect(await link(n.org, n.person.userId, { clock })).toMatchObject({ ok: false, code: 'not_found' });
    const r = await link(next, own(n.own1, n.sub), { clock });
    expect(r.link).toMatchObject({ userId: n.person.userId, match: { of: 'app', appId: n.own1.id } });
    expect((r.link as { apps: unknown[] }).apps).toHaveLength(4);
  });

  it('the cost is bounded by the 100-app cap, not by the person’s app count: a person on 100 apps and on 120 read the same budget', async () => {
    const org = newOrg();
    const first = await seedApp({ sharedScope: true });
    const apps = [first];
    for (let i = 1; i < 120; i++) apps.push(await seedApp({ scope: first.scope }));
    await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(first.scope, org).run();
    const rowsRead = async (userId: string) => (await prepare(env.DB, linkStatement(org, { kind: 'userId', userId })).all()).meta.rows_read;
    const on = async (count: number) => {
      const sub = `g-${uid()}`;
      let person = '';
      for (const [i, a] of apps.slice(0, count).entries()) person = (await signIn(a, sub, Date.now() - DAY + i * 1000)).userId;
      return rowsRead(person);
    };
    const hundred = await on(100);
    const more = await on(120);
    // Measured: 208 rows for 100 apps (two an app listed, down migration 0031's index), 210 for 120: the read stops at
    // the cap's 101 rows. Held to 240 for either (before the index, 368 for 120 apps).
    expect(hundred).toBeLessThanOrEqual(240);
    expect(more).toBeLessThanOrEqual(240);
    const staff = async (count: number) => {
      const sub = `s-${uid()}`;
      let internal = '';
      for (const [i, a] of apps.slice(0, count).entries()) internal = (await signIn(a, sub, Date.now() - DAY + i * 1000)).internalId;
      return (await prepare(env.DB, userAppsStatement([internal])).all()).meta.rows_read;
    };
    const staffHundred = await staff(100);
    // Measured 101 for either: the cap's rows, down the same index.
    expect(staffHundred).toBeLessThanOrEqual(110);
    expect(await staff(120)).toBeLessThanOrEqual(110);
  });
});

describe('the staff Support ID lookup resolves an app’s own codes (AdminRpc.supportLookup, findUsers)', () => {
  type Lookup = { ok: boolean; matches: { user: { userId: string }; matchedBy: unknown; userApps: { appId: string; userId: string; supportId: string }[] }[] };
  const lookup = async (query: string) => (await adminRpc().supportLookup({ ...hana(), query })) as unknown as Lookup;

  it('by an app’s own User ID or Support ID, and by the scope’s: one match, which code it was, and every app’s IDs (a deleted app’s too, until purged)', async () => {
    const n = await network();
    const cases: [string, unknown][] = [
      [own(n.own1, n.sub), { of: 'app', appId: n.own1.id }],
      [ownSupport(n.own2, n.sub), { of: 'app', appId: n.own2.id }],
      [ownSupport(n.gone, n.sub), { of: 'app', appId: n.gone.id }],
      [n.person.userId, { of: 'scope', appId: null }],
      [n.person.supportId, { of: 'scope', appId: null }],
      [n.person.internalId, null],
    ];
    for (const [query, by] of cases) {
      const r = await lookup(query);
      expect(r.ok, query).toBe(true);
      expect(r.matches.map((m) => m.user.userId), query).toEqual([n.person.userId]);
      expect(r.matches[0]!.matchedBy, query).toEqual(by);
    }
    const apps = (await lookup(n.person.userId)).matches[0]!.userApps;
    expect(apps.map((a) => a.appId)).toEqual([n.gone.id, n.paused.id, n.own2.id, n.own1.id, n.before.id]);
    expect(apps.find((a) => a.appId === n.own1.id)).toMatchObject({ userId: own(n.own1, n.sub), supportId: ownSupport(n.own1, n.sub) });
    expect(apps.find((a) => a.appId === n.before.id)).toMatchObject({ userId: n.person.userId, supportId: n.person.supportId });
    // Each match carries the console audit's reference of the person (D925 after PR 153's review).
    expect(((await lookup(n.person.userId)).matches[0] as unknown as { linkAuditRef: string }).linkAuditRef).toBe(await linkAuditRef(KEY, n.person.userId));
    // A person on an unmarked scope: no per-app rows.
    expect((await lookup(n.onPlain.userId)).matches[0]!.userApps).toEqual([]);
  });

  it('a Support ID several people hold: every match listed, each saying whose code it is (staff tell them apart by the scope and the app)', async () => {
    const n = await network();
    const code = supportCodeOf(own(n.own1, n.sub));
    const twin = `hu_${(uid() + '4'.repeat(26)).slice(0, 26)}`;
    const twinSub = `u1_${uid().padEnd(21, 'z').slice(0, 21)}A`;
    await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 1)').bind(twin, twinSub, code, n.theirs.scope).run();
    const r = await lookup(formatSupportId(code));
    expect(r.matches.map((m) => [m.user.userId, m.matchedBy]).sort()).toEqual(
      [
        [n.person.userId, { of: 'app', appId: n.own1.id }],
        [twinSub, { of: 'scope', appId: null }],
      ].sort(),
    );
  });

  it('the Users search finds a person by an app’s own ID for staff; a partner’s Users search by it finds nobody (owners use the linking view)', async () => {
    const n = await network();
    const staff = (await adminRpc().findUsers({ ...hana(), query: own(n.own1, n.sub) })) as unknown as { users: { userId: string }[] };
    expect(staff.users.map((u) => u.userId)).toEqual([n.person.userId]);
    const staffSupport = (await adminRpc().findUsers({ ...hana(), query: ownSupport(n.own2, n.sub) })) as unknown as { users: { userId: string }[] };
    expect(staffSupport.users.map((u) => u.userId)).toEqual([n.person.userId]);
    const partner = (await consoleRpc().listUsers({ ...member(), orgId: n.org, search: own(n.own1, n.sub) })) as unknown as { users: unknown[] };
    expect(partner.users).toEqual([]);
    const byScope = (await consoleRpc().listUsers({ ...member(), orgId: n.org, search: n.person.userId })) as unknown as { users: { userId: string; sharedScope: boolean }[] };
    expect(byScope.users).toMatchObject([{ userId: n.person.userId, sharedScope: true }]);
    const plain = (await consoleRpc().listUsers({ ...member(), orgId: n.org, search: n.onPlain.userId })) as unknown as { users: { sharedScope: boolean }[] };
    expect(plain.users).toMatchObject([{ sharedScope: false }]);
  });

  it('the lookup’s per-app read costs a bounded number of rows (pinned)', async () => {
    const n = await network();
    for (let i = 0; i < 5; i++) await signIn(n.own2, `g-${uid()}`);
    const read = async () => {
      const r = await prepare(env.DB, userAppsStatement([n.person.internalId])).all<{ apps_json: string }>();
      return [(JSON.parse(r.results[0]!.apps_json) as unknown[]).length, r.meta.rows_read];
    };
    const first = await read();
    for (let i = 0; i < 10; i++) await signIn(n.own1, `g-${uid()}`);
    const second = await read();
    // Five apps; measured alone 28 rows read for them. Held to a budget before and after the tables grow.
    for (const [n, rowsRead] of [first, second]) {
      expect(n).toBe(5);
      expect(rowsRead).toBeLessThanOrEqual(32);
    }
  });
});

it('fixtures: the per-app IDs differ from the scope’s and from each other (so every test above can tell them apart)', async () => {
  const n = await network();
  const ids = [n.person.userId, own(n.own1, n.sub), own(n.own2, n.sub), own(n.paused, n.sub)];
  expect(new Set(ids).size).toBe(4);
  expect(identitySub(KEY, n.before.scope, { provider: 'google', sub: n.sub })).toBe(n.person.userId);
  void newId;
});

describe('the tables this piece reads and writes, as the schema has them (sqlite_schema)', () => {
  it('every trigger and view naming them is the known set: the linking view adds none and relies on these', async () => {
    const named = async (table: string) =>
      (await env.DB.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger', 'view') AND (tbl_name = ?1 OR sql LIKE '%' || ?1 || '%') ORDER BY type, name").bind(table).all<{ type: string; name: string }>()).results.map((r) => `${r.type}:${r.name}`);
    expect({
      end_user_apps: await named('end_user_apps'),
      security_events: await named('security_events'),
    }).toMatchInlineSnapshot(`
      {
        "end_user_apps": [
          "trigger:end_user_apps_insert",
        ],
        "security_events": [],
      }
    `);
  });
});
