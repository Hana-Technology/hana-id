// Passport Home's "Ways to sign in" (D874; home-page.ts mounts it on each app's page): every sign-in that opens the
// user's wallet in that app (a Google account, an email address), which one they are signed in with now, how each
// was added, a link still waiting to start, and where each can be cancelled or removed.
//
// READ ONLY, by design (D874, D619): Passport Home can't cancel or remove a sign-in. The contract wants a fresh token of
// the acting sign-in whose nonce commits to that one change (`link_change`), relayed by `POST /v1/link/cancel` or
// `/unlink`. Those relays are app-gated (a publishable key, and a partner origin of that app in
// `x-hana-parent-origin`), which Home has neither of, and the email issuer's Home route mints only Home's own
// `identity` and `derive` codes, never a `link_change` one. Doing it here needs an API and an issuer change (a Home
// route behind Home's gate for both), which D874 left to the founder. So each line says where the change can be made
// today: the sign-in window's banners (D259: Cancel by any active sign-in; Remove by the wallet's own sign-in, at every
// sign-in for 7 days, then until Done is pressed on it in that browser, D875), the waiting email's own sign-in (D864), and the member's own
// sign-in (D865). A line never points to a change the contract would refuse (`mayCancel`, `mayRemove`: links.rs
// `cancel_link`, `unlink_identity`).
//
// The chain is read only when the user asks ("Show ways to sign in"): `get_identity` and `get_account` of the signed-in
// identity in that app's scope, on each of the env's two NEAR providers alone (`rpc` and `rpcFallback`, D263's
// `independent()`), all four side by side, at most `SIGN_INS_READ_LIMIT_MS` in all. The list is shown only when both
// providers answer and describe the same list; one down, no second provider, or any difference is a failed read, never
// a partial list (D874 as amended: one lying or stale provider could otherwise hide an added sign-in). A confirmed
// answer is kept in memory for this Home sign-in, per app, so going back to an app reads nothing; "Show again" reads
// again; a failed read is never kept. Nothing is written to storage, a URL or a log.
//
// PRIVACY: the chain holds identity keys (hashes) for the sign-ins added to a wallet, and the wallet's own sign-in as
// `(provider, sub)`, whose `sub` is Google's number or the email issuer's pseudonymous `e1.` id: never an address.
// So the only address shown is the one this Home sign-in typed (held in memory, masked once the sign-in ends, D689);
// every other sign-in is named by its kind only ("Another email address", "A Google account") with its dates. Nothing
// here looks an address up.
//
// SECURITY: every text is a text node (dom.ts). The views are checked against each other and against the identity key
// computed here, so an answer about another identity or a half-made account reads as a failed read, never as a list;
// dates past the year 9999 too (a date the page can't write would break it). Both providers must agree on the list.
import { type AccountView, type IdentityView, ViewShapeError, identityKeyHex, isRecentLink, parseAccountView, parseIdentityView } from '@hana-id/core';
import { type Child, type Dom, addressText, maskedAddress, supportCode } from './dom.ts';
import { plainProblem } from './home-problems.ts';
import type { HomeScope } from './home-api.ts';
import type { NearReader } from './near-rpc.ts';
import type { GestureCheck, PageWindow } from './page-window.ts';
import { BTN, alert, icon } from './ui.ts';

export const HOME_SIGN_INS_TITLE = 'Ways to sign in';
/** The whole read (both views, a fallback included) ends within this, else it reads as failed. */
export const SIGN_INS_READ_LIMIT_MS = 20_000;
/** A failed read's codes, for support: a provider didn't answer in time (or there is no second one); the answers disagree or don't hold together. */
export const SIGN_INS_UNREADABLE = 'sign_ins_unreadable';
export const SIGN_INS_DISPUTED = 'sign_ins_disputed';
/** The last moment a date may name (9999-12-31T23:59:59.999Z): beyond it a view is refused, as the page couldn't write it. */
export const SIGN_IN_MAX_MS = 253_402_300_799_999;

// ---- what the chain says, as rows ----

