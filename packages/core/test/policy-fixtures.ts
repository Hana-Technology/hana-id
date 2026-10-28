// A pilot-like auto-approve policy covering both chains, used by the validator and matcher tests.
import { functionSelector } from '../src/index.ts';
import { PASSPHRASE, POOL, ROUTER, TOKEN, USDC } from './stellar-fixtures.ts';

export const EVM_USER = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
export const EVM_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const EVM_VAULT = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
export const EVM_FRIEND = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
export const EVM_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const CHAIN = 8453;

const entry = (signature: string, addressArgs?: 'self-or-listed' | 'any') => ({
  selector: functionSelector(signature),
  signature,
  ...(addressArgs ? { addressArgs } : {}),
});

export const policyJson = () => ({
  v: 1,
  label: 'Swaps on Example',
  maxConsentMs: 12 * 3_600_000,
  limits: { perDayCount: 3 },
  stellar: {
    networkPassphrases: [PASSPHRASE],
    maxFeeStroops: '100000',
    contracts: [
      {
        id: POOL,
        name: 'Example pool',
        functions: [{ name: 'swap' }, { name: 'deposit', addressArgs: 'self-or-listed' }],
      },
      { id: TOKEN, name: 'USDC', functions: [{ name: 'transfer' }, { name: 'approve' }] },
      { id: ROUTER, name: 'Router', functions: [{ name: 'route', addressArgs: 'any' }] },
    ],
    changeTrustAssets: [`USDC:${USDC.getIssuer()}`],
  },
  evm: {
    chains: [
      {
        chainId: CHAIN,
        maxValueWei: '1000',
        maxValueWeiPerDay: '1500',
        contracts: [
          { address: EVM_USDC, name: 'USDC', selectors: [entry('approve(address,uint256)', 'self-or-listed')] },
          {
            address: EVM_VAULT,
            name: 'Example vault',
            selectors: [
              entry('deposit(uint256)'),
              entry('withdraw(address,uint256)', 'self-or-listed'),
              entry('batch((address,uint256)[])', 'self-or-listed'),
              entry('execute(address,bytes)', 'any'),
            ],
          },
        ],
        typedData: [{ verifyingContract: EVM_PERMIT2, primaryType: 'PermitSingle' }],
      },
    ],
  },
});
