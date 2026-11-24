// POST /v1/home/link/cancel (D902, D898 option B): Passport Home cancels a link that is still waiting, for a wallet on
// the shared Google client. The one success, then every refusal in the handler's order, each relaying nothing: the Home
// gate (origin, header, signature, counter), Google only, the shape, the proof (genuine, a nonce, the same identity as
// Home's, a shared client in force admitted for the scope, not paused), the chain's rules with Home's stricter ones (the
// actor active and not the member, the member pending in the actor's own account, the nonce and the epoch), one relay
// per proof across this route and the window's, the limits, a relay that failed, and the usage event for Journear's own
// org. No token, sub or key in any answer or log line.
import { HOME_EMAIL_AUDIENCE, encodeHomeIdentity, homeMessage, homeNonce } from '@hana-id/core/home';
import { usageEventV1 } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromHex, sha256 } from '../src/bytes.ts';
import { HOME_LINK_CANCEL_ENDPOINT, HOME_LINK_CANCEL_PER_IP_MINUTE, toHomeLinkCancel } from '../src/home/link-cancel.ts';
import { clearLinkViewCaches } from '../src/link-views.ts';
import { POOL_METHODS, parseRelayerKeys } from '../src/relayer-config.ts';
import { linkChangeNonce } from '../src/session-crypto.ts';
import { clearViewCaches } from '../src/views.ts';
import { type EmailChain, emailAud, emailEnv, emailToken, ikSync, withEmail } from './email-helpers.ts';
import { GOOGLE_ISS, call, chain, google, seedApp, uid } from './helpers.ts';
import { hanaHeaders } from './login-helpers.ts';
import { ledger } from './usage-ledger.ts';

const AUTH = env.AUTH_ORIGIN!;
const SHARED = 'shared-client.apps.googleusercontent.com';
const OWN = 'partner-own.apps.googleusercontent.com';
const HANA = 'org_hanaD902';
const sessionKeys = parseRelayerKeys(env.RELAYER_KEYS, 'RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
const homeKeys = parseRelayerKeys(env.HOME_RELAYER_KEYS, 'HOME_RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());

let counter = 0;

interface Identity {
  /** `x-hana-home` for a POST of `body` to the route (a fresh counter unless one is given). */
  sign: (body: string, c?: number) => string;
}

/** A Home identity of `provider`/`sub`: its token's nonce commits to a fresh Home key (Google's shared client by default). */
async function newIdentity(o: { sub: string; provider?: 'google' | 'email' }): Promise<Identity> {
  const kp = KeyPair.fromRandom('ed25519');
  const pub = Uint8Array.from(kp.getPublicKey().data);
  const expiresAtMs = Date.now() + 15 * 60_000;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: pub, expiresAtMs, salt });
  const jwt =
    o.provider === 'email'
      ? await emailToken({ aud: HOME_EMAIL_AUDIENCE, sub: o.sub, nonce })
      : await google.sign({ iss: GOOGLE_ISS, aud: SHARED, sub: o.sub, nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
  return {
    sign: (body, c = ++counter) => {
      const sig = kp.sign(homeMessage({ signer: env.SIGNER_ACCOUNT, counter: c, method: 'POST', path: HOME_LINK_CANCEL_ENDPOINT, body: new TextEncoder().encode(body) })).signature;
      return encodeHomeIdentity({ jwt, key: pub, expiresAtMs, salt, counter: c, sig: Uint8Array.from(sig) });
    },
  };
}

const randomIp = (): string => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const post = (rawBody: string, header: string | null, init: { origin?: string | null; ip?: string; env?: Partial<typeof env>; method?: string } = {}) =>
  call(HOME_LINK_CANCEL_ENDPOINT, {
    method: init.method ?? 'POST',
    rawBody,
    headers: {
      ...(init.origin === null ? {} : { origin: init.origin ?? AUTH }),
      ...(header === null ? {} : { 'x-hana-home': header }),
      'content-type': 'application/json',
      'cf-connecting-ip': init.ip ?? randomIp(),
    },
    env: { ...emailEnv(), HANA_ORG_ID: HANA, ...init.env },
  });
const json = (r: Response): Promise<Record<string, unknown>> => r.json() as Promise<Record<string, unknown>>;

let near: EmailChain;
let scope: string;
let G: string;
const E = 'e1.waiting';
const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)));

