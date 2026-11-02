// Read-only status for batch C's admin portal (D83), plus acknowledgements:
//   GET  /status               last run and its checks, heartbeat, silence, seen kids, relayer funds, the email pins
//                              and the chain's email issuer, the link stats (D200), recent actions,
//                              open alerts
//   GET  /alerts?cursor&limit&severity   alert history, newest first, with deliveries
//   GET  /actions?cursor&limit actions log, newest first (transaction hashes)
//   POST /alerts/:id/ack {by}  records who acknowledged (via "portal"); stops only the 15-minute re-sends
// Every request needs `Authorization: Bearer <WATCHDOG_STATUS_TOKEN>` (the admin Worker holds the other copy). Nothing
// here can change a check, stop a first delivery or call the chain.
import { ALERT_KINDS_WITH_PLAYBOOKS, CHANNELS, CHECKS, RESEND_MS, RUN_INTERVAL_MS, type Severity } from './checks.ts';
import type { Notifier } from './channels.ts';
import type { LinkStatsView } from './chain.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { parsePins } from './pins.ts';
import { type EmailPolicyStatus, type HeartbeatState, META, type RelayerFundsStatus } from './run.ts';
import type { AlertRow, Store } from './store.ts';

/** The portal warns when the last run is older than two intervals (spec "Monitoring in the admin portal"). */
export const SILENT_AFTER_MS = 2 * RUN_INTERVAL_MS;
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 1024;
const BY_RE = /^[\p{L}\p{N} ._@+:()-]{1,200}$/u;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const error = (status: number, code: string, message: string) => json(status, { error: message, code });

