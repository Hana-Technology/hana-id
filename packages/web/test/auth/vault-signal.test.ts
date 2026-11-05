// @vitest-environment happy-dom
// D400: a page that signals the vault (`hana:auth-progress`) and then navigates or closes does so only once the vault
// acked (`hana:auth-progress-ack`), or after SIGNAL_ACK_WAIT_MS: Chromium delivers a message posted in the same task
// as a navigation with a null `event.source`, which the vault can't take.
import { describe, expect, it, vi } from 'vitest';
import { SIGNAL_ACK_WAIT_MS, type SignalTimers, vaultSignals } from '../../src/auth/vault-signal.ts';
import { ENV, EVIL, FakeWindow, type RemoteWindow, asWindow, flush, remoteWindow } from './helpers.ts';

/** Timers the test runs by hand. */
function manualTimers(): SignalTimers & { due: { fn: () => void; ms: number; id: number }[]; run(): void } {
  let next = 1;
  const due: { fn: () => void; ms: number; id: number }[] = [];
  return {
    due,
    setTimeout(fn, ms) {
      const id = next++;
      due.push({ fn, ms, id });
      return id;
    },
    clearTimeout(h) {
      const i = due.findIndex((d) => d.id === h);
      if (i >= 0) due.splice(i, 1);
    },
    run() {
      for (const d of due.splice(0)) d.fn();
    },
  };
}

const ack = (stage: string) => ({ v: 1, t: 'hana:auth-progress-ack', stage });

function setup(targets: () => readonly unknown[] = () => [vault], o: { origin?: string } = { origin: ENV.vaultOrigin }) {
  const origin = o.origin;
  const win = new FakeWindow('/login');
  const timers = manualTimers();
  const signals = vaultSignals(win, targets, origin, { timers });
  const go = vi.fn();
  return { win, timers, signals, go };
}
let vault: RemoteWindow = remoteWindow();

