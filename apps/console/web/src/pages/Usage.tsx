// The org's usage report (`GET /api/orgs/:org/usage?from&to&by&apps`, ConsoleRpc.usage; docs/batch-c-spec.md
// "Reports"): one row per app (owner actions per scope) and day or month, with the counts the statement CSV uses
// (logins, derives, revokes, unlocks, owner actions, link actions and identity tokens, D324; active and new users;
// failures by code), the settled gas with its relayed-then-rejected and error parts, NEAR and USD as exact decimals,
// latencies and the unsettled events. Any member, frozen orgs included (a read; D356). Aggregates only: no end user is
// named (the report has no per-user field). The figures are the server's: the page adds nothing up (D373).
import type { AppSummary, UsageRow } from '@hana-id/console-core';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApi, utcDay } from '../lib.tsx';
import { Empty, ErrorNote, Field, Loading, PageHeader } from '../ui.tsx';
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
      <PageHeader title="Usage" description="What your apps did, by UTC day or month: logins, signatures, users, and the NEAR gas Journear paid for them. The monthly statement is the billing record." />
      <details className="explain">
        <summary>How usage is counted</summary>
        <p>
          At most 400 days and 100 apps at a time. Gas is what Journear’s relayer paid, settled at FINAL; unsettled events are never billed, and relayed-then-rejected gas is not billed by default (it is part of the Tgas,
          NEAR and USD columns and shown on its own). USD is at each day’s NEAR/USD rate (testnet usage at the mainnet price); “—” until the day has a rate.
        </p>
      </details>
      <form
        className="form form-inline filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setQuery({ ...form, apps: [...form.apps] });
        }}
      >
        <Field label="From">{(c) => <input {...c} className="jp-input" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
        <Field label="To">{(c) => <input {...c} className="jp-input" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
        <Field label="By">
          {(c) => (
          <select {...c} className="jp-input" value={form.by} onChange={(e) => setForm({ ...form, by: e.target.value === 'month' ? 'month' : 'day' })}>
            <option value="day">day</option>
            <option value="month">month</option>
          </select>
          )}
        </Field>
        {(apps.data?.apps.length ?? 0) > 0 && (
          <fieldset className="choice-group">
            <legend className="jp-label">Apps <span className="opt">none ticked: all apps and the owner actions</span></legend>
            <div className="apps-filter">
            {apps.data!.apps.map((a) => (
              <label key={a.id} className="jp-check">
                <input
                  type="checkbox"
                  checked={form.apps.includes(a.id)}
                  onChange={(e) => setForm({ ...form, apps: e.target.checked ? [...form.apps, a.id] : form.apps.filter((x) => x !== a.id) })}
                />
                {a.name}
              </label>
            ))}
            </div>
          </fieldset>
        )}
        <button type="submit" className="jp-btn jp-btn-primary" disabled={!valid}>
          Show
        </button>
      </form>
      {!valid && <p className="jp-error">Pick a start day on or before the end day.</p>}
      {query.apps.length > 0 && <p className="muted">Filtered by app: owner actions and Passport Home logins (which belong to a scope, not an app) are left out.</p>}
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && rows.length === 0 && (
        <Empty title="No usage in this period.">
          <p>Usage shows here once users log in to your apps. Try a longer period, or untick the app filter.</p>
        </Empty>
      )}
      {r.data && rows.length > 0 && (
        <div className="jp-table-wrap tall">
          <table className="jp-table report">
            <thead>
              <tr className="group-row">
                <th scope="colgroup" colSpan={2} />
                <th scope="colgroup" colSpan={8}>
                  Activity
                </th>
                <th scope="colgroup" colSpan={3}>
                  Users and failures
                </th>
                <th scope="colgroup" colSpan={7}>
                  Gas and cost
                </th>
                <th scope="colgroup" colSpan={2}>
                  Speed
                </th>
                <th scope="colgroup" colSpan={late ? 2 : 1}>
                  Settlement
                </th>
              </tr>
              <tr>
                <th>{query.by === 'month' ? 'Month' : 'Day'}</th>
                <th>App or scope</th>
                <th className="num">Logins</th>
                <th className="num">Derives</th>
                <th className="num">Revokes</th>
                <th className="num">Unlocks</th>
                <th className="num">Owner actions</th>
                <th className="num">Link actions</th>
                <th className="num">Identity tokens</th>
                <th className="num">Home logins</th>
                <th className="num">Active users</th>
                <th className="num">New users</th>
                <th>Failures by code</th>
                <th className="num">Tgas</th>
                <th className="num">Relayed-then-rejected Tgas</th>
                <th className="num">Error Tgas</th>
                <th className="num">NEAR</th>
                <th className="num">Relayed-then-rejected NEAR</th>
                <th className="num">USD</th>
                <th className="num">Relayed-then-rejected USD</th>
                <th className="num">Login p50 / p95 ms</th>
                <th className="num">Derive p50 / p95 ms</th>
                <th className="num">Unsettled</th>
                {late && <th className="num">After the statement</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={`${x.period}:${x.appId ?? `${x.kind === 'home' ? 'home' : 'scope'}:${x.scopeId ?? ''}`}`}>
                  <td className="mono">{x.period}</td>
                  <td>
                    {x.appId ? (
                      <>
                        {names.get(x.appId) ?? x.appId}
                        {names.has(x.appId) && <div className="muted mono small">{x.appId}</div>}
                      </>
                    ) : x.kind === 'home' ? (
                      `Passport Home logins, scope ${x.scopeId ?? '—'}`
                    ) : (
                      `Owner actions, scope ${x.scopeId ?? '—'}`
                    )}
                  </td>
                  <td className="num">{x.logins}</td>
                  <td className="num">{x.derives}</td>
                  <td className="num">{x.revokes}</td>
                  <td className="num">{x.unlocks}</td>
                  <td className="num">{x.ownerActions}</td>
                  <td className="num">{x.linkActions ?? 0}</td>
                  <td className="num">{x.identityTokens ?? 0}</td>
                  <td className="num">{x.homeLogins ?? 0}</td>
                  <td className="num">{x.activeUsers ?? '—'}</td>
                  <td className="num">{x.newUsers}</td>
                  <td className="mono small">{failures(x.failuresByCode)}</td>
                  <td className="mono num">{x.tgas}</td>
                  <td className="mono num">{x.relayedRejectedTgas}</td>
                  <td className="mono num">{x.errorTgas}</td>
                  <td className="mono num">{near(x.burntYocto)}</td>
                  <td className="mono num">{near(x.relayedRejectedBurntYocto)}</td>
                  <td className="mono num">{usd(x.usdMicros)}</td>
                  <td className="mono num">{usd(x.relayedRejectedUsdMicros)}</td>
                  <td className="num">
                    {ms(x.p50.login)} / {ms(x.p95.login)}
                  </td>
                  <td className="num">
                    {ms(x.p50.derive)} / {ms(x.p95.derive)}
                  </td>
                  <td className="num">{x.unsettled ? <strong>{x.unsettled}</strong> : 0}</td>
                  {late && <td className="num">{x.afterStatement ? <strong>{x.afterStatement}</strong> : 0}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {late && <p className="muted">“After the statement”: events of an issued month that reached the ledger after its statement was frozen. They are not in the statement; Journear handles them under the service contract.</p>}
    </>
  );
}
