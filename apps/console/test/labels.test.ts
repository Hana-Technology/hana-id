// D899 (partner labels piece 4): the console's Request labels routes over the real API. `GET …/scopes/:scope/labels`
// (any member: the entries with their text, the versions that ended with Journear's note on a blocked one, whether
// labels are on here, Journear's switch and review), the owner's Cancel of a waiting label change (`lc_`, immediate, no
// fresh sign-in, open in a frozen org as every cancel is), the `labels.set` action's review (the API's diff, the apps by
// name, whether Journear reviews it first), `labels.remove`'s apps, and the Request labels tab as the page a step-up
// returns to. No new authority: every write is ConsoleRpc's own, unchanged.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionOf, breathe, createAction, getAs, member, postAs, stepUp } from './c10.ts';
import { installChain, oidc, setChain, setScope, uninstallChain } from './chain.ts';
import { MockGoogle } from './google.ts';
import { auditRows, db, hana, linkPair, seedHotApp, system } from './helpers.ts';

let google: MockGoogle;
beforeEach(async () => {
  await breathe(700);
  installChain();
  google = new MockGoogle();
  await google.init();
  await setChain(google);
});
afterEach(() => {
  vi.restoreAllMocks();
  uninstallChain();
});

const PASSPHRASE = 'Test SDF Network ; September 2015';
const TILL = 'GBBQI276ICJLH2KJSTVNUFO4YIGYVKQHWZMP2OKU5OHA564L3SS55TZP';
const paymentDoc = (object = 'order') =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { stellar: { networkPassphrase: PASSPHRASE } },
    metadata: { addressBook: [{ account: TILL, name: 'Coffee Club till' }] },
    display: { formats: { payment: { call: { memo: 'text', feeAtMost: '100000' }, intent: { verb: 'pay', object }, sentence: ['verb', { word: 'for' }, 'object', { field: 'memo' }], fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }] } } },
  });

async function ownerWithApp() {
  const m = await member('owner');
  const app = await seedHotApp(m.org);
  await setScope({ id: app.scope, owners: [oidc(m.sub)], action_nonce: 3 });
  return { m, app };
}

interface ListBody {
  labelsVersion: number;
  enabled: boolean;
  orgOff: string | null;
  reviewRequired: boolean;
  now: number;
  entries: { id: string; removedAt: number | null; current: { id: string; text?: string } | null; waiting: { id: string; state: string; text?: string; apps: { id: string; name: string | null }[] } | null; recent: { id: string; state: string; blockNote?: string | null }[] }[];
}
const list = (m: Parameters<typeof getAs>[0], org: string, scope: string) => getAs<ListBody>(m, `/api/orgs/${org}/scopes/${scope}/labels`);

/** Proposes `doc` through the console's own action and the fresh sign-in; answers the change and the entry. */
async function propose(m: Awaited<ReturnType<typeof member>>, app: { id: string; scope: string }, doc = paymentDoc(), labelId?: string) {
  const a = await createAction(m, 'labels.set', { scopeId: app.scope, ...(labelId ? { labelId } : {}), document: doc, appIds: [app.id] });
  await stepUp(google, m, a.id);
  const out = (await actionOf(m, a.id)).body as unknown as { status: string; outcome: { changeId: string; labelId: string } };
  expect(out.status).toBe('ok');
  return { action: a, changeId: out.outcome.changeId, labelId: out.outcome.labelId };
}

