// SendGrid v3 Mail Send (D194, D401) against a mocked fetch: the request (key, one personalization per recipient,
// tracking off, the category), accepted only on 202, every other answer a failure by status, nothing of the key, the
// body or an address in a result, and a capped drain of the answer.
import { describe, expect, it } from 'vitest';
import { BYPASS_SUPPRESSIONS, SENDGRID_KEY_RE, SENDGRID_MAX_RECIPIENTS, SENDGRID_URL, classify, parseFrom, sendgridBody, sendgridSend, type SendGridMail } from '../src/index.ts';

const KEY = 'SG.fixture-key-not-real.fixture-secret-not-real-0123456789abcdef';
const FROM = 'Hana ID <notices@mail.hana.example>';
const mail: SendGridMail = { to: ['a@partner.example'], subject: 'Subject', text: 'Text', html: '<p>Text</p>', category: 'hana-id-admin' };

interface Seen {
  url: string;
  init: RequestInit;
}

function fake(reply: () => Response | Promise<Response>): { fetcher: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return reply();
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

describe('sendgridSend', () => {
  it('POSTs one v3 mail/send request with the key; accepted on 202, with the X-Message-Id', async () => {
    const { fetcher, seen } = fake(() => new Response(null, { status: 202, headers: { 'x-message-id': 'msg-1' } }));
    expect(await sendgridSend(KEY, FROM, mail, fetcher)).toEqual({ ok: true, messageId: 'msg-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(SENDGRID_URL);
    expect(seen[0]!.init.method).toBe('POST');
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    // No idempotency header: SendGrid has none (D401).
    expect(Object.keys(seen[0]!.init.headers as Record<string, string>).sort()).toEqual(['authorization', 'content-type']);
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(sendgridBody(FROM, mail));
    // A 202 without the header is still accepted (SendGrid queued it).
    const bare = fake(() => new Response(null, { status: 202 }));
    expect(await sendgridSend(KEY, FROM, mail, bare.fetcher)).toEqual({ ok: true, messageId: null });
  });

  it('the body: one personalization per recipient, both parts, the category, every tracking off', () => {
    const body = sendgridBody(FROM, { ...mail, to: ['a@x.example', 'b@x.example'] }) as Record<string, any>;
    expect(body.personalizations).toEqual([{ to: [{ email: 'a@x.example' }] }, { to: [{ email: 'b@x.example' }] }]);
    expect(body.from).toEqual({ email: 'notices@mail.hana.example', name: 'Hana ID' });
    expect(body.subject).toBe('Subject');
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'Text' },
      { type: 'text/html', value: '<p>Text</p>' },
    ]);
    expect(body.categories).toEqual(['hana-id-admin']);
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false }, ganalytics: { enable: false } });
    // Plain text only when there is no HTML part.
    const { html: _h, ...textOnly } = mail;
    expect((sendgridBody(FROM, textOnly) as Record<string, any>).content).toEqual([{ type: 'text/plain', value: 'Text' }]);
  });

  it('bypassSuppressions sets the three granular bypass filters, never bypass_list_management; without it no mail_settings at all', async () => {
    expect(BYPASS_SUPPRESSIONS).toEqual({ bypass_bounce_management: { enable: true }, bypass_spam_management: { enable: true }, bypass_unsubscribe_management: { enable: true } });
    const on = sendgridBody(FROM, { ...mail, bypassSuppressions: true }) as Record<string, any>;
    expect(on.mail_settings).toEqual(BYPASS_SUPPRESSIONS);
    // SendGrid refuses bypass_list_management combined with the granular filters; it is never sent.
    expect(JSON.stringify(on)).not.toContain('bypass_list_management');
    for (const m of [mail, { ...mail, bypassSuppressions: false }]) expect('mail_settings' in (sendgridBody(FROM, m) as Record<string, unknown>)).toBe(false);
    // On the wire too.
    const { fetcher, seen } = fake(() => new Response(null, { status: 202 }));
    await sendgridSend(KEY, FROM, { ...mail, bypassSuppressions: true }, fetcher);
    expect(JSON.parse(String(seen[0]!.init.body)).mail_settings).toEqual(BYPASS_SUPPRESSIONS);
  });

  it('every other answer is a failure, classified by status; nothing of the key, the body or the address in it', async () => {
    const cases: [number, string][] = [
      [200, 'rejected'],
      [204, 'rejected'],
      [400, 'rejected'],
      [413, 'rejected'],
      [401, 'misconfigured'],
      [403, 'misconfigured'],
      [429, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ];
    for (const [status, reason] of cases) {
      const body = status === 204 ? null : JSON.stringify({ errors: [{ message: `a@partner.example rejected for ${KEY}` }] });
      const { fetcher } = fake(() => new Response(body, { status }));
      const r = await sendgridSend(KEY, FROM, mail, fetcher);
      expect(r, String(status)).toEqual({ ok: false, reason, status });
      expect(JSON.stringify(r)).not.toMatch(/SG\.|partner\.example|rejected for/u);
    }
    expect(classify(418)).toEqual({ ok: false, reason: 'rejected', status: 418 });
  });

  it('a network error or a timeout is unavailable, without a status', async () => {
    const down = fake(() => Promise.reject(new TypeError(`connect failed ${KEY}`)));
    expect(await sendgridSend(KEY, FROM, mail, down.fetcher)).toEqual({ ok: false, reason: 'unavailable' });
    const timeout = fake(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
    expect(await sendgridSend(KEY, FROM, mail, timeout.fetcher)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('without a key, with no recipient or too many: nothing is fetched', async () => {
    const { fetcher, seen } = fake(() => new Response(null, { status: 202 }));
    expect(await sendgridSend(undefined, FROM, mail, fetcher)).toEqual({ ok: false, reason: 'misconfigured' });
    expect(await sendgridSend('', FROM, mail, fetcher)).toEqual({ ok: false, reason: 'misconfigured' });
    expect(await sendgridSend(KEY, FROM, { ...mail, to: [] }, fetcher)).toEqual({ ok: false, reason: 'rejected' });
    const many = Array.from({ length: SENDGRID_MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.example`);
    expect(await sendgridSend(KEY, FROM, { ...mail, to: many }, fetcher)).toEqual({ ok: false, reason: 'rejected' });
    expect(seen).toEqual([]);
  });

  it('drains at most 4 KB of the answer: a large or endless body is cancelled, the status still decides', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetcher } = fake(() => new Response(endless, { status: 400 }));
    expect(await sendgridSend(KEY, FROM, mail, fetcher)).toEqual({ ok: false, reason: 'rejected', status: 400 });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(6);
    const declared = fake(() => new Response('x'.repeat(100_000), { status: 202, headers: { 'content-length': '100000' } }));
    expect((await sendgridSend(KEY, FROM, mail, declared.fetcher)).ok).toBe(true);
  });
});

describe('parseFrom and the key shape', () => {
  it('splits a display name from the address; a bare address stays', () => {
    expect(parseFrom('Hana ID <team@hanawallet.example>')).toEqual({ email: 'team@hanawallet.example', name: 'Hana ID' });
    expect(parseFrom('<team@hanawallet.example>')).toEqual({ email: 'team@hanawallet.example' });
    expect(parseFrom('team@hanawallet.example')).toEqual({ email: 'team@hanawallet.example' });
  });

  it('SENDGRID_KEY_RE accepts SendGrid’s SG.<id>.<secret> shape only', () => {
    expect(SENDGRID_KEY_RE.test(KEY)).toBe(true);
    for (const bad of ['', 're_abcdefghijkl', 'SG.short.short', `${KEY}\n`, `Bearer ${KEY}`, 'SG.aaaaaaaaaaaaaaaaaaaaaa.bbb']) expect(SENDGRID_KEY_RE.test(bad), bad).toBe(false);
  });
});
