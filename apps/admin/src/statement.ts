// A monthly statement's CSV and totals (docs/batch-c-spec.md "Monthly statements", "CSV"; D92; D324), built from the
// report function's rows for the month with one `as_of`: per UTC day (`by = day`) for the day rows, per month
// (`by = month`) for the totals, so MAU and the percentiles of a total are exact over the month, not sums of days. The
// CSV is byte-stable: RFC 4180, UTF-8, LF, decimal strings, rows in a fixed order (apps by id then day, then owner
// actions by scope then day, then one total per app and one per scope), every cell through the injection guard
// (console-core csvCell). The totals are what `usage.statements.totals` stores and what the PDF and the on-screen
// statement render (console-core statementView), so all three carry the same numbers.
import {
  type ReportSqlRow,
  STATEMENT_CSV_COLUMNS,
  type StatementTotalRow,
  type StatementTotals,
  csvLine,
  failuresOf,
  formatNear,
  formatTgas,
  formatUsd,
  statementTotals,
} from '@hana-id/console-core';

export interface StatementApp {
  name: string;
  environment: string;
  scopeId: string;
}

export interface StatementInputs {
  orgId: string;
  orgName: string;
  /** YYYY-MM */
  month: string;
  asOf: number;
  network: string;
  apps: ReadonlyMap<string, StatementApp>;
  dayRows: readonly ReportSqlRow[];
  monthRows: readonly ReportSqlRow[];
}

const big = (v: string | null | undefined, what: string): bigint => {
  if (v === null || v === undefined || !/^(0|[1-9]\d*)$/u.test(v)) throw new Error(`statement: ${what} is missing`);
  return BigInt(v);
};
const n = (v: number | string | null | undefined): number => Number(v ?? 0);
const opt = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));
const byKey = (a: ReportSqlRow, b: ReportSqlRow): number => {
  const ka = a.app_id ?? '';
  const kb = b.app_id ?? '';
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.scope_id !== b.scope_id) return a.scope_id < b.scope_id ? -1 : 1;
  return a.period < b.period ? -1 : a.period > b.period ? 1 : 0;
};
const failuresCell = (r: ReportSqlRow): string =>
  Object.entries(failuresOf(r.failures))
    .map(([k, v]) => `${k}=${v}`)
    .join(';');

