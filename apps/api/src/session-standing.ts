// Where a session's identity stands before a session-opening relay (/v1/sessions, /v1/login; batch 6 review M1, L5):
// a pending member's session can only panic on chain (`Sign-in method link is pending`), so it is refused here, and the
// derivation path a member's session opens is its account root's, not its own (exports and the usage uid key on it).
// Read only once links can exist (`get_config().links_open`, cached): on a contract before v3, or before the owner
// accepted the pre-v3 wallets, no identity is a member and nothing extra is read. Fails open (the identity's own path,
// not pending) when the view can't be read: this only saves gas, the contract decides.
import type { Env } from './env.ts';
import { getIdentity } from './link-views.ts';
import { getConfig } from './views.ts';

export interface SessionStanding {
  /** A pending member: every session it opens panics until the link activates or is cancelled. */
  pending: boolean;
  /** The path the session derives: `{scope}#{root provider}#{root sub}#{key_index}` for a member, else its own. */
  path: string;
}

export async function sessionStanding(env: Env, scopeId: string, provider: string, sub: string, keyIndex: number): Promise<SessionStanding> {
  const own: SessionStanding = { pending: false, path: `${scopeId}#${provider}#${sub}#${keyIndex}` };
  try {
    if (!(await getConfig(env)).links_open) return own;
    const view = await getIdentity(env, scopeId, provider, sub);
    if (view.status === 'pending') return { ...own, pending: true };
    if (view.status === 'member' && view.root) return { pending: false, path: `${scopeId}#${view.root.provider}#${view.root.sub}#${keyIndex}` };
    return own;
  } catch {
    return own;
  }
}
