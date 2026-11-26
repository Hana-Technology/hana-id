// D934 (piece P12 of docs/partner-platform-spec.md): web addresses an app may use only inside a frame. Through the
// ConsoleRpc and AdminRpc entrypoints and the Worker: the flag is set with the web address's own proposal (a member's,
// bound to the fresh sign-in by the v2 origin-change digest; staff's), each guarded as any add (pending, announced,
// the delay); set later at once by an owner or staff (a tightening, one ledger row, one version bump, open in a frozen
// org's kill-switch path), never cleared but by a removal and a new add; read by the login path (App.frameOnlyOrigins),
// inlined in the vault page only when the app has one in force, kept out of Passport Home's list (home-apps.test.ts)
// and of the dev-env session endpoints, and shown in the app's read, the announcements and the ledger.
import { NO_ANYWHERE_ORIGIN, nonceOf, originChangeDigest } from '@hana-id/console-core';
import { clearJwksCache } from '@hana-id/oidc';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import { detectDrift } from '../src/changes/drift.ts';
import worker from '../src/index.ts';
import { forgetCachedApps } from '../src/app-cache.ts';
import { clearViewCaches } from '../src/views.ts';
import { ORIGIN, appHeaders, call, chain, sessionBody, uid } from './helpers.ts';
import { DELAY, type OrgApp, adminRpc, appRow, consoleRpc, hana, linkToken, member, orgApp, ownClock, ownerChain, rows, stepUp, system } from './rpc-helpers.ts';

const WIDGET = 'https://widget.lumenpay.example';
const PAGE = 'https://coffeeclub.example';
const SIGNER = env.SIGNER_ACCOUNT;

let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
  clearJwksCache();
  clearViewCaches();
  forgetCachedApps();
});
afterEach(() => vi.restoreAllMocks());

async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

const nonce = async (app: OrgApp, add: string[], frameOnly: string[], version: number) =>
  nonceOf(await originChangeDigest({ signer: SIGNER, appId: app.id, add, remove: [], frameOnly, originsVersion: version }));
const gate = (appId: string) => rows<{ origin: string; frame_only: number; active_from: number | null }>('SELECT origin, frame_only, active_from FROM app_origins WHERE app_id = ?1 ORDER BY origin', appId);
const ack = async (changeId: string) => ok(adminRpc().ackNotice({ ...system(), changeId, cancelTokenHash: await linkToken().hash }));

