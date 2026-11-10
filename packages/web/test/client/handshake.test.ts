// @vitest-environment happy-dom
// The vault iframe and the handshake (docs/batch-b-spec.md "Partner ↔ vault handshake", "Partner requirements").
import { ErrorCode } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaClient } from '../../src/client/client.ts';
import { HanaError } from '../../src/client/errors.ts';
import {
  ANSWER_TIMEOUT_MS,
  LAUNCHER_HEIGHT_PX,
  LAUNCHER_WIDTH_PX,
  POST_LOAD_ANSWER_MS,
  READY_AFTER_CONNECT_MS,
  VAULT_UNAVAILABLE_MESSAGES,
  noAnswerMessage,
} from '../../src/client/vault-connection.ts';
import { VERSION } from '../../src/version.ts';
import { EVM, FakeVault, LOGGED_IN, LOGGED_OUT, ORIGINS, PK, STELLAR, type Setup, flush, setup } from './harness.ts';

let s: Setup;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const rejection = async (p: Promise<unknown>): Promise<HanaError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HanaError);
  return e as HanaError;
};

describe('iframe', () => {
  it('inserts a hidden vault iframe with a 128-bit random name, the pk in src, and no sandbox or allow', () => {
    s = setup();
    const f = s.frame;
    expect(f).not.toBeNull();
    expect(f.name).toMatch(/^hana-vault-[0-9a-f]{32}$/u);
    expect(f.getAttribute('src')).toBe(`${ORIGINS.vaultOrigin}/vault?pk=${PK}`);
    expect(f.hidden).toBe(true);
    expect(f.style.getPropertyValue('display')).toBe('none');
    expect(f.hasAttribute('sandbox')).toBe(false);
    expect(f.hasAttribute('allow')).toBe(false);
    expect(f.parentElement).toBe(document.body);
  });

  it('names differ per client', () => {
    s = setup();
    const first = s.frame.name;
    s.client.destroy();
    s = setup();
    expect(s.frame.name).not.toBe(first);
  });

  it('goes into `container` when given', () => {
    const container = document.createElement('div');
    document.body.append(container);
    s = setup({ config: { container } });
    expect(s.frame.parentElement).toBe(container);
  });

  it('waits for <body> when created from <head>', async () => {
    const body = document.body;
    body.remove();
    try {
      const client = new HanaClient({ publishableKey: PK, environment: 'test' }, { win: window, origins: ORIGINS, fetch: vi.fn() });
      expect(document.querySelector('iframe')).toBeNull();
      document.documentElement.append(body);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(document.body.querySelector('iframe[name^="hana-vault-"]')).not.toBeNull();
      client.destroy();
    } finally {
      if (!body.isConnected) document.documentElement.append(body);
    }
  });
});