async function digest(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

/** Constant-time bearer check (hashes first, so lengths don't leak either). */
export async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token || token.length < MIN_TOKEN_LENGTH) return false;
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer (\S+)$/u.exec(header);
  if (!m?.[1]) return false;
  const [a, b] = await Promise.all([digest(m[1]), digest(token)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function alertView(a: AlertRow) {
  return {
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    title: a.title,
    details: a.details,
    created_at: a.created_at,
    resolved_at: a.resolved_at,
    acked_at: a.acked_at,
    acked_by: a.acked_by,
    acked_via: a.acked_via,
    last_sent_at: a.last_sent_at,
    send_count: a.send_count,
    pending_channels: a.pending_channels,
    channels: CHANNELS[a.severity],
    resends_until_ack: a.severity === 'critical',
  };
}

function cursorParams(url: URL): { before: number | null; limit: number } | null {
  const c = url.searchParams.get('cursor');
  const l = url.searchParams.get('limit');
  const before = c === null ? null : Number(c);
  const limit = l === null ? 50 : Number(l);
  if ((before !== null && (!Number.isInteger(before) || before < 1)) || !Number.isInteger(limit) || limit < 1 || limit > 200) return null;
  return { before, limit };
}

export interface StatusDeps {
  env: Env;
  store: Store;
  notifier: Notifier;
  now: () => number;
}

export async function handleRequest(request: Request, d: StatusDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const route = path === '/status' ? 'status' : path === '/alerts' ? 'alerts' : path === '/actions' ? 'actions' : /^\/alerts\/\d{1,12}\/ack$/u.test(path) ? 'ack' : null;
  if (!route) return error(404, 'not_found', 'Not found');
  if (!d.env.WATCHDOG_STATUS_TOKEN || d.env.WATCHDOG_STATUS_TOKEN.length < MIN_TOKEN_LENGTH) return error(503, 'not_configured', 'The status token is not configured');
  if (!(await authorized(request, d.env.WATCHDOG_STATUS_TOKEN))) {
    log({ event: 'status_request', outcome: 'rejected', code: 'unauthorized' }, 'warn');
    return error(401, 'unauthorized', 'Missing or wrong bearer token');
  }
  const method = request.method;
  if (route === 'ack' ? method !== 'POST' : method !== 'GET') return error(405, 'method_not_allowed', 'Method not allowed');

  if (route === 'status') return json(200, await status(d));
  if (route === 'alerts') {
    const p = cursorParams(url);
    const sev = url.searchParams.get('severity');
    if (!p || (sev !== null && !(['critical', 'warning', 'info'] as const).includes(sev as Severity))) return error(400, 'bad_request', 'Bad cursor, limit or severity');
    const rows = await d.store.listAlerts(p.before, p.limit, sev as Severity | null);
    const alerts = await Promise.all(rows.map(async (a) => ({ ...alertView(a), deliveries: await d.store.deliveries(a.id) })));
    return json(200, { alerts, next_cursor: rows.length === p.limit ? rows[rows.length - 1]!.id : null });
  }
  if (route === 'actions') {
    const p = cursorParams(url);
    if (!p) return error(400, 'bad_request', 'Bad cursor or limit');
    const rows = await d.store.listActions(p.before, p.limit);
    return json(200, { actions: rows, next_cursor: rows.length === p.limit ? rows[rows.length - 1]!.id : null });
  }

  // ---- ack ----
  const id = Number(path.split('/')[2]);
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return error(415, 'unsupported_media_type', 'Send JSON');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return error(413, 'too_large', 'Body too large');
  let by: unknown;
  try {
    by = (JSON.parse(text) as { by?: unknown } | null)?.by;
  } catch {
    return error(400, 'bad_request', 'Body is not JSON');
  }
  if (typeof by !== 'string' || !BY_RE.test(by)) return error(400, 'bad_request', '`by` must be 1-200 characters (letters, digits, space, . _ @ + : ( ) -)');
  const alert = await d.store.getAlert(id);
  if (!alert) return error(404, 'not_found', 'No such alert');
  if (!(await d.store.ack(id, by, 'portal', d.now()))) {
    const current = await d.store.getAlert(id);
    return json(409, { error: 'Already acknowledged', code: 'already_acknowledged', alert: current && alertView(current) });
  }
  log({ event: 'alert_acked', alertId: id, channel: 'portal' });
  const acked = await d.store.getAlert(id);
  return json(200, { alert: acked && alertView(acked) });
}

async function status(d: StatusDeps) {
  const now = d.now();
  const last = await d.store.lastRun();
  const hb = await d.store.getMeta<HeartbeatState>(META.heartbeat);
  const actions = await d.store.listActions(null, 50);
  const open = await d.store.openAlerts();
  return {
    service: 'hana-id-watchdog',
    env: d.env.ENV_NAME,
    network: d.env.NEAR_NETWORK,
    signer: d.env.SIGNER_ACCOUNT,
    watchdog_account: d.env.WATCHDOG_ACCOUNT,
    now,
    run_interval_ms: RUN_INTERVAL_MS,
    resend_ms: RESEND_MS,
    initialized_at: await d.store.getMeta<number>(META.initializedAt),
    last_run: last,
    // The portal shows a warning banner when true (D83).
    silent: !last?.finished_at || now - last.finished_at > SILENT_AFTER_MS,
    heartbeat: { configured: d.notifier.heartbeat.configured, ...(hb ?? { last_ping_at: null, last_ok_at: null, ok: false, failures: 0 }) },
    channels: {
      pager: { provider: d.notifier.pager.provider, configured: d.notifier.pager.configured },
      slack: { configured: d.notifier.slack.configured },
      email: { configured: d.notifier.email.configured },
    },
    seen_kids: await d.store.allSeenKids(),
    // The last relayer reading (balance, pool keys' allowances, thresholds; yocto strings), or null before one.
    relayer_funds: await d.store.getMeta<RelayerFundsStatus>(META.relayerFunds),
    // The email pins in force (thumbprints: public), Hana's JWKS URL, and the chain's email issuer and signer policy
    // with every difference at the last run (null before one).
    email: { pinned: parsePins(d.env.EMAIL_PINS).pins, jwks_url: d.env.EMAIL_JWKS_URL ?? null, last: await d.store.getMeta<EmailPolicyStatus>(META.emailPolicy) },
    // The last get_link_stats() (D200): thresholds, pending raise, the current and previous hour (null before one, or
    // on a contract without the view).
    link_stats: await d.store.getMeta<LinkStatsView & { at: number }>(META.linkStats),
    actions,
    open_alerts: open.map(alertView),
    checks: CHECKS,
    // Each kind with its severity, check, description and `playbook` id (`@hana-id/playbooks`, D126).
    alert_kinds: ALERT_KINDS_WITH_PLAYBOOKS,
  };
}
