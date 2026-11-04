// The emailed links' POST confirms (docs/batch-c-spec.md "Console BFF routes"): `POST /api/cancel` (a guarded change,
// checked by the API: `ConsoleRpc.cancelChangeByLink`) and `POST /api/owner-grants/cancel` (an owner grant, checked
// here). No session: the token is the proof, the actor is `link`. The pages that post them (`/cancel/:changeId`,
// `/cancel-owner/:grantId`, the token in the fragment) are SPA routes (C10); a GET never cancels, so a mail scanner
// fetching the link changes nothing. Both are rate-limited per IP before the body is read, and run under the CSRF
// rules like every non-GET request.
import { cancelByLinkBody, fromB64url, ownerGrantCancelBody } from '@hana-id/console-core';
import { type Writer, auditInsert, entry } from './audit.ts';
import type { Env } from './env.ts';
import { RpcRefusal } from './errors.ts';
import { cancelOwnerGrantByLink } from './grants.ts';
import { errorResponse, json, readJson } from './http.ts';
import { ipPrefix, ipSubject } from './ip.ts';
import { CONSOLE_LIMIT_PERIOD_S, consoleIpKey } from './limits.ts';
import { log } from './log.ts';

export interface RequestInfo {
  requestId: string;
  clientIp: string;
  country: string | null;
}

/** The per-IP flood limit of the link routes (limits.ts), or null when within it. */
async function limited(env: Env, info: RequestInfo): Promise<Response | null> {
  const { success } = await env.CONSOLE_IP_LIMIT.limit({ key: consoleIpKey(env.ENV_NAME, 'link', ipSubject(info.clientIp)) });
  return success ? null : errorResponse('rate_limited', undefined, { 'retry-after': String(CONSOLE_LIMIT_PERIOD_S) });
}

/**
 * Codes after which the attempt is worth an audit row: a real cancel, or a refusal of a valid link (too late, already
 * used). Wrong tokens, malformed input and rate limits are only logged (D244): anyone can send them, and audit rows
 * are kept 5 years.
 */
const AUDITED_FAILURES: ReadonlySet<string> = new Set(['not_pending', 'already_applied', 'conflict', 'internal', 'near_unavailable']);

/** `POST /api/cancel {changeId, token}` → the cancelled GuardedChange. */
export async function cancelChangeLink(request: Request, env: Env, info: RequestInfo): Promise<Response> {
  const over = await limited(env, info);
  if (over) return over;
  const body = await readJson(request);
  if (!body.ok) return errorResponse(body.code);
  const parsed = cancelByLinkBody.safeParse(body.value);
  if (!parsed.success) return errorResponse('bad_request', 'Expected {changeId, token}');
  const { changeId, token } = parsed.data;
  let answer: Awaited<ReturnType<Env['API']['cancelChangeByLink']>>;
  try {
    answer = await env.API.cancelChangeByLink({ actor: { kind: 'link', id: changeId }, requestId: info.requestId, clientIp: info.clientIp, changeId, token });
  } catch (err) {
    log({ event: 'link_cancel', method: 'cancelChangeByLink', requestId: info.requestId, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    return errorResponse('internal');
  }
  const code = answer.ok ? null : answer.code;
  log({ event: 'link_cancel', method: 'cancelChangeByLink', requestId: info.requestId, outcome: answer.ok ? 'ok' : 'rejected', ...(code ? { code } : {}) });
  // The outcome row, written after the RPC returns (docs/batch-c-spec.md "Audit"); app_changes is authoritative.
  if (answer.ok || AUDITED_FAILURES.has(code!)) {
    const w: Writer = { actor: { kind: 'link', id: changeId }, requestId: info.requestId, now: Date.now(), ipPrefix: ipPrefix(info.clientIp), country: info.country };
    try {
      await auditInsert(env.CONSOLE_DB, entry(w, 'change.link_cancel', { appId: answer.ok ? answer.change.appId : null, target: changeId, outcome: answer.ok ? 'ok' : 'failed', details: code ? { code } : {} })).run();
    } catch (err) {
      log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
    }
  }
  return answer.ok ? json(200, answer.change) : errorResponse(answer.code, answer.error);
}

/** `POST /api/owner-grants/cancel {grantId, token}` → `{}`. */
export async function cancelOwnerGrantLink(request: Request, env: Env, info: RequestInfo): Promise<Response> {
  const over = await limited(env, info);
  if (over) return over;
  const body = await readJson(request);
  if (!body.ok) return errorResponse(body.code);
  const parsed = ownerGrantCancelBody.safeParse(body.value);
  if (!parsed.success) return errorResponse('bad_request', 'Expected {grantId, token}');
  const { grantId, token } = parsed.data;
  const w: Writer = { actor: { kind: 'link', id: grantId }, requestId: info.requestId, now: Date.now(), ipPrefix: ipPrefix(info.clientIp), country: info.country };
  try {
    await cancelOwnerGrantByLink(env.CONSOLE_DB, w, grantId, fromB64url(token));
    log({ event: 'link_cancel', method: 'cancelOwnerGrantByLink', requestId: info.requestId, outcome: 'ok' });
    return json(200, {});
  } catch (err) {
    if (err instanceof RpcRefusal) {
      log({ event: 'link_cancel', method: 'cancelOwnerGrantByLink', requestId: info.requestId, outcome: 'rejected', code: err.code });
      return errorResponse(err.code, err.message);
    }
    log({ event: 'link_cancel', method: 'cancelOwnerGrantByLink', requestId: info.requestId, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
    return errorResponse('internal');
  }
}