describe('vaultSignals', () => {
  it('waits at most 150 ms for an ack', () => {
    expect(SIGNAL_ACK_WAIT_MS).toBeGreaterThan(0);
    expect(SIGNAL_ACK_WAIT_MS).toBeLessThanOrEqual(150);
  });

  it('posts only the stage, with vaultOrigin as the target origin, to every target', () => {
    vault = remoteWindow();
    const other = remoteWindow();
    const { signals } = setup(() => [vault, null, other]);
    signals.post('google');
    expect(vault.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:auth-progress', stage: 'google' }, ENV.vaultOrigin);
    expect(other.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:auth-progress', stage: 'google' }, ENV.vaultOrigin);
  });

  it('nothing to signal (no target, no vaultOrigin): posts nothing and leaves at once, in the same task', async () => {
    vault = remoteWindow();
    for (const s of [setup(() => []), setup(() => [vault], {})]) {
      s.signals.post('google');
      const left = s.signals.leave(s.go);
      expect(s.go).toHaveBeenCalledTimes(1);
      expect(s.win.listenerCount('message')).toBe(0);
      await left;
    }
    expect(vault.postMessage).not.toHaveBeenCalled();
  });

  it('leaves only once the vault acked, then stops listening', async () => {
    vault = remoteWindow();
    const { win, timers, signals, go } = setup();
    const left = signals.postThenLeave('google', go);
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(timers.due.map((d) => d.ms)).toEqual([SIGNAL_ACK_WAIT_MS]);
    win.message(ack('google'), ENV.vaultOrigin, vault);
    expect(go).toHaveBeenCalledTimes(1);
    await left;
    // The wait's timer is cleared and the listener gone: a late timer or ack does nothing.
    expect(timers.due).toEqual([]);
    expect(win.listenerCount('message')).toBe(0);
    win.message(ack('google'), ENV.vaultOrigin, vault);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('no ack: leaves at SIGNAL_ACK_WAIT_MS, and a late ack does nothing', async () => {
    vault = remoteWindow();
    const { win, timers, signals, go } = setup();
    const left = signals.postThenLeave('relayed', go);
    await flush();
    expect(go).not.toHaveBeenCalled();
    timers.run();
    expect(go).toHaveBeenCalledTimes(1);
    await left;
    expect(win.listenerCount('message')).toBe(0);
    win.message(ack('relayed'), ENV.vaultOrigin, vault);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another origin', () => [ack('google'), EVIL, vault]],
    ['the auth origin', () => [ack('google'), ENV.authOrigin, vault]],
    ['a window it didn’t signal', () => [ack('google'), ENV.vaultOrigin, remoteWindow()]],
    ['a null source (Chromium’s, after a navigation)', () => [ack('google'), ENV.vaultOrigin, null]],
    ['another stage', () => [ack('relayed'), ENV.vaultOrigin, vault]],
    ['an extra key', () => [{ ...ack('google'), extra: 1 }, ENV.vaultOrigin, vault]],
    ['an unknown stage', () => [ack('done'), ENV.vaultOrigin, vault]],
    ['the signal itself', () => [{ v: 1, t: 'hana:auth-progress', stage: 'google' }, ENV.vaultOrigin, vault]],
    ['not an object', () => ['hana:auth-progress-ack', ENV.vaultOrigin, vault]],
  ] as [string, () => [unknown, string, unknown]][])('an ack from %s is no ack', async (_, ev) => {
    vault = remoteWindow();
    const { win, timers, signals, go } = setup();
    void signals.postThenLeave('google', go);
    const [data, origin, source] = ev();
    win.message(data, origin, source);
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(timers.due).toHaveLength(1);
    win.message(ack('google'), ENV.vaultOrigin, vault);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('waits for every signal posted so far (the callback’s `back`, then `google`)', async () => {
    vault = remoteWindow();
    const { win, signals, go } = setup();
    signals.post('back');
    void signals.postThenLeave('google', go);
    win.message(ack('google'), ENV.vaultOrigin, vault);
    expect(go).not.toHaveBeenCalled();
    win.message(ack('back'), ENV.vaultOrigin, vault);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('a signal acked before the page leaves costs nothing: the leave is at once', async () => {
    vault = remoteWindow();
    const { win, timers, signals, go } = setup();
    signals.post('back');
    win.message(ack('back'), ENV.vaultOrigin, vault);
    void signals.leave(go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(timers.due).toEqual([]);
  });

  it('an ack from any one of the windows it signalled (the callback posts to the opener and its frames)', () => {
    const opener = remoteWindow();
    vault = remoteWindow({ parent: opener });
    const { win, signals, go } = setup(() => [opener, vault]);
    void signals.postThenLeave('relayed', go);
    win.message(ack('relayed'), ENV.vaultOrigin, vault);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('an ack that comes while the signal is being posted still counts', async () => {
    vault = remoteWindow();
    const win = new FakeWindow('/login');
    // A synchronous ack, sooner than any browser.
    vault.postMessage.mockImplementation((m: { stage: string }) => win.message(ack(m.stage), ENV.vaultOrigin, vault));
    const timers = manualTimers();
    const go = vi.fn();
    const left = vaultSignals(win, () => [vault], ENV.vaultOrigin, { timers }).postThenLeave('google', go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(timers.due).toEqual([]);
    await left;
  });

  it('a target that can’t be posted to is not waited for', () => {
    const gone = remoteWindow();
    gone.postMessage.mockImplementation(() => {
      throw new DOMException('gone');
    });
    const { win, timers, signals, go } = setup(() => [gone]);
    void signals.postThenLeave('google', go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(timers.due).toEqual([]);
    expect(win.listenerCount('message')).toBe(0);
  });

  it('resolves once the page left; rejects with what the navigation threw', async () => {
    vault = remoteWindow();
    const { win, signals } = setup();
    const order: string[] = [];
    const left = signals.postThenLeave('google', () => order.push('go')).then(() => order.push('resolved'));
    win.message(ack('google'), ENV.vaultOrigin, vault);
    await left;
    expect(order).toEqual(['go', 'resolved']);
    const boom = signals.postThenLeave('google', () => {
      throw new Error('assign failed');
    });
    win.message(ack('google'), ENV.vaultOrigin, vault);
    await expect(boom).rejects.toThrow('assign failed');
  });

  it('with the browser’s own timers by default', async () => {
    vi.useFakeTimers();
    try {
      vault = remoteWindow();
      const win = new FakeWindow('/login');
      win.opener = asWindow(vault);
      const go = vi.fn();
      void vaultSignals(win, () => [vault], ENV.vaultOrigin).postThenLeave('google', go);
      vi.advanceTimersByTime(SIGNAL_ACK_WAIT_MS - 1);
      expect(go).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(go).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
