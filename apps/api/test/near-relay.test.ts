// The NEAR meta-transaction relay (D730–D739; docs/api.md "NEAR relay"): the SignedDelegateAction decoder, the relay
// policy and the relayer's transaction encoder (unit), and POST /v1/near/relay and /v1/near/activate through the Worker
// with the fake NEAR RPC: the app gate (the SDK from the partner's page), the optional session proof, every refusal,
// the limits, the budget and its alerts.
// The same code against a real node: test-sandbox/meta-tx.test.ts.
import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { KeyPair } from '@near-js/crypto';
import { type Action, actionCreators, buildDelegateAction, createTransaction, encodeDelegateAction, encodeSignedDelegate, encodeTransaction, Signature, SignedDelegate } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64Encode, hex } from '../src/bytes.ts';
import { decodeSignedDelegate, encodeRelayTransaction, MAX_SIGNED_DELEGATE_BYTES, policyRefusal, TGAS, verifyDelegateSignature } from '../src/near/delegate.ts';
import { checkNearRelayFunds } from '../src/near/relay-funds.ts';
import { NEAR_RELAY_DEFAULTS, nearRelayVar, parseNearRelayConfig } from '../src/near/relay-config.ts';
import { budgetSettlement, defaultNearAccountLookup, delegateFailure, forgetHead, keyIndexFor, nearAccountKnown, nearDirectory, certainlyNotSent, toActivateRequest, toRelayRequest } from '../src/near/relay.ts';
import { inFlightCapPerKey, inFlightHold } from '../src/near/relay-config.ts';
import { nearRelayKeyName, type RelayerKey, type RelayResult } from '../src/relayer-key.ts';
import { runInDurableObject } from 'cloudflare:test';
import { appHeaders, call, type Chain, ORIGIN, type SeededApp, startOfMinuteClock } from './helpers.ts';
import { MOCK_RECEIPT_GAS, MOCK_TX_GAS } from './near-mock.ts';
import { spentSession, vaultHeaders, vaultSetup } from './vault-helpers.ts';

const GUESTBOOK = 'guestbook.test.near';
/** The second demo contract, Journear Passport stamps (near.demoStamps, D797): a receiver beside the guestbook. */
const STAMPS = 'stamps.test.near';
const RELAY_ACCOUNT = 'near-relay.test.near';
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

interface User {
  keyPair: KeyPair;
  accountId: string;
}
const newUser = (): User => {
  const keyPair = KeyPair.fromRandom('ed25519');
  return { keyPair, accountId: hex(keyPair.getPublicKey().data) };
};

const call_ = (method = 'add_message', gasTgas = 30n, deposit = 0n): Action => actionCreators.functionCall(method, { text: 'hello' }, gasTgas * TGAS, deposit);

/** A signed delegate as a wallet makes it (@near-js, an encoder independent of the relay's decoder). */
function delegate(user: User, o: { receiverId?: string; actions?: Action[]; nonce?: bigint; maxBlockHeight?: bigint; senderId?: string; signWith?: KeyPair } = {}): Uint8Array {
  const da = buildDelegateAction({
    senderId: o.senderId ?? user.accountId,
    receiverId: o.receiverId ?? GUESTBOOK,
    actions: o.actions ?? [call_()],
    nonce: o.nonce ?? 101n,
    maxBlockHeight: o.maxBlockHeight ?? 1100n,
    publicKey: user.keyPair.getPublicKey(),
  });
  const hash = new Uint8Array(sha256Sync(encodeDelegateAction(da)));
  const sig = (o.signWith ?? user.keyPair).sign(hash).signature;
  return encodeSignedDelegate(new SignedDelegate({ delegateAction: da, signature: new Signature({ keyType: 0, data: sig }) }));
}

// The delegate's hash, synchronously (nodejs_compat's node:crypto), so tests can build delegates inline.
const sha256Sync = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());

/** What the SDK sends (`hana.near.relay`): no session credential. */
const plainRelay = (signed: Uint8Array, network = 'testnet') => ({ network, signedDelegateAction: base64Encode(signed) });
const relay = (app: SeededApp, b: unknown, bindings?: Partial<typeof env>, headers = appHeaders(app)) => call('/v1/near/relay', { headers, body: b, env: bindings });
const activate = (app: SeededApp, b: unknown, bindings?: Partial<typeof env>, headers = appHeaders(app)) => call('/v1/near/activate', { headers, body: b, env: bindings });
const relayConfig = (extra: Record<string, unknown> = {}) => ({ NEAR_RELAY: JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], maxGasTgas: 50, ...extra }) });

/**
 * The wallet directory's NEAR records, as the directory build will hold them (D735): `scope#account` → user id. Every
 * test's `setup()` user is known unless a test says otherwise; `unknownNear` accounts never are.
 */
