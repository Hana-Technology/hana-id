// The channel adapters' requests, against a stubbed fetch (no real send). Credentials here are throwaway strings.
import { SENDGRID_URL } from '@hana-id/sendgrid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AlertMessage,
  heartbeatPinger,
  notifierFromEnv,
  ntfyPager,
  PAGERDUTY_EVENTS_URL,
  pagerDutyPager,
  PUSHOVER_EXPIRE_S,
  PUSHOVER_MESSAGES_URL,
  PUSHOVER_RETRY_S,
  pushoverPager,
  WATCHDOG_CATEGORY,
  emailSender,
  sendgridEmail,
  slackSender,
} from '../src/channels.ts';
import type { Env } from '../src/env.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(reply: (call: Call) => Response | Promise<Response> = () => new Response('ok')): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '';
    const call = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    return reply(call);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

const msg = (over: Partial<AlertMessage> = {}): AlertMessage => ({ alertId: 7, severity: 'critical', kind: 'forged_key_change', title: 'Forged key k9', text: 'kid: k9', resend: false, ...over });

describe('Slack', () => {
  it('posts the title and text to the webhook', async () => {
    const calls = stubFetch();
    const res = await slackSender('https://hooks.slack.com/services/T/B/secret1', 'sandbox-test').send(msg());
    expect(res).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://hooks.slack.com/services/T/B/secret1');
    expect(JSON.parse(calls[0]!.body).text).toBe('*CRITICAL: Forged key k9 [Hana ID sandbox-test]*\nkid: k9');
  });

  it('reports the HTTP status, never the URL', async () => {
    stubFetch(() => new Response('no', { status: 404 }));
    const res = await slackSender('https://hooks.slack.com/services/T/B/secret1', 'e').send(msg());
    expect(res).toEqual({ ok: false, error: 'HTTP 404' });
  });

  it('is unconfigured without a webhook and sends nothing', async () => {
    const calls = stubFetch();
    const s = slackSender(undefined, 'e');
    expect(s.configured).toBe(false);
    expect(await s.send(msg())).toEqual({ ok: false, error: 'not configured' });
    expect(calls).toEqual([]);
  });

  it('turns a network failure into an error without the URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed https://hooks.slack.com/services/T/B/secret1'));
    expect(await slackSender('https://hooks.slack.com/services/T/B/secret1', 'e').send(msg())).toEqual({ ok: false, error: 'network error or timeout' });
  });
});

