// D918 (docs/partner-platform-spec.md piece P2, A3, A7): platform keys in the API. Registration by an on-chain owner of
// each scope (the `platform.key_add` step-up, its nonce bound to the env, the org, the scopes, the thumbprint and the
// label) and by staff (held until an owner of each scope accepts it, which counts as its confirmation, or a second staff
// member approves it); the 7-day rule after a security-contact change; the two-key quota; the announcement's ack and
// the platform minimum with no waiver; the cancel link; an owner's confirmation (any owner on a dev env, four eyes on a
// real-money one, held in the commit predicate and the table's CHECK); immediate revocation by each route, each
// cancelling the key's waiting web addresses in the same batch; expiry and lapse; the org's switch with the key review
// and the freeze mirror; the notices' page and acks; nothing a platform key could present confirms anything.
import {
  CONSOLE_ERROR_STATUS,
  PLATFORM_KEY_LIFETIME_MS,
  PLATFORM_MIN_DELAY_MS,
  PLATFORM_UNFREEZE_GRACE_MS,
  newId,
  nonceOf,
  parsePlatformPublicKey,
  platformKeyDigest,
} from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { platformProposal as proposal } from './platform-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJwksCache } from '@hana-id/oidc';
import type { Writer } from '../src/changes/cas.ts';
import { HotDb } from '../src/changes/db.ts';
import { platformMinDelayMs } from '../src/guarded/config.ts';
import { platformKeysMaintenance } from '../src/platform/cron.ts';
import { REVOKE_LIMITS } from '../src/platform/revoke-guard.ts';
import { placedStub } from '../src/placement.ts';
import { cancelPlatformKey, confirmPlatformKey, fourEyesEnv, registerPlatformKey, revokePlatformKey } from '../src/platform/keys.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { CONSOLE_COSTS, ConsoleRpc } from '../src/rpc/console.ts';
import { clearViewCaches } from '../src/views.ts';
import { ORIGIN, call } from './helpers.ts';
import { type DbCount, type OrgApp, STEP_UP_SUB, counted, countingDb, hana, linkToken, member, orgApp, ownClock, ownerChain, rid, rows, stepUp, system } from './rpc-helpers.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock: ReturnType<typeof ownClock>;
beforeEach(() => {
  clock = ownClock({ freeze: true });
  clearJwksCache();
  clearViewCaches();
});
afterEach(() => vi.restoreAllMocks());

type Env = typeof env;
const MAINNET: Partial<Env> = { NETWORK: 'mainnet', APP_CHANGE_DELAY_MS: String(DAY) };
/** ConsoleRpc over `e`; each call first moves the clock 2 s on (a person clicking), so the org's budget refills. */
const consoleOn = (e: Partial<Env> = {}): ConsoleRpc => {
  const rpc = new ConsoleRpc(createExecutionContext(), { ...env, ...e } as Env);
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
const adminOn = (e: Partial<Env> = {}) => new AdminRpc(createExecutionContext(), { ...env, ...e } as Env);

async function ok<T>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
  const r = await p;
  if (!(r as { ok: boolean }).ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}
async function no<T>(p: Promise<T>): Promise<{ code: string; error?: string }> {
  const r = (await p) as { ok: boolean; code?: string; error?: string };
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r as { code: string; error?: string };
}

/** A fresh P-256 key pair's public half, as a partner pastes it (a JWK). */
async function newPublicKey(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}
const thumbprintOf = async (text: string): Promise<string> => {
  const p = await parsePlatformPublicKey(text);
  if (!p.ok) throw new Error(p.problem);
  return p.key.thumbprint;
};

/** A console owner with their own Google `sub` and email (member() is owner-sub-1, owner@partner.example). */
const owner = (sub: string, email: string, id: string = newId('user')) => ({ actor: { kind: 'member' as const, id, sub, email, sessionHash: 'A'.repeat(43) }, requestId: rid(), clientIp: '203.0.113.7' });
const staff = (id: string, email: string) => ({ actor: { kind: 'hana' as const, id, email }, requestId: rid(), clientIp: '198.51.100.2' });

const digest = async (kind: 'add' | 'accept' | 'confirm', i: { orgId: string; keyId?: string; publicKey?: string; thumbprint?: string; scopes: string[]; label: string; envName?: string; signer?: string }) =>
  nonceOf(
    await platformKeyDigest({
      kind,
      signer: i.signer ?? env.SIGNER_ACCOUNT,
      env: i.envName ?? env.ENV_NAME,
      orgId: i.orgId,
      keyId: i.keyId ?? '',
      thumbprint: i.thumbprint ?? (await thumbprintOf(i.publicKey!)),
      scopes: i.scopes,
      label: i.label,
    }),
  );

interface Reg {
  app: OrgApp;
  scopes: string[];
  publicKey: string;
  label: string;
}

async function setup(o: { scopes?: 1 | 2; owners?: string[] } = {}): Promise<Reg & { second?: OrgApp }> {
  ownerChain({ owners: o.owners ?? [STEP_UP_SUB, 'owner-sub-2'] });
  const app = await orgApp();
  const second = o.scopes === 2 ? await orgApp({ org: app.org }) : undefined;
  return { app, second, scopes: second ? [app.scope, second.scope] : [app.scope], publicKey: await newPublicKey(), label: 'Backend key 1' };
}

/** An owner's registration with a step-up for exactly this key (or `nonce`), on `rpc` (default: the dev env). */
async function memberRegister(r: Reg, o: { rpc?: ConsoleRpc; who?: ReturnType<typeof owner>; nonce?: string; sub?: string } = {}) {
  const who = o.who ?? member();
  const jwt = await stepUp(o.nonce ?? (await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: r.label })), { sub: o.sub ?? who.actor.sub });
  return (o.rpc ?? consoleOn()).proposePlatformKey({ ...who, orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: r.publicKey, stepUpJwt: jwt });
}

const staffRegister = (r: Reg, o: { rpc?: AdminRpc; who?: ReturnType<typeof staff> } = {}) =>
  (o.rpc ?? adminOn()).registerPlatformKey({ ...(o.who ?? staff('access-sub-staff-1', 'staff1@hana.example')), orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: r.publicKey, reason: 'Thumbprint read back by phone with the network’s CTO' });

/** The announcement's ack as the admin Worker sends it (with the revoke link's hash when the key is in force at once). */
async function announce(keyId: string, o: { rpc?: AdminRpc; atOnce?: boolean } = {}) {
  const cancel = linkToken();
  const revoke = linkToken();
  const r = await ok((o.rpc ?? adminOn()).ackPlatformKeyNotice({ ...system(), keyId, cancelTokenHash: await cancel.hash, ...(o.atOnce ? { revokeTokenHash: await revoke.hash } : {}) }));
  return { ...r, cancel: cancel.token, revoke: revoke.token };
}

async function confirmBy(r: Reg, keyId: string, who: ReturnType<typeof owner>, rpc: ConsoleRpc = consoleOn()) {
  const jwt = await stepUp(await digest('confirm', { orgId: r.app.org, keyId, publicKey: r.publicKey, scopes: r.scopes, label: r.label }), { sub: who.actor.sub });
  return rpc.confirmPlatformKey({ ...who, orgId: r.app.org, keyId, stepUpJwt: jwt });
}
async function acceptBy(r: Reg, keyId: string, who: ReturnType<typeof owner>, rpc: ConsoleRpc = consoleOn()) {
  const jwt = await stepUp(await digest('accept', { orgId: r.app.org, keyId, publicKey: r.publicKey, scopes: r.scopes, label: r.label }), { sub: who.actor.sub });
  return rpc.acceptPlatformKey({ ...who, orgId: r.app.org, keyId, stepUpJwt: jwt });
}

const keyRow = async (id: string) => (await env.DB.prepare('SELECT * FROM platform_keys WHERE id = ?1').bind(id).first<Record<string, unknown>>())!;
const ledger = (orgId: string, kind: string) => rows<{ kind: string; actor_kind: string; actor_id: string; actor_sub: string | null; detail_json: string; request_id: string }>('SELECT kind, actor_kind, actor_id, actor_sub, detail_json, request_id FROM app_changes WHERE org_id = ?1 AND kind = ?2 ORDER BY seq', orgId, kind);
const refusal = (sql: string, ...binds: unknown[]): Promise<string> =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => 'accepted',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );

/** A waiting web address the platform proposed for `app` with key `keyId` (written within migration 0033's rules). */
const platformProposal = (app: OrgApp, keyId: string, origin: string, o: { inForce?: boolean } = {}): Promise<string> => proposal(app.id, keyId, origin, o);

// ---- registration ----

