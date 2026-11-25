// ConsoleRpc (docs/batch-c-spec.md "RPC interfaces"): the API's entrypoint for the console Worker, bound only by it
// (batch C7) and reachable through no route: the public `fetch` serves `/v1/*` only. Every org method takes `orgId`
// and every query filters on it, so org A asking for org B's app is `not_found`. The console's member actor is trusted
// except where the API verifies a token (guarded-change proposals: changes/step-up.ts; owner actions: the owner-action
// precheck); the `orgId` filter is a backstop against console bugs, not against a compromise, which the breaker and the
// hot-DB budget bound instead. The console never acts for `org_legacy` (forbidden).
//
// Built in batches C5 and C6, plus C14's read-only `pendingUpgrades` and C12's `usage` / `statements` / `ledger`
// (Neon only, over the writer's USAGE_DB binding, no hot-DB statement; usage/reports.ts).
import {
  type RpcCode,
  cancelChangeByLinkInput,
  changeOriginsInput,
  consoleProposeChangeInput,
  cancelChangeInput,
  consoleGetUserInput,
  consoleListUsersInput,
  consoleLinkUserInput,
  consoleSetSuspendedInput,
  createKeyInput,
  getAppInput,
  ledgerInput,
  listAppsInput,
  listChangesInput,
  ownerActionInput,
  pendingUpgradesInput,
  pendingUpgradesView,
  removeOriginsInput,
  revokeKeyInput,
  rotateKeyInput,
  setLogoInput,
  statementsInput,
  turnOffInput,
  updateSettingsInput,
  usageInput,
  listLabelsInput,
  previewLabelsInput,
  proposeLabelsInput,
  removeLabelsInput,
  listPlatformKeysInput,
  platformKeyByLinkInput,
  platformKeyInput,
  proposePlatformKeyInput,
  revokePlatformKeyInput,
  stepUpPlatformKeyInput,
  platformCallsInput,
} from '@hana-id/console-core';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env.ts';
import { getApp, listApps, listChanges } from '../changes/apps.ts';
import { refuse } from '../changes/cas.ts';
import { createKey, revokeKey, rotateKey } from '../changes/keys.ts';
import { cancelChange, cancelChangeByLink } from '../changes/lifecycle.ts';
import { changeOrigins, removeOrigins } from '../changes/origins.ts';
import { proposeSettingByMember, setLogo, turnOff, updateSettings } from '../changes/settings.ts';
import { setSuspensionBit } from '../changes/suspension.ts';
import { governanceSnapshot } from '../governance-status.ts';
import { SAFETY_METHODS, newCtx, runOwnerAction } from '../handlers.ts';
import { finishUsageOnThrow } from '../usage/event.ts';
import { orgLedger, orgStatements, orgUsage } from '../usage/reports.ts';
import { consoleGetUser, consoleListUsers } from '../directory/read.ts';
import { admitLinkLookup, consoleLinkUser } from '../directory/link.ts';
import { identitySubKey } from '../identity/signer.ts';
import { emailSearchMac } from '../identity/email.ts';
import { cancelLabelChange, cancelLabelChangeByLink } from '../labels/lifecycle.ts';
import { listLabels, previewLabels, proposeLabels, removeLabels } from '../labels/propose.ts';
import { isLabelChange } from '../labels/sql.ts';
import { acceptPlatformKey, cancelPlatformKey, cancelPlatformKeyByLink, confirmPlatformKey, getPlatformKey, listPlatformKeys, registerPlatformKey, revokePlatformKey, revokePlatformKeyByLink } from '../platform/keys.ts';
import { platformCalls } from '../platform/activity.ts';
import { runRpc } from './common.ts';
import { confirmOrigins, getConfirmation, removalPreview, removeOriginByLink } from '../changes/confirm.ts';
import { confirmOriginsInput, getConfirmationInput, removeOriginByLinkInput } from '@hana-id/console-core';

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
  /** Plan read, a batch of up to six (commit, version, guarded changes, origin rows, and for removes two more), one diagnostic read. */
  changeOrigins: 8,
  proposeChange: 5,
  /** The scope-in-org read and, when a cap refuses, its `owner_cap` event. */
  ownerAction: 2,
  /** The governance snapshot's one D1 batch of two reads (the JWKS cron's state), when the 10 s snapshot is stale (C14). */
  pendingUpgrades: 2,
  /** One SELECT each (directory/read.ts). */
  listUsers: 1,
  getUser: 1,
  /**
   * D925: one SELECT (directory/link.ts), and at most three `link_lookup_volume` writes, by the look-up that crosses an
   * alert's threshold (member hour, org day, org week; PR 153's review). The limits are RateLimiter objects.
   */
  linkUser: 4,
  /** D894: the entries' read and, for a scope with none, its version. */
  listLabels: 2,
  /** One plan read. */
  previewLabels: 1,
  /** Plan read, a batch of up to five (commit, version, entry, version row, security event), one diagnostic read. */
  proposeLabels: 7,
  /** Plan read, a batch of four, one diagnostic read. */
  removeLabels: 6,
  /** D918: platform keys. One read each. */
  listPlatformKeys: 1,
  getPlatformKey: 1,
  /** Plan read, a batch of two (commit, key), the key read back (or, when the batch fails, one diagnostic read). */
  proposePlatformKey: 4,
  acceptPlatformKey: 4,
  confirmPlatformKey: 4,
  cancelPlatformKey: 4,
  /** Plan read, a batch of two and no read back. */
  cancelPlatformKeyByLink: 4,
  /** Plan read, a batch of six (commit, key, and the four that cancel its waiting web addresses), the key read back. */
  revokePlatformKey: 8,
  revokePlatformKeyByLink: 8,
  /** D930: one read (a page of the org's platform calls, at most PLATFORM_CALLS_SCAN rows looked through). */
  platformCalls: 1,
  /** D931: plan read, a batch of four (commit, confirmations, changes, gate rows), one diagnostic read. */
  confirmOrigins: 6,
  /** D931: one read (the confirmation page). */
  getConfirmation: 1,
  /** D931: the removal link's plan read (the preview), and its batch of four with one diagnostic read. */
  removalPreview: 1,
  removeOriginByLink: 6,
} as const;

