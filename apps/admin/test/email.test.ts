// EmailSender's SendGrid adapter (accepted only on 202; no idempotency header, SendGrid has none; nothing of the key,
// the answer or the address in an error; the admin category), sending to many (one message per recipient; a retry
// skips what this isolate saw accepted and never what it didn't, D401) and the rendering rules (escaped partner
// text, one-line subjects, links only to the console origin, no remote image); which mail bypasses SendGrid's
// suppression lists (alerts and blocking notices) and which keeps them (D401 as amended).
import { MAIL_LOGO_PATH } from '@hana-id/brand/mail-logo';
import { SENDGRID_URL } from '@hana-id/sendgrid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailLabel } from '../src/env.ts';
import { changePending, inviteLink } from '../src/email/messages.ts';
import { consoleLink, oneLine, render } from '../src/email/render.ts';
import { ADMIN_CATEGORY, outbound, sendgridSender } from '../src/email/sender.ts';
import { ACCEPTED_MEMO_MS, Budget, bypassesSuppressions, forgetAccepted, linkKey, messageKey, recipients, sendToAll } from '../src/mail.ts';
import { FakeEmail } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const KEY = 'SG.fixture-admin-not-real.fixture-secret-not-real-0123456789abcd';
const msg = { to: 'a@partner.example', subject: 's', text: 't', html: '<p>t</p>', messageKey: 'k1', bypassSuppressions: false };
const rendered = { subject: 's', text: 't', html: 'h' };

