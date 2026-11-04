// EmailSender (docs/batch-c-spec.md "Email", D87): one message in, accepted with the provider's id or an error. Code
// above it never knows the provider; switching to another (Postmark, …) is a new adapter. The Resend adapter is the
// only one in production; the tests use a fake (test/fake-email.ts) through `outbound.email` below.
//
// "Accepted" means the provider answered 2xx with a message id: anything else (a network error, a timeout, a 4xx, a
// 5xx, a 2xx without an id) is a failure, so a blocking notice is not acked on it. Each message carries an
// idempotency key derived from what it is (the notice and the recipient), so a retry after a lost answer is not sent
// twice by the provider within its window (Resend: 24 h). Errors carry the HTTP status only, never the key, the body
// or the provider's text (which can echo the recipient).

export interface EmailMessage {
  /** Exactly one recipient per message: no contact ever sees another's address. */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per (message purpose, recipient): the provider drops a repeat within its window. */
  idempotencyKey: string;
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export interface EmailSender {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<SendResult>;
}

export const RESEND_URL = 'https://api.resend.com/emails';
export const SEND_TIMEOUT_MS = 10_000;

export function resendSender(apiKey: string | undefined, from: string): EmailSender {
  return {
    configured: !!apiKey,
    async send(m) {
      if (!apiKey) return { ok: false, error: 'not configured' };
      let res: Response;
      try {
        res = await fetch(RESEND_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'idempotency-key': m.idempotencyKey },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: 'network error or timeout' };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return typeof body?.id === 'string' && body.id.length > 0 ? { ok: true, id: body.id } : { ok: false, error: 'no message id in the answer' };
    },
  };
}

/**
 * Where the Worker gets its sender. A property, so the tests can swap in the fake without a network; production code
 * never replaces it.
 */
export const outbound = {
  email(env: { EMAIL_API_KEY?: string | undefined; EMAIL_FROM: string }): EmailSender {
    return resendSender(env.EMAIL_API_KEY, env.EMAIL_FROM);
  },
};
