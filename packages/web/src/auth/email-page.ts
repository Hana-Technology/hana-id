// `GET {authOrigin}/login/email` (docs/email-login-spec.md "Vault, popup and SDK changes"; build plan batches 8a and
// 8b): the login popup's email step, and the follow-up mode of a login of an app with email.
//
// The email step. /login navigates here (same window, so the same sessionStorage) after the user picked email; the
// fragment names the login (`#<relayId>`). Steps: the address → `start` (the issuer computes the session's
// purpose-bound nonce from the commitment it is sent, D195) → the 6-digit code → `verify` → the email ID token, which
// this page encrypts under the login's relay key and writes to the relay slot, exactly as /login/callback does with
// Google's answer. From there the vault continues as for Google (it verifies the token against the on-chain email
// keys, resolves the path through `get_identity`, opens the session and derives the key).
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
//   no token. With the issuer's `linkTicket` the page offers "Link and continue" (continue with Google: the login opens
//   the Google wallet, and this email joins it, at once when Google hosts the mailbox, else after 24 h) or "Sign in
//   with Google" (the Google wallet, no link). "Link and continue" stores the ticket and the address's `sub` with the
//   relay key entry, and the callback relays them with Google's token: the vault signs a case-B link only then (D139).
// - A step the user can't finish here (email unavailable for the app, no issuer in this env, case B without Google)
//   tells the vault at once (`email_unavailable`), so the partner's login() ends instead of waiting out its 5 minutes;
//   and the page itself stops at the vault's deadline (EMAIL_STEP_LIMIT_MS from the context's creation).
// - "Cancel" ends the login: the relay gets `{error}` (`email_cancelled`, or `email_code_invalid` /
//   `email_challenge_expired` / `email_rate_limited` when that was the last thing the user saw), which the vault turns
//   into `login_cancelled`, `code_invalid`, `challenge_expired` or `rate_limited` (D245).
// - After `start` answered, it tells the vault (`hana:auth-progress`, `loginProgress: email_code`); before going to
//   Google (case B) it says `google`, and it navigates (or closes itself after `relayed`) once the vault acked, or after
//   SIGNAL_ACK_WAIT_MS (D400, auth/vault-signal.ts).
// - The partner's `emailHint` prefills the field; it is dropped from the stored context on load (kept in memory only).
// - Back after a cancel on Google's screen (D341): when the user cancels token_first's Google step (its first request,
//   or D273's interactive retry), /login/callback relays nothing and parks the login's keys under its slot
//   (`cancelled`); this page takes them on load (in memory only) and shows the screen that Google step came from:
//   Hana's method chooser ("Google sign-in was cancelled.", Continue with Google or with email, as the app offers) or
//   case B's choices. Google again is a fresh attempt under a new OAuth `state` whose entry names the slot (or, after
//   D273's retry, that retry again: slot 1 already holds the account's access token); email is the email step here.
//   Closing the window on that screen (`pagehide`) relays `google_cancelled`, encrypted in advance and sent with
//   `keepalive`, which the vault ends as `login_cancelled`. Case B's attempts under token_first always take a fresh
//   `state` too, so a cancelled attempt's `state` never finds an entry again.
// - `hana.linkAccount({method: 'email'})`: the same step over the vault's `link_new` commitment.
// - The export window's re-authentication (export mode): the same step for the export window's own session; no case B
//   link, no follow-up.
//
// Follow-up mode (batch 8b): in a login whose auth-params carried a `followKey`, after its token is relayed (here, or
// by /login/callback, which then navigates here with the login entry's `next`), the page reads the vault's notices in
// the follow-up slots (core relay.ts `FollowNotice`) and answers them:
// - `link_code` (case A, not Google-hosted): "Link and continue" sends the code google-match prepared (`resend`) to
//   a…@domain, and the code's `auto_link` token goes back to the vault; "Sign in with email" is an email login to the
//   wallet that address opens;
// - `use_email` (case A that can't link): only "Sign in with email";
// - `prove`: a link method's proof (Google: the vault's nonce and account; email: a code over its commitment);
// - `done`: "Signed in", or the link banners first (a pending method with Cancel, one just added); a banner's action
//   is a proof, then the vault's answer;
// - `stop`: why the login ended (a pending link: when it activates).
//
// - pk_test_ apps (the login entry carries /login's timings): this step's stages ride in the relay slot with the token
//   (timings.ts `emailLoad` … `emailVerify`), each a sum of durations on this page's clock. Nothing else is measured.
//
// It calls only the issuer and the API's relay (its CSP's connect-src, pages.ts).
//
// SECURITY: the address and the code are sent to the issuer only; this page stores neither (the device ticket's key is
// a hash of the address), logs them or puts them in a message. The issuer keeps the verified address in its user
// directory, for Hana staff only (D269). Tokens are held only until encrypted. The relay key (and the follow-up
// key) are taken (single use) only to relay, held in memory for the follow-up mode, and zeroed at its end.
import {
  ApiError,
  type FollowNotice,
  type FollowProve,
  type LinkBanner,
  type RelayCiphertext,
  type RelayPayload,
  base64UrlEncode,
  decryptRelayValue,
  encryptRelayPayload,
  followSlot,
  isFollowNotice,
} from '@hana-id/core';
import type { HanaEnv } from '../hana-env.ts';
import { appLogo } from './logo.ts';
import type { AuthApi } from './api.ts';
import { type Dom, dom, errorView, originText } from './dom.ts';
import type { EmailApi, LinkPurpose, SessionCommitment, Verified } from './email-api.ts';
import { EMAIL_STEP_LIMIT_MS, type EmailContext, deviceTicketFor, dropEmailContext, readEmailContext, saveDeviceTicket, storeEmailContext } from './email-storage.ts';
import { GOOGLE_CANCELLED_RELAY_ERROR, GOOGLE_EMAIL_FLOW, type GoogleEmailFlow, googleAccessUrl, googleAuthUrl, googleTokenFirstUrl, loginGoogleRequest } from './google.ts';
import { type TakenLogin, peekLogin, storeLoginEntry, takeLogin, zeroTaken } from './login-storage.ts';
import { type PageWindow, childFrame, isFramed } from './page-window.ts';
import { closeOrShare } from './share-handoff.ts';
import { vaultSignals } from './vault-signal.ts';

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
  /** How a Google request asks for the email scope (auth/google.ts GOOGLE_EMAIL_FLOW; tests set the other mode). */
  googleEmailFlow?: GoogleEmailFlow;
}

