// D861: `userMessage`, the plain sentence for the user beside the developer's `message`: one for every code the SDK can
// reject with, closer ones for known reasons, worked out from the code and `data.reason` only (never from `message` or
// any other text that came over the port), and plain by D853's word list.
import { ErrorCode, STRING_ERROR_CODES } from '@hana-id/core';
import { jargonIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import { HanaError, ProviderRpcError, RpcCode, toProviderRpcError } from '../../src/client/errors.ts';
import { readFileSync } from 'node:fs';
import { DEFAULT_USER_MESSAGE, NEAR_RELAY_REASON_NAMES, NEAR_RELAY_REASONS, SPONSOR_REASON_NAMES, SPONSOR_REASONS, SPONSORSHIP_REASON_NAMES, userMessageFor } from '../../src/client/user-messages.ts';
import { HanaSponsorError } from '../../src/client/evm-sponsor.ts';
import { SPONSOR_TEXT } from '../../src/vault/evm-sponsor.ts';
import * as sdk from '../../src/index.ts';
import { userMessageFor as exported } from '../../src/index.ts';

/**
 * Every `data.reason` a sponsored action's error can carry, read from the vault's own source (vault/evm-sponsor.ts), with
 * the `SPONSOR_TEXT` sentence the vault pairs it with: its refusals (`refusal(SPONSOR_TEXT.x, 'reason')`, `{ reason }`
 * beside a SPONSOR_TEXT), and the API codes `apiMessage` maps (`case 'code': … return SPONSOR_TEXT.x`). A new reason or a
 * reworded sentence there fails here until `SPONSOR_REASONS` follows.
 */
const SPONSOR_SOURCE = readFileSync(new URL('../../src/vault/evm-sponsor.ts', import.meta.url), 'utf8');
function sponsorPairs(): [reason: string, textKey: string][] {
  const pairs: [string, string][] = [];
  for (const m of SPONSOR_SOURCE.matchAll(/refusal\(SPONSOR_TEXT\.(\w+), '([a-z_]+)'/gu)) pairs.push([m[2]!, m[1]!]);
  for (const m of SPONSOR_SOURCE.matchAll(/new VaultError\([^,]+, SPONSOR_TEXT\.(\w+), \{ reason: '([a-z_]+)'/gu)) pairs.push([m[2]!, m[1]!]);
  const api = SPONSOR_SOURCE.slice(SPONSOR_SOURCE.indexOf('function apiMessage'), SPONSOR_SOURCE.indexOf('export function sponsorApiError'));
  let cases: string[] = [];
  for (const line of api.split('\n')) {
    const c = /case '([a-z_]+)':/u.exec(line);
    if (c) cases.push(c[1]!);
    const r = /return .*?SPONSOR_TEXT\.(\w+)/u.exec(line);
    if (r && cases.length > 0) {
      // reverted / not_executed: the vault picks failed or failedAfterSetup by the batch; the SDK can't tell, so it says the one true for both.
      for (const k of cases) pairs.push([k, line.includes('failedAfterSetup') ? 'failedAfterSetup' : r[1]!]);
      cases = [];
    }
  }
  return pairs;
}
const SPONSOR_REASON_LIST = [...new Set(sponsorPairs().map(([r]) => r))];

const ALL_CODES = [...Object.values(ErrorCode), ...Object.values(RpcCode), ...STRING_ERROR_CODES];
/** D871's closer sentences: the vault's other NEAR refusals, the sandbox mainnet demo's, the app's setup, email sharing, a stopped sign-in. */
const D871_REASONS = ['near_key_unknown', 'near_delegate_nonce_used', 'near_delegate_nonce_stale', 'near_delegate_nonce_too_large', 'near_delegate_expiry', 'near_delegate_test_app_action', 'near_delegate_test_app_receiver', 'near_rpc_unavailable', 'near_rpc_single_provider', 'mainnet_demo_over_cap', 'mainnet_demo_unknown_call', 'mainnet_demo_wrong_destination', 'mainnet_demo_unpriced', 'mainnet_demo_prices_stale', 'mainnet_demo_unconfirmed', 'missing_key', 'unknown_app', 'scope_conflict', 'off', 'no_address', 'popup_closed', 'email_consent_declined', 'google_account_mismatch'];
const REASONS = [...SPONSOR_REASON_LIST, ...Object.keys(NEAR_RELAY_REASONS), ...D871_REASONS, 'mainnet_not_allowed', 'raw_not_allowed_for_test_apps', 'too_many_pending', 'invalid_request', 'raw_sign_off', 'raw_reserved_domain', 'near_network_mismatch', 'near_block_unknown', 'near_relayed_delegate', 'signed_out', 'pending', 'webcrypto_unsupported', 'webcrypto_failed', 'access_denied'];

describe('userMessage (D861)', () => {
  it('every code the SDK can reject with has its own sentence', () => {
    for (const code of ALL_CODES) expect(userMessageFor(code, undefined), String(code)).not.toBe(DEFAULT_USER_MESSAGE);
    expect(userMessageFor('not_a_code', undefined)).toBe(DEFAULT_USER_MESSAGE);
    expect(exported).toBe(userMessageFor);
  });

  it('is plain: no chain or engineering word, one or a few short sentences ending in a full stop', () => {
    const all = [
      ...ALL_CODES.map((c) => userMessageFor(c, undefined)),
      ...ALL_CODES.flatMap((c) => REASONS.flatMap((r) => ([undefined, 'near_relay', 'sponsored_action'] as const).map((src) => userMessageFor(c, { reason: r, stage: r, error: r }, src)))),
      ...Object.values(NEAR_RELAY_REASONS),
      DEFAULT_USER_MESSAGE,
    ];
    for (const m of new Set(all)) {
      expect(jargonIn(m), m).toEqual([]);
      expect(m, m).toMatch(/\.$/u);
      for (const sentence of m.split(/(?<=\.) /u)) expect(sentence.split(' ').length, m).toBeLessThanOrEqual(22);
      expect(m).not.toMatch(/Hana|\(|_/u);
    }
  });

  it('link_pending is true for the one who made the link and for the email’s holder who didn’t (D864), and for a waiting Google account (D881)', () => {
    expect(userMessageFor('link_pending', { effectiveAtMs: 1 })).toBe('This sign-in is waiting to be linked to a wallet, so it can’t open one yet. Sign in again and follow the steps in the Journear Passport window.');
  });

  it('login_cancelled when the user chose to remove this sign-in from a wallet (D865): true before and after the removal is confirmed', () => {
    expect(userMessageFor('login_cancelled', { reason: 'link_remove' })).toBe('You chose to remove this sign-in from that wallet. Finish it in the Journear Passport window. Then sign in again when you’re ready.');
    // D871: the user's own close, and a new Google user who didn't share the email address.
    expect(userMessageFor('login_cancelled', { reason: 'popup_closed' })).toBe('You closed the Journear Passport window, so nothing changed. Sign in again when you’re ready.');
    expect(userMessageFor('login_cancelled', { reason: 'email_consent_declined' })).toBe('You didn’t share your Google email address, so no wallet was opened. Sign in with email instead, or try Google again.');
    expect(userMessageFor('login_cancelled', { reason: 'google_account_mismatch' })).toBe('You picked a different Google account, so nothing changed. Try again with the same account, or sign in with email instead.');
    expect(userMessageFor('login_cancelled', undefined)).toBe('The sign-in was cancelled. Nothing was changed.');
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
    expect(SPONSOR_REASON_LIST.length).toBeGreaterThan(30);
    for (const [r, key] of sponsorPairs()) {
      expect((SPONSOR_REASONS as Record<string, string>)[r], r).toBe((SPONSOR_TEXT as Record<string, string>)[key]);
    }
    for (const r of SPONSOR_REASON_LIST) {
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

  it('a HanaSponsorError carries userMessage like any HanaError', () => {
    const e = new HanaSponsorError('api_unavailable', 'Journear couldn’t tell whether your action went through. Check before you try again.', { reason: 'unknown_outcome', status: 504 });
    expect(e.userMessage).toBe(SPONSOR_TEXT.unknownOutcome);
    expect(new HanaSponsorError(4001, 'x').userMessage).toBe('You rejected this in Journear Passport, or closed it. Nothing was approved.');
    expect(new HanaSponsorError(4100, 'x', { reason: 'chain_not_sponsored', chainId: 1 }).userMessage).toBe(SPONSOR_TEXT.notOffered);
    expect(userMessageFor(4100, { reason: 'invalid_request' })).toMatch(/nothing was signed or sent/u);
  });
});

describe('userMessage by source, and the closer sentences of D871', () => {
  const SHARED = Object.keys(NEAR_RELAY_REASONS).filter((r) => Object.hasOwn(SPONSOR_REASONS, r));
  const near = NEAR_RELAY_REASONS as Record<string, string>;
  const sponsor = SPONSOR_REASONS as Record<string, string>;

  it('exports the reason NAMES, frozen, and no sentence table: sentences come only through userMessage and userMessageFor', () => {
    expect(sdk.SPONSOR_REASON_NAMES).toEqual(Object.keys(SPONSOR_REASONS));
    expect(sdk.NEAR_RELAY_REASON_NAMES).toEqual(Object.keys(NEAR_RELAY_REASONS));
    expect(sdk.SPONSORSHIP_REASON_NAMES).toEqual(['chain_not_enabled', 'app_not_sponsored', 'paused', 'budget_exhausted', 'not_available']);
    for (const list of [SPONSOR_REASON_NAMES, NEAR_RELAY_REASON_NAMES, SPONSORSHIP_REASON_NAMES]) expect(Object.isFrozen(list)).toBe(true);
    expect(Object.keys(sdk)).not.toContain('SPONSOR_REASONS');
    expect(Object.keys(sdk)).not.toContain('NEAR_RELAY_REASONS');
  });

  it('a NEAR relay result that may follow its send says to check first (from the API source: results without notSent)', () => {
    // The relay's RelayResult literals in the API (its handler and the relayer key object): `{ ok: false, status, code,
    // … }`. One without an unconditional `notSent: true` may come after the transaction went out.
    const sources = ['../../../../apps/api/src/relayer-key.ts', '../../../../apps/api/src/near/relay.ts'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'));
    const mayFollow = new Set<string>();
    const seen = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/\{ ok: false, status: \d+, code: '([a-z_]+)'([^\n]*)/gu)) {
        seen.add(m[1]!);
        if (!/notSent: true(?! as const)/u.test(m[2]!)) mayFollow.add(m[1]!);
      }
    }
    expect([...mayFollow].sort()).toEqual(expect.arrayContaining(['contract_rejected', 'near_error', 'near_rejected', 'near_unavailable', 'relayer_busy', 'relayer_unavailable', 'timeout']));
    for (const code of seen) expect(Object.hasOwn(NEAR_RELAY_REASONS, code), code).toBe(true);
    for (const code of mayFollow) {
      const text = userMessageFor('api_unavailable', { reason: code }, 'near_relay');
      // NEAR refused the transaction itself: an invalid transaction is never included, so it never ran.
      if (code === 'near_rejected') expect(text).toBe('The network refused this request, so it didn’t go through. Try again.');
      else expect(text, code).toMatch(/\bcheck\b/iu);
    }
  });

  it('a reason name the NEAR relay shares with a sponsored action reads by the error, not by the name', () => {
    expect(SHARED).toEqual(expect.arrayContaining(['gas_too_high', 'app_budget_exhausted', 'timeout', 'relayer_busy']));
    for (const r of SHARED) {
      for (const code of [4100, 'rate_limited', 'api_unavailable']) {
        // hana.near's refusals are plain HanaErrors; hana.evm's are HanaSponsorErrors, and so are the provider's for one.
        expect(new HanaError(code as 4100, 'x', { reason: r }).userMessage, `${code} ${r}`).toBe(near[r]);
        expect(new HanaSponsorError(code as 4100, 'x', { reason: r }).userMessage, `${code} ${r}`).toBe(sponsor[r]);
        expect(toProviderRpcError(new HanaSponsorError(code as 4100, 'x', { reason: r })).userMessage, `${code} ${r}`).toBe(sponsor[r]);
        // Without a source (a partner's own call, a provider error), the sponsored action's: the EVM side's names.
        expect(userMessageFor(code, { reason: r }), `${code} ${r}`).toBe(sponsor[r]);
        expect(userMessageFor(code, { reason: r }, 'near_relay'), `${code} ${r}`).toBe(near[r]);
      }
    }
    expect(new HanaError(4100, 'x', { reason: 'gas_too_high' }).userMessage).toBe('Journear doesn’t pay the fee for this kind of request. Nothing was sent.');
    expect(new HanaSponsorError(4100, 'x', { reason: 'gas_too_high' }).userMessage).toBe('This action is too big for free network fees.');
  });

  it('every NEAR relay reason has its own sentence, never the generic refusal', () => {
    const generic = userMessageFor(4100, undefined);
    for (const r of Object.keys(NEAR_RELAY_REASONS)) {
      for (const code of [4100, 'rate_limited', 'api_unavailable']) expect(new HanaError(code as 4100, 'x', { reason: r }).userMessage, `${code} ${r}`).toBe(near[r]);
      expect(near[r]).not.toBe(generic);
    }
    // Every code the API's NEAR relay answers with (apps/api/src/near/relay.ts) has a sentence, but the ones that keep
    // a code of their own and the two that are only logged.
    const relay = readFileSync(new URL('../../../../apps/api/src/near/relay.ts', import.meta.url), 'utf8');
    const answered = [...relay.matchAll(/(?:reject\(ctx, [\w.]+, |code: )'([a-z_]+)'/gu)].map((m) => m[1]!);
    for (const code of new Set(answered)) {
      if (['near_relay_budget_high', 'not_enough_balance', 'rate_limited'].includes(code)) continue;
      expect(userMessageFor(4100, { reason: code }, 'near_relay'), code).not.toBe(generic);
    }
  });

  it('the NEAR vault refusals, the sandbox mainnet demo, the app setup and email sharing have closer sentences', () => {
    const generic = userMessageFor(4100, undefined);
    for (const r of ['near_key_unknown', 'near_delegate_nonce_used', 'near_delegate_nonce_stale', 'near_delegate_nonce_too_large', 'near_delegate_expiry', 'near_delegate_test_app_action', 'near_delegate_test_app_receiver', 'mainnet_demo_over_cap', 'mainnet_demo_unknown_call', 'mainnet_demo_wrong_destination', 'mainnet_demo_unpriced', 'mainnet_demo_prices_stale', 'missing_key', 'unknown_app', 'scope_conflict']) {
      expect(userMessageFor(4100, { reason: r }), r).not.toBe(generic);
      expect(userMessageFor(4100, { reason: r }), r).not.toBe(DEFAULT_USER_MESSAGE);
    }
    for (const r of ['near_rpc_unavailable', 'near_rpc_single_provider', 'mainnet_demo_unconfirmed']) expect(userMessageFor('api_unavailable', { reason: r }), r).toMatch(/nothing was signed/u);
    expect(userMessageFor('email_sharing_unavailable', { reason: 'off' })).toBe('This app doesn’t ask for your email address. Nothing was shared.');
    expect(userMessageFor('email_sharing_unavailable', { reason: 'no_address' })).toMatch(/Sign in again/u);
    expect(userMessageFor('email_sharing_unavailable', { reason: 'unavailable' })).toBe(userMessageFor('email_sharing_unavailable', undefined));
  });

  it('invalid_request on a sponsored action reads as the vault says; elsewhere it keeps the approval queue’s sentence', () => {
    expect(new HanaSponsorError(4100, 'x', { reason: 'invalid_request' }).userMessage).toBe(SPONSOR_TEXT.notForThis);
    expect(new HanaError(4100, 'x', { reason: 'invalid_request' }).userMessage).toMatch(/nothing was signed or sent/u);
    // A test app's mainnet refusal keeps its own sentence on a sponsored action too (not a sponsor reason).
    expect(new HanaSponsorError(4100, 'x', { reason: 'mainnet_not_allowed' }).userMessage).toMatch(/^This app is a test version/u);
  });

  it('the source changes no field: equality and JSON as before', () => {
    const a = new HanaSponsorError(4100, 'x', { reason: 'timeout' });
    expect(Object.keys(a)).toEqual(Object.keys(new HanaError(4100, 'x', { reason: 'timeout' })));
    expect(JSON.stringify(toProviderRpcError(a))).toBe(JSON.stringify(new ProviderRpcError(4100, 'x', { reason: 'timeout' })));
  });
});
