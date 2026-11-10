// "Security & monitoring", the pending-upgrades page and the playbooks (batch C14; D83, D86, D126; docs/governance-spec.md
// "Monitoring in the admin portal", docs/batch-c-spec.md "Security & monitoring: recovery playbooks"): every route behind
// the Access check; the watchdog called server-side with the bearer, which never reaches a response; size caps and
// timeouts on its answers; its text reduced to bounded plain text; the ack forwarded with the staff identity (it stops
// re-sends only); a playbook for every watchdog alert kind (the watchdog's own registry, `ALERT_KINDS`) and a portal
// rendering for every check (`CHECK_IDS`); the governance read through AdminRpc; the pending-upgrades page.
import { ACTORS, PLAYBOOKS, getPlaybook, playbookForAlertKind } from '@hana-id/playbooks';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_KINDS_WITH_PLAYBOOKS, ALERT_KIND_IDS, CHECKS, CHECK_IDS, RESEND_MS, RUN_INTERVAL_MS } from '../../watchdog/src/checks.ts';
import worker from '../src/index.ts';
import { CHECK_VIEWS } from '../src/monitoring-registry.ts';
import { DELIVERIES_SHOWN, ackBy, alertView, findingsOf, statusView } from '../src/monitoring.ts';
import { plainString } from '../src/plain.ts';
import { WATCHDOG_LIMITS, watchdogTiming } from '../src/watchdog.ts';
import { ADMIN, CSRF, type ReqInit, STAFF_EMAIL, STAFF_SUB, WATCHDOG, WATCHDOG_TOKEN, type WatchdogCall, adminRequest, envWith, json, overrideBinding, staffJwt, stubNetwork, watchdog } from './helpers.ts';

const NOW = Date.now();
const UPGRADE_HASH = '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp';
const TX = '9Xq1bYhJzUJ6rN2f3wQpS7t8vKmLcD4eGhA5sBnTuV6W';

/** One alert row as the watchdog serves it (apps/watchdog/src/status.ts alertView). */
function alertRow(id: number, kind: string, over: Record<string, unknown> = {}) {
  const sev = (ALERT_KINDS_WITH_PLAYBOOKS as Record<string, { severity: string }>)[kind]?.severity ?? 'critical';
  return {
    id,
    kind,
    severity: sev,
    title: `${kind} on sandbox-test`,
    details: { by: 'signer.test.near' },
    created_at: NOW - 3_600_000,
    resolved_at: null,
    acked_at: null,
    acked_by: null,
    acked_via: null,
    last_sent_at: NOW - 60_000,
    send_count: 4,
    pending_channels: [],
    channels: sev === 'critical' ? ['pager', 'slack', 'email'] : sev === 'warning' ? ['slack', 'email'] : [],
    resends_until_ack: sev === 'critical',
    ...over,
  };
}

/** `GET /status` as the watchdog serves it, with alert #11 (the expected updater-key change on sandbox-dev) open. */
function statusBody(over: Record<string, unknown> = {}) {
  return {
    service: 'hana-id-watchdog',
    env: 'sandbox-test',
    network: 'testnet',
    signer: 'signer.test.near',
    watchdog_account: 'watchdog.test.near',
    now: NOW,
    run_interval_ms: RUN_INTERVAL_MS,
    resend_ms: RESEND_MS,
    initialized_at: NOW - 86_400_000,
    last_run: { id: 900, started_at: NOW - 70_000, finished_at: NOW - 60_000, outcome: 'ok', first_run: false, checks: CHECK_IDS.map((id) => ({ id, outcome: 'ok' })) },
    silent: false,
    heartbeat: { configured: true, last_ping_at: NOW - 60_000, last_ok_at: NOW - 60_000, ok: true, failures: 0 },
    channels: { pager: { provider: 'ntfy', configured: true }, slack: { configured: true }, email: { configured: true } },
    seen_kids: [{ provider: 'google', kid: 'k2', n: 'nnn', e: 'AQAB', source: 'jwks', first_seen_at: NOW - 7_200_000, last_seen_at: NOW - 60_000 }],
    relayer_funds: null,
    email: { pinned: null, jwks_url: null, last: null },
    link_stats: null,
    identity: { iss: null, jwks_url: null, discovery_url: null, pinned: [], jwks: null, discovery: null },
    actions: [{ id: 3, run_id: 899, at: NOW - 600_000, method: 'pause', args: {}, reason: 'forged_active_key', ok: true, tx_hash: TX, error: null }],
    open_alerts: [alertRow(11, 'governance_change', { details: { field: 'updater_keys', before: ['ed25519:old'], after: ['ed25519:new'] } })],
    checks: CHECKS,
    alert_kinds: ALERT_KINDS_WITH_PLAYBOOKS,
    ...over,
  };
}

