// The auto-approve demo against the real validator and matcher (@hana-id/core/policy), with the approval subject built
// exactly as the vault builds it (approvalContent): the covered requests match, the others go to the popup for the
// right reason. A policy or request change that breaks the demo fails here, not in a tester's browser.
import { Asset, Networks, StrKey } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { type ApprovalSubject, approvalContent } from '@hana-id/core';
import { matchAutoApprovePolicy, policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import {
  DEMO_EVM_CHAIN_ID,
  DEMO_EVM_STRANGER,
  DEMO_EVM_USDC,
  DEMO_POLICY,
  DEMO_STELLAR_PASSPHRASE,
  DEMO_STELLAR_SAC,
  DEMO_STELLAR_STRANGER,
  demoEvmApprove,
  demoStellarTransfer,
} from '../src/demo-requests.ts';

// Public keys made of repeated bytes (0x09 × 32; a well-known example EVM address): shapes only, nobody's wallet.
const SELF_STELLAR = 'GAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSH7S';
const SELF_EVM = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const NOW = Date.UTC(2026, 9, 28, 12);

function policy() {
  const r = validateAutoApprovePolicy(DEMO_POLICY);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.policy;
}

function stellarSubject(xdr: string, address = SELF_STELLAR): ApprovalSubject {
  const c = approvalContent({ v: 1, id: '1', method: 'stellar_signTransaction', params: { xdr, networkPassphrase: DEMO_STELLAR_PASSPHRASE } });
  return { kind: 'stellar_tx', chain: 'stellar', address, ...c };
}

function evmSubject(tx: ReturnType<typeof demoEvmApprove>): ApprovalSubject {
  // As the client's fillTransaction leaves a fully filled transaction: the same fields plus `from`.
  const c = approvalContent({ v: 1, id: '1', method: 'eth_signTransaction', params: { tx: { ...tx, from: SELF_EVM } } });
  return { kind: 'evm_tx', chain: 'evm', address: SELF_EVM, ...c };
}

const match = (s: ApprovalSubject) => matchAutoApprovePolicy(policy(), s, { usage: null, nowMs: NOW });

describe('demo auto-approve policy', () => {
  it('validates, and its constants are what they claim', () => {
    expect(validateAutoApprovePolicy(DEMO_POLICY).ok).toBe(true);
    expect(policyId(DEMO_POLICY)).toMatch(/^[0-9a-f]{64}$/u);
    expect(DEMO_STELLAR_SAC).toBe(Asset.native().contractId(Networks.TESTNET));
    expect(DEMO_STELLAR_PASSPHRASE).toBe('Test SDF Network ; September 2015');
    expect(StrKey.isValidEd25519PublicKey(DEMO_STELLAR_STRANGER)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(SELF_STELLAR)).toBe(true);
    const p = policy();
    expect(p.stellar?.contracts.map((c) => c.id)).toEqual([DEMO_STELLAR_SAC]);
    expect(p.evm?.chains.map((c) => c.chainId)).toEqual([DEMO_EVM_CHAIN_ID]);
    expect(p.evm?.chains[0]?.contracts[0]?.address).toBe(DEMO_EVM_USDC);
    expect(p.maxConsentMs).toBeLessThanOrEqual(3_600_000);
  });
});

describe('demo Stellar transfer', () => {
  it('to yourself is covered', () => {
    expect(match(stellarSubject(demoStellarTransfer(SELF_STELLAR, SELF_STELLAR, NOW)))).toEqual({ ok: true, chain: 'stellar', contract: DEMO_STELLAR_SAC, function: 'transfer' });
  });

  it('to anyone else goes to the popup (address rule)', () => {
    expect(match(stellarSubject(demoStellarTransfer(SELF_STELLAR, DEMO_STELLAR_STRANGER, NOW)))).toMatchObject({ ok: false, reason: 'address_not_allowed' });
  });

  it('from another source goes to the popup', () => {
    expect(match(stellarSubject(demoStellarTransfer(DEMO_STELLAR_STRANGER, DEMO_STELLAR_STRANGER, NOW)))).toMatchObject({ ok: false, reason: 'source_not_self' });
  });
});

describe('demo EVM approve', () => {
  it('to yourself is covered, and fits the fee cap', () => {
    expect(match(evmSubject(demoEvmApprove(SELF_EVM)))).toMatchObject({ ok: true, chain: 'evm', function: 'approve(address,uint256)' });
  });

  it('to anyone else goes to the popup (address rule)', () => {
    expect(match(evmSubject(demoEvmApprove(DEMO_EVM_STRANGER)))).toMatchObject({ ok: false, reason: 'address_not_allowed' });
  });

  it('encodes approve(spender, 1) calldata', () => {
    const tx = demoEvmApprove(DEMO_EVM_STRANGER);
    expect(tx.data).toBe(`0x095ea7b3${'0'.repeat(24)}000000000000000000000000000000000000dead${'0'.repeat(63)}1`);
    expect(tx.chainId).toBe('0xaa36a7');
    expect(() => demoEvmApprove('nope')).toThrow(/0x address/);
  });
});
