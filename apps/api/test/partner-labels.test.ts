// D894 (partner labels, piece 2): storage, the guarded change, the staff veto, the switches, drift and the delivery in
// GET /v1/app, through the ConsoleRpc and AdminRpc entrypoints as the console and the admin Worker call them, with real
// step-up tokens (rpc-helpers.ts) and a frozen clock that each test moves itself (D712: never the real clock across a
// boundary; the cron and drift take the test's `now`).
import { type LabelControlTarget, base58, labelChangeDigest, nonceOf, sha256, utf8 } from '@hana-id/console-core';
import { clearJwksCache } from '@hana-id/oidc';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelsMaintenance } from '../src/labels/cron.ts';
import { detectLabelDrift } from '../src/labels/drift.ts';
import { LABEL_LAPSE_MS } from '../src/labels/sql.ts';
import { type LabelPlan, limitProblem } from '../src/labels/store.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import { clearViewCaches } from '../src/views.ts';
import { ORIGIN, call } from './helpers.ts';
import { VAULT, hanaHeaders } from './login-helpers.ts';
import { DELAY, type OrgApp, hana, link, linkToken, member, newOrg, orgApp, ownClock, ownerChain, rows, stepUp, system } from './rpc-helpers.ts';

const ON = { ...env, PARTNER_LABELS: 'on' } as typeof env;
const SIGNER = env.SIGNER_ACCOUNT;
const DAY = 24 * 60 * 60 * 1000;

let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
  clearJwksCache();
  clearViewCaches();
  ownerChain();
});
afterEach(() => vi.restoreAllMocks());

