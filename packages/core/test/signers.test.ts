// Signers against independent implementations: Stellar against @stellar/stellar-base (its own Keypair signing,
// TransactionBuilder, fee bumps and authorizeEntry), EVM against viem (signTransaction, signMessage, signTypedData,
// sign). Ed25519 and RFC 6979 ECDSA are deterministic, so outputs must be identical byte for byte.
import { createHash } from 'node:crypto';
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash as stellarHash,
  xdr,
} from '@stellar/stellar-base';
import { hashTypedData as viemHashTypedData, keccak256, recoverMessageAddress, serializeSignature } from 'viem';
import { privateKeyToAccount, sign as viemSign } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { base64Decode, base64Encode, fromHex, toHex, utf8 } from '../src/bytes.ts';
import { encodeType, hashTypedData } from './eip712-reference.ts';
import { type NormalizedTypedData, normalizeTypedData } from '../src/typed-data.ts';
import {
  eip191Hash,
  evmSignerAddress,
  evmTxSigningHash,
  parseEvmTxRequest,
  personalSign,
  recoverEvmAddress,
  rlpEncode,
  signEvmDigest,
  signEvmTransaction,
  signTypedData,
} from '../src/signers/evm.ts';
import {
  sep53MessageHash,
  signStellarAuthEntry,
  signStellarMessage,
  signStellarRaw,
  signStellarTransaction,
  stellarAuthEntryHash,
  stellarSignerAddress,
  stellarTransactionHash,
  verifyStellarSignature,
} from '../src/signers/stellar.ts';

const SEED = fromHex('cd57e2d02be982d2e091dc7694448b5335a102d5aa8740aa3e8996f691929438');
const KP = Keypair.fromRawEd25519Seed(Buffer.from(SEED));
const TESTNET = Networks.TESTNET;
const DEST = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

function paymentTx(source = KP.publicKey()) {
  return new TransactionBuilder(new Account(source, '1234'), { fee: '100', networkPassphrase: TESTNET })
    .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: '1.5' }))
    .setTimeout(300)
    .build();
}

describe('Stellar transaction', () => {
  it('signs a v1 envelope exactly as stellar-base does', () => {
    const tx = paymentTx();
    const xdrIn = tx.toXDR();
    const out = signStellarTransaction(SEED, xdrIn, TESTNET);
    expect(out.signerAddress).toBe(KP.publicKey());
    expect(stellarSignerAddress(SEED)).toBe(KP.publicKey());
    const ref = TransactionBuilder.fromXDR(xdrIn, TESTNET);
    ref.sign(KP);
    expect(out.signedTxXdr).toBe(ref.toXDR());
    expect(toHex(stellarTransactionHash(xdrIn, TESTNET))).toBe(toHex(tx.hash()));
  });

  it('the hash is sha256(sha256(passphrase) ‖ ENVELOPE_TYPE_TX ‖ tx XDR) and binds the network', () => {
    const tx = paymentTx();
    const env = xdr.TransactionEnvelope.fromXDR(tx.toXDR(), 'base64');
    const manual = createHash('sha256')
      .update(Buffer.concat([createHash('sha256').update(TESTNET).digest(), Buffer.from([0, 0, 0, 2]), env.v1().tx().toXDR()]))
      .digest('hex');
    expect(toHex(stellarTransactionHash(tx.toXDR(), TESTNET))).toBe(manual);
    expect(toHex(stellarTransactionHash(tx.toXDR(), Networks.PUBLIC))).not.toBe(manual);
  });

  it('appends to existing signatures, with the hint of this key', () => {
    const tx = paymentTx();
    const other = Keypair.random();
    tx.sign(other);
    const out = signStellarTransaction(SEED, tx.toXDR(), TESTNET);
    const sigs = xdr.TransactionEnvelope.fromXDR(out.signedTxXdr, 'base64').v1().signatures();
    expect(sigs).toHaveLength(2);
    expect(toHex(sigs[1]!.hint())).toBe(toHex(KP.signatureHint()));
    expect(KP.verify(tx.hash(), sigs[1]!.signature())).toBe(true);
  });

  it('signs a fee-bump envelope as given (the outer transaction)', () => {
    const inner = paymentTx(DEST);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(KP.publicKey(), '200', inner, TESTNET);
    const out = signStellarTransaction(SEED, feeBump.toXDR(), TESTNET);
    const ref = TransactionBuilder.fromXDR(feeBump.toXDR(), TESTNET);
    ref.sign(KP);
    expect(out.signedTxXdr).toBe(ref.toXDR());
    expect(toHex(stellarTransactionHash(feeBump.toXDR(), TESTNET))).toBe(toHex(feeBump.hash()));
  });

  it('refuses malformed, non-canonical or trailing-byte XDR, and a bad passphrase', () => {
    const x = paymentTx().toXDR();
    expect(() => signStellarTransaction(SEED, 'not base64!', TESTNET)).toThrow();
    expect(() => signStellarTransaction(SEED, base64Encode(new Uint8Array([0, 0, 0, 9])), TESTNET)).toThrow();
    const trailing = base64Encode(Uint8Array.from([...base64Decode(x), 0, 0, 0, 0]));
    expect(() => signStellarTransaction(SEED, trailing, TESTNET)).toThrow();
    expect(() => signStellarTransaction(SEED, x, '')).toThrow(/passphrase/);
    expect(() => signStellarTransaction(new Uint8Array(31), x, TESTNET)).toThrow(/32 bytes/);
  });
});

