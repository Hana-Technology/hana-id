// Shared-scope rules (D915; docs/partner-platform-spec.md piece P0, finding H3). On a scope Journear staff mark as
// shared (`scopes.app_user_ids`, migration 0026), several partners' apps use one wallet per person; an app created by
// a network's backend (`apps.created_by_kind = 'platform'`) is one of those partners' apps. Neither may have an
// auto-approve policy: a policy one partner set would let that partner's site sign from a wallet every other partner's
// site also uses, without asking the user each time. The API, the console, the admin portal and the admin CLI all
// read these words and this rule from here.

/** Who created an app (`apps.created_by_kind`): Journear staff, or a network's backend through the platform API. */
export const APP_CREATOR_KINDS = ['hana', 'platform'] as const;
export type AppCreatorKind = (typeof APP_CREATOR_KINDS)[number];

/** The refusal of an auto-approve policy for such an app (code `policy_invalid`), and what the screens say instead. */
export const SHARED_WALLET_NO_AUTO_APPROVE = 'Auto-approve is off for apps that share a wallet';

/** Why staff can't mark a scope as shared yet (code `conflict`). */
export const SHARED_SCOPE_POLICY_IN_THE_WAY =
  'An app on this scope has an auto-approve policy in force or waiting: remove it or cancel it first, then mark the scope as shared';

/**
 * Whether an app may never have an auto-approve policy: it is on a shared scope, or Journear staff didn't create it.
 * Fails closed: any creator but `hana` (an unknown value included) counts as the platform.
 */
export function autoApproveRefused(a: { sharedScope: boolean; createdByKind: AppCreatorKind | (string & {}) }): boolean {
  return a.sharedScope || a.createdByKind !== 'hana';
}

/** Why a live scope can't be marked yet (code `env_mismatch`): D915 after PR 145's review. */
export const SHARED_SCOPE_TEST_ONLY = 'Only a test scope can be marked as shared for now: a live shared scope needs its own security review first';
