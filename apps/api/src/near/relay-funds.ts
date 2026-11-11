// The NEAR relay account's hourly funds check (D736), beside the owner pool's allowance check (owner-pool.ts): the
// relay account's balance below the manifest's `near.relay.lowBalanceNear` (default 2 NEAR), or the account missing,
// writes one `near_relay_balance_low` security event per UTC day (a fixed id), which the admin's Security &
// monitoring view shows and its feed emails. Amounts only; the account is a public name from the manifest.
import { eventId } from '../changes/guard.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { parseNearRelayConfig } from './relay-config.ts';
import { isUnknownAccount } from './relay-chain.ts';
import { nearRpc } from './rpc.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The hourly job. Off without a relay config or on any network but testnet. Returns the events written; never throws. */
export async function checkNearRelayFunds(env: Env, now: number = Date.now()): Promise<number> {
  const config = env.NETWORK === 'testnet' ? parseNearRelayConfig(env.NEAR_RELAY) : null;
  if (!config || !env.NEAR_RELAY_KEYS) return 0;
  let balance: bigint | null;
  try {
    const a = await nearRpc(env).call<{ amount: string }>('query', { request_type: 'view_account', finality: 'final', account_id: config.account }, 8_000);
    balance = /^\d{1,40}$/u.test(a.amount) ? BigInt(a.amount) : null;
    if (balance === null) throw new Error('Unreadable balance');
  } catch (e) {
    if (isUnknownAccount(e)) balance = null;
    else {
      log({ event: 'near_relay_funds_check', outcome: 'error', code: 'near_unavailable' }, 'error');
      return 0;
    }
  }
  if (balance !== null && balance >= config.lowBalanceYocto) return 0;
  const day = new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
  try {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'near_relay_balance_low', ?3)")
      .bind(
        await eventId('near_relay_balance_low', config.account, day),
        now,
        JSON.stringify({ account: config.account, balanceYocto: balance?.toString() ?? null, missing: balance === null, thresholdYocto: config.lowBalanceYocto.toString(), day }),
      )
      .run();
    log({ event: 'near_relay_funds_check', outcome: 'ok', code: 'near_relay_balance_low' }, 'warn');
    return r.meta.changes ?? 0;
  } catch {
    log({ event: 'near_relay_funds_check', outcome: 'error', code: 'event_write_failed' }, 'error');
    return 0;
  }
}
