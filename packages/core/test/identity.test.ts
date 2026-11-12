// The partner identity token's layouts, ids and claims (src/identity.ts) against test/vectors/identity-v1.json, written
// by scripts/gen-identity-vectors.mjs (an independent node:crypto implementation), plus the rules the vectors can't
// show: key_index ignored, malformed paths refused, the claim set exact, the lifetime capping.
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { checksumEvmAddress, parseEvmAddress, stellarAddress } from '../src/addresses.ts';
import { base64UrlDecode, fromHex, sha256, toHex, utf8 } from '../src/bytes.ts';
import { withChainKey, deriveAddresses } from '../src/derivation.ts';
import {
  IDENTITY_MIN_LIFETIME_S,
  IDENTITY_TOKEN_MAX_LIFETIME_S,
  type WalletProofs,
  buildIdentityClaims,
  normalizeProfileName,
  PROFILE_NAME_MAX,
  canonicalWalletAddress,
  identityJwksEntry,
  identityLifetime,
  identityMessage,
  identityRoot,
  identitySid,
  identitySigningInput,
  identitySub,
  identitySubBytes,
  identityTokenHeader,
  identityTokenPayload,
  isIdentityTokenResponse,
  isP256PublicJwk,
  jwkThumbprint,
  sealedEmailAad,
  type EmailConsentAction,
  emailConsentPayload,
  signWalletProof,
  verifyWalletProof,
  walletProofMessage,
  walletProofsHash,
} from '../src/identity.ts';
import { type Example, readJson } from './helpers.ts';

interface IdentityVectors {
  signer: string;
  app_id: string;
  parent_origin: string;
  scope_id: string;
  sub_key_hex: string;
  session_pk7_hex: string;
  issued_at_ms: number;
  nonce_hex: string;
  stellar_seed_hex: string;
  stellar_address: string;
  evm_address: string;
  evm_signature_hex: string;
  layouts: Record<string, Example>;
  subs: Record<string, Example & { path: string; sub: string; sub_bytes_hex: string }>;
  sids: Record<string, Example & { app_id: string; sid: string }>;
  thumbprint: { jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; input: string; kid: string };
  claims: { input: Record<string, unknown> & { jti_hex: string; login_methods_unsorted: string[]; wallets: { stellar: string; evm: string } }; json: string; header_json: string; signing_input: string };
}

const V = readJson<IdentityVectors>('./vectors/identity-v1.json');
const KEY = fromHex(V.sub_key_hex);
const PK7 = fromHex(V.session_pk7_hex);
const CTX = { signer: V.signer, appId: V.app_id, sessionPublicKey: PK7 };
const L = V.layouts;
const joined = (ex: Example): string => ex.parts.map(([, h]) => h).join('');

const vectorProofs = (): WalletProofs => ({
  stellar: { address: V.stellar_address, signature: fromHex(L.wallet_proof_stellar!.signature_hex as string) },
  evm: { address: V.evm_address, signature: fromHex(V.evm_signature_hex) },
});