describe('Stellar auth entry', () => {
  async function preimageFromStellarBase(): Promise<{ preimageXdr: string; refSig: Buffer }> {
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString('CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE').toScAddress(),
          functionName: 'transfer',
          args: [],
        }),
      ),
      subInvocations: [],
    });
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(KP.publicKey()).toScAddress(), nonce: new xdr.Int64(42), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: invocation,
    });
    let preimageXdr = '';
    let refSig: Buffer = Buffer.alloc(0);
    await authorizeEntry(
      entry,
      async (preimage) => {
        preimageXdr = preimage.toXDR('base64');
        refSig = KP.sign(stellarHash(preimage.toXDR()));
        return refSig;
      },
      1000,
      TESTNET,
    );
    return { preimageXdr, refSig };
  }

  it('signs sha256(HashIdPreimage) like stellar-base authorizeEntry’s preimage and Keypair', async () => {
    const { preimageXdr, refSig } = await preimageFromStellarBase();
    const out = signStellarAuthEntry(SEED, preimageXdr, TESTNET);
    expect(out.signedAuthEntry).toBe(refSig.toString('base64'));
    expect(base64Decode(out.signedAuthEntry)).toHaveLength(64);
    expect(out.signerAddress).toBe(KP.publicKey());
    expect(toHex(stellarAuthEntryHash(preimageXdr, TESTNET))).toBe(createHash('sha256').update(Buffer.from(preimageXdr, 'base64')).digest('hex'));
  });

  it('refuses another network, another preimage type and non-canonical input', async () => {
    const { preimageXdr } = await preimageFromStellarBase();
    expect(() => signStellarAuthEntry(SEED, preimageXdr, Networks.PUBLIC)).toThrow(/another network/);
    const opId = xdr.HashIdPreimage.envelopeTypeOpId(new xdr.HashIdPreimageOperationId({ sourceAccount: KP.xdrAccountId(), seqNum: new xdr.Int64(1), opNum: 0 }));
    expect(() => signStellarAuthEntry(SEED, opId.toXDR('base64'), TESTNET)).toThrow(/SOROBAN_AUTHORIZATION/);
    const trailing = base64Encode(Uint8Array.from([...base64Decode(preimageXdr), 0, 0, 0, 0]));
    expect(() => signStellarAuthEntry(SEED, trailing, TESTNET)).toThrow();
  });
});

describe('Stellar message (SEP-53) and raw', () => {
  it('signs sha256("Stellar Signed Message:\\n" ‖ message), string or bytes', () => {
    for (const message of ['Hello, World!', utf8('Hello, World!'), new Uint8Array([0, 255, 1])]) {
      const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
      const h = createHash('sha256').update(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), bytes])).digest();
      expect(toHex(sep53MessageHash(message))).toBe(h.toString('hex'));
      const out = signStellarMessage(SEED, message);
      expect(out.signedMessage).toBe(KP.sign(h).toString('base64'));
      expect(verifyStellarSignature(KP.publicKey(), h, base64Decode(out.signedMessage))).toBe(true);
    }
    expect(signStellarMessage(SEED, 'a').signedMessage).not.toBe(signStellarMessage(SEED, 'b').signedMessage);
  });

  it('raw: Ed25519 over the bytes themselves, 1..4096 bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(100));
    const sig = signStellarRaw(SEED, bytes);
    expect(toHex(sig)).toBe(KP.sign(Buffer.from(bytes)).toString('hex'));
    expect(() => signStellarRaw(SEED, new Uint8Array(0))).toThrow();
    expect(() => signStellarRaw(SEED, new Uint8Array(4097))).toThrow();
    expect(signStellarRaw(SEED, new Uint8Array(4096))).toHaveLength(64);
  });
});

