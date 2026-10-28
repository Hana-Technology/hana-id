// 4-byte selectors the approval page names and decodes. Only signatures of standard interfaces (ERC-20, ERC-721,
// ERC-1155, ERC-2612, WETH, Multicall) whose meaning is fixed by the standard: a contract can still lie about what a
// function does, so the page always shows the contract address next to the name. Selectors are computed from the
// signatures; test/decode-evm.test.ts checks them against their well-known values.
import { type AbiFunction, parseFunctionSignature } from './abi.ts';

const KNOWN_SIGNATURES = [
  // ERC-20
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'increaseAllowance(address,uint256)',
  'decreaseAllowance(address,uint256)',
  // ERC-2612
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  // ERC-721 / ERC-1155
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
  'setApprovalForAll(address,bool)',
  'safeTransferFrom(address,address,uint256,uint256,bytes)',
  'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  // WETH
  'deposit()',
  'withdraw(uint256)',
  // Multicall
  'multicall(bytes[])',
  'multicall(uint256,bytes[])',
] as const;

const BY_SELECTOR: ReadonlyMap<string, AbiFunction> = new Map(
  KNOWN_SIGNATURES.map((s) => {
    const fn = parseFunctionSignature(s);
    return [fn.selector, fn] as const;
  }),
);

/** The known function for a `0x` + 8 hex selector (lowercase), or undefined. */
export const knownFunction = (selector: string): AbiFunction | undefined => BY_SELECTOR.get(selector.toLowerCase());

/** Every known function (for tests and tooling). */
export const knownFunctions = (): AbiFunction[] => [...BY_SELECTOR.values()];
