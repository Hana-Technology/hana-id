// GET /v1/home/apps (docs/hana-home-spec.md "Tests", H2 of the build plan): each coverage row, suspended, deleted and
// purged apps, a member resolving to its root, the quieter listing, cross-user isolation, every refusal and the limits.
import { encodeHomeIdentity, HOME_EMAIL_AUDIENCE, homeMessage, homeNonce } from '@hana-id/core/home';
import { formatSupportId } from '@hana-id/console-core';
import { KeyPair } from '@near-js/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeDirectory } from '../src/changes/retention.ts';
import { syncAfterLogin } from '../src/directory/sync.ts';
import { HotDb } from '../src/changes/db.ts';
import { HOME_APPS_ENDPOINT, HOME_APPS_PER_IP_MINUTE, HOME_APPS_PER_KEY_MINUTE, HOME_LIST_PAGE, HOME_MINE_MAX, HOME_SCOPE_READS, HOME_SEARCH_PER_KEY_MINUTE } from '../src/home/apps.ts';
import { homeCoverage } from '../src/home/coverage.ts';
import type { ConfigView, ScopeView } from '../src/views.ts';
import { clearViewCaches } from '../src/views.ts';
import { emailEnv, emailToken, withEmail } from './email-helpers.ts';
import { GOOGLE_ISS, type Chain, call, chain, google, seedApp, uid } from './helpers.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const EXIT = 'hana-exit.apps.googleusercontent.com';
const OWN = 'partner-own.apps.googleusercontent.com';
const PATH = HOME_APPS_ENDPOINT;
const SUB = '110248495921238986420';

interface Identity {
  headerFor: (counter: number, path?: string) => string;
}
let counter = 0;

