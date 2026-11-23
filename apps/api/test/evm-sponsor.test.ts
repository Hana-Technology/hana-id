// EVM gas sponsorship's routes (D847, D848; docs/api.md "EVM gas sponsorship") through the Worker, with the two ports
// faked (evm-sponsor-helpers.ts): a chain that records every read and a relayer binding that records every send. Every
// refusal code, the order (cheap checks never read the chain), the budgets and their settlement, concurrency, replays,
// the receipt rule, the audit row, the security events and the request log.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { checkEvmSponsorRelay, evmSponsorConfig, sponsorFaults, EVM_SPONSOR_PREPARE_ENDPOINT as PREPARE, EVM_SPONSOR_SEND_ENDPOINT as SEND, EVM_SPONSOR_STATUS_ENDPOINT as STATUS, sponsorPins, sponsorTiming } from '../src/evm/sponsor.ts';
import { DEFAULT_SPONSOR_PORTS, type Hex, keccakHex, sponsorPorts } from '../src/evm/sponsor-ports.ts';
import { type SendRow, pruneEvmSponsorSends, reconcileEvmSends, settleNotCharged } from '../src/evm/sponsor-settle.ts';
import { checksumEvmAddress } from '../src/evm/sponsor-config.ts';
import { BILLING_LATE_MS, mirrorEvmBilling, RECORD_EVM_SPONSORED_SQL } from '../src/evm/sponsor-billing.ts';
import { usageTransport } from '../src/usage/record.ts';
import { EVM_SPONSOR_LIMITS } from '../src/evm/sponsor-checks.ts';
import { maxStartingFees, sponsorGasLimit } from '../src/evm/op-fee.ts';
import { encodeExecuteCalldata } from '@hana-id/core/evm-sponsor';
import { appHeaders, call, ORIGIN, seedApp, type SeededApp, startOfMinuteClock } from './helpers.ts';
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
  sessionFor,
  sessionsInMemory,
  withProof,
  digestOf,
  rawFor,
  receiptFor,
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

/** A seeded app whose sessions live in the vault's memory (no share: the chain alone decides, D856's step 3). */
async function sponsorApp(o?: Parameters<typeof seedApp>[0]): Promise<SeededApp> {
  const a = await seedApp(o);
  await sessionsInMemory(a.id);
  return a;
}

