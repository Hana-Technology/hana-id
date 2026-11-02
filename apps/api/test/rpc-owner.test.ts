// Batch C6 (docs/batch-c-spec.md tests "Guarded changes": the verification refusals of changeOrigins and proposeChange;
// "Apps, scopes, owner actions": ConsoleRpc.ownerAction, its precheck and the per-IP limiter fed by clientIp): through
// the ConsoleRpc and AdminRpc entrypoints, with real RS256 tokens from a test key the mocked Google JWKS serves and a
// mocked NEAR whose scope lists the member as an `Owner::Oidc`.
import { nonceOf, originChangeDigest, ownerActionNonce, settingsChangeDigest } from '@hana-id/console-core';
import { clearJwksCache } from '@hana-id/oidc';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import { detectDrift } from '../src/changes/drift.ts';
import { validatePolicy } from '../src/changes/policy.ts';
import { forgetCapEvents, OWNER_ACTIONS_PER_IP_MINUTE } from '../src/handlers.ts';
import { clearViewCaches } from '../src/views.ts';
import { GOOGLE_ISS, ORIGIN, call, google, uid } from './helpers.ts';
import {
  CONSOLE_AUD as CONSOLE,
  DELAY,
  type DbCount,
  type OrgApp,
  STEP_UP_SUB,
  adminRpc,
  appRow,
  consoleRpc,
  counted,
  hana,
  ledgerCount,
  linkToken,
  member,
  orgApp,
  ownClock,
  ownerChain as near,
  rows,
  stepUp,
  system,
} from './rpc-helpers.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import { autoApprovePolicy } from './vault-helpers.ts';

const SUB = STEP_UP_SUB;
const NEW = 'https://new.example.com';
const SIGNER = env.SIGNER_ACCOUNT;

let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
  clearJwksCache();
  clearViewCaches();
  forgetCapEvents();
});
afterEach(() => vi.restoreAllMocks());

const originNonce = async (app: OrgApp, add: string[], remove: string[], version: number) =>
  nonceOf(await originChangeDigest({ signer: SIGNER, appId: app.id, add, remove, originsVersion: version }));
const settingsNonce = async (app: OrgApp, kind: 'policy_set' | 'raw_sign_on', version: number, policyId?: string) =>
  nonceOf(await settingsChangeDigest({ signer: SIGNER, appId: app.id, kind, ...(policyId ? { policyId } : {}), settingsVersion: version }));

async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

const ack = async (changeId: string) => adminRpc().ackNotice({ ...system(), changeId, cancelTokenHash: await linkToken().hash });