describe('registration by an on-chain owner of each scope', () => {
  it('registers a waiting key, announced later; four eyes off and the 24 h minimum on this dev env; one ledger row', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    expect(key).toMatchObject({ orgId: r.app.org, label: r.label, scopes: r.scopes, status: 'pending', state: 'waiting', fourEyes: false, proposedByKind: 'member' });
    expect(key.thumbprint).toBe(await thumbprintOf(r.publicKey));
    expect(key.id).toMatch(/^pkc_/u);
    const row = await keyRow(key.id);
    expect(row).toMatchObject({ four_eyes: 0, min_delay_ms: PLATFORM_MIN_DELAY_MS, proposer_sub: STEP_UP_SUB, proposer_email_key: 'owner@partner.example', proposer_email: null, notified_at: null, active_from: null });
    expect(await env.DB.prepare('SELECT length(public_key) AS n, hex(substr(public_key, 1, 1)) AS b FROM platform_keys WHERE id = ?1').bind(key.id).first()).toEqual({ n: 65, b: '04' });
    const [l] = await ledger(r.app.org, 'platform.key_proposed');
    expect(l).toMatchObject({ actor_kind: 'member', actor_sub: STEP_UP_SUB });
    expect(JSON.parse(l!.detail_json)).toMatchObject({ keyId: key.id, thumbprint: key.thumbprint, scopes: r.scopes, by: 'member', fourEyes: false });
    // Never the public key itself in the ledger: the thumbprint does.
    expect(l!.detail_json).not.toContain(JSON.parse(r.publicKey).x);
  });

  it('a key for two scopes needs an owner of both: an owner of only one is refused and nothing is written', async () => {
    const r = await setup({ scopes: 2 });
    const n = ownerChain({ owners: [STEP_UP_SUB] });
    const base = n.views.get_scope!;
    n.views.get_scope = (a) => (a.scope_id === r.second!.scope ? { ...(base(a) as object), owners: [{ Oidc: { provider: 'google', sub: 'someone-else' } }] } : base(a));
    expect(await no(memberRegister(r))).toMatchObject({ code: 'not_owner' });
    expect(await rows('SELECT id FROM platform_keys WHERE org_id = ?1', r.app.org)).toEqual([]);
    // With both scopes owned it goes through.
    ownerChain({ owners: [STEP_UP_SUB] });
    expect((await ok(memberRegister(r))).key.scopes).toEqual([...r.scopes].sort());
  });

  it('the nonce binds the env, the signer, the org, the scopes, the thumbprint and the label: a token for another key is refused', async () => {
    const r = await setup({ scopes: 2 });
    const other = await newPublicKey();
    const wrong = [
      await digest('add', { orgId: r.app.org, publicKey: other, scopes: r.scopes, label: r.label }),
      await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: [r.app.scope], label: r.label }),
      await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: 'Another label' }),
      await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: r.label, envName: 'sandbox-other' }),
      await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: r.label, signer: 'another-signer.test.near' }),
      await digest('add', { orgId: newId('org'), publicKey: r.publicKey, scopes: r.scopes, label: r.label }),
      // Another kind's layout over the same fields.
      await digest('confirm', { orgId: r.app.org, keyId: newId('platformKey'), publicKey: r.publicKey, scopes: r.scopes, label: r.label }),
    ];
    for (const nonce of wrong) expect(await no(memberRegister(r, { nonce }))).toMatchObject({ code: 'forbidden' });
    expect(await rows('SELECT id FROM platform_keys WHERE org_id = ?1', r.app.org)).toEqual([]);
    await ok(memberRegister(r));
  });

  it('a used step-up token is refused the second time', async () => {
    const r = await setup();
    const jwt = await stepUp(await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: r.label }));
    const call = () => consoleOn().proposePlatformKey({ ...member(), orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: r.publicKey, stepUpJwt: jwt });
    await ok(call());
    expect((await no(call())).code).toMatch(/token_used|conflict/u);
  });

  it('refused within 7 days of a security-contact change, allowed after', async () => {
    const r = await setup();
    await ok(adminOn().setSecurityContacts({ ...hana(), orgId: r.app.org, emails: ['new-security@partner.example'] }));
    expect(await no(memberRegister(r))).toMatchObject({ code: 'conflict' });
    expect(await no(staffRegister(r))).toMatchObject({ code: 'conflict' });
    clock.advance(7 * DAY + 1000);
    await ok(memberRegister(r));
  });

  it('at most two keys in force, waiting or awaiting acceptance; a cancelled one frees its place', async () => {
    const r = await setup();
    const a = (await ok(memberRegister(r))).key;
    await ok(staffRegister({ ...r, publicKey: await newPublicKey() }));
    const third = { ...r, publicKey: await newPublicKey() };
    expect(await no(memberRegister(third))).toMatchObject({ code: 'key_limit' });
    await ok(consoleOn().cancelPlatformKey({ ...member(), orgId: r.app.org, keyId: a.id }));
    await ok(memberRegister(third));
  });

  it('refuses an org with no security contact, a live scope, another org’s scope, a frozen org, a reused key', async () => {
    const r = await setup();
    const lonely = await orgApp({ contacts: [] });
    expect(await no(memberRegister({ ...r, app: lonely, scopes: [lonely.scope] }))).toMatchObject({ code: 'no_security_contact' });
    const live = await orgApp({ org: r.app.org, live: true });
    expect(await no(memberRegister({ ...r, scopes: [live.scope] }))).toMatchObject({ code: 'env_mismatch' });
    const foreign = await orgApp();
    expect(await no(memberRegister({ ...r, scopes: [foreign.scope] }))).toMatchObject({ code: 'not_found' });
    await ok(memberRegister(r));
    expect(await no(memberRegister({ ...r, label: 'Same key again' }))).toMatchObject({ code: 'conflict' });
    await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    expect(await no(memberRegister({ ...r, publicKey: await newPublicKey() }))).toMatchObject({ code: 'forbidden' });
  });

  it('refuses a private key (JWK or PEM) with words that say so, a point off the curve, another curve, and a bad label', async () => {
    const r = await setup();
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const priv = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    const register = (publicKey: string, label = r.label) => staffRegister({ ...r, publicKey, label });
    expect((await no(register(priv))).error).toMatch(/private key/u);
    // A PEM private key's armour (built here so no secret scanner mistakes the test for a leak; the body is no key).
    const armour = (w: string) => `-----${w} ${['PRIVATE', 'KEY'].join(' ')}-----`;
    expect((await no(register(`${armour('BEGIN')}\nAAAA\n${armour('END')}`))).error).toMatch(/private key/u);
    const pub = JSON.parse(r.publicKey) as { x: string; y: string };
    const flipped = JSON.stringify({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.x });
    expect((await no(register(flipped))).error).toMatch(/not a point/u);
    expect(await no(register(JSON.stringify({ kty: 'EC', crv: 'P-384', x: pub.x, y: pub.y })))).toMatchObject({ code: 'bad_request' });
    expect(await no(register(r.publicKey, 'x'.repeat(41)))).toMatchObject({ code: 'bad_request' });
    expect(await no(register(r.publicKey, 'Journear backend'))).toMatchObject({ code: 'bad_request' });
    expect(await no(register(r.publicKey, 'api.example.com'))).toMatchObject({ code: 'bad_request' });
    expect(await rows('SELECT id FROM platform_keys WHERE org_id = ?1', r.app.org)).toEqual([]);
  });

  it('four_eyes is 1 on a mainnet setup and fixed once written; the wait is fixed too', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r, { rpc: consoleOn(MAINNET) }));
    expect(key.fourEyes).toBe(true);
    expect(await keyRow(key.id)).toMatchObject({ four_eyes: 1, min_delay_ms: DAY });
    expect(await refusal('UPDATE platform_keys SET four_eyes = 0 WHERE id = ?1', key.id)).toMatch(/never changed/u);
    expect(await refusal('UPDATE platform_keys SET min_delay_ms = 60000 WHERE id = ?1', key.id)).toMatch(/never changed/u);
    expect(await refusal('UPDATE platform_keys SET proposed_by = ?2 WHERE id = ?1', key.id, 'usr_other')).toMatch(/never changed/u);
    expect(fourEyesEnv({ NETWORK: 'mainnet' })).toBe(true);
    expect(fourEyesEnv({ NETWORK: 'testnet' })).toBe(false);
  });
});

describe('registration by staff', () => {
  it('is held awaiting acceptance: no notice, no ack, no confirmation until an owner accepts it or a second staff member approves it', async () => {
    const r = await setup();
    const { key } = await ok(staffRegister(r));
    expect(key).toMatchObject({ status: 'awaiting_acceptance', state: 'awaiting_acceptance', proposedByKind: 'hana', proposedByEmail: 'staff1@hana.example' });
    expect((await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.id === key.id)).toEqual([]);
    expect(await no(adminOn().ackPlatformKeyNotice({ ...system(), keyId: key.id, cancelTokenHash: await linkToken().hash }))).toMatchObject({ code: 'not_pending' });
    expect(await no(confirmBy(r, key.id, member()))).toMatchObject({ code: 'not_pending' });
    // The partner's view never names the staff member.
    const seen = (await ok(consoleOn().listPlatformKeys({ ...member(), orgId: r.app.org }))).keys[0]!;
    expect(seen.proposedBy).toBe('hana');
    expect(JSON.stringify(seen)).not.toMatch(/staff1@|access-sub-staff/u);
    // A bare D1 write can't make it usable either.
    expect(await refusal("UPDATE platform_keys SET status = 'pending' WHERE id = ?1", key.id)).toMatch(/CHECK/u);
  });

  it('the registering staffer can’t approve it (same Access subject, or the same email under another subject); a second staffer can', async () => {
    const r = await setup();
    const { key } = await ok(staffRegister(r));
    expect(await no(adminOn().approvePlatformKey({ ...staff('access-sub-staff-1', 'staff1@hana.example'), orgId: r.app.org, keyId: key.id, reason: 'I checked it myself, honestly' }))).toMatchObject({ code: 'forbidden' });
    expect(await no(adminOn().approvePlatformKey({ ...staff('access-sub-other', 'Staff.1+again@hana.example'), orgId: r.app.org, keyId: key.id, reason: 'Second identity of the same person' }))).toMatchObject({ code: 'forbidden' });
    // The table refuses it whoever writes it.
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'hana', accepted_by = proposed_by, accepted_at = 1, accept_note = 'x', accepted_email_key = 'z@x' WHERE id = ?1", key.id)).toMatch(/CHECK/u);
    const approved = await ok(adminOn().approvePlatformKey({ ...staff('access-sub-staff-2', 'staff2@hana.example'), orgId: r.app.org, keyId: key.id, reason: 'Checked the thumbprint with the CTO by phone' }));
    expect(approved.key).toMatchObject({ status: 'pending', acceptedByKind: 'hana', acceptedBy: 'access-sub-staff-2', acceptedByEmail: 'staff2@hana.example' });
    // Then it waits the full delay after its announcement, unless an owner confirms it (any owner: none registered it).
    const a = await announce(key.id);
    expect(a.key.activeFrom).toBe(Date.now() + PLATFORM_MIN_DELAY_MS);
    expect(a.key.state).toBe('waiting');
    expect((await ok(confirmBy(r, key.id, member()))).key.state).toBe('in_force');
  });

  it('a second staff member’s approval on a real-money setup still waits, and any owner may confirm it there', async () => {
    const r = await setup();
    const admin = adminOn(MAINNET);
    const { key } = await ok(staffRegister(r, { rpc: admin }));
    await ok(admin.approvePlatformKey({ ...staff('access-sub-staff-2', 'staff2@hana.example'), orgId: r.app.org, keyId: key.id, reason: 'Checked the thumbprint with the CTO by phone' }));
    await announce(key.id, { rpc: admin });
    expect((await ok(confirmBy(r, key.id, member(), consoleOn(MAINNET)))).key.state).toBe('in_force');
  });

  it('an owner’s acceptance (an owner of each scope, its own nonce) counts as the confirmation: in force once announced, with the revoke link', async () => {
    const r = await setup({ scopes: 2 });
    const { key } = await ok(staffRegister(r));
    // The accept layout binds the key: a token for a registration or a confirmation of it doesn't do.
    const wrong = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: key.id, publicKey: r.publicKey, scopes: r.scopes, label: r.label }));
    expect(await no(consoleOn().acceptPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id, stepUpJwt: wrong }))).toMatchObject({ code: 'forbidden' });
    const accepted = await ok(acceptBy(r, key.id, member()));
    expect(accepted.key).toMatchObject({ status: 'pending', acceptedByKind: 'member', confirmedKind: 'acceptance', state: 'waiting' });
    const [notice] = (await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.id === key.id);
    expect(notice).toMatchObject({ kind: 'announce', inForceAtOnce: true });
    // Its ack needs the revoke link, since the email is the last word before it works.
    expect(await no(adminOn().ackPlatformKeyNotice({ ...system(), keyId: key.id, cancelTokenHash: await linkToken().hash }))).toMatchObject({ code: 'bad_request' });
    const a = await announce(key.id, { atOnce: true });
    expect(a.key).toMatchObject({ state: 'in_force', status: 'active', activeFrom: Date.now() });
    expect(await keyRow(key.id)).toMatchObject({ unconfirmed_active_from: Date.now() + PLATFORM_MIN_DELAY_MS, revoke_link_until: Date.now() + 7 * DAY, confirm_notified_at: Date.now() });
    // The revoke link stops it at once.
    expect((await ok(consoleOn().revokePlatformKeyByLink({ actor: { kind: 'link', id: key.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: key.id, token: a.revoke }))).key.state).toBe('revoked');
  });

  it('an acceptance by an owner of only one of the key’s two scopes is refused, and on a real-money setup the registrant can’t accept their own key under a member account', async () => {
    const r = await setup({ scopes: 2 });
    const { key } = await ok(staffRegister(r, { rpc: adminOn(MAINNET) }));
    const n = ownerChain({ owners: [STEP_UP_SUB] });
    const base = n.views.get_scope!;
    n.views.get_scope = (a) => (a.scope_id === r.second!.scope ? { ...(base(a) as object), owners: [] } : base(a));
    expect(await no(acceptBy(r, key.id, member(), consoleOn(MAINNET)))).toMatchObject({ code: 'not_owner' });
    ownerChain({ owners: [STEP_UP_SUB, 'owner-sub-2'] });
    expect(await no(acceptBy(r, key.id, owner('owner-sub-2', 'staff1@hana.example'), consoleOn(MAINNET)))).toMatchObject({ code: 'forbidden' });
    await ok(acceptBy(r, key.id, member(), consoleOn(MAINNET)));
  });
});

