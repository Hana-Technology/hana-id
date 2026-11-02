// The usage ledger as the API tests see it: the writer's transport (src/usage/record.ts usageTransport) is replaced
// by an in-memory ledger that keeps what the Worker sent, as `usage.record_event` and `usage.record_identity_tokens`
// would receive it. Every test runs with a USAGE_DB binding (vitest.config.ts: a fake Hyperdrive whose connection
// string is never dialled, because nothing reaches pg), so capture runs beside every existing test. No network, no
// Postgres: the functions themselves are tested on PGlite (test-usage/). `realTransport` is pg itself, for the tests
// that point USAGE_DB at a refusing server.
import type { UsageEventV1 } from '@hana-id/console-core';
import { RECORD_IDENTITY_SQL } from '../src/usage/identity-sync.ts';
import { RECORD_EVENT_SQL, type UsageTransport, usageTransport } from '../src/usage/record.ts';

export const realTransport: UsageTransport['query'] = usageTransport.query;

export interface IdentityRow {
  app_id: string;
  day: string;
  org_id: string;
  scope_id: string;
  tokens: number;
}

export const ledger = {
  events: [] as UsageEventV1[],
  identity: [] as IdentityRow[],
  /** Every statement the writer ran, in order (one per attempt). */
  calls: [] as { sql: string; at: number }[],
  /** When set, an attempt throws what it returns, unless undefined (e.g. a pg error with a SQLSTATE, a connection error). */
  fail: null as null | ((sql: string, attempt: number) => unknown),
};

export const fakeTransport: UsageTransport['query'] = async (_binding, sql, params) => {
  ledger.calls.push({ sql, at: Date.now() });
  const failure = ledger.fail?.(sql, ledger.calls.length);
  if (failure !== undefined) throw failure;
  const value = JSON.parse(String(params[0])) as unknown;
  if (sql === RECORD_EVENT_SQL) {
    const e = value as UsageEventV1;
    // As the function: a retry with the same (request_id, at) is ignored.
    if (!ledger.events.some((x) => x.request_id === e.request_id && x.at_ms === e.at_ms)) ledger.events.push(e);
  } else if (sql === RECORD_IDENTITY_SQL) {
    for (const r of value as IdentityRow[]) {
      const i = ledger.identity.findIndex((x) => x.app_id === r.app_id && x.day === r.day);
      if (i < 0) ledger.identity.push(r);
      else ledger.identity[i] = { ...ledger.identity[i]!, tokens: Math.max(ledger.identity[i]!.tokens, r.tokens) };
    }
  } else throw new Error(`unexpected ledger statement ${sql}`);
};

export function resetLedger(): void {
  ledger.events = [];
  ledger.identity = [];
  ledger.calls = [];
  ledger.fail = null;
  usageTransport.query = fakeTransport;
}

/** The events recorded for an app (or, with `scope:`, a scope's owner actions), in the order they were sent. */
export function usageOf(appId: string): UsageEventV1[] {
  return ledger.events.filter((e) => e.app_id === appId);
}

export function ownerActionUsage(scopeId: string): UsageEventV1[] {
  return ledger.events.filter((e) => e.endpoint === 'owner_action' && e.scope_id === scopeId);
}

export const eventFor = (requestId: string): UsageEventV1 | undefined => ledger.events.find((e) => e.request_id === requestId);
