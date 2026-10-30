// The shape of a recovery playbook (D126). Plain data, no dependencies: the admin portal renders it, the watchdog
// links its alerts to it, and `scripts/gen-docs.ts` writes docs/playbooks.md from it.

export type Severity = 'critical' | 'warning' | 'info';

/**
 * Who must act on a step. The council is the contract owner (a 2-of-3 Sputnik DAO, D81; on an env still owned by a
 * plain account, that account's key). "a founder" is anyone of Hana's operators with the env's `.secrets/` and
 * Cloudflare logins; "scope owners" are a partner's registered owners (Hana can't act for them); "the user" is the
 * wallet's owner.
 */
export type Actor = 'council (2 of 3)' | 'a founder' | 'anyone' | 'the watchdog' | 'the API cron' | 'scope owners' | 'the user';
export const ACTORS: readonly Actor[] = ['council (2 of 3)', 'a founder', 'anyone', 'the watchdog', 'the API cron', 'scope owners', 'the user'];

export interface Step {
  title: string;
  who: Actor;
  /** What to do and why, in order. Says "not built yet: …" where the tool doesn't exist. */
  detail: string;
  /** Real commands from the repo's docs and scripts, with `<env>`-style placeholders. */
  commands?: string[];
}

export interface Playbook {
  /** Stable kebab-case id: the portal's link target, the anchor in docs/playbooks.md, the line in alert texts. */
  id: string;
  title: string;
  /** `alert`: covers watchdog alert kinds (`alertKinds`). `incident`: a scenario the watchdog doesn't raise. */
  kind: 'alert' | 'incident';
  /** The watchdog `ALERT_KINDS` keys this playbook answers (alert playbooks only; each kind in exactly one). */
  alertKinds?: string[];
  severity: Severity;
  /** `planned`: for a feature that isn't built yet (its spec says how it will work). */
  status: 'live' | 'planned';
  /** One sentence for lists and search. */
  summary: string;
  /** How you'd notice. */
  signals: string[];
  /** What is at risk, and what stops while it lasts. */
  impact: string[];
  /** In order. */
  steps: Step[];
  /** How to confirm the recovery worked. */
  verify: string[];
  followUps: string[];
  /** Doc anchors (`docs/operations.md#keys-updater-key`) and decision ids (`D126`). */
  refs: string[];
  /** Other playbook ids worth opening from this one. */
  related?: string[];
}
