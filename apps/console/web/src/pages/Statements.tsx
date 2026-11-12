// The org's monthly statements (docs/batch-c-spec.md "Monthly statements", D92, D326): the list
// (`GET /api/orgs/:org/statements`), the on-screen statement (`/statements/:month`: the server's view of the stored
// totals, the same labels and values the PDF prints, with the statement hash), and the downloads: the frozen CSV and
// PDF (`/statements/:month.csv`, `.pdf`, served only when they match their hash) and the ledger CSV
// (`/ledger/:month.csv`, at the statement's as_of so its final gas sums to the statement's Tgas and NEAR; for another
// month, as of now). Every download is a plain link to the console's own route: the browser builds no file (D372).
// Any member, frozen orgs included (reads; D356). Statements are issued by Hana: shown as Hana, never a staff address.
import type { StatementMeta, StatementTotals, StatementView } from '@hana-id/console-core';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, utcMonth, when } from '../lib.tsx';
import { Callout, CopyButton, Empty, ErrorNote, Field, Loading, PageHeader, Panel } from '../ui.tsx';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;

export const statementFile = (org: string, month: string, ext: 'csv' | 'pdf'): string => `/api/orgs/${org}/statements/${month}.${ext}`;
export const ledgerFile = (org: string, month: string, asOf?: number): string => `/api/orgs/${org}/ledger/${month}.csv${asOf === undefined ? '' : `?asOf=${asOf}`}`;

const VERIFY = (
  <>
    Check a download with <code>shasum -a 256 &lt;file&gt;</code> (or <code>sha256sum</code>): it must print the hash shown beside it.
  </>
);

function Hash({ label, sha }: { label: string; sha: string }) {
  return (
    <div className="hash">
      <span className="muted">{label}</span> <code className="mono small">{sha}</code> <CopyButton value={sha} label={label} />
    </div>
  );
}

function Downloads({ org, s }: { org: string; s: StatementMeta }) {
  return (
    <div className="downloads">
      <a href={statementFile(org, s.month, 'csv')} download>
        CSV
      </a>
      {s.pdfSha256 && (
        <a href={statementFile(org, s.month, 'pdf')} download>
          PDF
        </a>
      )}
      <a href={ledgerFile(org, s.month, s.asOf)} download>
        Ledger CSV
      </a>
    </div>
  );
}

