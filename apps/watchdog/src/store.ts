// The watchdog's D1 state (migrations/0001_init.sql, 0002_link_events.sql). Everything here is public data: kids, key material, change
// ids, transaction hashes, alert texts built from on-chain values.
import type { Jwk } from '@hana-id/jwks';
import { ALERT_KINDS, type AlertKind, type Channel, type CheckId, type Severity } from './checks.ts';
import type { LinkEvent } from './links.ts';

export interface SeenKid {
  provider: string;
  kid: string;
  n: string | null;
  e: string | null;
  source: 'jwks' | 'baseline';
  first_seen_at: number;
  last_seen_at: number | null;
}

export interface AlertRow {
  id: number;
  key: string;
  kind: AlertKind;
  severity: Severity;
  title: string;
  details: Record<string, unknown>;
  run_id: number | null;
  created_at: number;
  resolved_at: number | null;
  pending_channels: Channel[];
  last_sent_at: number | null;
  send_count: number;
  pager_ref: string | null;
  acked_at: number | null;
  acked_by: string | null;
  acked_via: 'portal' | 'pager' | null;
}

export interface ActionRow {
  id: number;
  run_id: number;
  at: number;
  method: string;
  args: Record<string, unknown>;
  reason: string;
  ok: boolean;
  tx_hash: string | null;
  error: string | null;
}

export interface CheckResult {
  id: CheckId;
  outcome: 'ok' | 'alert' | 'skipped' | 'error';
  detail?: string;
}

export interface RunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  outcome: 'ok' | 'degraded' | 'error' | null;
  first_run: boolean;
  checks: CheckResult[];
}

type RawAlert = Omit<AlertRow, 'details' | 'pending_channels'> & { details: string; pending_channels: string };
type RawAction = Omit<ActionRow, 'args' | 'ok'> & { args: string; ok: number };
type RawRun = Omit<RunRow, 'checks' | 'first_run'> & { checks: string; first_run: number };

const alertRow = (r: RawAlert): AlertRow => ({ ...r, details: JSON.parse(r.details) as Record<string, unknown>, pending_channels: JSON.parse(r.pending_channels) as Channel[] });
const actionRow = (r: RawAction): ActionRow => ({ ...r, args: JSON.parse(r.args) as Record<string, unknown>, ok: r.ok === 1 });
const runRow = (r: RawRun): RunRow => ({ ...r, first_run: r.first_run === 1, checks: JSON.parse(r.checks) as CheckResult[] });

