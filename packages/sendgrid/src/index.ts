// SendGrid v3 Mail Send, shared by every Hana Worker that emails (D194, D401): the email issuer's user mail, the admin
// Worker's notices and the watchdog's alerts. Each Worker holds its own API key, restricted to Mail Send.
//
// One request is one message: `POST https://api.sendgrid.com/v3/mail/send`, accepted = `202` (SendGrid queued it; its
// `X-Message-Id` header names it in SendGrid's activity feed). Anything else is a failure: a network error, a timeout,
// a 4xx, a 5xx, any other 2xx. Callers count a send only when it is accepted. SendGrid has no idempotency key: a retry
// after a lost answer may deliver the message twice, never zero times (D401).
//
// Click, open and subscription tracking are off on every message: a rewritten link would point at SendGrid's
// redirector instead of Hana's own origin (codes carry no link; notices link only to the console origin).
//
// Results carry the HTTP status at most: never the key, the request or response body, or an address (SendGrid's error
// bodies can echo the recipient). The response body is drained, at most SENDGRID_MAX_RESPONSE_BYTES of it, and never
// read for content.

export const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';
export const SENDGRID_TIMEOUT_MS = 10_000;
export const SENDGRID_MAX_RESPONSE_BYTES = 4096;
/** SendGrid's limit on personalizations (recipients here) per request. */
export const SENDGRID_MAX_RECIPIENTS = 1000;

export interface SendGridMail {
  /** Each address gets its own copy (its own personalization): no recipient sees another's address. */
  to: readonly string[];
  /** One line (callers make it so). */
  subject: string;
  text: string;
  html?: string;
  /**
   * The SendGrid category, `hana-id-…`. The email issuer's event webhook acts only on its own categories (M3), so
   * another Worker's category never suppresses a login address.
   */
  category: string;
}

export type SendGridFailure = 'misconfigured' | 'unavailable' | 'rejected';

export type SendGridResult = { ok: true; messageId: string | null } | { ok: false; reason: SendGridFailure; status?: number };

/** `Display Name <address>` (or a bare address) → SendGrid's from object (manifest-validated, emailFromProblem). */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = /^(?:(.+) )?<([^<>\s]+)>$/u.exec(from);
  if (m) return m[1] ? { email: m[2]!, name: m[1] } : { email: m[2]! };
  return { email: from };
}

export function sendgridBody(from: string, m: SendGridMail): Record<string, unknown> {
  return {
    personalizations: m.to.map((email) => ({ to: [{ email }] })),
    from: parseFrom(from),
    subject: m.subject,
    content: [{ type: 'text/plain', value: m.text }, ...(m.html === undefined ? [] : [{ type: 'text/html', value: m.html }])],
    categories: [m.category],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    },
  };
}

/** Reads and drops at most `max` bytes of the body (cancelling the rest), so the connection is released. */
async function drain(res: Response, max: number): Promise<void> {
  const body = res.body;
  if (!body) return;
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (declared > max) {
    await body.cancel().catch(() => undefined);
    return;
  }
  try {
    const reader = body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    // A broken body changes nothing: the status decides.
  }
}

const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** Classifies a SendGrid answer by its status alone. */
export function classify(status: number): Extract<SendGridResult, { ok: false }> {
  if (status === 401 || status === 403) return { ok: false, reason: 'misconfigured', status };
  if (status === 429 || status >= 500) return { ok: false, reason: 'unavailable', status };
  return { ok: false, reason: 'rejected', status };
}

/** Sends one message. Without a key: `misconfigured`, and nothing is fetched. */
export async function sendgridSend(apiKey: string | undefined, from: string, m: SendGridMail, fetcher: typeof fetch = globalFetch): Promise<SendGridResult> {
  if (!apiKey) return { ok: false, reason: 'misconfigured' };
  if (m.to.length === 0 || m.to.length > SENDGRID_MAX_RECIPIENTS) return { ok: false, reason: 'rejected' };
  let res: Response;
  try {
    res = await fetcher(SENDGRID_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(sendgridBody(from, m)),
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  await drain(res, SENDGRID_MAX_RESPONSE_BYTES);
  if (res.status === 202) return { ok: true, messageId: res.headers.get('x-message-id') || null };
  return classify(res.status);
}

/** A SendGrid API key's shape (`SG.<id>.<secret>`), for the operator scripts' checks. Not a validity check. */
export const SENDGRID_KEY_RE = /^SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{32,64}$/u;