describe('GET /api/orgs/:org/scopes/:scope/labels', () => {
  it('any member reads the entries (the waiting version with its text), whether labels are on, Journear’s switch and review, and the server’s now', async () => {
    const { m, app } = await ownerWithApp();
    const empty = await list(m, m.org, app.scope);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ labelsVersion: 0, entries: [], enabled: true, orgOff: null, reviewRequired: false });
    expect(Math.abs(empty.body.now - Date.now())).toBeLessThan(60_000);
    const p = await propose(m, app);
    const viewer = await member('viewer', { org: m.org });
    const r = await list(viewer, m.org, app.scope);
    expect(r.status).toBe(200);
    expect(r.body.labelsVersion).toBe(1);
    expect(r.body.entries).toEqual([expect.objectContaining({ id: p.labelId, current: null, removedAt: null, recent: [], waiting: expect.objectContaining({ id: p.changeId, state: 'proposed', text: paymentDoc(), apps: [{ id: app.id, name: expect.any(String) }] }) })]);
  });

  it('a blocked change is listed under the entry’s recent versions with Journear’s note; a member of another org gets 404', async () => {
    const { m, app } = await ownerWithApp();
    const p = await propose(m, app);
    const ack = await env.API_ADMIN.ackLabelNotice({ ...system(), changeId: p.changeId, cancelTokenHash: (await linkPair()).hashB64 });
    expect(ack.ok, JSON.stringify(ack)).toBe(true);
    const detail = (await env.API_ADMIN.labelDetail({ ...hana(), changeId: p.changeId })) as unknown as { ok: true; item: { labelsVersion: number; change: { state: string } } };
    const note = 'The words would mislead users about the fare';
    const b = await env.API_ADMIN.labelStaffAct({ ...hana(), changeId: p.changeId, tool: 'block', note, seen: { labelsVersion: detail.item.labelsVersion, state: detail.item.change.state } });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    const r = await list(m, m.org, app.scope);
    expect(r.body.entries).toEqual([expect.objectContaining({ id: p.labelId, current: null, waiting: null, recent: [expect.objectContaining({ id: p.changeId, state: 'blocked', blockNote: note })] })]);
    // A cancelled one carries no note.
    const q = await propose(m, app, paymentDoc('the order'), p.labelId);
    expect((await postAs(m, `/api/orgs/${m.org}/changes/${q.changeId}/cancel`, {})).status).toBe(200);
    const after = await list(m, m.org, app.scope);
    const recent = after.body.entries[0]!.recent;
    expect(recent.map((x) => x.state)).toEqual(['cancelled', 'blocked']);
    expect(recent[0]!.blockNote).toBeUndefined();
    const stranger = await member('owner');
    expect((await list(stranger, m.org, app.scope)).status).toBe(404);
    expect((await list(m, m.org, 'snotmine1')).status).toBe(404);
  });

  it('says when Journear reviews the org’s changes, and when it has switched the org’s labels off', async () => {
    const { m, app } = await ownerWithApp();
    const controls = (await env.API_ADMIN.labelControls({ ...hana() })) as unknown as { ok: true; controls: { orgs: { orgId: string; version: number }[] } };
    const v = controls.controls.orgs.find((o) => o.orgId === m.org)?.version ?? 0;
    const on = await env.API_ADMIN.labelControl({ ...hana(), target: { kind: 'org', orgId: m.org }, what: 'review_on', note: 'Reviewing this partner for now', seenVersion: v });
    expect(on.ok, JSON.stringify(on)).toBe(true);
    expect((await list(m, m.org, app.scope)).body).toMatchObject({ reviewRequired: true, orgOff: null });
    const off = await env.API_ADMIN.labelControl({ ...hana(), target: { kind: 'org', orgId: m.org }, what: 'off', note: 'Switched off while we look into it', seenVersion: v + 1 });
    expect(off.ok, JSON.stringify(off)).toBe(true);
    expect((await list(m, m.org, app.scope)).body).toMatchObject({ reviewRequired: true, orgOff: 'org' });
    // Proposing is refused, in Journear's words, before any fresh sign-in.
    const r = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'labels.set', params: { scopeId: app.scope, document: paymentDoc(), appIds: [app.id] } });
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'forbidden', message: expect.stringMatching(/^Journear has switched request labels off for your organisation/u) } } });
  });
});