const directory = new Map<string, string>();
const remember = (scope: string, accountId: string, userId = `hu_${Math.random().toString(36).slice(2)}`) => directory.set(`${scope}#${accountId}`, userId);
// The relay's and activation's windows are fixed minutes and UTC days (per IP, per app, per sender, per user, across the
// env, the daily budgets and the funds check's one event a day): every test starts a second into a minute that isn't its
// hour's last (helpers.ts startOfMinuteClock), before anything is counted, so no count straddles a window boundary
// however loaded the machine. On the real clock, a run crossing a minute counted 61 of a 60 a minute window.
beforeEach(startOfMinuteClock);
beforeEach(() => {
  forgetHead();
  nearDirectory.lookup = async (_db, q) => {
    const userId = directory.get(`${q.scopeId}#${q.accountId}`);
    return userId ? { userId } : null;
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  nearDirectory.lookup = defaultNearAccountLookup;
  directory.clear();
});

/** A user known to the directory for `scope` (relay and activate need it with requireKnownAccount, the default). */
function knownUser(scope: string, userId?: string): User {
  const u = newUser();
  remember(scope, u.accountId, userId);
  return u;
}

async function setup(): Promise<{ app: SeededApp; near: Chain; user: User }> {
  const { app, near } = await vaultSetup();
  return { app, near, user: knownUser(app.scope) };
}

// ---------------------------------------------------------------------------------------------------------------

describe('decodeSignedDelegate (strict borsh)', () => {
  it('decodes what @near-js encodes, keeping the exact signed bytes, and the signature verifies', async () => {
    const user = newUser();
    const signed = delegate(user, { nonce: 123n, maxBlockHeight: 4567n });
    const d = decodeSignedDelegate(signed);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect([d.value.senderId, d.value.receiverId, d.value.nonce, d.value.maxBlockHeight, d.value.otherAction]).toEqual([user.accountId, GUESTBOOK, 123n, 4567n, null]);
    expect(d.value.actions).toEqual([{ methodName: 'add_message', args: new TextEncoder().encode('{"text":"hello"}'), gas: 30n * TGAS, deposit: 0n }]);
    expect(hex(d.value.publicKey)).toBe(user.accountId);
    expect(d.value.signedBytes).toBe(signed);
    expect(d.value.delegateBytes).toEqual(encodeDelegateAction(buildDelegateAction({ senderId: user.accountId, receiverId: GUESTBOOK, actions: [call_()], nonce: 123n, maxBlockHeight: 4567n, publicKey: user.keyPair.getPublicKey() })).slice(4));
    expect(await verifyDelegateSignature(d.value)).toBe(true);
    // Signed by another key, or one byte of the action changed: refused.
    const forged = decodeSignedDelegate(delegate(user, { signWith: KeyPair.fromRandom('ed25519') }));
    expect(forged.ok && (await verifyDelegateSignature(forged.value))).toBe(false);
    const tampered = Uint8Array.from(signed);
    tampered[tampered.length - 100] = (tampered[tampered.length - 100] ?? 0) ^ 1; // inside max_block_height
    const t = decodeSignedDelegate(tampered);
    expect(t.ok && (await verifyDelegateSignature(t.value))).toBe(false);
  });

  it('refuses truncated input, trailing bytes, an oversized input, bad account ids, a non-Ed25519 key, too many actions', () => {
    const signed = delegate(newUser());
    expect(decodeSignedDelegate(signed.slice(0, signed.length - 1))).toEqual({ ok: false, error: 'truncated' });
    expect(decodeSignedDelegate(new Uint8Array([...signed, 0]))).toEqual({ ok: false, error: 'trailing_bytes' });
    expect(decodeSignedDelegate(new Uint8Array(MAX_SIGNED_DELEGATE_BYTES + 1))).toEqual({ ok: false, error: 'too_large' });
    expect(decodeSignedDelegate(new Uint8Array(0))).toEqual({ ok: false, error: 'truncated' });
    const upper = delegate(newUser(), { receiverId: 'Guestbook.test.near' });
    expect(decodeSignedDelegate(upper)).toEqual({ ok: false, error: 'bad_account' });
    // The public key's type byte (after nonce and max_block_height) set to secp256k1.
    const k = Uint8Array.from(signed);
    k[k.length - 65 - 33] = 1;
    expect(decodeSignedDelegate(k)).toEqual({ ok: false, error: 'key_type' });
    const five = delegate(newUser(), { actions: [call_(), call_(), call_(), call_(), call_()] });
    expect(decodeSignedDelegate(five)).toEqual({ ok: false, error: 'too_many_actions' });
  });

  it('names the first action that is not a FunctionCall', () => {
    const user = newUser();
    const cases: [Action, string][] = [
      [actionCreators.transfer(10n ** 24n), 'Transfer'],
      [actionCreators.addKey(KeyPair.fromRandom('ed25519').getPublicKey(), actionCreators.fullAccessKey()), 'AddKey'],
      [actionCreators.deleteAccount('attacker.test.near'), 'DeleteAccount'],
      [actionCreators.deployContract(new Uint8Array([0, 97, 115, 109])), 'DeployContract'],
      [actionCreators.deleteKey(KeyPair.fromRandom('ed25519').getPublicKey()), 'DeleteKey'],
      [actionCreators.stake(1n, KeyPair.fromRandom('ed25519').getPublicKey()), 'Stake'],
    ];
    for (const [action, name] of cases) {
      const d = decodeSignedDelegate(delegate(user, { actions: [call_(), action] }));
      expect(d.ok && d.value.otherAction, name).toEqual({ index: 1, name });
      expect(d.ok && policyRefusal(d.value, { receivers: [GUESTBOOK], maxGas: 100n * TGAS }), name).toEqual({ code: 'action_not_allowed', index: 1, action: name });
    }
    // Tags @near-js can't build into a delegate: a nested Delegate (8), the global contract actions (9, 10), and any
    // later or unknown tag; NEAR's own encoder would refuse a nested delegate, a forged byte stream must be refused too.
    const raw = (tag: number) => {
      const s = (x: string) => [...new Uint8Array(new Uint32Array([x.length]).buffer), ...new TextEncoder().encode(x)];
      return Uint8Array.from([...s(user.accountId), ...s(GUESTBOOK), 1, 0, 0, 0, tag, 0, 0, 0, 0]);
    };
    for (const [tag, name] of [[8, 'Delegate'], [9, 'DeployGlobalContract'], [10, 'UseGlobalContract'], [11, 'DeterministicStateInit'], [42, 'action 42']] as const) {
      const d = decodeSignedDelegate(raw(tag));
      expect(d.ok && policyRefusal(d.value, { receivers: [GUESTBOOK], maxGas: 100n * TGAS }), name).toEqual({ code: 'action_not_allowed', index: 0, action: name });
    }
  });
});

describe('policyRefusal (D732)', () => {
  const policy = { receivers: [GUESTBOOK], maxGas: 50n * TGAS };
  const refusal = (signed: Uint8Array) => {
    const d = decodeSignedDelegate(signed);
    if (!d.ok) throw new Error(d.error);
    return policyRefusal(d.value, policy);
  };
  it('passes a zero-deposit call to an allowlisted receiver within the gas cap', () => {
    expect(refusal(delegate(newUser()))).toBeNull();
    expect(refusal(delegate(newUser(), { actions: [call_('add_message', 25n), call_('add_message', 25n)] }))).toBeNull();
  });
  it('refuses a deposit, another receiver, too much gas in all, no actions, a sender that is not the key’s implicit account', () => {
    expect(refusal(delegate(newUser(), { actions: [call_('add_message', 30n, 1n)] }))).toEqual({ code: 'deposit_not_allowed', index: 0 });
    expect(refusal(delegate(newUser(), { receiverId: 'other.test.near' }))).toEqual({ code: 'receiver_not_allowed', receiverId: 'other.test.near' });
    expect(refusal(delegate(newUser(), { actions: [call_('add_message', 30n), call_('add_message', 21n)] }))).toEqual({ code: 'gas_too_high', maxGas: 50n * TGAS });
    expect(refusal(delegate(newUser(), { actions: [] }))).toEqual({ code: 'no_actions' });
    expect(refusal(delegate(newUser(), { senderId: 'alice.test.near' }))).toEqual({ code: 'sender_not_implicit' });
    expect(refusal(delegate(newUser(), { senderId: newUser().accountId }))).toEqual({ code: 'sender_not_implicit' });
  });
});

describe('encodeRelayTransaction', () => {
  it('encodes exactly what @near-js encodes: a Delegate action carrying the signed bytes, and the activation Transfer', () => {
    const relayer = KeyPair.fromRandom('ed25519');
    const user = newUser();
    const signed = delegate(user);
    const blockHash = baseEncode(new Uint8Array(32).fill(9));
    const d = decodeSignedDelegate(signed);
    if (!d.ok) throw new Error('decode');
    const sd = new SignedDelegate({
      delegateAction: buildDelegateAction({ senderId: user.accountId, receiverId: GUESTBOOK, actions: [call_()], nonce: 101n, maxBlockHeight: 1100n, publicKey: user.keyPair.getPublicKey() }),
      signature: new Signature({ keyType: 0, data: d.value.signature }),
    });
    const ours = encodeRelayTransaction({ signerId: RELAY_ACCOUNT, publicKey: relayer.getPublicKey().data, nonce: 77n, receiverId: user.accountId, blockHash, action: { kind: 'delegate', signedDelegate: signed } });
    const theirs = encodeTransaction(createTransaction(RELAY_ACCOUNT, relayer.getPublicKey(), user.accountId, 77n, [actionCreators.signedDelegate(sd)], baseDecode(blockHash)));
    expect(hex(ours)).toBe(hex(theirs));
    for (const amount of [0n, 1n, 10n ** 22n, (1n << 128n) - 1n]) {
      const t = encodeRelayTransaction({ signerId: RELAY_ACCOUNT, publicKey: relayer.getPublicKey().data, nonce: 2n ** 63n, receiverId: user.accountId, blockHash, action: { kind: 'activate', amount } });
      expect(hex(t)).toBe(hex(encodeTransaction(createTransaction(RELAY_ACCOUNT, relayer.getPublicKey(), user.accountId, 2n ** 63n, [actionCreators.transfer(amount)], baseDecode(blockHash)))));
    }
    expect(() => encodeRelayTransaction({ signerId: RELAY_ACCOUNT, publicKey: relayer.getPublicKey().data, nonce: 1n << 64n, receiverId: user.accountId, blockHash, action: { kind: 'activate', amount: 0n } })).toThrow(/u64/u);
  });
});

describe('NEAR_RELAY config', () => {
  it('parses the manifest var with defaults and refuses anything out of bounds (relay off)', () => {
    const c = parseNearRelayConfig(nearRelayVar({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK] }));
    expect(c).toEqual({
      account: RELAY_ACCOUNT,
      receivers: [GUESTBOOK],
      maxGas: BigInt(NEAR_RELAY_DEFAULTS.maxGasTgas) * TGAS,
      dailyBudgetYocto: 5n * 10n ** 24n,
      appDailyBudgetYocto: 10n ** 24n,
      perSenderPerDay: 100,
      perAppPerDay: 5000,
      relaysPerDay: 20_000,
      relaysPerMinute: 300,
      inFlightYocto: 2n * 10n ** 24n,
      activationsPerAppPerDay: 200,
      activationsPerDay: 1000,
      lowBalanceYocto: 2n * 10n ** 24n,
      activationYocto: 0n,
      requireKnownAccount: true,
    });
    // A small env budget gets an app budget of a fifth of it by default.
    expect(parseNearRelayConfig(nearRelayVar({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], dailyBudgetNear: 2 }))?.appDailyBudgetYocto).toBe(4n * 10n ** 23n);
    expect(parseNearRelayConfig(nearRelayVar({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], requireKnownAccount: false }))?.requireKnownAccount).toBe(false);
    expect(parseNearRelayConfig(nearRelayVar({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], dailyBudgetNear: 0.5, activationYocto: '1' }))).toMatchObject({ dailyBudgetYocto: 5n * 10n ** 23n, activationYocto: 1n });
    for (const bad of [
      undefined,
      '',
      'not json',
      '[]',
      JSON.stringify({ account: 'Bad', receivers: [] }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [RELAY_ACCOUNT] }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK, GUESTBOOK] }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], maxGasTgas: 301 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], dailyBudgetNear: 0 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], activationYocto: '10000000000000000000001' }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], extra: 1 }),
      // A per-app cap or budget not below the env's (D736).
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], perAppPerDay: 20_000 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], perAppPerDay: 10, relaysPerDay: 10 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], activationsPerAppPerDay: 1000 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], appDailyBudgetNear: 5 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], dailyBudgetNear: 0.000001 }),
      JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], requireKnownAccount: 'no' }),
    ]) {
      expect(parseNearRelayConfig(bad), String(bad)).toBeNull();
    }
  });

  it('reads the reason a delegate itself failed from the failure text', () => {
    expect(delegateFailure('{"ActionError":{"index":0,"kind":"DelegateActionExpired"}}')).toBe('expired');
    expect(delegateFailure('{"ActionError":{"kind":{"DelegateActionInvalidNonce":{"ak_nonce":1,"delegate_nonce":1}}}}')).toBe('invalid_nonce');
    expect(delegateFailure('{"ActionError":{"kind":{"DelegateActionNonceTooLarge":{}}}}')).toBe('nonce_too_large');
    expect(delegateFailure('{"ActionError":{"kind":{"AccountDoesNotExist":{}}}}')).toBe('account_missing');
    expect(delegateFailure('Smart contract panicked: text too long')).toBeNull();
  });
});

