// Message schemas (docs/batch-b-spec.md "Protocol"): v === 1, allow-listed types and methods, exact field sets and
// types, size caps (192 KiB sign, 8 KiB other). Includes a small fuzz pass: mutated messages never throw and are
// either refused or still valid.
import { describe, expect, it } from 'vitest';
import { base64Encode, toHex } from '../src/bytes.ts';
import { type ApprovalDigestInput, approvalContextString, approvalDigest } from '../src/approval.ts';
import {
  APPROVAL_KIND,
  APPROVAL_POPUP_METHODS,
  ErrorCode,
  MESSAGE_MAX_BYTES,
  PORT_METHODS,
  type PortRequest,
  SIGN_MESSAGE_MAX_BYTES,
  type WindowMessageType,
  approvalChain,
  approvalContent,
  isOrigin,
  messageSize,
  newRequestId,
  parsePortEvent,
  parsePortReply,
  parsePortRequest,
  parseVaultBroadcast,
  parseWindowMessage,
  unsupportedMethodId,
} from '../src/protocol.ts';
import { evmTxSigningPayload, parseEvmTxRequest } from '../src/signers/evm.ts';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const XDR = base64Encode(new Uint8Array([0, 0, 0, 2, 1, 2, 3, 4]));
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0x0', data: '0x' };
const TESTNET = 'Test SDF Network ; September 2015';

const req = (method: string, params?: unknown, id = 'r1') => (params === undefined ? { v: 1, id, method } : { v: 1, id, method, params });

const VALID_PARAMS: Record<(typeof PORT_METHODS)[number], unknown> = {
  hana_status: undefined,
  hana_login: { popupBlocked: true },
  hana_cancelLogin: undefined,
  hana_logout: undefined,
  hana_export: { chain: 'evm' },
  hana_revokeOtherDevices: undefined,
  stellar_getAddress: undefined,
  stellar_signTransaction: { xdr: XDR, networkPassphrase: TESTNET, address: G },
  stellar_signAuthEntry: { preimageXdr: XDR, networkPassphrase: TESTNET },
  stellar_signMessage: { message: new Uint8Array([1, 2]) },
  eth_accounts: [],
  eth_signTransaction: { tx: TX },
  personal_sign: ['0x68656c6c6f', EVM],
  eth_signTypedData_v4: [EVM, '{"types":{}}'],
  hana_signRaw: { chain: 'evm', digest: new Uint8Array(32) },
  hana_requestAutoApprove: undefined,
  hana_autoApproveStatus: undefined,
  hana_revokeAutoApprove: undefined,
  hana_identityToken: { maxAgeMs: 60_000 },
  hana_account: undefined,
  hana_linkAccount: { method: 'email' },
};

