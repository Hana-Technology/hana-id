// @vitest-environment happy-dom
// The approval popup's NEAR rendering (D723, D726): built only from the popup's own decode; every action in plain
// words; amounts in NEAR, gas in Tgas, arguments as escaped JSON or hex; the NEAR leaving the account; the
// account-control banner and warnings; the network line says what Hana checked; NEP-413's recipient up front.
import { type NearAction, encodeNearDelegateAction, encodeNearTransaction, encodeNep413Message, nearImplicitAccountId, nearPublicKeyString, sha256, utf8 } from '@hana-id/core';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { NEAR_ACCOUNT_CONTROL_BANNER, NEAR_DELEGATE_NOTES, type NearRenderContext, nearMessageWarning, nearNetworkLine, renderApproval } from '../../src/auth/render-approval.ts';

const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ME = nearImplicitAccountId(PUB);
const OTHER_KEY = { type: 'ed25519' as const, bytes: new Uint8Array(32).fill(9) };
const BLOCK = sha256(utf8('block'));
const TESTNET: NearRenderContext = { envNetwork: 'testnet', testApp: false };

function tx(actions: NearAction[], receiverId = ME): HTMLElement {
  const bytes = encodeNearTransaction({ signerId: ME, publicKey: { type: 'ed25519', bytes: PUB }, nonce: 3n, receiverId, blockHash: BLOCK, actions });
  const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: ME, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App', TESTNET);
  document.body.replaceChildren(el);
  return el;
}

const takeovers = (el: HTMLElement) => [...el.querySelectorAll('p.danger.takeover')].map((p) => p.textContent);
const call = (args: string | Uint8Array, deposit = 0n): NearAction => ({ type: 'functionCall', methodName: 'add_message', args: typeof args === 'string' ? utf8(args) : Uint8Array.from(args), gas: 30_000_000_000_000n, deposit });

describe('renderApproval: NEAR transactions', () => {
  beforeEach(() => document.body.replaceChildren());

  it('a function call: method, receiver, deposit, gas, JSON arguments; the total leaving the account', () => {
    const el = tx([call('{"text":"gm‮"}', 10n ** 24n)], 'guestbook.testnet');
    const text = el.textContent!;
    expect(text).toContain('NEAR transaction');
    expect(text).toContain('Calls');
    expect([...el.querySelectorAll('dd strong')].map((e) => e.textContent)).toContain('add_message');
    expect(text).toContain('guestbook.testnet');
    expect(text).toContain('Attached deposit1 NEAR');
    expect(text).toContain('Gas30 Tgas');
    expect(el.querySelector('pre.message')?.textContent).toBe('{\n  "text": "gm\\u202e"\n}');
    expect(text).toContain('NEAR leaving your account1 NEAR (plus the network fee for gas)');
    expect(text).toContain('Transaction hash');
    expect(takeovers(el)).toEqual([]);
  });

  it('shows non-JSON arguments as hex, and long ones in full behind a disclosure', () => {
    expect(tx([call(Uint8Array.of(0xff, 0x01))]).textContent).toContain('ff01');
    const long = `{"t":"${'a'.repeat(3000)}"}`;
    const el = tx([call(long)]);
    expect(el.querySelector('details pre')?.textContent).toBe(`{\n  "t": "${'a'.repeat(3000)}"\n}`);
  });

  it('a transfer sends NEAR to the receiver', () => {
    const el = tx([{ type: 'transfer', deposit: 2_500_000_000_000_000_000_000_000n }], 'bob.testnet');
    expect(el.textContent).toContain('Sends2.5 NEAR');
    expect(el.textContent).toContain('NEAR leaving your account2.5 NEAR');
  });

  it.each([
    ['a full-access key', { type: 'addKey', publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } } as NearAction, `This adds a full-access key to your account. Whoever holds ${nearPublicKeyString(OTHER_KEY.bytes)} can move all its NEAR and tokens and lock you out.`],
    ['a function-call key', { type: 'addKey', publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { type: 'functionCall', allowance: null, receiverId: 'x.testnet', methodNames: [] } } } as NearAction, 'This adds a key to your account that can call any method of x.testnet and spend NEAR on their fees.'],
    ['removing the Hana key', { type: 'deleteKey', publicKey: { type: 'ed25519', bytes: PUB } } as NearAction, 'This removes your Hana key from your account: Hana can no longer sign for it, so you lose control of it.'],
    ['deleting the account', { type: 'deleteAccount', beneficiaryId: 'bob.testnet' } as NearAction, 'This deletes your account and sends all of its NEAR to bob.testnet. It can’t be undone.'],
    ['deploying a contract', { type: 'deployContract', code: Uint8Array.of(0, 97, 115, 109) } as NearAction, 'This deploys a contract to your account. A contract runs with the account’s own authority: it can move everything in it.'],
    ['using a global contract', { type: 'useGlobalContract', contract: { type: 'accountId', accountId: 'g.testnet' } } as NearAction, 'This sets your account’s contract to a global contract. A contract runs with the account’s own authority: it can move everything in it.'],
  ])('%s: under the account-control banner, with its warning', (_, action, warning) => {
    const el = tx([action]);
    const banner = el.querySelector('p.takeover.banner');
    expect(banner?.textContent).toBe(NEAR_ACCOUNT_CONTROL_BANNER);
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(takeovers(el)).toEqual([NEAR_ACCOUNT_CONTROL_BANNER, warning]);
    expect(el.querySelector('li.op.takeover-op')).not.toBeNull();
  });

  it('deleting the account says all of it leaves', () => {
    expect(tx([{ type: 'deleteAccount', beneficiaryId: 'bob.testnet' }]).textContent).toContain('All of it (the account is deleted)');
  });

  it('relaying someone else’s delegate action: its actions carry no warning for the user', () => {
    const el = tx([
      {
        type: 'delegate',
        signedDelegate: {
          delegateAction: { senderId: 'bob.testnet', receiverId: 'bob.testnet', actions: [{ type: 'addKey', publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } }], nonce: 1n, maxBlockHeight: 5n, publicKey: OTHER_KEY },
          signature: { type: 'ed25519', bytes: new Uint8Array(64) },
        },
      },
    ]);
    expect(el.textContent).toContain('Relays a meta transaction signed by bob.testnet');
    expect(takeovers(el)).toEqual([]);
  });

  it('method names with invisible characters are shown as hex', () => {
    const el = tx([{ type: 'functionCall', methodName: 'a​b', args: new Uint8Array(0), gas: 1n, deposit: 0n }]);
    expect(el.textContent).toContain('(shown as hex) 61e2808b62');
  });
});