describe('request bodies', () => {
  it('take only their fields; network optional; no session proof fields (removed, review of 2026-11-11)', async () => {
    const user = newUser();
    const signed = delegate(user);
    expect(toRelayRequest({ signedDelegateAction: base64Encode(signed) })).toMatchObject({ network: 'testnet' });
    expect(toRelayRequest(plainRelay(signed, 'mainnet'))).toMatchObject({ network: 'mainnet' });
    expect(toRelayRequest({ ...plainRelay(signed), extra: 1 })).toBeNull();
    for (const field of ['sessionPublicKey', 'issuedAtMs', 'nonce', 'signature']) expect(toRelayRequest({ ...plainRelay(signed), [field]: 1 }), field).toBeNull();
    expect(toRelayRequest({ signedDelegateAction: `${base64Encode(signed)}=` })).toBeNull();
    expect(toRelayRequest({ signedDelegateAction: 'not base64!' })).toBeNull();
    expect(toRelayRequest({ network: 5, signedDelegateAction: base64Encode(signed) })).toBeNull();
    expect(toActivateRequest({ accountId: user.accountId })).toMatchObject({ accountId: user.accountId, network: 'testnet' });
    expect(toActivateRequest({ accountId: user.accountId, sessionPublicKey: [] })).toBeNull();
    expect(toActivateRequest({ accountId: 'alice.testnet' })).toBeNull();
    expect(toActivateRequest({ accountId: user.accountId.toUpperCase() })).toBeNull();
    expect(toActivateRequest({ accountId: user.accountId, extra: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('POST /v1/near/relay', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("relays a checked delegate from the partner's page: the relay account, receiver = the sender, one Delegate action", async () => {
    const signed = delegate(s.user);
    const res = await relay(s.app, plainRelay(signed));
    const b = await body(res);
    expect([res.status, b.status, b.code]).toEqual([200, 'executed', undefined]);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(b.transactionHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u);
    const tx = s.near.nearSent.at(-1)!;
    expect([tx.hash, tx.signerId, tx.receiverId, tx.kind, tx.actionCount]).toEqual([b.transactionHash, RELAY_ACCOUNT, s.user.accountId, 'delegate', 1]);
    expect(tx.delegate).toEqual({ senderId: s.user.accountId, receiverId: GUESTBOOK, nonce: 101n, maxBlockHeight: 1100n, methods: ['add_message'] });
    const nearKeys = (JSON.parse(env.NEAR_RELAY_KEYS!) as string[]).map((k) => KeyPair.fromString(k as `ed25519:${string}`).getPublicKey().toString());
    expect(nearKeys).toContain(tx.publicKey);
    // The same signed delegate again: at or below the sender's nonce floor, dropped.
    const again = await body(await relay(s.app, plainRelay(signed)));
    // accessKeyNonce: the lowest nonce Hana won't take for the sender (the floor here), which a client builds above.
    expect([again.code, again.accessKeyNonce, again.retryable]).toEqual(['delegate_nonce_used', '101', undefined]);
  });

  it('takes the vault too', async () => {
    const res = await relay(s.app, plainRelay(delegate(s.user)), undefined, vaultHeaders(s.app));
    expect([res.status, (await body(res)).status]).toEqual([200, 'executed']);
  });

  it('the app gate: the publishable key, an origin in force, an unsuspended app; preflight for the app’s origins', async () => {
    const b = plainRelay(delegate(s.user));
    expect((await body(await relay(s.app, b, undefined, { origin: ORIGIN }))).code).toBe('missing_key');
    expect((await body(await relay(s.app, b, undefined, appHeaders(s.app, 'https://evil.example')))).code).toBe('origin_not_allowed');
    expect((await body(await relay(s.app, b, undefined, vaultHeaders(s.app, 'https://evil.example')))).code).toBe('origin_not_allowed');
    expect((await call('/v1/near/relay', { method: 'OPTIONS', headers: { origin: ORIGIN } })).status).toBe(204);
    expect((await call('/v1/near/relay', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    await env.DB.prepare('UPDATE apps SET suspended_by = 1 WHERE id = ?1').bind(s.app.id).run();
    expect((await body(await relay(s.app, b))).code).toBe('app_suspended');
    expect(s.near.nearSent.length).toBe(0);
  });

  it('is off (503 relayer_unconfigured) unless the env is testnet, the config readable with receivers and the keys present and unshared', async () => {
    const b = plainRelay(delegate(s.user));
    const poolKey = (JSON.parse(env.RELAYER_KEYS) as string[])[0]!;
    for (const bindings of [
      { NETWORK: 'mainnet' },
      { NETWORK: undefined },
      { NEAR_RELAY: undefined },
      { NEAR_RELAY: '{"account":"x"}' },
      relayConfig({ receivers: [] }),
      { NEAR_RELAY_KEYS: undefined },
      { NEAR_RELAY_KEYS: '[]' },
      { NEAR_RELAY_KEYS: JSON.stringify([poolKey]) },
      // The same key in its 32-byte seed encoding (L3): compared by public key.
      { NEAR_RELAY_KEYS: JSON.stringify([`ed25519:${baseEncode(baseDecode(poolKey.slice(8)).slice(0, 32))}`]) },
      // The relay account may never be the pools' relayer or the signer.
      relayConfig({ account: env.RELAYER_ACCOUNT }),
      relayConfig({ account: env.SIGNER_ACCOUNT }),
    ] as Partial<typeof env>[]) {
      const res = await relay(s.app, b, bindings);
      expect([res.status, (await body(res)).code], JSON.stringify(bindings)).toEqual([503, 'relayer_unconfigured']);
    }
    expect(s.near.nearSent.length).toBe(0);
  });

  it('relays to a second receiver (the stamps contract, D797) with no code change; any other receiver is still refused', async () => {
    const bindings = relayConfig({ receivers: [GUESTBOOK, STAMPS], maxGasTgas: 10 });
    const collect = actionCreators.functionCall('collect', { stamp: 'arrival' }, 10n * TGAS, 0n);
    const res = await relay(s.app, plainRelay(delegate(s.user, { receiverId: STAMPS, actions: [collect], nonce: 101n })), bindings);
    expect([res.status, (await body(res)).status]).toEqual([200, 'executed']);
    expect(s.near.nearSent).toHaveLength(1);
    // The guestbook still passes beside it.
    expect((await relay(s.app, plainRelay(delegate(s.user, { actions: [call_('add_message', 10n)], nonce: 102n })), bindings)).status).toBe(200);
    for (const receiverId of ['other.test.near', 'stamps2.test.near', 'test.near', `x.${STAMPS}`]) {
      const b = await body(await relay(s.app, plainRelay(delegate(s.user, { receiverId, actions: [collect], nonce: 103n })), bindings));
      expect([b.code, b.receiverId], receiverId).toEqual(['receiver_not_allowed', receiverId]);
    }
    // Over the cap (10 Tgas on sandbox-dev) to the stamps contract: refused as for the guestbook.
    const over = await body(await relay(s.app, plainRelay(delegate(s.user, { receiverId: STAMPS, actions: [actionCreators.functionCall('collect', { stamp: 'arrival' }, 11n * TGAS, 0n)], nonce: 103n })), bindings));
    expect(over.code).toBe('gas_too_high');
    // Without the stamps contract in receivers (the manifest before D797): refused.
    const before = await body(await relay(s.app, plainRelay(delegate(s.user, { receiverId: STAMPS, actions: [collect], nonce: 103n }))));
    expect([before.code, before.receiverId]).toEqual(['receiver_not_allowed', STAMPS]);
    expect(s.near.nearSent).toHaveLength(2);
  });

  it('refuses mainnet, another network, a malformed body', async () => {
    const signed = delegate(s.user);
    expect((await body(await relay(s.app, plainRelay(signed, 'mainnet')))).code).toBe('mainnet_not_allowed');
    expect((await body(await relay(s.app, plainRelay(signed, 'betanet')))).code).toBe('bad_request');
    expect((await body(await relay(s.app, { ...plainRelay(signed), extra: true }))).code).toBe('bad_request');
    expect(s.near.nearSent.length).toBe(0);
  });

  it('refuses every delegate the policy refuses, before any chain read', async () => {
    const cases: [Uint8Array, string, Record<string, unknown>][] = [
      [new Uint8Array([1, 2, 3]), 'bad_delegate', { reason: 'truncated' }],
      [delegate(s.user, { actions: [actionCreators.transfer(10n ** 24n)] }), 'action_not_allowed', { action: 'Transfer', index: 0 }],
      [delegate(s.user, { actions: [actionCreators.transfer(0n)] }), 'action_not_allowed', { action: 'Transfer', index: 0 }],
      [delegate(s.user, { actions: [actionCreators.stake(1n, KeyPair.fromRandom('ed25519').getPublicKey())] }), 'action_not_allowed', { action: 'Stake', index: 0 }],
      [delegate(s.user, { actions: [actionCreators.addKey(KeyPair.fromRandom('ed25519').getPublicKey(), actionCreators.fullAccessKey())] }), 'action_not_allowed', { action: 'AddKey', index: 0 }],
      [delegate(s.user, { actions: [actionCreators.deleteKey(KeyPair.fromRandom('ed25519').getPublicKey())] }), 'action_not_allowed', { action: 'DeleteKey', index: 0 }],
      [delegate(s.user, { actions: [actionCreators.deleteAccount('attacker.test.near')] }), 'action_not_allowed', { action: 'DeleteAccount', index: 0 }],
      [delegate(s.user, { actions: [actionCreators.deployContract(new Uint8Array([0, 97, 115, 109]))] }), 'action_not_allowed', { action: 'DeployContract', index: 0 }],
      [delegate(s.user, { actions: [call_(), call_('add_message', 10n, 1n)] }), 'deposit_not_allowed', { index: 1 }],
      [delegate(s.user, { actions: [call_('add_message', 30n, 1n)] }), 'deposit_not_allowed', { index: 0 }],
      [delegate(s.user, { receiverId: 'signer.test.near' }), 'receiver_not_allowed', { receiverId: 'signer.test.near' }],
      [delegate(s.user, { actions: [call_('add_message', 51n)] }), 'gas_too_high', { maxGas: (50n * TGAS).toString() }],
      [delegate(s.user, { senderId: newUser().accountId }), 'sender_not_implicit', {}],
      [delegate(s.user, { signWith: KeyPair.fromRandom('ed25519') }), 'bad_delegate_signature', {}],
    ];
    for (const [signed, code, extra] of cases) {
      const res = await relay(s.app, plainRelay(signed));
      const b = await body(res);
      expect([b.code, ...Object.keys(extra).map((k) => b[k])], code).toEqual([code, ...Object.values(extra)]);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(s.near.nearSent.length).toBe(0);
  });

  it('reads the chain before paying: account missing, key missing, nonce used or too large, expired or too far ahead', async () => {
    const cases: [() => void, Uint8Array, string][] = [
      [() => s.near.missingAccounts.add(s.user.accountId), delegate(s.user), 'account_not_activated'],
      [() => s.near.missingKeys.add(s.user.accountId), delegate(s.user), 'access_key_missing'],
      [() => s.near.akNonce.set(s.user.keyPair.getPublicKey().toString(), 101n), delegate(s.user, { nonce: 101n }), 'delegate_nonce_used'],
      [() => undefined, delegate(s.user, { nonce: 1001n * 1_000_000n }), 'delegate_nonce_too_large'],
      // Above the floor the nonce-used answer raised (to 101).
      [() => undefined, delegate(s.user, { nonce: 102n, maxBlockHeight: 1002n }), 'delegate_expired'],
      [() => undefined, delegate(s.user, { nonce: 103n, maxBlockHeight: 2001n }), 'block_height_too_far'],
    ];
    const reset = () => {
      s.near.missingAccounts.clear();
      s.near.missingKeys.clear();
      s.near.akNonce.clear();
    };
    for (const [arrange, signed, code] of cases) {
      reset();
      arrange();
      expect((await body(await relay(s.app, plainRelay(signed)))).code, code).toBe(code);
    }
    expect(s.near.nearSent.length).toBe(0);
    // At the bounds: 1000 blocks ahead of the head, nonce just below (height + 1) × 10^6.
    reset();
    expect((await relay(s.app, plainRelay(delegate(s.user, { nonce: 1001n * 1_000_000n - 1n, maxBlockHeight: 2000n })))).status).toBe(200);
    // A nonce near (height − 10 000) × 10^6, as the core's test-app rule makes them, far above the key's: accepted (no `nonce + 1` assumed).
    reset();
    expect((await relay(s.app, plainRelay(delegate(knownUser(s.app.scope), { nonce: 999n * 1_000_000n + 7n })))).status).toBe(200);
  });

  it('answers a failed inner call as 422 contract_rejected, a refused delegate as 422 delegate_rejected', async () => {
    s.near.onNearTx = () => ({ failIn: 'receiver', failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: Text is too long' } } } } });
    let b = await body(await relay(s.app, plainRelay(delegate(s.user))));
    expect([b.code, b.status, b.executor, typeof b.transactionHash]).toEqual(['contract_rejected', 'failed', GUESTBOOK, 'string']);
    s.near.onNearTx = () => ({ failIn: 'sender', failure: { ActionError: { index: 0, kind: 'DelegateActionExpired' } } });
    b = await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 102n }))));
    expect([b.code, b.reason, b.status]).toEqual(['delegate_rejected', 'expired', 'failed']);
  });

  it('re-posting any relayed delegate of a sender, at any later time, counts nothing of the sender’s and reads no chain; the next honest relay goes through', async () => {
    const bindings = relayConfig({ perSenderPerDay: 2 });
    const first = delegate(s.user, { nonce: 101n });
    expect((await relay(s.app, plainRelay(first), bindings)).status).toBe(200);
    // Past the 20-minute hash mark (dropped here as if expired): the nonce floor, which never expires, still drops it.
    await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`near-relay:relayed:${s.user.accountId}`)).release(hex(new Uint8Array(createHash('sha256').update(first).digest())));
    const reads = s.near.rpcMethods.length;
    for (let i = 0; i < 20; i++) expect((await body(await relay(s.app, plainRelay(first), bindings))).code).toBe('delegate_nonce_used');
    // An older delegate of the sender (a lower nonce, another expiry): dropped the same way.
    for (let i = 0; i < 5; i++) expect((await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 100n, maxBlockHeight: 1050n })), bindings))).code).toBe('delegate_nonce_used');
    expect(s.near.rpcMethods.length).toBe(reads);
    // The sender's own minute holds only the first relay: the 25 replays counted nothing of theirs.
    const probe = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`near-relay:sender:${s.user.accountId}`)).hit([{ name: 'near-relay:minute', windowMs: 60_000, max: 2 }]);
    expect(probe.ok).toBe(true);
    // The sender's day still has its second relay: the honest next one goes through, the third is refused.
    expect((await relay(s.app, plainRelay(delegate(s.user, { nonce: 102n })), bindings)).status).toBe(200);
    expect((await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 103n })), bindings))).error).toBe('Rate limit exceeded (per account)');
  });

  it('chain-stale delegates (Hana’s floor behind the chain): the shared and the sender’s minutes all come back; the floor rises from the chain', async () => {
    const pk = s.user.keyPair.getPublicKey().toString();
    for (let n = 0; n < 11; n++) {
      // Each delegate above Hana's floor, each already used on chain (executed elsewhere): the chain nonce stays ahead.
      s.near.akNonce.set(pk, BigInt(20_000 + n * 10));
      const b = await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: BigInt(20_000 + n * 10 - 5) }))));
      // The chain's nonce, above Hana's floor: the lowest nonce Hana won't take now.
      expect([b.code, b.accessKeyNonce]).toEqual(['delegate_nonce_used', String(20_000 + n * 10)]);
    }
    // Nothing of the sender's, the app's or the env's minute is left taken (probes with a cap of 1 pass).
    const probe = (name: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name)).hit([{ name: 'near-relay:minute', windowMs: 60_000, max: 1 }]);
    expect((await probe(`app:${s.app.id}`)).ok).toBe(true);
    expect((await probe(`near-relay:sender:${s.user.accountId}`)).ok).toBe(true);
    // The floor rose to the chain's nonce: an older above-the-old-floor delegate is dropped with no chain read.
    const reads = s.near.rpcMethods.length;
    expect((await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 20_050n }))))).code).toBe('delegate_nonce_used');
    expect(s.near.rpcMethods.length).toBe(reads);
    expect((await relay(s.app, plainRelay(delegate(knownUser(s.app.scope))))).status).toBe(200);
  });

  it('12 public stale delegates of a victim posted at once (Hana’s floor at 0) can’t keep the victim out: their honest delegate goes through', async () => {
    const victim = knownUser(s.app.scope);
    s.near.akNonce.set(victim.keyPair.getPublicKey().toString(), 50_000n);
    // Stale on chain, above Hana's floor (0): what a third party can collect from the chain for a key used outside Hana.
    const stale = Array.from({ length: 12 }, (_, i) => plainRelay(delegate(victim, { nonce: BigInt(100 + i) })));
    const answers = await Promise.all(stale.map(async (b) => (await body(await relay(s.app, b))).code));
    expect(answers.every((c) => c === 'delegate_nonce_used' || c === 'rate_limited')).toBe(true);
    expect((await relay(s.app, plainRelay(delegate(victim, { nonce: 50_001n })))).status).toBe(200);
  });

  it('a delegate refused by the chain checks (expired) counts in no daily window', async () => {
    const bindings = relayConfig({ perSenderPerDay: 1 });
    for (let i = 0; i < 3; i++) expect((await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: BigInt(200 + i), maxBlockHeight: 1001n })), bindings))).code).toBe('delegate_expired');
    expect((await relay(s.app, plainRelay(delegate(s.user, { nonce: 300n })), bindings)).status).toBe(200);
  });

  it('counts per sender per day (manifest perSenderPerDay)', async () => {
    const bindings = relayConfig({ perSenderPerDay: 2 });
    for (const n of [101n, 102n]) expect((await relay(s.app, plainRelay(delegate(s.user, { nonce: n })), bindings)).status).toBe(200);
    const res = await relay(s.app, plainRelay(delegate(s.user, { nonce: 103n })), bindings);
    expect([res.status, (await body(res)).code, Number(res.headers.get('retry-after')) > 0]).toEqual([429, 'rate_limited', true]);
    expect((await relay(s.app, plainRelay(delegate(knownUser(s.app.scope))), bindings)).status).toBe(200);
  });

  it('counts per app per day (manifest perAppPerDay), a refusal giving the sender’s window back', async () => {
    const bindings = relayConfig({ perAppPerDay: 1, perSenderPerDay: 1 });
    expect((await relay(s.app, plainRelay(delegate(s.user)), bindings)).status).toBe(200);
    const other = knownUser(s.app.scope);
    const res = await relay(s.app, plainRelay(delegate(other)), bindings);
    expect([res.status, (await body(res)).error]).toEqual([429, 'Rate limit exceeded (per app)']);
    // The refused request took nothing from `other`'s daily window: another app relays for it at once.
    const app2 = await setup();
    remember(app2.app.scope, other.accountId);
    expect((await relay(app2.app, plainRelay(delegate(other)), bindings)).status).toBe(200);
  });

  it('per IP: 30 a minute across every app (one IP, two apps share the window)', async () => {
    const other = await setup();
    const ip = '10.250.1.1';
    let n = 0;
    for (; n < 31; n++) {
      const app = n % 2 === 0 ? s.app : other.app;
      if ((await relay(app, plainRelay(new Uint8Array([1])), undefined, { ...appHeaders(app), 'cf-connecting-ip': ip })).status === 429) break;
    }
    expect(n).toBe(30);
    expect((await relay(other.app, plainRelay(new Uint8Array([1])), undefined, { ...appHeaders(other.app), 'cf-connecting-ip': ip })).status).toBe(429);
  });

  it('only for a NEAR account the directory holds for a user of the app’s scope (requireKnownAccount, the default)', async () => {
    const stranger = newUser();
    let res = await relay(s.app, plainRelay(delegate(stranger)));
    const unknownBody = await body(res);
    expect([res.status, unknownBody.code, unknownBody.retryable, res.headers.get('retry-after')]).toEqual([409, 'near_account_unrecorded', true, '2']);
    // Known in another scope only: still unknown here.
    const elsewhere = knownUser('another-scope');
    expect((await body(await relay(s.app, plainRelay(delegate(elsewhere))))).code).toBe('near_account_unrecorded');
    // With the setting off (testnet only), the limits alone apply.
    res = await relay(s.app, plainRelay(delegate(stranger)), relayConfig({ requireKnownAccount: false }));
    expect(res.status).toBe(200);
    // The lookup failing is a 503, never a pass.
    nearDirectory.lookup = () => Promise.reject(new Error('D1 down'));
    expect((await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 102n }))))).code).toBe('directory_unavailable');
    expect(s.near.nearSent.length).toBe(1);
  });

  it('the default lookup reads the directory’s near rows of the scope (none before the directory build), through nearAccountKnown', async () => {
    nearDirectory.lookup = defaultNearAccountLookup;
    expect(await nearAccountKnown(env.DB, { scopeId: s.app.scope, accountId: s.user.accountId })).toBe(false);
  });

  it('a per-app daily NEAR budget below the env’s: 429 app_budget_exhausted for the app, the env’s still open to others', async () => {
    const bindings = relayConfig({ dailyBudgetNear: 1, appDailyBudgetNear: 0.000001 });
    const res = await relay(s.app, plainRelay(delegate(s.user)), bindings);
    expect([res.status, (await body(res)).code, Number(res.headers.get('retry-after')) > 0]).toEqual([429, 'app_budget_exhausted', true]);
    expect(s.near.nearSent.length).toBe(0);
  });

  it('the env’s daily NEAR budget: past it 503 relay_budget_exhausted for every app, with a near_relay_budget_high security event', async () => {
    // Each relay reserves (30 + 5 Tgas) × 10^8 = 0.0035 NEAR; an app may take 0.005, the env 0.01.
    const bindings = relayConfig({ dailyBudgetNear: 0.01, appDailyBudgetNear: 0.005 });
    const apps = [s, await setup(), await setup()];
    const codes: (string | number)[] = [];
    for (const a of apps) {
      const res = await relay(a.app, plainRelay(delegate(a.user)), { ...bindings });
      codes.push(res.status === 200 ? 200 : ((await body(res)).code as string));
    }
    expect(codes.at(-1)).toBe('relay_budget_exhausted');
    const ev = await env.DB.prepare("SELECT kind, detail_json FROM security_events WHERE kind = 'near_relay_budget_high'").all<{ kind: string; detail_json: string }>();
    expect(ev.results.length).toBe(1);
    expect(Object.keys(JSON.parse(ev.results[0]!.detail_json)).sort()).toEqual(['budgetYocto', 'day', 'spentYocto', 'thresholdPct']);
  });
});

