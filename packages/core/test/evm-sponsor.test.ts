// @hana-id/core/evm-sponsor (docs/decisions.md D833, D846): every builder against viem (hashAuthorization,
// recoverAuthorizationAddress, hashTypedData, encodeFunctionData, serializeTransaction / signTransaction for type 2 and
// type 4), every refusal of the signers, and the strict subject decoder against hostile bytes. Test-only keys:
// keccak256 of a fixed phrase.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData as viemHashTypedData,
  keccak256,
  parseTransaction,
  recoverTypedDataAddress,
  toFunctionSelector,
  toRlp,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashAuthorization, recoverAuthorizationAddress } from 'viem/utils';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checksumEvmAddress } from '../src/addresses.ts';
import { concatBytes, from0xHex, toHex, utf8 } from '../src/bytes.ts';
import { DecodeError } from '../src/decode/errors.ts';
import {
  type Authorization,
  type EvmSponsorErrorCode,
  type EvmSponsorSubject,
  type ExecuteInput,
  type SignedAuthorization,
  type SponsorTx,
  EVM_SPONSOR_MAX_CALL_DATA_BYTES,
  EVM_SPONSOR_MAX_CALLS,
  EVM_SPONSOR_SUBJECT_MAX_BYTES,
  EVM_SPONSOR_SUBJECT_PREFIX,
  EXECUTE_FUNCTION,
  EXECUTE_SELECTOR,
  EvmSponsorError,
  SPONSOR_ABI_VERSION,
  SPONSOR_DELEGATES,
  SPONSOR_DELEGATE_DOMAIN,
  ZERO_ADDRESS,
  authorizationHash,
  decodeSponsorSubject,
  delegationDesignator,
  delegationTarget,
  encodeExecuteCalldata,
  encodeSponsorSubject,
  executeDigest,
  executeTypedData,
  isPinnedSponsorDelegate,
  isSponsorDomain,
  recoverAuthorization,
  recoverExecuteSigner,
  serializeSponsorTx,
  signAuthorization,
  signExecute,
  signSponsorTx,
  sponsorDelegate,
  sponsorSubjectAuthorization,
  sponsorSubjectExecuteInput,
  sponsorTxHash,
  sponsorTxSigningHash,
} from '../src/evm-sponsor/index.ts';
import { TEST_EVM_CHAINS } from '../src/networks.ts';
import { decodeEvmTransaction } from '../src/decode/evm.ts';
import { bigIntBytes, evmSignerAddress, parseEvmTxRequest, rlpEncode, signEvmDigest } from '../src/signers/evm.ts';
import { hashTypedData, normalizeTypedData } from '../src/typed-data.ts';

type Hex = `0x${string}`;
const hex = (b: Uint8Array): Hex => `0x${toHex(b)}`;
const keyOf = (seed: string) => Uint8Array.from(keccak_256(utf8(seed)));
const addr = (seed: string): Hex => checksumEvmAddress(keccak_256(utf8(seed)).subarray(-20));

const D = keyOf('hana-id evm-sponsor unit test account');
const D_OTHER = keyOf('hana-id evm-sponsor unit test other account');
const D_RELAYER = keyOf('hana-id evm-sponsor unit test relayer');
const ACCOUNT = evmSignerAddress(D);
const RELAYER = evmSignerAddress(D_RELAYER);
const VIEM_ACCOUNT = privateKeyToAccount(hex(D));
const VIEM_RELAYER = privateKeyToAccount(hex(D_RELAYER));
const LOCAL = 31337;
const PINNED = SPONSOR_DELEGATES[LOCAL]!.address;
const OTHER = addr('some other contract');
const T1 = addr('target 1');
const T2 = addr('target 2');
/** The local chain's entry is the real deterministic deployment (no placeholder): no test-only option needed. */
const ENABLED = { enabledChains: [LOCAL] } as const;
const N = secp256k1.CURVE.n;
const U64 = (1n << 64n) - 1n;

/** The EvmSponsorError code a call throws (fails the test when it doesn't throw one). */
function codeOf(f: () => unknown): EvmSponsorErrorCode {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(EvmSponsorError);
    const msg = String((e as Error).message);
    // No key material, digest or input value in any refusal.
    for (const k of [D, D_OTHER, D_RELAYER]) expect(msg).not.toContain(toHex(k));
    expect(msg).not.toMatch(/[0-9a-fA-F]{40}/u);
    return (e as EvmSponsorError).code;
  }
  throw new Error('expected a refusal');
}

/** The DecodeError code a call throws. */
function decodeCode(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(DecodeError);
    expect(String((e as Error).message)).not.toMatch(/[0-9a-fA-F]{40}/u);
    return (e as DecodeError).code;
  }
  throw new Error('expected a DecodeError');
}

const baseInput = (over: Partial<ExecuteInput> = {}): ExecuteInput => ({
  chainId: LOCAL,
  account: ACCOUNT,
  implementation: PINNED,
  calls: [
    { to: T1, value: 0n, data: '0x183ff085' },
    { to: T2, value: 0n, data: '0x' },
  ],
  nonce: 7n,
  deadline: 1_800_000_000n,
  relayer: RELAYER,
  minGas: 100_000n,
  ...over,
});

const VIEM_TYPES = {
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
} as const;

const viemTyped = (i: ExecuteInput) => ({
  domain: { name: 'HanaDelegateExecutor', version: '1', chainId: i.chainId, verifyingContract: i.account, salt: `0x${'00'.repeat(12)}${i.implementation.slice(2).toLowerCase()}` as Hex },
  types: VIEM_TYPES,
  primaryType: 'Execute' as const,
  message: { calls: i.calls.map((c) => ({ ...c })), nonce: i.nonce, deadline: i.deadline, relayer: i.relayer, minGas: i.minGas },
});

const ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'calls', type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'relayer', type: 'address' },
      { name: 'minGas', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const bytesOf = (n: number, seed = 1): Hex => hex(Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff));

// ---- delegates ----