describe('renderApproval: NEAR network line (D726)', () => {
  it('says what Hana checked, and labels everything else as the app’s claim', () => {
    expect(nearNetworkLine('near_tx', 'testnet', TESTNET)).toBe('NEAR testnet (Hana found its block hash on testnet)');
    expect(nearNetworkLine('near_tx', 'mainnet', TESTNET)).toBe('NEAR mainnet, as the app says: Hana can’t check this');
    expect(nearNetworkLine('near_delegate', 'testnet', { envNetwork: 'testnet', testApp: true })).toBe('NEAR testnet (Hana checked your key, nonce and expiry on testnet)');
    expect(nearNetworkLine('near_delegate', 'testnet', TESTNET)).toBe('NEAR testnet, as the app says: Hana can’t check this');
    expect(nearNetworkLine('near_delegate', 'mainnet', TESTNET)).toBe('NEAR mainnet, as the app says: Hana can’t check this');
  });
});

describe('renderApproval: NEAR delegate actions and messages', () => {
  it('a delegate action: relayer and network notes, expiry, actions, total', () => {
    const bytes = encodeNearDelegateAction({ senderId: ME, receiverId: 'guestbook.testnet', actions: [call('{"text":"hi"}')], nonce: 7n, maxBlockHeight: 277_000_600n, publicKey: { type: 'ed25519', bytes: PUB } });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: ME, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App', { envNetwork: 'testnet', testApp: true });
    const text = el.textContent!;
    expect(text).toContain('NEAR transaction, fee paid by a relayer');
    expect(text).toContain(NEAR_DELEGATE_NOTES.relayer);
    expect(text).toContain(NEAR_DELEGATE_NOTES.network);
    expect(text).toContain('Valid until block277000600');
    expect(text).toContain('(the relayer pays the network fee)');
  });

  it('a NEP-413 message: the recipient first, the message as text', () => {
    const bytes = encodeNep413Message({ message: 'Sign in to Guestbook', nonce: new Uint8Array(32).fill(1), recipient: 'guestbook.example', callbackUrl: 'https://guestbook.example/cb' });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'Partner App');
    expect(el.querySelector('p.warn')?.textContent).toBe(nearMessageWarning('guestbook.example'));
    expect(el.textContent).toContain('Forguestbook.example');
    expect(el.textContent).toContain('Then returns tohttps://guestbook.example/cb');
    expect(el.querySelector('pre.message')?.textContent).toBe('Sign in to Guestbook');
  });

  it('a message with invisible characters is shown as hex', () => {
    const bytes = encodeNep413Message({ message: 'a‮b', nonce: new Uint8Array(32), recipient: 'r', callbackUrl: null });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'Partner App');
    expect(el.textContent).toContain('shown as hex');
  });
});