export type SignInKind = 'google' | 'email' | 'other';
/** `first`: the wallet was made with it (the account's root); `member`: it opens this wallet too; `waiting`: pending. */
export type SignInRole = 'first' | 'member' | 'waiting';

export interface SignInRow {
  /** Identity key (hex): kept in memory to tell rows apart, never shown. */
  readonly key: string;
  readonly kind: SignInKind;
  readonly role: SignInRole;
  /** This Home sign-in. */
  readonly you: boolean;
  /** `member`: since when it opens the wallet; `waiting`: when it starts to; `first`: null (the chain has no date). */
  readonly sinceMs: number | null;
  /** Members and waiting ones: made at a sign-in (`Member.auto`) or by hand (`linkAccount`); `first`: null. */
  readonly auto: boolean | null;
}

/** Who is looking: their key and where they stand in this wallet. */
export interface SignInViewer {
  readonly key: string;
  readonly role: SignInRole;
  readonly kind: SignInKind;
}

export type SignInModel = { readonly state: 'no_wallet' } | { readonly state: 'list'; readonly viewer: SignInViewer; readonly rows: readonly SignInRow[] };

const kindOf = (provider: string): SignInKind => (provider === 'google' || provider === 'email' ? provider : 'other');

/**
 * The rows for `me` in `scopeId`, from its own `get_identity` and `get_account`. Throws ViewShapeError when the two
 * views don't describe one account with `me` in it (another identity's answer, a half-made account): the page then
 * says the read failed. The signed-in sign-in comes first, then the wallet's own, then the others by date.
 */
export function signInModel(scopeId: string, me: { provider: string; sub: string }, identity: IdentityView, account: AccountView | null): SignInModel {
  const myKey = identityKeyHex(scopeId, me.provider, me.sub);
  if (identity.key !== myKey) throw new ViewShapeError('get_identity key');
  if (identity.status === 'own') {
    if (account === null) return identity.opened ? { state: 'list', viewer: { key: myKey, role: 'first', kind: kindOf(me.provider) }, rows: [{ key: myKey, kind: kindOf(me.provider), role: 'first', you: true, sinceMs: null, auto: null }] } : { state: 'no_wallet' };
    if (account.root.provider !== me.provider || account.root.sub !== me.sub) throw new ViewShapeError('get_account root');
  } else {
    const root = identity.root;
    if (account === null || root === null || account.root.provider !== root.provider || account.root.sub !== root.sub) throw new ViewShapeError('get_account root');
    const mine = account.members.find((m) => m.key === myKey);
    if (!mine || mine.active !== (identity.status === 'member')) throw new ViewShapeError('get_account member');
  }
  if (account.members.some((m) => m.effectiveAtMs > SIGN_IN_MAX_MS)) throw new ViewShapeError('get_account effective_at_ms');
  const rootKey = identityKeyHex(scopeId, account.root.provider, account.root.sub);
  const keys = new Set([rootKey, ...account.members.map((m) => m.key)]);
  if (keys.size !== account.members.length + 1) throw new ViewShapeError('get_account keys');
  const rootRow: SignInRow = { key: rootKey, kind: kindOf(account.root.provider), role: 'first', you: rootKey === myKey, sinceMs: null, auto: null };
  const members: SignInRow[] = account.members
    .map((m) => ({ key: m.key, kind: kindOf(m.provider), role: (m.active ? 'member' : 'waiting') as SignInRole, you: m.key === myKey, sinceMs: m.effectiveAtMs, auto: m.auto }))
    .sort((a, b) => (a.sinceMs ?? 0) - (b.sinceMs ?? 0));
  const all = [rootRow, ...members];
  const you = all.find((r) => r.you) as SignInRow;
  return { state: 'list', viewer: { key: myKey, role: you.role, kind: you.kind }, rows: [you, ...all.filter((r) => !r.you)] };
}

// ---- the contract's rules (links.rs; contracts/hana-signer/src/tests/email.rs "Cancel and unlink") ----

/**
 * `cancel_link`: a waiting sign-in can be cancelled by itself, or by any sign-in that already opens the wallet (the
 * wallet's own, or one added to it). Never by another waiting one, never once it has started (then it is a removal).
 */
