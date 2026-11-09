// Hana Home's byte layouts against the independent Node implementation (test/vectors/home-v1.json,
// scripts/gen-home-vectors.mjs). The API's verifier agrees with the same file (apps/api/test/home-identity.test.ts).
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64UrlEncode, fromHex, sha256, toHex, utf8 } from '../src/bytes.ts';
import {
  CONSENT_ID_BYTES,
  HOME_EMAIL_AUDIENCE,
  HOME_HEADER_MAX_CHARS,
  HOME_IDENTITY_MAX_LIFETIME_MS,
  HOME_KEY_BYTES,
  HOME_MESSAGE_DOMAIN,
  HOME_NONCE_DOMAIN,
  HOME_SALT_BYTES,
  consentRegisterPayload,
  consentRevokePayload,
  decodeHomeIdentity,
  encodeHomeIdentity,
  homeMessage,
  homeNonce,
  homeNoncePreimage,
  homeRequestPath,
} from '../src/home.ts';
import { CKD_PAYLOAD_PREFIX, RELAY_AAD_DOMAIN, SESSION_MESSAGE_DOMAIN, SESSION_NONCE_DOMAIN, VAULT_MESSAGE_DOMAIN, VAULT_RECORD_AAD_DOMAIN, sessionNonce, vaultMessage, vaultPayload } from '../src/layouts.ts';
import { type Example, readJson } from './helpers.ts';

interface HomeVectors {
  signer: string;
  app_id: string;
  pk_hex: string;
  seed7_hex: string;
  nonces: Record<string, Example & { input: { signer: string; pk_hex: string; expiresAtMs: number; salt_hex: string }; nonce: string }>;
  messages: Record<string, Example & { input: { signer: string; counter: number; method: string; path: string; body_hex: string }; signature_seed7_hex: string }>;
  header: { fields_input: { jwt: string; pk_hex: string; expiresAtMs: number; salt_hex: string; counter: number; sig_hex: string }; json: string };
  consent: {
    input: { consentId_hex: string; policyId_hex: string; expiresAtMs: number; parentOrigin: string };
    register_payload_hex: string;
    revoke_payload_hex: string;
  } & Record<string, Example & { input: { shareId_hex: string; counter: number; payload_hex: string } }>;
}
const V = readJson<HomeVectors>('vectors/home-v1.json');

const joined = (ex: Example): string => ex.parts.map(([, hex]) => hex).join('');
const nonceInput = (name: string) => {
  const i = V.nonces[name]!.input;
  return { signer: i.signer, homePublicKey: fromHex(i.pk_hex), expiresAtMs: i.expiresAtMs, salt: fromHex(i.salt_hex) };
};

