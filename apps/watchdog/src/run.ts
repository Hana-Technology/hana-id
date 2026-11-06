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
import { diffChain, linkThresholdsOf, type StoredSnapshot } from './diff.ts';
import {
  type IdentityPins,
  type IdentityResponse,
  identityDiscoveryUrl,
  identityJwksUrl,
  identityKeysOnChain,
  judgeDiscovery,
  judgeIdentityJwks,
  MAX_LISTED,
  type PublishedKey,
  readIdentityResponse,
  sha256b64url,
} from './identity.ts';
import { log } from './log.ts';
import { EMAIL_KEY_WHY, EMAIL_PROVIDER, type EmailKeyReason, emailKeyVerdict, pinnedSignersOf, policyFindings, policyId, type SignerPins, signerOfKid } from './pins.ts';
import { formatNear, level, RELAYER_POOLS, type RelayerFunds, type RelayerThresholds, type Threshold } from './relayer.ts';
import { ident, printable } from './sanitize.ts';
import { iso } from './time.ts';
import type { Absence, CheckResult, SeenKid, Store } from './store.ts';

/** A kid with a pending change counts as not published once absent from two fetches at least this far apart. */
export const ABSENCE_RECHECK_MS = 60_000;
/**
 * A pending Add of a kid Google doesn't publish now, but did publish with the same key material within this window,
 * is not a forgery (D153): either Google retired it (the API cron's fetch still listed it) or Google is rolling it out
 * and this fetch came from an edge that doesn't list it yet (D420).
 */
export const RETIRED_KEY_GRACE_MS = 24 * 60 * 60_000;
/**
 * Rollout hysteresis (D420): Google's edges serve different key sets for a day or two around a rotation, so absence
 * is weak evidence. Acting on it (cancelling an Add as retired, confirming a Remove early) takes at least this many
 * successful fetches in a row that missed the kid,
 */
export const ABSENT_FETCHES_TO_ACT = 3;
/** spread over at least this long for a retired Add's cancel, */
export const RETIRED_ABSENT_SPAN_MS = 30 * 60_000;
/** with Google's last listing of the kid at least this long ago, */
export const RETIRED_UNSEEN_MS = 6 * 60 * 60_000;
/** and the kid known for at least this long (a key still rolling out is never "retired"). */
export const RETIRED_MIN_KEY_AGE_MS = 7 * 24 * 60 * 60_000;
/** A Remove is confirmed early only after absent fetches spread over at least this long, */
export const REMOVAL_ABSENT_SPAN_MS = 10 * 60_000;
/** and no fetch listing the kid for at least this long (otherwise it waits out the contract's delay). */
export const REMOVAL_UNSEEN_MS = 24 * 60 * 60_000;
/**
 * An active kid Google stopped publishing longer ago than this is stale (warning): the API cron proposes its removal
 * only after 24 h missing from every fetch (D420), so stale means the removal is over 3 h late (was 3 h, before D420).
 */
export const STALE_ACTIVE_KID_MS = 27 * 60 * 60_000;
/** A change executable for longer than this that nobody executed (warning). */
export const UNEXECUTED_AFTER_MS = 60 * 60_000;
/** RPC or JWKS failures in a row before a warning. */
export const FAILING_RUNS = 3;
/** `link_volume_high` once the current window's links reach this share of `total_per_hour` (D200). */
export const LINK_VOLUME_WARN_SHARE = 0.5;
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
  /**
   * The partner identity token (D210): its issuer (`identityToken.iss`; null: the env has none, the JWKS check is
   * skipped) and `watchdog.pinnedIdentityKeys` (`pins: null`: nothing pinned), with any problem reading them.
   */
  identity: { iss: string | null; pins: IdentityPins };
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
  /**
   * Hana's identity JWKS and discovery document (no cache, `redirect: 'manual'`, body capped), or null when the env has
   * no identity issuer. Each answers a 200 body, a redirect or an oversized body; any other status or a network error
   * throws.
   */
  fetchIdentity: { jwks: () => Promise<IdentityResponse>; discovery: () => Promise<IdentityResponse> } | null;
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
  /** The last `get_link_stats()` with when it was read (`GET /status` `link_stats`). */
  linkStats: 'link_stats',
  /** The pins and the chain's email issuer at the last run (`GET /status` `email`). */
  emailPolicy: 'email_policy',
  identityJwksFailures: 'identity_jwks_failures',
  identityDiscoveryFailures: 'identity_discovery_failures',
  /** The last good read of Hana's identity JWKS, judged (`GET /status` `identity.jwks`; its thumbprints feed identity_on_chain). */
  identityJwks: 'identity_jwks',
  /** The last good read of the identity discovery document (`GET /status` `identity.discovery`). */
  identityDiscovery: 'identity_discovery',
} as const;

