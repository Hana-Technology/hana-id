// Audit rows in words, shared by the console's Audit page (D703) and the admin's feed digests (D704), so a partner
// reads the same title for the same code in both. Nothing is hidden: an unknown code reads as its own words, unknown
// detail keys stay recognisable, and callers keep the code itself beside the words for support.
import type { SECURITY_EVENT_KINDS } from './types.ts';

/**
 * Every `app_changes.kind` the API writes (D704): `CommitRow.kind` and the cron's ledger rows in apps/api are typed by
 * it, so a new kind is added here first, and a test then wants its title.
 */
export const APP_CHANGE_KINDS = [
  'app.created',
  'app.deleted',
  'app.renamed',
  'app.logo_set',
  'app.logo_removed',
  'change.announced',
  'change.cancelled',
  'change.expedited',
  'email.off',
  'key.created',
  'key.revoked',
  'key.rotated',
  'migration.baseline',
  'org.security_contacts',
  'origin.activated',
  'origin.proposed',
  'origin.removed',
  'policy.activated',
  'policy.ended',
  'policy.pending_dropped',
  'policy.proposed',
  'policy.removed',
  'raw_sign.activated',
  'raw_sign.off',
  'raw_sign.proposed',
  'scope.assigned',
  'settings.changed',
  'suspension.set',
  'suspension.cleared',
  'suspension.org_set',
  'suspension.org_cleared',
  'mainnet_demo.on',
  'mainnet_demo.off',
] as const;
export type AppChangeKind = (typeof APP_CHANGE_KINDS)[number];

/**
 * A title for every code the audit can hold (D704): the API's app-change kinds (`APP_CHANGE_KINDS`), the console's
 * audit actions (apps/console `AUDIT_DETAIL_KEYS`; a test there wants a title for each) and the kinds the admin SPA's
 * `LOG_KIND` names (that SPA has no build step and keeps a copy; a test holds the copy to these words). A code missing
 * here still reads as its own words (`key.created` → "Key created"), so nothing is hidden.
 */
export const ACTION_TITLES: Readonly<Record<string, string>> = {
  // Apps.
  'app.created': 'App created',
  'app.deleted': 'App deleted',
  'app.renamed': 'App renamed',
  'app.logo_set': 'App logo set',
  'app.logo_removed': 'App logo removed',
  'app.settings_changed': 'Settings changed',
  'app.turned_off': 'App setting turned off',
  'app.suspended': 'App suspended',
  'app.resumed': 'Suspension lifted',
  'settings.changed': 'Settings changed',
  'email.off': 'Email login turned off',
  'suspension.set': 'App suspended',
  'suspension.cleared': 'Suspension lifted',
  'suspension.org_set': 'All apps suspended',
  'suspension.org_cleared': 'Suspension of all apps lifted',
  'mainnet_demo.on': 'Mainnet demo turned on',
  'mainnet_demo.off': 'Mainnet demo turned off',
  // Guarded changes.
  'change.proposed': 'Change proposed',
  'change.announced': 'Change announced by email',
  'change.cancelled': 'Change cancelled',
  'change.expedited': 'Change put in force early',
  'change.link_cancel': 'Change cancelled from an emailed link',
  'origin.proposed': 'Origin proposed',
  'origin.activated': 'Origin in force',
  'origin.removed': 'Origin removed',
  'origins.removed': 'Origins removed',
  'policy.proposed': 'Policy proposed',
  'policy.activated': 'Policy in force',
  'policy.ended': 'Policy ended',
  'policy.pending_dropped': 'Waiting policy dropped',
  'policy.removed': 'Policy removed',
  'raw_sign.proposed': 'Raw signing proposed',
  'raw_sign.activated': 'Raw signing in force',
  'raw_sign.off': 'Raw signing turned off',
  // Keys.
  'key.created': 'Key created',
  'key.revoked': 'Key revoked',
  'key.rotated': 'Key rotated',
  // The organisation and its scopes.
  'org.security_contacts': 'Security contacts replaced',
  'org.policy': 'Organisation policy changed',
  'org.frozen': 'Organisation frozen',
  'org.unfrozen': 'Organisation unfrozen',
  'scope.assigned': 'Scope moved to this organisation',
  'migration.baseline': 'Migration baseline recorded',
  'owner_action.relayed': 'On-chain owner action sent',
  'owner_action.executed': 'On-chain owner action executed',
  // Members and invites.
  'invite.issued': 'Invite sent',
  'invite.revoked': 'Invite revoked',
  'invite.notified': 'Invite notice emailed',
  'invite.expired': 'Invite expired',
  'invite.accepted': 'Invite accepted',
  'owner_grant.created': 'Owner rights requested',
  'owner_grant.notified': 'Owner rights notice emailed',
  'owner_grant.cancelled': 'Owner rights request cancelled',
  'member.added': 'Member added',
  'member.role': 'Member role changed',
  'member.removed': 'Member removed',
  'member.owner_granted': 'Member became an owner',
  'user.disabled': 'User disabled',
  'user.enabled': 'User enabled',
  // Sign-in.
  'session.signed_in': 'Signed in',
  'session.signed_out': 'Signed out',
  'signin.refused': 'Sign-in refused',
  'step_up.failed': 'Fresh sign-in failed',
  // Hana staff.
  'statement.issued': 'Statement issued',
  'ledger.exported': 'Ledger exported',
  'rate.overridden': 'Rate overridden',
  'support.lookup': 'Support ID looked up',
  'users.find': 'Wallet directory searched',
};