describe('handshake', () => {
  it('posts hana:hello to vaultOrigin on load, transferring a port, and resolves ready with the status', async () => {
    s = setup();
    expect(s.client.status).toBe('unlocking');
    s.vault.load();
    expect(s.vault.hello?.message).toEqual({ v: 1, t: 'hana:hello', sdk: VERSION });
    expect(s.vault.hello?.targetOrigin).toBe(ORIGINS.vaultOrigin);
    expect(s.vault.hello?.transfer).toHaveLength(1);
    s.vault.emit('ready', LOGGED_OUT);
    await flush();
    await expect(s.client.ready).resolves.toBeUndefined();
    expect(s.client.status).toBe('logged_out');
    expect(s.client.persistence).toBe('session');
    expect(s.client.addresses).toBeNull();
  });

  it('a ready with an unlocked session reports logged_in, addresses and expiry, and emits accountsChanged', async () => {
    s = setup();
    const seen: unknown[] = [];
    const statuses: string[] = [];
    s.client.on('accountsChanged', (a) => seen.push(a));
    s.client.on('statusChanged', (st) => statuses.push(st));
    await s.vault.connect(LOGGED_IN);
    expect(s.client.status).toBe('logged_in');
    expect(s.client.addresses).toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.client.expiresAtMs).toBe(LOGGED_IN.expiresAtMs);
    expect(seen).toEqual([{ stellar: STELLAR, evm: EVM }]);
    expect(statuses).toEqual(['logged_in']);
  });

  it('reports the storage_unavailable warning from ready', async () => {
    s = setup();
    await s.vault.connect({ ...LOGGED_OUT, persistence: 'none', warning: 'storage_unavailable' });
    expect(s.client.warning).toBe('storage_unavailable');
    expect(s.client.persistence).toBe('none');
  });

  it('sends the hello only once, even if load fires again', async () => {
    s = setup();
    s.vault.load();
    const first = s.vault.hello;
    s.vault.load();
    expect(s.vault.hello).toBe(first);
  });

  /** A frame's answer deadline plus the task the SDK drains before deciding. */
  const DEADLINE = ANSWER_TIMEOUT_MS + 1;
  const frames = () => [...document.querySelectorAll('iframe[name^="hana-vault-"]')] as HTMLIFrameElement[];

  it('replaces a frame that loaded but did not answer within 1.5 s of its load once, then rejects fast with vault_unavailable (no_answer) naming the page origin', async () => {
    s = setup();
    s.vault.load();
    await vi.advanceTimersByTimeAsync(POST_LOAD_ANSWER_MS - 1);
    expect(s.client.status).toBe('unlocking');
    await vi.advanceTimersByTimeAsync(2); // the deadline, then the drained task
    // The retry: the first frame is gone, a new one with the same name and src is in.
    expect(frames()).toHaveLength(1);
    const second = frames()[0]!;
    expect(second).not.toBe(s.frame);
    expect(s.frame.isConnected).toBe(false);
    expect(second.name).toBe(s.frame.name);
    expect(second.getAttribute('src')).toBe(`${ORIGINS.vaultOrigin}/vault?pk=${PK}`);
    expect(s.client.status).toBe('unlocking');
    new FakeVault(second).load();
    await vi.advanceTimersByTimeAsync(POST_LOAD_ANSWER_MS + 1);
    // Two loaded, silent frames: about 3 s in all (it was two full 5 s deadlines, about 10 s).
    const e = await rejection(s.client.ready);
    expect(e.code).toBe('vault_unavailable');
    expect(e.data).toEqual({ reason: 'no_answer', attempts: 2, origin: window.location.origin });
    expect(e.message).toBe(noAnswerMessage(window.location.origin));
    expect(e.message).toContain(`(${window.location.origin})`);
    expect(e.message).toMatch(/allowed origins \(scheme, host and port/u);
    expect(s.client.status).toBe('error');
    expect(s.client.error?.code).toBe('vault_unavailable');
    // A failed handshake leaves no frame behind.
    expect(frames()).toHaveLength(0);
  });

  it('a vault that answers soon after its load connects; the short deadline counts from the load, not from the insertion', async () => {
    s = setup();
    // A slow page: the frame loads at 4.9 s, and its vault answers 1 s later (past the 5 s insertion deadline).
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 100);
    s.vault.load();
    await vi.advanceTimersByTimeAsync(POST_LOAD_ANSWER_MS - 500);
    expect(frames()).toEqual([s.frame]);
    s.vault.emit('connected', null);
    s.vault.emit('ready', LOGGED_OUT);
    await flush();
    await expect(s.client.ready).resolves.toBeUndefined();
    expect(frames()).toEqual([s.frame]);
  });

  it('the no_answer message points at the exact-origin check, with the origin it names', () => {
    expect(VAULT_UNAVAILABLE_MESSAGES.no_answer).toMatch(/allowed origins/u);
    expect(noAnswerMessage('http://localhost:5174')).toContain('http://localhost:5174 is exactly one of');
  });

  it('a frame still loading gets one more deadline, not a replacement; then frame_timeout', async () => {
    s = setup();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(frames()).toEqual([s.frame]);
    expect(s.client.status).toBe('unlocking');
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const e = await rejection(s.client.ready);
    expect(e.data).toEqual({ reason: 'frame_timeout', attempts: 1 });
    expect(e.message).toMatch(/didn't load in time/u);
    expect(frames()).toHaveLength(0);
  });

  it('a frame that loads during its extra time and then answers connects', async () => {
    s = setup();
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS + 1_000);
    await s.vault.connect(LOGGED_OUT);
    await expect(s.client.ready).resolves.toBeUndefined();
    expect(frames()).toEqual([s.frame]);
  });

  it('a frame that loads during its extra time but never answers is replaced once', async () => {
    s = setup();
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS + 1_000);
    s.vault.load();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(s.frame);
  });

  it('the retried frame can still connect, and a late answer from the first frame counts for nothing', async () => {
    s = setup();
    s.vault.load();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const second = new FakeVault(frames()[0]!);
    // The first frame's vault answers late: its port was closed and is ignored.
    s.vault.emit('ready', LOGGED_IN);
    s.frame.dispatchEvent(new Event('load'));
    await flush();
    expect(s.client.status).toBe('unlocking');
    await second.connect(LOGGED_OUT);
    await expect(s.client.ready).resolves.toBeUndefined();
    expect(s.client.status).toBe('logged_out');
    expect(s.client.addresses).toBeNull();
  });

  it('after connected, ready may take up to 20 s more; later it is ready_timeout, without a retry', async () => {
    s = setup();
    s.vault.load();
    await flush();
    await vi.advanceTimersByTimeAsync(POST_LOAD_ANSWER_MS - 100);
    s.vault.emit('connected', null);
    await flush();
    await vi.advanceTimersByTimeAsync(READY_AFTER_CONNECT_MS - 1);
    expect(s.client.status).toBe('unlocking');
    expect(frames()).toEqual([s.frame]);
    await vi.advanceTimersByTimeAsync(1);
    const e = await rejection(s.client.ready);
    expect(e.data).toEqual({ reason: 'ready_timeout', attempts: 1 });
    // No retry, and the failed frame is gone.
    expect(frames()).toHaveLength(0);
  });

  it('a second load before ready is frame_replaced, without a retry', async () => {
    s = setup();
    s.vault.load();
    s.vault.load();
    const e = await rejection(s.client.ready);
    expect(e.data).toEqual({ reason: 'frame_replaced', attempts: 1 });
  });

  it('a slow unlock after connected still resolves ready', async () => {
    s = setup();
    s.vault.load();
    await flush();
    s.vault.emit('connected', null);
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS + 5_000);
    s.vault.emit('ready', LOGGED_IN);
    await flush();
    await expect(s.client.ready).resolves.toBeUndefined();
    expect(s.client.status).toBe('logged_in');
  });

  it('a late ready after the timeout is ignored, and requests stay refused', async () => {
    s = setup();
    s.vault.load();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    new FakeVault(frames()[0]!).load();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    s.vault.emit('ready', LOGGED_IN);
    s.vault.emit('accountsChanged', { addresses: { stellar: STELLAR, evm: EVM } });
    await flush();
    expect(s.client.status).toBe('error');
    expect(s.client.addresses).toBeNull();
    expect((await rejection(s.client.logout())).code).toBe('vault_unavailable');
    expect(s.vault.requests).toHaveLength(0);
  });

  it('fails at once on a CSP frame-src violation for vaultOrigin (partner requirement)', async () => {
    s = setup();
    const ev = Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'frame-src', violatedDirective: 'frame-src', blockedURI: `${ORIGINS.vaultOrigin}/vault?pk=${PK}`, disposition: 'enforce' });
    document.dispatchEvent(ev);
    const e = await rejection(s.client.ready);
    expect(e.code).toBe('vault_unavailable');
    expect(e.data).toEqual({ reason: 'csp_frame_src', attempts: 1 });
    expect(e.message).toBe(VAULT_UNAVAILABLE_MESSAGES.csp_frame_src);
    // No retry for a block the page's own policy makes; the frame is removed.
    await vi.advanceTimersByTimeAsync(2 * ANSWER_TIMEOUT_MS);
    expect(frames()).toHaveLength(0);
  });

  it('ignores a report-only frame-src violation for vaultOrigin: the frame still loads, and ready resolves', async () => {
    s = setup();
    const ev = Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'frame-src', violatedDirective: 'frame-src', blockedURI: `${ORIGINS.vaultOrigin}/vault?pk=${PK}`, disposition: 'report' });
    document.dispatchEvent(ev);
    await flush();
    expect(s.client.status).toBe('unlocking');
    await s.vault.connect(LOGGED_IN);
    await expect(s.client.ready).resolves.toBeUndefined();
    expect(s.client.status).toBe('logged_in');
    expect(s.client.error).toBeNull();
  });

  it('ignores CSP violations for other origins or directives', async () => {
    s = setup();
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'frame-src', blockedURI: 'https://other.test/x' }));
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'img-src', blockedURI: `${ORIGINS.vaultOrigin}/logo.png` }));
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'frame-src', blockedURI: `${ORIGINS.vaultOrigin}.evil.test/vault` }));
    await s.vault.connect();
    await expect(s.client.ready).resolves.toBeUndefined();
  });

  it('drops malformed events', async () => {
    s = setup();
    s.vault.load();
    await flush();
    s.vault.emit('ready', { status: 'logged_in', persistence: 'session' }); // no addresses
    s.vault.port?.postMessage({ v: 2, event: 'ready', data: LOGGED_OUT });
    s.vault.emit('nonsense', {});
    await flush();
    expect(s.client.status).toBe('unlocking');
    s.vault.emit('ready', LOGGED_OUT);
    await flush();
    expect(s.client.status).toBe('logged_out');
  });
});

