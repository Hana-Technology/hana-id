// @vitest-environment happy-dom
// /share-email (D411, D418–D422; auth/share-page.ts) and the login popup's hand-off to it (auth/share-handoff.ts), and
// the approval popup's "Stop sharing" (D422): the sender checks, the address read from the API with the vault's proof,
// the guarded "Share email", "Not now", the already-shared sheet, the D42 caveat, and closing on the vault's word.
import { evmTxSigningPayload, newRequestId, parseEvmTxRequest } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { EMAIL_SHARED_TEXT, startApprovePage } from '../../src/auth/approve-page.ts';
import { SHARE_MARK_PREFIX, closeOrShare, markEmailShare, takeEmailShare } from '../../src/auth/share-handoff.ts';
import { DONE_CLOSE_MS, HELLO_EVERY_MS, LOGIN_WAIT_MS, OPENED_WAIT_MS, SHARE_TEXT, shareOpenerMode, startSharePage } from '../../src/auth/share-page.ts';
import { ENV, EVIL, FakeWindow, PARTNER, PK, type RemoteWindow, asWindow, flush, pageText, remoteWindow, resetDom } from './helpers.ts';

const SEALED = `se1.${'A'.repeat(60)}`;
const FRAME = `hana-vault-${'a'.repeat(32)}`;
const RELAY = 'A'.repeat(43);

let win: FakeWindow;
let vault: RemoteWindow;
let partner: RemoteWindow;
let preview: ReturnType<typeof vi.fn<(pk: string, parentOrigin: string, body: unknown) => Promise<string>>>;

const request = (over: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'hana:email-share-request',
  pk: PK,
  appName: 'Partner App',
  parentOrigin: PARTNER,
  ownGoogleClient: false,
  state: 'not_asked',
  sealedEmail: SEALED,
  proof: { sessionPublicKey: new Uint8Array(32).fill(1), issuedAtMs: 1_800_000_000_000, nonce: new Uint8Array(16).fill(2), signature: new Uint8Array(64).fill(3) },
  ...over,
});
const sent = () => vault.received.map((m) => m as Record<string, unknown>).filter((m) => m.t !== 'hana:email-share-hello');
const click = (sel: string) => {
  win.dispatch('pointerdown', { pointerType: 'mouse' });
  document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
};
const arm = () => {
  vi.advanceTimersByTime(GUARD_DELAY_MS);
  win.dispatch('pointermove', { pointerType: 'mouse', movementX: 3, movementY: 1 });
};