export type EmailStage =
  | 'address'
  | 'sending'
  | 'code'
  | 'verifying'
  | 'google_wallet'
  | 'relaying'
  | 'done'
  | 'error'
  /** D341: the method chooser again, after the user cancelled Google's screen. */
  | 'choosing'
  /** Follow-up mode: waiting for the vault's next notice. */
  | 'following'
  /** Follow-up mode: a screen that waits for the user (google-match's choice, banners, a stop). */
  | 'link_choice'
  | 'banners'
  | 'stopped';

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
/** The follow-up mode reads the vault's notices for at most this long after the login's context was made. */
export const FOLLOW_LIMIT_MS = 10 * 60_000;
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

/** What the vault's `stop` codes mean to the user. */
const STOP_TEXT: Record<string, string> = {
  link_pending: 'This sign-in method was added to a wallet recently. It can open the wallet once its waiting period ends.',
  link_refused: 'These sign-in methods can’t be linked. Sign in with the method that opened your wallet.',
  login_cancelled: 'The sign-in was cancelled.',
  login_timeout: 'This sign-in took too long. Start again from the app.',
  api_unavailable: 'Hana couldn’t finish the sign-in. Close this window and try again from the app.',
  token_invalid: 'The sign-in couldn’t be checked. Start again from the app.',
  derive_failed: 'The sign-in couldn’t finish. Start again from the app.',
};

/** D341: the line the screen after a cancel on Google's sign-in screen shows. */
export const GOOGLE_CANCELLED_TEXT = 'Google sign-in was cancelled.';

const providerName = (p: string): string => (p === 'google' ? 'Google' : 'email');
const dateText = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
};

/** Where a verified code's token goes: the login's first slot, or an answer in the follow-up channel. */
type Sink = { kind: 'first' } | { kind: 'answer'; slot: number; as: 'link' | 'session' | 'proof' };

