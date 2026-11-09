// The issuer's per-app daily counters (migration 0004 `email_daily`, build plan batch 9, D446): what the admin console's
// issuer view and a partner's Email login page show that the logs alone don't. `sent` per mail the provider accepted,
// `bounced` and `complained` from the event webhook, `refused:<limit>` per refusal, `alert:<event>[:code]` per alert
// occurrence. Written after the response (`waitUntil`) and never allowed to fail a request. Refusals are the one count
// an attacker controls, so each is capped at REFUSAL_COUNT_CAP per app, metric and day: the upsert changes nothing past
// the cap, so refusals never cost more than a bounded number of D1 writes (D417's free tier).
//
// Five alert kinds also email the security alias, at most once per kind, code and app a UTC day and at most
// ALERT_MAILS_PER_DAY in all (a limiter object each, so no cron and no extra read). Mail goes through the issuer's own
// sender; the message never holds an address, a sub, a key or a token.
import type { Deps } from './deps.ts';
import { log } from './log.ts';
import type { Limit } from './rate-limiter.ts';

/** One day of refusals per metric and app is counted exactly up to this many (a flood past it answers the same). */
export const REFUSAL_COUNT_CAP = 1000;
const NO_CAP = 2_000_000_000;

export const ALERT_MAILS_PER_DAY = 20;

const DAY_MS = 86_400_000;
const ONCE_A_DAY: Limit = { name: 'alert:1d', windowMs: DAY_MS, max: 1 };
const GLOBAL_ALERT_DAY: Limit = { name: 'alerts:1d', windowMs: DAY_MS, max: ALERT_MAILS_PER_DAY };

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const COUNT_SQL =
  'INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?5) ON CONFLICT (day, app_id, metric) DO UPDATE SET count = count + ?5 WHERE count < ?4';

/** Adds `n` to a metric of today, after the response. `cap` stops counting once reached (a refusal's writes bounded). */
export function countDaily(deps: Pick<Deps, 'env' | 'now' | 'waitUntil'>, appId: string | null, metric: string, opts: { cap?: number; n?: number } = {}): void {
  const write = deps.env.DB.prepare(COUNT_SQL)
    .bind(dayOf(deps.now()), appId ?? '', metric.slice(0, 96), opts.cap ?? NO_CAP, opts.n ?? 1)
    .run()
    .then(() => undefined)
    .catch(() => log({ event: 'daily_count_failed', outcome: 'error', code: metric.slice(0, 48) }, 'error'));
  deps.waitUntil(write);
}

/** One refusal, counted under its limit's name (`refused:<limit>`), up to REFUSAL_COUNT_CAP a day. */
export const countRefusal = (deps: Pick<Deps, 'env' | 'now' | 'waitUntil'>, appId: string | null, limit: string): void => countDaily(deps, appId, `refused:${limit}`, { cap: REFUSAL_COUNT_CAP });

/** The five alert events the issuer raises (build plan batch 9): each occurrence counted; at most one mail a day. */
export type AlertKind = 'send_budget_exhausted' | 'email_budget' | 'email_owner_pool' | 'email_domain_cap' | 'mailbox_guess_limit';

const ALERT_TEXT: Record<AlertKind, { title: string; what: string; hint: string }> = {
  send_budget_exhausted: {
    title: 'Email login: a send budget ran out',
    what: 'A login code was refused because a daily send budget was used up.',
    hint: 'Look at the admin console’s Email issuer page. Until the UTC day ends, affected users answer “try again later”.',
  },
  email_budget: {
    title: 'Email login: a daily budget passed 50% or 80%',
    what: 'The day’s user-mail budget passed a threshold.',
    hint: 'Look at the admin console’s Email issuer page; expect the budget to run out if the trend continues.',
  },
  email_owner_pool: {
    title: 'Email login: the owner pool passed 50% or 80%',
    what: 'The mails reserved for device owners passed a threshold. Someone may be holding many device tickets.',
    hint: 'Check the Email issuer page; staff can revoke tickets for an address.',
  },
  email_domain_cap: {
    title: 'Email login: a recipient domain hit its daily cap',
    what: 'A recipient domain used up its login-code cap for the day. New users on that domain answer “try again later” until the UTC day ends.',
    hint: 'If it is a real company domain, expect support contact. The domain is identified in the logs by its key only.',
  },
  mailbox_guess_limit: {
    title: 'Email login: someone is guessing codes for a mailbox',
    what: 'A mailbox passed its wrong-code backstop or ceiling for the day.',
    hint: 'The mailbox is identified in the issuer’s log by a key prefix only; follow the mailbox unlock playbook if the user contacts support.',
  },
};

/** The alert's mail, `kind: 'alert'` so the sender bypasses the provider's suppression lists (D401): no address in it. */
export function alertMail(kind: AlertKind, code: string, appId: string | null, env: string, to: string): { to: string; subject: string; text: string; html: string; kind: 'alert' } {
  const t = ALERT_TEXT[kind];
  const lines = [t.what, '', `Environment: ${env}`, `Code: ${code || '-'}`, ...(appId ? [`App: ${appId}`] : []), '', t.hint];
  return {
    to,
    subject: `[Hana ID ${env}] ${t.title}`,
    text: lines.join('\n'),
    html: lines.map((l) => (l ? `<p>${l.replace(/[&<>]/gu, (c) => `&#${c.charCodeAt(0)};`)}</p>` : '')).join(''),
    kind: 'alert',
  };
}

/**
 * Records one occurrence of an alert event and, the first time a UTC day for this (kind, code, app) and within the
 * day's overall cap, mails the security alias. Runs after the response; never throws.
 */
export function raiseAlert(deps: Deps, requestId: string, kind: AlertKind, code: string, appId: string | null): void {
  countDaily(deps, appId, `alert:${kind}${code ? `:${code}` : ''}`);
  const to = deps.env.SECURITY_ALIAS;
  if (!to) return;
  const limiter = (name: string) => deps.env.RATE_LIMITER.get(deps.env.RATE_LIMITER.idFromName(`${deps.env.ENV_NAME}:${name}`));
  const send = async (): Promise<void> => {
    const now = deps.now();
    // At most one mail per kind, code and app a day; at most ALERT_MAILS_PER_DAY across all of them.
    const key = `alert:${kind}:${code}:${appId ?? ''}`.slice(0, 96);
    if (!(await limiter(key).hit([ONCE_A_DAY], now)).ok) return;
    if (!(await limiter('alert-global').hit([GLOBAL_ALERT_DAY], now)).ok) return;
    const res = await deps.sender.send(alertMail(kind, code, appId, deps.env.ENV_NAME, to));
    log({ event: 'alert_mail', requestId, outcome: res.ok ? 'ok' : 'error', code: kind, ...(res.ok ? {} : { limit: res.reason }) }, res.ok ? 'info' : 'error');
  };
  deps.waitUntil(send().catch(() => log({ event: 'alert_mail', requestId, outcome: 'error', code: kind }, 'error')));
}
