// The JWKS cron (every 15 min): keeps hana-signer's issuer keys in step with Google's published JWKS through the
// contract's delayed key changes (docs/governance-spec.md "Rotation and logins", D33). It signs with the keys-updater
// key, a function-call key on SIGNER_ACCOUNT limited to UPDATER_METHODS, and only ever:
//   - proposes an Add (`set_issuer_key`) for a kid Google publishes that is neither active nor pending on chain;
//   - proposes a Remove (`propose_issuer_key_removal`) for an active kid missing from every fetch for ≥ 24 h, never
//     one that signed a verified token in the last 24 h and never the issuer's last key (rollout hysteresis, D420);
//   - executes (`execute_issuer_key_change`) a matured change that agrees with the JWKS it just fetched: an Add whose
//     n and e equal Google's key for that kid, a Remove of a kid Google no longer publishes. Anything else is left for
//     the watchdog and the owner (the cron can't cancel, by design).
// It never calls `remove_issuer_key` (owner-only). A change of ours that disappears without being applied was
// cancelled (owner or watchdog): it is logged once and not proposed again for REPROPOSE_AFTER_CANCEL_MS. Each run
// fetches the JWKS JWKS_FETCHES_PER_RUN times: Google's edges serve different key sets during a rollout (seen
// 2026-11-03..05, D420), so a kid any fetch lists counts as published, and a kid counts as missing only when every
// fetch succeeded and none listed it. The union is recorded for the key lead-time measurement (key-observations.ts).
import { type Jwk, GOOGLE_JWKS_URL, GOOGLE_PROVIDER, usableJwks } from '@hana-id/jwks';
import { base64UrlDecode } from './bytes.ts';
import type { Env } from './env.ts';
import { cacheMaxAgeS, recordJwksObservation } from './key-observations.ts';
import { log } from './log.ts';
import { Rpc, invalidNonce, isDefiniteRejection, type SendTxResult } from './near/rpc.ts';
import { type ContractCall, parseKeyPair, signFunctionCall, waitForOutcome } from './near/tx.ts';
import { type UpdaterMethod, updaterAllows } from './relayer-config.ts';

// The JWKS parsing is shared with apps/watchdog (packages/jwks).
export { GOOGLE_JWKS_URL, GOOGLE_PROVIDER, type Jwk, usableJwks } from '@hana-id/jwks';

/**
 * JWKS fetches per run. Google's frontends answer from different caches (each up to ~6 h old): during a rollout some
 * list a new kid and some don't, so one fetch is weak evidence of absence (D420).
 */
export const JWKS_FETCHES_PER_RUN = 3;
/**
 * A kid is proposed for removal only once every run's every fetch has missed it for this long (first seen missing by
 * a complete run, missing from every complete run since): a key left on chain a day longer is harmless (Google stops
 * signing with a key before it stops publishing it), a key removed early breaks logins (D420, was 55 min).
 */
export const REMOVE_AFTER_MISSING_MS = 24 * 60 * 60_000;
/** Never propose or execute the removal of a kid that signed a verified token within this window (D420). */
export const KEEP_AFTER_LAST_TOKEN_MS = 24 * 60 * 60_000;
/** After a proposal of ours was cancelled on chain, the same kid and op is not proposed again for this long. */
export const REPROPOSE_AFTER_CANCEL_MS = 60 * 60_000;
/** The contract's caps (docs/contract-interface.md "Limits"): checked here so a run never sends a doomed proposal. */
export const MAX_PENDING_KEY_CHANGES = 6;
export const MAX_KEYS_PER_ISSUER = 10;
/** Ample for a key proposal or execution (~3 Tgas burnt; docs/contract-interface.md). */
const ISSUER_KEY_GAS = 30_000_000_000_000n;


