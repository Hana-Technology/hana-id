// The demo's test requests. Each is signed only and never broadcast, so no funds are needed, and each would be
// harmless if someone broadcast it anyway: a message, or a 0-value transfer to yourself.

export const TEST_MESSAGE = 'Journear Passport testnet demo: this signature proves nothing and moves nothing.';

/** EIP-1559 fields as eth_signTransaction takes them, fully filled, so the SDK makes no RPC call to fill them. */
export interface TestEvmTx {
  type: '0x2';
  chainId: `0x${string}`;
  nonce: `0x${string}`;
  gas: `0x${string}`;
  maxFeePerGas: `0x${string}`;
  maxPriorityFeePerGas: `0x${string}`;
  to: string;
  value: '0x0';
  data: '0x';
}

const quantity = (n: number | bigint): `0x${string}` => `0x${n.toString(16)}`;

/** A 0-value transfer from `self` to itself on `chainId`: 21 000 gas at 1 gwei (max fee 0.000021 ETH), nonce 0. */
export function testEvmTransaction(self: string, chainId: number): TestEvmTx {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(self)) throw new Error('self must be a 0x address');
  return {
    type: '0x2',
    chainId: quantity(chainId),
    nonce: '0x0',
    gas: quantity(21_000),
    maxFeePerGas: quantity(1_000_000_000),
    maxPriorityFeePerGas: quantity(100_000_000),
    to: self,
    value: '0x0',
    data: '0x',
  };
}

/** `0x` hex of the UTF-8 bytes (personal_sign's message parameter). */
export const utf8Hex = (text: string): `0x${string}` => `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** `abcdef…uvwxyz` for long outputs (signatures are public, but long). */
export const shorten = (s: string, head = 10, tail = 8): string => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
