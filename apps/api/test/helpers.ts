import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index.ts';
import { NearMock, makeJwt } from './near-mock.ts';

export const GOOGLE_ISS = 'https://accounts.google.com';
export const ORIGIN = 'https://wallet.example.com';

let counter = 0;
/** Unique-ish suffix so tests don't share rate-limit windows or cache entries. */
export const uid = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** A valid-looking base58 publishable key. */
export const newKey = (prefix: 'pk_test_' | 'pk_live_' = 'pk_test_'): string => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 32; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return prefix + s;
};

export interface SeededApp {
  id: string;
  key: string;
  scope: string;
}

export async function seedPlan(id: string, perMinute: number, perDay: number, perIpMinute: number): Promise<void> {
  await env.DB.prepare('INSERT INTO plans (id, per_minute, per_day, per_ip_minute) VALUES (?1, ?2, ?3, ?4)').bind(id, perMinute, perDay, perIpMinute).run();
}

export async function seedApp(opts: { scope?: string; key?: string; status?: string; plan?: string; origins?: string[] } = {}): Promise<SeededApp> {
  const id = `app_${uid()}`;
  const key = opts.key ?? newKey();
  const scope = opts.scope ?? `s${uid()}`;
  await env.DB.prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, `Test ${id}`, scope, key, opts.status ?? 'active', opts.plan ?? 'free')
    .run();
  for (const origin of opts.origins ?? [ORIGIN]) await env.DB.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?1, ?2)').bind(id, origin).run();
  return { id, key, scope };
}

export async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; rawBody?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  let body: string | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
  const request = new Request(`https://api.test${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body }) as Request<unknown, IncomingRequestCfProperties>;
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const appHeaders = (app: { key: string }, origin = ORIGIN): Record<string, string> => ({ 'x-hana-key': app.key, origin });

export const bytes = (n: number, fill: number): number[] => Array.from({ length: n }, (_, i) => (fill + i) % 256);

let spkSeed = 1;
/** A fresh 32-byte session public key. */
export const newSessionKey = (): number[] => bytes(32, (spkSeed++ * 37) % 256).map((b, i) => (i === 0 ? spkSeed % 256 : b));

export function sessionBody(aud: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jwt: makeJwt({ iss: GOOGLE_ISS, aud, sub: '1234567890', nonce: 'n', exp: Math.floor(Date.now() / 1000) + 3600 }),
    sessionPublicKey: newSessionKey(),
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    salt: bytes(16, 3),
    keyIndex: 0,
    maxUses: 10,
    ...overrides,
  };
}

export const deriveBody = (spk: number[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionPublicKey: spk,
  counter: 1,
  signature: bytes(64, 9),
  pk1: 'bls12381g1:abc',
  pk2: 'bls12381g2:def',
  ...overrides,
});

export const revokeBody = (spk: number[]): Record<string, unknown> => ({ sessionPublicKey: spk, counter: 2, signature: bytes(64, 1) });

/**
 * A NearMock wired with a tiny registry: `clients` maps aud → scope; sessions created through the mock are stored
 * and served by get_session.
 */
export function chain(clients: Record<string, string> = {}): NearMock & { sessions: Map<string, Record<string, unknown>>; clients: Record<string, string> } {
  const near = Object.assign(new NearMock(), { sessions: new Map<string, Record<string, unknown>>(), clients });
  near.views.scope_for_client = (a) => (a.provider === 'google' ? (clients[a.aud as string] ?? null) : null);
  near.views.get_session = (a) => near.sessions.get(JSON.stringify(a.session_public_key)) ?? null;
  near.contract.create_session = (a) => {
    const aud = JSON.parse(atob((a.jwt as string).split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/'))).aud as string;
    const scope = clients[aud];
    if (!scope) throw new Error('Token is for an unregistered app');
    const session = { path: `${scope}#google#1234567890#${a.key_index}`, scope_id: scope, expires_at_ms: a.expires_at_ms, max_uses: a.max_uses, used: 0 };
    near.sessions.set(JSON.stringify(a.session_public_key), session);
    return session;
  };
  near.contract.derive_key = () => ({ big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' });
  near.contract.revoke_session = (a) => {
    near.sessions.delete(JSON.stringify(a.session_public_key));
    return null;
  };
  near.install();
  return near;
}