const fresh = (): void => {
  clearViewCaches();
  clearLinkViewCaches();
};

/** A Google wallet (root `G`) with the email `E` waiting to join it. */
function waitingAccount(o: { active?: boolean; epoch?: number } = {}): void {
  near.identities.set(`google#${G}`, { status: 'own', opened: true });
  near.identities.set(`email#${E}`, { status: o.active ? 'member' : 'pending', opened: false, root: { provider: 'google', sub: G } });
  near.accounts.set(`google#${G}`, { root: { provider: 'google', sub: G }, members: [{ provider: 'email', sub: E, active: o.active === true, effectiveAtMs: Date.now() + 86_400_000 }], epoch: o.epoch ?? 1 });
  fresh();
}

const rootKey = (): string => ikSync(scope, 'google', G);
const memberKey = (): string => ikSync(scope, 'email', E);

/** A Google proof: `link_change` over (signer, scope, action, root, member, epoch, salt), for `sub` on `aud`. */
async function proof(o: { sub?: string; aud?: string; action?: 'cancel' | 'unlink'; root?: string; member?: string; epoch?: number; scope?: string; nonce?: string | null; claims?: Record<string, unknown> } = {}): Promise<string> {
  const nonce =
    o.nonce === null
      ? undefined
      : (o.nonce ?? (await linkChangeNonce(env.SIGNER_ACCOUNT, o.scope ?? scope, o.action ?? 'cancel', fromHex(o.root ?? rootKey()), fromHex(o.member ?? memberKey()), o.epoch ?? 1, Uint8Array.from(salt))));
  return google.sign({ iss: GOOGLE_ISS, aud: o.aud ?? SHARED, sub: o.sub ?? G, ...(nonce === undefined ? {} : { nonce }), exp: Math.floor(Date.now() / 1000) + 600, ...o.claims });
}

const bodyOf = (jwt: string, o: { member?: string; epoch?: number; scope?: string; extra?: Record<string, unknown> } = {}): string =>
  JSON.stringify({ jwt, memberKey: o.member ?? memberKey(), epoch: o.epoch ?? 1, salt, scopeId: o.scope ?? scope, ...o.extra });

/** One request by a fresh Home identity of `sub` (G by default). */
async function cancel(raw: string, o: { sub?: string; ip?: string; env?: Partial<typeof env> } = {}): Promise<Response> {
  const id = await newIdentity({ sub: o.sub ?? G });
  return post(raw, id.sign(raw), { ...(o.ip ? { ip: o.ip } : {}), ...(o.env ? { env: o.env } : {}) });
}

const cancels = () => near.sent.filter((t) => t.method === 'cancel_link');
const refusal = async (r: Response): Promise<[number, unknown, unknown]> => {
  const b = await json(r);
  return [r.status, b.code, b.reason];
};

async function seedShare(appId: string, path: string): Promise<Uint8Array> {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, created_at, idle_until, abs_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)',
  )
    .bind(id, appId, crypto.getRandomValues(new Uint8Array(32)), await sha256(new TextEncoder().encode(path)), 'https://wallet.example.com', new Uint8Array(8), now, now + 3_600_000)
    .run();
  return id;
}
const revokedAt = async (id: Uint8Array): Promise<number | null> => ((await env.DB.prepare('SELECT revoked_at FROM vault_shares WHERE share_id = ?1').bind(id).first<{ revoked_at: number | null }>())?.revoked_at ?? null);

