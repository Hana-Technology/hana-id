// SendGrid's signed Event Webhook (spec "Deliverability": "The provider's bounce and complaint webhooks feed
// email_suppressions(email_key, reason, at)"). The signature is ECDSA P-256 / SHA-256 (base64 DER) over
// timestamp ‖ raw body, verified with the account's verification key (a public value, manifest
// `emailIssuer.sendgridWebhookPublicKey`). Only events of the issuer's own mail (its categories) count; hard bounces
// and spam reports are stored as `email_key` (HMAC under K_sup of the exact normalized address, `+tag` included: a
// bounce on `victim+x@` must not suppress `victim@`, D199); the address itself is dropped at once and never logged.
import { base64Decode, sha256, toHex, utf8 } from './bytes.ts';
import { normalizeEmail } from '@hana-id/email';
import { readCapped } from './http.ts';
import { type IssuerKeys, suppressionKey } from './keys.ts';

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

/** The headers' shape, checked before the body is read (L5): a timestamp within the window, a base64 signature. */
export function webhookHeadersOk(timestamp: string, signatureB64: string, nowS: number): boolean {
  return /^\d{1,12}$/u.test(timestamp) && Math.abs(nowS - Number(timestamp)) <= WEBHOOK_MAX_AGE_S && /^[A-Za-z0-9+/]{80,120}={0,2}$/u.test(signatureB64);
}

/** The imported verification key, per key value (the env's one), so a request doesn't import it again. */
const keyCache = new Map<string, Promise<CryptoKey>>();
const verificationKey = (b64: string): Promise<CryptoKey> => {
  let k = keyCache.get(b64);
  if (!k) {
    k = crypto.subtle.importKey('spki', base64Decode(b64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    k.catch(() => keyCache.delete(b64));
    keyCache.set(b64, k);
  }
  return k;
};

export async function verifyWebhook(publicKeyB64: string, timestamp: string, body: Uint8Array, signatureB64: string, nowS: number): Promise<boolean> {
  if (!webhookHeadersOk(timestamp, signatureB64, nowS)) return false;
  try {
    const key = await verificationKey(publicKeyB64);
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

export type Suppression = { emailKey: string; reason: 'bounce' | 'complaint'; appId: string | null; eventKey: string };

/**
 * What a redelivery of this event is recognised by (`email_webhook_events`, D446 as amended): SendGrid's `sg_event_id`,
 * which its docs give for this purpose. An event without one falls back to its own fields, which a redelivery repeats.
 * Hashed, so the stored key has one length and says nothing.
 */
function eventKeyOf(ev: Record<string, unknown>, reason: string, emailKey: string): string {
  const id = typeof ev.sg_event_id === 'string' && ev.sg_event_id ? `id:${ev.sg_event_id}` : `fields:${reason}:${emailKey}:${String(ev.timestamp)}:${String(ev.sg_message_id)}`;
  return toHex(sha256(utf8(id)));
}

/** The categories the issuer's own mails carry (sendgrid.ts): events of any other mail are ignored (M3). */
export const ISSUER_CATEGORIES: ReadonlySet<string> = new Set(['hana-id-code', 'hana-id-link_notice', 'hana-id-unlock', 'hana-id-confirm']);

const fromIssuer = (category: unknown): boolean =>
  typeof category === 'string' ? ISSUER_CATEGORIES.has(category) : Array.isArray(category) && category.some((c) => typeof c === 'string' && ISSUER_CATEGORIES.has(c));

/** The suppressions a verified batch carries: hard bounces (not `blocked`) and spam reports of the issuer's own mail. */
export async function suppressionsOf(keys: IssuerKeys, events: unknown): Promise<Suppression[] | null> {
  if (!Array.isArray(events) || events.length > WEBHOOK_MAX_EVENTS) return null;
  const out = new Map<string, Suppression>();
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const ev = e as Record<string, unknown>;
    if (!fromIssuer(ev.category)) continue;
    const reason = ev.event === 'spamreport' ? 'complaint' : ev.event === 'bounce' && ev.type !== 'blocked' ? 'bounce' : null;
    if (!reason || typeof ev.email !== 'string') continue;
    const r = normalizeEmail(ev.email);
    if (!r.ok) continue;
    const k = await suppressionKey(keys, r.email);
    const appId = typeof ev.hana_app === 'string' && /^app_[A-Za-z0-9]{1,64}$/u.test(ev.hana_app) ? ev.hana_app : null;
    if (!out.has(k) || reason === 'complaint') out.set(k, { emailKey: k, reason, appId, eventKey: eventKeyOf(ev, reason, k) });
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
