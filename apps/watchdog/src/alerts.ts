// Alert delivery (D85): first delivery on every channel of the alert's severity, retried until it succeeds (also
// after an acknowledgement: an ack never stops a first alert), re-sends of unacknowledged critical alerts every
// 15 min on every channel, and acknowledgements polled from the paging app. A failing channel never blocks the others.
// A channel with no credentials is not a failed send (D570): it is recorded once per alert and held, never retried
// while it stays unconfigured, and sent once it is configured if the alert is still open. The
// `channel_not_configured` alert is the signal for it.
import { alertPlaybook, CHANNELS, type Channel, RESEND_MS } from './checks.ts';
import { type AlertMessage, NOT_CONFIGURED, type Notifier, type Sender, type SendResult } from './channels.ts';
import { log } from './log.ts';
import { ident, printable } from './sanitize.ts';
import { iso } from './time.ts';
import type { AlertRow, Store } from './store.ts';

/** A 5-minute cron hits the 15-minute mark a little early or late; this much early still counts. */
export const RESEND_TOLERANCE_MS = 60_000;
/** Outstanding first deliveries of a non-critical alert are given up after this long (critical ones re-send anyway). */
export const FIRST_DELIVERY_GIVE_UP_MS = 24 * 60 * 60_000;

/** Fields never shown in alert texts: long key material (it stays in the alert's details). */
const HIDDEN_FIELDS = new Set(['n', 'e']);
/** Detail fields that hold an on-chain identifier: shown through the allow-list (`ident`). */
const IDENT_FIELDS = new Set(['kid', 'provider', 'by', 'op', 'public_key', 'account', 'chain_id', 'owner']);

const valueText = (v: unknown) => printable(typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));

/** One detail value, printable ASCII only: identifiers allow-listed, everything else escaped (`sanitize.ts`). */
function fieldText(key: string, value: unknown): string {
  if (IDENT_FIELDS.has(key) && typeof value === 'string') return ident(value);
  return valueText(value);
}

/**
 * One governance or config change as a readable line: lists as what was removed and added ("updater_keys: removed
 * ed25519:3PXt…"), anything else as "before -> after".
 */
function changeText(c: unknown): string {
  if (!c || typeof c !== 'object' || !('field' in c)) return valueText(c);
  const { field, before, after } = c as { field: unknown; before?: unknown; after?: unknown };
  const name = printable(String(field));
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = (x: unknown) => JSON.stringify(x);
    const was = new Set(before.map(key));
    const now = new Set(after.map(key));
    const removed = before.filter((x) => !now.has(key(x))).map(valueText);
    const added = after.filter((x) => !was.has(key(x))).map(valueText);
    const parts = [removed.length ? `removed ${removed.join(', ')}` : '', added.length ? `added ${added.join(', ')}` : ''].filter(Boolean);
    return `${name}: ${parts.length ? parts.join('; ') : 'reordered'}`;
  }
  return `${name}: ${valueText(before)} -> ${valueText(after)}`;
}

/**
 * Plain-text body of an alert: its details, the alert id, how to acknowledge, and its recovery playbook. Built from
 * public data only; every line is printable ASCII (on-chain strings can't add lines or control characters). A
 * `changes` list (governance and config changes) gets one readable line per change instead of its JSON.
 */
export function alertText(alert: Pick<AlertRow, 'id' | 'kind' | 'severity' | 'details' | 'created_at'>, envName: string): string {
  const lines = Object.entries(alert.details)
    .filter(([k]) => !HIDDEN_FIELDS.has(k))
    .flatMap(([k, v]) => (k === 'changes' && Array.isArray(v) ? v.map(changeText) : [`${printable(k)}: ${fieldText(k, v)}`]))
    .map((line) => line.slice(0, 600));
  lines.push(`alert: #${alert.id} (${alert.kind}, ${alert.severity}), env ${envName}, raised ${iso(alert.created_at)}`);
  if (alert.severity === 'critical') lines.push('Re-sent every 15 min until acknowledged (admin portal "Security & monitoring", or the paging app).');
  const playbook = alertPlaybook(alert.kind);
  if (playbook) lines.push(`Playbook: ${playbook} (admin portal "Security & monitoring" > Playbooks; docs/playbooks.md#${playbook})`);
  return lines.join('\n');
}

export const senderFor = (n: Notifier, c: Channel): Sender => (c === 'pager' ? n.pager : c === 'slack' ? n.slack : n.email);

export async function sendSafe(sender: Sender, msg: AlertMessage): Promise<SendResult> {
  try {
    return await sender.send(msg);
  } catch {
    return { ok: false, error: 'channel threw' };
  }
}

export interface DeliveryReport {
  first: number;
  resent: number;
  /** Sends a configured channel refused or lost (HTTP error, timeout, a throw). Never "not configured". */
  failed: number;
  ackedByPager: number;
  /** Channels newly held because they have no credentials: one `deliveries` row each, no retry. */
  notConfigured: number;
}

