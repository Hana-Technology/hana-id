// The console's local preview harness (dev only, never deployed): a Vite plugin that answers the SPA's `/api/*` calls
// with the fake data of preview/fixtures.ts, so every screen and state can be opened and screenshotted on localhost
// with no Worker, D1, session or Google. `GET /__preview/<scenario>?to=<path>` picks a scenario (a cookie) and goes to
// the path. The answers have the console's shapes; writes answer success (or, in `errors`, a representative refusal)
// and change nothing. The real console's CSRF, session and step-up checks are not imitated: this is a picture of the
// SPA, not of the security boundary (apps/console/README.md "Local preview").
import { canonicalJson, policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import * as F from './fixtures.ts';

export const SCENARIOS = ['owner', 'viewer', 'frozen', 'multi', 'new-org', 'signed-out', 'errors', 'session-ending', 'session-ended', 'not-chain-owner'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error: { code, message }, ...extra } });

interface ActionRecord {
  id: string;
  kind: string;
  status: 'pending' | 'ok' | 'failed' | 'expired';
  decoded: Record<string, unknown>;
  expiresAt: number;
  outcome?: Record<string, unknown>;
}

/** The harness's state: the actions built in this run (a fresh sign-in's review page reads them back). */
export class PreviewState {
  readonly actions = new Map<string, ActionRecord>();
  /** The Email login page's state; `/__preview/<scenario>?email=<state>` picks it. */
  emailState = 'off';
  private n = 0;
  nextActionId(): string {
    this.n += 1;
    return `act_Pv${String(this.n).padStart(10, 'x')}`;
  }
}

/** A few fixed actions, so each state of the review page has a URL (`/actions/act_demo_…`). */
function demoAction(id: string, now: number): ActionRecord | undefined {
  const app = F.appDetails(now)[0]!;
  const policy = F.livePolicy();
  const originDecoded = { appId: app.id, appName: app.name, environment: 'live', add: [{ origin: 'https://checkout.lumenpay.io', display: 'https://checkout.lumenpay.io', idn: false }, { origin: new URL('https://lumènpay.io').origin, display: 'https://lumènpay.io', idn: true }], remove: [], originsVersion: 7 };
  const expiresAt = now + 4 * 60_000 + 20_000;
  switch (id) {
    case 'act_demo_origin':
      return { id, kind: 'origin.add', status: 'pending', decoded: originDecoded, expiresAt };
    case 'act_demo_policy':
      return { id, kind: 'policy.set', status: 'pending', decoded: { appId: app.id, appName: app.name, policyId: policy.policyId, label: policy.label, policy: policy.json, parentOrigin: 'https://app.lumenpay.io', sessionTtlMs: app.settings.sessionTtlMs, settingsVersion: 12 }, expiresAt };
    case 'act_demo_settings':
      return { id, kind: 'app.settings', status: 'pending', decoded: { appId: app.id, appName: app.name, from: app.settings, changes: { sessionTtlMs: 8 * 3_600_000, idleTtlMs: 45 * 60_000 }, settingsVersion: 12 }, expiresAt };
    case 'act_demo_invite':
      return { id, kind: 'member.invite', status: 'pending', decoded: { email: 'noor.haddad@soralabs.io', role: 'owner', ownerWait: true }, expiresAt };
    case 'act_demo_owner':
      return { id, kind: 'owner_action', status: 'pending', decoded: { scopeId: 's_lumen_live', actionNonce: 6, method: 'remove_client', provider: 'google', aud: '204871935513-k2v9mq8d0w7hj1n3s6e4c5t0b8a2f9xg.apps.googleusercontent.com', immediate: true }, expiresAt };
    case 'act_demo_ok':
      return { id, kind: 'origin.add', status: 'ok', decoded: originDecoded, expiresAt: now - 60_000, outcome: { status: 'ok', version: 8, changeId: 'gc_Ch4kq81Ns' } };
    case 'act_demo_failed':
      return { id, kind: 'member.remove', status: 'failed', decoded: { userId: 'usr_Sm9Lk2Vb7q', email: 'sam.okafor@soralabs.io' }, expiresAt: now - 60_000, outcome: { status: 'failed', code: 'sub_mismatch' } };
    case 'act_demo_expired':
      return { id, kind: 'raw_sign.on', status: 'expired', decoded: { appId: app.id, appName: app.name, settingsVersion: 12 }, expiresAt: now - 30_000 };
    default:
      return undefined;
  }
}

/** The policy check the console runs (apps/console/src/policy.ts), at the app's session length. */
function checked(policy: unknown, sessionTtlMs: number): { ok: true; policy: unknown; policyId: string; label: string } | { ok: false; problems: readonly string[] } {
  const r = validateAutoApprovePolicy(policy, { sessionTtlMs });
  if (!r.ok) return { ok: false, problems: r.problems };
  return { ok: true, policy: JSON.parse(canonicalJson(r.policy)) as unknown, policyId: policyId(r.policy, { sessionTtlMs }), label: r.policy.label };
}

