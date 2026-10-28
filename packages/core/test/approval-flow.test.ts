// The approval flow across modules (docs/batch-b-spec.md "Approval flow"): the vault turns a port sign request into
// an approval subject with protocol.ts (APPROVAL_KIND, approvalChain, approvalContent), sends it as
// hana:approve-request, and the popup decodes it with @hana-id/core/decode and returns approval.ts's digest. Every
// sign method must make a subject that approval.ts accepts, the window schema accepts and the decoders read.
import { describe, expect, it } from 'vitest';
import { type ApprovalSubject, approvalDigest, validateApprovalSubject } from '../src/approval.ts';
import { base64Encode, toHex } from '../src/bytes.ts';
import { decodeApprovalRequest } from '../src/decode/index.ts';
import { APPROVAL_KIND, type PortRequest, SIGN_METHODS, type SignMethod, approvalChain, approvalContent, newRequestId, parsePortRequest, parseWindowMessage } from '../src/protocol.ts';
import { PASSPHRASE, POOL, USER, addr, authPreimageBytes, invocation, paymentOp, txBytes } from './stellar-fixtures.ts';

const EVM_USER = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
const TYPED = JSON.stringify({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], M: [{ name: 'to', type: 'address' }] },
  primaryType: 'M',
  domain: { name: 'Partner', chainId: 8453 },
  message: { to: EVM_USER },
});

const PARAMS: Record<SignMethod, unknown> = {
  stellar_signTransaction: { xdr: base64Encode(txBytes([paymentOp()])), networkPassphrase: PASSPHRASE },
  stellar_signAuthEntry: { preimageXdr: base64Encode(authPreimageBytes(invocation(POOL, 'swap', [addr(USER)]))), networkPassphrase: PASSPHRASE },
  stellar_signMessage: { message: 'Sign in to Partner' },
  eth_signTransaction: { tx: { chainId: '0x2105', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM_USER, value: '0x1', data: '0x' } },
  personal_sign: ['0x68656c6c6f', EVM_USER],
  eth_signTypedData_v4: [EVM_USER, TYPED],
  hana_signRaw: { chain: 'evm', digest: new Uint8Array(32).fill(0xab) },
};

/** What the vault builds for a sign request: the approval subject of hana:approve-request. */
function subjectOf(method: SignMethod, params: unknown = PARAMS[method]): ApprovalSubject {
  const request = parsePortRequest({ v: 1, id: 'r1', method, params }) as Extract<PortRequest, { method: SignMethod }>;
  expect(request).not.toBeNull();
  const chain = approvalChain(request);
  return { kind: APPROVAL_KIND[method], chain, address: chain === 'stellar' ? USER : EVM_USER, ...approvalContent(request) };
}

describe('approval flow: port request → approve-request → decoders → digest', () => {
  it('maps every sign method to an approval kind', () => {
    expect(Object.keys(APPROVAL_KIND).sort()).toEqual([...SIGN_METHODS].sort());
  });

  it.each([...SIGN_METHODS, 'hana_signRaw (Stellar)'] as const)('%s', (name) => {
    const s = name === 'hana_signRaw (Stellar)' ? subjectOf('hana_signRaw', { chain: 'stellar', bytes: new Uint8Array([1, 2, 3]) }) : subjectOf(name);
    expect(() => validateApprovalSubject(s)).not.toThrow();
    const message = { v: 1, t: 'hana:approve-request', id: newRequestId(), appName: 'Partner', parentOrigin: 'https://partner.example', ...s, position: 1, queued: 1 };
    const parsed = parseWindowMessage(message, ['hana:approve-request']);
    expect(parsed).not.toBeNull();
    expect(decodeApprovalRequest(s).kind).toBe(s.kind);
    // The popup computes the digest from the message it received, the vault from the subject it queued.
    const p = parsed as typeof message;
    expect(toHex(approvalDigest({ ...p, bytes: Uint8Array.from(p.bytes) }))).toBe(toHex(approvalDigest({ ...s, id: p.id, parentOrigin: p.parentOrigin })));
  });

  it('decodes the EVM transaction on the chain the request names, and typed data on its domain chain', () => {
    expect(decodeApprovalRequest(subjectOf('eth_signTransaction'))).toMatchObject({ kind: 'evm_tx', chainId: 8453 });
    expect(decodeApprovalRequest(subjectOf('eth_signTypedData_v4'))).toMatchObject({ kind: 'eip712', chainId: 8453 });
  });
});
