// User mail texts (spec "Deliverability", "Phishing: codes, not magic links", "Notices"). A plain text part plus a
// designed HTML part (@hana-id/brand/email: tables, inline styles, the hosted logo as its one image) that says the same
// thing. Code mails carry no link at all: the auth host and the app's name are written as text clients don't link. The
// code is never in the subject or in the preview line (lock-screen previews, Q8). The app is "named by the app" (D118):
// its name is shown only when it passes the display-safety rule and the app-name rule (D686), else a neutral wording;
// the HTML part's heading never holds it (D687).
import { BRAND } from '@hana-id/brand';
import { type MailBlock, type MailInline, mailHtml, mailLogoUrl } from '@hana-id/brand/email';
import { appNameProblem } from '@hana-id/console-core';
import { isDisplaySafeLine } from './bytes.ts';
import { type Purpose, isHomePurpose } from './commitment.ts';
import { MAIL_LABELS } from './labels.ts';
import type { MailMessage } from './sender.ts';

const MAX_APP_NAME = 64;

/**
 * The app's name as mails show it, or null when it isn't safe to display: control, bidi or invisible characters, or a
 * name the app-name rule refuses (D686 as extended by D765: one that looks like a web address or holds "Hana",
 * "Journear" or "Passport Home"). The API refuses such names
 * when an app is named; a name stored before the rule lands here and the mail says "an app".
 */
export function displayAppName(name: string): string | null {
  const n = name.trim();
  return n.length > 0 && n.length <= MAX_APP_NAME && isDisplaySafeLine(n) && appNameProblem(n) === null ? n : null;
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
  return `${label} Not production: this email is from ${BRAND.product} ${env.ENV_NAME} (testnet), for testing.`;
}

/** How an env's mail looks: its env banner (`mailEnvNotice`) and its logo's URL (`mailLook`). */
export interface MailLook {
  envNotice?: string;
  logoUrl?: string;
}

/** The env's look: D419's banner on testnet, and the hosted logo on the env's files origin when it has one (D685). */
export function mailLook(env: { ENV_NAME: string; ENV_LABEL?: string | undefined; NEAR_NETWORK?: string | undefined; FILES_ORIGIN?: string | undefined }): MailLook {
  const envNotice = mailEnvNotice(env);
  const logoUrl = mailLogoUrl(env.FILES_ORIGIN);
  return { ...(envNotice ? { envNotice } : {}), ...(logoUrl ? { logoUrl } : {}) };
}

/**
 * The HTML part's small print (D765): who sent it, and the anti-phishing line every mail ends with. The text part has
 * no footer (unchanged since D670).
 */
const FOOTER = `Sent automatically by ${BRAND.product}. ${BRAND.company} never asks you to approve anything from an email.`;

const designed = (title: string, preheader: string, blocks: MailBlock[], look: MailLook | undefined): string =>
  mailHtml({ title, preheader, blocks, footer: FOOTER, ...(look?.envNotice ? { envNotice: look.envNotice } : {}), ...(look?.logoUrl ? { logoUrl: look.logoUrl } : {}) });

/** A sentence with the app's quoted name written as unlinked text (D687): even a name that looks like a host stays text. */
function withApp(sentence: string, appText: string | null): MailInline[] {
  if (!appText) return [sentence];
  const parts = sentence.split(appText);
  return parts.flatMap((part, i) => (i === 0 ? [part] : [{ unlinked: appText }, part])).filter((x) => x !== '');
}

/** The HTML part's heading per purpose: fixed words, never the app's name (D687). */
export const CODE_HEADINGS: Readonly<Record<Purpose, string>> = Object.freeze({
  session: 'Your sign-in code',
  link_new: 'Your code to add this email to your wallet',
  link_account: 'Your code to allow another sign-in method',
  link_change: 'Your code to remove a sign-in method',
  auto_link: 'Your code to link your Google sign-in',
  home: `Your sign-in code for ${BRAND.home}`,
  home_session: `Your code to open a wallet in ${BRAND.home}`,
});

/** A stand-in for the app in a subject that names none: `purposeText`'s subject is cut before it. */
const NO_APP = '\u0000';
const NO_APP_TAIL = / (?:for|in) \u0000$/u;

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
    // Passport Home's codes name Passport Home and the action, never an app: the issuer reads no app for them, and a
    // name the page sent would let anyone put words in a Journear mail.
    case 'home':
      return { subject: `Your sign-in code for ${BRAND.home}`, what: `sign in to ${BRAND.home}`, ignore: `If you didn’t try to sign in to ${BRAND.home}, ignore this mail.` };
    case 'home_session':
      return {
        subject: `Your code to open a wallet in ${BRAND.home}`,
        what: `open one of your wallets in ${BRAND.home}, where its private key can be shown to move it to another wallet app`,
        ignore: `If you didn’t ask ${BRAND.home} to open a wallet, ignore this mail: nothing changes. Never give this code to anyone: it opens your wallet.`,
      };
  }
}

