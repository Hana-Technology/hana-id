// One watchdog run (every 5 min): docs/governance-spec.md "Watchdog service" steps 1–8, with the actions exactly as
// D82 allows them. On its own the watchdog only:
//   - cancels a pending issuer key Google doesn't publish (absent from two fetches ≥ 60 s apart) or publishes with
//     other key material, and then deletes every updater key if the updater (the signer account) proposed it;
//   - cancels any pending change the updater proposed for a provider other than Google (the updater only serves
//     Google, so its key is stolen), and deletes every updater key;
//   - pauses the contract, and only when a key Google doesn't publish is ACTIVE on chain (never at its first run),
//     and deletes every updater key (whoever proposed it: by then the change record is gone, and only the updater
//     or the owner can post keys; a needless deletion costs one council vote in a recovery that needs one anyway);
//   - confirms pending changes that match Google's JWKS (D86);
//   - for the email issuer (self-issued, D121; docs/email-login-spec.md "Watchdog"): cancels a pending key whose
//     thumbprint isn't pinned for its signer (never confirms one: self-issued keys wait their delay), pauses on an
//     active email key that isn't pinned (and deletes every updater key, as for Google), and pauses when the chain's
//     signer policy is weaker than the pins.
// Everything else is an alert (D85), the relayer's funds included: the watchdog reads the relayer account's balance and
// its pool keys' allowances and never tops anything up (it holds no key on that account). Dependencies are injected
// so every path is tested against stubs.
import { GOOGLE_PROVIDER, type Jwk, rsaThumbprint, sameRsaKey } from '@hana-id/jwks';
import { type DeliveryReport, deliverAlerts } from './alerts.ts';
import type { ChainReader, ChainSnapshot, ChainWriter, KeyChange, WatchdogMethod } from './chain.ts';
import type { Notifier } from './channels.ts';
import { ALERT_KINDS, type AlertKind, CHANNELS, CHECK_IDS, type CheckId } from './checks.ts';
import { maybeSendDigest } from './digest.ts';
import { diffChain, type StoredSnapshot } from './diff.ts';
import { type LinkEventSource, NEW_LINK_EVENTS } from './links.ts';
import { log } from './log.ts';
import { EMAIL_KEY_WHY, EMAIL_PROVIDER, type EmailKeyReason, emailKeyVerdict, pinnedSignersOf, policyFindings, policyId, type SignerPins, signerOfKid } from './pins.ts';
import { formatNear, level, RELAYER_POOLS, type RelayerFunds, type RelayerThresholds, type Threshold } from './relayer.ts';
import { ident } from './sanitize.ts';
import { iso } from './time.ts';
import type { CheckResult, SeenKid, Store } from './store.ts';

/** A kid with a pending change counts as not published once absent from two fetches at least this far apart. */
export const ABSENCE_RECHECK_MS = 60_000;
/**
 * A pending Add of a kid Google doesn't publish now, but did publish with the same key material within this window,
 * is a race with Google's key retirement (the API cron's fetch still listed it), not a forgery (D153).
 */
export const RETIRED_KEY_GRACE_MS = 24 * 60 * 60_000;
/** An active kid Google stopped publishing longer ago than this is stale (warning). */
export const STALE_ACTIVE_KID_MS = 3 * 60 * 60_000;
/** A change executable for longer than this that nobody executed (warning). */
export const UNEXECUTED_AFTER_MS = 60 * 60_000;
/** RPC or JWKS failures in a row before a warning. */
export const FAILING_RUNS = 3;
/** Link events are kept this long in D1 (the volume check looks at the last hour). */
export const LINK_EVENT_RETENTION_MS = 8 * 24 * 60 * 60_000;
/** The link-volume window. */
export const LINK_WINDOW_MS = 60 * 60_000;
/** A link scan further behind the chain than this can't see a burst in time (warning). */
export const LINK_SCAN_BEHIND_MS = 60 * 60_000;
/** A run lock older than this is taken over (a run that died without releasing it). */
export const LOCK_STALE_MS = 10 * 60_000;
/**
 * Panics that mean the target is already gone (another run or the owner got there first). Delete: the key is no
 * longer tracked, not a failed protection. Cancel: the change left the queue, but possibly because it was executed:
 * the run re-reads the chain to tell (`cancelOutcome`).
 */
const ALREADY_DONE = /No such key change|Not an updater key/u;
const CHANGE_GONE = /No such key change/u;

export interface RunConfig {
  envName: string;
  network: string;
  signer: string;
  watchdogAccount: string;
  digestHourUtc: number;
  /** The relayer account to monitor (null: not configured, the `relayer_funds` check is skipped). */
  relayer: string | null;
  /** Thresholds, and any problem reading the configured ones (shown in the `config` check). */
  relayerThresholds: { thresholds: RelayerThresholds; problems: string[] };
  /** The manifest's `watchdog.pinnedIssuerKeys.email` (`pins: null`: nothing pinned), and any problem reading it. */
  emailPins: { pins: SignerPins | null; problems: string[] };
  /** A dev env (`local*`, `sandbox*`): `unrecorded_wallets` may be true there (D139). */
  devEnv: boolean;
  /** New links per hour above which the link-volume check warns. */
  linkVolume: { thresholds: { perHour: number; perScopePerHour: number }; problems: string[] };
}

export interface RunDeps {
  store: Store;
  chain: ChainReader;
  /** Null when WATCHDOG_KEY is missing or malformed: the watchdog then alerts but can't act. */
  writer: ChainWriter | null;
  /** Google's usable RS256 keys, fetched with no cache. Throws when the fetch fails or lists no usable key. */
  fetchJwks: () => Promise<Jwk[]>;
  /** Hana's published email JWKS (usable RS256 keys; may be empty), or null when no URL is configured. Throws on failure. */
  fetchEmailJwks: (() => Promise<Jwk[]>) | null;
  /** The link-volume check's event source (the indexer), or null when none is configured. */
  linkEvents: LinkEventSource | null;
  notifier: Notifier;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  config: RunConfig;
}

export interface ActionSummary {
  id: number;
  method: WatchdogMethod;
  args: Record<string, unknown>;
  ok: boolean;
  txHash: string | null;
  error: string | null;
}

export interface RunReport {
  runId: number;
  outcome: 'ok' | 'degraded' | 'error';
  firstRun: boolean;
  checks: CheckResult[];
  actions: ActionSummary[];
  alerts: { id: number; kind: AlertKind; key: string }[];
  delivery: DeliveryReport | null;
}

/** Meta keys in D1. */
export const META = {
  initializedAt: 'initialized_at',
  snapshot: 'snapshot',
  selfChanges: 'self_changes',
  rpcFailures: 'rpc_failures',
  jwksFailures: 'jwks_failures',
  heartbeat: 'heartbeat',
  digest: 'digest',
  /** The last relayer reading with the thresholds it was judged against (`GET /status` `relayer_funds`). */
  relayerFunds: 'relayer_funds',
  emailJwksFailures: 'email_jwks_failures',
  /** The link scan's cursor and last result (`GET /status` `link_volume`). */
  linkScan: 'link_scan',
  /** The pins and the chain's email issuer at the last run (`GET /status` `email`). */
  emailPolicy: 'email_policy',
} as const;

/** What `GET /status` serves as `link_volume`. */
export interface LinkScanState {
  /** Last block height scanned (null: the next scan starts at the chain's head). */
  cursor: number | null;
  failures: number;
  at: number | null;
  latest_height: number | null;
  behind_ms: number | null;
  /** The last hour: new links in all and per scope, and every link event by name. */
  last_hour: { new_links: number; by_scope: Record<string, number>; by_event: Record<string, number> } | null;
  thresholds: { perHour: number; perScopePerHour: number };
}

/** What `GET /status` serves as `email`: the pins in force and the chain's email issuer at the last run. */
export interface EmailPolicyStatus {
  at: number;
  pinned: SignerPins | null;
  chain: { issuer: boolean; pre_v3: boolean; self_issued: { signers: { id: string; kids: string[] }[]; required: number; overlap_until_ms: number | null } | null; active_kids: string[] };
  differences: string[];
  weaker: string[];
}

/** What `GET /status` serves as `relayer_funds`: the last reading, when, and the thresholds (yocto strings). */
export interface RelayerFundsStatus extends RelayerFunds {
  at: number;
  thresholds: Record<keyof RelayerThresholds, { warn: string; critical: string }>;
}