describe('homeNonce', () => {
  it.each(['basic', 'other_signer'])('matches nonces.%s byte for byte', (name) => {
    const ex = V.nonces[name]!;
    const preimage = homeNoncePreimage(nonceInput(name));
    expect(toHex(preimage)).toBe(ex.preimage_hex);
    expect(toHex(preimage)).toBe(joined(ex));
    expect(homeNonce(nonceInput(name))).toBe(ex.nonce);
    expect(ex.nonce).toHaveLength(43);
  });

  it('commits to the signer, the key, the expiry and the salt', () => {
    const base = nonceInput('basic');
    const n = homeNonce(base);
    expect(homeNonce({ ...base, signer: 'x.testnet' })).not.toBe(n);
    expect(homeNonce({ ...base, homePublicKey: new Uint8Array(32).fill(1) })).not.toBe(n);
    expect(homeNonce({ ...base, expiresAtMs: base.expiresAtMs + 1 })).not.toBe(n);
    expect(homeNonce({ ...base, salt: new Uint8Array(32).fill(1) })).not.toBe(n);
  });

  it('refuses a malformed key, salt or expiry', () => {
    const base = nonceInput('basic');
    expect(() => homeNoncePreimage({ ...base, homePublicKey: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => homeNoncePreimage({ ...base, salt: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => homeNoncePreimage({ ...base, salt: new Uint8Array(33) })).toThrow(/32 bytes/);
    expect(() => homeNoncePreimage({ ...base, expiresAtMs: -1 })).toThrow(/u64/);
    expect(HOME_KEY_BYTES).toBe(32);
    expect(HOME_SALT_BYTES).toBe(32);
    expect(HOME_IDENTITY_MAX_LIFETIME_MS).toBe(20 * 60_000);
  });

  it('can never equal a session nonce for the same key, expiry and salt: the domains differ', () => {
    const base = nonceInput('basic');
    expect(HOME_NONCE_DOMAIN).not.toBe(SESSION_NONCE_DOMAIN);
    const session = sessionNonce({ signer: base.signer, scopeId: 's1', sessionPublicKey: base.homePublicKey, expiresAtMs: base.expiresAtMs, keyIndex: 0, maxUses: 1, salt: base.salt });
    expect(homeNonce(base)).not.toBe(session);
  });
});

describe('homeMessage', () => {
  it.each(['get', 'get_query', 'post'])('matches messages.%s', (name) => {
    const ex = V.messages[name]!;
    const i = ex.input;
    const msg = homeMessage({ signer: i.signer, counter: i.counter, method: i.method, path: i.path, body: fromHex(i.body_hex) });
    expect(toHex(msg)).toBe(ex.preimage_hex);
    expect(toHex(msg)).toBe(joined(ex));
  });

  it('binds the method, the path, the query, the body and the counter', () => {
    const base = { signer: V.signer, counter: 1, method: 'GET', path: '/v1/home/apps', body: new Uint8Array(0) };
    const m = toHex(homeMessage(base));
    expect(toHex(homeMessage({ ...base, counter: 2 }))).not.toBe(m);
    expect(toHex(homeMessage({ ...base, method: 'POST' }))).not.toBe(m);
    expect(toHex(homeMessage({ ...base, path: '/v1/home/devices' }))).not.toBe(m);
    expect(toHex(homeMessage({ ...base, path: '/v1/home/apps?x=1' }))).not.toBe(m);
    expect(toHex(homeMessage({ ...base, body: utf8('x') }))).not.toBe(m);
  });

  it('its prefix differs from every other signed layout', () => {
    for (const other of [SESSION_NONCE_DOMAIN, SESSION_MESSAGE_DOMAIN, CKD_PAYLOAD_PREFIX, VAULT_MESSAGE_DOMAIN, VAULT_RECORD_AAD_DOMAIN, RELAY_AAD_DOMAIN]) {
      expect(HOME_MESSAGE_DOMAIN).not.toBe(other);
      expect(HOME_NONCE_DOMAIN).not.toBe(other);
    }
  });

  it('homeRequestPath is the path and the query, as URL normalizes them', () => {
    expect(homeRequestPath(new URL('https://api.test/v1/home/apps'))).toBe('/v1/home/apps');
    expect(homeRequestPath(new URL('https://api.test/v1/home/devices?scopeId=s1'))).toBe('/v1/home/devices?scopeId=s1');
    expect(homeRequestPath(new URL('https://api.test/v1/home/apps?'))).toBe('/v1/home/apps');
  });
});

describe('the vector signatures (Ed25519 by seed [7; 32])', () => {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(V.pk_hex, 'hex').toString('base64url') }, format: 'jwk' });
  const verifies = (msg: Uint8Array, sigHex: string): boolean => verify(null, msg, key, Buffer.from(sigHex, 'hex'));
  const messageOf = (name: string): Uint8Array => {
    const i = V.messages[name]!.input;
    return homeMessage({ signer: i.signer, counter: i.counter, method: i.method, path: i.path, body: fromHex(i.body_hex) });
  };

  it('pk_hex is seed7_hex’s public key', () => {
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(V.seed7_hex, 'hex')]);
    const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!;
    expect(Buffer.from(pub, 'base64url').toString('hex')).toBe(V.pk_hex);
  });

  it.each(['get', 'get_query', 'post'])('messages.%s’s signature verifies over homeMessage’s bytes', (name) => {
    expect(verifies(messageOf(name), V.messages[name]!.signature_seed7_hex)).toBe(true);
  });

  it('a signature doesn’t verify over another message, and the header carries the first one', () => {
    expect(verifies(messageOf('get'), V.messages.post!.signature_seed7_hex)).toBe(false);
    expect(verifies(messageOf('post'), V.messages.get!.signature_seed7_hex)).toBe(false);
    expect(V.header.fields_input.sig_hex).toBe(V.messages.get!.signature_seed7_hex);
  });
});