export function codeMail(input: { to: string; code: string; appName: string; authOrigin: string; purpose: Purpose; appId?: string; look?: MailLook }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const host = hostOf(input.authOrigin);
  const t = purposeText(input.purpose, appText);
  const warning = `Type this code only in the ${BRAND.company} window you opened (${host}). ${BRAND.company} never asks for it by phone, chat or on another site.`;
  // Passport Home's own words already name the service.
  const by = isHomePurpose(input.purpose) ? '' : ` with ${BRAND.company}`;
  const intro = `Your code to ${t.what}${by}:`;
  const text = [intro, '', input.code, '', 'It expires in 10 minutes.', '', warning, '', t.ignore, ''].join('\n');
  // Subjects name the app only when it is display-safe; the code is never in a subject.
  const subject = app ? t.subject.replaceAll('“', '').replaceAll('”', '') : purposeText(input.purpose, NO_APP).subject.replace(NO_APP_TAIL, '');
  // The heading, the title and the preview line hold fixed words only (D687); the preview line never the code (D671).
  const heading = CODE_HEADINGS[input.purpose];
  const preheader = `${heading}. It expires in 10 minutes.`;
  // The HTML part: the text part's sentences, in the same order, the code boxed and the warning called out.
  const blocks: MailBlock[] = [
    { kind: 'heading', text: heading },
    { kind: 'p', text: withApp(intro, app ? appText : null) },
    { kind: 'code', code: input.code, caption: 'It expires in 10 minutes.' },
    { kind: 'callout', tone: 'info', text: [`Type this code only in the ${BRAND.company} window you opened (`, { host }, '). ', { strong: `${BRAND.company} never asks for it by phone, chat or on another site.` }] },
    { kind: 'p', text: t.ignore },
  ];
  return {
    to: input.to,
    subject,
    text,
    html: designed(heading, preheader, blocks, input.look),
    kind: 'code',
    ...(input.appId ? { appId: input.appId } : {}),
  };
}

/** The notice of a link that joins this email identity (spec "Notices"): the only link is to authOrigin. */
export function linkNoticeMail(input: { to: string; appName: string; authOrigin: string; pending: boolean; appId?: string; look?: MailLook }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const cancel = `${input.authOrigin.replace(/\/+$/u, '')}/link/cancel`;
  const what = input.pending
    ? `This email is being linked to a ${BRAND.company} wallet in ${appText} together with a Google sign-in. The link takes effect after a waiting period (24 hours on ${BRAND.company}'s live network), and can be cancelled until then.`
    : `This email now opens a ${BRAND.company} wallet in ${appText} together with a Google sign-in.`;
  const notYou = `Not you? ${cancel}`;
  const subject = app ? `A sign-in method was added in ${app}` : 'A sign-in method was added';
  return {
    to: input.to,
    subject,
    text: [what, '', notYou, ''].join('\n'),
    html: designed(
      'A sign-in method was added',
      `A sign-in method was added to a ${BRAND.company} wallet this email opens.`,
      [{ kind: 'heading', text: 'A sign-in method was added' }, { kind: 'p', text: withApp(what, app ? appText : null) }, { kind: 'p', text: [{ strong: 'Not you?' }] }, { kind: 'button', label: 'Open the cancel page', url: cancel }],
      input.look,
    ),
    kind: 'link_notice',
    ...(input.appId ? { appId: input.appId } : {}),
  };
}

/**
 * A staff unlock's one-time grant, mailed to the address (abuse review M3): only the mailbox's holder gets it. The token
 * travels in the link's fragment (never sent to a server by the browser), and the `authOrigin` page passes it to
 * `start` as `unlockToken` (batch 8).
 */
export function unlockMail(input: { to: string; token: string; authOrigin: string; look?: MailLook }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/unlock#${input.token}`;
  const what = `${BRAND.company} support unlocked sign-in with this email, as you asked. To sign in, open this link in the browser where you use the app. It works once, within 24 hours.`;
  const notYou = `Didn’t ask ${BRAND.company} support for this? Ignore this mail: nothing changes.`;
  const subject = `Your ${BRAND.company} sign-in is unlocked`;
  return {
    to: input.to,
    subject,
    text: [what, '', link, '', notYou, ''].join('\n'),
    html: designed(
      subject,
      `${BRAND.company} support unlocked sign-in with this email, as you asked.`,
      [{ kind: 'heading', text: subject }, { kind: 'p', text: what }, { kind: 'button', label: 'Open the sign-in link', url: link }, { kind: 'p', text: notYou, muted: true }],
      input.look,
    ),
    kind: 'unlock',
  };
}

/** A staff unsuppress's confirmation, mailed to the address (abuse review M3): mail resumes only once its holder confirms. */
export function confirmMail(input: { to: string; token: string; authOrigin: string; look?: MailLook }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/confirm#${input.token}`;
  const what = `${BRAND.company} stopped sending sign-in codes to this email after a bounce or a spam report. To receive them again, open this link. It works once, within 24 hours.`;
  const notYou = `Didn’t ask ${BRAND.company} support for this? Ignore this mail: nothing changes.`;
  const subject = `Confirm to receive ${BRAND.company} sign-in codes again`;
  return {
    to: input.to,
    subject,
    text: [what, '', link, '', notYou, ''].join('\n'),
    html: designed(
      subject,
      `${BRAND.company} stopped sending sign-in codes to this email after a bounce or a spam report.`,
      [{ kind: 'heading', text: subject }, { kind: 'p', text: what }, { kind: 'button', label: 'Receive codes again', url: link }, { kind: 'p', text: notYou, muted: true }],
      input.look,
    ),
    kind: 'confirm',
  };
}
