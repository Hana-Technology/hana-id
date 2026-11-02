// GET /v1/governance: hana-signer's governance state in one read-only answer (docs/api.md "Governance status"), for
// batch C's admin portal "Security & monitoring" view and the consoles' pending-upgrades page (D83, D86) until they
// exist, and for operators. Everything here is public: on-chain views, the signer's access-key list, Google's JWKS
// and the JWKS cron's own last run (D1). It changes nothing and needs no key.
//
// What it is not: the watchdog's verdicts, heartbeat, actions log and alerts come from the watchdog service's own
// status endpoint (docs/governance-spec.md "Watchdog service"), never from here, and the API is not independent of
// Hana's Cloudflare account. The on-chain views it summarises are documented in docs/contract-interface.md
// "Monitoring hand-off"; a reader that must not trust the API reads them itself through its own RPC.
import { publishedKeys } from '@hana-id/oidc';
import type { Env } from './env.ts';
import { done, newCtx } from './handlers.ts';
import { GOOGLE_PROVIDER, type KeyChange, parseKeyChanges, sameKeyMaterial, issuerKids } from './issuer-keys.ts';
import { type AccessKeyListEntry, Rpc } from './near/rpc.ts';
import { UPDATER_METHODS } from './relayer-config.ts';

export const GOVERNANCE_ENDPOINT = '/v1/governance';
/** One snapshot per isolate serves every request for this long (the chain reads are the cost). */
export const GOVERNANCE_CACHE_MS = 10_000;
/** Providers whose issuer keys the API reports (the ones it knows a JWKS for). */
const PROVIDERS = [GOOGLE_PROVIDER] as const;
/** The contract's MAX_UPDATER_ALLOWANCE (1 NEAR): an updater key with more, or unlimited, is a finding. */
const MAX_UPDATER_ALLOWANCE_YOCTO = 10n ** 24n;

/** A view answered with a shape this code doesn't know: report nothing rather than something wrong. */
class ShapeError extends Error {}

const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError();
  return v;
};
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new ShapeError();
  return v;
};
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new ShapeError();
  return v;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new ShapeError();
  return v;
};
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ShapeError();
  return v as Record<string, unknown>;
};
const optional = <T>(v: unknown, read: (o: Record<string, unknown>) => T): T | null => (v === null || v === undefined ? null : read(obj(v)));

export interface DelayChangeStatus {
  valueMs: number;
  effectiveAtMs: number;
}
export interface PendingClientStatus {
  provider: string;
  aud: string;
  effectiveAtMs: number;
}
/**
 * Google's JWKS against a pending change: an Add `match`es (same kid, same n and e), is a `mismatch` (same kid, other
 * key material) or `absent`; a Remove's kid is `absent` (as expected) or still `present`; `unknown` without a JWKS.
 */
export type JwksVerdict = 'match' | 'mismatch' | 'absent' | 'present' | 'unknown';

export interface KeyChangeStatus {
  id: number;
  provider: string;
  kid: string;
  op: 'Add' | 'Remove';
  by: string;
  proposedAtMs: number;
  executableAtMs: number;
  /** `executableAtMs` has passed: anyone may execute it (unless paused). */
  due: boolean;
  jwks: JwksVerdict;
}

export interface AccessKeyStatus {
  publicKey: string;
  kind: 'full_access' | 'function_call';
  receiverId: string | null;
  methodNames: string[] | null;
  /** yoctoNEAR; null = unlimited (or a full-access key). */
  allowanceYocto: string | null;
  /** Listed in `get_governance().updater_keys`. */
  updaterKey: boolean;
  /** A function-call key with exactly UPDATER_METHODS, receiver the signer, allowance ≤ 1 NEAR. */
  updaterPermission: boolean;
}

