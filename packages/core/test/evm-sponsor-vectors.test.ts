// src/evm-sponsor against the shared vector file (test/vectors/evm-sponsor-v1.json, written with viem only by
// scripts/gen-evm-sponsor-vectors.mjs). The delegate's forge test reads the same inputs and must reach the same digest
// and accept the same calldata (docs/decisions.md D846).
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { from0xHex, toHex, utf8 } from '../src/bytes.ts';
import {
  EXECUTE_FUNCTION,
  EXECUTE_SELECTOR,
  EXECUTE_TYPE,
  EVM_SPONSOR_SUBJECT_PREFIX,
  type ExecuteInput,
  SPONSOR_DELEGATE_DOMAIN,
  type SponsorTx,
  authorizationHash,
  decodeSponsorSubject,
  encodeExecuteCalldata,
  encodeSponsorSubject,
  executeDigest,
  executeTypedData,
  recoverAuthorization,
  recoverExecuteSigner,
  signAuthorization,
  signExecute,
  signSponsorTx,
  sponsorSubjectAuthorization,
  sponsorSubjectExecuteInput,
  sponsorTxHash,
  sponsorTxSigningHash,
} from '../src/evm-sponsor/index.ts';
import { evmSignerAddress, signEvmDigest } from '../src/signers/evm.ts';
import { encodeTypedDataType, typedDataDomainSeparator } from '../src/typed-data.ts';
import { readJson } from './helpers.ts';

type Hex = `0x${string}`;
interface VectorCase {
  name: string;
  walletSigns: boolean;
  inputs: { chainId: number; account: Hex; implementation: Hex; calls: { to: Hex; value: string; data: Hex }[]; nonce: string; deadline: string; relayer: Hex; minGas: string };
  domainSeparator: Hex;
  structHash: Hex;
  digest: Hex;
  signature: Hex;
  calldata: Hex;
  authorization: null | { chainId: number; address: Hex; nonce: string; hash: Hex; yParity: 0 | 1; r: Hex; s: Hex };
  subject: Hex | null;
  relayerTx: null | {
    type: 'eip1559' | 'eip7702';
    chainId: number;
    nonce: number;
    gas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    to: Hex;
    value: string;
    data: Hex;
    authorizationCount: number;
    unsigned: Hex;
    raw: Hex;
    hash: Hex;
  };
}
interface Vectors {
  version: number;
  contract: { name: string; version: string; domainType: string; domainTypeHash: Hex; executeType: string; executeTypeHash: Hex; callTypeHash: Hex; function: string; selector: Hex };
  keyDerivation: string;
  accountKeySeed: string;
  account: Hex;
  relayerKeySeed: string;
  relayer: Hex;
  subjectPrefix: string;
  cases: VectorCase[];
}

const V = readJson<Vectors>('vectors/evm-sponsor-v1.json');
const keyOf = (seed: string) => Uint8Array.from(keccak_256(utf8(seed)));
const ACCOUNT_KEY = keyOf(V.accountKeySeed);
const RELAYER_KEY = keyOf(V.relayerKeySeed);
const hex = (b: Uint8Array) => `0x${toHex(b)}`;

const inputOf = (c: VectorCase): ExecuteInput => ({
  chainId: c.inputs.chainId,
  account: c.inputs.account,
  implementation: c.inputs.implementation,
  calls: c.inputs.calls.map((x) => ({ to: x.to, value: BigInt(x.value), data: x.data })),
  nonce: BigInt(c.inputs.nonce),
  deadline: BigInt(c.inputs.deadline),
  relayer: c.inputs.relayer,
  minGas: BigInt(c.inputs.minGas),
});