export interface HeartbeatState {
  last_ping_at: number | null;
  last_ok_at: number | null;
  ok: boolean;
  failures: number;
}

/** What the watchdog changed itself in a run, so the next run's governance diff doesn't alert on it twice. */
export interface SelfChanges {
  paused: boolean;
  deletedUpdaterKeys: string[];
}

class Run {
  readonly checks = new Map<CheckId, CheckResult>();
  /**
   * Condition kinds whose state this run evaluated: their open alerts not raised again are resolved. `all`, or key
   * prefixes when only part of a kind was judged (e.g. the email half of `forged_active_key` without Google's JWKS).
   */
  readonly evaluated = new Map<AlertKind, 'all' | string[]>();
  readonly raisedKeys = new Set<string>();
  readonly actions: ActionSummary[] = [];
  readonly alerts: { id: number; kind: AlertKind; key: string }[] = [];

  constructor(
    readonly d: RunDeps,
    readonly id: number,
  ) {}

  check(id: CheckId, outcome: CheckResult['outcome'], detail?: string): void {
    const prev = this.checks.get(id);
    // An alert outcome sticks (over ok and skipped); details accumulate.
    const merged: CheckResult = { id, outcome: prev?.outcome === 'alert' && (outcome === 'ok' || outcome === 'skipped') ? 'alert' : outcome };
    const text = [prev?.detail, detail].filter(Boolean).join('; ');
    if (text) merged.detail = text.slice(0, 1000);
    this.checks.set(id, merged);
  }

  evaluate(...kinds: AlertKind[]): void {
    for (const k of kinds) this.evaluated.set(k, 'all');
  }

  /** Only the alerts of `kind` whose key starts with `prefix` were judged. */
  evaluatePrefix(kind: AlertKind, prefix: string): void {
    const cur = this.evaluated.get(kind);
    if (cur === 'all') return;
    this.evaluated.set(kind, [...(cur ?? []), prefix]);
  }

  /** A condition alert: raised once while its condition holds (resolved by a later run that no longer sees it). */
  async condition(kind: AlertKind, key: string, title: string, details: Record<string, unknown>): Promise<{ id: number; isNew: boolean }> {
    this.raisedKeys.add(key);
    this.check(ALERT_KINDS[kind].check, 'alert');
    const open = await this.d.store.openAlert(key);
    if (open) return { id: open.id, isNew: false };
    return { id: await this.create(kind, key, title, details, true), isNew: true };
  }

  /** An event alert: raised once ever for its key. */
  async event(kind: AlertKind, key: string, title: string, details: Record<string, unknown>): Promise<{ id: number; isNew: boolean } | null> {
    if (ALERT_KINDS[kind].severity !== 'info') this.check(ALERT_KINDS[kind].check, 'alert');
    if (await this.d.store.alertExists(key)) return null;
    return { id: await this.create(kind, key, title, details, false), isNew: true };
  }

  private async create(kind: AlertKind, key: string, title: string, details: Record<string, unknown>, condition: boolean): Promise<number> {
    const severity = ALERT_KINDS[kind].severity;
    const id = await this.d.store.createAlert({ key, kind, title, details, runId: this.id, at: this.d.now(), condition, channels: CHANNELS[severity] });
    this.alerts.push({ id, kind, key });
    log({ event: 'alert_raised', alertId: id, severity, code: kind, runId: this.id }, severity === 'critical' ? 'error' : severity === 'warning' ? 'warn' : 'info');
    return id;
  }

  async act(method: WatchdogMethod, args: Record<string, unknown>, reason: string): Promise<ActionSummary> {
    const at = this.d.now();
    const result = this.d.writer ? await this.d.writer.call(method, args) : { ok: false as const, txHash: null, error: 'no watchdog key' };
    const error = result.ok ? null : result.error;
    const id = await this.d.store.recordAction({ run_id: this.id, at, method, args, reason, ok: result.ok, tx_hash: result.txHash, error });
    const summary: ActionSummary = { id, method, args, ok: result.ok, txHash: result.txHash, error };
    this.actions.push(summary);
    return summary;
  }
}

const actionDetail = (a: ActionSummary) => ({ action: a.id, method: a.method, args: a.args, ok: a.ok, tx: a.txHash, ...(a.error ? { error: a.error } : {}) });

