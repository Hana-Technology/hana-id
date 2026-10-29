import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ACTIONS_GLOBAL_MINUTE, OWNER_ACTIONS_PER_IP_MINUTE } from '../src/handlers.ts';
import { clearJwksCache } from '../src/jwks.ts';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { GOVERNANCE_METHODS, UPDATER_METHODS, parseRelayerKeys } from '../src/relayer-config.ts';
import { clearViewCaches, parsePendingShared } from '../src/views.ts';
import { call } from './helpers.ts';
import { NearMock, type RsaSigner, makeJwt, panic, rsaSigner } from './near-mock.ts';

const GOOGLE = 'https://accounts.google.com';
const CONSOLE = 'console.apps.googleusercontent.com';
const NEW_CLIENT = 'new-client.apps.googleusercontent.com';
const OWNER_SUB = '42';

let google: RsaSigner;
let seq = 0;
beforeAll(async () => {
  google = await rsaSigner();
});
beforeEach(() => {
  clearJwksCache();
  clearViewCaches();
});
afterEach(() => vi.restoreAllMocks());

const exp = (): number => Math.floor(Date.now() / 1000) + 3600;
/** A genuine console token of the scope owner (fresh each time: a token is only relayed once). */
const ownerJwt = (claims: Record<string, unknown> = {}): Promise<string> =>
  google.sign({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, nonce: `n${seq++}`, exp: exp(), ...claims });
const oidc = async (claims: Record<string, unknown> = {}): Promise<{ Oidc: { jwt: string } }> => ({ Oidc: { jwt: await ownerJwt(claims) } });
const clientProof = (claims: Record<string, unknown> = {}): Promise<string> => google.sign({ iss: GOOGLE, aud: NEW_CLIENT, sub: OWNER_SUB, nonce: `p${seq++}`, exp: exp(), ...claims });

let ipSeq = 1;
const ip = (): string => `203.0.113.${ipSeq++ % 250}`;
const post = (body: unknown, from = ip()): Promise<Response> => call('/v1/owner-actions', { body, headers: { 'cf-connecting-ip': from } });

const NOW = Date.now();
function scope(): Record<string, unknown> {
  return {
    id: 's1',
    owners: [{ Near: { account_id: 'alice.testnet' } }, { Oidc: { provider: 'google', sub: OWNER_SUB } }],
    clients: [
      ['google', 'a.apps.googleusercontent.com'],
      ['google', 'old.apps.googleusercontent.com'],
    ],
    pending: [
      { id: 0, change: { AddClient: { provider: 'google', aud: 'x' } }, unlock_at_ms: NOW - 1000 },
      { id: 3, change: { AddClient: { provider: 'google', aud: 'y' } }, unlock_at_ms: NOW - 1000 },
      { id: 5, change: { AddClient: { provider: 'google', aud: 'z' } }, unlock_at_ms: NOW + 3_600_000 },
    ],
    action_nonce: 6,
    created_at_ms: NOW - 10_000,
  };
}

