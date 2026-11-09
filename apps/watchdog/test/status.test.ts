// The read-only status endpoint for the admin portal (D83) and the ack endpoint.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CHECK_IDS } from '../src/checks.ts';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { BUILD_ID_RE as ENV_BUILD_ID_RE } from '@hana-id/env/build-id';
import { BUILD_ID_RE, handleRequest, SILENT_AFTER_MS } from '../src/status.ts';
import { Store } from '../src/store.ts';
import { alertsOf, emailJwk, IDENTITY_ISS, identityKey, initialized, jwk, linkStats, linkWindow, MIN, NO_GRACE, pinsOf, RecordingNotifier } from './helpers.ts';

const TOKEN = 'status-token-for-tests-only-0123456789abcdef';
const testEnv = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), WATCHDOG_STATUS_TOKEN: TOKEN, ...over });

function req(path: string, init: RequestInit & { token?: string | null } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set('authorization', `Bearer ${init.token ?? TOKEN}`);
  return new Request(`https://watchdog.test${path}`, { ...init, headers });
}

async function call(path: string, init: RequestInit & { token?: string | null } = {}, now = Date.now(), e: Env = testEnv()) {
  const res = await handleRequest(req(path, init), { env: e, store: new Store(env.DB), notifier: new RecordingNotifier(), now: () => now });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

describe('auth', () => {
  it('refuses a missing or wrong bearer token', async () => {
    expect((await call('/status', { token: null })).status).toBe(401);
    expect((await call('/status', { token: 'wrong-token-wrong-token-wrong-token-1234' })).status).toBe(401);
    expect((await call('/alerts', { token: `${TOKEN}x` })).status).toBe(401);
    expect((await call('/alerts/1/ack', { method: 'POST', token: null })).status).toBe(401);
  });

  it('fails closed without a (long enough) token configured', async () => {
    expect((await call('/status', {}, Date.now(), testEnv({ WATCHDOG_STATUS_TOKEN: undefined }))).status).toBe(503);
    expect((await call('/status', { token: 'short' }, Date.now(), testEnv({ WATCHDOG_STATUS_TOKEN: 'short' }))).status).toBe(503);
  });

  it('answers 404 for unknown paths and 405 for writes other than an ack', async () => {
    expect((await call('/')).status).toBe(404);
    expect((await call('/runs')).status).toBe(404);
    expect((await call('/status', { method: 'POST' })).status).toBe(405);
    expect((await call('/alerts', { method: 'DELETE' })).status).toBe(405);
    expect((await call('/alerts/1/ack')).status).toBe(405);
  });
});

describe('GET /status: the identity token (D210)', () => {
  it('serves the issuer, the pins in force and the last JWKS and discovery reads', async () => {
    const [a, b] = [await identityKey(), await identityKey()];
    const w = await initialized({ identity: { published: [a, b] } });
    const e = testEnv({ IDENTITY_ISS: IDENTITY_ISS, IDENTITY_PINS: JSON.stringify([a.kid, b.kid]) });
    const { body } = await call('/status', {}, w.clock.t, e);
    const id = body.identity as { iss: string; jwks_url: string; discovery_url: string; pinned: string[]; jwks: { count: number; unpinned: number; keys: { kid: string; pinned: boolean }[] }; discovery: { issuer: string; problems: unknown[] } };
    expect(id).toMatchObject({ iss: IDENTITY_ISS, jwks_url: `${IDENTITY_ISS}/jwks.json`, discovery_url: `${IDENTITY_ISS}/.well-known/openid-configuration`, pinned: [a.kid, b.kid] });
    expect(id.jwks).toMatchObject({ count: 2, unpinned: 0, private: 0, missing: [] });
    expect(id.jwks.keys.map((k) => [k.kid, k.pinned])).toEqual([[a.kid, true], [b.kid, true]]);
    expect(id.discovery).toMatchObject({ issuer: IDENTITY_ISS, problems: [] });
    const kinds = body.alert_kinds as Record<string, { severity: string; playbook: string }>;
    for (const k of ['identity_key_unpinned', 'identity_private_key_published', 'identity_discovery_mismatch', 'identity_jwks_unreadable']) expect(kinds[k]).toMatchObject({ severity: 'critical', playbook: 'identity-jwks-forged' });
    expect(kinds.identity_key_missing).toMatchObject({ severity: 'warning', playbook: 'identity-jwks-degraded' });
    expect(kinds.identity_key_on_chain).toMatchObject({ severity: 'critical', playbook: 'identity-key-on-chain' });
  });

  it('an env without an identity token: nulls, nothing pinned', async () => {
    const { body } = await call('/status');
    expect(body.identity).toMatchObject({ iss: null, jwks_url: null, discovery_url: null, pinned: null });
  });
});

describe('GET /status', () => {
  it('returns the last run, heartbeat, seen kids, actions, open alerts and the check registry', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    await w.run();
    const { status, body, headers } = await call('/status', {}, w.clock.t);
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ service: 'hana-id-watchdog', signer: 'signer.test.near', watchdog_account: 'watchdog.test.near', silent: false });
    expect((body.last_run as { checks: { id: string }[] }).checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(body.heartbeat).toMatchObject({ configured: true, ok: true, failures: 0 });
    expect((body.seen_kids as { kid: string }[]).map((k) => k.kid).sort()).toEqual(['k1', 'k1x']);
    expect((body.actions as { method: string }[]).map((a) => a.method)).toEqual(['delete_updater_key', 'delete_updater_key', 'cancel_issuer_key_change']);
    expect((body.open_alerts as { kind: string }[]).map((a) => a.kind)).toContain('forged_key_change');
    expect(Object.keys(body.checks as object)).toEqual(CHECK_IDS);
    expect((body.alert_kinds as Record<string, { playbook: string }>).forged_active_key).toMatchObject({ severity: 'critical', playbook: 'forged-active-key' });
  });

  it('serves its build id (D425): null unstamped or malformed, the format @hana-id/env checks', async () => {
    const { body } = await call('/status');
    expect(body.build).toBeNull();
    expect((await call('/status', {}, Date.now(), testEnv({ HANA_BUILD: '0485faa1c2d3' }))).body.build).toBe('0485faa1c2d3');
    expect((await call('/status', {}, Date.now(), testEnv({ HANA_BUILD: 'main; rm' }))).body.build).toBeNull();
    expect(BUILD_ID_RE.source).toBe(ENV_BUILD_ID_RE.source);
    expect(BUILD_ID_RE.flags).toBe(ENV_BUILD_ID_RE.flags);
  });

  it('serves the last relayer reading with its thresholds, and the relayer alert kinds with their playbook', async () => {
    const w = await initialized();
    w.chain.setBalance(3);
    await w.run();
    const { body } = await call('/status', {}, w.clock.t);
    const funds = body.relayer_funds as { account: string; available: string; keys: { pool: string }[]; thresholds: { balance: { warn: string; critical: string } } };
    expect(funds.account).toBe('relayer.test.near');
    expect(funds.available).toBe((3n * 10n ** 24n).toString());
    expect(funds.keys.map((k) => k.pool).sort()).toEqual(['home', 'owner', 'session', 'session', 'session']);
    expect(funds.thresholds.balance).toEqual({ warn: (5n * 10n ** 24n).toString(), critical: (10n ** 24n).toString() });
    expect((body.open_alerts as { kind: string }[]).map((a) => a.kind)).toContain('relayer_balance_low');
    const kinds = body.alert_kinds as Record<string, { severity: string; playbook: string }>;
    for (const k of ['relayer_balance_critical', 'relayer_allowance_critical', 'relayer_pool_empty']) expect(kinds[k]).toMatchObject({ severity: 'critical', playbook: 'relayer-out-of-funds' });
    for (const k of ['relayer_balance_low', 'relayer_allowance_low']) expect(kinds[k]).toMatchObject({ severity: 'warning', playbook: 'relayer-out-of-funds' });
  });

  it('serves the email pins, the chain email issuer at the last run, and the last link stats', async () => {
    const hana = await emailJwk(201);
    const pins = pinsOf({ hana: [hana] });
    const w = await initialized({ pins, before: (x) => void x.chain.emailIssuer([hana]) });
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 7), links_total: 12 });
    await w.run();
    const e = testEnv({ EMAIL_PINS: JSON.stringify(pins), EMAIL_JWKS_URL: 'https://api.test/v1/email/jwks.json' });
    const { body } = await call('/status', {}, w.clock.t, e);
    expect(body.email).toMatchObject({
      pinned: pins,
      jwks_url: 'https://api.test/v1/email/jwks.json',
      last: { pinned: pins, chain: { issuer: true, pre_v3: false, self_issued: { signers: [{ id: 'hana', kids: [hana.kid] }], required: 1 }, active_kids: [hana.kid] }, differences: [], weaker: [] },
    });
    expect(body.link_stats).toMatchObject({ thresholds: { per_scope_per_hour: 50, total_per_hour: 500 }, links_total: 12, current: { total: 7 } });
    const kinds = body.alert_kinds as Record<string, { severity: string; playbook: string }>;
    expect(kinds.signer_policy_mismatch).toMatchObject({ severity: 'critical', check: 'signer_policy', playbook: 'signer-policy-mismatch' });
    expect(kinds.link_threshold_reached).toMatchObject({ severity: 'critical', check: 'links', playbook: 'link-volume' });
    expect(kinds.link_volume_high).toMatchObject({ severity: 'warning', check: 'links', playbook: 'link-volume' });
    // Without pins: nothing pinned.
    const bare = (await call('/status', {}, w.clock.t)).body;
    expect(bare.email).toMatchObject({ pinned: null, jwks_url: null });
  });

  it('says silent when the last run is older than two intervals', async () => {
    const w = await initialized();
    expect((await call('/status', {}, w.clock.t + SILENT_AFTER_MS + MIN)).body.silent).toBe(true);
    // ...and before any run at all.
    await env.DB.prepare('DELETE FROM runs').run();
    expect((await call('/status', {}, w.clock.t)).body.silent).toBe(true);
  });
});