describe('POST /v1/near/activate', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it('{accountId} from the partner page creates a missing implicit account with a zero Transfer, then answers created: false', async () => {
    s.near.missingAccounts.add(s.user.accountId);
    const res = await activate(s.app, { accountId: s.user.accountId });
    const b = await body(res);
    expect([res.status, b.created, b.accountId, typeof b.transactionHash, b.accessKeyNonce]).toEqual([200, true, s.user.accountId, 'string', '100']);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const tx = s.near.nearSent.at(-1)!;
    expect([tx.kind, tx.signerId, tx.receiverId, tx.amount, tx.actionCount]).toEqual(['transfer', RELAY_ACCOUNT, s.user.accountId, 0n, 1]);
    const again = await body(await activate(s.app, { accountId: s.user.accountId, network: 'testnet' }));
    expect([again.created, again.accessKeyNonce, again.blockHeight]).toEqual([false, '100', 1000]);
    expect(s.near.nearSent.length).toBe(1);
  });

  it('an activation refused by the budget gives the user’s day back (no account created, nothing of the user’s used)', async () => {
    const victim = 'hu_budget_victim';
    for (let i = 0; i < 3; i++) {
      const u = knownUser(s.app.scope, victim);
      s.near.missingAccounts.add(u.accountId);
      expect((await body(await activate(s.app, { accountId: u.accountId }, relayConfig({ dailyBudgetNear: 1, appDailyBudgetNear: 0.000001 })))).code).toBe('app_budget_exhausted');
    }
    for (let i = 0; i < 2; i++) {
      const u = knownUser(s.app.scope, victim);
      s.near.missingAccounts.add(u.accountId);
      expect((await body(await activate(s.app, { accountId: u.accountId }))).created).toBe(true);
    }
  });

  it('naming a victim’s existing account answers created: false and never uses up the victim’s daily activations', async () => {
    const victim = 'hu_victim';
    const existing = knownUser(s.app.scope, victim);
    for (let i = 0; i < 5; i++) expect((await body(await activate(s.app, { accountId: existing.accountId }))).created).toBe(false);
    // The victim's 2 a day are untouched: two new accounts of theirs still activate.
    for (let i = 0; i < 2; i++) {
      const fresh = knownUser(s.app.scope, victim);
      s.near.missingAccounts.add(fresh.accountId);
      expect((await body(await activate(s.app, { accountId: fresh.accountId }))).created).toBe(true);
    }
  });

  it('reserves the activation’s Transfer amount in the budget (M2): 0.01 NEAR of gas + 0.01 transferred is past an app budget of 0.015', async () => {
    s.near.missingAccounts.add(s.user.accountId);
    const res = await activate(s.app, { accountId: s.user.accountId }, relayConfig({ activationYocto: (10n ** 22n).toString(), dailyBudgetNear: 1, appDailyBudgetNear: 0.015 }));
    expect([res.status, (await body(res)).code]).toEqual([429, 'app_budget_exhausted']);
    // Without the amount it fits.
    expect((await activate(s.app, { accountId: s.user.accountId }, relayConfig({ dailyBudgetNear: 1, appDailyBudgetNear: 0.015 }))).status).toBe(200);
  });

  it('sends the manifest’s activationYocto when set', async () => {
    s.near.missingAccounts.add(s.user.accountId);
    expect((await activate(s.app, { accountId: s.user.accountId }, relayConfig({ activationYocto: '1000' }))).status).toBe(200);
    expect(s.near.nearSent.at(-1)!.amount).toBe(1000n);
  });

  it('refuses the gate’s refusals, an unconfigured env, mainnet, a bad id', async () => {
    const b = { accountId: s.user.accountId };
    expect((await body(await activate(s.app, b, { NETWORK: 'mainnet' }))).code).toBe('relayer_unconfigured');
    expect((await body(await activate(s.app, b, undefined, appHeaders(s.app, 'https://evil.example')))).code).toBe('origin_not_allowed');
    expect((await body(await activate(s.app, { ...b, network: 'mainnet' }))).code).toBe('mainnet_not_allowed');
    expect((await body(await activate(s.app, { accountId: 'alice.testnet' }))).code).toBe('bad_request');
  });

  it('per IP: 10 a minute across apps; 2 a day per directory user', async () => {
    const headers = { ...appHeaders(s.app), 'cf-connecting-ip': '10.250.2.2' };
    let n = 0;
    for (; n < 11; n++) {
      const u = knownUser(s.app.scope);
      s.near.missingAccounts.add(u.accountId);
      if ((await activate(s.app, { accountId: u.accountId }, undefined, headers)).status === 429) break;
    }
    expect(n).toBe(10);
    // Accounts of one directory user past 2 a day: refused (an honest user needs one activation ever, plus a retry).
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const u = knownUser(s.app.scope, 'hu_one_user');
      s.near.missingAccounts.add(u.accountId);
      last = (await activate(s.app, { accountId: u.accountId })).status;
    }
    expect(last).toBe(429);
  });

  it('an account the directory doesn’t hold yet: 409 near_account_unrecorded, retryable (retry-after: 2), nothing sent; a failed read 503', async () => {
    const res = await activate(s.app, { accountId: newUser().accountId });
    const b = await body(res);
    expect([res.status, b.code, b.retryable, res.headers.get('retry-after')]).toEqual([409, 'near_account_unrecorded', true, '2']);
    nearDirectory.lookup = () => Promise.reject(new Error('D1 down'));
    expect((await body(await activate(s.app, { accountId: s.user.accountId }))).code).toBe('directory_unavailable');
    expect(s.near.nearSent.length).toBe(0);
  });

  it('per app 200 a day below the env’s 1000 (manifest activationsPerAppPerDay / activationsPerDay)', async () => {
    const one = knownUser(s.app.scope);
    const two = knownUser(s.app.scope);
    for (const u of [one, two]) s.near.missingAccounts.add(u.accountId);
    const perApp = relayConfig({ activationsPerAppPerDay: 1 });
    expect((await activate(s.app, { accountId: one.accountId }, perApp)).status).toBe(200);
    expect((await body(await activate(s.app, { accountId: two.accountId }, perApp))).error).toBe('Rate limit exceeded (per app)');
    // The env's window, filled to a cap of 2 (other tests in this file count in it too): any app is refused.
    const global = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('near-activate:global'));
    for (let i = 0; i < 2; i++) await global.hit([{ name: 'near-activate:day', windowMs: 86_400_000, max: 2 }]);
    const b = await setup();
    b.near.missingAccounts.add(b.user.accountId);
    expect((await body(await activate(b.app, { accountId: b.user.accountId }, relayConfig({ activationsPerAppPerDay: 1, activationsPerDay: 2 })))).error).toBe('Rate limit exceeded (across the env)');
  });
});