describe('identity layouts (vectors)', () => {
  it('wallet proof messages match field by field', () => {
    for (const [name, chain, address] of [
      ['wallet_proof_stellar', 'stellar', V.stellar_address],
      ['wallet_proof_evm', 'evm', V.evm_address],
    ] as const) {
      const msg = walletProofMessage(CTX, chain, address);
      expect(toHex(msg)).toBe(L[name]!.preimage_hex);
      expect(toHex(msg)).toBe(joined(L[name]!));
    }
    expect(toHex(walletProofMessage({ ...CTX, appId: 'app_fedcba9876543210' }, 'evm', V.evm_address))).toBe(L.wallet_proof_evm_other_app!.preimage_hex);
    expect(toHex(sha256(walletProofMessage(CTX, 'evm', V.evm_address)))).toBe(L.wallet_proof_evm!.digest_hex);
  });

  it('the Stellar wallet proof is the deterministic Ed25519 signature of the vector seed', () => {
    const seed = fromHex(V.stellar_seed_hex);
    expect(stellarAddress(ed25519.getPublicKey(seed))).toBe(V.stellar_address);
    expect(toHex(signWalletProof('stellar', seed, walletProofMessage(CTX, 'stellar', V.stellar_address)))).toBe(L.wallet_proof_stellar!.signature_hex);
  });

  it('the wallet proofs hash covers stellar then evm, each chain, address and signature', () => {
    expect(toHex(walletProofsHash(vectorProofs()))).toBe(L.wallet_proofs_hash!.hash_hex);
    const swapped = vectorProofs();
    swapped.evm.signature = fromHex(`43${V.evm_signature_hex.slice(2)}`);
    expect(toHex(walletProofsHash(swapped))).not.toBe(L.wallet_proofs_hash!.hash_hex);
  });

  it('the session proof message and payload match, and the vector signature verifies', () => {
    for (const name of ['identity_message', 'identity_message_sealed']) {
      const ex = L[name]!;
      const payload = identityTokenPayload({ parentOrigin: V.parent_origin, walletProofsHash: walletProofsHash(vectorProofs()), sealedEmail: (ex.sealed_email as string) || null });
      expect(toHex(payload)).toBe(ex.payload_hex);
      const msg = identityMessage({ ...CTX, issuedAtMs: V.issued_at_ms, nonce: fromHex(V.nonce_hex), payload });
      expect(toHex(msg)).toBe(ex.preimage_hex);
      expect(toHex(msg)).toBe(joined(ex));
      expect(ed25519.verify(fromHex(ex.signature_seed7_hex as string), msg, PK7)).toBe(true);
    }
    // An absent blob and an empty one hash the same (sha256 of "").
    const h = walletProofsHash(vectorProofs());
    expect(identityTokenPayload({ parentOrigin: 'o', walletProofsHash: h })).toEqual(identityTokenPayload({ parentOrigin: 'o', walletProofsHash: h, sealedEmail: '' }));
  });

  it('refuses malformed inputs', () => {
    expect(() => identityMessage({ ...CTX, sessionPublicKey: new Uint8Array(31), issuedAtMs: 1, nonce: new Uint8Array(16), payload: new Uint8Array() })).toThrow('32 bytes');
    expect(() => identityMessage({ ...CTX, issuedAtMs: 1, nonce: new Uint8Array(15), payload: new Uint8Array() })).toThrow('16 bytes');
    expect(() => identityMessage({ ...CTX, issuedAtMs: -1, nonce: new Uint8Array(16), payload: new Uint8Array() })).toThrow(RangeError);
    expect(() => identityTokenPayload({ parentOrigin: 'o', walletProofsHash: new Uint8Array(31) })).toThrow('32 bytes');
    expect(() => walletProofMessage({ ...CTX, sessionPublicKey: new Uint8Array(33) }, 'evm', V.evm_address)).toThrow('32 bytes');
  });

  it('the email consent proof (D411) matches, and its payload is no mint payload', () => {
    for (const name of ['email_consent_granted', 'email_consent_revoke']) {
      const ex = L[name]!;
      const payload = emailConsentPayload({ action: ex.action as EmailConsentAction, parentOrigin: V.parent_origin, sealedEmail: (ex.sealed_email as string) || null });
      expect(toHex(payload)).toBe(ex.payload_hex);
      const msg = identityMessage({ ...CTX, issuedAtMs: V.issued_at_ms, nonce: fromHex(V.nonce_hex), payload });
      expect(toHex(msg)).toBe(ex.preimage_hex);
      expect(ed25519.verify(fromHex(ex.signature_seed7_hex as string), msg, PK7)).toBe(true);
    }
    expect(() => emailConsentPayload({ action: 'grant' as EmailConsentAction, parentOrigin: 'o' })).toThrow('Unknown');
    const a = toHex(emailConsentPayload({ action: 'granted', parentOrigin: 'o', sealedEmail: 'x' }));
    expect(a).not.toBe(toHex(emailConsentPayload({ action: 'declined', parentOrigin: 'o', sealedEmail: 'x' })));
    expect(a).not.toBe(toHex(identityTokenPayload({ parentOrigin: 'o', walletProofsHash: new Uint8Array(32), sealedEmail: 'x' })));
  });

  it('sealed-email AAD', () => {
    expect(toHex(sealedEmailAad(V.app_id, PK7, L.sealed_email_aad!.not_after_ms as number))).toBe(L.sealed_email_aad!.preimage_hex);
  });
});

