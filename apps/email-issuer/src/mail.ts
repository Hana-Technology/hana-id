// User mail texts (spec "Deliverability", "Phishing: codes, not magic links", "Notices"). Plain text plus simple HTML,
// no images; code mails carry no link at all; the code is never in the subject (lock-screen previews, Q8). The app is
// "named by the app" (D118): its name is shown only when it passes the display-safety rule, else a neutral wording.
import { isDisplaySafeLine } from './bytes.ts';
import type { Purpose } from './commitment.ts';
import type { MailMessage } from './sender.ts';

const MAX_APP_NAME = 64;

/** The app's name as mails show it, or null when it isn't safe to display (control, bidi or invisible characters). */
export function displayAppName(name: string): string | null {
  const n = name.trim();
  return n.length > 0 && n.length <= MAX_APP_NAME && isDisplaySafeLine(n) ? n : null;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

// Hana's ink and indigo and its typeface's name (packages/brand, D426): a mail loads no font, so a reader without
// Montserrat sees Arial. Inline styles only (mail clients drop stylesheets); nothing remote.
function html(paragraphs: string[]): string {
  return `<!doctype html><html><body style="font-family:Montserrat,Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#16073a">${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`;
}

/**
 * What a code does, per purpose (tokens review M1, D199): each purpose has its own subject and wording, so a code for
 * one thing can't be passed off as a code for another. `X` is the app as mails name it.
 */
export function purposeText(purpose: Purpose, appText: string): { subject: string; what: string; ignore: string } {
  switch (purpose) {
    case 'session':
      return { subject: `Your sign-in code for ${appText}`, what: `sign in to ${appText}`, ignore: 'If you didn’t try to sign in, ignore this mail.' };
    case 'link_new':
      return {
        subject: `Your code to add this email to your wallet in ${appText}`,
        what: `add this email as a sign-in method of your wallet in ${appText}`,
        ignore: 'If you didn’t ask to add this email to a wallet, ignore this mail: nothing changes.',
      };
    case 'link_account':
      return {
        subject: `Your code to allow another sign-in method in ${appText}`,
        what: `allow another sign-in method to open the wallet this email opens in ${appText}`,
        ignore: 'If you didn’t ask to add a sign-in method to your wallet, ignore this mail: nothing changes, and someone may be trying to reach your wallet.',
      };
    case 'link_change':
      return {
        subject: `Your code to remove a sign-in method in ${appText}`,
        what: `remove or cancel a sign-in method of the wallet this email opens in ${appText}`,
        ignore: 'If you didn’t ask to remove a sign-in method, ignore this mail: nothing changes.',
      };
    case 'auto_link':
      return {
        subject: `Your code to link your Google sign-in in ${appText}`,
        what: `link your Google sign-in to the wallet this email opens in ${appText}`,
        ignore: 'If you didn’t just sign in with Google, ignore this mail: nothing changes.',
      };
  }
}

export function codeMail(input: { to: string; code: string; appName: string; authOrigin: string; purpose: Purpose }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const host = hostOf(input.authOrigin);
  const t = purposeText(input.purpose, appText);
  const warning = `Type this code only in the Hana window you opened (${host}). Hana never asks for it by phone, chat or on another site.`;
  const text = [`Your code to ${t.what} with Hana:`, '', input.code, '', 'It expires in 10 minutes.', '', warning, '', t.ignore, ''].join('\n');
  // Subjects name the app only when it is display-safe; the code is never in a subject.
  const subject = app ? t.subject.replaceAll('“', '').replaceAll('”', '') : purposeText(input.purpose, 'Hana').subject.replace(/ (?:for|in) Hana$/u, '');
  return {
    to: input.to,
    subject,
    text,
    html: html([
      `Your code to ${escapeHtml(t.what)} with Hana:`,
      `<strong style="font-size:24px;letter-spacing:4px;color:#3308a8">${escapeHtml(input.code)}</strong>`,
      'It expires in 10 minutes.',
      escapeHtml(warning),
      escapeHtml(t.ignore),
    ]),
    kind: 'code',
  };
}

/** The notice of a link that joins this email identity (spec "Notices"): the only link is to authOrigin. */
export function linkNoticeMail(input: { to: string; appName: string; authOrigin: string; pending: boolean }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const cancel = `${input.authOrigin.replace(/\/+$/u, '')}/link/cancel`;
  const what = input.pending
    ? `This email is being linked to a Hana wallet in ${appText} together with a Google sign-in. The link takes effect after a waiting period (24 hours on Hana's live network), and can be cancelled until then.`
    : `This email now opens a Hana wallet in ${appText} together with a Google sign-in.`;
  const notYou = `Not you? ${cancel}`;
  return {
    to: input.to,
    subject: app ? `A sign-in method was added in ${app}` : 'A sign-in method was added',
    text: [what, '', notYou, ''].join('\n'),
    html: html([escapeHtml(what), `Not you? <a href="${escapeHtml(cancel)}">${escapeHtml(cancel)}</a>`]),
    kind: 'link_notice',
  };
}

/**
 * A staff unlock's one-time grant, mailed to the address (abuse review M3): only the mailbox's holder gets it. The token
 * travels in the link's fragment (never sent to a server by the browser), and the `authOrigin` page passes it to
 * `start` as `unlockToken` (batch 8).
 */
export function unlockMail(input: { to: string; token: string; authOrigin: string }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/unlock#${input.token}`;
  const what = 'Hana support unlocked sign-in with this email, as you asked. To sign in, open this link in the browser where you use the app. It works once, within 24 hours.';
  const notYou = 'Didn’t ask Hana support for this? Ignore this mail: nothing changes.';
  return {
    to: input.to,
    subject: 'Your Hana sign-in is unlocked',
    text: [what, '', link, '', notYou, ''].join('\n'),
    html: html([escapeHtml(what), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`, escapeHtml(notYou)]),
    kind: 'unlock',
  };
}

/** A staff unsuppress's confirmation, mailed to the address (abuse review M3): mail resumes only once its holder confirms. */
export function confirmMail(input: { to: string; token: string; authOrigin: string }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/confirm#${input.token}`;
  const what = 'Hana stopped sending sign-in codes to this email after a bounce or a spam report. To receive them again, open this link. It works once, within 24 hours.';
  const notYou = 'Didn’t ask Hana support for this? Ignore this mail: nothing changes.';
  return {
    to: input.to,
    subject: 'Confirm to receive Hana sign-in codes again',
    text: [what, '', link, '', notYou, ''].join('\n'),
    html: html([escapeHtml(what), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`, escapeHtml(notYou)]),
    kind: 'confirm',
  };
}
