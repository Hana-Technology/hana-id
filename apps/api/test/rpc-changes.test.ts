// Batch C5 (docs/batch-c-spec.md tests "Guarded changes" for staff proposals, the notice ack, cancel by an owner, by
// staff and by the link, waivers, expedite, versions, drift, the 20-origin and one-pending rules; "Apps, scopes" for
// createApp, assignScopeOrg, deleteApp and the security contacts; "Settings, keys"): through the AdminRpc and
// ConsoleRpc entrypoints, against local D1 with the 0001–0008 migrations.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import { detectDrift } from '../src/changes/drift.ts';
import { guardedChangesMaintenance } from '../src/guarded/cron.ts';
import worker from '../src/index.ts';
import { getSettingsRow, effectiveSettings } from '../src/vault/settings.ts';
import { preflightAllows } from '../src/origins.ts';
import { type Chain, ORIGIN, chain, newKey, seedApp, uid } from './helpers.ts';
import { autoApprovePolicy } from './vault-helpers.ts';
import {
  DELAY,
  HOUR,
  type OrgApp,
  adminRpc,
  appRow,
  consoleRpc,
  hana,
  ledgerCount,
  link,
  linkToken,
  member,
  memberProposal,
  newOrg,
  orgApp,
  ownClock,
  rows,
  system,
} from './rpc-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const NEW = 'https://new.example.com';
let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
});

async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

async function staffOrigin(app: OrgApp, origin = NEW, expectedVersion = 0) {
  return (await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [origin], expectedVersion }))).changes[0]!;
}

async function ack(changeId: string) {
  const { token, hash } = linkToken();
  const r = await adminRpc().ackNotice({ ...system(), changeId, cancelTokenHash: await hash });
  return { r, token };
}

const change = (id: string) => env.DB.prepare('SELECT * FROM guarded_changes WHERE id = ?1').bind(id).first<Record<string, unknown>>();
const originsOf = async (key: string) => (await getAppByKey(env.DB, key))?.origins ?? [];

/** A NEAR mock whose get_scope names these Oidc owners (subs) and Google clients. */
function scopeChain(owners: string[], clients: string[] = []): Chain {
  const near = chain();
  near.views.get_scope = (a) => ({
    id: a.scope_id,
    owners: [{ Near: { account_id: 'owner.test.near' } }, ...owners.map((sub) => ({ Oidc: { provider: 'google', sub } }))],
    clients: clients.map((c) => ['google', c]),
    pending: [],
    action_nonce: 0,
    allow_shared: false,
  });
  return near;
}