/** `get_issuer(provider)` → active kids. Accepts `{kids: [...]}`, `{keys: [...]}` or a bare array; null when unknown. */
export function issuerKids(view: unknown): string[] | null {
  const list = Array.isArray(view) ? view : (view as { kids?: unknown; keys?: unknown } | null)?.kids ?? (view as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return null;
  return list.filter((k): k is string => typeof k === 'string');
}

/** A pending key change as `get_key_changes()` returns it (docs/contract-interface.md "Types"). */
export interface KeyChange {
  id: number;
  provider: string;
  kid: string;
  op: 'Add' | 'Remove';
  /** JWK base64url, leading zeros stripped; null for a Remove. */
  n: string | null;
  e: string | null;
  by: string;
  proposed_at_ms: number;
  executable_at_ms: number;
}

const isKeyChange = (v: unknown): v is KeyChange => {
  const c = v as Partial<KeyChange> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    Number.isSafeInteger(c.id) &&
    typeof c.provider === 'string' &&
    typeof c.kid === 'string' &&
    (c.op === 'Add' ? typeof c.n === 'string' && typeof c.e === 'string' : c.op === 'Remove') &&
    typeof c.by === 'string' &&
    typeof c.proposed_at_ms === 'number' &&
    typeof c.executable_at_ms === 'number'
  );
};

/**
 * `get_key_changes()` → pending changes, or null when the answer isn't a list of well-formed changes (the run then
 * proposes nothing: counts and pending kids it can't read would only produce doomed transactions).
 */
export function parseKeyChanges(view: unknown): KeyChange[] | null {
  if (!Array.isArray(view) || !view.every(isKeyChange)) return null;
  return view.map((c) => ({ ...c, n: c.n ?? null, e: c.e ?? null }));
}

/** base64url or base64 (as the contract accepts both) → bytes with leading zeros stripped, or null if malformed. */
function keyBytes(part: string): Uint8Array | null {
  try {
    const bytes = base64UrlDecode(part.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, ''));
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    return bytes.subarray(i);
  } catch {
    return null;
  }
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The same RSA key: equal modulus and exponent after stripping leading zeros (the contract stores them stripped). */
export function sameKeyMaterial(a: { n: string | null; e: string | null }, b: { n: string | null; e: string | null }): boolean {
  if (a.n === null || a.e === null || b.n === null || b.e === null) return false;
  return sameBytes(keyBytes(a.n), keyBytes(b.n)) && sameBytes(keyBytes(a.e), keyBytes(b.e));
}

/** Something a run saw and left alone, logged (warn or error) and returned in SyncResult.notes. */
export interface SyncNote {
  code:
    | 'paused' // the contract is paused: matured changes can't be executed
    | 'unpublished_change' // a matured Add for a kid the JWKS doesn't list, or lists with other key material
    | 'removal_of_published_kid' // a pending Remove of a kid Google still publishes
    | 'pending_mismatch' // a pending Add whose key material differs from Google's for that kid
    | 'held_after_cancel' // our proposal for this kid and op was cancelled less than REPROPOSE_AFTER_CANCEL_MS ago
    | 'queue_full' // MAX_PENDING_KEY_CHANGES reached
    | 'issuer_full' // active + pending additions would exceed MAX_KEYS_PER_ISSUER
    | 'last_key_kept' // removing it would leave the issuer without an active key
    | 'recent_token_kept' // a verified token was signed with it less than KEEP_AFTER_LAST_TOKEN_MS ago
    | 'removal_evidence_incomplete' // not every fetch of this run succeeded, or the token sightings couldn't be read
    | 'execute_raced'; // the change was applied or cancelled by someone else between our read and our execute
  kid: string;
  id?: number;
}

const NOTE_LEVEL: Readonly<Record<SyncNote['code'], 'warn' | 'error'>> = {
  paused: 'warn',
  unpublished_change: 'error',
  removal_of_published_kid: 'warn',
  pending_mismatch: 'error',
  held_after_cancel: 'warn',
  queue_full: 'warn',
  issuer_full: 'warn',
  last_key_kept: 'warn',
  recent_token_kept: 'warn',
  removal_evidence_incomplete: 'warn',
  execute_raced: 'warn',
};

