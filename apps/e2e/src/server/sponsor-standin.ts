// TEST ONLY: a stand-in for the EVM gas sponsorship routes (docs/api.md "EVM gas sponsorship"), so the local stack runs
// a sponsored action end to end before the real API and relayer (apps/api/src/evm/, PRs of their own) are merged. It is
// never part of any deployed Worker: only the e2e stack's MockApi routes to it. Nothing is sent to any chain: a send
// that passes the checks below answers `executed` with a made-up transaction hash.
//
// What it checks, as the real API will (so the vault's side is exercised for real):
//   - prepare and send only from the vault's origin acting for an origin of the app (D832); status from the app's pages;
//   - the session proof on prepare and send (D856, core checkEvmSponsorSessionProof: the session key's signature over
//     the route, origin, app and body, and the session's wallet proof of the account), each nonce once;
//   - send: strict body, value 0, the stack's relayer, the Execute signature over the pinned delegate recovering to the
//     account, the authorization (pinned delegate, this chain, the account's) exactly when the account isn't set up,
//     the account's execute nonce.
// What it doesn't: the allowlist, budgets, gas, fees, the directory. The account's setup and transaction count live on
// the stack's mocked EVM chain (partner.ts MockEvm `accounts`), which the vault reads itself (D855): a send with an
// authorization sets the account's code to the pinned delegate's designator and bumps its count; prepare reports them.
// The account's execute nonce is kept here. Tests each use their own scope, so each signs in with its own account.
//
// Control (no CORS; the default stack's API only): POST /__e2e/evm-sponsor {account, delegation} sets an account's code
// (`none`, `journear`, `other`); {appId, hold: true|false} holds the app's sends until released; GET
// /__e2e/evm-sponsor?appId= → the app's {prepares, sends, executed, proofRefusals}.
import { checkEvmSponsorSessionProof, toHex, sha256 } from '@hana-id/core';
import { SPONSOR_DELEGATES, executeDigest, recoverAuthorization, recoverExecuteSigner } from '@hana-id/core/evm-sponsor';
import { E2E_ENV, E2E_SPONSOR_RELAYER, EVM_CHAIN_ID } from '../stack.ts';
import type { D1Shim } from './d1.ts';
import { json } from './http.ts';

const DELEGATE = (SPONSOR_DELEGATES[EVM_CHAIN_ID] as { address: `0x${string}` }).address;
const ROUTES = new Set(['/v1/evm/sponsor/prepare', '/v1/evm/sponsor/send', '/v1/evm/sponsor/status']);

type Body = Record<string, unknown>;
/** The mocked chain's accounts (MockEvm `accounts`): lowercase address → code and transaction count. */
export type EvmAccounts = Map<string, { code: `0x${string}`; nonce: number }>;
const DESIGNATOR = `0xef0100${DELEGATE.slice(2).toLowerCase()}` as const;
const OTHER_DESIGNATOR = `0xef0100${'42'.repeat(20)}` as const;
interface AccountState {
  delegation: 'none' | 'journear' | 'other';
  accountNonce: bigint;
  executeNonce: bigint;
}

const isObj = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

export class SponsorStandIn {
  private readonly executeNonces = new Map<string, bigint>();
  private readonly seenNonces = new Set<string>();
  private readonly held = new Map<string, { promise: Promise<void>; release: () => void }>();
  private readonly logs = new Map<string, { prepares: number; sends: number; executed: number; proofRefusals: string[] }>();

  private log(appId: string) {
    let l = this.logs.get(appId);
    if (!l) {
      l = { prepares: 0, sends: 0, executed: 0, proofRefusals: [] };
      this.logs.set(appId, l);
    }
    return l;
  }

  constructor(
    private readonly d1: D1Shim,
    private readonly vaultOrigin: string,
    private readonly chainAccounts: EvmAccounts = new Map(),
  ) {}

  static handles(pathname: string): boolean {
    return ROUTES.has(pathname);
  }

  /** The account as the mocked chain has it, and its execute nonce. */
  private state(account: string): AccountState {
    const on = this.chainAccounts.get(account.toLowerCase());
    const delegation = !on || on.code === '0x' ? 'none' : on.code === DESIGNATOR ? 'journear' : 'other';
    return { delegation, accountNonce: BigInt(on?.nonce ?? 0), executeNonce: this.executeNonces.get(account.toLowerCase()) ?? 0n };
  }

