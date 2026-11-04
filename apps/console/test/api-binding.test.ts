// The console → API wiring over a real service binding (docs/batch-c-spec.md "Topology", "Bindings"): the console's
// `API` binding (from its generated config) reaches the real API Worker's `ConsoleRpc` (bundled from apps/api), never
// its `AdminRpc` methods; the emailed-link cancel runs end to end through the console's `POST /api/cancel`; and its
// outcome lands in audit_log after the RPC returns, while app_changes (the API's) is authoritative.
import { newId } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { auditRows, hana, linkPair, post, rid, seedHotApp, system } from './helpers.ts';

const memberActor = () => ({ actor: { kind: 'member' as const, id: newId('user'), sub: 'sub-1', email: 'owner@partner.example', sessionHash: 'A'.repeat(43) }, requestId: rid(), clientIp: '203.0.113.7' });

/** A pending origin add on a fresh app, announced with a known cancel token (the admin Worker's role, done here). */
async function announcedChange() {
  const app = await seedHotApp();
  const version = (await env.HOT_DB.prepare('SELECT origins_version AS v FROM apps WHERE id = ?').bind(app.id).first<number>('v'))!;
  const added = await env.API_ADMIN.addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://new.partner.example'], expectedVersion: version });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  const changeId = (added as unknown as { changes: { id: string }[] }).changes[0]!.id;
  const pair = await linkPair();
  const ack = await env.API_ADMIN.ackNotice({ ...system(), changeId, cancelTokenHash: pair.hashB64 });
  expect(ack.ok, JSON.stringify(ack)).toBe(true);
  return { app, changeId, pair };
}

describe('the API binding (real ConsoleRpc)', () => {
  it('answers ConsoleRpc for a member actor, scoped to the org', async () => {
    const app = await seedHotApp();
    const mine = await env.API.listApps({ ...memberActor(), orgId: app.org });
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.apps.map((a) => a.id)).toEqual([app.id]);
    const other = await env.API.listApps({ ...memberActor(), orgId: newId('org') });
    expect(other).toEqual({ ok: true, apps: [] });
  });

  it("validates at the API: a staff actor and a malformed call are refused, whatever the console sends", async () => {
    const app = await seedHotApp();
    expect(await env.API.listApps({ ...hana(), orgId: app.org } as never)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await env.API.listApps({ ...memberActor(), orgId: "org_x' OR 1=1" })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it("can't reach AdminRpc's methods through the console's binding", async () => {
    const api = env.API as unknown as Record<string, (c: unknown) => Promise<unknown>>;
    for (const method of ['ackNotice', 'createApp', 'expediteChange', 'setSecurityContacts', 'pendingNotices']) {
      await expect(Promise.resolve().then(() => api[method]!({ ...system(), changeId: 'gc_x', cancelTokenHash: 'A'.repeat(43) })), method).rejects.toThrow();
    }
  });

  it('is an RPC binding only: the ConsoleRpc entrypoint has no fetch', async () => {
    await expect(env.API.fetch('https://api.test/v1/app', { method: 'GET' })).rejects.toThrow(/fetch/u);
  });
});

describe('POST /api/cancel: the emailed link, end to end', () => {
  it('cancels the announced change with its token and audits the outcome after the RPC', async () => {
    const { app, changeId, pair } = await announcedChange();
    const res = await post('/api/cancel', { changeId, token: pair.tokenB64 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: changeId, appId: app.id, status: 'cancelled' });
    const ledger = await env.HOT_DB.prepare("SELECT actor_kind, actor_id FROM app_changes WHERE app_id = ? AND kind LIKE '%cancel%'").bind(app.id).all<{ actor_kind: string; actor_id: string }>();
    expect(ledger.results).toEqual([{ actor_kind: 'link', actor_id: changeId }]);
    const rows = await auditRows("action = 'change.link_cancel' AND target = ?", changeId);
    expect(rows).toEqual([{ action: 'change.link_cancel', actor_kind: 'link', actor_id: changeId, target: changeId, org_id: null, details_json: '{}', outcome: 'ok' }]);
  });

  it('is single use: a second confirm is refused and audited as failed', async () => {
    const { changeId, pair } = await announcedChange();
    expect((await post('/api/cancel', { changeId, token: pair.tokenB64 })).status).toBe(200);
    const again = await post('/api/cancel', { changeId, token: pair.tokenB64 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'not_pending' } });
    const rows = await auditRows("action = 'change.link_cancel' AND target = ? AND outcome = 'failed'", changeId);
    expect(rows.map((r) => r.details_json)).toEqual(['{"code":"not_pending"}']);
  });

  it("refuses another change's token (403) and writes no audit row for it", async () => {
    const a = await announcedChange();
    const b = await announcedChange();
    const res = await post('/api/cancel', { changeId: a.changeId, token: b.pair.tokenB64 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await auditRows("action = 'change.link_cancel' AND target = ?", a.changeId)).toEqual([]);
    const status = await env.HOT_DB.prepare('SELECT cancelled_at FROM guarded_changes WHERE id = ?').bind(a.changeId).first('cancelled_at');
    expect(status).toBeNull();
  });

  it('a GET never cancels', async () => {
    const { changeId, pair } = await announcedChange();
    const { request } = await import('./helpers.ts');
    const res = await request(`/api/cancel?changeId=${changeId}&token=${pair.tokenB64}`);
    expect(res.status).toBe(405);
    expect(await env.HOT_DB.prepare('SELECT cancelled_at FROM guarded_changes WHERE id = ?').bind(changeId).first('cancelled_at')).toBeNull();
  });

  it('refuses a malformed body before calling the API', async () => {
    for (const body of [{}, { changeId: 'gc_x' }, { changeId: 'gc_x', token: 'short' }, { changeId: 'nope', token: 'A'.repeat(43) }, { changeId: 'gc_x', token: 'A'.repeat(43), extra: 1 }]) {
      const res = await post('/api/cancel', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await post('/api/cancel', '{not json');
    expect(res.status).toBe(400);
  });
});
