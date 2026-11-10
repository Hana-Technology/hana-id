// "Security & monitoring" (batch C14; D83, D126; docs/governance-spec.md "Monitoring in the admin portal"): the staff
// view of the watchdog and of hana-signer's governance. Read-only but for one thing, the acknowledgement of a watchdog
// alert, which only stops that alert's 15-minute re-sends: it never clears a condition, never stops a first alert and
// never acts on chain (the watchdog's own rule, apps/watchdog/src/status.ts).
//
//   GET  /api/monitoring                     the watchdog's /status, the GET /v1/governance snapshot (AdminRpc.governance),
//                                            the recent security events, and the findings the portal must show
//   GET  /api/monitoring/alerts?cursor&severity  the alert history (25 a page, newest first)
//   GET  /api/monitoring/actions?cursor      the watchdog's actions log (50 a page) with transaction links
//   POST /api/monitoring/alerts/:id/ack      forwards the ack with the staff member's Access identity as `by`
//   GET  /api/governance/pending-upgrades    the pending-upgrades page (D86; AdminRpc.pendingUpgrades)
//
// The three sources are read in parallel and each fails on its own: a watchdog that doesn't answer leaves the
// governance part standing, and the other way round. Everything from the watchdog is reduced to bounded plain data
// (plain.ts) and picked field by field; the SPA writes it as text. The portal never alerts: the watchdog sends its own.
import { isDevEnv } from '@hana-id/env/origins';
import type { Env } from './env.ts';
import { type ErrorCode, errorResponse, json } from './http.ts';
import { errorName, log } from './log.ts';
import { CHECK_VIEWS } from './monitoring-registry.ts';
import { getPlaybook } from '@hana-id/playbooks';
import { type PlaybookLink, playbookFor } from './playbooks.ts';
import { arr, bool, num, obj, plain, str } from './plain.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';
import { callWatchdog } from './watchdog.ts';

/** The watchdog's cron interval (apps/watchdog/src/checks.ts RUN_INTERVAL_MS); its own `run_interval_ms` wins when served. */
export const DEFAULT_RUN_INTERVAL_MS = 5 * 60_000;
/** Deliveries kept per alert in a view (the latest ones; the total is shown). */
export const DELIVERIES_SHOWN = 20;
export const ALERTS_PAGE = 25;
export const ACTIONS_PAGE = 50;

type Severity = 'critical' | 'warning' | 'info';
const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];
const severityOf = (v: unknown): Severity | 'unknown' => (SEVERITIES.includes(v as Severity) ? (v as Severity) : 'unknown');

// ---- the watchdog's answers, as views ----

export interface AlertView {
  id: number;
  kind: string;
  severity: Severity | 'unknown';
  title: string;
  details: unknown;
  createdAt: number | null;
  resolvedAt: number | null;
  ackedAt: number | null;
  ackedBy: string | null;
  ackedVia: string | null;
  lastSentAt: number | null;
  sendCount: number | null;
  channels: string[];
  resendsUntilAck: boolean;
  /** The condition still holds (not resolved). An ack never changes this. */
  open: boolean;
  /** Unacknowledged and re-sent until acknowledged: the portal offers the ack. */
  canAck: boolean;
  deliveries: unknown[];
  deliveriesTotal: number;
  /** The newest delivery row of each channel, out of all the watchdog served (not only the last ones kept above). */
  deliveriesLatest: unknown[];
  /** Its recovery playbook; null renders the "no playbook" error (D126). */
  playbook: PlaybookLink | null;
}

/** The newest row of each channel, oldest channel result first (the watchdog serves rows oldest first). */
function latestPerChannel(deliveries: unknown[]): unknown[] {
  const latest = new Map<string, unknown>();
  for (const d of deliveries) {
    const channel = str(obj(d)?.channel);
    if (channel === null) continue;
    latest.delete(channel);
    latest.set(channel, d);
  }
  return (plain([...latest.values()]) as unknown[]) ?? [];
}