describe('ConsoleRpc.changeOrigins: the API verifies the member’s step-up itself', () => {
  it('a verified owner’s add is a pending member proposal with its sub; removes sent with it apply at once; one version bump', async () => {
    near();
    const app = await orgApp({ origins: [ORIGIN, 'https://old.example.com'] });
    const jwt = await stepUp(await originNonce(app, [NEW], ['https://old.example.com'], 0));
    const r = await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW], remove: ['https://old.example.com'], expectedVersion: 0, stepUpJwt: jwt }));
    expect(r.version).toBe(1);
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'origin_add', origin: NEW, status: 'pending', proposedByKind: 'member', activeFrom: null })]);
    expect((await appRow(app.id)).origins_version).toBe(1);
    const [gc] = await rows('SELECT proposed_by_kind, proposer_sub, waiver FROM guarded_changes WHERE app_id = ?1', app.id);
    expect(gc).toEqual({ proposed_by_kind: 'member', proposer_sub: SUB, waiver: null });
    const [ledger] = await rows<{ kind: string; actor_kind: string; actor_sub: string; detail_json: string }>('SELECT kind, actor_kind, actor_sub, detail_json FROM app_changes WHERE app_id = ?1', app.id);
    expect(ledger).toMatchObject({ kind: 'origin.proposed', actor_kind: 'member', actor_sub: SUB });
    expect(JSON.parse(ledger!.detail_json)).toMatchObject({ removed: [{ origin: 'https://old.example.com', wasInForce: true }] });
    // The removal is immediate; the add waits for the notice and the delay.
    expect((await rows('SELECT origin FROM app_origins WHERE app_id = ?1 AND active_from IS NOT NULL', app.id)).map((o) => o.origin)).toEqual([ORIGIN]);
    expect((await getAppByKey(env.DB, app.key))?.origins).not.toContain(NEW);
  });

  it('refuses, in order and writing nothing: bad signature, another audience, iat over 300 s, wrong nonce, a non-owner, a reused token, a version mismatch, NEAR down', async () => {
    const n = near();
    const app = await orgApp();
    const call_ = (jwt: string, o: { add?: string[]; expectedVersion?: number; ctx?: ReturnType<typeof member> } = {}) =>
      consoleRpc(clock).changeOrigins({ ...(o.ctx ?? member()), orgId: app.org, appId: app.id, add: o.add ?? [NEW], remove: [], expectedVersion: o.expectedVersion ?? 0, stepUpJwt: jwt });
    const nonce = await originNonce(app, [NEW], [], 0);
    const before = await ledgerCount();
    const forged = await (await import('./near-mock.ts')).rsaSigner(google.jwk.kid);
    const cases: [string, Promise<unknown>, string][] = [
      ['bad signature', call_(await forged.sign({ iss: GOOGLE_ISS, aud: CONSOLE, sub: SUB, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })), 'forbidden'],
      ['not a console audience', call_(await stepUp(nonce, { aud: 'app.apps.googleusercontent.com' })), 'forbidden'],
      ['iat over 300 s', call_(await stepUp(nonce, { iat: Math.floor(Date.now() / 1000) - 301 })), 'forbidden'],
      ['no iat', call_(await stepUp(nonce, { iat: undefined })), 'forbidden'],
      ['iat in the future', call_(await stepUp(nonce, { iat: Math.floor(Date.now() / 1000) + 120 })), 'forbidden'],
      ['wrong nonce (another origin)', call_(await stepUp(await originNonce(app, ['https://other.example.com'], [], 0))), 'forbidden'],
      ['wrong nonce (another version)', call_(await stepUp(await originNonce(app, [NEW], [], 1))), 'forbidden'],
      ['a non-owner', call_(await stepUp(nonce, { sub: 'stranger' }), { ctx: member('stranger') }), 'not_owner'],
      ['not the member’s own token', call_(await stepUp(nonce, { sub: 'owner-sub-2' })), 'forbidden'],
      ['an email-carrying token', call_(await stepUp(nonce, { email: 'o@partner.example', email_verified: true })), 'forbidden'],
      ['an optional claim of the wrong type (strict)', call_(await stepUp(nonce, { amr: 'pwd' })), 'forbidden'],
      ['a version mismatch', call_(await stepUp(nonce), { expectedVersion: 3 }), 'version_conflict'],
    ];
    for (const [what, p, code] of cases) expect(await p, what).toMatchObject({ ok: false, code });
    expect(await ledgerCount()).toBe(before);
    // A valid token works once; its copy is token_used.
    const jwt = await stepUp(nonce);
    await ok(call_(jwt));
    const copy = await call_(jwt);
    expect(copy).toMatchObject({ ok: false });
    // (The version moved, so a replay of the same change is also stale: send the copy for the new version's nonce.)
    const jwt2 = await stepUp(await originNonce(app, ['https://two.example.com'], [], 1));
    await ok(call_(jwt2, { add: ['https://two.example.com'], expectedVersion: 1 }));
    expect(await call_(jwt2, { add: ['https://two.example.com'], expectedVersion: 1 })).toMatchObject({ ok: false, code: 'version_conflict' });
    const jwt3 = await stepUp(await originNonce(app, ['https://three.example.com'], [], 2));
    // NEAR down at the owner check: near_unavailable, and the token is not used up.
    const scope = n.views.get_scope!;
    delete n.views.get_scope;
    expect(await call_(jwt3, { add: ['https://three.example.com'], expectedVersion: 2 })).toMatchObject({ ok: false, code: 'near_unavailable' });
    n.views.get_scope = scope;
    await ok(call_(jwt3, { add: ['https://three.example.com'], expectedVersion: 2 }));
  });

  it('a reused token is token_used, even for the same change on a version that came back to it', async () => {
    near();
    const app = await orgApp();
    const jwt = await stepUp(await originNonce(app, [NEW], [], 0));
    await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: jwt }));
    // Put the version back (as a forged state would) and send the same token again: refused by the reservation.
    await env.DB.prepare('UPDATE apps SET origins_version = 0 WHERE id = ?1').bind(app.id).run();
    await env.DB.prepare('DELETE FROM app_origins WHERE app_id = ?1 AND origin = ?2').bind(app.id, NEW).run();
    await env.DB.prepare("UPDATE guarded_changes SET status = 'cancelled' WHERE app_id = ?1").bind(app.id).run();
    expect(await consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: jwt })).toMatchObject({ ok: false, code: 'token_used' });
  });

  it('a replayed request id is already_applied (before the token check), and a refused origin is origin_refused', async () => {
    near();
    const app = await orgApp();
    const ctx = member();
    const jwt = await stepUp(await originNonce(app, [NEW], [], 0));
    await ok(consoleRpc(clock).changeOrigins({ ...ctx, orgId: app.org, appId: app.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: jwt }));
    expect(await consoleRpc(clock).changeOrigins({ ...ctx, orgId: app.org, appId: app.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: jwt })).toMatchObject({ ok: false, code: 'already_applied' });
    const refused = env.API_URL ?? 'https://hana-id-api.example';
    const bad = await consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [refused], remove: [], expectedVersion: 1, stepUpJwt: await stepUp(await originNonce(app, [refused], [], 1)) });
    expect(bad).toMatchObject({ ok: false });
    expect(['origin_refused', 'bad_request']).toContain((bad as { code: string }).code);
  });

  it('org A’s member can’t propose on org B’s app; a Hana actor can’t call it', async () => {
    near();
    const a = await orgApp();
    const b = await orgApp();
    const jwt = await stepUp(await originNonce(b, [NEW], [], 0));
    expect(await consoleRpc(clock).changeOrigins({ ...member(), orgId: a.org, appId: b.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: jwt })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await consoleRpc(clock).changeOrigins({ ...hana(), orgId: b.org, appId: b.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: jwt })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('the no_session waiver: a verified member proposal on a scope no user has used gets it at the ack; one with any sign of a user waits', async () => {
    near();
    const fresh = await orgApp({ firstSession: null, origins: [] });
    const c = await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: fresh.org, appId: fresh.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(fresh, [NEW], [], 0)) }));
    expect(await ack(c.changes[0]!.id)).toMatchObject({ ok: true, change: { waiver: 'no_session', activeFrom: Date.now() } });
    const seen = await orgApp({ firstSession: Date.now(), origins: [] });
    const d = await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: seen.org, appId: seen.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(seen, [NEW], [], 0)) }));
    expect(await ack(d.changes[0]!.id)).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
    // A removal sent with the add of an origin that was in force: the scope had a user-facing origin, so no waiver.
    const removing = await orgApp({ firstSession: null });
    const e = await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: removing.org, appId: removing.id, add: [NEW], remove: [ORIGIN], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(removing, [NEW], [ORIGIN], 0)) }));
    expect(await ack(e.changes[0]!.id)).toMatchObject({ ok: true, change: { activeFrom: Date.now() + DELAY } });
  });

  it('drift: a baseline origin removed by a member’s change and put back by hand is drift', async () => {
    near();
    const app = await orgApp();
    await env.DB.prepare(
      "INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, ?2, ?3, ?4, 'migration.baseline', json_object('origins', json_array(?5)), 'system', 'migration:0006', ?6)",
    )
      .bind(Date.now(), app.org, app.id, app.scope, ORIGIN, `migration-0006:${app.id}`)
      .run();
    await detectDrift(env);
    expect(await rows("SELECT id FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id)).toEqual([]);
    await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW], remove: [ORIGIN], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(app, [NEW], [ORIGIN], 0)) }));
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(app.id, ORIGIN).run();
    await detectDrift(env);
    expect(await rows("SELECT id FROM security_events WHERE kind = 'drift' AND app_id = ?1", app.id)).toHaveLength(1);
  });

  it('stays within the hot-DB budget (two reads, one batch of at most eight)', async () => {
    near();
    const app = await orgApp({ origins: [ORIGIN, 'https://old.example.com'] });
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    const rpc = counted((ctx, e) => new ConsoleRpc(ctx, e), count);
    clock.advance(5000);
    await ok(rpc.changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW, 'https://b.example.com'], remove: ['https://old.example.com'], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(app, ['https://b.example.com', NEW], ['https://old.example.com'], 0)) }));
    expect(count.reads).toBeLessThanOrEqual(2);
    expect(count.batches).toBe(1);
    expect(count.statements - count.reads).toBeLessThanOrEqual(8);
  });
});

