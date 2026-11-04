// The wallet directory (D310, D312–D315): POST /v1/wallets/record (the vault's signed report), the identities kept
// current after /v1/login and the link relays, and the AdminRpc / ConsoleRpc reads. Migration 0011's tables.
import { uid as uidOf, userIdOf, supportIdOf } from '@hana-id/console-core';
import { deriveAddresses, withChainKey } from '@hana-id/core/derivation';
import { type WalletRecordChain, signWalletRecord, walletRecordStatement } from '@hana-id/core/wallet-record';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex } from '../src/bytes.ts';
import { syncAccount, syncAfterLogin } from '../src/directory/sync.ts';
import { linkChangeNonce, linkAccountNonce, linkNewNonce } from '../src/session-crypto.ts';
import { emailAud, emailEnv, emailToken, ikSync, setLoginMethods, withEmail } from './email-helpers.ts';
import { bytes, call, chain, google, newSessionKey, seedApp, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { adminRpc, consoleRpc, member, newOrg, orgApp, rid } from './rpc-helpers.ts';
import { HOUR, VAULT, pathFor, spentSession, vaultHeaders } from './vault-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const G_SUB = '1234567890';
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const randomPrk = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

interface RecordOpts {
  prk?: Uint8Array;
  path?: string;
  /** Sign the records for this path / env / app / session key instead (the body still says `path`). */
  signPath?: string;
  signEnv?: string;
  signApp?: string;
  signSpk?: number[];
  issuedAtMs?: number;
  /** Swap one chain's address for another wallet's, keeping the signature. */
  otherAddress?: WalletRecordChain;
  mutate?: (b: Record<string, unknown>) => void;
}

/** A POST /v1/wallets/record body as the vault makes it: each address signed by its own key. */
function recordBody(app: { id: string; scope: string }, spk: number[], o: RecordOpts = {}): Record<string, unknown> {
  const prk = o.prk ?? randomPrk();
  const addresses = deriveAddresses(prk);
  const path = o.path ?? pathFor(app.scope);
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const ctx = { env: o.signEnv ?? env.ENV_NAME, signer: env.SIGNER_ACCOUNT, appId: o.signApp ?? app.id, scopeId: app.scope, path: o.signPath ?? path, sessionPublicKey: Uint8Array.from(o.signSpk ?? spk), issuedAtMs };
  const wallets: Record<string, { address: string; signature: number[] }> = {};
  for (const c of ['stellar', 'evm'] as const) {
    wallets[c] = { address: addresses[c], signature: [...withChainKey(prk, c, 0, (k) => signWalletRecord(c, k, walletRecordStatement(ctx, c, addresses[c])))] };
  }
  if (o.otherAddress) wallets[o.otherAddress]!.address = deriveAddresses(randomPrk())[o.otherAddress];
  const b: Record<string, unknown> = { sessionPublicKey: spk, issuedAtMs, path, wallets };
  o.mutate?.(b);
  return b;
}

const record = (app: { id: string; key: string; scope: string }, spk: number[], o: RecordOpts & { headers?: Record<string, string>; env?: Partial<typeof env> } = {}) =>
  call('/v1/wallets/record', { headers: o.headers ?? vaultHeaders(app), body: recordBody(app, spk, o), env: o.env });

async function expectedUserId(scope: string, provider: string, sub: string): Promise<string> {
  return userIdOf(await uidOf(Uint8Array.from(atob(env.USER_ID_KEY!), (c) => c.charCodeAt(0)), { scopeId: scope, provider, sub }));
}

const users = (scope: string) => env.DB.prepare('SELECT * FROM end_users WHERE scope_id = ?1').bind(scope).all<Record<string, unknown>>().then((r) => r.results);
const wallets = (userId: string) => env.DB.prepare('SELECT chain, address, key_index, first_seen_at, last_used_at FROM end_user_wallets WHERE user_id = ?1 ORDER BY chain DESC').bind(userId).all<Record<string, unknown>>().then((r) => r.results);
const identities = (scope: string) =>
  env.DB.prepare('SELECT identity_key, user_id, provider, sub, role, status, effective_at FROM end_user_identities WHERE scope_id = ?1 ORDER BY role DESC, provider').bind(scope).all<Record<string, unknown>>().then((r) => r.results);

async function recorded(o: { sub?: string } = {}) {
  const near = chain();
  const app = await seedApp();
  const spk = spentSession(near, app.scope, o.sub ? { sub: o.sub } : {});
  return { near, app, spk };
}

describe('POST /v1/wallets/record', () => {
  it('stores the user (its uid), both wallets and the root identity, for the vault only', async () => {
    const { app, spk } = await recorded();
    const prk = randomPrk();
    const res = await record(app, spk, { prk });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(VAULT);
    const b = await body(res);
    expect(Object.keys(b).sort()).toEqual(['recorded', 'requestId']);
    const userId = await expectedUserId(app.scope, 'google', G_SUB);
    const [u] = await users(app.scope);
    expect(u).toMatchObject({ user_id: userId, support_code: supportIdOf(userId).replace(/HANA-|-/gu, '') });
    const a = deriveAddresses(prk);
    expect((await wallets(userId)).map((w) => [w.chain, w.address, w.key_index])).toEqual([
      ['stellar', a.stellar, 0],
      ['evm', a.evm, 0],
    ]);
    expect(await identities(app.scope)).toEqual([expect.objectContaining({ user_id: userId, provider: 'google', sub: G_SUB, role: 'root', status: 'active', identity_key: ikSync(app.scope, 'google', G_SUB) })]);
  });

  it('is idempotent and ordered: a replay changes nothing, an older record never moves last-used back', async () => {
    const { app, spk } = await recorded();
    const prk = randomPrk();
    const now = Date.now();
    expect((await record(app, spk, { prk, issuedAtMs: now })).status).toBe(200);
    expect((await record(app, spk, { prk, issuedAtMs: now })).status).toBe(200);
    expect((await record(app, spk, { prk, issuedAtMs: now - 60_000 })).status).toBe(200);
    expect((await record(app, spk, { prk, issuedAtMs: now - 30_000 })).status).toBe(200);
    const userId = await expectedUserId(app.scope, 'google', G_SUB);
    const rows = await wallets(userId);
    expect(rows).toHaveLength(2);
    for (const w of rows) expect([w.first_seen_at, w.last_used_at]).toEqual([now - 60_000, now]);
    const [u] = await users(app.scope);
    expect([u!.created_at, u!.last_seen_at]).toEqual([now - 60_000, now]);
  });

  it('refuses a forged or mismatched record, writing nothing', async () => {
    const { app, spk } = await recorded();
    const cases: [string, RecordOpts][] = [
      ['another wallet’s address', { otherAddress: 'evm' }],
      ['another wallet’s Stellar address', { otherAddress: 'stellar' }],
      ['signed for another app', { signApp: 'app_Other' }],
      ['signed for another env', { signEnv: 'sandbox-dev' }],
      ['signed for another session', { signSpk: newSessionKey() }],
      ['signed for another path', { signPath: `${app.scope}#google#999#0` }],
      ['a flipped signature', { mutate: (b) => ((b.wallets as { stellar: { signature: number[] } }).stellar.signature[3]! ^= 1) }],
    ];
    for (const [what, o] of cases) {
      const res = await record(app, spk, o);
      expect([res.status, (await body(res)).code], what).toEqual([400, 'bad_wallet_record']);
    }
    expect(await users(app.scope)).toEqual([]);
  });

  it('refuses another session’s path, a dead session and a session of another scope', async () => {
    const { near, app, spk } = await recorded();
    // The records are genuine for the body's path, but the session is on another path.
    const other = `${app.scope}#google#someone-else#0`;
    const mismatch = await record(app, spk, { path: other });
    expect([mismatch.status, (await body(mismatch)).code]).toEqual([403, 'session_mismatch']);
    const dead = await record(app, newSessionKey());
    expect([dead.status, (await body(dead)).code, (await body(await record(app, newSessionKey()))).reason]).toEqual([410, 'session_ended', 'no_session']);
    const elsewhere = await seedApp();
    const spk2 = spentSession(near, elsewhere.scope);
    const scoped = await record(app, spk2, { path: pathFor(app.scope) });
    expect([scoped.status, (await body(scoped)).code]).toEqual([403, 'scope_mismatch']);
    expect(await users(app.scope)).toEqual([]);
  });

  it('refuses a stale or future record, a path outside the scope and a malformed or oversized body', async () => {
    const { app, spk } = await recorded();
    const stale = await record(app, spk, { issuedAtMs: Date.now() - 6 * 60_000 });
    expect([stale.status, (await body(stale)).code]).toEqual([400, 'stale_record']);
    const future = await record(app, spk, { issuedAtMs: Date.now() + 6 * 60_000 });
    expect((await body(future)).code).toBe('stale_record');
    const outside = await record(app, spk, { path: `s999#google#${G_SUB}#0`, signPath: pathFor(app.scope) });
    expect([outside.status, (await body(outside)).code]).toEqual([400, 'bad_request']);
    for (const mutate of [(b: Record<string, unknown>) => (b.extra = 1), (b: Record<string, unknown>) => delete b.path, (b: Record<string, unknown>) => (b.sessionPublicKey = [1, 2])]) {
      const res = await record(app, spk, { mutate });
      expect([res.status, (await body(res)).code]).toEqual([400, 'bad_request']);
    }
    const big = await call('/v1/wallets/record', { headers: vaultHeaders(app), rawBody: JSON.stringify({ pad: 'x'.repeat(5000) }) });
    expect(big.status).toBe(413);
  });

  it('takes only the vault origin with an allowed parent', async () => {
    const { app, spk } = await recorded();
    for (const headers of [vaultHeaders(app, 'https://evil.example'), vaultHeaders(app, undefined, 'https://wallet.example.com'), { origin: VAULT }]) {
      const res = await record(app, spk, { headers });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const preflight = await call('/v1/wallets/record', { method: 'OPTIONS', headers: { origin: 'https://wallet.example.com' } });
    expect(preflight.status).toBe(403);
    expect(await users(app.scope)).toEqual([]);
  });

  it('without USER_ID_KEY answers 503 directory_unavailable and writes nothing', async () => {
    const { app, spk } = await recorded();
    const res = await record(app, spk, { env: { USER_ID_KEY: undefined } });
    expect([res.status, (await body(res)).code]).toEqual([503, 'directory_unavailable']);
    expect(await users(app.scope)).toEqual([]);
  });

  it('records a linked member’s wallet under its account root (the session path is the root’s)', async () => {
    const { app, spk } = await recorded({ sub: 'root-sub' });
    expect((await record(app, spk, { path: pathFor(app.scope, 'root-sub') })).status).toBe(200);
    const [u] = await users(app.scope);
    expect(u!.user_id).toBe(await expectedUserId(app.scope, 'google', 'root-sub'));
  });
});

// ---- identities kept current ----

async function linkSetup() {
  const app = await seedApp();
  const aud = `${uid()}.apps.googleusercontent.com`;
  const near = withEmail(withCombinedCall(chain({ [aud]: app.scope })), [app.scope]);
  await setLoginMethods(app.id, 'google,email');
  near.identities.set(`google#${G_SUB}`, { status: 'own', opened: true });
  return { app, aud, near };
}
const linkCall = (path: string, app: { key: string }, req: unknown) => call(path, { headers: hanaHeaders(app), body: req, env: emailEnv() });
const salt = bytes(16, 9);

describe('identities after /v1/login and the link relays', () => {
  it('a plain login writes the user and its root identity, from the login’s own chain read', async () => {
    const { app, aud } = await linkSetup();
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const userId = await expectedUserId(app.scope, 'google', G_SUB);
    expect((await users(app.scope)).map((u) => u.user_id)).toEqual([userId]);
    expect(await identities(app.scope)).toEqual([expect.objectContaining({ user_id: userId, sub: G_SUB, role: 'root', status: 'active' })]);
  });

  it('a member’s login writes the member under its root’s user', async () => {
    const { app, aud, near } = await linkSetup();
    near.identities.set(`google#${G_SUB}`, { status: 'member', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    near.accounts.set('email#e1.root', { root: { provider: 'email', sub: 'e1.root' }, members: [{ provider: 'google', sub: G_SUB, active: true }], epoch: 1 });
    // The mock opens the token's own path; the API only reads where the identity stands.
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    const userId = await expectedUserId(app.scope, 'email', 'e1.root');
    expect(await identities(app.scope)).toEqual([
      expect.objectContaining({ user_id: userId, provider: 'email', sub: 'e1.root', role: 'root' }),
      expect.objectContaining({ user_id: userId, provider: 'google', sub: G_SUB, role: 'member', status: 'active' }),
    ]);
  });

  it('a failed login writes nothing', async () => {
    const { app, aud, near } = await linkSetup();
    near.contract.create_session_and_derive = () => {
      throw new Error('Token is for another app');
    };
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(422);
    expect(await users(app.scope)).toEqual([]);
  });

  it('a link adds the new identity as pending, from the account the chain reports after the relay', async () => {
    const { app, aud, near } = await linkSetup();
    const root = fromHex(ikSync(app.scope, 'google', G_SUB));
    const nSub = 'e1.new';
    const newJwt = await emailToken({ aud: emailAud(app.scope), sub: nSub, nonce: await linkNewNonce(env.SIGNER_ACCOUNT, app.scope, root, 'email', 0, Uint8Array.from(salt)) });
    const accountJwt = await google.sign({ iss: 'https://accounts.google.com', aud, sub: G_SUB, nonce: await linkAccountNonce(env.SIGNER_ACCOUNT, app.scope, root, fromHex(ikSync(app.scope, 'email', nSub)), 0, Uint8Array.from(salt)), exp: Math.floor(Date.now() / 1000) + 600 });
    const effective = Date.now() + HOUR;
    near.contract.link_identity = () => {
      near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [{ provider: 'email', sub: nSub, active: false, effectiveAtMs: effective }], epoch: 1 });
      near.identities.set(`email#${nSub}`, { status: 'pending', opened: false, root: { provider: 'google', sub: G_SUB } });
      return effective;
    };
    const res = await linkCall('/v1/link', app, { accountJwt, newJwt, epoch: 0, salt });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const userId = await expectedUserId(app.scope, 'google', G_SUB);
    expect(await identities(app.scope)).toEqual([
      expect.objectContaining({ user_id: userId, provider: 'google', role: 'root' }),
      expect.objectContaining({ user_id: userId, provider: 'email', sub: nSub, role: 'member', status: 'pending', effective_at: effective }),
    ]);
  });

  it('cancel marks the member cancelled and unlink marks it unlinked, as confirmed on chain', async () => {
    for (const action of ['cancel', 'unlink'] as const) {
      const { app, aud, near } = await linkSetup();
      const e = `e1.m-${action}`;
      const active = action === 'unlink';
      near.identities.set(`email#${e}`, { status: active ? 'member' : 'pending', opened: false, root: { provider: 'google', sub: G_SUB } });
      near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [{ provider: 'email', sub: e, active, effectiveAtMs: active ? 1 : Date.now() + HOUR }], epoch: 1 });
      // The directory already knows the member (an earlier sync).
      expect(await syncAccount(env, app.scope, { provider: 'google', sub: G_SUB }, [{ provider: 'email', sub: e }], { requestId: rid(), endpoint: 'test' })).toBe(true);
      expect((await identities(app.scope))[1]).toMatchObject({ sub: e, status: active ? 'active' : 'pending' });
      const removeOnChain = () => {
        near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [], epoch: 2, unlinked: active ? [ikSync(app.scope, 'email', e)] : [] });
        near.identities.delete(`email#${e}`);
        return null;
      };
      near.contract.cancel_link = removeOnChain;
      near.contract.unlink_identity = removeOnChain;
      const member = ikSync(app.scope, 'email', e);
      const jwt = await google.sign({ iss: 'https://accounts.google.com', aud, sub: G_SUB, nonce: await linkChangeNonce(env.SIGNER_ACCOUNT, app.scope, action, fromHex(ikSync(app.scope, 'google', G_SUB)), fromHex(member), 1, Uint8Array.from(salt)), exp: Math.floor(Date.now() / 1000) + 600 });
      const res = await linkCall(`/v1/link/${action}`, app, { jwt, memberKey: member, epoch: 1, salt });
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      expect((await identities(app.scope))[1], action).toMatchObject({ sub: e, role: 'member', status: action === 'cancel' ? 'cancelled' : 'unlinked' });
    }
  });

  it('a member that leaves one account and joins another moves cleanly; an older sync never undoes a newer one', async () => {
    const { app, near } = await linkSetup();
    const m = { provider: 'email', sub: 'e1.mover' };
    near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [{ ...m, active: true }], epoch: 1 });
    near.identities.set('email#e1.mover', { status: 'member', opened: false, root: { provider: 'google', sub: G_SUB } });
    const at = { requestId: rid(), endpoint: 'test' };
    await syncAccount(env, app.scope, { provider: 'google', sub: G_SUB }, [m], at);
    // Unlinked from A, then linked to B.
    near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [], epoch: 2, unlinked: [ikSync(app.scope, 'email', 'e1.mover')] });
    near.accounts.set('google#other-root', { root: { provider: 'google', sub: 'other-root' }, members: [{ ...m, active: true }], epoch: 1 });
    near.identities.set('email#e1.mover', { status: 'member', opened: false, root: { provider: 'google', sub: 'other-root' } });
    await syncAccount(env, app.scope, { provider: 'google', sub: G_SUB }, [], at);
    expect((await identities(app.scope)).find((r) => r.sub === 'e1.mover')).toMatchObject({ status: 'unlinked', user_id: await expectedUserId(app.scope, 'google', G_SUB) });
    await syncAccount(env, app.scope, { provider: 'google', sub: 'other-root' }, [m], at);
    const userB = await expectedUserId(app.scope, 'google', 'other-root');
    expect((await identities(app.scope)).filter((r) => r.sub === 'e1.mover')).toEqual([expect.objectContaining({ user_id: userB, role: 'member', status: 'active' })]);
    // A late write from before the move (an older chain read) changes nothing.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10 * 60_000);
    near.accounts.set(`google#${G_SUB}`, { root: { provider: 'google', sub: G_SUB }, members: [{ ...m, active: true }], epoch: 1 });
    await syncAccount(env, app.scope, { provider: 'google', sub: G_SUB }, [m], at);
    vi.restoreAllMocks();
    expect((await identities(app.scope)).filter((r) => r.sub === 'e1.mover')).toEqual([expect.objectContaining({ user_id: userB, status: 'active' })]);
  });

  it('a login whose standing read failed writes nothing (the fail-open guess is never stored)', async () => {
    const app = await seedApp();
    expect(await syncAfterLogin(env, app.scope, { provider: 'google', sub: G_SUB }, null, { pending: false, path: pathFor(app.scope), confirmed: false }, { requestId: rid(), endpoint: 'test' })).toBe(false);
    expect(await users(app.scope)).toEqual([]);
  });
});