export function mayCancel(viewer: SignInViewer, row: SignInRow): boolean {
  if (row.role !== 'waiting') return false;
  if (row.key === viewer.key) return true;
  return viewer.role === 'first' || viewer.role === 'member';
}

/**
 * `unlink_identity`: a sign-in that opens the wallet can be removed by the wallet's own sign-in, or by itself. Never
 * by another added sign-in, never a waiting one (that is a cancel), and never the wallet's own sign-in (its path is
 * the wallet), so a wallet always keeps at least one way in.
 */
export function mayRemove(viewer: SignInViewer, row: SignInRow): boolean {
  if (row.role !== 'member') return false;
  return row.key === viewer.key || viewer.role === 'first';
}

/** Where a change the contract allows can be made today (none of them in Passport Home), or why there is none. */
export type SignInPointer =
  /** D864: the waiting email's own sign-in offers "Cancel this link". */
  | { readonly kind: 'cancel_own_email' }
  /** The contract allows a waiting Google account to cancel itself, but no window offers it. */
  | { readonly kind: 'cancel_own_none' }
  /** D259: the sign-in window's banner offers "Cancel this link" to every sign-in that opens the wallet. */
  | { readonly kind: 'cancel_at_sign_in' }
  /** D865: the member's own sign-in asks first, with "Remove this email" / "Remove this Google account". */
  | { readonly kind: 'remove_own' }
  /** D259: the banner offers the wallet's own sign-in "Remove it" (D887) at every sign-in for 7 days after it started. */
  | { readonly kind: 'remove_at_sign_in' }
  /** D875: after those 7 days, a quiet line with "Remove it" (D887), until Done is pressed on it in that browser. */
  | { readonly kind: 'remove_at_sign_in_once' }
  /** The contract refuses this viewer (another added sign-in). */
  | { readonly kind: 'not_yours' };

/** The pointer for one row, or null (the wallet's own sign-in, which can't be removed; or a viewer still waiting). */
export function pointerFor(viewer: SignInViewer, row: SignInRow, nowMs: number): SignInPointer | null {
  if (row.role === 'first') return null;
  if (row.role === 'waiting') {
    if (!mayCancel(viewer, row)) return null;
    if (row.key === viewer.key) return { kind: row.kind === 'email' ? 'cancel_own_email' : 'cancel_own_none' };
    return { kind: 'cancel_at_sign_in' };
  }
  if (viewer.role === 'waiting') return null;
  if (!mayRemove(viewer, row)) return { kind: 'not_yours' };
  if (row.key === viewer.key) return { kind: 'remove_own' };
  // The same 7 days, on the same rule, as the sign-in window's (core relay.ts).
  return isRecentLink(row.sinceMs ?? 0, nowMs) ? { kind: 'remove_at_sign_in' } : { kind: 'remove_at_sign_in_once' };
}

// ---- what the page says (D853: plain words) ----

