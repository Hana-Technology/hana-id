// The vault's sponsored EVM action (D855, D856; src/vault/evm-sponsor.ts) against a fake sponsorship API that checks
// what the real one will: the session proof on both calls (core checkEvmSponsorSessionProof), the Execute signature
// over the pinned implementation, the authorization. Thinking as a malicious page and as a lying API: neither may get
// a signature over anything the window didn't show, nor choose the delegate, relayer, chain or account; no signature
// reaches the page, an error or the result.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkEvmSponsorSessionProof, parsePortRequest } from '@hana-id/core';
import { decodeSponsoredAction } from '@hana-id/core/decode';
import { APP_ID, type ApiCall, Browser, apiError, ENV, type Google, PK, type Tab, START_MS, answer, google, login, makeConfig, openApproval, readyTab, waitLauncher } from './harness.ts';
import { SPONSOR_DELEGATES, decodeSponsorSubject, recoverAuthorization, recoverExecuteSigner } from '@hana-id/core/evm-sponsor';
import type { HanaEnv } from '../../src/hana-env.ts';
import { SPONSOR_TEXT, sponsorChains } from '../../src/vault/evm-sponsor.ts';

const DELEGATE = (SPONSOR_DELEGATES[31337] as { address: `0x${string}` }).address;
/** anvil's published second dev account's address (a public test vector), as the e2e stack's relayer. */
const RELAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHECK_IN = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e';
const CALL = { to: CHECK_IN, value: '0x0', data: '0x183ff085' };
const RPC_A = 'https://evm-a.test/a';
const RPC_B = 'https://evm-b.test/b';
const SPONSOR_ENV: HanaEnv = Object.freeze({ ...ENV, name: 'local-test', evmSponsor: Object.freeze({ '31337': Object.freeze({ delegate: DELEGATE, relayer: RELAYER, rpc: RPC_A, rpcFallback: RPC_B }) }) });
const DESIGNATOR = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;
const OTHER_DESIGNATOR = `0xef0100${'42'.repeat(20)}`;

/**
 * The chain as the build's two endpoints answer it (D855): the account's code and its latest and pending transaction
 * counts. Each endpoint can lie (`lies`) or be down (`down`); `reads` counts what the vault asked.
 */
class FakeEvmChain {
  code = '0x';
  latest = 3n;
  pending = 3n;
  chainId = 31337;
  readonly down = new Set<string>();
  readonly lies = new Map<string, Partial<{ code: string; latest: bigint; pending: bigint; chainId: number }>>();
  readonly reads: { endpoint: string; method: string }[] = [];

  constructor(t: Tab) {
    for (const [path, endpoint] of [['/a', RPC_A], ['/b', RPC_B]] as const) t.browser.backend.overrides.set(path, (call) => this.answer(endpoint, call));
  }

  private answer(endpoint: string, call: ApiCall): Response {
    if (this.down.has(endpoint)) throw new TypeError('Failed to fetch');
    const b = call.body as { id: unknown; method: string; params: unknown[] };
    this.reads.push({ endpoint, method: b.method });
    const v = { code: this.code, latest: this.latest, pending: this.pending, chainId: this.chainId, ...this.lies.get(endpoint) };
    const result =
      b.method === 'eth_chainId' ? `0x${v.chainId.toString(16)}` : b.method === 'eth_getCode' ? v.code : b.method === 'eth_getTransactionCount' ? `0x${(b.params[1] === 'pending' ? v.pending : v.latest).toString(16)}` : null;
    return json(200, { jsonrpc: '2.0', id: b.id, result });
  }