export function alertView(raw: unknown, servedKinds: Record<string, unknown> = {}): AlertView | null {
  const a = obj(raw);
  const id = num(a?.id);
  if (!a || id === null || !Number.isSafeInteger(id) || id < 1) return null;
  const kind = str(a.kind) ?? 'unknown';
  const ackedAt = num(a.acked_at);
  const resendsUntilAck = bool(a.resends_until_ack) ?? severityOf(a.severity) === 'critical';
  const deliveries = arr(a.deliveries);
  return {
    id,
    kind,
    severity: severityOf(a.severity),
    title: str(a.title) ?? kind,
    details: plain(a.details),
    createdAt: num(a.created_at),
    resolvedAt: num(a.resolved_at),
    ackedAt,
    ackedBy: str(a.acked_by),
    ackedVia: str(a.acked_via),
    lastSentAt: num(a.last_sent_at),
    sendCount: num(a.send_count),
    channels: arr(a.channels).flatMap((c) => (typeof c === 'string' ? [str(c)!] : [])),
    resendsUntilAck,
    open: num(a.resolved_at) === null,
    canAck: ackedAt === null && resendsUntilAck,
    deliveries: (plain(deliveries.slice(-DELIVERIES_SHOWN)) as unknown[]) ?? [],
    deliveriesTotal: deliveries.length,
    deliveriesLatest: latestPerChannel(deliveries),
    playbook: playbookFor(kind, obj(servedKinds[kind])?.playbook),
  };
}

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/u;

/** An explorer link for a transaction hash, on testnet or mainnet only. */
export function txUrl(hash: unknown, network: string | undefined): string | null {
  if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) return null;
  if (network === 'testnet') return `https://testnet.nearblocks.io/txns/${hash}`;
  if (network === 'mainnet') return `https://nearblocks.io/txns/${hash}`;
  return null;
}

export interface ActionView {
  id: number;
  runId: number | null;
  at: number | null;
  method: string;
  args: unknown;
  reason: string | null;
  ok: boolean | null;
  txHash: string | null;
  txUrl: string | null;
  error: string | null;
}

export function actionView(raw: unknown, network: string | undefined): ActionView | null {
  const a = obj(raw);
  const id = num(a?.id);
  if (!a || id === null || !Number.isSafeInteger(id)) return null;
  const hash = typeof a.tx_hash === 'string' && TX_HASH_RE.test(a.tx_hash) ? a.tx_hash : null;
  return { id, runId: num(a.run_id), at: num(a.at), method: str(a.method) ?? 'unknown', args: plain(a.args), reason: str(a.reason), ok: bool(a.ok), txHash: hash ?? str(a.tx_hash), txUrl: txUrl(hash, network), error: str(a.error) };
}

export interface CheckRow {
  id: string;
  title: string;
  shownIn: string | null;
  description: string | null;
  /** The last run's outcome (`ok`, `alert`, `skipped`, `error`), or null when it didn't report this check. */
  outcome: string | null;
  detail: string | null;
  /** False: the watchdog runs a check this portal has no rendering for (D83: not done until it has one). */
  known: boolean;
}

export interface WatchdogStatusView {
  env: string | null;
  network: string | null;
  signer: string | null;
  watchdogAccount: string | null;
  now: number | null;
  runIntervalMs: number;
  resendMs: number | null;
  initializedAt: number | null;
  lastRun: { id: number | null; startedAt: number | null; finishedAt: number | null; outcome: string | null; firstRun: boolean | null } | null;
  /** No finished run within two intervals (by the watchdog's clock, or by this Worker's). */
  silent: boolean;
  /** Since the last finished run, by this Worker's clock (null before any). */
  sinceLastRunMs: number | null;
  checks: CheckRow[];
  heartbeat: unknown;
  channels: unknown;
  seenKids: { provider: string | null; kid: string | null; source: string | null; firstSeenAt: number | null; lastSeenAt: number | null }[];
  relayerFunds: unknown;
  email: unknown;
  linkStats: unknown;
  identity: unknown;
  actions: ActionView[];
  openAlerts: AlertView[];
  alertKinds: { kind: string; severity: Severity | 'unknown'; check: string | null; description: string | null; playbook: PlaybookLink | null }[];
}

