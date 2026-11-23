// D896: what a label document describes (context.ts): one key per contract, the env's network, and the rule that two
// documents describing the same contract are both dropped (the vault's check and the window's own).
import { describe, expect, it } from 'vitest';
import { labelContextKey, labelOnNetwork, withoutSharedContracts } from '../src/partner-labels/context.ts';
import { GUESTBOOK_DOC_JSON, PASSPHRASE, PAYMENT_DOC_JSON, SOROBAN_DOC_JSON, STAMPS_DOC_JSON, parsed } from './partner-labels-fixtures.ts';

const MAINNET = 'Public Global Stellar Network ; September 2015';

describe('labelContextKey', () => {
  it('is the API’s context_key: chain, network and account or contract', () => {
    expect(labelContextKey(parsed(STAMPS_DOC_JSON))).toBe('near:testnet:stamps-partner.testnet');
    expect(labelContextKey(parsed(SOROBAN_DOC_JSON))).toBe(`soroban:${PASSPHRASE}:${SOROBAN_DOC_JSON.context.soroban.contract}`);
    expect(labelContextKey(parsed(PAYMENT_DOC_JSON))).toBe(`stellar:${PASSPHRASE}`);
  });
});

describe('labelOnNetwork', () => {
  it('NEAR by its network; Stellar by the matching passphrase', () => {
    expect(labelOnNetwork(parsed(STAMPS_DOC_JSON), 'testnet')).toBe(true);
    expect(labelOnNetwork(parsed(STAMPS_DOC_JSON), 'mainnet')).toBe(false);
    expect(labelOnNetwork(parsed(PAYMENT_DOC_JSON), 'testnet')).toBe(true);
    expect(labelOnNetwork(parsed(PAYMENT_DOC_JSON), 'mainnet')).toBe(false);
    const live = parsed(JSON.stringify(PAYMENT_DOC_JSON).replace(PASSPHRASE, MAINNET));
    expect(labelOnNetwork(live, 'mainnet')).toBe(true);
    expect(labelOnNetwork(live, 'testnet')).toBe(false);
  });
});

describe('withoutSharedContracts', () => {
  it('drops both of two documents for one contract, keeps the rest in order', () => {
    const a = { id: 'a', document: parsed(STAMPS_DOC_JSON) };
    const b = { id: 'b', document: parsed(GUESTBOOK_DOC_JSON) };
    const c = { id: 'c', document: parsed(JSON.stringify(STAMPS_DOC_JSON).replace('the stamp', 'the badge')) };
    const d = { id: 'd', document: parsed(PAYMENT_DOC_JSON) };
    expect(withoutSharedContracts([a, b, c, d]).map((x) => x.id)).toEqual(['b', 'd']);
    expect(withoutSharedContracts([a, b, d]).map((x) => x.id)).toEqual(['a', 'b', 'd']);
    expect(withoutSharedContracts([])).toEqual([]);
  });
});