describe('sub and sid (vectors)', () => {
  it('sub per scope and account root, key_index ignored', () => {
    for (const ex of Object.values(V.subs)) {
      const scope = ex.path.split('#')[0]!;
      const root = identityRoot(ex.path, scope);
      expect(root).not.toBeNull();
      expect(toHex(identitySubBytes(KEY, scope, root!))).toBe(ex.sub_bytes_hex);
      expect(identitySub(KEY, scope, root!)).toBe(ex.sub);
      expect(ex.sub).toHaveLength(25);
    }
    expect(V.subs.google_k0!.sub).toBe(V.subs.google_k1!.sub);
    expect(V.subs.google_k0!.sub).not.toBe(V.subs.google_other_scope!.sub);
    expect(V.subs.google_k0!.sub).not.toBe(V.subs.email_root!.sub);
  });

  it('sid per app and session key', () => {
    for (const ex of Object.values(V.sids)) expect(identitySid(KEY, ex.app_id, PK7)).toBe(ex.sid);
    expect(V.sids.app!.sid).not.toBe(V.sids.other_app!.sid);
    expect(identitySid(KEY, V.app_id, new Uint8Array(32).fill(8))).not.toBe(V.sids.app!.sid);
  });

  it('the key must be 32 bytes, and a different key gives different ids', () => {
    const root = { provider: 'google', sub: '1' };
    expect(() => identitySub(new Uint8Array(31), 's1', root)).toThrow('32 bytes');
    expect(() => identitySid(new Uint8Array(33), 'app_x', PK7)).toThrow('32 bytes');
    expect(identitySub(new Uint8Array(32), 's1', root)).not.toBe(identitySub(KEY, 's1', root));
    // Never the Google sub itself, nor anything containing it.
    expect(identitySub(KEY, 's1', { provider: 'google', sub: '110248495921238986420' })).not.toContain('110248495921238986420');
  });

  it('borsh framing: moving bytes between scope, provider and sub changes the id', () => {
    expect(identitySub(KEY, 's1', { provider: 'google', sub: 'ab' })).not.toBe(identitySub(KEY, 's1g', { provider: 'oogle', sub: 'ab' }));
  });
});

describe('identityRoot', () => {
  it('takes exactly provider, sub and a decimal key index after the app scope', () => {
    expect(identityRoot('s1#google#123#0', 's1')).toEqual({ provider: 'google', sub: '123' });
    expect(identityRoot('s1#google#123#7', 's1')).toEqual({ provider: 'google', sub: '123' });
    expect(identityRoot('s1#email#Zx9-_#2147483647', 's1')).toEqual({ provider: 'email', sub: 'Zx9-_' });
  });

  it.each([
    ['another scope', 's2#google#123#0'],
    ['a scope prefix only', 's1x#google#123#0'],
    ['two parts', 's1#google#123'],
    ['four parts', 's1#google#12#3#0'],
    ['an empty sub', 's1#google##0'],
    ['an empty provider', 's1##123#0'],
    ['a non-decimal key index', 's1#google#123#x'],
    ['a key index with a leading zero', 's1#google#123#01'],
    ['an upper-case provider', 's1#Google#123#0'],
    ['nothing after the scope', 's1#'],
  ])('refuses %s', (_name, path) => {
    expect(identityRoot(path, 's1')).toBeNull();
  });
});

