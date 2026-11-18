// `GET {authOrigin}/email/unlock#ug1.…` and `GET {authOrigin}/email/confirm#uc1.…` (D866): the pages behind the two
// mails a staff member can send to a user whose only sign-in is email (apps/email-issuer `admin/unlock`,
// `admin/unsuppress`; docs/operations.md "Staff calls").
//
// - unlock: too many wrong codes paused sign-in with the address. The press makes the staff unlock's one-time grant
//   usable (`POST /v1/email/unlock`), and keeps the token in this browser (email-storage.ts `hana.ug`), where the next
//   email sign-in sends it with `start`. It clears no lock and no counter (D198): it lets that one sign-in through.
// - confirm: mail to the address stopped after a bounce or a spam report. The press removes that exact address's
//   suppression (`POST /v1/email/confirm`), so sign-in codes are sent to it again.
//
// Each page shows one button and does nothing until it is pressed: a link scanner or an email preview that opens the
// link only loads the page, and the fragment (which browsers never send to a server) never leaves this page except in
// the press's POST body. A second press while the first is in flight does nothing. The answer is shown in plain words
// (D853): done, already used, expired, not valid, too many tries, or can't be reached (with "Try again"). After it the
// page offers nothing else: the user goes back to the app.
//
// SECURITY: the token is read from the fragment only, checked against its form before anything is shown, and removed
// from the address bar at once (kept in memory); nothing from the URL is ever put on the page. The one address shown comes from the issuer's answer (the address the mail went
// to, which only the token's holder could ask for), as a text node. The page loads nothing from another origin, fetches
// only the issuer (its CSP's connect-src, pages.ts), and sends no referrer.
import { ApiError, parseApiResponse } from '@hana-id/core';
import { BRAND } from '@hana-id/brand';
import { type Dom, addressText, dom, supportCode } from './dom.ts';
import { UNLOCK_TOKEN_RE, saveUnlockToken } from './email-storage.ts';
import { type PageWindow, isFramed } from './page-window.ts';
import { BTN, alert } from './ui.ts';

export type SupportKind = 'unlock' | 'confirm';

/** `uc1.` + 43 base64url characters (apps/email-issuer support-link.ts). */
export const CONFIRM_TOKEN_RE = /^uc1\.[A-Za-z0-9_-]{43}$/u;
const TOKEN_RE: Readonly<Record<SupportKind, RegExp>> = { unlock: UNLOCK_TOKEN_RE, confirm: CONFIRM_TOKEN_RE };

/** The issuer's answer to a press, as the page uses it. */
export type PressAnswer =
  | { kind: 'done'; email: string; untilMs: number | null }
  | { kind: 'used' | 'expired' | 'invalid' | 'limited' | 'unreachable' }
  | { kind: 'failed'; code: string };

export interface SupportApi {
  press(kind: SupportKind, token: string): Promise<PressAnswer>;
}

const isAddress = (v: unknown): v is string => typeof v === 'string' && v.length > 2 && v.length <= 320 && v.includes('@') && !/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/u.test(v);