describe('staff proposals and the blocking notice', () => {
  it('an origin add stays inactive until the notice is acked and the full delay has passed, then is in force by predicate', async () => {
    const app = await orgApp({ firstSession: null });
    const c = await staffOrigin(app);
    expect(c).toMatchObject({ kind: 'origin_add', origin: NEW, status: 'pending', proposedByKind: 'hana', activeFrom: null });
    expect(await originsOf(app.key)).toEqual([ORIGIN]);
    expect(await preflightAllows(env.DB, env, NEW)).toBe(false);
    // The notice: the change is listed (with the org's contacts) until acked; a failed send leaves it unannounced.
    const notices = await ok(adminRpc().pendingNotices({ ...system(), limit: 100 }));
    expect(notices.notices.find((n) => n.change.id === c.id)).toMatchObject({ contacts: ['security@partner.example'], app: { id: app.id, orgId: app.org } });
    clock.advance(10 * DELAY);
    expect(await originsOf(app.key)).toEqual([ORIGIN]);
    const { r } = await ack(c.id);
    // A staff proposal gets the full delay even on a scope with no session yet (no waiver: it isn't createApp's).
    expect(r).toMatchObject({ ok: true, change: { notifiedAt: Date.now(), activeFrom: Date.now() + DELAY } });
    expect((r as { change: { waiver?: string } }).change.waiver).toBeUndefined();
    expect((await ok(adminRpc().pendingNotices({ ...system(), limit: 100 }))).notices.some((n) => n.change.id === c.id)).toBe(false);
    expect(await originsOf(app.key)).toEqual([ORIGIN]);
    clock.advance(DELAY);
    expect((await originsOf(app.key)).sort()).toEqual([NEW, ORIGIN].sort());
    expect(await preflightAllows(env.DB, env, NEW)).toBe(true);
    // No version bump on the ack; one on the proposal.
    expect((await appRow(app.id)).origins_version).toBe(1);
    // A second ack is not_pending; the hourly job records the activation once.
    expect((await ack(c.id)).r).toMatchObject({ ok: false, code: 'not_pending' });
    await guardedChangesMaintenance(env);
    expect(await change(c.id)).toMatchObject({ status: 'active' });
  });

  it('an app read shows a change in force as active before the hourly job records it, and stops counting it as waiting', async () => {
    const app = await orgApp({ firstSession: null });
    const c = await staffOrigin(app);
    const read = async () => {
      const detail = (await ok(consoleRpc().getApp({ ...member(), orgId: app.org, appId: app.id }))).app;
      const summary = (await ok(consoleRpc().listApps({ ...member(), orgId: app.org }))).apps.find((a) => a.id === app.id)!;
      const staff = (await ok(adminRpc().getApp({ ...hana(), orgId: app.org, appId: app.id }))).app;
      return { status: detail.changes.find((x) => x.id === c.id)?.status, waiting: summary.pendingChanges, staffStatus: staff.changes.find((x) => x.id === c.id)?.status };
    };
    // Not announced, then announced with its clock running: pending and counted, for partners and staff alike.
    expect(await read()).toEqual({ status: 'pending', waiting: 1, staffStatus: 'pending' });
    await ack(c.id);
    clock.advance(DELAY - 1);
    expect(await read()).toEqual({ status: 'pending', waiting: 1, staffStatus: 'pending' });
    // Its clock passed: in force by the gate's predicate, so the read says active and nothing waits, while the stored
    // row stays pending until the hourly job records it.
    clock.advance(1);
    expect(await originsOf(app.key)).toContain(NEW);
    expect(await change(c.id)).toMatchObject({ status: 'pending' });
    expect(await read()).toEqual({ status: 'active', waiting: 0, staffStatus: 'active' });
    // Cancel is refused (the origin is in force: an owner removes it instead), and nothing changed.
    expect(await consoleRpc().cancelChange({ ...member(), orgId: app.org, changeId: c.id })).toMatchObject({ ok: false, code: 'not_pending' });
    expect(await originsOf(app.key)).toContain(NEW);
    await guardedChangesMaintenance(env);
    expect(await change(c.id)).toMatchObject({ status: 'active' });
    expect(await read()).toEqual({ status: 'active', waiting: 0, staffStatus: 'active' });
  });

  it('a retry after a failed send acks with the same link token; the stored hash is the token’s', async () => {
    const app = await orgApp();
    const c = await staffOrigin(app);
    const { token, hash } = linkToken();
    // First run: the provider refused a send, so no ack. Second run: the same deterministic T, acked.
    expect(await adminRpc().ackNotice({ ...system(), changeId: c.id, cancelTokenHash: await hash })).toMatchObject({ ok: true });
    const stored = await env.DB.prepare('SELECT hex(cancel_token_hash) AS h FROM guarded_changes WHERE id = ?1').bind(c.id).first<{ h: string }>();
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(token.replace(/-/gu, '+').replace(/_/gu, '/')), (ch) => ch.charCodeAt(0))))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    expect(stored!.h).toBe(expected);
  });

  it('a staff proposal is refused within appChangeDelayMs of a scope assignment, and allowed after', async () => {
    const app = await orgApp({ assignedAt: Date.now() - DELAY / 2 });
    expect(await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [NEW], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('p'), expectedVersion: 0 })).toMatchObject({ ok: false, code: 'conflict' });
    clock.advance(DELAY);
    expect(await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [NEW], expectedVersion: 0 })).toMatchObject({ ok: true });
  });

  it('an open origin_add without a row (parked) counts for duplicates and the 20-origin cap', async () => {
    const app = await orgApp();
    const c = await staffOrigin(app, 'https://parked.example.com');
    await env.DB.prepare('DELETE FROM app_origins WHERE change_id = ?1').bind(c.id).run(); // app:origins:park
    expect(await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://parked.example.com'], expectedVersion: 1 })).toMatchObject({ ok: false, code: 'conflict' });
    // One row and one parked change: 18 more fit, 19 don't.
    const many = (n: number) => Array.from({ length: n }, (_, k) => `https://p${k}.example.com`);
    expect(await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: many(19), expectedVersion: 1 })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: many(18), expectedVersion: 1 })).toMatchObject({ ok: true });
  });

  it('the origin rules: refused origins, duplicates, and at most 20 active or pending per app', async () => {
    const app = await orgApp();
    const add = (origins: string[], v: number) => adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: origins, expectedVersion: v });
    expect(await add([env.VAULT_ORIGIN!], 0)).toMatchObject({ ok: false, code: 'origin_refused' });
    expect(await add(['http://plain.example.com'], 0)).toMatchObject({ ok: false, code: 'origin_refused' });
    expect(await add(['https://x.example.com/path'], 0)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await add([ORIGIN], 0)).toMatchObject({ ok: false, code: 'conflict' });
    const many = Array.from({ length: 19 }, (_, k) => `https://o${k}.example.com`);
    expect(await add([...many, 'https://one-too-many.example.com'], 0)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await add(many, 0)).toMatchObject({ ok: true });
    expect(await add(['https://twenty-first.example.com'], 1)).toMatchObject({ ok: false, code: 'conflict' });
    // Stored in ASCII form; an IDN is flagged with its decoded form in the views.
    const idn = await orgApp();
    await ok(adminRpc().addOrigins({ ...hana(), orgId: idn.org, appId: idn.id, add: ['https://BÜCHER.example'], expectedVersion: 0 }));
    const d = await ok(consoleRpc(clock).getApp({ ...member(), orgId: idn.org, appId: idn.id }));
    expect(d.app.origins.find((o) => o.idn)).toMatchObject({ origin: 'https://xn--bcher-kva.example', display: 'https://bücher.example', activeFrom: null });
    expect(d.app.changes[0]).toMatchObject({ origin: 'https://xn--bcher-kva.example', idn: true });
  });

  it('policies: one pending policy_set and one raw_sign_on per app; raw signing refused for a test app; the ack writes the pending value', async () => {
    const app = await orgApp({ live: true });
    const p1 = await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('one'), expectedVersion: 0 }));
    expect(p1.change).toMatchObject({ kind: 'policy_set', status: 'pending' });
    expect(p1.change.policyId).toMatch(/^[0-9a-f]{64}$/u);
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('two'), expectedVersion: 1 })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: { v: 1 }, expectedVersion: 1 })).toMatchObject({ ok: false, code: 'policy_invalid' });
    await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'raw_sign_on', expectedVersion: 1 }));
    expect(await adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'raw_sign_on', expectedVersion: 2 })).toMatchObject({ ok: false, code: 'conflict' });
    const test = await orgApp();
    expect(await adminRpc().proposeChange({ ...hana(), orgId: test.org, appId: test.id, kind: 'raw_sign_on', expectedVersion: 0 })).toMatchObject({ ok: false, code: 'env_mismatch' });
    // Nothing in apps until the ack; then pending with the full delay; in force only after it.
    expect(await appRow(app.id)).toMatchObject({ auto_approve_pending: null, raw_sign_pending: null, settings_version: 2 });
    await ok(ack(p1.change.id).then((x) => x.r));
    const row = await appRow(app.id);
    expect(row).toMatchObject({ auto_approve_effective_at: Date.now() + DELAY, settings_version: 2 });
    expect((await effectiveSettings((await getSettingsRow(env.DB, app.id))!, app.id, Date.now())).autoApprovePolicy).toBeNull();
    clock.advance(DELAY);
    expect((await effectiveSettings((await getSettingsRow(env.DB, app.id))!, app.id, Date.now())).autoApprovePolicy?.label).toBe('one');
    // Turning it off is immediate, ends the change, and bumps the version.
    expect(await consoleRpc(clock).turnOff({ ...member(), orgId: app.org, appId: app.id, what: 'policy', expectedVersion: 2 })).toEqual({ ok: true, version: 3 });
    expect(await appRow(app.id)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null });
    expect(await change(p1.change.id)).toMatchObject({ status: 'ended' });
  });
});

