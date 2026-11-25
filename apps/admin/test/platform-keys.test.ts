// D918: platform keys in the admin Worker, against the real API and console. The notice step (`platform_key`): a new
// key's announcement to the alias, every security contact and every owner, naming who registered and who accepted it,
// with the 24 h wait line (or the four-eyes line), the Confirm link that only opens the console's page and the cancel
// link; a staff key an owner accepted in force at once, with the stop link instead; an owner's confirmation with its
// stop link; a stop with what it cancelled; the expiry warnings; each acked only after every send, the link tokens'
// hashes stored. Who a notice names comes from the org's current members only ("a former member" otherwise). The
// staff routes: register (held for acceptance), approve never by the registrant, stop, cancel, the switch with its
// review; the freeze route's mirror into the API and its hourly check.
import { linkToken, newId, parsePlatformPublicKey } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Budget } from '../src/mail.ts';
import { runPlatformKeyNotices } from '../src/notices.ts';
import { reconcileFreezes } from '../src/platform.ts';
import { systemCtx } from '../src/rpc.ts';
import { createExecutionContext } from 'cloudflare:test';
import { ADMIN, ALIAS, CONSOLE, CSRF, FakeEmail, adminRequest, envWith, json, linkIn, overrideBinding, seedConsoleMember, seedConsoleOrg, seedHotApp, sha256Hex, staffJwt, stubNetwork, tokenOf, uid } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const big = () => new Budget(1000);
const hot = () => env.HOT_DB;