export async function runWatchdog(d: RunDeps): Promise<RunReport> {
  const { store, config: cfg } = d;
  const startedAt = d.now();
  const runId = await store.startRun(startedAt);
  const run = new Run(d, runId);
  let outcome: RunReport['outcome'] = 'ok';
  let firstRun = false;
  let delivery: DeliveryReport | null = null;
  if (!(await store.acquireLock(runId, startedAt, LOCK_STALE_MS))) {
    // Another run is still going (a slow one overlaps the next cron tick): it does the work, and the heartbeat.
    const checks = CHECK_IDS.map((id) => ({ id, outcome: 'skipped' as const, detail: 'another run in progress' }));
    await store.finishRun(runId, d.now(), 'degraded', false, checks);
    log({ event: 'run', runId, outcome: 'skipped', code: 'locked' }, 'warn');
    return { runId, outcome: 'degraded', firstRun: false, checks, actions: [], alerts: [], delivery: null };
  }
  try {
    const initialized = (await store.getMeta<number>(META.initializedAt)) !== null;

    // ---- config ----
    run.evaluate('watchdog_key_missing', 'channel_not_configured');
    run.check('config', 'ok', [...cfg.relayerThresholds.problems, ...cfg.emailPins.problems, ...cfg.linkVolume.problems].join('; ') || undefined);
    if (!d.writer) await run.condition('watchdog_key_missing', 'watchdog_key_missing', 'The watchdog has no usable key: it can alert but not act', { account: cfg.watchdogAccount });
    const channels = { pager: d.notifier.pager.configured, slack: d.notifier.slack.configured, email: d.notifier.email.configured, heartbeat: d.notifier.heartbeat.configured };
    for (const [name, ok] of Object.entries(channels)) {
      if (!ok) await run.condition('channel_not_configured', `channel_not_configured:${name}`, `Alert channel not configured: ${name}`, { channel: name });
    }

    // ---- step 2: the chain, through its own RPC ----
    let snap: ChainSnapshot | null = null;
    let networkOk = false;
    {
      let chainId: string | null = null;
      let failures = (await store.getMeta<number>(META.rpcFailures)) ?? 0;
      try {
        chainId = await d.chain.chainId();
        const s = await d.chain.snapshot();
        failures = 0;
        run.evaluate('wrong_network');
        if (chainId !== cfg.network) {
          await run.condition('wrong_network', 'wrong_network', `The RPC is on ${chainId ? ident(chainId) : 'an unknown chain'}, not ${cfg.network}: nothing is sent`, { chain_id: chainId, expected: cfg.network });
        } else {
          snap = s;
          networkOk = true;
          run.check('chain_read', 'ok');
        }
      } catch {
        failures++;
        run.check('chain_read', 'error', `chain read failed (${failures} run(s) in a row)`);
        log({ event: 'chain_read', outcome: 'error', runId }, 'warn');
      }
      await store.setMeta(META.rpcFailures, failures);
      run.evaluate('rpc_failing');
      if (failures >= FAILING_RUNS) await run.condition('rpc_failing', 'rpc_failing', `Chain reads failed ${failures} runs in a row`, { failures });
    }

    // ---- step 1: Google's JWKS ----
    // The latest successful fetch (a second one may follow the 60 s absence re-check).
    const google: { jwks: Map<string, Jwk> | null; at: number } = { jwks: null, at: 0 };
    const fetchGoogle = async (): Promise<boolean> => {
      try {
        const keys = await d.fetchJwks();
        if (keys.length === 0) throw new Error('empty');
        google.at = d.now();
        await store.recordJwks(GOOGLE_PROVIDER, keys, google.at);
        google.jwks = new Map(keys.map((k) => [k.kid, k]));
        return true;
      } catch {
        return false;
      }
    };
    {
      let failures = (await store.getMeta<number>(META.jwksFailures)) ?? 0;
      if (await fetchGoogle()) {
        failures = 0;
        run.check('jwks_fetch', 'ok');
      } else {
        failures++;
        run.check('jwks_fetch', 'error', `JWKS fetch failed (${failures} run(s) in a row)`);
        log({ event: 'jwks_fetch', outcome: 'error', runId }, 'warn');
      }
      await store.setMeta(META.jwksFailures, failures);
      run.evaluate('jwks_failing');
      if (failures >= FAILING_RUNS) await run.condition('jwks_failing', 'jwks_failing', `Google's JWKS fetch failed ${failures} runs in a row`, { failures });
    }

    const prev = await store.getMeta<StoredSnapshot>(META.snapshot);
    const selfPrev = (await store.getMeta<SelfChanges>(META.selfChanges)) ?? { paused: false, deletedUpdaterKeys: [] };
    const self: SelfChanges = { paused: false, deletedUpdaterKeys: [] };
    const settled = new Set<number>(); // change ids cancelled or confirmed by this run
    const deleted = new Set<string>(); // updater keys deleted (or found gone) by this run
    let linksRead = true;

    // ---- watchdog role ----
    let canAct = false;
    let canConfirm = false;
    if (snap) {
      run.evaluate('not_a_watchdog');
      const role = snap.governance.watchdogs.find((w) => w.account_id === cfg.watchdogAccount);
      if (!role) {
        await run.condition('not_a_watchdog', 'not_a_watchdog', `${cfg.watchdogAccount} is not a watchdog of ${cfg.signer}: it can't cancel or pause`, {
          account: cfg.watchdogAccount,
          watchdogs: snap.governance.watchdogs.map((w) => w.account_id),
        });
      }
      canAct = !!role && !!d.writer && networkOk;
      canConfirm = canAct && !!role && role.confirm_from_ms <= d.now();
      run.check('watchdog_role', role ? 'ok' : 'alert', role ? (canConfirm ? 'may cancel, pause and confirm' : `may cancel and pause; confirms from ${iso(role.confirm_from_ms)}`) : 'not a watchdog');

      // ---- the email issuer (self-issued): judged against the pins, so it needs no Google JWKS ----
      await emailPendingChanges(run, snap, canAct, settled, deleted, self);
      await emailActiveKeys(run, snap, canAct, self, deleted);
      await signerPolicy(run, snap, canAct, self);
      await emailJwks(run, snap);
    }

    const firstJwks = google.jwks;
    const complete = snap !== null && firstJwks !== null;
    if (snap && firstJwks) {
      const s: ChainSnapshot = snap;
      firstRun = !initialized;

      // ---- steps 3–4: pending key changes ----
      run.evaluate('published_key_removal', 'unverifiable_key_change');
      run.check('pending_key_changes', 'ok', `${s.keyChanges.length} pending`);
      const pending = s.keyChanges.filter((c) => c.provider === GOOGLE_PROVIDER);
      for (const c of s.keyChanges.filter((c) => c.provider !== GOOGLE_PROVIDER && c.provider !== EMAIL_PROVIDER)) {
        if (c.by === cfg.signer) {
          // The updater (the API's key on the signer account) only serves Google: any other provider's change from
          // it means the key is stolen. Cancelled like a forged Google key, and the updater keys deleted.
          await forgedPending(run, s, c, 'updater_other_provider', null, canAct, settled, deleted, self);
          continue;
        }
        await run.condition('unverifiable_key_change', `unverifiable_key_change:${c.id}`, `Pending ${ident(c.op)} of ${ident(c.provider)} key ${ident(c.kid)}: no JWKS known for ${ident(c.provider)} (alert only)`, changeDetails(c));
      }
      let jwksNow: Map<string, Jwk> = firstJwks;
      const absent = await trackAbsences(store, pending, jwksNow, google.at);
      if (pending.some((c) => !jwksNow.has(c.kid) && !absent.has(c.kid))) {
        // A pending kid is missing from this fetch: look again after 60 s before calling it unpublished.
        await d.sleep(ABSENCE_RECHECK_MS);
        if ((await fetchGoogle()) && google.jwks) {
          jwksNow = google.jwks;
          for (const kid of await trackAbsences(store, pending, jwksNow, google.at)) absent.add(kid);
          for (const kid of [...absent]) if (jwksNow.has(kid)) absent.delete(kid);
        }
      }

      // Read for D153 only. A failed read must not hold back a cancel: without it every unpublished Add is forged.
      const seen = await store.seenKids(GOOGLE_PROVIDER).catch(() => {
        log({ event: 'seen_kids_read_failed', runId }, 'error');
        return new Map<string, SeenKid>();
      });
      for (const c of pending) {
        const jwk = jwksNow.get(c.kid);
        if (c.op === 'Add') {
          if (jwk && c.n && c.e && sameRsaKey({ n: c.n, e: c.e }, jwk)) {
            if (canConfirm) await confirm(run, c, settled);
            continue;
          }
          const reason = jwk ? 'other_key_material' : absent.has(c.kid) ? 'not_published' : null;
          if (!reason) {
            run.check('pending_key_changes', 'ok', `${ident(c.kid)} absent once, rechecking next run`);
            continue;
          }
          const lastSeen = reason === 'not_published' && c.by === cfg.signer ? retiredAt(seen.get(c.kid), c, d.now()) : null;
          if (lastSeen !== null) {
            await retiredPending(run, c, lastSeen, canAct, settled);
            continue;
          }
          await forgedPending(run, s, c, reason, jwk ?? null, canAct, settled, deleted, self);
        } else if (jwk) {
          await run.condition('published_key_removal', `published_key_removal:${c.id}`, `Pending removal of ${ident(c.kid)}, which Google still publishes (alert only: the owner decides)`, changeDetails(c));
        } else if (absent.has(c.kid) && canConfirm) {
          await confirm(run, c, settled);
        }
      }

      // ---- step 5: active keys ----
      run.evaluate('forged_active_key', 'stale_active_key', 'active_key_material_unavailable');
      await checkActiveKeys(run, s, jwksNow, firstRun, canAct, self, deleted);
      if (firstRun) {
        await run.event('first_run', 'first_run', 'First run: the current JWKS is recorded as known', { kids: [...jwksNow.keys()], active: s.issuer?.kids ?? [] });
        await store.setMeta(META.initializedAt, d.now());
      }
      run.evaluate('protective_action_failed');
    } else {
      for (const id of ['pending_key_changes', 'active_keys'] as const) run.check(id, 'skipped', snap ? 'no JWKS' : 'no chain read');
    }

    if (snap) {
      const s: ChainSnapshot = snap;
      // Changes that left the queue since the last run (by others: executed after the delay, cancelled by the owner).
      await queueExits(run, prev, s);

      // ---- step 6: governance diff (alert only) ----
      run.check('governance_diff', 'ok');
      const diff = diffChain(prev, s, d.now(), selfPrev);
      if (diff.critical.length) {
        await run.event('governance_change', `governance_change:${runId}`, `Governance change: ${diff.critical.map((c) => c.field).join(', ')}`, { changes: diff.critical });
      }
      if (diff.warning.length) await run.event('config_change', `config_change:${runId}`, `Config change: ${diff.warning.map((c) => c.field).join(', ')}`, { changes: diff.warning });
      if (diff.matured.length) await run.event('config_matured', `config_matured:${runId}`, `Scheduled change in force: ${diff.matured.map((c) => c.field).join(', ')}`, { changes: diff.matured });

      // ---- matured key changes nobody executed ----
      run.evaluate('unexecuted_key_change');
      run.check('unexecuted_changes', 'ok');
      for (const c of s.keyChanges) {
        if (settled.has(c.id) || d.now() - c.executable_at_ms <= UNEXECUTED_AFTER_MS) continue;
        await run.condition('unexecuted_key_change', `unexecuted_key_change:${c.id}`, `Key change ${c.id} (${ident(c.op)} ${ident(c.kid)}) executable since ${iso(c.executable_at_ms)} and not executed`, changeDetails(c));
      }

      // ---- links: identity_link_* volume, and D139's unrecorded_wallets ----
      linksRead = await checkLinks(run, s);

      await store.setMeta(META.snapshot, {
        at: d.now(),
        config: s.config,
        governance: s.governance,
        keyChanges: s.keyChanges,
        owner: s.owner,
        issuer: s.issuer,
        email: { issuer: s.email.issuer, selfIssued: s.email.selfIssued },
      } satisfies StoredSnapshot);
      await store.setMeta(META.selfChanges, self);
    } else {
      for (const id of ['signer_policy', 'email_jwks', 'governance_diff', 'unexecuted_changes', 'links'] as const) run.check(id, 'skipped', 'no chain read');
    }
    // ---- relayer funds (alert only) ----
    let relayerRead = true;
    if (!networkOk) run.check('relayer_funds', 'skipped', 'no chain read');
    else if (!cfg.relayer) run.check('relayer_funds', 'skipped', 'RELAYER_ACCOUNT not set');
    else relayerRead = await checkRelayerFunds(run, cfg.relayer, cfg.relayerThresholds.thresholds);
    if (!complete || !relayerRead || !linksRead) outcome = 'degraded';

    // ---- alerts out (first deliveries, re-sends, pager acks) ----
    delivery = await deliverAlerts(store, d.notifier, d.now(), cfg.envName);
    run.check('alert_delivery', delivery.failed ? 'error' : 'ok', `${delivery.first} first, ${delivery.resent} re-sent, ${delivery.failed} failed, ${delivery.ackedByPager} acked in the paging app`);
    const digest = await maybeSendDigest(store, d.notifier, d.now(), cfg.digestHourUtc, cfg.envName);
    run.check('digest', digest === 'failed' ? 'error' : digest === 'sent' ? 'ok' : 'skipped', digest);

    // ---- step 7: dead-man's switch ----
    await heartbeat(run);
  } catch (err) {
    outcome = 'error';
    log({ event: 'run_failed', runId, code: err instanceof Error ? err.name : 'error' }, 'error');
    // Whatever was raised before the failure still goes out (a run that always fails at the same later step must
    // not hold back a forgery alert). No heartbeat: the dead-man's switch then pages on its own.
    if (delivery === null) {
      try {
        delivery = await deliverAlerts(store, d.notifier, d.now(), cfg.envName);
        run.check('alert_delivery', delivery.failed ? 'error' : 'ok', 'delivered after a failed run');
      } catch {
        log({ event: 'alert_delivery', outcome: 'error', runId, code: 'after_run_failure' }, 'error');
      }
    }
  }

  // ---- step 8: record the run ----
  const checks = CHECK_IDS.map((id) => run.checks.get(id) ?? { id, outcome: 'skipped' as const });
  try {
    // A failed run may have stopped half-way through a check: resolve nothing on its say-so.
    if (outcome !== 'error') await store.resolveConditions(run.evaluated, run.raisedKeys, d.now());
    await store.finishRun(runId, d.now(), outcome, firstRun, checks);
    await store.pruneRuns(d.now());
  } catch {
    log({ event: 'run_record_failed', runId }, 'error');
  }
  await store.releaseLock(runId).catch(() => log({ event: 'run_lock_release_failed', runId }, 'error'));
  log({ event: 'run', runId, outcome: outcome === 'error' ? 'error' : 'ok', code: outcome, checks: checks.length, actions: run.actions.length, alerts: run.alerts.length, latencyMs: d.now() - startedAt });
  return { runId, outcome, firstRun, checks, actions: run.actions, alerts: run.alerts, delivery };
}

