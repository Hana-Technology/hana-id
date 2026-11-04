// AdminRpc (docs/batch-c-spec.md "RPC interfaces"): the API's entrypoint for the admin Worker, bound only by it (batch
// C8) and reachable through no route. The ConsoleRpc org methods for any org (a Hana actor: no step-up, no breaker, no
// hot-DB budget; proposals go through addOrigins / proposeChange), plus the staff-only methods: creating apps, assigning
// legacy scopes, deleting apps, every suspension bit, the security contacts, the blocking notices (pendingNotices →
// ackNotice), expedite, and the feeds. The admin Worker's crons call the feed and notice methods as a `system` actor.
//
// Built in batch C5: everything but `purgeAudit` / `deletedApps` (retention, C13). Batch C14 adds the read-only
// `governance` (the `GET /v1/governance` snapshot) and `pendingUpgrades` (the pending-upgrades page, D86).
import {
  adminFindUsersInput,
  adminGetUserInput,
  adminListUsersInput,
  ackNoticeInput,
  addOriginsInput,
  adminProposeChangeInput,
  adminSetSuspendedInput,
  assignScopeOrgInput,
  cancelChangeInput,
  changesSinceInput,
  createAppInput,
  createKeyInput,
  deleteAppInput,
  expediteChangeInput,
  getAppInput,
  getSecurityContactsInput,
  governanceInput,
  listAppsInput,
  listChangesInput,
  listScopesInput,
  markSecurityEventNotifiedInput,
  pendingNoticesInput,
  pendingUpgradesView,
  relayerKeysInput,
  removeOriginsInput,
  revokeKeyInput,
  rotateKeyInput,
  securityEventsInput,
  setLogoInput,
  setSecurityContactsInput,
  suspendOrgInput,
  turnOffInput,
  updateSettingsInput,
} from '@hana-id/console-core';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env.ts';
import {
  assignScopeOrg,
  changesSince,
  createApp,
  getSecurityContacts,
  listScopes,
  markSecurityEventNotified,
  relayerKeys,
  securityEvents,
  setSecurityContacts,
} from '../changes/admin.ts';
import { getApp, listApps, listChanges } from '../changes/apps.ts';
import { createKey, revokeKey, rotateKey } from '../changes/keys.ts';
import { ackNotice, cancelChange, expediteChange, pendingNotices } from '../changes/lifecycle.ts';
import { addOrigins, removeOrigins } from '../changes/origins.ts';
import { proposeSetting, setLogo, turnOff, updateSettings } from '../changes/settings.ts';
import { deleteApp, setSuspensionBit, suspendOrg } from '../changes/suspension.ts';
import { governanceSnapshot } from '../governance-status.ts';
import { adminFindUsers, adminGetUser, adminListUsers } from '../directory/read.ts';
import { runRpc } from './common.ts';

const HANA = ['hana'] as const;
/** Methods the admin Worker's crons call (notices, the feed, the watcher). */
const HANA_OR_SYSTEM = ['hana', 'system'] as const;
/** The notice ack: only the cron that sent the notice (a staffer can't start a change's clock by hand). */
const SYSTEM = ['system'] as const;

export class AdminRpc extends WorkerEntrypoint<Env> {
  // ---- the ConsoleRpc org methods, for any org ----

