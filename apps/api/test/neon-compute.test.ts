// Neon compute on the free plan (D872): with NEON_PLAN every usage-ledger connection is noted in D1 as a wake-up; the
// month's estimate raises `neon_compute_high` at 70% and 90%, once each a month; AdminRpc.neonWake notes the admin
// Worker's wake-ups with its runs' records; systemStatus answers them. Without NEON_PLAN nothing is written.
import { NEON_SUSPEND_MS, addWake, awakeMsAt, type NeonMonthRow } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventId } from '../src/changes/guard.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { syncIdentityUsage } from '../src/usage/identity-sync.ts';
import { noteNeonWake } from '../src/usage/neon-compute.ts';
import { ensureUsagePartitions } from '../src/usage/partitions.ts';
import { orgStatements, reportTransport } from '../src/usage/reports.ts';
import { call, chain, seedApp, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { governanceViews, hana, member, ownerChain, system } from './rpc-helpers.ts';
import { ledger } from './usage-ledger.ts';

afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;
const FREE = '{"computeHoursPerMonth":100,"computeUnits":0.25}';
/** A plan whose allowance is 15 minutes awake (1 compute-hour at 4 CU), so the tests reach the thresholds quickly. */
const TINY = '{"computeHoursPerMonth":1,"computeUnits":4}';

interface Row {
  month: string;
  first_at: number;
  closed_ms: number;
  win_start: number;
  win_end: number;
  windows: number;
  alerted: number;
}
const row = (month: string) => env.DB.prepare('SELECT month, first_at, closed_ms, win_start, win_end, windows, alerted FROM neon_compute WHERE month = ?1').bind(month).first<Row>();
const events = async (month: string) =>
  (await env.DB.prepare("SELECT id, kind, detail_json FROM security_events WHERE kind = 'neon_compute_high' AND json_extract(detail_json, '$.month') = ?1 ORDER BY detected_at").bind(month).all<{ id: string; kind: string; detail_json: string }>()).results.map(
    (r): Record<string, unknown> => ({ id: r.id, ...(JSON.parse(r.detail_json) as Record<string, unknown>) }),
  );
const withPlan = (plan: string | undefined) => ({ ...env, NEON_PLAN: plan });

describe('noteNeonWake (D872)', () => {
  it('writes nothing without NEON_PLAN, or with one it can’t read', async () => {
    const t = Date.UTC(2031, 0, 5, 10);
    await noteNeonWake(withPlan(undefined), t, t + 1000);
    await noteNeonWake(withPlan('{"computeHoursPerMonth":0}'), t, t + 1000);
    expect(await row('2031-01')).toBeNull();
  });

  it('its one UPSERT agrees with the reference arithmetic (console-core addWake) over a day of mixed wake-ups', async () => {
    const t0 = Date.UTC(2031, 1, 3, 0, 0);
    // Cron runs every 15 minutes (10 s each), a login now and then, a staff page, a late note.
    const wakes: [number, number][] = [];
    for (let i = 0; i < 20; i++) wakes.push([t0 + i * 15 * MIN, t0 + i * 15 * MIN + 10_000]);
    wakes.push([t0 + 7 * MIN, t0 + 7 * MIN + 400], [t0 + 22 * MIN, t0 + 22 * MIN + 300], [t0 + 61 * MIN, t0 + 63 * MIN], [t0 + 30 * MIN + 1000, t0 + 30 * MIN + 2000]);
    wakes.sort((a, b) => a[0] - b[0]);
    wakes.push([t0 + 29 * MIN, t0 + 29 * MIN + 1]); // late: ended before the open window began (adds its own length)
    wakes.push([t0 + 284 * MIN, t0 + 284 * MIN + 500]); // late: reaching into the open window (moves its start back)
    let ref: NeonMonthRow | null = null;
    for (const [s, e] of wakes) {
      await noteNeonWake(withPlan(FREE), s, e, e);
      ref = addWake(ref, '2031-02', s, e);
    }
    const got = (await row('2031-02'))!;
    expect({ firstAt: got.first_at, closedMs: got.closed_ms, winStart: got.win_start, winEnd: got.win_end, windows: got.windows }).toEqual({ firstAt: ref!.firstAt, closedMs: ref!.closedMs, winStart: ref!.winStart, winEnd: ref!.winEnd, windows: ref!.windows });
    expect(got.first_at).toBe(t0);
    expect(got.win_start).toBe(t0 + 284 * MIN);
    // 20 cron windows and the logins at :07 and :22 (each after its run's window ended), each its own; the :30 one and
    // the page at :61 fall inside the run's window (the page extends it), and the late note too.
    expect(got.windows).toBe(22);
    expect(got.alerted).toBe(0);
    expect(awakeMsAt(ref!, t0 + 24 * 60 * MIN)).toBe(ref!.closedMs + (ref!.winEnd - ref!.winStart));
  });

  it('raises neon_compute_high once at 70% and once at 90% a month, and starts again next month', async () => {
    const t = Date.UTC(2031, 2, 10, 8, 0);
    const plan = withPlan(TINY);
    // 15 minutes awake is the allowance: 10.5 min is 70%, 13.5 min is 90%.
    await noteNeonWake(plan, t, t, t); // [t, t+5]
    await noteNeonWake(plan, t + 6 * MIN, t + 6 * MIN, t + 6 * MIN); // closes 5 min
    await noteNeonWake(plan, t + 12 * MIN, t + 12 * MIN, t + 12 * MIN); // closes 10 min: 66.7%
    expect(await events('2031-03')).toEqual([]);
    await noteNeonWake(plan, t + 13 * MIN, t + 13 * MIN, t + 13 * MIN); // 11 min: 73%
    expect((await events('2031-03')).map((e) => e.threshold)).toEqual([70]);
    expect((await row('2031-03'))!.alerted).toBe(70);
    for (const m of [13.5, 14, 14.5]) await noteNeonWake(plan, t + m * MIN, t + m * MIN, t + m * MIN);
    await noteNeonWake(plan, t + 16 * MIN, t + 16 * MIN, t + 16 * MIN); // 14 min: 93%
    await noteNeonWake(plan, t + 16.5 * MIN, t + 16.5 * MIN, t + 16.5 * MIN);
    const march = await events('2031-03');
    expect(march.map((e) => e.threshold)).toEqual([70, 90]);
    expect(march[1]).toEqual({ id: await eventId('neon_compute_high', '2031-03', '90'), month: '2031-03', threshold: 90, hoursUsed: 0.9, allowanceHours: 1, computeUnits: 4, estimate: true });
    expect((await row('2031-03'))!.alerted).toBe(90);
    // The 1st of the next month: a new row from 0, no alert until it is reached again.
    const april = Date.UTC(2031, 3, 1, 0, 0);
    await noteNeonWake(plan, april, april, april);
    expect(await row('2031-04')).toMatchObject({ closed_ms: 0, windows: 1, alerted: 0 });
    expect(await events('2031-04')).toEqual([]);
  });

  it('a jump past both thresholds raises both events; a failed D1 write is logged, never thrown', async () => {
    const t = Date.UTC(2031, 4, 2, 8, 0);
    await noteNeonWake(withPlan(TINY), t, t + 10 * MIN, t + 10 * MIN); // 10 min open: 66.7%
    await noteNeonWake(withPlan(TINY), t + 10 * MIN, t + 14 * MIN, t + 14 * MIN); // 14 min: 93%
    expect((await events('2031-05')).map((e) => e.threshold)).toEqual([70, 90]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = { ...withPlan(FREE), DB: { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('d1 down')) }) }) } } as unknown as typeof env;
    await expect(noteNeonWake(broken, t, t)).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('neon_wake_failed');
  });
});