function changeDetails(c: KeyChange): Record<string, unknown> {
  return {
    id: c.id,
    provider: c.provider,
    kid: c.kid,
    op: c.op,
    by: c.by,
    proposed_at_ms: c.proposed_at_ms,
    executable_at_ms: c.executable_at_ms,
    ...(c.n ? { n: c.n, e: c.e } : {}),
    ...(c.signer !== undefined ? { signer: c.signer } : {}),
  };
}

/**
 * Records this fetch's absences of pending kids (the first absence per kid is kept), clears kids that are listed or
 * no longer pending, and returns the kids absent now and also at a fetch at least ABSENCE_RECHECK_MS earlier.
 */
async function trackAbsences(store: Store, pending: KeyChange[], jwks: Map<string, Jwk>, fetchAt: number): Promise<Set<string>> {
  const pendingKids = new Set(pending.map((c) => c.kid));
  const known = await store.absences(GOOGLE_PROVIDER);
  for (const kid of known.keys()) if (!pendingKids.has(kid) || jwks.has(kid)) await store.clearAbsent(GOOGLE_PROVIDER, kid);
  const absent = new Set<string>();
  for (const kid of pendingKids) {
    if (jwks.has(kid)) continue;
    const first = known.get(kid);
    if (first === undefined) await store.recordAbsent(GOOGLE_PROVIDER, kid, fetchAt);
    else if (fetchAt - first >= ABSENCE_RECHECK_MS) absent.add(kid);
  }
  return absent;
}

async function confirm(run: Run, c: KeyChange, settled: Set<number>): Promise<void> {
  const a = await run.act('confirm_issuer_key_change', { id: c.id }, c.op === 'Add' ? `${ident(c.kid)} matches Google's JWKS` : `${ident(c.kid)} is no longer in Google's JWKS`);
  if (a.ok) {
    settled.add(c.id);
    await run.event('key_change_confirmed', `confirmed:${c.id}`, `Confirmed ${c.op === 'Add' ? 'new key' : 'removal of'} ${ident(c.kid)} (change ${c.id})`, { ...changeDetails(c), ...actionDetail(a) });
  } else {
    await run.event('confirm_failed', `confirm_failed:${a.id}`, `Confirming change ${c.id} (${ident(c.op)} ${ident(c.kid)}) failed`, { ...changeDetails(c), ...actionDetail(a) });
  }
}

/**
 * When Google last published this Add's kid with the same key material, if within RETIRED_KEY_GRACE_MS of `now`
 * (D153); null otherwise. Only kids the watchdog fetched itself count, not first-run baseline kids.
 */
export function retiredAt(s: SeenKid | undefined, c: KeyChange, now: number): number | null {
  if (!s || s.source !== 'jwks' || s.last_seen_at === null || !s.n || !s.e || !c.n || !c.e) return null;
  if (now - s.last_seen_at > RETIRED_KEY_GRACE_MS) return null;
  return sameRsaKey({ n: c.n, e: c.e }, { n: s.n, e: s.e }) ? s.last_seen_at : null;
}

/**
 * D153: the updater proposed a key Google published, with this material, until recently. The API cron's fetch raced
 * Google's retirement of the kid. Cancelled (a retired key has no use), the updater keys kept, one warning.
 */
async function retiredPending(run: Run, c: KeyChange, lastSeen: number, canAct: boolean, settled: Set<number>): Promise<void> {
  let outcome: 'cancelled' | 'gone' | 'failed' | 'not_sent' = 'not_sent';
  let cancel: ActionSummary | null = null;
  if (canAct) {
    cancel = await run.act('cancel_issuer_key_change', { id: c.id }, `${ident(c.kid)}: retired by Google`);
    outcome = cancel.ok ? 'cancelled' : CHANGE_GONE.test(cancel.error ?? '') ? 'gone' : 'failed';
    if (outcome !== 'failed') settled.add(c.id);
  }
  const what = { cancelled: 'cancelled', gone: 'already gone from the queue', failed: 'the cancel failed (retried next run)', not_sent: 'the watchdog could not act' }[outcome];
  await run.event('retired_key_change', `retired_key_change:${c.id}`, `Retired Google key ${ident(c.kid)} proposed (change ${c.id}): Google stopped publishing it after ${iso(lastSeen)}; ${what}, updater key kept`, {
    ...changeDetails(c),
    last_seen_jwks_at: lastSeen,
    outcome,
    actions: cancel ? [actionDetail(cancel)] : [],
  });
}

/** Why a pending change is treated as forged and cancelled (Google: the first two; email: `EmailKeyReason`). */
export type ForgedReason = 'other_key_material' | 'not_published' | 'updater_other_provider' | EmailKeyReason;

/**
 * What became of a forged change after the cancel: `cancelled` by this run; `gone` from the queue without taking
 * effect (the owner or another watchdog cancelled it first); `executed` before the cancel landed (it took effect: the
 * protection failed); `unknown` (the cancel said it was gone, and the re-read failed or still lists it); `failed` (the
 * cancel failed for another reason, the change is still pending); `not_sent` (the watchdog can't act).
 */
export type CancelOutcome = 'cancelled' | 'gone' | 'executed' | 'unknown' | 'failed' | 'not_sent';

