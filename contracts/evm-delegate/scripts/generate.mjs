#!/usr/bin/env node
// The checked-in outputs of contracts/evm-delegate (D841):
//
//   artifacts/HanaDelegateExecutor.json, artifacts/CheckIn.json   from `forge build`'s out/: ABI, creation and runtime
//                                                                 bytecode, compiler settings, the CREATE2 deployment
//                                                                 (deployer, salt, address) and the hash of the runtime
//                                                                 code at that address
//   test/vectors/execute-v1.json                                  a byte-for-byte copy of the EIP-712 test vector of the
//                                                                 TypeScript signer, packages/core/test/vectors/
//                                                                 evm-sponsor-v1.json (generated there with viem; the
//                                                                 core file is the source)
//
//   node scripts/generate.mjs           write them (run `forge build` first; `pnpm run generate` does both)
//   node scripts/generate.mjs --check   compare instead; exit 1 naming each stale file (the verify lane runs this)
//
// Both modes also check that README.md's "Deployment" table quotes the current addresses and runtime code hashes.
// test/Vectors.t.sol checks the contract against the vector (and that the copy is the core file); test/Artifacts.t.sol
// checks the artifacts against a real CREATE2 deployment; packages/core/test/evm-sponsor.test.ts checks that the core
// signer's pinned table agrees with the artifact.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContractAddress, keccak256, pad, stringToHex } from 'viem';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The deterministic deployment proxy (Arachnid's), at this address on Base Sepolia and most EVM chains. */
export const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

export const CONTRACTS = [
  { name: 'HanaDelegateExecutor', source: 'src/HanaDelegateExecutor.sol', saltLabel: 'hana-id/evm-delegate/HanaDelegateExecutor/v1' },
  { name: 'CheckIn', source: 'src/demo/CheckIn.sol', saltLabel: 'hana-id/evm-delegate/CheckIn/v1' },
];

export const EIP712 = {
  name: 'HanaDelegateExecutor',
  version: '1',
  executeType: 'Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)',
  callType: 'Call(address to,uint256 value,bytes data)',
};

/** The vector's source (the TypeScript signer's) and its copy here, relative to this package. */
export const CORE_VECTOR = join('..', '..', 'packages', 'core', 'test', 'vectors', 'evm-sponsor-v1.json');
export const VECTOR_COPY = join('test', 'vectors', 'execute-v1.json');

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

function forgeOut(c) {
  const file = join(HERE, 'out', c.source.split('/').at(-1), `${c.name}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message} (run \`forge build\` in contracts/evm-delegate first)`);
  }
}

/** The runtime code as deployed at `address`: every immutable is the implementation's own address (the contract has
 * one immutable, IMPLEMENTATION = address(this)). */
export function runtimeAt(deployedBytecode, immutableReferences, address) {
  const ids = Object.keys(immutableReferences ?? {});
  if (ids.length > 1) throw new Error(`expected at most one immutable, found ${ids.length}`);
  let hex = deployedBytecode.slice(2);
  const word = pad(address.toLowerCase(), { size: 32 }).slice(2);
  for (const ref of ids.flatMap((id) => immutableReferences[id])) {
    if (ref.length !== 32) throw new Error('immutable reference is not one word');
    if (!/^0+$/u.test(hex.slice(ref.start * 2, (ref.start + 32) * 2))) throw new Error('immutable placeholder is not zero');
    hex = hex.slice(0, ref.start * 2) + word + hex.slice((ref.start + 32) * 2);
  }
  return `0x${hex}`;
}

export function artifact(c, out) {
  const s = out.metadata.settings;
  const salt = keccak256(stringToHex(c.saltLabel));
  const bytecode = out.bytecode.object;
  const deployedBytecode = out.deployedBytecode.object;
  const address = getContractAddress({ opcode: 'CREATE2', from: DEPLOYER, salt, bytecode });
  const refs = out.deployedBytecode.immutableReferences ?? {};
  const a = {
    contractName: c.name,
    source: `contracts/evm-delegate/${c.source}`,
    license: 'MIT',
    compiler: {
      version: out.metadata.compiler.version,
      evmVersion: s.evmVersion,
      optimizer: s.optimizer,
      viaIR: s.viaIR ?? false,
      metadata: s.metadata,
    },
    create2: { deployer: DEPLOYER, saltLabel: c.saltLabel, salt, initCodeHash: keccak256(bytecode), address },
    runtimeCodeHash: keccak256(runtimeAt(deployedBytecode, refs, address)),
  };
  if (c.name === 'HanaDelegateExecutor') {
    a.eip712 = { name: EIP712.name, version: EIP712.version, salt: pad(address.toLowerCase(), { size: 32 }), executeType: EIP712.executeType, callType: EIP712.callType };
  }
  return {
    ...a,
    abi: out.abi,
    bytecode,
    deployedBytecode,
    immutableReferences: Object.values(refs).flat().map((r) => ({ start: r.start, length: r.length, value: 'implementation address' })),
  };
}

function main() {
  const check = process.argv.includes('--check');
  const artifacts = CONTRACTS.map((c) => artifact(c, forgeOut(c)));
  const files = CONTRACTS.map((c, i) => [join('artifacts', `${c.name}.json`), json(artifacts[i])]);
  const core = join(HERE, CORE_VECTOR);
  if (!existsSync(core)) throw new Error(`${CORE_VECTOR} is missing: it is the source of ${VECTOR_COPY}`);
  files.push([VECTOR_COPY, readFileSync(core, 'utf8')]);

  const stale = [];
  for (const [rel, text] of files) {
    const path = join(HERE, rel);
    if (check) {
      let current = null;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        // missing counts as stale
      }
      if (current !== text) stale.push(rel === VECTOR_COPY ? `${rel} (differs from packages/core/test/vectors/evm-sponsor-v1.json, its source)` : rel);
    } else {
      writeFileSync(path, text);
      console.log(`wrote contracts/evm-delegate/${rel}`);
    }
  }
  for (const a of artifacts) console.log(`${a.contractName}: CREATE2 address ${a.create2.address}, runtime code hash ${a.runtimeCodeHash}`);
  // The README's deployment table quotes both values; it is written by hand, so it is only checked.
  const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
  const unquoted = artifacts.flatMap((a) => [a.create2.address, a.runtimeCodeHash]).filter((v) => !readme.includes(v));
  if (unquoted.length) stale.push(`README.md (its "Deployment" table lacks ${unquoted.join(', ')})`);
  if (stale.length) {
    console.error(`stale: ${stale.map((f) => `contracts/evm-delegate/${f}`).join('; ')}. Run \`pnpm --filter @hana-id/evm-delegate run generate\`, update the README's table and commit the result.`);
    process.exitCode = 1;
  } else if (check) console.log('artifacts and vector copy are up to date');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
