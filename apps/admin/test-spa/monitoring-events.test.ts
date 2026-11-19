// Security & monitoring's "Security events" table (C14; D843's free-network-fee kinds), as the browser runs
// public/app.js (boot.ts): each event in words with its playbook, as Feed and notices shows them, the code small
// under it. Found by the local stack's admin portal tests (D873): the table showed the bare code only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const MONITORING = {
  now: 1_795_000_000_000,
  env: 'sandbox-dev',
  watchdog: { ok: false, code: 'watchdog_unconfigured' },
  governance: { ok: false, code: 'near_unavailable' },
  events: {
    ok: true,
    events: [
      { id: 'se_1', kind: 'evm_relay_stuck', detectedAt: 1_794_999_000_000, orgId: null, appId: null, scopeId: null, notifiedAt: null, detail: { chainId: 84532 }, title: 'Free network fees are paused or slow', playbook: { id: 'evm-relay-paused', title: 'Free network fees paused' } },
      { id: 'se_2', kind: 'some_new_kind', detectedAt: 1_794_999_000_000, orgId: null, appId: null, scopeId: null, notifiedAt: null, detail: null, title: 'some_new_kind', playbook: null },
    ],
  },
  findings: [],
};

describe('Security & monitoring: security events', () => {
  it('each event in words with its playbook link, its code small under it; an event without a playbook says so', async () => {
    const page = boot('/security/monitoring', (c: Call): Answer => (c.path === '/api/monitoring' ? { body: MONITORING } : { status: 503, body: { error: { code: 'watchdog_unconfigured' } } }));
    await vi.waitFor(() => expect(page.text()).toContain('Security events'));
    const panel = [...page.main().querySelectorAll('section.panel')].find((s) => s.querySelector('h2')?.textContent === 'Security events')!;
    const rows = [...panel.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Free network fees are paused or slow');
    expect(rows[0]!.querySelector('code')?.textContent).toBe('evm_relay_stuck');
    const link = rows[0]!.querySelector('a')!;
    expect([link.textContent, link.getAttribute('href')]).toEqual(['Free network fees paused', '/security/playbooks/evm-relay-paused']);
    expect(rows[1]!.querySelector('a')).toBeNull();
    expect(rows[1]!.textContent).toContain('no playbook');
  });
});
