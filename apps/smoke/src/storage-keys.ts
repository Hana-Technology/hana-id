// localStorage keys of the smoke pages (public data only; every read and write is a convenience and may fail).

/** The publishable key last loaded, shared by the vault page and the direct page. */
export const PK_STORAGE = 'hana-smoke.publishableKey';
/** The direct page's results log (runs.ts RunRecord[]); the vault page reads it for the cross-checks and the ship gate. */
export const RUNS_STORAGE = 'hana-smoke.runs';
/** The vault page's results log (vault-runs.ts VaultRunRecord[]). */
export const VAULT_RUNS_STORAGE = 'hana-smoke.vault-runs';
/** The vault page's Google account label. */
export const ACCOUNT_STORAGE = 'hana-smoke.account';

export { isPublishableKey } from '@hana-id/core';
