// Linking one person's IDs across a network's apps (D925; docs/partner-platform-spec.md piece P7, B6, finding L9). On a
// scope Journear staff marked as shared (D915), each app created after the mark gives a person a User ID and Support ID
// of its own (D919, `apps.user_ids = 'app'`), and the API records which apps of the scope a person signed in on, with
// each app's IDs (`end_user_apps`, migration 0030). This is the one place that mapping is revealed, to two parties only:
//
// - **the network's owners**, in the partner console (`ConsoleRpc.linkUser`): "This person on your apps" for one person
//   of a marked scope of their own org, and the per-app search (any app's User ID or Support ID, or the scope's). Owners
//   only (D913 question 5), never the network's backend (question 4), audited before each answer, limited per member
//   and per org, and alerted on in volume;
// - **Journear staff**, in the admin portal's Support ID lookup (`AdminRpc.supportLookup`), which resolves either kind
//   of code and says which kind it was.
//
// What the console's answer holds, and nothing more (the console rebuilds it field by field): the person's User ID and
// Support ID for the scope (what the Users screen already shows), the scope, which kind of code matched, and per app the
// app's id and name, the User ID and Support ID that app gives the person, and when they first and last signed in there.
// Never a Google `sub`, an email, an internal id (`hu_…`), an identity key or a wallet address.
import { z } from '@hana-id/env/zod';
import { b64url, concatBytes, hmacSha256, utf8 } from './bytes.ts';
import { orgIdInput } from './rpc.ts';
import { ctx } from './types.ts';
import { USER_ID_RE, parseSupportId } from './users.ts';

/** Lookups one member may make, per clock hour and per UTC day (each org's own count is separate). */
export const LINK_MEMBER_PER_HOUR = 60;
export const LINK_MEMBER_PER_DAY = 300;
/** Lookups one org's members may make together per UTC day. */
export const LINK_ORG_PER_DAY = 1000;
/** Past these, one `link_lookup_volume` security event per window (an alert to Journear, never a refusal). */
export const LINK_ALERT_MEMBER_PER_HOUR = 30;
export const LINK_ALERT_ORG_PER_DAY = 200;
/**
 * And past this an org in a week (fixed 7-day windows from the Unix epoch, PR 153's review): slow harvesting under the
 * daily threshold (199 a day is about 1 400 a week) still alerts. Honest support work is a look-up per ticket that needs
 * the cross-app view; 500 a week is about 70 a working day, well above that for any network we expect on testnet. To
 * confirm (the Tech Lead).
 */
export const LINK_ALERT_ORG_PER_WEEK = 500;
/** Apps listed for one person in one answer, most recently used first (`truncated` says when there are more). */
export const LINK_APPS_MAX = 100;

/** What opened the lookup: the person's panel ("This person on your apps") or the per-app search. */
export const LINK_PURPOSES = ['panel', 'search'] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

/**
 * What a lookup starts from: a User ID (`u1_…`, exact case) or a Support ID (any case, `HANA-` and dashes optional,
 * Crockford's look-alikes read as console-core `parseSupportId` reads them). Whole values only: nothing matches a prefix
 * or a part of one. Null for anything else.
 */
export type LinkQuery = { kind: 'userId'; userId: string } | { kind: 'supportId'; code: string };

export function parseLinkQuery(input: string): LinkQuery | null {
  if (typeof input !== 'string') return null;
  const q = input.trim();
  if (!q || q.length > 64) return null;
  if (USER_ID_RE.test(q)) return { kind: 'userId', userId: q };
  const code = parseSupportId(q);
  return code ? { kind: 'supportId', code } : null;
}

/** `ConsoleRpc.linkUser`: the query (a User ID or a Support ID, as the owner typed it) and what opened it. */
export const consoleLinkUserInput = ctx.extend({ orgId: orgIdInput, query: z.string().min(1).max(64), purpose: z.enum(LINK_PURPOSES) }).strict();
export type ConsoleLinkUserInput = z.infer<typeof consoleLinkUserInput>;

/** The console's `POST /api/orgs/:org/users/link` body. */
export const linkUserBody = z.object({ query: z.string().min(1).max(64), purpose: z.enum(LINK_PURPOSES) }).strict();

/**
 * Which code matched: a User ID or a Support ID, and whose: the scope's (the person's one ID for every app made before the
 * mark, which the network also sees on its Users screen) or one app's own.
 */
export interface LinkMatch {
  kind: LinkQuery['kind'];
  of: 'scope' | 'app';
  /** The app whose own code it is (`of: 'app'`), else null. */
  appId: string | null;
}

/** One app of the scope the person signed in on, with the IDs that app gives them. */
export interface LinkedApp {
  appId: string;
  appName: string;
  /** The User ID this app's identity tokens carry for the person (`sub`). */
  userId: string;
  /** Its short form, `HANA-XXXX-XXXX` (what the app's page shows the person). */
  supportId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** `ConsoleRpc.linkUser`'s answer (and the console's, rebuilt field by field). */
/**
 * The opaque reference the console's audit row names the person by (PR 153's review): `lr1_` ‖ b64url of 16 bytes of
 * HMAC-SHA256(IDENTITY_SUB_KEY, "hana-id/link-audit-ref/v1" ‖ 0x00 ‖ the scope-level User ID). Staff get it with a
 * Support ID lookup and match it against `users.link_view` rows; it isn't the User ID, and an erasure leaves it (so an
 * erasure can't hide whom an owner looked up).
 */
export const LINK_AUDIT_REF_RE = /^lr1_[A-Za-z0-9_-]{21}[AQgw]$/u;
export const LINK_AUDIT_REF_LABEL = 'hana-id/link-audit-ref/v1';

/** The audit reference of a scope-level User ID under `IDENTITY_SUB_KEY` (above); only the API holds the key. */
export async function linkAuditRef(subKey: Uint8Array, scopeUserId: string): Promise<string> {
  const mac = await hmacSha256(subKey, concatBytes(utf8(LINK_AUDIT_REF_LABEL), Uint8Array.of(0), utf8(scopeUserId)));
  return `lr1_${b64url(mac.slice(0, 16))}`;
}

export interface UserLinkView {
  /** The person's User ID and Support ID for the scope (the Users screen's "User ID (all your apps)"). */
  userId: string;
  supportId: string;
  scopeId: string;
  match: LinkMatch;
  /** Most recently used first, at most LINK_APPS_MAX; live apps of the org on the person's scope only. */
  apps: LinkedApp[];
  truncated: boolean;
}

/**
 * The rule the network agreed to (N7), said where the IDs are shown: one partner never gets another partner's ID for the
 * same person, which would rebuild the join key per-app IDs remove.
 */
export const LINK_SHARING_RULE = 'Each app knows this person by its own ID. Never give one partner another partner’s ID for the same person.';
