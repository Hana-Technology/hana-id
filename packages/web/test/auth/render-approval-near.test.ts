// @vitest-environment happy-dom
// The approval popup's NEAR rendering (D723, D726): built only from the popup's own decode; every action in plain
// words; amounts in NEAR, gas in Tgas, arguments as escaped JSON or hex; the NEAR leaving the account; the
// account-control banner and warnings; the network line says what Hana checked; NEP-413's recipient up front.
import { type NearAction, encodeNearDelegateAction, encodeNearTransaction, encodeNep413Message, nearImplicitAccountId, nearPublicKeyString, sha256, utf8 } from '@hana-id/core';
import { decodeApprovalRequest } from '@hana-id/core/decode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import {
  NEAR_ACCOUNT_CONTROL_BANNER,
  NEAR_DELEGATE_NOTES,
  type NearRenderContext,
  NEAR_DELEGATE_NONE,
  NEAR_OWN_CONTRACT_TOTAL,
  markOverflowing,
  overflowNote,
  nearControlWarnings,
  nearMessageWarning,
  nearNetworkDetail,
  nearNetworkLine,
  nearRecipientLookalike,
  nearRecipientMismatch,
  renderApproval,
} from '../../src/auth/render-approval.ts';
import { jargonWatch } from './plain-words.ts';

const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ME = nearImplicitAccountId(PUB);
const OTHER_KEY = { type: 'ed25519' as const, bytes: new Uint8Array(32).fill(9) };
const BLOCK = sha256(utf8('block'));
const TESTNET: NearRenderContext = { envNetwork: 'testnet', testApp: false };

const plain = jargonWatch();
function tx(actions: NearAction[], receiverId = ME): HTMLElement {
  const bytes = encodeNearTransaction({ signerId: ME, publicKey: { type: 'ed25519', bytes: PUB }, nonce: 3n, receiverId, blockHash: BLOCK, actions });
  const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: ME, context: { nearNetwork: 'testnet' }, bytes }), 'Partner App', TESTNET);
  document.body.replaceChildren(el);
  plain(el);
  return el;
}

