// EmailSender's SendGrid adapter (accepted only on 202; no idempotency header, SendGrid has none; nothing of the key,
// the answer or the address in an error; the admin category), sending to many (one message per recipient; a retry
// skips what this isolate saw accepted and never what it didn't, D401) and the rendering rules (escaped partner
// text, one-line subjects, links only to the console origin, no remote image).
import { SENDGRID_URL } from '@hana-id/sendgrid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changePending } from '../src/email/messages.ts';
import { consoleLink, oneLine, render } from '../src/email/render.ts';
import { ADMIN_CATEGORY, outbound, sendgridSender } from '../src/email/sender.ts';
import { ACCEPTED_MEMO_MS, Budget, forgetAccepted, linkKey, messageKey, recipients, sendToAll } from '../src/mail.ts';
import { FakeEmail } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const KEY = 'SG.fixture-admin-not-real.fixture-secret-not-real-0123456789abcd';
const msg = { to: 'a@partner.example', subject: 's', text: 't', html: '<p>t</p>', messageKey: 'k1' };
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
});
