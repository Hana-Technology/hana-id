// The hourly owner-pool allowance check (docs/batch-c-spec.md "On-chain owner actions", Allowance alert): each key of
// OWNER_RELAYER_KEYS pays for /v1/owner-actions and ConsoleRpc.ownerAction from its function-call allowance, and a key
// whose allowance runs out can relay nothing (a safety call then needs the staff relay runbook). The API reads the
// relayer account's access keys once (`view_access_key_list`) and writes an `owner_allowance_low` security event for a
// key below 25% of its initial allowance, or missing from the account, once per key and UTC day (a deterministic id);
// the admin Worker's feed emails it. Public keys only: no secret is read beyond the pool's own parsing.
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { eventId } from './changes/guard.ts';
import type { Env } from './env.ts';
import { log } from './log.ts';
import { nearRpc } from './near/rpc.ts';
import { OWNER_POOL_ALLOWANCE_YOCTO, parseRelayerKeys } from './relayer-config.ts';

/** Below this share of its initial allowance a key is reported. */
export const OWNER_ALLOWANCE_LOW_PCT = 25n;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The allowance each owner-pool key started with: the var OWNER_POOL_ALLOWANCE_YOCTO (decimal yocto) or the deploy default. */
export function initialOwnerAllowance(env: Env): bigint {
  const v = env.OWNER_POOL_ALLOWANCE_YOCTO;
  return v && /^[1-9]\d{0,38}$/u.test(v) ? BigInt(v) : OWNER_POOL_ALLOWANCE_YOCTO;
}

export interface AllowanceFinding {
  publicKey: string;
  /** Null: the key is not on the relayer account. */
  allowanceYocto: string | null;
}

/** The owner-pool keys below the threshold or missing, from the relayer account's key list. Throws when NEAR can't be read. */
export async function lowOwnerAllowances(env: Env): Promise<AllowanceFinding[]> {
  const keys = parseRelayerKeys(env.OWNER_RELAYER_KEYS, 'OWNER_RELAYER_KEYS').map((k) => KeyPair.fromString(k as KeyPairString).getPublicKey().toString());
  if (!keys.length) return [];
  const threshold = (initialOwnerAllowance(env) * OWNER_ALLOWANCE_LOW_PCT) / 100n;
  const { keys: onChain } = await nearRpc(env).viewAccessKeyList(env.RELAYER_ACCOUNT);
  const out: AllowanceFinding[] = [];
  for (const publicKey of keys) {
    const entry = onChain.find((k) => k.public_key === publicKey);
    if (!entry) {
      out.push({ publicKey, allowanceYocto: null });
      continue;
    }
    const p = entry.access_key.permission;
    // A full-access key or an unlimited allowance has nothing to run out of (deploy-contract never adds either).
    if (p === 'FullAccess' || p.FunctionCall.allowance === null) continue;
    const allowance = p.FunctionCall.allowance;
    if (!/^\d{1,40}$/u.test(allowance) || BigInt(allowance) < threshold) out.push({ publicKey, allowanceYocto: allowance });
  }
  return out;
}

/** The hourly job: one event per low or missing key per UTC day. Never throws (a failure is logged). */
export async function checkOwnerPoolAllowance(env: Env, now: number = Date.now()): Promise<number> {
  let findings: AllowanceFinding[];
  try {
    findings = await lowOwnerAllowances(env);
  } catch {
    log({ event: 'owner_allowance_check', outcome: 'error', code: 'near_unavailable' }, 'error');
    return 0;
  }
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  const initial = initialOwnerAllowance(env).toString();
  let written = 0;
  for (const f of findings) {
    try {
      const r = await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'owner_allowance_low', ?3)")
        .bind(
          await eventId('owner_allowance_low', f.publicKey, String(day)),
          now,
          JSON.stringify({ publicKey: f.publicKey, allowanceYocto: f.allowanceYocto, missing: f.allowanceYocto === null, initialYocto: initial, thresholdPct: Number(OWNER_ALLOWANCE_LOW_PCT), day: new Date(day).toISOString().slice(0, 10) }),
        )
        .run();
      written += r.meta.changes ?? 0;
    } catch {
      log({ event: 'owner_allowance_check', outcome: 'error', code: 'event_write_failed' }, 'error');
    }
  }
  if (findings.length) log({ event: 'owner_allowance_check', outcome: 'ok', code: 'owner_allowance_low' }, 'warn');
  return written;
}