  /** The account set up with the pinned delegate, as a send with an authorization leaves it. */
  setUp(): void {
    this.code = DESIGNATOR;
    this.latest += 1n;
    this.pending = this.latest;
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The sponsorship API as the vault meets it: prepare's hints, send's checks; each request's proof checked. */
class FakeSponsorApi {
  delegation: 'none' | 'journear' | 'other' = 'none';
  executeNonce = 0n;
  /** An accountNonce for prepare to answer instead of the chain's (a lying API). */
  lieNonce: bigint | null = null;
  /** Fields of prepare's answer to replace (a lying API). */
  lie: Record<string, unknown> = {};
  /** An answer to send instead of the normal one (a refusal, a network failure). */
  sendAnswer: (() => Response | Promise<Response>) | null = null;
  /** Resolves send when set (held until the test releases it). */
  hold: Promise<void> | null = null;
  readonly prepares: Record<string, unknown>[] = [];
  readonly sends: Record<string, unknown>[] = [];
  readonly proofRefusals: string[] = [];
  private seq = 0;

  readonly chain: FakeEvmChain;

  constructor(private readonly t: Tab) {
    this.chain = new FakeEvmChain(t);
    t.browser.backend.overrides.set('/v1/evm/sponsor/prepare', (call) => this.prepare(call));
    t.browser.backend.overrides.set('/v1/evm/sponsor/send', (call) => this.send(call));
  }

  private proof(call: ApiCall, method: 'prepare' | 'send'): Response | null {
    const r = checkEvmSponsorSessionProof({ method, body: call.body as Record<string, unknown>, ctx: { signer: ENV.signer, appId: APP_ID, parentOrigin: call.headers['x-hana-parent-origin'] ?? '' }, nowMs: this.t.browser.backend.serverNow() });
    if (r.ok) return null;
    this.proofRefusals.push(r.reason);
    return apiError(401, r.reason);
  }

  private prepare(call: ApiCall): Response {
    this.prepares.push(call.body as Record<string, unknown>);
    const refused = this.proof(call, 'prepare');
    if (refused) return refused;
    return json(200, {
      delegation: this.delegation,
      accountNonce: (this.lieNonce ?? this.chain.latest).toString(),
      executeNonce: this.delegation === 'other' ? null : this.executeNonce.toString(),
      serverNow: Math.floor(this.t.browser.backend.serverNow() / 1000),
      relayer: RELAYER,
      implementation: DELEGATE,
      minGasFloor: '100000',
      maxMinGas: '240000',
      deadlineMaxS: 600,
      allowed: this.delegation !== 'other',
      ...(this.delegation === 'other' ? { reason: 'delegated_elsewhere' } : {}),
      requestId: 'rq',
      ...this.lie,
    });
  }

  private async send(call: ApiCall): Promise<Response> {
    const b = call.body as Record<string, unknown>;
    this.sends.push(b);
    const refused = this.proof(call, 'send');
    if (refused) return refused;
    if (this.hold) await this.hold;
    if (this.sendAnswer) return this.sendAnswer();
    const calls = (b.calls as { to: `0x${string}`; value: string; data: `0x${string}` }[]).map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));
    // The implementation is always the pinned delegate (never the request's), as the API's step 3.
    const input = { chainId: b.chainId as number, account: b.account as `0x${string}`, implementation: DELEGATE, calls, nonce: BigInt(b.executeNonce as string), deadline: BigInt(b.deadline as string), relayer: b.relayer as `0x${string}`, minGas: BigInt(b.minGas as string) };
    if (recoverExecuteSigner(input, b.signature as `0x${string}`) !== b.account) return apiError(401, 'invalid_signature');
    const a = b.authorization as Record<string, unknown> | undefined;
    if (this.delegation === 'none' && !a) return apiError(409, 'delegation_required');
    if (a && recoverAuthorization({ chainId: a.chainId as number, address: a.address as `0x${string}`, nonce: BigInt(a.nonce as string), yParity: a.yParity as 0 | 1, r: a.r as `0x${string}`, s: a.s as `0x${string}` }) !== b.account) return apiError(401, 'invalid_authorization_signature');
    if (a) this.chain.setUp();
    this.delegation = 'journear';
    this.executeNonce += 1n;
    this.seq += 1;
    return json(200, { transactionHash: `0x${this.seq.toString(16).padStart(64, 'a')}`, status: 'executed', requestId: 'rq', extra: 'dropped' });
  }
}

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function session(o: { env?: HanaEnv; sdk?: string; config?: ReturnType<typeof makeConfig> } = {}): Promise<{ t: Tab; evm: `0x${string}`; api: FakeSponsorApi }> {
  const t = await readyTab(new Browser(), { googleJwk: g.jwk, env: o.env ?? SPONSOR_ENV, sdk: o.sdk ?? '0.5.0', ...(o.config ? { config: o.config } : {}) });
  tabs.push(t);
  const api = new FakeSponsorApi(t);
  const { reply } = await login(t, g);
  return { t, api, evm: (reply.result as { addresses: { evm: `0x${string}` } }).addresses.evm };
}

