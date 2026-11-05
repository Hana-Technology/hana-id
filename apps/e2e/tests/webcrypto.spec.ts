// D385's audit, kept as a check on every browser CI runs: the WebCrypto calls the vault and the auth pages make take
// keys that start with zero bytes, and give the same bytes as Node's OpenSSL. WebKit's Linux ports refuse such keys
// in Ed25519 generateKey (D381, retried) and in a PKCS#8 import of an Ed25519 or X25519 private key, neither of which
// Hana makes; this spec pins that the calls Hana does make are not affected:
// - AES-256-GCM raw import, encrypt, decrypt: the relay keys (core relay.ts) and K_s (web vault/record.ts);
// - HKDF-SHA-256 raw import and deriveKey to AES-GCM: the record's PRK, a derived key (vault/record.ts consentKey);
// - Ed25519 raw public import and verify (core session.ts verifyEd25519), and the session key's generateKey, sign and
//   export (core session.ts), checked against Node;
// - RSASSA-PKCS1-v1_5 JWK import and verify: the Google and email tokens (core id-token.ts, email-token.ts).
// Every key here is a test key made from a public label; none is a Hana key.
import crypto from 'node:crypto';
import { API_URL } from '../src/stack.ts';
import { expect, test } from './fixtures.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const label = (s: string): Buffer => crypto.createHash('sha256').update(`hana-e2e-webcrypto-${s}`).digest();
/** 32 bytes from `name`, with the first `zeros` set to 0. */
const keyWith = (name: string, zeros: number): Buffer => {
  const k = label(name);
  k.fill(0, 0, zeros);
  return k;
};
const KEYS: [string, Buffer][] = [
  ['one leading zero byte', keyWith('k1', 1)],
  ['two leading zero bytes', keyWith('k2', 2)],
  ['sixteen leading zero bytes', keyWith('k16', 16)],
  ['all zero', Buffer.alloc(32)],
  ['no leading zero', (() => {
    const k = label('k0');
    k[0] = 0x80 | (k[0] ?? 0);
    return k;
  })()],
];

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const edSeed = (i: number): Buffer => crypto.createHash('sha256').update(`hana-e2e-webcrypto-ed25519-${i}`).digest();
const edPublic = (seed: Buffer): Buffer =>
  crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(12);
const edSign = (seed: Buffer, msg: Buffer): Buffer => crypto.sign(null, msg, crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' }));
/** Labels whose seed gives a public key starting with one zero byte (32, 65, 84) and with two (10932, 15140). */
const ED_LEADING_ZERO = [32, 65, 84, 10932, 15140];

test.beforeEach(async ({ page }) => {
  // Any page of the stack's loopback origins: a secure context, as WebCrypto's Ed25519 needs.
  await page.goto(`${API_URL}/__e2e/health`);
});

test('AES-256-GCM: raw keys with leading zero bytes import, and encrypt and decrypt as Node does (relay keys, K_s)', async ({ page }) => {
  const iv = label('iv').subarray(0, 12);
  const aad = label('aad');
  const pt = Buffer.concat([label('pt1'), label('pt2')]).subarray(0, 50);
  const cases = KEYS.map(([name, key]) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad);
    return { name, key: hex(key), ct: hex(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])) };
  });
  const got = await page.evaluate(
    async ({ cases, iv, aad, pt }) => {
      const h2b = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => parseInt(x, 16));
      const b2h = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
      const out: Record<string, { ct: string; pt: string }> = {};
      for (const c of cases) {
        const params = { name: 'AES-GCM', iv: h2b(iv), additionalData: h2b(aad) };
        const ek = await crypto.subtle.importKey('raw', h2b(c.key), { name: 'AES-GCM' }, false, ['encrypt']);
        const dk = await crypto.subtle.importKey('raw', h2b(c.key), { name: 'AES-GCM' }, false, ['decrypt']);
        out[c.name] = { ct: b2h(await crypto.subtle.encrypt(params, ek, h2b(pt))), pt: b2h(await crypto.subtle.decrypt(params, dk, h2b(c.ct))) };
      }
      return out;
    },
    { cases, iv: hex(iv), aad: hex(aad), pt: hex(pt) },
  );
  for (const c of cases) expect(got[c.name], c.name).toEqual({ ct: c.ct, pt: hex(pt) });
});

