// Structured JSON logs. Only the fields below can be logged, and none of them can hold an email address, a code, a
// `sub`, a token, an access token, a key or a request body (spec "The token": "It logs `jti`, purpose, app, `kid`,
// time; never the email, code, `sub` or the token"). `appId` and `scopeId` are Hana's own ids; `jti` and `kid` are
// public. A log-capture test greps every line of every flow for the address, the code, the `sub` and the tokens.

export interface LogFields {
  event: string;
  requestId?: string;
  endpoint?: string;
  outcome?: 'ok' | 'rejected' | 'error' | 'suppressed';
  status?: number;
  code?: string;
  appId?: string;
  scopeId?: string;
  purpose?: string;
  jti?: string;
  kid?: string;
  decision?: string;
  /** Which limit refused (a name such as `ip:start:10m`, never its key). */
  limit?: string;
  /** Provider HTTP status (SendGrid, Google, KMS, NEAR RPC). */
  providerStatus?: number;
  latencyMs?: number;
  count?: number;
}

export function log(fields: LogFields, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), service: 'email-issuer', ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
