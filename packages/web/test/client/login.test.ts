// @vitest-environment happy-dom
// The login popup opener (docs/batch-b-spec.md "Login" step 1, "Partner requirements"; Tests → Web unit → Login, "the
// SDK: popup closed before connect gives coop_blocks_popup; no hello within 15 s gives login_timeout; popup_blocked
// shows the launcher").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaError } from '../../src/client/errors.ts';
import { LOGIN_POPUP_FEATURES, POPUP_CONNECT_TIMEOUT_MS } from '../../src/client/login.ts';
import { EVM, EVM_2, LOGGED_IN, LOGGED_OUT, ORIGINS, STELLAR, STELLAR_2, type Setup, flush, setup } from './harness.ts';

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

const LOGIN_RESULT = { addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' as const };

/** The rejection of `p` as a HanaError. Attaches its handler at once, so call it before advancing timers. */
async function rejection(p: Promise<unknown>): Promise<HanaError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HanaError);
  return e as HanaError;
}

describe('opening the popup', () => {
  it('calls window.open synchronously, before login() returns, with the vault frame name, a random window name and popup features', async () => {
    s = setup();
    await s.vault.connect();
    const p = s.client.login();
    p.catch(() => {});
    expect(s.open).toHaveBeenCalledTimes(1); // no await between the call and window.open
    const [url, name, features] = s.open.mock.calls[0] as [string, string, string];
    expect(url).toBe(`${ORIGINS.authOrigin}/login?v=${s.frame.name}`);
    expect(name).toMatch(/^hana-login-[0-9a-f]{32}$/u);
    expect(features).toBe(LOGIN_POPUP_FEATURES);
    expect(features).not.toContain('noopener');
    expect(s.client.status).toBe('logging_in');
    p.catch(() => {});
  });

  it('sends hana_login with no params and resolves with the addresses from the vault', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.login();
    await flush();
    const req = s.vault.last('hana_login');
    expect(req.raw).toEqual({ v: 1, id: req.id, method: 'hana_login' });
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    s.vault.reply(req.id, { ...LOGIN_RESULT, timings: { chain: 6500 } });
    await expect(p).resolves.toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.client.status).toBe('logged_in');
    expect(s.client.addresses).toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.client.expiresAtMs).toBe(LOGIN_RESULT.expiresAtMs);
    // The client adds its own stages around the vault's (pk_test_ only): window.open, the wait, the port round trip.
    expect(s.client.lastLogin?.timings).toEqual({ chain: 6500, open: expect.any(Number), wait: expect.any(Number), port: expect.any(Number) });
    expect(s.client.error).toBeNull();
  });

  it('login({method, emailHint}) sends them with hana_login, after opening the popup in the click (batch 8a)', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.login({ method: 'email', emailHint: 'ada@example.com' });
    expect(s.open).toHaveBeenCalledTimes(1);
    await flush();
    const req = s.vault.last('hana_login');
    expect(req.raw).toEqual({ v: 1, id: req.id, method: 'hana_login', params: { method: 'email', emailHint: 'ada@example.com' } });
    s.vault.reply(req.id, LOGIN_RESULT);
    await expect(p).resolves.toEqual({ stellar: STELLAR, evm: EVM });
  });

  it('refuses bad login options before opening anything (-32602)', async () => {
    s = setup();
    await s.vault.connect();
    for (const bad of [{ method: 'apple' }, { method: 'google', emailHint: 'ada@example.com' }, { emailHint: 'nope' }, { other: 1 }, 'email']) {
      const e = await rejection(s.client.login(bad as never));
      expect(e.code).toBe(-32602);
    }
    expect(s.open).not.toHaveBeenCalled();
  });

  it('opens the popup even before the handshake finishes, then sends hana_login once ready', async () => {
    s = setup();
    s.vault.handle('hana_login', () => ({ result: LOGIN_RESULT }));
    const p = s.client.login();
    expect(s.open).toHaveBeenCalledTimes(1);
    await flush();
    expect(s.vault.requests).toHaveLength(0);
    await s.vault.connect(LOGGED_OUT);
    await expect(p).resolves.toEqual({ stellar: STELLAR, evm: EVM });
  });

  it('when the vault turns out already unlocked, closes the popup and resolves without hana_login', async () => {
    s = setup();
    const p = s.client.login();
    await s.vault.connect(LOGGED_IN);
    await expect(p).resolves.toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.popups[0]?.close).toHaveBeenCalled();
    expect(s.vault.seen('hana_login')).toHaveLength(0);
    expect(s.client.status).toBe('logged_in');
  });

  it('already logged in: resolves at once, with no popup', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    await expect(s.client.login()).resolves.toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.open).not.toHaveBeenCalled();
  });

  it('after vault_unavailable, rejects at once without opening a popup', async () => {
    s = setup();
    await vi.advanceTimersByTimeAsync(5000);
    const e = await rejection(s.client.login());
    expect(e.code).toBe('vault_unavailable');
    expect(s.open).not.toHaveBeenCalled();
  });

  it('a login started before the handshake fails with vault_unavailable and closes its popup', async () => {
    s = setup();
    const p = s.client.login();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect((await rejection(p)).code).toBe('vault_unavailable');
    expect(s.popups[0]?.close).toHaveBeenCalled();
    expect(s.client.status).toBe('error');
  });
});

