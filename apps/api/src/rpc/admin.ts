// AdminRpc (docs/batch-c-spec.md "RPC interfaces"): the API's entrypoint for the admin Worker, bound only by it (batch
// C8) and reachable through no route. The ConsoleRpc org methods for any org (a Hana actor: no step-up, no breaker, no
// hot-DB budget; proposals go through addOrigins / proposeChange), plus the staff-only methods: creating apps, assigning
// legacy scopes, deleting apps, every suspension bit, the security contacts, the blocking notices (pendingNotices →
// ackNotice), expedite, and the feeds. The admin Worker's crons call the feed and notice methods as a `system` actor.
//
// Built in batch C5; batch C14 adds the read-only `governance` (the `GET /v1/governance` snapshot) and `pendingUpgrades`
// (the pending-upgrades page, D86); batch C13 the retention methods `purgeAudit`, `deletedApps` and `purgeDirectory` (the
// admin Worker's monthly job only: a `system` actor, D360), with `purgeUserEvents` for migration 0013's events (readiness
// 7.17); batch C15 the Support ID lookup's hot-DB part,
// `supportLookup` and `userShares` (staff only; the admin Worker audits before it calls and reads the ledger itself, D394);
// the System status page (D425) `systemStatus` (staff only, read-only, no user data).
import {
  adminAppNamesInput,
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
  deletedAppsInput,
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
  purgeAuditInput,
  purgeDirectoryInput,
  purgeUserEventsInput,
  relayerKeysInput,
  removeOriginsInput,
  revokeKeyInput,
  rotateKeyInput,
  securityEventsInput,
  setLogoInput,
  setSecurityContactsInput,
  EMAIL_STATS_DAYS_DEFAULT,
  linkStatsInput,
  supportLookupInput,
  systemStatusInput,
  suspendOrgInput,
  turnOffInput,
  setMainnetDemoInput,
  updateSettingsInput,
  userSharesInput,
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
  relayerPools,
  securityEvents,
  setSecurityContacts,
} from '../changes/admin.ts';
import { getApp, listApps, listChanges } from '../changes/apps.ts';
import { createKey, revokeKey, rotateKey } from '../changes/keys.ts';
import { ackNotice, cancelChange, expediteChange, pendingNotices } from '../changes/lifecycle.ts';
import { addOrigins, removeOrigins } from '../changes/origins.ts';
import { proposeSetting, setLogo, setMainnetDemo, turnOff, updateSettings } from '../changes/settings.ts';
import { deleteApp, setSuspensionBit, suspendOrg } from '../changes/suspension.ts';
import { governanceSnapshot } from '../governance-status.ts';
import { systemStatus } from '../system-status.ts';
import { adminAppNames, adminFindUsers, adminGetUser, adminListUsers } from '../directory/read.ts';
import { supportLookup, userShares } from '../directory/support.ts';
import { linkStats } from '../link-usage.ts';
import { deletedApps, purgeAudit, purgeDirectory, purgeUserEvents } from '../changes/retention.ts';
import { runRpc } from './common.ts';
import { mainnetDemoEnv } from '../mainnet-demo-setting.ts';

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
    return runRpc(this.env, 'admin.getApp', getAppInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, db, w }) => ({ app: await getApp(db, input.appId, input.orgId, w.now, this.env.FILES_ORIGIN, { mainnetDemo: mainnetDemoEnv(this.env) }) }));
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

  /** The mainnet demo exception to D39 (D428): Hana staff only, a test app in a dev testnet env only. */
  setMainnetDemo(c: unknown) {
    return runRpc(this.env, 'admin.setMainnetDemo', setMainnetDemoInput, c, { actors: HANA }, ({ input, db, w }) => setMainnetDemo(db, this.env, w, input));
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
    return runRpc(this.env, 'admin.relayerKeys', relayerKeysInput, c, { actors: HANA_OR_SYSTEM }, async () => relayerPools(this.env));
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

  /**
   * The admin console's System status page (D425): the build, a timed hot-DB probe, the Google-key sync's last runs,
   * the blocking-notice backlog, the pools' public keys and the governance snapshot, in one call. Staff only, read-only,
   * no user data.
   */
  systemStatus(c: unknown) {
    return runRpc(this.env, 'admin.systemStatus', systemStatusInput, c, { actors: HANA }, ({ db }) => systemStatus(this.env, db));
  }

  // ---- retention (batch C13, D90): the admin Worker's monthly job only ----

  /** app_changes and guarded_changes rows older than min(before, 60 months ago), `limit` of each at most (D364). */
  purgeAudit(c: unknown) {
    return runRpc(this.env, 'admin.purgeAudit', purgeAuditInput, c, { actors: SYSTEM }, ({ input, db }) => purgeAudit(db, input));
  }

  /** Apps deleted at or before min(before, 30 days ago), for the ledger's app_users purge; paged by `next`. */
  deletedApps(c: unknown) {
    return runRpc(this.env, 'admin.deletedApps', deletedAppsInput, c, { actors: SYSTEM }, ({ input, db, w }) => deletedApps(db, input, w.now));
  }

  /** The wallet directory of scopes whose every app was deleted 30 days ago or more (D363). */
  purgeDirectory(c: unknown) {
    return runRpc(this.env, 'admin.purgeDirectory', purgeDirectoryInput, c, { actors: SYSTEM }, ({ input, db, w }) => purgeDirectory(db, input, w.now));
  }

  /** user_events past min(before, 24 months ago), and those of scopes left without apps (purgeDirectory's rule). */
  purgeUserEvents(c: unknown) {
    return runRpc(this.env, 'admin.purgeUserEvents', purgeUserEventsInput, c, { actors: SYSTEM }, ({ input, db, w }) => purgeUserEvents(db, input, w.now));
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

  /** The Users screen's app labels (C8b): names, orgs, scopes and environments of up to 50 app ids, deleted ones too. */
  appNames(c: unknown) {
    return runRpc(this.env, 'admin.appNames', adminAppNamesInput, c, { actors: HANA }, async ({ input, db }) => ({ apps: await adminAppNames(db, input.appIds) }));
  }

  // ---- the links view (build plan batch 9, D445) ----

  /** Link counts per app and day, for the newest `days` (14 by default): counts only, no user data. */
  linkStats(c: unknown) {
    return runRpc(this.env, 'admin.linkStats', linkStatsInput, c, { actors: HANA_OR_SYSTEM }, async ({ input, w }) => ({ rows: await linkStats(this.env.DB, input.days ?? EMAIL_STATS_DAYS_DEFAULT, input.appId, w.now) }));
  }

  // ---- the Support ID lookup (batch C15; D96, D144, D276 as amended by D346, D394): staff only, read only ----

  /**
   * Every user a Support ID (any case, `HANA-` and dashes optional), User ID or internal id names, each with its scope's
   * apps, its vault shares that haven't expired and the apps' changes over `days` (30 by default). No ledger rows: the
   * admin Worker and the CLI read those as usage_admin.
   */
  supportLookup(c: unknown) {
    return runRpc(this.env, 'admin.supportLookup', supportLookupInput, c, { actors: HANA }, ({ input, db, w }) => supportLookup(db, input, w.now));
  }

  /** The vault shares of one path in one app that haven't expired (no share id, key or counter). */
  userShares(c: unknown) {
    return runRpc(this.env, 'admin.userShares', userSharesInput, c, { actors: HANA }, ({ input, db, w }) => userShares(db, input, w.now));
  }
}