describe('in flight, balance and budget settlement (the review of 2026-11-11)', () => {
  it('the in-flight cap per key: inFlightNear over the keys at the largest hold; beyond it 503 relayer_busy, nothing sent', async () => {
    // sandbox-dev: 10 Tgas + 5 overhead at 10^8 × 12 = 0.018 NEAR a relay; 3 NEAR over 2 keys → 83 per key.
    expect(inFlightHold(15n * TGAS, 10n ** 8n)).toBe(18n * 10n ** 21n);
    expect(inFlightCapPerKey({ maxGas: 10n * TGAS, inFlightYocto: 3n * 10n ** 24n }, 5n * TGAS, 10n ** 8n, 2)).toBe(83);
    expect(inFlightCapPerKey({ maxGas: 10n * TGAS, inFlightYocto: 1n }, 5n * TGAS, 10n ** 8n, 2)).toBe(1);
    const s = await setup();
    const second = knownUser(s.app.scope);
    // One key only and a cap of 1: the first relay held in flight, the second refused.
    const bindings = { ...relayConfig({ inFlightNear: 0.000001 }), NEAR_RELAY_KEYS: JSON.stringify([(JSON.parse(env.NEAR_RELAY_KEYS!) as string[])[0]]) };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    s.near.onNearSend = () => held;
    const first = relay(s.app, plainRelay(delegate(s.user)), bindings);
    await new Promise((r) => setTimeout(r, 200));
    const res = await relay(s.app, plainRelay(delegate(second)), bindings);
    expect([res.status, (await body(res)).code, res.headers.get('retry-after')]).toEqual([503, 'relayer_busy', '1']);
    release();
    expect((await first).status).toBe(200);
    expect(s.near.nearSent.length).toBe(1);
  });

  it('a relay account short of balance (NotEnoughBalance): 502 near_rejected, and its reservation is kept', async () => {
    const s = await setup();
    s.near.nearRejection = { NotEnoughBalance: { signer_id: RELAY_ACCOUNT, balance: '1', cost: '2' } };
    const res = await relay(s.app, plainRelay(delegate(s.user)));
    expect([res.status, (await body(res)).code]).toEqual([502, 'near_rejected']);
    const r = (o: Partial<RelayResult>) => ({ ok: false, status: 502, code: 'near_rejected', error: 'x', ...o }) as RelayResult;
    expect(budgetSettlement(100n, r({ rejection: 'not_enough_balance' }))).toBe(0n);
    expect(budgetSettlement(100n, r({}))).toBe(100n);
    // A refusal after the broadcast started counts as sent (fail closed): that delegate is refused from now on, a re-signed one goes through.
    s.near.nearRejection = undefined;
    expect((await body(await relay(s.app, plainRelay(delegate(s.user))))).code).toBe('delegate_nonce_used');
    expect((await relay(s.app, plainRelay(delegate(s.user, { nonce: 102n })))).status).toBe(200);
  });

  it('settles a reservation: all back when nothing ran, less what burnt and what transferred, a spend above it charged', () => {
    const ok = (burnt: string) => ({ ok: true, result: null, nearTx: 'h', relayTokensBurnt: burnt }) as RelayResult;
    expect(budgetSettlement(100n, { ok: false, status: 503, code: 'relayer_busy', error: 'x' })).toBe(100n);
    expect(budgetSettlement(100n, { ok: false, status: 409, code: 'already_relayed', error: 'x' })).toBe(100n);
    expect(budgetSettlement(100n, ok('30'))).toBe(70n);
    // An activation's Transfer leaves the account too: never given back (M2).
    expect(budgetSettlement(100n, ok('30'), 50n)).toBe(20n);
    // Burnt above the reservation: charged (L2).
    expect(budgetSettlement(100n, ok('130'))).toBe(-30n);
    expect(budgetSettlement(100n, { ok: false, status: 504, code: 'timeout', error: 'x', nearTx: 'h' })).toBe(0n);
  });

  it('an env-wide per-minute relay window (manifest relaysPerMinute)', async () => {
    const a = await setup();
    const b = await setup();
    const bindings = relayConfig({ relaysPerMinute: 1 });
    // Other tests in this file count in the same minute window: fill it, then any app is refused.
    await relay(a.app, plainRelay(delegate(a.user)), bindings);
    const res = await relay(b.app, plainRelay(delegate(b.user)), bindings);
    expect([res.status, (await body(res)).error]).toEqual([429, 'Rate limit exceeded (across the env)']);
  });

  it('activate counts before the chain reads, "already exists" answers too (60 a minute per app, 5 per account first)', async () => {
    const s = await setup();
    let n = 0;
    for (; n < 61; n++) if ((await activate(s.app, { accountId: knownUser(s.app.scope).accountId })).status === 429) break;
    expect(n).toBe(60);
  });

  it('one account id, from many IPs, takes at most 5 of the app’s activation minute (L-B)', async () => {
    const s = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await activate(s.app, { accountId: s.user.accountId }, undefined, { ...appHeaders(s.app), 'cf-connecting-ip': `10.251.${i}.1` })).status);
    expect(codes.filter((c) => c === 200).length).toBe(5);
    // The app's minute holds 5: another account still activates, 55 times.
    let n = 0;
    for (; n < 56; n++) if ((await activate(s.app, { accountId: knownUser(s.app.scope).accountId })).status === 429) break;
    expect(n).toBe(55);
  });

  it('concurrent copies of one activation: both answer 200, one created, one created: false (L6)', async () => {
    const s = await setup();
    s.near.missingAccounts.add(s.user.accountId);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    s.near.onNearSend = () => held;
    const one = activate(s.app, { accountId: s.user.accountId });
    await new Promise((r) => setTimeout(r, 200));
    const two = activate(s.app, { accountId: s.user.accountId });
    await new Promise((r) => setTimeout(r, 200));
    release();
    const answers = await Promise.all([one, two].map(async (p) => body(await p)));
    expect(answers.map((a) => a.created).sort()).toEqual([false, true]);
    expect(s.near.nearSent.length).toBe(1);
  });

  it('copies of one request meet at one key object: the key index depends only on the sender', async () => {
    const u = newUser();
    expect(await keyIndexFor(u.accountId, 2)).toBe(await keyIndexFor(u.accountId, 2));
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) seen.add(await keyIndexFor(newUser().accountId, 2));
    expect([...seen].sort()).toEqual([0, 1]);
  });
});