describe('watching the popup until popup_connected', () => {
  it('popup closed before connect → coop_blocks_popup, and the vault is told to cancel', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    const p = s.client.login();
    p.catch(() => {});
    await flush();
    s.popups[0]!.closed = true;
    await vi.advanceTimersByTimeAsync(100);
    const e = await rejection(p);
    expect(e.code).toBe('coop_blocks_popup');
    expect(s.vault.seen('hana_cancelLogin')).toHaveLength(1);
    expect(s.client.status).toBe('logged_out');
    expect(s.client.error?.code).toBe('coop_blocks_popup');
    // The vault's own login_cancelled reply to the old hana_login changes nothing.
    s.vault.replyError(s.vault.last('hana_login').id, 'login_cancelled');
    await flush();
    expect(s.client.status).toBe('logged_out');
  });

  it('a popup that reports closed at once (opener COOP same-origin) → coop_blocks_popup', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    s.open.mockImplementationOnce(() => Object.assign(new (class {})(), { closed: true, close: vi.fn() }));
    const p = s.client.login();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    expect((await rejection(p)).code).toBe('coop_blocks_popup');
  });

  it('no popup_connected within 15 s of opening → hana_cancelLogin, popup closed, login_timeout {stage: connect}', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    const p = s.client.login();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(POPUP_CONNECT_TIMEOUT_MS - 1);
    expect(s.vault.seen('hana_cancelLogin')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const e = await rejection(p);
    expect(e.code).toBe('login_timeout');
    expect(e.data).toEqual({ stage: 'connect' });
    expect(s.popups[0]?.close).toHaveBeenCalled();
    expect(s.vault.seen('hana_cancelLogin')).toHaveLength(1);
  });

  it('after popup_connected, stops looking at popup.closed and has no 15 s limit (Google COOP may sever the handle)', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const progress: unknown[] = [];
    s.client.on('loginProgress', (d) => progress.push(d));
    const p = s.client.login();
    await flush();
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    await flush();
    s.popups[0]!.closed = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.vault.seen('hana_cancelLogin')).toHaveLength(0);
    expect(s.popups[0]?.close).not.toHaveBeenCalled();
    s.vault.emit('loginProgress', { stage: 'chain' });
    s.vault.reply(s.vault.last('hana_login').id, LOGIN_RESULT);
    await expect(p).resolves.toEqual({ stellar: STELLAR, evm: EVM });
    expect(progress).toEqual([{ stage: 'popup_connected' }, { stage: 'chain' }]);
  });

  it("passes on the vault's errors (google_error with Google's code, the 5 min login_timeout)", async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => ({ error: { code: 'google_error', message: 'Google refused', data: { error: 'access_denied' } } }));
    const e = await rejection(s.client.login());
    expect(e.code).toBe('google_error');
    expect(e.data).toEqual({ error: 'access_denied' });
    expect(s.client.status).toBe('logged_out');
    s.vault.handle('hana_login', () => ({ error: { code: 'login_timeout', message: 'timed out', data: { stage: 'pending' } } }));
    const e2 = await rejection(s.client.login());
    expect(e2.data).toEqual({ stage: 'pending' });
  });
});

