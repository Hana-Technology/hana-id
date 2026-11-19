// @vitest-environment happy-dom
// The approval window for a sponsored EVM action (D831, D850): the plain summary of its calls with every warning an
// ordinary transaction with those calls gets, the fee line, the amber one-time setup note only when an authorization
// is signed, and the details (folded) listing every call plus the account helper, the relayer and the deadline. The
// page decodes the subject against the build's own sponsor chains and offers no Approve when they don't match.
// Also: a Stellar setOptions that sets the user's own key to weight 0 keeps its "you lose control" bullet (PR 65's
// leftover Low).
import { approvalDigest, encodeNearTransaction, evmTxSigningPayload, nearImplicitAccountId, newRequestId, parseEvmTxRequest, toHex, utf8 } from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest } from '@hana-id/core/decode';
import { encodeSponsorSubject } from '@hana-id/core/evm-sponsor';
import { Keypair, Operation } from '@stellar/stellar-base';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { startApprovePage } from '../../src/auth/approve-page.ts';
import { dom } from '../../src/auth/dom.ts';
import { ACCOUNT_CONTROL_BANNER, renderApproval, validUntil } from '../../src/auth/render-approval.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { PASSPHRASE, USER, txBytes } from '../../../core/test/stellar-fixtures.ts';
import {
  CHECK_IN,
  CHECK_IN_DATA,
  RECIPIENT,
  SPENDER,
  SPONSOR_CHAIN,
  SPONSOR_CHAINS,
  SPONSOR_DELEGATE,
  SPONSOR_ME,
  SPONSOR_NOW_MS,
  SPONSOR_RELAYER,
  TOKEN,
  UINT256_MAX,
  calldata,
  sponsorSubject,
  sponsoredApproval,
  sponsoredCall,
} from '../../../core/test/evm-sponsored-fixture.ts';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, remoteWindow, resetDom } from './helpers.ts';
import { jargonWatch, shownText } from './plain-words.ts';
import { shortId } from '@hana-id/core/decode';

const APP = 'Partner App';
/** A contract Journear doesn't know, called with the check-in's selector. */
const UNKNOWN = '0x4444444444444444444444444444444444444444' as const;
const TRANSFER = calldata('transfer(address,uint256)', RECIPIENT, 5_000_000n);
const APPROVE_MAX = calldata('approve(address,uint256)', SPENDER, UINT256_MAX);
const SETUP = 'One-time setup: this also turns on free network fees for your account on the local test network. Your address stays the same and you still approve every action.';

const decodeSponsored = (over: Parameters<typeof sponsorSubject>[0] = {}): DecodedApproval => decodeApprovalRequest(sponsoredApproval(sponsorSubject(over)), { sponsorChains: SPONSOR_CHAINS, nowMs: SPONSOR_NOW_MS });
const plain = jargonWatch();
const render = (decoded: DecodedApproval, nowMs?: number): HTMLElement => {
  const el = renderApproval(dom(document), decoded, APP, { envNetwork: 'testnet', testApp: false, parentOrigin: PARTNER, address: SPONSOR_ME, ...(nowMs === undefined ? {} : { nowMs }) });
  document.body.replaceChildren(el);
  // A valid request never gets the catch-all summary (review 3).
  expect(el.querySelector('.summary-failed')).toBeNull();
  plain(el);
  return el;
};
const details = (el: ParentNode) => el.querySelector<HTMLDetailsElement>('details.request-details') as HTMLDetailsElement;
const aboveFold = (el: HTMLElement): string => [...el.children].filter((c) => !c.matches('details')).map((c) => c.textContent).join('\n');
const fact = (el: ParentNode, label: string): string | null => {
  const dt = [...el.querySelectorAll('dt')].find((x) => x.textContent === label);
  return dt?.nextElementSibling?.textContent ?? null;
};
const lines = (el: ParentNode) => [...el.querySelectorAll('p.summary-line')].map(shownText);

beforeEach(() => document.body.replaceChildren());