/** The issuer's two press endpoints (POST JSON, no cookies, no referrer); null `issuerUrl`: an env without email. */
export function supportApi(issuerUrl: string | null | undefined, fetchFn: typeof fetch = (...args) => fetch(...args)): SupportApi {
  return {
    async press(kind, token) {
      if (!issuerUrl) return { kind: 'failed', code: 'email_unavailable' };
      let res: Response;
      try {
        res = await fetchFn(`${new URL(issuerUrl).origin}/v1/email/${kind === 'unlock' ? 'unlock' : 'confirm'}`, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      } catch {
        return { kind: 'unreachable' };
      }
      try {
        const body = await parseApiResponse(res);
        const done = kind === 'unlock' ? body.unlocked === true : body.confirmed === 'unsuppress';
        if (!done || !isAddress(body.email)) return { kind: 'failed', code: 'bad_response' };
        const until = kind === 'unlock' && Number.isSafeInteger(body.expiresAtMs) ? (body.expiresAtMs as number) : null;
        if (kind === 'unlock' && until === null) return { kind: 'failed', code: 'bad_response' };
        return { kind: 'done', email: body.email, untilMs: until };
      } catch (err) {
        if (!(err instanceof ApiError)) return { kind: 'unreachable' };
        if (err.code === 'link_used') return { kind: 'used' };
        if (err.code === 'link_expired') return { kind: 'expired' };
        if (err.code === 'link_invalid') return { kind: 'invalid' };
        if (err.status === 429) return { kind: 'limited' };
        if (err.status >= 500 || err.code === 'non_json_response') return { kind: 'unreachable' };
        return { kind: 'failed', code: err.code };
      }
    },
  };
}

const NEW_EMAIL = 'Ask the app’s support to send a new email.';
const ASK_NEW_EMAIL = 'ask the app’s support to send a new email.';

/** Every word the two pages show (D853: plain, one idea a sentence, the safe default and the action). Tests read them. */
export const SUPPORT_TEXT = {
  unlock: {
    title: 'Unlock sign-in with your email',
    lead: 'Sign-in with your email was paused after too many wrong codes. Press the button to unlock it.',
    button: 'Unlock my email',
    busy: 'Unlocking…',
    doneTitle: 'Your email is unlocked',
    done: 'Your email is unlocked. You can sign in again.',
    next: (until: string) => `Go back to the app and sign in with this email in this browser. Do it before ${until}: the unlock works for one sign-in.`,
    used: `This link was already used to sign in. If you still can’t sign in, ${ASK_NEW_EMAIL}`,
    notSaved: 'This browser didn’t let the page save the unlock, so it won’t work here. Open the link again in the browser where you use the app, with private browsing off.',
  },
  confirm: {
    title: 'Confirm your email',
    lead: `${BRAND.company} stopped sending sign-in codes to your email. An earlier email to you couldn’t be delivered, or was marked as spam.`,
    ask: 'If this email is yours, press the button. We’ll send sign-in codes to it again.',
    button: 'Yes, this is my email',
    busy: 'Confirming…',
    doneTitle: 'Email confirmed',
    done: 'Thanks: this email is confirmed. We’ll send sign-in codes to it again.',
    next: 'Go back to the app to sign in.',
    spam: 'If our emails land in your spam folder, mark them as “not spam”. Otherwise we may have to stop sending them again.',
    used: `This link was already used, so this email may already be confirmed. If sign-in codes still don’t arrive, ${ASK_NEW_EMAIL}`,
  },
  ignore: 'Didn’t ask for this? Close this page. Nothing changes.',
  emailLabel: 'Email:',
  close: 'You can close this page.',
  usedTitle: 'Link already used',
  expiredTitle: 'Link expired',
  expired: `This link has expired. ${NEW_EMAIL}`,
  invalidTitle: 'Link not valid',
  invalid: `This link isn’t valid. Open the whole link from the email, or ${ASK_NEW_EMAIL}`,
  limitedTitle: 'Too many tries',
  limited: 'Too many tries. Wait a few minutes, then try again.',
  unreachableTitle: 'Can’t reach us right now',
  unreachable: `${BRAND.company} can’t be reached right now. Try again in a moment.`,
  failedTitle: 'Something went wrong',
  failed: `Something went wrong. Try again later, or ${ASK_NEW_EMAIL}`,
  framed: `This ${BRAND.product} page can’t run inside another page.`,
  retry: 'Try again',
} as const;

export type SupportState = 'ready' | 'busy' | 'done' | 'used' | 'expired' | 'invalid' | 'limited' | 'unreachable' | 'failed';

export interface SupportPageDeps {
  win: Pick<PageWindow, 'document' | 'location' | 'top' | 'history'>;
  kind: SupportKind;
  api: SupportApi;
  /** window.localStorage, where an unlock is kept for the sign-in window; null when it can't be used. */
  storage: Storage | null;
  now?: () => number;
}

export interface SupportPage {
  readonly state: SupportState;
  /** Resolves once the current press has an answer (tests). */
  settled(): Promise<SupportState>;
}

const timeText = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
};

