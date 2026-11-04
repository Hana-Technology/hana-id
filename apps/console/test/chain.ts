// A fake chain for C10's tests: hana-signer's `get_config` and `get_scope` views and Google's JWKS, stored in the
// FAKE_UPSTREAM D1. The API Worker reads them through its outbound service (test/fake-upstream.js); the console's own
// NEAR reads (src/near.ts) are answered in this isolate from the same table by `installChain`, which wraps `fetch`
// underneath MockGoogle (install it first; MockGoogle's spy passes anything that isn't Google's to it).
import { env } from 'cloudflare:workers';
import type { MockGoogle } from './google.ts';
import { CLIENT_ID } from './google.ts';

export const RPC = 'https://rpc.test.invalid';

const put = (key: string, value: unknown) => env.FAKE_UPSTREAM.prepare('INSERT INTO upstream (key, json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json').bind(key, JSON.stringify(value)).run();

export interface FakeScope {
  id: string;
  owners: unknown[];
  clients?: [string, string][];
  allow_shared?: boolean;
  pending?: { id: number; change: unknown; unlock_at_ms: number }[];
  action_nonce?: number;
}

/** Writes a scope as get_scope answers it. */
export async function setScope(s: FakeScope): Promise<void> {
  await put(`get_scope:${s.id}`, { clients: [], allow_shared: true, pending: [], action_nonce: 0, created_at_ms: 1, ...s });
}

/** get_config with the console client as the one console audience, and Google's JWKS from the mock. */
export async function setChain(google: MockGoogle): Promise<void> {
  await put('get_config', { console_audiences: [['google', CLIENT_ID]], shared_clients: [], pending_shared_clients: [], paused: false, unrecorded_wallets: false });
  await put('jwks', google.jwks.body);
}

/** An `Oidc` owner. */
export const oidc = (sub: string) => ({ Oidc: { provider: 'google', sub } });

let original: typeof fetch | null = null;

/** Answers the console isolate's NEAR RPC from the table (call before MockGoogle.init). */
export function installChain(): void {
  if (original) return;
  original = globalThis.fetch;
  const real = original.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (new URL(req.url).origin !== RPC) return real(input, init);
    const body = (await req.json()) as { id: string; params: { method_name: string; args_base64: string } };
    const args = JSON.parse(atob(body.params.args_base64)) as { scope_id?: string };
    const key = body.params.method_name === 'get_scope' ? `get_scope:${args.scope_id}` : body.params.method_name;
    const row = await env.FAKE_UPSTREAM.prepare('SELECT json FROM upstream WHERE key = ?').bind(key).first<{ json: string }>();
    if (!row) return new Response('unknown view', { status: 503 });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { result: [...new TextEncoder().encode(row.json)] } });
  }) as typeof fetch;
}

export function uninstallChain(): void {
  if (original) globalThis.fetch = original;
  original = null;
}
