// The C13 retention screen and RPCs in the Worker (the job itself runs on PGlite in test-ops/retention.test.ts):
// `GET /api/retention` needs a staff Access JWT and a ledger, shows the month's state, a warning until a run succeeds,
// the runs with their rows and errors, what waits for a person and the erasures; and the retention methods of the real
// AdminRpc and StaffRpc answer the admin's cron actor across the service bindings, and refuse a staff one.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { dueAt } from '../src/retention.ts';
import type { RetentionRun, RetentionStore } from '../src/retention-store.ts';
import { retentionStub } from './retention-stub.ts';
import { staffCtx, systemCtx } from '../src/rpc.ts';
import { adminRequest, json, stubNetwork } from './helpers.ts';

const e = env as unknown as Env;

const withRetention = (r: RetentionStore) => vi.spyOn(ledgerSource, 'open').mockImplementation(async () => ({ retention: r, close: async () => {} }) as unknown as LedgerStore);

beforeEach(async () => {
  await stubNetwork();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const run = (over: Partial<RetentionRun>): RetentionRun => ({ id: 1, month: '2026-11', startedAt: Date.UTC(2026, 10, 1, 1), finishedAt: Date.UTC(2026, 10, 1, 1, 1), status: 'ok', rows: {}, error: null, alertedAt: null, ...over });

describe('GET /api/retention', () => {
  it('needs a staff Access JWT and a ledger', async () => {
    expect((await adminRequest('/api/retention', { jwt: null })).status).toBe(401);
    const r = await adminRequest('/api/retention');
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ error: { code: 'ledger_unavailable' } });
  });

  it('lists the runs with their rows, what waits for a person and the erasures; no warning once the month is done', async () => {
    const ok = run({ id: 7, rows: { uidsStripped: 12, appChangesDeleted: 3, calls: 4, due: { statements: 1, rates: 31, rateOverrides: 0, oldestStatement: '2019-10' } } });
    withRetention(retentionStub({ runs: [ok], done: true }));
    const r = await adminRequest('/api/retention');
    expect(r.status).toBe(200);
    const body = (await json(r)) as Record<string, unknown>;
    expect(body).toMatchObject({ state: 'done', done: true, warning: null, maxCallsPerRun: 12, due: { statements: 1, rates: 31, oldestStatement: '2019-10' } });
    expect(body.runs).toEqual([ok]);
    expect(body.erasures).toEqual([expect.objectContaining({ ticket: 'SUP-42', scopeId: 's7' })]);
    expect(body.dueAt).toBe(dueAt(Date.now()));
  });

  it('warns while the last run failed, and while the month has no complete run an hour after it was due', async () => {
    withRetention(retentionStub({ runs: [run({ status: 'failed', error: 'directory: internal' })] }));
    const failed = (await json(await adminRequest('/api/retention'))) as { warning: string | null };
    expect(failed.warning).toMatch(/failed: directory: internal/u);
    vi.restoreAllMocks();
    await stubNetwork();
    withRetention(retentionStub({ runs: [run({ status: 'partial' })] }));
    const partial = (await json(await adminRequest('/api/retention'))) as { warning: string | null; state: string };
    if (Date.now() >= dueAt(Date.now()) + 60 * 60_000) {
      expect(partial.warning).toMatch(/No run of \d{4}-\d{2} has completed yet \(the last one ran out of its calls/u);
      expect(partial.state).toBe('continuing');
    }
  });
});

describe('the retention RPCs across the service bindings', () => {
  it('answer the admin cron’s system actor and refuse a staff actor', async () => {
    const now = Date.now();
    expect(await e.API.purgeAudit({ ...systemCtx(), before: now, limit: 10 })).toMatchObject({ ok: true, appChanges: expect.any(Number), guardedChanges: expect.any(Number) });
    expect(await e.API.deletedApps({ ...systemCtx(), before: now, limit: 10 })).toMatchObject({ ok: true, appIds: expect.any(Array), more: false });
    expect(await e.API.purgeDirectory({ ...systemCtx(), before: now, limit: 10 })).toMatchObject({ ok: true, users: 0 });
    expect(await e.CONSOLE.purgeAudit({ ...systemCtx(), before: now, limit: 10 })).toMatchObject({ ok: true, auditLog: expect.any(Number) });
    const staff = staffCtx({ actor: { kind: 'hana', id: 'access-sub-1', email: 'staff@hana.example' }, requestId: 'req_staff_retention_1', clientIp: '198.51.100.9' });
    expect(await e.API.purgeAudit({ ...staff, before: now, limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await e.CONSOLE.purgeAudit({ ...staff, before: now, limit: 10 })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
