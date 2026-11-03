// `GET {authOrigin}/login/email` (docs/email-login-spec.md "Vault, popup and SDK changes"; build plan batch 8a): the
// login popup's email step. /login navigates here (same window, so the same sessionStorage) after the user picked
// email; the fragment names the login (`#<relayId>`). Steps: the address → `start` (the issuer computes the session's
// purpose-bound nonce from the commitment it is sent, D195) → the 6-digit code → `verify` → the email ID token, which
// this page encrypts under the login's relay key and writes to the relay slot, exactly as /login/callback does with
// Google's answer. From there the vault continues as for Google (it verifies the token against the on-chain email
// keys, fixes `{scope}#email#{sub}#{key_index}`, opens the session and derives the key).
//
// - "Resend code" (after the issuer's `resendAfterMs`) and "Use a different email" (a new `start`, same commitment).
// - Every limit is the same generic "try again later" (the issuer's answers are enumeration-safe; so is this page).
//   Errors are told apart as: the service can't be reached (a network error or a 5xx: the notice offers "Try again",
//   which repeats the same request), a limit (429: no retry button, the user waits), a wrong or expired code (their
//   own messages), email unavailable for the app (the step ends), and any other refusal ("Something went wrong", with
//   its code).
// - The device ticket `verify` returns is kept on authOrigin for this address (email-storage.ts) and sent with the
//   next `start`, so its owner's code mail gets past the shared limits (D198).
// - Case B (`googleWallet`: a Google identity that reported this address has the wallet, the email identity has none):
//   no token; the page offers "Continue with Google", a plain Google login (batch 8a links nothing, so no `linkJwt`).
//   In batch 8a this screen is never reached: the issuer learns hints only from google-match (batch 8b), so nothing
//   writes `email_hints` yet, and an address with a Google wallet gets a separate email wallet (D249). Kept for 8b.
// - A step the user can't finish here (email unavailable for the app, no issuer in this env, case B without Google)
//   tells the vault at once (`email_unavailable`), so the partner's login() ends instead of waiting out its 5 minutes;
//   and the page itself stops at the vault's deadline (EMAIL_STEP_LIMIT_MS from the context's creation).
// - "Cancel" ends the login: the relay gets `{error}` (`email_cancelled`, or `email_code_invalid` /
//   `email_challenge_expired` / `email_rate_limited` when that was the last thing the user saw), which the vault turns
//   into `login_cancelled`, `code_invalid`, `challenge_expired` or `rate_limited` (D245).
// - After `start` answered, it tells the vault (`hana:auth-progress`, `loginProgress: email_code`); before going to
//   Google (case B) it says `google`.
// - The partner's `emailHint` prefills the field; it is dropped from the stored context on load (kept in memory only).
//
// - pk_test_ apps (the login entry carries /login's timings): this step's stages ride in the relay slot with the token
//   (timings.ts `emailLoad` … `emailVerify`), each a sum of durations on this page's clock. Nothing else is measured.
//
// It calls only the issuer and the API's relay (its CSP's connect-src, pages.ts).
//
// SECURITY: the address and the code are sent to the issuer only; neither is stored (the device ticket's key is a hash
// of the address), logged or put in a message. The token is held only until it is encrypted; the relay key is taken
// (single use) only then, and zeroed after.
import { ApiError, type RelayPayload, encryptRelayPayload } from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import type { AuthApi } from './api.ts';
import { type Dom, dom, errorView } from './dom.ts';
import type { EmailApi, SessionCommitment } from './email-api.ts';
import { EMAIL_STEP_LIMIT_MS, type EmailContext, deviceTicketFor, dropEmailContext, readEmailContext, saveDeviceTicket, storeEmailContext } from './email-storage.ts';
import { googleAuthUrl } from './google.ts';
import { takeLogin } from './login-storage.ts';
import { type PageWindow, childFrame, isFramed } from './page-window.ts';