/** Runs older than this are pruned (alerts, actions and deliveries are history and kept). */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class Store {
  constructor(private readonly db: D1Database) {}

  // ---- meta ----

  async getMeta<T>(key: string): Promise<T | null> {
    const row = await this.db.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
  }

  /**
   * Takes the run lock unless another run holds a lock younger than `staleMs` (cron invocations can overlap when a
   * run waits on the absence re-check and transactions). One statement, so two runs can't both take it.
   */
  async acquireLock(runId: number, now: number, staleMs: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('run_lock', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value
         WHERE json_extract(meta.value, '$.at') <= ?2`,
      )
      .bind(JSON.stringify({ runId, at: now }), now - staleMs)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async releaseLock(runId: number): Promise<void> {
    await this.db.prepare(`DELETE FROM meta WHERE key = 'run_lock' AND json_extract(value, '$.runId') = ?1`).bind(runId).run();
  }

  // ---- kids ----

  async seenKids(provider: string): Promise<Map<string, SeenKid>> {
    const rows = await this.db.prepare('SELECT * FROM seen_kids WHERE provider = ?1').bind(provider).all<SeenKid>();
    return new Map(rows.results.map((r) => [r.kid, r]));
  }

  async allSeenKids(): Promise<SeenKid[]> {
    return (await this.db.prepare('SELECT * FROM seen_kids ORDER BY first_seen_at, provider, kid').all<SeenKid>()).results;
  }

  /** Records one JWKS fetch: new kids with their material (first sighting), last_seen for all. */
  async recordJwks(provider: string, keys: Jwk[], at: number): Promise<void> {
    if (keys.length === 0) return;
    await this.db.batch(
      keys.map((k) =>
        this.db
          .prepare(
            `INSERT INTO seen_kids (provider, kid, n, e, source, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 'jwks', ?5, ?5)
             ON CONFLICT (provider, kid) DO UPDATE SET last_seen_at = excluded.last_seen_at,
               n = COALESCE(seen_kids.n, excluded.n), e = COALESCE(seen_kids.e, excluded.e)`,
          )
          .bind(provider, k.kid, k.n, k.e, at),
      ),
    );
  }

  /** First run only: an active kid Google doesn't list now, recorded so later runs don't pause on it. */
  async addBaselineKid(provider: string, kid: string, n: string | null, e: string | null, at: number): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO seen_kids (provider, kid, n, e, source, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 'baseline', ?5, NULL)`)
      .bind(provider, kid, n, e, at)
      .run();
  }

  async absences(provider: string): Promise<Map<string, number>> {
    const rows = await this.db.prepare('SELECT kid, first_absent_at FROM absences WHERE provider = ?1').bind(provider).all<{ kid: string; first_absent_at: number }>();
    return new Map(rows.results.map((r) => [r.kid, r.first_absent_at]));
  }

  async recordAbsent(provider: string, kid: string, at: number): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO absences (provider, kid, first_absent_at) VALUES (?1, ?2, ?3)').bind(provider, kid, at).run();
  }

  async clearAbsent(provider: string, kid: string): Promise<void> {
    await this.db.prepare('DELETE FROM absences WHERE provider = ?1 AND kid = ?2').bind(provider, kid).run();
  }

  // ---- runs ----

  async startRun(at: number): Promise<number> {
    const row = await this.db.prepare('INSERT INTO runs (started_at) VALUES (?1) RETURNING id').bind(at).first<{ id: number }>();
    if (!row) throw new Error('run insert failed');
    return row.id;
  }

  async finishRun(id: number, at: number, outcome: 'ok' | 'degraded' | 'error', firstRun: boolean, checks: CheckResult[]): Promise<void> {
    await this.db.prepare('UPDATE runs SET finished_at = ?2, outcome = ?3, first_run = ?4, checks = ?5 WHERE id = ?1').bind(id, at, outcome, firstRun ? 1 : 0, JSON.stringify(checks)).run();
  }

  async lastRun(): Promise<RunRow | null> {
    const row = await this.db.prepare('SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').first<RawRun>();
    return row ? runRow(row) : null;
  }

  async runsSince(at: number): Promise<RunRow[]> {
    return (await this.db.prepare('SELECT * FROM runs WHERE started_at >= ?1 ORDER BY id').bind(at).all<RawRun>()).results.map(runRow);
  }

  async pruneRuns(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM runs WHERE started_at < ?1').bind(now - RUN_RETENTION_MS).run();
  }

  // ---- actions ----

  async recordAction(a: Omit<ActionRow, 'id'>): Promise<number> {
    const row = await this.db
      .prepare('INSERT INTO actions (run_id, at, method, args, reason, ok, tx_hash, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id')
      .bind(a.run_id, a.at, a.method, JSON.stringify(a.args), a.reason, a.ok ? 1 : 0, a.tx_hash, a.error)
      .first<{ id: number }>();
    if (!row) throw new Error('action insert failed');
    return row.id;
  }

  /** Newest first; `before` is an action id cursor. */
  async listActions(before: number | null, limit: number): Promise<ActionRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM actions WHERE (?1 IS NULL OR id < ?1) ORDER BY id DESC LIMIT ?2')
      .bind(before, limit)
      .all<RawAction>();
    return rows.results.map(actionRow);
  }

  async actionsSince(at: number): Promise<ActionRow[]> {
    return (await this.db.prepare('SELECT * FROM actions WHERE at >= ?1 ORDER BY id').bind(at).all<RawAction>()).results.map(actionRow);
  }

  // ---- link events ----

  /** Records link events; an id seen before is ignored (a scan may re-read a block). */
  async recordLinkEvents(events: LinkEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.batch(
      events.map((e) =>
        this.db
          .prepare('INSERT INTO link_events (id, event, scope_id, provider, auto, at, block_height) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (id) DO NOTHING')
          .bind(e.id, e.event, e.scope_id, e.provider, e.auto === null ? null : e.auto ? 1 : 0, e.at, e.block_height),
      ),
    );
  }

  /** Link events since `at` (block time), counted per scope, event and auto flag. */
  async linkCounts(at: number): Promise<{ scope_id: string; event: string; auto: number | null; n: number }[]> {
    const rows = await this.db
      .prepare('SELECT scope_id, event, auto, COUNT(*) AS n FROM link_events WHERE at >= ?1 GROUP BY scope_id, event, auto ORDER BY scope_id, event')
      .bind(at)
      .all<{ scope_id: string; event: string; auto: number | null; n: number }>();
    return rows.results;
  }

  /** Drops events older than `before` and any dated after `after` (bad data from the indexer). */
  async pruneLinkEvents(before: number, after: number): Promise<void> {
    await this.db.prepare('DELETE FROM link_events WHERE at < ?1 OR at > ?2').bind(before, after).run();
  }

  // ---- alerts ----

  /** An alert with this key whose condition still holds (event alerts are resolved at creation). */
  async openAlert(key: string): Promise<AlertRow | null> {
    const row = await this.db.prepare('SELECT * FROM alerts WHERE key = ?1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').bind(key).first<RawAlert>();
    return row ? alertRow(row) : null;
  }

  async alertExists(key: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 AS x FROM alerts WHERE key = ?1 LIMIT 1').bind(key).first()) !== null;
  }

  async createAlert(a: { key: string; kind: AlertKind; title: string; details: Record<string, unknown>; runId: number | null; at: number; condition: boolean; channels: Channel[] }): Promise<number> {
    const severity = ALERT_KINDS[a.kind].severity;
    const row = await this.db
      .prepare('INSERT INTO alerts (key, kind, severity, title, details, run_id, created_at, resolved_at, pending_channels) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id')
      .bind(a.key, a.kind, severity, a.title, JSON.stringify(a.details), a.runId, a.at, a.condition ? null : a.at, JSON.stringify(a.channels))
      .first<{ id: number }>();
    if (!row) throw new Error('alert insert failed');
    return row.id;
  }

  async updateAlertDetails(id: number, details: Record<string, unknown>): Promise<void> {
    await this.db.prepare('UPDATE alerts SET details = ?2 WHERE id = ?1').bind(id, JSON.stringify(details)).run();
  }

  /**
   * Resolves open condition alerts of the evaluated kinds whose key isn't in `keep`. A kind evaluated only in part
   * (`string[]`: key prefixes, e.g. the email half of `forged_active_key` in a run whose Google half was skipped)
   * resolves only keys with one of those prefixes.
   */
  async resolveConditions(evaluated: Map<AlertKind, 'all' | string[]>, keep: Set<string>, at: number): Promise<number> {
    const kinds = [...evaluated.keys()];
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map((_, i) => `?${i + 1}`).join(', ');
    const open = await this.db.prepare(`SELECT id, key, kind FROM alerts WHERE resolved_at IS NULL AND kind IN (${placeholders})`).bind(...kinds).all<{ id: number; key: string; kind: AlertKind }>();
    const inScope = (r: { key: string; kind: AlertKind }) => {
      const scope = evaluated.get(r.kind);
      return scope === 'all' || (scope ?? []).some((p) => r.key.startsWith(p));
    };
    const ids = open.results.filter((r) => !keep.has(r.key) && inScope(r)).map((r) => r.id);
    if (ids.length) await this.db.batch(ids.map((id) => this.db.prepare('UPDATE alerts SET resolved_at = ?2 WHERE id = ?1').bind(id, at)));
    return ids.length;
  }

  async getAlert(id: number): Promise<AlertRow | null> {
    const row = await this.db.prepare('SELECT * FROM alerts WHERE id = ?1').bind(id).first<RawAlert>();
    return row ? alertRow(row) : null;
  }

  /** Newest first; `before` is an alert id cursor. */
  async listAlerts(before: number | null, limit: number, severity: Severity | null = null): Promise<AlertRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM alerts WHERE (?1 IS NULL OR id < ?1) AND (?3 IS NULL OR severity = ?3) ORDER BY id DESC LIMIT ?2')
      .bind(before, limit, severity)
      .all<RawAlert>();
    return rows.results.map(alertRow);
  }

  async alertsSince(at: number): Promise<AlertRow[]> {
    return (await this.db.prepare('SELECT * FROM alerts WHERE created_at >= ?1 ORDER BY id').bind(at).all<RawAlert>()).results.map(alertRow);
  }

  /** Alerts that still need a send: a first delivery outstanding, or critical and unacknowledged. */
  async alertsToDeliver(): Promise<AlertRow[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM alerts WHERE pending_channels != '[]' OR (severity = 'critical' AND acked_at IS NULL) ORDER BY id`)
      .all<RawAlert>();
    return rows.results.map(alertRow);
  }

  /** Unacknowledged critical alerts and open conditions. */
  async openAlerts(): Promise<AlertRow[]> {
    const rows = await this.db.prepare(`SELECT * FROM alerts WHERE (severity = 'critical' AND acked_at IS NULL) OR resolved_at IS NULL ORDER BY id DESC LIMIT 200`).all<RawAlert>();
    return rows.results.map(alertRow);
  }

  /** After a send: `lastSentAt` starts the re-send clock, `round` counts a full round in `send_count`. */
  async markSent(id: number, lastSentAt: number | null, round: boolean, pending: Channel[], pagerRef: string | null): Promise<void> {
    await this.db
      .prepare('UPDATE alerts SET last_sent_at = ?2, send_count = send_count + ?5, pending_channels = ?3, pager_ref = COALESCE(?4, pager_ref) WHERE id = ?1')
      .bind(id, lastSentAt, JSON.stringify(pending), pagerRef, round ? 1 : 0)
      .run();
  }

  /** Gives up the outstanding first deliveries (logged by the caller; the alert stays in the history). */
  async clearPending(id: number): Promise<void> {
    await this.db.prepare(`UPDATE alerts SET pending_channels = '[]' WHERE id = ?1`).bind(id).run();
  }

  /** Records an acknowledgement once; returns false if the alert was already acknowledged. */
  async ack(id: number, by: string, via: 'portal' | 'pager', at: number): Promise<boolean> {
    const res = await this.db.prepare('UPDATE alerts SET acked_at = ?2, acked_by = ?3, acked_via = ?4 WHERE id = ?1 AND acked_at IS NULL').bind(id, at, by, via).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async recordDelivery(d: { alertId: number | null; channel: Channel; kind: 'first' | 'resend' | 'digest'; at: number; ok: boolean; error: string | null }): Promise<void> {
    await this.db
      .prepare('INSERT INTO deliveries (alert_id, channel, kind, at, ok, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(d.alertId, d.channel, d.kind, d.at, d.ok ? 1 : 0, d.error)
      .run();
  }

  async deliveries(alertId: number): Promise<{ channel: Channel; kind: string; at: number; ok: boolean; error: string | null }[]> {
    const rows = await this.db.prepare('SELECT channel, kind, at, ok, error FROM deliveries WHERE alert_id = ?1 ORDER BY id').bind(alertId).all<{ channel: Channel; kind: string; at: number; ok: number; error: string | null }>();
    return rows.results.map((r) => ({ ...r, ok: r.ok === 1 }));
  }
}