describe('port requests', () => {
  it.each(PORT_METHODS)('accepts a valid %s', (method) => {
    const parsed = parsePortRequest(req(method, VALID_PARAMS[method]));
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe(method);
  });

  it('normalises no-params methods ([] or absent) to undefined, and refuses {} or other values', () => {
    expect(parsePortRequest(req('eth_accounts', []))!.params).toBeUndefined();
    expect(parsePortRequest(req('hana_status'))!.params).toBeUndefined();
    expect(parsePortRequest(req('hana_status', {}))).toBeNull();
    expect(parsePortRequest(req('hana_logout', [1]))).toBeNull();
    expect(parsePortRequest(req('hana_login'))!.params).toBeUndefined();
  });

  it('hana_login takes a method and, unless it is Google, an email hint (batch 8a)', () => {
    for (const p of [{ method: 'email' }, { method: 'google' }, { method: 'email', emailHint: 'ada@example.com' }, { emailHint: 'ada@example.com' }, { popupBlocked: true, method: 'email' }]) {
      expect(parsePortRequest(req('hana_login', p))!.params, JSON.stringify(p)).toEqual(p);
    }
  });

  it.each([
    ['v 2', { v: 2, id: 'a', method: 'hana_status' }],
    ['no id', { v: 1, method: 'hana_status' }],
    ['an empty id', { v: 1, id: '', method: 'hana_status' }],
    ['a 65-char id', { v: 1, id: 'x'.repeat(65), method: 'hana_status' }],
    ['a numeric id', { v: 1, id: 1, method: 'hana_status' }],
    ['an extra field', { v: 1, id: 'a', method: 'hana_status', extra: 1 }],
    ['an undefined params key with another', { v: 1, id: 'a', method: 'hana_export', params: { chain: 'evm', key: new Uint8Array(32) } }],
    ['an unknown method', { v: 1, id: 'a', method: 'eth_sign', params: [] }],
    ['an array', [1, 'a']],
    ['null', null],
    ['a string', 'hana_status'],
    ['a class instance', Object.assign(new (class X {})(), { v: 1, id: 'a', method: 'hana_status' })],
  ])('refuses %s', (_, data) => {
    expect(parsePortRequest(data)).toBeNull();
  });

  it.each([
    ['hana_export', { chain: 'solana' }],
    ['stellar_signTransaction', { xdr: 'not base64', networkPassphrase: TESTNET }],
    ['stellar_signTransaction', { xdr: XDR, networkPassphrase: '' }],
    ['stellar_signTransaction', { xdr: XDR, networkPassphrase: TESTNET, address: EVM }],
    ['stellar_signAuthEntry', { preimageXdr: XDR }],
    ['stellar_signMessage', { message: 42 }],
    ['eth_signTransaction', { tx: { ...TX, gasLimit: '0x1' } }],
    ['eth_signTransaction', { tx: { ...TX, nonce: 1 } }],
    ['personal_sign', ['hello', EVM]],
    ['personal_sign', ['0x68', G]],
    ['eth_signTypedData_v4', [EVM, { types: {} }]],
    ['hana_signRaw', { chain: 'evm', digest: new Uint8Array(31) }],
    ['hana_signRaw', { chain: 'evm', bytes: new Uint8Array(32) }],
    ['hana_signRaw', { chain: 'stellar', bytes: new Uint8Array(4097) }],
    ['hana_signRaw', { chain: 'stellar', bytes: [1, 2, 3] }],
    ['hana_login', { popupBlocked: 'yes' }],
    ['hana_login', { method: 'apple' }],
    ['hana_login', { method: 'google', emailHint: 'ada@example.com' }],
    ['hana_login', { method: 'email', emailHint: 'not-an-address' }],
    ['hana_login', { method: 'email', emailHint: 'a\nb@example.com' }],
    ['hana_login', { method: 'email', extra: 1 }],
  ])('refuses %s with bad params %j', (method, params) => {
    expect(parsePortRequest(req(method, params))).toBeNull();
  });

  it.each(APPROVAL_POPUP_METHODS)('accepts popupOpened: true on %s and keeps it (D99)', (method) => {
    const parsed = parsePortRequest({ ...req(method, VALID_PARAMS[method]), popupOpened: true });
    expect(parsed).not.toBeNull();
    expect(parsed!.popupOpened).toBe(true);
    expect(parsePortRequest(req(method, VALID_PARAMS[method]))!.popupOpened).toBeUndefined();
  });

  it('refuses popupOpened on methods that never show the approval popup, and any value but true', () => {
    for (const method of PORT_METHODS.filter((m) => !(APPROVAL_POPUP_METHODS as readonly string[]).includes(m))) {
      expect(parsePortRequest({ ...req(method, VALID_PARAMS[method]), popupOpened: true })).toBeNull();
    }
    for (const value of [false, 1, 'true', null, {}]) expect(parsePortRequest({ ...req('personal_sign', VALID_PARAMS.personal_sign), popupOpened: value })).toBeNull();
  });

  it('answers 4200 only to well-formed requests for unknown methods', () => {
    expect(unsupportedMethodId({ v: 1, id: 'q', method: 'eth_sign', params: [] })).toBe('q');
    expect(unsupportedMethodId({ v: 1, id: 'q', method: 'hana_status' })).toBeNull();
    expect(unsupportedMethodId({ v: 2, id: 'q', method: 'eth_sign' })).toBeNull();
    expect(unsupportedMethodId({ v: 1, id: 'q', method: 'eth_sign', junk: 1 })).toBeNull();
  });

  it('caps sign requests at 192 KiB and the rest at 8 KiB', () => {
    const big = new Uint8Array(SIGN_MESSAGE_MAX_BYTES - 200);
    expect(parsePortRequest(req('stellar_signMessage', { message: big }))).not.toBeNull();
    expect(parsePortRequest(req('stellar_signMessage', { message: new Uint8Array(SIGN_MESSAGE_MAX_BYTES + 1) }))).toBeNull();
    expect(parsePortRequest({ v: 1, id: 'x'.repeat(64), method: 'hana_export', params: { chain: 'evm' } })).not.toBeNull();
    expect(parsePortRequest(req('hana_login', { popupBlocked: true }, 'y'.repeat(64)))).not.toBeNull();
    expect(messageSize({ a: 'x'.repeat(MESSAGE_MAX_BYTES) }, MESSAGE_MAX_BYTES)).toBe(Number.POSITIVE_INFINITY);
    // A maximum-size Soroban transaction (132 096 bytes, ~176 K base64 characters) fits the sign cap.
    const sorobanMax = base64Encode(new Uint8Array(132_096));
    expect(parsePortRequest(req('stellar_signTransaction', { xdr: sorobanMax, networkPassphrase: TESTNET }))).not.toBeNull();
    // Strings count as UTF-8.
    expect(messageSize('é'.repeat(10), 100)).toBe(20);
    expect(messageSize('€', 100)).toBe(3);
  });

  it('messageSize refuses cycles, deep nesting and non-cloneable-plain values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageSize(cyclic, 1e6)).toBe(Number.POSITIVE_INFINITY);
    let deep: unknown = 1;
    for (let i = 0; i < 30; i++) deep = [deep];
    expect(messageSize(deep, 1e6)).toBe(Number.POSITIVE_INFINITY);
    for (const v of [new Map(), new Date(), new ArrayBuffer(4), () => 1, Symbol('x'), 1n]) expect(messageSize({ v }, 1e6)).toBe(Number.POSITIVE_INFINITY);
    expect(messageSize({ a: new Uint8Array(10), b: [1, 'ab'] }, 1e6)).toBeLessThan(100);
  });
});

