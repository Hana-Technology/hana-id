// The NEAR codec (src/near/codec.ts) and signers (src/near/sign.ts) against @near-js/transactions, @near-js/crypto and
// borsh (test-only dependencies): every action kind round-trips byte for byte, the hashes match, and the signatures
// equal the ones near-api-js's KeyPairSigner makes (written out below as it does them: Ed25519 is deterministic).
// Strictness: trailing bytes, short inputs, bad tags, invalid UTF-8, invalid account ids and oversize inputs are
// refused.
import { KeyPair, KeyPairEd25519, KeyType, PublicKey } from '@near-js/crypto';
import {
  type DelegateAction,
  GlobalContractDeployMode,
  GlobalContractIdentifier,
  SCHEMA,
  Signature,
  SignedDelegate,
  SignedTransaction,
  type Transaction,
  actionCreators,
  buildDelegateAction,
  createTransaction,
  encodeDelegateAction,
  encodeSignedDelegate,
  encodeTransaction,
} from '@near-js/transactions';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { base64Decode, concatBytes, fromHex, sha256, toHex, u32le, utf8 } from '../src/bytes.ts';
import { DecodeError } from '../src/decode/errors.ts';
import {
  NEAR_MAX_ACTIONS,
  NEAR_MAX_BYTES,
  NEP366_SIGNING_PREFIX,
  NEP413_TAG,
  type NearAction,
  decodeNearDelegateAction,
  decodeNearSignedDelegateAction,
  decodeNearSignedTransaction,
  decodeNearTransaction,
  decodeNep413Message,
  encodeNearDelegateAction,
  encodeNearTransaction,
  encodeNep413Message,
  nearDelegateActionHash,
  nearDelegateActionMessage,
  nearKeyString,
  nearTransactionHashString,
  nep413Hash,
} from '../src/near/codec.ts';
import { signNearDelegateAction, signNearTransaction, signNep413Message } from '../src/near/sign.ts';
import { readText } from './helpers.ts';
import { serialize } from 'borsh';

const NV = JSON.parse(readText('vectors/derivation-v1-near.json')) as { vectors: { accounts: { near: { seedHex: string; accountId: string; publicKey: string; exportBase58: string } }[] }[] };
const ME = NV.vectors[0]!.accounts[0]!.near;
const SEED = fromHex(ME.seedHex);
const KP = KeyPair.fromString(`ed25519:${ME.exportBase58}`) as KeyPairEd25519;
const PK = PublicKey.fromString(ME.publicKey);

/** near-api-js's KeyPairSigner (@near-js/signers 2.5.1), written out: its package can't be installed here alone. */
class KeyPairSigner {
  constructor(private readonly key: KeyPair) {}
  async signTransaction(t: Transaction): Promise<[Uint8Array, SignedTransaction]> {
    const hash = sha256(encodeTransaction(t));
    return [hash, new SignedTransaction({ transaction: t, signature: new Signature({ keyType: KeyType.ED25519, data: this.key.sign(hash).signature }) })];
  }
  async signDelegateAction(d: DelegateAction): Promise<[Uint8Array, SignedDelegate]> {
    const hash = sha256(encodeDelegateAction(d));
    return [hash, new SignedDelegate({ delegateAction: d, signature: new Signature({ keyType: KeyType.ED25519, data: this.key.sign(hash).signature }) })];
  }
  async signNep413Message(message: string, accountId: string, recipient: string, nonce: Uint8Array, callbackUrl?: string): Promise<{ accountId: string; signature: Uint8Array }> {
    const schema = { struct: { message: 'string', nonce: { array: { type: 'u8', len: 32 } }, recipient: 'string', callbackUrl: { option: 'string' } } } as const;
    const bytes = concatBytes(serialize('u32', 2147484061), serialize(schema, { message, nonce, recipient, callbackUrl }));
    return { accountId, signature: this.key.sign(sha256(bytes)).signature };
  }
}
const OTHER = KeyPair.fromString(`ed25519:${NV.vectors[1]!.accounts[0]!.near.exportBase58}`);
const SECP = PublicKey.fromString(`secp256k1:${base58.encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1))}`);
const BLOCK = sha256(utf8('a block'));
const { createAccount, deployContract, functionCall, transfer, stake, addKey, deleteKey, deleteAccount, fullAccessKey, functionCallAccessKey, signedDelegate, deployGlobalContract, useGlobalContract } = actionCreators;

