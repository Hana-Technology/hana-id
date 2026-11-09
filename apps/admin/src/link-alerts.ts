// The link-rate alert (build plan batch 9, spec "Links view": 5× an app's 7-day median, provisional; D448), in the
// 15-minute cron: one RPC (AdminRpc.linkStats) and at most one email to the security alias, once per app and UTC day
// (recorded in `ops.state` so a retry can't repeat it, D380's clean stops), never the email issuer's binding.
import { type LinkJumpAlert, linkJumpMessage } from './email/ledger-messages.ts';
import type { MailContext } from './email/messages.ts';
import type { EmailSender } from './email/sender.ts';
import type { Env } from './env.ts';
import { mailLabel } from './env.ts';
import { jumpsOf } from './link-jumps.ts';
import type { LedgerStore } from './ledger.ts';
import { type Budget, recipients, sendToAll } from './mail.ts';
import { systemCtx } from './rpc.ts';

export const LINK_JUMP_ALERT_STATE = 'links.jump_alerted';

/**
 * One RPC (AdminRpc.linkStats) and at most one digest of the apps whose links jumped today (5× the 7-day median, at
 * least LINK_JUMP_MIN_LINKS; once per app and UTC day, recorded in `ops.state` so a retry can't repeat it). Runs in
 * the 15-minute cron only when two more outbound calls fit (D380's clean stops).
 */
export async function runLinkJumpAlert(env: Pick<Env, 'API' | 'ENV_NAME' | 'CONSOLE_ORIGIN' | 'ENV_LABEL' | 'NEAR_NETWORK' | 'SECURITY_ALIAS'>, ops: LedgerStore['state'], sender: EmailSender, budget: Budget, now: number): Promise<{ alerted: number } | null> {
  if (!budget.fits(2, 1)) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const r = await env.API.linkStats({ ...systemCtx(), days: 8 });
  if (!r.ok) return null;
  const jumped = jumpsOf(r.rows, today).filter((j) => j.jumped);
  if (jumped.length === 0) return { alerted: 0 };
  const state = (await ops.getState([LINK_JUMP_ALERT_STATE])).get(LINK_JUMP_ALERT_STATE);
  const already: { day: string; apps: string[] } = state ? (JSON.parse(state.value) as { day: string; apps: string[] }) : { day: today, apps: [] };
  const seen = new Set(already.day === today ? already.apps : []);
  const fresh = jumped.filter((j) => !seen.has(j.appId));
  if (fresh.length === 0) return { alerted: 0 };
  const mail: MailContext = { env: env.ENV_NAME, consoleOrigin: env.CONSOLE_ORIGIN, label: mailLabel(env) };
  const alerts: LinkJumpAlert[] = fresh.map((j) => ({ appId: j.appId, appName: j.appName, today: j.today, median: j.median }));
  const sent = await sendToAll(sender, budget, recipients(env.SECURITY_ALIAS), linkJumpMessage(mail, alerts), `link_jump:${today}:${fresh.map((j) => j.appId).join(',')}`);
  if (!sent.allAccepted) return null;
  await ops.setState(LINK_JUMP_ALERT_STATE, JSON.stringify({ day: today, apps: [...seen, ...fresh.map((j) => j.appId)] }));
  return { alerted: fresh.length };
}