export interface GovernanceStatus {
  signer: string;
  env: string;
  readAtMs: number;
  stateVersion: number;
  paused: boolean;
  /** When the owner last unpaused (0: never). */
  unpausedAtMs: number;
  /** No scope change executes before this: each unpause gives changes pending across the pause a full timelock. */
  changesUnlockFloorMs: number;
  /** Sessions opened before this can't derive (raised by the owner after a forged issuer key was active). */
  sessionsValidFromMs: number;
  delays: {
    issuerKeyDelayMs: number;
    governanceDelayMs: number;
    changeDelayMs: number;
    /** Decreases waiting to take effect (increases apply at once). */
    pendingIssuerKeyDelay: DelayChangeStatus | null;
    pendingGovernanceDelay: DelayChangeStatus | null;
    pendingChangeDelay: DelayChangeStatus | null;
  };
  issuers: { provider: string; activeKids: string[]; jwksKids: string[] | null }[];
  keyChanges: KeyChangeStatus[];
  watchdogs: { accountId: string; confirmFromMs: number; canConfirm: boolean }[];
  keysSlowUntilMs: number;
  updaterKeys: string[];
  updaterMethods: string[];
  /** The signer account's access keys (null when the RPC didn't answer). */
  signerAccessKeys: AccessKeyStatus[] | null;
  pendingUpgrade: { codeHash: string; proposedAtMs: number; executableAtMs: number; due: boolean } | null;
  pendingOwner: { owner: string; acceptableAtMs: number; due: boolean } | null;
  pendingWithdrawal: { receiver: string; amountYocto: string; executableAtMs: number; due: boolean } | null;
  pendingConsoleAudiences: PendingClientStatus[];
  pendingSharedClients: PendingClientStatus[];
  /** The API's JWKS cron (issuer-keys.ts): its last run and the proposals it is tracking (null when D1 failed). */
  updater: {
    lastRuns: { provider: string; atMs: number; outcome: 'ok' | 'error' | 'skipped'; code: string | null; summary: unknown }[];
    proposals: { provider: string; kid: string; op: 'Add' | 'Remove'; changeId: number | null; proposedAtMs: number; cancelledSeenAtMs: number | null }[];
  } | null;
}

const delayChange = (v: unknown): DelayChangeStatus | null => optional(v, (o) => ({ valueMs: num(o.change_delay_ms), effectiveAtMs: num(o.effective_at_ms) }));
const pendingClients = (v: unknown): PendingClientStatus[] => list(v).map((e) => { const o = obj(e); return { provider: str(o.provider), aud: str(o.aud), effectiveAtMs: num(o.effective_at_ms) }; });

/** Google's JWKS for a pending change (see JwksVerdict). */
export function jwksVerdict(change: KeyChange, jwks: readonly { kid: string; n: string; e: string }[] | null): JwksVerdict {
  if (!jwks) return 'unknown';
  const jwk = jwks.find((k) => k.kid === change.kid);
  if (change.op === 'Remove') return jwk ? 'present' : 'absent';
  if (!jwk) return 'absent';
  return sameKeyMaterial(jwk, change) ? 'match' : 'mismatch';
}

export function accessKeyStatus(entry: AccessKeyListEntry, signer: string, updaterKeys: readonly string[]): AccessKeyStatus {
  const publicKey = str(entry.public_key);
  const updaterKey = updaterKeys.includes(publicKey);
  const p = entry.access_key?.permission;
  if (p === 'FullAccess') return { publicKey, kind: 'full_access', receiverId: null, methodNames: null, allowanceYocto: null, updaterKey, updaterPermission: false };
  const fc = obj(obj(p).FunctionCall);
  const methodNames = list(fc.method_names).map(str);
  const allowanceYocto = fc.allowance === null ? null : str(fc.allowance);
  const receiverId = str(fc.receiver_id);
  const exactMethods = methodNames.length === UPDATER_METHODS.length && UPDATER_METHODS.every((m) => methodNames.includes(m));
  const updaterPermission = exactMethods && receiverId === signer && allowanceYocto !== null && /^\d+$/u.test(allowanceYocto) && BigInt(allowanceYocto) <= MAX_UPDATER_ALLOWANCE_YOCTO;
  return { publicKey, kind: 'function_call', receiverId, methodNames, allowanceYocto, updaterKey, updaterPermission };
}