/** The red box (D814): its lead in full, then each other red item's bullet. */
const takeovers = (el: HTMLElement) => [...el.querySelectorAll('.danger-box .risk-lead, .danger-box li')].map((p) => p.textContent);
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
    expect(text).toContain('NEAR leaving your account1 NEAR (plus the network fee)');
    expect(text).toContain('Transaction hash');
    expect(takeovers(el)).toEqual([]);
  });

  it('shows arguments whole (never cut), as hex when they aren’t JSON; in the details, always folded at first (D808, D810)', () => {
    const hex = tx([call(Uint8Array.of(0xff, 0x01))]);
    expect(hex.textContent).toContain('ff01');
    expect(hex.querySelector<HTMLDetailsElement>('details.request-details')?.open).toBe(false);
    // A padded first key can't push receiver_id or amount out of the text: nothing is cut. The JSON of a call the
    // summary names is in the details (closed), whole, in one box.
    const long = `{"pad":"${'a'.repeat(3000)}","receiver_id":"attacker.testnet","amount":"1"}`;
    const el = tx([call(long)]);
    expect(el.querySelectorAll('details')).toHaveLength(1);
    expect(el.querySelector<HTMLDetailsElement>('details.request-details')?.open).toBe(false);
    expect(el.querySelector('details.request-details pre.message')!.textContent!).toContain('"receiver_id": "attacker.testnet"');
    // ft_transfer's receiver and amount are read into the summary, outside the fold.
    const ft = tx([{ ...call('{"receiver_id":"attacker.testnet","amount":"5"}', 1n), methodName: 'ft_transfer' } as NearAction], 'usdc.testnet');
    expect(ft.querySelector('h2.summary-headline')?.textContent).toBe('Partner App wants to send 5 units of the unlisted token usdc.testnet to attacker.testnet');
    expect(tx([call(new Uint8Array(1000).fill(0xff))]).querySelector('pre.message')!.textContent).toBe('ff'.repeat(1000));
  });

  describe('markOverflowing: a box that holds more than it shows says so, decided by layout, not length', () => {
    /** happy-dom lays nothing out: give every box the sizes a browser would (14 lines of ~22 px in a 320 px box). */
    function laidOut(el: HTMLElement, lineHeight = 22, boxHeight = 320): void {
      for (const box of Array.from(el.querySelectorAll<HTMLElement>('pre.message'))) {
        const lines = (box.textContent ?? '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 60)), 0);
        Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => lines * lineHeight });
        Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => Math.min(boxHeight, lines * lineHeight) });
      }
    }
    const notes = (el: HTMLElement) => [...el.querySelectorAll('p.overflow-note')].map((n) => n.textContent);

    it('JSON of many short keys (under 1,500 characters) overflows and is flagged', () => {
      const json = `{${Array.from({ length: 20 }, (_, i) => `"k${i}":${i}`).join(',')}}`;
      expect(json.length).toBeLessThan(1500);
      const el = tx([call(json)]);
      laidOut(el);
      markOverflowing(el);
      const box = el.querySelector('pre.message')!;
      expect(box.classList.contains('overflows')).toBe(true);
      expect(notes(el)).toEqual([overflowNote(box.textContent!.length)]);
      // Idempotent: a second pass (a resize) adds nothing.
      markOverflowing(el);
      expect(notes(el)).toHaveLength(1);
    });

    it('hex that overflows is flagged; a short box is not, and loses the note when it fits again', () => {
      const el = tx([call(new Uint8Array(650).fill(0xab))]);
      laidOut(el);
      markOverflowing(el);
      expect(notes(el)).toHaveLength(1);
      laidOut(el, 22, 100_000);
      markOverflowing(el);
      expect(notes(el)).toEqual([]);
      const small = tx([call('{"a":1}')]);
      laidOut(small);
      markOverflowing(small);
      expect(notes(small)).toEqual([]);
    });

    it('a multi-line NEP-413 message that overflows is flagged too', () => {
      const bytes = encodeNep413Message({ message: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), nonce: new Uint8Array(32), recipient: 'r', callbackUrl: null });
      const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'P');
      laidOut(el);
      markOverflowing(el);
      expect(notes(el)).toHaveLength(1);
    });
  });

  it('numbers each action once: the list has no numbers of its own, the heading has one', () => {
    const el = tx([call('{}', 0n), { type: 'transfer', deposit: 1n }], 'guestbook.testnet');
    expect([...el.querySelectorAll('ol.ops > li > h3')].map((h) => h.textContent)).toEqual(['1. Call a contract', '2. Send NEAR']);
    const css = readFileSync(join(process.cwd(), 'src', 'auth', 'css', 'approval.css'), 'utf8');
    expect(css).toMatch(/ol\.ops \{\n  list-style: none;/u);
  });

  it('a call to a contract on the user’s own account: the total is unknown and the red banner is up', () => {
    const el = tx([call('{}', 5n)]);
    expect(el.querySelector('p.takeover.banner')?.textContent).toBe(NEAR_ACCOUNT_CONTROL_BANNER);
    expect(el.textContent).toContain(`NEAR leaving your account${NEAR_OWN_CONTRACT_TOTAL} (plus the network fee)`);
    // D814: shown conservatively, never as 0 (the exact figure is in the details).
    expect(el.textContent).toContain('NEAR it sendsless than 0.000001 NEAR');
    expect(el.querySelector('details')?.textContent).toContain('0.000000000000000000000005 NEAR');
  });

  it('a call to a contract on the user’s own account carries a warning (it runs with the account’s full authority)', () => {
    expect(takeovers(tx([call('{}')]))).toEqual([NEAR_ACCOUNT_CONTROL_BANNER, 'Uses a program on your own account']);
    expect(takeovers(tx([call('{}')], 'guestbook.testnet'))).toEqual([]);
  });

  it('publishing a global contract shows its burn in the total and warns', () => {
    const el = tx([{ type: 'deployGlobalContract', code: new Uint8Array(1000), deployMode: 'codeHash' }]);
    expect(el.textContent).toContain('NEAR leaving your account0.1 NEAR (plus the network fee)');
    expect(el.textContent).toContain('NEAR destroyed0.1 NEAR (gone for good: publishing a shared program)');
    expect(takeovers(el)).toEqual(['This publishes a shared program. It destroys 0.1 NEAR from your account (0.0001 NEAR for each byte of the program). That NEAR is gone for good.']);
  });

  it('a transfer sends NEAR to the receiver', () => {
    const el = tx([{ type: 'transfer', deposit: 2_500_000_000_000_000_000_000_000n }], 'bob.testnet');
    expect(el.textContent).toContain('Sends2.5 NEAR');
    expect(el.textContent).toContain('NEAR leaving your account2.5 NEAR');
  });

  // The whole key, never cut (review of 5ef13452).
  const keyShort = (k: string) => k;
  it.each([
    ['a full-access key', { type: 'addKey', publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } } as NearAction, `This gives full control of your account to another key, ${nearPublicKeyString(OTHER_KEY.bytes)}. Whoever holds that key can take all its NEAR and tokens and lock you out.`, `Gives full control to another key (${keyShort(nearPublicKeyString(OTHER_KEY.bytes))})`],
    ['a function-call key', { type: 'addKey', publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { type: 'functionCall', allowance: null, receiverId: 'x.testnet', methodNames: [] } } } as NearAction, 'This lets another device or app act for you on x.testnet without asking. It can do anything there and spend NEAR from your account on fees.', `Lets another device or app (key ${keyShort(nearPublicKeyString(OTHER_KEY.bytes))}) act for you on x.testnet`],
    ['removing the Journear Passport key', { type: 'deleteKey', publicKey: { type: 'ed25519', bytes: PUB } } as NearAction, 'This removes your Journear Passport key from your account. Journear Passport can then no longer approve for it, so you lose control of it.', 'Removes your Journear Passport key'],
    ['deleting the account', { type: 'deleteAccount', beneficiaryId: 'bob.testnet' } as NearAction, 'This deletes your account and sends all of its NEAR to bob.testnet. It can’t be undone.', 'Deletes your account and sends all its NEAR to bob.testnet'],
    ['deploying a contract', { type: 'deployContract', code: Uint8Array.of(0, 97, 115, 109) } as NearAction, 'This puts a program on your account. The program can do anything the account can, including moving everything in it.', 'Puts a program on your account'],
    ['using a global contract', { type: 'useGlobalContract', contract: { type: 'accountId', accountId: 'g.testnet' } } as NearAction, 'This puts a shared program on your account. The program can do anything the account can, including moving everything in it.', 'Puts a shared program on your account'],
  ])('%s: one red box with the banner; the headline names the action (D814)', (_, action, warning, bullet) => {
    const el = tx([action]);
    const banner = el.querySelector('p.takeover.banner');
    expect(banner?.textContent).toBe(NEAR_ACCOUNT_CONTROL_BANNER);
    expect(banner?.closest('.danger-box')?.getAttribute('role')).toBe('alert');
    // A single action: its headline names it whole, so no bullet repeats it (the banner stays).
    // Removing the user's own key keeps its bullet: the line names the key, not whose it is.
    expect(takeovers(el)).toEqual(action.type === 'deleteKey' ? [NEAR_ACCOUNT_CONTROL_BANNER, bullet] : [NEAR_ACCOUNT_CONTROL_BANNER]);
    expect(nearControlWarnings(action, ME, ME)).toEqual([warning]);
    expect(el.querySelector('li.op.takeover-op')).not.toBeNull();
  });

  it('deleting the account says all of it leaves', () => {
    expect(tx([{ type: 'deleteAccount', beneficiaryId: 'bob.testnet' }]).textContent).toContain('All of it (the account is deleted)');
  });

  it('a transaction relaying someone else’s delegate action is never shown (its signer pays the delegate’s deposits)', () => {
    expect(() => tx([
      {
        type: 'delegate',
        signedDelegate: {
          delegateAction: { senderId: 'bob.testnet', receiverId: 'bob.testnet', actions: [{ type: 'addKey', publicKey: OTHER_KEY, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } }], nonce: 1n, maxBlockHeight: 5n, publicKey: OTHER_KEY },
          signature: { type: 'ed25519', bytes: new Uint8Array(64) },
        },
      },
    ])).toThrow(/relays a delegate action/u);
  });

  it('method names with invisible characters are shown as hex', () => {
    const el = tx([{ type: 'functionCall', methodName: 'a​b', args: new Uint8Array(0), gas: 1n, deposit: 0n }]);
    expect(el.textContent).toContain('(shown as hex) 61e2808b62');
  });
});

