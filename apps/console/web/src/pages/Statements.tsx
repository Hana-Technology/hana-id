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
import { ErrorNote, useApi, utcMonth, when } from '../lib.tsx';

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
      <span className="muted">{label}</span> <code className="mono small">{sha}</code>
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
      <h2>Monthly statements</h2>
      <p className="muted">
        Hana issues each month’s statement from the 3rd of the next month, once every relayed event is settled. A statement is frozen: its CSV, PDF and this page show the same totals, and its hash (the SHA-256 of the
        CSV) identifies it on invoices. {VERIFY}
      </p>
      {list.error && <ErrorNote error={list.error} />}
      {!list.data && !list.error && <p className="muted">Loading…</p>}
      {list.data && sorted.length === 0 && <p className="note">No statements yet.</p>}
      {list.data && sorted.length > 0 && (
        <div className="table-wrap">
          <table>
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
                  <td>{when(s.issuedAt)} by Hana</td>
                  <td className="mono small">{s.csvSha256}</td>
                  <td>
                    <Downloads org={org!} s={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="section">
        <h2>Ledger CSV</h2>
        <p className="muted">
          Every event of a month, one line each, with its settlement and transaction (check any of them on chain at FINAL). For a month with a statement it is read as of the statement’s time, so its final gas sums to the
          statement’s Tgas and NEAR; for any other month, as of now. A line starting <code>#&nbsp;incomplete</code> at the end means the file was cut short: download it again.
        </p>
        <div className="inline-form">
          <label>
            Month
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          {MONTH_RE.test(month) ? (
            <a href={ledgerFile(org!, month, issued?.asOf)} download>
              Download the {month} ledger CSV{issued ? ' (as of its statement)' : ''}
            </a>
          ) : (
            <span className="muted">Pick a month.</span>
          )}
        </div>
      </section>
    </>
  );
}

export function StatementPage() {
  const { org, month } = useParams();
  const ok = MONTH_RE.test(month ?? '');
  const r = useApi<{ statement: StatementMeta & { totals: StatementTotals }; view: StatementView }>(ok ? `/api/orgs/${org}/statements/${month}` : null);
  const back = (
    <p>
      <Link to={`/orgs/${org}/statements`}>← Statements</Link>
    </p>
  );
  if (!ok)
    return (
      <>
        {back}
        <p className="note note-error" role="alert">
          That isn’t a month (YYYY-MM).
        </p>
      </>
    );
  if (r.error)
    return (
      <>
        {back}
        {r.error.status === 404 ? <p className="note">No statement for {month}: Hana hasn’t issued it yet.</p> : <ErrorNote error={r.error} />}
      </>
    );
  if (!r.data)
    return (
      <>
        {back}
        <p className="muted">Loading…</p>
      </>
    );
  const { statement: s, view } = r.data;
  return (
    <>
      {back}
      <h2>{view.title}</h2>
      <dl className="settings">
        {view.header.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd className={k.startsWith('Statement hash') ? 'mono small' : undefined}>{v}</dd>
          </Fragment>
        ))}
        <dt>Issued</dt>
        <dd>{when(s.issuedAt)} by Hana</dd>
      </dl>
      <div className="table-wrap section">
        <table>
          <thead>
            <tr>
              <th>App or scope</th>
              {view.tableColumns.map((c) => (
                <th key={c}>{c}</th>
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
                    <td key={j} className="mono">
                      {c}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <dl className="settings">
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
      <section className="section">
        <h2>Download</h2>
        <Hash label="CSV SHA-256 (the statement hash)" sha={s.csvSha256} />
        {s.pdfSha256 && <Hash label="PDF SHA-256" sha={s.pdfSha256} />}
        <Downloads org={org!} s={s} />
        <p className="muted">The ledger CSV is read as of this statement’s time, so its final gas sums to the Tgas and NEAR above. {VERIFY}</p>
      </section>
    </>
  );
}
