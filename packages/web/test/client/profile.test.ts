// @vitest-environment happy-dom
// The user's shared name from the identity token: profileFromIdentityToken's decoding (absent, malformed and unsafe
// claims dropped), hana.getProfile() over getIdentityToken (null while logged out, maxAgeMs passed on, errors
// unchanged), and hana.profile with profileChanged (only when the name changes, never on a new token with the same name).
import { ErrorCode, PROFILE_NAME_MAX, base64UrlEncode, utf8 } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaError, RpcCode } from '../../src/client/errors.ts';
import { type HanaProfile, profileFromIdentityToken, sameProfile } from '../../src/client/profile.ts';
import { LOGGED_IN, LOGGED_OUT, type Setup, flush, setup } from './harness.ts';

const SIG = 'c'.repeat(86);
const HEADER = base64UrlEncode(utf8(JSON.stringify({ alg: 'ES256', kid: 'k'.repeat(43), typ: 'hana-identity+jwt' })));
let jtiCounter = 0;

/** A token shaped like the API's (unsigned: the page never checks the signature), with `extra` claims added. */
function tokenWith(extra: Record<string, unknown>): string {
  jtiCounter += 1;
  const claims = { iss: 'https://api.hana.test', aud: 'app_test', sub: `u1_${'A'.repeat(22)}`, sid: `s1_${'B'.repeat(22)}`, iat: 1_800_000_000, exp: 1_800_003_600, jti: `jti-${jtiCounter}`, ...extra };
  return `${HEADER}.${base64UrlEncode(utf8(JSON.stringify(claims)))}.${SIG}`;
}
const payloadToken = (payload: string | Uint8Array): string => `${HEADER}.${base64UrlEncode(typeof payload === 'string' ? utf8(payload) : payload)}.${SIG}`;

const EXP = 1_900_000_000_000;
const NO_NAME = { givenName: null, familyName: null };

describe('profileFromIdentityToken', () => {
  it('null for no token; the two claims when set; null for each one absent', () => {
    expect(profileFromIdentityToken(null)).toBeNull();
    expect(profileFromIdentityToken(tokenWith({ given_name: 'Ada', family_name: 'Lovelace' }))).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });
    expect(profileFromIdentityToken(tokenWith({ given_name: 'Ada' }))).toEqual({ givenName: 'Ada', familyName: null });
    expect(profileFromIdentityToken(tokenWith({ family_name: 'Lovelace' }))).toEqual({ givenName: null, familyName: 'Lovelace' });
    expect(profileFromIdentityToken(tokenWith({}))).toEqual(NO_NAME);
    // Names outside ASCII, a single inner space, and exactly the maximum length are kept as they are.
    expect(profileFromIdentityToken(tokenWith({ given_name: 'José María', family_name: '王' }))).toEqual({ givenName: 'José María', familyName: '王' });
    const longest = '名'.repeat(PROFILE_NAME_MAX);
    expect(profileFromIdentityToken(tokenWith({ given_name: longest }))?.givenName).toBe(longest);
  });

  it('frozen; one shared object for every token without a name', () => {
    const p = profileFromIdentityToken(tokenWith({ given_name: 'Ada' }))!;
    expect(Object.isFrozen(p)).toBe(true);
    const a = profileFromIdentityToken(tokenWith({}));
    expect(Object.isFrozen(a)).toBe(true);
    expect(profileFromIdentityToken(tokenWith({}))).toBe(a);
  });

  it('a claim that is not a normalized profile name reads as absent; the other part is kept', () => {
    const unsafe: unknown[] = [
      '', // empty: not set
      '   ', // blank
      ' Ada', // untrimmed
      'Ada ', // untrimmed
      'Ada  Byron', // two spaces
      'Ada\tByron', // a tab
      'José', // not NFC (the decomposed é)
      'A'.repeat(PROFILE_NAME_MAX + 1), // too long
      'Ada\u0000', // control
      'Ada\nByron', // a line break
      'Ada‮', // bidi override
      'Ad​a', // zero-width space
      '', // private use
      42,
      true,
      null,
      ['Ada'],
      { name: 'Ada' },
    ];
    for (const v of unsafe) {
      expect(profileFromIdentityToken(tokenWith({ given_name: v, family_name: 'Lovelace' })), JSON.stringify(v)).toEqual({ givenName: null, familyName: 'Lovelace' });
      expect(profileFromIdentityToken(tokenWith({ given_name: 'Ada', family_name: v })), JSON.stringify(v)).toEqual({ givenName: 'Ada', familyName: null });
    }
  });

  it('a token it cannot read (not three parts, bad base64url, bad UTF-8, not a JSON object) reads as no name, never throws', () => {
    const bad = [
      'a.b',
      `${HEADER}.${tokenWith({ given_name: 'Ada' }).split('.')[1]}.${SIG}.extra`,
      `${HEADER}.not*base64.${SIG}`,
      `${HEADER}.${'b'.repeat(301)}.${SIG}`, // a length base64url can't have
      payloadToken(Uint8Array.of(0x7b, 0xff, 0xfe, 0x7d)), // invalid UTF-8
      payloadToken('{"given_name":"Ada"'), // truncated JSON
      payloadToken('["Ada"]'),
      payloadToken('"Ada"'),
      payloadToken('null'),
      payloadToken('42'),
      '',
    ];
    for (const t of bad) expect(profileFromIdentityToken(t), t).toEqual(NO_NAME);
  });

  it('ignores claims with other names (name, nickname, a prototype key)', () => {
    expect(profileFromIdentityToken(tokenWith({ name: 'Ada Lovelace', nickname: 'Ada' }))).toEqual(NO_NAME);
    expect(profileFromIdentityToken(payloadToken('{"__proto__":{"given_name":"Ada"}}'))).toEqual(NO_NAME);
  });

  it('sameProfile compares the parts, and null only with null', () => {
    const p = (givenName: string | null, familyName: string | null): HanaProfile => ({ givenName, familyName });
    expect(sameProfile(null, null)).toBe(true);
    expect(sameProfile(null, p(null, null))).toBe(false);
    expect(sameProfile(p(null, null), null)).toBe(false);
    expect(sameProfile(p('Ada', null), p('Ada', null))).toBe(true);
    expect(sameProfile(p('Ada', null), p('Ada', 'L'))).toBe(false);
    expect(sameProfile(p('Ada', 'L'), p('Ade', 'L'))).toBe(false);
  });
});