/** What a built action shows, from the request's params (the real console builds it from the stored app). */
function decodedFor(kind: string, params: Record<string, unknown>, now: number): Record<string, unknown> {
  const app = F.appDetails(now).find((a) => a.id === params.appId);
  const base = app ? { appId: app.id, appName: app.name, environment: app.environment, settingsVersion: app.settingsVersion } : {};
  const asOrigin = (s: unknown) => {
    const display = String(s);
    let origin = display;
    try {
      origin = new URL(display).origin;
    } catch {
      /* the real console refuses it (origin_refused); the picture shows it as typed */
    }
    return { origin, display, idn: origin !== display };
  };
  switch (kind) {
    case 'origin.add':
      return { ...base, add: ((params.add as unknown[]) ?? []).map(asOrigin), remove: [] };
    case 'policy.set': {
      const ttl = app?.settings.sessionTtlMs ?? 43_200_000;
      const v = checked(params.policy, ttl);
      return { ...base, ...(v.ok ? { policyId: v.policyId, label: v.label, policy: v.policy } : {}), parentOrigin: app?.origins[0]?.display ?? null, sessionTtlMs: ttl };
    }
    case 'app.settings': {
      const { appId: _drop, ...changes } = params;
      return { ...base, from: app?.settings, changes };
    }
    case 'app.resume':
      return { ...base, otherSuspensions: ((app?.suspendedBy ?? 0) & 3) !== 0 };
    case 'member.invite':
      return { email: params.email, role: params.role, ownerWait: params.role === 'owner' };
    case 'member.role':
    case 'member.remove': {
      const m = F.members(now).members.find((x) => x.userId === params.userId);
      return { userId: params.userId, email: m?.email ?? 'someone@soralabs.io', ...(kind === 'member.role' ? { role: params.role } : {}) };
    }
    case 'org.policy':
      return { requiredHd: params.requiredHd ?? null };
    case 'owner_action':
      return { scopeId: params.scopeId, actionNonce: 6, method: params.method, ...(params.aud ? { aud: params.aud, provider: String(params.aud).startsWith('email:') ? 'email' : 'google', immediate: true } : {}), ...(params.change ? { change: (params.change as { kind?: string }).kind === 'AddEmailClient' ? { kind: 'AddClient', provider: 'email', aud: `email:${String(params.scopeId)}` } : params.change } : {}) };
    default:
      return base;
  }
}

const ORG_PATH = /^\/api\/orgs\/([^/]+)(\/.*)?$/u;

/** The answer to one `/api/*` request in a scenario (pure apart from `state.actions`; the tests call it). */
export function answer(scenario: Scenario, method: string, url: URL, body: unknown, state: PreviewState, now = Date.now()): Answer {
  const path = url.pathname;
  const role = scenario === 'viewer' ? 'viewer' : 'owner';
  const frozen = scenario === 'frozen';
  if (path === '/api/auth/start' && method === 'POST') return ok({ startUrl: '/__preview/owner?to=/' });
  if (scenario === 'signed-out') return fail(401, 'unauthenticated', 'Sign in again');
  if (path === '/api/auth/logout' && method === 'POST') return ok({});
  // The session's end: `session-ending` is 4 min from its 12 h absolute end (the warning; inside a demo action's
  // 4 min 20 s, so the fresh sign-in page says the session ends first); in `session-ended` the reads work but every
  // write answers 401, as a session that ended mid-task does (the banner, Try again).
  if (scenario === 'session-ended' && method === 'POST') return fail(401, 'unauthenticated', 'Sign in again');
  if (path === '/api/me') return ok({ ...F.me({ multi: scenario === 'multi', users: scenario !== 'new-org', role, frozen }), sessionExpiresAt: now + (scenario === 'session-ending' ? 4 * 60_000 : 9 * 3_600_000) });

  const act = /^\/api\/actions\/([^/]+)(\/google)?$/u.exec(path);
  if (act) {
    const id = act[1]!;
    const a = state.actions.get(id) ?? demoAction(id, now);
    if (!a) return fail(404, 'not_found', 'Not found');
    if (act[2] && method === 'POST') {
      if (a.status !== 'pending') return fail(409, 'step_up_expired', 'This confirmation has expired or was used: start again');
      // Stands in for Google: the real flow goes to the auth origin, then Google, then back to /actions/:id#.
      state.actions.set(id, { ...a, status: 'ok', outcome: { status: 'ok' } });
      return ok({ startUrl: `/actions/${id}` });
    }
    return ok(a);
  }
  if (path === '/api/cancel' || path === '/api/owner-grants/cancel') return scenario === 'errors' ? fail(409, 'not_pending', 'not_pending') : ok({});

  const m = ORG_PATH.exec(path);
  if (!m) return fail(404, 'not_found', 'Not found');
  const orgId = m[1]!;
  const rest = m[2] ?? '';
  if (orgId !== F.ORG_ID && !(scenario === 'multi' && orgId === F.ORG2_ID)) return fail(404, 'not_found', 'Not found');
  const apps = scenario === 'new-org' || orgId === F.ORG2_ID ? [] : F.appDetails(now);

  if (method === 'POST') return write(scenario, orgId, rest, body, state, now);

  if (rest === '') return ok(F.org(orgId, role, frozen));
  if (scenario === 'errors' && rest === '/apps') return fail(503, 'near_unavailable', 'NEAR RPC is unavailable: try again');
  if (scenario === 'errors' && rest !== '/apps' && !rest.startsWith('/apps/')) return fail(429, 'rate_limited', 'Too many requests; try again in a minute', {});
  if (rest === '/apps') return ok({ apps: apps.map(F.summaryOf) });
  const appM = /^\/apps\/([^/]+)$/u.exec(rest);
  if (appM) {
    const a = apps.find((x) => x.id === appM[1]);
    return a ? ok({ app: a, now }) : fail(404, 'not_found', 'Not found');
  }
  const emailM = /^\/apps\/([^/]+)\/email$/u.exec(rest);
  if (emailM) {
    const a = apps.find((x) => x.id === emailM[1]);
    if (!a) return fail(404, 'not_found', 'Not found');
    if (scenario === 'errors') return fail(503, 'near_unavailable', 'NEAR RPC is unavailable: try again');
    return ok(F.emailStatus(a, now, state.emailState));
  }
  if (rest === '/members') return ok(scenario === 'new-org' ? { members: [F.members(now).members[0]!], invites: [], grants: [] } : F.members(now));
  if (rest === '/audit') return ok(F.audit(now));
  // `not-chain-owner`: an owner in the console whose Google account isn't an on-chain owner of the scope (D652).
  if (rest.startsWith('/scopes/')) return ok(F.scope(now, scenario !== 'not-chain-owner'));
  if (rest === '/usage') {
    const by = url.searchParams.get('by') === 'month' ? 'month' : 'day';
    const ids = (url.searchParams.get('apps') ?? '').split(',').filter(Boolean);
    return ok({ rows: apps.length ? F.usage(now, by, ids) : [] });
  }
  if (rest === '/statements') return ok({ statements: apps.length ? F.statements(now) : [] });
  const st = /^\/statements\/(\d{4}-\d{2})$/u.exec(rest);
  if (st) {
    const s = F.statements(now).find((x) => x.month === st[1]);
    return s ? ok({ statement: { ...s, totals: {} }, view: F.statementView(s) }) : fail(404, 'not_found', `No ${st[1]} statement`);
  }
  if (rest === '/governance/pending-upgrades') return ok({ pendingUpgrades: F.pendingUpgrades(now) });
  if (rest.startsWith('/users')) return ok({ users: F.users(now) });
  return fail(404, 'not_found', 'Not found');
}

