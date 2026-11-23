// "Partner labels" (D894) in the admin Worker: the label notice step (sends to the alias and every contact, acks with
// sha256 of the cancel link's token only after every send was accepted; a failed send or no room in the budget acks
// nothing), the feed's own mail when Journear blocks a change (and no digest line for it, nor for the proposal), the
// staff routes (the one-time token, console-core's schemas, the audit row first and no action without it, a re-sent
// form, a page that moved, an older API or console), the System status tile's states, and the staff words kept plain.
// Against the real API and console where the path can be taken; AdminRpc's label methods are stubbed where a test needs
// an answer the API wouldn't give here.
import { type LabelControls, type LabelFeedItem, linkToken } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { durationWords, labelsBlocked, labelsLapsed, labelsProposed, nameList } from '../src/email/messages.ts';
import { SKIPPED_CHANGE_KINDS, runFeed } from '../src/feed.ts';
import { Budget } from '../src/mail.ts';
import { runLabelNotices } from '../src/notices.ts';
import { ALREADY_SENT, CHANGE_MOVED, NO_CLEAR_ANSWER, SWITCH_MOVED, actDoneWords, controlWords, labelActRoute, labelControlRoute, labelRoute, labelsRoute } from '../src/partner-labels.ts';
import type { RouteCtx } from '../src/routes.ts';
import { staffCtx } from '../src/rpc.ts';
import { type StatusAnswer, buildStatus, resetStatusCache } from '../src/status.ts';
import { ALIAS, CONSOLE, FakeEmail, STAFF_EMAIL, STAFF_SUB, adminRequest, downBinding, envWith, json, labelChangeRow, linkIn, memoryOps, newOpsData, overrideBinding, seedConsoleOrg, seedHotApp, seedLabelChange, sha256Hex, stubNetwork, tokenOf, uid, visibleText } from './helpers.ts';

/** Protocol words and codes kept out of staff sentences (evm-relay.test.ts's rule, D853, D879). */
const STAFF_JARGON = /\bnonce\b|\bRPC\b|\bmempool\b|\bEVM\b|halted|EIP|delegate|_|\bschema\b|\bJSON\b|\bversion_conflict\b/iu;

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const big = () => new Budget(1000);

// ---- the notice (label_pending) ----

