// The test critical page (D449, readiness 5.4): one labelled page, sent by the deployed Worker through the same senders,
// secrets and network path as a real critical alert, so a drill proves the path end to end. It is deliberately not an
// alert: no `alerts` or `deliveries` row, no dedupe key, no re-send, nothing to acknowledge. Only the cooldown's meta
// row is written (`Store.claimTestPage`). Route and auth: `status.ts`. Command: `admin <env> watchdog:test-page`.
import { sendSafe, senderFor } from './alerts.ts';
import { CHANNELS, type Channel } from './checks.ts';
import { type AlertMessage, type Notifier, subjectLine } from './channels.ts';
import { type Env, alertEmails, alertLabel } from './env.ts';
import { iso } from './time.ts';

/** Starts with TEST so a phone's lock screen (~30 characters, after `CRITICAL: `) says so before anything else. */
export const TEST_PAGE_TITLE = 'TEST (no action needed): paging check';
/** Not an `AlertKind`: this message never reaches the alert registry, the store or a playbook link. */
export const TEST_PAGE_KIND = 'test_page';
/** Between two sends, so a leaked status token or a loop can't ring phones at will; enough to fix a channel and retry. */
export const TEST_PAGE_COOLDOWN_MS = 5 * 60_000;

export type TestPageChannel = { channel: Channel; configured: boolean; provider?: string; recipients?: number };
export type TestPageResult = { channel: Channel; provider?: string; ok: boolean; error?: string };

export interface TestPagePlan {
  env: string;
  network: string;
  severity: 'critical';
  /** The title exactly as the channels show it (label, severity and env included). */
  title: string;
  text: string;
  channels: TestPageChannel[];
  cooldown_ms: number;
  /** When the next send is allowed; null when it is allowed now. */
  next_allowed_at: number | null;
}

/** What a critical page's own app does after the page, in the message so whoever gets it knows how to quiet it. */
function pagerNote(provider: string): string[] {
  if (provider === 'pushover') return ['Pushover repeats the alarm for up to 15 min: acknowledge it in the app to stop it.'];
  if (provider === 'pagerduty') return ['PagerDuty keeps this incident open: resolve it there.'];
  return [];
}

export function testPageText(envName: string, at: number, provider: string): string {
  return [
    'TEST PAGE. NO ACTION NEEDED. Nothing is wrong with Hana ID.',
    'Someone is checking that critical pages reach both founders: a drill, not an incident (docs/operations.md "Test page").',
    'It is not an alert: nothing to acknowledge in the admin portal, and the watchdog does not re-send it.',
    ...pagerNote(provider),
    `Tell whoever ran the test that it arrived. env ${envName}, sent ${iso(at)}`,
  ].join('\n');
}

/** What a send would do, from the Worker's own configuration. Booleans, a provider name and a count: never a secret or an address. */
export function testPagePlan(env: Env, notifier: Notifier, now: number, lastSentAt: number | null): TestPagePlan {
  const nextAt = lastSentAt === null ? null : lastSentAt + TEST_PAGE_COOLDOWN_MS;
  return {
    env: env.ENV_NAME,
    network: env.NEAR_NETWORK,
    severity: 'critical',
    title: subjectLine(env.ENV_NAME, 'critical', TEST_PAGE_TITLE, false, alertLabel(env)),
    text: testPageText(env.ENV_NAME, now, notifier.pager.provider),
    channels: CHANNELS.critical.map((channel): TestPageChannel => {
      const configured = senderFor(notifier, channel).configured;
      if (channel === 'pager') return { channel, configured, provider: notifier.pager.provider };
      if (channel === 'email') return { channel, configured, recipients: alertEmails(env).length };
      return { channel, configured };
    }),
    cooldown_ms: TEST_PAGE_COOLDOWN_MS,
    next_allowed_at: nextAt !== null && nextAt > now ? nextAt : null,
  };
}

/**
 * One send on every critical channel, each reported as its provider answered; a failing channel never blocks the others.
 * The id is negative so PagerDuty's dedup key (`…-<alertId>`) can never equal a real alert's (ids from 1 up): the test
 * opens its own incident and a real alert never folds into it. No retry: a failure is the finding.
 */
export async function sendTestPage(env: Env, notifier: Notifier, now: number): Promise<TestPageResult[]> {
  const msg: AlertMessage = { alertId: -now, severity: 'critical', kind: TEST_PAGE_KIND, title: TEST_PAGE_TITLE, text: testPageText(env.ENV_NAME, now, notifier.pager.provider), resend: false };
  return Promise.all(
    CHANNELS.critical.map(async (channel): Promise<TestPageResult> => {
      const r = await sendSafe(senderFor(notifier, channel), msg);
      return { channel, ...(channel === 'pager' ? { provider: notifier.pager.provider } : {}), ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
    }),
  );
}