async function newPublicKey(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

/** An org in the console with an owner, its test app in the API with a contact. */
async function orgWithApp() {
  const org = await seedConsoleOrg();
  const owner = await seedConsoleMember(org, 'owner');
  const other = await seedConsoleMember(org, 'owner');
  const viewer = await seedConsoleMember(org, 'viewer');
  const app = await seedHotApp(org);
  return { org, owner, other, viewer, app };
}

/** A member's registration as the API writes it (the step-up is the console's; here a bare write). */
async function memberKey(org: string, scope: string, by: { id: string; sub: string; email: string }, o: { fourEyes?: boolean } = {}) {
  const id = newId('platformKey');
  const p = await parsePlatformPublicKey(await newPublicKey());
  if (!p.ok) throw new Error(p.problem);
  await hot()
    .prepare(
      `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
       VALUES (?1, ?2, 'Production backend', 'ES256', ?3, ?4, ?5, 'pending', 'member', ?6, ?7, ?8, ?9, ?10, 86400000, ?11)`,
    )
    .bind(id, org, p.key.raw, p.key.thumbprint, JSON.stringify([scope]), by.id, by.sub, by.email, Date.now(), o.fourEyes ? 1 : 0, `r_${id}`)
    .run();
  return { id, thumbprint: p.key.thumbprint };
}

const keyRow = (id: string) =>
  hot()
    .prepare('SELECT status, notified_at, active_from, unconfirmed_active_from, hex(cancel_token_hash) AS cancel_h, hex(revoke_link_hash) AS revoke_h, revoke_link_until, confirm_notified_at, end_notified_at, expiry_notice_stage FROM platform_keys WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>();

/** A staff request to the admin Worker's own fetch with some bindings replaced (the route's order of calls). */
async function adminRequestWith(over: Partial<typeof env>, path: string, body: unknown): Promise<Response> {
  const worker = (await import('../src/index.ts')).default as unknown as { fetch: (r: Request, e: typeof env, c: ExecutionContext) => Promise<Response> };
  const headers = new Headers({ ...CSRF, 'cf-access-jwt-assertion': await staffJwt(), 'cf-connecting-ip': '198.51.100.9' });
  return worker.fetch(new Request(`${ADMIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), envWith(over), createExecutionContext());
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/gu)].map((x) => x[1]!);

describe('the platform key notices', () => {
  it('announces a member’s key to the alias, every contact and every owner (not viewers), naming the registrant; the wait line; Confirm only opens the page; acked with the cancel link’s hash', async () => {
    const { org, owner, other, viewer, app } = await orgWithApp();
    const k = await memberKey(org, app.scope, owner);
    const fake = new FakeEmail();
    const r = await runPlatformKeyNotices(env, fake, big());
    expect(r.acked).toBeGreaterThanOrEqual(1);
    const mine = fake.about(k.id);
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, app.contact, owner.email, other.email].sort());
    expect(mine.map((m) => m.to)).not.toContain(viewer.email);
    for (const m of mine) {
      expect(m.subject).toContain('New platform key registered for');
      expect(m.text).toContain(`${owner.email} registered a new platform key`);
      expect(m.text).toContain(k.thumbprint);
      expect(m.text).toMatch(/It starts working on .*, 24 hours from now, or sooner if an owner of your organisation confirms it\./u);
      expect(m.text).toContain('That link only opens the key’s page.');
      const links = hrefs(m.html);
      expect(links).toHaveLength(2);
      expect(links[0]).toBe(`${CONSOLE}/confirm-platform-key/${k.id}`);
      expect(links[1]!.startsWith(`${CONSOLE}/cancel-platform-key/${k.id}#t=`)).toBe(true);
      expect(m.html).not.toMatch(/<script/iu);
    }
    const token = tokenOf(linkIn(mine[0]!.text, `/cancel-platform-key/${k.id}`));
    expect([...token]).toEqual([...(await linkToken('platformKeyCancel', new Uint8Array(32).fill(1), k.id))]);
    const row = (await keyRow(k.id))!;
    expect(row.cancel_h).toBe((await sha256Hex(token)).toUpperCase());
    expect(row.unconfirmed_active_from).toBe((row.notified_at as number) + 86_400_000);
    // Once only.
    const again = new FakeEmail();
    await runPlatformKeyNotices(env, again, big());
    expect(again.about(k.id)).toEqual([]);
  });

  it('a real-money key says another owner must confirm it; a registrant who left the org is “a former member”, never looked up', async () => {
    const { org, app } = await orgWithApp();
    const gone = { id: newId('user'), sub: `sub-${uid()}`, email: `gone-${uid()}@partner.example` };
    const k = await memberKey(org, app.scope, gone, { fourEyes: true });
    const fake = new FakeEmail();
    await runPlatformKeyNotices(env, fake, big());
    const [m] = fake.about(k.id);
    expect(m!.text).toContain('a former member registered a new platform key');
    expect(m!.text).toContain('or sooner if another owner of your organisation confirms it. The owner who registered it can’t confirm it.');
    expect(m!.text).not.toContain(gone.email);
  });

  it('a staff key an owner accepted is in force once announced: the email says so and carries the stop link, stored for 7 days', async () => {
    const { org, owner, app } = await orgWithApp();
    const reg = await adminRequest(`/api/orgs/${org}/platform-keys`, { body: { scopeIds: [app.scope], label: 'Key sent by email', publicKey: await newPublicKey(), reason: 'Checked the thumbprint by phone with their CTO' } });
    if (reg.status !== 200) throw new Error(await reg.text());
    const key = (await json<{ key: { id: string; status: string; proposedByEmail: string } }>(reg)).key;
    expect(key).toMatchObject({ status: 'awaiting_acceptance', proposedByEmail: 'staff@hana.example' });
    // Nothing is announced while it awaits acceptance.
    const before = new FakeEmail();
    await runPlatformKeyNotices(env, before, big());
    expect(before.about(key.id)).toEqual([]);
    // The owner's acceptance (the console's step-up; here as the API writes it).
    await hot()
      .prepare("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'member', accepted_by = ?2, accepted_sub = ?3, accepted_at = ?4, confirmed_kind = 'acceptance', confirmed_by = ?2, confirmed_sub = ?3, confirmed_at = ?4 WHERE id = ?1")
      .bind(key.id, owner.id, owner.sub, Date.now())
      .run();
    const fake = new FakeEmail();
    await runPlatformKeyNotices(env, fake, big());
    const [m] = fake.about(key.id);
    expect(m!.text).toContain('Journear staff (staff@hana.example) registered a new platform key');
    expect(m!.text).toContain(`It works now: ${owner.email} accepted it, which counts as its confirmation.`);
    const links = hrefs(m!.html);
    expect(links).toHaveLength(1);
    expect(links[0]!.startsWith(`${CONSOLE}/revoke-platform-key/${key.id}#t=`)).toBe(true);
    const row = (await keyRow(key.id))!;
    expect(row.status).toBe('active');
    expect(row.revoke_h).toBe((await sha256Hex(tokenOf(links[0]!))).toUpperCase());
    expect(row.revoke_link_until).toBe((row.notified_at as number) + 7 * 86_400_000);
  });

  it('an owner’s confirmation: its notice names who confirmed, with the stop link; a stop: what it cancelled', async () => {
    const { org, owner, other, app } = await orgWithApp();
    const k = await memberKey(org, app.scope, owner);
    await runPlatformKeyNotices(env, new FakeEmail(), big());
    const now = Date.now();
    await hot()
      .prepare("UPDATE platform_keys SET confirmed_kind = 'confirm', confirmed_by = ?2, confirmed_sub = ?3, confirmed_email_key = ?4, confirmed_at = ?5, active_from = ?5, expires_at = ?6, status = 'active', activated_recorded_at = ?5 WHERE id = ?1")
      .bind(k.id, other.id, other.sub, other.email, now, now + 365 * 86_400_000)
      .run();
    const fake = new FakeEmail();
    await runPlatformKeyNotices(env, fake, big());
    const [m] = fake.about(k.id).filter((x) => x.subject.includes('confirmed'));
    expect(m!.text).toContain(`${other.email} confirmed the platform key "Production backend"`);
    expect(hrefs(m!.html)[0]!.startsWith(`${CONSOLE}/revoke-platform-key/${k.id}#t=`)).toBe(true);
    expect((await keyRow(k.id))!.confirm_notified_at).not.toBeNull();
    // A waiting web address the key proposed, then staff stop the key.
    const gc = newId('guardedChange');
    // Its wait first, as the platform's proposal writes it (API migration 0033, D929).
    await hot().prepare("INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, 'https://w.partner.example', ?3, 86400000, ?4)").bind(gc, app.id, k.id, now).run();
    await hot().prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', 'https://w.partner.example', 'pending', 'platform', ?3, ?4, ?5)").bind(gc, app.id, k.id, now, `pf_${gc}`).run();
    const stop = await adminRequest(`/api/orgs/${org}/platform-keys/${k.id}/revoke`, { body: { reason: 'The network asked us to' } });
    expect(stop.status).toBe(200);
    const end = new FakeEmail();
    await runPlatformKeyNotices(env, end, big());
    const [s] = end.about(k.id);
    expect(s!.subject).toContain('Platform key stopped');
    // The org's other waiting keys, each announced one with its own cancel link (finding 5).
    expect(s!.text).not.toContain('waiting to start working');
    expect(s!.text).toContain('was stopped by Journear staff');
    expect(s!.text).toContain('https://w.partner.example');
    expect((await keyRow(k.id))!.end_notified_at).not.toBeNull();
  });

  it('a notice whose owners can’t be read waits (no send, no ack); a failed send leaves it unannounced', async () => {
    const { org, app } = await orgWithApp();
    const k = await memberKey(org, app.scope, { id: newId('user'), sub: 's', email: 'x@partner.example' });
    const down = envWith({ CONSOLE: overrideBinding(env.CONSOLE, { listMembers: async () => ({ ok: false, code: 'internal' }) }) });
    const fake = new FakeEmail();
    await runPlatformKeyNotices(down, fake, big());
    expect(fake.about(k.id)).toEqual([]);
    expect((await keyRow(k.id))!.notified_at).toBeNull();
    const failing = new FakeEmail();
    failing.failFor.add(app.contact);
    await runPlatformKeyNotices(env, failing, big());
    expect((await keyRow(k.id))!.notified_at).toBeNull();
  });
});

