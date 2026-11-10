// Hana Home's email sign-in (D463): the issuer's Home route and the two screens of a code (the address, then the code),
// for Hana Home's own sign-in (home-page.ts) and for opening one app's wallet (home-export.ts).
//
// The page calls the issuer itself (its own URL, D230: an address or a code never passes through the API Worker), from
// the auth origin the issuer's CORS allows. Hana Home is already on that origin, so it needs no child window and no relay
// for email, unlike Google, which must answer to a redirect URI.
//
// What is sent: `POST /v1/email/home/start` `{email, kind, commitment}`, where the commitment holds only the inputs the
// issuer computes the nonce from (the Home key, its end and salt; or the one-use session), never a nonce, and for a
// per-app code the Hana Home sign-in's own email token (`identity`); then the shared `resend` and `verify`. The issuer answers `verify` with the token alone: no device ticket (Hana Home keeps none)
// and no sealed address.
//
// SECURITY: the address and the code go to the issuer only. The address stays in the page's memory for the sign-in it
// was typed for (so opening a wallet sends its code to the same mailbox) and is dropped with it; the code is dropped
// once sent; the token is handed to the caller and kept by nobody here. Nothing is written to storage, a URL or a log.
import { ApiError, parseApiResponse } from '@hana-id/core';
import type { Fetch } from './api.ts';
import type { Dom } from './dom.ts';
import { issuerDetail } from './email-api.ts';
import { CHALLENGE_ID_RE } from './email-storage.ts';
import type { GestureCheck } from './page-window.ts';

export type HomeEmailKind = 'identity' | 'derive';

/** `kind: 'identity'`: what the Home nonce is made of. */
export interface HomeIdentityCommitment {
  homePublicKey: Uint8Array;
  expiresAtMs: number;
  salt: Uint8Array;
}

/** `kind: 'derive'`: the session the token opens (one use, key index 0). */
export interface HomeSessionCommitment {
  scopeId: string;
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  salt: Uint8Array;
}

export interface HomeChallenge {
  challengeId: string;
  expiresAtMs: number;
  resendAfterMs: number;
}

export interface HomeEmailApi {
  start(email: string, kind: 'identity', commitment: HomeIdentityCommitment): Promise<HomeChallenge>;
  /** `identity`: the Hana Home sign-in's own email token, which the issuer checks is this address's. */
  start(email: string, kind: 'derive', commitment: HomeSessionCommitment, identity: string): Promise<HomeChallenge>;
  resend(challengeId: string): Promise<HomeChallenge>;
  /** The email token (JWS JSON), or an ApiError with the issuer's code. */
  verify(challengeId: string, code: string): Promise<string>;
}

const bad = (what: string): ApiError => new ApiError(502, 'bad_response', `Unexpected ${what} response`, null, null);
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function challenge(body: Record<string, unknown>, what: string): HomeChallenge {
  const { challengeId, expiresAtMs, resendAfterMs } = body;
  if (typeof challengeId !== 'string' || !CHALLENGE_ID_RE.test(challengeId) || !isMs(expiresAtMs) || !isMs(resendAfterMs)) throw bad(what);
  return { challengeId, expiresAtMs, resendAfterMs };
}

