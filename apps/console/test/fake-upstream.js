// The test API Worker's outbound fetches (vitest.config.ts `outboundService`): a fake NEAR RPC (hana-signer's views)
// and Google's JWKS, served from the `upstream` table of a D1 the tests share (FAKE_UPSTREAM), so a test sets what the
// chain and Google say and the real API verifies step-up and owner tokens against it end to end. Nothing else is
// answered (502): no test reaches a real network.
import { WorkerEntrypoint } from 'cloudflare:workers';

const RPC_ORIGIN = 'https://rpc.test.invalid';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

async function stored(env, key) {
  const row = await env.FAKE_UPSTREAM.prepare('SELECT json FROM upstream WHERE key = ?').bind(key).first();
  return row ? row.json : null;
}

// The issuer's ConsoleIssuerRpc (build plan batch 9, D447) as the console Worker's ISSUER binding: answers from the
// same table (`issuer:clientProof`, `issuer:deliverability`), or by default a syntactically valid answer.
export class ConsoleIssuerRpc extends WorkerEntrypoint {
  async clientProof(input) {
    const stored_ = await stored(this.env, 'issuer:clientProof');
    if (stored_ !== null) return JSON.parse(stored_);
    return { ok: true, token: JSON.stringify({ payload: 'p', signatures: [{ protected: 'h', signature: 's' }] }), client: ['email', `email:${input.scopeId}`] };
  }
  async deliverability(input) {
    const stored_ = await stored(this.env, `issuer:deliverability:${input.appId}`);
    return stored_ !== null ? JSON.parse(stored_) : { ok: true, days: [] };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.href === GOOGLE_JWKS_URL) {
      const jwks = await stored(env, 'jwks');
      return jwks === null ? new Response('no jwks', { status: 503 }) : new Response(jwks, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
    }
    if (url.origin === RPC_ORIGIN && request.method === 'POST') {
      const body = await request.json();
      const p = body.params ?? {};
      if (body.method !== 'query' || p.request_type !== 'call_function') return Response.json({ jsonrpc: '2.0', id: body.id, error: { name: 'UNSUPPORTED', message: 'fake upstream' } });
      const args = JSON.parse(atob(p.args_base64 || 'e30='));
      const key = p.method_name === 'get_scope' ? `get_scope:${args.scope_id}` : p.method_name;
      const json = await stored(env, key);
      if (json === null) return new Response('unknown view', { status: 503 });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { result: [...new TextEncoder().encode(json)], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } });
    }
    return new Response('fake upstream: no such host', { status: 502 });
  },
};
