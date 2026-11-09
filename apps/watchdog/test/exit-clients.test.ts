// The exit client's watchdog checks (D468, D487, D493): the pinned expected list, its pause on an unpinned client in
// force, and the hourly counter's alert. It reads only the chain view.
import { describe, expect, it } from 'vitest';
import { alertsOf, HOUR, initialized, MIN, T0 } from './helpers.ts';

const EXIT: [string, string] = ['google', 'exit.apps'];
const EMAIL: [string, string] = ['email', 'hana-home'];
const window = (start: number, current: number, previous = 0) => ({ window_start_ms: start, current, previous });

describe('the exit list against the pins', () => {
  it('a pre-v4 contract is skipped', async () => {
    const w = await initialized({ exitPins: [EXIT] });
    const r = await w.run();
    expect(r.checks.find((c) => c.id === 'exit_clients')).toMatchObject({ outcome: 'skipped' });
    expect(await alertsOf(w.store, 'exit_client_unpinned')).toEqual([]);
  });

  it('a pinned list on chain, in force and pending, is fine; a pin not yet on chain is a warning', async () => {
    const w = await initialized({ exitPins: [EXIT, EMAIL] });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [{ provider: 'email', aud: 'hana-home', effective_at_ms: T0 + HOUR }];
    w.chain.config.exit_window = window(T0, 0);
    const r = await w.run();
    expect(r.checks.find((c) => c.id === 'exit_clients')).toMatchObject({ outcome: 'ok' });
    expect(await alertsOf(w.store, 'exit_client_unpinned')).toEqual([]);
    expect(await alertsOf(w.store, 'exit_client_missing')).toEqual([]);
    expect(w.writer.calls).toEqual([]);
  });

  it('a pinned client on neither list warns: not proposed yet, or retired by an emergency removal', async () => {
    const w = await initialized({ exitPins: [EXIT, EMAIL] });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    await w.run();
    const missing = await alertsOf(w.store, 'exit_client_missing');
    expect(missing.map((a) => a.severity)).toEqual(['warning']);
    expect(missing[0]?.details.client).toEqual(EMAIL);
    expect(w.writer.calls).toEqual([]);
  });

  it('an unpinned client pending pages, and nothing is paused (it is not in force, the council removes it free)', async () => {
    const w = await initialized({ exitPins: [EMAIL] });
    w.chain.config.exit_clients = [];
    w.chain.config.pending_exit_clients = [{ provider: 'google', aud: 'exit.apps', effective_at_ms: T0 + 72 * HOUR }];
    await w.run();
    const [a] = await alertsOf(w.store, 'exit_client_unpinned');
    expect(a).toMatchObject({ severity: 'critical', details: { client: EXIT, state: 'pending' } });
    expect(w.writer.methods()).toEqual([]);
    expect(w.chain.config.paused).toBe(false);
  });

  it('an unpinned client in force pauses at once, and re-pages only once the alert is resolved', async () => {
    const w = await initialized({ exitPins: [EMAIL] });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    await w.run();
    const [a] = await alertsOf(w.store, 'exit_client_unpinned');
    expect(a).toMatchObject({ severity: 'critical', details: { client: EXIT, state: 'in_force' } });
    expect(w.writer.methods()).toEqual(['pause']);
    expect(w.chain.config.paused).toBe(true);
    await w.run(); // already paused: no second pause
    expect(w.writer.methods()).toEqual(['pause']);
    expect(await alertsOf(w.store, 'exit_client_unpinned')).toHaveLength(1);
  });

  it('with no pins every on-chain exit client is unpinned (none at all is fine)', async () => {
    const w = await initialized({ exitPins: null });
    w.chain.config.exit_clients = [];
    w.chain.config.pending_exit_clients = [];
    await w.run();
    expect(await alertsOf(w.store, 'exit_client_unpinned')).toEqual([]);
    w.chain.config.exit_clients = [EXIT];
    await w.run();
    expect((await alertsOf(w.store, 'exit_client_unpinned'))[0]).toMatchObject({ details: { state: 'in_force' } });
  });

  it('unreadable pins page `pins_invalid` and do not pause', async () => {
    const w = await initialized({ exitPins: null });
    w.deps.config.exitPins = { pins: null, problems: ['EXIT_PINS is malformed: every exit client is treated as unpinned'] };
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    const r = await w.run();
    expect((await alertsOf(w.store, 'pins_invalid')).map((a) => a.key)).toContain('pins_invalid:exit');
    expect(r.checks.find((c) => c.id === 'exit_clients')).toMatchObject({ outcome: 'error' });
    expect(w.writer.methods()).toEqual([]);
  });

  it('unreadable pins still page an in-force client as unpinned, without pausing', async () => {
    const w = await initialized({ exitPins: null });
    w.deps.config.exitPins = { pins: null, problems: ['EXIT_PINS is malformed: every exit client is treated as unpinned'] };
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    await w.run();
    const [a] = await alertsOf(w.store, 'exit_client_unpinned');
    expect(a).toMatchObject({ severity: 'critical', key: `exit_client_unpinned:in_force:${EXIT[0]}:${EXIT[1]}`, details: { client: EXIT, state: 'in_force' } });
    expect(a?.title).toContain('not paused: EXIT_PINS is unreadable');
    expect(w.writer.methods()).toEqual([]);
    expect(w.chain.config.paused).toBe(false);
  });

  it('an in-force alert already open stays open when the pins become unreadable, and nothing more is paused', async () => {
    const w = await initialized({ exitPins: [EMAIL] });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    await w.run();
    expect(w.writer.methods()).toEqual(['pause']);
    const key = `exit_client_unpinned:in_force:${EXIT[0]}:${EXIT[1]}`;
    const before = await w.store.openAlert(key);
    expect(before).not.toBeNull();
    // The council has unpaused; the var is broken by a bad deploy before the client is dealt with.
    w.chain.config.paused = false;
    w.deps.config.exitPins = { pins: null, problems: ['EXIT_PINS is malformed: every exit client is treated as unpinned'] };
    await w.run();
    const after = await w.store.openAlert(key);
    expect(after?.id).toBe(before?.id);
    expect(w.writer.methods()).toEqual(['pause']);
    expect(w.chain.config.paused).toBe(false);
  });
});