describe('evm-sponsor-v1.json', () => {
  it('pins the contract interface this module codes against', () => {
    expect(V.version).toBe(1);
    expect(V.contract.name).toBe(SPONSOR_DELEGATE_DOMAIN.name);
    expect(V.contract.version).toBe(SPONSOR_DELEGATE_DOMAIN.version);
    expect(V.contract.executeType).toBe(EXECUTE_TYPE);
    expect(V.contract.function).toBe(EXECUTE_FUNCTION);
    expect(V.contract.selector).toBe(EXECUTE_SELECTOR);
    expect(V.contract.executeTypeHash).toBe(hex(keccak_256(utf8(EXECUTE_TYPE))));
    expect(V.contract.domainTypeHash).toBe(hex(keccak_256(utf8(V.contract.domainType))));
    expect(V.subjectPrefix).toBe(EVM_SPONSOR_SUBJECT_PREFIX);
    expect(evmSignerAddress(ACCOUNT_KEY)).toBe(V.account);
    expect(evmSignerAddress(RELAYER_KEY)).toBe(V.relayer);
    expect(V.cases.length).toBe(3);
  });

  for (const c of V.cases) {
    describe(c.name, () => {
      const input = inputOf(c);

      it('typed data: type string, domain separator, digest', () => {
        const td = executeTypedData(input);
        expect(`${encodeTypedDataType(td.types, 'Execute')}`).toBe(EXECUTE_TYPE);
        expect(hex(typedDataDomainSeparator(td))).toBe(c.domainSeparator);
        expect(hex(executeDigest(input))).toBe(c.digest);
      });

      it('signature, recovery and calldata', () => {
        expect(hex(signEvmDigest(ACCOUNT_KEY, executeDigest(input)))).toBe(c.signature);
        expect(recoverExecuteSigner(input, c.signature)).toBe(V.account);
        expect(encodeExecuteCalldata(input, c.signature)).toBe(c.calldata);
        if (c.walletSigns) expect(signExecute(ACCOUNT_KEY, input, { enabledChains: [c.inputs.chainId] })).toBe(c.signature);
        else expect(() => signExecute(ACCOUNT_KEY, input, { enabledChains: [c.inputs.chainId] })).toThrow();
      });

      it('authorization', () => {
        if (c.authorization === null) return;
        const a = { chainId: c.authorization.chainId, address: c.authorization.address, nonce: BigInt(c.authorization.nonce) };
        expect(hex(authorizationHash(a))).toBe(c.authorization.hash);
        const signed = signAuthorization(ACCOUNT_KEY, a, { enabledChains: [a.chainId] });
        expect({ yParity: signed.yParity, r: signed.r, s: signed.s }).toEqual({ yParity: c.authorization.yParity, r: c.authorization.r, s: c.authorization.s });
        expect(recoverAuthorization(signed)).toBe(V.account);
      });

      it('subject', () => {
        if (c.subject === null) return;
        const s = decodeSponsorSubject(from0xHex(c.subject));
        expect(hex(encodeSponsorSubject(s))).toBe(c.subject);
        expect(sponsorSubjectExecuteInput(s)).toEqual(input);
        const auth = sponsorSubjectAuthorization(s);
        expect(auth === null ? null : { ...auth, nonce: auth.nonce.toString() }).toEqual(
          c.authorization === null ? null : { chainId: c.authorization.chainId, address: c.authorization.address, nonce: c.authorization.nonce },
        );
      });

      it('relayer transaction', () => {
        const t = c.relayerTx;
        if (t === null) return;
        const signed = c.authorization ? signAuthorization(ACCOUNT_KEY, { chainId: c.authorization.chainId, address: c.authorization.address, nonce: BigInt(c.authorization.nonce) }, { enabledChains: [c.authorization.chainId] }) : null;
        const base = {
          chainId: BigInt(t.chainId),
          nonce: BigInt(t.nonce),
          maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
          maxFeePerGas: BigInt(t.maxFeePerGas),
          gas: BigInt(t.gas),
          to: from0xHex(t.to),
          value: BigInt(t.value),
          data: from0xHex(t.data),
          accessList: [],
        };
        const tx: SponsorTx = t.type === 'eip7702' ? { type: 'eip7702', ...base, authorizationList: [signed!] } : { type: 'eip1559', ...base };
        expect(t.data).toBe(c.calldata);
        expect(hex(sponsorTxSigningHash(tx))).toBe(hex(keccak_256(from0xHex(t.unsigned))));
        const raw = signSponsorTx(RELAYER_KEY, tx);
        expect(raw).toBe(t.raw);
        expect(sponsorTxHash(raw)).toBe(t.hash);
      });
    });
  }
});