describe('renderApproval: NEAR network line (D726)', () => {
  it('says what Journear checked, and labels everything else as the app’s claim', () => {
    expect(nearNetworkLine('near_tx', 'testnet', TESTNET)).toBe('NEAR test network (checked by Journear)');
    expect(nearNetworkLine('near_tx', 'mainnet', TESTNET)).toBe('NEAR real network. Only the app says so; Journear couldn’t check.');
    expect(nearNetworkLine('near_delegate', 'testnet', { envNetwork: 'testnet', testApp: true })).toBe('NEAR test network (checked by Journear)');
    expect(nearNetworkLine('near_delegate', 'testnet', TESTNET)).toBe('NEAR test network. Only the app says so; Journear couldn’t check.');
    // How it was checked stays in the details, in D726's words.
    expect(nearNetworkDetail('near_tx', 'testnet', TESTNET)).toBe('testnet (Journear found its block hash on testnet)');
    expect(nearNetworkDetail('near_delegate', 'testnet', { envNetwork: 'testnet', testApp: true })).toBe('testnet (Journear checked your key, nonce and expiry on testnet)');
    expect(nearNetworkDetail('near_delegate', 'mainnet', TESTNET)).toBe('mainnet, as the app says (Journear can’t check this)');
    expect(nearNetworkLine('near_delegate', 'mainnet', TESTNET)).toBe('NEAR real network. Only the app says so; Journear couldn’t check.');
  });
});