describe('a sponsored action’s window', () => {
  it('first time, one known call: its headline, the fee line, the amber setup note (lead); the details folded with the setup row', () => {
    const el = render(decodeSponsored({ authNonce: 0n, calls: [sponsoredCall(TOKEN, TRANSFER)] }));
    expect(shownText(el.querySelector('h2.summary-headline'))).toBe(`${APP} wants to send 5,000,000 units of an unlisted token to ${shortId(RECIPIENT)}`);
    expect(el.dataset.explainable).toBe('true');
    expect(el.querySelector('.danger-box')).toBeNull();
    expect(el.querySelectorAll('.warning-box')).toHaveLength(1);
    expect(el.querySelector('.warning-box p.risk-lead.summary-warning.account-setup')?.textContent).toBe(SETUP);
    expect(fact(el, 'Network fee')).toBe('Free. Journear pays it for you.');
    expect(fact(el, 'Network')).toBe('Local test network');
    // The technical facts are in the details, which start folded.
    const d = details(el);
    expect(d.open).toBe(false);
    expect(d.querySelector('h3')?.textContent).toBe('EVM action, network fee paid by Journear');
    expect(fact(d, 'Account setup (EIP-7702)')).toBe(`account helper ${SPONSOR_DELEGATE} ✓ Journear Passport account helper v1, chain 31337, account nonce 0`);
    expect(fact(d, 'Paid by')).toBe(`Journear’s relayer ${SPONSOR_RELAYER}`);
    expect(fact(d, 'From')).toBe(SPONSOR_ME);
    expect(fact(d, 'Valid until')).toMatch(/^\d\d:\d\d( on \d{4}-\d\d-\d\d)? \(your time; unix 1900000000\)$/u);
    expect(fact(d, 'Action nonce')).toBe('0');
    expect(fact(d, 'Gas floor')).toBe('100000 gas');
    expect(d.querySelector('h2')?.textContent).toBe('1 call');
    const call = d.querySelector('ol.ops > li.op') as HTMLElement;
    expect(fact(call, 'To')).toBe(TOKEN);
    expect(fact(call, 'Value')).toBe('0 (0 wei)');
    expect(call.textContent).toContain('Function transfer(address,uint256) 0xa9059cbb');
    // EIP-7702 is named only in the details; "upgrade" and "smart account" nowhere.
    expect(aboveFold(el)).not.toMatch(/7702|delegat/iu);
    expect(el.textContent).not.toMatch(/upgrade|smart account/iu);
  });

  it('later (no authorization): no setup note, no amber box; the helper row says this approval sets nothing up', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(TOKEN, TRANSFER)] }));
    expect(el.querySelector('.warning-box')).toBeNull();
    expect(el.querySelector('.risk-box')).toBeNull();
    expect(fact(details(el), 'Account setup (EIP-7702)')).toBeNull();
    expect(fact(details(el), 'Account helper (EIP-7702)')).toBe(`${SPONSOR_DELEGATE} ✓ Journear Passport account helper v1 (no setup in this approval)`);
  });

  it('an unknown call: the red "can’t tell" line leads; its raw data is in the details', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(UNKNOWN, CHECK_IN_DATA)] }));
    expect(el.dataset.explainable).toBe('false');
    expect(el.querySelector('.danger-box p.risk-lead.summary-warning.cannot-explain')?.textContent).toContain('Journear can’t check what this does (it asks for an action Journear doesn’t know).');
    expect(details(el).textContent).toContain(`Unknown function ${CHECK_IN_DATA}. Its raw data:`);
  });

  it('an unlimited approve inside a sponsored batch: the red warning leads, the setup note in the amber box', () => {
    const el = render(decodeSponsored({ authNonce: 0n, calls: [sponsoredCall(TOKEN, APPROVE_MAX)] }));
    expect(shownText(el.querySelector('.danger-box p.risk-lead.summary-warning.unlimited-spend'))).toBe(
      `This lets ${shortId(SPENDER)} (not checked by Journear) take all your tokens from ${shortId(TOKEN)} (an unlisted token), now or later, with no limit. Approve only if you trust them completely.`,
    );
    expect(el.querySelector('.warning-box p.risk-lead')?.textContent).toBe(SETUP);
    // The red box comes right under the headline, the amber one after the fee row.
    const kids = [...el.children];
    expect(kids.indexOf(el.querySelector('.danger-box') as Element)).toBe(1);
    expect(kids.indexOf(el.querySelector('.warning-box') as Element)).toBeGreaterThan(kids.indexOf(el.querySelector('.summary-facts') as Element));
  });

  it('several calls: grouped lines; every call in the details, numbered', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(TOKEN, TRANSFER), sponsoredCall(TOKEN, TRANSFER), sponsoredCall(UNKNOWN, CHECK_IN_DATA)] }));
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to do 3 things at once`);
    expect(lines(el)).toEqual([`2 times: send 5,000,000 units of an unlisted token to ${shortId(RECIPIENT)}. Journear doesn’t know this token (${shortId(TOKEN)}), so it can’t tell what 5,000,000 units are worth. Check the amount in ${APP} first.`, `Use the program ${shortId(UNKNOWN)}`]);
    expect([...details(el).querySelectorAll('ol.ops > li.op > h3')].map((h) => h.textContent)).toEqual(['1. Call', '2. Call', '3. Call']);
    expect(details(el).querySelector('h2')?.textContent).toBe('3 calls');
  });

  it('validUntil: the user’s time, the date when it isn’t today, the raw value out of range', () => {
    const at = new Date(2030, 0, 2, 9, 5).getTime();
    const s = BigInt(at / 1000);
    expect(validUntil(s, at - 60_000)).toBe(`09:05 (your time; unix ${s})`);
    expect(validUntil(s, at - 86_400_000)).toBe(`09:05 on 2030-01-02 (your time; unix ${s})`);
    expect(validUntil(s)).toBe(`09:05 on 2030-01-02 (your time; unix ${s})`);
    expect(validUntil(2n ** 64n - 1n)).toBe(`${2n ** 64n - 1n} (unix seconds)`);
  });
});

describe('Journear’s demo check-in (D854)', () => {
  it('reads plainly with no box, its name and address in view; the details name its function', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to check you in`);
    expect(lines(el)).toEqual(['This is Journear’s demo check-in. It doesn’t move any money or tokens.', `It uses Journear demo check-in (${shortId(CHECK_IN)}, checked by Journear).`]);
    // D859: the whole address once, in its own row right under its line.
    expect(shownText(el.querySelector('p.summary-line + p.summary-line + dl.id-rows'))).toBe(`Program${CHECK_IN}`);
    expect(el.querySelector('.risk-box')).toBeNull();
    expect(el.dataset.explainable).toBe('true');
    expect(details(el).textContent).toContain('Function checkIn() 0x183ff085');
    expect(details(el).textContent).not.toContain('Unknown function');
  });

  it('the first time: only the amber setup note', () => {
    const el = render(decodeSponsored({ authNonce: 0n, calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    expect(el.querySelector('.danger-box')).toBeNull();
    expect(el.querySelector('.warning-box p.risk-lead')?.textContent).toBe(SETUP);
  });

  it('the same selector on another contract: red, "Unknown function" in the details', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(UNKNOWN, CHECK_IN_DATA)] }));
    expect(el.querySelector('.danger-box .cannot-explain')).not.toBeNull();
    expect(details(el).textContent).toContain('Unknown function 0x183ff085');
  });
});

