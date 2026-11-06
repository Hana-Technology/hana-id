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
//
// Budget (D280, D380): each listScopes, contacts lookup, listApps and getApp is one RPC of the run's budget, each
// get_scope and email one call. A scope whose reads or emails don't fit what is left stops the run there; the cursor
// stays before it, so the next run reads it first.
import type { ScopeRow } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { mailLabel } from './env.ts';
import { onChainChanged, onChainPending, type ScopeState } from './email/messages.ts';
import type { EmailSender } from './email/sender.ts';
import { errorName, log } from './log.ts';
import { type Budget, meteredEnv, recipients, sendToAll } from './mail.ts';
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

/**
 * The active origins of every app on the scope (the SetAllowShared notice lists them). Null when unreadable; 'budget'
 * when its reads (`listApps`, a `getApp` per app) and the notice's `emails` don't fit what is left of the budget.
 */
async function activeOrigins(env: Env, scope: ScopeRow, now: number, budget: Budget, emails: number): Promise<string[] | null | 'budget'> {
  if (!budget.fits(1 + emails, 1)) return 'budget';
  const apps = await env.API.listApps({ ...systemCtx(), orgId: scope.orgId }).catch(() => null);
  if (!apps?.ok) return null;
  const mine = apps.apps.filter((x) => x.scopeId === scope.scopeId);
  if (!budget.fits(mine.length + emails, mine.length)) return 'budget';
  const out: string[] = [];
  for (const a of mine) {
    const d = await env.API.getApp({ ...systemCtx(), orgId: scope.orgId, appId: a.id }).catch(() => null);
    if (!d?.ok) return null;
    for (const o of d.app.origins) if (o.activeFrom !== null && o.activeFrom <= now) out.push(`${o.origin} (${a.name})`);
  }
  return out;
}

export async function runWatcher(rawEnv: Env, ops: OpsStore, sender: EmailSender, budget: Budget, now = Date.now()): Promise<WatchResult> {
  const env = meteredEnv(rawEnv, budget);
  const result: WatchResult = { scopes: 0, pendingNotified: 0, diffsNotified: 0, failed: 0 };
  const stored = (await ops.getState([WATCH_CURSOR])).get(WATCH_CURSOR)?.value;
  // Each listScopes is one RPC of the run's budget, read only with room for one scope after it (its get_scope and its
  // org's contacts); otherwise the cursor stays and the next run reads from it.
  if (!budget.fits(3, 2)) return result;
  let page = await env.API.listScopes({ ...systemCtx(), ...(stored ? { cursor: stored } : {}), limit: WATCH_SCOPES_PER_RUN });
  if (!page.ok) throw new Error(`listScopes: ${page.code}`);
  if (page.scopes.length === 0 && stored) {
    if (!budget.fits(3, 2)) return result;
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
  const ctx = { env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN, label: mailLabel(env) };
  let lastDone: string | null = stored ?? null;
  let stopped = false;
  for (const scope of page.scopes) {
    // The scope's get_scope and, the first time its org comes up this run, the org's contacts (one RPC); its emails
    // are checked before each send. A scope that doesn't fit is read first next run.
    const lookup = contactsOf.has(scope.orgId) ? 0 : 1;
    if (!budget.fits(1 + lookup, lookup) || !budget.take()) {
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
      const origins = isShared ? await activeOrigins(env, scope, now, budget, to.length) : undefined;
      if (origins === 'budget') {
        stopped = true;
        break;
      }
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