describe('the hourly exit counter (alert only, never refuses)', () => {
  it('pages when the current or the previous hour reaches the level, once per hour', async () => {
    const w = await initialized({ exitPins: [EXIT], exitAlertPerHour: 5 });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    w.chain.config.exit_window = window(T0, 4, 0);
    await w.run();
    expect(await alertsOf(w.store, 'exit_volume_high')).toEqual([]);
    w.chain.config.exit_window = window(T0, 5, 0);
    await w.run();
    expect((await alertsOf(w.store, 'exit_volume_high')).map((a) => a.severity)).toEqual(['critical']);
    // The previous window is judged too, so a burst just before the hour boundary shows.
    w.chain.config.exit_window = window(T0 + HOUR, 0, 7);
    await w.run();
    const open = (await w.store.openAlerts()).filter((a) => a.kind === 'exit_volume_high');
    expect(open.map((a) => a.key)).toContain(`exit_volume_high:${T0}`);
    expect(w.writer.calls).toEqual([]);
  });

  it('the default level is 20', async () => {
    const w = await initialized({ exitPins: [EXIT] });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    w.chain.config.exit_window = window(T0, 19, 0);
    await w.run();
    expect(await alertsOf(w.store, 'exit_volume_high')).toEqual([]);
    w.chain.config.exit_window = window(T0, 20, 0);
    await w.run();
    expect(await alertsOf(w.store, 'exit_volume_high')).toHaveLength(1);
    expect(MIN).toBeGreaterThan(0);
  });

  const volumeWatchdog = async (exitAlertPerHour?: number) => {
    const w = await initialized({ exitPins: [EXIT], ...(exitAlertPerHour === undefined ? {} : { exitAlertPerHour }) });
    w.chain.config.exit_clients = [EXIT];
    w.chain.config.pending_exit_clients = [];
    return w;
  };
  const openVolumeKeys = async (w: Awaited<ReturnType<typeof volumeWatchdog>>) => (await w.store.openAlerts()).filter((a) => a.kind === 'exit_volume_high').map((a) => a.key);

  it('a burst split across an hour boundary pages: 19 then 19, under the level alone, at 1.5x together', async () => {
    const w = await volumeWatchdog();
    w.chain.config.exit_window = window(T0, 19, 19);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([`exit_volume_high:combined:${T0}`]);
    const [a] = await alertsOf(w.store, 'exit_volume_high');
    expect(a).toMatchObject({ severity: 'critical', details: { current: 19, previous: 19, combined: 38, combined_level: 30, threshold: 20 } });
    expect(w.writer.calls).toEqual([]);
  });

  it('the combined level is 1.5x the hourly level, rounded up, and just under it stays quiet', async () => {
    const w = await volumeWatchdog();
    w.chain.config.exit_window = window(T0, 15, 14);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([]);
    w.chain.config.exit_window = window(T0, 15, 15);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([`exit_volume_high:combined:${T0}`]);
  });

  it('an odd level rounds up: 5 per hour needs 8 across the two', async () => {
    const w = await volumeWatchdog(5);
    w.chain.config.exit_window = window(T0, 4, 3);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([]);
    w.chain.config.exit_window = window(T0, 4, 4);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([`exit_volume_high:combined:${T0}`]);
  });

  it('a single hour that reached the level pages once, not a second time as combined', async () => {
    const w = await volumeWatchdog();
    w.chain.config.exit_window = window(T0, 30, 0);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([`exit_volume_high:${T0}`]);
    w.chain.config.exit_window = window(T0, 25, 12);
    await w.run();
    expect(await openVolumeKeys(w)).toEqual([`exit_volume_high:${T0}`]);
  });

  it('the combined alert resolves once the burst has left both windows', async () => {
    const w = await volumeWatchdog();
    w.chain.config.exit_window = window(T0, 19, 19);
    await w.run();
    expect(await openVolumeKeys(w)).toHaveLength(1);
    w.chain.config.exit_window = window(T0 + HOUR, 0, 19);
    await w.run();
    expect(await w.store.openAlert(`exit_volume_high:combined:${T0}`)).toBeNull();
  });

  it('a slow harvest paced under the level is not caught: the known limit of the alarm', async () => {
    const w = await volumeWatchdog();
    for (let h = 0; h < 12; h++) {
      w.chain.config.exit_window = window(T0 + h * HOUR, 14, 14);
      await w.run();
    }
    expect(await alertsOf(w.store, 'exit_volume_high')).toEqual([]);
  });
});