describe('cancel', () => {
  it('an owner cancels a pending origin add: the row goes and the version bumps', async () => {
    const app = await orgApp();
    const c = await staffOrigin(app);
    await ok(ack(c.id).then((x) => x.r));
    expect(await consoleRpc(clock).cancelChange({ ...member(), orgId: app.org, changeId: c.id })).toMatchObject({ ok: true, change: { status: 'cancelled' } });
    expect(await rows('SELECT origin FROM app_origins WHERE app_id = ?1', app.id)).toEqual([{ origin: ORIGIN }]);
    expect((await appRow(app.id)).origins_version).toBe(2);
    clock.advance(DELAY);
    expect(await originsOf(app.key)).toEqual([ORIGIN]);
  });

  it('Hana staff cancel a pending policy: the pending columns are cleared, the stored policy stays', async () => {
    const app = await orgApp({ live: true });
    const p = await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('p'), expectedVersion: 0 }));
    await ok(ack(p.change.id).then((x) => x.r));
    expect(await adminRpc().cancelChange({ ...hana(), orgId: app.org, changeId: p.change.id })).toMatchObject({ ok: true });
    expect(await appRow(app.id)).toMatchObject({ auto_approve_pending: null, auto_approve_effective_at: null, settings_version: 2 });
  });

  it('the emailed link cancels once, only its own change, and only until active_from', async () => {
    const app = await orgApp();
    const a = await staffOrigin(app, 'https://a.example.com', 0);
    const b = await staffOrigin(app, 'https://b.example.com', 1);
    const notYet = await adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://c.example.com'], expectedVersion: 2 });
    const ta = await ack(a.id);
    const tb = await ack(b.id);
    // Unannounced: no link yet. A's token for B: refused. Then A's link works once.
    expect(await consoleRpc(clock).cancelChangeByLink({ ...link(a.id), changeId: (notYet as { changes: { id: string }[] }).changes[0]!.id, token: ta.token })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc(clock).cancelChangeByLink({ ...link(b.id), changeId: b.id, token: ta.token })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await consoleRpc(clock).cancelChangeByLink({ ...link(a.id), changeId: a.id, token: ta.token })).toMatchObject({ ok: true, change: { status: 'cancelled', cancelledBy: 'link' } });
    expect(await consoleRpc(clock).cancelChangeByLink({ ...link(a.id), changeId: a.id, token: ta.token })).toMatchObject({ ok: false, code: 'not_pending' });
    const led = await rows<{ actor_kind: string; actor_id: string }>("SELECT actor_kind, actor_id FROM app_changes WHERE app_id = ?1 AND kind = 'change.cancelled'", app.id);
    expect(led).toEqual([{ actor_kind: 'link', actor_id: a.id }]);
    // After active_from the link no longer cancels (the change is in force: remove it instead).
    clock.advance(DELAY);
    expect(await consoleRpc(clock).cancelChangeByLink({ ...link(b.id), changeId: b.id, token: tb.token })).toMatchObject({ ok: false, code: 'not_pending' });
  });
});