  /** Also the watcher's (a `system` actor): a SetAllowShared notice lists the scope's active origins (C8, D282). */
  listApps(c: unknown) {
    return runRpc(this.env, 'admin.listApps', listAppsInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db, w }) => ({ apps: await listApps(db, input.orgId, w.now, this.env.FILES_ORIGIN) }));
  }

  getApp(c: unknown) {
    return runRpc(this.env, 'admin.getApp', getAppInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db, w }) => ({ app: await getApp(db, input.appId, input.orgId, w.now, this.env.FILES_ORIGIN) }));
  }

  listChanges(c: unknown) {
    return runRpc(this.env, 'admin.listChanges', listChangesInput, c, { actors: HANA }, async ({ input, db }) => ({ changes: await listChanges(db, input.orgId, input.beforeSeq, input.limit) }));
  }

  removeOrigins(c: unknown) {
    return runRpc(this.env, 'admin.removeOrigins', removeOriginsInput, c, { actors: HANA }, ({ input, db, w }) => removeOrigins(db, w, input));
  }

  turnOff(c: unknown) {
    return runRpc(this.env, 'admin.turnOff', turnOffInput, c, { actors: HANA }, ({ input, db, w }) => turnOff(db, w, input));
  }

  updateSettings(c: unknown) {
    return runRpc(this.env, 'admin.updateSettings', updateSettingsInput, c, { actors: HANA }, ({ input, db, w }) => updateSettings(db, this.env, w, input));
  }

  setLogo(c: unknown) {
    return runRpc(this.env, 'admin.setLogo', setLogoInput, c, { actors: HANA }, ({ input, db, w }) => setLogo(db, w, input));
  }

  cancelChange(c: unknown) {
    return runRpc(this.env, 'admin.cancelChange', cancelChangeInput, c, { actors: HANA }, ({ input, db, w }) => cancelChange(db, w, input));
  }

  createKey(c: unknown) {
    return runRpc(this.env, 'admin.createKey', createKeyInput, c, { actors: HANA }, ({ input, db, w }) => createKey(db, w, input));
  }

  rotateKey(c: unknown) {
    return runRpc(this.env, 'admin.rotateKey', rotateKeyInput, c, { actors: HANA }, ({ input, db, w }) => rotateKey(db, w, input));
  }

  revokeKey(c: unknown) {
    return runRpc(this.env, 'admin.revokeKey', revokeKeyInput, c, { actors: HANA }, ({ input, db, w }) => revokeKey(db, w, input));
  }

  // ---- staff only ----

  createApp(c: unknown) {
    return runRpc(this.env, 'admin.createApp', createAppInput, c, { actors: HANA }, ({ input, db, w }) => createApp(db, this.env, w, input));
  }

  assignScopeOrg(c: unknown) {
    return runRpc(this.env, 'admin.assignScopeOrg', assignScopeOrgInput, c, { actors: HANA }, ({ input, db, w }) => assignScopeOrg(db, this.env, w, input));
  }

  deleteApp(c: unknown) {
    return runRpc(this.env, 'admin.deleteApp', deleteAppInput, c, { actors: HANA }, ({ input, db, w }) => deleteApp(db, w, input));
  }

  /** Any bit, set or cleared (Hana may clear bit 4 after a malicious mass suspension); works with the console down. */
  setSuspended(c: unknown) {
    return runRpc(this.env, 'admin.setSuspended', adminSetSuspendedInput, c, { actors: HANA }, ({ input, db, w }) => setSuspensionBit(db, w, { orgId: null, ...input }));
  }

  suspendOrg(c: unknown) {
    return runRpc(this.env, 'admin.suspendOrg', suspendOrgInput, c, { actors: HANA }, ({ input, db, w }) => suspendOrg(db, w, input));
  }

  /** Staff proposals: the full delay and the blocking notice; refused for appChangeDelayMs after a scope assignment. */
  addOrigins(c: unknown) {
    return runRpc(this.env, 'admin.addOrigins', addOriginsInput, c, { actors: HANA }, ({ input, db, w }) => addOrigins(db, this.env, w, input));
  }

  proposeChange(c: unknown) {
    return runRpc(this.env, 'admin.proposeChange', adminProposeChangeInput, c, { actors: HANA }, async ({ input, db, w }) => {
      const { change } = await proposeSetting(db, this.env, w, input);
      return { change };
    });
  }

  expediteChange(c: unknown) {
    return runRpc(this.env, 'admin.expediteChange', expediteChangeInput, c, { actors: HANA }, ({ input, db, w }) => expediteChange(db, w, input));
  }

  pendingNotices(c: unknown) {
    return runRpc(this.env, 'admin.pendingNotices', pendingNoticesInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db }) => ({ notices: await pendingNotices(db, input.limit) }));
  }

  /** Called only by the admin Worker's notice cron, after the email provider accepted every send; starts the clock. */
  ackNotice(c: unknown) {
    return runRpc(this.env, 'admin.ackNotice', ackNoticeInput, c, { actors: SYSTEM }, ({ input, db, w }) => ackNotice(db, this.env, w, input));
  }

  setSecurityContacts(c: unknown) {
    return runRpc(this.env, 'admin.setSecurityContacts', setSecurityContactsInput, c, { actors: HANA }, ({ input, db, w }) => setSecurityContacts(db, w, input));
  }

  getSecurityContacts(c: unknown) {
    return runRpc(this.env, 'admin.getSecurityContacts', getSecurityContactsInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db }) => ({ emails: await getSecurityContacts(db, input.orgId) }));
  }

  listScopes(c: unknown) {
    return runRpc(this.env, 'admin.listScopes', listScopesInput, c, { actors: HANA_OR_SYSTEM }, ({ input, db }) => listScopes(db, input.cursor, input.limit));
  }

  changesSince(c: unknown) {
    return runRpc(this.env, 'admin.changesSince', changesSinceInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db }) => ({ changes: await changesSince(db, input.seq, input.limit) }));
  }

  securityEvents(c: unknown) {
    return runRpc(this.env, 'admin.securityEvents', securityEventsInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db }) => ({ events: await securityEvents(db, input.unnotifiedOnly, input.limit) }));
  }

  markSecurityEventNotified(c: unknown) {
    return runRpc(this.env, 'admin.markSecurityEventNotified', markSecurityEventNotifiedInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db, w }) => {
      await markSecurityEventNotified(db, input.ids, w.now);
      return {};
    });
  }

  /** Public keys only: never a secret. */
  relayerKeys(c: unknown) {
    return runRpc(this.env, 'admin.relayerKeys', relayerKeysInput, c, { actors: HANA_OR_SYSTEM }, async () => ({ keys: relayerKeys(this.env) }));
  }

  // ---- governance (batch C14, D83, D86): read-only, the snapshot GET /v1/governance serves ----

  /** The whole snapshot, for the "Security & monitoring" view: staff only. */
  governance(c: unknown) {
    return runRpc(this.env, 'admin.governance', governanceInput, c, { actors: HANA }, async () => ({ governance: await governanceSnapshot(this.env) }));
  }

  /** The pending-upgrades page's view (the same one ConsoleRpc.pendingUpgrades gives partners). */
  pendingUpgrades(c: unknown) {
    return runRpc(this.env, 'admin.pendingUpgrades', governanceInput, c, { actors: HANA }, async () => ({ pendingUpgrades: pendingUpgradesView(await governanceSnapshot(this.env)) }));
  }

  // ---- end users and their wallets (D310, D315, D346; staff only: the internal id, subs and identity keys included,
  // no email) ----

  /** Newest first by last seen, for one org, one scope or all; `nextCursor` while more remain. */
  listUsers(c: unknown) {
    return runRpc(this.env, 'admin.listUsers', adminListUsersInput, c, { actors: HANA }, ({ input, db, w }) => adminListUsers(db, input, w.now));
  }

  /** By `userId` (`u1_…`) or `internalId` (`hu_…`), exactly one. */
  getUser(c: unknown) {
    return runRpc(this.env, 'admin.getUser', adminGetUserInput, c, { actors: HANA }, async ({ input, db, w }) => ({ user: await adminGetUser(db, input, w.now) }));
  }

  /** By wallet address, User ID, internal id, Support ID or sub (`provider` makes it a sub search). */
  findUsers(c: unknown) {
    return runRpc(this.env, 'admin.findUsers', adminFindUsersInput, c, { actors: HANA }, ({ input, db, w }) => adminFindUsers(db, input, w.now));
  }
}