describe('wallet proofs (sign and verify)', () => {
  const prk = new Uint8Array(32).fill(5);
  const addresses = deriveAddresses(prk);
  const prove = (chain: 'stellar' | 'evm', ctx = CTX) => withChainKey(prk, chain, 0, (key) => signWalletProof(chain, key, walletProofMessage(ctx, chain, addresses[chain])));

  it('a proof made inside withChainKey verifies for its own address', () => {
    expect(verifyWalletProof(CTX, 'stellar', { address: addresses.stellar, signature: prove('stellar') })).toBe(addresses.stellar);
    expect(verifyWalletProof(CTX, 'evm', { address: addresses.evm, signature: prove('evm') })).toBe(addresses.evm);
    expect(prove('evm')).toHaveLength(65);
  });

  it('a non-EIP-55 EVM address is normalized for the message and the answer', () => {
    const sig = prove('evm');
    expect(verifyWalletProof(CTX, 'evm', { address: addresses.evm.toLowerCase(), signature: sig })).toBe(addresses.evm);
    expect(verifyWalletProof(CTX, 'evm', { address: `0x${addresses.evm.slice(2).toUpperCase()}`, signature: sig })).toBe(addresses.evm);
    // A broken mixed-case checksum is refused, not normalized.
    const broken = addresses.evm.replace(/[a-f]/u, (c) => c.toUpperCase());
    if (broken !== addresses.evm) expect(verifyWalletProof(CTX, 'evm', { address: broken, signature: sig })).toBeNull();
  });

  it('refuses a proof for another session, another app or another signer', () => {
    for (const ctx of [{ ...CTX, sessionPublicKey: new Uint8Array(32).fill(9) }, { ...CTX, appId: 'app_other' }, { ...CTX, signer: 'other.testnet' }]) {
      expect(verifyWalletProof(ctx, 'stellar', { address: addresses.stellar, signature: prove('stellar') })).toBeNull();
      expect(verifyWalletProof(ctx, 'evm', { address: addresses.evm, signature: prove('evm') })).toBeNull();
    }
  });

  it('refuses swapped addresses and a signature that recovers to a different address', () => {
    const other = deriveAddresses(new Uint8Array(32).fill(6));
    expect(verifyWalletProof(CTX, 'stellar', { address: other.stellar, signature: prove('stellar') })).toBeNull();
    expect(verifyWalletProof(CTX, 'evm', { address: other.evm, signature: prove('evm') })).toBeNull();
    // A Stellar signature as an EVM one, and the reverse.
    expect(verifyWalletProof(CTX, 'evm', { address: addresses.evm, signature: prove('stellar') })).toBeNull();
    expect(verifyWalletProof(CTX, 'stellar', { address: addresses.stellar, signature: prove('evm') })).toBeNull();
    // Malformed signatures and addresses.
    const bad = prove('evm');
    bad[64] = 29;
    expect(verifyWalletProof(CTX, 'evm', { address: addresses.evm, signature: bad })).toBeNull();
    expect(verifyWalletProof(CTX, 'stellar', { address: 'GNOTANADDRESS', signature: prove('stellar') })).toBeNull();
    expect(verifyWalletProof(CTX, 'evm', { address: '0x1234', signature: prove('evm') })).toBeNull();
  });

  it('canonicalWalletAddress', () => {
    expect(canonicalWalletAddress('evm', V.evm_address.toLowerCase())).toBe(V.evm_address);
    expect(canonicalWalletAddress('stellar', V.stellar_address)).toBe(V.stellar_address);
    expect(canonicalWalletAddress('stellar', V.stellar_address.toLowerCase())).toBeNull();
    expect(checksumEvmAddress(parseEvmAddress(V.evm_address))).toBe(V.evm_address);
  });
});

