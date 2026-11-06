// The batch C12 emails (docs/batch-c-spec.md "Email": direct `nonce_unexplained`, `rejection_rate` to the security
// alias; the feed's "statements issued"; D321's settlement alerts) and C13's direct `retention_failed`. Builders only:
// who gets each and when is alerts.ts, statement-notices.ts and retention.ts. No key, token or end-user data: ids,
// hashes, counts and the chain's figures.
import type { NonceCheck, RejectionAlert, SettlementAlert } from '../ledger.ts';
import type { RetentionRun } from '../retention-store.ts';
import type { MailContext } from './messages.ts';
import { type Block, type Rendered, duration, isoTime, oneLine, render } from './render.ts';

/** `nonce_unexplained`: relayer keys whose last landed nonce has no ledger row. */
export function nonceUnexplained(c: MailContext, rows: NonceCheck[]): Rendered {
  const blocks: Block[] = [
    { kind: 'warn', text: `The daily nonce cross-check found ${rows.length} relayer key${rows.length === 1 ? '' : 's'} whose latest landed transaction has no row in the usage ledger.` },
    { kind: 'p', text: 'Either a usage write was lost (the API logs usage_write_failed), or something other than the API signed with a relayer key: treat it as a possible key leak until explained.' },
  ];
  for (const r of rows) {
    blocks.push({ kind: 'kv', rows: [['Relayer key', r.relayerPk], ['Nonce on chain', r.chainNonce.toString()], ['Checked at', isoTime(r.checkedAt)], ['Ledger relayed rows since the last check', String(r.ledgerRelayedSinceLast)]] });
  }
  blocks.push({ kind: 'p', text: 'The admin console’s security screen lists every check.' });
  return render(c.env, `Relayer nonce unexplained (${rows.length})`, blocks, c.consoleOrigin, c.label);
}

/** `rejection_rate` (D91): orgs whose relayed-then-rejected share passed the threshold for a day. */
export function rejectionRate(c: MailContext, rows: RejectionAlert[], o: { minRelayed: number; pct: number }): Rendered {
  const blocks: Block[] = [
    { kind: 'p', text: `These organisations had at least ${o.minRelayed} relayed attempts in a UTC day and more than ${o.pct}% of them were rejected after the relay (gas paid, not billed by default, D91).` },
  ];
  for (const r of rows) {
    blocks.push({ kind: 'kv', rows: [['Organisation', r.orgId], ['Day', r.day], ['Relayed', String(r.relayed)], ['Rejected after relay', `${r.rejected} (${((r.rejected * 100) / Math.max(1, r.relayed)).toFixed(1)}%)`]] });
  }
  blocks.push({ kind: 'p', text: 'A partner bug can cause this, and so can third parties replaying public signed requests. The service contract may bill partner-caused rejections above the threshold.' });
  return render(c.env, `Rejection rate over ${o.pct}% (${rows.length})`, blocks, c.consoleOrigin, c.label);
}

const REASON: Record<SettlementAlert['reason'], string> = {
  duplicate_tx: 'another relayed event in the ledger carries the same transaction',
  signer_mismatch: 'the transaction at FINAL is not signed by the event’s relayer key at its nonce (or the key is not in the env’s pools)',
};

/** Settlement refused to bill relayed events (C4 review L7, D222; D321). */
export function settlementMismatch(c: MailContext, rows: SettlementAlert[]): Rendered {
  const blocks: Block[] = [
    { kind: 'warn', text: `Settlement refused to bill ${rows.length} relayed event${rows.length === 1 ? '' : 's'}: each is recorded unsettled (not billed). A writer credential of the usage ledger may be in the wrong hands.` },
  ];
  for (const r of rows) {
    blocks.push({ kind: 'kv', rows: [['Request', r.requestId], ['Event time', isoTime(r.at)], ['Organisation', r.orgId], ['Transaction', r.nearTx], ['Why', REASON[r.reason]], ['Detail', oneLine(JSON.stringify(r.detail), 400)]] });
  }
  blocks.push({ kind: 'p', text: 'Check the transaction on chain at FINAL and the API’s logs for the request id; rotate the usage writer’s password if the event was not written by the API.' });
  return render(c.env, `Settlement refused ${rows.length} event${rows.length === 1 ? '' : 's'}`, blocks, c.consoleOrigin, c.label);
}