export function statusView(raw: unknown, now: number, network: string | undefined): WatchdogStatusView {
  const s = obj(raw) ?? {};
  const interval = num(s.run_interval_ms) ?? DEFAULT_RUN_INTERVAL_MS;
  const lr = obj(s.last_run);
  const finishedAt = num(lr?.finished_at);
  const servedKinds = obj(s.alert_kinds) ?? {};
  const servedChecks = obj(s.checks) ?? {};
  const outcomes = new Map<string, { outcome: string | null; detail: string | null }>();
  for (const c of arr(lr?.checks)) {
    const o = obj(c);
    const id = str(o?.id);
    if (id) outcomes.set(id, { outcome: str(o?.outcome), detail: str(o?.detail) });
  }
  const ids = [...new Set([...Object.keys(CHECK_VIEWS), ...Object.keys(servedChecks).map((k) => str(k)!), ...outcomes.keys()])];
  const checks: CheckRow[] = ids.map((id) => {
    const view = CHECK_VIEWS[id];
    const out = outcomes.get(id);
    return { id, title: view?.title ?? id, shownIn: view?.shownIn ?? null, description: str(servedChecks[id]), outcome: out?.outcome ?? null, detail: out?.detail ?? null, known: !!view };
  });
  const lastRun = lr ? { id: num(lr.id), startedAt: num(lr.started_at), finishedAt, outcome: str(lr.outcome), firstRun: bool(lr.first_run) } : null;
  const silentByUs = finishedAt === null || now - finishedAt > 2 * interval;
  return {
    env: str(s.env),
    network: str(s.network),
    signer: str(s.signer),
    watchdogAccount: str(s.watchdog_account),
    now: num(s.now),
    runIntervalMs: interval,
    resendMs: num(s.resend_ms),
    initializedAt: num(s.initialized_at),
    lastRun,
    silent: bool(s.silent) === true || silentByUs,
    sinceLastRunMs: finishedAt === null ? null : Math.max(0, now - finishedAt),
    checks,
    heartbeat: plain(s.heartbeat),
    channels: plain(s.channels),
    seenKids: arr(s.seen_kids).map((k) => {
      const o = obj(k) ?? {};
      return { provider: str(o.provider), kid: str(o.kid), source: str(o.source), firstSeenAt: num(o.first_seen_at), lastSeenAt: num(o.last_seen_at) };
    }),
    relayerFunds: plain(s.relayer_funds),
    email: plain(s.email),
    linkStats: plain(s.link_stats),
    identity: plain(s.identity),
    actions: arr(s.actions).flatMap((a) => actionView(a, network) ?? []),
    openAlerts: arr(s.open_alerts).flatMap((a) => alertView(a, servedKinds) ?? []),
    alertKinds: Object.entries(servedKinds).map(([kind, info]) => {
      const o = obj(info) ?? {};
      return { kind: str(kind)!, severity: severityOf(o.severity), check: str(o.check), description: str(o.description), playbook: playbookFor(kind, o.playbook) };
    }),
  };
}

// ---- the governance snapshot, joined with the watchdog's view ----

interface Gov {
  paused?: unknown;
  unpausedAtMs?: unknown;
  keyChanges?: unknown;
  watchdogs?: unknown;
  updaterKeys?: unknown;
  signerAccessKeys?: unknown;
  pendingUpgrade?: unknown;
  pendingOwner?: unknown;
  pendingWithdrawal?: unknown;
  pendingConsoleAudiences?: unknown;
  delays?: unknown;
  updater?: unknown;
}