export function startSupportPage(deps: SupportPageDeps): SupportPage {
  const { win, kind, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const d: Dom = dom(win.document);
  const words = SUPPORT_TEXT[kind];
  let state: SupportState = 'ready';
  let waiters: ((s: SupportState) => void)[] = [];
  const settle = (s: SupportState) => {
    state = s;
    const w = waiters;
    waiters = [];
    for (const f of w) f(s);
  };
  const page: SupportPage = {
    get state() {
      return state;
    },
    settled: () => new Promise<SupportState>((resolve) => (state === 'busy' ? waiters.push(resolve) : resolve(state))),
  };

  /** Shows a view; after a press, its heading takes the focus, so a screen reader reads the answer from the top. */
  let pressedOnce = false;
  const view = (cls: string, ...children: (Node | null)[]) => {
    const section = d.h('section', { class: `panel support ${cls}`, attrs: { 'aria-live': 'polite' } }, ...children);
    d.show(section);
    if (pressedOnce) (section.querySelector('h1') as HTMLElement | null)?.focus?.();
    return section;
  };
  const h1 = (text: string) => d.h('h1', { attrs: { tabindex: '-1' } }, text);
  const emailLine = (email: string) => d.h('p', { class: 'support-email' }, `${SUPPORT_TEXT.emailLabel} `, addressText(d, email, 'strong'));

  /** An answer that ends here: its title, its sentence, and nothing to press. */
  const ended = (s: SupportState, title: string, text: string, tone: 'warning' | 'danger', code?: string) => {
    view(s, h1(title), alert(d, tone, { class: `support-${s}`, attrs: { role: 'alert' } }, text), code ? d.h('p', { class: 'code muted' }, supportCode(code)) : null, d.h('p', { class: 'muted' }, SUPPORT_TEXT.close));
    settle(s);
  };

  if (isFramed(win as PageWindow)) {
    ended('invalid', SUPPORT_TEXT.failedTitle, SUPPORT_TEXT.framed, 'danger', 'config_mismatch');
    return page;
  }
  const raw = win.location.hash.startsWith('#') ? win.location.hash.slice(1) : '';
  const token = TOKEN_RE[kind].test(raw) ? raw : null;
  // The token leaves the address bar at once (a shared screen, a screenshot, a bookmark); the page keeps it in memory
  // for its button and "Try again" (D866 review). A reload then finds no token: "not valid", open the email's link again.
  if (raw) {
    try {
      win.history.replaceState(null, '', win.location.pathname);
    } catch {
      // Nothing to do: the fragment stays, as before.
    }
  }
  if (!token) {
    ended('invalid', SUPPORT_TEXT.invalidTitle, SUPPORT_TEXT.invalid, 'danger');
    return page;
  }

  let pressing = false;
  async function press(button: HTMLButtonElement): Promise<void> {
    // One press at a time: a double click, or Enter then a click, sends one request.
    if (pressing) return;
    pressing = true;
    pressedOnce = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = words.busy;
    state = 'busy';
    const answer = await api.press(kind, token as string);
    pressing = false;
    show(answer);
  }

  function show(a: PressAnswer): void {
    switch (a.kind) {
      case 'done':
        if (kind === 'unlock') {
          if (!saveUnlockToken(deps.storage, token as string, a.email, a.untilMs ?? 0, now())) return ended('failed', SUPPORT_TEXT.failedTitle, SUPPORT_TEXT.unlock.notSaved, 'warning', 'storage_blocked');
          view('done', h1(SUPPORT_TEXT.unlock.doneTitle), alert(d, 'success', { class: 'support-done', attrs: { role: 'status' } }, SUPPORT_TEXT.unlock.done), emailLine(a.email), d.h('p', {}, SUPPORT_TEXT.unlock.next(timeText(a.untilMs ?? now()))), d.h('p', { class: 'muted' }, SUPPORT_TEXT.close));
        } else {
          view('done', h1(SUPPORT_TEXT.confirm.doneTitle), alert(d, 'success', { class: 'support-done', attrs: { role: 'status' } }, SUPPORT_TEXT.confirm.done), emailLine(a.email), d.h('p', {}, SUPPORT_TEXT.confirm.next), d.h('p', {}, SUPPORT_TEXT.confirm.spam), d.h('p', { class: 'muted' }, SUPPORT_TEXT.close));
        }
        return settle('done');
      case 'used':
        return ended('used', SUPPORT_TEXT.usedTitle, words.used, 'warning');
      case 'expired':
        return ended('expired', SUPPORT_TEXT.expiredTitle, SUPPORT_TEXT.expired, 'warning');
      case 'invalid':
        return ended('invalid', SUPPORT_TEXT.invalidTitle, SUPPORT_TEXT.invalid, 'danger');
      case 'failed':
        return ended('failed', SUPPORT_TEXT.failedTitle, SUPPORT_TEXT.failed, 'danger', a.code);
      case 'limited':
      case 'unreachable':
        // Nothing was done: the same one button, to try again (still only on a press).
        return ready(a.kind);
    }
  }

  /** The page before the press (or after a press that couldn't be made: `problem` says why, and the button retries). */
  function ready(problem: 'limited' | 'unreachable' | null): void {
    const button = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'support-press' } }, problem ? SUPPORT_TEXT.retry : words.button);
    button.addEventListener('click', () => void press(button));
    const note = problem
      ? alert(d, 'warning', { class: `support-${problem}`, attrs: { role: 'alert' } }, problem === 'limited' ? SUPPORT_TEXT.limited : SUPPORT_TEXT.unreachable)
      : null;
    view(
      problem ?? 'ready',
      h1(words.title),
      d.h('p', {}, words.lead),
      kind === 'confirm' ? d.h('p', {}, SUPPORT_TEXT.confirm.ask) : null,
      note,
      d.h('div', { class: 'actions' }, button),
      d.h('p', { class: 'muted' }, SUPPORT_TEXT.ignore),
    );
    settle(problem ?? 'ready');
  }

  ready(null);
  return page;
}
