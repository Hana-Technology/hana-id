// User mail texts (spec "Deliverability", "Phishing: codes, not magic links", "Notices"). A plain text part plus a
// designed HTML part (@hana-id/brand/email: tables, inline styles, no image, nothing remote) that says the same thing.
// Code mails carry no link at all: the auth host is shown as text. The code is never in the subject or in the preview
// line (lock-screen previews, Q8). The app is "named by the app" (D118): its name is shown only when it passes the
// display-safety rule, else a neutral wording.
import { type MailBlock, mailHtml } from '@hana-id/brand/email';
import { isDisplaySafeLine } from './bytes.ts';
import { type Purpose, isHomePurpose } from './commitment.ts';
import { MAIL_LABELS } from './labels.ts';
import type { MailMessage } from './sender.ts';

const MAX_APP_NAME = 64;

/** The app's name as mails show it, or null when it isn't safe to display (control, bidi or invisible characters). */
export function displayAppName(name: string): string | null {
  const n = name.trim();
  return n.length > 0 && n.length <= MAX_APP_NAME && isDisplaySafeLine(n) ? n : null;
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * The banner a non-production env's HTML part opens with (D419's label, D670): `ENV_LABEL` when it is one of the
 * labels and the network is testnet, else none. The text part and the subject stay as D419 left them (the sender's
 * name already says "(testnet)").
 */
export function mailEnvNotice(env: { ENV_NAME: string; ENV_LABEL?: string | undefined; NEAR_NETWORK?: string | undefined }): string {
  const label = env.ENV_LABEL ?? '';
  if (env.NEAR_NETWORK !== 'testnet' || !(MAIL_LABELS as readonly string[]).includes(label)) return '';
  return `${label} Not production: this email is from Hana ID ${env.ENV_NAME} (testnet), for testing.`;
}

const FOOTER = 'Sent automatically by Hana ID.';

const designed = (title: string, preheader: string, blocks: MailBlock[], envNotice: string | undefined): string =>
  mailHtml({ title, preheader, blocks, footer: FOOTER, ...(envNotice ? { envNotice } : {}) });

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
    // Hana Home's codes name Hana Home and the action, never an app: the issuer reads no app for them, and a name the
    // page sent would let anyone put words in a Hana mail.
    case 'home':
      return { subject: 'Your sign-in code for Hana Home', what: 'sign in to Hana Home', ignore: 'If you didn’t try to sign in to Hana Home, ignore this mail.' };
    case 'home_session':
      return {
        subject: 'Your code to open a wallet in Hana Home',
        what: 'open one of your wallets in Hana Home, where its private key can be shown to move it to another wallet app',
        ignore: 'If you didn’t ask Hana Home to open a wallet, ignore this mail: nothing changes. Never give this code to anyone: it opens your wallet.',
      };
  }
}

export function codeMail(input: { to: string; code: string; appName: string; authOrigin: string; purpose: Purpose; appId?: string; envNotice?: string }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const host = hostOf(input.authOrigin);
  const t = purposeText(input.purpose, appText);
  const warning = `Type this code only in the Hana window you opened (${host}). Hana never asks for it by phone, chat or on another site.`;
  // Hana Home's own words already name Hana.
  const by = isHomePurpose(input.purpose) ? '' : ' with Hana';
  const intro = `Your code to ${t.what}${by}:`;
  const text = [intro, '', input.code, '', 'It expires in 10 minutes.', '', warning, '', t.ignore, ''].join('\n');
  // Subjects name the app only when it is display-safe; the code is never in a subject.
  const subject = app ? t.subject.replaceAll('“', '').replaceAll('”', '') : purposeText(input.purpose, 'Hana').subject.replace(/ (?:for|in) Hana$/u, '');
  // The preview line says what the code is for and that it expires, never the code (D671).
  const preheader = `${intro.slice(0, -1)}. It expires in 10 minutes.`;
  // The HTML part: the text part's sentences, in the same order, the code boxed and the warning called out.
  const blocks: MailBlock[] = [
    { kind: 'heading', text: subject },
    { kind: 'p', text: intro },
    { kind: 'code', code: input.code, caption: 'It expires in 10 minutes.' },
    { kind: 'callout', tone: 'info', text: ['Type this code only in the Hana window you opened (', { host }, '). ', { strong: 'Hana never asks for it by phone, chat or on another site.' }] },
    { kind: 'p', text: t.ignore },
  ];
  return {
    to: input.to,
    subject,
    text,
    html: designed(subject, preheader, blocks, input.envNotice),
    kind: 'code',
    ...(input.appId ? { appId: input.appId } : {}),
  };
}