describe('the request labels notice', () => {
  it('emails the alias and every contact one message each, then acks with sha256 of the cancel link’s token', async () => {
    const app = await seedHotApp(undefined, { contacts: [`a-${uid()}@partner.example`, `b-${uid()}@partner.example`] });
    const contacts = (await env.HOT_DB.prepare('SELECT email FROM org_security_contacts WHERE org_id = ?1 ORDER BY email').bind(app.org).all<{ email: string }>()).results.map((r) => r.email);
    const c = await seedLabelChange({ app });
    expect((await labelChangeRow(c.id))!.notified_at).toBeNull();
    const fake = new FakeEmail();
    const r = await runLabelNotices(env, fake, big());
    expect(r.acked).toBeGreaterThanOrEqual(1);
    const mine = fake.about(c.id);
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, ...contacts].sort());
    for (const m of mine) {
      expect(m.subject).toMatch(new RegExp(`\\[Journear Passport sandbox-test\\] Request labels proposed for Test ${app.id}$`, 'u'));
      expect(m.text).toContain(`Someone with owner rights in your organisation proposed request labels for Test ${app.id}: the words the approval window will show your users for your app’s requests, in your app’s name. Unless someone cancels them, they go live 1 minute after this email. Journear may block them if they would mislead users.`);
      expect(m.text).toContain('What users would see (example values):');
      expect(m.text).toContain(`Test ${app.id} says: collect the stamp “Arrival”`);
      expect(m.text).toContain('- Stamp: “Arrival”');
      // Every line is new (a first version): the API's diff lines, each as it reads (the line and its rows).
      expect(m.text).toContain(`What changes:\n\n- Added: NEAR test network, `);
      expect(m.text).toContain(`- Added: Test ${app.id} says: collect the stamp “Arrival” · Stamp: “Arrival”`);
      expect(m.text).toContain('Sent by Journear Passport security.');
      // The designed layout: the heading, one button (the cancel page), every other link-looking text unlinked.
      expect(visibleText(m.html)).toContain('Request labels proposed');
      const hrefs = [...m.html.matchAll(/href="([^"]*)"/gu)].map((x) => x[1]!);
      expect(hrefs).toHaveLength(1);
      expect(hrefs[0]!.startsWith(`${CONSOLE}/cancel/${c.id}#t=`)).toBe(true);
      expect(m.html).not.toMatch(/<script/iu);
    }
    const token = tokenOf(linkIn(mine[0]!.text, `/cancel/${c.id}`));
    // Deterministic, as a guarded change's: HMAC(CANCEL_LINK_KEY, "hana-id/cancel-link/v1" ‖ id).
    expect([...token]).toEqual([...(await linkToken('cancelLink', new Uint8Array(32).fill(1), c.id))]);
    const row = await labelChangeRow(c.id);
    expect(row!.notified_at).not.toBeNull();
    expect(row!.active_from).toBe(row!.notified_at! + 60_000);
    expect(row!.h).toBe((await sha256Hex(token)).toUpperCase());
    // A second run sends nothing more for it.
    const again = new FakeEmail();
    await runLabelNotices(env, again, big());
    expect(again.about(c.id)).toEqual([]);
  });

  it('a provider failure on one recipient acks nothing; the retry acks with the same token, to that recipient only', async () => {
    const c = await seedLabelChange();
    const fake = new FakeEmail();
    fake.failFor.add(c.app.contact);
    const first = await runLabelNotices(env, fake, big());
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect((await labelChangeRow(c.id))!).toMatchObject({ notified_at: null, h: null });
    const token = tokenOf(linkIn(fake.about(c.id).find((m) => m.to === ALIAS)!.text, `/cancel/${c.id}`));
    fake.failFor.clear();
    await runLabelNotices(env, fake, big());
    expect((await labelChangeRow(c.id))!.h).toBe((await sha256Hex(token)).toUpperCase());
    expect(fake.attempts.filter((m) => m.to === ALIAS && m.text.includes(c.id))).toHaveLength(1);
    expect(fake.attempts.filter((m) => m.to === c.app.contact && m.text.includes(c.id))).toHaveLength(2);
  });

  it('acks nothing without the email key or the cancel-link key, or when the budget can’t hold every email and the ack', async () => {
    const c = await seedLabelChange();
    const off = new FakeEmail();
    off.configured = false;
    await runLabelNotices(env, off, big());
    expect((await labelChangeRow(c.id))!.notified_at).toBeNull();
    const fake = new FakeEmail();
    expect(await runLabelNotices(envWith({ CANCEL_LINK_KEY: undefined }), fake, big())).toEqual({ acked: 0, failed: 0, skipped: 0 });
    // The page read and one notice's two emails and its ack need 4 calls; 3 reads the page only if a notice fits.
    await runLabelNotices(env, fake, new Budget(2));
    expect(fake.attempts).toEqual([]);
    const tight = await runLabelNotices(env, fake, new Budget(3));
    expect(tight.acked).toBe(0);
    expect(fake.about(c.id)).toEqual([]);
    expect((await labelChangeRow(c.id))!.notified_at).toBeNull();
    await runLabelNotices(env, fake, big());
    expect((await labelChangeRow(c.id))!.notified_at).not.toBeNull();
  });

  it('a page the API refuses, or an API without the method, sends nothing (the change notices still run)', async () => {
    const fake = new FakeEmail();
    const refusing = overrideBinding(env.API, { labelNotices: async () => ({ ok: false, code: 'internal' }) });
    expect(await runLabelNotices(envWith({ API: refusing }), fake, big())).toEqual({ acked: 0, failed: 0, skipped: 0 });
    const { runNotices } = await import('../src/notices.ts');
    const old = overrideBinding(env.API, { labelNotices: () => Promise.reject(new TypeError('labelNotices is not a function')) });
    const out = await runNotices(envWith({ API: old }), fake, big());
    expect(out.labels).toBeNull();
    expect(out.changes).not.toBeNull();
    expect(fake.attempts).toEqual([]);
  });

  it('the words: a change of an existing set lists only what changes, before and after; the wait in words', () => {
    const notice = {
      change: { id: 'lc_x1', labelId: 'pl_x', orgId: 'org_x', scopeId: 'sx', environment: 'test', apps: [{ id: 'app_a', name: 'Stamps' }, { id: 'app_b', name: 'Club' }], proposedAt: Date.UTC(2026, 10, 23, 9, 0) },
      contacts: [],
      preview: { appName: 'Stamps', context: 'NEAR test network, x.testnet', examples: true, formats: [{ key: 'collect', line: 'Stamps says: claim the stamp “Arrival”', sentence: '', parts: [], fields: [{ label: 'Stamp', value: '“Arrival”' }] }] },
      diff: [
        { change: 'changed', key: 'collect', before: 'Stamps says: collect the stamp “Arrival”', after: 'Stamps says: claim the stamp “Arrival”' },
        { change: 'same', key: 'redeem', before: 'Stamps says: redeem', after: 'Stamps says: redeem' },
        { change: 'removed', key: 'old', before: 'Stamps says: old words', after: null },
      ],
    } as never;
    const m = labelsProposed({ env: 'sandbox-test', consoleOrigin: CONSOLE }, notice, { cancelUrl: `${CONSOLE}/cancel/lc_x1#t=${'A'.repeat(43)}`, delayMs: 86_400_000 });
    expect(m.subject).toBe('[Journear Passport sandbox-test] Request labels proposed for Stamps');
    expect(m.text).toContain('proposed request labels for Stamps and Club:');
    expect(m.text).toContain('they go live 1 day after this email');
    expect(m.text).toContain('- Changed: Stamps says: collect the stamp “Arrival” → Stamps says: claim the stamp “Arrival”\n- Removed: Stamps says: old words');
    expect(m.text).not.toContain('redeem');
    expect([durationWords(60_000), durationWords(86_400_000), durationWords(90 * 60_000), durationWords(7 * 86_400_000), durationWords(1000)]).toEqual(['1 minute', '1 day', '1 hour 30 minutes', '7 days', 'less than a minute']);
    expect([nameList(['A']), nameList(['A', 'B']), nameList(['A', 'B', 'C'])]).toEqual(['A', 'A and B', 'A, B and C']);
  });
});

// ---- the feed ----