// ---- the wait ----

describe('the announcement and the wait', () => {
  it('a key nobody confirms waits the 24 h platform minimum on a dev env (appChangeDelayMs is 60 s here), with no waiver; in force by the predicate at its date', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const a = await announce(key.id);
    expect(a.key.activeFrom).toBe(Date.now() + DAY);
    expect(await keyRow(key.id)).toMatchObject({ unconfirmed_active_from: Date.now() + DAY, active_from: Date.now() + DAY, expires_at: Date.now() + DAY + PLATFORM_KEY_LIFETIME_MS, status: 'pending' });
    clock.advance(DAY - 10_000);
    expect((await ok(consoleOn().getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('waiting');
    await platformKeysMaintenance(env);
    expect((await keyRow(key.id)).status).toBe('pending');
    clock.advance(10_000);
    expect((await ok(consoleOn().getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('in_force');
    // The test's clock runs ahead of D1's: the database records `active` only once its own clock has passed the date
    // (platform_keys_active_on_time), so the job leaves it pending here, and nothing is written but the attempt.
    await platformKeysMaintenance(env);
    expect((await keyRow(key.id)).status).toBe('pending');
    expect(await ledger(r.app.org, 'platform.key_active')).toHaveLength(0);
  });

  it('the hourly job records a key in force once, by the database’s clock (a local* key whose 60 s wait has passed)', async () => {
    const r = await setup();
    const db = await dbNow();
    const { id } = await bareKey(r, { min_delay_ms: 60_000, notified_at: db - 110_000, unconfirmed_active_from: db - 50_000, active_from: db - 50_000, expires_at: db - 50_000 + PLATFORM_KEY_LIFETIME_MS });
    expect((await platformKeysMaintenance(env, db)).activated).toBeGreaterThanOrEqual(1);
    expect(await keyRow(id)).toMatchObject({ status: 'active', activated_recorded_at: db });
    expect(await ledger(r.app.org, 'platform.key_active')).toHaveLength(1);
    await platformKeysMaintenance(env, db + 1000);
    expect(await ledger(r.app.org, 'platform.key_active')).toHaveLength(1);
  });

  it('a local* test env on testnet keeps its own short delay; anything else gets the 24 h', async () => {
    expect(platformMinDelayMs({ ENV_NAME: 'local', NETWORK: 'testnet' })).toBe(0);
    expect(platformMinDelayMs({ ENV_NAME: 'local-alice', NETWORK: 'testnet' })).toBe(0);
    for (const e of [{ ENV_NAME: 'local', NETWORK: 'mainnet' }, { ENV_NAME: 'sandbox-dev', NETWORK: 'testnet' }, { ENV_NAME: 'xlocal', NETWORK: 'testnet' }, { NETWORK: 'testnet' }, { ENV_NAME: 'local' }]) expect(platformMinDelayMs(e), JSON.stringify(e)).toBe(DAY);
    const r = await setup();
    const local = { ENV_NAME: 'local-test', NETWORK: 'testnet' } as Partial<Env>;
    // The nonce is over the env's name.
    const jwt = await stepUp(await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: r.label, envName: 'local-test' }));
    const { key } = await ok(consoleOn(local).proposePlatformKey({ ...member(), orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: r.publicKey, stepUpJwt: jwt }));
    expect(await keyRow(key.id)).toMatchObject({ min_delay_ms: 60_000 });
    expect((await announce(key.id, { rpc: adminOn(local) })).key.activeFrom).toBe(Date.now() + 60_000);
  });

  it('no writer brings a key in early without a confirmation: the trigger and the CHECKs refuse bare D1 writes', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    // In force before its announcement.
    expect(await refusal('UPDATE platform_keys SET active_from = ?2, expires_at = ?3 WHERE id = ?1', key.id, Date.now(), Date.now() + 1)).toMatch(/CHECK/u);
    // An announcement with a short wait.
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?2, active_from = ?2, expires_at = ?3 WHERE id = ?1', key.id, Date.now(), Date.now() + 1)).toMatch(/CHECK|early/u);
    await announce(key.id);
    expect(await refusal('UPDATE platform_keys SET active_from = ?2 WHERE id = ?1', key.id, Date.now())).toMatch(/early only when confirmed/u);
    expect(await refusal('UPDATE platform_keys SET unconfirmed_active_from = ?2, active_from = ?2 WHERE id = ?1', key.id, Date.now())).toMatch(/early only when confirmed|CHECK/u);
    // A confirmation of the wrong state, or twice, is refused by the trigger too.
    expect(await refusal("UPDATE platform_keys SET confirmed_kind = 'acceptance', confirmed_by = 'u', confirmed_sub = 's', confirmed_at = 1 WHERE id = ?1", key.id)).toMatch(/written once|CHECK/u);
  });

  it('the CLI-style announce shortcut doesn’t exist for keys: only the system actor acks, once', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    expect(await no(adminOn().ackPlatformKeyNotice({ ...hana(), keyId: key.id, cancelTokenHash: await linkToken().hash }))).toMatchObject({ code: 'forbidden' });
    await announce(key.id);
    expect(await no(adminOn().ackPlatformKeyNotice({ ...system(), keyId: key.id, cancelTokenHash: await linkToken().hash }))).toMatchObject({ code: 'not_pending' });
  });
});

describe('cancel', () => {
  it('the emailed link cancels a waiting key once, with the link actor; a wrong token or a key in force is refused', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const a = await announce(key.id);
    const link = (token: string) => consoleOn().cancelPlatformKeyByLink({ actor: { kind: 'link', id: key.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: key.id, token });
    expect(await no(link(linkToken().token))).toMatchObject({ code: 'forbidden' });
    expect(await no(link('not-a-token-not-a-token-not-a-token-not-a-t'))).toMatchObject({ code: 'forbidden' });
    expect((await ok(link(a.cancel))).key.state).toBe('cancelled');
    expect(await keyRow(key.id)).toMatchObject({ status: 'cancelled', cancelled_by_kind: 'link' });
    const [l] = await ledger(r.app.org, 'platform.key_cancelled');
    expect(l).toMatchObject({ actor_kind: 'link', actor_id: key.id });
    expect(await no(link(a.cancel))).toMatchObject({ code: 'not_pending' });
    // A cancelled key never comes back.
    expect(await refusal("UPDATE platform_keys SET status = 'pending', cancelled_at = NULL WHERE id = ?1", key.id)).toMatch(/never comes back|CHECK/u);
  });

  it('a key in force can’t be cancelled (it is stopped instead); owners and staff cancel a waiting one', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const a = await announce(key.id);
    clock.advance(DAY + 1000);
    expect(await no(consoleOn().cancelPlatformKeyByLink({ actor: { kind: 'link', id: key.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: key.id, token: a.cancel }))).toMatchObject({ code: 'not_pending' });
    expect(await no(consoleOn().cancelPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).toMatchObject({ code: 'not_pending' });
    const s = (await ok(staffRegister({ ...r, publicKey: await newPublicKey() }))).key;
    expect((await ok(adminOn().cancelPlatformKey({ ...hana(), orgId: r.app.org, keyId: s.id }))).key.state).toBe('cancelled');
  });
});

// ---- the owner's confirmation ----

describe('an owner’s confirmation', () => {
  const second = () => owner('owner-sub-2', 'second.owner@partner.example');

  it('on a dev env the registrant’s own confirmation brings the key into force at once', async () => {
    const r = await setup();
    const who = member();
    const { key } = await ok(memberRegister(r, { who }));
    await announce(key.id);
    const c = await ok(confirmBy(r, key.id, owner(who.actor.sub, who.actor.email, who.actor.id)));
    expect(c.key).toMatchObject({ state: 'in_force', status: 'active', confirmedKind: 'confirm', confirmedBy: who.actor.id, activeFrom: Date.now(), expiresAt: Date.now() + PLATFORM_KEY_LIFETIME_MS });
    const [l] = await ledger(r.app.org, 'platform.key_confirmed');
    expect(l).toMatchObject({ actor_kind: 'member', actor_id: who.actor.id, actor_sub: STEP_UP_SUB });
    expect(await no(confirmBy(r, key.id, owner(who.actor.sub, who.actor.email, who.actor.id)))).toMatchObject({ code: 'not_pending' });
  });

  it('on a production env the registrant’s own confirmation is refused, by the API and by the table’s CHECK', async () => {
    const r = await setup();
    const who = member();
    const { key } = await ok(memberRegister(r, { who, rpc: consoleOn(MAINNET) }));
    await announce(key.id, { rpc: adminOn(MAINNET) });
    expect(await no(confirmBy(r, key.id, owner(who.actor.sub, who.actor.email, who.actor.id), consoleOn(MAINNET)))).toMatchObject({ code: 'forbidden' });
    // Another console user, the same Google account: still the registrant.
    expect(await no(confirmBy(r, key.id, owner(who.actor.sub, 'other@partner.example'), consoleOn(MAINNET)))).toMatchObject({ code: 'forbidden' });
    for (const [by, sub, mail] of [
      [who.actor.id, 'owner-sub-2', 'other@partner.example'],
      ['usr_other', STEP_UP_SUB, 'other@partner.example'],
      ['usr_other', 'owner-sub-2', 'owner@partner.example'],
    ]) {
      expect(
        await refusal(
          "UPDATE platform_keys SET confirmed_kind = 'confirm', confirmed_by = ?2, confirmed_sub = ?3, confirmed_email_key = ?4, confirmed_at = ?5, active_from = ?5, status = 'active', activated_recorded_at = ?5 WHERE id = ?1",
          key.id,
          by,
          sub,
          mail,
          Date.now(),
        ),
      ).toMatch(/CHECK/u);
    }
    expect((await keyRow(key.id)).confirmed_at).toBeNull();
  });

  it('on a production env a second owner’s confirmation brings it into force', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r, { rpc: consoleOn(MAINNET) }));
    await announce(key.id, { rpc: adminOn(MAINNET) });
    expect((await ok(confirmBy(r, key.id, second(), consoleOn(MAINNET)))).key.state).toBe('in_force');
  });

  it('a confirmer who differs only in the console account and the Google account, not the email (dots and +tags aside), is refused', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r, { rpc: consoleOn(MAINNET) }));
    await announce(key.id, { rpc: adminOn(MAINNET) });
    expect(await no(confirmBy(r, key.id, owner('owner-sub-2', 'Owner+backup@partner.example'), consoleOn(MAINNET)))).toMatchObject({ code: 'forbidden' });
    expect(await no(confirmBy(r, key.id, owner('owner-sub-2', 'o.w.n.e.r@partner.example'), consoleOn(MAINNET)))).toMatchObject({ code: 'forbidden' });
  });

  it('with one owner only, the key waits the 24 h on a production env', async () => {
    const r = await setup({ owners: [STEP_UP_SUB] });
    const { key } = await ok(memberRegister(r, { rpc: consoleOn(MAINNET) }));
    await announce(key.id, { rpc: adminOn(MAINNET) });
    expect(await no(confirmBy(r, key.id, member(), consoleOn(MAINNET)))).toMatchObject({ code: 'forbidden' });
    // An owner member who isn't an on-chain owner of the scope can't stand in.
    expect(await no(confirmBy(r, key.id, second(), consoleOn(MAINNET)))).toMatchObject({ code: 'not_owner' });
    clock.advance(DAY + 1000);
    await platformKeysMaintenance(env);
    expect((await ok(consoleOn().getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('in_force');
  });

  it('refused before the announcement, after a cancel, after a revocation, within 7 days of a contact change, while frozen, and for another key’s token', async () => {
    const r = await setup();
    const k1 = (await ok(memberRegister(r))).key;
    expect(await no(confirmBy(r, k1.id, second()))).toMatchObject({ code: 'not_pending' });
    await announce(k1.id);
    // A token for the confirmation of another key.
    const other = newId('platformKey');
    const jwt = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: other, publicKey: r.publicKey, scopes: r.scopes, label: r.label }), { sub: 'owner-sub-2' });
    expect(await no(consoleOn().confirmPlatformKey({ ...second(), orgId: r.app.org, keyId: k1.id, stepUpJwt: jwt }))).toMatchObject({ code: 'forbidden' });
    await ok(consoleOn().cancelPlatformKey({ ...member(), orgId: r.app.org, keyId: k1.id }));
    expect(await no(confirmBy(r, k1.id, second()))).toMatchObject({ code: 'not_pending' });
    const r2 = { ...r, publicKey: await newPublicKey() };
    const k2 = (await ok(memberRegister(r2))).key;
    await announce(k2.id);
    await ok(consoleOn().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: k2.id }));
    expect(await no(confirmBy(r2, k2.id, second()))).toMatchObject({ code: 'not_pending' });
    const r3 = { ...r, publicKey: await newPublicKey() };
    const k3 = (await ok(memberRegister(r3))).key;
    await announce(k3.id);
    await ok(adminOn().setSecurityContacts({ ...hana(), orgId: r.app.org, emails: ['other-security@partner.example'] }));
    expect(await no(confirmBy(r3, k3.id, second()))).toMatchObject({ code: 'conflict' });
    clock.advance(7 * DAY + 1000);
    // (by now the 24 h passed: a key already in force can't be confirmed)
    expect(await no(confirmBy(r3, k3.id, second()))).toMatchObject({ code: 'not_pending' });
    const r4 = { ...r, publicKey: await newPublicKey() };
    const k4 = (await ok(memberRegister(r4))).key;
    await announce(k4.id);
    // The mirror's flag alone (a bare write: the real mirror would also have cancelled the waiting key).
    await env.DB.prepare("INSERT INTO platform_orgs (org_id, frozen, frozen_at, set_by, set_at) VALUES (?1, 1, ?2, 'test', ?2)").bind(r.app.org, Date.now()).run();
    expect(await no(confirmBy(r4, k4.id, second()))).toMatchObject({ code: 'forbidden' });
  });

  it('a confirmation racing a revocation: whichever commits first wins (each order)', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    await announce(key.id);
    // The revocation lands between the confirmation's plan read and its batch.
    const raced = racing(env.DB, () => env.DB.prepare("UPDATE platform_keys SET status = 'revoked', revoked_at = ?2, revoked_by_kind = 'hana', revoked_by = 'x' WHERE id = ?1").bind(key.id, Date.now()).run());
    const jwt = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: key.id, publicKey: r.publicKey, scopes: r.scopes, label: r.label }), { sub: 'owner-sub-2' });
    expect(await no(consoleOn({ DB: raced }).confirmPlatformKey({ ...second(), orgId: r.app.org, keyId: key.id, stepUpJwt: jwt }))).toMatchObject({ code: 'version_conflict' });
    expect(await keyRow(key.id)).toMatchObject({ status: 'revoked', confirmed_at: null });
    // The other order: a confirmed key is still stopped at once.
    const r2 = { ...r, publicKey: await newPublicKey() };
    const k2 = (await ok(memberRegister(r2))).key;
    await announce(k2.id);
    await ok(confirmBy(r2, k2.id, second()));
    expect((await ok(consoleOn().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: k2.id }))).key.state).toBe('revoked');
  });

  it('a confirmation racing a cancel loses to it, and a cancel after the confirmation finds nothing to cancel', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const a = await announce(key.id);
    const raced = racing(env.DB, () => env.DB.prepare("UPDATE platform_keys SET status = 'cancelled', cancelled_at = ?2, cancelled_by_kind = 'link', cancelled_by = 'link' WHERE id = ?1").bind(key.id, Date.now()).run());
    const jwt = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: key.id, publicKey: r.publicKey, scopes: r.scopes, label: r.label }), { sub: 'owner-sub-2' });
    expect(await no(consoleOn({ DB: raced }).confirmPlatformKey({ ...second(), orgId: r.app.org, keyId: key.id, stepUpJwt: jwt }))).toMatchObject({ code: 'version_conflict' });
    expect(await keyRow(key.id)).toMatchObject({ status: 'cancelled', active_from: a.key.activeFrom, confirmed_at: null });
    const r2 = { ...r, publicKey: await newPublicKey() };
    const k2 = (await ok(memberRegister(r2))).key;
    await announce(k2.id);
    await ok(confirmBy(r2, k2.id, second()));
    expect(await no(consoleOn().cancelPlatformKey({ ...member(), orgId: r.app.org, keyId: k2.id }))).toMatchObject({ code: 'not_pending' });
  });

  it('nothing a platform key could present confirms, accepts or registers a key', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    await announce(key.id);
    const platform = { actor: { kind: 'platform', id: key.id }, requestId: rid(), clientIp: '203.0.113.50' };
    const jwt = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: key.id, publicKey: r.publicKey, scopes: r.scopes, label: r.label }));
    // The RPC boundary has no platform actor.
    for (const m of ['confirmPlatformKey', 'acceptPlatformKey'] as const) expect(await no(consoleOn()[m]({ ...platform, orgId: r.app.org, keyId: key.id, stepUpJwt: jwt }))).toMatchObject({ code: 'bad_request' });
    expect(await no(consoleOn().proposePlatformKey({ ...platform, orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: await newPublicKey(), stepUpJwt: jwt }))).toMatchObject({ code: 'bad_request' });
    expect(await no(adminOn().registerPlatformKey({ ...platform, orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: await newPublicKey(), reason: 'x'.repeat(30) }))).toMatchObject({ code: 'bad_request' });
    // And the writers refuse it themselves, whatever a later route passes them.
    const w = { actor: platform.actor, requestId: rid(), now: Date.now() } as unknown as Writer;
    const db = new HotDb(env.DB);
    for (const f of [
      () => confirmPlatformKey(db, env, { ...w }, { orgId: r.app.org, keyId: key.id, stepUpJwt: jwt }),
      () => registerPlatformKey(db, env, { ...w }, { orgId: r.app.org, scopeIds: r.scopes, label: 'x', publicKey: r.publicKey, by: { kind: 'member', stepUpJwt: jwt } }),
      () => cancelPlatformKey(db, { ...w }, { orgId: r.app.org, keyId: key.id }),
    ]) {
      await expect(f()).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect((await keyRow(key.id)).confirmed_at).toBeNull();
    // Nor does staff confirm or accept (the confirmation is an owner's): AdminRpc has no such method.
    expect('confirmPlatformKey' in AdminRpc.prototype).toBe(false);
    expect('acceptPlatformKey' in AdminRpc.prototype).toBe(false);
  });

  it('an unsigned request to the platform API (D927, piece P3) authenticates nothing; no route confirms', async () => {
    for (const [method, path] of [['GET', '/v1/platform/credential'], ['POST', '/v1/platform/credential/revoke']] as const) {
      expect((await call(path, { method, ...(method === 'POST' ? { body: {} } : {}) })).status, path).toBe(401);
    }
    expect((await call('/v1/platform/keys/x/confirm', { method: 'POST', body: {} })).status).toBe(404);
  });
});

