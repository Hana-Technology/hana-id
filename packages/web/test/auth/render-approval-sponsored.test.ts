// @vitest-environment happy-dom
// The approval window for a sponsored EVM action (D831, D850): the plain summary of its calls with every warning an
// ordinary transaction with those calls gets, the fee line, the amber one-time setup note only when an authorization
// is signed, and the details (folded) listing every call plus the account helper, the relayer and the deadline. The
// page decodes the subject against the build's own sponsor chains and offers no Approve when they don't match.
// Also: a Stellar setOptions that sets the user's own key to weight 0 keeps its "you lose control" bullet (PR 65's
// leftover Low).
import { approvalDigest, newRequestId, toHex } from '@hana-id/core';
import { type DecodedApproval, decodeApprovalRequest } from '@hana-id/core/decode';
import { encodeSponsorSubject } from '@hana-id/core/evm-sponsor';
import { Keypair, Operation } from '@stellar/stellar-base';
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
  SPONSOR_RELAYER,
  TOKEN,
  UINT256_MAX,
  calldata,
  sponsorSubject,
  sponsoredApproval,
  sponsoredCall,
} from '../../../core/test/evm-sponsored-fixture.ts';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, remoteWindow, resetDom } from './helpers.ts';

const APP = 'Partner App';
const TRANSFER = calldata('transfer(address,uint256)', RECIPIENT, 5_000_000n);
const APPROVE_MAX = calldata('approve(address,uint256)', SPENDER, UINT256_MAX);
const SETUP = 'One-time setup: this also turns on free network fees for your account on the local test chain 31337. Your address stays the same and you still approve every action.';

const decodeSponsored = (over: Parameters<typeof sponsorSubject>[0] = {}): DecodedApproval => decodeApprovalRequest(sponsoredApproval(sponsorSubject(over)), { sponsorChains: SPONSOR_CHAINS });
const render = (decoded: DecodedApproval, nowMs?: number): HTMLElement => {
  const el = renderApproval(dom(document), decoded, APP, { envNetwork: 'testnet', testApp: false, parentOrigin: PARTNER, address: SPONSOR_ME, ...(nowMs === undefined ? {} : { nowMs }) });
  document.body.replaceChildren(el);
  // A valid request never gets the catch-all summary (review 3).
  expect(el.querySelector('.summary-failed')).toBeNull();
  return el;
};
const details = (el: ParentNode) => el.querySelector<HTMLDetailsElement>('details.request-details') as HTMLDetailsElement;
const aboveFold = (el: HTMLElement): string => [...el.children].filter((c) => !c.matches('details')).map((c) => c.textContent).join('\n');
const fact = (el: ParentNode, label: string): string | null => {
  const dt = [...el.querySelectorAll('dt')].find((x) => x.textContent === label);
  return dt?.nextElementSibling?.textContent ?? null;
};
const lines = (el: ParentNode) => [...el.querySelectorAll('p.summary-line')].map((p) => p.textContent);

beforeEach(() => document.body.replaceChildren());

describe('a sponsored action’s window', () => {
  it('first time, one known call: its headline, the fee line, the amber setup note (lead); the details folded with the setup row', () => {
    const el = render(decodeSponsored({ authNonce: 0n, calls: [sponsoredCall(TOKEN, TRANSFER)] }));
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to send tokens of contract ${TOKEN} to ${RECIPIENT}`);
    expect(el.dataset.explainable).toBe('true');
    expect(el.querySelector('.danger-box')).toBeNull();
    expect(el.querySelectorAll('.warning-box')).toHaveLength(1);
    expect(el.querySelector('.warning-box p.risk-lead.summary-warning.account-setup')?.textContent).toBe(SETUP);
    expect(fact(el, 'Network fee')).toBe('none. Journear pays it for you.');
    expect(fact(el, 'Network')).toBe('Local (Hardhat, Anvil), chain 31337');
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
    const el = render(decodeSponsored({ calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    expect(el.dataset.explainable).toBe('false');
    expect(el.querySelector('.danger-box p.risk-lead.summary-warning.cannot-explain')?.textContent).toContain('Journear can’t tell what this request does: it calls a function Journear doesn’t recognise.');
    expect(details(el).textContent).toContain(`Unknown function ${CHECK_IN_DATA}. Its raw data:`);
  });

  it('an unlimited approve inside a sponsored batch: the red warning leads, the setup note in the amber box', () => {
    const el = render(decodeSponsored({ authNonce: 0n, calls: [sponsoredCall(TOKEN, APPROVE_MAX)] }));
    expect(el.querySelector('.danger-box p.risk-lead.summary-warning.unlimited-spend')?.textContent).toBe(
      `This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit, until you take the permission back. Approve only if you trust it completely.`,
    );
    expect(el.querySelector('.warning-box p.risk-lead')?.textContent).toBe(SETUP);
    // The red box comes right under the headline, the amber one after the fee row.
    const kids = [...el.children];
    expect(kids.indexOf(el.querySelector('.danger-box') as Element)).toBe(1);
    expect(kids.indexOf(el.querySelector('.warning-box') as Element)).toBeGreaterThan(kids.indexOf(el.querySelector('.summary-facts') as Element));
  });

  it('several calls: grouped lines; every call in the details, numbered', () => {
    const el = render(decodeSponsored({ calls: [sponsoredCall(TOKEN, TRANSFER), sponsoredCall(TOKEN, TRANSFER), sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to do 3 things in one transaction`);
    expect(lines(el)).toEqual([`2 times: send tokens of contract ${TOKEN} to ${RECIPIENT}. Amount: 5,000,000 in the token’s smallest units (Journear doesn’t know this token’s decimals).`, `Use contract ${CHECK_IN}`]);
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

describe('/approve: a sponsored action is checked against this build', () => {
  let win: FakeWindow;
  let vault: RemoteWindow;
  let page: ReturnType<typeof startApprovePage>;
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
    page = startApprovePage({ win, env, isGesture: () => true });
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
    expect(document.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to send tokens of contract ${TOKEN} to ${RECIPIENT}`);
    expect(document.querySelector('p.account')?.textContent).toBe(`Your EVM account ${SPONSOR_ME}`);
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
    expect(el.querySelector('h2.summary-headline')?.textContent).toBe(`${APP} wants to set your own key’s weight to 0`);
    expect(el.querySelector('.danger-box .risk-lead')?.textContent).toBe(ACCOUNT_CONTROL_BANNER);
    expect([...el.querySelectorAll('.danger-box li')].map((li) => li.textContent)).toEqual(['Sets your own Journear Passport key’s weight to 0: you lose control of the account']);
  });

  it('a weight other than 0 still drops its bullet when its line is in view, and keeps the 0 one in a group', () => {
    expect(renderStellar([Operation.setOptions({ masterWeight: 1 })]).querySelectorAll('.danger-box li')).toHaveLength(0);
    const other = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(44) as never).publicKey();
    const el = renderStellar([Operation.setOptions({ masterWeight: 0 }), Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 1 } })]);
    const bullets = [...el.querySelectorAll('.danger-box li')].map((li) => li.textContent);
    expect(bullets).toContain('Sets your own Journear Passport key’s weight to 0: you lose control of the account');
    expect(bullets.join('\n')).not.toContain(other);
  });
});

it('the sponsor fixture’s chain is the pinned local chain', () => {
  expect(SPONSOR_CHAIN).toBe(31337);
});
