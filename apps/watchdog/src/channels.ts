// Alert channels behind small interfaces (D85, D87): a paging app (ntfy, Pushover or PagerDuty, chosen at setup),
// Slack (incoming webhook), email (Resend, the watchdog's own key), and the dead-man's switch. Tests swap in doubles;
// nothing here is called with real credentials in tests. Errors never carry a URL, token or response body.
import type { Channel, Severity } from './checks.ts';
import { type Env, alertEmails, pagerProvider } from './env.ts';

export type SendResult = { ok: true; ref?: string } | { ok: false; error: string };

export interface AlertMessage {
  alertId: number;
  severity: Severity;
  kind: string;
  /** One line, no secrets. */
  title: string;
  /** Plain text body, no secrets. */
  text: string;
  /** True for the 15-minute re-sends. */
  resend: boolean;
}

export interface Sender {
  readonly channel: Channel;
  readonly configured: boolean;
  send(msg: AlertMessage): Promise<SendResult>;
}

export interface Pager extends Sender {
  readonly channel: 'pager';
  readonly provider: string;
  /** For apps with acknowledgements (Pushover receipts): who acknowledged the page `ref`, or null if nobody yet. */
  acknowledged?(ref: string): Promise<{ by: string } | null>;
}

export interface Email {
  send(message: { to: string[]; subject: string; text: string }): Promise<SendResult>;
}

export interface Heartbeat {
  readonly configured: boolean;
  ping(): Promise<SendResult>;
}

/** Everything the run sends through. */
export interface Notifier {
  pager: Pager;
  slack: Sender;
  email: Sender;
  /** Raw email for the daily digest (same Resend key and recipients). */
  digest: { configured: boolean; send(subject: string, text: string): Promise<SendResult> };
  heartbeat: Heartbeat;
}

const TIMEOUT_MS = 10_000;

/** fetch with a timeout; the error text names only the HTTP status (never the URL, which may carry a secret). */
async function post(url: string, init: RequestInit): Promise<Response | { error: string }> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { error: 'network error or timeout' };
  }
}

const failed = (r: Response | { error: string }): SendResult | null => ('error' in r && !(r instanceof Response) ? { ok: false, error: r.error } : null);

const notConfigured: SendResult = { ok: false, error: 'not configured' };

const subjectPrefix = (env: string, severity: Severity) => `[Hana ID ${env}] ${severity.toUpperCase()}`;

// ---- Slack ----

export function slackSender(webhookUrl: string | undefined, envName: string): Sender {
  return {
    channel: 'slack',
    configured: !!webhookUrl,
    async send(msg) {
      if (!webhookUrl) return notConfigured;
      const res = await post(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `*${subjectPrefix(envName, msg.severity)}${msg.resend ? ' (re-sent)' : ''}: ${msg.title}*\n${msg.text}` }),
      });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    },
  };
}

// ---- Email (Resend, D87) ----

export const RESEND_URL = 'https://api.resend.com/emails';

/** Accepted only when Resend answers 2xx with an id (D87: a send counts only when the provider accepts it). */
export function resendEmail(apiKey: string | undefined, from: string): Email & { configured: boolean } {
  return {
    configured: !!apiKey,
    async send({ to, subject, text }) {
      if (!apiKey) return notConfigured;
      if (to.length === 0) return { ok: false, error: 'no recipients' };
      const res = await post(RESEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to, subject, text }),
      });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = (await r.json().catch(() => null)) as { id?: unknown } | null;
      return typeof body?.id === 'string' ? { ok: true, ref: body.id } : { ok: false, error: 'no message id in the answer' };
    },
  };
}

export function emailSender(email: Email & { configured: boolean }, to: string[], envName: string): Sender {
  return {
    channel: 'email',
    configured: email.configured && to.length > 0,
    send: (msg) =>
      email.send({ to, subject: `${subjectPrefix(envName, msg.severity)}${msg.resend ? ' (re-sent)' : ''}: ${msg.title}`, text: msg.text }),
  };
}

// ---- Paging apps ----