describe('the feed: the proposal is the notice’s; a block gets its own mail', () => {
  it('labels.proposed and its change.announced are left out of the digest', () => {
    expect(SKIPPED_CHANGE_KINDS.has('labels.proposed')).toBe(true);
    expect(SKIPPED_CHANGE_KINDS.has('change.announced')).toBe(true);
  });

  async function drain(e: typeof env, data = newOpsData(), fake = new FakeEmail()) {
    for (let i = 0; i < 50; i++) {
      const before = fake.attempts.length;
      await runFeed(e, memoryOps(data), fake, big());
      if (fake.attempts.length === before) break;
    }
    return { data, fake };
  }
  const staff = () => staffCtx({ actor: { kind: 'hana', id: STAFF_SUB, email: STAFF_EMAIL }, requestId: `lblact_${uid().replace(/[^A-Za-z0-9]/gu, 'x').padEnd(22, 'x').slice(0, 22)}`, clientIp: '198.51.100.9' });

  async function blocked(o: { live?: boolean } = {}) {
    const c = await seedLabelChange(o.live ? { notifiedAt: Date.now() - 120_000, activeFrom: Date.now() - 60_000 } : {});
    const d = await env.API.labelDetail({ ...staff(), changeId: c.id });
    if (!d.ok) throw new Error(JSON.stringify(d));
    const r = await env.API.labelStaffAct({ ...staff(), changeId: c.id, tool: 'block', note: 'The words hide that the call moves money', seen: { labelsVersion: d.item.labelsVersion, state: d.item.change.state } });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    return c;
  }

  it('to the alias and the contacts: the apps, never seen (or no longer seen), the note, how to ask and try again; no digest line', async () => {
    const { data } = await drain(env);
    const c = await blocked();
    const names = overrideBinding(env.API, { labelDetail: async (x: unknown) => env.API.labelDetail({ ...(x as object), ...staff() }) });
    const { fake } = await drain(envWith({ API: names }), data);
    const mine = fake.sent.filter((m) => m.subject.includes('Journear blocked a change to request labels'));
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, c.app.contact].sort());
    for (const m of mine) {
      expect(m.subject).toMatch(new RegExp(`\\[Journear Passport sandbox-test\\] Journear blocked a change to request labels for Test ${c.app.id}$`, 'u'));
      expect(m.text).toContain(`Journear blocked a change to the request labels of Test ${c.app.id} (${c.id}): the words the approval window shows your users for your app’s requests. Your users will never see it.`);
      expect(m.text).toContain('Journear’s note: “The words hide that the call moves money”');
      expect(m.text).toContain('To ask why, reply to this email or write to your Journear contact. To try again, change the labels in the console; the new change waits 1 minute again.');
      expect(m.html).not.toMatch(/href=/u);
    }
    // The digest of the org's other rows carries no line for the block.
    for (const m of fake.to(c.app.contact).filter((x) => x.subject.includes('app change'))) expect(m.text).not.toContain('labels.blocked');    // One message for one block: the `label_blocked` security event goes to the security alias only, never the partner.
    expect(fake.sent.filter((m) => m.to === c.app.contact && m.subject.includes('Security event'))).toEqual([]);
    expect(fake.sent.some((m) => m.to === ALIAS && m.subject.includes('Security event: label_blocked'))).toBe(true);
  });

  it('a block of labels in force says users stop seeing them now; without the app names (the lookup refused) it says “your app”', async () => {
    const { data } = await drain(env);
    const c = await blocked({ live: true });
    const { fake } = await drain(envWith({ API: overrideBinding(env.API, { labelDetail: async () => ({ ok: false, code: 'forbidden' }) }) }), data);
    const m = fake.sent.find((x) => x.to === c.app.contact && x.subject.includes('Journear blocked'))!;
    expect(m.subject).toContain('Journear blocked a change to request labels for your app');
    expect(m.text).toContain(`Journear blocked a change to the request labels of your app (${c.id}): the words the approval window shows your users for your app’s requests. Your users see the plain approval window for these requests from now, without your earlier labels either.`);
  });

  it('the notice when staff review is on: it goes live only once Journear allows it, at the earliest after the wait; it lapses after 7 days; the org’s name', () => {
    const notice = {
      change: { id: 'lc_r1', labelId: 'pl_x', orgId: 'org_x', scopeId: 'sx', environment: 'test', apps: [{ id: 'app_a', name: 'Stamps' }], proposedAt: Date.UTC(2026, 10, 23, 9, 0), reviewRequired: true },
      contacts: [],
      preview: null,
      diff: [],
    } as never;
    const m = labelsProposed({ env: 'sandbox-test', consoleOrigin: CONSOLE }, notice, { cancelUrl: `${CONSOLE}/cancel/lc_r1#t=${'A'.repeat(43)}`, delayMs: 86_400_000, orgName: 'Stamp Rally Ltd' });
    expect(m.text).toContain('Journear reviews them first: they go live only after Journear allows them, at the earliest 1 day after this email, unless someone cancels them. If Journear hasn’t allowed them within 7 days of that time, they lapse and nothing changes.');
    expect(m.text).not.toContain('Unless someone cancels them, they go live');
    expect(m.text).toContain('Stamp Rally Ltd (org_x)');
  });

  it('a change held for review that lapsed: its own mail', () => {
    const m = labelsLapsed({ env: 'sandbox-test', consoleOrigin: CONSOLE }, { seq: 2, at: Date.UTC(2026, 10, 30, 9, 0), kind: 'change.cancelled', orgId: 'org_x', scopeId: 'sx', appId: null, actorKind: 'system', actorId: 'cron', detail: { changeId: 'lc_7', kind: 'label_set', reason: 'not_reviewed' } } as never, { apps: ['Stamps'] });
    expect(m.subject).toBe('[Journear Passport sandbox-test] A change to request labels lapsed for Stamps');
    expect(m.text).toContain('A change to the request labels of Stamps (lc_7), the words the approval window shows your users for your app’s requests, lapsed: Journear didn’t allow it within 7 days of its time, so your users never see it. Nothing else changed.');
  });

  it('a block of a live change while Journear had the labels switched off says what is true', () => {
    const m = labelsBlocked({ env: 'sandbox-test', consoleOrigin: CONSOLE }, { seq: 3, at: Date.UTC(2026, 10, 23, 9, 0), kind: 'labels.blocked', orgId: 'org_x', scopeId: 'sx', appId: null, actorKind: 'hana', actorId: 'staff', detail: { changeId: 'lc_8', wasLive: true, offBy: 'org', note: 'x' } } as never, { apps: ['Stamps'], delayMs: 86_400_000 });
    expect(m.text).toContain('Your users weren’t seeing it: Journear had already switched these labels off. When they are switched back on, neither these nor your earlier labels will show.');
  });

  it('the mail’s words on their own', () => {
    const m = labelsBlocked({ env: 'sandbox-test', consoleOrigin: CONSOLE }, { seq: 1, at: Date.UTC(2026, 10, 23, 9, 0), kind: 'labels.blocked', orgId: 'org_x', scopeId: 'sx', appId: null, actorKind: 'hana', actorId: 'staff', detail: { changeId: 'lc_9', wasLive: false, note: 'Misleading' } } as never, { apps: ['Stamps', 'Club'], delayMs: 86_400_000 });
    expect(m.subject).toBe('[Journear Passport sandbox-test] Journear blocked a change to request labels for Stamps');
    expect(m.text).toContain('Journear blocked a change to the request labels of Stamps and Club (lc_9): the words the approval window shows your users for your app’s requests. Your users will never see it.');
    expect(m.text).toContain('the new change waits 1 day again.');
  });
});