describe('the SendGrid adapter', () => {
  it('posts one message with the key, the from, one recipient, tracking off and the admin category; accepted on 202', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 202, headers: { 'x-message-id': 'msg-123' } });
    });
    expect(await sendgridSender(KEY, 'Hana ID <team@hanawallet.example>').send(msg)).toEqual({ ok: true, id: 'msg-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SENDGRID_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-type']);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, any>;
    expect(body.personalizations).toEqual([{ to: [{ email: 'a@partner.example' }] }]);
    expect(body.from).toEqual({ email: 'team@hanawallet.example', name: 'Hana ID' });
    expect(body.subject).toBe('s');
    expect(body.content).toEqual([
      { type: 'text/plain', value: 't' },
      { type: 'text/html', value: '<p>t</p>' },
    ]);
    expect(body.categories).toEqual([ADMIN_CATEGORY]);
    // A link in a notice must stay a console link: no click tracking rewrites it.
    expect(body.tracking_settings.click_tracking).toEqual({ enable: false, enable_text: false });
    expect(body.tracking_settings.open_tracking).toEqual({ enable: false });
    // A routine message keeps SendGrid's suppression lists; an alert or a blocking notice bypasses them.
    expect(body.mail_settings).toBeUndefined();
    calls.length = 0;
    await sendgridSender(KEY, 'x@mail.hana.example').send({ ...msg, bypassSuppressions: true });
    expect(JSON.parse(String(calls[0]!.init.body)).mail_settings).toEqual({ bypass_bounce_management: { enable: true }, bypass_spam_management: { enable: true }, bypass_unsubscribe_management: { enable: true } });
    // The Worker's sender is this adapter, with the Worker's own key and EMAIL_FROM.
    calls.length = 0;
    expect((await outbound.email({ EMAIL_API_KEY: KEY, EMAIL_FROM: 'team@hanawallet.example' }).send(msg)).ok).toBe(true);
    expect(calls[0]!.url).toBe(SENDGRID_URL);
  });

  it('anything but 202 is a failure, whose text carries the status only', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response(`{"errors":[{"message":"a@partner.example is invalid for ${KEY}"}]}`, { status: 400 }),
      () => new Response('unauthorized', { status: 401 }),
      () => new Response('slow down', { status: 429 }),
      () => new Response('oops', { status: 500 }),
      () => Response.json({ id: 'x' }),
      () => Promise.reject(new TypeError(`network ${KEY}`)),
    ];
    const errors: string[] = [];
    for (const a of answers) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => a());
      const r = await sendgridSender(KEY, 'x@mail.hana.example').send(msg);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/SG\.|partner\.example|invalid/u);
      if (!r.ok) errors.push(r.error);
      vi.restoreAllMocks();
    }
    expect(errors).toEqual(['HTTP 400', 'HTTP 401', 'HTTP 429', 'HTTP 500', 'HTTP 200', 'network error or timeout']);
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(sendgridSender(undefined, 'x@mail.hana.example').configured).toBe(false);
    expect(await sendgridSender(undefined, 'x@mail.hana.example').send(msg)).toEqual({ ok: false, error: 'not configured' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('sending to many', () => {
  it('one message per recipient, every one tried; all accepted or not; the budget is checked first', async () => {
    const fake = new FakeEmail();
    fake.failFor.add('b@x.example');
    const r = await sendToAll(fake, new Budget(10), ['a@x.example', 'b@x.example', 'c@x.example'], rendered, 'p');
    expect(r).toEqual({ allAccepted: false, sent: 2, failed: 1, skipped: 0, outOfBudget: false });
    expect(fake.attempts.map((m) => m.to)).toEqual(['a@x.example', 'b@x.example', 'c@x.example']);
    const tight = new FakeEmail();
    expect(await sendToAll(tight, new Budget(2), ['a@x.example', 'b@x.example', 'c@x.example'], rendered, 'q')).toMatchObject({ allAccepted: false, outOfBudget: true });
    expect(tight.attempts).toEqual([]);
    expect((await sendToAll(new FakeEmail(), new Budget(5), [], rendered, 'p')).allAccepted).toBe(false);
    const off = new FakeEmail();
    off.configured = false;
    expect(await sendToAll(off, new Budget(5), ['a@x.example'], rendered, 'r')).toEqual({ allAccepted: false, sent: 0, failed: 1, skipped: 0, outOfBudget: false });
    expect(off.attempts).toEqual([]);
    expect(recipients(['A@x.example ', 'a@x.example'], 'b@x.example', undefined, [''])).toEqual(['a@x.example', 'b@x.example']);
  });

  it('a retry sends only to the recipients not yet accepted (D401); one not accepted is always retried', async () => {
    const now = Date.UTC(2026, 10, 5, 9);
    const fake = new FakeEmail();
    fake.failFor.add('b@x.example');
    const to = ['a@x.example', 'b@x.example'];
    expect(await sendToAll(fake, new Budget(10), to, rendered, 'notice:1', now)).toMatchObject({ allAccepted: false, sent: 1, failed: 1, skipped: 0 });
    // b keeps failing: retried every run, never counted; a is not sent again.
    expect(await sendToAll(fake, new Budget(10), to, rendered, 'notice:1', now + 60_000)).toMatchObject({ allAccepted: false, sent: 0, failed: 1, skipped: 1 });
    fake.failFor.clear();
    expect(await sendToAll(fake, new Budget(10), to, rendered, 'notice:1', now + 120_000)).toEqual({ allAccepted: true, sent: 1, failed: 0, skipped: 1, outOfBudget: false });
    expect(fake.attempts.map((m) => m.to)).toEqual(['a@x.example', 'b@x.example', 'b@x.example', 'b@x.example']);
    // Everything accepted: a repeat sends nothing and needs no budget, and still reports all accepted.
    expect(await sendToAll(fake, new Budget(0), to, rendered, 'notice:1', now + 180_000)).toEqual({ allAccepted: true, sent: 0, failed: 0, skipped: 2, outOfBudget: false });
    // Another purpose (another message) to the same people is its own message.
    expect(await sendToAll(fake, new Budget(10), to, rendered, 'notice:2', now)).toMatchObject({ sent: 2, skipped: 0 });
    // After the window (Resend's 24 h) the memo has forgotten it; so has a fresh isolate.
    expect(await sendToAll(fake, new Budget(10), to, rendered, 'notice:1', now + 120_000 + ACCEPTED_MEMO_MS)).toMatchObject({ sent: 2, skipped: 0 });
    forgetAccepted();
    expect(await sendToAll(fake, new Budget(10), to, rendered, 'notice:2', now)).toMatchObject({ sent: 2, skipped: 0 });
  });

  it('a lost answer (timeout) is a failure, so the message is sent again: a duplicate at worst, never skipped', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new DOMException('The operation timed out.', 'TimeoutError');
      return new Response(null, { status: 202 });
    });
    const sender = sendgridSender(KEY, 'x@mail.hana.example');
    expect(await sendToAll(sender, new Budget(5), ['a@x.example'], rendered, 'notice:timeout')).toMatchObject({ allAccepted: false, failed: 1 });
    expect(await sendToAll(sender, new Budget(5), ['a@x.example'], rendered, 'notice:timeout')).toMatchObject({ allAccepted: true, sent: 1 });
    expect(calls).toBe(2);
  });

  it('message keys: one per purpose and recipient, no address in them; each send carries its own, SendGrid never sees it', async () => {
    const keys = await Promise.all(['a@x.example', 'b@x.example'].flatMap((to) => ['p', 'q'].map((p) => messageKey(p, to))));
    expect(new Set(keys).size).toBe(4);
    expect(keys.join()).not.toContain('@');
    const fake = new FakeEmail();
    await sendToAll(fake, new Budget(5), ['a@x.example'], rendered, 'p');
    expect(fake.attempts.map((m) => m.messageKey)).toEqual([await messageKey('p', 'a@x.example')]);
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String(init!.body));
      return new Response(null, { status: 202 });
    });
    await sendgridSender(KEY, 'x@mail.hana.example').send({ ...msg, messageKey: 'key-that-stays-here' });
    expect(bodies[0]).not.toContain('key-that-stays-here');
  });

  it('alerts and blocking notices bypass the suppression lists; invitations, statements and the audit digest keep them (D401 as amended)', async () => {
    for (const p of ['change_pending:c1', 'login_methods_changed:1', 'invite_notice:i1', 'owner_grant:g1', 'watch_pending:s:1', 'watch_changed:s:x', 'feed:security_events:1,2', 'feed:app_changes:org_1:1-2', 'nonce_unexplained:x', 'rejection_rate:x', 'settlement_mismatch:x', 'retention_failed:x', 'retention_overdue:2026-10', 'retention_skipped:2026-10', 'directory_budget:sandbox:a@hana.example:1h:1'])
      expect(bypassesSuppressions(p), p).toBe(true);
    for (const p of ['invite_link:i1', 'statement_issued:org_1:2026-10:abc', 'feed:audit_log:org_1:1-2']) expect(bypassesSuppressions(p), p).toBe(false);
    // An unknown kind fails towards delivery.
    expect(bypassesSuppressions('something_new:1')).toBe(true);
    const fake = new FakeEmail();
    await sendToAll(fake, new Budget(5), ['a@x.example'], rendered, 'owner_grant:g9');
    await sendToAll(fake, new Budget(5), ['a@x.example'], rendered, 'invite_link:i9');
    expect(fake.attempts.map((m) => m.bypassSuppressions)).toEqual([true, false]);
  });

  it('link keys: 32 bytes of base64 or b64url, anything else refused', () => {
    expect(linkKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))?.length).toBe(32);
    expect(linkKey('A'.repeat(43))?.length).toBe(32);
    for (const bad of [undefined, '', 'short', btoa('x'.repeat(31)), btoa('x'.repeat(33))]) expect(linkKey(bad)).toBeNull();
  });
});

