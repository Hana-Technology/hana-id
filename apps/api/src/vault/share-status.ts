// POST /v1/vault/share-status (D690): the vault's light check that its share is still live, so a sign-out from Hana
// Home reaches a tab already open (D680) without GET /v1/app's chain reads, settings rows or per-IP config window.
//
// - Vault only (`Origin: VAULT_ORIGIN`, an allowed `x-hana-parent-origin`), through the vault gate's app check, whose app
//   comes from the isolate's cache (D78): a warm request reads one D1 statement, the share's row joined to its app.
// - Named by the share id alone: 128 random bits only the vault, the API and the account's own Hana Home ever hold, for a
//   one-bit answer about that share. No session proof: a signature check on every read would cost CPU on every check and
//   prove nothing more (a proof without a counter replays; one with a counter is a write).
// - Its own flood limits on Rate Limiting bindings (no Durable Object, no network hop): per share, and a per-IP ceiling
//   high enough for a NAT. No app quota, no chain call, no usage event.
// - Only ever an answer: `live` or `revoked` (shareStatus: revoked, gone, the app no longer keeping logins, its origin
//   removed). It reads and slides nothing: no `idle_until`, no counter (D55, D539). Any refusal is no answer to the
//   vault, never `revoked`.
import { hex } from '../bytes.ts';
import type { Env } from '../env.ts';
import { done, lap, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { ipSubject } from '../ip.ts';
import { log } from '../log.ts';
import { shareStatus } from './consent-store.ts';
import { vaultApp } from './endpoints.ts';
import { VAULT_LIMIT_PERIOD_S, statusIpKey, statusShareKey } from './limits.ts';
import { SHARE_ID_BYTES } from './message.ts';
import { parentOriginAllowed } from './origins.ts';

export const SHARE_STATUS_ENDPOINT = '/v1/vault/share-status';
/** The body is one 16-byte array. */
const MAX_BODY = 256;

const limited = (ctx: Parameters<typeof reject>[0], which: string): Response =>
  reject(ctx, 429, 'rate_limited', `Rate limit exceeded (${which} per minute)`, { 'retry-after': String(VAULT_LIMIT_PERIOD_S) });

function toShareId(body: unknown): Uint8Array | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (Object.keys(o).length !== 1 || !Array.isArray(o.shareId) || o.shareId.length !== SHARE_ID_BYTES) return null;
  if (!o.shareId.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  return Uint8Array.from(o.shareId as number[]);
}

export async function handleShareStatus(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, SHARE_STATUS_ENDPOINT, request);
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app } = gate;
  try {
    const ip = await env.VAULT_STATUS_IP_LIMIT.limit({ key: statusIpKey(env.ENV_NAME, app.id, ipSubject(request.headers.get('cf-connecting-ip'))) });
    if (!ip.success) return limited(ctx, 'per IP');
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const shareId = toShareId(parsed.body);
  if (!shareId) return reject(ctx, 400, 'bad_request', 'Body must be {shareId: 16 bytes}');
  try {
    const hit = await env.VAULT_STATUS_SHARE_LIMIT.limit({ key: statusShareKey(env.ENV_NAME, app.id, hex(shareId)) });
    if (!hit.success) return limited(ctx, 'share');
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  lap(ctx, 'limits');
  let share: 'live' | 'revoked';
  try {
    share = await shareStatus(env.DB, app.id, shareId, (origin) => parentOriginAllowed(env.ENV_NAME, app, origin));
  } catch {
    log({ event: 'share_status_unavailable', requestId, appId: app.id, endpoint: ctx.endpoint }, 'warn');
    return reject(ctx, 503, 'share_status_unavailable', 'The share’s status could not be read, try again');
  }
  lap(ctx, 'share');
  return done(ctx, 200, { share, serverTimeMs: Date.now() });
}
