// Structured JSON logs. Only the fields below can be logged: never JWTs, signatures, request bodies, keys,
// CKD responses or contract panic text (which can echo inputs).

export interface LogFields {
  event: string;
  requestId?: string;
  appId?: string;
  /** Batch C's RPC calls (rpc/common.ts): the caller's org and actor kind (never the actor's id or email). */
  orgId?: string;
  actorKind?: string;
  endpoint?: string;
  method?: string;
  outcome?: 'ok' | 'rejected' | 'error';
  status?: number;
  code?: string;
  latencyMs?: number;
  /** Milliseconds per stage of a request (see handlers.ts `lap`). */
  phases?: Record<string, number>;
  /** Cloudflare data center that ran the request (e.g. SIN). */
  colo?: string;
  /** The relayer key object instance that served a relay (see relayer-key.ts RelayInstance). */
  relayInstance?: { cold: boolean; coldChainRead: boolean; blockRefresh: boolean; served: number; ageMs: number };
  nearTx?: string;
  pool?: string;
  keyIndex?: number;
  nonce?: string;
  attempt?: number;
  added?: number;
  removed?: number;
  kids?: string[];
  /** Issuer key changes (issuer-keys.ts): a change id, and how many matured changes a run executed. */
  changeId?: number;
  executed?: number;
  /** Vault maintenance (vault/cron.ts): shares pruned, re-wrapped, unreadable, and under an unknown KEK id. */
  pruned?: number;
  rewrapped?: number;
  unreadable?: number;
  unknownKek?: number;
  /** The identity token's signing key (RFC 7638 thumbprint, public). */
  kid?: string;
  /** Why a stored auto-approve policy was refused (vault/settings.ts): validator paths and limits, at most 5. */
  problems?: string[];
  /** The hourly guarded-change job (guarded/cron.ts): a change id (`gc_…`), what failed, and the run's counts. */
  guardedChangeId?: string;
  what?: string;
  activated?: number;
  superseded?: number;
  expired?: number;
  /** The hourly identity-count copy to the usage ledger (usage/identity-sync.ts): rows sent. */
  synced?: number;
  /**
   * `near_rpc_failover` (near/rpc.ts, D435): the endpoint passed over and the one asked next, as indexes into
   * NEAR_RPC followed by NEAR_RPC_FALLBACKS (0 is NEAR_RPC). Never the URL, which can carry a provider's API key.
   */
  rpcEndpoint?: number;
  nextRpcEndpoint?: number;
  /** The mainnet demo's price refresh (mainnet-demo-prices.ts, D436): which CoinGecko attempt. Never a URL or key. */
  priceSource?: 'pro' | 'demo' | 'public';
}

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** `onStaleKeys` for @hana-id/oidc verifyIdToken: an expired Google JWKS was served because its refetch failed. */
export const logStaleJwks = (): void => log({ event: 'jwks_stale', code: 'issuer_keys_unavailable' }, 'warn');
