// The on-chain watcher (docs/batch-c-spec.md "On-chain owner actions": admin, every 5 min, one channel; D282). It pages
// the hot DB's scopes (`AdminRpc.listScopes`, round-robin from `watch.scope_cursor` in ops.state), reads each with an
// uncached `get_scope`, and emails the security alias and the org's security contacts:
//
//   - each pending change `(scope_id, change_id)` not yet in `ops.scope_watch` with a `notified_at` (decoded:
//     SetOwners with the added owners marked and an added sign-in owner called out, AddClient's client,
//     SetAllowShared with the scope's active origins), with the cancel instructions;
//   - any difference of owners, clients or allow_shared from `ops.scope_snapshot`, which covers executed proposals and
//     the immediate owner actions, sent through the console or not.
//
// A pending change is recorded when first seen and marked notified only once every send was accepted, so a failed send
// is retried each run until it goes out. A diff's snapshot is replaced only after its email was accepted. A scope seen
// for the first time is stored as the baseline without an email (its state is what it was registered with).
import type { ScopeRow } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { onChainChanged, onChainPending, type ScopeState } from './email/messages.ts';
import type { EmailSender } from './email/sender.ts';
import { errorName, log } from './log.ts';
import { type Budget, recipients, sendToAll } from './mail.ts';
import { getScope } from './near.ts';
import type { OpsStore } from './ops.ts';
import { systemCtx } from './rpc.ts';

export const WATCH_CURSOR = 'watch.scope_cursor';
/** Scopes read per run (each one NEAR view from the run's budget); the next run carries on from the cursor. */
export const WATCH_SCOPES_PER_RUN = 15;

export interface WatchResult {
  scopes: number;
  pendingNotified: number;
  diffsNotified: number;
  failed: number;
}

const canon = (l: unknown[]): string => JSON.stringify(l.map((x) => JSON.stringify(x)).sort());
export const sameState = (a: ScopeState, b: ScopeState): boolean => canon(a.owners) === canon(b.owners) && canon(a.clients) === canon(b.clients) && a.allowShared === b.allowShared;

/** The active origins of every app on the scope (the SetAllowShared notice lists them). Null when unreadable. */
async function activeOrigins(env: Env, scope: ScopeRow, now: number): Promise<string[] | null> {
  const apps = await env.API.listApps({ ...systemCtx(), orgId: scope.orgId }).catch(() => null);
  if (!apps?.ok) return null;
  const out: string[] = [];
  for (const a of apps.apps.filter((x) => x.scopeId === scope.scopeId)) {
    const d = await env.API.getApp({ ...systemCtx(), orgId: scope.orgId, appId: a.id }).catch(() => null);
    if (!d?.ok) return null;
    for (const o of d.app.origins) if (o.activeFrom !== null && o.activeFrom <= now) out.push(`${o.origin} (${a.name})`);
  }
  return out;
}