describe('rendering', () => {
  const ctx = { env: 'sandbox-test', consoleOrigin: 'https://console.test' };

  it('escapes partner text in HTML, keeps the subject on one line, and links only to the console', () => {
    const r = changePending(
      ctx,
      {
        change: { id: 'gc_1', appId: 'app_1', kind: 'origin_add', origin: 'https://a.example', display: 'https://a.example', idn: false, status: 'pending', proposedByKind: 'hana', proposedBy: 'sub', proposedAt: 0 },
        contacts: [],
        app: { id: 'app_1', name: '<img src=x onerror=alert(1)>\r\nBcc: victim@example.com', orgId: 'org_1', scopeId: 's1', environment: 'test' },
      },
      { cancelUrl: consoleLink('https://console.test', '/cancel/gc_1#t=abc'), delayMs: 86_400_000 },
    );
    expect(r.subject).not.toMatch(/[\r\n]/u);
    expect(r.subject.startsWith('[Hana ID sandbox-test] Pending change for')).toBe(true);
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.text).toContain('about 1 d after this notice');
    expect(() => consoleLink('https://console.test', '//evil.example/x')).toThrow();
    expect(() => render('e', 's', [{ kind: 'link', label: 'x', url: 'https://evil.example/' }], 'https://console.test')).toThrow();
    expect(oneLine(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(7)}d`)).toBe('abcd');
  });
  it('a non-production env labels every subject and opens every body with it (D419); production carries none', () => {
    const r = render('sandbox-dev', 'Retention job failed (1 run)', [{ kind: 'p', text: 'body' }], 'https://console.test', '[SANDBOX]');
    expect(r.subject).toBe('[SANDBOX] [Hana ID sandbox-dev] Retention job failed (1 run)');
    expect(r.text.startsWith('[SANDBOX] Not production: this email is from Hana ID sandbox-dev (testnet), for testing.\n\nbody')).toBe(true);
    expect(r.html).toContain('<p><strong>[SANDBOX] Not production:');
    const prod = render('prod', 'Retention job failed (1 run)', [{ kind: 'p', text: 'body' }], 'https://console.test');
    expect(prod.subject).toBe('[Hana ID prod] Retention job failed (1 run)');
    expect(prod.text.startsWith('body')).toBe(true);
    // Partner mail too: an invitation from a sandbox says it is a test.
    const invite = inviteLink({ ...ctx, label: '[SANDBOX]' }, { id: 'inv_1', role: 'owner', newOrgName: 'Acme', expiresAt: 0 } as never, { inviteUrl: 'https://console.test/invite#t=x' });
    expect(invite.subject.startsWith('[SANDBOX] [Hana ID sandbox-test] You')).toBe(true);
  });

  it('the invite: the designed layout, one button and the raw URL as text, who invited and what accepting does', () => {
    const invite = { id: 'inv_1', email: 'ada@partner.example', orgId: 'org_1', role: 'owner', createdByKind: 'member', createdBy: 'usr_secret_id', createdAt: 0, expiresAt: Date.UTC(2026, 10, 17, 9) } as never;
    const url = 'https://console.test/invite#t=abc_DEF-123';
    const r = inviteLink({ ...ctx, label: '[SANDBOX]' }, invite, { orgName: 'Sodax Labs', inviteUrl: url });
    expect(r.subject).toBe("[SANDBOX] [Hana ID sandbox-test] You're invited to Sodax Labs on Hana ID");
    expect(r.text).toMatchSnapshot('text');
    expect(r.html).toMatchSnapshot('html');
    expect([...r.html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1])).toEqual([url]);
    expect(r.html.match(/<a /gu)).toHaveLength(1);
    expect(r.html).not.toMatch(/<img|<script|<form|src=/iu);
    // The raw URL as text, broken so clients don't link it a second time; the label banner; the heading without prefixes.
    expect(r.html).toContain('console<span>.</span><wbr>test<span>/</span><wbr>invite<span>#</span><wbr>t<span>=</span><wbr>abc_DEF-123');
    expect(r.html).toContain('[SANDBOX] Not production: this email is from Hana ID sandbox-test (testnet), for testing.');
    expect(r.html).toContain(">You&#39;re invited to Sodax Labs on Hana ID</h1>");
    // Who invited, by role only (no member id or staff address); what accepting does.
    expect(r.text).toContain('as an owner, by an owner of the organisation.');
    expect(`${r.text}${r.html}`).not.toContain('usr_secret_id');
    expect(r.text).toContain('Accepting adds you to the organisation.');
    expect(r.text).toContain('The link works once, for this address only.');
    const staff = inviteLink(ctx, { ...(invite as object), createdByKind: 'hana', createdBy: 'staff@hana.example', role: 'viewer' } as never, { orgName: 'Sodax Labs', inviteUrl: url });
    expect(staff.text).toContain('as a viewer, by Hana staff.');
    expect(staff.text).toContain('viewers see its apps and settings and change nothing');
    expect(`${staff.text}${staff.html}`).not.toContain('staff@hana.example');
    expect(staff.html).not.toContain('Not production');
    const fresh = inviteLink(ctx, { ...(invite as object), orgId: undefined, newOrgName: 'Acme' } as never, { inviteUrl: url });
    expect(fresh.text).toContain('Accepting creates the organisation in the console, with you as its first owner.');
    // Far under Gmail's clip.
    expect(new TextEncoder().encode(r.html).length).toBeLessThan(16_000);
  });

  it('the invite: hostile organisation names are text; the preview line holds no link token', () => {
    const url = 'https://console.test/invite#t=tok';
    for (const name of ['<a href="javascript:alert(1)">Claim</a>', `Acme${String.fromCharCode(0x202e)}moc.live`, `"><img src=x onerror=alert(1)>`, 'W'.repeat(256), `Acme\r\nBcc: x@example.com`]) {
      const r = inviteLink(ctx, { id: 'inv_1', role: 'owner', newOrgName: name, createdByKind: 'hana', createdBy: 's', expiresAt: 0 } as never, { inviteUrl: url });
      expect(r.subject, name).not.toMatch(/[\r\n]/u);
      expect([...r.html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1]), name).toEqual([url]);
      expect(r.html, name).not.toMatch(/<img|<script|<a href="javascript/iu);
      for (const cp of [0x202e, 0x0d]) expect(r.html.includes(String.fromCharCode(cp)), name).toBe(false);
      const pre = /<div style="display:none[^"]*">([^&<]*)/u.exec(r.html)![1]!;
      expect(pre).not.toContain('tok');
    }
    expect(() => render('e', 's', [{ kind: 'link', label: 'x', url: 'javascript:alert(1)' }], 'https://console.test', '', { heading: 'h', preheader: 'p' })).toThrow();
  });

  it('the invite: the hosted logo when the env has a files origin, the only image (D685); an org name that looks like a host is unlinked text', () => {
    const url = 'https://console.test/invite#t=tok';
    const r = inviteLink({ ...ctx, filesOrigin: 'https://files.test' }, { id: 'inv_1', role: 'owner', newOrgName: 'evil.example Labs', createdByKind: 'hana', createdBy: 's', expiresAt: 0 } as never, { inviteUrl: url });
    const imgs = [...r.html.matchAll(/<img\b[^>]*>/gu)].map((m) => m[0]);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toContain(`src="https://files.test${MAIL_LOGO_PATH}"`);
    expect(imgs[0]).toContain('alt="Hana ID"');
    expect([...r.html.matchAll(/\bsrc=/gu)]).toHaveLength(1);
    expect(r.html).toContain('evil<span>.</span><wbr>example Labs');
    expect([...r.html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1])).toEqual([url]);
    expect(inviteLink(ctx, { id: 'inv_1', role: 'owner', newOrgName: 'Acme', createdByKind: 'hana', createdBy: 's', expiresAt: 0 } as never, { inviteUrl: url }).html).not.toContain('<img');
  });

  it('operational mails keep the plain HTML (no designed layout)', () => {
    const r = render('prod', 'Retention job failed (1 run)', [{ kind: 'p', text: 'body' }], 'https://console.test');
    expect(r.html).toBe('<!doctype html><html><body><p>body</p>\n<p><small>Sent by Hana ID security. Hana never asks you to approve anything from an email. To reach Hana security, reply to this address or write to your Hana contact.</small></p></body></html>');
  });

  it('mailLabel: ENV_LABEL only when it is a label and the network is testnet', () => {
    expect(mailLabel({ ENV_LABEL: '[SANDBOX]', NEAR_NETWORK: 'testnet' })).toBe('[SANDBOX]');
    expect(mailLabel({ ENV_LABEL: '[STAGING]', NEAR_NETWORK: 'testnet' })).toBe('[STAGING]');
    expect(mailLabel({ ENV_LABEL: 'PROD', NEAR_NETWORK: 'testnet' })).toBe('');
    expect(mailLabel({ ENV_LABEL: '[SANDBOX]', NEAR_NETWORK: 'mainnet' })).toBe('');
    expect(mailLabel({ ENV_LABEL: '[SANDBOX]' })).toBe('');
    expect(mailLabel({ NEAR_NETWORK: 'testnet' })).toBe('');
  });
});
