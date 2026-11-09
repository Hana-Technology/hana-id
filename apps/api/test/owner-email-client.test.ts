// The scope's email client as an owner action (build plan batch 9, D447): `propose_change(AddClient("email", "email:<scope>"))`
// takes the issuer's JWS JSON client proof, checked against the published keys and the chain's signer policy, its `aud`, `sub`
// and client-proof nonce, and removed with `remove_client`. The proof isn't a compact JWT (the Google path refuses it).
import { clientProofNonce, ownerActionNonce } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJwksCache } from '@hana-id/oidc';
import { clearViewCaches } from '../src/views.ts';
import { forgetCapEvents } from '../src/handlers.ts';
import { call } from './helpers.ts';
import { NearMock, type RsaSigner, rsaSigner } from './near-mock.ts';
import { EMAIL_ISS, emailEnv, emailToken, issuer } from './email-helpers.ts';

const GOOGLE = 'https://accounts.google.com';
const CONSOLE = 'console.apps.googleusercontent.com';
const OWNER_SUB = '104729830516284937263';
const NOW = Date.now();
const SCOPE = 'semail1';

let google: RsaSigner;
let seq = 0;
beforeAll(async () => {
  google = await rsaSigner();
});
beforeEach(() => {
  clearJwksCache();
  clearViewCaches();
  forgetCapEvents();
});
afterEach(() => vi.restoreAllMocks());

function near(actionNonce = 4): NearMock & { scope: Record<string, unknown> } {
  const scope = {
    id: SCOPE,
    owners: [{ Oidc: { provider: 'google', sub: OWNER_SUB } }],
    clients: [['google', 'a.apps.googleusercontent.com']],
    pending: [],
    action_nonce: actionNonce,
    allow_shared: false,
    created_at_ms: NOW - 10_000,
  };
  const n = Object.assign(new NearMock(), { scope });
  n.jwks = { keys: [google.jwk] };
  n.views.get_config = () => ({ owner: 'admin.testnet', console_audiences: [['google', CONSOLE]], shared_clients: [], pending_shared_clients: [], change_delay_ms: 0, public_registration: false, unrecorded_wallets: false });
  n.views.get_scope = (a) => (a.scope_id === SCOPE ? scope : null);
  n.views.get_self_issued = (a) => (a.provider === 'email' ? { provider: 'email', signers: [{ id: 'hana', kids: [issuer.kid] }], required: 1, overlap_until_ms: null } : null);
  n.contract.propose_change = () => 7;
  n.contract.remove_client = () => null;
  n.install();
  return n;
}

const ownerAuth = async (method: string, args: Record<string, unknown>, actionNonce = 4) => {
  const nonce = await ownerActionNonce({ signer: env.SIGNER_ACCOUNT, method, args, actionNonce });
  return { Oidc: { jwt: await google.sign({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, nonce, exp: Math.floor(NOW / 1000) + 3600, jti: `o${seq++}` }) } };
};
const proof = async (claims: Record<string, unknown> = {}, actionNonce = 4) =>
  emailToken({ iss: EMAIL_ISS, aud: `email:${SCOPE}`, sub: 'hana-client-proof', nonce: await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId: SCOPE, actionNonce }), ...claims });

const post = (body: unknown) => call('/v1/owner-actions', { body, headers: { 'cf-connecting-ip': `203.0.113.${(seq++ % 200) + 1}` }, env: emailEnv() });

const addArgs = async (over: Record<string, unknown> = {}) => {
  const args: Record<string, unknown> = { scope_id: SCOPE, change: { AddClient: { provider: 'email', aud: `email:${SCOPE}` } }, client_proof: await proof(), ...over };
  return { ...args, auth: await ownerAuth('propose_change', args) };
};

describe('propose_change(AddClient email) (D447)', () => {
  it('relays a proof of the right aud, sub and nonce', async () => {
    const n = near();
    const res = await post({ method: 'propose_change', args: await addArgs() });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(n.sent.map((t) => t.method)).toEqual(['propose_change']);
  });

  it('refuses a proof for another aud, another sub, or a stale nonce; a forged signature; nothing relayed', async () => {
    const n = near();
    for (const claims of [{ aud: 'email:sother' }, { sub: 'e1.alice' }, { nonce: 'x'.repeat(43) }]) {
      const res = await post({ method: 'propose_change', args: await addArgs({ client_proof: await proof(claims) }) });
      expect(res.status, JSON.stringify(claims)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('invalid_client_proof');
    }
    // A malformed JSON token and the compact form are refused before any chain work.
    expect((await post({ method: 'propose_change', args: await addArgs({ client_proof: '{"payload":"x","signatures":[]}' }) })).status).toBe(400);
    expect((await post({ method: 'propose_change', args: await addArgs({ client_proof: 'a.b.c' }) })).status).toBe(400);
    expect(n.sent).toHaveLength(0);
  });

  it('refuses when the client is already there and a Google client with an email proof', async () => {
    const n = near();
    n.scope.clients = [['google', 'a.apps.googleusercontent.com'], ['email', `email:${SCOPE}`]];
    const res = await post({ method: 'propose_change', args: await addArgs() });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('client_registered');
    const asGoogle = await post({ method: 'propose_change', args: await addArgs({ change: { AddClient: { provider: 'google', aud: 'x.apps.googleusercontent.com' } } }) });
    expect(asGoogle.status).toBe(400);
    expect(n.sent).toHaveLength(0);
  });
});

describe('remove_client email (D447)', () => {
  it('removes the email client at once; the last-client rule still holds', async () => {
    const n = near();
    n.scope.clients = [['google', 'a.apps.googleusercontent.com'], ['email', `email:${SCOPE}`]];
    const args: Record<string, unknown> = { scope_id: SCOPE, provider: 'email', aud: `email:${SCOPE}` };
    const ok = await post({ method: 'remove_client', args: { ...args, auth: await ownerAuth('remove_client', args) } });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect(n.sent.map((t) => t.method)).toEqual(['remove_client']);

    n.scope.clients = [['email', `email:${SCOPE}`]];
    const last = await post({ method: 'remove_client', args: { ...args, auth: await ownerAuth('remove_client', args) } });
    expect(last.status).toBe(409);
    expect(((await last.json()) as { code: string }).code).toBe('last_client');
  });
});
