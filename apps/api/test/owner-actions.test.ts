import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_MAX_OWNERS,
  CONTRACT_MAX_PENDING,
  EXECUTES_PER_SCOPE_MINUTE,
  executeLimiterKey,
  forgetCapEvents,
  OWNER_ACTIONS_GLOBAL_MINUTE,
  OWNER_ACTIONS_PER_IP_MINUTE,
  OWNER_ACTIONS_PER_OWNER_DAY,
  OWNER_ACTIONS_PER_OWNER_MINUTE,
  OWNER_ACTIONS_PER_SCOPE_DAY,
  OWNER_ACTIONS_PER_SCOPE_MINUTE,
  ownerActionWindows,
  ownerLimiterKey,
  SAFETY_GLOBAL_DAY,
  SAFETY_GLOBAL_LIMITER,
  SAFETY_GLOBAL_MINUTE,
  SAFETY_PER_OWNER_DAY,
  SAFETY_PER_OWNER_MINUTE,
  SAFETY_PER_SCOPE_DAY,
  SAFETY_PER_SCOPE_MINUTE,
  safetyScopeLimiterKey,
  scopeLimiterKey,
} from '../src/handlers.ts';
import { clientProofNonce, ownerActionNonce } from '@hana-id/console-core';
import { clearJwksCache } from '@hana-id/oidc';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { GOVERNANCE_METHODS, UPDATER_METHODS, parseRelayerKeys } from '../src/relayer-config.ts';
import { clearViewCaches, parsePendingShared } from '../src/views.ts';
import { NAMED_PII_CLAIMS, call, minuteHeadroom, startOfMinuteClock } from './helpers.ts';
import { NearMock, type RsaSigner, makeJwt, panic, rsaSigner } from './near-mock.ts';
import { eventFor, ledger } from './usage-ledger.ts';

const GOOGLE = 'https://accounts.google.com';
const CONSOLE = 'console.apps.googleusercontent.com';
const NEW_CLIENT = 'new-client.apps.googleusercontent.com';
const OWNER_SUB = '42';
const OTHER_OWNER_SUB = '43';

let google: RsaSigner;
let seq = 0;
beforeAll(async () => {
  google = await rsaSigner();
});
/** Empties RateLimiter objects (storage is shared by the tests of this file). */
async function clearLimiters(names: string[]): Promise<void> {
  for (const name of names) {
    await runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name)), (_i, state) => {
      for (const [key] of state.storage.kv.list()) state.storage.kv.delete(key);
    });
  }
}
const SCOPES = ['s1', 's2', 's3'];
/** Every owner-action cap these tests touch: global, per scope, per owner identity. */
const ownerLimiters = async (): Promise<string[]> => [
  'owner-actions:global',
  SAFETY_GLOBAL_LIMITER,
  ...SCOPES.map(scopeLimiterKey),
  ...SCOPES.map(executeLimiterKey),
  ...SCOPES.map(safetyScopeLimiterKey),
  ...(await Promise.all([OWNER_SUB, OTHER_OWNER_SUB].map((sub) => ownerLimiterKey({ provider: 'google', sub })))),
];

beforeEach(async () => {
  clearJwksCache();
  clearViewCaches();
  forgetCapEvents();
  await clearLimiters(await ownerLimiters());
});
afterEach(() => vi.restoreAllMocks());

const exp = (): number => Math.floor(Date.now() / 1000) + 3600;
/** A genuine console token of the scope owner (fresh each time: a token is only relayed once), with any nonce. */
const ownerJwt = (claims: Record<string, unknown> = {}): Promise<string> =>
  google.sign({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, nonce: `n${seq++}`, exp: exp(), ...claims });

/**
 * A token signed when its body is first posted (materialize), with the nonce the precheck expects: the owner-action
 * nonce of exactly that body at the mock scope's action_nonce, or for a client proof the scope's client-proof nonce.
 * A `nonce` in `claims` overrides it. Once signed it stays (the body object is updated in place), so posting the same
 * body twice replays the same token.
 */
class Later {
  constructor(
    readonly claims: Record<string, unknown>,
    readonly kind: 'owner' | 'proof',
  ) {}
}
const oidc = async (claims: Record<string, unknown> = {}): Promise<{ Oidc: { jwt: string } }> => ({ Oidc: { jwt: new Later(claims, 'owner') as unknown as string } });
const clientProof = async (claims: Record<string, unknown> = {}): Promise<string> => new Later(claims, 'proof') as unknown as string;

