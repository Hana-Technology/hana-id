// D930 (docs/partner-platform-spec.md A11, piece P5): what the console's and the admin portal's platform screens read.
// The app views (who created it: the platform key's id in the detail, the creator in the list; who holds the partner
// suspension), the platform activity (ConsoleRpc for any member of the org, without the caller's network; AdminRpc
// with it; one org never sees another's; narrowed to one app, a bounded scan with its `next`), the staff queue
// (AdminRpc only: waiting platform web addresses and waiting keys, never what is in force, cancelled or a member's),
// and the change notices' platform field (the request, the key, the wait the ack gives). Reads only: no route here
// writes anything.
import { PLATFORM_CALLS_SCAN, newId, platformRouteWords } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ROUTES } from '../src/platform/routes.ts';
import { freshNow, seedKey, send, type SendOpts, type Seeded } from './platform-helpers.ts';
import { adminRpc, consoleRpc, hana, member, memberProposal, orgApp, rows, system } from './rpc-helpers.ts';

const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());

let n = 0;
const ik = (): string => `idem-${Date.now().toString(36)}-screens-${++n}`;
const post = (k: Pick<Seeded, 'id' | 'privateKey'>, path: string, body: unknown, o: SendOpts = {}) => send(k, { method: 'POST', path, body: JSON.stringify(body), idempotencyKey: ik(), now: freshNow(), ...o });
const get = (k: Pick<Seeded, 'id' | 'privateKey'>, path: string) => send(k, { path, now: freshNow() });

/** A network: an org with a marked test scope (with the network's own staff-created site) and a platform key in force. */
async function network() {
  const site = await orgApp({ contacts: ['security@partner.example'] });
  await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(site.scope).run();
  const k = await seedKey({ org: site, scopes: [site.scope] });
  return { k, org: site.org, scope: site.scope, site };
}

async function createdApp(net: Awaited<ReturnType<typeof network>>, origins: string[] = []) {
  const r = await post(net.k, '/v1/platform/apps', { scopeId: net.scope, name: `Partner ${newId('app').slice(4, 12)}`, origins });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: (r.body.app as { id: string }).id, changes: r.body.changes as { changeId: string; origin: string }[] };
}

describe('the app views', () => {
  it('a platform-created app names its key in the detail and its creator in the list; a staff-created one neither', async () => {
    const net = await network();
    const app = await createdApp(net);
    const d = await consoleRpc().getApp({ ...member(), orgId: net.org, appId: app.id });
    if (!d.ok) throw new Error(d.code);
    expect(d.app.createdByKind).toBe('platform');
    expect(d.app.createdByKey).toBe(net.k.id);
    const staffView = await adminRpc().getApp({ ...hana(), orgId: net.org, appId: app.id });
    expect(staffView.ok && staffView.app.createdByKey).toBe(net.k.id);
    const own = await consoleRpc().getApp({ ...member(), orgId: net.org, appId: net.site.id });
    if (!own.ok) throw new Error(own.code);
    expect(own.app.createdByKind).toBe('hana');
    expect(own.app).not.toHaveProperty('createdByKey');
    const list = await consoleRpc().listApps({ ...member(), orgId: net.org });
    if (!list.ok) throw new Error(list.code);
    expect(list.apps.find((a) => a.id === app.id)?.createdByKind).toBe('platform');
    expect(list.apps.find((a) => a.id === net.site.id)?.createdByKind).toBe('hana');
  });

  it('who holds the partner suspension: the platform, then a member who takes it over; Journear’s bit alone names none', async () => {
    const net = await network();
    const app = await createdApp(net);
    const view = async () => {
      const d = await consoleRpc().getApp({ ...member(), orgId: net.org, appId: app.id });
      if (!d.ok) throw new Error(d.code);
      return d.app;
    };
    expect((await view()).partnerBitBy).toBeUndefined();
    expect((await post(net.k, `/v1/platform/apps/${app.id}/suspend`, { suspended: true })).status).toBe(200);
    expect((await view()).partnerBitBy).toBe('platform');
    expect(await consoleRpc().setSuspended({ ...member(), orgId: net.org, appId: app.id, suspended: true })).toMatchObject({ ok: true });
    expect((await view()).partnerBitBy).toBe('member');
    // Journear's own bit alone names no partner holder.
    const other = await createdApp(net);
    expect(await adminRpc().setSuspended({ ...hana(), appId: other.id, bit: 1, suspended: true })).toMatchObject({ ok: true });
    const o = await consoleRpc().getApp({ ...member(), orgId: net.org, appId: other.id });
    expect(o.ok && o.app.suspendedBy).toBe(1);
    expect(o.ok && o.app.partnerBitBy).toBeUndefined();
  });
});