beforeEach(() => {
  G = `1${uid().replace(/\D/gu, '').padEnd(12, '7').slice(0, 12)}`;
  scope = `s${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
  near = withEmail(chain({ [OWN]: scope }, { shared: [SHARED] }), [scope]);
  near.allowShared.add(scope);
  near.contract.cancel_link = () => null;
  near.install();
  waitingAccount();
});
afterEach(() => vi.restoreAllMocks());

describe('POST /v1/home/link/cancel: the cancel', () => {
  it('relays one cancel_link from the session pool with the proof’s exact arguments; the account’s shares end; one event for Journear’s own org', async () => {
    const app = await seedApp({ scope });
    const share = await seedShare(app.id, `${scope}#google#${G}#0`);
    const other = await seedShare(app.id, `${scope}#google#someone-else#0`);
    const jwt = await proof();
    const r = await cancel(bodyOf(jwt));
    const b = await json(r);
    expect(r.status, JSON.stringify(b)).toBe(200);
    expect(b.result).toBeNull();
    expect(typeof b.nearTx).toBe('string');
    expect(cancels()).toHaveLength(1);
    const tx = cancels()[0]!;
    expect(tx.args).toEqual({ scope_id: scope, jwt, member_key: memberKey(), epoch: 1, salt });
    // The session pool (the method the window's cancel uses), never the Home pool, which relays only derives.
    expect(sessionKeys).toContain(tx.publicKey);
    expect(homeKeys).not.toContain(tx.publicKey);
    expect(POOL_METHODS.home).not.toContain('cancel_link');
    // The account's shares are revoked (its devices sign in again); nobody else's.
    expect(await revokedAt(share)).not.toBeNull();
    expect(await revokedAt(other)).toBeNull();
    // One usage event: no app, Journear's org, the session key and nonce that signed it, nothing of the user.
    const events = ledger.events.filter((e) => e.endpoint === 'home_link_cancel' && e.scope_id === scope);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(usageEventV1.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ endpoint: 'home_link_cancel', org_id: HANA, app_id: null, scope_id: scope, outcome: 'ok', code: null, status: 200, relayed: true, near_tx: b.nearTx, relayer_pk: tx.publicKey });
    expect(e.uid).toBeUndefined();
    for (const text of [JSON.stringify(e), JSON.stringify(b)]) {
      expect(text).not.toContain(G);
      expect(text).not.toContain(jwt);
      expect(text).not.toContain(memberKey());
    }
  });

  it('an active member of the wallet (not its root) cancels another waiting sign-in', async () => {
    // The wallet is an email's; Home's Google account is an active member; another Google account... here an email waits.
    const root = 'e1.root';
    near.identities.set(`email#${root}`, { status: 'own', opened: true });
    near.identities.set(`google#${G}`, { status: 'member', opened: false, root: { provider: 'email', sub: root } });
    near.identities.set(`email#${E}`, { status: 'pending', opened: false, root: { provider: 'email', sub: root } });
    near.accounts.set(`email#${root}`, { root: { provider: 'email', sub: root }, members: [{ provider: 'google', sub: G, active: true }, { provider: 'email', sub: E, active: false }], epoch: 4 });
    fresh();
    const rk = ikSync(scope, 'email', root);
    const r = await cancel(bodyOf(await proof({ root: rk, epoch: 4 }), { epoch: 4 }));
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    expect(cancels()).toHaveLength(1);
  });

  it('logs nothing of the user: no token, sub or identity key in any line', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const jwt = await proof();
    expect((await cancel(bodyOf(jwt))).status).toBe(200);
    expect((await cancel(bodyOf(await proof({ sub: 'someone-else' })))).status).toBe(403);
    const all = lines.join('\n');
    expect(all).toContain(HOME_LINK_CANCEL_ENDPOINT);
    for (const secret of [G, jwt, memberKey(), rootKey(), 'someone-else']) expect(all).not.toContain(secret);
  });
});

