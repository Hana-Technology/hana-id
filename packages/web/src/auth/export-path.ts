// The path a sign-in's key is derived from, for the pages that derive one themselves: the export window
// (export-page.ts) and Hana Home (home-page.ts). The same rule as the vault's login (vault/login.ts): `get_identity`
// names the identity or its account's root, and a path that isn't the signed-in identity's own is confirmed on both
// NEAR providers, each read alone, before it is used (path-check.ts): a lying RPC that knows a path's secret could
// otherwise have the page show its own wallet's key as the user's. The identity's own path needs no second opinion:
// only the MPC can answer for it, and the pairing check catches anything else.
//
// The path is `scopeId#provider#sub#keyIndex` of the root. Nothing here changes how it is built: `pathIdentity` (core)
// is the one rule, and this file only reads the chain for it.
//
// SECURITY: views are public. A `sub` goes to the NEAR RPC in the view's arguments, as in every login.
import { type IdentityView, parseIdentityView, pathIdentity } from '@hana-id/core';
import { PathCheckError, type PathCheckReason, confirmPath } from '../path-check.ts';
import { PageError } from './errors.ts';
import type { NearReader } from './near-rpc.ts';

export interface ExportPathInput {
  near: NearReader;
  /** The pinned signer. */
  signer: string;
  scopeId: string;
  /** The signed-in identity, from the page's own verified token. */
  who: { provider: 'google' | 'email'; sub: string };
  keyIndex: number;
}

export interface ExportPath {
  path: string;
  /** The path is the account root's, not the signed-in identity's own (a linked sign-in method). */
  linked: boolean;
}

/** Why a path was refused, beside the PageError's code: which sentence a page shows. */
export type ExportPathReason = 'identity_unreadable' | 'link_pending' | 'root_unsupported' | PathCheckReason;

export class ExportPathError extends PageError {
  constructor(
    code: PageError['code'],
    message: string,
    readonly reason: ExportPathReason,
  ) {
    super(code, message);
  }
}

/** The path this sign-in opens. Throws ExportPathError (a PageError); never falls back to the own path. */
export async function exportPath(i: ExportPathInput): Promise<ExportPath> {
  const unreadable = () => new ExportPathError('api_unavailable', 'Your sign-in method could not be read on NEAR. Try again.', 'identity_unreadable');
  let view: IdentityView;
  try {
    view = parseIdentityView(await i.near.view(i.signer, 'get_identity', { scope_id: i.scopeId, provider: i.who.provider, sub: i.who.sub }));
  } catch {
    throw unreadable();
  }
  let p;
  try {
    p = pathIdentity(i.scopeId, i.who, view);
  } catch {
    throw unreadable();
  }
  if (p.kind === 'pending') throw new ExportPathError('link_pending', 'This sign-in method’s link to the wallet is still pending. Sign in with the wallet’s own method.', 'link_pending');
  if (p.kind === 'unsupported') throw new ExportPathError('login_method_unavailable', 'This wallet’s sign-in method isn’t supported here.', 'root_unsupported');
  if (p.linked) {
    try {
      await confirmPath({ scopeId: i.scopeId, via: i.who, viaView: view, path: p.identity, views: i.near.independent(i.signer) });
    } catch (e) {
      if (!(e instanceof PathCheckError)) throw e;
      throw new ExportPathError(
        'api_unavailable',
        e.reason === 'path_disputed' ? 'NEAR providers disagree about the wallet this sign-in opens. Nothing was exported; try again later.' : 'The wallet this sign-in opens could not be confirmed on NEAR. Try again.',
        e.reason,
      );
    }
  }
  return { path: `${i.scopeId}#${p.identity.provider}#${p.identity.sub}#${i.keyIndex}`, linked: p.linked };
}
