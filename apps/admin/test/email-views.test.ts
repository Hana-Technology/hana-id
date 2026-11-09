// The admin console's email login views (build plan batch 9, D446, D448) over the real issuer (DirectoryRpc, its own D1),
// the real API (AdminRpc.linkStats) and the suite's fake chain: staff only, what each page answers, nothing to show, a
// service that doesn't answer (said in place, not a dead page), the signer policy against the pins, and the link-rate
// alert (once per app and day, inside the cron's call budget).
import { env } from 'cloudflare:workers';
import { LINK_JUMP_MIN_LINKS } from '@hana-id/console-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_JUMP_ALERT_STATE, runLinkJumpAlert } from '../src/email-views.ts';
import worker from '../src/index.ts';
import { Budget } from '../src/mail.ts';
import { ADMIN, FakeEmail, adminRequest, downBinding, emailChain, envWith, json, newOpsData, memoryOps, seedHotApp, setNearDown, staffJwt, stubNetwork } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
  setNearDown(false);
  emailChain.clear();
  await env.ISSUER_TEST_DB.batch(['email_issuance', 'email_daily'].map((t) => env.ISSUER_TEST_DB.prepare(`DELETE FROM ${t}`)));
  await env.HOT_DB.prepare('DELETE FROM link_usage').run();
});
afterEach(() => vi.restoreAllMocks());

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const get = (path: string, e: typeof env = env) => withEnv(path, e);
const withEnv = async (path: string, e: typeof env) =>
  worker.fetch(new Request(`${ADMIN}${path}`, { method: 'GET', headers: { 'cf-access-jwt-assertion': await staffJwt(), 'cf-connecting-ip': '198.51.100.9' } }), e);

function chainPolicy() {
  emailChain.set('get_self_issued', { provider: 'email', signers: [{ id: 'hana', kids: ['kid-a', 'kid-b'] }], required: 1 });
  emailChain.set('get_issuer_keys', [{ kid: 'kid-a', n: 'x', e: 'AQAB' }, { kid: 'kid-b', n: 'y', e: 'AQAB' }]);
  emailChain.set('get_issuer', { iss_values: ['https://issuer.test/v1/email'] });
}
const pins = (over: Record<string, unknown> = {}) => JSON.stringify({ required: 1, signers: { hana: ['kid-a', 'kid-b'] }, ...over });

