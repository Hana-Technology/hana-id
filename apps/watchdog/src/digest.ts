// The daily digest (D85 "info: admin portal + daily digest"): one email a day, after DIGEST_HOUR_UTC, summarising
// the runs, every alert (info ones included) and every action since the last digest.
import type { Notifier } from './channels.ts';
import { log } from './log.ts';
import { printable } from './sanitize.ts';
import type { Store } from './store.ts';

const DAY_MS = 24 * 60 * 60_000;

export interface DigestState {
  /** UTC date (YYYY-MM-DD) of the last digest sent. */
  date: string;
  at: number;
}

export type DigestOutcome = 'sent' | 'not_due' | 'not_configured' | 'failed';

export async function digestText(store: Store, since: number, now: number, envName: string): Promise<string> {
  const runs = await store.runsSince(since);
  const alerts = await store.alertsSince(since);
  const actions = await store.actionsSince(since);
  const open = (await store.openAlerts()).filter((a) => a.severity === 'critical' && a.acked_at === null);
  const count = (o: string) => runs.filter((r) => r.outcome === o).length;
  const lines = [
    `Hana ID watchdog, env ${envName}: ${new Date(since).toISOString()} to ${new Date(now).toISOString()}`,
    '',
    `Runs: ${runs.length} (ok ${count('ok')}, degraded ${count('degraded')}, error ${count('error')})`,
    `Unacknowledged critical alerts: ${open.length}${open.length ? ` (${open.map((a) => `#${a.id}`).join(', ')})` : ''}`,
    '',
    `Alerts (${alerts.length}):`,
    ...alerts.map((a) => `  #${a.id} [${a.severity}] ${printable(a.title)}${a.acked_at ? ` (acked by ${printable(String(a.acked_by))} via ${a.acked_via})` : ''}`),
    '',
    `Actions (${actions.length}):`,
    ...actions.map((a) => `  #${a.id} ${a.method} ${printable(JSON.stringify(a.args))}: ${a.ok ? 'ok' : 'failed'}${a.tx_hash ? ` tx ${a.tx_hash}` : ''} (${a.reason})`),
  ];
  return lines.join('\n');
}

export async function maybeSendDigest(store: Store, notifier: Notifier, now: number, hourUtc: number, envName: string): Promise<DigestOutcome> {
  const date = new Date(now).toISOString().slice(0, 10);
  if (new Date(now).getUTCHours() < hourUtc) return 'not_due';
  const last = await store.getMeta<DigestState>('digest');
  if (last?.date === date) return 'not_due';
  if (!notifier.digest.configured) return 'not_configured';
  const since = last?.at ?? now - DAY_MS;
  const text = await digestText(store, since, now, envName);
  const res = await notifier.digest.send(`[Hana ID ${envName}] Watchdog daily digest ${date}`, text).catch(() => ({ ok: false as const, error: 'threw' }));
  await store.recordDelivery({ alertId: null, channel: 'email', kind: 'digest', at: now, ok: res.ok, error: res.ok ? null : res.error });
  if (!res.ok) {
    log({ event: 'digest', outcome: 'error', channel: 'email' }, 'warn');
    return 'failed';
  }
  await store.setMeta('digest', { date, at: now } satisfies DigestState);
  return 'sent';
}