describe('claims', () => {
  const c = V.claims.input;
  const input = () => ({
    iss: c.iss as string,
    aud: c.aud as string,
    sub: c.sub as string,
    sid: c.sid as string,
    iat: c.iat as number,
    exp: c.exp as number,
    jti: fromHex(c.jti_hex),
    wallets: c.wallets,
    loginMethods: c.login_methods_unsorted,
  });

  it('exactly the listed claims, in order, login methods sorted and distinct (vector)', () => {
    const claims = buildIdentityClaims(input());
    expect(JSON.stringify(claims)).toBe(V.claims.json);
    expect(Object.keys(claims)).toEqual(['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods']);
    expect(JSON.stringify(identityTokenHeader(V.thumbprint.kid))).toBe(V.claims.header_json);
    expect(identitySigningInput(identityTokenHeader(V.thumbprint.kid), claims).text).toBe(V.claims.signing_input);
  });

  it('email only with email_verified: true, never alone', () => {
    const withEmail = buildIdentityClaims({ ...input(), email: 'ada@example.com' });
    expect(withEmail.email).toBe('ada@example.com');
    expect(withEmail.email_verified).toBe(true);
    expect(Object.keys(withEmail).slice(-2)).toEqual(['email', 'email_verified']);
    for (const email of [undefined, null]) {
      const none = buildIdentityClaims({ ...input(), email });
      expect('email' in none).toBe(false);
      expect('email_verified' in none).toBe(false);
    }
    expect(() => buildIdentityClaims({ ...input(), email: 'not-an-address' })).toThrow('email');
  });

  it('given_name and family_name only when shared, each alone, after email; malformed parts refused', () => {
    const both = buildIdentityClaims({ ...input(), email: 'ada@example.com', givenName: 'Ada', familyName: 'Lovelace King' });
    expect(Object.keys(both).slice(-4)).toEqual(['email', 'email_verified', 'given_name', 'family_name']);
    expect([both.given_name, both.family_name]).toEqual(['Ada', 'Lovelace King']);
    const given = buildIdentityClaims({ ...input(), givenName: 'Ada', familyName: null });
    expect(given.given_name).toBe('Ada');
    expect('family_name' in given).toBe(false);
    const none = buildIdentityClaims({ ...input(), givenName: null, familyName: undefined });
    expect('given_name' in none || 'family_name' in none).toBe(false);
    // Only a value normalizeProfileName returns as is: never untrimmed, never unsafe, never too long.
    for (const bad of [' Ada', 'A\u202Eda', 'x'.repeat(PROFILE_NAME_MAX + 1), '', 'Ada\nB'])
      expect(() => buildIdentityClaims({ ...input(), givenName: bad })).toThrow('given_name');
    expect(() => buildIdentityClaims({ ...input(), familyName: 'a\u200Bb' })).toThrow('family_name');
  });

  it('normalizeProfileName: NFC, trimmed, spaces folded, 1-50 code points, display-safe', () => {
    expect(normalizeProfileName('  Ada   Byron ')).toBe('Ada Byron');
    expect(normalizeProfileName('Jose\u0301')).toBe('Jos\u00e9');
    expect(normalizeProfileName('李')).toBe('李');
    expect(normalizeProfileName('🙂'.repeat(PROFILE_NAME_MAX))).toBe('🙂'.repeat(PROFILE_NAME_MAX));
    for (const empty of [null, undefined, '', '   ']) expect(normalizeProfileName(empty)).toBeNull();
    for (const bad of [42, {}, 'x'.repeat(PROFILE_NAME_MAX + 1), 'a\u202Eb', 'a\u200Bb', 'a\u0000b', 'a\uE000b', 'a\u2028b', 'a\uFE0Fb', 'a\nb', 'a\uFEFFb'])
      expect(normalizeProfileName(bad)).toBeUndefined();
  });

  it('never carries a path, scope, Google sub or session key', () => {
    const text = JSON.stringify(buildIdentityClaims(input()));
    for (const s of ['#', 'scope', 'path', 'session', 'nbf', 'name', 'picture', 'hd', 'locale']) expect(text).not.toContain(s);
  });

  it.each([
    ['a lifetime over an hour', { exp: (c.iat as number) + IDENTITY_TOKEN_MAX_LIFETIME_S + 1 }],
    ['a lifetime under 30 s', { exp: (c.iat as number) + IDENTITY_MIN_LIFETIME_S - 1 }],
    ['a non-app audience', { aud: 'pk_test_abc' }],
    ['a malformed sub', { sub: 'u1_short' }],
    ['a malformed sid', { sid: 'u1_8pQm3yR0tZ1vW5xA7cB2dE' }],
    ['a short jti', { jti: new Uint8Array(15) }],
    ['a lowercase (non-canonical) EVM wallet', { wallets: { stellar: c.wallets.stellar, evm: c.wallets.evm.toLowerCase() } }],
    ['no login method', { loginMethods: [] }],
    ['a malformed login method', { loginMethods: ['Google'] }],
    ['a relative issuer', { iss: '/v1/identity' }],
  ])('refuses %s', (_name, change) => {
    expect(() => buildIdentityClaims({ ...input(), ...change })).toThrow();
  });
});

