// @vitest-environment happy-dom
// /approve (docs/batch-b-spec.md "Approval flow", "Consent", "Tests → Web unit → Approval, Auto-approve, Raw signing"):
// sender checks, the popup's own decode, the digest over exactly what was rendered, the Approve guard, the queue
// position, Reject and close, keep-open reuse, raw requests never decoded, the consent screen and "Stop auto-approving".
import {
  type ApprovalDigestInput,
  approvalDigest,
  consentDigest,
  evmTxSigningPayload,
  newRequestId,
  parseEvmTxRequest,
  parseWindowMessage,
  rawSigningWarning,
  utf8,
} from '@hana-id/core';
import { policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { AUTO_APPROVE_REASON_TEXT, KEEP_OPEN_MS, TEST_APP_NOTE, autoApproveReasonText, startApprovePage } from '../../src/auth/approve-page.ts';
import { NO_NETWORK_NOTE } from '../../src/auth/render-approval.ts';
import { formatEndTime } from '../../src/auth/render-consent.ts';
import { policyJson } from '../../../core/test/policy-fixtures.ts';
import { PASSPHRASE, USER, paymentOp, txBytes } from '../../../core/test/stellar-fixtures.ts';
import { ENV, EVIL, FakeWindow, PARTNER, type RemoteWindow, asWindow, pageText, remoteWindow, resetDom } from './helpers.ts';

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };

type Req = Record<string, unknown> & { id: string };

function evmRequest(over: Record<string, unknown> = {}): Req {
  return {
    v: 1,
    t: 'hana:approve-request',
    id: newRequestId(),
    appName: 'Partner App',
    parentOrigin: PARTNER,
    kind: 'evm_tx',
    chain: 'evm',
    address: EVM,
    bytes: evmTxSigningPayload(parseEvmTxRequest(TX)),
    context: { chainId: 11155111 },
    position: 1,
    queued: 1,
    ...over,
  };
}

const stellarRequest = (over: Record<string, unknown> = {}): Req =>
  evmRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, bytes: txBytes([paymentOp()]), context: { networkPassphrase: PASSPHRASE }, ...over });

const digestInput = (r: Req): ApprovalDigestInput => ({
  id: r.id,
  kind: r.kind as never,
  chain: r.chain as never,
  address: r.address as string,
  parentOrigin: r.parentOrigin as string,
  context: r.context as never,
  bytes: r.bytes as Uint8Array,
});

const POLICY = validateAutoApprovePolicy(policyJson());
if (!POLICY.ok) throw new Error('fixture policy is invalid');
/** The normalized policy as a plain object, as the vault posts it. */
const POLICY_OBJECT = JSON.parse(JSON.stringify(POLICY.policy)) as Record<string, unknown>;
const POLICY_ID = policyId(POLICY.policy);
/** The fake clock's start; the consent ends 12 h after it (the fixture's maxConsentMs). */
const T0 = 1_800_000_000_000;
const CONSENT_END = T0 + 12 * 3_600_000;

const consentRequest = (over: Record<string, unknown> = {}): Req => ({
  v: 1,
  t: 'hana:consent-request',
  id: newRequestId(),
  appName: 'Partner App',
  parentOrigin: PARTNER,
  policy: POLICY_OBJECT,
  policyId: POLICY_ID,
  expiresAtMs: CONSENT_END,
  position: 1,
  queued: 1,
  ...over,
});

let win: FakeWindow;
let vault: RemoteWindow;
let page: ReturnType<typeof startApprovePage>;

const primary = () => document.querySelector<HTMLButtonElement>('button.primary');
const secondary = () => document.querySelector<HTMLButtonElement>('button.secondary');
/** A pointer click: its pointerdown reaches the window first, then the click (detail 1) fires on the button. */
const click = (b: Element | null, pointerType = 'mouse') => {
  if (!b) return;
  win.dispatch('pointerdown', { pointerType });
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
};
/** A stationary touch tap: pointerdown, pointerup, click; no pointermove. */
const tap = (b: Element | null) => {
  if (!b) return;
  win.dispatch('pointerdown', { pointerType: 'touch' });
  win.dispatch('pointerup', { pointerType: 'touch' });
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
};
/** A click on the button with no pointerdown of its own (a pointer click whose press began earlier). */
const bareClick = (b: Element | null) => b?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
/** Enter on a focused button: keydown, then a click with detail 0. */
const keyClick = (b: Element | null, key = 'Enter') => {
  if (!b) return;
  win.dispatch('keydown', { key });
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
};
const send = (m: unknown, origin = ENV.vaultOrigin, source: unknown = vault) => win.message(m, origin, source);
const results = () => vault.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.t !== 'hana:approve-hello');
/** Waits out the guard: 1 s, then a mouse move. */
const arm = () => {
  vi.advanceTimersByTime(GUARD_DELAY_MS);
  win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1 });
};