/** ConsoleRpc as the console gets it; each call first moves the clock 2 s on, as a person clicking would (the org's hot-DB budget). */
const consoleRpc = (e: typeof env = ON): ConsoleRpc => {
  const rpc = new ConsoleRpc(createExecutionContext(), e);
  return new Proxy(rpc, {
    get(t, p) {
      const v: unknown = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        clock.advance(2000);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
};

/** A second app on `app`'s scope, in its org (seedApp would make it in org_legacy, which the scope isn't in any more). */
async function sameScopeApp(app: OrgApp): Promise<OrgApp> {
  const id = `app_${Math.random().toString(36).slice(2)}x`;
  const key = `pk_test_${base58(crypto.getRandomValues(new Uint8Array(16)))}`;
  await env.DB.prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, plan, org_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(id, `Test ${id}`, app.scope, key, 'active', 'free', app.org).run();
  await env.DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${id}`, id, key, Date.now()).run();
  await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(id, ORIGIN).run();
  return { ...app, id, key };
}
const adminRpc = (e: typeof env = ON) => new AdminRpc(createExecutionContext(), e);

async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}
async function fail<T>(p: Promise<T>): Promise<{ code: string; error?: string }> {
  const r = (await p) as { ok: boolean; code: string; error?: string };
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r;
}

let seq = 0;
/** A NEAR contract a partner deploys: a fresh account and code hash per document, so no two collide. */
async function nearDoc(o: { network?: string; object?: string; account?: string; verb?: string } = {}): Promise<string> {
  seq += 1;
  const codeHash = base58(await sha256(utf8(`wasm ${seq} ${Math.random()}`)));
  return JSON.stringify({
    schema: 'journear-labels/1',
    context: { near: { network: o.network ?? 'testnet', account: o.account ?? `club${seq}x.testnet`, codeHash } },
    metadata: { enums: { stamp: { arrival: 'Arrival', sponsored: 'Fare paid' } } },
    display: {
      formats: {
        collect: {
          call: { gasAtMost: '30000000000000', args: { stamp: { type: 'string' } }, otherArgs: 'refuse' },
          intent: { verb: o.verb ?? 'collect', object: o.object ?? 'the stamp' },
          sentence: ['verb', 'object', { field: 'args.stamp' }],
          fields: [{ path: 'args.stamp', label: 'Stamp', format: 'enum', params: { enum: 'stamp' } }],
        },
      },
    },
  });
}

const shaHex = async (text: string) => [...(await sha256(utf8(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function nonce(app: OrgApp, i: { labelId?: string; doc?: string; apps?: string[]; version: number; remove?: boolean }): Promise<string> {
  return nonceOf(
    await labelChangeDigest(
      i.remove
        ? { signer: SIGNER, scopeId: app.scope, kind: 'labels_remove', labelId: i.labelId!, appIds: [], labelsVersion: i.version }
        : { signer: SIGNER, scopeId: app.scope, kind: 'labels_set', labelId: i.labelId ?? '', docSha256: await shaHex(i.doc!), appIds: [...(i.apps ?? [app.id])].sort(), labelsVersion: i.version },
    ),
  );
}

async function propose(app: OrgApp, doc: string, o: { labelId?: string; apps?: string[]; version?: number; e?: typeof env; ctx?: ReturnType<typeof member> } = {}) {
  const version = o.version ?? (await scopeVersion(app));
  const jwt = await stepUp(await nonce(app, { doc, version, ...(o.labelId ? { labelId: o.labelId } : {}), ...(o.apps ? { apps: o.apps } : {}) }));
  return consoleRpc(o.e).proposeLabels({ ...(o.ctx ?? member()), orgId: app.org, scopeId: app.scope, ...(o.labelId ? { labelId: o.labelId } : {}), document: doc, appIds: o.apps ?? [app.id], expectedVersion: version, stepUpJwt: jwt });
}

const scopeVersion = async (app: OrgApp): Promise<number> => (await rows<{ v: number }>('SELECT labels_version AS v FROM scopes WHERE scope_id = ?1', app.scope))[0]!.v;
const ack = async (changeId: string) => ok(adminRpc().ackLabelNotice({ ...system(), changeId, cancelTokenHash: await linkToken().hash }));
const appConfig = async (app: OrgApp, e: Partial<typeof env> = { PARTNER_LABELS: 'on' }, origin = VAULT) => (await (await call('/v1/app', { method: 'GET', headers: hanaHeaders(app, origin), env: e })).json()) as Record<string, unknown>;
const served = async (app: OrgApp) => ((await appConfig(app)).partnerLabels as { id: string; changeId: string; text: string; sha256: string; version: string; effectiveSince: number; previousEffectiveSince: number | null }[] | undefined) ?? null;
const detail = async (changeId: string) => (await ok(adminRpc().labelDetail({ ...hana(), changeId }))).item;
const note = 'Misleading wording about the fare';

/** Proposed, announced, and its delay passed: in force (by the predicate; the cron hasn't run). */
async function inForce(app: OrgApp, doc?: string, o: { labelId?: string } = {}) {
  const r = await ok(propose(app, doc ?? (await nearDoc()), o));
  await ack(r.change!.id);
  clock.advance(DELAY);
  return r.change!;
}

describe('proposing (ConsoleRpc.proposeLabels): who, what, and every refusal', () => {
  it('an on-chain owner’s proposal is a new entry and a pending version, with its ledger row, its security event and one version bump', async () => {
    const app = await orgApp();
    const doc = await nearDoc();
    const r = await ok(propose(app, doc));
    expect(r.noChange).toBe(false);
    expect(r.change).toMatchObject({ state: 'proposed', apps: [{ id: app.id, name: `Test ${app.id}` }], schema: 'journear-labels/1', sha256: await shaHex(doc), served: false });
    expect(r.preview.formats).toEqual([{ key: 'collect', line: `Test ${app.id} says: collect the stamp “Arrival”`, sentence: 'collect the stamp “Arrival”', parts: [{ kind: 'verb', text: 'collect' }, { kind: 'object', text: 'the stamp' }, { kind: 'value', text: '“Arrival”' }], fields: [{ label: 'Stamp', value: '“Arrival”' }] }]);
    expect(await scopeVersion(app)).toBe(1);
    const [c] = await rows('SELECT status, proposer_sub, doc_text, doc_bytes, notified_at, apps_json FROM label_changes WHERE id = ?1', r.change!.id);
    expect(c).toEqual({ status: 'pending', proposer_sub: 'owner-sub-1', doc_text: doc, doc_bytes: utf8(doc).length, notified_at: null, apps_json: JSON.stringify([app.id]) });
    const [l] = await rows<{ kind: string; actor_kind: string; actor_sub: string; app_id: null; scope_id: string; detail_json: string }>("SELECT kind, actor_kind, actor_sub, app_id, scope_id, detail_json FROM app_changes WHERE org_id = ?1 AND kind = 'labels.proposed'", app.org);
    expect(l).toMatchObject({ kind: 'labels.proposed', actor_kind: 'member', actor_sub: 'owner-sub-1', app_id: null, scope_id: app.scope });
    expect(JSON.parse(l!.detail_json)).toMatchObject({ changeId: r.change!.id, sha256: await shaHex(doc), apps: [app.id], newEntry: true, previousId: null });
    expect(await rows("SELECT kind, org_id FROM security_events WHERE kind = 'label_proposed' AND org_id = ?1", app.org)).toEqual([{ kind: 'label_proposed', org_id: app.org }]);
    // Nothing is served before its notice.
    expect(await served(app)).toEqual([]);
  });

  it('refuses with the switch off, writing nothing', async () => {
    const app = await orgApp();
    expect(await fail(propose(app, await nearDoc(), { e: env }))).toMatchObject({ code: 'env_mismatch' });
    expect(await fail(consoleRpc(env).previewLabels({ ...member(), orgId: app.org, scopeId: app.scope, document: await nearDoc(), appIds: [app.id] }))).toMatchObject({ code: 'env_mismatch' });
    expect(await rows('SELECT id FROM label_changes WHERE org_id = ?1', app.org)).toEqual([]);
  });

  it('refuses a document the parser refuses, with its stable codes and plain messages (a claim word, a reserved method, a reviewed contract, not JSON)', async () => {
    const app = await orgApp();
    const claim = await nearDoc({ object: 'the verified stamp' });
    const r1 = await fail(propose(app, claim));
    expect(r1.code).toBe('label_invalid');
    expect(r1.error).toMatch(/^text_claim at display\.formats\.collect\.intent\.object: /u);
    const reserved = (await nearDoc()).replace('"collect"', '"ft_transfer"');
    expect((await fail(propose(app, reserved))).error).toMatch(/reserved_method at display\.formats\.ft_transfer/u);
    expect((await fail(propose(app, '{"schema": '))).error).toMatch(/^not_json at /u);
    // A known token's contract is Journear's to read (journearReads).
    const wnear = (await nearDoc({ account: 'wrap.testnet' }));
    expect((await fail(propose(app, wnear))).error).toMatch(/journear_reads_this/u);
    expect(await rows('SELECT id FROM label_changes WHERE org_id = ?1', app.org)).toEqual([]);
  });

  it('refuses a document whose network isn’t the scope’s environment’s', async () => {
    const test = await orgApp();
    expect((await fail(propose(test, await nearDoc({ network: 'mainnet', account: `club${seq + 1}x.near` })))).error).toMatch(/^wrong_environment at context\.near\.network: These apps are test apps/u);
    const live = await orgApp({ live: true });
    expect((await fail(propose(live, await nearDoc()))).error).toMatch(/^wrong_environment at context\.near\.network: These apps are live apps/u);
  });

  it('refuses apps outside the scope or the org, a repeated app, a second waiting version, a second entry for one contract', async () => {
    const app = await orgApp();
    const sameScope = await sameScopeApp(app);
    const otherScope = await orgApp({ org: app.org });
    const otherOrg = await orgApp();
    const doc = await nearDoc();
    for (const apps of [[app.id, otherScope.id], [app.id, otherOrg.id]]) expect((await fail(propose(app, doc, { apps }))).code).toBe('bad_request');
    const jwt = await stepUp(await nonce(app, { doc, version: 0, apps: [app.id, sameScope.id] }));
    expect((await fail(consoleRpc().proposeLabels({ ...member(), orgId: app.org, scopeId: app.scope, document: doc, appIds: [app.id, app.id], expectedVersion: 0, stepUpJwt: jwt }))).error).toMatch(/listed twice/u);
    const first = await ok(propose(app, doc, { apps: [app.id, sameScope.id] }));
    expect(first.change!.apps.map((a) => a.id).sort()).toEqual([app.id, sameScope.id].sort());
    expect((await fail(propose(app, await nearDoc(), { labelId: first.change!.labelId }))).error).toMatch(/already waiting/u);
    // Another entry describing the same contract: refused.
    const again = JSON.parse(doc) as { context: { near: { codeHash: string } } };
    again.context.near.codeHash = base58(await sha256(utf8('another build')));
    expect((await fail(propose(app, JSON.stringify(again)))).error).toMatch(/already describe this contract/u);
  });

  it('who may: an on-chain owner of the scope only; the token bound to this exact document, apps and version', async () => {
    const app = await orgApp();
    const doc = await nearDoc();
    const other = await nearDoc();
    const send = (jwt: string, o: { ctx?: ReturnType<typeof member>; expectedVersion?: number } = {}) =>
      consoleRpc().proposeLabels({ ...(o.ctx ?? member()), orgId: app.org, scopeId: app.scope, document: doc, appIds: [app.id], expectedVersion: o.expectedVersion ?? 0, stepUpJwt: jwt });
    expect((await fail(send(await stepUp(await nonce(app, { doc: other, version: 0 }))))).code).toBe('forbidden');
    expect((await fail(send(await stepUp(await nonce(app, { doc, version: 0 }), { sub: 'stranger' }), { ctx: member('stranger') }))).code).toBe('not_owner');
    expect((await fail(send(await stepUp(await nonce(app, { doc, version: 0 })), { expectedVersion: 3 }))).code).toBe('version_conflict');
    // A staff actor (no step-up) can't propose through ConsoleRpc.
    expect((await fail(consoleRpc().proposeLabels({ ...hana(), orgId: app.org, scopeId: app.scope, document: doc, appIds: [app.id], expectedVersion: 0, stepUpJwt: await stepUp('x') } as never))).code).toBe('forbidden');
    const jwt = await stepUp(await nonce(app, { doc, version: 0 }));
    await ok(send(jwt));
    // The token can't be used again: the scope's version moved, and its nonce named the old one.
    expect((await fail(send(jwt, { expectedVersion: 1 }))).code).not.toBe('ok');
  });

  it('holds an org to its limits: entries, bytes, proposals a day', async () => {
    const app = await orgApp();
    for (let k = 0; k < 10; k++) await ok(propose(app, await nearDoc()));
    expect((await fail(propose(app, await nearDoc()))).error).toMatch(/at most 10 label changes in 24 hours/u);
    clock.advance(DAY + 1);
    for (let k = 0; k < 6; k++) await ok(propose(app, await nearDoc()));
    expect((await fail(propose(app, await nearDoc()))).error).toMatch(/at most 16 sets of request labels/u);
  });

  it('limitProblem: the bytes an org and an app may hold, each limit at its edge', () => {
    const plan = (o: Partial<LabelPlan>): LabelPlan => ({ org_entries: 0, org_bytes: 0, app_bytes: '{}', day_proposals: 0, ...o }) as LabelPlan;
    const i = { newEntry: true, bytes: 1000, appIds: ['app_a'] };
    expect(limitProblem(plan({}), i)).toBeNull();
    expect(limitProblem(plan({ org_entries: 15 }), i)).toBeNull();
    expect(limitProblem(plan({ org_entries: 16 }), i)).toMatch(/at most 16 sets/u);
    expect(limitProblem(plan({ org_entries: 16 }), { ...i, newEntry: false })).toBeNull();
    expect(limitProblem(plan({ org_bytes: 64 * 1024 - 1000 }), i)).toBeNull();
    expect(limitProblem(plan({ org_bytes: 64 * 1024 - 999 }), i)).toMatch(/at most 64 KiB together/u);
    expect(limitProblem(plan({ app_bytes: JSON.stringify({ app_a: 32 * 1024 - 1000 }) }), i)).toBeNull();
    expect(limitProblem(plan({ app_bytes: JSON.stringify({ app_a: 32 * 1024 - 999 }) }), i)).toMatch(/attached to app_a would be over 32 KiB/u);
    expect(limitProblem(plan({ day_proposals: 9 }), i)).toBeNull();
    expect(limitProblem(plan({ day_proposals: 10 }), i)).toMatch(/at most 10 label changes in 24 hours/u);
  });

  it('the same document on the same apps as the one in force is a no-op (the token not used)', async () => {
    const app = await orgApp();
    const doc = await nearDoc();
    const c = await inForce(app, doc);
    const before = await scopeVersion(app);
    const r = await ok(propose(app, doc, { labelId: c.labelId }));
    expect(r).toMatchObject({ noChange: true, change: null, version: before });
    expect(await scopeVersion(app)).toBe(before);
  });

  it('previewLabels answers every check without the step-up and writes nothing', async () => {
    const app = await orgApp();
    const r = await ok(consoleRpc().previewLabels({ ...member(), orgId: app.org, scopeId: app.scope, document: await nearDoc(), appIds: [app.id] }));
    expect(r).toMatchObject({ labelsVersion: 0, noChange: false, preview: { appName: `Test ${app.id}`, examples: true } });
    expect(r.preview.context).toMatch(/^NEAR test network, club\d+x\.testnet$/u);
    expect((await fail(consoleRpc().previewLabels({ ...member(), orgId: app.org, scopeId: app.scope, document: await nearDoc({ object: 'a free stamp' }), appIds: [app.id] }))).code).toBe('label_invalid');
    expect(await rows('SELECT id FROM label_changes WHERE org_id = ?1', app.org)).toEqual([]);
  });
});

describe('notice, delay, cancel, lapse (the guarded change’s rules)', () => {
  it('in force only once announced and appChangeDelayMs later, to the millisecond; the hourly job then records it once', async () => {
    const app = await orgApp();
    const doc = await nearDoc();
    const p = await ok(propose(app, doc));
    const notices = (await ok(adminRpc().labelNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.change.orgId === app.org);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ contacts: ['security@partner.example'], preview: { formats: [expect.objectContaining({ key: 'collect' })] }, diff: [expect.objectContaining({ change: 'added', key: '(contract)', before: null }), expect.objectContaining({ change: 'added', key: 'collect', before: null })] });
    clock.advance(6 * DAY);
    expect(await served(app)).toEqual([]);
    const { change } = await ack(p.change!.id);
    expect(change.activeFrom).toBe(clock.now() + DELAY);
    expect((await detail(p.change!.id)).change.state).toBe('announced');
    clock.advance(DELAY - 1);
    expect(await served(app)).toEqual([]);
    clock.advance(1);
    const s = await served(app);
    expect(s).toEqual([{ id: p.change!.labelId, changeId: p.change!.id, version: 'journear-labels/1', sha256: await shaHex(doc), text: doc, effectiveSince: change.activeFrom, previousEffectiveSince: null }]);
    expect((await detail(p.change!.id)).change).toMatchObject({ state: 'in_force', served: true });
    expect(await labelsMaintenance(env, clock.now())).toMatchObject({ activated: expect.any(Number) });
    expect(await rows("SELECT status FROM label_changes WHERE id = ?1", p.change!.id)).toEqual([{ status: 'active' }]);
    const again = await labelsMaintenance(env, clock.now());
    expect((await rows("SELECT COUNT(*) AS n FROM app_changes WHERE kind = 'labels.activated' AND org_id = ?1", app.org))[0]).toEqual({ n: 1 });
    expect(again.activated).toBe(0);
    expect(await rows("SELECT kind FROM security_events WHERE kind = 'label_live' AND org_id = ?1", app.org)).toEqual([{ kind: 'label_live' }]);
    // An ack twice is refused.
    expect((await fail(adminRpc().ackLabelNotice({ ...system(), changeId: p.change!.id, cancelTokenHash: await linkToken().hash }))).code).toBe('not_pending');
  });

  it('a new version replaces the old at its own time, with the old one’s date as previousEffectiveSince', async () => {
    const app = await orgApp();
    const v1 = await inForce(app);
    const t1 = (await served(app))![0]!.effectiveSince;
    const doc2 = await nearDoc();
    const v2 = await ok(propose(app, doc2, { labelId: v1.labelId }));
    expect((await detail(v2.change!.id)).diff.map((d) => [d.key, d.change])).toEqual([['(contract)', 'changed'], ['collect', 'same']]);
    await ack(v2.change!.id);
    clock.advance(DELAY - 1);
    expect((await served(app))![0]!.changeId).toBe(v1.id);
    clock.advance(1);
    expect(await served(app)).toEqual([expect.objectContaining({ changeId: v2.change!.id, text: doc2, previousEffectiveSince: t1 })]);
    await labelsMaintenance(env, clock.now());
    expect(await rows('SELECT id, status, end_reason FROM label_changes WHERE label_id = ?1 ORDER BY proposed_at', v1.labelId)).toEqual([
      { id: v1.id, status: 'ended', end_reason: 'replaced' },
      { id: v2.change!.id, status: 'active', end_reason: null },
    ]);
  });

  it('an owner cancels a waiting version (not one in force); the emailed link cancels with its token only', async () => {
    const app = await orgApp();
    const p = await ok(propose(app, await nearDoc()));
    await ok(consoleRpc().cancelChange({ ...member(), orgId: app.org, changeId: p.change!.id }));
    expect((await detail(p.change!.id)).change.state).toBe('cancelled');
    const live = await inForce(app);
    expect((await fail(consoleRpc().cancelChange({ ...member(), orgId: app.org, changeId: live.id }))).code).toBe('not_pending');
    // Another org can't cancel it.
    expect((await fail(consoleRpc().cancelChange({ ...member(), orgId: newOrg(), changeId: live.id }))).code).toBe('not_found');
    const q = await ok(propose(app, await nearDoc()));
    const t = linkToken();
    await ok(adminRpc().ackLabelNotice({ ...system(), changeId: q.change!.id, cancelTokenHash: await t.hash }));
    expect((await fail(consoleRpc().cancelChangeByLink({ ...link(q.change!.id), changeId: q.change!.id, token: linkToken().token }))).code).toBe('forbidden');
    await ok(consoleRpc().cancelChangeByLink({ ...link(q.change!.id), changeId: q.change!.id, token: t.token }));
    expect(await rows('SELECT status, end_reason, cancelled_by FROM label_changes WHERE id = ?1', q.change!.id)).toEqual([{ status: 'cancelled', end_reason: 'link', cancelled_by: 'link' }]);
    expect((await rows<{ actor_kind: string }>("SELECT actor_kind FROM app_changes WHERE kind = 'change.cancelled' AND json_extract(detail_json, '$.changeId') = ?1", q.change!.id))[0]).toEqual({ actor_kind: 'link' });
  });

  it('lapses when not announced within 7 days of its proposal (not a millisecond before)', async () => {
    const app = await orgApp();
    const p = await ok(propose(app, await nearDoc()));
    const at = clock.now();
    await labelsMaintenance(env, at + LABEL_LAPSE_MS - 1);
    expect((await rows('SELECT status FROM label_changes WHERE id = ?1', p.change!.id))[0]).toEqual({ status: 'pending' });
    await labelsMaintenance(env, at + LABEL_LAPSE_MS);
    expect((await rows('SELECT status, end_reason FROM label_changes WHERE id = ?1', p.change!.id))[0]).toEqual({ status: 'lapsed', end_reason: 'not_announced' });
    expect((await fail(adminRpc().ackLabelNotice({ ...system(), changeId: p.change!.id, cancelTokenHash: await linkToken().hash }))).code).toBe('not_pending');
  });

  it('removal is immediate, needs the same proof, and ends the version in force and the waiting one', async () => {
    const app = await orgApp();
    const v1 = await inForce(app);
    const v2 = await ok(propose(app, await nearDoc(), { labelId: v1.labelId }));
    const version = await scopeVersion(app);
    const send = async (jwt: string) => consoleRpc().removeLabels({ ...member(), orgId: app.org, scopeId: app.scope, labelId: v1.labelId, expectedVersion: version, stepUpJwt: jwt });
    expect((await fail(send(await stepUp(await nonce(app, { labelId: v1.labelId, version: version + 1, remove: true }))))).code).toBe('forbidden');
    await ok(send(await stepUp(await nonce(app, { labelId: v1.labelId, version, remove: true }))));
    expect(await served(app)).toEqual([]);
    expect(await rows('SELECT status, end_reason FROM label_changes WHERE label_id = ?1 ORDER BY proposed_at', v1.labelId)).toEqual([
      { status: 'ended', end_reason: 'removed' },
      { status: 'cancelled', end_reason: 'removed' },
    ]);
    expect((await detail(v2.change!.id)).change.state).toBe('removed');
    expect((await fail(propose(app, await nearDoc(), { labelId: v1.labelId }))).code).toBe('not_found');
  });
});

describe('the staff veto: Block, and required review with Allow', () => {
  const act = (changeId: string, tool: 'block' | 'allow', seen: { labelsVersion: number; state: string }) => adminRpc().labelStaffAct({ ...hana(), changeId, tool, note, seen });
  const seenOf = async (id: string) => {
    const d = await detail(id);
    return { labelsVersion: d.labelsVersion, state: d.change.state };
  };

  it('blocks a waiting change: it never takes effect; recorded with the note, a security event, a version bump', async () => {
    const app = await orgApp();
    const p = await ok(propose(app, await nearDoc()));
    await ack(p.change!.id);
    const seen = await seenOf(p.change!.id);
    expect((await fail(act(p.change!.id, 'block', { ...seen, labelsVersion: seen.labelsVersion + 1 }))).code).toBe('version_conflict');
    expect((await fail(act(p.change!.id, 'block', { ...seen, state: 'proposed' }))).code).toBe('version_conflict');
    const r = await ok(act(p.change!.id, 'block', seen));
    expect(r.change).toMatchObject({ state: 'blocked', blockNote: note });
    clock.advance(DELAY);
    await labelsMaintenance(env, clock.now());
    expect(await served(app)).toEqual([]);
    expect((await detail(p.change!.id)).change.state).toBe('blocked');
    const [l] = await rows<{ actor_kind: string; actor_id: string; detail_json: string }>("SELECT actor_kind, actor_id, detail_json FROM app_changes WHERE kind = 'labels.blocked' AND org_id = ?1", app.org);
    expect(l!.actor_kind).toBe('hana');
    expect(JSON.parse(l!.detail_json)).toEqual({ changeId: p.change!.id, labelId: p.change!.labelId, wasLive: false, note });
    expect(await rows("SELECT kind FROM security_events WHERE kind = 'label_blocked' AND org_id = ?1", app.org)).toEqual([{ kind: 'label_blocked' }]);
    // Blocked is final: nothing more to block or allow.
    expect((await fail(act(p.change!.id, 'block', await seenOf(p.change!.id)))).code).toBe('not_pending');
  });

  it('blocks a change in force: served no more, at once, and no earlier version comes back', async () => {
    const app = await orgApp();
    const v1 = await inForce(app);
    const v2 = await ok(propose(app, await nearDoc(), { labelId: v1.labelId }));
    await ack(v2.change!.id);
    clock.advance(DELAY);
    expect((await served(app))![0]!.changeId).toBe(v2.change!.id);
    await ok(act(v2.change!.id, 'block', await seenOf(v2.change!.id)));
    expect(await served(app)).toEqual([]);
    expect(await rows('SELECT status, was_live FROM label_changes WHERE id = ?1', v2.change!.id)).toEqual([{ status: 'blocked', was_live: 1 }]);
    expect(await rows('SELECT status, end_reason FROM label_changes WHERE id = ?1', v1.id)).toEqual([{ status: 'ended', end_reason: 'replaced' }]);
  });

  it('required review (off by default): a due change waits for Allow however long; lapses 7 days after its time; on for everyone too', async () => {
    const app = await orgApp();
    // Off by default: Allow has nothing to do.
    const plain = await ok(propose(app, await nearDoc()));
    expect((await fail(act(plain.change!.id, 'allow', await seenOf(plain.change!.id)))).error).toMatch(/Review isn’t switched on/u);
    await ok(adminRpc().labelControl({ ...hana(), target: { kind: 'org', orgId: app.org }, what: 'review_on', note, seenVersion: 0 }));
    await ack(plain.change!.id);
    clock.advance(DELAY);
    expect(await served(app)).toEqual([]);
    expect((await detail(plain.change!.id)).change).toMatchObject({ state: 'waiting_review', reviewRequired: true, lapsesAt: clock.now() + LABEL_LAPSE_MS });
    await labelsMaintenance(env, clock.now());
    expect((await rows('SELECT status FROM label_changes WHERE id = ?1', plain.change!.id))[0]).toEqual({ status: 'pending' });
    await ok(act(plain.change!.id, 'allow', await seenOf(plain.change!.id)));
    expect((await served(app))!.map((s) => s.changeId)).toEqual([plain.change!.id]);
    // Another change is held and nobody allows it: it lapses 7 days after its time, not before.
    const held = await ok(propose(app, await nearDoc()));
    const { change } = await ack(held.change!.id);
    await labelsMaintenance(env, change.activeFrom + LABEL_LAPSE_MS - 1);
    expect((await rows('SELECT status FROM label_changes WHERE id = ?1', held.change!.id))[0]).toEqual({ status: 'pending' });
    await labelsMaintenance(env, change.activeFrom + LABEL_LAPSE_MS);
    expect((await rows('SELECT status, end_reason FROM label_changes WHERE id = ?1', held.change!.id))[0]).toEqual({ status: 'lapsed', end_reason: 'not_reviewed' });
    // Review off again: a held change takes effect at once (its time had come).
    const third = await ok(propose(app, await nearDoc()));
    await ack(third.change!.id);
    clock.advance(DELAY);
    expect((await served(app))!.map((s) => s.changeId)).not.toContain(third.change!.id);
    await ok(adminRpc().labelControl({ ...hana(), target: { kind: 'org', orgId: app.org }, what: 'review_off', note, seenVersion: 1 }));
    expect((await served(app))!.map((s) => s.changeId)).toContain(third.change!.id);
    // For everyone.
    const other = await orgApp();
    const ctl = (await ok(adminRpc().labelQueue({ ...hana() }))).controls.all;
    await ok(adminRpc().labelControl({ ...hana(), target: { kind: 'all' }, what: 'review_on', note, seenVersion: ctl.version }));
    const o = await ok(propose(other, await nearDoc()));
    await ack(o.change!.id);
    clock.advance(DELAY);
    expect(await served(other)).toEqual([]);
    await ok(adminRpc().labelControl({ ...hana(), target: { kind: 'all' }, what: 'review_off', note, seenVersion: ctl.version + 1 }));
    expect((await served(other))!.map((s) => s.changeId)).toEqual([o.change!.id]);
  });

  it('only staff: ConsoleRpc has no staff tool, and the notice ack is the cron’s alone', async () => {
    expect((ConsoleRpc.prototype as unknown as Record<string, unknown>).labelStaffAct).toBeUndefined();
    expect((ConsoleRpc.prototype as unknown as Record<string, unknown>).labelControl).toBeUndefined();
    const app = await orgApp();
    const p = await ok(propose(app, await nearDoc()));
    expect((await fail(adminRpc().ackLabelNotice({ ...hana(), changeId: p.change!.id, cancelTokenHash: await linkToken().hash }))).code).toBe('forbidden');
  });
});

describe('the switches (staff): an entry, an org, everyone; only ever off, and back on only to what passed the guarded path', () => {
  const ctl = (target: LabelControlTarget, what: 'off' | 'on', seenVersion: number) =>
    adminRpc().labelControl({ ...hana(), target, what, note, seenVersion });

  it('one entry: off at once, back on at once; a stale page is refused; recorded in the org’s changes and the switch log', async () => {
    const app = await orgApp();
    const c = await inForce(app);
    await ok(ctl({ kind: 'entry', labelId: c.labelId }, 'off', 0));
    expect(await served(app)).toEqual([]);
    expect((await detail(c.id)).change).toMatchObject({ state: 'in_force', off: 'entry', served: false });
    expect((await fail(ctl({ kind: 'entry', labelId: c.labelId }, 'on', 0))).code).toBe('version_conflict');
    expect(await ok(ctl({ kind: 'entry', labelId: c.labelId }, 'off', 1))).toMatchObject({ changed: false });
    await ok(ctl({ kind: 'entry', labelId: c.labelId }, 'on', 1));
    expect((await served(app))!.map((s) => s.changeId)).toEqual([c.id]);
    expect((await rows<{ kind: string }>("SELECT kind FROM app_changes WHERE org_id = ?1 AND kind LIKE 'labels.switched%' ORDER BY seq", app.org)).map((r) => r.kind)).toEqual(['labels.switched_off', 'labels.switched_on']);
    expect((await rows('SELECT labels_off FROM label_control_log WHERE target = ?1 ORDER BY seq', c.labelId)).map((r) => r.labels_off)).toEqual([1, 0]);
    // A proposal on a switched-off entry is refused (ask Journear first).
    await ok(ctl({ kind: 'entry', labelId: c.labelId }, 'off', 2));
    expect((await fail(propose(app, await nearDoc(), { labelId: c.labelId }))).code).toBe('forbidden');
  });

  it('one org and everyone: off and back on; another org is untouched by an org’s switch', async () => {
    const a = await orgApp();
    const b = await orgApp();
    await inForce(a);
    await inForce(b);
    await ok(ctl({ kind: 'org', orgId: a.org }, 'off', 0));
    expect(await served(a)).toEqual([]);
    expect(await served(b)).toHaveLength(1);
    const all = (await ok(adminRpc().labelQueue({ ...hana() }))).controls;
    expect(all.orgs).toContainEqual(expect.objectContaining({ orgId: a.org, labelsOff: true }));
    await ok(ctl({ kind: 'all' }, 'off', all.all.version));
    expect(await served(b)).toEqual([]);
    await ok(ctl({ kind: 'all' }, 'on', all.all.version + 1));
    await ok(ctl({ kind: 'org', orgId: a.org }, 'on', 1));
    expect(await served(a)).toHaveLength(1);
    expect(await served(b)).toHaveLength(1);
    // A switch back on never makes a waiting change take effect.
    const w = await ok(propose(a, await nearDoc()));
    await ok(ctl({ kind: 'org', orgId: a.org }, 'off', 2));
    await ok(ctl({ kind: 'org', orgId: a.org }, 'on', 3));
    expect((await served(a))!.map((s) => s.changeId)).not.toContain(w.change!.id);
  });
});

describe('drift: a bare D1 write that skips the guarded path is reported, as for origins and policies', () => {
  const drift = async (org: string) => (await rows<{ detail_json: string }>("SELECT detail_json FROM security_events WHERE kind = 'drift' AND org_id = ?1", org)).map((r) => JSON.parse(r.detail_json) as { finding: string });

  it('a version announced and timed by hand (no notice), or put in force early, or unblocked, or a switch turned back on by hand', async () => {
    const app = await orgApp();
    const p = await ok(propose(app, await nearDoc()));
    await env.DB.prepare('UPDATE label_changes SET notified_at = ?2, active_from = ?2 WHERE id = ?1').bind(p.change!.id, clock.now()).run();
    expect((await served(app))!.map((s) => s.changeId)).toEqual([p.change!.id]);
    await detectLabelDrift(env, clock.now());
    expect(await drift(app.org)).toEqual([expect.objectContaining({ what: 'partner_label', finding: 'unannounced', changeId: p.change!.id })]);

    const early = await orgApp();
    const q = await ok(propose(early, await nearDoc()));
    await ack(q.change!.id);
    await env.DB.prepare('UPDATE label_changes SET active_from = ?2 WHERE id = ?1').bind(q.change!.id, clock.now() - 1).run();
    await detectLabelDrift(env, clock.now());
    expect((await drift(early.org)).map((d) => d.finding)).toEqual(['unannounced']);

    const blocked = await orgApp();
    const b = await inForce(blocked);
    const d = await detail(b.id);
    await ok(adminRpc().labelStaffAct({ ...hana(), changeId: b.id, tool: 'block', note, seen: { labelsVersion: d.labelsVersion, state: d.change.state } }));
    await env.DB.prepare("UPDATE label_changes SET status = 'active', blocked_at = NULL WHERE id = ?1").bind(b.id).run();
    await detectLabelDrift(env, clock.now());
    expect((await drift(blocked.org)).map((x) => x.finding)).toEqual(['unblocked']);

    const off = await orgApp();
    const o = await inForce(off);
    await ok(adminRpc().labelControl({ ...hana(), target: { kind: 'entry', labelId: o.labelId }, what: 'off', note, seenVersion: 0 }));
    await env.DB.prepare('UPDATE partner_labels SET off_at = NULL WHERE id = ?1').bind(o.labelId).run();
    await ok(adminRpc().labelControl({ ...hana(), target: { kind: 'org', orgId: off.org }, what: 'off', note, seenVersion: 0 }));
    await env.DB.prepare('UPDATE label_controls SET labels_off = 0 WHERE target = ?1').bind(off.org).run();
    await detectLabelDrift(env, clock.now());
    expect((await drift(off.org)).map((x) => x.finding).sort()).toEqual(['control', 'control']);
    // Once per finding.
    const before = (await drift(off.org)).length;
    await detectLabelDrift(env, clock.now());
    expect((await drift(off.org)).length).toBe(before);
  });

  it('a version that went through the path is no finding; a version’s text can’t be edited in place (the trigger) and an edit past it is a finding', async () => {
    const app = await orgApp();
    const c = await inForce(app);
    await labelsMaintenance(env, clock.now());
    await detectLabelDrift(env, clock.now());
    expect(await drift(app.org)).toEqual([]);
    await expect(env.DB.prepare("UPDATE label_changes SET doc_text = '{}' WHERE id = ?1").bind(c.id).run()).rejects.toThrow(/never edited/u);
    // Past the trigger (dropped, as a D1 compromise could): the edited text no longer hashes to its sha256.
    const trigger = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'label_changes_fixed'").first<{ sql: string }>())!.sql;
    await env.DB.prepare('DROP TRIGGER label_changes_fixed').run();
    try {
      await env.DB.prepare("UPDATE label_changes SET doc_text = replace(doc_text, 'the stamp', 'the token') WHERE id = ?1").bind(c.id).run();
      await detectLabelDrift(env, clock.now());
      expect((await drift(app.org)).map((d) => d.finding)).toEqual(['text_changed']);
    } finally {
      await env.DB.prepare(trigger).run();
    }
  });
});

describe('GET /v1/app delivers only what is in force, served, and the app’s own', () => {
  it('nothing with the switch off (no field), nothing on a non-vault read, nothing for another org’s or an unattached app; no-store', async () => {
    const app = await orgApp();
    const unattached = await sameScopeApp(app);
    const stranger = await orgApp();
    await inForce(app);
    expect(await served(app)).toHaveLength(1);
    expect('partnerLabels' in (await appConfig(app, {}))).toBe(false);
    expect('partnerLabels' in (await appConfig(app, { PARTNER_LABELS: 'on' }, env.AUTH_ORIGIN!))).toBe(false);
    expect(await served(unattached)).toEqual([]);
    expect(await served(stranger)).toEqual([]);
    const res = await call('/v1/app', { method: 'GET', headers: hanaHeaders(app, VAULT), env: { PARTNER_LABELS: 'on' } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // A scope moved to another org: its labels are not the new org's.
    await env.DB.prepare('UPDATE scopes SET org_id = ?2 WHERE scope_id = ?1').bind(app.scope, newOrg()).run();
    expect(await served(app)).toEqual([]);
  });
});

