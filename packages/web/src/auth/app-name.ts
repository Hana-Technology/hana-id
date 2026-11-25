// An app's name as Journear's pages show it: Passport Home's list of the apps that use a wallet, and the sign-in and
// approval windows' list of the other apps that share it (shared-wallet.ts, D912). One rule for all of them.
import { isDisplaySafeLine } from '@hana-id/core';

export const HOME_NAME_MAX = 200;
/** How much of an app's name the page shows, in characters; a longer one ends in "…". */
export const HOME_NAME_SHOWN = 60;
/** What stands in for a name the page won't show (empty, too long, or with a control, bidi or invisible character). */
export const HOME_UNNAMED_APP = 'Unnamed app';

/**
 * An app's name as the page shows it. The name is the partner's own words on Hana's origin, so it is held to the one
 * display-safety rule (no control, direction-changing or invisible character) and cut short; a name that fails is
 * replaced by Hana's own words, never shown. The app stays listed either way: a user's wallet is never hidden by it.
 */
export function homeAppName(v: unknown): string {
  if (typeof v !== 'string') return HOME_UNNAMED_APP;
  const name = v.trim();
  if (name.length === 0 || name.length > HOME_NAME_MAX || !isDisplaySafeLine(name)) return HOME_UNNAMED_APP;
  const chars = [...name];
  return chars.length <= HOME_NAME_SHOWN ? name : `${chars.slice(0, HOME_NAME_SHOWN).join('').trimEnd()}…`;
}