export function ntfyPager(topicUrl: string | undefined, token: string | undefined, envName: string): Pager {
  return {
    channel: 'pager',
    provider: 'ntfy',
    configured: !!topicUrl,
    async send(msg) {
      if (!topicUrl) return notConfigured;
      const headers: Record<string, string> = {
        title: `${subjectPrefix(envName, msg.severity)}: ${msg.title}`.slice(0, 250),
        priority: msg.severity === 'critical' ? 'urgent' : 'default',
        tags: 'rotating_light',
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await post(topicUrl, { method: 'POST', headers, body: msg.text });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    },
  };
}

export const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json';
export const pushoverReceiptUrl = (receipt: string, token: string) => `https://api.pushover.net/1/receipts/${encodeURIComponent(receipt)}.json?token=${encodeURIComponent(token)}`;
/** Emergency priority: Pushover itself repeats the alarm every 5 min for 15 min; the watchdog re-pages after that. */
export const PUSHOVER_RETRY_S = 300;
export const PUSHOVER_EXPIRE_S = 900;

export function pushoverPager(token: string | undefined, user: string | undefined, envName: string): Pager {
  const configured = !!token && !!user;
  return {
    channel: 'pager',
    provider: 'pushover',
    configured,
    async send(msg) {
      if (!token || !user) return notConfigured;
      const form = new URLSearchParams({
        token,
        user,
        title: `${subjectPrefix(envName, msg.severity)}: ${msg.title}`.slice(0, 250),
        message: msg.text.slice(0, 1024),
        priority: msg.severity === 'critical' ? '2' : '0',
      });
      if (msg.severity === 'critical') {
        form.set('retry', String(PUSHOVER_RETRY_S));
        form.set('expire', String(PUSHOVER_EXPIRE_S));
      }
      const res = await post(PUSHOVER_MESSAGES_URL, { method: 'POST', body: form });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = (await r.json().catch(() => null)) as { status?: unknown; receipt?: unknown } | null;
      if (body?.status !== 1) return { ok: false, error: 'Pushover refused the message' };
      return typeof body.receipt === 'string' ? { ok: true, ref: body.receipt } : { ok: true };
    },
    async acknowledged(ref) {
      if (!token) return null;
      const res = await post(pushoverReceiptUrl(ref, token), { method: 'GET' });
      if (!(res instanceof Response) || !res.ok) return null;
      const body = (await res.json().catch(() => null)) as { acknowledged?: unknown; acknowledged_by_device?: unknown } | null;
      if (body?.acknowledged !== 1) return null;
      const device = typeof body.acknowledged_by_device === 'string' && /^[A-Za-z0-9_-]{1,25}$/u.test(body.acknowledged_by_device) ? body.acknowledged_by_device : 'unknown device';
      return { by: `pushover:${device}` };
    },
  };
}

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

/** PagerDuty Events API v2. Re-sends use the same dedup key, so they fold into one incident. Acks happen in PagerDuty. */
export function pagerDutyPager(routingKey: string | undefined, envName: string): Pager {
  return {
    channel: 'pager',
    provider: 'pagerduty',
    configured: !!routingKey,
    async send(msg) {
      if (!routingKey) return notConfigured;
      const dedupKey = `hana-id-watchdog-${envName}-${msg.alertId}`;
      const res = await post(PAGERDUTY_EVENTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routing_key: routingKey,
          event_action: 'trigger',
          dedup_key: dedupKey,
          payload: { summary: `${subjectPrefix(envName, msg.severity)}: ${msg.title}`.slice(0, 1024), source: `hana-id-watchdog-${envName}`, severity: msg.severity === 'critical' ? 'critical' : 'warning', custom_details: { text: msg.text } },
        }),
      });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      return r.status === 202 || r.ok ? { ok: true, ref: dedupKey } : { ok: false, error: `HTTP ${r.status}` };
    },
  };
}

// ---- Dead-man's switch ----

export function heartbeatPinger(url: string | undefined): Heartbeat {
  return {
    configured: !!url,
    async ping() {
      if (!url) return notConfigured;
      const res = await post(url, { method: 'GET', cache: 'no-store' });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    },
  };
}

/** The real channels from the Worker's secrets. An unknown PAGER_PROVIDER yields an unconfigured pager. */
export function notifierFromEnv(env: Env): Notifier {
  const provider = pagerProvider(env);
  const pager =
    provider === 'pushover'
      ? pushoverPager(env.PUSHOVER_TOKEN, env.PUSHOVER_USER, env.ENV_NAME)
      : provider === 'pagerduty'
        ? pagerDutyPager(env.PAGERDUTY_ROUTING_KEY, env.ENV_NAME)
        : provider === 'ntfy'
          ? ntfyPager(env.NTFY_TOPIC_URL, env.NTFY_TOKEN, env.ENV_NAME)
          : { ...ntfyPager(undefined, undefined, env.ENV_NAME), provider: env.PAGER_PROVIDER || 'none' };
  const to = alertEmails(env);
  const email = resendEmail(env.RESEND_API_KEY, env.ALERT_FROM);
  return {
    pager,
    slack: slackSender(env.SLACK_WEBHOOK_URL, env.ENV_NAME),
    email: emailSender(email, to, env.ENV_NAME),
    digest: { configured: email.configured && to.length > 0, send: (subject, text) => email.send({ to, subject, text }) },
    heartbeat: heartbeatPinger(env.HEARTBEAT_URL),
  };
}
