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
import { STELLAR_MAINNET_PASSPHRASE, shortAddress } from '@hana-id/core';
import { policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS, KEYBOARD_DWELL_MS } from '../../src/auth/approve-guard.ts';
import {
  ADOPT_TIMEOUT_MS,
  AUTO_APPROVE_REASON_TEXT,
  KEEP_OPEN_MS,
  LOADING_DELAY_MS,
  MAINNET_DEMO_BANNER,
  SUPPORT_ID_HINT,
  TEST_APP_NOTE,
  approveOpenerMode,
  autoApproveReasonText,
  startApprovePage,
} from '../../src/auth/approve-page.ts';
import { NO_NETWORK_NOTE } from '../../src/auth/render-approval.ts';
import { formatEndTime, lingeringSignaturesNote } from '../../src/auth/render-consent.ts';
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
/** Enter on a focused button: focus held KEYBOARD_DWELL_MS (D113), keydown, then a click with detail 0. */
const keyClick = (b: Element | null, key = 'Enter') => {
  if (!b) return;
  if (document.activeElement !== b) {
    (b as HTMLElement).focus();
    vi.advanceTimersByTime(KEYBOARD_DWELL_MS);
  }
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

function start(env = ENV): void {
  win = new FakeWindow('/approve');
  vault = remoteWindow();
  win.opener = asWindow(vault);
  page = startApprovePage({ win, env, isGesture: () => true });
  win.dispatch('focus');
}

/** Batch C11: the build's files origin and a logo on it. */
const FILES = 'https://files.hana.test';
const LOGO = `${FILES}/logos/app_abc/${'0d'.repeat(32)}.png`;

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

  it('batch C11: shows the app’s logo beside its name on a request and a consent screen, from the files origin only', () => {
    page.stop();
    resetDom();
    start({ ...ENV, filesOrigin: FILES });
    const r = evmRequest({ logoUrl: LOGO });
    send(r);
    expect(document.querySelector('header.app img.app-logo')?.getAttribute('src')).toBe(LOGO);
    expect(pageText()).toContain('Request 1 of 1 from Partner App');
    // The digest binds what the request is, not the decoration: the logo changes nothing there.
    arm();
    click(primary());
    expect(results()[0]?.digest).toEqual(approvalDigest(digestInput(r)));
    page.stop();
    resetDom();
    start({ ...ENV, filesOrigin: FILES });
    send(consentRequest({ logoUrl: LOGO }));
    expect(document.querySelector('header.app img.app-logo')?.getAttribute('src')).toBe(LOGO);
    // Another origin, or a build without a files origin: the name alone.
    for (const [env, logoUrl] of [[{ ...ENV, filesOrigin: FILES }, `https://cdn.partner.example/logos/app_abc/${'0d'.repeat(32)}.png`], [ENV, LOGO]] as const) {
      page.stop();
      resetDom();
      start(env);
      send(evmRequest({ logoUrl }));
      expect(pageText()).toContain('from Partner App');
      expect(document.querySelector('img')).toBeNull();
    }
  });

  it('batch C15: shows the session’s Support ID under the account line, as text; none without one', () => {
    const r = evmRequest({ supportId: 'HANA-2750-G5HM' });
    send(r);
    const line = document.querySelector('p.support-id');
    expect(line?.textContent).toBe(`Support ID HANA-2750-G5HM ${SUPPORT_ID_HINT}`);
    expect(line?.querySelector('code')?.textContent).toBe('HANA-2750-G5HM');
    // Decoration only: the digest binds the request, not the code.
    arm();
    click(primary());
    expect(results()[0]?.digest).toEqual(approvalDigest(digestInput(r)));
    page.stop();
    resetDom();
    start();
    send(evmRequest());
    expect(pageText()).toContain(EVM);
    expect(document.querySelector('p.support-id')).toBeNull();
    expect(pageText()).not.toContain('Support ID');
  });

  it('batch C15: a request whose supportId is not a Support ID is ignored (schema)', () => {
    for (const supportId of ['hana-2750-g5hm', 'HANA-ILOU-0000', '', 7]) send(evmRequest({ supportId }));
    expect(page.state).toBe('connecting');
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

    /** A zero-movement mouse event at client (x, y), whose screen position is the window's offset plus that. */
    const at = (x: number, y: number) => ({ pointerType: 'mouse', movementX: 0, movementY: 0, clientX: x, clientY: y, screenX: 300 + x, screenY: 200 + y });

    it('mouse: with zero movement (WebKit reports 0 on every move), only a real cursor move arms it', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      // The first move has nothing to compare with; repeats at the same spot (synthetic moves, a press) never arm.
      win.dispatch('pointermove', at(5, 5));
      win.dispatch('pointermove', at(5, 5));
      win.dispatch('pointerdown', at(5, 5));
      win.dispatch('pointermove', at(5, 5));
      expect(primary()?.disabled).toBe(true);
      // The cursor moved (client and screen positions both changed): armed. The arming move never approves.
      win.dispatch('pointermove', at(16, 16));
      expect(primary()?.disabled).toBe(false);
      click(primary(), 'mouse');
      expect(results()[0]).toMatchObject({ approved: true });
    });

    it('mouse: a synthetic move at the position of the last press never arms it (the press records the position)', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('pointermove', at(5, 5));
      win.dispatch('pointerdown', at(40, 40));
      win.dispatch('pointermove', at(40, 40));
      expect(primary()?.disabled).toBe(true);
    });

    it('mouse: a position from the previous request never arms the next one', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('pointermove', at(5, 5));
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      // Different from (5, 5), but that was recorded for the request before: nothing to compare with yet.
      win.dispatch('pointermove', at(40, 40));
      expect(primary()?.disabled).toBe(true);
      win.dispatch('pointermove', at(41, 41));
      expect(primary()?.disabled).toBe(false);
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

    it('keyboard: Tab, Tab, Enter in one go does nothing; Enter acts only once Approve held focus 500 ms (AUTH-3, D113)', () => {
      const r = evmRequest();
      send(r);
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      const b = primary() as HTMLButtonElement;
      const enter = () => {
        win.dispatch('keydown', { key: 'Enter' });
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      };
      // Tab to Reject, Tab to Approve, Enter at once: refused, and again a moment later.
      win.dispatch('keydown', { key: 'Tab' });
      secondary()?.focus();
      win.dispatch('keydown', { key: 'Tab' });
      b.focus();
      enter();
      vi.advanceTimersByTime(KEYBOARD_DWELL_MS - 100);
      enter();
      expect(results()).toEqual([]);
      // Focus that leaves Approve and comes back restarts the wait.
      b.blur();
      vi.advanceTimersByTime(200);
      b.focus();
      enter();
      expect(results()).toEqual([]);
      vi.advanceTimersByTime(KEYBOARD_DWELL_MS);
      enter();
      expect(results()[0]).toMatchObject({ id: r.id, approved: true });
    });

    it('keyboard: a new request resets the focus wait', () => {
      send(evmRequest());
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('keydown', { key: 'Tab' });
      (primary() as HTMLButtonElement).focus();
      vi.advanceTimersByTime(KEYBOARD_DWELL_MS);
      send(evmRequest({ position: 2, queued: 2 }));
      vi.advanceTimersByTime(GUARD_DELAY_MS);
      win.dispatch('keydown', { key: 'Tab' });
      // The new screen's Approve never had focus.
      win.dispatch('keydown', { key: 'Enter' });
      primary()?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      expect(results().filter((m) => m.approved === true)).toEqual([]);
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
    for (const s of ['Partner App', PARTNER, '“Swaps on Example”', 'Example pool', 'USDC', 'Router', 'swap', 'deposit', 'route', 'can send to any address', 'at most 3', 'deposit(uint256)', 'EVM chain 8453', 'PermitSingle', 'Maximum value plus network fees, per transaction', 'Maximum value plus network fees, per day', 'Maximum network fee per transaction']) {
      expect(text).toContain(s);
    }
    for (const c of POLICY.ok ? POLICY.policy.stellar?.contracts ?? [] : []) expect(text).toContain(shortAddress(c.id));
    expect(text).toContain('Example pool · named by Partner App');
    expect(text).toContain('Some functions below can send to any address');
  });

  it('says that stopping can’t take back signatures the app already has (CORE-3, D116)', () => {
    send(consentRequest());
    expect(document.querySelector('p.note.lingering')?.textContent).toBe(lingeringSignaturesNote('Partner App'));
    expect(pageText()).toContain('a Stellar authorization until the ledger it names');
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

describe('/approve consent screen: contract names (D44)', () => {
  // Sodax's Base asset manager and Stellar asset manager are on Hana's verified list; OTHER is not.
  const SODAX_BASE = '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3';
  const SODAX_STELLAR = 'CCGF33A4CO6D3BXFEKPXVCFCZBK76I3AQOZK6KIKRPAWAZR3632WHCJ3';
  const OTHER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
  const DEPOSIT = { selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' };

  type Contract = { address: string; name: string };
  function evmPolicy(chainId: number, contracts: Contract[], stellar?: { passphrases: string[]; contracts: { id: string; name: string }[] }) {
    const json: Record<string, unknown> = {
      v: 1,
      label: 'Swaps',
      maxConsentMs: 12 * 3_600_000,
      limits: { perDayCount: 3 },
      evm: { chains: [{ chainId, maxValueWei: '1000', maxValueWeiPerDay: '3000', maxFeeWei: '1000', contracts: contracts.map((c) => ({ ...c, selectors: [DEPOSIT] })) }] },
    };
    if (stellar) {
      json.stellar = { networkPassphrases: stellar.passphrases, maxFeeStroops: '100000', contracts: stellar.contracts.map((c) => ({ ...c, functions: [{ name: 'deposit' }] })) };
    }
    const r = validateAutoApprovePolicy(json);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    const policy = JSON.parse(JSON.stringify(r.policy)) as Record<string, unknown>;
    return { policy, policyId: policyId(r.policy) };
  }
  const lines = () => [...document.querySelectorAll<HTMLElement>('.contracts p.contract')];
  const line = (address: string) => {
    const l = lines().find((p) => p.querySelector('code')?.getAttribute('title') === address);
    if (!l) throw new Error(`no line for ${address}`);
    return l;
  };

  it('a verified contract shows ✓ and the verified name, not the partner’s name, with the short address and explorer link', () => {
    send(consentRequest(evmPolicy(8453, [{ address: SODAX_BASE, name: 'Totally my router' }])));
    expect(primary()).not.toBeNull();
    const l = line(SODAX_BASE);
    expect(l.querySelector('.verified')?.textContent).toBe('✓ Sodax Asset Manager');
    expect(l.textContent).not.toContain('Totally my router');
    expect(l.textContent).not.toContain('named by');
    expect(l.querySelector('code')?.textContent).toBe('0x348B…7Bc3');
    const a = l.querySelector('a');
    expect(a?.getAttribute('href')).toBe(`https://basescan.org/address/${SODAX_BASE}`);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.textContent).toBe('View on Basescan');
    expect(pageText()).not.toContain('look like verified ones');
  });

  it('a verified address is case-insensitive on EVM (the policy may list it lowercase)', () => {
    send(consentRequest(evmPolicy(8453, [{ address: SODAX_BASE.toLowerCase(), name: 'x' }])));
    expect(document.querySelector('.verified')?.textContent).toBe('✓ Sodax Asset Manager');
  });

  it('an unverified contract shows the partner’s name as “named by {app}”, unflagged', () => {
    send(consentRequest(evmPolicy(8453, [{ address: OTHER, name: 'Example vault' }])));
    const l = line(OTHER);
    expect(l.querySelector('.verified')).toBeNull();
    expect(l.textContent).toContain('Example vault · named by Partner App');
    expect(l.querySelector('.name-warning')).toBeNull();
    expect(l.querySelector('a')?.getAttribute('href')).toBe(`https://basescan.org/address/${OTHER}`);
    expect(pageText()).not.toContain('look like verified ones');
  });

  it('a partner name that imitates a verified name is flagged, inline and at the top', () => {
    send(consentRequest(evmPolicy(8453, [{ address: OTHER, name: 'Sodax Asset Manager' }])));
    const l = line(OTHER);
    expect(l.querySelector('.verified')).toBeNull();
    expect(l.textContent).toContain('Sodax Asset Manager · named by Partner App — not the verified Sodax Asset Manager');
    expect(l.querySelector('.name-warning.danger')).not.toBeNull();
    expect(pageText()).toContain('Partner App gave some contracts below names that look like verified ones');
  });

  it('a partner name mentioning a verified protocol is flagged ("Sodax Router" on an unverified address)', () => {
    send(consentRequest(evmPolicy(8453, [{ address: OTHER, name: 'Sodax Router' }])));
    expect(line(OTHER).textContent).toContain('Sodax Router · named by Partner App — not a verified Sodax contract');
  });

  it('a verified name on the wrong chain is not verified: the same address on another chain is flagged', () => {
    send(consentRequest(evmPolicy(42220, [{ address: SODAX_BASE, name: 'Sodax Asset Manager' }])));
    const l = line(SODAX_BASE);
    expect(l.querySelector('.verified')).toBeNull();
    expect(l.textContent).toContain('— not the verified Sodax Asset Manager');
  });

  it('check marks in a partner name are removed: only the verified mark shows one', () => {
    send(consentRequest(evmPolicy(8453, [{ address: OTHER, name: '✓ USDC ✔' }])));
    const l = line(OTHER);
    expect(l.textContent).toContain('USDC · named by Partner App');
    expect(l.textContent).not.toMatch(/[✓✔]/u);
  });

  it.each([
    [1, 'https://etherscan.io/address/', 'Etherscan'],
    [146, 'https://sonicscan.org/address/', 'SonicScan'],
    [11155111, 'https://sepolia.etherscan.io/address/', 'Sepolia Etherscan'],
    [84532, 'https://sepolia.basescan.org/address/', 'Base Sepolia Basescan'],
  ])('EVM chain %i links to its explorer', (chainId, prefix, name) => {
    send(consentRequest(evmPolicy(chainId, [{ address: OTHER, name: 'Example vault' }])));
    const a = line(OTHER).querySelector('a');
    expect(a?.getAttribute('href')).toBe(`${prefix}${OTHER}`);
    expect(a?.textContent).toBe(`View on ${name}`);
  });

  it('Stellar contracts link to each listed network’s explorer; verified only on the network it is verified on', () => {
    send(consentRequest(evmPolicy(8453, [{ address: OTHER, name: 'Example vault' }], { passphrases: [STELLAR_MAINNET_PASSPHRASE], contracts: [{ id: SODAX_STELLAR, name: 'pool' }] })));
    let l = line(SODAX_STELLAR);
    expect(l.querySelector('.verified')?.textContent).toBe('✓ Sodax Asset Manager');
    expect(l.querySelector('code')?.textContent).toBe('CCGF…HCJ3');
    expect([...l.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([`https://stellar.expert/explorer/public/contract/${SODAX_STELLAR}`]);

    send(consentRequest(evmPolicy(8453, [{ address: OTHER, name: 'Example vault' }], { passphrases: [STELLAR_MAINNET_PASSPHRASE, PASSPHRASE], contracts: [{ id: SODAX_STELLAR, name: 'Sodax Asset Manager' }] })));
    l = line(SODAX_STELLAR);
    // Not verified on testnet, so not verified for this policy; its own name is no imitation.
    expect(l.querySelector('.verified')).toBeNull();
    expect(l.textContent).toContain('Sodax Asset Manager · named by Partner App');
    expect(l.querySelector('.name-warning')).toBeNull();
    expect([...l.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      [`https://stellar.expert/explorer/public/contract/${SODAX_STELLAR}`, 'View on StellarExpert'],
      [`https://stellar.expert/explorer/testnet/contract/${SODAX_STELLAR}`, 'View on StellarExpert (testnet)'],
    ]);
  });

  it('an unknown chain shows the short address without a link', () => {
    send(consentRequest(evmPolicy(999_999, [{ address: OTHER, name: 'Example vault' }])));
    const l = line(OTHER);
    expect(l.querySelector('a')).toBeNull();
    expect(l.querySelector('code')?.textContent).toBe('0x3fC9…7FAD');
    expect(l.textContent).toContain('Example vault · named by Partner App');
    expect(primary()).not.toBeNull();
  });

  it('renders partner-controlled names and app names as text, never markup', () => {
    send(consentRequest({ ...evmPolicy(8453, [{ address: OTHER, name: '<img src=x onerror=alert(1)>' }]), appName: '<b>App</b>' }));
    const l = line(OTHER);
    expect(l.querySelector('img')).toBeNull();
    expect(l.querySelector('b')).toBeNull();
    expect(l.textContent).toContain('<img src=x onerror=alert(1)> · named by <b>App</b>');
  });
});

describe('/approve opened by the partner page in the click (D99)', () => {
  const FRAME = `hana-vault-${'c'.repeat(32)}`;
  let partner: RemoteWindow;
  let vaultFrame: RemoteWindow;

  /** /approve?from=partner&v=FRAME, opened by the partner page, whose child frame FRAME is the vault. */
  function startPartner(search = `?from=partner&v=${FRAME}`): void {
    page.stop();
    resetDom();
    win = new FakeWindow('/approve', search);
    partner = remoteWindow();
    vaultFrame = remoteWindow({ parent: partner });
    partner.frames[FRAME] = vaultFrame;
    win.opener = asWindow(partner);
    vault = vaultFrame;
    page = startApprovePage({ win, env: ENV, isGesture: () => true });
    win.dispatch('focus');
  }

  beforeEach(() => startPartner());

  it('parses only the two opener forms', () => {
    expect(approveOpenerMode('')).toEqual({ mode: 'vault' });
    expect(approveOpenerMode(`?from=partner&v=${FRAME}`)).toEqual({ mode: 'partner', vaultFrame: FRAME });
    expect(approveOpenerMode(`?v=${FRAME}&from=partner`)).toEqual({ mode: 'partner', vaultFrame: FRAME });
    for (const bad of [`?from=vault&v=${FRAME}`, '?from=partner', `?v=${FRAME}`, '?from=partner&v=hana-vault-x', `?from=partner&v=${FRAME}&v=${FRAME}`, `?from=partner&v=${FRAME}&x=1`, '?x=1']) {
      expect(approveOpenerMode(bad)).toBeNull();
    }
  });

  it('an approval link in neither form shows an error and says nothing', () => {
    startPartner('?from=partner&v=nope');
    expect(page.state).toBe('error');
    expect(pageText()).toContain('This approval link is not valid');
    expect(vaultFrame.postMessage).not.toHaveBeenCalled();
    expect(partner.postMessage).not.toHaveBeenCalled();
  });

  it('says hello to the vault frame (opener.frames[v]) on vaultOrigin, never to the partner page', () => {
    expect(vaultFrame.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:approve-hello' }, ENV.vaultOrigin);
    expect(partner.postMessage).not.toHaveBeenCalled();
  });

  it('shows and answers a request from the authenticated vault frame exactly as when the vault opened it', () => {
    const r = evmRequest({ position: 2, queued: 3 });
    send(r, ENV.vaultOrigin, vaultFrame);
    expect(pageText()).toContain('Request 2 of 3 from Partner App');
    arm();
    click(primary());
    const [result] = results();
    expect(result).toMatchObject({ t: 'hana:approve-result', id: r.id, approved: true });
    expect(result?.digest).toEqual(approvalDigest(digestInput(r)));
    expect(vaultFrame.postMessage.mock.calls.every((c) => c[1] === ENV.vaultOrigin)).toBe(true);
    expect(partner.postMessage).not.toHaveBeenCalled();
    // It waits for a follow-up, whose Approve is guarded again.
    expect(page.state).toBe('waiting');
    send(stellarRequest(), ENV.vaultOrigin, vaultFrame);
    click(primary());
    expect(results()).toHaveLength(1);
  });

  it('the partner page posting fake requests (or a close) to its own popup gets nothing shown, nothing answered', () => {
    // The partner page holds this window: its messages carry its own origin, and it is not the vault frame.
    send(evmRequest(), PARTNER, partner);
    send(evmRequest(), ENV.vaultOrigin, partner); // even if it could claim the vault's origin, the window is wrong
    send(evmRequest(), PARTNER, vaultFrame);
    send({ v: 1, t: 'hana:approve-close' }, PARTNER, partner);
    // A frame on vaultOrigin that is not opener.frames[v] (another vault frame on the page).
    send(evmRequest(), ENV.vaultOrigin, remoteWindow({ parent: partner }));
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    expect(page.state).toBe('connecting');
    expect(primary()).toBeNull();
    expect(win.closed).toBe(false);
    expect(partner.postMessage).not.toHaveBeenCalled();
    expect(results()).toEqual([]);
  });

  it('a frame whose parent is not the opener is not the vault, even at opener.frames[v]', () => {
    vaultFrame.parent = remoteWindow();
    send(evmRequest(), ENV.vaultOrigin, vaultFrame);
    expect(primary()).toBeNull();
    expect(page.state).toBe('connecting');
  });

  it('auto-approved or refused: the vault’s close shuts it before it shows anything, and nothing can be approved there', () => {
    // Blank until LOADING_DELAY_MS: no text, no buttons.
    expect(pageText()).toBe('');
    expect(document.querySelectorAll('button')).toHaveLength(0);
    vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    send({ v: 1, t: 'hana:approve-close' }, ENV.vaultOrigin, vaultFrame);
    expect(win.closed).toBe(true);
    expect(page.state).toBe('closed');
    expect(pageText()).toBe('');
    // Closed: a request arriving after can't be shown or approved, and nothing more is posted.
    send(evmRequest(), ENV.vaultOrigin, vaultFrame);
    vi.advanceTimersByTime(ADOPT_TIMEOUT_MS * 2);
    expect(primary()).toBeNull();
    expect(results()).toEqual([]);
  });

  it(`says it is loading after ${LOADING_DELAY_MS} ms; with no request in ${ADOPT_TIMEOUT_MS} ms it says bye and closes`, () => {
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    expect(pageText()).toContain('Loading the request');
    vi.advanceTimersByTime(ADOPT_TIMEOUT_MS - LOADING_DELAY_MS - 1);
    expect(win.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(results()).toEqual([{ v: 1, t: 'hana:approve-bye' }]);
    expect(win.closed).toBe(true);
  });

  it('a request on screen when the vault says close is not answered (the vault already settled it)', () => {
    send(evmRequest(), ENV.vaultOrigin, vaultFrame);
    send({ v: 1, t: 'hana:approve-close' }, ENV.vaultOrigin, vaultFrame);
    expect(win.closed).toBe(true);
    win.dispatch('pagehide');
    expect(results()).toEqual([]);
  });

  it('without an opener (the partner page cut it off) it shows an error', () => {
    page.stop();
    resetDom();
    win = new FakeWindow('/approve', `?from=partner&v=${FRAME}`);
    page = startApprovePage({ win, env: ENV, isGesture: () => true });
    expect(page.state).toBe('error');
  });
});

describe('/approve opened by the vault: hana:approve-close', () => {
  it('closes at once on the vault’s close, and ignores one from anything else', () => {
    send({ v: 1, t: 'hana:approve-close' }, EVIL);
    send({ v: 1, t: 'hana:approve-close' }, ENV.vaultOrigin, remoteWindow());
    expect(win.closed).toBe(false);
    send({ v: 1, t: 'hana:approve-close' });
    expect(win.closed).toBe(true);
    expect(results()).toEqual([]);
  });
});

describe('/approve: the mainnet demo banner (D428, D429)', () => {
  const DEMO_NOW = Date.UTC(2026, 10, 10);
  const BASE_TX = { ...TX, chainId: '0x2105', value: '0x38d7ea4c68000' }; // 0.001 ETH: $8 at the table's $8,000
  const baseRequest = (over: Record<string, unknown> = {}) => evmRequest({ bytes: evmTxSigningPayload(parseEvmTxRequest(BASE_TX)), context: { chainId: 8453 }, testApp: true, ...over });
  const pubnetRequest = (over: Record<string, unknown> = {}) => stellarRequest({ context: { networkPassphrase: STELLAR_MAINNET_PASSPHRASE }, testApp: true, ...over });
  const rpcAnswer = (result: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  let calls: string[];

  function startDemo(fetchFn: (url: string, init: RequestInit) => Promise<Response>): void {
    page.stop();
    resetDom();
    calls = [];
    win = new FakeWindow('/approve');
    vault = remoteWindow();
    win.opener = asWindow(vault);
    page = startApprovePage({
      win,
      env: ENV,
      isGesture: () => true,
      now: () => Date.now() - T0 + DEMO_NOW,
      fetch: (url, init) => {
        calls.push(url);
        return fetchFn(url, init);
      },
    });
    win.dispatch('focus');
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  };

  it('shows the red banner with the value and the cap, then the balance, read only from Hana’s pinned Base endpoint', async () => {
    // 0.0005 ETH, 3 USDC and no EURC: $4 + $3.15.
    startDemo(async (_url, init) => {
      const body = JSON.parse(init.body as string) as { method: string; params: [{ to?: string }] };
      if (body.method === 'eth_getBalance') return rpcAnswer('0x1c6bf52634000');
      return rpcAnswer(body.params[0].to === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' ? '0x2dc6c0' : '0x0');
    });
    send(baseRequest());
    expect(pageText()).toContain(MAINNET_DEMO_BANNER);
    expect(pageText()).toContain('This request can move about $8.01, fee included. Hana’s limit is $9.99 per transaction.');
    expect(pageText()).not.toContain(TEST_APP_NOTE);
    expect(document.querySelector('.mainnet-demo')?.getAttribute('role')).toBe('alert');
    await settle();
    expect(pageText()).toContain('This wallet holds about $7.15.');
    expect(new Set(calls)).toEqual(new Set(['https://mainnet.base.org']));
    // The request is still approvable as usual: the banner warns, it never blocks.
    arm();
    click(primary());
    expect(results().at(-1)).toMatchObject({ t: 'hana:approve-result', approved: true });
  });

  it('warns strongly when the wallet holds more than $10, and says “Balance unknown” when it can’t read it', async () => {
    startDemo(async () => rpcAnswer('0x2386f26fc10000')); // 0.01 ETH = $80 (and the same for "USDC")
    send(baseRequest());
    await settle();
    const warning = document.querySelector('.demo-balance');
    expect(warning?.textContent).toMatch(/^This wallet holds about \$\d+\.\d\d: keep test funds under \$10\.00 — move the rest out\.$/u);
    expect(warning?.className).toContain('danger');

    startDemo(async () => new Response('nope', { status: 500 }));
    send(baseRequest());
    await settle();
    expect(pageText()).toContain('Balance unknown.');
  });

  it('reads a Stellar balance from Horizon, counting XLM and Circle’s USDC only', async () => {
    startDemo(
      async () =>
        new Response(
          JSON.stringify({
            balances: [
              { asset_type: 'native', balance: '3.5000000' },
              { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', balance: '2.0000000' },
              { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USER, balance: '1000.0000000' },
            ],
          }),
          { status: 200 },
        ),
    );
    send(pubnetRequest());
    expect(pageText()).toContain(MAINNET_DEMO_BANNER);
    await settle();
    expect(pageText()).toContain('This wallet holds about $5.60.');
    expect(calls).toEqual([`https://horizon.stellar.org/accounts/${USER}`]);
  });

  it('shows no banner (and reads nothing) for a test network or a live app', async () => {
    startDemo(async () => rpcAnswer('0x0'));
    send(evmRequest({ testApp: true }));
    send(baseRequest({ testApp: undefined }));
    await settle();
    expect(pageText()).not.toContain(MAINNET_DEMO_BANNER);
    expect(calls).toEqual([]);
  });
});
