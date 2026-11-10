// Reports, ledger and statement helpers (src/reports.ts, batch C12): exact decimals, the CSV cell rule, the RPC inputs'
// limits, the row mappings and the statement view.
import { describe, expect, it } from 'vitest';
import {
  HOME_LOGINS_LABEL,
  HOME_LOGINS_NOTE,
  LEDGER_CURSOR_RE,
  REPORT_MAX_APPS,
  REPORT_MAX_DAYS,
  csvCell,
  csvLine,
  daysInRange,
  formatNear,
  formatTgas,
  formatUnits,
  formatUsd,
  ledgerCursor,
  ledgerInput,
  ledgerRowOf,
  reportRowKind,
  STATEMENT_CSV_COLUMNS,
  statementTotals,
  statementView,
  usageInput,
  usdMicrosOf,
} from '../src/index.ts';

const ctx = { actor: { kind: 'system', id: 'test' }, requestId: 'req_12345678', clientIp: '0.0.0.0' } as const;

describe('exact decimals', () => {
  it('formats integer units exactly, trailing zeros dropped', () => {
    expect(formatUnits(0n, 12)).toBe('0');
    expect(formatTgas('2428158088232')).toBe('2.428158088232');
    expect(formatTgas(30_000_000_000_000n)).toBe('30');
    expect(formatNear('3244726730498400000000')).toBe('0.0032447267304984');
    expect(formatNear(10n ** 24n * 12n + 1n)).toBe('12.000000000000000000000001');
    expect(formatUsd('8112')).toBe('0.008112');
    expect(formatUsd(2_500_000n)).toBe('2.5');
    for (const bad of ['-1', '1.5', '01', '', 'x']) expect(() => formatUnits(bad, 6), bad).toThrow(RangeError);
    expect(() => formatUnits(-1n, 6)).toThrow(RangeError);
  });

  it('rounds USD half up, exactly (no float)', () => {
    expect(usdMicrosOf(5n * 10n ** 23n, 1n)).toBe(1n);
    expect(usdMicrosOf(5n * 10n ** 23n - 1n, 1n)).toBe(0n);
    expect(usdMicrosOf(10n ** 24n, 2_345_678n)).toBe(2_345_678n);
    expect(usdMicrosOf(0n, 2_345_678n)).toBe(0n);
  });
});

describe('the CSV cell rule (statements and the ledger)', () => {
  it('guards formula starts, leaves numbers (negative ones too) and quotes per RFC 4180', () => {
    expect(csvCell('=cmd')).toBe("'=cmd");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('-3')).toBe('-3');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
    expect(csvLine(['a', '', '1'])).toBe('a,,1\n');
  });
});