function write(scenario: Scenario, orgId: string, rest: string, body: unknown, state: PreviewState, now: number): Answer {
  const b = (body ?? {}) as Record<string, unknown>;
  if (scenario === 'viewer') return fail(403, 'forbidden', 'Only an owner of the organisation can do this');
  if (scenario === 'errors') {
    if (rest === '/actions') return fail(400, 'origin_refused', 'https://localhost.lumenpay.io: loopback names are refused for live apps');
    if (rest.endsWith('/policy/check')) return fail(400, 'policy_invalid', 'label: required; evm.chains[0].maxFeeWei: must be a decimal string', { problems: ['label: required', 'evm.chains[0].maxFeeWei: must be a decimal string'] });
    if (rest.endsWith('/keys')) return fail(409, 'key_limit', 'At most 5 unrevoked keys per app: revoke one first');
    if (rest.includes('/logo')) return fail(400, 'logo_type', 'logo_type');
    return fail(409, 'version_conflict', 'version_conflict');
  }
  if (rest === '/actions') {
    const kind = String(b.kind);
    const params = (b.params ?? {}) as Record<string, unknown>;
    const id = state.nextActionId();
    const a: ActionRecord = { id, kind, status: 'pending', decoded: decodedFor(kind, params, now), expiresAt: now + 5 * 60_000 };
    state.actions.set(id, a);
    return ok({ id, kind, decoded: a.decoded, expiresAt: a.expiresAt });
  }
  if (rest.endsWith('/policy/check')) {
    const v = checked(b.policy, 12 * 3_600_000);
    return v.ok ? ok({ policyId: v.policyId, label: v.label, policy: v.policy }) : fail(400, 'policy_invalid', v.problems.join('; '), { problems: v.problems });
  }
  if (/\/keys(\/[^/]+\/(rotate))?$/u.test(rest)) return ok({ id: 'key_new', prefix: 'pk_test_', key: 'pk_test_new', createdBy: 'usr_Ak3Pz8Qw2n', createdAt: now });
  if (rest.includes('/logo')) return ok({ logoUrl: undefined, version: 13 });
  if (rest.endsWith('/suspend')) return ok({ suspendedBy: 4 });
  if (rest.endsWith('/execute')) return ok({ status: 'ok', nearTx: '7sKq2Vb9Lm4Xc1Rt8Wz5Yn3Pd6Gh0Jf2Ns9Ua4Ee7Hk' });
  void orgId;
  return ok({ version: 1 });
}
