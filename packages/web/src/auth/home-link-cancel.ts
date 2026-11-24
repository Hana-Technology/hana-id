// Passport Home's "Cancel this link" (D902, D898 option B): one press on a waiting sign-in's row, then the
// confirmation, a fresh Google sign-in of the same account, one `POST /v1/home/link/cancel`, and its outcome, all in
// the row (home-sign-ins.ts mounts it). Only for a wallet on Journear's shared Google client, viewed by a Google sign-in
// that already opens it; every other row keeps D898 option A's link or the plain sentence.
//
// The steps, each of which can only stop with nothing sent to the API (fail closed):
//   1. "Cancel this link" asks first ("Cancel this link?", D898's words): Go back changes nothing;
//   2. "Cancel the link" opens the child `/login?mode=home` in the click (before any await), then, while it loads, reads
//      the wallet's ways to sign in again on both NEAR providers (they must agree, as the list's own read) and checks on
//      NEAR that the shared client still opens this wallet. The row must still be waiting, this sign-in still one that
//      opens the wallet, with the account's root and epoch as the chain has them now; otherwise "Nothing changed" and the
//      list shows what was just read;
//   3. the child gets `hana:home-cancel-params` (it recomputes the nonce) and Google signs the person in again
//      (`max_age=0`, the account chooser);
//   4. Google's answer comes back through the login relay; the token is checked against Google's keys, for the shared
//      client, this change's nonce, and the same account as Home's sign-in (never sent otherwise);
//   5. one `POST /v1/home/link/cancel`, never sent a second time by the page. Its answer picks the screen: "Link
//      cancelled", "Nothing changed" (refused before anything was sent, or refused by the contract, which reverts), or
//      "It may not have been cancelled" (anything else: "Show again" reads the list).
// The API checks all of it again, and the contract checks the proof itself (apps/api/src/home/link-cancel.ts).
//
// SECURITY: the Google token is held only until the request is sent, then dropped; the relay keys and the salt are
// zeroed. Nothing here is written to storage, a URL, a log or a message other than the child's parameters (public
// values and the relay key). Every text is a text node.
import {
  ApiError,
  EXPORT_MAX_AUTH_AGE_MS,
  type Jwk,
  RELAY_KEY_BYTES,
  type RelayReadResponse,
  type WindowMessage,
  base64UrlEncode,
  decryptRelayPayload,
  fromHex,
  isJsonFormToken,
  isRelayToken,
  linkChangeNonce,
  parseWindowMessage,
  randomBytes,
  relayIdFor,
  verifyGoogleIdToken,
} from '@hana-id/core';
import type { AuthApi } from './api.ts';
import type { ServerClock } from './clock.ts';
import { type Child, type Dom, supportCode } from './dom.ts';
import type { HomeApi, HomeConfig, HomeIdentity, HomeScope } from './home-api.ts';
import { plainProblem } from './home-problems.ts';
import type { NearReader } from './near-rpc.ts';
import { type GestureCheck, type PageWindow, randomName } from './page-window.ts';
import { BTN, alert } from './ui.ts';

/** The sign-in child's path and query: the same child as Hana Home's own sign-in, with another message. */
const LOGIN_CHILD = '/login?mode=home';
/** How long the page waits for Google's answer in the relay. */
export const HOME_CANCEL_LOGIN_LIMIT_MS = 5 * 60_000;
const RELAY_WAIT_S = 25;
const CHILD_WATCH_MS = 500;
const SALT_BYTES = 32;

/** The kind a waiting sign-in is named by in the flow's sentences. */
export type CancelKind = 'email' | 'google';
const KIND_WORDS: Readonly<Record<CancelKind, string>> = Object.freeze({ email: 'email address', google: 'Google account' });