describe('the staff routes', () => {
  it('the registering staffer can’t approve their own key; the switch on needs the review', async () => {
    const { org, app } = await orgWithApp();
    const reg = await adminRequest(`/api/orgs/${org}/platform-keys`, { body: { scopeIds: [app.scope], label: 'Staff key', publicKey: await newPublicKey(), reason: 'Checked the thumbprint by phone with their CTO' } });
    const key = (await json<{ key: { id: string } }>(reg)).key;
    const approve = await adminRequest(`/api/orgs/${org}/platform-keys/${key.id}/approve`, { body: { reason: 'Approving my own key, which must fail' } });
    expect(approve.status).toBe(403);
    // The same email under another Access identity is the same person.
    const twin = await adminRequest(`/api/orgs/${org}/platform-keys/${key.id}/approve`, { body: { reason: 'Same person, another identity' }, jwt: await staffJwt({ sub: '11111111-2222-4333-8444-555555555555' }) });
    expect(twin.status).toBe(403);
    expect((await adminRequest(`/api/orgs/${org}/platform-switch`, { body: { enabled: true, reason: 'Onboarded' } })).status).toBe(409);
    const on = await adminRequest(`/api/orgs/${org}/platform-switch`, { body: { enabled: true, reason: 'Onboarded', reviewedKeys: [key.id] } });
    expect(on.status).toBe(200);
    const view = await json<{ platform: { enabled: boolean }; keys: unknown[] }>(await adminRequest(`/api/orgs/${org}/platform`));
    expect(view.platform.enabled).toBe(true);
    expect((await adminRequest(`/api/orgs/${org}/platform-keys/${key.id}/cancel`, { body: {} })).status).toBe(200);
  });

  it('a freeze mirrors into the API (cancelling the org’s waiting keys); a failed mirror is said, and the hourly check repeats it', async () => {
    const { org, owner, app } = await orgWithApp();
    const k = await memberKey(org, app.scope, owner);
    const res = await adminRequest(`/api/orgs/${org}/freeze`, { body: { frozen: true } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ platformMirrored: true });
    expect((await keyRow(k.id))!.status).toBe('cancelled');
    expect(await hot().prepare('SELECT frozen FROM platform_orgs WHERE org_id = ?1').bind(org).first()).toEqual({ frozen: 1 });
    // Unfrozen in the console only (as if the mirror failed), the freeze past the check's grace: the check fixes it.
    await hot().prepare('UPDATE platform_orgs SET frozen_at = frozen_at - 3600000 WHERE org_id = ?1').bind(org).run();
    expect((await env.CONSOLE.freezeOrg({ actor: { kind: 'hana', id: 'staff-sub-1', email: 'staff@hana.example' }, requestId: `req_${uid()}`, clientIp: '198.51.100.9', orgId: org, frozen: false })).ok).toBe(true);
    const fixed = await reconcileFreezes(env);
    expect(fixed.fixed).toBeGreaterThanOrEqual(1);
    expect(await hot().prepare('SELECT frozen FROM platform_orgs WHERE org_id = ?1').bind(org).first()).toEqual({ frozen: 0 });
    expect(owner.email).toBeTruthy();
  });
});