async function setup(fields: ChainFields = {}, o: { chainId?: number; delegated?: boolean; known?: boolean; extraApps?: string[] } = {}): Promise<Setup> {
  const app = await sponsorApp();
  const chain = fakeChain();
  const relayer = fakeRelayer(chain, () => receiptKind);
  const user = testUser();
  sessionFor(app.scope, user.address);
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
  await env.DB.exec("DELETE FROM security_events WHERE kind LIKE 'evm_relay_%' OR kind = 'evm_billing_late'");
  await env.DB.exec('DELETE FROM evm_sponsor_sends');
  await env.DB.exec('DELETE FROM evm_sponsor_billing');
});
/** What the ledger was sent (the usage transport, faked: no test reaches a database). */
let ledgerCalls: { sql: string; rows: Record<string, unknown>[] }[] = [];
let ledgerDown = false;
const realTransport = usageTransport.query;
beforeEach(() => {
  ledgerCalls = [];
  ledgerDown = false;
  usageTransport.query = async (_b, sql, params) => {
    if (ledgerDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    ledgerCalls.push({ sql, rows: JSON.parse(String(params[0])) as Record<string, unknown>[] });
  };
});
afterEach(() => {
  usageTransport.query = realTransport;
});
beforeEach(async () => {
  const { forgetRelayerStatus, forgetRelayerBalances } = await import('../src/evm/sponsor.ts');
  forgetRelayerStatus();
  forgetRelayerBalances();
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
  sponsorFaults.afterSentPersisted = null;
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

  it('outside local* envs, without a usable trusted read endpoint secret (EVM_SPONSOR_RPC_<chainId>): never the public rpc instead', async () => {
    sponsorPins.table = { ...SPONSOR_DELEGATES, [OP_CHAIN]: { address: OP_DELEGATE } };
    const s = await setup({}, { chainId: OP_CHAIN });
    const { body: b } = signedSend(s.user, { chainId: OP_CHAIN });
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const sandbox = { ...s.bindings, ENV_NAME: 'sandbox-test' } as Partial<typeof env> & Record<string, unknown>;
    const variants = [sandbox, { ...sandbox, EVM_SPONSOR_RPC_84532: '' }, { ...sandbox, EVM_SPONSOR_RPC_84532: 'http://rpc.example.test/key-part' }, { ...sandbox, EVM_SPONSOR_RPC_84532: 'not a url key-part' }];
    for (const v of variants) {
      for (const [path, method, payload] of [[SEND, 'POST', b], [PREPARE, 'POST', { chainId: OP_CHAIN, account: s.user.address, calls: b.calls }], [`${STATUS}?chainId=${OP_CHAIN}`, 'GET', undefined]] as const) {
        const res = await sponsorCall(path, s.app, v as Partial<typeof env>, { body: payload, method });
        expect([res.status, (await body(res)).code], `${path} ${String(v.EVM_SPONSOR_RPC_84532)}`).toEqual([503, 'sponsorship_unconfigured']);
      }
    }
    expect(s.chain.calls).toEqual([]);
    expect(s.relayer.sends).toEqual([]);
    const missing = lines.filter((l) => l.includes('evm_sponsor_rpc_missing'));
    expect(missing.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(missing[0]!)).toMatchObject({ level: 'error', event: 'evm_sponsor_config', outcome: 'error', code: 'evm_sponsor_rpc_missing', chainIds: [OP_CHAIN] });
    expect(lines.join('\n')).not.toContain('key-part');
    // With an https secret the same env sends (the fake chain stands in for the endpoint); a local* env needs none.
    const ok = await send({ app: s.app, bindings: { ...sandbox, EVM_SPONSOR_RPC_84532: 'https://rpc.example.test/key-part' } as Partial<typeof env> }, b);
    expect(ok.status).toBe(200);
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

  it('per-IP windows across apps: 30 a minute for prepare and send, 60 for status, apart', async () => {
    const s = await setup();
    const headers = { ...vaultHeaders(s.app), 'cf-connecting-ip': '10.9.9.9' };
    const codes: number[] = [];
    const b = { chainId: 1, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] };
    for (let i = 0; i < EVM_SPONSOR_LIMITS.perIpPerMinute + 1; i++) codes.push((await prepare(s, b, headers)).status);
    expect(codes.slice(0, -1).every((c) => c === 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // The status window is its own: still open.
    const st: number[] = [];
    for (let i = 0; i < EVM_SPONSOR_LIMITS.statusPerIpPerMinute + 1; i++) st.push((await status(s, '?chainId=31337', headers)).status);
    expect(st.slice(0, -1).every((c) => c === 200)).toBe(true);
    expect(st.at(-1)).toBe(429);
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
    ['a deadline under 30 s away', (s) => signedSend(s.user, { deadline: BigInt(Math.floor(Date.now() / 1000) + 29) }).body, 400, 'deadline_out_of_range', { deadlineMaxS: 300 }],
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
    const other = await sponsorApp();
    const res = await send({ app: other, bindings: s.bindings }, signedSend(s.user).body);
    expect([res.status, (await body(res)).code]).toEqual([403, 'app_not_sponsored']);
    expect(s.chain.calls).toEqual([]);
  });

  it('an account the directory does not hold for this app’s scope: 409 account_unrecorded (retryable), also when another scope holds it', async () => {
    const s = await setup({}, { known: false });
    const elsewhere = await sponsorApp();
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
    // base fee 0.1 gwei: 2 × 0.1 + the tip (0.01 gwei, at most its starting cap, as the relayer's maxStartingFees), under
    // the starting cap. The reservation is at the 1 gwei cap (the relayer may replace the transaction up to it).
    const start = maxStartingFees({ maxFeePerGasWei: 1_000_000_000n, maxPriorityFeePerGasWei: 10_000_000n });
    expect(req).toEqual({ chainId: LOCAL_CHAIN, execute: signed.input, signature: signed.body.signature, gas, maxFeePerGas: 200_000_000n + start.maxPriorityFeePerGas, maxPriorityFeePerGas: start.maxPriorityFeePerGas, reservedWei: gas * 1_000_000_000n });
    expect(s.relayer.names).toContain('evm-relayer-31337-0');
    // The simulation: from the relayer, to the account, the exact calldata, at exactly the gas limit (no authorization), no override.
    const sim = s.chain.calls.find((c) => c.method === 'call' && (c.args as { data: string }).data === calldata)!.args;
    expect(sim).toEqual({ from: RELAYER, to: s.user.address, data: calldata, gas });
    // Settled to gasUsed × price (60 000 × 0.15 gwei), on the app's budget and the env's.
    expect([await appSpent(s.app), await envSpent()]).toEqual([9_000_000_000_000n, 9_000_000_000_000n]);
    expect(await auditRows(s.user.address)).toEqual([{ status: 'executed', tx_hash: b.transactionHash, reserved_wei: (gas * 1_000_000_000n).toString(), settled_wei: '9000000000000', user_id: s.userId, relayer_nonce: 0, app_id: s.app.id }]);
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

  it('a nonce the chain has used: 409 nonce_stale with the chain’s nonce; the floor is not raised from a head read (N2: a reorg could undo it)', async () => {
    const s = await setup();
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 1000n);
    const old = signedSend(s.user, { executeNonce: 1n });
    const res = await send(s, old.body);
    const b = await body(res);
    expect([res.status, b.code, b.executeNonce]).toEqual([409, 'nonce_stale', '1000']);
    const floor = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`evm-sponsor:account:${LOCAL_CHAIN}:${s.user.address.toLowerCase()}`)).floor('evm-sponsor:nonce');
    expect(floor).toBe('0');
    // The chain says the nonce is used; after a reorg in which it isn't, the same batch goes through.
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 1n);
    expect((await send(s, old.body)).status).toBe(200);
    // A future nonce is stale too, without moving the floor.
    const r3 = await send(s, signedSend(s.user, { executeNonce: 9n }).body);
    expect([(await body(r3)).code]).toEqual(['nonce_stale']);
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

  it('starts the fees at most at the relayer’s maxStartingFees (room for two replacements), and refuses a base fee above it', async () => {
    const s = await setup();
    const start = maxStartingFees({ maxFeePerGasWei: 1_000_000_000n, maxPriorityFeePerGasWei: 10_000_000n });
    s.chain.baseFeeWei = 500_000_000n;
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    expect(s.relayer.sends[0]!.maxFeePerGas).toBe(start.maxFeePerGas);
    s.chain.baseFeeWei = start.maxFeePerGas + 1n;
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 1n);
    const r = await send(s, signedSend(s.user, { executeNonce: 1n }).body);
    expect([r.status, (await body(r)).code]).toEqual([503, 'gas_price_too_high']);
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
    // The authorization's 25 000 is inside the relayer's own intrinsicGas (the units test has the figures).
    expect(req.gas > sponsorGasLimit({ calldata, callData: [CHECK_IN_DATA], minGas: 100_000n, authorizations: 0 })).toBe(true);
    const sim = s.chain.calls.find((c) => c.method === 'call' && (c.args as { data: string }).data === calldata)!.args as { stateOverride: Record<string, unknown> };
    expect(sim.stateOverride).toEqual({ [s.user.address]: { code: DESIGNATOR } });
    // eth_call has no authorization list: it runs with 25 000 less, the gas the batch will have in the real type-4 send.
    expect((sim as unknown as { gas: bigint }).gas).toBe(req.gas - 25_000n);
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
    expect([res.status, (await body(res)).code]).toEqual([503, 'outcome_unknown']);
    expect((await auditRows(s.user.address))[0]?.status).toBe('unknown');
    const first = s.relayer.sends[0]!.reservedWei;
    expect(await appSpent(s.app)).toBe(first);
    // The retry reaches the relayer (idempotent per digest): its first transaction, replay, this copy's reservation back.
    fail = false;
    const again = await send(s, signed.body);
    expect(again.status).toBe(200);
    expect(s.relayer.sends.map((x) => digestOf(x))).toEqual([signed.digest, signed.digest]);
    expect(await appSpent(s.app)).toBe(first);
  });

  it('a coded relayer refusal sent nothing: everything comes back, the row says refused, the code is answered', async () => {
    // [message, status, code, retryAfterS, the user's own attempts come back]
    const cases: [string, number, string, number | undefined, boolean][] = [
      ['evm_relayer:relayer_busy', 429, 'relayer_busy', 2, true],
      ['evm_relayer:relayer_busy:account', 429, 'account_busy', 5, true],
      ['evm_relayer:relayer_misconfigured', 503, 'sponsorship_unconfigured', undefined, true],
      ['evm_relayer:rpc_unavailable', 502, 'evm_rpc_unavailable', undefined, true],
      ['evm_relayer:rejected:insufficient_funds', 503, 'relayer_unavailable', undefined, true],
      ['evm_relayer:deadline_passed', 400, 'deadline_out_of_range', undefined, false],
      ['evm_relayer:invalid_request', 503, 'internal_error', undefined, true],
      ['evm_relayer:fees_too_high', 503, 'gas_price_too_high', 30, true],
      ['evm_relayer:fees_too_low', 503, 'gas_price_too_high', 15, true],
      ['evm_relayer:daily_cap', 429, 'budget_exhausted', 3600, true],
    ];
    for (const [message, statusCode, code, retry, ownBack] of cases) {
      const s = await setup();
      s.relayer.onSend = async () => {
        throw new Error(message);
      };
      const signed = signedSend(s.user);
      const res = await send(s, signed.body);
      const b = await body(res);
      expect([res.status, b.code], message).toEqual([statusCode, code]);
      if (retry !== undefined) expect(b.retryAfterS, message).toBe(retry);
      expect(await appSpent(s.app), message).toBe(0n);
      expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`), message).toBe(0n);
      expect(await hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:attempts`), message).toBe(ownBack ? 0 : 1);
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
      s.relayer.replaced.set(digestOf(req), [bumped]);
      // Only the replacement is mined, dearer than the reservation.
      s.chain.receipts.set(bumped, receiptFor(req, bumped, 'executed', { gasUsed: req.gas, price: req.maxFeePerGas * 2n }));
      return { transactionHash: keccakHex(raw), relayerNonce: 0, raw, replay: false, digest: digestOf(req), broadcast: "accepted" as const, rejection: null };
    };
    const res = await send(s, signedSend(s.user).body);
    expect(res.status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(await appSpent(s.app)).toBe(req.gas * req.maxFeePerGas * 2n);
    expect(s.relayer.lookups).toContain(digestOf(req));
  });

  it('a relayer replay whose latest version is the deadline cancel (no Executed log): 422 not_executed', async () => {
    const s = await setup();
    const inner = fakeRelayer(s.chain, () => 'not_executed').onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), replay: true });
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('not_executed');
  });

  it('a relayer answer whose hash is not its raw transaction’s is not trusted', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => ({ transactionHash: `0x${'ab'.repeat(32)}`, relayerNonce: 0, raw: `0x02${digestOf(req).slice(2)}`, replay: false, digest: digestOf(req), broadcast: "accepted" as const, rejection: null });
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('outcome_unknown');
  });

  it('a relayer replay (it had sent this digest): no second charge, the first send’s hash', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => {
      const { rawFor } = await import('./evm-sponsor-helpers.ts');
      const { keccakHex } = await import('../src/evm/sponsor-ports.ts');
      const raw = rawFor(req);
      const hash = keccakHex(raw);
      s.chain.receipts.set(hash, (await import('./evm-sponsor-helpers.ts')).receiptFor(req, hash, 'executed'));
      return { transactionHash: hash, relayerNonce: 4, raw, replay: true, digest: digestOf(req), broadcast: "accepted" as const, rejection: null };
    };
    const res = await send(s, signedSend(s.user).body);
    expect(res.status).toBe(200);
    expect(await appSpent(s.app)).toBe(0n);
  });

  it('a receipt dearer than the transaction’s own max fee is billed at that max fee and reported (D868), never more than could have been paid', async () => {
    const s = await setup();
    s.relayer.onSend = async (req) => {
      const { rawFor, receiptFor } = await import('./evm-sponsor-helpers.ts');
      const { keccakHex } = await import('../src/evm/sponsor-ports.ts');
      const raw = rawFor(req);
      const hash = keccakHex(raw);
      s.chain.receipts.set(hash, receiptFor(req, hash, 'executed', { gasUsed: req.gas, price: req.maxFeePerGas + 1n }));
      return { transactionHash: hash, relayerNonce: 0, raw, replay: false, digest: digestOf(req), broadcast: "accepted" as const, rejection: null };
    };
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(await appSpent(s.app)).toBe(req.gas * req.maxFeePerGas);
    const row = await env.DB.prepare('SELECT id, settled_wei FROM evm_sponsor_sends WHERE account = ?1').bind(s.user.address).first<{ id: string; settled_wei: string }>();
    expect(row!.settled_wei).toBe((req.gas * req.maxFeePerGas).toString());
    const bill = await env.DB.prepare('SELECT effective_gas_price_wei, execution_wei, total_cost_wei FROM evm_sponsor_billing WHERE send_id = ?1').bind(row!.id).first<Record<string, string>>();
    expect(bill).toEqual({ effective_gas_price_wei: req.maxFeePerGas.toString(), execution_wei: (req.gas * req.maxFeePerGas).toString(), total_cost_wei: (req.gas * req.maxFeePerGas).toString() });
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_receipt_odd'").all<{ detail_json: string }>();
    expect(ev.results.map((e) => JSON.parse(e.detail_json))).toEqual([{ chainId: 31337, priceAboveMaxFee: true }]);
  });

  it('the bound comes from the relayer’s lookup for a version it signed later (a fee bump): billed at that version’s max fee', async () => {
    const s = await setup();
    const bumped = `0x${'b'.repeat(64)}` as Hex;
    s.relayer.onSend = async (req) => {
      const { rawFor, receiptFor } = await import('./evm-sponsor-helpers.ts');
      const { keccakHex } = await import('../src/evm/sponsor-ports.ts');
      const raw = rawFor(req);
      // The bump is what was mined; its receipt says a price above the bump's own max fee.
      s.chain.receipts.set(bumped, receiptFor(req, bumped, 'executed', { gasUsed: 60_000n, price: req.maxFeePerGas * 2n }));
      return { transactionHash: keccakHex(raw), relayerNonce: 0, raw, replay: false, digest: digestOf(req), broadcast: 'accepted' as const, rejection: null };
    };
    s.relayer.lookupOverride = async (digest) => {
      const req = s.relayer.sends[0]!;
      const first = (await import('../src/evm/sponsor-ports.ts')).keccakHex((await import('./evm-sponsor-helpers.ts')).rawFor(req));
      const bumpFee = (req.maxFeePerGas * 9n) / 8n + 1n;
      return { digest, relayerNonce: 0, transactionHash: bumped, hashes: [first, bumped], state: 'pending', minedHash: null, outcome: null, costWei: null, reservedWei: req.reservedWei, versionFees: [{ hash: first, maxFeePerGas: req.maxFeePerGas }, { hash: bumped, maxFeePerGas: bumpFee }] };
    };
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(await appSpent(s.app)).toBe(60_000n * ((req.maxFeePerGas * 9n) / 8n + 1n));
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
    const other = await sponsorApp();
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
    // A non-local env needs its trusted read endpoint secret (D851 as amended); the fake chain stands in for it.
    s.bindings = { ...s.bindings, ENV_NAME: 'sandbox-test', EVM_SPONSOR_RPC_84532: 'https://rpc.example.test/key' } as Partial<typeof env>;
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
    expect(req.reservedWei).toBe(req.gas * 1_000_000_000n + 5_000_000_000_000n);
    const oracle = s.chain.calls.find((c) => c.method === 'call' && (c.args as { to: string }).to === '0x420000000000000000000000000000000000000f')!.args as { data: string };
    const size = BigInt(`0x${oracle.data.slice(10)}`);
    expect(oracle.data.slice(0, 10)).toBe('0xf1c7a58b');
    expect(size).toBe(BigInt((encodeExecuteCalldata(req.execute, req.signature).length - 2) / 2 + 200));
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
    // serverNow is the server's second during the request: between the clock's second before it and after it (a
    // fixed ±1 s around a read after the response failed whenever the request took more than a second).
    const beforeS = Math.floor(Date.now() / 1000);
    const res = await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] });
    const afterS = Math.floor(Date.now() / 1000);
    const b = await body(res);
    expect(res.status).toBe(200);
    expect(b).toMatchObject({ delegation: 'journear', accountNonce: '9', executeNonce: '4', relayer: RELAYER, implementation: DELEGATE, minGasFloor: '100000', deadlineMaxS: 300, allowed: true });
    expect(b.serverNow as number).toBeGreaterThanOrEqual(beforeS);
    expect(b.serverNow as number).toBeLessThanOrEqual(afterS);
    expect(isEvmSponsorPrepareResponse(b)).toBe(true);
    // maxMinGas: a send at it fits maxGasPerTx, one above doesn't.
    const at = await send(s, signedSend(s.user, { executeNonce: 4n, minGas: BigInt(b.maxMinGas as string) }).body);
    expect(at.status).toBe(200);
    expect('reason' in b).toBe(false);
    expect(s.relayer.sends.length).toBe(1);
  });

  it('maxMinGas is an upper bound for any real batch: at minGas = maxMinGas every deadline’s and signature’s calldata fits', async () => {
    const s = await setup();
    const b = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    const maxMinGas = BigInt(b.maxMinGas as string);
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (let i = 0n; i < 300n; i++) {
      // Deadlines across the window (some with a zero byte, some without), each with its own signature.
      const signed = signedSend(s.user, { minGas: maxMinGas, deadline: now + 30n + i * 2n });
      const limit = sponsorGasLimit({ calldata: encodeExecuteCalldata(signed.input, signed.body.signature as Hex), callData: [CHECK_IN_DATA], minGas: maxMinGas, authorizations: 0 });
      expect(limit <= 300_000n, String(i)).toBe(true);
    }
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

  it('an account outside the directory: 409 account_unrecorded before any window or chain read; the allowlist refusals are the send’s; never signs', async () => {
    const s = await setup({}, { known: false });
    const r0 = await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] });
    expect([r0.status, (await body(r0)).code]).toEqual([409, 'account_unrecorded']);
    expect(s.chain.calls).toEqual([]);
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
    const other = await sponsorApp();
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
    s.relayer.statusValue = { address: RELAYER, unmined: 2, awaitingConfirmation: 0, oldestUnminedMs: 11 * 60_000, oldestUnacceptedMs: null, nextNonce: 5, halted: null };
    sponsorPorts.relayer = () => ({ send: async () => Promise.reject(new Error('unused')), status: async () => s.relayer.statusValue, lookup: async () => null });
    const e = { ...env, ...s.bindings } as typeof env;
    await checkEvmSponsorRelay(e);
    await checkEvmSponsorRelay(e);
    const kinds = (await env.DB.prepare("SELECT kind, detail_json FROM security_events WHERE kind LIKE 'evm_relay_%' ORDER BY kind").all<{ kind: string; detail_json: string }>()).results;
    expect(kinds.map((k) => k.kind)).toEqual(['evm_relay_balance_low', 'evm_relay_stuck']);
    expect(JSON.parse(kinds[0]!.detail_json)).toMatchObject({ chainId: LOCAL_CHAIN, balanceWei: '1000000000000000', lowBalanceWei: (5n * 10n ** 16n).toString() });
    expect(JSON.parse(kinds[1]!.detail_json)).toEqual({ chainId: LOCAL_CHAIN, pending: 2, oldestPendingMs: 11 * 60_000 });
    s.chain.calls.length = 0;
    await checkEvmSponsorRelay({ ...e, EVM_SPONSOR: undefined } as typeof env);
    expect(s.chain.calls).toEqual([]);
  });

  it('D890: each automatic restart the relayer reports raises evm_relay_auto_resumed once (its id the restart’s time); none older than a day, none malformed', async () => {
    const s = await setup();
    const now = Date.now();
    const recent = [now - 60_000, now - 2 * 60 * 60_000, now - 2 * 86_400_000, 'x' as never];
    sponsorPorts.relayer = () => ({ send: async () => Promise.reject(new Error('unused')), status: async () => ({ address: RELAYER, unmined: 0, awaitingConfirmation: 0, oldestUnminedMs: null, oldestUnacceptedMs: null, nextNonce: 5, halted: null, autoRestartedAt: recent }), lookup: async () => null });
    const e = { ...env, ...s.bindings } as typeof env;
    await checkEvmSponsorRelay(e, now);
    await checkEvmSponsorRelay(e, now + 15 * 60_000);
    const rows = (await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_auto_resumed' ORDER BY detected_at").all<{ detail_json: string }>()).results.map((r) => JSON.parse(r.detail_json) as { at: number });
    expect(rows.map((r) => r.at).sort()).toEqual([now - 2 * 60 * 60_000, now - 60_000].sort());
    expect(rows[0]).toMatchObject({ chainId: LOCAL_CHAIN });
  });
});

// ---- after the independent review (2026-11-17): M1–M3, L1–L5 ----

/** The env a cron run sees for a setup. */
const cronEnv = (s: Pick<Setup, 'bindings'>) => ({ ...env, ...s.bindings }) as typeof env;
/** Makes every open row the reconciler's (as if a minute had passed since its last update). */
const ageRows = (ms = 2 * 60_000) => env.DB.prepare('UPDATE evm_sponsor_sends SET updated_at = created_at - ?1, created_at = created_at - ?1').bind(ms).run();
const reconcile = async (s: Pick<Setup, 'bindings'>, now = Date.now()) => reconcileEvmSends(cronEnv(s), evmSponsorConfig(cronEnv(s))!, now);
const billingRows = async () => (await env.DB.prepare('SELECT * FROM evm_sponsor_billing ORDER BY settled_at, record_key').all<Record<string, unknown>>()).results;
/** A fixed window's count on a limiter subject (RateLimiter.hit's own storage key). */
const hits = async (subject: string, name: string, windowMs = 86_400_000): Promise<number> =>
  runInDurableObject(env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(subject)), async (_i, state) => state.storage.kv.get<number>(`${name}@${Math.floor(Date.now() / windowMs) * windowMs}`) ?? 0);
const failuresSpent = async (subject: string) => BigInt(await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(subject)).spent('evm-sponsor:failures', 86_400_000));

