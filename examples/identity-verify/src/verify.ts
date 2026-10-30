import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';

// From Hana's partner console / your Hana app page. Not secrets.
const HANA_ISSUER = process.env.HANA_IDENTITY_ISSUER!; // e.g. https://<hana api>/v1/identity
const HANA_APP_ID = process.env.HANA_APP_ID!; // app_…

// Caches the keys for 10 minutes and refetches on an unknown kid (at most every 30 s).
const hanaKeys = createRemoteJWKSet(new URL(`${HANA_ISSUER}/jwks.json`));

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