describe('waivers', () => {
  it('no_session for createApp’s initial origins on a scope it created, while no user has a key there', async () => {
    const org = newOrg();
    await ok(adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: ['sec@partner.example'] }));
    const near = scopeChain(['owner-sub-1']);
    const scopeId = `s${uid()}`;
    const created = await ok(adminRpc().createApp({ ...hana(), orgId: org, scopeId, environment: 'test', name: 'Fresh', origins: [NEW, 'https://two.example.com'], orgOwnerSubs: ['owner-sub-1'] }));
    expect(created).toMatchObject({ createdScope: true, app: { orgId: org, scopeId, environment: 'test' } });
    expect(near.viewCalls.some((v) => v.method === 'get_scope')).toBe(true);
    const [c1, c2] = created.app.changes;
    expect((await ack(c1!.id)).r).toMatchObject({ ok: true, change: { waiver: 'no_session', activeFrom: Date.now() } });
    // The second initial origin also gets it: the first, now in force, came from the same createApp.
    expect((await ack(c2!.id)).r).toMatchObject({ ok: true, change: { waiver: 'no_session' } });
    expect((await originsOf(created.publishableKey)).sort()).toEqual(['https://two.example.com', NEW].sort());
    // A later staff proposal on the same fresh scope waits for the assignment delay, then gets the full delay.
    expect(await adminRpc().addOrigins({ ...hana(), orgId: org, appId: created.app.id, add: ['https://later.example.com'], expectedVersion: 1 })).toMatchObject({ ok: false, code: 'conflict' });
    clock.advance(DELAY);
    const later = (await ok(adminRpc().addOrigins({ ...hana(), orgId: org, appId: created.app.id, add: ['https://later.example.com'], expectedVersion: 1 }))).changes[0]!;
    expect((await ack(later.id)).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
  });

  it('no_session is dropped (full delay) once the scope saw a session, a vault share or another origin in force', async () => {
    const org = newOrg();
    await ok(adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: ['sec@partner.example'] }));
    scopeChain([]);
    const mk = async () => ok(adminRpc().createApp({ ...hana(), orgId: org, scopeId: `s${uid()}`, environment: 'test', name: 'Fresh', origins: [NEW], orgOwnerSubs: [] }));
    const a = await mk();
    await env.DB.prepare('UPDATE scopes SET first_session_at = ?2 WHERE scope_id = ?1').bind(a.app.scopeId, Date.now()).run();
    expect((await ack(a.app.changes[0]!.id)).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    const b = await mk();
    await env.DB.prepare("INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://direct.example.com', 0)").bind(b.app.id).run();
    expect((await ack(b.app.changes[0]!.id)).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
  });

  it('createApp on an existing scope records no waiver; its origins get the full delay', async () => {
    const app = await orgApp({ firstSession: null });
    scopeChain([]);
    const created = await ok(adminRpc().createApp({ ...hana(), orgId: app.org, scopeId: app.scope, environment: 'test', name: 'Second', origins: [NEW], orgOwnerSubs: [] }));
    expect(created.createdScope).toBe(false);
    expect((await ack(created.app.changes[0]!.id)).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
  });

  it('a member proposal with a verified step-up gets no_session only while the scope shows no user, fail closed', async () => {
    const fresh = await orgApp({ firstSession: null, origins: [] });
    const c = await memberProposal(fresh, { kind: 'origin_add', origin: NEW });
    expect((await ack(c)).r).toMatchObject({ ok: true, change: { waiver: 'no_session', activeFrom: Date.now() } });
    // Any sign of a user means the full delay: a first session, an origin of the scope already in force, a vault share,
    // a session marker, an identity count.
    const seen = await orgApp({ firstSession: Date.now(), origins: [] });
    expect((await ack(await memberProposal(seen, { kind: 'origin_add', origin: NEW }))).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    const live = await orgApp({ firstSession: null });
    expect((await ack(await memberProposal(live, { kind: 'origin_add', origin: NEW }))).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    const shared = await orgApp({ firstSession: null, origins: [] });
    await env.DB.prepare(
      "INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, created_at, idle_until, abs_expires_at) VALUES (randomblob(16), ?1, randomblob(32), randomblob(32), ?2, x'00', 1, 0, ?3, ?3)",
    )
      .bind(shared.id, ORIGIN, Date.now() + HOUR)
      .run();
    expect((await ack(await memberProposal(shared, { kind: 'origin_add', origin: NEW }))).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    // The app's session marker (migration 0009, D220): written once a session-pool relay settled, even with
    // first_session_at lost.
    const marked = await orgApp({ firstSession: null, origins: [] });
    await env.DB.prepare('INSERT INTO session_markers (app_id, first_at) VALUES (?1, 1)').bind(marked.id).run();
    expect((await ack(await memberProposal(marked, { kind: 'origin_add', origin: NEW }))).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    const counted = await orgApp({ firstSession: null, origins: [] });
    await env.DB.prepare("INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, '2026-11-02', 1)").bind(counted.id).run();
    expect((await ack(await memberProposal(counted, { kind: 'origin_add', origin: NEW }))).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    // A member proposal without a verified sub (no API-verified step-up) is no candidate.
    const nosub = await orgApp({ firstSession: null, origins: [] });
    const id = await memberProposal(nosub, { kind: 'origin_add', origin: NEW });
    await env.DB.prepare('UPDATE guarded_changes SET proposer_sub = NULL WHERE id = ?1').bind(id).run();
    expect((await ack(id)).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
  });

  it('loopback only for a member’s loopback origin on a test scope in a dev env', async () => {
    const test = await orgApp();
    expect((await ack(await memberProposal(test, { kind: 'origin_add', origin: 'http://localhost:5173' }))).r).toMatchObject({ ok: true, change: { waiver: 'loopback', activeFrom: Date.now() } });
    // Hana's loopback proposal gets the full delay.
    const staff = await staffOrigin(test, 'http://127.0.0.1:8080', 0);
    expect((await ack(staff.id)).r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    // Not in a production-network env.
    const prod = await orgApp();
    const id = await memberProposal(prod, { kind: 'origin_add', origin: 'http://localhost:3000' });
    const { hash } = linkToken();
    const r = await adminRpc().ackNotice.call(Object.assign(adminRpc(), { env: { ...env, ENV_NAME: 'production' } }), { ...system(), changeId: id, cancelTokenHash: await hash });
    expect(r).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
  });
});

describe('expedite', () => {
  it('only an announced member proposal, with a reason; recorded; no version bump', async () => {
    const app = await orgApp();
    const staff = await staffOrigin(app);
    await ok(ack(staff.id).then((x) => x.r));
    const reason = 'Confirmed by phone with sec@partner.example (not the proposer)';
    expect(await adminRpc().expediteChange({ ...hana(), changeId: staff.id, reason })).toMatchObject({ ok: false, code: 'forbidden' });
    const mine = await memberProposal(app, { kind: 'origin_add', origin: 'https://member.example.com' });
    expect(await adminRpc().expediteChange({ ...hana(), changeId: mine, reason })).toMatchObject({ ok: false, code: 'not_pending' });
    await env.DB.prepare('UPDATE scopes SET first_session_at = 1 WHERE scope_id = ?1').bind(app.scope).run();
    await ok(ack(mine).then((x) => x.r));
    expect(await adminRpc().expediteChange({ ...hana(), changeId: mine, reason: 'too short' })).toMatchObject({ ok: false, code: 'bad_request' });
    const v = (await appRow(app.id)).origins_version;
    expect(await adminRpc().expediteChange({ ...hana(), changeId: mine, reason })).toMatchObject({ ok: true, change: { activeFrom: Date.now(), expeditedBy: 'access-sub-staff-1' } });
    expect(await originsOf(app.key)).toContain('https://member.example.com');
    expect((await appRow(app.id)).origins_version).toBe(v);
    const led = await rows<{ detail_json: string; actor_kind: string }>("SELECT detail_json, actor_kind FROM app_changes WHERE app_id = ?1 AND kind = 'change.expedited'", app.id);
    expect(led).toHaveLength(1);
    expect(JSON.parse(led[0]!.detail_json)).toMatchObject({ changeId: mine, reason });
    expect(await adminRpc().expediteChange({ ...hana(), changeId: mine, reason })).toMatchObject({ ok: false, code: 'not_pending' });
  });
});

describe('versions', () => {
  it('bump on propose, remove, cancel and turn-off, never on ack, activation or expedite', async () => {
    const app = await orgApp({ live: true, origins: [ORIGIN, 'https://second.example.com'] });
    const v = async () => {
      const r = await appRow(app.id);
      return [r.origins_version, r.settings_version];
    };
    const c = await staffOrigin(app);
    expect(await v()).toEqual([1, 0]);
    await ok(ack(c.id).then((x) => x.r));
    expect(await v()).toEqual([1, 0]);
    clock.advance(DELAY);
    await guardedChangesMaintenance(env);
    expect(await v()).toEqual([1, 0]);
    await ok(consoleRpc(clock).removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: ['https://second.example.com'], expectedVersion: 1 }));
    expect(await v()).toEqual([2, 0]);
    const p = await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'raw_sign_on', expectedVersion: 0 }));
    expect(await v()).toEqual([2, 1]);
    await ok(adminRpc().cancelChange({ ...hana(), orgId: app.org, changeId: p.change.id }));
    expect(await v()).toEqual([2, 2]);
    await ok(consoleRpc(clock).turnOff({ ...member(), orgId: app.org, appId: app.id, what: 'raw_sign', expectedVersion: 2 }));
    expect(await v()).toEqual([2, 2]); // nothing was on: no write
    // Removing an origin in force ends its change.
    await ok(consoleRpc(clock).removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [NEW], expectedVersion: 2 }));
    expect(await change(c.id)).toMatchObject({ status: 'ended' });
    expect(await originsOf(app.key)).toEqual([ORIGIN]);
  });
});

