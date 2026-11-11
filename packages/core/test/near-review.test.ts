// The NEAR security review's fixes (2026-11-11): a transaction relaying a delegate action is never shown or signed
// (its signer prepays the delegate's deposits); a global contract's burn is counted; a leading BOM keeps arguments as
// hex; the delegate-action nonce rule and its helper; the export check zeroes its decoded copy.
import { Signature, SignedDelegate, buildDelegateAction } from '@near-js/transactions';
import { KeyType } from '@near-js/crypto';
import { describe, expect, it } from 'vitest';
import { DecodeError } from '../src/decode/errors.ts';
import { NEAR_GLOBAL_CONTRACT_YOCTO_PER_BYTE, nearArgsView, nearDeposits, nearGlobalContractBurn } from '../src/decode/near.ts';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import { decodeNearTransaction, nearRelaysDelegate } from '../src/near/codec.ts';
import { NEAR_DELEGATE_MAX_BLOCKS, NEAR_DELEGATE_NONCE_LAG_BLOCKS, NEAR_NONCE_PER_BLOCK, nearDelegateNonce, nearDelegateNonceFloor } from '../src/near/delegate.ts';
import { signNearTransaction } from '../src/near/sign.ts';
import { addressOfExport, exportKeyString } from '../src/export.ts';
import { extractPrk } from '../src/derivation.ts';
import { readText } from './helpers.ts';
import { NEAR_OTHER_KEY, NEAR_USER, NEAR_USER_KEY, NEAR_USER_S, NEAR_USER_SEED, deployGlobalContract, nearTxBytes, transfer } from './near-fixtures.ts';
import { actionCreators, GlobalContractDeployMode } from '@near-js/transactions';

/** A transaction from the user that relays bob's delegate action sending 1000 NEAR to an attacker. */
function relayingTx(): Uint8Array {
  const inner = buildDelegateAction({ senderId: 'bob.testnet', receiverId: 'attacker.testnet', actions: [transfer(1000n * 10n ** 24n)], nonce: 1n, maxBlockHeight: 5n, publicKey: NEAR_OTHER_KEY });
  return nearTxBytes([actionCreators.signedDelegate(new SignedDelegate({ delegateAction: inner, signature: new Signature({ keyType: KeyType.ED25519, data: new Uint8Array(64) }) }))], { receiver: 'bob.testnet' });
}

describe('H1: a transaction that relays a delegate action', () => {
  it('counts the delegate’s deposits as leaving the signer (nearcore’s total_deposit)', () => {
    const tx = decodeNearTransaction(relayingTx());
    expect(nearRelaysDelegate(tx)).toBe(true);
    expect(nearDeposits(tx.actions).total).toBe(1000n * 10n ** 24n);
  });

  it('is refused by the approval decoder (never shown) and by the signer', () => {
    const bytes = relayingTx();
    let code = '';
    try {
      decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: NEAR_USER, context: { nearNetwork: 'testnet' }, bytes });
    } catch (e) {
      code = (e as DecodeError).code;
      expect((e as Error).message).toMatch(/relays a delegate action/u);
    }
    expect(code).toBe('unsupported');
    expect(() => signNearTransaction(NEAR_USER_SEED(), bytes)).toThrow(/relays a delegate action/u);
  });
});

describe('M2: DeployGlobalContract burns 0.0001 NEAR per byte', () => {
  it('is counted apart from deposits', () => {
    expect(NEAR_GLOBAL_CONTRACT_YOCTO_PER_BYTE).toBe(10n ** 20n);
    expect(nearGlobalContractBurn(140_000)).toBe(14n * 10n ** 24n);
    const tx = decodeNearTransaction(nearTxBytes([deployGlobalContract(new Uint8Array(1000), new GlobalContractDeployMode({ CodeHash: null }))], { receiver: NEAR_USER }));
    expect(nearDeposits(tx.actions)).toEqual({ total: 0n, staked: 0n, burned: 1000n * 10n ** 20n, deletesAccount: false });
  });
});

describe('L1: a BOM before JSON arguments', () => {
  it('keeps them as hex (what is sent), never shown as the JSON after it', () => {
    const v = nearArgsView(Uint8Array.of(0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')));
    expect(v).toMatchObject({ kind: 'hex' });
    expect((v as { hex: string }).hex.startsWith('efbbbf')).toBe(true);
  });
});

describe('M1: the delegate-action nonce', () => {
  const H = 277_000_000n;

  it('nearDelegateNonce: the key’s nonce + 1, or (height − 100) × 10^6 when that is higher', () => {
    expect(NEAR_DELEGATE_NONCE_LAG_BLOCKS).toBe(100);
    expect(nearDelegateNonce({ keyNonce: 250_000_000_000_000, blockHeight: Number(H) })).toBe((H - 100n) * NEAR_NONCE_PER_BLOCK);
    expect(nearDelegateNonce({ keyNonce: (H - 5n) * NEAR_NONCE_PER_BLOCK, blockHeight: H })).toBe((H - 5n) * NEAR_NONCE_PER_BLOCK + 1n);
    expect(() => nearDelegateNonce({ keyNonce: H * NEAR_NONCE_PER_BLOCK - 1n, blockHeight: H })).toThrow(/bound/u);
    expect(() => nearDelegateNonce({ keyNonce: -1, blockHeight: H })).toThrow(RangeError);
    expect(() => nearDelegateNonce({ keyNonce: 1.5, blockHeight: H })).toThrow(RangeError);
  });

  it('what it picks passes the vault’s window for the next 9,900 blocks, and stays below nearcore’s bound', () => {
    const n = nearDelegateNonce({ keyNonce: 0, blockHeight: H });
    for (const later of [H, H + 9_899n]) {
      expect(n > nearDelegateNonceFloor(later)).toBe(true);
      expect(n < later * NEAR_NONCE_PER_BLOCK).toBe(true);
    }
    expect(n > nearDelegateNonceFloor(H + BigInt(NEAR_DELEGATE_MAX_BLOCKS))).toBe(false);
    // After it runs the key's nonce is n; the next one still fits under the bound.
    expect(nearDelegateNonce({ keyNonce: n, blockHeight: H + 1n }) > n).toBe(true);
    expect(nearDelegateNonce({ keyNonce: n, blockHeight: H + 1n }) < (H + 1n) * NEAR_NONCE_PER_BLOCK).toBe(true);
  });
});

describe('L3: the NEAR export check zeroes the key bytes it decoded', () => {
  it('decodes into the one buffer its finally zeroes (no copy)', () => {
    const exported = exportKeyString(extractPrk(NEAR_USER_S()), 'near');
    expect(addressOfExport('near', exported)).toBe(NEAR_USER);
    const src = readText('../src/export.ts');
    expect(src).toContain('key = base58.decode(m[1]!) as Bytes;');
    expect(src).not.toMatch(/toBytes\(base58\.decode/u);
    expect(src).toMatch(/finally \{\n    key\?\.fill\(0\);/u);
  });
});
