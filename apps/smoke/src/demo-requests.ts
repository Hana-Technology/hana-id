// The auto-approve demo (policies/demo-auto-approve.json) and the sign requests the vault page sends to exercise it:
// for each chain one request the policy covers (auto-signed once the user accepted the policy) and one it doesn't
// (the approval popup shows why). They are signed only, never broadcast: the page has no use for the signatures and
// shows only that they came back. Every request is harmless if it were broadcast anyway: 1 stroop of testnet XLM
// sent to yourself, or a 1-unit Sepolia USDC allowance (to yourself, or to the burn address).
import { Account, Address, Asset, Networks, Operation, TransactionBuilder, nativeToScVal } from '@stellar/stellar-base';
import demoPolicyJson from '../policies/demo-auto-approve.json';

/** The demo policy as `admin app:settings <app> --auto-approve apps/smoke/policies/demo-auto-approve.json` sets it. */
export const DEMO_POLICY: unknown = demoPolicyJson;

export const DEMO_STELLAR_PASSPHRASE = Networks.TESTNET;
/** The native XLM Stellar Asset Contract on testnet (listed in the demo policy with `transfer`). */
export const DEMO_STELLAR_SAC = Asset.native().contractId(Networks.TESTNET);
/** A valid G… address that is neither the user nor listed (ed25519 key 0x07 × 32, nobody's account). */
export const DEMO_STELLAR_STRANGER = 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI';

export const DEMO_EVM_CHAIN_ID = 11155111;
/** Sepolia public RPC for the client's EVM config (the demo transactions are fully filled, so it isn't called). */
export const DEMO_EVM_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
/** Circle's USDC on Sepolia (listed in the demo policy with `approve(address,uint256)`). */
export const DEMO_EVM_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
/** Not the user and not listed. */
export const DEMO_EVM_STRANGER = '0x000000000000000000000000000000000000dEaD';
const APPROVE_SELECTOR = '095ea7b3';

/** Base64 XDR of a testnet transaction from `self`: one SAC `transfer(self, to, 1)` call, fee 100 stroops. */
export function demoStellarTransfer(self: string, to: string, nowMs: number = Date.now()): string {
  const tx = new TransactionBuilder(new Account(self, '0'), { fee: '100', networkPassphrase: DEMO_STELLAR_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: DEMO_STELLAR_SAC,
        function: 'transfer',
        args: [new Address(self).toScVal(), new Address(to).toScVal(), nativeToScVal(1n, { type: 'i128' })],
      }),
    )
    .setTimebounds(0, Math.floor(nowMs / 1000) + 300)
    .build();
  return tx.toXDR();
}

/** EIP-1559 fields as eth_signTransaction takes them (all `0x` quantities), fully filled so no RPC is needed. */
export interface DemoEvmTx {
  type: '0x2';
  chainId: `0x${string}`;
  nonce: `0x${string}`;
  gas: `0x${string}`;
  maxFeePerGas: `0x${string}`;
  maxPriorityFeePerGas: `0x${string}`;
  to: string;
  value: '0x0';
  data: `0x${string}`;
}

const word = (hex: string): string => hex.padStart(64, '0');

/** A Sepolia `approve(spender, 1)` on the demo token: 60 000 gas at 2 gwei (fee 0.00012 ETH, under the policy's cap). */
export function demoEvmApprove(spender: string): DemoEvmTx {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(spender)) throw new Error('spender must be a 0x address');
  return {
    type: '0x2',
    chainId: `0x${DEMO_EVM_CHAIN_ID.toString(16)}`,
    nonce: '0x0',
    gas: `0x${(60_000).toString(16)}`,
    maxFeePerGas: `0x${(2_000_000_000).toString(16)}`,
    maxPriorityFeePerGas: `0x${(1_000_000_000).toString(16)}`,
    to: DEMO_EVM_USDC,
    value: '0x0',
    data: `0x${APPROVE_SELECTOR}${word(spender.slice(2).toLowerCase())}${word('1')}`,
  };
}
