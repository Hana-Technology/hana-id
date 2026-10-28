// The vault page's results log: one record per login through the vault and per unlock (a reload, a new tab or a
// remount restoring the wallet from the server-held share). Public data only: the vault returns addresses, expiry,
// persistence and (pk_test_ apps) per-stage timings, never a path, a `sub`, a token or a key. Because the page doesn't
// learn the Google `sub`, the tester tags each login with an account label of their choosing ("personal",
// "workspace"); the comparisons use the label where the direct page used the path.
import type { GoogleMode } from './api.ts';
import type { RunRecord } from './runs.ts';

export type VaultRunKind = 'login' | 'unlock';

export interface VaultTimings {
  /**
   * The vault's per-stage ms (LoginResult.timings, pk_test_ apps only; null otherwise and for unlocks): `app` (Google
   * client), `popup` (until the login popup connected), `google` (the Google UI and the relay, so it includes the
   * tester's clicks), `verify` (RS256 and claims), `chain` (POST /v1/login, create_session_and_derive, with any
   * retries), `decrypt` (CKD decryption, pairing check, derivation v1).
   */
  stages: Record<string, number> | null;
  /**
   * login: click → addresses on this page (includes the Google UI and the share creation). unlock: createHana → ready
   * (iframe load, vault page render, one POST /v1/vault/unlock).
   */
  totalMs: number;
}

export interface VaultRunRecord {
  /** 1-based, in this browser's vault log. */
  run: number;
  at: string;
  env: string;
  signer: string;
  /** First characters of the publishable key (public). */
  pkPrefix: string;
  /** From GET /v1/app on this page, when it answered. */
  scopeId: string | null;
  clientMode: GoogleMode | null;
  clientId: string | null;
  /** The tester's label for the Google account ('' when unset). Never an email address. */
  account: string;
  kind: VaultRunKind;
  /** The vault fixes key_index 0 in the MVP. */
  keyIndex: 0;
  /** Chain-key derivation version (@hana-id/core/derivation). */
  derivation: 1;
  persistence: 'session' | 'none';
  /** `storage_unavailable` when the vault fell back to 'none'. */
  warning: string | null;
  stellar: string;
  evm: string;
  expiresAtMs: number | null;
  timings: VaultTimings;
}

/** An account label: up to 32 letters, digits, spaces, `_`, `.` or `-`. No `@`, so an email address can't be stored. */
export const ACCOUNT_LABEL_RE = /^[A-Za-z0-9 _.-]{0,32}$/u;

export function accountLabelProblem(label: string): string | null {
  return ACCOUNT_LABEL_RE.test(label) ? null : 'Account label: up to 32 letters, digits, spaces, _ . or - (not an email address)';
}

export type VaultVerdict = 'ok' | 'fail' | 'info';

export interface VaultComparison {
  /** The earlier run compared with: a vault run number, or `direct #n` for a run of the direct page. */
  other: string;
  verdict: VaultVerdict;
  note: string;
}

const sameAddresses = (a: { stellar: string; evm: string }, b: { stellar: string; evm: string }): boolean =>
  a.stellar === b.stellar && a.evm.toLowerCase() === b.evm.toLowerCase();
const anyAddressEqual = (a: { stellar: string; evm: string }, b: { stellar: string; evm: string }): boolean =>
  a.stellar === b.stellar || a.evm.toLowerCase() === b.evm.toLowerCase();

/**
 * Compares a vault run with the earlier runs of the same environment and signer:
 * - unlock: the latest earlier run of the same app must have the same addresses (the share restored that wallet);
 * - login, same scope and account label: same addresses (also how own vs shared client is checked: the same Google
 *   `sub` in the same scope gives the same path whichever client signed the token);
 * - login, same label in another scope, or another label: different addresses (isolation);
 * - login, no label: an equal-address run in the same scope is noted, nothing is judged;
 * - login vs the direct page (in-page derivation, key_index 0, same scope): equal addresses are noted as the vault
 *   agreeing with the reference derivation. The direct run's `sub` is unknown here, so a difference isn't judged.
 */