describe('what raises the floor, and the limiter’s amounts (L-C, L-D)', () => {
  it('three states: certainly not sent only when the key object says so before a broadcast (or a copy); anything else counts as sent', () => {
    const no = (code: string, extra: Partial<RelayResult> = {}) => ({ ok: false, status: 500, code, error: 'x', ...extra }) as RelayResult;
    expect(certainlyNotSent({ ok: true, result: null, nearTx: 'h' })).toBe(false);
    for (const code of ['relayer_busy', 'relayer_unconfigured', 'relayer_unavailable', 'near_unavailable']) expect(certainlyNotSent(no(code, { notSent: true })), code).toBe(true);
    expect(certainlyNotSent(no('already_relayed'))).toBe(true);
    // Unknown is sent: the same codes without the key object's word, and everything after a broadcast.
    for (const code of ['relayer_unavailable', 'near_unavailable', 'relayer_busy', 'near_rejected', 'contract_rejected', 'delegate_rejected', 'timeout', 'near_error']) expect(certainlyNotSent(no(code)), code).toBe(false);
  });

  const marked = (sender: string, signed: Uint8Array) =>
    env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`near-relay:relayed:${sender}`)).reserve(hex(new Uint8Array(createHash('sha256').update(signed).digest())), Date.now(), Date.now()).then((free) => !free);

  it('an RPC error during send_tx counts as sent: the floor rises to the delegate’s nonce and the copy mark stays', async () => {
    const s = await setup();
    s.near.sendTxTransportError = 'network';
    const signed = delegate(s.user, { nonce: 150n });
    await relay(s.app, plainRelay(signed));
    s.near.sendTxTransportError = undefined;
    expect(await marked(s.user.accountId, signed)).toBe(true);
    const again = await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 150n, maxBlockHeight: 1101n }))));
    expect([again.code, again.accessKeyNonce]).toEqual(['delegate_nonce_used', '150']);
  });

  it('a relay refused in flight (relayer_busy) leaves the floor: the same signed delegate goes through later', async () => {
    const s = await setup();
    const bindings = { ...relayConfig({ inFlightNear: 0.000001 }), NEAR_RELAY_KEYS: JSON.stringify([(JSON.parse(env.NEAR_RELAY_KEYS!) as string[])[0]]) };
    let release!: () => void;
    // Created here, not inside the key object: a promise settled across Durable Objects is refused by workerd.
    const held = new Promise<void>((r) => (release = r));
    s.near.onNearSend = () => held;
    const first = relay(s.app, plainRelay(delegate(knownUser(s.app.scope))), bindings);
    await new Promise((r) => setTimeout(r, 200));
    const mine = plainRelay(delegate(s.user));
    expect((await body(await relay(s.app, mine, bindings))).code).toBe('relayer_busy');
    // Refused before any broadcast: the copy mark is gone and the floor unchanged.
    expect(await marked(s.user.accountId, Uint8Array.from(atob(mine.signedDelegateAction), (c) => c.charCodeAt(0)))).toBe(false);
    release();
    await first;
    s.near.onNearSend = undefined;
    expect((await relay(s.app, mine, bindings)).status).toBe(200);
  });

  it('a spend above the reservation is charged to the budgets (settleBudget)', async () => {
    const s = await setup();
    // A gas price of 1 yocto makes the reservation (35 Tgas × 1) far below what the mock burns.
    s.near.gasPrice = '1';
    expect((await relay(s.app, plainRelay(delegate(s.user)))).status).toBe(200);
    const burnt = BigInt(MOCK_TX_GAS.tokens_burnt) + 2n * BigInt(MOCK_RECEIPT_GAS.tokens_burnt);
    const spent = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`app:${s.app.id}`)).spend('near-relay:day', 86_400_000, (10n ** 30n).toString(), '0');
    expect(spent.spent).toBe(burnt.toString());
  });

  it('RateLimiter: charge adds whatever the total, never to an ended window; floor only grows', async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`limiter-units-${Math.random()}`));
    const now = Date.now();
    expect(await stub.spend('b', 60_000, '10', '8', now)).toMatchObject({ ok: true, spent: '8' });
    await stub.charge('b', 60_000, '5', now, now);
    expect(await stub.spend('b', 60_000, '100', '0', now)).toMatchObject({ ok: true, spent: '13' });
    expect(await stub.spend('b', 60_000, '10', '1', now)).toMatchObject({ ok: false, spent: '13' });
    await stub.charge('b', 60_000, '5', now - 120_000, now);
    await stub.charge('b', 60_000, '-3', now, now);
    expect(await stub.spend('b', 60_000, '100', '0', now)).toMatchObject({ spent: '13' });
    await stub.giveBack('b', 60_000, '20', now);
    expect(await stub.spend('b', 60_000, '100', '0', now)).toMatchObject({ spent: '0' });
    expect(await stub.floor('f')).toBe('0');
    await stub.raiseFloor('f', '5');
    await stub.raiseFloor('f', '3');
    expect(await stub.floor('f')).toBe('5');
    await stub.raiseFloor('f', '18446744073709551615');
    expect(await stub.floor('f')).toBe('18446744073709551615');
  });
});