export interface SyncPlan {
  /** Matured changes of this provider that agree with the JWKS, in id order. */
  execute: KeyChange[];
  /** Adds to propose. */
  propose: Jwk[];
  /** Kids to propose for removal. */
  proposeRemoval: string[];
  notes: SyncNote[];
}

export interface PlanInput {
  provider: string;
  /** Google's usable keys listed by any of this run's fetches (non-empty). */
  jwks: Jwk[];
  /** Active kids on chain (`get_issuer`). */
  active: readonly string[];
  /** Every pending change, all providers (`get_key_changes`): the queue cap counts them all. */
  changes: readonly KeyChange[];
  paused: boolean;
  now: number;
  /** Active kids missing from the JWKS for at least REMOVE_AFTER_MISSING_MS (dueForRemoval). */
  dueRemovals: readonly string[];
  /** `${op}:${kid}` of our proposals cancelled less than REPROPOSE_AFTER_CANCEL_MS ago. */
  held: ReadonlySet<string>;
  /**
   * Whether this run may judge a kid absent: every fetch succeeded and the token sightings were read. Without it no
   * Remove is proposed or executed (default true for callers that pass a single complete fetch).
   */
  removalEvidence?: boolean;
  /** Kids that signed a verified token less than KEEP_AFTER_LAST_TOKEN_MS ago (never removed). */
  recentTokens?: ReadonlySet<string>;
}

/**
 * What one run does, from what it read. Pure. Proposals are judged against the state before this run's executions
 * (a kid with any pending change, matured or not, gets no new proposal; the caps count every pending change), so a
 * failed execution can't make a proposal doomed; what the executions free up is used by the next run.
 */
export function planIssuerKeySync(input: PlanInput): SyncPlan {
  const { provider, now } = input;
  const notes: SyncNote[] = [];
  const active = new Set(input.active);
  const mine = input.changes.filter((c) => c.provider === provider).sort((a, b) => a.id - b.id);
  const pendingByKid = new Map(mine.map((c) => [c.kid, c]));
  const published = new Map<string, Jwk>();
  for (const k of input.jwks) if (!published.has(k.kid)) published.set(k.kid, k);
  const evidence = input.removalEvidence ?? true;
  const recentTokens = input.recentTokens ?? new Set<string>();

  const execute: KeyChange[] = [];
  const matured = mine.filter((c) => c.executable_at_ms <= now);
  if (input.paused && matured.length > 0) notes.push({ code: 'paused', kid: matured[0]!.kid, id: matured[0]!.id });
  // Active keys once the executions so far applied, so a matured Remove never runs into the last-key check.
  let live = active.size;
  for (const c of mine) {
    const jwk = published.get(c.kid);
    if (c.op === 'Add' && jwk && !sameKeyMaterial(jwk, c)) notes.push({ code: 'pending_mismatch', kid: c.kid, id: c.id });
    if (c.op === 'Remove' && jwk) notes.push({ code: 'removal_of_published_kid', kid: c.kid, id: c.id });
    if (c.executable_at_ms > now || input.paused) continue;
    if (c.op === 'Add') {
      if (jwk && sameKeyMaterial(jwk, c)) {
        execute.push(c);
        live++;
      } else if (!jwk) notes.push({ code: 'unpublished_change', kid: c.kid, id: c.id });
    } else if (!jwk) {
      if (!evidence) notes.push({ code: 'removal_evidence_incomplete', kid: c.kid, id: c.id });
      else if (recentTokens.has(c.kid)) notes.push({ code: 'recent_token_kept', kid: c.kid, id: c.id });
      else if (live <= 1) notes.push({ code: 'last_key_kept', kid: c.kid, id: c.id });
      else {
        execute.push(c);
        live--;
      }
    }
  }

  let pendingTotal = input.changes.length;
  let pendingAdds = mine.filter((c) => c.op === 'Add').length;
  let pendingRemovals = mine.filter((c) => c.op === 'Remove').length;

  const propose: Jwk[] = [];
  for (const jwk of published.values()) {
    if (active.has(jwk.kid) || pendingByKid.has(jwk.kid)) continue;
    if (input.held.has(`Add:${jwk.kid}`)) notes.push({ code: 'held_after_cancel', kid: jwk.kid });
    else if (pendingTotal >= MAX_PENDING_KEY_CHANGES) notes.push({ code: 'queue_full', kid: jwk.kid });
    else if (active.size + pendingAdds >= MAX_KEYS_PER_ISSUER) notes.push({ code: 'issuer_full', kid: jwk.kid });
    else {
      propose.push(jwk);
      pendingTotal++;
      pendingAdds++;
    }
  }

  const proposeRemoval: string[] = [];
  for (const kid of evidence ? input.dueRemovals : []) {
    if (!active.has(kid) || published.has(kid) || pendingByKid.has(kid)) continue;
    if (recentTokens.has(kid)) notes.push({ code: 'recent_token_kept', kid });
    else if (input.held.has(`Remove:${kid}`)) notes.push({ code: 'held_after_cancel', kid });
    else if (active.size - pendingRemovals <= 1) notes.push({ code: 'last_key_kept', kid });
    else if (pendingTotal >= MAX_PENDING_KEY_CHANGES) notes.push({ code: 'queue_full', kid });
    else {
      proposeRemoval.push(kid);
      pendingTotal++;
      pendingRemovals++;
    }
  }
  return { execute, propose, proposeRemoval, notes };
}