/** What `GET /status` serves as `identity.jwks`: the last good read of Hana's identity JWKS, judged against the pins. */
export interface IdentityJwksStatus {
  at: number;
  url: string;
  /** Published entries (at most 50 listed; `count` has them all). */
  keys: { kid: string | null; thumbprint: string | null; pinned: boolean; private: string[]; reason: string | null }[];
  count: number;
  unpinned: number;
  private: number;
  missing: { thumbprint: string; reason: 'not_published' | 'kid_differs' | 'not_clean' }[];
}

/** What `GET /status` serves as `identity.discovery`: the last good read of the discovery document. */
export interface IdentityDiscoveryStatus {
  at: number;
  url: string;
  issuer: string | null;
  jwks_uri: string | null;
  problems: { field: 'issuer' | 'jwks_uri'; expected: string; published: string | null }[];
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
  let advisorySnap: ChainSnapshot | null = null;
  let advisoryReady = false;
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
    run.evaluate('watchdog_key_missing', 'channel_not_configured', 'pins_invalid');
    run.check('config', 'ok', [...cfg.relayerThresholds.problems, ...cfg.emailPins.problems, ...cfg.identity.pins.problems].join('; ') || undefined);
    if (cfg.emailPins.problems.length) {
      // Fail closed: every email key then counts as unpinned (cancel, pause), so say why at once (L4).
      await run.condition('pins_invalid', 'pins_invalid', "The watchdog's email pins (EMAIL_PINS) are unreadable: every email key is treated as unpinned", { problems: cfg.emailPins.problems });
    }
    if (cfg.identity.pins.problems.length) {
      // Fail closed as for email: every published identity key then pages as unpinned (`pins_unreadable`).
      await run.condition('pins_invalid', 'pins_invalid:identity', "The watchdog's identity pins (IDENTITY_PINS) are unreadable: every published identity key is treated as unpinned", {
        problems: cfg.identity.pins.problems,
      });
    }
    if (cfg.identity.pins.pins && !cfg.identity.iss) {
      // Pins with nothing to check them against: the identity JWKS check can't run, and must not look fine (L2).
      run.check('config', 'ok', 'IDENTITY_PINS is set but IDENTITY_ISS is not: the identity JWKS check cannot run');
      await run.condition('pins_invalid', 'pins_invalid:identity_no_iss', "The watchdog pins identity keys (IDENTITY_PINS) but has no identity issuer (IDENTITY_ISS): the identity JWKS check can't run", {
        pinned: cfg.identity.pins.pins,
      });
    }
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
      await unrecordedWallets(run, snap);
      // D200: links per hour from one chain view, judged before the run is recorded and the lock released.
      await linkStats(run, snap);
      // D212: no identity key's thumbprint as an issuer kid (chain data and stored config only: no third-party read).
      await identityOnChain(run, snap);
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
      let tracked = await trackAbsences(store, pending, jwksNow, google.at);
      const absent = tracked.absent;
      if (pending.some((c) => !jwksNow.has(c.kid) && !absent.has(c.kid))) {
        // A pending kid is missing from this fetch: look again after 60 s before calling it unpublished.
        await d.sleep(ABSENCE_RECHECK_MS);
        if ((await fetchGoogle()) && google.jwks) {
          jwksNow = google.jwks;
          tracked = await trackAbsences(store, pending, jwksNow, google.at);
          for (const kid of tracked.absent) absent.add(kid);
          for (const kid of [...absent]) if (jwksNow.has(kid)) absent.delete(kid);
        }
      }
      const runs = tracked.runs;