/** The RPC's key list, or null when it didn't answer or answered in a shape this code doesn't know. */
function signerAccessKeys(answer: { keys: unknown } | null, signer: string, updaterKeys: readonly string[]): AccessKeyStatus[] | null {
  if (!answer) return null;
  try {
    return list(answer.keys).map((k) => accessKeyStatus(k as AccessKeyListEntry, signer, updaterKeys));
  } catch {
    return null;
  }
}

async function readUpdater(db: D1Database): Promise<GovernanceStatus['updater']> {
  try {
    const [runs, proposals] = await db.batch([
      db.prepare('SELECT provider, at_ms, outcome, code, summary FROM issuer_key_sync_runs ORDER BY provider'),
      db.prepare('SELECT provider, kid, op, change_id, proposed_at, cancelled_seen_at FROM issuer_key_proposals ORDER BY proposed_at, kid'),
    ]);
    type Run = { provider: string; at_ms: number; outcome: 'ok' | 'error' | 'skipped'; code: string | null; summary: string };
    type Proposal = { provider: string; kid: string; op: 'Add' | 'Remove'; change_id: number | null; proposed_at: number; cancelled_seen_at: number | null };
    return {
      lastRuns: (runs!.results as Run[]).map((r) => {
        let summary: unknown = null;
        try {
          summary = JSON.parse(r.summary);
        } catch {
          summary = null;
        }
        return { provider: r.provider, atMs: r.at_ms, outcome: r.outcome, code: r.code, summary };
      }),
      proposals: (proposals!.results as Proposal[]).map((p) => ({ provider: p.provider, kid: p.kid, op: p.op, changeId: p.change_id, proposedAtMs: p.proposed_at, cancelledSeenAtMs: p.cancelled_seen_at })),
    };
  } catch {
    return null;
  }
}