const ok = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

/** The fake watchdog's routes for most tests: /status, /alerts, /actions and the ack of alert 11 (once). */
function serveWatchdog(status: () => unknown = () => statusBody()) {
  let acked: number | null = null;
  watchdog.answer = (c: WatchdogCall) => {
    if (c.method === 'GET' && c.path === '/status') return ok(status());
    if (c.method === 'GET' && c.path.startsWith('/alerts')) return ok({ alerts: [alertRow(11, 'governance_change', { deliveries: Array.from({ length: 30 }, (_, i) => ({ channel: 'pager', kind: i ? 'resend' : 'first', at: NOW - i * RESEND_MS, ok: true, error: null })) }), alertRow(10, 'key_change_confirmed')], next_cursor: 10 });
    if (c.method === 'GET' && c.path.startsWith('/actions')) return ok({ actions: statusBody().actions, next_cursor: null });
    const m = /^\/alerts\/(\d+)\/ack$/u.exec(c.path);
    if (c.method === 'POST' && m) {
      if (m[1] !== '11') return ok({ error: 'No such alert', code: 'not_found' }, { status: 404 });
      const by = (c.body as { by: string }).by;
      if (acked !== null) return ok({ error: 'Already acknowledged', code: 'already_acknowledged', alert: alertRow(11, 'governance_change', { acked_at: acked, acked_by: by, acked_via: 'portal' }) }, { status: 409 });
      acked = NOW;
      // The condition is untouched: resolved_at stays null; only the re-sends stop.
      return ok({ alert: alertRow(11, 'governance_change', { acked_at: acked, acked_by: by, acked_via: 'portal' }) });
    }
    return ok({ error: 'Not found', code: 'not_found' }, { status: 404 });
  };
}

