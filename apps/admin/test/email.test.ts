// EmailSender's Resend adapter (accepted only on 2xx with a message id; the idempotency key; nothing of the key or the
// answer in an error) and the rendering rules (escaped partner text, one-line subjects, links only to the console
// origin, no remote image).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changePending } from '../src/email/messages.ts';
import { consoleLink, oneLine, render } from '../src/email/render.ts';
import { RESEND_URL, resendSender } from '../src/email/sender.ts';
import { Budget, linkKey, recipients, sendToAll } from '../src/mail.ts';
import { FakeEmail } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const msg = { to: 'a@partner.example', subject: 's', text: 't', html: '<p>t</p>', idempotencyKey: 'k1' };

describe('the Resend adapter', () => {
  it('posts one message with the key, the from and the idempotency key; accepted with the id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ id: 'msg-123' });
    });
    expect(await resendSender('re_key', 'Hana ID <notices@mail.hana.example>').send(msg)).toEqual({ ok: true, id: 'msg-123' });
    expect(calls[0]!.url).toBe(RESEND_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_key');
    expect(headers['idempotency-key']).toBe('k1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: 'Hana ID <notices@mail.hana.example>', to: ['a@partner.example'], subject: 's', text: 't', html: '<p>t</p>' });
  });

  it('anything but 2xx with an id is a failure, whose text carries the status only', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response('{"message":"a@partner.example is invalid","key":"re_key"}', { status: 422 }),
      () => new Response('oops', { status: 500 }),
      () => Response.json({}),
      () => new Response('not json', { status: 200 }),
      () => Promise.reject(new TypeError('network')),
    ];
    for (const a of answers) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => a());
      const r = await resendSender('re_key', 'x@mail.hana.example').send(msg);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/re_key|partner\.example|invalid/u);
      vi.restoreAllMocks();
    }
    expect(await resendSender(undefined, 'x@mail.hana.example').send(msg)).toEqual({ ok: false, error: 'not configured' });
  });
});

describe('sending to many', () => {
  it('one message per recipient, every one tried; all accepted or not; the budget is checked first', async () => {
    const fake = new FakeEmail();
    fake.failFor.add('b@x.example');
    const r = await sendToAll(fake, new Budget(10), ['a@x.example', 'b@x.example', 'c@x.example'], { subject: 's', text: 't', html: 'h' }, 'p');
    expect(r).toEqual({ allAccepted: false, sent: 2, failed: 1, outOfBudget: false });
    expect(fake.attempts.map((m) => m.to)).toEqual(['a@x.example', 'b@x.example', 'c@x.example']);
    expect(new Set(fake.attempts.map((m) => m.idempotencyKey)).size).toBe(3);
    expect(JSON.stringify(fake.attempts.map((m) => m.idempotencyKey))).not.toContain('@');
    const tight = new FakeEmail();
    expect(await sendToAll(tight, new Budget(2), ['a@x.example', 'b@x.example', 'c@x.example'], { subject: 's', text: 't', html: 'h' }, 'p')).toMatchObject({ allAccepted: false, outOfBudget: true });
    expect(tight.attempts).toEqual([]);
    expect((await sendToAll(new FakeEmail(), new Budget(5), [], { subject: 's', text: 't', html: 'h' }, 'p')).allAccepted).toBe(false);
    expect(recipients(['A@x.example ', 'a@x.example'], 'b@x.example', undefined, [''])).toEqual(['a@x.example', 'b@x.example']);
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
