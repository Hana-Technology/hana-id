// EVM gas sponsorship's routes (D847, D848; docs/api.md "EVM gas sponsorship") through the Worker, with the two ports
// faked (evm-sponsor-helpers.ts): a chain that records every read and a relayer binding that records every send. Every
// refusal code, the order (cheap checks never read the chain), the budgets and their settlement, concurrency, replays,
// the receipt rule, the audit row, the security events and the request log.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { checkEvmSponsorRelay, EVM_SPONSOR_PREPARE_ENDPOINT as PREPARE, EVM_SPONSOR_SEND_ENDPOINT as SEND, EVM_SPONSOR_STATUS_ENDPOINT as STATUS, sponsorPins, sponsorTiming } from '../src/evm/sponsor.ts';
import { DEFAULT_SPONSOR_PORTS, type Hex, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { EVM_SPONSOR_LIMITS } from '../src/evm/sponsor-checks.ts';
import { sponsorGasLimit } from '../src/evm/op-fee.ts';
import { encodeExecuteCalldata } from '@hana-id/core/evm-sponsor';
import { appHeaders, ORIGIN, seedApp, type SeededApp, startOfMinuteClock } from './helpers.ts';
import { vaultHeaders } from './vault-helpers.ts';
import { isEvmSponsorPrepareResponse, isEvmSponsorSendResponse, isEvmSponsorStatusResponse } from '../../../packages/core/src/api-types.ts';
import {
  CHECK_IN,
  CHECK_IN_DATA,
  DELEGATE,
  fakeChain,
  type FakeChain,
  fakeRelayer,
  LOCAL_CHAIN,
  OP_CHAIN,
  OP_DELEGATE,
  RELAYER,
  rememberAccount,
  revert as revertErr,
  type ReceiptKind,
  reads,
  signedSend,
  sponsorCall,
  sponsorEnv,
  sponsorVar,
  testUser,
  type TestUser,
  TOKEN,
  transferData,
  type ChainFields,
} from './evm-sponsor-helpers.ts';

/** The address with its first letter's case flipped: no longer EIP-55 (nor all one case). */
const flipCase = (a: string): string => {
  const i = [...a.slice(2)].findIndex((c) => /[a-fA-F]/u.test(c)) + 2;
  const c = a[i]!;
  return `${a.slice(0, i)}${c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()}${a.slice(i + 1)}`;
};
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const DESIGNATOR = `0xef0100${DELEGATE.slice(2).toLowerCase()}` as Hex;

interface Setup {
  app: SeededApp;
  chain: FakeChain;
  relayer: ReturnType<typeof fakeRelayer>;
  user: TestUser;
  userId: string;
  bindings: Partial<typeof env>;
}

let receiptKind: ReceiptKind = 'executed';

async function setup(fields: ChainFields = {}, o: { chainId?: number; delegated?: boolean; known?: boolean; extraApps?: string[] } = {}): Promise<Setup> {
  const app = await seedApp();
  const chain = fakeChain();
  const relayer = fakeRelayer(chain, () => receiptKind);
  const user = testUser();
  const userId = o.known === false ? '' : await rememberAccount(app.scope, user.address);
  if (o.delegated !== false) chain.codes.set(user.address.toLowerCase(), o.chainId === OP_CHAIN ? (`0xef0100${OP_DELEGATE.slice(2).toLowerCase()}` as Hex) : DESIGNATOR);
  sponsorPorts.chain = () => chain;
  // Most tests send many batches in one real minute: the env's minute and day are wide unless a test narrows them.
  const bindings = sponsorEnv(sponsorVar([app.id, ...(o.extraApps ?? [])], o.chainId ?? LOCAL_CHAIN, { sendsPerMinute: 100_000, ...fields }), relayer);
  return { app, chain, relayer, user, userId, bindings };
}

const send = (s: Pick<Setup, 'app' | 'bindings'>, b: unknown, headers?: Record<string, string>) => sponsorCall(SEND, s.app, s.bindings, { body: b, headers });
const prepare = (s: Pick<Setup, 'app' | 'bindings'>, b: unknown, headers?: Record<string, string>) => sponsorCall(PREPARE, s.app, s.bindings, { body: b, headers });
const status = (s: Pick<Setup, 'app' | 'bindings'>, query: string, headers?: Record<string, string>) => sponsorCall(`${STATUS}${query}`, s.app, s.bindings, { method: 'GET', headers });

/** The app's day budget spend (the RateLimiter's own figure). */
const appSpent = async (app: SeededApp, chainId = LOCAL_CHAIN) => BigInt(await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`app:${app.id}`)).spent(`evm-sponsor:${chainId}:wei`, 86_400_000));
const envSpent = async (chainId = LOCAL_CHAIN) => BigInt(await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`evm-sponsor:budget:${chainId}`)).spent(`evm-sponsor:${chainId}:wei`, 86_400_000));
const auditRows = async (account: Hex) =>
  (await env.DB.prepare('SELECT status, tx_hash, reserved_wei, settled_wei, user_id, relayer_nonce, app_id FROM evm_sponsor_sends WHERE account = ?1 ORDER BY created_at').bind(account).all<Record<string, unknown>>()).results;

beforeEach(startOfMinuteClock);
// Durable Object storage lasts the whole file: the env's shared objects (per chain) and the events start empty per test.
beforeEach(async () => {
  for (const chainId of [LOCAL_CHAIN, OP_CHAIN]) {
    for (const name of [`evm-sponsor:global:${chainId}`, `evm-sponsor:budget:${chainId}`]) {
      await runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name)), async (_i, state) => state.storage.deleteAll());
    }
  }
  await env.DB.exec("DELETE FROM security_events WHERE kind LIKE 'evm_relay_%'");
});
beforeEach(() => {
  receiptKind = 'executed';
  sponsorTiming.receiptWaitMs = 400;
  sponsorTiming.receiptPollMs = 50;
});
afterEach(() => {
  vi.restoreAllMocks();
  sponsorPorts.chain = DEFAULT_SPONSOR_PORTS.chain;
  sponsorPorts.relayer = DEFAULT_SPONSOR_PORTS.relayer;
  sponsorPins.table = SPONSOR_DELEGATES;
  sponsorTiming.receiptWaitMs = 30_000;
  sponsorTiming.receiptPollMs = 1_500;
});

// ---------------------------------------------------------------------------------------------------------------