async function vaultPage(key: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.VAULT_ORIGIN}/vault?pk=${encodeURIComponent(key)}`) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const inlined = async (res: Response) => JSON.parse(/<script type="application\/json" id="hana-config">([^<]*)<\/script>/u.exec(await res.text())![1]!) as Record<string, unknown>;
const frameAncestors = (res: Response) => /frame-ancestors ([^;]*)/u.exec(res.headers.get('content-security-policy') ?? '')?.[1];

describe('a member’s add marked frame-only: bound to the fresh sign-in, guarded as any add', () => {
  it('the v2 digest binds which adds are frame-only; the row, the change, the ledger and the app’s read say so; it waits as any add', async () => {
    ownerChain();
    const app = await orgApp({ origins: [PAGE] });
    const call_ = async (jwtNonce: string, frameOnly?: string[]) =>
      consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [WIDGET], remove: [], ...(frameOnly ? { frameOnly } : {}), expectedVersion: 0, stepUpJwt: await stepUp(jwtNonce) });
    // A sign-in for the plain add (v1) can't be spent on a frame-only one, nor the other way round.
    expect(await call_(await nonce(app, [WIDGET], [], 0), [WIDGET])).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await call_(await nonce(app, [WIDGET], [WIDGET], 0))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await gate(app.id)).toEqual([{ origin: PAGE, frame_only: 0, active_from: 0 }]);
    const r = await ok(call_(await nonce(app, [WIDGET], [WIDGET], 0), [WIDGET]));
    expect(r.changes).toEqual([expect.objectContaining({ origin: WIDGET, status: 'pending', frameOnly: true })]);
    expect(await gate(app.id)).toEqual([
      { origin: PAGE, frame_only: 0, active_from: 0 },
      { origin: WIDGET, frame_only: 1, active_from: null },
    ]);
    const [ledger] = await rows<{ kind: string; detail_json: string }>("SELECT kind, detail_json FROM app_changes WHERE app_id = ?1 AND kind = 'origin.proposed'", app.id);
    expect(JSON.parse(ledger!.detail_json)).toEqual({ changes: [{ changeId: r.changes[0]!.id, origin: WIDGET, frameOnly: true }] });
    // The announcement's change carries it; then the delay, as any add.
    const notice = (await ok(adminRpc().pendingNotices({ ...system(), limit: 100 }))).notices.find((n) => n.change.id === r.changes[0]!.id);
    expect(notice?.change).toMatchObject({ origin: WIDGET, frameOnly: true });
    await ack(r.changes[0]!.id);
    expect((await getAppByKey(env.DB, app.key))?.origins).toEqual([PAGE]);
    clock.advance(DELAY + 1);
    expect(await getAppByKey(env.DB, app.key)).toMatchObject({ origins: [PAGE, WIDGET].sort(), frameOnlyOrigins: [WIDGET] });
    const read = (await ok(consoleRpc(clock).getApp({ ...member(), orgId: app.org, appId: app.id }))).app;
    expect(read.origins).toEqual([expect.objectContaining({ origin: PAGE }), expect.objectContaining({ origin: WIDGET, frameOnly: true })]);
    expect(read.origins[0]).not.toHaveProperty('frameOnly');
    expect(read.changes.find((c) => c.id === r.changes[0]!.id)).toMatchObject({ frameOnly: true, status: 'active' });
  });

  it('refuses a frame-only web address that isn’t one of the adds, and the localhost wildcard, writing nothing', async () => {
    const app = await orgApp({ origins: [PAGE] });
    const base = { ...hana(), orgId: app.org, appId: app.id, expectedVersion: 0 };
    expect(await adminRpc().addOrigins({ ...base, add: [WIDGET], frameOnly: ['https://elsewhere.example'] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().addOrigins({ ...base, add: ['http://localhost:*'], frameOnly: ['http://localhost:*'] })).toMatchObject({ ok: false, code: 'bad_request' });
    expect((await appRow(app.id)).origins_version).toBe(0);
    expect(await gate(app.id)).toHaveLength(1);
  });
});

describe('staff’s add marked frame-only', () => {
  it('is a pending staff proposal like any other, frame-only as marked, the others usable anywhere', async () => {
    const app = await orgApp({ origins: [] });
    const r = await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [WIDGET, PAGE], frameOnly: [WIDGET.toUpperCase().replace('HTTPS://', 'https://')], expectedVersion: 0 }));
    expect(r.changes.map((c) => [c.origin, c.frameOnly ?? false])).toEqual([
      [PAGE, false],
      [WIDGET, true],
    ]);
    expect((await gate(app.id)).map((g) => [g.origin, g.frame_only])).toEqual([
      [PAGE, 0],
      [WIDGET, 1],
    ]);
  });
});

describe('a tightening: frameOnlyOrigins (an owner or staff), at once', () => {
  it('sets the flag on rows in force or waiting, one ledger row, one version bump; the next vault page sees it', async () => {
    const app = await orgApp({ origins: [PAGE, WIDGET] });
    const waiting = (await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://soon.example'], expectedVersion: 0 }))).changes[0]!;
    expect(await inlined(await vaultPage(app.key))).not.toHaveProperty('frameOnly');
    const r = await ok(consoleRpc(clock).frameOnlyOrigins({ ...member(), orgId: app.org, appId: app.id, origins: [WIDGET, 'https://soon.example'], expectedVersion: 1 }));
    expect(r.version).toBe(2);
    expect((await gate(app.id)).map((g) => [g.origin, g.frame_only])).toEqual([
      [PAGE, 0],
      ['https://soon.example', 1],
      [WIDGET, 1],
    ]);
    const [l] = await rows<{ kind: string; actor_kind: string; detail_json: string }>("SELECT kind, actor_kind, detail_json FROM app_changes WHERE app_id = ?1 AND kind = 'origin.frame_only'", app.id);
    expect(l).toMatchObject({ kind: 'origin.frame_only', actor_kind: 'member' });
    expect(JSON.parse(l!.detail_json)).toEqual({ origins: [{ origin: 'https://soon.example', wasInForce: false }, { origin: WIDGET, wasInForce: true }] });
    // The pending change still waits as before, now frame-only.
    expect((await ok(adminRpc().pendingNotices({ ...system(), limit: 100 }))).notices.find((n) => n.change.id === waiting.id)?.change.frameOnly).toBe(true);
    // The vault page is read fresh: it inlines the in-force frame-only one only; frame-ancestors still lists it.
    const page = await vaultPage(app.key);
    expect(frameAncestors(page)).toBe([PAGE, WIDGET].sort().join(' '));
    const config = await inlined(page);
    expect(config).toMatchObject({ origins: [PAGE, WIDGET].sort(), frameOnly: [WIDGET] });
    // Staff too; but never the app's last web address that works on its own page (the same refusal for both).
    expect(await adminRpc().frameOnlyOrigins({ ...hana(), orgId: app.org, appId: app.id, origins: [PAGE], expectedVersion: 2 })).toMatchObject({ ok: false, code: 'conflict', error: NO_ANYWHERE_ORIGIN });
    expect(await consoleRpc(clock).frameOnlyOrigins({ ...member(), orgId: app.org, appId: app.id, origins: [PAGE], expectedVersion: 2 })).toMatchObject({ ok: false, code: 'conflict', error: NO_ANYWHERE_ORIGIN });
    await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: ['https://kiosk.example'], expectedVersion: 2 }));
    await ok(adminRpc().frameOnlyOrigins({ ...hana(), orgId: app.org, appId: app.id, origins: [PAGE], expectedVersion: 3 }));
    expect(await inlined(await vaultPage(app.key))).toMatchObject({ frameOnly: [PAGE, WIDGET].sort() });
  });

  it('a proposal can’t leave the app with only frame-only web addresses; one usable-anywhere add or row is enough', async () => {
    const app = await orgApp({ origins: [] });
    const staff = (add: string[], frameOnly: string[], expectedVersion: number, remove?: string[]) =>
      remove ? null : adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add, frameOnly, expectedVersion });
    expect(await staff([WIDGET], [WIDGET], 0)).toMatchObject({ ok: false, code: 'conflict', error: NO_ANYWHERE_ORIGIN });
    expect(await gate(app.id)).toEqual([]);
    await ok(staff([WIDGET, PAGE], [WIDGET], 0)!);
    // With a usable-anywhere row there, a frame-only add alone is fine.
    await ok(staff(['https://w2.example'], ['https://w2.example'], 1)!);
    // A member’s: removing the only usable-anywhere one while adding only frame-only ones is refused before the step-up.
    ownerChain();
    const add = ['https://w3.example'];
    const jwt = await stepUp(nonceOf(await originChangeDigest({ signer: SIGNER, appId: app.id, add, remove: [PAGE], frameOnly: add, originsVersion: 2 })));
    expect(await consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add, remove: [PAGE], frameOnly: add, expectedVersion: 2, stepUpJwt: jwt })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('refuses, writing nothing: not an origin of the app, already frame-only, the localhost wildcard, a stale version', async () => {
    const app = await orgApp({ origins: [PAGE, WIDGET, 'http://localhost:*'] });
    const call_ = (origins: string[], expectedVersion = 0) => consoleRpc(clock).frameOnlyOrigins({ ...member(), orgId: app.org, appId: app.id, origins, expectedVersion });
    expect(await call_(['https://stranger.example'])).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await call_(['http://localhost:*'])).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await call_([WIDGET], 5)).toMatchObject({ ok: false, code: 'version_conflict' });
    await ok(call_([WIDGET]));
    expect(await call_([WIDGET], 1)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await rows("SELECT 1 FROM app_changes WHERE app_id = ?1 AND kind = 'origin.frame_only'", app.id)).toHaveLength(1);
    expect((await appRow(app.id)).origins_version).toBe(1);
  });

  it('the way back is a removal and a new add (which waits); the flag is never cleared in place', async () => {
    const app = await orgApp({ origins: [PAGE, WIDGET] });
    await ok(consoleRpc(clock).frameOnlyOrigins({ ...member(), orgId: app.org, appId: app.id, origins: [WIDGET], expectedVersion: 0 }));
    expect(await env.DB.prepare('UPDATE app_origins SET frame_only = 0 WHERE app_id = ?1').bind(app.id).run().then(() => 'ok', (e: Error) => e.message)).toMatch(/removed and proposed again/u);
    await ok(consoleRpc(clock).removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: [WIDGET], expectedVersion: 1 }));
    const again = (await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [WIDGET], expectedVersion: 2 }))).changes[0]!;
    expect(again.frameOnly).toBeUndefined();
    expect(await gate(app.id)).toEqual([
      { origin: PAGE, frame_only: 0, active_from: 0 },
      { origin: WIDGET, frame_only: 0, active_from: null },
    ]);
  });
});

describe('the login path and the partner endpoints', () => {
  it('a frame-only web address never calls the dev-env session endpoints itself; its pages still read GET /v1/app', async () => {
    const app = await orgApp({ origins: [PAGE, WIDGET] });
    await env.DB.prepare('UPDATE app_origins SET frame_only = 1 WHERE app_id = ?1 AND origin = ?2').bind(app.id, WIDGET).run();
    forgetCachedApps();
    const aud = `${uid()}.apps.googleusercontent.com`;
    chain({ [aud]: app.scope });
    const fromWidget = await call('/v1/sessions', { headers: appHeaders(app, WIDGET), body: await sessionBody(app.scope, aud) });
    expect(fromWidget.status).toBe(403);
    expect(await fromWidget.json()).toMatchObject({ code: 'origin_not_allowed' });
    // The same refusal as for a web address the app doesn't list (nothing says which of its addresses it has).
    const stranger = await call('/v1/sessions', { headers: appHeaders(app, 'https://stranger.example'), body: await sessionBody(app.scope, aud) });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ code: 'origin_not_allowed' });
    const config = await call('/v1/app', { method: 'GET', headers: appHeaders(app, WIDGET) });
    expect(config.status).toBe(200);
    expect((await call('/v1/sessions', { headers: appHeaders(app, PAGE), body: await sessionBody(app.scope, aud) })).status).toBe(200);
    // Not shown to it either: the config names no other web address.
    expect(JSON.stringify(await config.json())).not.toContain(PAGE);
    void ORIGIN;
  });
});

describe('the confirmation page and the staff queue mark a frame-only web address', () => {
  it('a staff proposal on a shared wallet (four eyes): the queue’s second-person row and the confirmation page say which is frame-only', async () => {
    const app = await orgApp({ origins: [PAGE] });
    await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(app.scope).run();
    const r = await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [WIDGET, 'https://tea.example'], frameOnly: [WIDGET], expectedVersion: 0 }));
    const widgetChange = r.changes.find((c) => c.origin === WIDGET)!;
    const queue = await ok(adminRpc().platformQueue({ ...hana(), limit: 50 }));
    const mine = queue.secondPerson.filter((x) => x.appId === app.id);
    expect(mine.map((x) => [x.origin, x.frameOnly ?? false]).sort()).toEqual([
      ['https://tea.example', false],
      [WIDGET, true],
    ]);
    await ack(widgetChange.id);
    const view = (await ok(consoleRpc(clock).getConfirmation({ ...member(), orgId: app.org, changeId: widgetChange.id }))).confirmation;
    expect(view.changes.map((c) => [c.origin, c.frameOnly ?? false])).toEqual([
      ['https://tea.example', false],
      [WIDGET, true],
    ]);
  });
});

describe('drift: a frame-only web address made usable anywhere by a bare delete and insert', () => {
  const findings = async (appId: string) =>
    (await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE app_id = ?1 AND kind = 'drift'", appId)).map((r) => JSON.parse(r.detail_json) as { what: string; origin: string }).filter((d) => d.what === 'frame_only');

  it('a tightened address put back as usable anywhere is reported; a removal and a new add is not', async () => {
    const app = await orgApp({ origins: [PAGE, WIDGET, 'https://tea.example'] });
    await ok(consoleRpc(clock).frameOnlyOrigins({ ...member(), orgId: app.org, appId: app.id, origins: [WIDGET, 'https://tea.example'], expectedVersion: 0 }));
    // The bare writer: delete and insert (the triggers can't tell this from a removal and an add).
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1 AND origin = ?2').bind(app.id, WIDGET).run();
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(app.id, WIDGET).run();
    // The way back done properly for the other one.
    await ok(consoleRpc(clock).removeOrigins({ ...member(), orgId: app.org, appId: app.id, remove: ['https://tea.example'], expectedVersion: 1 }));
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(app.id, 'https://tea.example').run();
    await detectDrift(env);
    expect((await findings(app.id)).map((f) => f.origin)).toEqual([WIDGET]);
    // Once only.
    await detectDrift(env);
    expect(await findings(app.id)).toHaveLength(1);
  });

  it('an address its proposal marked, put back under the same change as usable anywhere, is reported', async () => {
    const app = await orgApp({ origins: [PAGE] });
    const c = (await ok(adminRpc().addOrigins({ ...hana(), orgId: app.org, appId: app.id, add: [WIDGET], frameOnly: [WIDGET], expectedVersion: 0 }))).changes[0]!;
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1 AND origin = ?2').bind(app.id, WIDGET).run();
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)').bind(app.id, WIDGET, c.id).run();
    await detectDrift(env);
    expect((await findings(app.id)).map((f) => f.origin)).toEqual([WIDGET]);
  });
});
