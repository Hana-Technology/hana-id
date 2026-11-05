// SendGrid v3 Mail Send (D194) through the shared adapter (@hana-id/sendgrid, D401): accepted = `202`, and a send
// counts only on that 202. The API key (SENDGRID_API_KEY) is restricted to Mail Send and used by this Worker alone
// (the admin Worker and the watchdog hold their own). Click, open and subscription tracking are off: code mails carry
// no link, and a rewritten link in a notice would point away from authOrigin. No response body is ever logged (an
// error body can echo the recipient); the shared adapter drains at most 4 KB of it. Login mail never bypasses
// SendGrid's suppression lists (no `bypassSuppressions`, D401 as amended): an address that bounced or complained stays
// unmailed, as D194's suppression handling intends.
import { sendgridSend } from '@hana-id/sendgrid';
import { globalFetch } from './http.ts';
import type { EmailSender, MailMessage, SendResult } from './sender.ts';

export { SENDGRID_URL, parseFrom } from '@hana-id/sendgrid';

/** The SendGrid category of each kind of mail: the event webhook acts only on these (webhook.ts ISSUER_CATEGORIES). */
export const issuerCategory = (kind: MailMessage['kind']): string => `hana-id-${kind}`;

export class SendGridSender implements EmailSender {
  readonly name = 'sendgrid';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly from: string,
    private readonly fetcher: typeof fetch = globalFetch,
  ) {}

  async send(m: MailMessage): Promise<SendResult> {
    const r = await sendgridSend(this.apiKey, this.from, { to: [m.to], subject: m.subject, text: m.text, html: m.html, category: issuerCategory(m.kind) }, this.fetcher);
    // Accepted: SendGrid queued it (its X-Message-Id identifies the message in its activity feed; not kept here).
    if (r.ok) return { ok: true };
    return r.status === undefined ? { ok: false, reason: r.reason } : { ok: false, reason: r.reason, providerStatus: r.status };
  }
}