describe('M1: shared windows are counted only once the chain checks passed', () => {
  it('refusals after the chain reads (no delegation, a future nonce, too much gas, an RPC failure) never use up the app’s or the env’s minute', async () => {
    const s = await setup({ sendsPerMinute: 1 });
    const others = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const u = testUser();
        await rememberAccount(s.app.scope, u.address);
        return u;
      }),
    );
    // No code and no authorization; a future nonce; too much gas; the chain down.
    expect((await body(await send(s, signedSend(others[0]!).body))).code).toBe('delegation_required');
    s.chain.codes.set(others[1]!.address.toLowerCase(), DESIGNATOR);
    expect((await body(await send(s, signedSend(others[1]!, { executeNonce: 5n }).body))).code).toBe('nonce_stale');
    s.chain.codes.set(others[2]!.address.toLowerCase(), DESIGNATOR);
    expect((await body(await send(s, signedSend(others[2]!, { minGas: 290_000n }).body))).code).toBe('gas_too_high');
    s.chain.down = true;
    expect((await body(await send(s, signedSend(others[3]!).body))).code).toBe('evm_rpc_unavailable');
    s.chain.down = false;
    // The env's one send a minute is still there for a valid batch.
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
  });

  it('a user’s attempts that reach the chain are capped per day (perUserPerDay × 3), before any further chain read', async () => {
    const s = await setup({ perUserPerDay: 1 });
    s.chain.codes.delete(s.user.address.toLowerCase());
    for (let i = 0; i < 3; i++) expect((await body(await send(s, signedSend(s.user, { minGas: 100_000n + BigInt(i) }).body))).code).toBe('delegation_required');
    s.chain.calls.length = 0;
    const r = await send(s, signedSend(s.user, { minGas: 100_010n }).body);
    const b = await body(r);
    expect([r.status, b.code, b.error]).toEqual([429, 'rate_limited', 'Rate limit exceeded (attempts per user)']);
    expect(s.chain.calls).toEqual([]);
  });
});

describe('M2, closed by the session proof (D856)', () => {
  it('the account’s prepare minute is reached only by its own session: another session’s proof for the account is refused first, counting nothing', async () => {
    const s = await setup();
    const b = { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] };
    // A stranger with a live session of their own can't name this account: the wallet proof must be the account's.
    const stranger = testUser();
    const theirs = sessionFor(s.app.scope, stranger.address);
    for (let i = 0; i < EVM_SPONSOR_LIMITS.preparesPerAccountPerMinute + 2; i++) {
      const r = await prepare(s, withProof(s.app, b, 'prepare', { spk: theirs.spk, walletAddress: stranger.address }), undefined);
      expect((await body(r)).code).toBe('bad_wallet_proof');
    }
    expect(s.chain.calls).toEqual([]);
    for (let i = 0; i < EVM_SPONSOR_LIMITS.preparesPerAccountPerMinute; i++) expect((await prepare(s, b)).status).toBe(200);
    expect((await prepare(s, b)).status).toBe(429);
  });

  it('a user’s failure count is never disclosed: a generic not_available', async () => {
    const s = await setup();
    s.chain.simulate = () => {
      throw revertErr('0x756688fe');
    };
    for (let i = 0; i < 3; i++) expect((await body(await send(s, signedSend(s.user, { minGas: 100_000n + BigInt(i) }).body))).code).toBe('simulation_reverted');
    const b = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect([b.allowed, b.reason]).toEqual([false, 'not_available']);
  });
});

describe('M3: the settlement survives the client, and the cron reconciles what is left', () => {
  it('everything after the reservation runs inside waitUntil: a client gone before the answer still gets its batch settled', async () => {
    const s = await setup();
    const held: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void held.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const { call } = await import('./helpers.ts');
    // The client never reads the answer: only the waitUntil promise is awaited.
    void call(SEND, { headers: vaultHeaders(s.app), body: withProof(s.app, signedSend(s.user).body, 'send'), env: s.bindings, exec });
    await new Promise((r) => setTimeout(r, 20));
    while (held.length === 0) await new Promise((r) => setTimeout(r, 10));
    await Promise.all(held);
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'executed', settled_wei: '9000000000000' });
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
  });

  it('a timeout reconciled to executed: settled into the reservation’s day, the failure slot freed; idempotent: the same signed batch again is answered from its row, nothing sent', async () => {
    const s = await setup();
    receiptKind = 'none';
    // The one signed batch, kept: signedSend's default deadline is the wall clock's second + 300, so signing again a
    // second later would be ANOTHER batch (a new digest: sent, never mined here, 504), which made this test fail
    // whenever the machine was slow enough for the reconcile steps to cross a second.
    const batch = signedSend(s.user);
    expect((await send(s, batch.body)).status).toBe(504);
    const req = s.relayer.sends[0]!;
    expect(await appSpent(s.app)).toBe(req.reservedWei);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(1n);
    const hash = keccakHex(rawFor(req));
    s.chain.receipts.set(hash, receiptFor(req, hash, 'executed'));
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    expect(await reconcile(s)).toMatchObject({ settled: 0 });
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'executed', settled_wei: '9000000000000' });
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(0n);
    const copy = await body(await send(s, batch.body));
    expect(copy).toMatchObject({ status: 'executed', transactionHash: hash, replay: true });
    expect(s.relayer.sends).toHaveLength(1);
  });

  it('a timeout reconciled to reverted (charged, a failure) and to the deadline cancel (the lookup’s mined hash: not_executed)', async () => {
    const s = await setup();
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    expect((await send(s, signedSend(u2).body)).status).toBe(504);
    const [a, b] = s.relayer.sends;
    const ha = keccakHex(rawFor(a!));
    s.chain.receipts.set(ha, receiptFor(a!, ha, 'reverted'));
    const cancel = keccakHex(rawFor(b!, 'cancel'));
    s.chain.receipts.set(cancel, { ...receiptFor(b!, cancel, 'not_executed'), gasUsed: 21_000n });
    s.relayer.lookupOverride = async (digest) =>
      digest === digestOf(b!) ? { relayerNonce: 1, transactionHash: cancel, hashes: [keccakHex(rawFor(b!)), cancel], state: 'mined', digest: digestOf(b!), reservedWei: b!.reservedWei, minedHash: cancel, outcome: 'cancel', costWei: 21_000n * 150_000_000n } : null;
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 2 });
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'reverted', settled_wei: '9000000000000' });
    expect((await auditRows(u2.address))[0]).toMatchObject({ status: 'not_executed', settled_wei: (21_000n * 150_000_000n).toString() });
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(1n);
  });

  it('an unknown relayer failure, then the copy the relayer answers as a replay: the reconciler settles the first attempt’s reservation', async () => {
    const s = await setup();
    const inner = s.relayer.onSend;
    let fail = true;
    s.relayer.onSend = async (req) => {
      if (fail) throw new Error('the object was reset');
      return { ...(await inner(req)), replay: true };
    };
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(503);
    fail = false;
    expect((await send(s, signed.body)).status).toBe(200);
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    // The first attempt's reservation is now the receipt's cost, counted once; both rows say executed.
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
    expect((await auditRows(s.user.address)).map((r) => r.status)).toEqual(['executed', 'executed']);
  });

  it('a send the relayer doesn’t know stays open (no inference from silence), and an hour past the deadline is lost: the reservation kept, billed as lost', async () => {
    const s = await setup();
    s.relayer.onSend = async () => {
      throw new Error('the object was reset');
    };
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(503);
    s.relayer.lookupOverride = async () => null;
    await ageRows();
    const deadlineMs = Number(signed.body.deadline) * 1000;
    const reserved = s.relayer.sends[0]!.reservedWei;
    expect(await reconcile(s, deadlineMs + 3 * 60_000)).toMatchObject({ open: 1 });
    expect(await reconcile(s, deadlineMs + 61 * 60_000)).toMatchObject({ lost: 1 });
    expect(await appSpent(s.app)).toBe(reserved);
    expect(await billingRows()).toMatchObject([{ outcome: 'lost', tx_hash: null, settled_wei: reserved.toString(), total_cost_wei: null }]);
  });

  it('a row left open over 10 minutes writes evm_relay_stuck', async () => {
    const s = await setup();
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    await ageRows(11 * 60_000);
    await reconcile(s);
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").all<{ detail_json: string }>();
    expect(ev.results.length).toBe(1);
    expect(JSON.parse(ev.results[0]!.detail_json)).toMatchObject({ chainId: LOCAL_CHAIN, pending: 1 });
  });
});

describe('L2: a receipt outside what was reserved is settled at the reservation', () => {
  for (const [what, cost] of [
    ['more gas used than the limit', (g: bigint, _f: bigint) => ({ gasUsed: g + 1n, price: 1n })],
    ['a price above the fee cap', (_g: bigint, _f: bigint) => ({ gasUsed: 50_000n, price: 1_000_000_001n })],
    ['less than the base 21 000', (_g: bigint, _f: bigint) => ({ gasUsed: 20_999n, price: 1n })],
  ] as const) {
    it(what, async () => {
      const s = await setup();
      s.relayer.onSend = async (req) => {
        const raw = rawFor(req);
        const hash = keccakHex(raw);
        s.chain.receipts.set(hash, receiptFor(req, hash, 'executed', cost(req.gas, req.maxFeePerGas)));
        return { transactionHash: hash, relayerNonce: 0, raw, replay: false, digest: digestOf(req), broadcast: "accepted" as const, rejection: null };
      };
      expect((await send(s, signedSend(s.user).body)).status).toBe(200);
      expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
      const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'evm_relay_receipt_odd'").first<{ n: number }>();
      expect(ev?.n).toBe(1);
    });
  }
});

describe('L3: the OP Stack operator fee', () => {
  it('its bound (getOperatorFee at the gas limit) is reserved and the receipt’s operator fee settled; an oracle that fails other than by reverting fails closed', async () => {
    sponsorPins.table = { ...SPONSOR_DELEGATES, [OP_CHAIN]: { address: OP_DELEGATE } };
    const s = await setup({}, { chainId: OP_CHAIN });
    s.chain.l1BoundWei = 1_000n;
    s.chain.operatorBoundWei = 7_000_000_000_000n;
    s.relayer.onSend = async (req) => {
      const raw = rawFor(req);
      const hash = keccakHex(raw);
      s.chain.receipts.set(hash, receiptFor(req, hash, 'executed', { gasUsed: 60_000n, price: 150_000_000n, l1Fee: 500n, operatorFee: 3_000_000_000_000n }));
      return { transactionHash: hash, relayerNonce: 0, raw, replay: false, digest: digestOf(req), broadcast: "accepted" as const, rejection: null };
    };
    expect((await send(s, signedSend(s.user, { chainId: OP_CHAIN }).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    expect(req.reservedWei).toBe(req.gas * 1_000_000_000n + 1_000n + 7_000_000_000_000n);
    const opRead = s.chain.calls.find((c) => c.method === 'call' && (c.args as { data: string }).data.startsWith('0x275aedd2'))!.args as { data: string };
    expect(BigInt(`0x${opRead.data.slice(10)}`)).toBe(req.gas);
    expect(await appSpent(s.app, OP_CHAIN)).toBe(9_000_000_000_000n + 500n + 3_000_000_000_000n);
    s.chain.operatorBoundWei = 'fail';
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 1n);
    const r = await send(s, signedSend(s.user, { chainId: OP_CHAIN, executeNonce: 1n }).body);
    expect([r.status, (await body(r)).code]).toEqual([502, 'evm_rpc_unavailable']);
  });
});

describe('L5: retention', () => {
  it('rows older than 24 months are pruned (bounded); newer ones stay', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    await env.DB.prepare('UPDATE evm_sponsor_sends SET created_at = 1, updated_at = 1').run();
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    expect((await send(s, signedSend(u2).body)).status).toBe(200);
    expect(await pruneEvmSponsorSends(env)).toBe(1);
    expect((await auditRows(s.user.address)).length).toBe(0);
    expect((await auditRows(u2.address)).length).toBe(1);
  });
});

describe('the relayer’s final interface (PR #70)', () => {
  it('a relayer digest that is not the handler’s: an internal error, the reservation kept (unknown)', async () => {
    const s = await setup();
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), digest: `0x${'99'.repeat(32)}` as Hex });
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([503, 'outcome_unknown']);
    expect((await auditRows(s.user.address))[0]?.status).toBe('unknown');
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
  });

  it('D869: a slot the relayer’s staff closed as used by something else is not charged: every budget and count given back, the record kept at 0, final', async () => {
    const s = await setup();
    receiptKind = 'none';
    const day = (sub: string, name: string) => hits(sub, name);
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    const row = await env.DB.prepare('SELECT user_id, account FROM evm_sponsor_sends').first<{ user_id: string | null; account: string }>();
    const reserved = s.relayer.sends[0]!.reservedWei;
    // While open: the budgets carry the reservation; the day counts and the failure slot are taken.
    expect(await appSpent(s.app)).toBe(reserved);
    expect(await envSpent()).toBe(reserved);
    const userSub = row!.user_id ? `evm-sponsor:user:${row!.user_id}` : null;
    const failureSub = row!.user_id ? `evm-sponsor:failures:${row!.user_id}` : `evm-sponsor:failures:${LOCAL_CHAIN}:${row!.account}`;
    const before = { app: await day(`app:${s.app.id}`, `evm-sponsor:${LOCAL_CHAIN}:day`), env: await day(`evm-sponsor:global:${LOCAL_CHAIN}`, 'evm-sponsor:day'), user: userSub ? await day(userSub, `evm-sponsor:${LOCAL_CHAIN}:day`) : 0, failures: await failuresSpent(failureSub) };
    expect([before.app, before.env, before.failures]).toEqual([1, 1, 1n]);
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: `0x${'aa'.repeat(32)}`, hashes: [], state: 'closed', minedHash: null, outcome: 'consumed_elsewhere', costWei: null, reservedWei: 1n });
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    // Not charged: both budgets back to nothing, the day counts and the failure slot given back.
    expect(await appSpent(s.app)).toBe(0n);
    expect(await envSpent()).toBe(0n);
    expect(await day(`app:${s.app.id}`, `evm-sponsor:${LOCAL_CHAIN}:day`)).toBe(0);
    expect(await day(`evm-sponsor:global:${LOCAL_CHAIN}`, 'evm-sponsor:day')).toBe(0);
    if (userSub) expect(await day(userSub, `evm-sponsor:${LOCAL_CHAIN}:day`)).toBe(0);
    expect(await failuresSpent(failureSub)).toBe(0n);
    // The row and the record are kept, marked: consumed elsewhere, settled 0, no cost figures for a billing job to add.
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'consumed_elsewhere', settled_wei: '0' });
    expect(await billingRows()).toMatchObject([{ outcome: 'consumed_elsewhere', tx_hash: null, settled_wei: '0', total_cost_wei: null, record_key: expect.stringMatching(/^send:es_/u) }]);
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_nonce_taken'").all<{ detail_json: string }>();
    expect(ev.results.map((e) => JSON.parse(e.detail_json))).toEqual([{ chainId: LOCAL_CHAIN, charged: false }]);
    // Final: a later reconcile, even with a receipt or a mined verdict for one of its hashes, can't charge it again.
    receiptKind = 'executed';
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: `0x${'aa'.repeat(32)}`, hashes: [`0x${'aa'.repeat(32)}`], state: 'mined', minedHash: `0x${'aa'.repeat(32)}`, outcome: 'execute', costWei: 5n, reservedWei: 1n });
    await ageRows(60 * 60_000);
    expect(await reconcile(s)).toMatchObject({ settled: 0, corrected: 0 });
    expect(await appSpent(s.app)).toBe(0n);
    expect(await billingRows()).toHaveLength(1);
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'consumed_elsewhere', settled_wei: '0' });
  });

  it('D869: a relayer replay row closed as consumed elsewhere gives nothing back twice (its first send carries the counts)', async () => {
    const s = await setup();
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    await env.DB.prepare('UPDATE evm_sponsor_sends SET replay = 1').run();
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: `0x${'aa'.repeat(32)}`, hashes: [], state: 'closed', minedHash: null, outcome: 'consumed_elsewhere', costWei: null, reservedWei: 1n });
    const reserved = s.relayer.sends[0]!.reservedWei;
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    expect(await appSpent(s.app)).toBe(reserved);
    expect(await billingRows()).toEqual([]);
  });

  it('a halted relayer: evm_relay_stuck (“Gas sponsorship: paused or slow, needs a look”), status answers paused, a send is 503 sponsorship_paused with everything back', async () => {
    const s = await setup();
    const halted = { reason: 'nonce_gap' as const, since: Date.now(), nonce: 3 };
    s.relayer.statusValue = { address: RELAYER, unmined: 0, awaitingConfirmation: 0, oldestUnminedMs: null, oldestUnacceptedMs: null, nextNonce: 3, halted };
    await checkEvmSponsorRelay(cronEnv(s));
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").all<{ detail_json: string }>();
    expect(JSON.parse(ev.results[0]!.detail_json)).toMatchObject({ chainId: LOCAL_CHAIN, halted: 'nonce_gap' });
    expect(await body(await status(s, '?chainId=31337'))).toMatchObject({ available: false, reason: 'paused' });
    s.relayer.onSend = async () => {
      throw new Error('evm_relayer:relayer_halted');
    };
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([503, 'sponsorship_paused']);
    expect(await appSpent(s.app)).toBe(0n);
    expect((await auditRows(s.user.address))[0]?.status).toBe('refused');
  });
});