export function Statements() {
  const { org } = useParams();
  const list = useApi<{ statements: StatementMeta[] }>(`/api/orgs/${org}/statements`);
  const [month, setMonth] = useState(() => utcMonth(Date.now()));
  const sorted = [...(list.data?.statements ?? [])].sort((a, b) => (a.month < b.month ? 1 : -1));
  const issued = sorted.find((s) => s.month === month);
  return (
    <>
      <PageHeader
        title="Statements"
        description="Journear issues each month’s statement from the 3rd of the next month, once every relayed event is settled. A statement is frozen: its CSV, PDF and on-screen view show the same totals, and its hash (the SHA-256 of the CSV) identifies it on invoices."
      />
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data && sorted.length === 0 && (
        <Empty title="No statements yet.">
          <p>The first one appears early in the month after your apps’ first usage. Meanwhile, Usage shows the running figures.</p>
        </Empty>
      )}
      {list.data && sorted.length > 0 && (
        <div className="jp-table-wrap">
          <table className="jp-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Covers events received up to</th>
                <th>Issued</th>
                <th>Statement hash (SHA-256 of the CSV)</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.month}>
                  <td>
                    <Link to={`/orgs/${org}/statements/${s.month}`}>{s.month}</Link>
                  </td>
                  <td>{when(s.asOf)}</td>
                  <td>{when(s.issuedAt)} by Journear</td>
                  <td className="mono small hash-cell">{s.csvSha256}</td>
                  <td>
                    <Downloads org={org!} s={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small verify">{VERIFY}</p>
      <Panel title="Ledger CSV">
        <p className="muted">
          Every event of a month, one line each, with its settlement and transaction (check any of them on chain at FINAL). For a month with a statement it is read as of the statement’s time, so its final gas sums to the
          statement’s Tgas and NEAR; for any other month, as of now. A line starting <code>#&nbsp;incomplete</code> at the end means the file was cut short: download it again.
        </p>
        <div className="form form-inline">
          <Field label="Month">{(c) => <input {...c} className="jp-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}</Field>
          {MONTH_RE.test(month) ? (
            <a href={ledgerFile(org!, month, issued?.asOf)} download>
              Download the {month} ledger CSV{issued ? ' (as of its statement)' : ''}
            </a>
          ) : (
            <span className="muted">Pick a month.</span>
          )}
        </div>
      </Panel>
    </>
  );
}

export function StatementPage() {
  const { org, month } = useParams();
  const ok = MONTH_RE.test(month ?? '');
  const r = useApi<{ statement: StatementMeta & { totals: StatementTotals }; view: StatementView }>(ok ? `/api/orgs/${org}/statements/${month}` : null);
  const backTo = { to: `/orgs/${org}/statements`, label: 'Statements' };
  const back = <PageHeader title={`Statement ${ok ? month : ''}`.trim()} back={backTo} />;
  if (!ok)
    return (
      <>
        {back}
        <Callout tone="danger" role="alert">
          That isn’t a month (YYYY-MM). Pick a statement from the list.
        </Callout>
      </>
    );
  if (r.error)
    return (
      <>
        {back}
        {r.error.status === 404 ? (
          <Empty title={`No statement for ${month}: Journear hasn’t issued it yet.`}>
            <p>Statements are issued from the 3rd of the following month. Usage shows the month’s running figures.</p>
          </Empty>
        ) : (
          <ErrorNote error={r.error} onRetry={r.reload} />
        )}
      </>
    );
  if (!r.data)
    return (
      <>
        {back}
        <Loading />
      </>
    );
  const { statement: s, view } = r.data;
  return (
    <>
      <PageHeader title={view.title} back={backTo} />
      <dl className="facts facts-panel">
        {view.header.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd className={k.startsWith('Statement hash') ? 'mono small' : undefined}>{v}</dd>
          </Fragment>
        ))}
        <dt>Issued</dt>
        <dd>{when(s.issuedAt)} by Journear</dd>
      </dl>
      <div className="jp-table-wrap section">
        <table className="jp-table">
          <thead>
            <tr>
              <th>App or scope</th>
              {view.tableColumns.map((c) => (
                <th key={c} className="num">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.table.length === 0 ? (
              <tr>
                <td colSpan={view.tableColumns.length + 1} className="muted">
                  No usage this month.
                </td>
              </tr>
            ) : (
              view.table.map((row, i) => (
                <tr key={`${i}:${row.label}`}>
                  <td>{row.label}</td>
                  {row.cells.map((c, j) => (
                    <td key={j} className="mono num">
                      {c}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <dl className="facts facts-panel">
        {view.summary.map(([k, v]) => (
          <Fragment key={k}>
            <dt className={k.startsWith('Billed') ? 'strong' : undefined}>{k}</dt>
            <dd className={k.startsWith('Billed') ? 'mono strong' : 'mono'}>{v}</dd>
          </Fragment>
        ))}
      </dl>
      {view.notes.map((n) => (
        <p key={n} className="muted">
          {n}
        </p>
      ))}
      <Panel title="Download">
        <Hash label="CSV SHA-256 (the statement hash)" sha={s.csvSha256} />
        {s.pdfSha256 && <Hash label="PDF SHA-256" sha={s.pdfSha256} />}
        <Downloads org={org!} s={s} />
        <p className="muted">The ledger CSV is read as of this statement’s time, so its final gas sums to the Tgas and NEAR above. {VERIFY}</p>
      </Panel>
    </>
  );
}