describe('port replies', () => {
  const addresses = { stellar: G, evm: EVM };

  it.each([
    ['hana_status', { status: 'logged_in', addresses, expiresAtMs: 1, persistence: 'session' }],
    ['hana_status', { status: 'logged_out', persistence: 'none' }],
    ['hana_login', { addresses, expiresAtMs: 5, persistence: 'none', warning: 'storage_unavailable', timings: { chainMs: 4 } }],
    ['hana_logout', null],
    ['hana_revokeOtherDevices', { revoked: 2 }],
    ['stellar_getAddress', { address: G }],
    ['stellar_signTransaction', { signedTxXdr: XDR, signerAddress: G }],
    ['stellar_signAuthEntry', { signedAuthEntry: base64Encode(new Uint8Array(64)), signerAddress: G }],
    ['stellar_signMessage', { signedMessage: base64Encode(new Uint8Array(64)), signerAddress: G }],
    ['eth_accounts', [EVM]],
    ['eth_accounts', []],
    ['eth_signTransaction', '0x02f8'],
    ['personal_sign', `0x${'ab'.repeat(65)}`],
    ['eth_signTypedData_v4', `0x${'ab'.repeat(65)}`],
    ['hana_signRaw', { signature: new Uint8Array(64) }],
    ['hana_signRaw', { signature: Uint8Array.from({ length: 65 }, (_, i) => (i === 64 ? 28 : 1)) }],
    ['hana_requestAutoApprove', { granted: true, policyId: 'a'.repeat(64), expiresAtMs: 9 }],
    ['hana_autoApproveStatus', null],
    ['hana_autoApproveStatus', { policyId: 'b'.repeat(64), label: 'Swaps', expiresAtMs: 1, used: { count: 3, native: '1000' } }],
  ] as const)('accepts a %s result', (method, result) => {
    expect(parsePortReply({ v: 1, id: 'a', result }, method)).toEqual({ v: 1, id: 'a', result });
  });

  it.each([
    ['hana_status', { status: 'logged_in', persistence: 'session' }],
    ['hana_status', { status: 'logged_out', persistence: 'session', addresses }],
    ['hana_login', { addresses: { stellar: EVM, evm: G }, expiresAtMs: 5, persistence: 'none' }],
    ['hana_login', { addresses, expiresAtMs: 5, persistence: 'none', prk: new Uint8Array(32) }],
    ['stellar_signAuthEntry', { signedAuthEntry: base64Encode(new Uint8Array(63)), signerAddress: G }],
    ['personal_sign', '0x1234'],
    ['hana_signRaw', { signature: Uint8Array.from({ length: 65 }, () => 1) }],
    ['eth_accounts', [EVM, EVM]],
    ['hana_logout', undefined],
  ] as const)('refuses a bad %s result', (method, result) => {
    expect(parsePortReply({ v: 1, id: 'a', result }, method)).toBeNull();
  });

  it('accepts known error codes only, with an exact error shape', () => {
    expect(parsePortReply({ v: 1, id: 'a', error: { code: 4001, message: 'User rejected' } }, 'personal_sign')).toMatchObject({ error: { code: ErrorCode.userRejected } });
    expect(parsePortReply({ v: 1, id: 'a', error: { code: 'token_has_pii', message: 'x', data: { claim: 'email' } } }, 'hana_login')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', error: { code: 4321, message: 'x' } }, 'hana_login')).toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', error: { code: 'nope', message: 'x' } }, 'hana_login')).toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', error: { code: 4001 } }, 'hana_login')).toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', result: null, error: { code: 4001, message: '' } }, 'hana_logout')).toBeNull();
  });
});