describe('drift detection', () => {
  it('flags a directly inserted active origin, policy and raw-signing value once; explained values are not flagged', async () => {
    const app = await orgApp({ live: true });
    // Explained: a staff origin announced and in force; the seeded origin (active_from 0) has no baseline, so it drifts.
    const c = await staffOrigin(app);
    await ok(ack(c.id).then((x) => x.r));
    clock.advance(DELAY);
    await env.DB.prepare("INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://forged.example.com', 5)").bind(app.id).run();
    await env.DB.prepare("UPDATE apps SET raw_sign = 'approval', auto_approve_policy = ?2 WHERE id = ?1").bind(app.id, JSON.stringify(autoApprovePolicy('forged'))).run();
    await detectDrift(env);
    await detectDrift(env);
    const events = await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id);
    const what = events.map((e) => JSON.parse(e.detail_json) as { what: string; origin?: string }).map((d) => `${d.what}:${d.origin ?? ''}`).sort();
    expect(what).toEqual(['origin:https://forged.example.com', `origin:${ORIGIN}`, 'policy:', 'raw_sign:'].sort());
  });

  it('runs in the hourly cron', async () => {
    chain();
    const app = await orgApp({ live: true });
    await env.DB.prepare("UPDATE apps SET raw_sign_pending = 'approval', raw_sign_effective_at = 1 WHERE id = ?1").bind(app.id).run();
    const hourly = Math.floor(Date.now() / HOUR) * HOUR + 60_000;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: hourly }), env, ctx).catch(() => undefined);
    await waitOnExecutionContext(ctx);
    const events = await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id);
    expect(events.map((e) => JSON.parse(e.detail_json).what).sort()).toEqual(['origin', 'raw_sign_pending']);
  });

  it('a baseline value put back by hand after a kill switch ended it is drift (origin, raw signing, policy)', async () => {
    const policy = JSON.stringify(autoApprovePolicy('legacy'));
    const app = await orgApp({ live: true, origins: [ORIGIN, 'https://second.example.com'] });
    await env.DB.prepare("UPDATE apps SET raw_sign = 'approval', auto_approve_policy = ?2 WHERE id = ?1").bind(app.id, policy).run();
    await env.DB.prepare(
      "INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, ?2, ?3, ?4, 'migration.baseline', json_object('origins', json_array(?5, 'https://second.example.com'), 'rawSign', 'approval', 'autoApprovePolicy', ?6), 'system', 'migration:0006', ?7)",
    )
      .bind(Date.now(), app.org, app.id, app.scope, ORIGIN, policy, `migration-0006:${app.id}`)
      .run();
    await detectDrift(env);
    expect(await rows("SELECT id FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id)).toEqual([]);
    // The kill switches end each baseline value…
    await ok(consoleRpc(clock).removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: ['https://second.example.com'], expectedVersion: 0 }));
    await ok(consoleRpc(clock).turnOff({ ...member(), orgId: app.org, appId: app.id, what: 'raw_sign', expectedVersion: 0 }));
    await ok(consoleRpc(clock).turnOff({ ...member(), orgId: app.org, appId: app.id, what: 'policy', expectedVersion: 1 }));
    // …so writing them back by hand is drift, though the baseline still lists them.
    await env.DB.prepare("INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, 'https://second.example.com', 0)").bind(app.id).run();
    await env.DB.prepare("UPDATE apps SET raw_sign = 'approval', auto_approve_policy = ?2 WHERE id = ?1").bind(app.id, policy).run();
    await detectDrift(env);
    const what = (await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id))
      .map((e) => JSON.parse(e.detail_json) as { what: string; origin?: string })
      .map((d) => `${d.what}:${d.origin ?? ''}`)
      .sort();
    expect(what).toEqual(['origin:https://second.example.com', 'policy:', 'raw_sign:']);
  });

  it('the 0006 baseline and announced changes explain what they hold', async () => {
    const app = await orgApp({ live: true });
    await env.DB.prepare(
      "INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, ?2, ?3, ?4, 'migration.baseline', json_object('origins', json_array(?5), 'rawSign', 'approval'), 'system', 'migration:0006', ?6)",
    )
      .bind(Date.now(), app.org, app.id, app.scope, ORIGIN, `migration-0006:${app.id}`)
      .run();
    await env.DB.prepare("UPDATE apps SET raw_sign = 'approval' WHERE id = ?1").bind(app.id).run();
    const p = await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('ok'), expectedVersion: 0 }));
    await ok(ack(p.change.id).then((x) => x.r));
    await detectDrift(env);
    expect(await rows("SELECT id FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id)).toEqual([]);
    // A pending value whose effective time was pulled forward by hand is drift.
    await env.DB.prepare('UPDATE apps SET auto_approve_effective_at = ?2 WHERE id = ?1').bind(app.id, Date.now()).run();
    await detectDrift(env);
    expect(await rows("SELECT id FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id)).toHaveLength(1);
  });
});

