// admin scope:add-email-client (D253): the env refusal, the locally minted client proof (its layout and the
// contract's checks, against the contract fixture that contracts/hana-signer's tests/email/issuer_tokens.rs feeds to
// the real propose_change), the plan, the --yes flow against a fake chain, and the refusals.
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Manifest, loadEnv, rsaJwkThumbprint } from '@hana-id/env';
import type { Action } from '@near-js/transactions';
import { KeyPair } from '@near-js/crypto';
import { CLIENT_PROOF_JTI, CLIENT_PROOF_SCOPE, ISS, NOW_MS, SIGNER, testRsaJwk } from '../../apps/email-issuer/scripts/gen-contract-fixture.ts';
import { clientProofClaims, clientProofNonce } from '../../apps/email-issuer/src/client-proof.ts';
import {
  type ClientProofRules,
  type ScopeView,
  EMAIL_CLIENT_DRY_RUN_LINE,
  EXECUTE_GAS,
  PROPOSE_DEPOSIT,
  PROPOSE_GAS,
  assertDevEnv,
  clientProofProblems,
  sameRsaKey,
  scopeAddEmailClient,
} from '../lib/admin-email-client.ts';
import { parseCli } from '../lib/cli.ts';
import type { RsaPrivateJwk } from '../lib/email-issuer.ts';
import type { TxSigner } from '../lib/near.ts';
import { fullEntry, keychainKey, secretFragments, tempRoots } from './sim-fixtures.ts';

const FIXTURE_PATH = join(import.meta.dirname, '..', '..', 'contracts', 'hana-signer', 'src', 'issuer_tokens_fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { signer: string; iss: string; kid: string; n: string; e: string; tokens: Record<string, string> };
const FIXTURE_PROOF = fixture.tokens.client_proof_s3_0!;

const base = loadEnv('sandbox-dev');
const OWNER = 'hana-id-admin-dev1.testnet';
const NOW = 1_800_000_000_000;
const NEAR = 10n ** 24n;

const pubOf = (k: RsaPrivateJwk) => ({ kty: 'RSA' as const, n: k.n, e: k.e, kid: rsaJwkThumbprint(k), use: 'sig' as const, alg: 'RS256' as const });
const newRsa = (): RsaPrivateJwk => {
  const j = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 }).privateKey.export({ format: 'jwk' }) as RsaPrivateJwk;
  return { kty: 'RSA', n: j.n, e: j.e, d: j.d, p: j.p, q: j.q, dp: j.dp, dq: j.dq, qi: j.qi };
};

/** sandbox-dev with `key` as the email issuer's active key (and a standby). */
function manifestWith(key: RsaPrivateJwk, standby: RsaPrivateJwk, over: Partial<Manifest> = {}): Manifest {
  const url = 'https://hana-id-email-issuer-sandbox-dev.example.workers.dev';
  const emailIssuer: NonNullable<Manifest['emailIssuer']> = {
    url,
    iss: `${url}/v1/email`,
    cloudflare: { workerName: 'hana-id-email-issuer-sandbox-dev', d1Name: 'hana-id-email-issuer-sandbox-dev' },
    signer: { kind: 'worker-secret', activeKid: pubOf(key).kid },
    publicKeys: [pubOf(key), pubOf(standby)],
    from: 'Hana ID (testnet) <team@example.com>',
    sender: 'sendgrid',
    dailySendBudget: 200,
  };
  return { ...base, ...over, emailIssuer };
}