/** The `alert_delivery` check's detail. A held channel is named but is not an error. */
export const deliveryDetail = (r: DeliveryReport) =>
  `${r.first} first, ${r.resent} re-sent, ${r.failed} failed, ${r.ackedByPager} acked in the paging app${r.notConfigured ? `, ${r.notConfigured} held (channel not configured)` : ''}`;

export async function deliverAlerts(store: Store, notifier: Notifier, now: number, envName: string): Promise<DeliveryReport> {
  const report: DeliveryReport = { first: 0, resent: 0, failed: 0, ackedByPager: 0, notConfigured: 0 };
  for (const alert of await store.alertsToDeliver()) {
    // Paging-app acknowledgements (Pushover receipts) stop the re-sends like a portal ack.
    if (alert.severity === 'critical' && alert.acked_at === null && alert.pager_ref && notifier.pager.acknowledged) {
      const ack = await notifier.pager.acknowledged(alert.pager_ref).catch(() => null);
      if (ack && (await store.ack(alert.id, ack.by, 'pager', now))) {
        alert.acked_at = now;
        report.ackedByPager++;
        log({ event: 'alert_acked', alertId: alert.id, channel: 'pager' });
      }
    }
    const pending = alert.pending_channels;
    const held = alert.unconfigured_channels;
    const usable = (c: Channel) => senderFor(notifier, c).configured;
    // Still open: the condition holds, or it is critical and nobody acknowledged it. Only then is a held channel
    // sent once it gets credentials; a closed alert's held channel is left as it is.
    const open = alert.resolved_at === null || (alert.severity === 'critical' && alert.acked_at === null);
    const dueResend = alert.severity === 'critical' && alert.acked_at === null && alert.last_sent_at !== null && now - alert.last_sent_at >= RESEND_MS - RESEND_TOLERANCE_MS;
    if (!dueResend && pending.length > 0 && alert.severity !== 'critical' && now - alert.created_at > FIRST_DELIVERY_GIVE_UP_MS) {
      await store.clearPending(alert.id);
      log({ event: 'alert_delivery_given_up', alertId: alert.id, severity: alert.severity }, 'error');
      continue;
    }
    // First deliveries wanted now: the outstanding ones, and held ones whose channel has since been configured.
    const firsts = new Set<Channel>([...pending, ...(open ? held.filter(usable) : [])]);
    const wanted = dueResend ? [...new Set<Channel>([...CHANNELS.critical, ...firsts])] : [...firsts];
    const newlyHeld = wanted.filter((c) => !usable(c) && !held.includes(c));
    const targets = wanted.filter(usable).map((channel) => ({ channel, kind: firsts.has(channel) ? ('first' as const) : ('resend' as const) }));
    if (targets.length === 0 && newlyHeld.length === 0) continue;

    for (const channel of newlyHeld) {
      await store.recordDelivery({ alertId: alert.id, channel, kind: firsts.has(channel) ? 'first' : 'resend', at: now, ok: false, error: NOT_CONFIGURED });
      report.notConfigured++;
      log({ event: 'alert_delivery', alertId: alert.id, channel, outcome: 'skipped', code: 'not_configured' });
    }

    const base = { alertId: alert.id, severity: alert.severity, kind: alert.kind, title: alert.title, text: alertText(alert, envName) };
    const results = await Promise.all(targets.map(async (t) => ({ ...t, result: await sendSafe(senderFor(notifier, t.channel), { ...base, resend: t.kind === 'resend' || alert.send_count > 0 }) })));
    let pagerRef: string | null = null;
    for (const r of results) {
      await store.recordDelivery({ alertId: alert.id, channel: r.channel, kind: r.kind, at: now, ok: r.result.ok, error: r.result.ok ? null : r.result.error });
      if (r.result.ok) {
        if (r.kind === 'first') report.first++;
        else report.resent++;
        if (r.channel === 'pager' && r.result.ref) pagerRef = r.result.ref;
      } else {
        report.failed++;
        log({ event: 'alert_delivery', alertId: alert.id, channel: r.channel, outcome: 'error', code: r.result.error.slice(0, 60) }, 'warn');
      }
    }
    const stillPending = results.filter((r) => r.kind === 'first' && !r.result.ok).map((r) => r.channel);
    const stillHeld = [...held.filter((c) => !results.some((r) => r.channel === c)), ...newlyHeld];
    // Only a full round (the first one, or a re-send) restarts the 15-minute clock: retrying one failed channel
    // must not delay the re-send on the others. A run that sent nothing (every channel held) is not a round.
    const round = results.length > 0 && (dueResend || alert.last_sent_at === null);
    await store.markSent(alert.id, round ? now : alert.last_sent_at, round, stillPending, pagerRef, stillHeld);
  }
  return report;
}