describe('ConsoleRpc.proposeChange (member, with step-up)', () => {
  it('a policy set and a raw-signing enable, bound to the settings layout; the policy must validate; no raw signing on a test app', async () => {
    near();
    const live = await orgApp({ live: true });
    const policy = autoApprovePolicy('Member policy');
    const v = await validatePolicy(policy, 24 * 60 * 60 * 1000 - 10 * 60 * 1000);
    const policyId = v.ok ? v.policy.id : '';
    const p = await ok(consoleRpc(clock).proposeChange({ ...member(), orgId: live.org, appId: live.id, kind: 'policy_set', policy, expectedVersion: 0, stepUpJwt: await stepUp(await settingsNonce(live, 'policy_set', 0, policyId)) }));
    expect(p).toMatchObject({ version: 1, change: { kind: 'policy_set', policyId, proposedByKind: 'member', status: 'pending' } });
    const raw = await ok(consoleRpc(clock).proposeChange({ ...member(), orgId: live.org, appId: live.id, kind: 'raw_sign_on', expectedVersion: 1, stepUpJwt: await stepUp(await settingsNonce(live, 'raw_sign_on', 1)) }));
    expect(raw).toMatchObject({ version: 2, change: { kind: 'raw_sign_on', proposedByKind: 'member' } });
    expect((await rows('SELECT proposer_sub FROM guarded_changes WHERE app_id = ?1', live.id)).map((r) => r.proposer_sub)).toEqual([SUB, SUB]);
    expect((await rows('SELECT actor_sub FROM app_changes WHERE app_id = ?1', live.id)).map((r) => r.actor_sub)).toEqual([SUB, SUB]);
    // A token for the policy is not one for raw signing (and the other way round).
    const other = await orgApp({ live: true });
    expect(await consoleRpc(clock).proposeChange({ ...member(), orgId: other.org, appId: other.id, kind: 'raw_sign_on', expectedVersion: 0, stepUpJwt: await stepUp(await settingsNonce(other, 'policy_set', 0, policyId)) })).toMatchObject({ ok: false, code: 'forbidden' });
    // An invalid policy, raw signing on a test app.
    expect(await consoleRpc(clock).proposeChange({ ...member(), orgId: other.org, appId: other.id, kind: 'policy_set', policy: { v: 2 }, expectedVersion: 0, stepUpJwt: await stepUp('x') })).toMatchObject({ ok: false, code: 'policy_invalid' });
    const test = await orgApp();
    expect(await consoleRpc(clock).proposeChange({ ...member(), orgId: test.org, appId: test.id, kind: 'raw_sign_on', expectedVersion: 0, stepUpJwt: await stepUp(await settingsNonce(test, 'raw_sign_on', 0)) })).toMatchObject({ ok: false, code: 'env_mismatch' });
    // A member proposal isn't held back by a recent scope assignment (only staff proposals are).
    const assigned = await orgApp({ live: true, assignedAt: Date.now() });
    await ok(consoleRpc(clock).proposeChange({ ...member(), orgId: assigned.org, appId: assigned.id, kind: 'raw_sign_on', expectedVersion: 0, stepUpJwt: await stepUp(await settingsNonce(assigned, 'raw_sign_on', 0)) }));
  });
});