// ---- reads ----

async function populated(org: string) {
  const near = chain();
  const app = await orgApp({ org });
  const sub = `sub-${uid()}`;
  const spk = spentSession(near, app.scope, { sub });
  const prk = randomPrk();
  expect((await record(app, spk, { prk, path: pathFor(app.scope, sub) })).status).toBe(200);
  const userId = await expectedUserId(app.scope, 'google', sub);
  return { app, sub, prk, userId, addresses: deriveAddresses(prk), near };
}

describe('AdminRpc: users for staff', () => {
  it('lists, gets and finds users by wallet address, user id, Support ID and sub, with subs and wallets', async () => {
    const org = newOrg();
    const a = await populated(org);
    const staff = { actor: { kind: 'hana' as const, id: 'staff-1', email: 'staff@hana.example' }, requestId: rid(), clientIp: '203.0.113.1' };
    const got = (await adminRpc().getUser({ ...staff, userId: a.userId })) as unknown as { ok: true; user: Record<string, unknown> };
    expect(got.ok).toBe(true);
    expect(got.user).toMatchObject({ userId: a.userId, supportId: supportIdOf(a.userId), scopeId: a.app.scope, orgId: org });
    expect(got.user.identities).toEqual([expect.objectContaining({ provider: 'google', sub: a.sub, role: 'root', status: 'active', directoryKey: { provider: 'google', sub: a.sub } })]);
    expect(got.user.wallets).toEqual([
      expect.objectContaining({ chain: 'stellar', address: a.addresses.stellar, keyIndex: 0, sharedWith: 0 }),
      expect.objectContaining({ chain: 'evm', address: a.addresses.evm, keyIndex: 0, sharedWith: 0 }),
    ]);
    for (const query of [a.addresses.stellar, a.addresses.evm, a.addresses.evm.toLowerCase(), a.userId, supportIdOf(a.userId), supportIdOf(a.userId).toLowerCase(), a.sub]) {
      const found = (await adminRpc().findUsers({ ...staff, query })) as unknown as { ok: true; users: { userId: string }[] };
      expect(found.users.map((u) => u.userId), query).toEqual([a.userId]);
    }
    const bySub = (await adminRpc().findUsers({ ...staff, query: a.sub, provider: 'email' })) as unknown as { ok: true; users: unknown[] };
    expect(bySub.users).toEqual([]);
    const listed = (await adminRpc().listUsers({ ...staff, orgId: org })) as unknown as { ok: true; users: { userId: string }[]; nextCursor: string | null };
    expect([listed.users.map((u) => u.userId), listed.nextCursor]).toEqual([[a.userId], null]);
    expect(((await adminRpc().getUser({ ...staff, userId: `hu_${'0'.repeat(26)}` })) as unknown as { code: string }).code).toBe('not_found');
    expect(((await consoleRpc().listUsers({ ...staff, orgId: org })) as unknown as { code: string }).code).toBe('forbidden');
  });

  it('pages newest first with a cursor', async () => {
    const org = newOrg();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await populated(org)).userId);
    const staff = { actor: { kind: 'hana' as const, id: 'staff-1', email: 'staff@hana.example' }, requestId: rid(), clientIp: '203.0.113.1' };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = (await adminRpc().listUsers({ ...staff, orgId: org, limit: 2, ...(cursor ? { cursor } : {}) })) as unknown as { users: { userId: string }[]; nextCursor: string | null };
      seen.push(...r.users.map((u) => u.userId));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });
});