describe('the second review: refunds only on a verified "nothing ran", and the row persisted before any give-back', () => {
  /** A send that got a hash and timed out, the relayer since forgotten it; `minutes` past the deadline for the run. */
  async function forgottenTimeout(): Promise<Setup & { deadlineMs: number }> {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(504);
    s.relayer.lookupOverride = async () => null;
    await ageRows();
    return { ...s, deadlineMs: Number(signed.body.deadline) * 1000 };
  }

  it('a row with a hash the relayer forgot is never refunded: clean empty reads and an untouched nonce still leave it lost, the reservation kept', async () => {
    const s = await forgottenTimeout();
    expect(await reconcile(s, s.deadlineMs + 3 * 60_000)).toMatchObject({ open: 1 });
    expect(await reconcile(s, s.deadlineMs + 61 * 60_000)).toMatchObject({ lost: 1 });
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(1n);
  });

  it('a user who re-delegates elsewhere and resets the nonce slot can’t turn a mined batch into a refund', async () => {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(504);
    // The batch was mined under a version this row never saw; the relayer then forgot the digest. The user points the
    // account at another contract and zeroes the delegate's nonce slot.
    s.relayer.lookupOverride = async () => null;
    s.chain.codes.set(s.user.address.toLowerCase(), `0xef0100${'66'.repeat(20)}` as Hex);
    s.chain.executeNonce.set(s.user.address.toLowerCase(), 0n);
    await ageRows();
    expect(await reconcile(s, Number(signed.body.deadline) * 1000 + 61 * 60_000)).toMatchObject({ lost: 1 });
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
  });

  it('a fee-bumped version the relayer reported while the request polled is found and settled after the relayer forgot the digest', async () => {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    const bumped = keccakHex(`0x02${'b0'.repeat(32)}` as Hex);
    // While the request polls, the relayer lists a replacement.
    s.relayer.lookupOverride = async (digest) => {
      const req = s.relayer.sends[0]!;
      return { digest, relayerNonce: 0, transactionHash: bumped, hashes: [keccakHex(rawFor(req)), bumped], state: 'pending', minedHash: null, outcome: null, costWei: null, reservedWei: req.reservedWei };
    };
    expect((await send(s, signed.body)).status).toBe(504);
    const row = await env.DB.prepare('SELECT tx_hashes FROM evm_sponsor_sends').first<{ tx_hashes: string }>();
    expect(JSON.parse(row!.tx_hashes)).toEqual([keccakHex(rawFor(s.relayer.sends[0]!)), bumped]);
    // Then the relayer forgets it, and the replacement turns out to be the one mined.
    s.relayer.lookupOverride = async () => null;
    s.chain.receipts.set(bumped, receiptFor(s.relayer.sends[0]!, bumped, 'executed'));
    await ageRows();
    expect(await reconcile(s, Number(signed.body.deadline) * 1000 + 30 * 60_000)).toMatchObject({ settled: 1 });
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'executed', tx_hash: bumped, settled_wei: '9000000000000' });
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
  });

  it('… and a receipt read that fails decides nothing, ever: open while reads fail, lost only once they succeed and find nothing (M3)', async () => {
    const s = await forgottenTimeout();
    s.chain.receiptDown = true;
    expect(await reconcile(s, s.deadlineMs + 3 * 60_000)).toMatchObject({ open: 1, lost: 0 });
    expect(await reconcile(s, s.deadlineMs + 61 * 60_000)).toMatchObject({ open: 1, lost: 0 });
    // A relayer that can't be asked decides nothing either.
    s.chain.receiptDown = false;
    sponsorPorts.relayer = () => ({ send: async () => Promise.reject(new Error('down')), status: async () => Promise.reject(new Error('down')), lookup: async () => Promise.reject(new Error('down')) });
    expect(await reconcile(s, s.deadlineMs + 62 * 60_000)).toMatchObject({ open: 1, lost: 0 });
    sponsorPorts.relayer = DEFAULT_SPONSOR_PORTS.relayer;
    expect(await reconcile(s, s.deadlineMs + 63 * 60_000)).toMatchObject({ lost: 1 });
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
  });

  it('a row without a hash: a lookup that fails is not "unknown to the relayer": no refund', async () => {
    const s = await setup();
    s.relayer.onSend = async () => {
      throw new Error('the object was reset');
    };
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(503);
    s.relayer.lookupOverride = async () => Promise.reject(new Error('unreachable'));
    await ageRows();
    expect(await reconcile(s, Number(signed.body.deadline) * 1000 + 3 * 60_000)).toMatchObject({ open: 1 });
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
  });

  it('the relayer reports one of the row’s own versions mined but its receipt can’t be read: settled from the relayer’s cost an hour past the deadline (bounded by the reservation)', async () => {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(504);
    const req = s.relayer.sends[0]!;
    const mined = keccakHex(rawFor(req));
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: mined, hashes: [mined], state: 'mined', minedHash: mined, outcome: 'execute', costWei: 8_000_000_000_000n, reservedWei: req.reservedWei });
    s.chain.receiptDown = true;
    await ageRows();
    const deadlineMs = Number(signed.body.deadline) * 1000;
    expect(await reconcile(s, deadlineMs + 3 * 60_000)).toMatchObject({ open: 1 });
    expect(await reconcile(s, deadlineMs + 61 * 60_000)).toMatchObject({ settled: 1 });
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'mined', settled_wei: '8000000000000' });
    expect(await appSpent(s.app)).toBe(8_000_000_000_000n);
    expect(await billingRows()).toMatchObject([{ outcome: 'mined', tx_hash: mined, total_cost_wei: '8000000000000', gas_used: null }]);
  });

  it('a lookup naming a mined hash that is not one of the row’s own is not used', async () => {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(504);
    const stranger = `0x${'5e'.repeat(32)}` as Hex;
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: stranger, hashes: [], state: 'mined', minedHash: stranger, outcome: 'execute', costWei: 1n, reservedWei: 1n });
    s.chain.receiptDown = true;
    await ageRows();
    expect(await reconcile(s, Number(signed.body.deadline) * 1000 + 61 * 60_000)).toMatchObject({ settled: 0 });
  });

  it('a replay: the row records replay before the give-back; a crash in between and a reconciler run never give back twice', async () => {
    const s = await setup();
    // Someone else's spend in the same app budget, which a second give-back would eat into.
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), replay: true });
    sponsorFaults.afterSentPersisted = async () => {
      throw new Error('the isolate died here');
    };
    const r = await send(s, signedSend(u2).body);
    expect(r.status).toBe(500);
    const reserved = s.relayer.sends[1]!.reservedWei;
    expect((await auditRows(u2.address))[0]).toMatchObject({ status: 'sent' });
    // The crash lost this copy's give-back (errs high); the reconciler sees replay = 1 and changes no budget.
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n + reserved);
    expect((await auditRows(u2.address))[0]).toMatchObject({ status: 'executed', settled_wei: '0' });
  });

  it('the reconciler never takes a live request’s `sending` row (younger than the request’s lifetime)', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = s.relayer.onSend;
    let reached!: () => void;
    const atRelayer = new Promise<void>((r) => (reached = r));
    s.relayer.onSend = async (req) => {
      reached();
      await gate;
      return inner(req);
    };
    const pending = send(s, signedSend(s.user).body);
    await atRelayer;
    // Two minutes on, the row is still `sending` and the request alive: untouched.
    expect(await reconcile(s, Date.now() + 2 * 60_000)).toMatchObject({ settled: 0, lost: 0, open: 0 });
    release();
    expect((await pending).status).toBe(200);
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
    // Six minutes on, a row left `sending` (a request that died) is the reconciler's.
    await env.DB.prepare("UPDATE evm_sponsor_sends SET status = 'sending', tx_hash = NULL, tx_hashes = '[]'").run();
    s.relayer.lookupOverride = async () => null;
    expect(await reconcile(s, Date.now() + 6 * 60_000)).toMatchObject({ open: 1 });
  });
});

