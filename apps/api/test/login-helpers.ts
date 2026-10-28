// Test helpers for batch B's login side: Hana-origin headers, app keys, /v1/login bodies and the combined contract call.
import { baseDecode, baseEncode } from '@near-js/utils';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { env } from 'cloudflare:workers';
import { ckdPayload } from '../src/session-crypto.ts';
import { ORIGIN, type Chain, google, sessionBody, signSession } from './helpers.ts';
import { type RsaSigner, receiptFailure } from './near-mock.ts';

export const VAULT = env.VAULT_ORIGIN!;
export const AUTH = env.AUTH_ORIGIN!;

/** Headers of a call from a Hana page acting for `parent` (omitted when null). */
export const hanaHeaders = (app: { key: string }, origin: string = VAULT, parent: string | null = ORIGIN): Record<string, string> => ({
  'x-hana-key': app.key,
  origin,
  ...(parent === null ? {} : { 'x-hana-parent-origin': parent }),
});

export type AppKey = { pk1: string; pk2: string };

/** A valid publicly verifiable BLS app key (a·G1, a·G2) for scalar `a` (random by default). */
export function appKey(a: bigint = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey())): AppKey {
  return {
    pk1: `bls12381g1:${baseEncode(bls.G1.ProjectivePoint.BASE.multiply(a).toRawBytes(true))}`,
    pk2: `bls12381g2:${baseEncode(bls.G2.ProjectivePoint.BASE.multiply(a).toRawBytes(true))}`,
  };
}

/** pk1 and pk2 of different scalars: well-formed points that fail the pairing check. */
export const mismatchedAppKey = (): AppKey => ({ pk1: appKey(5n).pk1, pk2: appKey(7n).pk2 });

/**
 * A /v1/login body: a /v1/sessions body (genuine token committing to it, see sessionBody) plus the session key's
 * signature over counter 1 of the CKD payload for `key`. `overrides` replace fields after signing (pass `signature`
 * to keep a custom one).
 */
export async function loginBody(
  scope: string,
  aud: string,
  overrides: Record<string, unknown> = {},
  claims: Record<string, unknown> = {},
  key: AppKey = appKey(),
  signer: RsaSigner = google,
): Promise<Record<string, unknown>> {
  const { signature, pk1, pk2, ...createOverrides } = overrides;
  const body = await sessionBody(scope, aud, { maxUses: 1, ...createOverrides }, claims, signer);
  const p1 = (pk1 as string | undefined) ?? key.pk1;
  const p2 = (pk2 as string | undefined) ?? key.pk2;
  return { ...body, pk1: p1, pk2: p2, signature: signature ?? (await signSession(body.sessionPublicKey as number[], 1, ckdPayload(p1, p2))) };
}

/**
 * Teaches `near` the combined call as the contract runs it: create_session (its own checks, plus "Session key already
 * in use"), then derive_key with counter 1, all or nothing. With `ckd: 'fail'` the MPC's receipt fails after the
 * session was committed with `used = 1`; with `ckd: 'pairing'` it fails when pk1 and pk2 are not one key.
 */
export function withCombinedCall(near: Chain, opts: { ckd?: 'ok' | 'fail' | 'pairing' } = {}): Chain {
  near.contract.create_session_and_derive = (a, tx) => {
    const existing = near.sessions.get(JSON.stringify(a.session_public_key));
    if (existing && (existing.expires_at_ms as number) > Date.now()) throw new Error('Session key already in use');
    const session = near.contract.create_session!(a, tx) as Record<string, unknown>;
    near.sessions.set(JSON.stringify(a.session_public_key), { ...session, used: 1 });
    const mode = opts.ckd ?? 'pairing';
    if (mode === 'fail') return receiptFailure(env.MPC_ACCOUNT, 'CKD request failed');
    if (mode === 'pairing' && !sameScalar(a.pk1 as string, a.pk2 as string)) return receiptFailure(env.MPC_ACCOUNT, 'Invalid app public key');
    return { big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' };
  };
  return near;
}

/** e(pk1, g2) = e(g1, pk2), as the MPC checks. */
function sameScalar(pk1: string, pk2: string): boolean {
  try {
    const p1 = bls.G1.ProjectivePoint.fromHex(new Uint8Array(baseDecode(pk1.slice('bls12381g1:'.length))));
    const p2 = bls.G2.ProjectivePoint.fromHex(new Uint8Array(baseDecode(pk2.slice('bls12381g2:'.length))));
    return bls.fields.Fp12.eql(bls.pairing(p1, bls.G2.ProjectivePoint.BASE), bls.pairing(bls.G1.ProjectivePoint.BASE, p2));
  } catch {
    return false;
  }
}
