// EmailSender's SendGrid adapter (accepted only on 202; no idempotency header, SendGrid has none; nothing of the key,
// the answer or the address in an error; the admin category), sending to many (one message per recipient; a retry
// skips what this isolate saw accepted and never what it didn't, D401) and the rendering rules (escaped partner
// text, one-line subjects, links only to the console origin, no remote image); which mail bypasses SendGrid's
// suppression lists (alerts and blocking notices) and which keeps them (D401 as amended).
import { MAIL_LOGO_PATH } from '@hana-id/brand/mail-logo';
import { SENDGRID_URL } from '@hana-id/sendgrid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailLabel } from '../src/env.ts';
import { auditDigest, changePending, changesDigest, inviteLink, inviteNotice, loginMethodsChanged, onChainChanged, onChainPending, ownerGrantNotice, securityDigest } from '../src/email/messages.ts';
import { retentionFailed, statementIssued } from '../src/email/ledger-messages.ts';
import { DIGEST_HTML_BUDGET, consoleLink, cut, isoTime, oneLine, readableTime, render, rowTime } from '../src/email/render.ts';
import { FEED_PAGE } from '../src/feed.ts';
import { ADMIN_CATEGORY, outbound, sendgridSender } from '../src/email/sender.ts';
import { ACCEPTED_MEMO_MS, Budget, bypassesSuppressions, forgetAccepted, linkKey, messageKey, recipients, sendToAll } from '../src/mail.ts';
import { FakeEmail, visibleText } from './helpers.ts';

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
    expect(r.subject.startsWith('[Hana ID sandbox-test] New allowed origin proposed for')).toBe(true);
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).not.toMatch(/onerror=alert[^<]*>/u);
    expect(visibleText(r.html)).toContain('<img src=x onerror=alert(1)> Bcc: victim@example.com');
    expect(r.text).toContain('about 1 d after this notice');
    expect(() => consoleLink('https://console.test', '//evil.example/x')).toThrow();
    expect(() => render('e', 's', [{ kind: 'link', label: 'x', url: 'https://evil.example/' }], 'https://console.test')).toThrow();
    expect(oneLine(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(7)}d`)).toBe('abcd');
  });
  it('the change notice in plain words per kind (D699): subject, the Change row with its id, a readable time; still pending and cancellable', () => {
    const notice = (kind: string, extra: Record<string, unknown> = {}) =>
      changePending(
        { ...ctx, label: '[SANDBOX]' },
        {
          change: { id: 'gc_7', appId: 'app_1', kind, status: 'pending', proposedByKind: 'member', proposedBy: 'usr_1', proposedAt: Date.parse('2026-11-11T05:01:36.861Z'), ...extra } as never,
          contacts: [],
          app: { id: 'app_1', name: 'Dry Run App', orgId: 'org_1', scopeId: 's1', environment: 'test' },
        },
        { cancelUrl: consoleLink('https://console.test', '/cancel/gc_7#t=abc'), delayMs: 60_000 },
      );
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['origin_add', { origin: 'https://app.partner.example', display: 'https://app.partner.example', idn: false }, 'New allowed origin proposed for Dry Run App', 'Add an allowed origin (gc_7)'],
      ['policy_set', { policyId: 'pol_1' }, 'Auto-approve policy proposed for Dry Run App', 'Set an auto-approve policy (gc_7)'],
      ['raw_sign_on', {}, 'Raw signing proposed for Dry Run App', 'Turn on raw signing (with approval) (gc_7)'],
      ['some_new_kind', {}, 'Change proposed for Dry Run App', 'some_new_kind (gc_7)'],
    ];
    for (const [kind, extra, subject, row] of cases) {
      const r = notice(kind, extra);
      expect(r.subject).toBe(`[SANDBOX] [Hana ID sandbox-test] ${subject}`);
      expect(r.text).toMatch(new RegExp(`Change:\\s+${row.replace(/[()]/gu, '\\$&')}\n`, 'u'));
      expect(r.text).toMatch(/Proposed at:\s+11 November 2026, 05:01 UTC\n/u);
      expect(visibleText(r.html)).toContain(`Change${row}`);
      expect(visibleText(r.html)).toContain('Proposed at11 November 2026, 05:01 UTC');
      expect(r.text).not.toContain('2026-11-11T05:01');
      // Still a pending change with its cancel link; the email approves nothing.
      expect(r.text).toContain('It is not in force yet.');
      expect(r.text).toContain('If you did not expect this change, cancel it now. The page asks you to confirm; opening the link alone changes nothing.');
      expect([...r.html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1])).toEqual(['https://console.test/cancel/gc_7#t=abc']);
      // The heading is fixed words, never the app's name (D687's rule, D700).
      expect(r.html).toContain(`>${subject.replace(' for Dry Run App', '')}</h1>`);
      expect(r.html).not.toMatch(/approve this|accept this/iu);
    }
  });

  describe('the security notices partners receive: the designed layout (D700)', () => {
    const files = 'https://files.test';
    const c = { ...ctx, label: '[SANDBOX]', filesOrigin: files };
    const hostile = 'evil.example/login?x=1 <b>bold</b>';
    const app = { id: 'app_1', name: hostile, orgId: 'org_1', scopeId: 's1', environment: 'test' as const };
    const invite = { id: 'inv_1', email: 'new.owner@evil.example', orgId: 'org_1', role: 'owner', createdByKind: 'hana', createdBy: 'staff-sub', createdAt: Date.UTC(2026, 10, 11, 5), expiresAt: Date.UTC(2026, 10, 18, 5) } as never;
    const grant = { id: 'og_1', orgId: 'org_1', userId: 'usr_1', grantedByKind: 'member', grantedBy: 'usr_2', createdAt: Date.UTC(2026, 10, 11, 5) };
    const mails = {
      changePending: changePending(c, { change: { id: 'gc_1', appId: 'app_1', kind: 'origin_add', origin: 'http://localhost:5173', display: 'http://localhost:5173', idn: false, status: 'pending', proposedByKind: 'member', proposedBy: 'usr_1', proposedAt: Date.UTC(2026, 10, 11, 5, 1) } as never, contacts: [], app }, { cancelUrl: 'https://console.test/cancel/gc_1#t=abc', delayMs: 60_000 }),
      changePendingIdn: changePending(c, { change: { id: 'gc_2', appId: 'app_1', kind: 'origin_add', origin: 'https://xn--bcher-kva.example', display: 'https://bücher.example', idn: true, status: 'pending', proposedByKind: 'member', proposedBy: 'usr_1', proposedAt: 0 } as never, contacts: [], app }, { cancelUrl: 'https://console.test/cancel/gc_2#t=abc', delayMs: 60_000 }),
      inviteNotice: inviteNotice(c, invite, { orgName: hostile }),
      ownerGrantNotice: ownerGrantNotice(c, { kind: 'owner_grant', grant, member: { userId: 'usr_1', email: 'promoted@evil.example' }, owners: [] } as never, { orgName: hostile, cancelUrl: 'https://console.test/cancel-owner/og_1#t=abc', delayMs: 86_400_000 }),
      loginMethodsChanged: loginMethodsChanged(c, { seq: 1, at: Date.UTC(2026, 10, 11, 5), appId: 'app_1', orgId: 'org_1', scopeId: 's1', kind: 'app.settings', actorKind: 'member', actorId: 'usr_1', detail: { loginMethods: 'google,email' } } as never, { appName: hostile, undoUrl: 'https://console.test/orgs/org_1/apps/app_1/email' }),
      onChainPending: onChainPending(c, { scopeId: 's1', orgId: 'org_1', changeId: 7, change: { SetAllowShared: { allow: true } }, unlockAtMs: Date.UTC(2026, 10, 12, 5), currentOwners: [], activeOrigins: ['https://app.evil.example', 'http://localhost:5173'] }),
      policyLabelUrl: changePending(c, { change: { id: 'gc_3', appId: 'app_1', kind: 'policy_set', policyId: 'pol_1', status: 'pending', proposedByKind: 'member', proposedBy: 'usr_1', proposedAt: 0 } as never, contacts: [], app, policy: { label: 'Urgent: cancel at https://evil.example/cancel', rules: [{ contract: 'swap.evil.example', methods: ['swap'] }] } }, { cancelUrl: 'https://console.test/cancel/gc_3#t=abc', delayMs: 60_000 }),
      onChainUnknown: onChainPending(c, { scopeId: 's1', orgId: 'org_1', changeId: 8, change: { SomeFutureChange: { note: 'see https://evil.example/x?y=1' } }, unlockAtMs: Date.UTC(2026, 10, 12, 5), currentOwners: [] }),
      onChainChanged: onChainChanged(c, 's1', 'org_1', { owners: [], clients: [], allowShared: false }, { owners: [{ Oidc: { provider: 'google', sub: '123' } }], clients: [['google', 'x.apps.googleusercontent.com']], allowShared: true }),
    };
    const headings: Record<keyof typeof mails, string> = {
      changePending: 'New allowed origin proposed',
      changePendingIdn: 'New allowed origin proposed',
      policyLabelUrl: 'Auto-approve policy proposed',
      onChainUnknown: 'A change to your scope was proposed on chain',
      inviteNotice: 'A new owner was invited',
      ownerGrantNotice: 'Owner rights requested',
      loginMethodsChanged: 'Email login turned on',
      onChainPending: 'A change to your scope was proposed on chain',
      onChainChanged: 'Your scope changed on chain',
    };

    for (const [name, m] of Object.entries(mails) as [keyof typeof mails, ReturnType<typeof changePending>][]) {
      it(`${name}: the layout with a fixed heading, the banner, the logo, the footer; the text part faithful; no markup from names`, () => {
        expect(m.html).toContain('<html lang="en"');
        expect(m.html).toContain(`>${headings[name]}</h1>`);
        expect(m.html.match(/<h1/gu)).toHaveLength(1);
        // The title and heading never carry a partner's value.
        expect(m.html.match(/<title>[^<]*<\/title>/u)![0]).not.toMatch(/evil|bold/u);
        expect(visibleText(m.html)).toContain('[SANDBOX] Not production: this email is from Hana ID sandbox-test (testnet), for testing.');
        expect(visibleText(m.html)).toContain('Hana never asks you to approve anything from an email.');
        expect(m.text).toContain('Hana never asks you to approve anything from an email.');
        // The only image is the hosted logo; no script; links only to the console, at most the one button.
        expect([...m.html.matchAll(/src="([^"]*)"/gu)].map((x) => x[1])).toEqual([`${files}${MAIL_LOGO_PATH}`]);
        expect(m.html).not.toMatch(/<script|<form|javascript:/iu);
        const hrefs = [...m.html.matchAll(/href="([^"]*)"/gu)].map((x) => x[1]!);
        expect(hrefs.length).toBeLessThanOrEqual(1);
        for (const h of hrefs) expect(h.startsWith('https://console.test/')).toBe(true);
        // No markup from a partner's value, and no host or URL in one text node a client could link.
        expect(m.html).not.toContain('<b>bold</b>');
        for (const textNode of m.html.split(/<[^>]+>/u)) expect(textNode, name).not.toMatch(/evil&#46;example|evil\.example|localhost:5173\/|localhost&#58;/u);
        // Every paragraph sentence of the text part is in the HTML part (D670's rule).
        const html = visibleText(m.html);
        for (const para of m.text.split('\n\n').filter((p) => !/^[A-Za-z ]+:\s{1,}/u.test(p) && !p.includes('\n- ') && !p.startsWith('- ') && !/:\n/u.test(p))) expect(html, para).toContain(para.replace(/\s+/gu, ' ').trim());
      });
    }

    it('the action is the one cancel button where there is one, and the page confirms: opening the link alone changes nothing', () => {
      for (const [m, label] of [
        [mails.changePending, 'Cancel this change'],
        [mails.ownerGrantNotice, 'Cancel the owner grant'],
      ] as const) {
        expect(m.html).toContain(`>${label}</a>`);
        expect(visibleText(m.html)).toContain('opening the link alone changes nothing');
        expect(m.text).toContain('opening the link alone changes nothing');
      }
      expect(visibleText(mails.changePending.html)).toContain('It is not in force yet.');
      expect(mails.inviteNotice.html).not.toContain('href=');
      expect(mails.onChainPending.html).not.toContain('href=');
    });

    it('the origin and every value stay readable text: the localhost origin, an IDN warning, times in words', () => {
      const text = visibleText(mails.changePending.html);
      expect(text).toContain('Originhttp://localhost:5173');
      expect(text).toContain('Proposed at11 November 2026, 05:01 UTC');
      expect(visibleText(mails.changePendingIdn.html)).toContain('Warning: This origin is an internationalised domain name. Its ASCII form is https://xn--bcher-kva.example;');
      expect(visibleText(mails.inviteNotice.html)).toContain('Expires18 November 2026, 05:00 UTC');
      expect(visibleText(mails.inviteNotice.html)).toContain('Invitednew.owner@evil.example');
      expect(visibleText(mails.onChainPending.html)).toContain('https://app.evil.example');
      expect(visibleText(mails.onChainPending.html)).toContain('Can execute from12 November 2026, 05:00 UTC');
    });

    it('a URL in a policy label or an unknown on-chain change is shown in the JSON as text, never one linkable node (D700)', () => {
      for (const m of [mails.policyLabelUrl, mails.onChainUnknown]) {
        const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/u.exec(m.html)![1]!;
        expect(visibleText(pre)).toMatch(/https:\/\/evil\.example\/(cancel|x\?y=1)/u);
        for (const node of pre.split(/<[^>]+>/u)) expect(node).not.toMatch(/evil\.example|https:\/\//u);
        expect((m.html.match(/href="/gu) ?? []).length).toBeLessThanOrEqual(1);
      }
    });

  });

  describe('the feed digests: the designed layout (D704)', () => {
    const files = 'https://files.test';
    const c = { ...ctx, label: '[SANDBOX]', filesOrigin: files };
    const at = Date.parse('2026-11-11T05:01:36.861Z');
    // A partner's own text reaches a digest through a row's details, an audit target and an actor id.
    const hostileName = 'evil.example/login?x=1 <b>bold</b>';
    const HOSTILE_ID = 'https://evil.example/usr?x=1#y';
    const urlDetail = { name: hostileName, note: 'Urgent: cancel at https://evil.example/cancel?x=1#y', origin: 'http://localhost:5173' };
    const change = (i: number, extra: Record<string, unknown> = {}) =>
      ({ seq: i + 1, at: at + i * 60_000, orgId: 'org_1', appId: 'app_1', kind: 'origin.added', detail: urlDetail, actorKind: 'member', actorId: 'usr_1', requestId: `req_${i}`, ...extra }) as never;
    const audit = (i: number, extra: Record<string, unknown> = {}) =>
      ({ seq: i + 1, at: at + i * 60_000, actorKind: 'member', actorId: 'usr_1', orgId: 'org_1', action: 'member.invite', target: hostileName, details: urlDetail, requestId: `req_${i}`, outcome: 'ok', ...extra }) as never;
    const event = (i: number, extra: Record<string, unknown> = {}) =>
      ({ id: `se_${i}`, detectedAt: at + i * 60_000, kind: 'drift', orgId: 'org_1', appId: 'app_1', scopeId: 's1', detail: urlDetail, ...extra }) as never;
    const mails = {
      changesDigest: changesDigest(c, 'org_1', [change(0), change(1, { kind: 'org.security_contacts', appId: undefined, actorKind: 'hana', actorId: 'staff-sub', detail: { old: ['a@evil.example'], new: ['b@evil.example'] } })]),
      auditDigest: auditDigest(c, 'org_1', [audit(0), audit(1, { outcome: 'failed', target: undefined, details: {} })]),
      auditDigestNoOrg: auditDigest(c, null, [audit(0, { orgId: undefined })]),
      securityDigest: securityDigest(c, 'org_1', [event(0), event(1, { kind: 'breaker', scopeId: undefined })]),
      securityDigestOne: securityDigest(c, null, [event(0, { orgId: undefined, appId: undefined, scopeId: undefined, kind: 'home_budget_high', detail: { derives: 400 } })]),
      // Every field value hostile: an actor id and a scope id shaped like origins (each field must be unlinked).
      changesHostileFields: changesDigest(c, 'org_1', [change(0, { actorId: HOSTILE_ID, appId: 'evil.example/app' })]),
      auditHostileFields: auditDigest(c, 'org_1', [audit(0, { actorId: HOSTILE_ID, outcome: 'evil.example/ok' })]),
      securityHostileFields: securityDigest(c, 'org_1', [event(0, { scopeId: HOSTILE_ID, appId: 'evil.example/app', id: 'se_evil.example' })]),
    };
    const headings: Record<keyof typeof mails, string> = {
      changesDigest: 'Changes to your apps',
      auditDigest: 'Console activity',
      auditDigestNoOrg: 'Console activity',
      securityDigest: 'Security events were recorded',
      securityDigestOne: 'A security event was recorded',
      changesHostileFields: 'A change to your apps',
      auditHostileFields: 'Console activity',
      securityHostileFields: 'A security event was recorded',
    };

    for (const [name, m] of Object.entries(mails) as [keyof typeof mails, ReturnType<typeof changesDigest>][]) {
      it(`${name}: the layout with a fixed heading, the banner, the logo, the footer and no link; no markup or linkable text from a partner's values`, () => {
        expect(m.html).toContain('<html lang="en"');
        expect(m.html).toContain(`>${headings[name]}</h1>`);
        expect(m.html.match(/<h1/gu)).toHaveLength(1);
        expect(m.html.match(/<title>[^<]*<\/title>/u)![0]).toBe(`<title>${headings[name]}</title>`);
        expect(visibleText(m.html)).toContain('[SANDBOX] Not production: this email is from Hana ID sandbox-test (testnet), for testing.');
        expect(visibleText(m.html)).toContain('Hana never asks you to approve anything from an email.');
        expect(m.text).toContain('Hana never asks you to approve anything from an email.');
        expect([...m.html.matchAll(/src="([^"]*)"/gu)].map((x) => x[1])).toEqual([`${files}${MAIL_LOGO_PATH}`]);
        expect(m.html).not.toMatch(/<script|<form|javascript:/iu);
        // The plain digests link nowhere; the designed ones add no link either.
        expect(m.html).not.toMatch(/href=|<a /u);
        // No markup from a partner's value (a name, a target), and no host, URL or address in one text node.
        expect(m.html).not.toContain('<b>bold</b>');
        for (const textNode of m.html.split(/<[^>]+>/u)) expect(textNode, name).not.toMatch(/evil&#46;example|evil\.example|localhost:5173\/|https?:\/\//u);
        // Every paragraph of the text part (not the row lines) is in the HTML part.
        const html = visibleText(m.html);
        for (const para of m.text.split('\n\n').filter((p) => !p.startsWith('- '))) expect(html, para).toContain(para.replace(/\s+/gu, ' ').trim());
      });
    }

    it('the text part keeps each row on one line as before (ISO time, codes, JSON); the HTML reads it in words with the code kept (D704)', () => {
      const ch = mails.changesDigest;
      expect(ch.subject).toBe('[SANDBOX] [Hana ID sandbox-test] 2 app changes in org_1');
      expect(ch.text).toContain(`- 2026-11-11T05:01:36.861Z origin.added on app_1 by member usr_1 ${JSON.stringify(urlDetail)}\n`);
      expect(ch.text).toContain('- 2026-11-11T05:02:36.861Z org.security_contacts by hana staff-sub {"old":["a@evil.example"],"new":["b@evil.example"]}\n');
      const chHtml = visibleText(ch.html);
      // The title in words, its code under it, the time in words, the details as the console's Audit page reads them.
      for (const fact of ['Origin addedorigin.addedWhen 11 November 2026, 05:01 UTCBy a console member (usr_1)App app_1', `name: ${hostileName} · note: Urgent: cancel at https://evil.example/cancel?x=1#y · origin: http://localhost:5173`, 'Security contacts replacedorg.security_contactsWhen 11 November 2026, 05:02 UTCBy Hana staff (staff-sub)old: a@evil.example · new: b@evil.example']) expect(chHtml, fact).toContain(fact);
      // The exact time and the JSON stay in the text part only.
      expect(chHtml).not.toContain('2026-11-11T05:01:36.861Z');
      expect(chHtml).not.toContain(JSON.stringify(urlDetail));
      const au = mails.auditDigest;
      expect(au.subject).toBe('[SANDBOX] [Hana ID sandbox-test] 2 console events in org_1');
      expect(au.text).toContain(`- 2026-11-11T05:01:36.861Z member.invite ${hostileName} by member usr_1 (ok) ${JSON.stringify(urlDetail)}\n`);
      expect(au.text).toContain('- 2026-11-11T05:02:36.861Z member.invite by member usr_1 (failed)\n');
      const auHtml = visibleText(au.html);
      for (const fact of [`Member invitedmember.inviteWhen 11 November 2026, 05:01 UTCBy a console member (usr_1)About ${hostileName}Outcome succeededname: ${hostileName} · note: Urgent: cancel at https://evil.example/cancel?x=1#y · origin: http://localhost:5173`, 'Member invitedmember.inviteWhen 11 November 2026, 05:02 UTCBy a console member (usr_1)Outcome failedEnd of']) expect(auHtml, fact).toContain(fact);
      expect(mails.auditDigestNoOrg.subject).toBe('[SANDBOX] [Hana ID sandbox-test] 1 console event');
      const se = mails.securityDigest;
      expect(se.subject).toBe('[SANDBOX] [Hana ID sandbox-test] Security events: drift, breaker in org_1');
      expect(se.text).toContain(`- 2026-11-11T05:01:36.861Z drift (se_0) app app_1 scope s1 ${JSON.stringify(urlDetail)}\n`);
      const seHtml = visibleText(se.html);
      for (const fact of [`App setting in force without a noticedrift · se_0When 11 November 2026, 05:01 UTCApp app_1Scope s1name: ${hostileName} · note: Urgent: cancel at https://evil.example/cancel?x=1#y · origin: http://localhost:5173`, 'Too many destructive changes in an hourbreaker · se_1When 11 November 2026, 05:02 UTCApp app_1name:']) expect(seHtml, fact).toContain(fact);
      expect(visibleText(mails.securityDigestOne.html)).toContain('Hana Home daily budget running highhome_budget_high · se_0When 11 November 2026, 05:01 UTCderives: 400');
      // One entry per row, each with its When line.
      expect(se.html.match(/>When</gu)).toHaveLength(2);
      expect(mails.securityDigestOne.subject).toBe('[SANDBOX] [Hana ID sandbox-test] Security event: home_budget_high');
      // The row count is said before the rows and after them, in both parts (D704).
      const said: [ReturnType<typeof changesDigest>, string, string][] = [
        [ch, "2 changes were made to the apps of org_1. They are already in force or done; nothing here needs an answer unless you didn't expect it.", 'End of the 2 rows.'],
        [mails.changesHostileFields, "1 change was made to the apps of org_1. It is already in force or done; nothing here needs an answer unless you didn't expect it.", 'End of the 1 row.'],
        [au, '2 console events: members, invites and organisation settings changed in org_1:', 'End of the 2 rows.'],
        [mails.auditDigestNoOrg, '1 console event: members, invites and organisation settings changed:', 'End of the 1 row.'],
        [se, 'The API recorded these 2 security events:', 'End of the 2 rows.'],
        [mails.securityDigestOne, 'The API recorded this security event:', 'End of the 1 row.'],
      ];
      for (const [m, intro, end] of said) {
        expect(m.text).toContain(`\n\n${intro}\n\n- `);
        expect(m.text).toMatch(new RegExp(`\n- [^\n]*\n\n${end.replace('.', '\\.')}\n\n`, 'u'));
        const v = visibleText(m.html);
        expect(v).toContain(intro);
        expect(v.indexOf(end)).toBeGreaterThan(v.lastIndexOf('When '));
        expect(v).not.toContain('not shown here');
      }
      // The security digest's last line is for partners and staff alike: no internal path (D704).
      for (const m of [se, mails.securityDigestOne]) {
        const last = 'Hana security receives every security event too and has a recovery playbook for each kind. To ask about one, reply to this email or write to your Hana contact.';
        expect(m.text).toContain(last);
        expect(visibleText(m.html)).toContain(last);
        expect(`${m.text}${m.html}`).not.toContain('playbooks.md');
      }
    });

    it('details in words as the console reads them (D703): times as dates (a bad one raw), nulls dropped, yes and no, lists and objects as text; at most 400 characters', () => {
      const t = Date.UTC(2026, 10, 11, 5, 5);
      const w = changesDigest(c, 'org_1', [change(0, { kind: 'change.announced', detail: { changeId: 'gc_1', activeFrom: t, endedAt: 9e15, policyId: null, waived: true, origins: [{ changeId: 'gc_2', origin: 'https://a.example' }], tags: [] } })]);
      const words = visibleText(/<div class="hm-ink2"[^>]*>([\s\S]*?)<\/div>/u.exec(w.html)![1]!);
      expect(words).toBe('change id: gc_1 · active from: 11 November 2026, 05:05 UTC · ended at: 9000000000000000 · waived: yes · origins: change id: gc_2, origin: https://a.example · tags: none');
      expect(visibleText(w.html)).toContain('Change announcedchange.announced');
      // The text part keeps the JSON as before.
      expect(w.text).toContain(`"activeFrom":${t},"endedAt":9000000000000000,"policyId":null`);
    });

    it('the HTML part shows at most 400 characters of a row’s details, as the text part', () => {
      const m = changesDigest(c, 'org_1', [change(0, { detail: { label: 'x'.repeat(1000) } })]);
      const detail = /<div class="hm-ink2"[^>]*>([\s\S]*?)<\/div>/u.exec(m.html)![1]!;
      expect(visibleText(detail)).toBe(`label: ${'x'.repeat(393)}`);
      expect(visibleText(detail)).toHaveLength(400);
      expect(m.text).toContain(` {"label":"${'x'.repeat(390)}\n`);
    });

    it('cuts never leave half a surrogate pair (emoji at the 400-character cut and at oneLine’s); well-formed text is cut as before', () => {
      const lone = /[\uD800-\uDFFF]/u;
      // `{"l":"` is 6 units: after 393 x the cut at 400 falls inside the first emoji's pair, after 394 just before it.
      for (const pad of [393, 394]) {
        const m = changesDigest(c, 'org_1', [change(0, { detail: { l: `${'x'.repeat(pad)}${'😀'.repeat(5)}` } })]);
        expect(m.text, String(pad)).not.toMatch(lone);
        expect(m.html, String(pad)).not.toMatch(lone);
      }
      expect(cut(`${'a'.repeat(399)}😀`, 400)).toBe('a'.repeat(399));
      expect(cut(`${'a'.repeat(398)}😀`, 400)).toBe(`${'a'.repeat(398)}😀`);
      expect(cut(`a${String.fromCharCode(0xd83d)}b`, 10)).toBe('ab');
      expect(oneLine(`${'a'.repeat(198)}😀😀`, 200)).toBe(`${'a'.repeat(198)}…`);
      // Well-formed text the cut doesn't split: exactly what slice gave before.
      expect(oneLine(`${'a'.repeat(197)}😀bb`, 200)).toBe(`${'a'.repeat(197)}😀…`);
      expect(oneLine('W'.repeat(256), 200)).toBe(`${'W'.repeat(199)}…`);
      expect(oneLine('Acme 😀 Labs')).toBe('Acme 😀 Labs');
    });

    it('a row time that is not a valid one is shown raw and flagged in both parts; the other rows and the digest still render (D704)', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const bad of [Number.NaN, 8.64e15 + 1, 1e300]) {
        const flag = `not a valid time: ${String(bad)}`;
        for (const m of [changesDigest(c, 'org_1', [change(0, { at: bad }), change(1)]), auditDigest(c, 'org_1', [audit(0, { at: bad }), audit(1)]), securityDigest(c, 'org_1', [event(0, { detectedAt: bad }), event(1)])]) {
          expect(m.text).toContain(`- ${flag} `);
          expect(visibleText(m.html)).toContain(`When ${flag}`);
          // The good row is untouched.
          expect(m.text).toContain('- 2026-11-11T05:02:36.861Z ');
          expect(visibleText(m.html)).toContain('When 11 November 2026, 05:02 UTC');
        }
      }
      // Logged at error level as a count, never the value or the row: exactly these keys.
      const lines = error.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
      expect(lines).toHaveLength(9);
      expect(lines.map((l) => l.step)).toEqual(Array(3).fill(['app_changes', 'audit_log', 'security_events']).flat());
      for (const l of lines) {
        expect(Object.keys(l).sort()).toEqual(['at', 'count', 'event', 'level', 'orgId', 'step']);
        expect(l).toMatchObject({ level: 'error', event: 'digest_bad_time', orgId: 'org_1', count: 1 });
      }
      error.mockClear();
      auditDigest(c, null, [audit(0, { orgId: undefined, at: Number.NaN }), audit(1, { orgId: undefined, at: Number.NaN })]);
      const noOrg = JSON.parse(String(error.mock.calls[0]![0])) as Record<string, unknown>;
      expect(Object.keys(noOrg).sort()).toEqual(['at', 'count', 'event', 'level', 'step']);
      expect(noOrg).toMatchObject({ step: 'audit_log', count: 2 });
      expect(rowTime(Date.UTC(2026, 10, 18, 4, 54))).toEqual({ text: '2026-11-18T04:54:00Z', valid: true });
      expect(rowTime('1700000000000')).toEqual({ text: 'not a valid time: 1700000000000', valid: false });
      // The blocking notices still refuse to render (fail closed, D700).
      expect(() => readableTime(Number.NaN)).toThrow(RangeError);
    });

    it('50 rows (a feed page, the most one digest holds) with details at the 400-character cap stay under Gmail’s 102 KB clip', () => {
      const fat = (i: number) => ({ note: `see https://app.partner.example/settings?tab=origins&id=${i}#top and https://docs.partner.example/a/b/c.html`, origin: 'https://app.partner.example', label: 'x'.repeat(260) });
      const rows = Array.from({ length: FEED_PAGE }, (_, i) => i);
      for (const m of [changesDigest(c, 'org_1', rows.map((i) => change(i, { detail: fat(i) }))), auditDigest(c, 'org_1', rows.map((i) => audit(i, { target: 'inv_01jdnew', details: fat(i) }))), securityDigest(c, 'org_1', rows.map((i) => event(i, { detail: fat(i) })))]) {
        // Every row shown, none left out.
        expect(m.html.match(/>When</gu)).toHaveLength(FEED_PAGE);
        expect(new TextEncoder().encode(m.html).length).toBeLessThanOrEqual(DIGEST_HTML_BUDGET);
        expect(visibleText(m.html)).not.toContain('not shown here');
        expect(visibleText(m.html)).toContain('End of the 50 rows.');
      }
    });

    it('padded rows (details of dots or quotes, long delimiter-heavy targets) never push the HTML past the budget: the rows left out are counted and pointed to; the text part keeps all (D704)', () => {
      const rows = Array.from({ length: FEED_PAGE }, (_, i) => i);
      const target = `${'a.'.repeat(240)}@x.example`;
      const cases: [string, ReturnType<typeof changesDigest>, string][] = [
        ['dots', changesDigest(c, 'org_1', rows.map((i) => change(i, { detail: { label: '.'.repeat(400) } }))), "the console's Audit page"],
        ['quotes', changesDigest(c, 'org_1', rows.map((i) => change(i, { detail: { label: '"'.repeat(400) } }))), "the console's Audit page"],
        ['targets', auditDigest(c, 'org_1', rows.map((i) => audit(i, { target, details: { label: './'.repeat(200) } }))), "the console's Audit page"],
        ['events', securityDigest(c, 'org_1', rows.map((i) => event(i, { scopeId: target, detail: { label: '?='.repeat(200) } }))), 'ask Hana security (reply to this email)'],
      ];
      for (const [name, m, elsewhere] of cases) {
        expect(new TextEncoder().encode(m.html).length, name).toBeLessThanOrEqual(DIGEST_HTML_BUDGET);
        const shown = (m.html.match(/>When</gu) ?? []).length;
        expect(shown, name).toBeGreaterThan(0);
        expect(shown, name).toBeLessThan(FEED_PAGE);
        const left = FEED_PAGE - shown;
        const v = visibleText(m.html);
        expect(v, name).toContain(`${left} more ${left === 1 ? 'row is' : 'rows are'} not shown here: see the plain-text part of this email or ${elsewhere}.`);
        expect(v, name).toContain('End of the 50 rows.');
        // The note comes after the last row shown, before the end line; the footer is still there.
        expect(v.indexOf('not shown here'), name).toBeGreaterThan(v.lastIndexOf('When '));
        expect(v.indexOf('End of the 50 rows.'), name).toBeGreaterThan(v.indexOf('not shown here'));
        expect(v, name).toContain('Hana never asks you to approve anything from an email.');
        // The text part has every row.
        expect(m.text.split('\n').filter((l) => l.startsWith('- ')), name).toHaveLength(FEED_PAGE);
        expect(m.text, name).toContain('End of the 50 rows.');
        expect(m.text, name).not.toContain('not shown here');
        // One entry per row shown.
        expect(m.html.match(/<td class="hm-ink hm-line"/gu), name).toHaveLength(shown);
      }
    });

    it('an empty digest still renders (the feed never sends one)', () => {
      const d = changesDigest(c, 'org_1', []);
      expect(d.html).toContain('>Changes to your apps</h1>');
      expect(d.html).not.toContain('>When<');
      expect(d.text).toContain('End of the 0 rows.');
    });
  });

  describe('mails that stay plain', () => {
    it('the statement notice and the staff alerts keep the plain HTML (D674, D700, D704)', () => {
      const r = retentionFailed(ctx, { kind: 'overdue', month: '2026-10', dueAt: Date.UTC(2026, 10, 1, 3), latest: null });
      expect(r.html.startsWith('<!doctype html><html><body>')).toBe(true);
      expect(r.html).not.toContain('<h1');
      const s = statementIssued(ctx, { orgId: 'org_1', orgName: 'Acme', month: '2026-10', asOf: Date.UTC(2026, 10, 1), csvSha256: 'a'.repeat(64), pdfSha256: null });
      expect(s.html.startsWith('<!doctype html><html><body>')).toBe(true);
    });
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
    // The expiry as a person reads it, in the body and the preview line; never the raw ISO timestamp.
    expect(r.text).toContain('The invitation expires on 17 November 2026, 09:00 UTC.');
    expect(r.html).toContain('Join Sodax Labs in the Hana ID partner console. The invitation expires on 17 November 2026, 09:00 UTC.');
    expect(`${r.text}${r.html}`).not.toContain('2026-11-17T09');
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

  it('readable times (`18 November 2026, 04:54 UTC`) in sentences and partner notices; ISO for staff tables; both refuse an invalid time', () => {
    const t = Date.parse('2026-11-18T04:54:59.777Z');
    expect(readableTime(t)).toBe('18 November 2026, 04:54 UTC');
    expect(readableTime(Date.UTC(2027, 0, 1, 0, 5))).toBe('1 January 2027, 00:05 UTC');
    expect(isoTime(t)).toBe('2026-11-18T04:54:59.777Z');
    expect(isoTime(Date.UTC(2026, 10, 18, 4, 54))).toBe('2026-11-18T04:54:00Z');
    // Fails closed, as isoTime always did: a mail with a time that isn't one is never rendered, so never sent.
    for (const bad of [Number.NaN, 8.64e15 + 1, 1e300, Number.POSITIVE_INFINITY]) {
      expect(() => readableTime(bad)).toThrow(RangeError);
      expect(() => isoTime(bad)).toThrow(RangeError);
    }
    const overdue = retentionFailed(ctx, { kind: 'overdue', month: '2026-10', dueAt: Date.UTC(2026, 10, 1, 3), latest: null });
    expect(overdue.text).toContain('The monthly retention job for 2026-10 was due at 1 November 2026, 03:00 UTC and no run has completed since.');
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