describe('fail closed: 503 sponsorship_unconfigured', () => {
  it('without EVM_SPONSOR (every env today), without the relayer binding, without the key secret, with a var the Worker refuses, off testnet', async () => {
    const s = await setup();
    const { body: b } = signedSend(s.user);
    const variants: Partial<typeof env>[] = [
      { ...s.bindings, EVM_SPONSOR: undefined },
      { ...s.bindings, EVM_RELAYER: undefined } as Partial<typeof env>,
      { ...s.bindings, EVM_RELAY_KEYS: undefined },
      // 31337 is a local chain: refused outside local* envs, so the whole block is.
      { ...s.bindings, ENV_NAME: 'sandbox-test' },
      { ...s.bindings, EVM_SPONSOR: '{"relayerAddress":' },
      { ...s.bindings, NETWORK: 'mainnet' },
    ];
    for (const v of variants) {
      for (const [path, method, payload] of [[SEND, 'POST', b], [PREPARE, 'POST', { chainId: LOCAL_CHAIN, account: s.user.address, calls: b.calls }], [`${STATUS}?chainId=31337`, 'GET', undefined]] as const) {
        const res = await sponsorCall(path, s.app, v, { body: payload, method });
        expect([res.status, (await body(res)).code], `${path} ${JSON.stringify(Object.keys(v).filter((k) => v[k as keyof typeof v] === undefined))}`).toEqual([503, 'sponsorship_unconfigured']);
      }
    }
    expect(s.chain.calls).toEqual([]);
    expect(s.relayer.sends).toEqual([]);
  });

  it('the routes take POST (prepare, send) and GET (status) only; OPTIONS is the app preflight', async () => {
    const s = await setup();
    expect((await sponsorCall(SEND, s.app, s.bindings, { method: 'GET' })).status).toBe(405);
    expect((await sponsorCall(STATUS, s.app, s.bindings, { method: 'POST', body: {} })).status).toBe(405);
    const pre = await sponsorCall(SEND, s.app, s.bindings, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(pre.status).toBe(204);
  });
});

describe('the gate: the vault only for prepare and send (D832)', () => {
  it('a partner page gets 403 origin_not_allowed for prepare and send, and may read the status', async () => {
    const s = await setup();
    const { body: b } = signedSend(s.user);
    expect((await body(await send(s, b, appHeaders(s.app)))).code).toBe('origin_not_allowed');
    expect((await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: b.calls }, appHeaders(s.app)))).code).toBe('origin_not_allowed');
    const st = await status(s, '?chainId=31337', appHeaders(s.app));
    expect([st.status, st.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    // The vault for a parent origin the app doesn't have: refused too.
    expect((await body(await send(s, b, { 'x-hana-key': s.app.key, origin: 'https://vault.test', 'x-hana-parent-origin': 'https://evil.example' }))).code).toBe('origin_not_allowed');
    expect(s.chain.calls).toEqual([]);
  });

  it('a cross-app per-IP window: 30 a minute from one IP across the three routes, then 429', async () => {
    const s = await setup();
    const headers = { ...vaultHeaders(s.app), 'cf-connecting-ip': '10.9.9.9' };
    const codes: number[] = [];
    for (let i = 0; i < EVM_SPONSOR_LIMITS.perIpPerMinute + 1; i++) codes.push((await status(s, '?chainId=31337', headers)).status);
    expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('POST /v1/evm/sponsor/send: refusals before any chain read', () => {
  const dummySig = `0x${'11'.repeat(64)}1b`;
  const cases: [string, (s: Setup) => unknown, number, string, Record<string, unknown>?][] = [
    ['an unknown field', (s) => ({ ...signedSend(s.user).body, extra: 1 }), 400, 'bad_request'],
    ['a value that is not a decimal string', (s) => ({ ...signedSend(s.user).body, calls: [{ to: CHECK_IN, value: 0, data: CHECK_IN_DATA }] }), 400, 'bad_request'],
    ['a mis-checksummed address', (s) => ({ ...signedSend(s.user).body, account: flipCase(s.user.address) }), 400, 'bad_request'],
    ['no calls', (s) => ({ ...signedSend(s.user).body, calls: [] }), 400, 'bad_request'],
    ['a short signature', (s) => ({ ...signedSend(s.user).body, signature: '0x1234' }), 400, 'bad_request'],
    ['a malformed authorization', (s) => ({ ...signedSend(s.user).body, authorization: { chainId: LOCAL_CHAIN } }), 400, 'bad_request'],
    ['a chain sponsorship is not on', (s) => ({ ...signedSend(s.user).body, chainId: 1 }), 400, 'chain_not_enabled'],
    ['more calls than maxCallsPerBatch', (s) => signedSend(s.user, { calls: Array.from({ length: 5 }, () => ({ to: CHECK_IN, data: CHECK_IN_DATA })) }).body, 400, 'too_many_calls', { maxCalls: 4 }],
    ['a call with value', (s) => ({ ...signedSend(s.user).body, calls: [{ to: CHECK_IN, value: '1', data: CHECK_IN_DATA }] }), 403, 'value_not_allowed', { callIndex: 0 }],
    ['a call to the account itself', (s) => ({ ...signedSend(s.user).body, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }, { to: s.user.address, value: '0', data: '0x627cdcb9' }], signature: dummySig }), 403, 'target_not_allowed', { callIndex: 1 }],
    ['a call to the delegate', (s) => ({ ...signedSend(s.user).body, calls: [{ to: DELEGATE, value: '0', data: '0x627cdcb9' }], signature: dummySig }), 403, 'target_not_allowed', { callIndex: 0 }],
    ['a call to the relayer', (s) => ({ ...signedSend(s.user).body, calls: [{ to: RELAYER, value: '0', data: '0x00000000' }] }), 403, 'target_not_allowed', { callIndex: 0 }],
    ['a call to the zero address', (s) => ({ ...signedSend(s.user).body, calls: [{ to: `0x${'0'.repeat(40)}`, value: '0', data: '0x00000000' }] }), 403, 'target_not_allowed', { callIndex: 0 }],
    ['a contract not on the allowlist', (s) => ({ ...signedSend(s.user).body, calls: [{ to: `0x${'ab'.repeat(20)}`, value: '0', data: CHECK_IN_DATA }] }), 403, 'call_not_sponsored', { callIndex: 0 }],
    ['a selector not on the allowlist', (s) => ({ ...signedSend(s.user).body, calls: [{ to: TOKEN, value: '0', data: '0x095ea7b3' }] }), 403, 'call_not_sponsored', { callIndex: 0 }],
    ['trailing bytes on exact calldata (the sponsor would pay for them)', (s) => ({ ...signedSend(s.user).body, calls: [{ to: CHECK_IN, value: '0', data: `${CHECK_IN_DATA}00` }] }), 403, 'call_not_sponsored', { callIndex: 0 }],
    ['data over the target’s maxDataBytes', (s) => ({ ...signedSend(s.user).body, calls: [{ to: TOKEN, value: '0', data: `${transferData(RELAYER, 1n)}00` }] }), 403, 'call_not_sponsored', { callIndex: 0 }],
    ['another relayer', (s) => signedSend(s.user, { relayer: testUser('other relayer').address }).body, 400, 'wrong_relayer'],
    ['minGas below the floor', (s) => signedSend(s.user, { minGas: 99_999n }).body, 400, 'min_gas_out_of_range', { minGasFloor: '100000', maxGas: '300000' }],
    ['minGas above maxGasPerTx', (s) => signedSend(s.user, { minGas: 300_001n }).body, 400, 'min_gas_out_of_range'],
    ['a deadline under 30 s away', (s) => signedSend(s.user, { deadline: BigInt(Math.floor(Date.now() / 1000) + 29) }).body, 400, 'deadline_out_of_range', { deadlineMaxS: 600 }],
    ['a deadline past deadlineMaxS', (s) => signedSend(s.user, { deadline: BigInt(Math.floor(Date.now() / 1000) + 700) }).body, 400, 'deadline_out_of_range'],
    ['a batch signed by another key', (s) => signedSend(s.user, { signWith: testUser('mallory').key }).body, 401, 'invalid_signature'],
    ['a signature over another implementation (the request can’t pick the delegate)', (s) => signedSend(s.user, { delegate: OP_DELEGATE }).body, 401, 'invalid_signature'],
    ['a tampered batch', (s) => ({ ...signedSend(s.user).body, minGas: '100001' }), 401, 'invalid_signature'],
    ['a high-s signature', (s) => {
      const b = signedSend(s.user).body;
      const sig = b.signature as string;
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const high = (n - BigInt(`0x${sig.slice(66, 130)}`)).toString(16).padStart(64, '0');
      return { ...b, signature: `${sig.slice(0, 66)}${high}${sig.slice(130) === '1b' ? '1c' : '1b'}` };
    }, 401, 'invalid_signature'],
    ['an authorization for chain 0', (s) => signedSend(s.user, { authNonce: 0n, authChainId: 0 }).body, 400, 'bad_authorization'],
    ['an authorization for another chain', (s) => signedSend(s.user, { authNonce: 0n, authChainId: 1 }).body, 400, 'bad_authorization'],
    ['an authorization to another contract', (s) => signedSend(s.user, { authNonce: 0n, authAddress: OP_DELEGATE }).body, 403, 'authorization_not_pinned'],
    ['an authorization signed by another key', (s) => signedSend(s.user, { authNonce: 0n, authWith: testUser('mallory').key }).body, 401, 'invalid_authorization_signature'],
  ];
  for (const [what, make, statusCode, code, fields] of cases) {
    it(`${what}: ${statusCode} ${code}`, async () => {
      const s = await setup();
      const res = await send(s, make(s));
      const b = await body(res);
      expect([res.status, b.code]).toEqual([statusCode, code]);
      if (fields) expect(b).toMatchObject(fields);
      expect(typeof b.requestId).toBe('string');
      expect(s.chain.calls).toEqual([]);
      expect(s.relayer.sends).toEqual([]);
      expect(await appSpent(s.app)).toBe(0n);
    });
  }

  it('an app with no targets on the chain: 403 app_not_sponsored', async () => {
    const s = await setup();
    const other = await seedApp();
    const res = await send({ app: other, bindings: s.bindings }, signedSend(s.user).body);
    expect([res.status, (await body(res)).code]).toEqual([403, 'app_not_sponsored']);
    expect(s.chain.calls).toEqual([]);
  });

  it('an account the directory does not hold for this app’s scope: 409 account_unrecorded (retryable), also when another scope holds it', async () => {
    const s = await setup({}, { known: false });
    const elsewhere = await seedApp();
    await rememberAccount(elsewhere.scope, s.user.address);
    const res = await send(s, signedSend(s.user).body);
    const b = await body(res);
    expect([res.status, b.code, b.retryable, res.headers.get('retry-after')]).toEqual([409, 'account_unrecorded', true, '2']);
    expect(s.chain.calls).toEqual([]);
  });

  it('with requireKnownAccount false (testnet only) an unrecorded account is served, limited per account', async () => {
    const s = await setup({ requireKnownAccount: false }, { known: false });
    const res = await send(s, signedSend(s.user).body);
    expect(res.status).toBe(200);
    expect((await auditRows(s.user.address))[0]?.user_id).toBeNull();
  });
});

describe('POST /v1/evm/sponsor/send: a delegated account', () => {
  it('executes: the relayer gets the exact batch at the computed gas and fees, the budget settles to the receipt, the floor rises, the audit row says executed', async () => {
    const s = await setup();
    const signed = signedSend(s.user);
    const res = await send(s, signed.body);
    const b = await body(res);
    expect([res.status, b.status, typeof b.transactionHash]).toEqual([200, 'executed', 'string']);
    expect(Object.keys(b).sort()).toEqual(['requestId', 'status', 'transactionHash']);
    expect(isEvmSponsorSendResponse(b)).toBe(true);
    const req = s.relayer.sends[0]!;
    const calldata = encodeExecuteCalldata(signed.input, signed.body.signature as Hex);
    const gas = sponsorGasLimit({ calldata, callData: [CHECK_IN_DATA], minGas: 100_000n, authorizations: 0 });
    // base fee 0.1 gwei: 2 × 0.1 + 0.01 tip = 0.21 gwei, under the 1 gwei cap.
    expect(req).toEqual({ digest: signed.digest, chainId: LOCAL_CHAIN, to: s.user.address, data: calldata, gas, maxFeePerGas: 210_000_000n, maxPriorityFeePerGas: 10_000_000n, deadline: BigInt(signed.body.deadline as string), reservedWei: gas * 210_000_000n });
    expect(s.relayer.names).toContain('evm-relayer-31337-0');
    // The simulation: from the relayer, to the account, the exact calldata, at exactly the gas limit, no override.
    const sim = s.chain.calls.find((c) => c.method === 'call' && (c.args as { data: string }).data === calldata)!.args;
    expect(sim).toEqual({ from: RELAYER, to: s.user.address, data: calldata, gas });
    // Settled to gasUsed × price (60 000 × 0.15 gwei), on the app's budget and the env's.
    expect([await appSpent(s.app), await envSpent()]).toEqual([9_000_000_000_000n, 9_000_000_000_000n]);
    expect(await auditRows(s.user.address)).toEqual([{ status: 'executed', tx_hash: b.transactionHash, reserved_wei: (gas * 210_000_000n).toString(), settled_wei: '9000000000000', user_id: s.userId, relayer_nonce: 0, app_id: s.app.id }]);
    // The same request again: answered from the audit row (idempotent), no chain read, no second send.
    s.chain.calls.length = 0;
    const again = await send(s, signed.body);
    const a = await body(again);
    expect([again.status, a.status, a.transactionHash, a.replay]).toEqual([200, 'executed', b.transactionHash, true]);
    expect(s.chain.calls).toEqual([]);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('drops an authorization the account no longer needs (already delegated to the pinned delegate)', async () => {
    const s = await setup();
    const res = await send(s, signedSend(s.user, { authNonce: 0n }).body);
    expect(res.status).toBe(200);
    expect(s.relayer.sends[0]!.authorization).toBeUndefined();
  });

  it('409 delegated_elsewhere for an account delegated to another contract or with contract code (D840), 409 delegation_required without code or authorization', async () => {
    const s = await setup();
    s.chain.codes.set(s.user.address.toLowerCase(), `0xef0100${'12'.repeat(20)}` as Hex);
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('delegated_elsewhere');
    s.chain.codes.set(s.user.address.toLowerCase(), '0x6080604052' as Hex);
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('delegated_elsewhere');
    s.chain.codes.delete(s.user.address.toLowerCase());
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('delegation_required');
    expect(s.relayer.sends).toEqual([]);
  });

  it('a nonce the chain has used: 409 nonce_stale, the floor rises, and the next copy is dropped before any chain read', async () => {
    const s = await setup();
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 3n);
    const old = signedSend(s.user, { executeNonce: 1n });
    const res = await send(s, old.body);
    expect([res.status, (await body(res)).code, (await body(await send(s, old.body))).executeNonce]).toEqual([409, 'nonce_stale', '3']);
    s.chain.calls.length = 0;
    const r2 = await send(s, signedSend(s.user, { executeNonce: 2n }).body);
    expect([r2.status, (await body(r2)).code]).toEqual([409, 'nonce_stale']);
    expect(s.chain.calls).toEqual([]);
    // A future nonce is stale too, without moving the floor.
    const r3 = await send(s, signedSend(s.user, { executeNonce: 9n }).body);
    expect([(await body(r3)).code]).toEqual(['nonce_stale']);
    expect((await send(s, signedSend(s.user, { executeNonce: 3n }).body)).status).toBe(200);
  });

  it('403 gas_too_high when the computed limit passes maxGasPerTx; 503 gas_price_too_high when the base fee passes the cap', async () => {
    const s = await setup();
    const res = await send(s, signedSend(s.user, { minGas: 290_000n }).body);
    expect([res.status, (await body(res)).code]).toEqual([403, 'gas_too_high']);
    s.chain.baseFeeWei = 1_000_000_001n;
    const r2 = await send(s, signedSend(s.user).body);
    const b2 = await body(r2);
    expect([r2.status, b2.code, b2.retryAfterS]).toEqual([503, 'gas_price_too_high', 30]);
    expect(s.relayer.sends).toEqual([]);
    expect(await appSpent(s.app)).toBe(0n);
  });

  it('caps maxFeePerGas at the manifest’s cap (2 × base + tip above it)', async () => {
    const s = await setup();
    s.chain.baseFeeWei = 900_000_000n;
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    expect(s.relayer.sends[0]!.maxFeePerGas).toBe(1_000_000_000n);
  });

  it('502 evm_rpc_unavailable when the chain can’t be read; the RPC’s error text is never echoed', async () => {
    const s = await setup();
    s.chain.down = true;
    const res = await send(s, signedSend(s.user).body);
    const b = await body(res);
    expect([res.status, b.code, b.error]).toEqual([502, 'evm_rpc_unavailable', 'Could not read the chain, try again']);
    expect(s.relayer.sends).toEqual([]);
  });

  it('the minute windows are counted before the chain reads: the account’s 6, then 429 with retryAfterS', async () => {
    const s = await setup();
    s.chain.down = true;
    const codes: (string | number)[] = [];
    for (let i = 0; i < EVM_SPONSOR_LIMITS.sendsPerAccountPerMinute + 1; i++) codes.push((await body(await send(s, signedSend(s.user, { minGas: 100_000n + BigInt(i) }).body))).code as string);
    expect(codes.slice(0, -1).every((c) => c === 'evm_rpc_unavailable')).toBe(true);
    const last = await send(s, signedSend(s.user, { minGas: 100_100n }).body);
    const b = await body(last);
    expect([last.status, b.code, typeof b.retryAfterS, Number(last.headers.get('retry-after')) > 0]).toEqual([429, 'rate_limited', 'number', true]);
  });

  it('the env’s minute and day windows (sendsPerMinute, sendsPerDay), the app’s day (perAppPerDay) and the user’s (perUserPerDay)', async () => {
    const s = await setup({ sendsPerMinute: 1 });
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    expect((await body(await send(s, signedSend(u2).body))).code).toBe('rate_limited');
    const d = await setup({ perUserPerDay: 1, perAppPerDay: 2, sendsPerDay: 3 });
    expect((await send(d, signedSend(d.user).body)).status).toBe(200);
    d.chain.executeNonce.set(d.user.address.toLowerCase(), 1n);
    const second = await body(await send(d, signedSend(d.user, { executeNonce: 1n }).body));
    expect([second.code, second.error]).toEqual(['rate_limited', 'Rate limit exceeded (per user)']);
  });
});

describe('POST /v1/evm/sponsor/send: an account not yet delegated (the one-time setup)', () => {
  it('attaches the authorization: the simulation runs the account as the delegate (state override), the gas has 25 000 more', async () => {
    const s = await setup({}, { delegated: false });
    s.chain.pending.set(s.user.address.toLowerCase(), 7n);
    const signed = signedSend(s.user, { authNonce: 7n });
    const res = await send(s, signed.body);
    expect(res.status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(req.authorization).toMatchObject({ chainId: LOCAL_CHAIN, address: DELEGATE, nonce: 7n });
    const calldata = encodeExecuteCalldata(signed.input, signed.body.signature as Hex);
    expect(req.gas).toBe(sponsorGasLimit({ calldata, callData: [CHECK_IN_DATA], minGas: 100_000n, authorizations: 1 }));
    expect(req.gas - sponsorGasLimit({ calldata, callData: [CHECK_IN_DATA], minGas: 100_000n, authorizations: 0 })).toBe(27_500n);
    const sim = s.chain.calls.find((c) => c.method === 'call' && (c.args as { data: string }).data === calldata)!.args as { stateOverride: Record<string, unknown> };
    expect(sim.stateOverride).toEqual({ [s.user.address]: { code: DESIGNATOR } });
    // The delegate nonce of an account without code is read through the same override.
    const nonceRead = s.chain.calls.find((c) => c.method === 'call' && (c.args as { data: string }).data === '0xaffed0e0')!.args as { stateOverride: Record<string, unknown> };
    expect(nonceRead.stateOverride).toEqual({ [s.user.address]: { code: DESIGNATOR } });
  });

  it('409 authorization_nonce_stale when the authorization’s nonce is not the account’s pending nonce', async () => {
    const s = await setup({}, { delegated: false });
    s.chain.pending.set(s.user.address.toLowerCase(), 2n);
    const res = await send(s, signedSend(s.user, { authNonce: 1n }).body);
    const b = await body(res);
    expect([res.status, b.code, b.accountNonce]).toEqual([409, 'authorization_nonce_stale', '2']);
    expect(s.relayer.sends).toEqual([]);
  });

  it('a stale authorization the network skipped: the transaction runs nothing, 422 not_executed with its hash, charged, a failure', async () => {
    const s = await setup({}, { delegated: false });
    receiptKind = 'not_executed';
    const res = await send(s, signedSend(s.user, { authNonce: 0n }).body);
    const b = await body(res);
    expect([res.status, b.code, typeof b.transactionHash]).toEqual([422, 'not_executed', 'string']);
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'not_executed', settled_wei: '9000000000000' });
  });
});

describe('POST /v1/evm/sponsor/send: simulation, receipts and settlement', () => {
  it('a simulation revert: 422 simulation_reverted with the call index and bounded revert data, nothing sent, nothing spent, a failure counted', async () => {
    const s = await setup();
    const reason = `0x08c379a0${'00'.repeat(32)}`;
    const revert = `0x5c0dee5d${(0n).toString(16).padStart(64, '0')}${(0x40n).toString(16).padStart(64, '0')}${((reason.length - 2) / 2).toString(16).padStart(64, '0')}${reason.slice(2).padEnd(Math.ceil((reason.length - 2) / 64) * 64, '0')}`;
    s.chain.simulate = () => {
      throw revertErr(revert as Hex);
    };
    const res = await send(s, signedSend(s.user).body);
    const b = await body(res);
    expect([res.status, b.code, b.callIndex, b.revertData]).toEqual([422, 'simulation_reverted', 0, revert]);
    expect(s.relayer.sends).toEqual([]);
    expect(await appSpent(s.app)).toBe(0n);
    // Over 2 KiB: left out, never truncated. An index past the batch: no callIndex.
    s.chain.simulate = () => {
      throw revertErr(`0x${'ab'.repeat(2049)}` as Hex);
    };
    const big = await body(await send(s, signedSend(s.user, { minGas: 100_001n }).body));
    expect([big.code, 'revertData' in big, 'callIndex' in big]).toEqual(['simulation_reverted', false, false]);
    s.chain.simulate = () => {
      throw revertErr(`0x5c0dee5d${(5n).toString(16).padStart(64, '0')}${'00'.repeat(64)}` as Hex);
    };
    const far = await body(await send(s, signedSend(s.user, { minGas: 100_002n }).body));
    expect([far.code, 'callIndex' in far]).toEqual(['simulation_reverted', false]);
    // That was the third failure today: the fourth try is refused before the simulation.
    s.chain.simulate = () => '0x';
    const fourth = await send(s, signedSend(s.user, { minGas: 100_003n }).body);
    expect([fourth.status, (await body(fourth)).code]).toEqual([429, 'too_many_failures']);
    expect(s.relayer.sends).toEqual([]);
  });

  it('a revert on chain: 422 reverted with the hash, charged from the receipt; three failures and the user is refused for the day', async () => {
    const s = await setup();
    receiptKind = 'reverted';
    for (let i = 0; i < 3; i++) {
      const r = await send(s, signedSend(s.user, { minGas: 100_000n + BigInt(i) }).body);
      expect([r.status, (await body(r)).code]).toEqual([422, 'reverted']);
    }
    expect(await appSpent(s.app)).toBe(3n * 9_000_000_000_000n);
    const r = await send(s, signedSend(s.user, { minGas: 100_010n }).body);
    expect((await body(r)).code).toBe('too_many_failures');
    expect(s.relayer.sends.length).toBe(3);
  });

  it('a receipt without the Executed log from the account (a log from another address) is not_executed', async () => {
    const s = await setup();
    receiptKind = 'wrong_log';
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('not_executed');
  });

  it('no receipt within the wait: 504 timeout with the hash; the reservation stays; a copy is answered from the audit row with no chain read', async () => {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    const res = await send(s, signed.body);
    const b = await body(res);
    expect([res.status, b.code, typeof b.transactionHash]).toEqual([504, 'timeout', 'string']);
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
    s.chain.calls.length = 0;
    const again = await send(s, signed.body);
    expect([again.status, (await body(again)).transactionHash]).toEqual([504, b.transactionHash]);
    expect(s.chain.calls).toEqual([]);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('the relayer fails without a code: 503 relayer_unavailable, the reservation stays (it may have broadcast), the same batch may be sent again', async () => {
    const s = await setup();
    const inner = s.relayer.onSend;
    let fail = true;
    s.relayer.onSend = async (req) => {
      if (fail) throw new Error('the object was reset');
      return { ...(await inner(req)), replay: true };
    };
    const signed = signedSend(s.user);
    const res = await send(s, signed.body);
    expect([res.status, (await body(res)).code]).toEqual([503, 'relayer_unavailable']);
    expect((await auditRows(s.user.address))[0]?.status).toBe('unknown');
    const first = s.relayer.sends[0]!.reservedWei;
    expect(await appSpent(s.app)).toBe(first);
    // The retry reaches the relayer (idempotent per digest): its first transaction, replay, this copy's reservation back.
    fail = false;
    const again = await send(s, signed.body);
    expect(again.status).toBe(200);
    expect(s.relayer.sends.map((x) => x.digest)).toEqual([signed.digest, signed.digest]);
    expect(await appSpent(s.app)).toBe(first);
  });

  it('a coded relayer refusal sent nothing: everything comes back, the row says refused, the code is answered', async () => {
    const cases: [string, number, string][] = [
      ['evm_relayer:relayer_busy', 503, 'relayer_busy'],
      ['evm_relayer:relayer_misconfigured', 503, 'sponsorship_unconfigured'],
      ['evm_relayer:rpc_unavailable', 502, 'evm_rpc_unavailable'],
      ['evm_relayer:rejected:insufficient_funds', 503, 'relayer_rejected'],
      ['evm_relayer:deadline_passed', 400, 'deadline_out_of_range'],
      ['evm_relayer:invalid_request', 503, 'relayer_unavailable'],
    ];
    for (const [message, statusCode, code] of cases) {
      const s = await setup();
      s.relayer.onSend = async () => {
        throw new Error(message);
      };
      const signed = signedSend(s.user);
      const res = await send(s, signed.body);
      expect([res.status, (await body(res)).code], message).toEqual([statusCode, code]);
      expect(await appSpent(s.app), message).toBe(0n);
      expect((await auditRows(s.user.address))[0]?.status).toBe('refused');
      // Nothing was sent: the same batch goes through once the relayer takes it.
      s.relayer.onSend = fakeRelayer(s.chain).onSend;
      expect((await send(s, signed.body)).status, message).toBe(200);
    }
  });

  it('polls every hash the relayer lists for the digest: a replacement’s receipt settles it, charging what it cost', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => {
      const { rawFor, receiptFor } = await import('./evm-sponsor-helpers.ts');
      const { keccakHex } = await import('../src/evm/sponsor-ports.ts');
      const raw = rawFor(req);
      const bumped = keccakHex(rawFor(req, 'bumped'));
      s.relayer.replaced.set(req.digest, [bumped]);
      // Only the replacement is mined, dearer than the reservation.
      s.chain.receipts.set(bumped, receiptFor(req, bumped, 'executed', { gasUsed: req.gas, price: req.maxFeePerGas * 2n }));
      return { transactionHash: keccakHex(raw), relayerNonce: 0, raw, replay: false };
    };
    const res = await send(s, signedSend(s.user).body);
    expect(res.status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(await appSpent(s.app)).toBe(req.gas * req.maxFeePerGas * 2n);
    expect(s.relayer.lookups).toContain(req.digest);
  });

  it('a relayer replay whose latest version is the deadline cancel (no Executed log): 422 not_executed', async () => {
    const s = await setup();
    const inner = fakeRelayer(s.chain, () => 'not_executed').onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), replay: true });
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('not_executed');
  });

  it('a relayer answer whose hash is not its raw transaction’s is not trusted', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => ({ transactionHash: `0x${'ab'.repeat(32)}`, relayerNonce: 0, raw: `0x02${req.digest.slice(2)}`, replay: false });
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('relayer_unavailable');
  });

  it('a relayer replay (it had sent this digest): no second charge, the first send’s hash', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => {
      const { rawFor } = await import('./evm-sponsor-helpers.ts');
      const { keccakHex } = await import('../src/evm/sponsor-ports.ts');
      const raw = rawFor(req);
      const hash = keccakHex(raw);
      s.chain.receipts.set(hash, (await import('./evm-sponsor-helpers.ts')).receiptFor(req, hash, 'executed'));
      return { transactionHash: hash, relayerNonce: 4, raw, replay: true };
    };
    const res = await send(s, signedSend(s.user).body);
    expect(res.status).toBe(200);
    expect(await appSpent(s.app)).toBe(0n);
  });

  it('a spend above the reservation is charged (a receipt dearer than the worst case)', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => {
      const { rawFor, receiptFor } = await import('./evm-sponsor-helpers.ts');
      const { keccakHex } = await import('../src/evm/sponsor-ports.ts');
      const raw = rawFor(req);
      const hash = keccakHex(raw);
      s.chain.receipts.set(hash, receiptFor(req, hash, 'executed', { gasUsed: req.gas, price: req.maxFeePerGas + 1n }));
      return { transactionHash: hash, relayerNonce: 0, raw, replay: false };
    };
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(await appSpent(s.app)).toBe(req.gas * (req.maxFeePerGas + 1n));
  });
});