/** An action or change code in words: its title from `ACTION_TITLES`, else its own words (`some_new.kind` → "Some new kind"). */
export function actionLabel(code: string): string {
  const title = Object.hasOwn(ACTION_TITLES, code) ? ACTION_TITLES[code] : undefined;
  if (title) return title;
  const words = code.replace(/[._]+/gu, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

/** The security events' kinds in words (D704). */
export const SECURITY_EVENT_TITLES: Readonly<Record<(typeof SECURITY_EVENT_KINDS)[number], string>> = {
  drift: 'App setting in force without a notice',
  breaker: 'Too many destructive changes in an hour',
  owner_cap: 'On-chain owner action limit reached',
  owner_allowance_low: 'Owner action allowance running low',
  home_budget_high: 'Hana Home daily budget running high',
  near_relay_budget_high: 'NEAR relay daily budget running high',
  near_relay_balance_low: 'NEAR relay account running low',
};

/** A security event's kind in words; an unknown kind reads as its own words. */
export const securityEventLabel = (kind: string): string => (Object.hasOwn(SECURITY_EVENT_TITLES, kind) ? SECURITY_EVENT_TITLES[kind as keyof typeof SECURITY_EVENT_TITLES] : actionLabel(kind));

/** A detail key in words: `activeFrom` → "active from", `scope_id` → "scope id". Unknown keys stay recognisable. */
export const keyLabel = (k: string): string => k.replace(/_/gu, ' ').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase();

/**
 * A time in ms under a key that names one (`…At`, `…From`, `…Until`, `…Start` such as the breaker's and owner cap's
 * `windowStart`, and a statement's `asOf`): shown as a date.
 */
const isTime = (k: string, v: unknown): v is number => typeof v === 'number' && (/(At|From|Until|Start)$/u.test(k) || k === 'asOf') && v > 1e12;

/** How deep a detail value is read; deeper parts show as "…" (D704: a hostile or broken value can't recurse without end). */
export const DETAIL_DEPTH = 8;

/** The separators a detail line is built with; a string holding one is quoted, so a value can't pose as another field. */
const SEPARATOR = /( · |, |; |: )/u;

/**
 * One detail value as plain text: times as dates (`time`, the caller's form: the browser's local time on the console,
 * UTC in an email), null as "none" (D704: a field cleared to null is a change worth seeing, such as a Google client
 * removed), yes or no, lists joined, an object as its fields, a string holding a separator quoted; undefined gives null
 * and the field is left out (JSON never holds it). Nothing else is dropped; below `DETAIL_DEPTH` levels, "…".
 */
export function detailValue(k: string, v: unknown, time: (ms: number) => string, depth = 0): string | null {
  if (v === undefined) return null;
  if (depth > DETAIL_DEPTH) return '…';
  if (v === null) return 'none';
  if (isTime(k, v)) return time(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return SEPARATOR.test(v) ? JSON.stringify(v) : v;
  if (Array.isArray(v)) {
    const items = v.map((x) => detailValue(k, x, time, depth + 1)).filter((x): x is string => x !== null);
    return items.length ? items.join('; ') : 'none';
  }
  if (typeof v === 'object') {
    const fields = detailFields(v as Record<string, unknown>, time, depth + 1);
    return fields.length ? fields.join(', ') : 'none';
  }
  return JSON.stringify(v) ?? null;
}

/** An object's fields as "label: value"; only undefined ones left out. */
export const detailFields = (d: Record<string, unknown>, time: (ms: number) => string, depth = 0): string[] =>
  Object.entries(d).flatMap(([k, v]) => {
    const text = detailValue(k, v, time, depth);
    return text === null ? [] : [`${keyLabel(k)}: ${text}`];
  });
