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
import { identityMessage } from '@hana-id/core/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64Encode, hex } from '../src/bytes.ts';
import { decodeSignedDelegate, encodeRelayTransaction, MAX_SIGNED_DELEGATE_BYTES, policyRefusal, TGAS, verifyDelegateSignature } from '../src/near/delegate.ts';
import { checkNearRelayFunds } from '../src/near/relay-funds.ts';
import { NEAR_RELAY_DEFAULTS, nearRelayVar, parseNearRelayConfig } from '../src/near/relay-config.ts';
import { defaultNearAccountLookup, delegateFailure, nearActivatePayload, nearAccountKnown, nearDirectory, nearRelayPayload, toActivateRequest, toRelayRequest } from '../src/near/relay.ts';
import { appHeaders, call, type Chain, newSessionKey, ORIGIN, sessionKeyPair, type SeededApp } from './helpers.ts';
import { spentSession, vaultHeaders, vaultSetup } from './vault-helpers.ts';

const GUESTBOOK = 'guestbook.test.near';
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

/** The session proof the vault sends with each request (D735), over `payload`. */
function proof(app: { id: string }, spk: number[], payload: Uint8Array, o: { issuedAtMs?: number; signWith?: number[] } = {}) {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: Uint8Array.from(spk), issuedAtMs, nonce, payload });
  return { sessionPublicKey: spk, issuedAtMs, nonce: [...nonce], signature: [...sessionKeyPair(o.signWith ?? spk).sign(message).signature] };
}

async function relayBody(app: { id: string }, spk: number[], signed: Uint8Array, o: { network?: string; issuedAtMs?: number; signWith?: number[] } = {}) {
  const network = o.network ?? 'testnet';
  return { network, signedDelegateAction: base64Encode(signed), ...proof(app, spk, await nearRelayPayload(network, signed), o) };
}

function activateBody(app: { id: string }, spk: number[], accountId: string, network = 'testnet') {
  return { network, accountId, ...proof(app, spk, nearActivatePayload(network, accountId)) };
}

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
beforeEach(() => {
  nearDirectory.lookup = async (_db, q) => {
    const userId = directory.get(`${q.scopeId}#${q.accountId}`);
    return userId ? { userId } : null;
  };
});
afterEach(() => {
  nearDirectory.lookup = defaultNearAccountLookup;
  directory.clear();
});

/** A user known to the directory for `scope` (relay and activate need it with requireKnownAccount, the default). */
function knownUser(scope: string, userId?: string): User {
  const u = newUser();
  remember(scope, u.accountId, userId);
  return u;
}

