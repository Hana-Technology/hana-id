// The user-mail sender interface (spec "Deliverability", D194): one small interface, so another provider is one
// file. `to` is always the normalized address, byte for byte (packages/email README: never the raw input). A send
// counts only when the provider accepted it.

export interface MailMessage {
  /** The normalized address. */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** For the provider's own categorisation and the outbox stub; never the content. */
  kind: 'code' | 'link_notice' | 'unlock' | 'confirm' | 'alert';
  /** The app the mail is for (never the recipient): carried through the provider's events so bounces count per app (D446). */
  appId?: string;
}

export type SendResult = { ok: true } | { ok: false; reason: 'rejected' | 'unavailable' | 'misconfigured'; providerStatus?: number };

export interface EmailSender {
  readonly name: string;
  send(message: MailMessage): Promise<SendResult>;
}