  /** What a type-4 transaction with the authorization does to the account: the designator, one more transaction. */
  private setUp(account: string): void {
    const key = account.toLowerCase();
    this.chainAccounts.set(key, { code: DESIGNATOR, nonce: (this.chainAccounts.get(key)?.nonce ?? 0) + 1 });
  }

  private app(key: string | null): { id: string; origins: string[] } | null {
    if (!key) return null;
    const row = this.d1.db.prepare('SELECT app_id AS id FROM app_keys WHERE key = ?').get(key) as { id: string } | undefined;
    if (!row) return null;
    const origins = this.d1.db.prepare('SELECT origin FROM app_origins WHERE app_id = ?').all(row.id).map((r) => String(r.origin));
    return { id: row.id, origins };
  }

  async handle(req: Request, url: URL): Promise<Response> {
    const origin = req.headers.get('origin');
    const route = url.pathname.slice('/v1/evm/sponsor/'.length) as 'prepare' | 'send' | 'status';
    const cors: Record<string, string> = origin
      ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-hana-key, x-hana-parent-origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'retry-after, x-request-id', vary: 'Origin' }
      : {};
    const answer = (status: number, body: Body) => json(status, { ...body, requestId: 'rq_e2e_sponsor' }, cors);
    const refuse = (status: number, code: string, extra: Body = {}) => answer(status, { error: code, code, ...extra });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const app = this.app(req.headers.get('x-hana-key'));
    if (!app) return refuse(401, 'unknown_app');
    if (route === 'status') {
      if (req.method !== 'GET') return refuse(405, 'method_not_allowed');
      if (origin !== this.vaultOrigin && !app.origins.includes(origin ?? '')) return refuse(403, 'origin_not_allowed');
      if (url.searchParams.get('chainId') !== String(EVM_CHAIN_ID)) return answer(200, { available: false, reason: 'chain_not_enabled' });
      return answer(200, { available: true, remainingToday: '10000000000000000' });
    }
    if (req.method !== 'POST') return refuse(405, 'method_not_allowed');
    // D832: the vault's calls only, acting for an origin of the app.
    const parent = req.headers.get('x-hana-parent-origin') ?? '';
    if (origin !== this.vaultOrigin || !app.origins.includes(parent)) return refuse(403, 'origin_not_allowed');
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return refuse(400, 'bad_request');
    }
    if (!isObj(body)) return refuse(400, 'bad_request');
    // D856: the session proof, then each nonce once.
    const proof = checkEvmSponsorSessionProof({ method: route, body, ctx: { signer: E2E_ENV.signer, appId: app.id, parentOrigin: parent }, nowMs: Date.now() });
    if (!proof.ok) {
      this.log(app.id).proofRefusals.push(proof.reason);
      return refuse(401, proof.reason);
    }
    const marker = `${toHex(proof.sessionPublicKey)}:${toHex(proof.nonce)}`;
    if (this.seenNonces.has(marker)) return refuse(409, 'session_proof_used');
    this.seenNonces.add(marker);
    if (body.chainId !== EVM_CHAIN_ID) return refuse(400, 'chain_not_enabled');
    const s = this.state(proof.account);
    if (route === 'prepare') {
      this.log(app.id).prepares += 1;
      return answer(200, {
        delegation: s.delegation,
        accountNonce: s.accountNonce.toString(),
        executeNonce: s.delegation === 'other' ? null : s.executeNonce.toString(),
        serverNow: Math.floor(Date.now() / 1000),
        relayer: E2E_SPONSOR_RELAYER,
        implementation: DELEGATE,
        minGasFloor: '100000',
        maxMinGas: '240000',
        deadlineMaxS: 600,
        allowed: s.delegation !== 'other',
        ...(s.delegation === 'other' ? { reason: 'delegated_elsewhere' } : {}),
      });
    }
    this.log(app.id).sends += 1;
    await this.held.get(app.id)?.promise;
    return this.send(body, s, proof.account, refuse, answer, this.log(app.id));
  }

  private send(b: Body, s: AccountState, account: string, refuse: (status: number, code: string, extra?: Body) => Response, answer: (status: number, body: Body) => Response, log: { executed: number }): Response {
    const keys = ['chainId', 'account', 'calls', 'executeNonce', 'deadline', 'relayer', 'minGas', 'signature', 'authorization', 'sessionProof'];
    if (Object.keys(b).some((k) => !keys.includes(k)) || !Array.isArray(b.calls)) return refuse(400, 'bad_request');
    if (b.relayer !== E2E_SPONSOR_RELAYER) return refuse(400, 'wrong_relayer');
    if (s.delegation === 'other') return refuse(409, 'delegated_elsewhere');
    let calls: { to: `0x${string}`; value: bigint; data: `0x${string}` }[];
    try {
      calls = (b.calls as Body[]).map((c) => {
        if (c.value !== '0') throw new Error('value');
        return { to: c.to as `0x${string}`, value: 0n, data: c.data as `0x${string}` };
      });
    } catch {
      return refuse(403, 'value_not_allowed');
    }
    const input = { chainId: EVM_CHAIN_ID, account: account as `0x${string}`, implementation: DELEGATE, calls, nonce: BigInt(String(b.executeNonce)), deadline: BigInt(String(b.deadline)), relayer: E2E_SPONSOR_RELAYER as `0x${string}`, minGas: BigInt(String(b.minGas)) };
    try {
      if (recoverExecuteSigner(input, b.signature as `0x${string}`).toLowerCase() !== account.toLowerCase()) return refuse(401, 'invalid_signature');
    } catch {
      return refuse(401, 'invalid_signature');
    }
    const a = b.authorization;
    if (s.delegation === 'none') {
      if (!isObj(a)) return refuse(409, 'delegation_required');
      if (a.chainId !== EVM_CHAIN_ID || String(a.address).toLowerCase() !== DELEGATE.toLowerCase()) return refuse(403, 'authorization_not_pinned');
      try {
        const signer = recoverAuthorization({ chainId: EVM_CHAIN_ID, address: a.address as `0x${string}`, nonce: BigInt(String(a.nonce)), yParity: a.yParity as 0 | 1, r: a.r as `0x${string}`, s: a.s as `0x${string}` });
        if (signer.toLowerCase() !== account.toLowerCase()) return refuse(401, 'invalid_authorization_signature');
      } catch {
        return refuse(401, 'invalid_authorization_signature');
      }
      if (BigInt(String(a.nonce)) !== s.accountNonce) return refuse(409, 'authorization_nonce_stale', { accountNonce: s.accountNonce.toString() });
    }
    if (input.nonce !== s.executeNonce) return refuse(409, 'nonce_stale', { executeNonce: s.executeNonce.toString() });
    if (s.delegation === 'none') this.setUp(account);
    this.executeNonces.set(account.toLowerCase(), s.executeNonce + 1n);
    log.executed += 1;
    // Not a real transaction: a hash made from the batch's digest, so it is unique per batch.
    return answer(200, { transactionHash: `0x${toHex(sha256(executeDigest(input)))}`, status: 'executed' });
  }

  /** The control endpoint (see the header). */
  async control(req: Request, url: URL): Promise<Response> {
    if (req.method === 'GET') return json(200, this.log(url.searchParams.get('appId') ?? ''));
    const b = (await req.json()) as Body;
    if (typeof b.hold === 'boolean' && typeof b.appId === 'string') {
      const held = this.held.get(b.appId);
      if (b.hold && !held) {
        let release!: () => void;
        const promise = new Promise<void>((r) => (release = r));
        this.held.set(b.appId, { promise, release });
      } else if (!b.hold && held) {
        held.release();
        this.held.delete(b.appId);
      }
    }
    if (typeof b.account === 'string' && (b.delegation === 'none' || b.delegation === 'journear' || b.delegation === 'other')) {
      const key = b.account.toLowerCase();
      const nonce = this.chainAccounts.get(key)?.nonce ?? 0;
      this.chainAccounts.set(key, { code: b.delegation === 'none' ? '0x' : b.delegation === 'journear' ? DESIGNATOR : OTHER_DESIGNATOR, nonce });
    }
    return json(200, { ok: true });
  }
}