describe('after PR 149’s review (admin)', () => {
  it('the stop notice carries a working cancel link for each announced waiting key of the org (finding 5)', async () => {
    const { org, owner, app } = await orgWithApp();
    const k = await memberKey(org, app.scope, owner);
    const w = await memberKey(org, app.scope, owner);
    await runPlatformKeyNotices(env, new FakeEmail(), big());
    expect(await adminRequest(`/api/orgs/${org}/platform-keys/${k.id}/revoke`, { body: { reason: 'Rotated' } })).toMatchObject({ status: 200 });
    const end = new FakeEmail();
    await runPlatformKeyNotices(env, end, big());
    const [s] = end.about(k.id).filter((m) => m.subject.includes('stopped'));
    expect(s!.text).toContain('waiting to start working');
    const url = linkIn(s!.text, `/cancel-platform-key/${w.id}`);
    expect([...tokenOf(url)]).toEqual([...(await linkToken('platformKeyCancel', new Uint8Array(32).fill(1), w.id))]);
    expect((await keyRow(w.id))!.cancel_h).toBe((await sha256Hex(tokenOf(url))).toUpperCase());
  });

  it('a failing notice is recorded, retried later after the others, and reported as stuck at error level from the 12th failure (finding 11)', async () => {
    const { org, owner, app } = await orgWithApp();
    const k = await memberKey(org, app.scope, owner);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: string) => void errors.push(l));
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await runPlatformKeyNotices(env, fake, big());
    expect(await hot().prepare('SELECT notice_failures FROM platform_keys WHERE id = ?1').bind(k.id).first()).toEqual({ notice_failures: 1 });
    await hot().prepare('UPDATE platform_keys SET notice_failures = 11, notice_failed_at = 1 WHERE id = ?1').bind(k.id).run();
    await runPlatformKeyNotices(env, fake, big());
    expect(errors.some((l) => l.includes('"code":"notice_stuck"') && l.includes(k.id))).toBe(true);
  });

  it('a notice whose owners can’t be read is recorded as a failure too, so it can’t hold the page back (second review, finding 7)', async () => {
    const a = await orgWithApp();
    const ka = await memberKey(a.org, a.app.scope, a.owner);
    const con = overrideBinding(env.CONSOLE, { listMembers: async (c: unknown) => ((c as { orgId: string }).orgId === a.org ? { ok: false, code: 'internal' } : env.CONSOLE.listMembers(c)) });
    await runPlatformKeyNotices(envWith({ CONSOLE: con }), new FakeEmail(), big());
    expect(await hot().prepare('SELECT notice_failures, notified_at FROM platform_keys WHERE id = ?1').bind(ka.id).first()).toEqual({ notice_failures: 1, notified_at: null });
    // Offered again only after its backoff, and after every other notice.
    const page = async () => (await env.API.platformKeyNotices({ ...systemCtx(), limit: 100 })) as { ok: true; notices: { key: { id: string } }[] };
    expect((await page()).notices.map((n) => n.key.id)).not.toContain(ka.id);
  });

  it('freezing writes the mirror, the console, the mirror again; unfreezing frees the console, reads it, then the mirror (inside the grace: held, and said)', async () => {
    const { org } = await orgWithApp();
    const order: string[] = [];
    const api = overrideBinding(env.API, { setPlatformOrgFrozen: async (c: unknown) => (order.push(`api:${(c as { frozen: boolean }).frozen}`), env.API.setPlatformOrgFrozen(c)) });
    const con = overrideBinding(env.CONSOLE, {
      freezeOrg: async (c: unknown) => (order.push(`console:${(c as { frozen: boolean }).frozen}`), env.CONSOLE.freezeOrg(c)),
      getOrg: async (c: unknown) => (order.push('console:read'), env.CONSOLE.getOrg(c)),
    });
    // Through the real route with the bindings replaced.
    const res = await adminRequestWith({ API: api, CONSOLE: con }, `/api/orgs/${org}/freeze`, { frozen: true });
    expect(res.status).toBe(200);
    const res2 = await adminRequestWith({ API: api, CONSOLE: con }, `/api/orgs/${org}/freeze`, { frozen: false });
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ error: { code: 'mirror_held', message: expect.stringMatching(/less than 10 minutes ago/u) } });
    expect(order).toEqual(['api:true', 'console:true', 'api:true', 'console:false', 'console:read', 'api:false']);
    // Past the grace, pressing Unfreeze again frees the mirror (the console is already active).
    await hot().prepare('UPDATE platform_orgs SET frozen_at = frozen_at - 3600000 WHERE org_id = ?1').bind(org).run();
    expect((await adminRequestWith({ API: api, CONSOLE: con }, `/api/orgs/${org}/freeze`, { frozen: false })).status).toBe(200);
    expect(await hot().prepare('SELECT frozen FROM platform_orgs WHERE org_id = ?1').bind(org).first()).toEqual({ frozen: 0 });
    // A failed mirror on a freeze still freezes the console, and says so.
    const down = overrideBinding(env.API, { setPlatformOrgFrozen: async () => ({ ok: false, code: 'internal' }) });
    const res3 = await adminRequestWith({ API: down, CONSOLE: env.CONSOLE }, `/api/orgs/${org}/freeze`, { frozen: true });
    expect(res3.status).toBe(502);
    expect(await env.CONSOLE_TEST_DB.prepare('SELECT status FROM orgs WHERE id = ?').bind(org).first()).toEqual({ status: 'frozen' });
  });
});