function near(): NearMock & { scopes: Record<string, unknown> } {
  const n = Object.assign(new NearMock(), { scopes: { s1: scope() } as Record<string, unknown> });
  n.jwks = { keys: [google.jwk] };
  n.views.get_config = () => ({
    owner: 'admin.testnet',
    console_audiences: [['google', CONSOLE]],
    shared_clients: [['google', 'shared.apps.googleusercontent.com']],
    pending_shared_clients: [{ provider: 'google', aud: 'pending-shared.apps.googleusercontent.com', effective_at_ms: NOW + 3_600_000 }],
    change_delay_ms: 0,
    public_registration: false,
  });
  n.views.get_scope = (a) => n.scopes[a.scope_id as string] ?? null;
  n.contract.propose_change = () => 7;
  n.install();
  return n;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /v1/owner-actions', () => {
  it('relays each allowlisted method with the contract’s argument names', async () => {
    const n = near();
    const proof = await clientProof();
    const cases = [
      { method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: { AddClient: { provider: 'google', aud: NEW_CLIENT } }, client_proof: proof } },
      {
        method: 'propose_change',
        args: { scope_id: 's1', auth: await oidc(), change: { SetOwners: { owners: [{ Near: { account_id: 'alice.testnet' } }, { Oidc: { provider: 'google', sub: '42' } }] } } },
      },
      { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 0 } },
      { method: 'remove_client', args: { scope_id: 's1', auth: await oidc(), provider: 'google', aud: 'old.apps.googleusercontent.com' } },
      { method: 'execute_change', args: { scope_id: 's1', change_id: 3 } },
    ];
    for (const c of cases) {
      const res = await post(c);
      expect(res.status, c.method).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
    expect(n.sent.map((t) => t.method)).toEqual(['propose_change', 'propose_change', 'cancel_change', 'remove_client', 'execute_change']);
    expect(n.sent[0]!.args).toEqual(cases[0]!.args);
    // SetOwners carries an explicit null proof (Option<String>).
    expect(n.sent[1]!.args).toEqual({ ...cases[1]!.args, client_proof: null });
    expect(n.sent.every((t) => t.receiverId === 'signer.test.near')).toBe(true);
    const again = await json(await post(cases[4]));
    expect(again.result).toBeNull();
  });

  it('returns the propose_change result and contract panics', async () => {
    const n = near();
    const res = await post({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: '1' } }] } } } });
    expect(await json(res)).toMatchObject({ result: 7 });
    n.contract.execute_change = () => panic('No such change');
    const failed = await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 0 } });
    expect(failed.status).toBe(422);
    expect((await json(failed)).error).toContain('No such change');
  });

  it('rejects methods outside the allowlist', async () => {
    const n = near();
    for (const method of ['apply_pending_config', 'create_session', 'derive_key', 'register_scope', 'set_owner', 'prune_sessions', '__proto__', ...GOVERNANCE_METHODS, ...UPDATER_METHODS]) {
      const res = await post({ method, args: { scope_id: 's1' } });
      expect(res.status, method).toBe(400);
    }
    expect(n.sent).toHaveLength(0);
  });

  it('rejects Near auth and malformed arguments', async () => {
    const n = near();
    const jwt = await ownerJwt();
    const proof = await clientProof();
    const auth = { Oidc: { jwt } };
    const addClient = { AddClient: { provider: 'google', aud: 'c.apps.googleusercontent.com' } };
    const bad: unknown[] = [
      { method: 'propose_change', args: { scope_id: 's1', auth: 'Near', change: addClient, client_proof: proof } },
      { method: 'cancel_change', args: { scope_id: 's1', auth: 'Near', change_id: 1 } },
      { method: 'remove_client', args: { scope_id: 's1', auth: 'Near', provider: 'google', aud: 'x' } },
      { method: 'remove_client', args: { scope_id: 's1', auth: { Near: {} }, provider: 'google', aud: 'x' } },
      { method: 'remove_client', args: { scope_id: 's1', auth: { Oidc: { jwt: 'not-a-jwt' } }, provider: 'google', aud: 'x' } },
      { method: 'remove_client', args: { scope_id: 's1', auth: { Oidc: { jwt, extra: 1 } }, provider: 'google', aud: 'x' } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: addClient } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { SetOwners: { owners: [] } } } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { SetOwners: { owners: Array(6).fill({ Oidc: { provider: 'google', sub: '1' } }) } } } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: 'a#b' } }] } } } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { SetOwners: { owners: [{ Near: { account_id: 'Not Valid' } }] } } } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: '1' } }] } }, client_proof: proof } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { AddClient: { provider: 'goo#gle', aud: 'x' } }, client_proof: proof } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: { RemoveEverything: {} } } },
      { method: 'propose_change', args: { scope_id: 's1', auth, change: addClient, client_proof: proof, receiver_id: 'evil.testnet' } },
      { method: 'cancel_change', args: { scope_id: 's1', auth, change_id: -1 } },
      { method: 'execute_change', args: { scope_id: 's1', change_id: '1' } },
      { method: 'execute_change', args: { scope_id: 'S1!', change_id: 1 } },
      { method: 'execute_change', args: { change_id: 1 } },
      { method: 'execute_change', args: { scope_id: 's1', change_id: 1 }, receiver: 'other.testnet' },
      { method: 'execute_change' },
      [],
    ];
    for (const b of bad) {
      const res = await post(b);
      expect(res.status, JSON.stringify(b).slice(0, 120)).toBe(400);
    }
    expect(n.sent).toHaveLength(0);
  });

  it(`limits each IP to ${OWNER_ACTIONS_PER_IP_MINUTE} per minute`, async () => {
    near();
    const from = '198.18.0.9';
    const statuses: number[] = [];
    for (let i = 0; i < OWNER_ACTIONS_PER_IP_MINUTE + 1; i++) statuses.push((await post({ method: 'nope' }, from)).status);
    expect(statuses.slice(0, -1).every((s) => s === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await post({ method: 'nope' })).status).toBe(400);
  });

  it('limits an IPv6 client per /64, not per address', async () => {
    near();
    const statuses: number[] = [];
    // Every request from a different address in the same /64 (as a host with a routed /64 can do).
    for (let i = 0; i < OWNER_ACTIONS_PER_IP_MINUTE + 1; i++) statuses.push((await post({ method: 'nope' }, `2001:db8:aa:bb:${(i + 1).toString(16)}::${i + 7}`)).status);
    expect(statuses.at(-1)).toBe(429);
    // Another /64 has its own budget.
    expect((await post({ method: 'nope' }, '2001:db8:aa:bc::1')).status).toBe(400);
  });
});