describe('port requests', () => {
  it('waits for ready, then sends {v:1, id, method, params} and resolves with the result', async () => {
    s = setup();
    s.vault.handle('hana_revokeOtherDevices', () => ({ result: { revoked: 2 } }));
    const p = s.client.revokeOtherDevices();
    await flush();
    expect(s.vault.requests).toHaveLength(0);
    await s.vault.connect(LOGGED_IN);
    await expect(p).resolves.toEqual({ revoked: 2 });
    const r = s.vault.last('hana_revokeOtherDevices');
    expect(r.raw).toEqual({ v: 1, id: r.id, method: 'hana_revokeOtherDevices' });
  });

  it('gives each request a unique id and matches replies by id, in any order', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_autoApproveStatus', () => 'manual');
    s.vault.handle('hana_revokeAutoApprove', () => 'manual');
    const a = s.client.autoApproveStatus();
    const b = s.client.revokeAutoApprove();
    await flush();
    const [ra, rb] = [s.vault.last('hana_autoApproveStatus'), s.vault.last('hana_revokeAutoApprove')];
    expect(ra.id).not.toBe(rb.id);
    s.vault.reply(rb.id, null);
    s.vault.reply(ra.id, null);
    await expect(b).resolves.toBeNull();
    await expect(a).resolves.toBeNull();
  });

  it("rejects with the vault's error code, message and data", async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_export', () => ({ error: { code: 'busy', message: 'An export is already running' } }));
    const e = await rejection(s.client.exportKey('evm'));
    expect(e.code).toBe('busy');
    expect(e.message).toBe('An export is already running');
  });

  it("refuses, without sending, a request the vault's parser would drop (-32602)", async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const e = await rejection(s.client.signRaw({ chain: 'evm', digest: new Uint8Array(31) }));
    expect(e.code).toBe(-32602);
    const e2 = await rejection(s.client.exportKey('solana' as never));
    expect(e2.code).toBe(-32602);
    expect(s.vault.requests).toHaveLength(0);
    expect(s.vault.invalid).toHaveLength(0);
  });

  it('a malformed reply to a pending request fails it (-32603) instead of hanging', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_revokeOtherDevices', () => ({ result: { revoked: 'two' } }));
    expect((await rejection(s.client.revokeOtherDevices())).code).toBe(-32603);
  });

  it('ignores replies with unknown ids', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_revokeOtherDevices', () => 'manual');
    const p = s.client.revokeOtherDevices();
    await flush();
    s.vault.reply('999', { revoked: 1 });
    await flush();
    s.vault.reply(s.vault.last('hana_revokeOtherDevices').id, { revoked: 3 });
    await expect(p).resolves.toEqual({ revoked: 3 });
  });
});

