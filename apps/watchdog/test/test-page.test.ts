// The test critical page (D449, readiness 5.4): the bearer gate, the dry run, one send per channel reported honestly,
// no alert or dedupe state left behind, the cooldown, and the real wiring (each provider's request, no secret leaked).
import { env } from 'cloudflare:workers';
import { SENDGRID_URL } from '@hana-id/sendgrid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverAlerts } from '../src/alerts.ts';
import { type Env, alertLabel, SECRET_NAMES } from '../src/env.ts';
import worker from '../src/index.ts';
import { handleRequest } from '../src/status.ts';
import { Store } from '../src/store.ts';
import { TEST_PAGE_COOLDOWN_MS, TEST_PAGE_TITLE } from '../src/test-page.ts';
import { alertsOf, initialized, jwk, MIN, NO_GRACE, RecordingNotifier, T0 } from './helpers.ts';

const TOKEN = 'status-token-for-tests-only-0123456789abcdef';
const testEnv = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), WATCHDOG_STATUS_TOKEN: TOKEN, ...over });

function req(method: string, token: string | null = TOKEN): Request {
  return new Request('https://watchdog.test/test-page', { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
}

async function call(method: string, n: RecordingNotifier, opts: { now?: number; token?: string | null; env?: Env; store?: Store } = {}) {
  const res = await handleRequest(req(method, opts.token === undefined ? TOKEN : opts.token), { env: opts.env ?? testEnv(), store: opts.store ?? new Store(env.DB), notifier: n, now: () => opts.now ?? T0 });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const deliveryCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first<{ n: number }>())!.n;

describe('who can call it', () => {
  it('refuses a missing or wrong bearer token and sends nothing, on GET and POST', async () => {
    const n = new RecordingNotifier();
    for (const method of ['GET', 'POST']) {
      expect((await call(method, n, { token: null })).status).toBe(401);
      expect((await call(method, n, { token: 'wrong-token-wrong-token-wrong-token-1234' })).status).toBe(401);
    }
    expect(n.sent).toEqual([]);
  });

  it('fails closed without a long enough token configured', async () => {
    const n = new RecordingNotifier();
    expect((await call('POST', n, { env: testEnv({ WATCHDOG_STATUS_TOKEN: undefined }) })).status).toBe(503);
    expect((await call('POST', n, { token: 'short', env: testEnv({ WATCHDOG_STATUS_TOKEN: 'short' }) })).status).toBe(503);
    expect(n.sent).toEqual([]);
  });

  it('answers 405 to any other method', async () => {
    const n = new RecordingNotifier();
    for (const method of ['PUT', 'DELETE', 'PATCH']) expect((await call(method, n)).status).toBe(405);
    expect(n.sent).toEqual([]);
  });
});

describe('GET /test-page (the dry run)', () => {
  it('lists the critical channels and sends nothing', async () => {
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    const { status, body } = await call('GET', n, { env: testEnv({ ALERT_EMAILS: 'a@test.example, b@test.example' }) });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      dry_run: true,
      severity: 'critical',
      channels: [
        { channel: 'pager', configured: true, provider: 'stub' },
        { channel: 'slack', configured: false },
        { channel: 'email', configured: true, recipients: 2 },
      ],
      cooldown_ms: TEST_PAGE_COOLDOWN_MS,
      next_allowed_at: null,
    });
    expect(body.title).toContain(TEST_PAGE_TITLE);
    expect(n.sent).toEqual([]);
  });

  it('shows no email address, only the count', async () => {
    const { body } = await call('GET', new RecordingNotifier(), { env: testEnv({ ALERT_EMAILS: 'a@test.example' }) });
    expect(JSON.stringify(body)).not.toContain('a@test.example');
  });

  it('does not start the cooldown, however often it runs', async () => {
    const n = new RecordingNotifier();
    await call('GET', n);
    await call('GET', n);
    expect((await call('POST', n)).status).toBe(200);
    expect(n.sent).toHaveLength(3);
  });

  it('says when the next send is allowed after a send', async () => {
    const n = new RecordingNotifier();
    await call('POST', n, { now: T0 });
    expect((await call('GET', n, { now: T0 + MIN })).body.next_allowed_at).toBe(T0 + TEST_PAGE_COOLDOWN_MS);
    expect((await call('GET', n, { now: T0 + TEST_PAGE_COOLDOWN_MS })).body.next_allowed_at).toBe(null);
  });
});

