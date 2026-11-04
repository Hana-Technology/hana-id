// Retention's shared pieces (src/retention.ts; batch C13, D360–D369): the D90 cutoffs as the SQL triggers compute them
// (SQLite's `'-N months'`: an overflowing day rolls forward) and the retention RPCs' inputs.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AUDIT_KEEP_MONTHS, DELETED_APP_GRACE_MS, auditCutoff, deletedAppCutoff, deletedAppsInput, monthsBefore, purgeAuditInput, purgeDirectoryInput } from '../src/index.ts';

const ctx = { actor: { kind: 'system' as const, id: 'admin-cron' }, requestId: 'cron_12345678', clientIp: '0.0.0.0' };

describe('the cutoffs', () => {
  it('monthsBefore matches SQLite’s date arithmetic, end-of-month overflow included', () => {
    const db = new DatabaseSync(':memory:');
    const sqlite = (iso: string, k: number) => Date.parse(`${(db.prepare(`SELECT datetime(?, ?) AS d`).get(iso, `-${k} months`) as { d: string }).d.replace(' ', 'T')}Z`);
    for (const iso of ['2031-03-31T12:34:56Z', '2031-01-15T00:00:00Z', '2032-02-29T23:59:59Z', '2031-12-31T01:00:00Z', '2031-05-31T00:00:00Z']) {
      for (const k of [1, 12, 24, 60]) expect(monthsBefore(Date.parse(iso), k), `${iso} -${k}`).toBe(sqlite(iso.replace('Z', ''), k));
    }
    expect(new Date(monthsBefore(Date.parse('2031-03-31T00:00:00Z'), 1)).toISOString()).toBe('2031-03-03T00:00:00.000Z');
  });

  it('the audit cutoff is 60 months back; deleted apps wait 30 days', () => {
    const now = Date.parse('2031-07-15T01:00:00Z');
    expect(AUDIT_KEEP_MONTHS).toBe(60);
    expect(new Date(auditCutoff(now)).toISOString()).toBe('2026-07-15T01:00:00.000Z');
    expect(deletedAppCutoff(now)).toBe(now - 30 * 86_400_000);
    expect(DELETED_APP_GRACE_MS).toBe(30 * 86_400_000);
  });
});

describe('the retention RPC inputs', () => {
  it('take a time and a batch of 1–1000; deletedApps a cursor of a deletion time and an app id; nothing else', () => {
    expect(purgeAuditInput.safeParse({ ...ctx, before: 1, limit: 500 }).success).toBe(true);
    for (const limit of [0, 1001, 1.5]) expect(purgeAuditInput.safeParse({ ...ctx, before: 1, limit }).success, String(limit)).toBe(false);
    expect(purgeAuditInput.safeParse({ ...ctx, before: -1, limit: 1 }).success).toBe(false);
    expect(purgeAuditInput.safeParse({ ...ctx, before: 1, limit: 1, extra: true }).success).toBe(false);
    expect(purgeDirectoryInput.safeParse({ ...ctx, before: 1, limit: 1000 }).success).toBe(true);
    expect(deletedAppsInput.safeParse({ ...ctx, before: 1 }).success).toBe(true);
    expect(deletedAppsInput.safeParse({ ...ctx, before: 1, after: '1730000000000:app_abc', limit: 10 }).success).toBe(true);
    for (const after of ['', 'x:app_a', '1:usr_a', '01:app_a', '1:app_a;DROP']) expect(deletedAppsInput.safeParse({ ...ctx, before: 1, after }).success, after).toBe(false);
  });
});