/**
 * A cancel that panicked `No such key change` doesn't say why the change left the queue: re-reads the chain and tells
 * a cancel by someone else (`gone`) from an execution (`executed`: an Add's kid is active, a Remove's kid isn't).
 * Returns the fresh snapshot too, so the run judges the active keys on what is on chain now.
 */
async function cancelOutcome(run: Run, c: KeyChange): Promise<{ outcome: 'gone' | 'executed' | 'unknown'; fresh: ChainSnapshot | null }> {
  let fresh: ChainSnapshot | null = null;
  try {
    fresh = await run.d.chain.snapshot();
  } catch {
    return { outcome: 'unknown', fresh: null };
  }
  const issuer = c.provider === EMAIL_PROVIDER ? fresh.email.issuer : c.provider === GOOGLE_PROVIDER ? fresh.issuer : null;
  if (fresh.keyChanges.some((x) => x.id === c.id) || !issuer) return { outcome: 'unknown', fresh };
  const active = issuer.kids.includes(c.kid);
  return { outcome: (c.op === 'Add' ? active : !active) ? 'executed' : 'gone', fresh };
}

const FORGED_WHY: Record<ForgedReason, string> = {
  not_published: "Google doesn't publish it",
  other_key_material: 'Google publishes other key material for it',
  updater_other_provider: 'the updater only serves Google, so its key is stolen',
  ...EMAIL_KEY_WHY,
};

const OUTCOME_TEXT: Record<CancelOutcome, string> = {
  cancelled: 'cancelled',
  gone: 'already gone from the queue without taking effect',
  executed: 'EXECUTED before the watchdog could cancel it',
  unknown: 'the cancel found it gone and the re-read could not tell whether it was executed',
  failed: 'the cancel failed',
  not_sent: 'the watchdog could not act',
};

/**
 * D82: cancel, then delete every updater key if the updater proposed it, then one critical alert with the results.
 * The title says what actually happened (never "cancelled" unless this run's cancel went through).
 */
async function forgedPending(
  run: Run,
  s: ChainSnapshot,
  c: KeyChange,
  reason: ForgedReason,
  jwk: Jwk | null,
  canAct: boolean,
  settled: Set<number>,
  deleted: Set<string>,
  self: SelfChanges,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const signer = run.d.config.signer;
  const actions: ActionSummary[] = [];
  let outcome: CancelOutcome = 'not_sent';
  if (canAct) {
    const cancel = await run.act('cancel_issuer_key_change', { id: c.id }, `${ident(c.kid)}: ${reason}`);
    actions.push(cancel);
    if (cancel.ok) outcome = 'cancelled';
    else if (CHANGE_GONE.test(cancel.error ?? '')) {
      const r = await cancelOutcome(run, c);
      outcome = r.outcome;
      // An executed forged key is active now: let the active-key check see it in this run (it pauses, D82).
      if (r.outcome === 'executed' && r.fresh && c.provider === GOOGLE_PROVIDER) {
        s.issuer = r.fresh.issuer;
        s.issuerKeys = r.fresh.issuerKeys;
      }
      if (r.outcome === 'executed' && r.fresh && c.provider === EMAIL_PROVIDER) s.email = r.fresh.email;
    } else outcome = 'failed';
    if (outcome !== 'failed') settled.add(c.id);
    if (outcome === 'failed' || outcome === 'executed' || outcome === 'unknown') {
      const what =
        outcome === 'failed'
          ? `Cancelling forged key change ${c.id} (${ident(c.kid)}) failed`
          : outcome === 'executed'
            ? `Forged key change ${c.id} (${ident(c.op)} ${ident(c.provider)} ${ident(c.kid)}) was executed before the watchdog could cancel it`
            : `Forged key change ${c.id} (${ident(c.kid)}) left the queue and the watchdog could not tell whether it was executed`;
      await run.condition('protective_action_failed', `protective_action_failed:cancel:${c.id}`, what, { ...changeDetails(c), outcome, ...actionDetail(cancel) });
    }
    if (c.by === signer) actions.push(...(await deleteUpdaterKeys(run, s, deleted, self, `the updater proposed forged key change ${c.id}`)));
  }
  const subject =
    reason === 'updater_other_provider' ? `${ident(c.op)} of ${ident(c.provider)} key ${ident(c.kid)} by the updater` : c.provider === EMAIL_PROVIDER ? `email issuer key ${ident(c.kid)}` : `issuer key ${ident(c.kid)}`;
  const title = `Forged ${subject} (change ${c.id}): ${FORGED_WHY[reason]}; ${OUTCOME_TEXT[outcome]}`;
  const details = { ...changeDetails(c), reason, outcome, ...(jwk ? { google_n: jwk.n, google_e: jwk.e } : {}), ...extra, updater_proposed: c.by === signer, actions: actions.map(actionDetail) };
  const ev = await run.event('forged_key_change', `forged_key_change:${c.id}`, title, details);
  // Already alerted (an earlier cancel failed): each new successful action gets its own critical alert.
  if (!ev) for (const a of actions.filter((x) => x.ok)) await run.event('automatic_action', `automatic_action:${a.id}`, `Automatic action for forged change ${c.id}: ${a.method}`, actionDetail(a));
}

/** Deletes every updater key not deleted yet in this run (a stolen updater key can't post again). */
async function deleteUpdaterKeys(run: Run, s: ChainSnapshot, deleted: Set<string>, self: SelfChanges, reason: string): Promise<ActionSummary[]> {
  const actions: ActionSummary[] = [];
  for (const publicKey of s.governance.updater_keys) {
    if (deleted.has(publicKey)) continue;
    const del = await run.act('delete_updater_key', { public_key: publicKey }, reason);
    actions.push(del);
    if (del.ok) {
      deleted.add(publicKey);
      self.deletedUpdaterKeys.push(publicKey);
    } else if (ALREADY_DONE.test(del.error ?? '')) deleted.add(publicKey);
    else await run.condition('protective_action_failed', `protective_action_failed:delete_updater_key:${publicKey}`, `Deleting updater key ${ident(publicKey)} failed`, actionDetail(del));
  }
  return actions;
}

async function checkActiveKeys(run: Run, s: ChainSnapshot, jwks: Map<string, Jwk>, firstRun: boolean, canAct: boolean, self: SelfChanges, deleted: Set<string>): Promise<void> {
  const { store } = run.d;
  const now = run.d.now();
  if (!s.issuer) {
    run.check('active_keys', 'skipped', 'issuer google not configured');
    return;
  }
  run.check('active_keys', 'ok', `${s.issuer.kids.length} active`);
  if (s.issuerKeys === null) {
    await run.condition('active_key_material_unavailable', 'active_key_material_unavailable', 'The contract has no get_issuer_keys: active keys are checked by kid only', { signer: run.d.config.signer });
  }
  const material = new Map((s.issuerKeys ?? []).map((k) => [k.kid, k]));
  const seen = await store.seenKids(GOOGLE_PROVIDER);

  for (const kid of s.issuer.kids) {
    const jwk = jwks.get(kid);
    const onChain = material.get(kid) ?? null;
    if (firstRun) {
      // History the watchdog can't judge: alert, never pause (spec step 5).
      if (!jwk) {
        await store.addBaselineKid(GOOGLE_PROVIDER, kid, onChain?.n ?? null, onChain?.e ?? null, now);
        await run.event('unknown_active_key_first_run', `first_run_unknown:${GOOGLE_PROVIDER}:${kid}`, `First run: active key ${ident(kid)} is not in Google's JWKS (recorded as known; not paused)`, { kid, reason: 'not_in_jwks', ...(onChain ? { n: onChain.n, e: onChain.e } : {}) });
      } else if (onChain && !sameRsaKey(onChain, jwk)) {
        await run.event('unknown_active_key_first_run', `first_run_mismatch:${GOOGLE_PROVIDER}:${kid}`, `First run: active key ${ident(kid)} has other key material than Google's (not paused now; the next run pauses unless the owner removes it)`, { kid, reason: 'other_key_material', n: onChain.n, e: onChain.e, google_n: jwk.n, google_e: jwk.e });
      }
      continue;
    }
    const s0 = seen.get(kid);
    const known = jwk ?? (s0?.n && s0.e ? { n: s0.n, e: s0.e } : null);
    const reason = !s0 ? 'never_published' : onChain && known && !sameRsaKey(onChain, known) ? 'other_key_material' : null;
    if (reason) {
      const why = reason === 'never_published' ? 'Google never published it' : 'Google publishes other key material for it';
      await forgedActive(run, s, GOOGLE_PROVIDER, kid, reason, why, onChain, canAct, self, deleted, {});
      continue;
    }
    if (!jwk && s0) {
      const since = s0.last_seen_at ?? s0.first_seen_at;
      if (now - since > STALE_ACTIVE_KID_MS) {
        await run.condition('stale_active_key', `stale_active_key:${GOOGLE_PROVIDER}:${kid}`, `Active key ${ident(kid)} has not been in Google's JWKS since ${iso(since)}`, { kid, last_seen_at: s0.last_seen_at, source: s0.source });
      }
    }
  }
}

