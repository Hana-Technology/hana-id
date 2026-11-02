// SendGrid v3 Mail Send (D194): `POST https://api.sendgrid.com/v3/mail/send`, accepted = `202` with an `X-Message-Id`
// header and an empty body. A send counts only on that 202. The API key (SENDGRID_API_KEY) is restricted to Mail Send
// and used by this Worker alone. Click, open and subscription tracking are off: code mails carry no link, and a
// rewritten link in a notice would point away from authOrigin. No response body is ever logged (an error body can
// echo the recipient); the body is read at most 4 KB and only to drain it.
import { responseText } from './http.ts';
import type { EmailSender, MailMessage, SendResult } from './sender.ts';

export const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';
export const SENDGRID_TIMEOUT_MS = 10_000;
export const SENDGRID_MAX_RESPONSE_BYTES = 4096;

/** `Display Name <address>` (or a bare address) → SendGrid's from object (manifest-validated, emailFromProblem). */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = /^(?:(.+) )?<([^<>\s]+)>$/u.exec(from);
  if (m) return m[1] ? { email: m[2]!, name: m[1] } : { email: m[2]! };
  return { email: from };
}

export function sendgridBody(from: string, m: MailMessage): Record<string, unknown> {
  return {
    personalizations: [{ to: [{ email: m.to }] }],
    from: parseFrom(from),
    subject: m.subject,
    content: [
      { type: 'text/plain', value: m.text },
      { type: 'text/html', value: m.html },
    ],
    categories: [`hana-id-${m.kind}`],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    },
  };
}

export class SendGridSender implements EmailSender {
  readonly name = 'sendgrid';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly from: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(m: MailMessage): Promise<SendResult> {
    if (!this.apiKey) return { ok: false, reason: 'misconfigured' };
    let res: Response;
    try {
      res = await this.fetcher(SENDGRID_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(sendgridBody(this.from, m)),
        signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    // Drained, size-capped, never logged or returned.
    await responseText(res, SENDGRID_MAX_RESPONSE_BYTES);
    // Accepted: SendGrid queued it (its X-Message-Id identifies the message in its activity feed; not kept here).
    if (res.status === 202) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'misconfigured', providerStatus: res.status };
    if (res.status === 429 || res.status >= 500) return { ok: false, reason: 'unavailable', providerStatus: res.status };
    return { ok: false, reason: 'rejected', providerStatus: res.status };
  }
}
