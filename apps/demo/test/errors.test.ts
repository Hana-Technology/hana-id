import { HanaError, ProviderRpcError } from '@hana-id/web';
import { describe, expect, it } from 'vitest';
import { SIGNED_OUT_MESSAGE, errorInfo, isSignedOut, plainMessage, relayTransaction } from '../src/errors.ts';

describe('errorInfo', () => {
  it('prefers the Hana code an EIP-1193 error carries in data.code', () => {
    expect(errorInfo(new ProviderRpcError(4001, 'User rejected', { code: 'popup_blocked' }))).toEqual({ code: 'popup_blocked', reason: null, message: 'User rejected', requestId: null });
    expect(errorInfo(new HanaError(4100, 'nope', { reason: 'share_not_fresh' }))).toEqual({ code: 4100, reason: 'share_not_fresh', message: 'nope', requestId: null });
    expect(errorInfo(new TypeError('Failed to fetch'))).toEqual({ code: null, reason: null, message: 'Failed to fetch', requestId: null });
    expect(errorInfo('plain')).toEqual({ code: null, reason: null, message: 'plain', requestId: null });
  });

  it('ignores codes and reasons that are not code-shaped', () => {
    expect(errorInfo({ code: 'Not A Code', data: { reason: '<b>' }, message: 'm' })).toEqual({ code: null, reason: null, message: 'm', requestId: null });
  });

  it('D405: data.requestId, the Hana API request the error came from, in either error shape; only exactly a request ID', () => {
    const RQ = '8d1f2c3a4b5e6f70-SIN';
    expect(errorInfo(new HanaError('rate_limited', 'slow down', { requestId: RQ })).requestId).toBe(RQ);
    // The EIP-1193 provider's: the Hana code and the request ID side by side in data (client errors.ts).
    expect(errorInfo(new ProviderRpcError(-32005, 'slow down', { code: 'rate_limited', requestId: RQ }))).toEqual({ code: 'rate_limited', reason: null, message: 'slow down', requestId: RQ });
    for (const bad of ['short', `${RQ} x`, 'a'.repeat(65), 'has_underscore', 42, null, { id: RQ }]) {
      expect(errorInfo(new HanaError('api_unavailable', 'm', { requestId: bad })).requestId, String(bad)).toBeNull();
    }
    expect(errorInfo(new HanaError('login_cancelled', 'm')).requestId).toBeNull();
  });
});