// ---- revocation, and what it cancels ----

describe('revocation', () => {
  async function inForce(r: Reg) {
    const { key } = await ok(memberRegister(r));
    await announce(key.id);
    clock.advance(DAY + 1000);
    return key;
  }

  it('by an owner: immediate, cancels the key’s waiting web addresses in the same batch (one change.cancelled row naming the revoker), leaves one in force and another key’s', async () => {
    const r = await setup();
    const key = await inForce(r);
    const other = await inForce({ ...r, publicKey: await newPublicKey() });
    const app2 = await sameScopeApp(r.app);
    const waiting = [await platformProposal(r.app, key.id, 'https://a.partner.example'), await platformProposal(app2, key.id, 'https://b.partner.example')];
    const live = await platformProposal(r.app, key.id, 'https://live.partner.example', { inForce: true });
    const others = await platformProposal(r.app, other.id, 'https://other.partner.example');
    const versions = await rows<{ id: string; origins_version: number }>('SELECT id, origins_version FROM apps WHERE id IN (?1, ?2) ORDER BY id', r.app.id, app2.id);
    const who = member();
    const res = await ok(consoleOn().revokePlatformKey({ ...who, orgId: r.app.org, keyId: key.id, reason: 'Laptop lost' }));
    expect(res.key).toMatchObject({ state: 'revoked', revokedByKind: 'member', revokeReason: 'Laptop lost' });
    const g = await rows<{ id: string; status: string; cancelled_by: string | null }>('SELECT id, status, cancelled_by FROM guarded_changes WHERE id IN (?1, ?2, ?3, ?4) ORDER BY id', ...waiting, live, others);
    const status = Object.fromEntries(g.map((x) => [x.id, x.status]));
    expect(status[waiting[0]!]).toBe('cancelled');
    expect(status[waiting[1]!]).toBe('cancelled');
    expect(status[live]).toBe('active');
    expect(status[others]).toBe('pending');
    expect(await rows('SELECT change_id FROM app_origins WHERE change_id IN (?1, ?2)', ...waiting)).toEqual([]);
    expect(await rows('SELECT change_id FROM app_origins WHERE change_id IN (?1, ?2)', live, others)).toHaveLength(2);
    const [cancelled] = await rows<{ actor_kind: string; actor_id: string; detail_json: string; request_id: string }>("SELECT actor_kind, actor_id, detail_json, request_id FROM app_changes WHERE org_id = ?1 AND kind = 'change.cancelled'", r.app.org);
    expect(cancelled).toMatchObject({ actor_kind: 'member', actor_id: who.actor.id });
    const detail = JSON.parse(cancelled!.detail_json) as { reason: string; keyId: string; changes: { changeId: string }[] };
    expect(detail).toMatchObject({ reason: 'key_revoked', keyId: key.id });
    expect(detail.changes.map((c) => c.changeId).sort()).toEqual([...waiting].sort());
    const [rev] = await ledger(r.app.org, 'platform.key_revoked');
    expect(cancelled!.request_id).toBe(`${rev!.request_id}:cancelled`);
    for (const v of versions) expect((await rows<{ origins_version: number }>('SELECT origins_version FROM apps WHERE id = ?1', v.id))[0]!.origins_version).toBe(v.origins_version + 1);
    // Never reactivated.
    expect(await refusal("UPDATE platform_keys SET status = 'active', revoked_at = NULL WHERE id = ?1", key.id)).toMatch(/never comes back|CHECK/u);
    expect(await no(consoleOn().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).toMatchObject({ code: 'conflict' });
  });

  it('by staff, by the revoke link and by the key itself, each at once and each cancelling what the key left waiting', async () => {
    const r = await setup();
    const staffKey = await inForce(r);
    const p1 = await platformProposal(r.app, staffKey.id, 'https://s.partner.example');
    expect((await ok(adminOn().revokePlatformKey({ ...hana(), orgId: r.app.org, keyId: staffKey.id, reason: 'The network asked us to' }))).key).toMatchObject({ state: 'revoked', revokedByKind: 'hana' });
    expect((await rows<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', p1))[0]!.status).toBe('cancelled');

    // The revoke link (after an owner's confirmation, its notice stored the link).
    const r2 = { ...r, publicKey: await newPublicKey() };
    const k2 = (await ok(memberRegister(r2))).key;
    await announce(k2.id);
    await ok(confirmBy(r2, k2.id, owner('owner-sub-2', 'second@partner.example')));
    const revoke = linkToken();
    await ok(adminOn().ackPlatformKeyConfirmNotice({ ...system(), keyId: k2.id, revokeTokenHash: await revoke.hash }));
    const p2 = await platformProposal(r.app, k2.id, 'https://l.partner.example');
    const byLink = (token: string) => consoleOn().revokePlatformKeyByLink({ actor: { kind: 'link', id: k2.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: k2.id, token });
    expect(await no(byLink(linkToken().token))).toMatchObject({ code: 'forbidden' });
    expect((await ok(byLink(revoke.token))).key.state).toBe('revoked');
    expect((await rows<{ status: string; cancelled_by: string }>('SELECT status, cancelled_by FROM guarded_changes WHERE id = ?1', p2))[0]).toEqual({ status: 'cancelled', cancelled_by: 'link' });
    expect(await no(byLink(revoke.token))).toMatchObject({ code: 'conflict' });

    // The key itself (the platform API's self-revoke calls this writer, D927), only its own id, also with the switch off.
    const r3 = { ...r, publicKey: await newPublicKey() };
    const k3 = await inForce(r3);
    const p3 = await platformProposal(r.app, k3.id, 'https://k.partner.example');
    const self = (id: string, keyId: string) => revokePlatformKey(new HotDb(env.DB), { actor: { kind: 'platform', id }, requestId: rid(), now: Date.now() } as unknown as Writer, { orgId: r.app.org, keyId });
    await expect(self(newId('platformKey'), k3.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await self(k3.id, k3.id)).key.state).toBe('revoked');
    expect((await rows<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', p3))[0]!.status).toBe('cancelled');
    expect((await ledger(r.app.org, 'platform.key_revoked')).map((l) => l.actor_kind).sort()).toEqual(['hana', 'link', 'platform']);
  });

  it('the revoke link works 7 days only', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    await announce(key.id);
    await ok(confirmBy(r, key.id, owner('owner-sub-2', 'second@partner.example')));
    const revoke = linkToken();
    await ok(adminOn().ackPlatformKeyConfirmNotice({ ...system(), keyId: key.id, revokeTokenHash: await revoke.hash }));
    clock.advance(7 * DAY + 1000);
    expect((await no(consoleOn().revokePlatformKeyByLink({ actor: { kind: 'link', id: key.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: key.id, token: revoke.token }))).error).toMatch(/expired/u);
    expect((await keyRow(key.id)).status).toBe('active');
  });

  it('expiry: a year after it came into force the hourly job ends the key and cancels what it left waiting', async () => {
    const r = await setup();
    // A confirmed key (recorded `active` at its confirmation): the expiry ends an `active` key.
    const { key } = await ok(memberRegister(r));
    await announce(key.id);
    await ok(confirmBy(r, key.id, owner('owner-sub-2', 'second@partner.example')));
    const expiresAt = (await keyRow(key.id)).expires_at as number;
    clock.advance(expiresAt - Date.now() - 2 * HOUR);
    const p = await platformProposal(r.app, key.id, 'https://e.partner.example');
    await platformKeysMaintenance(env);
    expect((await keyRow(key.id)).status).toBe('active');
    clock.advance(3 * HOUR);
    expect((await platformKeysMaintenance(env)).expired).toBeGreaterThanOrEqual(1);
    expect(await keyRow(key.id)).toMatchObject({ status: 'expired', end_request_id: `cron:platform:expired:${key.id}` });
    expect((await rows<{ status: string; cancelled_by: string }>('SELECT status, cancelled_by FROM guarded_changes WHERE id = ?1', p))[0]).toEqual({ status: 'cancelled', cancelled_by: 'cron' });
    const [c] = await rows<{ actor_kind: string; detail_json: string }>("SELECT actor_kind, detail_json FROM app_changes WHERE org_id = ?1 AND kind = 'change.cancelled'", r.app.org);
    expect(c!.actor_kind).toBe('system');
    expect(JSON.parse(c!.detail_json)).toMatchObject({ reason: 'key_expired', keyId: key.id });
    expect(await ledger(r.app.org, 'platform.key_expired')).toHaveLength(1);
    expect((await ok(consoleOn().getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('expired');
  });
});

// ---- the switch and the freeze ----

describe('the org’s platform switch and the freeze mirror', () => {
  it('switching off cancels the org’s waiting keys and every waiting platform web address, in one batch; a key in force stays', async () => {
    const r = await setup();
    const live = (await ok(memberRegister(r))).key;
    await announce(live.id);
    clock.advance(DAY + 1000);
    const waiting = (await ok(staffRegister({ ...r, publicKey: await newPublicKey() }))).key;
    const p = await platformProposal(r.app, live.id, 'https://w.partner.example');
    const kept = await platformProposal(r.app, live.id, 'https://in-force.partner.example', { inForce: true });
    const res = await ok(adminOn().setPlatformOrg({ ...hana(), orgId: r.app.org, enabled: false, reason: 'Abuse report' }));
    expect(res.platform).toMatchObject({ enabled: false });
    expect(await keyRow(waiting.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'platform_off', cancelled_by_kind: 'hana' });
    expect((await keyRow(live.id)).status).toBe('pending');
    expect((await rows<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', p))[0]!.status).toBe('cancelled');
    expect((await rows<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', kept))[0]!.status).toBe('active');
    const [sw] = await ledger(r.app.org, 'platform.org_switch');
    expect(JSON.parse(sw!.detail_json)).toMatchObject({ enabled: false, reason: 'Abuse report', cancelledKeys: [waiting.id] });
    const [c] = await rows<{ detail_json: string }>("SELECT detail_json FROM app_changes WHERE org_id = ?1 AND kind = 'change.cancelled'", r.app.org);
    expect(JSON.parse(c!.detail_json)).toMatchObject({ reason: 'platform_off', keyId: null });
  });

  it('switching on needs every key in force or waiting reviewed, checked again at the commit; refused while frozen', async () => {
    const r = await setup();
    const k = (await ok(memberRegister(r))).key;
    const on = (reviewedKeys?: string[]) => adminOn().setPlatformOrg({ ...hana(), orgId: r.app.org, enabled: true, reason: 'Network onboarded', ...(reviewedKeys ? { reviewedKeys } : {}) });
    expect(await no(on())).toMatchObject({ code: 'conflict' });
    expect(await no(on([newId('platformKey')]))).toMatchObject({ code: 'conflict' });
    // A key registered between the review and the commit: the predicate holds the set.
    const raced = racing(env.DB, async () => {
      const r2 = { ...r, publicKey: await newPublicKey() };
      await staffRegister(r2);
    });
    expect(await no(adminOn({ DB: raced }).setPlatformOrg({ ...hana(), orgId: r.app.org, enabled: true, reason: 'x', reviewedKeys: [k.id] }))).toMatchObject({ code: 'version_conflict' });
    const all = (await ok(adminOn().listPlatformKeys({ ...hana(), orgId: r.app.org }))).keys.map((x) => x.id);
    expect((await ok(on(all))).platform.enabled).toBe(true);
    const [sw] = (await ledger(r.app.org, 'platform.org_switch')).slice(-1);
    expect(JSON.parse(sw!.detail_json)).toMatchObject({ enabled: true, reviewedKeys: [...all].sort() });
    expect((await ok(on(all))).changed).toBe(false);
    await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    await ok(adminOn().setPlatformOrg({ ...hana(), orgId: r.app.org, enabled: false, reason: 'Off for the freeze' }));
    expect(await no(on([]))).toMatchObject({ code: 'conflict' });
  });

  it('the freeze mirror cancels waiting keys and the platform’s waiting web addresses; unfreezing restores nothing', async () => {
    const r = await setup();
    const k = (await ok(memberRegister(r))).key;
    await announce(k.id);
    const p = await platformProposal(r.app, k.id, 'https://f.partner.example');
    expect((await ok(adminOn().setPlatformOrgFrozen({ ...system(), orgId: r.app.org, frozen: true }))).changed).toBe(true);
    expect(await keyRow(k.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'org_frozen' });
    expect((await rows<{ status: string }>('SELECT status FROM guarded_changes WHERE id = ?1', p))[0]!.status).toBe('cancelled');
    expect((await ok(adminOn().setPlatformOrgFrozen({ ...system(), orgId: r.app.org, frozen: true }))).changed).toBe(false);
    clock.advance(PLATFORM_UNFREEZE_GRACE_MS + 1000);
    await ok(adminOn().setPlatformOrgFrozen({ ...system(), orgId: r.app.org, frozen: false }));
    expect((await keyRow(k.id)).status).toBe('cancelled');
    expect((await ok(adminOn().platformOrgs({ ...system(), limit: 500 }))).orgs.find((o) => o.orgId === r.app.org)).toMatchObject({ orgId: r.app.org, enabled: false, frozen: false });
  });

  it('platformOrgs pages in id order with a cursor until the end', async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await ok(adminOn().platformOrgs({ ...system(), limit: 2, ...(cursor ? { cursor } : {}) }));
      all.push(...page.orgs.map((o) => o.orgId));
      if (!page.next) break;
      cursor = page.next;
    }
    const direct = (await rows<{ org_id: string }>('SELECT org_id FROM platform_orgs ORDER BY org_id')).map((r) => r.org_id);
    expect(all).toEqual(direct);
  });

  it('a frozen org keeps its kill switches: revoke and cancel still work', async () => {
    const r = await setup();
    const k = (await ok(memberRegister(r))).key;
    await announce(k.id);
    clock.advance(DAY + 1000);
    await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    expect((await ok(consoleOn().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: k.id }))).key.state).toBe('revoked');
  });
});

// ---- notices and the lapse ----

describe('the notices’ page and acks', () => {
  it('lists each kind once: announce, confirmed (then its revoke link), ended (with what it cancelled and the keys still waiting), the expiry warnings', async () => {
    const r = await setup();
    const page = async () => (await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.orgId === r.app.org);
    const k = (await ok(memberRegister(r))).key;
    expect((await page()).map((n) => n.kind)).toEqual(['announce']);
    expect((await page())[0]!.contacts).toEqual(['security@partner.example']);
    await announce(k.id);
    expect(await page()).toEqual([]);
    await ok(confirmBy(r, k.id, owner('owner-sub-2', 'second@partner.example')));
    expect((await page()).map((n) => n.kind)).toEqual(['confirmed']);
    await ok(adminOn().ackPlatformKeyConfirmNotice({ ...system(), keyId: k.id, revokeTokenHash: await linkToken().hash }));
    expect(await no(adminOn().ackPlatformKeyConfirmNotice({ ...system(), keyId: k.id, revokeTokenHash: await linkToken().hash }))).toMatchObject({ code: 'not_pending' });
    expect(await page()).toEqual([]);
    // The expiry warnings: 30 days before, then 7 (never the 30 after the 7).
    clock.advance(PLATFORM_KEY_LIFETIME_MS - 29 * DAY);
    expect((await page()).map((n) => [n.kind, n.stage])).toEqual([['expiring', 30]]);
    await ok(adminOn().ackPlatformKeyExpiryNotice({ ...system(), keyId: k.id, stage: 30 }));
    expect(await page()).toEqual([]);
    clock.advance(23 * DAY);
    expect((await page()).map((n) => [n.kind, n.stage])).toEqual([['expiring', 7]]);
    await ok(adminOn().ackPlatformKeyExpiryNotice({ ...system(), keyId: k.id, stage: 7 }));
    expect(await no(adminOn().ackPlatformKeyExpiryNotice({ ...system(), keyId: k.id, stage: 30 }))).toMatchObject({ code: 'not_pending' });
    // Revoked: the end notice lists the waiting address it cancelled and the org's other waiting key.
    const waiting = (await ok(staffRegister({ ...r, publicKey: await newPublicKey() }))).key;
    await platformProposal(r.app, k.id, 'https://n.partner.example');
    await ok(adminOn().revokePlatformKey({ ...hana(), orgId: r.app.org, keyId: k.id, reason: 'Rotated' }));
    const [ended] = (await page()).filter((n) => n.kind === 'ended');
    expect(ended!.cancelledOrigins).toEqual([{ appId: r.app.id, appName: expect.any(String), origin: 'https://n.partner.example' }]);
    expect(ended!.waitingKeys).toEqual([{ id: waiting.id, label: r.label, announced: false }]);
    await ok(adminOn().ackPlatformKeyEndNotice({ ...system(), keyId: k.id }));
    expect((await page()).filter((n) => n.kind === 'ended')).toEqual([]);
    // The acks are the system's only.
    expect(await no(adminOn().ackPlatformKeyEndNotice({ ...hana(), keyId: k.id }))).toMatchObject({ code: 'forbidden' });
  });

  it('a key not accepted, or not announced, within 7 days lapses (cancelled by the system)', async () => {
    const r = await setup();
    const s = (await ok(staffRegister(r))).key;
    const m = (await ok(memberRegister({ ...r, publicKey: await newPublicKey() }))).key;
    clock.advance(7 * DAY + 1000);
    expect((await platformKeysMaintenance(env)).lapsed).toBeGreaterThanOrEqual(2);
    expect(await keyRow(s.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'not_accepted', cancelled_by_kind: 'system' });
    expect(await keyRow(m.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'not_announced' });
  });
});

describe('the console’s hot-DB budget', () => {
  it('each ConsoleRpc platform key method stays within CONSOLE_DB_LIMITS and its cost', async () => {
    const r = await setup();
    const count = (): DbCount => ({ reads: 0, batches: 0, statements: 0 });
    const run = async <T>(name: keyof typeof CONSOLE_COSTS, f: (rpc: ConsoleRpc) => Promise<T>): Promise<T> => {
      const c = count();
      const out = await f(counted((ctx, e) => new ConsoleRpc(ctx, e), c));
      expect(c.statements, name).toBeLessThanOrEqual(CONSOLE_COSTS[name]);
      expect(c.reads, name).toBeLessThanOrEqual(2);
      expect(c.batches, name).toBeLessThanOrEqual(1);
      return out;
    };
    const jwt = await stepUp(await digest('add', { orgId: r.app.org, publicKey: r.publicKey, scopes: r.scopes, label: r.label }));
    const { key } = await ok(run('proposePlatformKey', (rpc) => rpc.proposePlatformKey({ ...member(), orgId: r.app.org, scopeIds: r.scopes, label: r.label, publicKey: r.publicKey, stepUpJwt: jwt })));
    await ok(run('listPlatformKeys', (rpc) => rpc.listPlatformKeys({ ...member(), orgId: r.app.org })));
    await ok(run('getPlatformKey', (rpc) => rpc.getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id })));
    const a = await announce(key.id);
    const cj = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: key.id, publicKey: r.publicKey, scopes: r.scopes, label: r.label }));
    await ok(run('confirmPlatformKey', (rpc) => rpc.confirmPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id, stepUpJwt: cj })));
    await platformProposal(r.app, key.id, 'https://budget.partner.example');
    await ok(run('revokePlatformKey', (rpc) => rpc.revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id })));
    const k2 = (await ok(memberRegister({ ...r, publicKey: await newPublicKey() }))).key;
    await ok(run('cancelPlatformKey', (rpc) => rpc.cancelPlatformKey({ ...member(), orgId: r.app.org, keyId: k2.id })));
    const sKey = await newPublicKey();
    const s = (await ok(staffRegister({ ...r, publicKey: sKey }))).key;
    const aj = await stepUp(await digest('accept', { orgId: r.app.org, keyId: s.id, publicKey: sKey, scopes: r.scopes, label: r.label }));
    await ok(run('acceptPlatformKey', (rpc) => rpc.acceptPlatformKey({ ...member(), orgId: r.app.org, keyId: s.id, stepUpJwt: aj })));
    const sa = await announce(s.id, { atOnce: true });
    await ok(run('revokePlatformKeyByLink', (rpc) => rpc.revokePlatformKeyByLink({ actor: { kind: 'link', id: s.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: s.id, token: sa.revoke })));
    const k3 = (await ok(memberRegister({ ...r, publicKey: await newPublicKey() }))).key;
    const a3 = await announce(k3.id);
    await ok(run('cancelPlatformKeyByLink', (rpc) => rpc.cancelPlatformKeyByLink({ actor: { kind: 'link', id: k3.id }, requestId: rid(), clientIp: '203.0.113.9', keyId: k3.id, token: a3.cancel })));
    expect(a.cancel).toBeTruthy();
    expect(CONSOLE_ERROR_STATUS.org_frozen).toBe(403);
    expect(ORIGIN).toBeTruthy();
  });
});

/** D1's own clock (ms), which the announcement and activation triggers read. */
async function dbNow(): Promise<number> {
  return (await env.DB.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t").first<{ t: number }>())!.t;
}

/** A member's key written straight to D1 (as the API would, or as a bare writer might), with `o` over the columns. */
async function bareKey(r: Reg, o: Record<string, unknown> = {}): Promise<{ id: string }> {
  const p = await parsePlatformPublicKey(await newPublicKey());
  if (!p.ok) throw new Error(p.problem);
  const id = newId('platformKey');
  await env.DB.prepare(
    `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
     VALUES (?1, ?2, 'Bare', 'ES256', ?3, ?4, ?5, 'pending', 'member', 'usr_bare', 'sub-bare', 'bare@partner.example', ?6, 0, ?7, ?8)`,
  )
    .bind(id, r.app.org, p.key.raw, p.key.thumbprint, JSON.stringify(r.scopes), Date.now(), (o.min_delay_ms as number | undefined) ?? DAY, `r_${id}`)
    .run();
  const rest = Object.entries(o).filter(([k]) => k !== 'min_delay_ms');
  if (rest.length) await env.DB.prepare(`UPDATE platform_keys SET ${rest.map(([k], i) => `${k} = ?${i + 2}`).join(', ')} WHERE id = ?1`).bind(id, ...rest.map(([, v]) => v)).run();
  return { id };
}

/** A second app on `of`'s scope (a direct insert: the scope already belongs to the org). */
async function sameScopeApp(of: OrgApp): Promise<OrgApp> {
  const id = `app_${newId('app').slice(4)}`;
  const key = `pk_test_${newId('app').slice(4)}${newId('app').slice(4)}`;
  await env.DB.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'free')").bind(id, `Second ${id}`, of.scope, of.org, key).run();
  return { ...of, id, key };
}

/** A hot DB whose first batch runs `before()` first (a write landing between a plan read and its batch). */
function racing(base: D1Database, before: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(base, {
    get(t, p) {
      if (p === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await before();
          }
          return t.batch(stmts);
        };
      }
      const v: unknown = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

describe('after PR 149’s review', () => {
  it('four eyes on any network but testnet, a missing one included (finding 6)', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r, { rpc: consoleOn({ NETWORK: 'devnet', APP_CHANGE_DELAY_MS: String(DAY) }) }));
    expect(await keyRow(key.id)).toMatchObject({ four_eyes: 1, min_delay_ms: DAY });
    expect(fourEyesEnv({ NETWORK: undefined })).toBe(true);
  });

  it('an owner’s stop is never refused by the breaker or the budget (finding 7)', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    await announce(key.id);
    // Fill the org's breaker hour with destructive calls (5 suspensions of 5 apps), and its bucket with reads.
    const apps = [r.app, ...(await Promise.all([1, 2, 3, 4, 5].map(() => sameScopeApp(r.app))))];
    let refused: { code?: string } | undefined;
    for (const a of apps) {
      const res = await consoleOn().setSuspended({ ...member(), orgId: r.app.org, appId: a.id, suspended: true });
      if (!res.ok) refused = res;
    }
    expect(refused).toMatchObject({ code: 'rate_limited' });
    for (let k = 0; k < 60; k++) await consoleOn().listApps({ ...member(), orgId: r.app.org });
    expect((await ok(consoleOn().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('revoked');
  });

  it('a security-contact change after the registration holds its announcement for 7 days (finding 8)', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    await ok(adminOn().setSecurityContacts({ ...hana(), orgId: r.app.org, emails: ['new-contact@partner.example'] }));
    expect((await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.id === key.id)).toEqual([]);
    expect(await no(adminOn().ackPlatformKeyNotice({ ...system(), keyId: key.id, cancelTokenHash: await linkToken().hash }))).toMatchObject({ code: 'conflict' });
    clock.advance(7 * DAY + 1000);
    expect((await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.id === key.id).map((n) => n.kind)).toEqual(['announce']);
  });

  it('a notice whose sends keep failing waits longer each time and comes after every other (finding 11)', async () => {
    const r = await setup();
    const a = (await ok(memberRegister(r))).key;
    const b = (await ok(memberRegister({ ...r, publicKey: await newPublicKey() }))).key;
    const page = async () => (await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.orgId === r.app.org).map((n) => n.key.id);
    expect(await page()).toEqual([a.id, b.id]);
    expect(await ok(adminOn().notePlatformKeyNoticeFailure({ ...system(), keyId: a.id }))).toMatchObject({ failures: 1 });
    expect(await page()).toEqual([b.id]);
    clock.advance(5 * 60_000 + 1000);
    expect(await page()).toEqual([b.id, a.id]);
    await ok(adminOn().notePlatformKeyNoticeFailure({ ...system(), keyId: a.id }));
    clock.advance(5 * 60_000 + 1000);
    expect(await page()).toEqual([b.id]);
    clock.advance(5 * 60_000);
    expect(await page()).toEqual([b.id, a.id]);
    await announce(a.id);
    expect(await keyRow(a.id)).toMatchObject({ notice_failures: 0, notice_failed_at: null });
    expect(await no(adminOn().notePlatformKeyNoticeFailure({ ...hana(), keyId: a.id }))).toMatchObject({ code: 'forbidden' });
  });

  it('a confirmation racing a switch-off or a freeze loses (nothing confirmed, the key cancelled)', async () => {
    for (const race of ['off', 'freeze'] as const) {
      const r = await setup();
      const { key } = await ok(memberRegister(r));
      await announce(key.id);
      const raced = racing(env.DB, () =>
        race === 'off' ? adminOn().setPlatformOrg({ ...hana(), orgId: r.app.org, enabled: false, reason: 'Race' }) : adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }),
      );
      const jwt = await stepUp(await digest('confirm', { orgId: r.app.org, keyId: key.id, publicKey: r.publicKey, scopes: r.scopes, label: r.label }), { sub: 'owner-sub-2' });
      expect(await no(consoleOn({ DB: raced }).confirmPlatformKey({ ...owner('owner-sub-2', 'second@partner.example'), orgId: r.app.org, keyId: key.id, stepUpJwt: jwt })), race).toMatchObject({ code: 'version_conflict' });
      expect(await keyRow(key.id), race).toMatchObject({ status: 'cancelled', confirmed_at: null });
    }
  });

  it('the freeze mirror’s unfreeze is a compare-and-swap on the row’s version (finding 4)', async () => {
    const r = await setup();
    await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    clock.advance(PLATFORM_UNFREEZE_GRACE_MS + 1000);
    const active = Date.now();
    const v = (await ok(adminOn().platformOrgs({ ...system(), limit: 500 }))).orgs.find((o) => o.orgId === r.app.org)!.version;
    expect(await no(adminOn().setPlatformOrgFrozen({ ...system(), orgId: r.app.org, frozen: false, expectedVersion: v - 1 }))).toMatchObject({ code: 'version_conflict' });
    // A write between the read and the batch moves the version: the unfreeze writes nothing.
    const raced = racing(env.DB, () => env.DB.prepare('UPDATE platform_orgs SET version = version + 1 WHERE org_id = ?1').bind(r.app.org).run());
    expect(await no(adminOn({ DB: raced }).setPlatformOrgFrozen({ ...system(), orgId: r.app.org, frozen: false, expectedVersion: v }))).toMatchObject({ code: 'version_conflict' });
    expect(await env.DB.prepare('SELECT frozen FROM platform_orgs WHERE org_id = ?1').bind(r.app.org).first()).toEqual({ frozen: 1 });
    expect((await ok(adminOn().setPlatformOrgFrozen({ ...system(), orgId: r.app.org, frozen: false, expectedVersion: v + 1 }))).changed).toBe(true);
  });

  it('the mirror’s unfreeze rule: refused inside the grace after the latest freeze (whoever asks), which every freeze restarts; a freeze racing it wins (second review)', async () => {
    const r = await setup();
    const row = () => env.DB.prepare('SELECT frozen, frozen_at, version FROM platform_orgs WHERE org_id = ?1').bind(r.app.org).first<{ frozen: number; frozen_at: number; version: number }>();
    expect((await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: false }))).changed).toBe(false); // nothing frozen
    await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    const first = (await row())!;
    // A second freeze finds the row frozen and still writes its time: the grace runs from the latest freeze.
    clock.advance(PLATFORM_UNFREEZE_GRACE_MS - 1000);
    await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    const again = (await row())!;
    expect(again).toMatchObject({ frozen: 1, frozen_at: first.frozen_at + PLATFORM_UNFREEZE_GRACE_MS - 1000, version: first.version + 1 });
    clock.advance(2000);
    for (const who of [hana(), system()]) expect(await no(adminOn().setPlatformOrgFrozen({ ...who, orgId: r.app.org, frozen: false })), who.actor.kind).toMatchObject({ code: 'conflict' });
    // Past the grace, a freeze landing between the unfreeze's read and its batch: the commit predicate sees its newer time.
    clock.advance(PLATFORM_UNFREEZE_GRACE_MS);
    const raced = racing(env.DB, () => adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: true }));
    expect(await no(adminOn({ DB: raced }).setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: false }))).toMatchObject({ code: 'version_conflict' });
    expect((await row())!.frozen).toBe(1);
    // Past the grace after that freeze, with nothing racing: unfrozen, by staff as by the check.
    clock.advance(PLATFORM_UNFREEZE_GRACE_MS + 1000);
    expect((await ok(adminOn().setPlatformOrgFrozen({ ...hana(), orgId: r.app.org, frozen: false }))).changed).toBe(true);
    expect((await row())!.frozen).toBe(0);
  });

  it('the console view says whether this member counts as the registrant for four eyes (finding 10)', async () => {
    const r = await setup();
    const { key } = await ok(staffRegister(r, { rpc: adminOn(MAINNET) }));
    expect((await ok(consoleOn().getPlatformKey({ ...owner('owner-sub-2', 'Staff.1+x@hana.example'), orgId: r.app.org, keyId: key.id }))).key.registeredByYou).toBe(true);
    expect((await ok(consoleOn().getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.registeredByYou).toBe(false);
  });
});