// ---- the routes ----

const staffReq = () => ({ actor: { kind: 'hana' as const, id: STAFF_SUB, email: STAFF_EMAIL }, requestId: `req_${uid()}`, clientIp: '198.51.100.9' });
const ctx = (over: Partial<typeof env>, params: Record<string, string> = {}, body: Record<string, unknown> = {}, s = staffReq()): RouteCtx => ({
  request: new Request('https://admin.test/api/labels', { method: 'POST' }),
  env: envWith(over),
  staff: s,
  url: new URL('https://admin.test/api/labels'),
  params,
  body,
});
const audit = (requestId: string) =>
  env.CONSOLE_TEST_DB.prepare("SELECT action, org_id, actor_kind, actor_email, target, details_json FROM audit_log WHERE request_id = ? AND action LIKE 'labels.%' ORDER BY seq").bind(requestId).all<Record<string, unknown>>().then((r) => r.results);
const pageToken = () => `lblact_${uid().replace(/[^A-Za-z0-9]/gu, 'x').padEnd(22, 'x').slice(0, 22)}`;
const NOW = Date.UTC(2026, 10, 23, 9, 0);
const CONTROLS: LabelControls = { all: { labelsOff: false, reviewRequired: false, version: 0, updatedAt: null, updatedBy: null, note: null }, orgs: [], entries: [] };
const change = (over: Record<string, unknown> = {}) => ({ id: 'lc_route1', labelId: 'pl_route1', orgId: 'org_route1', scopeId: 'sroute1', environment: 'test', apps: [{ id: 'app_r', name: 'Stamps' }], schema: 'journear-labels/1', sha256: 'ab'.repeat(32), bytes: 900, state: 'announced', proposedAt: NOW - 3_600_000, notifiedAt: NOW - 3_500_000, activeFrom: NOW + 3_600_000, lapsesAt: null, reviewRequired: false, allowedAt: null, blockedAt: null, endedAt: null, endReason: null, previousId: null, off: null, served: false, ...over });
const ITEM = { change: change(), labelsVersion: 4, preview: null, diff: [] } as unknown as LabelFeedItem;
const withLabels = (over: Record<string, (...a: unknown[]) => unknown> = {}) => overrideBinding(env.API, { labelControls: async () => ({ ok: true, controls: CONTROLS }), ...over });

