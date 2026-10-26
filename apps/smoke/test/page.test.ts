// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Boots the real page (index.html + src/main.ts) against a mocked API, RPC, Google Identity Services and MPC: wiring,
// the UNSET-key guard, the client choice, and a whole run (sign-in → create_session → derive → revoke → replays).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, toHex, utf8 } from '../src/bytes.ts';
import { CKD_DST, ckdAppId } from '../src/ckd.ts';
import type { PageEnv } from '../src/config.ts';
import { sessionNonce } from '../src/layouts.ts';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/gu, '');
const PK = 'pk_test_1111111111111111111111';
const OWN = 'own.apps.googleusercontent.com';
const SHARED = 'shared.apps.googleusercontent.com';
const SUB = '110248495921238986420';
const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
const MSK = 12345n;
const networkKeyBytes = G2.BASE.multiply(MSK).toRawBytes(true);
const validKey = `bls12381g2:${base58.encode(networkKeyBytes)}`;

const baseEnv: PageEnv = {
  name: 'sandbox-dev',
  network: 'testnet',
  signer: 'hana-id-signer-dev1.testnet',
  relayer: 'hana-id-relayer-dev1.testnet',
  mpc: 'v1.signer-prod.testnet',
  ckdDomainId: 2,
  ckdNetworkKey: 'UNSET-run-scripts/fetch-ckd-key.ts',
  rpc: 'https://rpc.example',
  apiUrl: 'https://api.example',
  apiUrlOverridden: false,
};

type Json = Record<string, unknown>;
const view = (value: unknown) => Response.json({ jsonrpc: '2.0', id: 'x', result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
const apiError = (status: number, code: string, error: string) => Response.json({ error, code, requestId: 'rq' }, { status });

/** CKD as the MPC answers it for `path`, encrypted to the request's pk1 (see ckd.test.ts). */
function mpcAnswer(pk1: string, path: string) {
  const appId = ckdAppId(baseEnv.signer, path);
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...networkKeyBytes, ...appId]), { DST: CKD_DST }).toAffine());
  const y = 777n;
  const a1 = G1.fromHex(base58.decode(pk1.slice('bls12381g1:'.length)));
  return {
    big_y: `bls12381g1:${base58.encode(G1.BASE.multiply(y).toRawBytes(true))}`,
    big_c: `bls12381g1:${base58.encode(h.multiply(MSK).add(a1.multiply(y)).toRawBytes(true))}`,
  };
}