describe('cancel a waiting label change: POST /api/orgs/:org/changes/lc_…/cancel', () => {
  it('an owner cancels at once (no fresh sign-in), audited with the change’s id; a viewer is refused; a frozen org may still cancel', async () => {
    const { m, app } = await ownerWithApp();
    const p = await propose(m, app);
    const viewer = await member('viewer', { org: m.org });
    expect((await postAs(viewer, `/api/orgs/${m.org}/changes/${p.changeId}/cancel`, {})).status).toBe(403);
    const r = await postAs<{ id: string; state: string }>(m, `/api/orgs/${m.org}/changes/${p.changeId}/cancel`, {});
    expect(r).toMatchObject({ status: 200, body: { id: p.changeId, state: 'cancelled' } });
    const rows = await auditRows("action = 'change.cancelled' AND org_id = ?", m.org);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'ok', target: m.org, details_json: JSON.stringify({ changeId: p.changeId }) })]);
    expect(await db.prepare("SELECT app_id FROM audit_log WHERE action = 'change.cancelled' AND org_id = ?").bind(m.org).first('app_id')).toBeNull();
    // Twice: not pending any more.
    expect((await postAs(m, `/api/orgs/${m.org}/changes/${p.changeId}/cancel`, {})).body).toMatchObject({ error: { code: 'not_pending' } });
    // A frozen org's owner can still cancel (cancels and kill switches stay open).
    const q = await propose(m, app, paymentDoc('the order'), p.labelId);
    await env.CONSOLE_DB.prepare("UPDATE orgs SET status = 'frozen' WHERE id = ?").bind(m.org).run();
    expect((await postAs(m, `/api/orgs/${m.org}/changes/${q.changeId}/cancel`, {})).status).toBe(200);
    // Another org's id is refused as not found.
    const other = await ownerWithApp();
    const o = await propose(other.m, other.app);
    expect((await postAs(m, `/api/orgs/${m.org}/changes/${o.changeId}/cancel`, {})).status).toBe(404);
    // A malformed id is no route.
    expect((await postAs(m, `/api/orgs/${m.org}/changes/xx_1/cancel`, {})).status).toBe(404);
  });
});

