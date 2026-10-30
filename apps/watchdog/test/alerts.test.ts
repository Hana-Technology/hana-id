// D85 routing and re-sends, acknowledgements (portal and paging app), failing channels, the first-alert guarantee.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { alertText, deliverAlerts, FIRST_DELIVERY_GIVE_UP_MS } from '../src/alerts.ts';
import { type AlertKind, CHANNELS } from '../src/checks.ts';
import { Store } from '../src/store.ts';
import { MIN, RecordingNotifier, T0 } from './helpers.ts';

const store = () => new Store(env.DB);

async function raise(s: Store, kind: AlertKind, key = kind, at = T0) {
  const { ALERT_KINDS } = await import('../src/checks.ts');
  return s.createAlert({ key, kind, title: `${kind} title`, details: { kid: 'k9', n: 'LONGMODULUS', e: 'AQAB' }, runId: null, at, condition: false, channels: CHANNELS[ALERT_KINDS[kind].severity] });
}

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