/** The snapshot with what the view joins in: each key change's watchdog sighting, the pause, the updater keys against the account. */
export function governanceView(raw: unknown, watchdog: WatchdogStatusView | null) {
  const g = (plain(raw) ?? {}) as Gov & Record<string, unknown>;
  const seen = new Map((watchdog?.seenKids ?? []).map((k) => [`${k.provider}#${k.kid}`, k]));
  const keyChanges = arr(g.keyChanges).map((c) => {
    const o = obj(c) ?? {};
    const k = seen.get(`${str(o.provider)}#${str(o.kid)}`);
    return { ...o, watchdogSeen: k ? { firstSeenAt: k.firstSeenAt, lastSeenAt: k.lastSeenAt, source: k.source } : null };
  });
  const keys = arr(g.signerAccessKeys).map((k) => obj(k) ?? {});
  const accessKeysRead = Array.isArray(g.signerAccessKeys);
  const updaterKeys = arr(g.updaterKeys).flatMap((pk) => {
    if (typeof pk !== 'string') return [];
    const onAccount = keys.find((k) => k.publicKey === pk);
    return [{ publicKey: pk, onAccount: accessKeysRead ? !!onAccount : null, permissionOk: onAccount ? onAccount.updaterPermission === true : null }];
  });
  const pauses = (watchdog?.actions ?? []).filter((a) => a.method === 'pause');
  return {
    ...g,
    keyChanges,
    pause: { paused: g.paused === true, unpausedAtMs: num(g.unpausedAtMs), lastWatchdogPause: pauses[0] ? { at: pauses[0].at, ok: pauses[0].ok, reason: pauses[0].reason, txUrl: pauses[0].txUrl } : null },
    updaterKeyCheck: updaterKeys,
    otherSignerKeys: keys.filter((k) => k.updaterKey !== true),
  };
}

// ---- findings: what the portal must show as problems ----