/** A stateful fake of the API + chain: enough contract rules to see replays rejected. */
function mockBackend(opts: { signer?: string } = {}) {
  const calls: { url: string; body: Json | null; headers: Headers }[] = [];
  const sessions = new Map<string, { path: string; used: number; revoked: boolean; maxUses: number }>();
  let txs = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const reqBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : null;
    calls.push({ url, body: reqBody, headers: new Headers(init?.headers) });
    const tx = () => `Tx${++txs}`;
    switch (url) {
      case 'https://api.example/v1/app':
        return Response.json({ scopeId: 's1', signer: opts.signer ?? baseEnv.signer, google: { clientId: OWN, mode: 'own' }, requestId: 'r1' });
      case 'https://api.example/v1/sessions': {
        const b = reqBody as { jwt: string; sessionPublicKey: number[]; keyIndex: number; maxUses: number; expiresAtMs: number; salt: number[] };
        const key = toHex(Uint8Array.from(b.sessionPublicKey));
        if (sessions.has(key)) return apiError(409, 'session_exists', 'This session key is already in use');
        const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b.jwt.split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/')), (c) => c.charCodeAt(0)))) as { nonce: string };
        const expected = await sessionNonce({ signer: baseEnv.signer, scopeId: 's1', sessionPublicKey: Uint8Array.from(b.sessionPublicKey), expiresAtMs: b.expiresAtMs, keyIndex: b.keyIndex, maxUses: b.maxUses, salt: Uint8Array.from(b.salt) });
        if (claims.nonce !== expected) return apiError(400, 'nonce_mismatch', 'The ID token nonce does not commit to this session');
        const path = `s1#google#${SUB}#${b.keyIndex}`;
        sessions.set(key, { path, used: 0, revoked: false, maxUses: b.maxUses });
        return Response.json({ result: { path, scope_id: 's1', expires_at_ms: b.expiresAtMs, max_uses: b.maxUses, used: 0 }, nearTx: tx(), requestId: 'r2' });
      }
      case 'https://api.example/v1/derive':
      case 'https://api.example/v1/sessions/revoke': {
        const b = reqBody as { sessionPublicKey: number[]; counter: number; pk1?: string };
        const s = sessions.get(toHex(Uint8Array.from(b.sessionPublicKey)));
        if (!s || s.revoked) return apiError(404, 'unknown_session', 'Unknown or expired session');
        if (b.counter !== s.used + 1) return apiError(422, 'contract_rejected', 'Wrong counter (replayed or out of order)');
        s.used += 1;
        if (url.endsWith('/revoke')) {
          s.revoked = true;
          return Response.json({ result: null, nearTx: tx(), requestId: 'r4' });
        }
        return Response.json({ result: mpcAnswer(b.pk1!, s.path), nearTx: tx(), requestId: 'r3' });
      }
      case 'https://rpc.example': {
        const rpc = reqBody as { method: string; params: { method_name?: string } };
        if (rpc.method === 'tx') {
          return Response.json({ jsonrpc: '2.0', id: 'x', result: { transaction_outcome: { outcome: { gas_burnt: 2e12, tokens_burnt: '0' } }, receipts_outcome: [{ outcome: { gas_burnt: 1e13, tokens_burnt: '0' } }] } });
        }
        if (rpc.params.method_name === 'get_scope') return view({ id: 's1', clients: [['google', OWN]], allow_shared: true, owners: [], pending: [] });
        if (rpc.params.method_name === 'get_config') return view({ shared_clients: [['google', SHARED]], pending_shared_clients: [], mpc: 'm', ckd_domain_id: 2 });
        if (rpc.params.method_name === 'get_session') return view(null);
        return new Response('unknown rpc', { status: 500 });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, sessions };
}

/** Google Identity Services stand-in: captures the nonce and lets the test "sign in". */
function mockGoogle() {
  const state: { clientId: string | null; nonce: string | null; callback: ((r: { credential: string }) => void) | null } = { clientId: null, nonce: null, callback: null };
  vi.stubGlobal('google', {
    accounts: {
      id: {
        initialize: (c: { client_id: string; nonce: string; callback: (r: { credential: string }) => void }) => Object.assign(state, { clientId: c.client_id, nonce: c.nonce, callback: c.callback }),
        renderButton: () => undefined,
      },
    },
  });
  const signIn = (sub = SUB) => {
    const part = (o: Json) => base64UrlEncode(utf8(JSON.stringify(o)));
    state.callback!({ credential: `${part({ alg: 'RS256', kid: 'k' })}.${part({ aud: state.clientId, sub, nonce: state.nonce })}.c2ln` });
  };
  return { state, signIn };
}

async function boot(env: Partial<PageEnv> = {}): Promise<void> {
  document.body.innerHTML = body;
  (globalThis as Record<string, unknown>).__HANA_SMOKE_ENV__ = { ...baseEnv, ...env };
  vi.resetModules();
  await import('../src/main.ts');
}

const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const text = (id: string) => document.getElementById(id)!.textContent ?? '';

async function loadApp(): Promise<void> {
  (document.getElementById('pk') as HTMLInputElement).value = PK;
  button('load-app').click();
  await vi.waitFor(() => expect(document.querySelectorAll('input[name="client"]').length).toBeGreaterThan(0));
}

async function idle(): Promise<void> {
  await vi.waitFor(() => expect(button('load-app').disabled).toBe(false));
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('smoke page', () => {
  it('shows the environment and refuses to start while ckdNetworkKey is UNSET', async () => {
    mockBackend();
    await boot();
    expect(text('env')).toContain('hana-id-signer-dev1.testnet');
    expect(document.getElementById('env-problem')!.hidden).toBe(false);
    expect(text('env-problem')).toMatch(/UNSET placeholder/);
    await loadApp();
    expect(button('start').disabled).toBe(true);
  });

  it('loads the app, keeps the publishable key, and offers own and shared clients', async () => {
    const { calls } = mockBackend();
    await boot({ ckdNetworkKey: validKey });
    expect(document.getElementById('env-problem')!.hidden).toBe(true);
    expect(button('start').disabled).toBe(true);
    await loadApp();
    expect(calls[0]!.headers.get('x-hana-key')).toBe(PK);
    expect(localStorage.getItem('hana-smoke.publishableKey')).toBe(PK);
    expect(text('app')).toContain('s1');
    const labels = [...document.querySelectorAll('#clients label')].map((l) => l.textContent);
    expect(labels).toEqual([`own client: ${OWN}`, `shared client: ${SHARED}`]);
    expect((document.querySelector('input[name="client"]:checked') as HTMLInputElement).value).toBe('0');
    expect(button('start').disabled).toBe(false);
    expect(button('derive-again').disabled).toBe(true);
  });

  it('rejects an API whose signer is not the manifest signer', async () => {
    mockBackend({ signer: 'someone-else.testnet' });
    await boot({ ckdNetworkKey: validKey });
    (document.getElementById('pk') as HTMLInputElement).value = PK;
    button('load-app').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/is not this page's hana-id-signer-dev1.testnet/));
    expect(button('start').disabled).toBe(true);
  });

  it('runs a whole session: sign-in, create_session, derive, derive again, replays, revoke', async () => {
    const backend = mockBackend();
    const google = mockGoogle();
    await boot({ ckdNetworkKey: validKey });
    await loadApp();
    // Shared client this time.
    (document.querySelectorAll<HTMLInputElement>('input[name="client"]')[1]!).checked = true;
    (document.getElementById('key-index') as HTMLInputElement).value = '1';
    button('start').click();
    await vi.waitFor(() => expect(google.state.nonce).not.toBeNull());
    expect(google.state.clientId).toBe(SHARED);
    expect(text('pending')).toContain(google.state.nonce!);

    google.signIn();
    await vi.waitFor(() => expect(document.querySelectorAll('#runs tr')).toHaveLength(1));
    await idle();
    const path = `s1#google#${SUB}#1`;
    expect(text('session')).toContain(path);
    const create = backend.calls.find((c) => c.url.endsWith('/v1/sessions'))!;
    expect(create.body).toMatchObject({ keyIndex: 1, maxUses: 5 });
    expect(create.body).not.toHaveProperty('scopeId');
    const result = text('result');
    expect(result).toMatch(/G[A-Z2-7]{55}/u);
    expect(result).toMatch(/0x[0-9a-fA-F]{40}/u);
    expect(result).toContain(toHex(ckdAppId(baseEnv.signer, path)));
    const firstRow = document.querySelector('#runs tr')!.textContent!;
    expect(firstRow).toContain('shared');

    // The Google token never reaches the DOM or storage.
    const jwt = create.body!.jwt as string;
    expect(document.body.innerHTML).not.toContain(jwt);
    expect(JSON.stringify({ ...localStorage })).not.toContain(jwt.split('.')[1]!);

    button('derive-again').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#runs tr')).toHaveLength(2));
    await idle();
    const derives = backend.calls.filter((c) => c.url.endsWith('/v1/derive'));
    expect(derives.map((c) => c.body!.counter)).toEqual([1, 2]);
    // Same path in the same session: same addresses, check is OK.
    expect(document.querySelectorAll('#runs tr')[1]!.textContent).toMatch(/#1: OK — same path, same session: same addresses/);
    await vi.waitFor(() => expect(text('timings')).toContain('12.00 Tgas'));

    button('replay-derive').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Replay of derive rejected as expected: 422 contract_rejected/));
    await idle();
    button('replay-session').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Replay of create_session rejected as expected: 409 session_exists/));
    await idle();

    button('revoke').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/revoke_session: done/));
    await idle();
    const revoke = backend.calls.find((c) => c.url.endsWith('/v1/sessions/revoke'))!;
    expect(revoke.body!.counter).toBe(3);
    expect(button('revoke').disabled).toBe(true);

    button('derive-again').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/404 unknown_session/));
    await idle();
    expect(document.querySelectorAll('#runs tr')).toHaveLength(2);

    button('restart').click();
    expect(button('start').disabled).toBe(false);
    expect(text('result')).toBe('');
  });

  it('restores the results log from storage and exports it as JSON', async () => {
    mockBackend();
    const run = { run: 1, path: 's1#google#111#0', stellar: 'GA', evm: '0xA', appIdHex: 'aa', pkPrefix: 'pk_test_x', clientMode: 'own', keyIndex: 0, env: 'sandbox-dev', signer: baseEnv.signer, sessionKeyPrefix: '00', timings: { googleMs: 1, createSessionMs: 2, deriveMs: 3, decryptVerifyMs: 4, totalMs: 10 }, createSessionGas: null, deriveGas: null };
    localStorage.setItem('hana-smoke.runs', JSON.stringify([run]));
    const writeText = vi.fn(async (_: string) => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await boot();
    expect(document.querySelectorAll('#runs tr')).toHaveLength(1);
    expect(document.querySelectorAll('#timings tr')).toHaveLength(1);
    button('copy-json').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect((JSON.parse(writeText.mock.calls[0]![0]) as { runs: unknown[] }).runs).toEqual([run]);
  });
});