describe('ConsoleRpc.ownerAction', () => {
  /** An app of the org on a scope the mock answers for; the body's token is signed for exactly that body. */
  async function setup(o: { actionNonce?: number } = {}) {
    const n = near(o);
    const app = await orgApp();
    return { n, app };
  }
  const signed = async (method: string, args: Record<string, unknown>, actionNonce: number, claims: Record<string, unknown> = {}) => ({
    method,
    args: { ...args, auth: { Oidc: { jwt: await stepUp(await ownerActionNonce({ signer: SIGNER, method, args, actionNonce }), claims) } } },
  });
  let ipN = 1;
  const ctx = () => ({ ...member(), clientIp: `198.18.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}` });

  it('relays the body byte-identical and answers the relay’s status, result and nearTx', async () => {
    const { n, app } = await setup();
    const body = await signed('propose_change', { scope_id: app.scope, change: { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: SUB } }] } }, client_proof: null }, 4);
    const r = await ok(consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body }));
    expect(r).toMatchObject({ status: 200, result: 9 });
    expect(r.nearTx).toBe(n.sent[0]!.hash);
    expect(n.sent[0]!.args).toEqual(body.args);
    // execute_change needs no token.
    n.views.get_scope = ((g) => (a: Record<string, unknown>) => ({ ...(g(a) as object), pending: [{ id: 2, change: {}, unlock_at_ms: 1 }] }))(n.views.get_scope!);
    expect(await ok(consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: { method: 'execute_change', args: { scope_id: app.scope, change_id: 2 } } }))).toMatchObject({ status: 200 });
    // A contract panic is the relay's answer, not an RPC failure.
    n.contract.cancel_change = () => {
      throw new Error('No such change');
    };
    const failed = await ok(consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await signed('cancel_change', { scope_id: app.scope, change_id: 2 }, 4) }));
    expect(failed).toMatchObject({ status: 422, code: 'contract_rejected' });
  });

  it('refusals before the relay are RpcCodes: another org’s scope, owner_nonce_mismatch, invalid_client_proof, token_used, not_owner, an email-carrying token', async () => {
    const { n, app } = await setup();
    const other = await orgApp();
    const cancel = (actionNonce = 4, claims: Record<string, unknown> = {}) => signed('cancel_change', { scope_id: app.scope, change_id: 2 }, actionNonce, claims);
    // The scope is another org's: not_found before any NEAR read.
    const reads = n.viewCalls.length;
    expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: other.org, body: await cancel() })).toMatchObject({ ok: false, code: 'not_found' });
    expect(n.viewCalls.length).toBe(reads);
    // N moved since the console built the action.
    expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await cancel(3) })).toMatchObject({ ok: false, code: 'owner_nonce_mismatch' });
    // AddClient with a proof for another client.
    const add = { scope_id: app.scope, change: { AddClient: { provider: 'google', aud: 'new.apps.googleusercontent.com' } }, client_proof: await google.sign({ iss: GOOGLE_ISS, aud: 'other.apps.googleusercontent.com', sub: SUB, nonce: 'p', exp: Math.floor(Date.now() / 1000) + 600 }) };
    expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await signed('propose_change', add, 4) })).toMatchObject({ ok: false, code: 'invalid_client_proof' });
    // A token of someone who isn't an on-chain owner.
    expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await cancel(4, { sub: 'stranger' }) })).toMatchObject({ ok: false, code: 'not_owner' });
    // The console asks for scope=openid: a token with email or hd is refused (it would be public once relayed).
    for (const pii of [{ email: 'o@partner.example' }, { hd: 'partner.example' }, { email_verified: true }]) {
      expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await cancel(4, pii) }), JSON.stringify(pii)).toMatchObject({ ok: false, code: 'forbidden' });
    }
    // Strict optional claims.
    expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await cancel(4, { iat: 'now' }) })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(n.sent).toHaveLength(0);
    // Used once, then token_used.
    const body = await cancel();
    await ok(consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body }));
    expect(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body })).toMatchObject({ ok: false, code: 'token_used' });
    // Only a member actor; never org_legacy.
    expect(await consoleRpc(clock).ownerAction({ ...hana(), orgId: app.org, body })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('clientIp feeds the same per-IP limiter as /v1/owner-actions', async () => {
    const { app } = await setup();
    // One frozen instant (no 2 s clicks): all eleven calls in one minute window.
    const ip = '198.51.100.77';
    await runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`ip:${ip}`)), (_i, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
    });
    for (let i = 0; i < OWNER_ACTIONS_PER_IP_MINUTE; i++) {
      expect(await consoleRpc().ownerAction({ ...member(), clientIp: ip, orgId: app.org, body: { method: 'execute_change', args: { scope_id: app.scope, change_id: 99 } } })).toMatchObject({ ok: false, code: 'not_found' });
    }
    expect(await consoleRpc().ownerAction({ ...member(), clientIp: ip, orgId: app.org, body: { method: 'execute_change', args: { scope_id: app.scope, change_id: 99 } } })).toMatchObject({ ok: false, code: 'rate_limited' });
    const res = await call('/v1/owner-actions', { body: { method: 'execute_change', args: { scope_id: app.scope, change_id: 99 } }, headers: { 'cf-connecting-ip': ip } });
    expect(res.status).toBe(429);
  });

  it('no email or hd of a refused token reaches a log line, an answer or a D1 row', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const { app } = await setup();
    const email = `pii-${uid()}@partner.example`;
    const hd = `hd-${uid()}.example`;
    const answers: unknown[] = [];
    answers.push(await consoleRpc(clock).ownerAction({ ...ctx(), orgId: app.org, body: await signed('cancel_change', { scope_id: app.scope, change_id: 2 }, 4, { email, hd, email_verified: true }) }));
    answers.push(
      await consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(app, [NEW], [], 0), { email, hd, email_verified: true }) }),
    );
    expect(answers).toEqual([expect.objectContaining({ ok: false, code: 'forbidden' }), expect.objectContaining({ ok: false, code: 'forbidden' })]);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    const dump: string[] = [];
    for (const { name } of tables.results) dump.push(JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results));
    for (const haystack of [...lines, ...answers.map((a) => JSON.stringify(a)), ...dump]) {
      expect(haystack).not.toContain(email);
      expect(haystack).not.toContain(hd);
    }
    // Nor the token itself.
    for (const l of lines) expect(l).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./u);
  });
});

describe('the API verifies against the on-chain console audiences, read fresh', () => {
  it('an audience the owner just dropped stops counting at once (no 60 s cache)', async () => {
    const n = near();
    const app = await orgApp();
    // Warm the cached config with the audience in force.
    await ok(consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: [NEW], remove: [], expectedVersion: 0, stepUpJwt: await stepUp(await originNonce(app, [NEW], [], 0)) }));
    const base = n.views.get_config!;
    n.views.get_config = () => ({ ...(base({}) as object), console_audiences: [] });
    const jwt = await stepUp(await originNonce(app, ['https://b.example.com'], [], 1));
    expect(await consoleRpc(clock).changeOrigins({ ...member(), orgId: app.org, appId: app.id, add: ['https://b.example.com'], remove: [], expectedVersion: 1, stepUpJwt: jwt })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
