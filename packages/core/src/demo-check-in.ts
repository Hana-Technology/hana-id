// Journear's demo check-in contract (`contracts/evm-delegate/src/demo/CheckIn.sol`, docs/decisions.md D854): pinned
// per chain where it is deployed, on Journear's verified list (verified-contracts.ts), and its one function `checkIn()`
// read as a known call by the approval summary (decode/summary.ts), sponsored or not. Pinned data, as the delegate's
// table is: a code release changes it. test/demo-check-in.test.ts checks every entry against the checked-in artifact
// (contracts/evm-delegate/artifacts/CheckIn.json: its CREATE2 address and runtime code hash).
//
// Adding a chain: one line, once the contract is deployed there from the reviewed source and its on-chain runtime code
// hash checked against the artifact (`deploy-evm-delegate` prints the line). The address is the same on every chain.
// No imports: the API Worker and the page bundles can take it as it is.

export interface DemoCheckIn {
  /** EIP-55, the deterministic CREATE2 address. */
  readonly address: `0x${string}`;
  /** keccak256 of the deployed runtime code, `0x` + 64 lowercase hex. */
  readonly runtimeCodeHash: `0x${string}`;
}

/** `checkIn()`'s whole calldata: its selector and nothing else. */
export const DEMO_CHECK_IN_CALLDATA = '0x183ff085';

export const DEMO_CHECK_IN: Readonly<Record<number, DemoCheckIn>> = Object.freeze({
  31337: Object.freeze({ address: '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e', runtimeCodeHash: '0x807946bfc8ed8e9b3fe9ef6bdeed6c9dfa519084bcda4a5b17c2059c96d0bb56' }),
} satisfies Record<number, DemoCheckIn>);

/**
 * Whether a call is exactly the demo check-in: the pinned contract on `chainId` (any letter case), calldata exactly
 * `checkIn()`'s selector (no trailing bytes) and no value. Anything else is an ordinary call Journear can't explain.
 */
export function isDemoCheckInCall(chainId: number, to: string | null, data: string, value: bigint): boolean {
  if (!Number.isSafeInteger(chainId) || !Object.hasOwn(DEMO_CHECK_IN, chainId) || typeof to !== 'string') return false;
  const pinned = DEMO_CHECK_IN[chainId] as DemoCheckIn;
  return to.toLowerCase() === pinned.address.toLowerCase() && typeof data === 'string' && data.toLowerCase() === DEMO_CHECK_IN_CALLDATA && value === 0n;
}
