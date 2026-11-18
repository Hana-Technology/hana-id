// D861: `userMessage`, the plain sentence for the user beside the developer's `message`: one for every code the SDK can
// reject with, closer ones for known reasons, worked out from the code and `data.reason` only (never from `message` or
// any other text that came over the port), and plain by D853's word list.
import { ErrorCode, STRING_ERROR_CODES } from '@hana-id/core';
import { jargonIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import { HanaError, ProviderRpcError, RpcCode, toProviderRpcError } from '../../src/client/errors.ts';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_USER_MESSAGE, SPONSOR_REASONS, userMessageFor } from '../../src/client/user-messages.ts';
import { userMessageFor as exported } from '../../src/index.ts';

/**
 * Every `data.reason` a sponsored action's error can carry (PR 76's vault/evm-sponsor.ts: its refusals' reasons, and the
 * API codes it passes on). Once that file is on this branch, the test also reads every reason it names, so a new one
 * fails here until it has a sentence.
 */
const SPONSOR_REASON_LIST = [
  'chain_not_sponsored', 'no_evm_account', 'invalid_request', 'target_not_allowed', 'delegated_elsewhere', 'budget_exhausted', 'gas_too_high', 'chain_not_enabled', 'app_not_sponsored', 'not_available',
  'clock_wrong', 'deadline_passed', 'bad_answer', 'unknown_outcome', 'api_unavailable', 'sponsor_in_flight',
  'reverted', 'not_executed', 'simulation_reverted', 'timeout', 'nonce_stale', 'authorization_nonce_stale', 'delegation_required', 'in_progress', 'account_unrecorded', 'app_budget_exhausted',
  'too_many_failures', 'rate_limited', 'call_not_sponsored', 'value_not_allowed', 'too_many_calls', 'deadline_out_of_range', 'session_ended',
];
const SPONSOR_SOURCE = new URL('../../src/vault/evm-sponsor.ts', import.meta.url);
function sponsorReasonsInSource(): string[] {
  if (!existsSync(SPONSOR_SOURCE)) return [];
  const src = readFileSync(SPONSOR_SOURCE, 'utf8');
  const found = [...src.matchAll(/refusal\([^,]+, '([a-z_]+)'|reason: '([a-z_]+)'|case '([a-z_]+)':/gu)].map((m) => m[1] ?? m[2] ?? m[3]!);
  return [...new Set(found)];
}

const ALL_CODES = [...Object.values(ErrorCode), ...Object.values(RpcCode), ...STRING_ERROR_CODES];
const REASONS = [...SPONSOR_REASON_LIST, 'mainnet_not_allowed', 'raw_not_allowed_for_test_apps', 'too_many_pending', 'invalid_request', 'raw_sign_off', 'raw_reserved_domain', 'near_network_mismatch', 'near_block_unknown', 'near_relayed_delegate', 'signed_out', 'pending', 'webcrypto_unsupported', 'webcrypto_failed', 'access_denied'];

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

  it('every sponsored action reason has its own sentence, the vault’s words, whatever code carries it', () => {
    for (const r of [...SPONSOR_REASON_LIST, ...sponsorReasonsInSource()]) {
      const own = r === 'invalid_request' ? userMessageFor(4100, { reason: r }) : SPONSOR_REASONS[r];
      expect(own, r).toBeDefined();
      for (const code of [4100, 'rate_limited', 'api_unavailable', 'session_ended', 'busy']) expect(userMessageFor(code, { reason: r }), `${code} ${r}`).not.toBe(DEFAULT_USER_MESSAGE);
    }
    expect(userMessageFor('api_unavailable', { reason: 'unknown_outcome' })).toBe('Journear couldn’t tell whether your action went through. Check before you try again.');
    expect(userMessageFor('api_unavailable', { reason: 'timeout', status: 504 })).toMatch(/Check again in a minute before you try again/u);
    expect(userMessageFor(4100, { reason: 'reverted', status: 422 })).toBe('The action didn’t go through. Your account’s one-time setup may still have been done. Nothing else changed.');
    expect(userMessageFor('busy', { reason: 'sponsor_in_flight' })).toBe('Your last action is still going through. Wait for it to finish, then try again.');
    // The per-code reasons come first: a test app's mainnet refusal keeps its own sentence.
    expect(userMessageFor(4100, { reason: 'mainnet_not_allowed' })).toMatch(/^This app is a test version/u);
  });

  it('never claims "nothing was signed" or "try again" without "check" where the outcome may be unknown', () => {
    expect(userMessageFor(4100, undefined)).not.toMatch(/Nothing was/u);
    for (const code of ['api_unavailable', -32603]) expect(userMessageFor(code, undefined), String(code)).toMatch(/check whether it went through before you try again/u);
    expect(userMessageFor('busy', undefined)).toBe('Journear Passport is finishing something else for this wallet. Wait a moment, then try again.');
    expect(userMessageFor('session_consumed', undefined)).toBe('This sign-in was already used, perhaps in another window. If that wasn’t you, start again and tell the app’s support.');
  });
});