/** One JWKS fetch: its usable keys and the response's Cache-Control max-age (seconds, null without one). Throws on HTTP or JSON errors. */
async function fetchUsableJwks(jwksUrl: string): Promise<{ keys: Jwk[]; maxAgeS: number | null }> {
  const res = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { keys: usableJwks(await res.json()), maxAgeS: cacheMaxAgeS(res.headers.get('cache-control')) };
}

export interface SyncResult {
  /** Kids whose Add was proposed (`set_issuer_key`). */
  proposed: string[];
  /** Kids whose Remove was proposed (`propose_issuer_key_removal`). */
  removalsProposed: string[];
  /** Change ids executed (`execute_issuer_key_change`). */
  executed: number[];
  /** `<method>:<kid or change id>` of every call that failed. */
  failed: string[];
  /** `<op>:<kid>` of our proposals first seen cancelled in this run. */
  cancelled: string[];
  notes: SyncNote[];
  skipped?: string;
}

const emptyResult = (): SyncResult => ({ proposed: [], removalsProposed: [], executed: [], failed: [], cancelled: [], notes: [] });

/**
 * Applies the removal grace period: records when each kid in `missing` was first seen missing, forgets kids that are
 * no longer missing, and returns the kids missing for at least REMOVE_AFTER_MISSING_MS. Returns [] (remove nothing)
 * when D1 can't be used.
 */
export async function dueForRemoval(db: D1Database, provider: string, missing: string[], now: number): Promise<string[]> {
  try {
    const rows = await db.prepare('SELECT kid, first_missing_at FROM issuer_key_missing WHERE provider = ?1').bind(provider).all<{ kid: string; first_missing_at: number }>();
    const since = new Map(rows.results.map((r) => [r.kid, r.first_missing_at]));
    const stmts: D1PreparedStatement[] = [];
    for (const kid of since.keys()) {
      if (!missing.includes(kid)) stmts.push(db.prepare('DELETE FROM issuer_key_missing WHERE provider = ?1 AND kid = ?2').bind(provider, kid));
    }
    for (const kid of missing) {
      if (!since.has(kid)) stmts.push(db.prepare('INSERT OR IGNORE INTO issuer_key_missing (provider, kid, first_missing_at) VALUES (?1, ?2, ?3)').bind(provider, kid, now));
    }
    if (stmts.length) await db.batch(stmts);
    return missing.filter((kid) => {
      const first = since.get(kid);
      return first !== undefined && now - first >= REMOVE_AFTER_MISSING_MS;
    });
  } catch {
    log({ event: 'jwks_sync_failed', code: 'missing_kids_unavailable' }, 'error');
    return [];
  }
}

