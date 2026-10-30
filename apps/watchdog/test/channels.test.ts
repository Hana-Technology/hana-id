// The channel adapters' requests, against a stubbed fetch (no real send). Credentials here are throwaway strings.
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
  RESEND_URL,
  resendEmail,
  emailSender,
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

describe('Email (Resend)', () => {
  it('sends with the watchdog’s own key and counts it only when Resend returns an id', async () => {
    const calls = stubFetch(() => Response.json({ id: 'msg_1' }));
    const email = emailSender(resendEmail('re_throwaway_key', 'alerts@notify.example.com'), ['a@example.com', 'b@example.com'], 'sandbox-test');
    expect(await email.send(msg({ resend: true }))).toEqual({ ok: true, ref: 'msg_1' });
    expect(calls[0]?.url).toBe(RESEND_URL);
    expect(calls[0]?.headers.authorization).toBe('Bearer re_throwaway_key');
    expect(JSON.parse(calls[0]!.body)).toEqual({ from: 'alerts@notify.example.com', to: ['a@example.com', 'b@example.com'], subject: 'CRITICAL (re-sent): Forged key k9 [Hana ID sandbox-test]', text: 'kid: k9' });
  });

  it('fails on a 2xx without an id, and on an error status', async () => {
    stubFetch(() => Response.json({}));
    expect(await resendEmail('re_k', 'a@b.co').send({ to: ['x@y.co'], subject: 's', text: 't' })).toEqual({ ok: false, error: 'no message id in the answer' });
    vi.restoreAllMocks();
    stubFetch(() => new Response('', { status: 422 }));
    expect(await resendEmail('re_k', 'a@b.co').send({ to: ['x@y.co'], subject: 's', text: 't' })).toEqual({ ok: false, error: 'HTTP 422' });
  });

  it('is unconfigured without a key or without recipients', () => {
    expect(emailSender(resendEmail(undefined, 'a@b.co'), ['x@y.co'], 'e').configured).toBe(false);
    expect(emailSender(resendEmail('re_k', 'a@b.co'), [], 'e').configured).toBe(false);
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
    const calls = stubFetch(() => Response.json({ id: 'm' }));
    const n = notifierFromEnv({ ...base, PAGER_PROVIDER: 'ntfy', RESEND_API_KEY: 're_k' });
    expect(n.email.configured).toBe(true);
    await n.digest.send('digest', 'body');
    expect(JSON.parse(calls[0]!.body).to).toEqual(['a@example.com', 'b@example.com']);
  });
});