export interface Finding {
  severity: Severity;
  source: 'watchdog' | 'governance' | 'portal';
  text: string;
  /** A playbook to open for it, when one answers it. */
  playbook?: PlaybookLink | null;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

export function findingsOf(input: { env: string; now: number; watchdog: { ok: true; view: WatchdogStatusView } | { ok: false; code: ErrorCode }; governance: { ok: true; data: Record<string, unknown> } | { ok: false; code: string } }): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, source: Finding['source'], text: string, playbookId?: string) => {
    const p = playbookId ? getPlaybook(playbookId) : undefined;
    out.push({ severity, source, text, ...(p ? { playbook: { id: p.id, title: p.title } } : {}) });
  };
  const w = input.watchdog;
  if (!w.ok) add('critical', 'watchdog', `The watchdog's status can't be read (${w.code}): heartbeat, verdicts and alerts are unknown here. Its own alerts don't depend on this portal.`, 'watchdog-down');
  else {
    const v = w.view;
    if (v.silent) add('critical', 'watchdog', v.sinceLastRunMs === null ? 'The watchdog has never finished a run.' : `The watchdog has been silent for ${minutes(v.sinceLastRunMs)} (more than two ${minutes(v.runIntervalMs)} intervals).`, 'watchdog-down');
    for (const c of v.checks) {
      if (!c.known) add('warning', 'portal', `The watchdog runs check "${c.id}", which this portal has no rendering for (D83).`);
      if (c.outcome === 'error' || c.outcome === 'alert') add(c.outcome === 'error' ? 'warning' : 'info', 'watchdog', `Check ${c.id} (${c.title}): ${c.outcome}${c.detail ? `: ${c.detail}` : ''}`);
    }
    const unacked = v.openAlerts.filter((a) => a.canAck);
    if (unacked.length) add('critical', 'watchdog', `${unacked.length} critical alert${unacked.length > 1 ? 's' : ''} not acknowledged (re-sent every 15 min until acknowledged): ${unacked.map((a) => `#${a.id} ${a.kind}`).join(', ')}.`);
    for (const a of [...v.openAlerts, ...v.alertKinds.map((k) => ({ kind: k.kind, playbook: k.playbook }))]) {
      if (!a.playbook) add('warning', 'portal', `Alert kind ${a.kind} has no playbook in @hana-id/playbooks.`);
    }
    const hb = obj(v.heartbeat);
    if (hb && hb.configured === false) add('warning', 'watchdog', "The dead-man's switch heartbeat is not configured.", 'watchdog-degraded');
    else if (hb && hb.ok === false) add('warning', 'watchdog', "The dead-man's switch ping is failing.", 'watchdog-degraded');
    const ch = obj(v.channels);
    for (const name of ['pager', 'slack', 'email']) if (ch && obj(ch[name])?.configured === false) add('warning', 'watchdog', `The watchdog's ${name} channel is not configured.`, 'watchdog-degraded');
  }
  const g = input.governance;
  if (!g.ok) add('critical', 'governance', `The governance state can't be read (${g.code}).`);
  else {
    const d = g.data as Gov;
    if (d.paused === true) add('critical', 'governance', 'hana-signer is paused: derivation and new sessions are refused.', 'contract-paused');
    const up = obj(d.pendingUpgrade);
    if (up) add('critical', 'governance', `Upgrade proposed to code hash ${str(up.codeHash)}, executable ${up.due ? 'now' : `at ${new Date(num(up.executableAtMs) ?? 0).toISOString()}`}.`, 'governance-change');
    const owner = obj(d.pendingOwner);
    if (owner) add('critical', 'governance', `Owner transfer proposed to ${str(owner.owner)}.`, 'governance-change');
    const wd = obj(d.pendingWithdrawal);
    if (wd) add('critical', 'governance', `Withdrawal proposed: ${str(wd.amountYocto)} yoctoNEAR to ${str(wd.receiver)}.`, 'governance-change');
    const delays = obj(d.delays) ?? {};
    for (const [k, label] of [['pendingIssuerKeyDelay', 'issuer-key'], ['pendingGovernanceDelay', 'governance'], ['pendingChangeDelay', 'scope-change']] as const) {
      const p = obj(delays[k]);
      if (p) add('warning', 'governance', `A ${label} delay decrease to ${num(p.valueMs)} ms is pending.`, 'governance-change');
    }
    for (const a of arr(d.pendingConsoleAudiences)) add('warning', 'governance', `Console audience addition pending: ${str(obj(a)?.aud)}.`, 'governance-change');
    for (const c of arr(d.keyChanges)) {
      const o = obj(c) ?? {};
      const what = `${str(o.op)} of ${str(o.provider)} kid ${str(o.kid)} (change ${num(o.id)})`;
      if (o.op === 'Add' && (o.jwks === 'mismatch' || o.jwks === 'absent')) add('critical', 'governance', `Pending ${what}: Google's JWKS ${o.jwks === 'absent' ? "doesn't publish it" : 'has other key material'}.`, 'forged-key-change');
      if (o.op === 'Remove' && o.jwks === 'present') add('critical', 'governance', `Pending ${what}: Google still publishes it.`, 'published-key-removal');
      if (o.due === true) add('warning', 'governance', `${what} is due and not executed.`, 'key-sync-stalled');
    }
    if (Array.isArray(d.watchdogs) && d.watchdogs.length === 0) add('critical', 'governance', 'The contract has no watchdog.');
    if (d.signerAccessKeys === null) add('warning', 'governance', "The signer's access-key list couldn't be read.");
    const updater = new Set(arr(d.updaterKeys).filter((k): k is string => typeof k === 'string'));
    const keys = arr(d.signerAccessKeys).map((k) => obj(k) ?? {});
    for (const k of keys) {
      if (k.kind === 'full_access') add(isDevEnv(input.env) ? 'info' : 'critical', 'governance', `Full-access key ${str(k.publicKey)} on the signer${isDevEnv(input.env) ? ' (allowed on a dev env, D86 Q9)' : ''}.`);
      else if (k.updaterKey !== true) add('critical', 'governance', `Function-call key ${str(k.publicKey)} on the signer is not an updater key.`, 'updater-key-stolen');
      else if (k.updaterPermission !== true) add('critical', 'governance', `Updater key ${str(k.publicKey)} has the wrong permission (methods, receiver or allowance).`, 'updater-key-stolen');
    }
    if (Array.isArray(d.signerAccessKeys)) for (const pk of updater) if (!keys.some((k) => k.publicKey === pk)) add('warning', 'governance', `Updater key ${pk} is in get_governance but not on the signer account.`);
    const cron = obj(d.updater);
    for (const r of arr(cron?.lastRuns)) {
      const o = obj(r) ?? {};
      if (o.outcome !== 'ok') add('warning', 'governance', `The API's JWKS cron last run for ${str(o.provider)}: ${str(o.outcome)}${o.code ? ` (${str(o.code)})` : ''}.`);
    }
    for (const p of arr(cron?.proposals)) {
      const o = obj(p) ?? {};
      if (num(o.cancelledSeenAtMs) !== null) add('warning', 'governance', `A key proposal of the API's cron (${str(o.op)} ${str(o.kid)}) was cancelled.`, 'forged-key-change');
    }
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---- routes ----

type Settled<T> = { ok: true; value: T } | { ok: false; code: string };

async function rpc<T extends { ok: boolean }>(route: string, staff: StaffRequest, call: () => Promise<T>): Promise<Settled<Extract<T, { ok: true }>>> {
  try {
    const r = await call();
    if (!r.ok) {
      const code = (r as unknown as { code: string }).code;
      log({ event: 'bff', route, requestId: staff.requestId, outcome: 'rejected', code });
      return { ok: false, code };
    }
    return { ok: true, value: r as Extract<T, { ok: true }> };
  } catch (err) {
    log({ event: 'bff', route, requestId: staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return { ok: false, code: 'upstream_unavailable' };
  }
}

export async function monitoringRoute(env: Env, staff: StaffRequest, now = Date.now()): Promise<Response> {
  const ctx = staffCtx(staff);
  const [status, gov, events] = await Promise.all([
    callWatchdog(env, 'status', '/status', { requestId: staff.requestId }),
    rpc('GET /api/monitoring governance', staff, () => env.API.governance(ctx)),
    rpc('GET /api/monitoring events', staff, () => env.API.securityEvents({ ...ctx, unnotifiedOnly: false, limit: 100 })),
  ]);
  const watchdog: { ok: true; view: WatchdogStatusView } | { ok: false; code: ErrorCode } = !status.ok ? { ok: false, code: status.code } : status.status !== 200 ? { ok: false, code: 'watchdog_bad_answer' } : { ok: true, view: statusView(status.body, now, env.NEAR_NETWORK) };
  const governance = gov.ok ? { ok: true as const, data: gov.value.governance } : { ok: false as const, code: gov.code };
  return json(200, {
    now,
    env: env.ENV_NAME,
    watchdog: watchdog.ok ? { ok: true, ...watchdog.view } : { ok: false, code: watchdog.code },
    governance: governance.ok ? { ok: true, ...governanceView(governance.data, watchdog.ok ? watchdog.view : null) } : { ok: false, code: governance.code },
    events: events.ok ? { ok: true, events: events.value.events } : { ok: false, code: events.code },
    findings: findingsOf({ env: env.ENV_NAME, now, watchdog, governance }),
  });
}

const CURSOR_RE = /^[1-9]\d{0,11}$/u;

function pageQuery(url: URL, limit: number, extra: Record<string, string | null> = {}): string | null {
  const q = new URLSearchParams({ limit: String(limit) });
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null) {
    if (!CURSOR_RE.test(cursor)) return null;
    q.set('cursor', cursor);
  }
  for (const [k, v] of Object.entries(extra)) if (v !== null) q.set(k, v);
  return q.toString();
}

/** A watchdog answer as the BFF's: its failure code, or the body for a 200. */
function watchdogFailure(a: Awaited<ReturnType<typeof callWatchdog>>): Response | null {
  if (!a.ok) return errorResponse(a.code);
  if (a.status === 400) return errorResponse('bad_request');
  if (a.status === 404) return errorResponse('not_found');
  if (a.status !== 200) return errorResponse('watchdog_bad_answer');
  return null;
}

export async function alertsRoute(env: Env, staff: StaffRequest, url: URL): Promise<Response> {
  const severity = url.searchParams.get('severity');
  if (severity !== null && !SEVERITIES.includes(severity as Severity)) return errorResponse('bad_request', 'severity is critical, warning or info');
  const q = pageQuery(url, ALERTS_PAGE, { severity });
  if (!q) return errorResponse('bad_request', 'Bad cursor');
  // The registry's playbook ids come with /status; the alerts page resolves them from the package (the same mapping).
  const a = await callWatchdog(env, 'alerts', `/alerts?${q}`, { requestId: staff.requestId });
  const bad = watchdogFailure(a);
  if (bad || !a.ok) return bad!;
  const b = obj(a.body) ?? {};
  const next = num(b.next_cursor);
  return json(200, { alerts: arr(b.alerts).flatMap((x) => alertView(x) ?? []), nextCursor: next !== null && Number.isSafeInteger(next) && next > 0 ? next : null });
}

export async function actionsRoute(env: Env, staff: StaffRequest, url: URL): Promise<Response> {
  const q = pageQuery(url, ACTIONS_PAGE);
  if (!q) return errorResponse('bad_request', 'Bad cursor');
  const a = await callWatchdog(env, 'actions', `/actions?${q}`, { requestId: staff.requestId });
  const bad = watchdogFailure(a);
  if (bad || !a.ok) return bad!;
  const b = obj(a.body) ?? {};
  const next = num(b.next_cursor);
  return json(200, { actions: arr(b.actions).flatMap((x) => actionView(x, env.NEAR_NETWORK) ?? []), nextCursor: next !== null && Number.isSafeInteger(next) && next > 0 ? next : null });
}

/** The watchdog's `by` rule (apps/watchdog/src/status.ts BY_RE). */
const BY_RE = /^[\p{L}\p{N} ._@+:()-]{1,200}$/u;

/** Who acknowledged, as the watchdog records it: the Access email and subject, or the subject alone if the email can't be. */
export function ackBy(actor: StaffRequest['actor']): string | null {
  const full = `${actor.email} (access:${actor.id})`;
  if (BY_RE.test(full)) return full;
  const sub = `access:${actor.id}`;
  return BY_RE.test(sub) ? sub : null;
}

/**
 * Forwards an acknowledgement. It stops only that alert's re-sends: the watchdog keeps the condition, the first
 * delivery and its checks as they are. A second ack is 409 `already_acknowledged` (the first is kept).
 */
export async function ackRoute(env: Env, staff: StaffRequest, id: string): Promise<Response> {
  if (!CURSOR_RE.test(id)) return errorResponse('not_found');
  const by = ackBy(staff.actor);
  if (!by) return errorResponse('bad_request', 'This Access identity cannot be recorded as the acknowledger');
  const a = await callWatchdog(env, 'ack', `/alerts/${id}/ack`, { method: 'POST', body: { by }, requestId: staff.requestId });
  if (!a.ok) return errorResponse(a.code);
  const b = obj(a.body) ?? {};
  const alert = alertView(b.alert);
  log({ event: 'watchdog_ack', requestId: staff.requestId, target: `alert:${id}`, outcome: a.status === 200 ? 'ok' : 'rejected', status: a.status });
  if (a.status === 200 && alert) return json(200, { alert });
  if (a.status === 409) return json(409, { error: { code: 'already_acknowledged', message: 'This alert was acknowledged already' }, ...(alert ? { alert } : {}) });
  if (a.status === 404) return errorResponse('not_found', 'No such alert');
  if (a.status === 400) return errorResponse('bad_request');
  return errorResponse('watchdog_bad_answer');
}

export async function pendingUpgradesRoute(env: Env, staff: StaffRequest): Promise<Response> {
  const r = await rpc('GET /api/governance/pending-upgrades', staff, () => env.API.pendingUpgrades(staffCtx(staff)));
  if (!r.ok) return errorResponse(r.code as ErrorCode);
  return json(200, { pendingUpgrades: r.value.pendingUpgrades });
}