describe('pinned delegates', () => {
  it('every entry is well formed; only the local chain has one, the deterministic deployment; Base Sepolia none yet', () => {
    const chains = Object.keys(SPONSOR_DELEGATES).map(Number);
    expect(chains).toEqual([LOCAL]);
    expect(Object.isFrozen(SPONSOR_DELEGATES)).toBe(true);
    expect(sponsorDelegate(84532)).toBeNull();
    for (const [chain, d] of Object.entries(SPONSOR_DELEGATES)) {
      expect(Object.isFrozen(d)).toBe(true);
      expect(Object.hasOwn(TEST_EVM_CHAINS, Number(chain))).toBe(true); // testnet only
      expect(checksumEvmAddress(from0xHex(d.address))).toBe(d.address);
      expect(d.address).not.toBe(ZERO_ADDRESS);
      expect(d.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(d.domain).toEqual(SPONSOR_DELEGATE_DOMAIN);
      expect(d.abiVersion).toBe(SPONSOR_ABI_VERSION);
      // A zero code hash only on a placeholder, and placeholders only on local chains.
      expect(d.runtimeCodeHash === `0x${'0'.repeat(64)}`).toBe(d.placeholder);
      if (d.placeholder) expect(Number(chain)).toBe(LOCAL);
    }
    expect(SPONSOR_DELEGATES[LOCAL]!.placeholder).toBe(false);
  });

  it('every deployed entry is the contract’s checked-in artifact: its CREATE2 address and runtime code hash', () => {
    // contracts/evm-delegate/artifacts/HanaDelegateExecutor.json (generated from the build, checked by its forge test
    // against a real CREATE2 deployment). A contract change moves both; this fails until the pin follows.
    const artifact = JSON.parse(readFileSync(new URL('../../../contracts/evm-delegate/artifacts/HanaDelegateExecutor.json', import.meta.url), 'utf8')) as {
      contractName: string;
      create2: { address: string };
      runtimeCodeHash: string;
      eip712: { name: string; version: string };
    };
    expect(artifact.contractName).toBe('HanaDelegateExecutor');
    expect(artifact.eip712).toMatchObject(SPONSOR_DELEGATE_DOMAIN);
    const deployed = Object.values(SPONSOR_DELEGATES).filter((d) => !d.placeholder);
    expect(deployed.length).toBeGreaterThan(0);
    for (const d of deployed) {
      expect(d.address).toBe(artifact.create2.address);
      expect(d.runtimeCodeHash).toBe(artifact.runtimeCodeHash);
    }
  });

  it('looks up by own chain keys only', () => {
    expect(sponsorDelegate(LOCAL)?.address).toBe(PINNED);
    for (const c of [0, -1, 1.5, Number.NaN, 2 ** 53, 1, 8453]) expect(sponsorDelegate(c)).toBeNull();
    expect(sponsorDelegate('31337' as unknown as number)).toBeNull();
    expect(sponsorDelegate(Number('constructor'))).toBeNull();
    expect(isPinnedSponsorDelegate(LOCAL, PINNED.toLowerCase())).toBe(true);
    expect(isPinnedSponsorDelegate(LOCAL, OTHER)).toBe(false);
    expect(isPinnedSponsorDelegate(84532, PINNED)).toBe(false);
    expect(isPinnedSponsorDelegate(LOCAL, 42 as unknown as string)).toBe(false);
  });
});

// ---- authorization ----

describe('authorizationHash', () => {
  it('matches viem hashAuthorization (chainId 0 included, nonce edges)', () => {
    for (const chainId of [0, 1, LOCAL, 84532, Number.MAX_SAFE_INTEGER]) {
      for (const nonce of [0n, 1n, 127n, 128n, 2n ** 32n, U64 - 1n]) {
        for (const address of [PINNED, OTHER, ZERO_ADDRESS]) {
          // viem types the nonce as a number but encodes a bigint the same way (needed above 2^53).
          expect(hex(authorizationHash({ chainId, address, nonce }))).toBe(hashAuthorization({ chainId, address, nonce: nonce as unknown as number }));
        }
      }
    }
  });

  it('is keccak256(0x05 ‖ rlp([chainId, address, nonce]))', () => {
    const a = { chainId: LOCAL, address: PINNED, nonce: 3n };
    const manual = keccak_256(concatBytes(Uint8Array.of(5), rlpEncode([bigIntBytes(BigInt(LOCAL)), from0xHex(PINNED), bigIntBytes(3n)])));
    expect(hex(authorizationHash(a))).toBe(hex(manual));
  });

  it('refuses malformed tuples', () => {
    for (const bad of [
      { chainId: -1, address: PINNED, nonce: 0n },
      { chainId: 1.5, address: PINNED, nonce: 0n },
      { chainId: 2 ** 53, address: PINNED, nonce: 0n },
      { chainId: LOCAL, address: PINNED, nonce: U64 }, // EIP-7702: nonce < 2^64 − 1
      { chainId: LOCAL, address: PINNED, nonce: -1n },
      { chainId: LOCAL, address: PINNED, nonce: 0 },
      { chainId: LOCAL, address: '0x7702', nonce: 0n },
      { chainId: LOCAL, address: '0x7702000000000000000000000000000000007702 ', nonce: 0n },
    ]) {
      expect(() => authorizationHash(bad as unknown as Authorization)).toThrow(EvmSponsorError);
    }
    // A mixed-case address must carry a valid EIP-55 checksum.
    const badChecksum = OTHER.replace(/[a-f]/u, (ch) => ch.toUpperCase()) as Hex;
    expect(codeOf(() => authorizationHash({ chainId: LOCAL, address: badChecksum, nonce: 0n }))).toBe('invalid_input');
  });
});

describe('signAuthorization', () => {
  it('signs the pinned delegate exactly as viem does, and both recoveries name the account', async () => {
    for (const nonce of [0n, 1n, 1000n, U64 - 1n]) {
      const a = { chainId: LOCAL, address: PINNED, nonce };
      const signed = signAuthorization(D, a, ENABLED);
      expect(Object.isFrozen(signed)).toBe(true);
      expect(signed.address).toBe(PINNED);
      expect(signed.r).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(signed.s).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(BigInt(signed.s) <= N / 2n).toBe(true);
      if (nonce <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const ref = await VIEM_ACCOUNT.signAuthorization({ chainId: LOCAL, address: PINNED, nonce: Number(nonce) });
        expect(BigInt(signed.r)).toBe(BigInt(ref.r));
        expect(BigInt(signed.s)).toBe(BigInt(ref.s));
        expect(signed.yParity).toBe(ref.yParity);
      }
      expect(recoverAuthorization(signed)).toBe(ACCOUNT);
      if (nonce <= BigInt(Number.MAX_SAFE_INTEGER)) expect(await recoverAuthorizationAddress({ authorization: { ...signed, nonce: Number(nonce) } })).toBe(ACCOUNT);
    }
  });

  it('accepts the pinned address in lowercase and returns it EIP-55', () => {
    expect(signAuthorization(D, { chainId: LOCAL, address: PINNED.toLowerCase() as Hex, nonce: 0n }, ENABLED).address).toBe(PINNED);
  });

  it('refuses chainId 0, chains not enabled, chains without a pinned delegate, and any other address', () => {
    const ok = { chainId: LOCAL, address: PINNED, nonce: 0n };
    expect(codeOf(() => signAuthorization(D, { ...ok, chainId: 0 }, { enabledChains: [0, LOCAL] as number[] }))).toBe('chain_id_invalid');
    expect(codeOf(() => signAuthorization(D, { ...ok, chainId: 0 }, ENABLED))).toBe('chain_id_invalid');
    expect(codeOf(() => signAuthorization(D, ok, { enabledChains: [] }))).toBe('chain_not_enabled');
    expect(codeOf(() => signAuthorization(D, ok, { enabledChains: [84532] }))).toBe('chain_not_enabled');
    expect(codeOf(() => signAuthorization(D, { ...ok, chainId: 84532 }, { enabledChains: [84532] }))).toBe('chain_not_enabled');
    expect(codeOf(() => signAuthorization(D, { ...ok, chainId: 1 }, { enabledChains: [1] }))).toBe('chain_not_enabled');
    expect(codeOf(() => signAuthorization(D, { ...ok, address: OTHER }, ENABLED))).toBe('delegate_not_pinned');
    expect(codeOf(() => signAuthorization(D, { ...ok, address: ZERO_ADDRESS }, ENABLED))).toBe('delegate_not_pinned');
    expect(codeOf(() => signAuthorization(D, { ...ok, address: ZERO_ADDRESS }, { ...ENABLED, revoke: false }))).toBe('delegate_not_pinned');
  });

  it('signs the zero address only on the explicit revoke path, and the revoke path only the zero address', async () => {
    const revoke = signAuthorization(D, { chainId: LOCAL, address: ZERO_ADDRESS, nonce: 4n }, { ...ENABLED, revoke: true });
    expect(revoke.address).toBe(ZERO_ADDRESS);
    expect(recoverAuthorization(revoke)).toBe(ACCOUNT);
    const ref = await VIEM_ACCOUNT.signAuthorization({ chainId: LOCAL, address: ZERO_ADDRESS, nonce: 4 });
    expect(BigInt(revoke.r)).toBe(BigInt(ref.r));
    expect(codeOf(() => signAuthorization(D, { chainId: LOCAL, address: PINNED, nonce: 0n }, { ...ENABLED, revoke: true }))).toBe('delegate_not_pinned');
    expect(codeOf(() => signAuthorization(D, { chainId: 0, address: ZERO_ADDRESS, nonce: 0n }, { ...ENABLED, revoke: true }))).toBe('chain_id_invalid');
    expect(codeOf(() => signAuthorization(D, { chainId: 84532, address: ZERO_ADDRESS, nonce: 0n }, { enabledChains: [84532], revoke: true }))).toBe('chain_not_enabled');
    expect(codeOf(() => signAuthorization(D, { chainId: LOCAL, address: ZERO_ADDRESS, nonce: 0n }, { ...ENABLED, revoke: 'true' as unknown as boolean }))).toBe('invalid_input');
  });

  it('refuses malformed options and keys', () => {
    const ok = { chainId: LOCAL, address: PINNED, nonce: 0n };
    for (const opts of [undefined, null, {}, { enabledChains: LOCAL }, { enabledChains: ['31337'] }, { enabledChains: [0] }, { enabledChains: [1.5] }]) {
      expect(codeOf(() => signAuthorization(D, ok, opts as never))).toBe('invalid_input');
    }
    for (const k of [new Uint8Array(32), new Uint8Array(31), from0xHex(`0x${N.toString(16)}`)]) {
      expect(codeOf(() => signAuthorization(k, ok, ENABLED))).toBe('invalid_input');
    }
  });
});

describe('recoverAuthorization', () => {
  const signed = signAuthorization(D, { chainId: LOCAL, address: PINNED, nonce: 9n }, ENABLED);
  const flipS = (s: SignedAuthorization): SignedAuthorization => ({
    ...s,
    s: `0x${(N - BigInt(s.s)).toString(16).padStart(64, '0')}`,
    yParity: s.yParity === 0 ? 1 : 0,
  });

  it('refuses a high s (the same signature, malleated), as EIP-7702 nodes do', () => {
    expect(codeOf(() => recoverAuthorization(flipS(signed)))).toBe('invalid_signature');
  });

  it('refuses bad yParity, r, s', () => {
    const zero = `0x${'0'.repeat(64)}`;
    const nHex = `0x${N.toString(16)}`;
    for (const bad of [
      { yParity: 2 },
      { yParity: 27 },
      { yParity: '0' },
      { r: zero },
      { s: zero },
      { r: nHex },
      { r: signed.r.slice(0, 64) },
      { s: `${signed.s}00` },
      { r: BigInt(signed.r) },
    ]) {
      expect(codeOf(() => recoverAuthorization({ ...signed, ...bad } as unknown as SignedAuthorization))).toBe('invalid_signature');
    }
  });

  it('a signature for one tuple names another address for any other tuple (chain, delegate, nonce bound)', () => {
    for (const change of [{ chainId: 84532 }, { address: OTHER }, { nonce: 10n }, { chainId: 0 }]) {
      expect(recoverAuthorization({ ...signed, ...change })).not.toBe(ACCOUNT);
    }
  });
});

describe('delegation designator', () => {
  it('is 0xef0100 ‖ address and reads back', () => {
    const code = delegationDesignator(PINNED);
    expect(hex(code)).toBe(`0xef0100${PINNED.slice(2).toLowerCase()}`);
    expect(delegationTarget(code)).toBe(PINNED);
    expect(delegationTarget(delegationDesignator(ZERO_ADDRESS))).toBe(ZERO_ADDRESS);
  });

  it('reads anything else as not delegated', () => {
    const code = delegationDesignator(PINNED);
    for (const bad of [new Uint8Array(0), code.subarray(0, 22), concatBytes(code, Uint8Array.of(0)), Uint8Array.of(0xef, 0x01, 0x01, ...code.subarray(3)), Uint8Array.of(0x60, 0x80, 0x60, 0x40)]) {
      expect(delegationTarget(bad)).toBeNull();
    }
    expect(delegationTarget('0xef0100' as unknown as Uint8Array)).toBeNull();
  });
});

// ---- execute ----

describe('executeTypedData and executeDigest', () => {
  const variants: ExecuteInput[] = [
    baseInput(),
    baseInput({ chainId: 84532, implementation: OTHER, nonce: 0n, deadline: 1n, minGas: 0n }),
    baseInput({ calls: [{ to: T1, value: (1n << 256n) - 1n, data: bytesOf(33) }] }),
    baseInput({ nonce: U64, deadline: U64, minGas: U64 }),
    baseInput({ calls: Array.from({ length: EVM_SPONSOR_MAX_CALLS }, (_, i) => ({ to: addr(`t${i}`), value: BigInt(i), data: bytesOf(i * 13, i) })) }),
    baseInput({ calls: [{ to: T1, value: 0n, data: bytesOf(EVM_SPONSOR_MAX_CALL_DATA_BYTES) }] }),
    baseInput({ account: ACCOUNT.toLowerCase() as Hex, relayer: RELAYER.toLowerCase() as Hex, implementation: PINNED.toLowerCase() as Hex }),
  ];

  it('hashes to viem hashTypedData for every variant', () => {
    for (const i of variants) expect(hex(executeDigest(i))).toBe(viemHashTypedData(viemTyped(i)));
  });

  it('is normalized typed data with the exact domain and types, the same object the popup would read', () => {
    const i = baseInput();
    const td = executeTypedData(i);
    expect(td.primaryType).toBe('Execute');
    expect({ ...td.domain }).toEqual({
      name: 'HanaDelegateExecutor',
      version: '1',
      chainId: 31337n,
      verifyingContract: ACCOUNT,
      salt: `0x${'00'.repeat(12)}${PINNED.slice(2).toLowerCase()}`,
    });
    expect(td.types.EIP712Domain!.map((f) => `${f.type} ${f.name}`)).toEqual(['string name', 'string version', 'uint256 chainId', 'address verifyingContract', 'bytes32 salt']);
    // Re-normalizing the dapp-shaped JSON gives the same digest (one reading).
    const json = JSON.stringify(td, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(hex(hashTypedData(normalizeTypedData(json)))).toBe(hex(executeDigest(i)));
  });

  it('binds chain, account, implementation (salt), relayer, minGas, nonce, deadline and every call field', () => {
    const d0 = hex(executeDigest(baseInput()));
    const changes: Partial<ExecuteInput>[] = [
      { chainId: 84532 },
      { account: addr('someone else') },
      { implementation: OTHER },
      { relayer: addr('other relayer') },
      { minGas: 100_001n },
      { nonce: 8n },
      { deadline: 1_800_000_001n },
      { calls: [{ to: T2, value: 0n, data: '0x183ff085' }, { to: T2, value: 0n, data: '0x' }] },
      { calls: [{ to: T1, value: 1n, data: '0x183ff085' }, { to: T2, value: 0n, data: '0x' }] },
      { calls: [{ to: T1, value: 0n, data: '0x183ff086' }, { to: T2, value: 0n, data: '0x' }] },
      { calls: [{ to: T2, value: 0n, data: '0x' }, { to: T1, value: 0n, data: '0x183ff085' }] },
      { calls: [{ to: T1, value: 0n, data: '0x183ff085' }] },
    ];
    const seen = new Set([d0]);
    for (const c of changes) {
      const d = hex(executeDigest(baseInput(c)));
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
  });

  it('refuses malformed input', () => {
    const cases: [Partial<ExecuteInput> | Record<string, unknown>, EvmSponsorErrorCode][] = [
      [{ chainId: 0 }, 'chain_id_invalid'],
      [{ chainId: -5 }, 'chain_id_invalid'],
      [{ chainId: 2 ** 53 }, 'chain_id_invalid'],
      [{ chainId: '31337' }, 'chain_id_invalid'],
      [{ account: ZERO_ADDRESS }, 'invalid_input'],
      [{ implementation: ZERO_ADDRESS }, 'invalid_input'],
      [{ relayer: ZERO_ADDRESS }, 'invalid_input'],
      [{ account: '0x1234' }, 'invalid_input'],
      [{ calls: [] }, 'invalid_input'],
      [{ calls: Array.from({ length: EVM_SPONSOR_MAX_CALLS + 1 }, () => ({ to: T1, value: 0n, data: '0x' })) }, 'invalid_input'],
      [{ calls: [{ to: T1, value: 0n, data: bytesOf(EVM_SPONSOR_MAX_CALL_DATA_BYTES + 1) }] }, 'invalid_input'],
      [{ calls: [{ to: T1, value: 0n, data: '0x1' }] }, 'invalid_input'],
      [{ calls: [{ to: T1, value: 0n, data: 'abcd' }] }, 'invalid_input'],
      [{ calls: [{ to: T1, value: 0n, data: '0xzz' }] }, 'invalid_input'],
      [{ calls: [{ to: T1, value: -1n, data: '0x' }] }, 'invalid_input'],
      [{ calls: [{ to: T1, value: 1n << 256n, data: '0x' }] }, 'invalid_input'],
      [{ calls: [{ to: T1, value: 0, data: '0x' }] }, 'invalid_input'],
      [{ calls: [null] }, 'invalid_input'],
      [{ calls: 'x' }, 'invalid_input'],
      [{ nonce: U64 + 1n }, 'invalid_input'],
      [{ deadline: -1n }, 'invalid_input'],
      [{ minGas: 1 }, 'invalid_input'],
    ];
    for (const [over, code] of cases) expect(codeOf(() => executeTypedData(baseInput(over as Partial<ExecuteInput>)))).toBe(code);
    expect(codeOf(() => executeTypedData(null as unknown as ExecuteInput))).toBe('invalid_input');
  });
});

describe('encodeExecuteCalldata', () => {
  it('matches viem encodeFunctionData and decodes back', () => {
    const sig = signExecute(D, baseInput(), ENABLED);
    expect(EXECUTE_SELECTOR).toBe(toFunctionSelector(EXECUTE_FUNCTION));
    const inputs = [
      baseInput(),
      baseInput({ calls: [{ to: T1, value: 5n, data: '0x' }] }),
      baseInput({ calls: Array.from({ length: 8 }, (_, i) => ({ to: addr(`c${i}`), value: BigInt(i) << 200n, data: bytesOf([0, 1, 31, 32, 33, 64, 65, 1000][i]!, i) })) }),
      baseInput({ nonce: U64, deadline: U64, minGas: U64 }),
    ];
    for (const i of inputs) {
      const data = encodeExecuteCalldata(i, sig);
      const ref = encodeFunctionData({ abi: ABI, functionName: 'execute', args: [i.calls.map((c) => ({ ...c })), i.nonce, i.deadline, i.relayer, i.minGas, sig] });
      expect(data).toBe(ref);
      const back = decodeFunctionData({ abi: ABI, data });
      expect(back.args[5]).toBe(sig);
      expect(encodeExecuteCalldata(i, from0xHex(sig))).toBe(ref);
    }
  });

  it('refuses a malformed signature', () => {
    const sig = signExecute(D, baseInput(), ENABLED);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const highS = `${sig.slice(0, 66)}${(N - s).toString(16).padStart(64, '0')}${sig.slice(130) === '1b' ? '1c' : '1b'}` as Hex;
    for (const bad of [sig.slice(0, 130), `${sig}00`, `${sig.slice(0, 130)}00`, `${sig.slice(0, 130)}01`, `${sig.slice(0, 130)}1d`, highS, `0x${'00'.repeat(64)}1b`, 'nope', 5]) {
      expect(codeOf(() => encodeExecuteCalldata(baseInput(), bad as Hex))).toBe('invalid_signature');
    }
  });
});

describe('signExecute and recoverExecuteSigner', () => {
  it('signs exactly as viem signTypedData; both recoveries name the account', async () => {
    for (const i of [baseInput(), baseInput({ calls: [{ to: T1, value: 0n, data: bytesOf(500) }], nonce: 0n })]) {
      const sig = signExecute(D, i, ENABLED);
      expect(sig).toBe(await VIEM_ACCOUNT.signTypedData(viemTyped(i)));
      expect(recoverExecuteSigner(i, sig)).toBe(ACCOUNT);
      expect(await recoverTypedDataAddress({ ...viemTyped(i), signature: sig })).toBe(ACCOUNT);
      expect(BigInt(`0x${sig.slice(66, 130)}`) <= N / 2n).toBe(true);
    }
  });

  it('refuses anything but the pinned delegate on an enabled chain, value, and another account', () => {
    expect(codeOf(() => signExecute(D, baseInput(), { enabledChains: [] }))).toBe('chain_not_enabled');
    expect(codeOf(() => signExecute(D, baseInput({ chainId: 84532 }), { enabledChains: [84532] }))).toBe('chain_not_enabled');
    expect(codeOf(() => signExecute(D, baseInput({ chainId: 0 }), ENABLED))).toBe('chain_id_invalid');
    expect(codeOf(() => signExecute(D, baseInput({ implementation: OTHER }), ENABLED))).toBe('delegate_not_pinned');
    expect(codeOf(() => signExecute(D, baseInput({ calls: [{ to: T1, value: 1n, data: '0x' }] }), ENABLED))).toBe('value_not_allowed');
    expect(codeOf(() => signExecute(D_OTHER, baseInput(), ENABLED))).toBe('not_own_account');
    expect(codeOf(() => signExecute(D, baseInput(), null as never))).toBe('invalid_input');
  });

  it('a signature verifies for its own Execute only', () => {
    const sig = signExecute(D, baseInput(), ENABLED);
    for (const c of [{ chainId: 84532 }, { implementation: OTHER }, { account: addr('x') }, { nonce: 8n }, { relayer: addr('r2') }]) {
      expect(recoverExecuteSigner(baseInput(c), sig)).not.toBe(ACCOUNT);
    }
  });

  it('recoverExecuteSigner refuses high s, v 0/1 and wrong lengths', () => {
    const sig = signExecute(D, baseInput(), ENABLED);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const highS = `${sig.slice(0, 66)}${(N - s).toString(16).padStart(64, '0')}${sig.endsWith('1b') ? '1c' : '1b'}` as Hex;
    for (const bad of [highS, `${sig.slice(0, 130)}00`, `${sig.slice(0, 130)}01`, sig.slice(0, 130), new Uint8Array(64)]) {
      expect(codeOf(() => recoverExecuteSigner(baseInput(), bad as Hex))).toBe('invalid_signature');
    }
  });
});

// ---- inputs read once ----

describe('the signers read each input field once', () => {
  /** An object whose fields count their reads and change value after the first (a check-then-use attack). */
  function shifty<T extends object>(first: T, later: Partial<T>): { obj: T; reads: Record<string, number> } {
    const reads: Record<string, number> = {};
    const obj = new Proxy(first, {
      get(target, key, receiver) {
        if (typeof key === 'string') {
          reads[key] = (reads[key] ?? 0) + 1;
          if (reads[key]! > 1 && key in later) return (later as Record<string, unknown>)[key];
        }
        return Reflect.get(target, key, receiver);
      },
    });
    return { obj, reads };
  }

  it('signAuthorization signs what it checked', () => {
    const { obj, reads } = shifty({ chainId: LOCAL, address: PINNED, nonce: 0n } as Authorization, { chainId: 1, address: OTHER });
    const signed = signAuthorization(D, obj, ENABLED);
    expect(reads).toEqual({ chainId: 1, address: 1, nonce: 1 });
    expect(recoverAuthorization(signed)).toBe(ACCOUNT);
    expect(signed.chainId).toBe(LOCAL);
  });

  it('signExecute signs what it checked', () => {
    const { obj, reads } = shifty(baseInput(), { implementation: OTHER, chainId: 84532 });
    const sig = signExecute(D, obj, ENABLED);
    for (const k of ['chainId', 'account', 'implementation', 'calls', 'nonce', 'deadline', 'relayer', 'minGas']) expect(reads[k], k).toBe(1);
    expect(recoverExecuteSigner(baseInput(), sig)).toBe(ACCOUNT);
  });
});

// ---- review fixes: placeholder, read once, call targets, keys, large chain ids ----

/**
 * A deep proxy over plain objects and arrays that counts each property read by path (byte arrays are passed through:
 * the module copies them). `reads` maps "path" → count.
 */
function counted<T>(value: T): { obj: T; reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const cache = new WeakMap<object, unknown>();
  const wrap = (v: unknown, path: string): unknown => {
    if (typeof v !== 'object' || v === null || v instanceof Uint8Array) return v;
    if (cache.has(v)) return cache.get(v);
    const p = new Proxy(v, {
      get(target, key, receiver) {
        const out = Reflect.get(target, key, receiver);
        if (typeof key !== 'string') return out;
        const at = `${path}.${key}`;
        reads.set(at, (reads.get(at) ?? 0) + 1);
        return wrap(out, at);
      },
    });
    cache.set(v, p);
    return p;
  };
  return { obj: wrap(value, '$') as T, reads };
}
const overRead = (reads: Map<string, number>) => [...reads].filter(([, n]) => n > 1).map(([k]) => k);

/** An array whose `length` reads 1 the first time and `n` after (a cap checked on one read, used on another). */
function growing<T>(item: T, n: number): T[] {
  let lengthReads = 0;
  const backing = Array.from({ length: n }, () => item);
  return new Proxy(backing, {
    get(target, key, receiver) {
      if (key === 'length') return ++lengthReads === 1 ? 1 : n;
      return Reflect.get(target, key, receiver);
    },
  });
}

describe('the test-only placeholder option (its refusals: test/evm-sponsor-placeholder.test.ts)', () => {
  it('no source outside tests passes the test-only option', () => {
    const repo = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const files = execSync('git ls-files -co --exclude-standard', { cwd: repo, encoding: 'utf8' }).split('\n');
    const code = files.filter((f) => /\.(ts|tsx|mts|js|mjs)$/u.test(f) && !/(^|\/)(test|tests|test-[a-z]+)\//u.test(f) && !/\.test\.[a-z]+$/u.test(f));
    const allowed = new Set(['packages/core/src/evm-sponsor/authorization.ts', 'packages/core/src/evm-sponsor/execute.ts', 'packages/core/src/evm-sponsor/values.ts']);
    const users = code.filter((f) => !allowed.has(f) && existsSync(`${repo}/${f}`) && readFileSync(`${repo}/${f}`, 'utf8').includes('allowPlaceholderDelegateInTests'));
    expect(code.length).toBeGreaterThan(100);
    expect(users).toEqual([]);
  });
});

describe('every caller-supplied object is read once', () => {
  it('signAuthorization (the tuple and the options, revoke included)', () => {
    const t = counted({ chainId: LOCAL, address: ZERO_ADDRESS, nonce: 0n });
    const o = counted({ enabledChains: [LOCAL], revoke: true, allowPlaceholderDelegateInTests: true as const });
    signAuthorization(D, t.obj, o.obj);
    expect(overRead(t.reads)).toEqual([]);
    expect(overRead(o.reads)).toEqual([]);
    // A revoke getter that says undefined first and true after can't get the zero address signed.
    let n = 0;
    const flip = { enabledChains: [LOCAL], allowPlaceholderDelegateInTests: true as const, get revoke() { return ++n === 1 ? undefined : true; } };
    expect(codeOf(() => signAuthorization(D, { chainId: LOCAL, address: ZERO_ADDRESS, nonce: 0n }, flip))).toBe('delegate_not_pinned');
  });

  it('signExecute (the input, each call, the options)', () => {
    const i = counted(baseInput());
    const o = counted({ ...ENABLED, enabledChains: [LOCAL] });
    signExecute(D, i.obj, o.obj);
    expect(overRead(i.reads)).toEqual([]);
    expect(overRead(o.reads)).toEqual([]);
  });

  it('encodeSponsorSubject (a calls array that grows after its cap check is refused or encoded as read)', () => {
    const s = counted(subject());
    encodeSponsorSubject(s.obj);
    expect(overRead(s.reads)).toEqual([]);
    const call = { to: T1, value: 0n, data: '0x' as Hex };
    let out: Uint8Array | null = null;
    try {
      out = encodeSponsorSubject(subject({ calls: growing(call, 20) }));
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
    }
    if (out !== null) expect(decodeSponsorSubject(out).calls.length).toBeLessThanOrEqual(EVM_SPONSOR_MAX_CALLS);
  });

  it('signSponsorTx (the tx, its authorizations, its access list; lists that grow after their cap check)', () => {
    const auth = signAuthorization(D, { chainId: LOCAL, address: PINNED, nonce: 0n }, ENABLED);
    const tx = {
      type: 'eip7702' as const,
      chainId: BigInt(LOCAL),
      nonce: 0n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      gas: 100_000n,
      to: from0xHex(ACCOUNT),
      value: 0n,
      data: new Uint8Array(4),
      accessList: [{ address: from0xHex(T1), storageKeys: [new Uint8Array(32)] }],
      authorizationList: [auth],
    };
    const c = counted(tx);
    signSponsorTx(D_RELAYER, c.obj as SponsorTx);
    expect(overRead(c.reads)).toEqual([]);
    const tooMany = { ...tx, authorizationList: growing(auth, 20) } as SponsorTx;
    let raw: Hex | null = null;
    try {
      raw = signSponsorTx(D_RELAYER, tooMany);
    } catch (e) {
      expect(e).toBeInstanceOf(EvmSponsorError);
    }
    if (raw !== null) expect(parseTransaction(raw).authorizationList!.length).toBeLessThanOrEqual(8);
    const entry = { address: from0xHex(T1), storageKeys: [] as Uint8Array[] };
    let raw2: Hex | null = null;
    try {
      raw2 = signSponsorTx(D_RELAYER, { ...tx, accessList: growing(entry, 100) } as SponsorTx);
    } catch (e) {
      expect(e).toBeInstanceOf(EvmSponsorError);
    }
    if (raw2 !== null) expect(parseTransaction(raw2).accessList!.length).toBeLessThanOrEqual(64);
  });
});

describe('signExecute refuses deadline 0, minGas 0 and calls to the account, the delegate or the zero address', () => {
  it('refuses them', () => {
    expect(codeOf(() => signExecute(D, baseInput({ deadline: 0n }), ENABLED))).toBe('invalid_input');
    expect(codeOf(() => signExecute(D, baseInput({ minGas: 0n }), ENABLED))).toBe('invalid_input');
    for (const to of [ACCOUNT, ACCOUNT.toLowerCase() as Hex, PINNED, ZERO_ADDRESS]) {
      expect(codeOf(() => signExecute(D, baseInput({ calls: [{ to: T1, value: 0n, data: '0x' }, { to, value: 0n, data: '0x' }] }), ENABLED))).toBe('invalid_input');
    }
  });

  it('the builders still accept them (the contract does; the vectors cover it)', () => {
    expect(() => executeDigest(baseInput({ deadline: 0n, minGas: 0n, calls: [{ to: ACCOUNT, value: 0n, data: '0x' }] }))).not.toThrow();
  });
});

describe('chain ids above 2^32', () => {
  const big = [2 ** 32 + 1, 2 ** 40 + 3, Number.MAX_SAFE_INTEGER];
  it('authorization hash and recovery agree with viem', async () => {
    for (const chainId of big) {
      const a = { chainId, address: PINNED, nonce: 1n };
      expect(hex(authorizationHash(a))).toBe(hashAuthorization({ chainId, address: PINNED, nonce: 1 }));
      const sig = signEvmDigest(D, authorizationHash(a));
      const signed: SignedAuthorization = { ...a, yParity: sig[64] === 27 ? 0 : 1, r: hex(sig.subarray(0, 32)), s: hex(sig.subarray(32, 64)) };
      expect(recoverAuthorization(signed)).toBe(ACCOUNT);
      expect(await recoverAuthorizationAddress({ authorization: { ...signed, nonce: 1 } })).toBe(ACCOUNT);
    }
  });

  it('Execute digest and the subject agree with viem / round-trip', () => {
    for (const chainId of big) {
      const i = baseInput({ chainId, implementation: OTHER });
      expect(hex(executeDigest(i))).toBe(viemHashTypedData(viemTyped(i)));
      const s = subject({ chainId });
      expect(decodeSponsorSubject(encodeSponsorSubject(s)).chainId).toBe(chainId);
    }
  });

  it('a type-4 transaction on such a chain signs as viem does', async () => {
    const chainId = 2 ** 40 + 3;
    const a = { chainId, address: PINNED, nonce: 0n };
    const sig = signEvmDigest(D, authorizationHash(a));
    const auth: SignedAuthorization = { ...a, yParity: sig[64] === 27 ? 0 : 1, r: hex(sig.subarray(0, 32)), s: hex(sig.subarray(32, 64)) };
    const tx: SponsorTx = { type: 'eip7702', chainId: BigInt(chainId), nonce: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 90_000n, to: from0xHex(ACCOUNT), value: 0n, data: new Uint8Array(0), accessList: [], authorizationList: [auth] };
    const ref = await VIEM_RELAYER.signTransaction({ type: 'eip7702', chainId, nonce: 1, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 90_000n, to: ACCOUNT, value: 0n, data: '0x', authorizationList: [{ ...auth, nonce: 0 }] } as never);
    expect(signSponsorTx(D_RELAYER, tx)).toBe(ref);
  });
});

describe('invalid keys', () => {
  it('are EvmSponsorError invalid_input in every signer, with no key material', () => {
    const tx: SponsorTx = { type: 'eip1559', chainId: BigInt(LOCAL), nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, gas: 21_000n, to: from0xHex(T1), value: 0n, data: new Uint8Array(0), accessList: [] };
    for (const k of [new Uint8Array(32), new Uint8Array(33).fill(1), from0xHex(`0x${N.toString(16)}`), 'key' as unknown as Uint8Array]) {
      expect(codeOf(() => signAuthorization(k, { chainId: LOCAL, address: PINNED, nonce: 0n }, ENABLED))).toBe('invalid_input');
      expect(codeOf(() => signExecute(k, baseInput(), ENABLED))).toBe('invalid_input');
      expect(codeOf(() => signSponsorTx(k, tx))).toBe('invalid_input');
    }
  });
});

// ---- guard ----

describe('isSponsorDomain', () => {
  const td = (domain: Record<string, unknown>) => {
    const fields = Object.keys(domain).map((name) => ({ name, type: { name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address', salt: 'bytes32' }[name]! }));
    return normalizeTypedData(JSON.stringify({ types: { EIP712Domain: fields, M: [{ name: 'x', type: 'uint256' }] }, primaryType: 'M', domain, message: { x: '1' } }));
  };

  it('matches the delegate name on any version, chain or contract', () => {
    expect(isSponsorDomain(executeTypedData(baseInput()))).toBe(true);
    expect(isSponsorDomain(td({ name: 'HanaDelegateExecutor' }))).toBe(true);
    expect(isSponsorDomain(td({ name: 'HanaDelegateExecutor', version: '2', chainId: '1', verifyingContract: OTHER }))).toBe(true);
  });

  it('does not match other names (the contract accepts only its exact name)', () => {
    for (const name of ['HanaDelegateExecutor ', 'hanadelegateexecutor', 'DelegateExecutor', 'Permit2', '']) expect(isSponsorDomain(td({ name }))).toBe(false);
    expect(isSponsorDomain(td({ version: '1', chainId: '1' }))).toBe(false);
    expect(isSponsorDomain(null as never)).toBe(false);
  });
});

describe('the generic transaction path takes no type-4 transaction (D833)', () => {
  const tx = { chainId: '0x7a69', nonce: '0x0', gas: '0x5208', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', to: T1, value: '0x0', data: '0x' };
  it('parseEvmTxRequest refuses type 0x4 and an authorizationList', () => {
    expect(() => parseEvmTxRequest(tx)).not.toThrow();
    expect(() => parseEvmTxRequest({ ...tx, type: '0x4' })).toThrow();
    expect(() => parseEvmTxRequest({ ...tx, authorizationList: [] })).toThrow('Unknown tx field');
  });
  it("the popup's decoder refuses type-4 bytes as unsupported", () => {
    const auth = signAuthorization(D, { chainId: LOCAL, address: PINNED, nonce: 0n }, ENABLED);
    const t4: SponsorTx = { type: 'eip7702', chainId: BigInt(LOCAL), nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, gas: 100_000n, to: from0xHex(ACCOUNT), value: 0n, data: new Uint8Array(0), accessList: [], authorizationList: [auth] };
    expect(decodeCode(() => decodeEvmTransaction(from0xHex(signSponsorTx(D_RELAYER, t4))))).toBe('unsupported');
  });
});

// ---- subject ----

const subject = (over: Partial<EvmSponsorSubject> = {}): EvmSponsorSubject => ({
  chainId: LOCAL,
  account: ACCOUNT,
  delegate: PINNED,
  authNonce: 0n,
  calls: [{ to: T1, value: 0n, data: '0x183ff085' }],
  executeNonce: 0n,
  deadline: 1_800_000_000n,
  relayer: RELAYER,
  minGas: 100_000n,
  ...over,
});

const PREFIX = utf8(EVM_SPONSOR_SUBJECT_PREFIX);
/** Subject bytes from a hand-built RLP list (to build what encodeSponsorSubject refuses to). */
const raw = (fields: Parameters<typeof toRlp>[0]): Uint8Array => concatBytes(PREFIX, from0xHex(toRlp(fields)));
const goodFields = () =>
  [
    '0x7a69',
    ACCOUNT.toLowerCase(),
    PINNED.toLowerCase(),
    ['0x'],
    [[T1.toLowerCase(), '0x', '0x183ff085']],
    '0x',
    '0x6b49d200',
    RELAYER.toLowerCase(),
    '0x0186a0',
  ] as Hex[] & unknown[];

describe('sponsor subject', () => {
  it('encodes as prefix ‖ rlp([...]) and decodes back to itself', () => {
    const s = subject();
    const b = encodeSponsorSubject(s);
    expect(hex(b)).toBe(hex(raw(goodFields() as never)));
    expect(decodeSponsorSubject(b)).toEqual(s);
    expect(Object.isFrozen(decodeSponsorSubject(b))).toBe(true);
  });

  it('round-trips many shapes; outputs EIP-55 addresses and lowercase data', () => {
    for (const s of [
      subject({ authNonce: null }),
      subject({ authNonce: U64 - 1n, executeNonce: U64, deadline: U64, minGas: 1n }),
      subject({ chainId: Number.MAX_SAFE_INTEGER }),
      subject({ calls: Array.from({ length: EVM_SPONSOR_MAX_CALLS }, (_, i) => ({ to: addr(`c${i}`), value: 0n, data: bytesOf(i === 7 ? EVM_SPONSOR_MAX_CALL_DATA_BYTES : i * 50, i) })) }),
      subject({ chainId: 2 ** 33 + 7 }),
    ]) {
      const b = encodeSponsorSubject(s);
      expect(b.length).toBeLessThanOrEqual(EVM_SPONSOR_SUBJECT_MAX_BYTES);
      expect(decodeSponsorSubject(b)).toEqual(s);
    }
    const lower = subject({ account: ACCOUNT.toLowerCase() as Hex, calls: [{ to: T1.toLowerCase() as Hex, value: 0n, data: '0xABCD' }] });
    const back = decodeSponsorSubject(encodeSponsorSubject(lower));
    expect(back.account).toBe(ACCOUNT);
    expect(back.calls[0]).toEqual({ to: T1, value: 0n, data: '0xabcd' });
  });

  it('keeps "no authorization" and "authorization nonce 0" apart', () => {
    const none = encodeSponsorSubject(subject({ authNonce: null }));
    const zero = encodeSponsorSubject(subject({ authNonce: 0n }));
    expect(hex(none)).not.toBe(hex(zero));
    expect(decodeSponsorSubject(none).authNonce).toBeNull();
    expect(decodeSponsorSubject(zero).authNonce).toBe(0n);
    expect(sponsorSubjectAuthorization(decodeSponsorSubject(none))).toBeNull();
    expect(sponsorSubjectAuthorization(decodeSponsorSubject(zero))).toEqual({ chainId: LOCAL, address: PINNED, nonce: 0n });
  });

  it('maps to the Execute and authorization the wallet signs', () => {
    const s = subject({ executeNonce: 3n });
    const i = sponsorSubjectExecuteInput(s);
    expect(i).toEqual({ chainId: LOCAL, account: ACCOUNT, implementation: PINNED, calls: s.calls, nonce: 3n, deadline: s.deadline, relayer: RELAYER, minGas: s.minGas });
    expect(recoverExecuteSigner(i, signExecute(D, i, ENABLED))).toBe(ACCOUNT);
  });

  it('encode refuses what decode would refuse', () => {
    const bad: Partial<EvmSponsorSubject>[] = [
      { chainId: 0 },
      { account: ZERO_ADDRESS },
      { delegate: ZERO_ADDRESS },
      { relayer: ZERO_ADDRESS },
      { calls: [] },
      { calls: Array.from({ length: 9 }, () => ({ to: T1, value: 0n, data: '0x' as Hex })) },
      { calls: [{ to: T1, value: 1n, data: '0x' }] },
      { calls: [{ to: T1, value: 0n, data: bytesOf(EVM_SPONSOR_MAX_CALL_DATA_BYTES + 1) }] },
      { authNonce: U64 },
      { executeNonce: U64 + 1n },
      { deadline: 0n },
      { minGas: 0n },
      { account: '0xnope' as Hex },
      { calls: [{ to: ZERO_ADDRESS, value: 0n, data: '0x' }] },
      { calls: [{ to: T1, value: 0n, data: '0x' }, { to: ACCOUNT, value: 0n, data: '0x' }] },
      { calls: [{ to: PINNED.toLowerCase() as Hex, value: 0n, data: '0x' }] },
    ];
    for (const over of bad) expect(decodeCode(() => encodeSponsorSubject(subject(over)))).toBe('invalid_value');
  });

  it('refuses hostile bytes', () => {
    const good = encodeSponsorSubject(subject());
    const body = good.subarray(PREFIX.length);
    const f = goodFields;
    const set = (i: number, v: unknown) => {
      const x = f() as unknown[];
      x[i] = v;
      return raw(x as never);
    };
    const cases: [Uint8Array, string][] = [
      [new Uint8Array(0), 'malformed'],
      [PREFIX, 'malformed'],
      [body, 'malformed'], // no prefix
      [concatBytes(utf8('hana-id/evm-sponsored/v2'), body), 'malformed'],
      [concatBytes(good, Uint8Array.of(0)), 'malformed'], // trailing byte
      [good.subarray(0, good.length - 1), 'malformed'], // truncated
      [raw(f().slice(0, 8) as never), 'malformed'],
      [raw([...f(), '0x'] as never), 'malformed'],
      [concatBytes(PREFIX, from0xHex(toRlp('0x1234'))), 'malformed'], // not a list
      [set(0, '0x007a69'), 'invalid_value'], // leading zero
      [set(0, '0x'), 'invalid_value'], // chainId 0
      [set(0, '0x20000000000000'), 'invalid_value'], // 2^53
      [set(1, `0x${'00'.repeat(20)}`), 'invalid_value'], // zero account
      [set(1, ACCOUNT.toLowerCase().slice(0, 40)), 'invalid_value'], // 19 bytes
      [set(1, [ACCOUNT.toLowerCase()]), 'malformed'],
      [set(2, `0x${'00'.repeat(20)}`), 'invalid_value'],
      [set(3, '0x'), 'malformed'], // authNonce must be a list
      [set(3, ['0x', '0x01']), 'malformed'],
      [set(3, [['0x']]), 'malformed'],
      [set(3, ['0xffffffffffffffff']), 'invalid_value'], // 2^64 − 1
      [set(4, []), 'invalid_value'],
      [set(4, '0x'), 'malformed'],
      [set(4, Array.from({ length: 9 }, () => [T1.toLowerCase(), '0x', '0x'])), 'invalid_value'],
      [set(4, [[T1.toLowerCase(), '0x01', '0x']]), 'invalid_value'], // value 1
      [set(4, [[T1.toLowerCase(), '0x00', '0x']]), 'invalid_value'], // value 0 written non-canonically
      [set(4, [[T1.toLowerCase(), '0x']]), 'malformed'],
      [set(4, [[T1.toLowerCase(), '0x', '0x', '0x']]), 'malformed'],
      [set(4, [[T1.toLowerCase(), '0x', ['0x']]]), 'malformed'],
      [set(4, [T1.toLowerCase()]), 'malformed'],
      [set(4, [[T1.toLowerCase(), '0x', bytesOf(EVM_SPONSOR_MAX_CALL_DATA_BYTES + 1)]]), 'too_large'],
      [set(5, '0x010000000000000000'), 'invalid_value'], // 2^64
      [set(6, '0x'), 'invalid_value'], // deadline 0
      [set(4, [[`0x${'00'.repeat(20)}`, '0x', '0x']]), 'invalid_value'], // call to the zero address
      [set(4, [[ACCOUNT.toLowerCase(), '0x', '0x']]), 'invalid_value'], // call to the account itself
      [set(4, [[PINNED.toLowerCase(), '0x', '0x']]), 'invalid_value'], // call to the delegate
      [set(7, `0x${'00'.repeat(20)}`), 'invalid_value'], // zero relayer
      [set(8, '0x'), 'invalid_value'], // minGas 0
      [set(8, ['0x01']), 'malformed'],
      [new Uint8Array(EVM_SPONSOR_SUBJECT_MAX_BYTES + 1), 'too_large'],
    ];
    for (const [b, code] of cases) expect(decodeCode(() => decodeSponsorSubject(b))).toBe(code);
    expect(decodeCode(() => decodeSponsorSubject('0x00' as unknown as Uint8Array))).toBe('malformed');
  });

  it('refuses non-canonical RLP (a single byte as a string, long forms for short lengths)', () => {
    const enc = (item: unknown) => from0xHex(toRlp(item as never));
    const header = (len: number, offset: number) => (len < 56 ? Uint8Array.of(offset + len) : Uint8Array.of(offset + 56, len));
    const listOf = (...items: Uint8Array[]) => {
      const p = concatBytes(...items);
      return concatBytes(header(p.length, 0xc0), p);
    };
    const f = goodFields() as unknown[];
    const fields = (replace: Record<number, Uint8Array>) => f.map((x, i) => replace[i] ?? enc(x));
    // The hand-built encoder agrees with the canonical one when nothing is replaced.
    expect(hex(concatBytes(PREFIX, listOf(...fields({}))))).toBe(hex(encodeSponsorSubject(subject())));
    const cases = [
      fields({ 5: Uint8Array.of(0x81, 0x05) }), // executeNonce 5 as a one-byte string
      fields({ 5: Uint8Array.of(0x00) }), // executeNonce 0 as the byte 0x00
      fields({ 0: Uint8Array.of(0xb8, 0x02, 0x7a, 0x69) }), // long form for a 2-byte string
      fields({ 4: listOf(listOf(enc(T1.toLowerCase()), enc('0x'), Uint8Array.of(0xb8, 0x04, 0x18, 0x3f, 0xf0, 0x85))) }),
      fields({ 3: Uint8Array.of(0xf8, 0x01, 0x80) }), // long form for a 1-byte list
    ];
    for (const c of cases) expect(decodeCode(() => decodeSponsorSubject(concatBytes(PREFIX, listOf(...c))))).toMatch(/^(malformed|invalid_value)$/u);
    // The outer list in long form though short (move one field out so it is under 56 bytes is not possible here: the
    // list is long, so write its length with a leading zero instead).
    const body = concatBytes(...fields({}));
    expect(body.length).toBeGreaterThan(55);
    const lenBytes = bigIntBytes(BigInt(body.length));
    const leadingZero = concatBytes(Uint8Array.of(0xf7 + lenBytes.length + 1, 0), lenBytes, body);
    expect(decodeCode(() => decodeSponsorSubject(concatBytes(PREFIX, leadingZero)))).toBe('malformed');
  });

  it('every single-byte change either fails to decode or is the unique encoding of what it decodes to', () => {
    const good = encodeSponsorSubject(subject({ calls: [{ to: T1, value: 0n, data: '0x183ff085' }, { to: T2, value: 0n, data: bytesOf(60) }] }));
    for (let i = 0; i < good.length; i++) {
      for (const flip of [0x01, 0x80, 0xff]) {
        const b = Uint8Array.from(good);
        b[i] = b[i]! ^ flip;
        let s: EvmSponsorSubject | null = null;
        try {
          s = decodeSponsorSubject(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
        if (s !== null) expect(hex(encodeSponsorSubject(s))).toBe(hex(b));
      }
    }
    for (let n = 0; n < good.length; n++) expect(() => decodeSponsorSubject(good.subarray(0, n))).toThrow(DecodeError);
  });
});

// ---- relayer transactions ----

describe('relayer transactions', () => {
  const auth = signAuthorization(D, { chainId: LOCAL, address: PINNED, nonce: 0n }, ENABLED);
  const calldata = encodeExecuteCalldata(baseInput(), signExecute(D, baseInput(), ENABLED));
  const base = {
    chainId: BigInt(LOCAL),
    nonce: 12n,
    maxPriorityFeePerGas: 10_000_000n,
    maxFeePerGas: 1_000_000_000n,
    gas: 300_000n,
    to: from0xHex(ACCOUNT),
    value: 0n,
    data: from0xHex(calldata),
    accessList: [{ address: from0xHex(T1), storageKeys: [new Uint8Array(32).fill(1)] }],
  };
  const t4: SponsorTx = { type: 'eip7702', ...base, authorizationList: [auth] };
  const t2: SponsorTx = { type: 'eip1559', ...base };
  const viemTx = (tx: SponsorTx) => ({
    type: tx.type,
    chainId: Number(tx.chainId),
    nonce: Number(tx.nonce),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    maxFeePerGas: tx.maxFeePerGas,
    gas: tx.gas,
    to: hex(tx.to!),
    value: tx.value,
    data: hex(tx.data),
    accessList: tx.accessList.map((e) => ({ address: hex(e.address), storageKeys: e.storageKeys.map(hex) })),
    ...(tx.type === 'eip7702' ? { authorizationList: tx.authorizationList.map((a) => ({ ...a, nonce: Number(a.nonce) })) } : {}),
  });

  it('type 4 and type 2 sign exactly as viem signTransaction, and parse back', async () => {
    for (const tx of [t4, t2, { ...t4, authorizationList: [auth, signAuthorization(D_OTHER, { chainId: LOCAL, address: PINNED, nonce: 7n }, ENABLED)] }, { ...t2, accessList: [] }]) {
      const ours = signSponsorTx(D_RELAYER, tx as SponsorTx);
      const ref = await VIEM_RELAYER.signTransaction(viemTx(tx as SponsorTx) as never);
      expect(ours).toBe(ref);
      expect(sponsorTxHash(ours)).toBe(keccak256(ref));
      const parsed = parseTransaction(ours);
      expect(parsed.type).toBe(tx.type);
      expect(parsed.to?.toLowerCase()).toBe(ACCOUNT.toLowerCase());
      expect(parsed.data).toBe(calldata);
    }
    const parsed4 = parseTransaction(signSponsorTx(D_RELAYER, t4));
    expect(parsed4.authorizationList?.[0]?.address.toLowerCase()).toBe(PINNED.toLowerCase());
  });

  it('the signing hash is keccak256 of viem serializeTransaction (unsigned)', async () => {
    const { serializeTransaction } = await import('viem');
    for (const tx of [t4, t2]) expect(hex(sponsorTxSigningHash(tx))).toBe(keccak256(serializeTransaction(viemTx(tx) as never)));
  });

  it('serializeSponsorTx refuses a bad signature', () => {
    for (const sig of [{ yParity: 2, r: 1n, s: 1n }, { yParity: 0, r: 0n, s: 1n }, { yParity: 0, r: 1n, s: N / 2n + 1n }, { yParity: 0, r: '1', s: 1n }]) {
      expect(codeOf(() => serializeSponsorTx(t4, sig as never))).toBe('invalid_signature');
    }
  });

  it('refuses malformed or unsafe transactions', () => {
    const highS = { ...auth, s: `0x${(N - BigInt(auth.s)).toString(16).padStart(64, '0')}` as Hex, yParity: auth.yParity === 0 ? 1 : 0 } as SignedAuthorization;
    const cases: [SponsorTx | Record<string, unknown>, EvmSponsorErrorCode][] = [
      [{ ...t4, authorizationList: [] }, 'invalid_input'],
      [{ ...t4, authorizationList: Array.from({ length: 9 }, () => auth) }, 'invalid_input'],
      [{ ...t4, authorizationList: [{ ...auth, chainId: 84532 }] }, 'chain_id_invalid'],
      [{ ...t4, authorizationList: [{ ...auth, chainId: 0 }] }, 'chain_id_invalid'],
      [{ ...t4, authorizationList: [highS] }, 'invalid_signature'],
      [{ ...t4, authorizationList: [{ ...auth, yParity: 3 }] }, 'invalid_signature'],
      [{ ...t4, to: null }, 'invalid_input'],
      [{ ...t2, to: null }, 'invalid_input'],
      [{ ...t2, to: new Uint8Array(19) }, 'invalid_input'],
      [{ ...t2, chainId: 0n }, 'chain_id_invalid'],
      [{ ...t2, chainId: 31337 }, 'invalid_input'],
      [{ ...t2, nonce: U64 }, 'invalid_input'],
      [{ ...t2, gas: U64 + 1n }, 'invalid_input'],
      [{ ...t2, maxPriorityFeePerGas: 2_000_000_000n }, 'invalid_input'],
      [{ ...t2, data: new Uint8Array(128 * 1024 + 1) }, 'invalid_input'],
      [{ ...t2, data: '0x' }, 'invalid_input'],
      [{ ...t2, accessList: [{ address: new Uint8Array(20), storageKeys: [new Uint8Array(31)] }] }, 'invalid_input'],
      [{ ...t2, type: 'legacy' }, 'invalid_input'],
    ];
    for (const [tx, code] of cases) expect(codeOf(() => signSponsorTx(D_RELAYER, tx as SponsorTx))).toBe(code);
    expect(codeOf(() => sponsorTxHash('0x' as Hex))).toBe('invalid_input');
  });
});