function start(): void {
  win = new FakeWindow('/approve');
  vault = remoteWindow();
  win.opener = asWindow(vault);
  page = startApprovePage({ win, env: ENV, isGesture: () => true });
  win.dispatch('focus');
}

beforeEach(() => {
  resetDom();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  start();
});
afterEach(() => {
  page.stop();
  vi.useRealTimers();
});

describe('/approve', () => {
  it('says hello to its opener on vaultOrigin', () => {
    expect(vault.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:approve-hello' }, ENV.vaultOrigin);
  });

  it('ignores requests from another origin or another window', () => {
    send(evmRequest(), EVIL);
    send(evmRequest(), ENV.authOrigin);
    send(evmRequest(), ENV.vaultOrigin, remoteWindow());
    send(evmRequest(), ENV.vaultOrigin, null);
    expect(page.state).toBe('connecting');
    expect(primary()).toBeNull();
  });

  it('ignores malformed requests (schema)', () => {
    send({ ...evmRequest(), extra: 1 });
    send({ ...evmRequest(), kind: 'stellar_tx' });
    expect(page.state).toBe('connecting');
  });

  it('decodes and shows an EVM transaction, with the queue position', () => {
    send(evmRequest({ position: 2, queued: 3 }));
    const text = pageText();
    expect(text).toContain('Request 2 of 3 from Partner App');
    expect(text).toContain(PARTNER);
    expect(text).toContain('11155111');
    expect(text).toContain(EVM);
    expect(text).toContain('1 (1000000000000000000 wei)');
  });

  it('decodes and shows a Stellar transaction', () => {
    send(stellarRequest());
    const text = pageText();
    expect(text).toContain(PASSPHRASE);
    expect(text).toContain('payment');
    expect(text).toContain(USER);
  });

  it('Approve sends the digest of exactly what was rendered, bound to the context', () => {
    const r = evmRequest();
    send(r);
    arm();
    click(primary());
    const [result] = results();
    expect(parseWindowMessage(result, ['hana:approve-result'])).not.toBeNull();
    expect(result).toMatchObject({ t: 'hana:approve-result', id: r.id, approved: true });
    expect(result?.digest).toEqual(approvalDigest(digestInput(r)));
    // A request that differs only in context (another chain) has another digest.
    expect(result?.digest).not.toEqual(approvalDigest({ ...digestInput(r), parentOrigin: EVIL }));
    const s = stellarRequest();
    expect(approvalDigest(digestInput(s))).not.toEqual(approvalDigest({ ...digestInput(s), context: { networkPassphrase: 'Public Global Stellar Network ; September 2015' } }));
    expect(vault.postMessage.mock.calls.every((c) => c[1] === ENV.vaultOrigin)).toBe(true);
  });

  describe('the Approve guard', () => {
    it('stays disabled before 1 s since render', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
      win.dispatch('pointermove');
      expect(primary()?.disabled).toBe(true);
      click(primary());
      expect(results()).toEqual([]);
    });

    it('stays disabled without a gesture after the marks, and the gesture that arms it never approves', () => {
      send(evmRequest());
      vi.advanceTimersByTime(10 * GUARD_DELAY_MS);
      expect(primary()?.disabled).toBe(true);
      // Tapping anyway (the disabled attribute removed) does nothing: the guard is checked on click. That tap's
      // pointerdown arms the guard, but the click it belongs to still can't act.
      const b = primary() as HTMLButtonElement;
      b.disabled = false;
      tap(b);
      expect(results()).toEqual([]);
      expect(primary()?.disabled).toBe(false);
    });

    it('mouse: clicks without a pointer move never arm it, however many (click-spam in place)', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      const b = primary() as HTMLButtonElement;
      for (let i = 0; i < 20; i++) {
        b.disabled = false; // as if the attribute were bypassed: the guard itself refuses
        click(b, 'mouse');
        vi.advanceTimersByTime(100);
      }
      expect(results()).toEqual([]);
      expect(page.guard.armed()).toBe(false);
    });

    it('mouse: a synthetic move with zero movement (a layout change under a still cursor) does not arm it', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('pointermove', { pointerType: 'mouse', movementX: 0, movementY: 0 });
      expect(primary()?.disabled).toBe(true);
      win.dispatch('pointermove', { pointerType: 'mouse', movementX: 0, movementY: 2 });
      expect(primary()?.disabled).toBe(false);
      click(primary(), 'mouse');
      expect(results()[0]).toMatchObject({ approved: true });
    });

    it('a click whose press began before the guard armed does not approve', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
      win.dispatch('pointerdown');
      vi.advanceTimersByTime(1);
      win.dispatch('pointermove'); // the drag of that press arms the guard
      expect(primary()?.disabled).toBe(false);
      bareClick(primary());
      expect(results()).toEqual([]);
      click(primary());
      expect(results()[0]).toMatchObject({ approved: true });
    });

    it.each(['touch', 'pen'])('%s: a tap without a move arms it, that tap does not approve, the next tap does', (pointerType) => {
      const r = evmRequest();
      send(r);
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      // A stationary tap: pointerdown/up and click, no pointermove (on the disabled button, which enables at once).
      win.dispatch('pointerdown', { pointerType });
      expect(primary()?.disabled).toBe(false);
      win.dispatch('pointerup', { pointerType });
      bareClick(primary());
      expect(results()).toEqual([]);
      click(primary(), pointerType);
      expect(results()[0]).toMatchObject({ t: 'hana:approve-result', id: r.id, approved: true });
    });

    it('touch: tap-tap on Approve after the marks approves (the residual risk of tap-spam), one tap never does', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      const b = primary() as HTMLButtonElement;
      b.disabled = false;
      tap(b);
      expect(results()).toEqual([]);
      tap(primary());
      expect(results()).toHaveLength(1);
      expect(results()[0]).toMatchObject({ approved: true });
    });

    it('a tap before the 1 s marks neither arms it nor approves', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
      click(primary());
      expect(primary()?.disabled).toBe(true);
      expect(results()).toEqual([]);
    });

    it('keyboard only: Tab after the marks arms it, and Enter on Approve (a later keydown) approves', () => {
      const r = evmRequest();
      send(r);
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('keydown', { key: 'Tab' });
      expect(primary()?.disabled).toBe(false);
      keyClick(primary());
      expect(results()[0]).toMatchObject({ id: r.id, approved: true });
    });

    it.each(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])('keyboard: %s arms it', (key) => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('keydown', { key, shiftKey: key === 'Tab' });
      expect(primary()?.disabled).toBe(false);
    });

    it.each(['Enter', ' ', 'Shift', 'a', 'Escape'])('keyboard: %j never arms it', (key) => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('keydown', { key });
      expect(primary()?.disabled).toBe(true);
    });

    it('a held Enter never approves (auto-repeat), even when the button is enabled by hand', () => {
      send(evmRequest());
      const b = primary() as HTMLButtonElement;
      win.dispatch('keydown', { key: 'Enter' });
      for (let i = 0; i < 40; i++) {
        vi.advanceTimersByTime(50);
        b.disabled = false;
        // Each auto-repeated keydown of a held Enter fires a keyboard click (detail 0) on a focused button.
        win.dispatch('keydown', { key: 'Enter', repeat: true });
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      }
      expect(results()).toEqual([]);
      expect(page.guard.armed()).toBe(false);
      // Nor after a Tab arms it while Enter is still held: only a fresh Enter press approves.
      win.dispatch('keydown', { key: 'Tab' });
      win.dispatch('keydown', { key: 'Enter', repeat: true });
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      expect(results()).toEqual([]);
      keyClick(b);
      expect(results()[0]).toMatchObject({ approved: true });
    });

    it('Approve is never focused by the page: not on render, not when it enables, not in a reused popup', () => {
      send(evmRequest());
      expect(document.activeElement).not.toBe(primary());
      arm();
      expect(primary()?.disabled).toBe(false);
      expect(document.activeElement).not.toBe(primary());
      expect(primary()?.hasAttribute('autofocus')).toBe(false);
      primary()?.focus();
      click(primary());
      send(evmRequest({ position: 2, queued: 2 }));
      expect(document.activeElement).not.toBe(primary());
      expect(primary()?.hasAttribute('autofocus')).toBe(false);
    });

    it('a keyboard click needs a keydown after arming; a pointer click needs a pointerdown after arming', () => {
      send(evmRequest());
      arm(); // pointermove
      // A keyboard click (detail 0) without a keydown of its own.
      primary()?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      expect(results()).toEqual([]);
      // A key pressed after arming does not let a pointer click without its own pointerdown through.
      win.dispatch('keydown', { key: 'Shift' });
      bareClick(primary());
      expect(results()).toEqual([]);
      keyClick(primary(), ' ');
      expect(results()[0]).toMatchObject({ approved: true });
    });

    it('gestures that are not trusted are ignored', () => {
      page.stop();
      resetDom();
      win = new FakeWindow('/approve');
      vault = remoteWindow();
      win.opener = asWindow(vault);
      page = startApprovePage({ win, env: ENV, isGesture: (e) => (e as { trusted?: boolean }).trusted === true });
      win.dispatch('focus');
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('pointermove');
      win.dispatch('pointerdown');
      win.dispatch('keydown', { key: 'Tab' });
      expect(primary()?.disabled).toBe(true);
      win.dispatch('pointermove', { trusted: true });
      expect(primary()?.disabled).toBe(false);
    });

    it('stays disabled before 1 s since the window last gained focus, and a blur disarms it', () => {
      send(evmRequest());
      arm();
      expect(primary()?.disabled).toBe(false);
      win.dispatch('blur');
      expect(primary()?.disabled).toBe(true);
      win.dispatch('focus');
      vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
      win.dispatch('pointermove');
      expect(primary()?.disabled).toBe(true);
      vi.advanceTimersByTime(1);
      win.dispatch('pointermove');
      expect(primary()?.disabled).toBe(false);
    });

    it('a pointer move from before the 1 s mark does not count', () => {
      send(evmRequest());
      vi.advanceTimersByTime(500);
      win.dispatch('pointermove');
      vi.advanceTimersByTime(600);
      expect(primary()?.disabled).toBe(true);
      win.dispatch('pointermove');
      expect(primary()?.disabled).toBe(false);
    });

    it('a hidden window is disarmed until visible again for 1 s', () => {
      send(evmRequest());
      arm();
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(primary()?.disabled).toBe(true);
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      win.dispatch('pointermove');
      expect(primary()?.disabled).toBe(true);
      arm();
      expect(primary()?.disabled).toBe(false);
    });

    it('resets for a new request in a reused popup (a request slipped in at the moment of a click)', () => {
      const first = evmRequest();
      send(first);
      arm();
      expect(primary()?.disabled).toBe(false);
      const second = evmRequest({ position: 2, queued: 2 });
      send(second);
      expect(primary()?.disabled).toBe(true);
      click(primary());
      // The click meant for the first request approves nothing (the first is rejected as replaced).
      expect(results()).toEqual([expect.objectContaining({ id: first.id, approved: false })]);
      arm();
      click(primary());
      expect(results()[1]).toMatchObject({ id: second.id, approved: true });
    });

    it('a double-click carried across the popup opening approves nothing', () => {
      send(evmRequest());
      // The second click of a double-click on the launcher lands in the new popup within a few hundred ms.
      vi.advanceTimersByTime(200);
      click(primary());
      click(primary());
      expect(results()).toEqual([]);
      expect(primary()?.disabled).toBe(true);
    });
  });

  it('Reject answers approved: false; closing with a request on screen also rejects', () => {
    const r = evmRequest();
    send(r);
    click(secondary());
    expect(results()[0]).toMatchObject({ t: 'hana:approve-result', id: r.id, approved: false });
    const r2 = evmRequest();
    send(r2);
    win.dispatch('pagehide');
    expect(results()[1]).toMatchObject({ t: 'hana:approve-result', id: r2.id, approved: false });
    expect(results()[1]?.digest).toEqual(approvalDigest(digestInput(r2)));
  });

  it('waits up to 15 s for a follow-up request, shows it without another launcher click, then says bye and closes', () => {
    send(evmRequest());
    arm();
    click(primary());
    expect(page.state).toBe('waiting');
    expect(pageText()).toContain('Waiting for the next request from Partner App');
    vi.advanceTimersByTime(KEEP_OPEN_MS - 1000);
    const next = stellarRequest({ position: 1, queued: 1 });
    send(next);
    expect(page.state).toBe('request');
    vi.advanceTimersByTime(KEEP_OPEN_MS * 2);
    expect(win.closed).toBe(false);
    arm();
    click(primary());
    expect(results()[1]).toMatchObject({ id: next.id, approved: true });
    vi.advanceTimersByTime(KEEP_OPEN_MS - 1);
    expect(win.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(results().at(-1)).toEqual({ v: 1, t: 'hana:approve-bye' });
    expect(win.closed).toBe(true);
    expect(page.state).toBe('closed');
  });

  it('closes after 15 s if no request ever arrives', () => {
    vi.advanceTimersByTime(KEEP_OPEN_MS);
    expect(results()).toEqual([{ v: 1, t: 'hana:approve-bye' }]);
    expect(win.closed).toBe(true);
  });

  it('refuses to approve a request it cannot decode: no Approve button, Reject only', () => {
    send(evmRequest({ bytes: new Uint8Array([0x02, 0xc0]) }));
    expect(primary()).toBeNull();
    expect(pageText()).toContain('can’t read this request');
    click(secondary());
    expect(results()[0]).toMatchObject({ approved: false });
  });

  it('refuses an EVM transaction whose bytes name another chain than its context', () => {
    send(evmRequest({ context: { chainId: 1 } }));
    expect(primary()).toBeNull();
  });

  it('shows a raw request as raw, with the warning, even when its bytes are a valid transaction', () => {
    const bytes = txBytes([paymentOp()]);
    const r = stellarRequest({ kind: 'raw', context: {}, bytes });
    send(r);
    const text = pageText();
    expect(text).toContain(rawSigningWarning('Stellar', 'Partner App'));
    expect(text).toContain(`0x${Buffer.from(bytes).toString('hex')}`);
    expect(text).not.toContain('payment');
    arm();
    click(primary());
    expect(results()[0]).toMatchObject({ id: r.id, approved: true });
    expect(results()[0]?.digest).toEqual(approvalDigest(digestInput(r)));
  });

  it('shows message text, and hex for text with invisible characters', () => {
    send(evmRequest({ kind: 'personal_sign', context: {}, bytes: utf8('Sign in to Partner') }));
    expect(pageText()).toContain('Sign in to Partner');
    send(evmRequest({ kind: 'personal_sign', context: {}, bytes: utf8('pay‮evil') }));
    expect(pageText()).toContain('shown as hex');
    expect(pageText()).not.toContain('pay‮evil');
  });

  it('says a message or raw signature is not tied to one network; transactions and typed data name theirs', () => {
    const shown = (r: Req) => {
      send(r);
      return pageText().includes(NO_NETWORK_NOTE);
    };
    expect(shown(evmRequest({ kind: 'personal_sign', context: {}, bytes: utf8('Sign in to Partner') }))).toBe(true);
    expect(shown(stellarRequest({ kind: 'stellar_message', context: {}, bytes: utf8('Sign in to Partner') }))).toBe(true);
    expect(shown(stellarRequest({ kind: 'raw', context: {}, bytes: txBytes([paymentOp()]) }))).toBe(true);
    expect(shown(evmRequest({ kind: 'raw', context: {}, bytes: new Uint8Array(32).fill(7) }))).toBe(true);
    expect(shown(evmRequest())).toBe(false);
    expect(shown(stellarRequest())).toBe(false);
    const typed = JSON.stringify({
      types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Order: [{ name: 'amount', type: 'uint256' }] },
      primaryType: 'Order',
      domain: { chainId: 11155111 },
      message: { amount: '5' },
    });
    expect(shown(evmRequest({ kind: 'eip712', context: {}, bytes: utf8(typed) }))).toBe(false);
    expect(pageText()).toContain('Chain ID 11155111');
  });

  it('says a test app signs only for test networks (D39), on requests and the consent screen; nothing for a live app', () => {
    send(evmRequest({ testApp: true }));
    expect(pageText()).toContain(TEST_APP_NOTE);
    expect(TEST_APP_NOTE).toMatch(/only for test networks/u);
    send(evmRequest());
    expect(pageText()).not.toContain(TEST_APP_NOTE);
    send(consentRequest({ testApp: true }));
    expect(pageText()).toContain(TEST_APP_NOTE);
    send(consentRequest());
    expect(pageText()).not.toContain(TEST_APP_NOTE);
    // The flag is `true` or absent: anything else is not a valid request (the popup drops it).
    send(evmRequest({ testApp: false }));
    expect(pageText()).not.toContain(TEST_APP_NOTE);
  });

  it('shows why a request was not auto-approved, and "Stop auto-approving" while a consent is active', () => {
    send(evmRequest({ autoApprove: { label: 'Swaps on Example', active: true, reason: 'contract_not_listed' } }));
    expect(pageText()).toContain('Not signed automatically under “Swaps on Example”: the contract isn’t listed in the rules.');
    const stop = document.querySelector('button.link');
    expect(stop?.textContent).toBe('Stop auto-approving');
    click(stop);
    expect(results()).toEqual([{ v: 1, t: 'hana:auto-approve-stop' }]);
    expect(pageText()).toContain('Auto-approving stopped');
    // The request itself is still pending.
    arm();
    click(primary());
    expect(results()[1]).toMatchObject({ t: 'hana:approve-result', approved: true });
  });

  it('fuzz: mutated requests never throw, and nothing but answers to rendered requests is ever posted', () => {
    const values: unknown[] = [null, undefined, 0, -1, 2 ** 53, '', 'x', [], {}, new Uint8Array(0), new Uint8Array(32), true, EVM, USER, { chainId: 1 }];
    let seed = 99;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const m: Record<string, unknown> = rand(2) ? evmRequest() : consentRequest();
      const keys = Object.keys(m);
      m[rand(4) === 0 ? `k${rand(3)}` : (keys[rand(keys.length)] as string)] = values[rand(values.length)];
      expect(() => send(m)).not.toThrow();
    }
    for (const r of results()) expect(['hana:approve-result', 'hana:consent-result']).toContain(r.t);
    const posted = JSON.stringify(results(), (_, v) => (v instanceof Uint8Array ? `bytes:${v.length}` : v));
    expect(posted).not.toMatch(/relayKey|prk|seed|idToken/iu);
  });

  it('offers no "Stop auto-approving" without an active consent, and no reason line without a reason', () => {
    send(evmRequest({ autoApprove: { label: 'Swaps', active: false } }));
    expect(document.querySelector('button.link')).toBeNull();
    expect(pageText()).not.toContain('Not signed automatically');
  });

  it('has words for every matcher reason, and a generic line for a code it does not know', () => {
    for (const [code, text] of Object.entries(AUTO_APPROVE_REASON_TEXT)) {
      expect(text.length).toBeGreaterThan(0);
      expect(autoApproveReasonText(code)).toBe(text);
    }
    expect(autoApproveReasonText('some_new_reason')).toBe('it doesn’t match the rules');
    expect(autoApproveReasonText('constructor')).toBe('it doesn’t match the rules');
    send(evmRequest({ autoApprove: { label: 'Swaps', active: true, reason: 'daily_count_reached' } }));
    expect(pageText()).toContain('today’s limit of automatic signatures is reached');
  });

  describe('a new request while one is on screen and unanswered', () => {
    it('rejects the one on screen with its own digest; the new one needs its own guarded Approve', () => {
      const first = evmRequest();
      send(first);
      arm();
      const second = stellarRequest({ position: 2, queued: 2 });
      send(second);
      expect(results()).toEqual([{ v: 1, t: 'hana:approve-result', id: first.id, approved: false, digest: approvalDigest(digestInput(first)) }]);
      expect(pageText()).toContain('Request 2 of 2');
      expect(primary()?.disabled).toBe(true);
      click(primary());
      expect(results()).toHaveLength(1);
      arm();
      click(primary());
      expect(results()[1]).toMatchObject({ id: second.id, approved: true });
      expect(results()[1]?.digest).toEqual(approvalDigest(digestInput(second)));
    });

    it('a consent screen replaced by a request is answered allowed: false; a request replaced by a consent screen is rejected', () => {
      const consent = consentRequest();
      send(consent);
      const req = evmRequest();
      send(req);
      expect(results()[0]).toMatchObject({ t: 'hana:consent-result', id: consent.id, allowed: false });
      expect(results()[0]?.digest).toEqual(consentDigest({ id: consent.id, policyId: POLICY_ID, parentOrigin: PARTNER, expiresAtMs: CONSENT_END }));
      send(consentRequest());
      expect(results()[1]).toMatchObject({ t: 'hana:approve-result', id: req.id, approved: false });
      expect(page.state).toBe('consent');
    });

    it('the same id sent again is shown again, unanswered, with the guard reset', () => {
      const r = evmRequest();
      send(r);
      arm();
      send(r);
      expect(results()).toEqual([]);
      expect(primary()?.disabled).toBe(true);
      arm();
      click(primary());
      expect(results()).toEqual([expect.objectContaining({ id: r.id, approved: true })]);
    });

    it('a request after an answer is not a replacement: nothing more is sent', () => {
      const r = evmRequest();
      send(r);
      click(secondary());
      send(evmRequest());
      expect(results()).toHaveLength(1);
    });
  });
});

