// Structured JSON logs. Only the fields below can be logged: never a key, token, webhook URL, request body or
// contract panic text. Kids, change ids, method names and transaction hashes are public.

export interface LogFields {
  event: string;
  outcome?: 'ok' | 'rejected' | 'error' | 'skipped';
  code?: string;
  runId?: number;
  method?: string;
  changeId?: number;
  kid?: string;
  nearTx?: string;
  alertId?: number;
  severity?: string;
  channel?: string;
  status?: number;
  checks?: number;
  actions?: number;
  alerts?: number;
  latencyMs?: number;
}

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), service: 'watchdog', ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