/** Every fixed sentence of the section, in one place (the plain-words check reads this file). */
export const SIGN_IN_TEXT = Object.freeze({
  intro: 'The sign-ins that open your wallet in this app.',
  show: 'Show ways to sign in',
  loading: 'Checking the ways to sign in…',
  again: 'Show again',
  retry: 'Try again',
  failed: 'Passport Home couldn’t confirm the ways to sign in, so it shows none. Nothing was changed. Try again in a moment.',
  noWallet: 'You don’t have a wallet in this app yet.',
  youBadge: 'You’re signed in with this now',
  waitingBadge: 'Waiting',
  yourGoogle: 'Your Google account',
  otherEmail: 'Another email address',
  otherGoogle: 'A Google account',
  otherKind: 'Another way to sign in',
  first: 'The wallet was made with this sign-in, so it can’t be removed.',
  autoGoogle: 'Added automatically at a sign-in, because this Google account uses the same email address as this wallet.',
  autoEmail: 'Added at a sign-in, after a code was sent to this email address.',
  byHand: 'Added by hand in the app, after both sign-ins were checked.',
  shared: 'Each of these opens the same wallet, or will once it stops waiting. Anyone who can sign in with one of them can use the money in it.',
  readOnly: 'Passport Home can show these, but can’t cancel or remove them yet.',
  privacy: 'Journear doesn’t show the addresses of your other sign-ins, only what kind they are.',
  cancelOwnEmail: 'Didn’t set this up? Sign in to this app with this email and choose “Cancel this link”. If you’re not sure, cancel it.',
  cancelOwnNone: 'Only the email this wallet was made with can cancel this. If you didn’t set this up, don’t add money to that wallet.',
  cancelAtSignIn: 'Don’t recognise it? Sign in to this app the way you signed in here, and choose “Cancel this link”. If you’re not sure, cancel it.',
  removeAtSignIn: 'Don’t recognise it? Sign in to this app the way you signed in here, and choose “Remove it”. If you’re not sure, remove it.',
  /** An automatic same-address Google link (D865's softer words: nothing pushes its removal). */
  removeAtSignInAuto: 'Don’t recognise this Google account? Sign in to this app the way you signed in here, and choose “Remove it”.',
  removeAtSignInOnceNotOffered: 'Once you press “Done” in the sign-in window, that browser stops offering to remove it. Not offered? Try signing in in a private window.',
  notYours: 'Only the sign-in this wallet was made with, or this sign-in itself, can remove it.',
  removeOwnNotAsked: 'Not asked? Try signing in in a private window. If this was added automatically because both use the same address, you won’t be asked.',
  signOutFirst: 'If you’re already signed in to this app, sign out of it first.',
  removeOwnMoney: 'If you added money to this wallet, move it out first. It stays in this wallet.',
});

/** Dates as the device's locale writes them, with the time (a link waits 24 hours). */
export function signInDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  } catch {
    try {
      return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    } catch {
      return 'a date Passport Home can’t show';
    }
  }
}

/** How a row is named: the signed-in one in full (Google: "Your Google account"), every other by its kind only. */
export function rowName(row: SignInRow, address: string | null): string {
  if (row.you) return row.kind === 'email' && address ? address : row.kind === 'google' ? SIGN_IN_TEXT.yourGoogle : row.kind === 'email' ? 'Your email address' : SIGN_IN_TEXT.otherKind;
  return row.kind === 'email' ? SIGN_IN_TEXT.otherEmail : row.kind === 'google' ? SIGN_IN_TEXT.otherGoogle : SIGN_IN_TEXT.otherKind;
}

/** The facts of a row: since when, or from when; how it was added. */
export function rowFacts(row: SignInRow): string[] {
  if (row.role === 'first') return [SIGN_IN_TEXT.first];
  const when = row.sinceMs === null ? null : signInDate(row.sinceMs);
  const out = [row.role === 'member' ? `Opens this wallet since ${when}.` : `Starts opening this wallet on ${when}. Until then, it can’t be used to sign in to this app.`];
  out.push(row.auto === false ? SIGN_IN_TEXT.byHand : row.kind === 'google' ? SIGN_IN_TEXT.autoGoogle : row.kind === 'email' ? SIGN_IN_TEXT.autoEmail : SIGN_IN_TEXT.byHand);
  return out;
}

/** What a pointer says, in order: `lines` (the main sentence first). `risk`: shown in the amber box. */
export function pointerText(p: SignInPointer, row: SignInRow): { lines: string[]; risk: boolean } {
  const removeLabel = row.kind === 'email' ? 'Remove this email' : 'Remove this Google account';
  switch (p.kind) {
    case 'cancel_own_email':
      return { lines: [SIGN_IN_TEXT.cancelOwnEmail], risk: true };
    case 'cancel_own_none':
      return { lines: [SIGN_IN_TEXT.cancelOwnNone], risk: true };
    case 'cancel_at_sign_in':
      return { lines: [SIGN_IN_TEXT.cancelAtSignIn], risk: true };
    case 'remove_own':
      return {
        lines: [
          `To remove it, sign in to this app with it and choose “${removeLabel}” when asked. After that, it no longer opens this wallet, and signing in with it opens a new, empty wallet.`,
          SIGN_IN_TEXT.removeOwnMoney,
          SIGN_IN_TEXT.removeOwnNotAsked,
        ],
        risk: false,
      };
    case 'remove_at_sign_in':
      return { lines: [SIGN_IN_TEXT.removeAtSignIn], risk: false };
    case 'remove_at_sign_in_once':
      return { lines: [row.kind === 'google' && row.auto === true ? SIGN_IN_TEXT.removeAtSignInAuto : SIGN_IN_TEXT.removeAtSignIn, SIGN_IN_TEXT.removeAtSignInOnceNotOffered], risk: false };
    case 'not_yours':
      return { lines: [SIGN_IN_TEXT.notYours], risk: false };
  }
}