describe('budgets: the worst case reserved atomically before sending', () => {
  it('the app’s day budget: 429 app_budget_exhausted with retryAfterS, nothing sent; another app still has the env’s', async () => {
    // 0.0003 ETH a day for the app: one worst case at a 1 gwei fee (about 190 000 gas) fits, a second doesn't.
    const s = await setup({ appDailyBudgetEth: 0.0003, dailyBudgetEth: 0.02 });
    s.chain.baseFeeWei = 600_000_000n;
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    const r = await send(s, signedSend(u2).body);
    const b = await body(r);
    expect([r.status, b.code, typeof b.retryAfterS]).toEqual([429, 'app_budget_exhausted', 'number']);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('concurrent sends against one budget: exactly as many as fit are sent, the rest refused, never more than the budget', async () => {
    const s = await setup({ appDailyBudgetEth: 0.0003, dailyBudgetEth: 0.02 });
    s.chain.baseFeeWei = 600_000_000n;
    // The relayer holds every send until all requests have reserved (or been refused).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => {
      await gate;
      return inner(req);
    };
    const users = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const u = testUser();
        await rememberAccount(s.app.scope, u.address);
        s.chain.codes.set(u.address.toLowerCase(), DESIGNATOR);
        return u;
      }),
    );
    // Released once the four that can't fit have been refused (a fallback after 20 s, which fails the count).
    let refused = 0;
    const pending = users.map((u) =>
      send(s, signedSend(u).body).then((r) => {
        if (r.status !== 200 && ++refused === 4) release();
        return r;
      }),
    );
    setTimeout(release, 20_000);
    const results = await Promise.all(pending.map(async (p) => (await p).status));
    expect(results.filter((c) => c === 200).length).toBe(1);
    expect(results.filter((c) => c === 429).length).toBe(4);
    expect(await appSpent(s.app)).toBeLessThanOrEqual(3n * 10n ** 14n);
  });

  it('concurrent copies of one batch: one send, the others in_progress', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => {
      await gate;
      return inner(req);
    };
    const signed = signedSend(s.user);
    let refused = 0;
    const pending = Array.from({ length: 4 }, () =>
      send(s, signed.body).then((r) => {
        if (r.status !== 200 && ++refused === 3) release();
        return r;
      }),
    );
    setTimeout(release, 20_000);
    const codes = await Promise.all(pending.map(async (p) => {
      const r = await p;
      return r.status === 200 ? 200 : (await body(r)).code;
    }));
    expect(codes.filter((c) => c === 200).length).toBe(1);
    expect(codes.filter((c) => c === 'in_progress').length).toBe(3);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('the env’s day budget: 429 budget_exhausted for every app past it, and one evm_relay_budget_high event a day', async () => {
    // One worst case at minGas 200 000 and a 1 gwei fee is about 292 000 gas: 94% of the env's 0.00031 ETH.
    const s = await setup();
    s.chain.baseFeeWei = 600_000_000n;
    receiptKind = 'none';
    const other = await seedApp();
    const bindings = sponsorEnv(sponsorVar([s.app.id, other.id], LOCAL_CHAIN, { sendsPerMinute: 100_000, appDailyBudgetEth: 0.0003, dailyBudgetEth: 0.00031 }), s.relayer);
    expect((await send({ app: s.app, bindings }, signedSend(s.user, { minGas: 200_000n }).body)).status).toBe(504);
    const u2 = testUser();
    await rememberAccount(other.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    const r = await send({ app: other, bindings }, signedSend(u2, { minGas: 200_000n }).body);
    expect([r.status, (await body(r)).code]).toEqual([429, 'budget_exhausted']);
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_budget_high'").all<{ detail_json: string }>();
    expect(ev.results.length).toBe(1);
    expect(Object.keys(JSON.parse(ev.results[0]!.detail_json)).sort()).toEqual(['budgetWei', 'chainId', 'day', 'spentWei', 'thresholdPct']);
  });
});