async function setup(): Promise<{ app: SeededApp; near: Chain; spk: number[]; user: User }> {
  const { app, near } = await vaultSetup();
  const spk = spentSession(near, app.scope, { sub: `near-${Math.random().toString(36).slice(2)}` });
  return { app, near, spk, user: knownUser(app.scope) };
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
  it('take only their fields; network optional; the session proof all or nothing', async () => {
    const user = newUser();
    const spk = newSessionKey();
    const signed = delegate(user);
    expect(toRelayRequest({ signedDelegateAction: base64Encode(signed) })).toMatchObject({ network: 'testnet', proof: null });
    expect(toRelayRequest(plainRelay(signed, 'mainnet'))).toMatchObject({ network: 'mainnet' });
    const b = await relayBody({ id: 'app_x' }, spk, signed);
    expect(toRelayRequest(b)?.proof).not.toBeNull();
    expect(toRelayRequest({ ...b, extra: 1 })).toBeNull();
    const { signature: _s, ...partial } = b;
    expect(toRelayRequest(partial)).toBeNull();
    expect(toRelayRequest({ ...b, nonce: [1, 2, 3] })).toBeNull();
    expect(toRelayRequest({ signedDelegateAction: `${base64Encode(signed)}=` })).toBeNull();
    expect(toRelayRequest({ signedDelegateAction: 'not base64!' })).toBeNull();
    expect(toRelayRequest({ network: 5, signedDelegateAction: base64Encode(signed) })).toBeNull();
    expect(toActivateRequest({ accountId: user.accountId })).toMatchObject({ accountId: user.accountId, network: 'testnet', proof: null });
    expect(toActivateRequest(activateBody({ id: 'app_x' }, spk, user.accountId))?.proof).not.toBeNull();
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
    // The same signed delegate again: its key object relayed it already (claims, D455).
    expect((await body(await relay(s.app, plainRelay(signed)))).code).toBe('already_relayed');
  });

  it('takes the vault too, with the session proof (then also counted per user)', async () => {
    const res = await relay(s.app, await relayBody(s.app, s.spk, delegate(s.user)), undefined, vaultHeaders(s.app));
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
    ] as Partial<typeof env>[]) {
      const res = await relay(s.app, b, bindings);
      expect([res.status, (await body(res)).code], JSON.stringify(bindings)).toEqual([503, 'relayer_unconfigured']);
    }
    expect(s.near.nearSent.length).toBe(0);
  });

  it('refuses mainnet, another network, a malformed body; with a proof: stale, by another key, over other bytes', async () => {
    const signed = delegate(s.user);
    expect((await body(await relay(s.app, plainRelay(signed, 'mainnet')))).code).toBe('mainnet_not_allowed');
    expect((await body(await relay(s.app, plainRelay(signed, 'betanet')))).code).toBe('bad_request');
    expect((await body(await relay(s.app, { ...plainRelay(signed), extra: true }))).code).toBe('bad_request');
    expect((await body(await relay(s.app, await relayBody(s.app, s.spk, signed, { issuedAtMs: Date.now() - 120_000 })))).code).toBe('stale_proof');
    expect((await body(await relay(s.app, await relayBody(s.app, s.spk, signed, { signWith: newSessionKey() })))).code).toBe('invalid_signature');
    const other = await relayBody(s.app, s.spk, delegate(s.user, { nonce: 999n }));
    expect((await body(await relay(s.app, { ...other, signedDelegateAction: base64Encode(signed) }))).code).toBe('invalid_signature');
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

  it('with a proof: needs a live session of the app’s scope, and each proof once', async () => {
    const res = await relay(s.app, await relayBody(s.app, newSessionKey(), delegate(s.user)));
    expect([res.status, (await body(res)).code]).toEqual([410, 'session_ended']);
    const other = spentSession(s.near, 'another-scope');
    expect((await body(await relay(s.app, await relayBody(s.app, other, delegate(s.user))))).code).toBe('scope_mismatch');
    const once = await relayBody(s.app, s.spk, delegate(s.user));
    expect((await relay(s.app, once)).status).toBe(200);
    expect((await body(await relay(s.app, once))).code).toBe('proof_replayed');
  });

  it('reads the chain before paying: account missing, key missing, nonce used or too large, expired or too far ahead', async () => {
    const cases: [() => void, Uint8Array, string][] = [
      [() => s.near.missingAccounts.add(s.user.accountId), delegate(s.user), 'account_not_activated'],
      [() => s.near.missingKeys.add(s.user.accountId), delegate(s.user), 'access_key_missing'],
      [() => s.near.akNonce.set(s.user.keyPair.getPublicKey().toString(), 101n), delegate(s.user, { nonce: 101n }), 'delegate_nonce_used'],
      [() => undefined, delegate(s.user, { nonce: 1001n * 1_000_000n }), 'delegate_nonce_too_large'],
      [() => undefined, delegate(s.user, { maxBlockHeight: 1002n }), 'delegate_expired'],
      [() => undefined, delegate(s.user, { maxBlockHeight: 2001n }), 'block_height_too_far'],
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
    expect((await relay(s.app, plainRelay(delegate(s.user, { nonce: 999n * 1_000_000n + 7n })))).status).toBe(200);
  });

  it('answers a failed inner call as 422 contract_rejected, a refused delegate as 422 delegate_rejected', async () => {
    s.near.onNearTx = () => ({ failIn: 'receiver', failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: Text is too long' } } } } });
    let b = await body(await relay(s.app, plainRelay(delegate(s.user))));
    expect([b.code, b.status, b.executor, typeof b.transactionHash]).toEqual(['contract_rejected', 'failed', GUESTBOOK, 'string']);
    s.near.onNearTx = () => ({ failIn: 'sender', failure: { ActionError: { index: 0, kind: 'DelegateActionExpired' } } });
    b = await body(await relay(s.app, plainRelay(delegate(s.user, { nonce: 102n }))));
    expect([b.code, b.reason, b.status]).toEqual(['delegate_rejected', 'expired', 'failed']);
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
    // The refused request took nothing from `other`'s window: another app relays for it at once.
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

  it('sends the manifest’s activationYocto when set', async () => {
    s.near.missingAccounts.add(s.user.accountId);
    expect((await activate(s.app, { accountId: s.user.accountId }, relayConfig({ activationYocto: '1000' }))).status).toBe(200);
    expect(s.near.nearSent.at(-1)!.amount).toBe(1000n);
  });

  it('refuses the gate’s refusals, an unconfigured env, mainnet, a bad id; a proof is checked when present', async () => {
    const b = { accountId: s.user.accountId };
    expect((await body(await activate(s.app, b, { NETWORK: 'mainnet' }))).code).toBe('relayer_unconfigured');
    expect((await body(await activate(s.app, b, undefined, appHeaders(s.app, 'https://evil.example')))).code).toBe('origin_not_allowed');
    expect((await body(await activate(s.app, { ...b, network: 'mainnet' }))).code).toBe('mainnet_not_allowed');
    expect((await body(await activate(s.app, { accountId: 'alice.testnet' }))).code).toBe('bad_request');
    const proven = activateBody(s.app, s.spk, s.user.accountId);
    expect((await body(await activate(s.app, { ...proven, accountId: knownUser(s.app.scope).accountId }))).code).toBe('invalid_signature');
    expect((await activate(s.app, proven)).status).toBe(200);
    expect((await body(await activate(s.app, proven))).code).toBe('proof_replayed');
  });

  it('per IP: 10 a minute across apps; 5 a day per directory user; with a proof also per session user', async () => {
    const headers = { ...appHeaders(s.app), 'cf-connecting-ip': '10.250.2.2' };
    let n = 0;
    for (; n < 11; n++) {
      const u = knownUser(s.app.scope);
      s.near.missingAccounts.add(u.accountId);
      if ((await activate(s.app, { accountId: u.accountId }, undefined, headers)).status === 429) break;
    }
    expect(n).toBe(10);
    // Six accounts of one directory user: the sixth is refused.
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const u = knownUser(s.app.scope, 'hu_one_user');
      s.near.missingAccounts.add(u.accountId);
      last = (await activate(s.app, { accountId: u.accountId })).status;
    }
    expect(last).toBe(429);
    // With the directory off, a session proof still counts per user.
    const off = relayConfig({ requireKnownAccount: false });
    for (let i = 0; i < 6; i++) {
      const u = newUser();
      s.near.missingAccounts.add(u.accountId);
      last = (await activate(s.app, activateBody(s.app, s.spk, u.accountId), off)).status;
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
