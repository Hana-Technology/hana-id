// Test doubles for the issuer: an in-memory hana-signer (identities, accounts, links, opened), Google behind a fake
// fetch (JWKS, tokeninfo, userinfo, revoke; the real Google client code runs against it), a recording sender, and a
// `call` that runs a request through the real router with the Worker's real bindings (D1, Durable Objects, secrets).
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { base64UrlDecode, base64UrlEncode, fromUtf8, sha256, toHex, utf8 } from '../src/bytes.ts';
import type { AccountView, Chain, IdentityView, ScopeView } from '../src/chain.ts';
import type { Deps } from '../src/deps.ts';
import { GOOGLE_TOKENINFO_URL, GOOGLE_USERINFO_URL, Google } from '../src/google.ts';

/** Google's revocation endpoint: the issuer must never call it (D265); the fake records any call. */
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
import { route } from '../src/handlers.ts';
import { importKeys, importSealKey, mailboxKey } from '../src/keys.ts';
import { parseChallengeId } from '../src/challenge-id.ts';
import { normalizeEmail } from '@hana-id/email';
import { identityKey, sessionNonceOf, type SessionCommitment } from '../src/layouts.ts';
import type { EmailSender, MailMessage, SendResult } from '../src/sender.ts';
import { type IssuerSigner, WorkerSecretSigner, parsePublicKeys, verifyRs256 } from '../src/signer.ts';

export const AUTH = 'https://auth.test';
export const VAULT = 'https://vault.test';
export const GOOGLE_CLIENT = 'app-client.apps.googleusercontent.com';
export const SHARED_CLIENT = 'shared.apps.googleusercontent.com';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

let counter = 0;
export const uid = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const newPk = (): string => `pk_test_${Array.from({ length: 32 }, () => B58[Math.floor(Math.random() * B58.length)]).join('')}`;

// ---- chain ----

interface AccountRec {
  rootProvider: string;
  rootSub: string;
  members: { key: string; provider: string; active: boolean }[];
  epoch: number;
  unlinked: string[];
}

/** An in-memory hana-signer with the views the issuer reads (links.rs semantics, simplified). */
export class FakeChain implements Chain {
  readonly scopes = new Map<string, ScopeView>();
  shared: string[] = [SHARED_CLIENT];
  unrecorded = false;
  readonly opened = new Set<string>();
  /** member ik → root ik */
  readonly links = new Map<string, string>();
  readonly accounts = new Map<string, AccountRec>();
  readonly calls: string[] = [];
  failViews = false;

  ik(scope: string, provider: string, sub: string): string {
    return toHex(identityKey(scope, provider, sub));
  }
  addScope(scopeId: string, opts: { email?: boolean; google?: string[]; allowShared?: boolean; actionNonce?: number } = {}): void {
    const clients: [string, string][] = [...(opts.google ?? [GOOGLE_CLIENT]).map((a): [string, string] => ['google', a])];
    if (opts.email !== false) clients.push(['email', `email:${scopeId}`]);
    this.scopes.set(scopeId, { clients, allowShared: opts.allowShared ?? false, actionNonce: opts.actionNonce ?? 0 });
  }
  open(scope: string, provider: string, sub: string): void {
    this.opened.add(this.ik(scope, provider, sub));
  }
  /** `member` joins the account of `root` (created if needed); bumps the epoch. */
  link(scope: string, root: [string, string], member: [string, string], active = true): void {
    const r = this.ik(scope, ...root);
    const m = this.ik(scope, ...member);
    const acc = this.accounts.get(r) ?? { rootProvider: root[0], rootSub: root[1], members: [], epoch: 0, unlinked: [] };
    acc.members.push({ key: m, provider: member[0], active });
    acc.epoch += 1;
    this.accounts.set(r, acc);
    this.links.set(m, r);
  }
  unlink(scope: string, root: [string, string], member: [string, string]): void {
    const r = this.ik(scope, ...root);
    const m = this.ik(scope, ...member);
    const acc = this.accounts.get(r)!;
    acc.members = acc.members.filter((x) => x.key !== m);
    acc.unlinked.push(m);
    acc.epoch += 1;
    this.links.delete(m);
  }
  bumpEpoch(scope: string, root: [string, string]): void {
    const acc = this.accounts.get(this.ik(scope, ...root));
    if (acc) acc.epoch += 1;
  }

