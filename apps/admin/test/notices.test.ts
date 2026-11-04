// The blocking notices (docs/batch-c-spec.md "Tests: Admin and email", "Guarded changes", "Invites and roles"):
// `change_pending`, `member_invite` and `owner_grant` go to the alias and every contact (and every owner, and the
// invitee), one message each, and are acked only after every send was accepted; a provider failure leaves the change,
// invite or grant unannounced, and a retry acks with the same link token. Against the real API and console.
import { linkToken } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Budget } from '../src/mail.ts';
import { runChangeNotices, runMemberNotices } from '../src/notices.ts';
import { ALIAS, CONSOLE, FakeEmail, adminRequest, envWith, hotVersion, json, linkIn, overrideBinding, seedConsoleMember, seedConsoleOrg, seedHotApp, sha256Hex, stubNetwork, tokenOf, uid } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => vi.restoreAllMocks());

const big = () => new Budget(1000);

async function proposeOrigin(app: { id: string; org: string }, origin = `https://${uid()}.partner.example`): Promise<string> {
  const res = await adminRequest(`/api/apps/${app.id}/origins`, { body: { orgId: app.org, add: [origin], expectedVersion: (await hotVersion(app.id)).origins } });
  expect(res.status).toBe(200);
  const body = await json<{ changes: { id: string }[] }>(res);
  return body.changes[0]!.id;
}

const changeRow = (id: string) => env.HOT_DB.prepare('SELECT notified_at, active_from, CASE WHEN cancel_token_hash IS NULL THEN NULL ELSE hex(cancel_token_hash) END AS h, status FROM guarded_changes WHERE id = ?1').bind(id).first<{ notified_at: number | null; active_from: number | null; h: string | null; status: string }>();

