// D918: platform keys' shared pieces. The public key as a partner pastes it (PEM or JWK; a private key, another curve,
// a compressed point or a point off the curve refused), its RFC 7638 thumbprint, and the three step-up layouts and
// the two link tokens, each against the independent generator (scripts/gen-vectors.mjs); the label rule; four eyes'
// email comparison; every ledger kind with a title.
import { describe, expect, it } from 'vitest';
import {
  ACTION_TITLES,
  APP_CHANGE_KINDS,
  DOMAINS,
  PLATFORM_KEY_DOMAINS,
  PLATFORM_KEY_LEDGER_KINDS,
  STEP_UP_KINDS,
  b64url,
  fromHex,
  hex,
  jwkThumbprint,
  linkToken,
  linkTokenHash,
  nonceOf,
  onP256,
  parsePlatformPublicKey,
  personEmailKey,
  platformKeyDigest,
  platformKeyLabel,
  rawToJwk,
} from '../src/index.ts';
import vectors from './vectors.json' with { type: 'json' };

const v = vectors.platform_key;
const base = { signer: vectors.inputs.signer, env: v.env, orgId: v.org_id, thumbprint: v.thumbprint, scopes: v.scopes, label: v.label };

describe('the public key', () => {
  it('reads the JWK and the PEM to the same point and RFC 7638 thumbprint as the independent generator', async () => {
    for (const text of [JSON.stringify(v.jwk), v.pem, `  ${v.pem}\n`, JSON.stringify({ ...v.jwk, alg: 'ES256', use: 'sig', kid: 'k1' })]) {
      const p = await parsePlatformPublicKey(text);
      expect(p.ok, text.slice(0, 30)).toBe(true);
      if (!p.ok) continue;
      expect(hex(p.key.raw)).toBe(v.raw_hex);
      expect(p.key.thumbprint).toBe(v.thumbprint);
      expect(p.key.jwk).toEqual(v.jwk);
    }
    expect(await jwkThumbprint(v.jwk.x, v.jwk.y)).toBe(v.thumbprint);
    expect(rawToJwk(fromHex(v.raw_hex))).toEqual(v.jwk);
  });

  it('refuses a private key with words that say so, and never echoes the input', async () => {
    const d = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    for (const text of [JSON.stringify({ ...v.jwk, d }), `-----BEGIN ${'PRIVATE'} KEY-----\nAAAA\n-----END ${'PRIVATE'} KEY-----`, `-----BEGIN EC ${'PRIVATE'} KEY-----\nAAAA\n-----END EC ${'PRIVATE'} KEY-----`]) {
      const p = await parsePlatformPublicKey(text);
      expect(p).toMatchObject({ ok: false, private: true });
      if (!p.ok) expect(p.problem).not.toContain(d);
    }
  });

  it('refuses another curve or algorithm, extra members, bad coordinates, a compressed or off-curve point, and anything else', async () => {
    const bad = [
      JSON.stringify({ ...v.jwk, crv: 'P-384' }),
      JSON.stringify({ ...v.jwk, kty: 'RSA' }),
      JSON.stringify({ ...v.jwk, alg: 'ES384' }),
      JSON.stringify({ ...v.jwk, n: 'x' }),
      JSON.stringify({ ...v.jwk, x: v.jwk.x.slice(1) }),
      JSON.stringify({ ...v.jwk, y: v.jwk.x }),
      v.pem.replace('BEGIN PUBLIC', 'BEGIN OTHER'),
      v.pem.replace(/\n[A-Za-z0-9+/]{4}/u, '\nAAAA'),
      '[1,2]',
      'not a key',
      '',
      'x'.repeat(3000),
    ];
    for (const text of bad) expect((await parsePlatformPublicKey(text)).ok, text.slice(0, 40)).toBe(false);
    const x = fromHex(v.raw_hex).subarray(1, 33);
    const y = fromHex(v.raw_hex).subarray(33);
    expect(onP256(x, y)).toBe(true);
    expect(onP256(y, x)).toBe(false);
    expect(onP256(new Uint8Array(32).fill(0xff), y)).toBe(false);
  });
});