test('HKDF-SHA-256: a PRK with leading zero bytes imports, and derives the AES-GCM key Node derives (the record’s consent key)', async ({ page }) => {
  const info = Buffer.from('hana-id/vault/consent/v1');
  const iv = label('hkdf-iv').subarray(0, 12);
  const pt = label('hkdf-pt');
  const cases = KEYS.map(([name, prk]) => {
    const bits = Buffer.from(crypto.hkdfSync('sha256', prk, Buffer.alloc(0), info, 32));
    const c = crypto.createCipheriv('aes-256-gcm', bits, iv);
    return { name, prk: hex(prk), bits: hex(bits), ct: hex(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])) };
  });
  const got = await page.evaluate(
    async ({ cases, info, iv, pt }) => {
      const h2b = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => parseInt(x, 16));
      const b2h = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
      const out: Record<string, { bits: string; ct: string }> = {};
      for (const c of cases) {
        const base = await crypto.subtle.importKey('raw', h2b(c.prk), 'HKDF', false, ['deriveKey', 'deriveBits']);
        const p = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: h2b(info) };
        const key = await crypto.subtle.deriveKey(p, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        out[c.name] = { bits: b2h(await crypto.subtle.deriveBits(p, base, 256)), ct: b2h(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: h2b(iv) }, key, h2b(pt))) };
      }
      return out;
    },
    { cases, info: hex(info), iv: hex(iv), pt: hex(pt) },
  );
  for (const c of cases) expect(got[c.name], c.name).toEqual({ bits: c.bits, ct: c.ct });
});

test('Ed25519: raw public keys starting with zero bytes import and verify Node’s signatures (and refuse a tampered one)', async ({ page }) => {
  const msg = label('ed-msg');
  const cases = ED_LEADING_ZERO.map((i) => {
    const seed = edSeed(i);
    return { pub: hex(edPublic(seed)), sig: hex(edSign(seed, msg)) };
  });
  expect(cases.map((c) => (c.pub.startsWith('0000') ? 2 : c.pub.startsWith('00') ? 1 : 0))).toEqual([1, 1, 1, 2, 2]);
  const got = await page.evaluate(
    async ({ cases, msg }) => {
      const h2b = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => parseInt(x, 16));
      const out: [boolean, boolean][] = [];
      for (const c of cases) {
        const key = await crypto.subtle.importKey('raw', h2b(c.pub), { name: 'Ed25519' }, false, ['verify']);
        const bad = h2b(msg);
        bad[0]! ^= 1;
        out.push([await crypto.subtle.verify({ name: 'Ed25519' }, key, h2b(c.sig), h2b(msg)), await crypto.subtle.verify({ name: 'Ed25519' }, key, h2b(c.sig), bad)]);
      }
      return out;
    },
    { cases, msg: hex(msg) },
  );
  expect(got).toEqual(cases.map(() => [true, false]));
});

test('Ed25519 session keys: generated (with D381’s retry), exported raw and signing, verified by Node', async ({ page }) => {
  const msg = label('session-msg');
  const keys = await page.evaluate(async (msg) => {
    const h2b = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => parseInt(x, 16));
    const b2h = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
    const out: { pub: string; sig: string; refused: number }[] = [];
    for (let i = 0; i < 64; i++) {
      let refused = 0;
      let kp: CryptoKeyPair | undefined;
      // As core session.ts newSessionKey: an OperationError is asked again, up to 4 attempts.
      while (!kp) {
        try {
          kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
        } catch (e) {
          if ((e as { name?: unknown }).name !== 'OperationError' || ++refused >= 4) throw e;
        }
      }
      out.push({ pub: b2h(await crypto.subtle.exportKey('raw', kp.publicKey)), sig: b2h(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, h2b(msg))), refused });
    }
    return out;
  }, hex(msg));
  for (const k of keys) {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.pub, 'hex')]);
    expect(crypto.verify(null, msg, crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(k.sig, 'hex'))).toBe(true);
  }
  expect(new Set(keys.map((k) => k.pub)).size).toBe(keys.length);
});

test('RS256: a JWK public key imports and verifies Node’s signature (the Google and email token checks)', async ({ page }) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const msg = label('rsa-msg');
  const sig = crypto.sign('sha256', msg, privateKey);
  const got = await page.evaluate(
    async ({ n, e, msg, sig }) => {
      const h2b = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => parseInt(x, 16));
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n, e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const bad = h2b(msg);
      bad[0]! ^= 1;
      return [await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, h2b(sig), h2b(msg)), await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, h2b(sig), bad)];
    },
    { n: jwk.n, e: jwk.e, msg: hex(msg), sig: hex(sig) },
  );
  expect(got).toEqual([true, false]);
});
