// The partner console's pending-upgrades backend (batch C14, D86; src/governance.ts), structured for C10 to route under
// the session check: scoped to the member's org (another org, an unknown one, a disabled user: 404, and no RPC call),
// over the real ConsoleRpc (which can't reach NEAR here, so near_unavailable proves the wiring) and over a stand-in API
// for the answer itself.
import { LEGACY_ORG_ID, type PendingUpgradesView } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import { type MemberActor, pendingUpgradesRoute } from '../src/governance.ts';
import { request, rid, seedMember, seedOrg, seedUser } from './helpers.ts';

const info = () => ({ requestId: rid(), clientIp: '203.0.113.7', country: null });
const actorOf = (u: { id: string; sub: string; email: string }): MemberActor => ({ kind: 'member', id: u.id, sub: u.sub, email: u.email, sessionHash: 'A'.repeat(43) });

const VIEW: PendingUpgradesView = {
  signer: 'signer.test.near',
  env: 'sandbox-test',
  readAtMs: 1,
  paused: false,
  governanceDelayMs: 60_000,
  upgrade: { codeHash: '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp', proposedAtMs: 1, executableAtMs: 60_001, due: false, release: null },
  ownerTransfer: null,
  withdrawal: null,
  delayDecreases: [],
  consoleAudienceAdditions: [],
  anyPending: true,
};

/** A stand-in API that records the calls and answers `answer`. */
function fakeApi(answer: unknown = { ok: true, pendingUpgrades: VIEW }) {
  const calls: unknown[] = [];
  const api = { pendingUpgrades: async (c: unknown) => (calls.push(c), typeof answer === 'function' ? (answer as () => unknown)() : answer) } as unknown as Env['API'];
  return { calls, e: { ...env, API: api } as Env };
}

describe('pendingUpgradesRoute', () => {
  it('a member of the org gets the view; the RPC carries the member actor and the org', async () => {
    const org = await seedOrg();
    const u = await seedMember(org, 'viewer');
    const { calls, e } = fakeApi();
    const i = info();
    const res = await pendingUpgradesRoute(e, i, actorOf(u), org);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pendingUpgrades: VIEW });
    expect(calls).toEqual([{ actor: actorOf(u), requestId: i.requestId, clientIp: '203.0.113.7', orgId: org }]);
  });

  it('scoped to the org: another org, an unknown org, a malformed id, a disabled user are 404 with no RPC call', async () => {
    const mine = await seedOrg();
    const other = await seedOrg();
    const u = await seedMember(mine, 'owner');
    const disabled = await seedMember(mine, 'owner', await seedUser({ disabled: true }));
    const { calls, e } = fakeApi();
    for (const [actor, org] of [
      [actorOf(u), other],
      [actorOf(u), 'org_doesnotexist1'],
      [actorOf(u), "org_x' OR 1=1"],
      [actorOf(disabled), mine],
    ] as const) {
      const res = await pendingUpgradesRoute(e, info(), actor, org);
      expect(res.status, org).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(calls).toEqual([]);
  });

  it('crosses the real binding into the real ConsoleRpc (NEAR unreachable here: near_unavailable, 503)', async () => {
    const org = await seedOrg();
    const u = await seedMember(org, 'viewer');
    const res = await pendingUpgradesRoute(env as Env, info(), actorOf(u), org);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'near_unavailable' } });
  });

  it('the real API refuses the legacy org (the console never acts for it)', async () => {
    const u = await seedMember(LEGACY_ORG_ID, 'viewer');
    const res = await pendingUpgradesRoute(env as Env, info(), actorOf(u), LEGACY_ORG_ID);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('keeps the RPC’s status with its own message; a binding that throws is near_unavailable', async () => {
    const org = await seedOrg();
    const u = await seedMember(org, 'viewer');
    const limited = fakeApi({ ok: false, code: 'rate_limited', error: 'internal detail from the API' });
    const res = await pendingUpgradesRoute(limited.e, info(), actorOf(u), org);
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).not.toContain('internal detail');
    const down = fakeApi(() => Promise.reject(new Error('Service unavailable')));
    expect((await pendingUpgradesRoute(down.e, info(), actorOf(u), org)).status).toBe(503);
  });

  it('C10 routes it behind the session: 401 without one, 404 for an org the member isn’t in', async () => {
    expect((await request('/api/orgs/org_abc/governance/pending-upgrades')).status).toBe(401);
    const { member, getAs } = await import('./c10.ts');
    const m = await member('viewer');
    expect((await getAs(m, '/api/orgs/org_abc/governance/pending-upgrades')).status).toBe(404);
    // A member reaches the real ConsoleRpc (which can't read the chain here, so it is near_unavailable, not 404).
    expect((await getAs(m, `/api/orgs/${m.org}/governance/pending-upgrades`)).status).not.toBe(404);
  });
});
