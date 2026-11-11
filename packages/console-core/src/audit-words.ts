// Audit rows in words, shared by the console's Audit page (D703) and the admin's feed digests (D704), so a partner
// reads the same title for the same code in both. Nothing is hidden: an unknown code reads as its own words, unknown
// detail keys stay recognisable, and callers keep the code itself beside the words for support.
import type { SECURITY_EVENT_KINDS } from './types.ts';

/**
 * Titles where the code's own words read badly: the app-change kinds as the admin SPA's `LOG_KIND` words them (that SPA
 * has no build step and keeps its own copy), and the console's step-up actions, which are named as commands. Every other
 * code reads as its words: `key.created` → "Key created".
 */
export const ACTION_TITLES: Readonly<Record<string, string>> = {
  'app.resumed': 'Suspension lifted',
  'change.expedited': 'Change put in force early',
  'org.security_contacts': 'Security contacts replaced',
  'scope.assigned': 'Scope moved here',
  'member.invite': 'Member invited',
  'member.role': 'Member role changed',
  'member.remove': 'Member removed',
  'org.policy': 'Organisation policy changed',
  'org.frozen': 'Organisation frozen',
  'org.unfrozen': 'Organisation unfrozen',
};

/** An action or change code in words: a title from `ACTION_TITLES`, else `key.created` → "Key created", `step_up.failed` → "Step up failed". */
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
};

/** A security event's kind in words; an unknown kind reads as its own words. */
export const securityEventLabel = (kind: string): string => (Object.hasOwn(SECURITY_EVENT_TITLES, kind) ? SECURITY_EVENT_TITLES[kind as keyof typeof SECURITY_EVENT_TITLES] : actionLabel(kind));

/** A detail key in words: `activeFrom` → "active from", `scope_id` → "scope id". Unknown keys stay recognisable. */
export const keyLabel = (k: string): string => k.replace(/_/gu, ' ').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase();

/** A time in ms under a key that names one (`…At`, `…From`, `…Until`): shown as a date. */
const isTime = (k: string, v: unknown): v is number => typeof v === 'number' && /(At|From|Until)$/u.test(k) && v > 1e12;

/**
 * One detail value as plain text: times as dates (`time`, the caller's form: the browser's local time on the console,
 * UTC in an email), yes or no, lists joined, an object as its fields; empty (null, undefined) gives null and the field
 * is left out. Nothing else is dropped.
 */
export function detailValue(k: string, v: unknown, time: (ms: number) => string): string | null {
  if (v === null || v === undefined) return null;
  if (isTime(k, v)) return time(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => detailValue(k, x, time)).filter((x): x is string => x !== null);
    return items.length ? items.join('; ') : 'none';
  }
  if (typeof v === 'object') {
    const fields = detailFields(v as Record<string, unknown>, time);
    return fields.length ? fields.join(', ') : 'none';
  }
  return JSON.stringify(v) ?? null;
}

/** An object's fields as "label: value", empty ones left out. */
export const detailFields = (d: Record<string, unknown>, time: (ms: number) => string): string[] =>
  Object.entries(d).flatMap(([k, v]) => {
    const text = detailValue(k, v, time);
    return text === null ? [] : [`${keyLabel(k)}: ${text}`];
  });
