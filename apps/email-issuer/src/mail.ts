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
 * The banner a non-production env's HTML part opens with (D419, D670), when `ENV_LABEL` is one of the labels and the
 * network is testnet, else none. Since D853 its words are plain and the same in every test env (the label, "[SANDBOX]"
 * and so on, is no longer in the text: it only switches the banner on). The text part and the subject stay as D419 left
 * them (the sender's name already says "(testnet)").
 */
export function mailEnvNotice(env: { ENV_NAME: string; ENV_LABEL?: string | undefined; NEAR_NETWORK?: string | undefined }): string {
  const label = env.ENV_LABEL ?? '';
  if (env.NEAR_NETWORK !== 'testnet' || !(MAIL_LABELS as readonly string[]).includes(label)) return '';
  return `Test email: this comes from a test version of ${BRAND.product}. Don’t use it with real money.`;
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

/**
 * The notice of a link that joins this email identity (spec "Notices"). D862: it carries no link. The page it once
 * linked to (`{authOrigin}/link/cancel`) was never built (D259), so "Not you?" says where a cancel or a removal really
 * is today. A pending link (case B, not Google-hosted) is cancelled from this email's own sign-in (D864): while it
 * waits, an email sign-in to the app is refused and the sign-in window shows the waiting link with "Cancel this link"
 * (one more code to this address; `vault/login.ts` `LinkWaiting`). Once the waiting period is over that sign-in would
 * open the Google account's wallet, but it asks first and offers to remove this email (D865), so the mail sends the
 * reader there in both cases (the issuer doesn't know the link's date: "during the waiting period"). An active link is removed
 * by the wallet's first sign-in method, its root, from the sign-in window's link banners (D259, `Afterword`): at every
 * sign-in for 7 days (`RECENT_LINK_MS`), then as a quiet line until Done is pressed on it in that browser (D875, which
 * dropped the mail's old "Within 7 days"). So the mail says what to do when the window doesn't show it: Passport
 * Home's "Ways to sign in" says where to remove it (a private window). An active link may already have let another sign-in open the wallet
 * (and show its key), and removing it only stops it from now on: so "Not you?" also says to move what the wallet holds.
 * "Google password" only as a Gmail or Workspace address's own: otherwise the Google account may be someone else's.
 */
export function linkNoticeMail(input: { to: string; appName: string; pending: boolean; appId?: string; look?: MailLook }): MailMessage {
  const app = displayAppName(input.appName);
  const appText = app ? `“${app}”` : 'an app';
  const what = input.pending
    ? `This email is being linked with a Google account, so both will open the same ${BRAND.company} wallet in ${appText}. The link starts working after a waiting period (24 hours; shorter in a test version), and it can be cancelled until then.`
    : `This email and a Google account now both open the same ${BRAND.company} wallet in ${appText}.`;
  const notYou = input.pending
    ? `Change your email password, then sign in to ${appText} with this email. During the waiting period you can cancel the link there. After it, the ${BRAND.product} sign-in window lets you remove this email from that wallet. Don’t add money to that wallet.`
    : `Then someone else may have been able to open this wallet. Change your email password, and your Google password if this is a Gmail or Google Workspace address. Sign in to ${appText} the way you first signed in to this wallet. The ${BRAND.product} sign-in window usually shows the new sign-in with a button to remove it. If it doesn’t, “Ways to sign in” in ${BRAND.home} tells you how to remove it. Then move what’s in this wallet to a new one.`;
  const subject = app ? `A sign-in method was added in ${app}` : 'A sign-in method was added';
  return {
    to: input.to,
    subject,
    text: [what, '', `Not you? ${notYou}`, ''].join('\n'),
    html: designed(
      'A sign-in method was added',
      `A sign-in method was added to a ${BRAND.company} wallet this email opens.`,
      [{ kind: 'heading', text: 'A sign-in method was added' }, { kind: 'p', text: withApp(what, app ? appText : null) }, { kind: 'p', text: [{ strong: 'Not you?' }, ' ', ...withApp(notYou, app ? appText : null)] }],
      input.look,
    ),
    kind: 'link_notice',
    ...(input.appId ? { appId: input.appId } : {}),
  };
}

/**
 * What the support pages' buttons say (D866, packages/web src/auth/support-page.ts SUPPORT_TEXT): the mails name them,
 * so a test checks both sides agree.
 */
export const SUPPORT_BUTTONS = Object.freeze({ unlock: 'Unlock my email', confirm: 'Yes, this is my email' });

/** The support mails' last lines (D866): when the link stops working, and what to do if the reader never asked. */
const LINK_ONCE = 'The link works once, within 24 hours of this email.';
const NOT_YOU = 'Didn’t ask for this? Ignore this email. Nothing changes.';

/**
 * A staff unlock's one-time grant, mailed to the address (abuse review M3): only the mailbox's holder gets it. The token
 * travels in the link's fragment (never sent to a server by the browser). Its page, `{authOrigin}/email/unlock`, asks
 * for one press (D866): that makes the grant usable, and keeps the token in that browser, where the next email sign-in
 * passes it to `start` as `unlockToken`.
 */
export function unlockMail(input: { to: string; token: string; authOrigin: string; look?: MailLook }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/unlock#${input.token}`;
  const what = 'Sign-in with this email was paused after too many wrong codes. You asked for help, so here is a link to unlock it.';
  const how = `Open the link in the browser where you use the app, and press “${SUPPORT_BUTTONS.unlock}”. Then sign in with this email again.`;
  const subject = `Unlock your ${BRAND.company} sign-in`;
  return {
    to: input.to,
    subject,
    text: [what, '', how, '', link, '', LINK_ONCE, '', NOT_YOU, ''].join('\n'),
    html: designed(
      subject,
      'Sign-in with this email was paused after too many wrong codes. Here is a link to unlock it.',
      [
        { kind: 'heading', text: subject },
        { kind: 'p', text: what },
        { kind: 'p', text: how },
        { kind: 'button', label: 'Open the unlock page', url: link },
        { kind: 'p', text: LINK_ONCE },
        { kind: 'p', text: NOT_YOU, muted: true },
      ],
      input.look,
    ),
    kind: 'unlock',
  };
}

/**
 * A staff unsuppress's confirmation, mailed to the address (abuse review M3): mail resumes only once its holder presses
 * the button on `{authOrigin}/email/confirm` (D866).
 */
export function confirmMail(input: { to: string; token: string; authOrigin: string; look?: MailLook }): MailMessage {
  const link = `${input.authOrigin.replace(/\/+$/u, '')}/email/confirm#${input.token}`;
  const what = `${BRAND.company} stopped sending sign-in codes to this email. An earlier email to you couldn’t be delivered, or was marked as spam.`;
  const how = `To get codes again, open the link and press “${SUPPORT_BUTTONS.confirm}”.`;
  const subject = `Confirm your email to get ${BRAND.company} sign-in codes again`;
  return {
    to: input.to,
    subject,
    text: [what, '', how, '', link, '', LINK_ONCE, '', NOT_YOU, ''].join('\n'),
    html: designed(
      subject,
      `${BRAND.company} stopped sending sign-in codes to this email. Confirm it to get them again.`,
      [
        { kind: 'heading', text: subject },
        { kind: 'p', text: what },
        { kind: 'p', text: how },
        { kind: 'button', label: 'Open the confirm page', url: link },
        { kind: 'p', text: LINK_ONCE },
        { kind: 'p', text: NOT_YOU, muted: true },
      ],
      input.look,
    ),
    kind: 'confirm',
  };
}
