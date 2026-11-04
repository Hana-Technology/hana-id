// The org's usage report (`GET /api/orgs/:org/usage?from&to&by&apps`, ConsoleRpc.usage; docs/batch-c-spec.md
// "Reports"): one row per app (owner actions per scope) and day or month, with the counts the statement CSV uses
// (logins, derives, revokes, unlocks, owner actions, link actions and identity tokens, D324; active and new users;
// failures by code), the settled gas with its relayed-then-rejected and error parts, NEAR and USD as exact decimals,
// latencies and the unsettled events. Any member, frozen orgs included (a read; D356). Aggregates only: no end user is
// named (the report has no per-user field). The figures are the server's: the page adds nothing up (D373).
import type { AppSummary, UsageRow } from '@hana-id/console-core';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorNote, useApi, utcDay } from '../lib.tsx';
import { near, usd } from '../units.ts';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

interface Query {
  from: string;
  to: string;
  by: 'day' | 'month';
  apps: string[];
}

export function usagePath(org: string, q: Query): string {
  const p = new URLSearchParams({ from: q.from, to: q.to, by: q.by });
  if (q.apps.length) p.set('apps', q.apps.join(','));
  return `/api/orgs/${org}/usage?${p.toString()}`;
}

const failures = (f: Record<string, number>): string =>
  Object.keys(f)
    .sort()
    .map((k) => `${k}=${f[k]}`)
    .join('; ') || '—';
const ms = (v: number | undefined): string => (v === undefined ? '—' : String(v));

export function Usage() {
  const { org } = useParams();
  const now = Date.now();
  const initial: Query = { from: `${utcDay(now).slice(0, 7)}-01`, to: utcDay(now), by: 'day', apps: [] };
  const [form, setForm] = useState<Query>(initial);
  const [query, setQuery] = useState<Query>(initial);
  const apps = useApi<{ apps: AppSummary[] }>(`/api/orgs/${org}/apps`);
  const valid = DAY_RE.test(form.from) && DAY_RE.test(form.to) && form.from <= form.to;
  const r = useApi<{ rows: UsageRow[] }>(usagePath(org!, query));
  const names = new Map((apps.data?.apps ?? []).map((a) => [a.id, a.name]));
  const rows = r.data?.rows ?? [];
  const late = rows.some((x) => (x.afterStatement ?? 0) > 0);

  return (
    <>
      <h2>Usage</h2>
      <p className="muted">
        By UTC day or month, at most 400 days and 100 apps. Gas is what Hana’s relayer paid, settled at FINAL; unsettled events are never billed, and relayed-then-rejected gas is not billed by default (it is part of
        the Tgas, NEAR and USD columns and shown on its own). USD is at each day’s NEAR/USD rate (testnet usage at the mainnet price); “—” until the day has a rate. The monthly statement is the billing record.
      </p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setQuery({ ...form, apps: [...form.apps] });
        }}
      >
        <label>
          From
          <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </label>
        <label>
          By
          <select value={form.by} onChange={(e) => setForm({ ...form, by: e.target.value === 'month' ? 'month' : 'day' })}>
            <option value="day">day</option>
            <option value="month">month</option>
          </select>
        </label>
        {(apps.data?.apps.length ?? 0) > 0 && (
          <fieldset className="apps-filter">
            <legend>Apps (none ticked: all apps and the owner actions)</legend>
            {apps.data!.apps.map((a) => (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={form.apps.includes(a.id)}
                  onChange={(e) => setForm({ ...form, apps: e.target.checked ? [...form.apps, a.id] : form.apps.filter((x) => x !== a.id) })}
                />
                {a.name}
              </label>
            ))}
          </fieldset>
        )}
        <button type="submit" disabled={!valid}>
          Show
        </button>
      </form>
      {!valid && <p className="note note-warn">Pick a start day on or before the end day.</p>}
      {query.apps.length > 0 && <p className="muted">Filtered by app: owner actions (which belong to a scope, not an app) are left out.</p>}
      {r.error && <ErrorNote error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && rows.length === 0 && <p className="note">No usage in this period.</p>}
      {r.data && rows.length > 0 && (
        <div className="table-wrap">
          <table className="report">
            <thead>
              <tr>
                <th>{query.by === 'month' ? 'Month' : 'Day'}</th>
                <th>App or scope</th>
                <th>Logins</th>
                <th>Derives</th>
                <th>Revokes</th>
                <th>Unlocks</th>
                <th>Owner actions</th>
                <th>Link actions</th>
                <th>Identity tokens</th>
                <th>Active users</th>
                <th>New users</th>
                <th>Failures by code</th>
                <th>Tgas</th>
                <th>Relayed-then-rejected Tgas</th>
                <th>Error Tgas</th>
                <th>NEAR</th>
                <th>Relayed-then-rejected NEAR</th>
                <th>USD</th>
                <th>Relayed-then-rejected USD</th>
                <th>Login p50 / p95 ms</th>
                <th>Derive p50 / p95 ms</th>
                <th>Unsettled</th>
                {late && <th>After the statement</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={`${x.period}:${x.appId ?? `scope:${x.scopeId ?? ''}`}`}>
                  <td className="mono">{x.period}</td>
                  <td>
                    {x.appId ? (
                      <>
                        {names.get(x.appId) ?? x.appId}
                        {names.has(x.appId) && <div className="muted mono small">{x.appId}</div>}
                      </>
                    ) : (
                      `Owner actions, scope ${x.scopeId ?? '—'}`
                    )}
                  </td>
                  <td>{x.logins}</td>
                  <td>{x.derives}</td>
                  <td>{x.revokes}</td>
                  <td>{x.unlocks}</td>
                  <td>{x.ownerActions}</td>
                  <td>{x.linkActions ?? 0}</td>
                  <td>{x.identityTokens ?? 0}</td>
                  <td>{x.activeUsers ?? '—'}</td>
                  <td>{x.newUsers}</td>
                  <td className="mono small">{failures(x.failuresByCode)}</td>
                  <td className="mono">{x.tgas}</td>
                  <td className="mono">{x.relayedRejectedTgas}</td>
                  <td className="mono">{x.errorTgas}</td>
                  <td className="mono">{near(x.burntYocto)}</td>
                  <td className="mono">{near(x.relayedRejectedBurntYocto)}</td>
                  <td className="mono">{usd(x.usdMicros)}</td>
                  <td className="mono">{usd(x.relayedRejectedUsdMicros)}</td>
                  <td>
                    {ms(x.p50.login)} / {ms(x.p95.login)}
                  </td>
                  <td>
                    {ms(x.p50.derive)} / {ms(x.p95.derive)}
                  </td>
                  <td>{x.unsettled ? <strong>{x.unsettled}</strong> : 0}</td>
                  {late && <td>{x.afterStatement ? <strong>{x.afterStatement}</strong> : 0}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {late && <p className="muted">“After the statement”: events of an issued month that reached the ledger after its statement was frozen. They are not in the statement; Hana handles them under the service contract.</p>}
    </>
  );
}
