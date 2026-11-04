// Structured JSON logs, one line per event. Only the fields below can be logged, and none can carry personal data or a
// secret: never an email address (invitees, members, staff), a Google `sub`, a token or its hash, a cookie, a request
// body or a full IP address. Ids (`org_…`, `inv_…`, `og_…`, `usr_…`, `gc_…`) and codes are what an operator gets.

export interface LogFields {
  event: string;
  requestId?: string;
  /** StaffRpc and link methods. */
  method?: string;
  actorKind?: string;
  orgId?: string;
  outcome?: 'ok' | 'rejected' | 'error';
  status?: number;
  code?: string;
  /** The hourly cron: what a step did. */
  step?: string;
  count?: number;
  /** An error's class name only (never its message, which can echo input). */
  error?: string;
  /** Sign-in: the name of a refused token claim (never its value). */
  claim?: string;
}

const ALLOWED: ReadonlySet<string> = new Set(['event', 'requestId', 'method', 'actorKind', 'orgId', 'outcome', 'status', 'code', 'step', 'count', 'error', 'claim']);

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line: Record<string, unknown> = { level, at: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) if (ALLOWED.has(k) && v !== undefined) line[k] = v;
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}