export function compareVaultRun(run: VaultRunRecord, earlier: readonly VaultRunRecord[], direct: readonly RunRecord[] = []): VaultComparison[] {
  const mine = earlier.filter((o) => o.run !== run.run && o.env === run.env && o.signer === run.signer);
  if (run.kind === 'unlock') {
    const last = mine.filter((o) => o.pkPrefix === run.pkPrefix && o.run < run.run).at(-1);
    if (!last) return [{ other: '—', verdict: 'info', note: 'unlocked a wallet this log has no earlier run for' }];
    const ok = sameAddresses(run, last);
    return [{ other: `#${last.run}`, verdict: ok ? 'ok' : 'fail', note: ok ? `unlock restored #${last.run}'s addresses` : `unlock gave DIFFERENT addresses from #${last.run}` }];
  }
  const out: VaultComparison[] = [];
  for (const o of mine) {
    if (o.kind !== 'login') continue;
    const equal = sameAddresses(run, o);
    const sameScope = run.scopeId !== null && run.scopeId === o.scopeId;
    if (run.account === '' || o.account === '') {
      if (sameScope && equal) out.push({ other: `#${o.run}`, verdict: 'info', note: 'same scope, same addresses (no account label to judge by)' });
      continue;
    }
    if (run.account === o.account && sameScope) {
      const how = o.clientMode !== null && run.clientMode !== null && o.clientMode !== run.clientMode ? `, ${o.clientMode} → ${run.clientMode} client` : '';
      out.push({
        other: `#${o.run}`,
        verdict: equal ? 'ok' : 'fail',
        note: equal ? `same account and scope${how}: same addresses` : `same account and scope${how}, but DIFFERENT addresses`,
      });
      continue;
    }
    if (run.scopeId === null || o.scopeId === null) continue;
    const what = run.account === o.account ? `same account, other scope (${o.scopeId} vs ${run.scopeId})` : `other account (${o.account} vs ${run.account})`;
    const clash = anyAddressEqual(run, o);
    out.push({ other: `#${o.run}`, verdict: clash ? 'fail' : 'ok', note: clash ? `${what}, but an address is EQUAL` : `${what}: addresses differ` });
  }
  for (const d of direct) {
    if (d.env !== run.env || d.signer !== run.signer || d.keyIndex !== 0 || d.scopeId !== run.scopeId) continue;
    if (sameAddresses(run, d)) out.push({ other: `direct #${d.run}`, verdict: 'ok', note: `same addresses as the in-page derivation (${d.path})` });
  }
  return out;
}

/** The vault log as stored, dropping anything that doesn't look like a vault run (public data, a convenience only). */
export function parseStoredVaultRuns(text: string | null): VaultRunRecord[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is VaultRunRecord => {
      if (typeof r !== 'object' || r === null) return false;
      const x = r as Partial<VaultRunRecord>;
      return (
        typeof x.run === 'number' &&
        (x.kind === 'login' || x.kind === 'unlock') &&
        typeof x.stellar === 'string' &&
        typeof x.evm === 'string' &&
        typeof x.account === 'string' &&
        x.derivation === 1 &&
        typeof x.timings === 'object' &&
        x.timings !== null &&
        typeof x.timings.totalMs === 'number'
      );
    });
  } catch {
    return [];
  }
}

/** "Copy results as JSON": both logs, public data only. */
export function allResultsJson(vaultRuns: readonly VaultRunRecord[], directRuns: readonly RunRecord[]): string {
  return JSON.stringify(
    { kind: 'hana-id-smoke-results', version: 2, derivation: 'v1 (hana-id/chain-keys/v1, @hana-id/core/derivation)', vaultRuns, directRuns },
    null,
    2,
  );
}
