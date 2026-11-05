// StaffRpc.recordStaffAction (batch C12, D327): the audit row of a statement issued, a ledger export or a rate override,
// written by the admin Worker with the staff actor. Hana actors only; the action's allowlisted details only; idempotent
// on (request id, action); never a way to write another action.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hana, seedOrg, staffRpc, system } from './helpers.ts';

describe('StaffRpc.recordStaffAction', () => {
  it('appends the audit row with the staff actor; a repeat of the request is already_applied and writes nothing', async () => {
    const org = await seedOrg();
    const c = { ...hana(), orgId: org, action: 'statement.issued', target: '2026-01', details: { month: '2026-01', csvSha256: 'ab'.repeat(32), asOf: 1_800_000_000_000, lines: 9 } };
    expect(await staffRpc().recordStaffAction(c)).toEqual({ ok: true });
    expect(await staffRpc().recordStaffAction(c)).toMatchObject({ ok: false, code: 'already_applied' });
    const rows = await env.CONSOLE_DB.prepare("SELECT actor_kind, actor_id, actor_email, org_id, target, details_json, outcome FROM audit_log WHERE request_id = ? AND action = 'statement.issued'").bind(c.requestId).all();
    expect(rows.results).toEqual([
      { actor_kind: 'hana', actor_id: 'access-sub-staff-1', actor_email: 'staff@hana.example', org_id: org, target: '2026-01', details_json: JSON.stringify(c.details), outcome: 'ok' },
    ]);
    // It reaches the feed like every other row.
    const since = await staffRpc().auditSince({ ...system(), seq: 0, limit: 500 });
    expect(since.ok && since.rows.some((r) => r.action === 'statement.issued' && r.requestId === c.requestId)).toBe(true);
  });

  it('refuses another actor, an unknown action and a detail the action doesn’t record', async () => {
    const base = { orgId: await seedOrg(), target: '2026-01', details: { month: '2026-01' } };
    expect(await staffRpc().recordStaffAction({ ...system(), ...base, action: 'ledger.exported' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await staffRpc().recordStaffAction({ ...hana(), ...base, action: 'member.added' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await staffRpc().recordStaffAction({ ...hana(), ...base, action: 'ledger.exported', details: { month: '2026-01', email: 'x@y.example' } })).toMatchObject({ ok: false, code: 'bad_request', error: expect.stringMatching(/details\.email/u) });
    expect(await staffRpc().recordStaffAction({ ...hana(), ...base, action: 'rate.overridden', details: { day: '2026-01-10', usdMicros: '2500000', overrideId: 3 } })).toEqual({ ok: true });
  });

  it('records a Support ID lookup without an org, so no partner audit view lists it, and refuses one with an org (C15)', async () => {
    const org = await seedOrg();
    const c = { ...hana(), action: 'support.lookup', target: 'HANA-2750-G5HM', details: { by: 'supportId', ticket: 'T-1', requestIds: 2, days: 30 } };
    expect(await staffRpc().recordStaffAction(c)).toEqual({ ok: true });
    const row = await env.CONSOLE_DB.prepare("SELECT org_id, target, details_json FROM audit_log WHERE request_id = ? AND action = 'support.lookup'").bind(c.requestId).first();
    expect(row).toEqual({ org_id: null, target: 'HANA-2750-G5HM', details_json: JSON.stringify(c.details) });
    // The partner audit view reads `WHERE org_id = ?` (bff.ts orgAudit): an org-less row is in no org's.
    const partner = await env.CONSOLE_DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND action = 'support.lookup'").bind(org).first<{ n: number }>();
    expect(partner?.n).toBe(0);
    expect(await staffRpc().recordStaffAction({ ...hana(), orgId: org, action: 'support.lookup', details: { by: 'supportId' } })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await staffRpc().recordStaffAction({ ...hana(), action: 'support.lookup', details: { by: 'supportId', email: 'x@y.example' } })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
