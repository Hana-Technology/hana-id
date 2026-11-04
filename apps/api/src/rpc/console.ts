// ConsoleRpc (docs/batch-c-spec.md "RPC interfaces"): the API's entrypoint for the console Worker, bound only by it
// (batch C7) and reachable through no route: the public `fetch` serves `/v1/*` only. Every org method takes `orgId`
// and every query filters on it, so org A asking for org B's app is `not_found`. The console's member actor is trusted
// except where the API verifies a token (guarded-change proposals: changes/step-up.ts; owner actions: the owner-action
// precheck); the `orgId` filter is a backstop against console bugs, not against a compromise, which the breaker and the
// hot-DB budget bound instead. The console never acts for `org_legacy` (forbidden).
//
// Built in batches C5 and C6: everything but `usage` / `statements` / `ledger` (Neon, C12). Those methods don't exist
// yet, so a console calling them gets an RPC error rather than a half-built answer.
import {
  type RpcCode,
  cancelChangeByLinkInput,
  changeOriginsInput,
  consoleProposeChangeInput,
  cancelChangeInput,
  consoleGetUserInput,
  consoleListUsersInput,
  consoleSetSuspendedInput,
  createKeyInput,
  getAppInput,
  listAppsInput,
  listChangesInput,
  ownerActionInput,
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
import { refuse } from '../changes/cas.ts';
import { createKey, revokeKey, rotateKey } from '../changes/keys.ts';
import { cancelChange, cancelChangeByLink } from '../changes/lifecycle.ts';
import { changeOrigins, removeOrigins } from '../changes/origins.ts';
import { proposeSettingByMember, setLogo, turnOff, updateSettings } from '../changes/settings.ts';
import { setSuspensionBit } from '../changes/suspension.ts';
import { SAFETY_METHODS, newCtx, runOwnerAction } from '../handlers.ts';
import { finishUsageOnThrow } from '../usage/event.ts';
import { consoleGetUser, consoleListUsers } from '../directory/read.ts';
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
  /** Plan read, a batch of up to six (commit, version, guarded changes, origin rows, and for removes two more), one diagnostic read. */
  changeOrigins: 8,
  proposeChange: 5,
  /** The scope-in-org read and, when a cap refuses, its `owner_cap` event. */
  ownerAction: 2,
  /** One SELECT each (directory/read.ts). */
  listUsers: 1,
  getUser: 1,
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

  // ---- end users and their wallets (D310, D315, D346): the org's own scopes only; `userId` is the identity token's
  // `sub` (`u1_…`); never the internal id (`hu_…`), a sub, an identity key or an email ----

  listUsers(c: unknown) {
    return runRpc(this.env, 'listUsers', consoleListUsersInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.listUsers }, ({ input, db, w }) => consoleListUsers(db, input, w.now));
  }

  getUser(c: unknown) {
    return runRpc(this.env, 'getUser', consoleGetUserInput, c, { actors: MEMBER, cost: CONSOLE_COSTS.getUser }, async ({ input, db, w }) => ({ user: await consoleGetUser(db, input, w.now) }));
  }
}
