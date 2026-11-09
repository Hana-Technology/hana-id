// AdminRpc.systemStatus (D425; apps/admin/README.md "System status"): the API's view of itself for the admin console's
// landing page, in one call. Staff only, read-only, no user data: a timed hot-DB probe, the Google-key sync's last
// runs, the notice backlog, both pools' public keys and the governance snapshot, each failing on its own.
import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminRpc } from '../src/rpc/admin.ts';
import { UPGRADE_HASH, adminRpc, governanceViews, hana, member, newOrg, orgApp, ownerChain, system } from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

describe('AdminRpc.systemStatus', () => {
  it('answers the build, the hot DB, the sync runs, the backlog, the pool keys and the governance snapshot', async () => {
    governanceViews(ownerChain());
    await env.DB.prepare("INSERT INTO issuer_key_sync_runs (provider, at_ms, outcome, code, summary) VALUES ('google', ?1, 'skipped', 'jwks_fetch_failed', '{}') ON CONFLICT (provider) DO UPDATE SET at_ms = excluded.at_ms, outcome = excluded.outcome, code = excluded.code")
      .bind(1_800_000_000_000)
      .run();
    const r = await adminRpc().systemStatus(hana());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hotDb).toMatchObject({ ok: true });
    expect(r.hotDb.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.jwksSync).toEqual([{ job: 'jwks_sync:google', atMs: 1_800_000_000_000, outcome: 'skipped', detail: 'jwks_fetch_failed' }]);
    expect(r.notices).toMatchObject({ truncated: false });
    expect(Array.isArray(r.relayerKeys)).toBe(true);
    expect(r.governance.ok).toBe(true);
    if (r.governance.ok) expect(r.governance.snapshot.pendingUpgrade).toMatchObject({ codeHash: UPGRADE_HASH });
    // The test Worker has no HANA_BUILD: unstamped is null, never a guess.
    expect(r.build).toBeNull();
  });

  it('reports the build id only when it is one', async () => {
    governanceViews(ownerChain());
    const stamped = await new AdminRpc(createExecutionContext(), { ...env, HANA_BUILD: '0485faa1c2d3-dirty' }).systemStatus(hana());
    expect(stamped).toMatchObject({ ok: true, build: '0485faa1c2d3-dirty' });
    const junk = await new AdminRpc(createExecutionContext(), { ...env, HANA_BUILD: 'not a build; <script>' }).systemStatus(hana());
    expect(junk).toMatchObject({ ok: true, build: null });
  });

  it('counts the guarded changes waiting for their notice, oldest first', async () => {
    governanceViews(ownerChain());
    const before = await adminRpc().systemStatus(hana());
    if (!before.ok || !before.notices) throw new Error('no backlog');
    const app = await orgApp();
    const at = Date.now() - 3_600_000;
    await env.DB.prepare(
      "INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', 'https://status.example', 'pending', 'hana', 'staff', ?3, ?4)",
    )
      .bind(`gc_sys_${crypto.randomUUID()}`, app.id, at, `req_${crypto.randomUUID()}`)
      .run();
    const after = await adminRpc().systemStatus(hana());
    if (!after.ok || !after.notices) throw new Error('no backlog');
    expect(after.notices.pending).toBe(before.notices.pending + 1);
    expect(after.notices.oldestAt).toBeLessThanOrEqual(at);
  });

  it('a NEAR outage leaves the D1 parts standing (governance near_unavailable)', async () => {
    const near = governanceViews(ownerChain());
    delete near.views.get_governance;
    const r = await adminRpc().systemStatus(hana());
    expect(r).toMatchObject({ ok: true, hotDb: { ok: true }, governance: { ok: false, code: 'near_unavailable' } });
  });

  it('a D1 failure is a failed probe and null parts, never a thrown call', async () => {
    governanceViews(ownerChain());
    const broken = {
      prepare: () => {
        throw new Error('D1 down');
      },
      batch: () => Promise.reject(new Error('D1 down')),
    } as unknown as D1Database;
    const r = await new AdminRpc(createExecutionContext(), { ...env, DB: broken }).systemStatus(hana());
    expect(r).toMatchObject({ ok: true, hotDb: { ok: false }, jwksSync: null, notices: null });
  });

  it('is staff only and takes no field beyond the context', async () => {
    expect(await adminRpc().systemStatus(member())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().systemStatus(system())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().systemStatus({ ...hana(), orgId: newOrg() })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('answers no secret: pool keys are public keys only', async () => {
    governanceViews(ownerChain());
    const r = await adminRpc().systemStatus(hana());
    const text = JSON.stringify(r);
    for (const secret of [env.RELAYER_KEYS, env.OWNER_RELAYER_KEYS, env.KEYS_UPDATER_KEY].filter((v): v is string => typeof v === 'string' && v.length > 10)) {
      for (const k of secret.match(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/gu) ?? []) expect(text).not.toContain(k);
    }
  });
});