describe('labels.set and labels.remove: the review the confirmation page shows', () => {
  it('a new entry: every line added, the apps by name, no review; a new version: what changed; the Request labels tab as the page to return to', async () => {
    const { m, app } = await ownerWithApp();
    const a = await createAction(m, 'labels.set', { scopeId: app.scope, document: paymentDoc(), appIds: [app.id] });
    expect(a.decoded).toMatchObject({ reviewRequired: false, apps: [{ id: app.id, name: expect.any(String) }] });
    const diff = a.decoded.diff as { change: string; key: string }[];
    expect(diff.map((x) => [x.key, x.change])).toEqual([
      ['(contract)', 'added'],
      ['payment', 'added'],
    ]);
    await stepUp(google, m, a.id);
    const labelId = ((await actionOf(m, a.id)).body.outcome as { labelId: string }).labelId;
    // The version in force is what a new version is compared with: here nothing is in force yet, so all is added again.
    const b = await postAs<{ decoded: { diff: { key: string; change: string; before: string | null; after: string | null }[] }; returnTo: string }>(m, `/api/orgs/${m.org}/actions`, {
      kind: 'labels.set',
      params: { scopeId: app.scope, labelId, document: paymentDoc('the order'), appIds: [app.id] },
      returnTo: { page: 'labels', appId: app.id },
    });
    // One version waits already: the API refuses a second.
    expect(b).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    // The tab as the page to return to: it needs the app, of the action's scope.
    const c = await postAs<{ returnTo: string }>(m, `/api/orgs/${m.org}/actions`, { kind: 'labels.remove', params: { scopeId: app.scope, labelId }, returnTo: { page: 'labels', appId: app.id } });
    expect(c).toMatchObject({ status: 200, body: { returnTo: `/orgs/${m.org}/apps/${app.id}/labels` } });
    expect((c.body as unknown as { decoded: { apps: unknown[]; waiting: string } }).decoded).toMatchObject({ apps: [{ id: app.id }], waiting: expect.stringMatching(/^lc_/u) });
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'labels.remove', params: { scopeId: app.scope, labelId }, returnTo: { page: 'labels' } })).status).toBe(400);
    const foreign = await seedHotApp((await member('owner')).org);
    expect((await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'labels.remove', params: { scopeId: app.scope, labelId }, returnTo: { page: 'labels', appId: foreign.id } })).status).toBe(404);
  });

  it('a change of what is in force: the diff says what changes; review on: the action says so', async () => {
    const { m, app } = await ownerWithApp();
    const p = await propose(m, app);
    const ack = await env.API_ADMIN.ackLabelNotice({ ...system(), changeId: p.changeId, cancelTokenHash: (await linkPair()).hashB64 });
    expect(ack.ok, JSON.stringify(ack)).toBe(true);
    // In force once its time has passed (the test env's delay).
    await env.HOT_DB.prepare('UPDATE label_changes SET active_from = ?, notified_at = ? WHERE id = ?').bind(Date.now() - 1000, Date.now() - 2000, p.changeId).run();
    const a = await createAction(m, 'labels.set', { scopeId: app.scope, labelId: p.labelId, document: paymentDoc('the order'), appIds: [app.id] });
    const diff = a.decoded.diff as { key: string; change: string; before: string | null; after: string | null }[];
    expect(diff.find((x) => x.key === '(contract)')).toMatchObject({ change: 'same' });
    expect(diff.find((x) => x.key === 'payment')).toMatchObject({ change: 'changed', before: expect.stringContaining('pay for order'), after: expect.stringContaining('pay for the order') });
    const controls = (await env.API_ADMIN.labelControls({ ...hana() })) as unknown as { ok: true; controls: { orgs: { orgId: string; version: number }[] } };
    const v = controls.controls.orgs.find((o) => o.orgId === m.org)?.version ?? 0;
    expect((await env.API_ADMIN.labelControl({ ...hana(), target: { kind: 'org', orgId: m.org }, what: 'review_on', note: 'Reviewing this partner for now', seenVersion: v })).ok).toBe(true);
    const b = await createAction(m, 'labels.set', { scopeId: app.scope, labelId: p.labelId, document: paymentDoc('the order'), appIds: [app.id] });
    expect(b.decoded.reviewRequired).toBe(true);
  });
});

describe('after PR 126’s review (D899)', () => {
  it('the list and the review carry the environment’s delay', async () => {
    const { m, app } = await ownerWithApp();
    expect((await list(m, m.org, app.scope)).body).toMatchObject({ delayMs: 60_000 });
    const a = await createAction(m, 'labels.set', { scopeId: app.scope, document: paymentDoc(), appIds: [app.id] });
    expect(a.decoded.delayMs).toBe(60_000);
  });

  it('removing an entry that was removed already is refused before any fresh sign-in', async () => {
    const { m, app } = await ownerWithApp();
    const p = await propose(m, app);
    const r = await createAction(m, 'labels.remove', { scopeId: app.scope, labelId: p.labelId });
    await stepUp(google, m, r.id);
    expect((await actionOf(m, r.id)).body).toMatchObject({ status: 'ok' });
    // Still listed (removed in the last 14 days), and not removable again.
    expect((await list(m, m.org, app.scope)).body.entries).toEqual([expect.objectContaining({ id: p.labelId, removedAt: expect.any(Number) })]);
    const again = await postAs(m, `/api/orgs/${m.org}/actions`, { kind: 'labels.remove', params: { scopeId: app.scope, labelId: p.labelId } });
    expect(again).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'These request labels were removed already' } } });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE org_id = ? AND kind = 'labels.remove'").bind(m.org).first('n')).toBe(1);
  });
});
