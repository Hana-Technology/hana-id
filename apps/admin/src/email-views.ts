// The admin console's email login views (build plan batch 9, spec "Admin portal hooks", D446, D448):
//
//   GET /api/email/issuer?days=14   the issuer's counters per app and day (`ISSUER` → DirectoryRpc.issuerStats, counts
//                                   only; the issuer checks the staff Access JWT itself), the signer policy on chain
//                                   (get_self_issued, get_issuer_keys, get_issuer: three NEAR reads) against the watchdog's
//                                   pins, and what batch 10 adds (AWS KMS figures) said as not applying.
//   GET /api/email/links?days=14    links proposed, activated, cancelled and unlinked per app and day (`API` →
//                                   AdminRpc.linkStats: counts only), and which apps' links jumped today.
//
// Reads only, and no personal data in any of them, so no staff audit row (D396 covers reads of a person) and no row
// budget (D390 covers identities). An issuer or chain that doesn't answer is said so in place; the page still shows
// what could be read.
import { ACCESS_JWT_HEADER } from '@hana-id/oidc';
import { EMAIL_STATS_DAYS_DEFAULT, type IssuerViewAnswer, type LinkStatsRow, type PinnedEmailKeys, type SignerKeyView, emailStatsDays, linkJump, linksMade } from '@hana-id/console-core';
import { type LinkJumpAlert, linkJumpMessage } from './email/ledger-messages.ts';
import type { LedgerStore } from './ledger.ts';
import type { MailContext } from './email/messages.ts';
import type { EmailSender } from './email/sender.ts';
import type { Env } from './env.ts';
import { mailLabel } from './env.ts';
import { type ErrorCode, errorResponse, json } from './http.ts';
import { errorName, log } from './log.ts';
import { type Budget, recipients, sendToAll } from './mail.ts';
import { getEmailSignerPolicy } from './near.ts';
import type { RouteCtx } from './routes.ts';
import { systemCtx, staffCtx } from './rpc.ts';

const daysOf = (c: RouteCtx): number => {
  const raw = c.url.searchParams.get('days');
  if (raw === null) return EMAIL_STATS_DAYS_DEFAULT;
  const n = emailStatsDays.safeParse(Number(raw));
  return n.success ? n.data : EMAIL_STATS_DAYS_DEFAULT;
};

const KMS_NOTE = 'The CloudTrail reconciliation, the AWS key age and the Sign volume and budget alarms apply once the issuer signs with AWS KMS (build plan batch 10).';

function pinsOf(env: Pick<Env, 'EMAIL_PINNED_KEYS'>): PinnedEmailKeys | null {
  if (!env.EMAIL_PINNED_KEYS) return null;
  try {
    const p = JSON.parse(env.EMAIL_PINNED_KEYS) as PinnedEmailKeys;
    return typeof p.required === 'number' && p.signers && typeof p.signers === 'object' ? p : null;
  } catch {
    return null;
  }
}

/** The email signer's keys and policy on chain against the pins. */
async function policyView(env: Env): Promise<IssuerViewAnswer['policy']> {
  const pins = pinsOf(env);
  let chain: Awaited<ReturnType<typeof getEmailSignerPolicy>>;
  try {
    chain = await getEmailSignerPolicy(env.NEAR_RPC, env.SIGNER_ACCOUNT);
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/email/issuer', outcome: 'error', code: 'near_unavailable', error: errorName(err) }, 'warn');
    return { unavailable: 'NEAR didn’t answer: the signer policy can’t be shown right now.' };
  }
  if (!chain) return { unavailable: 'No email issuer on this chain yet (get_self_issued("email") is empty).' };
  const pinnedOf = (signer: string): Set<string> => new Set(pins?.signers[signer] ?? []);
  const keys: SignerKeyView[] = chain.signers.flatMap((s) => s.kids.map((kid) => ({ kid, signer: s.id, onChain: chain!.keys.includes(kid), pinned: pinnedOf(s.id).has(kid) })));
  // A pinned key the chain doesn't list yet (or lists no more) shows too: the watchdog compares both ways.
  if (pins) for (const [signer, kids] of Object.entries(pins.signers)) for (const kid of kids) if (!keys.some((k) => k.signer === signer && k.kid === kid)) keys.push({ kid, signer, onChain: chain.keys.includes(kid), pinned: true });
  const matchesPins = pins !== null && chain.required === pins.required && keys.every((k) => k.onChain === k.pinned) && chain.signers.every((s) => (pins.signers[s.id]?.length ?? 0) === s.kids.length);
  return { required: chain.required, signers: chain.signers.map((s) => s.id), keys, iss: chain.iss, matchesPins, pinsConfigured: pins !== null };
}