describe('apps and scopes', () => {
  it('createApp refuses an org with no security contact and an on-chain owner who is not an owner of the org', async () => {
    const org = newOrg();
    scopeChain(['owner-sub-1', 'stranger-sub']);
    const input = { ...hana(), orgId: org, scopeId: `s${uid()}`, environment: 'live' as const, name: 'Live app', origins: [NEW], orgOwnerSubs: ['owner-sub-1'] };
    expect(await adminRpc().createApp(input)).toMatchObject({ ok: false, code: 'no_security_contact' });
    expect(await adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: ['b@partner.example', 'a@partner.example'] })).toEqual({ ok: true, emails: ['a@partner.example', 'b@partner.example'] });
    expect(await adminRpc().createApp({ ...input, requestId: `req_${uid()}` })).toMatchObject({ ok: false, code: 'scope_conflict' });
    const created = await ok(adminRpc().createApp({ ...input, requestId: `req_${uid()}`, orgOwnerSubs: ['owner-sub-1', 'stranger-sub'] }));
    expect(created.publishableKey).toMatch(/^pk_live_/u);
    expect(await getAppByKey(env.DB, created.publishableKey)).toMatchObject({ org_id: org, environment: 'live', origins: [] });
    expect((await appRow(created.app.id)).publishable_key).toBe(created.publishableKey);
    expect(await rows("SELECT kind FROM app_changes WHERE app_id = ?1", created.app.id)).toEqual([{ kind: 'app.created' }]);
    // Another org or environment for an existing scope is refused.
    const other = newOrg();
    await ok(adminRpc().setSecurityContacts({ ...hana(), orgId: other, emails: ['x@other.example'] }));
    expect(await adminRpc().createApp({ ...input, requestId: `req_${uid()}`, orgId: other })).toMatchObject({ ok: false, code: 'scope_conflict' });
    expect(await adminRpc().createApp({ ...input, requestId: `req_${uid()}`, environment: 'test', orgOwnerSubs: ['owner-sub-1', 'stranger-sub'] })).toMatchObject({ ok: false, code: 'env_mismatch' });
    // NEAR down: near_unavailable, nothing written.
    const before = await ledgerCount();
    const near = chain();
    near.views.get_scope = () => {
      throw new Error('node down');
    };
    expect(await adminRpc().createApp({ ...input, requestId: `req_${uid()}`, scopeId: `s${uid()}` })).toMatchObject({ ok: false, code: 'near_unavailable' });
    expect(await ledgerCount()).toBe(before);
  });

  it('assignScopeOrg refuses a non-legacy scope and moves every app of a two-app scope in one statement', async () => {
    const scope = `s${uid()}`;
    const a = await seedApp({ scope });
    const b = await seedApp({ scope });
    const org = newOrg();
    scopeChain(['sub-a']);
    expect(await adminRpc().assignScopeOrg({ ...hana(), scopeId: scope, orgId: org, orgOwnerSubs: [] })).toMatchObject({ ok: false, code: 'scope_conflict' });
    expect(await adminRpc().assignScopeOrg({ ...hana(), scopeId: scope, orgId: org, orgOwnerSubs: ['sub-a'] })).toEqual({ ok: true, apps: 2 });
    expect((await appRow(a.id)).org_id).toBe(org);
    expect((await appRow(b.id)).org_id).toBe(org);
    expect(await adminRpc().assignScopeOrg({ ...hana(), scopeId: scope, orgId: newOrg(), orgOwnerSubs: ['sub-a'] })).toMatchObject({ ok: false, code: 'scope_conflict' });
    // Updating one app's org alone violates the trigger.
    await expect(env.DB.prepare('UPDATE apps SET org_id = ?2 WHERE id = ?1').bind(a.id, newOrg()).run()).rejects.toThrow(/no scopes row/u);
    // Staff proposals now wait appChangeDelayMs after the assignment.
    await env.DB.prepare('INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES (?1, ?2, ?3, ?4)').bind(org, 's@x.example', 't', 0).run();
    expect(await adminRpc().addOrigins({ ...hana(), orgId: org, appId: a.id, add: [NEW], expectedVersion: 0 })).toMatchObject({ ok: false, code: 'conflict' });
    const led = await rows<{ kind: string; scope_id: string }>("SELECT kind, scope_id FROM app_changes WHERE org_id = ?1", org);
    expect(led).toEqual([{ kind: 'scope.assigned', scope_id: scope }]);
  });

  it('deleteApp revokes every key, suspends, cancels pending changes; the legacy column points at no key', async () => {
    const app = await orgApp();
    const extra = await ok(consoleRpc(clock).createKey({ ...member(), orgId: app.org, appId: app.id }));
    const c = await staffOrigin(app);
    expect(await adminRpc().deleteApp({ ...hana(), appId: app.id })).toEqual({ ok: true });
    expect(await getAppByKey(env.DB, app.key)).toBeNull();
    expect(await getAppByKey(env.DB, extra.key.key)).toBeNull();
    const row = await appRow(app.id);
    expect(row).toMatchObject({ suspended_by: 1, status: 'suspended' });
    expect(row.deleted_at).not.toBeNull();
    expect(String(row.publishable_key)).toMatch(/^pk_test_0revoked/u);
    expect(await change(c.id)).toMatchObject({ status: 'cancelled' });
    expect(await rows('SELECT id FROM app_keys WHERE app_id = ?1 AND (revoked_at IS NULL OR revoked_at > ?2)', app.id, Date.now())).toEqual([]);
    // Deleted: every write is not_found, and Hana's bit can't be cleared.
    expect(await adminRpc().setSuspended({ ...hana(), appId: app.id, bit: 1, suspended: false })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await adminRpc().deleteApp({ ...hana(), appId: app.id })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await consoleRpc(clock).listApps({ ...member(), orgId: app.org })).toMatchObject({ ok: true, apps: [{ id: app.id, deleted: true }] });
  });

  it('security contacts: only through AdminRpc; the ledger lists the old and the new set', async () => {
    const org = newOrg();
    await ok(adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: ['a@p.example'] }));
    await ok(adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: ['b@p.example', 'c@p.example'] }));
    expect(await adminRpc().getSecurityContacts({ ...hana(), orgId: org })).toEqual({ ok: true, emails: ['b@p.example', 'c@p.example'] });
    const led = await rows<{ detail_json: string }>("SELECT detail_json FROM app_changes WHERE org_id = ?1 AND kind = 'org.security_contacts' ORDER BY seq", org);
    expect(led.map((r) => JSON.parse(r.detail_json))).toEqual([
      { old: [], new: ['a@p.example'] },
      { old: ['a@p.example'], new: ['b@p.example', 'c@p.example'] },
    ]);
    expect(await adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: ['Upper@p.example'] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().setSecurityContacts({ ...hana(), orgId: org, emails: [] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect('setSecurityContacts' in consoleRpc(clock)).toBe(false);
  });

  it('the feeds: scopes by cursor, changes since a seq, security events marked once; relayer public keys only', async () => {
    const app = await orgApp();
    const page = await ok(adminRpc().listScopes({ ...system(), limit: 1 }));
    expect(page.scopes).toHaveLength(1);
    expect(page.next).toBeDefined();
    const all = await ok(adminRpc().listScopes({ ...system(), limit: 500 }));
    expect(all.scopes.some((s) => s.scopeId === app.scope && s.orgId === app.org)).toBe(true);
    const seq = (await env.DB.prepare('SELECT MAX(seq) AS s FROM app_changes').first<{ s: number }>())!.s ?? 0;
    await staffOrigin(app);
    const since = await ok(adminRpc().changesSince({ ...system(), seq, limit: 10 }));
    expect(since.changes.map((c) => c.kind)).toEqual(['origin.proposed']);
    await env.DB.prepare("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'drift', '{}')").bind(`se_${uid()}`, Date.now()).run();
    const un = await ok(adminRpc().securityEvents({ ...system(), unnotifiedOnly: true, limit: 500 }));
    expect(un.events.length).toBeGreaterThan(0);
    await ok(adminRpc().markSecurityEventNotified({ ...system(), ids: un.events.map((e) => e.id) }));
    expect((await ok(adminRpc().securityEvents({ ...system(), unnotifiedOnly: true, limit: 500 }))).events).toEqual([]);
    const keys = await ok(adminRpc().relayerKeys({ ...system() }));
    expect(keys.keys.length).toBeGreaterThan(0);
    for (const k of keys.keys) expect(k.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/u);
    const secrets = [...JSON.parse(env.RELAYER_KEYS), ...JSON.parse(env.OWNER_RELAYER_KEYS!)] as string[];
    expect(JSON.stringify(keys)).not.toContain(secrets[0]!.slice(8, 30));
  });
});