const decodeCode = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof DecodeError ? e.code : `not a DecodeError: ${(e as Error).message}`;
  }
  return 'no error';
};

function innerDelegate() {
  return buildDelegateAction({ senderId: 'bob.testnet', receiverId: 'guestbook.testnet', actions: [functionCall('add_message', { text: 'hi' }, 30_000_000_000_000n, 0n)], nonce: 7n, maxBlockHeight: 1000n, publicKey: OTHER.getPublicKey() });
}

const ACTIONS = {
  createAccount: () => createAccount(),
  deployContract: () => deployContract(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])),
  functionCall: () => functionCall('add_message', { text: 'gm' }, 30_000_000_000_000n, 10n ** 24n),
  functionCallBinaryArgs: () => functionCall('raw', Uint8Array.from([0xff, 0, 1]), 1n, 0n),
  transfer: () => transfer(2_500_000_000_000_000_000_000_000n),
  transferMax: () => transfer((1n << 128n) - 1n),
  stake: () => stake(10n ** 24n, PK),
  addKeyFull: () => addKey(OTHER.getPublicKey(), fullAccessKey()),
  addKeyFunctionCall: () => addKey(OTHER.getPublicKey(), functionCallAccessKey('guestbook.testnet', ['add_message', 'x'], 250_000_000_000_000_000_000_000n)),
  addKeyFunctionCallNoAllowance: () => addKey(SECP, functionCallAccessKey('guestbook.testnet', [])),
  deleteKey: () => deleteKey(OTHER.getPublicKey()),
  deleteAccount: () => deleteAccount('bob.testnet'),
  signedDelegate: () => signedDelegate({ delegateAction: innerDelegate(), signature: new Signature({ keyType: KeyType.ED25519, data: new Uint8Array(64).fill(7) }) }),
  deployGlobalContractHash: () => deployGlobalContract(Uint8Array.from([1, 2, 3]), new GlobalContractDeployMode({ CodeHash: null })),
  deployGlobalContractAccount: () => deployGlobalContract(Uint8Array.from([1, 2, 3]), new GlobalContractDeployMode({ AccountId: null })),
  useGlobalContractHash: () => useGlobalContract(new GlobalContractIdentifier({ CodeHash: new Uint8Array(32).fill(9) })),
  useGlobalContractAccount: () => useGlobalContract(new GlobalContractIdentifier({ AccountId: 'global.testnet' })),
};

const tx = (actions: ReturnType<(typeof ACTIONS)[keyof typeof ACTIONS]>[], signer = ME.accountId, pk = PK) => createTransaction(signer, pk, 'guestbook.testnet', 12345678901234n, actions, BLOCK);

