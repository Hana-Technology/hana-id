// EmailSender (docs/batch-c-spec.md "Email", D87, D401): one message in, accepted or an error. Code above it never
// knows the provider; switching to another is a new adapter. SendGrid (the shared @hana-id/sendgrid adapter, D401) is
// the only one in production; the tests use a fake (test/helpers.ts FakeEmail) through `outbound.email` below.
//
// "Accepted" means SendGrid answered 202: anything else (a network error, a timeout, a 4xx, a 5xx, any other 2xx) is
// a failure, so a blocking notice is not acked on it. SendGrid has no idempotency key (Resend's deduplicated a retry
// for 24 h): a retry after a lost answer can deliver a message twice, never zero times. `sendToAll` (mail.ts) skips a
// recipient this isolate already saw accepted for the same message, which removes most repeats (D401). Accepted is
// not delivered: SendGrid drops a message to an address on its suppression lists after the 202, so alerts and
// blocking notices set `bypassSuppressions` (mail.ts BYPASS_PURPOSES; D401 as amended). Errors carry the HTTP status
// only, never the key, the body or the provider's text (which can echo the recipient).
import { sendgridSend } from '@hana-id/sendgrid';

export interface EmailMessage {
  /** Exactly one recipient per message: no contact ever sees another's address. */
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * This message's identity (mail.ts `messageKey`: its purpose and recipient, hashed). Not sent to SendGrid, which has
   * no idempotency key; `sendToAll` uses it to skip a repeat, and it shows in tests which message a send was.
   */
  messageKey: string;
  /** Send even to an address on SendGrid's bounce, spam-report or unsubscribe list (alerts and blocking notices). */
  bypassSuppressions: boolean;
}

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string };

export interface EmailSender {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<SendResult>;
}

/** The SendGrid category of every admin mail (never one of the email issuer's, whose event webhook acts on its own). */
export const ADMIN_CATEGORY = 'hana-id-admin';

export function sendgridSender(apiKey: string | undefined, from: string, fetcher?: typeof fetch): EmailSender {
  return {
    configured: !!apiKey,
    async send(m) {
      if (!apiKey) return { ok: false, error: 'not configured' };
      const r = await sendgridSend(apiKey, from, { to: [m.to], subject: m.subject, text: m.text, html: m.html, category: ADMIN_CATEGORY, bypassSuppressions: m.bypassSuppressions }, fetcher);
      if (r.ok) return { ok: true, id: r.messageId };
      return { ok: false, error: r.status === undefined ? (r.reason === 'unavailable' ? 'network error or timeout' : r.reason) : `HTTP ${r.status}` };
    },
  };
}

/**
 * Where the Worker gets its sender. A property, so the tests can swap in the fake without a network; production code
 * never replaces it.
 */
export const outbound = {
  email(env: { EMAIL_API_KEY?: string | undefined; EMAIL_FROM: string }): EmailSender {
    return sendgridSender(env.EMAIL_API_KEY, env.EMAIL_FROM);
  },
};