describe('POST /v1/home/link/cancel: the Home gate', () => {
  it('only from Passport Home’s origin, with its signed header, each counter once; OPTIONS from Home only; POST only', async () => {
    const raw = bodyOf(await proof());
    const id = await newIdentity({ sub: G });
    expect(await refusal(await post(raw, id.sign(raw), { origin: 'https://evil.example' }))).toEqual([403, 'origin_not_allowed', undefined]);
    expect(await refusal(await post(raw, id.sign(raw), { origin: null }))).toEqual([403, 'origin_not_allowed', undefined]);
    expect(await refusal(await post(raw, null))).toEqual([401, 'missing_home_identity', undefined]);
    // A signature over another body (the request was changed on the way).
    expect(await refusal(await post(bodyOf(await proof(), { epoch: 2 }), id.sign(raw)))).toEqual([401, 'invalid_signature', undefined]);
    // The same signed request twice: the second is refused before anything is read.
    const header = id.sign(raw);
    expect((await post(raw, header)).status).toBe(200);
    expect(await refusal(await post(raw, header))).toEqual([409, 'counter_reused', undefined]);
    expect(cancels()).toHaveLength(1);
    const pre = await call(HOME_LINK_CANCEL_ENDPOINT, { method: 'OPTIONS', headers: { origin: AUTH } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(AUTH);
    expect((await call(HOME_LINK_CANCEL_ENDPOINT, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(HOME_LINK_CANCEL_ENDPOINT, { method: 'GET', headers: { origin: AUTH } })).status).toBe(405);
  });

  it('per IP: the eleventh request in a minute is refused before anything is read', async () => {
    const ip = randomIp();
    for (let i = 0; i < HOME_LINK_CANCEL_PER_IP_MINUTE; i++) await post('{}', null, { ip });
    expect(await refusal(await post('{}', null, { ip }))).toEqual([429, 'rate_limited', undefined]);
    expect(cancels()).toHaveLength(0);
  });

  it('an email Home sign-in is refused (Google only): an email owner cancels in the app’s sign-in window', async () => {
    near.exit = [['email', HOME_EMAIL_AUDIENCE]];
    fresh();
    const raw = bodyOf(await proof());
    const id = await newIdentity({ sub: E, provider: 'email' });
    const r = await post(raw, id.sign(raw));
    expect(await refusal(r)).toEqual([403, 'google_only', undefined]);
    expect(cancels()).toHaveLength(0);
  });
});

describe('POST /v1/home/link/cancel: the body and the proof', () => {
  it('exactly the five fields, each well formed', async () => {
    const jwt = await proof();
    const bad = [
      JSON.stringify({ jwt, memberKey: memberKey(), epoch: 1, salt }),
      bodyOf(jwt, { extra: { rootKey: rootKey() } }),
      bodyOf(jwt, { member: memberKey().toUpperCase() }),
      bodyOf(jwt, { member: 'ab' }),
      bodyOf(jwt, { epoch: -1 }),
      bodyOf(jwt, { epoch: 1.5 }),
      JSON.stringify({ jwt, memberKey: memberKey(), epoch: 1, salt: [1, 2, 3], scopeId: scope }),
      bodyOf(jwt, { scope: 'Not A Scope' }),
      bodyOf('not-a-token'),
      '[1]',
      'not json',
    ];
    for (const raw of bad) expect(await refusal(await cancel(raw)), raw).toEqual([400, 'bad_request', undefined]);
    expect(toHomeLinkCancel(new TextEncoder().encode(bodyOf(jwt)))).toEqual({ jwt, memberKey: memberKey(), epoch: 1, salt, scopeId: scope });
    expect(cancels()).toHaveLength(0);
  });

  it('a proof that isn’t genuine, has no nonce, or carries more than the allowed claims is refused', async () => {
    const forged = (await proof()).replace(/\.[^.]+$/u, '.AAAA');
    expect((await cancel(bodyOf(forged))).status).toBeGreaterThanOrEqual(400);
    expect(await refusal(await cancel(bodyOf(await proof({ nonce: null }))))).toEqual([400, 'nonce_mismatch', undefined]);
    const pii = await cancel(bodyOf(await proof({ claims: { email: 'a@example.com' } })));
    expect([pii.status, (await json(pii)).code]).toEqual([400, 'token_has_pii']);
    expect(cancels()).toHaveLength(0);
  });

  it('a proof of another Google account than Home’s sign-in is refused, even with the right nonce', async () => {
    const r = await cancel(bodyOf(await proof({ sub: 'another-google-account' })));
    expect(await refusal(r)).toEqual([403, 'home_account_mismatch', undefined]);
    // And Home signed in as someone else, with this wallet's root's proof.
    expect(await refusal(await cancel(bodyOf(await proof()), { sub: 'another-google-account' }))).toEqual([403, 'home_account_mismatch', undefined]);
    expect(cancels()).toHaveLength(0);
  });

  it('only the shared Google client, admitted for this scope: never the scope’s own client, an unknown client, or a scope without shared login', async () => {
    expect(await refusal(await cancel(bodyOf(await proof({ aud: OWN }))))).toEqual([403, 'not_shared_client', undefined]);
    expect(await refusal(await cancel(bodyOf(await proof({ aud: 'unknown.apps.googleusercontent.com' }))))).toEqual([403, 'not_shared_client', undefined]);
    near.allowShared.delete(scope);
    fresh();
    expect(await refusal(await cancel(bodyOf(await proof())))).toEqual([403, 'shared_login_disabled', undefined]);
    expect(cancels()).toHaveLength(0);
  });

  it('nothing while the contract is paused', async () => {
    near.paused = true;
    fresh();
    const r = await cancel(bodyOf(await proof()));
    expect(await refusal(r)).toEqual([503, 'paused', undefined]);
    expect(cancels()).toHaveLength(0);
  });
});

describe('POST /v1/home/link/cancel: the chain’s rules, stricter than the window', () => {
  it('the unlink nonce, another member’s nonce, a stale epoch, an active member, the root, a member of another wallet: refused before any gas', async () => {
    expect(await refusal(await cancel(bodyOf(await proof({ action: 'unlink' }))))).toEqual([422, 'link_refused', 'link_mismatch']);
    const otherKey = ikSync(scope, 'email', 'e1.someone');
    expect(await refusal(await cancel(bodyOf(await proof({ member: otherKey }), { member: otherKey })))).toEqual([422, 'link_refused', 'no_such_member']);
    // The proof says member A, the body names member B: the nonce doesn't match.
    expect(await refusal(await cancel(bodyOf(await proof({ member: otherKey }))))).toEqual([422, 'link_refused', 'link_mismatch']);
    expect(await refusal(await cancel(bodyOf(await proof({ epoch: 0 }), { epoch: 0 })))).toEqual([422, 'link_refused', 'stale_epoch']);
    expect(await refusal(await cancel(bodyOf(await proof({ member: rootKey() }), { member: rootKey() })))).toEqual([422, 'link_refused', 'no_such_member']);
    // A proof for another scope's wallet: the identity has no account there.
    const elsewhere = `o${uid()}`.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 60);
    near.allowShared.add(elsewhere);
    expect(await refusal(await cancel(bodyOf(await proof({ scope: elsewhere }), { scope: elsewhere })))).toEqual([422, 'link_refused', 'no_such_member']);
    // The wait ended: an active member is a removal, never a cancel.
    waitingAccount({ active: true });
    expect(await refusal(await cancel(bodyOf(await proof())))).toEqual([422, 'link_refused', 'no_such_member']);
    expect(cancels()).toHaveLength(0);
  });

  it('a cancel of a member of someone else’s wallet: the nonce over their root and member, by an identity outside that account', async () => {
    const victim = `1${uid().replace(/\D/gu, '').padEnd(12, '3').slice(0, 12)}`;
    near.identities.set(`google#${victim}`, { status: 'own', opened: true });
    near.identities.set(`email#e1.victim`, { status: 'pending', opened: false, root: { provider: 'google', sub: victim } });
    near.accounts.set(`google#${victim}`, { root: { provider: 'google', sub: victim }, members: [{ provider: 'email', sub: 'e1.victim', active: false }], epoch: 1 });
    fresh();
    const vRoot = ikSync(scope, 'google', victim);
    const vMember = ikSync(scope, 'email', 'e1.victim');
    // G's own proof over the victim's root and member: G's account has no such member.
    const r = await cancel(bodyOf(await proof({ root: vRoot, member: vMember }), { member: vMember }));
    expect(await refusal(r)).toEqual([422, 'link_refused', 'no_such_member']);
    expect(cancels()).toHaveLength(0);
  });

  it('the waiting sign-in itself never cancels from Home, and a waiting sign-in never cancels another (the window allows the first; Home doesn’t)', async () => {
    // Home signed in as the waiting Google account of an email wallet.
    const root = 'e1.root';
    near.identities.set(`email#${root}`, { status: 'own', opened: true });
    near.identities.set(`google#${G}`, { status: 'pending', opened: false, root: { provider: 'email', sub: root } });
    near.identities.set(`email#${E}`, { status: 'pending', opened: false, root: { provider: 'email', sub: root } });
    near.accounts.set(`email#${root}`, { root: { provider: 'email', sub: root }, members: [{ provider: 'google', sub: G, active: false }, { provider: 'email', sub: E, active: false }], epoch: 2 });
    fresh();
    const rk = ikSync(scope, 'email', root);
    const self = ikSync(scope, 'google', G);
    expect(await refusal(await cancel(bodyOf(await proof({ root: rk, member: self, epoch: 2 }), { member: self, epoch: 2 })))).toEqual([422, 'link_refused', 'not_allowed']);
    const r = await cancel(bodyOf(await proof({ root: rk, epoch: 2 }), { epoch: 2 }));
    expect([r.status, (await json(r)).code]).toEqual([409, 'link_pending']);
    expect(cancels()).toHaveLength(0);
  });
});

describe('POST /v1/home/link/cancel: once only, the limits, a failed relay', () => {
  it('one relay per proof: the same proof again from Home, or through the window’s /v1/link/cancel, is refused while the first stands', async () => {
    const app = await seedApp({ scope });
    const jwt = await proof();
    expect((await cancel(bodyOf(jwt))).status).toBe(200);
    expect(await refusal(await cancel(bodyOf(jwt)))).toEqual([409, 'link_in_flight', undefined]);
    const window = await call('/v1/link/cancel', { headers: hanaHeaders(app), body: { jwt, memberKey: memberKey(), epoch: 1, salt }, env: emailEnv() });
    expect([window.status, (await json(window)).code]).toEqual([409, 'link_in_flight']);
    expect(cancels()).toHaveLength(1);
  });

  it('a relay that certainly didn’t run gives the proof back (it can be sent again); a contract refusal is reverted and says why', async () => {
    const jwt = await proof();
    const noKey = await cancel(bodyOf(jwt), { env: { RELAYER_KEYS: '[]' } });
    expect([noKey.status, (await json(noKey)).code]).toEqual([503, 'relayer_unconfigured']);
    expect(ledger.events.filter((e) => e.scope_id === scope).map((e) => [e.endpoint, e.outcome, e.code, e.relayed])).toEqual([['home_link_cancel', 'error', 'relayer_unconfigured', false]]);
    // The epoch moved on chain between the precheck and the transaction: the contract's own refusal.
    near.contract.cancel_link = () => {
      throw new Error('Wrong epoch');
    };
    const late = await cancel(bodyOf(jwt));
    expect(await refusal(late)).toEqual([422, 'contract_rejected', 'stale_epoch']);
    expect(cancels()).toHaveLength(1);
    expect(ledger.events.filter((e) => e.scope_id === scope).map((e) => [e.endpoint, e.outcome, e.relayed]).at(-1)).toEqual(['home_link_cancel', 'rejected', true]);
  });

  it('the account’s link changes per minute are shared with the window’s route', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      const s = Array.from(crypto.getRandomValues(new Uint8Array(32)));
      const nonce = await linkChangeNonce(env.SIGNER_ACCOUNT, scope, 'cancel', fromHex(rootKey()), fromHex(memberKey()), 1, Uint8Array.from(s));
      const jwt = await google.sign({ iss: GOOGLE_ISS, aud: SHARED, sub: G, nonce, exp: Math.floor(Date.now() / 1000) + 600 });
      last = await cancel(JSON.stringify({ jwt, memberKey: memberKey(), epoch: 1, salt: s, scopeId: scope }));
      if (last.status === 429) break;
    }
    expect(await refusal(last!)).toEqual([429, 'rate_limited', undefined]);
    expect(cancels()).toHaveLength(10);
  });
});
