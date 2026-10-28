// The vault page's inlined config (docs/batch-b-spec.md "Inlined config"): a non-executable
// `<script type="application/json" id="hana-config">` that apps/api/src/vault/page.ts renders per request from D1 only
// (no chain RPC, so a reload unlocks with one API call). It carries no `signer`: the bundle's pinned SIGNER is used.
// Anything malformed is refused as a whole, and the vault then does nothing (the SDK raises vault_unavailable).
//
// The parent-origin rule mirrors apps/api/src/origins.ts `originAllowed`: exact match against the app's origins;
// loopback origins, and `http://localhost:<port>` through the `http://localhost:*` wildcard, only for pk_test_ keys in
// `local*`/`sandbox*` envs (the build constant `devEnv`). The page already serves only the origins this env allows; the
// vault applies the rule again so a stale or hand-edited page can't widen it.
import { isOrigin, isPublishableKey, isScopeId } from '@hana-id/core';
import { type AutoApprovePolicyV1, policyId as computePolicyId, validateAutoApprovePolicy } from '@hana-id/core/policy';

export type Persistence = 'session' | 'none';
export type RawSign = 'off' | 'approval';

export interface VaultSettings {
  persistence: Persistence;
  sessionTtlMs: number;
  idleTtlMs: number;
  rawSign: RawSign;
  /** The policy JSON in force, unvalidated (see VaultConfig.policy). */
  autoApprovePolicy: Record<string, unknown> | null;
}

export interface VaultConfig {
  v: 1;
  appId: string;
  appName: string;
  scopeId: string;
  origins: readonly string[];
  settings: VaultSettings;
  publishableKey: string;
  serverTimeMs: number;
}

/** The auto-approve policy in force, validated by @hana-id/core (the same validator as the CLI and the API). */
export interface PolicyInForce {
  policy: AutoApprovePolicyV1;
  policyId: string;
}

export const LOCALHOST_WILDCARD = 'http://localhost:*';
const LOCALHOST_RE = /^http:\/\/localhost(:\d{1,5})?$/u;
const LOOPBACK_RE = /^https?:\/\/(([a-z0-9-]+\.)*localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d{1,5})?$/u;
/** The API serves at most 20 origins per app. */
export const MAX_ORIGINS = 20;
/** The contract's `expires_at_ms ≤ block_now + 24 h`, less a 10 min margin (the setting's own cap). */
export const SESSION_TTL_CAP_MS = 24 * 3_600_000 - 10 * 60_000;
const SESSION_TTL_MIN_MS = 3_600_000;
const IDLE_TTL_MIN_MS = 15 * 60_000;
const APP_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/u;

type Obj = Record<string, unknown>;
const isPlainObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  Object.keys(o).every((k) => required.includes(k) || optional.includes(k)) && required.every((k) => Object.hasOwn(o, k));
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

function parseSettings(v: unknown): VaultSettings | null {
  if (!isPlainObject(v) || !exactKeys(v, ['persistence', 'sessionTtlMs', 'idleTtlMs', 'rawSign'], ['autoApprovePolicy'])) return null;
  const { persistence, sessionTtlMs, idleTtlMs, rawSign } = v;
  if (persistence !== 'session' && persistence !== 'none') return null;
  if (rawSign !== 'off' && rawSign !== 'approval') return null;
  if (!isInt(sessionTtlMs, SESSION_TTL_MIN_MS, SESSION_TTL_CAP_MS) || !isInt(idleTtlMs, IDLE_TTL_MIN_MS, sessionTtlMs)) return null;
  const policy = v.autoApprovePolicy ?? null;
  if (policy !== null && !isPlainObject(policy)) return null;
  return { persistence, sessionTtlMs, idleTtlMs, rawSign, autoApprovePolicy: policy };
}

/** Validates the config object, or null. */
export function parseVaultConfig(value: unknown): VaultConfig | null {
  if (!isPlainObject(value)) return null;
  if (!exactKeys(value, ['v', 'appId', 'appName', 'scopeId', 'origins', 'settings', 'publishableKey', 'serverTimeMs'])) return null;
  const { appId, appName, scopeId, origins, publishableKey, serverTimeMs } = value;
  if (value.v !== 1) return null;
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return null;
  if (typeof appName !== 'string' || appName.length === 0 || appName.length > 200) return null;
  if (!isScopeId(scopeId) || !isPublishableKey(publishableKey)) return null;
  if (!isInt(serverTimeMs, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(origins) || origins.length > MAX_ORIGINS) return null;
  if (!origins.every((o) => o === LOCALHOST_WILDCARD || isOrigin(o))) return null;
  const settings = parseSettings(value.settings);
  if (!settings) return null;
  return Object.freeze({ v: 1, appId, appName, scopeId, origins: Object.freeze([...(origins as string[])]), settings: Object.freeze(settings), publishableKey, serverTimeMs });
}

/** Reads and validates `#hana-config` from the vault page, or null (missing, not JSON, or malformed). */
export function readInlinedConfig(doc: Pick<Document, 'getElementById'>): VaultConfig | null {
  const el = doc.getElementById('hana-config');
  if (!el || el.tagName !== 'SCRIPT' || el.getAttribute('type') !== 'application/json') return null;
  try {
    return parseVaultConfig(JSON.parse(el.textContent ?? ''));
  } catch {
    return null;
  }
}

/** Whether `origin` may be the vault's parent for this app (apps/api/src/origins.ts originAllowed). */
export function parentAllowed(config: Pick<VaultConfig, 'origins' | 'publishableKey'>, origin: string | null | undefined, devEnv: boolean): boolean {
  if (typeof origin !== 'string' || !isOrigin(origin)) return false;
  const loopbackOk = devEnv && config.publishableKey.startsWith('pk_test_');
  if (LOOPBACK_RE.test(origin) && !loopbackOk) return false;
  if (config.origins.includes(origin)) return true;
  return loopbackOk && LOCALHOST_RE.test(origin) && config.origins.includes(LOCALHOST_WILDCARD);
}

/**
 * The auto-approve policy in force, or null when the app has none or it doesn't validate (an unreadable policy never
 * applies). `maxConsentMs` may not exceed the app's session TTL.
 */
export function policyInForce(settings: VaultSettings): PolicyInForce | null {
  if (settings.autoApprovePolicy === null) return null;
  const options = { sessionTtlMs: settings.sessionTtlMs };
  const result = validateAutoApprovePolicy(settings.autoApprovePolicy, options);
  if (!result.ok) return null;
  return { policy: result.policy, policyId: computePolicyId(result.policy, options) };
}