export function buildStatement(i: StatementInputs): { csv: string; totals: StatementTotals; lines: number } {
  const asOf = new Date(i.asOf).toISOString();
  const envOfScope = new Map<string, string>();
  for (const a of i.apps.values()) if (!envOfScope.has(a.scopeId)) envOfScope.set(a.scopeId, a.environment);
  const appOf = (r: ReportSqlRow) => (r.app_id === null ? undefined : i.apps.get(r.app_id));
  const environmentOf = (r: ReportSqlRow) => appOf(r)?.environment ?? envOfScope.get(r.scope_id) ?? '';

  const cells = (r: ReportSqlRow, day: string, total: boolean): string[] => {
    const usd = big(r.usd_micros, `the USD of ${r.app_id ?? r.scope_id} on ${r.period} (a day without a rate)`);
    const rejUsd = big(r.rejected_usd_micros, `the rejected USD of ${r.app_id ?? r.scope_id} on ${r.period}`);
    return [
      i.month,
      i.orgId,
      i.orgName,
      r.scope_id,
      r.app_id ?? '',
      appOf(r)?.name ?? '',
      environmentOf(r),
      day,
      String(n(r.logins)),
      String(n(r.derives)),
      String(n(r.revokes)),
      String(n(r.unlocks)),
      String(n(r.owner_actions)),
      String(n(r.link_actions)),
      String(n(r.identity_tokens)),
      total && r.app_id !== null ? String(n(r.active_users)) : '',
      String(n(r.new_users)),
      failuresCell(r),
      formatTgas(big(r.gas, 'gas')),
      formatTgas(big(r.rejected_gas, 'rejected gas')),
      formatTgas(big(r.error_gas, 'error gas')),
      formatNear(big(r.burnt_yocto, 'tokens burnt')),
      formatNear(big(r.rejected_yocto, 'rejected tokens burnt')),
      total || r.near_usd_rate === null ? '' : formatUsd(BigInt(String(r.near_usd_rate))),
      total ? '' : (r.rate_source ?? ''),
      formatUsd(usd),
      formatUsd(rejUsd),
      opt(r.login_p50),
      opt(r.login_p95),
      opt(r.derive_p50),
      opt(r.derive_p95),
      String(n(r.unsettled)),
      asOf,
    ];
  };

  const days = [...i.dayRows].sort(byKey);
  const months = [...i.monthRows].sort(byKey);
  const ordered = (rows: ReportSqlRow[]) => [...rows.filter((r) => r.app_id !== null), ...rows.filter((r) => r.app_id === null)];
  const lines = [
    csvLine(STATEMENT_CSV_COLUMNS),
    ...ordered(days).map((r) => csvLine(cells(r, r.period, false))),
    ...ordered(months).map((r) => csvLine(cells(r, 'total', true))),
  ];

  const rows: StatementTotalRow[] = ordered(months).map((r) => ({
    kind: r.app_id === null ? 'scope' : 'app',
    scopeId: r.scope_id,
    ...(r.app_id !== null ? { appId: r.app_id, appName: appOf(r)?.name ?? '' } : {}),
    ...(environmentOf(r) ? { environment: environmentOf(r) } : {}),
    logins: n(r.logins),
    derives: n(r.derives),
    revokes: n(r.revokes),
    unlocks: n(r.unlocks),
    ownerActions: n(r.owner_actions),
    linkActions: n(r.link_actions),
    identityTokens: n(r.identity_tokens),
    ...(r.app_id !== null ? { mau: n(r.active_users) } : {}),
    newUsers: n(r.new_users),
    failures: failuresOf(r.failures),
    tgas: formatTgas(big(r.gas, 'gas')),
    relayedRejectedTgas: formatTgas(big(r.rejected_gas, 'rejected gas')),
    errorTgas: formatTgas(big(r.error_gas, 'error gas')),
    near: formatNear(big(r.burnt_yocto, 'tokens burnt')),
    relayedRejectedNear: formatNear(big(r.rejected_yocto, 'rejected tokens')),
    usd: formatUsd(big(r.usd_micros, 'USD')),
    relayedRejectedUsd: formatUsd(big(r.rejected_usd_micros, 'rejected USD')),
    unsettled: n(r.unsettled),
  }));

  const sumBig = (f: (r: ReportSqlRow) => string | null) => months.reduce((s, r) => s + big(f(r), 'a total'), 0n);
  const sumN = (f: (r: ReportSqlRow) => number | string) => months.reduce((s, r) => s + n(f(r)), 0);
  const gas = sumBig((r) => r.gas);
  const rejGas = sumBig((r) => r.rejected_gas);
  const yocto = sumBig((r) => r.burnt_yocto);
  const rejYocto = sumBig((r) => r.rejected_yocto);
  const usd = sumBig((r) => r.usd_micros);
  const rejUsd = sumBig((r) => r.rejected_usd_micros);
  const totals = statementTotals.parse({
    v: 1,
    orgId: i.orgId,
    orgName: i.orgName,
    month: i.month,
    asOf: i.asOf,
    network: i.network,
    rows,
    sum: {
      logins: sumN((r) => r.logins),
      derives: sumN((r) => r.derives),
      revokes: sumN((r) => r.revokes),
      unlocks: sumN((r) => r.unlocks),
      ownerActions: sumN((r) => r.owner_actions),
      linkActions: sumN((r) => r.link_actions),
      identityTokens: sumN((r) => r.identity_tokens),
      newUsers: sumN((r) => r.new_users),
      tgas: formatTgas(gas),
      relayedRejectedTgas: formatTgas(rejGas),
      errorTgas: formatTgas(sumBig((r) => r.error_gas)),
      near: formatNear(yocto),
      relayedRejectedNear: formatNear(rejYocto),
      usd: formatUsd(usd),
      relayedRejectedUsd: formatUsd(rejUsd),
      unsettled: sumN((r) => r.unsettled),
    },
    billed: { tgas: formatTgas(gas - rejGas), near: formatNear(yocto - rejYocto), usd: formatUsd(usd - rejUsd) },
    notBilled: { relayedRejectedTgas: formatTgas(rejGas), relayedRejectedNear: formatNear(rejYocto), relayedRejectedUsd: formatUsd(rejUsd) },
  });
  return { csv: lines.join(''), totals, lines: lines.length - 1 };
}
