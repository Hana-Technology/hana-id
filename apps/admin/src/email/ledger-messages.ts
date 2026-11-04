// The batch C12 emails (docs/batch-c-spec.md "Email": direct `nonce_unexplained`, `rejection_rate` to the security
// alias; the feed's "statements issued"; D321's settlement alerts). Builders only: who gets each and when is
// alerts.ts and statement-notices.ts. No key, token or end-user data: ids, hashes, counts and the chain's figures.
import type { NonceCheck, RejectionAlert, SettlementAlert } from '../ledger.ts';
import type { MailContext } from './messages.ts';
import { type Block, type Rendered, isoTime, oneLine, render } from './render.ts';

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
  return render(c.env, `Relayer nonce unexplained (${rows.length})`, blocks, c.consoleOrigin);
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
  return render(c.env, `Rejection rate over ${o.pct}% (${rows.length})`, blocks, c.consoleOrigin);
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
  return render(c.env, `Settlement refused ${rows.length} event${rows.length === 1 ? '' : 's'}`, blocks, c.consoleOrigin);
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
  );
}
