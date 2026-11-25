// The SPA's local preview harness (apps/console/preview, dev only): its fake answers have the console's exact shapes
// (console-core's schemas), its scenarios behave as named (signed out is 401, a viewer's write 403, errors refuse),
// it serves only on 127.0.0.1 and only in `vite serve`, its redirect stays on the server, and nothing of it is built
// into dist/ (spa-build.test.ts checks the bundle too).
import { CONFIRM_WORDS, appDetail, appSummary, auditAnswer, confirmationChangeView, meAnswer, membersAnswer, orgAnswer, statementMeta, usageRow } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';
import * as F from '../../preview/fixtures.ts';
import { PreviewState, SCENARIOS, answer } from '../../preview/mock-api.ts';
import { SCENARIO_RE, mockApi, safeTo, scenarioOf } from '../../preview/plugin.ts';
import config from '../../preview/vite.config.ts';

const now = Date.UTC(2026, 10, 6, 4, 0);
const get = (scenario: (typeof SCENARIOS)[number], path: string) => answer(scenario, 'GET', new URL(path, 'http://127.0.0.1'), undefined, new PreviewState(), now);

describe('the fixtures have the console’s shapes', () => {
  it('me, org, apps, app details, members, audit, usage, statements', () => {
    expect(meAnswer.safeParse(F.me({ multi: true, users: true, role: 'owner', frozen: false })).success).toBe(true);
    expect(orgAnswer.safeParse(F.org(F.ORG_ID, 'viewer', true)).success).toBe(true);
    for (const a of F.appDetails(now)) {
      expect(appDetail.safeParse(a).error?.issues).toBeUndefined();
      expect(appSummary.safeParse(F.summaryOf(a)).success).toBe(true);
    }
    expect(membersAnswer.safeParse(F.members(now)).error?.issues).toBeUndefined();
    expect(auditAnswer.safeParse(F.audit(now)).error?.issues).toBeUndefined();
    for (const r of [...F.usage(now, 'day', []), ...F.usage(now, 'month', ['app_Lm4Pq9Zs2v'])]) expect(usageRow.safeParse(r).error?.issues).toBeUndefined();
    for (const s of F.statements(now)) expect(statementMeta.safeParse(s).success).toBe(true);
  });

  it('D931: each confirmation view’s web addresses, from the apps’ own changes; every state shown somewhere', () => {
    const states = new Set<string>();
    for (const id of ['gc_Pk4Ws9Ra1', 'gc_Pk5Tq2Nb6', 'gc_Pk9Cf4Mn3', 'gc_Pf3Lk8Wd2', 'gc_Hs4Rb8Tq2']) {
      const v = F.confirmationView(now, id)!;
      expect(v, id).toBeDefined();
      for (const c of v.changes) {
        expect(confirmationChangeView.safeParse(c).error?.issues, c.changeId).toBeUndefined();
        states.add(c.state);
      }
    }
    expect([...states].sort()).toEqual(['cancelled', 'in_force', 'waiting', 'waiting_announcement']);
    // A member's own change has no confirmation page.
    expect(F.confirmationView(now, 'gc_Ch4kq81Ns')).toBeUndefined();
    const coffee = F.confirmationView(now, 'gc_Pk6Id3Ka7')!;
    expect(coffee.changes.map((c) => c.changeId).sort()).toEqual(['gc_Pk4Ws9Ra1', 'gc_Pk6Id3Ka7', 'gc_Pk7Lt8Wq2']);
    expect(coffee.app).toMatchObject({ sharedScope: true, otherApps: ['Rewards beta', 'Stamp Rally'], otherAppsTotal: 2 });
    expect(coffee.keyLabel).toBe('Production backend');
    expect(F.confirmationView(now, 'gc_Hs4Rb8Tq2')!.proposedByKind).toBe('hana');
  });

  it('the live app’s policy is one the vault accepts', () => {
    expect(F.livePolicy().policyId).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the scenarios', () => {
  it('not-chain-owner: an owner in the console, not an on-chain owner of the scope (the Origins and Signing lines)', () => {
    expect((get('not-chain-owner', `/api/orgs/${F.ORG_ID}`).body as { role: string }).role).toBe('owner');
    const sc = get('not-chain-owner', `/api/orgs/${F.ORG_ID}/scopes/s_lumen_live`).body as { youAreOnChainOwner: boolean; drift: { missingOnChain: { email: string }[] } };
    expect(sc.youAreOnChainOwner).toBe(false);
    expect(sc.drift.missingOnChain.map((m) => m.email)).toEqual(['aiko.tanaka@examplelabs.example']);
    expect((get('owner', `/api/orgs/${F.ORG_ID}/scopes/s_lumen_live`).body as { youAreOnChainOwner: boolean }).youAreOnChainOwner).toBe(true);
  });

  it('the session scenarios: the warning’s end time, and a session that ended under the page’s writes', () => {
    expect((get('session-ending', '/api/me').body as { sessionExpiresAt: number }).sessionExpiresAt).toBe(now + 4 * 60_000);
    expect(meAnswer.safeParse(get('session-ending', '/api/me').body).success).toBe(true);
    expect(get('session-ended', '/api/me').status).toBe(200);
    expect(answer('session-ended', 'POST', new URL(`http://127.0.0.1/api/orgs/${F.ORG_ID}/actions`), { kind: 'member.invite', params: {} }, new PreviewState(), now).status).toBe(401);
    expect(answer('session-ended', 'POST', new URL('http://127.0.0.1/api/auth/start'), {}, new PreviewState(), now).status).toBe(200);
  });

  it('signed out answers 401 everywhere but the sign-in start', () => {
    expect(get('signed-out', '/api/me').status).toBe(401);
    expect(answer('signed-out', 'POST', new URL('http://127.0.0.1/api/auth/start'), {}, new PreviewState(), now).status).toBe(200);
  });

  it('a viewer’s write is 403; the errors scenario refuses with real codes', () => {
    const post = (s: (typeof SCENARIOS)[number], path: string, body: unknown = {}) => answer(s, 'POST', new URL(path, 'http://127.0.0.1'), body, new PreviewState(), now);
    expect(post('viewer', `/api/orgs/${F.ORG_ID}/apps/app_Lm4Pq9Zs2v/keys`).status).toBe(403);
    expect((post('errors', `/api/orgs/${F.ORG_ID}/apps/app_Lm4Pq9Zs2v/keys`).body as { error: { code: string } }).error.code).toBe('key_limit');
    expect(get('errors', `/api/orgs/${F.ORG_ID}/apps`).status).toBe(503);
  });

  it('a built action can be read back, confirmed once, then not again', () => {
    const state = new PreviewState();
    const built = answer('owner', 'POST', new URL(`http://127.0.0.1/api/orgs/${F.ORG_ID}/actions`), { kind: 'origin.add', params: { appId: 'app_Lm4Pq9Zs2v', add: ['https://new.lumenpay.io'] } }, state, now).body as { id: string };
    const read = answer('owner', 'GET', new URL(`http://127.0.0.1/api/actions/${built.id}`), undefined, state, now);
    expect((read.body as { status: string }).status).toBe('pending');
    const google = (n: number) => answer('owner', 'POST', new URL(`http://127.0.0.1/api/actions/${built.id}/google`), {}, state, now + n).status;
    expect(google(0)).toBe(200);
    expect(google(1)).toBe(409);
    // Its way back, as the console builds it (D711): the page that started it, a known page name only.
    expect((read.body as { returnTo: string }).returnTo).toBe(`/orgs/${F.ORG_ID}/apps/app_Lm4Pq9Zs2v/origins`);
    const email = answer('owner', 'POST', new URL(`http://127.0.0.1/api/orgs/${F.ORG_ID}/actions`), { kind: 'owner_action', params: { scopeId: 's_lumen_live', method: 'propose_change', change: { kind: 'AddEmailClient' } }, returnTo: { page: 'email', appId: 'app_Lm4Pq9Zs2v' } }, state, now).body as { returnTo: string };
    expect(email.returnTo).toBe(`/orgs/${F.ORG_ID}/apps/app_Lm4Pq9Zs2v/email`);
    const odd = answer('owner', 'POST', new URL(`http://127.0.0.1/api/orgs/${F.ORG_ID}/actions`), { kind: 'member.invite', params: {}, returnTo: { page: 'https://evil.example' } }, state, now).body as { returnTo: string };
    expect(odd.returnTo).toBe(`/orgs/${F.ORG_ID}/members`);
  });

  it('the Email login states, with the server’s clock; `unlocking` turns executable 60 s after it was picked', () => {
    const app = F.appDetails(now)[0]!;
    const state = new PreviewState();
    state.pickEmail('unlocking', now);
    const read = (t: number) => answer('owner', 'GET', new URL(`http://127.0.0.1/api/orgs/${F.ORG_ID}/apps/${app.id}/email`), undefined, state, t).body as { now: number; scope: { pending: { unlockAt: number; executable: boolean } } };
    expect(read(now + 59_000)).toMatchObject({ now: now + 59_000, scope: { pending: { unlockAt: now + 60_000, executable: false } } });
    expect(read(now + 60_000).scope.pending.executable).toBe(true);
    for (const s of ['off', 'stuck', 'waiting', 'ready', 'on']) expect(F.emailStatus(app, now, s).now).toBe(now);
  });

  it('D931: the confirmation page answers each member as the console does; the Confirm link finds the org', () => {
    const page = (sc: (typeof SCENARIOS)[number], id: string) => get(sc, `/api/orgs/${F.ORG_ID}/confirmations/${id}`).body as { ability: { allowed: boolean; reason?: string; code?: string }; role: string };
    expect(page('owner', 'gc_Pk4Ws9Ra1').ability).toEqual({ allowed: true });
    expect(page('viewer', 'gc_Pk4Ws9Ra1').ability).toMatchObject({ allowed: false, code: 'forbidden' });
    expect(page('not-chain-owner', 'gc_Pk4Ws9Ra1').ability).toEqual({ allowed: false, code: 'not_owner', reason: CONFIRM_WORDS.onlyOwner });
    expect(page('staff-proposer', 'gc_Hs4Rb8Tq2').ability).toEqual({ allowed: false, code: 'forbidden', reason: CONFIRM_WORDS.sameAsProposer });
    expect(page('staff-proposer', 'gc_Pk4Ws9Ra1').ability).toEqual({ allowed: true });
    expect(page('owner', 'gc_Pk5Tq2Nb6').ability).toEqual({ allowed: false, code: 'not_pending', reason: CONFIRM_WORDS.notAnnounced });
    expect(page('owner', 'gc_Pk9Cf4Mn3').ability).toMatchObject({ allowed: false, code: 'not_pending' });
    expect(get('owner', `/api/orgs/${F.ORG_ID}/confirmations/gc_Ch4kq81Ns`).status).toBe(404);
    expect(get('owner', '/api/confirmations/gc_Pk4Ws9Ra1/org').body).toEqual({ orgId: F.ORG_ID, appId: 'app_Pk3Cf8Ld2w' });
    expect(get('owner', '/api/confirmations/gc_nope/org').status).toBe(404);
  });

  it('D931: an origin.confirm action shows the ticked web addresses; the demo actions read back', () => {
    const state = new PreviewState();
    const built = answer('owner', 'POST', new URL(`http://127.0.0.1/api/orgs/${F.ORG_ID}/actions`), { kind: 'origin.confirm', params: { appId: 'app_Pk3Cf8Ld2w', changeIds: ['gc_Pk6Id3Ka7'] }, returnTo: { page: 'origins', appId: 'app_Pk3Cf8Ld2w' } }, state, now).body as { decoded: { appName: string; changes: { changeId: string; idn: boolean }[] }; returnTo: string };
    expect(built.decoded.appName).toBe('Coffee Club');
    expect(built.decoded.changes).toEqual([expect.objectContaining({ changeId: 'gc_Pk6Id3Ka7', idn: true })]);
    expect(built.returnTo).toBe(`/orgs/${F.ORG_ID}/apps/app_Pk3Cf8Ld2w/origins`);
    expect((get('owner', '/api/actions/act_demo_confirm').body as { status: string }).status).toBe('pending');
    expect((get('owner', '/api/actions/act_demo_confirm_ok').body as { outcome: { confirmed: number } }).outcome.confirmed).toBe(2);
  });

  it('D931: the removal link works signed out; a preview, a removal, one already removed, and an expired link', () => {
    const post = (sc: (typeof SCENARIOS)[number], path: string, changeId: string, token = 'A'.repeat(43)) => answer(sc, 'POST', new URL(path, 'http://127.0.0.1'), { changeId, token }, new PreviewState(), now);
    expect((post('signed-out', '/api/remove/preview', 'gc_Pk9Cf4Mn3').body as { removable: boolean }).removable).toBe(true);
    expect(post('owner', '/api/remove', 'gc_Pk9Cf4Mn3').status).toBe(200);
    expect((post('owner', '/api/remove/preview', 'gc_Rm2Xp7Lk4').body as { removable: boolean }).removable).toBe(false);
    expect(post('owner', '/api/remove', 'gc_Rm2Xp7Lk4').status).toBe(409);
    expect(post('errors', '/api/remove/preview', 'gc_Pk9Cf4Mn3').status).toBe(403);
    expect(post('owner', '/api/remove/preview', 'gc_Pk9Cf4Mn3', 'short').status).toBe(400);
  });

  it('another org is 404; the new org has no apps', () => {
    expect(get('owner', '/api/orgs/org_other/apps').status).toBe(404);
    expect(get('new-org', `/api/orgs/${F.ORG_ID}/apps`).body).toEqual({ apps: [] });
  });
});

describe('the harness stays local', () => {
  it('serves on 127.0.0.1 only, and only in vite serve', () => {
    expect(config.server?.host).toBe('127.0.0.1');
    expect(mockApi().apply).toBe('serve');
  });

  it('redirects only to a path on the same server; picks only a known scenario', () => {
    expect(safeTo('/orgs/x?y=1')).toBe('/orgs/x?y=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', null, '']) expect(safeTo(bad)).toBe('/');
    expect(scenarioOf('a=1; hana_preview=viewer', SCENARIOS)).toBe('viewer');
    expect(scenarioOf('hana_preview=nope', SCENARIOS)).toBe('owner');
    expect(SCENARIOS.every((s) => SCENARIO_RE.test(s))).toBe(true);
  });
});
