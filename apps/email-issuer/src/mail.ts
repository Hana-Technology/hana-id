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

function html(paragraphs: string[]): string {
  return `<!doctype html><html><body style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#111">${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`;
}

export function codeMail(input: { to: string; code: string; appName: string; authOrigin: string; purpose: Purpose }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const host = hostOf(input.authOrigin);
  const linking = input.purpose !== 'session';
  const what = linking ? `add this email to an existing wallet in ${appText}` : `sign in to ${appText}`;
  const warning = `Type this code only in the Hana window you opened (${host}). Hana never asks for it by phone, chat or on another site.`;
  const ignore = linking ? 'If you didn’t ask to add this email to a wallet, ignore this mail: nothing changes.' : 'If you didn’t try to sign in, ignore this mail.';
  const text = [`Your code to ${what} with Hana:`, '', input.code, '', 'It expires in 10 minutes.', '', warning, '', ignore, ''].join('\n');
  return {
    to: input.to,
    subject: app ? `Your sign-in code for ${app}` : 'Your sign-in code',
    text,
    html: html([
      `Your code to ${escapeHtml(what)} with Hana:`,
      `<strong style="font-size:24px;letter-spacing:4px">${escapeHtml(input.code)}</strong>`,
      'It expires in 10 minutes.',
      escapeHtml(warning),
      escapeHtml(ignore),
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