describe('identityLifetime', () => {
  const now = 1_800_000_000_500;
  const iat = 1_800_000_000;

  it('one hour when the session lasts longer', () => {
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 5 * 3_600_000 })).toEqual({ iat, exp: iat + 3600 });
  });

  it('capped at the on-chain expiry, the idle limit and the absolute cap, whichever is first (rounded down)', () => {
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 600_999 })).toEqual({ iat, exp: iat + 601 });
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 5 * 3_600_000, share: { idleUntilMs: now + 120_000, absCapMs: now + 9_000_000 } })).toEqual({ iat, exp: iat + 120 });
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 5 * 3_600_000, share: { idleUntilMs: now + 9_000_000, absCapMs: now + 300_000 } })).toEqual({ iat, exp: iat + 300 });
  });

  it('null when less than 30 s would remain', () => {
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 29_000 })).toBeNull();
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 31_000 })).toEqual({ iat, exp: iat + 31 });
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now + 5 * 3_600_000, share: { idleUntilMs: now + 10_000, absCapMs: now + 9_000_000 } })).toBeNull();
    expect(identityLifetime({ nowMs: now, sessionExpiresAtMs: now - 1 })).toBeNull();
  });
});

describe('JWK thumbprint and JWKS entries', () => {
  it('RFC 7638 over crv, kty, x, y in that order (vector)', () => {
    const jwk = V.thumbprint.jwk;
    expect(jwkThumbprint(jwk)).toBe(V.thumbprint.kid);
    expect(toHex(sha256(utf8(V.thumbprint.input)))).toBe(toHex(base64UrlDecode(V.thumbprint.kid)));
    // Member order and extra members of the input don't matter.
    expect(jwkThumbprint({ y: jwk.y, x: jwk.x, crv: 'P-256', kty: 'EC', d: 'ignored', kid: 'x' } as never)).toBe(V.thumbprint.kid);
  });

  it('a JWKS entry has the public members only, kid = thumbprint', () => {
    const entry = identityJwksEntry({ ...V.thumbprint.jwk, d: 'secret' } as never);
    expect(entry).toEqual({ kty: 'EC', crv: 'P-256', x: V.thumbprint.jwk.x, y: V.thumbprint.jwk.y, kid: V.thumbprint.kid, use: 'sig', alg: 'ES256' });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('refuses keys that are not P-256 public JWKs', () => {
    expect(isP256PublicJwk({ kty: 'RSA', n: 'x', e: 'AQAB' })).toBe(false);
    expect(isP256PublicJwk({ kty: 'EC', crv: 'P-384', x: V.thumbprint.jwk.x, y: V.thumbprint.jwk.y })).toBe(false);
    expect(isP256PublicJwk({ kty: 'EC', crv: 'P-256', x: 'short', y: V.thumbprint.jwk.y })).toBe(false);
    expect(() => jwkThumbprint({ kty: 'EC', crv: 'P-256', x: 'short', y: 'short' })).toThrow();
  });
});

describe('isIdentityTokenResponse', () => {
  const token = `${'a'.repeat(40)}.${'b'.repeat(200)}.${'c'.repeat(86)}`;
  it('accepts a compact ES256 token with expiresAtMs and an email status', () => {
    expect(isIdentityTokenResponse({ identityToken: token, expiresAtMs: 1_800_003_600_000, emailStatus: 'off' })).toBe(true);
  });
  it.each([
    ['a short signature', { identityToken: `${'a'.repeat(40)}.${'b'.repeat(200)}.${'c'.repeat(85)}`, expiresAtMs: 1, emailStatus: 'off' }],
    ['two parts', { identityToken: `${'a'.repeat(40)}.${'b'.repeat(200)}`, expiresAtMs: 1, emailStatus: 'off' }],
    ['an unknown email status', { identityToken: token, expiresAtMs: 1, emailStatus: 'maybe' }],
    ['no expiry', { identityToken: token, emailStatus: 'off' }],
  ])('refuses %s', (_name, v) => {
    expect(isIdentityTokenResponse(v)).toBe(false);
  });
});
