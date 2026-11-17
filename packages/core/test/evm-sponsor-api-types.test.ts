// The EVM gas sponsorship response guards (api-types.ts, D847): the shapes a client checks before trusting an answer.
import { describe, expect, it } from 'vitest';
import { isEvmSponsorPrepareResponse, isEvmSponsorSendResponse, isEvmSponsorStatusResponse } from '../src/api-types.ts';

const A = `0x${'ab'.repeat(20)}`;
const prepare = { delegation: 'journear', accountNonce: '3', executeNonce: '1', serverNow: 1_800_000_000, relayer: A, implementation: A, minGasFloor: '100000', maxMinGas: '160000', deadlineMaxS: 600, allowed: true };

describe('EVM sponsorship response guards', () => {
  it('prepare: exact field shapes; a reason exactly when not allowed; executeNonce null only when delegated elsewhere', () => {
    expect(isEvmSponsorPrepareResponse(prepare)).toBe(true);
    expect(isEvmSponsorPrepareResponse({ ...prepare, allowed: false, reason: 'budget_exhausted' })).toBe(true);
    expect(isEvmSponsorPrepareResponse({ ...prepare, delegation: 'other', executeNonce: null, allowed: false, reason: 'delegated_elsewhere' })).toBe(true);
    for (const bad of [
      { ...prepare, allowed: false },
      { ...prepare, reason: 'budget_exhausted' },
      { ...prepare, reason: 'made_up', allowed: false },
      { ...prepare, executeNonce: null },
      { ...prepare, accountNonce: 3 },
      { ...prepare, accountNonce: '03' },
      { ...prepare, relayer: 'nope' },
      { ...prepare, delegation: 'smart' },
      { ...prepare, serverNow: -1 },
    ]) expect(isEvmSponsorPrepareResponse(bad), JSON.stringify(bad)).toBe(false);
  });

  it('send and status', () => {
    const hash = `0x${'cd'.repeat(32)}`;
    expect(isEvmSponsorSendResponse({ transactionHash: hash, status: 'executed' })).toBe(true);
    expect(isEvmSponsorSendResponse({ transactionHash: hash, status: 'executed', replay: true })).toBe(true);
    expect(isEvmSponsorSendResponse({ transactionHash: hash.toUpperCase(), status: 'executed' })).toBe(false);
    expect(isEvmSponsorSendResponse({ transactionHash: hash, status: 'reverted' })).toBe(false);
    expect(isEvmSponsorStatusResponse({ available: true, remainingToday: '10' })).toBe(true);
    expect(isEvmSponsorStatusResponse({ available: false, reason: 'app_not_sponsored' })).toBe(true);
    expect(isEvmSponsorStatusResponse({ available: false })).toBe(false);
    expect(isEvmSponsorStatusResponse({ available: true, remainingToday: '-1' })).toBe(false);
  });
});