/** A governance snapshot as AdminRpc.governance answers it (the shape of GET /v1/governance). */
function governanceFixture(over: Record<string, unknown> = {}) {
  return {
    signer: 'signer.test.near',
    env: 'sandbox-test',
    readAtMs: NOW,
    stateVersion: 3,
    paused: false,
    unpausedAtMs: 0,
    changesUnlockFloorMs: 0,
    sessionsValidFromMs: 0,
    delays: { issuerKeyDelayMs: 120_000, governanceDelayMs: 60_000, changeDelayMs: 60_000, pendingIssuerKeyDelay: null, pendingGovernanceDelay: null, pendingChangeDelay: null },
    issuers: [{ provider: 'google', activeKids: ['k1'], jwksKids: ['k1', 'k2'] }],
    keyChanges: [{ id: 7, provider: 'google', kid: 'k2', op: 'Add', by: 'signer.test.near', proposedAtMs: NOW - 60_000, executableAtMs: NOW + 60_000, due: false, jwks: 'match' }],
    watchdogs: [{ accountId: 'watchdog.test.near', confirmFromMs: 0, canConfirm: true }],
    keysSlowUntilMs: 0,
    updaterKeys: ['ed25519:new'],
    updaterMethods: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'],
    signerAccessKeys: [
      { publicKey: 'ed25519:new', kind: 'function_call', receiverId: 'signer.test.near', methodNames: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'], allowanceYocto: '1000000000000000000000000', updaterKey: true, updaterPermission: true },
      { publicKey: 'ed25519:full', kind: 'full_access', receiverId: null, methodNames: null, allowanceYocto: null, updaterKey: false, updaterPermission: false },
    ],
    pendingUpgrade: { codeHash: UPGRADE_HASH, proposedAtMs: NOW - 1000, executableAtMs: NOW + 59_000, due: false },
    pendingOwner: null,
    pendingWithdrawal: null,
    pendingConsoleAudiences: [],
    pendingSharedClients: [],
    updater: { lastRuns: [{ provider: 'google', atMs: NOW - 60_000, outcome: 'ok', code: null, summary: {} }], proposals: [] },
    ...over,
  };
}

/** The Worker with the API's governance reads answered from fixtures (the real API's NEAR RPC is an invalid host). */
const withGovernance = (g: Record<string, unknown> = governanceFixture()) =>
  envWith({
    API: overrideBinding(env.API, {
      governance: async () => ({ ok: true, governance: g }),
      pendingUpgrades: async () => ({ ok: true, pendingUpgrades: { signer: 'signer.test.near', env: 'sandbox-test', readAtMs: NOW, paused: false, governanceDelayMs: 60_000, upgrade: { codeHash: UPGRADE_HASH, proposedAtMs: NOW - 1000, executableAtMs: NOW + 59_000, due: false, release: null }, ownerTransfer: null, withdrawal: null, delayDecreases: [], consoleAudienceAdditions: [], anyPending: true } }),
    }),
  });

async function staffFetch(e: typeof env, path: string, init: { method?: string; body?: unknown; csrf?: boolean } = {}): Promise<Response> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': await staffJwt(), ...(method !== 'GET' && init.csrf !== false ? CSRF : {}) };
  return worker.fetch(new Request(`${ADMIN}${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), e);
}

/**
 * A staff request to the Worker with the governance fixtures (the default here): adminRequest's front door, without the
 * real API's NEAR reads (an invalid host in the suite). The tests that cross the real binding use adminRequest.
 */
async function req(path: string, init: ReqInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const jwt = init.jwt === undefined ? await staffJwt() : init.jwt;
  if (jwt) headers.set('cf-access-jwt-assertion', jwt);
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  if (method !== 'GET' && method !== 'HEAD' && init.csrf !== false) for (const [k, v] of Object.entries(CSRF)) if (!headers.has(k)) headers.set(k, v);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return worker.fetch(new Request(`${ADMIN}${path}`, { method, headers, body }), withGovernance());
}

/** Everything a response exposes, headers included. */
const exposed = async (res: Response): Promise<string> => `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`;

beforeEach(async () => {
  await stubNetwork();
  serveWatchdog();
});
afterEach(() => {
  vi.restoreAllMocks();
  watchdogTiming.timeoutMs = 8_000;
});

const ROUTES: [string, string][] = [
  ['GET', '/api/monitoring'],
  ['GET', '/api/monitoring/alerts'],
  ['GET', '/api/monitoring/actions'],
  ['POST', '/api/monitoring/alerts/11/ack'],
  ['GET', '/api/governance/pending-upgrades'],
  ['GET', '/api/playbooks'],
  ['GET', `/api/playbooks/${PLAYBOOKS[0]!.id}`],
];

describe('behind the Access check', () => {
  it('every C14 route refuses no token (401) and a non-staff identity (403), and never calls the watchdog', async () => {
    const outsider = await staffJwt({ email: 'someone@hana.example' });
    for (const [method, path] of ROUTES) {
      const body = method === 'POST' ? {} : undefined;
      expect((await adminRequest(path, { method, body, jwt: null })).status, path).toBe(401);
      expect((await adminRequest(path, { method, body, jwt: outsider })).status, path).toBe(403);
    }
    expect(watchdog.calls).toEqual([]);
  });

  it('the ack is a write: it needs the CSRF checks, and GET is 405', async () => {
    const res = await adminRequest('/api/monitoring/alerts/11/ack', { method: 'POST', body: {}, csrf: false });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: { code: 'csrf' } });
    expect((await adminRequest('/api/monitoring/alerts/11/ack')).status).toBe(405);
    expect(watchdog.calls).toEqual([]);
  });
});

describe('the watchdog, server-side with the bearer', () => {
  it('sends Authorization: Bearer <token> and refuses redirects; the token is in no response', async () => {
    const res = await req('/api/monitoring');
    expect(res.status).toBe(200);
    expect(watchdog.calls).toEqual([{ method: 'GET', path: '/status', authorization: `Bearer ${WATCHDOG_TOKEN}`, redirect: 'manual', body: undefined }]);
    expect(await exposed(res)).not.toContain(WATCHDOG_TOKEN);
    for (const [method, path] of ROUTES) {
      const r = await req(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
      expect(await exposed(r), path).not.toContain(WATCHDOG_TOKEN);
    }
  });

  it('a watchdog that refuses the token is watchdog_unauthorized, with no echo of its answer', async () => {
    watchdog.answer = () => ok({ error: 'Missing or wrong bearer token', code: 'unauthorized', echo: WATCHDOG_TOKEN }, { status: 401 });
    const res = await req('/api/monitoring/alerts');
    expect(res.status).toBe(502);
    const text = await exposed(res);
    expect(text).toContain('watchdog_unauthorized');
    expect(text).not.toContain(WATCHDOG_TOKEN);
    expect(text).not.toContain('Missing or wrong bearer');
  });

  it('without WATCHDOG_URL or the token (or a malformed one) nothing is called: watchdog_unconfigured, governance still shown', async () => {
    for (const over of [{ WATCHDOG_URL: undefined }, { WATCHDOG_STATUS_TOKEN: undefined }, { WATCHDOG_STATUS_TOKEN: 'short' }, { WATCHDOG_URL: `${WATCHDOG}/status` }, { WATCHDOG_URL: 'http://watchdog.example' }]) {
      watchdog.calls = [];
      const e = envWith({ ...withGovernance(), ...over });
      const res = await staffFetch(e, '/api/monitoring');
      expect(res.status).toBe(200);
      const d = await json<{ watchdog: { ok: boolean; code: string }; governance: { ok: boolean }; findings: { text: string }[] }>(res);
      expect(d.watchdog, JSON.stringify(over)).toEqual({ ok: false, code: 'watchdog_unconfigured' });
      expect(d.governance.ok).toBe(true);
      expect(d.findings[0]!.text).toMatch(/watchdog's status can't be read \(watchdog_unconfigured\)/u);
      expect(watchdog.calls).toEqual([]);
      expect((await staffFetch(e, '/api/monitoring/alerts')).status).toBe(503);
    }
  });

  it('maps its failures: 5xx, 503 not_configured, a redirect, non-JSON, a network error', async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => ok({ error: 'Internal error' }, { status: 500 }), 'watchdog_unavailable'],
      [() => ok({ error: 'The status token is not configured', code: 'not_configured' }, { status: 503 }), 'watchdog_unconfigured'],
      [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/status' } }), 'watchdog_bad_answer'],
      [() => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'watchdog_bad_answer'],
      [() => ok([1, 2, 3]), 'watchdog_bad_answer'],
      [() => Promise.reject(new TypeError('Network connection lost.')), 'watchdog_unavailable'],
    ];
    for (const [answer, code] of cases) {
      watchdog.answer = answer;
      const d = await json<{ watchdog: { ok: boolean; code: string } }>(await req('/api/monitoring'));
      expect(d.watchdog, code).toEqual({ ok: false, code });
      const page = await req('/api/monitoring/actions');
      expect(await json(page), code).toMatchObject({ error: { code } });
    }
    // The redirect is never followed: the one call per request is to the watchdog itself.
    watchdog.answer = () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } });
    watchdog.calls = [];
    await req('/api/monitoring');
    expect(watchdog.calls.map((c) => c.path)).toEqual(['/status']);
  });
});

describe('size caps and timeouts', () => {
  const big = (bytes: number) => ({ ...statusBody(), pad: 'x'.repeat(bytes) });

  it('refuses an answer over the cap by Content-Length, and while streaming without one', async () => {
    watchdog.answer = () => ok(big(WATCHDOG_LIMITS.status));
    expect((await json<{ watchdog: unknown }>(await req('/api/monitoring'))).watchdog).toEqual({ ok: false, code: 'watchdog_too_large' });
    // No Content-Length: a stream that keeps going past the cap is cut off.
    watchdog.answer = () => {
      let sent = 0;
      const chunk = new TextEncoder().encode(`{"pad":"${'y'.repeat(64 * 1024)}`);
      return new Response(new ReadableStream({ pull(c) { if (sent > WATCHDOG_LIMITS.alerts + chunk.byteLength) c.close(); else { sent += chunk.byteLength; c.enqueue(chunk); } } }), { status: 200 });
    };
    expect(await json(await req('/api/monitoring/alerts'))).toMatchObject({ error: { code: 'watchdog_too_large' } });
    // Just under the cap is read.
    watchdog.answer = () => ok({ actions: [], next_cursor: null, pad: 'z'.repeat(WATCHDOG_LIMITS.actions - 200) });
    expect((await req('/api/monitoring/actions')).status).toBe(200);
  });

  it('gives up after the timeout, headers or body', async () => {
    watchdogTiming.timeoutMs = 50;
    watchdog.answer = (_c, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const t0 = Date.now();
    expect((await json<{ watchdog: unknown }>(await req('/api/monitoring'))).watchdog).toEqual({ ok: false, code: 'watchdog_timeout' });
    // A body that starts and then stalls.
    watchdog.answer = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"alerts":[')); } }), { status: 200 });
    const res = await req('/api/monitoring/alerts');
    expect(res.status).toBe(504);
    expect(await json(res)).toMatchObject({ error: { code: 'watchdog_timeout' } });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe('text only', () => {
  it('controls and bidi overrides become U+FFFD; long strings and wide lists are cut; markup stays inert text', () => {
    expect(plainString('kid‮evil\u0007')).toBe('kid�evil�');
    expect(plainString('a'.repeat(3000))).toHaveLength(2001);
    const v = statusView(statusBody({ open_alerts: [alertRow(12, 'forged_key_change', { title: '<img src=x onerror=alert(1)>⁦', details: { kid: 'x'.repeat(5000), list: Array.from({ length: 900 }, (_, i) => i) } })] }), NOW, 'testnet');
    const a = v.openAlerts[0]!;
    expect(a.title).toBe('<img src=x onerror=alert(1)>�');
    const d = a.details as { kid: string; list: unknown[] };
    expect(d.kid.length).toBe(2001);
    expect(d.list).toHaveLength(501);
    expect(d.list.at(-1)).toBe('… 400 more');
  });

  it('keeps the latest deliveries of an alert and their total', async () => {
    const d = await json<{ alerts: { deliveries: unknown[]; deliveriesTotal: number }[] }>(await req('/api/monitoring/alerts'));
    expect(d.alerts[0]!.deliveries).toHaveLength(DELIVERIES_SHOWN);
    expect(d.alerts[0]!.deliveriesTotal).toBe(30);
  });

  it('gives the latest result of each channel, whatever a flooding channel pushed out of the last rows', () => {
    const row = (channel: string, at: number, ok: boolean, error: string | null = null) => ({ channel, kind: 'first', at, ok, error });
    const flood = Array.from({ length: 40 }, (_, i) => row('slack', NOW + 10 + i, false, 'not configured'));
    const v = alertView({ id: 5, kind: 'governance_change', severity: 'critical', deliveries: [row('pager', NOW, false, 'HTTP 429'), row('email', NOW, false, 'HTTP 500'), row('email', NOW + 1, true), ...flood, { kind: 'first' }] })!;
    expect(v.deliveries).toHaveLength(DELIVERIES_SHOWN);
    expect(v.deliveriesLatest).toEqual([row('pager', NOW, false, 'HTTP 429'), row('email', NOW + 1, true), row('slack', NOW + 49, false, 'not configured')]);
    expect(alertView({ id: 6, kind: 'governance_change', severity: 'info' })!.deliveriesLatest).toEqual([]);
  });

  it('a malformed alert or action row is dropped, never half-rendered', () => {
    const v = statusView(statusBody({ open_alerts: [{ id: 'x' }, null, alertRow(13, 'rpc_failing')], actions: [{ id: null }, 7] }), NOW, 'testnet');
    expect(v.openAlerts.map((a) => a.id)).toEqual([13]);
    expect(v.actions).toEqual([]);
  });
});

describe('GET /api/monitoring', () => {
  it('the watchdog status, the governance snapshot joined with it, the events, the findings', async () => {
    const res = await staffFetch(withGovernance(), '/api/monitoring');
    expect(res.status).toBe(200);
    const d = await json<Record<string, any>>(res);
    expect(d.watchdog).toMatchObject({ ok: true, env: 'sandbox-test', silent: false, runIntervalMs: RUN_INTERVAL_MS, lastRun: { id: 900, outcome: 'ok' } });
    expect(d.watchdog.actions[0]).toMatchObject({ method: 'pause', txHash: TX, txUrl: `https://testnet.nearblocks.io/txns/${TX}` });
    // Each pending key change carries the watchdog's sighting of the kid beside the API's JWKS verdict.
    expect(d.governance.keyChanges[0]).toMatchObject({ kid: 'k2', jwks: 'match', watchdogSeen: { firstSeenAt: NOW - 7_200_000, source: 'jwks' } });
    expect(d.governance.pause).toMatchObject({ paused: false, lastWatchdogPause: { at: NOW - 600_000, reason: 'forged_active_key' } });
    expect(d.governance.updaterKeyCheck).toEqual([{ publicKey: 'ed25519:new', onAccount: true, permissionOk: true }]);
    expect(d.governance.otherSignerKeys).toEqual([expect.objectContaining({ publicKey: 'ed25519:full', kind: 'full_access' })]);
    expect(d.events).toMatchObject({ ok: true });
    const texts = (d.findings as { text: string }[]).map((f) => f.text);
    expect(texts).toContain(`Upgrade proposed to code hash ${UPGRADE_HASH}, executable at ${new Date(NOW + 59_000).toISOString()}.`);
    expect(texts.some((t) => /Full-access key ed25519:full on the signer \(allowed on a dev env/u.test(t))).toBe(true);
  });

  it('the governance read fails on its own (the real API cannot reach NEAR here): the watchdog part stands', async () => {
    const d = await json<Record<string, any>>(await adminRequest('/api/monitoring'));
    expect(d.watchdog.ok).toBe(true);
    expect(d.governance).toEqual({ ok: false, code: 'near_unavailable' });
    expect((d.findings as { text: string }[]).some((f) => f.text === "The governance state can't be read (near_unavailable).")).toBe(true);
  });

  it('warns when the watchdog has been silent for more than two intervals', async () => {
    serveWatchdog(() => statusBody({ silent: false, last_run: { id: 1, started_at: NOW - 12 * 60_000, finished_at: NOW - 11 * 60_000, outcome: 'ok', first_run: false, checks: [] } }));
    const d = await json<Record<string, any>>(await req('/api/monitoring'));
    expect(d.watchdog.silent).toBe(true);
    expect(d.findings[0]).toMatchObject({ severity: 'critical', source: 'watchdog', playbook: { id: 'watchdog-down' } });
    expect(d.findings[0].text).toMatch(/silent for 11 min \(more than two 5 min intervals\)/u);
  });

  it('governance findings: paused, a forged pending key, a key Google still publishes, an untracked signer key, a due change', () => {
    const f = findingsOf({
      env: 'staging',
      now: NOW,
      watchdog: { ok: false, code: 'watchdog_timeout' },
      governance: {
        ok: true,
        data: governanceFixture({
          paused: true,
          keyChanges: [
            { id: 8, provider: 'google', kid: 'forged', op: 'Add', jwks: 'absent', due: true },
            { id: 9, provider: 'google', kid: 'k0', op: 'Remove', jwks: 'present', due: false },
          ],
          signerAccessKeys: [{ publicKey: 'ed25519:x', kind: 'function_call', updaterKey: false }, { publicKey: 'ed25519:full', kind: 'full_access' }],
          watchdogs: [],
          pendingOwner: { owner: 'new.dao.test', acceptableAtMs: NOW, due: true },
          updater: { lastRuns: [{ provider: 'google', outcome: 'error', code: 'rpc' }], proposals: [{ op: 'Add', kid: 'k9', cancelledSeenAtMs: NOW }] },
        }),
      },
    });
    const by = (re: RegExp) => f.find((x) => re.test(x.text));
    expect(by(/is paused/u)).toMatchObject({ severity: 'critical', playbook: { id: 'contract-paused' } });
    expect(by(/kid forged.*doesn't publish it/u)).toMatchObject({ severity: 'critical', playbook: { id: 'forged-key-change' } });
    expect(by(/kid k0.*still publishes it/u)).toMatchObject({ severity: 'critical', playbook: { id: 'published-key-removal' } });
    expect(by(/kid forged.*due and not executed/u)).toMatchObject({ severity: 'warning', playbook: { id: 'key-sync-stalled' } });
    expect(by(/ed25519:x on the signer is not an updater key/u)).toMatchObject({ severity: 'critical', playbook: { id: 'updater-key-stolen' } });
    // Outside a dev env a full-access key on the signer is critical (D86 Q9).
    expect(by(/Full-access key ed25519:full/u)?.severity).toBe('critical');
    expect(by(/no watchdog/u)?.severity).toBe('critical');
    expect(by(/Owner transfer proposed to new\.dao\.test/u)).toMatchObject({ playbook: { id: 'governance-change' } });
    expect(by(/Updater key ed25519:new is in get_governance but not on the signer/u)?.severity).toBe('warning');
    expect(by(/JWKS cron last run for google: error \(rpc\)/u)).toBeTruthy();
    expect(by(/was cancelled/u)).toBeTruthy();
    expect(f.map((x) => x.severity)).toEqual([...f.map((x) => x.severity)].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
  });
});

describe('the alert history and the ack', () => {
  it('pages the history with a validated cursor and severity, 25 a page', async () => {
    const d = await json<{ alerts: { id: number; playbook: { id: string } }[]; nextCursor: number }>(await req('/api/monitoring/alerts?cursor=40&severity=critical'));
    expect(watchdog.calls.at(-1)!.path).toBe('/alerts?limit=25&cursor=40&severity=critical');
    expect(d.alerts.map((a) => [a.id, a.playbook.id])).toEqual([
      [11, 'governance-change'],
      [10, 'key-change-lifecycle'],
    ]);
    expect(d.nextCursor).toBe(10);
    for (const q of ['cursor=0', 'cursor=abc', 'cursor=1%3B', 'severity=page']) expect((await req(`/api/monitoring/alerts?${q}`)).status, q).toBe(400);
    expect(await json(await req('/api/monitoring/actions?cursor=3'))).toMatchObject({ actions: [{ method: 'pause', txUrl: `https://testnet.nearblocks.io/txns/${TX}` }], nextCursor: null });
    expect(watchdog.calls.at(-1)!.path).toBe('/actions?limit=50&cursor=3');
  });

  it('alert #11 (sandbox-dev’s expected updater-key change): open, unacknowledged, ackable; the ack records the Access identity and stops only the re-sends', async () => {
    const before = await json<Record<string, any>>(await req('/api/monitoring'));
    const a11 = before.watchdog.openAlerts.find((a: { id: number }) => a.id === 11);
    expect(a11).toMatchObject({ kind: 'governance_change', severity: 'critical', open: true, canAck: true, ackedAt: null, playbook: { id: 'governance-change', title: getPlaybook('governance-change')!.title } });
    expect(before.findings.some((f: { text: string }) => /1 critical alert not acknowledged .*#11 governance_change/u.test(f.text))).toBe(true);

    // The body can't choose who acknowledged: the watchdog gets the Access identity.
    const res = await req('/api/monitoring/alerts/11/ack', { method: 'POST', body: { by: 'someone else' } });
    expect(res.status).toBe(200);
    const call = watchdog.calls.at(-1)!;
    expect(call).toMatchObject({ method: 'POST', path: '/alerts/11/ack', authorization: `Bearer ${WATCHDOG_TOKEN}`, body: { by: `${STAFF_EMAIL} (access:${STAFF_SUB})` } });
    const { alert } = await json<{ alert: Record<string, unknown> }>(res);
    expect(alert).toMatchObject({ id: 11, ackedBy: `${STAFF_EMAIL} (access:${STAFF_SUB})`, ackedVia: 'portal', canAck: false, open: true, resolvedAt: null });

    // A second ack keeps the first (409), as the watchdog does.
    const again = await req('/api/monitoring/alerts/11/ack', { method: 'POST', body: {} });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: { code: 'already_acknowledged' }, alert: { id: 11, ackedVia: 'portal' } });
  });

  it('an unknown alert is 404; a malformed id is 404 without a call', async () => {
    expect((await req('/api/monitoring/alerts/99/ack', { method: 'POST', body: {} })).status).toBe(404);
    watchdog.calls = [];
    for (const id of ['0', 'abc', '1e3', '-1', '1234567890123']) expect((await req(`/api/monitoring/alerts/${id}/ack`, { method: 'POST', body: {} })).status, id).toBe(404);
    expect(watchdog.calls).toEqual([]);
  });

  it('`by` falls back to the Access subject when the email has characters the watchdog refuses', () => {
    expect(ackBy({ kind: 'hana', id: STAFF_SUB, email: 'a.b+c@hana.example' })).toBe(`a.b+c@hana.example (access:${STAFF_SUB})`);
    expect(ackBy({ kind: 'hana', id: STAFF_SUB, email: "o'brien@hana.example" })).toBe(`access:${STAFF_SUB}`);
    expect(ackBy({ kind: 'hana', id: 'bad/sub', email: "o'brien@hana.example" })).toBeNull();
  });
});

describe('playbooks for every alert kind and incident (D126)', () => {
  it('every watchdog alert kind links to its playbook (the served id, else the package’s), and an open alert of each kind does too', async () => {
    serveWatchdog(() => statusBody({ open_alerts: ALERT_KIND_IDS.map((k, i) => alertRow(100 + i, k)) }));
    const d = await json<Record<string, any>>(await req('/api/monitoring'));
    const kinds = new Map((d.watchdog.alertKinds as { kind: string; playbook: { id: string } | null }[]).map((k) => [k.kind, k.playbook]));
    expect([...kinds.keys()].sort()).toEqual([...ALERT_KIND_IDS].sort());
    for (const k of ALERT_KIND_IDS) {
      expect(kinds.get(k)?.id, k).toBe(playbookForAlertKind(k)!.id);
      const open = (d.watchdog.openAlerts as { kind: string; playbook: { id: string } }[]).find((a) => a.kind === k)!;
      expect(open.playbook.id, k).toBe(playbookForAlertKind(k)!.id);
    }
    expect((d.findings as { text: string }[]).filter((f) => /no playbook/u.test(f.text))).toEqual([]);
  });

  it('every playbook has a page with each step’s who, detail and commands verbatim, in the spec’s order', async () => {
    for (const p of PLAYBOOKS) {
      const res = await req(`/api/playbooks/${p.id}`);
      expect(res.status, p.id).toBe(200);
      const { notes, playbook } = await json<{ notes: string[]; playbook: Record<string, any> }>(res);
      expect(notes.length).toBeGreaterThan(0);
      expect(Object.keys(playbook)).toEqual(['id', 'title', 'kind', 'severity', 'status', 'summary', 'alertKinds', 'signals', 'impact', 'steps', 'verify', 'followUps', 'refs', 'related']);
      expect(playbook.steps).toEqual(p.steps.map((s, i) => ({ n: i + 1, title: s.title, who: s.who, detail: s.detail, commands: s.commands ?? [] })));
      for (const s of playbook.steps) expect(ACTORS).toContain(s.who);
      expect(playbook.refs.map((r: { ref: string }) => r.ref)).toEqual(p.refs);
      for (const r of playbook.refs) expect(r.href).toMatch(/^https:\/\/github\.com\/Hana-Technology\/hana-id\/blob\/develop\/(docs|apps|README)/u);
      expect(playbook.related.map((r: { id: string }) => r.id)).toEqual(p.related ?? []);
    }
    expect((await req('/api/playbooks/no-such-playbook')).status).toBe(404);
  });

  it('the list filters by kind and severity, marks planned ones, and the search finds an incident by a word of its signals', async () => {
    const all = await json<{ playbooks: { id: string; status: string }[]; actors: string[] }>(await req('/api/playbooks'));
    expect(all.playbooks.map((p) => p.id)).toEqual(PLAYBOOKS.map((p) => p.id));
    expect(all.actors).toEqual([...ACTORS]);
    expect(all.playbooks.find((p) => p.id === 'email-issuer-key-compromised')?.status).toBe('planned');
    const incidents = await json<{ playbooks: { kind: string }[] }>(await req('/api/playbooks?kind=incident'));
    expect(incidents.playbooks.every((p) => p.kind === 'incident')).toBe(true);
    const crit = await json<{ playbooks: { severity: string }[] }>(await req('/api/playbooks?severity=critical'));
    expect(crit.playbooks.every((p) => p.severity === 'critical')).toBe(true);
    // A distinctive word from an incident's signals finds it.
    const target = PLAYBOOKS.find((p) => p.id === 'watchdog-down')!;
    const word = target.signals.join(' ').split(/\W+/u).find((w) => w.length > 6 && !PLAYBOOKS.some((o) => o.id !== target.id && o.kind === 'incident' && [o.title, o.summary, ...o.signals, ...o.impact].join(' ').toLowerCase().includes(w.toLowerCase())))!;
    expect(word).toBeTruthy();
    const found = await json<{ playbooks: { id: string }[] }>(await req(`/api/playbooks?kind=incident&q=${encodeURIComponent(word)}`));
    expect(found.playbooks.map((p) => p.id)).toEqual(['watchdog-down']);
    expect((await req('/api/playbooks?kind=other')).status).toBe(400);
  });

  it('an alert kind with no playbook renders the "no playbook" error, never a blank link', async () => {
    serveWatchdog(() => statusBody({ open_alerts: [alertRow(50, 'brand_new_kind')], alert_kinds: { ...ALERT_KINDS_WITH_PLAYBOOKS, brand_new_kind: { severity: 'critical', check: 'config', description: 'new', playbook: null } } }));
    const d = await json<Record<string, any>>(await req('/api/monitoring'));
    expect(d.watchdog.openAlerts[0]).toMatchObject({ kind: 'brand_new_kind', playbook: null });
    expect(d.findings.some((f: { text: string }) => f.text === 'Alert kind brand_new_kind has no playbook in @hana-id/playbooks.')).toBe(true);
  });
});

describe('the check registry (D83: every check has a portal rendering)', () => {
  it('has a view for every watchdog check id, and only those', () => {
    expect(Object.keys(CHECK_VIEWS).sort()).toEqual([...CHECK_IDS].sort());
  });

  it('a check the portal doesn’t know is shown as such, and is a finding', () => {
    const v = statusView(statusBody({ checks: { ...CHECKS, brand_new_check: 'A new one' }, last_run: { id: 1, started_at: NOW - 20_000, finished_at: NOW - 10_000, outcome: 'degraded', first_run: false, checks: [{ id: 'brand_new_check', outcome: 'error', detail: 'boom' }] } }), NOW, 'testnet');
    expect(v.checks.find((c) => c.id === 'brand_new_check')).toEqual({ id: 'brand_new_check', title: 'brand_new_check', shownIn: null, description: 'A new one', outcome: 'error', detail: 'boom', known: false });
    expect(v.checks.filter((c) => c.known).map((c) => c.id).sort()).toEqual([...CHECK_IDS].sort());
    const f = findingsOf({ env: 'sandbox-test', now: NOW, watchdog: { ok: true, view: v }, governance: { ok: true, data: governanceFixture({ pendingUpgrade: null }) } });
    expect(f.map((x) => x.text)).toContain('The watchdog runs check "brand_new_check", which this portal has no rendering for (D83).');
  });
});

describe('GET /api/governance/pending-upgrades', () => {
  it('answers AdminRpc.pendingUpgrades', async () => {
    const res = await staffFetch(withGovernance(), '/api/governance/pending-upgrades');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ pendingUpgrades: { upgrade: { codeHash: UPGRADE_HASH, release: null }, anyPending: true } });
  });

  it('crosses the real binding into the real AdminRpc (NEAR unreachable here: near_unavailable, 503)', async () => {
    const res = await adminRequest('/api/governance/pending-upgrades');
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ error: { code: 'near_unavailable' } });
  });
});