/**
 * Kids of `provider` that signed a verified token less than KEEP_AFTER_LAST_TOKEN_MS ago (`last_token_ms`, migration
 * 0012), or null when D1 can't be read (the run then removes nothing).
 */
export async function recentTokenKids(db: D1Database, provider: string, now: number): Promise<Set<string> | null> {
  try {
    const rows = await db
      .prepare('SELECT kid FROM issuer_key_observations WHERE provider = ?1 AND COALESCE(last_token_ms, first_token_ms) >= ?2')
      .bind(provider, now - KEEP_AFTER_LAST_TOKEN_MS)
      .all<{ kid: string }>();
    return new Set(rows.results.map((r) => r.kid));
  } catch {
    log({ event: 'jwks_sync_failed', code: 'token_sightings_unavailable' }, 'error');
    return null;
  }
}

interface ProposalRow {
  kid: string;
  op: 'Add' | 'Remove';
  change_id: number | null;
  proposed_at: number;
  cancelled_seen_at: number | null;
}

/**
 * Resolves our earlier proposals against the chain: still pending (kept), applied (forgotten), or cancelled (marked
 * once, then held for REPROPOSE_AFTER_CANCEL_MS and forgotten after). Returns the held `${op}:${kid}` and the ones
 * first seen cancelled now. A pending change proposed by `signer` (the updater) that has no row yet, e.g. one whose
 * transaction outcome this cron never saw, is adopted so its cancellation is seen too. With D1 unavailable nothing is
 * held (a cancelled kid may then be proposed again: the watchdog cancels again).
 */
export async function reconcileProposals(db: D1Database, provider: string, signer: string, active: ReadonlySet<string>, changes: readonly KeyChange[], now: number): Promise<{ held: Set<string>; cancelled: string[] }> {
  const held = new Set<string>();
  const cancelled: string[] = [];
  try {
    const rows = await db.prepare('SELECT kid, op, change_id, proposed_at, cancelled_seen_at FROM issuer_key_proposals WHERE provider = ?1').bind(provider).all<ProposalRow>();
    const stmts: D1PreparedStatement[] = [];
    const forget = (r: ProposalRow): number => stmts.push(db.prepare('DELETE FROM issuer_key_proposals WHERE provider = ?1 AND kid = ?2 AND op = ?3').bind(provider, r.kid, r.op));
    for (const r of rows.results) {
      const pending = changes.find((c) => c.provider === provider && c.kid === r.kid && c.op === r.op);
      if (pending) {
        if (pending.id !== r.change_id || r.cancelled_seen_at !== null) {
          stmts.push(db.prepare('UPDATE issuer_key_proposals SET change_id = ?4, cancelled_seen_at = NULL WHERE provider = ?1 AND kid = ?2 AND op = ?3').bind(provider, r.kid, r.op, pending.id));
        }
        continue;
      }
      const applied = r.op === 'Add' ? active.has(r.kid) : !active.has(r.kid);
      if (applied) {
        forget(r);
        continue;
      }
      const key = `${r.op}:${r.kid}`;
      if (r.cancelled_seen_at === null) {
        cancelled.push(key);
        held.add(key);
        stmts.push(db.prepare('UPDATE issuer_key_proposals SET cancelled_seen_at = ?4 WHERE provider = ?1 AND kid = ?2 AND op = ?3').bind(provider, r.kid, r.op, now));
        log({ event: 'issuer_key_change_cancelled', method: r.op === 'Add' ? 'set_issuer_key' : 'propose_issuer_key_removal', kids: [r.kid], ...(r.change_id === null ? {} : { changeId: r.change_id }) }, 'error');
      } else if (now - r.cancelled_seen_at < REPROPOSE_AFTER_CANCEL_MS) held.add(key);
      else forget(r);
    }
    for (const c of changes) {
      if (c.provider !== provider || c.by !== signer || rows.results.some((r) => r.kid === c.kid && r.op === c.op)) continue;
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO issuer_key_proposals (provider, kid, op, change_id, proposed_at, cancelled_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)')
          .bind(provider, c.kid, c.op, c.id, c.proposed_at_ms),
      );
    }
    if (stmts.length) await db.batch(stmts);
  } catch {
    log({ event: 'jwks_sync_failed', code: 'proposals_unavailable' }, 'error');
  }
  return { held, cancelled };
}

