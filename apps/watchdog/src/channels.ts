// Alert channels behind small interfaces (D85, D87): a paging app (ntfy, Pushover or PagerDuty, chosen at setup),
// Slack (incoming webhook), email (SendGrid, the watchdog's own key), and the dead-man's switch. Tests swap in doubles;
// nothing here is called with real credentials in tests. Errors never carry a URL, token or response body.
// Titles and texts carry on-chain strings (already allow-listed or escaped by `sanitize.ts` where they are built);
// each sender also makes the whole message safe for its format: no CR, LF or non-ASCII in a header or subject line,
// and Slack's `&`, `<`, `>` as entities.
import { sendgridSend } from '@hana-id/sendgrid';
import type { Channel, Severity } from './checks.ts';
import { type Env, alertEmails, pagerProvider } from './env.ts';
import { headerValue, slackEscape } from './sanitize.ts';

export type SendResult = { ok: true; ref?: string } | { ok: false; error: string };

export interface AlertMessage {
  alertId: number;
  severity: Severity;
  kind: string;
  /** One line, no secrets. Senders still strip line breaks and non-ASCII where it goes into a header. */
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
  /** Raw email for the daily digest (same SendGrid key and recipients). */
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

/**
 * One alert's subject: the severity and title first, so a phone's lock screen (which shows ~30 characters) says what
 * happened, and the env last.
 */
const subjectLine = (env: string, severity: Severity, title: string, resend = false) =>
  `${severity.toUpperCase()}${resend ? ' (re-sent)' : ''}: ${title} [Hana ID ${env}]`;

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
        body: JSON.stringify({ text: `*${slackEscape(headerValue(subjectLine(envName, msg.severity, msg.title, msg.resend), 550))}*\n${slackEscape(msg.text)}` }),
      });
      const f = failed(res);
      if (f) return f;
      const r = res as Response;
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    },
  };
}

// ---- Email (SendGrid, D87, D401) ----

/** The SendGrid category of the watchdog's mail (never one of the email issuer's, whose webhook acts on its own). */
export const WATCHDOG_CATEGORY = 'hana-id-watchdog';

/**
 * Through the shared SendGrid adapter, with the watchdog's own Mail-Send-only key: accepted only on SendGrid's 202
 * (D87: a send counts only when the provider accepts it). Each recipient gets its own copy; SendGrid has no
 * idempotency key, so a send retried after a lost answer may arrive twice (D401).
 */
export function sendgridEmail(apiKey: string | undefined, from: string): Email & { configured: boolean } {
  return {
    configured: !!apiKey,
    async send({ to, subject, text }) {
      if (!apiKey) return notConfigured;
      if (to.length === 0) return { ok: false, error: 'no recipients' };
      // The adapter's own timeout is this file's TIMEOUT_MS (10 s); it never puts the key, a body or an address in r.
      const r = await sendgridSend(apiKey, from, { to, subject, text, category: WATCHDOG_CATEGORY });
      if (r.ok) return r.messageId ? { ok: true, ref: r.messageId } : { ok: true };
      return { ok: false, error: r.status !== undefined ? `HTTP ${r.status}` : r.reason === 'unavailable' ? 'network error or timeout' : r.reason };
    },
  };
}

export function emailSender(email: Email & { configured: boolean }, to: string[], envName: string): Sender {
  return {
    channel: 'email',
    configured: email.configured && to.length > 0,
    send: (msg) =>
      email.send({ to, subject: headerValue(subjectLine(envName, msg.severity, msg.title, msg.resend), 250), text: msg.text }),
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
        // An HTTP header: CR/LF and non-ASCII removed (fetch would throw on them, and the page would never go out).
        title: headerValue(subjectLine(envName, msg.severity, msg.title), 250),
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
        title: headerValue(subjectLine(envName, msg.severity, msg.title), 250),
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
          payload: { summary: headerValue(subjectLine(envName, msg.severity, msg.title), 1024), source: `hana-id-watchdog-${envName}`, severity: msg.severity === 'critical' ? 'critical' : 'warning', custom_details: { text: msg.text } },
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
  const email = sendgridEmail(env.SENDGRID_API_KEY, env.ALERT_FROM);
  return {
    pager,
    slack: slackSender(env.SLACK_WEBHOOK_URL, env.ENV_NAME),
    email: emailSender(email, to, env.ENV_NAME),
    digest: { configured: email.configured && to.length > 0, send: (subject, text) => email.send({ to, subject, text }) },
    heartbeat: heartbeatPinger(env.HEARTBEAT_URL),
  };
}
