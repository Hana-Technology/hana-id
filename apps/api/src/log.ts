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
  nearTx?: string;
  keyIndex?: number;
  nonce?: string;
  attempt?: number;
  added?: number;
  removed?: number;
  kids?: string[];
}

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
