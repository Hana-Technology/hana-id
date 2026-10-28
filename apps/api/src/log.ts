// Structured JSON logs. Only the fields below can be logged: never JWTs, signatures, request bodies, keys,
// CKD responses or contract panic text (which can echo inputs).

export interface LogFields {
  event: string;
  requestId?: string;
  appId?: string;
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
  /** Vault maintenance (vault/cron.ts): shares pruned, re-wrapped, unreadable, and under an unknown KEK id. */
  pruned?: number;
  rewrapped?: number;
  unreadable?: number;
  unknownKek?: number;
  /** Why a stored auto-approve policy was refused (vault/settings.ts): validator paths and limits, at most 5. */
  problems?: string[];
}

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