let s: Setup;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

describe('getProfile', () => {
  it('reads the name from the token getIdentityToken returns (one hana_identityToken call)', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const token = tokenWith({ given_name: 'Ada', family_name: 'Lovelace' });
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: token, expiresAtMs: EXP } }));
    expect(await s.client.getProfile()).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });
    expect(s.vault.requests.filter((r) => r.method === 'hana_identityToken')).toHaveLength(1);
    expect(s.vault.last('hana_identityToken').params).toBeUndefined();
    expect(s.client.identityToken).toBe(token);
    expect(s.client.profile).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });
  });

  it('logged in with no name shared: both parts null; logged out: null', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: tokenWith({}), expiresAtMs: EXP } }));
    expect(await s.client.getProfile()).toEqual(NO_NAME);
    s.client.destroy();
    document.body.replaceChildren();

    s = setup();
    await s.vault.connect(LOGGED_OUT);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: null, expiresAtMs: null } }));
    expect(await s.client.getProfile()).toBeNull();
    expect(s.client.profile).toBeNull();
  });

  it('passes maxAgeMs to getIdentityToken (clamped as there) and refuses what it refuses', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: tokenWith({ given_name: 'Ada' }), expiresAtMs: EXP } }));
    await s.client.getProfile({ maxAgeMs: 120_000 });
    expect(s.vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 120_000 });
    await s.client.getProfile({ maxAgeMs: 1 });
    expect(s.vault.last('hana_identityToken').params).toEqual({ maxAgeMs: 30_000 });
    const e = await rejection(s.client.getProfile({ maxAgeMs: 0 }));
    expect(e).toBeInstanceOf(HanaError);
    expect((e as HanaError).code).toBe(RpcCode.invalidParams);
    expect(await rejection(s.client.getProfile(null as unknown as object))).toBeInstanceOf(TypeError);
  });

  it('propagates getIdentityToken’s errors unchanged (code, message, data)', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    for (const code of ['identity_unavailable', 'session_ended', 'rate_limited'] as const) {
      s.vault.handle('hana_identityToken', () => ({ error: { code, message: `m-${code}`, data: { requestId: '3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b' } } }));
      const fromToken = (await rejection(s.client.getIdentityToken())) as HanaError;
      const fromProfile = (await rejection(s.client.getProfile())) as HanaError;
      expect(fromProfile).toBeInstanceOf(HanaError);
      expect({ code: fromProfile.code, message: fromProfile.message, data: fromProfile.data }).toEqual({ code: fromToken.code, message: fromToken.message, data: fromToken.data });
      expect(fromProfile.code).toBe(code);
    }
    s.client.destroy();
    expect(((await rejection(s.client.getProfile())) as HanaError).code).toBe(ErrorCode.disconnected);
  });
});

