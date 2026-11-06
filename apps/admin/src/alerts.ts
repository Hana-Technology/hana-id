// The ledger's alerts to the security alias (docs/batch-c-spec.md "Email": direct `nonce_unexplained` and
// `rejection_rate`; D321's settlement alerts), sent by the daily run right after its checks and retried by every
// 15-minute run until accepted: each kind is one digest of the rows not yet alerted, and the rows get `alerted_at` only
// after the provider accepted it (at least once). One email each from the run's budget.
//
// Also the statement notices (the feed's "statements issued", spec "Monthly statements"): each new statement is emailed
// to the org's security contacts, its billing email and the alias with the CSV's sha256, and recorded in
// `ops.statement_notices` once every send was accepted.
import type { Env } from './env.ts';
import { mailLabel } from './env.ts';
import { nonceUnexplained, rejectionRate, settlementMismatch, statementIssued } from './email/ledger-messages.ts';
import type { MailContext } from './email/messages.ts';
import type { EmailSender } from './email/sender.ts';
import { type Budget, meteredEnv, recipients, sendToAll } from './mail.ts';
import type { LedgerStore } from './ledger.ts';
import { REJECTION_MIN_RELAYED, REJECTION_PCT } from './rejections.ts';
import { systemCtx } from './rpc.ts';

/** Rows per digest; the rest wait for the next run. */
export const ALERT_BATCH = 20;
export const STATEMENT_NOTICES_PER_RUN = 5;
/** The RPCs one statement notice reads before its emails: the org's security contacts and the org (its billing email). */
export const STATEMENT_NOTICE_RPCS = 2;

export interface AlertsSummary {
  nonce: number;
  rejection: number;
  settlement: number;
  failed: number;
}

const mail = (env: Pick<Env, 'ENV_NAME' | 'CONSOLE_ORIGIN' | 'ENV_LABEL' | 'NEAR_NETWORK'>): MailContext => ({ env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN, label: mailLabel(env) });

export async function runAlerts(env: Pick<Env, 'ENV_NAME' | 'CONSOLE_ORIGIN' | 'SECURITY_ALIAS'>, store: LedgerStore, sender: EmailSender, budget: Budget, now: number): Promise<AlertsSummary> {
  const sum: AlertsSummary = { nonce: 0, rejection: 0, settlement: 0, failed: 0 };
  const to = recipients(env.SECURITY_ALIAS);

  const nonce = await store.nonceChecks({ unalertedUnexplainedOnly: true, limit: ALERT_BATCH });
  if (nonce.length) {
    const r = await sendToAll(sender, budget, to, nonceUnexplained(mail(env), nonce), `nonce_unexplained:${nonce.map((n) => `${n.relayerPk}@${n.checkedAt}`).join(',')}`);
    if (r.allAccepted) {
      await store.markNonceAlerted(nonce, now);
      sum.nonce = nonce.length;
    } else sum.failed++;
  }

  const rejected = await store.rejectionAlerts({ unalertedOnly: true, limit: ALERT_BATCH });
  if (rejected.length) {
    const r = await sendToAll(sender, budget, to, rejectionRate(mail(env), rejected, { minRelayed: REJECTION_MIN_RELAYED, pct: REJECTION_PCT }), `rejection_rate:${rejected.map((a) => `${a.orgId}@${a.day}`).join(',')}`);
    if (r.allAccepted) {
      await store.markRejectionAlerted(rejected, now);
      sum.rejection = rejected.length;
    } else sum.failed++;
  }

  const settlement = await store.settlementAlerts({ unalertedOnly: true, limit: ALERT_BATCH });
  if (settlement.length) {
    const r = await sendToAll(sender, budget, to, settlementMismatch(mail(env), settlement), `settlement_mismatch:${settlement.map((a) => `${a.requestId}@${a.at}`).join(',')}`);
    if (r.allAccepted) {
      await store.markSettlementAlerted(settlement, now);
      sum.settlement = settlement.length;
    } else sum.failed++;
  }
  return sum;
}

/**
 * Statement notices; a statement whose recipients can't be read (the API or console down) waits for the next run. Each
 * takes two RPCs (the contacts and the org) and one call per recipient from the budget (D380); a statement that doesn't
 * fit what is left ends the step, and it and the rest go out next run.
 */
export async function runStatementNotices(env: Pick<Env, 'ENV_NAME' | 'CONSOLE_ORIGIN' | 'SECURITY_ALIAS' | 'API' | 'CONSOLE'>, store: LedgerStore, sender: EmailSender, budget: Budget): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const rpc = meteredEnv(env, budget);
  for (const s of await store.unnoticedStatements(STATEMENT_NOTICES_PER_RUN)) {
    // The two reads and at least the alias's email, or the statement waits whole.
    if (!budget.fits(STATEMENT_NOTICE_RPCS + 1, STATEMENT_NOTICE_RPCS)) break;
    const [contacts, org] = await Promise.all([
      rpc.API.getSecurityContacts({ ...systemCtx(), orgId: s.orgId }).catch(() => null),
      rpc.CONSOLE.getOrg({ ...systemCtx(), orgId: s.orgId }).catch(() => null),
    ]);
    if (!contacts?.ok || !org?.ok) {
      out.failed++;
      continue;
    }
    const to = recipients(contacts.emails, org.org.billingEmail, env.SECURITY_ALIAS);
    const r = await sendToAll(sender, budget, to, statementIssued(mail(env), { ...s, orgName: org.org.name }), `statement_issued:${s.orgId}:${s.month}:${s.csvSha256}`);
    if (r.outOfBudget) break;
    if (r.allAccepted) {
      await store.markStatementNoticed(s.orgId, s.month);
      out.sent++;
    } else out.failed++;
  }
  return out;
}
