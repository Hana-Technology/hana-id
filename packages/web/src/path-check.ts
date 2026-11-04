// A path that is not the signed-in identity's own, confirmed on two independent NEAR RPC providers (D263).
//
// The CKD pairing check only proves that an answer is the MPC's key *for the path the vault asked about*. When the
// vault derives its own identity's path, a lying RPC can't steer it anywhere useful: an answer that pairs for that
// path is the user's own key. But a `get_identity` view that says "member of root R" makes the vault compute R's path,
// and whoever knows S for R (R's owner) can forge `{big_y = y·G1, big_c = S + y·A}` for the vault's public `A`; the CKD
// outcome comes from the same RPC (the API's NEAR_RPC is the same provider). The user would then deposit into a wallet
// the attacker holds. So whenever the path is another identity's, the view that named it must be read again on each of
// two providers separately (the manifest's `rpc` and `rpcFallback`, never one through the other), each must agree on
// status, root and key, and the root's own `get_identity` must show it is an account root (own, its computed key) on
// both. A provider that can't be reached, or no second provider at all, refuses: the vault never falls back to the own
// path when a member view can't be confirmed.
//
// SECURITY: views are public; nothing secret passes here. The answer is a refusal or nothing.
import { type IdentityRef, type IdentityView, identityKeyHex, parseIdentityView } from '@hana-id/core';

/** One provider's view call: a view of the signer at optimistic finality, as parsed JSON, from that provider only. */
export type ViewRead = (method: string, args: unknown) => Promise<unknown>;

/** The two providers a path is confirmed on, each read alone (no fallback from one to the other). */
export interface IndependentViews {
  primary: ViewRead;
  second: ViewRead;
}

export type PathCheckReason =
  /** No second provider is configured, or a provider didn't answer: the path can't be confirmed (try again). */
  | 'path_unconfirmed'
  /** The providers disagree, or a view isn't the identity asked about: a lying RPC, or a link changing right now. */
  | 'path_disputed';

export class PathCheckError extends Error {
  constructor(readonly reason: PathCheckReason) {
    super(reason === 'path_unconfirmed' ? 'The wallet this sign-in opens could not be confirmed on NEAR' : 'NEAR providers disagree about the wallet this sign-in opens');
  }
}

const sameRef = (a: IdentityRef | null, b: IdentityRef | null): boolean => (a === null || b === null ? a === b : a.provider === b.provider && a.sub === b.sub);

/** Same status, root and key: what decides a path. */
export const sameIdentityView = (a: IdentityView, b: IdentityView): boolean => a.key === b.key && a.status === b.status && sameRef(a.root, b.root);

async function read(r: ViewRead, scopeId: string, who: IdentityRef): Promise<IdentityView | 'unreachable' | 'malformed'> {
  let raw: unknown;
  try {
    raw = await r('get_identity', { scope_id: scopeId, provider: who.provider, sub: who.sub });
  } catch {
    return 'unreachable';
  }
  try {
    return parseIdentityView(raw);
  } catch {
    return 'malformed';
  }
}

export interface PathConfirmInput {
  scopeId: string;
  /** The identity whose view named the path (the signed-in one, or a link judgement's target side). */
  via: IdentityRef;
  /** That view, as first read. */
  viaView: IdentityView;
  /** The identity whose own path the vault will derive. */
  path: IdentityRef;
  /** The two providers, or null when the env has no second one. */
  views: IndependentViews | null;
}

/**
 * Confirms `path` on both providers (see the header). Throws PathCheckError; returns nothing when confirmed. Both
 * providers are asked side by side, and every answer must be in before the verdict, so a fast liar can't race it.
 */
export async function confirmPath(i: PathConfirmInput): Promise<void> {
  if (!i.views) throw new PathCheckError('path_unconfirmed');
  const { primary, second } = i.views;
  const rootToo = !sameRef(i.via, i.path);
  const [p, s, pr, sr] = await Promise.all([
    read(primary, i.scopeId, i.via),
    read(second, i.scopeId, i.via),
    rootToo ? read(primary, i.scopeId, i.path) : Promise.resolve(null),
    rootToo ? read(second, i.scopeId, i.path) : Promise.resolve(null),
  ]);
  const answers = [p, s, pr, sr];
  if (answers.includes('malformed')) throw new PathCheckError('path_disputed');
  if (answers.includes('unreachable')) throw new PathCheckError('path_unconfirmed');
  const viaKey = identityKeyHex(i.scopeId, i.via.provider, i.via.sub);
  for (const v of [p, s] as IdentityView[]) {
    if (v.key !== viaKey || !sameIdentityView(v, i.viaView)) throw new PathCheckError('path_disputed');
  }
  if (rootToo) {
    // The path must be what the view says: the root of the account (via's root), and an account root is "own".
    if (!sameRef(i.viaView.root, i.path)) throw new PathCheckError('path_disputed');
    const rootKey = identityKeyHex(i.scopeId, i.path.provider, i.path.sub);
    for (const v of [pr, sr] as IdentityView[]) {
      if (v.key !== rootKey || v.status !== 'own' || v.root !== null) throw new PathCheckError('path_disputed');
    }
  } else if (i.viaView.status !== 'own') {
    throw new PathCheckError('path_disputed');
  }
}
