// NEAR approvals (D722, D723, D726): the port's near_* requests, their approval subjects and digests, what the popup
// decodes (the signer must be the subject's account and key), the display helpers, the test-app network rule, and
// that no auto-approve policy covers them.
import { PublicKey } from '@near-js/crypto';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_KIND,
  type ApprovalSubject,
  DecodeError,
  NEAR_SDK_MIN,
  NEVER_AUTO_APPROVED_KINDS,
  type PortRequest,
  type SignMethod,
  approvalChain,
  approvalContent,
  base64Decode,
  base64Encode,
  decodeApprovalRequest,
  decodeNep413Message,
  formatGas,
  formatNear,
  mainnetOfRequest,
  matchAutoApprovePolicy,
  nearAccountControl,
  nearArgsView,
  nearChangesControl,
  nearDeposits,
  nearMethodName,
  parsePortEvent,
  parsePortReply,
  parsePortRequest,
  sdkAtLeast,
  validateAutoApprovePolicy,
} from './entries.ts';
import {
  NEAR_BLOCK,
  NEAR_OTHER,
  NEAR_OTHER_KEY,
  NEAR_PARAMS,
  NEAR_USER,
  addKey,
  createAccount,
  deleteAccount,
  deleteKey,
  deployContract,
  deployGlobalContract,
  fullAccessKey,
  functionCall,
  functionCallAccessKey,
  guestbookCall,
  nearDelegateBytes,
  nearTxBytes,
  stake,
  transfer,
  useGlobalContract,
} from './near-fixtures.ts';
import { policyJson } from './policy-fixtures.ts';
import { GlobalContractDeployMode, GlobalContractIdentifier } from '@near-js/transactions';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

type NearMethod = 'near_signTransaction' | 'near_signMessage' | 'near_signDelegateAction';
const req = (method: NearMethod, params: unknown) => parsePortRequest({ v: 1, id: 'r1', method, params }) as Extract<PortRequest, { method: SignMethod }> | null;

function subjectOf(method: NearMethod, params: unknown = NEAR_PARAMS[method], address = NEAR_USER): ApprovalSubject {
  const r = req(method, params);
  expect(r).not.toBeNull();
  return { kind: APPROVAL_KIND[method], chain: approvalChain(r!), address, ...approvalContent(r!) };
}

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof DecodeError ? e.code : 'other';
  }
  return 'none';
};