describe('billing records (D852): one permanent record per sponsored transaction, no personal data', () => {
  it('an executed send leaves one record with the org, app, chain, hash, costs, calls, targets and setup; no address, user or IP; a copy writes nothing more', async () => {
    const s = await setup({}, { delegated: false });
    const signed = signedSend(s.user, { authNonce: 0n });
    const r = await send(s, signed.body);
    expect(r.status).toBe(200);
    const hash = (await body(r)).transactionHash as string;
    const [b, ...more] = await billingRows();
    expect(more).toEqual([]);
    const org = await env.DB.prepare('SELECT org_id FROM apps WHERE id = ?1').bind(s.app.id).first<{ org_id: string }>();
    expect(b).toMatchObject({
      chain_id: LOCAL_CHAIN,
      record_key: hash,
      org_id: org!.org_id,
      app_id: s.app.id,
      environment: 'local-test',
      tx_hash: hash,
      outcome: 'executed',
      gas_used: '60000',
      effective_gas_price_wei: '150000000',
      execution_wei: '9000000000000',
      l1_fee_wei: '0',
      operator_fee_wei: '0',
      total_cost_wei: '9000000000000',
      settled_wei: '9000000000000',
      call_count: 1,
      with_setup: 1,
      mirrored_at: null,
    });
    expect(JSON.parse(b!.targets_json as string)).toEqual([{ address: CHECK_IN.toLowerCase(), selector: '0x183ff085' }]);
    const text = JSON.stringify(b).toLowerCase();
    for (const personal of [s.user.address.toLowerCase(), s.userId.toLowerCase()]) expect(text.includes(personal), personal).toBe(false);
    // The same request again (a copy answered from the audit row): still one record.
    expect((await send(s, signed.body)).status).toBe(200);
    expect((await billingRows()).length).toBe(1);
  });

  it('reverted, not executed and the deadline’s cancel each leave a record; a relayer replay leaves none of its own', async () => {
    const s = await setup();
    receiptKind = 'reverted';
    expect((await send(s, signedSend(s.user).body)).status).toBe(422);
    receiptKind = 'not_executed';
    expect((await send(s, signedSend(s.user, { minGas: 100_001n }).body)).status).toBe(422);
    expect((await billingRows()).map((b) => b.outcome).sort()).toEqual(['not_executed', 'reverted']);
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    receiptKind = 'executed';
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), replay: true });
    expect((await send(s, signedSend(u2).body)).status).toBe(200);
    expect((await billingRows()).length).toBe(2);
  });

  it('records survive the user’s erasure and the audit rows’ 24-month retention', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    await env.DB.prepare('DELETE FROM end_user_wallets WHERE user_id = ?1').bind(s.userId).run();
    await env.DB.prepare('DELETE FROM end_users WHERE user_id = ?1').bind(s.userId).run();
    expect((await auditRows(s.user.address)).length).toBe(0);
    expect((await billingRows()).length).toBe(1);
    await env.DB.prepare('UPDATE evm_sponsor_billing SET created_at = 1, settled_at = 1').run();
    expect(await pruneEvmSponsorSends(env)).toBe(0);
    expect((await billingRows()).length).toBe(1);
  });

  it('the cron copies records to the usage ledger once, retries while it is down, and nothing is lost without it', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    ledgerDown = true;
    expect(await mirrorEvmBilling(cronEnv(s))).toBe(0);
    expect((await billingRows())[0]!.mirrored_at).toBeNull();
    ledgerDown = false;
    expect(await mirrorEvmBilling(cronEnv(s))).toBe(1);
    expect(ledgerCalls.map((c) => c.sql)).toEqual([RECORD_EVM_SPONSORED_SQL]);
    expect(ledgerCalls[0]!.rows[0]).toMatchObject({ chain_id: LOCAL_CHAIN, outcome: 'executed', settled_wei: '9000000000000', with_setup: false, targets: [{ address: CHECK_IN.toLowerCase(), selector: '0x183ff085' }] });
    expect(Object.keys(ledgerCalls[0]!.rows[0]!).sort()).toEqual(['app_id', 'block_number', 'block_time', 'call_count', 'chain_id', 'created_at', 'effective_gas_price_wei', 'environment', 'execution_wei', 'gas_used', 'l1_fee_wei', 'operator_fee_wei', 'org_id', 'outcome', 'record_key', 'settled_at', 'settled_wei', 'targets', 'total_cost_wei', 'tx_hash', 'with_setup']);
    expect((await billingRows())[0]!.mirrored_at).not.toBeNull();
    expect(await mirrorEvmBilling(cronEnv(s))).toBe(0);
    // Without the ledger binding: nothing is sent, the record waits in D1.
    const u2 = testUser();
    await rememberAccount(s.app.scope, u2.address);
    s.chain.codes.set(u2.address.toLowerCase(), DESIGNATOR);
    expect((await send(s, signedSend(u2).body)).status).toBe(200);
    expect(await mirrorEvmBilling({ ...cronEnv(s), USAGE_DB: undefined } as typeof env)).toBe(0);
    expect((await billingRows()).filter((b) => b.mirrored_at === null).length).toBe(1);
  });

  it('a settled send without its record, or a record the ledger hasn’t had for an hour, raises evm_billing_late', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    ledgerDown = true;
    await env.DB.prepare('UPDATE evm_sponsor_billing SET settled_at = settled_at - ?1').bind(BILLING_LATE_MS + 1).run();
    await checkEvmSponsorRelay(cronEnv(s));
    const late = async () => (await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_billing_late'").all<{ detail_json: string }>()).results.map((r) => JSON.parse(r.detail_json) as Record<string, number>);
    expect(await late()).toEqual([{ missing: 0, unmirrored: 1, quarantined: 0 }]);
    await env.DB.exec("DELETE FROM security_events WHERE kind = 'evm_billing_late'");
    await env.DB.exec('DELETE FROM evm_sponsor_billing');
    await env.DB.prepare('UPDATE evm_sponsor_sends SET updated_at = updated_at - ?1, created_at = created_at - ?1').bind(BILLING_LATE_MS + 1).run();
    await checkEvmSponsorRelay(cronEnv(s));
    expect(await late()).toEqual([{ missing: 1, unmirrored: 0, quarantined: 0 }]);
  });
});

// ---- the session proof (D856), before any window, replay check, directory read or chain read ----

describe('the session proof of prepare and send (D856)', () => {
  const prepBody = (s: Setup) => ({ chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] });
  /** Nothing counted and nothing read: no EVM read, no relayer send, no account window. */
  const untouched = async (s: Setup) => {
    expect(s.chain.calls).toEqual([]);
    expect(s.relayer.sends).toEqual([]);
    expect(await hits(`evm-sponsor:account:${LOCAL_CHAIN}:${s.user.address.toLowerCase()}`, 'evm-sponsor:send:minute', 60_000)).toBe(0);
    expect(await hits(`evm-sponsor:account:${LOCAL_CHAIN}:${s.user.address.toLowerCase()}`, 'evm-sponsor:prepare:minute', 60_000)).toBe(0);
  };
  const routes = [
    ['prepare', PREPARE, (s: Setup) => prepBody(s)],
    ['send', SEND, (s: Setup) => signedSend(s.user).body],
  ] as const;

  for (const [method, path, make] of routes) {
    describe(method, () => {
      const go = (s: Setup, b: unknown, o: { proof?: false; headers?: Record<string, string> } = {}) => sponsorCall(path, s.app, s.bindings, { body: b, ...o });
      const code = async (r: Response) => [r.status, (await body(r)).code];

      it('with a valid proof it passes; without one: 401 missing_session_proof; a malformed one: 400 bad_session_proof', async () => {
        const s = await setup();
        expect((await go(s, make(s))).status).toBe(method === 'prepare' ? 200 : 200);
        const t = await setup();
        expect(await code(await go(t, make(t), { proof: false }))).toEqual([401, 'missing_session_proof']);
        const proof = (await import('./evm-sponsor-helpers.ts')).sessionProof(t.app, make(t), method);
        for (const bad of [{ ...proof, extra: 1 }, { ...proof, nonce: [1, 2, 3] }, { ...proof, walletProof: { ...proof.walletProof, signature: [1] } }, 'proof', null]) {
          expect(await code(await go(t, { ...make(t), sessionProof: bad }))).toEqual([400, 'bad_session_proof']);
        }
        await untouched(t);
      });

      it('a stale or future proof: 400 stale_session_proof with serverTimeMs (±60 s)', async () => {
        const s = await setup();
        // The clock held still: on the running clock the future proof (61 s ahead when made) was within the window
        // again once the stale case's request took more than a second, as it can under verify's load.
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        for (const issuedAtMs of [now - 61_000, now + 61_000]) {
          const r = await go(s, withProof(s.app, make(s), method, { issuedAtMs }));
          const b = await body(r);
          expect([r.status, b.code]).toEqual([400, 'stale_session_proof']);
          expect(b.serverTimeMs).toBe(now);
        }
        await untouched(s);
      });

      it('signed by another key, for another app, origin, route or body: 401 invalid_session_signature', async () => {
        const s = await setup();
        const other = sessionFor(s.app.scope, testUser().address);
        const b = make(s);
        const variants: [string, Record<string, unknown>][] = [
          ['another session key signed it', withProof(s.app, b, method, { signWith: other.spk })],
          ['for another app', withProof(s.app, b, method, { appId: 'app_someone_else' })],
          ['for another partner origin', withProof(s.app, b, method, { parentOrigin: 'https://other.example.com' })],
          ['for the other route', withProof(s.app, b, method, method === 'prepare' ? { method: 'send', signedBody: signedSend(s.user).body } : { method: 'prepare', signedBody: prepBody(s) })],
          ['for another chain', { ...withProof(s.app, { ...b, chainId: 1 }, method), chainId: LOCAL_CHAIN }],
          ['for other calls', { ...withProof(s.app, { ...b, calls: [{ to: TOKEN, value: '0', data: transferData(RELAYER, 1n) }] }, method), calls: b.calls }],
        ];
        for (const [what, sent] of variants) {
          const r = await go(s, sent);
          const got = await code(r);
          expect(got, what).toEqual([401, 'invalid_session_signature']);
        }
        await untouched(s);
      });

      it('a proof for prepare reused on send (and the reverse) is refused', async () => {
        const s = await setup();
        const sendBody = signedSend(s.user).body;
        const p = withProof(s.app, prepBody(s), 'prepare');
        expect(await code(await sponsorCall(SEND, s.app, s.bindings, { body: { ...sendBody, sessionProof: p.sessionProof } }))).toEqual([401, 'invalid_session_signature']);
        const sp = withProof(s.app, sendBody, 'send');
        expect(await code(await sponsorCall(PREPARE, s.app, s.bindings, { body: { ...prepBody(s), sessionProof: sp.sessionProof } }))).toEqual([401, 'invalid_session_signature']);
        await untouched(s);
      });

      it('a wallet proof not the account’s (another key, another session or app): 400 bad_wallet_proof', async () => {
        const s = await setup();
        const mallory = testUser();
        const b = make(s);
        expect(await code(await go(s, withProof(s.app, b, method, { walletAddress: mallory.address })))).toEqual([400, 'bad_wallet_proof']);
        expect(await code(await go(s, withProof(s.app, b, method, { walletKey: mallory.key })))).toEqual([400, 'bad_wallet_proof']);
        await untouched(s);
      });

      it('a replayed proof: 409 proof_replayed, the marker kept for the whole window', async () => {
        const s = await setup();
        const sent = withProof(s.app, make(s), method);
        const first = await go(s, sent);
        expect(first.status).toBeLessThan(500);
        const before = s.chain.calls.length;
        expect(await code(await go(s, sent))).toEqual([409, 'proof_replayed']);
        expect(s.chain.calls.length).toBe(before);
      });

      it('the session: not visible on chain 503 session_not_visible; expired 410 session_ended; another scope 403 scope_mismatch', async () => {
        const s = await setup();
        const { nearMock } = await import('./evm-sponsor-helpers.ts');
        const near = nearMock();
        const mine = sessionFor(s.app.scope, s.user.address);
        const key = JSON.stringify(mine.spk);
        const live = near.sessions.get(key)!;
        near.sessions.delete(key);
        const missing = await go(s, make(s));
        expect([missing.status, (await body(missing)).code, missing.headers.get('retry-after')]).toEqual([503, 'session_not_visible', '1']);
        near.sessions.set(key, { ...live, expires_at_ms: Date.now() - 1 });
        expect(await code(await go(s, make(s)))).toEqual([410, 'session_ended']);
        near.sessions.set(key, { ...live, scope_id: 'scope_elsewhere', path: `scope_elsewhere#google#${mine.sub}#0` });
        expect(await code(await go(s, make(s)))).toEqual([403, 'scope_mismatch']);
        await untouched(s);
      });

      it('in `session` mode the share must be live: none for this session 410 session_ended', async () => {
        const s = await setup();
        await (await import('./vault-helpers.ts')).setSettings(s.app.id, { persistence: 'session' });
        const r = await go(s, make(s));
        expect([r.status, (await body(r)).code]).toEqual([410, 'session_ended']);
        await untouched(s);
      });

      it('requireKnownAccount: the account’s directory user must be the session’s own (403 account_mismatch); none yet 409 account_unrecorded', async () => {
        const s = await setup({}, { known: false });
        expect(await code(await go(s, make(s)))).toEqual([409, 'account_unrecorded']);
        // Recorded for another user of the scope: this session can't act for it.
        await rememberAccount(s.app.scope, s.user.address, `hu_${Array.from({ length: 26 }, () => '0123456789abcdefghjkmnpqrstvwxyz'[Math.floor(Math.random() * 32)]).join('')}`);
        expect(await code(await go(s, make(s)))).toEqual([403, 'account_mismatch']);
        await untouched(s);
      });

      it('refuses a body that repeats a key (L6: the text a reader sees is the object acted on): 400, nothing read', async () => {
        const s = await setup();
        const proofed = withProof(s.app, make(s), method);
        // The raw text repeats `account` first with a stranger's address (JSON.parse would keep the last), or a call's `to`.
        for (const text of [JSON.stringify(proofed).replace('{', `{"account":"${testUser().address}",`), JSON.stringify(proofed).replace('"calls":[{', '"calls":[{"to":"0x00",')]) {
          const r = await call(path, { headers: vaultHeaders(s.app), rawBody: text, env: s.bindings });
          expect([r.status, (await body(r)).code]).toEqual([400, 'bad_request']);
        }
        // An escaped copy of a key is the same key.
        const escaped = JSON.stringify(proofed).replace('{', '{"\\u0061ccount":"x",');
        expect((await call(path, { headers: vaultHeaders(s.app), rawBody: escaped, env: s.bindings })).status).toBe(400);
        await untouched(s);
        expect((await go(s, make(s))).status).toBe(200);
      });
    });
  }

  it('without requireKnownAccount (local envs only) the wallet proof alone ties the account to the session', async () => {
    const s = await setup({ requireKnownAccount: false }, { known: false });
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
  });
});

// ---- the relayer's verdicts the handlers must act on (its reviews' list) ----