describe('the OP Stack L1 data fee (D836 addendum)', () => {
  async function opSetup(fields: ChainFields = {}): Promise<Setup> {
    sponsorPins.table = { ...SPONSOR_DELEGATES, [OP_CHAIN]: { address: OP_DELEGATE } };
    const s = await setup(fields, { chainId: OP_CHAIN });
    s.bindings = { ...s.bindings, ENV_NAME: 'sandbox-test' };
    return s;
  }

  it('is read from the GasPriceOracle for the transaction’s size, reserved with the gas, and settled from the receipt’s l1Fee', async () => {
    const s = await opSetup();
    s.chain.l1BoundWei = 5_000_000_000_000n;
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => {
      const out = await inner(req);
      s.chain.receipts.set(out.transactionHash, { ...s.chain.receipts.get(out.transactionHash)!, l1Fee: 1_000_000_000_000n });
      return out;
    };
    const signed = signedSend(s.user, { chainId: OP_CHAIN });
    const res = await send(s, signed.body);
    expect(res.status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(req.reservedWei).toBe(req.gas * req.maxFeePerGas + 5_000_000_000_000n);
    const oracle = s.chain.calls.find((c) => c.method === 'call' && (c.args as { to: string }).to === '0x420000000000000000000000000000000000000f')!.args as { data: string };
    const size = BigInt(`0x${oracle.data.slice(10)}`);
    expect(oracle.data.slice(0, 10)).toBe('0xf1c7a58b');
    expect(size).toBe(BigInt((req.data.length - 2) / 2 + 200));
    expect(await appSpent(s.app, OP_CHAIN)).toBe(9_000_000_000_000n + 1_000_000_000_000n);
  });

  it('a receipt without l1Fee is charged the bound; an oracle that doesn’t answer fails closed (502, nothing sent)', async () => {
    const s = await opSetup();
    s.chain.l1BoundWei = 7n;
    expect((await send(s, signedSend(s.user, { chainId: OP_CHAIN }).body)).status).toBe(200);
    expect(await appSpent(s.app, OP_CHAIN)).toBe(9_000_000_000_007n);
    s.chain.l1BoundWei = 'fail';
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 1n);
    const r = await send(s, signedSend(s.user, { chainId: OP_CHAIN, executeNonce: 1n }).body);
    expect([r.status, (await body(r)).code]).toEqual([502, 'evm_rpc_unavailable']);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('an L1 bound that doesn’t fit the app’s budget is refused before sending', async () => {
    const s = await opSetup({ appDailyBudgetEth: 0.0003, dailyBudgetEth: 0.02 });
    s.chain.l1BoundWei = 3n * 10n ** 14n;
    const r = await send(s, signedSend(s.user, { chainId: OP_CHAIN }).body);
    expect([r.status, (await body(r)).code]).toEqual([429, 'app_budget_exhausted']);
    expect(s.relayer.sends).toEqual([]);
  });
});

describe('POST /v1/evm/sponsor/prepare', () => {
  it('a delegated account: journear, both nonces, the relayer, implementation, floor, the largest minGas that fits, allowed', async () => {
    const s = await setup();
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 4n);
    s.chain.pending.set(s.user.address.toLowerCase(), 9n);
    const res = await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] });
    const b = await body(res);
    expect(res.status).toBe(200);
    expect(b).toMatchObject({ delegation: 'journear', accountNonce: '9', executeNonce: '4', relayer: RELAYER, implementation: DELEGATE, minGasFloor: '100000', deadlineMaxS: 600, allowed: true });
    expect(Math.abs((b.serverNow as number) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
    expect(isEvmSponsorPrepareResponse(b)).toBe(true);
    // maxMinGas: a send at it fits maxGasPerTx, one above doesn't.
    const at = await send(s, signedSend(s.user, { executeNonce: 4n, minGas: BigInt(b.maxMinGas as string) }).body);
    expect(at.status).toBe(200);
    expect('reason' in b).toBe(false);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('an account without code: none, its delegate nonce read through the override; another delegate: other, not allowed', async () => {
    const s = await setup({}, { delegated: false });
    const b = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect(b).toMatchObject({ delegation: 'none', executeNonce: '0', allowed: true });
    s.chain.codes.set(s.user.address.toLowerCase(), `0xef0100${'12'.repeat(20)}` as Hex);
    const o = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect(o).toMatchObject({ delegation: 'other', executeNonce: null, allowed: false, reason: 'delegated_elsewhere' });
    expect([isEvmSponsorPrepareResponse(b), isEvmSponsorPrepareResponse(o)]).toEqual([true, true]);
  });

  it('allowed: false with account_unrecorded; the allowlist refusals are the send’s, before any chain read; never signs', async () => {
    const s = await setup({}, { known: false });
    const b = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect([b.allowed, b.reason]).toEqual([false, 'account_unrecorded']);
    s.chain.calls.length = 0;
    const r = await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: `${CHECK_IN_DATA}00` }] });
    expect([r.status, (await body(r)).code]).toEqual([403, 'call_not_sponsored']);
    expect((await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [], extra: 1 }))).code).toBe('bad_request');
    expect(s.chain.calls).toEqual([]);
    expect(s.relayer.sends).toEqual([]);
  });

  it('allowed: false with budget_exhausted once the app’s day budget can’t take another batch', async () => {
    const s = await setup({ appDailyBudgetEth: 0.0003, dailyBudgetEth: 0.02 });
    s.chain.baseFeeWei = 600_000_000n;
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    const b = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect([b.allowed, b.reason]).toEqual([false, 'budget_exhausted']);
  });
});

