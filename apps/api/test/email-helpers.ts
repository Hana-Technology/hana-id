// Test helpers for email login (build plan batch 6): a throwaway email issuer key, email tokens in the issuer's JWS JSON
// form, apps with email on, and a chain that knows the email client, the signer policy and the identities and
// accounts the link prechecks read (the contract's views, kept as plain records here).
import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { base64Encode, borshString, concatBytes, hex } from '../src/bytes.ts';
import { IDENTITY_DOMAIN, identityKey } from '../src/session-crypto.ts';
import { type Chain, uid } from './helpers.ts';

/** The identity key, hex, computed synchronously (the mock's views are synchronous). */
export const ikSync = (scope: string, provider: string, sub: string): string =>
  createHash('sha256').update(concatBytes(new TextEncoder().encode(IDENTITY_DOMAIN), borshString(scope), borshString(provider), borshString(sub))).digest('hex');

export const EMAIL_ISS = 'https://api.test/v1/email';

const b64url = (s: string | Uint8Array): string => base64Encode(typeof s === 'string' ? new TextEncoder().encode(s) : s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

export interface EmailSigner {
  kid: string;
  jwk: { kty: 'RSA'; kid: string; n: string; e: string; use: 'sig'; alg: 'RS256' };
  sign(input: string): Promise<string>;
}

export async function emailSigner(kid = `ek-${uid()}`): Promise<EmailSigner> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwk: { kty: 'RSA', kid, n: pub.n!, e: pub.e!, use: 'sig', alg: 'RS256' },
    async sign(input) {
      return b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input))));
    },
  };
}

/** The issuer's own key for these tests (the vitest env doesn't set EMAIL_*: tests pass them per request). */
export const issuer = await emailSigner('hana-email-test');

/** An email token in the issuer's exact form (apps/email-issuer/src/jws.ts): claims in its order, one signature each. */
export async function emailToken(claims: Record<string, unknown>, signers: EmailSigner[] = [issuer]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ordered = { iss: EMAIL_ISS, aud: 'email:s', sub: `e1.${uid()}`, iat: now, exp: now + 600, nonce: 'n', jti: 'AAECAwQFBgcICQoLDA0ODw', ...claims };
  const payload = b64url(JSON.stringify(ordered));
  const signatures = [];
  for (const s of signers) {
    const prot = b64url(JSON.stringify({ alg: 'RS256', kid: s.kid }));
    signatures.push({ protected: prot, signature: await s.sign(`${prot}.${payload}`) });
  }
  return JSON.stringify({ payload, signatures });
}

/** The env bindings that turn email tokens on for a request. */
export const emailEnv = (signers: EmailSigner[] = [issuer]): Partial<typeof env> => ({ EMAIL_ISS, EMAIL_PUBLIC_KEYS: JSON.stringify(signers.map((s) => s.jwk)) });

export async function setLoginMethods(appId: string, methods: string): Promise<void> {
  await env.DB.prepare('UPDATE apps SET login_methods = ?2 WHERE id = ?1').bind(appId, methods).run();
}

export const emailAud = (scope: string): string => `email:${scope}`;

export interface IdentityRecord {
  status: 'own' | 'member' | 'pending';
  opened: boolean;
  root?: { provider: string; sub: string };
}

export interface AccountRecord {
  root: { provider: string; sub: string };
  members: { provider: string; sub: string; active: boolean; effectiveAtMs?: number; auto?: boolean }[];
  epoch: number;
  unlinked?: string[];
}

export interface EmailChain extends Chain {
  /** `${provider}#${sub}` → its standing (absent: own, no wallet). */
  identities: Map<string, IdentityRecord>;
  /** Accounts by their root's `${provider}#${sub}`. */
  accounts: Map<string, AccountRecord>;
  /** get_self_issued("email"): signer id → kids, and required. */
  policy: { signers: { id: string; kids: string[] }[]; required: number } | null;
  /** get_config().unrecorded_wallets (undefined: a pre-v3 contract, the field is absent). */
  unrecordedWallets: boolean | undefined;
}

/**
 * Extends `near` (a chain() mock) with email: the scope's email client (`email:<scope>`, for every scope in `scopes`),
 * the signer policy (the issuer's key active, 1-of-1), links open (`unrecorded_wallets` false) and the identity views.
 */
export function withEmail(near: Chain, scopes: string[]): EmailChain {
  const e = Object.assign(near, {
    identities: new Map<string, IdentityRecord>(),
    accounts: new Map<string, AccountRecord>(),
    policy: { signers: [{ id: 'hana', kids: [issuer.kid] }], required: 1 } as EmailChain['policy'],
    unrecordedWallets: false as boolean | undefined,
  });
  const scopeFor = near.views.scope_for_client!;
  near.views.scope_for_client = (a) => (a.provider === 'email' ? (scopes.find((s) => emailAud(s) === a.aud) ?? null) : scopeFor(a));
  const getScope = near.views.get_scope!;
  near.views.get_scope = (a) => {
    const v = getScope(a) as Record<string, unknown> | null;
    if (!v || !scopes.includes(a.scope_id as string)) return v;
    return { ...v, clients: [...(v.clients as unknown[]), ['email', emailAud(a.scope_id as string)]] };
  };
  const getConfig = near.views.get_config!;
  near.views.get_config = () => ({ ...(getConfig({}) as Record<string, unknown>), ...(e.unrecordedWallets === undefined ? {} : { unrecorded_wallets: e.unrecordedWallets }) });
  near.views.get_self_issued = (a) => (a.provider === 'email' && e.policy ? { provider: 'email', signers: e.policy.signers, required: e.policy.required, overlap_until_ms: null } : null);
  near.views.get_identity = (a) => {
    const key = ikSync(a.scope_id as string, a.provider as string, a.sub as string);
    const rec = e.identities.get(`${a.provider}#${a.sub}`) ?? { status: 'own', opened: false };
    const rootName = rec.root ? `${rec.root.provider}#${rec.root.sub}` : `${a.provider}#${a.sub}`;
    return { key, status: rec.status, opened: rec.opened, root: rec.root ?? null, effective_at_ms: null, account_epoch: e.accounts.get(rootName)?.epoch ?? 0 };
  };
  near.views.get_account = (a) => {
    const rec = e.identities.get(`${a.provider}#${a.sub}`);
    const rootName = rec?.root ? `${rec.root.provider}#${rec.root.sub}` : `${a.provider}#${a.sub}`;
    const acc = e.accounts.get(rootName);
    if (!acc) return null;
    const members = acc.members.map((m) => ({ key: ikSync(a.scope_id as string, m.provider, m.sub), provider: m.provider, effective_at_ms: m.effectiveAtMs ?? 0, active: m.active, auto: m.auto ?? false }));
    return { root: acc.root, members, epoch: acc.epoch, unlinked: acc.unlinked ?? [] };
  };
  return e;
}

/** The identity key, hex. */
export const ikHex = async (scope: string, provider: string, sub: string): Promise<string> => hex(await identityKey(scope, provider, sub));

/** The (provider, sub) of an email token's payload. */
export function emailClaims(token: string): { sub: string; aud: string; nonce: string } {
  const payload = (JSON.parse(token) as { payload: string }).payload;
  return JSON.parse(atob(payload.replace(/-/gu, '+').replace(/_/gu, '/'))) as { sub: string; aud: string; nonce: string };
}

/** The env the request runs with: email on (the issuer's key), as `call(..., {env})` takes it. */
export const withEmailEnv = (): Partial<typeof env> => emailEnv();

export { env };