export async function issuerViewRoute(c: RouteCtx): Promise<Response> {
  const days = daysOf(c);
  const issuer = c.env.ISSUER;
  let stats: IssuerViewAnswer['stats'] = { unavailable: 'This environment has no email issuer.' };
  if (issuer) {
    try {
      const r = await issuer.issuerStats({ requestId: c.staff.requestId, accessJwt: c.request.headers.get(ACCESS_JWT_HEADER) ?? '', days });
      if (r.ok) {
        const { ok: _ok, ...s } = r;
        stats = s;
      } else {
        log({ event: 'bff', route: 'GET /api/email/issuer', requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
        stats = { unavailable: r.code === 'not_staff' || r.code === 'unauthenticated' ? 'The issuer refused your Access session (check ADMIN_STAFF_EMAILS).' : 'The issuer’s counters can’t be read right now.' };
      }
    } catch (err) {
      log({ event: 'bff', route: 'GET /api/email/issuer', requestId: c.staff.requestId, outcome: 'error', code: 'directory_unavailable', error: errorName(err) }, 'error');
      stats = { unavailable: 'The issuer didn’t answer: its counters can’t be shown right now.' };
    }
  }
  // The apps' names for the page (at most one RPC; a failure shows ids).
  const appIds = 'issuance' in stats ? [...new Set([...stats.issuance.map((r) => r.appId), ...stats.metrics.map((r) => r.appId)].filter((v): v is string => v !== null))].slice(0, 50) : [];
  let appNames: Record<string, string> = {};
  if (appIds.length) {
    try {
      const names = await c.env.API.appNames({ ...staffCtx(c.staff), appIds });
      if (names.ok) appNames = Object.fromEntries(names.apps.map((a) => [a.id, a.name]));
    } catch {
      // Ids instead of names.
    }
  }
  const body: IssuerViewAnswer = { days, appNames, stats, policy: await policyView(c.env), kms: { signerKind: c.env.EMAIL_SIGNER_KIND === 'aws-kms' ? 'aws-kms' : 'worker-secret', note: KMS_NOTE } };
  return json(200, body);
}

/** One row per app with the links it made today and whether that jumped over its 7-day median. */
function jumpsOf(rows: readonly LinkStatsRow[], today: string): { appId: string; appName: string; today: number; median: number; jumped: boolean }[] {
  const byApp = new Map<string, LinkStatsRow[]>();
  for (const r of rows) (byApp.get(r.appId) ?? byApp.set(r.appId, []).get(r.appId)!).push(r);
  const out: { appId: string; appName: string; today: number; median: number; jumped: boolean }[] = [];
  for (const [appId, list] of byApp) {
    const todayRow = list.find((x) => x.day === today);
    const count = todayRow ? linksMade(todayRow) : 0;
    const prior = list.filter((x) => x.day < today).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7).map(linksMade);
    const { median, jumped } = linkJump(count, prior);
    if (count > 0) out.push({ appId, appName: list[0]!.appName, today: count, median, jumped });
  }
  return out.sort((a, b) => Number(b.jumped) - Number(a.jumped) || b.today - a.today);
}

export async function linksViewRoute(c: RouteCtx): Promise<Response> {
  const days = daysOf(c);
  let r: Awaited<ReturnType<Env['API']['linkStats']>>;
  try {
    r = await c.env.API.linkStats({ ...staffCtx(c.staff), days });
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/email/links', requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable', 'The API didn’t answer: try again');
  }
  if (!r.ok) {
    log({ event: 'bff', route: 'GET /api/email/links', requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
    return errorResponse(r.code as ErrorCode, r.error);
  }
  const today = new Date().toISOString().slice(0, 10);
  return json(200, { days, today, rows: r.rows, jumps: jumpsOf(r.rows, today) });
}

// ---- the link-rate alert (the 15-minute cron, D448) ----

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