describe('near_* port requests', () => {
  it('maps the methods to near_tx, near_message and near_delegate on chain near', () => {
    expect([APPROVAL_KIND.near_signTransaction, APPROVAL_KIND.near_signMessage, APPROVAL_KIND.near_signDelegateAction]).toEqual(['near_tx', 'near_message', 'near_delegate']);
    expect(subjectOf('near_signTransaction')).toMatchObject({ chain: 'near', context: { nearNetwork: 'testnet' } });
    expect(subjectOf('near_signDelegateAction')).toMatchObject({ chain: 'near', context: { nearNetwork: 'testnet' } });
    expect(subjectOf('near_signMessage')).toMatchObject({ chain: 'near', context: {} });
  });

  it.each([
    ['near_signTransaction', { network: 'betanet', transaction: NEAR_PARAMS.near_signTransaction.transaction }],
    ['near_signTransaction', { network: 'testnet' }],
    ['near_signTransaction', { network: 'testnet', transaction: 'not base64!' }],
    ['near_signTransaction', { ...NEAR_PARAMS.near_signTransaction, extra: 1 }],
    ['near_signDelegateAction', { network: 'testnet', transaction: NEAR_PARAMS.near_signTransaction.transaction }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, nonce: base64Encode(new Uint8Array(31)) }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, recipient: '' }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, recipient: 'evil‮good' }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, recipient: 'two\nlines' }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, callbackUrl: '' }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, message: `a${String.fromCharCode(0xd800)}` }],
    ['near_signMessage', { ...NEAR_PARAMS.near_signMessage, recipient: 'r'.repeat(1025) }],
  ] as const)('refuses %s %j', (method, params) => {
    expect(req(method, params)).toBeNull();
  });

  it('takes a callbackUrl and an empty message', () => {
    expect(req('near_signMessage', { ...NEAR_PARAMS.near_signMessage, message: '', callbackUrl: 'https://guestbook.example/cb' })).not.toBeNull();
  });

  it('the NEP-413 subject bytes are the tagged payload of the request', () => {
    const s = subjectOf('near_signMessage', { ...NEAR_PARAMS.near_signMessage, callbackUrl: 'https://x.example' });
    expect(decodeNep413Message(s.bytes)).toEqual({ message: 'Sign in to Guestbook', recipient: 'guestbook.example', nonce: new Uint8Array(32).fill(3), callbackUrl: 'https://x.example' });
  });

  it('validates the replies', () => {
    const sig = base64Encode(new Uint8Array(64).fill(1));
    const ok = (method: NearMethod, result: unknown) => parsePortReply({ v: 1, id: 'r1', result }, method) !== null;
    expect(ok('near_signTransaction', { signature: sig, signedTransaction: base64Encode(new Uint8Array(100)), hash: '11111111111111111111111111111111' })).toBe(true);
    expect(ok('near_signTransaction', { signature: sig, signedTransaction: base64Encode(new Uint8Array(100)), hash: 'xyz' })).toBe(false);
    expect(ok('near_signTransaction', { signature: base64Encode(new Uint8Array(65)), signedTransaction: base64Encode(new Uint8Array(100)), hash: '11111111111111111111111111111111' })).toBe(false);
    expect(ok('near_signMessage', { accountId: NEAR_USER, publicKey: 'ed25519:11111111111111111111111111111111', signature: sig })).toBe(true);
    expect(ok('near_signMessage', { accountId: 'alice.testnet', publicKey: 'ed25519:11111111111111111111111111111111', signature: sig })).toBe(false);
    expect(ok('near_signDelegateAction', { signature: sig, signedDelegateAction: base64Encode(new Uint8Array(100)) })).toBe(true);
    expect(ok('near_signDelegateAction', { signature: sig })).toBe(false);
  });
});

describe('addresses with NEAR (compatibility, D725)', () => {
  const ready = (addresses: unknown) => parsePortEvent({ v: 1, event: 'ready', data: { status: 'logged_in', persistence: 'session', expiresAtMs: 1, addresses } });

  it('the new parsers take addresses with or without near (an older vault sends none)', () => {
    expect(ready({ stellar: G, evm: EVM })).not.toBeNull();
    expect(ready({ stellar: G, evm: EVM, near: NEAR_USER })).not.toBeNull();
    expect(ready({ stellar: G, evm: EVM, near: 'alice.testnet' })).toBeNull();
    expect(ready({ stellar: G, evm: EVM, near: NEAR_USER.toUpperCase() })).toBeNull();
    expect(parsePortEvent({ v: 1, event: 'accountsChanged', data: { addresses: { stellar: G, evm: EVM, near: NEAR_USER } } })).not.toBeNull();
  });

  it('NEAR_SDK_MIN is 0.4.0: SDKs 0.3.x get the two-chain shape', () => {
    expect(NEAR_SDK_MIN).toBe('0.4.0');
    expect(sdkAtLeast('0.3.1', NEAR_SDK_MIN)).toBe(false);
    expect(sdkAtLeast('0.3.0', NEAR_SDK_MIN)).toBe(false);
    expect(sdkAtLeast('0.4.0', NEAR_SDK_MIN)).toBe(true);
  });
});

