// The security feed (docs/batch-c-spec.md "Tests: Admin and email"): the first run only sets the cursors at each
// source's current position (D344); after it each `app_changes`, `audit_log` and `security_events` row is emailed once; a cursor advances only after its rows' sends were accepted and survives a
// restart (it lives in ops.state); the feed works with the console Worker down. Against the real API and console.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { everyFiveMinutes } from '../src/cron.ts';
import { FEED_CURSORS, FEED_INIT_PAGE, FEED_INIT_PAGES, feedAudit, feedChanges, feedSecurityEvents, initKey, runFeed } from '../src/feed.ts';
import { Budget, RUN_BUDGET } from '../src/mail.ts';
import { ALIAS, FakeEmail, adminRequest, downBinding, envWith, memoryOps, newOpsData, overrideBinding, seedConsoleOrg, seedHotApp, stubNetwork, uid, useFakeEmail, useMemoryOps } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const big = () => new Budget(1000);

/** Walks the whole feed until nothing more is sent (a test's rows sit behind the earlier tests' rows). */
async function drain(e: typeof env, data = newOpsData(), fake = new FakeEmail()): Promise<{ data: typeof data; fake: FakeEmail }> {
  for (let i = 0; i < 50; i++) {
    const before = fake.attempts.length;
    await runFeed(e, memoryOps(data), fake, big());
    if (fake.attempts.length === before) break;
  }
  return { data, fake };
}

describe('app_changes', () => {
  it('emails each row once to the org’s contacts; skips proposals and announcements; the cursor is in ops.state', async () => {
    // The first run only sets the cursor (D344); rows after it are emailed.
    const { data } = await drain(env);
    const app = await seedHotApp();
    await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1 } });
    await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: [`https://${uid()}.partner.example`], expectedVersion: 0 } });
    const { fake } = await drain(env, data);
    const mine = fake.to(app.contact);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(app.id);
    expect(mine[0]!.text).toContain("suspension.set");
    expect(mine[0]!.text).not.toContain('origin.proposed');
    const max = await env.HOT_DB.prepare('SELECT MAX(seq) AS m FROM app_changes').first<number>('m');
    expect(Number(data.state.get(FEED_CURSORS.changes)!.value)).toBe(max);
    // A restart (a new store over the same state) sends nothing again.
    const again = new FakeEmail();
    await feedChanges(env, memoryOps(data), again, big());
    expect(again.attempts).toEqual([]);
  });

  it('a failed send keeps the cursor before that org’s rows; the retry sends them', async () => {
    const { data } = await drain(env);
    const app = await seedHotApp();
    await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1 } });
    const cursor = data.state.get(FEED_CURSORS.changes)!.value;
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await feedChanges(env, memoryOps(data), fake, big());
    expect(data.state.get(FEED_CURSORS.changes)!.value).toBe(cursor);
    fake.failFor.clear();
    await feedChanges(env, memoryOps(data), fake, big());
    expect(fake.to(app.contact)).toHaveLength(1);
    expect(Number(data.state.get(FEED_CURSORS.changes)!.value)).toBeGreaterThan(Number(cursor));
  });

  it('an org without contacts goes to the alias; a contacts change goes to the old and the new contacts', async () => {
    const { data } = await drain(env);
    const app = await seedHotApp(undefined, { contacts: ['before@partner.example'] });
    await adminRequest(`/api/orgs/${app.org}/security-contacts`, { method: 'PUT', body: { emails: ['after@partner.example'] } });
    const fake = new FakeEmail();
    await feedChanges(env, memoryOps(data), fake, big());
    expect(fake.to('before@partner.example')).toHaveLength(1);
    expect(fake.to('after@partner.example')).toHaveLength(1);
    expect(fake.to('before@partner.example')[0]!.text).toContain('org.security_contacts');

    const lonely = await seedHotApp(undefined, { contacts: [] });
    await adminRequest(`/api/apps/${lonely.id}/suspend`, { body: { bit: 1 } });
    const f2 = new FakeEmail();
    await feedChanges(env, memoryOps(data), f2, big());
    expect(f2.about(lonely.id).map((m) => m.to)).toEqual([ALIAS]);
  });

  it('works with the console Worker down: app_changes still go out, the audit_log cursor waits', async () => {
    const { data } = await drain(env);
    const app = await seedHotApp();
    await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1 } });
    const auditCursor = data.state.get(FEED_CURSORS.audit)?.value;
    const fake = new FakeEmail();
    const r = await runFeed(envWith({ CONSOLE: downBinding() }), memoryOps(data), fake, big());
    expect(fake.to(app.contact)).toHaveLength(1);
    expect(r.audit_log).toBeNull();
    expect(data.state.get(FEED_CURSORS.audit)?.value).toBe(auditCursor);
  });
});