describe('GET /alerts and /actions', () => {
  it('pages the alert history newest first, with deliveries, and filters by severity', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost', NO_GRACE);
    w.chain.config.sponsors = [];
    await w.run();
    const all = await call('/alerts?limit=2', {}, w.clock.t);
    const page = all.body.alerts as { id: number; deliveries: unknown[] }[];
    expect(page).toHaveLength(2);
    expect(page[0]!.id).toBeGreaterThan(page[1]!.id);
    const next = await call(`/alerts?cursor=${String(all.body.next_cursor)}&limit=50`, {}, w.clock.t);
    expect((next.body.alerts as { id: number }[]).every((a) => a.id < page[1]!.id)).toBe(true);
    const crit = await call('/alerts?severity=critical', {}, w.clock.t);
    const critical = crit.body.alerts as { severity: string; deliveries: { channel: string }[] }[];
    expect(critical.every((a) => a.severity === 'critical')).toBe(true);
    expect(critical[0]!.deliveries.map((d) => d.channel).sort()).toEqual(['email', 'pager', 'slack']);
    expect((await call('/alerts?severity=loud')).status).toBe(400);
    expect((await call('/alerts?limit=0')).status).toBe(400);
    expect((await call('/alerts?cursor=x')).status).toBe(400);
    const actions = await call('/actions?limit=1', {}, w.clock.t);
    expect((actions.body.actions as unknown[]).length).toBe(1);
    expect(actions.body.next_cursor).not.toBeNull();
  });
});