/** Every sentence of the flow (D898's words for option B; D881's for what it reuses), in one place (plain-words check). */
export const CANCEL_TEXT = Object.freeze({
  lead: 'Don’t recognise it? If you’re not sure, cancel it.',
  button: 'Cancel this link',
  confirmTitle: 'Cancel this link?',
  confirmGo: 'Cancel the link',
  back: 'Go back',
  signInTitle: 'Sign in with Google to confirm it’s you',
  signInHint: 'A Google window is open. Choose the Google account you signed in with here.',
  workingTitle: 'Cancelling the link',
  working: 'This takes a few seconds…',
  doneTitle: 'Link cancelled',
  devices: 'Devices signed in to this wallet will be asked to sign in again.',
  nothingTitle: 'Nothing changed',
  stillWaiting: 'The link is still waiting.',
  changed: 'The ways to sign in to this wallet may have changed since this page showed them.',
  changedNext: 'Close this, then choose “Show again” to see them as they are now.',
  notYou: 'We couldn’t check it was you.',
  notYouGoogle: 'If you picked a different Google account, try again with the one you signed in with here.',
  notNow: 'Journear couldn’t do this just now. Try again later.',
  notChecked: 'Google didn’t finish checking it’s you.',
  unknownTitle: 'It may not have been cancelled',
  unknown: 'Something went wrong, so we can’t tell whether the link was cancelled. Choose “Show again” to check.',
  showAgain: 'Show again',
  close: 'Close',
});

/** The confirmation's sentence and the result's, for the waiting sign-in's kind. */
export const cancelConfirmText = (kind: CancelKind): string => `The ${KIND_WORDS[kind]} will never open this wallet. You can’t undo this: it can only be added again, and then it waits again.`;
export const cancelDoneText = (kind: CancelKind): string => `The ${KIND_WORDS[kind]} won’t open this wallet.`;
/** The button's accessible name (D887's form: whose link it cancels). */
export const cancelButtonName = (kind: CancelKind): string => `${CANCEL_TEXT.button} for the ${KIND_WORDS[kind]}`;

/**
 * Why nothing changed, by group: `you` (the proof wasn't this sign-in's, or couldn't be checked as it), `changed` (the
 * ways to sign in changed: the chain's rules refused it, or the contract did and reverted), `now` (refused before
 * anything was sent), `check` (the Google check didn't finish), `signed_out` (Home's own sign-in ended).
 */
export type NothingGroup = 'you' | 'changed' | 'now' | 'check' | 'signed_out';
export type CancelOutcome = { kind: 'nothing'; group: NothingGroup; code: string } | { kind: 'unknown'; code: string };

/** API codes that certainly relayed nothing, by group. Anything not listed (and every network failure) is `unknown`. */
const NOTHING_CODES: Readonly<Record<string, NothingGroup>> = Object.freeze({
  // The proof is not this sign-in's, or not one Home may use (refused before the relay).
  home_account_mismatch: 'you',
  invalid_token: 'you',
  token_invalid: 'you',
  wrong_audience: 'you',
  wrong_issuer: 'you',
  token_has_pii: 'you',
  not_shared_client: 'you',
  scope_mismatch: 'you',
  unregistered_client: 'you',
  google_only: 'you',
  // The chain's rules, prechecked (`link_refused`) or the contract's own state answer.
  link_refused: 'changed',
  link_pending: 'changed',
  // Refused before anything was relayed (the gate, the limits, the views), or a relay that certainly never ran.
  rate_limited: 'now',
  rate_limiter_unavailable: 'now',
  bad_request: 'now',
  token_expired: 'now',
  nonce_mismatch: 'now',
  near_unavailable: 'now',
  near_rejected: 'now',
  relayer_busy: 'now',
  relayer_unconfigured: 'now',
  method_not_allowed: 'now',
  links_unavailable: 'now',
  paused: 'now',
  issuer_key_pending: 'now',
  shared_login_disabled: 'now',
  unknown_scope: 'now',
  counter_reused: 'now',
  origin_not_allowed: 'now',
});

/** What an answer of `POST /v1/home/link/cancel` that wasn't a success means (fail closed: unknown unless certain). */
export function cancelOutcome(err: unknown): CancelOutcome {
  if (!(err instanceof ApiError)) return { kind: 'unknown', code: 'api_unavailable' };
  const code = /^[a-z][a-z0-9_]{0,63}$/u.test(err.code) ? err.code : 'error';
  // Every credential refusal of Home's own sign-in is a 401, before anything is read.
  if (err.status === 401) return { kind: 'nothing', group: 'signed_out', code };
  // A known rule of the contract refused it in its own receipt: reverted, so nothing changed (panics.ts, `reason`).
  if (code === 'contract_rejected' && typeof err.details.reason === 'string') return { kind: 'nothing', group: 'changed', code };
  const group = Object.hasOwn(NOTHING_CODES, code) ? NOTHING_CODES[code] : undefined;
  return group ? { kind: 'nothing', group, code } : { kind: 'unknown', code };
}