describe('the key object (RelayerKey.relayNear)', () => {
  const job = (receiverId: string) => ({ receiverId, action: { kind: 'activate' as const, amount: 0n }, maxInFlight: 10 });

  it('refuses to sign off testnet whatever its caller checked, and serves one role for its life', async () => {
    const { near } = await vaultSetup();
    const u = newUser();
    near.missingAccounts.add(u.accountId);
    const stub = env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(`${nearRelayKeyName(0)}-role-test-${Math.random()}`));
    const offTestnet = await runInDurableObject(stub, async (instance: RelayerKey) => {
      const self = instance as unknown as { env: typeof env };
      const saved = self.env;
      self.env = { ...saved, NETWORK: 'mainnet' };
      try {
        return await instance.relayNear(0, job(u.accountId));
      } finally {
        self.env = saved;
      }
    });
    expect(offTestnet).toMatchObject({ ok: false, code: 'relayer_unconfigured' });
    // A NEAR relay object never relays for a pool, nor a pool object for the NEAR relay.
    expect(await stub.relayNear(0, job(u.accountId))).toMatchObject({ ok: true });
    expect(await stub.relay('session', 0, { method: 'derive_key', args: {} })).toMatchObject({ ok: false, code: 'relayer_unavailable' });
    const pool = env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(`relayer-key-0-role-test-${Math.random()}`));
    near.contract.revoke_session = () => true;
    await pool.relay('session', 0, { method: 'revoke_session', args: {} });
    expect(await pool.relayNear(0, job(newUser().accountId))).toMatchObject({ ok: false, code: 'relayer_unavailable' });
    // Every transaction named its own account: the pools' RELAYER_ACCOUNT, the NEAR relay's account (the mock refuses others).
    expect(near.nearSent.map((t) => t.signerId)).toEqual([RELAY_ACCOUNT]);
    expect(near.sent.map((t) => t.signerId)).toEqual([env.RELAYER_ACCOUNT]);
  });
});