describe('owner-action checks before relaying (each relayed tx costs relayer allowance)', () => {
  async function expectRejected(body: unknown, status: number, code: string, n: NearMock): Promise<void> {
    const res = await post(body);
    const b = await json(res);
    expect([res.status, b.code], JSON.stringify(b)).toEqual([status, code]);
    expect(n.sent).toHaveLength(0);
  }

  it('rejects a forged owner token (bad signature, unknown kid, unsigned)', async () => {
    const n = near();
    const other = await rsaSigner(google.jwk.kid);
    const forged = await other.sign({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, exp: exp() });
    const unknownKid = await (await rsaSigner('nope')).sign({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, exp: exp() });
    const unsigned = makeJwt({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, exp: exp() });
    const none = makeJwt({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, exp: exp() }).replace(/^[^.]+/u, btoa(JSON.stringify({ alg: 'none', kid: google.jwk.kid })).replace(/=+$/u, ''));
    for (const jwt of [forged, unknownKid, unsigned, none]) {
      await expectRejected({ method: 'cancel_change', args: { scope_id: 's1', auth: { Oidc: { jwt } }, change_id: 0 } }, 401, 'invalid_token', n);
    }
  });

  it('rejects expired tokens, unknown issuers and tokens for other audiences', async () => {
    const n = near();
    const expired = await ownerJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await expectRejected({ method: 'cancel_change', args: { scope_id: 's1', auth: { Oidc: { jwt: expired } }, change_id: 0 } }, 401, 'token_expired', n);
    const evil = await ownerJwt({ iss: 'https://evil.example' });
    await expectRejected({ method: 'cancel_change', args: { scope_id: 's1', auth: { Oidc: { jwt: evil } }, change_id: 0 } }, 400, 'unsupported_issuer', n);
    // A genuine Google token, but for an app's client id rather than the console.
    const appToken = await ownerJwt({ aud: 'a.apps.googleusercontent.com' });
    await expectRejected({ method: 'cancel_change', args: { scope_id: 's1', auth: { Oidc: { jwt: appToken } }, change_id: 0 } }, 403, 'not_console_token', n);
  });

  it('rejects unknown scopes and tokens of non-owners', async () => {
    const n = near();
    await expectRejected({ method: 'cancel_change', args: { scope_id: 's9', auth: await oidc(), change_id: 0 } }, 404, 'unknown_scope', n);
    await expectRejected({ method: 'execute_change', args: { scope_id: 's9', change_id: 0 } }, 404, 'unknown_scope', n);
    await expectRejected({ method: 'cancel_change', args: { scope_id: 's1', auth: await oidc({ sub: 'mallory' }), change_id: 0 } }, 403, 'not_owner', n);
  });

  it('execute_change: only an existing, unlocked pending change', async () => {
    const n = near();
    await expectRejected({ method: 'execute_change', args: { scope_id: 's1', change_id: 999 } }, 404, 'unknown_change', n);
    await expectRejected({ method: 'execute_change', args: { scope_id: 's1', change_id: 5 } }, 409, 'change_locked', n);
    await expectRejected({ method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 999 } }, 404, 'unknown_change', n);
  });

  it('remove_client: only a client of the scope, never the last one', async () => {
    const n = near();
    await expectRejected({ method: 'remove_client', args: { scope_id: 's1', auth: await oidc(), provider: 'google', aud: 'nope.apps' } }, 404, 'unknown_client', n);
    clearViewCaches();
    (n.scopes.s1 as { clients: unknown[] }).clients = [['google', 'a.apps.googleusercontent.com']];
    await expectRejected({ method: 'remove_client', args: { scope_id: 's1', auth: await oidc(), provider: 'google', aud: 'a.apps.googleusercontent.com' } }, 409, 'last_client', n);
  });

  it('propose_change AddClient: the client proof must be genuine and for that client', async () => {
    const n = near();
    const change = { AddClient: { provider: 'google', aud: NEW_CLIENT } };
    const forged = makeJwt({ iss: GOOGLE, aud: NEW_CLIENT, sub: OWNER_SUB, exp: exp() });
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: forged } }, 400, 'invalid_client_proof', n);
    const wrongClient = await clientProof({ aud: 'other.apps.googleusercontent.com' });
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: wrongClient } }, 400, 'invalid_client_proof', n);
    const existing = { AddClient: { provider: 'google', aud: 'a.apps.googleusercontent.com' } };
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: existing, client_proof: await clientProof({ aud: 'a.apps.googleusercontent.com' }) } }, 409, 'client_registered', n);
  });

  it('relays an owner token at most once (it is bound to one action on chain)', async () => {
    const n = near();
    const auth = await oidc();
    const body = { method: 'cancel_change', args: { scope_id: 's1', auth, change_id: 0 } };
    expect((await post(body)).status).toBe(200);
    const replay = await post(body);
    expect(replay.status).toBe(409);
    expect((await json(replay)).code).toBe('token_used');
    // A token the contract rejected is dead too.
    n.contract.cancel_change = () => panic('Owner token nonce doesn’t match this action');
    const rejected = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 3 } };
    expect((await post(rejected)).status).toBe(422);
    expect((await post(rejected)).status).toBe(409);
    expect(n.sent).toHaveLength(2);
  });

  it('relays concurrent copies of one owner token only once (atomic reservation)', async () => {
    const n = near();
    // Relays take a while (the outcome is awaited): every copy arrives while the first is in flight.
    n.onSendTx = () => new Promise((r) => setTimeout(() => r(undefined), 30));
    const body = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 0 } };
    const res = await Promise.all(Array.from({ length: 6 }, () => post(body)));
    const codes = await Promise.all(res.map(async (r) => (r.status === 200 ? 'ok' : (await json(r)).code)));
    expect(codes.sort()).toEqual(['ok', 'token_used', 'token_used', 'token_used', 'token_used', 'token_used']);
    expect(n.sent).toHaveLength(1);
  });

  it('frees a token whose relay certainly never executed, keeps it when the outcome is unknown', async () => {
    const n = near();
    // NEAR rejects the transaction outright (validation error): nothing ran, the token may be retried.
    let mode: 'reject' | 'ok' = 'reject';
    n.onSendTx = () =>
      mode === 'reject'
        ? { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: { ActionsValidation: 'bad' } } } } }
        : undefined;
    const body = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 0 } };
    const first = await post(body);
    expect([first.status, (await json(first)).code]).toEqual([502, 'near_rejected']);
    mode = 'ok';
    expect((await post(body)).status).toBe(200);
    expect((await json(await post(body))).code).toBe('token_used');
    // An unknown outcome (it may still land): the token stays reserved.
    n.sendTxTimesOut = true;
    n.txPollFailures = 1000;
    const pending = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 3 } };
    // Every poll fails; run the clock fast so the relay gives up on its 60 s outcome deadline in ~1 s.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (skew += 10_000));
    const slow = await post(pending);
    clock.mockRestore();
    expect([slow.status, (await json(slow)).code]).toEqual([504, 'timeout']);
    n.sendTxTimesOut = false;
    n.txPollFailures = 0;
    expect((await json(await post(pending))).code).toBe('token_used');
    expect(n.sent.filter((t) => t.args.change_id === 3)).toHaveLength(1);
  });

  it('frees the token when the global cap turns the request away', async () => {
    const n = near();
    const global = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('owner-actions:global'));
    await runInDurableObject(global, (_i, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
    });
    for (let i = 0; i < OWNER_ACTIONS_GLOBAL_MINUTE; i++) expect((await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 3 } }, `198.51.100.${i + 1}`)).status).toBe(200);
    const body = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 0 } };
    expect((await post(body)).status).toBe(429);
    await runInDurableObject(global, (_i, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
    });
    expect((await post(body)).status).toBe(200);
    expect(n.sent.filter((t) => t.method === 'cancel_change')).toHaveLength(1);
  });

  it(`caps relayed owner actions globally (${OWNER_ACTIONS_GLOBAL_MINUTE} per minute), across IPs`, async () => {
    const n = near();
    // Storage is shared by the tests of this file: start from an empty global window.
    await runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('owner-actions:global')), (_i, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
    });
    const statuses: number[] = [];
    for (let i = 0; i < OWNER_ACTIONS_GLOBAL_MINUTE + 1; i++) statuses.push((await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 3 } }, `198.51.100.${i + 1}`)).status);
    expect(statuses.slice(0, -1)).toEqual(Array(OWNER_ACTIONS_GLOBAL_MINUTE).fill(200));
    expect(statuses.at(-1)).toBe(429);
    expect(n.sent).toHaveLength(OWNER_ACTIONS_GLOBAL_MINUTE);
  });

  it('fails closed when the issuer keys or the registry cannot be read', async () => {
    const n = near();
    n.jwksStatus = 500;
    const res = await post({ method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 0 } });
    expect([res.status, (await json(res)).code]).toEqual([503, 'issuer_keys_unavailable']);
    n.jwksStatus = 200;
    delete n.views.get_scope;
    const noView = await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 3 } });
    expect([noView.status, (await json(noView)).code]).toEqual([502, 'near_unavailable']);
    expect(n.sent).toHaveLength(0);
  });
});