/** The mock of the running test (near()), whose scopes give the action_nonce the tokens commit to. */
let current: (NearMock & { scopes: Record<string, unknown> }) | null = null;
const actionNonceOf = (scopeId: unknown): number => ((current?.scopes[scopeId as string] as { action_nonce?: number } | undefined)?.action_nonce ?? 0);

async function materialize(body: unknown): Promise<void> {
  const args = (body as { args?: Record<string, unknown> } | null)?.args;
  if (!args || typeof args !== 'object') return;
  const n = actionNonceOf(args.scope_id);
  if (args.client_proof instanceof Later) {
    const l = args.client_proof;
    const nonce = await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId: args.scope_id as string, actionNonce: n });
    args.client_proof = await google.sign({ iss: GOOGLE, aud: NEW_CLIENT, sub: OWNER_SUB, nonce, exp: exp(), jti: `p${seq++}`, ...l.claims });
  }
  const auth = (args.auth as { Oidc?: { jwt?: unknown } } | undefined)?.Oidc;
  if (auth && auth.jwt instanceof Later) {
    const l = auth.jwt;
    const method = (body as { method: string }).method;
    let nonce: string;
    try {
      nonce = await ownerActionNonce({ signer: env.SIGNER_ACCOUNT, method, args, actionNonce: n });
    } catch {
      nonce = `unencodable-${seq++}`;
    }
    // A distinct jti: two tokens for the same action are still two tokens (a replay test reposts the same body).
    auth.jwt = await google.sign({ iss: GOOGLE, aud: CONSOLE, sub: OWNER_SUB, nonce, exp: exp(), jti: `n${seq++}`, ...l.claims });
  }
}