describe('change_pending', () => {
  it('emails the alias and every contact, one message each, then acks with sha256 of the link token', async () => {
    const app = await seedHotApp(undefined, { contacts: [`a-${uid()}@partner.example`, `b-${uid()}@partner.example`] });
    const contacts = (await env.HOT_DB.prepare('SELECT email FROM org_security_contacts WHERE org_id = ?1 ORDER BY email').bind(app.org).all<{ email: string }>()).results.map((r) => r.email);
    const id = await proposeOrigin(app, 'https://xn--bcher-kva.example');
    expect((await changeRow(id))!.notified_at).toBeNull();
    const fake = new FakeEmail();
    const r = await runChangeNotices(env, fake, big());
    expect(r.acked).toBeGreaterThanOrEqual(1);
    const mine = fake.about(id);
    expect(mine.map((m) => m.to).sort()).toEqual([ALIAS, ...contacts].sort());
    for (const m of mine) {
      expect(m.subject).toContain('[Hana ID sandbox-test] Pending change');
      expect(m.text).toContain('https://xn--bcher-kva.example');
      expect(m.text).toContain('internationalised domain name');
      expect(m.html).not.toMatch(/<img|<script|src=/iu);
      // Every link is to the console origin; no approve link.
      expect(m.text).toContain('https://bücher.example');
      for (const url of m.text.match(/https?:\/\/[^\s]+/gu) ?? []) if (!/xn--bcher-kva\.example|bücher\.example/u.test(url)) expect(url.startsWith(`${CONSOLE}/`), url).toBe(true);
      const hrefs = [...m.html.matchAll(/href="([^"]*)"/gu)].map((x) => x[1]!);
      expect(hrefs).toHaveLength(1);
      expect(hrefs[0]!.startsWith(`${CONSOLE}/cancel/`)).toBe(true);
      expect(m.text).not.toMatch(/approve\b[^\n]*https?:/iu);
    }
    const url = linkIn(mine[0]!.text, `/cancel/${id}`);
    const token = tokenOf(url);
    // Deterministic: HMAC(CANCEL_LINK_KEY, "hana-id/cancel-link/v1" ‖ borsh(id)).
    expect([...token]).toEqual([...(await linkToken('cancelLink', new Uint8Array(32).fill(1), id))]);
    const row = await changeRow(id);
    expect(row!.notified_at).not.toBeNull();
    expect(row!.active_from).toBeGreaterThan(row!.notified_at!);
    expect(row!.h).toBe((await sha256Hex(token)).toUpperCase());
    // The same link cancels through the console's confirm (the API checks the hash).
    const cancel = await env.HOT_DB.prepare('SELECT COUNT(*) AS n FROM app_changes WHERE kind = ?1 AND detail_json LIKE ?2').bind('change.announced', `%${id}%`).first<number>('n');
    expect(cancel).toBe(1);
    // A second run sends nothing more for it.
    const again = new FakeEmail();
    await runChangeNotices(env, again, big());
    expect(again.about(id)).toEqual([]);
  });

  it('a provider failure on one recipient leaves the change unannounced; the retry acks with the same token', async () => {
    const app = await seedHotApp();
    const id = await proposeOrigin(app);
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await runChangeNotices(env, fake, big());
    expect((await changeRow(id))!.notified_at).toBeNull();
    expect((await changeRow(id))!.h).toBeNull();
    const first = tokenOf(linkIn(fake.about(id).find((m) => m.to === ALIAS)!.text, `/cancel/${id}`));
    fake.failFor.clear();
    await runChangeNotices(env, fake, big());
    const row = await changeRow(id);
    expect(row!.notified_at).not.toBeNull();
    expect(row!.h).toBe((await sha256Hex(first)).toUpperCase());
    // The retry carried the same idempotency key per recipient, so the provider drops a duplicate.
    const keys = fake.attempts.filter((m) => m.to === ALIAS && m.text.includes(id)).map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('acks nothing without the email key, without the cancel-link key, or when the budget runs out', async () => {
    const app = await seedHotApp();
    const id = await proposeOrigin(app);
    const off = new FakeEmail();
    off.configured = false;
    await runChangeNotices(env, off, big());
    expect((await changeRow(id))!.notified_at).toBeNull();
    const fake = new FakeEmail();
    await runChangeNotices(envWith({ CANCEL_LINK_KEY: undefined }), fake, big());
    await runChangeNotices(envWith({ CANCEL_LINK_KEY: 'too-short' }), fake, big());
    expect(fake.attempts).toEqual([]);
    await runChangeNotices(env, fake, new Budget(1));
    expect(fake.attempts).toEqual([]);
    expect((await changeRow(id))!.notified_at).toBeNull();
    await runChangeNotices(env, fake, big());
    expect((await changeRow(id))!.notified_at).not.toBeNull();
  });

  it('describes a policy: label, limits, every addressArgs any, the JSON', async () => {
    const app = await seedHotApp();
    // apps/api/test/vault-helpers.ts autoApprovePolicy, with an `addressArgs: 'any'` selector.
    const policy = {
      v: 1,
      label: 'USDC approvals',
      maxConsentMs: 3_600_000,
      limits: { perDayCount: 5 },
      evm: {
        chains: [
          {
            chainId: 8453,
            maxValueWei: '100000',
            maxValueWeiPerDay: '100000',
            maxFeeWei: '100000',
            contracts: [{ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USDC', selectors: [{ selector: '0x4420e486', signature: 'register(address)', addressArgs: 'any' }] }],
          },
        ],
      },
    };
    const res = await adminRequest(`/api/apps/${app.id}/changes`, { body: { orgId: app.org, kind: 'policy_set', policy, expectedVersion: (await hotVersion(app.id)).settings } });
    expect(res.status, await res.clone().text()).toBe(200);
    const { change } = await json<{ change: { id: string } }>(res);
    const fake = new FakeEmail();
    await runChangeNotices(env, fake, big());
    const m = fake.about(change.id)[0]!;
    expect(m.text).toContain('USDC approvals');
    expect(m.text).toContain('perDayCount');
    expect(m.text).toContain('Consent lasts up to:');
    expect(m.text).toMatch(/WARNING: The policy lets any address be passed at: policy\.evm\.chains\[0\]\.contracts\[0\]\.selectors\[0\]\.addressArgs/u);
  });
});

describe('member_invite and owner_grant', () => {
  async function orgWithOwner() {
    const app = await seedHotApp();
    await seedConsoleOrg(app.org, `Acme ${uid()}`);
    const owner = await seedConsoleMember(app.org, 'owner');
    return { org: app.org, owner, contact: app.contact };
  }

  const inviteRow = (id: string) => env.CONSOLE_TEST_DB.prepare('SELECT CASE WHEN token_hash IS NULL THEN NULL ELSE hex(token_hash) END AS h, notified_at FROM invites WHERE id = ?').bind(id).first<{ h: string | null; notified_at: number | null }>();

  it('an invite: the notice to every owner, the contacts and the alias, the link to the invitee, then the ack', async () => {
    const { org, owner, contact } = await orgWithOwner();
    const email = `new-${uid()}@partner.example`;
    const res = await adminRequest('/api/invites', { body: { email, role: 'viewer', orgId: org } });
    expect(res.status).toBe(200);
    const { invite } = await json<{ invite: { id: string } }>(res);
    expect(JSON.stringify(invite)).not.toMatch(/token/iu);
    const fake = new FakeEmail();
    await runMemberNotices(env, fake, big());
    const notice = fake.about(invite.id);
    expect(notice.map((m) => m.to).sort()).toEqual([owner.email, contact, ALIAS].sort());
    expect(notice[0]!.text).toContain(email);
    const link = fake.to(email);
    expect(link).toHaveLength(1);
    expect(link[0]!.subject).toContain("You're invited to Acme");
    const token = tokenOf(linkIn(link[0]!.text, '/invite'));
    expect([...token]).toEqual([...(await linkToken('invite', new Uint8Array(32).fill(2), invite.id))]);
    // Only the invitee's message carries the link.
    for (const m of notice) expect(m.text).not.toContain('/invite#t=');
    const row = await inviteRow(invite.id);
    expect(row!.h).toBe((await sha256Hex(token)).toUpperCase());
  });

  it('a failed send leaves the invite unusable (no token hash); a new org invite goes to the alias and the invitee', async () => {
    const { org } = await orgWithOwner();
    const email = `fail-${uid()}@partner.example`;
    const { invite } = await json<{ invite: { id: string } }>(await adminRequest('/api/invites', { body: { email, role: 'viewer', orgId: org } }));
    const fake = new FakeEmail();
    fake.failFor.add(email);
    await runMemberNotices(env, fake, big());
    expect((await inviteRow(invite.id))!.h).toBeNull();
    fake.failFor.clear();
    await runMemberNotices(env, fake, big());
    expect((await inviteRow(invite.id))!.h).not.toBeNull();

    const founder = `founder-${uid()}@partner.example`;
    const created = await adminRequest('/api/invites', { body: { email: founder, role: 'owner', newOrgName: `New ${uid()}`, kind: 'internal' } });
    expect(created.status).toBe(200);
    const fresh = await json<{ invite: { id: string } }>(created);
    const f2 = new FakeEmail();
    await runMemberNotices(env, f2, big());
    expect(f2.about(fresh.invite.id).map((m) => m.to)).toEqual([ALIAS]);
    expect(f2.to(founder)).toHaveLength(1);
    expect((await inviteRow(fresh.invite.id))!.h).not.toBeNull();
  });

  it('a promotion: the grant notice with its cancel link to every owner, the contacts and the alias; acked with sha256(T)', async () => {
    const { org, owner, contact } = await orgWithOwner();
    const viewer = await seedConsoleMember(org, 'viewer');
    const res = await adminRequest(`/api/orgs/${org}/members/${viewer.id}`, { body: { role: 'owner' } });
    expect(res.status).toBe(200);
    const grant = await env.CONSOLE_TEST_DB.prepare('SELECT id, owner_from FROM owner_grants WHERE org_id = ? AND user_id = ?').bind(org, viewer.id).first<{ id: string; owner_from: number | null }>();
    expect(grant!.owner_from).toBeNull();
    const fake = new FakeEmail();
    fake.failFor.add(contact);
    await runMemberNotices(env, fake, big());
    const unacked = await env.CONSOLE_TEST_DB.prepare('SELECT CASE WHEN cancel_token_hash IS NULL THEN NULL ELSE hex(cancel_token_hash) END AS h FROM owner_grants WHERE id = ?').bind(grant!.id).first<string>('h');
    expect(unacked).toBeNull();
    fake.failFor.clear();
    await runMemberNotices(env, fake, big());
    const sent = fake.about(grant!.id);
    expect([...new Set(sent.map((m) => m.to))].sort()).toEqual([owner.email, contact, ALIAS].sort());
    expect(sent[0]!.text).toContain(viewer.email);
    const token = tokenOf(linkIn(sent[0]!.text, `/cancel-owner/${grant!.id}`));
    expect([...token]).toEqual([...(await linkToken('ownerGrantCancel', new Uint8Array(32).fill(1), grant!.id))]);
    const row = await env.CONSOLE_TEST_DB.prepare('SELECT CASE WHEN cancel_token_hash IS NULL THEN NULL ELSE hex(cancel_token_hash) END AS h, owner_from, notified_at FROM owner_grants WHERE id = ?').bind(grant!.id).first<{ h: string; owner_from: number; notified_at: number }>();
    expect(row!.h).toBe((await sha256Hex(token)).toUpperCase());
    expect(row!.owner_from).toBe(row!.notified_at + 60_000);
  });

  it('sends nothing for an org whose contacts are unreadable (the API down), and nothing without the invite key', async () => {
    const { org } = await orgWithOwner();
    const { invite } = await json<{ invite: { id: string } }>(await adminRequest('/api/invites', { body: { email: `x-${uid()}@partner.example`, role: 'viewer', orgId: org } }));
    const fake = new FakeEmail();
    await runMemberNotices(envWith({ INVITE_LINK_KEY: undefined }), fake, big());
    expect(fake.attempts).toEqual([]);
    const brokenApi = overrideBinding(env.API, { getSecurityContacts: () => Promise.reject(new Error('down')) });
    await runMemberNotices(envWith({ API: brokenApi }), fake, big());
    expect(fake.about(invite.id)).toEqual([]);
    expect((await inviteRow(invite.id))!.h).toBeNull();
  });
});

describe('privacy of the notice run', () => {
  it('no log line carries an address, a link token or its hash', async () => {
    const { org } = await (async () => {
      const app = await seedHotApp();
      await seedConsoleOrg(app.org);
      await seedConsoleMember(app.org, 'owner');
      return app;
    })();
    await adminRequest('/api/invites', { body: { email: `log-${uid()}@partner.example`, role: 'viewer', orgId: org } });
    const app = await seedHotApp();
    const id = await proposeOrigin(app);
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((s: unknown) => void lines.push(String(s)));
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await runChangeNotices(env, fake, big());
    await runMemberNotices(env, fake, big());
    fake.failFor.clear();
    await runChangeNotices(env, fake, big());
    expect(lines.length).toBeGreaterThan(0);
    const token = tokenOf(linkIn(fake.about(id)[0]!.text, `/cancel/${id}`));
    const b64 = btoa(String.fromCharCode(...token)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    for (const l of lines) {
      expect(l).not.toContain('@');
      expect(l).not.toContain(b64);
      expect(l).not.toMatch(/[A-Za-z0-9_-]{43}/u);
    }
  });
});