describe('blocked popups (Safari after an await, popup blockers)', () => {
  it('sends hana_login {popupBlocked: true}, shows the launcher on the vault ui event, and resolves after the launcher login', async () => {
    s = setup({ popup: 'blocked' });
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.login();
    await flush();
    expect(s.vault.last('hana_login').params).toEqual({ popupBlocked: true });
    s.vault.emit('ui', { launcher: 'show', label: 'Sign in with Hana' });
    await flush();
    expect(s.frame.hidden).toBe(false);
    // No popup to watch: no 15 s limit on the SDK side (the vault's 5 min pending limit applies).
    await vi.advanceTimersByTimeAsync(60_000);
    s.vault.emit('ui', { launcher: 'hide', label: '' });
    s.vault.reply(s.vault.last('hana_login').id, LOGIN_RESULT);
    await expect(p).resolves.toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.frame.hidden).toBe(true);
  });

  it('a window.open that throws counts as blocked', async () => {
    s = setup();
    await s.vault.connect();
    s.open.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    s.vault.handle('hana_login', () => 'manual');
    const p = s.client.login();
    await flush();
    expect(s.vault.last('hana_login').params).toEqual({ popupBlocked: true });
    p.catch(() => {});
  });

  it('cancelLogin while waiting on the launcher → popup_blocked, and the vault is told', async () => {
    s = setup({ popup: 'blocked' });
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    const p = s.client.login();
    await flush();
    s.client.cancelLogin();
    expect((await rejection(p)).code).toBe('popup_blocked');
    await flush();
    expect(s.vault.seen('hana_cancelLogin')).toHaveLength(1);
    expect(s.client.status).toBe('logged_out');
  });
});

describe('cancel and supersede', () => {
  it('cancelLogin with a popup → login_cancelled, popup closed', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    const p = s.client.login();
    await flush();
    s.client.cancelLogin();
    expect((await rejection(p)).code).toBe('login_cancelled');
    expect(s.popups[0]?.close).toHaveBeenCalled();
    await flush();
    expect(s.vault.seen('hana_cancelLogin')).toHaveLength(1);
  });

  it('a second login() supersedes the first: the first rejects login_cancelled, the second completes', async () => {
    s = setup();
    await s.vault.connect();
    s.vault.handle('hana_login', () => 'manual');
    const first = s.client.login();
    await flush();
    const second = s.client.login();
    expect((await rejection(first)).code).toBe('login_cancelled');
    expect(s.popups[0]?.close).toHaveBeenCalled();
    expect(s.open).toHaveBeenCalledTimes(2);
    expect(s.client.status).toBe('logging_in');
    await flush();
    const [r1, r2] = s.vault.seen('hana_login');
    // The vault answers the superseded request with login_cancelled; the second gets the result.
    s.vault.replyError(r1!.id, 'login_cancelled');
    await flush();
    expect(s.client.status).toBe('logging_in');
    s.vault.reply(r2!.id, { ...LOGIN_RESULT, addresses: { stellar: STELLAR_2, evm: EVM_2 } });
    await expect(second).resolves.toEqual({ stellar: STELLAR_2, evm: EVM_2 });
    expect(s.client.status).toBe('logged_in');
  });

  it('a login superseded before the handshake never sends its hana_login', async () => {
    s = setup();
    s.vault.handle('hana_login', () => 'manual');
    const first = s.client.login();
    const second = s.client.login();
    expect((await rejection(first)).code).toBe('login_cancelled');
    await s.vault.connect();
    expect(s.vault.seen('hana_login')).toHaveLength(1);
    second.catch(() => {});
  });

  it('the old popup_connected never stops the new attempt from watching its popup before its own hana_login', async () => {
    s = setup();
    s.vault.handle('hana_login', () => 'manual');
    s.vault.handle('hana_cancelLogin', () => ({ result: null }));
    const p = s.client.login();
    p.catch(() => {});
    // Not ready yet: a stray popup_connected before this attempt's hana_login is ignored.
    s.vault.load();
    await flush();
    s.vault.emit('loginProgress', { stage: 'popup_connected' });
    await flush();
    s.vault.emit('ready', LOGGED_OUT);
    await flush();
    s.popups[0]!.closed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect((await rejection(p)).code).toBe('coop_blocks_popup');
  });
});