describe('POST /test-page (the send)', () => {
  it('sends one critical message on every critical channel, titled TEST and no action needed', async () => {
    const n = new RecordingNotifier();
    const { status, body } = await call('POST', n);
    expect(status).toBe(200);
    expect(body).toMatchObject({ sent: true, ok: true, results: [{ channel: 'pager', provider: 'stub', ok: true }, { channel: 'slack', ok: true }, { channel: 'email', ok: true }] });
    expect(n.sent.map((s) => s.channel)).toEqual(['pager', 'slack', 'email']);
    for (const { msg } of n.sent) {
      expect(msg).toMatchObject({ severity: 'critical', kind: 'test_page', resend: false });
      expect(msg.title).toMatch(/^TEST /u);
      expect(msg.title.toLowerCase()).toContain('no action needed');
      expect(msg.text).toContain('NO ACTION NEEDED');
      expect(msg.alertId).toBeLessThan(0);
    }
  });

  it('reports each channel as its provider answered; one failing does not stop the others or read as success', async () => {
    const n = new RecordingNotifier();
    n.failing.add('slack');
    n.throwing.add('email');
    const { status, body } = await call('POST', n);
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      { channel: 'pager', provider: 'stub', ok: true },
      { channel: 'slack', ok: false, error: 'HTTP 500' },
      { channel: 'email', ok: false, error: 'channel threw' },
    ]);
    expect(n.sent.map((s) => s.channel)).toEqual(['pager']);
  });

  it('counts a channel with no credentials as failed, not skipped', async () => {
    const n = new RecordingNotifier();
    n.unconfigured.add('pager');
    const { body } = await call('POST', n);
    expect(body.ok).toBe(false);
    expect((body.results as { channel: string; ok: boolean }[])[0]).toMatchObject({ channel: 'pager', ok: false });
  });

  it('allows one send per cooldown, reports how long is left, and sends nothing while it runs', async () => {
    const n = new RecordingNotifier();
    expect((await call('POST', n, { now: T0 })).status).toBe(200);
    n.clear();
    const again = await call('POST', n, { now: T0 + MIN });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: 'test_page_cooldown', retry_after_ms: TEST_PAGE_COOLDOWN_MS - MIN });
    expect(n.sent).toEqual([]);
    expect((await call('POST', n, { now: T0 + TEST_PAGE_COOLDOWN_MS })).status).toBe(200);
    expect(n.sent).toHaveLength(3);
  });

  it('sends once when two requests race', async () => {
    const n = new RecordingNotifier();
    const statuses = (await Promise.all([call('POST', n), call('POST', n)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429]);
    expect(n.sent).toHaveLength(3);
  });
});