describe('launcher', () => {
  it('shows the iframe as a fixed 320×72 element on ui show, hides it on ui hide, and emits launcher', async () => {
    s = setup();
    const seen: unknown[] = [];
    s.client.on('launcher', (l) => seen.push(l));
    await s.vault.connect();
    s.vault.emit('ui', { launcher: 'show', label: 'Review in Hana' });
    await flush();
    const st = s.frame.style;
    expect(s.frame.hidden).toBe(false);
    expect(st.getPropertyValue('display')).toBe('block');
    expect(st.getPropertyValue('position')).toBe('fixed');
    expect(st.getPropertyValue('width')).toBe(`${LAUNCHER_WIDTH_PX}px`);
    expect(st.getPropertyValue('height')).toBe(`${LAUNCHER_HEIGHT_PX}px`);
    expect(s.frame.hasAttribute('sandbox')).toBe(false);
    s.vault.emit('ui', { launcher: 'hide', label: '' });
    await flush();
    expect(s.frame.hidden).toBe(true);
    expect(st.getPropertyValue('display')).toBe('none');
    expect(seen).toEqual([
      { visible: true, label: 'Review in Hana', clickable: true },
      { visible: false, label: '', clickable: false },
    ]);
  });

  it('says whether the launcher can be clicked: a notice is not a button, and the next show is one again', async () => {
    s = setup();
    const seen: unknown[] = [];
    s.client.on('launcher', (l) => seen.push(l));
    await s.vault.connect();
    // The vault says what kind the next show is, just before it.
    s.vault.emit('launcherKind', { clickable: false });
    s.vault.emit('ui', { launcher: 'show', label: 'Signed by Hana under Swaps' });
    s.vault.emit('ui', { launcher: 'hide', label: '' });
    s.vault.emit('launcherKind', { clickable: true });
    s.vault.emit('ui', { launcher: 'show', label: 'Review in Hana' });
    // A show with no kind before it (nothing said otherwise) is a button.
    s.vault.emit('ui', { launcher: 'show', label: 'Sign in with Hana' });
    await flush();
    expect(seen).toEqual([
      { visible: true, label: 'Signed by Hana under Swaps', clickable: false },
      { visible: false, label: '', clickable: false },
      { visible: true, label: 'Review in Hana', clickable: true },
      { visible: true, label: 'Sign in with Hana', clickable: true },
    ]);
    // The frame shows for a notice as for a button: the notice is the vault's own.
    expect(s.frame.hidden).toBe(false);
  });

  it('a second load while the launcher shows hides the frame at once and emits launcher hidden (PART-1)', async () => {
    s = setup();
    const seen: unknown[] = [];
    s.client.on('launcher', (l) => seen.push(l));
    await s.vault.connect();
    s.vault.emit('ui', { launcher: 'show', label: 'Review in Hana' });
    await flush();
    expect(s.frame.hidden).toBe(false);
    // Another frame navigated the vault frame: whatever loads there now must not sit in the launcher's spot.
    s.vault.load();
    await flush();
    expect(s.frame.hidden).toBe(true);
    expect(s.frame.style.getPropertyValue('display')).toBe('none');
    expect(seen).toEqual([
      { visible: true, label: 'Review in Hana', clickable: true },
      { visible: false, label: '', clickable: false },
    ]);
    expect(s.client.status).toBe('error');
  });
});

