// Batch C14's governance RPCs (D83, D86): AdminRpc.governance (the whole GET /v1/governance snapshot, staff only),
// AdminRpc.pendingUpgrades and ConsoleRpc.pendingUpgrades (the pending-upgrades page's view, the same for both
// consoles, with nothing staff-only in it), each refusing the wrong actors and failing closed when the chain can't be
// read.
import { LEGACY_ORG_ID, pendingUpgradesView } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GovernanceStatus } from '../src/governance-status.ts';
import { call } from './helpers.ts';
import { UPDATER_PK, UPGRADE_HASH, adminRpc, consoleRpc, governanceViews, hana, member, newOrg, ownClock, ownerChain, system } from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

describe('AdminRpc.governance', () => {
  it('answers the GET /v1/governance snapshot to staff, with the access keys and the updater', async () => {
    governanceViews(ownerChain());
    const r = await adminRpc().governance(hana());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.governance as GovernanceStatus;
    expect(g.pendingUpgrade).toMatchObject({ codeHash: UPGRADE_HASH, due: false });
    expect(g.updaterKeys).toEqual([UPDATER_PK]);
    expect(g.signerAccessKeys).toEqual([expect.objectContaining({ publicKey: UPDATER_PK, kind: 'full_access', updaterKey: true, updaterPermission: false })]);
    expect(g.updater).toEqual({ lastRuns: [], proposals: [] });
    // The same snapshot the public endpoint serves (one read for both within GOVERNANCE_CACHE_MS).
    const pub = (await (await call('/v1/governance')).json()) as Record<string, unknown>;
    const { requestId: _r, ...rest } = pub;
    expect(rest).toEqual(JSON.parse(JSON.stringify(g)));
  });

  it('is staff only: a member or the cron is forbidden; an extra field is bad_request', async () => {
    governanceViews(ownerChain());
    expect(await adminRpc().governance(member())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().governance(system())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().governance({ ...hana(), orgId: newOrg() })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('pendingUpgrades (both consoles)', () => {
  it('AdminRpc and ConsoleRpc give the same view, built from the snapshot', async () => {
    ownClock();
    governanceViews(ownerChain());
    const admin = await adminRpc().pendingUpgrades(hana());
    const partner = await consoleRpc().pendingUpgrades({ ...member(), orgId: newOrg() });
    expect(admin.ok && partner.ok).toBe(true);
    if (!admin.ok || !partner.ok) return;
    expect(partner.pendingUpgrades).toEqual(admin.pendingUpgrades);
    const g = await adminRpc().governance(hana());
    if (!g.ok) throw new Error(g.code);
    expect(admin.pendingUpgrades).toEqual(pendingUpgradesView(g.governance as GovernanceStatus));
    expect(admin.pendingUpgrades).toMatchObject({
      upgrade: { codeHash: UPGRADE_HASH, release: null, due: false },
      ownerTransfer: { owner: 'new-dao.sputnik.test.near', due: false },
      withdrawal: null,
      delayDecreases: [{ delay: 'governance', currentMs: 259_200_000, valueMs: 3_600_000 }],
      consoleAudienceAdditions: [{ provider: 'google', aud: 'console2.apps.googleusercontent.com' }],
      anyPending: true,
    });
  });

  it('a partner sees nothing staff-only: no access keys, updater keys, watchdogs, key changes or cron state', async () => {
    ownClock();
    governanceViews(ownerChain());
    const r = await consoleRpc().pendingUpgrades({ ...member(), orgId: newOrg() });
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r);
    for (const absent of [UPDATER_PK, 'watchdog.test.near', 'signerAccessKeys', 'updaterKeys', 'keyChanges', 'watchdogs', 'updater', 'issuers', 'sessionsValidFromMs']) expect(text, absent).not.toContain(absent);
  });

  it('ConsoleRpc: member actors only, an org id, never the legacy org', async () => {
    ownClock();
    governanceViews(ownerChain());
    expect(await consoleRpc().pendingUpgrades({ ...hana(), orgId: newOrg() })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc().pendingUpgrades({ ...member(), orgId: LEGACY_ORG_ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc().pendingUpgrades(member())).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc().pendingUpgrades({ ...member(), orgId: "org_x' OR 1=1" })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().pendingUpgrades(member())).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('is charged to the org: one org’s refreshes run out its own budget only', async () => {
    ownClock({ freeze: true });
    governanceViews(ownerChain());
    const a = newOrg();
    const rpc = consoleRpc();
    let ok = 0;
    let refused: unknown;
    for (let k = 0; k < 60 && !refused; k++) {
      const r = await rpc.pendingUpgrades({ ...member(), orgId: a });
      if (r.ok) ok++;
      else refused = r;
    }
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(ok).toBeGreaterThan(0);
    expect(await rpc.pendingUpgrades({ ...member(), orgId: newOrg() })).toMatchObject({ ok: true });
  });
});

describe('failing closed', () => {
  it('a NEAR outage is near_unavailable on all three, never a partial answer', async () => {
    ownClock();
    const near = governanceViews(ownerChain());
    delete near.views.get_governance;
    for (const r of [await adminRpc().governance(hana()), await adminRpc().pendingUpgrades(hana()), await consoleRpc().pendingUpgrades({ ...member(), orgId: newOrg() })]) {
      expect(r).toMatchObject({ ok: false, code: 'near_unavailable' });
    }
  });

  it('a view of an unknown shape is near_unavailable too', async () => {
    const near = governanceViews(ownerChain());
    near.views.get_governance = () => ({ state_version: 'two' });
    expect(await adminRpc().governance(hana())).toEqual({ ok: false, code: 'near_unavailable', error: 'The contract answered with an unexpected governance state' });
  });
});