describe('the first run starts at the current position (D344)', () => {
  it('sends nothing and stores each source’s latest seq; a later row is sent once; a restart keeps the cursor', async () => {
    // History before the feed's first run, in both sources.
    const old = await seedHotApp();
    await seedConsoleOrg(old.org);
    await adminRequest(`/api/apps/${old.id}/suspend`, { body: { bit: 1 } });
    await adminRequest(`/api/orgs/${old.org}/freeze`, { body: { frozen: true } });
    const data = newOpsData();
    const fake = new FakeEmail();
    const r = await runFeed(env, memoryOps(data), fake, big());
    expect(r.app_changes).toMatchObject({ emailedGroups: 0, initialised: true });
    expect(r.audit_log).toMatchObject({ emailedGroups: 0, initialised: true });
    expect(fake.attempts.filter((m) => m.text.includes(old.id) || m.text.includes(old.org))).toEqual([]);
    const maxChange = await env.HOT_DB.prepare('SELECT MAX(seq) AS m FROM app_changes').first<number>('m');
    const maxAudit = await env.CONSOLE_TEST_DB.prepare('SELECT MAX(seq) AS m FROM audit_log').first<number>('m');
    expect(Number(data.state.get(FEED_CURSORS.changes)!.value)).toBe(maxChange);
    expect(Number(data.state.get(FEED_CURSORS.audit)!.value)).toBe(maxAudit);

    // A new row after the first run: sent once, to its org's contacts.
    const app = await seedHotApp();
    await adminRequest(`/api/apps/${app.id}/suspend`, { body: { bit: 1 } });
    const f1 = new FakeEmail();
    await feedChanges(env, memoryOps(data), f1, big());
    expect(f1.to(app.contact)).toHaveLength(1);
    expect(f1.about(old.id)).toEqual([]);
    // A restart (a new store over the same state) keeps the cursor: nothing again.
    const f2 = new FakeEmail();
    await feedChanges(env, memoryOps(data), f2, big());
    expect(f2.attempts).toEqual([]);
    expect(Number(data.state.get(FEED_CURSORS.changes)!.value)).toBeGreaterThan(maxChange!);
  });

  it('an empty source starts at 0 and then sends its first row', async () => {
    const data = newOpsData();
    const empty = { ...env, API: overrideBinding(env.API, { changesSince: async () => ({ ok: true, changes: [] }) }) } as typeof env;
    const r = await feedChanges(empty, memoryOps(data), new FakeEmail(), big());
    expect(r).toMatchObject({ read: 0, initialised: true, cursor: 0 });
    expect(data.state.get(FEED_CURSORS.changes)!.value).toBe('0');
  });

  it('a history longer than one run’s silent walk continues next run, still silent, before the cursor is set', async () => {
    const data = newOpsData();
    const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ seq: from + i + 1, at: 1, kind: 'suspension.set', orgId: 'org_x', appId: 'app_x', detail: {}, actorKind: 'hana', actorId: 'x', requestId: `r${from + i}` }));
    const total = FEED_INIT_PAGE * FEED_INIT_PAGES + 7;
    const long = { ...env, API: overrideBinding(env.API, { changesSince: async (c: unknown) => { const { seq, limit } = c as { seq: number; limit: number }; return { ok: true, changes: rows(seq, Math.max(0, Math.min(limit, total - seq))) }; } }) } as typeof env;
    const fake = new FakeEmail();
    const first = await feedChanges(long, memoryOps(data), fake, big());
    expect(first).toMatchObject({ initialised: false, cursor: FEED_INIT_PAGE * FEED_INIT_PAGES });
    expect(data.state.has(FEED_CURSORS.changes)).toBe(false);
    expect(data.state.get(initKey(FEED_CURSORS.changes))!.value).toBe(String(FEED_INIT_PAGE * FEED_INIT_PAGES));
    const second = await feedChanges(long, memoryOps(data), fake, big());
    expect(second).toMatchObject({ initialised: true, cursor: total });
    expect(data.state.get(FEED_CURSORS.changes)!.value).toBe(String(total));
    expect(fake.attempts).toEqual([]);
  });
});

