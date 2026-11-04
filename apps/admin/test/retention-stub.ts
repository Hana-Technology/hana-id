// A RetentionStore that answers empty (no run due unless `done` is false and the month has none), for the Worker tests
// that swap the ledger store (retention.test.ts, reports.test.ts). The real store runs on PGlite in test-ops/.
import type { RetentionRun, RetentionStore } from '../src/retention-store.ts';

export function retentionStub(o: { runs?: RetentionRun[]; done?: boolean } = {}): RetentionStore {
  const runs = o.runs ?? [];
  return {
    closeStale: async () => [],
    latestRun: async () => runs[0] ?? null,
    monthDone: async () => o.done ?? false,
    startRun: async () => null,
    finishRun: async () => {},
    runs: async () => runs,
    unalertedFailures: async () => [],
    markAlerted: async () => {},
    getState: async () => null,
    setState: async () => {},
    stripUids: async () => ({ events: 0, appUsers: 0, more: false }),
    dropExpiredPartitions: async () => ({ partitions: 0, settlements: 0, identityTokens: 0, emailCounts: 0, settlementAlerts: 0, settlementTries: 0 }),
    purgeOps: async () => ({ nonceChecks: 0, rejectionAlerts: 0, scopeWatch: 0, retentionRuns: 0, erasures: 0 }),
    purgeAppUsers: async () => 0,
    due: async () => ({ statements: 0, rates: 0, rateOverrides: 0, oldestStatement: null }),
    erasures: async () => [{ id: 1, at: Date.UTC(2026, 10, 2), ticket: 'SUP-42', operator: 'cli:ops', scopeId: 's7', rows: { ledgerEvents: 3, issuerApps: 1 } }],
  };
}