/** The notice of a link that joins this email identity (spec "Notices"): the only link is to authOrigin. */
export function linkNoticeMail(input: { to: string; appName: string; authOrigin: string; pending: boolean; appId?: string; envNotice?: string }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const cancel = `${input.authOrigin.replace(/\/+$/u, '')}/link/cancel`;
  const what = input.pending
    ? `This email is being linked to a Hana wallet in ${appText} together with a Google sign-in. The link takes effect after a waiting period (24 hours on Hana's live network), and can be cancelled until then.`
    : `This email now opens a Hana wallet in ${appText} together with a Google sign-in.`;
  const notYou = `Not you? ${cancel}`;
  const subject = app ? `A sign-in method was added in ${app}` : 'A sign-in method was added';
  return {
    to: input.to,
    subject,
    text: [what, '', notYou, ''].join('\n'),
    html: designed(subject, what, [{ kind: 'heading', text: subject }, { kind: 'p', text: what }, { kind: 'p', text: [{ strong: 'Not you?' }] }, { kind: 'button', label: 'Open the cancel page', url: cancel }], input.envNotice),
    kind: 'link_notice',
    ...(input.appId ? { appId: input.appId } : {}),
  };
}

/**
 * A staff unlock's one-time grant, mailed to the address (abuse review M3): only the mailbox's holder gets it. The token
 * travels in the link's fragment (never sent to a server by the browser), and the `authOrigin` page passes it to
 * `start` as `unlockToken` (batch 8).
 */
export function unlockMail(input: { to: string; token: string; authOrigin: string; envNotice?: string }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/unlock#${input.token}`;
  const what = 'Hana support unlocked sign-in with this email, as you asked. To sign in, open this link in the browser where you use the app. It works once, within 24 hours.';
  const notYou = 'Didn’t ask Hana support for this? Ignore this mail: nothing changes.';
  const subject = 'Your Hana sign-in is unlocked';
  return {
    to: input.to,
    subject,
    text: [what, '', link, '', notYou, ''].join('\n'),
    html: designed(
      subject,
      'Hana support unlocked sign-in with this email, as you asked.',
      [{ kind: 'heading', text: subject }, { kind: 'p', text: what }, { kind: 'button', label: 'Open the sign-in link', url: link }, { kind: 'p', text: notYou, muted: true }],
      input.envNotice,
    ),
    kind: 'unlock',
  };
}

/** A staff unsuppress's confirmation, mailed to the address (abuse review M3): mail resumes only once its holder confirms. */
export function confirmMail(input: { to: string; token: string; authOrigin: string; envNotice?: string }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/confirm#${input.token}`;
  const what = 'Hana stopped sending sign-in codes to this email after a bounce or a spam report. To receive them again, open this link. It works once, within 24 hours.';
  const notYou = 'Didn’t ask Hana support for this? Ignore this mail: nothing changes.';
  const subject = 'Confirm to receive Hana sign-in codes again';
  return {
    to: input.to,
    subject,
    text: [what, '', link, '', notYou, ''].join('\n'),
    html: designed(
      subject,
      'Hana stopped sending sign-in codes to this email after a bounce or a spam report.',
      [{ kind: 'heading', text: subject }, { kind: 'p', text: what }, { kind: 'button', label: 'Receive codes again', url: link }, { kind: 'p', text: notYou, muted: true }],
      input.envNotice,
    ),
    kind: 'confirm',
  };
}