describe('audit_log', () => {
  it('emails each console row once (the notices’ own rows are skipped) and persists its cursor', async () => {
    const { data } = await drain(env);
    const app = await seedHotApp();
    await seedConsoleOrg(app.org);
    await adminRequest(`/api/orgs/${app.org}/freeze`, { body: { frozen: true } });
    const fake = new FakeEmail();
    await feedAudit(env, memoryOps(data), fake, big());
    const mine = fake.to(app.contact);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain('org.frozen');
    const max = await env.CONSOLE_TEST_DB.prepare('SELECT MAX(seq) AS m FROM audit_log').first<number>('m');
    expect(Number(data.state.get(FEED_CURSORS.audit)!.value)).toBe(max);
    const again = new FakeEmail();
    await feedAudit(env, memoryOps(data), again, big());
    expect(again.attempts).toEqual([]);
  });
});

describe('security_events', () => {
  it('emails the alias and the org’s contacts once, then marks each event notified', async () => {
    await drain(env);
    const app = await seedHotApp();
    const id = `se_${uid()}`;
    await env.HOT_DB.prepare("INSERT INTO security_events (id, detected_at, kind, org_id, app_id, scope_id, detail_json) VALUES (?1, ?2, 'drift', ?3, ?4, ?5, '{\"what\":\"origin\"}')").bind(id, Date.now(), app.org, app.id, app.scope).run();
    const fake = new FakeEmail();
    fake.failFor.add(ALIAS);
    await feedSecurityEvents(env, fake, big());
    expect(await env.HOT_DB.prepare('SELECT notified_at FROM security_events WHERE id = ?1').bind(id).first('notified_at')).toBeNull();
    fake.failFor.clear();
    await feedSecurityEvents(env, fake, big());
    const mine = fake.sent.filter((m) => m.text.includes(id));
    expect([...new Set(mine.map((m) => m.to))].sort()).toEqual([ALIAS, app.contact].sort());
    // The contact's copy went out on both runs with one idempotency key: the provider delivers it once.
    expect(new Set(mine.filter((m) => m.to === app.contact).map((m) => m.idempotencyKey)).size).toBe(1);
    expect(await env.HOT_DB.prepare('SELECT notified_at FROM security_events WHERE id = ?1').bind(id).first('notified_at')).not.toBeNull();
    const again = new FakeEmail();
    await feedSecurityEvents(env, again, big());
    expect(again.about(id)).toEqual([]);
  });
});

describe('the 5-minute cron', () => {
  it('runs the notices, the feed and the watcher with the Worker’s own sender and store; records its last run', async () => {
    const fake = useFakeEmail();
    const data = useMemoryOps();
    const app = await seedHotApp();
    await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: [`https://${uid()}.partner.example`], expectedVersion: 0 } });
    const s = await everyFiveMinutes(env);
    expect(s.feed).toBe(true);
    expect(s.watcher).toBe(true);
    expect(fake.to(app.contact).some((m) => m.subject.includes('Pending change'))).toBe(true);
    expect(JSON.parse(data.state.get('cron.last_run')!.value)).toMatchObject({ feed: true, watcher: true });
    // Every call over the real service bindings came out of the run's budget, recorded per job (D380): at least the
    // notices' two pages and the feed's reads.
    expect(s.calls.notices).toBeGreaterThanOrEqual(2);
    expect(s.calls.feed).toBeGreaterThanOrEqual(1);
    expect(Object.values(s.calls).reduce((a, b) => a + b, 0)).toBe(RUN_BUDGET - s.budgetLeft);
  });

  it('without USAGE_DB the notices still go out; the feed and the watcher are skipped', async () => {
    const fake = useFakeEmail();
    const app = await seedHotApp();
    await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: [`https://${uid()}.partner.example`], expectedVersion: 0 } });
    const s = await everyFiveMinutes(envWith({ USAGE_DB: undefined }));
    expect(s).toMatchObject({ feed: false, watcher: false });
    expect(fake.to(app.contact).some((m) => m.subject.includes('Pending change'))).toBe(true);
  });
});