describe('GET /api/labels and /api/labels/:changeId', () => {
  it('need a staff Access JWT; the tools need the CSRF headers too', async () => {
    expect((await adminRequest('/api/labels', { jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/labels/lc_abc', { jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/labels/lc_abc/act', { body: { tool: 'block' }, csrf: false })).status).toBe(403);
    expect((await adminRequest('/api/labels/controls', { body: { what: 'off' }, csrf: false })).status).toBe(403);
    expect((await adminRequest('/api/labels/lc_abc/act', { method: 'GET' })).status).toBe(405);
  });

  it('the feed with the switches, the orgs’ names and a one-time token; read through the real API', async () => {
    const c = await seedLabelChange();
    await seedConsoleOrg(c.app.org, `Lumen ${uid()}`);
    const res = await adminRequest('/api/labels');
    expect(res.status).toBe(200);
    const d = await json<{ items: LabelFeedItem[]; controls: LabelControls; orgNames: Record<string, string>; token: string }>(res);
    expect(d.token).toMatch(/^lblact_[A-Za-z0-9_-]{22}$/u);
    const mine = d.items.find((i) => i.change.id === c.id)!;
    expect(mine.change).toMatchObject({ state: 'proposed', orgId: c.app.org, apps: [{ id: c.app.id, name: `Test ${c.app.id}` }] });
    expect(mine.preview!.formats[0]!.line).toBe(`Test ${c.app.id} says: collect the stamp “Arrival”`);
    expect(d.orgNames[c.app.org]).toMatch(/^Lumen /u);
    expect(d.controls.all).toMatchObject({ labelsOff: false, reviewRequired: false });
    const one = await adminRequest(`/api/labels/${c.id}`);
    expect(one.status).toBe(200);
    expect(await json(one)).toMatchObject({ item: { change: { id: c.id } }, orgName: expect.stringMatching(/^Lumen /u), token: expect.stringMatching(/^lblact_/u) });
    // A fresh token each read.
    expect((await json<{ token: string }>(await adminRequest('/api/labels'))).token).not.toBe(d.token);
  });

  it('a malformed change id is not found without a call; an older API is said; the console down leaves the names out', async () => {
    const calls: unknown[] = [];
    const api = overrideBinding(env.API, { labelDetail: async (x: unknown) => (calls.push(x), { ok: true, item: ITEM }) });
    for (const id of ['gc_1', 'lc_', 'lc_a-b', 'x']) expect((await labelRoute(ctx({ API: api }, { changeId: id }))).status, id).toBe(404);
    expect(calls).toEqual([]);
    const old = await labelsRoute(ctx({ API: {} as typeof env.API }));
    expect(old.status).toBe(503);
    expect(((await old.json()) as { error: { code: string } }).error.code).toBe('api_outdated');
    const noNames = await labelRoute(ctx({ API: api, CONSOLE: downBinding() }, { changeId: 'lc_route1' }));
    expect(await noNames.json()).toMatchObject({ orgName: null, item: { change: { id: 'lc_route1' } } });
  });
});

describe('POST /api/labels/:changeId/act', () => {
  const body = (over: Record<string, unknown> = {}) => ({ token: pageToken(), tool: 'block', note: 'The words hide that it moves money', seen: { labelsVersion: 4, state: 'announced' }, ...over });
  const done = { ok: true, change: change({ state: 'blocked', blockedAt: NOW }) };

  it('records the action first (keyed by the page’s token), then acts, then records the answer; the words say what it did', async () => {
    const calls: Record<string, unknown>[] = [];
    const api = withLabels({ labelStaffAct: async (x: unknown) => (calls.push(x as Record<string, unknown>), done) });
    const s = staffReq();
    const b = body();
    const res = await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b, s));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ change: { id: 'lc_route1', state: 'blocked' }, words: { tone: 'ok', title: 'Blocked', text: 'Users will never see this change. The partner’s security contacts are emailed within about 5 minutes, with your note.' } });
    expect(calls).toEqual([{ ...s, requestId: b.token, changeId: 'lc_route1', tool: 'block', note: b.note, seen: b.seen }]);
    expect(await audit(b.token)).toEqual([
      { action: 'labels.staff_action', org_id: null, actor_kind: 'hana', actor_email: STAFF_EMAIL, target: 'lc_route1', details_json: JSON.stringify({ tool: 'block', target: 'lc_route1', note: b.note }) },
      { action: 'labels.staff_result', org_id: null, actor_kind: 'hana', actor_email: STAFF_EMAIL, target: 'lc_route1', details_json: JSON.stringify({ tool: 'block', target: 'lc_route1', result: 'done' }) },
    ]);
  });

  it('checks the input before anything: no audit row and no call for a bad token, tool, note, seen or an extra field', async () => {
    const calls: unknown[] = [];
    const api = withLabels({ labelStaffAct: async (x: unknown) => (calls.push(x), done) });
    const bad: Record<string, unknown>[] = [
      body({ token: undefined }),
      body({ token: 'evmact_xxxxxxxxxxxxxxxxxxxxxx' }),
      body({ token: 'lblact_short' }),
      body({ tool: 'approve' }),
      body({ note: 'too short' }),
      body({ note: `${'x'.repeat(20)}\n${'y'.repeat(20)}` }),
      body({ note: 'x'.repeat(301) }),
      body({ seen: undefined }),
      body({ seen: { labelsVersion: -1, state: 'announced' } }),
      body({ seen: { labelsVersion: 4, state: 'announced', extra: 1 } }),
      body({ actor: { kind: 'system', id: 'admin-cron' } }),
      body({ changeId: 'lc_other' }),
    ];
    for (const b of bad) {
      expect((await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b))).status, JSON.stringify(b)).toBe(400);
      if (typeof b.token === 'string') expect(await audit(b.token)).toEqual([]);
    }
    expect((await labelActRoute(ctx({ API: api }, { changeId: 'gc_1' }, body()))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('no audit row, no action: the console down or refusing stops it before the API; an older console is said', async () => {
    const calls: unknown[] = [];
    const api = withLabels({ labelStaffAct: async (x: unknown) => (calls.push(x), done) });
    expect((await labelActRoute(ctx({ API: api, CONSOLE: downBinding() }, { changeId: 'lc_route1' }, body()))).status).toBe(503);
    expect((await labelActRoute(ctx({ API: api, CONSOLE: overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'internal' }) }) }, { changeId: 'lc_route1' }, body()))).status).toBe(500);
    const oldConsole = await labelActRoute(ctx({ API: api, CONSOLE: overrideBinding(env.CONSOLE, { recordStaffAction: async () => ({ ok: false, code: 'bad_request', error: 'action: Invalid enum value' }) }) }, { changeId: 'lc_route1' }, body()));
    expect(((await oldConsole.json()) as { error: { code: string } }).error.code).toBe('console_outdated');
    expect(calls).toEqual([]);
  });

  it('an older API (no partner labels): the plain message, nothing recorded, nothing done', async () => {
    const calls: unknown[] = [];
    const old = { labelStaffAct: async (x: unknown) => (calls.push(x), done) } as unknown as typeof env.API;
    const b = body();
    const res = await labelActRoute(ctx({ API: old }, { changeId: 'lc_route1' }, b));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'api_outdated', message: 'This page is newer than the API: deploy the API first (then this admin console). Nothing was done.' } });
    expect(await audit(b.token)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a re-sent form (the same page token) is already_applied and does nothing a second time', async () => {
    const calls: unknown[] = [];
    const api = withLabels({ labelStaffAct: async (x: unknown) => (calls.push(x), done) });
    const b = body();
    expect((await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b))).status).toBe(200);
    const again = await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: unknown }).error).toEqual({ code: 'already_applied', message: ALREADY_SENT });
    expect(calls).toHaveLength(1);
  });

  it('a change that moved is 409 in plain words; a refusal is passed on; an unclear answer is said, recorded and never retried', async () => {
    let answer: () => Promise<unknown> = async () => ({ ok: false, code: 'version_conflict', error: 'This change moved since the page was read: read it again' });
    let n = 0;
    const api = withLabels({ labelStaffAct: async () => (n++, answer()) });
    let b = body();
    const stale = await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: unknown }).error).toEqual({ code: 'version_conflict', message: CHANGE_MOVED });
    expect(CHANGE_MOVED).toBe('This change moved since you opened the page (someone may have acted, or it went live). Nothing was done. Reload the page and look again.');
    expect((await audit(b.token)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'stale_page']);
    answer = async () => ({ ok: false, code: 'conflict', error: 'Review isn’t switched on for this organisation: the change takes effect at its time without an Allow' });
    b = body({ tool: 'allow' });
    const refused = await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'conflict', message: expect.stringMatching(/^Review isn’t switched on/u) });
    expect((await audit(b.token)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'rpc_conflict']);
    answer = () => Promise.reject(new Error('Network connection lost.'));
    b = body();
    const unclear = await labelActRoute(ctx({ API: api }, { changeId: 'lc_route1' }, b));
    expect(unclear.status).toBe(503);
    expect(((await unclear.json()) as { error: { message: string } }).error.message).toBe(NO_CLEAR_ANSWER);
    expect((await audit(b.token)).map((r) => JSON.parse(String(r.details_json)).result ?? 'before')).toEqual(['before', 'unknown']);
    expect(n).toBe(3);
  });

  it('through the real API: Block from the page’s own read stops the change; the same page again is a change that moved', async () => {
    const c = await seedLabelChange();
    const page = await json<{ item: LabelFeedItem; token: string }>(await adminRequest(`/api/labels/${c.id}`));
    const seen = { labelsVersion: page.item.labelsVersion, state: page.item.change.state };
    const res = await adminRequest(`/api/labels/${c.id}/act`, { body: { token: page.token, tool: 'block', note: 'The words would mislead users', seen } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json(res)).toMatchObject({ change: { id: c.id, state: 'blocked' }, words: { title: 'Blocked' } });
    expect(await labelChangeRow(c.id)).toMatchObject({ status: 'blocked', block_note: 'The words would mislead users', was_live: 0 });
    expect((await audit(page.token)).map((r) => r.action)).toEqual(['labels.staff_action', 'labels.staff_result']);
    const again = await adminRequest(`/api/labels/${c.id}/act`, { body: { token: pageToken(), tool: 'block', note: 'The words would mislead users', seen } });
    expect(again.status).toBe(409);
    expect((await json<{ error: { message: string } }>(again)).error.message).toBe(CHANGE_MOVED);
  });
});