let ipSeq = 1;
const ip = (): string => `203.0.113.${ipSeq++ % 250}`;
const post = async (body: unknown, from = ip()): Promise<Response> => {
  await materialize(body);
  return call('/v1/owner-actions', { body, headers: { 'cf-connecting-ip': from } });
};

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
  const n = Object.assign(new NearMock(), { scopes: Object.fromEntries(SCOPES.map((id) => [id, { ...scope(), id }])) as Record<string, unknown> });
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
  current = n;
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

  it('records one usage event per action past the owner check (the scope’s org, no app, the owner pool’s key); none before it', async () => {
    const n = near();
    const ownerPool = parseRelayerKeys(env.OWNER_RELAYER_KEYS, 'OWNER_RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
    // s2 is in the hot DB under an org; s1 isn't (a scope with no app yet): org_legacy.
    await env.DB.prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s2', 'org_owner_test', 'test', NULL, 0, 0)").run();
    const ok = await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 3 } });
    const other = await post({ method: 'execute_change', args: { scope_id: 's2', change_id: 3 } });
    n.contract.execute_change = () => panic('No such change');
    const rejected = await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 0 } });
    // Refused before the owner check passed (an unknown pending change, a malformed body): no event.
    const unchecked = [await post({ method: 'execute_change', args: { scope_id: 's1', change_id: 5 } }), await post({ method: 'execute_change' })];
    expect([ok.status, other.status, rejected.status, ...unchecked.map((r) => r.status)]).toEqual([200, 200, 422, 409, 400]);
    const ev = async (r: Response) => eventFor(((await r.clone().json()) as { requestId: string }).requestId);
    expect(await ev(ok)).toMatchObject({ endpoint: 'owner_action', app_id: null, scope_id: 's1', org_id: 'org_legacy', outcome: 'ok', relayed: true, near_tx: n.sent[0]!.hash, relayer_nonce: n.sent[0]!.nonce.toString() });
    expect(ownerPool).toContain((await ev(ok))!.relayer_pk);
    expect(await ev(other)).toMatchObject({ scope_id: 's2', org_id: 'org_owner_test', outcome: 'ok' });
    expect(await ev(rejected)).toMatchObject({ outcome: 'rejected', code: 'contract_rejected', relayed: true });
    for (const r of unchecked) expect(await ev(r)).toBeUndefined();
    expect(ledger.events.every((e) => !('uid' in e))).toBe(true);
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
    await startOfMinuteClock();
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

  it('an email-carrying console token or client proof: 400 token_has_pii, nothing relayed, nothing reserved (D271, D274)', async () => {
    const n = near();
    const addClient = { AddClient: { provider: 'google', aud: NEW_CLIENT } };
    const cases: [string, unknown, string][] = [];
    for (const claim of [...NAMED_PII_CLAIMS, 'unknown_claim']) {
      cases.push([`owner token ${claim}`, { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc({ [claim]: 'x' }), change_id: 0 } }, claim]);
    }
    cases.push(['client proof email', { method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: addClient, client_proof: await clientProof({ email: 'a@example.com' }) } }, 'email']);
    cases.push(['client proof hd', { method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: addClient, client_proof: await clientProof({ hd: 'example.com' }) } }, 'hd']);
    const authJwts: string[] = [];
    for (const [label, req, claim] of cases) {
      authJwts.push((req as { args: { auth: { Oidc: { jwt: string } } } }).args.auth.Oidc.jwt);
      const res = await post(req);
      expect([res.status, await json(res)], label).toEqual([400, expect.objectContaining({ code: 'token_has_pii', data: { claim } })]);
    }
    expect(n.sent).toHaveLength(0);
    expect(n.rpcMethods).not.toContain('send_tx');
    // A refused request reserves no token: the client-proof cases' (clean) owner tokens still relay once.
    const retry = await post({ method: 'propose_change', args: { scope_id: 's1', auth: { Oidc: { jwt: authJwts.at(-1)! } }, change: addClient, client_proof: await clientProof() } });
    expect(retry.status).toBe(200);
    expect(n.sent.map((t) => t.method)).toEqual(['propose_change']);
  });

  it('refused PII tokens: their email and hd reach no log, response or D1 row', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const n = near();
    const email = `owner-${seq++}@example.com`;
    const hd = `hd-${seq++}.example`;
    const pii = { email, email_verified: true, hd };
    const responses: string[] = [];
    for (const body of [
      { method: 'propose_change', args: { scope_id: 's1', auth: await oidc(pii), change: { AddClient: { provider: 'google', aud: NEW_CLIENT } }, client_proof: await clientProof(pii) } },
      { method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change: { AddClient: { provider: 'google', aud: NEW_CLIENT } }, client_proof: await clientProof(pii) } },
      { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(pii), change_id: 0 } },
      { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc({ ...pii, sub: '999' }), change_id: 0 } },
      { method: 'cancel_change', args: { scope_id: 'nope', auth: await oidc(pii), change_id: 0 } },
    ]) {
      const res = await post(body);
      responses.push(`${res.status} ${await res.text()}`);
    }
    expect(responses.map((r) => r.slice(0, 3))).toEqual(['400', '400', '400', '400', '400']);
    expect(n.sent).toHaveLength(0);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    const rows: string[] = [];
    for (const { name } of tables.results) rows.push(JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results));
    for (const haystack of [...lines, ...responses, ...rows]) {
      expect(haystack).not.toContain(email);
      expect(haystack).not.toContain(hd);
    }
  });

  it('allow-listed claims of the wrong type are ignored, not refused (verifyIdToken optionalClaims "ignore", D201)', async () => {
    const n = near();
    const wrong = { iat: 'soon', auth_time: 'x', azp: 5, nbf: 'later', jti: 7 };
    const res = await post({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(wrong), change: { AddClient: { provider: 'google', aud: NEW_CLIENT } }, client_proof: await clientProof(wrong) } });
    expect(res.status).toBe(200);
    expect(n.sent.map((t) => t.method)).toEqual(['propose_change']);
    // A non-finite exp is still refused.
    const forever = (await ownerJwt()).split('.');
    const payload = JSON.parse(atob(forever[1]!.replace(/-/gu, '+').replace(/_/gu, '/'))) as Record<string, unknown>;
    const b64 = (s: string): string => btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    const infinite = `${forever[0]}.${b64(JSON.stringify(payload).replace(/"exp":\d+/u, '"exp":1e400'))}.${forever[2]}`;
    const refused = await post({ method: 'cancel_change', args: { scope_id: 's1', auth: { Oidc: { jwt: infinite } }, change_id: 0 } });
    expect([refused.status, (await json(refused)).code]).toEqual([401, 'invalid_token']);
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

  const execute = (scopeId: string, i: number) => post({ method: 'execute_change', args: { scope_id: scopeId, change_id: 3 } }, `198.51.100.${(i % 250) + 1}`);
  const setOwners = async (sub = OWNER_SUB) => ({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc({ sub }), change: { SetOwners: { owners: [{ Oidc: { provider: 'google', sub } }] } } } });
  const cancel = async (sub = OWNER_SUB) => post({ method: 'cancel_change', args: { scope_id: 's1', auth: await oidc({ sub }), change_id: 5 } });
  const fill = async (scopeId: string, count: number, from = 0) => {
    for (let i = 0; i < count; i++) expect((await execute(scopeId, from + i)).status, `${scopeId} #${i}`).toBe(200);
  };
  /** Fills a RateLimiter object's minute window directly (traffic the test doesn't need to send). */
  const exhaust = async (subject: string, max: number): Promise<void> => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(subject));
    for (let i = 0; i < max; i++) expect((await stub.hit([{ name: 'minute', windowMs: 60_000, max }])).ok).toBe(true);
  };
  /** The count a RateLimiter object holds in its current window `name`. */
  const countIn = async (subject: string, name: string): Promise<number> =>
    runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(subject)), (_i, state) => {
      let n = 0;
      for (const [key, value] of state.storage.kv.list<number>()) if (key.startsWith(`${name}@`)) n += value;
      return n;
    });

  it('frees the token when a cap turns the request away', async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    await exhaust(scopeLimiterKey('s1'), OWNER_ACTIONS_PER_SCOPE_MINUTE);
    const body = await setOwners();
    const refused = await post(body);
    expect([refused.status, (await json(refused)).error]).toEqual([429, 'Rate limit exceeded (owner actions per scope per minute)']);
    await clearLimiters([scopeLimiterKey('s1')]);
    expect((await post(body)).status).toBe(200);
    expect(n.sent.filter((t) => t.method === 'propose_change')).toHaveLength(1);
  });

  it(`unauthenticated execute_change has its own per-scope window (${EXECUTES_PER_SCOPE_MINUTE}/min), never the owners'`, async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    const statuses: number[] = [];
    for (let i = 0; i < EXECUTES_PER_SCOPE_MINUTE + 1; i++) statuses.push((await execute('s1', i)).status);
    expect(statuses).toEqual([...Array(EXECUTES_PER_SCOPE_MINUTE).fill(200), 429]);
    expect((await json(await execute('s1', 30))).error).toBe('Rate limit exceeded (executes per scope per minute)');
    // The execute flood left the scope's owner window alone, and other scopes' execute windows.
    expect(await countIn(scopeLimiterKey('s1'), 'minute')).toBe(0);
    expect((await post(await setOwners())).status).toBe(200);
    expect((await execute('s2', 99)).status).toBe(200);
    expect(n.sent.filter((t) => t.method === 'execute_change')).toHaveLength(EXECUTES_PER_SCOPE_MINUTE + 1);
  });

  it(`caps owner actions per scope (${OWNER_ACTIONS_PER_SCOPE_MINUTE} per minute), across owners`, async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    const owners = (n.scopes.s1 as { owners: unknown[] }).owners;
    // The contract's MAX_OWNERS owners, each at its own cap: together exactly the scope's window.
    const subs = Array.from({ length: CONTRACT_MAX_OWNERS - 1 }, (_, i) => `7${i}`);
    for (const sub of subs) owners.push({ Oidc: { provider: 'google', sub } });
    const all = [OWNER_SUB, ...subs];
    const statuses: number[] = [];
    for (let i = 0; i < OWNER_ACTIONS_PER_SCOPE_MINUTE; i++) statuses.push((await post(await setOwners(all[i % all.length]))).status);
    expect(statuses).toEqual(Array(OWNER_ACTIONS_PER_SCOPE_MINUTE).fill(200));
    // A sixth identity (an owner the chain added) finds the scope's window full.
    owners.push({ Oidc: { provider: 'google', sub: '79' } });
    const over = await post(await setOwners('79'));
    expect([over.status, (await json(over)).error]).toEqual([429, 'Rate limit exceeded (owner actions per scope per minute)']);
    await clearLimiters(await Promise.all([...subs, '79'].map((sub) => ownerLimiterKey({ provider: 'google', sub }))));
  });

  it('the per-owner windows are the scope’s divided by the contract’s MAX_OWNERS: one owner can’t use up a scope’s proposals (D236)', async () => {
    expect(OWNER_ACTIONS_PER_SCOPE_MINUTE).toBeGreaterThanOrEqual(CONTRACT_MAX_OWNERS * OWNER_ACTIONS_PER_OWNER_MINUTE);
    expect(OWNER_ACTIONS_PER_SCOPE_DAY).toBeGreaterThanOrEqual(CONTRACT_MAX_OWNERS * OWNER_ACTIONS_PER_OWNER_DAY);
    // One owner spends its whole day; a co-owner still proposes.
    const n = near();
    (n.scopes.s1 as { owners: unknown[] }).owners.push({ Oidc: { provider: 'google', sub: OTHER_OWNER_SUB } });
    const ownerDay = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(await ownerLimiterKey({ provider: 'google', sub: OWNER_SUB })));
    for (let i = 0; i < OWNER_ACTIONS_PER_OWNER_DAY; i++) expect((await ownerDay.hit([{ name: 'day', windowMs: 24 * 60 * 60_000, max: OWNER_ACTIONS_PER_OWNER_DAY }])).ok).toBe(true);
    const stopped = await post(await setOwners());
    expect([stopped.status, (await json(stopped)).error]).toEqual([429, 'Rate limit exceeded (owner actions per owner per day)']);
    expect((await post(await setOwners(OTHER_OWNER_SUB))).status).toBe(200);
    // The first owner's spent day took only its share of the scope's.
    expect(await countIn(scopeLimiterKey('s1'), 'day')).toBe(1);
  });

  it(`caps owner actions per owner identity (${OWNER_ACTIONS_PER_OWNER_MINUTE} per minute), whatever the IP`, async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    (n.scopes.s1 as { owners: unknown[] }).owners.push({ Oidc: { provider: 'google', sub: OTHER_OWNER_SUB } });
    const statuses: number[] = [];
    for (let i = 0; i < OWNER_ACTIONS_PER_OWNER_MINUTE + 1; i++) statuses.push((await post(await setOwners())).status);
    expect(statuses).toEqual([...Array(OWNER_ACTIONS_PER_OWNER_MINUTE).fill(200), 429]);
    // A co-owner of the same scope has its own window.
    expect((await post(await setOwners(OTHER_OWNER_SUB))).status).toBe(200);
  });

  it(`caps relayed owner actions globally (${OWNER_ACTIONS_GLOBAL_MINUTE} per minute) across scopes`, async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    await fill('s1', EXECUTES_PER_SCOPE_MINUTE);
    await fill('s2', OWNER_ACTIONS_GLOBAL_MINUTE - EXECUTES_PER_SCOPE_MINUTE, 50);
    const over = await execute('s3', 120);
    expect([over.status, (await json(over)).error]).toEqual([429, 'Rate limit exceeded (owner actions per minute)']);
    expect(n.sent).toHaveLength(OWNER_ACTIONS_GLOBAL_MINUTE);
  }, 20_000);

  it('a request a later window refuses is taken back from the earlier ones (a refusal costs no window)', async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    near();
    await exhaust('owner-actions:global', OWNER_ACTIONS_GLOBAL_MINUTE);
    // Twice the owner's own allowance, all refused by the global ceiling...
    for (let i = 0; i < 2 * OWNER_ACTIONS_PER_OWNER_MINUTE; i++) expect((await post(await setOwners())).status).toBe(429);
    expect((await execute('s1', 1)).status).toBe(429);
    // ...leave the owner's, the scope's and the execute window untouched.
    expect(await countIn(await ownerLimiterKey({ provider: 'google', sub: OWNER_SUB }), 'minute')).toBe(0);
    expect(await countIn(scopeLimiterKey('s1'), 'minute')).toBe(0);
    expect(await countIn(executeLimiterKey('s1'), 'minute')).toBe(0);
    await clearLimiters(['owner-actions:global']);
    for (let i = 0; i < OWNER_ACTIONS_PER_OWNER_MINUTE; i++) expect((await post(await setOwners())).status).toBe(200);
  });

  it('cancel_change is never starved: its own per-owner allowance and ceiling, outside every other cap (APIW-3)', async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    (n.scopes.s1 as { owners: unknown[] }).owners.push({ Oidc: { provider: 'google', sub: OTHER_OWNER_SUB } });
    // Someone fills the global ceiling, the victim scope's owner window and its execute window.
    await exhaust('owner-actions:global', OWNER_ACTIONS_GLOBAL_MINUTE);
    await exhaust(scopeLimiterKey('s1'), OWNER_ACTIONS_PER_SCOPE_MINUTE);
    await exhaust(executeLimiterKey('s1'), EXECUTES_PER_SCOPE_MINUTE);
    expect((await post(await setOwners())).status).toBe(429);
    expect((await execute('s1', 200)).status).toBe(429);
    // The honest owner can still cancel, up to its own small allowance.
    const cancels: number[] = [];
    for (let i = 0; i < SAFETY_PER_OWNER_MINUTE + 1; i++) cancels.push((await cancel()).status);
    expect(cancels).toEqual([...Array(SAFETY_PER_OWNER_MINUTE).fill(200), 429]);
    expect((await json(await cancel())).error).toBe('Rate limit exceeded (safety actions per owner per minute)');
    // One owner using up its cancels leaves every other owner's untouched.
    expect((await cancel(OTHER_OWNER_SUB)).status).toBe(200);
    expect(n.sent.filter((t) => t.method === 'cancel_change')).toHaveLength(SAFETY_PER_OWNER_MINUTE + 1);
  });

  it(`cancels have a high global ceiling of their own (${SAFETY_GLOBAL_MINUTE}/min); a refused cancel keeps the owner's and scope's allowance`, async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    near();
    await exhaust(SAFETY_GLOBAL_LIMITER, SAFETY_GLOBAL_MINUTE);
    const refused = await cancel();
    expect([refused.status, (await json(refused)).error]).toEqual([429, 'Rate limit exceeded (safety actions per minute)']);
    expect(await countIn(await ownerLimiterKey({ provider: 'google', sub: OWNER_SUB }), 'safety:minute')).toBe(0);
    expect(await countIn(safetyScopeLimiterKey('s1'), 'minute')).toBe(0);
    // The shared owner-action ceiling is a different object: filling one never fills the other.
    expect(await countIn('owner-actions:global', 'minute')).toBe(0);
  });

  it('the cancel ceilings are sized from the contract: per scope = every owner at its cap, global needs ≥ 20 identities', () => {
    expect(SAFETY_PER_SCOPE_MINUTE).toBe(CONTRACT_MAX_OWNERS * SAFETY_PER_OWNER_MINUTE);
    expect(SAFETY_PER_SCOPE_DAY).toBe(CONTRACT_MAX_OWNERS * SAFETY_PER_OWNER_DAY);
    // Identities at their own cap needed to fill the global ceiling, and the scopes they need (≤ MAX_OWNERS each).
    expect(SAFETY_GLOBAL_MINUTE / SAFETY_PER_OWNER_MINUTE).toBeGreaterThanOrEqual(4 * CONTRACT_MAX_OWNERS);
    expect(SAFETY_GLOBAL_DAY / SAFETY_PER_OWNER_DAY).toBeGreaterThanOrEqual(10 * CONTRACT_MAX_OWNERS);
    // More cancellable changes than ≥ 100 scopes hold at once.
    expect(SAFETY_GLOBAL_DAY).toBeGreaterThanOrEqual(100 * CONTRACT_MAX_PENDING);
  });

  it(`a scope's cancel window (${SAFETY_PER_SCOPE_MINUTE}/min) is filled only by that scope's owners, and never by fewer than all of them`, async () => {
    // Fixed per-minute windows: the whole run in one minute (helpers.ts minuteHeadroom; no clock shift: the changes'
    // delays are on the real clock).
    await minuteHeadroom(15_000);
    const n = near();
    const coOwners = ['81', '82', '83', '84']; // with OWNER_SUB: the contract's MAX_OWNERS
    await clearLimiters([...(await Promise.all([...coOwners, 'mallory'].map((sub) => ownerLimiterKey({ provider: 'google', sub }))))]);
    (n.scopes.s1 as { owners: unknown[] }).owners = [{ Oidc: { provider: 'google', sub: OWNER_SUB } }, ...coOwners.map((sub) => ({ Oidc: { provider: 'google', sub } }))];
    (n.scopes.s2 as { owners: unknown[] }).owners = [{ Oidc: { provider: 'google', sub: OTHER_OWNER_SUB } }];
    // An owner of another scope cancels at its full allowance there: s1's cancel window is untouched.
    for (let i = 0; i < SAFETY_PER_OWNER_MINUTE; i++) expect((await post({ method: 'cancel_change', args: { scope_id: 's2', auth: await oidc({ sub: OTHER_OWNER_SUB }), change_id: 5 } })).status).toBe(200);
    expect(await countIn(safetyScopeLimiterKey('s1'), 'minute')).toBe(0);
    // A non-owner's cancel is refused by the owner check before any window counts it.
    expect((await cancel('mallory')).status).toBe(403);
    expect(await countIn(safetyScopeLimiterKey('s1'), 'minute')).toBe(0);
    expect(await countIn(await ownerLimiterKey({ provider: 'google', sub: 'mallory' }), 'safety:minute')).toBe(0);
    // Four malicious co-owners at their own caps leave the honest owner room.
    for (const sub of coOwners) for (let i = 0; i < SAFETY_PER_OWNER_MINUTE; i++) expect((await cancel(sub)).status).toBe(200);
    expect((await cancel()).status).toBe(200);
    expect(await countIn(safetyScopeLimiterKey('s1'), 'minute')).toBe(coOwners.length * SAFETY_PER_OWNER_MINUTE + 1);
    // A full scope window refuses that scope's cancels only.
    await clearLimiters([safetyScopeLimiterKey('s1'), await ownerLimiterKey({ provider: 'google', sub: OWNER_SUB })]);
    await exhaust(safetyScopeLimiterKey('s1'), SAFETY_PER_SCOPE_MINUTE);
    expect((await json(await cancel())).error).toBe('Rate limit exceeded (safety actions per scope per minute)');
    expect(await countIn(await ownerLimiterKey({ provider: 'google', sub: OWNER_SUB }), 'safety:minute')).toBe(0);
    await clearLimiters(await Promise.all(coOwners.map((sub) => ownerLimiterKey({ provider: 'google', sub }))));
  });

  it('ownerActionWindows: the windows of each method, fail closed without an owner, no Google sub in a name', async () => {
    const owner = { provider: 'google', sub: '110248495921238986420' };
    const propose = (await ownerActionWindows('propose_change', { scopeId: 's1', owner }))!;
    expect(propose.map((w) => w.subject)).toEqual([await ownerLimiterKey(owner), 'owner-actions:scope:s1', 'owner-actions:global']);
    expect(propose[0]!.subject).toMatch(/^owner-actions:owner:[0-9a-f]{64}$/u);
    expect((await ownerActionWindows('execute_change', { scopeId: 's1', owner: null }))!.map((w) => w.subject)).toEqual(['owner-actions:execute:s1', 'owner-actions:global']);
    const cancelWindows = (await ownerActionWindows('cancel_change', { scopeId: 's1', owner }))!;
    expect(cancelWindows.map((w) => w.subject)).toEqual([await ownerLimiterKey(owner), 'owner-actions:safety:s1', SAFETY_GLOBAL_LIMITER]);
    expect(cancelWindows[0]!.limits).toEqual([expect.objectContaining({ name: 'safety:minute', max: SAFETY_PER_OWNER_MINUTE }), expect.objectContaining({ name: 'safety:day' })]);
    for (const method of ['cancel_change', 'propose_change', 'remove_client', 'disable_shared_login']) {
      expect(await ownerActionWindows(method, { scopeId: 's1', owner: null }), method).toBeNull();
    }
    for (const w of [...propose, ...cancelWindows]) expect(w.subject).not.toContain(owner.sub);
  });

  it('the safety budget also covers remove_client and disable_shared_login; propose_change keeps the general windows', async () => {
    const owner = { provider: 'google', sub: OWNER_SUB };
    for (const method of ['remove_client', 'disable_shared_login']) {
      const w = (await ownerActionWindows(method, { scopeId: 's1', owner }))!;
      expect(w.map((x) => x.subject), method).toEqual([await ownerLimiterKey(owner), safetyScopeLimiterKey('s1'), SAFETY_GLOBAL_LIMITER]);
    }
    expect((await ownerActionWindows('propose_change', { scopeId: 's1', owner }))!.map((x) => x.subject)).toEqual([await ownerLimiterKey(owner), scopeLimiterKey('s1'), 'owner-actions:global']);
    // A proposal flood that filled every general window leaves a client removal and a shared-login disable possible.
    const n = near();
    (n.scopes.s1 as Record<string, unknown>).allow_shared = true;
    await exhaust('owner-actions:global', OWNER_ACTIONS_GLOBAL_MINUTE);
    await exhaust(scopeLimiterKey('s1'), OWNER_ACTIONS_PER_SCOPE_MINUTE);
    expect((await post(await setOwners())).status).toBe(429);
    expect((await post({ method: 'remove_client', args: { scope_id: 's1', auth: await oidc(), provider: 'google', aud: 'old.apps.googleusercontent.com' } })).status).toBe(200);
    expect((await post({ method: 'disable_shared_login', args: { scope_id: 's1', auth: await oidc() } })).status).toBe(200);
    expect(n.sent.map((t) => t.method)).toEqual(['remove_client', 'disable_shared_login']);
  });

  it(`caps owner actions per scope at ${OWNER_ACTIONS_PER_SCOPE_DAY} a UTC day (the spec's cap)`, async () => {
    near();
    expect(OWNER_ACTIONS_PER_SCOPE_DAY).toBe(20);
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(scopeLimiterKey('s1')));
    for (let i = 0; i < OWNER_ACTIONS_PER_SCOPE_DAY; i++) expect((await stub.hit([{ name: 'day', windowMs: 24 * 60 * 60_000, max: OWNER_ACTIONS_PER_SCOPE_DAY }])).ok).toBe(true);
    const refused = await post(await setOwners());
    expect([refused.status, (await json(refused)).error]).toEqual([429, 'Rate limit exceeded (owner actions per scope per day)']);
  });

  it('reaching a cap writes one owner_cap security event per window, with the scope and its org, and no owner identity', async () => {
    near();
    await env.DB.prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s3', 'org_cap_test', 'test', NULL, 0, 0)").run();
    await env.DB.prepare("DELETE FROM security_events WHERE kind = 'owner_cap'").run();
    await exhaust(scopeLimiterKey('s3'), OWNER_ACTIONS_PER_SCOPE_MINUTE);
    const body = async () => ({ method: 'propose_change', args: { scope_id: 's3', auth: await oidc(), change: { SetOwners: { owners: [{ Oidc: { provider: 'google', sub: OWNER_SUB } }] } } } });
    for (let i = 0; i < 3; i++) expect((await post(await body())).status).toBe(429);
    forgetCapEvents(); // another isolate: the deterministic id still dedups in D1
    expect((await post(await body())).status).toBe(429);
    const events = (await env.DB.prepare("SELECT * FROM security_events WHERE kind = 'owner_cap'").all<Record<string, unknown>>()).results;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ org_id: 'org_cap_test', scope_id: 's3', app_id: null, notified_at: null });
    expect(JSON.parse(events[0]!.detail_json as string)).toMatchObject({ method: 'propose_change', window: 'owner actions per scope', limit: 'minute', max: OWNER_ACTIONS_PER_SCOPE_MINUTE });
    expect(JSON.stringify(events)).not.toContain(OWNER_SUB);
    // A safety window's refusal is its own event.
    await exhaust(SAFETY_GLOBAL_LIMITER, SAFETY_GLOBAL_MINUTE);
    expect((await cancel()).status).toBe(429);
    const kinds = (await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'owner_cap'").all<{ detail_json: string }>()).results.map((r) => JSON.parse(r.detail_json).window);
    expect(kinds.sort()).toEqual(['owner actions per scope', 'safety actions']);
  });

  it('owner_nonce_mismatch: a token for another action, or for an action_nonce that moved since, is refused before any reservation (uncached re-read)', async () => {
    const n = near();
    // Signed for change 5 but sent for change 3 (the args it commits to differ).
    const wrongArgs = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 5 } };
    await materialize(wrongArgs);
    wrongArgs.args.change_id = 3;
    const r1 = await post(wrongArgs);
    expect([r1.status, (await json(r1)).code]).toEqual([409, 'owner_nonce_mismatch']);
    // Signed at action_nonce 6; the scope moved to 7 since. The cached view (warmed by the refusal above) still says 6:
    // the precheck reads the scope uncached.
    const body = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc(), change_id: 5 } };
    await materialize(body);
    (n.scopes.s1 as Record<string, unknown>).action_nonce = 7;
    const r2 = await post(body);
    const b2 = await json(r2);
    expect([r2.status, b2.code]).toEqual([409, 'owner_nonce_mismatch']);
    expect(b2.error).toContain('action_nonce 7');
    expect(n.sent).toHaveLength(0);
    // Nothing was reserved or counted: back at 6, the same token is relayed.
    expect(await countIn(await ownerLimiterKey({ provider: 'google', sub: OWNER_SUB }), 'safety:minute')).toBe(0);
    (n.scopes.s1 as Record<string, unknown>).action_nonce = 6;
    expect((await post(body)).status).toBe(200);
    // A nonce from another method with the same arguments (the contract's own example) is refused too.
    const other = { method: 'cancel_change', args: { scope_id: 's1', auth: await oidc({ nonce: await ownerActionNonce({ signer: env.SIGNER_ACCOUNT, method: 'disable_shared_login', args: { scope_id: 's1' }, actionNonce: 6 }) }), change_id: 5 } };
    expect((await json(await post(other))).code).toBe('owner_nonce_mismatch');
    // A view without an action_nonce fails closed.
    delete (n.scopes.s1 as Record<string, unknown>).action_nonce;
    const noNonce = await post({ method: 'cancel_change', args: { scope_id: 's1', auth: await oidc({ nonce: 'x' }), change_id: 5 } });
    expect([noNonce.status, (await json(noNonce)).code]).toEqual([502, 'near_unavailable']);
    expect(n.sent).toHaveLength(1);
  });

  it('propose_change AddClient: a client proof whose nonce is not the scope’s client-proof nonce is invalid_client_proof', async () => {
    const n = near();
    const change = { AddClient: { provider: 'google', aud: NEW_CLIENT } };
    // A genuine proof for the client, minted for another scope's (or an older) client-proof nonce.
    const stale = await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId: 's1', actionNonce: 5 });
    const res = await post({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: await clientProof({ nonce: stale }) } });
    const b = await json(res);
    expect([res.status, b.code]).toEqual([400, 'invalid_client_proof']);
    expect(b.error).toContain('action_nonce 6');
    const otherScope = await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId: 's2', actionNonce: 6 });
    expect((await json(await post({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: await clientProof({ nonce: otherScope }) } }))).code).toBe('invalid_client_proof');
    expect(n.sent).toHaveLength(0);
    // The right nonce passes.
    expect((await post({ method: 'propose_change', args: { scope_id: 's1', auth: await oidc(), change, client_proof: await clientProof() } })).status).toBe(200);
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