describe('port events', () => {
  it.each([
    [{ v: 1, event: 'ready', data: { status: 'logged_out', persistence: 'none', warning: 'storage_unavailable' } }],
    [{ v: 1, event: 'accountsChanged', data: { addresses: null } }],
    [{ v: 1, event: 'disconnect', data: { code: 4900 } }],
    [{ v: 1, event: 'sessionExpired', data: null }],
    [{ v: 1, event: 'sessionExpired' }],
    [{ v: 1, event: 'connected', data: null }],
    [{ v: 1, event: 'connected' }],
    [{ v: 1, event: 'loginProgress', data: { stage: 'chain' } }],
    [{ v: 1, event: 'loginProgress', data: { stage: 'key_pending' } }],
    [{ v: 1, event: 'ui', data: { launcher: 'show', label: 'Review in Hana' } }],
    [{ v: 1, event: 'autoApproved', data: { kind: 'eth_signTransaction', chain: 'evm', contract: EVM, function: 'swap' } }],
    [{ v: 1, event: 'persistenceChanged', data: { persistence: 'none' } }],
    [{ v: 1, event: 'approvalWindow', data: { open: true } }],
    [{ v: 1, event: 'approvalWindow', data: { open: false } }],
  ])('accepts %j', (data) => {
    expect(parsePortEvent(data)).not.toBeNull();
  });

  it.each([
    [{ v: 1, event: 'connect', data: null }],
    [{ v: 1, event: 'toString', data: null }],
    [{ v: 1, event: 'loginProgress', data: { stage: 'nope' } }],
    [{ v: 1, event: 'ui', data: { launcher: 'show' } }],
    [{ v: 1, event: 'ready', data: { status: 'logged_in', persistence: 'none' } }],
    [{ v: 1, event: 'disconnect', data: { code: 4900, reason: 'x' } }],
    [{ v: 1, event: 'autoApproved', data: { kind: 'hana_logout', chain: 'evm', contract: EVM, function: 'swap' } }],
    [{ v: 1, event: 'persistenceChanged', data: { persistence: 'forever' } }],
    [{ v: 1, event: 'persistenceChanged', data: { persistence: 'none', reason: 'share' } }],
    [{ v: 1, event: 'persistenceChanged', data: null }],
    [{ v: 1, event: 'approvalWindow', data: { open: 'yes' } }],
    [{ v: 1, event: 'approvalWindow', data: { open: true, name: 'hana-approve-x' } }],
    [{ v: 1, event: 'approvalWindow', data: null }],
    [{ v: 1, event: 'connected', data: {} }],
    [{ v: 1, event: 'connected', data: { status: 'logged_out' } }],
  ])('refuses %j', (data) => {
    expect(parsePortEvent(data)).toBeNull();
  });
});

const AUTH_PARAMS = {
  v: 1,
  t: 'hana:auth-params',
  pk: 'pk_test_3yZe7d5AqbgrQ8LzVc3qbQ4bHkZ',
  appName: 'Partner',
  parentOrigin: 'https://partner.example',
  scopeId: 's1',
  signer: 'hana-signer.testnet',
  clientId: 'hana-shared.apps.googleusercontent.com',
  mode: 'shared',
  sessionPublicKey: new Uint8Array(32),
  expiresAtMs: 1_800_000_000_000,
  salt: new Uint8Array(32),
  keyIndex: 0,
  maxUses: 1,
  nonce: 'n'.repeat(43),
  relayId: 'r'.repeat(43),
  relayKey: new Uint8Array(32),
};

const APPROVE_REQUEST = {
  v: 1,
  t: 'hana:approve-request',
  id: newRequestId(),
  appName: 'Partner',
  parentOrigin: 'https://partner.example',
  kind: 'stellar_tx',
  chain: 'stellar',
  address: G,
  bytes: new Uint8Array([1, 2, 3]),
  context: { networkPassphrase: TESTNET },
  position: 1,
  queued: 2,
};

const VALID_WINDOW: Record<WindowMessageType, Record<string, unknown>> = {
  'hana:hello': { v: 1, t: 'hana:hello', sdk: '0.0.0' },
  'hana:auth-hello': { v: 1, t: 'hana:auth-hello' },
  'hana:auth-params': AUTH_PARAMS,
  'hana:auth-progress': { v: 1, t: 'hana:auth-progress', stage: 'email_code' },
  'hana:approve-hello': { v: 1, t: 'hana:approve-hello' },
  'hana:approve-request': APPROVE_REQUEST,
  'hana:approve-result': { v: 1, t: 'hana:approve-result', id: newRequestId(), approved: true, digest: new Uint8Array(32) },
  'hana:approve-bye': { v: 1, t: 'hana:approve-bye' },
  'hana:approve-close': { v: 1, t: 'hana:approve-close' },
  'hana:export-hello': { v: 1, t: 'hana:export-hello' },
  'hana:export-end': { v: 1, t: 'hana:export-end' },
  'hana:export-context': {
    v: 1,
    t: 'hana:export-context',
    pk: AUTH_PARAMS.pk,
    appName: 'Partner',
    parentOrigin: 'https://partner.example',
    scopeId: 's1',
    signer: 'hana-signer.testnet',
    keyIndex: 0,
    chain: 'evm',
    address: EVM,
  },
  'hana:consent-request': {
    v: 1,
    t: 'hana:consent-request',
    id: newRequestId(),
    appName: 'Partner',
    parentOrigin: 'https://partner.example',
    policy: { v: 1, label: 'Swaps' },
    policyId: 'a'.repeat(64),
    expiresAtMs: 1_800_000_000_000,
    position: 1,
    queued: 1,
  },
  'hana:consent-result': { v: 1, t: 'hana:consent-result', id: newRequestId(), allowed: true, digest: new Uint8Array(32) },
  'hana:auto-approve-stop': { v: 1, t: 'hana:auto-approve-stop' },
};
const TYPES = Object.keys(VALID_WINDOW) as WindowMessageType[];

