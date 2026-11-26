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
//   next `start`, so its owner's code mail gets past the shared limits (D198). A staff unlock pressed on this browser's
//   `/email/unlock` page (D866) is sent with each `start` while it lasts, and dropped after a sign-in with its address.
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
//   is a proof, then the vault's answer; Done answers `{choice: 'keep'}` when an action was offered (the vault stops
//   waiting). D875: for the wallet's own sign-in, an active method past its first 7 days (`RECENT_LINK_MS`, on the
//   API's time from the read) is one plain line with Remove, shown until the user presses Done on it in this browser
//   (`localStorage` on authOrigin, `hana.ol.<sha256 of the line's kind and date>`). When only such dismissed lines are
//   left, the window answers `{choice: 'keep'}` and closes as with no banners. D887: a banner's or a line's Remove or
//   Cancel is a small outlined button on its own line under the sentence, after "Don't recognise it?";
// - `stop`: why the login ended (a pending link: when it activates).
// - `link_waiting` (D864): this email sign-in was refused because the email itself waits to join a wallet (someone
//   linked it to a Google account with one code to this address): the screen says so, with the date the link starts
//   working, and offers "Cancel this link" (one more code to the same address, over the vault's `link_change`
//   commitment for this email only, answered `as: 'proof'`) or "Keep the link" (closes; nothing changes). Then
//   `link_cancel`: the link was cancelled, was already gone, can't be cancelled any more (the waiting period ended:
//   the notice mail's stronger advice), or wasn't cancelled (what to do next, with the code for support).
// - `member_link` (D865): before the sign-in goes on, this sign-in is an active member of a wallet another sign-in
//   opens: "Remove this email" (a confirmation step that says what removing costs, then `{choice: 'remove'}`: the
//   sign-in stops, and `member_remove` asks for one more code, or Google, over the vault's `link_change` "unlink"
//   commitment), "Not now" (`{choice: 'keep'}`: the sign-in goes on; asked again next time) or the smaller "Don't ask
//   again on this device" (the same, and this device isn't asked again about this link: `localStorage` on
//   authOrigin, `hana.ml.<linkId>`). Then `member_removed`: removed, already removed, not removed or not known.
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
  isRecentLink,
  sha256,
  toHex,
  utf8,
} from '@hana-id/core';
import { BRAND } from '@hana-id/brand';
import type { HanaEnv } from '../hana-env.ts';
import { appLogo } from './logo.ts';
import type { AuthApi } from './api.ts';
import { type Child, type Dom, SIGN_IN_WINDOW, askerBox, dom, errorView, supportCode } from './dom.ts';
import { STORAGE_BLOCKED } from './errors.ts';
import type { EmailApi, LinkPurpose, SessionCommitment, Verified } from './email-api.ts';
import { issuerDetail } from './email-api.ts';
import { type BannerAction, EMAIL_STEP_LIMIT_MS, type EmailContext, deviceTicketFor, dropEmailContext, dropUnlockTokenFor, liveUnlockToken, readEmailContext, saveDeviceTicket, storeEmailContext } from './email-storage.ts';
import { GOOGLE_CANCELLED_RELAY_ERROR, GOOGLE_EMAIL_FLOW, type GoogleEmailFlow, googleAccessUrl, googleAuthUrl, googleTokenFirstUrl, loginGoogleRequest } from './google.ts';
import { type TakenLogin, peekLogin, storeLoginEntry, takeLogin, zeroTaken } from './login-storage.ts';
import { type PageWindow, childFrame, isFramed } from './page-window.ts';
import { closeOrShare } from './share-handoff.ts';
import { sharedWalletLine } from './shared-wallet.ts';
import { vaultSignals } from './vault-signal.ts';
import { BTN, alert, icon } from './ui.ts';

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
  | 'stopped'
  /** D864: this email waits to join a wallet: Cancel this link, or Keep the link. */
  | 'link_waiting'
  /** D864: what became of that cancel. */
  | 'link_cancelled'
  /** D865: an active member's own notice (Remove or Keep it), its confirmation step, and the removal's outcome. */
  | 'member_link'
  | 'member_confirm'
  | 'member_removed'
  /** D881: a banner's Remove asks first; then what became of a Remove or Cancel. */
  | 'banner_confirm'
  | 'link_changed';

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
/** The address check before a code is sent (the issuer makes its own): the field's blur check and the submit's. */
export const validAddress = (address: string): boolean => address.length >= 3 && address.length <= 254 && address.includes('@') && !/\s/u.test(address);
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
  unreachable: `${BRAND.company}’s email service can’t be reached right now. Try again in a moment.`,
  /** `start` failed without an answer: it may still have sent a mail. */
  unreachableStart: `${BRAND.company}’s email service can’t be reached right now. A code may already be on its way: if you try again, use the newest code.`,
  failed: (code: string) => `Something went wrong. Try again, or close this window and start again from the app. Error code (for support): ${code}.`,
  invalidEmail: 'Enter a valid email address.',
  invalidCode: 'Enter the 6-digit code from the mail.',
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
  api_unavailable: `${BRAND.company} couldn’t finish the sign-in. Close this window and try again from the app.`,
  token_invalid: 'The sign-in couldn’t be checked. Start again from the app.',
  derive_failed: 'The sign-in couldn’t finish. Start again from the app.',
};

/**
 * Case B's "Link and continue" (D853's wording): what the link does, and its waiting period when the mailbox isn't
 * Google's (the contract's `change_delay_ms`: 24 hours on a production network, shorter in a test env, D138).
 */
export const LINK_DELAY_TEXT =
  '“Link and continue” lets this email open the same wallet too. If this isn’t a Gmail or Google Workspace address, the link starts working after a waiting period (24 hours; shorter in a test version), and you can cancel it until then.';

/**
 * D875: the wallet's own sign-in sees its older ways to sign in (past their first 7 days) as plain lines with Remove,
 * until Done is pressed on them in this browser. What a line says (by kind only, as the banners do), and the note
 * under them.
 */
export const olderLinkText = (provider: string, since: string): string => `${provider === 'email' ? 'An email address' : 'A Google account'} also opens this wallet, since ${since}.`;
export const OLDER_LINK_NOTE = `After you press Done, this browser won’t show this again. ${BRAND.home} lists the ways to sign in to your wallet.`;

/**
 * D887 (decided by the Tech Lead 2026-11-23: "a small button, plus 'Didn't add it?' in front of it", then, the same day,
 * 'Change to "Don't recognise it?"'): a banner's or an older line's Remove or Cancel is a small outlined button on its
 * own line under the sentence, after "Don't recognise it?", which is true whoever added the sign-in (the user, a
 * same-address automatic link, or someone else). Not on a way to sign in this sign-in just added: the button stands
 * alone there, and a Remove is the shorter "Remove". Each button's accessible name is its visible words, then
 * (`more`, in a visually hidden span inside the button) what it changes, so a voice user's "Remove it" matches (WCAG
 * 2.5.3) and a screen reader's list of buttons tells two lines apart; the button is described by its sentence
 * (`aria-describedby`).
 */
export const BANNER_ACTION_TEXT = Object.freeze({
  lead: 'Don’t recognise it?',
  remove: 'Remove it',
  removeMore: (kind: string) => ` (the ${kind})`,
  removeFresh: 'Remove',
  removeFreshMore: (kind: string) => ` the ${kind} from this wallet`,
  cancel: 'Cancel this link',
  cancelMore: (kind: string) => ` for the ${kind}`,
});
/** How long a window waits for its `{choice: 'keep'}` write before it closes anyway (D875). */
export const KEEP_WRITE_MS = 1_500;

/** Passport Home's section that lists the ways to sign in (home-sign-ins.ts HOME_SIGN_INS_TITLE; a test keeps them equal). */
export const HOME_SIGN_INS_SECTION = 'Ways to sign in';

/**
 * D881: the screen after a sign-in that just added a way to sign in (a banner with `fresh: true` that is active), by
 * case. The vault's banner names only the kind of sign-in that joined; the rest this window knows itself: a Google
 * sign-in that joined after this window's "Link and continue" code (case A, not Google-hosted) shows the masked address
 * that screen already showed (`n.to`, a…@domain); a Google one without it joined at once (case A, Google-hosted:
 * nothing to decide, D119); an email one joined a Google wallet after the email step's "Link and continue" (case B,
 * Google-hosted). A waiting one (case B not hosted, `linkAccount`) keeps the waiting line.
 */
