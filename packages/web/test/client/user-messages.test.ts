// D861: `userMessage`, the plain sentence for the user beside the developer's `message`: one for every code the SDK can
// reject with, closer ones for known reasons, worked out from the code and `data.reason` only (never from `message` or
// any other text that came over the port), and plain by D853's word list.
import { ErrorCode, STRING_ERROR_CODES } from '@hana-id/core';
import { jargonIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import { HanaError, ProviderRpcError, RpcCode, toProviderRpcError } from '../../src/client/errors.ts';
import { DEFAULT_USER_MESSAGE, userMessageFor } from '../../src/client/user-messages.ts';
import { userMessageFor as exported } from '../../src/index.ts';

const ALL_CODES = [...Object.values(ErrorCode), ...Object.values(RpcCode), ...STRING_ERROR_CODES];
const REASONS = ['mainnet_not_allowed', 'raw_not_allowed_for_test_apps', 'too_many_pending', 'invalid_request', 'raw_sign_off', 'raw_reserved_domain', 'near_network_mismatch', 'near_block_unknown', 'near_relayed_delegate', 'signed_out', 'pending', 'webcrypto_unsupported', 'webcrypto_failed', 'access_denied'];

describe('userMessage (D861)', () => {
  it('every code the SDK can reject with has its own sentence', () => {
    for (const code of ALL_CODES) expect(userMessageFor(code, undefined), String(code)).not.toBe(DEFAULT_USER_MESSAGE);
    expect(userMessageFor('not_a_code', undefined)).toBe(DEFAULT_USER_MESSAGE);
    expect(exported).toBe(userMessageFor);
  });

  it('is plain: no chain or engineering word, one or a few short sentences ending in a full stop', () => {
    const all = [...ALL_CODES.map((c) => userMessageFor(c, undefined)), ...ALL_CODES.flatMap((c) => REASONS.map((r) => userMessageFor(c, { reason: r, stage: r, error: r }))), DEFAULT_USER_MESSAGE];
    for (const m of new Set(all)) {
      expect(jargonIn(m), m).toEqual([]);
      expect(m, m).toMatch(/\.$/u);
      for (const sentence of m.split(/(?<=\.) /u)) expect(sentence.split(' ').length, m).toBeLessThanOrEqual(22);
      expect(m).not.toMatch(/Hana|\(|_/u);
    }
  });

  it('a known reason picks a closer sentence; an unknown one, or one of another shape, keeps the code’s', () => {
    expect(userMessageFor(4001, undefined)).toBe('You rejected this in Journear Passport, or closed it. Nothing was approved.');
    expect(userMessageFor(4100, { reason: 'mainnet_not_allowed', chain: 'evm', chainId: 8453 })).toBe('This app is a test version, so Journear Passport lets it use only test networks. Nothing was signed.');
    expect(userMessageFor(4900, { reason: 'signed_out' })).toBe('You were signed out of Journear Passport on this device. Sign in again.');
    expect(userMessageFor('login_timeout', { stage: 'pending' })).toBe('The sign-in wasn’t finished in time, so it stopped. Sign in again when you’re ready.');
    expect(userMessageFor('google_error', { error: 'access_denied' })).toBe('You cancelled the Google sign-in. Nothing was changed.');
    expect(userMessageFor(4100, { reason: 'something_new' })).toBe(userMessageFor(4100, undefined));
    expect(userMessageFor(4100, { reason: 'Mainnet_Not_Allowed' })).toBe(userMessageFor(4100, undefined));
    expect(userMessageFor(4100, ['mainnet_not_allowed'])).toBe(userMessageFor(4100, undefined));
    expect(userMessageFor('ckd_failed', undefined)).toBe('We couldn’t open your wallet. Try again.');
  });

  it('on a HanaError: from code and data only, never from the message; a getter, so the error’s fields are as before', () => {
    const e = HanaError.from({ code: 4001, message: 'Click here: evil.example', data: { reason: 'evil text' } });
    expect(e.message).toBe('Click here: evil.example');
    expect(e.userMessage).toBe('You rejected this in Journear Passport, or closed it. Nothing was approved.');
    expect(Object.keys(e)).not.toContain('userMessage');
    expect(e).toEqual(new HanaError(4001, 'Click here: evil.example', { reason: 'evil text' }));
    expect(new HanaError('vault_unavailable', 'x', { reason: 'csp_frame_src' }).userMessage).toBe('Journear Passport couldn’t load on this page. Reload the page and try again.');
  });

  it('on the EIP-1193 provider’s errors: from the Journear Passport code it carries', () => {
    const p = toProviderRpcError(new HanaError('login_cancelled', 'The sign-in was cancelled'));
    expect(p.code).toBe(4001);
    expect(p.userMessage).toBe('The sign-in was cancelled. Nothing was changed.');
    expect(toProviderRpcError(new HanaError('rate_limited', 'x')).userMessage).toBe('Too many attempts. Wait a minute and try again.');
    expect(toProviderRpcError(new HanaError(4100, 'x', { reason: 'mainnet_not_allowed' })).userMessage).toMatch(/^This app is a test version/u);
    expect(new ProviderRpcError(4200, 'Unsupported method').userMessage).toBe('Journear Passport can’t do this kind of request. Nothing was signed.');
    expect(Object.keys(p)).not.toContain('userMessage');
  });
});