/** Info alerts for changes that left the queue without this watchdog: executed after the delay, or cancelled. */
async function queueExits(run: Run, prev: StoredSnapshot | null, s: ChainSnapshot): Promise<void> {
  if (!prev) return;
  const current = new Set(s.keyChanges.map((c) => c.id));
  const activeOf: Record<string, Set<string>> = { [GOOGLE_PROVIDER]: new Set(s.issuer?.kids ?? []), [EMAIL_PROVIDER]: new Set(s.email.issuer?.kids ?? []) };
  for (const p of prev.keyChanges) {
    if (current.has(p.id)) continue;
    if ((await run.d.store.alertExists(`confirmed:${p.id}`)) || (await run.d.store.alertExists(`forged_key_change:${p.id}`))) continue;
    const active = activeOf[p.provider];
    if (!active) {
      // Only Google's and the email issuer's active sets are read: say it left the queue, not how.
      await run.event('key_change_executed', `executed:${p.id}`, `Key change ${p.id} left the queue: ${ident(p.op)} ${ident(p.provider)} ${ident(p.kid)}`, { ...changeDetails(p), effect: 'not checked' });
      continue;
    }
    const what = `${p.provider === GOOGLE_PROVIDER ? '' : `${ident(p.provider)} `}${ident(p.kid)}`;
    const tookEffect = p.op === 'Add' ? active.has(p.kid) : !active.has(p.kid);
    if (tookEffect) await run.event('key_change_executed', `executed:${p.id}`, `Key change ${p.id} took effect: ${ident(p.op)} ${what}`, changeDetails(p));
    else await run.event('key_change_cancelled', `cancelled:${p.id}`, `Key change ${p.id} left the queue without taking effect: ${ident(p.op)} ${what}`, changeDetails(p));
  }
}

/**
 * D82's response to a forged ACTIVE key (Google's or the email issuer's): pause (once: not while already paused, by
 * the chain or by this run), then delete every updater key (a stolen one can't post again), then one condition
 * alert; a pause or deletion repeated while the alert is open (after an unpause) gets its own critical alert.
 */
async function forgedActive(
  run: Run,
  s: ChainSnapshot,
  provider: string,
  kid: string,
  reason: string,
  why: string,
  onChain: { n: string; e: string } | null,
  canAct: boolean,
  self: SelfChanges,
  deleted: Set<string>,
  extra: Record<string, unknown>,
): Promise<void> {
  let action: ActionSummary | null = null;
  if (canAct && !s.config.paused && !self.paused) {
    action = await run.act('pause', {}, `active ${provider === GOOGLE_PROVIDER ? '' : `${ident(provider)} `}key ${ident(kid)}: ${reason}`);
    if (action.ok) self.paused = true;
    else await run.condition('protective_action_failed', 'protective_action_failed:pause', `Pausing for active key ${ident(kid)} failed`, actionDetail(action));
  }
  // Pause first (it stops every login at once), then the updater keys, so a stolen one can't post again.
  const deletions = canAct ? await deleteUpdaterKeys(run, s, deleted, self, `active key ${ident(kid)}: ${reason}`) : [];
  const state = action?.ok ? 'paused' : s.config.paused || self.paused ? 'already paused' : canAct ? 'pause failed' : 'the watchdog could not act';
  const removed = deletions.filter((a) => a.ok).length;
  const acted = [...(action ? [action] : []), ...deletions];
  const subject = provider === GOOGLE_PROVIDER ? 'Active issuer key' : `Active ${ident(provider)} issuer key`;
  const cond = await run.condition('forged_active_key', `forged_active_key:${provider}:${kid}`, `${subject} ${ident(kid)}: ${why}; ${state}${removed ? `, ${removed} updater key(s) deleted` : ''}`, {
    provider,
    kid,
    reason,
    ...(onChain ? { n: onChain.n, e: onChain.e } : {}),
    ...extra,
    ...(acted.length ? { actions: acted.map(actionDetail) } : {}),
  });
  if (!cond.isNew) for (const a of acted.filter((x) => x.ok)) await run.event('automatic_action', `automatic_action:${a.id}`, a.method === 'pause' ? `Paused again: active key ${ident(kid)} (${why})` : `Automatic action for active key ${ident(kid)}: ${a.method}`, actionDetail(a));
}

/**
 * Pending email key changes (docs/email-login-spec.md "Watchdog"). The updater ("self") never serves email: its change
 * is `updater_other_provider` (cancel, delete every updater key). An Add whose key isn't pinned for its signer, or whose
 * kid isn't its thumbprint, is forged: cancelled. A pinned Add, and any removal (owner only, DoS only), is info: never
 * confirmed (the contract refuses, D121), it waits its `governance_delay_ms`.
 */
async function emailPendingChanges(run: Run, s: ChainSnapshot, canAct: boolean, settled: Set<number>, deleted: Set<string>, self: SelfChanges): Promise<void> {
  const changes = s.keyChanges.filter((c) => c.provider === EMAIL_PROVIDER);
  if (changes.length === 0) return;
  run.check('pending_key_changes', 'ok', `${changes.length} email pending`);
  const pins = run.d.config.emailPins.pins;
  for (const c of changes) {
    if (c.by === run.d.config.signer) {
      await forgedPending(run, s, c, 'updater_other_provider', null, canAct, settled, deleted, self);
      continue;
    }
    if (c.op === 'Remove') {
      await run.event('self_issued_key_change', `self_issued_key_change:${c.id}`, `Pending removal of email key ${ident(c.kid)} (change ${c.id}), executable from ${iso(c.executable_at_ms)}: never confirmed early`, changeDetails(c));
      continue;
    }
    const v = await emailKeyVerdict(pins, { kid: c.kid, n: c.n, e: c.e }, c.signer ?? null, true);
    if (v.reason) {
      await forgedPending(run, s, c, v.reason, null, canAct, settled, deleted, self, { thumbprint: v.thumbprint, pinned_for: v.pinnedFor, pinned: pins !== null });
      continue;
    }
    await run.event('self_issued_key_change', `self_issued_key_change:${c.id}`, `Pending pinned email key ${ident(c.kid)} for signer ${ident(c.signer ?? '')} (change ${c.id}): waits until ${iso(c.executable_at_ms)}, never confirmed early`, {
      ...changeDetails(c),
      thumbprint: v.thumbprint,
    });
  }
}

/**
 * Active email keys against the pins: each key's thumbprint pinned, its kid that thumbprint, and pinned for the signer
 * `get_self_issued` lists it under. Anything else pauses, as a forged Google key does (D82). Pins are configuration,
 * not history, so this holds at the first run too (D190).
 */
async function emailActiveKeys(run: Run, s: ChainSnapshot, canAct: boolean, self: SelfChanges, deleted: Set<string>): Promise<void> {
  run.evaluatePrefix('forged_active_key', `forged_active_key:${EMAIL_PROVIDER}:`);
  const { issuer, issuerKeys, selfIssued } = s.email;
  if (!issuer) return;
  const pins = run.d.config.emailPins.pins;
  const keys = issuerKeys ?? issuer.kids.map((kid) => ({ kid, n: null, e: null }));
  run.check('active_keys', 'ok', `${keys.length} active email`);
  for (const k of keys) {
    const signer = signerOfKid(selfIssued, k.kid);
    const v = await emailKeyVerdict(pins, k, signer, false);
    if (!v.reason) continue;
    const onChain = k.n && k.e ? { n: k.n, e: k.e } : null;
    await forgedActive(run, s, EMAIL_PROVIDER, k.kid, v.reason, EMAIL_KEY_WHY[v.reason], onChain, canAct, self, deleted, { signer, thumbprint: v.thumbprint, pinned_for: v.pinnedFor, pinned: pins !== null });
  }
}