describe('hana.profile and profileChanged', () => {
  it('fires only when the name changes, with the new profile; the getters are current inside either event', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    let next = tokenWith({ given_name: 'Ada' });
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: next, expiresAtMs: EXP } }));
    s.vault.handle('hana_logout', () => ({ result: null }));
    const profiles: (HanaProfile | null)[] = [];
    const tokens: (string | null)[] = [];
    const seenInTokenEvent: (HanaProfile | null)[] = [];
    s.client.on('profileChanged', (p) => {
      expect(s.client.profile).toBe(p);
      profiles.push(p);
    });
    s.client.on('identityTokenChanged', (t) => {
      tokens.push(t);
      seenInTokenEvent.push(s.client.profile);
    });
    expect(s.client.profile).toBeNull();

    // First token: null → Ada.
    await s.client.getIdentityToken();
    expect(profiles).toEqual([{ givenName: 'Ada', familyName: null }]);
    expect(seenInTokenEvent).toEqual([{ givenName: 'Ada', familyName: null }]);
    const first = s.client.profile;

    // A new token with the same name: identityTokenChanged only, and the same profile object.
    next = tokenWith({ given_name: 'Ada' });
    await s.client.getIdentityToken({ maxAgeMs: 30_000 });
    expect(tokens).toHaveLength(2);
    expect(profiles).toHaveLength(1);
    expect(s.client.profile).toBe(first);

    // Another tab's token with a new name (the user changed it in Hana Home).
    s.vault.emit('identityTokenChanged', { identityToken: tokenWith({ given_name: 'Ada', family_name: 'Lovelace' }), expiresAtMs: EXP + 1 });
    await flush();
    expect(profiles.at(-1)).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });

    // The user stopped sharing: a token without the claims.
    s.vault.emit('identityTokenChanged', { identityToken: tokenWith({}), expiresAtMs: EXP + 2 });
    await flush();
    expect(profiles.at(-1)).toEqual(NO_NAME);
    // And another token without them: nothing.
    s.vault.emit('identityTokenChanged', { identityToken: tokenWith({}), expiresAtMs: EXP + 3 });
    await flush();
    expect(profiles).toHaveLength(3);

    // Logout: null.
    await s.client.logout();
    expect(profiles.at(-1)).toBeNull();
    expect(s.client.profile).toBeNull();
    expect(profiles).toHaveLength(4);
    expect(tokens).toHaveLength(6);
  });

  it('null with the token at sessionExpired, the vault’s null and a dead vault', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_identityToken', () => ({ result: { identityToken: tokenWith({ given_name: 'Ada' }), expiresAtMs: EXP } }));
    const profiles: (HanaProfile | null)[] = [];
    s.client.on('profileChanged', (p) => profiles.push(p));

    await s.client.getProfile();
    s.vault.emit('sessionExpired', null);
    await flush();
    expect(profiles.at(-1)).toBeNull();

    await s.client.getProfile();
    s.vault.emit('identityTokenChanged', { identityToken: null, expiresAtMs: null });
    await flush();
    expect(profiles.at(-1)).toBeNull();

    await s.client.getProfile();
    expect(s.client.profile).toEqual({ givenName: 'Ada', familyName: null });
    s.vault.load();
    await flush();
    expect(profiles.at(-1)).toBeNull();
    expect(s.client.profile).toBeNull();
    expect(profiles).toHaveLength(6);
  });

  it('a token with no name after none at all fires (null → no name), and a malformed claim is no change from no name', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const profiles: (HanaProfile | null)[] = [];
    s.client.on('profileChanged', (p) => profiles.push(p));
    s.vault.emit('identityTokenChanged', { identityToken: tokenWith({}), expiresAtMs: EXP });
    await flush();
    expect(profiles).toEqual([NO_NAME]);
    s.vault.emit('identityTokenChanged', { identityToken: tokenWith({ given_name: 'Ada‮' }), expiresAtMs: EXP + 1 });
    await flush();
    expect(profiles).toEqual([NO_NAME]);
    expect(s.client.profile).toEqual(NO_NAME);
  });
});