/** Whether a pointer tells the user to sign in to the app (then the section says once to sign out of it first). */
export const pointerSignsIn = (p: SignInPointer | null): boolean => p !== null && ['cancel_own_email', 'cancel_at_sign_in', 'remove_own', 'remove_at_sign_in', 'remove_at_sign_in_once'].includes(p.kind);

// ---- the section ----

export interface HomeSignInsWho {
  provider: 'google' | 'email';
  sub: string;
  /** An email sign-in's address (memory only), else null. */
  address: string | null;
}

export interface HomeSignInsDeps {
  win: PageWindow;
  d: Dom;
  near: NearReader;
  /** The pinned signer. */
  signer: string;
  isGesture: GestureCheck;
  /** Passport Home's usable sign-in, or null when there is none (then nothing is read). */
  session: () => HomeSignInsWho | null;
  /** Whether the sign-in has ended (an address on screen is then masked, D689). */
  ended: () => boolean;
  track: (p: Promise<unknown>) => void;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type HomeSignInsState = 'closed' | 'loading' | 'ready' | 'failed';

export interface HomeSignIns {
  readonly state: HomeSignInsState;
  /** How many reads (pairs of views) this section has made. */
  readonly reads: number;
  readonly errorCode: string | null;
  /** The section of `scope`'s page. An answer read earlier in this sign-in is shown again without a read. */
  appView(scope: HomeScope): HTMLElement;
  /** The user left an app's page. What was read stays for this sign-in. */
  leaveApp(): void;
  /** The sign-in ended: the address on screen is masked; nothing is read until the next sign-in. */
  sessionEnded(): void;
  /** Another account, or signed out: everything read is dropped. */
  reset(): void;
}

interface Entry {
  who: HomeSignInsWho;
  model: SignInModel;
}

export function startHomeSignIns(deps: HomeSignInsDeps): HomeSignIns {
  const { d, isGesture } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let epoch = 0;
  let reads = 0;
  let scope: HomeScope | null = null;
  let state: HomeSignInsState = 'closed';
  let errorCode: string | null = null;
  let problemText: string | null = null;
  /** What was read, per app, for this Home sign-in. Memory only. */
  const cache = new Map<string, Entry>();

  const root = d.h('section', { class: 'home-devices home-sign-ins', attrs: { id: 'home-sign-ins', 'aria-labelledby': 'home-sign-ins-title' } });

  const button = (label: string, id: string, onClick: () => void, o: { disabled?: boolean } = {}): HTMLButtonElement => {
    const b = d.h('button', { class: `${BTN.secondary}`, attrs: { type: 'button', id } }, label);
    if (o.disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', (e) => {
      if (isGesture(e)) onClick();
    });
    return b;
  };
  const focus = (id: string): void => {
    try {
      deps.win.document.getElementById(id)?.focus();
    } catch {
      // Focus is a convenience.
    }
  };

  /** One provider's list, or why there is none. */
  async function readOne(read: (method: string, args: unknown) => Promise<unknown>, scopeId: string, who: HomeSignInsWho): Promise<SignInModel | 'unreachable' | 'disputed'> {
    const args = { scope_id: scopeId, provider: who.provider, sub: who.sub };
    let raw: [unknown, unknown];
    try {
      raw = await Promise.all([read('get_identity', args), read('get_account', args)]);
    } catch {
      return 'unreachable';
    }
    try {
      return signInModel(scopeId, who, parseIdentityView(raw[0]), parseAccountView(raw[1]));
    } catch {
      return 'disputed';
    }
  }