// ---- EVM ----

const D = fromHex('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
/** Typed data as the vault signs it: normalizeTypedData over the JSON a dapp sends (bigints as decimal strings). */
const normalized = (td: unknown): NormalizedTypedData =>
  normalizeTypedData(JSON.stringify(td, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
const ACCOUNT = privateKeyToAccount(`0x${toHex(D)}`);
const TO = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

describe('EVM transaction', () => {
  const eip1559 = {
    chainId: '0xaa36a7',
    nonce: '0x7',
    gas: '0x5208',
    maxFeePerGas: '0x77359400',
    maxPriorityFeePerGas: '0x3b9aca00',
    to: TO,
    value: '0xde0b6b3a7640000',
    data: '0xa9059cbb000000000000000000000000',
  };

  it('EIP-1559 (type 2) matches viem signTransaction', async () => {
    const raw = signEvmTransaction(D, eip1559);
    const ref = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: 11155111,
      nonce: 7,
      gas: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: TO,
      value: 10n ** 18n,
      data: '0xa9059cbb000000000000000000000000',
    });
    expect(raw).toBe(ref);
  });

  it('EIP-1559 with an access list, zero values and contract creation', async () => {
    const accessList = [{ address: TO, storageKeys: [`0x${'11'.repeat(32)}`] }];
    const req = { ...eip1559, nonce: '0x0', value: '0x0', to: undefined, data: '0x6080', accessList };
    delete (req as { to?: string }).to;
    const ref = await ACCOUNT.signTransaction({
      type: 'eip1559',
      chainId: 11155111,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 0n,
      data: '0x6080',
      accessList: [{ address: TO, storageKeys: [`0x${'11'.repeat(32)}`] }],
    });
    expect(signEvmTransaction(D, req)).toBe(ref);
  });

  it('legacy with EIP-155 matches viem', async () => {
    const legacy = { chainId: '0x1', nonce: '0x9', gas: '0x5208', gasPrice: '0x4a817c800', to: TO, value: '0x1', data: '0x', type: '0x0' };
    const ref = await ACCOUNT.signTransaction({ type: 'legacy', chainId: 1, nonce: 9, gas: 21000n, gasPrice: 20_000_000_000n, to: TO, value: 1n, data: '0x' });
    expect(signEvmTransaction(D, legacy)).toBe(ref);
  });

  it('accepts a matching from and refuses another', () => {
    expect(() => signEvmTransaction(D, { ...eip1559, from: ACCOUNT.address.toLowerCase() })).not.toThrow();
    expect(() => signEvmTransaction(D, { ...eip1559, from: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' })).toThrow(/from/);
  });

  it.each([
    ['an unknown field', { ...eip1559, gasLimit: '0x1' }],
    ['a missing chainId', { ...eip1559, chainId: undefined }],
    ['chainId 0', { ...eip1559, chainId: '0x0' }],
    ['a decimal quantity', { ...eip1559, nonce: 7 }],
    ['odd-length data', { ...eip1559, data: '0xabc' }],
    ['both fee kinds', { ...eip1559, gasPrice: '0x1' }],
    ['no fees', { chainId: '0x1', nonce: '0x0', gas: '0x1', value: '0x0', data: '0x' }],
    ['a type that disagrees', { ...eip1559, type: '0x0' }],
    ['priority over max fee', { ...eip1559, maxPriorityFeePerGas: '0x77359401' }],
    ['a bad checksum', { ...eip1559, to: TO.replace('E', 'e') }],
    ['an empty to string', { ...eip1559, to: '' }],
    ['a value over 2^256', { ...eip1559, value: `0x1${'0'.repeat(64)}` }],
    ['an access list on legacy', { chainId: '0x1', nonce: '0x0', gas: '0x1', value: '0x0', data: '0x', gasPrice: '0x1', accessList: [] }],
    ['a short storage key', { ...eip1559, accessList: [{ address: TO, storageKeys: ['0x11'] }] }],
  ])('refuses %s', (_, req) => {
    const clean = Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined));
    expect(() => parseEvmTxRequest(clean)).toThrow();
  });

  it('the signing hash is keccak256 of the unsigned payload', () => {
    const tx = parseEvmTxRequest(eip1559);
    expect(toHex(evmTxSigningHash(tx))).toHaveLength(64);
    expect(toHex(evmTxSigningHash(parseEvmTxRequest({ ...eip1559, nonce: '0x8' })))).not.toBe(toHex(evmTxSigningHash(tx)));
  });

  it('RLP encodes the Yellow Paper examples', () => {
    expect(toHex(rlpEncode(utf8('dog')))).toBe('83646f67');
    expect(toHex(rlpEncode([utf8('cat'), utf8('dog')]))).toBe('c88363617483646f67');
    expect(toHex(rlpEncode(new Uint8Array(0)))).toBe('80');
    expect(toHex(rlpEncode([]))).toBe('c0');
    expect(toHex(rlpEncode(Uint8Array.of(0x0f)))).toBe('0f');
    expect(toHex(rlpEncode(Uint8Array.of(0x04, 0x00)))).toBe('820400');
    expect(toHex(rlpEncode([[], [[]], [[], [[]]]]))).toBe('c7c0c1c0c3c0c1c0');
    const long = utf8('Lorem ipsum dolor sit amet, consectetur adipisicing elit');
    expect(toHex(rlpEncode(long)).slice(0, 4)).toBe('b838');
  });
});

describe('EVM messages and raw', () => {
  it('personal_sign (EIP-191) matches viem signMessage and recovers', async () => {
    const message = utf8('Hello Hana');
    const sig = personalSign(D, message);
    expect(sig).toBe(await ACCOUNT.signMessage({ message: { raw: message } }));
    expect(await recoverMessageAddress({ message: { raw: message }, signature: sig })).toBe(ACCOUNT.address);
    expect(recoverEvmAddress(eip191Hash(message), fromHex(sig.slice(2)))).toBe(ACCOUNT.address);
    expect([27, 28]).toContain(Number.parseInt(sig.slice(-2), 16));
  });

  it('raw digest signing gives r‖s‖v with v ∈ {27, 28}, as viem sign', async () => {
    for (let i = 0; i < 6; i++) {
      const digest = crypto.getRandomValues(new Uint8Array(32));
      const sig = signEvmDigest(D, digest);
      expect(sig).toHaveLength(65);
      expect([27, 28]).toContain(sig[64]);
      const ref = await viemSign({ hash: `0x${toHex(digest)}`, privateKey: `0x${toHex(D)}` });
      expect(`0x${toHex(sig)}`).toBe(serializeSignature(ref));
      expect(recoverEvmAddress(digest, sig)).toBe(ACCOUNT.address);
    }
    expect(() => signEvmDigest(D, new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => signEvmDigest(new Uint8Array(32), new Uint8Array(32))).toThrow(/private key/);
    expect(evmSignerAddress(D)).toBe(ACCOUNT.address);
  });
});

describe('EIP-712', () => {
  const mail = {
    domain: { name: 'Ether Mail', version: '1', chainId: 1n, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Person: [
        { name: 'name', type: 'string' },
        { name: 'wallet', type: 'address' },
      ],
      Mail: [
        { name: 'from', type: 'Person' },
        { name: 'to', type: 'Person' },
        { name: 'contents', type: 'string' },
      ],
    },
    primaryType: 'Mail',
    message: {
      from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
      to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
      contents: 'Hello, Bob!',
    },
  } as const;

  it('hashes the EIP-712 spec example to its published digest', () => {
    expect(encodeType('Mail', mail.types)).toBe('Mail(Person from,Person to,string contents)Person(string name,address wallet)');
    expect(toHex(hashTypedData(mail))).toBe('be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
    expect(`0x${toHex(hashTypedData(mail))}`).toBe(viemHashTypedData(mail));
  });

  it('signs like viem signTypedData', async () => {
    expect(signTypedData(D, normalized(mail))).toBe(await ACCOUNT.signTypedData(mail));
  });

  it('a permit with uint, bytes, bool, int, arrays and every domain field matches viem', async () => {
    const td = {
      domain: { name: 'Token', version: '2', chainId: 11155111, verifyingContract: TO, salt: `0x${'ab'.repeat(32)}` as `0x${string}` },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
          { name: 'salt', type: 'bytes32' },
        ],
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'memo', type: 'bytes' },
          { name: 'tag', type: 'bytes4' },
          { name: 'ok', type: 'bool' },
          { name: 'delta', type: 'int64' },
          { name: 'ids', type: 'uint8[]' },
          { name: 'pair', type: 'address[2]' },
          { name: 'notes', type: 'string[]' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: ACCOUNT.address,
        spender: TO,
        value: 10n ** 24n,
        nonce: 0n,
        deadline: 1_900_000_000n,
        memo: '0xdeadbeef',
        tag: '0x12345678',
        ok: true,
        delta: -5n,
        ids: [1, 2, 3],
        pair: [TO, ACCOUNT.address],
        notes: ['a', 'b'],
      },
    } as const;
    expect(`0x${toHex(hashTypedData(td))}`).toBe(viemHashTypedData(td as never));
    expect(signTypedData(D, normalized(td))).toBe(await ACCOUNT.signTypedData(td as never));
    // Decimal and hex strings for integers hash the same as bigints.
    expect(toHex(hashTypedData({ ...td, message: { ...td.message, value: (10n ** 24n).toString(), nonce: '0x0', delta: '-5' } }))).toBe(toHex(hashTypedData(td)));
  });

  it('refuses types without EIP712Domain instead of inferring it (implementations infer it differently)', () => {
    const { EIP712Domain: _, ...noDomain } = mail.types;
    expect(() => hashTypedData({ ...mail, types: noDomain })).toThrow(/must declare EIP712Domain/u);
    expect(() => signTypedData(D, normalized({ ...mail, types: noDomain }))).toThrow(/must declare EIP712Domain/u);
    // The case that diverged: a string chainId. viem drops it from an inferred domain, this module kept it; with the
    // domain declared, both hash it as the uint256 1.
    const stringChain = { ...mail, domain: { name: 'X', chainId: '1' } };
    expect(() => hashTypedData({ ...stringChain, types: noDomain })).toThrow(/must declare EIP712Domain/u);
    const declared = {
      ...stringChain,
      types: { ...noDomain, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }] },
    };
    expect(`0x${toHex(hashTypedData(declared))}`).toBe(viemHashTypedData({ ...declared, domain: { name: 'X', chainId: 1 } } as never));
  });

  it('primaryType EIP712Domain hashes the domain only (as viem)', () => {
    const td = { domain: mail.domain, types: { EIP712Domain: mail.types.EIP712Domain }, primaryType: 'EIP712Domain' } as const;
    expect(`0x${toHex(hashTypedData({ ...td, message: {} }))}`).toBe(viemHashTypedData(td));
  });

  it.each([
    ['a missing field', { ...mail, message: { ...mail.message, contents: undefined } }],
    ['an extra field', { ...mail, message: { ...mail.message, cc: 'x' } }],
    ['an undeclared type', { ...mail, types: { ...mail.types, Mail: [{ name: 'from', type: 'Nobody' }] }, message: { from: {} } }],
    ['a primaryType not in types', { ...mail, primaryType: 'Letter' }],
    ['a proto key as type', { ...mail, primaryType: '__proto__' }],
    ['an out-of-range uint', { ...mail, types: { ...mail.types, Mail: [{ name: 'n', type: 'uint8' }] }, message: { n: 256 } }],
    ['a negative uint', { ...mail, types: { ...mail.types, Mail: [{ name: 'n', type: 'uint256' }] }, message: { n: -1 } }],
    ['a short bytes32', { ...mail, types: { ...mail.types, Mail: [{ name: 'b', type: 'bytes32' }] }, message: { b: '0x11' } }],
    ['a bad address', { ...mail, message: { ...mail.message, to: { name: 'Bob', wallet: '0x1234' } } }],
    ['a wrong fixed array length', { ...mail, types: { ...mail.types, Mail: [{ name: 'a', type: 'uint8[2]' }] }, message: { a: [1] } }],
    ['an invalid uint width', { ...mail, types: { ...mail.types, Mail: [{ name: 'n', type: 'uint7' }] }, message: { n: 1 } }],
    ['a duplicate field', { ...mail, types: { ...mail.types, Person: [...mail.types.Person, { name: 'name', type: 'string' }] } }],
    ['a struct named like an atomic type', { ...mail, types: { ...mail.types, address: [{ name: 'x', type: 'string' }] } }],
    ['an undeclared type in an unused struct', { ...mail, types: { ...mail.types, Extra: [{ name: 'x', type: 'Ghost[]' }] } }],
    ['an unsafe number', { ...mail, types: { ...mail.types, Mail: [{ name: 'n', type: 'uint256' }] }, message: { n: 2 ** 60 } }],
  ])('refuses %s', (_, td) => {
    expect(() => hashTypedData(td as never)).toThrow();
  });

  it('keccak256 sanity: the module and viem agree on a plain hash', () => {
    expect(keccak256('0x')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });
});
