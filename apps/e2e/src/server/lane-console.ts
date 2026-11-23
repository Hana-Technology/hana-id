// The partner console in an admin lane (D899): apps/console's REAL Worker (its routes, its CONSOLE_DB, its fresh sign-in)
// and its built SPA, on an origin of its own per browser lane (stack.ts CONSOLE_LANES), over the lane's own API
// (ConsoleRpc, the same copy the staff portal and lane-labels.ts reach), so a test drives the Request labels tab
// against what staff see. Two stand-ins, at the edge, as the Access stand-in is for the admin portal; the product
// decides everything behind them:
//
//   SIGN-IN   `GET /__e2e/console/sign-in?to=/path` on the console origin: the lane labels org's owner (the Google
//             `sub` the lane's chain lists as an on-chain owner of its scope) as a console member and owner, and a
//             session made by the console's own `createSession`, its cookie set, then the page. (The console's Google
//             sign-in itself is tested in apps/console.)
//   GOOGLE    the fresh sign-in: the console's real `/start` (on the console's auth origin, apps/console's
//             `handleAuthOrigin`, as console-auth forwards it) answers its 303 to Google; the edge answers for Google
//             at once, as the scope owner consenting: back to the real `/callback` with a code. The console's own code
//             exchange reaches `oauth2.googleapis.com/token` in this thread's fetch, answered here with an ID token
//             signed by the lane's Google key (lane-labels.ts) for exactly that flow's nonce, after the PKCE verifier
//             checks out. The console verifies it (JWKS, audience, nonce, iat, the claim allow-list), runs the action,
//             and the API verifies the token again (the label-change nonce, an on-chain owner). Never logged or answered.
//   TLS       browsers keep a `Secure` cookie only from https (WebKit not even on loopback), and the console's cookies
//             are `__Host-…; Secure`: the edge renames them on the way out (`e2e-host-…`, without `Secure`) and back on
//             the way in, so the Worker sets and reads exactly its own cookies.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { D1Shim } from './d1.ts';
import { json } from './http.ts';
import type { LabelsLane } from './lane-labels.ts';
import { LANE_CONSOLE_AUD, LANE_OWNER_SUB } from './lane-labels.ts';

const SRC = (path: string): string => new URL(`../../../console/src/${path}`, import.meta.url).href;
const consoleWorker = (await import(SRC('index.ts'))) as { default: { fetch(request: Request, env: unknown): Promise<Response> } };
const { handleAuthOrigin } = (await import(SRC('auth-handler.ts'))) as { handleAuthOrigin(request: Request, env: unknown): Promise<Response> };
const { createSession } = (await import(SRC('sessions.ts'))) as { createSession(db: unknown, s: { userId: string; hd: string | null; now: number }): Promise<{ cookieValue: string }> };

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The lane owner's console account (lane-only test values). */
export const LANE_CONSOLE_USER = 'usr_e2elabelsowner';
export const LANE_CONSOLE_EMAIL = 'owner@stamp-rally.e2e.invalid';
const HOST_PREFIX = '__Host-';
const STAND_IN_PREFIX = 'e2e-host-';

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export interface ConsoleLaneDeps {
  origin: string;
  authOrigin: string;
  /** The SPA's build (src/build.ts `CONSOLE_DIR`). */
  dist: string;
  db: D1Shim;
  /** The lane's ConsoleRpc, as a service binding. */
  api: object;
  labels: LabelsLane;
  signer: string;
  nearRpc: string;
  envName: string;
}

/** `__Host-x=…; Secure; …` → `e2e-host-x=…; …` (a Set-Cookie line). */
const outCookie = (line: string): string => (line.startsWith(HOST_PREFIX) ? `${STAND_IN_PREFIX}${line.slice(HOST_PREFIX.length)}`.replace(/;\s*Secure(?=;|$)/giu, '') : line);
/** `e2e-host-x=…` → `__Host-x=…` (a Cookie header). */
const inCookies = (header: string | null): string | null => header && header.split(/;\s*/u).map((c) => (c.startsWith(STAND_IN_PREFIX) ? `${HOST_PREFIX}${c.slice(STAND_IN_PREFIX.length)}` : c)).join('; ');

const b64url = (b: Buffer): string => b.toString('base64url');

export class ConsoleLane {
  readonly env: Record<string, unknown>;
  /** Codes the Google stand-in issued, each once: its flow's nonce, the PKCE challenge and the account. */
  private readonly codes = new Map<string, { nonce: string; challenge: string; sub: string; clientId: string; redirectUri: string }>();

  constructor(private readonly d: ConsoleLaneDeps) {
    this.env = {
      ENV_NAME: d.envName,
      CONSOLE_ORIGIN: d.origin,
      CONSOLE_AUTH_ORIGIN: d.authOrigin,
      CONSOLE_GOOGLE_CLIENT_ID: LANE_CONSOLE_AUD,
      // A lane-only stand-in value: the token endpoint here doesn't check it.
      CONSOLE_GOOGLE_CLIENT_SECRET: 'e2e-lane-console-secret',
      FILES_ORIGIN: 'http://files.e2e.invalid',
      NEAR_RPC: d.nearRpc,
      SIGNER_ACCOUNT: d.signer,
      NETWORK: 'testnet',
      OWNER_GRANT_DELAY_MS: String(24 * 3_600_000),
      CONSOLE_DB: d.db,
      API: d.api,
      ASSETS: { fetch: (r: Request) => this.asset(r) },
      CONSOLE_IP_LIMIT: { limit: async () => ({ success: true }) },
    };
  }