describe('GET /v1/evm/sponsor/status', () => {
  it('available with this app’s own remaining budget; never the env’s or another app’s figures', async () => {
    const s = await setup();
    const b = await body(await status(s, '?chainId=31337'));
    expect(b).toEqual({ available: true, remainingToday: (10n ** 16n).toString(), requestId: b.requestId });
    expect(isEvmSponsorStatusResponse(b)).toBe(true);
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const after = await body(await status(s, '?chainId=31337'));
    expect(after.remainingToday).toBe((10n ** 16n - 9_000_000_000_000n).toString());
  });

  it('chain_not_enabled, app_not_sponsored, a strict query', async () => {
    const s = await setup();
    expect(await body(await status(s, '?chainId=1'))).toMatchObject({ available: false, reason: 'chain_not_enabled' });
    const other = await seedApp();
    expect(await body(await status({ app: other, bindings: s.bindings }, '?chainId=31337'))).toMatchObject({ available: false, reason: 'app_not_sponsored' });
    for (const q of ['', '?chainId=', '?chainId=0x7a69', '?chainId=31337&x=1', '?chainId=031337']) expect((await status(s, q)).status, q).toBe(400);
    expect(s.chain.calls).toEqual([]);
  });
});

describe('the audit row, the erasure, the request log', () => {
  it('the user’s rows go with the directory user (ON DELETE CASCADE)', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    expect((await auditRows(s.user.address)).length).toBe(1);
    await env.DB.prepare('DELETE FROM end_user_wallets WHERE user_id = ?1').bind(s.userId).run();
    await env.DB.prepare('DELETE FROM end_users WHERE user_id = ?1').bind(s.userId).run();
    expect((await auditRows(s.user.address)).length).toBe(0);
  });

  it('no address, signature, authorization, digest, key or RPC URL in any log line of a send, a refusal or a timeout', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const s = await setup({}, { delegated: false });
    const signed = signedSend(s.user, { authNonce: 0n });
    expect((await send(s, signed.body)).status).toBe(200);
    receiptKind = 'none';
    await send(s, signedSend(s.user, { executeNonce: 0n, minGas: 100_001n, authNonce: 0n }).body);
    await send(s, signedSend(s.user, { signWith: testUser('mallory').key }).body);
    s.chain.down = true;
    await send(s, signedSend(s.user, { minGas: 100_002n, authNonce: 0n }).body);
    const auth = signed.body.authorization as { r: string; s: string };
    const secrets = [s.user.address, s.user.address.toLowerCase(), (signed.body.signature as string).slice(2, 40), auth.r.slice(2, 40), auth.s.slice(2, 40), signed.digest.slice(2, 40), RELAYER.toLowerCase(), RELAYER, 'http://127.0.0.1:8545', (s.bindings.EVM_RELAY_KEYS as string).slice(4, 40)];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) for (const x of secrets) expect(line.includes(x), x).toBe(false);
    expect(lines.some((l) => l.includes('"endpoint":"/v1/evm/sponsor/send"'))).toBe(true);
  });
});

