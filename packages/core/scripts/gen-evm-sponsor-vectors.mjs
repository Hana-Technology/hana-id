#!/usr/bin/env node
// Writes test/vectors/evm-sponsor-v1.json: worked examples of a sponsored EVM action against the delegate's interface
// (contracts/evm-delegate, HanaDelegateExecutor v1; docs/decisions.md D841, D846): the Execute's EIP-712 domain
// separator, struct hash, digest and signature, the execute(...) calldata, the EIP-7702 authorization's hash and
// signature, the approval subject's bytes, and the relayer's signed type-4 / type-2 transaction. Computed with viem
// only (independent of src/evm-sponsor), so src/evm-sponsor must agree with it byte for byte
// (test/evm-sponsor-vectors.test.ts), and the contract's forge test reads the same inputs and must reach the same
// digest and accept the same calldata.
//
// Test-only keys: each is keccak256(utf8(seed)) of the seed written next to it, never a real key.
//
//   node packages/core/scripts/gen-evm-sponsor-vectors.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  concat,
  domainSeparator,
  encodeFunctionData,
  getAddress,
  hashStruct,
  hashTypedData,
  keccak256,
  numberToHex,
  pad,
  serializeTransaction,
  stringToBytes,
  stringToHex,
  toFunctionSelector,
  toHex,
  toRlp,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashAuthorization } from 'viem/utils';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'vectors', 'evm-sponsor-v1.json');

const keyOf = (seed) => keccak256(stringToBytes(seed));
const ACCOUNT_SEED = 'hana-id evm-sponsor vector account 1';
const RELAYER_SEED = 'hana-id evm-sponsor vector relayer 1';
const account = privateKeyToAccount(keyOf(ACCOUNT_SEED));
const relayer = privateKeyToAccount(keyOf(RELAYER_SEED));

const DOMAIN_NAME = 'HanaDelegateExecutor';
const DOMAIN_VERSION = '1';
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)';
const CALL_TYPE = 'Call(address to,uint256 value,bytes data)';
const EXECUTE_TYPE = `Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)${CALL_TYPE}`;
const FUNCTION = 'execute((address,uint256,bytes)[],uint256,uint256,address,uint256,bytes)';
const SUBJECT_PREFIX = 'hana-id/evm-sponsored/v1';

const TYPES = {
  Execute: [
    { name: 'calls', type: 'Call[]' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'relayer', type: 'address' },
    { name: 'minGas', type: 'uint256' },
  ],
  Call: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
};

const ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'relayer', type: 'address' },
      { name: 'minGas', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
];

// The placeholder delegate of src/evm-sponsor/delegates.ts (chain 31337), and a second, unpinned implementation.
const PLACEHOLDER_DELEGATE = '0x7702000000000000000000000000000000007702';
const OTHER_IMPLEMENTATION = getAddress(`0x${keccak256(stringToBytes('hana-id evm-sponsor vector implementation 2')).slice(-40)}`);
const target = (n) => getAddress(`0x${keccak256(stringToBytes(`hana-id evm-sponsor vector target ${n}`)).slice(-40)}`);
const CHECK_IN = toFunctionSelector('checkIn()');
const PATTERN_100 = toHex(Uint8Array.from({ length: 100 }, (_, i) => (i * 7 + 3) & 0xff));

const CASES = [
  {
    name: 'checkin-with-authorization',
    description: 'One check-in call on a local chain, with the authorization that delegates the account in the same transaction.',
    walletSigns: true,
    inputs: {
      chainId: 31337,
      implementation: PLACEHOLDER_DELEGATE,
      calls: [{ to: target(1), value: 0n, data: CHECK_IN }],
      nonce: 0n,
      deadline: 1_800_000_000n,
      minGas: 100_000n,
    },
    authNonce: 0n,
    relayerTx: { type: 'eip7702', nonce: 3, gas: 300_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 10_000_000n },
  },
  {
    name: 'three-calls-delegated',
    description: 'Three calls with empty, 4-byte and 100-byte data on an account that is already delegated (no authorization).',
    walletSigns: true,
    inputs: {
      chainId: 31337,
      implementation: PLACEHOLDER_DELEGATE,
      calls: [
        { to: target(1), value: 0n, data: '0x' },
        { to: target(2), value: 0n, data: CHECK_IN },
        { to: target(3), value: 0n, data: PATTERN_100 },
      ],
      nonce: 5n,
      deadline: 1_800_000_600n,
      minGas: 250_000n,
    },
    authNonce: null,
    relayerTx: { type: 'eip1559', nonce: 4, gas: 400_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 10_000_000n },
  },
  {
    name: 'value-call-other-chain',
    description:
      'A call with value on Base Sepolia under another implementation: the contract accepts it; the wallet never signs it (value is refused and the implementation is not pinned), so it has no subject.',
    walletSigns: false,
    inputs: {
      chainId: 84532,
      implementation: OTHER_IMPLEMENTATION,
      calls: [{ to: target(4), value: 1_000_000_000_000_000n, data: '0x' }],
      nonce: 1n,
      deadline: 1_800_001_200n,
      minGas: 0n,
    },
    authNonce: null,
    relayerTx: null,
  },
];

