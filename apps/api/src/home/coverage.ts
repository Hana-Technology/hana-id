// Which route Hana Home can open a scope's wallet by, for the signed-in user's sign-in method (docs/hana-home-spec.md
// "Coverage", D42, D468, D490, D501). Pure: the caller reads the chain views. A Google identity and an email identity
// have separate routes, since a token is one or the other.
//
// Google, in order (D490: the exit client only where a scope's normal route is gone):
//   shared          shared login on and a shared Google client in force (the path has no client id: the same address)
//   hana_client     a Google client of the scope that Hana holds (hana_held_clients) and the chain still lists
//   exit            an exit Google client in force (D468): every registered scope, whatever its clients and allow_shared
//   partner_client  only a partner-held client and no exit client in force: best effort, it works while the partner keeps it
//   none            nothing can open a session
// Email: `email` (the scope's own email client), then `exit` (the Home audience on the exit list, D485), then `none`.
// A scope the chain doesn't have is `none`: the exit needs a registered scope too.
import { HOME_EMAIL_AUDIENCE } from '@hana-id/core/home';
import { GOOGLE_PROVIDER } from '@hana-id/jwks';
import { EMAIL_PROVIDER } from '../email-token.ts';
import { type ConfigView, type ScopeView, effectiveExitClients, effectiveSharedClients, isExitClient } from '../views.ts';

export type HomeCoverage = 'shared' | 'hana_client' | 'partner_client' | 'email' | 'exit' | 'none';

export interface HomeRouteChoice {
  coverage: HomeCoverage;
  /** The Google client Home signs in with for this scope, or null (an email route, or no route). */
  googleClientId: string | null;
}

export interface CoverageInput {
  /** The Home identity's provider, from its verified token. */
  provider: string;
  /** `get_scope`, or null when the chain has no such scope. */
  scope: ScopeView | null;
  config: ConfigView;
  /** The Google client ids `hana_held_clients` holds for this scope. */
  heldClients: readonly string[];
  /** The live apps' `google_web_client_id`s (the client GET /v1/app hands out), tried first among a scope's own clients. */
  preferredClients: readonly string[];
  now: number;
}

const NONE: HomeRouteChoice = { coverage: 'none', googleClientId: null };

export function homeCoverage(i: CoverageInput): HomeRouteChoice {
  if (!i.scope) return NONE;
  if (i.provider === EMAIL_PROVIDER) {
    if (i.scope.clients.some(([p]) => p === EMAIL_PROVIDER)) return { coverage: 'email', googleClientId: null };
    return isExitClient(i.config, EMAIL_PROVIDER, HOME_EMAIL_AUDIENCE, i.now) ? { coverage: 'exit', googleClientId: null } : NONE;
  }
  if (i.provider !== GOOGLE_PROVIDER) return NONE;

  const shared = effectiveSharedClients(i.config, i.now).find(([p]) => p === GOOGLE_PROVIDER);
  if (i.scope.allow_shared && shared) return { coverage: 'shared', googleClientId: shared[1] };

  const own = i.scope.clients.filter(([p]) => p === GOOGLE_PROVIDER).map(([, aud]) => aud);
  const held = own.find((aud) => i.heldClients.includes(aud));
  if (held !== undefined) return { coverage: 'hana_client', googleClientId: held };

  const exit = effectiveExitClients(i.config, i.now).find(([p]) => p === GOOGLE_PROVIDER);
  if (exit) return { coverage: 'exit', googleClientId: exit[1] };

  const partner = own.find((aud) => i.preferredClients.includes(aud)) ?? own[0];
  return partner !== undefined ? { coverage: 'partner_client', googleClientId: partner } : NONE;
}