describe('the relayer checks (cron): balance and stuck transactions', () => {
  it('writes evm_relay_balance_low once a day and evm_relay_stuck once an hour; nothing without the config', async () => {
    const s = await setup();
    s.chain.balanceWei = 10n ** 15n;
    s.relayer.statusValue = { address: RELAYER, pending: 2, oldestPendingMs: 6 * 60_000, nextNonce: 5 };
    sponsorPorts.relayer = () => ({ send: async () => Promise.reject(new Error('unused')), status: async () => s.relayer.statusValue, lookup: async () => null });
    const e = { ...env, ...s.bindings } as typeof env;
    await checkEvmSponsorRelay(e);
    await checkEvmSponsorRelay(e);
    const kinds = (await env.DB.prepare("SELECT kind, detail_json FROM security_events WHERE kind LIKE 'evm_relay_%' ORDER BY kind").all<{ kind: string; detail_json: string }>()).results;
    expect(kinds.map((k) => k.kind)).toEqual(['evm_relay_balance_low', 'evm_relay_stuck']);
    expect(JSON.parse(kinds[0]!.detail_json)).toMatchObject({ chainId: LOCAL_CHAIN, balanceWei: '1000000000000000', lowBalanceWei: (5n * 10n ** 16n).toString() });
    expect(JSON.parse(kinds[1]!.detail_json)).toEqual({ chainId: LOCAL_CHAIN, pending: 2, oldestPendingMs: 6 * 60_000 });
    s.chain.calls.length = 0;
    await checkEvmSponsorRelay({ ...e, EVM_SPONSOR: undefined } as typeof env);
    expect(s.chain.calls).toEqual([]);
  });
});