describe('window messages', () => {
  it.each(TYPES)('accepts a valid %s when allowed, and refuses it otherwise', (t) => {
    expect(parseWindowMessage(VALID_WINDOW[t], [t])).not.toBeNull();
    expect(parseWindowMessage(VALID_WINDOW[t], TYPES.filter((x) => x !== t))).toBeNull();
  });

  it.each(TYPES)('%s: refuses v 2, an extra field (including key-like ones) and a missing field', (t) => {
    const m = VALID_WINDOW[t];
    expect(parseWindowMessage({ ...m, v: 2 }, [t])).toBeNull();
    for (const extra of ['prk', 'seed', 'idToken', 'secret', 'x']) expect(parseWindowMessage({ ...m, [extra]: new Uint8Array(32) }, [t])).toBeNull();
    const keys = Object.keys(m).filter((k) => k !== 'v' && k !== 't');
    for (const k of keys) {
      const { [k]: _, ...rest } = m;
      expect(parseWindowMessage(rest, [t])).toBeNull();
    }
  });

  it.each([
    ['a 31-byte relayKey', { relayKey: new Uint8Array(31) }],
    ['a relayKey as number array', { relayKey: Array.from(new Uint8Array(32)) }],
    ['a short nonce', { nonce: 'n'.repeat(42) }],
    ['a bad relayId', { relayId: `${'r'.repeat(42)}=` }],
    ['key_index ≥ 2^31', { keyIndex: 0x80000000 }],
    ['max_uses 0', { maxUses: 0 }],
    ['a 15-byte salt', { salt: new Uint8Array(15) }],
    ['a path-like origin', { parentOrigin: 'https://partner.example/' }],
    ['an unknown mode', { mode: 'partner' }],
    ['a bad signer', { signer: 'Hana Signer' }],
    ['a bad pk', { pk: 'sk_live_abc' }],
    ['an over-long appName', { appName: 'x'.repeat(201) }],
  ])('auth-params refuses %s', (_, change) => {
    expect(parseWindowMessage({ ...AUTH_PARAMS, ...change }, ['hana:auth-params'])).toBeNull();
  });

  // Email login (batch 8a): the offered methods ride only when email is among them; a Google-only message is batch B's.
  it('auth-params takes the email methods, a preselected method and an email hint', () => {
    for (const extra of [
      { methods: ['google', 'email'] },
      { methods: ['google', 'email'], method: 'email' },
      { methods: ['google', 'email'], method: 'google' },
      { methods: ['google', 'email'], method: 'email', emailHint: 'ada@example.com' },
      { methods: ['google', 'email'], emailHint: 'ada@example.com' },
    ]) {
      expect(parseWindowMessage({ ...AUTH_PARAMS, ...extra }, ['hana:auth-params']), JSON.stringify(extra)).not.toBeNull();
    }
  });

  it.each([
    ['Google alone as the offered methods', { methods: ['google'] }],
    ['methods out of order', { methods: ['email', 'google'] }],
    ['a repeated method', { methods: ['google', 'email', 'email'] }],
    ['an unknown method', { methods: ['google', 'apple'] }],
    ['a method without methods', { method: 'email' }],
    ['a method not offered', { methods: ['email'], method: 'google' }],
    ['a hint without methods', { emailHint: 'ada@example.com' }],
    ['a hint with Google preselected', { methods: ['google', 'email'], method: 'google', emailHint: 'ada@example.com' }],
    ['a hint with no @', { methods: ['google', 'email'], emailHint: 'ada.example.com' }],
    ['a hint with a space', { methods: ['google', 'email'], emailHint: 'ada @example.com' }],
    ['a hint with a bidi control', { methods: ['google', 'email'], emailHint: 'ada\u202e@example.com' }],
    ['an over-long hint', { methods: ['google', 'email'], emailHint: `${'a'.repeat(250)}@b.co` }],
  ])('auth-params refuses %s', (_, change) => {
    expect(parseWindowMessage({ ...AUTH_PARAMS, ...change }, ['hana:auth-params'])).toBeNull();
  });

  it('auth-progress carries only the google, email_code, relayed and back stages', () => {
    expect(parseWindowMessage({ v: 1, t: 'hana:auth-progress', stage: 'email_code' }, ['hana:auth-progress'])).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:auth-progress', stage: 'google' }, ['hana:auth-progress'])).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:auth-progress', stage: 'relayed' }, ['hana:auth-progress'])).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:auth-progress', stage: 'back' }, ['hana:auth-progress'])).not.toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:auth-progress', stage: 'done' }, ['hana:auth-progress'])).toBeNull();
    expect(parseWindowMessage({ v: 1, t: 'hana:auth-progress', stage: 'email_code', code: '123456' }, ['hana:auth-progress'])).toBeNull();
  });

  it.each([
    ['a kind on the wrong chain', { kind: 'evm_tx' }],
    ['an address of the other chain', { address: EVM }],
    ['position over queued', { position: 3 }],
    ['a non-hex id', { id: 'z'.repeat(32) }],
    ['an unknown kind', { kind: 'hana_logout' }],
    ['a sign method as the kind', { kind: 'stellar_signTransaction' }],
    ['a context with two keys', { context: { networkPassphrase: TESTNET, chainId: 1 } }],
    ['a transaction without its context', { context: {} }],
    ['a message with a context', { kind: 'stellar_message' }],
    ['a raw EVM request that is not a 32-byte digest', { kind: 'raw', chain: 'evm', address: EVM, context: {} }],
    ['bytes over 192 KiB', { bytes: new Uint8Array(SIGN_MESSAGE_MAX_BYTES + 1) }],
  ])('approve-request refuses %s', (_, change) => {
    expect(parseWindowMessage({ ...APPROVE_REQUEST, ...change }, ['hana:approve-request'])).toBeNull();
  });

  it('approve-request takes an optional auto-approve note, strictly shaped', () => {
    const ok = (autoApprove: unknown) => parseWindowMessage({ ...APPROVE_REQUEST, autoApprove }, ['hana:approve-request']);
    expect(ok({ label: 'Swaps', active: true, reason: 'contract_not_listed' })).not.toBeNull();
    expect(ok({ label: 'Swaps', active: false })).not.toBeNull();
    expect(ok({ label: '', active: true })).toBeNull();
    expect(ok({ label: 'x'.repeat(81), active: true })).toBeNull();
    expect(ok({ label: 'Swaps', active: 'yes' })).toBeNull();
    expect(ok({ label: 'Swaps', active: true, reason: 'Not Listed' })).toBeNull();
    expect(ok({ label: 'Swaps', active: true, extra: 1 })).toBeNull();
  });

  it('auth-params, approve-request, consent-request and export-context take an optional logo URL of the logo shape only (C11)', () => {
    const logo = `https://files.example/logos/app_abc/${'0f'.repeat(32)}.png`;
    for (const t of ['hana:auth-params', 'hana:approve-request', 'hana:consent-request', 'hana:export-context'] as const) {
      const base = VALID_WINDOW[t];
      expect(parseWindowMessage({ ...base, logoUrl: logo }, [t]), t).not.toBeNull();
      expect(parseWindowMessage({ ...base }, [t]), t).not.toBeNull();
      for (const bad of [null, '', 'https://files.example/logo.png', `${logo}?x=1`, `${logo}#x`, `javascript:alert(1)//${logo}`, `https://u:p@files.example/logos/app_abc/${'0f'.repeat(32)}.png`, `https://files.example/logos/app_abc/${'0F'.repeat(32)}.png`, `data:image/png;base64,AAAA`, 1]) {
        expect(parseWindowMessage({ ...base, logoUrl: bad }, [t]), `${t} ${String(bad)}`).toBeNull();
      }
    }
  });

  it('approve-request and consent-request take an optional testApp flag that is only ever true (D39)', () => {
    for (const [t, base] of [['hana:approve-request', APPROVE_REQUEST], ['hana:consent-request', VALID_WINDOW['hana:consent-request']]] as const) {
      const ok = (testApp: unknown) => parseWindowMessage({ ...base, testApp }, [t]);
      expect(ok(true)).not.toBeNull();
      expect(parseWindowMessage({ ...base }, [t])).not.toBeNull();
      expect(ok(false)).toBeNull();
      expect(ok('yes')).toBeNull();
    }
  });

  it.each([
    ['a short policyId', { policyId: 'a'.repeat(63) }],
    ['an uppercase policyId', { policyId: 'A'.repeat(64) }],
    ['a policy that is not an object', { policy: 'policy' }],
    ['a policy array', { policy: [] }],
    ['position over queued', { position: 2 }],
    ['a negative expiry', { expiresAtMs: -1 }],
  ])('consent-request refuses %s', (_, change) => {
    expect(parseWindowMessage({ ...VALID_WINDOW['hana:consent-request'], ...change }, ['hana:consent-request'])).toBeNull();
  });

  it('consent-request carries a policy up to the 192 KiB approval cap', () => {
    const big = { ...VALID_WINDOW['hana:consent-request'], policy: { label: 'x'.repeat(20_000) } };
    expect(parseWindowMessage(big, ['hana:consent-request'])).not.toBeNull();
  });

  it('approve-request carries up to 192 KiB, other messages only 8 KiB', () => {
    expect(parseWindowMessage({ ...APPROVE_REQUEST, bytes: new Uint8Array(150_000) }, ['hana:approve-request'])).not.toBeNull();
    expect(parseWindowMessage({ ...AUTH_PARAMS, appName: 'x'.repeat(200) }, ['hana:auth-params'])).not.toBeNull();
    expect(parseWindowMessage({ ...VALID_WINDOW['hana:hello'], sdk: '1'.repeat(33) }, ['hana:hello'])).toBeNull();
  });

  it('approve-request allows raw on either chain, and an empty context for messages, typed data and raw', () => {
    const ok = (change: Record<string, unknown>) => parseWindowMessage({ ...APPROVE_REQUEST, ...change }, ['hana:approve-request']);
    expect(ok({ kind: 'raw', chain: 'evm', address: EVM, context: {}, bytes: new Uint8Array(32) })).not.toBeNull();
    expect(ok({ kind: 'raw', context: {} })).not.toBeNull();
    expect(ok({ kind: 'stellar_message', context: {} })).not.toBeNull();
    expect(ok({ kind: 'personal_sign', chain: 'evm', address: EVM, context: {} })).not.toBeNull();
    expect(ok({ kind: 'eip712', chain: 'evm', address: EVM, context: {} })).not.toBeNull();
    expect(ok({ kind: 'evm_tx', chain: 'evm', address: EVM, context: { chainId: 1 } })).not.toBeNull();
    expect(ok({ kind: 'eip712', chain: 'evm', address: EVM, context: { chainId: 1 } })).toBeNull();
  });

  it('origins are exact URL origins', () => {
    expect(isOrigin('https://a.example')).toBe(true);
    expect(isOrigin('http://localhost:5173')).toBe(true);
    expect(isOrigin('https://A.example')).toBe(false);
    expect(isOrigin('https://a.example:443')).toBe(false);
    expect(isOrigin('javascript:alert(1)')).toBe(false);
    expect(isOrigin('null')).toBe(false);
  });

  it('fuzz: random mutations never throw and never produce an invalid accepted message', () => {
    const values: unknown[] = [null, undefined, 0, -1, 1.5, 2 ** 53, '', 'x', [], {}, new Uint8Array(0), new Uint8Array(32), new Uint8Array(33), true, '0x', G, EVM];
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const t = TYPES[rand(TYPES.length)]!;
      const m: Record<string, unknown> = { ...VALID_WINDOW[t] };
      const keys = Object.keys(m);
      const k = rand(3) === 0 ? `k${rand(5)}` : keys[rand(keys.length)]!;
      m[k] = values[rand(values.length)];
      const out = parseWindowMessage(m, TYPES);
      if (out !== null) expect(parseWindowMessage(out, [out.t])).toEqual(out);
      expect(() => parsePortRequest({ v: 1, id: 'f', method: PORT_METHODS[rand(PORT_METHODS.length)], params: m })).not.toThrow();
    }
  });
});