describe('POST /alerts/:id/ack', () => {
  const ack = (id: number, body: unknown, now = Date.now()) =>
    call(`/alerts/${id}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now);

  it('records who acknowledged from the portal; stops re-sends, changes nothing else', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost', NO_GRACE);
    await w.run();
    const [forged] = await alertsOf(w.store, 'forged_key_change');
    const before = await w.store.getAlert(forged!.id);
    const res = await ack(forged!.id, { by: 'founder-a@example.com' }, w.clock.t);
    expect(res.status).toBe(200);
    expect(res.body.alert).toMatchObject({ acked_by: 'founder-a@example.com', acked_via: 'portal', acked_at: w.clock.t });
    const after = await w.store.getAlert(forged!.id);
    expect({ ...after, acked_at: null, acked_by: null, acked_via: null }).toEqual(before);
    // No re-send 15 min later.
    w.notifier.clear();
    w.clock.t += 15 * MIN;
    await w.run();
    expect(w.notifier.sent.filter((s) => s.msg.alertId === forged!.id)).toEqual([]);
    // A second ack keeps the first.
    const again = await ack(forged!.id, { by: 'founder-b@example.com' }, w.clock.t);
    expect(again.status).toBe(409);
    expect(again.body.alert).toMatchObject({ acked_by: 'founder-a@example.com' });
  });

  it('validates the request', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost', NO_GRACE);
    await w.run();
    const [forged] = await alertsOf(w.store, 'forged_key_change');
    expect((await ack(999999, { by: 'x' })).status).toBe(404);
    expect((await ack(forged!.id, { by: '' })).status).toBe(400);
    expect((await ack(forged!.id, { by: '<script>' })).status).toBe(400);
    expect((await ack(forged!.id, 'not json')).status).toBe(400);
    expect((await ack(forged!.id, { by: 'x'.repeat(2000) })).status).toBe(413);
    const noType = await call(`/alerts/${forged!.id}/ack`, { method: 'POST', body: '{"by":"a"}' });
    expect(noType.status).toBe(415);
    expect((await w.store.getAlert(forged!.id))?.acked_at).toBeNull();
  });
});

describe('the Worker', () => {
  it('serves the status endpoint through its fetch handler', async () => {
    const res = await worker.fetch(req('/status'), testEnv());
    expect(res.status).toBe(200);
    expect((await worker.fetch(req('/status', { token: null }), testEnv())).status).toBe(401);
  });
});
