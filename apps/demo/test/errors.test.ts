import { HanaError, ProviderRpcError } from '@hana-id/web';
import { describe, expect, it } from 'vitest';
import { errorInfo, plainMessage } from '../src/errors.ts';

describe('errorInfo', () => {
  it('prefers the Hana code an EIP-1193 error carries in data.code', () => {
    expect(errorInfo(new ProviderRpcError(4001, 'User rejected', { code: 'popup_blocked' }))).toEqual({ code: 'popup_blocked', reason: null, message: 'User rejected' });
    expect(errorInfo(new HanaError(4100, 'nope', { reason: 'share_not_fresh' }))).toEqual({ code: 4100, reason: 'share_not_fresh', message: 'nope' });
    expect(errorInfo(new TypeError('Failed to fetch'))).toEqual({ code: null, reason: null, message: 'Failed to fetch' });
    expect(errorInfo('plain')).toEqual({ code: null, reason: null, message: 'plain' });
  });

  it('ignores codes and reasons that are not code-shaped', () => {
    expect(errorInfo({ code: 'Not A Code', data: { reason: '<b>' }, message: 'm' })).toEqual({ code: null, reason: null, message: 'm' });
  });
});

describe('plainMessage', () => {
  it('explains the login failures a user can hit', () => {
    expect(plainMessage(new HanaError('popup_blocked', 'x'), 'login')).toMatch(/blocked the Hana sign-in window.*Allow pop-ups/u);
    expect(plainMessage(new HanaError('login_cancelled', 'x'), 'login')).toBe('Sign-in cancelled.');
    expect(plainMessage(new HanaError('login_method_unavailable', 'x'), 'login')).toMatch(/Email login isn’t turned on/u);
    expect(plainMessage(new HanaError('code_invalid', 'x'), 'login')).toMatch(/wrong code/u);
    expect(plainMessage(new HanaError('challenge_expired', 'x'), 'login')).toMatch(/expired/u);
    // login_timeout: the window never connected, or the sign-in was left unfinished past the vault's 5 minutes.
    expect(plainMessage(new HanaError('login_timeout', 'x', { stage: 'connect' }), 'login')).toBe('The Hana sign-in window did not respond in time. Try again.');
    expect(plainMessage(new HanaError('login_timeout', 'x', { stage: 'pending' }), 'login')).toMatch(/wasn’t finished within 5 minutes/u);
    expect(plainMessage(new HanaError(4001, 'x'), 'login')).toMatch(/did not complete/u);
    expect(plainMessage(new HanaError('google_error', 'x', { error: 'access_denied' }), 'login')).toBe('You declined the Google sign-in.');
    expect(plainMessage(new HanaError('vault_unavailable', 'x'), 'load')).toMatch(/Could not load the Hana vault/u);
    // The SDK's reason after its one retry: a timeout, a frame that didn't answer, a slow start, a blocked frame.
    expect(plainMessage(new HanaError('vault_unavailable', 'x', { reason: 'frame_timeout', attempts: 2 }), 'load')).toMatch(/Could not load the Hana vault in time/u);
    expect(plainMessage(new HanaError('vault_unavailable', 'x', { reason: 'no_answer', attempts: 2 }), 'load')).toMatch(/didn’t answer.*allowed origins/u);
    expect(plainMessage(new HanaError('vault_unavailable', 'x', { reason: 'ready_timeout', attempts: 1 }), 'load')).toMatch(/too slow to restore/u);
    expect(plainMessage(new HanaError('vault_unavailable', 'x', { reason: 'csp_frame_src', attempts: 1 }), 'load')).toMatch(/security policy blocks/u);
    expect(plainMessage(new HanaError('origin_not_allowed', 'x'), 'load')).toMatch(/allowed origins/u);
  });

  it('D385: a session key the browser couldn’t make is about the browser, never the connection', () => {
    const unsupported = plainMessage(new HanaError('derive_failed', 'x', { reason: 'webcrypto_unsupported', error: 'NotSupportedError' }), 'login');
    expect(unsupported).toMatch(/This browser can’t create the key.*Update it, or use another browser/u);
    const failed = plainMessage(new HanaError('derive_failed', 'x', { reason: 'webcrypto_failed', error: 'OperationError' }), 'login');
    expect(failed).toMatch(/This browser failed to create the key.*Try again/u);
    for (const m of [unsupported, failed]) expect(m).not.toMatch(/connection|reach/u);
    expect(plainMessage(new HanaError('derive_failed', 'x', { reason: 'link_restart' }), 'login')).toMatch(/Sign-in failed \(derive_failed\)/u);
  });

  it('explains signing and device outcomes', () => {
    expect(plainMessage(new ProviderRpcError(4001, 'x'), 'sign')).toBe('Rejected in the Hana window: nothing was signed.');
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'share_not_fresh' }), 'revoke')).toMatch(/within 5 minutes/u);
    expect(plainMessage(new HanaError('rate_limited', 'x'), 'export')).toMatch(/exports/u);
  });

  it('turns a network failure into a network message, and anything else into a report hint with its code', () => {
    expect(plainMessage(new TypeError('Failed to fetch'), 'sign')).toBe('Network error. Check your connection and try again.');
    expect(plainMessage(new TypeError('Load failed'), 'login')).toBe('Network error. Check your connection and try again.');
    expect(plainMessage(new HanaError(-32603, 'boom'), 'sign')).toMatch(/Something went wrong \(-32603\).*Copy diagnostics/u);
    expect(plainMessage(new Error('denied'), 'copy')).toMatch(/Could not copy/u);
  });
});
