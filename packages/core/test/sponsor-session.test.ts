// The sponsorship calls' session binding (src/sponsor-session.ts, D856): the payload layout, the request hash over the
// body's own values, and the API's stateless check, which refuses a proof for another route, origin, app, body,
// account, time or session, and a wallet proof of another session or address.
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { evmSignerAddress as evmAddressFromPrivateKey } from '../src/signers/evm.ts';
import { concatBytes, sha256, toHex, utf8 } from '../src/bytes.ts';
import { identityMessage, signWalletProof, walletProofMessage } from '../src/identity.ts';
import {
  EVM_SPONSOR_REQUEST_HASH_DOMAIN,
  type EvmSponsorRequestMethod,
  checkEvmSponsorSessionProof,
  evmSponsorRequestHash,
  evmSponsorRequestPayload,
  evmSponsorSessionMessage,
  isEvmSponsorSessionProof,
} from '../src/sponsor-session.ts';

// Test keys: hashes of phrases (public on purpose), never a real wallet's.
const SESSION_SEED = sha256(utf8('hana-id test: sponsor session key'));
const SESSION_PK = ed25519.getPublicKey(SESSION_SEED);
const EVM_KEY = sha256(utf8('hana-id test: sponsor evm key'));
const ACCOUNT = evmAddressFromPrivateKey(EVM_KEY);
const OTHER_EVM_KEY = sha256(utf8('hana-id test: another evm key'));
const CTX = { signer: 'hana-signer.testnet', appId: 'app_1', parentOrigin: 'https://partner.test' };
const NOW = 1_800_000_000_000;

const CALLS = [{ to: '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e', value: '0', data: '0x183ff085' }];
const prepareBody = (): Record<string, unknown> => ({ chainId: 84532, account: ACCOUNT, calls: CALLS.map((c) => ({ ...c })) });
const sendBody = (): Record<string, unknown> => ({
  ...prepareBody(),
  executeNonce: '0',
  deadline: '1800000300',
  relayer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  minGas: '200000',
  signature: `0x${'11'.repeat(64)}1b`,
  authorization: { chainId: 84532, address: '0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA', nonce: '0', yParity: 0, r: `0x${'22'.repeat(32)}`, s: `0x${'33'.repeat(32)}` },
});

function walletProof(key = EVM_KEY, sessionPublicKey = SESSION_PK) {
  const address = evmAddressFromPrivateKey(key);
  return { address, signature: signWalletProof('evm', key, walletProofMessage({ signer: CTX.signer, appId: CTX.appId, sessionPublicKey }, 'evm', address)) };
}

/** A body with its proof, as the vault sends it. */
function signed(method: EvmSponsorRequestMethod, body: Record<string, unknown>, o: { issuedAtMs?: number; ctx?: typeof CTX; proof?: ReturnType<typeof walletProof>; seed?: Uint8Array } = {}): Record<string, unknown> {
  const seed = o.seed ?? SESSION_SEED;
  const sessionPublicKey = ed25519.getPublicKey(seed);
  const nonce = new Uint8Array(16).fill(9);
  const proof = o.proof ?? walletProof(EVM_KEY, sessionPublicKey);
  const issuedAtMs = o.issuedAtMs ?? NOW;
  const message = evmSponsorSessionMessage(o.ctx ?? CTX, { method, body, sessionPublicKey, issuedAtMs, nonce, walletProof: proof });
  return {
    ...body,
    sessionProof: {
      sessionPublicKey: Array.from(sessionPublicKey),
      issuedAtMs,
      nonce: Array.from(nonce),
      signature: Array.from(ed25519.sign(message, seed)),
      walletProof: { address: proof.address, signature: Array.from(proof.signature) },
    },
  };
}

const check = (method: EvmSponsorRequestMethod, body: Record<string, unknown>, nowMs = NOW, ctx = CTX) => checkEvmSponsorSessionProof({ method, body, ctx, nowMs });