describe('Email (SendGrid, D401)', () => {
  const KEY = 'SG.throwaway-watchdog-key.throwaway-secret-not-real-0123456789';

  it('sends with the watchdog’s own key, one copy per founder, tracking off; counts it only on a 202', async () => {
    const calls = stubFetch(() => new Response(null, { status: 202, headers: { 'x-message-id': 'msg_1' } }));
    const email = emailSender(sendgridEmail(KEY, 'Hana ID watchdog <alerts@notify.example.com>'), ['a@example.com', 'b@example.com'], 'sandbox-test');
    expect(await email.send(msg({ resend: true }))).toEqual({ ok: true, ref: 'msg_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SENDGRID_URL);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0]!.body) as Record<string, any>;
    expect(body.personalizations).toEqual([{ to: [{ email: 'a@example.com' }] }, { to: [{ email: 'b@example.com' }] }]);
    expect(body.from).toEqual({ email: 'alerts@notify.example.com', name: 'Hana ID watchdog' });
    expect(body.subject).toBe('CRITICAL (re-sent): Forged key k9 [Hana ID sandbox-test]');
    expect(body.content).toEqual([{ type: 'text/plain', value: 'kid: k9' }]);
    expect(body.categories).toEqual([WATCHDOG_CATEGORY]);
    expect(body.tracking_settings.click_tracking).toEqual({ enable: false, enable_text: false });
    // A 202 without the message id header is accepted too (SendGrid queued it).
    vi.restoreAllMocks();
    stubFetch(() => new Response(null, { status: 202 }));
    expect(await sendgridEmail(KEY, 'a@b.co').send({ to: ['x@y.co'], subject: 's', text: 't' })).toEqual({ ok: true });
  });

  it('fails on any other status or a network error, naming the status only', async () => {
    for (const [status, body] of [[200, '{}'], [400, '{"errors":[{"message":"x@y.co is bad"}]}'], [401, ''], [429, ''], [500, 'oops']] as const) {
      stubFetch(() => new Response(body || null, { status }));
      const r = await sendgridEmail(KEY, 'a@b.co').send({ to: ['x@y.co'], subject: 's', text: 't' });
      expect(r).toEqual({ ok: false, error: `HTTP ${status}` });
      vi.restoreAllMocks();
    }
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(`fetch failed ${KEY}`));
    expect(await sendgridEmail(KEY, 'a@b.co').send({ to: ['x@y.co'], subject: 's', text: 't' })).toEqual({ ok: false, error: 'network error or timeout' });
  });

  it('is unconfigured without a key or without recipients, and then fetches nothing', async () => {
    const calls = stubFetch();
    expect(emailSender(sendgridEmail(undefined, 'a@b.co'), ['x@y.co'], 'e').configured).toBe(false);
    expect(emailSender(sendgridEmail(KEY, 'a@b.co'), [], 'e').configured).toBe(false);
    expect(await sendgridEmail(undefined, 'a@b.co').send({ to: ['x@y.co'], subject: 's', text: 't' })).toEqual({ ok: false, error: 'not configured' });
    expect(await sendgridEmail(KEY, 'a@b.co').send({ to: [], subject: 's', text: 't' })).toEqual({ ok: false, error: 'no recipients' });
    expect(calls).toEqual([]);
  });
});

describe('paging apps', () => {
  it('ntfy: urgent priority for critical, bearer token when set', async () => {
    const calls = stubFetch();
    expect(await ntfyPager('https://ntfy.example.com/topic-abcdefghijklmnop', 'tk_throwaway', 'e').send(msg())).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: 'https://ntfy.example.com/topic-abcdefghijklmnop', method: 'POST', body: 'kid: k9' });
    expect(calls[0]?.headers).toMatchObject({ priority: 'urgent', authorization: 'Bearer tk_throwaway', title: 'CRITICAL: Forged key k9 [Hana ID e]' });
  });

  it('Pushover: emergency priority with retry and expire, and the receipt as reference', async () => {
    const calls = stubFetch(() => Response.json({ status: 1, receipt: 'rcpt123' }));
    const p = pushoverPager('a'.repeat(30), 'u'.repeat(30), 'e');
    expect(await p.send(msg())).toEqual({ ok: true, ref: 'rcpt123' });
    expect(calls[0]?.url).toBe(PUSHOVER_MESSAGES_URL);
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toMatchObject({ priority: '2', retry: String(PUSHOVER_RETRY_S), expire: String(PUSHOVER_EXPIRE_S), user: 'u'.repeat(30), title: 'CRITICAL: Forged key k9 [Hana ID e]' });
  });

  it('Pushover: reads acknowledgements from the receipt', async () => {
    stubFetch((c) => (c.url.includes('/receipts/rcpt123.json') ? Response.json({ status: 1, acknowledged: 1, acknowledged_by_device: 'phone-a' }) : new Response('', { status: 404 })));
    const p = pushoverPager('a'.repeat(30), 'u'.repeat(30), 'e');
    expect(await p.acknowledged!('rcpt123')).toEqual({ by: 'pushover:phone-a' });
    vi.restoreAllMocks();
    stubFetch(() => Response.json({ status: 1, acknowledged: 0 }));
    expect(await p.acknowledged!('rcpt123')).toBeNull();
  });

  it('Pushover: refuses an answer without status 1', async () => {
    stubFetch(() => Response.json({ status: 0 }));
    expect(await pushoverPager('a'.repeat(30), 'u'.repeat(30), 'e').send(msg())).toEqual({ ok: false, error: 'Pushover refused the message' });
  });

  it('PagerDuty: a trigger event with a stable dedup key per alert', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ status: 'success' }), { status: 202 }));
    expect(await pagerDutyPager('r'.repeat(32), 'sandbox-test').send(msg())).toEqual({ ok: true, ref: 'hana-id-watchdog-sandbox-test-7' });
    expect(calls[0]?.url).toBe(PAGERDUTY_EVENTS_URL);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ routing_key: 'r'.repeat(32), event_action: 'trigger', dedup_key: 'hana-id-watchdog-sandbox-test-7', payload: { severity: 'critical', source: 'hana-id-watchdog-sandbox-test' } });
  });
});

describe('heartbeat', () => {
  it('GETs the ping URL with no cache', async () => {
    const calls = stubFetch();
    expect(await heartbeatPinger('https://hc-ping.example.com/uuid-1').ping()).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: 'https://hc-ping.example.com/uuid-1', method: 'GET' });
    vi.restoreAllMocks();
    stubFetch(() => new Response('', { status: 500 }));
    expect(await heartbeatPinger('https://hc-ping.example.com/uuid-1').ping()).toEqual({ ok: false, error: 'HTTP 500' });
  });
});

describe('notifierFromEnv', () => {
  const base = { ENV_NAME: 'e', ALERT_EMAILS: 'a@example.com, b@example.com', ALERT_FROM: 'alerts@notify.example.com' } as unknown as Env;

  it('picks the configured paging app', () => {
    expect(notifierFromEnv({ ...base, PAGER_PROVIDER: 'pushover', PUSHOVER_TOKEN: 'x', PUSHOVER_USER: 'y' }).pager).toMatchObject({ provider: 'pushover', configured: true });
    expect(notifierFromEnv({ ...base, PAGER_PROVIDER: 'pagerduty' }).pager).toMatchObject({ provider: 'pagerduty', configured: false });
    expect(notifierFromEnv({ ...base, PAGER_PROVIDER: 'ntfy', NTFY_TOPIC_URL: 'https://ntfy.example.com/t' }).pager).toMatchObject({ provider: 'ntfy', configured: true });
    expect(notifierFromEnv({ ...base, PAGER_PROVIDER: 'sms' }).pager).toMatchObject({ provider: 'sms', configured: false });
  });

  it('sends email to every recipient', async () => {
    const calls = stubFetch(() => new Response(null, { status: 202 }));
    const n = notifierFromEnv({ ...base, PAGER_PROVIDER: 'ntfy', SENDGRID_API_KEY: 'SG.k' });
    expect(n.email.configured).toBe(true);
    expect(await n.digest.send('digest', 'body')).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(SENDGRID_URL);
    expect(JSON.parse(calls[0]!.body).personalizations).toEqual([{ to: [{ email: 'a@example.com' }] }, { to: [{ email: 'b@example.com' }] }]);
  });
});