describe('it is not an alert (D449)', () => {
  it('leaves no alert, delivery or anything to acknowledge or re-send', async () => {
    const store = new Store(env.DB);
    const n = new RecordingNotifier();
    await call('POST', n, { store });
    expect(await alertsOf(store)).toEqual([]);
    expect(await store.openAlerts()).toEqual([]);
    expect(await store.alertsToDeliver()).toEqual([]);
    expect(await deliveryCount()).toBe(0);
    n.clear();
    expect(await deliverAlerts(store, n, T0 + 20 * MIN, 'sandbox-test')).toMatchObject({ first: 0, resent: 0 });
    expect(n.sent).toEqual([]);
  });

  it('does not look like a first run or an earlier run to the watchdog', async () => {
    const store = new Store(env.DB);
    await call('POST', new RecordingNotifier(), { store });
    expect(await store.getMeta('initialized_at')).toBe(null);
    expect(await store.lastRun()).toBe(null);
  });

  it('a real critical alert right after a test page still pages on every channel', async () => {
    const w = await initialized();
    w.notifier.clear();
    await call('POST', w.notifier, { store: w.store, now: w.clock.t });
    expect(w.notifier.sent).toHaveLength(3);
    w.notifier.clear();
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66), ...NO_GRACE });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    await w.run();
    const real = await alertsOf(w.store, 'forged_key_change');
    expect(real).toHaveLength(1);
    const paged = w.notifier.sent.filter((s) => s.msg.alertId === real[0]!.id);
    expect(paged.map((s) => s.channel).sort()).toEqual(['email', 'pager', 'slack']);
    expect(paged[0]!.msg.title).not.toContain('TEST');
  });

  it('a real alert raised before stays open and keeps its re-sends', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66), ...NO_GRACE });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    await w.run();
    const [real] = await alertsOf(w.store, 'forged_key_change');
    await call('POST', new RecordingNotifier(), { store: w.store, now: w.clock.t });
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([real]);
    expect((await w.store.openAlerts()).map((a) => a.id)).toContain(real!.id);
  });
});

