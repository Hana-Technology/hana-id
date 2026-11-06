// The SPA's local preview harness (apps/console/preview, dev only): its fake answers have the console's exact shapes
// (console-core's schemas), its scenarios behave as named (signed out is 401, a viewer's write 403, errors refuse),
// it serves only on 127.0.0.1 and only in `vite serve`, its redirect stays on the server, and nothing of it is built
// into dist/ (spa-build.test.ts checks the bundle too).
import { appDetail, appSummary, auditAnswer, meAnswer, membersAnswer, orgAnswer, statementMeta, usageRow } from '@hana-id/console-core';
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

  it('the live app’s policy is one the vault accepts', () => {
    expect(F.livePolicy().policyId).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the scenarios', () => {
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