describe('NEAR Transaction', () => {
  it.each(Object.entries(ACTIONS))('%s: decodes what near-api-js encodes, and encodes back to the same bytes', (_, make) => {
    const bytes = encodeTransaction(tx([make()]));
    const d = decodeNearTransaction(bytes);
    expect(d.signerId).toBe(ME.accountId);
    expect(nearKeyString(d.publicKey)).toBe(ME.publicKey);
    expect(d.nonce).toBe(12345678901234n);
    expect(d.receiverId).toBe('guestbook.testnet');
    expect(toHex(d.blockHash)).toBe(toHex(BLOCK));
    expect(d.actions).toHaveLength(1);
    expect(toHex(encodeNearTransaction(d))).toBe(toHex(bytes));
  });

  it('decodes each action into the fields near-api-js put in', () => {
    const all = Object.values(ACTIONS).map((m) => m());
    const d = decodeNearTransaction(encodeTransaction(tx(all)));
    const byType = (t: NearAction['type']) => d.actions.filter((a) => a.type === t);
    expect(byType('createAccount')).toEqual([{ type: 'createAccount' }]);
    const fc = byType('functionCall')[0] as Extract<NearAction, { type: 'functionCall' }>;
    expect(fc.methodName).toBe('add_message');
    expect(new TextDecoder().decode(fc.args)).toBe('{"text":"gm"}');
    expect([fc.gas, fc.deposit]).toEqual([30_000_000_000_000n, 10n ** 24n]);
    expect(byType('transfer').map((a) => (a as { deposit: bigint }).deposit)).toEqual([2_500_000_000_000_000_000_000_000n, (1n << 128n) - 1n]);
    const [full, fcKey, noAllowance] = byType('addKey') as Extract<NearAction, { type: 'addKey' }>[];
    expect(full!.accessKey.permission).toEqual({ type: 'fullAccess' });
    expect(fcKey!.accessKey.permission).toEqual({ type: 'functionCall', allowance: 250_000_000_000_000_000_000_000n, receiverId: 'guestbook.testnet', methodNames: ['add_message', 'x'] });
    expect(noAllowance!.accessKey.permission).toEqual({ type: 'functionCall', allowance: null, receiverId: 'guestbook.testnet', methodNames: [] });
    expect(nearKeyString(noAllowance!.publicKey)).toBe(SECP.toString());
    expect(byType('deleteAccount')).toEqual([{ type: 'deleteAccount', beneficiaryId: 'bob.testnet' }]);
    const del = byType('delegate')[0] as Extract<NearAction, { type: 'delegate' }>;
    expect(del.signedDelegate.delegateAction.senderId).toBe('bob.testnet');
    expect(del.signedDelegate.delegateAction.maxBlockHeight).toBe(1000n);
    expect(byType('deployGlobalContract').map((a) => (a as { deployMode: string }).deployMode)).toEqual(['codeHash', 'accountId']);
    expect(byType('useGlobalContract').map((a) => (a as { contract: { type: string } }).contract.type)).toEqual(['codeHash', 'accountId']);
  });

  it('signNearTransaction: same signature, signed transaction and hash as near-api-js', async () => {
    const t = tx([transfer(1n), functionCall('add_message', { text: 'gm' }, 1n, 0n)]);
    const bytes = encodeTransaction(t);
    const [hash, signed] = await new KeyPairSigner(KP).signTransaction(t);
    const mine = signNearTransaction(SEED, bytes);
    expect(mine.hash).toBe(base58.encode(hash));
    expect(mine.hash).toBe(nearTransactionHashString(bytes));
    expect(toHex(base64Decode(mine.signedTransaction))).toBe(toHex(encodeTransaction(signed)));
    expect(toHex(base64Decode(mine.signature))).toBe(toHex(signed.signature.data));
    const back = decodeNearSignedTransaction(base64Decode(mine.signedTransaction));
    expect(back.transactionLength).toBe(bytes.length);
    expect(back.signature.type).toBe('ed25519');
    expect(KP.verify(hash, back.signature.bytes)).toBe(true);
  });

  it('signNearTransaction refuses a transaction for another key', () => {
    expect(() => signNearTransaction(SEED, encodeTransaction(tx([transfer(1n)], ME.accountId, OTHER.getPublicKey())))).toThrow(/not this key/);
  });

  it('refuses TransactionV1 (priority fee) as unsupported', () => {
    const v0 = encodeTransaction(tx([transfer(1n)]));
    const v1 = concatBytes(Uint8Array.of(1), v0, new Uint8Array(8));
    expect(decodeCode(() => decodeNearTransaction(v1))).toBe('unsupported');
  });

  it.each([
    ['trailing byte', (b: Uint8Array) => concatBytes(b, Uint8Array.of(0)), 'malformed'],
    ['one byte short', (b: Uint8Array) => b.subarray(0, b.length - 1), 'malformed'],
    ['empty', () => new Uint8Array(0), 'malformed'],
    ['oversize', () => new Uint8Array(NEAR_MAX_BYTES + 1), 'too_large'],
  ] as const)('refuses: %s', (_, mutate, code) => {
    const b = encodeTransaction(tx([transfer(1n)]));
    expect(decodeCode(() => decodeNearTransaction(mutate(b)))).toBe(code);
  });

  it('refuses unknown action tags (11 on: deterministic state init, gas keys) as unsupported', () => {
    const b = encodeTransaction(tx([createAccount()]));
    for (const tag of [11, 12, 255]) {
      const m = Uint8Array.from(b);
      m[m.length - 1] = tag;
      expect(decodeCode(() => decodeNearTransaction(m))).toBe('unsupported');
    }
  });

  it('refuses unknown key types, permission tags, option tags and deploy modes', () => {
    const b = encodeTransaction(tx([createAccount()]));
    const keyTypeAt = 4 + ME.accountId.length;
    const m = Uint8Array.from(b);
    m[keyTypeAt] = 2;
    expect(decodeCode(() => decodeNearTransaction(m))).toBe('unsupported');
    const full = encodeTransaction(tx([addKey(OTHER.getPublicKey(), fullAccessKey())]));
    const p = Uint8Array.from(full);
    p[p.length - 1] = 2;
    expect(decodeCode(() => decodeNearTransaction(p))).toBe('unsupported');
    const fc = encodeTransaction(tx([addKey(OTHER.getPublicKey(), functionCallAccessKey('guestbook.testnet', []))]));
    const optionAt = fc.length - (4 + 'guestbook.testnet'.length) - 4 - 1;
    const o = Uint8Array.from(fc);
    expect(o[optionAt]).toBe(0);
    o[optionAt] = 2;
    expect(decodeCode(() => decodeNearTransaction(o))).toBe('malformed');
    const g = encodeTransaction(tx([deployGlobalContract(Uint8Array.of(1), new GlobalContractDeployMode({ CodeHash: null }))]));
    const gm = Uint8Array.from(g);
    gm[gm.length - 1] = 2;
    expect(decodeCode(() => decodeNearTransaction(gm))).toBe('unsupported');
  });

  it('refuses invalid UTF-8 in a method name and invalid account ids', () => {
    const b = encodeTransaction(tx([functionCall('ab', Uint8Array.of(), 1n, 0n)]));
    const at = toHex(b).indexOf(toHex(utf8('ab'))) / 2;
    const m = Uint8Array.from(b);
    m[at] = 0xff;
    expect(decodeCode(() => decodeNearTransaction(m))).toBe('malformed');
    expect(decodeCode(() => decodeNearTransaction(encodeTransaction(tx([transfer(1n)], 'Bad.Account'))))).toBe('invalid_value');
    expect(decodeCode(() => decodeNearTransaction(encodeTransaction(createTransaction(ME.accountId, PK, 'x', 1n, [], BLOCK))))).toBe('invalid_value');
    expect(decodeCode(() => decodeNearTransaction(encodeTransaction(tx([deleteAccount('UPPER')]))))).toBe('invalid_value');
  });

  it(`refuses more than ${NEAR_MAX_ACTIONS} actions and over-long method names`, () => {
    const many = Array.from({ length: NEAR_MAX_ACTIONS + 1 }, () => createAccount());
    expect(decodeCode(() => decodeNearTransaction(encodeTransaction(tx(many))))).toBe('too_large');
    expect(decodeNearTransaction(encodeTransaction(tx(many.slice(1)))).actions).toHaveLength(NEAR_MAX_ACTIONS);
    expect(decodeCode(() => decodeNearTransaction(encodeTransaction(tx([functionCall('m'.repeat(257), Uint8Array.of(), 1n, 0n)]))))).toBe('too_large');
  });

  it('a length prefix past the end is malformed, not an allocation', () => {
    const b = encodeTransaction(tx([deployContract(Uint8Array.of(1, 2, 3))]));
    const m = Uint8Array.from(b);
    m.set(u32le(0xfffffff0), m.length - 3 - 4);
    expect(decodeCode(() => decodeNearTransaction(m))).toBe('malformed');
  });
});