export const FRESH_TEXT = Object.freeze({
  googleHeading: 'You can now sign in with Google too',
  emailHeading: 'You can now sign in with email too',
  googleHosted:
    'You already have a wallet here, made when you signed in with your email address. Your Google account uses the same address, so signing in with Google now opens that same wallet.',
  googleCodeLead: 'You already have a wallet here, made when you signed in with ',
  googleCodeRest: '. You confirmed that address with a code, so signing in with Google now opens that same wallet.',
  email: 'You already have a wallet here, made when you signed in with Google. You chose to link your email address, so signing in with it now opens the same wallet.',
  same: 'Nothing was moved or lost, and you can sign in either way.',
  home: `You can see every way to sign in to your wallet in ${BRAND.home}, under “${HOME_SIGN_INS_SECTION}”.`,
});

/** How a sign-in is named when only its kind is known (D259, D874: never another sign-in's address). */
export const kindName = (provider: string): string => (provider === 'google' ? 'Google account' : 'email address');

/**
 * D881 (decided by the Tech Lead 2026-11-19: "we need a confirmation screen … it's too abrupt and I didn't even know what
 * happened"): a banner's Remove asks first, and a Remove or Cancel ends on a screen that says what became of it.
 */
export const CHANGE_TEXT = Object.freeze({
  confirmTitle: (kind: string) => `Remove the ${kind} from this wallet?`,
  confirmWhat: (kind: string) => `After you remove it, the ${kind} can’t open this wallet any more. Your money stays in this wallet.`,
  later: (kind: string) => `If you sign in with that ${kind} later, it opens a new, empty wallet of its own. It won’t be added back automatically.`,
  checkGoogle: 'Google will ask you to sign in again to check it’s you.',
  checkEmail: 'We’ll send one more code to your email address to check it’s you.',
  removeButton: 'Remove it',
  backButton: 'Go back',
  removingTitle: (kind: string) => `Removing the ${kind}`,
  cancellingTitle: 'Cancelling the link',
  working: 'This takes a few seconds…',
  removedTitle: (kind: string) => `The ${kind} was removed`,
  removedWhat: (kind: string) => `The ${kind} no longer opens this wallet. Removing it didn’t move any money.`,
  /**
   * links.ts `revokeAccountShares` (D233): every vault share of the wallet's path in the scope (every app of it) is
   * revoked. An open session holding one ends at its next share check (vault.ts: about a minute while the tab is shown,
   * every 5 minutes when idle, and before any signature); a session without a share ('none' persistence) ends with its
   * tab. Either way the next use asks to sign in again.
   */
  signInAgain: 'Devices signed in to this wallet, this one too, will be asked to sign in again.',
  /** Removing ends the access from now on; it can't take back what was done with it before. */
  /**
   * Removing ends that sign-in's access from now on only (a key exported meanwhile still works). Passport Home's words
   * for this risk (home-devices.ts: "move your money to a new wallet"), and how: signing in the same way opens this
   * same wallet; a different email address opens a new, empty one here (or another wallet app).
   */
  notYours:
    'Didn’t add it yourself? Someone else may have used this wallet while it was added. To be safe, move your money to a new wallet. Signing in the same way opens this same wallet, so use a different email address or another wallet app.',
  cancelledTitle: 'Link cancelled',
  cancelledWhat: (kind: string) => `The ${kind} is no longer being linked to this wallet, so it won’t open it.`,
  notRemovedTitle: (kind: string) => `The ${kind} wasn’t removed`,
  notCancelledTitle: 'The link wasn’t cancelled',
  stillOpens: (kind: string) => `Nothing changed. The ${kind} still opens this wallet.`,
  stillWaiting: 'Nothing changed. The link is still waiting.',
  notYou: 'We couldn’t check it was you.',
  /** `token_invalid` is also the vault's own failure to check the proof (its app settings or keys unreadable). */
  otherGoogle: 'If you picked a different Google account, try again with the one you signed in with.',
  changed: 'Nothing was changed. The ways to sign in to this wallet may have changed after this window opened.',
  busy: 'Journear couldn’t do this just now.',
  /** The check this change needed didn't finish (the vault does nothing with an answer that isn't a proof). */
  notProved: {
    email_cancelled: 'The check was cancelled before the code was entered.',
    email_code_invalid: 'The code was wrong.',
    email_challenge_expired: 'The code expired.',
    email_rate_limited: 'Too many codes were asked for.',
    email_unavailable: 'We couldn’t send a code to check it’s you.',
    google: 'Google didn’t finish checking it’s you.',
  } as Readonly<Record<string, string>>,
  unknownRemovedTitle: 'We couldn’t check the removal',
  unknownCancelledTitle: 'We couldn’t check the link',
  unknownRemoved: (kind: string) => `Something went wrong, so we can’t tell whether the ${kind} was removed.`,
  unknownCancelled: 'Something went wrong, so we can’t tell whether the link was cancelled.',
});

/**
 * D881: what a `stop` after a banner's Remove or Cancel means. The vault sends the API's code only (vault/login.ts
 * Afterword; `contract_rejected` becomes `link_refused`):
 * - `token_invalid`: the proof wasn't this sign-in's, or the vault couldn't check it (its own failures say so too).
 * - `link_refused`: the contract's rules (apps/api/src/links.ts `precheckChange`, or the contract's own refusal, which
 *   is reverted): the sign-in already gone, the link already active or cancelled, the sign-ins changed, a nonce
 *   mismatch. Nothing changed.
 * - Refused before anything is relayed (links.ts: `rate_limited` and `rate_limiter_unavailable` at :211-213 and :304,
 *   `bad_request` at :248-250, `token_expired` from `loginTokenRefusal` at :258, `nonce_mismatch` at :259,
 *   `near_unavailable` at :103 and :267), or a relay failure that certainly didn't execute (links.ts NOT_EXECUTED at :65:
 *   `near_unavailable`, `near_rejected`, `relayer_busy`, `relayer_unconfigured`, `method_not_allowed`), or a contract
 *   refusal (panics.ts: `links_unavailable`, `link_pending`, reverted): nothing changed.
 * - Anything else (`api_unavailable` for no answer, `link_in_flight`, `relayer_unavailable`, `timeout`, …) may follow a
 *   send: the outcome is unknown.
 * `not_proved` is the window's own: the check didn't finish, so the vault got no proof and changed nothing.
 */