describe('owner actions: owner relayer pool and shared login', () => {
  const ownerPublicKeys = parseRelayerKeys(env.OWNER_RELAYER_KEYS).map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
  const sessionPublicKeys = parseRelayerKeys(env.RELAYER_KEYS).map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());

  // The global cap test above fills the shared window: start each test from an empty one.
  beforeEach(async () => {
    await runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('owner-actions:global')), (_i, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
    });
  });

  async function expectRejected(body: unknown, status: number, code: string, n: NearMock): Promise<void> {
    const res = await post(body);
    const b = await json(res);
    expect([res.status, b.code], JSON.stringify(b)).toEqual([status, code]);
    expect(n.sent).toHaveLength(0);
  }

  it('relays through OWNER_RELAYER_KEYS (never the login pool), at 50 Tgas', async () => {
    const n = near();
    for (let i = 0; i < 4; i++) expect((await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 3 } })).status).toBe(200);
    expect(n.sent).toHaveLength(4);
    for (const t of n.sent) {
      expect(ownerPublicKeys).toContain(t.publicKey);
      expect(sessionPublicKeys).not.toContain(t.publicKey);
      expect(t.gas).toBe(50_000_000_000_000n);
    }
  });

  it('disable_shared_login: relayed for a shared scope with a client of its own', async () => {
    const n = near();
    (n.scopes.s1 as Record<string, unknown>).allow_shared = true;
    const args = { scope_id: 's1', auth: await oidc() };
    expect((await post({ method: 'disable_shared_login', args })).status).toBe(200);
    expect(n.sent.map((t) => [t.method, t.args])).toEqual([['disable_shared_login', args]]);
  });

  it('disable_shared_login: rejected when already off or when the scope has no client, and with bad args', async () => {
    const n = near();
    await expectRejected({ method: 'disable_shared_login', args: { scope_id: 's1', auth: await oidc() } }, 409, 'shared_login_disabled', n);
    clearViewCaches();
    Object.assign(n.scopes.s1 as Record<string, unknown>, { allow_shared: true, clients: [] });
    await expectRejected({ method: 'disable_shared_login', args: { scope_id: 's1', auth: await oidc() } }, 409, 'last_client', n);
    await expectRejected({ method: 'disable_shared_login', args: { scope_id: 's1', auth: 'Near' } }, 400, 'bad_request', n);
    await expectRejected({ method: 'disable_shared_login', args: { scope_id: 's1', auth: await oidc(), allow: false } }, 400, 'bad_request', n);
  });

  it('remove_client may remove the last client only while shared login is on', async () => {
    const n = near();
    Object.assign(n.scopes.s1 as Record<string, unknown>, { clients: [['google', 'a.apps.googleusercontent.com']], allow_shared: true });
    expect((await post({ method: 'remove_client', args: { scope_id: 's1', auth: await oidc(), provider: 'google', aud: 'a.apps.googleusercontent.com' } })).status).toBe(200);
    expect(n.sent.map((t) => t.method)).toEqual(['remove_client']);
  });

  it('propose_change SetAllowShared: only {"allow":true}, no proof, not when already on', async () => {
    const n = near();
    const change = { SetAllowShared: { allow: true } };
    const ok = await post({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change } });
    expect(ok.status).toBe(200);
    expect(n.sent[0]!.args).toMatchObject({ change, client_proof: null });
    n.sent.length = 0;
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: { SetAllowShared: { allow: false } } } }, 400, 'bad_request', n);
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: { SetAllowShared: { allow: 'yes' } } } }, 400, 'bad_request', n);
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: await clientProof() } }, 400, 'bad_request', n);
    clearViewCaches();
    (n.scopes.s1 as Record<string, unknown>).allow_shared = true;
    await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change } }, 409, 'shared_login_enabled', n);
  });

  it('propose_change AddClient: a shared (or pending shared) client cannot become a scope client', async () => {
    const n = near();
    for (const aud of ['shared.apps.googleusercontent.com', 'pending-shared.apps.googleusercontent.com']) {
      const change = { AddClient: { provider: 'google', aud } };
      await expectRejected({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: await clientProof({ aud }) } }, 409, 'shared_client', n);
    }
  });

  it('reads get_config().pending_shared_clients', () => {
    expect(parsePendingShared(null)).toEqual([]);
    expect(parsePendingShared({ pending_shared_clients: [{ provider: 'google', aud: 'a', effective_at_ms: 5 }] })).toEqual([{ client: ['google', 'a'], effective_at_ms: 5 }]);
    // Unreadable entries are ignored (not treated as shared).
    expect(parsePendingShared({ pending_shared_clients: [{ provider: 'google', aud: 'e' }, { provider: 'google', aud: 'f', unlock_at_ms: 1 }, ['google', 'g'], 'x'] })).toEqual([]);
  });
});