describe('events and disconnects', () => {
  it('accountsChanged, sessionExpired and disconnect update status and addresses and are re-emitted', async () => {
    s = setup();
    const events: unknown[] = [];
    s.client.on('accountsChanged', (a) => events.push(['accounts', a]));
    s.client.on('sessionExpired', () => events.push(['expired']));
    s.client.on('disconnect', (d) => events.push(['disconnect', d]));
    await s.vault.connect(LOGGED_IN);
    s.vault.emit('sessionExpired', null);
    await flush();
    expect(s.client.status).toBe('logged_out');
    expect(s.client.addresses).toBeNull();
    s.vault.emit('accountsChanged', { addresses: { stellar: STELLAR, evm: EVM } });
    await flush();
    expect(s.client.status).toBe('logged_in');
    s.vault.emit('disconnect', { code: ErrorCode.disconnected });
    await flush();
    expect(s.client.status).toBe('logged_out');
    expect(events).toEqual([
      ['accounts', { stellar: STELLAR, evm: EVM }],
      ['accounts', null],
      ['expired'],
      ['accounts', { stellar: STELLAR, evm: EVM }],
      ['accounts', null],
      ['disconnect', { code: 4900 }],
    ]);
  });

  it('a second load (vault document replaced) disconnects: pending requests reject 4900, status error, disconnect emitted once', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const disconnects: unknown[] = [];
    s.client.on('disconnect', (d) => disconnects.push(d));
    s.vault.handle('hana_revokeOtherDevices', () => 'manual');
    const p = s.client.revokeOtherDevices();
    await flush();
    s.vault.load();
    expect((await rejection(p)).code).toBe(4900);
    expect(s.client.status).toBe('error');
    expect(s.client.addresses).toBeNull();
    expect(s.client.error?.code).toBe(4900);
    expect((await rejection(s.client.logout())).code).toBe(4900);
    s.vault.load();
    await flush();
    expect(disconnects).toEqual([{ code: 4900 }]);
  });

  it('destroy removes the iframe, rejects pending and later calls with 4900, and drops listeners', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_autoApproveStatus', () => 'manual');
    const p = s.client.autoApproveStatus();
    await flush();
    const listener = vi.fn();
    s.client.on('statusChanged', listener);
    const disconnect = vi.fn();
    s.client.on('disconnect', disconnect);
    s.client.destroy();
    expect(disconnect).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
    expect((await rejection(p)).code).toBe(4900);
    expect((await rejection(s.client.login())).code).toBe(4900);
    expect(s.client.listenerCount('statusChanged')).toBe(0);
    s.client.destroy(); // idempotent
  });
});