describe('/approve: a sponsored action is checked against this build', () => {
  let win: FakeWindow;
  let vault: RemoteWindow;
  let page: ReturnType<typeof startApprovePage>;
  let clock = SPONSOR_NOW_MS;
  const SPONSOR_ENV: HanaEnv = Object.freeze({ ...ENV, evmSponsor: SPONSOR_CHAINS });
  const request = (over: Parameters<typeof sponsorSubject>[0] = {}, msg: Record<string, unknown> = {}) => ({
    v: 1,
    t: 'hana:approve-request',
    id: newRequestId(),
    appName: APP,
    parentOrigin: PARTNER,
    ...sponsoredApproval(sponsorSubject(over)),
    position: 1,
    queued: 1,
    ...msg,
  });
  const start = (env: HanaEnv) => {
    // The page's clock: `clock` when it starts, moving with the fake timers (the Approve guard times itself with it).
    const started = Date.now();
    const at = clock;
    page = startApprovePage({ win, env, isGesture: () => true, now: () => at + (Date.now() - started) });
    win.dispatch('focus');
  };
  const approveButton = () => document.querySelector<HTMLButtonElement>('button.primary');

  beforeEach(() => {
    resetDom();
    vi.useFakeTimers();
    win = new FakeWindow('/approve');
    vault = remoteWindow();
    win.opener = asWindow(vault);
  });
  afterEach(() => {
    page.stop();
    vi.useRealTimers();
  });

  it('a build that sponsors the chain shows it with Approve, and the answer’s digest binds the subject bytes', () => {
    start(SPONSOR_ENV);
    const m = request({ authNonce: 0n, calls: [sponsoredCall(TOKEN, TRANSFER)] });
    win.message(m, ENV.vaultOrigin, vault);
    expect(shownText(document.querySelector('h2.summary-headline'))).toBe(`${APP} wants to send 5,000,000 units of an unlisted token to ${shortId(RECIPIENT)}`);
    expect(shownText(document.querySelector('p.account'))).toBe(`Your account: ${shortId(SPONSOR_ME)} (Ethereum-style)`);
    expect(approveButton()).not.toBeNull();
    vi.advanceTimersByTime(GUARD_DELAY_MS);
    win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1 });
    win.dispatch('pointerdown', { pointerType: 'mouse' });
    approveButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const results = vault.received.filter((r) => (r as { t?: string }).t === 'hana:approve-result') as { id: string; approved: boolean; digest: Uint8Array }[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: m.id, approved: true });
    const { v: _v, t: _t, appName: _a, position: _p, queued: _q, ...input } = m;
    expect(toHex(results[0]!.digest)).toBe(toHex(approvalDigest(input)));
  });

  it.each([
    ['a build with no sponsored chain', ENV, {}],
    ['a delegate other than the pinned one', SPONSOR_ENV, { delegate: '0x7702000000000000000000000000000000007702' as const }],
    ['a relayer other than the build’s', SPONSOR_ENV, { relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const }],
    ['a call to the user’s own account', SPONSOR_ENV, 'own'],
  ] as const)('%s: refused, no Approve', (_name, env, over) => {
    start(env);
    if (over === 'own') {
      // encodeSponsorSubject refuses it, so the hostile bytes are built by hand from a valid subject's.
      const good = encodeSponsorSubject(sponsorSubject({ calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
      const hex = toHex(good).replace(CHECK_IN.slice(2).toLowerCase(), SPONSOR_ME.slice(2).toLowerCase());
      win.message(request({}, { bytes: Uint8Array.from(Buffer.from(hex, 'hex')) }), ENV.vaultOrigin, vault);
    } else {
      win.message(request(over as Parameters<typeof sponsorSubject>[0]), ENV.vaultOrigin, vault);
    }
    expect(document.body.textContent).toContain('Journear can’t read this request, so it can’t be approved.');
    expect(approveButton()).toBeNull();
    expect(document.querySelector('h2.summary-headline')).toBeNull();
  });

  it('a deadline more than 2 hours ahead of the popup’s clock, or more than 5 minutes past: refused, no Approve', () => {
    for (const [now, ok] of [
      [SPONSOR_NOW_MS, true],
      [(1_900_000_000 - 7201) * 1000, false],
      [(1_900_000_000 + 301) * 1000, false],
    ] as const) {
      clock = now;
      start(SPONSOR_ENV);
      win.message(request(), ENV.vaultOrigin, vault);
      expect(approveButton() !== null, String(now)).toBe(ok);
      page.stop();
      resetDom();
    }
    clock = SPONSOR_NOW_MS;
    start(SPONSOR_ENV);
  });

  it('the chain must be the request’s own: a subject for 31337 under a context of another chain is refused', () => {
    start(SPONSOR_ENV);
    win.message(request({}, { context: { chainId: 84532 } }), ENV.vaultOrigin, vault);
    expect(approveButton()).toBeNull();
  });
});

describe('Stellar: the user’s own key set to weight 0 keeps its bullet (PR 65’s leftover Low)', () => {
  const renderStellar = (ops: ReturnType<typeof Operation.setOptions>[]) => {
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes(ops) }), APP, { envNetwork: 'testnet', testApp: false, address: USER });
    document.body.replaceChildren(el);
    return el;
  };

  it('the line says "set your own key’s weight to 0"; the bullet says the user loses control, and stays', () => {
    const el = renderStellar([Operation.setOptions({ masterWeight: 0 })]);
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to set your own key’s strength to 0`);
    expect(el.querySelector('.danger-box .risk-lead')?.textContent).toBe(ACCOUNT_CONTROL_BANNER);
    expect([...el.querySelectorAll('.danger-box li')].map((li) => li.textContent)).toEqual(['Sets your own Journear Passport key’s strength to 0: you lose control of the account']);
  });

  it('a weight other than 0 still drops its bullet when its line is in view, and keeps the 0 one in a group', () => {
    expect(renderStellar([Operation.setOptions({ masterWeight: 1 })]).querySelectorAll('.danger-box li')).toHaveLength(0);
    const other = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(44) as never).publicKey();
    const el = renderStellar([Operation.setOptions({ masterWeight: 0 }), Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 1 } })]);
    const bullets = [...el.querySelectorAll('.danger-box li')].map((li) => li.textContent);
    expect(bullets).toContain('Sets your own Journear Passport key’s strength to 0: you lose control of the account');
    expect(bullets.join('\n')).not.toContain(other);
  });
});

describe('Stellar: any signing-threshold change keeps its bullet (review, Low)', () => {
  // Whether new thresholds lock the user out depends on the account's current signers and weights, which the request
  // doesn't carry: so the bullet, which says what the line ("change the signing thresholds") doesn't, always stays.
  it.each([
    ['all three thresholds', { lowThreshold: 255, medThreshold: 255, highThreshold: 255 }],
    ['the high threshold alone', { highThreshold: 2 }],
    ['harmless-looking low thresholds', { lowThreshold: 0, medThreshold: 0, highThreshold: 1 }],
  ] as const)('%s', (_name, opts) => {
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([Operation.setOptions(opts)]) }), APP, { envNetwork: 'testnet', testApp: false, address: USER });
    document.body.replaceChildren(el);
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to change how many approvals the account needs`);
    expect([...el.querySelectorAll('.danger-box li')].map((li) => li.textContent)).toEqual(['Changes how many approvals the account needs: wrong numbers can lock you out']);
  });
});