export function homeEmailApi(issuerUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): HomeEmailApi {
  const base = `${new URL(issuerUrl).origin}/v1/email`;
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    parseApiResponse(
      await fetchFn(`${base}/${path}`, { method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  return {
    async start(email: string, kind: HomeEmailKind, c: HomeIdentityCommitment | HomeSessionCommitment, identity?: string): Promise<HomeChallenge> {
      const commitment =
        kind === 'identity'
          ? { homePublicKey: Array.from((c as HomeIdentityCommitment).homePublicKey), expiresAtMs: c.expiresAtMs, salt: Array.from(c.salt) }
          : { scopeId: (c as HomeSessionCommitment).scopeId, sessionPublicKey: Array.from((c as HomeSessionCommitment).sessionPublicKey), expiresAtMs: c.expiresAtMs, keyIndex: 0, maxUses: 1, salt: Array.from(c.salt) };
      return challenge(await post('home/start', { email, kind, commitment, ...(kind === 'derive' ? { identity } : {}) }), 'start');
    },
    async resend(challengeId) {
      return challenge(await post('resend', { challengeId }), 'resend');
    },
    async verify(challengeId, code) {
      const body = await post('verify', { challengeId, code });
      if (typeof body.idToken !== 'string' || !body.idToken.startsWith('{') || body.deviceTicket !== undefined || body.googleWallet !== undefined) throw bad('verify');
      return body.idToken;
    },
  } as HomeEmailApi;
}

/** An email token's claims, read without a signature check (the API checks it against the chain's keys), or null. */
export function emailTokenClaims(token: string): { iss: string; aud: string; sub: string; exp: number; nonce: string } | null {
  try {
    const t = JSON.parse(token) as { payload?: unknown };
    if (typeof t.payload !== 'string') return null;
    const p = t.payload;
    const json = atob(p.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (p.length % 4)) % 4));
    const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>;
    if (typeof c.iss !== 'string' || typeof c.aud !== 'string' || typeof c.sub !== 'string' || !Number.isSafeInteger(c.exp) || typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(c.nonce)) return null;
    return { iss: c.iss, aud: c.aud, sub: c.sub, exp: c.exp as number, nonce: c.nonce };
  } catch {
    return null;
  }
}

/** An email identity's `sub` (the issuer's `e1.` form). */
export const EMAIL_SUB_RE = /^e1\.[A-Za-z0-9_-]{43}$/u;

/** What an email code's screens say; the same sentences as the login popup's email step where they mean the same. */
export const HOME_EMAIL_TEXT = Object.freeze({
  invalidEmail: 'Enter a valid email address.',
  domain: 'Addresses on this domain can’t be used to sign in.',
  rateLimited: 'Too many attempts. Try again later.',
  unreachable: 'Hana’s email service can’t be reached right now. Try again in a moment.',
  unreachableStart: 'Hana’s email service can’t be reached right now. A code may already be on its way: if you try again, use the newest code.',
  expired: 'This code expired or can’t be used any more. Send a new code.',
  noTries: 'That code is wrong, and this attempt has no tries left. Send a new code.',
  wrong: (left: number | null) => (left === null ? 'That code is wrong. Check the mail and try again.' : `That code is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left.`),
  resendLimit: 'No more codes can be sent for this attempt. Try again later.',
  resendWait: 'Wait a few seconds before asking for another code.',
  newCode: 'A new code is on its way. The old one no longer works.',
  typeCode: 'Enter the 6-digit code from the mail.',
  failed: (code: string) => `Something went wrong (${code}). Try again.`,
});

export const CODE_RE = /^\d{6}$/u;

const RESEND_WAIT_MAX_MS = 60_000;

/** Where an email code's steps are. */
export type HomeEmailStage = 'address' | 'sending' | 'code' | 'verifying' | 'done' | 'stopped';

/** Why the steps ended without a token: a refusal the user can't fix here (the email route is off, or not for this app). */
export interface HomeEmailStop {
  code: string;
}

export interface HomeEmailStepDeps {
  d: Dom;
  /** Where the screens go: the step replaces this element's content. */
  root: HTMLElement;
  isGesture: GestureCheck;
  now: () => number;
  /** The heading of the first screen. */
  title: string;
  /** What the first screen says above the field (or with a fixed address, above the "Send code" button). */
  intro: string;
  /** The address to use, fixed (opening a wallet uses the sign-in's own); null: the user types it. */
  address: string | null;
  /** The issuer's `start` for this step's commitment. */
  start: (address: string) => Promise<HomeChallenge>;
  api: Pick<HomeEmailApi, 'resend' | 'verify'>;
  /** The code was right: the token, and the address it was for. */
  onToken: (token: string, address: string) => void;
  /** A refusal that ends the steps (the screen says it; the caller decides what comes next). */
  onStop: (stop: HomeEmailStop) => void;
  onCancel: () => void;
  /** An id prefix for the screen's elements, so two steps on one page don't clash. */
  ids: string;
}

export interface HomeEmailStep {
  readonly stage: HomeEmailStage;
  /** The code of the notice on screen, or null. */
  readonly notice: string | null;
  /** Ends the steps (a sign-out, a newer attempt): nothing more is sent, and an answer still on its way is dropped. */
  end(): void;
}

/** The issuer's codes that mean "email can't do this here right now": nothing the user can fix. */
const STOPS = new Set(['home_email_unavailable', 'not_covered', 'home_identity_invalid', 'origin_not_allowed', 'bad_request']);

/**
 * An email code's screens: the address (unless fixed), then the code, with "Resend code", "Use a different email" (when
 * the address isn't fixed) and Cancel. Each button acts only on a real click; nothing is sent again by the step itself.
 */
export function homeEmailStep(deps: HomeEmailStepDeps): HomeEmailStep {
  const { d, root, isGesture, now, ids } = deps;
  let stage: HomeEmailStage = 'address';
  let notice: string | null = null;
  let address = deps.address ?? '';
  let challengeId: string | null = null;
  let resendTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  /** Raised by each request and by `end`: an answer to an older one is dropped. */
  let turn = 0;

  const id = (name: string) => `${ids}-${name}`;
  const show = (...children: (HTMLElement | null)[]): void => {
    root.replaceChildren();
    for (const c of children) if (c) root.append(c);
  };
  const button = (label: string, name: string, onClick: () => void, cls?: string, type: 'button' | 'submit' = 'button'): HTMLButtonElement => {
    const b = d.h('button', { ...(cls ? { class: cls } : {}), attrs: { type, id: id(name) } }, label);
    if (type === 'button')
      b.addEventListener('click', (e) => {
        if (isGesture(e)) onClick();
      });
    return b;
  };
  // The login popup's email step's notice (a `note` line, "Try again" in it when the service didn't answer).
  const message = (text: string | null, retry?: () => void): HTMLElement | null =>
    text ? d.h('p', { class: 'note', attrs: { role: 'alert', id: id('notice') } }, text, ...(retry ? [' ', button('Try again', 'retry', retry, 'link')] : [])) : null;
  const heading = (text: string) => d.h('h3', { attrs: { id: id('title'), tabindex: '-1' } }, text);
  const focus = (el: HTMLElement): void => {
    try {
      el.focus();
    } catch {
      // Focus is a convenience.
    }
  };
  const cancel = () => button('Cancel', 'cancel', () => {
    if (ended) return;
    end();
    deps.onCancel();
  });

  function end(): void {
    ended = true;
    turn += 1;
    clearTimeout(resendTimer);
    challengeId = null;
  }

  function showAddress(problem: string | null = null, retry?: () => void): void {
    clearTimeout(resendTimer);
    stage = 'address';
    if (deps.address !== null) {
      // A fixed address: one button sends the code to it.
      show(
        heading(deps.title),
        d.h('p', {}, deps.intro),
        d.h('p', {}, 'The code goes to ', d.h('strong', { attrs: { id: id('to') } }, deps.address), '.'),
        message(problem, retry),
        d.h('div', { class: 'actions start' }, button('Send code', 'send', () => void send(), 'primary'), cancel()),
      );
      return;
    }
    const input = d.h('input', { attrs: { type: 'email', id: id('address'), name: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: '', maxlength: '254' } });
    input.value = address;
    const go = button('Send code', 'send', () => {}, 'primary', 'submit');
    const form = d.h('form', { attrs: { novalidate: '' } }, d.h('label', { attrs: { for: id('address') } }, 'Email address', input), message(problem, retry), d.h('div', { class: 'actions start' }, go, cancel()));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      // A submit from the keyboard or the button, never one a script made.
      if (!isGesture(e)) return;
      address = input.value.trim();
      void send();
    });
    show(heading(deps.title), d.h('p', {}, deps.intro), form);
    focus(input);
  }

  function showCode(resendAfterMs: number, problem: string | null = null, retry?: 'verify' | 'resend', typed?: string): void {
    stage = 'code';
    const input = d.h('input', { attrs: { type: 'text', id: id('code'), name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: '' } });
    if (typed) input.value = typed;
    const resend = button('Resend code', 'resend', () => void resendCode(), 'link');
    resend.setAttribute('disabled', '');
    const submit = () => {
      const code = input.value.replace(/\s+/gu, '');
      if (!CODE_RE.test(code)) return showCode(resendAfterMs, HOME_EMAIL_TEXT.typeCode);
      void verify(code, resendAfterMs);
    };
    const form = d.h(
      'form',
      { attrs: { novalidate: '' } },
      d.h('p', {}, 'We sent a 6-digit code to ', d.h('strong', { attrs: { id: id('to') } }, address), '. Type it here, on this Hana page only.'),
      d.h('label', { attrs: { for: id('code') } }, 'Code', input),
      message(problem, retry === 'verify' ? submit : retry === 'resend' ? () => void resendCode() : undefined),
      d.h('div', { class: 'actions start' }, button('Continue', 'verify', () => {}, 'primary', 'submit'), cancel()),
      d.h('p', { class: 'muted links' }, resend, ...(deps.address === null ? [' · ', button('Use a different email', 'other', () => {
        challengeId = null;
        notice = null;
        showAddress();
      }, 'link')] : [])),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!isGesture(e)) return;
      submit();
    });
    clearTimeout(resendTimer);
    resendTimer = setTimeout(() => resend.removeAttribute('disabled'), Math.min(RESEND_WAIT_MAX_MS, Math.max(0, resendAfterMs - now())));
    show(heading('Check your email'), form);
    focus(input);
  }

  function busy(title: string, text: string, s: HomeEmailStage): void {
    stage = s;
    show(heading(title), d.h('p', { class: 'muted', attrs: { role: 'status' } }, text));
  }

  function stop(code: string): void {
    end();
    stage = 'stopped';
    notice = code;
    deps.onStop({ code });
  }

  /** The issuer's refusal as this step's notice: a sentence, and whether "Try again" can help (the service didn't answer). */
  function problemOf(err: unknown): { code: string; text: string; transient: boolean } | 'stop' {
    if (!(err instanceof ApiError)) return { code: 'api_unavailable', text: HOME_EMAIL_TEXT.unreachable, transient: true };
    if (err.status === 429) return err.code === 'resend_limit' ? { code: 'resend_limit', text: HOME_EMAIL_TEXT.resendLimit, transient: false } : { code: 'rate_limited', text: HOME_EMAIL_TEXT.rateLimited, transient: false };
    if (STOPS.has(err.code)) return 'stop';
    if (err.status >= 500) return { code: 'api_unavailable', text: HOME_EMAIL_TEXT.unreachable, transient: true };
    return { code: err.code, text: HOME_EMAIL_TEXT.failed(err.code), transient: false };
  }

  async function send(): Promise<void> {
    if (ended) return;
    if (address.length < 3 || address.length > 254 || !address.includes('@') || /\s/u.test(address)) {
      notice = 'invalid_email';
      return showAddress(HOME_EMAIL_TEXT.invalidEmail);
    }
    const mine = ++turn;
    busy(deps.title, 'Sending a code…', 'sending');
    try {
      const c = await deps.start(address);
      if (mine !== turn) return;
      challengeId = c.challengeId;
      notice = null;
      showCode(c.resendAfterMs);
    } catch (err) {
      if (mine !== turn) return;
      if (err instanceof ApiError && err.code === 'invalid_email') {
        notice = 'invalid_email';
        return showAddress(HOME_EMAIL_TEXT.invalidEmail);
      }
      if (err instanceof ApiError && err.code === 'email_domain_not_allowed') {
        notice = 'email_domain_not_allowed';
        return showAddress(HOME_EMAIL_TEXT.domain);
      }
      const p = problemOf(err);
      if (p === 'stop') return stop((err as ApiError).code);
      notice = p.code;
      showAddress(p.code === 'api_unavailable' ? HOME_EMAIL_TEXT.unreachableStart : p.text, p.transient ? () => void send() : undefined);
    }
  }

  async function resendCode(): Promise<void> {
    if (ended || !challengeId) return;
    const mine = ++turn;
    busy('Check your email', 'Sending a new code…', 'sending');
    try {
      const c = await deps.api.resend(challengeId);
      if (mine !== turn) return;
      challengeId = c.challengeId;
      notice = null;
      showCode(c.resendAfterMs, HOME_EMAIL_TEXT.newCode);
    } catch (err) {
      if (mine !== turn) return;
      if (err instanceof ApiError && err.code === 'challenge_expired') {
        challengeId = null;
        notice = 'challenge_expired';
        return showAddress(HOME_EMAIL_TEXT.expired);
      }
      const after = err instanceof ApiError && err.status === 429 && err.code === 'rate_limited' ? issuerDetail(err, 'resendAfterMs') : null;
      if (after !== null) {
        notice = 'resend_wait';
        return showCode(after, HOME_EMAIL_TEXT.resendWait);
      }
      const p = problemOf(err);
      if (p === 'stop') return stop((err as ApiError).code);
      notice = p.code;
      showCode(now() + RESEND_WAIT_MAX_MS, p.text, p.transient ? 'resend' : undefined);
    }
  }

  async function verify(code: string, resendAfterMs: number): Promise<void> {
    if (ended || !challengeId) return;
    const mine = ++turn;
    busy('Check your email', 'Checking the code…', 'verifying');
    let token: string;
    try {
      token = await deps.api.verify(challengeId, code);
    } catch (err) {
      if (mine !== turn) return;
      if (err instanceof ApiError && err.code === 'code_invalid') {
        const left = issuerDetail(err, 'attemptsLeft');
        notice = 'code_invalid';
        if (left === 0) {
          challengeId = null;
          return showAddress(HOME_EMAIL_TEXT.noTries);
        }
        return showCode(resendAfterMs, HOME_EMAIL_TEXT.wrong(left));
      }
      if (err instanceof ApiError && err.code === 'challenge_expired') {
        challengeId = null;
        notice = 'challenge_expired';
        return showAddress(HOME_EMAIL_TEXT.expired);
      }
      const p = problemOf(err);
      if (p === 'stop') return stop((err as ApiError).code);
      notice = p.code;
      return showCode(resendAfterMs, p.text, p.transient ? 'verify' : undefined, code);
    }
    if (mine !== turn) return;
    end();
    stage = 'done';
    notice = null;
    deps.onToken(token, address);
  }

  showAddress();
  return {
    get stage() {
      return stage;
    },
    get notice() {
      return notice;
    },
    end,
  };
}