const send = (t: Tab, calls: unknown[] = [CALL], chainId = 31337) => t.request('evm_sendSponsored', { chainId, calls });

/**
 * The approval window the request is waiting on and its message: opened from the launcher, or `open` (the window an
 * earlier request used, which the vault keeps for the next one) with its `n`th request.
 */
async function windowOf(t: Tab, open?: { popup: ReturnType<typeof openApproval>; n: number }) {
  if (open) return { popup: open.popup, m: await open.popup.next('hana:approve-request', open.n) };
  await waitLauncher(t, 'Review in Journear Passport');
  const popup = openApproval(t);
  return { popup, m: await popup.next('hana:approve-request') };
}

const noWindow = (t: Tab) => expect(t.launcher.label).toBeNull();
/** No signature, authorization or digest of the batch is anywhere in what the page got. */
function nothingSigned(t: Tab, api: FakeSponsorApi): void {
  const page = JSON.stringify(t.portMessages);
  for (const b of api.sends) {
    expect(page).not.toContain((b.signature as string).slice(2, 40));
    const a = b.authorization as { r: string } | undefined;
    if (a) expect(page).not.toContain(a.r.slice(2, 40));
  }
}

describe('the build’s sponsored chains (status and ready, D855)', () => {
  it('are reported to an SDK of 0.5.0 or later, logged out and in', async () => {
    const { t } = await session();
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in', sponsoredChains: [31337] });
    const fresh = await readyTab(new Browser(), { env: SPONSOR_ENV, sdk: '0.5.0' });
    tabs.push(fresh);
    expect((await fresh.request('hana_status')).result).toEqual({ status: 'logged_out', persistence: 'session', sponsoredChains: [31337] });
  });

  it('never to an older SDK (its validators refuse the key), nor from a build without sponsorship', async () => {
    const old = await readyTab(new Browser(), { env: SPONSOR_ENV, sdk: '0.4.1' });
    const none = await readyTab(new Browser(), { sdk: '0.5.0' });
    tabs.push(old, none);
    expect((await old.request('hana_status')).result).not.toHaveProperty('sponsoredChains');
    expect((await none.request('hana_status')).result).not.toHaveProperty('sponsoredChains');
  });

  it('a local chain only in a local build; a delegate other than the pinned one, a bad relayer or a mainnet never', () => {
    const entry = { delegate: DELEGATE, relayer: RELAYER, rpc: RPC_A };
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': entry } }).map((c) => c.chainId)).toEqual([31337]);
    expect(sponsorChains({ name: 'sandbox-dev', evmSponsor: { '31337': entry } })).toEqual([]);
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': { ...entry, delegate: RELAYER } } })).toEqual([]);
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': { ...entry, relayer: '0x0000000000000000000000000000000000000000' } } })).toEqual([]);
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': { ...entry, relayer: DELEGATE } } })).toEqual([]);
    // Chain 1 (a mainnet) and 84532 (no pinned delegate yet) never; nor a non-canonical key.
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '1': entry, '84532': entry, '031337': entry, '0': entry } })).toEqual([]);
  });
});