describe('a batch no node took (broadcast: rejected)', () => {
  const rejecting = (s: Setup, cause: string, code: string) => {
    const inner = fakeRelayer(s.chain, () => 'none').onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), broadcast: 'rejected', rejection: { cause, code } as never });
  };
  /** The relayer's lookup once the cancel at the batch's nonce is mined: outcome cancel, its cost. */
  const cancelMined = (s: Setup, costWei: bigint) => {
    s.relayer.lookupOverride = async (digest) => {
      const req = s.relayer.sends.find((x) => digestOf(x) === digest)!;
      const batch = keccakHex(rawFor(req));
      const cancel = keccakHex(rawFor(req, 'cancel'));
      return { digest, relayerNonce: 0, transactionHash: cancel, hashes: [batch, cancel], state: 'mined', minedHash: cancel, outcome: 'cancel', costWei, reservedWei: req.reservedWei };
    };
  };
  const attempts = (s: Setup) => hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:attempts`);
  const appMinute = (s: Setup) => hits(`app:${s.app.id}`, `evm-sponsor:${LOCAL_CHAIN}:minute`, 60_000);

  /** Every count a send takes: the user's, the app's and the env's day, the user's attempts, the failure slot. */
  const counts = async (s: Setup) => ({
    userDay: await hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:day`),
    appDay: await hits(`app:${s.app.id}`, `evm-sponsor:${LOCAL_CHAIN}:day`),
    envDay: await hits(`evm-sponsor:global:${LOCAL_CHAIN}`, 'evm-sponsor:day'),
    attempts: await attempts(s),
    failures: await failuresSpent(`evm-sponsor:failures:${s.userId}`),
  });
  const closedElsewhere = (s: Setup) => {
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: `0x${'aa'.repeat(32)}`, hashes: [], state: 'closed', minedHash: null, outcome: 'consumed_elsewhere', costWei: null, reservedWei: 1n });
  };

  for (const [cause, code] of [['relayer', 'insufficient_funds'], ['pricing', 'underpriced'], ['request', 'gas_limit']] as const) {
    it(`D869: a rejected batch (cause ${cause}) later closed as used elsewhere: its money comes back, its counts are not returned a second time`, async () => {
      const s = await setup();
      // Another action of the same user and app earlier today: a second give-back would eat into its counts.
      const rl = (sub: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(sub));
      await rl(`evm-sponsor:user:${s.userId}`).hit([{ name: `evm-sponsor:${LOCAL_CHAIN}:day`, windowMs: 86_400_000, max: 100 }, { name: `evm-sponsor:${LOCAL_CHAIN}:attempts`, windowMs: 86_400_000, max: 100 }]);
      await rl(`app:${s.app.id}`).hit([{ name: `evm-sponsor:${LOCAL_CHAIN}:day`, windowMs: 86_400_000, max: 100 }]);
      await rl(`evm-sponsor:global:${LOCAL_CHAIN}`).hit([{ name: 'evm-sponsor:day', windowMs: 86_400_000, max: 100 }]);
      await rl(`evm-sponsor:failures:${s.userId}`).spend('evm-sponsor:failures', 86_400_000, '10', '1');
      rejecting(s, cause, code);
      await send(s, signedSend(s.user).body);
      expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'rejected' });
      // What the rejection itself settled (given back for a cause not the user's; kept for the user's own).
      const afterRejection = await counts(s);
      expect(await appSpent(s.app)).toBeGreaterThan(0n);
      closedElsewhere(s);
      await ageRows();
      expect(await reconcile(s)).toMatchObject({ settled: 1 });
      expect(await counts(s)).toEqual(afterRejection);
      expect(await appSpent(s.app)).toBe(0n);
      expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'consumed_elsewhere', settled_wei: '0' });
      await ageRows(60 * 60_000);
      await reconcile(s);
      expect(await counts(s)).toEqual(afterRejection);
    });
  }

  it('D869: two settlements of one row at once: one moves it, the counts and the money come back exactly once', async () => {
    const s = await setup();
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    const open = await counts(s);
    expect(open).toMatchObject({ userDay: 1, appDay: 1, envDay: 1, failures: 1n });
    const c = await env.DB.prepare('SELECT * FROM evm_sponsor_sends WHERE account = ?1').bind(s.user.address).first<Record<string, unknown>>();
    const row: SendRow = { id: String(c!.id), appId: String(c!.app_id), chainId: Number(c!.chain_id), account: c!.account as Hex, userId: (c!.user_id as string) ?? null, digest: c!.digest as Hex, executeNonce: BigInt(String(c!.execute_nonce)), txHash: null, hashes: [], deadline: Number(c!.deadline), reserved: { gasLimit: 0n, feeCap: 0n, l1Bound: 0n, operatorBound: 0n, reservedWei: BigInt(String(c!.reserved_wei)) }, replay: false, createdAt: Number(c!.created_at) };
    const both = await Promise.all([settleNotCharged(cronEnv(s), row, 'timeout'), settleNotCharged(cronEnv(s), row, 'timeout')]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await counts(s)).toEqual({ userDay: 0, appDay: 0, envDay: 0, attempts: open.attempts - 1, failures: 0n });
    expect(await appSpent(s.app)).toBe(0n);
    // A third, later attempt (the reconciler again, or a status read before the move): nothing moves, nothing comes back.
    expect(await settleNotCharged(cronEnv(s), row, 'timeout')).toBe(false);
    expect(await settleNotCharged(cronEnv(s), row, 'consumed_elsewhere')).toBe(false);
    expect(await counts(s)).toEqual({ userDay: 0, appDay: 0, envDay: 0, attempts: open.attempts - 1, failures: 0n });
  });

  it('cause request (the batch’s own size or shape): answered at once 422 not_executed, a failure charged; the cancel’s cost settles from the relayer’s lookup', async () => {
    const s = await setup();
    rejecting(s, 'request', 'oversized');
    sponsorTiming.receiptWaitMs = 30_000;
    const t0 = Date.now();
    const r = await send(s, signedSend(s.user).body);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect([r.status, (await body(r)).code]).toEqual([422, 'not_executed']);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(1n);
    expect(await attempts(s)).toBe(1);
    const req = s.relayer.sends[0]!;
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'rejected' });
    expect(await appSpent(s.app)).toBe(req.reservedWei);
    // The cancel mined: the money settles to its cost, the record says cancelled.
    cancelMined(s, 21_000n * 1_000_000n);
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'not_executed', settled_wei: String(21_000n * 1_000_000n) });
    expect(await billingRows()).toMatchObject([{ outcome: 'cancelled', settled_wei: String(21_000n * 1_000_000n) }]);
    expect(await appSpent(s.app)).toBe(21_000n * 1_000_000n);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(1n);
    // A copy is answered the same from the row, the relayer not asked again.
    expect((await body(await send(s, { ...signedSend(s.user).body }))).code).toBeDefined();
  });

  it('cause request with code gas_limit (the gas Journear itself set, D847): 503 relayer_unavailable in neutral words, nothing charged to the user, evm_relay_stuck with gasModel raised; a copy the same', async () => {
    const s = await setup();
    await env.DB.exec("DELETE FROM security_events WHERE kind LIKE 'evm_relay_%'");
    rejecting(s, 'request', 'gas_limit');
    const signed = signedSend(s.user);
    const r = await send(s, signed.body);
    const b = await body(r);
    expect([r.status, b.code, b.retryAfterS]).toEqual([503, 'relayer_unavailable', 60]);
    expect(String(b.error)).not.toMatch(/refused|batch|request/iu);
    // Not the user's doing: their failure slot, their attempts and the shared windows come back.
    expect(await counts(s)).toEqual({ userDay: 0, appDay: 0, envDay: 0, attempts: 0, failures: 0n });
    expect(await appMinute(s)).toBe(0);
    // Staff see a gas-model problem: the hour's evm_relay_stuck says so.
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").all<{ detail_json: string }>();
    expect(ev.results.map((e) => JSON.parse(e.detail_json))).toEqual([{ chainId: LOCAL_CHAIN, rejected: 'gas_limit', gasModel: true }]);
    // The row keeps the relayer's own words; the money waits for the cancel, as for any rejected batch.
    expect(await env.DB.prepare('SELECT status, rejection FROM evm_sponsor_sends WHERE account = ?1').bind(s.user.address).first()).toEqual({ status: 'rejected', rejection: 'request:gas_limit' });
    expect(await appSpent(s.app)).toBe(s.relayer.sends[0]!.reservedWei);
    // A copy is answered the same from the row, the relayer not asked again.
    const again = await send(s, signed.body);
    expect([again.status, (await body(again)).code]).toEqual([503, 'relayer_unavailable']);
    expect(s.relayer.sends).toHaveLength(1);
  });

  it('cause relayer (our side), and any cause not known yet: 503 sponsorship_paused, nothing charged to the user, evm_relay_stuck raised', async () => {
    for (const cause of ['relayer', 'something_new']) {
      const s = await setup();
      await env.DB.exec("DELETE FROM security_events WHERE kind LIKE 'evm_relay_%'");
      rejecting(s, cause, 'insufficient_funds');
      const r = await send(s, signedSend(s.user).body);
      expect([r.status, (await body(r)).code], cause).toEqual([503, 'sponsorship_paused']);
      expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`), cause).toBe(0n);
      expect(await attempts(s), cause).toBe(0);
      expect(await appMinute(s), cause).toBe(0);
      const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").all<{ detail_json: string }>();
      expect(JSON.parse(ev.results[0]!.detail_json), cause).toMatchObject({ chainId: LOCAL_CHAIN, rejected: 'insufficient_funds' });
      // The money waits for the cancel's cost (the reservation stays until the relayer reports it).
      expect(await appSpent(s.app), cause).toBe(s.relayer.sends[0]!.reservedWei);
      expect((await auditRows(s.user.address))[0]?.status).toBe('rejected');
    }
  });

  it('cause pricing (turned away over its fees, the relayer’s follow-up): 503 gas_price_too_high with a short retry, nothing charged, no alert', async () => {
    const s = await setup();
    rejecting(s, 'pricing', 'underpriced');
    const r = await send(s, signedSend(s.user).body);
    const b = await body(r);
    expect([r.status, b.code, b.retryAfterS]).toEqual([503, 'gas_price_too_high', 15]);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(0n);
    expect(await attempts(s)).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'evm_relay_stuck'").first<{ n: number }>())?.n).toBe(0);
  });

  it('a malformed rejection is read as the relayer’s (no charge to the user)', async () => {
    const s = await setup();
    const inner = fakeRelayer(s.chain, () => 'none').onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), broadcast: 'rejected', rejection: { cause: 'Not A Word!', code: 7 } as never });
    expect((await body(await send(s, signedSend(s.user).body))).code).toBe('sponsorship_paused');
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(0n);
  });
});

describe('the relayer’s balance covers the worst case (×3) before anything is sent', () => {
  it('short: 503 sponsorship_paused, evm_relay_balance_low raised, the user’s attempts back, nothing reserved or sent; prepare says paused', async () => {
    const s = await setup();
    const { forgetRelayerBalances } = await import('../src/evm/sponsor.ts');
    forgetRelayerBalances();
    s.chain.balanceWei = 1n;
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([503, 'sponsorship_paused']);
    expect(s.relayer.sends).toEqual([]);
    expect(await appSpent(s.app)).toBe(0n);
    expect(await hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:attempts`)).toBe(0);
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_balance_low'").first<{ detail_json: string }>();
    expect(JSON.parse(ev!.detail_json)).toMatchObject({ chainId: LOCAL_CHAIN, balanceWei: '1' });
    expect(JSON.parse(ev!.detail_json).neededWei).toMatch(/^[1-9][0-9]*$/u);
    const p = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect([p.allowed, p.reason]).toEqual([false, 'paused']);
    // Funded again: once the cached figure is gone (30 s), sends go through.
    s.chain.balanceWei = 10n ** 18n;
    forgetRelayerBalances();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
  });

  it('is cached a few seconds per chain and forgotten after each send', async () => {
    const s = await setup();
    const { forgetRelayerBalances } = await import('../src/evm/sponsor.ts');
    forgetRelayerBalances();
    const p = { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] };
    expect((await prepare(s, p)).status).toBe(200);
    expect((await prepare(s, p)).status).toBe(200);
    expect(reads(s.chain).filter((m) => m === 'balance').length).toBe(1);
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    expect((await prepare(s, p)).status).toBe(200);
    // One read for the prepares, the send's from the cache, then a fresh one after the send.
    expect(reads(s.chain).filter((m) => m === 'balance').length).toBe(2);
  });

  it('covers every send already committed: of 4 at once with funds for about 2½, exactly 2 reach the relayer, the rest are paused, one alert', async () => {
    const s = await setup({ lowBalanceEth: 0.000001 });
    const { forgetRelayerBalances } = await import('../src/evm/sponsor.ts');
    forgetRelayerBalances();
    receiptKind = 'none';
    const users = [s.user, testUser(), testUser(), testUser()];
    for (const u of users.slice(1)) {
      await rememberAccount(s.app.scope, u.address);
      s.chain.codes.set(u.address.toLowerCase(), DESIGNATOR);
    }
    const signed = users.map((u) => signedSend(u));
    const gas = sponsorGasLimit({ calldata: encodeExecuteCalldata(signed[0]!.input, signed[0]!.body.signature as Hex), callData: [CHECK_IN_DATA], minGas: 100_000n, authorizations: 0 });
    const worst = gas * 1_000_000_000n;
    s.chain.balanceWei = (EVM_SPONSOR_LIMITS.balanceMargin * worst * 5n) / 2n;
    const answers = await Promise.all(signed.map(async (x) => body(await send(s, x.body))));
    expect(answers.filter((b) => b.code === 'timeout').length).toBe(2);
    expect(answers.filter((b) => b.code === 'sponsorship_paused').length).toBe(2);
    expect(s.relayer.sends.length).toBe(2);
    const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'evm_relay_balance_low'").first<{ n: number }>();
    expect(ev?.n).toBe(1);
    // The two refused gave everything back: only the two sent hold a reservation.
    const sentRows = (await env.DB.prepare("SELECT reserved_wei FROM evm_sponsor_sends WHERE app_id = ?1 AND status IN ('sent', 'timeout')").bind(s.app.id).all<{ reserved_wei: string }>()).results;
    expect(await appSpent(s.app)).toBe(sentRows.reduce((n, r) => n + BigInt(r.reserved_wei), 0n));
  });

  it('a balance below lowBalanceEth refuses whatever the send costs', async () => {
    const s = await setup();
    const { forgetRelayerBalances } = await import('../src/evm/sponsor.ts');
    forgetRelayerBalances();
    s.chain.balanceWei = 5n * 10n ** 16n - 1n;
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([503, 'sponsorship_paused']);
    expect(s.relayer.sends).toEqual([]);
  });
});

