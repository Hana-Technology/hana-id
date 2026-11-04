// Structured JSON logs, one line per event. Only the fields below can be logged, and none can carry personal data or a
// secret: never an email address (staff, contacts, invitees, members), a Google or Access `sub`, a JWT, a link token or
// its hash, an email body, a request body or a full IP address. Ids (`org_…`, `gc_…`, `inv_…`, `og_…`, scope ids),
// codes and counts are what an operator gets.

export interface LogFields {
  event: string;
  requestId?: string;
  /** The BFF route (method and pattern, never the concrete path: it can carry an id we don't log) or the RPC method. */
  route?: string;
  method?: string;
  orgId?: string;
  scopeId?: string;
  /** A guarded change, invite or grant id (not personal data; never a token). */
  target?: string;
  outcome?: 'ok' | 'rejected' | 'error' | 'skipped';
  status?: number;
  code?: string;
  /** The 5-minute cron: which step, and what it did. */
  step?: string;
  count?: number;
  sent?: number;
  failed?: number;
  /** An error's class name only (never its message, which can echo input or a driver's host name). */
  error?: string;
}

const ALLOWED: ReadonlySet<string> = new Set(['event', 'requestId', 'route', 'method', 'orgId', 'scopeId', 'target', 'outcome', 'status', 'code', 'step', 'count', 'sent', 'failed', 'error']);

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line: Record<string, unknown> = { level, at: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) if (ALLOWED.has(k) && v !== undefined) line[k] = v;
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');