describe('the real wiring', () => {
  const SECRETS = {
    WATCHDOG_STATUS_TOKEN: TOKEN,
    SENDGRID_API_KEY: 'SG.key-for-tests-only.0123456789abcdefghijklmnopqrstuv',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/webhookfortestsonly',
    NTFY_TOPIC_URL: 'https://ntfy.example.com/topicfortestsonly01',
    NTFY_TOKEN: 'tk_tokenfortestsonly',
    PUSHOVER_TOKEN: 'pushovertokenfortestsonly00000',
    PUSHOVER_USER: 'pushoveruserfortestsonly000000',
    PAGERDUTY_ROUTING_KEY: 'routingkeyfortestsonly0000000000',
    HEARTBEAT_URL: 'https://hc-ping.example.com/heartbeatfortestsonly',
  } satisfies Partial<Record<(typeof SECRET_NAMES)[number], string>>;

  interface Post {
    url: string;
    body: string;
    headers: Headers;
  }

  /** Every provider behind one fetch; `answer` overrides the answer per URL. Captures every console line too. */
  function net(answer: (url: string) => Response | null = () => null) {
    const posts: Post[] = [];
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      posts.push({ url, body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? ''), headers: new Headers(init?.headers) });
      return answer(url) ?? (url === SENDGRID_URL ? new Response(null, { status: 202, headers: { 'x-message-id': 'email-1' } }) : url.includes('pushover') ? Response.json({ status: 1, receipt: 'r1' }) : new Response('ok'));
    });
    return { posts, lines };
  }

  const wired = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), ...SECRETS, ALERT_EMAILS: 'founder-a@test.example,founder-b@test.example', ALERT_FROM: 'alerts@test.example', ...over });
  const http = (method: string, e: Env, token: string | null = TOKEN) => worker.fetch(req(method, token), e);

  afterEach(() => vi.restoreAllMocks());

  it('ntfy, Slack and email: critical priority, the label, TEST first, every channel called', async () => {
    const e = wired({ PAGER_PROVIDER: 'ntfy' });
    const { posts } = net();
    const res = await http('POST', e);
    expect(res.status).toBe(200);
    const label = alertLabel(e);
    const title = `${label ? `${label} ` : ''}CRITICAL: ${TEST_PAGE_TITLE} [Journear Passport ${e.ENV_NAME}]`;
    const ntfy = posts.find((p) => p.url === SECRETS.NTFY_TOPIC_URL)!;
    expect(ntfy.headers.get('title')).toBe(title);
    expect(ntfy.headers.get('priority')).toBe('urgent');
    expect(ntfy.body).toContain('NO ACTION NEEDED');
    expect(JSON.parse(posts.find((p) => p.url === SECRETS.SLACK_WEBHOOK_URL)!.body)).toMatchObject({ text: expect.stringContaining('NO ACTION NEEDED') });
    const mail = JSON.parse(posts.find((p) => p.url === SENDGRID_URL)!.body) as { personalizations: unknown[]; subject: string; content: { value: string }[] };
    expect(mail.subject).toBe(title);
    expect(mail.personalizations).toHaveLength(2);
    expect(mail.content[0]!.value).toContain('NO ACTION NEEDED');
    expect(mail.content[0]!.value).toContain('Nothing is wrong with Journear Passport.');
    expect(posts.map((p) => p.url)).not.toContain(SECRETS.HEARTBEAT_URL);
  });

  it('Pushover: emergency priority like a real critical page, and the message says how to stop the alarm', async () => {
    const { posts } = net();
    await http('POST', wired({ PAGER_PROVIDER: 'pushover' }));
    const form = new URLSearchParams(posts.find((p) => p.url.includes('pushover'))!.body);
    expect(form.get('priority')).toBe('2');
    expect(form.get('retry')).toBe('300');
    expect(form.get('expire')).toBe('900');
    expect(form.get('message')).toContain('acknowledge it in the app');
  });

  it("PagerDuty: a critical event whose dedup key can't equal a real alert's", async () => {
    const e = wired({ PAGER_PROVIDER: 'pagerduty' });
    const { posts } = net();
    await http('POST', e);
    const event = JSON.parse(posts.find((p) => p.url.includes('pagerduty'))!.body) as { event_action: string; dedup_key: string; payload: { severity: string } };
    expect(event).toMatchObject({ event_action: 'trigger', payload: { severity: 'critical' } });
    expect(event.dedup_key).toMatch(new RegExp(`^hana-id-watchdog-${e.ENV_NAME}--\\d+$`, 'u'));
  });

  it('reports a provider failure as its status, with no URL or token in the answer', async () => {
    const e = wired({ PAGER_PROVIDER: 'ntfy' });
    net((url) => (url === SECRETS.NTFY_TOPIC_URL ? new Response('rate limited', { status: 429 }) : null));
    const body = (await (await http('POST', e)).json()) as { ok: boolean; results: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.results[0]).toEqual({ channel: 'pager', provider: 'ntfy', ok: false, error: 'HTTP 429' });
  });

  it('an unconfigured channel says so without calling anyone', async () => {
    const e = wired({ PAGER_PROVIDER: 'ntfy', SLACK_WEBHOOK_URL: undefined });
    const { posts } = net();
    const body = (await (await http('POST', e)).json()) as { results: unknown[] };
    expect(body.results[1]).toEqual({ channel: 'slack', ok: false, error: 'not configured' });
    expect(posts.some((p) => p.url.includes('slack'))).toBe(false);
  });

  it('no secret or founder address in any answer or log line, on the dry run, the send or a failure', async () => {
    const e = wired({ PAGER_PROVIDER: 'ntfy' });
    const { lines } = net((url) => (url === SECRETS.SLACK_WEBHOOK_URL ? new Response('nope', { status: 500 }) : null));
    const answers = [await (await http('GET', e)).text(), await (await http('POST', e)).text(), await (await http('POST', e, 'wrong-token-wrong-token-wrong-token-1234')).text()];
    const everything = [...answers, ...lines].join('\n');
    for (const secret of [...Object.values(SECRETS), 'founder-a@test.example', 'founder-b@test.example']) expect(everything).not.toContain(secret);
  });

  it('unauthenticated, the real Worker sends nothing and leaves nothing', async () => {
    const e = wired({ PAGER_PROVIDER: 'ntfy' });
    const { posts } = net();
    expect((await http('POST', e, null)).status).toBe(401);
    expect(posts).toEqual([]);
    expect(await new Store(env.DB).getMeta('test_page')).toBe(null);
  });
});
