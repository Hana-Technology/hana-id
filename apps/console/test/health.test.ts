// The console's part of the admin console's System status page (D425): the hourly cron records its last run in
// `cron_runs` (migration 0003), and `StaffRpc.health` answers the build, a timed D1 probe, that run, the member-notice
// backlog and a LOGOS probe. Staff only, read-only, no user data.
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOURLY_JOB, hourly } from '../src/cron.ts';
import { StaffRpc } from '../src/staff-rpc.ts';
import { db, hana, member, seedOrg, staffRpc, system } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const cronRow = () => db.prepare('SELECT job, at_ms, outcome, failed_steps FROM cron_runs WHERE job = ?').bind(HOURLY_JOB).first();

describe('the hourly cron records its run (cron_runs)', () => {
  it('ok with no failed step; error with the failed steps’ names, the next run replacing the row', async () => {
    const now = Date.now();
    await hourly(env, now);
    expect(await cronRow()).toEqual({ job: 'hourly', at_ms: now, outcome: 'ok', failed_steps: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.prepare("INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES ('logos/app_h/x.png', 'app_h', 0, 0)").run();
    await hourly({ ...env, LOGOS: { delete: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket }, now + 1);
    expect(await cronRow()).toEqual({ job: 'hourly', at_ms: now + 1, outcome: 'error', failed_steps: 'logos' });
    await db.prepare("DELETE FROM logo_objects WHERE key = 'logos/app_h/x.png'").run();
  });

  it('a failed record (no table) is logged and the steps still ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noTable = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => (/cron_runs/u.test(sql) ? { bind: () => ({ run: () => Promise.reject(new Error('D1_ERROR: no such table: cron_runs')) }) } : target.prepare(sql));
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await hourly({ ...env, CONSOLE_DB: noTable as D1Database }, Date.now());
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('"step":"record"')]);
  });
});

describe('StaffRpc.health', () => {
  it('answers the build, the D1 probe, the last run, the notice backlog and LOGOS', async () => {
    const now = Date.now();
    await hourly(env, now);
    const org = await seedOrg();
    const invite = await staffRpc().issueInvite({ ...hana(), email: `${Math.random().toString(36).slice(2)}@partner.example`, role: 'viewer', orgId: org });
    expect(invite.ok).toBe(true);
    const r = await new StaffRpc(createExecutionContext(), { ...env, HANA_BUILD: '0485faa1c2d3' }).health(hana());
    expect(r).toMatchObject({ ok: true, build: '0485faa1c2d3', db: { ok: true }, cron: { job: 'hourly', atMs: now, outcome: 'ok', detail: null }, logos: 'ok' });
    if (!r.ok) return;
    expect(r.notices!.pending).toBeGreaterThanOrEqual(1);
    expect(typeof r.notices!.oldestAt).toBe('number');
    // No user data: the invitee's address isn't in the answer.
    expect(JSON.stringify(r)).not.toContain('@partner.example');
  });

  it('reports a missing cron_runs table as `missing`, a failing D1 as db.ok false, no LOGOS as null', async () => {
    const broken = { prepare: () => ({ first: () => Promise.reject(new Error('D1_ERROR: no such table: cron_runs')), bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: no such table: cron_runs')), all: () => Promise.reject(new Error('down')) }) }) } as unknown as D1Database;
    const r = await new StaffRpc(createExecutionContext(), { ...env, CONSOLE_DB: broken, LOGOS: undefined }).health(hana());
    expect(r).toMatchObject({ ok: true, db: { ok: false }, cron: 'missing', notices: null, logos: null });
    const r2 = await new StaffRpc(createExecutionContext(), { ...env, LOGOS: { head: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket }).health(hana());
    expect(r2).toMatchObject({ ok: true, logos: 'error' });
  });

  it('is staff only and takes no field beyond the context', async () => {
    expect(await staffRpc().health(member())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await staffRpc().health(system())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await staffRpc().health({ ...hana(), orgId: 'org_x' })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