async function rememberProposal(db: D1Database, provider: string, kid: string, op: 'Add' | 'Remove', changeId: number | null, now: number): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO issuer_key_proposals (provider, kid, op, change_id, proposed_at, cancelled_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)')
    .bind(provider, kid, op, changeId, now)
    .run()
    .catch(() => log({ event: 'jwks_sync_failed', code: 'proposal_record_failed', kids: [kid] }, 'error'));
}

/** Writes the run's outcome for GET /v1/governance (governance-status.ts). Never throws. */
async function recordRun(db: D1Database, provider: string, result: SyncResult, now: number): Promise<void> {
  const outcome = result.skipped ? 'skipped' : result.failed.length ? 'error' : 'ok';
  await db
    .prepare(
      `INSERT INTO issuer_key_sync_runs (provider, at_ms, outcome, code, summary) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (provider) DO UPDATE SET at_ms = excluded.at_ms, outcome = excluded.outcome, code = excluded.code, summary = excluded.summary`,
    )
    .bind(provider, now, outcome, result.skipped ?? (result.failed.length ? 'call_failed' : null), JSON.stringify(result))
    .run()
    .catch(() => log({ event: 'jwks_sync_failed', code: 'run_record_failed' }, 'warn'));
}

const logNote = (n: SyncNote): void => log({ event: 'jwks_sync_note', code: n.code, kids: [n.kid], ...(n.id === undefined ? {} : { changeId: n.id }) }, NOTE_LEVEL[n.code]);

export async function syncIssuerKeys(env: Env, provider = GOOGLE_PROVIDER, jwksUrl = GOOGLE_JWKS_URL, now: number = Date.now()): Promise<SyncResult> {
  const result = await runSync(env, provider, jwksUrl, now);
  await recordRun(env.DB, provider, result, now);
  return result;
}