  /** The list both providers agree on, or the failed read's code. Every answer is in before the verdict. */
  async function readViews(scopeId: string, who: HomeSignInsWho): Promise<SignInModel | typeof SIGN_INS_UNREADABLE | typeof SIGN_INS_DISPUTED> {
    const views = deps.near.independent(deps.signer);
    if (!views) return SIGN_INS_UNREADABLE;
    const both = Promise.all([readOne(views.primary, scopeId, who), readOne(views.second, scopeId, who)]);
    const got = await Promise.race([both, sleep(SIGN_INS_READ_LIMIT_MS).then(() => null)]);
    if (got === null) return SIGN_INS_UNREADABLE;
    const [a, b] = got;
    if (a === 'disputed' || b === 'disputed') return SIGN_INS_DISPUTED;
    if (a === 'unreachable' || b === 'unreachable') return SIGN_INS_UNREADABLE;
    return JSON.stringify(a) === JSON.stringify(b) ? a : SIGN_INS_DISPUTED;
  }

  async function load(): Promise<void> {
    if (state === 'loading' || !scope) return;
    const at = epoch;
    const scopeId = scope.scopeId;
    const who = deps.session();
    errorCode = null;
    problemText = null;
    if (!who) {
      const p = plainProblem('home_signed_out');
      errorCode = p.code;
      problemText = p.text;
      state = cache.has(scopeId) ? 'ready' : 'failed';
      render();
      return;
    }
    state = 'loading';
    render();
    reads += 1;
    let answer: SignInModel | string;
    try {
      answer = await readViews(scopeId, who);
    } catch {
      answer = SIGN_INS_UNREADABLE;
    }
    if (at !== epoch || scope?.scopeId !== scopeId) return;
    const model = typeof answer === 'string' ? null : answer;
    if (model) {
      cache.set(scopeId, { who, model });
      state = 'ready';
    } else {
      // A failed read is never kept: the next press reads again.
      cache.delete(scopeId);
      state = 'failed';
      errorCode = answer as string;
      problemText = SIGN_IN_TEXT.failed;
    }
    render();
    focus(model ? 'home-sign-ins-title' : 'home-sign-ins-problem');
  }

  function rowView(entry: Entry, row: SignInRow, viewer: SignInViewer, i: number): HTMLElement {
    const address = row.you && row.kind === 'email' && entry.who.address ? (deps.ended() ? maskedAddress(entry.who.address) : entry.who.address) : null;
    const nameId = `home-sign-in-name-${i}`;
    const pointer = pointerFor(viewer, row, deps.now());
    const how = pointer ? pointerText(pointer, row) : null;
    const name = address ? addressText(d, address, 'strong', nameId) : d.h('strong', { attrs: { id: nameId } }, rowName(row, null));
    const badges: Child[] = [
      row.you ? d.h('span', { class: 'jp-badge jp-badge-success home-sign-in-you' }, SIGN_IN_TEXT.youBadge) : null,
      row.role === 'waiting' ? d.h('span', { class: 'jp-badge jp-badge-warning home-sign-in-waiting' }, SIGN_IN_TEXT.waitingBadge) : null,
    ];
    return d.h(
      'li',
      { class: 'home-device home-sign-in jp-card', attrs: { 'data-kind': row.kind, 'data-role': row.role, 'data-you': row.you ? 'true' : 'false' } },
      d.h(
        'div',
        { class: 'jp-setting home-setting' },
        d.h(
          'span',
          { class: 'home-setting-text' },
          d.h('p', { class: 'home-device-name' }, icon(d, row.kind === 'email' ? 'mail' : row.kind === 'google' ? 'google' : 'key', 'home-sign-in-ic'), name),
          badges.some(Boolean) ? d.h('p', { class: 'home-sign-in-badges' }, ...badges) : null,
          ...rowFacts(row).map((t) => d.h('p', { class: 'home-sign-in-fact' }, t)),
          how && !how.risk ? d.h('div', { class: 'home-sign-in-how' }, ...how.lines.map((t, j) => d.h('p', { class: j === 0 ? '' : 'muted' }, t))) : null,
        ),
      ),
      how && how.risk ? alert(d, 'warning', { tag: 'div', class: 'home-sign-in-how home-sign-in-risk' }, ...how.lines.map((t) => d.h('p', {}, t))) : null,
    );
  }