describe('NEAR calls: a malformed standard call is red, a value-like name amber (review of the approval window)', () => {
  it('both in view above the closed details, each in its own box', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const me = nearImplicitAccountId(pub);
    const fc = (methodName: string, args: string) => ({ type: 'functionCall' as const, methodName, args: utf8(args), gas: 1n, deposit: 1n });
    const bytes = encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: pub }, nonce: 1n, receiverId: 'tok.testnet', blockHash: new Uint8Array(32), actions: [fc('ft_transfer', '{"receiver_id":"bob.testnet","amount":5}'), fc('storage_withdraw', '{}')] });
    const el = renderApproval(dom(document), decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: me, context: { nearNetwork: 'testnet' }, bytes }), APP, { envNetwork: 'testnet', testApp: false, address: me });
    document.body.replaceChildren(el);
    expect(el.querySelector('.danger-box p.risk-lead.cannot-explain')?.textContent).toContain('it uses ft_transfer on tok.testnet in a non-standard way');
    expect(el.querySelector('.warning-box p.risk-lead.may-move-tokens')?.textContent).toBe(`This uses tok.testnet (storage_withdraw). It may move tokens or NEAR you keep with tok.testnet. Approve only if you expected this from ${APP}.`);
    expect(details(el).open).toBe(false);
  });
});