describe('the hourly funds check (near_relay_balance_low)', () => {
  it('writes one event a day when the relay account is below lowBalanceNear or missing, nothing when funded or off', async () => {
    const { near } = await vaultSetup();
    await env.DB.exec("DELETE FROM security_events WHERE kind = 'near_relay_balance_low'");
    near.balances.set(RELAY_ACCOUNT, (10n ** 25n).toString());
    expect(await checkNearRelayFunds(env)).toBe(0);
    near.balances.set(RELAY_ACCOUNT, (10n ** 24n).toString());
    expect(await checkNearRelayFunds(env)).toBe(1);
    expect(await checkNearRelayFunds(env)).toBe(0);
    near.missingAccounts.add(RELAY_ACCOUNT);
    expect(await checkNearRelayFunds(env, Date.now() + 86_400_000)).toBe(1);
    expect(await checkNearRelayFunds({ ...env, NEAR_RELAY: undefined })).toBe(0);
    expect(await checkNearRelayFunds({ ...env, NETWORK: 'mainnet' })).toBe(0);
    const rows = await env.DB.prepare("SELECT detail_json FROM security_events WHERE kind = 'near_relay_balance_low' ORDER BY detected_at").all<{ detail_json: string }>();
    expect(rows.results.map((r) => JSON.parse(r.detail_json).missing)).toEqual([false, true]);
  });
});