/**
 * `get_issuer("email")` and `get_self_issued("email")` against the pins: critical on any difference, pause on a weaker
 * policy (D191). One condition per chain policy state, so a later, different mismatch is a new alert.
 */
async function signerPolicy(run: Run, s: ChainSnapshot, canAct: boolean, self: SelfChanges): Promise<void> {
  run.evaluate('signer_policy_mismatch');
  const pins = run.d.config.emailPins.pins;
  const e = s.email;
  const f = policyFindings(pins, e);
  const si = e.selfIssued;
  await run.d.store.setMeta(META.emailPolicy, {
    at: run.d.now(),
    pinned: pins,
    chain: {
      issuer: e.issuer !== null,
      pre_v3: !e.hasSelfIssuedView,
      self_issued: si ? { signers: si.signers, required: si.required, overlap_until_ms: si.overlap_until_ms ?? null } : null,
      active_kids: e.issuer?.kids ?? [],
    },
    differences: f.differences,
    weaker: f.weaker,
  } satisfies EmailPolicyStatus);
  if (f.differences.length === 0) {
    const state = !e.issuer ? `no email issuer on chain${e.hasSelfIssuedView ? '' : ' (pre-v3 contract)'}` : `matches the pins (required ${si?.required})`;
    run.check('signer_policy', 'ok', `${state}; ${pins ? `pinned: ${Object.keys(pins.signers).length} signer(s), required ${pins.required}` : 'nothing pinned'}`);
    return;
  }
  let action: ActionSummary | null = null;
  if (f.weaker.length && canAct && !s.config.paused && !self.paused) {
    action = await run.act('pause', {}, `email signer policy weaker than the pins: ${f.weaker.join('; ')}`);
    if (action.ok) self.paused = true;
    else await run.condition('protective_action_failed', 'protective_action_failed:pause', 'Pausing for a weaker email signer policy failed', actionDetail(action));
  }
  const state = !f.weaker.length ? 'alert only' : action?.ok ? 'paused' : s.config.paused || self.paused ? 'already paused' : canAct ? 'pause failed' : 'the watchdog could not act';
  const title = `Email signer policy differs from the pins: ${f.differences.join('; ')}; ${f.weaker.length ? 'weaker, ' : ''}${state}`;
  const cond = await run.condition('signer_policy_mismatch', `signer_policy_mismatch:${EMAIL_PROVIDER}:${policyId(e)}${f.weaker.length ? ':weaker' : ''}`, title, {
    provider: EMAIL_PROVIDER,
    pinned: pins,
    chain: { issuer: e.issuer, self_issued: si, pre_v3: !e.hasSelfIssuedView },
    differences: f.differences,
    weaker: f.weaker,
    ...(action ? { actions: [actionDetail(action)] } : {}),
  });
  if (!cond.isNew && action?.ok) await run.event('automatic_action', `automatic_action:${action.id}`, 'Paused again: the email signer policy is weaker than the pins', actionDetail(action));
}

/**
 * Hana's published email JWKS against the pins and the active email keys: warning only (D190; Hana controls it, the
 * contract never reads it, the watchdog doesn't trust it). A failed fetch alerts after 3 runs, and only while email
 * keys are active (before that the issuer may not be deployed yet).
 */
async function emailJwks(run: Run, s: ChainSnapshot): Promise<void> {
  const { store } = run.d;
  const pins = run.d.config.emailPins.pins;
  const fetchJwks = run.d.fetchEmailJwks;
  if (!pins || !fetchJwks) {
    run.evaluate('email_jwks_mismatch');
    run.check('email_jwks', 'skipped', !pins ? 'nothing pinned' : 'no email JWKS URL configured');
    return;
  }
  const active = s.email.issuer?.kids ?? [];
  let failures = (await store.getMeta<number>(META.emailJwksFailures)) ?? 0;
  let keys: Jwk[];
  try {
    keys = await fetchJwks();
    failures = 0;
  } catch {
    failures++;
    await store.setMeta(META.emailJwksFailures, failures);
    run.evaluatePrefix('email_jwks_mismatch', 'email_jwks_mismatch:fetch');
    if (failures >= FAILING_RUNS && active.length) {
      await run.condition('email_jwks_mismatch', 'email_jwks_mismatch:fetch', `Hana's email JWKS fetch failed ${failures} runs in a row while ${active.length} email key(s) are active`, { failures, active_kids: active });
    }
    run.check('email_jwks', active.length ? 'error' : 'skipped', `fetch failed (${failures} run(s) in a row)${active.length ? '' : '; no email key active'}`);
    return;
  }
  await store.setMeta(META.emailJwksFailures, failures);
  run.evaluate('email_jwks_mismatch');
  const problems: string[] = [];
  const published = new Set<string>();
  for (const k of keys) {
    published.add(k.kid);
    const tp = await rsaThumbprint(k);
    if (pinnedSignersOf(pins, tp).length === 0) problems.push(`published key ${ident(k.kid)} is not pinned`);
    else if (k.kid !== tp) problems.push(`published key ${ident(k.kid)}: its kid is not its thumbprint`);
  }
  for (const kid of active) if (!published.has(kid)) problems.push(`active email key ${ident(kid)} is not published`);
  if (problems.length) {
    await run.condition('email_jwks_mismatch', 'email_jwks_mismatch:keys', `Hana's email JWKS differs from the pins: ${problems.join('; ')}`, { problems, published: [...published], active_kids: active });
  }
  run.check('email_jwks', problems.length ? 'alert' : 'ok', `${keys.length} published, ${active.length} active`);
}

/**
 * The link-volume check (identity_link_* events through the indexer) and D139's `unrecorded_wallets`. Links need an
 * email identity, so while no email issuer is on chain nothing is scanned and the cursor stays unset: the first scan
 * after the email issuer appears starts at the chain's head (no link can precede its first key, which waits
 * `governance_delay_ms`). Returns false when the indexer read failed (the run is then degraded).
 */
