// SendGrid's signed Event Webhook (spec "Deliverability": "The provider's bounce and complaint webhooks feed
// email_suppressions(email_key, reason, at)"). The signature is ECDSA P-256 / SHA-256 (base64 DER) over
// timestamp ‖ raw body, verified with the account's verification key (a public value, manifest
// `emailIssuer.sendgridWebhookPublicKey`). Hard bounces and spam reports are stored as `email_key` (HMAC under K_rl) of
// the normalized address; the address itself is dropped at once and never logged.
import { base64Decode } from './bytes.ts';
import { normalizeEmail } from '@hana-id/email';
import { readCapped } from './http.ts';
import { type IssuerKeys, emailKey } from './keys.ts';

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
export const WEBHOOK_MAX_EVENTS = 1000;
/** A signed batch older (or newer) than this is refused (replay). */
export const WEBHOOK_MAX_AGE_S = 600;

/** DER ECDSA signature → IEEE P1363 (r ‖ s, 32 bytes each), as Web Crypto verifies it; null when malformed. */
export function derToP1363(der: Uint8Array): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  let len = der[i++]!;
  if (len & 0x80) {
    if (len !== 0x81) return null;
    len = der[i++]!;
  }
  if (i + len !== der.length) return null;
  const out = new Uint8Array(64);
  for (const at of [0, 32]) {
    if (der[i++] !== 0x02) return null;
    const n = der[i++]!;
    if (n === 0 || n > 33 || i + n > der.length) return null;
    let int = der.subarray(i, i + n);
    i += n;
    if (int.length === 33) {
      if (int[0] !== 0) return null;
      int = int.subarray(1);
    }
    out.set(int, at + 32 - int.length);
  }
  return i === der.length ? out : null;
}

export async function verifyWebhook(publicKeyB64: string, timestamp: string, body: Uint8Array, signatureB64: string, nowS: number): Promise<boolean> {
  if (!/^\d{1,12}$/u.test(timestamp) || Math.abs(nowS - Number(timestamp)) > WEBHOOK_MAX_AGE_S) return false;
  try {
    const key = await crypto.subtle.importKey('spki', base64Decode(publicKeyB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = derToP1363(base64Decode(signatureB64));
    if (!sig) return false;
    const signed = new Uint8Array(timestamp.length + body.length);
    signed.set(new TextEncoder().encode(timestamp), 0);
    signed.set(body, timestamp.length);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed);
  } catch {
    return false;
  }
}

export type Suppression = { emailKey: string; reason: 'bounce' | 'complaint' };

/** The suppressions a verified batch carries: hard bounces (not `blocked`) and spam reports. */
export async function suppressionsOf(keys: IssuerKeys, events: unknown): Promise<Suppression[] | null> {
  if (!Array.isArray(events) || events.length > WEBHOOK_MAX_EVENTS) return null;
  const out = new Map<string, Suppression>();
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const ev = e as Record<string, unknown>;
    const reason = ev.event === 'spamreport' ? 'complaint' : ev.event === 'bounce' && ev.type !== 'blocked' ? 'bounce' : null;
    if (!reason || typeof ev.email !== 'string') continue;
    const r = normalizeEmail(ev.email);
    if (!r.ok) continue;
    const k = await emailKey(keys, r.email);
    if (!out.has(k) || reason === 'complaint') out.set(k, { emailKey: k, reason });
  }
  return [...out.values()];
}

export async function readWebhookBody(request: Request): Promise<Uint8Array | null> {
  try {
    return await readCapped(request.body, WEBHOOK_MAX_BYTES, request.headers.get('content-length'));
  } catch {
    return null;
  }
}
