// D85 routing and re-sends, acknowledgements (portal and paging app), failing channels, the first-alert guarantee.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { alertText, deliverAlerts, deliveryDetail, FIRST_DELIVERY_GIVE_UP_MS } from '../src/alerts.ts';
import { type AlertKind, CHANNELS } from '../src/checks.ts';
import { Store } from '../src/store.ts';
import { MIN, RecordingNotifier, T0 } from './helpers.ts';

const store = () => new Store(env.DB);

async function raise(s: Store, kind: AlertKind, key = kind, at = T0, condition = false) {
  const { ALERT_KINDS } = await import('../src/checks.ts');
  return s.createAlert({ key, kind, title: `${kind} title`, details: { kid: 'k9', n: 'LONGMODULUS', e: 'AQAB' }, runId: null, at, condition, channels: CHANNELS[ALERT_KINDS[kind].severity] });
}

/** One alert's delivery rows as `channel:kind:ok[:error]`. */
const rows = async (s: Store, id: number) => (await s.deliveries(id)).map((d) => `${d.channel}:${d.kind}:${d.ok}${d.error ? `:${d.error}` : ''}`);

const channels = (n: RecordingNotifier) => n.sent.map((s) => s.channel).sort();

describe('routing by severity (D85)', () => {
  it('critical → paging app, Slack and email; warning → Slack and email; info → none', async () => {
    const s = store();
    const n = new RecordingNotifier();
    await raise(s, 'forged_active_key');
    await deliverAlerts(s, n, T0, 'sandbox-test');
    expect(channels(n)).toEqual(['email', 'pager', 'slack']);
    n.clear();
    await raise(s, 'stale_active_key');
    await deliverAlerts(s, n, T0, 'sandbox-test');
    expect(channels(n)).toEqual(['email', 'slack']);
    n.clear();
    const info = await raise(s, 'key_change_confirmed');
    await deliverAlerts(s, n, T0, 'sandbox-test');
    expect(n.sent).toEqual([]);
    expect((await s.getAlert(info))?.send_count).toBe(0);
  });
});

describe('critical re-sends', () => {
  it('re-sends every 15 min on every channel until acknowledged in the portal', async () => {
    const s = store();
    const n = new RecordingNotifier();
    const id = await raise(s, 'forged_key_change');
    for (const m of [0, 5, 10]) await deliverAlerts(s, n, T0 + m * MIN, 'e');
    expect(n.sent.length).toBe(3); // the first delivery only
    await deliverAlerts(s, n, T0 + 15 * MIN, 'e');
    expect(n.sent.slice(3).map((x) => [x.channel, x.msg.resend]).sort()).toEqual([
      ['email', true],
      ['pager', true],
      ['slack', true],
    ]);
    await deliverAlerts(s, n, T0 + 30 * MIN, 'e');
    expect(n.sent.length).toBe(9);
    expect(await s.ack(id, 'founder-a@example.com', 'portal', T0 + 31 * MIN)).toBe(true);
    for (const m of [45, 60, 120]) await deliverAlerts(s, n, T0 + m * MIN, 'e');
    expect(n.sent.length).toBe(9);
    const a = await s.getAlert(id);
    expect(a).toMatchObject({ acked_by: 'founder-a@example.com', acked_via: 'portal', send_count: 3 });
  });

  it('stops after an acknowledgement in the paging app, recorded with who', async () => {
    const s = store();
    const n = new RecordingNotifier();
    const id = await raise(s, 'forged_key_change');
    await deliverAlerts(s, n, T0, 'e');
    const ref = (await s.getAlert(id))?.pager_ref;
    expect(ref).toBe('page-1');
    n.pagerAcks.set(ref!, 'pushover:phone-a');
    const report = await deliverAlerts(s, n, T0 + 15 * MIN, 'e');
    expect(report.ackedByPager).toBe(1);
    expect(n.sent.length).toBe(3);
    expect(await s.getAlert(id)).toMatchObject({ acked_by: 'pushover:phone-a', acked_via: 'pager' });
  });

  it('does not re-send warnings', async () => {
    const s = store();
    const n = new RecordingNotifier();
    await raise(s, 'rpc_failing');
    await deliverAlerts(s, n, T0, 'e');
    await deliverAlerts(s, n, T0 + 60 * MIN, 'e');
    expect(n.sent.length).toBe(2);
  });
});