describe('the request hash (D856)', () => {
  it('is sha256 of the domain, 0x00 and the canonical JSON of the body’s own values', () => {
    const b = prepareBody();
    const canonical = JSON.stringify(['prepare', 84532, ACCOUNT, [[CALLS[0]!.to, '0', '0x183ff085']]]);
    expect(toHex(evmSponsorRequestHash('prepare', b))).toBe(toHex(sha256(concatBytes(utf8(EVM_SPONSOR_REQUEST_HASH_DOMAIN), Uint8Array.of(0), utf8(canonical)))));
  });

  it('does not depend on key order, and changes with every value (send, field by field)', () => {
    const base = toHex(evmSponsorRequestHash('send', sendBody()));
    const reordered = Object.fromEntries(Object.entries(sendBody()).reverse());
    expect(toHex(evmSponsorRequestHash('send', reordered))).toBe(base);
    const changes: [string, (b: Record<string, unknown>) => void][] = [
      ['chainId', (b) => (b.chainId = 84533)],
      ['account case', (b) => (b.account = (b.account as string).toLowerCase())],
      ['a call target', (b) => ((b.calls as Record<string, unknown>[])[0]!.to = '0x1111111111111111111111111111111111111111')],
      ['a call data', (b) => ((b.calls as Record<string, unknown>[])[0]!.data = '0x183ff086')],
      ['executeNonce', (b) => (b.executeNonce = '1')],
      ['deadline', (b) => (b.deadline = '1800000301')],
      ['relayer', (b) => (b.relayer = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC')],
      ['minGas', (b) => (b.minGas = '200001')],
      ['signature', (b) => (b.signature = `0x${'11'.repeat(64)}1c`)],
      ['authorization nonce', (b) => ((b.authorization as Record<string, unknown>).nonce = '1')],
      ['no authorization', (b) => delete b.authorization],
    ];
    for (const [name, change] of changes) {
      const b = sendBody();
      change(b);
      expect(toHex(evmSponsorRequestHash('send', b)), name).not.toBe(base);
    }
  });

  it('differs between prepare and send of the same calls', () => {
    const s = sendBody();
    delete s.authorization;
    expect(toHex(evmSponsorRequestHash('prepare', prepareBody()))).not.toBe(toHex(evmSponsorRequestHash('send', s)));
  });

  it.each([
    ['an unknown field', (b: Record<string, unknown>) => (b.extra = 1)],
    ['a proof left in', (b: Record<string, unknown>) => (b.sessionProof = {})],
    ['a missing field', (b: Record<string, unknown>) => delete b.account],
    ['chainId as a string', (b: Record<string, unknown>) => (b.chainId = '84532')],
    ['no calls', (b: Record<string, unknown>) => (b.calls = [])],
    ['nine calls', (b: Record<string, unknown>) => (b.calls = Array.from({ length: 9 }, () => ({ ...CALLS[0] })))],
    ['a call with an extra field', (b: Record<string, unknown>) => (b.calls = [{ ...CALLS[0], gas: '1' }])],
  ])('refuses a prepare body with %s', (_n, change) => {
    const b = prepareBody();
    change(b);
    expect(() => evmSponsorRequestHash('prepare', b)).toThrow(TypeError);
  });

  it('refuses an authorization on prepare and a malformed one on send', () => {
    expect(() => evmSponsorRequestHash('prepare', { ...prepareBody(), authorization: {} })).toThrow(TypeError);
    const b = sendBody();
    (b.authorization as Record<string, unknown>).extra = 1;
    expect(() => evmSponsorRequestHash('send', b)).toThrow(TypeError);
  });
});

describe('the payload and the message', () => {
  it('lays out the label, method, origin, chain, account, hash and wallet proof', () => {
    const proof = walletProof();
    const requestHash = new Uint8Array(32).fill(5);
    const p = evmSponsorRequestPayload({ method: 'prepare', parentOrigin: 'https://p.test', chainId: 84532, account: ACCOUNT, requestHash, walletProof: proof });
    const borsh = (s: string) => concatBytes(new Uint8Array(new Uint32Array([utf8(s).length]).buffer), utf8(s));
    const u64 = new Uint8Array(8);
    new DataView(u64.buffer).setBigUint64(0, 84532n, true);
    const expected = concatBytes(utf8('evm-sponsor-request'), borsh('prepare'), borsh('https://p.test'), u64, borsh(ACCOUNT), requestHash, borsh(proof.address), new Uint8Array(new Uint32Array([65]).buffer), proof.signature);
    expect(toHex(p)).toBe(toHex(expected));
  });

  it('is identityMessage over that payload (one prefix for every session proof)', () => {
    const proof = walletProof();
    const nonce = new Uint8Array(16).fill(1);
    const body = prepareBody();
    const m = evmSponsorSessionMessage(CTX, { method: 'prepare', body, sessionPublicKey: SESSION_PK, issuedAtMs: NOW, nonce, walletProof: proof });
    const payload = evmSponsorRequestPayload({ method: 'prepare', parentOrigin: CTX.parentOrigin, chainId: 84532, account: ACCOUNT, requestHash: evmSponsorRequestHash('prepare', body), walletProof: proof });
    expect(toHex(m)).toBe(toHex(identityMessage({ signer: CTX.signer, appId: CTX.appId, sessionPublicKey: SESSION_PK, issuedAtMs: NOW, nonce, payload })));
  });

  it('refuses a bad method, chain or hash length', () => {
    const base = { method: 'prepare' as const, parentOrigin: 'x', chainId: 1, account: ACCOUNT, requestHash: new Uint8Array(32), walletProof: walletProof() };
    expect(() => evmSponsorRequestPayload({ ...base, method: 'status' as never })).toThrow();
    expect(() => evmSponsorRequestPayload({ ...base, chainId: 0 })).toThrow();
    expect(() => evmSponsorRequestPayload({ ...base, requestHash: new Uint8Array(31) })).toThrow();
  });
});

describe('the API’s stateless check (D856 steps 1 to 4)', () => {
  it('accepts a prepare and a send from the session, naming its account', () => {
    for (const [method, body] of [
      ['prepare', prepareBody()],
      ['send', sendBody()],
    ] as const) {
      const r = check(method, signed(method, body));
      expect(r).toMatchObject({ ok: true, account: ACCOUNT, issuedAtMs: NOW });
      if (r.ok) expect(toHex(r.sessionPublicKey)).toBe(toHex(SESSION_PK));
    }
  });

  it('a lowercase account in the body is the same account (the wallet proof is EIP-55)', () => {
    expect(check('prepare', signed('prepare', { ...prepareBody(), account: ACCOUNT.toLowerCase() })).ok).toBe(true);
  });

  it('refuses a body without a proof, or a proof of another shape', () => {
    expect(check('prepare', prepareBody())).toEqual({ ok: false, reason: 'missing_session_proof' });
    const b = signed('prepare', prepareBody());
    for (const change of [
      (p: Record<string, unknown>) => (p.extra = 1),
      (p: Record<string, unknown>) => (p.nonce = [1, 2]),
      (p: Record<string, unknown>) => (p.signature = Array(63).fill(0)),
      (p: Record<string, unknown>) => (p.issuedAtMs = -1),
      (p: Record<string, unknown>) => ((p.walletProof as Record<string, unknown>).signature = Array(64).fill(0)),
    ]) {
      const copy = structuredClone(b);
      change(copy.sessionProof as Record<string, unknown>);
      expect(check('prepare', copy)).toEqual({ ok: false, reason: 'bad_session_proof' });
    }
    expect(isEvmSponsorSessionProof(b.sessionProof)).toBe(true);
  });

  it('refuses a proof outside the 60 s window either way', () => {
    const b = signed('prepare', prepareBody());
    expect(check('prepare', b, NOW + 60_000).ok).toBe(true);
    expect(check('prepare', b, NOW + 60_001)).toEqual({ ok: false, reason: 'stale_session_proof' });
    expect(check('prepare', b, NOW - 60_001)).toEqual({ ok: false, reason: 'stale_session_proof' });
  });

  it('a proof signed for prepare is not good for send, nor for another app, origin or signer', () => {
    const s = sendBody();
    delete s.authorization;
    const asPrepare = signed('prepare', prepareBody());
    // The same calls posted to send (with the send fields added) carry the prepare's proof: refused.
    expect(check('send', { ...s, sessionProof: asPrepare.sessionProof }).ok).toBe(false);
    for (const ctx of [
      { ...CTX, appId: 'app_2' },
      { ...CTX, parentOrigin: 'https://evil.test' },
      { ...CTX, signer: 'other-signer.testnet' },
    ]) {
      expect(check('prepare', asPrepare, NOW, ctx)).toEqual({ ok: false, reason: 'invalid_session_signature' });
    }
  });

  it('refuses any change to the body after it was signed', () => {
    const b = signed('send', sendBody());
    for (const change of [
      (x: Record<string, unknown>) => (x.minGas = '300000'),
      (x: Record<string, unknown>) => ((x.calls as Record<string, unknown>[])[0]!.data = '0x183ff08500'),
      (x: Record<string, unknown>) => delete x.authorization,
      (x: Record<string, unknown>) => (x.chainId = 31337),
    ]) {
      const copy = structuredClone(b);
      change(copy);
      expect(check('send', copy)).toEqual({ ok: false, reason: 'invalid_session_signature' });
    }
  });

  it('refuses a wallet proof of another address, or of this address for another session', () => {
    // Signed by the session, but the wallet proof is another key's: the session doesn't own the body's account.
    expect(check('prepare', signed('prepare', prepareBody(), { proof: walletProof(OTHER_EVM_KEY) }))).toEqual({ ok: false, reason: 'bad_wallet_proof' });
    // Another session's (valid) wallet proof of this account, under this session's signature: refused.
    const otherSession = ed25519.getPublicKey(sha256(utf8('another session')));
    expect(check('prepare', signed('prepare', prepareBody(), { proof: walletProof(EVM_KEY, otherSession) }))).toEqual({ ok: false, reason: 'bad_wallet_proof' });
    // A body naming another account than the proof (both signed by the session).
    const other = evmAddressFromPrivateKey(OTHER_EVM_KEY);
    expect(check('prepare', signed('prepare', { ...prepareBody(), account: other }))).toEqual({ ok: false, reason: 'bad_wallet_proof' });
  });

  it('refuses a signature by another session key over the same message', () => {
    const b = signed('prepare', prepareBody(), { seed: sha256(utf8('a thief’s key')) });
    (b.sessionProof as Record<string, unknown>).sessionPublicKey = Array.from(SESSION_PK);
    expect(check('prepare', b).ok).toBe(false);
  });
});