describe('NEP-366 delegate actions', () => {
  const da = () => buildDelegateAction({ senderId: ME.accountId, receiverId: 'guestbook.testnet', actions: [functionCall('add_message', { text: 'gasless' }, 30_000_000_000_000n, 0n), transfer(5n)], nonce: 99n, maxBlockHeight: 277_200_000n, publicKey: PK });

  it('decodes and re-encodes borsh(DelegateAction); the NEP-461 message and hash match near-api-js', () => {
    const plain = serialize(SCHEMA.DelegateAction, da());
    const d = decodeNearDelegateAction(plain);
    expect([d.senderId, d.receiverId, d.nonce, d.maxBlockHeight, nearKeyString(d.publicKey)]).toEqual([ME.accountId, 'guestbook.testnet', 99n, 277_200_000n, ME.publicKey]);
    expect(toHex(encodeNearDelegateAction(d))).toBe(toHex(plain));
    expect(toHex(nearDelegateActionMessage(plain))).toBe(toHex(encodeDelegateAction(da())));
    expect(toHex(nearDelegateActionHash(plain))).toBe(toHex(sha256(encodeDelegateAction(da()))));
    expect(NEP366_SIGNING_PREFIX).toBe(1073742190);
  });

  it('signNearDelegateAction: same signature and SignedDelegateAction as near-api-js', async () => {
    const plain = serialize(SCHEMA.DelegateAction, da());
    const [, signed] = await new KeyPairSigner(KP).signDelegateAction(da());
    const mine = signNearDelegateAction(SEED, plain);
    expect(toHex(base64Decode(mine.signedDelegateAction))).toBe(toHex(encodeSignedDelegate(signed)));
    const back = decodeNearSignedDelegateAction(base64Decode(mine.signedDelegateAction));
    expect(toHex(back.signature.bytes)).toBe(toHex(base64Decode(mine.signature)));
  });

  it('refuses the prefixed form, a nested delegate, trailing bytes and another key', () => {
    expect(decodeCode(() => decodeNearDelegateAction(encodeDelegateAction(da())))).toBe('malformed');
    // near-api-js won't encode a delegate inside a delegate (its schema has a placeholder there): written by hand.
    const inner = encodeSignedDelegate(new SignedDelegate({ delegateAction: innerDelegate(), signature: new Signature({ keyType: KeyType.ED25519, data: new Uint8Array(64) }) }));
    const nested = concatBytes(serialize('string', ME.accountId), serialize('string', 'x.testnet'), u32le(1), Uint8Array.of(8), inner, serialize('u64', 1n), serialize('u64', 1n), Uint8Array.of(0), PK.data);
    expect(decodeCode(() => decodeNearDelegateAction(nested))).toBe('invalid_value');
    expect(decodeCode(() => decodeNearDelegateAction(concatBytes(serialize(SCHEMA.DelegateAction, da()), Uint8Array.of(0))))).toBe('malformed');
    const other = buildDelegateAction({ senderId: ME.accountId, receiverId: 'x.testnet', actions: [], nonce: 1n, maxBlockHeight: 1n, publicKey: OTHER.getPublicKey() });
    expect(() => signNearDelegateAction(SEED, serialize(SCHEMA.DelegateAction, other))).toThrow(/not this key/);
  });
});