describe('/approve consent screen', () => {
  it('shows the app, origin, label, every contract with name and address, the functions, the address rule, limits and duration', () => {
    send(consentRequest());
    const text = pageText();
    for (const s of ['Partner App', PARTNER, '“Swaps on Example”', 'Example pool', 'USDC', 'Router', 'swap', 'deposit', 'route', 'can send to any address', 'at most 3', 'deposit(uint256)', 'EVM chain 8453', 'PermitSingle']) {
      expect(text).toContain(s);
    }
    for (const c of POLICY.ok ? POLICY.policy.stellar?.contracts ?? [] : []) expect(text).toContain(c.id);
    expect(text).toContain('Some functions below can send to any address');
  });

  it('shows the actual end time the vault sent, not only the policy’s maximum', () => {
    const end = T0 + 90 * 60_000; // the session ends in 1 h 30 min, before the policy's 12 h
    send(consentRequest({ expiresAtMs: end }));
    expect(pageText()).toContain(`Until${formatEndTime(end)} (about 1 h 30 min from now)`);
    expect(pageText()).not.toContain('12 h');
  });

  it('Allow is guarded like Approve and sends the consent digest over the policyId it recomputed', () => {
    const r = consentRequest();
    send(r);
    vi.advanceTimersByTime(GUARD_DELAY_MS - 1);
    win.dispatch('pointermove');
    click(primary());
    expect(results()).toEqual([]);
    arm();
    click(primary());
    const [result] = results();
    expect(parseWindowMessage(result, ['hana:consent-result'])).not.toBeNull();
    expect(result).toMatchObject({ t: 'hana:consent-result', id: r.id, allowed: true });
    expect(result?.digest).toEqual(consentDigest({ id: r.id, policyId: POLICY_ID, parentOrigin: PARTNER, expiresAtMs: CONSENT_END }));
    // The digest binds the end time the user saw.
    expect(result?.digest).not.toEqual(consentDigest({ id: r.id, policyId: POLICY_ID, parentOrigin: PARTNER, expiresAtMs: CONSENT_END + 1 }));
  });

  it('Don’t allow answers allowed: false', () => {
    const r = consentRequest();
    send(r);
    click(secondary());
    expect(results()[0]).toMatchObject({ t: 'hana:consent-result', id: r.id, allowed: false });
  });

  it('recomputes policyId from the normalized policy: key order and address case don’t matter', () => {
    const shuffled = Object.fromEntries(Object.entries(POLICY_OBJECT).reverse());
    send(consentRequest({ policy: shuffled }));
    expect(primary()).not.toBeNull();
  });

  it.each([
    ['a policyId that is not the policy’s', { policyId: 'f'.repeat(64) }],
    ['an invalid policy (raw entry smuggled in)', { policy: { ...POLICY_OBJECT, raw: true } }],
    ['a policy that does not validate (empty label)', { policy: { ...POLICY_OBJECT, label: '' } }],
    ['another valid policy than the one its id names', { policy: { ...POLICY_OBJECT, limits: { perDayCount: 500 } } }],
  ])('refuses %s: no Allow button', (_, over) => {
    send(consentRequest(over));
    expect(primary()).toBeNull();
    expect(pageText()).toContain('could not be checked');
    click(secondary());
    expect(results()[0]).toMatchObject({ allowed: false });
  });
});
