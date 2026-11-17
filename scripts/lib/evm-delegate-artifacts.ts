// The EVM delegate's checked-in build outputs (contracts/evm-delegate/artifacts/*.json, D841) as the deploy scripts
// use them (D849): the creation bytecode, the CREATE2 salt and predicted address through the deterministic deployment
// proxy, and the runtime code hash expected at that address. Loading an artifact re-derives what it claims (the salt
// from its label, the init code hash from the bytecode, the address from the proxy, salt and init code hash), so a
// hand-edited or truncated file is refused before anything reads the chain.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksumEvmAddress, repoRoot } from '@hana-id/env';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** The deterministic deployment proxy (Arachnid's; on Base Sepolia an OP Stack preinstall; anvil has it by default). */
export const DETERMINISTIC_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
/** keccak256 of the proxy's runtime code (69 bytes, `0x7fff…6014600cf3`), the same on every chain that has it. */
export const DETERMINISTIC_DEPLOYER_CODE_HASH = '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989';

/** The contracts deploy-evm-delegate deploys, in order: the delegate, then the demo target. */
export const EVM_DELEGATE_CONTRACTS = ['HanaDelegateExecutor', 'CheckIn'] as const;
export type EvmDelegateContract = (typeof EVM_DELEGATE_CONTRACTS)[number];

export const EVM_DELEGATE_DIR = join(repoRoot, 'contracts', 'evm-delegate');
export const evmArtifactsDir = (root: string = repoRoot): string => join(root, 'contracts', 'evm-delegate', 'artifacts');

export interface DelegateArtifact {
  contractName: EvmDelegateContract;
  /** The source path, from the repo root, and `path:Name` as forge names it from contracts/evm-delegate. */
  source: string;
  forgeId: string;
  compilerVersion: string;
  saltLabel: string;
  salt: string;
  initCodeHash: string;
  /** The CREATE2 address (EIP-55). */
  address: string;
  /** keccak256 of the code at `address` after the deploy (the delegate's immutable filled in). */
  runtimeCodeHash: string;
  /** The creation bytecode, `0x` + lowercase hex. */
  bytecode: string;
}

const HASH_RE = /^0x[0-9a-f]{64}$/u;
const BYTECODE_RE = /^0x(?:[0-9a-f]{2})+$/u;

/** keccak256 of bytes or `0x` hex, as `0x` + 64 lowercase hex. */
export function keccakHex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? hexToBytes(data.startsWith('0x') ? data.slice(2) : data) : data;
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/** The CREATE2 address (EIP-1014) of `initCodeHash` deployed by `deployer` with `salt`, EIP-55. */
export function create2Address(deployer: string, salt: string, initCodeHash: string): string {
  const input = `ff${deployer.slice(2)}${salt.slice(2)}${initCodeHash.slice(2)}`.toLowerCase();
  return checksumEvmAddress(`0x${keccakHex(input).slice(-40)}`);
}

/** The proxy's calldata for a CREATE2 deploy: the 32-byte salt, then the init code. */
export const deployCalldata = (a: Pick<DelegateArtifact, 'salt' | 'bytecode'>): string => `0x${a.salt.slice(2)}${a.bytecode.slice(2)}`;

/** Reads and checks `artifacts/<name>.json`. Throws, naming the file and the field, when anything doesn't hold. */
export function loadDelegateArtifact(name: EvmDelegateContract, root: string = repoRoot): DelegateArtifact {
  const shown = `contracts/evm-delegate/artifacts/${name}.json`;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(evmArtifactsDir(root), `${name}.json`), 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`${shown} is missing or not JSON (regenerate it: cd contracts/evm-delegate && corepack pnpm run generate)`);
  }
  const bad = (field: string) => new Error(`${shown}: ${field} is not what the artifact should hold (regenerate it, then review the diff)`);
  const c2 = (raw.create2 ?? {}) as Record<string, unknown>;
  const compiler = (raw.compiler ?? {}) as Record<string, unknown>;
  if (raw.contractName !== name) throw bad('contractName');
  if (typeof raw.source !== 'string' || !/^contracts\/evm-delegate\/src\/[\w/]+\.sol$/u.test(raw.source)) throw bad('source');
  if (typeof compiler.version !== 'string' || !/^\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}$/u.test(compiler.version)) throw bad('compiler.version');
  if (typeof raw.bytecode !== 'string' || !BYTECODE_RE.test(raw.bytecode)) throw bad('bytecode');
  if (typeof c2.deployer !== 'string' || c2.deployer.toLowerCase() !== DETERMINISTIC_DEPLOYER.toLowerCase()) throw bad('create2.deployer');
  if (typeof c2.saltLabel !== 'string' || c2.saltLabel.length === 0) throw bad('create2.saltLabel');
  const salt = keccakHex(new TextEncoder().encode(c2.saltLabel));
  if (c2.salt !== salt) throw bad('create2.salt (not keccak256 of saltLabel)');
  const initCodeHash = keccakHex(raw.bytecode);
  if (c2.initCodeHash !== initCodeHash) throw bad('create2.initCodeHash (not keccak256 of bytecode)');
  const address = create2Address(DETERMINISTIC_DEPLOYER, salt, initCodeHash);
  if (c2.address !== address) throw bad('create2.address (not the CREATE2 address of the proxy, salt and init code)');
  if (typeof raw.runtimeCodeHash !== 'string' || !HASH_RE.test(raw.runtimeCodeHash)) throw bad('runtimeCodeHash');
  const source = raw.source;
  const forgeId = `${source.slice('contracts/evm-delegate/'.length)}:${name}`;
  return { contractName: name, source, forgeId, compilerVersion: compiler.version, saltLabel: c2.saltLabel, salt, initCodeHash, address, runtimeCodeHash: raw.runtimeCodeHash, bytecode: raw.bytecode };
}

/** Both artifacts, in deploy order. */
export const loadDelegateArtifacts = (root: string = repoRoot): DelegateArtifact[] => EVM_DELEGATE_CONTRACTS.map((n) => loadDelegateArtifact(n, root));