describe('failing channels', () => {
  it('a failing or throwing channel never blocks the others, and is retried as a first delivery', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.throwing.add('slack');
    n.failing.add('email');
    const id = await raise(s, 'forged_key_change');
    const r1 = await deliverAlerts(s, n, T0, 'e');
    expect(channels(n)).toEqual(['pager']);
    expect(r1.failed).toBe(2);
    expect((await s.getAlert(id))?.pending_channels.sort()).toEqual(['email', 'slack']);
    n.throwing.clear();
    n.failing.clear();
    await deliverAlerts(s, n, T0 + 5 * MIN, 'e');
    expect(channels(n)).toEqual(['email', 'pager', 'slack']);
    expect((await s.getAlert(id))?.pending_channels).toEqual([]);
    // Retrying one channel didn't move the re-send clock: everything re-sends 15 min after the first round.
    await deliverAlerts(s, n, T0 + 15 * MIN, 'e');
    expect(n.sent.length).toBe(6);
    const kinds = (await s.deliveries(id)).map((d) => `${d.channel}:${d.kind}:${d.ok}`);
    expect(kinds).toEqual(expect.arrayContaining(['slack:first:false', 'email:first:false', 'slack:first:true', 'email:first:true', 'pager:resend:true']));
  });

  it('an acknowledgement never stops a first delivery that has not gone out yet', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.failing.add('email');
    const id = await raise(s, 'forged_key_change');
    await deliverAlerts(s, n, T0, 'e');
    await s.ack(id, 'founder-b@example.com', 'portal', T0 + MIN);
    n.failing.clear();
    await deliverAlerts(s, n, T0 + 5 * MIN, 'e');
    expect(n.on('email')).toHaveLength(1);
    // ...but no re-sends after the ack.
    await deliverAlerts(s, n, T0 + 30 * MIN, 'e');
    expect(n.sent.length).toBe(3);
  });

  it('gives up first deliveries of a non-critical alert after a day', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.failing.add('slack');
    const id = await raise(s, 'stale_active_key');
    await deliverAlerts(s, n, T0, 'e');
    await deliverAlerts(s, n, T0 + FIRST_DELIVERY_GIVE_UP_MS + MIN, 'e');
    expect((await s.getAlert(id))?.pending_channels).toEqual([]);
  });
});