it('the sponsor fixture’s chain is the pinned local chain', () => {
  expect(SPONSOR_CHAIN).toBe(31337);
});

// ---- D877: the facts' faces, the free fee and the network's name ----
describe('D877: words in the text face, exact values in mono; the free fee in bold with a check mark', () => {
  const valueOf = (el: ParentNode, label: string) => [...el.querySelectorAll('dt')].find((x) => x.textContent === label)?.nextElementSibling as HTMLElement | undefined;
  /** The text a row's value holds outside any mono element (what the text face shows). */
  const wordsOf = (dd: Element) => {
    const c = dd.cloneNode(true) as Element;
    for (const m of Array.from(c.querySelectorAll('.mono, strong:not(.words)'))) m.remove();
    return c.textContent ?? '';
  };

  it('the sponsored fee: “Free. Journear pays it for you.”, “Free.” in bold after a decorative check mark; the network one line’s worth', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    const fee = valueOf(el, 'Network fee')!;
    expect(fee.textContent).toBe('Free. Journear pays it for you.');
    expect(fee.classList.contains('fee-free')).toBe(true);
    expect(fee.querySelector('strong')?.textContent).toBe('Free.');
    const mark = fee.firstElementChild!;
    expect(mark.matches('svg.ic.fee-free-mark')).toBe(true);
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    // Still one row in the summary's facts, no box of its own.
    expect(fee.closest('dl.jp-kv.summary-facts')).not.toBeNull();
    expect(fee.closest('.jp-alert')).toBeNull();
    // Words, not code: nothing in mono in the network or the fee row.
    expect(valueOf(el, 'Network')?.textContent).toBe('Local test network');
    expect(valueOf(el, 'Network')?.querySelector('.mono')).toBeNull();
    expect(fee.querySelector('.mono')).toBeNull();
  });

  it('an ordinary EVM fee starts with a capital and keeps its exact amount in bold mono; no check mark', () => {
    const r = { kind: 'evm_tx' as const, chain: 'evm' as const, address: SPONSOR_ME, context: { chainId: 84532 } };
    const tx = { chainId: '0x14a34', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', to: RECIPIENT, value: '0x2386f26fc10000', data: '0x' };
    const decoded = decodeApprovalRequest({ ...r, bytes: evmTxSigningPayload(parseEvmTxRequest(tx)) });
    const el = render(decoded);
    const fee = valueOf(el, 'Network fee')!;
    expect(fee.textContent).toBe('Up to 0.000021 ETH');
    expect(fee.classList.contains('fee-free')).toBe(false);
    expect(fee.querySelector('svg')).toBeNull();
    expect(fee.querySelector('strong')?.textContent).toBe('0.000021 ETH');
    expect(valueOf(el, 'Network')?.textContent).toBe('Base Sepolia (test network)');
    // The details: numbers and amounts read exactly are mono; words are not.
    const d = details(el);
    for (const label of ['Chain ID', 'To', 'Value', 'Gas limit', 'Maximum network fee', 'Nonce', 'Max fee per gas', 'Priority fee per gas']) {
      const dd = valueOf(d, label)!;
      expect(dd.querySelector('.mono'), label).not.toBeNull();
      expect(wordsOf(dd).trim(), label).toBe('');
    }
  });

  it('the sponsored details: the deadline and the relayer’s words in the text face, numbers and addresses in mono', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }), SPONSOR_NOW_MS);
    const d = details(el);
    for (const label of ['Chain ID', 'From', 'Action nonce', 'Gas floor']) expect(wordsOf(valueOf(d, label)!).trim(), label).toBe('');
    expect(wordsOf(valueOf(d, 'Paid by')!)).toBe('Journear’s relayer ');
    // The time in words; its unix seconds exact, in mono; the same text as validUntil.
    const until = valueOf(d, 'Valid until')!;
    expect(until.textContent).toBe(validUntil(sponsorSubject({}).deadline, SPONSOR_NOW_MS));
    expect(until.querySelector('code.mono')?.textContent).toBe(String(sponsorSubject({}).deadline));
    expect(wordsOf(until)).toMatch(/^\d{2}:\d{2}.* \(your time; unix \)$/u);
  });

  it('the check mark speaks of the fee only: beside a red box it is in the text colour, never the success green', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(TOKEN, APPROVE_MAX)] }));
    expect(el.querySelector('.danger-box')).not.toBeNull();
    const fee = valueOf(el, 'Network fee')!;
    expect(fee.textContent).toBe('Free. Journear pays it for you.');
    expect(fee.className).toBe('fee-free beside-danger');
    const calm = render(decodeSponsored({ calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    expect(calm.querySelector('.danger-box')).toBeNull();
    expect(valueOf(calm, 'Network fee')?.className).toBe('fee-free');
  });

  it('the stylesheet: the approval’s values in the text face, mono only for code, the free fee’s mark in the success colour', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'auth', 'css', 'approval.css'), 'utf8');
    expect(css).toMatch(/\.request dl\.jp-kv dd \{\s*font-family: var\(--jp-font-body\);/u);
    expect(css).toMatch(/\.request dl\.jp-kv dd\.fee-free strong \{\s*font-family: var\(--jp-font-body\);/u);
    expect(css).toMatch(/\.fee-free-mark \{[^}]*color: var\(--jp-success\);/u);
    expect(css).toMatch(/dd\.fee-free\.beside-danger \.fee-free-mark \{\s*color: var\(--jp-fg\);/u);
  });
});