/** The lines of a "Nothing changed" screen: the state of the link, then why. */
export function nothingLines(group: NothingGroup, code: string): string[] {
  switch (group) {
    case 'you':
      return [CANCEL_TEXT.stillWaiting, CANCEL_TEXT.notYou, CANCEL_TEXT.notYouGoogle];
    case 'changed':
      return [CANCEL_TEXT.changed, CANCEL_TEXT.changedNext];
    case 'check':
      return [CANCEL_TEXT.stillWaiting, code === 'popup_blocked' ? plainProblem('popup_blocked').text : CANCEL_TEXT.notChecked];
    case 'signed_out':
      return [CANCEL_TEXT.stillWaiting, plainProblem('home_signed_out').text];
    case 'now':
      return [CANCEL_TEXT.stillWaiting, code === 'home_signing_in' ? plainProblem('home_signing_in').text : CANCEL_TEXT.notNow];
  }
}

/** What the flow knows of the row it cancels: its key and kind (never an address). */
export interface CancelRow {
  readonly key: string;
  readonly kind: CancelKind;
}

/** A fresh read of the wallet's ways to sign in, as the section's own read gives it. */
export type CancelRead =
  | { ok: true; rootKey: string; epoch: number; viewerKey: string; viewerActive: boolean; waiting: readonly string[] }
  | { ok: false; code: string };

export interface HomeLinkCancelDeps {
  win: PageWindow;
  d: Dom;
  /** This page's origin (the sign-in child's and Home's). */
  authOrigin: string;
  signer: string;
  api: Pick<HomeApi, 'linkCancel'>;
  relay: Pick<AuthApi, 'readRelay'>;
  near: Pick<NearReader, 'view'>;
  jwks: (kid: string) => Promise<Jwk | null>;
  clock: ServerClock;
  sleep: (ms: number) => Promise<void>;
  isGesture: GestureCheck;
  /** Hana Home's live Google sign-in, or null: its identity signs the request, its `sub` must be the proof's. */
  session: () => { identity: HomeIdentity; sub: string } | null;
  config: () => HomeConfig | null;
  /** Whether Hana Home's own sign-in child is open: one child at a time, and that one comes first. */
  signingIn: () => boolean;
  /** Reads the wallet's ways to sign in again (both providers, as the section does). */
  read: (scopeId: string) => Promise<CancelRead>;
  /** The link was cancelled: the section drops the row from what it shows and recounts its line. */
  cancelled: (scopeId: string, key: string) => void;
  /** The API refused Hana Home's sign-in itself (a 401). */
  onSignedOut: () => void;
  /** "Show again" on an outcome nobody can tell: the section reads the list again. */
  showAgain: () => void;
  /** Something on screen changed: the section draws again. */
  changed: () => void;
  track: (p: Promise<unknown>) => void;
}

export type HomeLinkCancelStage = 'confirm' | 'signing_in' | 'working' | 'done' | 'nothing' | 'unknown';

export interface HomeLinkCancel {
  readonly stage: HomeLinkCancelStage | null;
  readonly scopeId: string | null;
  readonly rowKey: string | null;
  readonly outcome: CancelOutcome | null;
  readonly childName: string | null;
  /** The shared Google client this wallet's cancel would use, or null when Home can't cancel here (then option A). */
  clientFor(scope: HomeScope): string | null;
  /** "Cancel this link" on a row: the confirmation. */
  ask(scope: HomeScope, row: CancelRow): void;
  /** The row's panel while the flow is on it, else null. */
  panel(scopeId: string, rowKey: string, i: number): HTMLElement | null;
  /** A message to the page: true when it was this flow's child's hello. */
  onMessage(e: MessageEvent): boolean;
  /** The user left the app's page: anything not yet sent ends (closed child, nothing sent); a request in flight runs on. */
  leave(): void;
  /** Signed out or another account: everything ends. */
  drop(): void;
}