  function body(): Child[] {
    const entry = scope ? cache.get(scope.scopeId) : undefined;
    const problem = problemText
      ? alert(d, 'warning', { tag: 'div', class: 'home-problem', attrs: { role: 'alert', id: 'home-sign-ins-problem', tabindex: '-1' } }, d.h('p', {}, problemText), errorCode ? d.h('p', { class: 'code muted' }, supportCode(errorCode)) : null)
      : null;
    if (state === 'closed') return [d.h('div', { class: 'actions start' }, button(SIGN_IN_TEXT.show, 'home-sign-ins-show', () => deps.track(load())))];
    if (state === 'loading') return [d.h('p', { class: 'muted', attrs: { role: 'status' } }, SIGN_IN_TEXT.loading)];
    if (state === 'failed' || !entry) return [problem, d.h('div', { class: 'actions start' }, button(SIGN_IN_TEXT.retry, 'home-sign-ins-retry', () => deps.track(load())))];
    const out: Child[] = [problem];
    if (entry.model.state === 'no_wallet') out.push(d.h('p', { class: 'muted', attrs: { id: 'home-sign-ins-none' } }, SIGN_IN_TEXT.noWallet));
    else {
      const { viewer, rows } = entry.model;
      if (rows.length > 1) out.push(d.h('p', { attrs: { id: 'home-sign-ins-shared' } }, SIGN_IN_TEXT.shared));
      out.push(d.h('ul', { class: 'home-device-list home-sign-in-list', attrs: { id: 'home-sign-ins-list' } }, ...rows.map((r, i) => rowView(entry, r, viewer, i))));
      // Said once, where any line sends the user to the app's sign-in: the app shows it only to someone signed out.
      if (rows.some((r) => pointerSignsIn(pointerFor(viewer, r, deps.now())))) out.push(d.h('p', { attrs: { id: 'home-sign-ins-sign-out-first' } }, SIGN_IN_TEXT.signOutFirst));
      out.push(d.h('p', { class: 'muted', attrs: { id: 'home-sign-ins-read-only' } }, SIGN_IN_TEXT.readOnly, ' ', rows.length > 1 ? SIGN_IN_TEXT.privacy : null));
    }
    out.push(d.h('div', { class: 'actions start' }, button(SIGN_IN_TEXT.again, 'home-sign-ins-again', () => deps.track(load()))));
    return out;
  }

  function render(): void {
    root.replaceChildren();
    for (const c of [d.h('h3', { attrs: { id: 'home-sign-ins-title', tabindex: '-1' } }, HOME_SIGN_INS_TITLE), d.h('p', {}, SIGN_IN_TEXT.intro), ...body()]) {
      if (c !== null && c !== undefined && c !== false) root.append(typeof c === 'string' ? deps.win.document.createTextNode(c) : c);
    }
  }

  render();

  return {
    get state() {
      return state;
    },
    get reads() {
      return reads;
    },
    get errorCode() {
      return errorCode;
    },
    appView(next) {
      if (scope?.scopeId !== next.scopeId) {
        // Another app: shown from memory when read earlier in this sign-in, else closed until asked.
        state = cache.has(next.scopeId) ? 'ready' : 'closed';
        errorCode = null;
        problemText = null;
      }
      scope = next;
      render();
      return root;
    },
    leaveApp() {
      scope = null;
      if (state === 'loading') state = 'closed';
      epoch += 1;
    },
    sessionEnded() {
      render();
    },
    reset() {
      epoch += 1;
      cache.clear();
      scope = null;
      state = 'closed';
      errorCode = null;
      problemText = null;
      render();
    },
  };
}