export interface EmailPageDeps {
  win: PageWindow;
  env: HanaEnv;
  issuer: EmailApi;
  api: AuthApi;
  /** Where device tickets live (window.localStorage); null when it can't be used. */
  tickets: Storage | null;
  now?: () => number;
  /** Monotonic ms on this page's clock (0 = its navigation start), for a pk_test_ app's timings; default performance.now. */
  perfNow?: () => number;
  /** Timers (tests drive the resend delay). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

export type EmailStage = 'address' | 'sending' | 'code' | 'verifying' | 'google_wallet' | 'relaying' | 'done' | 'error';

/** What the user saw last that the vault should hear if they cancel now (D245), or why the step can't go on. */
type Reason = 'email_cancelled' | 'email_code_invalid' | 'email_challenge_expired' | 'email_rate_limited' | 'email_unavailable';

export interface EmailPage {
  readonly stage: EmailStage;
  /** The protocol-ish code of the last problem shown (tests), or null. */
  readonly notice: string | null;
  /** Resolves each time the page settles on a stage that waits for the user, or ends. */
  settled(): Promise<EmailStage>;
}

/** The longest the resend button waits, whatever the issuer said (its own minimum is 30 s). */
export const RESEND_WAIT_MAX_MS = 60_000;
export const CODE_RE = /^\d{6}$/u;
/** The relayId in the fragment. */
const FRAGMENT_RE = /^#([A-Za-z0-9_-]{43})$/u;

/** The issuer's answers that mean "this app can't use email right now": nothing the user can fix here. */
const UNAVAILABLE = new Set(['email_not_enabled', 'no_email_client', 'app_suspended', 'invalid_key', 'scope_mismatch', 'origin_not_allowed', 'bad_request']);

/** This step's pk_test_ stages (timings.ts), in the order the user meets them. */
export const EMAIL_STEP_STAGES = ['emailLoad', 'emailEntry', 'emailStart', 'emailCode', 'emailVerify'] as const;
type EmailStepStage = (typeof EMAIL_STEP_STAGES)[number];

const TEXT = {
  rateLimited: 'Too many attempts. Try again later.',
  unreachable: 'Hana’s email service can’t be reached right now. Try again in a moment.',
  /** `start` failed without an answer: it may still have sent a mail. */
  unreachableStart: 'Hana’s email service can’t be reached right now. A code may already be on its way: if you try again, use the newest code.',
  failed: (code: string) => `Something went wrong (${code}). Try again, or close this window and start again from the app.`,
  invalidEmail: 'Enter a valid email address.',
  domain: 'Addresses on this domain can’t be used to sign in.',
  expired: 'This code expired or can’t be used any more. Send a new code.',
  resendLimit: 'No more codes can be sent for this attempt. Use a different email, or try again later.',
  resendWait: 'Wait a few seconds before asking for another code.',
} as const;

export function startEmailPage(deps: EmailPageDeps): EmailPage {
  const { win, env, issuer, api } = deps;
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const d: Dom = dom(win.document);
  let stage: EmailStage = 'address';
  let notice: string | null = null;
  let reason: Reason = 'email_cancelled';
  let waiters: ((s: EmailStage) => void)[] = [];
  const settle = (s: EmailStage) => {
    stage = s;
    const w = waiters;
    waiters = [];
    for (const f of w) f(s);
  };
  const page: EmailPage = {
    get stage() {
      return stage;
    },
    get notice() {
      return notice;
    },
    settled: () => new Promise<EmailStage>((resolve) => waiters.push(resolve)),
  };

  const fatal = (title: string, message: string, code: string) => {
    notice = code;
    d.show(errorView(d, title, message, code));
    settle('error');
  };

  if (isFramed(win)) {
    fatal('Sign-in stopped', 'The Hana sign-in window can’t run inside another page.', 'config_mismatch');
    return page;
  }
  const m = FRAGMENT_RE.exec(win.location.hash);
  const relayId = m?.[1] ?? null;
  const read = relayId ? readEmailContext(win.sessionStorage, relayId, now()) : null;
  if (!relayId || !read) {
    fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
    return page;
  }
  const ctx: EmailContext = read.context;
  const rid: string = relayId;
  const createdAt = read.createdAt;
  /** The vault ends its pending login 5 min after hana_login; this page stops by then too (EMAIL_STEP_LIMIT_MS). */
  const deadlineAt = createdAt + EMAIL_STEP_LIMIT_MS;
  const commitment: SessionCommitment = {
    scopeId: ctx.scopeId,
    sessionPublicKey: ctx.sessionPublicKey,
    expiresAtMs: ctx.expiresAtMs,
    keyIndex: ctx.keyIndex,
    maxUses: ctx.maxUses,
    salt: ctx.salt,
  };
  let address = ctx.emailHint ?? '';
  let resendTimer: unknown = null;
  let deadlineTimer: unknown = null;
  // pk_test_ timings: the stage the page is in since `phaseAt` (it starts loading at this page's time 0).
  const spent: Record<EmailStepStage, number> = { emailLoad: 0, emailEntry: 0, emailStart: 0, emailCode: 0, emailVerify: 0 };
  let phase: EmailStepStage | null = 'emailLoad';
  let phaseAt = 0;
  const enter = (next: EmailStepStage | null) => {
    const t = perfNow();
    if (phase) spent[phase] += Math.max(0, t - phaseAt);
    phase = next;
    phaseAt = t;
  };

  const remember = (patch: Partial<EmailContext>) => {
    Object.assign(ctx, patch);
    try {
      storeEmailContext(win.sessionStorage, rid, ctx, now(), createdAt);
    } catch {
      // The step goes on in memory; only a reload would lose it.
    }
  };
  // The partner's hint stays in memory only from here on (a reload shows an empty field).
  if (ctx.emailHint !== null) remember({ emailHint: null });

  /**
   * Ends the step where the user can't go on: the vault hears `reason` now (if the relay key is still here), the page
   * shows why and stays open. Best effort: a failed write only means the vault times out as before.
   */
  async function abandon(why: Reason | null, title: string, text: string, code: string): Promise<void> {
    clearT(resendTimer);
    clearT(deadlineTimer);
    const taken = why ? takeLogin(win.sessionStorage, rid, now()) : null;
    dropEmailContext(win.sessionStorage, rid);
    fatal(title, text, code);
    if (!taken) return;
    try {
      await api.writeRelay(rid, await encryptRelayPayload(taken.relayKey, rid, { error: why as string }));
    } catch {
      // The vault ends at its own deadline.
    } finally {
      taken.relayKey.fill(0);
    }
  }

  const pastDeadline = (): boolean => {
    if (now() < deadlineAt) return false;
    void abandon(null, 'Sign-in stopped', 'This sign-in took too long. Close this window and start again from the app.', 'login_timeout');
    return true;
  };

  if (!env.emailIssuerUrl) {
    void abandon('email_unavailable', 'Sign-in stopped', 'Email sign-in is not set up here.', 'config_mismatch');
    return page;
  }
  if (pastDeadline()) return page;
  deadlineTimer = setT(() => {
    if (stage !== 'done' && stage !== 'error' && stage !== 'relaying') pastDeadline();
  }, Math.max(0, deadlineAt - now()));

  const header = () =>
    d.h('p', {}, 'Signing in to ', d.h('strong', {}, ctx.appName), ' at ', d.h('span', { class: 'origin' }, ctx.parentOrigin));
  /** A notice; `retry` (a transient failure) adds "Try again", which repeats the request that failed. */
  const message = (text: string | null, id: string, retry?: () => void) => {
    if (!text) return null;
    const note = d.h('p', { class: 'note', attrs: { role: 'alert', id } }, text);
    if (!retry) return note;
    const again = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-retry' } }, 'Try again');
    again.addEventListener('click', () => {
      again.setAttribute('disabled', '');
      retry();
    });
    note.append(' ', again);
    return note;
  };
  const cancelButton = () => {
    const b = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
    b.addEventListener('click', () => void cancel());
    return b;
  };

  /** Tells the vault where the user is (a progress signal only; the vault checks the sender). */
  const tellVault = (progress: 'email_code' | 'google' = 'email_code') => {
    const opener = win.opener;
    if (!opener) return;
    try {
      const target = ctx.opener === 'partner' && ctx.vaultFrame ? childFrame(opener, ctx.vaultFrame) : opener;
      (target as Window | null)?.postMessage({ v: 1, t: 'hana:auth-progress', stage: progress }, env.vaultOrigin);
    } catch {
      // The opener went away: the login still finishes through the relay.
    }
  };

  // ---- screens ----

  function showAddress(problem: string | null = null, retry?: () => void): void {
    clearT(resendTimer);
    enter('emailEntry');
    const input = d.h('input', {
      attrs: { type: 'email', id: 'email-address', name: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: '', maxlength: '254' },
    });
    input.value = address;
    const send = d.h('button', { class: 'primary', attrs: { type: 'submit', id: 'email-send' } }, 'Send code');
    const form = d.h('form', { attrs: { novalidate: '' } }, d.h('label', { attrs: { for: 'email-address' } }, 'Email address', input), message(problem, 'email-notice', retry), d.h('div', { class: 'actions' }, cancelButton(), send));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      address = input.value.trim();
      void sendCode();
    });
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Sign in with email'), header(), form));
    try {
      input.focus();
    } catch {
      // Not focusable in this document: nothing to do.
    }
    settle('address');
  }

  /**
   * `retry` (a transient failure): "Try again" repeats `verify` with what the code field holds when it is clicked, or
   * the `resend`, enabled only once the resend wait is over (as the Resend button). `code`: the code the user typed,
   * kept in the field after a failure that wasn't about the code.
   */
  function showCode(resendAfterMs: number, problem: string | null = null, retry?: 'verify' | 'resend', code?: string): void {
    enter('emailCode');
    const input = d.h('input', {
      attrs: { type: 'text', id: 'email-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: '' },
    });
    if (code) input.value = code;
    const go = d.h('button', { class: 'primary', attrs: { type: 'submit', id: 'email-verify' } }, 'Continue');
    const resend = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-resend', disabled: '' } }, 'Resend code');
    const other = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-other' } }, 'Use a different email');
    resend.addEventListener('click', () => void resendCode());
    other.addEventListener('click', () => {
      remember({ challengeId: null });
      reason = 'email_cancelled';
      showAddress();
    });
    const submitCode = () => {
      const typed = input.value.replace(/\s+/gu, '');
      if (!CODE_RE.test(typed)) {
        showCode(resendAfterMs, 'Enter the 6-digit code from the mail.');
        return;
      }
      void verifyCode(typed, resendAfterMs);
    };
    const form = d.h(
      'form',
      { attrs: { novalidate: '' } },
      d.h('p', {}, 'We sent a 6-digit code to ', d.h('strong', {}, address), '. Type it here, in this Hana window only.'),
      d.h('label', { attrs: { for: 'email-code' } }, 'Code', input),
      message(problem, 'email-notice', retry === 'verify' ? submitCode : retry === 'resend' ? () => void resendCode() : undefined),
      d.h('div', { class: 'actions' }, cancelButton(), go),
      d.h('p', { class: 'muted links' }, resend, ' · ', other),
    );
    const retryResend = retry === 'resend' ? form.querySelector('#email-retry') : null;
    retryResend?.setAttribute('disabled', '');
    clearT(resendTimer);
    resendTimer = setT(
      () => {
        resend.removeAttribute('disabled');
        retryResend?.removeAttribute('disabled');
      },
      Math.min(RESEND_WAIT_MAX_MS, Math.max(0, resendAfterMs - now())),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitCode();
    });
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Check your email'), header(), form));
    try {
      input.focus();
    } catch {
      // Not focusable in this document: nothing to do.
    }
    settle('code');
  }

  function busy(title: string, text: string, s: EmailStage): void {
    enter(s === 'sending' ? 'emailStart' : s === 'verifying' ? 'emailVerify' : null);
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, title), header(), d.h('p', { class: 'muted' }, text)));
    stage = s;
  }

  // ---- steps ----

  /**
   * An issuer error as what this page shows: a notice for the screen the user is on (`transient`: the service couldn't
   * answer, so the notice offers "Try again"), or a fatal end. A limit is never transient: retrying it can't help.
   */
  function issuerProblem(err: unknown): { notice: string; text: string; transient: boolean } | 'unavailable' {
    if (!(err instanceof ApiError)) return { notice: 'api_unavailable', text: TEXT.unreachable, transient: true };
    if (err.status === 429) {
      const limit = err.code === 'resend_limit';
      return { notice: limit ? 'resend_limit' : 'rate_limited', text: limit ? TEXT.resendLimit : TEXT.rateLimited, transient: false };
    }
    if (UNAVAILABLE.has(err.code)) return 'unavailable';
    if (err.status >= 500) return { notice: 'api_unavailable', text: TEXT.unreachable, transient: true };
    return { notice: err.code, text: TEXT.failed(err.code), transient: false };
  }

  const unavailable = () =>
    void abandon('email_unavailable', 'Email sign-in unavailable', 'Email sign-in isn’t available for this app right now. Close this window and try another way to sign in.', 'login_method_unavailable');

  async function sendCode(): Promise<void> {
    if (pastDeadline()) return;
    if (address.length < 3 || address.length > 254 || !address.includes('@') || /\s/u.test(address)) {
      notice = 'invalid_email';
      showAddress(TEXT.invalidEmail);
      return;
    }
    busy('Sign in with email', 'Sending a code…', 'sending');
    try {
      const c = await issuer.start(ctx.pk, address, commitment, deviceTicketFor(deps.tickets, address, now()));
      remember({ challengeId: c.challengeId });
      notice = null;
      reason = 'email_cancelled';
      tellVault();
      showCode(c.resendAfterMs);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_email') {
        notice = 'invalid_email';
        showAddress(TEXT.invalidEmail);
        return;
      }
      if (err instanceof ApiError && err.code === 'email_domain_not_allowed') {
        notice = 'email_domain_not_allowed';
        showAddress(TEXT.domain);
        return;
      }
      const p = issuerProblem(err);
      if (p === 'unavailable') return unavailable();
      notice = p.notice;
      if (p.notice === 'rate_limited') reason = 'email_rate_limited';
      showAddress(p.notice === 'api_unavailable' ? TEXT.unreachableStart : p.text, p.transient ? () => void sendCode() : undefined);
    }
  }

  async function resendCode(): Promise<void> {
    const challengeId = ctx.challengeId;
    if (!challengeId) return showAddress();
    if (pastDeadline()) return;
    busy('Check your email', 'Sending a new code…', 'sending');
    try {
      const c = await issuer.resend(challengeId);
      remember({ challengeId: c.challengeId });
      notice = null;
      reason = 'email_cancelled';
      showCode(c.resendAfterMs, 'A new code is on its way. The old one no longer works.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'challenge_expired') {
        notice = 'challenge_expired';
        reason = 'email_challenge_expired';
        remember({ challengeId: null });
        showAddress(TEXT.expired);
        return;
      }
      if (err instanceof ApiError && err.status === 429 && err.code === 'rate_limited' && typeof err.details.resendAfterMs === 'number') {
        notice = 'resend_wait';
        showCode(err.details.resendAfterMs, TEXT.resendWait);
        return;
      }
      const p = issuerProblem(err);
      if (p === 'unavailable') return unavailable();
      notice = p.notice;
      if (p.notice === 'rate_limited') reason = 'email_rate_limited';
      showCode(now() + RESEND_WAIT_MAX_MS, p.text, p.transient ? 'resend' : undefined);
    }
  }

  async function verifyCode(code: string, resendAfterMs: number): Promise<void> {
    const challengeId = ctx.challengeId;
    if (!challengeId) return showAddress();
    if (pastDeadline()) return;
    busy('Check your email', 'Checking the code…', 'verifying');
    let verified;
    try {
      verified = await issuer.verify(challengeId, code);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'code_invalid') {
        const left = typeof err.details.attemptsLeft === 'number' ? err.details.attemptsLeft : null;
        notice = 'code_invalid';
        reason = 'email_code_invalid';
        if (left === 0) {
          remember({ challengeId: null });
          showAddress('That code is wrong, and this attempt has no tries left. Send a new code.');
          return;
        }
        showCode(resendAfterMs, left === null ? 'That code is wrong. Check the mail and try again.' : `That code is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
        return;
      }
      if (err instanceof ApiError && err.code === 'challenge_expired') {
        notice = 'challenge_expired';
        reason = 'email_challenge_expired';
        remember({ challengeId: null });
        showAddress(TEXT.expired);
        return;
      }
      const p = issuerProblem(err);
      if (p === 'unavailable') return unavailable();
      notice = p.notice;
      if (p.notice === 'rate_limited') reason = 'email_rate_limited';
      showCode(resendAfterMs, p.text, p.transient ? 'verify' : undefined, code);
      return;
    }
    if (verified.deviceTicket) saveDeviceTicket(deps.tickets, address, verified.deviceTicket, now());
    remember({ challengeId: null });
    notice = null;
    reason = 'email_cancelled';
    if (verified.kind === 'google_wallet') return showGoogleWallet();
    await relay({ idToken: verified.idToken });
  }

  /** Case B: the address belongs to a wallet created with Google here; continue with Google (no link in batch 8a). */
  function showGoogleWallet(): void {
    enter(null);
    const clientId = ctx.clientId;
    if (!clientId) {
      void abandon('email_unavailable', 'Sign in with Google', 'This email already opens a wallet you created with Google, and this app doesn’t offer Google sign-in here.', 'login_method_unavailable');
      return;
    }
    const go = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'email-google' } }, 'Continue with Google');
    go.addEventListener('click', () => {
      go.setAttribute('disabled', '');
      // The relay key entry stays for /login/callback; this page's context is done.
      clearT(deadlineTimer);
      dropEmailContext(win.sessionStorage, rid);
      tellVault('google');
      win.location.assign(googleAuthUrl({ clientId, authOrigin: env.authOrigin, nonce: ctx.nonce, state: rid, forceReauth: false }));
    });
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, 'Sign in with Google'),
        header(),
        d.h('p', {}, 'This email belongs to a wallet you created by signing in with Google. Continue with Google to open it.'),
        d.h('div', { class: 'actions' }, cancelButton(), go),
      ),
    );
    notice = 'google_wallet';
    settle('google_wallet');
  }

  /** Encrypts `payload` under the login's relay key (taken now, single use) and writes it to the slot. */
  async function relay(payload: RelayPayload): Promise<void> {
    clearT(resendTimer);
    clearT(deadlineTimer);
    busy('Signing in', 'Finishing sign-in…', 'relaying');
    const taken = takeLogin(win.sessionStorage, rid, now());
    dropEmailContext(win.sessionStorage, rid);
    if (!taken) {
      fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
      return;
    }
    const { relayKey } = taken;
    let body: RelayPayload | null = taken.timings && 'idToken' in payload ? { ...payload, timings: { ...taken.timings, ...spent } } : payload;
    try {
      const value = await encryptRelayPayload(relayKey, rid, body);
      body = null;
      await api.writeRelay(rid, value);
    } catch (err) {
      const used = err instanceof ApiError && err.code === 'relay_used';
      fatal(
        'Sign-in could not finish',
        used ? 'This sign-in was already completed. Close this window.' : 'Hana could not be reached to finish the sign-in. Close this window and try again from the app.',
        err instanceof ApiError ? err.code : 'api_unavailable',
      );
      return;
    } finally {
      body = null;
      relayKey.fill(0);
    }
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'idToken' in payload ? 'Signed in' : 'Sign-in cancelled'), d.h('p', { class: 'muted' }, 'You can close this window.')));
    settle('done');
    win.close();
  }

  /** Cancel: the vault hears why (D245), and the window closes. */
  async function cancel(): Promise<void> {
    await relay({ error: reason });
  }

  showAddress();
  return page;
}