describe('ConsoleRpc inputs', () => {
  it(`usage: at most ${REPORT_MAX_DAYS} days and ${REPORT_MAX_APPS} apps, from ≤ to, real days`, () => {
    const ok = { ...ctx, orgId: 'org_abc', from: '2026-01-01', to: '2026-01-31', by: 'day' };
    expect(usageInput.safeParse(ok).success).toBe(true);
    expect(daysInRange('2025-01-01', '2026-02-04')).toBe(400);
    expect(usageInput.safeParse({ ...ok, from: '2025-01-01', to: '2026-02-04' }).success).toBe(true);
    expect(usageInput.safeParse({ ...ok, from: '2025-01-01', to: '2026-02-05' }).success).toBe(false);
    expect(usageInput.safeParse({ ...ok, from: '2026-02-01', to: '2026-01-31' }).success).toBe(false);
    expect(usageInput.safeParse({ ...ok, to: '2026-02-30' }).success).toBe(false);
    expect(usageInput.safeParse({ ...ok, by: 'week' }).success).toBe(false);
    expect(usageInput.safeParse({ ...ok, appIds: Array.from({ length: 100 }, (_, i) => `app_${i}`) }).success).toBe(true);
    expect(usageInput.safeParse({ ...ok, appIds: Array.from({ length: 101 }, (_, i) => `app_${i}`) }).success).toBe(false);
    expect(usageInput.safeParse({ ...ok, appIds: [] }).success).toBe(false);
    expect(usageInput.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('ledger: a month, an optional as_of and cursor', () => {
    const ok = { ...ctx, orgId: 'org_abc', month: '2026-01' };
    expect(ledgerInput.safeParse(ok).success).toBe(true);
    expect(ledgerInput.safeParse({ ...ok, asOf: 1_800_000_000_000, after: 'req_12345678,1800000000000' }).success).toBe(true);
    expect(ledgerInput.safeParse({ ...ok, month: '2026-13' }).success).toBe(false);
    expect(ledgerInput.safeParse({ ...ok, after: 'req_1;DROP' }).success).toBe(false);
    expect(LEDGER_CURSOR_RE.test(ledgerCursor({ requestId: 'req_12345678', at: 5 }))).toBe(true);
  });
});

describe('row mappings', () => {
  it('maps a ledger row; gas only when present', () => {
    expect(
      ledgerRowOf({ request_id: 'req_1', at_ms: '1800000000000', org_id: 'org_a', scope_id: 's1', app_id: null, endpoint: 'owner_action', outcome: 'ok', relayed: true, near_tx: 'tx', gas_status: 'final', gas_burnt: '5', tokens_burnt: '6' }),
    ).toEqual({ requestId: 'req_1', at: 1_800_000_000_000, orgId: 'org_a', scopeId: 's1', endpoint: 'owner_action', outcome: 'ok', relayed: true, nearTx: 'tx', gasStatus: 'final', gasBurnt: '5', tokensBurnt: '6' });
  });
});

describe('the statement view (on-screen and PDF)', () => {
  const figures = { logins: 3, derives: 1, revokes: 0, unlocks: 0, ownerActions: 0, linkActions: 0, identityTokens: 0, newUsers: 1, tgas: '7', relayedRejectedTgas: '2.2', errorTgas: '0', near: '0.0007', relayedRejectedNear: '0.00022', usd: '0.00175', relayedRejectedUsd: '0.00055', unsettled: 0 };
  const row = { scopeId: 's1', failures: {}, ...figures };
  const totals = statementTotals.parse({
    v: 1,
    orgId: 'org_a',
    orgName: 'Acme',
    month: '2026-01',
    asOf: Date.UTC(2026, 1, 3),
    network: 'testnet',
    rows: [{ kind: 'app', appId: 'app_1', appName: 'Acme web', environment: 'live', mau: 2, ...row }],
    sum: figures,
    billed: { tgas: '4.8', near: '0.00048', usd: '0.0012' },
    notBilled: { relayedRejectedTgas: '2.2', relayedRejectedNear: '0.00022', relayedRejectedUsd: '0.00055' },
  });

  it('labels the rejected line not billed, the testnet price, and carries the CSV hash', () => {
    const v = statementView({ csvSha256: 'ab'.repeat(32), totals });
    expect(v.header).toContainEqual(['Statement hash (SHA-256 of the CSV)', 'ab'.repeat(32)]);
    expect(v.summary).toContainEqual(['Relayed-then-rejected, not billed (Tgas)', '2.2']);
    expect(v.summary).toContainEqual(['Billed (Tgas)', '4.8']);
    expect(v.notes[0]).toMatch(/mainnet NEAR\/USD price/u);
    expect(v.table).toEqual([{ label: 'Acme web (app_1)', cells: ['3', '1', '0', '2', '1', '7', '0.0007', '0.00175', '0'] }]);
    expect(statementView({ csvSha256: 'ab'.repeat(32), totals: { ...totals, network: 'mainnet' } }).notes).toHaveLength(1);
  });

  it('a statement issued before Hana Home logins were counted still parses and renders as it did', () => {
    // `totals` above is that older shape: no `homeLogins`, no `home` row.
    const v = statementView({ csvSha256: 'ab'.repeat(32), totals });
    expect(v.tableColumns).toEqual(['Logins', 'Derives', 'Owner actions', 'MAU', 'New users', 'Tgas', 'NEAR', 'USD', 'Unsettled']);
    expect(v.summary.map(([k]) => k)).not.toContain(HOME_LOGINS_LABEL);
  });

  it('a scope’s Hana Home logins are a line of their own, with a column, a summary line and a note', () => {
    const home = { kind: 'home', ...row, logins: 0, derives: 0, newUsers: 0, homeLogins: 4, tgas: '154', near: '0.0154', usd: '0.0385', relayedRejectedTgas: '0', relayedRejectedNear: '0', relayedRejectedUsd: '0' };
    const t = statementTotals.parse({ ...totals, rows: [...totals.rows, { kind: 'scope', ...row, logins: 0, derives: 0, ownerActions: 2 }, home], sum: { ...figures, homeLogins: 4 } });
    const v = statementView({ csvSha256: 'ab'.repeat(32), totals: t });
    expect(v.table.map((r) => r.label)).toEqual(['Acme web (app_1)', 'Owner actions, scope s1', 'Hana Home logins, scope s1']);
    expect(v.tableColumns).toEqual(['Logins', 'Derives', 'Owner actions', 'Home logins', 'MAU', 'New users', 'Tgas', 'NEAR', 'USD', 'Unsettled']);
    expect(v.table[2]!.cells).toEqual(['0', '0', '0', '4', '', '0', '154', '0.0154', '0.0385', '0']);
    expect(v.table[0]!.cells[3]).toBe('0');
    expect(v.summary).toContainEqual([HOME_LOGINS_LABEL, '4']);
    expect(v.notes.at(-1)).toBe(HOME_LOGINS_NOTE);
    expect(statementTotals.safeParse({ ...totals, rows: [{ ...home, kind: 'other' }] }).success).toBe(false);
  });

  it('a report row’s kind: named by the report, else an app’s row or a scope’s owner actions', () => {
    expect(reportRowKind({ kind: 'home', app_id: null })).toBe('home');
    expect(reportRowKind({ kind: 'scope', app_id: null })).toBe('scope');
    expect(reportRowKind({ kind: 'app', app_id: 'app_1' })).toBe('app');
    expect(reportRowKind({ app_id: null })).toBe('scope');
    expect(reportRowKind({ app_id: 'app_1' })).toBe('app');
    expect(STATEMENT_CSV_COLUMNS).toContain('home_logins');
    // The two Home columns are the last two: no column a reader already knew has moved.
    expect(STATEMENT_CSV_COLUMNS.slice(-3)).toEqual(['as_of', 'row_kind', 'home_logins']);
    expect(STATEMENT_CSV_COLUMNS.indexOf('day')).toBe(7);
  });
});