describe('ConsoleRpc: users for partners', () => {
  it('sees its own org’s users only, with account kinds and wallets but never a sub, identity key or email', async () => {
    const orgA = newOrg();
    const orgB = newOrg();
    const a = await populated(orgA);
    const b = await populated(orgB);
    const asA = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: orgA };
    const list = (await consoleRpc().listUsers(asA)) as unknown as { ok: true; users: Record<string, unknown>[] };
    expect(list.ok).toBe(true);
    expect(list.users.map((u) => u.userId)).toEqual([a.userId]);
    const [u] = list.users;
    expect(Object.keys(u!).sort()).toEqual(['accounts', 'createdAt', 'lastSeenAt', 'scopeId', 'supportId', 'userId', 'wallets']);
    expect(u!.accounts).toEqual([{ kind: 'google', status: 'active' }]);
    expect((u!.wallets as { address: string }[]).map((w) => w.address)).toEqual([a.addresses.stellar, a.addresses.evm]);
    const text = JSON.stringify(list);
    expect(text).not.toContain(a.sub);
    expect(text).not.toContain(ikSync(a.app.scope, 'google', a.sub));
    expect(text).not.toContain('@');
    expect(text).not.toContain(b.userId);
    // Another org's user: not found, by id, by address and by Support ID.
    expect(((await consoleRpc().getUser({ ...asA, userId: b.userId })) as unknown as { code: string }).code).toBe('not_found');
    for (const search of [b.addresses.stellar, b.addresses.evm, b.userId, supportIdOf(b.userId)]) {
      expect(((await consoleRpc().listUsers({ ...asA, search })) as unknown as { users: unknown[] }).users, search).toEqual([]);
    }
    // Its own, by each.
    for (const search of [a.addresses.evm, a.userId, supportIdOf(a.userId)]) {
      expect(((await consoleRpc().listUsers({ ...asA, search })) as unknown as { users: { userId: string }[] }).users.map((x) => x.userId), search).toEqual([a.userId]);
    }
    const got = (await consoleRpc().getUser({ ...asA, userId: a.userId })) as unknown as { ok: true; user: Record<string, unknown> };
    expect(JSON.stringify(got)).not.toContain(a.sub);
  });

  it('refuses a search by sub (partners never test whether a Google account is a user)', async () => {
    const orgA = newOrg();
    const a = await populated(orgA);
    const r = (await consoleRpc().listUsers({ ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: orgA, search: a.sub })) as unknown as { ok: false; code: string };
    expect([r.ok, r.code]).toEqual([false, 'bad_request']);
  });

  it('shows a pending member as pending, and active once its activation time passes', async () => {
    const orgA = newOrg();
    const a = await populated(orgA);
    const near = withEmail(a.near, [a.app.scope]);
    near.accounts.set(`google#${a.sub}`, { root: { provider: 'google', sub: a.sub }, members: [{ provider: 'email', sub: 'e1.p', active: false, effectiveAtMs: Date.now() + HOUR }], epoch: 1 });
    await syncAccount(env, a.app.scope, { provider: 'google', sub: a.sub }, [{ provider: 'email', sub: 'e1.p' }], { requestId: rid(), endpoint: 'test' });
    const asA = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: orgA };
    const before = (await consoleRpc().getUser({ ...asA, userId: a.userId })) as unknown as { user: { accounts: unknown[] } };
    expect(before.user.accounts).toEqual([{ kind: 'google', status: 'active' }, { kind: 'email', status: 'pending' }]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * HOUR);
    const after = (await consoleRpc().getUser({ ...asA, requestId: rid(), userId: a.userId })) as unknown as { user: { accounts: unknown[] } };
    vi.restoreAllMocks();
    expect(after.user.accounts).toEqual([{ kind: 'google', status: 'active' }, { kind: 'email', status: 'active' }]);
  });
});
