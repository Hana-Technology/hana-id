import { describe, expect, it } from 'vitest';
import { STORAGE_MESSAGE, pageError, plainMessage } from '../src/messages.ts';
import { hanaError } from './fakes.ts';

describe('plainMessage', () => {
  it('the stamps contract out of storage balance: one plain notice, from the relay or from NEAR', () => {
    const relayed = hanaError(4100, { status: 422, reason: 'contract_rejected' }, '{"ActionError":{"index":0,"kind":{"LackBalanceForState":{"account_id":"hana-id-stamps-dev1.testnet","amount":"1"}}}}');
    expect(plainMessage(relayed, 'collect')).toBe(STORAGE_MESSAGE);
    expect(plainMessage(pageError('stamps_contract_storage', 'x'), 'collect')).toBe(STORAGE_MESSAGE);
  });

  it('the contract’s ERR_* from the relay, from NEAR, and nothing raw otherwise', () => {
    expect(plainMessage(hanaError(4100, { status: 422, reason: 'contract_rejected' }, 'Smart contract panicked: ERR_ALREADY'), 'collect')).toBe('You already hold this stamp: each one can be collected once.');
    expect(plainMessage(pageError('stamps_contract_refused', 'ERR_TOO_SOON'), 'collect')).toMatch(/^Not yet/u);
    const raw = plainMessage(hanaError(4100, { status: 422, reason: 'contract_rejected' }, '<script>alert(1)</script> \u202E'), 'collect');
    expect(raw).toBe('The stamps contract refused this stamp. Nothing was stored.');
  });

  it('the relayer’s and the vault’s refusals, and the page’s own', () => {
    expect(plainMessage(hanaError(4100, { status: 403, reason: 'receiver_not_allowed' }), 'collect')).toMatch(/doesn’t pay for the stamps contract/u);
    expect(plainMessage(hanaError('rate_limited', { status: 429, reason: 'app_budget_exhausted' }), 'collect')).toMatch(/used up today’s free NEAR transactions/u);
    expect(plainMessage(hanaError(4100, { status: 400, reason: 'something_new' }), 'collect')).toBe('Journear’s relayer refused this request (something_new). If it keeps happening, tell the Journear team.');
    expect(plainMessage(hanaError(4100, { reason: 'near_key_unknown' }), 'collect')).toMatch(/doesn’t exist on testnet yet/u);
    expect(plainMessage(pageError('near_page_rpc_failed', 'x'), 'read')).toMatch(/couldn’t read NEAR testnet/u);
    expect(plainMessage(hanaError(4001), 'login')).toBe('Sign-in did not complete (the window was closed or timed out).');
    expect(plainMessage(hanaError('popup_blocked'), 'login')).toMatch(/blocked the Journear Passport window/u);
    expect(plainMessage(new TypeError('Failed to fetch'), 'read')).toBe('Network error. Check your connection and try again.');
    expect(plainMessage(new Error('boom'), 'collect')).toBe('Something went wrong. If it keeps happening, tell the Journear team.');
  });
});
