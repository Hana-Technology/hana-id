// D896: the approval queue's hold for a fresh read of the app's partner labels (approvals.ts `labelsFor`), with the
// vault's labels replaced by a controlled stand-in: a request whose labels are stale waits for one read, then goes
// with what is fresh or with none; cancelled, expired or with its window closed while it waits, nothing is sent.
import { type ApprovalSubject, utf8 } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import { APPROVAL_TTL_MS, Approvals, type WindowLabels } from '../../src/vault/approvals.ts';
import { Launcher } from '../../src/vault/launcher.ts';
import { ENV, FakeLauncherView, FakeWindow, PARTNER, TestTimers, sleepReal } from './harness.ts';

const ADDRESS = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const subject = (): ApprovalSubject => ({ kind: 'personal_sign', chain: 'evm', address: ADDRESS, context: {}, bytes: utf8('hi') });

/** The vault's labels, controlled: `state` is what forRequest answers; each refresh waits for `settle`. */
function labels() {
  const l = {
    state: 'stale' as readonly string[] | 'stale',
    refreshes: 0,
    settle: (_fail?: boolean) => undefined as void,
    source: null as unknown as WindowLabels,
  };
  l.source = {
    forRequest: () => l.state,
    refresh: () => {
      l.refreshes += 1;
      return new Promise<void>((resolve, reject) => {
        l.settle = (fail) => (fail ? reject(new Error('read failed')) : resolve());
      });
    },
  };
  return l;
}

function make() {
  const timers = new TestTimers();
  const view = new FakeLauncherView();
  const opened: FakeWindow[] = [];
  const l = labels();
  const approvals = new Approvals({
    authOrigin: ENV.authOrigin,
    parentWindow: new FakeWindow('partner'),
    appName: 'Partner',
    parentOrigin: PARTNER,
    open: (url, name, features) => {
      const w = new FakeWindow(url, name, features);
      opened.push(w);
      return w;
    },
    launcher: new Launcher(view, () => undefined, timers),
    timers,
    now: () => timers.now,
    onStop: () => undefined,
    partnerLabels: l.source,
  });
  const connect = (): FakeWindow => {
    view.click();
    const popup = opened.at(-1)!;
    approvals.handleMessage({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: popup, ports: [] });
    return popup;
  };
  const requests = (w: FakeWindow) => w.posted.map((p) => p.message).filter((m) => m.t === 'hana:approve-request');
  return { approvals, timers, view, l, connect, requests };
}

const tick = () => sleepReal(5);

describe('the queue’s hold for a fresh labels read', () => {
  it('stale: nothing is sent until the read settles, then the request with what is fresh', async () => {
    const { approvals, l, connect, requests } = make();
    const done = approvals.requestApproval(subject());
    const popup = connect();
    await tick();
    expect(requests(popup)).toHaveLength(0);
    expect(l.refreshes).toBe(1);
    l.state = ['{"doc":1}'];
    l.settle();
    await tick();
    expect(requests(popup)).toHaveLength(1);
    expect(requests(popup)[0]).toMatchObject({ partnerLabels: ['{"doc":1}'] });
    approvals.cancelAll();
    expect(await done).toBe('cancelled');
  });

  it('the read fails: the request goes without labels, and isn’t held again', async () => {
    const { approvals, l, connect, requests } = make();
    void approvals.requestApproval(subject());
    const popup = connect();
    await tick();
    l.settle(true);
    await tick();
    expect(requests(popup)).toHaveLength(1);
    expect(requests(popup)[0]).not.toHaveProperty('partnerLabels');
    expect(l.refreshes).toBe(1);
    approvals.cancelAll();
  });

  it('cancelled while it waits (a logout): it ends at once, and nothing is sent when the read settles', async () => {
    const { approvals, l, connect, requests } = make();
    const done = approvals.requestApproval(subject());
    const popup = connect();
    await tick();
    approvals.cancelAll();
    expect(await done).toBe('cancelled');
    l.state = ['{"doc":1}'];
    l.settle();
    await tick();
    expect(requests(popup)).toHaveLength(0);
    expect(approvals.pending).toBe(0);
  });

  it('expired while it waits: rejected, and the next request in the queue is the one sent after the read', async () => {
    const { approvals, timers, l, connect, requests } = make();
    const first = approvals.requestApproval(subject());
    const popup = connect();
    await tick();
    const second = approvals.requestApproval(subject());
    timers.advance(APPROVAL_TTL_MS);
    expect(await first).toBe('rejected');
    l.state = [];
    l.settle();
    await tick();
    // The second request was queued before the first expired, so its own TTL ended too: nothing is left to send.
    expect(await second).toBe('rejected');
    expect(requests(popup)).toHaveLength(0);
  });

  it('the window closed while it waits: after the read, the launcher shows again and nothing is posted', async () => {
    const { approvals, l, connect, requests, view } = make();
    void approvals.requestApproval(subject());
    const popup = connect();
    await tick();
    popup.closed = true;
    approvals.handleMessage({ data: { v: 1, t: 'hana:approve-bye' }, origin: ENV.authOrigin, source: popup, ports: [] });
    l.settle();
    await tick();
    expect(requests(popup)).toHaveLength(0);
    expect(view.label).not.toBeNull();
    approvals.cancelAll();
  });
});
