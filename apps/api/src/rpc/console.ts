// ConsoleRpc (docs/batch-c-spec.md "RPC interfaces"): the API's entrypoint for the console Worker, bound only by it
// (batch C7) and reachable through no route: the public `fetch` serves `/v1/*` only. Every org method takes `orgId`
// and every query filters on it, so org A asking for org B's app is `not_found`. The console's member actor is trusted
// except where the API verifies a token (guarded-change proposals and owner actions, batch C6); the `orgId` filter is a
// backstop against console bugs, not against a compromise, which the breaker and the hot-DB budget bound instead. The
// console never acts for `org_legacy` (forbidden).
//
// Built in batch C5: everything but `changeOrigins` / `proposeChange` / `ownerAction` (the API-verified step-up and the
// owner-action precheck, C6) and `usage` / `statements` / `ledger` (Neon, C12). Those methods don't exist yet, so an
// older or newer console calling them gets an RPC error rather than a half-built answer.
import {
  cancelChangeByLinkInput,
  cancelChangeInput,
  consoleSetSuspendedInput,
  createKeyInput,
  getAppInput,
  listAppsInput,
  listChangesInput,
  removeOriginsInput,
  revokeKeyInput,
  rotateKeyInput,
  setLogoInput,
  turnOffInput,
  updateSettingsInput,
} from '@hana-id/console-core';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env.ts';
import { getApp, listApps, listChanges } from '../changes/apps.ts';
import { createKey, revokeKey, rotateKey } from '../changes/keys.ts';
import { cancelChange, cancelChangeByLink } from '../changes/lifecycle.ts';
import { removeOrigins } from '../changes/origins.ts';
import { setLogo, turnOff, updateSettings } from '../changes/settings.ts';
import { setSuspensionBit } from '../changes/suspension.ts';
import { runRpc } from './common.ts';

const MEMBER = ['member'] as const;
const LINK = ['link'] as const;

/**
 * Each method's hot-DB cost (statements: its plan read, its batch and the one diagnostic read a failed batch may
 * need), charged to the budget before it runs. The CAS tests check every method stays within it.
 */
export const CONSOLE_COSTS = {
  listApps: 1,
  getApp: 4,
  listChanges: 1,
  removeOrigins: 6,
  turnOff: 5,
  updateSettings: 4,
  setLogo: 4,
  cancelChange: 6,
  cancelChangeByLink: 6,
  setSuspended: 5,
  createKey: 5,
  rotateKey: 6,
  revokeKey: 5,
} as const;

export class ConsoleRpc extends WorkerEntrypoint<Env> {
  listApps(c: unknown) {
    return runRpc(this.env, 'listApps', listAppsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.listApps }, async ({ input, db, w }) => ({
      apps: await listApps(db, input.orgId, w.now, this.env.FILES_ORIGIN),
    }));
  }

  getApp(c: unknown) {
    return runRpc(this.env, 'getApp', getAppInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.getApp }, async ({ input, db, w }) => ({
      app: await getApp(db, input.appId, input.orgId, w.now, this.env.FILES_ORIGIN),
    }));
  }

  listChanges(c: unknown) {
    return runRpc(this.env, 'listChanges', listChangesInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.listChanges }, async ({ input, db }) => ({
      changes: await listChanges(db, input.orgId, input.beforeSeq, input.limit),
    }));
  }

  /** A kill switch: immediate, no step-up; counted by the breaker. */
  removeOrigins(c: unknown) {
    return runRpc(this.env, 'removeOrigins', removeOriginsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.removeOrigins, killSwitch: true, breaker: true }, ({ input, db, w }) => removeOrigins(db, w, input));
  }

  /** A kill switch (policy removed, raw signing off): immediate, not counted by the breaker. */
  turnOff(c: unknown) {
    return runRpc(this.env, 'turnOff', turnOffInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.turnOff, killSwitch: true }, ({ input, db, w }) => turnOff(db, w, input));
  }

  /**
   * The console asks for the generic step-up first (spec "Fresh sign-in"); the API trusts the member actor here. A
   * web-client change is counted by the breaker (it can stop every login of the app, D229).
   */
  updateSettings(c: unknown) {
    const client = (c as { googleWebClientId?: unknown } | null)?.googleWebClientId !== undefined;
    return runRpc(this.env, 'updateSettings', updateSettingsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.updateSettings, breaker: client }, ({ input, db, w }) => updateSettings(db, this.env, w, input));
  }

  setLogo(c: unknown) {
    return runRpc(this.env, 'setLogo', setLogoInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.setLogo }, ({ input, db, w }) => setLogo(db, w, input));
  }

  cancelChange(c: unknown) {
    return runRpc(this.env, 'cancelChange', cancelChangeInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.cancelChange }, ({ input, db, w }) => cancelChange(db, w, input));
  }

  /**
   * The emailed link's POST confirm (`POST /api/cancel`): no session, the `link` actor; the token is the proof. Its own
   * limits (per client IP, then a global link bucket), taken before the token is read and never from the members'
   * budget, so a link flood can't block anyone's kill switches.
   */
  cancelChangeByLink(c: unknown) {
    return runRpc(this.env, 'cancelChangeByLink', cancelChangeByLinkInput, c, { actors: LINK, cost: CONSOLE_COSTS.cancelChangeByLink, link: true }, ({ input, db, w }) => cancelChangeByLink(db, w, input));
  }

  /** The partner bit (4) only: a member never sets or clears Hana's bits 1 and 2. Suspending is counted by the breaker. */
  setSuspended(c: unknown) {
    const suspending = (c as { suspended?: unknown } | null)?.suspended === true;
    return runRpc(this.env, 'setSuspended', consoleSetSuspendedInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.setSuspended, killSwitch: suspending, breaker: suspending }, ({ input, db, w }) =>
      setSuspensionBit(db, w, { orgId: input.orgId, appId: input.appId, bit: 4, suspended: input.suspended }),
    );
  }

  createKey(c: unknown) {
    return runRpc(this.env, 'createKey', createKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.createKey }, ({ input, db, w }) => createKey(db, w, input));
  }

  rotateKey(c: unknown) {
    return runRpc(this.env, 'rotateKey', rotateKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.rotateKey, breaker: true }, ({ input, db, w }) => rotateKey(db, w, input));
  }

  revokeKey(c: unknown) {
    return runRpc(this.env, 'revokeKey', revokeKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.revokeKey, killSwitch: true, breaker: true }, ({ input, db, w }) => revokeKey(db, w, input));
  }
}