      // Read for D153 and D420. A failed read must not hold back a cancel (without it every unpublished Add is
      // forged), and holds back every early removal (it can't tell how recently Google listed the kid).
      let seenRead = true;
      const seen = await store.seenKids(GOOGLE_PROVIDER).catch(() => {
        log({ event: 'seen_kids_read_failed', runId }, 'error');
        seenRead = false;
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
            if (retiredAddDue(seen.get(c.kid)!, runs.get(c.kid), d.now())) await retiredPending(run, c, lastSeen, canAct, settled);
            // Known to Google within a day and not yet provably retired: a rollout seen through an edge that doesn't
            // list it. Left pending: confirmed once a fetch lists it, executed by the API if its own fetches do (D420).
            else run.check('pending_key_changes', 'ok', `${ident(c.kid)} missing from this fetch but listed by Google at ${iso(lastSeen)}: waiting (rollout, D420)`);
            continue;
          }
          await forgedPending(run, s, c, reason, jwk ?? null, canAct, settled, deleted, self);
        } else if (jwk) {
          await run.condition('published_key_removal', `published_key_removal:${c.id}`, `Pending removal of ${ident(c.kid)}, which Google still publishes (alert only: the owner decides)`, changeDetails(c));
        } else if (absent.has(c.kid) && canConfirm) {
          if (seenRead && removalConfirmable(seen.get(c.kid), runs.get(c.kid), d.now())) await confirm(run, c, settled);
          else run.check('pending_key_changes', 'ok', `${ident(c.kid)} absent, not yet long enough to confirm its removal early (D420)`);
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
      for (const id of ['pending_key_changes', 'active_keys'] as const) {
        // The email half may have been judged already (it needs no Google JWKS): keep its outcome.
        const judged = run.checks.get(id);
        run.check(id, judged ? judged.outcome : 'skipped', snap ? "Google's half skipped: no JWKS" : 'no chain read');
      }
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

      await store.setMeta(META.snapshot, {
        at: d.now(),
        config: s.config,
        governance: s.governance,
        keyChanges: s.keyChanges,
        owner: s.owner,
        issuer: s.issuer,
        email: { issuer: s.email.issuer, selfIssued: s.email.selfIssued },
        linkStats: linkThresholdsOf(s.linkStats),
      } satisfies StoredSnapshot);
      await store.setMeta(META.selfChanges, self);
    } else {
      for (const id of ['signer_policy', 'links', 'identity_on_chain', 'governance_diff', 'unexecuted_changes'] as const) run.check(id, 'skipped', 'no chain read');
    }
    // ---- relayer funds (alert only) ----
    let relayerRead = true;
    if (!networkOk) run.check('relayer_funds', 'skipped', 'no chain read');
    else if (!cfg.relayer) run.check('relayer_funds', 'skipped', 'RELAYER_ACCOUNT not set');
    else relayerRead = await checkRelayerFunds(run, cfg.relayer, cfg.relayerThresholds.thresholds);
    if (!complete || !relayerRead) outcome = 'degraded';

    // ---- alerts out (first deliveries, re-sends, pager acks) ----
    delivery = await deliverAlerts(store, d.notifier, d.now(), cfg.envName);
    run.check('alert_delivery', delivery.failed ? 'error' : 'ok', `${delivery.first} first, ${delivery.resent} re-sent, ${delivery.failed} failed, ${delivery.ackedByPager} acked in the paging app`);
    const digest = await maybeSendDigest(store, d.notifier, d.now(), cfg.digestHourUtc, cfg.envName);
    run.check('digest', digest === 'failed' ? 'error' : digest === 'sent' ? 'ok' : 'skipped', digest);

    // ---- step 7: dead-man's switch ----
    await heartbeat(run);

    // The advisory checks run after the run is recorded and the lock released (below).
    advisorySnap = snap;
    advisoryReady = true;
    run.check('email_jwks', 'skipped', snap ? 'advisory: runs after the run is recorded' : 'no chain read');
    run.check('identity_jwks', 'skipped', 'advisory: runs after the run is recorded');
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

  // ---- step 9: the advisory checks, after the run is recorded and the lock released ----
  // Their third-party reads (Hana's email JWKS, Hana's identity JWKS and discovery document: Hana's API is a party the
  // watchdog must survive, D86) can't hold back a cancel, a pause, the snapshot, an alert, the heartbeat, the run record
  // or the lock: a CPU kill or a hang here costs only these checks. Each runs guarded and resolves only its own kinds;
  // then the run's record is updated, and what they raised goes out in a second delivery. The identity check needs no
  // chain read, so it runs without one.
  if (advisoryReady && outcome !== 'error') {
    const s: ChainSnapshot | null = advisorySnap;
    try {
      run.evaluated.clear();
      run.raisedKeys.clear();
      const raised = run.alerts.length;
      if (s) {
        run.checks.delete('email_jwks');
        await advisory(run, 'email_jwks', () => emailJwks(run, s));
      }
      run.checks.delete('identity_jwks');
      await advisory(run, 'identity_jwks', () => identityJwks(run));
      await store.resolveConditions(run.evaluated, run.raisedKeys, d.now());
      if (run.alerts.length > raised) {
        const more = await deliverAlerts(store, d.notifier, d.now(), cfg.envName);
        run.check('alert_delivery', more.failed ? 'error' : 'ok', `advisory: ${more.first} first, ${more.failed} failed`);
      }
      const final = CHECK_IDS.map((id) => run.checks.get(id) ?? { id, outcome: 'skipped' as const });
      await store.updateRun(runId, outcome, final);
      return { runId, outcome, firstRun, checks: final, actions: run.actions, alerts: run.alerts, delivery };
    } catch {
      log({ event: 'advisory_phase_failed', runId }, 'error');
    }
  }
  return { runId, outcome, firstRun, checks, actions: run.actions, alerts: run.alerts, delivery };
}