describe('an owner’s stop: its own limits, never the shared budget (after PR 149’s automated findings)', () => {
  /** ConsoleRpc without the 2 s per call (the limits' minute windows stay put), over `e`. */
  const still = (e: Partial<Env> = {}) => new ConsoleRpc(createExecutionContext(), { ...env, ...e } as Env);
  const fresh = () => newId('platformKey');

  it('one org exhausting its own stop limits never stops another org’s owner; a member’s limit stops only that member', async () => {
    const a = await setup();
    const b = await setup();
    const { key: bKey } = await ok(memberRegister(b));
    const [a1, a2, a3] = [newId('user'), newId('user'), newId('user')];
    const by = (id: string) => owner('owner-sub-1', 'owner@partner.example', id);
    for (let k = 0; k < 20; k++) expect((await no(still().revokePlatformKey({ ...by(a1), orgId: a.app.org, keyId: fresh() }))).code).toBe('not_found');
    expect(await no(still().revokePlatformKey({ ...by(a1), orgId: a.app.org, keyId: fresh() }))).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/from you/u) });
    for (let k = 0; k < 20; k++) expect((await no(still().revokePlatformKey({ ...by(a2), orgId: a.app.org, keyId: fresh() }))).code).toBe('not_found');
    expect(await no(still().revokePlatformKey({ ...by(a3), orgId: a.app.org, keyId: fresh() }))).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/organisation/u) });
    // Org b's owner (the same person id as org a's, even) stops b's key at once.
    expect((await ok(still().revokePlatformKey({ ...member(), orgId: b.app.org, keyId: bKey.id }))).key.state).toBe('revoked');
    // The limits are their own: the console's shared budget and breaker were never drawn on.
    expect(REVOKE_LIMITS.perMember[0].max).toBe(20);
  });

  it('a repeat that changes nothing is answered without the database, from the key’s marker, for 15 minutes', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    const on = () => still({ DB: countingDb(env.DB, count) });
    const ghost = fresh();
    expect((await no(on().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: ghost }))).code).toBe('not_found');
    expect(count.reads).toBeGreaterThan(0);
    count.reads = 0;
    expect((await no(on().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: ghost }))).code).toBe('not_found');
    expect(count).toMatchObject({ reads: 0, batches: 0 });
    // A real stop, then its repeats: one read for the first `conflict`, none after.
    expect((await ok(on().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('revoked');
    count.reads = 0;
    count.batches = 0;
    expect((await no(on().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).code).toBe('conflict');
    expect(count.batches).toBe(0);
    count.reads = 0;
    expect((await no(on().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).code).toBe('conflict');
    expect(count).toMatchObject({ reads: 0, batches: 0 });
    // The marker is the org's: the same id in another org is read afresh.
    const other = await setup();
    count.reads = 0;
    expect((await no(on().revokePlatformKey({ ...member(), orgId: other.app.org, keyId: ghost }))).code).toBe('not_found');
    expect(count.reads).toBeGreaterThan(0);
  });

  it('past the global ceiling on no-ops a no-op answers rate_limited at error level; a stop that changes something still goes through', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void errors.push(String(l)));
    const now = Date.now();
    const g = placedStub(env, env.RATE_LIMITER, 'pk-revoke:global');
    for (let k = 0; k < REVOKE_LIMITS.noopGlobal[0].max; k++) await g.hit([...REVOKE_LIMITS.noopGlobal], now);
    expect(await no(still().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: fresh() }))).toMatchObject({ code: 'rate_limited' });
    expect(errors.some((l) => l.includes('revoke_noop_flood'))).toBe(true);
    expect((await ok(still().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('revoked');
  });

  it('if the stop’s own limiter can’t answer, the stop goes ahead, logged at error level (second review, finding 4)', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void errors.push(String(l)));
    const broken = { idFromName: () => ({}), get: () => new Proxy({}, { get: () => () => Promise.reject(new Error('limiter down')) }) } as unknown as Env['RATE_LIMITER'];
    expect((await ok(still({ RATE_LIMITER: broken }).revokePlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key.state).toBe('revoked');
    expect(errors.some((l) => l.includes('revoke_limiter_failed'))).toBe(true);
  });

  it('a burst of stops in an org is an alert, never a refusal', async () => {
    const r = await setup();
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((l: unknown) => void warns.push(String(l)));
    const ids = [await bareKey(r), await bareKey(r), await bareKey(r), await bareKey(r)];
    for (const { id } of ids) expect((await ok(still().revokePlatformKey({ ...member(), orgId: r.app.org, keyId: id }))).key.state).toBe('revoked');
    expect(warns.some((l) => l.includes('platform_key_revoke_burst') && l.includes(r.app.org))).toBe(true);
  });
});