describe('approval content', () => {
  const parsed = (method: (typeof PORT_METHODS)[number]) => parsePortRequest(req(method, VALID_PARAMS[method])) as Extract<PortRequest, { method: 'hana_signRaw' }>;

  it('Stellar tx: the envelope bytes with the passphrase as context', () => {
    const r = parsePortRequest(req('stellar_signTransaction', VALID_PARAMS.stellar_signTransaction))!;
    const c = approvalContent(r as never);
    expect(toHex(c.bytes)).toBe('0000000201020304');
    expect(c.context).toEqual({ networkPassphrase: TESTNET });
    expect(approvalChain(r as never)).toBe('stellar');
  });

  it('EVM tx: the unsigned signing payload with the chain id as context', () => {
    const r = parsePortRequest(req('eth_signTransaction', { tx: TX }))!;
    const c = approvalContent(r as never);
    expect(toHex(c.bytes)).toBe(toHex(evmTxSigningPayload(parseEvmTxRequest(TX))));
    expect(c.context).toEqual({ chainId: 11155111 });
    expect(approvalContextString('evm', c.context)).toBe('11155111');
  });

  it('messages, typed data and raw: their bytes, no context', () => {
    expect(toHex(approvalContent(parsePortRequest(req('personal_sign', ['0x6869', EVM]))! as never).bytes)).toBe('6869');
    expect(new TextDecoder().decode(approvalContent(parsePortRequest(req('eth_signTypedData_v4', [EVM, '{"a":1}']))! as never).bytes)).toBe('{"a":1}');
    expect(toHex(approvalContent(parsePortRequest(req('stellar_signMessage', { message: 'hi' }))! as never).bytes)).toBe('6869');
    const raw = parsed('hana_signRaw');
    expect(approvalContent(raw)).toEqual({ bytes: new Uint8Array(32), context: {} });
    expect(approvalChain(raw)).toBe('evm');
  });

  it('the digest binds the content: popup and vault compute the same one', () => {
    const r = parsePortRequest(req('stellar_signTransaction', VALID_PARAMS.stellar_signTransaction))!;
    const { bytes, context } = approvalContent(r as never);
    const input: ApprovalDigestInput = { id: newRequestId(), kind: APPROVAL_KIND[r.method as 'stellar_signTransaction'], chain: 'stellar', address: G, parentOrigin: 'https://partner.example', context, bytes };
    expect(toHex(approvalDigest(input))).toBe(toHex(approvalDigest({ ...input, bytes: Uint8Array.from(bytes) })));
    expect(toHex(approvalDigest({ ...input, context: { networkPassphrase: 'Public Global Stellar Network ; September 2015' } }))).not.toBe(toHex(approvalDigest(input)));
  });

  it('refuses an eth_signTransaction chainId over Number.MAX_SAFE_INTEGER at parse time', () => {
    const tx = (chainId: string) => parsePortRequest(req('eth_signTransaction', { tx: { ...TX, chainId } }));
    expect(tx('0xffffffffffffff')).toBeNull();
    expect(tx(`0x${(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(16)}`)).toBeNull();
    const max = tx(`0x${Number.MAX_SAFE_INTEGER.toString(16)}`);
    expect(max).not.toBeNull();
    expect(approvalContent(max as never).context).toEqual({ chainId: Number.MAX_SAFE_INTEGER });
  });

  describe('the largest sign request of each method still fits what it turns into', () => {
    // The largest n for which build(n) passes parsePortRequest (accepted sizes are a prefix: binary search).
    const largest = (build: (n: number) => unknown): Extract<PortRequest, { method: 'hana_signRaw' }> => {
      let lo = 0;
      let hi = SIGN_MESSAGE_MAX_BYTES * 2;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (parsePortRequest(build(mid)) !== null) lo = mid;
        else hi = mid - 1;
      }
      const r = parsePortRequest(build(lo));
      expect(r).not.toBeNull();
      expect(parsePortRequest(build(lo + 4))).toBeNull();
      return r as never;
    };
    const b64 = (n: number) => base64Encode(new Uint8Array(Math.floor((n * 3) / 4)));
    const id = 'i'.repeat(64);

    it.each([
      ['stellar_signTransaction', (n: number) => req('stellar_signTransaction', { xdr: b64(n), networkPassphrase: TESTNET, address: G }, id)],
      ['stellar_signAuthEntry', (n: number) => req('stellar_signAuthEntry', { preimageXdr: b64(n), networkPassphrase: TESTNET, address: G }, id)],
      ['stellar_signMessage (bytes)', (n: number) => req('stellar_signMessage', { message: new Uint8Array(n), address: G }, id)],
      ['stellar_signMessage (multi-byte text)', (n: number) => req('stellar_signMessage', { message: '€'.repeat(n), address: G }, id)],
      ['personal_sign', (n: number) => req('personal_sign', [`0x${'ab'.repeat(n)}`, EVM], id)],
      ['eth_signTypedData_v4', (n: number) => req('eth_signTypedData_v4', [EVM, '€'.repeat(n)], id)],
      ['eth_signTransaction', (n: number) => req('eth_signTransaction', { tx: { ...TX, data: `0x${'ab'.repeat(n)}` } }, id)],
    ] as const)('%s → hana:approve-request with the longest app name and origin', (_, build) => {
      const r = largest(build);
      const { bytes, context } = approvalContent(r);
      const chain = approvalChain(r);
      const msg = {
        ...APPROVE_REQUEST,
        appName: '€'.repeat(200),
        parentOrigin: `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example:65535`,
        kind: APPROVAL_KIND[r.method],
        chain,
        address: chain === 'evm' ? EVM : G,
        bytes,
        context,
        position: 1000,
        queued: 1000,
      };
      expect(parseWindowMessage(msg, ['hana:approve-request'])).not.toBeNull();
    });

    it('the signed envelope of the largest stellar_signTransaction fits the reply cap', () => {
      const r = largest((n) => req('stellar_signTransaction', { xdr: b64(n), networkPassphrase: TESTNET, address: G }, id));
      // The signed envelope is the input plus one DecoratedSignature (4-byte hint, 4-byte length, 64-byte signature).
      const signed = base64Encode(new Uint8Array(approvalContent(r).bytes.length + 72));
      expect(parsePortReply({ v: 1, id, result: { signedTxXdr: signed, signerAddress: G } }, 'stellar_signTransaction')).not.toBeNull();
    });
  });

  it('request ids are 128-bit random hex', () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/u);
    expect(newRequestId()).not.toBe(a);
  });
});

describe('vault BroadcastChannel', () => {
  it('accepts counter, logout and revoked outcomes only', () => {
    expect(parseVaultBroadcast({ v: 1, t: 'counter', shareId: new Uint8Array(16), counter: 4 })).not.toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'logout' })).not.toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'revoked', shareId: new Uint8Array(16) })).not.toBeNull();
    // A revocation names the share it ends (tabs holding another share keep theirs).
    expect(parseVaultBroadcast({ v: 1, t: 'revoked' })).toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'revoked', shareId: new Uint8Array(15) })).toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'revoked', shareId: new Uint8Array(16), counter: 1 })).toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'logout', shareId: new Uint8Array(16) })).toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'counter', shareId: new Uint8Array(15), counter: 4 })).toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'logout', prk: new Uint8Array(32) })).toBeNull();
    expect(parseVaultBroadcast({ v: 1, t: 'unlocked', ks: new Uint8Array(32) })).toBeNull();
    expect(parseVaultBroadcast({ t: 'logout' })).toBeNull();
  });
});