describe('NEP-413 messages', () => {
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);

  it.each([
    ['no callback', undefined],
    ['a callback', 'https://app.example/cb'],
  ])('%s: the bytes, hash and signature match @near-js/signers', async (_, callbackUrl) => {
    const bytes = encodeNep413Message({ message: 'Sign in to Guestbook', nonce, recipient: 'guestbook.example', callbackUrl: callbackUrl ?? null });
    expect(toHex(bytes.subarray(0, 4))).toBe(toHex(u32le(NEP413_TAG)));
    expect(NEP413_TAG).toBe(2147484061);
    const theirs = await new KeyPairSigner(KP).signNep413Message('Sign in to Guestbook', ME.accountId, 'guestbook.example', nonce, callbackUrl);
    const mine = signNep413Message(SEED, bytes);
    expect(toHex(base64Decode(mine.signature))).toBe(toHex(theirs.signature));
    expect([mine.accountId, mine.publicKey]).toEqual([ME.accountId, ME.publicKey]);
    expect(KP.verify(nep413Hash(bytes), theirs.signature)).toBe(true);
    expect(decodeNep413Message(bytes)).toEqual({ message: 'Sign in to Guestbook', nonce, recipient: 'guestbook.example', callbackUrl: callbackUrl ?? null });
  });

  it('refuses a wrong tag, trailing bytes, a bad option tag and invisible characters in the recipient', () => {
    const bytes = encodeNep413Message({ message: 'm', nonce, recipient: 'r', callbackUrl: null });
    const wrong = Uint8Array.from(bytes);
    wrong[0] = 0;
    expect(decodeCode(() => decodeNep413Message(wrong))).toBe('malformed');
    expect(decodeCode(() => decodeNep413Message(concatBytes(bytes, Uint8Array.of(0))))).toBe('malformed');
    const opt = Uint8Array.from(bytes);
    opt[opt.length - 1] = 2;
    expect(decodeCode(() => decodeNep413Message(opt))).toBe('malformed');
    expect(() => encodeNep413Message({ message: 'm', nonce, recipient: 'evil‮good', callbackUrl: null })).toThrow();
    expect(() => encodeNep413Message({ message: 'm', nonce: new Uint8Array(31), recipient: 'r', callbackUrl: null })).toThrow(/32 bytes/);
  });
});
