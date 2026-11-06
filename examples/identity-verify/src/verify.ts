import { calculateJwkThumbprint, createRemoteJWKSet, errors, exportJWK, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// Not secrets: the app id is on your app's page in the partner portal, the issuer and its key thumbprints in the
// partner guide. All three are required, and the verifier refuses to start without them: with no app id, jose would
// skip the audience check and accept a token minted for any other app.
function setting(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is not set: the Hana identity-token verifier refuses to start without it`);
  return value;
}
const HANA_ISSUER = setting('HANA_IDENTITY_ISSUER'); // e.g. https://<hana api>/v1/identity
const HANA_APP_ID = setting('HANA_APP_ID'); // app_…
if (!/^app_[A-Za-z0-9]{1,64}$/u.test(HANA_APP_ID)) throw new Error('HANA_APP_ID must be your app id (app_…), not a publishable key');
const issuerUrl = new URL(HANA_ISSUER); // throws on a malformed URL
if (issuerUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname)) {
  throw new Error('HANA_IDENTITY_ISSUER must be an https:// URL');
}

// The issuer's key thumbprints (comma-separated; each is also its kid). A key that isn't one of them is refused even
// if Hana's JWKS lists it, so a key published by whoever controls Hana's servers never verifies here. Hana announces
// scheduled rotations 14 days ahead. `jwks-only` trusts the JWKS URL alone (not for anything of value); a missing
// value is refused rather than read as "no pins", so pinning can't be dropped by a forgotten variable.
const PINS = setting('HANA_IDENTITY_PINS');
const HANA_PINS = PINS === 'jwks-only' ? [] : PINS.split(',').map((s) => s.trim()).filter(Boolean);
if (PINS !== 'jwks-only' && (HANA_PINS.length === 0 || !HANA_PINS.every((p) => /^[A-Za-z0-9_-]{43}$/u.test(p)))) {
  throw new Error('HANA_IDENTITY_PINS must be key thumbprints (43 base64url characters each, comma-separated) or jwks-only');
}

// Caches the keys for 10 minutes and refetches on an unknown kid (at most every 30 s).
const remoteKeys = createRemoteJWKSet(new URL(`${HANA_ISSUER}/jwks.json`));
const hanaKeys: JWTVerifyGetKey = async (header, token) => {
  const key = await remoteKeys(header, token);
  // Judged by the key itself, never by its kid (anyone can put a pinned kid on another key).
  if (HANA_PINS.length && !HANA_PINS.includes(await calculateJwkThumbprint(await exportJWK(key)))) throw new errors.JWKSNoMatchingKey();
  return key;
};

export interface HanaIdentity {
  userId: string; // sub: stable per user in your app
  sessionId: string; // sid: one per Hana session (device)
  wallets: { chain: 'stellar' | 'evm'; address: string }[];
  email: string | null; // only if the user agreed to share it with you
  loginMethods: string[];
  issuedAt: number; // seconds
}

export class HanaTokenError extends Error {
  constructor(readonly code: 'expired' | 'invalid' | 'stale') {
    super(code);
  }
}

export async function verifyHanaIdentityToken(token: string, opts: { maxAgeSec?: number } = {}): Promise<HanaIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, hanaKeys, {
      issuer: HANA_ISSUER,
      audience: HANA_APP_ID, // mandatory: a token for another app must fail
      algorithms: ['ES256'],
      typ: 'hana-identity+jwt',
      requiredClaims: ['sub', 'sid', 'iat', 'exp', 'wallets'],
      clockTolerance: 30,
      ...(opts.maxAgeSec ? { maxTokenAge: opts.maxAgeSec } : {}),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new HanaTokenError(opts.maxAgeSec && e.claim === 'iat' ? 'stale' : 'expired');
    throw new HanaTokenError('invalid'); // fail closed
  }
  const wallets = Array.isArray(payload.wallets) ? (payload.wallets as HanaIdentity['wallets']) : [];
  return {
    userId: payload.sub!,
    sessionId: payload.sid as string,
    wallets,
    email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email : null,
    loginMethods: Array.isArray(payload.login_methods) ? (payload.login_methods as string[]) : [],
    issuedAt: payload.iat!,
  };
}

// Bind the token to the request's wallet when the wallet also authenticated (e.g. a signed challenge):
export function assertWallet(identity: HanaIdentity, chain: 'stellar' | 'evm', address: string): void {
  const ok = identity.wallets.some((w) => w.chain === chain && (chain === 'evm' ? w.address.toLowerCase() === address.toLowerCase() : w.address === address));
  if (!ok) throw new HanaTokenError('invalid');
}