describe('the API’s own ledger connections are noted (D872)', () => {
  it('a login’s usage write is a wake-up; without NEON_PLAN it notes nothing', async () => {
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    withCombinedCall(chain({ [aud]: app.scope }), { ckd: 'ok' });
    const month = new Date().toISOString().slice(0, 7);
    const before = await row(month);
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) });
    expect(res.status).toBe(200);
    expect(ledger.events.length).toBeGreaterThan(0);
    expect(await row(month)).toEqual(before);
    const res2 = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { NEON_PLAN: FREE } });
    expect(res2.status).toBe(200);
    const after = (await row(month))!;
    expect(after).not.toBeNull();
    expect(after.win_end).toBeGreaterThanOrEqual(Date.now() - 60_000 + NEON_SUSPEND_MS);
  });

  it('the hourly partitions call is a wake-up; a copy with nothing to copy opens no connection and notes nothing', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare('DELETE FROM neon_compute WHERE month = ?1').bind(month).run();
    await env.DB.prepare('DELETE FROM identity_usage').run();
    const calls = ledger.calls.length;
    await syncIdentityUsage(withPlan(FREE));
    expect(ledger.calls.length).toBe(calls);
    expect(await row(month)).toBeNull();
    await ensureUsagePartitions(withPlan(FREE));
    expect(ledger.calls.length).toBe(calls + 1);
    expect(await row(month)).toMatchObject({ windows: 1 });
  });
});

describe('a console report’s wake-up is noted after its answer (D872 after review)', () => {
  it('the answer doesn’t wait for the note; the note lands with the RPC’s waitUntil', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare('DELETE FROM neon_compute WHERE month = ?1').bind(month).run();
    vi.spyOn(reportTransport, 'rows').mockResolvedValue([]);
    const pending: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const rows = await orgStatements(withPlan(FREE), { ...member(), orgId: 'org_neon1' } as never, Date.now(), exec);
    expect(rows).toEqual([]);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await row(month)).toMatchObject({ windows: 1 });
    // Without the plan nothing is scheduled.
    const none: Promise<unknown>[] = [];
    await orgStatements(withPlan(undefined), { ...member(), orgId: 'org_neon1' } as never, Date.now(), { waitUntil: (p) => void none.push(p) });
    expect(none).toEqual([]);
  });
});