describe('keys', () => {
  it('rotation keeps the old key valid for exactly 24 h; revoke is immediate; the legacy column follows a valid key', async () => {
    const app = await orgApp();
    const key = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1', app.id))[0]!.id;
    const r = await ok(consoleRpc(clock).rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: key }));
    expect(r.oldKeyRevokedAt).toBe(Date.now() + 24 * HOUR);
    expect(r.key.key).toMatch(/^pk_test_/u);
    expect((await appRow(app.id)).publishable_key).toBe(r.key.key);
    expect(await getAppByKey(env.DB, app.key, Date.now() + 24 * HOUR - 1)).not.toBeNull();
    expect(await getAppByKey(env.DB, app.key, Date.now() + 24 * HOUR)).toBeNull();
    expect(await consoleRpc(clock).rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: key })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await ok(consoleRpc(clock).revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: key }))).toEqual({ ok: true });
    expect(await getAppByKey(env.DB, app.key)).toBeNull();
    expect(await ok(consoleRpc(clock).revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: r.key.id }))).toEqual({ ok: true, warning: 'last_key' });
    expect(await getAppByKey(env.DB, r.key.key)).toBeNull();
    expect(String((await appRow(app.id)).publishable_key)).toMatch(/^pk_test_0revoked/u);
    // A new key brings the legacy column back to a real key.
    const fresh = await ok(consoleRpc(clock).createKey({ ...member(), orgId: app.org, appId: app.id }));
    expect((await appRow(app.id)).publishable_key).toBe(fresh.key.key);
    const kinds = await rows<{ kind: string }>("SELECT kind FROM app_changes WHERE app_id = ?1 AND kind LIKE 'key.%' ORDER BY seq", app.id);
    expect(kinds.map((k) => k.kind)).toEqual(['key.rotated', 'key.revoked', 'key.revoked', 'key.created']);
  });

  it('a legacy reader of apps.publishable_key and status (apps/email-issuer until it moves, D206) never accepts a revoked, rotating or deleted app’s key', async () => {
    // The issuer's lookup on feat/email-login-4: the app whose publishable_key equals the key sent, active iff status.
    const issuer = async (pk: string) => {
      const r = await env.DB.prepare('SELECT status FROM apps WHERE publishable_key = ?1').bind(pk).first<{ status: string }>();
      return r?.status === 'active';
    };
    const app = await orgApp();
    expect(await issuer(app.key)).toBe(true);
    const second = await ok(consoleRpc(clock).createKey({ ...member(), orgId: app.org, appId: app.id }));
    expect(await issuer(app.key)).toBe(true); // the older key stays the legacy one while it has no revocation
    const oldId = (await rows<{ id: string }>('SELECT id FROM app_keys WHERE app_id = ?1 AND key = ?2', app.id, app.key))[0]!.id;
    const rotated = await ok(consoleRpc(clock).rotateKey({ ...member(), orgId: app.org, appId: app.id, keyId: oldId }));
    expect(await issuer(app.key)).toBe(false); // refused at once, before the grace ends (D225)
    expect(await issuer(second.key.key)).toBe(true);
    await ok(consoleRpc(clock).revokeKey({ ...member(), orgId: app.org, appId: app.id, keyId: second.key.id }));
    expect(await issuer(second.key.key)).toBe(false);
    expect(await issuer(rotated.key.key)).toBe(true);
    await ok(adminRpc().deleteApp({ ...hana(), appId: app.id }));
    for (const k of [app.key, second.key.key, rotated.key.key]) expect(await issuer(k)).toBe(false);
    expect(await env.DB.prepare('SELECT status FROM apps WHERE id = ?1').bind(app.id).first()).toEqual({ status: 'suspended' });
  });

  it('at most 5 unrevoked keys; the prefix is the scope’s environment', async () => {
    const app = await orgApp({ live: true });
    for (let k = 0; k < 4; k++) expect((await ok(consoleRpc(clock).createKey({ ...member(), orgId: app.org, appId: app.id }))).key.key).toMatch(/^pk_live_/u);
    expect(await consoleRpc(clock).createKey({ ...member(), orgId: app.org, appId: app.id })).toMatchObject({ ok: false, code: 'key_limit' });
    expect((await appRow(app.id)).publishable_key).toBe(app.key);
    await expect(env.DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES ('key_x1', ?1, ?2, 't', 0)").bind(app.id, newKey('pk_test_')).run()).rejects.toThrow();
  });
});

