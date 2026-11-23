import { jargonIn } from '@hana-id/brand/plain-words';
import { HanaError, NEAR_RELAY_REASON_NAMES, ProviderRpcError, userMessageFor } from '@hana-id/web';
import { describe, expect, it } from 'vitest';
import { SIGNED_OUT_MESSAGE, activationFailure, errorInfo, isSignedOut, plainMessage, relayTransaction } from '../src/errors.ts';

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
    // D881: a sign-in still waiting to join another wallet (D864): a plain, true sentence, not "Something went wrong".
    expect(plainMessage(new HanaError('link_pending', 'x', { effectiveAtMs: 1 }), 'login')).toBe('This sign-in is waiting to be linked to a wallet, so it can’t open one yet. The Journear sign-in window says what to do.');
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
    expect(plainMessage(new ProviderRpcError(4001, 'x'), 'sign')).toBe('Rejected in the Journear Passport window: nothing was signed.');
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'share_not_fresh' }), 'revoke')).toMatch(/within 5 minutes/u);
    expect(plainMessage(new HanaError('rate_limited', 'x'), 'export')).toMatch(/exports/u);
  });

  it('D695: a 4900 with reason signed_out is a sign-out (log in again, no reload); a 4900 without it is a lost vault', () => {
    const signedOut = 'You were signed out on this device (from Passport Home, another tab or another device). Sign in again.';
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
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'near_key_unknown' }), 'near')).toBe('Your NEAR account isn’t set up yet, so nothing was signed. Click “Write to the guestbook (no NEAR needed)” again: the demo sets up your account first.');
    expect(plainMessage(new HanaError('api_unavailable', 'x', { reason: 'near_rpc_unavailable' }), 'sign')).toBe('Journear Passport couldn’t reach NEAR’s test network to check this request, so nothing was signed. Try again in a minute.');
    // The page's own reads.
    expect(plainMessage({ code: 'near_page_rpc_failed', message: 'x' }, 'near')).toBe('This page couldn’t reach NEAR’s test network. Check your connection and try again.');
    // D889: in "Sign a transaction" the same failure can follow the send: check first.
    // D889: a read before the window says only that; the send has its own codes (near.ts sendTx).
    expect(plainMessage({ code: 'near_page_rpc_failed', message: 'x' }, 'sign')).toBe('This page couldn’t reach NEAR’s test network. Check your connection and try again.');
    expect(plainMessage({ code: 'near_account_pending', message: 'x' }, 'near')).toBe('Journear is still creating your NEAR account. Wait a few seconds and try again.');
    expect(plainMessage({ code: 'near_send_failed', message: 'x' }, 'sign')).toBe('NEAR’s test network refused this transaction, or it failed there: it didn’t go through. Check the guestbook list, then use “Write to the guestbook (no NEAR needed)” if your message isn’t there.');
    expect(plainMessage({ code: 'near_send_unconfirmed', message: 'x' }, 'sign')).toBe('NEAR’s test network didn’t confirm this transaction, so it may or may not have gone through. Check the guestbook list before you try again.');
    expect(plainMessage({ code: 'near_nonce_wait', message: 'x' }, 'near')).toBe('NEAR’s test network isn’t ready for this request yet, so nothing was signed. Wait a few seconds and try again.');
    expect(plainMessage(new HanaError('api_unavailable', 'x', { reason: 'near_rpc_single_provider' }), 'near')).toMatch(/^This test version of Journear Passport isn’t set up to check this request yet, so nothing was signed\./u);
  });

  it("maps the relayer's refusals (relay, activate) by data.reason, with a default for codes it doesn't know", () => {
    const relayer = (code: string | number, status: number, reason?: string) => new HanaError(code as never, 'x', { status, ...(reason ? { reason } : {}) });
    expect(plainMessage(relayer(4100, 409, 'near_account_unrecorded'), 'near')).toMatch(/still setting up your NEAR account/u);
    // D788: the API never sends `near_account_unknown` (an early draft's code): no text of its own, the default's.
    expect(plainMessage(relayer(4100, 409, 'near_account_unknown'), 'near')).toMatch(/^Journear refused this request \(near_account_unknown\)\. /u);
    expect(plainMessage(relayer('rate_limited', 429, 'app_budget_exhausted'), 'near')).toBe('The demo app has used up today’s free NEAR transactions. Nothing was sent. Try again tomorrow (UTC).');
    expect(plainMessage(new HanaError(4100, 'Guestbook: text is longer than 200 characters after trimming\u202E', { status: 422, reason: 'contract_rejected' }), 'near')).toBe('The guestbook refused the message: Guestbook: text is longer than 200 characters after trimming\uFFFD. Nothing was stored.');
    expect(plainMessage(relayer('api_unavailable', 504, 'timeout'), 'near')).toBe('NEAR’s test network hasn’t confirmed your message yet: it may still arrive. Click Refresh on the guestbook list in a moment to see, before you try again.');
    expect(plainMessage(relayer(4100, 403, 'receiver_not_allowed'), 'near')).toBe('Journear isn’t set up to pay for this guestbook, so it refused this request. Nothing was sent. If it keeps happening, use “Copy diagnostics” and send it to the Journear team.');
    expect(plainMessage(relayer('api_unavailable', 503, 'relay_budget_exhausted'), 'near')).toBe('The demo’s free NEAR transactions are used up for today. Nothing was sent. Try again tomorrow (UTC).');
    // D881: no "relayer" or "environment" in what only a tester on a misconfigured test version sees.
    expect(plainMessage(relayer('api_unavailable', 503, 'relayer_unconfigured'), 'near')).toBe('The demo’s free NEAR transactions aren’t set up on this test version yet. Nothing was sent. If it keeps happening, use “Copy diagnostics” and send it to the Journear team.');
    expect(plainMessage(relayer(4100, 400, 'something_new'), 'near')).toMatch(/^Journear refused this request \(something_new\)\. /u);
    expect(plainMessage(relayer(4100, 400), 'near')).toMatch(/^Journear refused this request\. /u);
    // An unknown 5xx may follow a send: check first (D889).
    expect(plainMessage(relayer('api_unavailable', 502, 'whatever'), 'near')).toBe('Something went wrong while Journear was sending this. Check the guestbook list for your message before you try again. (whatever)');
    expect(plainMessage(relayer('api_unavailable', 502), 'near')).toBe('Journear didn’t answer properly, so it can’t tell whether this was sent. Check the guestbook list for your message before you try again.');
    expect(plainMessage(relayer('rate_limited', 429, 'rate_limited'), 'near')).toMatch(/Too many guestbook writes/u);
    // Not from the relayer (no HTTP status): the usual texts.
    expect(plainMessage(new HanaError(4100, 'x'), 'near')).toBe('Not allowed: you may have been signed out. Sign in and try again.');
    // D889: no answer at all in the write (the SDK's fetch failed): the relay may have gone out, so check first.
    expect(plainMessage(new HanaError('api_unavailable', 'x'), 'near')).toBe('Couldn’t reach Journear, so this may or may not have been sent. Check your connection, then check the guestbook list for your message before you try again.');
    expect(plainMessage(new HanaError('api_unavailable', 'x'), 'sign')).toBe('Could not reach Journear’s service. Check your connection and try again.');
    expect(plainMessage(new HanaError(4001, 'x'), 'near')).toBe('Rejected in the Journear Passport window: nothing was signed.');
    // The same reason outside the card is not the relayer's.
    expect(plainMessage(relayer(4100, 403, 'receiver_not_allowed'), 'sign')).toBe('Not allowed: you may have been signed out. Sign in and try again.');
  });

  // D889: the NEAR card's sentences in plain words, the SDK's check-first rule, and where they match the SDK's own.
  const relay = (reason: string) => {
    // The SDK's mapping of the API's answer: 429 rate_limited, 5xx api_unavailable, 4xx 4100 (client/near.ts).
    const status = /timeout/u.test(reason) ? 504 : /unavailable|busy|unconfigured|near_error|near_rejected/u.test(reason) ? 503 : reason.endsWith('budget_exhausted') ? 429 : 400;
    const code = status === 429 ? 'rate_limited' : status >= 500 ? 'api_unavailable' : 4100;
    return new HanaError(code as never, 'x', { status, reason });
  };
  const VAULT = ['near_key_unknown', 'near_block_unknown', 'near_network_mismatch', 'near_delegate_nonce_used', 'near_delegate_nonce_too_large', 'near_delegate_expiry', 'near_delegate_nonce_stale', 'near_relayed_delegate', 'near_delegate_test_app_action', 'near_delegate_test_app_receiver'];
  const RELAY = [...new Set([...NEAR_RELAY_REASON_NAMES, 'mainnet_not_allowed', 'not_enough_balance'])].filter((r) => r !== 'rate_limited');
  const OWN = ['near_page_rpc_failed', 'near_account_pending', 'near_nonce_wait', 'near_send_failed', 'near_send_unconfirmed', 'near_activation_failed', 'near_activation_pending'];

  it('D889: every NEAR card sentence is plain (no relayer, gas, nonce, testnet, contract, …) and has its own words', () => {
    const texts = new Map<string, string>();
    for (const r of VAULT) texts.set(`vault ${r}`, plainMessage(new HanaError(4100, 'x', { reason: r }), 'near'));
    for (const r of RELAY) texts.set(`relay ${r}`, plainMessage(relay(r), 'near'));
    for (const c of OWN) for (const a of ['near', 'sign'] as const) texts.set(`own ${c} ${a}`, plainMessage({ code: c, message: 'x' }, a));
    for (const r of ['near_rpc_unavailable', 'near_rpc_single_provider']) texts.set(`check ${r}`, plainMessage(new HanaError('api_unavailable', 'x', { reason: r }), 'near'));
    texts.set('relay default 4100', plainMessage(new HanaError(4100, 'x', { status: 400 }), 'near'));
    texts.set('relay default 5xx', plainMessage(new HanaError('api_unavailable', 'x', { status: 502 }), 'near'));
    texts.set('relay rate_limited', plainMessage(new HanaError('rate_limited', 'x', { status: 429, reason: 'rate_limited' }), 'near'));
    for (const [where, t] of texts) {
      expect(jargonIn(t), `${where}: ${t}`).toEqual([]);
      expect(t, where).not.toMatch(/relay|testnet|\bgas\b|nonce|\bRPC\b|delegate|[–—]/iu);
    }
    // One sentence per condition, so support can tell them apart.
    const relayTexts = RELAY.map((r) => texts.get(`relay ${r}`)!);
    expect(new Set(relayTexts).size).toBe(relayTexts.length);
    const vaultTexts = VAULT.map((r) => texts.get(`vault ${r}`)!);
    expect(new Set(vaultTexts).size).toBe(vaultTexts.length);
  });

  it('D889: a relay answer that may follow a send says to check the guestbook list first (the SDK’s rule); a refusal before any send says nothing was sent', () => {
    // apps/api: certainly not sent are the checks before relayThrough and the key's `notSent` answers; the page can't
    // see `notSent`, so a code the key can also send after its broadcast is "check first".
    const mayFollowSend = ['delegate_nonce_used', 'already_relayed', 'timeout', 'near_error', 'near_unavailable', 'relayer_busy', 'relayer_unavailable', 'method_not_allowed'];
    for (const r of mayFollowSend) expect(plainMessage(relay(r), 'near'), r).toMatch(/Check the guestbook list|Click Refresh on the guestbook list/u);
    const beforeSend = ['receiver_not_allowed', 'action_not_allowed', 'deposit_not_allowed', 'sender_not_implicit', 'bad_delegate', 'bad_delegate_signature', 'bad_request', 'mainnet_not_allowed', 'account_not_activated', 'access_key_missing', 'delegate_nonce_too_large', 'delegate_expired', 'block_height_too_far', 'app_budget_exhausted', 'rate_limiter_unavailable'];
    for (const r of [...beforeSend, 'gas_too_high', 'relay_budget_exhausted', 'relayer_unconfigured']) expect(plainMessage(relay(r), 'near'), r).toMatch(/[Nn]othing was sent/u);
    // NEAR turned the request down: the guestbook call never ran (the API's NOT_EXECUTED; the sender's receipt).
    for (const r of ['near_rejected', 'delegate_rejected']) expect(plainMessage(relay(r), 'near'), r).toMatch(/so your message wasn’t stored\. Try again\.$/u);
    // Where the Journear team has to act, the diagnostics sentence: never a bare "Tell the Journear team".
    for (const r of RELAY) expect(plainMessage(relay(r), 'near'), r).not.toMatch(/Tell the Journear team/u);
    // "Journear Passport" checks and signs, "Journear" pays and sends: a sentence never names both for one thing.
    expect(plainMessage(relay('access_key_missing'), 'near')).toBe('Your NEAR account no longer holds the key Journear Passport made for it (was it changed in another wallet?), so it can’t be used here. Nothing was sent. If it keeps happening, use “Copy diagnostics” and send it to the Journear team.');
    // delegate_nonce_used is refused before sending (the vault's, before signing): another request took its place.
    expect(plainMessage(relay('delegate_nonce_used'), 'near')).toBe('Another request from your account just used this one’s place, perhaps from another tab, so this one wasn’t sent. Check the guestbook list for your message before you try again.');
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'near_delegate_nonce_used' }), 'near')).toBe('Another request from your account just used this one’s place, perhaps from another tab, so this one wasn’t signed. Check the guestbook list for your message before you try again.');
    for (const r of [...beforeSend, 'near_account_unrecorded', 'directory_unavailable', 'gas_too_high', 'relay_budget_exhausted', 'relayer_unconfigured']) expect(plainMessage(relay(r), 'near'), r).not.toMatch(/may or may not|can’t tell/u);
    // The vault's refusals come before its window: nothing was signed.
    for (const r of VAULT) expect(plainMessage(new HanaError(4100, 'x', { reason: r }), 'near'), r).toMatch(/[Nn]othing (new )?was signed|wasn’t signed/u);
  });

  it('D889: an activation failure (before any approval) says what is true of the account, keeping the API’s reason for diagnostics', () => {
    const failed = 'Journear couldn’t finish setting up your NEAR account. Nothing was signed. Try again in a minute.';
    for (const r of ['relayer_busy', 'relayer_unavailable', 'near_unavailable', 'near_error', 'near_rejected', 'method_not_allowed']) {
      const shown = activationFailure(relay(r));
      expect(plainMessage(shown, 'near'), r).toBe(failed);
      expect(errorInfo(shown), r).toMatchObject({ code: 'near_activation_failed', reason: r });
    }
    // No answer at all, or a 5xx the table doesn't know.
    expect(plainMessage(activationFailure(new HanaError('api_unavailable', 'x')), 'near')).toBe(failed);
    expect(plainMessage(activationFailure(new HanaError('api_unavailable', 'x', { status: 502, reason: 'whatever' })), 'near')).toBe(failed);
    // A timeout: still being set up.
    expect(plainMessage(activationFailure(relay('timeout')), 'near')).toBe('Your NEAR account is still being set up. Wait a few seconds and try again.');
    // A sentence already true of an activation stays as it is (the same error).
    for (const r of ['near_account_unrecorded', 'directory_unavailable', 'app_budget_exhausted', 'relayer_unconfigured', 'bad_request', 'mainnet_not_allowed']) {
      const e = relay(r);
      expect(activationFailure(e), r).toBe(e);
    }
  });

  it('D889: where the demo takes the SDK’s sentence, it is the SDK’s word for word', () => {
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'near_block_unknown' }), 'near')).toBe(userMessageFor(4100, { reason: 'near_block_unknown' }));
    expect(plainMessage(new HanaError(4100, 'x', { reason: 'near_delegate_nonce_too_large' }), 'near')).toBe(userMessageFor(4100, { reason: 'near_delegate_nonce_too_large' }));
    expect(plainMessage(relay('delegate_nonce_too_large'), 'near')).toBe(userMessageFor(4100, { reason: 'delegate_nonce_too_large' }, 'near_relay'));
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