  async scope(scopeId: string): Promise<ScopeView | null> {
    this.calls.push('get_scope');
    return this.scopes.get(scopeId) ?? null;
  }
  async sharedGoogleClients(): Promise<string[]> {
    return this.shared;
  }
  async unrecordedWallets(): Promise<boolean> {
    return this.unrecorded;
  }
  async identity(scope: string, provider: string, sub: string): Promise<IdentityView> {
    this.calls.push('get_identity');
    if (this.failViews) throw new (await import('../src/chain.ts')).ChainUnavailable('down');
    const key = this.ik(scope, provider, sub);
    const rootKey = this.links.get(key);
    const acc = this.accounts.get(rootKey ?? key);
    const member = rootKey ? acc!.members.find((m) => m.key === key) : undefined;
    return {
      key,
      status: member ? (member.active ? 'member' : 'pending') : 'own',
      opened: this.opened.has(key),
      root: rootKey ? { provider: acc!.rootProvider, sub: acc!.rootSub } : null,
      accountEpoch: acc?.epoch ?? 0,
    };
  }
  async account(scope: string, provider: string, sub: string): Promise<AccountView | null> {
    this.calls.push('get_account');
    const key = this.ik(scope, provider, sub);
    const acc = this.accounts.get(this.links.get(key) ?? key);
    if (!acc) return null;
    return { root: { provider: acc.rootProvider, sub: acc.rootSub }, members: acc.members.map((m) => ({ ...m })), epoch: acc.epoch, unlinked: [...acc.unlinked] };
  }
}

// ---- Google ----

export interface GoogleAccount {
  sub: string;
  email: string;
  emailVerified?: boolean;
  hd?: string;
  /** tokeninfo answers for this audience (default: the ID token's). */
  tokenAud?: string;
  tokenSub?: string;
}

export class FakeGoogle {
  readonly revoked: string[] = [];
  readonly requests: { url: string; body: string; auth: string | null }[] = [];
  private key!: CryptoKeyPair;
  private jwk!: JsonWebKey;
  readonly kid = 'google-test-kid';
  /** access token → account */
  readonly tokens = new Map<string, { account: GoogleAccount; aud: string }>();
  userinfoStatus = 200;

  static async create(): Promise<FakeGoogle> {
    const g = new FakeGoogle();
    g.key = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    g.jwk = (await crypto.subtle.exportKey('jwk', g.key.publicKey)) as JsonWebKey;
    return g;
  }

