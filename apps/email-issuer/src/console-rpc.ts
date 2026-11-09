// ConsoleIssuerRpc (build plan batch 9, D447): what the partner console Worker asks the issuer, a WorkerEntrypoint with
// no route (the issuer's public `fetch` doesn't change), bound only by the console Worker as `ISSUER` (a gen test checks
// it). Two calls, both after the console checked the caller against the org:
//
//   - `clientProof`: the AddClient proof of the scope's email client for an owner action the console is building
//     (D447: the staff route's checks, audited in `email_admin_audit` as `partner-console`, 20 per scope and UTC day);
//   - `deliverability`: an app's sent, bounced and complained mails and its refusals per day (counts only).
//
// Neither names an address, a sub, or an org's other data: `deliverability` answers for exactly the one app id it is
// given, which the console takes only after `ConsoleRpc.getApp` confirmed that app belongs to the caller's org. A source
// test (scripts/test/console-issuer-rpc-source.test.ts) pins these two methods and `email_daily` as the only table.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { type DeliverabilityDay, type PartnerClientProof, type PartnerDeliverability, partnerClientProofInput, partnerDeliverabilityInput } from '@hana-id/console-core';
import { depsFromEnv } from './deps.ts';
import type { Env } from './env.ts';
import { mintPartnerClientProof } from './handlers.ts';
import { log } from './log.ts';

export class ConsoleIssuerRpc extends WorkerEntrypoint<Env> {
  async clientProof(c: unknown): Promise<PartnerClientProof> {
    const parsed = partnerClientProofInput.safeParse(c);
    if (!parsed.success) return { ok: false, code: 'bad_request', error: 'Malformed client proof request' };
    const i = parsed.data;
    try {
      const r = await mintPartnerClientProof(depsFromEnv(this.env, (p) => this.ctx.waitUntil(p)), i.requestId, i);
      log({ event: 'partner_client_proof', requestId: i.requestId, outcome: r.ok ? 'ok' : 'rejected', ...(r.ok ? {} : { code: r.code }) });
      return r;
    } catch {
      log({ event: 'partner_client_proof', requestId: i.requestId, outcome: 'error', code: 'internal' }, 'error');
      return { ok: false, code: 'unavailable', error: 'The issuer could not mint the proof' };
    }
  }

  async deliverability(c: unknown): Promise<PartnerDeliverability> {
    const parsed = partnerDeliverabilityInput.safeParse(c);
    if (!parsed.success) return { ok: false, code: 'bad_request' };
    const i = parsed.data;
    const fromDay = new Date(Date.now() - (i.days - 1) * 86_400_000).toISOString().slice(0, 10);
    try {
      const rows = await this.env.DB.prepare("SELECT day, metric, SUM(count) AS n FROM email_daily WHERE app_id = ?1 AND day >= ?2 AND (metric IN ('sent', 'bounced', 'complained') OR metric GLOB 'refused:*') GROUP BY day, metric ORDER BY day DESC")
        .bind(i.appId, fromDay)
        .all<{ day: string; metric: string; n: number }>();
      const days = new Map<string, DeliverabilityDay>();
      for (const r of rows.results) {
        const d = days.get(r.day) ?? { day: r.day, sent: 0, bounced: 0, complained: 0, refused: 0 };
        if (r.metric === 'sent') d.sent += r.n;
        else if (r.metric === 'bounced') d.bounced += r.n;
        else if (r.metric === 'complained') d.complained += r.n;
        else d.refused += r.n;
        days.set(r.day, d);
      }
      log({ event: 'partner_deliverability', requestId: i.requestId, outcome: 'ok', appId: i.appId, count: days.size });
      return { ok: true, days: [...days.values()] };
    } catch {
      log({ event: 'partner_deliverability', requestId: i.requestId, outcome: 'error', code: 'd1', appId: i.appId }, 'error');
      return { ok: false, code: 'internal' };
    }
  }
}