describe('logout and the other silent methods', () => {
  it('logout sends hana_logout, then reports logged_out and accountsChanged null', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const seen: unknown[] = [];
    s.client.on('accountsChanged', (a) => seen.push(a));
    s.vault.handle('hana_logout', () => ({ result: null }));
    await s.client.logout();
    expect(s.vault.seen('hana_logout')).toHaveLength(1);
    expect(s.client.status).toBe('logged_out');
    expect(s.client.addresses).toBeNull();
    expect(seen).toEqual([null]);
  });

  it('exportKey sends hana_export {chain} and resolves null (the key never comes back)', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_export', () => ({ result: null }));
    await expect(s.client.exportKey('stellar')).resolves.toBeNull();
    expect(s.vault.last('hana_export').params).toEqual({ chain: 'stellar' });
  });

  it('auto-approve: request, status and revoke go to their port methods; autoApproved is re-emitted', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const policyId = 'ab'.repeat(32);
    s.vault.handle('hana_requestAutoApprove', () => ({ result: { granted: true, policyId, expiresAtMs: 1_900_000_000_000 } }));
    s.vault.handle('hana_autoApproveStatus', () => ({ result: { policyId, label: 'Swaps', expiresAtMs: 1_900_000_000_000, used: { count: 1, native: '0' } } }));
    s.vault.handle('hana_revokeAutoApprove', () => ({ result: null }));
    await expect(s.client.requestAutoApprove()).resolves.toEqual({ granted: true, policyId, expiresAtMs: 1_900_000_000_000 });
    await expect(s.client.autoApproveStatus()).resolves.toMatchObject({ policyId, label: 'Swaps' });
    await expect(s.client.revokeAutoApprove()).resolves.toBeNull();
    const seen: unknown[] = [];
    s.client.on('autoApproved', (a) => seen.push(a));
    const ev = { kind: 'eth_signTransaction', chain: 'evm', contract: '0x0000000000000000000000000000000000000001', function: 'deposit' };
    s.vault.emit('autoApproved', ev);
    await flush();
    expect(seen).toEqual([ev]);
  });

  it('persistenceChanged updates hana.persistence and is re-emitted once per change (D79)', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    expect(s.client.persistence).toBe('session');
    const seen: unknown[] = [];
    s.client.on('persistenceChanged', (p) => seen.push(p));
    s.vault.emit('persistenceChanged', { persistence: 'none' });
    s.vault.emit('persistenceChanged', { persistence: 'none' });
    await flush();
    expect(s.client.persistence).toBe('none');
    expect(seen).toEqual(['none']);
    // The session itself goes on.
    expect(s.client.status).toBe('logged_in');
  });

  it('requestAutoApprove passes on 4100 when the app has no policy in force', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_requestAutoApprove', () => ({ error: { code: 4100, message: 'No auto-approve policy' } }));
    expect((await rejection(s.client.requestAutoApprove())).code).toBe(4100);
  });
});