interface Pending {
  scope: HomeScope;
  row: CancelRow;
  clientId: string;
  sub: string;
  identity: HomeIdentity;
  /** Set once the fresh read and the route check passed. */
  call: { rootKey: string; epoch: number; salt: Uint8Array; nonce: string } | null;
  relay: { id: string; key: Uint8Array; readKey: Uint8Array; params: WindowMessage<'hana:home-cancel-params'>; helloAccepted: boolean } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function startHomeLinkCancel(deps: HomeLinkCancelDeps): HomeLinkCancel {
  const { win, d, isGesture, clock } = deps;
  let stage: HomeLinkCancelStage | null = null;
  let scope: HomeScope | null = null;
  let row: CancelRow | null = null;
  let outcome: CancelOutcome | null = null;
  let pending: Pending | null = null;
  let child: Window | null = null;
  let childName: string | null = null;
  /** Raised whenever what is in progress is dropped: an answer from before it is thrown away. */
  let run = 0;

  const button = (label: string, id: string, onClick: () => void, o: { kind?: keyof typeof BTN; name?: string } = {}): HTMLButtonElement => {
    const b = d.h('button', { class: `${BTN[o.kind ?? 'secondary']} jp-btn-sm`, attrs: { type: 'button', id, ...(o.name ? { 'aria-label': o.name } : {}) } }, label);
    b.addEventListener('click', (e) => {
      if (isGesture(e)) onClick();
    });
    return b;
  };
  const focus = (id: string): void => {
    try {
      win.document.getElementById(id)?.focus();
    } catch {
      // Focus is a convenience.
    }
  };
  const show = (): void => {
    deps.changed();
    focus('home-sign-in-cancel-title');
  };

  function wipe(): void {
    if (pending) {
      pending.call?.salt.fill(0);
      if (pending.relay) {
        pending.relay.key.fill(0);
        pending.relay.readKey.fill(0);
        pending.relay.params.relayKey.fill(0);
        pending.relay.params.salt.fill(0);
      }
    }
    pending = null;
  }
  function closeChild(): void {
    try {
      child?.close();
    } catch {
      // Already closed.
    }
    child = null;
  }
  function end(): void {
    run += 1;
    wipe();
    closeChild();
    stage = null;
    scope = null;
    row = null;
    outcome = null;
  }
  /** Ends what is in progress on an outcome screen (nothing is sent after this). */
  function finish(o: CancelOutcome | 'done'): void {
    run += 1;
    wipe();
    closeChild();
    if (o === 'done') {
      stage = 'done';
      outcome = null;
    } else {
      stage = o.kind;
      outcome = o;
    }
    show();
  }
  const nothing = (group: NothingGroup, code: string): void => finish({ kind: 'nothing', group, code });

  function clientFor(s: HomeScope): string | null {
    if (s.coverage !== 'shared') return null;
    return s.googleClientId ?? deps.config()?.sharedGoogleClientId ?? null;
  }

  /** Whether the shared client still opens this wallet, read from NEAR by this page itself (the API only named it). */
  async function checkRoute(scopeId: string, clientId: string): Promise<'ok' | 'not_covered' | 'near_unreadable'> {
    try {
      const [onChain, config] = await Promise.all([deps.near.view(deps.signer, 'get_scope', { scope_id: scopeId }), deps.near.view(deps.signer, 'get_config', {})]);
      if (onChain === null) return 'not_covered';
      if (!isObj(onChain) || typeof onChain.allow_shared !== 'boolean' || !isObj(config) || !Array.isArray(config.shared_clients)) return 'near_unreadable';
      const listed = config.shared_clients.some((c) => Array.isArray(c) && c.length === 2 && c[0] === 'google' && c[1] === clientId);
      return onChain.allow_shared && listed ? 'ok' : 'not_covered';
    } catch {
      return 'near_unreadable';
    }
  }

  /** "Cancel the link": the child in the click, then the fresh read and the route while it loads. */
  function go(): void {
    if (stage !== 'confirm' || !scope || !row) return;
    if (deps.signingIn()) return nothing('now', 'home_signing_in');
    const live = deps.session();
    if (!live || !live.identity.usable) return nothing('signed_out', 'home_signed_out');
    const clientId = clientFor(scope);
    if (!clientId) return nothing('now', 'not_covered');
    run += 1;
    const mine = run;
    childName = randomName('hana-home-cancel-');
    child = win.open(`${deps.authOrigin}${LOGIN_CHILD}`, childName, 'popup,width=480,height=640');
    if (!child) return nothing('check', 'popup_blocked');
    stage = 'signing_in';
    const p: Pending = { scope, row, clientId, sub: live.sub, identity: live.identity, call: null, relay: null };
    pending = p;
    show();
    const opened = child;
    // A child closed before it connected: nothing was sent. After the hello the handle isn't watched, because Google's
    // pages may make it report `closed`; Go back and the time limit cover that.
    const watch = setInterval(() => {
      if (run !== mine || child !== opened || stage !== 'signing_in' || pending?.relay?.helloAccepted) {
        clearInterval(watch);
        return;
      }
      let closed = false;
      try {
        closed = opened.closed === true;
      } catch {
        closed = false;
      }
      if (closed) {
        clearInterval(watch);
        nothing('check', 'login_cancelled');
      }
    }, CHILD_WATCH_MS);
    deps.track(prepare(mine, p));
  }

  async function prepare(mine: number, p: Pending): Promise<void> {
    const [route, fresh] = await Promise.all([checkRoute(p.scope.scopeId, p.clientId), deps.read(p.scope.scopeId).catch((): CancelRead => ({ ok: false, code: 'sign_ins_unreadable' }))]);
    if (run !== mine || pending !== p) return;
    if (route !== 'ok') return nothing('now', route);
    if (!fresh.ok) return nothing('now', fresh.code);
    // The row must still be waiting in this sign-in's own wallet, and this sign-in one that opens it.
    if (!fresh.viewerActive || !fresh.waiting.includes(p.row.key) || fresh.rootKey === p.row.key) return nothing('changed', 'sign_ins_changed');
    const salt = randomBytes(SALT_BYTES);
    const nonce = linkChangeNonce(deps.signer, p.scope.scopeId, 'cancel', fromHex(fresh.rootKey), fromHex(p.row.key), fresh.epoch, salt);
    const relayKey = randomBytes(RELAY_KEY_BYTES);
    const readKey = randomBytes(32);
    const relayId = relayIdFor(readKey);
    const params: WindowMessage<'hana:home-cancel-params'> = {
      v: 1,
      t: 'hana:home-cancel-params',
      signer: deps.signer,
      clientId: p.clientId,
      scopeId: p.scope.scopeId,
      rootKey: fresh.rootKey,
      memberKey: p.row.key,
      epoch: fresh.epoch,
      salt: Uint8Array.from(salt),
      nonce,
      relayId,
      relayKey: Uint8Array.from(relayKey),
    };
    p.call = { rootKey: fresh.rootKey, epoch: fresh.epoch, salt, nonce };
    p.relay = { id: relayId, key: relayKey, readKey, params, helloAccepted: false };
  }

  /** Whether `w` is on this origin at the sign-in child's address. A window whose address can't be read isn't. */
  function childAtLogin(w: Window): boolean {
    try {
      return `${w.location.pathname}${w.location.search}` === LOGIN_CHILD;
    } catch {
      return false;
    }
  }

  function onMessage(e: MessageEvent): boolean {
    const p = pending;
    const r = p?.relay;
    if (!p || !r || r.helloAccepted || child === null || e.source !== child || e.origin !== deps.authOrigin) return false;
    if (!parseWindowMessage(e.data, ['hana:auth-hello'])) return false;
    if (!childAtLogin(child)) return true;
    r.helloAccepted = true;
    try {
      child.postMessage(r.params, deps.authOrigin);
    } catch {
      nothing('check', 'login_cancelled');
      return true;
    } finally {
      // postMessage cloned it; the page keeps only its own copy of the relay key, for the decrypt.
      r.params.relayKey.fill(0);
    }
    deps.track(awaitToken(p, run));
    return true;
  }

  /** Long-polls the relay for Google's answer, checks the token, then sends the one request (`send`). */
  async function awaitToken(p: Pending, mine: number): Promise<void> {
    const stale = () => run !== mine || pending !== p;
    const r = p.relay;
    const c = p.call;
    if (!r || !c) return;
    const limit = clock.now() + HOME_CANCEL_LOGIN_LIMIT_MS;
    const readKey = base64UrlEncode(r.readKey);
    let value: RelayReadResponse | null = null;
    while (value === null) {
      if (stale()) return;
      if (clock.now() > limit) return nothing('check', 'login_timeout');
      try {
        value = await deps.relay.readRelay(r.id, readKey, RELAY_WAIT_S);
      } catch (err) {
        if (stale()) return;
        // A slot that is gone or forbidden never recovers (nothing was sent to the API); anything else is the wait itself.
        if (err instanceof ApiError && (err.status === 410 || err.status === 403)) return nothing('check', 'token_invalid');
        await deps.sleep(1000);
      }
    }
    if (stale()) return;
    clock.sync(value.serverTimeMs);
    closeChild();
    stage = 'working';
    show();
    let token: string;
    try {
      const payload = await decryptRelayPayload(r.key, r.id, value).catch(() => null);
      if (stale()) return;
      if (payload === null) return nothing('check', 'token_invalid');
      if ('error' in payload) return nothing('check', payload.error === 'access_denied' ? 'login_cancelled' : 'google_error');
      if (!isRelayToken(payload) || payload.accessToken !== undefined || payload.access !== undefined || payload.caseB !== undefined || payload.as !== undefined || isJsonFormToken(payload.idToken)) {
        return nothing('you', 'token_invalid');
      }
      const checked = await verifyGoogleIdToken(payload.idToken, { clientId: p.clientId, nonce: c.nonce, nowMs: clock.now(), jwks: deps.jwks }).catch(() => null);
      if (stale()) return;
      if (checked === null) return nothing('now', 'api_unavailable');
      if (!checked.ok) return nothing('you', checked.code === 'token_has_pii' ? 'token_has_pii' : 'token_invalid');
      // Google sends no auth_time today even with max_age=0, so its absence is accepted; when present it must be fresh.
      if (checked.token.authTime !== null && checked.token.authTime * 1000 < clock.now() - EXPORT_MAX_AUTH_AGE_MS) return nothing('check', 'stale_sign_in');
      // The same Google account as Home's sign-in: checked here before anything is sent (the API checks it again).
      if (checked.token.sub !== p.sub) return nothing('you', 'home_account_mismatch');
      token = payload.idToken;
    } catch {
      if (!stale()) nothing('now', 'token_invalid');
      return;
    }
    await send(p, mine, token);
  }

  /** The one request. Its answer picks the screen; it is never sent again by the page. */
  async function send(p: Pending, mine: number, token: string): Promise<void> {
    const c = p.call;
    const live = deps.session();
    if (!c) return;
    if (!live || live.identity !== p.identity || !live.identity.usable || live.sub !== p.sub) return nothing('signed_out', 'home_signed_out');
    const body = { jwt: token, memberKey: p.row.key, epoch: c.epoch, salt: Array.from(c.salt), scopeId: p.scope.scopeId };
    try {
      await deps.api.linkCancel(p.identity, body);
    } catch (err) {
      body.jwt = '';
      if (run !== mine) return;
      const o = cancelOutcome(err);
      if (o.kind === 'nothing' && o.group === 'signed_out') deps.onSignedOut();
      return finish(o);
    }
    body.jwt = '';
    // The cancel is on chain: what the section shows changes even if the user has left this app's page meanwhile.
    deps.cancelled(p.scope.scopeId, p.row.key);
    if (run !== mine) return;
    finish('done');
  }

  /** The panel's heading, focusable (each step moves the focus to it). */
  const title = (text: string): HTMLElement => d.h('p', { class: 'home-confirm-title home-sign-in-cancel-title', attrs: { id: 'home-sign-in-cancel-title', tabindex: '-1' } }, text);

  function panel(scopeId: string, rowKey: string, i: number): HTMLElement | null {
    if (stage === null || !row || !scope || scope.scopeId !== scopeId || row.key !== rowKey) return null;
    const kind = row.kind;
    const id = `home-sign-in-cancel-${i}`;
    const box = (tone: 'warning' | 'success' | 'info', ...children: Child[]): HTMLElement =>
      alert(d, tone, { tag: 'div', class: 'home-sign-in-how home-sign-in-risk home-sign-in-cancel', attrs: { id, role: 'group', 'aria-labelledby': 'home-sign-in-cancel-title', 'data-stage': stage as string } }, ...children);
    const code = (c: string): HTMLElement => d.h('p', { class: 'code muted' }, supportCode(c));
    switch (stage) {
      case 'confirm':
        return box(
          'warning',
          title(CANCEL_TEXT.confirmTitle),
          d.h('p', {}, cancelConfirmText(kind)),
          d.h('p', { class: 'muted' }, CANCEL_TEXT.signInTitle),
          d.h(
            'div',
            { class: 'actions start' },
            button(CANCEL_TEXT.confirmGo, 'home-sign-in-cancel-go', go, { kind: 'danger' }),
            button(CANCEL_TEXT.back, 'home-sign-in-cancel-back', () => {
              end();
              deps.changed();
              focus(`home-sign-in-cancel-open-${i}`);
            }),
          ),
        );
      case 'signing_in':
        return box(
          'warning',
          title(CANCEL_TEXT.signInTitle),
          d.h('p', {}, CANCEL_TEXT.signInHint),
          d.h(
            'div',
            { class: 'actions start' },
            button(CANCEL_TEXT.back, 'home-sign-in-cancel-back', () => {
              // Nothing was sent yet: the child closes and the row is as it was.
              end();
              deps.changed();
              focus(`home-sign-in-cancel-open-${i}`);
            }),
          ),
        );
      case 'working':
        return box('info', title(CANCEL_TEXT.workingTitle), d.h('p', { class: 'muted', attrs: { role: 'status' } }, CANCEL_TEXT.working));
      case 'done':
        return box(
          'success',
          title(CANCEL_TEXT.doneTitle),
          d.h('p', { attrs: { id: 'home-sign-in-cancel-what' } }, cancelDoneText(kind)),
          d.h('p', {}, CANCEL_TEXT.devices),
          d.h('div', { class: 'actions start' }, button(CANCEL_TEXT.close, 'home-sign-in-cancel-close', closeResult)),
        );
      case 'nothing': {
        const o = outcome as Extract<CancelOutcome, { kind: 'nothing' }>;
        return box(
          'warning',
          title(CANCEL_TEXT.nothingTitle),
          ...nothingLines(o.group, o.code).map((t) => d.h('p', {}, t)),
          code(o.code),
          d.h('div', { class: 'actions start' }, button(CANCEL_TEXT.close, 'home-sign-in-cancel-close', closeResult)),
        );
      }
      case 'unknown':
        return box(
          'warning',
          title(CANCEL_TEXT.unknownTitle),
          d.h('p', {}, CANCEL_TEXT.unknown),
          code((outcome as CancelOutcome).code),
          d.h(
            'div',
            { class: 'actions start' },
            button(CANCEL_TEXT.showAgain, 'home-sign-in-cancel-again', () => {
              end();
              deps.showAgain();
            }),
            button(CANCEL_TEXT.close, 'home-sign-in-cancel-close', closeResult),
          ),
        );
    }
  }

  function closeResult(): void {
    end();
    deps.changed();
    focus('home-sign-ins-title');
  }

  return {
    get stage() {
      return stage;
    },
    get scopeId() {
      return scope?.scopeId ?? null;
    },
    get rowKey() {
      return row?.key ?? null;
    },
    get outcome() {
      return outcome;
    },
    get childName() {
      return childName;
    },
    clientFor,
    ask(s, r) {
      // One at a time: asking on another row ends what was open (nothing had been sent, or it already ended).
      if (stage === 'signing_in' || stage === 'working') return;
      end();
      scope = s;
      row = r;
      stage = 'confirm';
      show();
    },
    panel,
    onMessage,
    leave() {
      // A request in flight runs on: its outcome is shown when the user comes back, and the list changes either way.
      if (stage === 'working') return;
      end();
    },
    drop() {
      end();
    },
  };
}

/** The lead and the small outlined button of a row Home can cancel, before the flow starts on it (D887's look). */
export function cancelOffer(d: Dom, kind: CancelKind, i: number, onClick: (e: Event) => void, disabled: boolean): Child[] {
  const b = d.h('button', { class: `${BTN.secondary} jp-btn-sm home-sign-in-cancel-open`, attrs: { type: 'button', id: `home-sign-in-cancel-open-${i}`, 'aria-label': cancelButtonName(kind) } }, CANCEL_TEXT.button);
  if (disabled) b.setAttribute('disabled', '');
  b.addEventListener('click', onClick);
  return [d.h('p', {}, CANCEL_TEXT.lead), d.h('p', { class: 'home-sign-in-open-row' }, b)];
}