describe('the hold after a security-contact change and the lapse (second review, finding 3)', () => {
  const contacts = (r: Reg, email: string) => ok(adminOn().setSecurityContacts({ ...hana(), orgId: r.app.org, emails: [email] }));
  const onPage = async (id: string) => (await ok(adminOn().platformKeyNotices({ ...system(), limit: 100 }))).notices.filter((n) => n.key.id === id).map((n) => n.kind);

  it('a contact change on day 3 holds the key until day 10, shown on its page; it is announced then, not cancelled', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    clock.advance(3 * DAY);
    await contacts(r, 'day3@partner.example');
    const view = async () => (await ok(consoleOn().getPlatformKey({ ...member(), orgId: r.app.org, keyId: key.id }))).key;
    const held = (await view()).heldUntil!;
    expect(held).toBeGreaterThan(Date.now() + 7 * DAY - 60_000);
    // Day 9: the old 7-day lapse would have cancelled it; it waits.
    clock.advance(6 * DAY);
    await platformKeysMaintenance(env);
    expect((await keyRow(key.id)).status).toBe('pending');
    expect(await onPage(key.id)).toEqual([]);
    // Day 10, past the hold: on the notices page, and announced.
    clock.advance(held + 60_000 - Date.now());
    await platformKeysMaintenance(env);
    expect((await keyRow(key.id)).status).toBe('pending');
    expect((await view()).heldUntil).toBeUndefined();
    expect(await onPage(key.id)).toEqual(['announce']);
    await announce(key.id);
    expect((await keyRow(key.id)).notified_at).not.toBeNull();
  });

  it('a key not announced 7 days after its hold ends lapses then; repeated contact changes hold it 28 days at most', async () => {
    const r = await setup();
    const { key } = await ok(memberRegister(r));
    clock.advance(2 * DAY);
    await contacts(r, 'a@partner.example');
    // The hold ends on day 9; the lapse is day 16: a day before, nothing; after, cancelled.
    clock.advance(13 * DAY);
    await platformKeysMaintenance(env);
    expect((await keyRow(key.id)).status).toBe('pending');
    clock.advance(DAY + 60_000);
    await platformKeysMaintenance(env);
    expect(await keyRow(key.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'not_announced' });

    const s = await setup();
    const k2 = (await ok(memberRegister(s))).key;
    // A change every 6 days keeps it held: it lapses 28 days after its registration all the same.
    for (let d = 0; d < 4; d++) {
      clock.advance(6 * DAY);
      await contacts(s, `c${d}@partner.example`);
      await platformKeysMaintenance(env);
      expect((await keyRow(k2.id)).status, `day ${(d + 1) * 6}`).toBe('pending');
    }
    clock.advance(4 * DAY + 60_000);
    await platformKeysMaintenance(env);
    expect(await keyRow(k2.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'not_announced' });
  });
});
