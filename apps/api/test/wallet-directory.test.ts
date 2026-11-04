// The wallet directory (D310, D312–D315, D346): POST /v1/wallets/record (the vault's signed report, with the session
// signature over the whole request), the identities kept current after /v1/login and the link relays, and the
// AdminRpc / ConsoleRpc reads with their three ids. Migration 0011's tables.
import { internalIdOf, uid as uidOf, supportIdOf } from '@hana-id/console-core';
import { deriveAddresses, withChainKey } from '@hana-id/core/derivation';
import { identitySub } from '@hana-id/core/identity';
import { type WalletRecordChain, signWalletRecord, walletRecordSessionMessage, walletRecordStatement } from '@hana-id/core/wallet-record';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex } from '../src/bytes.ts';
import { syncAccount, syncAfterLogin } from '../src/directory/sync.ts';
import { linkChangeNonce, linkAccountNonce, linkNewNonce } from '../src/session-crypto.ts';
import { emailAud, emailEnv, emailToken, ikSync, setLoginMethods, withEmail } from './email-helpers.ts';
import { bytes, call, chain, google, newSessionKey, seedApp, sessionKeyPair, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { adminRpc, consoleRpc, member, newOrg, orgApp, rid } from './rpc-helpers.ts';
import { mint, verifyToken } from './identity-helpers.ts';
import { HOUR, VAULT, createShare, pathFor, spentSession, vaultHeaders, vaultSetup } from './vault-helpers.ts';

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
  /**
   * Who makes the session signature: the body's own session key (default), another test session key, or nobody
   * (`null`: the field left out). Signed over what the records were signed for.
   */
  sessionSigner?: number[] | null;
  /** Applied after every signature is made (a tampered body). */
  mutate?: (b: Record<string, unknown>) => void;
}

/** A POST /v1/wallets/record body as the vault makes it: each address signed by its own key, the whole by the session key. */
function recordBody(app: { id: string; scope: string }, spk: number[], o: RecordOpts = {}): Record<string, unknown> {
  const prk = o.prk ?? randomPrk();
  const addresses = deriveAddresses(prk);
  const path = o.path ?? pathFor(app.scope);
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const ctx = { env: o.signEnv ?? env.ENV_NAME, signer: env.SIGNER_ACCOUNT, appId: o.signApp ?? app.id, scopeId: app.scope, path: o.signPath ?? path, sessionPublicKey: Uint8Array.from(o.signSpk ?? spk), issuedAtMs };
  const wallets: Record<WalletRecordChain, { address: string; signature: number[] }> = {} as never;
  for (const c of ['stellar', 'evm'] as const) {
    wallets[c] = { address: addresses[c], signature: [...withChainKey(prk, c, 0, (k) => signWalletRecord(c, k, walletRecordStatement(ctx, c, addresses[c])))] };
  }
  if (o.otherAddress) wallets[o.otherAddress].address = deriveAddresses(randomPrk())[o.otherAddress];
  const b: Record<string, unknown> = { sessionPublicKey: spk, issuedAtMs, path, wallets };
  const signer = o.sessionSigner === undefined ? spk : o.sessionSigner;
  if (signer !== null) {
    const proofs = { stellar: { address: wallets.stellar.address, signature: Uint8Array.from(wallets.stellar.signature) }, evm: { address: wallets.evm.address, signature: Uint8Array.from(wallets.evm.signature) } };
    b.sessionSignature = [...sessionKeyPair(signer).sign(walletRecordSessionMessage(ctx, proofs)).signature];
  }
  o.mutate?.(b);
  return b;
}

const record = (app: { id: string; key: string; scope: string }, spk: number[], o: RecordOpts & { headers?: Record<string, string>; env?: Partial<typeof env> } = {}) =>
  call('/v1/wallets/record', { headers: o.headers ?? vaultHeaders(app), body: recordBody(app, spk, o), env: o.env });

const b64Key = (v: string | undefined): Uint8Array => Uint8Array.from(atob(v!), (c) => c.charCodeAt(0));

/** The internal id (`hu_…`, end_users.user_id and the other tables' join column) of an account root. */
async function expectedInternalId(scope: string, provider: string, sub: string): Promise<string> {
  return internalIdOf(await uidOf(b64Key(env.USER_ID_KEY), { scopeId: scope, provider, sub }));
}

