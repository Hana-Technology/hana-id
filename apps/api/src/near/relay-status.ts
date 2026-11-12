// The NEAR relay's part of `AdminRpc.systemStatus` (D784–D786; the admin's System status page, its "NEAR relay" tile):
// whether the relay is on, the relay account's balance and its full-access keys against the API's relay keys, and the
// UTC day's spend against `dailyBudgetNear`. The admin judges it; this only reads.
//
// Reads, per status call and only when a config is readable: `view_account` and `view_access_key_list` of the relay
// account in parallel (the API's RPC failover, 5 s per endpoint), and one RateLimiter `spent` (read only). None when the
// relay is off. The keys are compared here, by public key derived from NEAR_RELAY_KEYS as `nearRelayReady` does: no
// secret leaves `nearRelayKeys`, and the answer holds counts and the public keys missing on chain only. Never throws.
import type { NearRelayStatus } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { NEAR_RELAY_LIMITS, parseNearRelayConfig } from './relay-config.ts';
import { isUnknownAccount } from './relay-chain.ts';
import { nearRelayConfig, nearRelayKeys, nearRelaySpent } from './relay.ts';
import { type AccessKeyListEntry, nearRpc } from './rpc.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Per endpoint (the page's own probes take 5 s too). */
export const RELAY_STATUS_TIMEOUT_MS = 5_000;
/** NEAR's storage price: 10^19 yocto per byte (what storage locks; the watchdog's `available` is the same). */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
const DIGITS = /^\d{1,40}$/u;

type Chain = NonNullable<NearRelayStatus['chain']>;

async function readChain(env: Env, account: string): Promise<{ chain: Chain; fullAccess: Set<string> }> {
  const rpc = nearRpc(env);
  const [view, list] = await Promise.allSettled([
    rpc.call<{ amount?: unknown; storage_usage?: unknown }>('query', { request_type: 'view_account', finality: 'final', account_id: account }, RELAY_STATUS_TIMEOUT_MS),
    rpc.call<{ keys?: AccessKeyListEntry[] }>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account }, RELAY_STATUS_TIMEOUT_MS),
  ]);
  if (view.status === 'rejected') {
    if (isUnknownAccount(view.reason)) return { chain: { ok: true, exists: false, availableYocto: '0', fullAccessKeys: 0 }, fullAccess: new Set() };
    return { chain: { ok: false, code: 'near_unavailable' }, fullAccess: new Set() };
  }
  const amount = typeof view.value.amount === 'string' && DIGITS.test(view.value.amount) ? BigInt(view.value.amount) : null;
  const storage = typeof view.value.storage_usage === 'number' && Number.isSafeInteger(view.value.storage_usage) && view.value.storage_usage >= 0 ? BigInt(view.value.storage_usage) : null;
  const keys = list.status === 'fulfilled' && Array.isArray(list.value.keys) ? list.value.keys : null;
  if (amount === null || storage === null || keys === null) return { chain: { ok: false, code: 'near_unavailable' }, fullAccess: new Set() };
  const locks = storage * STORAGE_YOCTO_PER_BYTE;
  const fullAccess = new Set(keys.filter((k) => typeof k?.public_key === 'string' && k.access_key?.permission === 'FullAccess').map((k) => k.public_key));
  return { chain: { ok: true, exists: true, availableYocto: (amount > locks ? amount - locks : 0n).toString(), fullAccessKeys: fullAccess.size }, fullAccess };
}

async function readSpend(env: Env, now: number): Promise<NonNullable<NearRelayStatus['spend']>> {
  try {
    const spent = await nearRelaySpent(env, now);
    if (!DIGITS.test(spent)) return { ok: false, code: 'rate_limiter_unavailable' };
    return { ok: true, day: new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString().slice(0, 10), spentYocto: spent };
  } catch {
    return { ok: false, code: 'rate_limiter_unavailable' };
  }
}

export async function nearRelayStatus(env: Env, now: number = Date.now()): Promise<NearRelayStatus> {
  const off = (offReason: NonNullable<NearRelayStatus['offReason']>): NearRelayStatus => ({ state: 'off', offReason, readAt: now, account: null, lowBalanceYocto: null, dailyBudgetYocto: null, budgetAlertPct: null, chain: null, keys: null, spend: null });
  if (env.NETWORK !== 'testnet') return off('not_testnet');
  if (!env.NEAR_RELAY) return off('none');
  const parsed = parseNearRelayConfig(env.NEAR_RELAY);
  if (parsed && parsed.receivers.length === 0) return off('no_receivers');
  const config = nearRelayConfig(env);
  if (!config) return { ...off('none'), state: 'bad_config', offReason: null };
  const keys = nearRelayKeys(env);
  const state: NearRelayStatus['state'] = keys.state === 'ok' ? 'on' : keys.state === 'none' ? 'no_keys' : 'bad_keys';
  const [{ chain, fullAccess }, spend] = await Promise.all([readChain(env, config.account).catch(() => ({ chain: { ok: false, code: 'near_unavailable' } as Chain, fullAccess: new Set<string>() })), readSpend(env, now)]);
  if (!chain.ok) log({ event: 'system_status', outcome: 'error', code: 'near_relay_unreadable' }, 'warn');
  let keyView: NearRelayStatus['keys'] = null;
  if (keys.state === 'ok' && chain.ok) {
    keyView = { configured: keys.publicKeys.length, missing: keys.publicKeys.filter((k) => !fullAccess.has(k)) };
  }
  return {
    state,
    offReason: null,
    readAt: now,
    account: config.account,
    lowBalanceYocto: config.lowBalanceYocto.toString(),
    dailyBudgetYocto: config.dailyBudgetYocto.toString(),
    budgetAlertPct: NEAR_RELAY_LIMITS.budgetAlertPct,
    chain,
    keys: keyView,
    spend,
  };
}
