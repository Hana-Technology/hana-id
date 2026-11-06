// IssuerRpc's inputs (src/issuer-apps.ts, D432): strict, one lookup key each, in the forms the issuer accepts.
import { describe, expect, it } from 'vitest';
import { ISSUER_RPC_METHODS, issuerAppByIdInput, issuerAppByKeyInput, issuerScopeInput } from '../src/index.ts';

describe('IssuerRpc inputs', () => {
  it('appByKey takes a publishable key only', () => {
    expect(issuerAppByKeyInput.safeParse({ pk: 'pk_test_1111111111111111111111111111111a' }).success).toBe(true);
    expect(issuerAppByKeyInput.safeParse({ pk: 'pk_live_1111111111111111111111111111111a' }).success).toBe(true);
    for (const pk of ['', 'pk_test_short', 'pk_prod_1111111111111111111111111111111a', 'pk_test_0OIl111111111111111111111111111', "pk_test_1111111111111111' OR 1=1", 42, null]) {
      expect(issuerAppByKeyInput.safeParse({ pk }).success, String(pk)).toBe(false);
    }
    // Strict: an extra field (a caller thinking it set something, e.g. a clock) is refused.
    expect(issuerAppByKeyInput.safeParse({ pk: 'pk_test_1111111111111111111111111111111a', now: 0 }).success).toBe(false);
  });

  it('appById takes an app id; scopeHasEmailApp a scope id as the issuer’s commitments carry it', () => {
    for (const appId of ['app_abc123', 'app_e2e_1_ab12', 'old1']) expect(issuerAppByIdInput.safeParse({ appId }).success, appId).toBe(true);
    for (const appId of ['', 'app x', "app_x' OR 1=1", 'a'.repeat(97), 42]) expect(issuerAppByIdInput.safeParse({ appId }).success, String(appId)).toBe(false);
    for (const scopeId of ['s2', 'global', 'a'.repeat(64)]) expect(issuerScopeInput.safeParse({ scopeId }).success, scopeId).toBe(true);
    for (const scopeId of ['', 'S2', 's-2', 'a'.repeat(65)]) expect(issuerScopeInput.safeParse({ scopeId }).success, scopeId).toBe(false);
    expect(issuerScopeInput.safeParse({ scopeId: 's2', limit: 1 }).success).toBe(false);
  });

  it('names exactly the three reads', () => {
    expect([...ISSUER_RPC_METHODS]).toEqual(['appByKey', 'appById', 'scopeHasEmailApp']);
  });
});