  async idToken(account: GoogleAccount, aud: string, nonce: string, over: Record<string, unknown> = {}): Promise<string> {
    const header = base64UrlEncode(utf8(JSON.stringify({ alg: 'RS256', kid: this.kid, typ: 'JWT' })));
    const now = Math.floor(Date.now() / 1000);
    const claims = base64UrlEncode(utf8(JSON.stringify({ iss: 'https://accounts.google.com', aud, sub: account.sub, iat: now, exp: now + 3600, nonce, ...over })));
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.key.privateKey, utf8(`${header}.${claims}`)));
    return `${header}.${claims}.${base64UrlEncode(sig)}`;
  }

  /** A fresh access token for `account`, issued to `aud`. */
  accessToken(account: GoogleAccount, aud: string): string {
    const t = `ya29.${uid()}${uid()}`;
    this.tokens.set(t, { account, aud });
    return t;
  }

  readonly fetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const auth = new Headers(init?.headers).get('authorization');
    this.requests.push({ url, body, auth });
    const j = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url === GOOGLE_JWKS) return j(200, { keys: [{ ...this.jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
    if (url === GOOGLE_TOKENINFO_URL) {
      const t = this.tokens.get(new URLSearchParams(body).get('access_token') ?? '');
      if (!t) return j(400, { error: 'invalid_token' });
      return j(200, { aud: t.account.tokenAud ?? t.aud, azp: t.account.tokenAud ?? t.aud, sub: t.account.tokenSub ?? t.account.sub, scope: 'openid email', expires_in: '3500' });
    }
    if (url === GOOGLE_USERINFO_URL) {
      const t = this.tokens.get((auth ?? '').replace(/^Bearer /u, ''));
      if (!t || this.userinfoStatus !== 200) return j(this.userinfoStatus === 200 ? 401 : this.userinfoStatus, { error: 'invalid_token' });
      const a = t.account;
      return j(200, { sub: a.sub, email: a.email, email_verified: a.emailVerified ?? true, ...(a.hd ? { hd: a.hd } : {}) });
    }
    if (url === GOOGLE_REVOKE_URL) {
      const token = new URLSearchParams(body).get('token') ?? '';
      this.revoked.push(token);
      this.tokens.delete(token);
      return new Response('', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

// ---- sender ----

export class RecordingSender implements EmailSender {
  readonly name = 'recording';
  readonly sent: MailMessage[] = [];
  next: SendResult = { ok: true };
  async send(m: MailMessage): Promise<SendResult> {
    if (this.next.ok) this.sent.push(m);
    return this.next;
  }
  /** The code in the last mail to `to`. */
  codeFor(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to && x.kind === 'code');
    if (!m) throw new Error(`no code mail to ${to}`);
    return /\n(\d{6})\n/u.exec(m.text)![1]!;
  }
  to(addr: string): MailMessage[] {
    return this.sent.filter((m) => m.to === addr);
  }
}

// ---- the harness ----

export interface Harness {
  deps: Deps;
  chain: FakeChain;
  google: FakeGoogle;
  sender: RecordingSender;
  clock: { now: number };
  /** `ip: null` sends no cf-connecting-ip; `contentType: null` none. */
  call: (path: string, body: unknown, opts?: { origin?: string | null; ip?: string | null; headers?: Record<string, string>; method?: string; contentType?: string | null }) => Promise<Response>;
}

let googleSingleton: FakeGoogle | null = null;

export async function harness(over: Partial<Deps> = {}): Promise<Harness> {
  const chain = new FakeChain();
  googleSingleton ??= await FakeGoogle.create();
  const google = googleSingleton;
  const sender = new RecordingSender();
  const clock = { now: Date.now() };
  const pending: Promise<unknown>[] = [];
  const publicKeys = await parsePublicKeys(env.EMAIL_PUBLIC_KEYS);
  const signer = await WorkerSecretSigner.create(env.ISSUER_SIGNING_KEY, env.EMAIL_ACTIVE_KID);
  const keys = await importKeys(env);
  const deps: Deps = {
    // Each harness its own env name: limiter objects are named `<env>:<subject>`, so tests never share a window. `t-…`
    // is not a dev name (`isDevEnv`), so every test runs under the production limits unless it names a dev env (D340).
    env: { ...env, ENV_NAME: `t-${uid()}` },
    now: () => clock.now,
    chain,
    google: new Google(google.fetch, () => clock.now),
    sender,
    signers: async () => [signer as IssuerSigner],
    publicKeys: async () => publicKeys,
    keys: async () => keys,
    // The env's IDENTITY_SEAL_KEY (vitest.config.ts binds one), as the Worker loads it.
    sealKey: () => importSealKey(env.IDENTITY_SEAL_KEY),
    access: null,
    waitUntil: (p) => void pending.push(p),
    ...over,
  };
  const call: Harness['call'] = async (path, body, opts = {}) => {
    // A random IPv4 address on its own /24 (10.x.y.z: x and y random), so tests don't share aggregate windows.
    const randomIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const headers = new Headers(opts.headers ?? {});
    if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json');
    if (opts.ip !== null) headers.set('cf-connecting-ip', opts.ip ?? randomIp);
    const origin = opts.origin === undefined ? (path.endsWith('/google-match') || path.endsWith('/google-record') ? VAULT : AUTH) : opts.origin;
    if (origin) headers.set('origin', origin);
    const res = await route(new Request(`https://api.test${path}`, { method: opts.method ?? 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
    while (pending.length) await pending.shift();
    return res;
  };
  return { deps, chain, google, sender, clock, call };
}

// ---- apps ----

export interface TestApp {
  id: string;
  pk: string;
  scope: string;
  name: string;
}

export async function seedApp(h: Harness, opts: { methods?: string; status?: string; plan?: string; name?: string; scope?: { email?: boolean; google?: string[]; allowShared?: boolean } } = {}): Promise<TestApp> {
  const id = `app_${uid()}`;
  const pk = newPk();
  const scope = `s${uid().replace(/[^a-z0-9]/gu, '')}`.slice(0, 40);
  const name = opts.name ?? 'Test Wallet';
  // The API's migration 0006: an app's scope row exists in its org, with the environment its key names.
  await env.APP_DB.prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, created_at, assigned_at) VALUES (?1, 'org_legacy', 'test', 0, 0)").bind(scope).run();
  await env.APP_DB.prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, plan, login_methods) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, name, scope, pk, opts.status ?? 'active', opts.plan ?? 'free', opts.methods ?? 'google,email')
    .run();
  // The gate's model (0006): the issuer finds the app by its key in app_keys, never by the legacy column.
  await env.APP_DB.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', 0)").bind(`key_${id}`, id, pk).run();
  h.chain.addScope(scope, opts.scope);
  return { id, pk, scope, name };
}

export async function seedPlan(id: string, perMinute: number, perDay: number): Promise<void> {
  await env.APP_DB.prepare('INSERT OR REPLACE INTO plans (id, per_minute, per_day, per_ip_minute) VALUES (?1, ?2, ?3, 20)').bind(id, perMinute, perDay).run();
}

export function sessionCommitment(scopeId: string, now = Date.now()): SessionCommitment & { json: Record<string, unknown> } {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const c = { scopeId, sessionPublicKey, expiresAtMs: now + 3_600_000, keyIndex: 0, maxUses: 3, salt };
  return { ...c, json: { scopeId, sessionPublicKey: [...sessionPublicKey], expiresAtMs: c.expiresAtMs, keyIndex: 0, maxUses: 3, salt: [...salt] } };
}

export const nonceFor = (c: SessionCommitment): string => sessionNonceOf(env.SIGNER_ACCOUNT, c);

// ---- tokens ----

export interface DecodedToken {
  claims: Record<string, unknown>;
  kids: string[];
  verified: boolean;
}

/** Parses a JWS JSON email token and checks every signature against the published keys. */
export async function decodeToken(token: string): Promise<DecodedToken> {
  const t = JSON.parse(token) as { payload: string; signatures: { protected: string; signature: string }[] };
  expect(Object.keys(t).sort()).toEqual(['payload', 'signatures']);
  const keys = await parsePublicKeys(env.EMAIL_PUBLIC_KEYS);
  let verified = t.signatures.length > 0;
  const kids: string[] = [];
  for (const s of t.signatures) {
    expect(Object.keys(s).sort()).toEqual(['protected', 'signature']);
    const header = JSON.parse(fromUtf8(base64UrlDecode(s.protected))) as Record<string, unknown>;
    expect(Object.keys(header).sort()).toEqual(['alg', 'kid']);
    expect(header.alg).toBe('RS256');
    kids.push(header.kid as string);
    const key = keys.find((k) => k.kid === header.kid);
    verified &&= !!key && (await verifyRs256(key, utf8(`${s.protected}.${t.payload}`), base64UrlDecode(s.signature)));
  }
  return { claims: JSON.parse(fromUtf8(base64UrlDecode(t.payload))) as Record<string, unknown>, kids, verified };
}

/** Every log line written while `f` runs (console.log, warn, error). */
export async function captureLogs<T>(f: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))));
  try {
    return { result: await f(), lines };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

export const sha256Hex = (s: string): string => toHex(sha256(utf8(s)));


/** Runs a full email session login: start, code from the mail, verify. */
export async function emailLogin(h: Harness, app: TestApp, email: string, normalized = email): Promise<{ idToken?: string; googleWallet: boolean; linkTicket?: string; deviceTicket: string; sealedEmail?: string; commitment: ReturnType<typeof sessionCommitment> }> {
  const commitment = sessionCommitment(app.scope, h.clock.now);
  const s = await h.call('/v1/email/start', { pk: app.pk, email, purpose: 'session', commitment: commitment.json });
  expect(s.status).toBe(202);
  const { challengeId } = (await s.json()) as { challengeId: string };
  const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(normalized) });
  expect(v.status).toBe(200);
  return { ...((await v.json()) as { idToken?: string; googleWallet: boolean; linkTicket?: string; deviceTicket: string; sealedEmail?: string }), commitment };
}

export { env };

/** The Durable Object name of a challenge id (challenge-id.ts). */
export function challengeObject(challengeId: unknown) {
  const c = parseChallengeId(challengeId);
  if (!c) throw new Error('not a challenge id');
  return env.EMAIL_CHALLENGE.get(env.EMAIL_CHALLENGE.idFromName(c.name));
}

/** The mailbox limiter object of an address (as the issuer names it). */
export async function mailboxObject(h: Harness, email: string) {
  const r = normalizeEmail(email);
  if (!r.ok) throw new Error('bad test address');
  const key = await mailboxKey(await h.deps.keys(), r.mailbox);
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h.deps.env.ENV_NAME}:mbx:${key}`));
}