describe('renderApproval: NEAR delegate actions and messages', () => {
  /** A relayed call to `receiverId` as the stamps demo sends it, for a test app or a live app. */
  const relayed = (actions: NearAction[], testApp: boolean, receiverId = 'guestbook.testnet', network: 'testnet' | 'mainnet' = 'testnet'): HTMLElement => {
    const bytes = encodeNearDelegateAction({ senderId: ME, receiverId, actions, nonce: 7n, maxBlockHeight: 277_000_600n, publicKey: { type: 'ed25519', bytes: PUB } });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: ME, context: { nearNetwork: network }, bytes }), 'Partner App', { envNetwork: 'testnet', testApp });
    document.body.replaceChildren(el);
    plain(el);
    return el;
  };
  const factRows = (el: Element) => [...el.querySelectorAll('dl.summary-facts dt')].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`);
  const aboveFold = (el: Element) => [...el.children].filter((c) => !c.matches('details')).map((c) => c.textContent).join('\n');

  it('D858: the stamps demo’s relayed call for a test app: network, one cost row, the acts-as-you risk in amber, the test-app note only', () => {
    const el = relayed([call('{"text":"hi"}')], true);
    expect(factRows(el)).toEqual(['Network: NEAR test network (checked by Journear)', 'Cost to you: nothing. Someone else pays the fee.']);
    // No fee row, no "NEAR leaving your account" row, no blue note: "someone else pays" is said once.
    const shown = aboveFold(el);
    expect(shown).not.toContain('Network fee');
    expect(shown).not.toContain('NEAR leaving your account');
    expect(el.querySelector('.request > .jp-alert-info, .request > .note')).toBeNull();
    expect(shown.split('Someone else pays').length - 1).toBe(1);
    // The one real risk, amber, naming the contract; the network sentence is dropped (the vault binds a test app's).
    const amber = el.querySelector('.warning-box');
    expect(amber?.querySelector('.risk-lead')?.textContent).toBe('This acts as you: guestbook.testnet can use anything you keep with it.');
    expect(amber?.querySelectorAll('li')).toHaveLength(0);
    expect(el.querySelector('.danger-box')).toBeNull();
    expect(el.textContent).not.toContain('could also be used');
    // Never "Journear pays": a partner may relay it itself.
    expect(shown).not.toMatch(/Journear pays/u);
    // Who pays, in technical words, and the expiry: in the details.
    const details = el.querySelector('details.request-details')!;
    expect(details.textContent).toContain('NEAR transaction, fee paid by a relayer');
    expect(details.textContent).toContain(NEAR_DELEGATE_NOTES.relayer);
    expect(details.textContent).toContain('Valid until block277000600');
  });

  it('D858: a live app’s relayed call also says, in amber, that it could be used on the other NEAR network', () => {
    const el = relayed([call('{"text":"hi"}')], false);
    const amber = el.querySelector('.warning-box')!;
    expect(amber.querySelector('.risk-lead')?.textContent).toBe('This acts as you: guestbook.testnet can use anything you keep with it.');
    expect([...amber.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['This approval could also be used on the real NEAR network if your account exists there.']);
    expect(NEAR_DELEGATE_NOTES.network('mainnet')).toBe('This approval could also be used on the NEAR test network if your account exists there.');
    // Not a blue box: a risk is never in an information box (D853).
    expect(el.textContent).not.toContain('doesn’t name a network');
    expect(factRows(el)).toEqual(['Network: NEAR test network. Only the app says so; Journear couldn’t check.', 'Cost to you: nothing. Someone else pays the fee.']);
  });

  it('D858: NEAR attached to a free call is someone else’s, in its own row; tokens or NEAR of the user’s keep the fee and total rows', () => {
    const attached = relayed([{ type: 'functionCall', methodName: 'collect', args: utf8('{}'), gas: 30_000_000_000_000n, deposit: 10n ** 24n }], true);
    expect(factRows(attached)).toEqual(['Network: NEAR test network (checked by Journear)', 'Cost to you: nothing. Someone else pays the fee.']);
    expect(aboveFold(attached)).toContain('NEAR it sends, paid by someone else1 NEAR');
    // A token transfer: the fee row and the NEAR-leaving row as decided (D723, D729), never "Cost to you: nothing".
    const tokens = relayed([{ type: 'functionCall', methodName: 'ft_transfer', args: utf8('{"receiver_id":"bob.testnet","amount":"5"}'), gas: 30_000_000_000_000n, deposit: 1n }], true, 'usdc.testnet');
    expect(factRows(tokens)).toEqual(['Network: NEAR test network (checked by Journear)', 'Network fee: free for you: someone else pays it']);
    expect(aboveFold(tokens)).toContain(`NEAR leaving your account${NEAR_DELEGATE_NONE}`);
    expect(aboveFold(tokens)).not.toContain('Cost to you');
    expect(NEAR_DELEGATE_NONE).toBe('None of your NEAR (someone else pays the fee and any NEAR it sends). Tokens it moves are yours.');
  });

  it('a delegate action: what it sends is the relayer’s; a burn or a deleted account still leaves the user’s', () => {
    const render = (actions: NearAction[]) => {
      const bytes = encodeNearDelegateAction({ senderId: ME, receiverId: ME, actions, nonce: 7n, maxBlockHeight: 9n, publicKey: { type: 'ed25519', bytes: PUB } });
      return renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: ME, context: { nearNetwork: 'testnet' }, bytes }), 'P', TESTNET).textContent!;
    };
    expect(NEAR_DELEGATE_NOTES.relayer).toBe(
      'Someone else (a relayer) sends this for you. They pay the network fee and prepay any NEAR it attaches or sends; if an action fails, that NEAR comes back to your account. The actions run as your account.',
    );
    const sends = render([{ type: 'transfer', deposit: 2n * 10n ** 24n }]);
    expect(sends).toContain(`NEAR leaving your account${NEAR_DELEGATE_NONE}`);
    // A call to a contract on the user's own account: unknown, under the banner.
    const own = render([{ type: 'functionCall', methodName: 'm', args: new Uint8Array(0), gas: 1n, deposit: 0n }]);
    expect(own).toContain(`NEAR leaving your account${NEAR_OWN_CONTRACT_TOTAL}`);
    expect(own).toContain(NEAR_ACCOUNT_CONTROL_BANNER);
    expect(sends).toContain('NEAR it sends, paid by someone else2 NEAR');
    expect(render([{ type: 'deployGlobalContract', code: new Uint8Array(10), deployMode: 'accountId' }])).toContain('NEAR leaving your account0.001 NEAR');
    expect(render([{ type: 'deleteAccount', beneficiaryId: 'bob.testnet' }])).toContain('All of it (the account is deleted)');
  });

  it('a NEP-413 message: the recipient first, the message as text', () => {
    const bytes = encodeNep413Message({ message: 'Sign in to Guestbook', nonce: new Uint8Array(32).fill(1), recipient: 'guestbook.example', callbackUrl: 'https://guestbook.example/cb' });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'Partner App');
    expect(el.querySelector('p.warn')?.textContent).toBe(nearMessageWarning('guestbook.example'));
    expect(el.textContent).toContain('Forguestbook.example');
    expect(el.textContent).toContain('Then returns tohttps://guestbook.example/cb');
    expect(el.querySelector('pre.message')?.textContent).toBe('Sign in to Guestbook');
  });

  it('NEP-413: a recipient that isn’t the requesting page’s host is flagged; look-alike characters are written out', () => {
    const msg = (recipient: string, parentOrigin?: string) => {
      const bytes = encodeNep413Message({ message: 'Sign in', nonce: new Uint8Array(32), recipient, callbackUrl: null });
      return renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'P', { envNetwork: 'testnet', testApp: false, ...(parentOrigin ? { parentOrigin } : {}) });
    };
    // D814: one amber box; a mismatch leads it, in full.
    const mismatches = (el: HTMLElement) => [...el.querySelectorAll('.warning-box .recipient-mismatch')].map((p) => [p.className, p.textContent]);
    const dangers = (el: HTMLElement) => [...el.querySelectorAll('p.danger')].map((p) => p.textContent);
    expect(mismatches(msg('guestbook.example', 'https://guestbook.example'))).toEqual([]);
    expect(mismatches(msg('https://guestbook.example', 'https://guestbook.example'))).toEqual([]);
    // Every other shape gets the same line, in the same style: no pattern can soften it.
    for (const recipient of ['bank.example', 'https://bank.example/login', 'guestbook.near', 'guestbook.testnet', 'guestbook.example/login', 'Guestbook']) {
      expect(mismatches(msg(recipient, 'https://guestbook.example'))).toEqual([['risk-lead warn recipient-mismatch', nearRecipientMismatch(recipient, 'guestbook.example')]]);
    }
    expect(dangers(msg('gооgle.com', 'https://gооgle.com'.normalize()))).toContain(nearRecipientLookalike('g\\u043e\\u043egle.com'));
    expect(nearRecipientMismatch('bank.example', 'guestbook.example')).toBe('This app is at guestbook.example, but the proof is for bank.example. Only sign if you expected that.');
  });

  it('a message with invisible characters is shown as hex', () => {
    const bytes = encodeNep413Message({ message: 'a‮b', nonce: new Uint8Array(32), recipient: 'r', callbackUrl: null });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes }), 'Partner App');
    expect(el.textContent).toContain('shown in its raw form');
  });
});