/**
 * An owner action refused before the relay, as an RpcCode (docs/batch-c-spec.md "RpcCode → HTTP status"; D237). The
 * precheck's own code goes in `error` (`unknown_change: …`), so the console can still tell the cases apart.
 */
export const OWNER_ACTION_CODES: Readonly<Record<string, RpcCode>> = {
  bad_request: 'bad_request',
  invalid_token: 'forbidden',
  token_expired: 'forbidden',
  unsupported_issuer: 'forbidden',
  bad_token: 'forbidden',
  token_has_pii: 'forbidden',
  not_console_token: 'forbidden',
  not_owner: 'not_owner',
  unknown_scope: 'not_found',
  unknown_change: 'not_found',
  unknown_client: 'not_found',
  owner_nonce_mismatch: 'owner_nonce_mismatch',
  invalid_client_proof: 'invalid_client_proof',
  token_used: 'token_used',
  rate_limited: 'rate_limited',
  change_locked: 'conflict',
  last_client: 'conflict',
  shared_login_disabled: 'conflict',
  shared_login_enabled: 'conflict',
  client_registered: 'conflict',
  shared_client: 'conflict',
  issuer_keys_unavailable: 'near_unavailable',
  near_unavailable: 'near_unavailable',
};

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

  /**
   * The pending-upgrades page (batch C14, D86): pending upgrades, owner transfers, withdrawals, delay decreases and
   * console-audience additions with their countdowns, from the GET /v1/governance snapshot. Contract-wide and public
   * on chain, so nothing in it is filtered by org; the call is charged to the member's org and the console checks the
   * membership first. Its only hot-DB use is the snapshot's one D1 batch, shared and at most once per 10 s.
   */
  pendingUpgrades(c: unknown) {
    return runRpc(this.env, 'pendingUpgrades', pendingUpgradesInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.pendingUpgrades }, async () => ({
      pendingUpgrades: pendingUpgradesView(await governanceSnapshot(this.env)),
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

  /**
   * The org's usage report (docs/batch-c-spec.md "Reports"): ≤ 400 days, ≤ 100 apps (the input schema and the Neon
   * function both refuse more), limited per member. Neon only: no hot-DB statement, so no `cost`.
   */
  usage(c: unknown) {
    return runRpc(this.env, 'usage', usageInput, c, { actors: MEMBER }, async ({ input }) => ({ rows: await orgUsage(this.env, input, Date.now(), this.ctx) }));
  }

  /** The org's frozen monthly statements: metadata, hashes and the stored totals (the on-screen statement, D92). */
  statements(c: unknown) {
    return runRpc(this.env, 'statements', statementsInput, c, { actors: MEMBER }, async ({ input }) => ({ statements: await orgStatements(this.env, input, Date.now(), this.ctx) }));
  }

  /** One page of the ledger CSV's rows for a month (`asOf` pins every page of one CSV to the same bound). */
  ledger(c: unknown) {
    return runRpc(this.env, 'ledger', ledgerInput, c, { actors: MEMBER }, ({ input }) => orgLedger(this.env, input, Date.now(), this.ctx));
  }

  /** A guarded change (`gc_`) or a partner label version (`lc_`, D894). */
  cancelChange(c: unknown) {
    return runRpc(this.env, 'cancelChange', cancelChangeInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.cancelChange }, ({ input, db, w }): Promise<{ change: object }> => (isLabelChange(input.changeId) ? cancelLabelChange(db, w, input) : cancelChange(db, w, input)));
  }

  /**
   * The emailed link's POST confirm (`POST /api/cancel`): no session, the `link` actor; the token is the proof. Its own
   * limits (per client IP, then a global link bucket), taken before the token is read and never from the members'
   * budget, so a link flood can't block anyone's kill switches.
   */
  cancelChangeByLink(c: unknown) {
    return runRpc(this.env, 'cancelChangeByLink', cancelChangeByLinkInput, c, { actors: LINK, cost: CONSOLE_COSTS.cancelChangeByLink, link: true }, ({ input, db, w }): Promise<{ change: object }> =>
      isLabelChange(input.changeId) ? cancelLabelChangeByLink(db, w, input) : cancelChangeByLink(db, w, input),
    );
  }

  // ---- D931: an owner's confirmation of web addresses that wait for a second person, and its notice's removal link ----

  /**
   * An owner's confirmation (the step-up of kind `origin.confirm`, verified here: its nonce over exactly these changes,
   * the on-chain owner read uncached, single use). A member actor only. Not counted by the breaker: it brings web
   * addresses into force, it stops nothing.
   */
  confirmOrigins(c: unknown) {
    return runRpc(this.env, 'confirmOrigins', confirmOriginsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.confirmOrigins }, ({ input, db, w }) => confirmOrigins(db, this.env, w, input));
  }

  /** The page the email's Confirm link opens: reads only (a GET never confirms). */
  getConfirmation(c: unknown) {
    return runRpc(this.env, 'getConfirmation', getConfirmationInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.getConfirmation }, ({ input, db, w }) => getConfirmation(db, input, w.now));
  }

  /** The removal page's details (`POST /api/remove/preview`: the token is in the body, never a URL): reads only. */
  removalPreview(c: unknown) {
    return runRpc(this.env, 'removalPreview', removeOriginByLinkInput, c, { actors: LINK, cost: CONSOLE_COSTS.removalPreview, link: true }, ({ input, db, w }) => removalPreview(db, w, input));
  }

  /** The confirmation notice's one-click removal link (`POST /api/remove`, 7 days, single use): the `link` actor. */
  removeOriginByLink(c: unknown) {
    return runRpc(this.env, 'removeOriginByLink', removeOriginByLinkInput, c, { actors: LINK, cost: CONSOLE_COSTS.removeOriginByLink, link: true }, ({ input, db, w }) => removeOriginByLink(db, w, input));
  }

  // ---- partner labels (D894): an on-chain owner's proposals and removals, bound to the step-up; no UI yet (piece 4) ----

  listLabels(c: unknown) {
    return runRpc(this.env, 'listLabels', listLabelsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.listLabels }, ({ input, db, w }) => listLabels(db, this.env, input, w.now));
  }

  /** Every check a proposal gets, without the step-up and without writing: the preview, or `label_invalid`. */
  previewLabels(c: unknown) {
    return runRpc(this.env, 'previewLabels', previewLabelsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.previewLabels }, ({ input, db, w }) => previewLabels(db, this.env, w, input));
  }

  /** Not counted by the breaker: nothing applies without an on-chain owner's token for exactly this change, and the notice and delay. */
  proposeLabels(c: unknown) {
    return runRpc(this.env, 'proposeLabels', proposeLabelsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.proposeLabels }, ({ input, db, w }) => proposeLabels(db, this.env, w, input));
  }

  /** Immediate, with the same proof as a proposal; it only ever returns the window to the plain view. */
  removeLabels(c: unknown) {
    return runRpc(this.env, 'removeLabels', removeLabelsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.removeLabels, killSwitch: true }, ({ input, db, w }) => removeLabels(db, this.env, w, input));
  }

  /** The partner bit (4) only: a member never sets or clears Hana's bits 1 and 2. Suspending is counted by the breaker. */
  setSuspended(c: unknown) {
    const suspending = (c as { suspended?: unknown } | null)?.suspended === true;
    return runRpc(this.env, 'setSuspended', consoleSetSuspendedInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.setSuspended, killSwitch: suspending, breaker: suspending }, ({ input, db, w }) =>
      // D930: `takenOver` when the member took the platform's suspension over (the console's audit row says so).
      setSuspensionBit(db, w, { orgId: input.orgId, appId: input.appId, bit: 4, suspended: input.suspended }).then(({ suspendedBy, takenOver }) => ({ suspendedBy, ...(takenOver ? { takenOver } : {}) })),
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

  /**
   * A member's origin adds (and any removes sent with them), with the step-up token the console's callback received:
   * the API verifies it itself (changes/step-up.ts). Not counted by the breaker: nothing applies without an on-chain
   * owner's token for exactly this change.
   */
  changeOrigins(c: unknown) {
    return runRpc(this.env, 'changeOrigins', changeOriginsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.changeOrigins }, ({ input, db, w }) => changeOrigins(db, this.env, w, input));
  }

  /** A member's policy set or raw-signing enable, with its step-up token (verified as for changeOrigins). */
  proposeChange(c: unknown) {
    return runRpc(this.env, 'proposeChange', consoleProposeChangeInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.proposeChange }, ({ input, db, w }) => proposeSettingByMember(db, this.env, w, input));
  }

  /**
   * An on-chain owner action, relayed through the owner pool exactly as /v1/owner-actions relays it (the same per-IP
   * limiter, fed `clientIp`; the same precheck, with the claim allow-list on the owner token and the client proof
   * (D274), token reservation, caps and usage event), with three console rules: the scope must be one of the org's
   * (`not_found`), the owner token's optional claims are checked strictly (`forbidden`), and a refusal before the relay
   * is an RpcCode (`token_has_pii` → `forbidden`, the claim's name in the message). Once relayed, the answer is the relay's
   * `{status, result?, nearTx?, code?, error?}`. The safety methods (cancel, remove a client, disable shared login) may
   * use the budget's kill-switch reserve.
   */
  ownerAction(c: unknown) {
    const method = (c as { body?: { method?: unknown } } | null)?.body?.method;
    const safety = typeof method === 'string' && SAFETY_METHODS.includes(method);
    return runRpc(this.env, 'ownerAction', ownerActionInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.ownerAction, ...(safety ? { killSwitch: true } : {}) }, async ({ input, w }) => {
      const ctx = newCtx(this.env, input.requestId, 'ConsoleRpc.ownerAction');
      let out;
      try {
        out = await runOwnerAction(this.env, ctx, { clientIp: input.clientIp, body: () => Promise.resolve({ ok: true, body: input.body }), exec: this.ctx, console: { orgId: input.orgId } });
      } catch (err) {
        finishUsageOnThrow(ctx);
        throw err;
      }
      const status = out.response.status;
      const body = (await out.response.json()) as { result?: unknown; nearTx?: unknown; code?: unknown; error?: unknown; data?: { claim?: unknown } };
      const code = typeof body.code === 'string' ? body.code : undefined;
      const error = typeof body.error === 'string' ? body.error : undefined;
      if (!out.relayed) {
        // A claim name (token_has_pii) tells the member which Google setting to change; it is never a claim's value.
        const claim = typeof body.data?.claim === 'string' ? ` (claim: ${body.data.claim.slice(0, 64)})` : '';
        return refuse(OWNER_ACTION_CODES[code ?? ''] ?? 'internal', `${code ?? 'internal'}: ${error ?? 'refused'}${claim}`);
      }
      // Relayed: something may have changed on chain (the breaker and the reserve keep what it took).
      w.wrote = true;
      return {
        status,
        ...(status < 400 ? { result: body.result ?? null } : {}),
        ...(typeof body.nearTx === 'string' ? { nearTx: body.nearTx } : {}),
        ...(code ? { code } : {}),
        ...(status >= 400 && error ? { error: error.slice(0, 500) } : {}),
      };
    });
  }

  // ---- platform keys (D918): a network's backend's keys. Registering, accepting and confirming are a member's, with the
  // step-up the API verifies itself; no platform key can reach any of these (the actor union has no `platform`, and the
  // writers refuse every other kind) ----

  /** D930: the org's platform calls (any member: the console's route matrix lets every member read them, as the Audit). */
  platformCalls(c: unknown) {
    return runRpc(this.env, 'platformCalls', platformCallsInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.platformCalls }, ({ input, db }) => platformCalls(db, input, false));
  }

  listPlatformKeys(c: unknown) {
    return runRpc(this.env, 'listPlatformKeys', listPlatformKeysInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.listPlatformKeys }, ({ input, db, w }) => listPlatformKeys(db, input.orgId, w.now, false));
  }

  getPlatformKey(c: unknown) {
    return runRpc(this.env, 'getPlatformKey', platformKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.getPlatformKey }, async ({ input, db, w }) => ({ key: await getPlatformKey(db, input.orgId, input.keyId, w.now, false, input.actor) }));
  }

  /** An on-chain owner of each scope, with the `platform.key_add` step-up. Not counted by the breaker: nothing works without the wait or a confirmation. */
  proposePlatformKey(c: unknown) {
    return runRpc(this.env, 'proposePlatformKey', proposePlatformKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.proposePlatformKey }, ({ input, db, w }) =>
      registerPlatformKey(db, this.env, w, { orgId: input.orgId, scopeIds: input.scopeIds, label: input.label, publicKey: input.publicKey, by: { kind: 'member', stepUpJwt: input.stepUpJwt } }),
    );
  }

  /** An on-chain owner of each scope accepts a staff-registered key (counts as its confirmation, D917). */
  acceptPlatformKey(c: unknown) {
    return runRpc(this.env, 'acceptPlatformKey', stepUpPlatformKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.acceptPlatformKey }, ({ input, db, w }) => acceptPlatformKey(db, this.env, w, input));
  }

  /** An owner's confirmation of a waiting key: in force at once; four eyes on a real-money setup. A member actor only. */
  confirmPlatformKey(c: unknown) {
    return runRpc(this.env, 'confirmPlatformKey', stepUpPlatformKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.confirmPlatformKey }, ({ input, db, w }) => confirmPlatformKey(db, this.env, w, input));
  }

  /** A waiting key cancelled at once, no fresh sign-in (a cancel only stops a key). */
  cancelPlatformKey(c: unknown) {
    return runRpc(this.env, 'cancelPlatformKey', platformKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.cancelPlatformKey, killSwitch: true }, ({ input, db, w }) => cancelPlatformKey(db, w, input));
  }

  /**
   * A kill switch: immediate, no fresh sign-in, whatever the key's state; cancels the key's waiting web addresses.
   * Never refused by the members' budget or the breaker (D918 after PR 149's review: one org's burst must not leave any
   * owner unable to stop a stolen key), but admitted by limits of its own (platform/revoke-guard.ts): per member and per
   * org before any database work, a repeat that changes nothing answered from the key's marker without the database, a
   * global ceiling on no-ops only, and an alert on a burst of stops. Still held to CONSOLE_DB_LIMITS.
   */
  revokePlatformKey(c: unknown) {
    return runRpc(this.env, 'revokePlatformKey', revokePlatformKeyInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.revokePlatformKey, revokeGuard: true }, ({ input, db, w }) => revokePlatformKey(db, w, input));
  }

  /** The announcement's cancel link (`POST /api/platform-keys/cancel`): no session, the `link` actor, the link limits. */
  cancelPlatformKeyByLink(c: unknown) {
    return runRpc(this.env, 'cancelPlatformKeyByLink', platformKeyByLinkInput, c, { actors: LINK, cost: CONSOLE_COSTS.cancelPlatformKeyByLink, link: true }, ({ input, db, w }) => cancelPlatformKeyByLink(db, w, input));
  }

  /** The confirmation notice's revoke link (`POST /api/platform-keys/revoke`, 7 days, single use): the `link` actor. */
  revokePlatformKeyByLink(c: unknown) {
    return runRpc(this.env, 'revokePlatformKeyByLink', platformKeyByLinkInput, c, { actors: LINK, cost: CONSOLE_COSTS.revokePlatformKeyByLink, link: true }, ({ input, db, w }) => revokePlatformKeyByLink(db, w, input));
  }

  // ---- end users and their wallets (D310, D315, D346): the org's own scopes only; `userId` is the identity token's
  // `sub` (`u1_…`); never the internal id (`hu_…`), a sub, an identity key or an email ----

  listUsers(c: unknown) {
    return runRpc(this.env, 'listUsers', consoleListUsersInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.listUsers }, ({ input, db, w }) => consoleListUsers(db, input, w.now, (term) => emailSearchMac(this.env, term)));
  }

  getUser(c: unknown) {
    return runRpc(this.env, 'getUser', consoleGetUserInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.getUser }, async ({ input, db, w }) => ({ user: await consoleGetUser(db, input, w.now) }));
  }

  /**
   * D925 (piece P7): one person of a marked scope across the org's apps, by a whole User ID or Support ID (the scope's
   * or one app's own). For the org's owners: the console checks the role on the request and again in the audit row it
   * writes before it answers; this is reachable through no route, no publishable key, no platform key and no end-user
   * session. Counted for the member and the org before the read (directory/link.ts); one SELECT.
   */
  linkUser(c: unknown) {
    return runRpc(this.env, 'linkUser', consoleLinkUserInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.linkUser }, async ({ input, db, w }) => {
      const subKey = identitySubKey(this.env);
      // Without the key the directory holds nothing to link and no audit reference can be made: refused, nothing read.
      if (typeof subKey === 'string') return refuse('internal', 'The directory is unavailable');
      await admitLinkLookup(this.env, { memberId: input.actor.id, orgId: input.orgId }, w.now);
      const { auditRef, ...link } = await consoleLinkUser(db, input, subKey);
      return { link, auditRef };
    });
  }
}