/**
 * Runs a warning-only check guarded: a throw marks its check `error` and undoes what it marked as evaluated (so a
 * half-run check resolves nothing); returns false then.
 */
async function advisory(run: Run, id: CheckId, fn: () => Promise<void>): Promise<boolean> {
  const evaluated = new Map(run.evaluated);
  try {
    await fn();
    return true;
  } catch (err) {
    run.evaluated.clear();
    for (const [k, v] of evaluated) run.evaluated.set(k, v);
    run.check(id, 'error', 'the check failed');
    log({ event: 'advisory_check_failed', runId: run.id, code: `${id}:${err instanceof Error ? err.name : 'error'}` }, 'error');
    return false;
  }
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
 * Records this fetch's absences of pending kids (the first absence per kid is kept, every absent fetch counted),
 * clears kids that are listed or no longer pending, and returns the kids absent now and also at a fetch at least
 * ABSENCE_RECHECK_MS earlier, with each absent kid's run of absences including this fetch (D420).
 */
async function trackAbsences(store: Store, pending: KeyChange[], jwks: Map<string, Jwk>, fetchAt: number): Promise<{ absent: Set<string>; runs: Map<string, Absence> }> {
  const pendingKids = new Set(pending.map((c) => c.kid));
  const known = await store.absences(GOOGLE_PROVIDER);
  for (const kid of known.keys()) if (!pendingKids.has(kid) || jwks.has(kid)) await store.clearAbsent(GOOGLE_PROVIDER, kid);
  const absent = new Set<string>();
  const runs = new Map<string, Absence>();
  for (const kid of pendingKids) {
    if (jwks.has(kid)) continue;
    const prior = known.get(kid);
    await store.recordAbsent(GOOGLE_PROVIDER, kid, fetchAt);
    runs.set(kid, prior ? { first: prior.first, fetches: prior.fetches + 1 } : { first: fetchAt, fetches: 1 });
    if (prior && fetchAt - prior.first >= ABSENCE_RECHECK_MS) absent.add(kid);
  }
  return { absent, runs };
}

/**
 * D420: whether an updater Add of a kid Google listed with this material within RETIRED_KEY_GRACE_MS (`retiredAt`)
 * is provably retired: Google's last listing is at least RETIRED_UNSEEN_MS old, the kid was first seen at least
 * RETIRED_MIN_KEY_AGE_MS ago, and ABSENT_FETCHES_TO_ACT fetches in a row over RETIRED_ABSENT_SPAN_MS missed it.
 */
export function retiredAddDue(s: SeenKid, absence: Absence | undefined, now: number): boolean {
  if (s.last_seen_at === null || now - s.last_seen_at < RETIRED_UNSEEN_MS) return false;
  if (now - s.first_seen_at < RETIRED_MIN_KEY_AGE_MS) return false;
  return !!absence && absence.fetches >= ABSENT_FETCHES_TO_ACT && now - absence.first >= RETIRED_ABSENT_SPAN_MS;
}

/**
 * D420: whether a pending Remove may be confirmed early: ABSENT_FETCHES_TO_ACT fetches in a row over
 * REMOVAL_ABSENT_SPAN_MS missed the kid, and no fetch of the watchdog's listed it for REMOVAL_UNSEEN_MS. Otherwise the
 * change waits out the contract's delay (the API executes it only if its own fetches miss the kid and no token was
 * signed with it for a day).
 */
export function removalConfirmable(s: SeenKid | undefined, absence: Absence | undefined, now: number): boolean {
  if (!absence || absence.fetches < ABSENT_FETCHES_TO_ACT || now - absence.first < REMOVAL_ABSENT_SPAN_MS) return false;
  return !s || s.last_seen_at === null || now - s.last_seen_at >= REMOVAL_UNSEEN_MS;
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
    const reason = pinsReason(run, v.reason);
    if (reason) {
      await forgedPending(run, s, c, reason, null, canAct, settled, deleted, self, { thumbprint: v.thumbprint, pinned_for: v.pinnedFor, pinned: pins !== null });
      continue;
    }
    await run.event('self_issued_key_change', `self_issued_key_change:${c.id}`, `Pending pinned email key ${ident(c.kid)} for signer ${ident(c.signer ?? '')} (change ${c.id}): waits until ${iso(c.executable_at_ms)}, never confirmed early`, {
      ...changeDetails(c),
      thumbprint: v.thumbprint,
    });
  }
}

