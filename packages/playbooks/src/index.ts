// @hana-id/playbooks: the one source of Hana ID's recovery playbooks (D126). Every watchdog alert kind has one
// (`apps/watchdog/test/registry.test.ts`), and so does every incident the watchdog doesn't raise. The admin portal's
// "Security & monitoring" view renders them (docs/batch-c-spec.md); docs/playbooks.md is generated from them
// (`pnpm --filter @hana-id/playbooks gen-docs`). Plain data, no dependencies: safe to bundle into any Worker.
import { ALERT_PLAYBOOKS } from './alerts.ts';
import { INCIDENT_PLAYBOOKS } from './incidents.ts';
import type { Playbook } from './types.ts';

export type { Actor, Playbook, Severity, Step } from './types.ts';
export { ACTORS } from './types.ts';

/** Bumped whenever the playbooks are re-checked against the code and the runbooks. */
export const LAST_VERIFIED = '2026-11-05 (branch `feat/coop-canary`: the `google-enforces-coop` incident, D385); 2026-11-05 (branch `chore/ci-cost`: the outside identity-JWKS probe runs every 3 hours, D383); 2026-11-05 (branch `chore/identity-probe-hourly`: the outside identity-JWKS probe runs hourly, D382); 2026-11-03 (branch `feat/email-login-8b`: `near-rpc-outage` impact, member paths confirmed on both RPCs, D263; before it branch `docs/consistency-pass`)';

/** Shown above every playbook: how its commands are meant to be run. */
export const NOTES: readonly string[] = [
  'Testnet only. Placeholders in angle brackets (`<env>`, `<signer>`, `<apiUrl>`, `<member>`, …) come from `envs/<env>.json`; never type a mainnet account.',
  'Every `scripts` command prints its plan and sends nothing without `--yes`: run it once without `--yes` and read the plan before sending.',
  "Owner calls (`admin <env> owner:call …`) go through the manifest's owner: a 2-of-3 council proposal when `ownerKind` is `sputnik` (dev envs: add `--approve-with <second member>` to approve it in the same command; elsewhere each member signs the printed `act_proposal` command with their Ledger), or the owner account's keychain key.",
  'Never print, paste or log a key, token or secret file while following a playbook (CLAUDE.md); values go through pipes and files under `.secrets/` only.',
  "Acknowledging a watchdog alert stops only its 15-minute re-sends, never the first alert or a check.",
];

export const PLAYBOOKS: readonly Playbook[] = [...ALERT_PLAYBOOKS, ...INCIDENT_PLAYBOOKS];

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}

/** The playbook that answers a watchdog alert kind (`ALERT_KINDS` key), or undefined. */
export function playbookForAlertKind(kind: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.alertKinds?.includes(kind));
}