describe('an app’s sends in flight (at most 4 of the relayer’s 8 unmined)', () => {
  it('a fifth while four are unconfirmed: 429 relayer_busy, retry in 5 s; a settled one frees its slot', async () => {
    const s = await setup();
    receiptKind = 'none';
    const users = [s.user, testUser(), testUser(), testUser(), testUser()];
    for (const u of users.slice(1)) {
      await rememberAccount(s.app.scope, u.address);
      s.chain.codes.set(u.address.toLowerCase(), DESIGNATOR);
    }
    for (const u of users.slice(0, 4)) expect((await send(s, signedSend(u).body)).status).toBe(504);
    const r = await send(s, signedSend(users[4]!).body);
    const b = await body(r);
    expect([r.status, b.code, b.retryAfterS]).toEqual([429, 'relayer_busy', 5]);
    expect(s.relayer.sends.length).toBe(4);
    // One of them lands: its settlement gives the slot back.
    const req = s.relayer.sends[0]!;
    const hash = keccakHex(rawFor(req));
    s.chain.receipts.set(hash, receiptFor(req, hash, 'executed'));
    await ageRows();
    await reconcile(s);
    receiptKind = 'executed';
    expect((await send(s, signedSend(users[4]!).body)).status).toBe(200);
  });

  it('the relayer’s own busy refusals are 429 with a short retry (its unmined cap 2 s, one unmined batch per account 5 s)', async () => {
    const s = await setup();
    s.relayer.onSend = async () => {
      throw new Error('evm_relayer:relayer_busy:account');
    };
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).retryAfterS, r.headers.get('retry-after')]).toEqual([429, 5, '5']);
  });
});

describe('the one-time setup’s authorization is attached only when nothing of the account’s own is in flight', () => {
  it('pending above latest (a transaction of the account in the pool): 409 authorization_nonce_stale; equal and the nonce: sent', async () => {
    const s = await setup({}, { delegated: false });
    const a = s.user.address.toLowerCase();
    s.chain.pending.set(a, 3n);
    s.chain.latest.set(a, 2n);
    const r = await send(s, signedSend(s.user, { authNonce: 3n }).body);
    expect([r.status, (await body(r)).code]).toEqual([409, 'authorization_nonce_stale']);
    expect(s.relayer.sends).toEqual([]);
    s.chain.latest.set(a, 3n);
    expect((await send(s, signedSend(s.user, { authNonce: 3n }).body)).status).toBe(200);
    expect(s.relayer.sends[0]!.authorization).toMatchObject({ nonce: 3n });
  });

  it('an account already delegated to the pinned delegate: the authorization is left off (a type-2 send)', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user, { authNonce: 0n }).body)).status).toBe(200);
    expect(s.relayer.sends[0]!.authorization).toBeUndefined();
  });
});

describe('the relayer halted or slow (cron and prepare)', () => {
  it('a halt with its refusal code is raised with it; prepare answers paused; an unmined transaction under 2 minutes raises nothing', async () => {
    const s = await setup();
    s.relayer.statusValue = { address: RELAYER, unmined: 1, awaitingConfirmation: 0, oldestUnminedMs: 90_000, oldestUnacceptedMs: null, nextNonce: 3, halted: null };
    await checkEvmSponsorRelay(cronEnv(s));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'evm_relay_stuck'").first<{ n: number }>())?.n).toBe(0);
    s.relayer.statusValue = { ...s.relayer.statusValue, halted: { reason: 'relayer_cannot_send', since: Date.now(), nonce: 2, code: 'insufficient_funds' } };
    await checkEvmSponsorRelay(cronEnv(s));
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").first<{ detail_json: string }>();
    expect(JSON.parse(ev!.detail_json)).toMatchObject({ halted: 'relayer_cannot_send', haltCode: 'insufficient_funds' });
    const p = await body(await prepare(s, { chainId: LOCAL_CHAIN, account: s.user.address, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] }));
    expect([p.allowed, p.reason]).toEqual([false, 'paused']);
  });
});

// ---- the re-review of a0a83e25 (M1–M3, L1–L7) ----

describe('M1: nothing taken can leak', () => {
  it('the whole send runs inside waitUntil from before the first count: registered before any chain read', async () => {
    const s = await setup();
    const at: number[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void (at.push(s.chain.calls.length), p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const res = await call(SEND, { headers: vaultHeaders(s.app), body: withProof(s.app, signedSend(s.user).body, 'send'), env: s.bindings, exec });
    expect(res.status).toBe(200);
    expect(at[0]).toBe(0);
  });

  it('the app’s share is counted from its open rows, atomically at the insert: of 6 at once with room for 4, exactly 4 reach the relayer', async () => {
    const s = await setup();
    receiptKind = 'none';
    const users = [s.user, ...Array.from({ length: 5 }, () => testUser())];
    for (const u of users.slice(1)) {
      await rememberAccount(s.app.scope, u.address);
      s.chain.codes.set(u.address.toLowerCase(), DESIGNATOR);
    }
    const answers = await Promise.all(users.map(async (u) => body(await send(s, signedSend(u).body))));
    expect(answers.filter((b) => b.code === 'timeout').length).toBe(4);
    expect(answers.filter((b) => b.code === 'relayer_busy').length).toBe(2);
    expect(s.relayer.sends.length).toBe(4);
    // The two refused took nothing: only the four sent hold a reservation.
    const held = (await env.DB.prepare("SELECT reserved_wei FROM evm_sponsor_sends WHERE app_id = ?1 AND status = 'timeout'").bind(s.app.id).all<{ reserved_wei: string }>()).results;
    expect(await appSpent(s.app)).toBe(held.reduce((n, r) => n + BigInt(r.reserved_wei), 0n));
  });
});

describe('M2: a full share settles its own open rows inline', () => {
  it('four sends whose receipts came after the wait: the fifth settles them first (no cron) and goes through', async () => {
    const s = await setup();
    receiptKind = 'none';
    const users = [s.user, testUser(), testUser(), testUser(), testUser()];
    for (const u of users.slice(1)) {
      await rememberAccount(s.app.scope, u.address);
      s.chain.codes.set(u.address.toLowerCase(), DESIGNATOR);
    }
    for (const u of users.slice(0, 4)) expect((await send(s, signedSend(u).body)).status).toBe(504);
    for (const req of s.relayer.sends) {
      const hash = keccakHex(rawFor(req));
      s.chain.receipts.set(hash, receiptFor(req, hash, 'executed'));
    }
    receiptKind = 'executed';
    expect((await send(s, signedSend(users[4]!).body)).status).toBe(200);
    expect((await auditRows(s.user.address))[0]?.status).toBe('executed');
  });
});

describe('L1: a digest with two rows is charged once', () => {
  it('a first attempt answered unknown, then the real send: the first becomes a zero duplicate, the budget charged once, no late alert', async () => {
    const s = await setup();
    const signed = signedSend(s.user);
    const inner = s.relayer.onSend;
    s.relayer.onSend = async () => {
      throw new Error('the object was reset');
    };
    expect((await body(await send(s, signed.body))).code).toBe('outcome_unknown');
    s.relayer.onSend = inner;
    expect((await send(s, signed.body)).status).toBe(200);
    await ageRows();
    await reconcile(s);
    const statuses = (await auditRows(s.user.address)).map((r) => r.status).sort();
    expect(statuses).toEqual(['duplicate', 'executed']);
    expect(await appSpent(s.app)).toBe(9_000_000_000_000n);
    expect((await billingRows()).length).toBe(1);
    await env.DB.prepare('UPDATE evm_sponsor_billing SET settled_at = settled_at - ?1').bind(BILLING_LATE_MS + 1).run();
    await checkEvmSponsorRelay(cronEnv(s));
    const late = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_billing_late'").first<{ detail_json: string }>();
    expect(late === null || JSON.parse(late.detail_json).missing === 0).toBe(true);
  });
});

describe('L2: the nonce floor and the outcome follow the relayer’s verdict at confirmed depth', () => {
  const floorOf = (s: Setup) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`evm-sponsor:account:${LOCAL_CHAIN}:${s.user.address.toLowerCase()}`)).floor('evm-sponsor:nonce');

  it('a head receipt answers 200 but raises no floor; the relayer’s mined verdict on the same hash confirms it and raises it', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    expect(await floorOf(s)).toBe('0');
    const req = s.relayer.sends[0]!;
    const hash = keccakHex(rawFor(req));
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: hash, hashes: [hash], state: 'mined', minedHash: hash, outcome: 'execute', costWei: 1n, reservedWei: req.reservedWei });
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ confirmed: 1, corrected: 0 });
    expect(await floorOf(s)).toBe('1');
  });

  it('a reorg: the verdict names the batch’s cancel instead: the row corrected to not_executed, a correction record supersedes the first, the budget moves', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    const first = keccakHex(rawFor(req));
    const cancel = keccakHex(rawFor(req, 'cancel'));
    s.chain.receipts.set(cancel, receiptFor(req, cancel, 'not_executed', { gasUsed: 21_000n, price: 100_000_000n }));
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: cancel, hashes: [first, cancel], state: 'mined', minedHash: cancel, outcome: 'cancel', costWei: 1n, reservedWei: req.reservedWei });
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ corrected: 1 });
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'not_executed', tx_hash: cancel, settled_wei: String(21_000n * 100_000_000n) });
    const records = await billingRows();
    expect(records.map((r) => [r.record_key, r.corrects, r.outcome])).toEqual([
      [first, null, 'executed'],
      [`fix:${records[0]!.send_id}`, first, 'cancelled'],
    ]);
    expect(await appSpent(s.app)).toBe(21_000n * 100_000_000n);
    expect(await floorOf(s)).toBe('0');
    // Checked once: a second run changes nothing.
    expect(await reconcile(s)).toMatchObject({ corrected: 0, confirmed: 0 });
  });

  it('N1: a relayer replay copy settled at head, then a reorg: no correction of its own; the ledger view counts the transaction and its cost once', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    const first = keccakHex(rawFor(req));
    const cancel = keccakHex(rawFor(req, 'cancel'));
    // A second row for the same digest that the relayer answered as a replay (settled at head with no charge of its own).
    const COPY = `es_${'f'.repeat(32)}`;
    const cols = (await env.DB.prepare('SELECT name FROM pragma_table_info(?1)').bind('evm_sponsor_sends').all<{ name: string }>()).results.map((c) => c.name);
    const copied = cols.map((c) => (c === 'id' ? `'${COPY}'` : c === 'replay' ? '1' : c === 'settled_wei' ? "'0'" : c)).join(', ');
    await env.DB.prepare(`INSERT INTO evm_sponsor_sends (${cols.join(', ')}) SELECT ${copied} FROM evm_sponsor_sends`).run();
    s.chain.receipts.set(cancel, receiptFor(req, cancel, 'not_executed', { gasUsed: 21_000n, price: 100_000_000n }));
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: cancel, hashes: [first, cancel], state: 'mined', minedHash: cancel, outcome: 'cancel', costWei: 1n, reservedWei: req.reservedWei });
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ corrected: 1, confirmed: 1 });
    const records = await billingRows();
    expect(records.map((r) => r.send_id)).not.toContain(COPY);
    // The ledger view's rule (migrations-usage 0009): a record a correction superseded counts no more.
    const counted = records.filter((r) => !records.some((c) => c.corrects === r.record_key));
    expect(counted.length).toBe(1);
    expect(counted.reduce((n, r) => n + BigInt(r.total_cost_wei as string), 0n)).toBe(21_000n * 100_000_000n);
    expect(await appSpent(s.app)).toBe(21_000n * 100_000_000n);
    const copy = await env.DB.prepare("SELECT confirmed_at, settled_wei FROM evm_sponsor_sends WHERE id = ?1").bind(COPY).first<{ confirmed_at: number | null; settled_wei: string }>();
    expect(copy?.confirmed_at).not.toBeNull();
    expect(copy?.settled_wei).toBe('0');
    expect(await reconcile(s)).toMatchObject({ corrected: 0, confirmed: 0 });
  });
});

