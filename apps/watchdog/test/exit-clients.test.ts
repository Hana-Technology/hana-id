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
});