describe('POST /api/labels/controls', () => {
  const body = (over: Record<string, unknown> = {}) => ({ token: pageToken(), target: { kind: 'all' }, what: 'off', note: 'A partner’s words mislead users', seenVersion: 0, ...over });

  it('records the switch first with its target (all, an org’s id, an entry’s id), then switches, then records the answer', async () => {
    const calls: Record<string, unknown>[] = [];
    const api = withLabels({ labelControl: async (x: unknown) => (calls.push(x as Record<string, unknown>), { ok: true, version: 1, changed: true }) });
    for (const [target, want] of [
      [{ kind: 'all' }, 'all'],
      [{ kind: 'org', orgId: 'org_route1' }, 'org_route1'],
      [{ kind: 'entry', labelId: 'pl_route1' }, 'pl_route1'],
    ] as const) {
      const b = body({ target, what: target.kind === 'entry' ? 'off' : 'review_on' });
      const res = await labelControlRoute(ctx({ API: api }, {}, b));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { words: { title: string } }).words.title).toBe(target.kind === 'entry' ? 'Switched off' : 'Staff review is on');
      expect((await audit(b.token)).map((r) => [r.action, r.target, JSON.parse(String(r.details_json))])).toEqual([
        ['labels.staff_action', want, { tool: b.what, target: want, note: b.note }],
        ['labels.staff_result', want, { tool: b.what, target: want, result: 'done' }],
      ]);
    }
    expect(calls).toHaveLength(3);
  });

  it('refuses what the API’s schema refuses (review for one entry, a bad org id, no note) before anything is recorded', async () => {
    const calls: unknown[] = [];
    const api = withLabels({ labelControl: async (x: unknown) => (calls.push(x), { ok: true, version: 1, changed: true }) });
    for (const b of [body({ target: { kind: 'entry', labelId: 'pl_route1' }, what: 'review_on' }), body({ target: { kind: 'org', orgId: 'nope' } }), body({ what: 'delete' }), body({ note: '' }), body({ seenVersion: '0' }), body({ token: 'lblact_' })]) {
      expect((await labelControlRoute(ctx({ API: api }, {}, b))).status, JSON.stringify(b)).toBe(400);
      expect(await audit(b.token as string)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('a switch that moved is 409 in plain words; one already as asked says nothing changed', async () => {
    let answer: unknown = { ok: false, code: 'version_conflict', error: 'This switch moved since the page was read: read it again' };
    const api = withLabels({ labelControl: async () => answer });
    const stale = await labelControlRoute(ctx({ API: api }, {}, body()));
    expect(((await stale.json()) as { error: unknown }).error).toEqual({ code: 'version_conflict', message: SWITCH_MOVED });
    answer = { ok: true, version: 3, changed: false };
    const same = await labelControlRoute(ctx({ API: api }, {}, body()));
    expect(await same.json()).toEqual({ version: 3, changed: false, words: { tone: 'ok', title: 'Nothing to change', text: 'It was already like that, so nothing changed.' } });
  });

  it('through the real API: every partner label off, then back on, each a version on from the page’s', async () => {
    const page = await json<{ controls: LabelControls; token: string }>(await adminRequest('/api/labels'));
    const v = page.controls.all.version;
    const off = await adminRequest('/api/labels/controls', { body: { token: page.token, target: { kind: 'all' }, what: 'off', note: 'Testing the switch in sandbox', seenVersion: v } });
    expect(off.status, await off.clone().text()).toBe(200);
    expect(await json(off)).toMatchObject({ version: v + 1, changed: true });
    const after = await json<{ controls: LabelControls; token: string }>(await adminRequest('/api/labels'));
    expect(after.controls.all).toMatchObject({ labelsOff: true, version: v + 1, updatedBy: STAFF_EMAIL });
    const on = await adminRequest('/api/labels/controls', { body: { token: after.token, target: { kind: 'all' }, what: 'on', note: 'Testing the switch in sandbox', seenVersion: v + 1 } });
    expect(await json(on)).toMatchObject({ version: v + 2, changed: true, words: { title: 'Back on' } });
  });
});

// ---- the System status tile ----

describe('the System status tile', () => {
  const tileOf = async (answer: () => unknown): Promise<{ a: StatusAnswer; t: StatusAnswer['groups'][number]['tiles'][number] }> => {
    resetStatusCache();
    const e = envWith({ API: overrideBinding(env.API, { labelControls: answer as (...a: unknown[]) => unknown }) });
    const a = await buildStatus(e, staffReq(), 'jwt', NOW);
    const t = a.groups.flatMap((g) => g.tiles).find((x) => x.id === 'partner-labels')!;
    return { a, t };
  };
  const issues = (a: StatusAnswer) => a.issues.filter((i) => i.component === 'partner-labels');
  const at = NOW - 50 * 60_000;

  it('OK: no switch is off; review, when on, is a line', async () => {
    let r = await tileOf(async () => ({ ok: true, controls: CONTROLS }));
    expect([r.t.state, r.t.detail, r.t.link]).toEqual(['ok', 'No switch is off', { path: '/labels', label: 'Partner labels' }]);
    expect(r.a.groups.find((g) => g.tiles.includes(r.t))!.title).toBe('Partners');
    r = await tileOf(async () => ({ ok: true, controls: { ...CONTROLS, all: { ...CONTROLS.all, reviewRequired: true, version: 1 } } }));
    expect([r.t.state, r.t.detail]).toEqual(['ok', 'No switch is off · Staff review required for every change']);
    r = await tileOf(async () => ({ ok: true, controls: { ...CONTROLS, orgs: [{ orgId: 'org_a', labelsOff: false, reviewRequired: true, version: 1, updatedAt: at, updatedBy: STAFF_EMAIL, note: null }, { orgId: 'org_b', labelsOff: false, reviewRequired: true, version: 1, updatedAt: at, updatedBy: STAFF_EMAIL, note: null }] } }));
    expect([r.t.state, r.t.detail, issues(r.a)]).toEqual(['ok', 'No switch is off · Staff review required for 2 organisations', []]);
  });

  it('Warning: switched off for everyone, for organisations, or sets; who and when; the issue says what it does and where to go', async () => {
    let r = await tileOf(async () => ({ ok: true, controls: { ...CONTROLS, all: { labelsOff: true, reviewRequired: false, version: 2, updatedAt: at, updatedBy: STAFF_EMAIL, note: 'x' } } }));
    expect([r.t.state, r.t.detail]).toEqual(['warning', 'Switched off for everyone']);
    expect(r.t.lines).toEqual([{ label: 'Every partner label', state: 'warning', stateLabel: 'Off', detail: `Switched off by ${STAFF_EMAIL}, 2026-11-23 08:10 UTC (50 min ago)` }]);
    expect(issues(r.a)).toEqual([
      expect.objectContaining({ severity: 'warning', title: 'Partner labels are switched off for everyone', action: 'Users of every partner’s apps see the plain approval window, without the partner’s words. To turn a switch back on, open Partner labels.', since: at, sinceSource: 'source', link: { path: '/labels', label: 'Partner labels' } }),
    ]);
    r = await tileOf(async () => ({
      ok: true,
      controls: {
        ...CONTROLS,
        orgs: [{ orgId: 'org_a', labelsOff: true, reviewRequired: false, version: 1, updatedAt: at, updatedBy: STAFF_EMAIL, note: null }],
        entries: [
          { labelId: 'pl_a', orgId: 'org_b', scopeId: 'sb', offAt: at - 60_000, offBy: STAFF_EMAIL, note: null, version: 1 },
          { labelId: 'pl_b', orgId: 'org_b', scopeId: 'sb', offAt: at, offBy: null, note: null, version: 1 },
        ],
      },
    }));
    expect([r.t.state, r.t.detail]).toEqual(['warning', 'Switched off for 1 organisation · 2 sets switched off']);
    expect(issues(r.a).map((i) => [i.title, i.action, i.since])).toEqual([['Partner labels are switched off for 1 organisation; 2 sets of partner labels are switched off', 'Users of those apps see the plain approval window, without the partner’s words. To turn a switch back on, open Partner labels.', at - 60_000]]);
  });

  it('Unknown: the read failed, or the API is older (no such method)', async () => {
    let r = await tileOf(() => Promise.reject(new TypeError('labelControls is not a function')));
    expect([r.t.state, r.t.detail]).toEqual(['unknown', 'Can’t check: the API deployed here is older than this page.']);
    expect(issues(r.a).map((i) => [i.severity, i.title, i.action])).toEqual([['warning', 'The API deployed here is older than this page, so the partner label switches can’t be read', 'Deploy the API first, then this admin console.']]);
    r = await tileOf(async () => ({ ok: false, code: 'internal' }));
    expect([r.t.state, r.t.detail]).toEqual(['unknown', 'Can’t check right now: the API didn’t answer']);
  });
});

// ---- the words ----

describe('plain staff words (D853, D879)', () => {
  it('every staff sentence of the screen and the tile is free of protocol words and codes', () => {
    const sentences = [
      ALREADY_SENT,
      CHANGE_MOVED,
      SWITCH_MOVED,
      NO_CLEAR_ANSWER,
      ...(['block', 'allow'] as const).flatMap((tool) => [false, true].flatMap((live) => [actDoneWords(tool, { state: 'announced', activeFrom: NOW }, live), actDoneWords(tool, { state: 'in_force', activeFrom: NOW }, live)])).flatMap((w) => [w.title, w.text]),
      ...(['all', 'org', 'entry'] as const).flatMap((kind) =>
        (['off', 'on', 'review_on', 'review_off'] as const).flatMap((what) => [true, false].map((changed) => controlWords(kind === 'all' ? { kind } : kind === 'org' ? { kind, orgId: 'org_x' } : { kind, labelId: 'pl_x' }, what, changed))).flatMap((w) => [w.title, w.text]),
      ),
      'Partner labels are switched off for everyone',
      'Users of those apps see the plain approval window, without the partner’s words. To turn a switch back on, open Partner labels.',
      'The API deployed here is older than this page, so the partner label switches can’t be read',
      'The partner label switches can’t be read right now',
    ];
    for (const s of sentences) {
      expect(s, s).not.toMatch(STAFF_JARGON);
      expect(s.length, s).toBeLessThan(260);
    }
  });
});

describe('staff Block a label change, never cancel it (D894 after review)', () => {
  it('the old guarded-change cancel route refuses an lc_ id, in plain words, and the API refuses it too; nothing changes', async () => {
    const c = await seedLabelChange({});
    const res = await adminRequest(`/api/changes/${c.id}/cancel`, { body: { orgId: c.app.org } });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: { code: 'forbidden', message: 'Staff don’t cancel request label changes. Open it on Partner labels and use Block this change, with a note.' } });
    const api = await env.API.cancelChange({ ...staffReq(), orgId: c.app.org, changeId: c.id });
    expect(api).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await labelChangeRow(c.id))!.status).toBe('pending');
  });

  it('expedite and the guarded notice’s ack take a guarded change only, never a label version', async () => {
    const c = await seedLabelChange({});
    expect(await env.API.expediteChange({ ...staffReq(), changeId: c.id, reason: 'The security contact confirmed it by phone today' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect((await labelChangeRow(c.id))!.status).toBe('pending');
  });
});