describe('the step-up layouts and links', () => {
  it('registration, acceptance and confirmation match the independent generator, each with its own domain', async () => {
    expect(nonceOf(await platformKeyDigest({ kind: 'add', keyId: '', ...base }))).toBe(v.add.nonce);
    expect(nonceOf(await platformKeyDigest({ kind: 'accept', keyId: v.key_id, ...base }))).toBe(v.accept.nonce);
    expect(nonceOf(await platformKeyDigest({ kind: 'confirm', keyId: v.key_id, ...base }))).toBe(v.confirm.nonce);
    expect(new Set([v.add.nonce, v.accept.nonce, v.confirm.nonce]).size).toBe(3);
    expect(Object.values(PLATFORM_KEY_DOMAINS)).toEqual([DOMAINS.platformKeyAdd, DOMAINS.platformKeyAccept, DOMAINS.platformKeyConfirm]);
    // The scopes' order given doesn't matter (sorted by bytes); every other field does.
    expect(nonceOf(await platformKeyDigest({ kind: 'add', keyId: '', ...base, scopes: [...v.scopes].reverse() }))).toBe(v.add.nonce);
    for (const change of [{ env: 'other' }, { orgId: 'org_other' }, { label: 'Other' }, { thumbprint: 'A'.repeat(43) }, { scopes: [v.scopes[0]!] }, { signer: 'other.testnet' }]) {
      expect(nonceOf(await platformKeyDigest({ kind: 'add', keyId: '', ...base, ...change })), JSON.stringify(change)).not.toBe(v.add.nonce);
    }
  });

  it('refuses a malformed step: a registration with a key id, a confirmation without one, three scopes, a duplicate scope', async () => {
    await expect(platformKeyDigest({ kind: 'add', keyId: 'pkc_x', ...base })).rejects.toThrow();
    await expect(platformKeyDigest({ kind: 'confirm', keyId: '', ...base })).rejects.toThrow();
    await expect(platformKeyDigest({ kind: 'add', keyId: '', ...base, scopes: ['a', 'b', 'c'] })).rejects.toThrow();
    await expect(platformKeyDigest({ kind: 'add', keyId: '', ...base, scopes: ['a', 'a'] })).rejects.toThrow();
  });

  it('the cancel and stop links’ tokens match the generator', async () => {
    const key = new Uint8Array(32).fill(0x11);
    const cancel = await linkToken('platformKeyCancel', key, v.key_id);
    const revoke = await linkToken('platformKeyRevoke', key, v.key_id);
    expect(b64url(cancel)).toBe(v.cancel_link.token);
    expect(hex(await linkTokenHash(cancel))).toBe(v.cancel_link.token_hash_hex);
    expect(b64url(revoke)).toBe(v.revoke_link.token);
    expect(b64url(await linkToken('cancelLink', key, v.key_id))).not.toBe(v.cancel_link.token);
  });
});

describe('labels, people and words', () => {
  it('a label is one display-safe line of at most 40 characters, never a brand or a web address', () => {
    expect(platformKeyLabel('  Production backend ')).toEqual({ ok: true, label: 'Production backend' });
    for (const bad of ['', 'x'.repeat(41), 'Journear backend', 'api.example.com', 'a‮b', 'line\nbreak']) expect(platformKeyLabel(bad).ok, bad).toBe(false);
  });

  it('four eyes compares emails without dots and +tags in the local part, case aside', () => {
    expect(personEmailKey('A.B+x@Example.com')).toBe('ab@example.com');
    expect(personEmailKey('ab@example.com')).toBe(personEmailKey('a.b@example.com'));
    expect(personEmailKey('ab@example.com')).not.toBe(personEmailKey('ab@other.example'));
    expect(personEmailKey('a.b@ex.ample.com')).toBe('ab@ex.ample.com');
  });

  it('every ledger kind is an app change kind with a title; the step-up kinds include the three', () => {
    for (const k of PLATFORM_KEY_LEDGER_KINDS) {
      expect(APP_CHANGE_KINDS as readonly string[], k).toContain(k);
      expect(ACTION_TITLES[k], k).toBeTruthy();
    }
    expect(STEP_UP_KINDS).toEqual(expect.arrayContaining(['platform.key_add', 'platform.key_accept', 'platform.key_confirm']));
  });
});