describe('the freeze mirror against the real API and console: a staff freeze racing the check (the exhaustive proof: freeze-mirror-interleavings.test.ts)', () => {
  type Point = 0 | 1 | 2 | 3;
  const staffCtx = () => ({ actor: { kind: 'hana' as const, id: 'staff-sub-1', email: 'staff@hana.example' }, requestId: `req_${uid()}`, clientIp: '198.51.100.9' });
  const mirror = (org: string) => hot().prepare('SELECT frozen FROM platform_orgs WHERE org_id = ?1').bind(org).first<{ frozen: number }>();
  const consoleStatus = async (org: string) => (await env.CONSOLE_TEST_DB.prepare('SELECT status FROM orgs WHERE id = ?').bind(org).first<{ status: string }>())!.status;

  /** An org whose console is active and whose mirror was left frozen an hour ago (a staff unfreeze whose mirror didn't land). */
  async function staleMirror(): Promise<string> {
    const { org } = await orgWithApp();
    await hot().prepare("INSERT INTO platform_orgs (org_id, frozen, frozen_at, set_by, set_at, version) VALUES (?1, 1, ?2, 'test', ?2, 1)").bind(org, Date.now() - 3_600_000).run();
    return org;
  }

  /**
   * One reconcile run seeing only `org`, with `at(point)` run at each point of its unfreeze path: 0 before it, 1 after
   * the lists (before the console is read again), 2 after that read (before the API's unfreeze), 3 after the run.
   */
  async function reconcileWith(org: string, at: (p: Point) => Promise<void>) {
    const only = <T extends { ok: boolean }>(r: T, key: 'orgs', id: 'id' | 'orgId'): T =>
      r.ok ? ({ ...r, [key]: (r as unknown as Record<string, { id?: string; orgId?: string }[]>)[key]!.filter((x) => x[id] === org), next: undefined } as T) : r;
    const con = overrideBinding(env.CONSOLE, {
      listOrgs: async (c: unknown) => only(await env.CONSOLE.listOrgs(c), 'orgs', 'id'),
      getOrg: async (c: unknown) => (await at(1), env.CONSOLE.getOrg(c)),
    });
    const api = overrideBinding(env.API, {
      platformOrgs: async (c: unknown) => only(await env.API.platformOrgs(c), 'orgs', 'orgId'),
      setPlatformOrgFrozen: async (c: unknown) => ((c as { frozen: boolean }).frozen ? undefined : await at(2), env.API.setPlatformOrgFrozen(c)),
    });
    await at(0);
    const r = await reconcileFreezes({ ...env, API: api, CONSOLE: con });
    await at(3);
    return r;
  }

  it('a staff freeze (mirror first, then the console) at every point of the unfreeze path: the mirror never ends unfrozen while the console is frozen', async () => {
    const points: Point[] = [0, 1, 2, 3];
    for (const a of points)
      for (const c of points.filter((p) => p >= a)) {
        const org = await staleMirror();
        await reconcileWith(org, async (p) => {
          if (p === a) expect((await env.API.setPlatformOrgFrozen({ ...staffCtx(), orgId: org, frozen: true })).ok, `mirror at ${a}`).toBe(true);
          if (p === c) expect((await env.CONSOLE.freezeOrg({ ...staffCtx(), orgId: org, frozen: true })).ok, `console at ${c}`).toBe(true);
        });
        expect(await consoleStatus(org), `${a}/${c}`).toBe('frozen');
        expect(await mirror(org), `${a}/${c}`).toEqual({ frozen: 1 });
      }
  });

  it('with no freeze racing it, the stale mirror is unfrozen (the console reads active, the mirror’s freeze is past the grace)', async () => {
    const org = await staleMirror();
    expect(await reconcileWith(org, async () => {})).toMatchObject({ fixed: 1, failed: 0 });
    expect(await mirror(org)).toEqual({ frozen: 0 });
  });

  it('a staff freeze whose mirror write fails, landing mid-run: an error-level log at once, and the next run freezes the mirror', async () => {
    const org = await staleMirror();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void errors.push(String(l)));
    const down = overrideBinding(env.API, { setPlatformOrgFrozen: async () => ({ ok: false, code: 'internal' }) });
    await reconcileWith(org, async (p) => {
      if (p === 2) expect((await adminRequestWith({ API: down }, `/api/orgs/${org}/freeze`, { frozen: true })).status).toBe(502);
    });
    expect(await consoleStatus(org)).toBe('frozen');
    // The check's unfreeze went through (the console read active, the mirror's freeze an hour old, and the staff route's
    // mirror writes both failed): the remaining window, said at error level at once.
    expect(await mirror(org)).toEqual({ frozen: 0 });
    expect(errors.some((l) => l.includes('platform_mirror'))).toBe(true);
    await reconcileWith(org, async () => {});
    expect(await mirror(org)).toEqual({ frozen: 1 });
    expect(errors.some((l) => l.includes('mirror_was_unfrozen') && l.includes(org))).toBe(true);
  });
});