describe('plainMessage', () => {
  it('explains the login failures a user can hit', () => {
    expect(plainMessage(new HanaError('popup_blocked', 'x'), 'login')).toMatch(/blocked the Journear sign-in window.*Allow pop-ups/u);
    expect(plainMessage(new HanaError('login_cancelled', 'x'), 'login')).toBe('Sign-in cancelled.');
    expect(plainMessage(new HanaError('login_method_unavailable', 'x'), 'login')).toMatch(/Email login isn’t turned on/u);
    expect(plainMessage(new HanaError('code_invalid', 'x'), 'login')).toMatch(/wrong code/u);
    expect(plainMessage(new HanaError('challenge_expired', 'x'), 'login')).toMatch(/expired/u);
    // login_timeout: the window never connected, or the sign-in was left unfinished past the vault's 5 minutes.
    expect(plainMessage(new HanaError('login_timeout', 'x', { stage: 'connect' }), 'login')).toBe('The Journear sign-in window did not respond in time. Try again.');
    expect(plainMessage(new HanaError('login_timeout', 'x', { stage: 'pending' }), 'login')).toMatch(/wasn’t finished within 5 minutes/u);
    expect(plainMessage(new HanaError(4001, 'x'), 'login')).toMatch(/did not complete/u);
    expect(plainMessage(new HanaError('google_error', 'x', { error: 'access_denied' }), 'login')).toBe('You declined the Google sign-in.');
    expect(plainMessage(new HanaError('vault_unavailable', 'x'), 'load')).toMatch(/Could not load the Journear vault/u);
    // The SDK's reason after its one retry: a timeout, a frame that didn't answer, a slow start, a blocked frame.
    expect(plainMessage(new HanaError('vault_unavailable', 'x', { reason: 'frame_timeout', attempts: 2 }), 'load')).toMatch(/Could not load the Journear vault in time/u);
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
    expect(plainMessage(new ProviderRpcError(4001, 'x'), 'sign')).toBe('Rejected in the Journear window: nothing was signed.');
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'share_not_fresh' }), 'revoke')).toMatch(/within 5 minutes/u);
    expect(plainMessage(new HanaError('rate_limited', 'x'), 'export')).toMatch(/exports/u);
  });

  it('D695: a 4900 with reason signed_out is a sign-out (log in again, no reload); a 4900 without it is a lost vault', () => {
    const signedOut = 'You were signed out on this device (from Passport Home, another tab or another device). Log in again.';
    expect(SIGNED_OUT_MESSAGE).toBe(signedOut);
    // The refused signature (either error shape) and the disconnect event the page turns into one.
    for (const e of [new HanaError(4900, 'x', { reason: 'signed_out' }), new ProviderRpcError(4900, 'x', { reason: 'signed_out' }), { code: 4900, data: { reason: 'signed_out' } }]) {
      expect(isSignedOut(e)).toBe(true);
      for (const action of ['load', 'sign', 'export', 'identity'] as const) expect(plainMessage(e, action)).toBe(signedOut);
    }
    for (const e of [new HanaError(4900, 'x'), { code: 4900 }, new HanaError(4900, 'x', { reason: 'other' }), new HanaError(4100, 'x', { reason: 'signed_out' })]) expect(isSignedOut(e)).toBe(false);
    expect(plainMessage({ code: 4900 }, 'load')).toBe('The connection to the Journear vault was lost. Reload the page.');
    expect(plainMessage(new ProviderRpcError(4900, 'x'), 'sign')).toBe('The connection to the Journear vault was lost. Reload the page.');
    // Plain words: no em or en dash.
    expect(signedOut).not.toMatch(/[\u2013\u2014]/u);
  });

  it('explains every NEAR refusal of the vault, in any action, in plain words', () => {
    const reasons = ['near_key_unknown', 'near_block_unknown', 'near_network_mismatch', 'near_delegate_nonce_used', 'near_delegate_nonce_too_large', 'near_delegate_expiry', 'near_delegate_nonce_stale', 'near_relayed_delegate', 'near_delegate_test_app_action', 'near_delegate_test_app_receiver'];
    const seen = new Set<string>();
    for (const reason of reasons) {
      for (const action of ['near', 'sign'] as const) {
        const m = plainMessage(new HanaError(4100, 'x', { reason }), action);
        expect(m, reason).not.toMatch(/Not allowed: you may have been logged out|Something went wrong|[–—]/u);
        seen.add(m);
      }
    }
    expect(seen.size).toBe(reasons.length);
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'near_key_unknown' }), 'near')).toMatch(/doesn’t exist on testnet yet.*creates the account first/u);
    expect(plainMessage(new HanaError('api_unavailable', 'x', { reason: 'near_rpc_unavailable' }), 'sign')).toBe('Journear couldn’t reach NEAR testnet to check this request. Try again in a minute.');
    // The page's own reads.
    expect(plainMessage({ code: 'near_page_rpc_failed', message: 'x' }, 'near')).toMatch(/couldn’t read NEAR testnet/u);
    expect(plainMessage({ code: 'near_account_pending', message: 'x' }, 'near')).toMatch(/still creating your NEAR account/u);
    expect(plainMessage({ code: 'near_send_failed', message: 'x' }, 'sign')).toMatch(/gasless write/u);
    expect(plainMessage({ code: 'near_nonce_wait', message: 'x' }, 'near')).toMatch(/needs a new block/u);
    expect(plainMessage(new HanaError('api_unavailable', 'x', { reason: 'near_rpc_single_provider' }), 'near')).toMatch(/only one NEAR provider/u);
  });

  it("maps the relayer's refusals (relay, activate) by data.reason, with a default for codes it doesn't know", () => {
    const relayer = (code: string | number, status: number, reason?: string) => new HanaError(code as never, 'x', { status, ...(reason ? { reason } : {}) });
    expect(plainMessage(relayer(4100, 409, 'near_account_unrecorded'), 'near')).toMatch(/still setting up your NEAR account/u);
    // D788: the API never sends `near_account_unknown` (an early draft's code): no text of its own, the default's.
    expect(plainMessage(relayer(4100, 409, 'near_account_unknown'), 'near')).toMatch(/^Journear’s relayer refused this request \(near_account_unknown\)\. /u);
    expect(plainMessage(relayer('rate_limited', 429, 'app_budget_exhausted'), 'near')).toMatch(/used up today’s free NEAR relays/u);
    expect(plainMessage(new HanaError(4100, 'Guestbook: text is longer than 200 characters after trimming\u202E', { status: 422, reason: 'contract_rejected' }), 'near')).toBe('The guestbook contract refused the message: Guestbook: text is longer than 200 characters after trimming\uFFFD. Nothing was stored.');
    expect(plainMessage(relayer('api_unavailable', 504, 'timeout'), 'near')).toMatch(/may still land/u);
    expect(plainMessage(relayer(4100, 403, 'receiver_not_allowed'), 'near')).toMatch(/only for calls to the demo guestbook/u);
    expect(plainMessage(relayer('api_unavailable', 503, 'relay_budget_exhausted'), 'near')).toBe('The demo’s free NEAR transactions are used up for today. Try again tomorrow (UTC).');
    expect(plainMessage(relayer(4100, 400, 'something_new'), 'near')).toMatch(/^Journear’s relayer refused this request \(something_new\)\. /u);
    expect(plainMessage(relayer(4100, 400), 'near')).toMatch(/^Journear’s relayer refused this request\. /u);
    expect(plainMessage(relayer('api_unavailable', 502, 'whatever'), 'near')).toBe('Journear’s relayer is unavailable right now. Try again in a minute. (whatever)');
    expect(plainMessage(relayer('rate_limited', 429, 'rate_limited'), 'near')).toMatch(/Too many guestbook writes/u);
    // Not from the relayer (no HTTP status): the usual texts.
    expect(plainMessage(new HanaError(4100, 'x'), 'near')).toBe('Not allowed: you may have been logged out. Log in and try again.');
    expect(plainMessage(new HanaError('api_unavailable', 'x'), 'near')).toBe('Could not reach Journear’s service. Check your connection and try again.');
    expect(plainMessage(new HanaError(4001, 'x'), 'near')).toBe('Rejected in the Journear window: nothing was signed.');
    // The same reason outside the card is not the relayer's.
    expect(plainMessage(relayer(4100, 403, 'receiver_not_allowed'), 'sign')).toBe('Not allowed: you may have been logged out. Log in and try again.');
  });

  it('D788: relayTransaction is the SDK’s data.transactionHash, only in base58’s shape', () => {
    const TX = '4uQeVj5tqViQh7yWWV8TMVXnHuqKF1s5Dw7HPfRQRZtx';
    expect(relayTransaction(new HanaError('api_unavailable', 'x', { status: 504, reason: 'timeout', transactionHash: TX }))).toBe(TX);
    expect(relayTransaction(new HanaError('api_unavailable', 'x', { status: 504, reason: 'timeout' }))).toBeNull();
    for (const bad of ['', 'x', '0'.repeat(44), '1'.repeat(45), `${TX}"><img src=x>`, `javascript:${TX}`, `${TX}/../../evil`, { hash: TX }, [TX], 44]) {
      expect(relayTransaction(new HanaError('api_unavailable', 'x', { transactionHash: bad })), JSON.stringify(bad)).toBeNull();
    }
    expect(relayTransaction(null)).toBeNull();
    expect(relayTransaction('timeout')).toBeNull();
    expect(relayTransaction({ data: null })).toBeNull();
  });

  it('turns a network failure into a network message, and anything else into a report hint with its code', () => {
    expect(plainMessage(new TypeError('Failed to fetch'), 'sign')).toBe('Network error. Check your connection and try again.');
    expect(plainMessage(new TypeError('Load failed'), 'login')).toBe('Network error. Check your connection and try again.');
    expect(plainMessage(new HanaError(-32603, 'boom'), 'sign')).toMatch(/Something went wrong \(-32603\).*Copy diagnostics/u);
    expect(plainMessage(new Error('denied'), 'copy')).toMatch(/Could not copy/u);
  });
});