function writeSigningKey(secretsRoot: string, env: string, key: unknown): string {
  const dir = join(secretsRoot, '.secrets', env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'email-issuer-signing-key.json');
  writeFileSync(file, `${JSON.stringify(key)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

interface Sent {
  signer: string;
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

/** A fake testnet with hana-signer's views and the two calls the command sends (the contract's state rules only). */
class FakeChain {
  constructor(readonly signer: string = base.signer) {}
  chainId = 'testnet';
  now = NOW;
  config: Record<string, unknown> | null = { paused: false, change_delay_ms: 60_000 };
  scopes = new Map<string, ScopeView>();
  issuer: unknown = null;
  selfIssued: unknown = null;
  keys: unknown = null;
  accessKeys = new Map<string, ReturnType<typeof fullEntry>[]>();
  sent: Sent[] = [];
  /** Block clock lag: execute_change sees now - lag. */
  lagMs = 0;
  reads = 0;

  rpc() {
    return {
      chainId: async () => this.chainId,
      accessKeys: async (id: string) => structuredClone(this.accessKeys.get(id) ?? []),
      view: async <T,>(account: string, method: string, args: Record<string, unknown> = {}): Promise<T> => {
        this.reads++;
        if (account !== this.signer || !this.config) throw new Error('CodeDoesNotExist');
        const v = (() => {
          switch (method) {
            case 'get_config':
              return this.config;
            case 'get_scope':
              return this.scopes.get(String(args.scope_id)) ?? null;
            case 'get_issuer':
              return args.provider === 'email' ? this.issuer : null;
            case 'get_self_issued':
              return args.provider === 'email' ? this.selfIssued : null;
            case 'get_issuer_keys':
              return args.provider === 'email' ? this.keys : null;
            default:
              throw new Error('MethodNotFound');
          }
        })();
        return structuredClone(v) as T;
      },
      sendTx: async (signer: TxSigner, receiver: string, actions: Action[]) => {
        const fc = actions[0]!.functionCall!;
        const args = JSON.parse(Buffer.from(fc.args).toString('utf8')) as Record<string, unknown>;
        this.sent.push({ signer: signer.accountId, receiver, method: fc.methodName, args, gas: fc.gas, deposit: fc.deposit });
        const scope = this.scopes.get(String(args.scope_id));
        if (!scope) throw new Error('Transaction x failed: No such scope');
        if (fc.methodName === 'propose_change') {
          const id = scope.action_nonce;
          scope.pending.push({ id, change: args.change, unlock_at_ms: this.now + Number(this.config!.change_delay_ms) });
          scope.action_nonce++;
          return { hash: 'PROPOSE', value: id };
        }
        if (fc.methodName === 'execute_change') {
          const i = scope.pending.findIndex((p) => p.id === args.change_id);
          if (i < 0) throw new Error('Transaction x failed: No such change');
          if (this.now - this.lagMs < scope.pending[i]!.unlock_at_ms) throw new Error('Transaction x failed: Change is still timelocked');
          const [p] = scope.pending.splice(i, 1);
          const add = (p!.change as { AddClient: { provider: string; aud: string } }).AddClient;
          scope.clients.push([add.provider, add.aud]);
          scope.action_nonce++;
          return { hash: 'EXECUTE', value: null };
        }
        throw new Error(`unexpected ${fc.methodName}`);
      },
    };
  }
}

const argv = (a: string[]) => parseCli(a, { strings: ['scope'], booleans: ['yes'] });

describe('assertDevEnv (D253)', () => {
  it('accepts local* and sandbox* testnet envs only', () => {
    for (const name of ['local', 'local-e2e', 'sandbox-dev', 'sandbox2']) expect(() => assertDevEnv({ name, network: 'testnet' })).not.toThrow();
    for (const name of ['staging', 'prod', 'mainnet', 'testnet-dev', 'my-sandbox']) expect(() => assertDevEnv({ name, network: 'testnet' })).toThrow(/dev envs \(local\*, sandbox\*\) only.*Cloudflare Access/u);
    expect(() => assertDevEnv({ name: 'sandbox-dev', network: 'mainnet' as 'testnet' })).toThrow(/not a testnet env/u);
  });
});

describe('the client proof against the contract fixture (contracts/hana-signer/src/issuer_tokens_fixture.json)', () => {
  const rules = (over: Partial<ClientProofRules> = {}): ClientProofRules => ({
    issValues: [fixture.iss],
    keys: [{ kid: fixture.kid, n: fixture.n, e: fixture.e }],
    policy: { provider: 'email', signers: [{ id: 'hana', kids: [fixture.kid] }], required: 1 },
    signerAccount: fixture.signer,
    scopeId: CLIENT_PROOF_SCOPE,
    actionNonce: 0,
    nowMs: NOW_MS,
    ...over,
  });
  const claimsOf = (token: string) => JSON.parse(Buffer.from((JSON.parse(token) as { payload: string }).payload, 'base64url').toString('utf8')) as Record<string, unknown>;

  it('has the layout of client-proof.ts: the route\'s claims, nonce client_proof_nonce(signer, scope, action_nonce)', () => {
    const c = claimsOf(FIXTURE_PROOF);
    expect(c).toEqual(clientProofClaims({ iss: ISS, signerAccount: SIGNER, scopeId: CLIENT_PROOF_SCOPE, actionNonce: 0, iat: c.iat as number, jti: CLIENT_PROOF_JTI }));
    expect(Object.keys(c)).toEqual(['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'jti']);
    expect(c).toMatchObject({ aud: 'email:s3', sub: 'hana-client-proof', exp: (c.iat as number) + 600 });
    // The contract's worked example (test_fixture.json "client_proof": s1, action_nonce 0).
    expect(clientProofNonce('hana-signer.testnet', 's1', 0)).toBe('5nh7P_dNPCQFltyJ0cTH6EiLvBkSYapJXxZs_c8N3hk');
    const header = JSON.parse(Buffer.from((JSON.parse(FIXTURE_PROOF) as { signatures: { protected: string }[] }).signatures[0]!.protected, 'base64url').toString('utf8')) as unknown;
    expect(header).toEqual({ alg: 'RS256', kid: fixture.kid });
  });

  it('passes the contract\'s checks exactly where the contract test accepts it', () => {
    expect(clientProofProblems(FIXTURE_PROOF, rules())).toEqual([]);
  });

  it('fails them where the contract refuses it, with its panic messages', () => {
    expect(clientProofProblems(FIXTURE_PROOF, rules({ actionNonce: 2 }))).toEqual([expect.stringMatching(/^Client proof nonce doesn't match/u)]);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ scopeId: 's4' }))).toEqual([expect.stringMatching(/^Client proof is for another client/u), expect.stringMatching(/^Client proof nonce doesn't match/u)]);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ signerAccount: 'other-signer.testnet' }))).toEqual([expect.stringMatching(/^Client proof nonce doesn't match/u)]);
    // The contract's "Token expired" (tests/email/issuer_tokens.rs, at NOW + 540 s).
    expect(clientProofProblems(FIXTURE_PROOF, rules({ nowMs: NOW_MS + 540_000 }))).toEqual(['Token expired']);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ nowMs: NOW_MS + 539_999 }))).toEqual([]);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ issValues: ['https://other.example/v1/email'] }))[0]).toMatch(/^Unknown token issuer/u);
    const other = newRsa();
    expect(clientProofProblems(FIXTURE_PROOF, rules({ keys: [{ kid: fixture.kid, n: other.n, e: other.e }] }))[0]).toMatch(/^Invalid token signature/u);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ keys: [] }))[0]).toMatch(/^Unknown signing key/u);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ policy: { provider: 'email', signers: [{ id: 'hana', kids: [] }], required: 1 } }))[0]).toMatch(/^Unknown signing key/u);
    expect(clientProofProblems(FIXTURE_PROOF, rules({ policy: { provider: 'email', signers: [{ id: 'hana', kids: [fixture.kid] }, { id: 'cosign', kids: [] }], required: 2 } }))[0]).toMatch(/^Not enough signatures/u);
    // Another purpose's email token (a session token) is not a client proof.
    expect(clientProofProblems(fixture.tokens.session_e7!, rules()).join('; ')).toMatch(/another client|nonce doesn't match/u);
  });

  it('refuses a malformed or tampered token like the contract\'s parser', () => {
    const t = JSON.parse(FIXTURE_PROOF) as { payload: string; signatures: { protected: string; signature: string }[] };
    const tampered = { ...t, payload: Buffer.from(JSON.stringify({ ...claimsOf(FIXTURE_PROOF), aud: 'email:s3', jti: 'x' })).toString('base64url') };
    expect(clientProofProblems(JSON.stringify(tampered), rules())[0]).toMatch(/^Invalid token signature/u);
    expect(clientProofProblems(JSON.stringify({ ...t, header: {} }), rules())).toEqual(['Malformed JWS']);
    expect(clientProofProblems(JSON.stringify({ ...t, signatures: [] }), rules())).toEqual(['Malformed JWS']);
    expect(clientProofProblems(JSON.stringify({ ...t, signatures: [t.signatures[0], t.signatures[0], t.signatures[0], t.signatures[0]] }), rules())).toEqual(['Too many signatures']);
    expect(clientProofProblems(JSON.stringify({ ...t, signatures: [t.signatures[0], t.signatures[0]] }), rules())).toEqual(['Duplicate signature kid']);
    expect(clientProofProblems(JSON.stringify({ ...t, signatures: [{ ...t.signatures[0], header: { kid: 'x' } }] }), rules())).toEqual(['Malformed JWS']);
    const crit = Buffer.from(JSON.stringify({ alg: 'RS256', kid: fixture.kid, crit: ['b64'] })).toString('base64url');
    expect(clientProofProblems(JSON.stringify({ ...t, signatures: [{ ...t.signatures[0], protected: crit }] }), rules())).toEqual(['Unsupported JWS header']);
    const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: fixture.kid })).toString('base64url');
    expect(clientProofProblems(JSON.stringify({ ...t, signatures: [{ ...t.signatures[0], protected: hs }] }), rules())).toEqual(['Unsupported JWT algorithm']);
    expect(clientProofProblems('eyJhbGciOiJSUzI1NiJ9.e30.x', rules())[0]).toMatch(/^Wrong token format/u);
    expect(clientProofProblems(`{"payload":"${'a'.repeat(7200)}","signatures":[]}`, rules())).toEqual(['JWT too large']);
  });

  it('the command mints exactly the fixture\'s proof from the fixture key, iat and jti (the token the contract test accepts)', async () => {
    const jwk = testRsaJwk() as unknown as RsaPrivateJwk;
    expect(rsaJwkThumbprint(jwk)).toBe(fixture.kid);
    const roots = tempRoots();
    const m = manifestWith(jwk, newRsa(), { signer: SIGNER });
    m.emailIssuer = { ...m.emailIssuer!, iss: ISS };
    writeSigningKey(roots.secretsRoot, m.name, jwk);
    const chain = new FakeChain(SIGNER);
    const owner = keychainKey(roots.home, OWNER);
    chain.accessKeys.set(OWNER, [fullEntry(owner)]);
    chain.scopes.set('s3', { id: 's3', owners: [{ Near: { account_id: OWNER } }], clients: [['google', 'app-s3']], allow_shared: false, pending: [], action_nonce: 0 });
    chain.issuer = { provider: 'email', iss_values: [ISS], kids: [fixture.kid] };
    chain.selfIssued = { provider: 'email', signers: [{ id: 'hana', kids: [fixture.kid] }], required: 1 };
    chain.keys = [{ kid: fixture.kid, n: fixture.n, e: fixture.e }];
    const out: string[] = [];
    await scopeAddEmailClient(m, argv(['--scope', 's3']), {
      rpc: chain.rpc(),
      log: (l) => out.push(l),
      home: roots.home,
      secretsRoot: roots.secretsRoot,
      now: () => NOW_MS - 60_000,
      jti: () => CLIENT_PROOF_JTI,
    });
    const line = out.find((l) => l.startsWith('  client_proof: '));
    expect(line?.slice('  client_proof: '.length)).toBe(FIXTURE_PROOF);
    expect(chain.sent).toEqual([]);
  }, 60_000);
});

describe('scope:add-email-client', () => {
  let key: RsaPrivateJwk;
  let standby: RsaPrivateJwk;
  beforeAll(() => {
    key = newRsa();
    standby = newRsa();
  });

  let roots: ReturnType<typeof tempRoots>;
  let chain: FakeChain;
  let m: Manifest;
  let owner: KeyPair;
  let out: string[];
  let sleeps: number[];

  beforeEach(() => {
    roots = tempRoots();
    m = manifestWith(key, standby);
    writeSigningKey(roots.secretsRoot, m.name, key);
    chain = new FakeChain();
    owner = keychainKey(roots.home, OWNER);
    chain.accessKeys.set(OWNER, [fullEntry(owner)]);
    chain.scopes.set('s2', { id: 's2', owners: [{ Oidc: { provider: 'google', sub: '123' } }, { Near: { account_id: OWNER } }], clients: [['google', 'app.apps.googleusercontent.com']], allow_shared: true, pending: [], action_nonce: 4 });
    chain.issuer = { provider: 'email', iss_values: [m.emailIssuer!.iss], kids: [pubOf(key).kid, pubOf(standby).kid] };
    chain.selfIssued = { provider: 'email', signers: [{ id: 'hana', kids: [pubOf(key).kid, pubOf(standby).kid] }], required: 1, overlap_until_ms: null };
    chain.keys = [pubOf(key), pubOf(standby)].map(({ kid, n, e }) => ({ kid, n, e }));
    out = [];
    sleeps = [];
  });

  const deps = () => ({
    rpc: chain.rpc(),
    log: (l: string) => out.push(l),
    home: roots.home,
    secretsRoot: roots.secretsRoot,
    now: () => chain.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      chain.now += ms;
    },
  });
  const run = (a: string[], mm: Manifest = m) => scopeAddEmailClient(mm, argv(a), deps());
  const noSecrets = () => {
    const text = out.join('\n');
    for (const f of secretFragments([owner])) expect(text).not.toContain(f);
    for (const part of [key.d, key.p, key.q, key.dp, key.dq, key.qi]) expect(text).not.toContain(part.slice(0, 24));
  };

  it('dry run: reads the scope fresh, mints and checks the proof, prints the plan, sends nothing', async () => {
    await run(['--scope', 's2']);
    expect(chain.sent).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain(`scope:add-email-client on sandbox-dev: scope s2 on ${m.signer}, client ["email","email:s2"]`);
    expect(text).toContain(`owner ${OWNER} (Owner::Near; full-access key ${owner.getPublicKey().toString()}`);
    expect(text).toContain('action_nonce 4');
    expect(text).toContain(`kid ${pubOf(key).kid}); sub hana-client-proof, aud email:s2, nonce ${clientProofNonce(m.signer, 's2', 4)} (action_nonce 4)`);
    expect(text).toContain('checked against the contract\'s rules with the manifest\'s public key and with get_issuer_keys("email"): OK');
    expect(text).toContain(`propose_change({"scope_id":"s2","auth":"Near","change":{"AddClient":{"provider":"email","aud":"email:s2"}},"client_proof":<above>}) signed by ${OWNER}, 0.01 NEAR, 150 Tgas`);
    expect(text).toContain('execute_change(s2, 4) signed by');
    expect(text).toContain('check get_scope lists ["email","email:s2"]');
    expect(out.at(-1)).toBe(EMAIL_CLIENT_DRY_RUN_LINE);
    // The printed proof passes the contract's checks for s2 at action_nonce 4.
    const proof = out.find((l) => l.startsWith('  client_proof: '))!.slice('  client_proof: '.length);
    const rules = { issValues: [m.emailIssuer!.iss], keys: chain.keys as never, policy: chain.selfIssued as never, signerAccount: m.signer, scopeId: 's2', actionNonce: 4, nowMs: NOW };
    expect(clientProofProblems(proof, rules)).toEqual([]);
    noSecrets();
  });

  it('--yes: proposes (owner, 0.01 NEAR, 150 Tgas), waits the timelock, executes and confirms', async () => {
    await run(['--scope', 's2', '--yes']);
    expect(chain.sent.map((s) => [s.signer, s.receiver, s.method])).toEqual([
      [OWNER, m.signer, 'propose_change'],
      [OWNER, m.signer, 'execute_change'],
    ]);
    const [propose, execute] = chain.sent as [Sent, Sent];
    expect(propose.deposit).toBe(PROPOSE_DEPOSIT);
    expect(PROPOSE_DEPOSIT).toBe(NEAR / 100n);
    expect(propose.gas).toBe(PROPOSE_GAS);
    expect(propose.args).toMatchObject({ scope_id: 's2', auth: 'Near', change: { AddClient: { provider: 'email', aud: 'email:s2' } } });
    expect(Object.keys(propose.args)).toEqual(['scope_id', 'auth', 'change', 'client_proof']);
    expect(clientProofProblems(propose.args.client_proof as string, { issValues: [m.emailIssuer!.iss], keys: chain.keys as never, policy: chain.selfIssued as never, signerAccount: m.signer, scopeId: 's2', actionNonce: 4, nowMs: NOW })).toEqual([]);
    expect(execute).toMatchObject({ args: { scope_id: 's2', change_id: 4 }, gas: EXECUTE_GAS, deposit: 0n });
    expect(sleeps).toEqual([63_000]);
    expect(chain.scopes.get('s2')!.clients).toContainEqual(['email', 'email:s2']);
    expect(out.at(-1)).toMatch(/^Done: get_scope\(s2\) lists \["email","email:s2"\]/u);
    noSecrets();
  });

  it('retries an execute_change the block clock still sees as timelocked', async () => {
    chain.lagMs = 6_000;
    await run(['--scope', 's2', '--yes']);
    expect(chain.sent.map((s) => s.method)).toEqual(['propose_change', 'execute_change', 'execute_change']);
    expect(sleeps).toEqual([63_000, 5_000]);
    expect(out.at(-1)).toMatch(/^Done/u);
  });

  it('leaves a change that unlocks in more than 10 minutes pending, and a re-run executes it without re-proposing', async () => {
    chain.config = { paused: false, change_delay_ms: 3_600_000 };
    await run(['--scope', 's2', '--yes']);
    expect(chain.sent.map((s) => s.method)).toEqual(['propose_change']);
    expect(out.at(-1)).toMatch(/more than 10 min away: not waiting\. Re-run this command with --yes/u);
    expect(sleeps).toEqual([]);
    // Dry run of the re-run: the plan names the pending change.
    out = [];
    await run(['--scope', 's2']);
    expect(out.join('\n')).toContain('already pending as change #4');
    expect(out.at(-1)).toBe(EMAIL_CLIENT_DRY_RUN_LINE);
    chain.now += 3_600_000 - 5 * 60_000;
    await run(['--scope', 's2', '--yes']);
    expect(chain.sent.map((s) => s.method)).toEqual(['propose_change', 'execute_change']);
    expect(sleeps).toEqual([5 * 60_000 + 3_000]);
    expect(chain.scopes.get('s2')!.clients).toContainEqual(['email', 'email:s2']);
  });

  describe('refuses', () => {
    const refuses = async (re: RegExp, a: string[] = ['--scope', 's2', '--yes'], mm: Manifest = m) => {
      await expect(run(a, mm)).rejects.toThrow(re);
      expect(chain.sent).toEqual([]);
    };

    it('every env but local* and sandbox*, before reading anything', async () => {
      await refuses(/dev envs \(local\*, sandbox\*\) only/u, ['--scope', 's2', '--yes'], { ...m, name: 'staging' });
      expect(chain.reads).toBe(0);
    });

    it('a malformed or missing --scope, an unknown scope', async () => {
      await refuses(/--scope is required/u, ['--yes']);
      await refuses(/--scope must be a scope id/u, ['--scope', 'S2#x']);
      await refuses(/No scope s9/u, ['--scope', 's9']);
    });

    it('an RPC that is not testnet, a paused contract', async () => {
      chain.chainId = 'mainnet';
      await refuses(/is not a testnet RPC/u);
      chain.chainId = 'testnet';
      chain.config = { paused: true, change_delay_ms: 60_000 };
      await refuses(/is paused/u);
    });

    it('a scope that already has the email client', async () => {
      chain.scopes.get('s2')!.clients.push(['email', 'email:s2']);
      await refuses(/already has the email client \["email","email:s2"\]: nothing to do/u);
    });

    it('when the issuer is not on chain, not self-issued, or the active key is not active on chain', async () => {
      chain.issuer = null;
      await refuses(/get_issuer\("email"\) is null/u);
      chain.issuer = { provider: 'email', iss_values: ['https://elsewhere.example/v1/email'], kids: [] };
      await refuses(/is not one of get_issuer\("email"\)\.iss_values/u);
      chain.issuer = { provider: 'email', iss_values: [m.emailIssuer!.iss], kids: [] };
      chain.selfIssued = null;
      await refuses(/get_self_issued\("email"\) is null/u);
      chain.selfIssued = { provider: 'email', signers: [{ id: 'hana', kids: [pubOf(standby).kid] }], required: 1 };
      chain.keys = [pubOf(standby)].map(({ kid, n, e }) => ({ kid, n, e }));
      await refuses(/active email key .* is not active on chain/u);
      chain.keys = [{ kid: pubOf(key).kid, n: standby.n, e: standby.e }];
      await refuses(/differs from emailIssuer\.publicKeys/u);
      chain.keys = [pubOf(key)].map(({ kid, n, e }) => ({ kid, n, e }));
      await refuses(/belongs to no signer of get_self_issued/u);
    });

    it('a co-signed policy (one local key is not enough)', async () => {
      chain.selfIssued = { provider: 'email', signers: [{ id: 'hana', kids: [pubOf(key).kid] }, { id: 'cosign', kids: [] }], required: 2 };
      await refuses(/fails the contract's checks .*Not enough signatures/u);
    });

    it('a scope with no NEAR owner, or none whose full-access key is in the keychain and on chain', async () => {
      chain.scopes.get('s2')!.owners = [{ Oidc: { provider: 'google', sub: '123' } }];
      await refuses(/has no Owner::Near/u);
      chain.scopes.get('s2')!.owners = [{ Near: { account_id: 'someone-else.testnet' } }];
      await refuses(/someone-else\.testnet: no key in ~\/\.near-credentials\/testnet\//u);
      chain.scopes.get('s2')!.owners = [{ Near: { account_id: OWNER } }];
      chain.accessKeys.set(OWNER, [fullEntry(KeyPair.fromRandom('ed25519'))]);
      await refuses(/is not a full-access key of the account on chain/u);
    });

    it('a missing signing key file, or one that is not the manifest\'s active key', async () => {
      const file = join(roots.secretsRoot, '.secrets', m.name, 'email-issuer-signing-key.json');
      writeSigningKey(roots.secretsRoot, m.name, standby);
      await refuses(/holds key .*, not the manifest's active key/u);
      chmodSync(file, 0o644);
      await refuses(/must be 0600/u);
      unlinkSync(file);
      await refuses(/email-issuer-signing-key\.json doesn't exist/u);
      expect(out.join('\n')).not.toContain(standby.d.slice(0, 24));
    });

    it('an env without emailIssuer', async () => {
      const { emailIssuer: _e, ...bare } = m;
      await refuses(/has no emailIssuer/u, ['--scope', 's2'], bare as Manifest);
    });
  });

  it('compares keys as numbers (the contract strips leading zeros)', () => {
    expect(sameRsaKey({ n: 'AAEC', e: 'AQAB' }, { n: 'AQI', e: 'AQAB' })).toBe(true);
    expect(sameRsaKey({ n: 'AQI', e: 'AQAB' }, { n: 'AQM', e: 'AQAB' })).toBe(false);
  });
});