async function runSync(env: Env, provider: string, jwksUrl: string, now: number): Promise<SyncResult> {
  const result = emptyResult();
  const skip = (code: string, level: 'warn' | 'error' = 'error'): SyncResult => {
    log({ event: level === 'warn' ? 'jwks_sync_skipped' : 'jwks_sync_failed', code }, level);
    return { ...result, skipped: code };
  };

  // JWKS_FETCHES_PER_RUN fetches, one after another: a kid any of them lists is published (D420).
  const fetches: PromiseSettledResult<{ keys: Jwk[]; maxAgeS: number | null }>[] = [];
  for (let i = 0; i < JWKS_FETCHES_PER_RUN; i++) fetches.push(...(await Promise.allSettled([fetchUsableJwks(jwksUrl)])));
  const succeeded = fetches.flatMap((f) => (f.status === 'fulfilled' ? [f.value] : []));
  if (succeeded.length === 0) return skip('jwks_fetch_failed');
  // An empty answer is a broken one, not "Google publishes nothing": it neither lists nor misses a kid.
  const answers = succeeded.filter((a) => a.keys.length > 0);
  const union = new Map<string, Jwk>();
  for (const a of answers) for (const k of a.keys) if (!union.has(k.kid)) union.set(k.kid, k);
  const jwks = [...union.values()];
  // Measurement only (never fails the sync): the union, recorded whether or not this env can post keys.
  await recordJwksObservation(env.DB, provider, jwks.map((k) => k.kid), answers[0]?.maxAgeS ?? null, now);
  const completeFetches = answers.length === JWKS_FETCHES_PER_RUN;
  if (!env.KEYS_UPDATER_KEY) return skip('no_keys_updater_key', 'warn');
  if (jwks.length === 0) return skip('jwks_empty');
  const rpc = new Rpc(env.NEAR_RPC);

  const [issuerView, changesView, configView] = await Promise.allSettled([
    rpc.view<unknown>(env.SIGNER_ACCOUNT, 'get_issuer', { provider }),
    rpc.view<unknown>(env.SIGNER_ACCOUNT, 'get_key_changes', {}),
    rpc.view<{ paused?: unknown } | null>(env.SIGNER_ACCOUNT, 'get_config', {}),
  ]);
  if (issuerView.status === 'rejected') return skip('get_issuer_failed');
  const onChain = issuerKids(issuerView.value);
  if (onChain === null) return skip('issuer_not_configured');
  // Without the pending list every proposal could be doomed (or a duplicate): propose nothing. A contract without
  // get_key_changes (still v1) lands here too.
  const changes = changesView.status === 'fulfilled' ? parseKeyChanges(changesView.value) : null;
  if (changes === null) return skip('key_changes_unavailable');
  // Unknown pause state: don't execute (a paused contract refuses), proposals are still fine.
  const paused = configView.status === 'fulfilled' ? configView.value?.paused !== false : true;
  if (configView.status === 'rejected') log({ event: 'jwks_sync_failed', code: 'get_config_failed' }, 'warn');

  const active = new Set(onChain);
  const published = new Set(jwks.map((k) => k.kid));
  const missing = onChain.filter((kid) => !published.has(kid));
  // An incomplete run (a fetch failed or was empty) leaves the missing-since rows as they are: it neither starts nor
  // resets a kid's 24 h, and judges nothing absent.
  const [{ held, cancelled }, dueRemovals, recentTokens] = await Promise.all([
    reconcileProposals(env.DB, provider, env.SIGNER_ACCOUNT, active, changes, now),
    completeFetches ? dueForRemoval(env.DB, provider, missing, now) : Promise.resolve([]),
    recentTokenKids(env.DB, provider, now),
  ]);
  result.cancelled = cancelled;

  const plan = planIssuerKeySync({ provider, jwks, active: onChain, changes, paused, now, dueRemovals, held, removalEvidence: completeFetches && recentTokens !== null, recentTokens: recentTokens ?? new Set() });
  result.notes = plan.notes;
  for (const n of plan.notes) logNote(n);
  if (plan.execute.length === 0 && plan.propose.length === 0 && plan.proposeRemoval.length === 0) {
    log({ event: 'jwks_sync', outcome: 'ok', added: 0, removed: 0 });
    return result;
  }

  let sender: KeySender;
  try {
    sender = new KeySender(env, rpc);
  } catch {
    return skip('bad_keys_updater_key');
  }
  for (const c of plan.execute) {
    const r = await sender.call({ method: 'execute_issuer_key_change', args: { id: c.id }, gas: ISSUER_KEY_GAS });
    if (r.ok) result.executed.push(c.id);
    else if (r.raced) {
      const note: SyncNote = { code: 'execute_raced', kid: c.kid, id: c.id };
      result.notes.push(note);
      logNote(note);
    } else result.failed.push(`execute_issuer_key_change:${c.id}`);
  }
  for (const key of plan.propose) {
    const r = await sender.call({ method: 'set_issuer_key', args: { provider, kid: key.kid, n: key.n, e: key.e }, gas: ISSUER_KEY_GAS });
    if (!r.ok) {
      result.failed.push(`set_issuer_key:${key.kid}`);
      continue;
    }
    result.proposed.push(key.kid);
    await rememberProposal(env.DB, provider, key.kid, 'Add', idOf(r.value), now);
  }
  // Old keys leave only once every new key of this run was proposed.
  if (!result.failed.some((f) => f.startsWith('set_issuer_key:'))) {
    for (const kid of plan.proposeRemoval) {
      const r = await sender.call({ method: 'propose_issuer_key_removal', args: { provider, kid }, gas: ISSUER_KEY_GAS });
      if (!r.ok) {
        result.failed.push(`propose_issuer_key_removal:${kid}`);
        continue;
      }
      result.removalsProposed.push(kid);
      await rememberProposal(env.DB, provider, kid, 'Remove', idOf(r.value), now);
    }
  }
  log(
    {
      event: 'jwks_sync',
      outcome: result.failed.length ? 'error' : 'ok',
      added: result.proposed.length,
      removed: result.removalsProposed.length,
      kids: [...result.proposed, ...result.removalsProposed],
      executed: result.executed.length,
    },
    result.failed.length ? 'error' : 'info',
  );
  return result;
}