describe('refused before any window or API call (D855)', () => {
  it.each([
    ['a chain the build doesn’t sponsor', [CALL], 84532, 'chain_not_sponsored', SPONSOR_TEXT.notOffered],
    ['a call to the relayer', [{ ...CALL, to: RELAYER }], 31337, 'target_not_allowed', SPONSOR_TEXT.notForThis],
    ['a call to the delegate', [{ ...CALL, to: DELEGATE }], 31337, 'target_not_allowed', SPONSOR_TEXT.notForThis],
  ])('%s', async (_n, calls, chainId, reason, message) => {
    const { t, api } = await session();
    const r = await send(t, calls, chainId);
    expect(r.error).toMatchObject({ code: 4100, message, data: { reason } });
    expect(api.prepares).toHaveLength(0);
    noWindow(t);
  });

  it('a call to the user’s own account', async () => {
    const { t, api, evm } = await session();
    expect((await send(t, [{ ...CALL, to: evm }])).error).toMatchObject({ code: 4100, data: { reason: 'target_not_allowed' } });
    expect(api.prepares).toHaveLength(0);
  });

  it('a test app on a mainnet: mainnet_not_allowed (D39), even with the chain in the build', async () => {
    const env = { ...SPONSOR_ENV, evmSponsor: { ...SPONSOR_ENV.evmSponsor, '1': { delegate: DELEGATE, relayer: RELAYER } } };
    const { t, api } = await session({ env });
    expect((await send(t, [CALL], 1)).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed' } });
    expect(api.prepares).toHaveLength(0);
  });

  it('a live app on a mainnet the build lists: not sponsored (testnets only)', async () => {
    const env = { ...SPONSOR_ENV, evmSponsor: { ...SPONSOR_ENV.evmSponsor, '8453': { delegate: DELEGATE, relayer: RELAYER } } };
    const { t, api } = await session({ env, config: makeConfig({ publishableKey: PK.replace('pk_test_', 'pk_live_') }) });
    expect((await send(t, [CALL], 8453)).error).toMatchObject({ code: 4100, data: { reason: 'chain_not_sponsored' } });
    expect(api.prepares).toHaveLength(0);
  });

  it('value, a bare call, chain 0 or an extra field are refused at the port (protocol), before the vault', () => {
    expect(parsePortRequest({ v: 1, id: 'r1', method: 'evm_sendSponsored', params: { chainId: 31337, calls: [CALL] } })).not.toBeNull();
    for (const params of [
      { chainId: 31337, calls: [{ ...CALL, value: '0x1' }] },
      { chainId: 31337, calls: [{ ...CALL, data: '0x' }] },
      { chainId: 0, calls: [CALL] },
      { chainId: 31337, calls: [CALL], relayer: RELAYER },
      { chainId: 31337, calls: [{ ...CALL, gas: '0x1' }] },
    ]) {
      expect(parsePortRequest({ v: 1, id: 'r1', method: 'evm_sendSponsored', params })).toBeNull();
    }
  });

  it('logged out: 4100', async () => {
    const t = await readyTab(new Browser(), { env: SPONSOR_ENV, sdk: '0.5.0' });
    tabs.push(t);
    expect((await send(t)).error?.code).toBe(4100);
  });
});

describe('the first action: one window with the setup, then the authorization and the batch (D831, D855)', () => {
  it('signs exactly the shown subject, sends it from the vault, answers {transactionHash, status}', async () => {
    const { t, api, evm } = await session();
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    expect(m.kind).toBe('evm_sponsored');
    // The popup's own decode, with the build's chains, accepts it and sees the setup.
    const decoded = decodeSponsoredAction(m.bytes as Uint8Array, 31337, evm, SPONSOR_ENV.evmSponsor, START_MS);
    expect(decoded.setup).toBe(true);
    const subject = decodeSponsorSubject(m.bytes as Uint8Array);
    expect(subject).toMatchObject({ chainId: 31337, account: evm, delegate: DELEGATE, relayer: RELAYER, authNonce: 3n, executeNonce: 0n, minGas: 240000n, deadline: BigInt(START_MS / 1000 + 300) });
    expect(subject.calls).toEqual([{ to: CHECK_IN, value: 0n, data: '0x183ff085' }]);
    expect(api.sends).toHaveLength(0);
    answer(t, popup, m, true);
    const r = await reply;
    expect(r.result).toEqual({ transactionHash: `0x${'1'.padStart(64, 'a')}`, status: 'executed' });
    expect(api.proofRefusals).toEqual([]);
    const b = api.sends[0]!;
    // Every value of the send is the approved subject's.
    expect(b).toMatchObject({ chainId: 31337, account: evm, executeNonce: '0', deadline: String(subject.deadline), relayer: RELAYER, minGas: '240000', calls: [{ to: CHECK_IN, value: '0', data: '0x183ff085' }] });
    expect(b.authorization).toMatchObject({ chainId: 31337, address: DELEGATE, nonce: '3' });
    nothingSigned(t, api);
  });

  it('a later action: no setup in the window and no authorization sent', async () => {
    const { t, api } = await session();
    api.delegation = 'journear';
    api.chain.setUp();
    api.executeNonce = 4n;
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    expect(decodeSponsorSubject(m.bytes as Uint8Array)).toMatchObject({ authNonce: null, executeNonce: 4n });
    answer(t, popup, m, true);
    expect((await reply).result).toMatchObject({ status: 'executed' });
    expect(api.sends[0]).not.toHaveProperty('authorization');
  });

  it('declined: 4001, nothing signed or sent', async () => {
    const { t, api } = await session();
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    answer(t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
    expect(api.sends).toHaveLength(0);
  });

  it('an approval of other bytes (a forged digest) signs nothing', async () => {
    const { t, api } = await session();
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    answer(t, popup, m, true, new Uint8Array(32).fill(1));
    // A wrong digest is never an approval: the vault keeps waiting, then the test rejects it properly.
    answer(t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
    expect(api.sends).toHaveLength(0);
  });
});

describe('a lying or refusing prepare (D840, D855)', () => {
  it('delegated elsewhere: a plain refusal, no window', async () => {
    const { t, api } = await session();
    api.delegation = 'other';
    expect((await send(t)).error).toMatchObject({ code: 4100, message: SPONSOR_TEXT.delegatedElsewhere, data: { reason: 'delegated_elsewhere' } });
    noWindow(t);
    // Even with `allowed: true` (an API that forgot the rule).
    api.lie = { allowed: true, reason: undefined, executeNonce: null };
    expect((await send(t)).error).toMatchObject({ code: 4100, data: { reason: 'delegated_elsewhere' } });
  });

  it.each([
    ['budget_exhausted', SPONSOR_TEXT.budgetUsed],
    ['gas_too_high', SPONSOR_TEXT.tooBig],
    ['not_available', SPONSOR_TEXT.notAvailable],
    ['some_new_reason', SPONSOR_TEXT.notAvailable],
  ])('allowed: false (%s): refused before any window', async (reason, message) => {
    const { t, api } = await session();
    api.lie = { allowed: false, reason };
    expect((await send(t)).error).toMatchObject({ code: 4100, message });
    noWindow(t);
    expect(api.sends).toHaveLength(0);
  });

  it.each([
    ['another relayer', { relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }],
    ['another implementation', { implementation: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }],
    ['a gas window above the vault’s bound', { maxMinGas: '2000001' }],
    ['a floor above the most', { minGasFloor: '300000' }],
    ['a deadline window out of bounds', { deadlineMaxS: 86_400 }],
    ['a clock a few minutes off the vault’s, within the device bound', { serverNow: START_MS / 1000 + 120 }],
    ['another shape', { accountNonce: 3 }],
    ['a nonce past 2^64', { executeNonce: '18446744073709551616' }],
  ])('%s: not ready, nothing shown or signed', async (_n, lie) => {
    const { t, api } = await session();
    api.lie = lie;
    expect((await send(t)).error).toMatchObject({ code: 'api_unavailable', message: SPONSOR_TEXT.notReady, data: { reason: 'bad_answer' } });
    noWindow(t);
    expect(api.sends).toHaveLength(0);
  });

  it('a device clock far off the API’s: “your device’s clock is wrong”', async () => {
    const { t, api } = await session();
    api.lie = { serverNow: START_MS / 1000 + 600 };
    expect((await send(t)).error).toMatchObject({ code: 4100, message: SPONSOR_TEXT.clockWrong, data: { reason: 'clock_wrong' } });
  });

  it('a gas window too small for the calls: too big', async () => {
    const { t, api } = await session();
    api.lie = { minGasFloor: '10000', maxMinGas: '49999' };
    expect((await send(t, [{ ...CALL }, { ...CALL }])).error).toMatchObject({ code: 4100, data: { reason: 'gas_too_high' } });
  });

  it('a huge deadline window still signs at most 5 minutes; a short one less', async () => {
    const { t, api } = await session();
    api.lie = { deadlineMaxS: 3600 };
    let reply = send(t);
    let w = await windowOf(t);
    expect(decodeSponsorSubject(w.m.bytes as Uint8Array).deadline).toBe(BigInt(START_MS / 1000 + 300));
    answer(t, w.popup, w.m, false);
    await reply;
    api.lie = { deadlineMaxS: 200 };
    reply = send(t);
    w = await windowOf(t, { popup: w.popup, n: 1 });
    expect(decodeSponsorSubject(w.m.bytes as Uint8Array).deadline).toBe(BigInt(START_MS / 1000 + 140));
    answer(t, w.popup, w.m, false);
    await reply;
    api.lie = { deadlineMaxS: 150 };
    expect((await send(t)).error).toMatchObject({ code: 4100, data: { reason: 'not_available' } });
  });

  it('a prepare refusal keeps only exact-shape fields; a proof refusal is not shown as anything else', async () => {
    const { t } = await session();
    t.browser.backend.overrides.set('/v1/evm/sponsor/prepare', () => apiError(429, 'rate_limited', { retryAfterS: 7, secret: 'x', transactionHash: 'nope' }));
    const r = await send(t);
    expect(r.error).toMatchObject({ code: 'rate_limited', message: SPONSOR_TEXT.tooMany });
    expect(r.error?.data).toEqual({ status: 429, reason: 'rate_limited', retryAfterS: 7 });
  });
});

describe('send’s answers (D788’s style)', () => {
  async function sentWith(answerFn: () => Response | Promise<Response>) {
    const s = await session();
    s.api.sendAnswer = answerFn;
    const reply = send(s.t);
    const { popup, m } = await windowOf(s.t);
    answer(s.t, popup, m, true);
    return { ...s, r: await reply };
  }

  it('reverted: plain words, the hash, nothing else of the body', async () => {
    const hash = `0x${'cd'.repeat(32)}`;
    const { r, t, api } = await sentWith(() => apiError(422, 'reverted', { transactionHash: hash, revertData: '0xdead', signature: 'x' }));
    expect(r.error).toMatchObject({ code: 4100, message: SPONSOR_TEXT.failed });
    expect(r.error?.data).toEqual({ status: 422, reason: 'reverted', transactionHash: hash });
    nothingSigned(t, api);
  });

  it('simulation_reverted names the call; a timeout its hash (api_unavailable)', async () => {
    let { r } = await sentWith(() => apiError(422, 'simulation_reverted', { callIndex: 0 }));
    expect(r.error).toMatchObject({ code: 4100, message: SPONSOR_TEXT.wouldFail, data: { callIndex: 0 } });
    ({ r } = await sentWith(() => apiError(504, 'timeout', { transactionHash: `0x${'ef'.repeat(32)}` })));
    expect(r.error).toMatchObject({ code: 'api_unavailable', message: SPONSOR_TEXT.notConfirmed, data: { status: 504, transactionHash: `0x${'ef'.repeat(32)}` } });
  });

  it('a 429 with retry-after: rate_limited with retryAfterS', async () => {
    const { r } = await sentWith(() => json(429, { error: 'x', code: 'app_budget_exhausted', requestId: 'rq' }, { 'retry-after': '3600' }));
    expect(r.error).toMatchObject({ code: 'rate_limited', message: SPONSOR_TEXT.budgetUsed, data: { retryAfterS: 3600, reason: 'app_budget_exhausted' } });
  });

  it('no answer: the outcome is unknown, said plainly', async () => {
    const { r } = await sentWith(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(r.error).toMatchObject({ code: 'api_unavailable', message: SPONSOR_TEXT.unknownOutcome, data: { reason: 'unknown_outcome' } });
  });

  it('a 200 of another shape is not a success', async () => {
    const { r } = await sentWith(() => json(200, { transactionHash: 'abc', status: 'executed' }));
    expect(r.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'unknown_outcome' } });
  });

  it('the session ended on chain: session_ended, plainly', async () => {
    const { r } = await sentWith(() => apiError(410, 'session_ended'));
    expect(r.error).toMatchObject({ code: 'session_ended', message: SPONSOR_TEXT.signInEnded });
  });
});

describe('one action per account at a time; the clock after the approval (D855)', () => {
  it('a second action while one is in flight is refused busy, before any API call; the next one after it works', async () => {
    const { t, api } = await session();
    let release!: () => void;
    api.hold = new Promise<void>((r) => (release = r));
    const first = send(t);
    const { popup, m } = await windowOf(t);
    answer(t, popup, m, true);
    await t.waitUntil(() => api.sends.length === 1, 'the first send');
    const second = await send(t);
    expect(second.error).toMatchObject({ code: 'busy', message: SPONSOR_TEXT.busy, data: { reason: 'sponsor_in_flight' } });
    expect(api.prepares).toHaveLength(1);
    release();
    expect((await first).result).toMatchObject({ status: 'executed' });
    api.hold = null;
    const third = send(t);
    const w = await windowOf(t, { popup, n: 1 });
    answer(t, w.popup, w.m, true);
    expect((await third).result).toMatchObject({ status: 'executed' });
  });

  it('a refused first action frees the slot', async () => {
    const { t, api } = await session();
    api.delegation = 'other';
    await send(t);
    api.delegation = 'journear';
    api.chain.setUp();
    const reply = send(t);
    const w = await windowOf(t);
    answer(t, w.popup, w.m, false);
    expect((await reply).error?.code).toBe(4001);
  });

  it('approved too late (under 45 s left): nothing signed or sent', async () => {
    const { t, api } = await session();
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    t.browser.timers.now += 260_000;
    answer(t, popup, m, true);
    expect((await reply).error).toMatchObject({ code: 4100, message: SPONSOR_TEXT.tooSlow, data: { reason: 'deadline_passed' } });
    expect(api.sends).toHaveLength(0);
  });
});

describe('the vault reads the account itself, from the build’s endpoints (D855, after the review of PR 76)', () => {
  it('a fresh account: both endpoints asked (chain, code, latest, pending), the authorization at their nonce', async () => {
    const { t, api } = await session();
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    expect(decodeSponsorSubject(m.bytes as Uint8Array).authNonce).toBe(3n);
    for (const endpoint of [RPC_A, RPC_B]) expect(api.chain.reads.filter((r) => r.endpoint === endpoint).map((r) => r.method).sort()).toEqual(['eth_chainId', 'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionCount']);
    answer(t, popup, m, true);
    expect((await reply).result).toMatchObject({ status: 'executed' });
  });

  it('a lying prepare says `none` for an account the chain shows set up with the pinned delegate: not ready, no window', async () => {
    const { t, api } = await session();
    api.chain.setUp();
    expect((await send(t)).error).toMatchObject({ code: 'api_unavailable', message: SPONSOR_TEXT.notReady, data: { reason: 'bad_answer' } });
    noWindow(t);
  });

  it('a lying prepare says `journear` for an account with no code: not ready (never a batch without its setup)', async () => {
    const { t, api } = await session();
    api.delegation = 'journear';
    expect((await send(t)).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'bad_answer' } });
    noWindow(t);
  });

  it.each([
    ['says `none`', 'none'],
    ['says `journear`', 'journear'],
  ] as const)('an account set up by another app while the API %s: the D840 refusal, no window, nothing signed', async (_n, delegation) => {
    const { t, api } = await session();
    api.delegation = delegation;
    api.chain.code = OTHER_DESIGNATOR;
    expect((await send(t)).error).toMatchObject({ code: 4100, message: SPONSOR_TEXT.delegatedElsewhere, data: { reason: 'delegated_elsewhere' } });
    noWindow(t);
    // Contract code is "elsewhere" too.
    api.chain.code = '0x6080604052';
    expect((await send(t)).error).toMatchObject({ code: 4100, data: { reason: 'delegated_elsewhere' } });
  });

  it.each([
    ['a future nonce from the API', (api: FakeSponsorApi) => (api.lieNonce = 9n)],
    ['a pending transaction (latest ≠ pending)', (api: FakeSponsorApi) => (api.chain.pending = 4n)],
  ])('%s: no authorization is signed (not ready)', async (_n, change) => {
    const { t, api } = await session();
    change(api);
    expect((await send(t)).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'bad_answer' } });
    noWindow(t);
  });

  it('one endpoint down: the other answers alone', async () => {
    const { t, api } = await session();
    api.chain.down.add(RPC_A);
    const reply = send(t);
    const { popup, m } = await windowOf(t);
    answer(t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
  });

  it('both endpoints down: not ready, never the API’s word', async () => {
    const { t, api } = await session();
    api.chain.down.add(RPC_A);
    api.chain.down.add(RPC_B);
    expect((await send(t)).error).toMatchObject({ code: 'api_unavailable', message: SPONSOR_TEXT.notReady, data: { reason: 'bad_answer' } });
    noWindow(t);
  });

  it.each([
    ['disagree on the code', (c: FakeEvmChain) => c.lies.set(RPC_B, { code: DESIGNATOR })],
    ['disagree on the nonce', (c: FakeEvmChain) => c.lies.set(RPC_B, { latest: 5n, pending: 5n })],
    ['one is on another chain', (c: FakeEvmChain) => c.lies.set(RPC_B, { chainId: 1 })],
    ['answer garbage', (c: FakeEvmChain) => c.lies.set(RPC_A, { code: 'nope' })],
  ])('the endpoints %s: unreadable, not ready', async (_n, lie) => {
    const { t, api } = await session();
    lie(api.chain);
    expect((await send(t)).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'bad_answer' } });
    noWindow(t);
  });

  it('a chain without an endpoint in the build is not sponsored', () => {
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': { delegate: DELEGATE, relayer: RELAYER } } })).toEqual([]);
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': { delegate: DELEGATE, relayer: RELAYER, rpc: 'ftp://x.test' } } })).toEqual([]);
    expect(sponsorChains({ name: 'sandbox-x', evmSponsor: { '84532': { delegate: DELEGATE, relayer: RELAYER, rpc: 'http://127.0.0.1:8545' } } })).toEqual([]);
    expect(sponsorChains({ name: 'local-x', evmSponsor: { '31337': { delegate: DELEGATE, relayer: RELAYER, rpc: 'http://127.0.0.1:8545' } } }).map((c) => c.rpcs)).toEqual([['http://127.0.0.1:8545']]);
  });
});

describe('the user-visible words follow the plain-wording rule', () => {
  it('no chain jargon in any refusal text', () => {
    for (const text of Object.values(SPONSOR_TEXT)) {
      expect(text).not.toMatch(/gas|nonce|relayer|delegat|contract|EIP|7702|signature|upgrade|smart account|Hana\b/iu);
      expect(text.length).toBeLessThan(130);
    }
  });
});