function start(search: string): void {
  win = new FakeWindow('/share-email', search);
  vault = remoteWindow();
  partner = remoteWindow({ frames: { [FRAME]: null } });
  if (search.includes('from=partner')) {
    vault.parent = partner;
    partner.frames[FRAME] = vault;
    win.opener = asWindow(partner);
  } else {
    win.opener = asWindow(vault);
  }
  preview = vi.fn<(pk: string, parentOrigin: string, body: unknown) => Promise<string>>(async () => 'ada@example.com');
  startSharePage({ win, env: ENV, api: { emailPreview: preview }, isGesture: () => true, now: () => Date.now() });
  win.dispatch('focus');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDom();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('opener modes', () => {
  it('exactly from=login, from=vault, or from=partner&v=<vault frame>', () => {
    expect(shareOpenerMode('?from=login')).toEqual({ mode: 'login' });
    expect(shareOpenerMode('?from=vault')).toEqual({ mode: 'vault' });
    expect(shareOpenerMode(`?from=partner&v=${FRAME}`)).toEqual({ mode: 'partner', vaultFrame: FRAME });
    for (const bad of ['', '?from=partner', '?from=partner&v=x', '?from=login&x=1', '?from=other', `?from=login&from=vault`]) expect(shareOpenerMode(bad), bad).toBeNull();
  });

  it('refuses a window Hana didn’t open', () => {
    win = new FakeWindow('/share-email', '?from=login');
    startSharePage({ win, env: ENV, api: { emailPreview: vi.fn(async () => 'x@y.z') }, isGesture: () => true });
    expect(pageText()).toContain('wasn’t opened by Hana');
  });
});

describe('the sheet', () => {
  it('says hello until the vault answers, reads the address with the vault’s proof, and records "Share email" behind the guard', async () => {
    start('?from=vault');
    expect(pageText()).toContain('Loading');
    vi.advanceTimersByTime(HELLO_EVERY_MS * 3);
    expect(vault.received.filter((m) => (m as { t: string }).t === 'hana:email-share-hello').length).toBeGreaterThanOrEqual(3);
    expect(vault.postMessage.mock.calls[0]![1]).toBe(ENV.vaultOrigin);
    win.message(request(), ENV.vaultOrigin, vault);
    await flush();
    expect(preview).toHaveBeenCalledWith(PK, PARTNER, {
      sessionPublicKey: Array(32).fill(1),
      issuedAtMs: 1_800_000_000_000,
      nonce: Array(16).fill(2),
      signature: Array(64).fill(3),
      sealedEmail: SEALED,
    });
    expect(pageText()).toContain(SHARE_TEXT.ask('Partner App'));
    expect(document.getElementById('share-address')?.textContent).toBe('ada@example.com');
    expect(pageText()).toContain('may keep the address it already received');
    expect(pageText()).not.toContain('own Google client');
    // Not armed yet: a click does nothing.
    const yes = document.querySelector<HTMLButtonElement>('#share-email')!;
    expect(yes.disabled).toBe(true);
    click('#share-email');
    expect(sent()).toEqual([]);
    arm();
    expect(yes.disabled).toBe(false);
    click('#share-email');
    expect(sent()).toEqual([{ v: 1, t: 'hana:email-share-answer', answer: 'granted' }]);
    expect(pageText()).toContain('Saving');
    win.message({ v: 1, t: 'hana:email-share-done', state: 'granted' }, ENV.vaultOrigin, vault);
    expect(pageText()).toContain(SHARE_TEXT.savedShared('Partner App'));
    expect(pageText()).not.toContain('ada@example.com');
    vi.advanceTimersByTime(DONE_CLOSE_MS);
    expect(win.closed).toBe(true);
  });

  it('"Not now" needs no guard and records declined; the own-Google-client caveat is shown (D42)', async () => {
    start('?from=vault');
    win.message(request({ ownGoogleClient: true }), ENV.vaultOrigin, vault);
    await flush();
    expect(pageText()).toContain(SHARE_TEXT.ownGoogle('Partner App'));
    click('#share-not-now');
    expect(sent()).toEqual([{ v: 1, t: 'hana:email-share-answer', answer: 'declined' }]);
  });

  it('an address already shared: Stop sharing (revoke) or Done (keep)', async () => {
    start('?from=vault');
    win.message(request({ state: 'granted' }), ENV.vaultOrigin, vault);
    await flush();
    expect(pageText()).toContain(SHARE_TEXT.shared('Partner App'));
    expect(pageText()).toContain(SHARE_TEXT.stopNote('Partner App'));
    click('#share-stop');
    expect(sent()).toEqual([{ v: 1, t: 'hana:email-share-answer', answer: 'revoke' }]);
  });

  it('takes messages only from the authenticated vault; the partner page can’t drive it', async () => {
    start(`?from=partner&v=${FRAME}`);
    win.message(request(), EVIL, vault);
    win.message(request(), ENV.vaultOrigin, partner);
    await flush();
    expect(preview).not.toHaveBeenCalled();
    win.message(request(), ENV.vaultOrigin, vault);
    await flush();
    expect(preview).toHaveBeenCalledOnce();
    // A "done" or "close" from anyone else changes nothing.
    win.message({ v: 1, t: 'hana:email-share-close' }, ENV.vaultOrigin, partner);
    expect(win.closed).toBe(false);
  });

  it('the vault’s close closes the window; a preview that fails shows why and lets the user close', async () => {
    start('?from=login');
    expect(pageText()).toContain('Finishing sign-in');
    win.message({ v: 1, t: 'hana:email-share-close' }, ENV.vaultOrigin, vault);
    expect(win.closed).toBe(true);

    start('?from=vault');
    preview.mockRejectedValueOnce(new Error('400'));
    win.message(request(), ENV.vaultOrigin, vault);
    await flush();
    expect(pageText()).toContain('Couldn’t load your email address');
    expect(sent()).toEqual([]);
    document.querySelector<HTMLButtonElement>('#share-close')!.click();
    expect(win.closed).toBe(true);
  });

  it('a "failed" from the vault says so; no request in time closes the window', async () => {
    start('?from=vault');
    win.message(request(), ENV.vaultOrigin, vault);
    await flush();
    click('#share-not-now');
    win.message({ v: 1, t: 'hana:email-share-done', state: 'failed' }, ENV.vaultOrigin, vault);
    expect(pageText()).toContain('Couldn’t save your choice');
    start('?from=vault');
    vi.advanceTimersByTime(OPENED_WAIT_MS);
    expect(win.closed).toBe(true);
    start('?from=login');
    vi.advanceTimersByTime(OPENED_WAIT_MS);
    expect(win.closed).toBe(false);
    vi.advanceTimersByTime(LOGIN_WAIT_MS);
    expect(win.closed).toBe(true);
  });
});

describe('the login popup’s hand-off (share-handoff.ts)', () => {
  it('a marked login goes to /share-email?from=login instead of closing, once; others close', () => {
    const now = 1_800_000_000_000;
    markEmailShare(window.sessionStorage, RELAY, now);
    expect(window.sessionStorage.getItem(`${SHARE_MARK_PREFIX}${RELAY}`)).toBe(String(now));
    const w = new FakeWindow('/login/callback');
    closeOrShare(w, RELAY, now + 1000);
    expect(w.location.assigned).toEqual(['/share-email?from=login']);
    expect(w.closed).toBe(false);
    const again = new FakeWindow('/login/callback');
    closeOrShare(again, RELAY, now + 2000);
    expect(again.closed).toBe(true);
    // Too old, or not a relay id: no hand-off.
    markEmailShare(window.sessionStorage, RELAY, now);
    expect(takeEmailShare(window.sessionStorage, RELAY, now + 11 * 60_000)).toBe(false);
    markEmailShare(window.sessionStorage, 'bad id', now);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('the approval popup’s account line (D422)', () => {
  it('shows "Stop sharing" only with emailShared, posts hana:email-revoke, and says what happened', async () => {
    resetDom();
    const w = new FakeWindow('/approve');
    const v = remoteWindow();
    w.opener = asWindow(v);
    startApprovePage({ win: w, env: ENV, isGesture: () => true });
    const req = {
      v: 1,
      t: 'hana:approve-request',
      id: newRequestId(),
      appName: 'Partner App',
      parentOrigin: PARTNER,
      kind: 'evm_tx',
      chain: 'evm',
      address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
      bytes: evmTxSigningPayload(
        parseEvmTxRequest({ chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', value: '0x1', data: '0x' }),
      ),
      context: { chainId: 11155111 },
      position: 1,
      queued: 1,
    };
    w.message(req, ENV.vaultOrigin, v);
    expect(document.getElementById('email-shared')).toBeNull();
    w.message({ ...req, id: newRequestId(), emailShared: true }, ENV.vaultOrigin, v);
    expect(pageText()).toContain(EMAIL_SHARED_TEXT.line('Partner App'));
    document.getElementById('email-stop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(v.received.some((m) => (m as { t: string }).t === 'hana:email-revoke')).toBe(true);
    w.message({ v: 1, t: 'hana:email-revoked', ok: false }, ENV.vaultOrigin, v);
    expect(pageText()).toContain(EMAIL_SHARED_TEXT.failed);
    w.message({ v: 1, t: 'hana:email-revoked', ok: true }, ENV.vaultOrigin, v);
    expect(pageText()).toContain(EMAIL_SHARED_TEXT.stopped('Partner App'));
    // From anyone else: ignored.
    w.message({ v: 1, t: 'hana:email-revoked', ok: true }, EVIL, v);
  });
});