  /** Whether `url` is one of this lane's console origins. */
  serves(url: URL): boolean {
    return url.origin === this.d.origin || url.origin === this.d.authOrigin;
  }

  /** The SPA's assets binding: a file of the build, else index.html (single-page application). */
  private async asset(request: Request): Promise<Response> {
    const root = this.d.dist.endsWith(sep) ? this.d.dist : `${this.d.dist}${sep}`;
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    try {
      if (!file.startsWith(root)) throw new Error('outside');
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response(await readFile(join(root, 'index.html')), { headers: { 'content-type': TYPES['.html']! } });
    }
  }

  /** The lane labels org's owner as a console member (an owner since yesterday), mirrored from the lane's labels org. */
  private async member(): Promise<{ orgId: string }> {
    const s = await this.d.labels.state();
    const db = this.d.db.db;
    const now = Date.now();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name, kind, status, created_at) VALUES (?, 'Stamp Rally Ltd', 'partner', 'active', ?)").run(s.orgId, now);
    db.prepare("INSERT OR IGNORE INTO console_users (id, provider, sub, email, created_at) VALUES (?, 'google', ?, ?, ?)").run(LANE_CONSOLE_USER, LANE_OWNER_SUB, LANE_CONSOLE_EMAIL, now);
    db.prepare("INSERT OR IGNORE INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, 'owner', ?, 'e2e', ?)").run(s.orgId, LANE_CONSOLE_USER, now - 86_400_000, now - 86_400_000);
    return { orgId: s.orgId };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === this.d.origin && url.pathname === '/__e2e/console/sign-in' && request.method === 'GET') {
      const { orgId } = await this.member();
      const { cookieValue } = await createSession(this.d.db, { userId: LANE_CONSOLE_USER, hd: null, now: Date.now() });
      const to = (url.searchParams.get('to') ?? `/orgs/${orgId}`).replaceAll('{org}', orgId);
      const target = /^\/(?!\/)[^\s\\]*$/u.test(to) ? to : '/';
      return new Response(null, { status: 302, headers: { location: target, 'set-cookie': `${STAND_IN_PREFIX}hana_cs=${cookieValue}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' } });
    }
    if (url.pathname.startsWith('/__e2e/')) return json(404, { error: 'not_found' });
    const headers = new Headers(request.headers);
    const cookie = inCookies(request.headers.get('cookie'));
    if (cookie) headers.set('cookie', cookie);
    headers.set('cf-connecting-ip', '127.0.0.1');
    const init: RequestInit = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
    const inner = new Request(request.url, init);
    let res = url.origin === this.d.authOrigin ? await handleAuthOrigin(inner, this.env) : await consoleWorker.default.fetch(inner, this.env);
    if (url.origin === this.d.authOrigin && url.pathname === '/start') res = this.google(res);
    return this.withCookies(res);
  }

  /** The Google stand-in: the console's 303 to Google answered at once, back to its callback with a code for that flow. */
  private google(res: Response): Response {
    const location = res.headers.get('location');
    if (res.status !== 303 || !location?.startsWith('https://accounts.google.com/')) return res;
    const g = new URL(location).searchParams;
    const code = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(24))));
    this.codes.set(code, { nonce: g.get('nonce') ?? '', challenge: g.get('code_challenge') ?? '', sub: g.get('login_hint') ?? LANE_OWNER_SUB, clientId: g.get('client_id') ?? '', redirectUri: g.get('redirect_uri') ?? '' });
    const back = new URL(g.get('redirect_uri') ?? `${this.d.authOrigin}/callback`);
    back.search = new URLSearchParams({ state: g.get('state') ?? '', code }).toString();
    const headers = new Headers(res.headers);
    headers.set('location', back.href);
    return new Response(null, { status: 303, headers });
  }

  private withCookies(res: Response): Response {
    const set = res.headers.getSetCookie();
    if (set.length === 0) return res;
    const headers = new Headers(res.headers);
    headers.delete('set-cookie');
    for (const c of set) headers.append('set-cookie', outCookie(c));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  /**
   * Google's token endpoint for the console's code exchange: a code the stand-in issued, once, with the verifier of
   * its flow's PKCE challenge, the console's client and redirect URI. Answers an ID token for the flow's nonce.
   */
  async token(body: string): Promise<Response> {
    const p = new URLSearchParams(body);
    const code = p.get('code') ?? '';
    const c = this.codes.get(code);
    this.codes.delete(code);
    const challenge = b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest());
    if (!c || c.challenge !== challenge || p.get('client_id') !== c.clientId || p.get('redirect_uri') !== c.redirectUri || p.get('grant_type') !== 'authorization_code') return json(400, { error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    const idToken = await this.d.labels.idToken({ iss: 'https://accounts.google.com', aud: c.clientId, azp: c.clientId, sub: c.sub, nonce: c.nonce, iat: now, exp: now + 300 });
    return json(200, { id_token: idToken, token_type: 'Bearer', expires_in: 300, scope: 'openid' });
  }
}
