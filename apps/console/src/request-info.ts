// What every console route knows about its request: an id for its logs and audit rows (Cloudflare's ray id when it is
// well formed), the client address (for the per-IP limits and the coarse prefix kept for staff, never stored whole) and
// the country. The auth origin's requests reach the console through `AuthHandler` with their headers unchanged, so the
// same reading holds there.
import type { RequestInfo } from './links.ts';

const RAY_RE = /^[A-Za-z0-9_-]{8,128}$/u;

export function requestInfo(request: Request): RequestInfo {
  const ray = request.headers.get('cf-ray');
  const requestId = ray && RAY_RE.test(ray) ? ray : `req_${crypto.randomUUID().replaceAll('-', '')}`;
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  return { requestId, clientIp: ip && ip.length <= 64 ? ip : 'unknown', country: typeof cf?.country === 'string' ? cf.country : null };
}