const idOf = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

/** The contract's panics that mean someone else already applied or cancelled the change (or it can't apply yet). */
const RACED_PANICS = ['No such key change', 'Kid is already active', 'No such key'];

type SendResult = { ok: true; value: unknown } | { ok: false; raced: boolean };

/** Sends txs one by one from the keys-updater key (signer == receiver == SIGNER_ACCOUNT), UPDATER_METHODS only. */
class KeySender {
  private nonce: bigint | null = null;
  private blockHash = '';
  private readonly keyPair;
  private readonly publicKey: string;

  constructor(
    private readonly env: Env,
    private readonly rpc: Rpc,
  ) {
    this.keyPair = parseKeyPair(env.KEYS_UPDATER_KEY ?? '');
    this.publicKey = this.keyPair.getPublicKey().toString();
  }

  private async refresh(): Promise<void> {
    const ak = await this.rpc.viewAccessKey(this.env.SIGNER_ACCOUNT, this.publicKey);
    this.nonce = BigInt(ak.nonce);
    this.blockHash = ak.block_hash;
  }

  async call(call: ContractCall & { method: UpdaterMethod }): Promise<SendResult> {
    // Belt and braces: the type already says so, and the key's own method list is the real limit.
    if (!updaterAllows(call.method)) {
      log({ event: 'jwks_tx', method: call.method, outcome: 'error', code: 'method_not_allowed' }, 'error');
      return { ok: false, raced: false };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (this.nonce === null) await this.refresh();
        const nonce = (this.nonce ?? 0n) + 1n;
        this.nonce = nonce;
        const signed = await signFunctionCall({ keyPair: this.keyPair, signerId: this.env.SIGNER_ACCOUNT, receiverId: this.env.SIGNER_ACCOUNT, nonce, blockHash: this.blockHash, call });
        let initial: SendTxResult | null = null;
        try {
          initial = await this.rpc.sendTx(signed.bytes, 'EXECUTED');
        } catch (err) {
          if (invalidNonce(err) && attempt === 0) {
            this.nonce = null;
            continue;
          }
          // Not a definite rejection: the tx may have been forwarded, so poll its outcome.
          if (isDefiniteRejection(err)) throw err;
        }
        const outcome = await waitForOutcome(this.rpc, signed.hash, this.env.SIGNER_ACCOUNT, initial);
        // The panic text is matched, never logged (it can echo inputs).
        const raced = !outcome.ok && outcome.kind === 'failure' && call.method === 'execute_issuer_key_change' && RACED_PANICS.some((p) => outcome.error.includes(p));
        log({ event: 'jwks_tx', method: call.method, nearTx: signed.hash, outcome: outcome.ok ? 'ok' : 'error', ...(raced ? { code: 'raced' } : {}) }, outcome.ok || raced ? 'info' : 'error');
        return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, raced };
      } catch {
        log({ event: 'jwks_tx', method: call.method, outcome: 'error', code: 'send_failed' }, 'error');
        return { ok: false, raced: false };
      }
    }
    return { ok: false, raced: false };
  }
}
