// The watchdog's relayer pool classification (src/relayer.ts `poolOf`) matches the API's pool allowlists
// (apps/api/src/relayer-config.ts `POOL_METHODS`), including the session pool's planned later states, and the
// default thresholds sit below the deploy script's default allowances.
import { describe, expect, it } from 'vitest';
import { POOL_METHODS } from '../../../api/src/relayer-config.ts';
import { DEFAULT_RELAYER_FUNDS, poolOf } from '../../src/relayer.ts';

describe('poolOf', () => {
  it("classifies the API's session and owner pools", () => {
    expect(poolOf(POOL_METHODS.session)).toBe('session');
    expect(poolOf(POOL_METHODS.owner)).toBe('owner');
  });

  it('keeps classifying the session pool after batch B drops create_session or create_session_and_derive', () => {
    expect(poolOf(POOL_METHODS.session.filter((m) => m !== 'create_session'))).toBe('session');
    expect(poolOf(POOL_METHODS.session.filter((m) => m !== 'create_session_and_derive'))).toBe('session');
  });

  it('leaves other keys and mixed keys out', () => {
    expect(poolOf(['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'])).toBeNull();
    expect(poolOf([])).toBeNull();
    expect(poolOf([...POOL_METHODS.session, ...POOL_METHODS.owner])).toBeNull();
  });

  it('defaults sit below the default allowances (2 NEAR session, 0.5 NEAR owner: scripts/lib/deploy-run.ts)', () => {
    expect(DEFAULT_RELAYER_FUNDS.sessionAllowance.warn).toBeLessThan(2);
    expect(DEFAULT_RELAYER_FUNDS.ownerAllowance.warn).toBeLessThan(0.5);
    for (const p of Object.values(DEFAULT_RELAYER_FUNDS)) expect(p.critical).toBeLessThan(p.warn);
  });
});