/** Reads and assembles the status. Throws when a contract view fails or answers in an unknown shape. */
export async function readGovernanceStatus(env: Env, now: number = Date.now()): Promise<GovernanceStatus> {
  const rpc = new Rpc(env.NEAR_RPC);
  const signer = env.SIGNER_ACCOUNT;
  const [configRaw, governanceRaw, changesRaw, issuersRaw, accessKeys, jwksList, updater] = await Promise.all([
    rpc.view<unknown>(signer, 'get_config', {}),
    rpc.view<unknown>(signer, 'get_governance', {}),
    rpc.view<unknown>(signer, 'get_key_changes', {}),
    Promise.all(PROVIDERS.map((provider) => rpc.view<unknown>(signer, 'get_issuer', { provider }))),
    rpc.viewAccessKeyList(signer).then(
      (r) => r,
      () => null,
    ),
    Promise.all(PROVIDERS.map((provider) => publishedKeys(provider, now))),
    readUpdater(env.DB),
  ]);
  const config = obj(configRaw);
  const governance = obj(governanceRaw);
  const changes = parseKeyChanges(changesRaw);
  if (!changes) throw new ShapeError();
  const jwksByProvider = new Map<string, readonly { kid: string; n: string; e: string }[] | null>(PROVIDERS.map((p, i) => [p, jwksList[i] ?? null]));
  const updaterKeys = list(governance.updater_keys).map(str);

  return {
    signer,
    env: env.ENV_NAME,
    readAtMs: now,
    stateVersion: num(governance.state_version),
    paused: bool(config.paused),
    unpausedAtMs: num(config.unpaused_at_ms),
    changesUnlockFloorMs: num(config.changes_unlock_floor_ms),
    sessionsValidFromMs: num(config.sessions_valid_from_ms),
    delays: {
      issuerKeyDelayMs: num(config.issuer_key_delay_ms),
      governanceDelayMs: num(config.governance_delay_ms),
      changeDelayMs: num(config.change_delay_ms),
      pendingIssuerKeyDelay: delayChange(config.pending_issuer_key_delay),
      pendingGovernanceDelay: delayChange(config.pending_governance_delay),
      pendingChangeDelay: delayChange(config.pending_change_delay),
    },
    issuers: PROVIDERS.map((provider, i) => ({
      provider,
      activeKids: issuerKids(issuersRaw[i]) ?? [],
      jwksKids: jwksByProvider.get(provider)?.map((k) => k.kid) ?? null,
    })),
    keyChanges: changes.map((c) => ({
      id: c.id,
      provider: c.provider,
      kid: c.kid,
      op: c.op,
      by: c.by,
      proposedAtMs: c.proposed_at_ms,
      executableAtMs: c.executable_at_ms,
      due: c.executable_at_ms <= now,
      jwks: jwksVerdict(c, jwksByProvider.get(c.provider) ?? null),
    })),
    watchdogs: list(governance.watchdogs).map((w) => {
      const o = obj(w);
      const confirmFromMs = num(o.confirm_from_ms);
      return { accountId: str(o.account_id), confirmFromMs, canConfirm: confirmFromMs <= now };
    }),
    keysSlowUntilMs: num(governance.keys_slow_until_ms),
    updaterKeys,
    updaterMethods: list(governance.updater_methods).map(str),
    signerAccessKeys: signerAccessKeys(accessKeys, signer, updaterKeys),
    pendingUpgrade: optional(governance.pending_upgrade, (o) => {
      const executableAtMs = num(o.executable_at_ms);
      return { codeHash: str(o.code_hash), proposedAtMs: num(o.proposed_at_ms), executableAtMs, due: executableAtMs <= now };
    }),
    pendingOwner: optional(governance.pending_owner, (o) => {
      const acceptableAtMs = num(o.acceptable_at_ms);
      return { owner: str(o.owner), acceptableAtMs, due: acceptableAtMs <= now };
    }),
    pendingWithdrawal: optional(governance.pending_withdrawal, (o) => {
      const executableAtMs = num(o.executable_at_ms);
      return { receiver: str(o.receiver), amountYocto: str(o.amount), executableAtMs, due: executableAtMs <= now };
    }),
    pendingConsoleAudiences: pendingClients(config.pending_console_audiences ?? []),
    pendingSharedClients: pendingClients(config.pending_shared_clients ?? []),
    updater,
  };
}

let cached: { status: GovernanceStatus; until: number } | null = null;
let building: Promise<GovernanceStatus> | null = null;

/** The isolate's snapshot, at most GOVERNANCE_CACHE_MS old; concurrent misses share one read. */
async function snapshot(env: Env): Promise<GovernanceStatus> {
  const now = Date.now();
  if (cached && cached.until > now) return cached.status;
  if (building) return building;
  building = readGovernanceStatus(env, now)
    .then((status) => {
      cached = { status, until: now + GOVERNANCE_CACHE_MS };
      return status;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

export async function handleGovernance(request: Request, env: Env, requestId: string): Promise<Response> {
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-request-id' };
  const ctx = newCtx(env, requestId, GOVERNANCE_ENDPOINT, request, cors);
  let status: GovernanceStatus;
  try {
    status = await snapshot(env);
  } catch (err) {
    if (err instanceof ShapeError) return done(ctx, 502, { error: 'The contract answered with an unexpected governance state', code: 'bad_contract_result' });
    return done(ctx, 502, { error: 'Could not read the governance state', code: 'near_unavailable' });
  }
  // Countdowns are the reader's: `readAtMs` says how old the snapshot is.
  return done(ctx, 200, { ...status }, { 'cache-control': `public, max-age=${GOVERNANCE_CACHE_MS / 1000}` });
}

/** Tests only. */
export function clearGovernanceCache(): void {
  cached = null;
  building = null;
}