describe('a channel with no credentials (D570)', () => {
  it('is recorded once per alert, never retried, and is not a delivery failure', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    const id = await raise(s, 'forged_key_change');
    const r1 = await deliverAlerts(s, n, T0, 'e');
    expect(r1).toMatchObject({ first: 2, failed: 0, notConfigured: 1 });
    expect(deliveryDetail(r1)).toBe('2 first, 0 re-sent, 0 failed, 0 acked in the paging app, 1 held (channel not configured)');
    expect(channels(n)).toEqual(['email', 'pager']);
    expect(await s.getAlert(id)).toMatchObject({ pending_channels: [], unconfigured_channels: ['slack'], send_count: 1 });
    // The runs between re-sends write nothing: no delivery row, no change to the alert.
    const before = await s.getAlert(id);
    for (const m of [5, 10]) expect(await deliverAlerts(s, n, T0 + m * MIN, 'e')).toEqual({ first: 0, resent: 0, failed: 0, ackedByPager: 0, notConfigured: 0 });
    expect(await s.getAlert(id)).toEqual(before);
    // Re-sends on the configured channels are unchanged, and add no row for the held one.
    for (const m of [15, 30]) expect(await deliverAlerts(s, n, T0 + m * MIN, 'e')).toMatchObject({ resent: 2, failed: 0, notConfigured: 0 });
    expect((await rows(s, id)).filter((r) => r.startsWith('slack'))).toEqual(['slack:first:false:not configured']);
    expect((await rows(s, id)).filter((r) => r.endsWith(':resend:true')).sort()).toEqual(['email:resend:true', 'email:resend:true', 'pager:resend:true', 'pager:resend:true']);
    expect(deliveryDetail(await deliverAlerts(s, n, T0 + 31 * MIN, 'e'))).toBe('0 first, 0 re-sent, 0 failed, 0 acked in the paging app');
  });

  it('a resolved, acknowledged alert with a held channel is not looked at again', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    const id = await raise(s, 'forged_key_change');
    await deliverAlerts(s, n, T0, 'e');
    await s.ack(id, 'founder-a@example.com', 'portal', T0 + MIN);
    expect((await s.alertsToDeliver()).map((a) => a.id)).toEqual([]);
    // Slack gets its webhook later: the alert is closed (an event, acknowledged), so nothing goes out.
    n.unconfigured.clear();
    n.clear();
    for (const m of [5, 15, 60]) await deliverAlerts(s, n, T0 + m * MIN, 'e');
    expect(n.sent).toEqual([]);
    expect(await rows(s, id)).toHaveLength(3);
  });

  it('once configured, sends what is still open: an unacknowledged critical alert and a condition that still holds', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    const critical = await raise(s, 'forged_key_change');
    const condition = await raise(s, 'rpc_failing', 'rpc_failing', T0, true);
    const event = await raise(s, 'stale_active_key'); // a warning event: resolved at creation
    await deliverAlerts(s, n, T0, 'e');
    for (const id of [critical, condition, event]) expect((await s.getAlert(id))?.unconfigured_channels).toEqual(['slack']);
    n.unconfigured.clear();
    n.clear();
    // The next run, not the next 15-minute round, and long after a warning's one-day retry window.
    const r = await deliverAlerts(s, n, T0 + FIRST_DELIVERY_GIVE_UP_MS + 5 * MIN, 'e');
    expect(n.on('slack').map((x) => x.msg.alertId).sort()).toEqual([critical, condition].sort());
    expect(r.failed).toBe(0);
    expect((await s.getAlert(critical))?.unconfigured_channels).toEqual([]);
    expect((await s.getAlert(condition))?.unconfigured_channels).toEqual([]);
    expect(await rows(s, condition)).toEqual(expect.arrayContaining(['slack:first:false:not configured', 'slack:first:true']));
    // The closed event keeps its one "not configured" row and is never sent.
    expect((await rows(s, event)).filter((x) => x.startsWith('slack'))).toEqual(['slack:first:false:not configured']);
  });

  it('a condition that resolved while its channel was held is not sent afterwards', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    const id = await raise(s, 'rpc_failing', 'rpc_failing', T0, true);
    await deliverAlerts(s, n, T0, 'e');
    expect(await s.resolveConditions(new Map([['rpc_failing', 'all']]), new Set(), T0 + MIN)).toBe(1);
    n.unconfigured.clear();
    await deliverAlerts(s, n, T0 + 5 * MIN, 'e');
    expect(n.on('slack')).toEqual([]);
    expect((await rows(s, id)).filter((x) => x.startsWith('slack'))).toEqual(['slack:first:false:not configured']);
  });

  it('a real send failure keeps its retry on every run and is counted, next to a held channel', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    n.failing.add('email');
    const id = await raise(s, 'forged_key_change');
    expect(await deliverAlerts(s, n, T0, 'e')).toMatchObject({ first: 1, failed: 1, notConfigured: 1 });
    expect(await deliverAlerts(s, n, T0 + 5 * MIN, 'e')).toMatchObject({ first: 0, failed: 1, notConfigured: 0 });
    expect(await s.getAlert(id)).toMatchObject({ pending_channels: ['email'], unconfigured_channels: ['slack'] });
    n.failing.clear();
    expect(await deliverAlerts(s, n, T0 + 10 * MIN, 'e')).toMatchObject({ first: 1, failed: 0 });
    expect((await rows(s, id)).filter((x) => x.startsWith('email'))).toEqual(['email:first:false:HTTP 500', 'email:first:false:HTTP 500', 'email:first:true']);
  });

  it('a held channel that fails once it is configured becomes an ordinary retried first delivery', async () => {
    const s = store();
    const n = new RecordingNotifier();
    n.unconfigured.add('slack');
    const id = await raise(s, 'forged_key_change');
    await deliverAlerts(s, n, T0, 'e');
    n.unconfigured.clear();
    n.failing.add('slack');
    expect(await deliverAlerts(s, n, T0 + 5 * MIN, 'e')).toMatchObject({ failed: 1, notConfigured: 0 });
    expect(await s.getAlert(id)).toMatchObject({ pending_channels: ['slack'], unconfigured_channels: [] });
    n.failing.clear();
    await deliverAlerts(s, n, T0 + 10 * MIN, 'e');
    expect(n.on('slack')).toHaveLength(1);
    expect((await s.getAlert(id))?.pending_channels).toEqual([]);
  });

  it('a channel that loses its credentials after delivering is recorded once, not on every re-send', async () => {
    const s = store();
    const n = new RecordingNotifier();
    const id = await raise(s, 'forged_key_change');
    await deliverAlerts(s, n, T0, 'e');
    n.unconfigured.add('slack');
    for (const m of [15, 30, 45]) expect((await deliverAlerts(s, n, T0 + m * MIN, 'e')).failed).toBe(0);
    expect((await rows(s, id)).filter((x) => x.startsWith('slack'))).toEqual(['slack:first:true', 'slack:resend:false:not configured']);
    expect(n.on('pager')).toHaveLength(4);
  });

  it('with no channel configured nothing is sent and no round is counted; the first round starts when one is', async () => {
    const s = store();
    const n = new RecordingNotifier();
    for (const c of ['pager', 'slack', 'email'] as const) n.unconfigured.add(c);
    const id = await raise(s, 'forged_key_change');
    for (const m of [0, 5, 15, 30]) await deliverAlerts(s, n, T0 + m * MIN, 'e');
    expect(await rows(s, id)).toHaveLength(3);
    expect(await s.getAlert(id)).toMatchObject({ send_count: 0, last_sent_at: null });
    n.unconfigured.delete('email');
    await deliverAlerts(s, n, T0 + 35 * MIN, 'e');
    expect(n.on('email').map((x) => x.msg.resend)).toEqual([false]);
    expect(await s.getAlert(id)).toMatchObject({ send_count: 1, last_sent_at: T0 + 35 * MIN, unconfigured_channels: ['pager', 'slack'] });
  });
});