describe('settings', () => {
  it('ranges match batch B’s; the web client must be one of the scope’s on-chain Google clients; names are display-safe', async () => {
    const app = await orgApp();
    const s = (x: Record<string, unknown>, v = 0) => consoleRpc(clock).updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: v, ...x });
    expect(await s({ sessionTtlMs: 59 * 60 * 1000 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await s({ idleTtlMs: 13 * HOUR })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await s({ name: 'Bad‮name' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await s({ name: 'x'.repeat(65) })).toMatchObject({ ok: false, code: 'bad_request' });
    scopeChain([], ['web-client.apps.googleusercontent.com']);
    expect(await s({ googleWebClientId: 'other.apps.googleusercontent.com' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await s({ googleWebClientId: 'web-client.apps.googleusercontent.com', sessionTtlMs: 2 * HOUR, idleTtlMs: HOUR, name: '  Café  ' })).toEqual({ ok: true, version: 1 });
    expect(await appRow(app.id)).toMatchObject({ google_web_client_id: 'web-client.apps.googleusercontent.com', session_ttl_ms: 2 * HOUR, idle_ttl_ms: HOUR, name: 'Café' });
    expect(await s({ persistence: 'none' }, 0)).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await s({ googleWebClientId: null }, 1)).toEqual({ ok: true, version: 2 });
    const near = chain();
    near.views.get_scope = () => {
      throw new Error('down');
    };
    expect(await s({ googleWebClientId: 'web-client.apps.googleusercontent.com' }, 2)).toMatchObject({ ok: false, code: 'near_unavailable' });
  });

  it('a session TTL lowered under a stored or proposed policy’s maxConsentMs is policy_invalid', async () => {
    const app = await orgApp({ live: true });
    await ok(adminRpc().proposeChange({ ...hana(), orgId: app.org, appId: app.id, kind: 'policy_set', policy: autoApprovePolicy('12h'), expectedVersion: 0 }));
    expect(await consoleRpc(clock).updateSettings({ ...member(), orgId: app.org, appId: app.id, expectedVersion: 1, sessionTtlMs: 2 * HOUR, idleTtlMs: HOUR })).toMatchObject({ ok: false, code: 'policy_invalid' });
  });

  it('setLogo points at an object of this app only', async () => {
    const app = await orgApp();
    const other = await orgApp();
    expect(await consoleRpc(clock).setLogo({ ...member(), orgId: app.org, appId: app.id, logoKey: `logos/${other.id}/${'b'.repeat(64)}.png`, expectedVersion: 0 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc(clock).setLogo({ ...member(), orgId: app.org, appId: app.id, logoKey: `logos/${app.id}/${'b'.repeat(64)}.svg`, expectedVersion: 0 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await consoleRpc(clock).setLogo({ ...member(), orgId: app.org, appId: app.id, logoKey: `logos/${app.id}/${'b'.repeat(64)}.png`, expectedVersion: 0 })).toEqual({ ok: true, version: 1 });
    expect(await consoleRpc(clock).setLogo({ ...member(), orgId: app.org, appId: app.id, logoKey: null, expectedVersion: 1 })).toEqual({ ok: true, version: 2 });
  });
});
