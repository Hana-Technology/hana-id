// D930 (docs/partner-platform-spec.md A6, finding L14; D929's found (g)): the web addresses one request of a platform key
// asked for go out as ONE email per recipient, each address with its own cancel link, then one ack each; the email
// states the real wait the ack gives (at least 24 h outside `local*` test envs: this suite's env is `sandbox-test`,
// whose delay is a minute) and its date, and never the waiver sentence. A member's or staff's proposal keeps its own
// email. Against the real API (AdminRpc.pendingNotices, ackNotice) and its migrations' triggers.
import { linkToken, newId, parsePlatformPublicKey } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeNotice } from '../src/env.ts';
import { Budget } from '../src/mail.ts';
import { NOTICE_PAGE, platformGroup, runChangeNotices } from '../src/notices.ts';
import { ALIAS, CONSOLE, FakeEmail, adminRequest, envWith, json, linkIn, overrideBinding, seedHotApp, sha256Hex, stubNetwork, tokenOf, uid } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const big = () => new Budget(1000);
const hot = () => env.HOT_DB;

/** A platform key row for the org (the label the email names); a bare write, as the API's own tests seed keys. */
async function platformKey(org: string, scope: string, label = 'Partner backend'): Promise<string> {
  const id = newId('platformKey');
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const p = await parsePlatformPublicKey(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  if (!p.ok) throw new Error(p.problem);
  await hot()
    .prepare(
      `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
       VALUES (?1, ?2, ?3, 'ES256', ?4, ?5, ?6, 'pending', 'member', 'usr_test', 'sub-test', 'owner@partner.example', ?7, 0, 86400000, ?8)`,
    )
    .bind(id, org, label, p.key.raw, p.key.thumbprint, JSON.stringify([scope]), Date.now(), `r_${id}`)
    .run();
  return id;
}

/** One platform request's web addresses as P4's proposal writes them: each wait first, then the change and its row. */
async function platformProposal(app: { id: string }, keyId: string, origins: string[], requestId = `pf_${uid()}`): Promise<string[]> {
  const now = Date.now();
  const ids: string[] = [];
  for (const origin of origins) {
    const id = newId('guardedChange');
    await hot().prepare('INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, app.id, origin, keyId, DAY, now).run();
    await hot()
      .prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', ?3, 'pending', 'platform', ?4, ?5, ?6)")
      .bind(id, app.id, origin, keyId, now, requestId)
      .run();
    await hot().prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)').bind(app.id, origin, id).run();
    ids.push(id);
  }
  return ids;
}

const changeRow = (id: string) => hot().prepare('SELECT notified_at, active_from, hex(cancel_token_hash) AS h FROM guarded_changes WHERE id = ?1').bind(id).first<{ notified_at: number | null; active_from: number | null; h: string | null }>();

describe('a platform request’s web addresses: one email', () => {
  it('one message per recipient listing every address with its own cancel link, the real 24 h and its date, no waiver; one ack each', async () => {
    const app = await seedHotApp();
    const key = await platformKey(app.org, app.scope, 'Sodax partner backend');
    const ids = await platformProposal(app, key, [`https://shop-${uid()}.partner.example`, 'https://xn--bcher-kva.example']);
    const fake = new FakeEmail();
    const before = Date.now();
    const r = await runChangeNotices(env, fake, big());
    expect(r.acked).toBeGreaterThanOrEqual(2);
    const mine = fake.sent.filter((m) => ids.every((id) => m.text.includes(`/cancel/${id}`)));
    // One message per recipient for the whole request, never one per address.
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, app.contact].sort());
    expect(fake.sent.filter((m) => ids.some((id) => m.text.includes(`/cancel/${id}`)))).toHaveLength(2);
    for (const m of mine) {
      expect(m.subject).toContain('New web addresses requested by your platform key for');
      expect(m.text).toContain('your platform key “Sodax partner backend”');
      expect(m.text).toContain(key);
      // The real wait and its date, not the env's one minute; no waiver, and nothing that brings it forward.
      expect(m.text).toContain('24 hours after this email');
      expect(m.text).not.toMatch(/waiver|at once|1 min/iu);
      expect(m.text).toContain('international letters');
      expect(m.text).toContain('https://bücher.example');
      // Each button names the plain form, never the decoded one (which could imitate another site).
      expect(m.text).toContain('Cancel https://xn--bcher-kva.example');
      expect(m.text).not.toContain('Cancel https://bücher.example');
      const hrefs = [...m.html.matchAll(/href="([^"]*)"/gu)].map((x) => x[1]!);
      expect(hrefs).toHaveLength(2);
      for (const h of hrefs) expect(h.startsWith(`${CONSOLE}/cancel/`)).toBe(true);
    }
    // Each address's link is its own (HMAC of its own id), and each ack stored its hash and the full day.
    for (const id of ids) {
      const token = tokenOf(linkIn(mine[0]!.text, `/cancel/${id}`));
      expect([...token]).toEqual([...(await linkToken('cancelLink', new Uint8Array(32).fill(1), id))]);
      const row = await changeRow(id);
      expect(row!.h).toBe((await sha256Hex(token)).toUpperCase());
      expect(row!.active_from! - row!.notified_at!).toBeGreaterThanOrEqual(DAY);
      expect(row!.notified_at!).toBeGreaterThanOrEqual(before);
    }
    // The stated date is the ack's time to within the run (the plain text may wrap between its words).
    const m = /working on\s+(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4}),\s+(\d{2}):(\d{2})\s+UTC/u.exec(mine[0]!.text);
    expect(m, mine[0]!.text).not.toBeNull();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const stated = Date.UTC(Number(m![3]), months.indexOf(m![2]!), Number(m![1]), Number(m![4]), Number(m![5]));
    const at = (await changeRow(ids[0]!))!.active_from!;
    expect(Math.abs(stated - at)).toBeLessThan(3 * 60_000);
  });

  it('two requests on one app: two emails; a member’s proposal keeps its own email with the env’s delay', async () => {
    const app = await seedHotApp();
    const key = await platformKey(app.org, app.scope);
    const [a] = await platformProposal(app, key, [`https://one-${uid()}.partner.example`]);
    const [b] = await platformProposal(app, key, [`https://two-${uid()}.partner.example`]);
    const fake = new FakeEmail();
    await runChangeNotices(env, fake, big());
    const toAlias = (id: string) => fake.sent.filter((m) => m.to === ALIAS && m.text.includes(`/cancel/${id}`));
    expect(toAlias(a!)).toHaveLength(1);
    expect(toAlias(b!)).toHaveLength(1);
    expect(toAlias(a!)[0]).not.toBe(toAlias(b!)[0]);
    expect(toAlias(a!)[0]!.subject).toContain('New web address requested by your platform key for');
    expect(toAlias(a!)[0]!.text).toContain('Cancel this web address');
  });

  it('a send refused for one recipient acks none of the request; the retry sends to that recipient only and acks every one', async () => {
    const app = await seedHotApp();
    const ids = await platformProposal(app, await platformKey(app.org, app.scope), [`https://a-${uid()}.partner.example`, `https://b-${uid()}.partner.example`]);
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await runChangeNotices(env, fake, big());
    for (const id of ids) expect((await changeRow(id))!.notified_at).toBeNull();
    fake.failFor.clear();
    await runChangeNotices(env, fake, big());
    for (const id of ids) expect((await changeRow(id))!.notified_at).not.toBeNull();
    expect(fake.attempts.filter((m) => m.to === ALIAS && m.text.includes(ids[0]!))).toHaveLength(1);
    expect(fake.attempts.filter((m) => m.to === app.contact && m.text.includes(ids[0]!))).toHaveLength(2);
  });

  it('without room for every recipient and every ack, the request waits whole', async () => {
    const app = await seedHotApp();
    const ids = await platformProposal(app, await platformKey(app.org, app.scope), [`https://a-${uid()}.partner.example`, `https://b-${uid()}.partner.example`, `https://c-${uid()}.partner.example`]);
    // Only this request on the page: the page read, then 2 emails and 3 acks are needed; 4 calls aren't enough.
    const only = (await env.API.pendingNotices({ actor: { kind: 'system', id: 'test' }, requestId: `rq_${uid()}`, clientIp: '127.0.0.1', limit: 100 })) as { ok: true; notices: ChangeNotice[] };
    const page = only.notices.filter((n) => ids.includes(n.change.id));
    const api = overrideBinding(env.API, { pendingNotices: async () => ({ ok: true, notices: page }) });
    const fake = new FakeEmail();
    const r = await runChangeNotices(envWith({ API: api }), fake, new Budget(5));
    expect(r.skipped).toBe(3);
    expect(fake.attempts).toEqual([]);
    for (const id of ids) expect((await changeRow(id))!.notified_at).toBeNull();
  });

  it('a request cut off by the end of a full page waits for the next run, so it goes out whole', async () => {
    const app = await seedHotApp();
    const key = await platformKey(app.org, app.scope);
    const firsts = await platformProposal(app, key, [`https://lead-${uid()}.partner.example`]);
    const tail = await platformProposal(app, key, [`https://tail-${uid()}.partner.example`]);
    const all = (await env.API.pendingNotices({ actor: { kind: 'system', id: 'test' }, requestId: `rq_${uid()}`, clientIp: '127.0.0.1', limit: 100 })) as { ok: true; notices: ChangeNotice[] };
    const lead = all.notices.find((n) => n.change.id === firsts[0])!;
    const cut = all.notices.find((n) => n.change.id === tail[0])!;
    // A full page whose last request may go on past it: the lead goes out, the tail waits.
    const page = [...Array.from({ length: NOTICE_PAGE - 2 }, () => lead), lead, cut].slice(-NOTICE_PAGE);
    const api = overrideBinding(env.API, { pendingNotices: async () => ({ ok: true, notices: page }) });
    const fake = new FakeEmail();
    await runChangeNotices(envWith({ API: api }), fake, big());
    expect((await changeRow(tail[0]!))!.notified_at).toBeNull();
    expect((await changeRow(firsts[0]!))!.notified_at).not.toBeNull();
  });
});