export type ChangeFailure = 'not_you' | 'changed' | 'busy' | 'not_proved' | 'unknown';
const NOTHING_SENT: ReadonlySet<string> = new Set([
  'rate_limited',
  'rate_limiter_unavailable',
  'links_unavailable',
  'link_pending',
  'bad_request',
  'nonce_mismatch',
  'token_expired',
  'near_unavailable',
  'near_rejected',
  'relayer_busy',
  'relayer_unconfigured',
  'method_not_allowed',
]);
export function changeFailure(code: string): ChangeFailure {
  if (code === 'token_invalid') return 'not_you';
  if (code === 'link_refused') return 'changed';
  if (NOTHING_SENT.has(code)) return 'busy';
  return 'unknown';
}

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
  const d: Dom = dom(win.document, SIGN_IN_WINDOW);
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
    fatal('Sign-in stopped', `The ${BRAND.product} sign-in window can’t run inside another page.`, 'config_mismatch');
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
  /**
   * D881: the masked address (a…@domain) of the case-A code this window sent after "Link and continue", as its screen
   * showed it: the fresh banner that follows names the wallet by it. Memory only.
   */
  let codeLinkTo: string | null = null;
  /** Off the case-A code path (an email login instead): the code's address no longer names anything. */
  const leavePrepared = (): void => {
    startAs = { kind: 'session' };
    codeLinkTo = null;
  };
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
    askerBox(d, [appLogo(d, env, ctx.logoUrl), 'Signing in to ', d.h('strong', {}, ctx.appName)], ctx.parentOrigin, ctx.frame);
  /**
   * D912: who is asking, then the shared-wallet line, on the screens that sign in to this app's wallet (the address,
   * the code, the busy screens between them, the chooser again and the way to Google); none when the app is alone, or
   * in export mode. The follow-up screens keep the header alone: they may be about another wallet or a link.
   */
  const signInHeader = (): HTMLElement[] => {
    const shared = ctx.exportMode ? null : sharedWalletLine(d, ctx.otherApps, ctx.otherAppsUnknown);
    return shared ? [header(), shared] : [header()];
  };
  /** A notice; `retry` (a transient failure) adds "Try again", which repeats the request that failed. */
  const message = (text: string | null, id: string, retry?: () => void) => {
    if (!text) return null;
    if (!retry) return alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id } }, text);
    const again = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-retry' } }, 'Try again');
    again.addEventListener('click', () => {
      again.setAttribute('disabled', '');
      retry();
    });
    return alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id } }, text, ' ', again);
  };
  const cancelButton = () => {
    const b = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
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

  /**
   * A form field on the design system's pattern (D765): the label above (6 px gap), the input, a hint below that an
   * error replaces in place (the same line, so nothing under it moves while a pointer is on its way to a button). The
   * check runs when the field loses focus, never on each keystroke; the submit makes its own check as before.
   */
  function field(id: string, label: string, input: HTMLInputElement, hint: string, check: (value: string) => string | null): HTMLElement {
    const error = d.h('span', { class: 'jp-error', attrs: { id: `${id}-error` } });
    const wrap = d.h('div', { class: 'jp-field' }, d.h('label', { class: 'jp-label', attrs: { for: id } }, label), input, d.h('span', { class: 'jp-hint', attrs: { id: `${id}-hint` } }, hint), error);
    input.classList.add('jp-input');
    input.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
    input.addEventListener('blur', () => {
      const value = input.value.trim();
      const problem = value ? check(value) : null;
      error.textContent = problem ?? '';
      wrap.classList.toggle('is-invalid', problem !== null);
      if (problem) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
    return wrap;
  }

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
    const send = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'submit', id: 'email-send' } }, 'Send code');
    const form = d.h(
      'form',
      { class: 'email-form', attrs: { novalidate: '' } },
      field('email-address', 'Email address', input, 'We’ll email you a 6-digit code.', (v) => (validAddress(v) ? null : TEXT.invalidEmail)),
      message(problem, 'email-notice', retry),
      d.h('div', { class: 'actions' }, cancelButton(), send),
    );
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
    d.show(d.h('section', { class: 'panel email-step' }, d.h('h1', {}, addressTitle()), ...signInHeader(), explain, form));
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
    input.classList.add('code-input');
    const go = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'submit', id: 'email-verify' } }, 'Continue');
    const resend = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-resend', disabled: '' } }, 'Resend code');
    const other = d.h('button', { class: 'link', attrs: { type: 'button', id: 'email-other' } }, 'Use a different email');
    resend.addEventListener('click', () => void resendCode());
    other.addEventListener('click', () => {
      remember({ challengeId: null });
      reason = 'email_cancelled';
      // A prepared case-A code can't go to another address: "a different email" is an email login.
      if (startAs.kind === 'prepared') {
        leavePrepared();
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
        showCode(resendAfterMs, TEXT.invalidCode);
        return;
      }
      void verifyCode(typed, resendAfterMs);
    };
    const form = d.h(
      'form',
      { class: 'email-form', attrs: { novalidate: '' } },
      d.h('p', {}, 'We sent a 6-digit code to ', d.h('strong', {}, to), `. Type it here, in this ${BRAND.product} window only.`),
      field('email-code', 'Code', input, 'Find it in the mail we just sent.', (v) => (CODE_RE.test(v.replace(/\s+/gu, '')) ? null : TEXT.invalidCode)),
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
    d.show(d.h('section', { class: 'panel email-step' }, d.h('h1', {}, 'Check your email'), ...signInHeader(), form));
    try {
      input.focus();
    } catch {
      // Not focusable in this document: nothing to do.
    }
    settle('code');
  }

  /** `ownWallet`: false for a follow-up's change (a banner's Remove or Cancel), which shows who is asking alone (D912). */
  function busy(title: string, text: string, s: EmailStage, ownWallet = true): void {
    enter(s === 'sending' ? 'emailStart' : s === 'verifying' ? 'emailVerify' : null);
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, title), ...(ownWallet ? signInHeader() : [header()]), d.h('p', { class: 'muted' }, text)));
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
    if (!validAddress(address)) {
      notice = 'invalid_email';
      showAddress(TEXT.invalidEmail);
      return;
    }
    busy(addressTitle(), 'Sending a code…', 'sending');
    try {
      const ticket = deviceTicketFor(deps.tickets, address, now());
      // D866: a staff unlock this browser's support page pressed rides along while it lasts.
      const unlock = liveUnlockToken(deps.tickets, now());
      const extra: [string] | [] = unlock ? [unlock] : [];
      const c = startAs.kind === 'link' ? await issuer.startLink(ctx.pk, address, startAs.purpose, startAs.commitment, ticket, ...extra) : await issuer.start(ctx.pk, address, commitment, ticket, ...extra);
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
        if (startAs.kind === 'prepared') leavePrepared();
        showAddress(TEXT.expired);
        return;
      }
      const after = err instanceof ApiError && err.status === 429 && err.code === 'rate_limited' ? issuerDetail(err, 'resendAfterMs') : null;
      if (after !== null) {
        notice = 'resend_wait';
        showCode(after, TEXT.resendWait);
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
        // The issuer's body is `{error, code, data: {attemptsLeft}}`.
        const left = issuerDetail(err, 'attemptsLeft');
        notice = 'code_invalid';
        reason = 'email_code_invalid';
        if (left === 0) {
          remember({ challengeId: null });
          if (startAs.kind === 'prepared') leavePrepared();
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
        if (startAs.kind === 'prepared') leavePrepared();
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
    // A code to this address was right: an unlock kept for it has done its job (D866).
    if (startAs.kind !== 'prepared') dropUnlockTokenFor(deps.tickets, address);
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
          fatal('Sign-in stopped', STORAGE_BLOCKED, 'storage_unavailable');
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
      const go = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'email-link-google' } }, 'Link and continue');
      const plain = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'email-google' } }, 'Sign in with Google');
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
      buttons.push(go, plain);
    } else {
      const go = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'email-google' } }, 'Continue with Google');
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
        cancelled ? alert(d, 'info', { class: 'note', attrs: { role: 'status', id: 'google-cancelled' } }, GOOGLE_CANCELLED_TEXT) : null,
        d.h('p', {}, 'This email belongs to a wallet you created by signing in with Google. Continue with Google to open it.'),
        link
          ? d.h(
              'p',
              { class: 'muted', attrs: { id: 'email-link-explain' } },
              LINK_DELAY_TEXT,
            )
          : null,
        link ? d.h('div', { class: 'actions stack' }, ...buttons, cancelButton()) : d.h('div', { class: 'actions' }, cancelButton(), ...buttons),
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
      fatal('Sign-in stopped', STORAGE_BLOCKED, 'storage_unavailable');
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
    d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signing in'), ...signInHeader(), d.h('p', { class: 'muted' }, 'Continuing to Google…')));
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
      const google = d.h('button', { class: 'jp-provider primary', attrs: { type: 'button', id: 'continue-google' } }, icon(d, 'google'), 'Continue with Google', icon(d, 'chev-r', 'chev'));
      google.addEventListener('click', () => {
        disable();
        restartGoogle({ back: 'chooser' });
      });
      buttons.push(google);
    }
    // D348: email only when the partner didn't restrict the login to Google (`hana.login({method: 'google'})`).
    if (ctx.methods.includes('email') && ctx.method !== 'google') {
      const email = d.h('button', { class: 'jp-provider', attrs: { type: 'button', id: 'continue-email' } }, icon(d, 'mail'), 'Continue with email', icon(d, 'chev-r', 'chev'));
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
        ...signInHeader(),
        alert(d, 'info', { class: 'note', attrs: { role: 'status', id: 'google-cancelled' } }, GOOGLE_CANCELLED_TEXT),
        d.h('div', { class: 'providers' }, ...buttons),
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
      fatal('Sign-in stopped', STORAGE_BLOCKED, 'storage_unavailable');
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
        'Sign-in couldn’t finish',
        used ? 'This sign-in was already completed. Close this window.' : `${BRAND.company} couldn’t be reached to finish the sign-in. Close this window and try again from the app.`,
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
    // D881: an answer to a banner's Remove or Cancel. A proof shows the change's own words while the vault works; an
    // error (the code step cancelled or failed) changes nothing, and says so once written.
    const change = actionAt(slot + 2);
    const failed = 'error' in payload ? String(payload.error) : null;
    if (!(change && failed !== null) && !changeBusy(slot + 2, 'relaying')) busy('Signing in', 'Finishing sign-in…', 'relaying');
    const { id } = followSlot(f.followKey, slot + 1);
    try {
      await api.writeRelay(id, await encryptRelayPayload(f.relayKey, id, payload));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'api_unavailable';
      // A proof that may have reached the vault: can't tell. An error answer that didn't: nothing changed either way.
      if (change) return showChangeResult(change, failed ?? code, failed === null ? 'unknown' : 'not_proved');
      endFollow();
      fatal('Sign-in couldn’t finish', `${BRAND.company} couldn’t be reached to finish the sign-in. Close this window and try again from the app.`, code);
      return;
    }
    sink = { kind: 'first' };
    if (change && failed !== null) return showChangeResult(change, failed, 'not_proved');
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
    if (!changeBusy(slot, 'following')) busy('Signing in', 'Finishing sign-in…', 'following');
    settle('following');
    const { id, readKey } = followSlot(f.followKey, slot);
    const key = base64UrlEncode(readKey);
    readKey.fill(0);
    let backoff = 500;
    for (;;) {
      if (!follow) return;
      if (now() >= createdAt + FOLLOW_LIMIT_MS) {
        // D881: the vault's word on a change never came (its own wait may have ended first): can't tell.
        const change = actionAt(slot);
        if (change) return showChangeResult(change, 'login_timeout', 'unknown');
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
          const change = actionAt(slot);
          if (change) return showChangeResult(change, err.code, 'unknown');
          endFollow();
          fatal('Sign-in stopped', 'This sign-in can’t be finished any more. Start again from the app.', err.code);
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
        const change = actionAt(slot);
        if (change) return showChangeResult(change, 'token_invalid', 'unknown');
        endFollow();
        fatal('Sign-in stopped', 'This sign-in couldn’t be read. Start again from the app.', 'token_invalid');
        return;
      }
      show(n, slot, value.serverTimeMs);
      return;
    }
  }

  /** `serverTimeMs`: the API's time on the read that brought `n` (an older link's line is judged on it, D875). */
  function show(n: FollowNotice, slot: number, serverTimeMs: number): void {
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
        return showDone(n.banners, slot, serverTimeMs);
      case 'stop':
        return showStop(n, slot, serverTimeMs);
      case 'link_waiting':
        return showLinkWaiting(n, slot);
      case 'link_cancel':
        return showLinkCancel(n, slot);
      case 'member_link':
        return showMemberLink(n, slot);
      case 'member_remove':
        return proveMemberRemove(n.prove, slot);
      case 'member_removed':
        return showMemberRemoved(n);
    }
  }

  /** Case A, not Google-hosted: "Link and continue" (google-match's prepared code) or "Sign in with email". */
  function showLinkCode(n: Extract<FollowNotice, { t: 'link_code' }>, slot: number): void {
    const go = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'link-continue' } }, 'Link and continue');
    const other = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'link-use-email' } }, 'Sign in with email');
    go.addEventListener('click', () => {
      go.setAttribute('disabled', '');
      other.setAttribute('disabled', '');
      startAs = { kind: 'prepared', challengeId: n.challengeId, to: n.to };
      sink = { kind: 'answer', slot, as: 'link' };
      codeLinkTo = n.to;
      remember({ challengeId: n.challengeId });
      void resendCode();
    });
    other.addEventListener('click', () => toEmailLogin(slot));
    const cancelB = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
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
        d.h('div', { class: 'actions stack' }, go, other, cancelB),
      ),
    );
    notice = 'link_code';
    settle('link_choice');
  }

  /** Case A that can't link: only "Sign in with email" (never a second wallet, D122). */
  function showUseEmail(slot: number): void {
    const other = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'link-use-email' } }, 'Sign in with email');
    other.addEventListener('click', () => toEmailLogin(slot));
    const cancelB = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
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
    const viaEmail = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'consent-email' } }, 'Sign in with email instead');
    const again = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'consent-google' } }, 'Try Google again');
    viaEmail.addEventListener('click', () => toEmailLogin(slot));
    again.addEventListener('click', () => {
      viaEmail.setAttribute('disabled', '');
      again.setAttribute('disabled', '');
      googleAgain(n.loginHint, slot);
    });
    const cancelB = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'email-cancel' } }, 'Cancel');
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
            ? `${BRAND.company} checks whether your Google address already has a wallet. It keeps the address with your account and doesn’t share it with the app you’re signing in to. Without it you can’t open a new wallet with Google here.`
            : 'You signed in with one Google account, then picked a different one when Google asked to share your email address. Try Google again and pick the account you signed in with, or sign in with email instead.',
        ),
        d.h('div', { class: 'actions stack' }, again, viaEmail, cancelB),
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
        fatal('Sign-in stopped', STORAGE_BLOCKED, 'storage_unavailable');
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
    leavePrepared();
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
        fatal('Sign-in stopped', STORAGE_BLOCKED, 'storage_unavailable');
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
  function showDone(banners: LinkBanner[], slot: number, serverTimeMs: number): void {
    // D881: the vault's word after a banner's Remove or Cancel this window started: it was done.
    const after = actionAt(slot);
    if (after) return showChangeResult(after, null);
    // D875: an older link this browser has already dismissed (Done) is no reason to keep the window open.
    const worth = banners.filter((b) => !olderLink(b, serverTimeMs) || !olderSeenHere(b));
    if (worth.length === 0) {
      // Something was offered (only an older link's Remove, already shown here): tell the vault not to wait for it.
      const told = banners.some((b) => b.action) ? keepAnswer(slot) : null;
      endFollow();
      d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'Signed in'), d.h('p', { class: 'muted' }, 'You can close this window.')));
      settle('done');
      // D411: an `at_login` app's popup goes on to the email sharing sheet instead of closing (share-handoff.ts).
      if (told) void told.then(() => closeOrShare(win, rid, now()));
      else closeOrShare(win, rid, now());
      return;
    }
    // D881: a way to sign in this sign-in just added gets a heading that says so.
    const fresh = banners.find((b) => b.fresh && b.status === 'active' && (b.provider === 'google' || b.provider === 'email'));
    const title = fresh ? (fresh.provider === 'google' ? FRESH_TEXT.googleHeading : FRESH_TEXT.emailHeading) : 'Signed in';
    showBanners(title, banners, slot, null, serverTimeMs, true);
  }

  function showStop(n: Extract<FollowNotice, { t: 'stop' }>, slot: number, serverTimeMs: number): void {
    // D881: the vault's word after a banner's Remove or Cancel this window started: it wasn't done, or may not be.
    const after = actionAt(slot);
    if (after) return showChangeResult(after, n.code);
    const text =
      n.code === 'link_pending' && n.effectiveAtMs !== undefined
        ? `This sign-in method was added to a wallet recently. It can open the wallet from ${dateText(n.effectiveAtMs)}.`
        : (STOP_TEXT[n.code] ?? 'The sign-in couldn’t finish. Close this window and try again from the app.');
    notice = n.code;
    if (n.banners && n.banners.length > 0) {
      showBanners('Sign-in stopped', n.banners, slot, text, serverTimeMs, false);
      return;
    }
    endFollow();
    d.show(errorView(d, 'Sign-in stopped', text, n.code));
    settle('stopped');
  }

  // ---- D875: the older ways to sign in, offered quietly to the wallet's own sign-in ----

  /**
   * The browser remembers the older lines the user pressed Done on: authOrigin's localStorage, keyed by a hash of the
   * line's kind and date (public chain facts: the hash hides them from a casual look, nothing more).
   */
  const OLDER_SEEN_PREFIX = 'hana.ol.';
  const olderId = (b: LinkBanner): string => toHex(sha256(utf8(`hana-id/older-link/v1|${b.provider}|${b.effectiveAtMs}`)));
  /**
   * An active link past its first 7 days that this login didn't make (core relay.ts `RECENT_LINK_MS`), judged on the
   * API's time as the vault judged it. The vault sends one only to the wallet's own sign-in, with Remove.
   */
  const olderLink = (b: LinkBanner, serverTimeMs: number): boolean => b.status === 'active' && !b.fresh && !isRecentLink(b.effectiveAtMs, serverTimeMs);
  const olderSeenHere = (b: LinkBanner): boolean => {
    try {
      const v = deps.tickets?.getItem(OLDER_SEEN_PREFIX + olderId(b));
      return v !== null && v !== undefined;
    } catch {
      // Storage unreadable: show it (the safe side).
      return false;
    }
  };
  const olderShownHere = (b: LinkBanner): void => {
    try {
      deps.tickets?.setItem(OLDER_SEEN_PREFIX + olderId(b), String(now()));
    } catch {
      // Storage refused: the next sign-in on this device shows it again.
    }
  };

  /**
   * Tells the vault there's nothing to wait for: `{choice: 'keep'}` in slot + 1 ends its wait for a banner's answer at
   * once, instead of after AFTERWORD_MS. One request, given at most KEEP_WRITE_MS before the window closes anyway (the
   * app's sign-in finished before it). Never fails.
   */
  function keepAnswer(slot: number): Promise<void> {
    const f = follow;
    if (!f) return Promise.resolve();
    const { id } = followSlot(f.followKey, slot + 1);
    // Encrypted at once (the key is copied before this returns), so endFollow may zero it straight after.
    const write = (async () => api.writeRelay(id, await encryptRelayPayload(f.relayKey, id, { choice: 'keep' })))();
    return Promise.race([write, new Promise<void>((r) => setT(r, KEEP_WRITE_MS))]).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * D881: what a fresh, active banner says, by case (FRESH_TEXT): the sign-in that joined, the wallet it opens (the
   * one made with the other sign-in), and that nothing was moved. Text nodes; the masked address only as this window's
   * own case-A screen showed it.
   */
  function freshText(b: LinkBanner): Child[] {
    if (b.provider === 'email') return [FRESH_TEXT.email, ' ', FRESH_TEXT.same];
    if (codeLinkTo !== null) return [FRESH_TEXT.googleCodeLead, d.h('strong', {}, codeLinkTo), FRESH_TEXT.googleCodeRest, ' ', FRESH_TEXT.same];
    return [FRESH_TEXT.googleHosted, ' ', FRESH_TEXT.same];
  }

  /**
   * Link banners (spec "Notices"): each method, its state, and its Cancel or Remove when this sign-in may. `signedIn`:
   * the sign-in itself finished (`done`), so Done goes on as a finished sign-in does (D411); a `stop` closes.
   */
  function showBanners(title: string, banners: LinkBanner[], slot: number, text: string | null, serverTimeMs: number, signedIn: boolean): void {
    const again = (): void => showBanners(title, banners, slot, text, serverTimeMs, signedIn);
    /** One press per screen: Done, a Remove or a Cancel (each takes this screen away). */
    let pressed = false;
    const once = (f: () => void) => () => {
      if (pressed) return;
      pressed = true;
      f();
    };
    /**
     * D887: the banner's Remove or Cancel, on its own line under the sentence: "Don't recognise it?" and a small outlined
     * button (a way to sign in this sign-in just added: the button alone). Quiet on purpose: no box, colour or icon of
     * its own; Done stays the one primary button.
     */
    /** The id of banner `i`'s sentence, which describes its button. */
    const sentenceId = (i: number): string => `banner-sentence-${i}`;
    const actionLine = (b: LinkBanner, i: number): HTMLElement | null => {
      const action = b.action;
      if (!action) return null;
      const provider = b.provider === 'google' ? 'google' : 'email';
      const kind = kindName(provider);
      const T = BANNER_ACTION_TEXT;
      const [label, more] = action.kind === 'cancel' ? [T.cancel, T.cancelMore(kind)] : b.fresh ? [T.removeFresh, T.removeFreshMore(kind)] : [T.remove, T.removeMore(kind)];
      const el = d.h(
        'button',
        { class: `${BTN.secondary} jp-btn-sm`, attrs: { type: 'button', id: `banner-${action.kind}-${i}`, 'aria-describedby': sentenceId(i) } },
        label,
        d.h('span', { class: 'sr-only' }, more),
      );
      const change: BannerAction = { kind: action.kind, provider, method: action.prove.method, slot: slot + 2, signedIn };
      // D881: Remove asks first (what it costs); Cancel, the safe side of a link nobody may have meant, doesn't.
      el.addEventListener(
        'click',
        once(() => (action.kind === 'unlink' ? showRemoveConfirm(change, action.prove, slot, again) : startChange(change, action.prove, slot))),
      );
      return d.h('p', { class: 'banner-action' }, b.fresh ? null : d.h('span', { class: 'banner-action-lead' }, T.lead), el);
    };
    const items: HTMLElement[] = [];
    const older: HTMLElement[] = [];
    const shownOlder: LinkBanner[] = [];
    let freshShown = false;
    banners.forEach((b, i) => {
      const action = actionLine(b, i);
      if (olderLink(b, serverTimeMs)) {
        // D875: plain lines, no box, no colour: who else opens this wallet; D887: under it, "Don't recognise it?" and Remove.
        older.push(d.h('div', { class: 'older-link', attrs: { 'data-provider': b.provider } }, d.h('p', { class: 'older-link-text', attrs: { id: sentenceId(i) } }, olderLinkText(b.provider, dateText(b.effectiveAtMs))), action));
        shownOlder.push(b);
        return;
      }
      const fresh = b.status === 'active' && b.fresh;
      if (fresh) freshShown = true;
      const what: Child[] =
        b.status === 'pending'
          ? [`${providerName(b.provider) === 'email' ? 'An email' : 'A Google account'} will be able to open this wallet from ${dateText(b.effectiveAtMs)}.`]
          : fresh
            ? freshText(b)
            : [`A sign-in method was added: ${providerName(b.provider)} on ${dateText(b.effectiveAtMs)}.`];
      items.push(
        d.h(
          'li',
          { class: b.status === 'pending' ? 'banner pending' : 'banner', attrs: { 'data-provider': b.provider, 'data-status': b.status, ...(fresh ? { 'data-fresh': 'true' } : {}) } },
          icon(d, b.status === 'pending' ? 'clock' : 'check-c'),
          d.h('div', { class: 'banner-text' }, d.h('p', { class: 'banner-what', attrs: { id: sentenceId(i) } }, ...what), action),
        ),
      );
    });
    const done = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'banner-done' } }, 'Done');
    done.addEventListener(
      'click',
      once(() => {
        // D875: only Done uses up an older line in this browser. Remove (which may still fail or be abandoned, or be
        // gone back from, D881), the window's own close button, or the app closing the window leaves it to be shown at
        // the next sign-in.
        for (const b of shownOlder) olderShownHere(b);
        // Done means no Remove or Cancel from this screen: tell the vault so it stops waiting. Safe: a Remove or Cancel
        // takes this window away to its confirmation or proof, and only the proof writes this slot's answer; "Go back"
        // writes nothing, so a Done here is the slot's one write (and the relay takes one write per slot anyway).
        const told = banners.some((b) => b.action) ? keepAnswer(slot) : null;
        endFollow();
        settle('done');
        const leave = (): void => (signedIn ? closeOrShare(win, rid, now()) : win.close());
        if (told) {
          done.setAttribute('disabled', '');
          void told.then(leave);
        } else leave();
      }),
    );
    d.show(
      d.h(
        'section',
        { class: 'panel' },
        d.h('h1', {}, title),
        header(),
        text ? alert(d, 'danger', { attrs: { role: 'alert' } }, text) : null,
        items.length > 0 ? d.h('ul', { class: 'banners', attrs: { id: 'link-banners' } }, ...items) : null,
        // D881: where every way to sign in is listed (D874); the older lines' own note says it when they are shown.
        freshShown && older.length === 0 ? d.h('p', { class: 'muted', attrs: { id: 'link-fresh-home' } }, FRESH_TEXT.home) : null,
        older.length > 0 ? d.h('div', { class: 'older-links', attrs: { id: 'link-older' } }, ...older, d.h('p', { class: 'muted' }, OLDER_LINK_NOTE)) : null,
        d.h('div', { class: 'actions' }, done),
      ),
    );
    settle('banners');
  }

  // ---- D881: a banner's Remove (asked first) and Cancel, and what became of them ----

  /** The Remove or Cancel this window started whose outcome is the vault's word in `slot`, if any. */
  function actionAt(slot: number): BannerAction | null {
    const a = ctx.bannerAction ?? null;
    return a && a.slot === slot ? a : null;
  }

  /**
   * Before a Remove: what it costs, in D865's shape and tone ("Remove it" / "Go back"). Go back shows the banners again
   * with nothing written or marked seen (D875: only Done does that).
   */
  function showRemoveConfirm(change: BannerAction, p: FollowProve, slot: number, onBack: () => void): void {
    const kind = kindName(change.provider);
    const go = d.h('button', { class: `${BTN.danger} jp-btn-lg`, attrs: { type: 'button', id: 'banner-remove-confirm' } }, CHANGE_TEXT.removeButton);
    const back = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'banner-remove-back' } }, CHANGE_TEXT.backButton);
    let chosen = false;
    go.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      go.setAttribute('disabled', '');
      back.setAttribute('disabled', '');
      startChange(change, p, slot);
    });
    back.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      onBack();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel', attrs: { id: 'banner-remove', 'data-provider': change.provider } },
        d.h('h1', {}, CHANGE_TEXT.confirmTitle(kind)),
        header(),
        alert(d, 'danger', { class: 'note', attrs: { role: 'alert', id: 'banner-remove-what' } }, CHANGE_TEXT.confirmWhat(kind)),
        d.h('p', { attrs: { id: 'banner-remove-next' } }, CHANGE_TEXT.later(kind)),
        d.h('p', { class: 'muted', attrs: { id: 'banner-remove-check' } }, change.method === 'google' ? CHANGE_TEXT.checkGoogle : CHANGE_TEXT.checkEmail),
        d.h('div', { class: 'actions stack' }, go, back),
      ),
    );
    notice = 'banner_remove';
    settle('banner_confirm');
  }

  /**
   * The change's proof. The window remembers what it started (the email context, so a Google proof's round trip
   * through /login/callback keeps it), so the vault's next word shows as its outcome. An email proof goes to the
   * address this window just proved, as D864's and D865's do (no retyping); the address screen only when it isn't here.
   */
  function startChange(change: BannerAction, p: FollowProve, slot: number): void {
    remember({ bannerAction: change });
    if (p.method === 'email' && p.purpose === 'link_change' && validAddress(address)) {
      startAs = { kind: 'link', purpose: 'link_change', commitment: p.commitment };
      sink = { kind: 'answer', slot, as: 'proof' };
      void sendCode();
      return;
    }
    prove(p, slot, 'Confirm it’s you');
  }

  /** While the vault makes the change: its own words, not "Signing in". */
  function changeBusy(slot: number, s: EmailStage): boolean {
    const a = actionAt(slot);
    if (!a) return false;
    busy(a.kind === 'unlink' ? CHANGE_TEXT.removingTitle(kindName(a.provider)) : CHANGE_TEXT.cancellingTitle, CHANGE_TEXT.working, s, false);
    return true;
  }

  /**
   * What became of the change: `code` null when the vault said it was done, else its `stop` code (changeFailure). A
   * failure leaves the banner or line to be shown again at the next sign-in (nothing is marked seen, D875).
   */
  function showChangeResult(change: BannerAction, code: string | null, as?: ChangeFailure): void {
    endFollow();
    const kind = kindName(change.provider);
    const removing = change.kind === 'unlink';
    const app = () => d.h('strong', {}, ctx.appName);
    const say = (tone: 'success' | 'warning', ...text: Child[]) => alert(d, tone, { class: 'note', attrs: { role: tone === 'success' ? 'status' : 'alert', id: 'link-change-what' } }, ...text);
    const advice = (...text: Child[]) => d.h('p', { attrs: { id: 'link-change-advice' } }, ...text);
    const failure = code === null ? null : (as ?? changeFailure(code));
    let title: string;
    let body: (HTMLElement | null)[];
    if (failure === null) {
      title = removing ? CHANGE_TEXT.removedTitle(kind) : CHANGE_TEXT.cancelledTitle;
      body = removing
        ? [
            say('success', CHANGE_TEXT.removedWhat(kind)),
            d.h('p', { attrs: { id: 'link-change-signin' } }, CHANGE_TEXT.signInAgain),
            d.h('p', { attrs: { id: 'link-change-next' } }, CHANGE_TEXT.later(kind)),
            d.h('p', { attrs: { id: 'link-change-advice' } }, CHANGE_TEXT.notYours),
          ]
        : [say('success', CHANGE_TEXT.cancelledWhat(kind)), d.h('p', { attrs: { id: 'link-change-signin' } }, CHANGE_TEXT.signInAgain)];
    } else {
      // Can't tell: the heading says so too (D865's and D864's own headings for the same case).
      title = failure === 'unknown' ? (removing ? CHANGE_TEXT.unknownRemovedTitle : CHANGE_TEXT.unknownCancelledTitle) : removing ? CHANGE_TEXT.notRemovedTitle(kind) : CHANGE_TEXT.notCancelledTitle;
      const nothing = removing ? CHANGE_TEXT.stillOpens(kind) : CHANGE_TEXT.stillWaiting;
      const tryAgain = advice('Close this window, then sign in to ', app(), ' again to try again.');
      switch (failure) {
        case 'not_you':
          body = [say('warning', nothing, ' ', CHANGE_TEXT.notYou), change.method === 'google' ? d.h('p', { attrs: { id: 'link-change-why' } }, CHANGE_TEXT.otherGoogle) : null, tryAgain];
          break;
        case 'not_proved':
          body = [say('warning', nothing, ' ', CHANGE_TEXT.notProved[code as string] ?? CHANGE_TEXT.notProved.google!), tryAgain];
          break;
        case 'changed':
          body = [say('warning', CHANGE_TEXT.changed), advice('Close this window, then sign in to ', app(), ' again to see them as they are now.')];
          break;
        case 'busy':
          // A day's limit can be what refused it (links.ts: 100 changes a day per wallet): "later", not "in a few minutes".
          body = [say('warning', nothing, ' ', CHANGE_TEXT.busy), advice('Close this window, then sign in to ', app(), ' again later to try again.')];
          break;
        case 'unknown':
          body = [
            say('warning', removing ? CHANGE_TEXT.unknownRemoved(kind) : CHANGE_TEXT.unknownCancelled),
            removing
              ? advice('Sign in to ', app(), ` again. If the ${kind} still opens this wallet, you’ll see it there with a button to remove it.`)
              : advice('Sign in to ', app(), ' again. If the link is still waiting, you’ll see Cancel this link again.'),
          ];
          break;
      }
      body.push(d.h('p', { class: 'code' }, supportCode(code as string)));
    }
    const close = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'link-change-close' } }, 'Close');
    close.addEventListener('click', () => {
      settle('done');
      // A finished sign-in goes on as it does after Done (D411); a stopped one just closes.
      if (change.signedIn) closeOrShare(win, rid, now());
      else win.close();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel', attrs: { id: 'link-change-result', 'data-kind': change.kind, 'data-outcome': failure ?? 'done' } },
        d.h('h1', {}, title),
        header(),
        ...body,
        d.h('div', { class: 'actions' }, close),
      ),
    );
    notice = code ?? (removing ? 'link_removed' : 'link_cancelled');
    settle('link_changed');
  }

  // ---- D864: the email that waits to join a wallet ----

  /** The other sign-in the waiting screen named ("that Google account"), for the outcome's words. */
  let waitingOther = 'that account';

  /** The panel's close button: ends the follow-up mode and closes the window. */
  function closeButton(id: string, label = 'Close'): HTMLElement {
    const b = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id } }, label);
    b.addEventListener('click', () => {
      endFollow();
      settle('done');
      win.close();
    });
    return b;
  }

  /**
   * The person who just proved this mailbox learns that it is being linked with another sign-in (`n.provider`, the
   * wallet's own: named only by its kind, as the banners do), and since when it will work; Cancel proves the mailbox
   * once more over the vault's `link_change` commitment. The safe default is to cancel: the one who made the link can
   * make it again, while a link nobody here made would let this email open someone else's wallet.
   */
  function showLinkWaiting(n: Extract<FollowNotice, { t: 'link_waiting' }>, slot: number): void {
    const google = n.provider === 'google';
    const other = google ? 'a Google account' : 'another sign-in';
    waitingOther = google ? 'that Google account' : 'that sign-in';
    const when = dateText(n.effectiveAtMs);
    const cancelB = d.h('button', { class: `primary ${BTN.primary} jp-btn-lg`, attrs: { type: 'button', id: 'link-cancel' } }, 'Cancel this link');
    const keepB = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'link-keep' } }, 'Keep the link');
    // One choice per screen, however fast the taps (the buttons are disabled too).
    let chosen = false;
    cancelB.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      cancelB.setAttribute('disabled', '');
      keepB.setAttribute('disabled', '');
      if (!follow || n.prove.method !== 'email' || n.prove.purpose !== 'link_change') {
        endFollow();
        fatal('Link not cancelled', 'This sign-in can’t cancel the link. Close this window and sign in with this email again.', 'token_invalid');
        return;
      }
      startAs = { kind: 'link', purpose: 'link_change', commitment: n.prove.commitment };
      sink = { kind: 'answer', slot, as: 'proof' };
      // The address this window just proved: the code goes to it again, no retyping.
      if (validAddress(address)) void sendCode();
      else showAddress();
    });
    keepB.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      cancelB.setAttribute('disabled', '');
      keepB.setAttribute('disabled', '');
      endFollow();
      d.show(d.h('section', { class: 'panel' }, d.h('h1', {}, 'The link stays'), header(), d.h('p', {}, `Nothing changed. This email can sign in here from ${when}.`), d.h('p', { class: 'muted' }, 'You can close this window.')));
      settle('done');
      win.close();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel', attrs: { id: 'link-waiting' } },
        d.h('h1', {}, google ? 'A Google account is being linked to this email' : 'Another sign-in is being linked to this email'),
        header(),
        alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id: 'link-waiting-what' } }, `This email is being linked with ${other}, so both will open the same ${BRAND.company} wallet. The link starts working on ${when}. Until then, you can’t sign in here with this email.`),
        d.h('p', { attrs: { id: 'link-waiting-advice' } }, 'Didn’t do this? Cancel the link. We’ll send one more code to this email to check it’s you. If you’re not sure, cancel it.'),
        d.h('p', { class: 'muted', attrs: { id: 'link-waiting-keep' } }, `If you linked this email yourself, keep the link. This email opens that wallet from ${when}.`),
        d.h('div', { class: 'actions stack' }, cancelB, keepB),
      ),
    );
    notice = 'link_pending';
    settle('link_waiting');
  }

  /** What became of the cancel (the vault re-read the chain before it said so). */
  function showLinkCancel(n: Extract<FollowNotice, { t: 'link_cancel' }>, slot: number): void {
    // Too late to cancel: the member's own removal is offered here (D865), so the channel stays open for it.
    if (n.outcome !== 'now_active') endFollow();
    const app = () => d.h('strong', {}, ctx.appName);
    const codeLine = n.code ? d.h('p', { class: 'code' }, supportCode(n.code)) : null;
    const passwordAdvice = d.h('p', { attrs: { id: 'link-cancel-advice' } }, 'If you didn’t start this link, change your email password. Someone may have used a code from your mailbox.');
    let body: (HTMLElement | null)[];
    let title: string;
    switch (n.outcome) {
      case 'cancelled':
        title = 'Link cancelled';
        body = [alert(d, 'success', { class: 'note', attrs: { role: 'status', id: 'link-cancel-what' } }, `This email is no longer being linked with ${waitingOther}. Anyone signed in to that wallet will be asked to sign in again.`), passwordAdvice];
        break;
      case 'already_cancelled':
        title = 'This link was already cancelled';
        body = [alert(d, 'success', { class: 'note', attrs: { role: 'status', id: 'link-cancel-what' } }, `This email is no longer being linked with ${waitingOther}. There’s nothing more to do.`), passwordAdvice];
        break;
      case 'now_active':
        title = 'This link can’t be cancelled any more';
        body = [
          alert(d, 'danger', { class: 'note', attrs: { role: 'alert', id: 'link-cancel-what' } }, `The waiting period has ended: this email and ${waitingOther} now open the same wallet.`),
          d.h('p', { attrs: { id: 'link-cancel-advice' } }, 'If you didn’t set this up, don’t add money to it. Choose Remove this email below, and change your email password.'),
        ];
        break;
      case 'not_cancelled':
        title = 'The link wasn’t cancelled';
        body = [
          alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id: 'link-cancel-what' } }, 'Nothing changed: the link is still waiting.'),
          d.h('p', { attrs: { id: 'link-cancel-advice' } }, 'Close this window, then sign in to ', app(), ' with this email again to try again.'),
          codeLine,
        ];
        break;
      case 'unknown':
        title = 'We couldn’t check the link';
        body = [
          alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id: 'link-cancel-what' } }, `${BRAND.company} couldn’t be reached, so we can’t tell whether the link was cancelled.`),
          d.h('p', { attrs: { id: 'link-cancel-advice' } }, 'Sign in to ', app(), ' with this email again. If the link is still waiting, you’ll see the button to cancel it again.'),
          codeLine,
        ];
        break;
    }
    let actions: HTMLElement[] = [closeButton('link-cancel-close')];
    if (n.outcome === 'now_active') {
      const removeB = d.h('button', { class: `${BTN.danger} jp-btn-lg`, attrs: { type: 'button', id: 'link-active-remove' } }, 'Remove this email');
      const closeB = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'link-cancel-close' } }, 'Close');
      closeB.addEventListener('click', () => {
        endFollow();
        settle('done');
        win.close();
      });
      memberMethod = 'email';
      memberOther = waitingOther.replace(/^that /u, '');
      removeB.addEventListener('click', () => showMemberConfirm({ method: 'email', otherAccount: memberOther }, slot, () => showLinkCancel(n, slot)));
      actions = [removeB, closeB];
    }
    d.show(
      d.h(
        'section',
        { class: 'panel', attrs: { id: 'link-cancel-result', 'data-outcome': n.outcome } },
        d.h('h1', {}, title),
        header(),
        ...body,
        d.h('div', { class: n.outcome === 'now_active' ? 'actions stack' : 'actions' }, ...actions),
      ),
    );
    notice = n.code ?? n.outcome;
    settle('link_cancelled');
  }

  // ---- D865: an active member's own notice ----

  /** The device remembers that the user kept this link (D865): authOrigin's localStorage, the link's opaque id only. */
  const KEPT_PREFIX = 'hana.ml.';
  const keptHere = (linkId: string): boolean => {
    try {
      const v = deps.tickets?.getItem(KEPT_PREFIX + linkId);
      return v !== null && v !== undefined;
    } catch {
      return false;
    }
  };
  const keepHere = (linkId: string): void => {
    try {
      deps.tickets?.setItem(KEPT_PREFIX + linkId, String(now()));
    } catch {
      // Storage refused: the next sign-in on this device asks again.
    }
  };

  /** The words for this sign-in and the other one, by method. */
  const memberWords = (method: string, rootProvider: string) => {
    const self = method === 'google' ? 'Google account' : 'email';
    const other = rootProvider === 'google' ? 'Google account' : 'email';
    const article = (w: string) => (w === 'email' ? 'an email' : 'a Google account');
    return { self, other, otherA: article(other) };
  };

  /**
   * This sign-in opens a wallet that another sign-in (the wallet's first) also opens: whoever holds that one can open it
   * too. "Remove this email" goes to a confirmation that says what removing costs; "Not now" goes on with the sign-in
   * and stores nothing (asked again next time); the smaller "Don't ask again on this device" goes on and stores the
   * link's id. A link that may have been made automatically (`how: 'automatic'`) is told in words that don't push
   * removal, in a blue box, with Not now first and Remove not in red.
   */
  function showMemberLink(n: Extract<FollowNotice, { t: 'member_link' }>, slot: number): void {
    if (keptHere(n.linkId)) {
      void answer(slot, { choice: 'keep' });
      return;
    }
    const w = memberWords(n.method, n.rootProvider);
    memberMethod = n.method;
    memberOther = w.other;
    const since = dateText(n.sinceMs);
    const automatic = n.how === 'automatic';
    const removeB = d.h('button', { class: `${automatic ? BTN.secondary : BTN.danger} jp-btn-lg`, attrs: { type: 'button', id: 'member-remove' } }, `Remove this ${w.self}`);
    const notNowB = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'member-not-now' } }, 'Not now');
    const dontAskB = d.h('button', { class: 'link', attrs: { type: 'button', id: 'member-dont-ask' } }, 'Don’t ask again on this device');
    const all = [removeB, notNowB, dontAskB];
    let chosen = false;
    const go = (f: () => void) => () => {
      if (chosen) return;
      chosen = true;
      for (const b of all) b.setAttribute('disabled', '');
      f();
    };
    removeB.addEventListener('click', go(() => showMemberConfirm({ method: n.method, otherAccount: w.other }, slot, () => showMemberLink(n, slot))));
    notNowB.addEventListener('click', go(() => void answer(slot, { choice: 'keep' })));
    dontAskB.addEventListener(
      'click',
      go(() => {
        keepHere(n.linkId);
        void answer(slot, { choice: 'keep' });
      }),
    );
    d.show(
      d.h(
        'section',
        { class: 'panel', attrs: { id: 'member-link', 'data-how': n.how } },
        d.h('h1', {}, `This ${w.self} now also opens another wallet`),
        header(),
        alert(d, automatic ? 'info' : 'warning', { class: 'note', attrs: { role: automatic ? 'status' : 'alert', id: 'member-link-what' } }, `Since ${since}, this ${w.self} opens a wallet that ${w.otherA} also opens. Whoever holds that ${w.other} can open it too.`),
        d.h(
          'p',
          { attrs: { id: 'member-link-advice' } },
          automatic
            ? `This usually happens when that ${w.other} is your own Gmail or Google Workspace address. If you don’t recognise it, remove this ${w.self} from it.`
            : `If you didn’t set this up, remove this ${w.self} from it.`,
        ),
        d.h('div', { class: 'actions stack' }, ...(automatic ? [notNowB, removeB] : [removeB, notNowB])),
        d.h('p', { class: 'muted', attrs: { id: 'member-link-keep' } }, 'If you set this up yourself, you can choose Don’t ask again on this device.'),
        d.h('p', { class: 'muted links' }, dontAskB),
      ),
    );
    notice = 'member_link';
    settle('member_link');
  }

  /** Before removing: what it costs (the one thing it can't undo for this user), then "Remove it" or "Go back". */
  function showMemberConfirm(c: { method: string; otherAccount: string }, slot: number, onBack: () => void): void {
    const w = { self: c.method === 'google' ? 'Google account' : 'email', other: c.otherAccount };
    const go = d.h('button', { class: `${BTN.danger} jp-btn-lg`, attrs: { type: 'button', id: 'member-remove-confirm' } }, 'Remove it');
    const back = d.h('button', { class: `${BTN.secondary} jp-btn-lg`, attrs: { type: 'button', id: 'member-remove-back' } }, 'Go back');
    let chosen = false;
    go.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      go.setAttribute('disabled', '');
      back.setAttribute('disabled', '');
      void answer(slot, { choice: 'remove' });
    });
    back.addEventListener('click', () => {
      if (chosen) return;
      chosen = true;
      onBack();
    });
    d.show(
      d.h(
        'section',
        { class: 'panel', attrs: { id: 'member-confirm' } },
        d.h('h1', {}, `Remove this ${w.self} from that wallet?`),
        header(),
        alert(d, 'danger', { class: 'note', attrs: { role: 'alert', id: 'member-confirm-what' } }, `After you remove it, this ${w.self} can’t open that wallet any more. Anything in it stays there, and whoever holds that ${w.other} can still open it.`),
        d.h('p', { attrs: { id: 'member-confirm-money' } }, 'If you added money to that wallet, move it out first. Choose Go back, then Not now, and sign in to move it. You’ll be asked again next time.'),
        d.h('p', { attrs: { id: 'member-confirm-next' } }, `If you sign in with this ${w.self} again afterwards, it opens a new, empty wallet of its own.`),
        d.h('p', { class: 'muted', attrs: { id: 'member-confirm-check' } }, c.method === 'google' ? 'Google will ask you to sign in again to check it’s you.' : 'We’ll send one more code to this email to check it’s you.'),
        d.h('div', { class: 'actions stack' }, go, back),
      ),
    );
    notice = 'member_confirm';
    settle('member_confirm');
  }

  /** The removal's proof: one more code to the address this window just proved, or Google with the account named. */
  function proveMemberRemove(p: FollowProve, slot: number): void {
    if (p.method === 'email' && p.purpose === 'link_change' && validAddress(address)) {
      startAs = { kind: 'link', purpose: 'link_change', commitment: p.commitment };
      sink = { kind: 'answer', slot, as: 'proof' };
      void sendCode();
      return;
    }
    prove(p, slot, 'Confirm it’s you');
  }

  let memberMethod = 'email';
  let memberOther = 'Google account';

  /** What became of the removal (the vault re-read the chain before it said so). */
  function showMemberRemoved(n: Extract<FollowNotice, { t: 'member_removed' }>): void {
    endFollow();
    const app = () => d.h('strong', {}, ctx.appName);
    const self = memberMethod === 'google' ? 'Google account' : 'email';
    const codeLine = n.code ? d.h('p', { class: 'code' }, supportCode(n.code)) : null;
    const fresh = d.h('p', { attrs: { id: 'member-removed-next' } }, `If you sign in with this ${self} again, it opens a new, empty wallet of its own.`);
    let title: string;
    let body: (HTMLElement | null)[];
    switch (n.outcome) {
      case 'removed':
        title = `This ${self} was removed`;
        body = [
          alert(d, 'success', { class: 'note', attrs: { role: 'status', id: 'member-removed-what' } }, `This ${self} no longer opens that wallet. Anything in it stays there, with whoever holds that ${memberOther}. Anyone signed in to that wallet will be asked to sign in again.`),
          fresh,
          d.h('p', { attrs: { id: 'member-removed-advice' } }, `If you didn’t set up the link, change your ${self === 'email' ? 'email' : 'Google'} password.`),
        ];
        break;
      case 'already_removed':
        title = `This ${self} was already removed`;
        body = [alert(d, 'success', { class: 'note', attrs: { role: 'status', id: 'member-removed-what' } }, `This ${self} no longer opens that wallet. There’s nothing more to do.`), fresh];
        break;
      case 'not_removed':
        title = `This ${self} wasn’t removed`;
        body = [
          alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id: 'member-removed-what' } }, `Nothing changed: this ${self} still opens that wallet.`),
          d.h('p', { attrs: { id: 'member-removed-advice' } }, 'Close this window, then sign in to ', app(), ` with this ${self} again to try again.`),
          codeLine,
        ];
        break;
      case 'unknown':
        title = 'We couldn’t check the removal';
        body = [
          alert(d, 'warning', { class: 'note', attrs: { role: 'alert', id: 'member-removed-what' } }, `${BRAND.company} couldn’t be reached, so we can’t tell whether this ${self} was removed.`),
          d.h('p', { attrs: { id: 'member-removed-advice' } }, 'Sign in to ', app(), ` with this ${self} again. If it still opens that wallet, you’ll be asked again.`),
          codeLine,
        ];
        break;
    }
    d.show(d.h('section', { class: 'panel', attrs: { id: 'member-removed', 'data-outcome': n.outcome } }, d.h('h1', {}, title), header(), ...body, d.h('div', { class: 'actions' }, closeButton('member-removed-close'))));
    notice = n.code ?? n.outcome;
    settle('member_removed');
  }

  // ---- start ----

  if (!env.emailIssuerUrl) {
    void abandon('email_unavailable', 'Sign-in stopped', 'Email sign-in isn’t set up here.', 'config_mismatch');
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