describe('the x-hana-home header', () => {
  const f = V.header.fields_input;
  const fields = { jwt: f.jwt, key: fromHex(f.pk_hex), expiresAtMs: f.expiresAtMs, salt: fromHex(f.salt_hex), counter: f.counter, sig: fromHex(f.sig_hex) };

  const headerValue = base64UrlEncode(utf8(V.header.json));

  it('encodes exactly as the vector', () => {
    expect(encodeHomeIdentity(fields)).toBe(headerValue);
  });

  it('decodes the vector, and round-trips', () => {
    expect(decodeHomeIdentity(headerValue)).toEqual(fields);
    expect(decodeHomeIdentity(encodeHomeIdentity(fields))).toEqual(fields);
  });

  const reencode = (change: (j: Record<string, unknown>) => void): string => {
    const j = JSON.parse(V.header.json) as Record<string, unknown>;
    change(j);
    return base64UrlEncode(utf8(JSON.stringify(j)));
  };

  it.each([
    ['empty', ''],
    ['not base64url', 'a!b'],
    ['too long', 'A'.repeat(HOME_HEADER_MAX_CHARS + 1)],
    ['not JSON', base64UrlEncode(utf8('not json'))],
    ['a JSON array', base64UrlEncode(utf8('[]'))],
    ['a missing field', reencode((j) => delete j.counter)],
    ['an extra field', reencode((j) => (j.extra = 1))],
    ['an empty jwt', reencode((j) => (j.jwt = ''))],
    ['a key of the wrong length', reencode((j) => (j.key = base64UrlEncode(new Uint8Array(31))))],
    ['a salt of the wrong length', reencode((j) => (j.salt = base64UrlEncode(new Uint8Array(16))))],
    ['a signature of the wrong length', reencode((j) => (j.sig = base64UrlEncode(new Uint8Array(63))))],
    ['padding in a field', reencode((j) => (j.key = `${j.key as string}=`))],
    ['a non-integer counter', reencode((j) => (j.counter = 1.5))],
    ['a negative counter', reencode((j) => (j.counter = -1))],
    ['an expiry of 0', reencode((j) => (j.expiresAtMs = 0))],
    ['an unsafe integer', reencode((j) => (j.expiresAtMs = 2 ** 53))],
  ])('refuses %s', (_name, value) => {
    expect(decodeHomeIdentity(value)).toBeNull();
  });

  it('refuses a key in a non-canonical base64url form (spare bits)', () => {
    const j = JSON.parse(V.header.json) as Record<string, string>;
    // Flip the unused low bits of the last character of a 32-byte value.
    const last = j.key!.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flipped = alphabet[alphabet.indexOf(last) + 1]!;
    expect(decodeHomeIdentity(base64UrlEncode(utf8(JSON.stringify({ ...j, key: j.key!.slice(0, -1) + flipped, counter: 1, expiresAtMs: f.expiresAtMs }))))).toBeNull();
  });

  it('encode refuses wrong lengths', () => {
    expect(() => encodeHomeIdentity({ ...fields, key: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => encodeHomeIdentity({ ...fields, salt: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => encodeHomeIdentity({ ...fields, sig: new Uint8Array(63) })).toThrow(/64 bytes/);
  });

  it('holds a maximum-size email token', () => {
    const big = { ...fields, jwt: JSON.stringify({ payload: 'p'.repeat(7000), signatures: [{ protected: 'q', signature: 'r' }] }) };
    expect(decodeHomeIdentity(encodeHomeIdentity(big))).toEqual(big);
  });
});

describe('HOME_EMAIL_AUDIENCE', () => {
  it('can never be a scope’s email client', () => {
    expect(HOME_EMAIL_AUDIENCE.startsWith('email:')).toBe(false);
  });
});

describe('consent payloads', () => {
  const c = V.consent.input;
  const input = { consentId: fromHex(c.consentId_hex), policyId: fromHex(c.policyId_hex), expiresAtMs: c.expiresAtMs, parentOrigin: c.parentOrigin };

  it('match the vectors', () => {
    expect(toHex(consentRegisterPayload(input))).toBe(V.consent.register_payload_hex);
    expect(toHex(consentRevokePayload(input.consentId))).toBe(V.consent.revoke_payload_hex);
  });

  it('are vaultPayload’s two new actions', () => {
    expect(toHex(vaultPayload.consent(input))).toBe(V.consent.register_payload_hex);
    expect(toHex(vaultPayload.consentRevoke(input.consentId))).toBe(V.consent.revoke_payload_hex);
  });

  it.each([
    ['vault_message_register', input, null],
    ['vault_message_register_none_mode', input, null],
    ['vault_message_revoke', null, input.consentId],
  ] as const)('%s matches byte for byte', (name, register, revoke) => {
    const ex = V.consent[name] as Example & { input: { shareId_hex: string; counter: number; payload_hex: string } };
    const payload = register ? vaultPayload.consent(register) : vaultPayload.consentRevoke(revoke!);
    expect(toHex(payload)).toBe(ex.input.payload_hex);
    const msg = vaultMessage({ signer: V.signer, appId: V.app_id, shareId: fromHex(ex.input.shareId_hex), counter: ex.input.counter, payload });
    expect(toHex(msg)).toBe(ex.preimage_hex);
  });

  it('refuse a consentId or policyId of the wrong length', () => {
    expect(CONSENT_ID_BYTES).toBe(16);
    expect(() => consentRegisterPayload({ ...input, consentId: new Uint8Array(15) })).toThrow(/consentId/);
    expect(() => consentRegisterPayload({ ...input, policyId: new Uint8Array(31) })).toThrow(/policyId/);
    expect(() => consentRevokePayload(new Uint8Array(17))).toThrow(/consentId/);
  });

  it('can’t be confused: the register and revoke tags differ, and each is unlike the older vault payloads', () => {
    const reg = toHex(consentRegisterPayload(input));
    const rev = toHex(consentRevokePayload(input.consentId));
    expect(reg.startsWith(toHex(utf8('consent')))).toBe(true);
    expect(rev.startsWith(toHex(utf8('consent-revoke')))).toBe(true);
    expect(reg).not.toBe(rev);
    for (const older of ['share', 'unlock', 'touch', 'revoke', 'revoke-all']) {
      expect(reg.startsWith(toHex(utf8(older)))).toBe(false);
      expect(rev.startsWith(toHex(utf8(older)))).toBe(false);
    }
    expect(toHex(sha256(utf8('x')))).toHaveLength(64);
  });
});