export async function runWatcher(env: Env, ops: OpsStore, sender: EmailSender, budget: Budget, now = Date.now()): Promise<WatchResult> {
  const result: WatchResult = { scopes: 0, pendingNotified: 0, diffsNotified: 0, failed: 0 };
  const stored = (await ops.getState([WATCH_CURSOR])).get(WATCH_CURSOR)?.value;
  let page = await env.API.listScopes({ ...systemCtx(), ...(stored ? { cursor: stored } : {}), limit: WATCH_SCOPES_PER_RUN });
  if (!page.ok) throw new Error(`listScopes: ${page.code}`);
  if (page.scopes.length === 0 && stored) {
    page = await env.API.listScopes({ ...systemCtx(), limit: WATCH_SCOPES_PER_RUN });
    if (!page.ok) throw new Error(`listScopes: ${page.code}`);
  }
  const contactsOf = new Map<string, string[] | null>();
  const contacts = async (orgId: string): Promise<string[] | null> => {
    if (!contactsOf.has(orgId)) {
      const r = await env.API.getSecurityContacts({ ...systemCtx(), orgId }).catch(() => null);
      contactsOf.set(orgId, r?.ok ? r.emails : null);
    }
    return contactsOf.get(orgId)!;
  };
  const ctx = { env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN };
  let lastDone: string | null = stored ?? null;
  let stopped = false;
  for (const scope of page.scopes) {
    if (!budget.take()) {
      stopped = true;
      break;
    }
    let chain;
    try {
      chain = await getScope(env.NEAR_RPC, env.SIGNER_ACCOUNT, scope.scopeId);
    } catch (err) {
      result.failed++;
      log({ event: 'watcher', scopeId: scope.scopeId, outcome: 'error', code: 'near_unavailable', error: errorName(err) }, 'warn');
      lastDone = scope.scopeId;
      continue;
    }
    result.scopes++;
    if (!chain) {
      log({ event: 'watcher', scopeId: scope.scopeId, outcome: 'skipped', code: 'not_on_chain' }, 'warn');
      lastDone = scope.scopeId;
      continue;
    }
    const orgContacts = await contacts(scope.orgId);
    const to = orgContacts === null ? null : recipients(env.SECURITY_ALIAS, orgContacts);
    // Pending proposals, each once.
    const seen = new Map((await ops.watchRows(scope.scopeId)).map((w) => [w.changeId, w]));
    for (const p of chain.pending) {
      const row = seen.get(p.id);
      if (row?.notifiedAt != null) continue;
      if (!row) await ops.markWatch(scope.scopeId, p.id, now, null);
      if (to === null) {
        result.failed++;
        continue;
      }
      const isShared = !!(p.change as { SetAllowShared?: unknown } | null)?.SetAllowShared;
      const origins = isShared ? await activeOrigins(env, scope, now) : undefined;
      if (isShared && origins === null) {
        result.failed++;
        continue;
      }
      const message = onChainPending(ctx, { scopeId: scope.scopeId, orgId: scope.orgId, changeId: p.id, change: p.change, unlockAtMs: p.unlockAtMs, currentOwners: chain.owners, ...(origins ? { activeOrigins: origins } : {}) });
      const sent = await sendToAll(sender, budget, to, message, `watch_pending:${scope.scopeId}:${p.id}`);
      if (sent.outOfBudget) {
        stopped = true;
        break;
      }
      if (sent.allAccepted) {
        await ops.markWatch(scope.scopeId, p.id, now, now);
        result.pendingNotified++;
        log({ event: 'watcher', scopeId: scope.scopeId, target: String(p.id), outcome: 'ok', code: 'scope_pending_change', sent: sent.sent });
      } else {
        result.failed++;
        log({ event: 'watcher', scopeId: scope.scopeId, target: String(p.id), outcome: 'rejected', code: 'send_failed' }, 'warn');
      }
    }
    if (stopped) break;
    // The state diff.
    const current: ScopeState = { owners: chain.owners, clients: chain.clients, allowShared: chain.allowShared };
    const before = await ops.getSnapshot(scope.scopeId);
    if (!before || sameState(before, current)) {
      await ops.putSnapshot(scope.scopeId, current, now);
    } else if (to === null) {
      result.failed++;
    } else {
      const sent = await sendToAll(sender, budget, to, onChainChanged(ctx, scope.scopeId, scope.orgId, before, current), `watch_changed:${scope.scopeId}:${canon(current.owners)}${canon(current.clients)}${current.allowShared}`);
      if (sent.outOfBudget) {
        stopped = true;
        break;
      }
      if (sent.allAccepted) {
        await ops.putSnapshot(scope.scopeId, current, now);
        result.diffsNotified++;
        log({ event: 'watcher', scopeId: scope.scopeId, outcome: 'ok', code: 'scope_changed', sent: sent.sent });
      } else {
        result.failed++;
        log({ event: 'watcher', scopeId: scope.scopeId, outcome: 'rejected', code: 'send_failed' }, 'warn');
      }
    }
    lastDone = scope.scopeId;
  }
  // Round-robin: past the last scope handled; back to the start after the last page.
  const next = stopped ? lastDone : (page.next ?? null);
  await ops.setState(WATCH_CURSOR, next ?? '');
  return result;
}