/** The User ID (`u1_…`): exactly the identity token's `sub` for that root (core identitySub, IDENTITY_SUB_KEY). */
const expectedUserId = (scope: string, provider: string, sub: string): string => identitySub(b64Key(env.IDENTITY_SUB_KEY), scope, { provider, sub });

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
  it('stores the user (its three ids), both wallets and the root identity, for the vault only', async () => {
    const { app, spk } = await recorded();
    const prk = randomPrk();
    const res = await record(app, spk, { prk });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(VAULT);
    const b = await body(res);
    expect(Object.keys(b).sort()).toEqual(['recorded', 'requestId']);
    const userId = await expectedInternalId(app.scope, 'google', G_SUB);
    const tokenSub = expectedUserId(app.scope, 'google', G_SUB);
    const [u] = await users(app.scope);
    // The internal id is the ledger's uid; the User ID is the identity token's `sub`; the Support ID is its short form.
    expect(u).toMatchObject({ user_id: userId, token_sub: tokenSub, support_code: supportIdOf(tokenSub).replace(/HANA-|-/gu, '') });
    expect(tokenSub).toMatch(/^u1_[A-Za-z0-9_-]{22}$/u);
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
    const userId = await expectedInternalId(app.scope, 'google', G_SUB);
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

  it('refuses a record without the session’s own signature over it: someone else’s wallet can’t be listed as the user’s', async () => {
    const { app, spk } = await recorded();
    // The attack (security review): a genuine record by the attacker's own wallet key, naming the victim's live
    // session key (public on chain) and path, with no session signature, or with one by another session key.
    const attackerPrk = randomPrk();
    const attacker = newSessionKey();
    const forged: [string, RecordOpts, number, string][] = [
      ['no session signature', { prk: attackerPrk, sessionSigner: null }, 400, 'bad_request'],
      ['another key’s session signature', { prk: attackerPrk, sessionSigner: attacker }, 401, 'invalid_signature'],
      ['a zero signature', { prk: attackerPrk, mutate: (b) => (b.sessionSignature = new Array(64).fill(0)) }, 401, 'invalid_signature'],
      ['a short signature', { prk: attackerPrk, mutate: (b) => (b.sessionSignature = new Array(63).fill(1)) }, 400, 'bad_request'],
    ];
    for (const [what, o, status, code] of forged) {
      const res = await record(app, spk, o);
      expect([res.status, (await body(res)).code], what).toEqual([status, code]);
    }
    // A genuine vault body, changed after signing: refused by whichever signature covers the change first.
    const tampered: [string, (b: Record<string, unknown>) => void, number, string][] = [
      ['issuedAtMs', (b) => (b.issuedAtMs = (b.issuedAtMs as number) - 1), 400, 'bad_wallet_record'],
      ['path', (b) => (b.path = `${app.scope}#google#999#0`), 400, 'bad_wallet_record'],
      ['the session signature', (b) => ((b.sessionSignature as number[])[7]! ^= 1), 401, 'invalid_signature'],
    ];
    for (const [what, mutate, status, code] of tampered) {
      const res = await record(app, spk, { mutate });
      expect([res.status, (await body(res)).code], what).toEqual([status, code]);
    }
    // A swapped address (with its own valid record) under the vault's session signature: the session signature fails.
    const issuedAtMs = Date.now();
    const swapped = recordBody(app, spk, { issuedAtMs });
    const genuine = recordBody(app, spk, { issuedAtMs });
    (genuine.wallets as Record<string, unknown>).evm = (swapped.wallets as Record<string, unknown>).evm;
    const swap = await call('/v1/wallets/record', { headers: vaultHeaders(app), body: genuine });
    expect([swap.status, (await body(swap)).code]).toEqual([401, 'invalid_signature']);
    expect(await users(app.scope)).toEqual([]);
    // The vault's own record (both signatures genuine) is taken.
    expect((await record(app, spk)).status).toBe(200);
  });

  it('refuses a replay of a genuine record outside the ±5 min window', async () => {
    const { app, spk } = await recorded();
    const issuedAtMs = Date.now();
    const genuine = recordBody(app, spk, { issuedAtMs });
    expect((await call('/v1/wallets/record', { headers: vaultHeaders(app), body: genuine })).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(issuedAtMs + 5 * 60_000 + 1);
    const replay = await call('/v1/wallets/record', { headers: vaultHeaders(app), body: genuine });
    expect([replay.status, (await body(replay)).code]).toEqual([400, 'stale_record']);
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

  it('without USER_ID_KEY or IDENTITY_SUB_KEY answers 503 directory_unavailable and writes nothing', async () => {
    const { app, spk } = await recorded();
    for (const missing of [{ USER_ID_KEY: undefined }, { IDENTITY_SUB_KEY: undefined }, { IDENTITY_SUB_KEY: 'not-a-key' }]) {
      const res = await record(app, spk, { env: missing });
      expect([res.status, (await body(res)).code], JSON.stringify(missing)).toEqual([503, 'directory_unavailable']);
    }
    expect(await users(app.scope)).toEqual([]);
  });

  it('records a linked member’s wallet under its account root (the session path is the root’s)', async () => {
    const { app, spk } = await recorded({ sub: 'root-sub' });
    expect((await record(app, spk, { path: pathFor(app.scope, 'root-sub') })).status).toBe(200);
    const [u] = await users(app.scope);
    expect(u!.user_id).toBe(await expectedInternalId(app.scope, 'google', 'root-sub'));
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
    const userId = await expectedInternalId(app.scope, 'google', G_SUB);
    expect((await users(app.scope)).map((u) => u.user_id)).toEqual([userId]);
    expect(await identities(app.scope)).toEqual([expect.objectContaining({ user_id: userId, sub: G_SUB, role: 'root', status: 'active' })]);
  });

  it('a login without IDENTITY_SUB_KEY still succeeds and writes nothing (no user without the id partners see)', async () => {
    const { app, aud } = await linkSetup();
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud), env: { IDENTITY_SUB_KEY: undefined } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await users(app.scope)).toEqual([]);
  });

  it('a member’s login writes the member under its root’s user', async () => {
    const { app, aud, near } = await linkSetup();
    near.identities.set(`google#${G_SUB}`, { status: 'member', opened: false, root: { provider: 'email', sub: 'e1.root' } });
    near.accounts.set('email#e1.root', { root: { provider: 'email', sub: 'e1.root' }, members: [{ provider: 'google', sub: G_SUB, active: true }], epoch: 1 });
    // The mock opens the token's own path; the API only reads where the identity stands.
    expect((await call('/v1/login', { headers: hanaHeaders(app), body: await loginBody(app.scope, aud) })).status).toBe(200);
    const userId = await expectedInternalId(app.scope, 'email', 'e1.root');
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
    const userId = await expectedInternalId(app.scope, 'google', G_SUB);
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
    expect((await identities(app.scope)).find((r) => r.sub === 'e1.mover')).toMatchObject({ status: 'unlinked', user_id: await expectedInternalId(app.scope, 'google', G_SUB) });
    await syncAccount(env, app.scope, { provider: 'google', sub: 'other-root' }, [m], at);
    const userB = await expectedInternalId(app.scope, 'google', 'other-root');
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
  const internalId = await expectedInternalId(app.scope, 'google', sub);
  const userId = expectedUserId(app.scope, 'google', sub);
  return { app, sub, prk, userId, internalId, addresses: deriveAddresses(prk), near };
}

describe('AdminRpc: users for staff', () => {
  it('lists, gets and finds users by wallet address, User ID, internal id, Support ID and sub, with all three ids', async () => {
    const org = newOrg();
    const a = await populated(org);
    const staff = { actor: { kind: 'hana' as const, id: 'staff-1', email: 'staff@hana.example' }, requestId: rid(), clientIp: '203.0.113.1' };
    const got = (await adminRpc().getUser({ ...staff, userId: a.userId })) as unknown as { ok: true; user: Record<string, unknown> };
    expect(got.ok).toBe(true);
    expect(got.user).toMatchObject({ userId: a.userId, supportId: supportIdOf(a.userId), internalId: a.internalId, scopeId: a.app.scope, orgId: org });
    expect(a.userId).toMatch(/^u1_/u);
    expect(a.internalId).toMatch(/^hu_/u);
    const byInternal = (await adminRpc().getUser({ ...staff, internalId: a.internalId })) as unknown as { ok: true; user: Record<string, unknown> };
    expect(byInternal.user).toEqual(got.user);
    expect(((await adminRpc().getUser({ ...staff })) as unknown as { code: string }).code).toBe('bad_request');
    expect(got.user.identities).toEqual([expect.objectContaining({ provider: 'google', sub: a.sub, role: 'root', status: 'active', directoryKey: { provider: 'google', sub: a.sub } })]);
    expect(got.user.wallets).toEqual([
      expect.objectContaining({ chain: 'stellar', address: a.addresses.stellar, keyIndex: 0, sharedWith: 0 }),
      expect.objectContaining({ chain: 'evm', address: a.addresses.evm, keyIndex: 0, sharedWith: 0 }),
    ]);
    for (const query of [a.addresses.stellar, a.addresses.evm, a.addresses.evm.toLowerCase(), a.userId, a.internalId, a.internalId.toUpperCase().replace('HU_', 'hu_'), supportIdOf(a.userId), supportIdOf(a.userId).toLowerCase(), a.sub]) {
      const found = (await adminRpc().findUsers({ ...staff, query })) as unknown as { ok: true; users: { userId: string }[] };
      expect(found.users.map((u) => u.userId), query).toEqual([a.userId]);
    }
    const bySub = (await adminRpc().findUsers({ ...staff, query: a.sub, provider: 'email' })) as unknown as { ok: true; users: unknown[] };
    expect(bySub.users).toEqual([]);
    const listed = (await adminRpc().listUsers({ ...staff, orgId: org })) as unknown as { ok: true; users: { userId: string }[]; nextCursor: string | null };
    expect([listed.users.map((u) => u.userId), listed.nextCursor]).toEqual([[a.userId], null]);
    expect(((await adminRpc().getUser({ ...staff, internalId: `hu_${'0'.repeat(26)}` })) as unknown as { code: string }).code).toBe('not_found');
    expect(((await adminRpc().getUser({ ...staff, userId: `u1_${'A'.repeat(22)}` })) as unknown as { code: string }).code).toBe('not_found');
    expect(((await consoleRpc().listUsers({ ...staff, orgId: org })) as unknown as { code: string }).code).toBe('forbidden');
  });

  it('the User ID is the `sub` of the identity token the same session mints', async () => {
    // The partner's backend stores the token's `sub`; the directory's User ID is that same string (D346).
    const { app, near } = await vaultSetup();
    const sub = `tok-${uid()}`;
    const share = await createShare(app, near, { sub });
    expect((await record(app, share.spk, { path: pathFor(app.scope, sub) })).status).toBe(200);
    const minted = (await (await mint(app, share.spk)).json()) as { identityToken: string };
    const { claims } = await verifyToken(minted.identityToken);
    const staff = { actor: { kind: 'hana' as const, id: 'staff-1', email: 'staff@hana.example' }, requestId: rid(), clientIp: '203.0.113.1' };
    const found = (await adminRpc().findUsers({ ...staff, query: claims.sub as string })) as unknown as { users: { userId: string; supportId: string }[] };
    expect(found.users).toEqual([expect.objectContaining({ userId: claims.sub, supportId: supportIdOf(claims.sub as string) })]);
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
    expect(u!.userId).toBe(a.userId);
    expect(u!.userId).toMatch(/^u1_/u);
    expect(u!.supportId).toBe(supportIdOf(a.userId));
    const text = JSON.stringify(list);
    // Never the internal id (D346), a sub, an identity key or an email.
    expect(text).not.toContain(a.internalId);
    expect(text).not.toContain('hu_');
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
    expect(got.user).toMatchObject({ userId: a.userId, supportId: supportIdOf(a.userId) });
    expect(JSON.stringify(got)).not.toContain(a.sub);
    expect(JSON.stringify(got)).not.toContain(a.internalId);
  });

  it('pages with a cursor that names the User ID, never the internal id', async () => {
    const org = newOrg();
    const ids: string[] = [];
    const internal: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await populated(org);
      ids.push(p.userId);
      internal.push(p.internalId);
    }
    const asA = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: org };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = (await consoleRpc().listUsers({ ...asA, requestId: rid(), limit: 2, ...(cursor ? { cursor } : {}) })) as unknown as { users: { userId: string }[]; nextCursor: string | null };
      seen.push(...r.users.map((u) => u.userId));
      if (!r.nextCursor) break;
      expect(r.nextCursor).toMatch(/^\d+:u1_/u);
      for (const h of internal) expect(r.nextCursor).not.toContain(h);
      cursor = r.nextCursor;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('refuses a search by sub or by internal id, and a get by internal id (partners never see or use `hu_…`)', async () => {
    const orgA = newOrg();
    const a = await populated(orgA);
    const asA = { ...member(), requestId: rid(), clientIp: '203.0.113.2', orgId: orgA };
    for (const search of [a.sub, a.internalId, a.internalId.toUpperCase()]) {
      const r = (await consoleRpc().listUsers({ ...asA, requestId: rid(), search })) as unknown as { ok: false; code: string };
      expect([r.ok, r.code], search).toEqual([false, 'bad_request']);
    }
    const byInternal = (await consoleRpc().getUser({ ...asA, requestId: rid(), userId: a.internalId })) as unknown as { ok: false; code: string };
    expect([byInternal.ok, byInternal.code]).toEqual([false, 'bad_request']);
    const internalField = (await consoleRpc().getUser({ ...asA, requestId: rid(), internalId: a.internalId } as never)) as unknown as { ok: false; code: string };
    expect([internalField.ok, internalField.code]).toEqual([false, 'bad_request']);
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
