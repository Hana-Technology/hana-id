// The results log: one record per successful derive, public data only (no tokens, signatures, secrets or keys
// beyond public addresses), so testers can compare apps, key indexes and client modes, and copy it as JSON.
import type { GoogleMode } from './api.ts';

export interface StepTimings {
  /** Google sign-in, from rendering the button to the credential (includes the tester's clicks). */
  googleMs: number | null;
  /** POST /v1/sessions round trip (create_session). */
  createSessionMs: number | null;
  /** POST /v1/derive round trip (derive_key + MPC). */
  deriveMs: number;
  /** Local CKD decryption, pairing check and derivation v1 addresses. */
  decryptVerifyMs: number;
  /** Start of the run (session start, or "derive again" click) to addresses shown. */
  totalMs: number;
}

export interface RunRecord {
  /** 1-based, in this browser's log. */
  run: number;
  at: string;
  env: string;
  signer: string;
  /** The API the run called (VITE_HANA_API_URL when set). Absent in runs logged before it was recorded. */
  apiUrl?: string;
  /** First characters of the publishable key (public). */
  pkPrefix: string;
  scopeId: string;
  clientMode: GoogleMode;
  clientId: string;
  keyIndex: number;
  path: string;
  /** Session counter used for this derive (1 = first derive in the session). */
  counter: number;
  /** First bytes of the session public key, hex: tells runs of one session apart. */
  sessionKeyPrefix: string;
  appIdHex: string;
  /** Chain-key derivation version (@hana-id/core/derivation). Runs logged before v1 (PROVISIONAL) are dropped on load. */
  derivation: 1;
  stellar: string;
  evm: string;
  createSessionTx: string | null;
  deriveTx: string | null;
  createSessionGas: number | null;
  deriveGas: number | null;
  timings: StepTimings;
}

export const pkPrefix = (publishableKey: string): string => (publishableKey.length > 16 ? `${publishableKey.slice(0, 16)}…` : publishableKey);

/** `{scope}#{provider}#{sub}#{key_index}` → parts, or null if malformed. */
export function parsePath(path: string): { scope: string; provider: string; sub: string; keyIndex: string } | null {
  const parts = path.split('#');
  if (parts.length !== 4 || parts.some((p) => p.length === 0)) return null;
  const [scope, provider, sub, keyIndex] = parts as [string, string, string, string];
  return { scope, provider, sub, keyIndex };
}

export type Verdict = 'ok' | 'fail';

export interface Comparison {
  /** The earlier run this run is compared with. */
  other: number;
  verdict: Verdict;
  note: string;
}

/**
 * Compares a run with every earlier run of the same environment and signer:
 * - same path → addresses and app_id must be equal (also how own vs shared client is checked: same Google `sub`,
 *   same scope, same key index gives the same path);
 * - different path (other app, key index or user) → addresses must differ (isolation).
 */
export function compareRun(run: RunRecord, earlier: readonly RunRecord[]): Comparison[] {
  const out: Comparison[] = [];
  const mine = parsePath(run.path);
  for (const o of earlier) {
    if (o.run === run.run || o.env !== run.env || o.signer !== run.signer) continue;
    const theirs = parsePath(o.path);
    const sameAddresses = o.stellar === run.stellar && o.evm === run.evm && o.appIdHex === run.appIdHex;
    if (o.path === run.path) {
      const how = o.clientMode !== run.clientMode ? `own vs shared client (${o.clientMode} → ${run.clientMode})` : o.sessionKeyPrefix === run.sessionKeyPrefix ? 'same session' : 'another session';
      out.push({
        other: o.run,
        verdict: sameAddresses ? 'ok' : 'fail',
        note: sameAddresses ? `same path, ${how}: same addresses` : `same path, ${how}, but DIFFERENT addresses`,
      });
      continue;
    }
    const anyEqual = o.stellar === run.stellar || o.evm === run.evm || o.appIdHex === run.appIdHex;
    let what = 'different path';
    if (mine && theirs && mine.sub === theirs.sub && mine.provider === theirs.provider) {
      if (mine.scope !== theirs.scope && mine.keyIndex === theirs.keyIndex) what = `same user, other scope (${theirs.scope} vs ${mine.scope})`;
      else if (mine.scope === theirs.scope && mine.keyIndex !== theirs.keyIndex) what = `same user and scope, key_index ${theirs.keyIndex} vs ${mine.keyIndex}`;
      else what = 'same user, other scope and key_index';
    } else if (mine && theirs && mine.scope === theirs.scope && mine.keyIndex === theirs.keyIndex && o.clientMode !== run.clientMode) {
      // Same scope and key index but another sub: own and shared clients gave different Google `sub`s.
      what = `other sub via ${o.clientMode} vs ${run.clientMode} client (Google sub differs across clients?)`;
    }
    out.push({ other: o.run, verdict: anyEqual ? 'fail' : 'ok', note: anyEqual ? `${what}, but an address or app_id is EQUAL` : `${what}: addresses differ` });
  }
  return out;
}

/** "Copy results as JSON": the public log only. */
export function resultsJson(runs: readonly RunRecord[]): string {
  return JSON.stringify({ kind: 'hana-id-smoke-results', version: 1, derivation: 'v1 (hana-id/chain-keys/v1, @hana-id/core/derivation)', runs }, null, 2);
}

/**
 * Loads a stored log, dropping anything that doesn't look like a run (public data, a convenience only), including runs
 * from the PROVISIONAL derivation, whose addresses would wrongly fail the comparisons against v1 runs.
 */
export function parseStoredRuns(text: string | null): RunRecord[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is RunRecord =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RunRecord).run === 'number' &&
        typeof (r as RunRecord).path === 'string' &&
        typeof (r as RunRecord).stellar === 'string' &&
        (r as RunRecord).derivation === 1,
    );
  } catch {
    return [];
  }
}