/** A statement was issued: to the org's security contacts, its billing email and the alias, with the statement hash. */
export function statementIssued(c: MailContext, s: { orgId: string; orgName: string; month: string; asOf: number; csvSha256: string; pdfSha256: string | null }): Rendered {
  const rows: [string, string][] = [
    ['Organisation', `${oneLine(s.orgName, 80)} (${s.orgId})`],
    ['Month', s.month],
    ['Covers events received up to', isoTime(s.asOf)],
    ['Statement hash (SHA-256 of the CSV)', s.csvSha256],
  ];
  if (s.pdfSha256) rows.push(['SHA-256 of the PDF', s.pdfSha256]);
  return render(
    c.env,
    `Usage statement ${s.month} for ${oneLine(s.orgName, 60)}`,
    [
      { kind: 'p', text: `Hana ID issued the usage statement for ${s.month}. It is frozen: the CSV, the PDF and the on-screen statement show the same totals and this hash.` },
      { kind: 'kv', rows },
      { kind: 'p', text: 'Owners and viewers can download it from the partner console. Tax invoices come from Hana’s accounting software and quote this hash.' },
    ],
    c.consoleOrigin,
    c.label,
  );
}

export type RetentionProblem =
  | { kind: 'failed'; runs: RetentionRun[]; retryAfterMs: number }
  | { kind: 'overdue'; month: string; dueAt: number; latest: RetentionRun | null }
  | { kind: 'skipped'; month: string; reason: string };

/**
 * `retention_failed` (D90): the monthly retention job failed, was skipped (no ledger at its due time), or has no
 * complete run a day after it was due. The error is the step and a code, never a message; counts only.
 */
export function retentionFailed(c: MailContext, p: RetentionProblem): Rendered {
  const blocks: Block[] = [];
  let subject: string;
  if (p.kind === 'failed') {
    subject = `Retention job failed (${p.runs.length} run${p.runs.length === 1 ? '' : 's'})`;
    blocks.push({ kind: 'warn', text: `The monthly retention job (D90) failed. Each step runs on its own, so the others did their part; the job runs again ${duration(p.retryAfterMs)} after a failure until a run completes.` });
    for (const r of p.runs) {
      blocks.push({ kind: 'kv', rows: [['Run', String(r.id)], ['Month', r.month], ['Started', isoTime(r.startedAt)], ['Finished', r.finishedAt === null ? '' : isoTime(r.finishedAt)], ['Error', oneLine(r.error ?? '', 500)]] });
    }
  } else if (p.kind === 'overdue') {
    subject = `Retention job overdue for ${p.month}`;
    blocks.push({ kind: 'warn', text: `The monthly retention job for ${p.month} was due at ${isoTime(p.dueAt)} and no run has completed since.` });
    blocks.push({
      kind: 'kv',
      rows: p.latest
        ? [['Latest run', String(p.latest.id)], ['Status', p.latest.status], ['Started', isoTime(p.latest.startedAt)], ['Error', oneLine(p.latest.error ?? 'none', 500)]]
        : [['Latest run', 'none this month']],
    });
    blocks.push({ kind: 'p', text: 'A run that ends partial ran out of its calls and continues every 15 minutes; one that never starts means the admin Worker cannot reach the usage ledger.' });
  } else {
    subject = `Retention job skipped for ${p.month}`;
    blocks.push({ kind: 'warn', text: `The monthly retention job for ${p.month} could not start: ${oneLine(p.reason, 200)}. Nothing was recorded; it runs once the usage ledger is reachable.` });
  }
  blocks.push({ kind: 'p', text: 'The admin console’s retention screen lists every run with its rows per table. docs/operations.md "Retention" has the recovery steps.' });
  return render(c.env, subject, blocks, c.consoleOrigin, c.label);
}

/**
 * `directory_budget` (D275, C8b; a Direct kind to the security alias): a staff member's Users screen reads reached the
 * row budget, so the issuer refused the next one. The staff address is Hana's own (an Access identity), never an end
 * user's; no search term, sub or row is in it.
 */
export function directoryBudget(c: MailContext, o: { staff: string; window: '1h' | '1d'; limit: number; retryAfterMs: number; at: number }): Rendered {
  const per = o.window === '1h' ? 'an hour' : 'a UTC day';
  return render(
    c.env,
    `User directory budget reached by ${oneLine(o.staff, 120)}`,
    [
      { kind: 'warn', text: `A staff member read ${o.limit} identities ${per} from the user directory (the Users screen), the budget per staff email, so the email issuer refused the next read.` },
      { kind: 'kv', rows: [['Staff', oneLine(o.staff, 120)], ['Window', o.window], ['Budget', `${o.limit} identities ${per}`], ['Refused at', isoTime(o.at)], ['Reads again from', isoTime(o.at + o.retryAfterMs)]] },
      { kind: 'p', text: 'If this isn’t expected support work, treat the staff session as compromised: remove the person from the Access policy and admin.staffEmails, and review their rows in the admin console’s audit (issuer directory reads).' },
    ],
    c.consoleOrigin,
    c.label,
  );
}