async function checkLinks(run: Run, s: ChainSnapshot): Promise<boolean> {
  const { store, config: cfg } = run.d;
  const now = run.d.now();
  run.evaluate('unrecorded_wallets');
  if (s.config.unrecorded_wallets === true) {
    if (cfg.devEnv) run.check('links', 'ok', 'unrecorded_wallets is true (a dev env: allowed until accept_unrecorded_wallets)');
    else {
      await run.condition('unrecorded_wallets', 'unrecorded_wallets', `unrecorded_wallets is true on ${ident(cfg.envName)}, which is not a dev env: links are refused until the owner accepts, and mainnet must never show it`, {
        env: cfg.envName,
        signer: cfg.signer,
      });
    }
  }
  const state: LinkScanState = (await store.getMeta<LinkScanState>(META.linkScan)) ?? { cursor: null, failures: 0, at: null, latest_height: null, behind_ms: null, last_hour: null, thresholds: cfg.linkVolume.thresholds };
  state.thresholds = cfg.linkVolume.thresholds;
  const emailLive = s.email.issuer !== null || s.email.selfIssued !== null;
  const src = run.d.linkEvents;
  if (!src) {
    run.evaluate('link_events_unavailable');
    if (emailLive) await run.condition('link_events_unavailable', 'link_events_unavailable:not_configured', 'Link volume is not monitored: an email issuer is on chain and no indexer is configured (watchdog.linkVolume)', { signer: cfg.signer });
    run.check('links', 'skipped', 'no indexer configured');
    return true;
  }
  if (!emailLive) {
    // No email identity can exist, so no link: nothing to read (and the next scan starts at the head).
    run.evaluate('link_events_unavailable', 'link_volume_high');
    await store.setMeta(META.linkScan, { ...state, cursor: null, failures: 0, last_hour: null } satisfies LinkScanState);
    run.check('links', 'ok', 'no email issuer on chain: no link possible, nothing scanned');
    return true;
  }
  let scan;
  try {
    scan = await src.scan(state.cursor === null ? null : state.cursor + 1, now);
  } catch {
    const failures = state.failures + 1;
    await store.setMeta(META.linkScan, { ...state, failures } satisfies LinkScanState);
    run.evaluatePrefix('link_events_unavailable', 'link_events_unavailable:failing');
    if (failures >= FAILING_RUNS) await run.condition('link_events_unavailable', 'link_events_unavailable:failing', `The link-event indexer failed ${failures} runs in a row: link volume is not monitored`, { failures });
    run.check('links', 'error', `indexer read failed (${failures} run(s) in a row)`);
    log({ event: 'link_scan', outcome: 'error', runId: run.id }, 'warn');
    return false;
  }
  await store.recordLinkEvents(scan.events);
  await store.pruneLinkEvents(now - LINK_EVENT_RETENTION_MS);
  const counts = await store.linkCounts(now - LINK_WINDOW_MS);
  const byScope: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  let total = 0;
  for (const c of counts) {
    byEvent[c.event] = (byEvent[c.event] ?? 0) + c.n;
    if (!(NEW_LINK_EVENTS as readonly string[]).includes(c.event)) continue;
    byScope[c.scope_id] = (byScope[c.scope_id] ?? 0) + c.n;
    total += c.n;
  }
  run.evaluate('link_volume_high', 'link_events_unavailable');
  const t = cfg.linkVolume.thresholds;
  for (const [scope, n] of Object.entries(byScope)) {
    if (n <= t.perScopePerHour) continue;
    const auto = counts.filter((c) => c.scope_id === scope && c.auto === 1).reduce((a, c) => a + c.n, 0);
    await run.condition('link_volume_high', `link_volume_high:scope:${scope}`, `${n} new links in scope ${ident(scope)} in the last hour (threshold ${t.perScopePerHour}; ${auto} automatic)`, { scope_id: scope, new_links: n, automatic: auto, threshold: t.perScopePerHour, window_ms: LINK_WINDOW_MS });
  }
  if (total > t.perHour) await run.condition('link_volume_high', 'link_volume_high:total', `${total} new links in the last hour in all scopes (threshold ${t.perHour})`, { new_links: total, by_scope: byScope, threshold: t.perHour, window_ms: LINK_WINDOW_MS });
  if (scan.behindMs > LINK_SCAN_BEHIND_MS) {
    await run.condition('link_events_unavailable', 'link_events_unavailable:behind', `The link scan is ${Math.round(scan.behindMs / 60_000)} min behind the chain${scan.truncated ? ' (more transactions than one run reads)' : ''}: a burst is seen late`, {
      behind_ms: scan.behindMs,
      truncated: scan.truncated,
      scanned_to: scan.scannedTo,
      latest_height: scan.latestHeight,
    });
  }
  await store.setMeta(META.linkScan, {
    cursor: scan.scannedTo,
    failures: 0,
    at: now,
    latest_height: scan.latestHeight,
    behind_ms: scan.behindMs,
    last_hour: { new_links: total, by_scope: byScope, by_event: byEvent },
    thresholds: t,
  } satisfies LinkScanState);
  run.check('links', 'ok', `${scan.events.length} new link event(s) read; ${total} new link(s) in the last hour`);
  return true;
}

const thresholdText = (t: Threshold) => ({ warn_below: formatNear(t.warn), critical_below: formatNear(t.critical) });

/**
 * Reads the relayer account and raises one condition per thing running low: its available balance (critical below
 * the critical threshold, else a warning below the warning one), each pool key's remaining allowance (the same way,
 * per key and pool), and a pool with no key at all. A refill, a replaced key or a raised allowance resolves them at
 * the next run. Returns false when the read failed: nothing is judged then, and open alerts stay open.
 */
async function checkRelayerFunds(run: Run, relayer: string, t: RelayerThresholds): Promise<boolean> {
  let f: RelayerFunds;
  try {
    f = await run.d.chain.relayerFunds(relayer);
  } catch {
    run.check('relayer_funds', 'error', 'relayer account read failed');
    log({ event: 'relayer_read', outcome: 'error', runId: run.id }, 'warn');
    return false;
  }
  const at = run.d.now();
  const str = (x: Threshold) => ({ warn: x.warn.toString(), critical: x.critical.toString() });
  await run.d.store.setMeta(META.relayerFunds, { ...f, at, thresholds: { balance: str(t.balance), session: str(t.session), owner: str(t.owner) } } satisfies RelayerFundsStatus);
  run.evaluate('relayer_balance_critical', 'relayer_balance_low', 'relayer_allowance_critical', 'relayer_allowance_low', 'relayer_pool_empty');
  const available = BigInt(f.available);
  const counts = RELAYER_POOLS.map((p) => `${f.keys.filter((k) => k.pool === p).length} ${p}`).join(', ');
  run.check('relayer_funds', 'ok', `${formatNear(available)} available; pool keys: ${counts}${f.other_keys.length ? `; ${f.other_keys.length} other key(s) for the signer not judged` : ''}`);
  const account = ident(relayer);

  const balance = level(available, t.balance);
  const balanceDetails = { account: relayer, exists: f.exists, available: formatNear(available), available_yocto: f.available, amount_yocto: f.amount, storage_usage: f.storage_usage, ...thresholdText(t.balance) };
  if (balance === 'critical') {
    await run.condition('relayer_balance_critical', 'relayer_balance_critical', f.exists ? `Relayer ${account} has ${formatNear(available)} available (critical below ${formatNear(t.balance.critical)}): relays fail when it runs out` : `Relayer account ${account} does not exist: every relay fails`, balanceDetails);
  } else if (balance === 'warn') {
    await run.condition('relayer_balance_low', 'relayer_balance_low', `Relayer ${account} has ${formatNear(available)} available (warning below ${formatNear(t.balance.warn)})`, balanceDetails);
  }

  for (const pool of RELAYER_POOLS) {
    const keys = f.keys.filter((k) => k.pool === pool);
    const th = t[pool];
    if (keys.length === 0) {
      await run.condition('relayer_pool_empty', `relayer_pool_empty:${pool}`, `Relayer ${account} has no ${pool}-pool key for ${ident(run.d.config.signer)}: every ${pool === 'session' ? 'login' : 'owner action'} relay fails`, { account: relayer, pool, receiver: run.d.config.signer });
      continue;
    }
    for (const k of keys) {
      if (k.allowance === null) continue; // unlimited: only the account balance bounds it
      const left = BigInt(k.allowance);
      const lv = level(left, th);
      if (lv === 'ok') continue;
      const details = { account: relayer, pool, public_key: k.public_key, allowance: formatNear(left), allowance_yocto: k.allowance, ...thresholdText(th) };
      const kind = lv === 'critical' ? 'relayer_allowance_critical' : 'relayer_allowance_low';
      const below = lv === 'critical' ? `critical below ${formatNear(th.critical)}` : `warning below ${formatNear(th.warn)}`;
      await run.condition(kind, `${kind}:${pool}:${k.public_key}`, `Relayer ${pool}-pool key ${ident(k.public_key)} has ${formatNear(left)} of allowance left (${below})`, details);
    }
  }
  return true;
}

async function heartbeat(run: Run): Promise<void> {
  const { store, notifier } = run.d;
  const state = (await store.getMeta<HeartbeatState>(META.heartbeat)) ?? { last_ping_at: null, last_ok_at: null, ok: false, failures: 0 };
  run.evaluate('heartbeat_failing');
  if (!notifier.heartbeat.configured) {
    run.check('heartbeat', 'skipped', 'not configured');
    return;
  }
  const at = run.d.now();
  const res = await notifier.heartbeat.ping().catch(() => ({ ok: false as const, error: 'threw' }));
  const next: HeartbeatState = { last_ping_at: at, last_ok_at: res.ok ? at : state.last_ok_at, ok: res.ok, failures: res.ok ? 0 : state.failures + 1 };
  await store.setMeta(META.heartbeat, next);
  run.check('heartbeat', res.ok ? 'ok' : 'error', res.ok ? undefined : `ping failed (${next.failures} in a row)`);
  if (next.failures >= FAILING_RUNS) await run.condition('heartbeat_failing', 'heartbeat_failing', `The dead-man's switch ping failed ${next.failures} runs in a row`, { failures: next.failures, last_ok_at: next.last_ok_at });
}