/** `not_pinned` while the pins are unreadable is `pins_unreadable`: the alert then names the config, not a forgery. */
const pinsReason = (run: Run, r: EmailKeyReason | null): EmailKeyReason | null => (r === 'not_pinned' && run.d.config.emailPins.problems.length ? 'pins_unreadable' : r);

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
    const reason = pinsReason(run, v.reason);
    if (!reason) continue;
    const onChain = k.n && k.e ? { n: k.n, e: k.e } : null;
    await forgedActive(run, s, EMAIL_PROVIDER, k.kid, reason, EMAIL_KEY_WHY[reason], onChain, canAct, self, deleted, { signer, thumbprint: v.thumbprint, pinned_for: v.pinnedFor, pinned: pins !== null });
  }
}

/**
 * `get_issuer("email")` and `get_self_issued("email")` against the pins: critical on any difference, pause on a weaker
 * policy (D191). One condition per chain policy state, so a later, different mismatch is a new alert.
 */
async function signerPolicy(run: Run, s: ChainSnapshot, canAct: boolean, self: SelfChanges): Promise<void> {
  run.evaluate('signer_policy_mismatch', 'signer_policy_transition');
  const pins = run.d.config.emailPins.pins;
  const e = s.email;
  const f = policyFindings(pins, e, run.d.now());
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
  const details = { provider: EMAIL_PROVIDER, pinned: pins, chain: { issuer: e.issuer, self_issued: si, pre_v3: !e.hasSelfIssuedView }, differences: f.differences, weaker: f.weaker };
  if (!f.weaker.length && !f.critical.length) {
    // Pins and chain mid-way through a planned change (L5): a warning, no pause, no repeated page.
    await run.condition('signer_policy_transition', `signer_policy_transition:${EMAIL_PROVIDER}:${policyId(e)}`, `Email signer policy in transition: ${f.transition.join('; ')} (no pause)`, details);
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
    ...details,
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
 * D212: an issuer key on chain whose kid is an identity key's thumbprint (the pins, and what Hana published at the last
 * good JWKS read) is critical, alert only. The contract holds RSA keys only, so an identity key's material can't be
 * there; the Google and email rules of this run already cancel or pause on such a kid (Google never published it; an
 * email kid must be its own RSA thumbprint). This says why. Chain data and stored config only: no third-party read.
 */
async function identityOnChain(run: Run, s: ChainSnapshot): Promise<void> {
  const pins = run.d.config.identity.pins.pins ?? [];
  const last = await run.d.store.getMeta<IdentityJwksStatus>(META.identityJwks);
  const thumbprints = new Set([...pins, ...(last?.keys ?? []).flatMap((k) => (k.thumbprint ? [k.thumbprint] : []))]);
  run.evaluate('identity_key_on_chain');
  if (thumbprints.size === 0) {
    run.check('identity_on_chain', 'skipped', 'no identity key pinned or published');
    return;
  }
  const hits = identityKeysOnChain({ issuerKids: s.issuer?.kids ?? [], emailKids: s.email.issuer?.kids ?? [], pending: s.keyChanges }, thumbprints);
  for (const h of hits) {
    const key = h.where === 'pending' ? `identity_key_on_chain:pending:${h.change}` : `identity_key_on_chain:active:${h.provider}:${h.kid}`;
    const what = h.where === 'pending' ? `A pending addition (change ${h.change}) of ${ident(h.provider)} key` : `An active ${h.provider} key`;
    await run.condition('identity_key_on_chain', key, `${what} has identity token key ${h.kid}'s thumbprint as its kid: the contract must never trust an identity key (alert only)`, {
      ...h,
      pinned: pins.includes(h.kid),
    });
  }
  run.check('identity_on_chain', hits.length ? 'alert' : 'ok', `${thumbprints.size} identity thumbprint(s) checked`);
}

/** The first `MAX_LISTED` entries of a list for an alert's details or title. */
const listed = <T>(xs: T[]): T[] => xs.slice(0, MAX_LISTED);
const keyLabel = (k: PublishedKey): string => (k.kid !== null ? ident(k.kid) : k.thumbprint ?? `keys[${k.index}]`);
const keyDetail = (k: PublishedKey) => ({ index: k.index, kid: k.kid, thumbprint: k.thumbprint, reason: k.reason, private: k.private, extra: k.extra });
const DOC_NAME = { jwks: 'JWKS', discovery: 'discovery document' } as const;

/**
 * One of Hana's identity documents, read and checked for what makes it unreadable (D210):
 *   - a network or HTTP error (anything but a 200 or a redirect) adds to its counter; 3 in a row is critical
 *     `identity_jwks_unreadable:<what>:sustained` (selective failure is a way to hide a key from the watchdog);
 *   - an answer that is a redirect (never followed), over the cap, not JSON, or with duplicate members is critical at
 *     once (`identity_jwks_unreadable:<what>:answer:<reason>`): padding or malformed content never downgrades a finding.
 * Returns the parsed value to judge (null when there is none). A failed fetch resolves none of the answer findings.
 */
async function readIdentityDoc(run: Run, what: 'jwks' | 'discovery', fetch: () => Promise<IdentityResponse>, url: string): Promise<{ value: unknown } | null> {
  const metaKey = what === 'jwks' ? META.identityJwksFailures : META.identityDiscoveryFailures;
  const sustainedKey = `identity_jwks_unreadable:${what}:sustained`;
  let failures = (await run.d.store.getMeta<number>(metaKey)) ?? 0;
  let res: IdentityResponse | null = null;
  try {
    res = await fetch();
    failures = 0;
  } catch {
    failures++;
  }
  await run.d.store.setMeta(metaKey, failures);
  run.evaluatePrefix('identity_jwks_unreadable', sustainedKey);
  if (!res) {
    if (failures >= FAILING_RUNS) {
      await run.condition('identity_jwks_unreadable', sustainedKey, `Hana's identity ${DOC_NAME[what]} failed ${failures} fetches in a row: the watchdog can't see what partners are served`, {
        document: what,
        url,
        reason: 'sustained',
        failures,
      });
    }
    return null;
  }
  const answerPrefix = `identity_jwks_unreadable:${what}:answer:`;
  run.evaluatePrefix('identity_jwks_unreadable', answerPrefix);
  const r = readIdentityResponse(res);
  for (const f of r.findings) {
    await run.condition('identity_jwks_unreadable', `${answerPrefix}${f.reason}`, `Hana's identity ${DOC_NAME[what]} can't be judged as published (${f.reason}: ${printable(f.detail)}). No pause: the chain isn't involved`, {
      document: what,
      url,
      reason: f.reason,
      detail: f.detail,
    });
  }
  return r.parsed ? { value: r.value } : null;
}

/** A shape problem of a parsed document: critical at once, like the other unreadable answers. */
async function badShape(run: Run, what: 'jwks' | 'discovery', url: string, problems: string[]): Promise<void> {
  await run.condition('identity_jwks_unreadable', `identity_jwks_unreadable:${what}:answer:bad_shape`, `Hana's identity ${DOC_NAME[what]} has the wrong shape: ${listed(problems).map(printable).join('; ')}. No pause: the chain isn't involved`, {
    document: what,
    url,
    reason: 'bad_shape',
    problems: listed(problems),
  });
}

/**
 * Hana's identity JWKS and discovery document against the pins and the configured issuer (D210, D211, D213, D214).
 * Critical for an unpinned or private key, a wrong issuer or jwks_uri, and an answer that can't be judged; never a
 * pause: the chain is not involved (partners verify identity tokens; the contract never does). Each set of findings
 * is one condition keyed by what it found, so a different finding is a new page, and the list in one alert is
 * bounded. A failed read resolves nothing of what it would judge; an unconfigured check resolves nothing at all.
 */
async function identityJwks(run: Run): Promise<void> {
  const { iss, pins } = run.d.config.identity;
  const f = run.d.fetchIdentity;
  if (!iss || !f) {
    // Never evaluated here: an open identity alert stays open (IDENTITY_PINS without IDENTITY_ISS is a config problem).
    run.check('identity_jwks', 'skipped', 'no identity token configured (IDENTITY_ISS)');
    return;
  }
  const { store } = run.d;
  const at = run.d.now();
  const notes: string[] = [];
  let failed = false;

  // ---- the JWKS ----
  const jwksUrl = identityJwksUrl(iss);
  const doc = await readIdentityDoc(run, 'jwks', f.jwks, jwksUrl);
  const v = doc ? await judgeIdentityJwks(doc.value, pins) : null;
  if (v && v.shapeProblems.length) await badShape(run, 'jwks', jwksUrl, v.shapeProblems);
  if (!v || !v.shapeOk) {
    failed = true;
    notes.push(doc ? 'JWKS has the wrong shape' : 'JWKS not readable');
  } else {
    run.evaluate('identity_key_unpinned', 'identity_private_key_published', 'identity_key_missing');
    await store.setMeta(META.identityJwks, {
      at,
      url: jwksUrl,
      keys: v.keys.slice(0, 50).map((k) => ({ kid: k.kid, thumbprint: k.thumbprint, pinned: k.pinned, private: k.private, reason: k.reason })),
      count: v.keys.length,
      unpinned: v.unpinned.length,
      private: v.privateKeys.length,
      missing: v.missing,
    } satisfies IdentityJwksStatus);
    if (v.unpinned.length) {
      const refs = v.unpinned.map((k) => k.ref).sort();
      const why = pins.problems.length ? "the watchdog's identity pins are unreadable" : !pins.pins ? 'nothing is pinned (watchdog.pinnedIdentityKeys)' : 'not pinned, or not a clean P-256 public key';
      await run.condition(
        'identity_key_unpinned',
        `identity_key_unpinned:${(await sha256b64url(refs.join(','))).slice(0, 16)}`,
        `Hana's identity JWKS publishes ${v.unpinned.length} key(s) the watchdog doesn't accept (${why}): ${listed(v.unpinned).slice(0, 3).map(keyLabel).join(', ')}${v.unpinned.length > 3 ? ', ...' : ''}; partners trusting the JWKS URL accept tokens they sign. No pause: the chain isn't involved`,
        { url: jwksUrl, count: v.unpinned.length, keys: listed(v.unpinned).map(keyDetail), pinned: pins.pins, published: v.keys.length },
      );
    }
    if (v.privateKeys.length) {
      const refs = v.privateKeys.map((k) => k.ref).sort();
      await run.condition(
        'identity_private_key_published',
        `identity_private_key_published:${(await sha256b64url(refs.join(','))).slice(0, 16)}`,
        `Hana's identity JWKS publishes private key material for ${v.privateKeys.length} key(s): ${listed(v.privateKeys).slice(0, 3).map(keyLabel).join(', ')}${v.privateKeys.length > 3 ? ', ...' : ''}; anyone can sign identity tokens with them. No pause: the chain isn't involved`,
        // The members' names only: the stored alert never holds the private values.
        { url: jwksUrl, count: v.privateKeys.length, keys: listed(v.privateKeys).map(keyDetail) },
      );
    }
    for (const m of v.missing) {
      const how = m.reason === 'kid_differs' ? 'is published under another kid' : m.reason === 'not_clean' ? 'is published with members beyond the public ones' : 'is not published';
      await run.condition('identity_key_missing', `identity_key_missing:${m.thumbprint}`, `Pinned identity key ${m.thumbprint} ${how} in Hana's identity JWKS`, { url: jwksUrl, ...m });
    }
    notes.push(`${v.keys.length} published, ${v.unpinned.length} unpinned, ${v.privateKeys.length} with private members, ${v.missing.length} pinned missing`);
  }

  // ---- the discovery document ----
  const discoveryUrl = identityDiscoveryUrl(iss);
  const ddoc = await readIdentityDoc(run, 'discovery', f.discovery, discoveryUrl);
  const dv = ddoc ? judgeDiscovery(ddoc.value, iss) : null;
  if (ddoc && dv && !dv.shapeOk) await badShape(run, 'discovery', discoveryUrl, ['the discovery document is not a JSON object']);
  if (!dv || !dv.shapeOk) {
    failed = true;
    notes.push(ddoc ? 'discovery has the wrong shape' : 'discovery not readable');
  } else {
    run.evaluate('identity_discovery_mismatch');
    await store.setMeta(META.identityDiscovery, { at, url: discoveryUrl, issuer: dv.issuer, jwks_uri: dv.jwks_uri, problems: dv.problems } satisfies IdentityDiscoveryStatus);
    for (const p of dv.problems) {
      const shown = p.published === null ? 'none' : ident(p.published);
      await run.condition(
        'identity_discovery_mismatch',
        `identity_discovery_mismatch:${p.field}:${(await sha256b64url(String(p.published))).slice(0, 16)}`,
        `Hana's identity discovery document has ${p.field} ${shown}, not ${p.expected}. No pause: the chain isn't involved`,
        { url: discoveryUrl, ...p },
      );
    }
    notes.push(dv.problems.length ? `discovery differs: ${dv.problems.map((p) => p.field).join(', ')}` : 'discovery ok');
  }
  const alerted = run.checks.get('identity_jwks')?.outcome === 'alert';
  run.check('identity_jwks', alerted ? 'alert' : failed ? 'error' : 'ok', notes.join('; '));
}

/** D139: `unrecorded_wallets` must never be true outside a dev env (critical, alert only). Chain data only. */
async function unrecordedWallets(run: Run, s: ChainSnapshot): Promise<void> {
  const cfg = run.d.config;
  run.evaluate('unrecorded_wallets');
  if (s.config.unrecorded_wallets !== true) return;
  if (cfg.devEnv) {
    run.check('governance_diff', 'ok', 'unrecorded_wallets is true (a dev env: allowed until accept_unrecorded_wallets)');
    return;
  }
  await run.condition('unrecorded_wallets', 'unrecorded_wallets', `unrecorded_wallets is true on ${ident(cfg.envName)}, which is not a dev env: links are refused until the owner accepts, and mainnet must never show it`, {
    env: cfg.envName,
    signer: cfg.signer,
  });
}

/**
 * D200: the contract counts every new link per scope and in total in fixed UTC-hour windows and flags a scope, or the
 * total, whose links reach its alarm threshold; nothing is refused. `get_link_stats()` reports the current and the
 * previous window, so a threshold reached between two runs is still seen. A threshold reached is critical (alert
 * only: the links went through, the council decides whether to pause); the current total at half the total
 * threshold is a warning. A contract without the view reads as "no link stats": quiet while no email
 * issuer is on chain (no link is possible), a warning once one is.
 */
async function linkStats(run: Run, s: ChainSnapshot): Promise<void> {
  // Without a good read the link state is unknown: only `link_stats_unavailable` is judged, so open threshold and volume
  // alerts stay open until a good read says otherwise (never resolved by a broken or missing view).
  run.evaluate('link_stats_unavailable');
  const v = s.linkStats;
  const emailLive = s.email.issuer !== null || s.email.selfIssued !== null;
  if (s.linkStatsProblem) {
    // Only this check is affected: the snapshot and every protective step ran on the rest of the chain read.
    const why = s.linkStatsProblem === 'malformed' ? 'answered in an unexpected shape' : 'failed';
    await run.condition('link_stats_unavailable', `link_stats_unavailable:${s.linkStatsProblem}`, `get_link_stats ${why}: links per hour are not monitored this run (the contract still counts them)`, {
      reason: s.linkStatsProblem,
      signer: run.d.config.signer,
    });
    run.check('links', 'error', `get_link_stats ${why}`);
    return;
  }
  if (!v) {
    if (emailLive) {
      await run.condition('link_stats_unavailable', 'link_stats_unavailable:missing', 'An email issuer is on chain but the contract has no get_link_stats: links per hour are neither counted nor monitored (D200)', { reason: 'missing', signer: run.d.config.signer });
    } else run.check('links', 'skipped', 'no get_link_stats (pre-D200 contract) and no email issuer: no link possible');
    return;
  }
  run.evaluate('link_threshold_reached', 'link_volume_high');
  await run.d.store.setMeta(META.linkStats, { at: run.d.now(), ...v });
  const lim = v.thresholds;
  for (const w of [v.current, v.previous]) {
    if (!w) continue;
    const window = { window_start_ms: w.window_start_ms, window_ms: v.window_ms, thresholds: lim };
    if (w.total_threshold_reached) {
      await run.condition('link_threshold_reached', `link_threshold_reached:total:${w.window_start_ms}`, `${w.total} links went through in all scopes in the hour from ${iso(w.window_start_ms)}: the alarm threshold of ${lim.total_per_hour} was reached (nothing was refused)`, {
        ...window,
        scope: null,
        total: w.total,
      });
    }
    for (const scope of w.flagged_scopes) {
      await run.condition('link_threshold_reached', `link_threshold_reached:scope:${scope}:${w.window_start_ms}`, `Links in scope ${ident(scope)} reached the alarm threshold of ${lim.per_scope_per_hour} in the hour from ${iso(w.window_start_ms)}; they went through (nothing was refused)`, {
        ...window,
        scope,
        total: w.total,
      });
    }
    if (w.flagged_scopes_truncated) {
      await run.condition('link_threshold_reached', `link_threshold_reached:more_scopes:${w.window_start_ms}`, `More scopes reached the link alarm threshold in the hour from ${iso(w.window_start_ms)} than the view lists (their links went through)`, { ...window, listed: w.flagged_scopes });
    }
  }
  const c = v.current;
  if (lim.total_per_hour > 0 && c.total >= lim.total_per_hour * LINK_VOLUME_WARN_SHARE && !c.total_threshold_reached) {
    await run.condition('link_volume_high', `link_volume_high:${c.window_start_ms}`, `${c.total} new links this hour, at least half the total alarm threshold of ${lim.total_per_hour}`, {
      window_start_ms: c.window_start_ms,
      total: c.total,
      thresholds: lim,
    });
  }
  run.check('links', 'ok', `${c.total} new link(s) this hour (alarm thresholds ${lim.per_scope_per_hour} per scope, ${lim.total_per_hour} in all); ${v.links_total} in all time`);
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