describe('platform activity', () => {
  it('a member sees the org’s calls newest first, without the caller’s network; staff with it; another org’s never', async () => {
    const net = await network();
    const app = await createdApp(net);
    await get(net.k, `/v1/platform/apps/${app.id}`);
    await get(net.k, '/v1/platform/credential');
    const other = await network();
    await get(other.k, '/v1/platform/credential');
    const page = await consoleRpc().platformCalls({ ...member(), orgId: net.org, limit: 50 });
    if (!page.ok) throw new Error(page.code);
    expect(page.calls.map((c) => c.route)).toEqual(['/v1/platform/credential', '/v1/platform/apps/:appId', '/v1/platform/apps']);
    expect(page.calls.every((c) => c.keyId === net.k.id)).toBe(true);
    expect(page.calls[1]).toMatchObject({ method: 'GET', appId: app.id, status: 200 });
    for (const c of page.calls) expect(c).not.toHaveProperty('ipPrefix');
    expect(page.next).toBeUndefined();
    const staff = await adminRpc().platformCalls({ ...hana(), orgId: net.org, limit: 50 });
    if (!staff.ok) throw new Error(staff.code);
    expect(staff.calls.map((c) => c.seq)).toEqual(page.calls.map((c) => c.seq));
    // A staff-only field: the platform's own record of the caller's network.
    const stored = await rows<{ ip_prefix: string | null }>('SELECT ip_prefix FROM platform_calls WHERE org_id = ?1 ORDER BY seq DESC', net.org);
    expect(staff.calls.map((c) => c.ipPrefix ?? null)).toEqual(stored.map((r) => r.ip_prefix));
    // Narrowed to the app: only its calls.
    const one = await consoleRpc().platformCalls({ ...member(), orgId: net.org, appId: app.id, limit: 50 });
    expect(one.ok && one.calls.map((c) => c.route)).toEqual(['/v1/platform/apps/:appId', '/v1/platform/apps']);
    // Another org's app named in this org's read: nothing.
    const foreign = await consoleRpc().platformCalls({ ...member(), orgId: other.org, appId: app.id, limit: 50 });
    expect(foreign.ok && foreign.calls).toEqual([]);
    // A system or a link actor can't read it from the console's entrypoint; a member can't from staff's.
    expect(await consoleRpc().platformCalls({ ...system(), orgId: net.org, limit: 50 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().platformCalls({ ...member(), orgId: net.org, limit: 50 })).toMatchObject({ ok: false });
  });

  it('pages by `next`; narrowed to one app, a page looks through at most PLATFORM_CALLS_SCAN calls and `next` moves the window back', async () => {
    const net = await network();
    const app = await createdApp(net);
    const org = net.org;
    const now = Date.now();
    // One call of the app, then PLATFORM_CALLS_SCAN + 5 calls of nothing in particular after it (bare rows, as P3 writes them).
    const insert = (appId: string | null, at: number) =>
      env.DB.prepare("INSERT INTO platform_calls (at, org_id, key_id, method, route, app_id, status, code, request_id, ip_prefix) VALUES (?1, ?2, ?3, 'GET', '/v1/platform/credential', ?4, 200, NULL, ?5, NULL)").bind(at, org, net.k.id, appId, `rq_${newId('app').slice(4)}`);
    await insert(app.id, now).run();
    const filler = Array.from({ length: PLATFORM_CALLS_SCAN + 5 }, (_, k) => insert(null, now + k + 1));
    for (let i = 0; i < filler.length; i += 100) await env.DB.batch(filler.slice(i, i + 100));
    const first = await consoleRpc().platformCalls({ ...member(), orgId: org, limit: 10 });
    if (!first.ok) throw new Error(first.code);
    expect(first.calls).toHaveLength(10);
    expect(first.next).toBe(first.calls[9]!.seq);
    const second = await consoleRpc().platformCalls({ ...member(), orgId: org, limit: 10, before: first.next });
    expect(second.ok && second.calls[0]!.seq).toBeLessThan(first.next!);
    // Narrowed: the newest PLATFORM_CALLS_SCAN calls hold none of the app's (its create and its seeded call are older).
    const narrowed = await consoleRpc().platformCalls({ ...member(), orgId: org, appId: app.id, limit: 10 });
    if (!narrowed.ok) throw new Error(narrowed.code);
    expect(narrowed.calls).toEqual([]);
    expect(narrowed.next).toBeDefined();
    const older = await consoleRpc().platformCalls({ ...member(), orgId: org, appId: app.id, limit: 10, before: narrowed.next });
    expect(older.ok && older.calls.map((c) => c.appId)).toEqual([app.id, app.id]);
  });

  it('every platform route has plain words for the screens', () => {
    for (const r of PLATFORM_ROUTES) expect(platformRouteWords(r.method, r.path), `${r.method} ${r.path}`).not.toContain('/v1/');
  });
});

describe('the staff queue', () => {
  it('lists waiting platform web addresses (unannounced and announced) and waiting keys; never one in force, cancelled or a member’s', async () => {
    const net = await network();
    const app = await createdApp(net, ['https://shop.partner-one.example', 'https://pay.partner-one.example']);
    const [a, b] = app.changes;
    // b announced: its time is set a day out.
    const t = await adminRpc().ackNotice({ ...system(), changeId: b!.changeId, cancelTokenHash: 'A'.repeat(43) });
    expect(t).toMatchObject({ ok: true });
    // A member's waiting proposal on the network's own site is not the platform's.
    const mine = await memberProposal(net.site, { kind: 'origin_add', origin: 'https://member.partner.example' });
    // A cancelled platform proposal.
    const c = await createdApp(net, ['https://gone.partner-two.example']);
    expect((await post(net.k, `/v1/platform/changes/${c.changes[0]!.changeId}/cancel`, {})).status).toBe(200);
    // A waiting staff-registered key for another org.
    const waitingOrg = await orgApp();
    const pub = (await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair).publicKey)) as JsonWebKey;
    const reg = await adminRpc().registerPlatformKey({ ...hana(), orgId: waitingOrg.org, scopeIds: [waitingOrg.scope], label: 'Queue key', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), reason: 'Thumbprint checked by phone with the network' });
    if (!reg.ok) throw new Error(reg.code);
    const q = await adminRpc().platformQueue({ ...hana(), limit: 100 });
    if (!q.ok) throw new Error(q.code);
    const ids = q.origins.map((o) => o.changeId);
    expect(ids).toEqual(expect.arrayContaining([a!.changeId, b!.changeId]));
    expect(ids).not.toContain(c.changes[0]!.changeId);
    expect(ids).not.toContain(mine);
    const announced = q.origins.find((o) => o.changeId === b!.changeId)!;
    expect(announced).toMatchObject({ appId: app.id, orgId: net.org, keyId: net.k.id, keyLabel: 'Backend key', origin: b!.origin });
    expect(announced.activeFrom! - announced.notifiedAt!).toBeGreaterThanOrEqual(DAY);
    expect(q.origins.find((o) => o.changeId === a!.changeId)).not.toHaveProperty('notifiedAt');
    // Unannounced first, then the soonest.
    expect(ids.indexOf(a!.changeId)).toBeLessThan(ids.indexOf(b!.changeId));
    expect(q.keys.map((k) => k.id)).toContain(reg.key.id);
    expect(q.keys.map((k) => k.id)).not.toContain(net.k.id);
    // Staff only.
    expect(await adminRpc().platformQueue({ ...system(), limit: 100 })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('the change notices’ platform field', () => {
  it('a platform proposal carries its request, key and the wait its ack gives; a member’s none', async () => {
    const net = await network();
    const app = await createdApp(net, ['https://a.partner-three.example', 'https://b.partner-three.example']);
    const mine = await memberProposal(net.site, { kind: 'origin_add', origin: 'https://member-three.partner.example' });
    const page = await adminRpc().pendingNotices({ ...system(), limit: 100 });
    if (!page.ok) throw new Error(page.code);
    const ours = page.notices.filter((x) => app.changes.some((c) => c.changeId === x.change.id));
    expect(ours).toHaveLength(2);
    expect(new Set(ours.map((x) => x.platform?.requestId)).size).toBe(1);
    for (const x of ours) expect(x.platform).toMatchObject({ keyId: net.k.id, keyLabel: 'Backend key', waitMs: DAY });
    // Next to each other on the page (one email per request).
    const at = page.notices.findIndex((x) => x.change.id === ours[0]!.change.id);
    expect(page.notices[at + 1]!.change.id).toBe(ours[1]!.change.id);
    expect(page.notices.find((x) => x.change.id === mine)).not.toHaveProperty('platform');
  });
});