describe('platformGroup', () => {
  const n = (id: string, app: string, requestId?: string): ChangeNotice =>
    ({ change: { id }, contacts: [], app: { id: app }, ...(requestId ? { platform: { keyId: 'pkc_x', keyLabel: null, requestId, waitMs: DAY } } : {}) }) as unknown as ChangeNotice;
  it('takes the consecutive platform proposals of one request on one app', () => {
    const page = [n('1', 'A', 'r1'), n('2', 'A', 'r1'), n('3', 'B', 'r1'), n('4', 'A', 'r2'), n('5', 'A'), n('6', 'A', 'r2')];
    expect(platformGroup(page, 0).map((x) => x.change.id)).toEqual(['1', '2']);
    expect(platformGroup(page, 2).map((x) => x.change.id)).toEqual(['3']);
    expect(platformGroup(page, 3).map((x) => x.change.id)).toEqual(['4']);
  });
});

describe('the staff routes of the platform screens (D930)', () => {
  it('GET /api/platform-queue lists a waiting platform web address with its key; GET …/platform-calls pages an org’s calls', async () => {
    const app = await seedHotApp();
    const key = await platformKey(app.org, app.scope, 'Queue backend');
    const [id] = await platformProposal(app, key, [`https://queue-${uid()}.partner.example`]);
    const q = await adminRequest('/api/platform-queue');
    expect(q.status).toBe(200);
    const body = await json<{ origins: { changeId: string; keyLabel: string | null; orgId: string }[]; keys: { id: string }[] }>(q);
    expect(body.origins.find((o) => o.changeId === id)).toMatchObject({ keyLabel: 'Queue backend', orgId: app.org });
    await hot()
      .prepare("INSERT INTO platform_calls (at, org_id, key_id, method, route, app_id, status, code, request_id, ip_prefix) VALUES (?1, ?2, ?3, 'GET', '/v1/platform/apps/:appId', ?4, 200, NULL, ?5, '203.0.113.0/24')")
      .bind(Date.now(), app.org, key, app.id, `rq_${uid()}`)
      .run();
    const calls = await adminRequest(`/api/orgs/${app.org}/platform-calls?app=${app.id}`);
    expect(calls.status).toBe(200);
    expect(await json(calls)).toMatchObject({ calls: [{ keyId: key, appId: app.id, ipPrefix: '203.0.113.0/24' }] });
    // Without a staff sign-in: refused like every staff route.
    expect((await adminRequest('/api/platform-queue', { jwt: null })).status).toBe(401);
  });
});