describe('alert text', () => {
  it('lists the details without key material, with the id and the ack hint for critical alerts', async () => {
    const text = alertText({ id: 7, kind: 'forged_key_change', severity: 'critical', created_at: T0, details: { kid: 'k9', n: 'LONGMODULUS', e: 'AQAB', actions: [{ method: 'cancel_issuer_key_change' }] } }, 'sandbox-test');
    expect(text).toContain('kid: k9');
    expect(text).toContain('cancel_issuer_key_change');
    expect(text).not.toContain('LONGMODULUS');
    expect(text).toContain('#7');
    expect(text).toContain('until acknowledged');
    expect(text.split('\n').at(-1)).toBe('Playbook: forged-key-change (admin portal "Security & monitoring" > Playbooks; docs/playbooks.md#forged-key-change)');
  });

  it('shows governance changes as one readable line each, not JSON', async () => {
    const changes = [
      { field: 'updater_keys', before: ['ed25519:OLD'], after: ['ed25519:NEW'] },
      { field: 'watchdogs', before: ['w1.testnet'], after: ['w1.testnet', 'w2.testnet'] },
      { field: 'paused', before: false, after: true },
      { field: 'owner', before: 'a.testnet', after: 'b.testnet' },
      { field: 'pending_upgrade', before: null, after: { code_hash: 'H1' } },
    ];
    const lines = alertText({ id: 8, kind: 'governance_change', severity: 'critical', created_at: T0, details: { changes } }, 'sandbox-test').split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'updater_keys: removed ed25519:OLD; added ed25519:NEW',
      'watchdogs: added w2.testnet',
      'paused: false -> true',
      'owner: a.testnet -> b.testnet',
      'pending_upgrade: null -> {"code_hash":"H1"}',
    ]);
    expect(lines.join('\n')).not.toContain('"field"');
  });

  it('keeps change lines printable and bounded (hostile values)', async () => {
    const changes = [{ field: 'updater_keys\nX-Injected: 1', before: [], after: ['k\r\n<!channel>'.padEnd(2000, 'x')] }];
    const [line] = alertText({ id: 9, kind: 'governance_change', severity: 'critical', created_at: T0, details: { changes } }, 'e').split('\n');
    expect(line!.length).toBeLessThanOrEqual(600);
    expect(line).not.toMatch(/[\r\n]/u);
    expect(line).toMatch(/^updater_keys.*X-Injected: 1: added /u);
  });
});