describe('GET /api/email/issuer (D446, D448)', () => {
  it('is staff only: no Access token is refused, a stranger’s token is refused', async () => {
    expect((await adminRequest('/api/email/issuer', { jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/email/issuer', { jwt: await staffJwt({ email: 'partner@elsewhere.example' }) })).status).toBe(403);
  });

  it('answers the issuer’s counters, the app names, the signer policy and the KMS note; empty is empty', async () => {
    const app = await seedHotApp();
    chainPolicy();
    const nowS = Math.floor(Date.now() / 1000);
    await env.ISSUER_TEST_DB.batch([
      env.ISSUER_TEST_DB.prepare("INSERT INTO email_issuance (jti, app_id, purpose, kid, iat) VALUES ('j1', ?1, 'session', 'k', ?2)").bind(app.id, nowS),
      env.ISSUER_TEST_DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind(today(), app.id, 'sent', 9),
      env.ISSUER_TEST_DB.prepare("INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, '', ?2, ?3)").bind(today(), 'refused:ip:start:10m', 4),
      env.ISSUER_TEST_DB.prepare("INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, '', ?2, ?3)").bind(today(), 'alert:send_budget_exhausted:global', 2),
    ]);
    const res = await get('/api/email/issuer?days=7', envWith({ EMAIL_PINNED_KEYS: pins(), EMAIL_SIGNER_KIND: 'worker-secret' }));
    expect(res.status).toBe(200);
    const body = await json<{ days: number; appNames: Record<string, string>; stats: { issuance: { appId: string | null; purpose: string; count: number }[]; metrics: { metric: string; appId: string | null }[] }; policy: Record<string, unknown>; kms: { signerKind: string } }>(res);
    expect(body.days).toBe(7);
    expect(body.appNames[app.id]).toMatch(/^Test /u);
    expect(body.stats.issuance).toEqual([{ day: today(), appId: app.id, purpose: 'session', count: 1 }]);
    expect(body.stats.metrics.map((m) => m.metric).sort()).toEqual(['alert:send_budget_exhausted:global', 'refused:ip:start:10m', 'sent']);
    expect(body.stats.metrics.find((m) => m.metric === 'refused:ip:start:10m')!.appId).toBeNull();
    expect(body.policy).toMatchObject({ required: 1, signers: ['hana'], matchesPins: true, pinsConfigured: true, iss: ['https://issuer.test/v1/email'] });
    expect(body.policy.keys).toEqual([{ kid: 'kid-a', signer: 'hana', onChain: true, pinned: true }, { kid: 'kid-b', signer: 'hana', onChain: true, pinned: true }]);
    expect(body.kms.signerKind).toBe('worker-secret');

    await env.ISSUER_TEST_DB.batch(['email_issuance', 'email_daily'].map((t) => env.ISSUER_TEST_DB.prepare(`DELETE FROM ${t}`)));
    const empty = await json<{ stats: { issuance: unknown[]; metrics: unknown[]; truncated: boolean }; appNames: object }>(await get('/api/email/issuer?days=1', envWith({ EMAIL_PINNED_KEYS: pins() })));
    expect(empty.stats).toMatchObject({ issuance: [], metrics: [], truncated: false });
    expect(empty.appNames).toEqual({});
  });

  it('flags pins that differ from the chain, an unpinned key, and no pins at all', async () => {
    chainPolicy();
    const differ = await json<{ policy: { matchesPins: boolean; keys: { kid: string; pinned: boolean; onChain: boolean }[] } }>(await get('/api/email/issuer', envWith({ EMAIL_PINNED_KEYS: pins({ signers: { hana: ['kid-a', 'kid-c'] } }) })));
    expect(differ.policy.matchesPins).toBe(false);
    expect(differ.policy.keys.find((k) => k.kid === 'kid-b')).toMatchObject({ onChain: true, pinned: false });
    expect(differ.policy.keys.find((k) => k.kid === 'kid-c')).toMatchObject({ onChain: false, pinned: true });
    const nopins = await json<{ policy: { pinsConfigured: boolean; matchesPins: boolean } }>(await get('/api/email/issuer', envWith({ EMAIL_PINNED_KEYS: undefined })));
    expect(nopins.policy).toMatchObject({ pinsConfigured: false, matchesPins: false });
    emailChain.set('get_self_issued', null);
    const none = await json<{ policy: { unavailable: string } }>(await get('/api/email/issuer', envWith({ EMAIL_PINNED_KEYS: pins() })));
    expect(none.policy.unavailable).toMatch(/No email issuer/u);
  });

  it('no issuer, a refused or unreachable issuer, and NEAR down are said in place: the page still answers 200', async () => {
    chainPolicy();
    const noIssuer = await json<{ stats: { unavailable: string } }>(await get('/api/email/issuer', envWith({ ISSUER: undefined })));
    expect(noIssuer.stats.unavailable).toMatch(/no email issuer/u);
    const down = await json<{ stats: { unavailable: string } }>(await get('/api/email/issuer', envWith({ ISSUER: downBinding() })));
    expect(down.stats.unavailable).toMatch(/didn’t answer/u);
    setNearDown(true);
    const nearDown = await json<{ policy: { unavailable: string } }>(await get('/api/email/issuer'));
    expect(nearDown.policy.unavailable).toMatch(/NEAR/u);
  });

  it('a staff token the issuer refuses (config drift) is said so, without failing the page', async () => {
    chainPolicy();
    const res = await get('/api/email/issuer', envWith({ ISSUER: { issuerStats: async () => ({ ok: false, code: 'not_staff' }) } as unknown as typeof env.ISSUER }));
    expect(res.status).toBe(200);
    expect((await json<{ stats: { unavailable: string } }>(res)).stats.unavailable).toMatch(/refused your Access session/u);
  });
});

describe('GET /api/email/links (D445, D448)', () => {
  async function linkRow(appId: string, day: string, n: Record<string, number>) {
    await env.HOT_DB.prepare('INSERT INTO link_usage (app_id, day, proposed, linked, activated, cancelled, unlinked, auto, explicit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(appId, day, n.proposed ?? 0, n.linked ?? 0, n.activated ?? 0, n.cancelled ?? 0, n.unlinked ?? 0, n.auto ?? 0, n.explicit ?? 0)
      .run();
  }

  it('is staff only and answers the app’s counts per day, marking a jump over the 7-day median', async () => {
    expect((await adminRequest('/api/email/links', { jwt: null })).status).toBe(401);
    const quiet = await seedHotApp();
    const busy = await seedHotApp();
    for (let d = 1; d <= 7; d++) await linkRow(busy.id, daysAgo(d), { proposed: 2 });
    await linkRow(busy.id, today(), { proposed: 40, linked: 5, auto: 44, explicit: 1 });
    await linkRow(quiet.id, today(), { proposed: 1, explicit: 1 });
    const res = await get('/api/email/links?days=31');
    expect(res.status).toBe(200);
    const body = await json<{ rows: { appId: string; appName: string; proposed: number }[]; jumps: { appId: string; today: number; median: number; jumped: boolean }[] }>(res);
    expect(body.rows.filter((r) => r.appId === busy.id)).toHaveLength(8);
    expect(body.rows.find((r) => r.appId === quiet.id)?.appName).toMatch(/^Test /u);
    expect(body.jumps.find((j) => j.appId === busy.id)).toMatchObject({ today: 45, median: 2, jumped: true });
    expect(body.jumps.find((j) => j.appId === quiet.id)).toMatchObject({ today: 1, jumped: false });
  });

  it('nothing yet is an empty page; the API down is said as 503', async () => {
    expect(await json(await get('/api/email/links'))).toMatchObject({ rows: [], jumps: [] });
    const res = await get('/api/email/links', envWith({ API: downBinding() }));
    expect(res.status).toBe(503);
  });
});

describe('the link-rate alert (15-minute cron, D448)', () => {
  const senderOf = () => new FakeEmail();

  async function jumpedApp() {
    const app = await seedHotApp();
    const now = Date.now();
    for (let d = 1; d <= 7; d++) await env.HOT_DB.prepare('INSERT INTO link_usage (app_id, day, proposed) VALUES (?1, ?2, 2)').bind(app.id, new Date(now - d * 86_400_000).toISOString().slice(0, 10)).run();
    await env.HOT_DB.prepare('INSERT INTO link_usage (app_id, day, proposed, auto) VALUES (?1, ?2, ?3, ?3)').bind(app.id, new Date(now).toISOString().slice(0, 10), LINK_JUMP_MIN_LINKS * 5).run();
    return app;
  }

  it('emails the alias once per app and day; a second run sends nothing', async () => {
    const app = await jumpedApp();
    const data = newOpsData();
    const ops = memoryOps(data);
    const email = senderOf();
    const first = await runLinkJumpAlert(env as never, ops, email, new Budget(), Date.now());
    expect(first).toEqual({ alerted: 1 });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe('security@hana.example');
    expect(email.sent[0]!.subject).toMatch(/Link rate jump/u);
    expect(`${email.sent[0]!.text}`).toContain(app.id);
    const again = await runLinkJumpAlert(env as never, ops, email, new Budget(), Date.now());
    expect(again).toEqual({ alerted: 0 });
    expect(email.sent).toHaveLength(1);
    expect(data.state.has(LINK_JUMP_ALERT_STATE)).toBe(true);
  });

  it('no jump sends nothing, and a run without two calls to spare doesn’t read or send', async () => {
    const data = newOpsData();
    const email = senderOf();
    expect(await runLinkJumpAlert(env as never, memoryOps(data), email, new Budget(), Date.now())).toEqual({ alerted: 0 });
    await jumpedApp();
    const spent = new Budget(1, 1);
    const calls: string[] = [];
    const api = new Proxy(env.API, { get: (t, p) => (p === 'linkStats' ? async () => (calls.push('x'), { ok: true, rows: [] }) : Reflect.get(t, p)) });
    expect(await runLinkJumpAlert({ ...env, API: api } as never, memoryOps(data), email, spent, Date.now())).toBeNull();
    expect(calls).toEqual([]);
    expect(email.sent).toHaveLength(0);
  });

  it('an email that wasn’t accepted isn’t recorded: the next run tries again', async () => {
    await jumpedApp();
    const data = newOpsData();
    const email = senderOf();
    email.failFor.add('security@hana.example');
    expect(await runLinkJumpAlert(env as never, memoryOps(data), email, new Budget(), Date.now())).toBeNull();
    expect(data.state.has(LINK_JUMP_ALERT_STATE)).toBe(false);
  });
});