describe('AdminRpc.neonWake (D872)', () => {
  const rpc = (plan: string | undefined) => new AdminRpc(createExecutionContext(), withPlan(plan));
  const runs = [
    { key: 'ledger_cron.last_run' as const, value: JSON.stringify({ at: 1, budgetLeft: 30, calls: { ledger: 1 }, failed: [] }) },
    { key: 'ledger.health' as const, value: JSON.stringify({ at: 1, ok: true, partitionsAhead: 12, settlement: { pending: 0, oldestAt: null } }) },
  ];

  it('notes nothing and stores nothing without NEON_PLAN', async () => {
    await env.DB.prepare('DELETE FROM neon_admin_runs').run();
    const now = Date.now();
    expect(await rpc(undefined).neonWake({ ...system(), startMs: now - 1000, endMs: now, runs })).toEqual({ ok: true, noted: false });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM neon_admin_runs').first<{ n: number }>())!.n).toBe(0);
  });

  it('notes the wake-up and keeps each run’s latest record; the System status answer carries both', async () => {
    const now = Date.now();
    expect(await rpc(FREE).neonWake({ ...system(), startMs: now - 2000, endMs: now - 1000, runs })).toEqual({ ok: true, noted: true });
    const newer = { key: 'ledger.health' as const, value: JSON.stringify({ at: 2, ok: false }) };
    expect(await rpc(FREE).neonWake({ ...hana(), startMs: now - 500, endMs: now, runs: [newer] })).toMatchObject({ ok: true, noted: true });
    governanceViews(ownerChain());
    const s = await rpc(FREE).systemStatus(hana());
    if (!s.ok) throw new Error('no status');
    expect(s.neon?.state).toBe('on');
    if (s.neon?.state !== 'on') return;
    expect(s.neon.plan).toEqual({ computeHoursPerMonth: 100, computeUnits: 0.25 });
    expect(s.neon.month).toBe(new Date().toISOString().slice(0, 7));
    expect(s.neon.row).toMatchObject({ windows: expect.any(Number) as number });
    expect(s.neon.row!.winEnd).toBeGreaterThanOrEqual(now + NEON_SUSPEND_MS);
    expect(JSON.parse(s.neon.runs['ledger.health']!.value)).toEqual({ at: 2, ok: false });
    expect(JSON.parse(s.neon.runs['ledger_cron.last_run']!.value)).toMatchObject({ budgetLeft: 30 });
    // Without the plan the status says off and reads nothing.
    const off = await rpc(undefined).systemStatus(hana());
    expect(off.ok && off.neon).toEqual({ state: 'off' });
  });

  it('neonAdminRun answers a run’s stored record, or null; staff or the crons only', async () => {
    await env.DB.prepare('DELETE FROM neon_admin_runs').run();
    expect(await rpc(FREE).neonAdminRun({ ...system(), key: 'cron.last_run' })).toEqual({ ok: true, run: null });
    const now = Date.now();
    await rpc(FREE).neonWake({ ...system(), startMs: now - 1000, endMs: now, runs: [{ key: 'cron.last_run', value: '{"at":5,"feed":true,"watcher":true}' }] });
    const r = await rpc(FREE).neonAdminRun({ ...system(), key: 'cron.last_run' });
    expect(r).toMatchObject({ ok: true, run: { value: '{"at":5,"feed":true,"watcher":true}' } });
    expect(await rpc(FREE).neonAdminRun({ ...member(), key: 'cron.last_run' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc(FREE).neonAdminRun({ ...system(), key: 'feed.app_changes.seq' })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('refuses a member, a record that isn’t JSON, an unknown key, a window longer than a run and a start an hour off the clock', async () => {
    const now = Date.now();
    for (const startMs of [now - 61 * MIN, now + 61 * MIN]) expect(await rpc(FREE).neonWake({ ...system(), startMs, endMs: startMs })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpc(FREE).neonWake({ ...system(), startMs: now - 59 * MIN, endMs: now - 59 * MIN })).toMatchObject({ ok: true, noted: true });
    expect(await rpc(FREE).neonWake({ ...member(), startMs: now, endMs: now })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc(FREE).neonWake({ ...system(), startMs: now, endMs: now, runs: [{ key: 'cron.last_run', value: 'not json' }] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpc(FREE).neonWake({ ...system(), startMs: now, endMs: now, runs: [{ key: 'feed.app_changes.seq', value: '1' }] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpc(FREE).neonWake({ ...system(), startMs: now, endMs: now + 16 * MIN })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