describe('decodeApprovalRequest: NEAR', () => {
  it('decodes a transaction with its hash and network', () => {
    const d = decodeApprovalRequest(subjectOf('near_signTransaction'));
    expect(d).toMatchObject({ kind: 'near_tx', network: 'testnet' });
    if (d.kind !== 'near_tx') throw new Error('kind');
    expect(d.tx.signerId).toBe(NEAR_USER);
    expect(d.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u);
  });

  it('decodes a delegate action and a message', () => {
    expect(decodeApprovalRequest(subjectOf('near_signDelegateAction'))).toMatchObject({ kind: 'near_delegate', network: 'testnet', delegate: { senderId: NEAR_USER, receiverId: 'guestbook.testnet', maxBlockHeight: 277_300_000n } });
    expect(decodeApprovalRequest(subjectOf('near_signMessage'))).toMatchObject({ kind: 'near_message', payload: { recipient: 'guestbook.example' }, message: { text: 'Sign in to Guestbook' } });
  });

  it('refuses a transaction or delegate action from another account or key', () => {
    const tx = (bytes: Uint8Array) => subjectOf('near_signTransaction', { network: 'testnet', transaction: base64Encode(bytes) });
    const da = (bytes: Uint8Array) => subjectOf('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(bytes) });
    expect(code(() => decodeApprovalRequest(tx(nearTxBytes([transfer(1n)], { signer: NEAR_OTHER }))))).toBe('invalid_value');
    expect(code(() => decodeApprovalRequest(tx(nearTxBytes([transfer(1n)], { key: NEAR_OTHER_KEY }))))).toBe('invalid_value');
    expect(code(() => decodeApprovalRequest(tx(nearTxBytes([transfer(1n)], { signer: 'alice.testnet' }))))).toBe('invalid_value');
    expect(code(() => decodeApprovalRequest(da(nearDelegateBytes([transfer(1n)], { sender: NEAR_OTHER }))))).toBe('invalid_value');
    expect(code(() => decodeApprovalRequest(da(nearDelegateBytes([transfer(1n)], { key: NEAR_OTHER_KEY }))))).toBe('invalid_value');
    // The subject's own address must be an implicit account id.
    expect(code(() => decodeApprovalRequest(subjectOf('near_signTransaction', NEAR_PARAMS.near_signTransaction, 'alice.testnet')))).toBe('malformed');
  });

  it('refuses bytes that are not the kind they claim', () => {
    const asDelegate = subjectOf('near_signDelegateAction', { network: 'testnet', delegateAction: NEAR_PARAMS.near_signTransaction.transaction });
    expect(code(() => decodeApprovalRequest(asDelegate))).not.toBe('none');
  });
});

describe('NEAR display helpers', () => {
  it('formats NEAR and gas exactly', () => {
    expect(formatNear(0n)).toBe('0 NEAR');
    expect(formatNear(10n ** 24n)).toBe('1 NEAR');
    expect(formatNear(1_500_000_000_000_000_000_000_000n)).toBe('1.5 NEAR');
    expect(formatNear(1n)).toBe('0.000000000000000000000001 NEAR');
    expect(formatNear((1n << 128n) - 1n)).toBe('340282366920938.463463374607431768211455 NEAR');
    expect(formatGas(30_000_000_000_000n)).toBe('30 Tgas');
    expect(formatGas(500_000_000_000n)).toBe('0.5 Tgas');
    expect(formatGas(1n)).toBe('0.000000000001 Tgas');
  });

  it('shows JSON arguments re-indented in their order, with unsafe characters escaped', () => {
    const v = nearArgsView(new TextEncoder().encode('{"b":1,"1":[true,null],"text":"hi‮there","n":12345678901234567890123,"e":{},"a":[]}'));
    expect(v.kind).toBe('json');
    if (v.kind !== 'json') throw new Error('kind');
    expect(v.text).toBe('{\n  "b": 1,\n  "1": [\n    true,\n    null\n  ],\n  "text": "hi\\u202ethere",\n  "n": 12345678901234567890123,\n  "e": {},\n  "a": []\n}');
    // Escapes in the input are kept as written.
    expect((nearArgsView(new TextEncoder().encode('{"q":"a\\"b\\u0041"}')) as { text: string }).text).toBe('{\n  "q": "a\\"b\\u0041"\n}');
  });

  it('shows anything else as hex', () => {
    expect(nearArgsView(Uint8Array.of(0xff, 0x00))).toMatchObject({ kind: 'hex', hex: 'ff00' });
    expect(nearArgsView(new TextEncoder().encode('{"a":1,"a":2}'))).toMatchObject({ kind: 'hex' });
    expect(nearArgsView(new TextEncoder().encode('not json'))).toMatchObject({ kind: 'hex' });
    expect(nearArgsView(new Uint8Array(0))).toEqual({ kind: 'empty', length: 0 });
  });

  it('shows a method name with invisible characters as hex', () => {
    expect(nearMethodName('add_message')).toEqual({ text: 'add_message', hex: '6164645f6d657373616765' });
    expect(nearMethodName('a​b').text).toBeNull();
  });

  it('flags what changes who controls an account, and adds up the NEAR that leaves it', () => {
    const tx = decodeApprovalRequest(
      subjectOf('near_signTransaction', {
        network: 'testnet',
        transaction: base64Encode(
          nearTxBytes([
            createAccount(),
            transfer(2n),
            functionCall('m', Uint8Array.of(), 1n, 3n),
            stake(7n, PublicKey.fromString(NEAR_OTHER_KEY.toString())),
            addKey(NEAR_OTHER_KEY, fullAccessKey()),
            addKey(NEAR_OTHER_KEY, functionCallAccessKey('guestbook.testnet', [])),
            deleteKey(NEAR_OTHER_KEY),
            deleteAccount('bob.testnet'),
            deployContract(Uint8Array.of(0)),
            deployGlobalContract(Uint8Array.of(0), new GlobalContractDeployMode({ CodeHash: null })),
            useGlobalContract(new GlobalContractIdentifier({ AccountId: 'global.testnet' })),
          ]),
        ),
      }),
    );
    if (tx.kind !== 'near_tx') throw new Error('kind');
    expect(tx.tx.actions.map(nearAccountControl)).toEqual([[], [], [], [], ['add_full_access_key'], ['add_function_call_key'], ['delete_key'], ['delete_account'], ['deploy_contract'], [], ['use_global_contract']]);
    expect(nearChangesControl(tx.tx.actions)).toBe(true);
    expect(nearChangesControl(tx.tx.actions.slice(0, 4))).toBe(false);
    expect(nearDeposits(tx.tx.actions)).toEqual({ total: 5n, staked: 7n, burned: 10n ** 20n, deletesAccount: true });
  });
});

describe('NEAR network rules (D726)', () => {
  it('mainnetOfRequest names NEAR mainnet transactions and delegate actions; messages name no network', () => {
    expect(mainnetOfRequest(req('near_signTransaction', { ...NEAR_PARAMS.near_signTransaction, network: 'mainnet' })!)).toEqual({ chain: 'near', network: 'mainnet' });
    expect(mainnetOfRequest(req('near_signDelegateAction', { ...NEAR_PARAMS.near_signDelegateAction, network: 'mainnet' })!)).toEqual({ chain: 'near', network: 'mainnet' });
    expect(mainnetOfRequest(req('near_signTransaction', NEAR_PARAMS.near_signTransaction)!)).toBeNull();
    expect(mainnetOfRequest(req('near_signMessage', NEAR_PARAMS.near_signMessage)!)).toBeNull();
  });
});

describe('auto-approve never covers NEAR (D722)', () => {
  it.each(['near_tx', 'near_message', 'near_delegate'] as const)('%s is never auto-approved', (kind) => {
    expect(NEVER_AUTO_APPROVED_KINDS.has(kind)).toBe(true);
  });

  it.each(['near_signTransaction', 'near_signMessage', 'near_signDelegateAction'] as const)('the matcher misses %s as never_covered', (method) => {
    const policy = validateAutoApprovePolicy(policyJson());
    if (!policy.ok) throw new Error('policy');
    const r = matchAutoApprovePolicy(policy.policy, subjectOf(method), { usage: null, nowMs: Date.UTC(2026, 10, 11) });
    expect(r).toMatchObject({ ok: false, reason: 'never_covered' });
  });
});

describe('fixtures', () => {
  it('the block hash is 32 bytes and guestbook calls decode', () => {
    expect(NEAR_BLOCK.length).toBe(32);
    expect(base64Decode(base64Encode(nearTxBytes([guestbookCall()])))).toHaveLength(nearTxBytes([guestbookCall()]).length);
  });
});