async function newIdentity(o: { sub?: string; aud?: string; jwt?: (nonce: string) => Promise<string> } = {}): Promise<Identity> {
  const kp = KeyPair.fromRandom('ed25519');
  const pub = Uint8Array.from(kp.getPublicKey().data);
  const expiresAtMs = Date.now() + 15 * 60_000;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: pub, expiresAtMs, salt });
  const jwt = o.jwt ? await o.jwt(nonce) : await google.sign({ iss: GOOGLE_ISS, aud: o.aud ?? SHARED, sub: o.sub ?? SUB, nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
  return {
    headerFor: (c, p = PATH) => {
      const sig = kp.sign(homeMessage({ signer: env.SIGNER_ACCOUNT, counter: c, method: 'GET', path: p, body: new Uint8Array(0) })).signature;
      return encodeHomeIdentity({ jwt, key: pub, expiresAtMs, salt, counter: c, sig: Uint8Array.from(sig) });
    },
  };
}

const emailIdentity = (sub: string): Promise<Identity> => newIdentity({ jwt: (nonce) => emailToken({ aud: HOME_EMAIL_AUDIENCE, sub, nonce }) });

interface AppRow {
  appId: string;
  name: string;
  status: string;
  environment: string;
  origins: string[];
  logoUrl: string | null;
}
interface ScopeEntry {
  scopeId: string;
  mine: boolean;
  coverage: string;
  googleClientId: string | null;
  supportId?: string;
  addresses?: { chain: string; address: string }[];
  apps: AppRow[];
}
interface Answer {
  scopes: ScopeEntry[];
  nextCursor: string | null;
}

async function get(id: Identity, query = '', init: { ip?: string; env?: Partial<typeof env>; origin?: string | null } = {}): Promise<Response> {
  const path = `${PATH}${query}`;
  const headers: Record<string, string> = { 'x-hana-home': id.headerFor(++counter, path), 'cf-connecting-ip': init.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  const origin = init.origin === undefined ? AUTH : init.origin;
  if (origin !== null) headers.origin = origin;
  return call(path, { method: 'GET', headers, ...(init.env ? { env: init.env } : {}) });
}

async function list(id: Identity, query = '', init: Parameters<typeof get>[2] = {}): Promise<Answer> {
  const res = await get(id, query, init);
  expect(res.status).toBe(200);
  return (await res.json()) as Answer;
}

const one = async (id: Identity, scopeId: string, init: Parameters<typeof get>[2] = {}): Promise<ScopeEntry | undefined> => (await list(id, `?scopeId=${scopeId}`, init)).scopes[0];

/** Every listed scope, walking the cursor. A new identity each time, so the walk stays inside its per-key window. */
async function walk(): Promise<ScopeEntry[]> {
  const id = await newIdentity();
  const out: ScopeEntry[] = [];
  let query = '';
  for (let i = 0; i < 25; i++) {
    const page = await list(id, query);
    out.push(...page.scopes);
    if (!page.nextCursor) return out;
    query = `?cursor=${page.nextCursor}`;
  }
  throw new Error('too many pages');
}

const hex64 = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const b36 = (n: number): string => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const crockford = (n: number): string => Array.from({ length: n }, () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]).join('');

interface UserOpts {
  userId?: string;
  supportCode?: string;
  provider?: string;
  sub?: string;
  role?: 'root' | 'member';
  status?: string;
  effectiveAt?: number | null;
  wallets?: { chain: 'stellar' | 'evm'; address: string; keyIndex?: number }[] | null;
}

/** A directory user of `scope` (migration 0011's rows), returning its internal id. A given `userId` adds another identity to it. */
async function seedUser(scope: string, o: UserOpts = {}): Promise<{ userId: string; supportCode: string }> {
  const now = Date.now();
  const userId = o.userId ?? `hu_${b36(26)}`;
  const supportCode = o.supportCode ?? crockford(8);
  if (!o.userId) await env.DB.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(userId, `u1_${b36(22)}`, supportCode, scope, now).run();
  await env.DB.prepare('INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)')
    .bind(scope, hex64(), userId, o.provider ?? 'google', o.sub ?? SUB, o.role ?? 'root', o.status ?? 'active', o.effectiveAt ?? null, now)
    .run();
  const wallets = o.wallets === undefined ? [{ chain: 'stellar' as const, address: `G${crockford(55)}` }, { chain: 'evm' as const, address: `0x${hex64().slice(0, 40)}` }] : (o.wallets ?? []);
  for (const w of wallets) await env.DB.prepare('INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(userId, w.chain, w.address, w.keyIndex ?? 0, now).run();
  return { userId, supportCode };
}

const hold = (aud: string, scope: string) => env.DB.prepare('INSERT INTO hana_held_clients (provider, aud, scope_id, added_at) VALUES (?1, ?2, ?3, ?4)').bind('google', aud, scope, 1).run();
const setQuiet = (scope: string, quiet = 1) => env.DB.prepare('UPDATE scopes SET home_quiet = ?2 WHERE scope_id = ?1').bind(scope, quiet).run();

let near: Chain;

beforeEach(() => {
  clearViewCaches();
  near = chain({}, { shared: [SHARED] });
  near.exit = [];
});
afterEach(() => vi.restoreAllMocks());

const getScopeCalls = () => near.viewCalls.filter((c) => c.method === 'get_scope').length;

describe('homeCoverage: each row of the coverage table', () => {
  const now = 1_000;
  const config: ConfigView = { console_audiences: [], shared_clients: [['google', SHARED]], pending_shared_clients: [], exit_clients: [], pending_exit_clients: [], paused: false, links_open: true };
  const withExit: ConfigView = { ...config, exit_clients: [['google', EXIT], ['email', HOME_EMAIL_AUDIENCE]] };
  const scope = (clients: [string, string][], allow_shared: boolean): ScopeView => ({ id: 's1', owners: [], clients, pending: [], action_nonce: 0, allow_shared });
  const google1 = (s: ScopeView | null, cfg: ConfigView, held: string[] = [], preferred: string[] = []) => homeCoverage({ provider: 'google', scope: s, config: cfg, heldClients: held, preferredClients: preferred, now });
  const email1 = (s: ScopeView | null, cfg: ConfigView) => homeCoverage({ provider: 'email', scope: s, config: cfg, heldClients: [], preferredClients: [], now });

  it('allow_shared and no own client: shared, through the shared client', () => {
    expect(google1(scope([], true), config)).toEqual({ coverage: 'shared', googleClientId: SHARED });
  });

  it('allow_shared and only the email client: shared for a Google identity', () => {
    expect(google1(scope([['email', 'email:s1']], true), config)).toEqual({ coverage: 'shared', googleClientId: SHARED });
  });

  it('allow_shared and an own Google client: still the shared client', () => {
    expect(google1(scope([['google', OWN]], true), config)).toEqual({ coverage: 'shared', googleClientId: SHARED });
  });

  it('a shared client that retired or never matured falls back as if shared login were off (D490: "no Hana client")', () => {
    const none = { ...config, shared_clients: [], pending_shared_clients: [{ client: ['google', SHARED] as [string, string], effective_at_ms: now + 1 }] };
    expect(google1(scope([], true), none)).toEqual({ coverage: 'none', googleClientId: null });
    expect(google1(scope([['google', OWN]], true), { ...none, exit_clients: [['google', EXIT]] })).toEqual({ coverage: 'exit', googleClientId: EXIT });
    const matured = { ...config, shared_clients: [], pending_shared_clients: [{ client: ['google', SHARED] as [string, string], effective_at_ms: now }] };
    expect(google1(scope([], true), matured)).toEqual({ coverage: 'shared', googleClientId: SHARED });
  });

  it('own client held by Hana, no allow_shared: hana_client, and not the exit client even when one is in force', () => {
    const held = scope([['google', OWN]], false);
    expect(google1(held, config, [OWN])).toEqual({ coverage: 'hana_client', googleClientId: OWN });
    expect(google1(held, withExit, [OWN])).toEqual({ coverage: 'hana_client', googleClientId: OWN });
  });

  it('a hana_held_clients row for a client the chain no longer lists changes nothing', () => {
    expect(google1(scope([['google', 'another']], false), config, [OWN])).toEqual({ coverage: 'partner_client', googleClientId: 'another' });
  });

  it('own client held by the partner, no allow_shared: best effort without an exit client', () => {
    expect(google1(scope([['google', OWN]], false), config)).toEqual({ coverage: 'partner_client', googleClientId: OWN });
  });

  it('own client held by the partner, no allow_shared, with an exit client: exit (D490)', () => {
    expect(google1(scope([['google', OWN]], false), withExit)).toEqual({ coverage: 'exit', googleClientId: EXIT });
  });

  it('the app’s web client is chosen among several partner clients', () => {
    const s = scope([['google', 'ios'], ['google', 'web']], false);
    expect(google1(s, config, [], ['web'])).toEqual({ coverage: 'partner_client', googleClientId: 'web' });
    expect(google1(s, config)).toEqual({ coverage: 'partner_client', googleClientId: 'ios' });
  });

  it('no client at all: none, or the exit client once H6’s list has one', () => {
    expect(google1(scope([], false), config)).toEqual({ coverage: 'none', googleClientId: null });
    expect(google1(scope([], false), withExit)).toEqual({ coverage: 'exit', googleClientId: EXIT });
  });

  it('an exit entry not yet in force doesn’t count', () => {
    const pending = { ...config, pending_exit_clients: [{ client: ['google', EXIT] as [string, string], effective_at_ms: now + 1 }] };
    expect(google1(scope([], false), pending)).toEqual({ coverage: 'none', googleClientId: null });
  });

  it('a scope the chain doesn’t have: none, even with an exit client', () => {
    expect(google1(null, withExit)).toEqual({ coverage: 'none', googleClientId: null });
  });

  it('an email identity: its email client, then the exit list, then none; never a Google client', () => {
    expect(email1(scope([['email', 'email:s1']], false), config)).toEqual({ coverage: 'email', googleClientId: null });
    expect(email1(scope([['google', OWN]], true), withExit)).toEqual({ coverage: 'exit', googleClientId: null });
    expect(email1(scope([['google', OWN]], true), config)).toEqual({ coverage: 'none', googleClientId: null });
    expect(email1(null, withExit)).toEqual({ coverage: 'none', googleClientId: null });
  });

  it('an unknown provider has no route', () => {
    expect(homeCoverage({ provider: 'apple', scope: scope([], true), config, heldClients: [], preferredClients: [], now })).toEqual({ coverage: 'none', googleClientId: null });
  });
});

describe('GET /v1/home/apps: the list and the overlay', () => {
  it('your apps first, with the Support ID and addresses; other listed apps after, without either', async () => {
    const mineApp = await seedApp();
    const otherApp = await seedApp();
    near.allowShared.add(mineApp.scope).add(otherApp.scope);
    const { supportCode } = await seedUser(mineApp.scope, { wallets: [{ chain: 'evm', address: `0x${'a'.repeat(40)}` }, { chain: 'stellar', address: `G${'B'.repeat(55)}` }] });

    const first = await list(await newIdentity());
    expect(first.scopes[0]?.scopeId).toBe(mineApp.scope);
    const mine = first.scopes[0]!;
    expect(mine).toMatchObject({ mine: true, coverage: 'shared', googleClientId: SHARED, supportId: formatSupportId(supportCode) });
    expect(mine.addresses).toEqual([{ chain: 'stellar', address: `G${'B'.repeat(55)}` }, { chain: 'evm', address: `0x${'a'.repeat(40)}` }]);
    expect(mine.apps[0]).toMatchObject({ appId: mineApp.id, status: 'active', environment: 'test', origins: ['https://wallet.example.com'], logoUrl: null });

    const other = (await walk()).find((s) => s.scopeId === otherApp.scope);
    expect(other).toMatchObject({ mine: false, coverage: 'shared' });
    expect(other).not.toHaveProperty('supportId');
    expect(other).not.toHaveProperty('addresses');
  });

  it('only addresses at key_index 0, the ones Home can derive', async () => {
    const app = await seedApp();
    await seedUser(app.scope, { wallets: [{ chain: 'stellar', address: `G${'C'.repeat(55)}`, keyIndex: 3 }, { chain: 'evm', address: `0x${'b'.repeat(40)}` }] });
    const entry = await one(await newIdentity(), app.scope);
    expect(entry?.addresses).toEqual([{ chain: 'evm', address: `0x${'b'.repeat(40)}` }]);
  });

  it('a user with no directory row: the app is listed, mine false, no Support ID, no addresses', async () => {
    const app = await seedApp();
    near.allowShared.add(app.scope);
    const entry = await one(await newIdentity({ sub: `nobody-${uid()}` }), app.scope);
    expect(entry).toMatchObject({ scopeId: app.scope, mine: false, coverage: 'shared' });
    expect(entry).not.toHaveProperty('supportId');
    expect(entry).not.toHaveProperty('addresses');
  });

  it('a scope with no first_session_at is left out of the list, but not out of its own user’s', async () => {
    const empty = await seedApp({ firstSession: null });
    const owned = await seedApp({ firstSession: null });
    await seedUser(owned.scope);
    const all = await walk();
    expect(all.some((s) => s.scopeId === empty.scope)).toBe(false);
    expect((await list(await newIdentity(), `?scopeId=${empty.scope}`)).scopes).toEqual([]);
    expect(await one(await newIdentity(), owned.scope)).toMatchObject({ mine: true });
    expect(all.some((s) => s.scopeId === owned.scope)).toBe(true);
  });

  it('suspended and deleted apps stay listed, with their status', async () => {
    const suspended = await seedApp({ suspendedBy: 1 });
    const scope = `s${uid()}`;
    const live = await seedApp({ scope });
    const gone = await seedApp({ scope });
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(gone.id, Date.now()).run();
    near.allowShared.add(scope).add(suspended.scope);
    const a = await one(await newIdentity(), suspended.scope);
    expect(a?.apps[0]).toMatchObject({ status: 'suspended' });
    expect(a?.coverage).toBe('shared');
    const b = await one(await newIdentity(), scope);
    expect(b?.apps.map((x) => x.status)).toEqual(['active', 'deleted']);
    expect(b?.apps[0]?.appId).toBe(live.id);
  });

  it('every app deleted, directory purged after 30 days: the scope stays, with no Support ID or addresses', async () => {
    const app = await seedApp();
    near.allowShared.add(app.scope);
    const { userId } = await seedUser(app.scope);
    const longAgo = Date.now() - 40 * 86_400_000;
    await env.DB.prepare('UPDATE apps SET deleted_at = ?2 WHERE id = ?1').bind(app.id, longAgo).run();
    const before = await one(await newIdentity(), app.scope);
    expect(before).toMatchObject({ mine: true });

    await purgeDirectory(new HotDb(env.DB), { before: Date.now(), limit: 500 }, Date.now());
    expect(await env.DB.prepare('SELECT 1 FROM end_users WHERE user_id = ?1').bind(userId).first()).toBeNull();

    const after = await one(await newIdentity(), app.scope);
    expect(after).toMatchObject({ scopeId: app.scope, mine: false, coverage: 'shared' });
    expect(after?.apps[0]?.status).toBe('deleted');
    expect(after).not.toHaveProperty('supportId');
    expect(after).not.toHaveProperty('addresses');
  });

  it('a linked member sees its account root’s wallet and Support ID, by its own identity', async () => {
    const app = await seedApp();
    const memberSub = `member-${uid()}`;
    const root = await seedUser(app.scope, { sub: `root-${uid()}`, wallets: [{ chain: 'evm', address: `0x${'c'.repeat(40)}` }] });
    await seedUser(app.scope, { userId: root.userId, sub: memberSub, role: 'member', wallets: null });
    const entry = await one(await newIdentity({ sub: memberSub }), app.scope);
    expect(entry).toMatchObject({ mine: true, supportId: formatSupportId(root.supportCode) });
    expect(entry?.addresses).toEqual([{ chain: 'evm', address: `0x${'c'.repeat(40)}` }]);
  });

  it('an email-linked member sees its root’s wallet, and an email identity reads only email rows', async () => {
    const app = await seedApp();
    withEmail(near, []);
    near.exit = [['email', HOME_EMAIL_AUDIENCE]];
    const root = await seedUser(app.scope, { sub: `g-${uid()}`, wallets: [{ chain: 'evm', address: `0x${'d'.repeat(40)}` }] });
    const emailSub = `e1.${uid()}`;
    await seedUser(app.scope, { userId: root.userId, provider: 'email', sub: emailSub, role: 'member', wallets: null });
    const entry = await one(await emailIdentity(emailSub), app.scope, { env: emailEnv() });
    expect(entry).toMatchObject({ mine: true, coverage: 'exit', googleClientId: null });
    expect(entry?.addresses).toEqual([{ chain: 'evm', address: `0x${'d'.repeat(40)}` }]);
    // The same string as a Google sub is another person's row.
    const google2 = await one(await newIdentity({ sub: emailSub }), app.scope);
    expect(google2).toMatchObject({ mine: false });
    expect(google2).not.toHaveProperty('addresses');
  });

  it('a link in its delay, or past it but not yet written active, is not in the account; a member’s login writes it', async () => {
    const app = await seedApp();
    const root = await seedUser(app.scope, { sub: `root-${uid()}` });
    const pendingSub = `pending-${uid()}`;
    await seedUser(app.scope, { userId: root.userId, sub: pendingSub, role: 'member', status: 'pending', effectiveAt: Date.now() + 3_600_000, wallets: null });
    const pending = await one(await newIdentity({ sub: pendingSub }), app.scope);
    expect(pending).toMatchObject({ mine: false });
    expect(pending).not.toHaveProperty('addresses');

    // Past its delay but still `pending` in D1: a cancel's sync may have been lost, so the row alone proves nothing.
    const maturedSub = `matured-${uid()}`;
    await seedUser(app.scope, { userId: root.userId, sub: maturedSub, role: 'member', status: 'pending', effectiveAt: Date.now() - 1, wallets: null });
    const matured = await one(await newIdentity({ sub: maturedSub }), app.scope);
    expect(matured).toMatchObject({ mine: false });
    expect(matured).not.toHaveProperty('supportId');
    expect(matured).not.toHaveProperty('addresses');

    // A genuine member isn't locked out: the app stays listed, and the member's next login writes `active`.
    const member = { provider: 'google', sub: maturedSub };
    const standing = { pending: false, path: `${app.scope}#google#${root.userId}#0`, confirmed: true, member: { root: { provider: 'google', sub: `root-${uid()}` }, effectiveAtMs: Date.now() - 1 } };
    expect(await syncAfterLogin(env, app.scope, member, null, standing, { requestId: 'req_test', endpoint: 'test' })).toBe(true);
    expect(await one(await newIdentity({ sub: maturedSub }), app.scope)).toMatchObject({ mine: true });
  });

  it('an unlinked or cancelled member sees none of its old account’s rows', async () => {
    const app = await seedApp();
    const root = await seedUser(app.scope, { sub: `root-${uid()}` });
    for (const status of ['unlinked', 'cancelled']) {
      const sub = `${status}-${uid()}`;
      await seedUser(app.scope, { userId: root.userId, sub, role: 'member', status, wallets: null });
      const entry = await one(await newIdentity({ sub }), app.scope);
      expect(entry).toMatchObject({ mine: false });
      expect(entry).not.toHaveProperty('supportId');
      expect(entry).not.toHaveProperty('addresses');
    }
  });

  it('cross-user isolation: one user never sees another’s Support ID or addresses, in any way of asking', async () => {
    const app = await seedApp();
    const alice = `alice-${uid()}`;
    const bob = `bob-${uid()}`;
    const a = await seedUser(app.scope, { sub: alice, wallets: [{ chain: 'evm', address: `0x${'e'.repeat(40)}` }] });
    const b = await seedUser(app.scope, { sub: bob, wallets: [{ chain: 'evm', address: `0x${'f'.repeat(40)}` }] });
    const idA = await newIdentity({ sub: alice });
    const idB = await newIdentity({ sub: bob });
    for (const [id, own, other] of [[idA, a, b], [idB, b, a]] as const) {
      const answers = [await list(id), await list(id, `?scopeId=${app.scope}`), await list(id, `?appId=${app.id}`)];
      for (const answer of answers) {
        const text = JSON.stringify(answer);
        expect(text).toContain(formatSupportId(own.supportCode));
        expect(text).not.toContain(formatSupportId(other.supportCode));
        expect(text).not.toContain(other === a ? 'e'.repeat(40) : 'f'.repeat(40));
      }
    }
  });

  it('no query can name another user: unknown parameters are refused', async () => {
    const id = await newIdentity();
    for (const q of ['?sub=x', '?userId=u1', '?scopeId=s1&appId=app_x', '?provider=email']) {
      const res = await get(id, q);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('bad_request');
    }
  });

  it('test apps only in dev envs: a production env leaves them out, even a user’s own', async () => {
    const testApp = await seedApp();
    await seedUser(testApp.scope);
    expect(await one(await newIdentity(), testApp.scope)).toMatchObject({ mine: true });
    const prod = { ENV_NAME: 'prod' };
    expect((await list(await newIdentity(), `?scopeId=${testApp.scope}`, { env: prod })).scopes).toEqual([]);
    const firstPage = await list(await newIdentity(), '', { env: prod });
    expect(firstPage.scopes.some((s) => s.scopeId === testApp.scope)).toBe(false);
  });

  it('a live app shows in production', async () => {
    const live = await seedApp({ key: `pk_live_${'A'.repeat(32)}${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[O0I]/gu, 'A')}` });
    near.allowShared.add(live.scope);
    const entry = await one(await newIdentity(), live.scope, { env: { ENV_NAME: 'prod' } });
    expect(entry).toMatchObject({ scopeId: live.scope, coverage: 'shared' });
    expect(entry?.apps[0]?.environment).toBe('live');
  });

  it('origins not yet in force are left out; the app’s logo is on the files origin', async () => {
    const app = await seedApp({ origins: ['https://a.example.com'] });
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, ?3)').bind(app.id, 'https://later.example.com', Date.now() + 86_400_000).run();
    await env.DB.prepare('UPDATE apps SET logo_key = ?2 WHERE id = ?1').bind(app.id, 'logos/x.png').run();
    const entry = await one(await newIdentity(), app.scope, { env: { FILES_ORIGIN: 'https://files.test' } });
    expect(entry?.apps[0]).toMatchObject({ origins: ['https://a.example.com'], logoUrl: 'https://files.test/logos/x.png' });
  });

  it('a partner-controlled name is returned as data, unchanged', async () => {
    const app = await seedApp();
    const name = `<img src=x onerror=alert(1)> "'${uid()}`;
    await env.DB.prepare('UPDATE apps SET name = ?2 WHERE id = ?1').bind(app.id, name).run();
    const entry = await one(await newIdentity(), app.scope);
    expect(entry?.apps[0]?.name).toBe(name);
  });

  it('coverage through the route: hana-held, and partner-held with and without an exit client', async () => {
    const heldApp = await seedApp();
    near.clients[OWN] = heldApp.scope;
    await hold(OWN, heldApp.scope);
    expect(await one(await newIdentity(), heldApp.scope)).toMatchObject({ coverage: 'hana_client', googleClientId: OWN });

    clearViewCaches();
    const partnerAud = `${uid()}.apps.googleusercontent.com`;
    const partnerApp = await seedApp();
    near.clients[partnerAud] = partnerApp.scope;
    expect(await one(await newIdentity(), partnerApp.scope)).toMatchObject({ coverage: 'partner_client', googleClientId: partnerAud });

    clearViewCaches();
    near.exit = [EXIT];
    expect(await one(await newIdentity(), partnerApp.scope)).toMatchObject({ coverage: 'exit', googleClientId: EXIT });
  });

  it('a scope the chain doesn’t list: coverage none, the apps still shown', async () => {
    const app = await seedApp();
    near.missingScopes.add(app.scope);
    const entry = await one(await newIdentity(), app.scope);
    expect(entry).toMatchObject({ coverage: 'none', googleClientId: null });
    expect(entry?.apps).toHaveLength(1);
  });
});

describe('the quieter listing (D98 item 8)', () => {
  it('leaves the list but is found by its whole app name or its app id, never by walking scope ids', async () => {
    const quiet = await seedApp();
    near.allowShared.add(quiet.scope);
    await setQuiet(quiet.scope);
    const name = (await env.DB.prepare('SELECT name FROM apps WHERE id = ?1').bind(quiet.id).first<{ name: string }>())!.name;
    expect((await walk()).some((s) => s.scopeId === quiet.scope)).toBe(false);

    const byName = await list(await newIdentity(), `?q=${encodeURIComponent(name.toUpperCase())}`);
    expect(byName.scopes.some((s) => s.scopeId === quiet.scope)).toBe(true);
    expect((await list(await newIdentity(), `?q=${encodeURIComponent(name.slice(0, -2))}`)).scopes.some((s) => s.scopeId === quiet.scope)).toBe(false);
    expect((await list(await newIdentity(), `?scopeId=${quiet.scope}`)).scopes).toEqual([]);
    expect((await list(await newIdentity(), `?appId=${quiet.id}`)).scopes).toHaveLength(1);
  });

  it('a stranger’s scope-id lookup finds a normal scope but nothing quiet; the scope’s own user still finds it by id', async () => {
    const normal = await seedApp();
    expect((await list(await newIdentity(), `?scopeId=${normal.scope}`)).scopes).toHaveLength(1);
    const quiet = await seedApp();
    await setQuiet(quiet.scope);
    expect((await list(await newIdentity(), `?scopeId=${quiet.scope}`)).scopes).toEqual([]);
    const sub = `quiet-owner-${uid()}`;
    await seedUser(quiet.scope, { sub });
    expect(await one(await newIdentity({ sub }), quiet.scope)).toMatchObject({ scopeId: quiet.scope, mine: true });
  });

  it('still shows for its own users, without a search', async () => {
    const quiet = await seedApp();
    await setQuiet(quiet.scope);
    const sub = `quiet-user-${uid()}`;
    await seedUser(quiet.scope, { sub });
    const first = await list(await newIdentity({ sub }));
    expect(first.scopes.find((s) => s.scopeId === quiet.scope)).toMatchObject({ mine: true });
  });

  it('a normal app is found by part of its name, case-insensitive, with wildcards as data', async () => {
    const app = await seedApp();
    await env.DB.prepare('UPDATE apps SET name = ?2 WHERE id = ?1').bind(app.id, `Tidepool%_${app.id}`).run();
    const hit = await list(await newIdentity(), `?q=${encodeURIComponent(`tidepool%_${app.id}`)}`);
    expect(hit.scopes.some((s) => s.scopeId === app.scope)).toBe(true);
    const wild = await list(await newIdentity(), `?q=${encodeURIComponent('%_')}`);
    expect(wild.scopes.some((s) => s.scopeId === app.scope)).toBe(true);
    const other = await seedApp();
    await env.DB.prepare('UPDATE apps SET name = ?2 WHERE id = ?1').bind(other.id, `PlainName${other.id}`).run();
    expect((await list(await newIdentity(), `?q=${encodeURIComponent('%_')}`)).scopes.some((s) => s.scopeId === other.scope)).toBe(false);
  });

  it('a search’s term must be 2 to 64 characters', async () => {
    const id = await newIdentity();
    for (const q of ['a', '%20a%20', 'x'.repeat(65)]) expect((await get(id, `?q=${q}`)).status).toBe(400);
  });
});

describe('paging and the free-plan bounds (D417)', () => {
  it('a cursor walks the list once each, the user’s own rows only on the first page', async () => {
    const sub = `walker-${uid()}`;
    const mine = await seedApp();
    await seedUser(mine.scope, { sub });
    const seeded = new Set<string>();
    for (let i = 0; i < HOME_LIST_PAGE + 3; i++) seeded.add((await seedApp()).scope);
    const id = await newIdentity({ sub });
    const seen: string[] = [];
    let query = '';
    for (let pages = 0; pages < 20; pages++) {
      const page = await list(id, query);
      if (pages === 0) expect(page.scopes.some((s) => s.scopeId === mine.scope && s.mine)).toBe(true);
      else expect(page.scopes.some((s) => s.scopeId === mine.scope)).toBe(false);
      expect(page.scopes.filter((s) => !s.mine).length).toBeLessThanOrEqual(HOME_LIST_PAGE);
      seen.push(...page.scopes.map((s) => s.scopeId));
      if (!page.nextCursor) break;
      query = `?cursor=${page.nextCursor}`;
    }
    for (const s of seeded) expect(seen.filter((x) => x === s)).toHaveLength(1);
  });

  it('a user in more scopes than a request may read: at most the read budget of get_scope calls, the rest unknown, then filled from the cache', async () => {
    const sub = `many-${uid()}`;
    const ids: string[] = [];
    for (let i = 0; i < HOME_MINE_MAX + 2; i++) {
      const app = await seedApp();
      ids.push(app.scope);
      near.allowShared.add(app.scope);
      await seedUser(app.scope, { sub, wallets: null });
    }
    near.viewCalls.length = 0;
    const id = await newIdentity({ sub });
    const first = await list(id);
    const mine = first.scopes.filter((s) => s.mine);
    expect(mine).toHaveLength(HOME_MINE_MAX);
    expect(getScopeCalls()).toBeLessThanOrEqual(HOME_SCOPE_READS);
    expect(mine.filter((s) => s.coverage === 'shared').length).toBe(HOME_SCOPE_READS);
    expect(mine.filter((s) => s.coverage === 'unknown').length).toBe(HOME_MINE_MAX - HOME_SCOPE_READS);

    // A later request reads the rest; what it cached costs nothing.
    near.viewCalls.length = 0;
    const second = await list(id);
    expect(second.scopes.filter((s) => s.mine && s.coverage === 'unknown')).toHaveLength(Math.max(0, HOME_MINE_MAX - 2 * HOME_SCOPE_READS));
    expect(getScopeCalls()).toBeLessThanOrEqual(HOME_SCOPE_READS);
    // By scope: a row the page wants next.
    expect(await one(id, ids[0]!)).toMatchObject({ coverage: 'shared' });
  });

  it('a failing chain read stops the reads and answers unknown, with the rows still there', async () => {
    const apps = await Promise.all(Array.from({ length: 8 }, () => seedApp()));
    const sub = `flaky-${uid()}`;
    for (const a of apps) {
      await seedUser(a.scope, { sub, wallets: null });
      near.allowShared.add(a.scope);
    }
    near.viewCalls.length = 0;
    near.views.get_scope = () => {
      throw new Error('rpc down');
    };
    const answer = await list(await newIdentity({ sub }));
    expect(answer.scopes.filter((s) => s.mine)).toHaveLength(8);
    expect(answer.scopes.every((s) => !s.mine || s.coverage === 'unknown')).toBe(true);
    expect(getScopeCalls()).toBeLessThanOrEqual(5);
  });

  it('coverage is cached (at most about 70 s, D500): a turn-off shows on the next read after the cache', async () => {
    const app = await seedApp();
    near.allowShared.add(app.scope);
    expect(await one(await newIdentity(), app.scope)).toMatchObject({ coverage: 'shared' });
    near.allowShared.delete(app.scope);
    near.viewCalls.length = 0;
    expect(await one(await newIdentity(), app.scope)).toMatchObject({ coverage: 'shared' });
    expect(getScopeCalls()).toBe(0);
    clearViewCaches();
    expect(await one(await newIdentity(), app.scope)).toMatchObject({ coverage: 'none' });
  });

  it('an app or origin cap holds: at most 10 apps a scope, 5 origins an app', async () => {
    const scope = `s${uid()}`;
    const origins = Array.from({ length: 8 }, (_, i) => `https://o${i}.example.com`);
    for (let i = 0; i < 12; i++) await seedApp({ scope, origins });
    const entry = await one(await newIdentity(), scope);
    expect(entry?.apps).toHaveLength(10);
    expect(entry?.apps[0]?.origins).toHaveLength(5);
  });
});

describe('every refusal, and the limits', () => {
  it('no identity, a wrong origin: refused, no CORS without the origin', async () => {
    const noHeader = await call(PATH, { method: 'GET', headers: { origin: AUTH } });
    expect(noHeader.status).toBe(401);
    expect(((await noHeader.json()) as { code: string }).code).toBe('missing_home_identity');
    const id = await newIdentity();
    const wrong = await get(id, '', { origin: 'https://partner.example' });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe('origin_not_allowed');
    expect(wrong.headers.get('access-control-allow-origin')).toBeNull();
    const noOrigin = await get(await newIdentity(), '', { origin: null });
    expect(noOrigin.status).toBe(403);
  });

  it('a partner’s own client can’t list: a scope client is not a Home identity', async () => {
    near.clients[OWN] = 'scopex';
    const res = await get(await newIdentity({ aud: OWN }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('not_a_home_client');
  });

  it('an answer carries CORS for AUTH_ORIGIN only, and no-store', async () => {
    const res = await get(await newIdentity());
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a reused counter is 409', async () => {
    const id = await newIdentity();
    const header = id.headerFor(99);
    const first = await call(PATH, { method: 'GET', headers: { 'x-hana-home': header, origin: AUTH } });
    expect(first.status).toBe(200);
    const again = await call(PATH, { method: 'GET', headers: { 'x-hana-home': header, origin: AUTH } });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('counter_reused');
  });

  it('a malformed cursor, scope id or app id is 400', async () => {
    const id = await newIdentity();
    for (const q of ['?cursor=UPPER', '?scopeId=a!b', '?appId=nope', '?q=x']) expect((await get(id, q)).status).toBe(400);
  });

  it(`the per-IP limit (${HOME_APPS_PER_IP_MINUTE} a minute) answers 429`, async () => {
    const { startOfMinuteClock } = await import('./helpers.ts');
    await startOfMinuteClock();
    const ip = '10.123.45.67';
    const id = await newIdentity();
    for (let i = 0; i < HOME_APPS_PER_IP_MINUTE; i++) expect((await get(id, '', { ip })).status).toBe(200);
    const res = await get(id, '', { ip });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('rate_limited');
  });

  it(`the per-Home-key limit (${HOME_APPS_PER_KEY_MINUTE} a minute) answers 429`, async () => {
    const { startOfMinuteClock } = await import('./helpers.ts');
    await startOfMinuteClock();
    const id = await newIdentity();
    for (let i = 0; i < HOME_APPS_PER_KEY_MINUTE; i++) expect((await get(id)).status).toBe(200);
    expect((await get(id)).status).toBe(429);
  });

  it(`searches are limited to ${HOME_SEARCH_PER_KEY_MINUTE} a minute per Home key, and don't spend the list's window`, async () => {
    const { startOfMinuteClock } = await import('./helpers.ts');
    await startOfMinuteClock();
    const id = await newIdentity();
    for (let i = 0; i < HOME_SEARCH_PER_KEY_MINUTE; i++) expect((await get(id, '?q=nothing-matches')).status).toBe(200);
    const res = await get(id, '?q=nothing-matches');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
    expect((await get(id)).status).toBe(200);
  });

  it('a failed limiter refuses a search (503), never lets it through', async () => {
    const id = await newIdentity();
    const real = env.RATE_LIMITER;
    let calls = 0;
    const failing = {
      idFromName: (n: string) => real.idFromName(n),
      get: (i: DurableObjectId, o?: DurableObjectNamespaceGetDurableObjectOptions) => {
        const stub = real.get(i, o);
        return new Proxy(stub, {
          get(t, p) {
            if (p === 'hit') {
              return async (...a: unknown[]) => {
                calls++;
                if (calls >= 3) throw new Error('do down');
                return (t as unknown as { hit: (...x: unknown[]) => Promise<unknown> }).hit(...a);
              };
            }
            return Reflect.get(t, p);
          },
        });
      },
    } as unknown as typeof env.RATE_LIMITER;
    const res = await get(id, '?q=ab', { env: { RATE_LIMITER: failing } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('rate_limiter_unavailable');
  });

  it('a D1 failure is 503, never a partial list', async () => {
    const id = await newIdentity();
    const broken = { prepare: () => { throw new Error('d1 down'); }, batch: () => { throw new Error('d1 down'); } } as unknown as D1Database;
    const res = await get(id, '', { env: { DB: broken } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('home_directory_unavailable');
  });

  it('a chain failure on get_config is 502', async () => {
    const id = await newIdentity();
    near.views.get_config = () => {
      throw new Error('rpc down');
    };
    clearViewCaches();
    const res = await get(id);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe('near_unavailable');
  });

  it('405 on POST; preflight only for AUTH_ORIGIN and allows x-hana-home', async () => {
    expect((await call(PATH, { method: 'POST', rawBody: '{}', headers: { origin: AUTH } })).status).toBe(405);
    const ok = await call(PATH, { method: 'OPTIONS', headers: { origin: AUTH } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('x-hana-home');
    expect((await call(PATH, { method: 'OPTIONS', headers: { origin: 'https://partner.example' } })).status).toBe(403);
  });

  it('nothing is derived or relayed: no transaction leaves', async () => {
    await seedApp();
    await list(await newIdentity());
    expect(near.sent).toHaveLength(0);
  });

  it('no sub, token, Support ID or address reaches a log line', async () => {
    const spy = { log: vi.spyOn(console, 'log'), warn: vi.spyOn(console, 'warn'), error: vi.spyOn(console, 'error') };
    const app = await seedApp();
    const sub = `secret-sub-${uid()}`;
    const { supportCode } = await seedUser(app.scope, { sub, wallets: [{ chain: 'evm', address: `0x${'9'.repeat(40)}` }] });
    const id = await newIdentity({ sub });
    await list(id);
    await get(id, '?q=x');
    const logged = [...spy.log.mock.calls, ...spy.warn.mock.calls, ...spy.error.mock.calls].flat().join('\n');
    expect(logged).not.toContain(sub);
    expect(logged).not.toContain(supportCode);
    expect(logged).not.toContain('9'.repeat(40));
  });
});