/** The `start` of the current step: a login's session, or a link purpose over the vault's commitment. */
type StartAs = { kind: 'session' } | { kind: 'link'; purpose: LinkPurpose; commitment: Record<string, unknown> } | { kind: 'prepared'; challengeId: string; to: string };

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
  /** Where the next verified token goes, and which `start` the address screen makes. */
  let sink: Sink = { kind: 'first' };
  let startAs: StartAs = ctx.proof ? { kind: 'link', purpose: ctx.proof.purpose, commitment: ctx.proof.commitment } : { kind: 'session' };
  /** Follow-up mode's keys, in memory only (taken from the login entry). */
  let follow: { relayKey: Uint8Array; followKey: Uint8Array } | null = null;
  /**
   * D341: the login's keys after a cancel on Google's screen, taken from the entry the callback parked (in memory
   * only), until the user picks a way on; `closeValue` is `{error: google_cancelled}` for the slot, encrypted in
   * advance so `pagehide` can send it at once; `leaving` once this page navigates on by itself.
   */
  let held: TakenLogin | null = null;
  let closeValue: RelayCiphertext | null = null;
  let leaving = false;
  /** The login's keys for a write or the next entry: the held ones (D341), else the stored entry (single use). */
  const takeKeys = (): TakenLogin | null => {
    const h = held;
    held = null;
    return h ?? takeLogin(win.sessionStorage, rid, now());
  };
  const dropHeld = () => {
    if (held) zeroTaken(held);
    held = null;
  };
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
    if (sink.kind === 'answer' && why) {
      fatal(title, text, code);
      await answer(sink.slot, { error: why });
      return;
    }
    if (!why) dropHeld();
    const taken = why ? takeKeys() : null;
    dropEmailContext(win.sessionStorage, rid);
    fatal(title, text, code);
    if (!taken) return;
    try {
      await api.writeRelay(rid, await encryptRelayPayload(taken.relayKey, rid, { error: why as string }));
    } catch {
      // The vault ends at its own deadline.
    } finally {
      zeroTaken(taken);
    }
  }

  const pastDeadline = (): boolean => {
    if (now() < (follow ? createdAt + FOLLOW_LIMIT_MS : deadlineAt)) return false;
    void abandon(null, 'Sign-in stopped', 'This sign-in took too long. Close this window and start again from the app.', 'login_timeout');
    return true;
  };

  const header = () =>
    d.h('p', { class: 'asker' }, appLogo(d, env, ctx.logoUrl), 'Signing in to ', d.h('strong', {}, ctx.appName), ' at ', originText(d, ctx.parentOrigin));
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

  /**
   * Tells the vault where the user is (a progress signal only; the vault checks the sender): the code was sent, the
   * window navigates to Google, or it closes itself after relaying (D347: the vault's close watch tells these from a
   * user's close). The export window's step has no vault to tell.
   */
  const signals = vaultSignals(
    win,
    () => {
      const opener = win.opener;
      if (!opener || ctx.exportMode) return [];
      return [ctx.opener === 'partner' && ctx.vaultFrame ? childFrame(opener, ctx.vaultFrame) : opener];
    },
    env.vaultOrigin,
    { timers: { setTimeout: setT, clearTimeout: clearT } },
  );
  const tellVault = (): void => signals.post('email_code');
  /**
   * D400: `google` or `relayed`, then the navigation or the close once the vault acked (or after SIGNAL_ACK_WAIT_MS):
   * Chromium drops a signal's source when the page navigates in the same task.
   */
  const tellVaultThen = (progress: 'google' | 'relayed', go: () => void): void => void signals.postThenLeave(progress, go);

  // ---- screens ----

  function addressTitle(): string {
    if (startAs.kind === 'link' && startAs.purpose === 'link_new') return 'Add an email sign-in';
    if (startAs.kind === 'link') return 'Confirm it’s you';
    return 'Sign in with email';
  }

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
    const explain =
      startAs.kind === 'link' && startAs.purpose === 'link_account'
        ? d.h('p', {}, 'Enter the email that opens this wallet, to allow the new sign-in method.')
        : startAs.kind === 'link' && startAs.purpose === 'link_new'
          ? d.h('p', {}, 'Enter the email you want to add. It can open this wallet after a waiting period.')
          : null;
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, addressTitle()), header(), explain, form));
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
      // A prepared case-A code can't go to another address: "a different email" is an email login.
      if (startAs.kind === 'prepared') {
        startAs = { kind: 'session' };
        if (sink.kind === 'answer') sink = { ...sink, as: 'session' };
        address = '';
      }
      showAddress();
    });
    const to = startAs.kind === 'prepared' ? startAs.to : address;
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
      d.h('p', {}, 'We sent a 6-digit code to ', d.h('strong', {}, to), '. Type it here, in this Hana window only.'),
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
    busy(addressTitle(), 'Sending a code…', 'sending');
    try {
      const ticket = deviceTicketFor(deps.tickets, address, now());
      const c = startAs.kind === 'link' ? await issuer.startLink(ctx.pk, address, startAs.purpose, startAs.commitment, ticket) : await issuer.start(ctx.pk, address, commitment, ticket);
      remember({ challengeId: c.challengeId });
      notice = null;
      reason = 'email_cancelled';
      if (sink.kind === 'first') tellVault();
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
        if (startAs.kind === 'prepared') startAs = { kind: 'session' };
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
    let verified: Verified;
    try {
      verified = await issuer.verify(challengeId, code);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'code_invalid') {
        const left = typeof err.details.attemptsLeft === 'number' ? err.details.attemptsLeft : null;
        notice = 'code_invalid';
        reason = 'email_code_invalid';
        if (left === 0) {
          remember({ challengeId: null });
          if (startAs.kind === 'prepared') startAs = { kind: 'session' };
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
        if (startAs.kind === 'prepared') startAs = { kind: 'session' };
        showAddress(TEXT.expired);
        return;
      }
      if (err instanceof ApiError && (err.code === 'link_refused' || err.code === 'links_unavailable')) {
        // Case A's code was right but the chain moved on (D133): only the email login remains.
        notice = err.code;
        remember({ challengeId: null });
        startAs = { kind: 'session' };
        if (sink.kind === 'answer') sink = { ...sink, as: 'session' };
        address = '';
        showAddress('These sign-in methods can’t be linked now. Sign in with your email instead.');
        return;
      }
      const p = issuerProblem(err);
      if (p === 'unavailable') return unavailable();
      notice = p.notice;
      if (p.notice === 'rate_limited') reason = 'email_rate_limited';
      showCode(resendAfterMs, p.text, p.transient ? 'verify' : undefined, code);
      return;
    }
    // A prepared code's address is Google's (masked here): no device ticket is kept for it.
    if (verified.deviceTicket && startAs.kind !== 'prepared') saveDeviceTicket(deps.tickets, address, verified.deviceTicket, now());
    remember({ challengeId: null });
    notice = null;
    reason = 'email_cancelled';
    if (verified.kind === 'google_wallet') {
      if (sink.kind === 'answer' || ctx.exportMode || startAs.kind !== 'session') {
        // Only a login's first step continues to Google; elsewhere this address opens no wallet of its own.
        return void abandon('email_unavailable', 'Sign in with Google', 'This email belongs to a wallet you created with Google. Sign in with Google instead.', 'login_method_unavailable');
      }
      return showGoogleWallet(verified.link ?? null);
    }
    // D438: a session token's sealed address rides beside it to the vault (which can't open it either).
    const sealed = verified.sealedEmail && !ctx.exportMode ? { sealedEmail: verified.sealedEmail } : {};
    if (sink.kind === 'answer') {
      await answer(sink.slot, { idToken: verified.idToken, as: sink.as, ...(sink.as === 'session' ? sealed : {}) });
      return;
    }
    await relay({ idToken: verified.idToken, ...sealed });
  }

  /**
   * Case B: the address belongs to a wallet created with Google here. With the issuer's ticket: "Link and continue"
   * (this email joins that wallet, D139) or "Sign in with Google"; without it: "Continue with Google".
   */
  function showGoogleWallet(link: { linkTicket: string; emailSub: string } | null, cancelled = false): void {
    enter(null);
    const clientId = ctx.clientId;
    if (!clientId) {
      void abandon('email_unavailable', 'Sign in with Google', 'This email already opens a wallet you created with Google, and this app doesn’t offer Google sign-in here.', 'login_method_unavailable');
      return;
    }
    const toGoogle = (withLink: boolean) => {
      // The login's own Google request, as /login makes it (G-L3: google-match needs the access token in case B, so
      // token_first asks for it first here too).
      const follows = held ? !!held.followKey : peekLogin(win.sessionStorage, rid, now())?.follows === true;
      const google = loginGoogleRequest({
        flow: deps.googleEmailFlow ?? GOOGLE_EMAIL_FLOW,
        clientId,
        authOrigin: env.authOrigin,
        nonce: ctx.nonce,
        state: rid,
        follow: follows && !ctx.exportMode,
        task: !!ctx.proof,
        forceReauth: false,
      });
      // token_first: an attempt under a fresh `state` that answers this login's slot, and whose cancel comes back to
      // these choices (D341); the link, when picked, rides in its entry (D139).
      if (google.tokenFirst) {
        restartGoogle({ back: 'case_b', offer: link, caseB: withLink ? link : null });
        return;
      }
      // The relay key entry stays for /login/callback; with the link, the ticket and the `sub` ride in it (D139).
      if (withLink && link) {
        const taken = takeLogin(win.sessionStorage, rid, now());
        if (!taken) {
          fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
          return;
        }
        try {
          storeLoginEntry(win.sessionStorage, rid, taken.relayKey, now(), taken.timings ?? undefined, {
            ...(taken.followKey ? { followKey: taken.followKey } : {}),
            ...(taken.clientId ? { clientId: taken.clientId } : {}),
            caseB: link,
          });
        } catch {
          fatal('Sign-in stopped', 'This browser blocked the storage the sign-in needs.', 'storage_unavailable');
          return;
        } finally {
          zeroTaken(taken);
        }
      }
      clearT(deadlineTimer);
      tellVaultThen('google', () => win.location.assign(google.url));
    };
    const buttons: HTMLElement[] = [];
    if (link) {
      const go = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'email-link-google' } }, 'Link and continue');
      const plain = d.h('button', { attrs: { type: 'button', id: 'email-google' } }, 'Sign in with Google');
      go.addEventListener('click', () => {
        go.setAttribute('disabled', '');
        plain.setAttribute('disabled', '');
        toGoogle(true);
      });
      plain.addEventListener('click', () => {
        go.setAttribute('disabled', '');
        plain.setAttribute('disabled', '');
        toGoogle(false);
      });
      buttons.push(plain, go);
    } else {
      const go = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'email-google' } }, 'Continue with Google');
      go.addEventListener('click', () => {
        go.setAttribute('disabled', '');
        toGoogle(false);
      });
      buttons.push(go);
    }
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, 'Sign in with Google'),
        header(),
        cancelled ? d.h('p', { class: 'note', attrs: { role: 'status', id: 'google-cancelled' } }, GOOGLE_CANCELLED_TEXT) : null,
        d.h('p', {}, 'This email belongs to a wallet you created by signing in with Google. Continue with Google to open it.'),
        link
          ? d.h(
              'p',
              { class: 'muted', attrs: { id: 'email-link-explain' } },
              '“Link and continue” lets this email open the same wallet afterwards. If Google doesn’t host this mailbox, the link waits 24 hours and can be cancelled.',
            )
          : null,
        d.h('div', { class: 'actions' }, cancelButton(), ...buttons),
      ),
    );
    notice = cancelled ? 'google_cancelled' : 'google_wallet';
    settle('google_wallet');
  }

  /**
   * D341: Google again after a cancel (or case B's Google step under token_first): a fresh attempt under a new OAuth
   * `state`, its entry naming this login's slot, with the login's nonce; a cancel on Google's screen comes back to
   * `back`. With the held keys' `loginHint` (D273's interactive retry was what got cancelled, so slot 1 already holds
   * that account's access token) it is that retry again: the openid ID token of that account; otherwise token_first's
   * first request, with the account chooser.
   */
  function restartGoogle(o: { back: 'chooser' | 'case_b'; offer?: { linkTicket: string; emailSub: string } | null; caseB?: { linkTicket: string; emailSub: string } | null }): void {
    // Past the login's limit the vault has stopped waiting: no new attempt (the page says the sign-in took too long).
    if (pastDeadline()) return;
    const clientId = ctx.clientId;
    const taken = takeKeys();
    if (!taken || !clientId) {
      if (taken) zeroTaken(taken);
      fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
      return;
    }
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const hint = taken.loginHint ?? null;
    try {
      storeLoginEntry(win.sessionStorage, state, taken.relayKey, now(), taken.timings ?? undefined, {
        ...(taken.followKey ? { followKey: taken.followKey } : {}),
        clientId,
        tokenFirst: true,
        nonce: ctx.nonce,
        slot: rid,
        back: o.back,
        ...(o.offer ? { offer: o.offer } : {}),
        ...(o.caseB ? { caseB: o.caseB } : {}),
        ...(taken.record ? { record: true } : {}),
        ...(hint ? { leg: 'id' as const, loginHint: hint, interactive: true } : {}),
      });
    } catch {
      fatal('Sign-in stopped', 'This browser blocked the storage the sign-in needs.', 'storage_unavailable');
      // The vault waits on the slot: it hears why (G-L2).
      void encryptRelayPayload(taken.relayKey, rid, { error: 'storage_unavailable' })
        .then((v) => api.writeRelay(rid, v))
        .catch(() => undefined)
        .finally(() => zeroTaken(taken));
      return;
    }
    zeroTaken(taken);
    const url = hint
      ? googleAuthUrl({ clientId, authOrigin: env.authOrigin, nonce: ctx.nonce, state, forceReauth: false, loginHint: hint, silent: false })
      : googleTokenFirstUrl({ clientId, authOrigin: env.authOrigin, state });
    leaving = true;
    clearT(deadlineTimer);
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), header(), d.h('p', { class: 'muted' }, 'Continuing to Google…')));
    tellVaultThen('google', () => win.location.assign(url));
  }

  /** D341: Hana's method chooser again, after the user cancelled Google's screen (the held keys wait for the choice). */
  function showChooser(): void {
    enter(null);
    const buttons: HTMLElement[] = [];
    const disable = () => {
      for (const b of buttons) b.setAttribute('disabled', '');
    };
    if (ctx.methods.includes('google') && ctx.clientId) {
      const google = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'continue-google' } }, 'Continue with Google');
      google.addEventListener('click', () => {
        disable();
        restartGoogle({ back: 'chooser' });
      });
      buttons.push(google);
    }
    // D348: email only when the partner didn't restrict the login to Google (`hana.login({method: 'google'})`).
    if (ctx.methods.includes('email') && ctx.method !== 'google') {
      const email = d.h('button', { attrs: { type: 'button', id: 'continue-email' } }, 'Continue with email');
      email.addEventListener('click', () => {
        disable();
        chooseEmail();
      });
      buttons.push(email);
    }
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, 'Sign in'),
        header(),
        d.h('p', { class: 'note', attrs: { role: 'status', id: 'google-cancelled' } }, GOOGLE_CANCELLED_TEXT),
        d.h('div', { class: 'actions choose' }, ...buttons),
      ),
    );
    notice = 'google_cancelled';
    settle('choosing');
  }

  /** D341: the chooser's email: the login's entry back under its slot (as /login stores it), then the email step here. */
  function chooseEmail(): void {
    if (pastDeadline()) return;
    const taken = takeKeys();
    if (!taken) {
      fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
      return;
    }
    try {
      storeLoginEntry(win.sessionStorage, rid, taken.relayKey, now(), taken.timings ?? undefined, {
        ...(taken.followKey ? { followKey: taken.followKey } : {}),
        ...(taken.clientId ? { clientId: taken.clientId } : {}),
        tokenFirst: true,
        nonce: ctx.nonce,
        ...(taken.record ? { record: true } : {}),
        // Slot 1 already holds this account's access token (D273's retry was cancelled): case B's Google step is that
        // retry again.
        ...(taken.loginHint ? { loginHint: taken.loginHint } : {}),
      });
    } catch {
      fatal('Sign-in stopped', 'This browser blocked the storage the sign-in needs.', 'storage_unavailable');
      return;
    } finally {
      zeroTaken(taken);
    }
    showAddress();
  }

  /** D341: the window closed on the screen after a cancel: the vault hears it at once (`login_cancelled`). */
  function onPageHide(): void {
    win.removeEventListener('pagehide', onPageHide);
    const value = closeValue;
    closeValue = null;
    if (leaving || !held || !value) return;
    dropHeld();
    dropEmailContext(win.sessionStorage, rid);
    // keepalive (api.ts): the write outlives the closing window.
    void api.writeRelay(rid, value).catch(() => undefined);
  }

  /** Encrypts `payload` under the login's relay key (taken now, single use) and writes it to the first slot. */
  async function relay(payload: RelayPayload): Promise<void> {
    clearT(resendTimer);
    clearT(deadlineTimer);
    busy('Signing in', 'Finishing sign-in…', 'relaying');
    const taken = takeKeys();
    if (!taken) {
      dropEmailContext(win.sessionStorage, rid);
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
      dropEmailContext(win.sessionStorage, rid);
      zeroTaken(taken);
      fatal(
        'Sign-in could not finish',
        used ? 'This sign-in was already completed. Close this window.' : 'Hana could not be reached to finish the sign-in. Close this window and try again from the app.',
        err instanceof ApiError ? err.code : 'api_unavailable',
      );
      return;
    } finally {
      body = null;
    }
    if (taken.followKey && !ctx.exportMode && 'idToken' in payload) {
      // Follow-up mode, in place: the vault's next notice (its last word, or a screen).
      follow = { relayKey, followKey: taken.followKey };
      void readNotice(2);
      return;
    }
    dropEmailContext(win.sessionStorage, rid);
    zeroTaken(taken);
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'idToken' in payload ? 'Signed in' : 'Sign-in cancelled'), d.h('p', { class: 'muted' }, 'You can close this window.')));
    settle('done');
    tellVaultThen('relayed', () => win.close());
  }

  /** Cancel: the vault hears why (D245), and the window closes. */
  async function cancel(): Promise<void> {
    if (sink.kind === 'answer') {
      await answer(sink.slot, { error: reason });
      return;
    }
    await relay({ error: reason });
  }

  // ---- follow-up mode ----

  /** Writes the popup's answer to the notice in `slot` (into slot + 1), then reads the vault's next notice. */
  async function answer(slot: number, payload: RelayPayload): Promise<void> {
    const f = follow;
    if (!f) return;
    clearT(resendTimer);
    busy('Signing in', 'Finishing sign-in…', 'relaying');
    const { id } = followSlot(f.followKey, slot + 1);
    try {
      await api.writeRelay(id, await encryptRelayPayload(f.relayKey, id, payload));
    } catch (err) {
      endFollow();
      fatal('Sign-in could not finish', 'Hana could not be reached to finish the sign-in. Close this window and try again from the app.', err instanceof ApiError ? err.code : 'api_unavailable');
      return;
    }
    sink = { kind: 'first' };
    if ('error' in payload) {
      endFollow();
      d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Sign-in cancelled'), d.h('p', { class: 'muted' }, 'You can close this window.')));
      settle('done');
      tellVaultThen('relayed', () => win.close());
      return;
    }
    await readNotice(slot + 2);
  }

  function endFollow(): void {
    if (follow) zeroTaken({ relayKey: follow.relayKey, followKey: follow.followKey });
    follow = null;
    dropEmailContext(win.sessionStorage, rid);
  }

  /** Long-polls the vault's notice in `slot` and shows it. */
  async function readNotice(slot: number): Promise<void> {
    const f = follow;
    if (!f) return;
    busy('Signing in', 'Finishing sign-in…', 'following');
    settle('following');
    const { id, readKey } = followSlot(f.followKey, slot);
    const key = base64UrlEncode(readKey);
    readKey.fill(0);
    let backoff = 500;
    for (;;) {
      if (!follow) return;
      if (now() >= createdAt + FOLLOW_LIMIT_MS) {
        endFollow();
        d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), d.h('p', { class: 'muted' }, 'You can close this window.')));
        settle('done');
        return;
      }
      let value;
      try {
        value = await api.readRelay(id, key, 25);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 410)) {
          endFollow();
          fatal('Sign-in stopped', 'This sign-in’s answer is gone. Start again from the app.', err.code);
          return;
        }
        await new Promise<void>((resolve) => setT(resolve, backoff));
        backoff = Math.min(backoff * 2, 5_000);
        continue;
      }
      if (!value) continue;
      let n: FollowNotice;
      try {
        n = await decryptRelayValue(f.relayKey, id, value, isFollowNotice);
      } catch {
        endFollow();
        fatal('Sign-in stopped', 'The sign-in answer could not be read. Start again from the app.', 'token_invalid');
        return;
      }
      show(n, slot);
      return;
    }
  }

  function show(n: FollowNotice, slot: number): void {
    switch (n.t) {
      case 'link_code':
        return showLinkCode(n, slot);
      case 'use_email':
        return showUseEmail(slot);
      case 'email_consent':
        return showEmailConsent(n, slot);
      case 'prove':
        return prove(n.prove, slot, n.why === 'link_account' ? `Sign in with the ${providerName(n.provider)} that opens this wallet` : null);
      case 'done':
        return showDone(n.banners, slot);
      case 'stop':
        return showStop(n, slot);
    }
  }

  /** Case A, not Google-hosted: "Link and continue" (google-match's prepared code) or "Sign in with email". */
  function showLinkCode(n: Extract<FollowNotice, { t: 'link_code' }>, slot: number): void {
    const go = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'link-continue' } }, 'Link and continue');
    const other = d.h('button', { attrs: { type: 'button', id: 'link-use-email' } }, 'Sign in with email');
    go.addEventListener('click', () => {
      go.setAttribute('disabled', '');
      other.setAttribute('disabled', '');
      startAs = { kind: 'prepared', challengeId: n.challengeId, to: n.to };
      sink = { kind: 'answer', slot, as: 'link' };
      remember({ challengeId: n.challengeId });
      void resendCode();
    });
    other.addEventListener('click', () => toEmailLogin(slot));
    const cancelB = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
    cancelB.addEventListener('click', () => {
      sink = { kind: 'answer', slot, as: 'session' };
      void cancel();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, 'This email already has a wallet'),
        header(),
        d.h('p', {}, 'Your Google account’s email, ', d.h('strong', {}, n.to), ', already opens a wallet here. To open it with Google too, confirm with a code sent to that address.'),
        d.h('div', { class: 'actions' }, cancelB, other, go),
      ),
    );
    notice = 'link_code';
    settle('link_choice');
  }

  /** Case A that can't link: only "Sign in with email" (never a second wallet, D122). */
  function showUseEmail(slot: number): void {
    const other = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'link-use-email' } }, 'Sign in with email');
    other.addEventListener('click', () => toEmailLogin(slot));
    const cancelB = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
    cancelB.addEventListener('click', () => {
      sink = { kind: 'answer', slot, as: 'session' };
      void cancel();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, 'Sign in with email'),
        header(),
        d.h('p', {}, 'Your Google account’s email already opens a wallet here, which can’t take a Google sign-in. Sign in with that email to open it.'),
        d.h('div', { class: 'actions' }, cancelB, other),
      ),
    );
    notice = 'use_email';
    settle('link_choice');
  }

  /**
   * D264: a new Google wallet here needs Google's address checked once (case A: an email wallet may already have it),
   * and google-match couldn't read it: the user declined Google's permission, or picked another Google account on
   * Google's screen. "Sign in with email instead" (an email login answered to the vault), "Try Google again" (Google's
   * permission screen for the signed-in account, its answer in the next slot), or Cancel.
   */
  function showEmailConsent(n: Extract<FollowNotice, { t: 'email_consent' }>, slot: number): void {
    const viaEmail = d.h('button', { attrs: { type: 'button', id: 'consent-email' } }, 'Sign in with email instead');
    const again = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'consent-google' } }, 'Try Google again');
    viaEmail.addEventListener('click', () => toEmailLogin(slot));
    again.addEventListener('click', () => {
      viaEmail.setAttribute('disabled', '');
      again.setAttribute('disabled', '');
      googleAgain(n.loginHint, slot);
    });
    const cancelB = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
    cancelB.addEventListener('click', () => {
      sink = { kind: 'answer', slot, as: 'session' };
      reason = 'email_cancelled';
      void cancel();
    });
    const declined = n.reason === 'declined';
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, declined ? 'Your Google email address is needed' : 'Another Google account was chosen'),
        header(),
        d.h(
          'p',
          { attrs: { id: 'consent-text' } },
          declined
            ? 'Hana checks whether your Google address already has a wallet. It keeps the address with your account and doesn’t share it with the app you’re signing in to. Without it you can’t open a new wallet with Google here.'
            : 'You signed in with one Google account, then picked a different one when Google asked to share your email address. Try Google again and pick the account you signed in with, or sign in with email instead.',
        ),
        d.h('div', { class: 'actions' }, cancelB, viaEmail, again),
      ),
    );
    notice = declined ? 'email_consent_declined' : 'google_account_mismatch';
    settle('link_choice');
  }

  /** "Try Google again": Google's email permission for `loginHint`, interactively; the callback answers slot + 1. */
  function googleAgain(loginHint: string, slot: number): void {
    const f = follow;
    const clientId = ctx.clientId;
    if (!f || !clientId) {
      void answer(slot, { error: 'email_unavailable' });
      return;
    }
    const state = followSlot(f.followKey, slot + 1).id;
    try {
      storeLoginEntry(win.sessionStorage, state, f.relayKey, now(), undefined, { followKey: f.followKey, home: rid, next: slot + 2, leg: 'access', clientId, loginHint, interactive: true });
    } catch {
      void answer(slot, { error: 'storage_unavailable' }).finally(() => {
        endFollow();
        fatal('Sign-in stopped', 'This browser blocked the storage the sign-in needs.', 'storage_unavailable');
      });
      return;
    }
    zeroTaken({ relayKey: f.relayKey, followKey: f.followKey });
    follow = null;
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Continuing to Google'), header(), d.h('p', { class: 'muted' }, 'Google will ask to share your email address.')));
    settle('done');
    tellVaultThen('google', () => win.location.assign(googleAccessUrl({ clientId, authOrigin: env.authOrigin, state, loginHint, silent: false })));
  }

  function toEmailLogin(slot: number): void {
    startAs = { kind: 'session' };
    sink = { kind: 'answer', slot, as: 'session' };
    address = '';
    showAddress();
  }

  /** A proof the vault asked for (a link method's or a banner's): Google with its nonce, or an email code. */
  function prove(p: FollowProve, slot: number, title: string | null): void {
    if (!follow) return;
    if (p.method === 'google') {
      if (!ctx.clientId) {
        void answer(slot, { error: 'email_unavailable' });
        return;
      }
      const state = followSlot(follow.followKey, slot + 1).id;
      try {
        storeLoginEntry(win.sessionStorage, state, follow.relayKey, now(), undefined, { followKey: follow.followKey, home: rid, next: slot + 2, leg: 'proof', clientId: ctx.clientId });
      } catch {
        endFollow();
        fatal('Sign-in stopped', 'This browser blocked the storage the sign-in needs.', 'storage_unavailable');
        return;
      }
      const url = googleAuthUrl({ clientId: ctx.clientId, authOrigin: env.authOrigin, nonce: p.nonce, state, forceReauth: false, loginHint: p.loginHint });
      zeroTaken({ relayKey: follow.relayKey, followKey: follow.followKey });
      follow = null;
      d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, title ?? 'Confirm it’s you'), header(), d.h('p', { class: 'muted' }, 'Continuing to Google…')));
      settle('done');
      tellVaultThen('google', () => win.location.assign(url));
      return;
    }
    startAs = p.purpose === 'session' ? { kind: 'session' } : { kind: 'link', purpose: p.purpose, commitment: p.commitment };
    sink = { kind: 'answer', slot, as: 'proof' };
    showAddress(title);
  }

  /** The vault's last word: "Signed in", or the link banners first. */
  function showDone(banners: LinkBanner[], slot: number): void {
    if (banners.length === 0) {
      endFollow();
      d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signed in'), d.h('p', { class: 'muted' }, 'You can close this window.')));
      settle('done');
      // D411: an `at_login` app's popup goes on to the email sharing sheet instead of closing (share-handoff.ts).
      closeOrShare(win, rid, now());
      return;
    }
    showBanners('Signed in', banners, slot, null);
  }

  function showStop(n: Extract<FollowNotice, { t: 'stop' }>, slot: number): void {
    const text =
      n.code === 'link_pending' && n.effectiveAtMs !== undefined
        ? `This sign-in method was added to a wallet recently. It can open the wallet from ${dateText(n.effectiveAtMs)}.`
        : (STOP_TEXT[n.code] ?? 'The sign-in couldn’t finish. Close this window and try again from the app.');
    notice = n.code;
    if (n.banners && n.banners.length > 0) {
      showBanners('Sign-in stopped', n.banners, slot, text);
      return;
    }
    endFollow();
    d.show(errorView(d, 'Sign-in stopped', text, n.code));
    settle('stopped');
  }

  /** Link banners (spec "Notices"): each method, its state, and its Cancel or Remove when this sign-in may. */
  function showBanners(title: string, banners: LinkBanner[], slot: number, text: string | null): void {
    const items = banners.map((b, i) => {
      const what =
        b.status === 'pending'
          ? `${providerName(b.provider) === 'email' ? 'An email' : 'A Google account'} will be able to open this wallet from ${dateText(b.effectiveAtMs)}.`
          : b.fresh
            ? `Your ${providerName(b.provider)} sign-in now opens this wallet too.`
            : `A sign-in method was added: ${providerName(b.provider)} on ${dateText(b.effectiveAtMs)}.`;
      const action = b.action;
      const button = action ? d.h('button', { class: 'link', attrs: { type: 'button', id: `banner-${action.kind}-${i}` } }, action.kind === 'cancel' ? 'Cancel this link' : 'Remove') : null;
      if (button && action) button.addEventListener('click', () => prove(action.prove, slot, 'Confirm it’s you'));
      return d.h('li', { class: b.status === 'pending' ? 'banner pending' : 'banner', attrs: { 'data-provider': b.provider, 'data-status': b.status } }, what, button ? ' ' : null, button);
    });
    const done = d.h('button', { class: 'primary', attrs: { type: 'button', id: 'banner-done' } }, 'Done');
    done.addEventListener('click', () => {
      endFollow();
      settle('done');
      if (title === 'Signed in') closeOrShare(win, rid, now());
      else win.close();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, title),
        header(),
        text ? d.h('p', { attrs: { role: 'alert' } }, text) : null,
        d.h('ul', { class: 'banners', attrs: { id: 'link-banners' } }, ...items),
        d.h('div', { class: 'actions' }, done),
      ),
    );
    settle('banners');
  }

  // ---- start ----

  if (!env.emailIssuerUrl) {
    void abandon('email_unavailable', 'Sign-in stopped', 'Email sign-in is not set up here.', 'config_mismatch');
    return page;
  }
  // Follow-up mode after a Google leg (/login/callback stored the vault's next notice slot).
  const entry = peekLogin(win.sessionStorage, rid, now());
  if (entry?.next !== undefined) {
    const taken = takeLogin(win.sessionStorage, rid, now());
    if (!taken?.followKey) {
      if (taken) zeroTaken(taken);
      fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
      return page;
    }
    follow = { relayKey: taken.relayKey, followKey: taken.followKey };
    void readNotice(taken.next ?? 2);
    return page;
  }
  // D341: back after a cancel on Google's screen (/login/callback parked the login's keys for this screen).
  if (entry?.cancelled) {
    const taken = takeLogin(win.sessionStorage, rid, now());
    if (!taken?.followKey) {
      if (taken) zeroTaken(taken);
      fatal('Sign-in stopped', 'This sign-in has expired or was already used. Start again from the app.', 'login_timeout');
      return page;
    }
    held = taken;
    win.addEventListener('pagehide', onPageHide);
    void encryptRelayPayload(taken.relayKey, rid, { error: GOOGLE_CANCELLED_RELAY_ERROR }).then(
      (v) => {
        closeValue = v;
      },
      () => undefined,
    );
    if (pastDeadline()) return page;
    deadlineTimer = setT(() => {
      if (stage !== 'done' && stage !== 'error' && stage !== 'relaying' && !follow) pastDeadline();
    }, Math.max(0, deadlineAt - now()));
    if (taken.back === 'case_b') showGoogleWallet(taken.offer ?? null, true);
    else showChooser();
    return page;
  }
  if (pastDeadline()) return page;
  deadlineTimer = setT(() => {
    if (stage !== 'done' && stage !== 'error' && stage !== 'relaying' && !follow) pastDeadline();
  }, Math.max(0, deadlineAt - now()));
  showAddress();
  return page;
}