describe('L3: never send what the relayer would refuse', () => {
  it('calldata over the relayer’s own limit is refused before anything is sent (a second line: a valid manifest can’t reach it)', async () => {
    const { calldataTooLarge } = await import('../src/evm/sponsor.ts');
    const { EVM_RELAYER_MAX_DATA_BYTES } = await import('../src/evm-relayer.ts');
    expect(calldataTooLarge(`0x${'ab'.repeat(EVM_RELAYER_MAX_DATA_BYTES)}`)).toBe(false);
    expect(calldataTooLarge(`0x${'ab'.repeat(EVM_RELAYER_MAX_DATA_BYTES + 1)}`)).toBe(true);
  });

  it('fees the relayer’s own floor refuses (`feesTooLow`): 503 gas_price_too_high (15 s), nothing sent, the attempt back', async () => {
    const s = await setup();
    s.chain.baseFeeWei = 750_000_000n;
    const r = await send(s, signedSend(s.user).body);
    const b = await body(r);
    expect([r.status, b.code, b.retryAfterS]).toEqual([503, 'gas_price_too_high', 15]);
    expect(s.relayer.sends).toEqual([]);
    expect(await hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:attempts`)).toBe(0);
  });

  it('the relayer refusing the handlers’ own request (invalid_request): an internal error with everything back and an event', async () => {
    const s = await setup();
    s.relayer.onSend = async () => {
      throw new Error('evm_relayer:invalid_request');
    };
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([503, 'internal_error']);
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").first<{ detail_json: string }>();
    expect(JSON.parse(ev!.detail_json)).toMatchObject({ internal: 'invalid_request' });
    expect(await appSpent(s.app)).toBe(0n);
  });
});

describe('L4 and L5: status is cached; unknown outcomes say so', () => {
  it('GET /status asks the relayer at most once per 15 s per isolate', async () => {
    const s = await setup();
    let asked = 0;
    const real = sponsorPorts.relayer;
    sponsorPorts.relayer = (e, id) => {
      const r = real(e, id)!;
      return { ...r, status: async () => (asked++, r.status()) };
    };
    for (let i = 0; i < 5; i++) expect((await status(s, '?chainId=31337')).status).toBe(200);
    expect(asked).toBe(1);
  });

  it('a row given up as lost answers its copies outcome_unknown with no retry, never “timeout” forever', async () => {
    const s = await setup();
    receiptKind = 'none';
    const signed = signedSend(s.user);
    expect((await send(s, signed.body)).status).toBe(504);
    s.relayer.lookupOverride = async () => null;
    await ageRows();
    expect(await reconcile(s, Number(signed.body.deadline) * 1000 + 61 * 60_000)).toMatchObject({ lost: 1 });
    const r = await send(s, signed.body);
    expect([r.status, (await body(r)).code, r.headers.get('retry-after')]).toEqual([409, 'outcome_unknown', null]);
  });
});

describe('L7: one bad record never blocks the others; an env without the block reads (almost) nothing', () => {
  it('the ledger refusing a batch’s input: rows go one by one, the bad one set aside with an alert, the rest copied', async () => {
    const s = await setup();
    const users = [s.user, testUser(), testUser()];
    for (const u of users.slice(1)) {
      await rememberAccount(s.app.scope, u.address);
      s.chain.codes.set(u.address.toLowerCase(), DESIGNATOR);
    }
    for (const u of users) expect((await send(s, signedSend(u).body)).status).toBe(200);
    const bad = (await billingRows())[1]!.record_key as string;
    const pg = (await import('pg')).default;
    usageTransport.query = async (_b, _sql, params) => {
      const rows = JSON.parse(String(params[0])) as { record_key: string }[];
      if (rows.some((r) => r.record_key === bad)) throw Object.assign(new pg.DatabaseError('evm row: an amount', 0, 'error'), { code: '22023' });
      ledgerCalls.push({ sql: _sql, rows: rows as never });
    };
    await mirrorEvmBilling(cronEnv(s));
    const after = await billingRows();
    expect(after.filter((r) => r.mirrored_at !== null).length).toBe(2);
    expect(after.find((r) => r.record_key === bad)).toMatchObject({ mirrored_at: null, quarantined_at: expect.any(Number) });
    await checkEvmSponsorRelay(cronEnv(s));
    const late = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_billing_late'").first<{ detail_json: string }>();
    expect(JSON.parse(late!.detail_json)).toMatchObject({ quarantined: 1 });
  });

  it('without the block and with nothing left in the tables: one D1 read a run, nothing else', async () => {
    const s = await setup();
    const e = { ...cronEnv(s), EVM_SPONSOR: undefined } as typeof env;
    const prepared: string[] = [];
    const db = e.DB;
    const spy = { ...e, DB: { prepare: (q: string) => (prepared.push(q), db.prepare(q)), batch: db.batch.bind(db), exec: db.exec.bind(db) } } as unknown as typeof env;
    await checkEvmSponsorRelay(spy);
    expect(prepared.length).toBe(1);
    expect(s.chain.calls).toEqual([]);
  });
});

describe('the relayer’s answers as values (PR 86’s interface)', () => {
  it('a coded refusal returned as `{ok: false}` is read as a thrown one: nothing sent, everything back', async () => {
    const s = await setup();
    s.relayer.onSend = async () => ({ ok: false, refused: 'relayer_busy', reason: 'account' }) as never;
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([429, 'account_busy']);
    expect((await auditRows(s.user.address))[0]?.status).toBe('refused');
    expect(await appSpent(s.app)).toBe(0n);
  });

  it('an `ok: true` answer is the transaction', async () => {
    const s = await setup();
    const inner = s.relayer.onSend;
    s.relayer.onSend = async (req) => ({ ok: true, ...(await inner(req)) }) as never;
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
  });

  it('the user’s account had other transactions waiting (`authority_reserved`, cause request): 422 account_pending, a failure', async () => {
    const s = await setup();
    const inner = fakeRelayer(s.chain, () => 'none').onSend;
    s.relayer.onSend = async (req) => ({ ...(await inner(req)), broadcast: 'rejected', rejection: { cause: 'request', code: 'authority_reserved' } as never });
    const r = await send(s, signedSend(s.user).body);
    expect([r.status, (await body(r)).code]).toEqual([422, 'account_pending']);
    expect(await failuresSpent(`evm-sponsor:failures:${s.userId}`)).toBe(1n);
  });
});

describe('the relayer’s oldest unaccepted transaction (PR 86’s status field)', () => {
  it('over 2 minutes raises evm_relay_stuck with its age; under it, nothing', async () => {
    const s = await setup();
    s.relayer.statusValue = { address: RELAYER, unmined: 1, awaitingConfirmation: 0, oldestUnminedMs: 10_000, oldestUnacceptedMs: 60_000, nextNonce: 1, halted: null };
    sponsorPorts.relayer = () => ({ send: async () => Promise.reject(new Error('unused')), status: async () => s.relayer.statusValue, lookup: async () => null });
    await checkEvmSponsorRelay(cronEnv(s));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events WHERE kind = 'evm_relay_stuck'").first<{ n: number }>())?.n).toBe(0);
    s.relayer.statusValue = { ...s.relayer.statusValue, oldestUnacceptedMs: 3 * 60_000 };
    await checkEvmSponsorRelay(cronEnv(s));
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_stuck'").first<{ detail_json: string }>();
    expect(JSON.parse(ev!.detail_json)).toMatchObject({ oldestUnacceptedMs: 3 * 60_000 });
  });
});

describe('D869 after its review: every path to “not charged”, each returning everything exactly once', () => {
  const counts = async (s: Setup) => ({
    userDay: await hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:day`),
    appDay: await hits(`app:${s.app.id}`, `evm-sponsor:${LOCAL_CHAIN}:day`),
    envDay: await hits(`evm-sponsor:global:${LOCAL_CHAIN}`, 'evm-sponsor:day'),
    attempts: await hits(`evm-sponsor:user:${s.userId}`, `evm-sponsor:${LOCAL_CHAIN}:attempts`),
    failures: await failuresSpent(`evm-sponsor:failures:${s.userId}`),
  });
  const closed = (s: Setup) => {
    s.relayer.lookupOverride = async (digest) => ({ digest, relayerNonce: 0, transactionHash: `0x${'aa'.repeat(32)}`, hashes: [], state: 'closed', minedHash: null, outcome: 'consumed_elsewhere', costWei: null, reservedWei: 1n });
  };
  const rowOfDb = async (s: Setup): Promise<SendRow> => {
    const c = await env.DB.prepare('SELECT * FROM evm_sponsor_sends WHERE account = ?1').bind(s.user.address).first<Record<string, unknown>>();
    return { id: String(c!.id), appId: String(c!.app_id), chainId: Number(c!.chain_id), account: c!.account as Hex, userId: (c!.user_id as string) ?? null, digest: c!.digest as Hex, executeNonce: BigInt(String(c!.execute_nonce)), txHash: null, hashes: [], deadline: Number(c!.deadline), reserved: { gasLimit: 0n, feeCap: 0n, l1Bound: 0n, operatorBound: 0n, reservedWei: BigInt(String(c!.reserved_wei)) }, replay: false, createdAt: Number(c!.created_at) };
  };
  const inflight = async (s: Setup) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM evm_sponsor_sends WHERE app_id = ?1 AND replay = 0 AND status IN ('sending', 'sent', 'timeout', 'unknown', 'rejected')").bind(s.app.id).first<{ n: number }>())!.n;

  for (const prior of ['sending', 'sent', 'timeout', 'unknown'] as const) {
    it(`an open row in ${prior}: money, day counts, attempts and the failure slot back exactly once; its in-flight place freed`, async () => {
      const s = await setup();
      receiptKind = 'none';
      expect((await send(s, signedSend(s.user).body)).status).toBe(504);
      await env.DB.prepare('UPDATE evm_sponsor_sends SET status = ?1').bind(prior).run();
      const open = await counts(s);
      expect(open).toMatchObject({ userDay: 1, appDay: 1, envDay: 1, failures: 1n });
      expect(await inflight(s)).toBe(1);
      const row = await rowOfDb(s);
      // The status read must match: a stale read moves nothing.
      expect(await settleNotCharged(cronEnv(s), row, prior === 'timeout' ? 'unknown' : 'timeout')).toBe(false);
      expect(await settleNotCharged(cronEnv(s), row, prior)).toBe(true);
      expect(await settleNotCharged(cronEnv(s), row, prior)).toBe(false);
      expect(await counts(s)).toEqual({ userDay: 0, appDay: 0, envDay: 0, attempts: open.attempts - 1, failures: 0n });
      expect(await appSpent(s.app)).toBe(0n);
      expect(await inflight(s)).toBe(0);
    });
  }

  it('L1: settled executed at head, reorged out, its slot closed as used elsewhere: corrected to not charged once (a fix record at 0), everything back once', async () => {
    const s = await setup();
    expect((await send(s, signedSend(s.user).body)).status).toBe(200);
    const req = s.relayer.sends[0]!;
    const first = keccakHex(rawFor(req));
    const atHead = await counts(s);
    // Executed: the failure slot was freed then; the budgets hold the receipt's cost.
    expect(atHead).toMatchObject({ userDay: 1, appDay: 1, envDay: 1, failures: 0n });
    expect(await appSpent(s.app)).toBeGreaterThan(0n);
    closed(s);
    await ageRows();
    // Two cron runs at once: one moves the row.
    const [a, b] = await Promise.all([reconcile(s), reconcile(s)]);
    expect(a.corrected + b.corrected).toBe(1);
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'consumed_elsewhere', settled_wei: '0' });
    const records = await billingRows();
    expect(records.map((r) => [r.record_key, r.corrects, r.outcome, r.settled_wei, r.tx_hash])).toEqual([
      [first, null, 'executed', records[0]!.settled_wei, first],
      [`fix:${records[0]!.send_id}`, first, 'consumed_elsewhere', '0', null],
    ]);
    expect(await appSpent(s.app)).toBe(0n);
    expect(await envSpent()).toBe(0n);
    expect(await counts(s)).toEqual({ userDay: 0, appDay: 0, envDay: 0, attempts: atHead.attempts - 1, failures: 0n });
    // Final: later runs change nothing.
    await ageRows(60 * 60_000);
    expect(await reconcile(s)).toMatchObject({ corrected: 0, confirmed: 0, settled: 0 });
    expect(await counts(s)).toEqual({ userDay: 0, appDay: 0, envDay: 0, attempts: atHead.attempts - 1, failures: 0n });
    expect(await billingRows()).toHaveLength(2);
  });

  it('L2: a closed slot whose own transaction later mines: an alert for staff once, nothing charged', async () => {
    const s = await setup();
    receiptKind = 'none';
    expect((await send(s, signedSend(s.user).body)).status).toBe(504);
    closed(s);
    await ageRows();
    expect(await reconcile(s)).toMatchObject({ settled: 1 });
    expect(await reconcile(s)).toMatchObject({ closedMined: 0 });
    // The mistaken close: the batch's own transaction is on the chain after all.
    const req = s.relayer.sends[0]!;
    const own = keccakHex(rawFor(req));
    s.chain.receipts.set(own, receiptFor(req, own, 'executed', { gasUsed: 60_000n, price: 100_000_000n }));
    const r1 = await reconcile(s);
    expect(r1.closedMined).toBe(1);
    const ev = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'evm_relay_closed_slot_mined'").all<{ detail_json: string }>();
    expect(ev.results.map((e) => JSON.parse(e.detail_json))).toEqual([{ chainId: LOCAL_CHAIN, sendId: (await rowOfDb(s)).id }]);
    // Once per row, never charged.
    expect((await reconcile(s)).closedMined).toBe(0);
    expect(await appSpent(s.app)).toBe(0n);
    expect((await auditRows(s.user.address))[0]).toMatchObject({ status: 'consumed_elsewhere', settled_wei: '0' });
    expect(await billingRows()).toMatchObject([{ outcome: 'consumed_elsewhere', settled_wei: '0' }]);
    // Past 7 days the watch stops reading it.
    await env.DB.prepare('DELETE FROM security_events WHERE kind = ?1').bind('evm_relay_closed_slot_mined').run();
    await env.DB.prepare('UPDATE evm_sponsor_sends SET created_at = created_at - ?1, updated_at = updated_at - ?1').bind(8 * 86_400_000).run();
    expect((await reconcile(s)).closedMined).toBe(0);
  });
});