const dec = (n) => n.toString();
const scalar = (n) => (n === 0n ? '0x' : numberToHex(n));

function build(c) {
  const i = { ...c.inputs, account: account.address, relayer: relayer.address };
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: i.chainId,
    verifyingContract: i.account,
    salt: pad(i.implementation.toLowerCase(), { size: 32 }),
  };
  const message = { calls: i.calls, nonce: i.nonce, deadline: i.deadline, relayer: i.relayer, minGas: i.minGas };
  const digest = hashTypedData({ domain, types: TYPES, primaryType: 'Execute', message });
  return { i, domain, message, digest };
}

const cases = [];
for (const c of CASES) {
  const { i, domain, message, digest } = build(c);
  const signature = await account.signTypedData({ domain, types: TYPES, primaryType: 'Execute', message });
  const calldata = encodeFunctionData({ abi: ABI, functionName: 'execute', args: [i.calls, i.nonce, i.deadline, i.relayer, i.minGas, signature] });

  let authorization = null;
  if (c.authNonce !== null) {
    const a = { chainId: i.chainId, address: i.implementation, nonce: Number(c.authNonce) };
    const signed = await account.signAuthorization(a);
    authorization = {
      chainId: i.chainId,
      address: getAddress(i.implementation),
      nonce: dec(c.authNonce),
      hash: hashAuthorization(a),
      yParity: signed.yParity,
      r: pad(signed.r, { size: 32 }),
      s: pad(signed.s, { size: 32 }),
      signed,
    };
  }

  const subject = c.walletSigns
    ? concat([
        stringToHex(SUBJECT_PREFIX),
        toRlp([
          numberToHex(i.chainId),
          i.account.toLowerCase(),
          i.implementation.toLowerCase(),
          c.authNonce === null ? [] : [scalar(c.authNonce)],
          i.calls.map((call) => [call.to.toLowerCase(), scalar(call.value), call.data]),
          scalar(i.nonce),
          scalar(i.deadline),
          i.relayer.toLowerCase(),
          scalar(i.minGas),
        ]),
      ])
    : null;

  let relayerTx = null;
  if (c.relayerTx) {
    const t = c.relayerTx;
    const tx = {
      type: t.type,
      chainId: i.chainId,
      nonce: t.nonce,
      gas: t.gas,
      maxFeePerGas: t.maxFeePerGas,
      maxPriorityFeePerGas: t.maxPriorityFeePerGas,
      to: i.account,
      value: 0n,
      data: calldata,
      ...(t.type === 'eip7702' ? { authorizationList: [authorization.signed] } : {}),
    };
    const raw = await relayer.signTransaction(tx);
    relayerTx = {
      type: t.type,
      chainId: i.chainId,
      nonce: t.nonce,
      gas: dec(t.gas),
      maxFeePerGas: dec(t.maxFeePerGas),
      maxPriorityFeePerGas: dec(t.maxPriorityFeePerGas),
      to: i.account,
      value: '0',
      data: calldata,
      authorizationCount: t.type === 'eip7702' ? 1 : 0,
      unsigned: serializeTransaction(tx),
      raw,
      hash: keccak256(raw),
    };
  }
  if (authorization) delete authorization.signed;

  cases.push({
    name: c.name,
    description: c.description,
    walletSigns: c.walletSigns,
    inputs: {
      chainId: i.chainId,
      account: i.account,
      implementation: getAddress(i.implementation),
      calls: i.calls.map((call) => ({ to: call.to, value: dec(call.value), data: call.data })),
      nonce: dec(i.nonce),
      deadline: dec(i.deadline),
      relayer: i.relayer,
      minGas: dec(i.minGas),
    },
    domainSeparator: domainSeparator({ domain }),
    structHash: hashStruct({ data: message, primaryType: 'Execute', types: TYPES }),
    digest,
    signature,
    calldata,
    authorization,
    subject,
    relayerTx,
  });
}

const out = {
  _comment:
    'Generated by packages/core/scripts/gen-evm-sponsor-vectors.mjs with viem only (independent of src/evm-sponsor). Test-only keys: keccak256(utf8(seed)). uint256 values are decimal strings; chainId, yParity, relayerTx.nonce and authorizationCount are numbers.',
  version: 1,
  contract: {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    domainType: DOMAIN_TYPE,
    domainTypeHash: keccak256(stringToBytes(DOMAIN_TYPE)),
    executeType: EXECUTE_TYPE,
    executeTypeHash: keccak256(stringToBytes(EXECUTE_TYPE)),
    callTypeHash: keccak256(stringToBytes(CALL_TYPE)),
    function: FUNCTION,
    selector: toFunctionSelector(FUNCTION),
    salt: 'bytes32(uint256(uint160(implementation)))',
    verifyingContract: 'the account (address(this) under EIP-7702)',
  },
  keyDerivation: 'keccak256(utf8(seed))',
  accountKeySeed: ACCOUNT_SEED,
  account: account.address,
  relayerKeySeed: RELAYER_SEED,
  relayer: relayer.address,
  subjectPrefix: SUBJECT_PREFIX,
  cases,
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}`);
